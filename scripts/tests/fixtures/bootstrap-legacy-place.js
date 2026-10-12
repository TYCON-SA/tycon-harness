#!/usr/bin/env node
'use strict';
// ── FIXTURE CONGELADA (story 8.19, T10) ─────────────────────────────────────────────────────────────────────────────
// La copia fija de arranque tal como era ANTES de la tanda A de la 8.19 (`main` en ea450ae0): conoce un solo nombre, el
// viejo. La prueba la usa para mostrar que una máquina con esta copia vieja sigue arrancando con el código nuevo. NO se
// edita: es lo que hay escrito en las máquinas.
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
//   3. Resuelve el enlace ~/.claude/tycon-claude-guides (colgado → sale 1) y comprueba que exista
//      <tree>/scripts/setup/harness.js (si no → sale 1).
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
const PIPE_DIR = path.join(HOME, '.claude', '.tycon-pipeline');
const HARNESS_DIR = path.join(PIPE_DIR, 'harness');
const STATE_FILE = path.join(PIPE_DIR, 'harness-state.json');
const LOCK_DIR = path.join(HARNESS_DIR, 'harness.lock');
const LOG_FILE = path.join(HARNESS_DIR, 'startup.log');
const LINK = path.join(HOME, '.claude', 'tycon-claude-guides');
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

/** El candado del programa, por `mkdir` (el método del aplicador): tomado y fresco → false; huérfano (> 10 min) → se pisa. */
function acquireLock() {
  if (process.env.TYCON_HARNESS_LOCK_HELD === '1') return { ok: true, held: true };
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.mkdirSync(LOCK_DIR); fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid) + '\n'); return { ok: true, held: false }; } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: e.message };
      let stale = false;
      try { stale = Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS; } catch (_) { stale = true; }
      if (!stale) return { ok: false, reason: 'otra sesión está actualizando (harness.lock tomado)' };
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) { /* lo intenta de nuevo */ }
    }
  }
  return { ok: false, reason: 'no pude tomar harness.lock' };
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
    const r = spawnSync(process.execPath, [canonical, '--ensure-link', '--clone', before, '--link', before], { encoding: 'utf8', env: process.env, timeout: 30000 });
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
  const r = spawnSync(process.execPath, [PROGRAM, ...args], { stdio: 'inherit', env: process.env });
  if (r.error) return fail(1, `no pude lanzar la copia fija ${PROGRAM}: ${r.error.message}`);
  if (r.status === null) return fail(1, `${PROGRAM} murió por señal ${r.signal}`);
  if (r.status !== 0) log(`copia fija: harness.js ${args.join(' ')} salió ${r.status}`);
  return r.status;
}

function main(argv) {
  const fixed = runFixedProgram(argv);
  if (fixed !== null) return fixed;
  const state = readState();
  if (state && state.mode === 'developer' && typeof state.tree === 'string' && !fs.existsSync(path.join(state.tree, 'scripts', 'setup', 'harness.js'))) {
    const r = recoverDeveloper(state);
    if (!r.ok) return fail(1, r.reason);
  }
  const tree = realDir(LINK);
  if (!tree) return fail(1, `el enlace ${LINK} no resuelve (colgado o ausente): corre el respaldo en shell`);
  const harness = path.join(tree, 'scripts', 'setup', 'harness.js');
  if (!fs.existsSync(harness)) return fail(1, `no existe ${harness}: corre el respaldo en shell`);
  const args = argv.length ? argv : ['startup'];
  const r = spawnSync(process.execPath, [harness, ...args], { stdio: 'inherit', env: process.env });
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

module.exports = { main, recoverDeveloper, NODE_FLOOR };
