#!/usr/bin/env node
'use strict';
/**
 * work-items.js — el pedido de trabajo del líder.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * La revisión nocturna de dependencias avisaba SÓLO por un pull request en el repo del arnés, que ve
 * quien mantiene el arnés. El equipo dueño del código no recibía nada. Este guion convierte cada
 * ficha viva en un **Bug en el proyecto de Azure DevOps de ese equipo, asignado a quien lo
 * administra, con el responsable de respaldo mencionado**, la misma noche en que se detecta, y nunca
 * dos veces.
 *
 * ── QUIÉN RESPONDE ─────────────────────────────────────────────────────
 * El RESPONSABLE DE RESPALDO cumple tres papeles: (a) se lo excluye al deducir el dueño entre los
 * administradores, (b) se lo menciona en cada comentario del arnés, y (c) recibe el pedido cuando no
 * hay un dueño único. Sin su identidad resuelta no se crea ningún pedido. Es `owners.default` de
 * `operations.json` (`--operations`, por defecto el de la raíz del repo; lo lee
 * `scripts/lib/operations-config.js`) y, sin ese archivo, `azure.fallback_owner` de repos.json.
 * `owners.by_project.<proyecto>`, si está declarado, REEMPLAZA la deducción en ese proyecto: el
 * pedido se le asigna directo («declarado en operations.json») y la mención sigue siendo al
 * responsable de respaldo.
 * 🔴 Un operations.json que está y no valida NO cae en repos.json: sería adivinar quién responde.
 * Es «sin responsable», como una identidad vacía: no se crea ningún pedido y el motivo se dice.
 * Los motivos que van a la foto nunca llevan un nombre propio: dicen «el responsable de respaldo».
 *
 * ── LAS REGLAS QUE NO SE DISCUTEN ───────────────────────────────────────────────────────────────
 * 1. **EL DUEÑO SE DEDUCE DE AZURE**, no de una lista (salvo el declarado por proyecto): el único
 *    miembro persona del grupo «Project Administrators» del proyecto que no sea el responsable de
 *    respaldo. Cero, varios, o un grupo ilegible → el responsable de respaldo, y el comentario lo
 *    dice. Nunca alguien elegido al azar.
 * 2. **UN PEDIDO TIENE DOS IDENTIDADES** y las dos se miran antes de crear: el id en la ficha
 *    (`pedidos:`) y la etiqueta `arnes:<id>` en Azure. Si Azure lo tiene y la ficha no (el push de
 *    anoche se perdió), se ADOPTA. 🔴 Si la consulta falla o no se puede leer, NO se crea nada:
 *    «no pude preguntar» no es «no hay».
 * 3. **BUSCAR Y CREAR VAN POR LA CAPA DE PLATAFORMA** (`work-item.find` y `work-item.create` del conector de Azure
 *    DevOps): la búsqueda acota por proyecto y relee la etiqueta exacta de cada resultado. La organización, el proyecto,
 *    el tipo, la iteración y los campos salen de repos.json y operations.json, nunca de la configuración del pedido
 *    de trabajo de un repo; el asignado va en `System.AssignedTo`, así lo valida Azure.
 * 4. **EL TEXTO VA A REPRO STEPS, EN HTML.** El formulario del Bug no muestra Descripción. El conector manda el
 *    texto por archivo: `az` lee como archivo todo lo que siga a un `=@` o empiece con `@`.
 * 5. **NACE APAGADA.** Con `azure.pedidos_activos` distinto de `true` (o `--simulate`) hace las
 *    lecturas y publica lo que HABRÍA creado, sin una sola escritura. Se enciende después de probar
 *    los dos mails y los dos permisos con la identidad del pipeline.
 * 6. **HABLA CON AZURE SÓLO POR `TYCON_ADO_CMD`** (por defecto `az`), con `--org` y `-o json`
 *    explícitos en cada llamada: el default de `az devops configure` apunta a un proyecto que ya no
 *    existe, y la salida por defecto depende de la máquina. La suite usa un `az` de mentira.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node work-items.js run    [--config <f>] [--operations <f>] [--pending <dir>] [--out <dir>]
 *                             [--today <fecha>] [--simulate] [--json]
 *   node work-items.js state  [--config <f>] [--pending <dir>] [--out <dir>] [--today <fecha>]
 *
 * ── `state`: LO QUE AZURE DICE DE CADA PEDIDO, ESCRITO ANTES DE DECIDIR ─────────────
 * Vuelca a `<out>/bugs-<hoy>.json` el estado de cada pedido que nombran las fichas de `pending/` y
 * `promoted/`, y los Bugs del arnés que ninguna ficha nombra. El nocturno decide sobre ese archivo
 * sin tocar la red. Cuatro reglas de Azure:
 *   · CERRADO SE LEE POR CATEGORÍA (`workItemTypeStates`, una vez por proyecto), nunca por el nombre:
 *     `Closed` (Agile) y `Done` (Scrum) son la misma cosa en dos vocabularios.
 *   · PERSONA = una revisión cuyo `System.ChangedBy.descriptor` no empieza con `svc.`. Un comentario
 *     del pipeline es una revisión más: con `System.ChangedDate` a secas, `ignorado` no dispararía nunca.
 *   · SE LEE DE A UNO y sin `errorPolicy=omit`: «no existe» y «sin permiso» salen igual (TF401232) y
 *     los dos son «no leído», nunca «sin pedido».
 *   · LISTA BLANCA DE CAMPOS: el archivo viaja por git, y un comentario o una descripción pueden traer
 *     datos de cliente. Ni títulos, ni descripciones, ni `System.History`.
 * Este guion cambia el estado de un Bug en DOS casos: lo CIERRA cuando el
 * arreglo llegó a `main` en ese proyecto (`cerrarPedido`) y lo REABRE si la vulnerabilidad vuelve a un Bug
 * que cerró él y nadie tocó después (`reabrirPedido`). Nunca manda un motivo, nunca reabre lo que cerró una
 * persona, y el cruce sólo comenta.
 *
 * Exit: 0 = habló con Azure (aunque haya fallos por par: se cobran en el snapshot y en el aviso) ·
 *       2 = no pudo intentar nada (sin `azure.org`, sin snapshot de hoy, sin token, sin `az`) —
 *           eso es «no medido», no «nada que pedir», y NO escribe la sección `pedidos`.
 *           En `state`, 2 escribe igual el volcado con `consultado: false` y el motivo: así el
 *           nocturno puede decir POR QUÉ no cruzó, en vez de sólo «sin volcado».
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// el nocturno vive en la misma carpeta: por la ruta vieja cargaría el reemplazo, que en Azure DevOps deja
// un aviso en la salida
const noc = require('./nightly-dependencies');

const { listaDe, ponerLista, proyectoDe, proyectoAzureDe, etiqueta, leerTodasLasFichas, leerPedidos, cuerpoDeFicha, aHtml } = noc;
const operaciones = require('../../lib/operations-config.js');
const fuentes = require('../findings/sources.js');
const { sitioDecide } = require('../findings/cycle.js');
const { ponerEscalar, quitarClave } = fuentes.FUENTES.dependencias.formato;

/** La capa de plataforma con el conector de Azure DevOps: `(operación, args) → Promise<resultado del contrato>`. */
function plataformaAzure() {
  const P = require('../../lib/platform/platform.js');
  const INT = require('../../lib/integrations.js');
  return (op, args) => {
    const manifiesto = INT.find('azure-devops', { kind: 'platform', env: process.env });
    if (!manifiesto) return Promise.resolve({ ok: false, reason: 'sin_plataforma', detail: 'no está el conector de Azure DevOps' });
    return P.call(manifiesto, op, args, { env: process.env });
  };
}

const RAIZ_REPO = path.resolve(__dirname, '..', '..', '..');
// repos.json vive al lado de este guion; las fichas, en inbox/dependencies/
const CONFIG_DEF = path.join(RAIZ_REPO, 'scripts', 'nightly', 'dependencies', 'repos.json');
// el responsable de cada proyecto: en la raíz del repo de operaciones de la organización
const OPERATIONS_DEF = path.join(RAIZ_REPO, 'operations.json');
const OUT_DEF = path.join(RAIZ_REPO, '.dashboard', 'dependencias');
const PENDING_DEF = path.join(RAIZ_REPO, 'inbox', 'dependencies');
const GRUPO_ADMIN = 'Project Administrators';
const DIAS_SIN_PEDIDO = 7;                 // el mismo corte que `ignorado` en el nocturno
const ORDEN_SEV = { critical: 2, high: 1 };
// 🔴 La severidad del hallazgo va al campo Severity del Bug. Sin esto Azure pone su valor por defecto
// («3 - Medium») y una crítica se ve en el tablero igual que cualquier otra cosa.
// Los proyectos aceptan estos cuatro valores. Lo que no está en la tabla no se inventa: el campo no se manda.
const SEVERIDAD_AZURE = { critical: '1 - Critical', high: '2 - High', moderate: '3 - Medium', low: '4 - Low' };
const CAMPO_SEVERIDAD = 'Microsoft.VSTS.Common.Severity';
const CAMPO_REPRO = 'Microsoft.VSTS.TCM.ReproSteps';
// los obligatorios que el pedido ya trae (o que Azure pone solo): el resto tiene que cubrirlo la configuración
const CAMPOS_PROPIOS = new Set(['System.Title', 'System.State', 'System.AreaId', 'System.AreaPath', 'System.IterationId', 'System.IterationPath',
  'System.TeamProject', 'System.WorkItemType', 'System.Description', 'System.Tags', 'System.AssignedTo', 'System.Reason']);

/** Los campos de un tipo en un proyecto: `{ ok, campos: Set, obligatorios: [] }`, `{ ok: false, noExiste }` o `{ ok: false, motivo }`. */
function leerCamposDelTipo(az, proyecto, tipo) {
  const r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'workitemtypesfield', '--route-parameters', `project=${proyecto}`, `type=${tipo}`, '--api-version', '7.1'],
    { valida: (v) => (v && Array.isArray(v.value) && v.value.every((x) => x && typeof x.referenceName === 'string') ? null : 'la respuesta no trae «value[].referenceName»') });
  if (!r.ok) return /VS402323/.test(r.motivo) ? { ok: false, noExiste: true, motivo: r.motivo } : { ok: false, motivo: `no pude leer los campos del tipo ${tipo} en ${proyecto} (${r.motivo})` };
  // un obligatorio con valor por defecto lo completa Azure (medido: Priority y ValueArea del Product Backlog Item)
  const sinDefecto = (x) => x.defaultValue === undefined || x.defaultValue === null || x.defaultValue === '';
  return { ok: true, campos: new Set(r.valor.value.map((x) => x.referenceName)), obligatorios: r.valor.value.filter((x) => x.alwaysRequired === true && sinDefecto(x)).map((x) => x.referenceName) };
}

/** El elemento de backlog por defecto de un proyecto (la categoría Microsoft.RequirementCategory): `{ ok, tipo }` o `{ ok: false, motivo }`. */
function leerTipoDeBacklog(az, proyecto) {
  const r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'workitemtypecategories', '--route-parameters', `project=${proyecto}`, '--api-version', '7.1'],
    { valida: (v) => (v && Array.isArray(v.value) ? null : 'la respuesta no trae «value»') });
  if (!r.ok) return { ok: false, motivo: `no pude leer la categoría de elemento de backlog de ${proyecto} (${r.motivo}): no se inventa un tipo` };
  const c = r.valor.value.find((x) => x && x.referenceName === 'Microsoft.RequirementCategory');
  const tipo = c && c.defaultWorkItemType && typeof c.defaultWorkItemType.name === 'string' ? c.defaultWorkItemType.name : null;
  return tipo ? { ok: true, tipo } : { ok: false, motivo: `${proyecto} no tiene una categoría de elemento de backlog legible: no se inventa un tipo` };
}

/**
 * El tipo del pedido en un proyecto, una vez por proyecto y por corrida: el que configura la organización
 * (`work_items.type`) si existe en el proyecto; si no, o sin configuración, su elemento de backlog. Devuelve
 * `{ ok, tipo, campos, obligatorios, deFabrica, motivoFabrica }` o `{ ok: false, motivo }` (no se crea: falla cerrado).
 */
function cacheDeTipos(az, workItems) {
  const cache = new Map();
  return (proyecto) => {
    if (cache.has(proyecto)) return cache.get(proyecto);
    let v;
    const configurado = workItems && typeof workItems.type === 'string' ? workItems.type : null;
    const c = configurado ? leerCamposDelTipo(az, proyecto, configurado) : null;
    if (c && c.ok) v = { ok: true, tipo: configurado, campos: c.campos, obligatorios: c.obligatorios, deFabrica: false };
    else if (c && !c.noExiste) v = { ok: false, motivo: c.motivo };
    else {
      const b = leerTipoDeBacklog(az, proyecto);
      if (!b.ok) v = { ok: false, motivo: b.motivo };
      else {
        const cb = leerCamposDelTipo(az, proyecto, b.tipo);
        v = cb.ok ? { ok: true, tipo: b.tipo, campos: cb.campos, obligatorios: cb.obligatorios, deFabrica: true,
          motivoFabrica: configurado ? `el tipo «${configurado}» no existe en ${proyecto}: va como ${b.tipo}, su elemento de backlog` : null }
          : { ok: false, motivo: cb.motivo };
      }
    }
    cache.set(proyecto, v);
    return v;
  };
}

/**
 * Los campos del pedido: los fijos de la configuración, pisados por los de su gravedad (sólo si el tipo es el
 * configurado), y Severity y ReproSteps sólo si el tipo los tiene. `{ ok, campos: { campo: valor } }` o
 * `{ ok: false, motivo }` si queda un obligatorio del tipo sin cubrir: nunca un pedido a medias.
 */
function camposDelPedido(t, workItems, severidad, cuerpo) {
  const valores = {};
  if (!t.deFabrica && workItems) {
    // sólo lo que el lector deja viajar: un comentario («__nota») o un campo que el pedido ya fija no van a Azure
    const copiar = (m) => { for (const [k, v] of Object.entries(m || {})) if (operaciones.workItemFieldOk(k, v)) valores[k] = v; };
    copiar(workItems.fixed_fields);
    copiar(workItems.by_severity && workItems.by_severity[severidad]);
    // un campo configurado que el tipo no tiene: Azure lo rechazaría; se dice antes, con su nombre
    const ajenos = Object.keys(valores).filter((k) => !t.campos.has(k));
    if (ajenos.length) return { ok: false, motivo: `el tipo ${t.tipo} no tiene ${ajenos.join(', ')}: revisá work_items en operations.json` };
  }
  if (t.campos.has(CAMPO_REPRO)) valores[CAMPO_REPRO] = cuerpo;
  if (t.campos.has(CAMPO_SEVERIDAD) && Object.prototype.hasOwnProperty.call(SEVERIDAD_AZURE, severidad)) valores[CAMPO_SEVERIDAD] = SEVERIDAD_AZURE[severidad];
  const faltan = t.obligatorios.filter((k) => !CAMPOS_PROPIOS.has(k) && !Object.prototype.hasOwnProperty.call(valores, k));
  if (faltan.length) return { ok: false, motivo: `el tipo ${t.tipo} exige ${faltan.join(', ')} y la configuración no ${faltan.length > 1 ? 'los cubre' : 'lo cubre'}: no se crea un pedido a medias` };
  return { ok: true, campos: valores };
}

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { cmd: argv[2] || 'help', config: CONFIG_DEF, operations: OPERATIONS_DEF, operationsExplicito: false,
              pending: PENDING_DEF, out: OUT_DEF, hoy: null, json: false, simular: false };
  for (let i = 3; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--config') a.config = path.resolve(argv[++i]);
    else if (v === '--operations') { a.operations = path.resolve(argv[++i]); a.operationsExplicito = true; }
    else if (v === '--pending') a.pending = path.resolve(argv[++i]);
    else if (v === '--out') a.out = path.resolve(argv[++i]);
    else if (v === '--today') a.hoy = argv[++i];
    else if (v === '--json') a.json = true;
    else if (v === '--simulate') a.simular = true;
    else if (v === '--help' || v === '-h') a.cmd = 'help';
    else a.error = `opción desconocida: ${v}`;
  }
  return a;
}

const recortar = (t, n = 300) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
// lo que dijo la plataforma, para el resumen: el motivo del vocabulario cerrado y, si lo trae, el código de error de
// Azure; el texto libre del detalle no sale
const motivoDe = (r) => {
  const reason = r && typeof r.reason === 'string' && /^[a-z_]{1,30}$/.test(r.reason) ? r.reason : 'sin respuesta';
  const codigo = r && typeof r.detail === 'string' ? /\b(?:TF|VS)\d{4,6}\b/.exec(r.detail) : null;
  return codigo ? `${reason}, ${codigo[0]}` : reason;
};
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Un fallo que impide intentar CUALQUIER cosa: la corrida sale 2 sin escribir la sección. */
class NoSePuedeIntentar extends Error {}

/**
 * `az(args, { valida })` → `{ ok, valor, motivo }`.
 *
 * 🔴 Se decide por el CÓDIGO DE SALIDA más la LEGIBILIDAD, nunca por «salida vacía»: ≠ 0 es fallo con
 * el stderr crudo; 0 con algo que no es JSON, o JSON sin el campo esperado (`valida` devuelve el
 * motivo), también. Sin `|| true`, sin descartar stderr: «no pude preguntar» y «pregunté y no hay»
 * no pueden salir iguales.
 */
function crearAz({ cmd, org }) {
  return function az(args, { valida = null } = {}) {
    const r = spawnSync(cmd, [...args, '--org', org, '-o', 'json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env,
    });
    if (r.error && r.error.code === 'ENOENT') throw new NoSePuedeIntentar(`no se pudo ejecutar ${cmd}: ${r.error.message}`);
    if (r.error) return { ok: false, motivo: `${cmd} no terminó (${r.error.message})` };
    if (r.status !== 0) return { ok: false, motivo: `salió ${r.status}: ${recortar(r.stderr || r.stdout)}` };
    let valor;
    try { valor = JSON.parse(r.stdout); } catch { return { ok: false, motivo: `la respuesta no es JSON: ${recortar(r.stdout, 120)}` }; }
    const m = valida ? valida(valor) : null;
    return m ? { ok: false, motivo: m } : { ok: true, valor };
  };
}

// ── piezas puras (exportadas: otros guiones reusan este) ────────────────────────────────────

/** Los proyectos de Azure de una ficha: donde está SIN declarar (`repos:`). `declarada_en:` ya decidió. */
function proyectosDeFicha(f, cfg) {
  // 🔴 `proyectoAzureDe`, no `proyectoDe`: a un repo que no está en repos.json no se le inventa un
  // proyecto (el producto no es el proyecto). Esos repos se publican aparte.
  return [...new Set(f.fi.listas.repos.map((r) => proyectoAzureDe(r, cfg)).filter(Boolean))];
}

/**
 * `[{ ficha, proyectos, faltan, conPedido, desconocidos }]` de las fichas vivas. La que está contando sus noches sin
 * aparecer no pide: la vulnerabilidad ya no está en ningún repo medido.
 */
function paresPorPedir(fichas, cfg) {
  return fichas.filter((f) => f.viva && !f.contando).map((f) => {
    const proyectos = proyectosDeFicha(f, cfg);
    const pedidos = new Map(leerPedidos(f.txt).map((x) => [x.proyecto, x.id]));
    return { ficha: f, proyectos, faltan: proyectos.filter((p) => !pedidos.has(p)),
             conPedido: proyectos.filter((p) => pedidos.has(p)),
             desconocidos: f.fi.listas.repos.filter((r) => !proyectoAzureDe(r, cfg)) };
  });
}

/**
 * El tope cuenta FICHAS, no pedidos (una ficha en 3 proyectos son 3 pedidos y 1 cupo). Orden: los
 * reintentos de anoche primero, después más noches, después severidad; el id desempata para que la
 * corrida sea reproducible.
 *
 * 🔴 Una CRÍTICA no consume cupo y pide la misma noche: el mismo criterio
 * que el anuncio del nocturno, para que el pull request y el Bug de una crítica salgan juntos.
 */
function ordenarYTopar(sinPedido, tope, fallidasAnoche) {
  const noches = (x) => Number(x.ficha.fi.escalares.noches) || 0;
  const sev = (x) => ORDEN_SEV[x.ficha.fi.escalares.severidad] || 0;
  const orden = [...sinPedido].sort((x, y) =>
    (Number(fallidasAnoche.has(y.ficha.idFicha)) - Number(fallidasAnoche.has(x.ficha.idFicha)))
    || (noches(y) - noches(x)) || (sev(y) - sev(x)) || String(x.ficha.idFicha).localeCompare(String(y.ficha.idFicha)));
  const conCupo = orden.filter((x) => x.ficha.fi.escalares.severidad !== 'critical');
  return { elegidas: [...orden.filter((x) => x.ficha.fi.escalares.severidad === 'critical'), ...conCupo.slice(0, tope)],
    postergadas: conCupo.slice(tope) };
}

/**
 * El dueño deducido de las PERSONAS de «Project Administrators», sin el responsable de respaldo.
 *
 * El valor asignado es el `principalName` TAL COMO AZURE LO DEVOLVIÓ, y viaja crudo en
 * `--fields System.AssignedTo=…`, no por `--assigned-to`: con esa opción el CLI trata un valor sin
 * «@» como un alias y, si no lo resuelve, crea el Bug SIN ASIGNAR sin decir nada
 * (`_resolve_identity_as_unique_user_id` devuelve None). Por `--fields` lo valida Azure, y un valor
 * inválido es un `crear` fallido con su motivo — nunca un pedido sin dueño en silencio.
 */
function deducirDueno(personas, respaldoMail) {
  const respaldo = String(respaldoMail || '').toLowerCase();
  const otros = personas.filter((x) => ![x.cuenta, x.mail].some((v) => String(v || '').toLowerCase() === respaldo));
  if (otros.length === 1) return { unico: true, asignado: otros[0].cuenta, motivo: 'único administrador además del responsable de respaldo' };
  if (otros.length === 0) {
    return { unico: false, asignado: respaldoMail, motivo: 'sin dueño deducible: ningún administrador del proyecto además del responsable de respaldo' };
  }
  // Ordenados: el motivo va al snapshot que se commitea cada noche, y el orden de la respuesta de
  // Azure no está garantizado — el mismo contenido en otro orden sería un diff que no dice nada.
  return { unico: false, asignado: respaldoMail,
           motivo: `${otros.length} administradores además del responsable de respaldo: ${otros.map((x) => x.nombre).sort().join(', ')}` };
}

/**
 * La identidad del responsable de respaldo por la API de identidades.
 * `{ ok, id, nombre }` o `{ ok: false, motivo }`. Es el ÚNICO resolvedor de identidad del arnés.
 */
function resolverIdentidad(az, mail) {
  const pre = 'identidad del responsable de respaldo sin configurar o sin resolver';
  if (!mail) return { ok: false, motivo: `${pre}: no hay ninguna declarada` };
  const r = az(['devops', 'invoke', '--area', 'ims', '--resource', 'identities', '--query-parameters',
    'searchFilter=General', `filterValue=${mail}`, 'queryMembership=None', '--api-version', '7.1'],
  { valida: (v) => (v && Array.isArray(v.value) ? null : 'la respuesta no trae «value»') });
  if (!r.ok) return { ok: false, motivo: `${pre}: ${r.motivo}` };
  const vs = r.valor.value.filter((x) => x && x.id);
  if (vs.length !== 1) return { ok: false, motivo: `${pre}: la API devolvió ${vs.length} identidades para ${mail}` };
  return { ok: true, id: vs[0].id, nombre: vs[0].providerDisplayName || mail };
}

/**
 * Quienes mantienen el arnés, para mencionarlos además del responsable de respaldo: una identidad por persona, por el
 * primero de sus correos que Azure conoce, sin repetir al respaldo ni a otra. Quien no tiene identidad se saltea y se
 * cuenta en `res.maintainers_sin_identidad`; 🔴 su correo no va a la salida ni a la foto.
 */
function maintainersDe(az, personas, respaldoId, res) {
  const vistos = new Set([String(respaldoId).toLowerCase()]);
  const extra = [];
  for (const correos of personas) {
    let ident = null;
    let usado = null;
    for (const mail of correos) { const r = resolverIdentidad(az, mail); if (r.ok) { ident = r; usado = mail; break; } }
    if (!ident) { res.maintainers_sin_identidad += 1; continue; }
    const k = String(ident.id).toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    // sin nombre visible en Azure, el resolvedor devuelve el correo: en el comentario va un nombre genérico
    extra.push({ id: ident.id, nombre: ident.nombre === usado ? 'mantiene el arnés' : ident.nombre });
  }
  return extra;
}

/** Las menciones del primer párrafo de un comentario del arnés: el responsable de respaldo y quienes mantienen el arnés. */
function mencionesDelArnes(respaldo) {
  return [respaldo, ...(respaldo.extra || [])]
    .map((x) => `<a href="#" data-vss-mention="version:2.0,${escHtml(x.id)}">@${escHtml(x.nombre)}</a>`).join(' ');
}

/**
 * Quién responde, sin operations.json: `azure.fallback_owner` de repos.json, sin declarados por proyecto.
 * `{ ok, fuente, respaldo, declarado(p) }` o `{ ok: false, motivo }`.
 */
function responsablesDeRepos(azure) {
  const fb = azure && typeof azure.fallback_owner === 'string' ? azure.fallback_owner.trim() : '';
  if (!fb) return { ok: false, motivo: 'sin responsable de respaldo: no hay operations.json y `azure.fallback_owner` de repos.json está vacío' };
  return { ok: true, fuente: 'repos.json', respaldo: fb, declarado: () => null };
}

/**
 * Quién responde: operations.json si está —el de `--operations`, o el de la raíz
 * del repo—, y si no, repos.json. 🔴 Un operations.json que está y no valida no se saltea: el motivo vuelve
 * como `{ ok: false }` y no se crea ningún pedido. Pedido con `--operations` y ausente, tampoco se adivina.
 */
function responsables(a, azure) {
  if (!a.operationsExplicito && !fs.existsSync(a.operations)) return responsablesDeRepos(azure);
  const r = operaciones.load(a.operations);
  // 🔴 El motivo es fijo: el problema del lector copia valores del archivo (correos, identidades), y el motivo va a la
  // salida de la noche y a su foto. El detalle lo da el lector a mano.
  if (!r.ok) {
    return { ok: false, motivo: 'sin responsable de respaldo: operations.json no sirve (el detalle: node scripts/lib/operations-config.js operations.json) — no se adivina' };
  }
  const bp = r.data.owners.by_project || {};
  // quienes mantienen el arnés, cada persona con sus correos: las entradas «maintainer» de site.access o, en la forma
  // corta, cada correo de site.maintainers
  const site = r.data.site || {};
  const maintainers = Array.isArray(site.access)
    ? site.access.filter((e) => e.role === 'maintainer').map((e) => e.emails)
    : (site.maintainers || []).map((m) => [m]);
  return { ok: true, fuente: 'operations.json', respaldo: r.data.owners.default, maintainers, workItems: r.data.work_items || null,
           declarado: (p) => (Object.prototype.hasOwnProperty.call(bp, p) ? operaciones.ownerFor(r.data, p) : null) };
}

/**
 * Las PERSONAS de «Project Administrators» de un proyecto: `{ ok, personas }` o
 * `{ ok: false, motivo }`. Pagina la lista de grupos hasta encontrarlo (tope de 20 páginas).
 */
function leerAdministradores(az, proyecto) {
  let grupos = [], token = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const r = az(['devops', 'security', 'group', 'list', '--project', proyecto, ...(token ? ['--continuation-token', token] : [])],
      { valida: (v) => (v && Array.isArray(v.graphGroups) ? null : 'la respuesta no trae «graphGroups»') });
    if (!r.ok) return { ok: false, motivo: r.motivo };
    grupos = grupos.concat(r.valor.graphGroups);
    token = r.valor.continuationToken;
    if (!token || grupos.some((g) => g && g.displayName === GRUPO_ADMIN)) break;
  }
  const pa = grupos.find((g) => g && g.displayName === GRUPO_ADMIN);
  if (!(pa && pa.descriptor)) return { ok: false, motivo: `no encontré el grupo «${GRUPO_ADMIN}»` };
  const m = az(['devops', 'security', 'group', 'membership', 'list', '--id', pa.descriptor],
    { valida: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? null : 'la respuesta no es un mapa de miembros') });
  if (!m.ok) return { ok: false, motivo: m.motivo };
  const personas = Object.values(m.valor).filter((x) => x && x.subjectKind === 'user')
    .map((x) => ({ nombre: x.displayName || x.principalName, cuenta: x.principalName || x.mailAddress, mail: x.mailAddress || x.principalName }));
  // 🔴 Una persona SIN cuenta no se puede asignar ni excluir: la respuesta no se pudo leer entera.
  // Sin esto viaja literal `System.AssignedTo=undefined` y el comentario dice «Asignado a undefined».
  // Azure devuelve `principalName` para todo usuario: si falta,
  // algo raro pasó, y se dice en vez de adivinar.
  const sinCuenta = personas.filter((x) => !x.cuenta);
  if (sinCuenta.length) {
    return { ok: false, motivo: `Azure devolvió administradores sin cuenta (${sinCuenta.map((x) => x.nombre || 'sin nombre').sort().join(', ')})` };
  }
  return { ok: true, personas };
}

/** Los pasos que dejan a un par (ficha, proyecto) SIN pedido anotado: los únicos que piden reintento. */
// El paso que resuelve la identidad del líder se llama `lead-identity` (el aviso del arranque,
// que se publica, lo lee y no puede llevar un nombre de persona). Las noches anteriores lo escribieron como `identidad-`
// más ese nombre: se reconocen por el prefijo, para que su prioridad de reintento no se pierda con el cambio.
const PASOS_SIN_PEDIDO = ['lead-identity', 'duplicados', 'crear', 'escribir-ficha'];
const isNoWorkItemStep = (paso) => PASOS_SIN_PEDIDO.includes(paso) || /^identidad-/.test(String(paso || ''));

/**
 * La iteración a la que va el pedido: `{ ruta, motivo, fallo }`. `fallo: true` sólo cuando NO SE
 * PUDO LEER (eso es un fallo y va a `pedidos.fallidos`); «sin iteración actual» o «terminó» son hechos
 * del tablero, no fallos. En los tres casos la ruta es la raíz: la iteración nunca frena el pedido.
 */
function leerIteracion(az, proyecto, hoy) {
  const e = az(['devops', 'project', 'show', '--project', proyecto],
    { valida: (v) => (v && v.defaultTeam && v.defaultTeam.name ? null : 'la respuesta no trae «defaultTeam»') });
  if (!e.ok) return { ruta: proyecto, motivo: `no pude leer la iteración (${e.motivo})`, fallo: true };
  const r = az(['boards', 'iteration', 'team', 'list', '--team', e.valor.defaultTeam.name, '--timeframe', 'current', '--project', proyecto],
    { valida: (v) => (Array.isArray(v) ? null : 'la respuesta no es una lista') });
  if (!r.ok) return { ruta: proyecto, motivo: `no pude leer la iteración (${r.motivo})`, fallo: true };
  return { ...iteracionVigente(r.valor, hoy, proyecto), fallo: false };
}

/** La iteración vigente: sin `finishDate`, o con `finishDate` hoy o después. Si no, la raíz y el motivo. */
function iteracionVigente(lista, hoy, proyecto) {
  if (!lista.length) return { ruta: proyecto, motivo: 'sin iteración actual' };
  const fin = (x) => (x && x.attributes && x.attributes.finishDate ? String(x.attributes.finishDate).slice(0, 10) : null);
  const vigente = lista.find((x) => !fin(x) || fin(x) >= hoy);
  if (vigente) return { ruta: vigente.path || proyecto, motivo: null };
  return { ruta: proyecto, motivo: `la iteración marcada como actual (${lista[0].path}) terminó el ${fin(lista[0])}` };
}

/** `System.Tags` → tokens exactos (`arnes:abc1` no es `arnes:abc12345`). */
const tokensDeEtiquetas = (tags) => String(tags || '').split(';').map((t) => t.trim().toLowerCase()).filter(Boolean);

/** Los marcadores de aviso por proyecto (`pagado_avisado:`, `deuda_avisada:`). */
const yaMarcado = (txt, clave, linea) => listaDe(txt, clave).includes(linea);
function marcar(archivo, clave, proyecto, linea) {
  const txt = fs.readFileSync(archivo, 'utf8');
  const items = listaDe(txt, clave).filter((l) => !l.startsWith(`${proyecto} (`));
  fs.writeFileSync(archivo, ponerLista(txt, clave, [...items, linea]));
}

/** Escribe `  - <Proyecto>: <id>` en `pedidos:` releyendo la ficha del disco (otra escritura pudo tocarla). */
function anotarPedido(archivo, proyecto, id) {
  const txt = fs.readFileSync(archivo, 'utf8');
  const otros = leerPedidos(txt).filter((x) => x.proyecto !== proyecto).map((x) => `${x.proyecto}: ${x.id}`);
  fs.writeFileSync(archivo, ponerLista(txt, 'pedidos', [...otros, `${proyecto}: ${id}`]));
}

/**
 * Las fichas cuyo pedido falló la última noche que intentó pedir: `{ ids, aviso }`.
 *
 * Se toma el último snapshot ANTERIOR a hoy con sección `pedidos` (los que no la
 * tienen y se saltean: no son un fallo). 🔴 Pero uno ILEGIBLE corta la búsqueda: saltearlo y seguir
 * con uno más viejo priorizaría fichas con datos de otra noche, en silencio. Esa noche no se priorizan
 * reintentos —se crean por antigüedad igual— y el `aviso` sale en la salida del paso.
 */
function fallidasDeAnoche(outDir, hoy) {
  let files = [];
  try { files = fs.readdirSync(outDir).filter((f) => /^dependencias-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse(); }
  catch { return { ids: new Set(), aviso: null }; }   // sin carpeta de snapshots no hubo noche anterior
  const noches = [];   // [anoche, anteanoche]: los dos últimos snapshots con sección `pedidos`
  const avisos = [];
  for (const f of files) {
    if (f.slice('dependencias-'.length, -'.json'.length) >= hoy) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); }
    catch (e) {
      avisos.push(`el snapshot ${f} es ilegible (${recortar(e.message, 120)}): ${noches.length ? 'no se sabe si los reintentos de anoche venían fallando de antes' : 'esta noche no se priorizan los reintentos'}`);
      break;
    }
    if (!(s && s.pedidos)) continue;
    // 🔴 Reintento = un par que quedó SIN pedido. Un fallo que no lo impidió (administradores,
    // iteración, comentario) no le quita el turno a una ficha más vieja. Y la lista se lee con
    // cuidado: `fallidos` con forma inesperada (objeto, `null` adentro) tumbaba la noche entera.
    const fallidos = Array.isArray(s.pedidos.fallidos) ? s.pedidos.fallidos : [];
    const validas = fallidos.filter((x) => x && typeof x === 'object' && typeof x.ficha === 'string');
    if (validas.length !== fallidos.length) avisos.push(`el snapshot ${f} trae ${fallidos.length - validas.length} fallo(s) ilegible(s) en pedidos.fallidos: se ignoran para priorizar reintentos`);
    noches.push(new Set(validas.filter((x) => isNoWorkItemStep(x.paso)).map((x) => x.ficha)));
    if (noches.length === 2) break;
  }
  // 🔴 La prioridad es para un fallo de UNA noche. Una ficha que falló anoche Y anteanoche vuelve a
  // competir por antigüedad: si no, una falla permanente en un proyecto (un permiso que falta, dos
  // pedidos duplicados que nadie resuelve) acapararía el cupo todas las noches y postergaría sin fin a
  // las fichas sanas de los demás proyectos.
  const [anoche = new Set(), anteanoche = new Set()] = noches;
  return { ids: new Set([...anoche].filter((id) => !anteanoche.has(id))), aviso: avisos.join(' · ') || null };
}

const porFicha = (a, b) => String(a.ficha).localeCompare(String(b.ficha)) || String(a.proyecto || '').localeCompare(String(b.proyecto || ''));

// ── la conversación con Azure ──────────────────────────────────────────────────────────────────

async function hablar(ctx) {
  const { az, cfg, azure, hoy, simulado, tope, snap, tmp, fichas } = ctx;
  const plataforma = ctx.plataforma || plataformaAzure();
  // la carpeta temporal no tiene configuración del pedido de trabajo: la de un repo no se mezcla con la de dependencias
  const destino = (p) => ({ repoDir: tmp, org: azure.org, project: p });
  let nArchivo = 0;
  const archivo = (nombre, contenido) => {
    const p = path.join(tmp, `${++nArchivo}-${nombre}`);
    fs.writeFileSync(p, contenido);
    return p;
  };
  const res = {
    simulado, tope, fichas_vivas: 0, fichas_sin_pedido: 0, creados: [], adoptados: [], existentes: 0,
    fallidos: [], postergados: [], sin_iteracion: [], sin_dueno_unico: [], pagados_avisados: [], reabiertos: [],
    deuda_avisada: [], sin_pedido: [], cerrados_vivos_avisados: [], huerfanos_adoptados: [], huerfanos_sin_adoptar: [],
    tipo_de_fabrica: [], maintainers_sin_identidad: 0,
  };
  const textos = [];
  const unaVez = (lista, item) => { if (!lista.some((x) => x.proyecto === item.proyecto)) lista.push(item); };

  // 🔴 El Bug suelto se adopta PRIMERO: si la ficha que nombra está viva, sin esto
  // el camino de crear lo buscaría por su etiqueta igual — pero una ficha ya cerrada no la mira nadie.
  adoptarHuerfanos(ctx, res);

  const pares = paresPorPedir(fichas, cfg);
  res.fichas_vivas = pares.length;
  res.existentes = pares.reduce((n, x) => n + x.conPedido.length, 0);
  const sinPedido = pares.filter((x) => x.faltan.length);
  res.fichas_sin_pedido = sinPedido.length;
  // 🔴 Un Bug por (paquete, proyecto), aunque el nocturno deje DOS fichas vivas para el mismo hecho
  // (dos huellas la misma noche, o una ficha que se extiende a otro proyecto).
  // La identidad del pedido es por ficha; esto es la red para que la segunda no abra otro.
  const clavePaquete = (f, p) => `${String(f.fi.escalares.paquete || '').toLowerCase()}|${p}`;
  const pedidoDelPaquete = new Map();
  // En orden de id: si dos fichas ya tenían pedido para el mismo paquete (lo pudo dejar el código
  // anterior), la nombrada tiene que ser siempre la misma, no la que el disco devuelva primero.
  for (const x of [...pares].sort((a, b) => String(a.ficha.idFicha).localeCompare(String(b.ficha.idFicha)))) {
    for (const { proyecto, id } of leerPedidos(x.ficha.txt)) {
      if (!pedidoDelPaquete.has(clavePaquete(x.ficha, proyecto))) pedidoDelPaquete.set(clavePaquete(x.ficha, proyecto), { ficha: x.ficha.idFicha, id });
    }
  }
  const anoche = fallidasDeAnoche(ctx.out, hoy);
  if (anoche.aviso) (ctx.avisosDeSalida || (ctx.avisosDeSalida = [])).push(anoche.aviso);
  const { elegidas, postergadas } = ordenarYTopar(sinPedido, tope, anoche.ids);
  for (const x of postergadas) res.postergados.push({ ficha: x.ficha.idFicha, proyectos: x.faltan });

  // Quién responde: lo resolvió `correr` desde operations.json o repos.json. Un llamador
  // directo (las pruebas) que no lo pasa usa el de repos.json.
  const quien = ctx.responsables || responsablesDeRepos(azure);
  // La identidad del responsable de respaldo: una vez por corrida, y sólo si hay algo que pedir o que avisar:
  // el aviso de «cerrado con la vulnerabilidad viva» lleva la misma mención que el primer comentario.
  let respaldo = null, motivoRespaldo = null, respaldoLeido = false;
  const respaldoDe = () => {
    if (!respaldoLeido) {
      respaldoLeido = true;
      const r = quien.ok ? resolverIdentidad(az, quien.respaldo) : { ok: false, motivo: quien.motivo };
      if (r.ok) respaldo = { ...r, extra: maintainersDe(az, quien.maintainers || [], r.id, res) }; else motivoRespaldo = r.motivo;
    }
    return respaldo ? { ok: true, ...respaldo } : { ok: false, motivo: motivoRespaldo };
  };
  if (elegidas.length) respaldoDe();
  // el tipo del pedido de cada proyecto, con lo que configura la organización (operations.json → work_items)
  const workItems = quien.ok ? (quien.workItems || null) : null;
  const tipoDe = cacheDeTipos(az, workItems);

  // Lo que se lee UNA vez por proyecto por corrida (no por ficha).
  const cacheDueno = new Map(), cacheIter = new Map();
  const duenoDe = (p) => {
    if (!cacheDueno.has(p)) {
      // 🔴 El responsable declarado para el proyecto REEMPLAZA la deducción: no se leen los administradores.
      const declarado = quien.ok ? quien.declarado(p) : null;
      if (declarado) cacheDueno.set(p, { unico: true, asignado: declarado, motivo: 'declarado en operations.json', fallo: false });
      else {
        const a = leerAdministradores(az, p);
        cacheDueno.set(p, a.ok
          ? { ...deducirDueno(a.personas, quien.respaldo), fallo: false }
          : { unico: false, asignado: quien.respaldo, motivo: `no pude leer los administradores (${a.motivo})`, fallo: true });
      }
    }
    return cacheDueno.get(p);
  };
  const iteracionDe = (p) => {
    if (!cacheIter.has(p)) cacheIter.set(p, leerIteracion(az, p, hoy));
    return cacheIter.get(p);
  };
  const comentar = (id, html) => az(['boards', 'work-item', 'update', '--id', String(id), '--discussion', `@${archivo('comentario.html', html)}`],
    { valida: (v) => (v && v.id !== undefined ? null : 'la respuesta no trae «id»') });
  const deCategorias = cacheDeCategorias(az);
  // por proyecto y por el tipo del pedido (lo pone cerrarLeido/reabrirLeido, que ya leyeron el work item)
  const categoriasDe = (proyecto) => (tipo) => deCategorias(proyecto, tipo);
  const cerrar = (id, proyecto, idFicha) => cerrarPedido(az, id, proyecto, idFicha, categoriasDe(proyecto));
  const reabrir = (id, proyecto, idFicha, desde) => reabrirPedido(az, id, proyecto, idFicha, desde, categoriasDe(proyecto));

  // ── por par (ficha, proyecto) ──
  for (const x of elegidas) {
    const f = x.ficha, idFicha = f.idFicha;
    for (const p of x.faltan) {
      const fallo = (paso, motivo) => res.fallidos.push({ ficha: idFicha, proyecto: p, paso, motivo });
      if (!respaldo) { fallo('lead-identity', motivoRespaldo); continue; }
      if (!/^[A-Za-z0-9_-]+$/.test(idFicha)) { fallo('duplicados', `no pude consultar duplicados (el id «${idFicha}» no es seguro para una consulta)`); continue; }
      const otra = pedidoDelPaquete.get(clavePaquete(f, p));
      if (otra && otra.ficha !== idFicha) {
        fallo('duplicados', `otra ficha viva del mismo paquete ya tiene pedido en ${p}: ${otra.ficha} (Bug ${otra.id === null ? 'que se crearía esta noche' : otra.id}) — son dos fichas para el mismo hecho; una persona decide cuál queda`);
        continue;
      }

      // Duplicados: los pedidos del proyecto con la etiqueta exacta de la ficha. Una búsqueda que no se pudo hacer no crea.
      let w;
      try { w = await plataforma('work-item.find', { ...destino(p), tag: `arnes:${idFicha}` }); } catch { w = null; }
      if (!(w && w.ok === true && w.value && Array.isArray(w.value.ids))) {
        fallo('duplicados', `no pude consultar duplicados (${motivoDe(w)})`);
        continue;
      }
      const nuestros = w.value.ids.filter(Number.isInteger);
      if (nuestros.length > 1) { fallo('duplicados', `pedidos duplicados en Azure: ${[...nuestros].sort((a, b) => a - b).join(', ')} — una persona decide cuál queda`); continue; }
      if (nuestros.length === 1) {
        // 🔴 El Bug existe en Azure aunque la ficha no se pueda anotar: se registra ANTES, como en la
        // rama de crear. Si no, una segunda ficha del mismo paquete abriría otro Bug esa misma noche.
        pedidoDelPaquete.set(clavePaquete(f, p), { ficha: idFicha, id: nuestros[0] });
        if (!simulado) {
          try { anotarPedido(f.archivo, p, nuestros[0]); }
          catch (e) { fallo('escribir-ficha', `no pude anotar el pedido adoptado ${nuestros[0]}: ${e.message}`); continue; }
          // 🔴 El adoptado recibe la mención: si `crear` respondió con error
          // pero Azure sí lo creó, este Bug nunca tuvo su comentario, y «el responsable de respaldo va SIEMPRE». Si el que
          // se perdió fue el push, es un segundo comentario — ruido chico frente a un Bug sin mención.
          const adop = `<p>${mencionesDelArnes(respaldo)} — este pedido ya existía en Azure con la etiqueta <code>arnes:${escHtml(idFicha)}</code> y la ficha no lo tenía anotado (se perdió el registro de una noche anterior, o la creación respondió con error aunque se hizo): la revisión nocturna lo adopta.</p>`;
          const k = comentar(nuestros[0], adop);
          if (!k.ok) fallo('comentario', `adopté el Bug ${nuestros[0]} pero no pude comentarlo: ${k.motivo}`);
        }
        res.adoptados.push({ ficha: idFicha, proyecto: p, id: nuestros[0] });
        continue;
      }

      // Crear.
      // 🔴 Una lectura que NO SE PUDO HACER (administradores, iteración) no frena el pedido —cae en
      // el responsable de respaldo o en la raíz, y lo dice— pero SÍ es un fallo: el permiso de leer grupos es justo
      // el que nadie verificó con la identidad del pipeline, y si fallara todas las noches el aviso de
      // arranque tiene que decirlo, no esconderlo en `sin_dueno_unico`.
      const dueno = duenoDe(p);
      if (!dueno.unico) unaVez(res.sin_dueno_unico, { proyecto: p, motivo: dueno.motivo });
      if (dueno.fallo) fallo('administradores', dueno.motivo);
      const it = iteracionDe(p);
      if (it.motivo) unaVez(res.sin_iteracion, { proyecto: p, motivo: it.motivo });
      if (it.fallo) fallo('iteracion', it.motivo);
      const reposP = f.fi.listas.repos.filter((r) => proyectoAzureDe(r, cfg) === p);
      const titulo = `Dependencia vulnerable: ${f.fi.escalares.paquete} (${f.fi.escalares.severidad}) en ${reposP.join(', ')}`.slice(0, 250);
      const cuerpo = aHtml(cuerpoDeFicha({ paquete: f.fi.escalares.paquete, sev: f.fi.escalares.severidad,
        noches: f.fi.escalares.noches, repos: reposP, avisos: f.fi.listas.avisos, id: idFicha }, { destino: 'pedido' }));
      const comentario = [
        `<p>${mencionesDelArnes(respaldo)} — pedido abierto por la revisión nocturna de dependencias del arnés (ficha <code>arnes:${escHtml(idFicha)}</code>).</p>`,
        dueno.unico
          ? `<p>Asignado a <strong>${escHtml(dueno.asignado)}</strong>: ${escHtml(dueno.motivo)}.</p>`
          : `<p>Asignado al responsable de respaldo (<strong>${escHtml(dueno.asignado)}</strong>) — ${escHtml(dueno.motivo)}.</p>`,
      ].join('\n');

      const t = tipoDe(p);
      if (!t.ok) { fallo('tipo', t.motivo); continue; }
      if (t.deFabrica && t.motivoFabrica) unaVez(res.tipo_de_fabrica, { proyecto: p, tipo: t.tipo, motivo: t.motivoFabrica });
      const severidadFicha = f.fi.escalares.severidad;
      // los campos se arman antes del simulado: un obligatorio sin cubrir se ve también sin crear nada
      const pc = camposDelPedido(t, workItems, severidadFicha, '<cuerpo>');
      if (!pc.ok) { fallo('campos', pc.motivo); continue; }
      if (simulado) {
        res.creados.push({ ficha: idFicha, proyecto: p, id: null, tipo: t.tipo, asignado_a: dueno.asignado, motivo_dueno: dueno.motivo, iteracion: it.ruta });
        textos.push({ proyecto: p, ficha: idFicha, titulo, cuerpo, comentario });
        pedidoDelPaquete.set(clavePaquete(f, p), { ficha: idFicha, id: null });
        continue;
      }
      const { campos } = camposDelPedido(t, workItems, severidadFicha, cuerpo);
      // la gravedad va siempre en una etiqueta (y en el cuerpo): no todos los tipos tienen Severity
      const gravedad = /^[a-z]+$/.test(String(severidadFicha || '')) ? [`arnes-gravedad:${severidadFicha}`] : [];
      let c;
      try {
        c = await plataforma('work-item.create', { ...destino(p), type: t.tipo, title: titulo, iteration: it.ruta, description: cuerpo,
          tags: ['arnes-hallazgo', `arnes:${idFicha}`, ...gravedad],
          // la asignación va como campo, cruda, y no como asignado del conector (ver `deducirDueno`): así la valida
          // Azure en vez de perderse sin aviso
          fields: { 'System.AssignedTo': dueno.asignado, ...campos }, forNight: true });
      } catch { c = null; }
      if (!(c && c.ok === true && c.value && Number.isInteger(c.value.id))) { fallo('crear', `la plataforma no creó el Bug (${motivoDe(c)})`); continue; }
      const id = c.value.id;
      pedidoDelPaquete.set(clavePaquete(f, p), { ficha: idFicha, id });
      // El id va a la ficha ANTES del comentario: si el comentario falla, sin el id mañana se crearía otro.
      try { anotarPedido(f.archivo, p, id); }
      catch (e) { fallo('escribir-ficha', `el Bug ${id} se creó pero no pude anotarlo en la ficha: ${e.message} — mañana se adopta por la etiqueta`); }
      const k = comentar(id, comentario);
      if (!k.ok) fallo('comentario', `el Bug ${id} se creó sin su comentario: ${k.motivo}`);
      res.creados.push({ ficha: idFicha, proyecto: p, id, tipo: t.tipo, asignado_a: dueno.asignado, motivo_dueno: dueno.motivo, iteracion: it.ruta });
    }
  }

  avisos(ctx, res, comentar, cerrar, reabrir, respaldoDe, (id, proyecto, idFicha) => leerSuPedido(az, id, proyecto, idFicha));
  avisarCerradosVivos(ctx, res, comentar, respaldoDe, textos);

  // Lo que SIGUE sin pedido al terminar: es lo que el resumen tiene que listar como fallo de creación.
  // 🔴 Recorrido en orden de id: el snapshot se commitea cada noche, y el orden de `readdirSync` no
  // está garantizado — un orden distinto con el mismo contenido es un diff que no dice nada.
  const postergadasIds = new Set(postergadas.map((x) => x.ficha.idFicha));
  for (const x of pares.filter((y) => y.faltan.length || y.desconocidos.length)
    .sort((a, b) => String(a.ficha.idFicha).localeCompare(String(b.ficha.idFicha)))) {
    let faltan = x.faltan;
    if (simulado) {
      // 🔴 Simulado no escribe la ficha: lo que esta corrida habría creado o adoptado sale de lo que ella
      // misma registró. Si no, el mismo par saldría en «habría creado» y en «sin pedido desde hace N días»,
      // justo en la salida que se lee para decidir si encender los pedidos.
      const saldria = new Set([...res.creados, ...res.adoptados].filter((y) => y.ficha === x.ficha.idFicha).map((y) => y.proyecto));
      faltan = faltan.filter((p) => !saldria.has(p));
    } else {
      try {
        const ya = new Set(leerPedidos(fs.readFileSync(x.ficha.archivo, 'utf8')).map((y) => y.proyecto));
        faltan = faltan.filter((p) => !ya.has(p));
      } catch { /* la ficha no se pudo releer: se informa con lo que se sabía */ }
    }
    if (!faltan.length && !x.desconocidos.length) continue;
    const partes = [];
    if (x.desconocidos.length) partes.push(`repo(s) fuera de repos.json: ${x.desconocidos.join(', ')} — sin proyecto de Azure conocido, no se les pide`);
    if (postergadasIds.has(x.ficha.idFicha)) partes.push('postergada por el tope de la noche');
    // 🔴 El fallo que explica ESTA ausencia: de un proyecto que sigue sin pedido y de un paso que lo
    // impidió. Con «el primero de la ficha» saldría «falló administradores» sobre el proyecto donde el que
    // falló fue `crear`.
    // Una razón POR PROYECTO: con dos trabados por motivos distintos, una sola razón haría leer el
    // problema de uno como si fuera el del otro.
    const razones = faltan.map((proy) => {
      const suyo = res.fallidos.find((y) => y.ficha === x.ficha.idFicha && y.proyecto === proy && isNoWorkItemStep(y.paso));
      return suyo ? `${faltan.length > 1 ? `${proy}: ` : ''}falló ${suyo.paso}: ${suyo.motivo}` : null;
    }).filter(Boolean);
    partes.push(...razones);
    if (simulado && !partes.length) partes.push('modo simulado: no se crea nada');
    const desde = [x.ficha.fi.escalares.detectado, x.ficha.fi.escalares.reaparecido].filter(Boolean).sort().pop();
    const dias = desde ? diasEntre(desde, hoy) : NaN;
    if (faltan.length && dias >= DIAS_SIN_PEDIDO) partes.push(`sin pedido en ${faltan.join(', ')} desde hace ${dias} días`);
    res.sin_pedido.push({ ficha: x.ficha.idFicha, proyectos: faltan, motivo: partes.join(' · ') || 'sin pedido' });
  }
  res.sin_pedido.sort(porFicha); res.pagados_avisados.sort(porFicha); res.deuda_avisada.sort(porFicha); res.reabiertos.sort(porFicha);
  res.cerrados_vivos_avisados.sort(porFicha); res.huerfanos_adoptados.sort(porFicha);
  return { res, textos, avisosDeSalida: ctx.avisosDeSalida || [] };
}

/**
 * Cierra un pedido cuya parte se pagó en `main`. `{ ok: true, cerrado: true|false, estado, motivo_azure }`
 * o `{ ok: false, motivo }`.
 *
 * 🔴 Si el arreglo ya está en `main`, el Bug está arreglado; cuándo subirlo a prod es una decisión del
 * equipo. Por eso el aviso «ya no aparece» además lo cierra.
 * La deuda declarada no cierra (no es un arreglo) y el cruce no cambia estados.
 *
 * · El estado de cierre sale de las categorías del proyecto (el único de categoría `Completed`), no de
 *   un nombre fijo: Agile es Closed, Scrum es Done. Cero o más de uno → no se cierra y se dice.
 * · No se manda motivo. Con validateOnly se ve que Azure pone «Fixed and verified» (New →
 *   Closed), «Verified» (Resolved → Closed) y «Work finished» (New → Done) — los tres en
 *   `motivos_arreglado`, así que el cruce lo lee como arreglado.
 * · Un Bug que una persona ya cerró, quitó o resolvió (Completed, Removed, Resolved), o que creó una persona,
 *   no se toca: `cerrado: false`. Uno que no es el Bug de la ficha (otro proyecto, otro tipo, sin su
 *   etiqueta) tampoco, y además no se comenta (`ajeno`).
 */
/**
 * Lee el work item y verifica que sea SU Bug antes de cambiarle el estado: el proyecto de la línea de
 * `pedidos:`, un Bug, con la etiqueta de la ficha (un id mal anotado cerraría un work
 * item ajeno — los ids son únicos en la organización). `{ ok, fields }` · `{ ok: false, ajeno, motivo }`.
 */
function leerSuPedido(az, id, proyecto, idFicha) {
  const s = az(['boards', 'work-item', 'show', '--id', String(id)],
    { valida: (v) => (v && v.fields && typeof v.fields['System.State'] === 'string' ? null : 'la respuesta no trae «fields.System.State»') });
  if (!s.ok) return { ok: false, motivo: `no pude leer el pedido ${id} (${s.motivo})` };
  const f = s.valor.fields;
  const tp = f['System.TeamProject'];
  const tipo = f['System.WorkItemType'];
  // Propio por las etiquetas, no por el tipo: una organización puede pasar el pedido a otro tipo de work item y el
  // nocturno lo tiene que seguir cerrando, reabriendo y comentando. El creador NO cuenta acá a propósito: lo mira
  // cerrarLeido (sólo cierra lo que creó el arnés); una copia hecha por una persona sigue recibiendo el aviso.
  const tokens = tokensDeEtiquetas(f['System.Tags']);
  const conEtiqueta = tokens.includes(`arnes:${idFicha}`.toLowerCase());
  const delArnes = tokens.includes('arnes-hallazgo');
  if (tp !== proyecto || !conEtiqueta || !delArnes) {
    const falta = [conEtiqueta ? null : `arnes:${idFicha}`, delArnes ? null : 'arnes-hallazgo'].filter(Boolean);
    return { ok: false, ajeno: true, motivo: `el work item ${id} no es el pedido de esta ficha en ${proyecto} (proyecto ${tp || '?'}, tipo ${tipo || '?'}${falta.length ? `, sin la etiqueta ${falta.join(' ni ')}` : ''})` };
  }
  return { ok: true, fields: f };
}

function cerrarPedido(az, id, proyecto, idFicha, categoriasDe) {
  const b = leerSuPedido(az, id, proyecto, idFicha);
  if (!b.ok) return b;
  return { ...cerrarLeido(az, id, proyecto, b.fields, categoriasDe), fields: b.fields };
}

function cerrarLeido(az, id, proyecto, f, categoriasDe) {
  // 🔴 Sólo cierra lo que creó el arnés: una COPIA hecha por una persona (con las mismas etiquetas) se adopta
  // como pedido y se cerraría esa misma noche. Persona = descriptor que no empieza con `svc.` (la regla del cruce).
  const creador = f['System.CreatedBy'];
  const desc = creador && typeof creador === 'object' ? String(creador.descriptor || '') : '';
  if (!desc.startsWith('svc.')) return { ok: true, cerrado: false, porque: 'persona', motivo_azure: null };
  const tipo = f['System.WorkItemType'];
  const cat = categoriasDe(tipo);
  if (!cat || !cat.categorias) return { ok: false, motivo: (cat && cat.motivo) || `no pude leer las categorías de estado de ${proyecto}` };
  const completos = Object.keys(cat.categorias).filter((e) => cat.categorias[e] === 'Completed');
  if (completos.length !== 1) {
    return { ok: false, motivo: `el tipo ${tipo} de ${proyecto} tiene ${completos.length} estado(s) de cierre (${completos.join(', ') || 'ninguno'}): no sé a cuál cerrarlo` };
  }
  const actual = f['System.State'];
  if (['Completed', 'Removed'].includes(cat.categorias[actual])) return { ok: true, cerrado: false, porque: 'ya-cerrado', motivo_azure: null };
  // Resolved = una persona ya decidió («Fixed», pero también «As Designed», «Duplicate»…): no se pisa.
  if (cat.categorias[actual] === 'Resolved') return { ok: true, cerrado: false, porque: 'resuelto', motivo_azure: null };
  const destino = completos[0];
  const u = az(['boards', 'work-item', 'update', '--id', String(id), '--state', destino],
    { valida: (v) => (v && v.fields && v.fields['System.State'] === destino ? null : `la respuesta no dice que quedó en «${destino}»`) });
  if (!u.ok) return { ok: false, motivo: `no pude cerrar el pedido ${id} (${u.motivo})` };
  return { ok: true, cerrado: true, porque: null, motivo_azure: u.valor.fields['System.Reason'] || null };
}

/**
 * Reabre un pedido que cerró el ARNÉS y cuya vulnerabilidad volvió a ese proyecto
 * (si no, el tablero del equipo dice «Closed» con la vulnerabilidad viva y sólo el responsable de respaldo se entera).
 * `{ ok: true, reabierto: true|false, porque }` o `{ ok: false, ajeno?, motivo }`.
 *
 * · Sólo si sigue cerrado (categoría Completed) y NADIE le cambió el estado después del cierre del arnés: la
 *   fecha del último cambio de estado tiene que ser la de la marca (`desde`). Si una persona lo tocó, decide ella.
 * · Al primer estado «Proposed» del proyecto (New), sin motivo. Con validateOnly:
 *   Closed→New pone «Not fixed» (Agile) y Done→New «Moved to the backlog» (Scrum).
 */
function reabrirPedido(az, id, proyecto, idFicha, desde, categoriasDe) {
  const b = leerSuPedido(az, id, proyecto, idFicha);
  if (!b.ok) return b;
  return { ...reabrirLeido(az, id, proyecto, desde, b.fields, categoriasDe), fields: b.fields };
}

function reabrirLeido(az, id, proyecto, desde, f, categoriasDe) {
  const tipo = f['System.WorkItemType'];
  const cat = categoriasDe(tipo);
  if (!cat || !cat.categorias) return { ok: false, motivo: (cat && cat.motivo) || `no pude leer las categorías de estado de ${proyecto}` };
  if (cat.categorias[f['System.State']] !== 'Completed') return { ok: true, reabierto: false, porque: 'no-esta-cerrado' };
  const cambio = String(f['Microsoft.VSTS.Common.StateChangeDate'] || '').slice(0, 10);
  if (cambio !== desde) return { ok: true, reabierto: false, porque: 'lo-toco-una-persona' };
  const destino = Object.keys(cat.categorias).find((e) => cat.categorias[e] === 'Proposed');
  if (!destino) return { ok: false, motivo: `el tipo ${tipo} de ${proyecto} no tiene un estado inicial al que reabrirlo` };
  const u = az(['boards', 'work-item', 'update', '--id', String(id), '--state', destino],
    { valida: (v) => (v && v.fields && v.fields['System.State'] === destino ? null : `la respuesta no dice que quedó en «${destino}»`) });
  if (!u.ok) return { ok: false, motivo: `no pude reabrir el pedido ${id} (${u.motivo})` };
  return { ok: true, reabierto: true, porque: null };
}

/**
 * «En tu proyecto ya no aparece» y «quedó declarada». Un comentario, una vez. El
 * primero además CIERRA el Bug (`cerrarPedido`); el de la deuda lo deja abierto.
 *
 * Se miran TODAS las fichas con pedidos, no sólo las vivas: la noche en que una ficha se resuelve es
 * justamente la noche en que ya no aparece en ningún proyecto. Los repos de un proyecto salen de
 * `repos.json` (la ficha pierde de `repos:` los repos donde ya no está), y si alguno no se midió, no se
 * avisa: «no medido» nunca es «limpio».
 */
/**
 * Las menciones de un aviso del arnés en un Bug: quien lo tiene asignado, el responsable de respaldo y quienes mantienen
 * el arnés, una vez cada uno.
 * 🔴 En esta organización cambiar el estado de un Bug no manda mail a nadie
 * (medido: las únicas suscripciones de work items son «asignado» y «reacción»); una mención sí.
 */
function menciones(respaldo, fields) {
  const personas = [];
  const asg = fields && fields['System.AssignedTo'];
  if (asg && typeof asg === 'object' && asg.id) personas.push({ id: String(asg.id), nombre: asg.displayName || asg.uniqueName || 'responsable' });
  for (const x of respaldo && respaldo.ok ? [respaldo, ...(respaldo.extra || [])] : []) {
    if (!personas.some((y) => y.id.toLowerCase() === String(x.id).toLowerCase())) personas.push({ id: String(x.id), nombre: x.nombre });
  }
  return personas.map((x) => `<a href="#" data-vss-mention="version:2.0,${escHtml(x.id)}">@${escHtml(x.nombre)}</a>`).join(' ');
}

function avisos(ctx, res, comentar, cerrar, reabrir, respaldoDe, leerBug) {
  const { cfg, snap, hoy, simulado, fichas } = ctx;
  // El prefijo de menciones de cada aviso. Sin la identidad del responsable de respaldo el aviso sale igual (el cierre o la
  // reapertura ya ocurrió: callarlo sería peor) y el fallo se dice.
  const prefijo = (ficha, proyecto, fields) => {
    const respaldo = respaldoDe();
    if (!respaldo.ok) res.fallidos.push({ ficha, proyecto, paso: 'mencion', motivo: `el aviso salió sin mencionar al responsable de respaldo: ${respaldo.motivo}` });
    const m = menciones(respaldo, fields);
    return m ? `${m} — ` : '';
  };
  // 🔴 Sin `presencias` el snapshot no dice «no aparece en ningún lado»: dice «no sé». Nada que avisar ni cerrar.
  if (!Array.isArray(snap.presencias)) return;
  const medidos = new Set((snap.repos || []).filter((r) => r.medido).map(etiqueta));
  const enConfig = new Set((cfg.repos || []).map(etiqueta));
  for (const f of [...fichas].sort((a, b) => String(a.idFicha).localeCompare(String(b.idFicha)))) {
    const pedidos = leerPedidos(f.txt);
    if (!pedidos.length) continue;
    const paquete = String(f.fi.escalares.paquete || '').toLowerCase();
    for (const { proyecto, id } of pedidos) {
      const reposP = (cfg.repos || []).filter((r) => proyectoDe(etiqueta(r), cfg) === proyecto);
      if (!reposP.length || !reposP.every((r) => r.activo !== false && medidos.has(etiqueta(r)))) continue;
      // 🔴 Un repo de la ficha que ya no está en repos.json no se mide y su proyecto no se conoce: bloquea, como
      // en el cruce (si no, se cerraría el Bug con ese repo jamás medido).
      if ([...f.fi.listas.repos, ...(f.fi.listas.declarada_en || []).map(noc.soloRepo)].some((r) => r && !enConfig.has(r))) continue;
      const etiquetas = new Set(reposP.map(etiqueta));
      const presente = [];
      for (const p of snap.presencias || []) {
        const suya = f.ids.includes(p.id) || (paquete && String(p.paquete || '').toLowerCase() === paquete);
        if (suya) for (const x of p.repos || []) if (etiquetas.has(x.repo)) presente.push(x);
      }
      let clave, linea, html, entrada, lista;
      // 🔴 Volvió a aparecer en ESTE proyecto: su «ya no aparece» ya no vale, y el próximo arreglo
      // tiene que poder avisarse. Se borra sólo el de este proyecto — el de otro proyecto de la misma ficha,
      // donde nada cambió, se conserva (si no, recibiría otro «ya no aparece»).
      if (presente.length && !simulado) {
        const txtActual = fs.readFileSync(f.archivo, 'utf8');
        const pagados = listaDe(txtActual, 'pagado_avisado');
        const marca = pagados.find((l) => l.startsWith(`${proyecto} (`));
        // 🔴 Si el que cerró fue el arnés, se reabre. Un Bug ajeno no se toca ni se comenta; si la
        // reapertura falla, el aviso sale igual. La marca se borra en todos los casos: la próxima vez que se
        // arregle tiene que poder volver a cerrarse y avisarse.
        const desde = marca && (marca.match(/^.* \((\d{4}-\d{2}-\d{2}), cerrado por el arnés\)$/) || [])[1];
        if (desde) {
          const r = reabrir(id, proyecto, f.idFicha, desde);
          let html = null;
          if (!r.ok) {
            res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'reabrir', motivo: r.motivo });
            if (!r.ajeno) html = `<p>${prefijo(f.idFicha, proyecto, r.fields)}Volvió a aparecer en tu proyecto — medido el ${hoy}. No pude reabrirlo (${escHtml(r.motivo)}): reabrilo vos. Lo había cerrado la revisión nocturna el ${escHtml(desde)}.</p>`;
          } else if (r.reabierto) {
            html = `<p>${prefijo(f.idFicha, proyecto, r.fields)}Volvió a aparecer en tu proyecto — medido el ${hoy}. Reabro este pedido: lo había cerrado la revisión nocturna el ${escHtml(desde)}, cuando dejó de verla (ficha <code>arnes:${escHtml(f.idFicha)}</code>).</p>`;
            res.reabiertos.push({ ficha: f.idFicha, proyecto, id });
          }
          if (html) {
            const k = comentar(id, html);
            if (!k.ok) res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'comentario', motivo: `no pude avisar en el Bug ${id}: ${k.motivo}` });
          }
        }
        if (marca) {
          try { fs.writeFileSync(f.archivo, ponerLista(fs.readFileSync(f.archivo, 'utf8'), 'pagado_avisado', pagados.filter((l) => !l.startsWith(`${proyecto} (`)))); }
          catch (e) { res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'escribir-ficha', motivo: `no pude borrar el «ya no aparece» de ${proyecto}: ${e.message}` }); }
        }
      }
      if (!presente.length) {
        clave = 'pagado_avisado'; linea = `${proyecto} (${hoy})`;
        if (listaDe(fs.readFileSync(f.archivo, 'utf8'), clave).some((l) => l.startsWith(`${proyecto} (`))) continue;
        entrada = { ficha: f.idFicha, proyecto, id, cerrado: null, motivo_azure: null }; lista = res.pagados_avisados;
        // 🔴 Primero el cierre, después el comentario, después la marca. Un work item AJENO no se cierra ni se
        // comenta. Si el cierre falla por otra cosa, el aviso sale igual diciendo que no se pudo
        // (un fallo permanente —una regla del proceso, un permiso— dejaría al equipo sin el «ya no
        // aparece») y queda marcado. Nunca un «Cierro este Bug» sobre un Bug que quedó abierto.
        let porque = null;
        let noPude = null;
        let leidos = null;
        if (!simulado) {
          const c = cerrar(id, proyecto, f.idFicha);
          leidos = c.fields || null;
          if (!c.ok) {
            res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'cerrar', motivo: c.motivo });
            if (c.ajeno) continue;
            noPude = c.motivo; entrada.cerrado = false;
          } else { entrada.cerrado = c.cerrado; entrada.motivo_azure = c.motivo_azure; porque = c.porque; }
        }
        const m = simulado ? '' : prefijo(f.idFicha, proyecto, leidos);
        // La marca dice si lo cerró el arnés: es lo único que habilita reabrirlo si la vulnerabilidad vuelve.
        if (entrada.cerrado) linea = `${proyecto} (${hoy}, cerrado por el arnés)`;
        const pie = `<p>La revisión nocturna de dependencias dejó de ver la vulnerabilidad, como alta o crítica, en todos los repos de este proyecto (ficha <code>arnes:${escHtml(f.idFicha)}</code>). Si vuelve a aparecer, se va a ver.</p>`;
        html = entrada.cerrado
          ? `<p>${m}En tu proyecto ya no aparece — medido el ${hoy}. Cierro este pedido: el arreglo está en <code>main</code>; cuándo llega a producción lo decide el equipo.</p>\n${pie}`
          : noPude ? `<p>${m}En tu proyecto ya no aparece — medido el ${hoy}. No pude cerrarlo (${escHtml(noPude)}): cerralo vos si corresponde.</p>\n${pie}`
            : porque === 'ya-cerrado' ? `<p>${m}En tu proyecto ya no aparece — medido el ${hoy}.</p>\n${pie}`
              : `<p>${m}En tu proyecto ya no aparece — medido el ${hoy}; cerralo si corresponde.</p>\n${pie}`;
      } else if (presente.every((x) => x.declarada)) {
        const vence = presente.map((x) => x.vence || 'sin fecha').sort()[0];
        clave = 'deuda_avisada'; linea = `${proyecto} (vence ${vence})`;
        if (yaMarcado(fs.readFileSync(f.archivo, 'utf8'), clave, linea)) continue;
        // El Bug se lee para mencionar a su responsable (y para no comentar un work item ajeno). Si no se puede
        // leer, el aviso sale sólo con la mención al responsable de respaldo.
        let m = '';
        if (!simulado) {
          const b = leerBug(id, proyecto, f.idFicha);
          if (!b.ok && b.ajeno) { res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'comentario', motivo: b.motivo }); continue; }
          m = prefijo(f.idFicha, proyecto, b.ok ? b.fields : null);
        }
        html = `<p>${m}En tu proyecto quedó declarada como deuda, vence ${escHtml(vence)}.</p>\n<p>Mientras la declaración esté vigente la revisión nocturna no insiste; cuando venza vuelve a contar (ficha <code>arnes:${escHtml(f.idFicha)}</code>).</p>`;
        entrada = { ficha: f.idFicha, proyecto, id, vence }; lista = res.deuda_avisada;
      } else continue;
      if (!simulado) {
        const k = comentar(id, html);
        if (!k.ok) { res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'comentario', motivo: `no pude avisar en el Bug ${id}: ${k.motivo}` }); continue; }
        try { marcar(f.archivo, clave, proyecto, linea); }
        catch (e) { res.fallidos.push({ ficha: f.idFicha, proyecto, paso: 'escribir-ficha', motivo: `avisé en el Bug ${id} pero no pude marcarlo: ${e.message}` }); }
      }
      lista.push(entrada);
    }
  }
}

// ── el estado de cada pedido ───────────────────────────────────────────────────────

/**
 * La revisión más reciente de una PERSONA: `{ el, nombre }` o `{ el: null, nombre: null }`.
 *
 * 🔴 Persona = `System.ChangedBy.descriptor` que NO empieza con `svc.` (el
 * pipeline es `svc.…`, una persona `msa.…` o `aad.…`). No se escribe el id del build service en ningún
 * lado: si Azure cambiara la identidad del pipeline, un id fijo dejaría de excluirla sin error. Una
 * revisión SIN descriptor legible cuenta como persona: ante la duda, «nadie la miró» no se afirma.
 */
function personaMasReciente(revisiones) {
  let mejor = null;
  for (const r of revisiones || []) {
    const f = (r && r.fields) || {};
    const quien = f['System.ChangedBy'];
    const desc = quien && typeof quien === 'object' ? String(quien.descriptor || '') : '';
    if (desc.startsWith('svc.')) continue;
    const t = Date.parse(f['System.ChangedDate']);
    if (Number.isNaN(t)) continue;
    if (!mejor || t > mejor.t) {
      mejor = { t, el: f['System.ChangedDate'], nombre: quien && typeof quien === 'object' ? (quien.displayName || null) : (quien ? String(quien) : null) };
    }
  }
  return mejor ? { el: mejor.el, nombre: mejor.nombre } : { el: null, nombre: null };
}

/**
 * Las categorías de estado de un TIPO de work item en un proyecto: `{ categorias: { <estado>: <categoría> }, motivo: null }`
 * o `{ categorias: null, motivo }`. Las del pedido salen de su propio tipo: un tipo propio de la organización
 * tiene sus estados («Identificado … Cerrado»), y los del Bug no le sirven. Sin tipo, o sin poder leerlas, `categorias` es
 * null: quien la llama no cierra ni reabre ese pedido (falla cerrado) y el motivo dice el tipo.
 */
function leerCategorias(az, proyecto, tipo) {
  if (typeof tipo !== 'string' || !tipo.trim()) return { categorias: null, motivo: `el pedido de ${proyecto} no dice su tipo de work item: no sé qué categorías de estado leer` };
  const r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'workItemTypeStates', '--route-parameters',
    `project=${proyecto}`, `type=${tipo}`, '--api-version', '7.1'],
  { valida: (v) => (v && Array.isArray(v.value) && v.value.length
    && v.value.every((x) => x && typeof x.name === 'string' && typeof x.category === 'string') ? null : 'la respuesta no trae «value[].category»') });
  if (!r.ok) return { categorias: null, motivo: `no pude leer las categorías de estado de ${proyecto} (tipo ${tipo}: ${r.motivo})` };
  return { categorias: Object.fromEntries(r.valor.value.map((x) => [x.name, x.category])), motivo: null };
}

/**
 * Una caché de categorías por proyecto y por tipo: `de(proyecto, tipo)`. `de.porProyecto()` arma lo que el volcado
 * publica en `proyectos`: por proyecto, las del Bug (o las del primer tipo leído, si no se leyó el Bug) como siempre, y
 * en `tipos` las de cada tipo que se leyó.
 */
function cacheDeCategorias(az) {
  const cache = new Map();
  const de = (proyecto, tipo) => {
    const k = JSON.stringify([proyecto, tipo]);
    if (!cache.has(k)) cache.set(k, leerCategorias(az, proyecto, tipo));
    return cache.get(k);
  };
  de.porProyecto = () => {
    const out = {};
    for (const [k, v] of cache.entries()) {
      const [p, t] = JSON.parse(k);
      const tipoDe = typeof t === 'string' && t ? t : '(sin tipo)';
      if (!out[p]) out[p] = { tipos: {} };
      out[p].tipos[tipoDe] = v;
    }
    for (const p of Object.keys(out)) {
      const base = out[p].tipos.Bug || Object.values(out[p].tipos)[0];
      out[p] = { categorias: base.categorias, motivo: base.motivo, tipos: out[p].tipos };
    }
    return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
  };
  return de;
}

/** Un pedido por id: el `show` y sus revisiones. `{ ok, fields, revisiones }` o `{ ok: false, motivo }`. */
function leerPedidoDeAzure(az, id) {
  const s = az(['boards', 'work-item', 'show', '--id', String(id)],
    { valida: (v) => (v && v.fields && typeof v.fields['System.State'] === 'string' ? null : 'la respuesta no trae «fields.System.State»') });
  if (!s.ok) {
    // 🔴 «No existe» y «sin permiso» son el mismo TF401232 y las dos son «no leído», nunca «sin pedido».
    return { ok: false, motivo: /TF401232/.test(s.motivo) ? `no existe o sin permiso de lectura (${recortar(s.motivo, 160)})` : `no pude leer el work item (${s.motivo})` };
  }
  const r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'revisions', '--route-parameters', `id=${id}`, '--api-version', '7.1'],
    { valida: (v) => (v && Array.isArray(v.value) ? null : 'la respuesta no trae «value»') });
  if (!r.ok) return { ok: false, motivo: `no pude leer las revisiones (${r.motivo})` };
  return { ok: true, fields: s.valor.fields, revisiones: r.valor.value };
}

/**
 * Los Bugs del arnés que NINGUNA ficha nombra: el caso es que `crear` sale
 * bien, el push con el id se pierde y la ficha se cierra la noche siguiente. La adopción por etiqueta
 * sólo mira fichas vivas, así que ese Bug no lo encuentra nadie.
 *
 * Una WIQL por proyecto declarado, SIEMPRE con `[System.TeamProject] = @project` (la ruta sola no acota:
 * devuelve work items de otros proyectos). Un proyecto cuya consulta o cuyo `show` falla va a `no_consultados` y lo que ya
 * se había encontrado ahí se descarta: «encontré uno» sobre una lectura a medias no es «estos son todos».
 */
function buscarHuerfanos(az, cfg, nombrados, categoriasDe, archivo) {
  const huerfanos = [], noConsultados = [];
  const proyectos = [...new Set((cfg.repos || []).map((r) => proyectoAzureDe(etiqueta(r), cfg)).filter(Boolean))].sort();
  for (const p of proyectos) {
    const consulta = archivo('wiql-huerfanos.json', JSON.stringify({
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'arnes-hallazgo'",
    }));
    const w = az(['devops', 'invoke', '--area', 'wit', '--resource', 'wiql', '--route-parameters', `project=${p}`,
      '--http-method', 'POST', '--in-file', consulta, '--api-version', '7.1'],
    { valida: (v) => (v && Array.isArray(v.workItems) ? null : 'la respuesta no trae «workItems»') });
    if (!w.ok) { noConsultados.push({ proyecto: p, motivo: `no pude consultar los Bugs del arnés (${w.motivo})` }); continue; }
    const candidatos = [...new Set(w.valor.workItems.map((i) => i && i.id).filter(Number.isInteger))].filter((id) => !nombrados.has(id)).sort((a, b) => a - b);
    const deEste = [];
    let fallo = null;
    for (const id of candidatos) {
      const s = az(['boards', 'work-item', 'show', '--id', String(id)],
        { valida: (v) => (v && v.fields ? null : 'la respuesta no trae «fields»') });
      if (!s.ok) { fallo = `no pude leer el work item ${id} (${s.motivo})`; break; }
      const tokens = tokensDeEtiquetas(s.valor.fields['System.Tags']);
      if (!tokens.includes('arnes-hallazgo')) continue;          // CONTAINS es por substring: se confirma exacto
      const tok = tokens.find((x) => x.startsWith('arnes:'));
      const estado = typeof s.valor.fields['System.State'] === 'string' ? s.valor.fields['System.State'] : null;
      const cats = categoriasDe(p, s.valor.fields['System.WorkItemType']).categorias;
      deEste.push({ id, proyecto: p, ficha: tok ? tok.slice('arnes:'.length) : null, estado,
        categoria: cats && estado && Object.prototype.hasOwnProperty.call(cats, estado) ? cats[estado] : null });
    }
    if (fallo) { noConsultados.push({ proyecto: p, motivo: fallo }); continue; }
    huerfanos.push(...deEste);
  }
  return { huerfanos, noConsultados };
}

const escribirJsonAtomico = (archivo, obj) => {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, archivo);
};

/** `state`: el volcado. Sale 2 (y lo escribe con `consultado: false`) si no pudo intentar nada. */
function volcar(a) {
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  const destino = path.join(a.out, `bugs-${hoy}.json`);
  const noPudoVolcar = (motivo) => {
    try { escribirJsonAtomico(destino, { fecha: hoy, consultado: false, motivo }); }
    catch (e) { console.error(`🔴 estado de los pedidos: tampoco se pudo escribir ${destino}: ${e.message}`); }
    console.error(`🔴 estado de los pedidos: NO se pudo leer nada — ${motivo}`);
    console.error('   Esto es «no leído», no «coinciden»: el nocturno lo cobra como tal.');
    return 2;
  };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(a.config, 'utf8')); } catch (e) { return noPudoVolcar(`no se pudo leer la configuración ${a.config}: ${e.message}`); }
  const azure = cfg.azure || {};
  if (!azure.org) return noPudoVolcar('falta `azure.org` en la configuración');
  if (!process.env.AZURE_DEVOPS_EXT_PAT) return noPudoVolcar('sin token: AZURE_DEVOPS_EXT_PAT está vacío');
  const cmd = process.env.TYCON_ADO_CMD || 'az';
  const ver = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (ver.error || ver.status !== 0) return noPudoVolcar(`\`${cmd} --version\` no responde (${ver.error ? ver.error.message : `salió ${ver.status}`})`);

  const az = crearAz({ cmd, org: azure.org });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estado-de-pedidos-'));
  let n = 0;
  const archivo = (nombre, contenido) => { const p = path.join(tmp, `${++n}-${nombre}`); fs.writeFileSync(p, contenido); return p; };
  try {
    const todas = leerTodasLasFichas(a.pending);
    const categoriasDe = cacheDeCategorias(az);   // (proyecto, tipo): las del tipo de cada pedido
    const pedidos = {};
    // Ordenado por ficha: el archivo se commitea cada noche, y el orden del disco no está garantizado.
    for (const f of todas.filter((x) => x.estado !== 'archived').sort((x, y) => String(x.idFicha).localeCompare(String(y.idFicha)))) {
      for (const { proyecto, id } of leerPedidos(f.txt)) {
        if (Object.prototype.hasOwnProperty.call(pedidos, id)) continue;      // un id es único en la organización
        // 🔴 LISTA BLANCA: estos campos y ninguno más. Nunca `fields` entero.
        const e = { ficha: f.idFicha, proyecto, leido: false, estado: null, categoria: null, motivo: null,
          estado_desde: null, cambiado_por_persona_el: null, cambiado_por_persona: null, asignado: null, sin_asignar: null, motivo_no_leido: null };
        pedidos[id] = e;
        const w = leerPedidoDeAzure(az, id);
        if (!w.ok) { e.motivo_no_leido = w.motivo; continue; }
        const cats = categoriasDe(proyecto, w.fields['System.WorkItemType']);
        if (!cats.categorias) { e.motivo_no_leido = cats.motivo; continue; }
        const estado = w.fields['System.State'];
        if (!Object.prototype.hasOwnProperty.call(cats.categorias, estado)) { e.motivo_no_leido = `el estado ${estado} no está en las categorías de ${proyecto}`; continue; }
        const persona = personaMasReciente(w.revisiones);
        Object.assign(e, { leido: true, estado, categoria: cats.categorias[estado],
          motivo: typeof w.fields['System.Reason'] === 'string' ? w.fields['System.Reason'] : null,
          estado_desde: w.fields['Microsoft.VSTS.Common.StateChangeDate'] || null,
          cambiado_por_persona_el: persona.el, cambiado_por_persona: persona.nombre, asignado: nombreDeAsignado(w.fields['System.AssignedTo']),
          sin_asignar: !w.fields['System.AssignedTo'] });
      }
    }
    // Nombrado = en `pedidos:` de CUALQUIER ficha, archivadas incluidas: un Bug de una ficha descartada
    // tiene dueño aunque nadie lo mire; no es un suelto.
    const nombrados = new Set(todas.flatMap((f) => leerPedidos(f.txt).map((x) => x.id)));
    const { huerfanos, noConsultados } = buscarHuerfanos(az, cfg, nombrados, categoriasDe, archivo);
    const proyectos = categoriasDe.porProyecto();
    const salida = { fecha: hoy, consultado: true, motivo: null, proyectos, pedidos, huerfanos, huerfanos_no_consultados: noConsultados };
    escribirJsonAtomico(destino, salida);

    const lista = Object.entries(pedidos);
    console.log(`Estado de los pedidos de trabajo — ${hoy}`);
    console.log(`Pedidos leídos: ${lista.filter(([, x]) => x.leido).length} de ${lista.length}`);
    for (const [id, x] of lista.filter(([, y]) => !y.leido)) console.log(`🚧 NO LEÍDO ${id} (${x.ficha}, ${x.proyecto}): ${x.motivo_no_leido}`);
    for (const x of huerfanos) console.log(`🧷 Bug suelto ${x.id} en ${x.proyecto} (ficha ${x.ficha || 'sin etiqueta'}): ninguna ficha lo nombra`);
    for (const x of noConsultados) console.log(`🚧 ${x.proyecto}: ${x.motivo} — no se puede decir que no haya Bugs sueltos`);
    return 0;
  } catch (e) {
    if (e instanceof NoSePuedeIntentar) return noPudoVolcar(e.message);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** El volcado de hoy si consultó; `null` si falta, es ilegible o no pudo consultar. */
/**
 * El nombre de quien tiene la tarea, para mostrarlo en el sitio. 🔴 Nunca un correo: si el nombre que da Azure
 * es un correo (cuentas sin nombre cargado), o no tiene forma de nombre, queda en null.
 */
function nombreDeAsignado(asg) {
  let nombre = null;
  if (asg && typeof asg === 'object') nombre = asg.displayName;
  else if (typeof asg === 'string') nombre = asg.split('<')[0];
  nombre = typeof nombre === 'string' ? nombre.trim() : '';
  return nombre && fuentes.NOMBRE_DE_PERSONA.test(nombre) ? nombre : null;
}

/**
 * Lo que la noche anota en cada ficha viva para el sitio: quién tiene cada tarea (`asignados:`, del volcado de
 * `state`; la leída sin nadie, con `SIN_ASIGNAR`) y, si a alguna le falta su tarea, por qué (`pedido_motivo:`). Con el sitio, la ficha que ya tiene su
 * tarea no espera ninguna decisión: pasa a promoted/ con `veredicto: util`. Sin el sitio, se anota y no se mueve.
 */
function anotarSeguimiento(ctx, res, rutaOperations) {
  const conSitio = sitioDecide(rutaOperations).codigo === 0;
  const postergadas = new Set(res.postergados.map((x) => x.ficha));
  const volcados = (ctx.volcado && ctx.volcado.pedidos) || {};
  for (const f of ctx.fichas.filter((x) => x.estado !== 'archived')) {
    try {
      const antes = fs.readFileSync(f.archivo, 'utf8');
      const pedidos = leerPedidos(antes);
      const asignados = pedidos.map(({ id }) => {
        const v = volcados[id];
        const nombre = v && typeof v.asignado === 'string' ? nombreDeAsignado(v.asignado) : null;
        // leída y sin nadie: se anota, para que el sitio diga «sin asignar» sólo cuando se midió
        if (!nombre && v && v.leido === true && v.sin_asignar === true) return `${id}: ${fuentes.SIN_ASIGNAR}`;
        return nombre ? `${id}: ${nombre}` : null;
      }).filter(Boolean);
      const falta = res.sin_pedido.find((x) => x.ficha === f.idFicha);
      const motivo = postergadas.has(f.idFicha) ? 'tope'
        : falta ? (falta.proyectos.length ? 'falla' : 'sin-proyecto') : null;
      let txt = ponerLista(antes, 'asignados', asignados);
      txt = motivo ? ponerEscalar(txt, 'pedido_motivo', motivo) : quitarClave(txt, 'pedido_motivo');
      const promover = conSitio && f.estado === 'pending' && pedidos.length && /^veredicto:[ \t]*"?pendiente"?[ \t]*$/m.test(txt);
      if (promover) {
        txt = ponerEscalar(txt, 'veredicto', 'util');
        const destino = path.join(path.dirname(path.dirname(f.archivo)), 'promoted', path.basename(f.archivo));
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.writeFileSync(destino, txt);
        fs.rmSync(f.archivo);
      } else if (txt !== antes) fs.writeFileSync(f.archivo, txt);
    } catch (e) {
      res.fallidos.push({ ficha: f.idFicha, proyecto: null, paso: 'escribir-ficha', motivo: `no pude anotar el seguimiento: ${e.code || e.message}` });
    }
  }
}

function leerVolcadoDeHoy(outDir, hoy) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(outDir, `bugs-${hoy}.json`), 'utf8'));
    return v && typeof v === 'object' && v.consultado === true ? v : null;
  } catch { return null; }
}

/** El texto del aviso único, en HTML — el mismo idioma de los otros comentarios del guion. */
function textoCerradoVivo(x, paquete, respaldo, hoy) {
  const repos = (Array.isArray(x.repos) && x.repos.length ? x.repos : ['(sin repos)']).map(escHtml).join(', ');
  const est = escHtml(x.estado || '?'), mot = escHtml(x.motivo || 'sin motivo'), desde = escHtml(x.visto_cerrado || '?');
  const L = [`<p>${mencionesDelArnes(respaldo)} — revisión nocturna de dependencias del arnés (ficha <code>arnes:${escHtml(x.ficha)}</code>).</p>`];
  if (x.clase === 'no-aplica') {
    L.push(`<p>Este pedido está cerrado como no aplica (${est}, ${mot}) desde el ${desde}, y la vulnerabilidad ${escHtml(paquete)} sigue apareciendo en ${repos}, medido el ${escHtml(hoy)}.</p>`,
      '<p>No lo reabro: decidilo vos. La única salida sin arreglo es declarar la deuda en <code>vulnerabilidades-pendientes.json</code>, con motivo y fecha de revisión: si no, va a seguir apareciendo todas las noches.</p>');
  } else {
    L.push(`<p>Este pedido está cerrado como ${est} (${mot}) desde el ${desde}, y la vulnerabilidad ${escHtml(paquete)} sigue apareciendo en ${repos}, medido el ${escHtml(hoy)}.</p>`,
      '<p>No lo reabro: decidilo vos — se arregla (subir el paquete) o se declara la deuda en <code>vulnerabilidades-pendientes.json</code>, con motivo y fecha de revisión.</p>');
  }
  return L.join('\n');
}

/**
 * «Cerrado con la vulnerabilidad viva»: UN comentario por episodio de cierre, sin reabrir.
 * El nocturno decide (`cruce.cerrados_vivos` con `avisar: true`); acá sólo se habla.
 *
 * 🔴 El marcador `avisado_cerrado_vivo:` se escribe DESPUÉS de que el comentario salió: un marcador sin
 * comentario es un aviso que nunca llega, en verde. Si el comentario falla, mañana el nocturno lo vuelve
 * a pedir.
 */
function avisarCerradosVivos(ctx, res, comentar, respaldoDe, textos) {
  const { snap, hoy, simulado, fichas } = ctx;
  const c = snap && snap.cruce && typeof snap.cruce === 'object' ? snap.cruce : null;
  const lista = c && Array.isArray(c.cerrados_vivos) ? c.cerrados_vivos.filter((x) => x && typeof x === 'object' && x.avisar === true) : [];
  for (const x of [...lista].sort(porFicha)) {
    const fallo = (motivo) => res.fallidos.push({ ficha: x.ficha, proyecto: x.proyecto, paso: 'aviso-cerrado-vivo', motivo });
    const id = Number(x.pedido);
    if (!Number.isInteger(id)) { fallo(`el cruce no trae un pedido legible («${x.pedido}»)`); continue; }
    const f = fichas.find((y) => y.idFicha === x.ficha && y.estado !== 'archived');
    if (!f) { fallo(`la ficha ${x.ficha} no está viva en el disco`); continue; }
    let txt;
    try { txt = fs.readFileSync(f.archivo, 'utf8'); } catch (e) { fallo(`no pude leer la ficha: ${e.message}`); continue; }
    if (listaDe(txt, 'avisado_cerrado_vivo').some((l) => l.startsWith(`${x.proyecto} (`))) continue;
    const respaldo = respaldoDe();
    if (!respaldo.ok) { fallo(`sin la mención al responsable de respaldo no se avisa: ${respaldo.motivo}`); continue; }
    const html = textoCerradoVivo(x, f.fi.escalares.paquete || '(paquete desconocido)', respaldo, hoy);
    if (simulado) {
      textos.push({ tipo: 'aviso', proyecto: x.proyecto, ficha: x.ficha, id, comentario: html });
      res.cerrados_vivos_avisados.push({ ficha: x.ficha, proyecto: x.proyecto, id });
      continue;
    }
    const k = comentar(id, html);
    if (!k.ok) { fallo(`no pude avisar en el Bug ${id}: ${k.motivo}`); continue; }
    try { marcar(f.archivo, 'avisado_cerrado_vivo', x.proyecto, `${x.proyecto} (${hoy})`); }
    catch (e) { res.fallidos.push({ ficha: x.ficha, proyecto: x.proyecto, paso: 'escribir-ficha', motivo: `avisé en el Bug ${id} pero no pude marcarlo: ${e.message}` }); }
    res.cerrados_vivos_avisados.push({ ficha: x.ficha, proyecto: x.proyecto, id });
  }
}

/**
 * El Bug suelto se ADOPTA en la ficha que nombra su etiqueta, en cualquiera de las tres
 * carpetas. Sin comentario: no es un pedido nuevo, ya tuvo el suyo al crearse. Si la ficha no existe
 * o ya tiene OTRO Bug en ese proyecto, no se escribe nada: dos Bugs para el mismo par los decide una
 * persona.
 */
function adoptarHuerfanos(ctx, res) {
  const v = ctx.volcado;
  const lista = v && Array.isArray(v.huerfanos) ? v.huerfanos.filter((h) => h && Number.isInteger(h.id) && typeof h.proyecto === 'string') : [];
  for (const h of [...lista].sort((a, b) => a.id - b.id)) {
    const sinAdoptar = (motivo) => res.huerfanos_sin_adoptar.push({ id: h.id, proyecto: h.proyecto, ficha: h.ficha || null, motivo });
    if (!h.ficha) { sinAdoptar('el Bug no nombra ninguna ficha (sin etiqueta arnes:<id>)'); continue; }
    const f = ctx.fichas.find((y) => y.idFicha === h.ficha);
    if (!f) { sinAdoptar(`la ficha ${h.ficha} no existe`); continue; }
    const ya = leerPedidos(f.txt).find((x) => x.proyecto === h.proyecto);
    if (ya && ya.id === h.id) continue;
    if (ya) { sinAdoptar(`la ficha ya tiene otro pedido en ${h.proyecto}: Bug ${ya.id} — dos Bugs para el mismo par los decide una persona`); continue; }
    if (!ctx.simulado) {
      try {
        anotarPedido(f.archivo, h.proyecto, h.id);
        f.txt = fs.readFileSync(f.archivo, 'utf8');           // lo que sigue en esta corrida ya lo ve con pedido
      } catch (e) {
        res.fallidos.push({ ficha: h.ficha, proyecto: h.proyecto, paso: 'escribir-ficha', motivo: `no pude anotar el Bug suelto ${h.id}: ${e.message}` });
        continue;
      }
    } else {
      // 🔴 Simulado no escribe, pero lo que sigue en esta corrida tiene que verlo adoptado: si no, el
      // mismo par saldría «habría adoptado» Y «habría creado».
      const otros = leerPedidos(f.txt).filter((x) => x.proyecto !== h.proyecto).map((x) => `${x.proyecto}: ${x.id}`);
      f.txt = ponerLista(f.txt, 'pedidos', [...otros, `${h.proyecto}: ${h.id}`]);
    }
    res.huerfanos_adoptados.push({ ficha: h.ficha, proyecto: h.proyecto, id: h.id });
  }
}


// ── la corrida ─────────────────────────────────────────────────────────────────────────────────

function noPudo(motivo) {
  console.error(`🔴 pedidos de trabajo: NO se pudo intentar nada — ${motivo}`);
  console.error('   Esto es «no medido», no «nada que pedir»: no se escribió la sección `pedidos`.');
  return 2;
}

async function correr(a) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(a.config, 'utf8')); } catch (e) { return noPudo(`no se pudo leer la configuración ${a.config}: ${e.message}`); }
  const azure = cfg.azure || {};
  if (!azure.org) return noPudo('falta `azure.org` en la configuración: sin organización no hay a quién preguntar');
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  const archSnap = path.join(a.out, `dependencias-${hoy}.json`);
  if (!fs.existsSync(archSnap)) return noPudo(`no está el snapshot de hoy (${archSnap}): la revisión no corrió o no escribió`);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(archSnap, 'utf8')); } catch (e) { return noPudo(`el snapshot de hoy es ilegible: ${e.message}`); }
  if (!process.env.AZURE_DEVOPS_EXT_PAT) return noPudo('sin token: AZURE_DEVOPS_EXT_PAT está vacío');
  const cmd = process.env.TYCON_ADO_CMD || 'az';
  // 🔴 Todas las noches, aunque no haya nada que pedir: una pieza rota tiene que avisar también en la
  // noche tranquila, no recién la noche en que había algo que crear.
  const v = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (v.error || v.status !== 0) return noPudo(`\`${cmd} --version\` no responde (${v.error ? v.error.message : `salió ${v.status}`})`);

  const pres = cfg.presupuesto_de_ruido || {};
  const ctx = {
    az: crearAz({ cmd, org: azure.org }), cfg, azure, hoy, snap, out: a.out,
    // quién responde: se resuelve cada noche (no sólo cuando hay algo que pedir), pero su falta sólo frena
    // los pedidos y las menciones — el resto de la corrida sigue y el motivo se cobra por par
    responsables: responsables(a, azure),
    simulado: a.simular || azure.pedidos_activos !== true,
    tope: Number.isInteger(pres.tope_pr_por_noche) ? pres.tope_pr_por_noche : 2,
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-de-trabajo-')),
    fichas: leerTodasLasFichas(a.pending),
    // El volcado de `state`: de acá salen los Bugs sueltos a adoptar. Sin él, o ilegible,
    // no se adopta nada esa noche — y eso no es un fallo: el nocturno ya cobra la ausencia del volcado.
    volcado: leerVolcadoDeHoy(a.out, hoy),
  };
  let resultado;
  try { resultado = await hablar(ctx); }
  catch (e) { if (e instanceof NoSePuedeIntentar) return noPudo(e.message); throw e; }
  finally { fs.rmSync(ctx.tmp, { recursive: true, force: true }); }
  if (!ctx.simulado) anotarSeguimiento(ctx, resultado.res, a.operations);

  // La sección se AGREGA al snapshot que dejó el nocturno, sin tocar el resto. Archivo temporal +
  // rename: un corte a mitad de escritura no puede dejar el snapshot de la noche ilegible.
  const actual = JSON.parse(fs.readFileSync(archSnap, 'utf8'));
  actual.pedidos = resultado.res;
  const tmpSnap = `${archSnap}.${process.pid}.tmp`;
  fs.writeFileSync(tmpSnap, `${JSON.stringify(actual, null, 2)}\n`);
  fs.renameSync(tmpSnap, archSnap);

  // Por stderr, para no ensuciar `--json`; el paso del pipeline guarda las dos salidas.
  for (const m of resultado.avisosDeSalida) console.error(`⚠️ pedidos de trabajo: ${m}`);
  if (a.json) console.log(JSON.stringify(resultado.res, null, 2));
  else imprimir(resultado.res, resultado.textos, hoy);
  return 0;
}

function imprimir(r, textos, hoy) {
  console.log(`Pedidos de trabajo — ${hoy}`);
  if (r.simulado) console.log('🟡 MODO SIMULADO: se leyó Azure y se calculó lo que habría salido. No se creó ni se comentó nada, y las fichas no se tocaron.');
  console.log(`Fichas vivas: ${r.fichas_vivas} · sin pedido en algún proyecto: ${r.fichas_sin_pedido} · tope: ${r.tope} ficha(s) por noche · pedidos que ya existían: ${r.existentes}`);
  for (const c of r.creados) {
    console.log(`${r.simulado ? '🟡 habría creado' : '🆕 creado'} en ${c.proyecto} (ficha ${c.ficha})${c.id ? ` → ${c.tipo || 'pedido'} ${c.id}` : (c.tipo ? ` como ${c.tipo}` : '')} · asignado a ${c.asignado_a} (${c.motivo_dueno}) · iteración ${c.iteracion}`);
  }
  for (const x of r.adoptados) console.log(`🔗 adoptado en ${x.proyecto} (ficha ${x.ficha}) → Bug ${x.id}: Azure ya lo tenía por la etiqueta`);
  for (const x of r.fallidos) console.log(`❌ ${x.paso} · ${x.proyecto} (ficha ${x.ficha}): ${x.motivo}`);
  for (const x of r.postergados) console.log(`⏳ postergada por el tope: ${x.ficha} (${x.proyectos.join(', ')}) — entra primero mañana`);
  for (const x of r.sin_iteracion) console.log(`🗓️ ${x.proyecto}: ${x.motivo} → el pedido va a la raíz del backlog`);
  for (const x of r.tipo_de_fabrica || []) console.log(`🧩 ${x.proyecto}: ${x.motivo}`);
  for (const x of r.sin_dueno_unico) console.log(`👤 ${x.proyecto}: ${x.motivo} → se asigna al responsable de respaldo`);
  for (let i = 0; i < (r.maintainers_sin_identidad || 0); i++) console.log('👤 una persona que mantiene el arnés y no tiene identidad en Azure (o no se pudo consultar) no se menciona');
  for (const x of r.reabiertos || []) console.log(`🔁 volvió a aparecer en ${x.proyecto}: Bug ${x.id} reabierto (ficha ${x.ficha})`);
  for (const x of r.pagados_avisados) console.log(`📣 «ya no aparece» en ${x.proyecto} (Bug ${x.id}, ficha ${x.ficha})${x.cerrado === true ? ' · Bug cerrado' : x.cerrado === false ? ' · ya estaba cerrado' : ''}`);
  for (const x of r.deuda_avisada) console.log(`📣 «quedó declarada, vence ${x.vence}» en ${x.proyecto} (Bug ${x.id}, ficha ${x.ficha})`);
  for (const x of r.sin_pedido) console.log(`🚧 sigue sin pedido: ${x.ficha} en ${x.proyectos.join(', ')} — ${x.motivo}`);
  for (const x of r.cerrados_vivos_avisados) console.log(`${r.simulado ? '🟡 habría avisado' : '📣 avisado'} «cerrado con la vulnerabilidad viva» en ${x.proyecto} (Bug ${x.id}, ficha ${x.ficha}) — no se reabre`);
  for (const x of r.huerfanos_adoptados) console.log(`${r.simulado ? '🟡 habría adoptado' : '🧷 adoptado'} el Bug suelto ${x.id} en ${x.proyecto} → ficha ${x.ficha}`);
  for (const x of r.huerfanos_sin_adoptar) console.log(`🚧 Bug suelto ${x.id} en ${x.proyecto} sin adoptar: ${x.motivo}`);
  if (textos.length) {
    console.log('\n--- el texto de lo que habría salido ---');
    for (const t of textos) {
      if (t.tipo === 'aviso') {
        console.log(`\n## ${t.proyecto} · ficha ${t.ficha} · comentario en el Bug ${t.id}`);
        console.log(t.comentario);
        continue;
      }
      console.log(`\n## ${t.proyecto} · ficha ${t.ficha}`);
      console.log(`Título: ${t.titulo}`);
      console.log('Repro Steps / Descripción:');
      console.log(t.cuerpo);
      console.log('Comentario:');
      console.log(t.comentario);
    }
  }
}

const AYUDA = `work-items.js — el pedido de trabajo del líder (un Bug por proyecto de Azure DevOps).

  run     por cada ficha viva sin pedido en alguno de sus proyectos: busca el pedido en Azure por su
          etiqueta, deduce el dueño, elige la iteración y crea el Bug (o, simulado, dice qué crearía).
          Avisa una vez en los pedidos cerrados con la vulnerabilidad viva y adopta los Bugs sueltos.
          Agrega la sección «pedidos» al snapshot de hoy.

  state   vuelca a <out>/bugs-<hoy>.json el estado de cada pedido de las fichas (categoría, motivo,
          quién lo tocó por última vez) y los Bugs del arnés que ninguna ficha nombra. Sólo lee.

  --config <f>     repos.json (bloque «azure»: org, pedidos_activos y, sin operations.json, fallback_owner)
  --operations <f> operations.json: owners.default es el responsable de respaldo (se excluye al deducir el
                   dueño, se lo menciona y recibe lo que no tiene dueño único); owners.by_project.<proyecto>
                   asigna directo en ese proyecto. Por defecto, el de la raíz del repo; si no está, repos.json
  --pending <dir>  dónde están las fichas (por defecto inbox/dependencies/)
  --out <dir>      dónde está el snapshot de hoy (por defecto .dashboard/dependencias)
  --today <fecha>  fija la fecha (pruebas)
  --simulate       no escribe nada aunque «pedidos_activos» esté encendido
  --json           vuelca la sección «pedidos»
  --team-repos <f> team-repos.json: con operations.platform «github» corre github-issues.js (issues en vez de Bugs).
                   Por defecto el de la raíz del árbol; sin él, Azure

Habla con Azure sólo por TYCON_ADO_CMD (por defecto az) y necesita AZURE_DEVOPS_EXT_PAT.
Exit: 0 habló con Azure (los fallos por par van al snapshot) · 2 no pudo intentar nada.`;

/**
 * La plataforma de los avisos la elige la capa de plataforma (scripts/lib/platform/platform.js), como la de cualquier
 * pedido de trabajo: el área `workItems` del perfil, su valor por defecto, o `operations.platform` de team-repos.json
 * (`--team-repos <f>`, por defecto el de la raíz del árbol). Un archivo que no valida, o pedido con `--team-repos` y
 * ausente, no se adivina: `{ error }`. Sin ninguna elección sigue con Azure DevOps y lo dice (`aviso`): así no se queda
 * sin pedidos una organización que todavía no eligió.
 * Devuelve `{ plataforma, argv, aviso? }` con `--team-repos` ya sacado de los argumentos; `plataforma` es `azure` o `github`.
 */
function elegirPlataforma(argv, { env = process.env } = {}) {
  const out = [];
  let archivo = path.join(RAIZ_REPO, 'team-repos.json'), explicito = false;
  for (let i = 0; i < argv.length; i++) {
    if (i >= 2 && argv[i] === '--team-repos') { archivo = path.resolve(String(argv[++i] || '')); explicito = true; } else out.push(argv[i]);
  }
  if (explicito || fs.existsSync(archivo)) {
    const r = require('../../lib/team-repos.js').load(archivo);
    if (!r.ok) return { error: `${archivo} no sirve para elegir la plataforma (${r.problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; ')}) — no se adivina` };
  }
  const c = require('../../lib/platform/platform.js').choose('work-item.create', { env, tree: path.dirname(archivo), teamReposFile: explicito || fs.existsSync(archivo) ? archivo : undefined });
  if (c.ok) {
    const plataforma = { 'azure-devops': 'azure', github: 'github' }[c.value.connector];
    if (!plataforma) return { error: `los pedidos de las vulnerabilidades no saben usar el conector ${c.value.connector} todavía` };
    return { plataforma, argv: out };
  }
  // sin elección: lo de siempre, a la vista; una elección rota o un conector que falta no se tapa con Azure
  if (c.sinEleccion) return { plataforma: 'azure', argv: out, aviso: `nadie eligió la plataforma de los pedidos: sigo con Azure DevOps como hasta hoy; elegila en integrations.platform del perfil del equipo (${c.detail.replace(/^.*?: /, '')})` };
  return { error: c.detail };
}

/** Una entrada de GitHub en repos.json con la plataforma Azure es una mezcla: no se adivina. */
function mezclaEnAzure(configFile) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; }   // lo dice el camino de siempre
  const gh = ((cfg && cfg.repos) || []).filter((r) => r && r.github && !r.ado).map((r) => r.ruta);
  return gh.length ? `repos.json trae entradas de GitHub (${gh.join(', ')}) y la plataforma de la organización es Azure: una organización, una plataforma` : null;
}

async function main() {
  const p = elegirPlataforma(process.argv);
  if (p.error) { console.error(`error: ${p.error}`); return 2; }
  if (p.aviso) console.error(`aviso: ${p.aviso}`);
  if (p.plataforma === 'github') return require('./github-issues.js').main(p.argv);
  const a = parseArgs(p.argv);
  if (!a.error && (a.cmd === 'run' || a.cmd === 'state')) {
    const mezcla = mezclaEnAzure(a.config);
    if (mezcla) { console.error(`error: ${mezcla}`); return 2; }
  }
  if (a.error) { console.error(`error: ${a.error}\n\n${AYUDA}`); return 2; }
  if (a.cmd === 'run') return correr(a);
  if (a.cmd === 'state') return volcar(a);
  console.log(AYUDA);
  return a.cmd === 'help' ? 0 : 2;
}

// Exportado para el subcomando `state` (`avisarCerradosVivos`): reusa `crearAz`, los tres
// lectores de Azure y el patrón de marcadores por proyecto en vez de copiarlos.
module.exports = { parseArgs, crearAz, proyectosDeFicha, paresPorPedir, ordenarYTopar, deducirDueno,
  resolverIdentidad, leerAdministradores, leerIteracion, iteracionVigente, tokensDeEtiquetas, yaMarcado,
  marcar, anotarPedido, fallidasDeAnoche, hablar, correr,
  // el programa de los issues de GitHub reusa la regla de reintento
  isNoWorkItemStep, elegirPlataforma,
  // quién responde por cada repo
  responsables, responsablesDeRepos,
  // el estado de cada pedido y el cruce
  personaMasReciente, leerCategorias, leerPedidoDeAzure, buscarHuerfanos, volcar, avisarCerradosVivos, adoptarHuerfanos,
  textoCerradoVivo,
  // los pedidos asignados del sitio juzgan «abierto» con las mismas categorías
  cacheDeCategorias };

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire: un
// informe de 9782 bytes llega cortado en 8192 y el consumidor lo lee como «no pude», nunca como
// un error. `main` no deja manejadores abiertos, así que con `exitCode` el proceso termina solo, cuando
// terminó de escribir.
// Va DESPUÉS de module.exports — github-issues.js (que este main puede cargar) usa lo que exporta este guion.
if (require.main === module) {
  // Los nombres viejos (subcomandos y opciones en castellano) siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dependencies/work-items.js', { exitCode: 2, prefix: 'error: ' });
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}
