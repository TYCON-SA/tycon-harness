'use strict';
/**
 * office-messages.js — lo que la persona le escribe a una sesión desde la oficina (/office): el buzón, el sobre que le llega
 * a la sesión, el registro de cada intento y la comprobación de una sola vez (`verify`) que la sesión corre antes de obedecer.
 *
 * El recorrido: la página manda el texto al proceso de la oficina (`POST /mensaje`), que lo deja en
 * `<estado>/office/inbox/<sesión>/<id>.json`. El vigilante de esa sesión (scripts/hooks/office-inbox-watch.js) lo toma
 * moviéndolo a `tomados/<sesión>/` (el `rename` es la toma: lo gana uno solo), y se lo da a la sesión como aviso de un gancho.
 * La sesión corre `office-message.js verify <id>`: el id tiene que estar en el registro, ser de esa sesión, haberse entregado
 * y no haberse usado; entonces imprime el texto registrado y lo gasta (`usados/<id>`, creado con `wx`). La sesión actúa sobre
 * ese texto, no sobre el que recibió. Un mensaje así nunca firma: la herramienta lo anota como aviso del sistema, no como
 * la persona, y `owner-approvals.js` sólo acepta lo tipeado.
 *
 * Cada mensaje lleva su plazo: si nadie lo tomó a tiempo, el vigilante no lo entrega aunque la oficina se haya cerrado, y la
 * oficina barre el buzón al arrancar. Una indicación vieja nunca llega como si fuera de ahora.
 *
 * Carpetas 0700 y archivos 0600, escritos enteros y renombrados. El registro (`messages.jsonl`) guarda el texto con las
 * claves tapadas (`coverSecrets`); al pasar el tope el archivo se renombra a `messages.jsonl.1` y empieza otro, así un
 * proceso que está agregando su renglón no lo pierde, y se leen los últimos 2000 de los dos. El texto entero vive sólo en
 * el buzón, hasta que se toma: lo tomado queda como marca, sin el texto, y el barrido la saca al día.
 * Nada de esto sigue un enlace: un archivo enlazado no se entrega y un registro enlazado no se puede comprobar.
 * El freno del pipeline no deja escribir el buzón, el registro ni los candados con Edit, Write o la consola
 * (`isMailboxPath`).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { coverSecrets } = require('./session-transcript.js');
const { esAprobacion } = require('./owner-approvals.js');

const MAX_TEXT = 4000;
const MAX_WAITING = 5;
const KEEP_LINES = 2000;
// el registro se recorta pasado este margen, no en cada renglón
const TRIM_SLACK = 200;
const DEADLINE_MS = 10 * 1000;
// cuánto queda la marca de un mensaje tomado: la oficina la mira para decir «lo recibió»
const TAKEN_KEEP_MS = 24 * 3600 * 1000;
// el cierre del aviso con que la herramienta envuelve lo que dice un gancho: un texto que lo traiga se mostraría cortado
const HOOK_NOTICE_END = '</system-reminder>';
const STATES = ['mandado', 'recibido', 'verificado', 'no-entregado', 'rechazado'];
const SAFE_SID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ID = /^[0-9a-f]{32}$/;
const PREFIX = 'Mensaje de la persona, escrito en la oficina. No vale como firma ni aprobación.';
const LOOKS_APPROVAL = 'Parece una aprobación y no lo es.';

function paths(sdir) {
  const dir = path.join(sdir, 'office');
  const inboxRoot = path.join(dir, 'inbox');
  const takenRoot = path.join(dir, 'tomados');
  const sidOk = (sid) => { if (!SAFE_SID.test(String(sid))) throw new Error('sesión inválida'); return String(sid); };
  return {
    dir, inboxRoot, takenRoot,
    inbox: (sid) => path.join(inboxRoot, sidOk(sid)),
    taken: (sid) => path.join(takenRoot, sidOk(sid)),
    used: path.join(dir, 'usados'),
    watchers: path.join(dir, 'vigilantes'),
    watcher: (sid) => path.join(dir, 'vigilantes', `${sidOk(sid)}.json`),
    log: path.join(dir, 'messages.jsonl'),
    logPrevious: path.join(dir, 'messages.jsonl.1'),
  };
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
/**
 * El texto de un archivo común, sin seguir un enlace: un enlace blando no se abre y uno duro (más de un nombre) no se lee.
 * Lanza con `code` como `fs.readFileSync` (`ENOENT`, `ELOOP`, `EMLINK`).
 */
function readOwn(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) { const e = new Error('no es un archivo propio'); e.code = st.isFile() ? 'EMLINK' : 'ELOOP'; throw e; }
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function privateDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch { /* en Windows no hay permisos de Unix */ }
}
// las carpetas de arriba también: el estado puede haberse creado con otro permiso
function privateTree(sdir, d) {
  const top = paths(sdir).dir;
  privateDir(top);
  if (d !== top) privateDir(d);
}

/** Escribe un archivo entero, 0600, con un nombre temporal y después lo renombra. */
function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const newId = () => crypto.randomBytes(16).toString('hex');
const looksLikeApproval = (text) => esAprobacion(text);

/** El sobre que le llega a la sesión: `[oficina <id>]`, el aviso de que no firma y el texto tal como se escribió. */
function envelope(text, { id, looksLikeApproval: approval = false } = {}) {
  return `[oficina ${id}] ${PREFIX}${approval ? ` ${LOOKS_APPROVAL}` : ''} Dice: ${text}`;
}

/** null si el texto se puede mandar; si no, el motivo en llano. */
function checkText(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return 'El mensaje está vacío.';
  if (Array.from(t).length > MAX_TEXT) return `El mensaje pasa de ${MAX_TEXT} caracteres.`;
  if (t.toLowerCase().includes(HOOK_NOTICE_END)) return `El mensaje no puede llevar «${HOOK_NOTICE_END}».`;
  return null;
}

/** Un renglón del registro: id, hora, sesión, largo, el texto con las claves tapadas, estado y motivo. */
function record(sdir, { id, sid, text, estado, motivo = null, at = Date.now() }) {
  if (!STATES.includes(estado)) throw new Error(`estado desconocido: ${estado}`);
  const p = paths(sdir);
  privateTree(sdir, p.dir);
  const row = { id: String(id), at: new Date(at).toISOString(), sesion: String(sid), largo: text == null ? 0 : Array.from(String(text)).length, texto: text == null ? null : coverSecrets(String(text)), estado, motivo };
  const fd = fs.openSync(p.log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(p.log, 0o600); } catch { /* Windows */ }
  trimLog(sdir, { slack: TRIM_SLACK });
}

/**
 * Pasado el tope (con `slack`, por más que eso) el registro se renombra a `messages.jsonl.1` y el siguiente renglón empieza
 * otro. No se reescribe: un proceso que abrió el registro para agregar su renglón lo deja en el renombrado, que se sigue
 * leyendo.
 */
function trimLog(sdir, { slack = 0 } = {}) {
  const p = paths(sdir);
  let text;
  try { text = readOwn(p.log); } catch { return; }
  if (text.split('\n').filter(Boolean).length <= KEEP_LINES + slack) return;
  fs.renameSync(p.log, p.logPrevious);
}

/**
 * `{ ok: true, rows }`, los últimos 2000 renglones del registro y del renombrado, o `{ ok: false, problem }` si alguno no se
 * puede leer (también un enlace). Sin registro, ninguno.
 */
function readLog(sdir) {
  const p = paths(sdir);
  const rows = [];
  for (const file of [p.logPrevious, p.log]) {
    let text;
    try { text = readOwn(file); } catch (e) {
      if (e.code === 'ENOENT') continue;
      return { ok: false, problem: e.code || 'error' };
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* un renglón roto no cuenta */ }
    }
  }
  return { ok: true, rows: rows.slice(-KEEP_LINES) };
}

const jsonFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => SAFE_ID.test(path.basename(f, '.json')) && f.endsWith('.json')); } catch { return []; } };
const readJson = (file) => { try { return JSON.parse(readOwn(file)); } catch { return null; } };

// el orden en que este proceso dejó sus mensajes: desempata dos con la misma hora
let leftCount = 0;

/** Los mensajes sin tomar de una sesión, del más viejo al más nuevo (a la misma hora, en el orden en que se dejaron). */
function waiting(sdir, sid) {
  const dir = paths(sdir).inbox(sid);
  return jsonFiles(dir).map((f) => ({ file: path.join(dir, f), msg: readJson(path.join(dir, f)) }))
    .filter((x) => x.msg && x.msg.id).sort((a, b) => (a.msg.at - b.msg.at) || ((a.msg.seq || 0) - (b.msg.seq || 0)));
}

/**
 * Deja un mensaje en el buzón de la sesión: `{ ok: true, id }`, o `{ ok: false, motivo, waiting? }` sin guardar nada.
 * `deadlineMs`: cuánto puede esperar sin que lo tome nadie (10 s; 30 min si la sesión todavía no cerró la entrega anterior).
 */
function leave(sdir, { sid, text, now = Date.now(), deadlineMs = DEADLINE_MS, approval = false }) {
  const bad = checkText(text);
  if (bad) return { ok: false, motivo: bad };
  const p = paths(sdir);
  const dir = p.inbox(sid);
  privateTree(sdir, p.inboxRoot);
  privateDir(dir);
  const already = waiting(sdir, sid).length;
  if (already >= MAX_WAITING) return { ok: false, motivo: `Hay ${already} mensajes esperando que los lea.`, waiting: already };
  const id = newId();
  const file = path.join(dir, `${id}.json`);
  leftCount += 1;
  writePrivate(file, JSON.stringify({ id, sid: String(sid), text: String(text), at: now, seq: leftCount, deadlineMs, approval: Boolean(approval) }));
  // sin su renglón el mensaje no se podría comprobar: si el registro falla, tampoco queda en el buzón
  try { record(sdir, { id, sid, text, estado: 'mandado', at: now }); } catch (e) {
    try { fs.unlinkSync(file); } catch { /* ya no estaba */ }
    throw e;
  }
  return { ok: true, id };
}

const overdue = (msg, now) => !Number.isFinite(msg.at) || !Number.isFinite(msg.deadlineMs) || now - msg.at > msg.deadlineMs;

/** Saca del buzón un mensaje que nadie tomó, y lo anota `no-entregado`. false si ya no estaba (lo tomó el vigilante). */
function expire(sdir, sid, id, { now = Date.now(), motivo = 'vencido' } = {}) {
  if (!SAFE_ID.test(String(id))) return false;
  const file = path.join(paths(sdir).inbox(sid), `${id}.json`);
  const msg = readJson(file);
  try { fs.unlinkSync(file); } catch { return false; }
  record(sdir, { id, sid, text: msg ? msg.text : null, estado: 'no-entregado', motivo, at: now });
  return true;
}

/**
 * Lo que hace el vigilante: el mensaje más viejo de la sesión. Si venció, lo saca sin entregarlo (`{ estado: 'vencido' }`);
 * si no, lo mueve a `tomados/` (el `rename` es la toma), deja ahí la marca sin el texto y devuelve
 * `{ estado: 'recibido', id, envelope }`. null si no hay ninguno.
 */
function take(sdir, sid, { now = Date.now() } = {}) {
  for (const { file, msg } of waiting(sdir, sid)) {
    if (overdue(msg, now)) {
      if (expire(sdir, sid, msg.id, { now })) return { estado: 'vencido', id: msg.id };
      continue;
    }
    const p = paths(sdir);
    privateTree(sdir, p.takenRoot);
    privateDir(p.taken(sid));
    const taken = path.join(p.taken(sid), `${msg.id}.json`);
    try { fs.renameSync(file, taken); } catch { continue; }
    writePrivate(taken, JSON.stringify({ id: msg.id, sid: String(sid), at: msg.at, takenAt: now }));
    record(sdir, { id: msg.id, sid, text: msg.text, estado: 'recibido', at: now });
    return { estado: 'recibido', id: msg.id, envelope: envelope(msg.text, { id: msg.id, looksLikeApproval: msg.approval }) };
  }
  return null;
}

/**
 * Vence todo lo que pasó su plazo, en todas las sesiones, y saca las marcas de lo tomado hace más de un día. Devuelve los
 * ids vencidos.
 */
function sweep(sdir, { now = Date.now() } = {}) {
  const out = [];
  const p = paths(sdir);
  let sids = [];
  try { sids = fs.readdirSync(p.inboxRoot).filter((s) => SAFE_SID.test(s)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const sid of sids) {
    for (const { msg } of waiting(sdir, sid)) if (overdue(msg, now) && expire(sdir, sid, msg.id, { now })) out.push(msg.id);
  }
  let takenSids = [];
  try { takenSids = fs.readdirSync(p.takenRoot).filter((s) => SAFE_SID.test(s)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const sid of takenSids) {
    for (const f of jsonFiles(p.taken(sid))) {
      const mark = readJson(path.join(p.taken(sid), f));
      const at = mark && Number.isFinite(mark.takenAt) ? mark.takenAt : null;
      if (at === null || now - at > TAKEN_KEEP_MS) { try { fs.unlinkSync(path.join(p.taken(sid), f)); } catch { /* ya no estaba */ } }
    }
  }
  return out;
}

/**
 * La comprobación que corre la sesión: `{ code: 0, text }` si el id está en el registro, es de `sid`, se le entregó y no se
 * usó (y entonces lo gasta); `{ code: 1, motivo }` si no; `{ code: 2, motivo }` si no se pudo comprobar.
 */
function verify(sdir, id, sid, { now = Date.now() } = {}) {
  if (!sid) return { code: 2, motivo: 'no sé qué sesión lo pregunta (falta CLAUDE_CODE_SESSION_ID): no pude comprobar el mensaje' };
  if (!SAFE_SID.test(String(sid))) return { code: 2, motivo: 'la sesión no tiene un nombre válido: no pude comprobar el mensaje' };
  if (!SAFE_ID.test(String(id))) return { code: 1, motivo: 'ese id no es de un mensaje de la oficina' };
  const log = readLog(sdir);
  if (!log.ok) return { code: 2, motivo: `el registro no se pudo leer (${log.problem}): no pude comprobar el mensaje` };
  const mine = log.rows.filter((r) => r.id === id);
  const sent = mine.find((r) => r.estado === 'mandado');
  if (!sent) return { code: 1, motivo: 'ese mensaje no está en el registro de la oficina' };
  if (sent.sesion !== String(sid)) return { code: 1, motivo: 'ese mensaje es de otra sesión' };
  if (mine.some((r) => r.estado === 'verificado')) return { code: 1, motivo: 'ese mensaje ya se usó: cada uno sirve una sola vez' };
  if (!mine.some((r) => r.estado === 'recibido')) return { code: 1, motivo: 'ese mensaje no se le entregó a esta sesión' };
  const p = paths(sdir);
  try {
    privateDir(p.used);
    const fd = fs.openSync(path.join(p.used, id), 'wx', 0o600);
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === 'EEXIST') return { code: 1, motivo: 'ese mensaje ya se usó: cada uno sirve una sola vez' };
    return { code: 2, motivo: `no pude marcarlo como usado (${e.code || 'error'}): no pude comprobar el mensaje` };
  }
  record(sdir, { id, sid, text: sent.texto, estado: 'verificado', at: now });
  return { code: 0, text: sent.texto };
}

/** ¿La ruta es del buzón, de lo tomado, de lo usado, del registro o de un candado? Es lo que el freno no deja escribir. */
function isMailboxPath(sdir, file) {
  const p = paths(sdir);
  const abs = path.resolve(String(file));
  const inside = (root) => abs === root || abs.startsWith(root + path.sep);
  return inside(p.inboxRoot) || inside(p.takenRoot) || inside(p.used) || inside(p.watchers) || abs === p.log || abs === p.logPrevious;
}

// --- el vigilante de cada sesión ----------------------------------------------------------------------------------

/** La hora de arranque de un proceso, para no confundir un pid reutilizado; null si no se sabe (Windows o sin `ps`). */
function processStart(pid) {
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const t = r.status === 0 ? r.stdout.trim() : '';
  return t || null;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * El estado del vigilante de una sesión: `{ alive: true }` con uno escuchando; `{ alive: false, deliveredAt }` si el último
 * entregó y se fue (la sesión arma otro al cerrar su turno); `{ alive: false }` sin ninguno. Vivo es su pid vivo con la
 * misma hora de arranque que anotó: un candado sin esa hora no pasa por vivo (salvo en Windows, donde no se sabe).
 */
function watcherState(sdir, sid, { isAlive = pidAlive, startOf = processStart } = {}) {
  let lock;
  try { lock = readJson(paths(sdir).watcher(sid)); } catch { return { alive: false }; }
  if (!lock) return { alive: false };
  if (Number.isInteger(lock.pid) && isAlive(lock.pid)) {
    const started = startOf(lock.pid);
    if (started === (lock.started == null ? null : lock.started) && (started !== null || process.platform === 'win32')) return { alive: true, pid: lock.pid };
  }
  return { alive: false, ...(Number.isFinite(lock.deliveredAt) ? { deliveredAt: lock.deliveredAt } : {}) };
}

module.exports = {
  MAX_TEXT, MAX_WAITING, KEEP_LINES, DEADLINE_MS, TAKEN_KEEP_MS, STATES, PREFIX,
  paths, newId, envelope, looksLikeApproval, checkText, record, trimLog, readLog, waiting, leave, expire, take, sweep, verify,
  isMailboxPath, processStart, watcherState, writePrivate, privateDir, privateTree,
};
