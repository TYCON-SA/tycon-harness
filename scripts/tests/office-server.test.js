'use strict';
// office-server.test.js — the live office: the local process that watches the harness folders and pushes each change to
// the page over WebSocket. Every test runs with a toy HOME and kills the processes it starts.
// stable-data: every date comes from the process clock; the waits are bounded and short.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OFFICE = path.join(ROOT, 'scripts', 'tools', 'office.js');
const SERVER = path.join(ROOT, 'scripts', 'tools', 'office', 'server.js');
const VENDOR_WS = path.join(ROOT, 'scripts', 'tools', 'office', 'vendor', 'ws');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const WIN = process.platform === 'win32';
// Cuánto se espera algo del servidor (una foto, un cambio que llega): con la máquina cargada, 2 s no alcanzan y la
// prueba caía sin que nada estuviera roto. TYCON_OFFICE_TEST_WAIT_MS lo cambia; un valor que no sirve, el de por defecto.
function plazoDeEspera(env = process.env) {
  const n = Number(env.TYCON_OFFICE_TEST_WAIT_MS);
  return env.TYCON_OFFICE_TEST_WAIT_MS && Number.isFinite(n) && n > 0 ? n : 8000;
}
const PLAZO = plazoDeEspera();

const started = new Set();
test.after(() => { for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya salió */ } } });

// A toy machine: the state folders the office watches and one live session. These tests measure the office without the
// organization site: the team's profile, laid over the tree in the validation runs, does bring a site.url.
function toy({ withAdhoc = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-live-'));
  const sdir = stateDir(home);
  for (const d of ['active', ...(withAdhoc ? ['adhoc'] : []), 'doing']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', status: 'busy', statusUpdatedAt: Date.now() }));
  return { home, sdir, sessions };
}

const envOf = (home, more = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_TEST: '1', TYCON_OFFICE_LINK: '0', ...more });
const lockOf = (m) => path.join(m.sdir, 'office', 'server.json');
const readLock = (m) => { try { return JSON.parse(fs.readFileSync(lockOf(m), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openSync(m, more) {
  const r = spawnSync('node', [OFFICE, '--open'], { input: '', env: envOf(m.home, more), encoding: 'utf8', timeout: 20000 });
  const lock = readLock(m);
  if (lock && lock.pid) started.add(lock.pid);
  return r;
}
function openAsync(m, more) {
  return new Promise((resolve) => {
    const c = spawn('node', [OFFICE, '--open'], { env: envOf(m.home, more), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => { const lock = readLock(m); if (lock && lock.pid) started.add(lock.pid); resolve({ status, stdout: out, stderr: err }); });
  });
}
const urlOf = (stdout) => (stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/) || []);

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.end();
  });
}
const counters = async (lock) => JSON.parse((await get(lock.port, `/debug/counters?t=${lock.token}`)).body);

// A page: the WebSocket client from the copied library, with the headers a browser would send.
function page(lock, { token = lock.token, origin = `http://127.0.0.1:${lock.port}`, host = `127.0.0.1:${lock.port}` } = {}) {
  const WebSocket = require(VENDOR_WS);
  const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/live${token == null ? '' : `?t=${token}`}`, { origin: origin || undefined, headers: { host } });
  const fotos = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    fotos.push(msg);
    while (waiters.length) waiters.shift()(msg);
  });
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.rejected = new Promise((resolve) => ws.on('unexpected-response', (req, res) => resolve(res.statusCode)));
  ws.on('error', () => { /* lo dicen closed y rejected */ });
  ws.fotos = fotos;
  ws.next = (ms = 3000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no llegó una foto en ${ms} ms`)), ms);
    waiters.push((msg) => { clearTimeout(t); resolve(msg); });
  });
  ws.opened = new Promise((resolve) => ws.on('open', resolve));
  return ws;
}

function marker(m, sid, storyId, title) {
  const story = path.join(m.home, `story-${storyId}.md`);
  fs.writeFileSync(story, `---\nstory: "${storyId}"\ntitle: "${title}"\n---\n# Story\n`);
  fs.writeFileSync(path.join(m.sdir, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, storyId, storyPath: story, stepsCompleted: ['start'], stepsPending: ['validate-story'] }));
}

async function exited(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}

test('T1 Server_StartsOnLoopback_WritesLock: arranca aparte, sólo en 127.0.0.1, con candado privado', async () => {
  const m = toy();
  const r = openSync(m);
  assert.strictEqual(r.status, 0, r.stderr);
  const [, port, token] = urlOf(r.stdout);
  assert.ok(port && token, r.stdout);
  const lock = readLock(m);
  assert.deepStrictEqual([lock.port, lock.token], [Number(port), token]);
  assert.ok(Number.isInteger(lock.pid) && alive(lock.pid) && lock.pid !== process.pid);
  assert.ok(Date.parse(lock.startedAt) > 0);
  if (!WIN) {
    assert.strictEqual(fs.statSync(lockOf(m)).mode & 0o777, 0o600, 'el candado con el token, sólo para su dueño');
    assert.strictEqual(fs.statSync(path.dirname(lockOf(m))).mode & 0o777, 0o700, 'y su carpeta');
  }
  const health = JSON.parse((await get(lock.port, `/health?t=${lock.token}`)).body);
  assert.strictEqual(health.address, '127.0.0.1');
  const home = await get(lock.port, `/?t=${lock.token}`);
  assert.strictEqual(home.status, 200);
  assert.match(home.type, /text\/html/);
});

test('T2 Server_SecondOpen_ReusesTheLiveOne: la segunda apertura usa el que está', async () => {
  const m = toy();
  const first = openSync(m);
  const lock = readLock(m);
  const second = openSync(m);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /ya estaba abierta/);
  assert.strictEqual(urlOf(second.stdout)[0], urlOf(first.stdout)[0]);
  assert.strictEqual(readLock(m).pid, lock.pid);
  assert.ok(alive(lock.pid));
});

test('T3 Server_StaleLock_IsReplaced: un candado de un proceso muerto, o que no contesta, se reemplaza', async () => {
  const m = toy();
  fs.mkdirSync(path.dirname(lockOf(m)), { recursive: true, mode: 0o700 });
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(lockOf(m), JSON.stringify({ pid: Number(dead.stdout), port: 9, token: 'viejo', startedAt: new Date().toISOString() }));
  assert.strictEqual(openSync(m).status, 0);
  const fresh = readLock(m);
  assert.notStrictEqual(fresh.token, 'viejo');
  assert.ok(alive(fresh.pid));
  // un pid vivo cuyo puerto no contesta: tampoco sirve
  process.kill(fresh.pid, 'SIGKILL');
  await exited(fresh.pid, 3000);
  fs.writeFileSync(lockOf(m), JSON.stringify({ pid: process.pid, port: 9, token: 'mudo', startedAt: new Date().toISOString() }));
  assert.strictEqual(openSync(m).status, 0);
  const third = readLock(m);
  assert.notStrictEqual(third.token, 'mudo');
  assert.ok(alive(third.pid));
});

test('T4 Server_TwoAtOnce_OnlyOneSurvives: dos aperturas a la vez dan un solo proceso', async () => {
  const m = toy();
  const [a, b] = await Promise.all([openAsync(m), openAsync(m)]);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(b.status, 0, b.stderr);
  assert.strictEqual(urlOf(a.stdout)[0], urlOf(b.stdout)[0]);
  await sleep(300);
  const starts = fs.readFileSync(path.join(m.sdir, 'office', 'starts.log'), 'utf8').trim().split('\n');
  assert.strictEqual(starts.length, 1, 'arrancó un solo proceso');
});

test('T5 Events_FirstSnapshot_ReadOnce: cada página recibe la foto; los archivos se leyeron una vez', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const [p1, p2] = [page(lock), page(lock)];
  const [f1, f2] = await Promise.all([p1.next(), p2.next()]);
  assert.strictEqual(f1.type, 'foto');
  assert.deepStrictEqual(f1.data.agents.map((x) => x.nombre), ['Alfa']);
  assert.deepStrictEqual(f2.data, f1.data);
  assert.strictEqual((await counters(lock)).reads, 1);
  p1.close(); p2.close();
});

test('T6 Events_FileChange_PushesWithinTwoSeconds: un marcador nuevo llega en menos de 2 s', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  const t0 = Date.now();
  marker(m, 's1', '7.1', 'La oficina viva');
  const foto = await p.next(PLAZO);
  assert.ok(Date.now() - t0 < PLAZO);
  assert.strictEqual(foto.data.rows.length, 1);
  p.close();
});

test('T96 Live_StatusChange_PushesPhoto @story-2.81 @ac-51: una sesión que se para y una marca nueva llegan solas a la página', async () => {
  const m = toy();
  marker(m, 's1', '7.1', 'La oficina viva');
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  const inicial = await p.next();
  assert.strictEqual(inicial.data.agents.find((a) => a.nombre === 'Alfa').estado, 'trabajando');
  const until = (pred, ms = PLAZO) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const look = () => {
      const f = p.fotos.find(pred);
      if (f) { resolve(Date.now() - t0); return; }
      if (Date.now() - t0 > ms) { reject(new Error(`no llegó en ${ms} ms`)); return; }
      setTimeout(look, 25);
    };
    look();
  });
  const at = Date.now();
  fs.writeFileSync(path.join(m.sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', status: 'idle', statusUpdatedAt: at }));
  await until((f) => f.data.agents.find((a) => a.nombre === 'Alfa').estado === 'parada');
  const parada = p.fotos.find((f) => f.data.agents.find((a) => a.nombre === 'Alfa').estado === 'parada');
  assert.ok(parada.data.kanban.columnas.find((c) => c.id === 'curso').tarjetas.some((t) => t.quien === 'Alfa'), 'va a «En curso»');
  // la marca: una carpeta que todavía no existe se espera desde la de arriba
  fs.mkdirSync(path.join(m.sdir, 'parked'), { recursive: true });
  await sleep(100);
  fs.writeFileSync(path.join(m.sdir, 'parked', 's1.json'), JSON.stringify({ story: '7.1', kind: 'queue', until: null, at: new Date().toISOString(), by: 'x' }));
  await until((f) => f.data.agents.find((a) => a.nombre === 'Alfa').marca === 'En fila para pruebas');
  p.close();
});

test('T7 Events_BurstOfChanges_OneSnapshot: cinco cambios juntos dan una foto; uno igual no manda nada', async () => {
  // la foto lleva la hora en minutos: si el minuto cambia en medio, la foto nueva es legítima.
  // La prueba arranca lejos del cambio de minuto (dura unos 4 s, aun con la máquina cargada).
  const enElMinuto = Date.now() % 60000;
  if (enElMinuto > 45000) await sleep(60000 - enElMinuto + 300);
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  const coordination = path.join(m.sdir, 'coordination');
  fs.mkdirSync(coordination, { recursive: true });
  const board = path.join(coordination, 'tablero.json');
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(board, JSON.stringify({ pendientes: [{ titulo: `fila ${i}`, estado: 'espera' }] }));
  await p.next(PLAZO);
  await sleep(800);
  assert.strictEqual(p.fotos.length, 2, 'una sola foto por la ráfaga');
  fs.writeFileSync(board, fs.readFileSync(board));
  await sleep(900);
  assert.strictEqual(p.fotos.length, 2, 'la foto igual no se manda');
  p.close();
});

test('T8 Server_Idle_ReadsNothing: sin cambios no se lee nada ni se corre nada', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  // en macOS el aviso de un archivo escrito antes de vigilar (el de la sesión, de toy()) puede llegar tarde: se mide
  // desde que los contadores quedan quietos un segundo
  let before = await counters(lock);
  for (let still = 0, i = 0; still < 5 && i < 25; i += 1) {
    await sleep(200);
    const now = await counters(lock);
    still = now.reads === before.reads && now.queries === before.queries ? still + 1 : 0;
    before = now;
  }
  await sleep(2500);
  const after = await counters(lock);
  assert.deepStrictEqual([after.reads, after.queries], [before.reads, before.queries]);
  assert.strictEqual(after.intervals, 0, 'ningún reloj que consulte');
  p.close();
});

test('T8b PrPhoto_RenewedOnlyWhileSomeoneLooks: la lectura de pedidos se renueva con una página abierta, y sólo si nadie lo hizo antes', async () => {
  const fake = (m) => {
    const script = path.join(m.sdir, 'fake-refresh.js');
    const photo = path.join(m.sdir, 'stuck-prs-photo.json');
    const own = path.join(m.sdir, 'own-prs.json');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(`${script}.log`)}, 'x\\n');
require('fs').writeFileSync(${JSON.stringify(photo)}, JSON.stringify({ at: new Date().toISOString(), lecturas: { 'org/pub': { ok: true, value: [{ number: 909, title: 'arreglo', inQueue: true }] } } }));
require('fs').writeFileSync(${JSON.stringify(own)}, JSON.stringify({ at: new Date().toISOString(), lecturas: { 'org/pub': { ok: true, value: [{ number: 909, title: 'arreglo', inQueue: true }] } } }));`);
    return { script, runs: () => { try { return fs.readFileSync(`${script}.log`, 'utf8').trim().split('\n').length; } catch { return 0; } }, photo };
  };
  // sin lectura: la primera página la pide, la foto trae el pedido y sigue cada tanto
  const m = toy();
  const f = fake(m);
  openSync(m, { TYCON_OFFICE_PR_REFRESH: f.script, TYCON_OFFICE_PR_PHOTO_MS: '500' });
  const lock = readLock(m);
  await sleep(700);
  assert.strictEqual(f.runs(), 0, 'sin páginas no se lee nada');
  const p = page(lock);
  await p.next();
  let shown = null;
  for (let i = 0; i < 40 && !shown; i += 1) {
    await sleep(100);
    const last = p.fotos[p.fotos.length - 1];
    const c = last.data && last.data.kanban ? last.data.kanban.columnas.find((x) => x.id === 'entrando') : null;
    if (c && c.tarjetas.length) shown = c.tarjetas[0];
  }
  assert.ok(shown, 'la foto nueva llega sola a la página');
  assert.strictEqual(shown.quien, 'pedido #909');
  await sleep(1300);
  const during = f.runs();
  assert.ok(during >= 2, `se renueva mientras está abierta (${during})`);
  assert.ok(during <= 5, `sin apurarse (${during})`);
  p.close();
  await sleep(300);
  const closed = f.runs();
  await sleep(1000);
  assert.strictEqual(f.runs(), closed, 'sin páginas deja de leer');
  // una lectura reciente de otra sesión no se repite
  const n = toy();
  const g = fake(n);
  fs.writeFileSync(g.photo, JSON.stringify({ at: new Date().toISOString(), lecturas: {} }));
  openSync(n, { TYCON_OFFICE_PR_REFRESH: g.script, TYCON_OFFICE_PR_PHOTO_MS: '60000' });
  const q = page(readLock(n));
  await q.next();
  await sleep(500);
  assert.strictEqual(g.runs(), 0);
  q.close();
});

// Un clasificador de juguete que anota cada vez que corre. Es lento a propósito: la foto no lo espera.
const fakeClassifier = (m) => {
  const script = path.join(m.home, 'topics-falso.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(`${script}.log`)}, process.argv[2] + '\\n');\nsetTimeout(() => {}, 300);\n`);
  return { script, runs: () => { try { return fs.readFileSync(`${script}.log`, 'utf8').trim().split('\n'); } catch { return []; } } };
};
// un trabajo en un repo que el arnés sigue: de lo que no se sabe de qué proyecto es no se clasifica nada
const withWork = (m) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'office-repo-'));
  spawnSync('git', ['-c', 'maintenance.auto=false', '-C', repo, 'init', '-q']);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git']);
  fs.writeFileSync(path.join(m.sdir, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date().toISOString(), lecturas: { 'acme/repo': { ok: true, value: [] } } }));
  fs.writeFileSync(path.join(m.sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'Un trabajo por clasificar', declaredAt: new Date().toISOString(), cwd: repo }));
  fs.writeFileSync(path.join(m.sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', status: 'busy', statusUpdatedAt: Date.now(), cwd: repo }));
};

test('T29 Server_ClassifiesOnlyWithAPage @story-8.184 @ac-11: sin páginas no lanza; con una, lanza de fondo; respeta el plazo', async () => {
  const m = toy();
  withWork(m);
  const f = fakeClassifier(m);
  openSync(m, { TYCON_OFFICE_TOPICS_RUN: f.script, TYCON_OFFICE_TOPICS_MS: '300' });
  await sleep(900);
  assert.deepStrictEqual(f.runs(), [], 'sin páginas no clasifica');
  const p = page(readLock(m));
  await p.next();
  for (let i = 0; i < 50 && !f.runs().length; i += 1) await sleep(100);
  assert.strictEqual(f.runs()[0], '--classify', 'con una página, lanza');
  const pending = JSON.parse(fs.readFileSync(path.join(m.sdir, 'office', 'topics-pending.json'), 'utf8'));
  assert.deepStrictEqual(pending.trabajos.map((w) => w.titulo), ['Un trabajo por clasificar']);
  assert.deepStrictEqual(Object.keys(pending.trabajos[0]).sort(), ['clave', 'titulo'], 'sólo la clave y el título');
  p.close();
  await sleep(500);
  const closed = f.runs().length;
  await sleep(800);
  assert.strictEqual(f.runs().length, closed, 'sin páginas deja de lanzar');
  // con la hora del próximo intento por delante, no lanza; y sin nada por clasificar, tampoco
  const n = toy();
  withWork(n);
  const g = fakeClassifier(n);
  fs.mkdirSync(path.join(n.sdir, 'office'), { recursive: true });
  fs.writeFileSync(path.join(n.sdir, 'office', 'topics-state.json'), JSON.stringify({ version: 1, nextAt: Date.now() + 3600000 }));
  openSync(n, { TYCON_OFFICE_TOPICS_RUN: g.script, TYCON_OFFICE_TOPICS_MS: '200' });
  const q = page(readLock(n));
  await q.next();
  await sleep(800);
  assert.deepStrictEqual(g.runs(), [], 'espera su plazo');
  q.close();
  const o = toy();
  const h = fakeClassifier(o);
  openSync(o, { TYCON_OFFICE_TOPICS_RUN: h.script, TYCON_OFFICE_TOPICS_MS: '200' });
  const r = page(readLock(o));
  await r.next();
  await sleep(800);
  assert.deepStrictEqual(h.runs(), [], 'sin títulos no hay proceso ni llamada');
  r.close();
});

test('Regresion_ElClasificadorSeCae_SeDiceYNoSeRepite @story-8.184 @ac-21: si el proceso se cae antes de dejar su plazo, no se relanza cada minuto y la página lo dice', async () => {
  const m = toy();
  withWork(m);
  const script = path.join(m.home, 'topics-roto.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(`${script}.log`)}, 'x\\n');\nprocess.exit(1);\n`);
  openSync(m, { TYCON_OFFICE_TOPICS_RUN: script, TYCON_OFFICE_TOPICS_MS: '200' });
  const p = page(readLock(m));
  await p.next();
  assert.ok(await until(() => p.fotos.some((f) => f.data.unreadable.some((u) => /los temas no se pudieron clasificar/.test(u))), 6000), 'llega la foto con el aviso');
  await sleep(800);
  assert.strictEqual(fs.readFileSync(`${script}.log`, 'utf8').trim().split('\n').length, 1, 'no se relanza enseguida');
  p.close();
});

test('T30 Snapshot_NeverWaitsOrLaunches @story-8.184 @ac-11: la foto fija y --json no lanzan ni dejan pendientes', () => {
  const m = toy();
  withWork(m);
  const f = fakeClassifier(m);
  const env = envOf(m.home, { TYCON_OFFICE_TOPICS_RUN: f.script });
  for (const args of [['--json'], ['--out', path.join(m.home, 'foto.html')]]) {
    const r = spawnSync('node', [OFFICE, ...args], { input: '', env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  assert.deepStrictEqual(f.runs(), []);
  assert.ok(!fs.existsSync(path.join(m.sdir, 'office', 'topics-pending.json')));
});

test('Regresion_LecturaDeProyectosQueSeCae_LoDice @story-8.185 @ac-15: si la lectura de fondo sale con error, la oficina lo dice una vez', async () => {
  const m = toy();
  const script = path.join(m.home, 'proyectos-que-falla.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(`${script}.log`)}, 'x\\n');\nprocess.exit(3);\n`);
  openSync(m, { TYCON_OFFICE_PROJECTS_READ: script, TYCON_OFFICE_PROJECTS_MS: '60000' });
  const p = page(readLock(m));
  await p.next();
  assert.ok(await until(() => p.fotos.some((f) => f.data && (f.data.unreadable || []).some((u) => /las historias de tus proyectos no se pudieron leer: .*3/.test(u))), PLAZO), 'llega la foto con el aviso y el código de salida');
  p.close();
});

test('T21 Server_ReadsOnlyWithAPage_Every30 @story-8.185 @ac-19: las historias de tus proyectos se leen sólo con una página, cada tanto; la foto fija y --json no las lanzan', async () => {
  // un lector de juguete: anota cada vez que corre y deja una lectura con una historia lista
  const fakeReader = (m) => {
    const script = path.join(m.home, 'proyectos-falso.js');
    const out = path.join(m.sdir, 'office', 'project-stories.json');
    fs.writeFileSync(script, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(`${script}.log`)}, process.argv[2] + '\\n');
fs.mkdirSync(${JSON.stringify(path.dirname(out))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ at: new Date().toISOString(), proyectos: [{ nombre: 'Acme', traidoAt: null, deTuCopia: true, sinLeer: 0, historias: [{ id: '9.9', archivo: 'story-9.9-x.md', titulo: 'La que espera', estado: 'ready-for-dev' }] }], sinHistorias: [] }));`);
    return { script, out, runs: () => { try { return fs.readFileSync(`${script}.log`, 'utf8').trim().split('\n'); } catch { return []; } } };
  };
  const m = toy();
  const f = fakeReader(m);
  openSync(m, { TYCON_OFFICE_PROJECTS_READ: f.script, TYCON_OFFICE_PROJECTS_MS: '600' });
  const lock = readLock(m);
  await sleep(900);
  assert.deepStrictEqual(f.runs(), [], 'sin páginas no se lee nada');
  const p = page(lock);
  await p.next();
  const tarjeta = () => {
    const last = p.fotos[p.fotos.length - 1];
    const c = last && last.data && last.data.kanban ? last.data.kanban.columnas.find((x) => x.id === 'sinEmpezar') : null;
    return c ? c.tarjetas.find((t) => t.local === true) : null;
  };
  assert.ok(await until(() => tarjeta(), PLAZO), 'la lectura corre de fondo y la foto nueva trae la historia');
  assert.strictEqual(tarjeta().titulo, '9.9 · La que espera');
  assert.deepStrictEqual(f.runs()[0], '--refresh');
  await sleep(1500);
  const during = f.runs().length;
  assert.ok(during >= 2 && during <= 5, `se renueva mientras está abierta, sin apurarse (${during})`);
  p.close();
  await sleep(300);
  const closed = f.runs().length;
  await sleep(1000);
  assert.strictEqual(f.runs().length, closed, 'sin páginas deja de leer');
  // una lectura de hace menos de media hora no se repite
  const n = toy();
  const g = fakeReader(n);
  fs.mkdirSync(path.dirname(g.out), { recursive: true });
  fs.writeFileSync(g.out, JSON.stringify({ at: new Date().toISOString(), proyectos: [], sinHistorias: [] }));
  openSync(n, { TYCON_OFFICE_PROJECTS_READ: g.script });
  const q = page(readLock(n));
  await q.next();
  await sleep(600);
  assert.deepStrictEqual(g.runs(), [], 'con la lectura fresca no corre');
  q.close();
  // la foto fija y --json leen lo que hay y no lanzan nada
  const o = toy();
  const h = fakeReader(o);
  for (const args of [['--json'], ['--out', path.join(o.home, 'foto.html')]]) {
    const r = spawnSync('node', [OFFICE, ...args], { input: '', env: envOf(o.home, { TYCON_OFFICE_PROJECTS_READ: h.script }), encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  assert.deepStrictEqual(h.runs(), []);
  assert.ok(!fs.existsSync(h.out) && !fs.existsSync(path.join(o.sdir, 'office', 'project-stories.lock')));
});

test('T9 Remote_QueriedAtMostOncePerMinute: los pedidos se preguntan una vez por minuto', async () => {
  const { cachedQuery } = require(SERVER);
  let calls = 0;
  let now = 1_000_000;
  const q = cachedQuery(async (wanted) => { calls += 1; return wanted.map(() => ({ ok: true })); }, { ttlMs: 60000, clock: () => now });
  for (let i = 0; i < 10; i += 1) { await q([{ root: '/r' }]); now += 3000; }
  assert.strictEqual(calls, 1);
  assert.strictEqual(q.readAt(), 1_000_000);
  now += 40000;
  await q([{ root: '/r' }]);
  assert.strictEqual(calls, 2, 'pasado el minuto se vuelve a preguntar');
});

test('T10 Shutdown_NoPageForTwoMinutes_Exits: sin páginas sale solo, aunque ninguna se haya abierto', async () => {
  const m = toy();
  openSync(m, { TYCON_OFFICE_IDLE_MS: '600' });
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  p.close();
  assert.ok(await exited(lock.pid, 4000), 'salió');
  assert.strictEqual(readLock(m), null, 'borró su candado');
  // uno al que nunca se conecta nadie
  const n = toy();
  openSync(n, { TYCON_OFFICE_IDLE_MS: '600' });
  const lone = readLock(n);
  assert.ok(await exited(lone.pid, 4000), 'el que nunca tuvo página también sale');
  assert.strictEqual(readLock(n), null);
});

test('T11 Shutdown_ReloadDoesNotKill: recargar la página no lo apaga', async () => {
  const m = toy();
  openSync(m, { TYCON_OFFICE_IDLE_MS: '1500' });
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  p.close();
  await sleep(300);
  const q = page(lock);
  await q.next();
  await sleep(2000);
  assert.ok(alive(lock.pid), 'sigue');
  q.close();
});

test('T12 Shutdown_EightHourCap_AndSignals: el tope y las señales lo cierran; un candado ajeno queda', async () => {
  const m = toy();
  openSync(m, { TYCON_OFFICE_MAX_MS: '900' });
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  assert.strictEqual(typeof await Promise.race([p.closed, sleep(4000).then(() => 'no')]), 'number', 'la página ve el cierre');
  assert.ok(await exited(lock.pid, 4000));
  assert.strictEqual(readLock(m), null);
  // SIGTERM
  const n = toy();
  openSync(n);
  const l2 = readLock(n);
  process.kill(l2.pid, 'SIGTERM');
  assert.ok(await exited(l2.pid, 4000));
  assert.strictEqual(readLock(n), null);
  // un candado que dice otro pid no se borra
  const o = toy();
  openSync(o);
  const l3 = readLock(o);
  fs.writeFileSync(lockOf(o), JSON.stringify({ ...l3, pid: process.pid }));
  process.kill(l3.pid, 'SIGTERM');
  assert.ok(await exited(l3.pid, 4000));
  assert.strictEqual(readLock(o).pid, process.pid);
});

test('T12b Shutdown_PageArrivingMidShutdown_Gets1001: una página que termina de conectarse durante el apagado recibe el cierre', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const net = require('net');
  const sock = net.connect(lock.port, '127.0.0.1');
  const got = [];
  sock.on('data', (d) => got.push(d));
  sock.on('error', () => { /* lo dice lo que llegó */ });
  const ended = new Promise((resolve) => sock.on('close', resolve));
  await new Promise((resolve) => sock.on('connect', resolve));
  sock.write(`GET /live?t=${lock.token} HTTP/1.1\r\nHost: 127.0.0.1:${lock.port}\r\nOrigin: http://127.0.0.1:${lock.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`);
  await sleep(200);
  process.kill(lock.pid, 'SIGTERM');
  await sleep(30);
  sock.write('\r\n');
  await Promise.race([ended, sleep(4000)]);
  sock.destroy();
  const buf = Buffer.concat(got);
  // rechazada sin aceptarla también está bien; aceptada, el cierre llega con su código (0x88, largo, 1001), no con el
  // socket cortado
  if (!/^HTTP\/1\.1 101/.test(buf.toString('latin1'))) return;
  const closes = [...buf.keys()].some((i) => buf[i] === 0x88 && buf[i + 2] === 0x03 && buf[i + 3] === 0xe9);
  assert.ok(closes, 'la conexión aceptada durante el apagado se cierra con 1001');
});

test('T12c Shutdown_PhotoThreadBusy_ClosesAndExits: con una foto a medio armar, el apagado cierra la página y el proceso sale', async () => {
  const m = toy();
  const flag = path.join(m.home, 'foto-lenta');
  const preload = path.join(m.home, 'foto-lenta.js');
  // la foto que tarda bajo carga: el hilo queda en un proceso hijo síncrono, como cuando lee la configuración
  fs.writeFileSync(preload, `const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.officePhoto) wt.parentPort.on('message', () => {
  if (!require('fs').existsSync(${JSON.stringify(flag)})) return;
  require('fs').writeFileSync(${JSON.stringify(`${flag}.on`)}, '');
  require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, ${PLAZO * 3})']);
});\n`);
  openSync(m, { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim() });
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  fs.writeFileSync(flag, '');
  marker(m, 's1', '7.1', 'La oficina viva');
  for (let i = 0; i < 60 && !fs.existsSync(`${flag}.on`); i += 1) await sleep(50);
  assert.ok(fs.existsSync(`${flag}.on`), 'la foto lenta arrancó');
  process.kill(lock.pid, 'SIGTERM');
  // la foto lenta dura el triple del plazo: cerrar dentro del plazo es no haberla esperado
  assert.strictEqual(typeof await Promise.race([p.closed, sleep(PLAZO).then(() => 'no')]), 'number', 'la página ve el cierre sin esperar a la foto');
  assert.ok(await exited(lock.pid, PLAZO), 'sale sin esperar a la foto');
  assert.strictEqual(readLock(m), null);
});

test('T13 Security_BadHostOrToken_403: Host, token u Origin ajenos dan 403 sin datos', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  for (const pathname of ['/', '/live', '/modules/three', '/health']) {
    for (const [q, headers] of [[`?t=${lock.token}`, { host: 'evil.example' }], ['', {}], ['?t=errado', {}]]) {
      const r = await get(lock.port, pathname + q, headers);
      assert.strictEqual(r.status, 403, `${pathname}${q} ${JSON.stringify(headers)}`);
      assert.ok(!r.body.includes('agents'), 'sin datos');
    }
  }
  for (const opts of [{ origin: 'http://evil.example' }, { origin: null }, { host: 'evil.example' }, { token: null }]) {
    const p = page(lock, opts);
    assert.strictEqual(await Promise.race([p.rejected, sleep(3000).then(() => 'abrió')]), 403, JSON.stringify(opts));
  }
});

test('T14 Watch_MissingFolder_AndWatchError: una carpeta que aparece después se vigila; un error se dice', async () => {
  const m = toy({ withAdhoc: false });
  openSync(m, { TYCON_OFFICE_WATCH_FAIL: 'doing' });
  const lock = readLock(m);
  const p = page(lock);
  const first = await p.next();
  assert.ok(first.data.unreadable.some((u) => /no se vigila .*doing/.test(u)), first.data.unreadable.join(' | '));
  fs.mkdirSync(path.join(m.sdir, 'adhoc'));
  fs.writeFileSync(path.join(m.sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'arreglo de la oficina', declaredAt: new Date().toISOString() }));
  const foto = await p.next(3000);
  assert.ok(foto.data.agents.some((a) => /arreglo de la oficina/.test(a.titulo || '')), JSON.stringify(foto.data.agents));
  assert.strictEqual((await counters(lock)).intervals, 0, 'sin consultas periódicas');
  p.close();
});

test('T15 Open_PortOrLockFails_Exits1: sin poder escribir el candado sale 1 y no deja proceso', { skip: WIN || process.getuid() === 0 }, () => {
  const m = toy();
  const dir = path.join(m.sdir, 'office');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  try {
    const r = openSync(m);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /office\.js: .+/);
    assert.strictEqual(r.stderr.trim().split('\n').length, 1, 'el motivo en una línea');
    assert.strictEqual(readLock(m), null);
  } finally { fs.chmodSync(dir, 0o700); }
});

test('T16 Static_JsonAndOut_StartNoProcess: --json y --out siguen igual, sin proceso', () => {
  const m = toy();
  const json = spawnSync('node', [OFFICE, '--json'], { input: '', env: envOf(m.home), encoding: 'utf8' });
  assert.strictEqual(json.status, 0, json.stderr);
  assert.deepStrictEqual(JSON.parse(json.stdout).agents.map((a) => a.nombre), ['Alfa']);
  const out = path.join(m.home, 'oficina.html');
  const html = spawnSync('node', [OFFICE, '--out', out], { input: '', env: envOf(m.home), encoding: 'utf8' });
  assert.strictEqual(html.status, 0, html.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /<title>Oficina del arnés<\/title>/);
  assert.strictEqual(readLock(m), null, 'ningún candado');
});

test('T54 BackChannel_Closed_1008: la página no puede mandarle nada al proceso', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const other = page(lock);
  await other.next();
  for (const [payload, code] of [['hola', 1008], [Buffer.from([1, 2, 3]), 1008], ['x'.repeat(2048), 1009]]) {
    const p = page(lock);
    await p.next();
    p.send(payload);
    assert.strictEqual(await Promise.race([p.closed, sleep(3000).then(() => 'abierta')]), code);
  }
  const foto = await other.next(3000);
  assert.ok(foto.data.unreadable.some((u) => /canal de vuelta está cerrado/.test(u)), foto.data.unreadable.join(' | '));
  assert.strictEqual(other.readyState, 1, 'la otra página sigue conectada');
  other.close();
});

test('T55 VendoredWs_PinnedAndOffline: ws 8.22.0 copiada tal cual, cargada sin red ni node_modules', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(VENDOR_WS, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, '8.22.0');
  assert.strictEqual(pkg.license, 'MIT');
  assert.match(fs.readFileSync(path.join(VENDOR_WS, 'LICENSE'), 'utf8'), /Permission is hereby granted, free of charge/);
  const stamp = JSON.parse(fs.readFileSync(path.join(VENDOR_WS, 'VERSION.json'), 'utf8'));
  assert.strictEqual(stamp.version, '8.22.0');
  assert.match(stamp.integrity, /^sha512-/);
  for (const [rel, sha] of Object.entries(stamp.files)) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR_WS, rel))).digest('hex');
    assert.strictEqual(got, sha, `${rel} igual al publicado`);
  }
  // el proceso la carga de la copia: sin red, sin node_modules
  const r = spawnSync('node', ['-e', `const p=require.resolve(${JSON.stringify(SERVER)});require(p);const k=Object.keys(require.cache).filter(f=>/[\\\\/]ws[\\\\/]/.test(f));process.stdout.write(JSON.stringify(k))`], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const loaded = JSON.parse(r.stdout);
  assert.ok(loaded.length > 0 && loaded.every((f) => f.startsWith(VENDOR_WS)), loaded.join(', '));
  assert.ok(!loaded.some((f) => f.includes('node_modules')));
});

// A preload that makes the first photo of server.js slow: it reads for real, writes `flag`, then waits `ms`.
function slowFirstPhoto(ms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-slow-'));
  const flag = path.join(dir, 'leyo');
  const file = path.join(dir, 'slow.js');
  fs.writeFileSync(file, `if (!require('worker_threads').isMainThread) {
  const Module = require('module'); const orig = Module.prototype.require; let done = false;
  Module.prototype.require = function (id) {
    const m = orig.apply(this, arguments);
    if (!done && /tools[\\\\/]office\\.js$/.test(id)) {
      done = true; const c = m.collect; let first = true;
      m.collect = async (...a) => { const d = await c(...a); if (first) { first = false; require('fs').writeFileSync(${JSON.stringify(flag)}, 'x'); await new Promise((r) => setTimeout(r, ${ms})); } return d; };
    }
    return m;
  };
}\n`);
  return { NODE_OPTIONS: `--require ${file}`, flag };
}
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(50); } return cond(); };
const watchedOf = (m) => require(SERVER).watchedDirs(m.home, m.sdir);

test('T59 FirstPhoto_ChangeDuringIt_NotLost: un cambio mientras se arma la primera foto llega a la página', async () => {
  const m = toy();
  const slow = slowFirstPhoto(2500);
  const opening = openAsync(m, { NODE_OPTIONS: slow.NODE_OPTIONS });
  assert.ok(await until(() => fs.existsSync(slow.flag), 10000), 'la primera foto empezó a leer');
  // la primera foto ya leyó las carpetas: esta sesión nueva no está en ella
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Nueva', status: 'busy', statusUpdatedAt: Date.now() }));
  const r = await opening;
  assert.strictEqual(r.status, 0, r.stderr);
  const p = page(readLock(m));
  assert.ok(await until(() => p.fotos.some((f) => JSON.stringify(f.data).includes('Nueva')), 6000), 'la sesión nueva llega sin otro cambio');
  p.close();
});

test('T60 FirstPhoto_Slow_OpenStillAnswers: una primera foto lenta no hace fallar --open ni mata al proceso', async () => {
  const m = toy();
  const slow = slowFirstPhoto(12000);
  const t0 = Date.now();
  const r = openSync(m, { NODE_OPTIONS: slow.NODE_OPTIONS });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10000, 'el proceso contesta antes de tener la foto');
  const lock = readLock(m);
  assert.ok(lock && alive(lock.pid), 'el proceso sigue vivo');
  const p = page(lock);
  const first = await p.next(16000);
  assert.strictEqual(first.type, 'foto');
  p.close();
});

// A preload that makes every photo after the first one fail.
function failingRecompute() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-fail-'));
  const file = path.join(dir, 'fail.js');
  fs.writeFileSync(file, `if (!require('worker_threads').isMainThread) {
  const Module = require('module'); const orig = Module.prototype.require; let done = false;
  Module.prototype.require = function (id) {
    const m = orig.apply(this, arguments);
    if (!done && /tools[\\\\/]office\\.js$/.test(id)) {
      done = true; const c = m.collect; let calls = 0;
      m.collect = async (...a) => { calls += 1; if (calls > 1) throw new Error('lectura rota de prueba'); return c(...a); };
    }
    return m;
  };
}\n`);
  return { NODE_OPTIONS: `--require ${file}` };
}

// A raw TCP client that asks for the WebSocket without a token and resets the connection right away.
function resetUpgrade(port) {
  return new Promise((resolve) => {
    const s = require('net').connect(port, '127.0.0.1', () => {
      s.write(`GET /live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
      setImmediate(() => { s.resetAndDestroy(); resolve(); });
    });
    s.on('error', () => resolve());
  });
}

test('T62 Upgrade_RejectedAndReset_ProcessLives: un pedido rechazado que corta de golpe no tira el proceso', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  await p.next();
  for (let i = 0; i < 20; i += 1) await resetUpgrade(lock.port);
  await sleep(300);
  assert.ok(alive(lock.pid), 'el proceso sigue vivo');
  assert.strictEqual((await get(lock.port, `/health?t=${lock.token}`)).status, 200);
  assert.strictEqual(p.readyState, 1, 'la página conectada sigue');
  p.close();
});

test('T63 Modules_BadPercent_404: una ruta con un % roto contesta 404 sin tirar el proceso', async () => {
  const m = toy();
  openSync(m);
  const lock = readLock(m);
  assert.strictEqual((await get(lock.port, `/modules/%E0%A4%A?t=${lock.token}`)).status, 404);
  // los nombres que todo objeto hereda no son módulos
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual((await get(lock.port, `/modules/${k}?t=${lock.token}`)).status, 404, k);
  }
  assert.ok(alive(lock.pid));
  assert.strictEqual((await get(lock.port, `/health?t=${lock.token}`)).status, 200);
});

test('T64 Recompute_Fails_PageTold: si una foto nueva no se puede armar, la página lo sabe una vez', async () => {
  const m = toy();
  openSync(m, failingRecompute());
  const p = page(readLock(m));
  await p.next();
  for (let i = 0; i < 3; i += 1) { fs.writeFileSync(path.join(m.sdir, 'doing', `n${i}.json`), '{}'); await sleep(500); }
  assert.ok(await until(() => p.fotos.some((f) => f.data.unreadable.some((u) => /no se pudo recalcular/.test(u))), 4000), 'llega la foto con el aviso');
  const last = p.fotos[p.fotos.length - 1].data.unreadable.filter((u) => /no se pudo recalcular/.test(u));
  assert.strictEqual(last.length, 1, 'el aviso no se repite');
  p.close();
});

// A preload that holds the photo's thread without letting go, as git does, and writes `flag` when it starts holding it.
function blockingPhoto(ms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-block-'));
  const flag = path.join(dir, 'trabado');
  const file = path.join(dir, 'block.js');
  fs.writeFileSync(file, `if (!require('worker_threads').isMainThread) {
  const Module = require('module'); const orig = Module.prototype.require; let done = false;
  Module.prototype.require = function (id) {
    const m = orig.apply(this, arguments);
    if (!done && /tools[\\\\/]office\\.js$/.test(id)) {
      done = true; const c = m.collect;
      m.collect = async (...a) => { const d = await c(...a); require('fs').writeFileSync(${JSON.stringify(flag)}, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms}); return d; };
    }
    return m;
  };
}\n`);
  return { NODE_OPTIONS: `--require ${file}`, flag };
}

// A preload that makes the second photo of each thread kill that thread.
function dyingThread() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-die-'));
  const file = path.join(dir, 'die.js');
  fs.writeFileSync(file, `if (!require('worker_threads').isMainThread) {
  const Module = require('module'); const orig = Module.prototype.require; let done = false;
  Module.prototype.require = function (id) {
    const m = orig.apply(this, arguments);
    if (!done && /tools[\\\\/]office\\.js$/.test(id)) {
      done = true; const c = m.collect; let calls = 0;
      m.collect = async (...a) => { calls += 1; if (calls === 2) process.exit(1); return c(...a); };
    }
    return m;
  };
}\n`);
  return { NODE_OPTIONS: `--require ${file}` };
}

test('T65 Photo_HoldsItsThread_ProcessAnswers: mientras se arma la foto, el proceso contesta enseguida', async () => {
  const m = toy();
  const held = blockingPhoto(4000);
  const opening = openAsync(m, { NODE_OPTIONS: held.NODE_OPTIONS });
  assert.ok(await until(() => fs.existsSync(held.flag) && readLock(m), 10000), 'la foto está trabada');
  const lock = readLock(m);
  const t0 = Date.now();
  const health = await get(lock.port, `/health?t=${lock.token}`);
  assert.strictEqual(health.status, 200);
  assert.ok(Date.now() - t0 < 1500, `contestó en ${Date.now() - t0} ms`);
  await opening;
});

test('T66 Photo_ThreadDies_PageToldAndNextPhotoWorks: si el hilo de la foto se cae, la página lo sabe y la próxima foto sale', async () => {
  const m = toy();
  openSync(m, dyingThread());
  const p = page(readLock(m));
  await p.next();
  fs.writeFileSync(path.join(m.sdir, 'doing', 'n0.json'), '{}');
  assert.ok(await until(() => p.fotos.some((f) => f.data.unreadable.some((u) => /no se pudo recalcular: el hilo de la foto se cerró/.test(u))), 6000), 'llega el aviso');
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Nueva', status: 'busy', statusUpdatedAt: Date.now() }));
  assert.ok(await until(() => { const d = p.fotos[p.fotos.length - 1].data; return JSON.stringify(d).includes('Nueva') && !d.unreadable.some((u) => /no se pudo recalcular/.test(u)); }, 6000), 'otro hilo armó la foto, y el aviso se fue');
  p.close();
});

// What a closed session left: a folder with one file not saved.
function leftBehind(m) {
  const repo = path.join(m.home, 'trabajo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  spawnSync('git', ['init', '-q', repo]);
  git('symbolic-ref', 'HEAD', 'refs/heads/trabajo');
  git('commit', '-q', '--allow-empty', '-m', 'uno');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x');
  fs.mkdirSync(path.join(m.sdir, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(m.sdir, 'adhoc', 'cerrada-1.json'), JSON.stringify({ reason: 'lo dejado', files: [path.join(repo, 'a.js')], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() }));
  return repo;
}
const halfOf = (f) => JSON.stringify(f.data.kanban.medioCamino);
const lastFoto = (p) => p.fotos[p.fotos.length - 1];

test('T67 Halfway_EveryWhile_PageOpen: con la página abierta se revisa cada tanto, aunque nada avise', async () => {
  const m = toy();
  const repo = leftBehind(m);
  openSync(m, { TYCON_OFFICE_HALFWAY_MS: '1500' });
  const p = page(readLock(m));
  const first = await p.next();
  assert.strictEqual(first.data.kanban.medioCamino.length, 1);
  assert.match(first.data.kanban.medioCaminoLeido, /^Leído a las \d\d:\d\d$/);
  fs.writeFileSync(path.join(repo, 'b.js'), 'x');
  assert.ok(await until(() => halfOf(lastFoto(p)) !== halfOf(first), 8000), 'la revisión ve el archivo nuevo');
  p.close();
});

test('T68 Halfway_OtherChange_NotRead: otro cambio arma la foto sin volver a leer A medio camino', async () => {
  const m = toy();
  const repo = leftBehind(m);
  openSync(m);
  const lock = readLock(m);
  const p = page(lock);
  const first = await p.next();
  const before = (await counters(lock)).reads;
  fs.writeFileSync(path.join(repo, 'b.js'), 'x');
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Nueva', status: 'busy', statusUpdatedAt: Date.now() }));
  assert.ok(await until(() => JSON.stringify(lastFoto(p).data).includes('Nueva'), 6000), 'la sesión nueva llegó en vivo');
  assert.ok((await counters(lock)).reads > before);
  assert.strictEqual(halfOf(lastFoto(p)), halfOf(first), 'A medio camino espera su revisión');
  p.close();
});

test('T69 Halfway_PageOpened_Read: al abrir la oficina otra vez se revisa', async () => {
  const m = toy();
  const repo = leftBehind(m);
  openSync(m, { TYCON_OFFICE_HALFWAY_FRESH_MS: '200' });
  const lock = readLock(m);
  const p = page(lock);
  const first = await p.next();
  p.close();
  fs.writeFileSync(path.join(repo, 'b.js'), 'x');
  await sleep(600);
  const again = page(lock);
  await again.next();
  assert.ok(await until(() => halfOf(lastFoto(again)) !== halfOf(first), 6000), 'la página nueva ve el archivo nuevo');
  again.close();
});

test('T61 Signatures_Change_PushesPhoto: una firma pedida o resuelta llega sola a la página', async () => {
  const m = toy();
  assert.ok(watchedOf(m).includes(path.join(m.sdir, 'coordination')), 'vigila las firmas');
  assert.ok(watchedOf(m).includes(path.join(m.sdir, 'gates.log')), 'vigila quién coordina');
  openSync(m);
  const p = page(readLock(m));
  await p.next();
  fs.mkdirSync(path.join(m.sdir, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(m.sdir, 'coordination', 'signatures.json'), JSON.stringify([{ title: 'firma de prueba', sid: 's1', at: Date.now() }]));
  assert.ok(await until(() => p.fotos.length >= 2, 4000), 'llega una foto nueva sin tocar otra carpeta');
  p.close();
});

// Una conversación de juguete para una sesión de la máquina de juguete.
function toyTranscript(m, sid, lines) {
  const dir = path.join(claudeDir(m.home), 'projects', 'toy');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return file;
}
const peerLine = (name, body, id) => ({ type: 'user', isMeta: true, timestamp: new Date().toISOString(), origin: { kind: 'peer', name, body, msg_id: id }, message: { role: 'user', content: 'x' } });

test('T30 Envelope_InPhoto_NoText; Conversation_OnlyWithToken: el sobre dice quién y no qué; el texto se pide con el token, por un nombre de la oficina', async () => {
  const m = toy();
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Beta', status: 'busy', statusUpdatedAt: Date.now() }));
  toyTranscript(m, 's1', [{ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Empiezo.' }] } }]);
  const r = openSync(m);
  assert.strictEqual(r.status, 0, r.stderr);
  const lock = readLock(m);
  const ws = page(lock);
  await ws.opened;
  await ws.next(8000);
  toyTranscript(m, 's1', [peerLine('Beta', 'el secreto del mensaje', 'id-1')]);
  // la foto se renueva cuando cambia algo que la oficina vigila
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', name: 'Beta', status: 'idle', statusUpdatedAt: Date.now() }));
  let foto = null;
  for (let i = 0; i < 40 && !foto; i += 1) {
    await sleep(100);
    foto = ws.fotos.map((f) => f.data).find((d) => d && (d.sobres || []).length);
  }
  assert.ok(foto, 'llegó una foto con el sobre');
  assert.deepStrictEqual(foto.sobres.map((s) => [s.id, s.de, s.a]), [['id-1', 'Beta', 'Alfa']]);
  assert.ok(!JSON.stringify(ws.fotos).includes('el secreto del mensaje'), 'el texto nunca viaja en la foto');
  // sin token no se lee; un nombre que no está en la oficina, tampoco; una ruta no es un nombre
  assert.strictEqual((await get(lock.port, '/conversacion?s=Alfa')).status, 403);
  assert.strictEqual((await get(lock.port, `/conversacion?t=${lock.token}&s=${encodeURIComponent('../../etc/passwd')}`)).status, 404);
  const said = await get(lock.port, `/conversacion?t=${lock.token}&s=Alfa`);
  assert.strictEqual(said.status, 200);
  const conv = JSON.parse(said.body);
  assert.strictEqual(conv.sinCoordinadora, true, 'sin coordinadora designada, no hay con quién cruzar');
  assert.deepStrictEqual(conv.conVos, [], 'lo de la persona se lee igual (8.183), y acá no hay nada suyo');
  assert.ok(!JSON.stringify(conv).includes('el secreto del mensaje'), 'el mensaje de otra sesión no está en lo de la persona');
  ws.close();
});

// ── Hablarle a una sesión desde la oficina ─────────────────────────────────────────────────────────────────────────

const om = require(path.join(ROOT, 'scripts', 'lib', 'office-messages.js'));
const { officeMessages } = require(path.join(ROOT, 'scripts', 'tools', 'office', 'messages.js'));

// un vigilante «vivo» para la sesión: el candado con el pid de esta prueba
function watcherAlive(m, sid) {
  fs.mkdirSync(om.paths(m.sdir).watchers, { recursive: true });
  fs.writeFileSync(om.paths(m.sdir).watcher(sid), JSON.stringify({ pid: process.pid, started: om.processStart(process.pid) }));
}
// lo que manda la ventana: el token, el Host y el Origin de la oficina, Sec-Fetch-Site y el tipo; `drop` saca uno
function post(port, token, body, { drop = null, headers = {}, method = 'POST' } = {}) {
  const base = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  if (drop) delete base[drop];
  const pathName = drop === 'token' ? '/mensaje' : `/mensaje?t=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: { ...base, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* sin cuerpo */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body == null ? undefined : JSON.stringify(body));
  });
}
const inboxOf = (m, sid = 's1') => { try { return fs.readdirSync(om.paths(m.sdir).inbox(sid)).filter((f) => f.endsWith('.json')); } catch { return []; } };
const logOf = (m) => om.readLog(m.sdir).rows;

// la oficina de verdad, con Alfa (s1) en la foto y su conversación
async function messagingOffice(more = {}) {
  const m = toy();
  toyTranscript(m, 's1', [{ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Empiezo.' }] } }]);
  const r = openSync(m, more);
  assert.strictEqual(r.status, 0, r.stderr);
  const lock = readLock(m);
  const ws = page(lock);
  await ws.opened;
  await ws.next(8000);
  return { m, lock, ws };
}

// la ruta montada en un servidor de la prueba, con los relojes cortos: los plazos se miden sin esperar minutos
async function mountedRoute(m, recipients, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries({ TYCON_OFFICE_MESSAGE_POLL_MS: '50', ...env })) { saved[k] = process.env[k]; process.env[k] = v; }
  const said = [];
  const envelopes = { files: new Map(), recipients: new Map(Object.entries(recipients)) };
  let port = 0;
  const route = officeMessages({ sdir: m.sdir, envelopes, okOrigin: (o) => o === `http://127.0.0.1:${port}`, notify: (x) => said.push(x) });
  const srv = http.createServer((req, res) => route.onPost(req, res));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  port = srv.address().port;
  const close = () => { route.stop(); srv.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return { port, said, envelopes, route, close, send: (body, o) => post(port, 'x', body, o) };
}

test('T1 Mensaje_PedidoCompleto_LoGuardaEnElBuzon @story-8.183 @ac-2 @ac-19: 200 y el mensaje en el buzón, 0600 en una carpeta 0700', async () => {
  const { m, lock, ws } = await messagingOffice();
  watcherAlive(m, 's1');
  const r = await post(lock.port, lock.token, { s: 'Alfa', texto: 'revisá el pedido 12' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.estado, 'mandado');
  assert.match(r.json.id, /^[0-9a-f]{32}$/);
  const files = inboxOf(m);
  assert.deepStrictEqual(files, [`${r.json.id}.json`]);
  if (!WIN) {
    assert.strictEqual(fs.statSync(path.join(om.paths(m.sdir).inbox('s1'), files[0])).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(om.paths(m.sdir).inbox('s1')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(om.paths(m.sdir).dir).mode & 0o777, 0o700);
  }
  assert.ok(logOf(m).some((x) => x.id === r.json.id && x.estado === 'mandado'));
  ws.close();
});

test('T2 Mensaje_SinCadaControl_NoEscribeNada @story-8.183 @ac-16 @ac-29: sin token, Host, Origin, Sec-Fetch-Site o tipo: 403 o 415, sin buzón ni registro', async () => {
  const { m, lock, ws } = await messagingOffice();
  watcherAlive(m, 's1');
  const cases = [['token', 403], ['host', 403], ['origin', 403], ['sec-fetch-site', 403], ['content-type', 415]];
  for (const [drop, code] of cases) {
    const r = await post(lock.port, lock.token, { s: 'Alfa', texto: 'hola' }, { drop, ...(drop === 'host' ? { headers: { host: `evil.example:${lock.port}` } } : {}) });
    assert.strictEqual(r.status, code, `sin ${drop}`);
  }
  const wrongType = await post(lock.port, lock.token, { s: 'Alfa', texto: 'hola' }, { headers: { 'content-type': 'text/plain' } });
  assert.strictEqual(wrongType.status, 415);
  assert.deepStrictEqual(inboxOf(m), []);
  assert.deepStrictEqual(logOf(m), []);
  ws.close();
});

test('T3 Mensaje_OtroOrigen_NoPasaNiDaPermisos @story-8.183 @ac-17: otro Origin y el preflight se rechazan sin cabeceras CORS', async () => {
  const { m, lock, ws } = await messagingOffice();
  watcherAlive(m, 's1');
  const other = await post(lock.port, lock.token, { s: 'Alfa', texto: 'hola' }, { headers: { origin: 'http://127.0.0.1:9', 'sec-fetch-site': 'same-site' } });
  assert.strictEqual(other.status, 403);
  const pre = await post(lock.port, lock.token, null, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:9', 'access-control-request-method': 'POST' } });
  assert.notStrictEqual(pre.status, 200);
  for (const r of [other, pre]) assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), JSON.stringify(r.headers));
  assert.deepStrictEqual(inboxOf(m), []);
  ws.close();
});

test('T4 Mensaje_DestinoQueNoEsPersona_404 @story-8.183 @ac-18: una ruta, constructor o un nombre desconocido dan 404 sin escribir en el buzón', async () => {
  const { m, lock, ws } = await messagingOffice();
  watcherAlive(m, 's1');
  for (const s of ['../x', 'constructor', '__proto__', 'Nadie']) {
    const r = await post(lock.port, lock.token, { s, texto: 'hola' });
    assert.strictEqual(r.status, 404, s);
  }
  assert.deepStrictEqual(fs.existsSync(om.paths(m.sdir).inboxRoot) ? fs.readdirSync(om.paths(m.sdir).inboxRoot) : [], []);
  assert.ok(logOf(m).every((x) => x.estado === 'rechazado'), 'quedan anotados como rechazados');
  ws.close();
});

test('T19 CanalDeVuelta_SigueCerrado @story-8.183 @ac-34: un mensaje por el WebSocket cierra con 1008; /event con otro tipo, 400', async () => {
  const { lock, ws } = await messagingOffice();
  const p = page(lock);
  await p.next();
  p.send(JSON.stringify({ type: 'mensaje', s: 'Alfa', texto: 'hola' }));
  assert.strictEqual(await Promise.race([p.closed, sleep(3000).then(() => 'abierta')]), 1008);
  const ev = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: lock.port, path: `/event?t=${lock.token}`, method: 'POST', headers: { host: `127.0.0.1:${lock.port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(JSON.stringify({ type: 'mensaje' }));
  });
  assert.strictEqual(ev, 400);
  ws.close();
});

test('T14 Mensaje_SinTomar10s_NoEntregado @story-8.183 @ac-23: sin nadie que lo tome, sale del buzón, queda no-entregado y se avisa', async () => {
  const m = toy();
  watcherAlive(m, 's1');
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } }, { TYCON_OFFICE_MESSAGE_DEADLINE_MS: '300' });
  try {
    const sent = await r.send({ s: 'Alfa', texto: 'nadie me lee' });
    assert.strictEqual(sent.status, 200);
    const end = Date.now() + 4000;
    while (Date.now() < end && !r.said.some((x) => x.estado === 'no-entregado')) await sleep(50);
    assert.deepStrictEqual(r.said.map((x) => [x.id, x.estado]), [[sent.json.id, 'no-entregado']]);
    assert.strictEqual(r.said[0].motivo, 'No le llegó.');
    assert.deepStrictEqual(inboxOf(m), []);
    assert.ok(logOf(m).some((x) => x.id === sent.json.id && x.estado === 'no-entregado'));
  } finally { r.close(); }
});

test('T16 Mensaje_CincoEsperando_ElSextoNo @story-8.183 @ac-26: con 5 sin tomar, el sexto da 409 y no se guarda', async () => {
  const m = toy();
  watcherAlive(m, 's1');
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } }, { TYCON_OFFICE_MESSAGE_DEADLINE_MS: '60000' });
  try {
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await r.send({ s: 'Alfa', texto: `m${i}` })).status, 200);
    const sixth = await r.send({ s: 'Alfa', texto: 'el sexto' });
    assert.strictEqual(sixth.status, 409);
    assert.strictEqual(sixth.json.esperando, 5);
    assert.match(sixth.json.motivo, /5 mensajes esperando/);
    assert.strictEqual(inboxOf(m).length, 5);
  } finally { r.close(); }
});

test('T17 Mensaje_SesionDeCodex_409 @story-8.183 @ac-25: a una sesión de Codex no se le escribe', async () => {
  const m = toy();
  const r = await mountedRoute(m, { Gamma: { sid: 'c1', recibe: 'codex' } });
  try {
    const got = await r.send({ s: 'Gamma', texto: 'hola' });
    assert.strictEqual(got.status, 409);
    assert.strictEqual(got.json.motivo, 'Esta sesión es de Codex: desde acá no se le puede escribir.');
    assert.deepStrictEqual(inboxOf(m, 'c1'), []);
  } finally { r.close(); }
});

test('T18 Mensaje_Apagado_409 @story-8.183 @ac-28: con TYCON_OFFICE_MESSAGES=0 contesta 409 y dice que está apagado', async () => {
  const m = toy();
  watcherAlive(m, 's1');
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } }, { TYCON_OFFICE_MESSAGES: '0' });
  try {
    const got = await r.send({ s: 'Alfa', texto: 'hola' });
    assert.strictEqual(got.status, 409);
    assert.match(got.json.motivo, /apagados/);
    assert.deepStrictEqual(inboxOf(m), []);
  } finally { r.close(); }
});

test('Mensaje_SinVigilante_409 (8.183 T23, ruta) @story-8.183 @ac-22: sin vigilante vivo, 409 con el texto de la ventana', async () => {
  const m = toy();
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } });
  try {
    const got = await r.send({ s: 'Alfa', texto: 'hola' });
    assert.strictEqual(got.status, 409);
    assert.strictEqual(got.json.motivo, 'Esta sesión no puede recibir mensajes de la oficina. Escribile una vez en su pestaña y vuelve a poder.');
    assert.deepStrictEqual(inboxOf(m), []);
  } finally { r.close(); }
});

test('T27 Mensaje_NoEscribeEnAprobaciones @story-8.183 @ac-14 @ac-15: «aprobado» avisa antes; mandado igual, owner-approvals queda como estaba', async () => {
  const m = toy();
  watcherAlive(m, 's1');
  const approvals = path.join(m.sdir, 'owner-approvals');
  fs.mkdirSync(approvals, { recursive: true });
  fs.writeFileSync(path.join(approvals, 'previa.json'), '{}');
  const before = fs.readdirSync(approvals).sort();
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } }, { TYCON_OFFICE_MESSAGE_DEADLINE_MS: '60000' });
  try {
    const warned = await r.send({ s: 'Alfa', texto: 'aprobado' });
    assert.strictEqual(warned.status, 409);
    assert.strictEqual(warned.json.parece, 'aprobacion');
    assert.strictEqual(warned.json.motivo, 'Esto no aprueba nada: para aprobar, contestá el cuadro.');
    assert.deepStrictEqual(inboxOf(m), []);
    const anyway = await r.send({ s: 'Alfa', texto: 'aprobado', igual: true });
    assert.strictEqual(anyway.status, 200);
    const got = om.take(m.sdir, 's1');
    assert.match(got.envelope, /Parece una aprobación y no lo es\. Dice: aprobado$/);
    assert.deepStrictEqual(fs.readdirSync(approvals).sort(), before);
  } finally { r.close(); }
});

test('T39 Mensaje_TomadoSinAparecer_LoDice @story-8.183 @ac-24: sólo con la sesión quieta y el plazo vencido avisa que no aparece', async () => {
  const m = toy();
  watcherAlive(m, 's1');
  const file = toyTranscript(m, 's1', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] } }]);
  for (const [estado, shouldSay] of [['libre', true], ['pregunta', false], ['trabajando', false]]) {
    const recipients = { Alfa: { sid: 's1', recibe: 'si', ocupada: estado === 'trabajando', cuadro: estado === 'pregunta' } };
    const r = await mountedRoute(m, recipients, { TYCON_OFFICE_MESSAGE_DEADLINE_MS: '60000', TYCON_OFFICE_MESSAGE_APPEAR_MS: '300' });
    r.envelopes.files.set('Alfa', { file, sid: 's1' });
    try {
      const sent = await r.send({ s: 'Alfa', texto: `mensaje con la sesión ${estado}` });
      assert.strictEqual(sent.status, 200);
      assert.strictEqual(om.take(m.sdir, 's1').estado, 'recibido');
      await sleep(1200);
      assert.ok(r.said.some((x) => x.estado === 'recibido'), `${estado}: dijo que lo recibió`);
      assert.strictEqual(r.said.some((x) => x.estado === 'no-aparece'), shouldSay, estado);
      if (shouldSay) assert.strictEqual(r.said.find((x) => x.estado === 'no-aparece').motivo, 'Se le entregó y no aparece en su conversación.');
    } finally { r.close(); }
  }
});

test('T45 Sitio_MensajesDeLaOficina_NoSalen @story-8.183 @ac-41: al sitio no van los mensajes escritos desde la oficina ni el estado del destinatario', () => {
  const { forSite } = require(SERVER);
  const enLaPestana = { quien: 'vos', at: '2026-11-04T10:00:00Z', texto: 'revisá el pedido' };
  const respuesta = { quien: 'sesion', at: '2026-11-04T10:01:00Z', texto: 'listo' };
  const desdeLaOficina = { quien: 'vos', at: '2026-11-04T10:02:00Z', texto: 'seguí con la tanda', oficina: true, id: '3f9c2a7d0b1e4c5a8d6e7f9012345678' };
  const conv = { conVos: [enLaPestana, respuesta, desdeLaOficina], conCoordinadora: [], oficina: { recibe: 'si', cuadro: false } };
  const antes = JSON.parse(JSON.stringify(conv));
  const out = forSite(conv);
  assert.deepStrictEqual(out, { conVos: [enLaPestana, respuesta], conCoordinadora: [] });
  assert.deepStrictEqual(conv, antes, 'la conversación que recibe queda igual');
});

test('T53 NoAparece_ConversacionQueCrecio_LoEncuentra @story-8.183 @ac-24: el sobre entregado sigue encontrándose aunque después la conversación crezca más de 2 MB', () => {
  const { appearsIn } = require(path.join(ROOT, 'scripts', 'tools', 'office', 'messages.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-aparece-'));
  const file = path.join(dir, 't.jsonl');
  const id = '3f9c2a7d0b1e4c5a8d6e7f9012345678';
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: `[oficina ${id}] Mensaje de la persona` } })}\n`);
  assert.strictEqual(appearsIn(file, id), true);
  const junk = `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(4000) }] } })}\n`;
  fs.appendFileSync(file, junk.repeat(700));
  assert.ok(fs.statSync(file).size > 2.5 * 1024 * 1024);
  assert.strictEqual(appearsIn(file, id), true, 'lo encuentra aunque quede lejos del final');
  assert.strictEqual(appearsIn(file, 'a'.repeat(32)), false);
  assert.strictEqual(appearsIn(path.join(dir, 'no-esta.jsonl'), id), null);
});

test('T40 Mensaje_EntreEntregaYCierre_Espera @story-8.183 @ac-38: tras una entrega, se acepta y espera; vencido el plazo largo, no-entregado', async () => {
  const m = toy();
  fs.mkdirSync(om.paths(m.sdir).watchers, { recursive: true });
  fs.writeFileSync(om.paths(m.sdir).watcher('s1'), JSON.stringify({ pid: null, deliveredAt: Date.now() }));
  const r = await mountedRoute(m, { Alfa: { sid: 's1', recibe: 'si' } }, { TYCON_OFFICE_MESSAGE_DEADLINE_MS: '50', TYCON_OFFICE_MESSAGE_LONG_MS: '600' });
  try {
    const sent = await r.send({ s: 'Alfa', texto: 'para cuando termine' });
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sent.json.motivo, 'Lo va a recibir cuando termine lo que está haciendo.');
    await sleep(300);
    assert.deepStrictEqual(inboxOf(m), [`${sent.json.id}.json`], 'pasado el plazo corto sigue esperando');
    const end = Date.now() + 4000;
    while (Date.now() < end && !r.said.some((x) => x.estado === 'no-entregado')) await sleep(50);
    assert.ok(r.said.some((x) => x.id === sent.json.id && x.estado === 'no-entregado'));
    assert.deepStrictEqual(inboxOf(m), []);
  } finally { r.close(); }
});

test('Oficina_AlArrancar_BarreElBuzon (8.183 T41, oficina) @story-8.183 @ac-39: un mensaje vencido del buzón sale al abrir la oficina', async () => {
  const m = toy();
  const old = om.leave(m.sdir, { sid: 's1', text: 'de ayer', now: Date.now() - 3600 * 1000, deadlineMs: 10000 });
  const r = openSync(m);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(inboxOf(m), []);
  assert.ok(logOf(m).some((x) => x.id === old.id && x.estado === 'no-entregado' && x.motivo === 'vencido'));
});

// ── La tarjeta que se abre y la rueda: el código de la página, sin levantar el proceso ──────────────────────────────

const officePage = require(OFFICE).page;

test('T97 Card_Pr: el pedido de una tarjeta lleva su enlace sólo si se sabe dónde está', () => {
  const { cardPr } = require(OFFICE);
  assert.deepStrictEqual(cardPr('acme/mi-repo', 912), { numero: 912, sitio: 'github', ruta: 'acme/mi-repo/pull/912' });
  assert.deepStrictEqual(cardPr('acme/mi proyecto/repo', 6138), { numero: 6138, sitio: 'azure', ruta: 'acme/mi%20proyecto/_git/repo/pullrequest/6138' });
  assert.deepStrictEqual(cardPr('tycon-harness', 912), { numero: 912 });
  assert.deepStrictEqual(cardPr(undefined, 912), { numero: 912 });
});

// The card-detail code of the page, on a small stand-in for the DOM.
function cardDetail(card, sessions = []) {
  class Fake {
    constructor(tag, cls, text) { this.tag = tag; this.className = cls || ''; this.textContent = text == null ? '' : String(text); this.children = []; this.hidden = true; this.style = { setProperty() {} }; this.classList = { add: (c) => { this.added = c; }, remove() {} }; }
    append(...kids) { this.children.push(...kids.map((k) => (typeof k === 'string' ? new Fake('#text', '', k) : k))); }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    focus() { this.focused = true; }
    setAttribute(k, v) { (this.attrs = this.attrs || {})[k] = String(v); }
  }
  const box = new Fake('div');
  const win = new Fake('div');
  win.firstElementChild = box;
  const html = officePage({ agents: [], items: [], kanban: null, meta: null });
  const code = html.slice(html.indexOf('// Quién hace una tarjeta'), html.indexOf('function abrirCharla('));
  const fichas = [];
  const stubs = {
    // el número de la tarjeta (8.198): la misma regla que la página
    numeroDe: (i) => (i && typeof i.numero === 'string' ? i.numero : ''),
    // la X arriba de cada ventana (8.198)
    botonCerrar: (alCerrar) => { const b = new Fake('button', 'close', '×'); b.setAttribute('aria-label', 'Cerrar'); b.onclick = alCerrar; return b; },
    el: (tag, cls, text) => new Fake(tag, cls, text), finTxt: (a) => (a.fin ? { hora: a.fin } : null), agents: sessions, AST: { trabajando: ['Trabajando', '#0f0'] }, etiquetaComo: (c) => new Fake('span', 'como', c), pintarFicha: (a) => fichas.push(a.nombre), ventana: () => win, cerrarCharla() {},
    document: { documentElement: new Fake('html') },
  };
  new Function(...Object.keys(stubs), `let charlaDe=null,ultimoPedido=0,charlaVuelve=null;${code};abrirTarjeta(${JSON.stringify(card)},{});`)(...Object.values(stubs));
  const rows = {};
  const dl = box.children.find((k) => k.tag === 'dl');
  if (dl) for (let i = 0; i < dl.children.length; i += 2) rows[dl.children[i].textContent] = dl.children[i + 1].children[0];
  return { box, win, rows, fichas, title: box.children[0].textContent, last: box.children[box.children.length - 1] };
}

test('T98 Card_Detail_WithSession: título entero, lo que sabe la tarjeta y la misma ficha de la persona, sin repetir su hora', () => {
  const d = cardDetail({ titulo: 'Las oficinas de cada dev, en vivo, en el sitio', quien: 'Tero', hora: 'mar 04:00', nota: 'espera el turno', pedido: { numero: 912, sitio: 'github', ruta: 'o/r/pull/912' } }, [{ nombre: 'Tero', estado: 'trabajando', fin: 'mar 04:00' }]);
  assert.strictEqual(d.title, 'Las oficinas de cada dev, en vivo, en el sitio');
  assert.strictEqual(d.win.hidden, false);
  assert.deepStrictEqual(d.fichas, ['Tero']);
  assert.strictEqual(d.rows['Quién'].textContent, 'Tero');
  assert.strictEqual(d.rows['Nota'].textContent, 'espera el turno');
  assert.ok(!('Cuándo' in d.rows), 'la misma hora la dice la ficha');
  const other = cardDetail({ titulo: 'Otra fila de Tero', quien: 'Tero', hora: 'lun 10:00' }, [{ nombre: 'Tero', estado: 'trabajando', fin: 'mar 04:00' }]);
  assert.strictEqual(other.rows['Cuándo'].textContent, 'lun 10:00', 'otra hora no se pierde');
  assert.strictEqual(d.rows['Pedido'].tag, 'a');
  assert.strictEqual(d.rows['Pedido'].href, 'https://github.com/o/r/pull/912');
  assert.strictEqual(d.rows['Pedido'].rel, 'noopener');
  // se cierra con la × del panel lateral, que se llama «Cerrar»
  assert.strictEqual(d.last.textContent, '×');
  assert.strictEqual(d.last.className, 'close');
  assert.strictEqual(d.last.attrs && d.last.attrs['aria-label'], 'Cerrar');
  assert.strictEqual(d.last.focused, true);
});

test('T99 Card_Detail_NoSession: sin sesión, su hora y su pedido sin ficha; lo que no tiene no aparece; un sitio desconocido no da enlace', () => {
  const d = cardDetail({ titulo: 'Una fila del tablero', quien: 'Nadie Vivo', hora: 'estaba para lun 10:00', pedido: { numero: 7, sitio: 'constructor', ruta: 'x' } }, [{ nombre: 'Tero', estado: 'trabajando', fin: 'mar 04:00' }]);
  assert.deepStrictEqual(d.fichas, []);
  assert.strictEqual(d.rows['Cuándo'].textContent, 'estaba para lun 10:00');
  assert.strictEqual(d.rows['Pedido'].tag, '#text', 'sin enlace');
  assert.strictEqual(d.rows['Pedido'].textContent, 'Pedido 7');
  assert.deepStrictEqual(Object.keys(d.rows).sort(), ['Cuándo', 'Pedido', 'Quién']);
  assert.strictEqual(cardDetail({ titulo: 'Sin nada' }).box.children.some((k) => k.tag === 'dl'), false, 'sin datos, no hay lista vacía');
});

test('T100 Card_Opens_Everywhere: cada tarjeta del kanban se abre con un click o con el teclado, y seleccionar texto no la abre', () => {
  const html = officePage({ agents: [], items: [], kanban: null, meta: null });
  const board = html.slice(html.indexOf('function renderBoard('), html.indexOf('function renderHalfway('));
  assert.match(board, /el\("div","item abre"\)/);
  assert.match(board, /card\.tabIndex=0;card\.setAttribute\("role","button"\)/);
  assert.match(board, /e\.key==="Enter"\|\|e\.key===" "/);
  assert.match(board, /if\(!String\(window\.getSelection\?getSelection\(\):""\)\)abrirTarjeta\(i,card\)/);
});

test('T101 Wheel_MovesThePage: la rueda sola no llega a la cámara y no se frena; acercar es con ⌘ o Ctrl, el pellizco o los botones', () => {
  const html = officePage({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /Arrastrá para girar · ⌘ o Ctrl más rueda, o pellizco, para acercar · tocá a alguien/);
  assert.doesNotMatch(html, /· rueda para acercar ·/);
  const wheel = html.slice(html.indexOf('stage.addEventListener("wheel"'), html.indexOf('stage.addEventListener("gesturestart"'));
  assert.match(wheel, /^stage\.addEventListener\("wheel",e=>\{if\(e\.target\.closest\("\.panel3"\)\)return;e\.stopPropagation\(\);/, 'el detalle abierto sigue con su rueda');
  assert.match(wheel, /if\(e\.ctrlKey\|\|e\.metaKey\)\{e\.preventDefault\(\);/, 'sólo acercando se frena la página');
  assert.match(wheel, /\{capture:true,passive:false\}/, 'antes de que llegue a los controles');
  assert.equal(wheel.match(/preventDefault/g).length, 1);
  assert.match(html, /\+" \+ rueda para acercar"/);
  assert.match(html, /\["pointerdown","pointermove"\]\.forEach\(ev=>renderer\.domElement/);
  assert.match(html, /<div class="zoom" id="zoom" hidden>/, 'sin 3D no hay botones');
  assert.match(html, /@media \(hover:none\)\{\.zoom\{display:none\}\}/, 'en un teléfono, tampoco');
  assert.match(html, /gesturechange/);
});

test('OfficeServer_PlazoPorVariable @story-8.230 @ac-13: el plazo para esperar al servidor sale de una variable, más amplio que 2 s, y sin respuesta la espera igual falla', async () => {
  // 🔴 mutación: el plazo fijo en 2000 → el caso (a) falla; ignorar la variable → falla el (b).
  assert.strictEqual(plazoDeEspera({}), 8000, '(a) sin la variable, 8 s');
  assert.ok(plazoDeEspera({}) > 2000, '(a) más amplio que los 2 s de antes');
  assert.strictEqual(plazoDeEspera({ TYCON_OFFICE_TEST_WAIT_MS: '300' }), 300, '(b) la variable lo cambia');
  for (const malo of ['', 'x', '0', '-5']) assert.strictEqual(plazoDeEspera({ TYCON_OFFICE_TEST_WAIT_MS: malo }), 8000, `(b) «${malo}» vuelve al de por defecto`);
  // (c) un servidor que acepta la página y no manda nunca una foto: la espera falla con el plazo chico, no cuelga
  const WebSocket = require(VENDOR_WS);
  const mudo = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => mudo.on('listening', r));
  const p = page({ port: mudo.address().port, token: 'x' });
  await p.opened;
  const t0 = Date.now();
  await assert.rejects(p.next(plazoDeEspera({ TYCON_OFFICE_TEST_WAIT_MS: '300' })), /no llegó una foto en 300 ms/);
  assert.ok(Date.now() - t0 < 2000, '(c) falla con su plazo, sin colgarse');
  p.close();
  await new Promise((r) => mudo.close(r));
});

test('T47 Office_LaMarcaDeAusenteSeVe @story-8.221 @ac-36: con la marca puesta, la oficina dice desde qué hora y quién la puso', () => {
  const m = toy();
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-away.js'));
  const foto = () => {
    const r = spawnSync('node', [OFFICE, '--json'], { input: '', env: envOf(m.home), encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.strictEqual(foto().meta.ausente, null, 'sin marca, nada');
  OA.set({ estado: m.sdir, quien: 'coordinadora', frase: 'me voy', ahora: Date.now() });
  const a = foto().meta.ausente;
  assert.ok(a, 'con la marca puesta, la trae');
  assert.strictEqual(a.quien, 'coordinadora');
  assert.match(a.desde, /^\d\d:\d\d$/);
  assert.match(a.linea, /ausente desde las \d\d:\d\d.*coordinadora/);
  OA.clear({ estado: m.sdir, motivo: 'prueba' });
  assert.strictEqual(foto().meta.ausente, null, 'borrada, no la trae');
  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'tools', 'office', 'page.html'), 'utf8');
  assert.match(html, /id="ausente"/, 'la página tiene dónde mostrarla');
});
