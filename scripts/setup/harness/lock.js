'use strict';
// lock.js — el candado propio del mecanismo: ~/.claude/.tycon-pipeline/harness/harness.lock.
//
// Calco del método probado del aplicador (`install-tycon-hooks.sh`, bloque «Lock anti-concurrencia»): `mkdir` atómico,
// el pid adentro para diagnóstico, y un candado HUÉRFANO (más de 10 minutos: crash o SIGKILL sin limpieza) se pisa con
// un mutex de takeover —mkdir, sección crítica de microsegundos, vida 1 minuto— re-verificando la vejez ADENTRO del
// mutex: `rmdir + mkdir` a secas deja pasar a dos, y un `mv` atómico abre una ventana por la que entra un tercero.
//
// Quién lo usa: toda operación que escribe (`startup`, `update`, `apply`, `link`, `install`, y en la C `rollback` y
// `uninstall`). La segunda sesión que llega mientras la primera trabaja se va: `startup` en silencio con 0, los demás
// con 3 «otra sesión está actualizando» —eso lo decide el llamador con `onBusy`—. Con `TYCON_HARNESS_LOCK_HELD=1` en el
// ambiente no se toma nada: lo tiene el padre (el aplicador que llamó a `install --from-existing`), y tampoco se
// suelta. En Windows el candado vive acá y cubre al `.ps1`.
//
// Funciones puras respecto del HOME: reciben `home` y `env`.

const fs = require('fs');
const os = require('os');
const { paths } = require('./state.js');

const STALE_MS = 10 * 60 * 1000;       // huérfano: nadie trabaja 10 minutos seguidos con el candado tomado
const TAKEOVER_STALE_MS = 60 * 1000;   // el mutex de takeover vive un minuto como mucho
const HELD_VAR = 'TYCON_HARNESS_LOCK_HELD';

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}
function isStale(p, limitMs, now) {
  const m = mtimeMs(p);
  return m !== null && (now - m) > limitMs;
}
/** El dueño del candado: `{ pid, host }` (`host` null en el formato sin máquina, sólo el PID) o null. */
function readOwner(lockDir) {
  try {
    const [p, h] = fs.readFileSync(`${lockDir}/pid`, 'utf8').split('\n').map((s) => s.trim());
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? { pid: n, host: h || null } : null;
  } catch (_) { return null; }
}
function readPid(lockDir) { const o = readOwner(lockDir); return o ? o.pid : null; }
/**
 * ¿El dueño del candado ya no existe? Sólo se puede saber en ESTA máquina —el formato sin
 * máquina, es de ésta— y sólo cuando el sistema dice que el PID no existe (`ESRCH`). Vivo, sin permiso para consultarlo
 * (`EPERM`), de otra máquina o ilegible: no se sabe, y manda la regla de la edad de siempre. Un PID reusado por otro
 * proceso se ve vivo: también cae a la edad.
 */
function ownerIsDead(owner) {
  if (!owner || (owner.host && owner.host !== os.hostname())) return false;
  try { process.kill(owner.pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}
function mkdirExclusive(p) {
  try { fs.mkdirSync(p); return true; } catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
}
function take(lockDir, ownerPid = process.pid) {
  fs.mkdirSync(lockDir, { recursive: true });
  try { fs.writeFileSync(`${lockDir}/pid`, `${ownerPid}\n${os.hostname()}\n`); } catch (_) { /* diagnóstico y dueño: sin él, manda la edad */ }
  return { ok: true, held: false, pid: ownerPid, reason: null };
}

/**
 * Toma el candado. No espera: si está tomado, vuelve enseguida con `ok:false`.
 * `ownerPid`: el proceso que va a USAR el candado, si no es éste (el
 * instalador de Windows lo toma con un `node -e` que termina enseguida; a nombre de ése, el candado de un instalador vivo
 * se daría por huérfano en el acto).
 * @returns {{ ok: boolean, held: boolean, pid: number|null, reason: string|null, ageMs?: number }}
 *   `held:true` = lo tiene el padre (TYCON_HARNESS_LOCK_HELD=1): no se tomó nada y no hay que soltar nada.
 *   `ageMs` (ocupado): hace cuánto lo tiene el otro.
 */
function acquire(home = os.homedir(), { env = process.env, now = Date.now(), ownerPid = process.pid } = {}) {
  if (String(env[HELD_VAR] || '') === '1') return { ok: true, held: true, pid: null, reason: null };
  const { lockDir, harnessDir } = paths(home);
  fs.mkdirSync(harnessDir, { recursive: true });
  if (mkdirExclusive(lockDir)) return take(lockDir, ownerPid);

  // Otro lo tiene. Su dueño murió (en esta máquina) o es viejo → takeover con mutex. Si no, está corriendo: me voy.
  const busy = () => {
    const o = readOwner(lockDir);
    const otherHost = o && o.host && o.host !== os.hostname();
    const state = !o ? '' : otherHost ? ` de ${o.host}` : ownerIsDead(o) ? ', ya no existe' : ', vive';
    const m = mtimeMs(lockDir);
    return { ok: false, held: false, pid: o ? o.pid : null, ageMs: m === null ? null : Math.max(0, now - m), reason: `otra sesión está actualizando (candado ${lockDir}${o ? `, pid ${o.pid}${state}` : ''})` };
  };
  const owner = readOwner(lockDir);
  const dead = ownerIsDead(owner);
  const orphan = () => dead ? ownerIsDead(readOwner(lockDir)) && readPid(lockDir) === owner.pid : isStale(lockDir, STALE_MS, now);
  if (!orphan()) return busy();
  const takeover = `${lockDir}.takeover`;
  if (!mkdirExclusive(takeover)) {
    // el mutex está tomado: si también quedó huérfano (> 1 min) se renueva; si no, otro está pisando el candado ahora
    if (!isStale(takeover, TAKEOVER_STALE_MS, now)) return busy();
    try { fs.rmdirSync(takeover); } catch (_) { return busy(); }
    if (!mkdirExclusive(takeover)) return busy();
  }
  let taken = false;
  try {
    if (orphan()) {   // re-verificar ADENTRO del mutex: el que llegó tarde ve el candado renovado (o de otro dueño)
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* se intenta el mkdir igual */ }
      if (mkdirExclusive(lockDir)) { take(lockDir, ownerPid); taken = true; }
    }
  } finally {
    try { fs.rmdirSync(takeover); } catch (_) { /* ya no está */ }
  }
  if (!taken) return busy();
  if (!dead) return { ok: true, held: false, pid: ownerPid, reason: null };
  // lo dice el registro, para TODO comando que toma el candado (startup, update, install, rollback, …):
  // un candado pisado es un arranque o una actualización que se cortó
  try {
    const { log } = paths(home);
    fs.appendFileSync(log, `${new Date().toISOString()} candado: era del pid ${owner.pid}, que ya no existe (algo se cortó sin soltarlo): lo pisé (pid ${process.pid}, ${process.argv.slice(2, 3).join('') || 'harness.js'})\n`);
  } catch (_) { /* el registro nunca frena el candado */ }
  return { ok: true, held: false, pid: ownerPid, reason: null, reclaimed: { pid: owner.pid } };
}

/** Suelta el candado (sea de quien sea: el llamador sabe que lo tomó él). */
function release(home = os.homedir()) {
  const { lockDir } = paths(home);
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* ya no está */ }
}

/**
 * Corre `fn(lock)` con el candado tomado y lo suelta al salir (también si `fn` tira). Si está tomado por otra sesión,
 * devuelve `onBusy(result)` (o el resultado de `acquire` si no hay `onBusy`). Con el candado del padre, `fn` corre y
 * no se suelta nada. `fn` es SÍNCRONA (todo harness.js lo es): con una promesa el candado se soltaría antes de tiempo.
 */
function withLock(home, fn, { env = process.env, onBusy = null, now } = {}) {
  const lock = acquire(home, { env, now });
  if (!lock.ok) return onBusy ? onBusy(lock) : lock;
  try {
    return fn(lock);
  } finally {
    if (!lock.held) release(home);
  }
}

module.exports = { STALE_MS, TAKEOVER_STALE_MS, HELD_VAR, acquire, release, withLock, readOwner, ownerIsDead };
