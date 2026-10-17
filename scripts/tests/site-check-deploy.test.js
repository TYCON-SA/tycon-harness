'use strict';
// site-check-deploy.test.js — red de scripts/site/check-deploy.js, la prueba sin sesión de un sitio instalado.
//
// Cada caso levanta un servidor local que contesta como contestaría un sitio (bien cerrado, abierto, frenado, dormido,
// detrás del candado de la plataforma) y corre la prueba como proceso aparte. Sin red: todo es 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const CHECK = path.join(RAIZ, 'scripts', 'site', 'check-deploy.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deploy-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const EMISOR = 'https://login.acme.example/tenant/oauth2/v2.0/authorize';

/** Un servidor local con un manejador; devuelve { url, cerrar }. */
function servidor(manejar) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => manejar(req, res));
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, cerrar: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) }));
  });
}
const json = (res, status, doc, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(doc)); };

/** El sitio bien cerrado: /healthz sano, todo lo demás pide iniciar sesión. */
function sitioCerrado(req, res, { healthz } = {}) {
  const ruta = req.url.split('?')[0];
  if (ruta === '/healthz') return healthz ? healthz(res) : json(res, 200, { ok: true });
  if (ruta === '/livez') return json(res, 200, { ok: true });
  if (ruta.startsWith('/api/')) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
  res.writeHead(302, { Location: `${EMISOR}?response_type=code&client_id=x&state=s`, 'Cache-Control': 'no-store' });
  return res.end();
}

function correr(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECK, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr });
    });
  });
}

test('T4 Prueba_SitioBienCerrado @story-2.30 @ac-6', async () => {
  const s = await servidor((req, res) => sitioCerrado(req, res));
  const out = path.join(tmp, 't4.json');
  const r = await correr(['--url', s.url, '--out', out]);
  await s.cerrar();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(doc.resultado, 'paso');
  assert.strictEqual(doc.motivo, null);
  assert.ok(Number.isFinite(Date.parse(doc.hora)) && doc.hora.endsWith('Z'), 'la hora en UTC');
  assert.ok(doc.capas && doc.capas.healthz && doc.capas.inicio && doc.capas.api, 'dice qué contestó cada capa');
  // con el inicio de sesión de GitHub: la autorización no lleva response_type,
  // lleva client_id, redirect_uri y code_challenge. También es «pide iniciar sesión».
  const gh = await servidor((req, res) => (req.url === '/' ? (res.writeHead(302, { Location: 'https://github.com/login/oauth/authorize?client_id=x&redirect_uri=y&scope=read%3Auser&state=s&code_challenge=c&code_challenge_method=S256', 'Cache-Control': 'no-store' }), res.end()) : sitioCerrado(req, res)));
  const r2 = await correr(['--url', gh.url]);
  await gh.cerrar();
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  // pero una redirección a otro origen sin nada de eso no cuenta como inicio de sesión
  const otro = await servidor((req, res) => (req.url === '/' ? (res.writeHead(302, { Location: 'https://otro.acme.example/pagina', 'Cache-Control': 'no-store' }), res.end()) : sitioCerrado(req, res)));
  const r3 = await correr(['--url', otro.url]);
  await otro.cerrar();
  assert.strictEqual(r3.status, 1, r3.stdout + r3.stderr);
});

test('T5 Prueba_SitioAbierto @story-2.30 @ac-6', async () => {
  const casos = [
    // `/` con contenido, sin sesión
    [(req, res) => (req.url === '/' ? (res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }), res.end('<h1>tablero</h1>')) : sitioCerrado(req, res)), 'el sitio responde sin iniciar sesión'],
    // `/api/inicio` con datos
    [(req, res) => (req.url.startsWith('/api/') ? json(res, 200, { repos: ['x'] }) : sitioCerrado(req, res)), '/api contesta con datos'],
    // /healthz con otra clave
    [(req, res) => sitioCerrado(req, res, { healthz: (r) => json(r, 200, { ok: true, version: '1.2.3' }) }), '/healthz cuenta de más'],
    // la redirección del sitio sin no-store
    [(req, res) => (req.url === '/' ? (res.writeHead(302, { Location: `${EMISOR}?response_type=code` }), res.end()) : sitioCerrado(req, res)), 'falta no-store'],
    // una cadena del mismo origen que termina en 200 HTML
    [(req, res) => (req.url === '/' ? (res.writeHead(302, { Location: '/inicio', 'Cache-Control': 'no-store' }), res.end())
      : req.url === '/inicio' ? (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<p>hola</p>')) : sitioCerrado(req, res)), 'el sitio responde sin iniciar sesión'],
  ];
  for (const [manejar, motivo] of casos) {
    const s = await servidor(manejar);
    const out = path.join(tmp, 't5.json');
    const r = await correr(['--url', s.url, '--out', out]);
    await s.cerrar();
    assert.strictEqual(r.status, 1, `${motivo}: ${r.stdout}${r.stderr}`);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(doc.resultado, 'fallo');
    assert.strictEqual(doc.motivo, motivo);
    assert.ok(!r.stdout.includes(s.url) && !r.stderr.includes(s.url) && !JSON.stringify({ motivo: doc.motivo }).includes('127.0.0.1'), 'el motivo no lleva la dirección');
  }
  // el vocabulario es cerrado y lo exporta el módulo
  const { MOTIVOS } = require(CHECK);
  assert.deepStrictEqual(MOTIVOS, ['/healthz cuenta de más', 'el sitio está frenado', 'el sitio responde sin iniciar sesión', '/api contesta con datos', 'falta no-store', 'acepta http']);
});

test('T6 Prueba_NoPudoPreguntar @story-2.30 @ac-6', async () => {
  const out = path.join(tmp, 't6.json');
  // sin conexión: un puerto cerrado
  let r = await correr(['--url', 'http://127.0.0.1:9', '--out', out, '--wake-timeout', '2']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).resultado, 'no_pudo');
  // dirección inválida, o http a un host que no es la propia máquina
  for (const mala of ['no es una dirección', 'http://sitio.acme.example', 'ftp://sitio.acme.example']) {
    r = await correr(['--url', mala, '--out', out]);
    assert.strictEqual(r.status, 2, `${mala}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).resultado, 'no_pudo');
  }
  // sin --url: uso
  r = await correr([]);
  assert.strictEqual(r.status, 2);
});

test('T6b Prueba_RespuestaRara_NoEsSinConexion @story-2.30 @ac-6', async () => {
  // un Location que no es una dirección (el sitio contestó, y contestó mal): «no pudo», pero con el motivo verdadero
  const s = await servidor((req, res) => (req.url === '/' ? (res.writeHead(302, { Location: 'http://[no-es-una-direccion', 'Cache-Control': 'no-store' }), res.end()) : sitioCerrado(req, res)));
  const out = path.join(tmp, 't6b.json');
  const r = await correr(['--url', s.url, '--out', out]);
  await s.cerrar();
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(doc.motivo, 'respuesta inesperada del sitio');
  assert.doesNotMatch(r.stderr, /sin conexión/);
});

test('T27 Prueba_DetrasDelCandadoDeLaPlataforma @story-2.30 @ac-6', async () => {
  // el candado: 302 a /.auth/login/aad para todo salvo /healthz y /livez, sin no-store (no lo pone el sitio)
  const candado = (req, res) => {
    const ruta = req.url.split('?')[0];
    if (ruta === '/healthz' || ruta === '/livez') return json(res, 200, { ok: true });
    if (ruta.startsWith('/.auth/login/aad')) { res.writeHead(302, { Location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?response_type=code+id_token' }); return res.end(); }
    res.writeHead(302, { Location: `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(ruta)}` });
    return res.end();
  };
  let s = await servidor(candado);
  let r = await correr(['--url', s.url]);
  await s.cerrar();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  // la misma cadena, pero /api/inicio termina en 200 HTML del mismo origen
  s = await servidor((req, res) => (req.url.startsWith('/api/inicio') ? (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<p>x</p>')) : candado(req, res)));
  r = await correr(['--url', s.url]);
  await s.cerrar();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
});

test('T28 Prueba_HealthzSinNombres @story-2.30 @ac-6', async () => {
  const s = await servidor((req, res) => sitioCerrado(req, res, { healthz: (r) => json(r, 503, { ok: false, motivo: 'no pude leer https://dev.azure.com/acme/_git/operaciones' }) }));
  const out = path.join(tmp, 't28.json');
  const r = await correr(['--url', s.url, '--out', out]);
  await s.cerrar();
  assert.strictEqual(r.status, 1);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(doc.motivo, '/healthz cuenta de más');
  assert.ok(!fs.readFileSync(out, 'utf8').includes('dev.azure.com') && !r.stdout.includes('dev.azure.com') && !r.stderr.includes('dev.azure.com'), 'sin repetir la dirección');
});

test('T35 Prueba_SitioDormidoDespierta @story-2.30 @ac-6 @ac-12', async () => {
  // tarda 3 s en contestar el PRIMER pedido (despierta) y después contesta al toque
  let despierto = false;
  const dormido = (req, res) => {
    if (despierto) return sitioCerrado(req, res);
    setTimeout(() => { despierto = true; sitioCerrado(req, res); }, 3000);
  };
  let s = await servidor(dormido);
  let r = await correr(['--url', s.url, '--wake-timeout', '5']);
  await s.cerrar();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  despierto = false;
  s = await servidor(dormido);
  const out = path.join(tmp, 't35.json');
  r = await correr(['--url', s.url, '--wake-timeout', '1', '--out', out]);
  await s.cerrar();
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr + r.stdout, /no despertó a tiempo/);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).resultado, 'no_pudo');
});

test('T38c Prueba_SitioFrenado @story-2.30 @ac-6', async () => {
  // la parte de T38 que es de la prueba sin sesión: el sitio frenado por operations.json es falla, no «pasa»
  const s = await servidor((req, res) => sitioCerrado(req, res, { healthz: (r) => json(r, 503, { ok: false, motivo: 'frenado' }) }));
  const r = await correr(['--url', s.url]);
  await s.cerrar();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout + r.stderr, /el sitio está frenado/);
});

test('Prueba_HttpDeLaMismaDireccion @story-2.30 @ac-6', async () => {
  // la dirección https tiene su gemela http: si contesta con contenido, «acepta http»; si redirige a https, pasa
  const s = await servidor((req, res) => sitioCerrado(req, res));
  const abierta = await servidor((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>hola por http</p>'); });
  const redirige = await servidor((req, res) => { res.writeHead(301, { Location: `https://sitio.acme.example${req.url}` }); res.end(); });
  let r = await correr(['--url', s.url], { TYCON_CHECK_DEPLOY_HTTP_URL: abierta.url });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /acepta http/);
  r = await correr(['--url', s.url], { TYCON_CHECK_DEPLOY_HTTP_URL: redirige.url });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  r = await correr(['--url', s.url], { TYCON_CHECK_DEPLOY_HTTP_URL: 'http://127.0.0.1:9' });
  assert.strictEqual(r.status, 0, `no contesta por http: pasa · ${r.stdout}${r.stderr}`);
  await Promise.all([s.cerrar(), abierta.cerrar(), redirige.cerrar()]);
});
