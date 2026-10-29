'use strict';
/*
 * sources.js — LAS FUENTES DEL SITIO DE LA ORGANIZACIÓN Y SU REFRESCO.
 *
 * El sitio lee directo de DOS fuentes, con credenciales de sólo lectura:
 *   · el REPO DE OPERACIONES, de `main`: un clon superficial en una carpeta del disco del contenedor (no en
 *     `SITE_DATA_DIR`: un disco de red montado por SMB no admite el `chmod` que git hace al clonar; el clon
 *     se vuelve a armar en cada arranque) y `git fetch` en cada refresco. La credencial va en una cabecera pasada por variables de git (`GIT_CONFIG_*`, el patrón de `gitAuth` del
 *     exportador): nunca en la dirección, en un argumento ni en el disco.
 *   · el BUZÓN de corridas, con `bajar()` de scripts/metrics/download-runs.js y la credencial que da la plataforma —una SAS
 *     de sólo lectura, o la identidad administrada (cloud/)—. Se bajan los volcados y los registros; las conversaciones
 *     y los cambios de git, SÓLO con `site.mailbox.threads: true` y un disco del sitio (`SITE_DATA_DIR`), para el detalle
 *     de la pestaña Corridas. La bajada es incremental: lo que ya está en el disco no se vuelve a
 *     bajar. Esos textos sólo salen por `modelo()` de runs.js, saneados y filtrados por persona (G3).
 *
 * EL MODELO se arma en el servidor con LISTA BLANCA campo por campo: de cada foto se copian cantidades,
 * fechas, días, nombres de producto, proyecto y repo, números con su enlace, y estados. Nada de texto libre: los títulos,
 * los diagnósticos y los mensajes no llegan al modelo, así que tampoco a una vista. Cada fuente lleva
 * `{ estado: 'medido' | 'no_medido', codigo, fecha }`; `codigo` es de una lista cerrada (`sin_red`, `sin_permiso`,
 * `credencial_rechazada`, `parcial`, `fuente_vieja`, `sin_configurar`, y los propios de una foto: `sin_foto`, `ilegible`,
 * `sin_buzon`, `no_corre_banco`, `no_medido_noche`, y `cargando` para las corridas hasta la primera lectura del buzón). El motivo crudo —que nombra rutas, blobs y máquinas— va SÓLO al
 * registro del servidor.
 *
 * EL REFRESCO: cada `site.refresh_minutes` (15 si no está) y al despertar. El modelo nuevo reemplaza al viejo entero o no
 * lo reemplaza. Una fuente que falla deja su último bueno y una banda «no se pudo actualizar desde <hora>: <estado>»; una
 * foto más vieja que su `max_age_days` (sources.json del repo de operaciones, o el del arnés) sale `fuente_vieja`.
 *
 * operations.json TIENE SU PROPIA REGLA: si un refresco no lo puede leer o no valida, vale
 * el último bueno 24 horas desde el PRIMER refresco fallido, con una banda sólo para quienes mantienen; pasado el plazo,
 * el sitio se FRENA para todos. Sin último bueno, el freno es inmediato. El último bueno y la hora de la primera falla se
 * guardan en `SITE_DATA_DIR` (escritura atómica), así despertar o reiniciar no vuelve a empezar el plazo. La cuenta la
 * hace `estadoDeLaConfiguracion` de scripts/lib/people.js: el sitio no tiene otra (`estadoDelSitio` la traduce a la
 * banda y al freno).
 *
 * LO QUE QUEDA FUERA DEL MODELO: lo que cada máquina informa en su place.json (el correo de su dev) y la lista de
 * repos.json. Los usa la regla de quién es quién (access.js → people.js), pero el modelo va entero a quien mantiene: con
 * los correos adentro, una pantalla podría mostrarlos. Viajan aparte, en `personas()`.
 *
 * EL PERFIL DEL EQUIPO: con `SITE_PROFILE_REPO` y `SITE_PROFILE_TOKEN`, un clon igual, al
 * lado del de operaciones y por el mismo camino, para que la pestaña Configuración lea `team-repos.json` y `team-layer.json`.
 * Sin esas variables, no hay clon y la sección dice «no configurado». Un perfil que no se baja no frena nada: lo dice el
 * registro y su estado.
 *
 * EL CANDADO: `exclusivo(fn)` corre `fn` sin otro trabajo de git sobre los clones en el medio. El
 * refresco pasa por ahí (salvo la bajada del buzón, que no toca los clones), y la propuesta de la pestaña también: así un refresco no hace `reset --hard` mientras se arma un
 * commit, y un commit no ve un clon a medio bajar.
 *
 * Contrato con server.js: crearFuentes(…) → { arrancar, refrescar, estado, config, modelo, personas, detener, clones,
 * exclusivo, dirBuzon }.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const OPS = require('../lib/operations-config.js');
const people = require('../lib/people.js');
const COPIA = require('./operations-copy.js');
const { validAgeDays } = require('../nightly/projects/state-age.js');

/** Un proceso sin bloquear: { status, stdout, stderr, error }. Nunca rechaza; con `timeout`, lo corta. */
function correr(cmd, args, { cwd, env, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { resolve({ status: null, stdout: '', stderr: '', error }); return; }
    let stdout = ''; let stderr = ''; let error = null;
    const corte = setTimeout(() => { error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', (e) => { error = e; });
    p.on('close', (status) => { clearTimeout(corte); resolve({ status, stdout, stderr, error }); });
  });
}

const DIA = 86400000;
const PLAZO_CONFIG_MS = people.PLAZO_MS;
// la edad de la copia de operaciones que todavía no cuenta como falla
const PLAZO_COPIA_MS = 24 * 3600000;
const REFRESCO_POR_DEFECTO = 15;
const EDAD_MAXIMA_SIN_DECLARAR = 2;
const ARCHIVO_ESTADO = 'configuracion-estado.json';
// cuánto bajan de conversaciones (y cambios de git) una pasada del buzón, antes de resumirlas y borrarlas del disco: el
// disco del sitio guarda a lo sumo esto más los resúmenes y los volcados
const TOPE_CONVERSACIONES_BYTES = 300 * 1024 * 1024;
// la conversación más grande que el sitio baja y lee. Una sesión que queda abierta días crece sin parar (se vio una de
// 159 MB que cada máquina volvía a subir con otra huella): bajarla de nuevo cada vez llenaba la tanda entera y la pestaña
// no terminaba nunca de leer el buzón. Por arriba de esto la corrida queda en la tabla sin su conversación, y lo dice
const TOPE_CONVERSACION_BYTES = 50 * 1024 * 1024;
const SOURCES_DEL_ARNES = path.join(__dirname, '..', 'nightly', 'dashboard', 'sources.json');

/** La regla de operations.json: la de people.js, la única. */
const { estadoDeLaConfiguracion } = people;

/**
 * La banda y el freno del sitio para una configuración: `{ frenado: { desde, fallaDesde } | null, bandaConfig: { desde,
 * motivo } | null }`, en milisegundos. `frenado.desde` es desde cuándo está frenado (lo dice la página);
 * `frenado.fallaDesde`, el primer refresco fallido (lo dice /healthz). La banda lleva las rutas de los problemas.
 */
function estadoDelSitio({ hayUltimoBueno, fallaDesde, fallaRutas = null, ahora }) {
  const e = estadoDeLaConfiguracion({ hayUltimoBueno, fallaDesde, ahora });
  if (e.estado === 'frenado') return { frenado: { desde: Date.parse(e.frenado_desde), fallaDesde: Date.parse(e.desde) }, bandaConfig: null };
  if (e.estado === 'ultimo_bueno') return { frenado: null, bandaConfig: { desde: Date.parse(e.desde), motivo: fallaRutas } };
  return { frenado: null, bandaConfig: null };
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (Number.isFinite(x) ? x : null);
const texto = (x, max = 120) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const codigoDe = (x) => (typeof x === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(x) ? x : null);   // un código, nunca una frase
// un texto de la foto que llega a la pantalla, sin correos ni rutas de máquina: la foto ya los saca, esto es la segunda capa
const sinDatos = (s) => (s === null ? null : s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[correo]').replace(/(?<![\w./])\/[\w.-]+\/[^\s"'`)\],;<>*]*/g, '[ruta]').replace(/\b[A-Za-z]:[\\/][^\s"'`)\],;<>]*/g, '[ruta]'));
const UNIDADES = ['hours', 'days', 'points'];
const unidadDe = (x) => (UNIDADES.includes(x) ? x : null);
/** La estimación de una épica de la foto por proyecto (scripts/nightly/projects/snapshot.js), por lista blanca. */
function estimacionDe(e) {
  if (!isObject(e)) return null;
  const h = isObject(e.en_horas) ? e.en_horas : null;
  const r = isObject(e.real) ? e.real : {};
  const sumas = isObject(e.sumas_por_unidad) ? Object.fromEntries(Object.entries(e.sumas_por_unidad).filter(([u, v]) => unidadDe(u) && num(v) !== null)) : null;
  return {
    rango: isObject(e.rango) && num(e.rango.min) !== null && num(e.rango.max) !== null ? { min: e.rango.min, max: e.rango.max, unidad: unidadDe(e.rango.unidad) } : null,
    unidad: unidadDe(e.unidad),
    suma_plan: num(e.suma_plan),
    suma_vigente: num(e.suma_vigente),
    dentro: typeof e.dentro === 'boolean' ? e.dentro : null,
    fuera: e.fuera === 'encima' || e.fuera === 'debajo' ? e.fuera : null,
    por: num(e.por),
    sumas_por_unidad: sumas,
    motivo: sinDatos(texto(e.motivo, 200)),
    en_horas: h ? { min: num(h.min), max: num(h.max), plan: num(h.plan), vigente: num(h.vigente) } : null,
    real: { cerrada: r.cerrada === true, suma: num(r.suma), faltan: Number.isInteger(r.faltan) ? r.faltan : null, motivo: sinDatos(texto(r.motivo, 200)) },
  };
}
/** El estado de las estimaciones de un repo, de la foto: null si la foto es anterior a ellas (no se midió). */
function estimacionesDe(x) {
  if (!isObject(x) || !['medido', 'sin_registro', 'no_medido'].includes(x.estado)) return null;
  return { estado: x.estado, motivo: sinDatos(texto(x.motivo, 200)), ilegibles: Number.isInteger(x.ilegibles) ? x.ilegibles : 0, unidad: unidadDe(x.unidad) };
}
const enlace = (x) => (typeof x === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(x) ? x.slice(0, 400) : null);
const fechaDe = (nombre) => { const m = String(nombre).match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const diaUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const fuente = (estado, codigo, fecha, extra = {}) => ({ estado, codigo: codigo || null, motivo: null, fecha: fecha || null, ...extra });
const noMedida = (codigo, fecha = null) => fuente('no_medido', codigo, fecha);
const decodificar = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
// controles C0 y C1 y los separadores de línea U+2028/U+2029 (armados por código: escritos tal cual cortan la expresión)
const CONTROLES = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]+`, 'g');
/** Saca los caracteres de control de una línea que va al registro (saltos, escape de la consola). */
const limpiarLinea = (s) => String(s).replace(CONTROLES, ' ');

/** Un JSON: { doc } o { codigo: 'sin_foto' | 'ilegible' } — «no está» y «está roto» no son lo mismo. */
function leerJsonDe(ruta) {
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { codigo: e.code === 'ENOENT' ? 'sin_foto' : 'ilegible' }; }
  try { return { doc: JSON.parse(crudo) }; } catch { return { codigo: 'ilegible' }; }
}
const leerJson = (ruta) => leerJsonDe(ruta).doc || null;

/**
 * 🔴 Lo que se lee del clon tiene que estar ADENTRO del clon: quien escribe el repo de
 * operaciones podría dejar un enlace simbólico a un archivo del servidor —las variables del proceso, con los secretos— o
 * un `dir` con `..` en sources.json. El clon se baja con `core.symlinks=false` y, además, cada lectura resuelve la ruta
 * real y exige que quede bajo la raíz real del clon.
 */
function dentroDe(raiz, ruta) {
  try {
    const r = fs.realpathSync(raiz);
    const p = fs.realpathSync(ruta);
    return p === r || p.startsWith(r + path.sep);
  } catch { return false; }
}

/**
 * El clon de escritura de operaciones con la copia: un repo vacío con `origin` en `url`, donde
 * «Proponer» trae `main` fresco y arma su commit. Nunca es la carpeta de la foto. `{ dir }` o `{ motivo }`.
 */
function prepararClonDeEscritura({ dir, url, git = 'git' }) {
  const g = (...a) => childProcess.spawnSync(git, ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SITE_/.test(k))), GIT_TERMINAL_PROMPT: '0' } });
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      const r = g('init', '-q');
      if (r.status !== 0) return { motivo: `no se pudo armar el clon de escritura (${String(r.stderr || r.error || '').trim().slice(0, 200)})` };
    }
    const actual = g('config', '--get', 'remote.origin.url');
    const r = actual.status === 0 ? (String(actual.stdout).trim() === url ? { status: 0 } : g('remote', 'set-url', 'origin', url)) : g('remote', 'add', 'origin', url);
    if (r.status !== 0) return { motivo: `no se pudo poner el remoto del clon de escritura (${String(r.stderr || r.error || '').trim().slice(0, 200)})` };
    return { dir };
  } catch (e) { return { motivo: `no se pudo armar el clon de escritura (${e.code || e.message})` }; }
}

/** Los módulos de cloud/ (lo de cada nube): el núcleo les pide el buzón o un token sin nombrar a ninguna. */
function nubes(log = () => {}) {
  const dir = path.join(__dirname, 'cloud');
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => /^[a-z][a-z0-9-]*\.js$/.test(f)).sort(); } catch (e) { log(`no se pudo leer cloud/ (${e.code || e.message})`); return []; }
  const out = [];
  for (const f of archivos) {
    try {
      const m = require(path.join(dir, f));
      // de qué archivo salió: la bajada lo vuelve a cargar en un hilo aparte (summaries.js → bajarEnWorker)
      if (m && typeof m === 'object' && !Object.prototype.hasOwnProperty.call(m, '__archivo')) Object.defineProperty(m, '__archivo', { value: path.join(dir, f), enumerable: false });
      out.push(m);
    } catch (e) { log(`el módulo cloud/${f} no carga (${(e && e.name) || 'error'}): lo de esa nube no está disponible`); }
  }
  return out;
}

function escribirAtomico(archivo, contenido) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
}

/** La foto más nueva de una carpeta con un patrón: { fecha, doc, archivos } o { codigo }. `raiz`: lo leído queda adentro. */
function ultimaFoto(dir, patron, raiz = dir) {
  let nombres;
  try {
    const rx = new RegExp(`^${patron.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    nombres = fs.readdirSync(dir).filter((n) => rx.test(n) && fechaDe(n)).sort();
  } catch (e) { return { codigo: e.code === 'ENOENT' ? 'sin_foto' : 'ilegible' }; }
  if (!nombres.length) return { codigo: 'sin_foto' };
  const ultimo = nombres[nombres.length - 1];
  const ruta = path.join(dir, ultimo);
  if (!dentroDe(raiz, ruta)) return { codigo: 'ilegible', fecha: fechaDe(ultimo) };
  const r = leerJsonDe(ruta);
  if (!r.doc) return { codigo: 'ilegible', fecha: fechaDe(ultimo) };
  return { fecha: fechaDe(ultimo), doc: r.doc, nombres };
}

/** La foto de un día dado (para «rojo de esta noche»). */
function fotoDelDia(dir, patron, dia, raiz = dir, log = () => {}) {
  const ruta = path.join(dir, patron.replace('*', dia));
  if (!fs.existsSync(ruta)) return null;
  const r = dentroDe(raiz, ruta) ? leerJsonDe(ruta) : { codigo: 'ilegible' };
  if (!r.doc) log(`la foto de ayer (${patron.replace('*', dia)}) existe y no se pudo leer: sin ayer`);
  return r.doc || null;
}

/** Las corridas del espejo del buzón, contadas con `leerRegistro` de runs.js (las copias de una sesión, una vez). */
function leerCorridas(dirBuzon) {
  const runs = require('../nightly/dashboard/runs.js');
  const nombres = runs.nombresDePasos().nombres;
  const sinLocal = path.join(os.tmpdir(), `site-sin-registro-local-${process.pid}`);
  const r = runs.leerRegistro(sinLocal, nombres, { buzon: dirBuzon, maquina: null });
  // el motivo (que nombra la carpeta) viaja sólo para el registro: quien llama lo saca antes del modelo
  if (!r.buzon || r.buzon.estado !== 'leido') return { ...noMedida('ilegible'), _motivo: r.buzon ? String(r.buzon.motivo || r.buzon.estado) : 'sin lectura del buzón' };
  // `producto` (la carpeta del volcado, `<padre>/<repo>`) es lo que usa «dónde trabaja» para ubicar la corrida: el
  // sitio no baja los cambios de git (G3), así que no hay repo de la plataforma del cambio. `carpeta` es la carpeta real
  // del volcado: `maquina` ya viene unida a la nueva, y people.js vuelve a juzgar la unión desde la vieja
  return fuente('medido', null, null, { lista: r.corridas.map((c) => ({ maquina: texto(c.maquina, 80), carpeta: texto(c.maquina_origen, 80), inicio: texto(c.inicio, 40), producto: texto(c.producto, 200) })) });
}

/**
 * La lista de repos.json para «dónde trabaja»: sólo producto, ruta y repo de la plataforma, de las entradas
 * activas (como los productos del modelo). `{ repos, motivo }`: sin lista, el motivo dice por qué — no es «no hay repos».
 */
function leerRepos(clon) {
  const ruta = path.join(clon, 'scripts', 'nightly', 'dependencies', 'repos.json');
  if (!fs.existsSync(ruta)) {
    let enlace = false;
    try { enlace = fs.lstatSync(ruta).isSymbolicLink(); } catch { /* no está */ }
    if (!enlace) return { repos: null, motivo: 'el repo de operaciones no trae repos.json' };
  }
  if (!dentroDe(clon, ruta)) return { repos: null, motivo: 'repos.json no es un archivo del repo de operaciones' };
  const doc = leerJson(ruta);
  if (!isObject(doc) || !Array.isArray(doc.repos)) return { repos: null, motivo: 'repos.json no se pudo leer o no es JSON' };
  return { repos: doc.repos.filter((r) => isObject(r) && r.activo !== false && texto(r.producto))
    .map((r) => ({ producto: texto(r.producto), ruta: texto(r.ruta, 200) || '', ado: texto(r.ado, 200) || '' })), motivo: null };
}

const FORMA_CARPETA = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const ESTADOS_CARPETA = new Set(['unida', 'compartida', 'siguio_recibiendo']);
/** `.carpetas-de-maquina.json`, con lista blanca: nombres con forma de carpeta, estados conocidos, números, fechas. */
function carpetasProyectadas(doc) {
  if (!isObject(doc) || !isObject(doc.carpetas)) return null;
  const carpetas = {};
  for (const [k, v] of Object.entries(doc.carpetas)) {
    if (!FORMA_CARPETA.test(k) || !isObject(v) || !ESTADOS_CARPETA.has(v.estado)) continue;
    carpetas[k] = { estado: v.estado, nueva: typeof v.nueva === 'string' && FORMA_CARPETA.test(v.nueva) ? v.nueva : null, declarantes: num(v.declarantes), desde: texto(v.desde, 10) };
  }
  return { schema: 1, carpetas };
}

/** Los umbrales de sources.json, con lista blanca: el sentido y los cuatro números. Nada de texto. */
function umbralesProyectados(th) {
  const out = {};
  for (const [k, u] of Object.entries(isObject(th) ? th : {})) {
    if (!/^[a-z0-9_]{1,60}$/.test(k) || !isObject(u)) continue;
    const v = {};
    if (u.direction === 'mayor_es_mejor' || u.direction === 'menor_es_mejor') v.direction = u.direction;
    for (const n of ['ok_min', 'bad_max', 'ok_max', 'bad_min']) if (Number.isFinite(u[n])) v[n] = u[n];
    out[k] = v;
  }
  return out;
}

/** Los dos días de edad en el estado (`params.edad_en_estado_dias`), validados como el tablero; si no valen, null. */
function stateAgeDaysProjected(params) {
  const d = isObject(params) ? params.edad_en_estado_dias : undefined;
  return validAgeDays(d) ? [d[0], d[1]] : null;
}

const DIR_SEGURO = /^(\.|[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;
// como mucho dos `*`: muchos comodines encadenados dan una expresión con retroceso catastrófico sobre los nombres
const PATRON_SEGURO = /^(?!(?:[^*]*\*){3})[A-Za-z0-9._*-]{1,80}$/;

// ── El modelo (lista blanca), desde un clon del repo de operaciones ───────────────────────────────────────────────
function construirDesdeClon(clon, { ahora = Date.now(), corridas = noMedida('sin_buzon'), carpetas = null, fichas, log: logCrudo = () => {} } = {}) {
  const log = (l) => logCrudo(limpiarLinea(l));   // los nombres de archivo del repo pueden traer saltos de línea
  const t = ahora;
  const hoy = diaUtc(t);
  const dash = path.join(clon, '.dashboard');
  const delClon = (...partes) => { const r = path.join(clon, ...partes); return dentroDe(clon, r) ? r : null; };
  const jsonDelClon = (...partes) => { const r = delClon(...partes); return r ? leerJsonDe(r) : { codigo: fs.existsSync(path.join(clon, ...partes)) ? 'ilegible' : 'sin_foto' }; };

  let sourcesCfg = null;
  const sc = jsonDelClon('scripts', 'nightly', 'dashboard', 'sources.json');
  if (sc.doc) sourcesCfg = sc.doc;
  else {
    if (sc.codigo === 'ilegible') log('el sources.json del repo de operaciones no se pudo leer: se usa el del arnés');
    sourcesCfg = leerJson(SOURCES_DEL_ARNES);
    if (!sourcesCfg) { log('tampoco se pudo leer el sources.json del arnés: sin antigüedades declaradas'); sourcesCfg = { sources: [], thresholds: {} }; }
  }
  // un `dir` o un patrón que no tienen forma de carpeta y nombre de archivo del tablero no se leen (nunca salen del clon)
  const lista = (Array.isArray(sourcesCfg.sources) ? sourcesCfg.sources : []).filter((s) => isObject(s) && !s.local && typeof s.dir === 'string' && typeof s.pattern === 'string' && DIR_SEGURO.test(s.dir) && PATRON_SEGURO.test(s.pattern) && !s.dir.split('/').includes('..'));
  const edadMax = (dir, patron) => { const s = lista.find((x) => x.dir === dir && x.pattern === patron); return s && Number.isFinite(s.max_age_days) ? s.max_age_days : EDAD_MAXIMA_SIN_DECLARAR; };
  const edad = (fecha) => Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${fecha}T00:00:00Z`)) / DIA);

  /** Una foto con su frescura: { ok, doc, fecha } o la fuente «no medido». */
  function foto(dir, patron, { sinCarpeta } = {}) {
    const abs = path.join(dash, dir === '.' ? '' : dir);
    if (!DIR_SEGURO.test(dir) || dir.split('/').includes('..')) { log(`la carpeta de fotos «${dir}» no tiene forma de carpeta del tablero: no se lee`); return { fuente: noMedida('ilegible') }; }
    if (sinCarpeta && !fs.existsSync(abs)) return { fuente: noMedida(sinCarpeta) };
    if (fs.existsSync(abs) && !dentroDe(clon, abs)) { log(`la carpeta de fotos «${dir}» queda fuera del clon (un enlace): no se lee`); return { fuente: noMedida('ilegible') }; }
    const f = ultimaFoto(abs, patron, clon);
    if (!f.doc) {
      // una foto que está y no se puede leer se nombra en el registro, en un solo lugar para todas las fuentes
      if (f.codigo === 'ilegible') log(`la foto ${dir}/${patron}${f.fecha ? ` del ${f.fecha}` : ''} no se pudo leer`);
      return { fuente: noMedida(f.codigo, f.fecha) };
    }
    if (edad(f.fecha) > edadMax(dir, patron)) return { fuente: noMedida('fuente_vieja', f.fecha), vieja: true };
    return { ok: true, doc: f.doc, fecha: f.fecha, abs };
  }
  const largo = (r) => (isObject(r) && r.motivo == null && Array.isArray(r.valor) ? r.valor.length : (isObject(r) && r.motivo == null && Number.isFinite(r.valor) ? r.valor : null));
  const ayerDe = (fecha) => diaUtc(Date.parse(`${fecha}T00:00:00Z`) - DIA);

  const m = { generado: t };

  // dependencias. 🔴 Un rubro sin medir (valor null con motivo, o ausente) es null, nunca un objeto vacío: «0 vivas» no.
  const dep = foto('dependencias', 'dependencias-*.json');
  if (dep.ok) {
    const rub = isObject(dep.doc.resumen) && isObject(dep.doc.resumen.rubros) ? dep.doc.resumen.rubros : {};
    let vivas = null;
    const vp = rub.vivas_por_proyecto;
    if (isObject(vp) && vp.motivo == null && Array.isArray(vp.valor)) {
      vivas = {};
      for (const x of vp.valor) if (isObject(x) && texto(x.proyecto)) vivas[decodificar(texto(x.proyecto))] = Array.isArray(x.ids) ? x.ids.length : 0;
    }
    m.dependencias = fuente('medido', null, dep.fecha, {
      rubros: { nuevos: largo(rub.nuevos), aceptadas_sin_resolver: largo(rub.aceptadas_sin_resolver), rechazadas_sin_deuda: largo(rub.rechazadas_sin_deuda), pedidos_cerrados_con_vivas: largo(rub.pedidos_cerrados_con_vivas) },
      vivas_por_proyecto: vivas,
    });
  } else m.dependencias = dep.fuente;

  // vigilante
  const vig = foto('vigilante', 'vigilante-*.json');
  if (vig.ok) {
    const rub = isObject(vig.doc.resumen) && isObject(vig.doc.resumen.rubros) ? vig.doc.resumen.rubros : {};
    m.vigilante = fuente('medido', null, vig.fecha, { pendientes: largo(rub.pendientes), aceptadas_sin_story: largo(rub.aceptadas_sin_story), productos: isObject(vig.doc.productos) ? Object.keys(vig.doc.productos).map((k) => texto(k, 60)).filter(Boolean) : [] });
  } else m.vigilante = vig.fuente;

  // lo que hay que decidir, ficha por ficha, con el pedido que anota cada una (decisions.js): sin ninguna de las dos
  // fotos, no medido
  m.decisiones = dep.ok || vig.ok
    ? fuente('medido', null, [dep.ok && dep.fecha, vig.ok && vig.fecha].filter(Boolean).sort().pop(), {
      items: require('./decisions.js').itemsDeLasColas({ clon, fotos: { dependencias: dep.ok ? dep.doc : null, vigilante: vig.ok ? vig.doc : null }, dentroDe }) })
    : noMedida('sin_foto');

  // banco, suites y examen (el nocturno del tablero de una organización que corre el banco los guarda acá)
  const rojosDelBanco = (doc) => (isObject(doc) && isObject(doc.results) ? Object.entries(doc.results).filter(([, r]) => isObject(r) && isObject(r.tools) && Object.values(r.tools).some((x) => isObject(x) && x.pass === false)).map(([id]) => texto(id, 160)).filter(Boolean) : null);
  const banco = foto('controls-bench', 'banco-*.json', { sinCarpeta: 'no_corre_banco' });
  if (banco.ok) {
    const ayer = fotoDelDia(banco.abs, 'banco-*.json', ayerDe(banco.fecha), clon, log);
    const rojos = rojosDelBanco(banco.doc);
    // 🔴 una foto sin `results` no es «0 rojos»: es una foto que no se pudo leer
    if (rojos === null) { m.banco = noMedida('ilegible', banco.fecha); log(`la foto del banco del ${banco.fecha} no trae results`); }
    else m.banco = fuente('medido', null, banco.fecha, { rojos, total: num(banco.doc.ran), ayer: ayer && rojosDelBanco(ayer) ? { fecha: ayerDe(banco.fecha), rojos: rojosDelBanco(ayer) } : null });
  } else m.banco = banco.fuente;
  const suites = foto('controls-bench', 'suites-*.json', { sinCarpeta: 'no_corre_banco' });
  // 🔴 suites-report.js deja en `failures` también las suites NO medidas, con la marca «(no-medida)»: no son rojas
  const NO_MEDIDA = /\(no-medida\)$/;
  const nombresSuites = (doc) => (Array.isArray(doc && doc.failures) ? doc.failures.map((x) => texto(x, 160)).filter((x) => x && !NO_MEDIDA.test(x)) : null);
  if (suites.ok && nombresSuites(suites.doc) === null) { m.suites = noMedida('ilegible', suites.fecha); log(`la foto de las suites del ${suites.fecha} no trae failures`); }
  else if (suites.ok) {
    const ayer = fotoDelDia(suites.abs, 'suites-*.json', ayerDe(suites.fecha), clon, log);
    m.suites = fuente('medido', null, suites.fecha, {
      rojas: nombresSuites(suites.doc) || [], sin_medir: Array.isArray(suites.doc.unmeasured) ? suites.doc.unmeasured.length : 0,
      total: num(suites.doc.corridas) ?? (Array.isArray(suites.doc.ran) ? suites.doc.ran.length : null),
      ayer: ayer && nombresSuites(ayer) ? { fecha: ayerDe(suites.fecha), rojas: nombresSuites(ayer) } : null,
    });
  } else m.suites = suites.fuente;
  const examen = foto('controls-bench', 'examen-*.json', { sinCarpeta: 'no_corre_banco' });
  m.examen = examen.ok ? fuente('medido', null, examen.fecha, { fallos: num(examen.doc.failed), completo: examen.doc.estado === 'completo' }) : examen.fuente;

  // datos declarados
  const decl = jsonDelClon('scripts', 'nightly', 'dashboard', 'declared.json');
  if (decl.doc && Array.isArray(decl.doc.declared)) m.declarados = fuente('medido', null, hoy, { lista: decl.doc.declared.filter(isObject).map((d) => ({ id: texto(d.id, 80), review_before: texto(d.review_before, 10) })) });
  else { m.declarados = noMedida(decl.doc ? 'ilegible' : decl.codigo); if (m.declarados.codigo === 'ilegible') log('declared.json del repo de operaciones no se pudo leer'); }

  // productos (repos.json). 🔴 El cruce es por el NOMBRE DEL PROYECTO, decodificado: repos.json lista los repos de código con
  // el proyecto codificado («Proyecto%20Uno/Front»), las fotos por proyecto son de los repos de stories, y las
  // vulnerabilidades vienen por proyecto decodificado. Una entrada de GitHub (`github: <dueño>/<repo>`) es su propio proyecto.
  const repos = jsonDelClon('scripts', 'nightly', 'dependencies', 'repos.json');
  const porProducto = new Map();
  for (const r of (repos.doc && Array.isArray(repos.doc.repos) ? repos.doc.repos : [])) {
    if (!isObject(r) || r.activo === false || !texto(r.producto)) continue;
    let proyecto = null;
    if (texto(r.ado) && texto(r.ado).includes('/')) proyecto = decodificar(texto(r.ado, 200).split('/')[0]);
    else if (texto(r.github)) proyecto = texto(r.github, 200);
    if (!proyecto) continue;
    if (!porProducto.has(texto(r.producto))) porProducto.set(texto(r.producto), { proyectos: new Set(), rutas: new Set() });
    porProducto.get(texto(r.producto)).proyectos.add(proyecto);
    if (texto(r.ruta)) porProducto.get(texto(r.producto)).rutas.add(texto(r.ruta, 200));
  }
  m.productos = [...porProducto].map(([producto, s]) => ({ producto, proyectos: [...s.proyectos], rutas: [...s.rutas] }));
  if (repos.doc && Array.isArray(repos.doc.repos)) m.productosFuente = fuente('medido', null, hoy);
  else { m.productosFuente = noMedida(repos.doc ? 'ilegible' : repos.codigo); log(`repos.json del repo de operaciones: ${m.productosFuente.codigo}`); }

  // fotos por proyecto: cada una con su antigüedad (2 días); una vieja no cuenta como al día, una ilegible se nombra
  const dirProy = path.join(dash, 'proyectos');
  const proyectos = [];
  let fechaProy = null;
  let ilegibles = 0;
  try {
    for (const n of fs.readdirSync(dirProy).filter((x) => x.endsWith('.json')).sort()) {
      const ruta = path.join(dirProy, n);
      const r = dentroDe(clon, ruta) ? leerJsonDe(ruta) : { codigo: 'ilegible' };
      const d = r.doc;
      if (!isObject(d) || !texto(d.proyecto) || !texto(d.repo)) { ilegibles += 1; log(`la foto por proyecto ${n} no se pudo leer o no tiene proyecto y repo`); continue; }
      const fecha = texto(d.generated_at, 10);
      const vieja = !fecha || edad(fecha) > EDAD_MAXIMA_SIN_DECLARAR;
      if (fecha && !vieja && (!fechaProy || fecha > fechaProy)) fechaProy = fecha;
      proyectos.push({ proyecto: decodificar(texto(d.proyecto)), repo: texto(d.repo), fecha, vieja, stories: (Array.isArray(d.stories) ? d.stories : []).filter(isObject).map((s) => ({ grupo: texto(s.grupo, 30), canonico: texto(s.canonico, 30), dias_en_estado: num(s.dias_en_estado) })),
        epicas: (Array.isArray(d.epicas) ? d.epicas : []).filter(isObject).map((e) => ({ id: texto(String(e.id == null ? '' : e.id), 40), titulo: sinDatos(texto(e.titulo, 120)), estimacion: estimacionDe(e.estimacion) })),
        estimaciones: isObject(d.cobertura) ? estimacionesDe(d.cobertura.estimaciones) : null });
    }
    if (!proyectos.length) m.proyectos = noMedida(ilegibles ? 'ilegible' : 'sin_foto');
    // hay_al_dia: si el nocturno de métricas dejó alguna foto al día; viaja aparte porque la vista de una persona recorta
    // la lista a sus productos y sin esto no podría decir «sus repos no usan stories del arnés»
    else m.proyectos = fuente('medido', ilegibles ? 'parcial' : null, fechaProy, { lista: proyectos, ilegibles, hay_al_dia: proyectos.some((x) => !x.vieja) });
  } catch (e) {
    m.proyectos = noMedida(e.code === 'ENOENT' ? 'sin_foto' : 'ilegible');
    if (e.code !== 'ENOENT') log(`la carpeta de fotos por proyecto no se pudo leer (${e.code || e.message})`);
  }

  // despliegues: de cada producto, estados y fechas; el motivo sólo si es un código (nunca una frase)
  const desp = foto('deployments', 'deployments-*.json');
  if (desp.ok) {
    const productos = {};
    for (const [k, p] of Object.entries(isObject(desp.doc.productos) ? desp.doc.productos : {})) {
      if (!isObject(p)) continue;
      const lado = (x) => (isObject(x) ? { fecha: texto(x.fecha, 30) } : null);
      const apr = p.aprobacion;
      productos[texto(k, 120)] = {
        estado: ['medido', 'parcial', 'no_medido'].includes(p.estado) ? p.estado : 'no_medido', motivo: codigoDe(p.motivo),
        staging: lado(p.staging), produccion: lado(p.produccion), produccion_atrasada: typeof p.produccion_atrasada === 'boolean' ? p.produccion_atrasada : null,
        aprobacion: typeof apr === 'string' ? { estado: codigoDe(apr) } : (isObject(apr) ? { estado: codigoDe(apr.estado) } : null),
        main: codigoDe(p.main),
      };
    }
    m.despliegues = fuente('medido', null, desp.fecha, { productos });
  } else m.despliegues = desp.fuente;

  // lo que deja la noche para el sitio: pull requests y pedidos asignados
  const prs = foto('open-prs', 'open-prs-*.json');
  if (prs.ok && prs.doc.estado === 'medido' && Array.isArray(prs.doc.prs)) {
    m.prs = fuente('medido', null, prs.fecha, { lista: prs.doc.prs.filter(isObject).map((p) => ({ numero: num(p.numero), proyecto: texto(p.proyecto), repo: texto(p.repo), dias: num(p.dias), autor: texto(p.autor, 200), enlace: enlace(p.enlace) })) });
  } else if (prs.ok && prs.doc.estado === 'medido') { m.prs = noMedida('ilegible', prs.fecha); log(`la foto de PR del ${prs.fecha} dice medido y no trae la lista`); }
  else m.prs = prs.ok ? noMedida('no_medido_noche', prs.fecha) : prs.fuente;
  const asig = foto('assigned', 'assigned-*.json');
  if (asig.ok && asig.doc.estado === 'medido' && Array.isArray(asig.doc.pedidos)) {
    m.pedidos = fuente('medido', null, asig.fecha, { lista: asig.doc.pedidos.filter(isObject).map((p) => ({ id: num(p.id), proyecto: texto(p.proyecto), tipo: texto(p.tipo, 40), estado: texto(p.estado, 40), asignado: texto(p.asignado, 200), dias: num(p.dias_en_estado), enlace: enlace(p.enlace), dependencias: p.dependencias === true, titulo: texto(p.titulo, 120) })),
      // de los proyectos que la noche no pudo medir, sólo el nombre: el motivo trae texto de la plataforma
      sin_medir: (Array.isArray(asig.doc.proyectos_no_medidos) ? asig.doc.proyectos_no_medidos : []).filter(isObject).map((x) => texto(x.proyecto)).filter(Boolean).map(decodificar) });
  } else if (asig.ok && asig.doc.estado === 'medido') { m.pedidos = noMedida('ilegible', asig.fecha); log(`la foto de pedidos asignados del ${asig.fecha} dice medido y no trae la lista`); }
  else m.pedidos = asig.ok ? noMedida('no_medido_noche', asig.fecha) : asig.fuente;
  // las retrospectivas pendientes: la foto de HOY, sólo la cuenta por repo. Sin ella, el Inicio dice lo de siempre
  const ret = foto('retros', 'retros-*.json');
  if (ret.ok && ret.fecha === hoy && ret.doc.estado === 'medido' && Array.isArray(ret.doc.pendientes)) {
    m.retros = fuente('medido', null, ret.fecha, { pendientes: ret.doc.pendientes.filter(isObject).map((x) => ({ repo: texto(x.repo, 200), dias: num(x.dias) })) });
  } else if (ret.ok && ret.doc.estado === 'medido' && !Array.isArray(ret.doc.pendientes)) { m.retros = noMedida('ilegible', ret.fecha); log(`la foto de retrospectivas del ${ret.fecha} dice medido y no trae la lista`); }
  else m.retros = ret.ok ? noMedida('no_medido_noche', ret.fecha) : ret.fuente;

  // la paridad de los productos: el archivo de HOY, y de él sólo las cantidades por repo de `por_ruta`.
  // `divergencias[]` —el texto del rasgo y qué productos lo tienen— no entra al modelo.
  const MOTIVOS_PARIDAD = new Set(['sin_clon', 'ilegible', 'grupo_sin_comparar', 'declaracion_incompleta']);
  const par = fs.existsSync(path.join(dash, 'paridad')) && !dentroDe(clon, path.join(dash, 'paridad')) ? { codigo: 'ilegible' } : ultimaFoto(path.join(dash, 'paridad'), 'paridad-*.json', clon);
  if (!par.doc && par.codigo === 'ilegible') { m.paridad = noMedida('ilegible', par.fecha || null); log('la foto de la paridad no se pudo leer'); }
  else if (!par.doc || par.fecha !== hoy) m.paridad = noMedida('sin_paridad', par.fecha || null);
  else if (par.doc.estado === 'sin_productos') m.paridad = noMedida('sin_productos', par.fecha);
  else if (!['medido', 'parcial'].includes(par.doc.estado)) m.paridad = noMedida('paridad_no_medida', par.fecha);
  else {
    m.paridad = fuente('medido', null, par.fecha, { por_ruta: (Array.isArray(par.doc.por_ruta) ? par.doc.por_ruta : []).filter(isObject).map((x) => ({
      ruta: texto(x.ruta, 200), estado: ['medido', 'desde_disco', 'no_medido'].includes(x.estado) ? x.estado : 'no_medido',
      motivo: MOTIVOS_PARIDAD.has(x.motivo) ? x.motivo : null, divergencias: num(x.divergencias), vencidas: num(x.vencidas),
    })).filter((x) => x.ruta) });
  }

  // el sello de la página de las seis preguntas: dice si el nocturno corrió. La página no se guarda: el sitio no la sirve
  let html = null;
  const rutaTablero = delClon('artifacts', 'tablero-del-arnes.html');
  if (rutaTablero) { try { if (fs.lstatSync(rutaTablero).isFile()) html = fs.readFileSync(rutaTablero, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log(`la página de las seis preguntas no se pudo leer (${e.code || e.message})`); } }
  if (html === null) m.tablero = noMedida(fs.existsSync(path.join(clon, 'artifacts', 'tablero-del-arnes.html')) ? 'ilegible' : 'sin_foto');
  else {
    const seal = require('../nightly/dashboard/seal.js');
    const s = seal.leer(html);
    // «completa» con la regla del aviso de la mañana: el sello no trae el campo, lo dicen sus partes
    m.tablero = fuente('medido', null, s.sello ? texto(s.sello.generado, 10) : null, { sello: s.sello ? { generado: texto(s.sello.generado, 30), completo: seal.completo(s.sello) } : null });
  }

  // cada fuente de sources.json, al día o no (la misma lectura de antigüedad que el tablero)
  m.sources = { lista: lista.filter((s) => !s.dir.startsWith('~')).map((s) => {
    const f = foto(s.dir, s.pattern);
    return f.ok ? { id: texto(s.id, 60), estado: 'medido', codigo: null, fecha: f.fecha } : { id: texto(s.id, 60), ...f.fuente };
  }) };
  m.umbrales = umbralesProyectados(sourcesCfg.thresholds);
  m.stateAgeDays = stateAgeDaysProjected(sourcesCfg.params);
  m.corridas = corridas;
  m.carpetas = carpetasProyectadas(carpetas);
  // las fichas del tablero nocturno, ya calculadas aparte (refrescarUnaVez → calcularFichas). `null` = todavía no
  // se calcularon; sin la clave (las pruebas que no las piden) el modelo no las trae.
  if (fichas !== undefined) m.fichas = fichas;
  return m;
}

/**
 * El estado de una salida de git, de la lista cerrada: la credencial rechazada, sin permiso sobre el repo (o el repo no
 * existe: los dos se ven igual desde afuera), o sin red.
 */
function estadoDeGit(stderr) {
  const s = String(stderr || '');
  if (/\b(401)\b|Authentication failed|could not read Username|terminal prompts disabled|invalid credentials/i.test(s)) return 'credencial_rechazada';
  if (/\b(403)\b|TF401019|repository .* not found|Repository not found|does not exist or you do not have permissions|Access denied|Permission denied/i.test(s)) return 'sin_permiso';
  if (/Remote branch main not found|couldn't find remote ref main|Could not find remote branch main/i.test(s)) return 'sin_rama';
  // «unable to access» solo no alcanza: git lo dice también ante un 404, un 429 o un certificado
  if (/Could not resolve host|Connection refused|Connection timed out|timed out|Failed to connect|Network is unreachable|\b50[0-9]\b|ETIMEDOUT|ECONNRESET/i.test(s)) return 'sin_red';
  // lo que no se reconoce (git ausente, disco lleno…) no se disfraza de «sin red»: el motivo crudo queda en el registro
  return 'falla_git';
}

/** Saca los caracteres de control de una línea que va al registro (saltos, escape de la consola). */
function crearFuentes({ cfg, dataDir, dirClones = null, log: logCrudo = () => {}, ahora = Date.now, spawn = correr, urlBuzon, git = 'git', nubes: nubesDadas, presupuestoBuzonMs = 120000,
  topeConversacionesBytes = TOPE_CONVERSACIONES_BYTES, topeConversacionBytes = TOPE_CONVERSACION_BYTES, resumir = (o) => require('./summaries.js').resumirEnWorker({ ...o, skillsDir: process.env.TYCON_SKILLS_DIR || null }),
  leerEspejo = (o) => require('./summaries.js').leerEspejoEnWorker(o), calcularFichasEn = (o) => require('./summaries.js').fichasEnWorker(o), almacenCopia = null, urlCopia = null, opcionesPodaCopia = {} }) {
  // 🔴 todo lo que este módulo registra puede traer texto del repo de operaciones o del buzón (valores de operations.json,
  //    stderr de git, nombres de archivo): sale sin caracteres de control
  const log = (l) => logCrudo(limpiarLinea(l));
  if (!dataDir) throw new Error('crearFuentes necesita SITE_DATA_DIR o una carpeta temporal');
  // los clones, en el disco del contenedor y nunca en SITE_DATA_DIR: git hace chmod al clonar, y un disco montado por
  // SMB lo rechaza y deja el sitio frenado. Son copias que se vuelven a armar: no necesitan persistir
  const raizClones = dirClones || fs.mkdtempSync(path.join(os.tmpdir(), 'site-clones-'));
  // con la copia no hay clon: `clon` es la carpeta de la última foto abierta, en el disco del contenedor como los
  // clones. En SITE_DATA_DIR (un disco compartido en la nube) escribir sus ~1.200 archivos llevaba casi un minuto en
  // cada arranque en frío; acá, segundos, y bajar la foto es un solo archivo. Cambia de una vez cuando llega una nueva
  const conCopia = cfg.operationsSource === 'copy';
  let clon = path.join(raizClones, 'operaciones');
  const dirCopias = path.join(raizClones, 'operaciones-copia');
  // las copias que versiones anteriores dejaron en SITE_DATA_DIR: se borran de fondo, ninguna se conserva
  const dirCopiasViejas = path.join(dataDir, 'operaciones-copia');
  const dirBuzon = path.join(dataDir, 'buzon');
  const dirPerfil = path.join(raizClones, 'perfil');
  // el candado de los clones: una cola de promesas; un trabajo que falla no traba a los siguientes
  let cola = Promise.resolve();
  const exclusivo = (fn) => { const p = cola.then(() => fn()); cola = p.catch(() => {}); return p; };
  const rutaEstado = path.join(dataDir, ARCHIVO_ESTADO);
  // `personas`: lo que la regla de quién es quién necesita y el modelo NO lleva — lo informado por cada máquina
  // (de la última bajada entera del buzón) y la lista de repos.json
  const st = { perfil: cfg.profileRepo ? { estado: 'pendiente', motivo: 'el perfil del equipo todavía se está bajando' } : { estado: 'sin_configurar', motivo: 'no configurado: faltan SITE_PROFILE_REPO y SITE_PROFILE_TOKEN' }, cargado: false, ultimoBueno: null, fallaDesde: null, fallaMotivo: null, fallaRutas: null, frenado: null, bandaConfig: null, modelo: null, personas: { informados: null, repos: null }, fallas: { repo: null, buzon: null }, hilos: false, buzon: { completo: false, armable: false, generacion: 0, seguir: false, pendientes: 0 }, copia: null, copiaHora: null };
  // quien quiere saber que el refresco terminó (la pestaña Corridas rearma su vista si el espejo cambió)
  const oyentes = [];
  let temporizador = null;
  let enCurso = null;
  const lasNubes = () => (Array.isArray(nubesDadas) ? nubesDadas : nubes(log));

  const guardado = leerJsonDe(rutaEstado);
  if (guardado.doc && isObject(guardado.doc)) {
    const g = guardado.doc;
    const r = g.ultimoBueno ? OPS.parse(JSON.stringify(g.ultimoBueno)) : null;
    if (r && r.ok) st.ultimoBueno = r.data;
    else if (g.ultimoBueno) log('el último bueno guardado en SITE_DATA_DIR ya no valida: se descarta');
    if (Number.isFinite(g.fallaDesde)) { st.fallaDesde = g.fallaDesde; st.fallaMotivo = texto(g.fallaMotivo, 2000); st.fallaRutas = texto(g.fallaRutas, 500); }
    if (conCopia && Number.isFinite(g.copiaHora)) st.copiaHora = g.copiaHora;
  } else if (guardado.codigo !== 'sin_foto') log('el estado de la configuración guardado en SITE_DATA_DIR no se pudo leer: se arranca sin último bueno');

  function guardarEstado() {
    try { escribirAtomico(rutaEstado, `${JSON.stringify({ ultimoBueno: st.ultimoBueno, fallaDesde: st.fallaDesde, fallaMotivo: st.fallaMotivo, fallaRutas: st.fallaRutas, ...(conCopia ? { copiaHora: st.copiaHora } : {}) })}\n`); }
    catch (e) { log(`no se pudo guardar el estado de la configuración en SITE_DATA_DIR (${e.code || e.message})`); }
  }

  // ── El repo de operaciones ─────────────────────────────────────────────────────────────────────────────────────
  async function cabecera() {
    if (cfg.operationsCredencial && cfg.operationsCredencial.token) return { valor: `Basic ${Buffer.from(`x-access-token:${cfg.operationsCredencial.token}`).toString('base64')}` };
    if (cfg.operationsCredencial && cfg.operationsCredencial.managed) {
      const nube = lasNubes().find((n) => typeof n.tokenParaRepo === 'function');
      if (!nube) return { estado: 'sin_configurar', motivo: 'ninguna nube de cloud/ da una identidad administrada para el repo de operaciones' };
      const t = await nube.tokenParaRepo();
      return t.token ? { valor: `Bearer ${t.token}` } : { estado: t.estado, motivo: t.motivo };
    }
    return { estado: 'sin_configurar', motivo: 'sin credencial del repo de operaciones' };
  }

  // 🔴 Asíncrono: un clon puede tardar minutos, y una llamada bloqueante frenaría todos los pedidos del sitio mientras.
  // `core.symlinks=false`: un enlace simbólico del repo se baja como un archivo con la ruta adentro, nunca como enlace.
  function correrGit(args, cab, cwd, url = cfg.operationsRepo) {
    let origen = null;
    try { origen = new URL(url).origin; } catch { /* una ruta local (las pruebas): sin cabecera */ }
    const conf = [['core.symlinks', 'false'], ['credential.helper', '']];
    if (origen && cab) conf.push([`http.${origen}/.extraheader`, `Authorization: ${cab}`]);
    // las variables del sitio (sus credenciales) no viajan al proceso git: no las necesita
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SITE_/.test(k))), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(conf.length) };
    conf.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return spawn(git, args, { cwd, env, timeout: 180000 });
  }

  /** Baja o pone al día un clon superficial de `main` (`url` en `dir`), con la cabecera `cab`. `nombre`: para el registro. */
  async function actualizarClon({ url, dir, cab, nombre }) {
    let hayClon = fs.existsSync(path.join(dir, '.git'));
    if (hayClon) {
      // 🔴 el clon de un disco persistente puede ser de OTRO repo (cambió la variable): se vuelve a clonar
      const r = await correrGit(['-C', dir, 'config', '--get', 'remote.origin.url'], null, undefined, url);
      if (r.status !== 0 || String(r.stdout || '').trim() !== url) { log(`el clon guardado es de otro ${nombre}: se vuelve a clonar`); hayClon = false; }
    }
    const pasos = hayClon
      ? [['-C', dir, 'fetch', '--depth', '1', '--no-tags', 'origin', 'main'], ['-C', dir, 'reset', '--hard', '-q', 'FETCH_HEAD']]
      : [['clone', '-q', '--depth', '1', '--branch', 'main', '--single-branch', '--no-tags', url, dir]];
    if (!hayClon) fs.rmSync(dir, { recursive: true, force: true });
    for (const args of pasos) {
      const r = await correrGit(args, cab, undefined, url);
      if (r.error || r.status !== 0) {
        const err = String((r.stderr || '') + (r.error ? ` ${r.error.code || r.error.message}` : '')).split(cab).join('[credencial]').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' · ');
        return { estado: estadoDeGit(err), motivo: `git ${args.find((a) => a === 'fetch' || a === 'clone' || a === 'reset')} del ${nombre} falló: ${err.slice(0, 300)}` };
      }
    }
    return { ok: true };
  }

  // la copia de operaciones: el índice en cada refresco; la foto sólo si cambió el commit o su huella
  let almacen = almacenCopia;
  async function actualizarCopia() {
    if (!almacen) {
      const nube = lasNubes().find((n) => typeof n.almacenDeCopia === 'function');
      if (!nube) return { estado: 'sin_configurar', motivo: 'ningún módulo de cloud/ sabe leer la copia de operaciones' };
      try { almacen = nube.almacenDeCopia({ ...cfg.operationsCopy, urlBase: urlCopia }); }
      catch (e) { return { estado: 'sin_configurar', motivo: `la copia de operaciones no está configurada (${e.message})` }; }
    }
    const r = await COPIA.bajar({ almacen, dir: dirCopias, previo: st.copia ? { commit: st.copia.indice.commit, huella: st.copia.indice.huella, carpeta: st.copia.carpeta } : null, log, opcionesPoda: opcionesPodaCopia });
    if (!r.ok) return { estado: r.codigo, motivo: `copia de operaciones: ${r.motivo}` };
    // vacía, la carpeta se borra: un refresco no vuelve a listar el disco compartido para nada
    if (fs.existsSync(dirCopiasViejas)) COPIA.programarPoda({ dir: dirCopiasViejas, actual: null, conservar: 0, log, ...opcionesPodaCopia }).then(() => fs.promises.rmdir(dirCopiasViejas)).catch(() => { /* con algo adentro todavía: la próxima */ });
    st.copia = { carpeta: r.carpeta, indice: r.indice };
    const hora = Date.parse(r.indice.hora);
    if (Number.isFinite(hora) && hora !== st.copiaHora) { st.copiaHora = hora; guardarEstado(); }
    clon = r.carpeta;
    return { ok: true };
  }
  /** ¿Hay algo de operaciones para leer? El clon con su .git, o una foto abierta. */
  const hayLectura = () => (conCopia ? Boolean(st.copia) && fs.existsSync(clon) : fs.existsSync(path.join(clon, '.git')));

  async function actualizarRepo() {
    if (conCopia) return actualizarCopia();
    const cab = await cabecera();
    if (!cab.valor) return { estado: cab.estado || 'sin_configurar', motivo: cab.motivo };
    return actualizarClon({ url: cfg.operationsRepo, dir: clon, cab: cab.valor, nombre: 'repo de operaciones' });
  }

  // el perfil del equipo: sólo con SITE_PROFILE_REPO y su credencial; nunca frena el refresco
  async function actualizarPerfil() {
    if (!cfg.profileRepo || !cfg.profileCredencial || !cfg.profileCredencial.token) { st.perfil = { estado: 'sin_configurar', motivo: 'no configurado: faltan SITE_PROFILE_REPO y SITE_PROFILE_TOKEN' }; return; }
    const cab = `Basic ${Buffer.from(`x-access-token:${cfg.profileCredencial.token}`).toString('base64')}`;
    const r = await actualizarClon({ url: cfg.profileRepo, dir: dirPerfil, cab, nombre: 'perfil del equipo' });
    // el registro dice cada cambio: bajado la primera vez y cuando vuelve, y cada falla con su motivo (sin la credencial)
    if (r.ok) { if (st.perfil.estado !== 'medido') log('perfil del equipo: bajado'); st.perfil = { estado: 'medido', motivo: null }; }
    else { log(r.motivo); st.perfil = { estado: r.estado, motivo: `el perfil del equipo no se pudo leer (${r.estado})` }; }
  }

  // ── operations.json ────────────────────────────────────────────────────────────────────────────────────────────
  // La banda de quienes mantienen trae las RUTAS de los problemas; el texto entero —que puede repetir un valor del
  // archivo, como un correo— va sólo al registro.
  /**
   * La falla que cuenta para la banda y el freno: la de operations.json y, con la copia, su edad. Una copia
   * de más de 24 horas cuenta como una falla desde sus 24 horas: la banda enseguida y el freno a las 48, con la misma
   * cuenta de `estadoDeLaConfiguracion`.
   */
  function fallaEfectiva(t) {
    let fallaDesde = st.fallaDesde;
    let fallaRutas = st.fallaRutas;
    // la hora de la última copia abierta, guardada en SITE_DATA_DIR: un reinicio no le da a una copia vieja un plazo nuevo
    const hora = st.copiaHora;
    if (conCopia && Number.isFinite(hora) && Number.isFinite(t) && t - hora > PLAZO_COPIA_MS) {
      // +1 ms: la cuenta compartida frena con «24 h o más» desde la falla, y la copia se frena con MÁS de 48 h
      const desde = hora + PLAZO_COPIA_MS + 1;
      if (fallaDesde === null || desde < fallaDesde) fallaDesde = desde;
      const edad = `la copia de operaciones tiene ${Math.floor((t - hora) / 3600000)} horas`;
      fallaRutas = fallaRutas ? `${fallaRutas} · ${edad}` : edad;
    }
    return { fallaDesde, fallaRutas };
  }
  const recontar = (t) => Object.assign(st, estadoDelSitio({ hayUltimoBueno: Boolean(st.ultimoBueno), ...fallaEfectiva(t), ahora: t }));

  function aplicarConfig(r, t) {
    if (r.ok) {
      if (st.fallaDesde !== null) log('operations.json vuelve a validar: se saca la banda y el freno');
      // cuándo entra en vigor un cambio de la lista de quién entra (la cuenta, alta, baja o cambio de rol): el pedido que
      // lo propuso dice quién y quién lo aprobó; esto dice desde cuándo vale en el sitio
      if (st.ultimoBueno) {
        const cambios = people.textoDeCambios(people.cambiosDeAcceso(st.ultimoBueno, r.data));
        if (cambios) log(`la lista de quién entra cambió y vale desde ahora: ${cambios}`);
      }
      st.ultimoBueno = r.data; st.fallaDesde = null; st.fallaMotivo = null; st.fallaRutas = null;
    } else {
      if (st.fallaDesde === null) st.fallaDesde = t;
      st.fallaMotivo = r.motivo;
      st.fallaRutas = r.rutas || r.motivo;
      log(`operations.json no se pudo releer o no valida (desde ${new Date(st.fallaDesde).toISOString()}): ${r.motivo}`);
    }
    guardarEstado();
    recontar(t);
    if (st.frenado) log(`el sitio está FRENADO desde ${new Date(st.frenado.desde).toISOString()}: ${st.fallaMotivo || 'sin último bueno'}`);
  }

  function leerOperaciones() {
    const archivo = path.join(clon, 'operations.json');
    if (!fs.existsSync(archivo)) return { ok: false, motivo: 'el repo de operaciones no trae operations.json', rutas: 'falta operations.json' };
    if (!dentroDe(clon, archivo)) return { ok: false, motivo: 'operations.json no es un archivo del repo de operaciones', rutas: 'operations.json ilegible' };
    const r = OPS.load(archivo);
    if (r.couldNotRead) return { ok: false, motivo: 'operations.json no se pudo leer', rutas: 'operations.json ilegible' };
    if (!r.ok) {
      return {
        ok: false,
        motivo: r.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join(' · ').slice(0, 2000),
        rutas: `problemas en ${[...new Set(r.problems.map((p) => p.path || '(el archivo)'))].join(', ')}`.slice(0, 500),
      };
    }
    return { ok: true, data: r.data };
  }

  // ── El buzón ───────────────────────────────────────────────────────────────────────────────────────────────────
  const ESTADO_BUZON = { llave_con_escritura: 'credencial_rechazada', sin_permiso: 'credencial_rechazada', sin_permiso_a_mitad: 'credencial_rechazada', credencial_rechazada: 'credencial_rechazada', sin_red: 'sin_red', servicio_fallo: 'sin_red', parcial: 'parcial', sin_tiempo: 'parcial', bajado: 'parcial', al_dia: 'parcial', sin_contenedor: 'sin_configurar', config_rota: 'sin_configurar', sin_configurar: 'sin_configurar' };

  async function leerBuzon(conf, previo, t) {
    const mb = conf && isObject(conf.site) && isObject(conf.site.mailbox) ? conf.site.mailbox : null;
    const nube = mb ? lasNubes().find((n) => Array.isArray(n.PROVEEDORES_DE_BUZON) && n.PROVEEDORES_DE_BUZON.includes(mb.provider)) : null;
    if (!mb) { st.fallas.buzon = null; st.personas.informados = null; return noMedida('sin_buzon'); }
    if (!nube) {
      // hay buzón declarado y ninguna nube de cloud/ lo sabe leer (un módulo que no carga): no es «sin buzón», y se avisa
      log(`ninguna nube de cloud/ sabe leer el buzón «${String(mb.provider).slice(0, 40)}»`);
      st.fallas.buzon = st.fallas.buzon || { desde: t, estado: 'sin_configurar' };
      return previo && previo.estado === 'medido' ? previo : noMedida('sin_configurar');
    }
    if (!cfg.mailboxCredencial) {
      log('operations.json declara un buzón y el sitio no tiene su credencial (SITE_MAILBOX_SAS o SITE_MAILBOX_IDENTITY)');
      st.fallas.buzon = st.fallas.buzon || { desde: t, estado: 'sin_configurar' };
      return previo && previo.estado === 'medido' ? previo : noMedida('sin_configurar');
    }
    // las conversaciones y los cambios de git se bajan SÓLO con `site.mailbox.threads: true` y
    // un disco del sitio (SITE_DATA_DIR): pesan casi un giga, y sin disco se volverían a bajar enteros en cada despertar
    const conHilos = mb.threads === true && Boolean(cfg.dataDir);
    if (mb.threads === true && !cfg.dataDir) log('site.mailbox.threads está en true pero SITE_DATA_DIR no está puesta: no se bajan las conversaciones (sin un disco del sitio se bajarían enteras en cada despertar)');
    let r;
    try {
      // con conversaciones: por tandas de `topeConversacionesBytes`, cada una resumida y borrada antes de la siguiente (el
      // disco del sitio guarda los resúmenes, nunca las conversaciones); y el espejo poda lo que ya no está en el buzón
      // la bajada recorre el espejo en el disco montado: con el módulo de la nube cargado de cloud/, en un hilo aparte
      // (el principal contesta las sondas); una nube dada a mano (las pruebas) corre acá
      const opts = { cuenta: mb.account, contenedor: mb.container, credencial: cfg.mailboxCredencial, dir: dirBuzon, urlBase: urlBuzon, sinHilos: !conHilos, budgetMs: presupuestoBuzonMs,
        resumenes: conHilos, topeBytesHilos: conHilos ? topeConversacionesBytes : null, hiloTopeBytes: conHilos ? topeConversacionBytes : null, podar: true, log: (l) => log(`buzón: ${l}`) };
      r = nube.__archivo ? await require('./summaries.js').bajarEnWorker({ modulo: nube.__archivo, ...opts }) : await nube.bajarBuzon(opts);
    } catch (e) { r = { codigo: 1, res: { estado: 'sin_red', motivo: `error inesperado al bajar: ${e.message}` } }; }
    if (conHilos) {
      // pase lo que pase con la bajada: lo que llegó a bajar se resume y se borra (un disco lleno no se espera a la pasada entera)
      try {
        const s = await resumir({ buzon: dirBuzon });
        if (s.resumidas) log(`buzón: ${s.resumidas} ejecución(es) resumida(s); sus conversaciones ya no ocupan el disco`);
        if (s.fallidas) log(`buzón: ${s.fallidas} ejecución(es) no se pudieron resumir y siguen en el disco: ${(s.motivos || []).join(', ')}`);
      } catch (e) { log(`buzón: no se pudieron resumir las conversaciones bajadas (${e.code || e.message}): siguen en el disco`); }
    }
    const est = r.res.estado;
    // 🔴 «leído entero» lo dice `completo` (download-runs.js), no el estado: 'bajado' también sale con el presupuesto agotado
    // la pestaña Corridas arma con una bajada entera, la misma que fija lo informado por las máquinas; con una a medias,
    // la foto del espejo y la de quién es quién no serían la misma. Una pasada que cortó DESPUÉS de bajar todos los
    // volcados y los registros (`registros_enteros`) también arma: lo que falta son conversaciones de corridas que ya
    // están en la tabla, y la pestaña dice cuántos archivos quedan (`pendientes`) en vez de quedarse en la foto vieja
    st.buzon.completo = r.codigo === 0 && r.res.completo === true;
    st.buzon.armable = st.buzon.completo || (r.codigo === 0 && r.res.registros_enteros === true);
    st.buzon.pendientes = st.buzon.armable && !st.buzon.completo ? r.res.sin_tiempo || 0 : 0;
    // la pasada cortó por TIEMPO pero avanzó: la siguiente va enseguida y retoma donde quedó, en vez de
    // esperar el refresco de los minutos de siempre. Sin avance, no: sería un lazo.
    st.buzon.seguir = r.codigo === 0 && !st.buzon.completo && r.res.sin_tiempo > 0 && r.res.bajados > 0;
    if (st.buzon.seguir) log(`buzón: la pasada cortó ${r.res.por_tope ? 'por el tope de conversaciones' : 'por tiempo'} con ${r.res.sin_tiempo} archivo(s) pendientes; la siguiente sigue enseguida`);
    if (r.res.hilos_grandes) log(`buzón: ${r.res.hilos_grandes} conversación(es) pasan el tope de ${Math.round(topeConversacionBytes / (1024 * 1024))} MB: no se bajan, y sus ejecuciones lo dicen en la tabla`);
    if (st.buzon.armable) {
      st.buzon.generacion += 1;
      st.fallas.buzon = null;
      st.hilos = conHilos;
      // lo informado se lee del mismo espejo, entero: con una bajada a medias queda el de la última entera. Las dos
      // lecturas recorren el espejo en el disco montado: en un hilo aparte, para que el principal siga contestando
      let leido;
      try { leido = await leerEspejo({ buzon: dirBuzon }); }
      catch (e) {
        const motivo = `la lectura del espejo falló (${e.code || e.message})`;
        leido = { corridas: { ...noMedida('ilegible'), _motivo: motivo }, informados: { maquinas: {}, uniones: { schema: 1, carpetas: {}, regeneradas: {}, no_medido: motivo }, no_medido: motivo } };
      }
      const c = leido.corridas;
      st.personas.informados = leido.informados;
      if (st.personas.informados.no_medido) log(`lo informado por las máquinas no se pudo leer: ${st.personas.informados.no_medido}`);
      if (c.estado !== 'medido') log(`el espejo del buzón se bajó entero pero no se pudo leer${c._motivo ? `: ${c._motivo}` : ''}`);
      delete c._motivo;
      return { ...c, fecha: diaUtc(t) };
    }
    const codigo = ESTADO_BUZON[est] || 'sin_red';
    log(`el buzón no se leyó entero (${est}${r.res.sin_tiempo ? `, ${r.res.sin_tiempo} sin tiempo` : ''}): ${r.res.motivo || 'sin motivo'}`);
    st.fallas.buzon = st.fallas.buzon || { desde: t, estado: codigo };
    if (previo && previo.estado === 'medido') return previo;
    return noMedida(codigo);
  }

  /** La unión de carpetas del espejo, leída sin trabar el hilo principal (el espejo vive en el disco montado). */
  async function leerCarpetas() {
    let r;
    try { const crudo = await fs.promises.readFile(path.join(dirBuzon, '.carpetas-de-maquina.json'), 'utf8'); try { r = { doc: JSON.parse(crudo) }; } catch { r = { codigo: 'ilegible' }; } }
    catch (e) { r = { codigo: e.code === 'ENOENT' ? 'sin_foto' : 'ilegible' }; }
    if (r.codigo === 'ilegible') log('.carpetas-de-maquina.json del espejo del buzón no se pudo leer: sin la unión de carpetas');
    if (r.doc && !carpetasProyectadas(r.doc)) log('.carpetas-de-maquina.json no tiene la forma esperada: sin la unión de carpetas');
    return r.doc && isObject(r.doc) ? r.doc : null;
  }

  const construir = ({ corridas, carpetas, t }) => construirDesdeClon(clon, { ahora: t, corridas, carpetas, fichas: st.fichas || null, log });

  /**
   * Las fichas del tablero nocturno: el mismo cálculo que arma la página, en un hilo aparte porque recorre el espejo
   * del buzón. Las que `site.hidden_cards` oculta no entran. Si el hilo se cae, queda la última lista buena (o todas no medidas).
   */
  async function calcularFichas(corridas, t) {
    const ocultas = st.ultimoBueno && st.ultimoBueno.site && Array.isArray(st.ultimoBueno.site.hidden_cards) ? st.ultimoBueno.site.hidden_cards : [];
    try {
      return await calcularFichasEn({ clon, dirBuzon, buzonLeido: Boolean(corridas && corridas.estado === 'medido'), ocultas, ahora: t, log: (l) => log(`fichas: ${l}`) });
    } catch (e) {
      log(`las fichas del tablero no se pudieron calcular (${(e && e.code) || (e && e.name) || 'error'}): ${st.fichas ? 'queda la última lista buena' : 'salen no medidas'}`);
      // la última lista buena no se presenta como de hoy: cada ficha lleva la fecha de su fuente y la pantalla la muestra
      return st.fichas || require('./tabs/cards.js').fichasNoMedidas(ocultas);
    }
  }

  /** Lo que se puede armar sin el repo (la primera lectura sin clon): todo «no medido» con el estado. */
  function modeloVacio(codigo, t, corridas) {
    const n = noMedida(codigo);
    return { generado: t, dependencias: n, vigilante: n, banco: n, suites: n, examen: n, declarados: n, productos: [], productosFuente: n, proyectos: n, despliegues: n, paridad: n, prs: n, pedidos: n, tablero: n, sources: { lista: [] }, umbrales: {}, stateAgeDays: null, corridas: corridas || n, carpetas: null };
  }

  /**
   * Un refresco, en tres tramos: lo de los clones con el candado, la bajada del buzón sin él (no toca los clones y tarda
   * un minuto en un sitio real: un envío de Mantenimiento no la espera), y lo que vuelve a leer el clon, otra vez con él.
   */
  async function refrescarUnaVez() {
    const t = ahora();
    if (!(await exclusivo(() => losClones(t)))) return;
    const corridas = await leerBuzon(st.ultimoBueno, st.modelo && st.modelo.corridas && st.modelo.corridas.codigo !== 'cargando' ? st.modelo.corridas : null, t);
    await exclusivo(async () => {
      st.fichas = await calcularFichas(corridas, t);
      st.modelo = construir({ corridas, carpetas: await leerCarpetas(), t });
      st.cargado = true;
    });
    for (const fn of oyentes) { try { fn(); } catch (e) { log(`un aviso de refresco falló: ${e && e.message ? e.message : e}`); } }
  }

  /** Los clones al día y lo que se lee de ellos. false = el repo no se pudo leer (el refresco termina ahí). */
  async function losClones(t) {
    const repo = await actualizarRepo();
    if (!repo.ok) {
      log(repo.motivo || 'el repo de operaciones no se pudo leer');
      st.fallas.repo = st.fallas.repo || { desde: t, estado: repo.estado };
      aplicarConfig({ ok: false, motivo: 'el repo de operaciones no se pudo leer', rutas: 'el repo de operaciones no se pudo leer' }, t);
      if (!st.modelo) st.modelo = hayLectura() ? construir({ corridas: noMedida(repo.estado), carpetas: null, t }) : modeloVacio(repo.estado, t);
      // el perfil no depende del repo de operaciones: se baja igual
      await actualizarPerfil();
      st.cargado = true;
      return false;
    }
    st.fallas.repo = null;
    aplicarConfig(leerOperaciones(), t);
    // repos.json que no se lee deja la última lista buena (como el resto de las fuentes), y lo dice el registro
    const repos = leerRepos(clon);
    if (repos.repos) st.personas.repos = repos.repos;
    else log(`dónde trabaja cada uno: ${repos.motivo}${st.personas.repos ? '; queda la última lista buena' : ''}`);
    // el perfil del equipo antes que el buzón: es un clon chico, y la pestaña Configuración no espera a las corridas
    await actualizarPerfil();
    // la espera es POR FUENTE: con el repo leído, el sitio ya se navega; lo lento es el buzón. Hasta la primera
    // lectura del buzón, las corridas dicen «cargando» (nunca cero), y sólo la pestaña Corridas espera
    if (!st.modelo) st.modelo = construir({ corridas: noMedida('cargando'), carpetas: null, t });
    st.navegable = true;
    return true;
  }

  function refrescar() {
    if (enCurso) return enCurso;
    enCurso = refrescarUnaVez().catch((e) => {
      // un refresco que se cae por algo inesperado deja el último modelo bueno, pero con banda (nunca en silencio)
      log(`el refresco falló de forma inesperada: ${e && e.stack ? e.stack : e}`);
      st.fallas.repo = st.fallas.repo || { desde: ahora(), estado: 'falla_interna' };
      if (!st.modelo) st.modelo = modeloVacio('falla_interna', ahora());
      st.cargado = true;
    }).finally(() => { enCurso = null; });
    return enCurso;
  }

  function minutos() {
    const c = st.ultimoBueno;
    const v = c && isObject(c.site) ? c.site.refresh_minutes : null;
    return Number.isInteger(v) && v >= OPS.REFRESH_MIN && v <= OPS.REFRESH_MAX ? v : REFRESCO_POR_DEFECTO;
  }

  // cuándo va el próximo refresco: los minutos de siempre, o enseguida si la bajada cortó por tiempo y avanzó
  const SEGUIR_MS = 10000;
  const proximoRefrescoMs = () => (st.buzon.seguir ? SEGUIR_MS : minutos() * 60000);

  function programar() {
    temporizador = setTimeout(async () => { await refrescar(); programar(); }, proximoRefrescoMs());
    if (temporizador.unref) temporizador.unref();
  }

  return {
    /** Lee al despertar y después cada `site.refresh_minutes`. */
    arrancar() { refrescar().then(programar); },
    refrescar,
    estado() {
      const fallas = [st.fallas.repo, st.fallas.buzon].filter(Boolean);
      const banda = fallas.length ? { desde: Math.min(...fallas.map((f) => f.desde)), estado: fallas[0].estado } : null;
      // el freno se cuenta con la hora de CADA pedido, no sólo al refrescar: si el repo deja de bajarse después del
      // primer fallo, el sitio igual se frena a las 24 horas
      if (st.cargado && (st.fallaDesde !== null || conCopia)) recontar(ahora());
      // `navegable`: ya se leyó el repo de operaciones (el sitio se navega); `cargado`: además, el buzón (lo que espera /readyz)
      return { cargado: st.cargado, navegable: Boolean(st.navegable) || st.cargado, frenado: st.frenado, bandaConfig: st.bandaConfig, bandaRefresco: banda };
    },
    config: () => st.ultimoBueno,
    modelo: () => st.modelo,
    /** Lo que la regla de quién es quién necesita y el modelo no lleva: `{ informados, repos }` (nunca a una vista). */
    personas: () => st.personas,
    detener() { if (temporizador) clearTimeout(temporizador); temporizador = null; },
    /**
     * Los clones que lee la pestaña Configuración: `{ operaciones: { dir } | null, perfil: { dir, estado, motivo } | null }`.
     * Con la copia, `operaciones` es la carpeta de la foto, sin git, y trae su índice (`{ dir, indice }`).
     */
    clones: () => ({
      operaciones: !hayLectura() ? null : (conCopia ? { dir: clon, indice: st.copia.indice } : { dir: clon }),
      perfil: cfg.profileRepo ? { dir: fs.existsSync(path.join(dirPerfil, '.git')) ? dirPerfil : null, estado: st.perfil.estado, motivo: st.perfil.motivo } : null,
    }),
    /** Con la copia: el clon aparte donde «Proponer» trae `main` (en el disco del contenedor, como los clones). */
    clonDeEscritura: conCopia ? () => prepararClonDeEscritura({ dir: path.join(raizClones, 'operaciones-escritura'), url: cfg.operationsRepo, git }) : undefined,
    /** El clon de escritura de un repo de producto, armado a pedido: la sección por repo lee `main` y propone ahí. */
    clonDeProducto: ({ id, url }) => (/^[a-z0-9-]+$/.test(String(id)) ? prepararClonDeEscritura({ dir: path.join(raizClones, 'productos', id), url, git }) : { motivo: 'identificador de repo inválido' }),
    exclusivo,
    dirBuzon,
    /** ¿la última bajada entera del espejo trajo las conversaciones y los cambios de git? */
    hilos: () => st.hilos,
    /**
     * El detalle a demanda: la conversación y el cambio de git de UNA corrida (`maquina`, `base`: el volcado sin
     * `.json`), bajados a `<dir>/<maquina>/` con la credencial del buzón. `{ codigo, res: { estado, motivo } }`.
     */
    async bajarCorrida({ maquina, base, dir }) {
      const conf = st.ultimoBueno;
      const mb = conf && isObject(conf.site) && isObject(conf.site.mailbox) ? conf.site.mailbox : null;
      const nube = mb ? lasNubes().find((n) => Array.isArray(n.PROVEEDORES_DE_BUZON) && n.PROVEEDORES_DE_BUZON.includes(mb.provider)) : null;
      if (!mb || !nube || typeof nube.bajarUnaCorrida !== 'function' || !cfg.mailboxCredencial) return { codigo: 1, res: { estado: 'sin_configurar', motivo: 'el buzón no está configurado en el sitio' } };
      return nube.bajarUnaCorrida({ cuenta: mb.account, contenedor: mb.container, credencial: cfg.mailboxCredencial, urlBase: urlBuzon, maquina, base, dir });
    },
    /** ¿la ÚLTIMA bajada del buzón terminó entera?, y cuántas enteras hubo (la pestaña arma con una entera). */
    // `armable`: la pestaña puede armar (entera, o con todos los volcados y registros); `pendientes`: archivos de
    // conversaciones que esa pasada dejó para la siguiente
    // `siguiendo`: la última pasada cortó por tiempo y la siguiente ya está en camino (la pestaña dice «cargando»)
    buzonEstado: () => ({ completo: st.buzon.completo, armable: st.buzon.armable, generacion: st.buzon.generacion, siguiendo: st.buzon.seguir, pendientes: st.buzon.pendientes || 0 }),
    /** En cuántos ms va el próximo refresco (las pruebas lo miran). */
    proximoRefrescoMs,
    /** `fn` corre al terminar cada refresco (la pestaña Corridas mira si el espejo cambió). */
    alRefrescar(fn) { oyentes.push(fn); },
  };
}

module.exports = { crearFuentes, nubes, prepararClonDeEscritura, construirDesdeClon, estadoDeLaConfiguracion, estadoDelSitio, leerRepos, estadoDeGit, limpiarLinea, leerCorridas, ultimaFoto, correr, dentroDe, PLAZO_CONFIG_MS };
