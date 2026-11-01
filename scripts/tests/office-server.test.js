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

const started = new Set();
test.after(() => { for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya salió */ } } });

// A toy machine: the state folders the office watches and one live session.
function toy({ withAdhoc = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-live-'));
  const sdir = stateDir(home);
  for (const d of ['active', ...(withAdhoc ? ['adhoc'] : []), 'doing']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', status: 'busy', statusUpdatedAt: Date.now() }));
  return { home, sdir, sessions };
}

const envOf = (home, more = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_TEST: '1', ...more });
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
  const foto = await p.next(2000);
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(foto.data.rows.length, 1);
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
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(m.sdir, 'doing', `n${i}.json`), JSON.stringify({ text: `nota ${i}`, at: new Date().toISOString() }));
  await p.next(2000);
  await sleep(800);
  assert.strictEqual(p.fotos.length, 2, 'una sola foto por la ráfaga');
  fs.writeFileSync(path.join(m.sdir, 'doing', 'n0.json'), fs.readFileSync(path.join(m.sdir, 'doing', 'n0.json')));
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
  const before = await counters(lock);
  await sleep(2500);
  const after = await counters(lock);
  assert.deepStrictEqual([after.reads, after.queries], [before.reads, before.queries]);
  assert.strictEqual(after.intervals, 0, 'ningún reloj que consulte');
  p.close();
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
  assert.ok(foto.data.agents.some((a) => /arreglo de la oficina/.test(a.haciendo || '')), JSON.stringify(foto.data.agents));
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
  fs.writeFileSync(file, `if (process.argv[1] && /office[\\\\/]server\\.js$/.test(process.argv[1])) {
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
  fs.writeFileSync(file, `if (process.argv[1] && /office[\\\\/]server\\.js$/.test(process.argv[1])) {
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
