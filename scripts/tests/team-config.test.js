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

/** Un clon con un remoto bare local (y el nombre de rama main), listo para proponer. */
function cloneWithRemote() {
  const bare = tmp('bare');
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  const dir = tmp('clone');
  g(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'perfil\n');
  // el perfil ya pide una versión que admite team-repos.json en la capa: sin eso la página no propone el cambio (T6b)
  fs.writeFileSync(path.join(dir, 'team-layer.json'), `${JSON.stringify({ schema: 1, name: 'equipo', requires: { harness: `>= ${TC.TEAM_REPOS_SINCE}` } })}\n`);
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
    const big = await request(p.port, { method: 'POST', pathname: '/api/check', headers: { 'x-harness-key': p.token, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'repos', data: { x: 'a'.repeat(300 * 1024) } }) }).catch(() => ({ status: 400 }));
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

test('T5 Save_OnlyWhatTheReaderAccepts_TwoSpacesAndNewline', async () => {
  const { dir } = cloneWithRemote();
  const file = path.join(dir, 'team-repos.json');
  await withPage({ readers: { repos: toyReader, operations: null }, clones: { repos: dir } }, async (p) => {
    const bad = (await api(p, 'save', { target: 'repos', data: { version: 1, owners: ['x'] } })).json;
    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(bad.problems.map((x) => x.path).sort(), ['owners', 'public.repo']);
    assert.ok(!fs.existsSync(file), 'lo que el lector rechaza no se escribe');
    const chk = (await api(p, 'check', { target: 'repos', data: GOOD })).json;
    assert.deepStrictEqual(chk, { ok: true, problems: [] });
    assert.ok(!fs.existsSync(file), 'revisar no escribe');
    const ok = (await api(p, 'save', { target: 'repos', data: { __doc: 'se conserva', ...GOOD } })).json;
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify({ __doc: 'se conserva', ...GOOD }, null, 2)}\n`);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'sin temporales');
    const none = (await api(p, 'save', { target: 'operations', data: { version: 1 } })).json;
    assert.strictEqual(none.ok, false, 'sin lector no se guarda');
  });
});

test('T6 Plan_OnlyThisFile_NothingToPropose_PlatformFromOrigin', () => {
  const t = TC.TARGETS[0];
  const { dir } = cloneWithRemote();
  assert.match(TC.proposalPlan(t, dir, { env: ENV }).message, /no tiene cambios/);
  fs.writeFileSync(path.join(dir, t.file), TC.formatJson(GOOD));
  fs.writeFileSync(path.join(dir, 'otro.txt'), 'x');
  assert.match(TC.proposalPlan(t, dir, { env: ENV }).message, /otros cambios sin commitear \(otro\.txt\)/, 'el pedido no lleva lo que no se ve');
  fs.rmSync(path.join(dir, 'otro.txt'));
  const now = new Date('2026-10-13T23:30:05Z');
  const plain = TC.proposalPlan(t, dir, { env: ENV, now });
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.branch, 'team-config/repos-20261013-233005');
  assert.deepStrictEqual(plain.commands.map((c) => c.slice(0, 2).join(' ')), ['git switch', 'git add', 'git commit', 'git push']);
  assert.strictEqual(plain.pr, null, 'un remoto que no es de GitHub ni de Azure: sin pedido automático');
  g(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/team-profile.git');
  const gh = TC.proposalPlan(t, dir, { env: ENV, now });
  assert.deepStrictEqual(gh.pr.slice(0, 7), ['gh', 'pr', 'create', '--base', 'main', '--head', gh.branch]);
  assert.strictEqual(gh.manual, `https://github.com/acme/team-profile/compare/main...${gh.branch}?expand=1`);
  g(dir, 'remote', 'set-url', 'origin', 'https://dev.azure.com/acme/Mi%20Proyecto/_git/team-profile');
  const az = TC.proposalPlan(t, dir, { env: ENV, now });
  assert.deepStrictEqual(az.pr.slice(0, 5), ['az', 'repos', 'pr', 'create', '--detect']);
  assert.ok(az.manual.startsWith('https://dev.azure.com/acme/Mi%20Proyecto/_git/team-profile/pullrequestcreate?sourceRef=team-config%2Frepos-'));
});

test('T6b Plan_ProfileMustRequireAVersionThatAdmitsTeamRepos — sin eso, cada máquina anterior rechazaría la capa entera', () => {
  const t = TC.TARGETS[0];
  const { dir } = cloneWithRemote();
  fs.writeFileSync(path.join(dir, t.file), TC.formatJson(GOOD));
  const first = TC.proposalPlan(t, dir, { env: ENV });
  assert.strictEqual(first.ok, true, `con el perfil pidiendo la versión, se propone: ${first.message}`);
  for (const [req, why] of [['>= 2026.10.13.9', 'una anterior'], ['', 'sin pedir'], ['cualquiera', 'ilegible']]) {
    fs.writeFileSync(path.join(dir, 'team-layer.json'), `${JSON.stringify({ schema: 1, name: 'equipo', requires: { harness: req } })}\n`);
    g(dir, 'add', 'team-layer.json'); g(dir, 'commit', '-q', '-m', why);
    const r = TC.proposalPlan(t, dir, { env: ENV });
    assert.strictEqual(r.ok, false, `${why}: no se propone`);
    assert.match(r.message, /todavía no se puede proponer: .*rechazaría la capa entera/, why);
  }
  g(dir, 'rm', '-q', 'team-layer.json'); g(dir, 'commit', '-q', '-m', 'sin declaración');
  assert.match(TC.proposalPlan(t, dir, { env: ENV }).message, /no pude leer team-layer\.json/);
  // operations.json no llega a las máquinas: su propuesta no depende de la versión
  const o = TC.TARGETS[1];
  fs.writeFileSync(path.join(dir, o.file), '{"version":1,"owners":{"default":"a@b.example"}}\n');
  fs.rmSync(path.join(dir, t.file));
  const op = TC.proposalPlan(o, dir, { env: ENV });
  assert.strictEqual(op.ok, true, `operations: ${op.message}`);
});

test('T7 Propose_RealPushToTheRemote_PermissionSaidPlainly_MissingToolGivesTheLink', () => {
  const t = TC.TARGETS[0];
  const { dir, bare } = cloneWithRemote();
  fs.writeFileSync(path.join(dir, t.file), TC.formatJson(GOOD));
  const r = TC.runProposal(t, dir, { env: ENV });
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /abrí el pedido a mano/);
  assert.strictEqual(g(bare, 'show', `${r.branch}:${t.file}`), TC.formatJson(GOOD).trim(), 'el archivo llegó a la rama del remoto');
  assert.strictEqual(g(bare, 'rev-parse', 'main'), g(dir, 'rev-parse', 'origin/main'), 'main del remoto no se tocó');
  // un rechazo por permisos, con el texto de Azure DevOps
  const fake = (fail) => (cmd) => (cmd[1] === fail ? { ok: false, err: "remote: TF401027: You need the Git 'GenericContribute' permission to perform this action." } : { ok: true, out: '' });
  fs.writeFileSync(path.join(dir, 'team-repos.json'), TC.formatJson({ ...GOOD, version: 1, profile: GOOD.public }));
  const denied = TC.runProposal(t, dir, { env: ENV, run: fake('push') });
  assert.strictEqual(denied.ok, false);
  assert.match(denied.message, /^No tenés permiso para escribir en el repo de harness-team-profile/);
  assert.match(denied.message, /quedó guardado en tu clon, en la rama team-config\/repos-/);
  // sin gh: el cambio subió y la página da el enlace para abrir el pedido
  g(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/team-profile.git');
  const noTool = TC.runProposal(t, dir, { env: ENV, run: (cmd) => (cmd[0] === 'gh' ? { ok: false, missing: true, err: 'spawn gh ENOENT' } : { ok: true, out: '' }) });
  assert.strictEqual(noTool.ok, false);
  assert.match(noTool.message, /no encontré «gh» en esta máquina\)\. Abrilo desde: https:\/\/github\.com\/acme\/team-profile\/compare\/main\.\.\./);
});

test('T8 Browser_OpenOnMac_StartOnWindows_XdgOpenElsewhere', () => {
  const u = 'http://127.0.0.1:5/?k=ab';
  assert.deepStrictEqual(TC.browserCommand('darwin', u), ['open', [u]]);
  assert.deepStrictEqual(TC.browserCommand('win32', u), ['cmd', ['/c', 'start', '""', u]]);
  assert.deepStrictEqual(TC.browserCommand('linux', u), ['xdg-open', [u]]);
});

test('T9 Remote_GithubAzureVisualStudio_UnknownIsNull', () => {
  assert.deepStrictEqual(TC.remoteOf('git@github.com:acme/team-profile.git'), { platform: 'github', org: 'acme', repo: 'team-profile', web: 'https://github.com/acme/team-profile' });
  assert.strictEqual(TC.remoteOf('https://dev.azure.com/acme/Proj/_git/ops').platform, 'azure');
  assert.deepStrictEqual(TC.remoteOf('https://acme.visualstudio.com/Mi%20Proyecto/_git/ops'), { platform: 'azure', org: 'acme', project: 'Mi Proyecto', repo: 'ops', web: 'https://dev.azure.com/acme/Mi%20Proyecto/_git/ops' });
  assert.deepStrictEqual(TC.remoteOf('/tmp/bare'), { platform: null, web: null });
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
  const repos = { __doc: 'de prueba', version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: azure('team-profile'), operations: azure('team-operations'), harness_copies: [azure('old-copy')] };
  const opsData = { version: 1, owners: { default: 'owner@acme.example', by_project: { 'Proyecto A': 'lead@acme.example' } }, reviewers: { dependencies: ['rev@acme.example'] } };
  await withPage({ tree, clones: { repos: team, operations: ops } }, async (p) => {
    assert.deepStrictEqual((await api(p, 'save', { target: 'repos', data: repos })).json.ok, true);
    assert.deepStrictEqual((await api(p, 'save', { target: 'operations', data: opsData })).json.ok, true);
    const s = (await api(p, 'state')).json.targets;
    assert.deepStrictEqual(s.map((t) => [t.state, t.problems.length]), [['loaded', 0], ['loaded', 0]]);
    assert.deepStrictEqual(s[0].data, repos, 'lo guardado se vuelve a leer igual, con su comentario');
    // la lista de responsables no va en el archivo que llega a todas las máquinas
    const owners = (await api(p, 'check', { target: 'repos', data: { ...repos, owners: ['x'] } })).json;
    assert.deepStrictEqual(owners.problems.map((x) => x.path), ['owners']);
    // un proyecto de Azure que falta y un nombre con un carácter que no va: cada uno en la ruta de su campo
    const bad = (await api(p, 'check', { target: 'repos', data: { ...repos, operations: { platform: 'azure', org: 'acme', repo: 'ops' }, harness_copies: [azure('mal/nombre')] } })).json;
    assert.deepStrictEqual(bad.problems.map((x) => x.path).sort(), ['harness_copies.0.repo', 'operations.project']);
    const noDefault = (await api(p, 'check', { target: 'operations', data: { version: 1, owners: {} } })).json;
    assert.deepStrictEqual(noDefault.problems.map((x) => x.path), ['owners.default']);
  });
});

// story 2.28 (AC 19): la página no dibuja `people` (quién es quién), pero tampoco la pierde. Se hace lo que hace la
// página: lee el estado, cambia el responsable por defecto en el borrador y guarda el borrador entero.
test('T24 GuardarOwners_ConservaPeople', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const file = path.join(ops, 'operations.json');
  const people = {
    machines: {
      'maq-uno-1a2b3c4d': { person: 'dev.uno@acme.example', reported_sha256: 'a'.repeat(64), confirmed_by: 'lead@acme.example', confirmed_on: '2026-10-15' },
      'maq-dos-5e6f7a8b': { person: 'dev.dos@acme.example', reported_sha256: null, confirmed_by: 'lead@acme.example', confirmed_on: '2026-10-15' },
    },
    projects: { 'dev.uno@acme.example': { add: ['Gama'], remove: ['Beta'] } },
  };
  fs.writeFileSync(file, TC.formatJson({ version: 1, owners: { default: 'lead@acme.example' }, people }));
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'operations');
    assert.deepStrictEqual([t.state, t.problems], ['loaded', []], 'el lector acepta people');
    const draft = JSON.parse(JSON.stringify(t.data));
    draft.owners.default = 'otro-lead@acme.example';
    const r = (await api(p, 'save', { target: 'operations', data: draft })).json;
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.owners.default, 'otro-lead@acme.example', 'el cambio de owners se guardó');
  assert.deepStrictEqual(saved.people, people, 'people sigue igual');
  // y el texto de alcance ya no dice que lo leen sólo los procesos de la noche: lo lee también el sitio de la organización
  const reach = TC.TARGETS.find((x) => x.id === 'operations').reach;
  assert.doesNotMatch(reach, /sólo los procesos de la noche/);
  assert.match(reach, /el sitio de la organización/);
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

// story 2.23: la página no dibuja `site`, pero el borrador es una copia del archivo que el lector aceptó: guardar
// `owners` lo conserva igual. Rojo previo: el lector rechazaba `site`, el estado venía sin datos y el borrador nacía vacío.
test('2.23-T5 TeamConfig_ConservaSite', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const site = { maintainers: ['lead@acme.example'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' }, refresh_minutes: 20 };
  const file = path.join(ops, 'operations.json');
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, site }, null, 2)}\n`);
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'operations');
    assert.strictEqual(t.state, 'loaded');
    assert.deepStrictEqual(t.problems, []);
    assert.deepStrictEqual(t.data.site, site, 'el borrador de la página trae site');
    const draft = JSON.parse(JSON.stringify(t.data));
    draft.owners.default = 'other@acme.example';
    assert.strictEqual((await api(p, 'save', { target: 'operations', data: draft })).json.ok, true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.owners.default, 'other@acme.example');
    assert.deepStrictEqual(saved.site, site, 'site sigue igual en el archivo guardado');
  });
});

// ── story 2.22: la sección de despliegues y la ayuda que propone los stages (AC 1 y 18) ─────────────────────────────
const AZ_FAKE = path.join(__dirname, 'lib', 'fake-az.sh');
function fakeAz() {
  const d = tmp('az');
  const fix = path.join(d, 'fix'); fs.mkdirSync(fix);
  const az = path.join(d, 'az'); fs.copyFileSync(AZ_FAKE, az); fs.chmodSync(az, 0o755);
  const w = (n, v) => fs.writeFileSync(path.join(fix, n), JSON.stringify(v));
  return { fix, az, w };
}
const DEPLOY = { provider: 'azure', products: { Acme: { production: [{ pipeline: 'Proy/Acme Prod', stages: ['DeployProd'] }] } } };

test('2.22-T3 TeamConfig_SeccionDespliegues', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const file = path.join(ops, 'operations.json');
  fs.writeFileSync(file, TC.formatJson({ version: 1, owners: { default: 'lead@acme.example' }, deployments: DEPLOY }));
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    const t = (await api(p, 'state')).json.targets.find((x) => x.id === 'operations');
    assert.deepStrictEqual([t.state, t.problems], ['loaded', []], 'el lector real acepta deployments');
    assert.deepStrictEqual(t.data.deployments, DEPLOY);
    // un problema se marca en su campo, con la ruta del lector real (sin validador propio)
    const bad = (await api(p, 'check', { target: 'operations', data: { ...t.data, deployments: { provider: 'azure', products: { Acme: { production: [{ pipeline: 'Proy/Acme Prod', stages: [] }] } } } } })).json;
    assert.deepStrictEqual(bad.problems.map((x) => x.path), ['deployments.products.Acme.production.0.stages']);
    const draft = JSON.parse(JSON.stringify(t.data)); draft.owners.default = 'otro@acme.example';
    assert.strictEqual((await api(p, 'save', { target: 'operations', data: draft })).json.ok, true);
    const page = (await request(p.port, { pathname: `/?k=${p.token}` })).text;
    assert.match(page, /Despliegues por producto/);
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deployments, DEPLOY, 'guardar no pierde deployments');
});

test('2.22-T23 TeamConfig_ProponeStagesDelPipeline', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const file = path.join(ops, 'operations.json');
  fs.writeFileSync(file, TC.formatJson({ version: 1, owners: { default: 'lead@acme.example' } }));
  const antes = fs.readFileSync(file);
  const { fix, az, w } = fakeAz();
  w('definiciones-Proy.json', [{ id: 9, name: 'Acme Prod' }, { id: 8, name: 'Acme Prod Viejo' }, { id: 7, name: 'Sin Corridas' }]);
  w('builds-9.json', [
    { id: 51, status: 'inProgress', result: null, sourceBranch: 'refs/heads/main', queueTime: '2026-10-15T00:00:00Z' },
    { id: 50, status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', queueTime: '2026-10-14T00:00:00Z' },
  ]);
  w('timeline-50.json', { records: [
    { type: 'Stage', identifier: 'DeployNonProd', name: 'Staging visible', state: 'completed', result: 'succeeded' },
    { type: 'Stage', identifier: 'DeployProd', name: 'Producción visible', state: 'completed', result: 'skipped' },
    { type: 'Job', identifier: 'UnJob', name: 'job' },
  ] });
  const env = { ...ENV, FIXAZ: fix, TYCON_ADO_CMD: az };
  await withPage({ tree, clones: { operations: ops }, env }, async (p) => {
    const r = (await api(p, 'propose-stages', { target: 'operations', provider: 'azure', pipeline: 'Proy/Acme Prod', org: 'https://dev.azure.com/prueba' })).json;
    assert.strictEqual(r.ok, true, r.message);
    assert.deepStrictEqual(r.proposals, [{ id: 'DeployNonProd', name: 'Staging visible', state: 'propuesto' }, { id: 'DeployProd', name: 'Producción visible', state: 'propuesto' }]);
    const sin = (await api(p, 'propose-stages', { target: 'operations', provider: 'azure', pipeline: 'Proy/Sin Corridas', org: 'https://dev.azure.com/prueba' })).json;
    assert.strictEqual(sin.ok, false);
    assert.deepStrictEqual(sin.proposals, []);
    assert.match(sin.message, /main/);
  });
  assert.ok(fs.readFileSync(file).equals(antes), 'la propuesta no se guarda: operations.json byte a byte igual');
  const pasos = fs.readFileSync(path.join(fix, 'llamadas.log'), 'utf8');
  assert.match(pasos, /timeline/, 'los stages salen del timeline de la última corrida terminada de main');
  assert.doesNotMatch(pasos, /buildId=51/, 'nunca de una corrida sin terminar');
});

test('2.22-T24 TeamConfig_SoloLoConfirmadoSeGuarda', async () => {
  const tree = path.join(__dirname, '..', '..');
  const ops = cloneWithRemote().dir;
  const file = path.join(ops, 'operations.json');
  fs.writeFileSync(file, TC.formatJson({ version: 1, owners: { default: 'lead@acme.example' } }));
  await withPage({ tree, clones: { operations: ops } }, async (p) => {
    // la persona confirma DeployProd en production; DeployNonProd quedó propuesto y sin confirmar
    const draft = { version: 1, owners: { default: 'lead@acme.example' }, deployments: TC.confirmStage({}, { provider: 'azure', product: 'Acme', side: 'production', pipeline: 'Proy/Acme Prod', stage: 'DeployProd' }) };
    assert.strictEqual((await api(p, 'save', { target: 'operations', data: draft })).json.ok, true);
  });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).deployments;
  assert.deepStrictEqual(saved, DEPLOY, 'sólo lo confirmado');
  // y la foto: sin staging confirmado, staging sale no medido
  const out = tmp('foto');
  const reposFile = path.join(out, 'repos.json');
  fs.writeFileSync(reposFile, JSON.stringify({ azure: { org: 'https://dev.azure.com/prueba' }, repos: [{ producto: 'Acme', ado: 'Proy/a' }] }));
  const { fix, az, w } = fakeAz();
  w('definiciones-Proy.json', [{ id: 9, name: 'Acme Prod' }]);
  execFileSync(process.execPath, [path.join(tree, 'scripts', 'nightly', 'deployments', 'deployments.js'), '--today', '2026-10-15', '--out', out, '--repos', reposFile, '--operations', file],
    { env: { ...ENV, FIXAZ: fix, TYCON_ADO_CMD: az, TF_BUILD: '' } });
  const foto = JSON.parse(fs.readFileSync(path.join(out, 'deployments-2026-10-15.json'), 'utf8'));
  assert.strictEqual(foto.productos.Acme.staging.estado, 'no_medido');
  assert.strictEqual(foto.productos.Acme.staging.motivo, 'sin_declarar');
});

test('2.22-T25 TeamConfig_AyudaSinAcceso_DiceElMotivo', async () => {
  const { fix, az, w } = fakeAz();
  w('definiciones-Proy.json', [{ id: 9, name: 'Acme Prod' }]);
  w('builds-9.json', [{ id: 50, status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', queueTime: '2026-10-14T00:00:00Z' }]);
  const falla = TC.proposeStages({ provider: 'azure', pipeline: 'Proy/Acme Prod', org: 'https://dev.azure.com/prueba', env: { ...ENV, FIXAZ: fix, TYCON_ADO_CMD: az, TYCON_AZ_FAIL: 'timeline' } });
  assert.strictEqual(falla.ok, false);
  assert.deepStrictEqual(falla.proposals, []);
  assert.match(falla.message, /no pude leer el pipeline/);
  assert.match(falla.message, /a mano/);
  const sinAz = TC.proposeStages({ provider: 'azure', pipeline: 'Proy/Acme Prod', org: 'https://dev.azure.com/prueba', env: { ...ENV, TYCON_ADO_CMD: path.join(tmp('nada'), 'az-que-no-existe') } });
  assert.strictEqual(sinAz.ok, false);
  assert.deepStrictEqual(sinAz.proposals, []);
  assert.match(sinAz.message, /no pude leer el pipeline/);
  // la cabecera dice que también sale a la red al pedir la propuesta
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'harness', 'team-config.js'), 'utf8').split('\n').slice(0, 30).join('\n');
  assert.match(src, /propuesta/);
});

test('2.22-T25b TeamConfig_OrgYRepoValidados (revisores)', () => {
  const { fix, az } = fakeAz();
  const env = { ...ENV, FIXAZ: fix, TYCON_ADO_CMD: az };
  const org = TC.proposeStages({ provider: 'azure', pipeline: 'Proy/Acme Prod', org: 'https://host-ajeno.example/x', env });
  assert.strictEqual(org.ok, false);
  assert.match(org.message, /dev\.azure\.com/);
  assert.ok(!fs.existsSync(path.join(fix, 'llamadas.log')), 'az no se llamó con una organización ajena');
  const repo = TC.proposeStages({ provider: 'github', repo: '../..', env });
  assert.strictEqual(repo.ok, false);
  assert.match(repo.message, /dueño\/repo/);
});

// Chequeo textual a propósito: la página no se ejecuta en un navegador en esta suite. El servidor, en cambio, se prueba
// de verdad en T23/T25b: con la organización del pedido propone, con una ajena no llama a az.
test('2.22-A11 TeamConfig_LaPaginaMandaLaOrganizacion (pase adversarial)', async () => {
  await withPage({ tree: path.join(__dirname, '..', '..') }, async (p) => {
    const page = (await request(p.port, { pathname: `/?k=${p.token}` })).text;
    assert.match(page, /dev\.azure\.com\/<organización>/, 'la página pide la organización');
    assert.match(page, /org: gh \? undefined : \(org\.value\.trim\(\) \|\| undefined\)/, 'y la manda en el pedido');
  });
});
