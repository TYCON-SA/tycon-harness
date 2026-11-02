'use strict';
/**
 * session-state.js — el archivo de estado de cada sesión de Claude o de Codex: `<estado>/sessions/<sesión>.json`.
 *
 * Lo que dice: `{schema: 1, session, tool, name, sentence, step, endAt, endWithoutHour, waitingForOwner, waitingFor,
 * updatedAt, pid}`. Lo escriben los que saben cada cosa: marker.js el paso, la oración y la hora de fin (`refresh`), y el
 * gancho scripts/hooks/session-state.js el arranque, la espera y el cierre. Cada uno lee el archivo, cambia sólo sus
 * campos y lo escribe entero, con un temporal que después se renombra; si lo que quedaría es lo mismo que ya dice (sin
 * contar `updatedAt`), no escribe, así la oficina no recibe un cambio falso. La oficina (scripts/tools/office.js) lo
 * prefiere a lo que deduce /wip, en lo que el archivo sabe.
 *
 * «Inactiva» (`isStale`): con pid, el proceso ya no existe; sin pid (Codex, o Claude sin su archivo de sesión), más de
 * 2 h sin cambios. Nadie reescribe el archivo para decir que sigue viva.
 *
 * Nada de esto frena: un error se anota en `<estado>/office/session-state-errors.log` (fuera de la carpeta que vigila la
 * oficina). Con `TYCON_SESSION_STATE=0` no se escribe nada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = 1;
const TOOLS = ['claude', 'codex'];
const FIELDS = ['schema', 'session', 'tool', 'name', 'sentence', 'step', 'endAt', 'endWithoutHour', 'waitingForOwner', 'waitingFor', 'updatedAt', 'pid'];
// la oración de una sesión sin pipeline ni trabajo suelto declarado: la misma que dice la oficina
const NO_PIPELINE = 'Trabaja sin pipeline.';
const DEAD_AFTER_MS = 2 * 3600 * 1000;
const LOG_MAX = 256 * 1024;

const safeSid = (sid) => String(sid || '').replace(/[^\w.-]/g, '_');
const dirOf = (sdir) => path.join(sdir, 'sessions');
const pathOf = (sdir, sid) => path.join(dirOf(sdir), `${safeSid(sid)}.json`);
const errorsLogOf = (sdir) => path.join(sdir, 'office', 'session-state-errors.log');
const enabled = (env = process.env) => env.TYCON_SESSION_STATE !== '0';

/** Anota un error, sin frenar: si tampoco se puede anotar, no queda nada que hacer. */
function logError(sdir, text) {
  try {
    const file = errorsLogOf(sdir);
    // la carpeta del proceso de la oficina, con el mismo permiso que le da él (guarda su candado)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, `${file}.1`); } catch { /* todavía no existe */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(text).replace(/\s+/g, ' ').slice(0, 500)}\n`);
  } catch { /* sin registro tampoco: el gancho sigue sin frenar */ }
}

/** Lo que tiene de malo un archivo ya leído, o null. */
function problemOf(s, sid) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'no es un objeto';
  if (s.schema !== SCHEMA) return `schema desconocido (${JSON.stringify(s.schema)})`;
  if (!TOOLS.includes(s.tool)) return `herramienta desconocida (${JSON.stringify(s.tool)})`;
  if (sid != null && s.session !== sid) return `dice ser de otra sesión (${JSON.stringify(s.session)})`;
  return null;
}

/** El archivo de una sesión: `{ state }` (null si no hay) o `{ problem }` si no se puede usar. */
function read(sdir, sid) {
  let text;
  try { text = fs.readFileSync(pathOf(sdir, sid), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: null } : { state: null, problem: `no se pudo leer (${e.code || e.message})` };
  }
  let s;
  try { s = JSON.parse(text); } catch (e) { return { state: null, problem: `JSON roto (${e.message})` }; }
  const problem = problemOf(s, sid);
  return problem ? { state: null, problem } : { state: s };
}

/** Todos los archivos de la carpeta: `{ states: [estado…], problems: ['<archivo>: <motivo>'] }`. Sólo `<sesión>.json`. */
function readAll(sdir) {
  const states = [];
  const problems = [];
  let names = [];
  try { names = fs.readdirSync(dirOf(sdir)).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`${dirOf(sdir)}: no se pudo leer (${e.code || e.message})`);
    return { states, problems };
  }
  for (const n of names.sort()) {
    const file = path.join(dirOf(sdir), n);
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`${file}: ${e instanceof SyntaxError ? `JSON roto (${e.message})` : `no se pudo leer (${e.code || e.message})`}`); continue; }
    // el nombre del archivo es el id saneado: se compara con el id del archivo saneado igual
    const problem = problemOf(s, null)
      || (safeSid(s.session) !== path.basename(n, '.json') ? `dice ser de otra sesión (${JSON.stringify(s.session)})` : null);
    if (problem) { problems.push(`${file}: ${problem}`); continue; }
    states.push(s);
  }
  return { states, problems };
}

const fresh = (sid, tool) => ({
  schema: SCHEMA, session: String(sid), tool, name: null, sentence: NO_PIPELINE, step: null, endAt: null, endWithoutHour: null,
  waitingForOwner: false, waitingFor: null, updatedAt: null, pid: null,
});
const withoutTime = (s) => JSON.stringify(FIELDS.filter((k) => k !== 'updatedAt').map((k) => s[k] === undefined ? null : s[k]));

/**
 * Cambia los campos de `patch` en el archivo de la sesión. Sin archivo, lo crea sólo con `create` (y `tool`); un archivo
 * roto se reemplaza sólo con `create`. La herramienta no cambia, salvo con `retool` y `tool`. Devuelve 'written', 'same' (ya decía eso), 'missing' (no existe y no se crea),
 * 'broken' (roto y no se crea), 'disabled' o 'error'.
 */
function update(sdir, sid, patch = {}, { create = false, tool = null, retool = false, now = Date.now(), env = process.env } = {}) {
  if (!enabled(env)) return 'disabled';
  if (!sid) return 'missing';
  try {
    const cur = read(sdir, sid);
    if (cur.problem && !create) {
      logError(sdir, `sesión ${sid}: su estado está roto y no se reescribe (${cur.problem})`);
      return 'broken';
    }
    if (!cur.state && !create) return 'missing';
    const base = cur.state || fresh(sid, TOOLS.includes(tool) ? tool : 'claude');
    const next = { ...base };
    for (const k of FIELDS) if (k in patch && !['schema', 'session', 'tool', 'updatedAt'].includes(k)) next[k] = patch[k];
    // `retool`: quien escribe sabe con certeza de qué herramienta es la sesión (un archivo creado con la equivocada se corrige)
    if (retool && TOOLS.includes(tool)) next.tool = tool;
    if (cur.state && withoutTime(cur.state) === withoutTime(next)) return 'same';
    next.updatedAt = new Date(now).toISOString();
    const ordered = {};
    for (const k of FIELDS) ordered[k] = next[k] === undefined ? null : next[k];
    const file = pathOf(sdir, sid);
    // privado, como el candado del proceso de la oficina: dice el nombre de la sesión, qué hace y qué espera
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return 'written';
  } catch (e) {
    try { fs.unlinkSync(`${pathOf(sdir, sid)}.${process.pid}.tmp`); } catch { /* no quedó */ }
    logError(sdir, `sesión ${sid}: no pude escribir su estado (${e.code || e.message})`);
    return 'error';
  }
}

/** Borra el archivo de la sesión (el cierre de Claude). Sin archivo, nada. */
function remove(sdir, sid, { env = process.env } = {}) {
  if (!enabled(env)) return 'disabled';
  try { fs.unlinkSync(pathOf(sdir, sid)); return 'removed'; } catch (e) {
    if (e.code === 'ENOENT') return 'missing';
    logError(sdir, `sesión ${sid}: no pude borrar su estado (${e.code || e.message})`);
    return 'error';
  }
}

const isAliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** ¿Inactiva? Con pid, si el proceso ya no existe; sin pid, si no cambió hace más de 2 h. */
function isStale(state, { now = Date.now(), isAlive = isAliveDefault } = {}) {
  if (!state) return true;
  const pid = Number(state.pid);
  if (state.pid != null && Number.isInteger(pid) && pid > 0) return !isAlive(pid);
  const at = Date.parse(state.updatedAt);
  return !Number.isFinite(at) || now - at > DEAD_AFTER_MS;
}

// Un marcador sin tocar hace más de un día no es la corrida de hoy: /wip tampoco lo muestra (su STALE_MS).
const MARKER_STALE_MS = 24 * 3600 * 1000;

/**
 * Lee un JSON del disco: null si no existe. Si existe y no se puede leer o está roto, tira: el paso que no se pudo leer
 * no se anota como «sin pipeline» (refresh lo deja en el registro y no escribe nada).
 */
function readJsonOrNull(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${file}: no se pudo leer (${e.code || e.message})`);
  }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file}: JSON roto (${e.message})`); }
}

function touchedAt(m, file) {
  const at = Date.parse(m && m.lastTouch);
  if (Number.isFinite(at)) return at;
  try { return fs.statSync(file).mtimeMs; } catch { return NaN; }
}

/**
 * El paso, la oración y la hora de fin, de lo que dice el disco: el marcador de la sesión (un pipeline con pasos
 * pendientes, tocado en el último día) y, sin pipeline, su carril de trabajo suelto. La hora es la misma que muestra
 * /wip. Un marcador o un carril que existe y no se puede leer tira: no se adivina.
 */
function fromDisk(sdir, sid, { home = os.homedir(), now = Date.now() } = {}) {
  const markerFile = path.join(sdir, 'active', `${safeSid(sid)}.json`);
  const m = readJsonOrNull(markerFile);
  const recent = m && now - touchedAt(m, markerFile) <= MARKER_STALE_MS;
  if (recent && Array.isArray(m.stepsPending) && m.stepsPending.length) {
    const steps = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
    // los dos esquemas: el nuevo (por nombre) y el viejo (por número), con el nombre llano de la tabla de pasos
    const pending = steps.schemeOf(m) !== null ? steps.pendingSteps(m) : [];
    const first = String(pending.length ? pending[0] : m.stepsPending[0]);
    const name = steps.stepName(first) || `paso ${first}`;
    let end = { endAt: null, endWithoutHour: 'sin datos' };
    try { end = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js')).endOf(m, { home, stateDir: sdir, now }); } catch (e) {
      end = { endAt: null, endWithoutHour: `la hora no se pudo calcular (${e.code || e.message})` };
      logError(sdir, `sesión ${sid}: la hora de fin no se pudo calcular (${e.code || e.message})`);
    }
    return { step: name, sentence: `Va por el paso «${name}».`, endAt: end.endAt == null ? null : new Date(end.endAt).toISOString(), endWithoutHour: end.endAt == null ? end.endWithoutHour : null };
  }
  const a = readJsonOrNull(path.join(sdir, 'adhoc', `${safeSid(sid)}.json`));
  if (a && typeof a.reason === 'string' && a.reason.trim()) {
    const { plain } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
    const until = Date.parse(a.until);
    return { step: null, sentence: plain(a.reason) || NO_PIPELINE, endAt: Number.isFinite(until) ? new Date(until).toISOString() : null, endWithoutHour: Number.isFinite(until) ? null : 'sin hora estimada' };
  }
  return { step: null, sentence: NO_PIPELINE, endAt: null, endWithoutHour: null };
}

/** Pone al día el paso, la oración y la hora con lo que dice el disco. Sin archivo, sólo lo crea con `create`. */
function refresh(sdir, sid, opts = {}) {
  if (!enabled(opts.env)) return 'disabled';
  if (!opts.create && !fs.existsSync(pathOf(sdir, sid))) return 'missing';
  let fields;
  try { fields = fromDisk(sdir, sid, opts); } catch (e) {
    logError(sdir, `sesión ${sid}: no pude leer su paso (${e.code || e.message})`);
    return 'error';
  }
  return update(sdir, sid, fields, opts);
}

module.exports = { SCHEMA, FIELDS, NO_PIPELINE, DEAD_AFTER_MS, dirOf, pathOf, errorsLogOf, enabled, logError, read, readAll, update, remove, isStale, fromDisk, refresh };
