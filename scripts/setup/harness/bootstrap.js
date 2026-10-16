#!/usr/bin/env node
'use strict';
// bootstrap.js — la COPIA FIJA de arranque del arnés (story 8.13, AC 13). Vive en ~/.claude/.tycon-pipeline/harness/,
// FUERA del árbol que actualiza; la línea de arranque de cada sesión llama a esta copia, no al árbol.
//
// Por qué: una máquina del equipo quedó 272 commits atrás durante 6 días con el instalador viejo diciendo «todo bien»
// (incident-log#arnes-que-se-bloquea-a-si-mismo-2026-09-03). La doctrina que dejó: lo durable no puede viajar por el
// camino roto. Si el `harness.js` del árbol está roto, el enlace colgado o la versión no arranca, esta copia sale ≠ 0 y
// la línea de arranque cae al respaldo en shell (`bootstrap-fallback.sh` / `.ps1`): el `git pull --ff-only --autostash`
// de siempre en los dos repos y el aplicador. Nada deja una máquina quieta, y `rollback` siempre tiene desde dónde correr.
//
// Qué hace, en orden:
//   1. El piso de Node (20): no alcanza → una línea y sale 2, antes de nada.
//   2. Lee el estado (`harness-state.json`) sin validarlo del todo. Si está en `developer` y el árbol del dev desapareció
//      (un clon descartable que se borró al reiniciar), VUELVE SOLO a `managed` sobre `tree_before`: re-apunta el enlace
//      con `canonical-path.js --ensure-link --clone <tree_before> --link <tree_before>` de ese árbol, escribe el estado
//      bajo el mismo candado por `mkdir` del programa (`harness/harness.lock`) y deja el aviso en `notice`.
//   3. Resuelve el lugar del arnés: ~/.claude/tycon-harness y, si no resuelve, el nombre viejo ~/.claude/tycon-claude-guides
//      (story 8.19); ninguno → sale 1. Comprueba que exista <tree>/scripts/setup/harness.js (si no → sale 1).
//      Los dos nombres van ESCRITOS acá (copia declarada en scripts/tests/fixtures/harness-place-names.json): esta copia
//      no carga nada del árbol, tampoco scripts/setup/harness/place.js.
//   4. Lanza `node <tree>/scripts/setup/harness.js <argv, o startup>` con el mismo PATH y devuelve su exit code.
//   (Tanda C) `rollback` y `uninstall` van ANTES de todo esto por `program/harness.js` de esta misma carpeta —la copia
//   del programa que pasó la salud—: no dependen de que el árbol arranque ni de que exista.
//   Cualquier fallo → exit ≠ 0 (y una línea en startup.log con el motivo), para que la línea caiga al respaldo.
//
// 🔴 AUTÓNOMO: cero `require` del árbol — sólo módulos de Node. Es lo que sobrevive al árbol roto. Se refresca desde el
// árbol sólo cuando un `update` pasó la comprobación de salud o en `install`; `doctor` compara su sha256 con el estado.

const NODE_FLOOR = 20;
{
  const major = parseInt(String(process.versions.node).split('.')[0], 10);
  if (!(major >= NODE_FLOOR)) {
    process.stderr.write(`bootstrap.js: Node ${process.versions.node} < ${NODE_FLOOR} — la copia fija no arranca harness.js; corre el respaldo en shell (instalá Node ${NODE_FLOOR}+)\n`);
    process.exit(2);
  }
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
// Dónde vive el estado (story 8.23, tanda C): una máquina sin Claude Code vive entera en la casa propia del arnés, y su
// estado es `~/.tycon/state` (o `TYCON_HOME/state`). La regla es la de scripts/setup/harness/tycon-home.js —si esa
// carpeta existe, es ésa; si no, la de siempre—, ESCRITA acá: esta copia no carga nada del árbol.
const OWN_HOME = process.env.TYCON_HOME && path.isAbsolute(process.env.TYCON_HOME) ? process.env.TYCON_HOME : path.join(HOME, '.tycon');
const OWN_STATE = path.join(OWN_HOME, 'state');
const livesInOwnHome = (() => { try { return fs.statSync(OWN_STATE).isDirectory(); } catch (_) { return false; } })();
const PIPE_DIR = livesInOwnHome ? OWN_STATE : path.join(HOME, '.claude', '.tycon-pipeline');
const HARNESS_DIR = path.join(PIPE_DIR, 'harness');
const STATE_FILE = path.join(PIPE_DIR, 'harness-state.json');
const LOCK_DIR = path.join(HARNESS_DIR, 'harness.lock');
const LOG_FILE = path.join(HARNESS_DIR, 'startup.log');
const PLACE_NAME = 'tycon-harness';
const LEGACY_PLACE_NAME = 'tycon-claude-guides';
const LINK = path.join(HOME, '.claude', PLACE_NAME);
const LEGACY_LINK = path.join(HOME, '.claude', LEGACY_PLACE_NAME);
const LOCK_STALE_MS = 10 * 60 * 1000;

function log(line) {
  try {
    fs.mkdirSync(HARNESS_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) { /* no hay registro todavía */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} bootstrap: ${line}\n`);
  } catch (_) { /* el registro nunca frena el arranque */ }
}
function fail(code, line) { process.stderr.write(`bootstrap.js: ${line}\n`); log(line); return code; }
function realDir(p) { try { const r = fs.realpathSync(p); return fs.statSync(r).isDirectory() ? r : null; } catch (_) { return null; } }
function readState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return s && typeof s === 'object' ? s : null; } catch (_) { return null; }
}
function writeStateAtomic(state) {
  const tmp = path.join(PIPE_DIR, `.harness-state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  let last = null;
  for (let i = 0; i < 3; i++) { try { fs.renameSync(tmp, STATE_FILE); return; } catch (e) { last = e; if (e.code !== 'EPERM') break; } }
  try { fs.unlinkSync(tmp); } catch (_) { /* nada */ }
  throw last;
}

/**
 * ¿El dueño del candado ya no existe? El mismo criterio que lock.js (story 8.23, AC 37), escrito acá porque esta copia no
 * carga nada del árbol: sólo en esta máquina (el formato de antes, sin máquina, es de ésta) y sólo con `ESRCH`.
 */
function lockOwnerDead() {
  try {
    const [p, h] = fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8').split('\n').map((s) => s.trim());
    const pid = parseInt(p, 10);
    if (!Number.isFinite(pid) || (h && h !== os.hostname())) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
  } catch (_) { return false; }
}
function olderThan(p, ms) { try { return Date.now() - fs.statSync(p).mtimeMs > ms; } catch (_) { return false; } }
function mkdirExclusive(p) { try { fs.mkdirSync(p); return true; } catch (e) { if (e && e.code === 'EEXIST') return false; throw e; } }
/** ¿El candado quedó huérfano? Viejo (> 10 min) o con su dueño muerto en esta máquina. */
function lockOrphan() { return olderThan(LOCK_DIR, LOCK_STALE_MS) || lockOwnerDead(); }
/**
 * El candado del programa, por `mkdir` (el método del aplicador): tomado y vivo → false; huérfano → se pisa con el mismo
 * mutex de takeover que lock.js, re-verificando ADENTRO (pase de revisores de la tanda L de la 8.23: sin el mutex, dos
 * arranques que veían el mismo dueño muerto se quedaban los dos con el candado — antes la ventana pedía 10 minutos de
 * candado viejo; con el dueño muerto, se abría enseguida).
 */
function acquireLock() {
  if (process.env.TYCON_HARNESS_LOCK_HELD === '1') return { ok: true, held: true };
  const busy = { ok: false, reason: 'otra sesión está actualizando (harness.lock tomado)' };
  const take = () => { try { fs.writeFileSync(path.join(LOCK_DIR, 'pid'), `${process.pid}\n${os.hostname()}\n`); } catch (_) { /* sin dueño escrito: manda la edad */ } return { ok: true, held: false }; };
  try {
    fs.mkdirSync(HARNESS_DIR, { recursive: true });
    if (mkdirExclusive(LOCK_DIR)) return take();
    if (!lockOrphan()) return busy;
    const takeover = `${LOCK_DIR}.takeover`;
    if (!mkdirExclusive(takeover)) {
      // el mutex vive un minuto como mucho: uno más viejo quedó de un proceso muerto
      if (!olderThan(takeover, 60 * 1000)) return busy;
      try { fs.rmdirSync(takeover); } catch (_) { return busy; }
      if (!mkdirExclusive(takeover)) return busy;
    }
    try {
      if (!lockOrphan()) return busy;   // adentro del mutex: el que llegó tarde ve el candado del que ganó
      if (lockOwnerDead()) {
        let pid = '?';
        try { pid = fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8').split('\n')[0].trim() || '?'; } catch (_) { /* queda «?» */ }
        log(`el candado era del pid ${pid}, que ya no existe: lo piso`);
      }
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) { /* se intenta el mkdir igual */ }
      return mkdirExclusive(LOCK_DIR) ? take() : busy;
    } finally {
      try { fs.rmdirSync(takeover); } catch (_) { /* ya no está */ }
    }
  } catch (e) {
    return { ok: false, reason: `no pude tomar harness.lock: ${e.message}` };
  }
}
function releaseLock(l) { if (l && l.ok && !l.held) { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) { /* nada */ } } }

/** `developer` con el árbol borrado: vuelve a `managed` sobre `tree_before`. Devuelve { ok, reason, tree }. */
function recoverDeveloper(state) {
  const gone = state.tree;
  const before = typeof state.tree_before === 'string' ? state.tree_before : null;
  if (!before || !realDir(before) || !fs.existsSync(path.join(before, 'scripts', 'setup', 'harness.js'))) {
    return { ok: false, reason: `modo desarrollador y el árbol ${gone} desapareció; no hay tree_before al que volver — corré harness.js install desde un clon` };
  }
  const canonical = path.join(before, 'scripts', 'lib', 'canonical-path.js');
  if (!fs.existsSync(canonical)) return { ok: false, reason: `modo desarrollador y el árbol ${gone} desapareció; ${canonical} no existe para re-apuntar el enlace` };
  const lock = acquireLock();
  if (!lock.ok) return { ok: false, reason: `modo desarrollador y el árbol ${gone} desapareció; no vuelvo a managed ahora: ${lock.reason}` };
  try {
    const r = spawnSync(process.execPath, [canonical, '--ensure-link', '--clone', before, '--link', before], { windowsHide: true, encoding: 'utf8', env: process.env, timeout: 30000 });
    if (r.status !== 0) return { ok: false, reason: `modo desarrollador y el árbol ${gone} desapareció; no pude re-apuntar el enlace a ${before}: ${(r.stdout || '') + (r.stderr || '')}`.trim() };
    const fresh = readState() || state;   // releído adentro del candado
    fresh.mode = 'managed';
    fresh.tree = before;
    fresh.tree_before = null;
    // la fuente harness vuelve al árbol también (como `link --managed`): si quedaba apuntando al clon borrado, update la
    // daba por «origin cambiado» en cada arranque y la máquina no se actualizaba nunca más (pase adversarial, clase 26)
    if (Array.isArray(fresh.sources)) for (const s of fresh.sources) if (s && s.name === 'harness') s.dir = before;
    fresh.notice = `el árbol del modo desarrollador (${gone}) desapareció: el arranque volvió solo a managed sobre ${before} y re-apuntó el enlace. Si querés seguir en modo desarrollador: harness.js link --local <clon>`;
    writeStateAtomic(fresh);
    log(`developer → managed: el árbol ${gone} desapareció; enlace re-apuntado a ${before}`);
    return { ok: true, tree: before };
  } catch (e) {
    return { ok: false, reason: `modo desarrollador y el árbol ${gone} desapareció; no pude escribir el estado: ${e.message}` };
  } finally { releaseLock(lock); }
}

/**
 * `rollback` y `uninstall` corren el PROGRAMA de la copia fija (`program/harness.js` y `program/harness/*.js`, la última
 * versión que pasó la comprobación de salud; tanda C, decisión 7 del dueño): son los que tienen que andar con el árbol
 * roto (una actualización que no arranca) o sin árbol (el dev borró el clon). Sin esa copia (una máquina de antes de la
 * C), el `harness.js` del árbol, como siempre. Devuelve el exit code, o null si no hay copia del programa.
 */
const PROGRAM = path.join(HARNESS_DIR, 'program', 'harness.js');
const FROM_FIXED_COPY = new Set(['rollback', 'uninstall']);
function runFixedProgram(args) {
  if (!FROM_FIXED_COPY.has(args[0]) || !fs.existsSync(PROGRAM)) return null;
  const r = spawnSync(process.execPath, [PROGRAM, ...args], { windowsHide: true, stdio: 'inherit', env: process.env });
  if (r.error) return fail(1, `no pude lanzar la copia fija ${PROGRAM}: ${r.error.message}`);
  if (r.status === null) return fail(1, `${PROGRAM} murió por señal ${r.signal}`);
  if (r.status !== 0) log(`copia fija: harness.js ${args.join(' ')} salió ${r.status}`);
  return r.status;
}

/**
 * La versión bajada (story 8.23, tanda B · AC 13): un cambio de versión cortado a mitad (entre los dos `rename`) se
 * repara desde su diario (`~/.tycon/swap.json`) ANTES de resolver el lugar —sin reparar, el lugar no resuelve—. Lo
 * hace `release.js` de la copia fija del programa; sin esa copia (una máquina de antes de la B) no hay nada que reparar.
 * En la forma con enlaces (story 8.33, Windows) el diario es `~/.tycon/link-swap.json`: un corte puede dejar `harness`
 * sin enlace, y sin repararlo el lugar tampoco resuelve.
 */
function repairRelease() {
  const own = process.env.TYCON_HOME && path.isAbsolute(process.env.TYCON_HOME) ? process.env.TYCON_HOME : path.join(HOME, '.tycon');
  const journal = ['swap.json', 'link-swap.json'].map((n) => path.join(own, n)).find((f) => fs.existsSync(f));
  if (!journal) return;
  const release = path.join(HARNESS_DIR, 'program', 'harness', 'release.js');
  if (!fs.existsSync(release)) { log(`hay un cambio de versión a medias (${journal}) y la copia fija no trae release.js para repararlo`); return; }
  try {
    const r = require(release).repair({ home: HOME, env: process.env }, { log: (l) => log(l) });
    if (!r.repaired) log(`el cambio de versión a medias no se pudo reparar: ${r.lines.join(' · ')}`);
  } catch (e) { log(`la reparación del cambio de versión falló: ${e.message}`); }
}

/**
 * El Node con que se lanza harness.js (story 8.39, decisión 24): el propio del arnés, `<casa>/node/current`, sólo si
 * `--version` contesta `v<n>` con n ≥ 20 en menos de 5 s; si no (no está, no arranca, se cuelga), el que corre esta copia,
 * como siempre. Un `current` roto nunca hace caer la línea al respaldo, que volvería atrás una versión sana. La ruta es la
 * regla de scripts/setup/harness/tycon-home.js#harnessNode ESCRITA acá (esta copia no carga nada del árbol; copia
 * declarada en scripts/tests/fixtures/harness-node-copies.json). TYCON_HARNESS_NODE=0 lo apaga.
 */
function harnessNodeOr(fallback) {
  if (process.env.TYCON_HARNESS_NODE === '0') return fallback;
  const bin = process.platform === 'win32' ? path.join(OWN_HOME, 'node', 'current', 'node.exe') : path.join(OWN_HOME, 'node', 'current', 'bin', 'node');
  if (!fs.existsSync(bin)) return fallback;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = /^v(\d+)\./.exec(String(r.stdout || '').trim());
  if (r.error || r.status !== 0 || !m || Number(m[1]) < NODE_FLOOR) { log(`el Node del arnés (${bin}) no contesta bien: lanzo harness.js con ${fallback}`); return fallback; }
  return bin;
}

function main(argv) {
  repairRelease();
  const fixed = runFixedProgram(argv);
  if (fixed !== null) return fixed;
  const state = readState();
  if (state && state.mode === 'developer' && typeof state.tree === 'string' && !fs.existsSync(path.join(state.tree, 'scripts', 'setup', 'harness.js'))) {
    const r = recoverDeveloper(state);
    if (!r.ok) return fail(1, r.reason);
  }
  // primero el lugar, después el nombre viejo: el primero que resuelve a un árbol con el programa
  const named = [LINK, LEGACY_LINK].map(realDir).filter(Boolean);
  let tree = named.find((d) => fs.existsSync(path.join(d, 'scripts', 'setup', 'harness.js'))) || named[0] || null;
  // una máquina que NO enchufa a Claude Code (tanda C) corre el árbol de su estado ANTES que lo que haya en la carpeta de
  // Claude Code: un clon viejo que quedó ahí no es el programa de esta máquina (pase adversarial, clase 13)
  if (state && Array.isArray(state.tools) && !state.tools.includes('claude') && typeof state.tree === 'string') {
    const own = realDir(state.tree);
    if (own && fs.existsSync(path.join(own, 'scripts', 'setup', 'harness.js'))) tree = own;
  }
  // una versión bajada en una máquina SIN Claude Code (story 8.23, tanda C) no tiene el lugar (es un enlace en la carpeta
  // de Claude Code): su árbol es el que nombra el estado, la casa propia del arnés
  if (!tree && state && Array.isArray(state.sources) && state.sources.some((s) => s && s.kind === 'release') && typeof state.tree === 'string') {
    const own = realDir(state.tree);
    if (own && fs.existsSync(path.join(own, 'scripts', 'setup', 'harness.js'))) tree = own;
  }
  if (!tree) {
    const legacyThere = (() => { try { fs.lstatSync(LEGACY_LINK); return true; } catch (_) { return false; } })();
    return fail(1, `el lugar ${LINK} no resuelve (colgado o ausente)${legacyThere ? `, ni el nombre viejo ${LEGACY_LINK}` : ''}: corre el respaldo en shell`);
  }
  const harness = path.join(tree, 'scripts', 'setup', 'harness.js');
  if (!fs.existsSync(harness)) return fail(1, `no existe ${harness}: corre el respaldo en shell`);
  const args = argv.length ? argv : ['startup'];
  const r = spawnSync(harnessNodeOr(process.execPath), [harness, ...args], { windowsHide: true, stdio: 'inherit', env: process.env });
  if (r.error) return fail(1, `no pude lanzar ${harness}: ${r.error.message}`);
  if (r.status === null) return fail(1, `${harness} murió por señal ${r.signal}`);
  if (r.status !== 0) log(`harness.js ${args.join(' ')} salió ${r.status}${args[0] === 'startup' ? ': corre el respaldo en shell' : ''}`);
  return r.status;
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) { code = fail(1, `error inesperado: ${e && e.message}`); }
  process.exitCode = code;
}

module.exports = { main, recoverDeveloper, NODE_FLOOR, acquireLock, releaseLock };
