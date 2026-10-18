'use strict';
/*
 * people.js — QUIÉN ES QUIÉN (story 2.28): de quién es cada máquina, quién puede ver sus corridas y dónde trabaja cada
 * persona. Es LA regla: el sitio de la organización (2.23) la llama en cada pedido y no la copia.
 *
 *   · Cada máquina informa en su `place.json` el correo de git de su dev (`owner`, lo arma `upload-runs.js`). Es sólo una
 *     pista: lo que cuenta es lo que confirma un mantenedor en `operations.json` → `people.machines.<carpeta>`
 *     (`person`, y la HUELLA del correo que la máquina informaba al confirmar, `reported_sha256`, nunca el correo).
 *   · Cuatro estados por máquina (AC 7): `confirmada` (sus corridas son de `person`), `sin_confirmar`, `cambio` (informa
 *     otro correo: la confirmación se cae entera, decisión 4) y `sin_correo`; más `compartida` para una carpeta vieja
 *     que no se une a una sola nueva (AC 27-28). Una carpeta vieja `unida` sigue a su nueva: una entrada con su nombre
 *     viejo no confirma nada (AC 26).
 *   · Quién entra y con qué rol lo dice la lista del sitio, `site.access`: una entrada por persona, con su
 *     rol y uno o más correos; sin la lista, se arma con `site.maintainers` y las personas de `people.machines`
 *     (`listaDeAcceso`). Ve una máquina quien mantiene o la persona para la que está confirmada, con cualquiera de sus
 *     correos (`correosDe`). Es persona quien tiene una entrada `dev`.
 *   · «Dónde trabaja» se cuenta en productos de `repos.json` (decisión 8), deducidos de sus corridas confirmadas y de
 *     sus pedidos asignados, y se corrige con `people.projects.<correo>` (`add`, `remove`). Lo que no da UN solo
 *     producto queda «sin ubicar», con el motivo: no se adivina.
 *   · Una `operations.json` que no se puede releer vale como el último bueno 24 horas; después el sitio se frena (AC 10):
 *     la cuenta la hace `estadoDeLaConfiguracion`; guardar el último bueno y la hora del primer refresco fallido es del
 *     sitio.
 *
 * El sitio la llama desde `scripts/site/access.js` (rol, filtro, cuenta de máquinas por confirmar y dónde trabaja) y
 * `scripts/site/sources.js` (la cuenta del freno, y lo informado, que queda FUERA del modelo de las pantallas).
 *
 * TODO(Story-2.28-deferral): todavía no hay ninguna máquina confirmada en la configuración de la organización (Task 8:
 * las primeras confirmaciones, en el repo de operaciones, después de una noche verde con las carpetas nuevas y con la
 * decisión de quién lee ese repo). Hasta entonces la regla corre, pero cada corrida la ven sólo quienes mantienen.
 *
 * Los correos se comparan sin mayúsculas y sin espacios alrededor (decisión 7). El único disco que toca es el espejo
 * del buzón (`leerCorreosInformados`): sólo lee, nunca escribe, nunca tira. Lo demás lo recibe ya leído. Sin red. Sin
 * valores de ninguna organización (T19).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { FORMA_MAQUINA } = require('../metrics/upload-runs.js');
const { carpetasDeMaquina } = require('../metrics/download-runs.js');

const PLAZO_MS = 24 * 3600 * 1000;
const FORMA_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// un texto que viene del place.json de OTRA máquina (el motivo de su `owner`): sin controles ni separadores de línea, y
// acotado — lo va a mostrar el sitio a quien mantiene
// (armada con fromCharCode: escritos literales en el fuente, los separadores de línea cortan la expresión)
const NO_IMPRIMIBLES = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const textoAjeno = (s) => String(s || '').replace(NO_IMPRIMIBLES, ' ').trim().slice(0, 200);

/** El correo como se compara: sin espacios alrededor y en minúsculas. Acepta una sesión `{ email }`. '' si no hay. */
function normalizarCorreo(c) {
  const v = c && typeof c === 'object' ? c.email : c;
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
/** La huella de un correo: sha256 del correo normalizado (lo que guarda `reported_sha256`). */
function huellaDeCorreo(c) { return crypto.createHash('sha256').update(normalizarCorreo(c)).digest('hex'); }

/**
 * Lo que informa cada máquina del espejo del buzón (AC 4), en la forma que deja el bajador después de la 2.24 (un
 * `<espejo>/<carpeta>/registros/place.json` por carpeta). Por carpeta: `{ estado: 'informa', correo, dia, corridas }`,
 * `{ estado: 'no_informa', motivo, dia?, corridas }` o `{ estado: 'ilegible', motivo, corridas }`. Trae también la
 * unión de carpetas viejas (`carpetasDeMaquina` del bajador). Sólo lee; nunca tira.
 */
function leerCorreosInformados(espejoDir) {
  const out = { maquinas: {}, uniones: { schema: 1, carpetas: {}, regeneradas: {} } };
  let entradas = [];
  try { entradas = fs.readdirSync(espejoDir, { withFileTypes: true }); }
  catch (e) { out.no_medido = `el espejo del buzón no se pudo listar (${e.code || 'error'})`; out.uniones.no_medido = out.no_medido; return out; }
  for (const e of entradas) {
    if (!e.isDirectory() || !FORMA_MAQUINA.test(e.name)) continue;
    // «no pude contar» no es «0 corridas»: null
    let corridas = null;
    try { corridas = fs.readdirSync(path.join(espejoDir, e.name)).filter((f) => f.endsWith('.json')).length; } catch (_) { corridas = null; }
    let texto;
    try { texto = fs.readFileSync(path.join(espejoDir, e.name, 'registros', 'place.json'), 'utf8'); }
    catch (err) {
      out.maquinas[e.name] = { estado: 'no_informa', motivo: err.code === 'ENOENT' ? 'la máquina no subió place.json' : `place.json no se pudo leer (${err.code || 'error'})`, corridas };
      continue;
    }
    let p;
    try { p = JSON.parse(texto); } catch (_) { out.maquinas[e.name] = { estado: 'ilegible', motivo: 'place.json no es JSON válido', corridas }; continue; }
    // el día y el correo vienen de OTRA máquina: un día que no es una fecha real es null, y un correo con caracteres de
    // control no se toma por informado (segunda vuelta de seguridad)
    const dia = p && /^\d{4}-\d{2}-\d{2}$/.test(String(p.day)) && new Date(`${p.day}T00:00:00Z`).toISOString().slice(0, 10) === p.day ? p.day : null;
    const o = p && p.owner;
    const correo = o && typeof o.email === 'string' ? normalizarCorreo(o.email) : '';
    if (correo && FORMA_CORREO.test(correo) && !(new RegExp(NO_IMPRIMIBLES.source)).test(correo)) out.maquinas[e.name] = { estado: 'informa', correo, dia, corridas };
    else {
      const motivo = o && typeof o.reason === 'string' && textoAjeno(o.reason) ? textoAjeno(o.reason) : (o ? 'el correo informado no tiene forma de correo' : 'place.json no trae el correo (una versión de antes de la 2.28)');
      out.maquinas[e.name] = { estado: 'no_informa', motivo, ...(dia ? { dia } : {}), corridas };
    }
  }
  // sin uniones cada carpeta cuenta como hoy, pero se DICE: «no pude calcularlas» no es «no hay»
  try { out.uniones = carpetasDeMaquina(espejoDir); }
  catch (e) { out.uniones.no_medido = `las uniones de carpetas no se pudieron calcular (${(e && e.code) || 'error'})`; }
  return out;
}

/**
 * El contexto de la regla: la configuración vigente (o el último bueno) y lo informado. `operations` es el objeto de
 * operations.json ya validado; `informados`, lo de `leerCorreosInformados`.
 */
// las claves `__…` son comentarios para el lector de operations.json: acá tampoco cuentan (pase adversarial)
const sinComentarios = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('__'))) : {});
const ROLES_DE_ACCESO = ['maintainer', 'dev'];

/**
 * La lista de quién entra al sitio: `{ origen, entradas: [{ role, emails }] }`, con los correos ya
 * normalizados. `origen: 'lista'` es `site.access` de operations.json; sin ella, `'migracion'`: la lista armada con lo de
 * antes, para que nadie que entraba pierda el acceso (cada correo de `site.maintainers` como maintainer, y cada persona
 * de `people.machines` que no mantiene, como dev; sin repetir). Una entrada sin rol válido o sin correos no cuenta (el
 * lector de operations.json ya la rechaza; esto no la adivina).
 */
function listaDeAcceso(operations) {
  const site = (operations && operations.site) || {};
  // `descartados`: cuántos correos (o entradas) no se pudieron leer y quedaron afuera; quien muestra la lista lo dice
  let descartados = 0;
  const correos = (l) => {
    const todos = (Array.isArray(l) ? l : []).map(normalizarCorreo);
    const buenos = todos.filter((m) => FORMA_CORREO.test(m));
    descartados += todos.length - buenos.length;
    return [...new Set(buenos)];
  };
  if (Array.isArray(site.access)) {
    const entradas = [];
    // un correo es de una sola persona: si aparece en dos entradas (el lector lo rechaza), queda en la primera
    const usados = new Set();
    for (const e of site.access) {
      if (!e || typeof e !== 'object' || !ROLES_DE_ACCESO.includes(e.role)) { descartados += 1; continue; }
      const emails = correos(e.emails).filter((m) => { if (usados.has(m)) { descartados += 1; return false; } usados.add(m); return true; });
      if (emails.length) entradas.push({ role: e.role, emails });
    }
    return { origen: 'lista', entradas, descartados };
  }
  const vistos = new Set();
  const entradas = [];
  const sumar = (role, m) => { if (!vistos.has(m)) { vistos.add(m); entradas.push({ role, emails: [m] }); } };
  for (const m of correos(site.maintainers)) sumar('maintainer', m);
  for (const e of Object.values(sinComentarios((operations && operations.people && operations.people.machines) || {}))) {
    const m = normalizarCorreo(e && e.person);
    if (FORMA_CORREO.test(m)) sumar('dev', m);
    else if (m) descartados += 1;   // una máquina sin persona no es un correo mal escrito
  }
  return { origen: 'migracion', entradas, descartados };
}

/**
 * Qué cambió de una lista de quién entra a otra (las dos, operations.json; sin `site.access`, su migración): altas y bajas
 * por correo, y cambios de rol. Lo usa el registro del sitio para decir cuándo entra en vigor cada cambio.
 */
function cambiosDeAcceso(antes, despues) {
  const roles = (ops) => { const m = new Map(); for (const e of listaDeAcceso(ops).entradas) for (const x of e.emails) m.set(x, e.role); return m; };
  const a = roles(antes); const d = roles(despues);
  return {
    altas: [...d].filter(([x]) => !a.has(x)).map(([email, role]) => ({ email, role })),
    bajas: [...a].filter(([x]) => !d.has(x)).map(([email, role]) => ({ email, role })),
    roles: [...d].filter(([x, r]) => a.has(x) && a.get(x) !== r).map(([email, r]) => ({ email, de: a.get(email), a: r })),
  };
}
const textoDeCambios = (c) => [...c.altas.map((x) => `alta ${x.email} (${x.role})`), ...c.bajas.map((x) => `baja ${x.email}`), ...c.roles.map((x) => `${x.email}: ${x.de} → ${x.a}`)].join(' · ');

function contexto({ operations, informados }) {
  const people = (operations && operations.people) || {};
  const acceso = listaDeAcceso(operations);
  // cada correo de la lista → todos los correos de su persona (lo suyo se calcula con todos)
  const personaDe = new Map();
  for (const e of acceso.entradas) for (const m of e.emails) if (!personaDe.has(m)) personaDe.set(m, e);
  return {
    machines: sinComentarios(people.machines),
    projects: sinComentarios(people.projects),
    acceso,
    personaDe,
    maintainers: new Set(acceso.entradas.filter((e) => e.role === 'maintainer').flatMap((e) => e.emails)),
    informados: informados || { maquinas: {}, uniones: { carpetas: {}, regeneradas: {} } },
  };
}

/** Todos los correos de la persona de `sesion` (el primero, el suyo); un correo fuera de la lista es sólo él mismo. */
function correosDe(sesion, c) {
  const correo = normalizarCorreo(sesion);
  if (!correo) return [];
  const e = c.personaDe && c.personaDe.get(correo);
  return e ? [...e.emails] : [correo];
}

const uniones = (c) => ((c.informados && c.informados.uniones && c.informados.uniones.carpetas) || {});

/** El estado de una máquina (AC 7, AC 26-28): `{ estado, motivo, person?, antes_de? }`. */
function estadoDeMaquina(maquina, c) {
  const u = uniones(c)[maquina];
  if (u && u.estado === 'unida' && u.nueva) {
    // una vieja se une a UNA carpeta nueva, que no es a su vez una vieja: una cadena (o un ciclo) no la confirma (falla
    // hacia no mostrar; el bajador ya no la escribe, pero el archivo lo puede traer cualquiera — pase adversarial)
    if (uniones(c)[u.nueva]) return { estado: 'compartida', motivo: 'la unión de carpetas encadena dos carpetas viejas: no se une' };
    const nueva = { ...estadoDeMaquina(u.nueva, c), antes_de: u.nueva };
    // la vieja confirmada para OTRA persona que la de su nueva: la unión pasaría sus corridas de una persona a otra — no
    // se aplica (segunda vuelta de seguridad). La misma persona, o sin entrada, sigue a la nueva. La misma persona es
    // cualquiera de sus correos de la lista de quién entra: dos correos de una entrada son la misma persona
    const propia = Object.prototype.hasOwnProperty.call(c.machines, maquina) ? c.machines[maquina] : null;
    if (propia && nueva.person && !correosDe(nueva.person, c).includes(normalizarCorreo(propia.person))) {
      return { estado: 'compartida', motivo: 'la carpeta vieja está confirmada para otra persona que la nueva: no se une' };
    }
    // la vieja informa el correo de OTRA persona que su nueva: no hereda la confirmación (tercera vuelta de seguridad)
    const infVieja = c.informados.maquinas[maquina];
    const infNueva = c.informados.maquinas[u.nueva];
    if (infVieja && infVieja.estado === 'informa' && (!infNueva || infNueva.estado !== 'informa' || !correosDe(infNueva.correo, c).includes(normalizarCorreo(infVieja.correo)))) {
      return { estado: 'compartida', motivo: 'la carpeta vieja informa otro correo que la nueva: no se une' };
    }
    return nueva;
  }
  if (u && (u.estado === 'compartida' || u.estado === 'siguio_recibiendo')) {
    return { estado: 'compartida', motivo: u.estado === 'compartida' ? `compartida por ${u.declarantes} máquinas: no se une` : 'siguió recibiendo después de la mudanza: no se une' };
  }
  const entrada = Object.prototype.hasOwnProperty.call(c.machines, maquina) ? c.machines[maquina] : null;
  const inf = c.informados.maquinas[maquina];
  const huella = inf && inf.estado === 'informa' ? huellaDeCorreo(inf.correo) : null;
  if (!entrada) {
    return huella ? { estado: 'sin_confirmar', motivo: 'ningún mantenedor la confirmó todavía' } : { estado: 'sin_correo', motivo: (inf && inf.motivo) || 'no informa correo' };
  }
  const person = normalizarCorreo(entrada.person);
  if (!huella) return { estado: 'confirmada', motivo: 'confirmada; la máquina no informa correo hoy', person };
  const esperada = typeof entrada.reported_sha256 === 'string' ? entrada.reported_sha256 : huellaDeCorreo(person);
  if (huella === esperada) return { estado: 'confirmada', motivo: 'confirmada', person };
  return { estado: 'cambio', motivo: 'la máquina informa otro correo que el que se confirmó: hay que reconfirmarla', person };
}

/** ¿Esta sesión ve las corridas de esa máquina? (AC 8). `maquina: null` = una corrida sin máquina: sólo quien mantiene. */
function puedeVer(sesion, maquina, c) {
  const suyos = correosDe(sesion, c);
  if (!suyos.length) return false;
  if (suyos.some((m) => c.maintainers.has(m))) return true;
  if (!maquina) return false;
  const e = estadoDeMaquina(maquina, c);
  return e.estado === 'confirmada' && suyos.includes(e.person);
}

/** ¿Es persona? Quien tiene una entrada `dev` en la lista de quién entra (o en su migración). */
function esPersona(sesion, c) {
  const correo = normalizarCorreo(sesion);
  const e = correo && c.personaDe ? c.personaDe.get(correo) : null;
  return Boolean(e) && e.role === 'dev';
}

/**
 * La configuración de la organización (AC 10): `vigente` si el último refresco la leyó bien; `ultimo_bueno` (con `desde`
 * y el motivo) durante las 24 horas desde el primer refresco fallido; `frenado` pasado el plazo, o enseguida si no hay
 * último bueno. Es la ÚNICA cuenta: el sitio la usa tal cual. Las horas pueden venir en milisegundos o en ISO; `desde`
 * (el primer refresco fallido) y `frenado_desde` (desde cuándo está frenado) salen en ISO. Sin último bueno y sin
 * ningún refresco fallido —nunca leyó bien— también frena, desde `ahora`: falla hacia frenar.
 */
function estadoDeLaConfiguracion({ hayUltimoBueno, fallaDesde, ahora = Date.now(), motivo = null }) {
  const t = typeof ahora === 'number' ? ahora : Date.parse(ahora);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  if (fallaDesde === null || fallaDesde === undefined || fallaDesde === '') {
    if (hayUltimoBueno) return { estado: 'vigente' };
    return { estado: 'frenado', desde: iso(t), frenado_desde: iso(t), motivo };
  }
  const ms = typeof fallaDesde === 'number' ? fallaDesde : Date.parse(fallaDesde);
  if (!Number.isFinite(ms)) return { estado: 'frenado', desde: iso(t), frenado_desde: iso(t), motivo };
  const desde = iso(ms);
  if (!hayUltimoBueno) return { estado: 'frenado', desde, frenado_desde: desde, motivo };
  // un reloj que no se puede leer, o una primera falla en el futuro (el reloj cambió), no estiran el plazo: frena
  if (!Number.isFinite(t) || ms > t) return { estado: 'frenado', desde, frenado_desde: desde, motivo };
  if (t - ms >= PLAZO_MS) return { estado: 'frenado', desde, frenado_desde: iso(ms + PLAZO_MS), motivo };
  return { estado: 'ultimo_bueno', desde, motivo };
}

/**
 * Las máquinas que no están confirmadas (AC 11), para quien mantiene: estado, motivo, correo informado (o null), día de
 * su place.json, cuántas corridas, y las otras máquinas ya confirmadas para ese mismo correo (por `person` o por la
 * huella). Trae las carpetas viejas que no se unen y las regeneradas; una vieja unida no aparece (no es una máquina).
 */
/**
 * ¿La máquina nunca dio señales? Sin place.json, sin fecha y sin ninguna corrida: así llega una carpeta que dejó un
 * laboratorio o una prueba en el buzón. No se ofrece para confirmar (no hay nada que confirmar), pero no se esconde:
 * `maquinasSinActividad` la lista aparte.
 */
const sinActividad = (inf) => Boolean(inf) && inf.estado === 'no_informa' && !inf.dia && inf.corridas === 0;

function maquinasPorConfirmar(c) {
  return candidatasAConfirmar(c).filter((x) => !x.sinActividad);
}

/** Las máquinas sin ninguna señal (ver `sinActividad`), con su nombre: para mostrarlas aparte, sin «Confirmar». */
function maquinasSinActividad(c) {
  return candidatasAConfirmar(c).filter((x) => x.sinActividad).map((x) => ({ maquina: x.maquina }));
}

function candidatasAConfirmar(c) {
  const u = uniones(c);
  const regeneradas = (c.informados.uniones && c.informados.uniones.regeneradas) || {};
  // una vieja `unida` cuya unión vale no es una máquina (sus corridas son de la nueva); una cuya unión se descartó
  // (informa otro correo, o está confirmada para otra persona) sí sale, para que quien mantiene la resuelva
  const unidaDeVerdad = (m) => Boolean(u[m] && u[m].estado === 'unida' && estadoDeMaquina(m, c).estado !== 'compartida');
  const confirmadas = Object.keys(c.informados.maquinas).sort().filter((m) => estadoDeMaquina(m, c).estado === 'confirmada' && !unidaDeVerdad(m));
  const out = [];
  for (const [m, inf] of Object.entries(c.informados.maquinas).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (unidaDeVerdad(m)) continue;
    const e = estadoDeMaquina(m, c);
    if (e.estado === 'confirmada') continue;
    const correo = inf.estado === 'informa' ? inf.correo : null;
    const otras = correo ? confirmadas.filter((o) => o !== m && (() => {
      const ent = c.machines[o];
      return ent && (normalizarCorreo(ent.person) === correo || ent.reported_sha256 === huellaDeCorreo(correo));
    })()) : [];
    out.push({ maquina: m, estado: e.estado, motivo: e.estado === 'sin_correo' || e.estado === 'compartida' ? e.motivo : (inf.motivo || e.motivo), correo, dia: inf.dia || null, corridas: Number.isInteger(inf.corridas) ? inf.corridas : null, otras, sinActividad: sinActividad(inf), ...(regeneradas[m] ? { regenerado: regeneradas[m] } : {}) });
  }
  return out;
}

// ── dónde trabaja ────────────────────────────────────────────────────────────────────────────────────────────────
const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (_) { return String(s); } };
const low = (s) => String(s || '').trim().toLowerCase();
function entradasDeRepos(repos) {
  const lista = Array.isArray(repos) ? repos : (repos && Array.isArray(repos.repos) ? repos.repos : null);
  if (!lista) return null;
  return lista.filter((r) => r && typeof r.producto === 'string').map((r) => {
    const ado = typeof r.ado === 'string' ? dec(r.ado) : '';
    const i = ado.indexOf('/');
    return { producto: r.producto, ruta: typeof r.ruta === 'string' ? r.ruta : '', proyecto: i > 0 ? ado.slice(0, i) : '', repo: i > 0 ? ado.slice(i + 1) : '' };
  });
}
const unicos = (xs) => [...new Set(xs)].sort();

/** El producto de un repo de Azure (paso 1 del AC 13): `{ producto }` o `{ empate: [...] , paso }`. */
function porRepoDeAzure(ent, proyecto, nombre) {
  if (!nombre) return { empate: [], paso: 'sin repo de Azure' };
  if (proyecto) {
    const exacto = unicos(ent.filter((e) => low(e.proyecto) === low(proyecto) && low(e.repo) === low(nombre)).map((e) => e.producto));
    if (exacto.length === 1) return { producto: exacto[0] };
    if (exacto.length > 1) return { empate: exacto, paso: `el repo de Azure ${proyecto}/${nombre}` };
    const delProyecto = unicos(ent.filter((e) => low(e.proyecto) === low(proyecto)).map((e) => e.producto));
    if (delProyecto.length === 1) return { producto: delProyecto[0] };
    return { empate: delProyecto, paso: `el repo de Azure ${proyecto}/${nombre} y su proyecto` };
  }
  const porNombre = unicos(ent.filter((e) => low(e.repo) === low(nombre)).map((e) => e.producto));
  if (porNombre.length === 1) return { producto: porNombre[0] };
  return { empate: porNombre, paso: `el nombre del repo ${nombre} (un cambio sin proyecto)` };
}

/** El producto de la carpeta del volcado `<padre>/<carpeta>` (paso 2 del AC 13). */
function porCarpeta(ent, carpeta) {
  if (!carpeta) return { empate: [], paso: 'sin carpeta' };
  const exacta = unicos(ent.filter((e) => low(e.ruta) === low(carpeta)).map((e) => e.producto));
  if (exacta.length === 1) return { producto: exacta[0] };
  // la ruta exacta empata: queda sin ubicar, no se sigue buscando por el padre o la hoja (decisión 8 — pase adversarial)
  if (exacta.length > 1) return { empate: exacta, paso: `la carpeta ${carpeta}` };
  const partes = String(carpeta).split('/');
  const padre = partes.length > 1 ? partes[0] : '';
  const hoja = partes[partes.length - 1];
  if (padre) {
    const porPadre = unicos(ent.filter((e) => low(e.producto) === low(padre)).map((e) => e.producto));
    if (porPadre.length === 1) return { producto: porPadre[0] };
  }
  const porHoja = unicos(ent.filter((e) => low(e.ruta.split('/').pop()) === low(hoja)).map((e) => e.producto));
  if (porHoja.length === 1) return { producto: porHoja[0] };
  return { empate: exacta.length > 1 ? exacta : porHoja, paso: `la carpeta ${carpeta}` };
}

/** Las fotos de proyecto (2.20) que traen ese repo, leídas por sus campos. */
function fotosDe(fotos, repo) {
  if (!Array.isArray(fotos) || !repo) return [];
  return unicos(fotos.filter((f) => f && typeof f.repo === 'string' && low(f.repo) === low(repo) && typeof f.proyecto === 'string').map((f) => `${f.proyecto}/${f.repo}`));
}

function motivoSinUbicar(intentos, fotos) {
  const partes = intentos.map((i) => (i.empate.length ? `${i.paso}: empatan ${i.empate.join(', ')}` : `${i.paso}: ningún producto`));
  if (fotos.length) partes.push(`está en las fotos de proyecto ${fotos.join(', ')}: corregirlo con un add`);
  return partes.join(' · ');
}

/**
 * Dónde trabaja una persona (AC 13-16), en productos de repos.json. `datos`: `repos` (repos.json o su lista),
 * `fotos` (`[{ proyecto, repo }]`, opcional), `corridas` (`[{ maquina, producto: '<padre>/<carpeta>', cambio: { repos:
 * [{ nombre, proyecto, principal }] } | null }]`) y `pedidos` (`[{ proyecto, asignado }]`). Sólo cuentan las corridas de
 * máquinas confirmadas para esa persona. Devuelve `{ estado, motivo?, productos: [{ producto, de, agregado? }],
 * sin_ubicar: [{ clave, motivo }], pedidos_no_medidos: [{ proyecto, motivo }] }`.
 */
function dondeTrabaja(sesion, c, datos = {}) {
  // la persona con todos sus correos: sus máquinas, sus pedidos y su corrección pueden estar a nombre de
  // cualquiera de ellos
  const suyos = correosDe(sesion, c);
  const correcciones = Object.entries(c.projects).filter(([k]) => suyos.includes(normalizarCorreo(k))).map(([, v]) => v);
  const add = correcciones.flatMap((corr) => (Array.isArray(corr && corr.add) ? corr.add : []));
  const remove = new Set(correcciones.flatMap((corr) => (Array.isArray(corr && corr.remove) ? corr.remove : [])));
  const ent = entradasDeRepos(datos.repos);
  const productos = new Map();   // producto → { de: Set, agregado }
  const sinUbicar = [];
  const pedidosNoMedidos = [];
  const sumar = (p, de) => { if (!productos.has(p)) productos.set(p, { de: new Set(), agregado: false }); productos.get(p).de.add(de); };
  let estado = 'medido';
  let motivo = null;
  if (!ent) { estado = 'no_medido'; motivo = 'no hay repos.json legible: no se puede deducir en qué productos trabaja'; }
  else {
    for (const r of Array.isArray(datos.corridas) ? datos.corridas : []) {
      if (!r || !r.maquina) continue;
      const e = estadoDeMaquina(r.maquina, c);
      if (e.estado !== 'confirmada' || !suyos.includes(e.person)) continue;
      const repos = r.cambio && Array.isArray(r.cambio.repos) ? r.cambio.repos : [];
      const principal = repos.find((x) => x && x.principal) || repos[0] || null;
      const intentos = [];
      let producto = null;
      if (principal) {
        const p1 = porRepoDeAzure(ent, principal.proyecto || null, principal.nombre || null);
        if (p1.producto) producto = p1.producto; else intentos.push(p1);
      }
      if (!producto) {
        const p2 = porCarpeta(ent, r.producto || null);
        if (p2.producto) producto = p2.producto; else intentos.push(p2);
      }
      if (producto) { sumar(producto, 'corridas'); continue; }
      const clave = principal ? `${principal.proyecto ? `${principal.proyecto}/` : ''}${principal.nombre} (${r.producto || 'sin carpeta'})` : String(r.producto || 'sin carpeta');
      if (!sinUbicar.some((x) => x.clave === clave)) {
        const repo = (principal && principal.nombre) || String(r.producto || '').split('/').pop();
        sinUbicar.push({ clave, motivo: motivoSinUbicar(intentos, fotosDe(datos.fotos, repo)) });
      }
    }
    for (const p of Array.isArray(datos.pedidos) ? datos.pedidos : []) {
      if (!p) continue;
      const asignado = normalizarCorreo(p.asignado);
      if (!FORMA_CORREO.test(asignado)) {
        if (asignado) pedidosNoMedidos.push({ proyecto: p.proyecto || null, motivo: 'el asignado no tiene forma de correo (un usuario de la plataforma): no se cruza con la persona' });
        continue;
      }
      if (!suyos.includes(asignado)) continue;
      const delProyecto = unicos(ent.filter((e) => low(e.proyecto) === low(dec(p.proyecto))).map((e) => e.producto));
      if (delProyecto.length === 1) { sumar(delProyecto[0], 'pedidos'); continue; }
      const clave = `pedido del proyecto ${dec(p.proyecto)}`;
      if (!sinUbicar.some((x) => x.clave === clave)) sinUbicar.push({ clave, motivo: motivoSinUbicar([{ empate: delProyecto, paso: `el proyecto ${dec(p.proyecto)}` }], []) });
    }
  }
  for (const a of add) { if (!productos.has(a)) productos.set(a, { de: new Set(), agregado: true }); else productos.get(a).agregado = true; }
  for (const r of remove) productos.delete(r);
  return {
    estado, ...(motivo ? { motivo } : {}),
    productos: [...productos.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([producto, v]) => ({ producto, de: [...v.de].sort(), ...(v.agregado ? { agregado: true } : {}) })),
    sin_ubicar: sinUbicar,
    pedidos_no_medidos: pedidosNoMedidos,
  };
}

/** La vista de una persona (AC 17): sólo sus máquinas, sus productos y sus repos sin ubicar. Nada de otro. */
function vistaDePersona(sesion, c, datos = {}) {
  const suyos = correosDe(sesion, c);
  const maquinas = Object.entries(c.machines)
    .filter(([m, e]) => e && suyos.includes(normalizarCorreo(e.person)) && !(uniones(c)[m]))
    .map(([m]) => ({ maquina: m, estado: estadoDeMaquina(m, c).estado }))
    .sort((a, b) => (a.maquina < b.maquina ? -1 : 1));
  const d = dondeTrabaja(sesion, c, datos);
  return { maquinas, productos: d.productos, sin_ubicar: d.sin_ubicar, estado: d.estado, ...(d.motivo ? { motivo: d.motivo } : {}) };
}

module.exports = {
  normalizarCorreo, huellaDeCorreo, leerCorreosInformados, contexto, listaDeAcceso, cambiosDeAcceso, textoDeCambios, correosDe, estadoDeMaquina, puedeVer, esPersona,
  estadoDeLaConfiguracion, maquinasPorConfirmar, maquinasSinActividad, dondeTrabaja, vistaDePersona, PLAZO_MS,
};
