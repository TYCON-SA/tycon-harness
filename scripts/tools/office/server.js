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
 * DevOps y GitHub se preguntan a lo sumo una vez por minuto. La lectura de los pedidos abiertos, que deja
 * stuck-pr-notice.js, se renueva cada 3 minutos si nadie lo hizo antes, y sólo con una página conectada: son cinco listados
 * en unos 3 s. El canal de vuelta está cerrado: un mensaje de la página
 * cierra esa conexión sin leerlo. Se apaga solo a los 2 min sin páginas (el reloj arranca con el proceso) y a las 8 h.
 *
 * `/conversacion?s=<nombre>` contesta los últimos mensajes de una persona de la oficina, y se lee sólo cuando alguien la
 * toca. Ese texto no entra en la foto: lo que se conecte a la foto no lo recibe.
 *
 * La foto se arma en un hilo aparte, porque lanza git y lee muchos archivos sin soltar el hilo: acá adentro, la página y los
 * vigilantes siguen contestando mientras tanto. Ese hilo recuerda de una foto a la otra lo que no cambió (`createMemory`).
 * Los archivos sin guardar de «A medio camino» se leen al abrir la oficina, al cerrarse una sesión y cada 15 minutos con una
 * página abierta; con la página cerrada, nunca.
 *
 * Quien cambia el estado de una sesión (el marcador del pipeline, la ventana del dueño) lo avisa por `POST /event`
 * (scripts/lib/office-event.js), con el mismo token: la foto se recalcula enseguida y una vez más al segundo, porque la
 * ventana del dueño avisa antes de que la herramienta escriba el estado de la sesión. La vigilancia queda de respaldo
 * para lo que no avisa o se escribe más tarde.
 *
 * La foto, la vigilancia y la conexión de la página son tres partes separadas. Con `site.url` en el perfil, cada foto nueva
 * sale también al sitio de la organización (office/site-link.js), y el proceso vive con las sesiones: se apaga tras 10 min
 * sin sesiones vivas ni páginas, con un tope de 12 h. Una sesión que muere sin avisar se ve en un repaso cada 30 s, que
 * existe sólo en este modo. La dirección se relee con el aviso de una sesión nueva (`session`) o de la capa del equipo nueva
 * (`config`): el proceso vivo se enlaza, cambia de sitio o se desenlaza sin reiniciarse. Con un sitio que la entiende, la
 * conversación de cada sesión sale también, en su propio mensaje (`forSite` decide qué sale).
 *
 * Hay uno por máquina. Al arrancar, si el candado es de otro proceso que contesta, éste se va sin escuchar ni tocarlo. Y un
 * proceso que ve otro candado encima del suyo (quedó congelado más que el plazo del que arrancaba) se apaga.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const WebSocket = require('./vendor/ws');
const { createLink, linkedSite, lockOwner, appendLog, OWNER_WAIT_MS } = require('./site-link.js');
const topics = require('./topics.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const DEBOUNCE_MS = 250;
const QUERY_TTL_MS = 60 * 1000;
const PR_PHOTO_MS = 3 * 60 * 1000;
const TOPICS_MS = 60 * 1000;
const HALFWAY_MS = 15 * 60 * 1000;
const HALFWAY_OPEN_FRESH_MS = 60 * 1000;
const MAX_PAYLOAD = 1024;
const MAX_EVENT_BYTES = 256;
const EVENT_TYPES = ['changed', 'session', 'config'];
const SESSION_CHECK_MS = 30 * 1000;
const EVENT_SETTLE_MS = 1000;
const BACK_CHANNEL = 'la página mandó un mensaje: el canal de vuelta está cerrado';

const numEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
const officeDirOf = (sdir) => path.join(sdir, 'office');
const lockPathOf = (sdir) => path.join(officeDirOf(sdir), 'server.json');
/** Cuánto vive el proceso: con el sitio, lo que duran las sesiones; sin él, lo que dura la página abierta. */
const lifeLimits = (linked) => (linked ? { idleMs: 10 * 60 * 1000, capMs: 12 * 3600 * 1000 } : { idleMs: 2 * 60 * 1000, capMs: 8 * 3600 * 1000 });

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
  return [path.join(sdir, 'active'), path.join(sdir, 'adhoc'), path.join(sdir, 'doing'), path.join(sdir, 'parked'), path.join(claudeDir(home), 'sessions'), path.join(sdir, 'sessions'),
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

/** Lo que dice el candado; null sin candado o con uno ilegible. */
function readLockFile(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
}

/**
 * Lo que de la conversación de una sesión sale al sitio. Hoy, todo lo que muestra la oficina local; acá se saca lo que no
 * tiene que salir (los mensajes escritos desde la oficina, cuando existan).
 */
function forSite(conversation) {
  return conversation;
}

/**
 * Las conversaciones que cambiaron desde la última vez, por el nombre de su sesión: sólo de las que su archivo creció, y a
 * lo sumo una lectura por minuto por sesión, porque la de la coordinadora lee hasta 64 MB. Se olvida de las que se fueron.
 * Una lectura que falla no cuenta como hecha: se reintenta en la foto siguiente, y su motivo va a `failed`.
 */
function changedTalks(office, envelopes, talked, now = Date.now(), failed = []) {
  const { CHARLA_EVERY_MS } = require('./fields.js');
  const out = {};
  for (const name of talked.keys()) if (!envelopes.files.has(name)) talked.delete(name);
  for (const [name, e] of envelopes.files) {
    let size;
    try { size = fs.statSync(e.file).size; } catch { continue; }
    const seen = talked.get(name);
    if (seen && (seen.size === size || now - seen.at < CHARLA_EVERY_MS)) continue;
    let said = null;
    try { said = office.conversationOf(envelopes, name); } catch (err) { failed.push(`no se pudo leer la conversación de una sesión (${err.code || err.message}): se reintenta`); continue; }
    if (!said) continue;
    talked.set(name, { size, at: now });
    out[name] = forSite(said);
  }
  return out;
}

// El hilo de la foto: arma una por cada mensaje y contesta con ella, con lo que el proceso necesita para leer una
// conversación y con cuánto consultó. Lo que recuerda de una foto a la otra vive sólo acá.
function photoThread() {
  const office = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const { queryAll, readPrs, createMemory, reviseHalfway } = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  const home = os.homedir();
  const counted = { queries: 0, intervals: 0 };
  if (process.env.TYCON_OFFICE_TEST === '1') {
    const every = global.setInterval;
    global.setInterval = (...a) => { counted.intervals += 1; return every(...a); };
  }
  const query = cachedQuery(async (wanted) => { counted.queries += 1; return queryAll(wanted); });
  // los pedidos que nombra el tablero, con el mismo recuerdo de un minuto
  const queryPrs = cachedQuery(async (wanted) => { counted.queries += 1; return readPrs(wanted); });
  const memory = createMemory();
  // hasta dónde se leyó cada conversación y a quién corresponde cada nombre
  const envelopes = office.createEnvelopes();
  // la dirección del sitio y el umbral de la sesión callada se leen una vez, y otra vez cuando el proceso relee la dirección
  let once = null;
  // de cada conversación, hasta dónde creció cuando se leyó y a qué hora: una que no creció, o leída hace menos de un minuto, no se lee
  const talked = new Map();
  parentPort.on('message', async ({ revise, pageOpen, reread, charlas }) => {
    try {
      memory.pageOpen = pageOpen;
      if (revise) reviseHalfway(memory);
      if (!once || reread) once = { site: office.readSiteUrl(), quiet: office.readQuietMinutes() };
      // con otro sitio, todas las conversaciones salen de nuevo: el sitio nuevo no recibió ninguna
      if (reread) talked.clear();
      // este proceso tiene el candado de la oficina de la máquina: él mueve el tablero con los hechos de cada foto
      const data = await office.collect({ home, queryAll: query, queryPrs, siteUrl: async () => once.site, quietMinutes: async () => once.quiet, envelopes, memory, syncBoard: true });
      const charlaFailures = [];
      const said = charlas ? changedTalks(office, envelopes, talked, Date.now(), charlaFailures) : null;
      parentPort.postMessage({ data, files: [...envelopes.files], coordinator: envelopes.coordinator, readAt: query.readAt(), halfwayReadAt: memory.halfwayReadAt, counted, charlas: said, charlaFailures });
    } catch (e) {
      parentPort.postMessage({ error: e && e.message ? e.message : String(e), stack: e && e.stack });
    }
  });
}

// Le pide una foto al hilo. Si el hilo se cae, esa foto falla y la próxima arranca otro, sin lo que recordaba.
function photoAsker() {
  let worker = null;
  let waiting = null;
  const settle = (fn, value) => { const w = waiting; waiting = null; if (w) w[fn](value); };
  const start = () => {
    const w = new Worker(__filename, { workerData: { officePhoto: true } });
    const gone = (e) => { if (worker === w) worker = null; settle('reject', e); };
    w.on('message', (m) => {
      if (!m.error) { settle('resolve', m); return; }
      settle('reject', Object.assign(new Error(m.error), m.stack ? { stack: m.stack } : {}));
    });
    w.on('error', gone);
    w.on('exit', () => gone(new Error('el hilo de la foto se cerró')));
    return w;
  };
  return (request) => new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    if (!worker) worker = start();
    worker.postMessage(request);
  });
}

async function serve() {
  const home = os.homedir();
  const sdir = stateDir(home);
  const dir = officeDirOf(sdir);
  const lockFile = lockPathOf(sdir);
  const holder = readLockFile(lockFile);
  if (holder && holder.pid !== process.pid && await lockOwner(holder, numEnv('TYCON_OFFICE_OWNER_WAIT_MS', OWNER_WAIT_MS)) === 'office') {
    process.stderr.write(`${new Date().toISOString()} otra oficina está viva (pid ${holder.pid}): este proceso se va sin tocar el candado\n`);
    releaseStarting();
    return;
  }
  const office = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const { sessionsBySid } = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  const testing = process.env.TYCON_OFFICE_TEST === '1';
  const token = crypto.randomBytes(16).toString('hex');
  const counters = { reads: 0, sends: 0, intervals: 0, prRefreshes: 0, topicRuns: 0 };
  // en las pruebas, cada reloj que repite queda contado: el proceso no consulta cada tanto
  if (testing) {
    const every = global.setInterval;
    global.setInterval = (...a) => { counters.intervals += 1; return every(...a); };
  }
  const notes = [];
  const askPhoto = photoAsker();
  // «A medio camino» se revisa al abrir la oficina, al cerrarse una sesión (lo ve el hilo) y cada tanto con la página abierta
  let reviseNext = false;
  let halfwayReadAt = null;
  // a quién corresponde cada nombre, según la última foto: vive sólo en este proceso
  const envelopes = { files: new Map(), coordinator: null };
  let threadCounted = { queries: 0, intervals: 0 };
  // el enlace al sitio se decide al arrancar, y otra vez con el aviso de una sesión nueva o de la capa del equipo nueva
  // (`relink`, más abajo): la dirección puede llegar o cambiar con el proceso vivo
  const startedAt = Date.now();
  let siteAddress = linkedSite(office.readSiteUrl());
  // con un sitio que entiende la conversación, la próxima foto la lee: si no, esperaría al próximo cambio
  const charlaReady = () => schedule();
  let link = siteAddress ? createLink({ site: siteAddress, sdir, home, onCharlaReady: charlaReady }) : null;
  let limits = lifeLimits(Boolean(link));
  let rereadNext = false;
  let pendingCharlas = null;
  const deliverCharlas = () => {
    const charlas = pendingCharlas;
    pendingCharlas = null;
    if (charlas && link) for (const [name, said] of Object.entries(charlas)) link.charla(name, said);
  };
  // las mismas sesiones que cuenta /wip: vivas, sin los agentes internos de otras sesiones
  const liveSessions = () => [...sessionsBySid(path.join(claudeDir(home), 'sessions'), [], path.join(claudeDir(home), 'projects'))]
    .filter(([, s]) => s.alive && !s.internal).map(([sid]) => sid).sort();

  // la foto: lo mismo que la foto fija, más lo que este proceso no pudo hacer
  const snapshot = async () => {
    counters.reads += 1;
    const request = { revise: reviseNext, pageOpen: clients.size > 0, reread: rereadNext, charlas: Boolean(link && link.takesCharla()) };
    reviseNext = false;
    rereadNext = false;
    const { data, files, coordinator, readAt, halfwayReadAt: halfwayAt, counted, charlas, charlaFailures } = await askPhoto(request);
    // salen después de la foto (`deliverCharlas`): el sitio no guarda la conversación de una sesión que su foto no nombra
    pendingCharlas = charlas;
    if (link) link.keepTalks(files.map(([name]) => name));
    for (const failure of new Set(charlaFailures || [])) appendLog(sdir, failure);
    halfwayReadAt = halfwayAt;
    envelopes.files = new Map(files);
    envelopes.coordinator = coordinator;
    threadCounted = counted;
    data.unreadable.push(...notes);
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
    if (link) link.update(last);
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
      deliverCharlas();
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
      if (lockLost()) shutdown();
      if (again && !done) { again = false; schedule(); }
      if (link && !done) reviewLife();
    }
  };
  const schedule = () => { clearTimeout(pending); pending = setTimeout(recompute, DEBOUNCE_MS); };
  const noteOnce = (text) => { if (!notes.includes(text)) notes.push(text); schedule(); };

  // la lectura de los pedidos abiertos, al día mientras alguien mira: en las pruebas sólo corre el guion que ellas le den
  const prRefresher = testing ? process.env.TYCON_OFFICE_PR_REFRESH : path.join(ROOT, 'scripts', 'hooks', 'stuck-pr-notice.js');
  const prEveryMs = numEnv('TYCON_OFFICE_PR_PHOTO_MS', PR_PHOTO_MS);
  let prTimer = null;
  let prRunning = false;
  const prPhotoAge = () => { try { return Date.now() - fs.statSync(path.join(sdir, 'stuck-prs-photo.json')).mtimeMs; } catch { return Infinity; } };
  const refreshPrPhoto = () => {
    if (prRunning || !prRefresher || process.env.TYCON_STUCK_PR_NOTICE === '0') return;
    prRunning = true;
    counters.prRefreshes += 1;
    const child = spawn(process.execPath, [prRefresher, '--refresh', path.resolve(process.env.TYCON_TREE || ROOT)], { stdio: 'ignore', windowsHide: true, timeout: 2 * 60 * 1000 });
    child.on('error', (e) => { prRunning = false; noteOnce(`los pedidos abiertos no se pudieron leer: ${e.message}`); });
    child.on('exit', () => { prRunning = false; schedule(); });
    child.unref();
  };
  const prTick = () => {
    if (!clients.size) { prTimer = null; return; }
    const age = prPhotoAge();
    if (age >= prEveryMs) refreshPrPhoto();
    prTimer = setTimeout(prTick, age >= prEveryMs ? prEveryMs : prEveryMs - age);
    prTimer.unref();
  };

  // el tema de los trabajos nuevos, de fondo y a lo sumo una vez por minuto: armar la foto no espera al modelo. Sólo con una
  // página conectada, trabajos por clasificar y pasado el plazo que dejó la última vez. En las pruebas sólo corre el guion que le den
  const topicsRunner = testing ? process.env.TYCON_OFFICE_TOPICS_RUN : path.join(__dirname, 'topics.js');
  const topicsEveryMs = numEnv('TYCON_OFFICE_TOPICS_MS', TOPICS_MS);
  let topicsTimer = null;
  let topicsRunning = false;
  let topicsHoldUntil = 0;
  // un proceso caído no dejó su plazo: sin esta espera se relanzaría cada minuto, y puede haber gastado modelo antes de caerse
  const topicsFailed = (why) => {
    topicsRunning = false;
    topicsHoldUntil = Date.now() + topics.BACKOFF_MS;
    noteOnce(`los temas no se pudieron clasificar: ${why}`);
  };
  const topicsDue = () => {
    if (Date.now() < topicsHoldUntil) return false;
    const { temas } = topics.readTopics(sdir);
    const { nextAt, sinModelo } = topics.readState(sdir).state;
    // sin nada que clasificar sólo hace falta mirar si el modelo volvió
    if (!sinModelo && !topics.readPending(sdir).some((w) => w && w.clave && !temas[w.clave])) return false;
    return !(Number.isFinite(nextAt) && Date.now() < nextAt);
  };
  const runTopics = () => {
    if (topicsRunning || !topicsRunner || !topicsDue()) return;
    topicsRunning = true;
    counters.topicRuns += 1;
    const child = spawn(process.execPath, [topicsRunner, '--classify'], { stdio: 'ignore', windowsHide: true, timeout: 2 * 60 * 1000 });
    child.on('error', (e) => topicsFailed(e.message));
    child.on('exit', (code, signal) => {
      if (code !== 0) { topicsFailed(`el proceso terminó con ${signal || `el código ${code}`}`); return; }
      topicsRunning = false;
      schedule();
    });
    child.unref();
  };
  const topicsTick = () => {
    if (!clients.size) { topicsTimer = null; return; }
    runTopics();
    topicsTimer = setTimeout(topicsTick, topicsEveryMs);
    topicsTimer.unref();
  };

  const halfwayEveryMs = numEnv('TYCON_OFFICE_HALFWAY_MS', HALFWAY_MS);
  let halfwayTimer = null;
  const reviseHalfwaySoon = () => { reviseNext = true; schedule(); };
  const halfwayTick = () => {
    reviseHalfwaySoon();
    halfwayTimer = setTimeout(halfwayTick, halfwayEveryMs);
    halfwayTimer.unref();
  };
  // la primera página de un proceso que recién leyó no vuelve a pedir lo mismo
  const halfwayOnOpen = () => {
    if (halfwayTimer) return;
    if (halfwayReadAt != null && Date.now() - halfwayReadAt >= numEnv('TYCON_OFFICE_HALFWAY_FRESH_MS', HALFWAY_OPEN_FRESH_MS)) reviseHalfwaySoon();
    halfwayTimer = setTimeout(halfwayTick, halfwayEveryMs);
    halfwayTimer.unref();
  };

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

  // el aviso de quien cambió algo: sólo dispara un recálculo, nada de lo que trae se usa
  let settle = null;
  const onEvent = (req, res) => {
    const answer = (code) => { res.writeHead(code, { 'cache-control': 'no-store' }); res.end(); };
    if (req.method !== 'POST') { req.resume(); answer(405); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size <= MAX_EVENT_BYTES) chunks.push(d); });
    req.on('error', () => { /* el que avisó cortó */ });
    req.on('end', () => {
      if (size > MAX_EVENT_BYTES) { answer(413); return; }
      let type = null;
      try { ({ type } = JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* abajo: sin tipo */ }
      if (!EVENT_TYPES.includes(type)) { answer(400); return; }
      answer(204);
      if (type === 'session' || type === 'config') relink(type);
      schedule();
      clearTimeout(settle);
      settle = setTimeout(schedule, EVENT_SETTLE_MS);
    });
  };

  const server = http.createServer((req, res) => {
    const url = urlOf(req);
    if (!url || !okHost(req.headers.host) || !okToken(url)) { deny(res); return; }
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/event') { onEvent(req, res); return; }
    if (url.pathname === '/') {
      ready.then(() => send('text/html; charset=utf-8', office.page(last, { live: { token } }))).catch((e) => {
        noteOnce(`la página no se pudo armar: ${e.message}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('la página no se pudo armar');
      });
      return;
    }
    if (url.pathname === '/page.js') { send('text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, 'page.js'))); return; }
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
    // sólo se lee al tocar a una persona, y sólo una que está en la oficina: el nombre es una clave, nunca una ruta
    if (url.pathname === '/conversacion') {
      ready.then(() => {
        const said = office.conversationOf(envelopes, url.searchParams.get('s') || '');
        if (!said) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
        send('application/json; charset=utf-8', JSON.stringify(said));
      }).catch((e) => {
        process.stderr.write(`${new Date().toISOString()} la conversación no se pudo leer: ${e && e.code ? e.code : 'error'}\n`);
        if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' });
        res.end();
      });
      return;
    }
    if (testing && url.pathname === '/debug/counters') { send('application/json', JSON.stringify({ ...counters, queries: threadCounted.queries, intervals: counters.intervals + threadCounted.intervals, linked: { site: siteAddress, idleMs: limits.idleMs, capMs: limits.capMs } })); return; }
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
      reviewLife();
      if (!prTimer) prTick();
      if (!topicsTimer) topicsTick();
      halfwayOnOpen();
      // el canal de vuelta está cerrado: un mensaje cierra la conexión sin leerse
      ws.on('message', () => { ws.close(1008, 'el canal de vuelta está cerrado'); noteOnce(BACK_CHANNEL); });
      // un mensaje de más de 1 KB lo corta la librería sola, con 1009, antes de leerlo
      // sólo el corte por tamaño es un mensaje de la página; un corte de red no lo es (lo dice el `close`)
      ws.on('error', (e) => { if (e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') noteOnce(BACK_CHANNEL); });
      ws.on('close', () => { clients.delete(ws); reviewLife(); if (!clients.size) { clearTimeout(prTimer); prTimer = null; clearTimeout(topicsTimer); topicsTimer = null; clearTimeout(halfwayTimer); halfwayTimer = null; } });
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
  releaseStarting();
  if (testing) fs.appendFileSync(path.join(dir, 'starts.log'), `${process.pid}\n`);

  const unwatch = testing && process.env.TYCON_OFFICE_NO_WATCH === '1' ? () => {} : watchAll(watchedDirs(home, sdir), schedule, notes);

  // el apagado, los dos relojes y las señales se arman antes de la primera foto: una foto que se cuelga no deja el
  // proceso vivo para siempre, y una señal mientras se arma borra el candado igual
  let sessionCheck = null;
  function shutdown() {
    if (done) return;
    done = true;
    clearTimeout(idle); clearTimeout(cap); clearTimeout(pending); clearTimeout(settle); clearTimeout(prTimer); clearTimeout(topicsTimer); clearTimeout(halfwayTimer); clearInterval(sessionCheck);
    unwatch();
    if (link) link.stop();
    for (const c of clients) { try { c.close(1001, 'la oficina se cerró'); } catch { /* ya cerrada */ } }
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock && lock.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* sin candado o de otro: no se toca */ }
    server.close();
    setTimeout(() => process.exit(0), 150).unref();
  }
  // otro proceso escribió su candado encima: sigue uno solo, y es el otro
  function lockLost() {
    const lock = readLockFile(lockFile);
    return Boolean(lock) && lock.pid !== process.pid;
  }
  // con páginas (o, con el sitio, con sesiones vivas) no corre el reloj de apagado; sin nada, arranca una sola vez
  function reviewLife() {
    if (clients.size || (link && liveSessions().length)) { clearTimeout(idle); idle = null; return; }
    if (idle == null) idle = setTimeout(shutdown, numEnv('TYCON_OFFICE_IDLE_MS', limits.idleMs));
  }
  // con el sitio, una sesión que muere no toca ninguna carpeta: el repaso la ve
  function watchSessions() {
    let seen = liveSessions().join('\n');
    sessionCheck = setInterval(() => {
      if (lockLost()) { shutdown(); return; }
      const now = liveSessions().join('\n');
      if (now !== seen) { seen = now; schedule(); }
      reviewLife();
    }, numEnv('TYCON_OFFICE_SESSION_CHECK_MS', SESSION_CHECK_MS));
  }
  // el tope cuenta desde que arrancó el proceso, con los límites del enlace de ahora
  const armCap = () => { clearTimeout(cap); cap = setTimeout(shutdown, Math.max(0, numEnv('TYCON_OFFICE_MAX_MS', limits.capMs) - (Date.now() - startedAt))); };
  /**
   * Vuelve a decidir el enlace con la dirección de ahora: aparecida, se enlaza y vive con las sesiones; cambiada, corta el
   * enlace viejo (aunque esté a mitad del saludo) y abre otro; ida, corta y vuelve a la vida de la oficina local. Con la
   * configuración ilegible el enlace queda como estaba.
   */
  function relink(type) {
    const read = office.readSiteUrl();
    if (read.code !== 0 && read.code !== 3) {
      appendLog(sdir, `no se pudo leer la dirección del sitio (${String(read.out || '').trim().split('\n')[0].slice(0, 160) || `salió ${read.code}`}): el enlace queda como estaba`);
      return;
    }
    const next = linkedSite(read);
    if (next === siteAddress) { if (type === 'session' && link) link.wake(); return; }
    if (link) link.stop();
    siteAddress = next;
    link = next ? createLink({ site: next, sdir, home, onCharlaReady: charlaReady }) : null;
    limits = lifeLimits(Boolean(link));
    appendLog(sdir, link ? `el proceso de la oficina se enlazó con ${next}, sin reiniciarse` : 'el proceso de la oficina dejó el sitio: vuelve a vivir con la página local');
    if (link && !sessionCheck) watchSessions();
    if (!link && sessionCheck) { clearInterval(sessionCheck); sessionCheck = null; }
    clearTimeout(idle); idle = null;
    armCap();
    reviewLife();
    // la foto que sigue relee la dirección (`meta.sitio`) y sale entera, aunque lo demás no haya cambiado: el sitio nuevo
    // no recibe la vieja, que nombra al otro. Antes de la primera foto, el enlace lo arranca el arranque
    rereadNext = true;
    lastJson = null;
    if (link && last) link.start();
  }
  reviewLife();
  armCap();
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, shutdown);
  if (link) watchSessions();

  // mientras se arma la primera foto, un cambio deja pedida otra (`again`): se calcula apenas termina
  running = true;
  try {
    last = await snapshot();
    lastJson = JSON.stringify(last);
  } catch (e) {
    unwatch();
    // el candado se borra sólo si es el de este proceso: otro arranque pudo haberlo escrito encima
    if (!lockLost()) { try { fs.unlinkSync(lockFile); } catch { /* sin candado: no se toca */ } }
    throw e;
  } finally {
    running = false;
  }
  markReady();
  if (lockLost()) { shutdown(); return; }
  if (link) { link.update(last); link.start(); }
  if (again) { again = false; schedule(); }
}

/** Suelta el candado de arranque si lo tomó quien lanzó este proceso sin esperarlo (el gancho de la sesión). */
function releaseStarting() {
  if (process.env.TYCON_OFFICE_RELEASE_STARTING !== '1') return;
  try { fs.rmSync(path.join(officeDirOf(stateDir(os.homedir())), 'server.starting'), { force: true }); } catch { /* vence solo */ }
}

if (!isMainThread && workerData && workerData.officePhoto) photoThread();
else if (require.main === module) {
  serve().catch((e) => {
    releaseStarting();
    process.stderr.write(`no arrancó: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}

module.exports = { cachedQuery, watchedDirs, watchAll, lockPathOf, officeDirOf, lifeLimits, forSite, changedTalks };
