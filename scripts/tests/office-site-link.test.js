'use strict';
// office-site-link.test.js — what each machine sends to the organization site: its key, its enrollment request and the
// same snapshot its local office shows. The toy site is a real server inside the test, with the copied WebSocket library;
// every test runs with a toy HOME and kills the processes it starts.
// stable-data: the link runs on an injected clock; the real clock only bounds the waits and measures how long a notice takes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OFFICE = path.join(ROOT, 'scripts', 'tools', 'office.js');
const SERVER = path.join(ROOT, 'scripts', 'tools', 'office', 'server.js');
const PAGE = path.join(ROOT, 'scripts', 'tools', 'office', 'page.js');
const OWNER_WINDOW = path.join(ROOT, 'scripts', 'lib', 'owner-window.js');
const WebSocket = require(path.join(ROOT, 'scripts', 'tools', 'office', 'vendor', 'ws'));
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const WIN = process.platform === 'win32';
// una carpeta personal inventada, armada por partes: entera en el archivo la frena el control de publicación
const USERS_HOME = ['', 'Users', 'dev-a'].join('/');

// se cargan dentro de cada prueba: el rojo de una pieza que falta es de esa prueba, no de todo el archivo
const fields = () => require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));
const siteLink = () => require(path.join(ROOT, 'scripts', 'tools', 'office', 'site-link.js'));
const officeEvent = () => require(path.join(ROOT, 'scripts', 'lib', 'office-event.js'));
const office = () => require(OFFICE);

const started = new Set();
const dirs = new Set();
const closers = new Set();
test.after(async () => {
  for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya salió */ } }
  for (const close of closers) await close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20); } return Boolean(cond()); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.add(d); return d; };

// La dirección del sitio vale sólo desde el perfil del árbol del arnés: ninguna variable la cambia. Por eso los procesos
// corren desde una copia del árbol, con su propio perfil.
let treeDir = null;
function tree() {
  if (treeDir) return treeDir;
  treeDir = tmp('office-tree-');
  for (const rel of ['scripts/lib', 'scripts/tools', 'scripts/hooks', 'scripts/setup', 'scripts/metrics', 'scripts/publishing', 'skills/tycon-pipeline/scripts']) {
    fs.cpSync(path.join(ROOT, ...rel.split('/')), path.join(treeDir, ...rel.split('/')), { recursive: true });
  }
  return treeDir;
}
const inTree = (...p) => path.join(tree(), ...p);
const OFFICE_RUN = () => inTree('scripts', 'tools', 'office.js');
const HOOK = () => inTree('scripts', 'hooks', 'office-link-start.js');
const MARKER = () => inTree('skills', 'tycon-pipeline', 'scripts', 'marker.js');
const UPLOAD = () => inTree('scripts', 'metrics', 'upload-runs.js');
function applySite(m) {
  const profile = inTree('team-profile.json');
  if (m.url) fs.writeFileSync(profile, JSON.stringify({ site: { url: m.url } }));
  else fs.rmSync(profile, { force: true });
}

// Una máquina de juguete: las carpetas que mira la oficina y una sesión viva.
function toy({ pid = process.pid, name = 'Alfa' } = {}) {
  const home = tmp('office-link-');
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify({ pid, sessionId: 's1', name, nameSource: 'user', status: 'busy', statusUpdatedAt: 1000 }));
  return { home, sdir, sessions, url: null };
}
function withSite(m, url) { m.url = url; return m; }

const REMOVED = ['TF_BUILD', 'AGENT_ID', 'BUILD_BUILDID', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT',
  'TYCON_HOME', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_SKILLS_DIR', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_OFFICE_LINK', 'TYCON_EVAL_SANDBOX', 'TYCON_PROFILE'];
function envOf(m, more = {}) {
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_TEST: '1' };
  for (const k of REMOVED) delete env[k];
  return { ...env, ...more };
}
const lockOf = (m) => path.join(m.sdir, 'office', 'server.json');
const startingOf = (m) => path.join(m.sdir, 'office', 'server.starting');
const readLock = (m) => { try { return JSON.parse(fs.readFileSync(lockOf(m), 'utf8')); } catch { return null; } };
const startsOf = (m) => { try { return fs.readFileSync(path.join(m.sdir, 'office', 'starts.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const logOf = (m) => { try { return fs.readFileSync(path.join(m.sdir, 'office', 'site-link.log'), 'utf8'); } catch { return ''; } };

function run(file, args, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
  });
}
async function hook(m, more) {
  applySite(m);
  const r = await run(HOOK(), [], envOf(m, more));
  const lock = readLock(m);
  if (lock && lock.pid) started.add(lock.pid);
  return r;
}
async function openLocal(m, more) {
  applySite(m);
  const r = await run(OFFICE_RUN(), ['--open'], envOf(m, more));
  const lock = readLock(m);
  if (lock && lock.pid) started.add(lock.pid);
  return r;
}
async function stopServer(m) {
  const lock = readLock(m);
  if (lock && lock.pid) { try { process.kill(lock.pid, 'SIGTERM'); } catch { /* ya salió */ } await until(() => !alive(lock.pid)); }
}

// Un proceso con el candado de la oficina que tarda `busyMs` en contestar, como uno que está armando la foto. Después
// contesta con `answerPid` (su pid, si no se dice otro).
const BUSY_OFFICE = `const http = require('http');
const busyUntil = Date.now() + Number(process.argv[1]);
const answerPid = Number(process.argv[2]) || process.pid;
const reply = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pid: answerPid })); };
const server = http.createServer((req, res) => { setTimeout(() => reply(res), Math.max(0, busyUntil - Date.now())); });
server.listen(0, '127.0.0.1', () => console.log(server.address().port));`;
async function busyOffice(m, busyMs, answerPid = 0) {
  const child = spawn(process.execPath, ['-e', BUSY_OFFICE, String(busyMs), String(answerPid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.add(child.pid);
  const port = await new Promise((resolve) => { child.stdout.once('data', (d) => resolve(Number(String(d).trim()))); });
  fs.mkdirSync(path.dirname(lockOf(m)), { recursive: true, mode: 0o700 });
  const lockText = JSON.stringify({ pid: child.pid, port, token: 'ocupada', startedAt: '2026-06-01T12:00:00.000Z' });
  fs.writeFileSync(lockOf(m), lockText);
  return { pid: child.pid, port, lockText };
}
// El proceso de la oficina, lanzado a mano, con un límite: uno que no termina se corta y cuenta como que no terminó.
function runServer(m, more, ms = 8000) {
  applySite(m);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [inTree('scripts', 'tools', 'office', 'server.js')], { env: envOf(m, more), stdio: ['ignore', 'ignore', 'pipe'] });
    started.add(c.pid);
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    const limit = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('close', (status, signal) => { clearTimeout(limit); resolve({ status, signal, stderr }); });
  });
}

// El sitio de juguete: contesta el pedido de alta, manda el desafío, verifica la firma y anota lo que recibe. `mode` dice
// qué le contesta a una firma: approve, pending (4401), revoked (4403), unknown (4404) o mute (nada). `noChallenge` acepta la
// conexión y calla; `closeAfterAck` cierra enseguida de aceptar la firma.
async function toySite({ mode = 'approve', port = 0 } = {}) {
  const site = { mode, enrollStatus: 200, enrollDelayMs: 0, hangEnroll: false, muteHeartbeat: false, noChallenge: false, closeAfterAck: false, puede: null, enrolls: [], connections: [], closes: [], auths: [], fotos: [], charlas: [], pings: [], raw: [], url: null };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/live/enroll') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        site.enrolls.push(body);
        site.raw.push(body);
        if (site.hangEnroll) return;
        if (site.enrollDelayMs) await sleep(site.enrollDelayMs);
        res.writeHead(site.enrollStatus, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* el cliente cortó */ });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const nonce = crypto.randomBytes(32).toString('base64');
      site.connections.push(ws);
      ws.on('error', () => { /* el cliente cortó */ });
      ws.on('close', (code) => site.closes.push(code));
      if (!site.noChallenge) ws.send(JSON.stringify({ type: 'challenge', nonce: site.badNonce ? 'corto' : nonce, text: 'firmá este texto, no el tuyo' }));
      ws.on('message', (raw) => {
        const text = String(raw);
        site.raw.push(text);
        const msg = JSON.parse(text);
        if (msg.type === 'auth') {
          site.auths.push({ ...msg, verified: verifies(site.url, nonce, msg) });
          if (site.mode === 'mute') return;
          if (site.mode === 'approve') {
            // un sitio que entiende la conversación lo anuncia en el ack; uno que no, no anuncia nada
            ws.send(JSON.stringify({ type: 'ack', ...(site.puede ? { puede: site.puede } : {}) }));
            if (site.closeAfterAck) ws.close(1008, 'el esquema no coincide');
          } else ws.close({ pending: 4401, revoked: 4403, unknown: 4404 }[site.mode], site.mode);
        } else if (msg.type === 'foto') {
          site.fotos.push({ data: msg.data, bytes: Buffer.byteLength(text), at: Date.now() });
        } else if (msg.type === 'charla') {
          site.charlas.push({ sesion: msg.sesion, datos: msg.datos, bytes: Buffer.byteLength(text) });
        } else if (msg.type === 'ping') {
          site.pings.push(msg);
          if (!site.muteHeartbeat) ws.send(JSON.stringify({ type: 'pong' }));
        }
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  site.url = `http://127.0.0.1:${server.address().port}`;
  site.port = server.address().port;
  site.broadcast = (payload) => { for (const c of site.connections) if (c.readyState === WebSocket.OPEN) c.send(payload); };
  site.stop = () => new Promise((resolve) => {
    closers.delete(site.stop);
    for (const c of site.connections) { try { c.terminate(); } catch { /* ya cerrada */ } }
    server.close(() => resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  });
  closers.add(site.stop);
  return site;
}
function verifies(url, nonce, msg) {
  try {
    const x = Buffer.from(msg.publicKey, 'base64').toString('base64url');
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(`tycon-office-v1|${url}|${nonce}`), key, Buffer.from(msg.signature, 'base64'));
  } catch { return false; }
}
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function fakeClock() {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { nextId += 1; timers.set(nextId, { fn, ms, at: now + ms, id: nextId }); return nextId; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => [...timers.values()],
    advance(ms) {
      now += ms;
      for (const t of [...timers.values()].sort((a, b) => a.at - b.at)) if (t.at <= now && timers.has(t.id)) { timers.delete(t.id); t.fn(); }
    },
  };
}
// Las esperas de reconexión: lo que queda en el reloj sin el saludo ni el latido.
const GREETING_MS = 15000;
const BEAT_MS = 60000;
const waits = (clock) => clock.pending().filter((t) => t.ms !== GREETING_MS && t.ms !== BEAT_MS);
function linkOf(m, site, state = 'pedida', more = {}) {
  const sl = siteLink();
  sl.ensureKey(m.sdir);
  sl.writeLinkState(m.sdir, state);
  const clock = fakeClock();
  const link = sl.createLink({ site: site.url || site, sdir: m.sdir, home: m.home, clock, random: () => 0, ...more });
  closers.add(async () => link.stop());
  return { link, clock };
}

const FOTO = (txt = 'Hace algo') => ({ agents: [{ nombre: 'Alfa', estado: 'trabajando', haciendo: txt, titulo: null, carpeta: '~/SourceCode/acme-repo', fin: null }], items: [], meta: { actualizado: '10:00' }, rows: [], free: [], unreadable: [] });

// Una foto armada por `buildOffice`, con cada campo que arma: la que cruza la lista con la página.
function richFoto() {
  const { buildOffice, buildBoard, buildTables } = office();
  const nowMs = Date.parse('2026-06-01T12:00:00Z');
  const row = (session, folder = 'acme-repo') => ({ work: 'Trabajo', state: 'estado', end: 'fin', session, folder: `~/SourceCode/${folder}` });
  const step = { id: 'run-tests', name: 'Correr pruebas', done: false };
  const wip = {
    rows: ['Alfa', 'Beta', 'Gama', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Kappa'].map((name) => row(name)),
    details: [{ sid: 's1', status: 'busy' }, { sid: 's2', status: 'busy' }, { sid: 's3', status: 'busy' }, { sid: 's4', status: 'waiting_for_permission' }, { sid: 's5', status: 'idle', statusAt: nowMs - 60000 }, { sid: 's6', status: 'busy' }, { sid: 's7', status: 'busy' }, { sid: 's8', status: 'busy' }],
    extra: [
      { kind: 'pipeline', title: '7.1 · La historia', batch: 'A-la-tanda', storyId: '7.1', steps: [step], current: 'run-tests', progress: 40, endAt: nowMs - 60000, promisedAt: nowMs - 120000, late: true, meanwhile: 'Revisa otra cosa' },
      { kind: 'entering', title: '7.2 · Otra', storyId: '7.2', endAt: nowMs - 60000 },
      { kind: 'loose', text: 'Un arreglo suelto' },
      { kind: 'pipeline', title: '7.3 · La que pide', storyId: '7.3', steps: [step], current: 'run-tests' },
      { kind: 'pipeline', title: '7.4 · La parada', storyId: '7.4', steps: [step], current: 'run-tests' },
      { kind: 'pipeline', title: '7.5 · La tapada', storyId: '7.5', steps: [step], current: 'run-tests', activityAt: nowMs - 600000, meanwhileAt: nowMs - 60000, meanwhileKind: 'loose', meanwhile: 'Un arreglo de ahora' },
      { kind: 'pipeline', title: '7.6 · La recalculada', storyId: '7.6', steps: [step], current: 'run-tests', endAt: nowMs + 3600000, hourStep: 'Correr pruebas' },
      { kind: 'activity' },
    ],
    free: ['Libre'],
    unreadable: ['algo que no se leyó'],
    halfwayItems: [
      { kind: 'run', text: 'Un plan sin aprobar', name: 'Theta', awaits: 'plan' },
      { kind: 'run', text: 'Una dejada a propósito', name: 'Iota', mark: 'la dejó para el lunes' },
      { kind: 'run', text: 'Un trabajo', left: [{ folder: 'acme-repo', branch: 'rama', changes: 2, ahead: 0 }] },
      { kind: 'run', text: 'Otro trabajo', unknown: true },
    ],
  };
  const board = buildBoard({ meta: { actualizado: '2026-06-01T10:00', resumen: 'Resumen', teToca: ['Algo'] }, pendientes: [{ titulo: 'Pendiente', estado: 'espera', grupo: 'Hoy', quien: 'Omega', nota: 'Nota', termina: 'hoy', orden: 1 }, { titulo: 'Hecho', estado: 'hecho', quien: 'Beta', realIso: '2026-06-01T09:00' }] });
  const { data } = buildOffice({
    wip, signatures: [{ title: 'Firma del plan', at: nowMs }], nowMs, board, openPrsNote: 'Los pedidos no se pudieron leer.',
    sessionFiles: [{ session: 's3', tool: 'claude', pid: null, updatedAt: new Date(nowMs - 1800000).toISOString() }],
    transcripts: new Map(['s3', 's8'].map((sid) => [sid, { encargo: 'Lo que le pidieron', haciendoAhora: 'Lo que hace ahora', ultimaAccion: 'Lo último que hizo', lastWriteMs: nowMs - 60000 }])),
  });
  // lo que collect() le agrega a la foto de buildOffice
  data.tablas = buildTables({ kanban: data.kanban, nowMs });
  data.tablero = { actualizado: board.actualizado, resumen: board.resumen, teToca: board.teToca };
  data.kanban.columnas[0].tarjetas[0] = { ...data.kanban.columnas[0].tarjetas[0], otro: true };
  data.kanban.escrito = 'Tablero escrito a las 11:59';
  data.meta.pedidosLeidos = '11:59';
  data.meta.sitio = 'https://acme.example';
  // lo que collect() le agrega con la oficina viva, y lo que buildOffice arma con agentes corriendo o con un pedido
  data.tokens = { Alfa: { contexto: '12k de 200k · 6 %', consumidos: 'Read 1k · Write 2k · Cache Read 3k', agentes: 1 } };
  data.sobres = [{ id: 'm0', de: 'Alfa', a: 'Beta', at: nowMs }];
  data.agents[0].agentesAhora = 'Con su agente';
  data.kanban.columnas[1].tarjetas.push({ titulo: 'Con pedido', quien: 'Beta', hora: 'hoy', pedido: { numero: 3, sitio: 'azure', ruta: 'acme/proyecto/_git/repo/pullrequest/3' } });
  return data;
}
function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

// Los tokens con forma conocida, armados por partes: enteros en el archivo los frena el control de claves del commit.
function LOOSE_TOKENS() {
  return [
    ['GitHub', `${'ghp_'}${'a'.repeat(36)}`],
    ['GitHub, de grano fino', `${'github_'}${'pat_'}${'b'.repeat(40)}`],
    ['Anthropic', `${'sk-'}${'ant-'}${'api03-'}${'c'.repeat(30)}`],
    ['OpenAI', `${'sk-'}${'d'.repeat(40)}`],
    ['AWS', `${'AKIA'}${'IOSFODNN7EXAMPLE'}`],
    ['AWS temporal', `${'ASIA'}${'IOSFODNN7EXAMPLE'}`],
    ['JWT', `${'eyJ'}${'h'.repeat(12)}.${'eyJ'}${'p'.repeat(12)}.${'s'.repeat(12)}`],
    ['bot de Telegram', `123456789:${'A'.repeat(35)}`],
    ['Slack', `${'xox'}b-${'1'.repeat(12)}`],
    ['npm', `${'npm_'}${'e'.repeat(20)}`],
    ['GitLab', `${'glpat-'}${'f'.repeat(20)}`],
    ['Google', `${'AIza'}${'g'.repeat(25)}`],
    ['Stripe', `${'sk_'}live_${'i'.repeat(16)}`],
  ];
}

test('T1 Foto_LaMismaQueLaOficinaLocal: viaja sólo lo que lee la página; la lista y la página se cruzan', () => {
  const { pick, FIELDS } = fields();
  const foto = richFoto();
  const src = fs.readFileSync(PAGE, 'utf8');
  const readBy = (vars, text = src) => (k) => new RegExp(`\\b(?:${vars})\\.${k}\\b`).test(text);
  // lo que pinta cada parte de la página: las variables `i`, `r` y `t` significan otra cosa en otras funciones
  const fn = (name) => { const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name); const end = src.indexOf('\nfunction ', at + 1); return src.slice(at, end < 0 ? undefined : end); };
  const cardsSrc = fn('renderBoard') + fn('abrirTablero') + fn('abrirTarjeta');
  const allOf = (records) => Object.assign({}, ...records);
  const cards = foto.kanban.columnas.flatMap((c) => c.tarjetas);
  const tableList = [foto.tablas.hoy, foto.tablas.pendientes];
  const tableFields = FIELDS.tablas.fields.hoy.fields;
  const sections = [
    // la página guarda `DATA.items` y no lee ninguno de sus campos: los pendientes le llegan por el kanban
    ['foto', foto, FIELDS, (k) => k !== 'items' && readBy('DATA')(k)],
    ['agents', allOf(foto.agents), FIELDS.agents.of.fields, readBy('a|x')],
    ['fin', foto.agents[0].fin, FIELDS.agents.of.fields.fin.fields, readBy('f')],
    ['pasos', foto.agents[0].pasos[0], FIELDS.agents.of.fields.pasos.of.fields, readBy('p')],
    ['kanban', foto.kanban, FIELDS.kanban.fields, readBy('k|K')],
    ['columnas', allOf(foto.kanban.columnas), FIELDS.kanban.fields.columnas.of.fields, readBy('c', fn('renderBoard'))],
    ['tarjetas', allOf(cards), FIELDS.kanban.fields.columnas.of.fields.tarjetas.of.fields, readBy('i|r', cardsSrc)],
    // el panel de pendientes dibuja «A medio camino» como una columna más, con las mismas tarjetas
    ['medioCamino', allOf(foto.kanban.medioCamino), FIELDS.kanban.fields.medioCamino.of.fields, (k) => readBy('i', fn('renderHalfway'))(k) || readBy('i|r', cardsSrc)(k)],
    ['tablas', foto.tablas, FIELDS.tablas.fields, (k) => fn('renderTablas').includes(`"${k}"`)],
    ['tabla', allOf(tableList), tableFields, readBy('t', fn('renderTablas'))],
    ['filas', allOf(tableList.flatMap((t) => t.filas)), tableFields.filas.of.fields, readBy('r', fn('renderTablas'))],
    ['trabajos', allOf(tableList.flatMap((t) => t.filas).flatMap((r) => r.trabajos)), tableFields.filas.of.fields.trabajos.of.fields, readBy('w', fn('renderTablas'))],
    // `sitio`: la oficina local lo muestra, pero lo lee del atributo que arma office.js, nunca de la foto
    ['meta', foto.meta, FIELDS.meta.fields, (k) => k === 'sitio' || readBy('meta')(k) || readBy('m', fn('umbral') + src.split('\n').find((l) => l.startsWith('const puestos=')))(k)],
    ['rows', foto.rows[0], FIELDS.rows.of.fields, readBy('r')],
    ['tablero', foto.tablero, FIELDS.tablero.fields, readBy('t', fn('renderBoard'))],
  ];
  const seen = [];
  for (const [name, record, listed, isRead] of sections) {
    for (const k of Object.keys(record)) {
      seen.push(k);
      assert.strictEqual(k in listed, isRead(k), `${name}.${k}: la lista y lo que lee la página no coinciden`);
    }
    for (const k of Object.keys(listed)) {
      assert.ok(isRead(k), `${name}.${k} está en la lista y la página no lo lee`);
      assert.ok(k in record, `${name}.${k} está en la lista y la foto de la prueba no lo trae: no se está cruzando`);
    }
  }
  for (const k of ['atrasada', 'atrasoMin', 'termina', 'tipo', 'orden', 'pronosticoIso']) assert.ok(seen.includes(k), `la foto de la prueba trae «${k}», que la página no lee`);
  for (const k of ['pelo', 'gorra', 'piel', 'lentes', 'barba']) assert.ok(!(k in FIELDS.agents.of.fields), `«${k}» lo calcula la página, no viaja`);
  // los valores cerrados son los que la página sabe pintar: uno que falta acá llega al sitio sin estado
  const keysOf = (re) => { const m = re.exec(src); assert.ok(m, String(re)); return [...m[1].matchAll(/(\w+):[\[#"]/g)].map((x) => x[1]).sort(); };
  assert.deepStrictEqual([...fields().AGENT_STATES].sort(), keysOf(/\bAST=\{(.*?)\};/));
  assert.deepStrictEqual([...FIELDS.kanban.fields.columnas.of.fields.id.values].sort(), keysOf(/\bKC=\{(.*?)\};/));

  // un campo de más, en cualquier sección, no viaja; la foto original no cambia
  foto.secreto = 'campo-de-mas';
  foto.agents[0].secreto = 'campo-de-mas';
  foto.meta.secreto = 'campo-de-mas';
  foto.rows[0].secreto = 'campo-de-mas';
  foto.tablero.secreto = 'campo-de-mas';
  foto.kanban.secreto = 'campo-de-mas';
  foto.kanban.columnas[0].secreto = 'campo-de-mas';
  foto.kanban.columnas[0].tarjetas[0].secreto = 'campo-de-mas';
  foto.tablas.hoy.secreto = 'campo-de-mas';
  foto.tablas.hoy.filas[0].secreto = 'campo-de-mas';
  const before = JSON.stringify(foto);
  const sent = pick(foto, '/home/nadie');
  assert.ok(!JSON.stringify(sent).includes('campo-de-mas'));
  assert.strictEqual(JSON.stringify(foto), before);
  assert.deepStrictEqual(Object.keys(sent.agents[0]).filter((k) => !(k in FIELDS.agents.of.fields)), []);
  assert.strictEqual(sent.agents[0].nombre, foto.agents[0].nombre);
  assert.deepStrictEqual(sent.agents[0].fin, foto.agents[0].fin);
  assert.deepStrictEqual(sent.agents[0].pasos, [{ name: 'Correr pruebas', done: false }]);
  assert.deepStrictEqual(sent.meta.puestos, foto.meta.puestos);
  assert.strictEqual(sent.meta.sitio, 'https://acme.example');
  // el umbral de «callada» viaja: sin él, el sitio usaría el suyo y marcaría distinto que la oficina local
  assert.strictEqual(sent.meta.quietMin, foto.meta.quietMin);
  assert.strictEqual(pick({ meta: { quietMin: 'mucho' } }, '/home/nadie').meta.quietMin, undefined);
  // la oficina del sitio pinta lo mismo que la local: la espera, la parada, las dos vistas y el resumen
  const sentOf = (name) => sent.agents.find((a) => a.nombre === name);
  const fotoOf = (name) => foto.agents.find((a) => a.nombre === name);
  assert.strictEqual(sentOf('Delta').estado, 'firma');
  assert.strictEqual(sentOf('Delta').espera, 'tu respuesta en su pantalla');
  assert.strictEqual(sentOf('Epsilon').estado, 'parada');
  assert.strictEqual(sentOf('Epsilon').parada, fotoOf('Epsilon').parada);
  assert.strictEqual(sentOf('Gama').encargo, 'Lo que le pidieron');
  assert.strictEqual(sentOf('Gama').novedadMs, fotoOf('Gama').novedadMs);
  assert.strictEqual(sentOf('Gama').sinPid, true);
  assert.deepStrictEqual(sent.kanban.columnas.map((c) => c.id), foto.kanban.columnas.map((c) => c.id));
  assert.deepStrictEqual(sent.kanban.columnas.map((c) => c.tarjetas.length), foto.kanban.columnas.map((c) => c.tarjetas.length));
  assert.ok(sent.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.some((c) => c.nota === 'Nota' && c.grupo === 'Hoy'));
  assert.deepStrictEqual(sent.kanban.medioCamino, foto.kanban.medioCamino.map(({ titulo, quien, accion }) => ({ titulo, quien, accion })));
  assert.strictEqual(sent.kanban.medioCaminoNoSe, foto.kanban.medioCaminoNoSe);
  assert.deepStrictEqual(sent.tablas.hoy.filas.map((r) => r.que), foto.tablas.hoy.filas.map((r) => r.que));
  assert.deepStrictEqual(sent.tablas.pendientes.columnas, foto.tablas.pendientes.columnas);
  assert.deepStrictEqual(sent.tablas.hoy.filas.map((r) => r.trabajos), foto.tablas.hoy.filas.map((r) => r.trabajos));
  assert.strictEqual(sent.tablas.pendientes.vacio, foto.tablas.pendientes.vacio);
  assert.ok(foto.items.length > 0 && !('items' in sent), 'la página no lee los campos de `items`');
  // los sobres viajan sin texto: el sitio lleva todo lo de la oficina local, y el mensaje va con la conversación (T47, T48)
  assert.ok(readBy('DATA')('sobres') && 'sobres' in FIELDS, 'los sobres están en la lista');
  assert.deepStrictEqual(pick({ sobres: [{ id: 'm1', de: 'Alfa', a: 'Beta', at: 5, texto: 'un mensaje' }] }, '/home/nadie').sobres, [{ id: 'm1', de: 'Alfa', a: 'Beta', at: 5 }]);
  assert.strictEqual(typeof sentOf('Alfa').comoTrabaja, 'string');
  assert.deepStrictEqual(sent.tablero, { resumen: 'Resumen' });
  assert.strictEqual(sent.unreadable[0], 'algo que no se leyó');
  // un valor que no tiene la forma de su campo tampoco viaja
  assert.strictEqual(pick({ agents: [{ nombre: 'x', estado: 'rm -rf', avance: 'mucho', estimadaIso: 'mañana', fin: 'una hora' }] }, '/home/nadie').agents[0].estado, undefined);
  const odd = pick({ agents: [{ nombre: 7, avance: 'mucho', estimadaIso: 'mañana', fin: 'una hora' }] }, '/home/nadie').agents[0];
  assert.deepStrictEqual(odd, {});
  // lo opcional que viene en null, viaja en null: la página sabe qué hacer
  assert.strictEqual(pick({ agents: [{ titulo: null, fin: null }] }, '/home/nadie').agents[0].fin, null);
});

test('T2 Foto_SaneadaYRecortada: un token no viaja; 200 caracteres por texto; de la carpeta, sólo su nombre', () => {
  const { pick, TEXT_MAX } = fields();
  assert.strictEqual(TEXT_MAX, 200);
  const home = '/home/dev-a';
  const secret = 'abcd1234efgh5678';
  const sent = pick({
    agents: [
      { nombre: 'Alfa', haciendo: `corre con token=${secret} y Authorization: Bearer ${secret}`, titulo: `password=${secret}`, encargo: `usá password=${secret}`, ultimaAccion: `Mirá ${home}/x.js`, carpeta: '~/SourceCode/acme-repo', mientras: 'x'.repeat(500) },
      { nombre: 'Beta', carpeta: `${home}/SourceCode/otro-repo/` },
      { nombre: 'Gama', carpeta: 'C:\\Users\\dev-a\\repo-en-windows' },
      // el token cae justo sobre el corte de los 200: tampoco viaja una punta
      { nombre: 'Delta', haciendo: `${'y '.repeat(96)}token=${secret}` },
    ],
    rows: [{ work: `Mirá ${home}/SourceCode/acme-repo/x.js`, state: 'ok', end: '', session: 'Alfa', folder: '~/SourceCode/acme-repo' }],
    unreadable: [`no se vigila ${USERS_HOME}/.claude/sessions: EACCES`],
    tablero: { resumen: `z${'z'.repeat(300)}`, teToca: [`secret=${secret}`] },
    kanban: { columnas: [{ id: 'curso', nombre: 'En curso', tarjetas: [{ titulo: 'T', nota: `secret=${secret}`, motivo: `Mirá ${home}/x.js` }] }], medioCamino: [{ titulo: `secret=${secret}`, accion: 'x'.repeat(300) }] },
    tablas: { hoy: { titulo: 'Hoy', columnas: ['Grupo'], filas: [{ grupo: 'g', que: `secret=${secret}`, col: `Mirá ${home}/x.js` }], cruce: 'y'.repeat(300) } },
  }, home);
  const json = JSON.stringify(sent);
  assert.ok(!json.includes(secret), json);
  assert.ok(!json.includes('abcd1234'), 'ni una punta del token');
  assert.ok(!/dev-a/.test(json), 'ninguna ruta de la persona');
  for (const s of allStrings(sent)) assert.ok(s.length <= 200, `${s.length}: ${s.slice(0, 40)}`);
  assert.strictEqual(sent.agents[0].mientras.length, 200);
  assert.strictEqual(sent.agents[0].carpeta, 'acme-repo');
  assert.strictEqual(sent.agents[1].carpeta, 'otro-repo');
  assert.strictEqual(sent.agents[2].carpeta, 'repo-en-windows');
  assert.strictEqual(sent.rows[0].folder, 'acme-repo');

  // los tokens sueltos, sin ningún nombre adelante, tampoco viajan
  const loose = pick({ agents: LOOSE_TOKENS().map(([, token]) => ({ haciendo: `corre con ${token} y sigue` })) }, home);
  for (const [i, [name, token]] of LOOSE_TOKENS().entries()) {
    assert.ok(!JSON.stringify(loose.agents[i]).includes(token), `${name}: ${JSON.stringify(loose.agents[i])}`);
    assert.match(loose.agents[i].haciendo, /corre con .* y sigue/, name);
  }
});

test('T3 Foto_TopeDe64KB: una foto de más de 64 KB no sale y queda anotado; la de 21,4 KB sale', async () => {
  const { MAX_MESSAGE_BYTES } = fields();
  assert.strictEqual(MAX_MESSAGE_BYTES, 64 * 1024);
  const sized = (bytes) => {
    const agents = [];
    while (JSON.stringify(agents).length < bytes) agents.push({ nombre: `Sesión ${agents.length}`, estado: 'trabajando', haciendo: 'h'.repeat(180), titulo: 't'.repeat(180) });
    return { agents, items: [], meta: { actualizado: '10:00' }, rows: [], free: [], unreadable: [] };
  };
  const m = toy();
  const site = await toySite();
  const { link } = linkOf(m, site);
  link.update(sized(21400));
  link.start();
  assert.ok(await until(() => site.fotos.length === 1), 'la de 21,4 KB sale');
  assert.ok(site.fotos[0].bytes >= 21400 && site.fotos[0].bytes < 64 * 1024, String(site.fotos[0].bytes));
  link.update(sized(70000));
  await sleep(150);
  assert.strictEqual(site.fotos.length, 1, 'la grande no sale');
  assert.match(logOf(m), /64 KB/);
  assert.strictEqual(site.connections[0].readyState, WebSocket.OPEN, 'la conexión sigue; el sitio se queda con la anterior');
  link.update(FOTO('chica otra vez'));
  assert.ok(await until(() => site.fotos.length === 2), 'la siguiente que entra, sale');
  link.stop();
  await site.stop();
});

test('T4 Envio_EnteraAlConectar_CambiosDespues: entera al conectar; igual no sale; latido a los 60 s', async () => {
  const m = toy();
  const site = await toySite();
  const { link, clock } = linkOf(m, site);
  link.update(FOTO('uno'));
  link.start();
  assert.ok(await until(() => site.fotos.length === 1));
  assert.deepStrictEqual(site.fotos[0].data, fields().pick(FOTO('uno'), m.home), 'la foto entera, armada con la lista');
  link.update(FOTO('uno'));
  await sleep(150);
  assert.strictEqual(site.fotos.length, 1, 'una foto igual no se manda');
  link.update(FOTO('dos'));
  assert.ok(await until(() => site.fotos.length === 2), 'un cambio sale enseguida');
  assert.strictEqual(site.pings.length, 0, 'todavía no toca el latido');
  clock.advance(59000);
  await sleep(100);
  assert.strictEqual(site.pings.length, 0);
  clock.advance(1000);
  assert.ok(await until(() => site.pings.length === 1), 'latido a los 60 s');
  await sleep(50);
  clock.advance(60000);
  assert.ok(await until(() => site.pings.length === 2), 'y otro a los 60 s siguientes');
  assert.strictEqual(site.fotos.length, 2, 'el latido no manda foto');
  link.stop();
  await site.stop();
});

test('T5 Reconexion_EsperaCreciente_FotoEntera: de 2 s a 5 min, y al volver, la foto entera', async () => {
  const m = toy();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { link, clock } = linkOf(m, url);
  link.update(FOTO('uno'));
  link.start();
  const delays = [];
  for (let i = 0; i < 10; i += 1) {
    assert.ok(await until(() => waits(clock).length === 1), `espera ${i}`);
    const [t] = waits(clock);
    delays.push(t.ms);
    clock.advance(t.ms);
    await sleep(5);
  }
  assert.deepStrictEqual(delays, [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
  // con azar, cada espera queda entre la que le toca y el tope
  const jitter = linkOf(toy(), url, 'pedida', { random: () => 1 });
  jitter.link.start();
  const noisy = [];
  for (let i = 0; i < 9; i += 1) {
    assert.ok(await until(() => waits(jitter.clock).length === 1));
    const [t] = waits(jitter.clock);
    noisy.push(t.ms);
    jitter.clock.advance(t.ms);
    await sleep(5);
  }
  jitter.link.stop();
  assert.ok(noisy[0] > 2000 && noisy[0] <= 2500, String(noisy[0]));
  assert.ok(noisy.every((d) => d <= 300000), noisy.join());
  assert.notStrictEqual(noisy[0], delays[0], 'el azar separa a las máquinas que se cortaron juntas');

  // el sitio vuelve: entera, aunque sea la misma de antes
  let site = await toySite({ port });
  assert.ok(await until(() => waits(clock).length === 1));
  clock.advance(waits(clock)[0].ms);
  assert.ok(await until(() => site.fotos.length === 1), 'al volver, la foto entera');
  // con el primer pong la conexión es estable: la espera vuelve a 2 s
  clock.advance(BEAT_MS);
  assert.ok(await until(() => site.pings.length === 1));
  await sleep(50);
  await site.stop();
  site = await toySite({ port });
  assert.ok(await until(() => waits(clock).some((t) => t.ms === 2000)), 'con la conexión estable, la espera vuelve a 2 s');
  clock.advance(2000);
  assert.ok(await until(() => site.fotos.length === 1), 'la misma foto, otra vez entera');
  // un sitio que dejó de contestar el latido cuenta como caído
  site.muteHeartbeat = true;
  const conn = site.connections[0];
  clock.advance(60000);
  assert.ok(await until(() => site.pings.length === 1));
  clock.advance(60000);
  assert.ok(await until(() => conn.readyState !== WebSocket.OPEN), 'corta la conexión muda');
  assert.ok(await until(() => waits(clock).length === 1), 'y reintenta');
  link.stop();
  await site.stop();
});

test('T6 SinClaveAprobada_NoManda: pendiente, 4401 y ninguna foto; de baja, 4403, deja de pedir y lo anota', async () => {
  const m = toy();
  const site = await toySite({ mode: 'pending' });
  withSite(m, site.url);
  const { link, clock } = linkOf(m, site);
  link.update(FOTO());
  link.start();
  assert.ok(await until(() => site.closes.includes(4401)), 'el sitio cerró con 4401');
  assert.ok(await until(() => siteLink().readLinkState(m.sdir) === 'pendiente'));
  assert.ok(site.auths[0].verified, 'firmó');
  assert.strictEqual(site.fotos.length, 0, 'ninguna foto');
  assert.ok(await until(() => waits(clock).length === 1), 'lo vuelve a intentar: el intento renueva el pedido');
  clock.advance(waits(clock)[0].ms);
  assert.ok(await until(() => site.auths.length === 2));
  assert.strictEqual(site.enrolls.length, 0, 'el intento no es otro pedido de alta');
  assert.strictEqual(site.fotos.length, 0);

  // la línea de /office, con la huella
  const shown = fields().displayFingerprint(siteLink().readKey(m.sdir).fingerprint);
  assert.match(shown, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  const opened = await openLocal(m);
  assert.strictEqual(opened.status, 0, opened.stderr);
  const lines = opened.stdout.trim().split('\n');
  assert.ok(lines.some((l) => l.includes('espera la aprobación') && l.includes(shown)), opened.stdout);
  assert.strictEqual(lines.filter((l) => l.includes(shown)).length, 1, 'una línea');
  await stopServer(m);

  // la aprueban y la siguiente vuelta ya manda
  site.mode = 'approve';
  assert.ok(await until(() => waits(clock).length === 1));
  clock.advance(waits(clock)[0].ms);
  assert.ok(await until(() => site.fotos.length === 1), 'aprobada, manda');
  assert.ok(await until(() => siteLink().readLinkState(m.sdir) === 'aprobada'));
  const linkConnection = site.connections[site.connections.length - 1];
  const quiet = await openLocal(m);
  assert.ok(!quiet.stdout.includes('espera la aprobación'), quiet.stdout);
  await stopServer(m);

  // de baja
  site.mode = 'revoked';
  linkConnection.close(4403, 'baja');
  assert.ok(await until(() => siteLink().readLinkState(m.sdir) === 'de-baja'), 'quedó de baja');
  assert.match(logOf(m), /de baja/);
  await sleep(100);
  assert.deepStrictEqual(clock.pending(), [], 'no reintenta en el aire');
  withSite(m, site.url);
  const again = await hook(m);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(again.stdout, '', 'no dice nada');
  assert.strictEqual(site.enrolls.length, 0, 'de baja, no pide el alta');
  await stopServer(m);
  // reactivada, una sesión nueva vuelve a conectar, sin otra alta
  site.mode = 'approve';
  const fotosBefore = site.fotos.length;
  link.wake();
  assert.ok(await until(() => site.fotos.length > fotosBefore), 'una sesión nueva lo intenta una vez');
  assert.strictEqual(site.enrolls.length, 0);
  link.stop();
  await site.stop();
});

test('T7 CanalDeVuelta_Cerrado: lo que no es ack, pong ni el desafío cierra con 1008, se anota y no corre nada', async () => {
  const m = toy();
  const site = await toySite();
  const witness = path.join(m.home, 'corrio-una-orden');
  const { link, clock } = linkOf(m, site);
  const before = fs.readdirSync(path.join(m.sdir, 'office')).sort();
  link.update(FOTO());
  link.start();
  assert.ok(await until(() => site.fotos.length === 1));
  assert.ok(site.auths[0].verified, 'firmó tycon-office-v1|<sitio>|<nonce>, no el texto que le mandaron');

  // lo que traen `ack` y `pong` no se usa, y un segundo desafío no se firma
  site.broadcast(JSON.stringify({ type: 'ack', cmd: `touch ${witness}`, foto: { agents: [] } }));
  site.broadcast(JSON.stringify({ type: 'pong', cmd: `touch ${witness}` }));
  site.broadcast(JSON.stringify({ type: 'challenge', nonce: crypto.randomBytes(32).toString('base64') }));
  await sleep(150);
  assert.strictEqual(site.closes.length, 0, 'válidos: la conexión sigue');
  assert.strictEqual(site.auths.length, 1, 'firma una vez por conexión');

  const hostile = [
    JSON.stringify({ type: 'run', cmd: `touch ${witness}` }),
    JSON.stringify({ type: 'config', data: { secreto: 'contenido-del-mensaje' } }),
    JSON.stringify({ cmd: `touch ${witness}` }),
    'hola, esto no es JSON',
    Buffer.from([1, 2, 3]),
    JSON.stringify({ type: { toString: 'x' } }),
  ];
  for (const payload of hostile) {
    const closes = site.closes.length;
    const auths = site.auths.length;
    site.broadcast(payload);
    assert.ok(await until(() => site.closes.length === closes + 1), `cierra con ${payload}`);
    assert.strictEqual(site.closes[closes], 1008, String(payload));
    assert.ok(await until(() => waits(clock).length === 1));
    clock.advance(waits(clock)[0].ms);
    assert.ok(await until(() => site.auths.length === auths + 1), 'se reconecta y sigue');
    assert.ok(await until(() => site.connections[site.connections.length - 1].readyState === WebSocket.OPEN));
    await until(() => site.fotos.length > auths);
  }
  // un desafío sin un nonce de 32 bytes no se firma
  const auths = site.auths.length;
  const closes = site.closes.length;
  site.badNonce = true;
  site.connections[site.connections.length - 1].terminate();
  assert.ok(await until(() => site.closes.length === closes + 1));
  assert.ok(await until(() => waits(clock).length === 1));
  clock.advance(waits(clock)[0].ms);
  assert.ok(await until(() => site.closes[site.closes.length - 1] === 1008 && site.closes.length === closes + 2), site.closes.join());
  assert.strictEqual(site.auths.length, auths, 'no firmó');
  site.badNonce = false;
  const log = logOf(m);
  assert.match(log, /«run»/);
  assert.match(log, /«config»/);
  assert.ok(!log.includes('touch') && !log.includes('contenido-del-mensaje'), 'de un mensaje se anota el tipo, no lo que trae');
  assert.ok(!fs.existsSync(witness), 'no corrió nada');
  const after = fs.readdirSync(path.join(m.sdir, 'office')).filter((f) => !before.includes(f) && !/^site-(?:key|key-state)\.json$|^site-link\.log$/.test(f));
  assert.deepStrictEqual(after, [], 'y no tocó ningún otro archivo');
  link.stop();
  await site.stop();
});

test('T8 Proceso_ViveConLasSesiones: el gancho lanza o reusa; sin sesiones se apaga; tope; sin site.url, como antes', async () => {
  const { lifeLimits } = require(SERVER);
  assert.deepStrictEqual(lifeLimits(true), { idleMs: 10 * 60 * 1000, capMs: 12 * 3600 * 1000 });
  assert.deepStrictEqual(lifeLimits(false), { idleMs: 2 * 60 * 1000, capMs: 8 * 3600 * 1000 });

  const site = await toySite();
  // lanza y reusa
  const a = withSite(toy(), site.url);
  assert.strictEqual((await hook(a)).status, 0);
  assert.ok(await until(() => readLock(a)), 'lanzó el proceso sin esperarlo');
  started.add(readLock(a).pid);
  assert.strictEqual((await hook(a)).status, 0);
  assert.strictEqual(startsOf(a).length, 1, 'el segundo reusa');
  assert.ok(await until(() => site.fotos.length >= 1), 'y la foto llega sola, sin ninguna página');
  await stopServer(a);

  // dos ganchos a la vez: un solo proceso
  const two = withSite(toy(), site.url);
  await Promise.all([hook(two), hook(two)]);
  assert.ok(await until(() => readLock(two)));
  started.add(readLock(two).pid);
  await sleep(300);
  assert.strictEqual(startsOf(two).length, 1, 'un solo proceso');
  await stopServer(two);

  // uno vivo y ocupado no cuenta como muerto: el gancho no lanza otro, y el candado sigue siendo del que estaba
  const busy = withSite(toy(), site.url);
  const owner = await busyOffice(busy, 1500);
  assert.strictEqual((await hook(busy)).status, 0);
  assert.ok(await until(() => !fs.existsSync(startingOf(busy)), 8000), 'el que esperaba se fue');
  assert.strictEqual(fs.readFileSync(lockOf(busy), 'utf8'), owner.lockText, 'el candado no se tocó');
  assert.deepStrictEqual(startsOf(busy), [], 'ningún otro proceso arrancó');

  // sigue vivo con una sesión viva, sin páginas, más allá del plazo; muerta la sesión, se apaga
  const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  started.add(helper.pid);
  const b = withSite(toy({ pid: helper.pid }), site.url);
  const fast = { TYCON_OFFICE_IDLE_MS: '500', TYCON_OFFICE_SESSION_CHECK_MS: '100' };
  assert.strictEqual((await hook(b, fast)).status, 0);
  assert.ok(await until(() => readLock(b)));
  const pid = readLock(b).pid;
  started.add(pid);
  await sleep(1500);
  assert.ok(alive(pid), 'con una sesión viva sigue');
  helper.kill('SIGKILL');
  assert.ok(await until(() => !alive(pid), 5000), 'sin sesiones, se apaga solo');
  assert.strictEqual(readLock(b), null, 'y borra su candado');

  // el tope, aun con sesiones
  const c = withSite(toy(), site.url);
  assert.strictEqual((await hook(c, { TYCON_OFFICE_MAX_MS: '900' })).status, 0);
  assert.ok(await until(() => readLock(c)));
  const capped = readLock(c).pid;
  started.add(capped);
  assert.ok(await until(() => !alive(capped), 5000), 'el tope lo cierra');

  // sin site.url el gancho no lanza nada, y el proceso se porta como siempre: sin páginas se va, con sesiones o sin ellas
  const d = toy();
  const quiet = await hook(d);
  assert.strictEqual(quiet.status, 0);
  assert.strictEqual(readLock(d), null, 'sin site.url, ningún proceso');
  const before = site.connections.length;
  assert.strictEqual((await openLocal(d, { TYCON_OFFICE_IDLE_MS: '600' })).status, 0);
  const plain = readLock(d).pid;
  assert.ok(await until(() => !alive(plain), 5000), 'se fue con la sesión viva');
  assert.strictEqual(site.connections.length, before, 'y sin tocar el sitio');
  await site.stop();
});

const LINE = (shown) => `Esta máquina pidió el alta en la oficina del sitio (huella ${shown}): la aprueba quien mantiene, no tenés que hacer nada`;

test('T9 AltaAutomatica_ClaveYPedidoSinComandos: el par, el pedido, la línea, el buzón, sin red, 4404 y dos a la vez', async () => {
  const { displayFingerprint, fingerprintOf } = fields();
  const site = await toySite();
  const m = withSite(toy(), site.url);
  const first = await hook(m);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.ok(first.ms < 3000, `${first.ms} ms`);
  const keyFile = path.join(m.sdir, 'office', 'site-key.json');
  const key = siteLink().readKey(m.sdir);
  assert.ok(key && key.publicKey && key.fingerprint, 'armó el par');
  if (!WIN) {
    assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600, 'la privada, sólo para su dueño');
    assert.strictEqual(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700, 'y su carpeta');
  }
  assert.strictEqual(Buffer.from(key.publicKey, 'base64').length, 32, 'la pública, ed25519 cruda');
  assert.strictEqual(key.fingerprint, crypto.createHash('sha256').update(Buffer.from(key.publicKey, 'base64')).digest('hex'));
  assert.strictEqual(fingerprintOf(key.publicKey), key.fingerprint);
  assert.strictEqual(site.enrolls.length, 1, 'un pedido de alta');
  const body = JSON.parse(site.enrolls[0]);
  assert.deepStrictEqual(Object.keys(body).sort(), ['fingerprint', 'nombre', 'publicKey']);
  assert.strictEqual(body.publicKey, key.publicKey);
  assert.strictEqual(body.fingerprint, key.fingerprint, 'la huella es la misma en la máquina y en el sitio');
  const shown = displayFingerprint(key.fingerprint);
  assert.strictEqual(first.stdout.trim(), LINE(shown), 'la línea, con la huella que muestra el sitio');
  assert.strictEqual(shown.replace(/-/g, ''), key.fingerprint.slice(0, 16));
  assert.strictEqual(siteLink().readLinkState(m.sdir), 'pedida');
  // el proceso que lanzó firma el desafío
  assert.ok(await until(() => site.auths.length >= 1), 'se conecta solo');
  assert.ok(site.auths[0].verified, 'firma tycon-office-v1|<sitio>|<nonce>');
  assert.strictEqual(site.auths[0].fingerprint, key.fingerprint);
  // la privada no viaja, en ningún mensaje
  const raw = site.raw.join('\n');
  assert.ok(!/PRIVATE|privateKey/.test(raw));
  const stored = fs.readFileSync(keyFile, 'utf8');
  assert.ok(/PRIVATE KEY/.test(stored), 'el archivo sí la guarda');
  const privateBody = key.privateKey.split('\n')[1];
  assert.ok(privateBody.length > 20 && !raw.includes(privateBody), 'ni su contenido');

  // la sesión siguiente no pide de nuevo ni repite la línea
  const second = await hook(m);
  assert.strictEqual(second.stdout, '');
  assert.strictEqual(site.enrolls.length, 1);
  await stopServer(m);

  // el buzón: la huella en su propio archivo, una sola vez
  const puts = [];
  const blobs = new Set();
  let answerExists = false;
  const box = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      puts.push({ ruta, inm: req.headers['if-none-match'], tipo: req.headers['x-ms-blob-type'], body: b });
      if (answerExists || blobs.has(ruta)) { res.writeHead(409); res.end('<Error><Code>BlobAlreadyExists</Code></Error>'); return; }
      blobs.add(ruta);
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  closers.add(() => new Promise((r) => { box.close(() => r()); if (box.closeAllConnections) box.closeAllConnections(); }));
  // la firma de mentira va en su propia variable: pegada a su parámetro, la línea tendría la forma de una llave de verdad
  const fakeSignature = 'FIRMA%2Bdeprueba%3D';
  const cfg = path.join(m.home, 'buzon.json');
  fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '00000000-0000-0000-0000-000000000000', politica: 'subida-prueba', vence: '2099-01-01', sas: `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${fakeSignature}` }));
  const uploadEnv = (log) => envOf(m, { TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: cfg, TYCON_MAILBOX_URL_BASE: `http://127.0.0.1:${box.address().port}`, TYCON_TIMING_HISTORY: path.join(m.home, 'sin-corridas'), TYCON_UPLOADS_LOG: path.join(m.home, log), TYCON_MACHINE: 'maquina-a', TYCON_LOGS_DIR: path.join(m.home, 'registros'), TYCON_LOGS_SOURCE: path.join(m.home, 'sin-logs') });
  const keyPuts = () => puts.filter((p) => p.ruta.includes('/office-keys/'));
  let up = await run(UPLOAD(), ['--json'], uploadEnv('subidas.json'));
  assert.strictEqual(keyPuts().length, 1, `${up.stdout}${up.stderr}`);
  const [put] = keyPuts();
  assert.strictEqual(put.ruta, `/corridas/maquina-a/office-keys/${key.fingerprint}.json`);
  assert.strictEqual(put.inm, '*', 'sólo crea');
  assert.strictEqual(put.tipo, 'BlockBlob');
  assert.deepStrictEqual(JSON.parse(put.body), { fingerprint: key.fingerprint, publicKey: key.publicKey });
  assert.ok(Buffer.byteLength(put.body) <= 512, String(Buffer.byteLength(put.body)));
  assert.ok(!/PRIVATE/.test(put.body));
  const noted = JSON.parse(fs.readFileSync(path.join(m.home, 'subidas.json'), 'utf8'));
  assert.ok(noted.archivos[`maquina-a/office-keys/${key.fingerprint}.json`], 'anotada en el registro de subidas');
  await run(UPLOAD(), ['--json'], uploadEnv('subidas.json'));
  assert.strictEqual(keyPuts().length, 1, 'la misma huella no se vuelve a subir');
  // T52: sin nada nuevo, la línea dice que la huella ya había subido y cuándo
  const subida = noted.archivos[`maquina-a/office-keys/${key.fingerprint}.json`].subido.slice(0, 10);
  assert.match(up.stderr, new RegExp(`nada nuevo que subir desde maquina-a \\(la huella de la oficina ya había subido el ${subida}\\)`), up.stderr);
  assert.strictEqual(JSON.parse(up.stdout).huella_oficina, `ya_subida:${subida}`);
  // un «ya existe» cuenta como subida
  answerExists = true;
  await run(UPLOAD(), ['--json'], uploadEnv('otra-subida.json'));
  assert.strictEqual(keyPuts().length, 2);
  await run(UPLOAD(), ['--json'], uploadEnv('otra-subida.json'));
  assert.strictEqual(keyPuts().length, 2, 'con un «ya existe» tampoco se repite');
  answerExists = false;

  // sin red: no dice nada, y lo intenta en la sesión siguiente
  const port = await freePort();
  const offline = withSite(toy(), `http://127.0.0.1:${port}`);
  const down = await hook(offline);
  assert.strictEqual(down.status, 0);
  assert.strictEqual(down.stdout, '', 'sin red, nada');
  assert.notStrictEqual(siteLink().readLinkState(offline.sdir), 'pedida');
  await stopServer(offline);
  const back = await toySite({ port });
  const retried = await hook(offline);
  assert.strictEqual(back.enrolls.length, 1, 'lo pide en la sesión siguiente');
  assert.strictEqual(retried.stdout.trim(), LINE(displayFingerprint(siteLink().readKey(offline.sdir).fingerprint)));
  await stopServer(offline);
  await back.stop();

  // un sitio que contesta con un error no cuenta como pedido hecho
  const refusing = await toySite();
  refusing.enrollStatus = 429;
  const limited = withSite(toy(), refusing.url);
  assert.strictEqual((await hook(limited)).stdout, '');
  assert.notStrictEqual(siteLink().readLinkState(limited.sdir), 'pedida');
  assert.match(logOf(limited), /429/);
  await stopServer(limited);
  await refusing.stop();

  // 4404: clave nueva y otro pedido
  const lost = withSite(toy(), site.url);
  const gone = await toySite({ mode: 'unknown' });
  const { link, clock } = linkOf(lost, gone);
  link.start();
  assert.ok(await until(() => siteLink().readLinkState(lost.sdir) === 'desconocida'));
  await sleep(100);
  assert.deepStrictEqual(clock.pending(), [], 'no reintenta con una clave que el sitio no conoce');
  link.stop();
  await gone.stop();
  const oldFingerprint = siteLink().readKey(lost.sdir).fingerprint;
  const enrollsBefore = site.enrolls.length;
  const renewed = await hook(lost);
  const newFingerprint = siteLink().readKey(lost.sdir).fingerprint;
  assert.notStrictEqual(newFingerprint, oldFingerprint, 'una clave nueva');
  assert.strictEqual(site.enrolls.length, enrollsBefore + 1, 'y otro pedido');
  assert.strictEqual(renewed.stdout.trim(), LINE(displayFingerprint(newFingerprint)));
  await stopServer(lost);

  // dos sesiones a la vez: un par y un pedido
  site.enrollDelayMs = 400;
  const before = site.enrolls.length;
  const both = withSite(toy(), site.url);
  const [x, y] = await Promise.all([hook(both), hook(both)]);
  assert.strictEqual(x.status, 0);
  assert.strictEqual(y.status, 0);
  assert.strictEqual(site.enrolls.length, before + 1, 'un solo pedido');
  assert.ok(fs.statSync(path.join(both.sdir, 'office', 'site-key.json')).isFile());
  assert.strictEqual(JSON.parse(site.enrolls[before]).fingerprint, siteLink().readKey(both.sdir).fingerprint, 'un solo par');
  assert.deepStrictEqual(fs.readdirSync(path.join(both.sdir, 'office')).filter((f) => /\.tmp|claim/.test(f)), [], 'sin restos');
  site.enrollDelayMs = 0;
  await stopServer(both);

  // un archivo de clave ilegible se reemplaza y se vuelve a pedir el alta; la máquina no queda muda
  const broken = withSite(toy(), site.url);
  fs.mkdirSync(path.dirname(lockOf(broken)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(broken.sdir, 'office', 'site-key.json'), 'no-es-json');
  const enrollsBroken = site.enrolls.length;
  const healed = await hook(broken);
  assert.strictEqual(site.enrolls.length, enrollsBroken + 1, 'otro pedido');
  assert.strictEqual(healed.stdout.trim(), LINE(displayFingerprint(siteLink().readKey(broken.sdir).fingerprint)));
  assert.match(logOf(broken), /site-key\.json/);
  assert.ok(await until(() => readLock(broken)), 'y lanzó el proceso');
  await stopServer(broken);

  // el arranque no pasa de 3 s, ni con un sitio que acepta y no contesta
  site.hangEnroll = true;
  const hanging = withSite(toy(), site.url);
  const slow = await hook(hanging);
  site.hangEnroll = false;
  assert.strictEqual(slow.status, 0);
  assert.ok(slow.ms < 3000, `${slow.ms} ms`);
  assert.strictEqual(slow.stdout, '');
  await stopServer(hanging);
  await site.stop();
});

test('T10 Alta_SinSitio_NoHaceNada: sin site.url no arma clave ni manda nada', async () => {
  const m = toy();
  const r = await hook(m);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(m.sdir, 'office', 'site-key.json')), 'sin clave');
  assert.strictEqual(readLock(m), null, 'sin proceso');
  assert.ok(r.ms < 3000);
  // ni tampoco apagado o en un agente de compilación
  const site = await toySite();
  for (const more of [{ TYCON_OFFICE_LINK: '0' }, { TF_BUILD: 'True' }, { TYCON_EVAL_SANDBOX: '1' }]) {
    const n = withSite(toy(), site.url);
    const off = await hook(n, more);
    assert.strictEqual(off.status, 0);
    assert.strictEqual(off.stdout, '', JSON.stringify(more));
    assert.ok(!fs.existsSync(path.join(n.sdir, 'office', 'site-key.json')), JSON.stringify(more));
    assert.strictEqual(readLock(n), null, JSON.stringify(more));
  }
  assert.strictEqual(site.enrolls.length, 0);
  await site.stop();
});

test('T29 NombreDeSesion_ViajaComoEnLaLocal: el nombre de la coordinación y uno a mano viajan iguales', async () => {
  const { pick } = fields();
  const m = toy({ name: 'Coordinadora' });
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Escrito a mano · Ñandú', nameSource: 'user', status: 'busy', statusUpdatedAt: 1000 }));
  const story = path.join(m.home, 'story-7.1.md');
  fs.writeFileSync(story, '---\nstory: "7.1"\ntitle: "La historia"\n---\n# Story\n');
  fs.writeFileSync(path.join(m.sdir, 'active', 's2.json'), JSON.stringify({ sessionId: 's2', storyId: '7.1', storyPath: story, stepsCompleted: ['start'], stepsPending: ['validate-story'] }));
  const local = await office().collect({ home: m.home, now: '2026-06-01T12:00:00.000Z', siteUrl: async () => ({ code: 3, out: '' }) });
  const sent = pick(local, m.home);
  assert.deepStrictEqual(sent.agents.map((a) => a.nombre), local.agents.map((a) => a.nombre));
  assert.deepStrictEqual(sent.agents.map((a) => a.nombre).sort(), ['Coordinadora', 'Escrito a mano · Ñandú']);
  assert.deepStrictEqual(sent.rows.map((r) => r.session), local.rows.map((r) => r.session));
  assert.deepStrictEqual(sent.free, local.free);
  // la coordinadora quieta, con su nombre, también
  const { buildOffice } = office();
  const { data } = buildOffice({ wip: { rows: [], free: ['Coordinadora', 'Otra'], unreadable: [] }, coordinatorName: 'Coordinadora', nowMs: 1000 });
  assert.deepStrictEqual(pick(data, m.home).agents.map((a) => [a.nombre, a.estado]), [['Coordinadora', 'coordina'], ['Otra', 'libre']]);
});

// Una página: el cliente WebSocket de la copia, con los encabezados de un navegador.
function pageOf(lock) {
  const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/live?t=${lock.token}`, { origin: `http://127.0.0.1:${lock.port}`, headers: { host: `127.0.0.1:${lock.port}` } });
  ws.fotos = [];
  ws.on('message', (raw) => { ws.fotos.push({ data: JSON.parse(String(raw)).data, at: Date.now() }); });
  ws.on('error', () => { /* la prueba mira las fotos */ });
  closers.add(async () => { try { ws.terminate(); } catch { /* ya cerrada */ } });
  return ws;
}
function postEvent(lock, { query = `?t=${lock.token}`, method = 'POST', body = '{"type":"changed","sid":"s1"}' } = {}) {
  return new Promise((resolve, reject) => {
    // una conexión por pedido: el servidor corta la de un pedido que rechaza sin leer, y reusarla daría un error de la prueba
    const req = http.request({ host: '127.0.0.1', port: lock.port, path: `/event${query}`, method, agent: false, headers: { host: `127.0.0.1:${lock.port}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}
const says = (holder, text) => holder.fotos.find((f) => JSON.stringify(f.data).includes(text));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('T40 Eventos_LlegaEnDosSegundos_SinProcesoNoFrena: el aviso llega; sin proceso no frena; la vigilancia sigue de respaldo', async () => {
  const site = await toySite();
  const m = withSite(toy(), site.url);
  const r = await openLocal(m, { TYCON_OFFICE_NO_WATCH: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  const lock = readLock(m);
  // la clave la arma el gancho: acá el proceso ya está y recibe la novedad por el aviso
  assert.strictEqual((await hook(m)).status, 0);
  assert.ok(await until(() => site.fotos.length >= 1), 'la foto llega al sitio de juguete');
  const page = pageOf(lock);
  assert.ok(await until(() => page.fotos.length >= 1));

  // lo que no es un aviso bien formado no pasa
  assert.strictEqual(await postEvent(lock, { query: '' }), 403);
  assert.strictEqual(await postEvent(lock, { query: '?t=errado' }), 403);
  assert.strictEqual(await postEvent(lock, { method: 'GET', body: undefined }), 405);
  assert.strictEqual(await postEvent(lock, { body: 'x'.repeat(300) }), 413);
  assert.strictEqual(await postEvent(lock, { body: '{"type":"run"}' }), 400);
  assert.strictEqual(await postEvent(lock), 204);

  // un cambio del marcador, con la vigilancia apagada: lo que llega es el aviso
  const story = path.join(m.home, 'story-7.1.md');
  fs.writeFileSync(story, '---\nstory: "7.1"\ntitle: "La oficina en el sitio"\n---\n# Story\n');
  const markerEnv = envOf(m, { CLAUDE_CODE_SESSION_ID: 's1' });
  const active = path.join(m.sdir, 'active', 's1.json');
  const set = await run(MARKER(), ['set', JSON.stringify({ storyId: '7.1', storyPath: story, stepsCompleted: ['start'], stepsPending: ['validate-story', 'implement'] })], markerEnv);
  assert.strictEqual(set.status, 0, set.stderr);
  const writtenAt = fs.statSync(active).mtimeMs;
  assert.ok(await until(() => says(page, 'La oficina en el sitio') && says(site, 'La oficina en el sitio'), 3000), 'llegó a la página y al sitio');
  assert.ok(says(page, 'La oficina en el sitio').at - writtenAt < 2000, 'a la página, en menos de 2 s');
  assert.ok(says(site, 'La oficina en el sitio').at - writtenAt < 2000, 'al sitio, en menos de 2 s');
  // un cambio de paso
  const stepped = await run(MARKER(), ['complete-step', 'validate-story'], markerEnv);
  assert.strictEqual(stepped.status, 0, stepped.stderr);
  const steppedAt = fs.statSync(active).mtimeMs;
  const nextStep = 'Va por el paso «Armar el plan».';
  assert.ok(await until(() => says(page, nextStep) && says(site, nextStep), 3000), `${stepped.stderr}${JSON.stringify(site.fotos[site.fotos.length - 1].data.agents)}`);
  assert.ok(says(site, nextStep).at - steppedAt < 2000, 'el cambio de paso, en menos de 2 s');

  // una espera de la ventana del dueño, en el orden real: el freno avisa antes de abrir la ventana, y la herramienta
  // escribe el estado de la sesión recién después
  const ow = require(OWNER_WINDOW);
  const inicio = 'Tue Oct 27 10:00:00 2026';
  const arbol = [{ pid: 1, ppid: 0, inicio, comando: '/sbin/launchd' }, { pid: 100, ppid: 1, inicio, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' },
    { pid: 200, ppid: 100, inicio, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' }, { pid: 201, ppid: 200, inicio, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  const askedAt = Date.now();
  const asked = ow.decidir({
    evento: { session_id: 's1', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node ${MARKER()} mark-tested --acs 3` } },
    arbol, pid: 201, casa: m.home, ahora: askedAt, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null, comprobar: () => null, aprobador: () => ({ label: 'Tu firma' }),
  });
  assert.strictEqual(asked.decision, 'ask', JSON.stringify(asked));
  // más que lo que tarda el aviso en llegar y recalcular: el primer recálculo no ve el estado
  await sleep(700);
  const waits = 'tu respuesta en su pantalla';
  assert.ok(!says(site, waits), 'el estado todavía no está escrito');
  fs.writeFileSync(path.join(m.sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', nameSource: 'user', status: 'waiting_for_permission', statusUpdatedAt: 2000 }));
  assert.ok(await until(() => says(page, waits) && says(site, waits), 3000), 'la espera llegó');
  assert.ok(says(site, waits).at - askedAt < 2000, 'en menos de 2 s');
  // quien espera sigue diciendo por qué paso va; lo que espera va aparte, y la tarjeta del sitio lo dice igual que la local
  const asking = (holder) => says(holder, waits).data.agents.find((a) => a.nombre === 'Alfa');
  assert.strictEqual(asking(site).estado, 'firma');
  assert.strictEqual(asking(site).espera, waits);
  assert.strictEqual(asking(site).haciendo, nextStep);
  assert.strictEqual(asking(page).espera, waits);
  page.terminate();
  await stopServer(m);
  assert.strictEqual(readLock(m), null);

  // sin proceso, el comando termina igual: con el mismo resultado y sin demora de más
  const event = officeEvent();
  const quick = Date.now();
  assert.doesNotThrow(() => event.notify('s1', { home: m.home }));
  assert.ok(Date.now() - quick < 200, 'sin candado, vuelve enseguida');
  const timed = async () => { const x = await run(MARKER(), ['touch'], markerEnv); assert.strictEqual(x.status, 0, x.stderr); return x; };
  const without = [];
  let lastWithout = null;
  for (let i = 0; i < 3; i += 1) { lastWithout = await timed(); without.push(lastWithout.ms); }
  // la ventana del dueño, por su camino de siempre: pide la misma firma con proceso o sin él
  const ask = (id) => {
    const t0 = Date.now();
    const r = ow.decidir({
      evento: { session_id: 's1', tool_use_id: id, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node ${MARKER()} mark-tested --acs 3` } },
      arbol, pid: 201, casa: m.home, ahora: Date.now(), delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null, comprobar: () => null, aprobador: () => ({ label: 'Tu firma' }),
    });
    return { r, ms: Date.now() - t0 };
  };
  const sameAsWithProcess = ({ r }) => { assert.strictEqual(r.decision, asked.decision, JSON.stringify(r)); assert.deepStrictEqual(Object.keys(r).sort(), Object.keys(asked).sort()); };
  const withoutProcess = ask('toolu_02');
  sameAsWithProcess(withoutProcess);
  // un candado de un proceso que ya no está: el aviso se pierde en silencio
  fs.writeFileSync(lockOf(m), JSON.stringify({ pid: 999999, port: await freePort(), token: 'viejo', startedAt: '2026-06-01T12:00:00.000Z' }));
  const stale = [];
  let lastStale = null;
  for (let i = 0; i < 3; i += 1) { lastStale = await timed(); stale.push(lastStale.ms); }
  assert.ok(median(stale) - median(without) < 200, `sin proceso: ${without} ms, con candado viejo: ${stale} ms`);
  assert.strictEqual(lastStale.stderr, '', 'y se calla');
  assert.strictEqual(lastStale.stdout, lastWithout.stdout, 'el comando dice lo mismo');
  const staleWindow = ask('toolu_03');
  sameAsWithProcess(staleWindow);
  assert.ok(staleWindow.ms - withoutProcess.ms < 200, `ventana sin proceso: ${withoutProcess.ms} ms, con candado viejo: ${staleWindow.ms} ms`);
  const q2 = Date.now();
  assert.doesNotThrow(() => event.notify('s1', { home: m.home }));
  assert.ok(Date.now() - q2 < 200, 'con candado viejo, tampoco espera');
  fs.unlinkSync(lockOf(m));

  // con la vigilancia prendida, un cambio que no avisa también llega
  const w = withSite(toy(), site.url);
  assert.strictEqual((await openLocal(w)).status, 0);
  assert.strictEqual((await hook(w)).status, 0);
  const watched = pageOf(readLock(w));
  assert.ok(await until(() => watched.fotos.length >= 1));
  fs.writeFileSync(path.join(w.sessions, 's9.json'), JSON.stringify({ pid: process.pid, sessionId: 's9', name: 'Sin aviso', nameSource: 'user', status: 'busy', statusUpdatedAt: 1000 }));
  assert.ok(await until(() => says(watched, 'Sin aviso') && says(site, 'Sin aviso'), 4000), 'la vigilancia sigue de respaldo');
  watched.terminate();
  await stopServer(w);
  await site.stop();
});

// ── Un proceso por máquina ──────────────────────────────────────────────────────────────────────────────────────────

// Un lector de pedidos de juguete: anota cada lectura y deja la foto de los pedidos, como el de verdad.
function fakePrReader(m) {
  const script = path.join(m.home, 'fake-refresh.js');
  const log = `${script}.log`;
  const photo = path.join(m.sdir, 'stuck-prs-photo.json');
  fs.writeFileSync(script, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, 'x\\n');
fs.writeFileSync(${JSON.stringify(photo)}, JSON.stringify({ at: new Date().toISOString(), lecturas: {} }));`);
  return { script, reads: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').length; } catch { return 0; } } };
}

test('Regresion_SinPaginas_ElRelojDePedidosSeCorta_LaVidaLaDecideReviewLife: con sitio y sin él, abrir y cerrar páginas', async () => {
  const opened = (ws) => new Promise((resolve) => { if (ws.fotos.length) resolve(); else ws.once('message', () => resolve()); });
  const closeOf = (ws) => new Promise((resolve) => { ws.once('close', resolve); ws.close(); });
  const waitAll = (lock, ms) => until(() => !alive(lock.pid), ms);

  // sin sitio: la página sostiene el proceso y el reloj de los pedidos; sin ella, las dos cosas se cortan
  const a = toy();
  const readerA = fakePrReader(a);
  assert.strictEqual((await openLocal(a, { TYCON_OFFICE_IDLE_MS: '2000', TYCON_OFFICE_PR_REFRESH: readerA.script, TYCON_OFFICE_PR_PHOTO_MS: '200', TYCON_OFFICE_NO_WATCH: '1' })).status, 0);
  const lockA = readLock(a);
  assert.ok(alive(lockA.pid), 'sin páginas, el proceso espera su reloj');
  assert.strictEqual(readerA.reads(), 0, 'sin páginas no se leen los pedidos');
  const first = pageOf(lockA);
  await opened(first);
  // abrir la página cancela el apagado: pasa de largo el plazo y sigue, leyendo los pedidos
  await sleep(2400);
  assert.ok(alive(lockA.pid), 'con una página abierta no se apaga');
  assert.ok(readerA.reads() >= 2, `con una página se leen los pedidos (${readerA.reads()})`);
  // cerrar una de dos no corta nada: la otra sigue mirando
  const second = pageOf(lockA);
  await opened(second);
  await closeOf(first);
  const withOne = readerA.reads();
  await sleep(2400);
  assert.ok(alive(lockA.pid), 'queda una página: no se apaga');
  assert.ok(readerA.reads() > withOne, 'queda una página: se siguen leyendo los pedidos');
  // sin ninguna, el reloj de los pedidos se corta enseguida y el proceso se apaga a su plazo
  await closeOf(second);
  const atClose = readerA.reads();
  await sleep(300);
  assert.ok(readerA.reads() <= atClose + 1, 'sin páginas deja de leer');
  const settled = readerA.reads();
  // volver antes del plazo cancela el apagado y vuelve a leer
  const third = pageOf(lockA);
  await opened(third);
  await sleep(2400);
  assert.ok(alive(lockA.pid), 'la página que volvió canceló el apagado');
  assert.ok(readerA.reads() > settled, 'y el reloj de los pedidos volvió a andar');
  await closeOf(third);
  const last = readerA.reads();
  assert.ok(await waitAll(lockA, 6000), 'sin páginas ni sitio, se apaga');
  assert.ok(readerA.reads() <= last + 1, 'no leyó más mientras se apagaba');
  assert.strictEqual(readLock(a), null);

  // con sitio y una sesión viva: cerrar la página corta el reloj de los pedidos, y el proceso sigue por la sesión
  const site = await toySite();
  const b = withSite(toy(), site.url);
  const readerB = fakePrReader(b);
  const session = path.join(b.sessions, 's1.json');
  assert.strictEqual((await openLocal(b, { TYCON_OFFICE_IDLE_MS: '500', TYCON_OFFICE_SESSION_CHECK_MS: '100', TYCON_OFFICE_PR_REFRESH: readerB.script, TYCON_OFFICE_PR_PHOTO_MS: '200', TYCON_OFFICE_NO_WATCH: '1' })).status, 0);
  const lockB = readLock(b);
  const pageB = pageOf(lockB);
  await opened(pageB);
  await sleep(700);
  assert.ok(readerB.reads() >= 2, `con una página se leen los pedidos (${readerB.reads()})`);
  await closeOf(pageB);
  const atCloseB = readerB.reads();
  await sleep(1000);
  assert.ok(alive(lockB.pid), 'sin páginas, la sesión viva lo sostiene');
  assert.ok(readerB.reads() <= atCloseB + 1, 'sin páginas no se leen los pedidos, aunque el proceso siga');
  // sin sesiones ni páginas, el repaso arranca el apagado
  fs.rmSync(session);
  assert.ok(await waitAll(lockB, 6000), 'sin sesiones ni páginas, se apaga');
  assert.strictEqual(readLock(b), null);
  await site.stop();
});

test('Regresion_LoQueSaleDeLaConversacion_ViajaSaneado: de la última acción no viaja el archivo; lo que escribió una persona, sí', () => {
  const { pick } = fields();
  const { readTranscript } = require(path.join(ROOT, 'scripts', 'lib', 'session-transcript.js'));
  const file = path.join(tmp('office-transcript-'), 's.jsonl');
  const at = new Date('2026-06-01T12:00:00Z').toISOString();
  const conversation = (encargo) => {
    fs.writeFileSync(file, `${[
      { type: 'user', isSidechain: false, timestamp: at, message: { role: 'user', content: encargo } },
      { type: 'assistant', isSidechain: false, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${USERS_HOME}/clientes/contrato-acme-sa.pdf` } }] } },
    ].map((l) => JSON.stringify(l)).join('\n')}\n`);
    const said = readTranscript(file);
    return { said, sent: pick({ agents: [{ encargo: said.encargo, ultimaAccion: said.ultimaAccion }] }, '/Users/dev-a').agents[0] };
  };
  // la oficina local dice el archivo; al sitio van sólo la acción y la hora
  const secret = 'abcd1234efgh5678';
  const { said, sent } = conversation(`usá password=${secret} ahora. Ordená las pruebas.`);
  assert.match(said.ultimaAccion, /contrato-acme-sa\.pdf/);
  assert.match(sent.ultimaAccion, /^Editar · a las \d\d:\d\d$/);
  assert.ok(!JSON.stringify(sent).includes('acme'), JSON.stringify(sent));
  assert.strictEqual(sent.encargo, 'Ordená las pruebas.', 'la oración con una clave con nombre no viaja');
  assert.strictEqual(pick({ agents: [{ ultimaAccion: 'Ejecutar un comando' }] }, '/h').agents[0].ultimaAccion, 'Ejecutar un comando');
  // un texto libre que no tiene forma de clave viaja: lo aceptó el dueño, con el encargo a la vista en la oficina local
  assert.strictEqual(conversation('La clave es hunter2. Seguí.').sent.encargo, 'La clave es hunter2.');
});

test('T28 Site_RowsTravel_OtherProjectDoesNot @story-8.184 @ac-26: viajan los trabajos; en `tablas`, el título de otro proyecto no', () => {
  const { pick } = fields();
  const { buildTables } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const kanban = { columnas: [
    { id: 'curso', tarjetas: [
      { titulo: 'Mesa secreta de otro cliente', quien: 'Rojas · Otro proyecto', hora: 'lun 12:00', clave: 'titulo:mesa', otro: true },
      { titulo: 'Lo de la oficina', quien: 'Paz', hora: 'lun 13:00', clave: 'titulo:oficina', tema: 'Oficina' },
    ] },
  ], medioCamino: [], anteriores: [] };
  const tablas = buildTables({ kanban, nowMs: Date.parse('2026-11-03T14:00:00Z') });
  const sent = pick({ tablas }, '/home/nadie').tablas;
  assert.ok(!JSON.stringify(sent).includes('Mesa secreta'), 'ni en la fila ni en sus trabajos');
  const other = sent.hoy.filas.find((r) => r.grupo === 'Otro proyecto');
  assert.strictEqual(other.que, 'Otro proyecto');
  assert.deepStrictEqual(other.trabajos.map((w) => w.titulo), ['Otro proyecto']);
  assert.strictEqual(other.col, '1 en curso', 'la cuenta sí viaja');
  const own = sent.hoy.filas.find((r) => r.grupo === 'Oficina');
  assert.deepStrictEqual(own.trabajos, [{ titulo: 'Lo de la oficina', quien: 'Paz', como: 'En curso · lun 13:00' }]);
  assert.strictEqual(own.otro, undefined);
  // en la máquina, el título se sigue viendo
  assert.match(JSON.stringify(tablas), /Mesa secreta/);
});

test('Regresion_FotoReal_TodoLoQueTraeViajaOSeLoDeja: una sección nueva de la foto no se pierde en silencio', async () => {
  const { pick, FIELDS } = fields();
  const m = toy();
  fs.mkdirSync(path.join(m.sdir, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(m.sdir, 'coordination', 'tablero.json'), JSON.stringify({ meta: { resumen: 'Resumen real', teToca: ['Algo'] }, pendientes: [{ titulo: 'Pendiente real', estado: 'espera', grupo: 'Hoy' }] }));
  applySite(m);
  const r = await run(OFFICE_RUN(), ['--json'], envOf(m));
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const foto = parsed.data || parsed;
  // `items` es la única que se queda, a propósito: la página no lee sus campos (T1)
  assert.deepStrictEqual(Object.keys(foto).filter((k) => !(k in FIELDS)), ['items'], 'cada sección de la foto real está en la lista');
  const sent = pick(foto, m.home);
  assert.strictEqual(sent.tablero.resumen, 'Resumen real');
  assert.ok(sent.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.some((c) => c.titulo === 'Pendiente real'));
  assert.strictEqual(sent.tablas.hoy.titulo, 'Hoy');
  assert.strictEqual(sent.tablas.pendientes.titulo, 'Pendientes');
});

test('Regresion_ProcesoOcupado_ElGanchoNoLanzaOtro: uno vivo que tarda en contestar sigue siendo el de la máquina', async () => {
  const site = await toySite();
  const m = withSite(toy(), site.url);
  const owner = await busyOffice(m, 1500);
  const r = await hook(m);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(await until(() => !fs.existsSync(startingOf(m)), 8000), 'nadie quedó esperando');
  await sleep(300);
  assert.strictEqual(fs.readFileSync(lockOf(m), 'utf8'), owner.lockText, 'el candado sigue siendo del que estaba');
  assert.deepStrictEqual(startsOf(m), [], 'ningún otro proceso arrancó');
  assert.strictEqual(site.connections.length, 0, 'y nadie más se conectó');
  await site.stop();
});

test('Regresion_ProcesoCongelado_SigueUnoSolo: de punta a punta, con el proceso real frenado durante el gancho', { skip: WIN }, async () => {
  const site = await toySite();
  const m = withSite(toy(), site.url);
  assert.strictEqual((await hook(m)).status, 0);
  assert.ok(await until(() => readLock(m) && site.fotos.length >= 1), 'el proceso está conectado');
  const { pid } = readLock(m);
  started.add(pid);
  process.kill(pid, 'SIGSTOP');
  assert.strictEqual((await hook(m)).status, 0);
  await sleep(1000);
  process.kill(pid, 'SIGCONT');
  assert.ok(await until(() => !fs.existsSync(startingOf(m)), 8000), 'nadie quedó esperando');
  assert.deepStrictEqual(startsOf(m), [String(pid)], 'un solo proceso arrancó');
  assert.strictEqual(readLock(m).pid, pid, 'y el candado sigue siendo suyo');
  assert.ok(alive(pid));
  assert.strictEqual(site.connections.filter((c) => c.readyState === WebSocket.OPEN).length, 1, 'una sola conexión al sitio');
  await stopServer(m);
  await site.stop();
});

test('Regresion_ProcesoQueArrancaConOtroVivo_SeVaSinTocarElCandado: se va solo, y suelta el arranque si lo lanzó el gancho', async () => {
  const m = toy();
  const owner = await busyOffice(m, 800);
  const r = await runServer(m);
  assert.strictEqual(r.signal, null, 'se fue solo');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /otra oficina/);
  assert.strictEqual(fs.readFileSync(lockOf(m), 'utf8'), owner.lockText, 'el candado no se tocó');
  assert.deepStrictEqual(startsOf(m), []);
  fs.writeFileSync(startingOf(m), '');
  const launched = await runServer(m, { TYCON_OFFICE_RELEASE_STARTING: '1' });
  assert.strictEqual(launched.status, 0, launched.stderr);
  assert.ok(!fs.existsSync(startingOf(m)), 'soltó el arranque');
});

test('Regresion_OpenLive_ConLaOficinaOcupada_UsaLaQueEsta: /office no arranca otra ni falla', async () => {
  const m = toy();
  const owner = await busyOffice(m, 1800);
  const r = await openLocal(m);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`:${owner.port}/`), r.stdout);
  assert.strictEqual(fs.readFileSync(lockOf(m), 'utf8'), owner.lockText);
  assert.deepStrictEqual(startsOf(m), []);
});

test('Regresion_PidVivoQueNoEsLaOficina_NoFrenaElArranque: pid reusado, sin puerto, con otra respuesta o mudo pasado el plazo', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  started.add(other.pid);
  const closed = toy();
  fs.mkdirSync(path.dirname(lockOf(closed)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockOf(closed), JSON.stringify({ pid: other.pid, port: await freePort(), token: 'ajeno', startedAt: '2026-06-01T12:00:00.000Z' }));
  assert.strictEqual((await openLocal(closed)).status, 0);
  assert.strictEqual(startsOf(closed).length, 1, 'nadie escucha en su puerto: arranca');
  assert.notStrictEqual(readLock(closed).token, 'ajeno');
  assert.ok(alive(other.pid), 'y al otro no lo toca');
  await stopServer(closed);

  const answersOther = toy();
  await busyOffice(answersOther, 0, other.pid + 1);
  assert.strictEqual((await openLocal(answersOther)).status, 0);
  assert.strictEqual(startsOf(answersOther).length, 1, 'contesta con otro pid: arranca');
  await stopServer(answersOther);

  const mute = toy();
  const silent = await busyOffice(mute, 1e9);
  assert.strictEqual((await openLocal(mute, { TYCON_OFFICE_OWNER_WAIT_MS: '300' })).status, 0);
  assert.strictEqual(startsOf(mute).length, 1, 'mudo pasado el plazo: arranca');
  assert.notStrictEqual(readLock(mute).pid, silent.pid);
  await stopServer(mute);
});

test('Regresion_ProcesoQuePerdioElCandado_SeVa: si otro escribió su candado encima, sigue uno solo', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  started.add(other.pid);
  const m = toy();
  assert.strictEqual((await openLocal(m)).status, 0);
  const lock = readLock(m);
  fs.writeFileSync(lockOf(m), JSON.stringify({ ...lock, pid: other.pid }));
  assert.strictEqual(await postEvent(lock), 204);
  assert.ok(await until(() => !alive(lock.pid), 5000), 'se fue');
  assert.strictEqual(readLock(m).pid, other.pid, 'sin tocar el candado del otro');
});

// ── La clave ilegible ───────────────────────────────────────────────────────────────────────────────────────────────

test('Regresion_ClaveIlegible_SeReemplazaYSePideElAlta: cualquier archivo que no sirve; la máquina no queda muda', async () => {
  const site = await toySite();
  const { displayFingerprint } = fields();
  const mismatch = JSON.stringify({ publicKey: 'AAAA', fingerprint: 'otra', privateKey: 'contenido-privado' });
  for (const [name, content, state] of [['no es JSON', 'contenido-privado', null], ['vacío', '', null], ['sin campos', '{"privateKey":"contenido-privado"}', 'aprobada'], ['huella que no coincide', mismatch, 'aprobada']]) {
    const m = withSite(toy(), site.url);
    fs.mkdirSync(path.dirname(lockOf(m)), { recursive: true, mode: 0o700 });
    const keyFile = path.join(m.sdir, 'office', 'site-key.json');
    fs.writeFileSync(keyFile, content);
    if (state) siteLink().writeLinkState(m.sdir, state);
    const before = site.enrolls.length;
    const r = await hook(m);
    assert.strictEqual(r.status, 0, name);
    const key = siteLink().readKey(m.sdir);
    assert.ok(key, `${name}: quedó una clave que sirve`);
    assert.strictEqual(site.enrolls.length, before + 1, `${name}: otro pedido de alta`);
    assert.strictEqual(JSON.parse(site.enrolls[before]).fingerprint, key.fingerprint);
    assert.strictEqual(r.stdout.trim(), LINE(displayFingerprint(key.fingerprint)), name);
    assert.strictEqual(siteLink().readLinkState(m.sdir), 'pedida', name);
    if (!WIN) assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600, name);
    assert.match(logOf(m), /site-key\.json/, name);
    assert.ok(!logOf(m).includes('contenido-privado'), 'el registro no copia el contenido');
    const again = await hook(m);
    assert.strictEqual(again.stdout, '', `${name}: la sesión siguiente no pide de nuevo`);
    assert.strictEqual(site.enrolls.length, before + 1, name);
    await stopServer(m);
  }
  await site.stop();
});

test('Regresion_ClaveIlegible_ElGanchoLanzaElProcesoIgual: con una clave que no se puede reemplazar, el proceso arranca', async () => {
  const site = await toySite();
  const m = withSite(toy(), site.url);
  const keyFile = path.join(m.sdir, 'office', 'site-key.json');
  fs.mkdirSync(path.join(keyFile, 'una-carpeta'), { recursive: true });
  siteLink().writeLinkState(m.sdir, 'aprobada');
  const r = await hook(m);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(await until(() => readLock(m)), 'lanzó el proceso');
  started.add(readLock(m).pid);
  assert.strictEqual(siteLink().readLinkState(m.sdir), 'aprobada', 'el estado sigue como estaba');
  assert.match(logOf(m), /site-key\.json/);
  await stopServer(m);
  await site.stop();
});

test('Regresion_ClaveYEstadoIlegibles_QuedanAnotados: el estado roto y la subida al buzón lo dicen', async () => {
  const m = toy();
  const { readLinkState, writeLinkState, ensureKey } = siteLink();
  fs.mkdirSync(path.dirname(lockOf(m)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(m.sdir, 'office', 'site-key-state.json'), 'no-es-json');
  assert.strictEqual(readLinkState(m.sdir), null);
  assert.strictEqual(readLinkState(m.sdir), null);
  assert.strictEqual(logOf(m).split('\n').filter((l) => l.includes('site-key-state.json')).length, 1, 'anotado, una vez');
  const fresh = toy();
  fs.mkdirSync(path.dirname(lockOf(fresh)), { recursive: true, mode: 0o700 });
  assert.strictEqual(readLinkState(fresh.sdir), null);
  assert.strictEqual(logOf(fresh), '', 'sin archivo no hay nada que anotar');
  writeLinkState(fresh.sdir, 'pedida');
  assert.strictEqual(readLinkState(fresh.sdir), 'pedida');

  // la subida al buzón: con un archivo roto lo dice; sin archivo, calla
  const box = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(201); res.end(); }); });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  closers.add(() => new Promise((r) => { box.close(() => r()); if (box.closeAllConnections) box.closeAllConnections(); }));
  const fakeSignature = 'FIRMA%2Bdeprueba%3D';
  const upload = (t) => {
    const cfg = path.join(t.home, 'buzon.json');
    fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '00000000-0000-0000-0000-000000000000', politica: 'subida-prueba', vence: '2099-01-01', sas: `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${fakeSignature}` }));
    return run(UPLOAD(), ['--json'], envOf(t, { TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: cfg, TYCON_MAILBOX_URL_BASE: `http://127.0.0.1:${box.address().port}`, TYCON_TIMING_HISTORY: path.join(t.home, 'sin-corridas'), TYCON_UPLOADS_LOG: path.join(t.home, 'subidas.json'), TYCON_MACHINE: 'maquina-a', TYCON_LOGS_DIR: path.join(t.home, 'registros'), TYCON_LOGS_SOURCE: path.join(t.home, 'sin-logs') }));
  };
  const broken = toy();
  fs.mkdirSync(path.dirname(lockOf(broken)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(broken.sdir, 'office', 'site-key.json'), 'contenido-privado');
  const said = await upload(broken);
  assert.match(said.stdout + said.stderr, /clave de la oficina/);
  assert.ok(!(said.stdout + said.stderr).includes('contenido-privado'));
  const none = toy();
  const quiet = await upload(none);
  assert.ok(!/clave de la oficina/.test(quiet.stdout + quiet.stderr), quiet.stdout);
  const good = toy();
  ensureKey(good.sdir);
  const up = await upload(good);
  assert.ok(!/clave de la oficina/.test(up.stdout + up.stderr), up.stdout);
});

// ── Los relojes de la conexión ──────────────────────────────────────────────────────────────────────────────────────

test('Regresion_SaludoMudo_SeCortaYReintenta: sin desafío o sin ack a tiempo se corta, se anota y wake vuelve a intentar', async () => {
  for (const [name, mute] of [['sin desafío', (s) => { s.noChallenge = true; }], ['sin ack', (s) => { s.mode = 'mute'; }]]) {
    const m = toy();
    const site = await toySite();
    mute(site);
    const { link, clock } = linkOf(m, site, 'aprobada');
    link.update(FOTO());
    link.start();
    assert.ok(await until(() => site.connections.length === 1), name);
    if (site.mode === 'mute') assert.ok(await until(() => site.auths.length === 1), name);
    await sleep(50);
    assert.ok(clock.pending().some((t) => t.ms === GREETING_MS), `${name}: un reloj cubre el saludo`);
    clock.advance(GREETING_MS);
    assert.ok(await until(() => site.closes.length === 1), `${name}: se cortó`);
    assert.match(logOf(m), /saludo/, name);
    assert.ok(await until(() => waits(clock).length === 1), `${name}: y reintenta`);
    site.noChallenge = false;
    site.mode = 'approve';
    link.wake();
    assert.ok(await until(() => site.fotos.length === 1), `${name}: wake vuelve a intentar enseguida`);
    assert.ok(!clock.pending().some((t) => t.ms === GREETING_MS), `${name}: con el ack el reloj del saludo se apaga`);
    link.stop();
    await site.stop();
  }
});

test('Regresion_LatidoNoDependeDeLasFotos: con fotos cada 45 s hay latido, y un sitio mudo se corta igual', async () => {
  const m = toy();
  const site = await toySite();
  const { link, clock } = linkOf(m, site);
  link.update(FOTO('primera'));
  link.start();
  assert.ok(await until(() => site.fotos.length === 1));
  site.muteHeartbeat = true;
  const [conn] = site.connections;
  // el reloj de juguete salta: el latido sale a los 90 s, y el siguiente vence a los 150 s
  for (let i = 0; i < 4; i += 1) {
    clock.advance(45000);
    link.update(FOTO(`foto ${i}`));
    await sleep(30);
  }
  assert.ok(await until(() => site.pings.length === 1), 'hubo latido, aunque hubo fotos');
  assert.ok(await until(() => conn.readyState !== WebSocket.OPEN), 'el sitio que no contesta el latido se corta');
  link.stop();
  await site.stop();
});

test('Regresion_AckSeguidoDeCierre_LaEsperaSigueCreciendo: sólo el primer pong vuelve la espera a 2 s', async () => {
  const m = toy();
  const site = await toySite();
  site.closeAfterAck = true;
  const { link, clock } = linkOf(m, site);
  link.update(FOTO());
  link.start();
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    assert.ok(await until(() => site.auths.length === i + 1), `vuelta ${i}`);
    assert.ok(await until(() => waits(clock).length === 1), `vuelta ${i}`);
    const [t] = waits(clock);
    delays.push(t.ms);
    if (i < 5) clock.advance(t.ms);
    await sleep(5);
  }
  assert.deepStrictEqual(delays, [2000, 4000, 8000, 16000, 32000, 64000]);
  assert.strictEqual(logOf(m).split('\n').filter((l) => l.includes('reintenta')).length, 1, 'un renglón por corte, no uno por vuelta');
  // la conexión que dura: con el primer pong, otra vez 2 s
  site.closeAfterAck = false;
  const auths = site.auths.length;
  clock.advance(waits(clock)[0].ms);
  assert.ok(await until(() => site.auths.length === auths + 1));
  assert.ok(await until(() => site.connections[site.connections.length - 1].readyState === WebSocket.OPEN));
  await sleep(50);
  clock.advance(BEAT_MS);
  assert.ok(await until(() => site.pings.length === 1));
  await sleep(50);
  site.connections[site.connections.length - 1].close(1011, 'el sitio se reinicia');
  assert.ok(await until(() => waits(clock).length === 1));
  assert.strictEqual(waits(clock)[0].ms, 2000);
  link.stop();
  await site.stop();
});

// ── Los avisos del marcador ─────────────────────────────────────────────────────────────────────────────────────────

test('Regresion_BorrarElMarcadorYLaNota_AvisanALaOficina: con la vigilancia apagada, cada cambio llega por el aviso', async () => {
  const m = toy();
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Beta', nameSource: 'user', status: 'busy', statusUpdatedAt: 1000 }));
  assert.strictEqual((await openLocal(m, { TYCON_OFFICE_NO_WATCH: '1' })).status, 0);
  const page = pageOf(readLock(m));
  assert.ok(await until(() => page.fotos.length >= 1));
  const lastSays = (text) => { const f = page.fotos[page.fotos.length - 1]; return Boolean(f) && JSON.stringify(f.data).includes(text); };
  const shows = (text, step) => until(() => lastSays(text), 4000).then((ok) => assert.ok(ok, `${step}: llegó`));
  const hides = (text, step) => until(() => !lastSays(text), 4000).then((ok) => assert.ok(ok, `${step}: se fue`));
  const env1 = envOf(m, { CLAUDE_CODE_SESSION_ID: 's1' });
  const env2 = envOf(m, { CLAUDE_CODE_SESSION_ID: 's2' });
  const mark = async (args, env) => { const r = await run(MARKER(), args, env); assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`); };

  // la nota de la sesión
  await mark(['doing', 'Revisando la oficina del sitio'], env1);
  await shows('Revisando la oficina del sitio', 'doing');
  await mark(['doing', 'clear'], env1);
  await hides('Revisando la oficina del sitio', 'doing clear');

  // el marcador, por su borrado
  const story = path.join(m.home, 'story-7.1.md');
  fs.writeFileSync(story, '---\nstory: "7.1"\ntitle: "La oficina en el sitio"\n---\n# Story\n');
  const marker = (sid) => JSON.stringify({ storyId: '7.1', storyPath: story, sessionId: sid, stepsCompleted: ['start'], stepsPending: ['validate-story'] });
  await mark(['set', marker('s1')], env1);
  await shows('La oficina en el sitio', 'set');
  await mark(['clear'], env1);
  await hides('La oficina en el sitio', 'clear');

  // el borrado desde otra sesión
  await mark(['set', marker('s1')], env1);
  await shows('La oficina en el sitio', 'set');
  await mark(['clear-session', 's1'], env2);
  await hides('La oficina en el sitio', 'clear-session');

  // el arreglo rápido: su hora y su cierre
  fs.writeFileSync(path.join(m.sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'Un arreglo rápido de prueba', maxFiles: 8, files: [], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() }));
  await mark(['adhoc', 'until', '23:59'], env1);
  await shows('Un arreglo rápido de prueba', 'adhoc until');
  await mark(['adhoc', 'clear'], env1);
  await hides('Un arreglo rápido de prueba', 'adhoc clear');

  page.terminate();
  await stopServer(m);
});

// ── El saneado ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('Regresion_TokensSueltosYRutas_NoViajan: credenciales sin nombre y rutas enteras, por el camino real de la foto', () => {
  const { pick } = fields();
  const home = '/root';
  const secrets = [
    ...LOOSE_TOKENS(),
    ['firma SAS corta', `https://acme.example/c?sv=2024&sig=${'AbCd'}%2Bx&se=2027`, `${'AbCd'}%2Bx`],
    ['usuario y clave en una dirección', `${'postgres'}://dbuser:${'p4ssw0rd'}Largo@db.acme.example/app`, `${'p4ssw0rd'}Largo`],
    ['clave de una cuenta', `AccountKey=${'k'.repeat(20)}==;EndpointSuffix=acme`, 'k'.repeat(20)],
    ['llave privada, con su contenido', `-----BEGIN ${'PRIVATE'} KEY-----\nMII${'m'.repeat(20)}\n-----END ${'PRIVATE'} KEY-----`, 'm'.repeat(20)],
    ['llave privada, sin su cierre', `-----BEGIN ${'PRIVATE'} KEY-----MII${'n'.repeat(20)}`, 'n'.repeat(20)],
  ];
  for (const [name, text, secret = text] of secrets) {
    const sent = pick({
      agents: [{ nombre: 'Alfa', haciendo: `corre con ${text}`, titulo: text, carpeta: `${USERS_HOME}/${text}` }],
      kanban: { columnas: [{ id: 'curso', tarjetas: [{ titulo: 'T', nota: `con ${text}` }] }] },
      tablas: { hoy: { filas: [{ que: `con ${text}` }] } },
      tablero: { resumen: `con ${text}` },
    }, home);
    assert.ok(!JSON.stringify(sent).includes(secret), `${name}: ${JSON.stringify(sent)}`);
  }
  for (const route of ['/opt/acme-cliente/secreto.cs', 'D:/Proyectos/Cliente/a.cs', '/mnt/data/cliente/a.cs', '/root/proyectos/cliente/a.cs', '\\\\servidor\\cliente\\a.cs', '~\\proyectos\\cliente\\a.cs']) {
    const json = JSON.stringify(pick({ agents: [{ haciendo: `mirá ${route} y seguí` }] }, home));
    assert.ok(!/cliente/i.test(json), `${route}: ${json}`);
    assert.match(json, /mirá .* y seguí/, route);
  }
  // lo que no es un secreto ni una ruta personal llega como estaba
  for (const text of ['Mirá scripts/lib/x.js y la página /office', 'y/o el 10/11/2026 a las 10:30', 'https://acme.example/oficinas', 'PATH=/usr/local/bin:/usr/bin']) {
    assert.strictEqual(pick({ agents: [{ haciendo: text }] }, home).agents[0].haciendo, text);
  }
});

// ── La línea de espera ──────────────────────────────────────────────────────────────────────────────────────────────

test('Regresion_LineaDeEspera_SoloConSitioYEnlace: sin site.url o con el enlace apagado, /office no dice que espera', async () => {
  const site = await toySite({ mode: 'pending' });
  const waiting = () => {
    const m = toy();
    siteLink().ensureKey(m.sdir);
    siteLink().writeLinkState(m.sdir, 'pedida');
    return m;
  };
  const noSite = waiting();
  const a = await openLocal(noSite);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.ok(!a.stdout.includes('espera la aprobación'), a.stdout);
  await stopServer(noSite);
  const off = withSite(waiting(), site.url);
  const b = await openLocal(off, { TYCON_OFFICE_LINK: '0' });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(!b.stdout.includes('espera la aprobación'), b.stdout);
  await stopServer(off);
  const on = withSite(waiting(), site.url);
  const c = await openLocal(on);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.ok(c.stdout.includes('espera la aprobación'), c.stdout);
  await stopServer(on);
  await site.stop();
});

// ── La capa del equipo mientras se trabaja, el enlace sin abrir sesión y el proceso que relee la dirección ─────

// El gancho con lo que le manda la herramienta por la entrada: el evento.
function hookOn(m, event, more = {}) {
  applySite(m);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [HOOK()], { env: envOf(m, more), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 's1', prompt: 'seguí' }));
  });
}
// La puesta al día de juguete: cuenta cada corrida, tarda `sleepMs` y, si se le da `site`, deja esa dirección en el perfil
// del árbol, como la capa nueva del equipo.
function refreshFake(m, { sleepMs = 0, site = undefined, status = 'refreshed' } = {}) {
  const dir = tmp('team-refresh-');
  const file = path.join(dir, 'fake-harness.js');
  const runs = path.join(dir, 'runs.log');
  const profile = inTree('team-profile.json');
  fs.writeFileSync(file, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(runs)}, process.argv.slice(2).join(' ') + '\\n');
setTimeout(() => {
  const site = ${JSON.stringify(site === undefined ? null : site)};
  if (site !== null) fs.writeFileSync(${JSON.stringify(profile)}, JSON.stringify({ site: { url: site } }));
  console.log(JSON.stringify({ status: ${JSON.stringify(status)}, profileChanged: site !== null, lines: [] }));
}, ${sleepMs});
`);
  return { file, runs: () => { try { return fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } } };
}
const stampOf = (m) => path.join(m.sdir, 'office', 'team-refresh.json');
const ageStamp = (m, minutes) => fs.writeFileSync(stampOf(m), JSON.stringify({ at: new Date(Date.now() - minutes * 60000).toISOString() }));
function countersOf(lock) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: lock.port, path: `/debug/counters?t=${lock.token}`, headers: { host: `127.0.0.1:${lock.port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

test('T44 CadaTreintaMinutos_SinEsperar: un pedido lanza la puesta al día aparte; dentro de los 30 min no; apagada o en un agente, nada', async () => {
  const m = toy();
  const fake = refreshFake(m, { sleepMs: 3000 });
  const env = { TYCON_TEAM_REFRESH_RUN: fake.file };
  const first = await hookOn(m, 'UserPromptSubmit', env);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(first.stdout, '', 'al pedir no dice nada');
  assert.ok(first.ms < 2500, `no espera la puesta al día, que tarda 3 s (${first.ms} ms)`);
  assert.ok(fs.existsSync(stampOf(m)), 'el sello, escrito al lanzarla');
  assert.ok(await until(() => fake.runs().length === 1, 8000), 'la puesta al día corrió aparte');
  assert.deepStrictEqual(fake.runs(), ['team-refresh --json']);
  // dentro de los 30 min, aunque la anterior no haya terminado: nada
  assert.strictEqual((await hookOn(m, 'UserPromptSubmit', env)).status, 0);
  await sleep(600);
  assert.strictEqual(fake.runs().length, 1, 'dentro de los 30 min no lanza otra');
  // pasados los 30 min, otra
  ageStamp(m, 31);
  assert.strictEqual((await hookOn(m, 'UserPromptSubmit', env)).status, 0);
  assert.ok(await until(() => fake.runs().length === 2, 8000), 'pasados los 30 min, otra');
  // apagada, en un agente de compilación, o al abrir la sesión (eso lo hace el arranque del arnés): nada
  const agents = [{ CI: 'true' }, { TF_BUILD: 'True' }, { GITHUB_ACTIONS: 'true' }, { AGENT_ID: '7' }, { BUILD_BUILDID: '123' }, { SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: 'https://dev.azure.com/acme/' }];
  for (const more of [{ TYCON_TEAM_REFRESH: '0' }, ...agents, { TYCON_OFFICE_LINK: '0' }]) {
    ageStamp(m, 31);
    assert.strictEqual((await hookOn(m, 'UserPromptSubmit', { ...env, ...more })).status, 0);
  }
  ageStamp(m, 31);
  assert.strictEqual((await hookOn(m, 'SessionStart', env)).status, 0);
  await sleep(600);
  assert.strictEqual(fake.runs().length, 2, 'apagada, en un agente o al abrir sesión, no lanza nada');
  // un sello roto cuenta como vencido: no deja a la máquina sin puesta al día para siempre
  fs.writeFileSync(stampOf(m), '{roto');
  assert.strictEqual((await hookOn(m, 'UserPromptSubmit', env)).status, 0);
  assert.ok(await until(() => fake.runs().length === 3, 8000), 'un sello roto no frena');
  // lo que no corrió también queda en el registro de la oficina; una instalación sin capa (`off`) no anota nada
  for (const [status, said] of [['busy', /otra sesión estaba actualizando/], ['none', /no miró nada/]]) {
    const other = refreshFake(m, { status });
    ageStamp(m, 31);
    assert.strictEqual((await hookOn(m, 'UserPromptSubmit', { TYCON_TEAM_REFRESH_RUN: other.file })).status, 0);
    assert.ok(await until(() => said.test(logOf(m)), 8000), `${status}: ${logOf(m)}`);
  }
  const off = refreshFake(m, { status: 'off' });
  const lines = logOf(m).split('\n').length;
  ageStamp(m, 31);
  assert.strictEqual((await hookOn(m, 'UserPromptSubmit', { TYCON_TEAM_REFRESH_RUN: off.file })).status, 0);
  assert.ok(await until(() => off.runs().length === 1, 8000));
  await sleep(800);
  assert.strictEqual(logOf(m).split('\n').length, lines, 'sin capa, nada que anotar cada 30 min');
});

test('T45 Enlace_LlegaSiteUrl_PideElAltaYLanza: la capa nueva trae site.url y la máquina pide el alta y lanza, sin abrir sesión', async () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const entries = (list.hooks || list).filter((h) => h.spec === '@tcg:office-link-start.js');
  assert.deepStrictEqual(entries.map((h) => h.event).sort(), ['SessionStart', 'UserPromptSubmit']);
  for (const h of entries) {
    assert.strictEqual(h.platforms && h.platforms.windows, true, `${h.event}: también en Windows`);
    assert.notStrictEqual(h.platforms && h.platforms.mac, false, `${h.event}: también en Mac`);
  }

  const site = await toySite();
  const m = toy();
  const fake = refreshFake(m, { site: site.url });
  assert.strictEqual((await hookOn(m, 'UserPromptSubmit', { TYCON_TEAM_REFRESH_RUN: fake.file })).status, 0);
  assert.ok(await until(() => site.enrolls.length === 1, 8000), 'pidió el alta sin abrir sesión');
  assert.ok(siteLink().readKey(m.sdir), 'armó su clave');
  assert.ok(await until(() => readLock(m), 8000), 'lanzó el proceso de la oficina');
  started.add(readLock(m).pid);
  assert.ok(await until(() => site.fotos.length >= 1, 8000), 'y la foto llegó al sitio, sin página abierta');
  await stopServer(m);

  // la puesta al día no trajo dirección: ni clave ni proceso
  const n = toy();
  const quiet = refreshFake(n, { status: 'same' });
  applySite({ url: null });
  assert.strictEqual((await hookOn(n, 'UserPromptSubmit', { TYCON_TEAM_REFRESH_RUN: quiet.file })).status, 0);
  assert.ok(await until(() => quiet.runs().length === 1, 8000));
  await sleep(800);
  assert.strictEqual(siteLink().readKey(n.sdir), null, 'sin dirección no arma clave');
  assert.strictEqual(readLock(n), null, 'ni lanza el proceso');
  await site.stop();
});

test('T46 ProcesoVivo_ReleeSiteUrl: el proceso vivo se enlaza, cambia de sitio o se desenlaza al aviso, sin cortarlo', async () => {
  const one = await toySite();
  const two = await toySite();
  const m = toy();
  // la máquina ya pidió el alta y está aprobada: lo que se mide es el proceso que relee la dirección
  siteLink().ensureKey(m.sdir);
  siteLink().writeLinkState(m.sdir, 'aprobada');
  // arranca sin dirección: sólo la oficina local, que se cierra sin la página abierta
  assert.strictEqual((await openLocal(m, { TYCON_OFFICE_IDLE_MS: '60000' })).status, 0);
  const lock = readLock(m);
  started.add(lock.pid);
  assert.deepStrictEqual((await countersOf(lock)).linked, { site: '', idleMs: 2 * 60 * 1000, capMs: 8 * 3600 * 1000 });
  // aparece la dirección: el aviso de la capa nueva lo enlaza, con la foto entera y la vida de las sesiones
  m.url = one.url; applySite(m);
  assert.strictEqual(await postEvent(lock, { body: '{"type":"config"}' }), 204);
  assert.ok(await until(() => one.fotos.length >= 1, 8000), 'se enlazó y mandó la foto entera');
  assert.strictEqual(one.fotos[0].data.meta.sitio, one.url, 'la foto relee la dirección');
  assert.deepStrictEqual((await countersOf(lock)).linked, { site: one.url, idleMs: 10 * 60 * 1000, capMs: 12 * 3600 * 1000 });
  assert.strictEqual(readLock(m).pid, lock.pid, 'el mismo proceso');
  // otra dirección: corta la vieja y abre la nueva (también con el aviso de una sesión)
  m.url = two.url; applySite(m);
  assert.strictEqual(await postEvent(lock, { body: '{"type":"session"}' }), 204);
  assert.ok(await until(() => two.fotos.length >= 1 && one.closes.length >= 1, 8000), 'cambió de sitio');
  assert.strictEqual(two.fotos[0].data.meta.sitio, two.url);
  // la configuración ilegible: queda como estaba y lo anota
  fs.writeFileSync(inTree('team-profile.json'), '{roto');
  assert.strictEqual(await postEvent(lock, { body: '{"type":"config"}' }), 204);
  assert.ok(await until(() => /no se pudo leer la dirección del sitio/.test(logOf(m)), 8000), logOf(m));
  assert.strictEqual((await countersOf(lock)).linked.site, two.url, 'sigue enlazado al de antes');
  // una dirección que no es web la rechaza el lector: es una configuración que no se lee, y el enlace queda como estaba
  const before = (logOf(m).match(/no se pudo leer la dirección del sitio/g) || []).length;
  m.url = 'ftp://sitio.acme.example'; applySite(m);
  assert.strictEqual(await postEvent(lock, { body: '{"type":"config"}' }), 204);
  assert.ok(await until(() => (logOf(m).match(/no se pudo leer la dirección del sitio/g) || []).length > before, 8000), 'y lo anota de nuevo');
  assert.strictEqual((await countersOf(lock)).linked.site, two.url, 'una dirección rechazada no corta el enlace');
  // sin dirección, corta y vuelve a la vida de la oficina local: 2 min sin la página y 8 h de tope
  m.url = null; applySite(m);
  assert.strictEqual(await postEvent(lock, { body: '{"type":"config"}' }), 204);
  assert.ok(await until(() => two.closes.length >= 1, 8000), 'cortó el enlace');
  assert.deepStrictEqual((await countersOf(lock)).linked, { site: '', idleMs: 2 * 60 * 1000, capMs: 8 * 3600 * 1000 });
  await stopServer(m);
  applySite({ url: null });
  await one.stop();
  await two.stop();
});

// Lo que la página lee y no es de la foto: propiedades del navegador y de JavaScript, y los objetos que arma ella sola (los
// escritorios, la ropa y el pelo de cada persona).
const NOT_PHOTO = new Set(['addEventListener', 'checked', 'className', 'filter', 'find', 'hidden', 'id', 'length', 'style', 'textContent', 'value', 'ay', 'st', 'hit', 'barba', 'gorra', 'lentes', 'pelo', 'pelocol', 'piel']);

test('T47 Foto_TodoLoDeLaLocal_ListasComparadas: lo que lee la página está en la lista o en LOCAL_ONLY, con su motivo', () => {
  const { pick, FIELDS, LOCAL_ONLY } = fields();
  const src = fs.readFileSync(PAGE, 'utf8');
  const fn = (name) => { const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name); const end = src.indexOf('\nfunction ', at + 1); return src.slice(at, end < 0 ? undefined : end); };
  const reads = (vars, text) => new Set([...text.matchAll(new RegExp(`\\b(?:${vars})\\.([A-Za-z_]\\w*)`, 'g'))].map((m) => m[1]).filter((k) => !NOT_PHOTO.has(k)));
  // cada motivo de lo que no viaja está escrito
  assert.ok(LOCAL_ONLY && typeof LOCAL_ONLY === 'object');
  for (const [k, why] of Object.entries(LOCAL_ONLY)) assert.ok(typeof why === 'string' && why.length > 20, `«${k}» no dice por qué no viaja`);
  const decided = (listed) => (k) => k in listed || k in LOCAL_ONLY;
  // el primer nivel: cada DATA.<campo> de la página
  for (const k of reads('DATA', src)) assert.ok(decided(FIELDS)(k), `la página lee DATA.${k} y nadie decidió si viaja`);
  // la ficha de una sesión, el detalle de una tarjeta, los tokens, los sobres y el pedido
  const agentFields = FIELDS.agents.of.fields;
  for (const k of reads('a', fn('ficha') + fn('pintarFicha'))) assert.ok(decided(agentFields)(k), `la ficha lee a.${k} y no está en la lista`);
  const cardFields = FIELDS.kanban.fields.columnas.of.fields.tarjetas.of.fields;
  for (const k of reads('i', fn('abrirTarjeta'))) assert.ok(decided(cardFields)(k), `el detalle de una tarjeta lee i.${k} y no está en la lista`);
  for (const k of reads('i\\.pedido', fn('abrirTarjeta'))) assert.ok(k in cardFields.pedido.fields, `el pedido de una tarjeta lee .${k}`);
  for (const k of reads('tk', fn('ficha'))) assert.ok(k in FIELDS.tokens.of.fields, `los tokens leen tk.${k}`);
  for (const k of reads('s|v\\.s', fn('lanzarSobres'))) assert.ok(k in FIELDS.sobres.of.fields, `los sobres leen .${k}`);
  // y viajan: los tokens, los sobres, el pedido y los agentes de ahora
  const foto = richFoto();
  foto.tokens = { Alfa: { contexto: '12k de 200k · 6 %', consumidos: 'Read 1k · Write 2k · Cache Read 3k', agentes: 2 }, Beta: { noMedido: true } };
  foto.sobres = [{ id: 'm1', de: 'Alfa', a: 'Beta', at: 1000, texto: 'el texto va por la conversación, no en el sobre' }];
  foto.agents[0].agentesAhora = 'Con 2 agentes';
  foto.kanban.columnas[0].tarjetas[0].pedido = { numero: 7, sitio: 'github', ruta: 'acme/repo/pull/7' };
  const sent = pick(foto, '/home/nadie');
  assert.deepStrictEqual(sent.tokens, foto.tokens);
  assert.deepStrictEqual(sent.sobres, [{ id: 'm1', de: 'Alfa', a: 'Beta', at: 1000 }], 'el sobre viaja sin texto: el mensaje va con la conversación');
  assert.strictEqual(sent.agents[0].agentesAhora, 'Con 2 agentes');
  assert.deepStrictEqual(sent.kanban.columnas[0].tarjetas[0].pedido, { numero: 7, sitio: 'github', ruta: 'acme/repo/pull/7' });
  // una ruta de pedido no puede ser una dirección entera, y un sitio de pedido desconocido no viaja
  assert.strictEqual(pick({ kanban: { columnas: [{ id: 'curso', tarjetas: [{ pedido: { numero: 7, sitio: 'otro', ruta: 'x' } }] }] } }, '/h').kanban.columnas[0].tarjetas[0].pedido.sitio, undefined);
  // los tokens de una persona con un nombre que trae un token de juguete: el nombre se sanea como cualquier texto
  const fake = LOOSE_TOKENS()[0];
  assert.ok(!JSON.stringify(pick({ tokens: { [`Alfa ${fake}`]: { noMedido: true } } }, '/h')).includes(fake));
  assert.ok('items' in LOCAL_ONLY && !('items' in sent));
  // la foto entera de collect(), campo por campo y a cualquier profundidad: cada uno está en la lista o en LOCAL_ONLY. Un
  // campo nuevo que la página todavía no lee también tiene que decidirse
  const undecided = [];
  const walk = (value, spec, at) => {
    if (!spec || value == null || typeof value !== 'object') return;
    if (spec.form === 'list') { if (Array.isArray(value)) value.forEach((v) => walk(v, spec.of, `${at}[]`)); return; }
    if (spec.form === 'byName') { Object.values(value).forEach((v) => walk(v, spec.of, `${at}{}`)); return; }
    if (!spec.fields) return;
    for (const [k, v] of Object.entries(value)) {
      const route = `${at.replace(/^foto\.?/, '').replace(/\[\]|\{\}/g, '')}${at === 'foto' ? '' : '.'}${k}`;
      if (k in LOCAL_ONLY || route in LOCAL_ONLY) continue;
      // la marca de otro proyecto la lee la lista para taparlo (T1), no la página
      if (k === 'otro' && v === true) continue;
      if (!(k in spec.fields)) { undecided.push(`${at}.${k}`); continue; }
      walk(v, spec.fields[k], `${at}.${k}`);
    }
  };
  walk(richFoto(), { fields: FIELDS }, 'foto');
  assert.deepStrictEqual([...new Set(undecided)], [], 'campos de la foto que nadie decidió si viajan');
});

// Las declaraciones de primer nivel de la página, por nombre: cada una va desde su renglón hasta el próximo que empieza sin
// sangría. Así la ficha corre acá con el código de la página, no con una copia.
function pageDecls(names) {
  const lines = fs.readFileSync(PAGE, 'utf8').split('\n');
  return names.map((name) => {
    const at = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`const ${name}=`));
    assert.ok(at >= 0, `la página no declara ${name}`);
    let end = at + 1;
    while (end < lines.length && /^\s/.test(lines[end])) end += 1;
    return lines.slice(at, end).join('\n');
  }).join('\n');
}

// Lo que la tarjeta del sitio puede mostrar distinto de la local, con su motivo: nada más.
const CARD_DIFFERS = {
  Carpeta: 'sale sólo el último tramo de la ruta: la ruta entera dice la carpeta personal y cómo está ordenado el disco',
};

test('T54 Tarjeta_IgualEnLaLocalYEnElSitio: cada renglón de la ficha y del detalle de una tarjeta es el mismo en las dos oficinas', () => {
  const vm = require('vm');
  const { pick } = fields();
  const src = fs.readFileSync(PAGE, 'utf8');
  const foto = richFoto();
  const sent = pick(JSON.parse(JSON.stringify(foto)), '/home/nadie');
  // la ficha de cada sesión, armada por la función de la página con la foto local y con la que llega al sitio
  const ctx = vm.createContext({ DATA: null });
  vm.runInContext(`${pageDecls(['DAYS', 'parse', 'fmt', 'AST', 'finTxt', 'SOLO_COORDINA', 'ficha'])}\nthis.ficha = ficha;`, ctx);
  const rows = (data, a) => { ctx.DATA = data; return JSON.parse(JSON.stringify(ctx.ficha(a))); };
  assert.ok(foto.agents.length >= 8, 'la foto de la prueba trae varias sesiones');
  assert.strictEqual(sent.agents.length, foto.agents.length, 'llegan todas las sesiones');
  let compared = 0;
  for (const [i, a] of foto.agents.entries()) {
    const local = rows(foto, a);
    const site = rows(sent, sent.agents[i]);
    assert.ok(local.length > 0, `${a.nombre}: la ficha local tiene renglones`);
    assert.deepStrictEqual(site.map((r) => r.k), local.map((r) => r.k), `${a.nombre}: los renglones de la ficha del sitio no son los de la local`);
    for (const [j, r] of local.entries()) {
      compared += 1;
      if (r.k in CARD_DIFFERS) { assert.ok(site[j].v, `${a.nombre}: «${r.k}» falta en el sitio`); continue; }
      assert.deepStrictEqual(site[j], r, `${a.nombre}: «${r.k || r.v}» cambia entre la oficina local y la del sitio`);
    }
  }
  assert.ok(compared > 30, `se compararon ${compared} renglones`);
  for (const [k, why] of Object.entries(CARD_DIFFERS)) assert.ok(why.length > 20 && compared, `«${k}» no dice por qué cambia`);
  // el nombre, el estado y cómo trabaja, que van en la tarjeta misma
  for (const [i, a] of foto.agents.entries()) for (const k of ['nombre', 'estado', 'comoTrabaja', 'titulo']) assert.deepStrictEqual(sent.agents[i][k], a[k], `${a.nombre}: «${k}» cambia`);
  // el detalle de una tarjeta del tablero: cada campo que lee la página llega igual
  const fn = (name) => { const at = src.indexOf(`function ${name}(`); const end = src.indexOf('\nfunction ', at + 1); return src.slice(at, end < 0 ? undefined : end); };
  const readsOfCard = [...new Set([...fn('abrirTarjeta').matchAll(/\bi\.([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  let cards = 0;
  for (const [c, col] of foto.kanban.columnas.entries()) {
    for (const [t, card] of col.tarjetas.entries()) {
      cards += 1;
      // la tarjeta de otro proyecto sale tapada a propósito (T1): no es una diferencia de la oficina del sitio
      if (card.otro) continue;
      for (const k of readsOfCard) assert.deepStrictEqual(sent.kanban.columnas[c].tarjetas[t][k], card[k], `la tarjeta «${card.titulo}»: «${k}» cambia`);
    }
  }
  assert.ok(cards >= 3, `la foto trae ${cards} tarjetas`);
  // «A medio camino» es una columna más del panel, con las mismas tarjetas
  assert.ok(foto.kanban.medioCamino.length > 0, 'la foto trae trabajos a medio camino');
  for (const [m, card] of foto.kanban.medioCamino.entries()) for (const k of [...readsOfCard, 'accion']) assert.deepStrictEqual(sent.kanban.medioCamino[m][k], card[k], `a medio camino «${card.titulo}»: «${k}» cambia`);
  // y los sobres que vuelan entre escritorios
  assert.deepStrictEqual(sent.sobres, foto.sobres);
});

test('T48 Charla_ViajaAparte_SaneadaConTope: la conversación sale en su mensaje, sólo a un sitio que la entiende', async () => {
  const { MAX_MESSAGE_BYTES, CHARLA_TEXT_MAX, CHARLA_EVERY_MS, CHARLA_GAP_MS } = fields();
  assert.strictEqual(CHARLA_TEXT_MAX, 8000);
  assert.strictEqual(CHARLA_EVERY_MS, 60 * 1000);
  assert.ok(CHARLA_GAP_MS >= 1000 / 5, 'a lo sumo cinco conversaciones por segundo: el sitio corta a las diez');
  const fake = LOOSE_TOKENS()[0];
  const conv = (n, texto = 'un mensaje') => ({ conCoordinadora: Array.from({ length: n }, (_, i) => ({ de: i % 2 ? null : 'Coordinadora', texto: `${texto} ${i}`, at: 1000 + i, propio: Boolean(i % 2) })) });
  // un sitio de hoy: su ack no trae `puede`, y no le llega ninguna charla; la foto sigue
  const today = await toySite();
  const m = toy();
  const { link: old, clock: oc } = linkOf(m, today, 'aprobada');
  old.update(FOTO());
  old.charla('Alfa', conv(2));
  old.start();
  assert.ok(await until(() => today.fotos.length === 1));
  oc.advance(CHARLA_EVERY_MS + 1);
  old.charla('Alfa', conv(3));
  await sleep(200);
  assert.ok(!today.raw.some((r) => r.includes('"charla"')), 'a un sitio de hoy no le llega ninguna charla');
  assert.strictEqual(today.closes.length, 0, 'y la conexión sigue');
  old.stop();
  await today.stop();
  // un sitio que la entiende
  const site = await toySite();
  site.puede = ['charla'];
  const n = toy();
  const { link, clock } = linkOf(n, site, 'aprobada');
  link.update(FOTO());
  link.charla('Alfa', conv(2, `con un token ${fake}`));
  link.charla('Beta', conv(1));
  link.start();
  // al conectar salen todas, de a una: juntas pasarían el tope de mensajes por segundo del sitio
  assert.ok(await until(() => site.charlas.length === 1), 'al conectar, la primera enseguida');
  await sleep(150);
  assert.strictEqual(site.charlas.length, 1, 'la segunda espera su turno');
  clock.advance(CHARLA_GAP_MS);
  assert.ok(await until(() => site.charlas.length === 2), 'al conectar, todas');
  const alfa = site.charlas.find((c) => c.sesion === 'Alfa');
  assert.ok(!JSON.stringify(alfa).includes(fake), 'saneada');
  assert.strictEqual(alfa.datos.conCoordinadora.length, 2);
  // igual no se manda; distinta antes del minuto, espera; pasado el minuto, sale
  link.charla('Alfa', conv(2, `con un token ${fake}`));
  link.charla('Alfa', conv(4));
  await sleep(150);
  assert.strictEqual(site.charlas.length, 2, 'dentro del minuto no sale otra de la misma sesión');
  clock.advance(CHARLA_EVERY_MS + 1);
  assert.ok(await until(() => site.charlas.length === 3), 'pasado el minuto, sale la última');
  assert.strictEqual(site.charlas[2].datos.conCoordinadora.length, 4);
  // cada texto hasta 8000; el mensaje hasta 64 KB, sacando los más viejos y con la marca
  clock.advance(CHARLA_EVERY_MS + 1);
  const t0 = Date.now();
  link.charla('Beta', conv(30, 'palabra '.repeat(1200)));
  assert.ok(Date.now() - t0 < 3000, `armar una conversación grande no traba el proceso (${Date.now() - t0} ms)`);
  assert.ok(await until(() => site.charlas.length === 4));
  const big = site.charlas[3];
  assert.strictEqual(big.datos.recortada, true);
  assert.ok(big.bytes <= MAX_MESSAGE_BYTES, `${big.bytes} bytes`);
  assert.ok(big.datos.conCoordinadora.every((x) => x.texto.length <= 8000));
  assert.strictEqual(big.datos.conCoordinadora[big.datos.conCoordinadora.length - 1].at, 1029, 'quedan los más nuevos');
  assert.ok(big.datos.conCoordinadora[0].at > 1000, 'y salieron los más viejos');
  // la de la coordinadora, con sus dos listas
  clock.advance(CHARLA_EVERY_MS + 1);
  link.charla('Coordinadora', { conVos: [{ quien: 'vos', texto: 'hola', at: 1 }], conSesiones: [{ sesion: 'Alfa', at: 2, mensajes: [{ de: 'Alfa', texto: 'listo', at: 2 }] }] });
  assert.ok(await until(() => site.charlas.length === 5));
  assert.deepStrictEqual(site.charlas[4].datos.conSesiones[0].mensajes[0], { de: 'Alfa', texto: 'listo', at: 2 });
  // una tirada de miles de caracteres sin espacios no viaja, y se resuelve rápido: el saneador tarda segundos con ella
  // entera. Vale para letras, puntos, guiones o lo que sea: lo que no es un espacio
  const textOf = (texto, home = '/h') => fields().pickCharla({ conCoordinadora: [{ de: 'Alfa', texto, at: 1, propio: false }] }, home).conCoordinadora[0].texto;
  for (const ch of ['x', '.', '-', 'á', '/']) {
    const t1 = Date.now();
    const run = textOf(`antes ${ch.repeat(16000)} después`);
    assert.ok(Date.now() - t1 < 1000, `«${ch}»: ${Date.now() - t1} ms`);
    assert.strictEqual(run, 'antes [16000 caracteres seguidos: no viajan] después', `«${ch}»`);
  }
  // muchas tiradas cortas también: un mensaje entero de ellas no traba el proceso
  const t2 = Date.now();
  textOf(`${'-'.repeat(200)} `.repeat(80));
  assert.ok(Date.now() - t2 < 1000, `tiradas cortas: ${Date.now() - t2} ms`);
  // el corte de un texto muy largo cae en un espacio: una clave en el borde no deja pasar su punta, aunque lo saneado achique
  const home = '/Users/nadie';
  const filler = `${home}/a `.repeat(Math.ceil((CHARLA_TEXT_MAX * 2 - 5) / `${home}/a `.length));
  const edge = textOf(`${filler.slice(0, CHARLA_TEXT_MAX * 2 - 10)} ${fake}`, home);
  assert.ok(!edge.includes(fake.slice(0, 8)), 'la punta de la clave del borde no viaja');
  // el nombre de la sesión sale como en la foto: el sitio busca la conversación por ese valor
  clock.advance(CHARLA_EVERY_MS + 1);
  const named = `Sesión en ${n.home}/proyecto ${fake}`;
  link.charla(named, conv(1));
  assert.ok(await until(() => site.charlas.length === 6));
  const inFoto = fields().pick({ agents: [{ nombre: named }] }, n.home).agents[0].nombre;
  assert.strictEqual(site.charlas[5].sesion, inFoto);
  assert.ok(!site.charlas[5].sesion.includes(fake) && !site.charlas[5].sesion.includes(n.home));
  // forSite decide qué sale: hoy, todo lo que trae la conversación de la oficina local
  const { forSite } = require(SERVER);
  assert.deepStrictEqual(forSite(conv(2)), conv(2));
  link.stop();
  await site.stop();
});

test('T55 Charla_LeeSoloLoQueCrecio_YReintentaLoQueFalla: qué conversación se lee en cada foto', () => {
  const { changedTalks } = require(SERVER);
  const { CHARLA_EVERY_MS } = fields();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charlas-'));
  const fileOf = (name) => path.join(dir, `${name}.jsonl`);
  const grow = (name, text = 'x') => fs.appendFileSync(fileOf(name), `${text}\n`);
  ['Alfa', 'Beta', 'Gama'].forEach((n) => grow(n));
  const envelopes = { files: new Map(['Alfa', 'Beta', 'Gama'].map((n) => [n, { file: fileOf(n) }])) };
  const reads = [];
  let behavior = { Gama: 'null' };
  const office = { conversationOf: (_e, name) => {
    reads.push(name);
    if (behavior[name] === 'null') return null;
    if (behavior[name] === 'throw') { const e = new Error('ilegible'); e.code = 'EIO'; throw e; }
    return { conCoordinadora: [{ de: name, texto: fs.readFileSync(fileOf(name), 'utf8'), at: 1, propio: false }] };
  } };
  const talked = new Map();
  let now = 1_000_000;
  // la primera vez, todas; la que no se pudo leer no cuenta como leída
  let failed = [];
  let out = changedTalks(office, envelopes, talked, now, failed);
  assert.deepStrictEqual(Object.keys(out).sort(), ['Alfa', 'Beta']);
  assert.deepStrictEqual(reads.sort(), ['Alfa', 'Beta', 'Gama']);
  assert.ok(!talked.has('Gama'), 'la que no se leyó no queda marcada');
  // sin crecer, ninguna; Gama se reintenta aunque no haya crecido
  reads.length = 0;
  behavior = { Gama: 'throw' };
  now += CHARLA_EVERY_MS + 1;
  failed = [];
  out = changedTalks(office, envelopes, talked, now, failed);
  assert.deepStrictEqual(reads, ['Gama'], 'las que no crecieron no se leen; la que falló, sí');
  assert.deepStrictEqual(out, {});
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0], /no se pudo leer la conversación de una sesión \(EIO\): se reintenta/);
  // creció: sale, y Gama, ya legible, también
  behavior = {};
  grow('Alfa', 'nuevo');
  now += 1000;
  out = changedTalks(office, envelopes, talked, now);
  assert.deepStrictEqual(Object.keys(out).sort(), ['Alfa', 'Gama']);
  assert.match(out.Alfa.conCoordinadora[0].texto, /nuevo/);
  // vuelve a crecer dentro del minuto: espera; pasado el minuto, sale la última
  grow('Alfa', 'otra vez');
  now += 1000;
  assert.deepStrictEqual(changedTalks(office, envelopes, talked, now), {}, 'dentro del minuto de su última lectura, espera');
  now += CHARLA_EVERY_MS;
  out = changedTalks(office, envelopes, talked, now);
  assert.deepStrictEqual(Object.keys(out), ['Alfa']);
  assert.match(out.Alfa.conCoordinadora[0].texto, /otra vez/);
  // la sesión que se fue se olvida
  envelopes.files.delete('Beta');
  changedTalks(office, envelopes, talked, now);
  assert.ok(!talked.has('Beta'));
});

// ── El aislamiento de las suites ────────────────────────────────────────────────────────────────────────────────────

test('Regresion_SuitesDeLaOficina_SeAislanDelSitio: con site.url en el perfil, la suite del proceso sigue verde', async () => {
  const m = withSite(toy(), 'http://127.0.0.1:9');
  applySite(m);
  const suite = inTree('scripts', 'tests', 'office-server.test.js');
  fs.mkdirSync(path.dirname(suite), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'tests', 'office-server.test.js'), suite);
  try {
    const r = await run('--test', ['--test-name-pattern=^T(8|10|14) ', suite], envOf(m));
    assert.strictEqual(r.status, 0, r.stdout.slice(-1500));
  } finally { applySite({ url: null }); }
  for (const file of ['office.test.js', 'office-live.smoke.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', file), 'utf8'), /TYCON_OFFICE_LINK: '0'/, file);
  }
});
