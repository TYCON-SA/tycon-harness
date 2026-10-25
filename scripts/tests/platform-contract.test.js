'use strict';
// platform-contract.test.js — la capa de plataforma (scripts/lib/platform/platform.js): el contrato de las operaciones,
// quién elige la plataforma de cada una, los motivos cerrados, los conectores (el de mentira y los dos de verdad) y la
// elección en el perfil del equipo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
const C = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));
const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
const FAKE = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-platform');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const copiar = (de, a) => fs.cpSync(de, a, { recursive: true });

/** Una carpeta de integraciones con el conector de mentira y los dos de verdad (copias: la prueba no toca el árbol). */
function integraciones(extra = {}) {
  const d = tmp('plataformas-');
  copiar(FAKE, path.join(d, 'fake-platform'));
  for (const n of ['azure-devops', 'github']) copiar(path.join(ROOT, 'integrations', n), path.join(d, n));
  for (const [n, m] of Object.entries(extra)) { fs.mkdirSync(path.join(d, n, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(d, n, 'integration.json'), JSON.stringify(m)); }
  return d;
}
/**
 * Un árbol con su perfil y su team-repos.json (`teamRepos: false`: sin el archivo), una casa vacía y el entorno que los
 * apunta. Los repos de `repos` van como repos de merge_suites, que es donde team-repos.json declara repos de producto.
 */
function mundo({ platform, repos = [], operations = { platform: 'github', org: 'acme', repo: 'operaciones' }, teamRepos = true, extraInt } = {}) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  const perfil = {};
  if (platform !== undefined) perfil.integrations = { platform };
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify(perfil));
  if (teamRepos) {
    const doc = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations };
    if (repos.length) doc.merge_suites = { repos: repos.map((repo) => ({ repo, rule: 'automatico' })) };
    fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(doc));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_INTEGRATIONS_DIR: integraciones(extraInt), TYCON_TREE: tree };
  // lo que trae quien corre la prueba no entra: TYCON_PROFILE (las portables lo ponen en 0) apagaría el perfil del caso
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|FAKE_PLATFORM_TOKEN)$|^FAKE_PLATFORM_/.test(k)) delete env[k];
  env.TYCON_HOME = path.join(home, '.tycon');
  return { tree, home, env };
}
/** Un estado del gh de mentira en un archivo temporal. */
const estadoGh = (estado) => { const f = path.join(tmp('gh-'), 'estado.json'); fs.writeFileSync(f, JSON.stringify(estado)); return f; };
const AZ = { platform: 'azure', org: 'acme', project: 'Producto', repo: 'Backend' };
const GH = { platform: 'github', org: 'acme', repo: 'portal' };

test('Platform_UndeclaredOp_ReturnsNoSoportado @story-8.85 @ac-1', async () => {
  const m = mundo({ platform: { default: 'fake-platform' } });
  m.env.TYCON_FAKE_PLATFORM_TOKEN = ['tok', 'falso'].join('-');
  const r = await P().run('change-request.vote', { id: 7, voto: 'approve' }, { env: m.env, repo: { ...GH, platform: undefined } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_soportado');
  assert.match(r.detail, /Plataforma de mentira no declara change-request\.vote/);
});

test('Platform_OperationsList_MatchesContract @story-8.85 @ac-1', () => {
  const ops = C().OPERATIONS;
  // el lector de configuración guarda su copia de las áreas: tienen que ser las mismas del contrato
  assert.deepStrictEqual([...require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).AREAS_PLATAFORMA], [...C().AREAS]);
  assert.strictEqual(ops.length, 10, 'las diez operaciones del dominio');
  for (const n of ['azure-devops', 'github']) {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', n, 'integration.json'), 'utf8'));
    assert.strictEqual(man.kind, 'platform', n);
    assert.ok(man.operations.length > 0, `${n} declara algo`);
    for (const o of man.operations) assert.ok(ops.includes(o), `${n}: ${o} está en el contrato`);
    assert.ok(man.operations.includes('deployments.read'), `${n}: la tanda A trae la lectura de despliegues`);
  }
});

test('Platform_Resolve_ByRepoIdentity @story-8.85 @ac-2', () => {
  const m = mundo({ platform: { default: 'github' }, repos: [AZ, GH] });
  const de = (repo) => P().choose('ci.read', { env: m.env, repo });
  assert.deepStrictEqual(de(AZ).value, { connector: 'azure-devops', origin: 'repo' });
  assert.deepStrictEqual(de(GH).value, { connector: 'github', origin: 'repo' });
  // la traducción de team-repos.json al nombre del conector vive en un solo lugar
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  assert.deepStrictEqual([TR.connectorOf('azure'), TR.connectorOf('github'), TR.connectorOf('gitlab')], ['azure-devops', 'github', null]);
  // una operación de repo sin repo es un uso incorrecto, no una elección
  const sinRepo = P().choose('ci.read', { env: m.env });
  assert.strictEqual(sinRepo.ok, false);
  assert.strictEqual(sinRepo.reason, 'sin_plataforma');
  assert.match(sinRepo.detail, /--repo/);
});

test('Platform_NoDuplicatedDerivation @story-8.85 @ac-2', () => {
  const leer = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // merge-pr.js: la identidad del repo sale de la capa, no de su propio «host === azure»
  const mp = leer('scripts/tools/merge-pr.js');
  assert.match(mp, /'platform', 'platform\.js'/);
  assert.doesNotMatch(mp, /identity = \{ platform: 'azure'/);
  // work-items.js: elige por la capa (el área de los pedidos de trabajo), no por operations.platform a mano
  const wi = leer('scripts/nightly/dependencies/work-items.js');
  assert.match(wi, /platform\/platform\.js/);
  assert.doesNotMatch(wi, /plataforma: r\.data\.operations\.platform/);
  // harness-repo.js sólo lee direcciones: no arma identidades con plataforma ni elige
  assert.doesNotMatch(leer('scripts/lib/harness-repo.js'), /platform: '(azure|github)'/);
  // el sitio no adivina: un repo sin plataforma no se muestra como Azure
  const oc = leer('scripts/lib/org-config.js');
  assert.doesNotMatch(oc, /r\.platform === 'github' \? 'github' : 'azure'/);
});

test('Platform_ProfileChooses_NoCredsInProfile @story-8.85 @ac-3', () => {
  const m = mundo({ platform: { default: 'github' } });
  m.env.PATH = '/usr/bin:/bin';
  const r = P().choose('work-item.create', { env: m.env });
  assert.deepStrictEqual(r.value, { connector: 'github', origin: 'perfil:default' });
  // el lector de configuración acepta la elección del perfil y la devuelve; sin ado.org en la máquina no hay error
  const CFG0 = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  const c = CFG0.cargar({ env: m.env, home: m.home, arnes: m.tree });
  assert.deepStrictEqual(c.errores, [], JSON.stringify(c.errores));
  assert.deepStrictEqual(CFG0.plataforma(c).value, { default: 'github' });
  // con GitHub elegido, el aviso de Azure DevOps no dice «apagado»: dice que la organización eligió otra plataforma
  assert.doesNotMatch(CFG0.comoSePrende('ado', m.home, c), /apagad/);
  assert.match(CFG0.comoSePrende('ado', m.home, c), /eligió github/);
  // el perfil no tiene ni pide credenciales
  const perfil = fs.readFileSync(path.join(m.tree, 'team-profile.json'), 'utf8');
  assert.doesNotMatch(perfil, /token|secret|password/i);
  // una credencial en integrations.platform es un error del lector
  const CFG = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  assert.ok(CFG.validarTipo('plataforma', { default: 'github', token: 'x' }), 'una clave fuera de las áreas es un error');
  assert.strictEqual(CFG.validarTipo('plataforma', { default: 'github', workItems: 'azure-devops', queue: 'github' }), null);
});

test('Platform_NoneChosen_SaysHowAndContinues @story-8.85 @ac-4', () => {
  const m = mundo({ teamRepos: false });
  const r = P().choose('work-item.create', { env: m.env });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'sin_plataforma');
  assert.match(r.detail, /integrations\.platform/);
  // un repo sin plataforma y sin valor por defecto: tampoco elige, ni por el remoto ni por costumbre
  const sinNada = P().choose('ci.read', { env: m.env, repo: { org: 'acme', repo: 'sin-plataforma' } });
  assert.strictEqual(sinNada.reason, 'sin_plataforma');
  // con un valor por defecto en el perfil, ese repo lo usa
  const conDefault = mundo({ platform: { default: 'github' } });
  assert.deepStrictEqual(P().choose('ci.read', { env: conDefault.env, repo: { org: 'acme', repo: 'sin-plataforma' } }).value, { connector: 'github', origin: 'perfil:default' });
  // la línea de comandos sale 0 y lo dice en JSON
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'), 'work-item.create'], { env: m.env, encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(JSON.parse(cli.stdout).reason, 'sin_plataforma');
  // un uso incorrecto sale 2
  assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'), 'no-existe'], { env: m.env }).status, 2);
});

test('Platform_Reasons_ClosedVocabulary @story-8.85 @ac-5', async () => {
  const R = C().REASONS;
  assert.deepStrictEqual([...R].sort(), ['no_encontrado', 'no_medido', 'no_soportado', 'rechazado', 'red', 'sin_credencial', 'sin_plataforma'].sort());
  const m = mundo({ platform: { default: 'fake-platform' } });
  m.env.TYCON_FAKE_PLATFORM_TOKEN = ['tok', 'falso'].join('-');
  // un conector que inventa un motivo: la capa lo convierte en no_medido, con el motivo inventado en el detalle
  m.env.FAKE_PLATFORM_ANSWERS = JSON.stringify({ 'queue.read': { ok: false, reason: 'se_rompio', detail: 'x' }, 'assigned.list': { ok: true }, 'ci.read': 'nada' });
  for (const op of ['queue.read', 'assigned.list']) {
    const r = await P().run(op, {}, { env: m.env });
    assert.strictEqual(r.ok, false, op);
    assert.ok(R.includes(r.reason), `${op}: ${r.reason}`);
    assert.strictEqual(r.reason, 'no_medido', op);
  }
  // los dos conectores de verdad, sin credencial o sin poder leer: también dentro del vocabulario
  for (const plat of ['azure-devops', 'github']) {
    const w = mundo({ platform: { default: plat } });
    w.env.TYCON_ADO_CMD = '/no/existe/az'; w.env.TYCON_GH_CMD = '/no/existe/gh';
    const r = await P().run('deployments.read', { entrada: { pipeline: 'P/publicar', stages: ['Prod'], repo: 'acme/portal', environment: 'production' }, entorno: 'production', org: 'https://dev.azure.com/acme' }, { env: w.env });
    assert.strictEqual(r.ok, false, plat);
    assert.ok(R.includes(r.reason), `${plat}: ${r.reason}`);
  }
});

test('Platform_ReadFailure_IsNoMedidoNeverEmpty @story-8.85 @ac-5', async () => {
  const m = mundo({ platform: { default: 'fake-platform' } });
  m.env.TYCON_FAKE_PLATFORM_TOKEN = ['tok', 'falso'].join('-');
  m.env.FAKE_PLATFORM_THROW = 'change-request.list';
  const r = await P().run('change-request.list', {}, { env: m.env, repo: { org: 'acme', repo: 'x' } });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido']);
  assert.match(r.detail, /falla de mentira/);
  // las lecturas de verdad con el az y el gh de mentira que fallan: no_medido, nunca una lista vacía
  for (const [plat, env] of [['azure-devops', { TYCON_ADO_CMD: FAKE_AZ, FIXAZ: tmp('fixaz-'), TYCON_AZ_FAIL: 'definiciones', TYCON_ADO_ORG: 'https://dev.azure.com/acme' }], ['github', { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: estadoGh({ fail: { 'GET repos/acme/portal/deployments': { status: 500, message: 'caído' } } }) }]]) {
    const w = mundo({ platform: { default: plat } });
    Object.assign(w.env, env);
    const x = await P().run('deployments.read', { entrada: { pipeline: 'P/publicar', stages: ['Prod'], repo: 'acme/portal', environment: 'production' }, entorno: 'production', org: 'https://dev.azure.com/acme' }, { env: w.env });
    assert.strictEqual(x.ok, false, `${plat}: ${JSON.stringify(x)}`);
    assert.strictEqual(x.reason, 'no_medido', `${plat}: ${x.detail}`);
    assert.ok(x.value === undefined, 'sin valor cuando no se pudo leer');
  }
});

test('FakePlatform_PassesConformance @story-8.85 @ac-6', async () => {
  const m = mundo({ platform: { default: 'fake-platform' } });
  m.env.TYCON_FAKE_PLATFORM_TOKEN = ['tok', 'falso'].join('-');
  m.env.FAKE_PLATFORM_LOG = path.join(tmp('registro-'), 'llamadas');
  const r = await P().conformance('fake-platform', { env: m.env });
  assert.deepStrictEqual(r.problems, [], JSON.stringify(r));
  const llamadas = fs.readFileSync(m.env.FAKE_PLATFORM_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l).operacion);
  const declaradas = JSON.parse(fs.readFileSync(path.join(FAKE, 'integration.json'), 'utf8')).operations;
  assert.deepStrictEqual([...new Set(llamadas)].sort(), [...declaradas].sort(), 'registra cada operación que declara');
});

test('Conformance_AzureAndGithub_DeclaredOps @story-8.85 @ac-6', async () => {
  for (const plat of ['azure-devops', 'github']) {
    const m = mundo({ platform: { default: plat } });
    Object.assign(m.env, { TYCON_ADO_CMD: FAKE_AZ, FIXAZ: tmp('fixaz-'), TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: estadoGh({}), TYCON_ADO_ORG: 'https://dev.azure.com/acme' });
    const r = await P().conformance(plat, { env: m.env });
    assert.deepStrictEqual(r.problems, [], `${plat}: ${JSON.stringify(r)}`);
    // lo que no declara contesta no_soportado
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', plat, 'integration.json'), 'utf8'));
    for (const op of C().OPERATIONS.filter((o) => !man.operations.includes(o))) {
      const x = await P().run(op, {}, { env: m.env, repo: plat === 'github' ? GH : AZ });
      assert.strictEqual(x.reason, 'no_soportado', `${plat} ${op}`);
    }
  }
});

test('Credentials_Missing_SaysCommandNeverPrints @story-8.85 @ac-28', async () => {
  const marcada = ['MARCA', 'secreta', '7731'].join('-');
  // sin la organización de Azure DevOps: sin_credencial con el comando para ponerla
  const az = mundo({ platform: { default: 'azure-devops' } });
  const r1 = await P().run('deployments.read', { entrada: { pipeline: 'P/publicar', stages: ['Prod'] }, entorno: 'production' }, { env: az.env });
  assert.deepStrictEqual([r1.ok, r1.reason], [false, 'sin_credencial']);
  assert.match(r1.detail, /harness\.js config set ado\.org/);
  // la organización nunca sale de un argumento (llevaría la credencial de az a otro host): sin ado.org, igual falta
  const conArg = await P().run('deployments.read', { org: 'https://ajeno.example', entrada: { pipeline: 'P/publicar', stages: ['Prod'] }, entorno: 'production' }, { env: az.env });
  assert.strictEqual(conArg.reason, 'sin_credencial');
  // GitHub sin sesión: gh contesta 401 → sin_credencial con cómo iniciarla
  const gh = mundo({ platform: { default: 'github' } });
  Object.assign(gh.env, { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: estadoGh({ fail: { 'GET repos/acme/portal': { status: 401, message: 'Bad credentials' } } }) });
  const r0 = await P().run('deployments.read', { entrada: { repo: 'acme/portal', environment: 'production' }, entorno: 'production' }, { env: gh.env });
  assert.deepStrictEqual([r0.ok, r0.reason], [false, 'sin_credencial'], JSON.stringify(r0));
  assert.match(r0.detail, /gh auth login|GH_TOKEN/);
  // el secreto declarado por el conector de mentira: falta → sin_credencial y su comando
  const m = mundo({ platform: { default: 'fake-platform' } });
  const r2 = await P().run('queue.read', {}, { env: m.env });
  assert.deepStrictEqual([r2.ok, r2.reason], [false, 'sin_credencial']);
  assert.match(r2.detail, /harness\.js config set fake-platform\.token/);
  // se pone con la escritura de secretos de las integraciones: va a secrets/fake-platform.json y config.json no cambia
  // un config.json de la máquina que ya existe: guardar el secreto no lo toca
  const cfg = path.join(m.home, '.claude', 'tycon.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' } }));
  const antes = fs.readFileSync(cfg, 'utf8');
  INT.writeSecret('fake-platform.token', marcada, { env: m.env, dir: m.env.TYCON_INTEGRATIONS_DIR });
  const archivo = INT.secretsFile('fake-platform', m.env);
  assert.ok(fs.existsSync(archivo));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(archivo).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(archivo)).mode & 0o777, 0o700);
  }
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), antes, 'config.json no cambia');
  m.env.FAKE_PLATFORM_LOG = path.join(tmp('registro-'), 'llamadas');
  const r3 = await P().run('queue.read', {}, { env: m.env });
  assert.strictEqual(r3.ok, true);
  // la marcada no sale nunca: ni en la salida de la línea de comandos ni en el registro
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'), 'queue.read'], { env: m.env, encoding: 'utf8' });
  assert.ok(!(cli.stdout + cli.stderr).includes(marcada));
  assert.ok(!fs.readFileSync(m.env.FAKE_PLATFORM_LOG, 'utf8').includes(marcada));
});

test('Platform_UnknownValue_TreatedAsNone @story-8.85 @ac-29', () => {
  const m = mundo({ platform: { default: 'gitlab' } });
  const r = P().choose('work-item.create', { env: m.env });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'sin_plataforma']);
  assert.match(r.detail, /plataforma desconocida: «gitlab»/);
});

test('Connector_FolderMissing_SaysWhich @story-8.85 @ac-29', () => {
  const m = mundo({ platform: { default: 'github' } });
  fs.rmSync(path.join(m.env.TYCON_INTEGRATIONS_DIR, 'github'), { recursive: true, force: true });
  const r = P().choose('work-item.create', { env: m.env });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'sin_plataforma']);
  assert.match(r.detail, /el conector github no está instalado/);
});

test('MixedOrg_ResolvesPerOperation @story-8.85 @ac-30', () => {
  const m = mundo({ platform: { default: 'github', workItems: 'azure-devops' }, repos: [AZ, GH] });
  const de = (op, repo) => P().choose(op, { env: m.env, repo }).value.connector;
  assert.strictEqual(de('change-request.open', AZ), 'azure-devops');
  assert.strictEqual(de('change-request.open', GH), 'github');
  assert.strictEqual(de('ci.read', AZ), 'azure-devops');
  assert.strictEqual(de('work-item.create'), 'azure-devops');
  assert.strictEqual(de('queue.read'), 'github', 'sin área propia, la cola va al valor por defecto');
});

test('Manifest_PlatformKind_ValidatedByReader @story-8.85 @ac-32', () => {
  const ok = { name: 'buena', label: 'Buena', kind: 'platform', connector: 'scripts/connector.js', operations: ['ci.read'], capabilities: {}, rawCommands: ['x pr create'] };
  const d = tmp('manifiestos-');
  const poner = (n, m) => { fs.mkdirSync(path.join(d, n), { recursive: true }); fs.writeFileSync(path.join(d, n, 'integration.json'), JSON.stringify({ ...m, name: n })); };
  poner('buena', ok);
  poner('afuera', { ...ok, connector: '../otra/connector.js' });
  poner('opdesconocida', { ...ok, operations: ['ci.read', 'cafe.read'] });
  poner('mayusculas', { ...ok, kind: 'Platform' });
  poner('sinconector', { ...ok, connector: undefined });
  copiar(path.join(ROOT, 'integrations', 'clockify'), path.join(d, 'clockify'));
  const r = INT.listManifests({ dir: d });
  const de = (n) => (r.problems.find((x) => x.name === n) || {}).reasons;
  const buena = INT.find('buena', { kind: 'platform', dir: d });
  assert.ok(buena, JSON.stringify(r));
  assert.deepStrictEqual([buena.connector, buena.operations, buena.rawCommands], ['scripts/connector.js', ['ci.read'], ['x pr create']]);
  for (const [n, rx] of [['afuera', /«connector» es un \.js dentro de la carpeta/], ['opdesconocida', /operación desconocida: cafe\.read/], ['mayusculas', /«kind» se escribe platform/], ['sinconector', /falta «connector»/]]) {
    assert.ok(!INT.find(n, { kind: 'platform', dir: d }), `${n} no se carga`);
    assert.match(JSON.stringify(de(n) || r.problems), rx, n);
  }
  assert.ok(INT.find('clockify', { kind: 'timeTracking', dir: d }), 'el de horas se lee igual que antes');
});

test('Layer_PlatformChange_RaisesRequiresHarness @story-8.85 @ac-33', () => {
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  const actual = { version: 1, integrations: {} };
  const doc = { version: 1, integrations: { platform: { default: 'github' } } };
  const vieja = ORG.timeTrackingLayer({ layerText: JSON.stringify({ requires: { harness: '>= 2026.01.01.1' } }), actual, doc });
  assert.ok(vieja && vieja.archivo === 'team-layer.json', JSON.stringify(vieja));
  assert.match(JSON.parse(vieja.contenido).requires.harness, new RegExp(`>= ${ORG.PLATFORM_SINCE.replace(/\./g, '\\.')}`));
  const nueva = ORG.timeTrackingLayer({ layerText: JSON.stringify({ requires: { harness: `>= ${ORG.PLATFORM_SINCE}` } }), actual, doc });
  assert.strictEqual(nueva, null, 'la capa ya pide esa versión: no se toca');
  assert.strictEqual(ORG.timeTrackingLayer({ layerText: JSON.stringify({ requires: { harness: '>= 2026.01.01.1' } }), actual, doc: actual }), null, 'sin cambiar la plataforma, nada');
});

test('Site_Integrations_PlatformByArea_NeverGuesses @story-8.85 @ac-3 @ac-33', async () => {
  // la pantalla de Integraciones: la plataforma del equipo y, aparte, la de los pedidos de trabajo y la de la cola, con los
  // conectores que trae el árbol; sin elegir no muestra ninguna, y elegir una escribe sólo su área
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const pedidos = [];
  const seccion = { id: 'integraciones', titulo: 'i', repo: 'perfil', archivo: 'team-profile.json', estado: 'cargado', soloLectura: false, motivo: null, problems: [], avisos: [],
    borrador: { integrations: {} }, extras: { horas: [], plataformas: [{ name: 'azure-devops', label: 'Azure DevOps' }, { name: 'github', label: 'GitHub' }] } };
  const respuesta = { ok: true, secciones: [seccion], proponer: {}, versiones: [], productos: [] };
  new Function('document', 'fetch', ORG.pantalla())(document, (ruta, o) => { pedidos.push({ ruta, cuerpo: o && o.body ? JSON.parse(o.body) : null }); return Promise.resolve({ status: 200, json: () => Promise.resolve(ruta === '/api/config' ? respuesta : { ok: true, texto: '', diferencias: [] }) }); });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const sel = (area) => creados.filter((n) => n.tag === 'select' && n.attrs['data-path'] === `integrations.platform.${area}`).pop();
  for (const a of ['default', 'workItems', 'queue']) assert.ok(sel(a), `el selector de ${a}`);
  assert.strictEqual(sel('default').value, '', 'sin elegir no muestra ninguna');
  assert.deepStrictEqual(sel('default').hijos.map((o) => o.attrs.value), ['', 'azure-devops', 'github']);
  sel('default').on.change({ target: { value: 'github' } });
  sel('workItems').on.change({ target: { value: 'azure-devops' } });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const boton = creados.filter((n) => n.tag === 'button' && n.textContent === 'Revisar cambios').pop();
  boton.on.click({});
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const enviado = pedidos.filter((x) => x.ruta === '/api/config/revisar').pop().cuerpo.borrador;
  assert.deepStrictEqual(enviado.integrations.platform, { default: 'github', workItems: 'azure-devops' });
});

test('Platform_DetailsSanitized_AndUnreadableIsNotAbsent @story-8.85 @ac-5 @ac-28', async () => {
  // todo detalle que sale de la capa va saneado, venga de un conector o de una excepción
  const m = mundo({ platform: { default: 'fake-platform' } });
  m.env.TYCON_FAKE_PLATFORM_TOKEN = ['tok', 'falso'].join('-');
  const largo = ['A', 'b'.repeat(40)].join('');
  m.env.FAKE_PLATFORM_ANSWERS = JSON.stringify({ 'queue.read': { ok: false, reason: 'red', detail: `falló contra https://dev.azure.com/acme con Bearer ${largo} de ana@acme.example` } });
  const r = await P().run('queue.read', {}, { env: m.env });
  assert.strictEqual(r.reason, 'red');
  for (const x of ['https://', largo, 'ana@acme.example']) assert.ok(!r.detail.includes(x), `${x} no sale: ${r.detail}`);
  // un team-repos.json roto no se lee como «nadie eligió»: se dice que está roto
  const roto = mundo({ teamRepos: false });
  fs.writeFileSync(path.join(roto.tree, 'team-repos.json'), '{ roto');
  const c = P().choose('work-item.create', { env: roto.env });
  assert.strictEqual(c.reason, 'sin_plataforma');
  assert.match(c.detail, /team-repos\.json no valida/);
  assert.ok(!c.sinEleccion, 'no es «nadie eligió»');
  // y sin nada de nada, sí lo es (es lo que lee work-items.js para seguir con Azure DevOps diciéndolo)
  const nada = mundo({ teamRepos: false });
  assert.strictEqual(P().choose('work-item.create', { env: nada.env }).sinEleccion, true);
});

// ── los bordes de la elección: otro archivo de repos, un perfil roto, la variable, el aviso, el inventario ──────────
test('Adversarial_TeamReposFile_OtherName_IsHonored @story-8.85 @ac-2', () => {
  // work-items.js --team-repos <otro nombre>: la elección lee ESE archivo, no el team-repos.json de su carpeta
  const m = mundo({ teamRepos: false });
  const otro = path.join(tmp('cfg-'), 'repos-equipo.json');
  fs.writeFileSync(otro, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } }));
  const W = require(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'work-items.js'));
  const r = W.elegirPlataforma(['node', 'work-items.js', 'run', '--team-repos', otro], { env: m.env });
  assert.deepStrictEqual([r.plataforma, r.aviso], ['github', undefined], JSON.stringify(r));
});

test('Adversarial_BrokenProfile_IsBrokenNotUnchosen @story-8.85 @ac-4', () => {
  // un perfil que no se puede leer pudo haber elegido otra plataforma: no se cae a operations.platform
  const m = mundo({ operations: { platform: 'azure', org: 'acme', project: 'P', repo: 'operaciones' } });
  fs.writeFileSync(path.join(m.tree, 'team-profile.json'), '{"integrations":{"platform":{"default":"github"}}');
  const r = P().choose('work-item.create', { env: m.env });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'sin_plataforma'], JSON.stringify(r));
  assert.match(r.detail, /rota/);
});

test('Adversarial_EnvPlatform_OnlyDefault_KeepsAreas @story-8.85 @ac-3 @ac-30', () => {
  // TYCON_PLATFORM cambia el valor por defecto de la máquina; las áreas del perfil se quedan
  const m = mundo({ platform: { workItems: 'azure-devops' } });
  m.env.TYCON_PLATFORM = 'github';
  assert.strictEqual(P().choose('work-item.create', { env: m.env }).value.connector, 'azure-devops');
  assert.strictEqual(P().choose('queue.read', { env: m.env }).value.connector, 'github');
  m.env.TYCON_PLATFORM = 'Git Lab!';
  assert.match(P().choose('queue.read', { env: m.env }).detail, /TYCON_PLATFORM/);
});

test('Adversarial_AdoNotice_UsedByCallers @story-8.85 @ac-3', () => {
  // el aviso «Azure DevOps no es la plataforma de tu organización» lo ven quienes preguntan por la integración
  const m = mundo({ platform: { default: 'github' } });
  const CFG = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  const r = CFG.integracionParaComando('ado', { env: m.env, home: m.home, arnes: m.tree });
  assert.strictEqual(r.prendida, false);
  assert.match(r.apagada, /no es la plataforma de tu organización/);
});

test('Adversarial_Golden_CommandMovedToConnector_StillCounted @story-8.85 @ac-27', () => {
  // el inventario de comandos az mira también las integraciones: un comando mudado al conector sigue contado, y la
  // lista de comandos crudos del manifiesto (una declaración, no una llamada) no cuenta
  const G = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'));
  const repo = tmp('foto-repo-');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'integrations', 'azure-devops', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'integrations', 'azure-devops', 'scripts', 'connector.js'), "spawn('az repos pr list --org x');\n");
  fs.writeFileSync(path.join(repo, 'integrations', 'azure-devops', 'integration.json'), '{"rawCommands": ["az repos pr create"]}\n');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'otro.js'), "const x = 'nada de az acá';\n");
  const l = G.literales({ root: repo });
  assert.deepStrictEqual(Object.keys(l), ['integrations/azure-devops/scripts/connector.js']);
  assert.deepStrictEqual(l['integrations/azure-devops/scripts/connector.js'], ["spawn('az repos pr list --org x');"]);
});

test('Adversarial_TreeWithoutPlatformFolder_SecretsStillRead @story-8.85 @ac-32', () => {
  // un árbol sin scripts/lib/platform/ (una instalación a medias, o una copia que sólo trae los archivos sueltos de
  // scripts/lib/): el lector de integraciones carga igual, sigue conociendo los secretos, y del conector dice qué falta
  const arbol = tmp('arbol-sin-capa-');
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) if (/\.(js|json)$/.test(f)) fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', f), path.join(arbol, 'scripts', 'lib', f));
  const d = integraciones();
  copiar(path.join(ROOT, 'integrations', 'notify'), path.join(d, 'notify'));
  const r = spawnSync(process.execPath, ['-e', `
    const I = require(${JSON.stringify(path.join(arbol, 'scripts', 'lib', 'integrations.js'))});
    const l = I.listManifests({ dir: ${JSON.stringify(d)} });
    console.log(JSON.stringify({ secreto: I.isSecretKey('notify.slack_webhook', { dir: ${JSON.stringify(d)} }), azure: (l.problems.find((p) => p.name === 'azure-devops') || {}).reasons }));
  `], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.secreto, true, 'los secretos se siguen conociendo');
  assert.match(o.azure.join(' '), /no pude cargar scripts\/lib\/platform\/contract\.js/, 'el conector dice qué le falta');
});

// ── change-request.list en Azure DevOps ─────────────────────────────────────────────────────────────────────────────
/** Un pedido como lo devuelve Azure en la lista del proyecto. */
function prAzure(n, o = {}) {
  return {
    pullRequestId: n, isDraft: false, mergeStatus: 'succeeded', status: 'active', title: `pedido ${n}`,
    sourceRefName: `refs/heads/story/${n}`, creationDate: '2026-10-25T10:00:00Z',
    lastMergeSourceCommit: { commitId: `${n}`.padStart(40, 'a') }, repository: { name: 'Backend', project: { name: 'Producto' } }, ...o,
  };
}
/** Un mundo de Azure con las páginas de pedidos en el az de mentira: `paginas[i]` va en prs-<i*99>.json (las páginas se
 *  pisan en un pedido: el primero de cada una es el último de la anterior). */
function mundoAzure(paginas) {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const fix = tmp('fixaz-');
  paginas.forEach((v, i) => fs.writeFileSync(path.join(fix, `prs-${i * 99}.json`), JSON.stringify({ count: v.length, value: v })));
  // el doble va copiado y ejecutable: en git no lleva el bit de ejecución
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  Object.assign(m.env, { TYCON_ADO_CMD: az, FIXAZ: fix });
  return { ...m, fix };
}

test('AdoList_MapsFields @story-8.131 @ac-12', async () => {
  const w = mundoAzure([[
    prAzure(7, { isDraft: true, mergeStatus: 'conflicts', autoCompleteSetBy: { id: 'x' } }),
    prAzure(8, { mergeStatus: 'queued' }),
    prAzure(9, { mergeStatus: 'rejectedByPolicy', autoCompleteSetBy: { id: 'y' } }),
    prAzure(10, { repository: { name: 'Otro', project: { name: 'Producto' } } }),
    prAzure(11, { repository: { name: 'backend', project: { name: 'Producto' } } }),
  ]]);
  const r = await P().run('change-request.list', {}, { env: w.env, repo: AZ });
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value.map((p) => p.number), [7, 8, 9, 11], 'el pedido de otro repo del proyecto queda afuera; el nombre no distingue mayúsculas');
  const [a, b, c] = r.value;
  assert.deepStrictEqual(a, { number: 7, draft: true, autoComplete: true, mergeState: 'conflict', sourceBranch: 'story/7', sourceCommit: '7'.padStart(40, 'a'), createdAt: '2026-10-25T10:00:00Z', title: 'pedido 7' });
  assert.strictEqual(b.mergeState, 'pending');
  assert.strictEqual(b.autoComplete, false);
  assert.strictEqual(c.mergeState, 'unknown');
  const llamadas = fs.readFileSync(path.join(w.fix, 'llamadas.log'), 'utf8');
  assert.match(llamadas, /searchCriteria\.status=active/);
  assert.match(llamadas, /project=Producto/);
});

test('AdoList_AzFails_NoMedido @story-8.131 @ac-12', async () => {
  const w = mundoAzure([[prAzure(7)]]);
  w.env.TYCON_AZ_FAIL = 'prs';
  const r = await P().run('change-request.list', {}, { env: w.env, repo: AZ });
  assert.strictEqual(r.ok, false);
  assert.notStrictEqual(r.reason, undefined);
  assert.ok(['no_medido', 'rechazado', 'sin_credencial', 'red'].includes(r.reason), r.reason);
  assert.ok(!Array.isArray(r.value), 'nunca una lista vacía');
  const basura = mundoAzure([[prAzure(7)]]);
  basura.env.TYCON_AZ_GARBAGE = 'prs';
  const g = await P().run('change-request.list', {}, { env: basura.env, repo: AZ });
  assert.deepStrictEqual([g.ok, g.reason], [false, 'no_medido']);
});

test('AdoList_Paginates @story-8.131 @ac-12', async () => {
  const uno = Array.from({ length: 100 }, (_, i) => prAzure(i + 1));
  const dos = Array.from({ length: 51 }, (_, i) => prAzure(i + 100));
  const w = mundoAzure([uno, dos]);
  const r = await P().run('change-request.list', {}, { env: w.env, repo: AZ });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.length, 150);
});

test('AdoList_ShiftBetweenPages_NoMedido @story-8.131 @ac-12', async () => {
  // entre una página y la otra se cerró un pedido más nuevo: la lista corrió un lugar y el del borde (el 100) no
  // aparece en ninguna. Leerla como entera borraría su reloj
  const uno = Array.from({ length: 100 }, (_, i) => prAzure(i + 1));
  const dos = Array.from({ length: 50 }, (_, i) => prAzure(i + 101));
  const w = mundoAzure([uno, dos]);
  const r = await P().run('change-request.list', {}, { env: w.env, repo: AZ });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
  assert.match(r.detail, /cambió mientras se leía/);
  assert.strictEqual(r.value, undefined, 'nunca la lista con un hueco');
});

test('AdoList_Windows_AzThroughConsole @story-8.131 @ac-12', () => {
  // en Windows `az` es az.cmd, que node sólo corre por la consola: los argumentos van entre comillas
  const { llamadaAz } = require(path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'change-requests.js'));
  const args = ['devops', 'invoke', '--route-parameters', 'project=Mi Proyecto', '$top=100', '--org', 'https://dev.azure.com/acme'];
  const win = llamadaAz('az', args, 'win32');
  assert.strictEqual(win.shell, true);
  assert.deepStrictEqual(win.args, args.map((a) => `"${a}"`));
  assert.deepStrictEqual(llamadaAz('az', args, 'darwin'), { args, shell: false });
  assert.deepStrictEqual(llamadaAz('/x/fake-az', args, 'win32'), { args, shell: false }, 'un doble con ruta no pasa por la consola');
  assert.match(llamadaAz('az', ['project=a&b'], 'win32').problem, /no seguros/);
  assert.strictEqual(Object.keys(require(path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'change-requests.js'))).includes('llamadaAz'), false,
    'no es una operación del conector');
});

test('AdoList_PageCap_NoMedido @story-8.131 @ac-12', async () => {
  const lleno = (base) => Array.from({ length: 100 }, (_, i) => prAzure(base + i + 1));
  const w = mundoAzure([lleno(0), lleno(99), lleno(198)]);
  const r = await P().run('change-request.list', { maxPages: 2 }, { env: w.env, repo: AZ });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
  assert.match(r.detail, /tope/);
  assert.strictEqual(r.value, undefined, 'nunca la lista cortada');
});
