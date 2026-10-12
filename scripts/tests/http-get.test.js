'use strict';
/**
 * http-get.test.js — el cliente HTTP propio del mecanismo de instalación (story 8.23, tanda B · parte de T9 y T11).
 *
 * POR QUÉ UNO PROPIO (2026-10-07). Instalar sin git baja de GitHub por HTTPS. Node 20 (el piso del arnés) no honra
 * `HTTPS_PROXY`/`NO_PROXY` en `fetch`, y las máquinas del equipo pueden estar detrás de un proxy corporativo (revisión
 * I6). Y la bajada del comprimido redirige a OTRO host (codeload) con una llave temporal en la URL: la credencial no
 * puede viajar a ese host.
 *
 * Qué fija:
 *   · GET con cabeceras, estado y cuerpo; la respuesta dice en qué URL terminó;
 *   · una redirección al MISMO origen conserva `Authorization`; a OTRO origen la saca; más de 5 es un error `redirect`;
 *   · `HTTP_PROXY` manda un destino http por el proxy (forma absoluta); `NO_PROXY` lo saca del proxy; las credenciales
 *     del proxy viajan como `Proxy-Authorization`; un destino https pasa por un túnel CONNECT;
 *   · un proxy que acepta y no contesta es `proxy-timeout` dentro del tope; un servidor mudo directo es `timeout`;
 *   · conexión rechazada o nombre que no resuelve son `network`, con el código; un cuerpo más grande que el tope es
 *     `too-big`;
 *   · `getSync` corre el pedido en un proceso hijo (harness.js es síncrono) y le pasa el pedido por stdin: ninguna
 *     cabecera —la credencial— va en la línea de comandos.
 * 🔴 Todo en localhost y en el temporal; el certificado de prueba se genera con openssl al correr (sin él, la prueba del
 * túnel FALLA diciendo que no midió: no medido no es verde).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'scripts', 'lib', 'http-get.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
const servers = [];
const closeAll = () => { for (const s of servers) try { s.close(); } catch (_) { /* ya */ } servers.length = 0; };
const env0 = { PATH: process.env.PATH };   // ningún proxy heredado de la máquina

/** Un servidor http que devuelve lo que recibió (método, url, cabeceras) y honra /redirect/<n>, /to?url=, /big, /mute. */
async function echoServer({ muteOn = null } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/mute' || (muteOn && u.pathname === muteOn)) return;            // nunca contesta
    if (u.pathname.startsWith('/redirect/')) {
      const n = parseInt(u.pathname.split('/')[2], 10);
      res.writeHead(302, { Location: n > 1 ? `/redirect/${n - 1}` : '/final' }); return res.end();
    }
    if (u.pathname === '/to') { res.writeHead(307, { Location: u.searchParams.get('url') }); return res.end(); }
    if (u.pathname === '/big') { res.writeHead(200); return res.end(Buffer.alloc(200000, 0x61)); }
    res.writeHead(200, { 'content-type': 'application/json', etag: '"e1"' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  servers.push(srv);
  const port = await listen(srv);
  return { port, seen, base: `http://127.0.0.1:${port}` };
}
/** Un proxy de juguete: forma absoluta para http, CONNECT para https; anota qué le pidieron. Con `mute`, acepta y calla. */
async function toyProxy({ mute = false } = {}) {
  const seen = [];
  const srv = net.createServer((sock) => {
    if (mute) { sock.on('error', () => {}); return; }
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.once('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const head = buf.toString('latin1');
      const line = head.split('\r\n')[0];
      const auth = /proxy-authorization: (.*)\r\n/i.exec(head);
      seen.push({ line, proxyAuth: auth ? auth[1] : null });
      const [method, target] = line.split(' ');
      if (method === 'CONNECT') {
        const [host, port] = target.split(':');
        const up = net.connect(parseInt(port, 10), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy());
        return;
      }
      const u = new URL(target);
      const up = net.connect(parseInt(u.port, 10), u.hostname, () => {
        // reescribe la línea de pedido a la forma relativa y pasa el resto tal cual
        const rest = head.slice(head.indexOf('\r\n') + 2);
        up.write(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${rest}`);
        up.pipe(sock); sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
    });
  });
  servers.push(srv);
  const port = await listen(srv);
  return { port, seen, url: `http://127.0.0.1:${port}` };
}
/** Un certificado autofirmado para 127.0.0.1, generado con openssl en el temporal. */
function selfSigned(dir) {
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `sin openssl no se puede medir el túnel CONNECT: ${r.stderr || r.error}`);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
test.after(closeAll);

test('GET: estado, cabeceras enviadas y recibidas, cuerpo, y la URL final', async () => {
  const { httpGet } = require(CLIENT);
  const s = await echoServer();
  const r = await httpGet(`${s.base}/x?y=1`, { headers: { Accept: 'application/json', 'If-None-Match': '"e0"' }, env: env0, timeoutMs: 3000 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.etag, '"e1"');
  const body = JSON.parse(r.body.toString('utf8'));
  assert.strictEqual(body.url, '/x?y=1');
  assert.strictEqual(body.headers['if-none-match'], '"e0"');
  assert.strictEqual(r.url, `${s.base}/x?y=1`);
});

test('redirecciones: el mismo origen conserva Authorization, otro origen la saca, más de 5 es un error', async () => {
  const { httpGet } = require(CLIENT);
  const a = await echoServer(), b = await echoServer();
  const same = await httpGet(`${a.base}/redirect/2`, { headers: { Authorization: 'Bearer MARCA-1' }, env: env0, timeoutMs: 3000 });
  assert.strictEqual(same.status, 200);
  assert.strictEqual(JSON.parse(same.body.toString()).headers.authorization, 'Bearer MARCA-1');
  assert.strictEqual(same.url, `${a.base}/final`);
  const other = await httpGet(`${a.base}/to?url=${encodeURIComponent(`${b.base}/landed`)}`, { headers: { Authorization: 'Bearer MARCA-2' }, env: env0, timeoutMs: 3000 });
  assert.strictEqual(other.status, 200);
  assert.strictEqual(JSON.parse(other.body.toString()).headers.authorization, undefined, 'la credencial no viaja a otro host');
  assert.strictEqual(other.url, `${b.base}/landed`);
  assert.ok(b.seen.some((x) => x.url === '/landed' && !x.headers.authorization));
  await assert.rejects(httpGet(`${a.base}/redirect/7`, { env: env0, timeoutMs: 3000 }), (e) => e.kind === 'redirect');
});

test('HTTP_PROXY manda por el proxy en forma absoluta con sus credenciales; NO_PROXY lo saca', async () => {
  const { httpGet } = require(CLIENT);
  const s = await echoServer();
  const p = await toyProxy();
  const env = Object.assign({}, env0, { HTTP_PROXY: `http://usuario:clave@127.0.0.1:${p.port}` });
  const r = await httpGet(`${s.base}/via-proxy`, { env, timeoutMs: 3000 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(p.seen.length, 1, 'pasó por el proxy');
  assert.strictEqual(p.seen[0].line, `GET ${s.base}/via-proxy HTTP/1.1`);
  assert.strictEqual(p.seen[0].proxyAuth, `Basic ${Buffer.from('usuario:clave').toString('base64')}`);
  const envNo = Object.assign({}, env, { NO_PROXY: 'localhost,127.0.0.1' });
  await httpGet(`${s.base}/directo`, { env: envNo, timeoutMs: 3000 });
  assert.strictEqual(p.seen.length, 1, 'con NO_PROXY no pasó por el proxy');
  assert.ok(s.seen.some((x) => x.url === '/directo'));
  // https_proxy en minúsculas también vale
  const envLower = Object.assign({}, env0, { http_proxy: `http://127.0.0.1:${p.port}` });
  await httpGet(`${s.base}/lower`, { env: envLower, timeoutMs: 3000 });
  assert.strictEqual(p.seen.length, 2);
});

test('un destino https pasa por un túnel CONNECT del proxy', async () => {
  const { httpGet } = require(CLIENT);
  const pem = selfSigned(tmp('http-tls-'));
  const srv = https.createServer({ key: pem.key, cert: pem.cert }, (req, res) => { res.writeHead(200); res.end(`seguro ${req.url}`); });
  servers.push(srv);
  const port = await listen(srv);
  const p = await toyProxy();
  const env = Object.assign({}, env0, { HTTPS_PROXY: p.url });
  const r = await httpGet(`https://127.0.0.1:${port}/tunel`, { env, timeoutMs: 4000, tls: { ca: pem.cert } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.toString(), 'seguro /tunel');
  assert.strictEqual(p.seen[0].line, `CONNECT 127.0.0.1:${port} HTTP/1.1`);
  // sin proxy, directo, con la misma CA
  const d = await httpGet(`https://127.0.0.1:${port}/directo`, { env: env0, timeoutMs: 4000, tls: { ca: pem.cert } });
  assert.strictEqual(d.body.toString(), 'seguro /directo');
});

test('un proxy mudo es «proxy sin respuesta» dentro del tope; un servidor mudo directo es «sin respuesta»', async () => {
  const { httpGet } = require(CLIENT);
  const s = await echoServer();
  const p = await toyProxy({ mute: true });
  const t0 = Date.now();
  await assert.rejects(httpGet(`${s.base}/x`, { env: Object.assign({}, env0, { HTTP_PROXY: p.url }), timeoutMs: 800 }), (e) => e.kind === 'proxy-timeout');
  assert.ok(Date.now() - t0 < 2500, 'dentro del tope');
  await assert.rejects(httpGet(`${s.base}/mute`, { env: env0, timeoutMs: 800 }), (e) => e.kind === 'timeout');
});

test('conexión rechazada y nombre que no resuelve son «sin red» con su código; un cuerpo más grande que el tope se corta', async () => {
  const { httpGet } = require(CLIENT);
  const closed = net.createServer(); const port = await listen(closed); closed.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(httpGet(`http://127.0.0.1:${port}/`, { env: env0, timeoutMs: 3000 }), (e) => e.kind === 'network' && e.code === 'ECONNREFUSED');
  await assert.rejects(httpGet('http://nombre-que-no-existe.invalid/', { env: env0, timeoutMs: 5000 }), (e) => e.kind === 'network' && /ENOTFOUND|EAI_AGAIN/.test(e.code));
  const s = await echoServer();
  await assert.rejects(httpGet(`${s.base}/big`, { env: env0, timeoutMs: 3000, maxBytes: 1000 }), (e) => e.kind === 'too-big');
});

/** El servidor de eco en OTRO proceso: `getSync` bloquea el de la prueba, y un servidor en el mismo proceso no contestaría. */
function echoServerProcess() {
  const { spawn } = require('child_process');
  const code = `const http=require('http');const s=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({url:q.url,headers:q.headers}))});s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)+'\\n')});`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => child.stdout.once('data', (d) => res({ base: `http://127.0.0.1:${String(d).trim()}`, kill: () => child.kill() })));
}

test('getSync corre el pedido en un proceso hijo y le pasa el pedido por stdin, nunca por la línea de comandos', async (t) => {
  const { getSync } = require(CLIENT);
  const s = await echoServerProcess();
  t.after(() => s.kill());
  const r = getSync(`${s.base}/sync`, { headers: { Authorization: 'Bearer MARCA-SYNC' }, env: env0, timeoutMs: 3000 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body.toString()).headers.authorization, 'Bearer MARCA-SYNC');
  // el contrato del hijo: sólo `--json`, el pedido entero por stdin
  const child = spawnSync(process.execPath, [CLIENT, '--json'], { input: JSON.stringify({ url: `${s.base}/child`, headers: { Authorization: 'Bearer MARCA-CHILD' }, timeoutMs: 3000, env: env0 }), encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(JSON.parse(Buffer.from(out.body, 'base64').toString()).headers.authorization, 'Bearer MARCA-CHILD');
  // un error también vuelve como dato, no como excepción
  const bad = getSync('http://127.0.0.1:9/', { env: env0, timeoutMs: 2000 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.kind, 'network');
});
