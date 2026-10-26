#!/usr/bin/env node
'use strict';
/*
 * runs-review.js — LA REVISIÓN NOCTURNA DE LAS EJECUCIONES: LEE LAS NUEVAS DEL BUZÓN Y DICE CUÁLES TUVIERON FALLAS DEL
 * ARNÉS.
 *
 * Cada noche, sin modelo: baja el buzón (las conversaciones, sólo las de la ventana: download-runs.js --threads-since),
 * lee cada ejecución, le pasa las reglas de rules.js y deja una ficha POR CAUSA (regla y categoría) en
 * `inbox/runs-review/`, con la ficha común del ciclo de la noche (scripts/nightly/findings/cycle.js): adentro, la lista
 * de las ejecuciones que la traen. El estado de la pasada va en `inbox/runs-review/last-run.json`, que lee el resumen
 * diario. El id de cada ejecución es el de la pestaña Corridas (`leerRegistro` de runs.js: misma máquina después de
 * unir carpetas viejas); una sesión que corrió dos stories da dos ejecuciones con el mismo id y distinto `base`.
 *
 * 🔴 NINGÚN TEXTO LIBRE SALE. La ficha lleva sólo ids, fechas, números y valores de las listas cerradas de rules.js: ni
 *    comandos, ni salidas, ni rutas del disco del dev, ni el motivo escrito en bypass.log, ni el texto de un error de la
 *    bajada. El enlace de cada ejecución no se guarda: se arma al leer (`enlaceDeCaso`), con el sitio o relativo.
 * 🔴 «NO PUDE» NO ES «LIMPIO». Sin conversación, la pasada lo cuenta en `sin_hilo`; con la bajada fallada no se toca
 *    ninguna ficha; y un volcado, una ficha o una línea que no se pudo leer se cuentan en `ilegibles` y dejan la pasada
 *    en `completo: false`.
 *
 * Ciclo de una ficha: nace en `pending/`; la noche que vuelve a ver la causa la actualiza donde esté (una aparición más
 * y las ejecuciones nuevas). Una pasada entera cuenta una noche sin aparecer a cada ficha de `pending/` y `promoted/`
 * que no vio; a las N noches (`findings.resolve_after_nights`) queda resuelta y pasa a `archived/`. Una pasada a medias
 * no cuenta: la causa pudo estar en lo que no se leyó. Una resuelta o una ignorada de `archived/` que vuelve se reabre
 * en `pending/` y, si tenía pedido, se le avisa al pedido que volvió (sólo un comentario). Una migrada no se toca.
 * Cada archivo se escribe a un temporal y se renombra.
 *
 * Las fichas por ejecución de antes (sin `fuente:`, con `reglas`) que siguen en `pending/` se migran una vez, al
 * empezar la pasada: se agrupan por causa, se escribe la ficha por causa y recién después cada vieja pasa a `archived/`
 * con `veredicto: "migrada"`. Las ya decididas (`promoted/`, `archived/`) no se tocan.
 *
 * Uso: node scripts/nightly/runs-review/runs-review.js run --mailbox <dir> --operations <clon de operaciones> --today <AAAA-MM-DD>
 *        [--days 7] [--no-download]
 *      node scripts/nightly/runs-review/runs-review.js migrate --operations <clon de operaciones> --today <AAAA-MM-DD> [--dry-run]
 * Salida: 0 pasada entera · 1 parcial o sin poder bajar · 2 uso.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const RULES = require('./rules.js');
const RUNS = require('../dashboard/runs.js');
const OPS = require('../../lib/operations-config.js');
const CYCLE = require('../findings/cycle.js');
const SOURCES = require('../findings/sources.js');
const NOMBRES = require('../findings/cause-names.js');

const CARPETAS = ['pending', 'promoted', 'archived'];
const DIA = /^\d{4}-\d{2}-\d{2}$/;
// Un campo que viene del volcado entra a la ficha sólo con forma de id o de fecha; si no, null.
const FORMA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const comoId = (v) => (typeof v === 'string' && FORMA_ID.test(v) ? v : null);
// La clave de una causa: la que acepta la ficha común (sin `|`, que es el separador de causas-vistas.json)
const FORMA_CAUSA = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

/** El día de la ejecución por su nombre (las dos formas que sube upload-runs.js); null si no trae una fecha legible. */
function diaDelNombre(base) {
  const a = /-(\d{4}-\d{2}-\d{2})T\d{4}$/.exec(base);
  if (a) return a[1];
  const b = /-(\d{4})(\d{2})(\d{2})\d{6}-sin-cerrar$/.exec(base);
  return b ? `${b[1]}-${b[2]}-${b[3]}` : null;
}
const menosDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

/** Escribe entero o no escribe: a un temporal al lado y después el renombre (si el renombre falla, el temporal se borra). */
function escribirEntero(p, contenido) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido, 'utf8');
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } throw e; }
}
/** La ficha por ejecución de antes: un campo por renglón, cada valor en JSON. Se sigue escribiendo al migrarla. */
function escribirFicha(p, f) {
  const orden = ['id', 'fecha', 'maquina', 'story', 'base', 'archivada', 'cierre', 'reglas', 'sin_hilo', 'escapes_registro', 'enlace', 'enlace_sin_sitio', 'veredicto', 'vista_por_ultima_vez', 'reaparecido', 'resuelta_sola'];
  const y = ['# Ficha de la revisión nocturna de las ejecuciones. La decide quien mantiene el arnés:',
    '# promoted/ si terminó en trabajo, archived/ si no. Sin texto de la conversación, a propósito.',
    ...orden.filter((k) => f[k] !== undefined).map((k) => `${k}: ${JSON.stringify(f[k])}`), ''];
  escribirEntero(p, y.join('\n'));
}
/**
 * Una ficha leída campo por campo (la vieja o la común); `reglas` siempre es una lista. Si la ficha trae `reglas:` y no
 * es una lista de objetos (un JSON cortado, una edición a mano), `reglasRotas` (no enumerable) lo dice: esa ficha no se
 * puede migrar sin perder sus causas.
 */
function leerFicha(p) {
  const out = {};
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^([a-z_]+): (.*)$/.exec(l);
    if (!m) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = null; }
  }
  const rotas = Object.prototype.hasOwnProperty.call(out, 'reglas') && !(Array.isArray(out.reglas) && out.reglas.every((r) => r && typeof r === 'object'));
  if (!Array.isArray(out.reglas)) out.reglas = [];
  out.reglas = out.reglas.filter((r) => r && typeof r === 'object');
  Object.defineProperty(out, 'reglasRotas', { value: rotas, enumerable: false });
  return out;
}

/** La causa de una regla (`{ regla, categoria }`): su código, o `<regla>:<categoría>`. */
const causaDe = (x) => (x.categoria === null || x.categoria === undefined ? String(x.regla) : `${x.regla}:${x.categoria}`);
/** El enlace de una ejecución de una ficha: con la dirección del sitio, o relativo sin ella. */
const enlaceDeCaso = (c, urlSitio) => `${urlSitio ? String(urlSitio).replace(/\/+$/, '') : ''}/corridas?abrir=${c.ejecucion}`;
/** Una ejecución como caso de la ficha: sólo campos con forma, así su huella es la misma cada noche. */
const casoDe = ({ id, base, dia, maquina, story }) => ({ ejecucion: comoId(id), base: comoId(base), dia: DIA.test(String(dia || '')) ? dia : null,
  maquina: comoId(maquina), story: comoId(story) });
/** ¿Ninguna carpeta tiene ya un archivo con ese nombre? Uno que está y no se pudo leer no se pisa con una ficha nueva. */
const libre = (raiz, nombre) => CARPETAS.every((c) => !fs.existsSync(path.join(raiz, c, nombre)));

/**
 * Las fichas que ya hay: las por causa, por causa; las viejas (por ejecución), aparte; y cuántas no se pudieron leer.
 * Una vieja que se lee no es ilegible: la lee el lector viejo y alimenta lo «conocido». Una vieja con las reglas rotas sí.
 */
function fichasPrevias(raiz) {
  const porCausa = new Map();
  const viejas = [];
  let ilegibles = 0;
  for (const c of CARPETAS) {
    const dir = path.join(raiz, c);
    let nombres = [];
    try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort(); } catch (e) { if (e.code !== 'ENOENT') ilegibles += 1; continue; }
    for (const f of nombres) {
      const ruta = path.join(dir, f);
      let txt;
      try { txt = fs.readFileSync(ruta, 'utf8'); } catch { ilegibles += 1; continue; }
      if (SOURCES.esVieja(txt)) {
        let datos = null;
        try { datos = leerFicha(ruta); } catch { datos = null; }
        if (!datos || typeof datos.id !== 'string' || !datos.id || datos.reglasRotas) { ilegibles += 1; continue; }
        viejas.push({ carpeta: c, ruta, datos });
        continue;
      }
      let ficha;
      try { ficha = CYCLE.parsear(txt); } catch { ilegibles += 1; continue; }
      if (ficha.fuente !== 'ejecuciones') { ilegibles += 1; continue; }
      porCausa.set(ficha.causa, { carpeta: c, ruta, ficha });
    }
  }
  return { porCausa, viejas, ilegibles };
}

/**
 * La migración de las fichas por ejecución que siguen en `pending/`: `{ viejas, causas, casos, ilegibles, movidas }`.
 * Con `simular`, sólo cuenta. Sin simular, escribe primero cada ficha por causa (si ya está, le suma los casos que no
 * tenía) y recién después mueve cada vieja a `archived/` con `veredicto: "migrada"`; una migración cortada sigue la
 * noche siguiente sin duplicar (los casos se juntan por su huella). Una vieja que no se lee (o con las reglas rotas)
 * queda quieta. Una ficha por causa que está en `archived/` no se toca: sus casos de la vieja quedan en la migrada.
 */
function migrar({ ops: opsDir, today, simular = false }) {
  const raiz = path.join(opsDir, 'inbox', 'runs-review');
  const out = { viejas: 0, causas: 0, casos: 0, ilegibles: 0, movidas: 0 };
  const dir = path.join(raiz, 'pending');
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort(); } catch (e) { if (e.code !== 'ENOENT') out.ilegibles += 1; return out; }
  const viejas = [];
  const grupos = new Map();
  for (const n of nombres) {
    const ruta = path.join(dir, n);
    let txt;
    try { txt = fs.readFileSync(ruta, 'utf8'); } catch { out.ilegibles += 1; continue; }
    if (!SOURCES.esVieja(txt)) continue;
    let d = null;
    try { d = leerFicha(ruta); } catch { d = null; }
    if (!d || !comoId(d.id) || d.reglasRotas) { out.ilegibles += 1; continue; }
    viejas.push({ ruta, datos: d });
    // el día del caso, armado como lo arma la pasada: del nombre del volcado, o de la hora de archivado
    const archivada = typeof d.archivada === 'string' && DIA.test(d.archivada.slice(0, 10)) ? d.archivada.slice(0, 10) : null;
    const caso = casoDe({ id: d.id, base: d.base, dia: diaDelNombre(String(d.base || '')) || archivada || d.fecha, maquina: d.maquina, story: d.story });
    const dias = [d.fecha, d.vista_por_ultima_vez].filter((x) => DIA.test(String(x || '')));
    for (const x of d.reglas) {
      if (typeof x.regla !== 'string') continue;
      const k = causaDe(x);
      if (!FORMA_CAUSA.test(k)) continue;
      const g = grupos.get(k) || { regla: x.regla, categoria: x.categoria === undefined ? null : x.categoria, casos: [], dias: new Set(), primera: null, ultima: null };
      g.casos.push(caso);
      for (const f of dias) g.dias.add(f);
      if (DIA.test(String(d.fecha || '')) && (!g.primera || d.fecha < g.primera)) g.primera = d.fecha;
      const ultima = DIA.test(String(d.vista_por_ultima_vez || '')) ? d.vista_por_ultima_vez : d.fecha;
      if (DIA.test(String(ultima || '')) && (!g.ultima || ultima > g.ultima)) g.ultima = ultima;
      grupos.set(k, g);
    }
  }
  out.viejas = viejas.length;
  out.causas = grupos.size;
  out.casos = [...grupos.values()].reduce((s, g) => s + g.casos.length, 0);
  if (simular) return out;
  const previas = fichasPrevias(raiz).porCausa;
  for (const [k, g] of grupos) {
    const primera = g.primera || today;
    const ultima = g.ultima && g.ultima >= primera ? g.ultima : primera;
    const prev = previas.get(k);
    if (prev && prev.carpeta === 'archived') continue;
    let f;
    let ruta;
    if (prev) {
      f = CYCLE.conCasos({ ...prev.ficha }, g.casos);
      if (primera < f.primera_vez) f.primera_vez = primera;
      if (ultima > f.ultima_vez) f.ultima_vez = ultima;
      f.apariciones = Math.max(f.apariciones, g.dias.size);
      ruta = prev.ruta;
    } else {
      f = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: k, nombre: NOMBRES.nombreDe('ejecuciones', g), hoy: primera, casos: g.casos });
      f.ultima_vez = ultima;
      f.apariciones = Math.max(1, g.dias.size);
      // una ficha de esa causa que está y no se leyó no se pisa: la vieja espera en pending/ a la noche que se lea
      if (!libre(raiz, `${f.id}.yaml`)) { out.ilegibles += 1; for (const v of viejas) v.esperar = v.esperar || v.datos.reglas.some((x) => causaDe(x) === k); continue; }
      ruta = path.join(raiz, 'pending', `${f.id}.yaml`);
    }
    escribirEntero(ruta, CYCLE.serializar(f));
  }
  for (const v of viejas) {
    if (v.esperar) continue;
    escribirFicha(path.join(raiz, 'archived', path.basename(v.ruta)), { ...v.datos, veredicto: 'migrada' });
    fs.unlinkSync(v.ruta);
    out.movidas += 1;
  }
  return out;
}

/**
 * Las líneas JSON de un `.gz`: `{ lineas, rotas }`; `null` si el archivo no está; `{ lineas: null, roto: true }` si está
 * y no se puede leer (no es gzip, permisos).
 */
function leerJsonl(p) {
  let t;
  try { t = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { lineas: null, rotas: 0, roto: true }; }
  const lineas = [];
  let rotas = 0;
  for (const l of t.split('\n')) { if (!l.trim()) continue; try { lineas.push(JSON.parse(l)); } catch { rotas += 1; } }
  return { lineas, rotas };
}
function leerRegistros(dirMaquina, cache, estado) {
  if (cache.has(dirMaquina)) return cache.get(dirMaquina);
  const r = path.join(dirMaquina, 'registros');
  let cobertura = null;
  try { cobertura = JSON.parse(fs.readFileSync(path.join(r, 'cobertura.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') estado.ilegibles += 1; }
  const b = leerJsonl(path.join(r, 'bypass.log.gz'));
  if (b) estado.ilegibles += b.roto ? 1 : b.rotas;
  const out = { cobertura, bypass: b && !b.roto ? b.lineas : null };
  cache.set(dirMaquina, out);
  return out;
}

/** Lo que entra a la ficha de lo que devolvieron las reglas: categorías de forma cerrada, sin texto. */
function reglasParaFicha(reglas) {
  return reglas.map((r) => {
    const x = { regla: r.regla, categoria: r.categoria === null ? null : (/^[A-Za-z0-9:/._-]{1,80}$/.test(String(r.categoria)) ? r.categoria : 'otro'), cuenta: r.cuenta };
    for (const k of ['con_frase', 'con_motivo', 'pendientes', 'rojos']) if (r[k] !== undefined) x[k] = r[k];
    return x;
  });
}
// El estado de una bajada que no fue entera va por su código (`sin_permiso`, `parcial`…); su texto puede traer rutas.
const estadoDeBajada = (e) => (typeof e === 'string' && /^[a-z_]{1,30}$/.test(e) ? e : 'desconocido');

/** Los volcados del espejo, por carpeta de máquina: `{ ruta, carpeta }`, y cuántas carpetas no se pudieron leer. */
function volcadosDelEspejo(mailbox) {
  const out = [];
  let ilegibles = 0;
  let carpetas = [];
  try { carpetas = fs.readdirSync(mailbox, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return null; }
  for (const c of carpetas) {
    let fs_ = [];
    try { fs_ = fs.readdirSync(path.join(mailbox, c)).filter((f) => f.endsWith('.json')).sort(); } catch { ilegibles += 1; continue; }
    for (const f of fs_) out.push({ ruta: path.join(mailbox, c, f), carpeta: c });
  }
  return { lista: out, ilegibles };
}

/** La clave de una causa: la regla y su categoría (`null` es la regla sola), como la escribe causas-vistas.json. */
const parDe = (x) => `${x.regla}|${x.categoria === null || x.categoria === undefined ? '' : x.categoria}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Si una pasada anterior de HOY fue entera (una que se corta antes de revisar no la pisa), y si el archivo no se lee. */
function pasadaDeHoy(archivo, today) {
  let l;
  try { l = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { return { entera: false, ilegible: !(e && e.code === 'ENOENT') }; }
  return { entera: Boolean(l && typeof l === 'object' && l.fecha === today && l.completo === true), ilegible: false };
}

/**
 * `causas-vistas.json`: la fecha de la primera vez de cada causa. Lo nuevo de hoy se decide con él y no con la pasada
 * anterior, así una pasada repetida, cortada o que no vuelve a ver una ejecución no cambia lo que es nuevo. `{ pares,
 * ilegible }`; `pares: null` si el archivo no está (la primera noche: se usan las fichas previas).
 */
function leerVistas(archivo) {
  let j;
  try { j = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { return { pares: null, ilegible: !(e && e.code === 'ENOENT') }; }
  if (!j || typeof j !== 'object' || !j.pares || typeof j.pares !== 'object' || Array.isArray(j.pares)) return { pares: null, ilegible: true };
  const pares = {};
  for (const [k, v] of Object.entries(j.pares)) if (typeof v === 'string' && DIA.test(v)) pares[k] = v;
  return { pares, ilegible: false };
}

/** Las frases de `motivo` de last-run.json: las únicas que el resumen de la mañana imprime. */
const MOTIVOS = [
  /^la bajada del buzón no fue entera \([a-z_]{1,40}\)$/,
  /^operations\.json no se pudo leer: los enlaces van sin el sitio$/,
  /^la carpeta del buzón no se pudo leer$/,
  /^\d{1,9} archivo\(s\) o línea\(s\) ilegible\(s\)$/,
  /^la pasada se cortó por un error \([\p{L}\p{N}_ ]{1,40}\)$/u,
];

async function run(opts) {
  const { mailbox, ops: opsDir, today } = opts;
  const days = Number.isFinite(opts.days) ? opts.days : 7;
  if (!mailbox || !opsDir || !DIA.test(String(today || ''))) return { codigo: 2, motivo: 'faltan --mailbox, --operations o --today (AAAA-MM-DD)' };
  const raiz = path.join(opsDir, 'inbox', 'runs-review');
  // las decisiones confirmadas en el sitio que otra persona aprobó, antes de revisar; sólo renglones a la
  // salida de error: last-run.json conserva su forma
  for (const l of CYCLE.aplicarDecisiones({ base: opsDir, fuente: 'ejecuciones' }).lineas) process.stderr.write(`${l}\n`);
  // el pedido de trabajo de cada arreglo decidido que todavía no lo tiene
  // un error del paso no corta la revisión de la noche: se dice y la noche siguiente vuelve a pedir
  try {
    const pedidos = await CYCLE.pedirTrabajo({ base: opsDir, fuente: 'ejecuciones', operations: path.join(opsDir, 'operations.json'), run: opts.plataforma || null, repoDir: opsDir });
    for (const l of pedidos.lineas) process.stderr.write(`${l}\n`);
  } catch (e) { process.stderr.write(`pedidos de ejecuciones: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); esta noche no se pidió ninguno\n`); }
  const desde = menosDias(today, days);
  const estado = { fecha: today, completo: true, motivo: null, miradas: 0, con_fallas: 0, nuevas: 0, sin_hilo: 0, hilos_sin_hooks: 0, ilegibles: 0, causas: [] };
  const previa = pasadaDeHoy(path.join(raiz, 'last-run.json'), today);
  if (previa.ilegible) estado.ilegibles += 1;
  const vistas = leerVistas(path.join(raiz, 'causas-vistas.json'));
  if (vistas.ilegible) estado.ilegibles += 1;
  const cerrar = (codigo) => {
    escribirEntero(path.join(raiz, 'last-run.json'), `${JSON.stringify(estado, null, 2)}\n`);
    return { codigo, estado };
  };
  // cortada antes de revisar: una pasada entera de hoy queda como está (lo que dijo sigue valiendo para la mañana)
  const cortadaAntes = () => (previa.entera ? { codigo: 1, estado } : cerrar(1));
  // conocida: vista antes de hoy según causas-vistas.json; un par que el archivo no tiene (la primera noche, o una ficha
  // anterior a él), si está en una ficha previa de antes de hoy (con la fecha más vieja de las que lo traen)
  const enFichasViejas = new Map();
  const causas = new Map();
  const conocida = (k) => (vistas.pares && Object.prototype.hasOwnProperty.call(vistas.pares, k) ? vistas.pares[k] < today : enFichasViejas.has(k));
  const armarCausas = () => [...causas.entries()]
    .map(([k, c]) => ({ regla: c.regla, categoria: c.categoria, ejecuciones: c.ejecuciones, nueva: !conocida(k) }))
    .sort((a, b) => b.ejecuciones - a.ejecuciones || cmp(a.regla, b.regla) || cmp(a.categoria || '', b.categoria || ''));
  // suma lo visto: los pares de las fichas viejas con su fecha y los de esta pasada con la de hoy; una fecha escrita no cambia
  const guardarVistas = () => {
    const pares = { ...(vistas.pares || {}) };
    for (const [k, f] of enFichasViejas) if (!(k in pares)) pares[k] = f;
    for (const k of causas.keys()) if (!(k in pares)) pares[k] = today;
    escribirEntero(path.join(raiz, 'causas-vistas.json'), `${JSON.stringify({ esquema: 1, pares }, null, 2)}\n`);
  };
  // la ficha de cada causa vista: una aparición más donde esté, o una nueva en pending/. Una de archived/ resuelta o
  // ignorada se reabre en pending/ (primero se escribe la nueva, después se borra la archivada); una migrada no se toca.
  let previas = { porCausa: new Map(), viejas: [], ilegibles: 0 };
  // cada causa se escribe una sola vez por pasada: si la pasada se corta después, el camino del error no la repite
  const escritas = new Set();
  // las causas que esta noche trajeron un caso que la ficha no tenía: el cruce con su pedido cerrado mira sólo ésas
  const conCasoNuevo = new Set();
  const totalDe = (f) => f.casos_total || (f.casos || []).length;
  const escribirCausas = () => {
    for (const c of causas.values()) {
      const clave = causaDe(c);
      if (!FORMA_CAUSA.test(clave) || escritas.has(clave)) continue;
      const prev = previas.porCausa.get(clave);
      if (prev && prev.carpeta === 'archived') {
        const g = CYCLE.registrarAparicion(prev.ficha, today, c.casos);
        if (totalDe(g) > totalDe(prev.ficha)) conCasoNuevo.add(clave);
        // se reabrió esta noche: una ignorada que ya había vuelto antes guarda `reaparecio` y igual se reabre
        if (g.estado === 'reaparecio' && g.reaparecio_el === today) {
          escribirEntero(path.join(raiz, 'pending', path.basename(prev.ruta)), CYCLE.serializar(g));
          fs.unlinkSync(prev.ruta);
        }
        escritas.add(clave);
        continue;
      }
      if (prev) {
        const g = CYCLE.registrarAparicion(prev.ficha, today, c.casos);
        if (totalDe(g) > totalDe(prev.ficha)) conCasoNuevo.add(clave);
        escribirEntero(prev.ruta, CYCLE.serializar(g));
        escritas.add(clave);
        continue;
      }
      const f = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: clave, nombre: NOMBRES.nombreDe('ejecuciones', c), hoy: today, casos: c.casos });
      // una ficha de esa causa que está y no se pudo leer (ya contada en ilegibles) no se pisa con una nueva
      if (!libre(raiz, `${f.id}.yaml`)) { escritas.add(clave); continue; }
      escribirEntero(path.join(raiz, 'pending', `${f.id}.yaml`), CYCLE.serializar(f));
      escritas.add(clave);
      estado.nuevas += 1;
    }
  };
  // una noche sin aparecer para cada ficha de pending/ y promoted/ que la pasada entera no vio; la resuelta va a archived/
  const contarNoches = () => {
    const n = CYCLE.nochesParaResolver(path.join(opsDir, 'operations.json'));
    if (!n.ok) { process.stderr.write(`noches de ejecuciones: ${n.motivo}; esta noche no se cuenta\n`); return; }
    const vistasHoy = new Set([...causas.values()].map(causaDe));
    for (const p of previas.porCausa.values()) {
      if (p.carpeta === 'archived' || vistasHoy.has(p.ficha.causa)) continue;
      const g = CYCLE.noche({ ficha: p.ficha, presente: false, medida: true, n: n.n, hoy: today });
      if (g.estado === 'resuelta') {
        escribirEntero(path.join(raiz, 'archived', path.basename(p.ruta)), CYCLE.serializar(g));
        fs.unlinkSync(p.ruta);
      } else if (g.noche_contada !== p.ficha.noche_contada) escribirEntero(p.ruta, CYCLE.serializar(g));
    }
  };

  if (!opts.noDownload) {
    const bajar = opts.bajar || ((o) => require('../../metrics/download-runs.js').bajar(o));
    // la bajada escribe en la carpeta de --mailbox, para que esta pasada lea lo que bajó; el ambiente queda como estaba
    let r;
    // una bajada que se cae lo dice en el registro con la clase del error, nunca con su texto (puede traer rutas)
    try { r = await bajar({ hilosDesde: desde, dirBuzon: mailbox }); } catch (e) {
      process.stderr.write(`runs-review: la bajada del buzón se cayó (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')})\n`);
      r = { codigo: 1, res: { completo: false, estado: 'error' } };
    }
    const res = (r && r.res) || {};
    if (!(r && r.codigo === 0 && res.completo === true)) {
      // la bajada no fue entera: no se mueve ni se escribe ninguna ficha
      estado.completo = false;
      estado.motivo = `la bajada del buzón no fue entera (${estadoDeBajada(res.estado)})`;
      return cortadaAntes();
    }
  }

  try {
    const opsJson = path.join(opsDir, 'operations.json');
    try {
      const o = OPS.load(opsJson);
      if (!o.ok && fs.existsSync(opsJson)) estado.motivo = 'operations.json no se pudo leer: los enlaces van sin el sitio';
    } catch { estado.motivo = 'operations.json no se pudo leer: los enlaces van sin el sitio'; }

    const espejo = volcadosDelEspejo(mailbox);
    if (espejo === null) { estado.completo = false; estado.motivo = 'la carpeta del buzón no se pudo leer'; return cortadaAntes(); }
    // las fichas por ejecución de antes que quedan en pending/ pasan a su causa antes de revisar
    migrar({ ops: opsDir, today });
    const lista = espejo.lista;
    estado.ilegibles += espejo.ilegibles;
    // id y máquina de cada sesión, como los arma la pestaña Corridas
    const reg = RUNS.leerRegistro(null, RUNS.nombresDePasos().nombres, { buzon: mailbox, soloBuzon: true });
    const porSesion = new Map();
    for (const c of reg.corridas) {
      const sid = c._volcado ? (() => { try { return JSON.parse(fs.readFileSync(c._volcado, 'utf8')).marker.sessionId; } catch { return null; } })() : null;
      if (sid) porSesion.set(sid, { id: c.id, maquina: c.maquina });
    }
    previas = fichasPrevias(raiz);
    estado.ilegibles += previas.ilegibles;
    // las causas de antes de hoy, con su fecha más vieja: las de las fichas viejas (en cualquier carpeta: lo decidido
    // también cuenta) y la primera vez de cada ficha por causa
    const conocer = (k, fecha) => { if (!enFichasViejas.has(k) || fecha < enFichasViejas.get(k)) enFichasViejas.set(k, fecha); };
    for (const p of previas.viejas) {
      if (!DIA.test(String(p.datos.fecha || '')) || p.datos.fecha >= today) continue;
      for (const x of p.datos.reglas) if (x && typeof x.regla === 'string') conocer(parDe(x), p.datos.fecha);
    }
    for (const p of previas.porCausa.values()) {
      if (p.ficha.primera_vez >= today) continue;
      const i = p.ficha.causa.indexOf(':');
      conocer(parDe(i < 0 ? { regla: p.ficha.causa, categoria: null } : { regla: p.ficha.causa.slice(0, i), categoria: p.ficha.causa.slice(i + 1) }), p.ficha.primera_vez);
    }
    const cacheRegistros = new Map();
    // una ejecución se mira una vez aunque esté en dos carpetas de la máquina (la vieja y la de código)
    const miradas = new Set();
    for (const { ruta, carpeta } of lista) {
      let volcado;
      try { volcado = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { volcado = null; }
      if (!volcado || typeof volcado !== 'object' || !volcado.marker || typeof volcado.marker !== 'object' || typeof volcado.marker.sessionId !== 'string') { estado.ilegibles += 1; continue; }
      const base = path.basename(ruta, '.json');
      const dia = diaDelNombre(base) || String(volcado.archivedAt || volcado.marker.startedAt || '').slice(0, 10);
      if (!DIA.test(dia) || dia < desde) continue;
      const sesion = porSesion.get(volcado.marker.sessionId) || { id: RUNS.idEstable(carpeta, volcado.marker.sessionId), maquina: carpeta };
      const unaVez = `${sesion.id}|${comoId(base)}`;
      if (miradas.has(unaVez)) continue;
      miradas.add(unaVez);
      estado.miradas += 1;
      const h = leerJsonl(ruta.replace(/\.json$/, '.hilo.jsonl.gz'));
      if (h) estado.ilegibles += h.roto ? 1 : h.rotas;
      const r = RULES.revisar({ volcado, lineasHilo: h && !h.roto ? h.lineas : null, registros: leerRegistros(path.dirname(ruta), cacheRegistros, estado) });
      if (r.sin_hilo) estado.sin_hilo += 1; else if (r.hilo_sin_hooks) estado.hilos_sin_hooks += 1;
      if (!r.reglas.length) continue;
      estado.con_fallas += 1;
      const caso = casoDe({ id: sesion.id, base, dia, maquina: sesion.maquina, story: volcado.marker.storyId });
      for (const x of reglasParaFicha(r.reglas)) {
        const k = parDe(x);
        if (!causas.has(k)) causas.set(k, { regla: x.regla, categoria: x.categoria, ejecuciones: 0, vista: null, casos: [] });
        const c = causas.get(k);
        if (c.vista !== unaVez) { c.vista = unaVez; c.ejecuciones += 1; c.casos.push(caso); }
      }
    }
    estado.causas = armarCausas();
    escribirCausas();
    guardarVistas();
    if (estado.ilegibles) { estado.completo = false; if (!estado.motivo) estado.motivo = `${estado.ilegibles} archivo(s) o línea(s) ilegible(s)`; }
    if (estado.completo) contarNoches();
    // el aviso a su pedido de cada ficha que volvió; como el pedido, un error no corta la noche
    try {
      const avisos = await CYCLE.avisarQueVolvio({ base: opsDir, fuente: 'ejecuciones', operations: opsJson, hoy: today, run: opts.plataforma || null, repoDir: opsDir });
      for (const l of avisos.lineas) process.stderr.write(`${l}\n`);
    } catch (e) { process.stderr.write(`avisos de ejecuciones: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); se avisa mañana\n`); }
    // y a su pedido cerrado, que la falla sigue
    try {
      const cerrados = await CYCLE.avisarCerradoConFallaViva({ base: opsDir, fuente: 'ejecuciones', operations: opsJson, hoy: today, run: opts.plataforma || null, repoDir: opsDir, vistas: conCasoNuevo });
      for (const l of cerrados.lineas) process.stderr.write(`${l}\n`);
    } catch (e) { process.stderr.write(`pedidos cerrados de ejecuciones: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); se mira mañana\n`); }
    return cerrar(estado.completo ? 0 : 1);
  } catch (e) {
    // una pasada cortada no deja el estado de ayer como si fuera de hoy
    estado.completo = false;
    estado.motivo = `la pasada se cortó por un error (${e && /^[A-Za-z0-9_]{1,40}$/.test(String(e.code)) ? e.code : 'sin código'})`;
    // cortada antes de revisar ninguna ejecución: como las demás salidas tempranas, no pisa una pasada entera de hoy
    if (!estado.miradas) return cortadaAntes();
    // las causas de lo que alcanzó a revisar: la mañana dice «parcial» con ellas, y lo nuevo no se pierde
    estado.causas = armarCausas();
    try { escribirCausas(); guardarVistas(); } catch { estado.ilegibles += 1; }
    return cerrar(1);
  }
}

function main(argv) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'migrate') {
    if (!val('--operations') || !DIA.test(String(val('--today') || ''))) { process.stderr.write('uso: runs-review.js migrate --operations <dir> --today <AAAA-MM-DD> [--dry-run]\n'); return Promise.resolve(2); }
    const r = migrar({ ops: val('--operations'), today: val('--today'), simular: argv.includes('--dry-run') });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return Promise.resolve(r.ilegibles ? 1 : 0);
  }
  if (argv[0] !== 'run') { process.stderr.write('uso: runs-review.js run --mailbox <dir> --operations <dir> --today <AAAA-MM-DD> [--days 7] [--no-download]\n       runs-review.js migrate --operations <dir> --today <AAAA-MM-DD> [--dry-run]\n'); return Promise.resolve(2); }
  const days = val('--days') === undefined ? undefined : Number(val('--days'));
  return run({ mailbox: val('--mailbox'), ops: val('--operations'), today: val('--today'), days, noDownload: argv.includes('--no-download') })
    .then((r) => { process.stdout.write(`${JSON.stringify(r.estado || { motivo: r.motivo }, null, 2)}\n`); return r.codigo; });
}

module.exports = { run, migrar, leerFicha, diaDelNombre, causaDe, enlaceDeCaso, MOTIVOS };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`runs-review: ${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; });
}
