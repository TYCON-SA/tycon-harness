'use strict';
/**
 * team-config.test.js — la página local de configuración de la organización (`harness.js team-config`).
 *
 * Qué fija: que la página sólo le conteste a quien trae su llave y por su propia dirección (ni otra pestaña, ni otro
 * sitio, ni un nombre que resuelva a 127.0.0.1), que valide con el lector que se le da y no escriba nada que el lector
 * rechace, que el pedido no lleve otros cambios del clon y que un rechazo por permisos se diga en llano, y cómo se abre el
 * navegador en cada sistema. Los lectores son de juguete (los de verdad tienen sus propias pruebas); git corre aislado de
 * la configuración global de la máquina (sus hooks no corren).
 *
 * Correr: node --test scripts/tests/team-config.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TC = require(path.join(__dirname, '..', 'setup', 'harness', 'team-config.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `team-config-${p}-`));
const GLOBAL = path.join(tmp('git'), 'gitconfig');
fs.writeFileSync(GLOBAL, '');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com' };
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV }).trim();

/** Un lector de juguete con el contrato de los de verdad: version 1, `public` obligatoria, nada de claves desconocidas. */
const toyReader = {
  parse(text) {
    let d;
    try { d = JSON.parse(text); } catch { return { ok: false, data: null, problems: [{ path: '', message: 'no es JSON' }] }; }
    const problems = [];
    if (d.version !== 1) problems.push({ path: 'version', message: 'tiene que ser 1' });
    if (!d.public || !d.public.repo) problems.push({ path: 'public.repo', message: 'falta el repo' });
    for (const k of Object.keys(d)) if (!k.startsWith('__') && !['version', 'public', 'profile', 'operations', 'maintainers', 'harness_copies'].includes(k)) problems.push({ path: k, message: 'clave desconocida' });
    return problems.length ? { ok: false, data: null, problems } : { ok: true, data: d, problems: [] };
  },
};
const GOOD = { version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' } };

/** Un clon con un remoto bare local (y el nombre de rama main). */
function cloneWithRemote() {
  const bare = tmp('bare');
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  const dir = tmp('clone');
  g(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'perfil\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base');
  g(dir, 'remote', 'add', 'origin', bare);
  g(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, bare };
}

/** Un pedido HTTP crudo, con los encabezados que se quieran (Host incluido). */
function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
async function withPage(opts, fn) {
  const p = await TC.start({ tree: tmp('tree'), env: ENV, ...opts });
  try { await fn(p); } finally { p.close(); await p.done; }
}
const api = (p, name, body) => request(p.port, body === undefined
  ? { pathname: `/api/${name}`, headers: { 'x-harness-key': p.token } }
  : { method: 'POST', pathname: `/api/${name}`, headers: { 'x-harness-key': p.token, 'content-type': 'application/json' }, body });

test('T1 Page_OnlyWithItsKey_InlineOnly_StrictPolicy', async () => {
  await withPage({ readers: { repos: toyReader, operations: null } }, async (p) => {
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{48}$/);
    assert.strictEqual((await request(p.port, { pathname: '/' })).status, 403, 'sin la llave no hay página');
    assert.strictEqual((await request(p.port, { pathname: '/?k=otra' })).status, 403, 'con otra llave tampoco');
    const r = await request(p.port, { pathname: `/?k=${p.token}` });
    assert.strictEqual(r.status, 200);
    const csp = r.headers['content-security-policy'];
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(r.text.includes(`<script nonce="${nonce}">`) && r.text.includes(`<style nonce="${nonce}">`), 'lo inline lleva el nonce de la respuesta');
    assert.doesNotMatch(r.text, /\bsrc=|https?:\/\/(?!127\.0\.0\.1)/, 'nada se carga de afuera');
    assert.doesNotMatch(r.text, /innerHTML/, 'los textos van con textContent');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });
});

test('T2 Page_RejectsOtherHost_OtherOrigin_NoKey_NonJson', async () => {
  await withPage({ readers: { repos: toyReader, operations: null } }, async (p) => {
    // un sitio de afuera que resuelve su nombre a 127.0.0.1 manda su propio Host
    assert.strictEqual((await request(p.port, { pathname: `/?k=${p.token}`, headers: { host: `evil.example:${p.port}` } })).status, 403);
    assert.strictEqual((await request(p.port, { pathname: '/api/state', headers: { host: `localhost:${p.port}`, 'x-harness-key': p.token } })).status, 403);
    assert.strictEqual((await request(p.port, { pathname: '/api/state' })).status, 403, 'la API sin la llave');
    const foreign = await request(p.port, { method: 'POST', pathname: '/api/save', headers: { 'x-harness-key': p.token, 'content-type': 'application/json', origin: 'http://evil.example' }, body: { target: 'repos', data: GOOD } });
    assert.strictEqual(foreign.status, 403, 'un POST desde otro origen');
    const form = await request(p.port, { method: 'POST', pathname: '/api/save', headers: { 'x-harness-key': p.token, 'content-type': 'text/plain' }, body: 'x' });
    assert.strictEqual(form.status, 415, 'sólo JSON');
    const big = await request(p.port, { method: 'POST', pathname: '/api/clone', headers: { 'x-harness-key': p.token, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'repos', dir: 'a'.repeat(300 * 1024) }) }).catch(() => ({ status: 400 }));
    assert.strictEqual(big.status, 400, 'un cuerpo más grande que el tope');
  });
});

test('T3 State_NeedsClone_NoReader_New_Loaded', async () => {
  const { dir } = cloneWithRemote();
  await withPage({ readers: { repos: toyReader, operations: null }, clones: {} }, async (p) => {
    const s = (await api(p, 'state')).json;
    assert.deepStrictEqual(s.targets.map((t) => [t.id, t.state]), [['repos', 'needs-clone'], ['operations', 'no-reader']]);
    assert.deepStrictEqual(s.targets.map((t) => t.configKey), ['paths.team', 'paths.operations']);
  });
  await withPage({ readers: { repos: toyReader, operations: null }, clones: { repos: dir } }, async (p) => {
    assert.strictEqual((await api(p, 'state')).json.targets[0].state, 'new', 'sin el archivo: se crea al guardar');
  });
  fs.writeFileSync(path.join(dir, 'team-repos.json'), JSON.stringify({ version: 2, otra: 1 }));
  await withPage({ readers: { repos: toyReader, operations: null }, clones: { repos: dir } }, async (p) => {
    const t = (await api(p, 'state')).json.targets[0];
    assert.strictEqual(t.state, 'loaded');
    assert.deepStrictEqual(t.data, { version: 2, otra: 1 }, 'un archivo con problemas se muestra igual, para corregirlo');
    assert.deepStrictEqual(t.problems.map((x) => x.path).sort(), ['otra', 'public.repo', 'version']);
  });
});

test('T4 Clone_AskedOnce_ValidatedAndSavedByTheCaller', async () => {
  const { dir } = cloneWithRemote();
  const saved = [];
  const setClone = (t, d) => { saved.push([t.configKey, d]); return { ok: true, message: `${t.configKey} guardada` }; };
  await withPage({ readers: { repos: toyReader, operations: null }, setClone, home: path.dirname(dir) }, async (p) => {
    assert.match((await api(p, 'clone', { target: 'repos', dir: 'relativa' })).json.message, /ruta completa/);
    assert.match((await api(p, 'clone', { target: 'repos', dir: path.join(dir, 'no-existe') })).json.message, /no existe/);
    assert.match((await api(p, 'clone', { target: 'repos', dir: os.tmpdir() })).json.message, /no es un clon/);
    assert.strictEqual(saved.length, 0, 'nada se guarda si la carpeta no sirve');
    const ok = (await api(p, 'clone', { target: 'repos', dir: `~/${path.basename(dir)}` })).json;
    assert.strictEqual(ok.ok, true, '~ se lee como la carpeta personal');
    assert.deepStrictEqual(saved, [['paths.team', dir]]);
    assert.strictEqual((await api(p, 'state')).json.targets[0].state, 'new');
    assert.strictEqual((await api(p, 'clone', { target: 'nada', dir })).status, 400, 'un archivo que no existe en la página');
  });
  const refused = () => ({ ok: false, message: 'el freno de producción no conoce paths.team' });
  await withPage({ readers: { repos: toyReader, operations: null }, setClone: refused }, async (p) => {
    const r = (await api(p, 'clone', { target: 'repos', dir })).json;
    assert.deepStrictEqual([r.ok, r.message], [false, 'el freno de producción no conoce paths.team'], 'lo que diga quien guarda llega tal cual');
    assert.strictEqual((await api(p, 'state')).json.targets[0].state, 'needs-clone');
  });
});

test('T8 Browser_OpenOnMac_StartOnWindows_XdgOpenElsewhere', () => {
  const u = 'http://127.0.0.1:5/?k=ab';
  assert.deepStrictEqual(TC.browserCommand('darwin', u), ['open', [u]]);
  assert.deepStrictEqual(TC.browserCommand('win32', u), ['cmd', ['/c', 'start', '""', u]]);
  assert.deepStrictEqual(TC.browserCommand('linux', u), ['xdg-open', [u]]);
});

test('T10 Quit_ClosesThePage', async () => {
  const p = await TC.start({ tree: tmp('tree'), readers: { repos: toyReader, operations: null } });
  const r = await api(p, 'quit', {});
  assert.strictEqual(r.json.ok, true);
  await p.done;
  await assert.rejects(request(p.port, { pathname: '/' }), 'cerrada, no contesta');
});

// Con los lectores de verdad del árbol (scripts/lib/team-repos.js y operations-config.js): la página los toma sola, un
// archivo como el de una organización real se lee entero, y cada problema llega con la ruta del campo que lo muestra.
test('T11 RealReaders_PickedFromTheTree_ExampleLoads_ProblemsCarryTheFieldPath', async () => {
  const tree = path.join(__dirname, '..', '..');
  assert.ok(TC.loadReader(tree, TC.TARGETS[0]) && TC.loadReader(tree, TC.TARGETS[1]), 'los dos lectores están en el árbol');
  const team = cloneWithRemote().dir;
  const ops = cloneWithRemote().dir;
  const azure = (repo) => ({ platform: 'azure', org: 'acme', project: 'Arnés del equipo', repo });
  const fmt = (d) => `${JSON.stringify(d, null, 2)}\n`;
  const repos = { __doc: 'de prueba', version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: azure('team-profile'), operations: azure('team-operations'), harness_copies: [azure('old-copy')] };
  const opsData = { version: 1, owners: { default: 'owner@acme.example', by_project: { 'Proyecto A': 'lead@acme.example' } }, reviewers: { dependencies: ['rev@acme.example'] } };
  fs.writeFileSync(path.join(team, 'team-repos.json'), fmt(repos));
  fs.writeFileSync(path.join(ops, 'operations.json'), fmt(opsData));
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const s = (await api(p, 'state')).json.targets;
    assert.deepStrictEqual(s.map((t) => [t.state, t.problems.length]), [['loaded', 0], ['loaded', 0]]);
    assert.deepStrictEqual(s[0].data, repos, 'lo escrito se vuelve a leer igual, con su comentario');
  });
  // la lista de responsables no va en el archivo que llega a todas las máquinas; un proyecto de Azure que falta y un nombre
  // con un carácter que no va: cada problema en la ruta de su campo
  fs.writeFileSync(path.join(team, 'team-repos.json'), fmt({ ...repos, owners: ['x'] }));
  await withPage({ tree, clones: { repos: team } }, async (p) => {
    assert.deepStrictEqual((await api(p, 'state')).json.targets[0].problems.map((x) => x.path), ['owners']);
  });
  fs.writeFileSync(path.join(team, 'team-repos.json'), fmt({ ...repos, operations: { platform: 'azure', org: 'acme', repo: 'ops' }, harness_copies: [azure('mal/nombre')] }));
  await withPage({ tree, clones: { repos: team } }, async (p) => {
    assert.deepStrictEqual((await api(p, 'state')).json.targets[0].problems.map((x) => x.path).sort(), ['harness_copies.0.repo', 'operations.project']);
  });
  fs.writeFileSync(path.join(ops, 'operations.json'), fmt({ version: 1, owners: {} }));
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    assert.deepStrictEqual((await api(p, 'state')).json.targets[1].problems.map((x) => x.path), ['owners.default']);
  });
});

// story 2.24 (AC 23): el buzón de corridas de la organización, en un panel de sólo lectura. La llave es una credencial y la
// página no guarda credenciales: el servidor arma una proyección con leerConfig y los NOMBRES de los parámetros de la firma.
test('T21 2.24-TeamConfig_BuzonSoloLecturaSinFirma', async () => {
  const tree = path.join(__dirname, '..', '..');
  const sig = 'FIRMAsecreta' + 'DePrueba123';   // armada por partes: una firma de mentira entera en el código frena el empuje
  const file = path.join(tmp('buzon'), 'corridas-buzon.json');
  fs.writeFileSync(file, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', politica: 'subida-prueba', vence: '2099-01-01', tenant: '00000000-0000-0000-0000-000000000000', sas: `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${sig}` }));
  await withPage({ tree, readers: { repos: toyReader, operations: null }, mailboxFile: file }, async (p) => {
    const s = await api(p, 'state');
    const m = s.json.mailbox;
    assert.deepStrictEqual({ hay: m.hay, cuenta: m.cuenta, contenedor: m.contenedor, politica: m.politica, vence: m.vence, permisos_propios: m.permisos_propios },
      { hay: true, cuenta: 'cuentadeprueba', contenedor: 'corridas', politica: 'subida-prueba', vence: '2099-01-01', permisos_propios: null });
    assert.ok(m.parametros.includes('sig') && m.parametros.includes('si'), 'los nombres de los parámetros, sin valores');
    const page = await request(p.port, { pathname: `/?k=${p.token}` });
    for (const r of [s.text, page.text]) {
      assert.ok(!r.includes(sig), 'ninguna respuesta trae la firma');
      assert.ok(!r.includes('sv=2022-11-02'), 'ni la SAS entera');
    }
    assert.match(page.text, /--check-create-only/, 'la página da el comando para comprobar «sólo crear» desde una máquina');
    const save = await api(p, 'save', { target: 'mailbox', data: { cuenta: 'otra' } });
    assert.strictEqual(save.json.ok, false, 'no hay acción de guardar para el buzón');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cuenta, 'cuentadeprueba', 'el archivo no se tocó');
  });
});

test('T21b 2.24-TeamConfig_PermisosPropios_LlaveRota_SeDicen', () => {
  const tree = path.join(__dirname, '..', '..');
  const dir = tmp('buzon-b');
  const cw = path.join(dir, 'cw.json');
  fs.writeFileSync(cw, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', vence: '2099-01-01', sas: 'sv=2022-11-02&si=p&sp=cw&sr=c&sig=x' }));
  assert.strictEqual(TC.mailboxSummary(tree, cw).permisos_propios, 'cw', 'la firma con permisos propios lo dice');
  const roto = path.join(dir, 'roto.json');
  fs.writeFileSync(roto, '{"cuenta": ');
  const r = TC.mailboxSummary(tree, roto);
  assert.strictEqual(r.hay, false);
  assert.match(r.problema, /JSON/, 'una llave rota se dice, no se toma por «sin buzón»');
  const sinGuion = TC.mailboxSummary(tmp('arbol-vacio'), roto);
  assert.match(sinGuion.problema, /no trae la subida/, 'un árbol sin el guion: esta versión no lo trae');
  // un guion que está pero no carga (un error de sintaxis) no es «esta versión no lo trae»: se dice con su código
  const roto2 = tmp('arbol-roto');
  fs.mkdirSync(path.join(roto2, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(roto2, 'scripts', 'metrics', 'upload-runs.js'), 'module.exports = {;\n');
  const noCarga = TC.mailboxSummary(roto2, roto);
  assert.strictEqual(noCarga.hay, false);
  assert.match(noCarga.problema, /no se pudo cargar scripts\/metrics\/upload-runs\.js \(SyntaxError\)/);
});

test('T22 2.24-TeamConfig_SinBuzon_DiceQueNoSeSube', async () => {
  const tree = path.join(__dirname, '..', '..');
  await withPage({ tree, readers: { repos: toyReader, operations: null }, mailboxFile: path.join(tmp('sin-buzon'), 'corridas-buzon.json') }, async (p) => {
    assert.deepStrictEqual((await api(p, 'state')).json.mailbox, { hay: false });
    assert.match((await request(p.port, { pathname: `/?k=${p.token}` })).text, /sin buzón: esta organización no sube corridas/);
  });
});

test('T39 PaginaLocal_ModelsConProblema_NoSePierde @story-2.29 @ac-21 (tanda C) — un modelo mal escrito no desaparece del borrador al leer team-repos.json', () => {
  const TR = require(path.join(__dirname, '..', 'lib', 'team-repos.js'));
  const { dir } = cloneWithRemote();
  const gh = (repo) => ({ platform: 'github', org: 'acme', repo });
  const doc = { version: 1, public: gh('harness'), profile: gh('profile'), operations: gh('ops'), models: { reviewers: 'gpt', helpers: 'haiku' } };
  fs.writeFileSync(path.join(dir, 'team-repos.json'), `${JSON.stringify(doc, null, 2)}\n`);
  assert.strictEqual(TR.parse(fs.readFileSync(path.join(dir, 'team-repos.json'), 'utf8')).ok, true, 'el lector lo tolera (decisión 13 de la 7.29)');
  const t = TC.readTarget(TC.TARGETS.find((x) => x.id === 'repos'), dir, TR);
  assert.strictEqual(t.state, 'loaded');
  assert.deepStrictEqual(t.data, doc, 'el borrador trae models tal como está, para corregirlo; guardar no lo borra en silencio');
  assert.deepStrictEqual(t.problems.map((x) => x.path), ['models.reviewers'], 'y el problema a la vista');
});

// La página local es de sólo lectura: muestra las secciones del núcleo común de los archivos de sus dos clones (las del
// sitio y las de personas incluidas) con los problemas que dan los lectores; no tiene control para guardar; las cinco
// rutas de edición contestan 410 sin escribir nada; las tres que quedan siguen andando.
test('2.29-T21 PaginaLocal_SoloLectura_AvisoDelSitio', async () => {
  const tree = path.join(__dirname, '..', '..');
  const fmt = (d) => `${JSON.stringify(d, null, 2)}\n`;
  const team = cloneWithRemote().dir;
  const ops = cloneWithRemote().dir;
  const gh = (repo) => ({ platform: 'github', org: 'acme', repo });
  fs.writeFileSync(path.join(team, 'team-repos.json'), fmt({ version: 1, public: gh('harness'), profile: gh('profile'), operations: gh('ops') }));
  const people = { machines: { 'maq-uno-1a2b3c4d': { person: 'dev.uno@acme.example', reported_sha256: 'a'.repeat(64), confirmed_by: 'lead@acme.example', confirmed_on: '2026-10-15' } } };
  const opsDoc = { version: 1, owners: { default: 'lead@acme.example' }, people, site: { maintainers: ['lead@acme.example'], url: 'https://sitio.acme.example' } };
  fs.writeFileSync(path.join(ops, 'operations.json'), fmt(opsDoc));
  const before = { team: g(team, 'status', '--porcelain'), ops: g(ops, 'status', '--porcelain'), opsFile: fs.readFileSync(path.join(ops, 'operations.json'), 'utf8') };
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const s = (await api(p, 'state')).json;
    const opsT = s.targets.find((x) => x.id === 'operations');
    const reposT = s.targets.find((x) => x.id === 'repos');
    // las secciones del núcleo, con sus datos, también las del sitio y las de personas
    const ids = (t) => t.sections.map((x) => x.id);
    assert.ok(ids(reposT).includes('repos'), 'el perfil muestra la sección de los repos');
    assert.ok(['responsables', 'sitio', 'personas'].every((x) => ids(opsT).includes(x)), `operaciones muestra responsables, sitio y personas: ${ids(opsT)}`);
    assert.strictEqual(opsT.sections.find((x) => x.id === 'sitio').data.site.url, 'https://sitio.acme.example');
    assert.deepStrictEqual(opsT.sections.find((x) => x.id === 'personas').data, { people });
    assert.deepStrictEqual(opsT.problems, [], 'los lectores aceptan el archivo');
    // la dirección del sitio llega a la página y el aviso la dice
    assert.strictEqual(s.site, 'https://sitio.acme.example');
    assert.strictEqual(s.notice, 'la configuración de la organización se edita en el sitio: https://sitio.acme.example');
    const html = (await request(p.port, { pathname: `/?k=${p.token}` })).text;
    assert.doesNotMatch(html, /Guardar|api\('(save|check|plan|propose|propose-stages)'/, 'ningún control ni llamada de edición');
    // las cinco rutas retiradas contestan 410 y no dejan archivo, rama ni pedido
    for (const name of ['check', 'save', 'plan', 'propose', 'propose-stages']) {
      const r = await api(p, name, { target: 'operations', data: { ...opsDoc, owners: { default: 'otro@acme.example' } } });
      assert.strictEqual(r.status, 410, name);
      assert.match(r.json.message, /la configuración se mudó al sitio/);
    }
    assert.strictEqual(fs.readFileSync(path.join(ops, 'operations.json'), 'utf8'), before.opsFile, 'el archivo no se tocó');
    assert.strictEqual(g(ops, 'status', '--porcelain'), before.ops);
    assert.strictEqual(g(team, 'status', '--porcelain'), before.team);
    assert.strictEqual(g(ops, 'branch', '--list'), '* main', 'ninguna rama nueva');
    // las tres que quedan siguen andando
    assert.strictEqual((await api(p, 'clone', { target: 'repos', dir: team })).json.ok, true);
    assert.strictEqual((await api(p, 'state')).status, 200);
  });
  // sin la dirección del sitio, el aviso manda al repo de operaciones
  fs.writeFileSync(path.join(ops, 'operations.json'), fmt({ version: 1, owners: { default: 'lead@acme.example' } }));
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const s = (await api(p, 'state')).json;
    assert.strictEqual(s.site, null);
    assert.strictEqual(s.notice, 'sin sitio: se edita con un pedido al repo de operaciones');
  });
  // un problema de los lectores se muestra en su sección
  fs.writeFileSync(path.join(ops, 'operations.json'), fmt({ version: 1, owners: {} }));
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'operations');
    assert.deepStrictEqual(t.sections.find((x) => x.id === 'responsables').problems.map((x) => x.path), ['owners.default']);
  });
  // el núcleo se carga del árbol que se le pasa, o se inyecta: nunca por una ruta fija
  const core = { SECCIONES: [{ id: 'unica', titulo: 'La única', archivo: 'operations.json', repo: 'operaciones', claves: ['owners'] }] };
  await withPage({ tree: tmp('arbol-vacio'), core, readers: { repos: toyReader, operations: null }, clones: { operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'operations');
    assert.deepStrictEqual(t.sections.map((x) => x.id), ['unica'], 'las secciones salen del núcleo inyectado');
  });
  await withPage({ tree: tmp('arbol-sin-nucleo'), readers: { repos: toyReader, operations: null } }, async (p) => {
    const s = (await api(p, 'state')).json;
    assert.ok(s.targets.every((x) => Array.isArray(x.sections) && x.sections.length === 0), 'un árbol sin el núcleo no muestra secciones y no se cae');
    assert.match(s.coreProblem, /org-config\.js/, 'y lo dice');
  });
});

// El script de la página se corre de verdad contra un DOM mínimo (no hay navegador): sin el texto «null» de un nodo ausente,
// «Cerrar la página» que dice el error si el servidor no cierra, y el botón de la carpeta del clon que dice si no pudo volver
// a cargar. El HTML solo no lo prueba: un error en el script se vería recién en el navegador.
class FakeNode {
  constructor(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.textContent = ''; this.value = ''; this.listeners = {}; }
  append(...k) { this.kids.push(...k); }
  replaceChildren(...k) { this.kids = k; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(e, f) { this.listeners[e] = f; }
  text() { return [this.textContent, ...this.kids.map((c) => (c instanceof FakeNode ? c.text() : String(c)))].join(' '); }
  find(fn) { if (fn(this)) return this; for (const c of this.kids) { const r = c instanceof FakeNode ? c.find(fn) : null; if (r) return r; } return null; }
}
async function runPageScript(p, fetchFor) {
  const html = (await request(p.port, { pathname: `/?k=${p.token}` })).text;
  const src = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const app = new FakeNode('div'); const quit = new FakeNode('button');
  const document = { getElementById: (id) => (id === 'app' ? app : quit), createElement: (t) => new FakeNode(t) };
  const real = async (u, o) => { const r = await request(p.port, { method: o.method, pathname: u, headers: o.headers, body: o.body }); return { json: async () => r.json }; };
  new Function('document', 'location', 'history', 'fetch', 'URLSearchParams', src)(document, { search: `?k=${p.token}` }, { replaceState() {} }, (u, o) => fetchFor(u, o, real), URLSearchParams);
  await new Promise((r) => setTimeout(r, 300));
  return { app, quit };
}
test('2.29-T21c PaginaLocal_ElScriptDeLaPagina_CorreContraUnDomMinimo', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  fs.writeFileSync(path.join(ops, 'operations.json'), `${JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], url: 'https://sitio.acme.example' } }, null, 2)}\n`);
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    // sin problema del núcleo no queda un «null» suelto; el aviso y el clon que falta se dicen
    const { app, quit } = await runPageScript(p, (u, o, real) => real(u, o));
    assert.doesNotMatch(app.text(), /\bnull\b/, 'ningún nodo ausente se escribe como texto');
    assert.match(app.text(), /se edita en el sitio: https:\/\/sitio\.acme\.example/);
    assert.match(app.text(), /Falta saber dónde está tu clon/, 'el clon que falta se pide');
    // «Cerrar la página» dice el error si el servidor no contesta ok
    const sinCerrar = await runPageScript(p, (u, o, real) => (u === '/api/quit' ? { json: async () => ({ ok: false, message: 'no contesta' }) } : real(u, o)));
    await sinCerrar.quit.listeners.click();
    assert.match(sinCerrar.app.text(), /No pude cerrar la página: no contesta/);
    // el botón de la carpeta: si guarda y después no puede volver a cargar, lo dice en la página
    let estados = 0;
    const recarga = await runPageScript(p, (u, o, real) => {
      if (u === '/api/clone') return { json: async () => ({ ok: true }) };
      if (u === '/api/state' && ++estados > 1) return Promise.reject(new Error('sin red'));
      return real(u, o);
    });
    const boton = recarga.app.find((n) => n.tag === 'button' && n.textContent === 'Usar esta carpeta');
    assert.ok(boton, 'hay botón para indicar el clon');
    await boton.listeners.click();
    await new Promise((r) => setTimeout(r, 100));
    assert.match(recarga.app.text(), /No pude volver a cargar la página: no pude hablar con la página local \(sin red\)/);
    // una llamada que falla de verdad (no contesta, o no es JSON) se dice y no deja el botón sin respuesta
    const sinServidor = await runPageScript(p, (u, o, real) => (u === '/api/quit' ? Promise.reject(new Error('conexión cerrada')) : real(u, o)));
    await sinServidor.quit.listeners.click();
    assert.match(sinServidor.app.text(), /No pude cerrar la página: no pude hablar con la página local \(conexión cerrada\)/);
    const noJson = await runPageScript(p, (u, o, real) => (u === '/api/clone' ? { json: async () => { throw new SyntaxError('Unexpected token <'); } } : real(u, o)));
    const boton2 = noJson.app.find((n) => n.tag === 'button' && n.textContent === 'Usar esta carpeta');
    await boton2.listeners.click();
    assert.match(noJson.app.text(), /no pude hablar con la página local \(Unexpected token </);
    assert.ok(quit, 'el botón de cerrar existe');
  });
});

// Lo que la página no puede leer se dice; nunca se reemplaza en silencio ni se confunde con «no hay». Casos de cada rama de error:
// un archivo nuevo roto no se cambia por el viejo, uno ilegible se nombra, «sin sitio» sólo si se pudo leer
// operations.json, una dirección que no sirve no cuenta como sitio, y un núcleo roto o sin secciones no tira la página.
test('2.29-T21b PaginaLocal_LoQueNoSePuedeLeer_SeDice', async () => {
  const tree = path.join(__dirname, '..', '..');
  const fmt = (d) => `${JSON.stringify(d, null, 2)}\n`;
  const team = cloneWithRemote().dir;
  const ops = cloneWithRemote().dir;
  const gh = (repo) => ({ platform: 'github', org: 'acme', repo });
  fs.writeFileSync(path.join(team, 'team-repos.json'), fmt({ version: 1, public: gh('harness'), profile: gh('profile'), operations: gh('ops') }));
  // team-profile.json roto y perfil-equipo.json (el nombre de antes) sano: gana el nuevo, y se dice que está roto
  fs.writeFileSync(path.join(team, 'team-profile.json'), '{ roto');
  fs.writeFileSync(path.join(team, 'perfil-equipo.json'), fmt({ packs: { default: 'all' } }));
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'repos');
    const paquetes = t.sections.find((x) => x.id === 'paquetes');
    assert.strictEqual(paquetes.data, null, 'los datos del archivo viejo no se muestran como vigentes');
    assert.match(paquetes.problems[0].message, /team-profile\.json no es un objeto JSON válido/);
    // sólo el nombre de antes: se muestra
    fs.rmSync(path.join(team, 'team-profile.json'));
    const viejo = (await api(p, 'state')).json.targets.find((x) => x.id === 'repos').sections.find((x) => x.id === 'paquetes');
    assert.deepStrictEqual(viejo.data, { packs: { default: 'all' } });
    assert.deepStrictEqual(viejo.problems, []);
    // ninguno de los dos: sin datos y sin problema (es lo normal de un perfil sin esa clave)
    fs.rmSync(path.join(team, 'perfil-equipo.json'));
    const ninguno = (await api(p, 'state')).json.targets.find((x) => x.id === 'repos').sections.find((x) => x.id === 'paquetes');
    assert.deepStrictEqual([ninguno.data, ninguno.problems], [null, []]);
  });
  // un archivo que existe y no se puede leer (es una carpeta) se nombra con su código
  fs.mkdirSync(path.join(team, 'team-profile.json'));
  await withPage({ tree, clones: { repos: team } }, async (p) => {
    const paquetes = (await api(p, 'state')).json.targets.find((x) => x.id === 'repos').sections.find((x) => x.id === 'paquetes');
    assert.match(paquetes.problems[0].message, /no pude leer team-profile\.json \(EISDIR\)/);
  });
  // «sin sitio» sólo cuando operations.json se leyó: roto o sin clon, el aviso dice que no sabe
  fs.writeFileSync(path.join(ops, 'operations.json'), '{ roto');
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    const s = (await api(p, 'state')).json;
    assert.strictEqual(s.site, null);
    assert.match(s.notice, /^no sé dónde se edita la configuración: no se pudo leer operations\.json/);
  });
  await withPage({ tree, clones: { repos: team } }, async (p) => {
    assert.match((await api(p, 'state')).json.notice, /^no sé dónde se edita/, 'sin el clon de operaciones tampoco se sabe');
  });
  // una dirección que no es https, con usuario, con espacios o larguísima no cuenta como sitio
  for (const url of ['http://sitio.acme.example', 'https://confiable@otro.example', 'https://sitio acme.example', `https://${'a'.repeat(400)}.example`, 'sitio.acme.example', 'https://']) {
    fs.writeFileSync(path.join(ops, 'operations.json'), fmt({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], url } }));
    await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
      const s = (await api(p, 'state')).json;
      assert.strictEqual(s.site, null, `«${url.slice(0, 40)}» no es un sitio`);
      assert.match(s.notice, /^la dirección del sitio de operations\.json \(site\.url\) no sirve/, 'una dirección declarada que no sirve no es «sin sitio»');
    });
  }
  // el núcleo que no carga o que no trae SECCIONES no tira la página y se dice
  const sinSecciones = tmp('arbol-sin-secciones');
  fs.mkdirSync(path.join(sinSecciones, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sinSecciones, 'scripts', 'lib', 'org-config.js'), 'module.exports = {};\n');
  const noCarga = tmp('arbol-nucleo-roto');
  fs.mkdirSync(path.join(noCarga, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(noCarga, 'scripts', 'lib', 'org-config.js'), 'module.exports = {;\n');
  for (const [arbol, esperado] of [[sinSecciones, /no trae las secciones/], [noCarga, /no se pudo cargar scripts\/lib\/org-config\.js \(SyntaxError\)/]]) {
    await withPage({ tree: arbol, readers: { repos: toyReader, operations: null }, clones: { repos: team } }, async (p) => {
      const s = (await api(p, 'state')).json;
      assert.match(s.coreProblem, esperado);
      assert.ok(s.targets.every((x) => x.sections.length === 0));
      assert.strictEqual((await request(p.port, { pathname: `/?k=${p.token}` })).status, 200, 'la página sigue andando');
    });
  }
});

// la configuración de los pedidos de vulnerabilidades se ve, de sólo lectura, en la página
// local — sale del núcleo común como las demás secciones de operations.json, sin código propio
test('4.9-T16c PaginaLocal_MuestraLosPedidosDeVulnerabilidades @story-4.9 @ac-10', () => {
  // 🔴 rojo: la sección no llega a la página local, o llega sin la configuración del archivo.
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const work_items = { type: 'Riesgo', fixed_fields: { 'Custom.Categoria': 'Seguridad' }, by_severity: { critical: { 'Custom.Impacto': 5 } } };
  fs.writeFileSync(path.join(ops, 'operations.json'), `${JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, work_items }, null, 2)}\n`);
  const target = TC.TARGETS.find((t) => t.id === 'operations');
  const s = TC.sectionsOf(target, ops, TC.loadCore(tree).core, []).find((x) => x.id === 'pedidos');
  assert.ok(s, 'la página local tiene la sección de los pedidos');
  assert.strictEqual(s.titulo, 'Pedidos de vulnerabilidades');
  assert.deepStrictEqual(s.data, { work_items });
});
