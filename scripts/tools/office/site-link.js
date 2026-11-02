'use strict';
/*
 * site-link.js — la salida al sitio de la organización del proceso de la oficina: la llave de la máquina, el pedido de
 * alta y la conexión que le manda la foto.
 *
 * La máquina sale al sitio (`wss://<sitio>/live/machine`) y nada entra a la máquina. La llave vive en
 * `<estado>/office/site-key.json`, con permiso 0600 en una carpeta 0700: la privada no sale nunca. Al sitio van la pública
 * y su huella, y en cada conexión una firma del desafío que manda.
 *
 * Qué pasó con la llave, en `<estado>/office/site-key-state.json`:
 *   nueva        armada, sin pedido hecho: el gancho de la próxima sesión lo pide
 *   pedida       el sitio recibió el pedido
 *   pendiente    el sitio contestó 4401: espera la aprobación. Cada intento firmado renueva el pedido
 *   aprobada     el sitio aceptó la firma
 *   de-baja      el sitio contestó 4403: no se pide el alta ni se reintenta; cada sesión nueva prueba una vez, para volver
 *                si quien mantiene la reactivó
 *   desconocida  el sitio contestó 4404: la próxima sesión arma una clave nueva y vuelve a pedir
 *
 * El canal de vuelta está cerrado: de un mensaje del sitio se lee sólo `type` (y `nonce`, del desafío). Cualquier otro tipo
 * se descarta sin leer el resto, cierra la conexión con 1008 y queda anotado en `<estado>/office/site-link.log`.
 *
 * Casos: scripts/tests/office-site-link.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { MAX_MESSAGE_BYTES, CLOSE, MESSAGES, signedText, validNonce, machineUrl, fingerprintOf, displayFingerprint, pick } = require('./fields.js');

const HEARTBEAT_MS = 60 * 1000;
const RETRY_MIN_MS = 2 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const HANDSHAKE_MS = 10 * 1000;
// del upgrade al `ack`: los 10 s del upgrade más los 5 s que el sitio le da a un saludo sin firma
const GREETING_MS = 15 * 1000;
// lo más largo que el sitio tiene para decirle a la máquina es el desafío
const INBOUND_MAX_BYTES = 4 * 1024;
const ENROLL_MS = 2000;
const STALE_CLAIM_MS = 15 * 1000;
// lo que se le espera a un proceso vivo con el candado antes de darlo por ajeno: más que una foto en una máquina muy
// cargada (hasta 3 s), y menos que el vencimiento del candado de arranque, que sigue tomado mientras tanto
const OWNER_WAIT_MS = 10 * 1000;
const NAME_MAX = 64;

const CONNECTABLE = new Set(['pedida', 'pendiente', 'aprobada']);
const WAITING = new Set(['pedida', 'pendiente']);
// un archivo que no se deja leer no sirve; una falla pasajera del sistema no es motivo para tirar una llave aprobada
const UNUSABLE_CODES = new Set(['EACCES', 'EPERM', 'EISDIR']);

const officeDir = (sdir) => path.join(sdir, 'office');
const keyFile = (sdir) => path.join(officeDir(sdir), 'site-key.json');
const stateFile = (sdir) => path.join(officeDir(sdir), 'site-key-state.json');
const logFile = (sdir) => path.join(officeDir(sdir), 'site-link.log');
const claimFile = (sdir) => path.join(officeDir(sdir), 'site-enroll.claim');
const startingFile = (sdir) => path.join(officeDir(sdir), 'server.starting');
const serverLockFile = (sdir) => path.join(officeDir(sdir), 'server.json');

function ensureOfficeDir(sdir) {
  fs.mkdirSync(officeDir(sdir), { recursive: true, mode: 0o700 });
  fs.chmodSync(officeDir(sdir), 0o700);
}

function appendLog(sdir, line, now = Date.now()) {
  try {
    ensureOfficeDir(sdir);
    fs.appendFileSync(logFile(sdir), `${new Date(now).toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* el registro nunca frena la conexión */ }
}

const publicKeyOf = (privatePem) => Buffer.from(crypto.createPublicKey(privatePem).export({ format: 'jwk' }).x, 'base64url').toString('base64');

/**
 * Qué hay en el archivo de la llave: `{ key }` si sirve, `{ missing: true }` si no está, `{ broken: motivo }` si está y no
 * sirve, `{ unread: código }` si no se pudo mirar. El motivo nunca copia el contenido del archivo.
 */
function inspectKey(sdir) {
  let text;
  try { text = fs.readFileSync(keyFile(sdir), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return UNUSABLE_CODES.has(e.code) ? { broken: e.code } : { unread: e.code || e.message };
  }
  let k;
  try { k = JSON.parse(text); } catch { return { broken: 'no es JSON' }; }
  if (!k || typeof k.privateKey !== 'string' || typeof k.publicKey !== 'string') return { broken: 'le faltan campos' };
  if (k.fingerprint !== fingerprintOf(k.publicKey)) return { broken: 'la huella no coincide' };
  // con una privada que no firma, cada conexión se cortaría al contestar el desafío
  try { if (publicKeyOf(k.privateKey) !== k.publicKey) return { broken: 'la privada no es de esta pública' }; } catch { return { broken: 'la privada no se entiende' }; }
  return { key: k };
}

/** La llave guardada, o null si no hay una que sirva. */
function readKey(sdir) {
  return inspectKey(sdir).key || null;
}

/**
 * La llave de la máquina: la arma si falta y reemplaza una que no sirve, dejándolo anotado. Dos procesos a la vez terminan
 * usando la misma: entra sólo la primera que se enlaza con el nombre final. Tira si no quedó una que sirva.
 */
function ensureKey(sdir) {
  const found = inspectKey(sdir);
  if (found.key) return found.key;
  if (found.unread) throw Object.assign(new Error(`no se pudo leer site-key.json (${found.unread})`), { code: found.unread });
  ensureOfficeDir(sdir);
  if (found.broken) {
    appendLog(sdir, `site-key.json no sirve (${found.broken}): se reemplaza por una clave nueva y se vuelve a pedir el alta`);
    fs.rmSync(keyFile(sdir), { force: true });
  }
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const key = { publicKey, fingerprint: fingerprintOf(publicKey), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const tmp = `${keyFile(sdir)}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(key)); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, keyFile(sdir)); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { fs.unlinkSync(tmp); }
  const kept = readKey(sdir);
  if (!kept) throw new Error('site-key.json no quedó legible');
  return kept;
}

// el estado se lee muchas veces por proceso: uno roto se anota una sola
const notedBrokenState = new Set();
function noteBrokenState(sdir, why) {
  if (notedBrokenState.has(sdir)) return;
  notedBrokenState.add(sdir);
  appendLog(sdir, `site-key-state.json no sirve (${why}): se toma como sin estado, y la próxima sesión vuelve a pedir el alta`);
}

function readLinkState(sdir) {
  let text;
  try { text = fs.readFileSync(stateFile(sdir), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') noteBrokenState(sdir, e.code || e.message);
    return null;
  }
  let s = null;
  try { s = JSON.parse(text); } catch { /* abajo: no sirve */ }
  if (s && typeof s.state === 'string') return s.state;
  noteBrokenState(sdir, 'no se entiende');
  return null;
}

function writeLinkState(sdir, state) {
  ensureOfficeDir(sdir);
  const tmp = `${stateFile(sdir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ state }), { mode: 0o600 });
  fs.renameSync(tmp, stateFile(sdir));
  notedBrokenState.delete(sdir);
}

/** La dirección con la que conecta el proceso: la del sitio (lo que devuelve `readSiteUrl`), o '' sin sitio o con el enlace apagado. */
function linkedSite(site, env = process.env) {
  const address = site && site.code === 0 ? String(site.out || '').trim() : '';
  return env.TYCON_OFFICE_LINK !== '0' && machineUrl(address) ? address : '';
}

const enrollLine = (fingerprint) => `Esta máquina pidió el alta en la oficina del sitio (huella ${displayFingerprint(fingerprint)}): la aprueba quien mantiene, no tenés que hacer nada`;

/** La línea de /office mientras la máquina espera la aprobación, o null si no espera. */
function waitingLine(sdir) {
  if (!WAITING.has(readLinkState(sdir))) return null;
  const key = readKey(sdir);
  return key ? `Esta máquina espera la aprobación de su oficina en el sitio (huella ${displayFingerprint(key.fingerprint)}): por ahora la oficina se ve sólo acá.` : null;
}

/** Manda un JSON por POST, sin seguir redirecciones. Resuelve `{ status }` o `{ error }`; nunca rechaza. */
function postJson(url, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ error: e }); return; }
    const payload = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    const giveUp = setTimeout(() => req.destroy(Object.assign(new Error('sin respuesta'), { code: 'ETIMEDOUT' })), timeoutMs);
    giveUp.unref();
    req.on('timeout', () => req.destroy(Object.assign(new Error('sin respuesta'), { code: 'ETIMEDOUT' })));
    req.on('error', (error) => { clearTimeout(giveUp); resolve({ error }); });
    req.on('close', () => clearTimeout(giveUp));
    req.end(payload);
  });
}

/** Toma un candado por crear un archivo. Uno de otro que murió a mitad vence solo. */
function claim(file) {
  for (let i = 0; i < 2; i += 1) {
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs <= STALE_CLAIM_MS) return false; fs.unlinkSync(file); } catch { /* lo sacó el otro */ }
    }
  }
  return false;
}

/**
 * El alta automática: arma la llave si falta y pide el alta al sitio. Devuelve la línea para el dev si el sitio recibió el
 * pedido; null si no hacía falta, si otra sesión ya lo está pidiendo o si no se pudo (se reintenta en la próxima sesión).
 */
async function enrollIfNeeded({ site, sdir, name = os.hostname(), timeoutMs = ENROLL_MS, now = Date.now() }) {
  const asked = () => { const s = readLinkState(sdir); return s === 'de-baja' || (CONNECTABLE.has(s) && readKey(sdir)); };
  if (asked()) {
    // de baja no se pide el alta, ni con una clave nueva: la clave rota queda dicha y nada más
    if (inspectKey(sdir).broken) appendLog(sdir, 'site-key.json no sirve y la máquina está de baja: no se reemplaza ni se pide el alta', now);
    return null;
  }
  ensureOfficeDir(sdir);
  if (!claim(claimFile(sdir))) return null;
  try {
    // la otra sesión pudo terminar mientras ésta llegaba al candado
    if (asked()) return null;
    if (readLinkState(sdir) === 'desconocida') fs.rmSync(keyFile(sdir), { force: true });
    const key = ensureKey(sdir);
    writeLinkState(sdir, 'nueva');
    const hint = String(name).split('.')[0].slice(0, NAME_MAX);
    const r = await postJson(new URL('/live/enroll', site).href, { publicKey: key.publicKey, fingerprint: key.fingerprint, nombre: hint }, timeoutMs);
    if (r.error) { appendLog(sdir, `el pedido de alta no llegó al sitio (${r.error.code || 'sin red'}): se reintenta en la próxima sesión`, now); return null; }
    if (r.status < 200 || r.status >= 300) { appendLog(sdir, `el sitio contestó ${r.status} al pedido de alta: se reintenta en la próxima sesión`, now); return null; }
    writeLinkState(sdir, 'pedida');
    return enrollLine(key.fingerprint);
  } finally {
    fs.rmSync(claimFile(sdir), { force: true });
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * De quién es el candado, esperando a lo sumo `waitMs`:
 *   none     no hay candado, o su pid ya no vive
 *   office   la oficina: contesta, con su pid
 *   foreign  su pid vive pero no es la oficina (pid reusado): nadie escucha en su puerto, o contesta otra cosa
 *   silent   su puerto acepta y no contesta a tiempo: armar la foto frena el proceso varios segundos
 */
function lockOwner(lock, waitMs) {
  return new Promise((resolve) => {
    if (!lock || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port) || !isAlive(lock.pid)) { resolve('none'); return; }
    const req = http.get({ host: '127.0.0.1', port: lock.port, path: `/health?t=${lock.token}`, headers: { host: `127.0.0.1:${lock.port}` }, timeout: waitMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let pid = null;
        try { ({ pid } = JSON.parse(body)); } catch { /* otra cosa: abajo */ }
        resolve(res.statusCode === 200 && pid === lock.pid ? 'office' : 'foreign');
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('silent'); });
    req.on('error', () => resolve('foreign'));
  });
}

/**
 * Lanza el proceso de la oficina sin esperarlo, o reusa el que está. Comparte con `--open` el candado `server.starting`,
 * que acá lo suelta el proceso nuevo: así dos arranques a la vez no lanzan dos. Con un proceso vivo que tarda en contestar,
 * lo que se lanza sólo espera: el gancho no tiene tiempo para el plazo de `OWNER_WAIT_MS`, y `server.js` se va sin escuchar,
 * sin conectar y sin tocar el candado apenas el que está contesta. Si no contesta en ese plazo, ocupa su lugar.
 * Devuelve 'reused', 'busy' (vivo y ocupado), 'started' o 'starting' (otro lo está lanzando).
 */
async function launchServer({ sdir, env = process.env, timeoutMs = 500 }) {
  ensureOfficeDir(sdir);
  if (!claim(startingFile(sdir))) return 'starting';
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(serverLockFile(sdir), 'utf8')); } catch { /* sin proceso */ }
  const owner = await lockOwner(lock, timeoutMs);
  if (owner === 'office') {
    fs.rmSync(startingFile(sdir), { force: true });
    return 'reused';
  }
  const out = fs.openSync(path.join(officeDir(sdir), 'server.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', out], env: { ...env, TYCON_OFFICE_RELEASE_STARTING: '1' } });
    child.on('error', () => { fs.rmSync(startingFile(sdir), { force: true }); });
    child.unref();
  } finally { fs.closeSync(out); }
  return owner === 'silent' ? 'busy' : 'started';
}

/**
 * La conexión al sitio. `start()` la abre, `update(foto)` le pasa la foto de la oficina, `wake()` la intenta otra vez (una
 * sesión nueva) y `stop()` la cierra. El reloj, el azar y la librería se reciben para poder probarlos.
 */
function createLink({ site, sdir, home = os.homedir(), WebSocket = require('./vendor/ws'), clock = { now: Date.now, setTimeout, clearTimeout }, random = Math.random }) {
  const url = machineUrl(site);
  let sock = null;
  let authed = false;
  let stopped = false;
  let attempts = 0;
  let retryTimer = null;
  let beatTimer = null;
  let greetTimer = null;
  let awaitingPong = false;
  let latest = null;
  let lastSent = null;
  let notedSize = null;
  let down = false;

  const note = (line) => appendLog(sdir, line, clock.now());
  // este estado lo lee después el gancho; un disco que no deja escribir no tira el proceso, que también atiende la página local
  const setState = (state) => { try { writeLinkState(sdir, state); } catch (e) { note(`el estado de la clave no se pudo guardar (${e.code || e.message})`); } };
  const clearRetry = () => { if (retryTimer != null) { clock.clearTimeout(retryTimer); retryTimer = null; } };
  const clearBeat = () => { if (beatTimer != null) { clock.clearTimeout(beatTimer); beatTimer = null; } };
  const clearGreet = () => { if (greetTimer != null) { clock.clearTimeout(greetTimer); greetTimer = null; } };

  // el latido no depende de las fotos: una máquina con actividad manda fotos seguidas, y es la que tiene algo para mostrar
  function armBeat() {
    clearBeat();
    beatTimer = clock.setTimeout(() => {
      beatTimer = null;
      if (!sock || !authed) return;
      // un sitio que no contesta el latido anterior cuenta como caído: una conexión muda no se entera sola
      if (awaitingPong) { sock.terminate(); return; }
      awaitingPong = true;
      sock.send(JSON.stringify({ type: 'ping' }));
      armBeat();
    }, HEARTBEAT_MS);
  }

  function sendFoto() {
    if (!sock || !authed || !latest) return;
    const msg = JSON.stringify({ type: 'foto', data: pick(latest, home) });
    if (msg === lastSent) return;
    const bytes = Buffer.byteLength(msg);
    if (bytes > MAX_MESSAGE_BYTES) {
      if (notedSize !== bytes) { notedSize = bytes; note(`una foto de ${bytes} bytes pasa de 64 KB y no se mandó: el sitio sigue con la anterior`); }
      return;
    }
    notedSize = null;
    sock.send(msg);
    lastSent = msg;
  }

  function retry() {
    clearRetry();
    if (stopped) return;
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempts);
    attempts += 1;
    // algo de azar, para que las máquinas que se cortaron juntas no vuelvan juntas
    const delay = Math.min(RETRY_MAX_MS, Math.round(base + random() * base * 0.25));
    retryTimer = clock.setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  function refuse(conn, type) {
    const shown = typeof type === 'string' ? `«${type.replace(/[^\w-]/g, '').slice(0, 40)}»` : 'sin tipo';
    note(`el sitio mandó un mensaje ${shown}: se descartó y se cerró la conexión, el canal de vuelta está cerrado`);
    conn.close(CLOSE.policy, 'el canal de vuelta está cerrado');
  }

  function onMessage(conn, raw, state) {
    if (conn !== sock) return;
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { /* abajo: sin tipo */ }
    const type = msg && typeof msg === 'object' ? msg.type : undefined;
    if (!MESSAGES.toMachine.includes(type)) { refuse(conn, type); return; }
    if (type === 'pong') {
      // la conexión estable es la que contesta el latido: un `ack` seguido de un cierre no cuenta, y la espera sigue creciendo
      if (authed && awaitingPong) { attempts = 0; down = false; }
      awaitingPong = false;
      return;
    }
    if (type === 'ack') {
      // aceptado es después de firmar: un `ack` antes del desafío no abre nada
      if (authed || !state.signed) return;
      authed = true;
      clearGreet();
      setState('aprobada');
      armBeat();
      sendFoto();
      return;
    }
    if (state.signed) return;
    if (!validNonce(msg.nonce)) { refuse(conn, type); return; }
    const key = readKey(sdir);
    if (!key) { conn.close(1000, 'sin clave'); return; }
    state.signed = true;
    const signature = crypto.sign(null, Buffer.from(signedText(site, msg.nonce)), crypto.createPrivateKey(key.privateKey)).toString('base64');
    conn.send(JSON.stringify({ type: 'auth', publicKey: key.publicKey, fingerprint: key.fingerprint, signature }));
  }

  function onClose(conn, code) {
    if (conn !== sock) return;
    const wasAuthed = authed;
    sock = null;
    authed = false;
    awaitingPong = false;
    lastSent = null;
    clearBeat();
    clearGreet();
    if (stopped) return;
    if (code === CLOSE.revoked) {
      setState('de-baja');
      note('el sitio dio esta máquina de baja (4403): deja de pedir el alta');
      return;
    }
    if (code === CLOSE.unknown) {
      setState('desconocida');
      note('el sitio no conoce esta clave o venció (4404): la próxima sesión arma una nueva y vuelve a pedir');
      return;
    }
    if (code === CLOSE.pending) {
      if (readLinkState(sdir) !== 'pendiente') note('el sitio tiene esta máquina pendiente de aprobación (4401): no manda fotos');
      setState('pendiente');
    } else if (!down) {
      down = true;
      note(`${wasAuthed ? 'se cortó la conexión con' : 'no se pudo conectar con'} el sitio (${code}): reintenta con espera creciente`);
    }
    retry();
  }

  function connect(force = false) {
    clearRetry();
    if (stopped || sock || !url) return;
    if (!force && !CONNECTABLE.has(readLinkState(sdir))) return;
    const found = inspectKey(sdir);
    if (found.broken) note(`site-key.json no sirve (${found.broken}): no se conecta hasta que la próxima sesión la reemplace`);
    if (!found.key) return;
    const conn = new WebSocket(url, { handshakeTimeout: HANDSHAKE_MS, maxPayload: INBOUND_MAX_BYTES, followRedirects: false });
    sock = conn;
    const state = { signed: false };
    // la librería cubre sólo el upgrade: con un sitio que después calla, la conexión quedaría colgada y `wake` sin efecto
    greetTimer = clock.setTimeout(() => {
      greetTimer = null;
      if (conn !== sock || authed) return;
      if (!down) { down = true; note(`el sitio no completó el saludo en ${GREETING_MS / 1000} s: se corta y reintenta con espera creciente`); }
      conn.terminate();
    }, GREETING_MS);
    // una llave ilegible no tira el proceso: se corta esta conexión y queda anotado
    conn.on('message', (raw) => {
      try { onMessage(conn, raw, state); } catch (e) { note(`no se pudo contestar al sitio (${e.code || e.message})`); conn.close(1011, 'error de la máquina'); }
    });
    conn.on('close', (code) => onClose(conn, code));
    conn.on('error', (e) => { if (e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') note('el sitio mandó un mensaje demasiado largo: se cerró sin leerlo'); });
  }

  return {
    start() { connect(readLinkState(sdir) === 'de-baja'); },
    update(foto) { latest = foto; sendFoto(); },
    wake() {
      attempts = 0;
      // una conexión abierta se resuelve sola: la cortan el reloj del saludo o el del latido, y reintenta desde la base
      if (sock) return;
      connect(readLinkState(sdir) === 'de-baja');
    },
    stop() {
      stopped = true;
      clearRetry();
      clearBeat();
      clearGreet();
      if (sock) { try { sock.close(1001, 'la oficina se cerró'); } catch { /* ya cerrada */ } }
    },
  };
}

module.exports = { GREETING_MS, OWNER_WAIT_MS, keyFile, stateFile, logFile, appendLog, readKey, ensureKey, readLinkState, writeLinkState, linkedSite, enrollLine, waitingLine, enrollIfNeeded, lockOwner, launchServer, createLink };
