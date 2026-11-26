#!/usr/bin/env node
'use strict';
/**
 * work-items.js — el pedido de trabajo del líder: la entrada, igual para cualquier plataforma.
 *
 * La revisión nocturna de dependencias convierte cada ficha viva en un pedido de trabajo en el proyecto del equipo dueño
 * del código. Lo que se habla con la plataforma (crear, buscar, leer el estado, cerrar, reabrir, comentar) lo trae el
 * conector de la plataforma que eligió la organización, en `integrations/<conector>/scripts/dependency-notices.js`. Acá
 * queda lo que no depende de la plataforma: los argumentos, qué pares (ficha, proyecto) piden, el orden y el tope, los
 * reintentos de la noche anterior, las marcas en la ficha y la adopción de los pedidos sueltos.
 *
 * La llama el nocturno de operaciones por esta ruta: la ruta y la interfaz (`run`, `state`) no cambian con la
 * plataforma.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node work-items.js run    [--config <f>] [--operations <f>] [--pending <dir>] [--out <dir>]
 *                             [--today <fecha>] [--simulate] [--json] [--team-repos <f>]
 *   node work-items.js state  [--config <f>] [--pending <dir>] [--out <dir>] [--today <fecha>] [--team-repos <f>]
 * La ayuda completa la da el conector: `node work-items.js help`.
 *
 * Exit: lo que devuelve el conector · 2 = no se pudo elegir la plataforma, o su conector no trae el aviso.
 */
const fs = require('fs');
const path = require('path');

// el nocturno vive en la misma carpeta: por la ruta vieja cargaría el reemplazo, que deja un aviso en la salida
const noc = require('./nightly-dependencies');

const { listaDe, ponerLista, proyectoAzureDe, leerPedidos } = noc;

const RAIZ_REPO = path.resolve(__dirname, '..', '..', '..');
// repos.json vive al lado de este guion; las fichas, en inbox/dependencies/
const CONFIG_DEF = path.join(RAIZ_REPO, 'scripts', 'nightly', 'dependencies', 'repos.json');
// el responsable de cada proyecto: en la raíz del repo de operaciones de la organización
const OPERATIONS_DEF = path.join(RAIZ_REPO, 'operations.json');
const OUT_DEF = path.join(RAIZ_REPO, '.dashboard', 'dependencias');
const PENDING_DEF = path.join(RAIZ_REPO, 'inbox', 'dependencies');

const ORDEN_SEV = { critical: 2, high: 1 };

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

/** Los pasos que dejan a un par (ficha, proyecto) SIN pedido anotado: los únicos que piden reintento. */
// El paso que resuelve la identidad del líder se llama `lead-identity` (el aviso del arranque,
// que se publica, lo lee y no puede llevar un nombre de persona). Las noches anteriores lo escribieron como `identidad-`
// más ese nombre: se reconocen por el prefijo, para que su prioridad de reintento no se pierda con el cambio.
const PASOS_SIN_PEDIDO = ['lead-identity', 'duplicados', 'crear', 'escribir-ficha'];
const isNoWorkItemStep = (paso) => PASOS_SIN_PEDIDO.includes(paso) || /^identidad-/.test(String(paso || ''));

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

/**
 * La plataforma de los avisos la elige la capa de plataforma (scripts/lib/platform/platform.js), como la de cualquier
 * pedido de trabajo: el área `workItems` del perfil, su valor por defecto, o `operations.platform` de team-repos.json
 * (`--team-repos <f>`, por defecto el de la raíz del árbol). Un archivo que no valida, o pedido con `--team-repos` y
 * ausente, no se adivina: `{ error }`. Sin ninguna elección sigue con la plataforma de siempre y lo dice (`aviso`): así no
 * se queda sin pedidos una organización que todavía no eligió.
 * Devuelve `{ plataforma, argv, aviso? }` con `--team-repos` ya sacado de los argumentos; `plataforma` es la de
 * team-repos.json (la que nombra a su conector).
 */
// la plataforma de los pedidos de una organización que todavía no eligió: la de antes de que se pudiera elegir
const SIN_ELECCION = 'azure';
function elegirPlataforma(argv, { env = process.env } = {}) {
  const TR = require('../../lib/team-repos.js');
  const out = [];
  let archivo = path.join(RAIZ_REPO, 'team-repos.json'), explicito = false;
  for (let i = 0; i < argv.length; i++) {
    if (i >= 2 && argv[i] === '--team-repos') { archivo = path.resolve(String(argv[++i] || '')); explicito = true; } else out.push(argv[i]);
  }
  if (explicito || fs.existsSync(archivo)) {
    const r = TR.load(archivo);
    if (!r.ok) return { error: `${archivo} no sirve para elegir la plataforma (${r.problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; ')}) — no se adivina` };
  }
  const c = require('../../lib/platform/platform.js').choose('work-item.create', { env, tree: path.dirname(archivo), teamReposFile: explicito || fs.existsSync(archivo) ? archivo : undefined });
  if (c.ok) {
    const plataforma = Object.keys(TR.CONNECTORS).find((k) => TR.CONNECTORS[k] === c.value.connector);
    if (!plataforma || !fs.existsSync(avisoDelConector(plataforma))) return { error: `los pedidos de las vulnerabilidades no saben usar el conector ${c.value.connector} todavía` };
    return { plataforma, argv: out };
  }
  // sin elección: lo de siempre, a la vista; una elección rota o un conector que falta no se tapa con la de siempre
  if (c.sinEleccion) return { plataforma: SIN_ELECCION, argv: out, aviso: `nadie eligió la plataforma de los pedidos: sigo con ${TR.connectorOf(SIN_ELECCION)} como hasta hoy; elegila en integrations.platform del perfil del equipo (${c.detail.replace(/^.*?: /, '')})` };
  return { error: c.detail };
}

/** El aviso de dependencias del conector de una plataforma: `integrations/<conector>/scripts/dependency-notices.js`. */
function avisoDelConector(plataforma) {
  return path.join(RAIZ_REPO, 'integrations', String(require('../../lib/team-repos.js').connectorOf(plataforma)), 'scripts', 'dependency-notices.js');
}

async function main() {
  const p = elegirPlataforma(process.argv);
  if (p.error) { console.error(`error: ${p.error}`); return 2; }
  if (p.aviso) console.error(`aviso: ${p.aviso}`);
  return require(avisoDelConector(p.plataforma)).main(p.argv);
}

module.exports = { RAIZ_REPO, parseArgs, recortar, proyectosDeFicha, paresPorPedir, ordenarYTopar, isNoWorkItemStep,
  yaMarcado, marcar, anotarPedido, fallidasDeAnoche, adoptarHuerfanos, elegirPlataforma };

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire: un
// informe de 9782 bytes llega cortado en 8192 y el consumidor lo lee como «no pude», nunca como
// un error. `main` no deja manejadores abiertos, así que con `exitCode` el proceso termina solo, cuando
// terminó de escribir.
// Va DESPUÉS de module.exports — el aviso del conector (que este main puede cargar) usa lo que exporta este guion.
if (require.main === module) {
  // Los nombres viejos (subcomandos y opciones en castellano) siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dependencies/work-items.js', { exitCode: 2, prefix: 'error: ' });
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}
