'use strict';
/**
 * worked-time.js — el tiempo en que cada sesión de agente estuvo trabajando, anotado por día local de la máquina.
 *
 * Un tramo va desde que la sesión empieza un turno hasta que lo cierra o se pone a esperar a la persona. Lo abre y lo
 * cierra el gancho de estado (scripts/hooks/session-state.js), con `workingSince` y `lastEventAt` en el archivo de
 * estado de la sesión; al cerrarse, este módulo agrega un renglón `{ sid, tool, desde, hasta }` a
 * `<estado>/worked/<AAAA-MM-DD>.jsonl`. Un tramo que cruza la medianoche se parte en dos. La apertura de un día
 * (`<día>.abierto`, `{ abierto, tz }`) la crea sólo el gancho, con la hora del evento que atiende: es la prueba de que
 * el gancho anotó ese día. La cuenta de un día la leen la preparación del día (scripts/metrics/workday-upload.js).
 *
 * 🔴 TODO DÍA ES LOCAL. El día de un momento sale de `dayOf` (la fecha local de la máquina); «ayer» se cuenta por
 *    calendario, nunca restando 24 h; nunca se corta una fecha ISO (que es UTC).
 *
 * El gancho es un proceso nuevo por evento: nada se recuerda en memoria. La apertura se crea con «sólo si no existe»,
 * así dos procesos a la vez dejan una. Un tramo que cerraron a la vez el gancho y la preparación queda dos veces: la
 * cuenta lo toma una (misma sesión, mismo `desde`). Off: TYCON_WORKDAYS=0 (y TYCON_SESSION_STATE=0, que apaga el gancho).
 *
 * Casos: scripts/tests/worked-time.test.js y scripts/tests/workday-upload.test.js
 */
const fs = require('fs');
const path = require('path');

const MIN_MS = 60000;
// una sesión sin proceso que lo diga (Codex) se da por muerta a las 2 h sin eventos, como en lib/session-state.js
const DEAD_AFTER_MS = 2 * 3600 * 1000;
const KEEP_DAYS = 60;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.(jsonl|abierto)$/;

const enabled = (env = process.env) => env.TYCON_WORKDAYS !== '0' && env.TYCON_SESSION_STATE !== '0';
const dirOf = (sdir) => path.join(sdir, 'worked');
const pad = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString();

/** El día local de un momento: `AAAA-MM-DD`. */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** La medianoche local con que empieza el día, en ms. */
function midnightOf(day) {
  const m = DAY_RE.exec(day);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}
/** El día `n` días de calendario después (o antes, con `n` negativo). */
function addDays(day, n) {
  const m = DAY_RE.exec(day);
  return dayOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n).getTime());
}
/** Los segundos de un día: entre sus dos medianoches locales (23 o 25 h el día del cambio de horario). */
const daySeconds = (day) => (midnightOf(addDays(day, 1)) - midnightOf(day)) / 1000;
/** El desplazamiento de la zona de la máquina en ese momento: `-03:00`. */
function tzOf(ms) {
  const off = -new Date(ms).getTimezoneOffset();
  const a = Math.abs(off);
  return `${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Un tramo partido por día local: `[{ day, desde, hasta }]` en ms. */
function splitAtMidnight(desde, hasta) {
  const out = [];
  let a = desde;
  while (a < hasta) {
    const day = dayOf(a);
    const end = Math.min(hasta, midnightOf(addDays(day, 1)));
    out.push({ day, desde: a, hasta: end });
    a = end;
  }
  return out;
}

function ensureDir(sdir) { fs.mkdirSync(dirOf(sdir), { recursive: true, mode: 0o700 }); }

/** Crea la apertura del día de `ms` si todavía no está. Sólo la llama el gancho, con la hora del evento. */
function markOpened(sdir, ms) {
  ensureDir(sdir);
  try {
    fs.writeFileSync(path.join(dirOf(sdir), `${dayOf(ms)}.abierto`), `${JSON.stringify({ abierto: iso(ms), tz: tzOf(ms) })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

/** Agrega el tramo, partido por día, a los archivos de cada día: un `append` de una línea por renglón. */
function appendSpan(sdir, { sid, tool, desde, hasta }) {
  if (!(hasta > desde)) return 0;
  ensureDir(sdir);
  const parts = splitAtMidnight(desde, hasta);
  for (const p of parts) {
    fs.appendFileSync(path.join(dirOf(sdir), `${p.day}.jsonl`), `${JSON.stringify({ sid, tool, desde: iso(p.desde), hasta: iso(p.hasta) })}\n`, { mode: 0o600 });
  }
  return parts.length;
}

/** El fin del último tramo anotado de una sesión, entre los de hoy y de ayer (ms; NaN si no hay). */
function lastClose(sdir, sid, now) {
  let best = NaN;
  for (const day of [dayOf(now), addDays(dayOf(now), -1)]) {
    let text = '';
    try { text = fs.readFileSync(path.join(dirOf(sdir), `${day}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(sid)) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const h = o && o.sid === sid ? Date.parse(o.hasta) : NaN;
      if (Number.isFinite(h) && h <= now && !(h <= best)) best = h;
    }
  }
  return best;
}

/**
 * Lo que cambia el tramo de una sesión con un evento: `{ patch, spans }`. `patch` lleva `workingSince` y `lastEventAt`
 * (null para borrarlos); `spans`, los tramos que se cierran (`[desde, hasta]` en ms). `decided` es lo que decidió el gancho
 * para la espera (`decide`), o null.
 *   Claude: abre con UserPromptSubmit; cierra con Stop, SessionEnd o una espera de la persona; después de una espera,
 *           lo reabre el evento que la termina (el PostToolUse con que `decide` la cierra). Un PostToolUse suelto (una
 *           tarea de fondo después de Stop) no abre nada.
 *   Codex:  abre con UserPromptSubmit; cierra con Stop; su PostToolUse sólo refresca `lastEventAt`.
 * Un UserPromptSubmit con el tramo todavía abierto (el turno anterior se cortó sin Stop: la persona lo interrumpió o
 * terminó en un error) cierra ese tramo en su `lastEventAt` y abre otro: el hueco hasta el pedido nuevo no se cuenta.
 * Si otro gancho frenó un Stop y el turno siguió, el Stop siguiente llega con `stop_hook_active`: suma el tramo desde
 * el cierre anterior de la sesión (`prevClose`, que quien llama lee de sus tramos anotados) hasta ahora.
 * `lastEventAt` se refresca a lo sumo una vez por minuto. Un tramo de una vida anterior (un SessionStart de arranque o de
 * retome con el tramo abierto; no el de una compactación, que sigue el mismo turno) o de un Codex que pasó 2 h sin
 * eventos se cierra en su `lastEventAt`.
 */
function nextState({ cur, ev, source, stopHookActive = false, prevClose = NaN, codex, decided, now }) {
  const patch = {};
  const spans = [];
  const opened = cur && cur.workingSince ? Date.parse(cur.workingSince) : NaN;
  let isOpen = Number.isFinite(opened);
  const lastAt = cur && cur.lastEventAt ? Date.parse(cur.lastEventAt) : NaN;
  const last = Number.isFinite(lastAt) ? lastAt : opened;
  const close = (end) => { spans.push([opened, end]); patch.workingSince = null; patch.lastEventAt = null; isOpen = false; };
  const open = () => { patch.workingSince = iso(now); patch.lastEventAt = iso(now); isOpen = true; };
  const newLife = ev === 'SessionStart' && source !== 'compact' && source !== 'clear';
  if (isOpen && (newLife || (codex && now - last > DEAD_AFTER_MS))) close(last);
  const p = decided && decided.patch ? decided.patch : null;
  const waitStarts = !codex && Boolean(p && p.waitingForOwner === true);
  const waitEnds = !codex && Boolean(cur && cur.waitingForOwner === true && p && p.waitingForOwner === false);
  if (ev === 'Stop') {
    if (isOpen) close(now);
    // el turno siguió después de un Stop frenado: del Stop anterior a éste también se trabajó
    else if (stopHookActive && Number.isFinite(prevClose) && prevClose < now) spans.push([prevClose, now]);
  } else if (ev === 'SessionEnd' || waitStarts) {
    if (isOpen) close(now);
  } else if (ev === 'UserPromptSubmit') {
    if (isOpen) close(last);
    open();
  } else if (ev === 'PostToolUse' && waitEnds) {
    if (!isOpen) open();
  } else if (isOpen && !(now - last < MIN_MS)) patch.lastEventAt = iso(now);
  return { patch, spans };
}

/**
 * Cierra en su `lastEventAt` los tramos de las sesiones que murieron con el tramo abierto: con pid, cuando el proceso ya
 * no existe; sin pid (Codex), a las 2 h sin eventos. Devuelve cuántos cerró.
 */
function closeDead(sdir, { now = Date.now(), env = process.env, isAlive = null } = {}) {
  if (!enabled(env)) return 0;
  const lib = require('./session-state.js');
  const alive = isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  let n = 0;
  for (const s of lib.readAll(sdir).states) {
    const opened = Date.parse(s.workingSince);
    if (!Number.isFinite(opened)) continue;
    const lastAt = Date.parse(s.lastEventAt);
    const last = Number.isFinite(lastAt) ? lastAt : opened;
    const pid = Number(s.pid);
    const dead = s.pid != null && Number.isInteger(pid) && pid > 0 ? !alive(pid) : now - last > DEAD_AFTER_MS;
    if (!dead) continue;
    appendSpan(sdir, { sid: s.session, tool: s.tool, desde: opened, hasta: last });
    lib.update(sdir, s.session, { workingSince: null, lastEventAt: null }, { env, now });
    n += 1;
  }
  return n;
}

/**
 * La cuenta de los renglones de un día: `{ arnes_segundos, sesion_segundos, sesiones, ilegibles }`. `arnes_segundos` es la
 * unión de los tramos (el tiempo con al menos una sesión trabajando); `sesion_segundos`, su suma. Un renglón repetido
 * (misma sesión, mismo `desde`) cuenta una vez; uno que no se entiende se cuenta en `ilegibles`.
 */
function dayTotals(lines, day) {
  const lo = day ? midnightOf(day) : -Infinity;
  const hi = day ? midnightOf(addDays(day, 1)) : Infinity;
  const seen = new Set();
  const spans = [];
  const sids = new Set();
  let ilegibles = 0;
  for (const raw of lines) {
    if (!String(raw).trim()) continue;
    let r;
    try { r = JSON.parse(raw); } catch { ilegibles += 1; continue; }
    const a = Math.max(Date.parse(r && r.desde), lo);
    const b = Math.min(Date.parse(r && r.hasta), hi);
    if (!r || typeof r.sid !== 'string' || !Number.isFinite(a) || !Number.isFinite(b)) { ilegibles += 1; continue; }
    const key = `${r.sid}\0${r.desde}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (b <= a) continue;
    spans.push([a, b]);
    sids.add(r.sid);
  }
  const sum = spans.reduce((t, [a, b]) => t + (b - a), 0);
  let union = 0;
  let cur = null;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (!cur || a > cur[1]) { if (cur) union += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) union += cur[1] - cur[0];
  return { arnes_segundos: Math.round(union / 1000), sesion_segundos: Math.round(sum / 1000), sesiones: sids.size, ilegibles };
}

/**
 * Lo anotado de un día: la cuenta de sus tramos, su apertura (o null) y si tiene tramos. Un archivo que existe y no se
 * puede leer devuelve `problema` (el código del error, sin la ruta).
 */
function readDay(sdir, day) {
  const out = { arnes_segundos: 0, sesion_segundos: 0, sesiones: 0, ilegibles: 0, abierto: null, hayTramos: false, problema: null };
  try { out.abierto = JSON.parse(fs.readFileSync(path.join(dirOf(sdir), `${day}.abierto`), 'utf8')); } catch (e) {
    if (e.code && e.code !== 'ENOENT') out.problema = e.code;
    else if (!e.code) out.abierto = { abierto: null, tz: null };
  }
  let text = '';
  try { text = fs.readFileSync(path.join(dirOf(sdir), `${day}.jsonl`), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') out.problema = e.code || 'error';
    return out;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  out.hayTramos = lines.length > 0;
  Object.assign(out, dayTotals(lines, day));
  return out;
}

/** Borra los archivos de día de más de `keep` días. Devuelve el primer día que se conserva. */
function prune(sdir, now = Date.now(), keep = KEEP_DAYS) {
  const cutoff = addDays(dayOf(now), -keep);
  let names = [];
  try { names = fs.readdirSync(dirOf(sdir)); } catch { return cutoff; }
  for (const n of names) {
    const m = DAY_FILE.exec(n);
    if (m && m[1] < cutoff) fs.rmSync(path.join(dirOf(sdir), n), { force: true });
  }
  return cutoff;
}

module.exports = { enabled, dirOf, dayOf, midnightOf, addDays, daySeconds, tzOf, splitAtMidnight, markOpened, appendSpan, lastClose, nextState, closeDead, dayTotals, readDay, prune, DEAD_AFTER_MS, KEEP_DAYS };
