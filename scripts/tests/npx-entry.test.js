'use strict';

/**
 * npx-entry.test.js — `harness.js npx`: lo que sigue a la bajada del paquete de npm (scripts/setup/harness/npx.js).
 *
 *   · T6  — `requisites()` por plataforma: Windows pide pwsh 7 y tar; fuera de Windows, bash, tar y python3 (éste salvo que
 *           se pida SÓLO Codex); `--tool` se lee como lo lee install; en una Mac sin las herramientas de línea de comandos
 *           el python3 de /usr/bin no cuenta; un xcode-select que no se pudo correr no afirma nada; un Node viejo se nombra.
 *   · T7  — «para quién» (`--audience`), `--team` con `parseTeam` (GitHub y Azure), el permiso de lectura (se pide, se
 *           guarda, o alcanza el del gestor de git), el agente instalado, sin terminal y sin --yes (la línea exacta), y una
 *           configuración que está y no se lee (sale 1 sin tocarla).
 *   · T8  — una máquina con el arnés: «al día», la pregunta «¿Actualizo?» y el `update` del árbol que corre (no el del
 *           instalado); con `--audience org` el `team-init` y con `--team` sin capa el `install --team`, también de este árbol.
 *   · T9  — un solo número de versión: el instalado no se nombra como si fuera el actual.
 *   · T10 — el paquete 1.0.x (el de la historia de git) contra el árbol de esta rama sigue instalando con
 *           `harness.js install --version latest`.
 *   · 8.46 T15 / T44 — la ayuda dice el defecto «para mí» y el único sí; sin Claude Code ni Codex salen las órdenes de tools.js.
 *
 * El subcomando corre en un proceso hijo (un guion de juguete le inyecta lo que toca la máquina: el hijo que lanzaría, la
 * terminal, el permiso pegado) contra un GitHub de juguete en este proceso. Sin red de verdad.
 * Correr: node --test scripts/tests/npx-entry.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NPX = path.join(ROOT, 'scripts', 'setup', 'harness', 'npx.js');
const HARNESS = path.join(ROOT, 'scripts', 'setup', 'harness.js');
const TL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));
const N = require(NPX);
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const OLD = 'b'.repeat(40);   // el commit instalado
const NEW = 'c'.repeat(40);    // la punta que trajo el paquete
const MAIN_REPO = 'TYCON-SA/tycon-harness';

// el guion del hijo: corre `run` con lo que toca la máquina inyectado, y dice qué hijos habría lanzado
const DRIVER = [
  "'use strict';",
  'const N = require(process.argv[2]); const spec = JSON.parse(process.argv[3]); const launches = [];',
  'const io = { tty: Boolean(spec.tty), line: () => (spec.answer === undefined ? "" : spec.answer), secret: () => spec.secret || "",',
  '  launch: (what, args) => { launches.push({ what, args }); return spec.status === undefined ? 0 : spec.status; } };',
  'if (spec.tools) io.tools = (n) => `/x/bin/${n}`;',
  'const r = N.run({ env: process.env, home: process.env.HOME, argv: spec.argv }, io);',
  'process.stdout.write(JSON.stringify({ code: r.code, launches }));', ''].join('\n');

/** Un GitHub de juguete: `routes(url)` → `{ status, body }`; anota cada pedido. */
async function serve(routes) {
  const seen = [];
  const srv = http.createServer((q, r) => { seen.push(q.url); const x = routes(q.url, q.headers) || { status: 404, body: '{}' }; r.writeHead(x.status, x.headers || {}); r.end(x.body); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}
const gitRefs = (repo) => (u) => (u.startsWith(`/${repo}.git/info/refs`) ? { status: 200, body: Buffer.from(`001e# service=git-upload-pack\n0000003f${OLD} refs/heads/main\n0000`, 'latin1') } : null);

/** Un estado de arnés instalado de juguete, con su árbol (que sólo sirve para nombrarlo). */
function installedAt(home, { commit = OLD, repo = MAIN_REPO, ref = 'main', release = true, team = null } = {}) {
  const own = path.join(home, '.tycon'); const tree = path.join(own, 'harness');
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'setup', 'harness.js'), '// el arnés instalado: no tiene que correr\n');
  fs.mkdirSync(path.join(own, 'state'), { recursive: true });
  const sources = release ? [{ name: 'harness', kind: 'release', url: `https://github.com/${repo}`, repo, ref, commit, tree, version: '1.2.3' }] : [{ name: 'harness', kind: 'tree', tree }];
  fs.writeFileSync(path.join(own, 'state', 'harness-state.json'), JSON.stringify({ schema: 1, tree, sources, version: { number: '1.2.3' }, team, mode: 'managed', channel: 'stable' }));
  return tree;
}

/**
 * `run` en un hijo. `spec`: argv, tty, answer (lo que se contesta a la pregunta), secret (el permiso pegado), status (lo que
 * devuelven los hijos lanzados), tools (todos los requisitos presentes; por defecto sí). Devuelve `{ code, out, launches, home }`.
 */
async function drive(box, spec, { env = {}, server = null, agent = true, home = null } = {}) {
  const h = home || fs.mkdtempSync(path.join(box, 'home-'));
  if (agent) fs.writeFileSync(path.join(h, '.claude.json'), '{}');
  const driver = path.join(box, 'driver.js'); fs.writeFileSync(driver, DRIVER);
  const e = Object.assign({ PATH: process.env.PATH, HOME: h, USERPROFILE: h, TYCON_HOME: path.join(h, '.tycon'), TYCON_NPX_COMMIT: NEW, TYCON_NPX_REPO: MAIN_REPO,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(h, 'gitconfig'), TYCON_AZURE_GIT_CREDENTIAL: '0' }, server ? { TYCON_RELEASE_API: server.base, TYCON_RELEASE_GIT: server.base, TYCON_RELEASE_ARCHIVE: server.base } : {}, env);
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) e[k] = process.env[k];
  const child = spawn(process.execPath, [driver, NPX, JSON.stringify(Object.assign({ tools: true }, spec))], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', out = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { out += d; });
  const status = await new Promise((res) => child.on('close', res));
  let r = { code: null, launches: [] };
  try { r = JSON.parse(stdout); } catch (_) { out += `\n(sin resultado, salió ${status}) ${stdout}`; }
  return { code: r.code, out, launches: r.launches, home: h };
}
const treeArgs = (...a) => [HARNESS, ...a];
const installArgs = (...a) => treeArgs('install', '--version', 'latest', '--repo', MAIN_REPO, ...a);

test('T6 NpxEntry_Requisitos @story-8.80 @ac-5', (t) => {
  assert.strictEqual(typeof N.requisites, 'function', 'requisites() exportada');
  const have = (...names) => (n) => names.includes(n);
  const V = '24.0.0';
  // Windows sin pwsh: lo nombra con el comando sugerido; tar sí está
  const win = N.requisites({ platform: 'win32', tools: have('tar'), nodeVersion: V, args: [] });
  assert.strictEqual(win.length, 1, JSON.stringify(win));
  assert.match(win[0], /pwsh/); assert.match(win[0], /7/); assert.match(win[0], /winget install Microsoft\.PowerShell/);
  assert.match(win[0], /no lo corro/);
  // en Windows no se piden bash ni python3
  assert.deepStrictEqual(N.requisites({ platform: 'win32', tools: have('tar', 'pwsh'), nodeVersion: V, args: [] }), []);
  // una Mac sin bash: lo nombra (brew)
  const mac = N.requisites({ platform: 'darwin', tools: have('tar', 'python3'), nodeVersion: V, args: [], clt: true });
  assert.strictEqual(mac.length, 1); assert.match(mac[0], /falta bash/); assert.match(mac[0], /brew install bash/);
  // sólo Codex: python3 no hace falta; Claude y Codex: sí
  assert.deepStrictEqual(N.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: V, args: ['--tool', 'codex'] }), []);
  const both = N.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: V, args: ['--tool', 'claude', '--tool', 'codex'] });
  assert.strictEqual(both.length, 1); assert.match(both[0], /python3/);
  // sin opciones (Claude Code por defecto): python3 es requisito
  assert.strictEqual(N.requisites({ platform: 'linux', tools: have('tar', 'bash'), nodeVersion: V, args: [] }).length, 1);
  // un Node viejo se nombra con la versión que hay y el piso (20 ya no alcanza para instalar)
  const old = N.requisites({ platform: 'darwin', tools: have('tar', 'bash', 'python3'), nodeVersion: '20.19.0', args: [], clt: true });
  assert.strictEqual(old.length, 1); assert.match(old[0], /20\.19\.0/); assert.match(old[0], new RegExp(String(N.NODE_FLOOR)));
  assert.deepStrictEqual(N.requisites({ platform: 'darwin', tools: have('tar', 'bash', 'python3'), nodeVersion: '22.0.0', args: [], clt: true }), [], 'Node 22 alcanza');
  // dos faltas: una línea por cada una
  assert.strictEqual(N.requisites({ platform: 'darwin', tools: have(), nodeVersion: V, args: [] }).length, 3);
  // Windows: tar por ruta absoluta (el de System32), nunca el primero que aparezca: un tar.exe en el PATH no lo cumple
  assert.strictEqual(N.tarCmd({ SystemRoot: 'C:\\Windows' }, 'win32'), 'C:\\Windows\\System32\\tar.exe');
  assert.strictEqual(N.tarCmd({}, 'darwin'), 'tar');
  const box = tmp('npx-wintar-');
  try {
    fs.writeFileSync(path.join(box, 'tar.exe'), '');
    const noSys = N.requisites({ platform: 'win32', env: { PATH: box, PATHEXT: '.EXE', SystemRoot: path.join(box, 'no-existe') }, nodeVersion: V, args: [] });
    assert.ok(noSys.some((l) => /falta tar/.test(l)), `un tar.exe en el PATH no cuenta: ${JSON.stringify(noSys)}`);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
  // ninguna variable de entorno cambia la plataforma
  const src = read(NPX);
  assert.ok(!/env\.[A-Z_]*(PLATFORM|OSTYPE|\bOS\b)/.test(src) && !/process\.env\.OS\b/.test(src), 'la plataforma no sale de una variable');
  // `--tool` como lo lee install (tools.parseOption): comas, mayúsculas, espacios
  for (const args of [['--tool', 'codex', '--tool', 'CLAUDE'], ['--tool', 'Codex'], ['--tool', ' codex '], ['--tool', 'codex,claude'], ['--tool=CODEX'],
    ['--tool', 'claude'], ['--tool', 'Codex,'], ['--tool=codex', '--tool=Claude']]) {
    const p = TL.parseOption(toolValues(args));
    assert.ok(p.ok, `${JSON.stringify(args)}: install lo acepta`);
    const needsPython = !(p.tools.length === 1 && p.tools[0] === 'codex');
    const gate = N.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: V, args, clt: true });
    assert.strictEqual(gate.some((l) => /python3/.test(l)), needsPython, `${JSON.stringify(args)}: install instala ${JSON.stringify(p.tools)}`);
  }
  // en una Mac sin las herramientas de línea de comandos, /usr/bin/python3 sólo pide instalarlas
  const stub = (n) => (n === 'python3' ? '/usr/bin/python3' : ['tar', 'bash'].includes(n));
  const noClt = N.requisites({ platform: 'darwin', tools: stub, nodeVersion: V, args: [], clt: false });
  assert.strictEqual(noClt.length, 1, JSON.stringify(noClt));
  assert.match(noClt[0], /python3/); assert.match(noClt[0], /xcode-select --install/); assert.match(noClt[0], /no lo corro/);
  assert.deepStrictEqual(N.requisites({ platform: 'darwin', tools: stub, nodeVersion: V, args: [], clt: true }), [], 'con las herramientas, el de /usr/bin vale');
  assert.deepStrictEqual(N.requisites({ platform: 'darwin', tools: (n) => (n === 'python3' ? '/opt/homebrew/bin/python3' : true), nodeVersion: V, args: [], clt: false }), [], 'otro python3 primero en el PATH no depende de las herramientas');
  assert.deepStrictEqual(N.requisites({ platform: 'darwin', tools: stub, nodeVersion: V, args: ['--tool', 'codex'], clt: false }), [], 'sólo Codex no pide python3');
  assert.deepStrictEqual(N.requisites({ platform: 'linux', tools: stub, nodeVersion: V, args: [], clt: false }), [], 'fuera de la Mac no se mira');
  // un xcode-select que no se pudo correr (no está, o lo corta una señal) no afirma que faltan las herramientas; uno que corre y dice que no están, sí
  if (process.platform === 'win32') { t.diagnostic('NO MEDIDO: el xcode-select de mentira es un guion de shell'); return; }
  const dir = tmp('npx-xcode-'); const before = process.env.PATH;
  const fake = (body) => { const bin = fs.mkdtempSync(path.join(dir, 'bin-')); const f = path.join(bin, 'xcode-select'); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); return bin; };
  const gate = (PATH) => { process.env.PATH = PATH; try { return N.requisites({ platform: 'darwin', tools: stub, nodeVersion: V, args: [] }); } finally { process.env.PATH = before; } };
  try {
    assert.deepStrictEqual(gate(fs.mkdtempSync(path.join(dir, 'vacio-'))), [], 'sin xcode-select no se afirma que faltan las herramientas');
    assert.deepStrictEqual(gate(fake('kill -9 $$')), [], 'un xcode-select cortado por una señal no afirma que faltan');
    const no = gate(fake('exit 2'));
    assert.strictEqual(no.length, 1, JSON.stringify(no)); assert.match(no[0], /xcode-select --install/);
    assert.deepStrictEqual(gate(fake('echo /Library/Developer/CommandLineTools; exit 0')), [], 'con las herramientas, nada falta');
  } finally { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); }
});
const toolValues = (args) => args.flatMap((a, i) => (a === '--tool' ? [args[i + 1]] : (a.startsWith('--tool=') ? [a.slice(7)] : [])));

test('T7 NpxEntry_ParaQuienYEquipo @story-8.80 @ac-5 @ac-6', async () => {
  const box = tmp('npx-team-');
  try {
    // las bibliotecas del árbol, no copias
    const src = read(NPX);
    for (const lib of ['team.js', 'team-azure.js', 'github-auth.js', 'tools.js', 'prompt.js', 'state.js']) assert.ok(src.includes(`require('./${lib}')`), `usa ${lib}`);
    assert.ok(/T\.parseTeam\(/.test(src), '--team con parseTeam');
    assert.ok(!/home-paths|teamShape|agentFound/.test(src), 'sin las copias del paquete');
    // «para quién»
    let r = await drive(box, { argv: ['--audience', 'nadie', '--yes'] });
    assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /--audience es me, team u org: nadie/); assert.deepStrictEqual(r.launches, []);
    r = await drive(box, { argv: ['--audience', 'team', '--tool', 'codex'] });
    assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /--audience team pide --team/);
    // el repo del perfil que no vale (y uno de esta máquina, que `parseTeam` acepta pero acá no): 2 sin instalar
    for (const bad of ['acme/..', 'acme', 'https://gitlab.com/acme/perfil', '/tmp/un-perfil-local']) {
      r = await drive(box, { argv: ['--team', bad, '--yes'] });
      assert.strictEqual(r.code, 2, `${bad}: ${r.out}`); assert.match(r.out, /el repo del perfil tiene que ser/); assert.deepStrictEqual(r.launches, [], bad);
    }
    // el agente: sin Claude Code ni Codex sale 1 con las órdenes de tools.js
    r = await drive(box, { argv: ['--yes'] }, { agent: false, env: { TYCON_TOOLS_DETECT_PATH: '' } });
    assert.strictEqual(r.code, 1, r.out); assert.deepStrictEqual(r.launches, []);
    assert.ok(r.out.includes(TL.noneFound(process.platform)), 'dice lo mismo que tools.noneFound');
    r = await drive(box, { argv: ['--yes'] }, { agent: false, env: { TYCON_TOOLS_DETECT_PATH: '', TYCON_CODEX: '1' } });
    assert.strictEqual(r.code, 0, `TYCON_CODEX=1 alcanza: ${r.out}`);
    // sin terminal y sin --yes: la línea exacta para confirmar
    r = await drive(box, { argv: ['--tool', 'codex', '--profile', 'full x'] });
    assert.strictEqual(r.code, 2, r.out); assert.deepStrictEqual(r.launches, []);
    assert.ok(r.out.includes("sin terminal no puedo preguntarte «¿Instalo?»: para instalar igual, corré npx @tyconsa/harness@latest --tool codex --profile 'full x' --yes. No instalé nada."), r.out);
    r = await drive(box, { argv: ['--dry-run', '--tool', 'codex'] });
    assert.strictEqual(r.code, 0, `--dry-run no pide terminal: ${r.out}`);
    assert.deepStrictEqual(r.launches[0].args, installArgs('--defaults', '--dry-run', '--tool', 'codex'));
    // la salida del hijo es la del paquete; sin `--defaults` repetido si ya vino
    r = await drive(box, { argv: ['--yes', '--defaults'], status: 5 });
    assert.strictEqual(r.code, 5); assert.deepStrictEqual(r.launches[0].args, installArgs('--yes', '--defaults'));

    // --team de GitHub: las formas que parseTeam acepta llegan a install como org/repo, después de mirar el repo del equipo
    const gh = await serve(gitRefs('acme/team-profile'));
    try {
      for (const form of ['https://github.com/acme/team-profile', 'https://GitHub.com/acme/team-profile.git', 'https://github.com/acme/team-profile/', 'acme/team-profile']) {
        r = await drive(box, { argv: ['--team', form, '--yes', '--tool', 'codex'] }, { server: gh });
        assert.strictEqual(r.code, 0, `${form}: ${r.out}`);
        assert.deepStrictEqual(r.launches[0].args, installArgs('--team', 'acme/team-profile', '--defaults', '--yes', '--tool', 'codex'), form);
      }
      assert.ok(gh.seen.some((u) => u.startsWith('/acme/team-profile.git/info/refs')), `miró el repo del equipo: ${JSON.stringify(gh.seen)}`);
      // la forma `--team=<repo>`
      r = await drive(box, { argv: ['--team=acme/team-profile', '--yes', '--tool', 'codex'] }, { server: gh });
      assert.strictEqual(r.code, 0, r.out); assert.ok(r.launches[0].args.includes('acme/team-profile'));
    } finally { gh.close(); }
    // con `--audience org`, después de un install que sale 0 y deja el arnés, el team-init de ESTE árbol
    const org = await serve(() => null);
    try {
      const noInstall = await drive(box, { argv: ['--audience', 'org', '--yes', '--tool', 'codex'] }, { server: org });
      assert.strictEqual(noInstall.code, 0, noInstall.out); assert.match(noInstall.out, /no se instaló nada/);
      assert.strictEqual(noInstall.launches.length, 1, 'install, y sin arnés instalado no hay alta');
    } finally { org.close(); }

    // el permiso del repo del equipo en GitHub: 404 sin terminal sale 1 antes de instalar; con terminal se pide y se guarda
    const priv = await serve(() => ({ status: 404, body: '{}' }));
    try {
      r = await drive(box, { argv: ['--team', 'acme/team-profile', '--yes', '--tool', 'codex'] }, { server: priv });
      assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /no se puede leer sin un permiso de GitHub/); assert.deepStrictEqual(r.launches, []);
      const pat = ['permiso', 'github', 'de', 'laboratorio'].join('-');
      r = await drive(box, { argv: ['--team', 'acme/team-profile', '--yes', '--tool', 'codex'], tty: true, secret: pat }, { server: priv });
      assert.strictEqual(r.code, 0, r.out);
      assert.strictEqual(JSON.parse(read(path.join(r.home, '.tycon', 'config.json'))).github.token, pat, 'el permiso pedido se guarda para install --team');
      assert.ok(!r.out.includes(pat), 'el permiso no sale en pantalla');
      r = await drive(box, { argv: ['--team', 'acme/team-profile', '--yes', '--tool', 'codex'], tty: true, secret: '' }, { server: priv });
      assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /sin permiso/); assert.deepStrictEqual(r.launches, []);
    } finally { priv.close(); }

    // Azure: la URL de clonar (con usuario) y TYCON_AZURE_TOKEN: el permiso se guarda como azure.token
    const pat = ['permiso', 'azure', 'de', 'laboratorio'].join('-');
    const azure = ['https://acme', 'dev.azure.com/acme/Proj/_git/team-profile'].join('@');
    r = await drive(box, { argv: ['--team', azure, '--yes', '--tool', 'codex'] }, { env: { TYCON_AZURE_TOKEN: pat } });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.launches[0].args, installArgs('--team', 'https://dev.azure.com/acme/Proj/_git/team-profile', '--defaults', '--yes', '--tool', 'codex'));
    assert.strictEqual(JSON.parse(read(path.join(r.home, '.tycon', 'config.json'))).azure.token, pat, 'TYCON_AZURE_TOKEN se guarda como azure.token');
    assert.ok(!r.out.includes(pat), 'el permiso no sale en pantalla');
    // sin credencial de ninguna clase: sale 1 antes de instalar
    r = await drive(box, { argv: ['--team', 'https://dev.azure.com/acme/Proj/_git/team-profile/', '--yes', '--tool', 'codex'] });
    assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /permiso de Azure DevOps/); assert.deepStrictEqual(r.launches, []);
    // el gestor de credenciales de git alcanza (como install --team): no se pide, no se guarda
    if (spawnSync('git', ['--version']).status === 0) {
      const creds = path.join(box, 'git-credentials');
      fs.writeFileSync(creds, `https://usuario:${['otro', 'permiso', 'azure'].join('-')}@dev.azure.com\n`);
      const gitconfig = path.join(box, 'gitconfig-store');
      fs.writeFileSync(gitconfig, `[credential]\n\thelper = store --file=${creds.replace(/\\/g, '/')}\n`);
      r = await drive(box, { argv: ['--team', 'https://dev.azure.com/acme/Proj/_git/team-profile', '--yes', '--tool', 'codex'] }, { env: { GIT_CONFIG_GLOBAL: gitconfig, TYCON_AZURE_GIT_CREDENTIAL: '' } });
      assert.strictEqual(r.code, 0, r.out); assert.strictEqual(r.launches.length, 1, 'siguió a install --team');
      assert.ok(!fs.existsSync(path.join(r.home, '.tycon', 'config.json')), 'no guardó nada: install la lee del gestor de git');
    }

    // una configuración que está y no se lee sale 1 nombrando el archivo, sin instalar ni tocarla
    for (const [what, text] of [['no es JSON', '{"github": {"token": '], ['no es un objeto', 'null\n']]) {
      const home = fs.mkdtempSync(path.join(box, 'home-')); const own = path.join(home, '.tycon'); fs.mkdirSync(own);
      const f = path.join(own, 'config.json'); fs.writeFileSync(f, text);
      r = await drive(box, { argv: ['--yes', '--tool', 'codex'] }, { home });
      assert.strictEqual(r.code, 1, `${what}: ${r.out}`);
      assert.ok(r.out.includes(f), `${what}: nombra el archivo — ${r.out}`);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), text, `${what}: el archivo queda como estaba`);
      assert.deepStrictEqual(r.launches, [], `${what}: no instaló`);
    }
    // el control: sin config.json (ENOENT) es «sin permiso guardado», e instala
    r = await drive(box, { argv: ['--yes', '--tool', 'codex'] });
    assert.strictEqual(r.code, 0, r.out); assert.strictEqual(r.launches.length, 1);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T8 NpxEntry_YaInstalado_ActualizaConElArbolNuevo @story-8.80 @ac-7', async () => {
  const box = tmp('npx-instalado-');
  try {
    assert.strictEqual(N.HARNESS_JS, HARNESS, 'el harness.js de ESTE árbol, el de al lado de npx.js');
    const home = () => { const h = fs.mkdtempSync(path.join(box, 'home-')); return h; };
    // al día: el commit instalado es el de la punta; no se pregunta ni se corre nada
    let h = home(); installedAt(h, { commit: NEW });
    let r = await drive(box, { argv: ['--tool', 'codex'], tty: true, answer: 's' }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /está al día/); assert.deepStrictEqual(r.launches, []);
    // una punta más nueva, con terminal y «s»: corre el update del árbol que corre (no el del instalado)
    h = home(); const installedTree = installedAt(h);
    r = await drive(box, { argv: ['--tool', 'codex'], tty: true, answer: 's' }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /hay una versión nueva \(ccccccc\)/); assert.match(r.out, /¿Actualizo\? \[s\/N\]/);
    assert.deepStrictEqual(r.launches.map((l) => l.args), [treeArgs('update', '--yes')]);
    assert.ok(!r.launches[0].args[0].startsWith(installedTree), 'no es el harness.js del instalado');
    // con `--yes` y terminal no se pregunta
    r = await drive(box, { argv: ['--yes'], tty: true, answer: 'n' }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.ok(!/¿Actualizo/.test(r.out)); assert.deepStrictEqual(r.launches.map((l) => l.args), [treeArgs('update', '--yes')]);
    // «no», vacío o fin de entrada: no actualiza
    for (const answer of ['n', '', 'quizás']) {
      r = await drive(box, { argv: ['--tool', 'codex'], tty: true, answer }, { home: h });
      assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /no actualicé/); assert.deepStrictEqual(r.launches, [], `«${answer}»`);
    }
    // sin terminal: avisa y no corre nada, ni con --yes
    for (const argv of [['--tool', 'codex'], ['--yes']]) {
      r = await drive(box, { argv }, { home: h });
      assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /para actualizarlo/); assert.deepStrictEqual(r.launches, []);
    }
    // el hijo falla: el código del hijo
    r = await drive(box, { argv: ['--yes'], tty: true, status: 3 }, { home: h });
    assert.strictEqual(r.code, 3, r.out);
    // con --audience org, el team-init de este árbol; con --team y sin capa, install --team de este árbol
    r = await drive(box, { argv: ['--audience', 'org'] }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.deepStrictEqual(r.launches.map((l) => l.args), [treeArgs('team-init')]);
    r = await drive(box, { argv: ['--team', 'acme/team-profile', '--yes'] }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.deepStrictEqual(r.launches.map((l) => l.args), [treeArgs('install', '--team', 'acme/team-profile', '--yes')]);
    // con la capa ya puesta, `--team` no pide nada: sigue la comparación de commits
    h = home(); installedAt(h, { commit: NEW, team: { repo: 'acme/team-profile' } });
    r = await drive(box, { argv: ['--team', 'acme/team-profile'] }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /está al día/); assert.deepStrictEqual(r.launches, []);
    // instalado desde un clon, o con otro repo u otra rama: no se compara, se dice cómo actualizar
    h = home(); installedAt(h, { release: false });
    r = await drive(box, { argv: ['--yes'], tty: true }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /instalado desde un clon/); assert.deepStrictEqual(r.launches, []);
    for (const opt of [{ repo: 'otra/cosa' }, { ref: 'latest' }]) {
      h = home(); installedAt(h, opt);
      r = await drive(box, { argv: ['--yes'], tty: true }, { home: h });
      assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /para actualizarlo/); assert.deepStrictEqual(r.launches, [], JSON.stringify(opt));
    }
    // un estado cuyo árbol ya no está es «sin arnés»: la instalación sigue (como el paquete 1.0.3)
    h = home(); fs.rmSync(installedAt(h), { recursive: true, force: true });
    r = await drive(box, { argv: ['--yes', '--tool', 'codex'] }, { home: h });
    assert.strictEqual(r.code, 0, r.out); assert.deepStrictEqual(r.launches.map((l) => l.args), [installArgs('--defaults', '--yes', '--tool', 'codex')]);
    // un estado que está y no se lee sale 1 sin instalar encima
    h = home(); fs.mkdirSync(path.join(h, '.tycon', 'state'), { recursive: true });
    fs.writeFileSync(path.join(h, '.tycon', 'state', 'harness-state.json'), '{ no es json');
    r = await drive(box, { argv: ['--yes'] }, { home: h });
    assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /no instalo encima/); assert.deepStrictEqual(r.launches, []);
    // sin el commit del paquete (corrido a mano) no hay con qué comparar
    r = await drive(box, { argv: ['--yes'] }, { env: { TYCON_NPX_COMMIT: '' } });
    assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /lo corre el paquete/);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T9 NpxEntry_UnSoloNumero @story-8.80 @ac-8', async () => {
  const box = tmp('npx-numero-');
  try {
    const src = read(NPX);
    assert.ok(!/\.version\b|versión \$\{/.test(src), 'npx.js no lee ni nombra el número de versión instalado');
    const number = /\d+\.\d+\.\d+/;
    // la máquina instalada tiene una versión vieja: ninguna salida de npx.js la nombra (la línea de versión es la del instalador)
    let h = fs.mkdtempSync(path.join(box, 'home-')); installedAt(h, { commit: NEW });
    let r = await drive(box, { argv: ['--tool', 'codex'] }, { home: h });
    assert.ok(!number.test(r.out) && !/versión \d/.test(r.out), `al día: ${r.out}`);
    h = fs.mkdtempSync(path.join(box, 'home-')); installedAt(h);
    for (const spec of [{ argv: ['--yes'], tty: true }, { argv: ['--tool', 'codex'], tty: true, answer: 'n' }, { argv: ['--tool', 'codex'] }]) {
      r = await drive(box, spec, { home: h });
      assert.ok(!number.test(r.out) && !/versión \d/.test(r.out), `actualización: ${r.out}`);
    }
    // la instalación nueva y el alta de la organización: nada de números
    const toy = await serve(() => null);
    try {
      for (const argv of [['--yes', '--tool', 'codex'], ['--audience', 'org', '--yes', '--tool', 'codex']]) {
        r = await drive(box, { argv }, { server: toy });
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(!number.test(r.out), `instalación: ${r.out}`);
      }
    } finally { toy.close(); }
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T10 NpxEntry_PaqueteViejoSigueAndando @story-8.80 @ac-9', async (t) => {
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  // el paquete 1.0.3 sale de la historia: el commit que lo subió (el último de la lista del pickaxe es el más viejo)
  const pick = git('log', '-S"version": "1.0.3"', '--format=%H', '--', 'scripts/setup/npm/package.json');
  const sha = pick.status === 0 ? pick.stdout.trim().split('\n').filter(Boolean).pop() : '';
  const index = sha ? git('show', `${sha}:scripts/setup/npm/index.js`) : { status: 1 };
  const paths = sha ? git('show', `${sha}:scripts/setup/npm/home-paths.json`) : { status: 1 };
  if (index.status !== 0 || paths.status !== 0) { t.diagnostic('NO MEDIDO: esta copia no trae la historia donde el paquete era 1.0.3'); return; }
  const box = tmp('npx-viejo-');
  try {
    const dir = path.join(box, 'pkg'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), index.stdout); fs.writeFileSync(path.join(dir, 'home-paths.json'), paths.stdout);
    // el árbol «bajado»: un harness.js que anota la llamada y le pregunta al `parse` del harness.js de esta rama si la acepta
    const top = path.join(box, 'src', 'example-harness-main', 'scripts', 'setup'); fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, 'harness.js'), [
      "const fs=require('fs');const a=process.argv.slice(2);const r=require(process.env.BRANCH_HARNESS).parse(a);",
      "fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({argv:a,error:r.error||null,cmd:r.cmd||null})+'\\n');", ''].join('\n'));
    const tgz = path.join(box, 'arnes.tgz'); execFileSync('tar', ['-czf', tgz, '-C', path.join(box, 'src'), 'example-harness-main']);
    const srv = await serve((u) => (u.includes('/info/refs') ? { status: 200, body: Buffer.from(`001e# service=git-upload-pack\n0000003f${NEW} refs/heads/main\n0000`, 'latin1') } : (u.includes('/tar.gz/') ? { status: 200, body: fs.readFileSync(tgz) } : null)));
    const home = fs.mkdtempSync(path.join(box, 'home-')); fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    const log = path.join(home, 'fake.log');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), FAKE_LOG: log, BRANCH_HARNESS: HARNESS,
      TYCON_RELEASE_API: srv.base, TYCON_RELEASE_GIT: srv.base, TYCON_RELEASE_ARCHIVE: srv.base };
    if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) env[k] = process.env[k];
    try {
      const c = spawn(process.execPath, [path.join(dir, 'index.js'), '--yes', '--tool', 'codex'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      const code = await new Promise((res) => c.on('close', res));
      assert.strictEqual(code, 0, out);
    } finally { srv.close(); }
    const calls = read(log).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(calls.length, 1, JSON.stringify(calls));
    assert.deepStrictEqual(calls[0].argv.slice(0, 3), ['install', '--version', 'latest'], 'harness.js install --version latest');
    assert.strictEqual(calls[0].error, null, `el harness.js de esta rama acepta esa llamada: ${calls[0].error}`);
    assert.strictEqual(calls[0].cmd, 'install');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

/** El paquete (index.js) contra un GitHub de juguete que sirve un árbol con `harness.js` y `npx.js` de mentira; `harness.js` anota el permiso que recibe. */
async function pkgRun(box, args, { routes, env = {}, config = null }) {
  const top = path.join(box, 'src', 'example-harness-main', 'scripts', 'setup');
  if (!fs.existsSync(top)) {
    fs.mkdirSync(path.join(top, 'harness'), { recursive: true });
    fs.writeFileSync(path.join(top, 'harness', 'npx.js'), '// juguete\n');
    fs.writeFileSync(path.join(top, 'harness.js'), "require('fs').appendFileSync(process.env.FAKE_LOG,JSON.stringify({token:process.env.TYCON_GITHUB_TOKEN||null})+'\\n');\n");
    execFileSync('tar', ['-czf', path.join(box, 'arnes.tgz'), '-C', path.join(box, 'src'), 'example-harness-main']);
  }
  const srv = await serve((u, hd) => routes(u, hd, fs.readFileSync(path.join(box, 'arnes.tgz'))));
  const home = fs.mkdtempSync(path.join(box, 'home-')); const log = path.join(home, 'fake.log');
  if (config) { fs.mkdirSync(path.join(home, '.tycon')); fs.writeFileSync(path.join(home, '.tycon', 'config.json'), JSON.stringify(config)); }
  const e = Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), FAKE_LOG: log,
    TYCON_RELEASE_API: srv.base, TYCON_RELEASE_GIT: srv.base, TYCON_RELEASE_ARCHIVE: srv.base }, env);
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) e[k] = process.env[k];
  const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'npm', 'index.js'), ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => c.on('close', res));
  srv.close();
  return { code, out, calls: fs.existsSync(log) ? read(log).trim().split('\n').map((l) => JSON.parse(l)) : [] };
}

test('NpxEntry_Paquete_RepoPrivadoYFaltaTar @story-8.80 @ac-5', async () => {
  const box = tmp('npx-paquete-');
  try {
    const TOKEN = ['permiso', 'guardado', 'de', 'laboratorio'].join('-');
    // un repo privado: lo público no lo ve; la API sólo contesta con el permiso
    const priv = (u, hd, tgz) => {
      if (u.includes('/info/refs')) return { status: 404, body: '' };
      if (hd.authorization !== `Bearer ${TOKEN}`) return { status: 404, body: '{}' };
      if (u.includes('/git/ref/heads/main')) return { status: 200, body: JSON.stringify({ object: { sha: NEW } }) };
      if (u.includes('/tarball/')) return { status: 200, body: tgz };
      return null;
    };
    let r = await pkgRun(box, ['--repo', 'acme/priv', '--yes'], { routes: priv, config: { github: { token: TOKEN } } });
    assert.strictEqual(r.code, 0, `el permiso guardado alcanza: ${r.out}`);
    assert.strictEqual(r.calls[0].token, TOKEN, 'el permiso viaja al instalador (que lo guarda)');
    assert.ok(!r.out.includes(TOKEN), 'el permiso no sale en pantalla');
    // sin permiso y sin terminal: sale 1 diciendo cuál crear
    r = await pkgRun(box, ['--repo', 'acme/priv', '--yes'], { routes: priv });
    assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /GitHub no muestra acme\/priv \(404\)/); assert.match(r.out, /personal-access-tokens\/new/); assert.deepStrictEqual(r.calls, []);
    // falta tar: se dice con el comando sugerido, no con un error genérico
    if (process.platform !== 'win32') {
      const pub = (u, hd, tgz) => (u.includes('/info/refs') ? { status: 200, body: Buffer.from(`001e# service=git-upload-pack\n0000003f${NEW} refs/heads/main\n0000`, 'latin1') } : (u.includes('/tar.gz/') ? { status: 200, body: tgz } : null));
      r = await pkgRun(box, ['--yes'], { routes: pub, env: { PATH: path.join(box, 'sin-herramientas') } });
      assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /falta tar — sugerido \(no lo corro\): \S/); assert.deepStrictEqual(r.calls, []);
    }
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('NpxEntry_Despachador_OpcionesYAyuda @story-8.80 @ac-5', () => {
  // el despachador de harness.js: `npx` no declara opciones (la tabla de --tool y --team de las otras órdenes no cambia);
  // entrega los argumentos sin mirarlos, en las dos formas, y las opciones que no son suyas las valida `install`
  const H = require(HARNESS);
  assert.ok(H.COMMANDS.npx && H.COMMANDS.npx.passthrough && !Object.keys(H.COMMANDS.npx.opts).length, 'harness.js tiene el subcomando npx, sin opciones declaradas');
  const ok = H.parse(['npx', '--repo=acme/harness', '--team', 'acme/p', '--audience=org', '--tool', 'codex', '--tool=claude', '--yes']);
  assert.ok(!ok.error, ok.error); assert.strictEqual(ok.cmd, 'npx');
  assert.ok(H.parse(['npx', '--help']).help, '--help sigue mostrando la ayuda');
  assert.ok(H.parse(['install', '--repo=x']).error, 'las otras órdenes siguen como eran');
  const run = (args, env = {}) => spawnSync(process.execPath, [HARNESS, 'npx', ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_NPX_COMMIT: NEW, TYCON_HARNESS_NODE: '0' }, env) });
  let r = run(['--repo=../x']); assert.strictEqual(r.status, 2, r.stderr); assert.match(r.stderr, /--repo pide/);
  r = run(['--audience', 'nadie']); assert.strictEqual(r.status, 2, r.stderr); assert.match(r.stderr, /--audience es me, team u org: nadie/);
  r = run(['--audience', 'me'], { TYCON_NPX_COMMIT: '' }); assert.strictEqual(r.status, 2, r.stderr); assert.match(r.stderr, /lo corre el paquete/);
});

test('8.46 T15 NpxEntry_Help_DefaultsForMe_OneYes', () => {
  const h = spawnSync(process.execPath, [HARNESS, '--help'], { encoding: 'utf8' });
  assert.strictEqual(h.status, 0, h.stderr);
  const out = h.stdout.slice(h.stdout.indexOf('  npx\n'));
  assert.ok(out.length > 100, 'la ayuda lista el subcomando npx');
  assert.match(out, /para m[ií]/, 'nombra «para mí» como defecto');
  assert.match(out, /--audience team\|org/, 'nombra --audience team|org');
  assert.match(out, /cinco renglones/, 'dice el plan corto');
  assert.match(out, /¿Instalo\? \[s\/N\]/, 'dice el único sí');
  assert.ok(!/sin valor por defecto/.test(out), 'no dice «sin valor por defecto»');
});

test('8.46 T44 NpxEntry_AgentHelp_SameAsTools', async () => {
  for (const p of ['darwin', 'linux', 'win32']) {
    const text = TL.agentLines(p).join('\n');
    assert.match(text, /Claude Code/); assert.match(text, /Codex/);
    assert.match(text, p === 'win32' ? /irm https:\/\/claude\.ai\/install\.ps1 \| iex/ : /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.ok(TL.noneFound(p).includes(TL.agentLines(p)[0]), `noneFound(${p}) trae las órdenes`);
  }
  // npx.js dice lo que dice tools.js, y detecta con tools.detect: Claude Code o Codex en el PATH o con su configuración propia
  const box = tmp('npx-agente-');
  try {
    const bin = path.join(box, 'bin'); fs.mkdirSync(bin);
    const claude = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'); fs.writeFileSync(claude, ''); fs.chmodSync(claude, 0o755);
    const cases = { 'sin nada': [false, () => {}, ''], 'claude en el PATH': [true, () => {}, bin], 'claude.json': [true, (h) => fs.writeFileSync(path.join(h, '.claude.json'), '{}'), ''],
      'codex auth': [true, (h) => { fs.mkdirSync(path.join(h, '.codex')); fs.writeFileSync(path.join(h, '.codex', 'auth.json'), '{}'); }, ''],
      'sólo lo desplegado': [false, (h) => { fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{}'); }, ''] };
    for (const [name, [found, make, look]] of Object.entries(cases)) {
      const home = fs.mkdtempSync(path.join(box, 'home-')); make(home);
      const r = await drive(box, { argv: ['--yes'] }, { home, agent: false, env: { TYCON_TOOLS_DETECT_PATH: look } });
      assert.strictEqual(r.code, found ? 0 : 1, `${name}: ${r.out}`);
      if (!found) assert.ok(r.out.includes(TL.agentLines(process.platform)[1]), `${name}: las órdenes de tools.js`);
    }
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});
