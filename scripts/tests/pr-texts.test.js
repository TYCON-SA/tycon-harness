'use strict';

/**
 * pr-texts.test.js — el título y el cuerpo de un pedido, leídos de la API de GitHub (story 8.26, tanda F2 · AC 23 · T64).
 *
 * El freno de publicación mira, en la validación de cada pedido, su título y su cuerpo. Esos dos textos no están en
 * git: los trae scripts/ci/pr-texts.js y los deja en dos archivos. Lo que no puede pasar:
 *   · que «no pude leer» termine en dos archivos vacíos (el freno los miraría y diría «limpio»);
 *   · que queden los archivos de un intento anterior;
 *   · que la credencial aparezca en una salida, o viaje a otro servidor (una redirección, una base cambiada);
 *   · que la salida traiga el título o el cuerpo (el registro de la validación es público).
 *
 * Sin red: una API de mentira en la propia máquina. Los términos y la credencial son inventados.
 *
 * Correr: node --test scripts/tests/pr-texts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'pr-texts.js');
const TITLE = 'docs: una guía sobre Zorblax';          // inventado
const BODY = ['Primera línea.', '', 'La tercera nombra a Quimbaya9.'].join('\n');
// armada acá: escrita de corrido, este archivo —que viaja en la copia— dispararía el detector
const CREDENTIAL = ['gh', 's_', 'Tt7'.repeat(12)].join('');
const HEADER = `basic ${Buffer.from(`x-access-token:${CREDENTIAL}`).toString('base64')}`;

const cleanEnv = () => {
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec', 'PATHEXT', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
};

/** Una API de mentira: `respond(req)` → { status, json | raw, headers }. Anota lo que le piden. */
function fakeApi(t, respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    const answer = respond(req, requests.length);
    if (answer === null) return;   // no contesta: queda colgada
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...(answer.headers || {}) });
    res.end(answer.raw !== undefined ? answer.raw : JSON.stringify(answer.json === undefined ? {} : answer.json));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections(); server.close(); });
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

function lab(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prtexts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'salida');
  const clone = path.join(root, 'clon');
  spawnSync('git', ['init', '--quiet', clone], { encoding: 'utf8', env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: root } });
  return { root, out, clone, title: path.join(out, 'pr-title.txt'), body: path.join(out, 'pr-body.txt') };
}

/** Deja en el clon la credencial como la deja el checkout de Azure: una cabecera de más para ese servidor. */
function persistCredential(fx, url = 'https://github.com/', header = HEADER) {
  const r = spawnSync('git', ['-C', fx.clone, 'config', `http.${url}.extraheader`, `AUTHORIZATION: ${header}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

function run(fx, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...cleanEnv(), HOME: fx.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, all: `${stdout}\n${stderr}` }));
  });
}
const argsFor = (fx, api, extra = []) => ['--repo', 'acme/widgets', '--number', '12', '--out', fx.out, '--api', api.url, ...extra];
const pull = (over = {}) => ({ number: 12, title: TITLE, body: BODY, state: 'open', ...over });
const noFiles = (fx) => assert.ok(!fs.existsSync(fx.title) && !fs.existsSync(fx.body), 'no deja archivos de un pedido que no pudo leer');
const noTexts = (r) => {
  for (const s of ['Zorblax', 'Quimbaya9', CREDENTIAL, HEADER]) assert.ok(!r.all.includes(s), `la salida trae lo que no puede traer\n${r.all}`);
};

test('T64_ReadsTitleAndBody_IntoTwoFiles_AndPrintsNeither', async (t) => {
  const fx = lab(t);
  const api = await fakeApi(t, () => ({ status: 200, json: pull() }));
  const r = await run(fx, argsFor(fx, api));
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(fs.readFileSync(fx.title, 'utf8'), TITLE);
  assert.strictEqual(fs.readFileSync(fx.body, 'utf8'), BODY);
  noTexts(r);
  assert.match(r.stdout, /pedido nº 12/);
  assert.deepStrictEqual(api.requests.map((q) => `${q.method} ${q.path}`), ['GET /repos/acme/widgets/pulls/12']);
  assert.strictEqual(api.requests[0].headers.authorization, undefined, 'sin credencial no manda ninguna');

  // un pedido sin cuerpo: un archivo VACÍO (no es un error: no escribir cuerpo es legítimo)
  const empty = await fakeApi(t, () => ({ status: 200, json: pull({ body: null }) }));
  const e = await run(fx, argsFor(fx, empty));
  assert.strictEqual(e.status, 0, e.all);
  assert.strictEqual(fs.readFileSync(fx.body, 'utf8'), '');
  assert.strictEqual(fs.readFileSync(fx.title, 'utf8'), TITLE);
});

test('T64_WhatItCannotRead_IsTwo_AndLeavesNoFiles_NotEvenOldOnes', async (t) => {
  const fx = lab(t);
  // primero una lectura buena: quedan los dos archivos. Cada falla de abajo tiene que BORRARLOS, no dejarlos como están
  const good = await fakeApi(t, () => ({ status: 200, json: pull() }));
  const answers = [
    ['403', { status: 403, json: { message: 'API rate limit exceeded' } }],
    ['404', { status: 404, json: { message: 'Not Found' } }],
    ['500', { status: 500, json: {} }],
    ['no es JSON', { status: 200, raw: '<html>una página</html>' }],
    ['una lista', { status: 200, json: [pull()] }],
    ['sin título', { status: 200, json: { number: 12, body: 'x' } }],
    ['un título que no es texto', { status: 200, json: pull({ title: { html: 'x' } }) }],
    ['un cuerpo que no es texto', { status: 200, json: pull({ body: 7 }) }],
    ['otro pedido', { status: 200, json: pull({ number: 13 }) }],
  ];
  for (const [what, answer] of answers) {
    assert.strictEqual((await run(fx, argsFor(fx, good))).status, 0);
    const api = await fakeApi(t, () => answer);
    const r = await run(fx, argsFor(fx, api));
    assert.strictEqual(r.status, 2, `${what}: tenía que salir 2\n${r.all}`);
    noFiles(fx);
    noTexts(r);
    assert.match(r.stderr, /no pude leer/, what);
  }
  // nadie contesta en esa dirección; y alguien que no termina de contestar
  assert.strictEqual((await run(fx, argsFor(fx, good))).status, 0);
  const closed = await run(fx, argsFor(fx, { url: 'http://127.0.0.1:9' }));
  assert.strictEqual(closed.status, 2, closed.all);
  noFiles(fx);
  const hung = await fakeApi(t, () => null);
  const slow = await run(fx, argsFor(fx, hung), { PR_TEXTS_TIMEOUT_MS: '300' });
  assert.strictEqual(slow.status, 2, slow.all);
  assert.match(slow.stderr, /no contestó/);
  // 🔴 y si al guion lo CORTAN mientras espera (una corrida cancelada, el tope del paso), no llega a limpiar nada al
  // salir: por eso los archivos de antes se borran ANTES de pedir nada, no sólo cuando la lectura falla
  assert.strictEqual((await run(fx, argsFor(fx, good))).status, 0);
  const stuck = await fakeApi(t, () => null);
  const child = spawn(process.execPath, [SCRIPT, ...argsFor(fx, stuck)], { env: { ...cleanEnv(), HOME: fx.root }, stdio: 'ignore' });
  await new Promise((resolve) => { const tick = setInterval(() => { if (stuck.requests.length) { clearInterval(tick); resolve(); } }, 20); });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));
  noFiles(fx);
  // una respuesta que se corta a la mitad (dice que trae más de lo que llega): no es un pedido a medias, es 2
  assert.strictEqual((await run(fx, argsFor(fx, good))).status, 0);
  const cut = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    res.write(JSON.stringify(pull()).slice(0, 40));
    setTimeout(() => res.socket.destroy(), 30);
  });
  await new Promise((resolve) => cut.listen(0, '127.0.0.1', resolve));
  t.after(() => { cut.closeAllConnections(); cut.close(); });
  const half = await run(fx, argsFor(fx, { url: `http://127.0.0.1:${cut.address().port}` }), { PR_TEXTS_TIMEOUT_MS: '2000' });
  assert.strictEqual(half.status, 2, half.all);
  noFiles(fx);
  noTexts(half);
  // la carpeta de salida no se puede crear (hay un archivo con ese nombre): 2, y el mensaje no trae la ruta
  const inTheWay = path.join(fx.root, 'ocupado');
  fs.writeFileSync(inTheWay, 'x');
  const noDir = await run(fx, ['--repo', 'acme/widgets', '--number', '12', '--out', path.join(inTheWay, 'salida'), '--api', good.url]);
  assert.strictEqual(noDir.status, 2, noDir.all);
  assert.match(noDir.stderr, /no pude leer el título y el cuerpo del pedido nº 12 — error no previsto \(E[A-Z]+\)/);
  assert.ok(!noDir.all.includes(fx.root), 'el mensaje de un error no previsto no trae rutas de la máquina');
  // una respuesta más grande de lo que un pedido puede pesar
  const huge = await fakeApi(t, () => ({ status: 200, json: pull({ body: 'x'.repeat(3 * 1024 * 1024) }) }));
  assert.strictEqual((await run(fx, argsFor(fx, huge))).status, 2);
  noFiles(fx);
});

test('T64_Redirect_IsNotFollowed', async (t) => {
  const fx = lab(t);
  persistCredential(fx);
  const elsewhere = await fakeApi(t, () => ({ status: 200, json: pull() }));
  const api = await fakeApi(t, () => ({ status: 302, json: {}, headers: { Location: `${elsewhere.url}/repos/acme/widgets/pulls/12` } }));
  const r = await run(fx, argsFor(fx, api, ['--credential-from', fx.clone]));
  assert.strictEqual(r.status, 2, r.all);
  assert.strictEqual(elsewhere.requests.length, 0, 'la credencial no viaja a donde mande una redirección');
  noFiles(fx);
  noTexts(r);
});

test('T64_Credential_FromTheClone_OnlyForGithub_NeverPrinted_AndWithoutItWhenItIsRefused', async (t) => {
  const fx = lab(t);
  persistCredential(fx);
  const api = await fakeApi(t, () => ({ status: 200, json: pull() }));
  const r = await run(fx, argsFor(fx, api, ['--credential-from', fx.clone]));
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(api.requests[0].headers.authorization, HEADER, 'manda la credencial que el checkout dejó en el clon');
  assert.match(r.stdout, /con la credencial del checkout/);
  noTexts(r);

  // la credencial no sirve para la API (401, 403 o 404): se prueba sin ella —el repo es público— y se dice
  for (const refused of [401, 403, 404]) {
    const picky = await fakeApi(t, (req) => (req.headers.authorization ? { status: refused, json: { message: 'Bad credentials' } } : { status: 200, json: pull() }));
    const again = await run(fx, argsFor(fx, picky, ['--credential-from', fx.clone]));
    assert.strictEqual(again.status, 0, `${refused}\n${again.all}`);
    assert.strictEqual(picky.requests.length, 2);
    assert.strictEqual(picky.requests[1].headers.authorization, undefined);
    assert.match(again.stdout, /sin credencial/);
    noTexts(again);
  }
  // …pero un 500 con credencial no se reintenta sin ella: eso no es «la credencial no sirve»
  const broken = await fakeApi(t, () => ({ status: 500, json: {} }));
  assert.strictEqual((await run(fx, argsFor(fx, broken, ['--credential-from', fx.clone]))).status, 2);
  assert.strictEqual(broken.requests.length, 1);

  // …y si tampoco sin ella (el cupo agotado, un repo que no es público): 2, sin archivos, después de las dos preguntas
  const never = await fakeApi(t, (req) => ({ status: req.headers.authorization ? 404 : 403, json: { message: 'no' } }));
  const both = await run(fx, argsFor(fx, never, ['--credential-from', fx.clone]));
  assert.strictEqual(both.status, 2, both.all);
  assert.strictEqual(never.requests.length, 2);
  assert.match(both.stderr, /la API contestó 403/);
  noFiles(fx);
  noTexts(both);

  // una credencial guardada para OTRO servidor no es la de GitHub: no se manda. Tampoco la de un servidor cuyo nombre
  // EMPIEZA o TERMINA como el de GitHub (se compara el nombre entero, no un pedazo)
  for (const url of ['https://dev.azure.com/org-de-prueba/', 'https://github.com.otro.test/', 'https://no-github.com/', 'https://api.github.com.otro.test/acme/widgets']) {
    const other = lab(t);
    persistCredential(other, url, HEADER);
    const plain = await fakeApi(t, () => ({ status: 200, json: pull() }));
    const o = await run(other, argsFor(other, plain, ['--credential-from', other.clone]));
    assert.strictEqual(o.status, 0, `${url}\n${o.all}`);
    assert.strictEqual(plain.requests[0].headers.authorization, undefined, `la credencial de ${url} no es la de GitHub`);
    assert.match(o.stdout, /sin credencial/);
  }
  // con varias cabeceras guardadas, se elige la de GitHub esté en el lugar que esté —y sólo ésa—
  const several = lab(t);
  const OTHER = `basic ${Buffer.from('x-access-token:otra-credencial-de-otro-servidor').toString('base64')}`;
  persistCredential(several, 'https://dev.azure.com/org-de-prueba/', OTHER);
  persistCredential(several, 'https://github.com.otro.test/', OTHER);
  persistCredential(several, 'https://github.com/', HEADER);
  persistCredential(several, 'https://zzz.example.test/', OTHER);
  const picked = await fakeApi(t, () => ({ status: 200, json: pull() }));
  assert.strictEqual((await run(several, argsFor(several, picked, ['--credential-from', several.clone]))).status, 0);
  assert.strictEqual(picked.requests[0].headers.authorization, HEADER, 'la de GitHub, no la primera que aparece');
  // el gemelo: la del repo mismo (Azure la guarda a veces con la dirección entera del repo) sí
  const exact = lab(t);
  persistCredential(exact, 'https://github.com/acme/widgets', HEADER);
  const withIt = await fakeApi(t, () => ({ status: 200, json: pull() }));
  assert.strictEqual((await run(exact, argsFor(exact, withIt, ['--credential-from', exact.clone]))).status, 0);
  assert.strictEqual(withIt.requests[0].headers.authorization, HEADER);
  // una cabecera guardada que no es de autorización, tampoco
  const odd = lab(t);
  spawnSync('git', ['-C', odd.clone, 'config', 'http.https://github.com/.extraheader', 'X-Other: 1']);
  const q = await fakeApi(t, () => ({ status: 200, json: pull() }));
  assert.strictEqual((await run(odd, argsFor(odd, q, ['--credential-from', odd.clone]))).status, 0);
  assert.strictEqual(q.requests[0].headers.authorization, undefined);
  // una carpeta que no es un clon: sin credencial, y sigue
  const none = await fakeApi(t, () => ({ status: 200, json: pull() }));
  const n = await run(fx, argsFor(fx, none, ['--credential-from', path.join(fx.root, 'no-existe')]));
  assert.strictEqual(n.status, 0, n.all);
  assert.strictEqual(none.requests[0].headers.authorization, undefined);
});

test('T64_ApiBase_OnlyChangesTowardsThisMachine_AndBadArgumentsAreTwo', async (t) => {
  const fx = lab(t);
  persistCredential(fx);
  const base = ['--repo', 'acme/widgets', '--number', '12', '--out', fx.out];
  // 🔴 `--api` cambia la base SÓLO hacia la propia máquina: a cualquier otro servidor —cifrado o no— viajaría la
  // credencial del checkout. (La de GitHub no pasa por esa opción: es una constante del guion.)
  for (const api of ['http://api.example.test', 'https://api.example.test', 'https://github.com.otro.test', 'https://127.0.0.1.otro.test', 'ftp://127.0.0.1',
    'https://usuario:clave@127.0.0.1', 'no es una dirección', 'http://127.0.0.1/?x=1', 'http://localhost/#x']) {
    const r = await run(fx, [...base, '--api', api, '--credential-from', fx.clone]);
    assert.strictEqual(r.status, 2, `${api}\n${r.all}`);
    assert.match(r.stderr, /la base de la API/);
    noFiles(fx);
  }
  for (const bad of [['--repo', 'acme', '--number', '12', '--out', fx.out], ['--repo', 'acme/widgets', '--number', 'doce', '--out', fx.out],
    ['--repo', 'acme/widgets/../x', '--number', '12', '--out', fx.out], ['--repo', 'acme/widgets', '--number', '12'], ['--repo', 'acme/widgets', '--number', '0', '--out', fx.out],
    [...base, '--unknown', 'x'], [...base, '--api']]) {
    const r = await run(fx, bad);
    assert.strictEqual(r.status, 2, `${bad.join(' ')}\n${r.all}`);
  }
  // las tres formas de nombrar la propia máquina valen (la de IPv6 no siempre se puede escuchar acá: se mira la regla)
  const lib = require(SCRIPT);
  for (const api of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080', 'https://127.0.0.1']) assert.ok(lib.apiBase(api), api);
  assert.throws(() => lib.apiBase('https://api.github.com'), /propia máquina/, 'ni la de GitHub entra por la opción');
  assert.strictEqual(lib.parseArgs(base).api.href, 'https://api.github.com/', 'sin la opción, la de GitHub');
  // la base por defecto es la de GitHub, escrita en el guion: no la cambia ninguna variable de entorno
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /https:\/\/api\.github\.com/);
  assert.ok(!/process\.env\.[A-Z_]*API/.test(source), 'la base de la API no sale del entorno: sólo de --api, que el paso de la validación no usa');
});
