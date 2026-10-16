#!/usr/bin/env node
'use strict';
// http-get.js — el cliente HTTP del mecanismo de instalación: GET con proxy, tope y redirecciones (story 8.23, tanda B).
//
// ── POR QUÉ UNO PROPIO (revisión I6, 2026-10-07) ─────────────────────────────────────────────────────────────────
// Instalar sin git baja de GitHub por HTTPS. Node 20 (el piso del arnés) no honra `HTTPS_PROXY`/`NO_PROXY` en `fetch`,
// y las máquinas del equipo pueden estar detrás de un proxy. Además la bajada del comprimido redirige a OTRO host
// (codeload.github.com) con una llave temporal en la URL: la credencial no puede seguir a ese host.
//
// ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
//   · `httpGet(url, opts)` → Promise `{ status, headers, body: Buffer, url }` (la URL en la que terminó).
//     opts: `headers`, `timeoutMs` (por pedido, también el de conectar), `deadlineAt` (ms absolutos: el tope total de
//     quien llama), `maxRedirects` (5), `maxBytes` (64 MB), `env` (de dónde leer el proxy), `tls` ({ ca }, pruebas).
//   · Redirecciones 301/302/303/307/308: al MISMO origen (protocolo + host + puerto) con las mismas cabeceras; a otro
//     origen SIN `Authorization`. Más de `maxRedirects` es un error.
//   · Proxy: `HTTPS_PROXY` para destinos https (túnel CONNECT), `HTTP_PROXY` para http (forma absoluta); en mayúsculas o
//     minúsculas; `NO_PROXY` (lista separada por comas; `*`, un host, o un sufijo `.dominio`) saca al destino del proxy;
//     las credenciales de la URL del proxy van en `Proxy-Authorization`.
//   · Errores, como `HttpError` con `kind`: `network` (rechazada, sin ruta, nombre que no resuelve; con `code`),
//     `timeout` (el servidor no contesta), `proxy-timeout` (el proxy no contesta), `proxy` (el proxy contestó ≠ 200 al
//     túnel), `tls`, `redirect`, `too-big`.
//   · `getSync(url, opts)` corre el pedido en un proceso hijo —harness.js es síncrono— y le pasa el pedido POR STDIN:
//     ninguna cabecera (la credencial) va en la línea de comandos. Devuelve `{ ok, status, headers, body, url }` o
//     `{ ok: false, kind, code, message }`, nunca tira.
//   · `TYCON_HTTP_TRACE=<archivo>` (sólo pruebas, story 8.34): cada pedido —también cada salto de una redirección— agrega
//     una línea JSON con el origen, la ruta (los VALORES de la consulta tapados: la llave temporal de codeload no se
//     escribe) y si llevó `Authorization` (sí o no, nunca el valor). Así una prueba cuenta los pedidos a cada host, también
//     contra el GitHub real (el ensayo de Windows).
//   · Como comando: `node http-get.js --json` lee `{ url, headers, timeoutMs, … }` de stdin y escribe el resultado en
//     JSON (el cuerpo en base64). Es el hijo de `getSync`; no está pensado para una persona.
//
// Sin dependencias: `http`, `https`, `net`, `tls`, `url`, `child_process`.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EADDRNOTAVAIL']);

class HttpError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'HttpError'; this.kind = kind; Object.assign(this, extra); }
}

const envGet = (env, name) => env[name] !== undefined ? env[name] : env[name.toLowerCase()];

/** ¿El host del destino queda fuera del proxy según NO_PROXY? */
function noProxy(env, hostname) {
  const list = String(envGet(env, 'NO_PROXY') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = hostname.toLowerCase();
  return list.some((p) => p === '*' || p === h || (p.startsWith('.') && h.endsWith(p)) || h.endsWith(`.${p}`));
}

/** El proxy para un destino: `{ url: URL }` o null. */
function proxyFor(env, target) {
  if (noProxy(env, target.hostname)) return null;
  const raw = target.protocol === 'https:' ? (envGet(env, 'HTTPS_PROXY') || envGet(env, 'HTTP_PROXY')) : envGet(env, 'HTTP_PROXY');
  if (!raw) return null;
  try { return { url: new URL(/^\w+:\/\//.test(raw) ? raw : `http://${raw}`) }; } catch (_) { return null; }
}

const proxyAuth = (p) => (p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`).toString('base64')}` } : {});
const classifyNet = (e) => (e && NETWORK_CODES.has(e.code) ? 'network' : (e && /CERT|TLS|SSL|certificate/i.test(e.code || e.message) ? 'tls' : 'network'));

// un proxy declarado `https://` se habla por TLS y, sin puerto, en el 443 (como curl); `http://` (o sin esquema), en claro
// y en el 80 (pase adversarial de la 8.40, clase 9)
const proxyIsTls = (p) => p.protocol === 'https:';
const proxyPort = (p) => p.port || (proxyIsTls(p) ? 443 : 80);
/** Las opciones de la conexión AL proxy: con TLS, su nombre (SNI salvo una IP) y las opciones TLS de quien llama. */
const toProxy = (p, tlsOpts) => Object.assign({ host: p.hostname, port: proxyPort(p) }, proxyIsTls(p) ? Object.assign(net.isIP(p.hostname) ? {} : { servername: p.hostname }, tlsOpts || {}) : {});

/** Un túnel CONNECT abierto en el proxy hacia `host:port`; devuelve el socket. */
function connectTunnel(proxy, target, { timeoutMs, tlsOpts }) {
  return new Promise((resolve, reject) => {
    const req = (proxyIsTls(proxy) ? https : http).request(Object.assign(toProxy(proxy, tlsOpts), {
      agent: false, method: 'CONNECT', path: `${target.hostname}:${target.port || 443}`,
      headers: Object.assign({ Host: `${target.hostname}:${target.port || 443}` }, proxyAuth(proxy)), timeout: timeoutMs,
    }));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new HttpError('proxy', `el proxy ${proxy.host} contestó ${res.statusCode} al túnel hacia ${target.host}`)); }
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(new HttpError('proxy-timeout', `proxy sin respuesta: ${proxy.host} no contestó en ${timeoutMs} ms`)); });
    req.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(classifyNet(e), `no pude hablar con el proxy ${proxy.host}: ${e.code || e.message}`, { code: e.code })));
    req.end();
  });
}

/** El registro de pedidos de las pruebas (`TYCON_HTTP_TRACE`): origen, ruta sin valores de la consulta, si llevó credencial. */
function trace(env, target, headers) {
  const file = envGet(env, 'TYCON_HTTP_TRACE');
  if (!file) return;
  const query = [...target.searchParams.keys()].map((k) => `${k}=…`).join('&');
  const auth = Object.keys(headers || {}).some((k) => /^authorization$/i.test(k));
  try { require('fs').appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), method: 'GET', origin: target.origin, path: `${target.pathname}${query ? `?${query}` : ''}`, auth })}\n`); } catch (_) { /* el registro de una prueba no frena un pedido */ }
}

/** Un GET, sin seguir redirecciones. */
function once(target, { headers, timeoutMs, maxBytes, env, tlsOpts }) {
  return new Promise((resolve, reject) => {
    const proxy = proxyFor(env, target);
    const isHttps = target.protocol === 'https:';
    const fail = (e) => reject(e instanceof HttpError ? e : new HttpError(classifyNet(e), `${target.host}: ${e.code || e.message}`, { code: e.code }));
    const go = (opts, mod) => {
      const req = mod.request(opts, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new HttpError('too-big', `la respuesta de ${target.host} pasa de ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new HttpError(proxy && !isHttps ? 'proxy-timeout' : 'timeout', `${proxy && !isHttps ? `proxy sin respuesta: ${proxy.url.host}` : `sin respuesta: ${target.host}`} no contestó en ${timeoutMs} ms`)));
      req.on('error', fail);
      req.end();
    };
    // un agente por pedido, sin keep-alive: ningún socket se reusa (un proxy, un tope); las opciones TLS (`ca` en las
    // pruebas) viajan en el agente —con `agent: false` Node las deja afuera—
    const base = { method: 'GET', headers: Object.assign({ Host: target.host, 'User-Agent': 'tycon-installer', Accept: '*/*' }, headers), timeout: timeoutMs };
    if (proxy && !isHttps) {
      // forma absoluta al proxy, http
      const viaTls = proxyIsTls(proxy.url);
      go(Object.assign({}, base, toProxy(proxy.url, tlsOpts), { agent: viaTls ? new https.Agent(Object.assign({ keepAlive: false }, tlsOpts || {})) : new http.Agent({ keepAlive: false }), path: target.href, headers: Object.assign({}, base.headers, proxyAuth(proxy.url)) }), viaTls ? https : http);
    } else if (proxy && isHttps) {
      connectTunnel(proxy.url, target, { timeoutMs, tlsOpts }).then((socket) => {
        // `host` para que TLS verifique la identidad del certificado; `servername` (SNI) sólo con un nombre, nunca con una IP
        const tlsSocket = tls.connect(Object.assign({ socket, host: target.hostname }, net.isIP(target.hostname) ? {} : { servername: target.hostname }, tlsOpts || {}));
        tlsSocket.on('error', fail);
        // sin `agent`: sólo así http usa `createConnection` (con un agente, aunque sea `false`, lo ignora y abre su propia conexión)
        go(Object.assign({}, base, { host: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, createConnection: () => tlsSocket }), https);
      }).catch(fail);
    } else {
      go(Object.assign({}, base, { agent: isHttps ? new https.Agent(Object.assign({ keepAlive: false }, tlsOpts || {})) : new http.Agent({ keepAlive: false }), host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: `${target.pathname}${target.search}` }, isHttps ? (tlsOpts || {}) : {}), isHttps ? https : http);
    }
  });
}

/**
 * GET con redirecciones, proxy y tope. Resuelve `{ status, headers, body, url }`; rechaza con HttpError.
 */
async function httpGet(url, opts = {}) {
  const env = opts.env || process.env;
  const maxRedirects = opts.maxRedirects === undefined ? DEFAULT_MAX_REDIRECTS : opts.maxRedirects;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  let headers = Object.assign({}, opts.headers || {});
  let target = new URL(url);
  const origin0 = target.origin;
  for (let hop = 0; ; hop++) {
    const left = opts.deadlineAt ? opts.deadlineAt - Date.now() : Infinity;
    if (left <= 0) throw new HttpError('timeout', `se acabó el tope antes de pedir ${target.host}`);
    const timeoutMs = Math.max(1, Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, left));
    trace(env, target, headers);
    const r = await once(target, { headers, timeoutMs, maxBytes, env, tlsOpts: opts.tls });
    if (!REDIRECTS.has(r.status) || !r.headers.location) return { status: r.status, headers: r.headers, body: r.body, url: target.href };
    if (hop >= maxRedirects) throw new HttpError('redirect', `más de ${maxRedirects} redirecciones desde ${url}`);
    const next = new URL(r.headers.location, target);
    if (next.origin !== origin0 && next.origin !== target.origin) {
      // otro origen: la credencial no viaja (la bajada de GitHub va a codeload con su propia llave en la URL)
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
    }
    target = next;
  }
}

/** El pedido en un proceso hijo, por stdin; nunca tira. */
function getSync(url, opts = {}) {
  const req = Object.assign({}, opts, { url, env: opts.env || process.env });
  if (req.tls && req.tls.ca) req.tls = { ca: Buffer.from(req.tls.ca).toString('base64'), caBase64: true };
  const total = (opts.timeoutMs || DEFAULT_TIMEOUT_MS) * ((opts.maxRedirects === undefined ? DEFAULT_MAX_REDIRECTS : opts.maxRedirects) + 1) + 5000;
  const r = spawnSync(process.execPath, [__filename, '--json'], { input: JSON.stringify(req), encoding: 'utf8', maxBuffer: (opts.maxBytes || DEFAULT_MAX_BYTES) * 2 + 1024 * 1024, timeout: opts.deadlineAt ? Math.max(1000, opts.deadlineAt - Date.now() + 2000) : total, env: process.env });
  if (r.error) return { ok: false, kind: r.error.code === 'ETIMEDOUT' ? 'timeout' : 'network', code: r.error.code, message: `no pude correr el pedido: ${r.error.message}` };
  // cortado por una señal (sin el tope: ése es r.error): la causa es la señal, no una respuesta ilegible
  if (r.signal) return { ok: false, kind: 'network', code: r.signal, message: `el pedido se cortó con la señal ${r.signal}` };
  let out;
  try { out = JSON.parse(r.stdout); } catch (_) { return { ok: false, kind: 'network', message: `el pedido no devolvió nada legible (salió ${r.status}): ${(r.stderr || '').trim().split('\n')[0] || 'sin detalle'}` }; }
  if (out.ok) out.body = Buffer.from(out.body, 'base64');
  return out;
}

if (require.main === module) {
  if (!process.argv.includes('--json')) { process.stderr.write('uso: node http-get.js --json  (el pedido, en JSON, por stdin)\n'); process.exit(2); }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    let req;
    try { req = JSON.parse(input); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, kind: 'network', message: `pedido ilegible: ${e.message}` })); return; }
    const opts = Object.assign({}, req);
    delete opts.url;
    if (opts.tls && opts.tls.caBase64) opts.tls = { ca: Buffer.from(opts.tls.ca, 'base64') };
    httpGet(req.url, opts)
      .then((r) => process.stdout.write(JSON.stringify({ ok: true, status: r.status, headers: r.headers, url: r.url, body: r.body.toString('base64') })))
      .catch((e) => process.stdout.write(JSON.stringify({ ok: false, kind: e.kind || 'network', code: e.code, message: e.message })));
  });
}

/**
 * ¿Este fallo es del RELOJ de quien llama y no de la red? Un cliente con tope total (`deadlineAt`) que hace varios pedidos le
 * deja al último lo que sobra: si eso era casi nada, «no contestó en 118 ms» no dice nada de la red (2026-10-09: la capa de
 * 115 archivos bajada de a uno con el reloj de mirar salía como «sin red»). Es del reloj cuando el pedido ni llegó a salir
 * (`leftMs` ≤ 0), o cuando el servidor ya venía contestando (`answered` > 0) y a éste le quedaba menos que una espera justa.
 * Un servidor que nunca contestó, con todo el tope para él, sigue siendo «sin red».
 */
const FAIR_WAIT_MS = 2000;
function ranOutOfClock(r, { leftMs, answered }) {
  return Boolean(r && !r.ok && r.kind === 'timeout' && (leftMs <= 0 || (answered > 0 && leftMs < FAIR_WAIT_MS)));
}

module.exports = { HttpError, httpGet, getSync, proxyFor, noProxy, ranOutOfClock, FAIR_WAIT_MS };
