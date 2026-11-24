'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * isolated-run.js — la corrida aislada de un humo (historia 8.314): el comando corre con una casa aparte y no puede
 * escribir en la casa de la cuenta.
 *
 * `smoke-run.sh` corre un humo comparado primero «de siempre», con el ambiente de quien lo llama; un guion que armaba su
 * casa de juguete en `process.env.HOME` escribió así en la máquina real (el tablero, la designación de la coordinadora).
 * Ahora esa pasada, y la de todo humo cuyo programa es un guion de laboratorio, corre acá:
 *   - `HOME` y `USERPROFILE` son una carpeta nueva de `mkdtemp`, con `TMPDIR`, `TMP` y `TEMP` adentro; `TYCON_HOME`,
 *     `CLAUDE_CONFIG_DIR` y `CODEX_HOME` no llegan; `TYCON_TEST_RUN=1` sí;
 *   - la red de escritura de las pruebas (scripts/tests/lib/real-home-guard.js) frena todo `node` que escriba en las
 *     carpetas del arnés de la casa de la cuenta (la propia, la de Claude Code, la de Codex y `TYCON_HOME`: `vigiladas`),
 *     y lo anota; un intento anotado hace fallar el humo aunque el comando se haya tragado el error;
 *   - en macOS, además, `sandbox-exec` deja escribir sólo en esa carpeta y en las raíces admitidas; la red queda abierta.
 *     Si el sistema no deja abrir el encierro (una sesión ya encerrada), se dice y sigue con la red de escritura. Un
 *     hijo que el comando lanza con el ambiente mínimo pierde la red (vive en `NODE_OPTIONS`) y su casa vuelve a ser la
 *     de la cuenta: si escribe en una carpeta vigilada, el encierro lo mata y el sistema lo anota en su registro con la
 *     marca de esta corrida; al terminar se lee ese registro, y lo anotado hace fallar el humo como un intento de la
 *     red. Lo que se niega sin matar, el sistema no lo anota para node. Y anota pocas muertes por minuto: si no anotó
 *     una, el proceso igual murió sin escribir.
 *     Sin el encierro, la red es la única defensa, y ese hijo escribe.
 * Las raíces admitidas son la del repo del comando y, para un guion suelto, su carpeta; no se admite una que sea la
 * casa, que contenga una carpeta vigilada o que sea el arnés instalado.
 *
 * Un humo común (sin `--compare` y sin programa de laboratorio) no pasa por acá: `decide` lo dice sin cargar nada de
 * `scripts/` ni crear nada. Lo que no se puede armar falla cerrado: nunca cae en la casa real.
 *
 * CLI (lo llama smoke-run.sh):
 *   isolated-run.js decide [--compare] [--covers a,b] [--root <r>] -- <comando…>
 *       imprime `comun`, o `aislada` y debajo una raíz admitida por renglón; sale 2 con el motivo si no se corre
 *   isolated-run.js exec [--root <r>]… -- <comando…>
 *       corre el comando aislado y sale con su código, o con 3 si salió 0 y hubo intentos sobre la casa real (anotados
 *       por la red o negados por el encierro), o no se pudo leer alguno de los dos registros
 * Casos: scripts/tests/test-run-isolation.test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const GUARD = path.join(RAIZ, 'scripts', 'tests', 'lib', 'real-home-guard.js');
const LAB_HOME = path.join(RAIZ, 'scripts', 'lib', 'lab-home.js');
const SHELL_PARSE = path.join(RAIZ, 'scripts', 'lib', 'shell-parse.js');
const TYCON_HOME_LIB = path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js');
// los nombres de las variables de la red: los mismos que lee real-home-guard.js
const ROOTS_VAR = 'TYCON_REAL_HOME_GUARD_ROOTS';
const LOG_VAR = 'TYCON_REAL_HOME_GUARD_LOG';
const ALLOW_VAR = 'TYCON_REAL_HOME_GUARD_ALLOW';

const INTERPRETE = /^(node|bash|sh|zsh|python3?|ruby|perl|deno|bun|npx|tsx)$/;
const SHELL = /^(bash|sh|zsh)$/;
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p) => (FOLD ? p.toLowerCase() : p);

const cp = () => require('./compare-previous.js');
const casaDe = (userInfo) => require(path.join(RAIZ, 'scripts', 'lib', 'real-home.js')).casaDeLaCuenta(userInfo ? { userInfo } : {});
function real(p) {
  let base = path.resolve(String(p));
  const resto = [];
  for (;;) {
    try { return path.join(fs.realpathSync(base), ...resto); } catch (_) { /* sube un tramo */ }
    const arriba = path.dirname(base);
    if (arriba === base) return path.join(base, ...resto);
    resto.unshift(path.basename(base));
    base = arriba;
  }
}
const dentroDe = (p, base) => { const a = fold(real(p)); const b = fold(real(base)); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
/** La raíz del repo de git de `p` (una carpeta con `.git`, carpeta o archivo), o null. Sin llamar a git. */
function repoDe(p) {
  let dir = real(p);
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const arriba = path.dirname(dir);
    if (arriba === dir) return null;
    dir = arriba;
  }
  return null;
}

// ── Qué corre el comando ────────────────────────────────────────────────────────────────────────────────────────────

// las palabras del shell que van antes de un programa en un tramo (`then node g.js`, `do …`, `! …`, `{ …`)
const PALABRAS_DEL_SHELL = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', '}', ')']);

/**
 * El comando sin lo que va delante del programa: `VAR=valor`, `env`, `timeout`, `nohup`, `time`, `nice`, `command`,
 * `exec` y las palabras del shell. `chdir`: la carpeta de un `env -C <dir>`, para leer el programa desde ahí.
 */
function envolturas(argv) {
  let a = argv.map(String);
  let chdir = null;
  const saltarOpciones = (conValor) => {
    while (a.length && a[0].startsWith('-') && a[0] !== '-') {
      const f = a[0];
      a = a.slice(1);
      if (/^(-C|--chdir)=/.test(f)) chdir = f.slice(f.indexOf('=') + 1);
      if (conValor.includes(f) && a.length) { if (f === '-C' || f === '--chdir') chdir = a[0]; a = a.slice(1); }
    }
  };
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
    const w = a.length ? path.basename(a[0]) : '';
    if (PALABRAS_DEL_SHELL.has(a[0])) { a = a.slice(1); continue; }
    if (w === 'env') { a = a.slice(1); for (;;) { const antes = a.length; saltarOpciones(['-u', '--unset', '-C', '--chdir', '-S']); while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1); if (a.length === antes) break; } continue; }
    if (w === 'timeout') { a = a.slice(1); saltarOpciones(['-s', '--signal', '-k', '--kill-after']); a = a.slice(1); continue; }
    if (w === 'nice') { a = a.slice(1); saltarOpciones(['-n', '--adjustment']); continue; }
    if (['time', 'nohup', 'command', 'exec'].includes(w)) { a = a.slice(1); saltarOpciones(['-a']); continue; }
    break;
  }
  return { a, chdir };
}
const sinEnvolturas = (argv) => envolturas(argv).a;
/**
 * El texto de un `bash -c`, `sh -c` o `zsh -c` (también `-lc`, `-ec`, `-euo pipefail -c`…), o null si no es eso. Una `o`
 * en las letras juntas pide el nombre de la opción en la palabra siguiente, como `-o` sola.
 */
function textoDelShell(a) {
  if (!a.length || !SHELL.test(path.basename(a[0]))) return null;
  for (let i = 1; i < a.length; i++) {
    const t = a[i];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return a[i + 1] == null ? '' : a[i + 1];
    if (/^[-+][A-Za-z]*[oO][A-Za-z]*$/.test(t)) { i++; continue; }
    if (!/^[-+]/.test(t)) return null;
  }
  return null;
}
/** Las carpetas de laboratorio sueltas: las temporales del sistema y la de la sesión de fondo. */
const temporales = (env) => [os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP, '/tmp', '/private/tmp', env.CLAUDE_JOB_DIR && path.join(env.CLAUDE_JOB_DIR, 'tmp')]
  .filter((t) => t && path.isAbsolute(String(t)));
// las variables que apuntan a una carpeta temporal: un comando que las nombra no se puede leer sin correrlo
const RE_VARIABLE_TEMPORAL = /\$\{?(TMPDIR|TMP|TEMP|CLAUDE_JOB_DIR)\b/;
const nombraLaboratorio = (texto, env) => String(texto).includes(`.advisors${path.sep}dod-runtime${path.sep}`)
  || String(texto).includes('.advisors/dod-runtime/') || RE_VARIABLE_TEMPORAL.test(String(texto))
  || temporales(env).some((t) => String(texto).includes(String(t).replace(/[\\/]+$/, '')));
// lo que un intérprete puede correr: un guion por su extensión, o un archivo que se puede ejecutar
const RE_GUION = /\.(c?js|mjs|ts|cts|mts|sh|bash|zsh|py|rb|pl)$/i;
function guionDeLaboratorio(palabra, dirs, env) {
  const t = String(palabra);
  if (!t || /[$`*?]/.test(t) || t.startsWith('-')) return null;
  for (const d of dirs) {
    const f = path.resolve(d, t);
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!st.isFile() || !(RE_GUION.test(f) || (st.mode & 0o111))) continue;
    if (esLaboratorio(f, env)) return f;
  }
  return null;
}

/**
 * Los archivos que corre el comando: `{ archivos, dudoso }`. Además del programa de cada tramo, toda palabra del comando
 * que es un guion existente en una carpeta de laboratorio cuenta: así un guion detrás de un segundo intérprete (`npx tsx`),
 * de una opción con valor o adentro de un `if … then` no se escapa. `dudoso`: un comando que nombra una carpeta de
 * laboratorio o sus variables y no se pudo leer entero (sin `shell-parse.js`, o con variables).
 */
function programas(argv, { cwd, raiz, env, profundidad = 0 }) {
  const { a, chdir } = envolturas(argv);
  if (!a.length) return { archivos: [], dudoso: false };
  const desde = chdir && !/[$`~]/.test(chdir) ? path.resolve(cwd, chdir) : cwd;
  const out = { archivos: [], dudoso: false };
  const sumarPalabras = (palabras, dir) => {
    for (const p of palabras) { const f = guionDeLaboratorio(p, [...new Set([dir, cwd])], env); if (f) out.archivos.push(f); }
  };
  const texto = textoDelShell(a);
  if (texto === null) {
    const f = cp().archivoQueCorre(a, { cwd: desde, raiz });
    if (f) out.archivos.push(f);
    sumarPalabras(a.slice(1), desde);
    out.dudoso = a.slice(1).some((p) => RE_VARIABLE_TEMPORAL.test(p));
    return out;
  }
  let sp = null;
  try { sp = profundidad < 4 ? require(SHELL_PARSE) : null; } catch (_) { sp = null; }
  if (!sp) return { archivos: [], dudoso: nombraLaboratorio(texto, env) };
  // con variables de una carpeta temporal no se sabe adónde apunta: cuenta como de laboratorio
  out.dudoso = RE_VARIABLE_TEMPORAL.test(texto);
  let dir = desde;
  let segs;
  try { segs = sp.segmentos(texto); } catch (_) { return { archivos: [], dudoso: nombraLaboratorio(texto, env) }; }
  for (const seg of segs) {
    let palabras;
    try { palabras = sp.tokens(seg.texto); } catch (_) { out.dudoso = out.dudoso || nombraLaboratorio(seg.texto, env); continue; }
    const p = sinEnvolturas(palabras);
    if (p[0] === 'cd') { if (p[1] && !/[$`~]/.test(p[1])) dir = path.resolve(dir, p[1]); continue; }
    const r = programas(p, { cwd: dir, raiz, env, profundidad: profundidad + 1 });
    out.archivos.push(...r.archivos);
    out.dudoso = out.dudoso || r.dudoso;
    sumarPalabras(palabras, dir);
  }
  return out;
}

/** ¿Es un guion de laboratorio? En `.advisors/dod-runtime/` de un repo, o fuera de todo repo en una carpeta temporal. */
function esLaboratorio(archivo, env) {
  const f = real(archivo);
  if (fold(f).includes(fold(`${path.sep}.advisors${path.sep}dod-runtime${path.sep}`))) return true;
  return temporales(env).some((t) => dentroDe(f, t)) && !repoDe(path.dirname(f));
}

// ── Lo que se puede escribir ────────────────────────────────────────────────────────────────────────────────────────

function vigiladas(casa, env) {
  const th = require(TYCON_HOME_LIB);
  const out = [path.join(casa, th.OWN_DIR_NAME), th.claudeDir(casa), path.join(casa, '.codex')];
  const pedida = String(env.TYCON_HOME || '').trim();
  if (pedida && path.isAbsolute(pedida)) out.push(pedida);
  return out;
}
/** Por qué una raíz no se admite, o null. */
function noSeAdmite(r, casa, env) {
  if (dentroDe(casa, r)) return 'es la casa de la cuenta o la contiene';
  if (vigiladas(casa, env).some((v) => dentroDe(v, r))) return 'contiene una carpeta del arnés';
  let instalado = [];
  try { instalado = require('./installed-tree.js').roots({ home: casa }); } catch (e) { return `no pude saber si es el arnés instalado (${e.message})`; }
  if (instalado.some((i) => dentroDe(r, i))) return 'es el arnés instalado';
  return null;
}

// ── Decidir ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Si el humo corre aislado: `{ modo: 'comun' }`, `{ modo: 'aislada', raices, avisos }` o `{ codigo: 2, motivo }` (no se
 * corre). Un humo común no carga nada de `scripts/`.
 */
function decide({ argv, compare = false, covers = [], root = null, cwd = process.cwd(), env = process.env, userInfo } = {}) {
  const no = (motivo) => ({ codigo: 2, motivo });
  let casa = null;
  if (compare) {
    try { casa = casaDe(userInfo); } catch (e) { return no(`no pude saber cuál es la casa de la cuenta (${e.message})`); }
    const a = argv.map(String);
    // la ruta del intérprete no cuenta: un node instalado bajo la casa no es escribir en ella. Es la primera palabra
    // después de los prefijos (`env VAR=…`, `timeout N`); los prefijos y sus valores sí cuentan
    const i = a.length - sinEnvolturas(a).length;
    const resto = i < a.length && INTERPRETE.test(path.basename(a[i])) ? [...a.slice(0, i), ...a.slice(i + 1)] : a;
    const m = cp().tocaLoReal(resto.join(' '), { raicesReales: [], casaReal: casa });
    if (m) return no(`${m}: un humo comparado no corre así. Nombrá el archivo del repo con {raiz} (node {raiz}/<archivo>), o copiá el guion a una carpeta temporal de afuera de la casa`);
  }
  const { archivos, dudoso } = programas(argv, { cwd, raiz: root, env });
  const labs = archivos.filter((f) => esLaboratorio(f, env));
  if (!compare && !labs.length && !dudoso) return { modo: 'comun' };
  try { casa = casa || casaDe(userInfo); } catch (e) { return no(`no pude saber cuál es la casa de la cuenta (${e.message})`); }
  if (!fs.existsSync(GUARD)) return no(`falta la red de escritura (${GUARD}): sin ella el humo podría escribir en la casa real`);
  let lh;
  try { lh = require(LAB_HOME); } catch (e) { return no(`no pude cargar lab-home.js (${e.message})`); }
  try { fs.rmSync(lh.labHouse('prueba', { env, userInfo }), { recursive: true, force: true }); } catch (e) { return no(`no puedo crear la casa aparte: ${e.message}`); }
  const candidatas = [];
  if (root) candidatas.push(root);
  if (compare && !root) {
    try {
      const estado = require('./state-dir.js').stateDir(os.homedir());
      const sid = require('./session-id.js').sessionIdFileKey();
      const r = cp().raizDelHumo({ argv, covers, cwd, repos: cp().reposDeLaSesion({ stateDir: estado, sid, cwd }) });
      if (r.raiz) candidatas.push(r.raiz);
    } catch (_) { /* sin raíz: escribe sólo en su casa */ }
  }
  for (const f of labs) candidatas.push(repoDe(path.dirname(f)) || path.dirname(f));
  const raices = [];
  const avisos = [];
  for (const r of [...new Set(candidatas.map((x) => real(x)))]) {
    const motivo = noSeAdmite(r, casa, env);
    if (motivo) avisos.push(`[aislada] ⚠️ ${r} no se puede escribir en esta corrida: ${motivo}`);
    else raices.push(r);
  }
  return { modo: 'aislada', raices, avisos };
}

// ── Correr ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** ¿El sistema deja abrir el encierro? Adentro de otro (el de una sesión) no deja. */
function encierroAbre() {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  return !r.error && r.status === 0;
}
// Los intentos anotados por la red. Sin registro, ninguno; un registro que no se puede leer no es «ninguno»: `{ error }`
function intentosDe(log) {
  let texto;
  try { texto = fs.readFileSync(log, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? [] : { error: e.code || e.message }; }
  return texto.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return { fn: '?', targets: [l] }; } });
}

const CARRIED_KEY = Symbol.for('tycon.real-home-guard');
const ARRANQUE_VIEJO_MS = 24 * 3600000;
/**
 * El archivo que carga la red con lo que vigila (`real-home-guard.js`, `CARRIED`). No vive en la carpeta de la ejecución,
 * que se borra al terminar el comando: un node que el comando dejó de fondo y arranca después no lo encontraría y no
 * correría. Va en el temporal, con nombre por su contenido; los de más de un día se borran al escribir uno nuevo.
 */
function arranqueDeLaRed(lleva) {
  const texto = [
    "'use strict';",
    'const k = Symbol.for(\'tycon.real-home-guard\');',
    `if (!process[k]) Object.defineProperty(process, k, { value: Object.freeze(${JSON.stringify(lleva)}) });`,
    `require(${JSON.stringify(GUARD)});`,
    '',
  ].join('\n');
  const dir = path.join(os.tmpdir(), 'tycon-red');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `${require('crypto').createHash('sha256').update(texto).digest('hex').slice(0, 32)}.js`);
  if (!fs.existsSync(archivo)) {
    const parcial = `${archivo}.${process.pid}.tmp`;
    fs.writeFileSync(parcial, texto);
    fs.renameSync(parcial, archivo);
  }
  try {
    const ahora = Date.now();
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      try { if (p !== archivo && ahora - fs.statSync(p).mtimeMs > ARRANQUE_VIEJO_MS) fs.rmSync(p, { force: true }); } catch (_) { /* otro lo borró */ }
    }
  } catch (_) { /* limpiar es de más: el arranque ya está */ }
  return archivo;
}

// La hora del registro del sistema, en UTC con su zona: la hora local de node y la del sistema pueden ser distintas (TZ)
const horaDelRegistro = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}+0000`;
// El registro del sistema muestra lo que negó el encierro con atraso, más con la máquina cargada: al terminar, la
// corrida deja una marca de cierre por el mismo camino (una negación anotada, de un programa del sistema) y lee hasta
// verla, con un tope
const CIERRE_ESPERA_MS = 30000;
const CIERRE_PAUSA_MS = 500;
const cierreDe = (marca) => `${marca}-cierre`;
const dormirSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Los mensajes del registro del sistema con la marca, desde `desde`: `{ eventos }` o `{ error }`. */
function leerRegistro(marca, desde) {
  const r = spawnSync('/usr/bin/log', ['show', '--start', horaDelRegistro(desde), '--style', 'ndjson',
    '--predicate', `eventMessage CONTAINS "${marca}"`],
  { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { error: r.error ? (r.error.code || r.error.message) : `salió ${r.status}` };
  const eventos = [];
  for (const l of String(r.stdout).split('\n')) {
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    eventos.push(String((o && o.eventMessage) || ''));
  }
  return { eventos };
}
/**
 * La marca de cierre: `touch` sobre una carpeta que el encierro le niega con el mensaje `<marca>-cierre`. Pasa por el
 * mismo camino que las negaciones de la corrida, después de todas ellas.
 */
function marcarCierre(base, marca) {
  const dir = path.join(base, 'cierre');
  fs.mkdirSync(dir, { recursive: true });
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const perfil = `(version 1)(allow default)(deny file-write* (subpath ${q(dir)}) (subpath ${q(real(dir))}) (with message ${q(cierreDe(marca))}))`;
  spawnSync('/usr/bin/sandbox-exec', ['-p', perfil, '/usr/bin/touch', path.join(dir, 'x')], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
}
/**
 * Las rutas de las escrituras que el encierro negó con la marca de esta corrida: las de las carpetas vigiladas, que
 * matan al proceso. Lee el registro hasta ver la marca de cierre: lo que se negó antes ya está ahí. Un registro que no se
 * puede leer, o que no muestra la marca de cierre en `espera`, no es «ninguna»: `{ error }`. Para las pruebas: `leer`,
 * `ahora` y `dormir`.
 */
function negadasDelEncierro(marca, desde, { leer = leerRegistro, espera = CIERRE_ESPERA_MS, pausa = CIERRE_PAUSA_MS, ahora = Date.now, dormir = dormirSync } = {}) {
  const cierre = cierreDe(marca);
  const hasta = ahora() + espera;
  let eventos;
  for (;;) {
    const r = leer(marca, desde);
    if (r.error) return { error: r.error };
    eventos = r.eventos || [];
    if (eventos.some((t) => t.includes(cierre))) break;
    if (ahora() >= hasta) return { error: `el registro del sistema no mostró la marca de cierre en ${Math.round(espera / 1000)} s` };
    dormir(pausa);
  }
  const rutas = [];
  for (const texto of eventos) {
    if (texto.includes(cierre)) continue;
    // `Sandbox: node(123) deny(1) file-write-create /ruta` y debajo la marca; el renglón del propio `log` no es así
    if (!/Sandbox: .*deny\(\d+\)/.test(texto)) continue;
    const m = /deny\(\d+\) \S+ ([^\n]+)/.exec(texto);
    rutas.push(m ? m[1] : texto.split('\n')[0]);
  }
  return [...new Set(rutas)];
}

/** Corre el comando aislado. Devuelve una promesa con el código de salida. */
function exec({ argv, raices = [], env = process.env, userInfo, cwd = process.cwd(), err = (t) => process.stderr.write(t) } = {}) {
  return new Promise((resolve) => {
    let base;
    const fin = (codigo) => { if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* queda en el temporal */ } } resolve(codigo); };
    if (!argv.length) { err('[aislada] ⛔ falta el comando\n'); fin(2); return; }
    let casa;
    try {
      casa = casaDe(userInfo);
      base = require(LAB_HOME).labHouse('aislada', { env, userInfo });
    } catch (e) { err(`[aislada] ⛔ no puedo crear la casa aparte (${e.message}): no corro el comando\n`); fin(2); return; }
    if (!fs.existsSync(GUARD)) { err(`[aislada] ⛔ falta la red de escritura (${GUARD}): no corro el comando\n`); fin(2); return; }
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    const log = path.join(base, 'intentos.jsonl');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    let previas = [];
    try { previas = JSON.parse(env[ROOTS_VAR] || '[]'); } catch (_) { previas = []; }
    // dentro de otra ejecución aislada, lo que vigila la red de afuera viaja con ella aunque el guion haya limpiado la
    // variable: se suma, para que el nieto no quede con menos que el hijo
    const deAfuera = process[CARRIED_KEY];
    if (deAfuera && Array.isArray(deAfuera.roots)) previas = [...(Array.isArray(previas) ? previas : []), ...deAfuera.roots.map(String)];
    const raicesVigiladas = [...new Set([...previas, ...vigiladas(casa, env).flatMap((p) => [path.resolve(p), real(p)])])];
    const admitidas = [...new Set(raices.flatMap((r) => [path.resolve(r), real(r)]))];
    const nuevo = { ...env };
    for (const k of ['TYCON_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete nuevo[k];
    Object.assign(nuevo, { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, TYCON_TEST_RUN: '1',
      // la cobertura de quien llama queda fuera del encierro: su aviso, distinto en cada corrida, ensuciaría la salida
      NODE_V8_COVERAGE: '',
      [ROOTS_VAR]: JSON.stringify(raicesVigiladas), [LOG_VAR]: log, [ALLOW_VAR]: JSON.stringify(admitidas) });
    // la red se carga con un arranque que antes deja en el proceso lo que vigila: un guion de laboratorio que limpia las
    // TYCON_* y conserva NODE_OPTIONS sigue con estas raíces, este registro y estas admitidas, no con las de su casa de
    // juguete. Va primero: si NODE_OPTIONS ya cargaba la red, ésa la encuentra cargada con lo de esta ejecución
    let arranque;
    try { arranque = arranqueDeLaRed({ roots: raicesVigiladas, log, allow: admitidas }); } catch (e) { err(`[aislada] ⛔ no puedo escribir el arranque de la red (${e.message}): no corro el comando\n`); fin(2); return; }
    const red = `--require "${arranque.replace(/\\/g, '/')}"`;
    const opciones = String(env.NODE_OPTIONS || '').trim();
    nuevo.NODE_OPTIONS = `${red}${opciones ? ` ${opciones}` : ''}`;
    let lanzar = [argv[0], argv.slice(1)];
    // con el encierro abierto: escribir en una carpeta vigilada mata al proceso y queda en el registro del sistema con la
    // marca de esta corrida; `desde`, de dónde leerlo
    let marca = null;
    let desde = 0;
    if (process.platform === 'darwin') {
      const enc = cp().encierro(env);
      if (enc.nombre === 'sandbox-exec' && encierroAbre()) {
        marca = `tycon-aislada-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
        desde = Date.now() - 2000;
        // el temporal de here document de bash, sólo en la carpeta actual y si no hay ya uno con ese nombre: adentro no se
        // pueden crear enlaces, pero uno que ya estaba escribiría el archivo al que apunta
        const actual = cwd || process.cwd();
        let yaHay = true;
        try { yaHay = fs.readdirSync(actual).some((n) => /^sh-thd-[0-9]+$/.test(n)); } catch (_) { /* sin leerla, no se admite */ }
        if (yaHay) err(`[aislada] ⚠️ ${actual} ya tiene un sh-thd-<n> o no se pudo leer: el here document del bash del sistema queda negado ahí (un enlace con ese nombre escribiría otro archivo)\n`);
        const perfil = cp().perfilSandbox([base, ...admitidas], { red: true, fatales: raicesVigiladas, mensaje: marca, heredoc: yaHay ? [] : [actual] });
        lanzar = ['/usr/bin/sandbox-exec', ['-p', perfil, ...argv]];
      } else err(`[aislada] ⚠️ sin el encierro del sistema (${enc.nombre === 'sandbox-exec' ? 'el sistema no deja abrirlo: esta sesión ya corre encerrada' : enc.corta}): frena sólo la red de escritura de node\n`);
    }
    let hijo;
    try { hijo = spawn(lanzar[0], lanzar[1], { cwd, env: nuevo, stdio: 'inherit', windowsHide: true }); } catch (e) { err(`[aislada] ⛔ no pude correr el comando: ${e.message}\n`); fin(127); return; }
    const reenviar = (senal) => { try { hijo.kill(senal); } catch (_) { /* ya terminó */ } };
    const senales = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    for (const s of senales) process.on(s, reenviar);
    let error = null;
    hijo.on('error', (e) => { error = e; });
    hijo.on('close', (code, signal) => {
      for (const s of senales) process.removeListener(s, reenviar);
      let codigo = code !== null ? code : 128 + ((os.constants.signals || {})[signal] || 1);
      if (error && code === null) { err(`[aislada] ⛔ no pude correr el comando: ${error.message}\n`); codigo = 127; }
      const intentos = intentosDe(log);
      if (intentos.error) {
        err(`[aislada] ⛔ no pude leer el registro de la red de escritura (${intentos.error}): no sé si el comando intentó escribir en la casa de la cuenta\n`);
        if (codigo === 0) codigo = 3;
      } else if (intentos.length) {
        const rutas = [...new Set(intentos.flatMap((i) => i.targets || []))];
        err(`[aislada] ⛔ el comando intentó escribir en la casa de la cuenta (frenado): ${rutas.join(' · ')}\n`);
        if (codigo === 0) codigo = 3;
      }
      if (marca) {
        // lo que la red no vio: un proceso sin NODE_OPTIONS que quiso escribir en una carpeta vigilada
        marcarCierre(base, marca);
        const negadas = negadasDelEncierro(marca, desde);
        if (negadas.error) {
          err(`[aislada] ⛔ no pude leer el registro del encierro (${negadas.error}): no sé si el comando intentó escribir en la casa de la cuenta\n`);
          if (codigo === 0) codigo = 3;
        } else if (negadas.length) {
          err(`[aislada] ⛔ un proceso sin la red de escritura quiso escribir en la casa de la cuenta (el encierro lo mató): ${negadas.join(' · ')}\n`);
          if (codigo === 0) codigo = 3;
        }
      }
      fin(codigo);
    });
  });
}

module.exports = { decide, exec, programas, esLaboratorio, sinEnvolturas, noSeAdmite, negadasDelEncierro };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const corte = argv.indexOf('--');
  const opts = corte >= 0 ? argv.slice(0, corte) : argv;
  const comando = corte >= 0 ? argv.slice(corte + 1) : [];
  const todos = (k) => opts.flatMap((o, i) => (o === k && opts[i + 1] !== undefined ? [opts[i + 1]] : []));
  // @spec-first-exempt(SPEC-C1): el subcomando `decide` lo nombra el plan firmado de la historia 8.314 (step-02-bmad-plan.md, «Tareas → 2. La corrida aislada»); decidido por la coordinadora, 19/11
  if (opts[0] === 'decide') {
    const d = decide({ argv: comando, compare: opts.includes('--compare'), covers: String(todos('--covers')[0] || '').split(',').map((s) => s.trim()).filter(Boolean), root: todos('--root')[0] || null });
    if (d.codigo) { process.stderr.write(`[smoke-run] ⛔ ${d.motivo} — no se corre.\n`); process.exit(d.codigo); }
    for (const a of d.avisos || []) process.stderr.write(`${a}\n`);
    process.stdout.write(`${[d.modo, ...(d.raices || [])].join('\n')}\n`);
  } else if (opts[0] === 'exec') {
    exec({ argv: comando, raices: todos('--root') }).then((codigo) => process.exit(codigo));
  } else {
    process.stderr.write('uso: isolated-run.js decide|exec [opciones] -- <comando…>\n');
    process.exit(2);
  }
}
