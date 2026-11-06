'use strict';
// lock.js — el candado propio del mecanismo: ~/.claude/.tycon-pipeline/harness/harness.lock.
//
// Calco del método probado del aplicador (`install-tycon-hooks.sh`, bloque «Lock anti-concurrencia»): `mkdir` atómico,
// el pid adentro para diagnóstico, y un candado HUÉRFANO se pisa con un mutex de takeover —mkdir, sección crítica de
// microsegundos, vida 1 minuto— re-verificando ADENTRO del mutex: `rmdir + mkdir` a secas deja pasar a dos, y un `mv`
// atómico abre una ventana por la que entra un tercero.
//
// Cuándo es huérfano el candado de siempre:
//   · su dueño murió en esta máquina: en el acto;
//   · su dueño vive en esta máquina: la edad de 10 minutos NO cuenta (una actualización legítima puede tardar más). Lo
//     liberan dos cosas: que se haya tomado antes del último arranque de la máquina (con un margen de 5 minutos por la
//     precisión de `os.uptime()` y un ajuste del reloj), porque después de un reinicio ese pid es de otro proceso; o el
//     tope de 2 horas, la salida para un pid reusado sin reinicio (o un `EPERM` de un proceso ajeno);
//   · su dueño es de otra máquina o no se puede leer: la edad de 10 minutos, como siempre.
// Toda toma que no es por dueño muerto también queda en el registro. `lock.js` no vuelve a tocar el candado después
// del `mkdir`: su `mtime` es la hora en que se tomó. La decisión vive en `orphanReason`, una función pura: el lanzador
// (`bootstrap.js`), que no puede cargar este archivo, tiene su copia, y una prueba compara las dos.
//
// Cada toma escribe un token al azar al lado del pid. El que se detuvo (una notebook suspendida) y despierta después de
// que otro pisó su candado por el tope ya no tiene el suyo: `release` con su token no borra el del otro, y
// `stillMine` le dice que se vaya sin escribir.
//
// Quién lo usa: toda operación que escribe (`startup`, `update`, `apply`, `link`, `install`, y en la C `rollback` y
// `uninstall`). La segunda sesión que llega mientras la primera trabaja se va: `startup` en silencio con 0, los demás
// con 3 «otra sesión está actualizando» —eso lo decide el llamador con `onBusy`—. Con `TYCON_HARNESS_LOCK_HELD=1` en el
// ambiente no se toma nada: lo tiene el padre (el aplicador que llamó a `install --from-existing`), y tampoco se
// suelta. En Windows el candado vive acá y cubre al `.ps1`.
//
// Funciones puras respecto del HOME: reciben `home` y `env`.
//
// Otro candado con el mismo método (el de `marker.js run-check`, uno por check y por repo) pasa su carpeta en
// `lockDir`, los datos de su dueño en `extra` (van a `owner.json`, al lado de `pid`) y `staleMs: null`: no se libera por
// edad, sólo cuando todos sus pids (`pid` y `extra.childPid`) murieron en esta máquina. Un dueño que no se puede leer
// se da por ocupado `unreadableMs` desde la creación. `TYCON_HARNESS_LOCK_HELD` no vale para esos candados.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./state.js');

const STALE_MS = 10 * 60 * 1000;       // huérfano por edad: dueño de otra máquina o ilegible, 10 minutos
const HARD_STALE_MS = 2 * 60 * 60 * 1000;   // el tope para un dueño que parece vivo: un pid reusado sin reinicio
const BOOT_MARGIN_MS = 5 * 60 * 1000;  // el margen sobre la hora de arranque de la máquina
const UNREADABLE_MS = 60 * 1000;       // sin edad: un dueño ilegible se da por ocupado un minuto (lo está escribiendo)
const TAKEOVER_STALE_MS = 60 * 1000;   // el mutex de takeover vive un minuto como mucho
const HELD_VAR = 'TYCON_HARNESS_LOCK_HELD';

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}
function isStale(p, limitMs, now) {
  const m = mtimeMs(p);
  return m !== null && (now - m) > limitMs;
}
/**
 * El dueño del candado: `{ pid, host, token, extra }` (`host` null en el formato sin máquina, sólo el PID; `token` null
 * en un candado de antes del token; `extra` lo de `owner.json`, o null) o null.
 */
function readOwner(lockDir) {
  try {
    const [p, h, t] = fs.readFileSync(`${lockDir}/pid`, 'utf8').split('\n').map((s) => s.trim());
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    let extra = null;
    try { extra = JSON.parse(fs.readFileSync(`${lockDir}/owner.json`, 'utf8')); } catch (_) { extra = null; }
    return { pid: n, host: h || null, token: t || null, extra };
  } catch (_) { return null; }
}
function readPid(lockDir) { const o = readOwner(lockDir); return o ? o.pid : null; }
/**
 * ¿El dueño del candado ya no existe? Sólo se puede saber en ESTA máquina —el formato sin
 * máquina, es de ésta— y sólo cuando el sistema dice que el PID no existe (`ESRCH`). Vivo, sin permiso para consultarlo
 * (`EPERM`), de otra máquina o ilegible: no se sabe, y manda `orphanReason`. Un PID reusado por otro proceso se ve
 * vivo: lo liberan el arranque de la máquina o el tope de 2 h.
 */
function pidIsDead(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}
function ownerIsDead(owner) {
  if (!owner || (owner.host && owner.host !== os.hostname())) return false;
  const child = owner.extra && Number.isInteger(owner.extra.childPid) ? owner.extra.childPid : null;
  return pidIsDead(owner.pid) && (child === null || pidIsDead(child));
}

/**
 * Por qué se pisa un candado cuyo dueño no murió: null (no se pisa), 'boot', 'hard-cap' o 'age'. Pura: recibe el dueño
 * leído (`{ pid, host }` o null si no se puede leer), el `mtime` del candado, la hora, la hora de arranque de la máquina
 * y el nombre de esta máquina. Sin edad (`staleMs` null): un dueño legible nunca es huérfano; uno ilegible, pasado
 * `unreadableMs`.
 */
function orphanReason({
  owner, mtimeMs: m, now, bootMs, hostname = os.hostname(),
  staleMs = STALE_MS, hardStaleMs = HARD_STALE_MS, unreadableMs = UNREADABLE_MS,
}) {
  if (m === null || m === undefined) return null;
  if (staleMs === null) return owner === null && now - m > unreadableMs ? 'age' : null;
  const here = owner && (!owner.host || owner.host === hostname);
  if (!here) return now - m > staleMs ? 'age' : null;
  if (m < bootMs - BOOT_MARGIN_MS) return 'boot';
  return now - m > hardStaleMs ? 'hard-cap' : null;
}

function mkdirExclusive(p) {
  try { fs.mkdirSync(p); return true; } catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
}
function writeExtra(lockDir, extra) {
  // por un temporal y un rename: quien lo lee mientras se reescribe ve el viejo o el nuevo, nunca uno a medias
  const tmp = `${lockDir}/owner.json.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(extra)}\n`); fs.renameSync(tmp, `${lockDir}/owner.json`); } catch (_) {
    try { fs.rmSync(tmp, { force: true }); } catch (_e) { /* no quedó */ }
    /* diagnóstico: sin él, cuenta el pid */
  }
}
function take(lockDir, ownerPid = process.pid, extra = null) {
  fs.mkdirSync(lockDir, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  // owner.json antes que pid: quien lee un pid legible ya ve también lo demás
  if (extra) writeExtra(lockDir, extra);
  try { fs.writeFileSync(`${lockDir}/pid`, `${ownerPid}\n${os.hostname()}\n${token}\n`); } catch (_) { /* diagnóstico y dueño: sin él, manda la edad */ }
  return { ok: true, held: false, pid: ownerPid, reason: null, lockDir, token };
}

/**
 * Toma el candado. No espera: si está tomado, vuelve enseguida con `ok:false`.
 * `ownerPid`: el proceso que va a USAR el candado, si no es éste (el
 * instalador de Windows lo toma con un `node -e` que termina enseguida; a nombre de ése, el candado de un instalador vivo
 * se daría por huérfano en el acto).
 * @returns {{ ok: boolean, held: boolean, pid: number|null, reason: string|null, token?: string, ageMs?: number }}
 *   `held:true` = lo tiene el padre (TYCON_HARNESS_LOCK_HELD=1): no se tomó nada y no hay que soltar nada.
 *   `token` (tomado): el de esta toma, para `release` y `stillMine`.
 *   `ageMs` (ocupado): hace cuánto lo tiene el otro.
 */
function acquire(home = os.homedir(), {
  env = process.env, now = Date.now(), ownerPid = process.pid,
  lockDir: ownDir = null, extra = null, staleMs = STALE_MS, unreadableMs = UNREADABLE_MS,
  bootTimeMs = null, hardStaleMs = HARD_STALE_MS,
} = {}) {
  const bootMs = Number.isFinite(bootTimeMs) ? bootTimeMs : now - os.uptime() * 1000;
  if (!ownDir && String(env[HELD_VAR] || '') === '1') return { ok: true, held: true, pid: null, reason: null };
  const lockDir = ownDir || paths(home).lockDir;
  fs.mkdirSync(ownDir ? path.dirname(ownDir) : paths(home).harnessDir, { recursive: true });
  if (mkdirExclusive(lockDir)) return take(lockDir, ownerPid, extra);

  // Otro lo tiene. Su dueño murió (en esta máquina) o es huérfano → takeover con mutex. Si no, está corriendo: me voy.
  const busy = () => {
    const o = readOwner(lockDir);
    const otherHost = o && o.host && o.host !== os.hostname();
    const state = !o ? '' : otherHost ? ` de ${o.host}` : ownerIsDead(o) ? ', ya no existe' : ', vive';
    const m = mtimeMs(lockDir);
    return { ok: false, held: false, pid: o ? o.pid : null, owner: o, lockDir, ageMs: m === null ? null : Math.max(0, now - m), reason: `otra sesión está actualizando (candado ${lockDir}${o ? `, pid ${o.pid}${state}` : ''})` };
  };
  const owner = readOwner(lockDir);
  const dead = ownerIsDead(owner);
  const whyOrphan = () => orphanReason({ owner: readOwner(lockDir), mtimeMs: mtimeMs(lockDir), now, bootMs, staleMs, hardStaleMs, unreadableMs });
  let why = null;
  const orphan = () => {
    if (dead) return ownerIsDead(readOwner(lockDir)) && readPid(lockDir) === owner.pid;
    why = whyOrphan();
    return why !== null;
  };
  if (!orphan()) return busy();
  const takeover = `${lockDir}.takeover`;
  if (!mkdirExclusive(takeover)) {
    // el mutex está tomado: si también quedó huérfano (> 1 min) se renueva; si no, otro está pisando el candado ahora
    if (!isStale(takeover, TAKEOVER_STALE_MS, now)) return busy();
    try { fs.rmdirSync(takeover); } catch (_) { return busy(); }
    if (!mkdirExclusive(takeover)) return busy();
  }
  let taken = null;
  try {
    if (orphan()) {   // re-verificar ADENTRO del mutex: el que llegó tarde ve el candado renovado (o de otro dueño)
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* se intenta el mkdir igual */ }
      if (mkdirExclusive(lockDir)) taken = take(lockDir, ownerPid, extra);
    }
  } finally {
    try { fs.rmdirSync(takeover); } catch (_) { /* ya no está */ }
  }
  if (!taken) return busy();
  const { token } = taken;
  // el registro del mecanismo es del candado de siempre; el llamador de otro candado lo dice él
  if (ownDir) return dead ? { ok: true, held: false, pid: ownerPid, reason: null, lockDir, token, reclaimed: { pid: owner.pid } } : { ok: true, held: false, pid: ownerPid, reason: null, lockDir, token };
  // lo dice el registro, para TODO comando que toma el candado (startup, update, install, rollback, …):
  // un candado pisado es un arranque o una actualización que se cortó
  const who = owner ? `pid ${owner.pid}` : 'dueño ilegible';
  const what = dead ? `era del pid ${owner.pid}, que ya no existe (algo se cortó sin soltarlo)`
    : why === 'boot' ? `era del pid ${owner.pid}, tomado antes del último arranque de la máquina (ese número ya es de otro proceso)`
      : why === 'hard-cap' ? `el pid ${owner.pid} parece vivo pero pasó el tope de 2 h`
        : `tenía más de 10 min y su dueño no se puede consultar (${owner ? `${who} de ${owner.host}` : 'no se puede leer'})`;
  appendLog(home, `candado: ${what}: lo pisé`);
  return dead ? { ok: true, held: false, pid: ownerPid, reason: null, lockDir, token, reclaimed: { pid: owner.pid } } : { ok: true, held: false, pid: ownerPid, reason: null, lockDir, token, takenOver: why };
}

function appendLog(home, line) {
  try {
    const { log } = paths(home);
    fs.appendFileSync(log, `${new Date().toISOString()} ${line} (pid ${process.pid}, ${process.argv.slice(2, 3).join('') || 'harness.js'})\n`);
  } catch (_) { /* el registro nunca frena el candado */ }
}

/**
 * ¿El candado sigue siendo de la toma de `token`? Falso si ya no está o si lo tomó otro (lo pisó por el tope mientras
 * éste estaba detenido). Un candado de antes del token (sin la tercera línea) cuenta como de quien lo tiene.
 */
function stillMine(home = os.homedir(), token, { lockDir = null } = {}) {
  const o = readOwner(lockDir || paths(home).lockDir);
  if (!o) return false;
  return !token || !o.token || o.token === token;
}

/**
 * Suelta el candado. Con `token`, sólo si sigue siendo de esa toma: si otro lo pisó mientras éste estaba detenido, no
 * lo toca y lo anota. Sin `token` (un llamador que sabe que lo tomó él), lo suelta sea de quien sea. `lockDir`: el de
 * otro candado, no el de siempre.
 */
function release(home = os.homedir(), { lockDir = null, token = null } = {}) {
  const dir = lockDir || paths(home).lockDir;
  if (token && fs.existsSync(dir) && !stillMine(home, token, { lockDir: dir })) {
    if (!lockDir) appendLog(home, 'candado: ya no es mío: no lo suelto (otro lo tomó mientras éste estaba detenido)');
    return;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ya no está */ }
}

/**
 * Corre `fn(lock)` con el candado tomado y lo suelta al salir (también si `fn` tira), con su token: si otro lo pisó,
 * no se suelta el del otro. Si está tomado por otra sesión, devuelve `onBusy(result)` (o el resultado de `acquire` si
 * no hay `onBusy`). Con el candado del padre, `fn` corre y no se suelta nada. `fn` es SÍNCRONA (todo harness.js lo
 * es): con una promesa el candado se soltaría antes de tiempo.
 */
function withLock(home, fn, { env = process.env, onBusy = null, now } = {}) {
  const lock = acquire(home, { env, now });
  if (!lock.ok) return onBusy ? onBusy(lock) : lock;
  const key = paths(home).lockDir;
  if (!lock.held) held.set(key, lock.token);
  try {
    return fn(lock);
  } finally {
    if (!lock.held) { held.delete(key); release(home, { token: lock.token }); }
  }
}

// El token de la toma que este proceso tiene ahora, por candado: lo anota `withLock`, y `assertStillMine` lo compara.
const held = new Map();
const LOCK_LOST = 'TYCON_LOCK_LOST';
/**
 * Tira (con `code: 'TYCON_LOCK_LOST'`) si este proceso tomó el candado con `withLock` y otro se lo pisó mientras
 * estaba detenido. Se llama antes de escribir: el aplicador, mover árboles, grabar el estado. Sin una toma de este
 * proceso (un comando que no toma el candado, o el del padre) no hace nada.
 */
function assertStillMine(home = os.homedir()) {
  const token = held.get(paths(home).lockDir);
  if (!token || stillMine(home, token)) return;
  const e = new Error('otro proceso tomó el candado mientras éste estaba detenido: me voy sin escribir');
  e.code = LOCK_LOST;
  throw e;
}

module.exports = {
  STALE_MS, HARD_STALE_MS, BOOT_MARGIN_MS, TAKEOVER_STALE_MS, UNREADABLE_MS, HELD_VAR,
  LOCK_LOST, acquire, release, withLock, stillMine, assertStillMine, orphanReason, readOwner, ownerIsDead, writeExtra,
};
