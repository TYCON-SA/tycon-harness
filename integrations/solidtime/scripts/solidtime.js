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
// El estado de la máquina, en `stateDir`: `identity.json` (organización y miembro, por instancia) y
// `sessions/<sesión>.json` (la entrada abierta por esa sesión: id, historia, última actividad).
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

async function start(api, ev) {
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
    const prev = listSessions(ev.stateDir).filter((s) => s.data.entryId === running.id);
    await close(api, id.organization, running.id, prev.length ? latest(prev) : ev.at);
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
 * cierre falla queda, y el próximo stop o sweep lo reintenta.
 */
async function stop(api, ev) {
  const file = sessionFile(ev.stateDir, ev.sessionId);
  const own = readSession(file);
  if (!own) return {};
  const now = Date.parse(ev.at);
  const others = listSessions(ev.stateDir).filter((s) => s.file !== file && s.data.entryId === own.entryId);
  if (others.some((s) => !isIdle(s, now))) { fs.rmSync(file, { force: true }); return {}; }
  const id = await identity(api, ev.stateDir);
  const running = await active(api);
  let out = {};
  if (running && running.id === own.entryId) {
    const seconds = await close(api, id.organization, running.id, ev.at);
    if (seconds !== null) out = { seconds };
  }
  for (const f of [file, ...others.map((s) => s.file)]) fs.rmSync(f, { force: true });
  return out;
}

function listSessions(stateDir) {
  const dir = path.join(stateDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  return names.map((n) => ({ file: path.join(dir, n), data: readJson(path.join(dir, n)) })).filter((s) => s.data && s.data.entryId);
}

/**
 * Cierra las entradas que quedaron sin actividad hace más de 15 minutos. Las sesiones se agrupan por entrada: una
 * entrada se cierra sólo si TODAS sus sesiones están quietas, una sola vez, con la actividad más reciente de todas.
 */
async function sweep(api, ev) {
  const now = Date.parse(ev.at);
  const byEntry = new Map();
  for (const s of listSessions(ev.stateDir)) {
    if (!byEntry.has(s.data.entryId)) byEntry.set(s.data.entryId, []);
    byEntry.get(s.data.entryId).push(s);
  }
  const idle = [...byEntry.entries()].filter(([, list]) => list.every((s) => isIdle(s, now)));
  if (!idle.length) return {};
  const id = await identity(api, ev.stateDir);
  const running = await active(api);
  for (const [entryId, list] of idle) {
    if (running && running.id === entryId) await close(api, id.organization, entryId, latest(list));
    for (const s of list) fs.rmSync(s.file, { force: true });
  }
  return {};
}

/** Los avisos de configuración faltante: dónde se pone cada cosa. */
function missingLines(ev) {
  const out = [];
  for (const m of Array.isArray(ev.missing) ? ev.missing : []) {
    if (m.where === 'profile') out.push('solidtime: falta la URL de la instancia — la pone la organización en el sitio (Configuración → Integraciones → Registro de horas); sigo sin registrar');
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
  const missing = missingLines(ev);
  if (missing.length) return { result: {}, warnings: missing };
  const settings = ev.settings && typeof ev.settings === 'object' ? ev.settings : {};
  if (!settings.url || !settings.token) return { result: {}, warnings: ['solidtime: el evento llegó sin la URL o sin el token; sigo sin registrar'] };
  const url = String(settings.url);
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(url)) return { result: {}, warnings: ['solidtime: la URL de la instancia tiene que empezar con https:// (o http://localhost para probar): el token no viaja en claro; sigo sin registrar'] };
  const api = { url, token: String(settings.token), timeoutMs };
  if (ev.event === 'start') return { result: await start(api, ev), warnings: [] };
  if (ev.event === 'stop') return { result: await stop(api, ev), warnings: [] };
  if (ev.event === 'sweep') return { result: await sweep(api, ev), warnings: [] };
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
