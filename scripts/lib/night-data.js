'use strict';
// night-data.js — dónde están en esta máquina los datos de la noche, y de cuándo es la copia que se lee.
//
// ── POR QUÉ ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Quien mantiene el arnés usa la versión bajada y tiene dos clones: el del repo público (el código) y el del repo de
// mantenimiento (donde los nocturnos dejan sus datos: `.dashboard/`, `artifacts/`, los reportes del banco). El clon que
// la máquina «mantiene» (`paths.maintained`) es el del público, y no trae esos datos: buscarlos ahí deja a los avisos de
// arranque con una sola línea («el tablero no está publicado») y una pieza muerta se ve igual que una sana. Lo que la
// máquina escribe —el registro de cada merge— no va a ningún clon: queda en su carpeta de estado y viaja por el buzón.
//
// ── DOS REPOS DE DATOS ───────────────────────────────────────────────────────────────────────────────────────────────
// Los nocturnos de la organización (dependencias, vigilante, el resumen diario, las métricas y el tablero) guardan en
// el REPO DE OPERACIONES, no en el de mantenimiento; el banco, las suites y el examen guardan en el de mantenimiento.
// Leer todo del de mantenimiento mostraría la noche anterior y, al día siguiente, «foto vieja» con los nocturnos
// sanos. Por eso hay dos resoluciones:
//   · resolve(ownTree)             → el clon de mantenimiento (`paths.maintainers`): banco, suites y examen;
//   · resolveOperations(ownTree)   → el clon de operaciones (`paths.operations`): dependencias, vigilante, resumen,
//                                    métricas y tablero.
// Una máquina que mantiene el arnés (declara `paths.maintained` o `paths.maintainers`) y no declara el clon de
// operaciones lo oye en una línea, con el comando; una que no mantiene nada (la de un dev) no tiene estos avisos.
//
// ── QUÉ HAY ACÁ ───────────────────────────────────────────────────────────────────────────────────────────────────────
//   · resolve(ownTree)             de qué árbol se LEE la noche del mantenimiento: `{ dir, source, problem }`
//   · resolveOperations(ownTree)   de qué árbol se LEE la noche de operaciones: `{ dir, source, problem }`
//   · machineDashboard(ownTree)    dónde ESCRIBE la máquina lo suyo (el registro de cada merge, en su carpeta de estado)
//                                  y si desde ahí viaja por el buzón; `history`, dónde quedó lo de antes
//   · machineDashboardDirs(ownTree) dónde se LEEN esos registros: la carpeta de estado y la de la historia
//   · readPublished(dir, rel)      un archivo de lo publicado en ese clon (`origin/main`, sin red), o del disco diciéndolo
//   · copyAfter(dir, since)        ¿la rama principal de ese clon se trajo después de `since`? Si no, el texto que lo dice
//
// La tabla de `resolve`:
//   corre desde un clon (no es una versión bajada)        → el árbol propio (`own`), como siempre
//   versión bajada, `paths.maintainers` declarado y sano  → ese clon (`maintainers`): la máquina espera los nocturnos
//   versión bajada, declarado y no sirve                  → nada, y `problem` dice por qué
//   versión bajada, sólo `paths.maintained`               → nada, y `problem` pide declarar el de mantenimiento
//   versión bajada, ninguno de los dos                    → nada y sin `problem`: no mantiene el arnés
//   los nocturnos apagados, o la configuración rota       → nada y sin `problem` (lo segundo ya lo dice su lector, en
//                                                            cada arranque, desde el aviso del banco)
//   no se pudo saber (algo de acá tiró)                    → nada, y `problem` lo dice: «no pude saber» nunca se
//                                                            devuelve con la forma de «esta máquina no mantiene el arnés»
// «Sano» = la raíz de un clon de git que no es el clon del código (`paths.maintained`) ni un clon del repo público (se
// reconoce por su remoto).
//
// ── POR QUÉ NO VIVE EN tycon-home.js ──────────────────────────────────────────────────────────────────────────────────
// A tycon-home.js lo copia el freno de producción a su carpeta protegida, y un cambio suyo le pide a cada máquina que lo
// tiene reinstalarlo con contraseña. Esto no es «dónde vive el arnés»: es dónde vive lo que el arnés LEE de otro repo.
// `maintainedDir()` y `dashboardDir()` de allá quedan para quien compara código contra el clon que se mantiene.
//
// ── QUIÉN TRAE ESOS CLONES ───────────────────────────────────────────────────────────────────────────────────────────────
// Nada de acá sale a la red. La copia la trae quien le haga `git fetch` o `git pull`; cada noche, el aviso de evidencia
// (scripts/ci/nightly-dod-notice.sh) en la máquina que lo tenga programado: trae los dos clones, el de operaciones (de
// donde lee las métricas) y el de mantenimiento. Por eso cada aviso mira de cuándo es su copia
// (`copyAfter`, que lee `FETCH_HEAD` y cuenta sólo una traída de la rama principal): con la foto vencida —o sin foto— y
// el clon sin traer desde antes, lo cierto es «no sé si corrió», no «no corre» ni «no hay foto».
//
// Cada llamador carga este archivo SI ESTÁ a su lado; un hook copiado solo (el banco de controles lo hace) sigue como antes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PUBLISHED = 'refs/remotes/origin/main';
const GIT_MS = 5000;
const SET_COMMAND = 'harness.js config set paths.maintainers <la carpeta de tu clon de mantenimiento>';
const SET_OPERATIONS_COMMAND = 'harness.js config set paths.operations <la carpeta de tu clon del repo de operaciones>';

const HOME_LIB = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
/** tycon-home.js, o `null` si este archivo viaja sin él. 🔴 Si ESTÁ y no carga, tira: lo dice quien llama, no se calla. */
function homeLib() { return fs.existsSync(HOME_LIB) ? require(HOME_LIB) : null; }
/** Un motivo en una línea, sin caracteres de control (va a la pantalla del arranque). */
const clean = (t, max = 240) => String(t === undefined || t === null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);
const reasonOf = (e) => clean((e && e.message) || e, 160);
function git(dir, args, cmd = 'git') {
  return spawnSync(cmd, ['-C', dir, ...args], { encoding: 'utf8', timeout: GIT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };
/**
 * ¿Por qué esa carpeta no sirve como clon de mantenimiento? `null` si sirve. `kept`: el clon que la máquina declara que
 * MANTIENE (`paths.maintained`: el del código), si se sabe.
 */
function unfit(dir, kept = null, key = 'paths.maintainers') {
  const repo = key === 'paths.operations' ? 'el clon del repo de operaciones' : 'el clon del repo de mantenimiento';
  let isRoot = false;
  try { isRoot = fs.existsSync(path.join(dir, '.git')); } catch (_) { isRoot = false; }
  if (!isRoot) return `${key} no es la raíz de un clon de git`;
  // el clon del código declarado en las dos claves: los datos de la noche viven en OTRO clon (y un clon del público con
  // otro remoto —un fork, un alias— no se reconoce por su remoto: por la carpeta, sí)
  if (kept && real(kept) === real(dir)) return `${key} es el mismo clon que paths.maintained (el del código), y los datos de la noche viven en ${repo}`;
  // un clon del repo público no trae los datos de la noche: los dos clones de quien mantiene se cruzan fácil. Se
  // reconoce por su remoto; un clon cuyo remoto no se deja leer (o no tiene) no se puede acusar: pasa.
  const lib = path.join(__dirname, 'harness-repo.js');
  if (!fs.existsSync(lib)) return null;   // sin esa biblioteca al lado no se afirma nada
  try {
    const HR = require(lib);
    const r = HR.resolverRemoto(dir);
    if (r && r.id && HR.esPublicoDeclarado(r.id)) return `${key} apunta a un clon del repo público, que no trae los datos de la noche`;
  } catch (e) { return `no pude mirar de qué repo es el clon de ${key} (${reasonOf(e)})`; }   // «no pude mirar» no es «sirve»
  return null;
}

/** Lo que la máquina declara, sin mirar si espera los nocturnos: `{ dir, declared, problem, maintains }`. */
function declaredClone(TH) {
  const m = typeof TH.maintainersClone === 'function' ? TH.maintainersClone() : { declared: false, path: null, problem: null };
  if (m.declared) {
    const why = m.problem || unfit(m.path, typeof TH.maintainedPath === 'function' ? TH.maintainedPath() : null);
    return { dir: why ? null : m.path, declared: true, problem: why || null };
  }
  if (m.problem) return { dir: null, declared: false, problem: null };   // configuración ilegible: lo dice su lector, no éste
  const maintains = typeof TH.maintainedPath === 'function' ? TH.maintainedPath() : null;
  return { dir: null, declared: false, problem: maintains ? 'esta máquina mantiene un clon del arnés (paths.maintained) y no declara el de mantenimiento (paths.maintainers)' : null };
}

/** ¿Esta máquina espera los resultados de los nocturnos? `true`/`false`, o `null` con la configuración rota. */
function nightliesOn() {
  let cfg;
  try { cfg = require(path.join(__dirname, 'tycon-config.js')); } catch (_) { return true; }   // sin el lector al lado: como siempre
  if (typeof cfg.integracionParaHook !== 'function') return true;
  try { const n = cfg.integracionParaHook('nightly'); return n.ok ? Boolean(n.prendida) : null; } catch (_) { return null; }
}

/**
 * De qué árbol se lee la noche. → `{ dir, source, problem }` (la tabla de la cabecera). `source: 'maintainers'` quiere
 * decir además que la máquina ESPERA los nocturnos: ahí cada aviso habla siempre. Nunca tira.
 * `opts.nightly`: lo que ya sabe quien llama de la llave de los nocturnos (si no, se lee acá).
 */
function resolve(ownTree, opts = {}) {
  const own = { dir: ownTree || null, source: 'own', problem: null };
  const none = { dir: null, source: null, problem: null };
  // 🔴 «No pude saber» se DICE: devuelto como `none` es idéntico a «esta máquina no mantiene el arnés», y los avisos
  // callarían justo cuando algo está roto (el defecto que este archivo vino a sacar).
  const failed = (e) => ({ dir: null, source: null, problem: `no pude saber de qué clon se leen los datos de la noche (${reasonOf(e)})` });
  let TH;
  try { TH = homeLib(); } catch (e) { return failed(e); }
  if (!TH) return own;   // este archivo viaja sin tycon-home.js: el árbol propio, como siempre
  const home = opts.home || os.homedir();
  try {
    if (!TH.isReleaseMachine(home)) return own;
    const on = opts.nightly === undefined ? nightliesOn() : opts.nightly;
    if (!on) return none;
    const c = declaredClone(TH);
    if (c.dir) return { dir: c.dir, source: 'maintainers', problem: null };
    return { dir: null, source: c.declared ? 'maintainers' : null, problem: c.problem };
  } catch (e) { return failed(e); }
}

/**
 * `paths.operations` de la configuración de la máquina: el clon del repo de operaciones. → `{ declared, path, problem }`,
 * con la misma forma que `maintainersClone` de tycon-home.js (que no se toca: ver «POR QUÉ NO VIVE EN tycon-home.js»).
 * Una configuración que no se deja leer es `declared: false` con `problem`. Nunca tira, y `problem` nunca cita el
 * archivo (trae un permiso en texto plano).
 */
function operationsClone(TH, { env = process.env } = {}) {
  const none = (problem = null) => ({ declared: false, path: null, problem });
  let j;
  try { j = JSON.parse(fs.readFileSync(TH.ownPaths({ env }).config, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return none();
    return none('la configuración de la máquina (config.json del arnés) no se puede leer: no sé si declara paths.operations');
  }
  const raw = j && typeof j === 'object' && j.paths && typeof j.paths === 'object' ? j.paths.operations : undefined;
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return none();
  const bad = (problem) => ({ declared: true, path: v, problem });
  if (!path.isAbsolute(v)) return bad('paths.operations no es una ruta absoluta');
  let st = null;
  try { st = fs.statSync(v); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return bad('paths.operations nombra una carpeta que no está');
  return { declared: true, path: v, problem: null };
}

/**
 * De qué árbol se lee lo que los nocturnos guardan en el repo de operaciones (dependencias, vigilante, resumen diario,
 * métricas y tablero). → `{ dir, source, problem }`, con la tabla de `resolve` y `paths.operations` en lugar de
 * `paths.maintainers`. `source: 'operations'` quiere decir que la máquina ESPERA esos nocturnos. Sin clon de operaciones
 * declarado: si la máquina mantiene el arnés (declara `paths.maintained` o `paths.maintainers`), `problem` lo dice; si
 * no, nada (la máquina de un dev no tiene estos avisos). Nunca tira.
 */
function resolveOperations(ownTree, opts = {}) {
  const own = { dir: ownTree || null, source: 'own', problem: null };
  const none = { dir: null, source: null, problem: null };
  const failed = (e) => ({ dir: null, source: null, problem: `no pude saber de qué clon se leen los datos de operaciones (${reasonOf(e)})` });
  let TH;
  try { TH = homeLib(); } catch (e) { return failed(e); }
  if (!TH) return own;
  const home = opts.home || os.homedir();
  try {
    if (!TH.isReleaseMachine(home)) return own;
    const on = opts.nightly === undefined ? nightliesOn() : opts.nightly;
    if (!on) return none;
    const o = operationsClone(TH);
    if (o.declared) {
      const why = o.problem || unfit(o.path, typeof TH.maintainedPath === 'function' ? TH.maintainedPath() : null, 'paths.operations');
      return why ? { dir: null, source: 'operations', problem: why } : { dir: o.path, source: 'operations', problem: null };
    }
    if (o.problem) return none;   // configuración ilegible: lo dice su lector, no éste
    const m = typeof TH.maintainersClone === 'function' ? TH.maintainersClone() : { declared: false };
    const maintains = Boolean(m.declared) || Boolean(typeof TH.maintainedPath === 'function' && TH.maintainedPath());
    return maintains ? { dir: null, source: null, problem: 'esta máquina mantiene el arnés y no declara el clon del repo de operaciones (paths.operations), donde guardan dependencias, vigilante, resumen, métricas y tablero' } : none;
  } catch (e) { return failed(e); }
}

/**
 * La línea que dice un `problem` de `resolve` (o de `resolveOperations`, con `ops`), con el comando que lo arregla. Una
 * por arranque: la dice un solo aviso. `ops`: el problema del clon de operaciones, que va en la MISMA línea.
 */
function problemLine(problem, ops = null) {
  const parts = [];
  if (problem) parts.push({ text: clean(problem), cmd: SET_COMMAND });
  if (ops) parts.push({ text: clean(ops), cmd: SET_OPERATIONS_COMMAND });
  const scope = problem && ops ? 'no puedo leer la noche de ningún nocturno'
    : ops ? 'no puedo leer la noche de dependencias, vigilante ni tablero'
      : 'no puedo leer la noche del banco, las suites ni el examen';
  return `🔴 avisos de los nocturnos: ${parts.map((p) => p.text).join('; ')} — ${scope} · ${parts.map((p) => p.cmd).join(' · ')}`;
}

/**
 * ¿Viaja por el buzón lo que la máquina escribe? Hay llave del buzón legible y no vencida (la de `upload-runs.js`,
 * leída sin salir a la red). → `{ travels, why }`.
 */
function mailboxTravels() {
  const UP = path.join(__dirname, '..', 'metrics', 'upload-runs.js');
  if (!fs.existsSync(UP)) return { travels: false, why: 'no está la subida al buzón (scripts/metrics/upload-runs.js) al lado de este archivo' };
  const U = require(UP);
  const integ = U.integracionBuzon();
  if (integ.error) return { travels: false, why: `la configuración del buzón no se puede leer (${clean(integ.error, 160)})` };
  // sin llave, la integración sale apagada por omisión: se dice lo que falta, la llave
  const c = U.leerConfig();
  if (!c.cfg) return { travels: false, why: clean(c.motivo, 200) };
  if (!integ.prendida) return { travels: false, why: 'la integración del buzón está apagada' };
  // la misma vara que la subida: una llave que ella rechaza siempre tampoco hace viajar nada
  const negativa = typeof U.negativaDeLaLlave === 'function' ? U.negativaDeLaLlave(c.cfg.sas) : null;
  if (negativa) return { travels: false, why: `la subida rechaza la llave del buzón: ${clean(negativa.motivo, 160)}` };
  const vence = String(c.cfg.vence || '').trim();
  const fin = Date.parse(`${vence}T23:59:59Z`);
  if (!Number.isFinite(fin)) return { travels: false, why: `la llave del buzón trae un vencimiento que no se entiende (${clean(vence, 40)})` };
  if (fin < Date.now()) return { travels: false, why: `la llave del buzón venció el ${vence}` };
  return { travels: true, why: null };
}

/**
 * Dónde quedó la historia de los registros de la máquina: la carpeta en la que se escribían antes de la carpeta de
 * estado. En un clon, su `.dashboard`; en una versión bajada, el del clon de mantenimiento que declara (ahí siguen los
 * ya versionados, que no se mudan). → `{ dir, why }`. Sin un clon que sirva, `dir` es `null`; si había uno declarado y
 * no sirve, `why` dice por qué (la historia existe y no se pudo leer, que no es lo mismo que no tenerla).
 */
function historyDir(TH, ownTree, home) {
  if (!TH.isReleaseMachine(home)) return { dir: ownTree ? path.join(ownTree, '.dashboard') : null, why: null };
  const c = declaredClone(TH);
  if (c.dir) return { dir: path.join(c.dir, '.dashboard'), why: null };
  return { dir: null, why: c.declared && c.problem ? `no leo la historia de registros del clon de mantenimiento: ${c.problem}` : null };
}

/**
 * Dónde escribe la máquina lo que es suyo y de nadie más (el registro de cada merge), y dónde lo buscan los que lo leen.
 * → `{ dir, travels, why }`. Siempre la carpeta del estado de la máquina (`<stateDir>/dashboard`), en un clon y en una
 * versión bajada (sólo una copia suelta, sin tycon-home.js al lado, escribe en su árbol de juguete): un archivo escrito en el `.dashboard/` de un clon ensucia ese checkout y nadie lo sube. Viaja por el
 * buzón (upload-runs.js lo sube en cada arranque); `travels: false` = no hay llave que sirva, y `why` dice por qué.
 * 🔴 Si no se puede saber (algo de acá tiró), `dir` es `null` y `why` lo dice: quien escribe NO vuelve en silencio a un
 * `.dashboard/` de un clon; se niega o lo avisa.
 */
function machineDashboard(ownTree, opts = {}) {
  const failed = (e) => ({ dir: null, travels: false, why: `no pude saber dónde escribe esta máquina sus registros (${reasonOf(e)})` });
  let TH;
  try { TH = homeLib(); } catch (e) { return failed(e); }
  const home = opts.home || os.homedir();
  let dir, history = null, historyWhy = null;
  try {
    // este archivo viaja sin tycon-home.js (al banco, a un laboratorio): no hay máquina de la que sea el estado, y
    // escribe en el árbol propio como siempre (un árbol de juguete, no un clon de nadie)
    dir = TH ? path.join(TH.stateDir(home), 'dashboard') : (ownTree ? path.join(ownTree, '.dashboard') : null);
    if (TH) ({ dir: history, why: historyWhy } = historyDir(TH, ownTree, home));
  } catch (e) { return failed(e); }
  if (!dir) return { dir: null, history: null, travels: false, why: 'este archivo viaja sin tycon-home.js y sin árbol propio: no sé dónde escribir' };
  if (history === dir) history = null;
  let t;
  try { t = mailboxTravels(); } catch (e) { t = { travels: false, why: `no pude leer la llave del buzón (${reasonOf(e)})` }; }
  const out = { dir, history, travels: t.travels, why: t.why };
  if (historyWhy) out.historyWhy = historyWhy;
  return out;
}
/**
 * Dónde se LEEN los registros de la máquina: su carpeta de estado y, después, la de la historia (`history`). Quien
 * cuenta merges mira las dos; un registro con el mismo nombre en las dos es uno solo. `[]` = no se pudo saber.
 * Una historia declarada que no se puede leer se avisa por stderr: la cuenta sale sin ella y no se calla.
 */
function machineDashboardDirs(ownTree, opts) {
  const m = machineDashboard(ownTree, opts);
  if (!m.dir && m.why) process.stderr.write(`⚠️ night-data: ${m.why}\n`);
  if (m.historyWhy) process.stderr.write(`⚠️ night-data: ${m.historyWhy}\n`);
  return [m.dir, m.history].filter(Boolean);
}
/** Sólo la carpeta. 🔴 `null` = no se pudo saber: el motivo va por stderr acá, para que ningún lector lo calle. */
function machineDashboardDir(ownTree, opts) {
  const m = machineDashboard(ownTree, opts);
  if (!m.dir && m.why) process.stderr.write(`⚠️ night-data: ${m.why}\n`);
  return m.dir;
}

/**
 * Un archivo del clon, como está PUBLICADO (`origin/main`, sin salir a la red). → `{ state, text, from, why }`:
 * `state`: `ok` | `missing` | `error` · `from`: `published` | `disk` · `why`: por qué se cayó al disco.
 * 🔴 «No está» y «no pude mirar» no son lo mismo: un git que falla manda a leer el disco y lo dice, no contesta «no está».
 */
function readPublished(dir, rel, gitCmd = 'git') {
  const disk = (why) => {
    try { return { state: 'ok', text: fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'), from: 'disk', why }; } catch (e) {
      return { state: e && e.code === 'ENOENT' ? 'missing' : 'error', text: null, from: 'disk', why };
    }
  };
  const failed = (r) => (r.error ? (r.error.code === 'ETIMEDOUT' ? 'git tardó más de 5 s' : 'no se pudo ejecutar git') : null);
  const ref = git(dir, ['rev-parse', '--verify', '--quiet', `${PUBLISHED}^{commit}`], gitCmd);
  if (ref.error || ref.status !== 0) return disk(failed(ref) || 'esta copia no tiene origin/main');
  const ls = git(dir, ['ls-tree', PUBLISHED, '--', rel], gitCmd);
  if (ls.error || ls.status !== 0) return disk(failed(ls) || 'no pude listar lo publicado');
  if (!String(ls.stdout || '').trim()) return { state: 'missing', text: null, from: 'published', why: null };
  const show = git(dir, ['show', `${PUBLISHED}:${rel}`], gitCmd);
  if (show.error || show.status !== 0) return disk(failed(show) || 'no pude leer lo publicado');
  return { state: 'ok', text: String(show.stdout || ''), from: 'published', why: null };
}

/** Una dirección de remoto como la anota git en FETCH_HEAD: sin credenciales, sin la barra ni el `.git` del final. */
const fetchedUrl = (u) => String(u || '').trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1').replace(/[\\/]+$/, '').replace(/\.git$/, '').replace(/[\\/]+$/, '');
/** Las carpetas de git de un clon: la suya y, si es un árbol enlazado, la común. `null` si `.git` no se deja leer. */
function gitDirs(dir) {
  const dot = path.join(dir, '.git');
  try {
    if (fs.statSync(dot).isDirectory()) return { own: dot, common: dot };
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, 'utf8'));
    if (!m) return null;
    const own = path.resolve(dir, m[1]);
    let common = own;
    try { common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch (_) { /* no es un árbol enlazado */ }
    return { own, common };
  } catch (_) { return null; }
}
/**
 * Las direcciones de los OTROS remotos del clon (los que no son `origin`), según su configuración. Vacío si no hay o si
 * no se puede leer. 🔴 Una traída se descarta sólo cuando se reconoce con certeza que es de otro remoto; ante la duda,
 * cuenta. Comparar contra la dirección de `origin` no sirve: git anota en FETCH_HEAD la dirección ya reescrita
 * (`insteadOf`), o escrita de otro modo (`file://`, mayúsculas), y una traída buena de la rama principal no se
 * contaba nunca: los cinco avisos quedaban en «no sé» para siempre.
 */
function otherRemoteUrls(common) {
  try {
    const cfg = fs.readFileSync(path.join(common, 'config'), 'utf8');
    const out = [];
    const re = /\[remote "([^"]+)"\]([^[]*)/g;
    for (let m = re.exec(cfg); m; m = re.exec(cfg)) {
      if (m[1] === 'origin') continue;
      const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(m[2]);
      if (url) out.push(fetchedUrl(url[1]));
    }
    return out;
  } catch (_) { return []; }
}
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const ages = new Map();
/**
 * La última vez que se trajo la RAMA PRINCIPAL del clon: `{ at, failed, unknown }` (`at` en ms, o null).
 * Sale de `FETCH_HEAD`, que git reescribe en cada traída (el propio, el común y el de cada árbol enlazado, del más
 * nuevo al más viejo), leído del disco: sin llamar a git, que puede no contestar.
 * 🔴 Cuenta SÓLO una traída que nombra `branch 'main'` y no es de OTRO remoto del clon. `git fetch origin <otra rama>`, `git pull origin
 *    <rama>` o la traída de la referencia de un pedido reescriben ese archivo con fecha de hoy y NO mueven
 *    `origin/main`, que es lo único que leen los avisos: contadas, la foto vencida de un nocturno sano se acusaría como
 *    «no está corriendo» —justo el error que mirar la copia viene a evitar—. Tampoco cuenta la de otro remoto.
 * 🔴 «Vacío» es «la última traída falló» (git lo vacía antes de conectarse), y lo que no se deja leer es `unknown`:
 *    ninguno de los dos se devuelve como «nunca se trajo».
 */
function copyAge(dir) {
  if (ages.has(dir)) return ages.get(dir);
  const out = { at: null, failed: false, unknown: false };
  ages.set(dir, out);
  const g = gitDirs(dir);
  if (!g) { out.unknown = true; return out; }
  const files = new Set([path.join(g.own, 'FETCH_HEAD'), path.join(g.common, 'FETCH_HEAD')]);
  try { for (const name of fs.readdirSync(path.join(g.common, 'worktrees'))) files.add(path.join(g.common, 'worktrees', name, 'FETCH_HEAD')); } catch (_) { /* sin árboles enlazados */ }
  const found = [];
  for (const f of files) {
    try { found.push({ f, at: fs.statSync(f).mtimeMs }); } catch (e) { if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) out.unknown = true; }
  }
  found.sort((x, y) => y.at - x.at);
  const others = otherRemoteUrls(g.common);
  let newest = true;
  for (const { f, at } of found) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { out.unknown = true; newest = false; continue; }
    if (!text.trim()) { if (newest) out.failed = true; newest = false; continue; }
    newest = false;
    const broughtMain = text.split('\n').some((l) => {
      const m = /\tbranch '([^']+)' of (.+?)\s*$/.exec(l);
      return Boolean(m) && m[1] === 'main' && !others.includes(fetchedUrl(m[2]));
    });
    if (!broughtMain) continue;
    if (at > Date.now() + FUTURE_SLACK_MS) { out.unknown = true; continue; }   // una fecha del futuro no dice cuándo se trajo
    out.at = at;
    break;
  }
  return out;
}
/**
 * ¿La rama principal del clon se trajo después de `since` (ms)? → `null` si sí. Si no, o si no se sabe, el texto que
 * lo dice: con él, una foto vencida (o que falta) no prueba que el nocturno no corrió.
 */
function copyAfter(dir, since, clone = 'el clon de mantenimiento') {
  const c = copyAge(dir);
  if (c.at && c.at > since) return null;
  const of = clone.replace(/^el /, 'del ');
  if (c.at) return `la copia ${of} es del ${new Date(c.at).toISOString().slice(0, 10)}`;
  if (c.failed) return `la última traída ${of} falló`;
  if (c.unknown) return `no pude leer cuándo se trajo ${clone}`;
  return `no consta ninguna traída de la rama principal ${of}`;
}
/** El nombre del clon según de dónde se leyó (`source` de `resolve` o `resolveOperations`). */
const cloneName = (source) => (source === 'operations' ? 'el clon de operaciones' : 'el clon de mantenimiento');
/** ¿Consta que la rama principal se trajo, y hace más de `ms`? (para decir cómo traerla aunque quien pregunta esté al día) */
function copyOlderThan(dir, ms, now = Date.now()) {
  const c = copyAge(dir);
  return Boolean(c.at) && c.at <= now - ms;
}
/** La foto que menos dura (banco, suites y tablero): con la copia más vieja que esto, alguno ya dice «no sé». */
const SHORTEST_PHOTO_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * El renglón que dice cómo traer la copia. Se dice una vez por arranque. La ruta va entre comillas (se copia y se pega:
 * con espacios quedaría rota) y sin caracteres de control; si trae una comilla, una barra invertida, un `$` o un acento
 * grave, no se arma un comando para pegar: se nombra la carpeta.
 */
function fetchHint(dir) {
  const d = clean(dir, 400);
  return /["\\$`]/.test(d) ? `   Para traerla: git fetch origin, parado en ${d}` : `   Para traerla: git -C "${d}" fetch origin`;
}

module.exports = { PUBLISHED, SET_COMMAND, SET_OPERATIONS_COMMAND, SHORTEST_PHOTO_LIFE_MS, resolve, resolveOperations, operationsClone, cloneName, problemLine, machineDashboard, machineDashboardDir, machineDashboardDirs, readPublished, copyAge, copyAfter, copyOlderThan, fetchHint, unfit, clean };

if (require.main === module) {
  // a mano, o desde un guion de shell: `node scripts/lib/night-data.js [--plain] [--operations]` dice de qué árbol se lee
  // la noche (con `--operations`, la del repo de operaciones; sin él, la del de mantenimiento)
  const own = path.resolve(__dirname, '..', '..');
  const r = process.argv.includes('--operations') ? resolveOperations(own) : resolve(own);
  if (process.argv.includes('--plain')) {
    if (r.dir) process.stdout.write(`${r.dir}\n`);
    else { process.stderr.write(`${r.problem || 'esta máquina no tiene de dónde leer los datos de la noche'}\n`); process.exitCode = 2; }
  } else process.stdout.write(`${JSON.stringify({ ...r, machine: machineDashboard(own) }, null, 2)}\n`);
}
