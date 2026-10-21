'use strict';

/**
 * solidtime-integration.test.js — la integración de Solidtime, de punta a punta por el evento neutro.
 *
 * Un servidor de mentira contesta como la API de Solidtime (memberships, projects, la entrada activa con
 * 404 cuando no hay ninguna, abrir con 400 `time_entry_still_running` si ya hay otra, cerrar con `duration`, 401 con un
 * token que no es el suyo). Cada caso corre `scripts/lib/work-signal.js` con la integración real de `integrations/`,
 * la URL en un perfil de laboratorio y el token por su variable, armado por partes.
 *
 *   T6  · `start` abre la entrada con la hora en UTC con Z, la descripción de la historia y el proyecto del repo.
 *   T7  · con otra entrada abierta la cierra antes de abrir; con una de la misma historia la reusa. Nunca recibe 400.
 *   T8  · el cierre por inactividad: última actividad hace 20 minutos → PUT con `end` en esa hora.
 *   T9  · `active` con 404 es «no hay ninguna»: abre sin aviso.
 *   T10 · sin URL o sin token: dice cuál falta y dónde se pone; sale 0.
 *   T11 · 401, 422, red caída y tiempo agotado: aviso con el código, sale 0, el token no sale en ningún lado.
 *   T25 · `activity` no llama a la API; `stop` cierra con un PUT.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'work-signal.js');
const TOKEN = ['st', 'lab', 'x9Q2', 'w7Zk', 'marca'].join('-');
const ORG = 'org-1';
const MEMBER = 'mem-1';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

/** La API de mentira. `state.active` es la entrada que corre (o null); `calls` anota cada pedido. */
function fakeApi({ mode = 'ok' } = {}) {
  const state = { active: null, calls: [], seq: 0, projects: [{ id: 'prj-acme', name: 'acme-repo' }, { id: 'prj-otro', name: 'otro' }] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      state.calls.push({ method: req.method, url: req.url, body: json, auth: req.headers.authorization });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (mode === 'timeout') return;   // nunca contesta: tiempo agotado
      if (mode === '422') return send(422, { message: 'The given data was invalid.' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
      const u = req.url.replace(/^\/api\/v1/, '');
      if (req.method === 'GET' && u === '/users/me/memberships') return send(200, { data: [{ id: MEMBER, organization: { id: ORG, name: 'Acme' } }] });
      if (req.method === 'GET' && u.startsWith(`/organizations/${ORG}/projects`)) return send(200, { data: state.projects });
      if (req.method === 'GET' && u === '/users/me/time-entries/active') return state.active ? send(200, { data: state.active }) : send(404, { message: 'No active time entry' });
      if (req.method === 'POST' && u === `/organizations/${ORG}/time-entries`) {
        if (state.active) return send(400, { error: true, key: 'time_entry_still_running', message: 'Time entry is still running' });
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(json.start)) return send(422, { message: 'The start field must match the format Y-m-d\\TH:i:s\\Z.' });
        state.active = { id: `ent-${++state.seq}`, start: json.start, end: null, description: json.description, project_id: json.project_id || null, member_id: json.member_id };
        return send(201, { data: state.active });
      }
      const m = /^\/organizations\/org-1\/time-entries\/([^/?]+)$/.exec(u);
      if (req.method === 'PUT' && m) {
        if (state.failPut) return send(500, { message: 'Server Error' });
        if (!state.active || state.active.id !== m[1]) return send(404, { message: 'not found' });
        if (json.end) {
          const seconds = Math.round((Date.parse(json.end) - Date.parse(state.active.start)) / 1000);
          if (seconds < 0) return send(422, { message: 'The end field must be a date after or equal to start.' });
          const closed = Object.assign({}, state.active, { end: json.end, duration: seconds });
          state.active = null;
          return send(200, { data: closed });
        }
        Object.assign(state.active, json);
        return send(200, { data: state.active });
      }
      return send(404, { message: 'no existe en la API de mentira' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://localhost:${server.address().port}` })));
}

function lab({ url, token = TOKEN } = {}) {
  const home = tmp('st-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const tyconHome = path.join(home, '.tycon');
  const profile = path.join(home, 'team-profile.json');
  const integrations = url === undefined ? { timeTracking: 'solidtime' } : { timeTracking: 'solidtime', solidtime: { url } };
  fs.writeFileSync(profile, JSON.stringify({ integrations }));
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: tyconHome, TYCON_PROFILE: profile, TYCON_SOLIDTIME_TIMEOUT_MS: '1500' });
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR', 'TYCON_SOLIDTIME_TOKEN']) delete env[k];
  if (token) env.TYCON_SOLIDTIME_TOKEN = token;
  return { home, tyconHome, env };
}

function run(event, l, { story = '7.40', session = 'ses-1', title = 'El registro de horas' } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, event, '--story', story, '--title', title, '--repo', '/tmp/acme-repo', '--session', session], { env: l.env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Todo lo que la integración escribió en la casa del arnés, para buscar el token. */
function everythingWritten(dir) {
  if (!fs.existsSync(dir)) return '';
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? everythingWritten(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
}

const posts = (s) => s.calls.filter((c) => c.method === 'POST');
const puts = (s) => s.calls.filter((c) => c.method === 'PUT');

test('Solidtime_Start_OpensUtcEntry @story-7.40 @ac-6', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    const r = await run('start', l);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stderr.trim(), '', 'abrir no avisa nada');
    const [post] = posts(api.state);
    assert.ok(post, 'abrió una entrada');
    assert.match(post.body.start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.strictEqual(post.body.end, null);
    assert.strictEqual(post.body.member_id, MEMBER);
    assert.strictEqual(post.body.project_id, 'prj-acme', 'el proyecto con el nombre de la carpeta del repo');
    assert.match(post.body.description, /^Story 7\.40 — El registro de horas$/);
    assert.deepStrictEqual(post.body.tags, []);
    // un repo sin proyecto con su nombre: sin proyecto, y la integración no crea ninguno
    api.state.active = null;
    api.state.projects = [{ id: 'prj-otro', name: 'otro' }];
    const r2 = await run('start', l, { story: '7.41', session: 'ses-2' });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.ok(!('project_id' in posts(api.state)[1].body) || posts(api.state)[1].body.project_id === null);
    assert.ok(!api.state.calls.some((c) => c.method === 'POST' && /projects/.test(c.url)), 'no crea proyectos');
  } finally { api.server.close(); }
});

test('Solidtime_Start_ClosesRunningFirst @story-7.40 @ac-7', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    // otra historia corriendo (abierta desde otro lado)
    // stable-data: la hora es relativa al momento de la prueba (diez minutos antes); ninguna aserción depende del día
    api.state.active = { id: 'ent-ajena', start: new Date(Date.now() - 600000).toISOString().replace(/\.\d{3}Z$/, 'Z'), end: null, description: 'Story 9.9 — otra cosa' };
    const r = await run('start', l);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(puts(api.state).some((c) => /ent-ajena$/.test(c.url) && c.body.end), 'cerró la que corría');
    assert.strictEqual(posts(api.state).length, 1, 'abrió una sola');
    assert.ok(!r.stderr.includes('still_running'), 'nunca recibió 400');
    // la misma historia otra vez: la reusa
    const antes = posts(api.state).length;
    const r2 = await run('start', l);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(posts(api.state).length, antes, 'la misma historia reusa la abierta');
    assert.ok(api.state.active, 'sigue abierta');
  } finally { api.server.close(); }
});

test('Solidtime_IdleClose_EndsAtLastActivity @story-7.40 @ac-8', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    const r = await run('start', l);
    assert.strictEqual(r.status, 0, r.stderr);
    // la última actividad, hace 20 minutos
    const stateDir = path.join(l.tyconHome, 'state', 'time-tracking', 'solidtime');
    const file = path.join(stateDir, 'sessions', 'ses-1.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = new Date(Date.now() - 20 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    s.lastActivity = last;
    api.state.active.start = new Date(Date.now() - 40 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.writeFileSync(file, JSON.stringify(s));
    const sw = await run('sweep', l);
    assert.strictEqual(sw.status, 0, sw.stderr);
    const put = puts(api.state).find((c) => c.body.end);
    assert.ok(put, 'la cerró');
    assert.strictEqual(put.body.end, last, 'con el fin en la última actividad');
    assert.strictEqual(api.state.active, null);
    assert.ok(!fs.existsSync(file), 'la sesión cerrada sale del estado');
    // una sesión con actividad reciente no se toca
    await run('start', l, { story: '7.42', session: 'ses-3' });
    const n = puts(api.state).length;
    await run('sweep', l);
    assert.strictEqual(puts(api.state).length, n);
  } finally { api.server.close(); }
});

test('Solidtime_SharedEntry_ClosesOnlyWhenAllIdle @story-7.40 @ac-8', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    // dos sesiones de la misma historia comparten la entrada abierta
    await run('start', l, { session: 'ses-a' });
    await run('start', l, { session: 'ses-b' });
    assert.strictEqual(posts(api.state).length, 1, 'la segunda reusa la de la primera');
    const dir = path.join(l.tyconHome, 'state', 'time-tracking', 'solidtime', 'sessions');
    const set = (s, minutes) => {
      const f = path.join(dir, `${s}.json`);
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      d.lastActivity = new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      fs.writeFileSync(f, JSON.stringify(d));
      return d.lastActivity;
    };
    api.state.active.start = new Date(Date.now() - 60 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    set('ses-a', 30);
    set('ses-b', 1);
    await run('sweep', l);
    assert.strictEqual(puts(api.state).length, 0, 'con otra sesión viva sobre la entrada, no la cierra');
    assert.ok(api.state.active, 'sigue abierta');
    // el stop de una no cierra la entrada que la otra sigue usando
    const s1 = await run('stop', l, { session: 'ses-a' });
    assert.deepStrictEqual(JSON.parse(s1.stdout.trim()), {});
    assert.strictEqual(puts(api.state).length, 0);
    // las dos quietas: un solo cierre, con la última actividad de todas
    await run('start', l, { session: 'ses-a' });
    set('ses-a', 40);
    const last = set('ses-b', 20);
    await run('sweep', l);
    const closes = puts(api.state).filter((c) => c.body.end);
    assert.strictEqual(closes.length, 1, 'un solo PUT');
    assert.strictEqual(closes[0].body.end, last, 'con la actividad más reciente');
  } finally { api.server.close(); }
});

test('Solidtime_StopFails_KeepsSessionForSweep @story-7.40 @ac-8', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    await run('start', l);
    api.state.failPut = true;
    const s = await run('stop', l);
    assert.strictEqual(s.status, 0);
    assert.match(s.stderr, /HTTP 500/);
    const file = path.join(l.tyconHome, 'state', 'time-tracking', 'solidtime', 'sessions', 'ses-1.json');
    assert.ok(fs.existsSync(file), 'un cierre que falla deja la sesión, para que el próximo stop o sweep la cierre');
    api.state.failPut = false;
    const s2 = await run('stop', l);
    assert.ok(Number.isInteger(JSON.parse(s2.stdout.trim()).seconds), 'el reintento la cierra');
    assert.ok(!fs.existsSync(file));
  } finally { api.server.close(); }
});

test('Solidtime_NeverThrows_OneLineWarning @story-7.40 @ac-13', async () => {
  const { handle } = require(path.join(ROOT, 'integrations', 'solidtime', 'scripts', 'solidtime.js'));
  const stateDir = tmp('st-state-');
  // un evento sin ajustes (armado a mano, o de otro núcleo): aviso, nunca una excepción
  const r = await handle({ event: 'start', stateDir, sessionId: 'x' });
  assert.deepStrictEqual(r.result, {});
  assert.strictEqual(r.warnings.length, 1);
  // anotar la actividad donde no se puede escribir: sale 0 con un aviso de una línea
  const blocked = path.join(tmp('st-block-'), 'archivo');
  fs.writeFileSync(blocked, 'no es una carpeta');
  const p = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'integrations', 'solidtime', 'scripts', 'on-work.js')], {
    input: JSON.stringify({ event: 'activity', stateDir: blocked, sessionId: 'x', at: '2026-10-20T10:00:00Z', settings: {}, missing: [] }), encoding: 'utf8',
  });
  // sin sesión abierta no hay nada que anotar; con una, el error de escritura es un aviso
  assert.strictEqual(p.status, 0, p.stderr);
  const sess = path.join(stateDir, 'sessions');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'x.json'), JSON.stringify({ entryId: 'e', storyId: '1', lastActivity: '2026-10-20T09:00:00Z' }));
  fs.chmodSync(sess, 0o500);
  try {
    const q = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'integrations', 'solidtime', 'scripts', 'on-work.js')], {
      input: JSON.stringify({ event: 'activity', stateDir, sessionId: 'x', at: '2026-10-20T10:00:00Z', settings: {}, missing: [] }), encoding: 'utf8',
    });
    assert.strictEqual(q.status, 0, q.stderr);
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      const lines = q.stderr.trim().split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1, `un aviso de una línea (dio: ${q.stderr})`);
      assert.match(lines[0], /^solidtime: /);
    }
  } finally { fs.chmodSync(sess, 0o700); }
});

test('Solidtime_NoActive404_IsNotError @story-7.40 @ac-9', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    const r = await run('start', l);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr.trim(), '', 'el 404 de la activa no es un error');
    const i = api.state.calls.findIndex((c) => c.url.endsWith('/time-entries/active'));
    const j = api.state.calls.findIndex((c) => c.method === 'POST');
    assert.ok(i >= 0 && i < j, 'leyó la que corre antes de abrir');
    const st = await run('stop', l);
    const k = api.state.calls.map((c) => c.url).lastIndexOf('/api/v1/users/me/time-entries/active');
    assert.ok(k > j, 'stop también lee la que corre antes de cerrar');
    assert.strictEqual(st.status, 0);
  } finally { api.server.close(); }
});

test('Solidtime_MissingUrlOrToken_SaysWhich @story-7.40 @ac-12', async () => {
  const api = await fakeApi();
  try {
    const sinUrl = await run('start', lab({ url: undefined }));
    assert.strictEqual(sinUrl.status, 0);
    assert.match(sinUrl.stderr, /falta la URL/);
    assert.match(sinUrl.stderr, /sitio/);
    const sinToken = await run('start', lab({ url: api.url, token: null }));
    assert.strictEqual(sinToken.status, 0);
    assert.match(sinToken.stderr, /falta tu token/);
    assert.match(sinToken.stderr, /harness\.js config set solidtime\.token/);
    assert.strictEqual(api.state.calls.length, 0, 'sin URL o sin token no llama');
    // una URL que no es https (ni de esta máquina) no recibe el token
    const enClaro = await run('start', lab({ url: 'http://acme.example' }));
    assert.strictEqual(enClaro.status, 0);
    assert.match(enClaro.stderr, /https/);
  } finally { api.server.close(); }
});

test('Solidtime_ApiErrors_NeverLeakSecrets @story-7.40 @ac-13', async () => {
  const cases = [];
  const malToken = await fakeApi();
  const l1 = lab({ url: malToken.url, token: `${TOKEN}-otro` });
  cases.push(['401', await run('start', l1), l1]);
  malToken.server.close();
  const invalido = await fakeApi({ mode: '422' });
  const l2 = lab({ url: invalido.url });
  cases.push(['422', await run('start', l2), l2]);
  invalido.server.close();
  const caido = await fakeApi();
  const url = caido.url;
  await new Promise((r) => caido.server.close(r));
  const l3 = lab({ url });
  cases.push(['sin red', await run('start', l3), l3]);
  const colgado = await fakeApi({ mode: 'timeout' });
  const l4 = lab({ url: colgado.url });
  cases.push(['tiempo agotado', await run('start', l4), l4]);
  colgado.server.closeAllConnections && colgado.server.closeAllConnections();
  colgado.server.close();
  for (const [what, r, l] of cases) {
    assert.strictEqual(r.status, 0, `${what}: la historia sigue`);
    const lines = r.stderr.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${what}: un aviso de una línea (dio: ${r.stderr})`);
    assert.match(lines[0], /^solidtime: /);
    if (what === '401' || what === '422') assert.match(lines[0], new RegExp(`HTTP ${what}`));
    if (what === 'tiempo agotado') assert.match(lines[0], /tiempo agotado/);
    if (what === 'sin red') assert.match(lines[0], /sin conexión/);
    for (const text of [r.stdout, r.stderr, everythingWritten(l.tyconHome), everythingWritten(path.join(l.home, '.claude'))]) {
      assert.ok(!text.includes(TOKEN), `${what}: el token no sale`);
      assert.ok(!text.includes(TOKEN.slice(3, 15)), `${what}: ni un pedazo del token`);
    }
    const log = path.join(l.tyconHome, 'state', 'time-tracking', 'solidtime', 'errors.jsonl');
    assert.ok(fs.existsSync(log), `${what}: anota el código`);
  }
});

test('Solidtime_ActivityNoApi_StopCloses @story-7.40 @ac-8', async () => {
  const api = await fakeApi();
  try {
    const l = lab({ url: api.url });
    await run('start', l);
    const n = api.state.calls.length;
    const a = await run('activity', l);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(api.state.calls.length, n, 'activity: 0 llamadas');
    const s = await run('stop', l);
    assert.strictEqual(s.status, 0, s.stderr);
    const closes = puts(api.state).filter((c) => c.body.end);
    assert.strictEqual(closes.length, 1, 'stop: un PUT con end');
    const out = JSON.parse(s.stdout.trim());
    assert.ok(Number.isInteger(out.seconds) && out.seconds >= 0, 'stop devuelve los segundos registrados');
    assert.strictEqual(api.state.active, null);
    // stop sin nada abierto: {}
    const s2 = await run('stop', l);
    assert.deepStrictEqual(JSON.parse(s2.stdout.trim()), {});
  } finally { api.server.close(); }
});
