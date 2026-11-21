'use strict';
/**
 * claude-retired.js — las sesiones de fondo que Claude Code cerró solo, leídas de su registro de fondo.
 *
 * Claude Code retira una sesión de fondo quieta cuando la máquina se queda sin memoria, y lo anota en
 * `<carpeta de Claude>/daemon.log`:
 *
 *   [2026-11-04T02:20:54.928Z] [bg] bg retire aaaabbbb: idle-prompt, idle 27m [low memory]
 *   [2026-11-04T21:57:58.601Z] [bg] bg retire ef549cad: idle-prompt, idle 2h [low memory]   ← quieta hace horas
 *   [2026-11-04T02:38:09.586Z] [bg] bg claimed-spare aaaabbbb (fleet)          ← se levantó (claude respawn)
 *
 * El id corto es el comienzo del id de la sesión; el nombre y el id entero están en `jobs/<id corto>/state.json`, que
 * queda después del retiro. Ese registro no es una interfaz documentada: lo que no se entiende es «no medido», nunca
 * «ninguna». Un motivo entre corchetes que no conoce se cuenta igual y se dice tal cual. Lee sólo el final del archivo y los renglones de las últimas 12 horas. No levanta ninguna sesión.
 */
const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 256 * 1024;
const WINDOW_MS = 12 * 3600000;
const LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[bg\] bg (retire|claimed-spare) ([0-9a-f]{8})\b(.*)$/;
const RETIRE_TAIL = /^: ([\w-]+), idle ((?:\d+[dhms])+)(?: \[([^\]]+)\])?$/;
const REASONS = { 'low memory': 'falta de memoria' };
const UNIT_MIN = { d: 1440, h: 60, m: 1, s: 1 / 60 };

// «2h», «27m», «1h5m»: los minutos enteros
const idleMinutes = (s) => Math.floor([...s.matchAll(/(\d+)([dhms])/g)].reduce((acc, [, n, u]) => acc + Number(n) * UNIT_MIN[u], 0));

// un trozo de un renglón del registro, para decir qué no se entendió: en una línea, sin caracteres de control y acotado
const piece = (s) => String(s).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

const claudeDirOf = (home) => require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).claudeDir(home);

/** El final del archivo, desde el primer renglón entero: `{ text, bytes }`. */
function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return { text, bytes: len };
  } finally { fs.closeSync(fd); }
}

/** El nombre y el id entero de una sesión por su id corto, o null. */
function jobOf(claudeDir, short) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeDir, 'jobs', short, 'state.json'), 'utf8'));
    const sid = typeof j.sessionId === 'string' && j.sessionId.startsWith(short) ? j.sessionId : null;
    const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim().replace(/[\p{Cc}\p{Cf}<>]/gu, '').slice(0, 40) : null;
    return { sid, name };
  } catch { return null; }
}

// un texto anotado por la sesión, en una línea, tapado y acotado: lo lee la persona en la coordinación y en la oficina
function shownWait(s) {
  let t = String(s).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  try { t = require(path.join(__dirname, '..', 'hooks', 'wait-notice.js')).redact(t); } catch (_) { /* sin el tapador, el texto acotado */ }
  return t.slice(0, 160);
}

/**
 * Qué esperaba la sesión cuando la cerraron, de lo que anotó el arnés: su nota de espera (`marker.js doing
 * --waiting-for`, de las últimas 24 h) o la espera abierta de su pipeline (hooks/wait-notice.js), con la historia y el
 * paso. null si no anotó nada o no se puede leer: la línea dice «sin anotar qué esperaba».
 */
function waitedFor(home, sid, now) {
  if (!sid) return null;
  let state;
  try { state = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home); } catch (_) { return null; }
  try {
    const turn = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate-io.js')).waitingTurn(state, sid, now);
    if (turn && turn.waitingFor) return shownWait(turn.waitingFor);
  } catch (_) { /* sin la nota, la espera del pipeline */ }
  try {
    const w = JSON.parse(fs.readFileSync(path.join(state, 'wait-notice', 'waits', `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf8'));
    const where = [w.story ? `la ${w.story}` : null, w.stepName || w.step || null].filter(Boolean).join(', ');
    const what = w.waiting ? shownWait(w.waiting) : '';
    if (where || what) return shownWait(`${where}${where && what ? ': ' : ''}${what}`);
  } catch (_) { /* sin espera abierta */ }
  return null;
}

/**
 * Las sesiones retiradas que no se volvieron a levantar: `{ measured, why, bytesRead, retired: [{ session, sid, short, at,
 * reason, idleMin, waited? }] }`. `waited`, sólo si la sesión anotó qué esperaba. `measured: false` con `why` cuando no
 * hay registro, no se puede leer o trae un retiro con otra forma.
 */
function retiredSessions({ home, now = Date.now(), claudeDir } = {}) {
  const dir = claudeDir || claudeDirOf(home);
  const file = path.join(dir, 'daemon.log');
  let read;
  try { read = tail(file); } catch (e) {
    return { measured: false, why: e.code === 'ENOENT' ? 'no hay registro de fondo de Claude Code' : `el registro de fondo de Claude Code no se pudo leer (${e.code || e.message})`, bytesRead: 0, retired: [] };
  }
  const last = new Map();
  for (const raw of read.text.split('\n')) {
    const line = raw.trim();
    if (!line.includes('] [bg] bg retire ') && !line.includes('] [bg] bg claimed-spare ')) continue;
    const m = LINE.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    if (!m || !Number.isFinite(at)) return { measured: false, why: `no entiendo un renglón del registro de fondo de Claude Code: ${piece(line)}`, bytesRead: read.bytes, retired: [] };
    if (now - at > WINDOW_MS) continue;
    const [, , kind, short, rest] = m;
    if (kind === 'claimed-spare') { last.set(short, null); continue; }
    const r = RETIRE_TAIL.exec(rest);
    if (!r) return { measured: false, why: `no entiendo un retiro del registro de fondo de Claude Code: ${piece(line)}`, bytesRead: read.bytes, retired: [] };
    const reason = !r[3] ? r[1] : REASONS[r[3]] || `un motivo que no conozco: ${piece(r[3])}`;
    last.set(short, { short, at, reason, idleMin: idleMinutes(r[2]) });
  }
  const retired = [];
  for (const x of last.values()) {
    if (!x) continue;
    const job = jobOf(dir, x.short);
    const sid = (job && job.sid) || null;
    const waited = waitedFor(home, sid, now);
    retired.push({ session: (job && job.name) || x.short, sid, short: x.short, at: x.at, reason: x.reason, idleMin: x.idleMin, ...(waited ? { waited } : {}) });
  }
  return { measured: true, why: null, bytesRead: read.bytes, retired };
}

module.exports = { retiredSessions, TAIL_BYTES, WINDOW_MS };
