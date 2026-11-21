'use strict';
/**
 * env-switches.js — la lista única de las variables de entorno que lee el arnés (`env-switches.json`, al lado).
 *
 * Cada entrada dice qué valores la apagan de verdad (los que toma su lector, no una regla general), quién la lee y cómo
 * (`entorno`: la variable del proceso; `comando`: un freno que la busca en el texto del comando del agente), su clase,
 * si ESC-C1 pide la firma (`firma`), si la revisión de la noche la cuenta como escape (`noche`) y si en la configuración
 * de la herramienta apaga con cualquier valor que no sea 0 ni vacío (`en_configuracion: 'cualquiera'`). Una entrada
 * puede traer su fecha de corte (`enforce_from`): hasta ese día su escape avisa y anota; desde ese día pide la firma, o su
 * escotilla deja de valer (`corteDe`, `antesDelCorte`).
 *
 * La leen `apaga()` (controls-off.js, HARNESS-C2) y la revisión de la noche (runs-review/rules.js). Los dos frenos de
 * bash (ESC-C1 y HARNESS-C1) corren en cada comando y no la leen: una prueba los ata a ella
 * (scripts/tests/env-switches.test.js).
 *
 * También anota el escape de un lector en `bypass.log` (`anotarEscape`): si no puede, lo dice por la salida de error y
 * sigue, porque el registro no traba el trabajo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA = path.join(__dirname, 'env-switches.json');

// las clases que apagan o aflojan un control: sólo éstas suman a `apaga()` y a HARNESS-C1
const APAGAN_UN_CONTROL = ['debilita-evidencia', 'kill-switch', 'escape-de-diseno'];

let cache = null;

/** La lista: `{ ok: true, entradas }`, o `{ ok: false, error }` si falta o no se puede leer. */
function leer({ ruta = RUTA } = {}) {
  if (ruta === RUTA && cache) return cache;
  let r;
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!datos || !Array.isArray(datos.entradas)) throw new Error('no trae «entradas»');
    // una entrada mal armada la invalida entera: los lectores la usan sin más chequeos
    const mal = datos.entradas.find((e) => !e || typeof e.nombre !== 'string' || !Array.isArray(e.apagan) || !Array.isArray(e.lectores)
      || typeof e.clase !== 'string' || typeof e.firma !== 'boolean' || typeof e.noche !== 'boolean');
    if (mal !== undefined) throw new Error(`entrada mal armada: ${mal && mal.nombre ? mal.nombre : JSON.stringify(mal)}`);
    r = { ok: true, entradas: datos.entradas };
  } catch (e) {
    r = { ok: false, error: e.code || e.message, entradas: [] };
  }
  if (ruta === RUTA) cache = r;
  return r;
}

const entrada = (nombre) => leer().entradas.find((e) => e.nombre === String(nombre).toUpperCase()) || null;
const apagaUnControl = (e) => Boolean(e) && APAGAN_UN_CONTROL.includes(e.clase) && (e.en_configuracion === 'cualquiera' || e.apagan.length > 0);

/**
 * ¿La lista dice que `nombre=valor` apaga un control? `true`/`false` si la variable es de las que apagan; `null` si la
 * lista no la conoce, o la conoce y no apaga nada (manda la regla general de `apaga()`).
 */
function apagaSegunLista(nombre, valor) {
  const e = entrada(nombre);
  if (!apagaUnControl(e)) return null;
  const v = String(valor == null ? '' : valor).trim().toLowerCase();
  if (e.en_configuracion === 'cualquiera') return v !== '' && v !== '0';
  return e.apagan.map((x) => String(x).toLowerCase()).includes(v);
}

const cualquiera = () => leer().entradas.filter((e) => e.en_configuracion === 'cualquiera').map((e) => e.nombre);
const conFirma = () => leer().entradas.filter((e) => e.firma).map((e) => e.nombre);
/**
 * La fecha de corte de una variable (`enforce_from`, `AAAA-MM-DD`): desde ese día su escape pide la firma del dueño, o su
 * escotilla deja de valer. `null` si no la trae o no se puede leer.
 */
function corteDe(nombre) {
  const e = entrada(nombre);
  const f = e && typeof e.enforce_from === 'string' ? e.enforce_from : null;
  return f && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) ? f : null;
}

/**
 * ¿`ahora` (fecha, milisegundos o texto) cae antes de la fecha de corte de `nombre`, a medianoche UTC? Sin fecha legible,
 * `false`: falla cerrado, y el escape pide la firma igual que desde el corte.
 */
function antesDelCorte(nombre, ahora = new Date()) {
  const f = corteDe(nombre);
  if (!f) return false;
  const t = ahora instanceof Date ? ahora.getTime() : (typeof ahora === 'number' ? ahora : Date.parse(String(ahora)));
  return Number.isFinite(t) && t < Date.parse(`${f}T00:00:00Z`);
}

/** Los escapes que cuenta la revisión de la noche, con los valores que de verdad los activan. */
const escapesDeLaNoche = () => leer().entradas.filter((e) => e.noche).map((e) => ({ nombre: e.nombre, apagan: e.apagan.slice() }));

// ── El inventario: qué variables lee el código ───────────────────────────────────────────────────────────────────────

const NOMBRE = 'TYCON_[A-Z0-9_]+|DOD_BYPASS|STOP_AUTONOMY';
// en .js: process.env.X, process.env['X'], env.X, env['X'] (el `env` inyectado) y readEnv('X' (legacy-names.js)
const EN_JS = new RegExp(`\\benv(?:\\.(${NOMBRE})\\b|\\[\\s*['"](${NOMBRE})['"]\\s*\\])|readEnv\\(\\s*['"](${NOMBRE})['"]`, 'g');
// en .sh: $X y ${X, y también las formas de .js (el node que un guion lleva adentro lee `process.env.X`)
const EN_SH = new RegExp(`\\$\\{?(${NOMBRE})\\b|\\benv\\.(${NOMBRE})\\b`, 'g');
// en la lista de ganchos del instalador: `optin:X`, la variable con que el instalador decide si registra el gancho
const LISTA_DE_GANCHOS = path.join('scripts', 'setup', 'hooks-list.json');
const EN_GANCHOS = new RegExp(`optin:(${NOMBRE})\\b`, 'g');
const CARPETAS_FUERA = new Set(['.git', 'node_modules', 'tests', '__tests__', 'test', 'controls-bench', 'fixtures']);
// Una prueba fuera de las carpetas de pruebas se llama `*.test.js`; un `test-*.js` suelto es código (lib/test-scope.js).
const esPrueba = (nombre) => /\.test\.[cm]?js$/.test(nombre);

// Las carpetas del código del núcleo. `integrations/` queda afuera (cada integración lleva lo suyo), y también lo que
// otro árbol pone encima del arnés (las historias, las tareas, la evidencia de un repo que lo usa).
const CARPETAS_DEL_NUCLEO = ['scripts', 'skills', 'build'];

/**
 * Las variables que lee el código del núcleo bajo `raiz` (sus carpetas de código, fuera de pruebas y del banco):
 * nombre → archivos (relativos).
 */
function lecturas(raiz) {
  const out = new Map();
  const visitar = (dir) => {
    let hijos;
    try { hijos = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const h of hijos) {
      const p = path.join(dir, h.name);
      if (dir === raiz && !(h.isDirectory() && CARPETAS_DEL_NUCLEO.includes(h.name))) continue;
      if (h.isDirectory()) { if (!CARPETAS_FUERA.has(h.name)) visitar(p); continue; }
      const ganchos = path.relative(raiz, p) === LISTA_DE_GANCHOS;
      if (!ganchos && (!/\.(c|m)?js$|\.sh$/.test(h.name) || esPrueba(h.name))) continue;
      let texto;
      try { texto = fs.readFileSync(p, 'utf8'); } catch (_e) { continue; }
      const re = new RegExp(ganchos ? EN_GANCHOS : h.name.endsWith('.sh') ? EN_SH : EN_JS);
      let m;
      while ((m = re.exec(texto))) {
        const nombre = m[1] || m[2] || m[3] || m[4];
        if (!out.has(nombre)) out.set(nombre, new Set());
        out.get(nombre).add(path.relative(raiz, p).split(path.sep).join('/'));
      }
    }
  };
  visitar(raiz);
  return out;
}

/** Las variables que el código lee y la lista no trae. */
const faltantes = (entradas, lecturasDelArbol) => {
  const nombres = new Set(entradas.map((e) => e.nombre));
  return [...lecturasDelArbol.keys()].filter((n) => !nombres.has(n)).sort();
};

/**
 * Las entradas que nadie lee y no se declaran `sin-lector`. Una de `entorno` se lee si el escaneo la encuentra; una de
 * `comando`, si alguno de sus lectores trae `X=` en su texto (el patrón del freno).
 */
function sinLector(entradas, raiz, lecturasDelArbol) {
  const leida = (e) => {
    if (e.lectura === 'comando') {
      return e.lectores.some((f) => { try { return fs.readFileSync(path.join(raiz, f), 'utf8').includes(`${e.nombre}=`); } catch (_e) { return false; } });
    }
    return lecturasDelArbol.has(e.nombre);
  };
  return entradas.filter((e) => e.clase !== 'sin-lector' && !leida(e)).map((e) => e.nombre).sort();
}

// ── El registro de un escape ─────────────────────────────────────────────────────────────────────────────────────────

const estadoDe = (home) => require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
const sesionDe = (env) => env.CLAUDE_CODE_SESSION_ID || env.TYCON_SESSION_ID || env.CODEX_SESSION_ID || null;

/**
 * Anota un escape en `bypass.log`: `{ stateDir | home, sessionId, kind, variable, ...campos }`. Con `unaVez` (una clave),
 * una sola vez por sesión, clave y día (UTC): la marca vive en `<estado>/escapes-anotados/`. Devuelve `true` si escribió,
 * `false` si no pudo (y lo dice por la salida de error) o si ya estaba anotado hoy.
 */
function anotarEscape({ stateDir, home = os.homedir(), sessionId, kind, variable, unaVez, ahora = new Date(), ...campos }) {
  const dir = stateDir || estadoDe(home);
  const ts = ahora.toISOString();
  try {
    fs.mkdirSync(dir, { recursive: true });
    let marca = null;
    if (unaVez && sessionId) {
      const seguro = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
      marca = path.join(dir, 'escapes-anotados', `${seguro(kind)}-${seguro(sessionId)}-${seguro(unaVez)}-${ts.slice(0, 10)}`);
      fs.mkdirSync(path.dirname(marca), { recursive: true });
      // La marca se toma antes de escribir, y de una sola vez: dos procesos a la par no anotan el mismo escape dos veces.
      try { fs.writeFileSync(marca, '', { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    }
    try {
      fs.appendFileSync(path.join(dir, 'bypass.log'), JSON.stringify({ ts, sessionId: sessionId || null, kind, variable, ...campos }) + '\n', 'utf8');
    } catch (e) {
      if (marca) { try { fs.unlinkSync(marca); } catch (_e) { /* la marca sin línea sólo pierde el aviso de hoy */ } }
      throw e;
    }
    return true;
  } catch (e) {
    process.stderr.write(`⚠️  no pude anotar el escape ${variable} en bypass.log (${e.code || e.message})\n`);
    return false;
  }
}

/** ¿Corre dentro de una CI? Azure DevOps (`TF_BUILD`, que Azure pone como `True`) o GitHub (`GITHUB_ACTIONS`). */
const esCI = (env = process.env) => /^true$/i.test(String(env.TF_BUILD || '').trim()) || /^true$/i.test(String(env.GITHUB_ACTIONS || '').trim());

module.exports = { RUTA, APAGAN_UN_CONTROL, leer, entrada, apagaUnControl, apagaSegunLista, cualquiera, conFirma, escapesDeLaNoche, corteDe, antesDelCorte,
  lecturas, faltantes, sinLector, anotarEscape, sesionDe, esCI };
