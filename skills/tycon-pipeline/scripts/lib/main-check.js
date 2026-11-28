#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * main-check.js — el juez de la punta de main: un rojo que la foto nocturna y la base no perdonaron se mide sobre la
 * última versión de `origin/main`. Si main falla igual, el rojo es de main y la corrida espera; si main pasa, es de la
 * historia; si no se pudo medir, también es de la historia («no sé» no pone a nadie a esperar).
 *
 * Es el tercer juez de lib/inherited-reds.js, y corre sólo cuando quien llama lo pide (`TYCON_MAIN_CHECK=1`, que pone el
 * portón de pruebas): corrido a mano, `apply` juzga como antes.
 *
 * Qué hace `judge`:
 *   · trae `origin/main` (`git fetch`) y mide cada suite roja en UNA copia de main por repo y máquina,
 *     `<repo principal>--main-check` (hermana del clon principal, `git worktree add --detach`), que se reusa: se pone en
 *     la punta traída (`checkout --detach` + `clean -fdx` salvo `node_modules`) y no se borra (se crea bloqueada con
 *     `git worktree lock`: la barrida diaria de carpetas de trabajo no toca una carpeta bloqueada). Nunca la copia del
 *     merge (`--merge`) ni el checkout de una sesión. Si el árbol que se mide está en esa punta y sin cambios, el rojo
 *     del portón ya es el de main: no se corre nada.
 *   · corre cada suite con el mismo corredor y el mismo tope que la base (run-suites-json.js dentro de run-capped.js),
 *     con el entorno sin TYCON_SKILLS_DIR ni TYCON_MAIN_CHECK (una suite que corre un portón de juguete adentro no prende
 *     un juez anidado): salida 0 → verde en main; 1 con la suite en las fallas → roja en main, con sus casos; el tope o
 *     cualquier otra cosa → no medida. Topes: TYCON_MAIN_CHECK_MAX suites por corrida (3; 0 apaga el juez) y
 *     TYCON_MAIN_CHECK_TIMEOUT_S segundos por suite (600).
 *   · guarda el RESULTADO de main, no el veredicto, en `<estado>/main-check/<clave del repo>.json`, sección `results`,
 *     por sha y suite, con quién lo midió y cuándo. Otra sesión con la misma suite y el mismo sha no corre nada: calcula
 *     su propio veredicto contra ese resultado. Un «no se pudo medir» no se guarda.
 *   · el veredicto por suite: `main-falla` (roja en main y todos los casos rojos de la historia están rojos en main; por
 *     caso con las dos listas completas, si no por suite y lo dice), `main-pasa` (verde en main, o con casos rojos de la
 *     historia que main no tiene) o `no-se` (con su motivo).
 *   · el archivo lleva además la sección `broken`: el registro de main roto del repo (a lo sumo uno abierto), con las
 *     sesiones que esperan y quién lo arregla. Lo crea o amplía `broken.join` (lo llama marker.js al anotar la espera);
 *     lo cierra este juez cuando `results` trae todas sus suites verdes en una punta más nueva.
 *
 * Candados: el del archivo (`<clave>.lock`) y el de la copia (`<clave>--copy.lock`) guardan pid, sesión y hora. Uno de
 * un proceso que ya no vive, o sin señales de vida en su plazo (30 s el del archivo; 15 min el de la copia, que quien
 * mide toca antes de cada suite), se rompe y se dice. La copia ocupada por otra medición viva se espera hasta
 * TYCON_MAIN_CHECK_LOCK_WAIT_S (900); pasado eso, `no-se` «otra sesión está midiendo main».
 *
 * CLI:  node main-check.js status --repo <repo> [--json]
 *   Sin correr nada: la última punta medida, cada suite con su resultado y quién la midió, y el registro de main roto,
 *   abierto o cerrado. Sale 0; 1 si el repo no es git; 2 con un pedido mal hecho.
 *       node main-check.js wait --repo <repo> --id <id>
 *   La espera de fondo (`wait`, abajo): sale 0 cuando main pasó, 3 pasado su tope, 2 sin ese registro.
 *       node main-check.js branch-check --repo <repo> --id <id>
 *   Dice si main ya pasó y esta rama no lo trae; si no, no imprime nada. Sale 0.
 *       node main-check.js fix --repo <repo> --id <id> --session <sesión> [--pr <n>]
 *   Anota quién arregla main (`fix`, abajo): sale 0; 1 si ya lo tiene otra sesión o el registro se cerró; 2 sin él.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, 'run-suites-json.js');
// El corte por tope es el del repo de este guion, como en la base: los árboles que se miden no siempre lo traen.
const RUN_CAPPED = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'ci', 'run-capped.js');
// Cuántos casos trae failedCases de run-suites-json.js (su MAX_CASES): con la lista llena faltan casos.
const CASE_CAP = 40;
const KEPT_SHAS = 5;
const FILE_LOCK_STALE_MS = 30 * 1000;
const FILE_LOCK_WAIT_MS = 10 * 1000;
const COPY_LOCK_STALE_MS = 15 * 60 * 1000;
const COPY_LOCK_POLL_MS = 2000;
const LOCK_EMPTY_GRACE_MS = 5000;
const DEFAULTS = { max: 3, timeout: 600, lockWait: 900, fetchTimeout: 120 };

const g = (dir, ...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { windowsHide: true, encoding: 'utf8' });
const lastLine = (r) => String((r && (r.stderr || r.stdout)) || '').trim().split('\n').pop().slice(0, 200);
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin espera: se sondea seguido */ } };
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '??:??' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const shortSid = (s) => String(s || 'sin sesión').slice(0, 8);
const realpath = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
const pathOf = (f) => (f && f.entrada && typeof f.entrada.ruta === 'string' ? f.entrada.ruta : null);

/** Un tope leído de la variable `key` (su valor en `v`); uno que no es un entero ≥ 0 vale el de por defecto y se dice. */
function intEnv(v, key, fallback, warnings) {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0) return n;
  if (warnings) warnings.push(`${key}=${v} no es un entero ≥ 0: uso ${fallback}`);
  return fallback;
}

function stateRoot(home) {
  return path.join(require('./state-dir.js').stateDir(home || os.homedir()), 'main-check');
}
function sessionOf() {
  try { return require('./session-id.js').resolveSessionId(); } catch (_) { return process.env.CLAUDE_CODE_SESSION_ID || '_nosession'; }
}

/** La carpeta del clon principal del repo (la del `.git` común): un worktree y su principal son el mismo repo. */
function mainRepoOf(tree) {
  const r = g(tree, 'rev-parse', '--git-common-dir');
  if (r.status !== 0) return null;
  const common = r.stdout.trim();
  if (!common) return null;
  return realpath(path.dirname(path.isAbsolute(common) ? common : path.resolve(tree, common)));
}

/** La clave del repo: el nombre del principal y una huella corta de su ruta real. */
function repoKey(mainRepo) {
  return `${path.basename(mainRepo)}-${crypto.createHash('sha256').update(realpath(mainRepo)).digest('hex').slice(0, 8)}`;
}

function statePaths(mainRepo, home) {
  const dir = stateRoot(home);
  const key = repoKey(mainRepo);
  return { dir, key, file: path.join(dir, `${key}.json`), lock: path.join(dir, `${key}.lock`), copyLock: path.join(dir, `${key}--copy.lock`), copy: `${mainRepo}--main-check` };
}

// ── candados ────────────────────────────────────────────────────────────────────────────────────────────────────────

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
/** Un candado está vencido si su proceso no vive o si no dio señales de vida en `staleMs`. */
function lockStale(held, staleMs) {
  if (!held || typeof held !== 'object') return 'ilegible';
  if (!alive(Number(held.pid))) return `su proceso (pid ${held.pid}) ya no vive`;
  const t = Date.parse(held.touched || held.since);
  if (!Number.isFinite(t)) return 'sin hora legible';
  if (Date.now() - t > staleMs) return `sin señales de vida desde las ${hhmm(held.touched || held.since)}`;
  return null;
}
/**
 * Toma el candado `file`: `{ ok: true, broke }` (con `broke`, el motivo del candado roto que encontró), o
 * `{ ok: false, held, motivo }` si otro proceso vivo lo tiene y pasó `waitMs`.
 */
function takeLock(file, { staleMs, waitMs, pollMs, session }) {
  const deadline = Date.now() + waitMs;
  let broke = null;
  for (;;) {
    // el candado nace con su contenido: se escribe aparte y se enlaza (falla si ya está), así nadie lo lee vacío
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, session, since: now, touched: now }));
      fs.linkSync(tmp, file);
      return { ok: true, broke };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, held: null, motivo: `no pude escribir el candado (${e.message})` };
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* no llegó a existir */ }
    }
    const held = readLock(file);
    // uno que no se deja leer puede ser de otro guion que lo está escribiendo: se rompe sólo si ya es viejo
    let edad = Infinity;
    try { edad = Date.now() - fs.statSync(file).mtimeMs; } catch (_) { /* ya no está: la vuelta siguiente lo toma */ }
    const stale = !held && edad < LOCK_EMPTY_GRACE_MS ? null : lockStale(held, staleMs);
    if (stale) {
      try { fs.unlinkSync(file); } catch (_) { /* otro lo rompió primero */ }
      broke = `candado de ${held ? `la sesión ${shortSid(held.session)}` : 'nadie'} roto: ${stale}`;
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, held, motivo: held ? `otra sesión está midiendo main (${shortSid(held.session)}, desde las ${hhmm(held.since)})` : 'otra sesión está tomando el candado de main (todavía no se deja leer)' };
    sleep(pollMs);
  }
}
function touchLock(file) {
  const held = readLock(file);
  if (held && held.pid === process.pid) { try { fs.writeFileSync(file, JSON.stringify({ ...held, touched: new Date().toISOString() })); } catch (_) { /* la próxima señal */ } }
}
function releaseLock(file) {
  const held = readLock(file);
  if (held && held.pid === process.pid) { try { fs.unlinkSync(file); } catch (_) { /* ya no estaba */ } }
}

// ── el archivo de estado ────────────────────────────────────────────────────────────────────────────────────────────

const emptyState = (mainRepo) => ({ repo: mainRepo, results: {}, broken: [], next_id: 1 });

/**
 * El archivo de estado del repo. Sin archivo, el estado vacío. Uno que está y no se deja leer trae `unreadable` con el
 * motivo: no es «no hay nada», y nadie lo pisa (`updateState` se niega).
 */
function readState(paths, mainRepo) {
  let text;
  try { text = fs.readFileSync(paths.file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? emptyState(mainRepo) : { ...emptyState(mainRepo), unreadable: errLine(e) };
  }
  let s;
  try { s = JSON.parse(text); } catch (e) { return { ...emptyState(mainRepo), unreadable: errLine(e) }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ...emptyState(mainRepo), unreadable: 'no es un objeto' };
  return { ...emptyState(mainRepo), ...s, results: s.results && typeof s.results === 'object' ? s.results : {}, broken: Array.isArray(s.broken) ? s.broken : [] };
}
/**
 * Lee, cambia y guarda el archivo bajo su candado. `fn(state)` cambia UNA sección (relee lo demás tal como está, así una
 * escritura nunca pisa la otra sección); devuelve lo que `fn` devuelva. Lanza si no pudo tomar el candado, si el archivo
 * no se deja leer (no lo pisa) o si no pudo escribir.
 */
function updateState(paths, mainRepo, session, fn) {
  const lock = takeLock(paths.lock, { staleMs: FILE_LOCK_STALE_MS, waitMs: FILE_LOCK_WAIT_MS, pollMs: 50, session });
  if (!lock.ok) throw new Error(`no pude tomar el candado del archivo de main-check (${lock.motivo})`);
  try {
    const state = readState(paths, mainRepo);
    if (state.unreadable) throw new Error(`el archivo de main-check ${paths.file} no se deja leer (${state.unreadable}): no lo piso; arreglalo o borralo a conciencia`);
    const out = fn(state);
    const tmp = `${paths.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, paths.file);
    return { out, broke: lock.broke };
  } finally {
    releaseLock(paths.lock);
  }
}

// Un resultado medido con el medidor de cobertura se guarda aparte del medido sin él: el medidor hace más lenta una suite
// y una que depende del tiempo puede pasar sin él y fallar con él (issue #1855). Se compara con lo de la misma condición.
const SUFIJO_COBERTURA = ' (con cobertura)';
const claveDe = (ruta, coverage) => (coverage ? `${ruta}${SUFIJO_COBERTURA}` : ruta);
/**
 * ¿La suite del registro `rec` pasó en `at` (los resultados de una punta)? En la condición con que falló (`rec.cobertura`,
 * que anota `join`); un registro de antes, sin esa anotación, acepta el verde de cualquiera de las dos.
 */
const verdeEn = (at, ruta, rec) => {
  const claves = rec && rec.cobertura ? [claveDe(ruta, rec.cobertura[ruta] === true)] : [ruta, `${ruta}${SUFIJO_COBERTURA}`];
  return claves.some((k) => at[k] && at[k].estado === 'verde');
};

/** Guarda los resultados de main de `sha` (`{ [ruta]: { estado, casos, casos_completos } }`) y poda los sha viejos. */
function saveResults(state, sha, measured, session) {
  const at = new Date().toISOString();
  state.results[sha] = state.results[sha] || {};
  for (const [ruta, r] of Object.entries(measured)) state.results[sha][ruta] = { ...r, at, session };
  const shas = Object.keys(state.results).sort((a, b) => latestAt(state.results[b]) - latestAt(state.results[a]));
  for (const old of shas.slice(KEPT_SHAS)) delete state.results[old];
}
const latestAt = (bySuite) => Math.max(0, ...Object.values(bySuite || {}).map((r) => Date.parse(r && r.at) || 0));
// `nuevo` desciende de `viejo` en el repo de `tree`; sin poder comprobarlo, no
const masNuevaEn = (tree) => (viejo, nuevo) => g(tree, 'merge-base', '--is-ancestor', viejo, nuevo).status === 0;

/** El registro abierto de main roto, o null. */
const openRecord = (state) => state.broken.find((r) => r && !r.closed) || null;

/**
 * Cierra el registro abierto si en `results[sha]` todas sus suites están verdes y `sha` es otra punta que la suya y más
 * nueva (`esMasNueva(viejo, nuevo)`; sin ella, cualquier otra). Una punta más vieja que la del registro no lo cierra: un
 * juicio que trajo main antes del commit que lo rompió y guardó tarde diría «main pasó» con main roto. Devuelve el
 * registro cerrado o null.
 */
function closeIfGreen(state, sha, { esMasNueva } = {}) {
  const rec = openRecord(state);
  if (!rec || !sha || rec.sha === sha) return null;
  if (esMasNueva && rec.sha && !esMasNueva(rec.sha, sha)) return null;
  const at = state.results[sha] || {};
  if (!(rec.suites || []).every((ruta) => verdeEn(at, ruta, rec))) return null;
  rec.closed = new Date().toISOString();
  rec.closedSha = sha;
  return rec;
}

// ── la copia de main ────────────────────────────────────────────────────────────────────────────────────────────────

/** Pone la copia en `sha`: la crea si no está, la reusa si está. `{ ok, dir, created }` o `{ ok: false, motivo }`. */
function prepareCopy(tree, paths, sha) {
  const dir = paths.copy;
  const isTree = fs.existsSync(dir) && g(dir, 'rev-parse', '--is-inside-work-tree').status === 0
    && realpath(g(dir, 'rev-parse', '--show-toplevel').stdout.trim() || dir) === realpath(dir);
  if (fs.existsSync(dir) && !isTree) {
    if (fs.readdirSync(dir).length) return { ok: false, motivo: `la carpeta de la copia existe y no es un árbol de git (${dir})` };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let created = false;
  if (!isTree) {
    g(tree, 'worktree', 'prune');
    const wt = g(tree, 'worktree', 'add', '--detach', '--quiet', dir, sha);
    if (wt.status !== 0) return { ok: false, motivo: `no se pudo armar la copia de main (${lastLine(wt)})` };
    // bloqueada: la barrida diaria de carpetas de trabajo nunca toca una carpeta bloqueada, y la copia se reusa por días
    g(tree, 'worktree', 'lock', '--reason', 'copia de main del juez de la punta de main: se reusa, no se borra', dir);
    created = true;
  } else {
    const co = g(dir, 'checkout', '--quiet', '--force', '--detach', sha);
    if (co.status !== 0) return { ok: false, motivo: `no pude poner la copia en la punta de main (${lastLine(co)})` };
    const cl = g(dir, 'clean', '-fdxq', '-e', 'node_modules');
    if (cl.status !== 0) return { ok: false, motivo: `no pude limpiar la copia de main (${lastLine(cl)})` };
  }
  return { ok: true, dir, created };
}

/** Las entradas de suites.json de una raíz: `{ entries }`, `{ entries: [] }` si no hay archivo, o `{ error }`. */
function suitesOf(root) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'tests', 'suites.json'), 'utf8'));
    return { entries: [...(d.diarias || []), ...(d.semanales || [])] };
  } catch (e) { return e.code === 'ENOENT' ? { entries: [] } : { error: e.message }; }
}

/** Corre una suite en la copia: `{ estado: 'verde' }`, `{ estado: 'roja', casos, casos_completos }` o `{ error }`. */
function runInCopy(copyRoot, ruta, { timeout, workDir, i, coverage = false }) {
  const out = path.join(workDir, `main-${i}.json`);
  const mark = path.join(workDir, `cap-${i}`);
  // las skills de main, no las del cambio: el corredor lee la variable antes que el clon; y sin la variable del juez, para
  // que una suite que corre un portón de juguete adentro no prenda un juez anidado
  const env = { ...process.env };
  delete env.TYCON_SKILLS_DIR;
  delete env.TYCON_MAIN_CHECK;
  // con el medidor de cobertura si la rama se midió con él: main se mide en las mismas condiciones (issue #1855). Sin él,
  // tampoco el que llega heredado del ambiente (`NODE_V8_COVERAGE` de quien corre el portón): mediría main con el medidor
  const cobertura = coverage ? ['--coverage', path.join(workDir, `cov-${i}`)] : [];
  // (vacía, no borrada: Node se la vuelve a poner a un hijo cuyo ambiente no la trae)
  if (!coverage) env.NODE_V8_COVERAGE = '';
  const r = spawnSync(process.execPath, [RUN_CAPPED, '--seconds', String(timeout), '--mark', mark, '--', process.execPath, RUNNER, copyRoot, out, '--suite', ruta, ...cobertura],
    { windowsHide: true, cwd: copyRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (timeout + 60) * 1000 });
  if (fs.existsSync(mark)) return { error: `pasó el tope de ${timeout} s` };
  if (r.status === 0) return { estado: 'verde' };
  if (r.status === 1) {
    let roja = null;
    try { roja = (JSON.parse(fs.readFileSync(out, 'utf8')).fallas || []).find((x) => pathOf(x) === ruta) || null; } catch (_) { roja = null; }
    if (roja) {
      const casos = Array.isArray(roja.casos) ? roja.casos.map(String) : [];
      return { estado: 'roja', casos, casos_completos: casos.length > 0 && casos.length < CASE_CAP };
    }
  }
  const how = r.error ? r.error.message : (r.signal ? `cortada por ${r.signal}` : `salió ${r.status}`);
  return { error: `en main la suite ${how} sin dar un rojo legible` };
}

// ── el veredicto ────────────────────────────────────────────────────────────────────────────────────────────────────

/** El veredicto de una falla de la historia contra el resultado de main de su suite (nunca se guarda). */
function verdictOf(falla, result) {
  if (result.estado === 'verde') return { verdict: 'main-pasa', motivo: 'main pasa: el rojo es de la historia' };
  // la misma comparación por caso que el juez de la base (require acá: inherited-reds.js carga este archivo)
  let comp;
  try { comp = require('./inherited-reds.js').casosNuevos(falla, { casos: result.casos }); } catch (e) { comp = { nuevos: null, porque: `no cargó la comparación por caso (${e.message})` }; }
  if (comp.nuevos && comp.nuevos.length) return { verdict: 'main-pasa', motivo: `roja también en main, pero con caso(s) nuevo(s) de la historia: ${comp.nuevos.join(' · ')}` };
  return { verdict: 'main-falla', motivo: comp.nuevos ? 'main falla igual, con los mismos casos' : `main falla igual (se juzgó por suite: ${comp.porque})` };
}

/**
 * El juez. `fallas` y `ausentes` son los del resumen de run-suites-json.js que quedaron rojos después de la foto y la
 * base. Devuelve `{ sha, at, suites: [{ ruta, raiz, casos, verdict, motivo, measuredBy, measuredAt }], lines }`: `lines`
 * son los avisos (un candado roto, el registro cerrado).
 */
// `atajo`: si el árbol medido está en la punta y sin cambios, el rojo del portón es el de main (vale cuando el portón acaba
// de correr esas suites en ese árbol). `wait` lo apaga: sus fallas no salen de una corrida de ahora.
function judge({ tree, fallas = [], ausentes = [], assembled = false, max = DEFAULTS.max, timeout = DEFAULTS.timeout, lockWait, fetchTimeout, session, home, atajo = true, coverage = false } = {}) {
  const at = new Date().toISOString();
  const lines = [];
  const suites = [];
  const sid = session || sessionOf();
  const warn = [];
  const waitS = lockWait !== undefined ? lockWait : intEnv(process.env.TYCON_MAIN_CHECK_LOCK_WAIT_S, 'TYCON_MAIN_CHECK_LOCK_WAIT_S', DEFAULTS.lockWait, warn);
  const fetchS = fetchTimeout !== undefined ? fetchTimeout : intEnv(process.env.TYCON_MAIN_CHECK_FETCH_TIMEOUT_S, 'TYCON_MAIN_CHECK_FETCH_TIMEOUT_S', DEFAULTS.fetchTimeout, warn) || DEFAULTS.fetchTimeout;
  lines.push(...warn);
  const noSe = (f, motivo) => suites.push({ ruta: pathOf(f) || String(f && f.ruta), raiz: (f && f.entrada && f.entrada.raiz) || null, casos: Array.isArray(f && f.casos) ? f.casos : [], verdict: 'no-se', motivo: `no se pudo medir main: ${motivo}` });
  const done = (sha) => {
    for (const a of ausentes) suites.push({ ruta: String(a), raiz: null, casos: [], verdict: 'no-se', motivo: 'no se pudo medir main: la suite no existe en el cambio' });
    return { sha, at, suites, lines };
  };
  const all = (motivo) => { for (const f of fallas) noSe(f, motivo); return done(null); };

  if (assembled) return all('el árbol armado del privado mezcla dos repos');
  if (!fallas.length) return done(null);
  const mainRepo = mainRepoOf(tree);
  if (!mainRepo) return all('el árbol no es un repo de git');
  const fetch = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', tree, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    { windowsHide: true, encoding: 'utf8', timeout: fetchS * 1000 });
  if (fetch.status !== 0) return all(`no pude traer origin/main (${fetch.error ? fetch.error.message : lastLine(fetch) || `git salió ${fetch.status}`})`);
  const rev = g(tree, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}');
  const sha = rev.status === 0 ? rev.stdout.trim() : '';
  if (!sha) return all('no hay origin/main después de traerlo');
  const paths = statePaths(mainRepo, home);

  const medibles = [];
  for (const f of fallas) {
    if (!pathOf(f)) noSe(f, 'la falla no trae su entrada de suites.json');
    else if (medibles.length < max) medibles.push(f);
    else noSe(f, `pasó del tope de ${max} suites`);
  }
  if (!medibles.length) return done(sha);

  // Lo guardado de esta punta vale para todos: se mide sólo lo que falta.
  const cached = (readState(paths, mainRepo).results || {})[sha] || {};
  const results = {};
  const toMeasure = [];
  for (const f of medibles) {
    const ruta = pathOf(f);
    if (cached[claveDe(ruta, coverage)]) results[ruta] = { ...cached[claveDe(ruta, coverage)], cached: true };
    else toMeasure.push(f);
  }

  const measured = {};
  const errors = {};
  if (toMeasure.length) {
    const head = g(tree, 'rev-parse', 'HEAD').stdout.trim();
    const dirty = g(tree, 'status', '--porcelain');
    if (atajo && head === sha && dirty.status === 0 && !dirty.stdout.trim()) {
      // el árbol ES la punta de main, sin cambios: el rojo del portón es el de main
      for (const f of toMeasure) {
        const casos = Array.isArray(f.casos) ? f.casos.map(String) : [];
        measured[pathOf(f)] = { estado: 'roja', casos, casos_completos: casos.length > 0 && casos.length < CASE_CAP, how: 'el árbol medido es la punta de main' };
      }
    } else if (!fs.existsSync(RUN_CAPPED)) {
      for (const f of toMeasure) errors[pathOf(f)] = `falta ${RUN_CAPPED}`;
    } else {
      const lock = takeLock(paths.copyLock, { staleMs: COPY_LOCK_STALE_MS, waitMs: waitS * 1000, pollMs: COPY_LOCK_POLL_MS, session: sid });
      if (lock.broke) lines.push(`main-check: ${lock.broke}`);
      if (!lock.ok) {
        for (const f of toMeasure) errors[pathOf(f)] = lock.motivo;
      } else {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'main-check-'));
        try {
          const copy = prepareCopy(tree, paths, sha);
          if (!copy.ok) {
            for (const f of toMeasure) errors[pathOf(f)] = copy.motivo;
          } else {
            if (copy.created) lines.push(`main-check: copia de main armada en ${copy.dir} (se reusa en las próximas mediciones)`);
            // el árbol que se mide puede ser una subcarpeta del repo: en la copia, la misma
            const prefix = g(tree, 'rev-parse', '--show-prefix').stdout.trim();
            const copyRoot = prefix ? path.join(copy.dir, prefix) : copy.dir;
            const list = suitesOf(copyRoot);
            toMeasure.forEach((f, i) => {
              const ruta = pathOf(f);
              const raiz = f.entrada.raiz || null;
              if (list.error) { errors[ruta] = `la lista de suites de main no se deja leer (${list.error})`; return; }
              if (!list.entries.some((s) => s && s.ruta === ruta && (s.raiz || null) === raiz)) { errors[ruta] = 'la suite no está en main'; return; }
              touchLock(paths.copyLock);
              const r = runInCopy(copyRoot, ruta, { timeout, workDir: work, i, coverage });
              if (r.error) errors[ruta] = r.error;
              else measured[ruta] = r;
            });
          }
        } finally {
          fs.rmSync(work, { recursive: true, force: true });
          releaseLock(paths.copyLock);
        }
      }
    }
  }

  // Lo medido se guarda (lo que no se pudo, no), y con la punta nueva el registro abierto se cierra si todo pasa. Sin nada
  // nuevo que guardar, también: el registro puede tener todas sus suites ya en verde en esta punta, guardadas por otra
  // sesión antes de que el registro se abriera.
  const cierraConLoGuardado = () => {
    const st = readState(paths, mainRepo);
    const rec = openRecord(st);
    return Boolean(rec && rec.sha !== sha && (rec.suites || []).length && rec.suites.every((r) => verdeEn(st.results[sha] || {}, r, rec)));
  };
  if (Object.keys(measured).length || cierraConLoGuardado()) {
    try {
      const { out, broke } = updateState(paths, mainRepo, sid, (state) => {
        if (Object.keys(measured).length) saveResults(state, sha, Object.fromEntries(Object.entries(measured).map(([ruta, r]) => [claveDe(ruta, coverage), r])), sid);
        return closeIfGreen(state, sha, { esMasNueva: masNuevaEn(tree) });
      });
      if (broke) lines.push(`main-check: ${broke}`);
      if (out) {
        lines.push(`main-check: main pasó: ${sha.slice(0, 10)} — el registro ${out.id} se cierra`);
        const fila = cerrarFila(out, home);
        if (fila) lines.push(fila);
      }
      for (const [ruta, r] of Object.entries(measured)) results[ruta] = { ...r, at: new Date().toISOString(), session: sid, cached: false };
    } catch (e) {
      lines.push(`main-check: medí main pero no pude guardar el resultado (${e.message}): la próxima corrida vuelve a medir`);
      for (const [ruta, r] of Object.entries(measured)) results[ruta] = { ...r, at: new Date().toISOString(), session: sid, cached: false };
    }
  }

  for (const f of medibles) {
    const ruta = pathOf(f);
    const raiz = f.entrada.raiz || null;
    const casos = Array.isArray(f.casos) ? f.casos : [];
    if (errors[ruta]) { suites.push({ ruta, raiz, casos, verdict: 'no-se', motivo: `no se pudo medir main: ${errors[ruta]}` }); continue; }
    const r = results[ruta];
    const v = verdictOf(f, r);
    const con = coverage ? ', con el medidor de cobertura' : '';
    const who = r.cached ? ` (main medido por ${shortSid(r.session)} a las ${hhmm(r.at)}${con})` : (r.how ? ` (${r.how})` : (con ? ` (${con.slice(2)})` : ''));
    suites.push({ ruta, raiz, casos, verdict: v.verdict, motivo: `${v.motivo}${who}`, measuredBy: r.session || sid, measuredAt: r.at || at, cached: !!r.cached });
  }
  return done(sha);
}

// ── el registro de main roto ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Crea el registro de main roto del repo o suma a él: `suites` son `[{ ruta, raiz, casos }]` de main-falla. Hay a lo
 * sumo uno abierto: una corrida cuyas suites ya están se suma a `waiting`; una con suites nuevas las agrega (mismo id);
 * un sha distinto (la punta medida ahora) mueve el del registro. Un rojo después de uno cerrado abre otro. Devuelve el
 * registro y, si lo hubo, el aviso del candado roto.
 */
// ── el tablero de la oficina ────────────────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BOARD = path.join(ROOT, 'scripts', 'tools', 'office', 'board.js');
const boardStateDir = (home) => require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home || os.homedir());
const errLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const tituloDeFila = (mainRepo, rec) => `Arreglar main en ${path.basename(mainRepo)} (${rec.id}): ${(rec.suites || []).map((r) => path.basename(String(r))).join(', ')}`;

/**
 * La fila del registro en el tablero, sólo con una coordinadora designada y viva (heavy-turn.js `coordinator`): una por
 * `id`, que se suma una vez (board.js `add`, estado `riesgo`) y cuyo número queda en el registro; si el registro se
 * amplía, esa fila, por su número, cambia el título. El `id` en el título la hace única entre las abiertas: una fila
 * cerrada de un registro viejo no se toca. Corre bajo el candado del archivo de estado: primero ése, después el del
 * tablero. Devuelve el aviso de un fallo, o null; un fallo no frena la espera.
 */
function filaDelTablero(rec, mainRepo, { home, cambio }) {
  if (rec.fila && !cambio) return null;
  let B;
  let sdir;
  try {
    const ht = require(HEAVY_TURN);
    if (typeof ht.coordinator !== 'function' || !ht.coordinator({ home: home || os.homedir(), env: process.env })) return null;
    B = require(BOARD);
    sdir = boardStateDir(home);
  } catch (e) { return `main-check: no pude ver si hay coordinadora (${errLine(e)}): el tablero no se toca`; }
  const titulo = tituloDeFila(mainRepo, rec);
  try {
    if (rec.fila) {
      const r = B.set(sdir, rec.fila, [`titulo=${titulo}`], { home: home || os.homedir() });
      return r.code === 0 ? null : `main-check: no pude cambiar la fila ${rec.fila} del tablero (${(r.lines || [])[0] || `salió ${r.code}`})`;
    }
    const r = B.add(sdir, [`titulo=${titulo}`, 'estado=riesgo'], { home: home || os.homedir() });
    if (r.code !== 0) return `main-check: no pude sumar la fila de ${rec.id} al tablero (${(r.lines || [])[0] || `salió ${r.code}`})`;
    const fila = (B.readBoardRaw(sdir).raw.pendientes || []).filter((x) => x && x.titulo === titulo && x.estado !== 'hecho').pop();
    if (!fila || !fila.id) return `main-check: sumé la fila de ${rec.id} al tablero pero no encontré su número`;
    rec.fila = fila.id;
    return null;
  } catch (e) { return `main-check: el tablero falló (${errLine(e)}): la espera sigue igual`; }
}

/** Con el registro cerrado, su fila del tablero se cierra por su número (board.js `close`). Devuelve el aviso de un fallo, o null. */
function cerrarFila(rec, home) {
  if (!rec || !rec.fila) return null;
  try {
    const r = require(BOARD).close(boardStateDir(home), rec.fila, { home: home || os.homedir() });
    return r.code === 0 ? null : `main-check: no pude cerrar la fila ${rec.fila} del tablero (${(r.lines || [])[0] || `salió ${r.code}`})`;
  } catch (e) { return `main-check: no pude cerrar la fila ${rec.fila} del tablero (${errLine(e)})`; }
}

function join({ tree, sha, suites, session, story, home }) {
  const mainRepo = mainRepoOf(tree);
  if (!mainRepo) throw new Error(`${tree} no es un repo de git`);
  const sid = session || sessionOf();
  const paths = statePaths(mainRepo, home);
  const { out, broke } = updateState(paths, mainRepo, sid, (state) => {
    const now = new Date().toISOString();
    let rec = openRecord(state);
    if (!rec) {
      rec = { id: `main-${state.next_id}`, sha, suites: [], casos: {}, cobertura: {}, since: now, waiting: [], fix: null, closed: null, closedSha: null };
      state.next_id += 1;
      state.broken.push(rec);
    }
    const antes = rec.suites.length;
    for (const s of suites) {
      if (!rec.suites.includes(s.ruta)) rec.suites.push(s.ruta);
      if (Array.isArray(s.casos) && s.casos.length) rec.casos[s.ruta] = s.casos.map(String);
      // la raíz de la suite en la lista: la espera de fondo vuelve a medirla sin una corrida del portón al lado
      if (s.raiz) rec.raiz = { ...(rec.raiz || {}), [s.ruta]: s.raiz };
      // la condición con que falló (con el medidor de cobertura o sin él): la espera la mide igual y el cierre pide el
      // verde de esa misma condición. Con el medidor una vez, queda con el medidor
      rec.cobertura = rec.cobertura || {};
      if (s.coverage === true) rec.cobertura[s.ruta] = true;
      else if (!(s.ruta in rec.cobertura)) rec.cobertura[s.ruta] = false;
    }
    if (sha && sha !== rec.sha) rec.sha = sha;
    if (!rec.waiting.some((w) => w && w.session === sid)) rec.waiting.push({ session: sid, since: now, ...(story ? { story } : {}) });
    const board = filaDelTablero(rec, mainRepo, { home, cambio: rec.suites.length !== antes });
    return { rec, board };
  });
  if (out.board) process.stderr.write(`${out.board}\n`);
  return { record: out.rec, broke, paths, board: out.board };
}

/**
 * Anota quién arregla main en el registro `id` (y su pedido, si lo hay). El arreglo es uno solo para todas las que
 * esperan: un segundo `fix` de otra sesión no lo pisa y dice quién lo tiene. `{ code, line }`: 0 anotado, 1 tomado por
 * otra o ya cerrado, 2 sin ese registro.
 */
function fix({ repo, id, session, pr, home }) {
  const mainRepo = mainRepoOf(repo);
  if (!mainRepo) return { code: 2, line: `main-check fix: ${repo} no es un repo de git` };
  const sid = session || sessionOf();
  const { out } = updateState(statePaths(mainRepo, home), mainRepo, sid, (state) => {
    const rec = state.broken.find((r) => r && r.id === id);
    if (!rec) return { code: 2, line: `main-check fix: no hay un registro ${id} de main roto` };
    if (rec.closed) return { code: 1, line: `main-check fix: el registro ${id} ya se cerró: main pasó (${String(rec.closedSha).slice(0, 10)})` };
    if (rec.fix && rec.fix.session && rec.fix.session !== sid) {
      return { code: 1, line: `main-check fix: el arreglo de ${id} ya lo tiene ${shortSid(rec.fix.session)}${rec.fix.pr ? ` (pedido #${rec.fix.pr})` : ''}` };
    }
    rec.fix = { session: sid, ...(pr ? { pr } : {}), since: new Date().toISOString() };
    return { code: 0, line: `main-check fix: el arreglo de ${id} queda a nombre de ${shortSid(sid)}${pr ? ` (pedido #${pr})` : ''}` };
  });
  return out;
}

/**
 * Guarda un resultado de main de una suite (`{ estado: 'verde' }` o `{ estado: 'roja', casos, casos_completos }`) para
 * `sha`, bajo el candado, y cierra el registro abierto si con eso todas sus suites están verdes en esa punta. Lo usa
 * quien mide fuera del juez (la espera de fondo). Devuelve `{ closed, broke }`.
 */
function saveResult({ tree, sha, ruta, result, session, home }) {
  const mainRepo = mainRepoOf(tree);
  if (!mainRepo) throw new Error(`${tree} no es un repo de git`);
  const sid = session || sessionOf();
  const paths = statePaths(mainRepo, home);
  const { out, broke } = updateState(paths, mainRepo, sid, (state) => {
    saveResults(state, sha, { [ruta]: result }, sid);
    return closeIfGreen(state, sha, { esMasNueva: masNuevaEn(tree) });
  });
  const fila = cerrarFila(out, home);
  if (fila) process.stderr.write(`${fila}\n`);
  return { closed: out, broke };
}

// ── la espera de fondo y la rama que no trae main ───────────────────────────────────────────────────────────────────

// el turno de las ejecuciones grandes, del repo de este guion (como run-capped.js): da el piso de memoria libre
const HEAVY_TURN = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'heavy-turn.js');
const WAIT_DEFAULTS = { interval: 300, max: 8 * 3600 };

/** ¿La memoria libre está debajo del piso del segundo turno? `{ bajo, texto }`; sin poder medirla, no posterga y lo dice. */
function memoriaParaMedir(readMemory) {
  try {
    const ht = require(HEAVY_TURN);
    const floor = ht.secondTurnFloor();
    const mem = (readMemory || ht.freeMemory)();
    if (mem.pct == null) return { bajo: false, texto: `no pude medir la memoria libre (${mem.why}): mido igual` };
    return mem.pct < floor.value ? { bajo: true, texto: `memoria libre ${mem.pct} %, debajo del piso de ${floor.value} %` } : { bajo: false, texto: null };
  } catch (e) { return { bajo: false, texto: `no pude leer el piso de memoria (${String(e.message).split('\n')[0]}): mido igual` }; }
}

/**
 * Espera que main pase sin el portón: cada `interval` segundos trae `origin/main` y, con una punta nueva y la memoria
 * sobre el piso del segundo turno, mide en la copia todas las suites del registro (`max` es su cantidad, no el tope del
 * portón; sin el atajo del árbol en la punta). El juez cierra el registro si todas pasan. `{ code, line }`: 0 con el
 * registro cerrado, 3 pasado `max` segundos, 2 sin registro con ese `id` o sin repo.
 */
function wait({ repo, id, interval, max, home, session, readMemory, now = Date.now, sleepMs = sleep, log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const warn = [];
  const intervalS = interval !== undefined ? interval : intEnv(process.env.TYCON_MAIN_CHECK_WAIT_INTERVAL_S, 'TYCON_MAIN_CHECK_WAIT_INTERVAL_S', WAIT_DEFAULTS.interval, warn);
  const maxS = max !== undefined ? max : intEnv(process.env.TYCON_MAIN_CHECK_WAIT_MAX_S, 'TYCON_MAIN_CHECK_WAIT_MAX_S', WAIT_DEFAULTS.max, warn);
  for (const w of warn) log(`main-check wait: ${w}`);
  const mainRepo = mainRepoOf(repo);
  if (!mainRepo) return { code: 2, line: `main-check wait: ${repo} no es un repo de git` };
  const paths = statePaths(mainRepo, home);
  const deadline = now() + maxS * 1000;
  let medido = null;
  for (;;) {
    const st = readState(paths, mainRepo);
    if (st.unreadable) return { code: 2, line: `main-check wait: el archivo de main-check ${paths.file} no se deja leer (${st.unreadable}): no puedo esperar a main` };
    const rec = st.broken.find((r) => r && r.id === id);
    if (!rec) return { code: 2, line: `main-check wait: no hay un registro ${id} de main roto en ${mainRepo}` };
    if (rec.closed) return { code: 0, line: `main pasó: ${rec.closedSha}; traé main y repetí el portón` };
    const fetch = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      { windowsHide: true, encoding: 'utf8', timeout: DEFAULTS.fetchTimeout * 1000 });
    const rev = g(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}');
    const sha = rev.status === 0 ? rev.stdout.trim() : '';
    if (fetch.status !== 0 || !sha) log(`main-check wait: no pude traer origin/main (${fetch.error ? fetch.error.message : lastLine(fetch) || 'sin punta'}): vuelvo a probar`);
    else if (sha !== rec.sha && sha !== medido) {
      const mem = memoriaParaMedir(readMemory);
      if (mem.texto) log(`main-check wait: ${mem.texto}${mem.bajo ? ': postergo la medición' : ''}`);
      if (!mem.bajo) {
        const lista = suitesOf(repo).entries || [];
        const raizDe = (ruta) => (rec.raiz && rec.raiz[ruta]) || ((lista.find((s) => s && s.ruta === ruta) || {}).raiz) || null;
        const fallas = (rec.suites || []).map((ruta) => ({ ruta, entrada: { raiz: raizDe(ruta), ruta }, casos: (rec.casos && rec.casos[ruta]) || [] }));
        // cada suite en la condición con que falló: un registro de antes, sin la anotación, se mide sin el medidor
        const conMedidor = (f) => Boolean(rec.cobertura && rec.cobertura[f.ruta] === true);
        const j = { lines: [], suites: [] };
        for (const grupo of [fallas.filter((f) => !conMedidor(f)), fallas.filter(conMedidor)]) {
          if (!grupo.length) continue;
          const r = judge({ tree: repo, fallas: grupo, max: grupo.length, atajo: false, session, home, coverage: conMedidor(grupo[0]) });
          j.lines.push(...r.lines);
          j.suites.push(...r.suites);
        }
        for (const l of j.lines) log(l);
        // una suite que no se pudo medir (la copia ocupada, un tope) no da la punta por medida: la vuelta siguiente la
        // vuelve a medir, y se dice por qué no
        const noSe = j.suites.filter((s) => s.verdict === 'no-se');
        for (const s of noSe) log(`main-check wait: no pude medir ${s.ruta} en ${sha.slice(0, 10)} (${String(s.motivo).replace(/^no se pudo medir main: /, '')}): vuelvo a probar`);
        if (!noSe.length) { medido = sha; continue; }
      }
    }
    if (now() >= deadline) return { code: 3, line: `main-check wait: pasaron ${maxS} s y main sigue roto (${id}): volvé a esperar, o mirá quién lo arregla (status)` };
    sleepMs(intervalS * 1000);
  }
}

/**
 * Con el registro `id` cerrado y la rama sin el commit con que main pasó, la línea que lo dice; si no (la rama lo trae,
 * el commit no está en el repo, o no hay registro), null: nunca se afirma sin poder comprobarlo.
 */
function branchCheck({ repo, id, home } = {}) {
  const mainRepo = mainRepoOf(repo);
  if (!mainRepo) return `no pude comprobar si main ya pasó: ${repo} no es un repo de git`;
  const st = readState(statePaths(mainRepo, home), mainRepo);
  if (st.unreadable) return `no pude comprobar si main ya pasó: el archivo de main-check no se deja leer (${st.unreadable})`;
  const rec = st.broken.find((r) => r && r.id === id);
  if (!rec || !rec.closedSha) return null;
  if (g(repo, 'merge-base', '--is-ancestor', rec.closedSha, 'HEAD').status !== 1) return null;
  const suites = (rec.suites || []).map((r) => path.basename(String(r))).join(', ');
  return `main ya pasó (${String(rec.closedSha).slice(0, 10)}) y esta rama no lo trae: traé main y repetí el portón antes de tocar ${suites || 'esas suites'}`;
}

// ── status ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que hay guardado del repo, sin correr nada. */
function status({ repo, home } = {}) {
  const mainRepo = mainRepoOf(repo || process.cwd());
  if (!mainRepo) return { ok: false, motivo: `${repo || process.cwd()} no es un repo de git` };
  const paths = statePaths(mainRepo, home);
  const state = readState(paths, mainRepo);
  // un archivo roto no es «sin mediciones»
  if (state.unreadable) return { ok: false, motivo: `el archivo ${paths.file} no se deja leer (${state.unreadable})` };
  const shas = Object.keys(state.results).sort((a, b) => latestAt(state.results[b]) - latestAt(state.results[a]));
  const latest = shas[0] || null;
  const suites = latest ? Object.entries(state.results[latest]).map(([ruta, r]) => ({ ruta, ...r })) : [];
  const open = openRecord(state);
  const last = state.broken.filter((r) => r && r.closed).sort((a, b) => Date.parse(b.closed) - Date.parse(a.closed))[0] || null;
  return { ok: true, repo: mainRepo, file: paths.file, copy: paths.copy, sha: latest, suites, broken: open || last || null, open: !!open };
}

function statusLines(s) {
  if (!s.ok) return [`main-check: ${s.motivo}`];
  const out = [`main-check: ${s.repo}`];
  if (!s.sha) out.push('  sin mediciones de main guardadas');
  else {
    out.push(`  última punta medida: ${s.sha.slice(0, 10)}`);
    for (const r of s.suites) {
      const estado = r.estado === 'verde' ? 'verde' : `roja (${(r.casos || []).length} caso(s)${r.casos_completos ? '' : ', lista incompleta'})`;
      out.push(`  ${r.ruta}: ${estado} en main — medida por ${shortSid(r.session)} a las ${hhmm(r.at)}`);
    }
  }
  const b = s.broken;
  if (!b) out.push('  sin registro de main roto');
  else if (!b.closed) {
    const fix = b.fix ? `${shortSid(b.fix.session)}${b.fix.pr ? ` (pedido #${b.fix.pr})` : ''}` : 'nadie lo tomó';
    out.push(`  registro ${b.id} abierto desde las ${hhmm(b.since)} (main ${String(b.sha).slice(0, 10)}): ${b.suites.join(', ')}; esperan ${b.waiting.length} sesión(es): ${b.waiting.map((w) => shortSid(w.session)).join(', ')}; arreglo: ${fix}`);
  } else out.push(`  registro ${b.id} cerrado a las ${hhmm(b.closed)}: main pasó (${String(b.closedSha).slice(0, 10)}); esperaban ${b.waiting.length} sesión(es)`);
  return out;
}

module.exports = { judge, broken: { join, openRecord, closeIfGreen, fix }, saveResult, status, statusLines, wait, branchCheck, mainRepoOf, repoKey, statePaths, readState, takeLock, releaseLock, DEFAULTS, WAIT_DEFAULTS, CASE_CAP };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const uso = 'uso: node main-check.js status --repo <repo> [--json] | wait --repo <repo> --id <id> | branch-check --repo <repo> --id <id> | fix --repo <repo> --id <id> --session <sesión> [--pr <n>]\n';
  const pr = val('--pr');
  if (!val('--repo') || !['status', 'wait', 'branch-check', 'fix'].includes(cmd) || (cmd !== 'status' && !val('--id'))
    || (cmd === 'fix' && (!val('--session') || (pr !== null && !/^[1-9]\d*$/.test(pr))))) {
    process.stderr.write(uso);
    process.exitCode = 2;
  } else if (cmd === 'fix') {
    let r;
    try { r = fix({ repo: val('--repo'), id: val('--id'), session: val('--session'), pr: pr ? Number(pr) : null }); } catch (e) { r = { code: 1, line: `main-check fix: ${errLine(e)}` }; }
    (r.code === 0 ? process.stdout : process.stderr).write(`${r.line}\n`);
    process.exitCode = r.code;
  } else if (cmd === 'wait') {
    const r = wait({ repo: val('--repo'), id: val('--id') });
    process.stdout.write(`${r.line}\n`);
    process.exitCode = r.code;
  } else if (cmd === 'branch-check') {
    const l = branchCheck({ repo: val('--repo'), id: val('--id') });
    if (l) process.stdout.write(`${l}\n`);
  } else {
    const s = status({ repo: val('--repo') });
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    else process.stdout.write(`${statusLines(s).join('\n')}\n`);
    process.exitCode = s.ok ? 0 : 1;
  }
}
