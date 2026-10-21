'use strict';
// solidtime.js — la entrada de horas de una persona en Solidtime, por la API de su instancia, sin dependencias.
//
// Lo que se usa de la API (base `<url>/api/v1`, `Authorization: Bearer <token>`):
//   GET  /users/me/memberships                    la organización y el miembro (se guardan en la máquina)
//   GET  /organizations/{org}/projects            para buscar el proyecto por el nombre de la carpeta del repo
//   GET  /users/me/time-entries/active            la que corre; 404 = ninguna, no es un error
//   POST /organizations/{org}/time-entries        abrir (con otra abierta da 400 time_entry_still_running: se evita)
//   PUT  /organizations/{org}/time-entries/{id}   cerrar con `end`; devuelve `duration` en segundos
// La hora va siempre en UTC con Z y sin milésimas: con desfase, la API contesta 422.
//
// Una historia nunca se frena por esto: todo error termina en un aviso de una línea y en errors.jsonl (la acción y el
// código, nunca el token, la URL ni el cuerpo de la respuesta).
//
// El estado de la máquina, en `stateDir`: `identity.json` (organización y miembro, por instancia),
// `sessions/<sesión>.json` (la entrada abierta por esa sesión: id, historia, última actividad) y `closed.json` (los
// segundos de cada historia que ya se cerraron antes de su `stop`: por inactividad o al abrir otra). El `stop` de una
// historia devuelve lo de su entrada abierta más eso, y lo saca: es el tiempo que el paso 9 suma a CompletedWork.
//
// Casos: scripts/tests/solidtime-integration.test.js.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const IDLE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;

const utc = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

class ApiError extends Error {
  constructor(action, detail) { super(`${action} (${detail})`); this.action = action; this.detail = detail; }
}

/** Un pedido a la API: `{ status, data }`. Tira ApiError con el código, la falta de conexión o el tiempo agotado. */
function request({ url, token, timeoutMs }, method, route, body, action) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url.replace(/\/+$/, '')}/api/v1${route}`);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = lib.request(target, { method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new ApiError(action, `tiempo agotado, ${Math.round(timeoutMs / 1000)} s`)); });
    req.on('error', (e) => reject(e instanceof ApiError ? e : new ApiError(action, `sin conexión: ${e.code || 'error de red'}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Un pedido que tiene que salir bien (o con uno de los códigos esperados). */
async function call(api, method, route, body, action, ok = [200, 201]) {
  const r = await request(api, method, route, body, action);
  if (!ok.includes(r.status)) throw new ApiError(action, `HTTP ${r.status}`);
  return r;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const sessionFile = (stateDir, session) => path.join(stateDir, 'sessions', `${session}.json`);

/** La organización y el miembro de la persona en esa instancia, de la máquina o de la API (una vez). */
async function identity(api, stateDir) {
  const file = path.join(stateDir, 'identity.json');
  const saved = readJson(file);
  if (saved && saved.url === api.url && saved.organization && saved.member) return saved;
  const r = await call(api, 'GET', '/users/me/memberships', undefined, 'leer tu organización');
  const first = r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
  if (!first || !first.organization || !first.organization.id || !first.id) throw new ApiError('leer tu organización', 'tu usuario no es miembro de ninguna');
  const out = { url: api.url, organization: first.organization.id, member: first.id };
  writeJson(file, out);
  return out;
}

/** La entrada que corre, o null (404 es «ninguna»). */
async function active(api) {
  const r = await call(api, 'GET', '/users/me/time-entries/active', undefined, 'leer la entrada abierta', [200, 404]);
  return r.status === 404 ? null : (r.data && r.data.data) || null;
}

/** El proyecto por el nombre de la carpeta del repo: igual (sin mayúsculas) y, si no, el único que lo contiene. */
async function projectFor(api, org, repo) {
  const name = path.basename(String(repo || '')).toLowerCase();
  if (!name) return null;
  const r = await call(api, 'GET', `/organizations/${encodeURIComponent(org)}/projects`, undefined, 'leer los proyectos');
  const list = r.data && Array.isArray(r.data.data) ? r.data.data : [];
  const exact = list.find((p) => String(p.name || '').toLowerCase() === name);
  if (exact) return exact.id;
  const partial = list.filter((p) => { const n = String(p.name || '').toLowerCase(); return n && (n.includes(name) || name.includes(n)); });
  return partial.length === 1 ? partial[0].id : null;
}

async function close(api, org, id, end) {
  const r = await call(api, 'PUT', `/organizations/${encodeURIComponent(org)}/time-entries/${encodeURIComponent(id)}`, { end }, 'cerrar la entrada');
  const d = r.data && r.data.data;
  return d && Number.isInteger(d.duration) ? d.duration : null;
}

const descriptionOf = (ev) => `Story ${ev.storyId || '?'}${ev.title ? ` — ${ev.title}` : ''}`.slice(0, 200);
const sameStory = (entry, ev) => String(entry.description || '').startsWith(`Story ${ev.storyId} `) || entry.description === `Story ${ev.storyId}`;
/** La historia de una entrada: la de las sesiones que la seguían o, si no, la de su descripción («Story <id> — …»). */
const storyOf = (list, entry) => {
  const s = list.find((x) => x.data && x.data.storyId);
  if (s) return s.data.storyId;
  const m = /^Story (\S+)(?: |$)/.exec(String((entry && entry.description) || ''));
  return m && m[1] !== '?' ? m[1] : null;
};

/**
 * Los segundos ya cerrados de cada historia, hasta su `stop`: `{ all, damaged }`. Un archivo que está y no se lee es
 * «dañado», no «vacío»: no se pisa (se perderían los segundos de las otras historias) y se dice.
 */
const closedFile = (stateDir) => path.join(stateDir, 'closed.json');
function readClosed(stateDir, warnings) {
  const file = closedFile(stateDir);
  if (!fs.existsSync(file)) return { all: {}, damaged: false };
  const all = readJson(file);
  if (all && typeof all === 'object' && !Array.isArray(all)) return { all, damaged: false };
  logError(stateDir, 'leer los segundos ya cerrados', 'closed.json está dañado');
  warnings.push('solidtime: el archivo de los segundos ya cerrados (closed.json) está dañado; no lo toco y esos segundos no se suman');
  return { all: {}, damaged: true };
}
function credit(stateDir, entry, storyId, seconds, warnings) {
  if (seconds === null) { warnings.push(`solidtime: cerré la entrada ${entry}, pero la instancia no informó su duración; esos segundos no se suman`); return; }
  if (!Number.isInteger(seconds) || seconds <= 0) return;
  if (!storyId) { warnings.push(`solidtime: cerré la entrada ${entry}, pero no sé de qué historia era; sus segundos no se suman`); return; }
  const c = readClosed(stateDir, warnings);
  if (c.damaged) return;
  c.all[storyId] = (Number.isInteger(c.all[storyId]) ? c.all[storyId] : 0) + seconds;
  writeJson(closedFile(stateDir), c.all);
}
const banked = (stateDir, storyId, warnings) => {
  const { all } = readClosed(stateDir, warnings);
  const v = Object.prototype.hasOwnProperty.call(all, storyId) ? all[storyId] : 0;
  return Number.isInteger(v) ? v : 0;
};
function forget(stateDir, storyId) {
  const c = readClosed(stateDir, []);
  if (c.damaged || !Object.prototype.hasOwnProperty.call(c.all, storyId)) return;
  delete c.all[storyId];
  writeJson(closedFile(stateDir), c.all);
}

async function start(api, ev, warnings) {
  const id = await identity(api, ev.stateDir);
  const running = await active(api);
  const own = readJson(sessionFile(ev.stateDir, ev.sessionId));
  if (running && (sameStory(running, ev) || (own && own.entryId === running.id && own.storyId === ev.storyId))) {
    writeJson(sessionFile(ev.stateDir, ev.sessionId), { entryId: running.id, storyId: ev.storyId, description: running.description, startedAt: running.start, lastActivity: ev.at });
    return {};
  }
  if (running) {
    // otra historia corriendo: se cierra antes de abrir (una sola abierta por persona); si la seguían sesiones de esta
    // máquina, con la actividad más reciente de todas ellas
    const prev = listSessions(ev.stateDir).filter((s) => !s.damaged && s.data.entryId === running.id);
    const seconds = await close(api, id.organization, running.id, prev.length ? latest(prev) : ev.at);
    credit(ev.stateDir, running.id, storyOf(prev, running), seconds, warnings);
    for (const s of prev) fs.rmSync(s.file, { force: true });
  }
  const project = await projectFor(api, id.organization, ev.repo);
  const body = { member_id: id.member, start: ev.at, end: null, billable: true, description: descriptionOf(ev), tags: [] };
  if (project) body.project_id = project;
  const r = await call(api, 'POST', `/organizations/${encodeURIComponent(id.organization)}/time-entries`, body, 'abrir la entrada');
  const entry = r.data && r.data.data;
  if (!entry || !entry.id) throw new ApiError('abrir la entrada', 'la respuesta no trae la entrada');
  writeJson(sessionFile(ev.stateDir, ev.sessionId), { entryId: entry.id, storyId: ev.storyId, description: body.description, startedAt: ev.at, lastActivity: ev.at });
  return {};
}

/** La sesión guardada, o null si no hay; un archivo que no se lee es un error (no se confunde con «no hay»). */
function readSession(file) {
  if (!fs.existsSync(file)) return null;
  const d = readJson(file);
  if (!d || !d.entryId) throw new ApiError('leer el estado de la sesión', `${path.basename(file)} está dañado`);
  return d;
}

function activity(ev) {
  const file = sessionFile(ev.stateDir, ev.sessionId);
  const own = readSession(file);
  if (own) writeJson(file, Object.assign(own, { lastActivity: ev.at }));
  return {};
}

const lastOf = (s) => s.data.lastActivity || s.data.startedAt;
const isIdle = (s, now) => now - Date.parse(lastOf(s)) > IDLE_MS;
/** La actividad más reciente de un grupo de sesiones (en UTC con Z se ordenan como texto). */
const latest = (list) => list.map(lastOf).sort().pop();

/**
 * Cierra la entrada de la sesión. Si otra sesión con actividad reciente comparte la entrada (dos sesiones con la misma
 * historia), no la cierra: sólo deja de seguirla. El archivo de la sesión se borra recién con el cierre hecho; si el
 * cierre falla queda, y el próximo stop o sweep lo reintenta. Una entrada que ya no corre en la herramienta, o un cierre
 * sin duración, se avisa: los segundos no se pierden en silencio.
 *
 * La entrada es la de la sesión o, si esta sesión no abrió ninguna (el paso 9 corre después del merge, muchas veces en
 * otra sesión), la de la misma historia que siga abierta en esta máquina. Los segundos son los de esa entrada más los
 * que la historia ya tenía cerrados (`closed.json`), que salen con el cierre hecho.
 */
function ownSession(ev) {
  const file = sessionFile(ev.stateDir, ev.sessionId);
  const data = readSession(file);
  if (data) return { file, data };
  if (!ev.storyId) return null;
  const same = listSessions(ev.stateDir).find((s) => !s.damaged && s.data.storyId === ev.storyId);
  return same ? { file: same.file, data: same.data } : null;
}

/** El `stop` sin entrada abierta de la historia: no llama a la API y devuelve lo que ya estaba cerrado. */
function stopWithoutEntry(ev, warnings) {
  const prior = ev.storyId ? banked(ev.stateDir, ev.storyId, warnings) : 0;
  if (!prior) return {};
  forget(ev.stateDir, ev.storyId);
  return { seconds: prior };
}

async function stop(api, ev, warnings) {
  const found = ownSession(ev);
  if (!found) return stopWithoutEntry(ev, warnings);
  const { file, data: own } = found;
  const now = Date.parse(ev.at);
  const others = listSessions(ev.stateDir).filter((s) => !s.damaged && s.file !== file && s.data.entryId === own.entryId);
  if (others.some((s) => !isIdle(s, now))) { fs.rmSync(file, { force: true }); return {}; }
  const id = await identity(api, ev.stateDir);
  const running = await active(api);
  const prior = banked(ev.stateDir, own.storyId, warnings);
  let seconds = null;
  if (running && running.id === own.entryId) {
    seconds = await close(api, id.organization, running.id, ev.at);
    if (seconds === null) warnings.push('solidtime: cerré la entrada, pero la instancia no informó su duración; sumo sólo lo que ya estaba cerrado');
  } else {
    warnings.push(`solidtime: la entrada de esta sesión (${own.entryId}) ya no estaba abierta en la instancia; sumo sólo lo que ya estaba cerrado`);
  }
  for (const f of [file, ...others.map((s) => s.file)]) fs.rmSync(f, { force: true });
  forget(ev.stateDir, own.storyId);
  return seconds !== null || prior ? { seconds: (seconds || 0) + prior } : {};
}

/** Las sesiones guardadas: `[{ file, data, damaged }]`; una que no se lee viene con `damaged: true` (nunca se descarta). */
function listSessions(stateDir) {
  const dir = path.join(stateDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.includes('.tmp-')); } catch (_) { return []; }
  return names.map((n) => {
    const data = readJson(path.join(dir, n));
    return { file: path.join(dir, n), data: data && data.entryId ? data : null, damaged: !(data && data.entryId) };
  });
}

/**
 * Cierra las entradas que quedaron sin actividad hace más de 15 minutos. Las sesiones se agrupan por entrada: una
 * entrada se cierra sólo si TODAS sus sesiones están quietas, una sola vez, con la actividad más reciente de todas. Una
 * sesión dañada se anota y se borra: no se sabe qué entrada seguía, y dejarla trabaría el cierre de las demás.
 */
async function sweep(api, ev, warnings) {
  const now = Date.parse(ev.at);
  const byEntry = new Map();
  for (const s of listSessions(ev.stateDir)) {
    if (s.damaged) {
      logError(ev.stateDir, 'leer el estado de la sesión', `${path.basename(s.file)} está dañado`);
      warnings.push(`solidtime: el estado de la sesión ${path.basename(s.file, '.json')} está dañado; lo saco (si quedó una entrada abierta, la cierra el próximo start)`);
      fs.rmSync(s.file, { force: true });
      continue;
    }
    if (!byEntry.has(s.data.entryId)) byEntry.set(s.data.entryId, []);
    byEntry.get(s.data.entryId).push(s);
  }
  const idle = [...byEntry.entries()].filter(([, list]) => list.every((s) => isIdle(s, now)));
  if (!idle.length) return {};
  const id = await identity(api, ev.stateDir);
  const running = await active(api);
  for (const [entryId, list] of idle) {
    if (running && running.id === entryId) credit(ev.stateDir, entryId, storyOf(list, running), await close(api, id.organization, entryId, latest(list)), warnings);
    else warnings.push(`solidtime: la entrada ${entryId} ya no estaba abierta en la instancia; la dejo de seguir y sus segundos no se suman`);
    for (const s of list) fs.rmSync(s.file, { force: true });
  }
  return {};
}

/** Los avisos de configuración faltante: dónde se pone cada cosa. */
function missingLines(ev) {
  const out = [];
  for (const m of Array.isArray(ev.missing) ? ev.missing : []) {
    if (m.where === 'profile') out.push('solidtime: falta la URL de la instancia — la pone la organización en el sitio (Configuración → Integraciones → Registro de horas); sigo sin registrar');
    else if (m.damaged) out.push(`solidtime: el archivo de tu token está dañado (${m.file || 'secrets/solidtime.json'}): arreglalo o borralo y volvé a guardarlo con harness.js config set solidtime.token; sigo sin registrar`);
    else out.push(`solidtime: falta tu token — guardalo con: ${m.how || 'harness.js config set solidtime.token'} (se pega en la terminal, sin eco); sigo sin registrar`);
  }
  return out;
}

function logError(stateDir, action, detail) {
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(stateDir, 'errors.jsonl'), `${JSON.stringify({ at: utc(Date.now()), action, detail })}\n`, { mode: 0o600 });
  } catch (_) { /* anotar nunca frena */ }
}

async function dispatch(ev, timeoutMs) {
  if (ev.event === 'activity') return { result: activity(ev), warnings: [] };
  // el cierre por inactividad corre con cada mensaje de la persona: sin sesiones guardadas no hay nada que cerrar, y
  // tampoco se repite en cada mensaje que falta configurar algo (eso lo dice `start`)
  if (ev.event === 'sweep' && !listSessions(ev.stateDir).length) return { result: {}, warnings: [] };
  // sin entrada abierta de la historia, el `stop` no llama a la API (AC 9): lo ya cerrado sale igual, sin ajustes
  if (ev.event === 'stop' && !ownSession(ev)) { const warnings = []; return { result: stopWithoutEntry(ev, warnings), warnings }; }
  const missing = missingLines(ev);
  if (missing.length) return { result: {}, warnings: missing };
  const settings = ev.settings && typeof ev.settings === 'object' ? ev.settings : {};
  if (!settings.url || !settings.token) return { result: {}, warnings: ['solidtime: el evento llegó sin la URL o sin el token; sigo sin registrar'] };
  const url = String(settings.url);
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(url)) return { result: {}, warnings: ['solidtime: la URL de la instancia tiene que empezar con https:// (o http://localhost para probar): el token no viaja en claro; sigo sin registrar'] };
  const api = { url, token: String(settings.token), timeoutMs };
  if (ev.event === 'start') { const warnings = []; return { result: await start(api, ev, warnings), warnings }; }
  if (ev.event === 'stop' || ev.event === 'sweep') {
    const warnings = [];
    const result = ev.event === 'stop' ? await stop(api, ev, warnings) : await sweep(api, ev, warnings);
    return { result, warnings };
  }
  return { result: {}, warnings: [`solidtime: evento desconocido «${String(ev.event).slice(0, 20)}»`] };
}

/**
 * Atiende un evento. `{ result, warnings }`; nunca tira: cualquier error es un aviso de una línea y una línea en
 * errors.jsonl. `ev.settings.url` y `ev.settings.token` vienen del núcleo; `ev.stateDir`, dónde guardar el estado.
 */
async function handle(ev, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!ev || typeof ev !== 'object' || !ev.stateDir || !SESSION_RE.test(String(ev.sessionId || 'sin-sesion'))) return { result: {}, warnings: ['solidtime: el evento llegó sin sesión o sin carpeta de estado; sigo sin registrar'] };
  if (!ev.sessionId) ev.sessionId = 'sin-sesion';
  try {
    return await dispatch(ev, timeoutMs);
  } catch (e) {
    const action = e instanceof ApiError ? e.action : `atender «${String(ev.event).slice(0, 20)}»`;
    const detail = e instanceof ApiError ? e.detail : (e && e.code) || 'error inesperado';
    logError(ev.stateDir, action, detail);
    return { result: {}, warnings: [`solidtime: no pude ${action} (${detail}); sigo sin registrar`] };
  }
}

module.exports = { handle, IDLE_MS, DEFAULT_TIMEOUT_MS };
