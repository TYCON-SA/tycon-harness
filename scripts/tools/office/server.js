#!/usr/bin/env node
'use strict';
/*
 * server.js — el proceso local de la oficina viva (el comando /office): vigila las carpetas del arnés y le empuja cada
 * cambio a la página por WebSocket. Lo arranca `office.js --open`, aparte de la terminal, y uno solo por máquina.
 *
 *   node server.js            (lo lanza office.js; no se corre a mano)
 *
 * Escucha sólo en 127.0.0.1, en un puerto que elige el sistema, y todo pedido lleva el token del candado
 * `<estado>/office/server.json` ({pid, port, token, startedAt}, permiso 0600 en una carpeta 0700): el token es la única
 * barrera contra otro usuario de la máquina, porque `Host` y `Origin` los fija cualquier programa que no sea un
 * navegador. El WebSocket de `/live` revisa además `Origin`, así otra página abierta en el mismo navegador no se conecta.
 *
 * Una lectura al arrancar y después sólo cuando cambia algo en las carpetas vigiladas (`fs.watch`, sin consultar cada N
 * segundos): los cambios de 250 ms se juntan, se recalcula la foto y se manda sólo si cambió. Los pedidos de git, Azure
 * DevOps y GitHub se preguntan a lo sumo una vez por minuto. El canal de vuelta está cerrado: un mensaje de la página
 * cierra esa conexión sin leerlo. Se apaga solo a los 2 min sin páginas (el reloj arranca con el proceso) y a las 8 h.
 *
 * La foto, la vigilancia y la conexión de la página son tres partes separadas: conectar este mismo proceso a otro
 * destino cambia sólo la última.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WebSocket = require('./vendor/ws');

const ROOT = path.join(__dirname, '..', '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const DEBOUNCE_MS = 250;
const QUERY_TTL_MS = 60 * 1000;
const MAX_PAYLOAD = 1024;
const BACK_CHANNEL = 'la página mandó un mensaje: el canal de vuelta está cerrado';

const numEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
const officeDirOf = (sdir) => path.join(sdir, 'office');
const lockPathOf = (sdir) => path.join(officeDirOf(sdir), 'server.json');

/**
 * La consulta de pedidos con un recuerdo de `ttlMs` por repo: entre medio se contesta con lo último leído.
 * `readAt()` dice cuándo se preguntó de verdad por última vez (null si nunca).
 */
function cachedQuery(query, { ttlMs = QUERY_TTL_MS, clock = Date.now } = {}) {
  const seen = new Map();
  let lastRead = null;
  const ask = async (wanted) => {
    const now = clock();
    const missing = wanted.filter((q) => !seen.has(q.root) || now - seen.get(q.root).at >= ttlMs);
    if (missing.length) {
      const answers = await query(missing);
      missing.forEach((q, i) => seen.set(q.root, { answer: answers[i], at: now }));
      lastRead = now;
    }
    return wanted.map((q) => seen.get(q.root).answer);
  };
  ask.readAt = () => lastRead;
  return ask;
}

/**
 * Lo que cambia cuando cambia una sesión: sus carpetas, las firmas pendientes (`coordination/`) y quién coordina
 * (`gates.log`).
 */
function watchedDirs(home, sdir) {
  return [path.join(sdir, 'active'), path.join(sdir, 'adhoc'), path.join(sdir, 'doing'), path.join(claudeDir(home), 'sessions'), path.join(sdir, 'sessions'),
    path.join(sdir, 'coordination'), path.join(sdir, 'gates.log')];
}

/**
 * Vigila cada carpeta; la que todavía no existe se espera desde la de arriba, y la que no se puede vigilar se anota en
 * `notes`. Devuelve una función que deja de vigilar.
 */
function watchAll(dirs, onChange, notes) {
  const watchers = [];
  const failOn = process.env.TYCON_OFFICE_TEST === '1' ? process.env.TYCON_OFFICE_WATCH_FAIL : null;
  const note = (dir, e) => notes.push(`no se vigila ${dir}: ${e.message || e}; los cambios ahí llegan al reabrir`);
  const watchDir = (dir) => {
    try {
      if (failOn && path.basename(dir) === failOn) throw new Error('falla de prueba');
      const w = fs.watch(dir, () => onChange());
      w.on('error', (e) => { note(dir, e); try { w.close(); } catch { /* ya cerrado */ } onChange(); });
      watchers.push(w);
    } catch (e) { note(dir, e); }
  };
  for (const dir of dirs) {
    if (fs.existsSync(dir)) { watchDir(dir); continue; }
    const parent = path.dirname(dir);
    try {
      const w = fs.watch(parent, (ev, name) => {
        if (name && name !== path.basename(dir)) return;
        if (!fs.existsSync(dir)) return;
        try { w.close(); } catch { /* ya cerrado */ }
        watchDir(dir);
        onChange();
      });
      w.on('error', (e) => { note(dir, e); onChange(); });
      watchers.push(w);
    } catch (e) { note(dir, e); }
  }
  return () => { for (const w of watchers) { try { w.close(); } catch { /* ya cerrado */ } } };
}

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

async function serve() {
  const office = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const { queryAll } = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  const home = os.homedir();
  const sdir = stateDir(home);
  const dir = officeDirOf(sdir);
  const lockFile = lockPathOf(sdir);
  const testing = process.env.TYCON_OFFICE_TEST === '1';
  const token = crypto.randomBytes(16).toString('hex');
  const counters = { reads: 0, sends: 0, queries: 0, intervals: 0 };
  // en las pruebas, cada reloj que repite queda contado: el proceso no consulta cada tanto
  if (testing) {
    const every = global.setInterval;
    global.setInterval = (...a) => { counters.intervals += 1; return every(...a); };
  }
  const notes = [];
  const query = cachedQuery(async (wanted) => { counters.queries += 1; return queryAll(wanted); });
  // la dirección del sitio se lee una vez, al arrancar: no cambia mientras la página está abierta
  const site = office.readSiteUrl();
  const siteUrl = async () => site;
  // el umbral de la sesión callada, también una vez: la página lo usa con su propio reloj
  const quiet = office.readQuietMinutes();
  const quietMinutes = async () => quiet;

  // la foto: lo mismo que la foto fija, más lo que este proceso no pudo hacer
  const snapshot = async () => {
    counters.reads += 1;
    const data = await office.collect({ home, queryAll: query, siteUrl, quietMinutes });
    data.unreadable.push(...notes);
    const readAt = query.readAt();
    if (readAt != null) data.meta.pedidosLeidos = hhmm(readAt);
    return data;
  };
  // la primera foto se arma después de escuchar y vigilar: el proceso contesta enseguida, y un cambio que llega
  // mientras se arma no se pierde. La página y el WebSocket la esperan.
  let last = null;
  let lastJson = null;
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });

  const clients = new Set();
  let idle = null;
  let cap = null;
  let done = false;
  const broadcast = () => {
    const msg = JSON.stringify({ type: 'foto', data: last });
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    counters.sends += 1;
  };
  let pending = null;
  let running = false;
  let again = false;
  const recompute = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const data = await snapshot();
      const json = JSON.stringify(data);
      if (json !== lastJson) { last = data; lastJson = json; broadcast(); }
    } catch (e) {
      // la página se entera con la foto que tiene, más el aviso (uno solo); la próxima foto buena lo saca
      const failed = 'la foto no se pudo recalcular';
      // queda también en el registro del proceso: sin páginas abiertas, nadie más se entera
      process.stderr.write(`${new Date().toISOString()} ${failed}: ${e && e.stack ? e.stack : e}\n`);
      if (last) {
        const shown = { ...last, unreadable: [...(last.unreadable || []).filter((u) => !u.startsWith(failed)), `${failed}: ${e.message}`] };
        const json = JSON.stringify(shown);
        if (json !== lastJson) { last = shown; lastJson = json; broadcast(); }
      }
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
  };
  const schedule = () => { clearTimeout(pending); pending = setTimeout(recompute, DEBOUNCE_MS); };
  const noteOnce = (text) => { if (!notes.includes(text)) notes.push(text); schedule(); };

  const okHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const okOrigin = (o) => o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOf = (url) => url.searchParams.get('t') || '';
  const okToken = (url) => {
    const t = Buffer.from(tokenOf(url));
    const want = Buffer.from(token);
    return t.length === want.length && crypto.timingSafeEqual(t, want);
  };
  const urlOf = (req) => { try { return new URL(req.url, 'http://127.0.0.1'); } catch { return null; } };
  const deny = (res) => { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('403'); };

  const server = http.createServer((req, res) => {
    const url = urlOf(req);
    if (!url || !okHost(req.headers.host) || !okToken(url)) { deny(res); return; }
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/') {
      ready.then(() => send('text/html; charset=utf-8', office.page(last, { live: { token } }))).catch((e) => {
        noteOnce(`la página no se pudo armar: ${e.message}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('la página no se pudo armar');
      });
      return;
    }
    if (url.pathname === '/health') { send('application/json', JSON.stringify({ pid: process.pid, address: server.address().address })); return; }
    if (url.pathname.startsWith('/modules/')) {
      let key = null;
      try { key = decodeURIComponent(url.pathname.slice('/modules/'.length)); } catch { /* un % roto no es ningún módulo: 404 abajo */ }
      // sólo las claves propias de la lista: `constructor` o `toString` no son módulos
      const rel = key != null && Object.prototype.hasOwnProperty.call(office.MODULES, key) ? office.MODULES[key] : null;
      if (!rel) { res.writeHead(404); res.end(); return; }
      send('text/javascript; charset=utf-8', office.moduleSource(key, rel));
      return;
    }
    if (testing && url.pathname === '/debug/counters') { send('application/json', JSON.stringify(counters)); return; }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  server.on('upgrade', (req, socket, head) => {
    const url = urlOf(req);
    if (!url || url.pathname !== '/live' || !okHost(req.headers.host) || !okOrigin(req.headers.origin) || !okToken(url)) {
      // tras el upgrade el socket ya no tiene el manejador de errores del servidor: un corte de golpe del otro lado
      // tiraría el proceso. Se le pone uno y se cierra del todo
      socket.on('error', () => { /* el que pidió cortó: no hay nada que contestarle */ });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroySoon();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      clearTimeout(idle);
      // el canal de vuelta está cerrado: un mensaje cierra la conexión sin leerse
      ws.on('message', () => { ws.close(1008, 'el canal de vuelta está cerrado'); noteOnce(BACK_CHANNEL); });
      // un mensaje de más de 1 KB lo corta la librería sola, con 1009, antes de leerlo
      // sólo el corte por tamaño es un mensaje de la página; un corte de red no lo es (lo dice el `close`)
      ws.on('error', (e) => { if (e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') noteOnce(BACK_CHANNEL); });
      ws.on('close', () => { clients.delete(ws); if (!clients.size) armIdle(); });
      ready.then(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'foto', data: last })); })
        .catch((e) => { noteOnce(`una página no recibió la foto: ${e.message}`); try { ws.close(1011, 'sin foto'); } catch { /* ya cerrada */ } });
    });
  });

  let port = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;

  // el candado: carpeta y archivo sólo para su dueño; se escribe entero y después se renombra
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${lockFile}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }));
  fs.closeSync(fd);
  fs.renameSync(tmp, lockFile);
  if (testing) fs.appendFileSync(path.join(dir, 'starts.log'), `${process.pid}\n`);

  const unwatch = watchAll(watchedDirs(home, sdir), schedule, notes);

  // el apagado, los dos relojes y las señales se arman antes de la primera foto: una foto que se cuelga no deja el
  // proceso vivo para siempre, y una señal mientras se arma borra el candado igual
  const shutdown = () => {
    if (done) return;
    done = true;
    clearTimeout(idle); clearTimeout(cap); clearTimeout(pending);
    unwatch();
    for (const c of clients) { try { c.close(1001, 'la oficina se cerró'); } catch { /* ya cerrada */ } }
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock && lock.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* sin candado o de otro: no se toca */ }
    server.close();
    setTimeout(() => process.exit(0), 150).unref();
  };
  function armIdle() { clearTimeout(idle); idle = setTimeout(shutdown, numEnv('TYCON_OFFICE_IDLE_MS', 2 * 60 * 1000)); }
  if (!clients.size) armIdle();
  cap = setTimeout(shutdown, numEnv('TYCON_OFFICE_MAX_MS', 8 * 60 * 60 * 1000));
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, shutdown);

  // mientras se arma la primera foto, un cambio deja pedida otra (`again`): se calcula apenas termina
  running = true;
  try {
    last = await snapshot();
    lastJson = JSON.stringify(last);
  } catch (e) {
    unwatch();
    // el candado se borra sólo si es el de este proceso: otro arranque pudo haberlo escrito encima
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock && lock.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* sin candado o de otro: no se toca */ }
    throw e;
  } finally {
    running = false;
  }
  markReady();
  if (again) { again = false; schedule(); }
}

if (require.main === module) {
  serve().catch((e) => {
    process.stderr.write(`no arrancó: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}

module.exports = { cachedQuery, watchedDirs, watchAll, lockPathOf, officeDirOf };
