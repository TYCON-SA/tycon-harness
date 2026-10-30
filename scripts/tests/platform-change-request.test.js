'use strict';
// platform-change-request.test.js — los pedidos de cambio por la capa de plataforma: abrir uno (Azure DevOps con la
// misma secuencia de az de siempre; GitHub con su entrada automática o esperando sus controles), listarlos con quién los
// abrió y si su CI corre, los frenos que leen los comandos de las dos plataformas, y los nocturnos que miden GitHub.
// Todo contra los dobles de az y de gh: ninguna prueba sale a la red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
const C = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));
const AZ_CR = () => require(path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'change-requests.js'));
const PLATFORM_JS = path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const FIX = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-change-request');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Una carpeta de integraciones con los dos conectores de verdad (copias) y los manifiestos extra que pida la prueba. */
function integraciones(extra = {}) {
  const d = tmp('plataformas-');
  for (const n of ['azure-devops', 'github']) fs.cpSync(path.join(ROOT, 'integrations', n), path.join(d, n), { recursive: true });
  for (const [n, m] of Object.entries(extra)) { fs.mkdirSync(path.join(d, n, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(d, n, 'integration.json'), JSON.stringify(m)); }
  return d;
}
/** Un árbol con su perfil vacío, una casa vacía y el entorno que los apunta. */
function mundo(extraInt) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_INTEGRATIONS_DIR: integraciones(extraInt), TYCON_TREE: tree };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|PR_BY_HAND|PR_ONE_PER_REPO|HARNESS_IDENTITIES|PUBLISH_DENYLIST)$|^GH_(TOKEN|REPO|HOST)$|^FAKE_GH_/.test(k)) delete env[k];
  env.TYCON_HOME = path.join(home, '.tycon');
  return { tree, home, env };
}
/** El az de mentira, copiado y ejecutable, con los pedidos ya abiertos en `pedidos`. */
function conAz(m, pedidos = []) {
  const fix = tmp('fixaz-');
  fs.writeFileSync(path.join(fix, 'repos-pr.json'), JSON.stringify(pedidos));
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  Object.assign(m.env, { TYCON_ADO_CMD: az, FIXAZ: fix });
  return {
    fix,
    llamadas: () => { try { return fs.readFileSync(path.join(fix, 'llamadas.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [paso, j] = l.split('\t'); return { paso, args: JSON.parse(j).args }; }); } catch (_) { return []; } },
  };
}
/** El gh de mentira con su estado y su registro de llamadas. */
function conGh(m, estado) {
  const d = tmp('gh-');
  const f = path.join(d, 'estado.json');
  const log = path.join(d, 'llamadas.jsonl');
  fs.writeFileSync(f, JSON.stringify({ user: 'arnes-bot', now: '2026-10-30T10:00:00Z', ...estado }));
  Object.assign(m.env, { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: f, FAKE_GH_LOG: log });
  return {
    estado: () => JSON.parse(fs.readFileSync(f, 'utf8')),
    llamadas: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } },
  };
}
const AZ = { platform: 'azure', org: 'acme', project: 'Producto', repo: 'Backend' };
const GH = { platform: 'github', org: 'acme', repo: 'widgets' };
const ORG = 'https://dev.azure.com/acme';
const abrir = (m, args, repo) => P().run('change-request.open', args, { env: m.env, repo });
const listar = (m, repo) => P().run('change-request.list', {}, { env: m.env, repo });
const pedidoAz = (n, o = {}) => ({ pullRequestId: n, status: 'active', sourceRefName: 'refs/heads/feat/x', targetRefName: 'refs/heads/main', title: 'viejo', description: 'viejo', mergeStatus: 'succeeded', autoCompleteSetBy: null, completionOptions: {}, ...o });
const pullGh = (n, o = {}) => ({ number: n, state: 'open', title: `pedido ${n}`, body: '', created_at: '2026-10-25T10:00:00Z', head: { ref: `feat/${n}` }, base: { ref: 'main' }, user: { login: 'Ana' }, ...o });
const TEXTO = 'feat: algo [skip ci]\n\nel cuerpo\n\n';
const SHOW_QUERY = '{ac:autoCompleteSetBy.id, msg:completionOptions.mergeCommitMessage}';

// ── abrir en Azure DevOps ─────────────────────────────────────────────────────────────────────────────────────────
test('ChangeRequest_Open_Azure_SameAzCalls @story-8.85 @ac-13', async () => {
  // uno nuevo: listar, crear, ponerle el mensaje del merge y verificar, con las mismas banderas que usaba el paso
  const m = mundo();
  const az = conAz(m);
  const dir = tmp('repo-');
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: dir }, AZ);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value, { id: 101, url: 'https://dev.azure.com/acme/_apis/git/pullRequests/101', modo: 'auto', reused: false });
  assert.deepStrictEqual(az.llamadas(), [
    { paso: 'pr-listar', args: ['repos', 'pr', 'list', '--org', ORG, '--project', 'Producto', '--repository', 'Backend', '--source-branch', 'feat/x', '--target-branch', 'main', '--status', 'active', '-o', 'json'] },
    { paso: 'pr-crear', args: ['repos', 'pr', 'create', '--org', ORG, '--project', 'Producto', '--repository', 'Backend', '--source-branch', 'feat/x', '--target-branch', 'main', '--title', 'feat: algo [skip ci]', '--description', 'feat: algo [skip ci]\n\nel cuerpo', '--auto-complete', 'true', '--delete-source-branch', 'true', '--squash', 'false', '-o', 'json'] },
    { paso: 'pr-actualizar', args: ['repos', 'pr', 'update', '--id', '101', '--merge-commit-message', 'Merged PR 101: feat: algo', '--auto-complete', 'true', '--squash', 'false', '--delete-source-branch', 'true', '-o', 'json'] },
    { paso: 'pr-ver', args: ['repos', 'pr', 'show', '--id', '101', '--query', SHOW_QUERY, '-o', 'json'] },
  ]);

  // uno que ya estaba abierto (y choca con su destino): se actualiza con el texto nuevo, no se crea otro
  const m2 = mundo();
  const az2 = conAz(m2, [pedidoAz(55, { mergeStatus: 'conflicts' })]);
  const r2 = await abrir(m2, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: false, title: 'mi título', repoDir: dir }, AZ);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  assert.deepStrictEqual(r2.value, { id: 55, url: 'https://dev.azure.com/acme/_apis/git/pullRequests/55', modo: 'auto', reused: true, conflict: true });
  assert.deepStrictEqual(az2.llamadas().map((l) => l.paso), ['pr-listar', 'pr-actualizar', 'pr-ver']);
  assert.deepStrictEqual(az2.llamadas()[1].args, ['repos', 'pr', 'update', '--id', '55', '--title', 'mi título', '--description', 'feat: algo [skip ci]\n\nel cuerpo', '--merge-commit-message', 'Merged PR 55: feat: algo', '--auto-complete', 'true', '--squash', 'false', '--delete-source-branch', 'false', '-o', 'json']);

  // si la verificación no ve el auto-completar puesto, el pedido quedó abierto: es un «no», con su número
  const m3 = mundo();
  conAz(m3);
  m3.env.TYCON_AZ_PR_WITHOUT_AUTO = '1';
  const r3 = await abrir(m3, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: dir }, AZ);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.reason, 'rechazado');
  assert.match(r3.detail, /#101/);
  assert.match(r3.detail, /auto-completar/);

  // az caído en la creación: el motivo de la capa, nunca un número inventado
  const m4 = mundo();
  conAz(m4);
  m4.env.TYCON_AZ_FAIL = 'pr-crear';
  const r4 = await abrir(m4, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: dir }, AZ);
  assert.strictEqual(r4.ok, false);
  assert.ok(C().REASONS.includes(r4.reason), r4.reason);
});

test('ChangeRequest_Open_Azure_SubjectWithoutSkipMarks @story-8.85 @ac-13', () => {
  const asunto = AZ_CR().asunto;
  assert.strictEqual(typeof asunto, 'function', 'el asunto del merge se exporta para las pruebas');
  const casos = [
    ['feat: algo [skip ci]\n\nel cuerpo', 'feat: algo'],
    ['merge: dev -> main — fix: el arreglo', 'fix: el arreglo'],
    ['fix: x ***NO_CI*** y', 'fix: x y'],
    ['chore: a [AZP SKIP]  skip-checks:true b', 'chore: a b'],
    ['docs: z [skip azurepipelines] [ci skip] [azpipelines skip]', 'docs: z'],
    ['feat: con skip-checks: TRUE al final', 'feat: con al final'],
  ];
  for (const [texto, esperado] of casos) assert.strictEqual(asunto(texto), esperado, texto);
});

test('ChangeRequest_Open_Azure_TextAsFileOnWindows @story-8.85 @ac-13', () => {
  // en Windows az es az.cmd y pasa por la consola: el título y la descripción van como @archivo, nunca sueltos
  const textoParaAz = AZ_CR().textoParaAz;
  const dir = tmp('textos-');
  const valor = 'feat: "comillas" & más\n\ncuerpo';
  const enWin = textoParaAz(valor, dir, 'descripcion', 'win32');
  assert.match(enWin, /^@/);
  assert.strictEqual(fs.readFileSync(enWin.slice(1), 'utf8'), valor);
  assert.strictEqual(textoParaAz(valor, dir, 'descripcion', 'darwin'), valor);
});

// ── abrir en GitHub ───────────────────────────────────────────────────────────────────────────────────────────────
test('ChangeRequest_Open_Github_AutoMergeOrWait @story-8.85 @ac-13', async () => {
  const dir = tmp('repo-');
  const base = { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: dir, pollSeconds: 0 };

  // el repo permite la entrada automática: se crea y se la pide (merge, no squash)
  const m = mundo();
  const gh = conGh(m, { allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'funciona', shas: { 'feat/x': 'a'.repeat(40) } });
  const r = await abrir(m, base, GH);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual({ ...r.value, warnings: undefined }, { id: 1, url: 'https://github.com/acme/widgets/pull/1', modo: 'auto', reused: false, merged: false, warnings: undefined });
  const post = gh.llamadas().find((l) => l.method === 'POST' && /\/pulls$/.test(l.ruta));
  assert.deepStrictEqual(post.cuerpo, { title: 'feat: algo [skip ci]', body: 'feat: algo [skip ci]\n\nel cuerpo', head: 'feat/x', base: 'main' });
  const gql = gh.llamadas().find((l) => l.ruta === 'graphql');
  assert.match(gql.cuerpo.query, /enablePullRequestAutoMerge/);
  assert.strictEqual(gql.cuerpo.variables.mergeMethod, 'MERGE');
  assert.ok(!gh.llamadas().some((l) => l.method === 'PUT'), 'con la entrada automática no se mergea a mano');

  // sin entrada automática: espera los controles de la punta y mergea (merge, con la punta que vio)
  const m2 = mundo();
  const gh2 = conGh(m2, { shas: { 'feat/x': 'b'.repeat(40) }, merge_sin_git: true,
    checks: { ['b'.repeat(40)]: { fotos: [[{ name: 'ci', status: 'in_progress', conclusion: null }], [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }]] } } });
  const r2 = await abrir(m2, base, GH);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  assert.strictEqual(r2.value.modo, 'espera-y-mergea');
  assert.strictEqual(r2.value.merged, true);
  const put = gh2.llamadas().find((l) => l.method === 'PUT');
  assert.match(put.ruta, /pulls\/1\/merge$/);
  assert.strictEqual(put.cuerpo.merge_method, 'merge');
  assert.strictEqual(put.cuerpo.sha, 'b'.repeat(40));
  assert.strictEqual(put.cuerpo.commit_title, 'feat: algo (#1)');
  assert.strictEqual(gh2.llamadas().filter((l) => /check-runs/.test(l.ruta)).length >= 2, true, 'leyó los controles hasta verlos terminados');

  // el repo dice que permite la entrada automática pero no queda puesta: espera y mergea, y lo avisa
  const m3 = mundo();
  conGh(m3, { allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'sin-efecto', merge_sin_git: true, shas: { 'feat/x': 'c'.repeat(40) }, checks: { ['c'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } });
  const r3 = await abrir(m3, base, GH);
  assert.strictEqual(r3.ok, true, JSON.stringify(r3));
  assert.strictEqual(r3.value.modo, 'espera-y-mergea');
  assert.match(r3.value.warnings.join(' '), /entrada automática/);

  // un control que falla: no se mergea, y el «no» dice el pedido y el control
  const m4 = mundo();
  const gh4 = conGh(m4, { merge_sin_git: true, shas: { 'feat/x': 'd'.repeat(40) }, checks: { ['d'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } });
  const r4 = await abrir(m4, base, GH);
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(r4.reason, 'rechazado');
  assert.match(r4.detail, /#1\b/);
  assert.match(r4.detail, /ci/);
  assert.ok(!gh4.llamadas().some((l) => l.method === 'PUT'));

  // en conflicto con su destino
  const m5 = mundo();
  conGh(m5, { pulls: { 'acme/widgets': [pullGh(9, { head: { ref: 'feat/x' }, mergeable: false })] } });
  const r5 = await abrir(m5, base, GH);
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.reason, 'rechazado');
  assert.match(r5.detail, /#9\b.*conflicto|conflicto.*#9\b/);

  // los controles no terminan en el tiempo que había: no medido, con el pedido abierto
  const m6 = mundo();
  conGh(m6, { shas: { 'feat/x': 'e'.repeat(40) }, checks: { ['e'.repeat(40)]: [{ name: 'ci', status: 'queued', conclusion: null }] } });
  const r6 = await abrir(m6, { ...base, waitMinutes: 0 }, GH);
  assert.strictEqual(r6.ok, false);
  assert.strictEqual(r6.reason, 'no_medido');
  assert.match(r6.detail, /#1\b/);
  assert.match(r6.detail, /no terminó en 0 min/);

  // GitHub rechaza el merge (la punta se movió): un «no» con el número
  const m7 = mundo();
  conGh(m7, { shas: { 'feat/x': 'f'.repeat(40) }, checks: { ['f'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }, merge_falla: { 'acme/widgets#1': { status: 409, message: 'Head branch was modified' } } });
  const r7 = await abrir(m7, base, GH);
  assert.strictEqual(r7.ok, false);
  assert.strictEqual(r7.reason, 'rechazado');
  assert.match(r7.detail, /#1\b/);

  // sin credencial y sin red: sus motivos
  const m8 = mundo();
  conGh(m8, { fail: { 'GET repos/acme/widgets/pulls': { status: 401, message: 'Bad credentials' } } });
  assert.strictEqual((await abrir(m8, base, GH)).reason, 'sin_credencial');
  const m9 = mundo();
  conGh(m9, { fail: { 'GET repos/acme/widgets/pulls': { red: true } } });
  assert.strictEqual((await abrir(m9, base, GH)).reason, 'red');
});

test('GhOpen_ReusesOpenRequest @story-8.85 @ac-13', async () => {
  const m = mundo();
  const gh = conGh(m, { allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'funciona', pulls: { 'acme/widgets': [pullGh(4, { head: { ref: 'feat/x' }, title: 'viejo' })] } });
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0 }, GH);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.id, 4);
  assert.strictEqual(r.value.reused, true);
  assert.ok(!gh.llamadas().some((l) => l.method === 'POST' && /\/pulls$/.test(l.ruta)), 'no crea otro');
  const patch = gh.llamadas().find((l) => l.method === 'PATCH');
  assert.deepStrictEqual(patch.cuerpo, { title: 'feat: algo [skip ci]', body: 'feat: algo [skip ci]\n\nel cuerpo' });
  assert.strictEqual(gh.estado().pulls['acme/widgets'][0].title, 'feat: algo [skip ci]');
});

test('GhOpen_RepoNameWithLeadingDot_IsARepo @story-8.85 @ac-13', async () => {
  // `.github` es un nombre de repo válido en GitHub; «..», un dueño o un nombre que empiezan con «-» no lo son
  const m = mundo();
  const gh = conGh(m, { allow_auto_merge: { 'acme/.github': true }, autoMerge: 'funciona' });
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0 }, { platform: 'github', org: 'acme', repo: '.github' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(gh.llamadas().some((l) => l.method === 'POST' && l.ruta === 'repos/acme/.github/pulls'), 'lo abre en acme/.github');
  for (const malo of [{ org: 'acme', repo: '..' }, { org: 'acme', repo: '.' }, { org: '-x', repo: 'widgets' }, { org: 'acme', repo: '-widgets' }, { org: '.', repo: 'widgets' }]) {
    const m2 = mundo();
    const gh2 = conGh(m2, {});
    const r2 = await abrir(m2, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0 }, { platform: 'github', ...malo });
    assert.strictEqual(r2.reason, 'rechazado', JSON.stringify(malo));
    assert.deepStrictEqual(gh2.llamadas(), [], `ningún gh con ${JSON.stringify(malo)}`);
  }
});

test('GhOpen_UnreadableCreateAnswer_FindsItByBranch @story-8.85 @ac-13', async () => {
  // GitHub creó el pedido pero su respuesta no se puede leer: se lo busca por la rama, no se informa «sin número»
  const m = mundo();
  const gh = conGh(m, { pr_create_raw: '<html>', allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'funciona' });
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0 }, GH);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.id, gh.estado().pulls['acme/widgets'][0].number);
  assert.strictEqual(r.value.reused, false);
});

test('GhOpen_EachWayItFails @story-8.85 @ac-13', async () => {
  const base = { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0 };
  const SHA = '9'.repeat(40);
  const verde = { shas: { 'feat/x': SHA }, merge_sin_git: true, checks: { [SHA]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } };

  // GitHub no crea el pedido (422): el «no» trae su mensaje, y no queda ningún pedido
  const m1 = mundo();
  const gh1 = conGh(m1, { fail: { 'POST repos/acme/widgets/pulls': { status: 422, message: 'No commits between main and feat/x' } } });
  const r1 = await abrir(m1, base, GH);
  assert.strictEqual(r1.reason, 'rechazado', JSON.stringify(r1));
  assert.match(r1.detail, /No commits between/);
  assert.deepStrictEqual((gh1.estado().pulls || {})['acme/widgets'] || [], []);

  // un 403 de permiso es una credencial que no alcanza
  const m2 = mundo();
  conGh(m2, { fail: { 'GET repos/acme/widgets/pulls': { status: 403, message: 'Resource not accessible by integration' } } });
  assert.strictEqual((await abrir(m2, base, GH)).reason, 'sin_credencial');

  // la red cae después de abrir: al leer el repo, en la mutación, al releer el pedido y al leer los controles
  const caidas = [
    [{ allow_auto_merge: { 'acme/widgets': true } }, 'GET repos/acme/widgets$'],
    [{ allow_auto_merge: { 'acme/widgets': true } }, 'POST graphql'],
    [{}, 'GET repos/acme/widgets/pulls/1'],
    [{}, 'GET repos/acme/widgets/commits'],
  ];
  for (const [extra, donde] of caidas) {
    const m = mundo();
    const gh = conGh(m, { ...verde, ...extra, fail: { [donde]: { red: true } } });
    const r = await abrir(m, base, GH);
    assert.strictEqual(r.reason, 'red', `${donde}: ${JSON.stringify(r)}`);
    assert.match(r.detail, /#1\b/, donde);
    assert.ok(!gh.llamadas().some((l) => l.method === 'PUT'), `${donde}: sin red no se mergea`);
  }

  // releer el pedido después de la mutación falla (no por la red): no se sabe si quedó la entrada automática, y se dice
  const m3 = mundo();
  conGh(m3, { ...verde, allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'funciona', fail: { 'GET repos/acme/widgets/pulls/1': { status: 500, message: 'boom' } } });
  const r3 = await abrir(m3, base, GH);
  assert.strictEqual(r3.ok, false);
  assert.match(r3.detail, /#1\b.*no pude releerlo/);

  // cada conclusión mala de un control frena el merge, con su nombre
  for (const conclusion of ['cancelled', 'timed_out', 'action_required']) {
    const m = mundo();
    const gh = conGh(m, { shas: { 'feat/x': SHA }, merge_sin_git: true, checks: { [SHA]: [{ name: 'ci', status: 'completed', conclusion }] } });
    const r = await abrir(m, base, GH);
    assert.strictEqual(r.reason, 'rechazado', conclusion);
    assert.match(r.detail, new RegExp(conclusion), conclusion);
    assert.ok(!gh.llamadas().some((l) => l.method === 'PUT'), conclusion);
  }

  // GitHub no deja mergear un pedido que no está abierto (405)
  const m4 = mundo();
  conGh(m4, { ...verde, merge_falla: { 'acme/widgets#1': { status: 405, message: 'Pull Request is not mergeable' } } });
  const r4 = await abrir(m4, base, GH);
  assert.strictEqual(r4.reason, 'rechazado');
  assert.match(r4.detail, /#1\b.*not mergeable/);
});

test('MergeStep_GithubWithoutCheck_DoesNotOpen @story-8.85 @ac-13', () => {
  // el paso del merge no abre un pedido de GitHub sin control declarado: no habría con qué esperar el verde
  const paso = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-merge-to-main', 'steps', 'step-09b-create-change-request.md'), 'utf8');
  assert.match(paso, /GitHub sin `merge\.check` declarado[^\n]*el pedido \*\*no se abre\*\*/);
});

test('Azure_ProjectOrRepoLikeAnOption_Rechazado @story-8.85 @ac-13', async () => {
  const m = mundo();
  const az = conAz(m);
  for (const repo of [{ ...AZ, project: '-p' }, { ...AZ, repo: '--evil' }]) {
    const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true }, repo);
    assert.strictEqual(r.reason, 'rechazado', JSON.stringify(r));
  }
  assert.deepStrictEqual(az.llamadas(), [], 'ningún az');
});

test('GhOpen_DeclaredCheckOnly @story-8.85 @ac-13', async () => {
  // con `check`, sólo cuenta el control de ese nombre: otro en curso no lo hace esperar
  const m = mundo();
  const gh = conGh(m, { merge_sin_git: true, shas: { 'feat/x': '1'.repeat(40) }, checks: { ['1'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'otro', status: 'in_progress', conclusion: null }] } });
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0, check: 'ci' }, GH);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.merged, true);
  assert.ok(gh.llamadas().some((l) => l.method === 'PUT'));
  // el control declarado que no aparece nunca no es «verde»: se espera hasta el tope
  const m2 = mundo();
  conGh(m2, { merge_sin_git: true, shas: { 'feat/x': '2'.repeat(40) }, checks: { ['2'.repeat(40)]: [{ name: 'otro', status: 'completed', conclusion: 'success' }] } });
  const r2 = await abrir(m2, { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0, waitMinutes: 0, check: 'ci' }, GH);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'no_medido');
});

test('GhOpen_PublishingGuardBlocks @story-8.85 @ac-13', async () => {
  // un pedido al repo público del arnés pasa por el freno de publicación antes de salir: con un nombre de la lista, no sale
  const m = mundo();
  const lista = path.join(tmp('lista-'), 'denylist.json');
  fs.writeFileSync(lista, JSON.stringify({ terminos: [{ patron: 'ClienteSecreto', categoria: 'cliente' }], permitidos: [] }));
  Object.assign(m.env, { TYCON_HARNESS_IDENTITIES: 'https://github.com/acme/widgets', TYCON_PUBLISH_DENYLIST: lista });
  const gh = conGh(m, { allow_auto_merge: { 'acme/widgets': true }, autoMerge: 'funciona' });
  const r = await abrir(m, { sourceBranch: 'feat/x', targetBranch: 'main', text: 'feat: lo de ClienteSecreto\n\ncuerpo', deleteSourceBranch: true, repoDir: tmp('repo-') }, GH);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rechazado');
  assert.match(r.detail, /freno de publicación/);
  assert.doesNotMatch(r.detail, /ClienteSecreto/, 'el «no» no repite lo que no puede salir');
  assert.ok(!gh.llamadas().some((l) => l.method !== 'GET'), 'nada se escribió en GitHub');
});

test('Open_ArgsInvalid_RechazadoSinLlamar @story-8.85 @ac-13', async () => {
  const malos = [
    {},
    { sourceBranch: 'feat/x', targetBranch: 'main', deleteSourceBranch: true },
    { sourceBranch: '', targetBranch: 'main', text: 't', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: 't' },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: 't', deleteSourceBranch: true, waitMinutes: -1 },
    { sourceBranch: '--evil', targetBranch: 'main', text: 't', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '-x', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: 't', title: '--evil', deleteSourceBranch: true },
    // con título, el texto también va suelto (es la descripción): se mira aparte
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '--evil', title: 'bien', deleteSourceBranch: true },
    // `az` lee como archivo un valor que empieza con «@»: publicaría el contenido de un archivo de la máquina
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '@/etc/passwd', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: 't', title: '@~/.ssh/id_rsa', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '@secreto.txt', title: 'bien', deleteSourceBranch: true },
    // sin título, el título es la primera línea del texto: en blanco, el pedido se abriría sin título
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '\ncuerpo', deleteSourceBranch: true },
    { sourceBranch: 'feat/x', targetBranch: 'main', text: '   \r\ncuerpo', deleteSourceBranch: true },
  ];
  for (const args of malos) {
    const m = mundo();
    const az = conAz(m);
    const gh = conGh(m, {});
    for (const repo of [AZ, GH]) {
      const r = await abrir(m, args, repo);
      assert.strictEqual(r.ok, false, JSON.stringify(args));
      assert.strictEqual(r.reason, 'rechazado', JSON.stringify(args));
    }
    assert.deepStrictEqual(az.llamadas(), [], 'ningún az');
    assert.deepStrictEqual(gh.llamadas(), [], 'ningún gh');
  }
});

// ── listar ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('AdoList_AuthorAndCiRunning @story-8.85 @ac-16', async () => {
  const m = mundo();
  const fix = tmp('fixaz-');
  fs.writeFileSync(path.join(fix, 'prs-0.json'), JSON.stringify({ count: 1, value: [{ pullRequestId: 7, isDraft: false, mergeStatus: 'succeeded', status: 'active', title: 'p', sourceRefName: 'refs/heads/x', creationDate: '2026-10-25T10:00:00Z', lastMergeSourceCommit: { commitId: 'a'.repeat(40) }, repository: { name: 'Backend', project: { name: 'Producto' } }, createdBy: { uniqueName: 'Ana@Example.com' } }] }));
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  Object.assign(m.env, { TYCON_ADO_CMD: az, FIXAZ: fix });
  const r = await listar(m, AZ);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value[0].author, 'ana@example.com');
  assert.strictEqual(r.value[0].ciRunning, null, 'Azure no dice desde esta lista si la CI corre: no se inventa');
});

test('GhChecks_ReadRunsAndCommitStatuses @story-8.85 @ac-13', async () => {
  // una CI que informa por estados de commit (la API vieja) cuenta igual que un check-run: rojo en cualquiera no mergea
  const base = { sourceBranch: 'feat/x', targetBranch: 'main', text: TEXTO, deleteSourceBranch: true, repoDir: tmp('repo-'), pollSeconds: 0, waitMinutes: 0 };
  const SHA = '9'.repeat(40);
  const conCi = (extra) => ({ shas: { 'feat/x': SHA }, merge_sin_git: true, ...extra });
  const sinPut = (gh) => !gh.llamadas().some((l) => l.method === 'PUT');

  // el control declarado informa sólo por estado, en rojo: se rechaza, no «no apareció»
  const m1 = mundo();
  const gh1 = conGh(m1, conCi({ statuses: { [SHA]: [{ context: 'ci/azure', state: 'failure' }] } }));
  const r1 = await abrir(m1, { ...base, check: 'ci/azure' }, GH);
  assert.strictEqual(r1.reason, 'rechazado', JSON.stringify(r1));
  assert.match(r1.detail, /ci\/azure terminó en failure/);
  assert.ok(sinPut(gh1));

  // un check-run verde y un estado rojo: no se mergea
  const m2 = mundo();
  const gh2 = conGh(m2, conCi({ checks: { [SHA]: [{ name: 'lint', status: 'completed', conclusion: 'success' }] }, statuses: { [SHA]: [{ context: 'ci/azure', state: 'error' }] } }));
  assert.strictEqual((await abrir(m2, base, GH)).reason, 'rechazado');
  assert.ok(sinPut(gh2));

  // vale el estado más nuevo de cada contexto (GitHub los devuelve del más nuevo al más viejo)
  const m3 = mundo();
  const gh3 = conGh(m3, conCi({ statuses: { [SHA]: [{ context: 'ci/azure', state: 'success' }, { context: 'ci/azure', state: 'failure' }] } }));
  const r3 = await abrir(m3, { ...base, check: 'ci/azure' }, GH);
  assert.strictEqual(r3.ok, true, JSON.stringify(r3));
  assert.strictEqual(r3.value.merged, true);
  assert.ok(!sinPut(gh3));

  // un estado en curso no es verde: el tope vence y el pedido queda abierto
  const m4 = mundo();
  const gh4 = conGh(m4, conCi({ checks: { [SHA]: [{ name: 'lint', status: 'completed', conclusion: 'success' }] }, statuses: { [SHA]: [{ context: 'ci/azure', state: 'pending' }] } }));
  assert.strictEqual((await abrir(m4, base, GH)).reason, 'no_medido');
  assert.ok(sinPut(gh4));

  // si los estados no se pueden leer, nunca se da por verde aunque los check-runs lo estén
  const m5 = mundo();
  const gh5 = conGh(m5, conCi({ checks: { [SHA]: [{ name: 'lint', status: 'completed', conclusion: 'success' }] }, fail: { [`GET repos/acme/widgets/commits/${SHA}/statuses`]: { status: 500, message: 'caído' } } }));
  const r5 = await abrir(m5, base, GH);
  assert.strictEqual(r5.ok, false, JSON.stringify(r5));
  assert.ok(sinPut(gh5));

  // la lista: un estado en curso es una validación corriendo; si los estados no se leen, no se sabe
  const m6 = mundo();
  conGh(m6, {
    shas: { 'feat/1': '1'.repeat(40), 'feat/2': '2'.repeat(40) },
    pulls: { 'acme/widgets': [pullGh(1), pullGh(2)] },
    statuses: { ['1'.repeat(40)]: [{ context: 'ci/azure', state: 'pending' }] },
    fail: { [`GET repos/acme/widgets/commits/${'2'.repeat(40)}/statuses`]: { status: 500, message: 'caído' } },
  });
  const l = await listar(m6, GH);
  assert.strictEqual(l.ok, true, JSON.stringify(l));
  assert.strictEqual(l.value[0].ciRunning, true);
  assert.strictEqual(l.value[1].ciRunning, null);
});

test('GhList_MapsFields_CiRunningFromCheckRuns @story-8.85 @ac-16', async () => {
  const m = mundo();
  conGh(m, {
    shas: { 'feat/1': '1'.repeat(40), 'feat/2': '2'.repeat(40), 'feat/3': '3'.repeat(40) },
    pulls: { 'acme/widgets': [
      pullGh(1, { draft: true, auto_merge: { merge_method: 'merge' } }),
      pullGh(2, { mergeable: false }),
      pullGh(3, { user: { login: 'Beto' } }),
      pullGh(4, { state: 'closed' }),
    ] },
    checks: { ['1'.repeat(40)]: [{ name: 'ci', status: 'in_progress', conclusion: null }], ['2'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
    fail: { 'GET repos/acme/widgets/commits/3333': { status: 500, message: 'caído' } },
  });
  const r = await listar(m, GH);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value.map((p) => p.number), [1, 2, 3], 'sólo los abiertos');
  assert.deepStrictEqual(r.value[0], { number: 1, draft: true, autoComplete: true, mergeState: 'clean', sourceBranch: 'feat/1', sourceCommit: '1'.repeat(40), createdAt: '2026-10-25T10:00:00Z', title: 'pedido 1', author: 'ana', ciRunning: true });
  assert.strictEqual(r.value[1].mergeState, 'conflict');
  assert.strictEqual(r.value[1].ciRunning, false);
  assert.strictEqual(r.value[2].author, 'beto');
  assert.strictEqual(r.value[2].ciRunning, null, 'los controles que no se pudieron leer: no se sabe, no «no corre»');

  // la lista que no se pudo leer es un «no», nunca una lista vacía
  const m2 = mundo();
  conGh(m2, { fail: { 'GET repos/acme/widgets/pulls': { status: 500, message: 'caído' } } });
  const r2 = await listar(m2, GH);
  assert.strictEqual(r2.ok, false);
  assert.ok(!Array.isArray(r2.value));
});

// ── los comandos crudos de cada conector y los frenos ─────────────────────────────────────────────────────────────
const crudo = (env, ...argv) => spawnSync(process.execPath, [PLATFORM_JS, 'raw-command', ...argv], { encoding: 'utf8', env });

test('Guards_RawCommandsOfEachConnector @story-8.85 @ac-15', () => {
  const m = mundo();
  const de = (cmd) => { const r = crudo(m.env, cmd); return { status: r.status, out: r.stdout.trim(), err: r.stderr }; };
  assert.deepStrictEqual(de('gh pr create --title x --body y'), { status: 0, out: 'github', err: '' });
  assert.deepStrictEqual(de('az repos pr create --title x'), { status: 0, out: 'azure-devops', err: '' });
  assert.strictEqual(de('env FOO=1 /usr/local/bin/gh.exe pr merge 3').out, 'github');
  assert.strictEqual(de('az --only-show-errors repos pr update --id 3').out, 'azure-devops');
  assert.strictEqual(de('cd x && gh issue close 3').out, 'github');
  for (const nada of ['echo gh pr create', 'git push origin main', 'gh pr view 3', 'grep "az repos pr create" notas.md']) {
    const r = de(nada);
    assert.deepStrictEqual([r.status, r.out], [1, ''], nada);
  }
  assert.strictEqual(crudo(m.env).status, 2, 'sin comando es un uso incorrecto');
  // dos conectores que dicen el mismo comando: no se elige a ciegas
  const dos = mundo({ otra: { __doc: 'de prueba', name: 'otra', label: 'Otra', kind: 'platform', connector: 'scripts/connector.js', operations: ['ci.read'], rawCommands: ['gh pr create'] } });
  const ambos = crudo(dos.env, 'gh pr create --title x');
  assert.strictEqual(ambos.status, 2, 'dos conectores no es «ninguno»: no se sabe cuál mira');
  assert.match(ambos.stderr, /lo reconocen github y otra|lo reconocen otra y github/);
  assert.throws(() => P().rawCommandOf('gh pr create', { env: dos.env }), /lo reconocen/);
  assert.strictEqual(typeof P().rawCommandOf, 'function', 'los frenos lo usan sin lanzar otro proceso');
  assert.strictEqual(P().rawCommandOf('gh pr merge 3', { env: m.env }), 'github');
  assert.strictEqual(P().rawCommandOf('echo gh pr merge 3', { env: m.env }), null);
  // una integración que no se lee: no se sabe qué comandos declara, así que no contesta «ninguno»
  const rota = mundo();
  fs.mkdirSync(path.join(rota.env.TYCON_INTEGRATIONS_DIR, 'rota'));
  fs.writeFileSync(path.join(rota.env.TYCON_INTEGRATIONS_DIR, 'rota', 'integration.json'), '{ no es json');
  const r = crudo(rota.env, 'gh pr create --title x');
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no pude leer rota/);
  assert.throws(() => P().rawCommandOf('gh pr create', { env: rota.env }), /no pude leer/);
});

const AUTO = path.join(ROOT, 'scripts', 'hooks', 'pr-auto-complete-guard.js');
const UNO = path.join(ROOT, 'scripts', 'hooks', 'pr-one-per-repo-guard.js');
const freno = (hook, env, command, cwd) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: cwd || os.tmpdir() }), encoding: 'utf8', env });
const frenos = (home) => { try { return fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'frenos.jsonl'), 'utf8'); } catch (_) { return ''; } };

test('Guards_ReadBothPlatforms @story-8.85 @ac-15', () => {
  // el freno de auto-completar: en GitHub, mergear a mano con squash o sacando la entrada automática no sale
  const m = mundo();
  for (const malo of ['gh pr merge 12 --squash', 'gh pr merge 12 -s', 'gh pr merge 12 --rebase', 'gh pr merge 12 -r', 'gh pr merge 12 --disable-auto']) {
    const r = freno(AUTO, m.env, malo);
    assert.strictEqual(r.status, 2, `${malo}: ${r.stderr}`);
    assert.match(r.stderr, /gh pr merge/);
  }
  assert.match(frenos(m.home), /"freno":"pr-sin-auto-complete"/);
  // la misma regla detrás de cualquier envoltorio, con banderas cortas juntas o entre comillas, como la ve `gh`
  for (const malo of ['gh pr merge 5 -sd', 'gh pr merge 5 -ds', 'gh pr merge 5 -rd', 'gh pr merge 5 "--squash"', 'sudo gh pr merge 5 --squash',
    'time gh pr merge 5 --squash', 'echo 5 | xargs gh pr merge --squash', 'nohup gh -R a/b pr merge 5 -s', 'env FOO=1 gh pr merge 5 --squash=true',
    'gh pr merge 5 -dt asunto --rebase', 'gh pr merge 5 $OPCIONES']) {
    const r = freno(AUTO, m.env, malo);
    assert.strictEqual(r.status, 2, `${malo}: ${r.stderr}`);
  }
  for (const bueno of ['gh pr merge 12', 'gh pr merge 12 --merge --auto', 'gh pr create --base main --title t --body b', 'echo gh pr merge 12 --squash',
    'gh pr merge 5 --body "--squash"', 'gh pr merge 5 -t "-s"', 'gh pr merge 5 -ts', 'gh pr merge $N --merge', 'gh pr merge 5 -dm', 'gh pr merge 5 --squash=false']) {
    assert.strictEqual(freno(AUTO, m.env, bueno).status, 0, bueno);
  }
  // adentro de una cadena que ejecuta otro intérprete no se leen sus banderas: lo que no se pudo mirar no pasa
  for (const escondido of ['bash -c "gh pr merge 12 --squash"', "sh -c 'gh pr merge 12'"]) {
    const r = freno(AUTO, m.env, escondido);
    assert.strictEqual(r.status, 2, `${escondido}: ${r.stderr}`);
    assert.match(r.stderr, /intérprete/);
  }
  assert.strictEqual(freno(AUTO, m.env, 'bash -c "gh pr view 12"').status, 0, 'un gh que no mergea, adentro de bash -c, no se toca');
  const escape = freno(AUTO, m.env, 'TYCON_PR_BY_HAND=1 gh pr merge 12 --squash');
  assert.strictEqual(escape.status, 0);
  assert.match(escape.stderr, /TYCON_PR_BY_HAND=1/);
  // lo de Azure DevOps sigue como estaba
  assert.strictEqual(freno(AUTO, m.env, 'az repos pr create --org https://dev.azure.com/acme -p P -r R -s feat/x -t main --title t').status, 2);
  assert.strictEqual(freno(AUTO, m.env, 'az repos pr create --org https://dev.azure.com/acme -p P -r R -s feat/x -t main --title t --auto-complete true --squash false').status, 0);

  // el freno de un pedido por repo: en GitHub frena sólo con la CI de otro pedido corriendo
  const uno = (estado, command) => {
    const w = mundo();
    w.env.TYCON_PR_ONE_PER_REPO = '1';
    conGh(w, estado);
    return freno(UNO, w.env, command);
  };
  const crear = 'gh pr create --repo acme/widgets --base main --head feat/y --title t --body b';
  const corriendo = { shas: { 'feat/3': '3'.repeat(40) }, pulls: { 'acme/widgets': [pullGh(3)] }, checks: { ['3'.repeat(40)]: [{ name: 'ci', status: 'in_progress', conclusion: null }] } };
  const r1 = uno(corriendo, crear);
  assert.strictEqual(r1.status, 2, r1.stderr);
  assert.match(r1.stderr, /#3|PR 3/);
  const terminada = { ...corriendo, checks: { ['3'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } };
  assert.strictEqual(uno(terminada, crear).status, 0);
  // el mismo pedido re-creado (su propia rama) no cuenta
  assert.strictEqual(uno({ ...corriendo, pulls: { 'acme/widgets': [pullGh(3, { head: { ref: 'feat/y' } })] }, shas: { 'feat/y': '3'.repeat(40) } }, crear).status, 0);
  // no pudo mirar: deja pasar y lo dice
  const sinLista = uno({ fail: { 'GET repos/acme/widgets/pulls': { status: 500, message: 'caído' } } }, crear);
  assert.strictEqual(sinLista.status, 0);
  assert.match(sinLista.stderr, /no pude/);
  const sinControles = uno({ ...corriendo, fail: { 'GET repos/acme/widgets/commits': { status: 500, message: 'caído' } } }, crear);
  assert.strictEqual(sinControles.status, 0);
  assert.match(sinControles.stderr, /no pude|no sé/);
  // un repo que no se sabe (sin --repo, fuera de un clon): deja pasar y lo dice
  const sinRepo = uno(corriendo, 'gh pr create --base main --head feat/y --title t --body b');
  assert.strictEqual(sinRepo.status, 0);
  assert.match(sinRepo.stderr, /no pude|no sé/);
  // la llamada a la capa también se mira
  const porLaCapa = `node ${PLATFORM_JS} change-request open --repo '{"platform":"github","org":"acme","repo":"widgets"}' --auto-complete --args '{"sourceBranch":"feat/y","targetBranch":"main","text":"t","deleteSourceBranch":true}'`;
  const r2 = uno(corriendo, porLaCapa);
  assert.strictEqual(r2.status, 2, r2.stderr);
  assert.strictEqual(uno(terminada, porLaCapa).status, 0);
  // los argumentos de la capa en un archivo que no se puede leer: deja pasar y lo dice
  const sinArgs = uno(corriendo, `node ${PLATFORM_JS} change-request open --repo acme/widgets --auto-complete --args @no-existe.json`);
  assert.strictEqual(sinArgs.status, 0, sinArgs.stderr);
  assert.match(sinArgs.stderr, /no pude leer/);
  assert.match(sinArgs.stderr, /NO verifiqué/);
});

test('Cli_OpenWithoutAutoComplete_Exit2 @story-8.85 @ac-13', () => {
  const m = mundo();
  const gh = conGh(m, {});
  const args = JSON.stringify({ sourceBranch: 'feat/x', targetBranch: 'main', text: 't', deleteSourceBranch: true });
  const r = spawnSync(process.execPath, [PLATFORM_JS, 'change-request', 'open', '--repo', JSON.stringify(GH), '--args', args], { encoding: 'utf8', env: m.env });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--auto-complete/);
  assert.deepStrictEqual(gh.llamadas(), []);
  // con la bandera y los topes de espera en la línea, abre
  conGh(m, { merge_sin_git: true, shas: { 'feat/x': '9'.repeat(40) }, checks: { ['9'.repeat(40)]: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } });
  const ok = spawnSync(process.execPath, [PLATFORM_JS, 'change-request', 'open', '--repo', JSON.stringify(GH), '--auto-complete', '--wait-minutes', '1', '--poll-seconds', '0', '--args', args], { encoding: 'utf8', env: m.env });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.strictEqual(j.ok, true, ok.stdout);
  assert.strictEqual(j.value.merged, true);
});

// ── los nocturnos ─────────────────────────────────────────────────────────────────────────────────────────────────
const ANTES = JSON.parse(fs.readFileSync(path.join(FIX, 'azure-before.json'), 'utf8'));
const OPEN_PRS = path.join(ROOT, 'scripts', 'nightly', 'open-prs', 'open-prs.js');
const ASSIGNED = path.join(ROOT, 'scripts', 'nightly', 'assigned', 'assigned-items.js');
const sinGenerado = (f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.generado; return j; };
/** El entorno de los nocturnos en Azure, como el que grabó la salida de antes. */
function nocheAzure() {
  const d = tmp('noche-');
  const fix = path.join(d, 'fixaz');
  fs.cpSync(path.join(FIX, 'azure'), fix, { recursive: true });
  // el az de mentira busca los estados y la consulta por el nombre del proyecto que declara repos.json
  const proyecto = 'Proyecto X';
  for (const [de, a] of [['states-Bug.json', `estados-${proyecto}-Bug.json`], ['states-Task.json', `estados-${proyecto}-Task.json`], ['query.json', `wiql-${proyecto}.json`]]) {
    fs.renameSync(path.join(fix, de), path.join(fix, a));
  }
  const az = path.join(d, 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const home = path.join(d, 'casa');
  fs.mkdirSync(home);
  return { d, fix, env: { PATH: process.env.PATH, HOME: home, FIXAZ: fix, TYCON_ADO_CMD: az } };
}

test('OpenPrs_Github_RepeatedRepoAndSameNumber_CountOnce @story-8.85 @ac-16', () => {
  // un repo declarado dos veces (una entrada por ecosistema, o con un espacio de más) se lee una vez; y el #1 de un repo
  // no tapa al #1 de otro: en GitHub cada repo numera desde 1
  const m = mundo();
  conGh(m, { pulls: {
    'acme/widgets': [pullGh(1, { created_at: '2026-10-20T08:00:00Z' })],
    'acme/otro': [pullGh(1, { created_at: '2026-10-21T08:00:00Z' })],
  } });
  const repos = path.join(tmp('repos-'), 'repos.json');
  fs.writeFileSync(repos, JSON.stringify({ repos: [{ ruta: 'a', github: 'acme/widgets' }, { ruta: 'b', github: 'acme/widgets ' }, { ruta: 'c', github: 'acme/otro' }] }));
  const d = tmp('gh-repetido-');
  const g = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--json', path.join(d, 'o.json'), '--out', path.join(d, 'o.txt')], { encoding: 'utf8', env: m.env });
  assert.strictEqual(g.status, 0, g.stderr);
  assert.strictEqual(fs.readFileSync(path.join(d, 'o.txt'), 'utf8'), 'PR abiertos hace más de 2 días: 2\n');
  assert.deepStrictEqual(sinGenerado(path.join(d, 'o.json')).prs.map((p) => `${p.repo}#${p.numero}`), ['otro#1', 'widgets#1']);
});

test('OpenPrs_Github_MeasuresInsteadOfNoMedido @story-8.85 @ac-16', () => {
  // Azure DevOps: la misma salida, byte a byte, que antes del cambio
  const a = nocheAzure();
  const o = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--org', ORG, '--json', path.join(a.d, 'o.json'), '--out', path.join(a.d, 'o.txt')], { encoding: 'utf8', env: a.env });
  assert.deepStrictEqual({ status: o.status, stdout: o.stdout, stderr: o.stderr, out: fs.readFileSync(path.join(a.d, 'o.txt'), 'utf8'), json: sinGenerado(path.join(a.d, 'o.json')) }, ANTES.openPrs);

  // GitHub: se mide por la capa, repo por repo
  const m = mundo();
  conGh(m, { pulls: { 'acme/widgets': [
    pullGh(5, { created_at: '2026-10-20T08:00:00Z' }),
    pullGh(6, { draft: true, created_at: '2026-10-01T08:00:00Z' }),
    pullGh(7, { created_at: '2026-10-29T08:00:00Z', user: { login: 'Beto' } }),
    pullGh(8, { created_at: '2026-10-01T08:00:00Z', head: { ref: 'vigilante/algo' } }),
  ] } });
  const d = tmp('gh-noche-');
  const repos = path.join(FIX, 'azure', 'repos.json');
  const g = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--json', path.join(d, 'o.json'), '--out', path.join(d, 'o.txt')], { encoding: 'utf8', env: m.env });
  assert.strictEqual(g.status, 0, g.stderr);
  assert.strictEqual(g.stdout, 'PR abiertos hace más de 2 días: 1\n#5 acme/widgets — ana — 10 días\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'o.txt'), 'utf8'), 'PR abiertos hace más de 2 días: 1\n');
  const j = sinGenerado(path.join(d, 'o.json'));
  assert.strictEqual(j.estado, 'medido');
  assert.deepStrictEqual(j.prs, [
    { numero: 5, proyecto: 'acme', repo: 'widgets', dias: 10, autor: 'ana', enlace: 'https://github.com/acme/widgets/pull/5' },
    { numero: 7, proyecto: 'acme', repo: 'widgets', dias: 1, autor: 'beto', enlace: 'https://github.com/acme/widgets/pull/7' },
  ]);

  // un repo que no se pudo leer: no medido con su motivo, nunca «ninguno»
  const m2 = mundo();
  conGh(m2, { fail: { 'GET repos/acme/widgets/pulls': { status: 500, message: 'caído' } } });
  const d2 = tmp('gh-noche-');
  const g2 = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--json', path.join(d2, 'o.json'), '--out', path.join(d2, 'o.txt')], { encoding: 'utf8', env: m2.env });
  assert.strictEqual(g2.status, 1);
  assert.match(g2.stdout, /no se pudo consultar/);
  assert.match(g2.stdout, /acme\/widgets/);
  assert.strictEqual(sinGenerado(path.join(d2, 'o.json')).estado, 'no_medido');
  assert.strictEqual(fs.readFileSync(path.join(d2, 'o.txt'), 'utf8'), 'PR abiertos hace más de 2 días: ? (no se pudo consultar)\n');
});

test('Assigned_Github_ListsIssuesAndPrs @story-8.85 @ac-16', () => {
  // Azure DevOps: la misma salida, byte a byte, que antes del cambio
  const a = nocheAzure();
  const r = spawnSync(process.execPath, [ASSIGNED, '--today', '2026-10-30', '--org', ORG, '--repos', path.join(a.fix, 'repos.json'), '--out', path.join(a.d, 'asig')], { encoding: 'utf8', env: a.env });
  assert.deepStrictEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr, json: sinGenerado(path.join(a.d, 'asig', 'assigned-2026-10-30.json')) }, ANTES.assigned);

  // GitHub: los issues y los pull requests abiertos con alguien asignado, una fila por persona
  const m = mundo();
  conGh(m, {
    issuesConPulls: true,
    issues: { 'acme/widgets': [
      { number: 1, state: 'open', title: 'un issue', assignees: ['Ana', 'beto'], labels: [] },
      { number: 2, state: 'open', title: 'sin nadie', assignees: [], labels: [] },
      { number: 3, state: 'closed', title: 'cerrado', assignees: ['Ana'], labels: [] },
    ] },
    pulls: { 'acme/widgets': [pullGh(4, { assignees: ['Ana'] })] },
  });
  const d = tmp('asig-gh-');
  const g = spawnSync(process.execPath, [ASSIGNED, '--today', '2026-10-30', '--provider', 'github', '--repos', path.join(FIX, 'azure', 'repos.json'), '--out', d], { encoding: 'utf8', env: m.env });
  assert.strictEqual(g.status, 0, g.stderr);
  const j = sinGenerado(path.join(d, 'assigned-2026-10-30.json'));
  assert.strictEqual(j.estado, 'medido');
  const fila = (id, tipo, asignado, titulo, enlace) => ({ id, proyecto: 'acme/widgets', tipo, estado: 'open', asignado, dias_en_estado: null, enlace, dependencias: false, titulo });
  assert.deepStrictEqual(j.pedidos, [
    fila(1, 'issue', 'ana', 'un issue', 'https://github.com/acme/widgets/issues/1'),
    fila(1, 'issue', 'beto', 'un issue', 'https://github.com/acme/widgets/issues/1'),
    fila(4, 'pull request', 'ana', 'pedido 4', 'https://github.com/acme/widgets/pull/4'),
  ]);
  assert.deepStrictEqual(j.proyectos_no_medidos, []);

  // un repo que no se pudo leer queda en proyectos_no_medidos con su motivo
  const m2 = mundo();
  conGh(m2, { fail: { 'GET repos/acme/widgets/issues': { status: 500, message: 'caído' } } });
  const d2 = tmp('asig-gh-');
  const g2 = spawnSync(process.execPath, [ASSIGNED, '--today', '2026-10-30', '--provider', 'github', '--repos', path.join(FIX, 'azure', 'repos.json'), '--out', d2], { encoding: 'utf8', env: m2.env });
  assert.strictEqual(g2.status, 1);
  const j2 = sinGenerado(path.join(d2, 'assigned-2026-10-30.json'));
  assert.strictEqual(j2.estado, 'no_medido');
  assert.strictEqual(j2.proyectos_no_medidos[0].proyecto, 'acme/widgets');
});

test('Nightlies_Github_NoReposDeclared_IsNoMedido @story-8.85 @ac-16', () => {
  // sin repos de GitHub que mirar, los dos nocturnos dicen «no medido», nunca «ninguno»
  const m = mundo();
  const gh = conGh(m, {});
  const repos = path.join(tmp('repos-'), 'repos.json');
  fs.writeFileSync(repos, JSON.stringify({ repos: [{ azure: 'Producto/Backend', activo: true }] }));
  const d = tmp('sin-gh-');
  const o = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--json', path.join(d, 'o.json'), '--out', path.join(d, 'o.txt')], { encoding: 'utf8', env: m.env });
  assert.strictEqual(o.status, 1, o.stdout + o.stderr);
  assert.strictEqual(sinGenerado(path.join(d, 'o.json')).estado, 'no_medido');
  assert.strictEqual(fs.readFileSync(path.join(d, 'o.txt'), 'utf8'), 'PR abiertos hace más de 2 días: ? (no se pudo consultar)\n');
  const a = spawnSync(process.execPath, [ASSIGNED, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--out', d], { encoding: 'utf8', env: m.env });
  assert.strictEqual(a.status, 1, a.stdout + a.stderr);
  const j = sinGenerado(path.join(d, 'assigned-2026-10-30.json'));
  assert.strictEqual(j.estado, 'no_medido');
  assert.match(j.motivo, /ningún repo de GitHub/);
  assert.deepStrictEqual(gh.llamadas(), [], 'no consulta nada');
});

test('Nightlies_Github_MalformedRepo_IsNoMedido @story-8.85 @ac-16', () => {
  // un `github:` sin dueño/nombre no se descarta callado: queda no medido con su nombre
  const m = mundo();
  conGh(m, { issuesConPulls: true, issues: { 'acme/widgets': [] }, pulls: { 'acme/widgets': [] } });
  const repos = path.join(tmp('repos-'), 'repos.json');
  fs.writeFileSync(repos, JSON.stringify({ repos: [{ github: 'acme/widgets', activo: true }, { github: 'widgets-sin-dueño', activo: true }] }));
  const d = tmp('mal-gh-');
  const a = spawnSync(process.execPath, [ASSIGNED, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--out', d], { encoding: 'utf8', env: m.env });
  assert.strictEqual(a.status, 1, a.stdout + a.stderr);
  const j = sinGenerado(path.join(d, 'assigned-2026-10-30.json'));
  // los demás repos quedan medidos, como un proyecto de Azure que no se pudo leer
  assert.strictEqual(j.estado, 'medido');
  assert.deepStrictEqual(j.proyectos_no_medidos.map((x) => x.proyecto), ['widgets-sin-dueño']);
  assert.match(j.proyectos_no_medidos[0].motivo, /no es dueño\/nombre/);
  const o = spawnSync(process.execPath, [OPEN_PRS, '--today', '2026-10-30', '--provider', 'github', '--repos', repos, '--json', path.join(d, 'o.json'), '--out', path.join(d, 'o.txt')], { encoding: 'utf8', env: m.env });
  assert.strictEqual(o.status, 1, o.stdout + o.stderr);
  assert.match(o.stdout, /widgets-sin-dueño/);
});
