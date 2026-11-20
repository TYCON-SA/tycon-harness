'use strict';
/**
 * branch-approval.test.js — la regla de aprobación de main: la lectura de la capa de plataforma (`branch-rules.read`), el
 * conector de Azure DevOps que la contesta, el comando que la juzga (scripts/tools/branch-approval.js) y el aviso de
 * `harness.js doctor --fetch`. Azure es el az de mentira (scripts/tests/lib/fake-az.sh, por TYCON_ADO_CMD): ningún caso
 * toca la red ni la casa real (cada uno con una casa vacía y su propio árbol con team-repos.json).
 *
 * Correr: node --test scripts/tests/branch-approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'tools', 'branch-approval.js');
const FAKE_AZ = path.join(__dirname, 'lib', 'fake-az.sh');
const TIPO = 'id-del-tipo-de-revisores';
const AZ = { platform: 'azure', org: 'acme', project: 'Producto', repo: 'Backend' };

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Un árbol con team-repos.json (los repos van en merge_suites), una casa vacía y el az de mentira con sus fixtures. */
function mundo(repos = [AZ]) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({
    version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' },
    operations: { platform: 'github', org: 'acme', repo: 'operaciones' }, merge_suites: { repos: repos.map((repo) => ({ repo, rule: 'automatico' })) },
  }));
  const fix = tmp('fixaz-');
  // el doble va copiado y ejecutable: en git no lleva el bit de ejecución
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_TREE: tree, TYCON_ADO_CMD: az, FIXAZ: fix };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|INTEGRATIONS_DIR|HARNESS_HEALTH|AZ_FAIL|AZ_GARBAGE)$|^NODE_TEST_CONTEXT$/.test(k)) delete env[k];
  return { tree, home, fix, env };
}

/** Una política de aprobación mínima como la devuelve `az repos policy list`. */
function politica(o = {}, s = {}) {
  return { isEnabled: true, isBlocking: true, isDeleted: false, type: { id: TIPO, displayName: 'Minimum number of reviewers' },
    settings: { minimumApproverCount: 1, creatorVoteCounts: true, resetOnSourcePush: true, scope: [{ repositoryId: 'id-Backend', refName: 'refs/heads/main', matchKind: 'Exact' }], ...s }, ...o };
}
const sembrar = (m, lista, repoId = 'id-Backend') => fs.writeFileSync(path.join(m.fix, `politicas-${repoId}.json`), JSON.stringify(lista));

function correr(m, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...m.env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}
const check = (m, extra = [], extraEnv) => correr(m, ['check', '--repo', 'acme/Producto/Backend', ...extra], extraEnv);

test('Regla_QueSirve_Sale0YDiceCuantasPide', () => {
  const m = mundo();
  sembrar(m, [politica()]);
  const r = check(m);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /✓ acme\/Producto\/Backend · main: un pedido necesita una aprobación/);
  const j = JSON.parse(check(m, ['--json']).stdout);
  assert.deepStrictEqual([j.result, j.branch, j.approval.minimum, j.faults], ['sirve', 'main', 1, []]);
  // la pregunta va con la organización, el proyecto y el id del repo, nunca sin ellos
  const llamadas = fs.readFileSync(path.join(m.fix, 'llamadas.log'), 'utf8');
  assert.match(llamadas, /^repo-ver\t.*"--repository","Backend"/m);
  assert.match(llamadas, /^politicas\t.*"--repository-id","id-Backend","--branch","refs\/heads\/main"/m);
});

test('Regla_QueFalta_Sale1YLoDiceEnLlano', () => {
  const m = mundo();
  sembrar(m, []);
  const r = check(m);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no hay regla de aprobación: un pedido entra sin que nadie lo apruebe/);
  assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).result, 'falta');
  // una de compilación, o una de aprobación borrada o de otra rama, no es la regla
  const compilacion = politica({ type: { id: 'otro', displayName: 'Build' } });
  compilacion.settings = { buildDefinitionId: 7, scope: compilacion.settings.scope };
  sembrar(m, [compilacion, politica({ isDeleted: true }),
    politica({}, { scope: [{ repositoryId: 'id-Backend', refName: 'refs/heads/dev', matchKind: 'Exact' }] }),
    politica({}, { scope: [{ repositoryId: 'id-OtroRepo', refName: 'refs/heads/main', matchKind: 'Exact' }] })]);
  assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).result, 'falta');
});

test('Regla_QueNoSirve_Sale1ConCadaFalta', () => {
  const casos = [
    [politica({ isBlocking: false }), /no frena el pedido \(es opcional\)/],
    [politica({ isEnabled: false }), /está apagada/],
    [politica({}, { minimumApproverCount: 0 }), /pide 0 aprobaciones: tiene que pedir al menos una/],
    [politica({}, { creatorVoteCounts: false }), /no cuenta el voto de quien abrió el pedido/],
    [politica({}, { resetOnSourcePush: false }), /sigue valiendo después de un empuje nuevo/],
  ];
  for (const [p, re] of casos) {
    const m = mundo();
    sembrar(m, [p]);
    const r = check(m);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, re);
    assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).result, 'no_sirve');
  }
});

test('Regla_VariasYDeTodoElProyecto_ValeLaMejor', () => {
  const m = mundo();
  // una que no bloquea y otra, para todo el proyecto (sin repositoryId), que sirve: vale la que sirve
  sembrar(m, [politica({ isBlocking: false }), politica({}, { scope: [{ repositoryId: null, refName: 'refs/heads/main', matchKind: 'Exact' }] })]);
  assert.strictEqual(check(m).code, 0);
  // la rama principal por su nombre (`defaultBranch`), sin --branch
  sembrar(m, [politica({}, { scope: [{ repositoryId: 'id-Backend', matchKind: 'DefaultBranch' }] })]);
  assert.strictEqual(check(m).code, 0);
});

// Azure DevOps exige todas las que frenan: el voto de quien abre tiene que contar en todas, y el mínimo es el mayor
test('Pase_VariasQueFrenan_SeExigenJuntas', () => {
  const m = mundo();
  for (const orden of [[politica(), politica({}, { creatorVoteCounts: false })], [politica({}, { creatorVoteCounts: false }), politica()]]) {
    sembrar(m, orden);
    const r = check(m, ['--json']);
    assert.strictEqual(r.code, 1, r.out);
    assert.strictEqual(JSON.parse(r.stdout).result, 'no_sirve');
  }
  for (const orden of [[politica(), politica({}, { minimumApproverCount: 2 })], [politica({}, { minimumApproverCount: 2 }), politica()]]) {
    sembrar(m, orden);
    assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).approval.minimum, 2);
  }
});

// la de revisores obligatorios también trae un mínimo, y puede valer sólo para algunas rutas: no es la regla de la rama
test('Pase_RevisoresObligatorios_NoSonLaRegla', () => {
  const m = mundo();
  sembrar(m, [politica({ type: { id: 'otro', displayName: 'Required reviewers' } }, { requiredReviewerIds: ['x'], filenamePatterns: ['/docs/*'] })]);
  assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).result, 'falta');
  sembrar(m, [politica({ type: {} }, { requiredReviewerIds: ['x'] })]);
  assert.strictEqual(JSON.parse(check(m, ['--json']).stdout).result, 'falta');
});

test('Pase_RamaComoRefCompletaOConOtrasLetras_SeMide', () => {
  const m = mundo();
  sembrar(m, [politica()]);
  assert.strictEqual(check(m, ['--branch', 'refs/heads/main']).code, 0);
  sembrar(m, [politica({}, { scope: [{ repositoryId: 'id-Backend', refName: 'refs/heads/développement+v2', matchKind: 'Exact' }] })]);
  const j = JSON.parse(check(m, ['--json', '--branch', 'développement+v2']).stdout);
  assert.deepStrictEqual([j.result, j.branch], ['sirve', 'développement+v2']);
});

test('Pase_RepoEnDosProyectos_NoSeEligeACiegas', () => {
  const m = mundo([AZ, { ...AZ, project: 'Otro' }]);
  sembrar(m, [politica()]);
  const r = correr(m, ['check', '--repo', 'acme/Backend']);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /varios proyectos.*org\/proyecto\/repo/);
});

test('Regla_RamaPrincipalDelRepo_SinBranchNoEsMainACiegas', () => {
  const m = mundo();
  fs.writeFileSync(path.join(m.fix, 'repo-Backend.json'), JSON.stringify({ id: 'id-Backend', name: 'Backend', defaultBranch: 'refs/heads/master' }));
  sembrar(m, [politica({}, { scope: [{ repositoryId: 'id-Backend', refName: 'refs/heads/master', matchKind: 'Exact' }] })]);
  const j = JSON.parse(check(m, ['--json']).stdout);
  assert.deepStrictEqual([j.result, j.branch], ['sirve', 'master']);
  // con --branch, la que se nombra
  assert.strictEqual(JSON.parse(check(m, ['--json', '--branch', 'main']).stdout).result, 'falta');
  // una rama que parece una opción no llega a la plataforma
  const r = check(m, ['--branch', '-x']);
  assert.strictEqual(r.code, 2, r.out);
});

test('Regla_AzQueFalla_NoMedidoSale2', () => {
  const m = mundo();
  sembrar(m, [politica()]);
  for (const sabotaje of [{ TYCON_AZ_FAIL: 'politicas' }, { TYCON_AZ_FAIL: 'repo-ver' }, { TYCON_AZ_GARBAGE: 'politicas' }]) {
    const r = check(m, [], sabotaje);
    assert.strictEqual(r.code, 2, `${JSON.stringify(sabotaje)}: ${r.out}`);
    assert.match(r.out, /\? acme\/Producto\/Backend: no medido — /);
  }
  // una plataforma que no declara la lectura tampoco es verde
  const g = correr(m, ['check', '--repo', 'acme/portal', '--platform', 'github']);
  assert.strictEqual(g.code, 2, g.out);
  assert.match(g.out, /no medido/);
});

test('Regla_IdentidadDeTeamRepos_CompletaPlataformaYProyecto', () => {
  const m = mundo();
  sembrar(m, [politica()]);
  // `org/repo` alcanza: el proyecto y la plataforma salen de team-repos.json
  const r = correr(m, ['check', '--repo', 'acme/Backend', '--json']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(r.stdout).repo, 'acme/Producto/Backend');
  // mal usado: sale 2 con el uso
  for (const args of [['check'], ['check', '--repo', 'solo'], ['otra'], ['check', '--repo', 'a/b', '--unknown']]) {
    const u = correr(m, args);
    assert.strictEqual(u.code, 2, `${args.join(' ')}: ${u.out}`);
    assert.match(u.out, /uso: branch-approval\.js/);
  }
});

test('Declarados_UnRenglonPorRepo_ConElPeorCodigo', () => {
  const FRONT = { ...AZ, repo: 'Frontend' };
  const m = mundo([AZ, FRONT]);
  sembrar(m, [politica()]);
  sembrar(m, [], 'id-Frontend');
  const r = correr(m, ['check-declared']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /✓ acme\/Producto\/Backend/);
  assert.match(r.out, /✗ acme\/Producto\/Frontend/);
  // uno que no se pudo medir gana: 2
  const n = correr(m, ['check-declared', '--json'], { TYCON_AZ_FAIL: 'politicas:id-Frontend' });
  assert.strictEqual(n.code, 2, n.out);
  assert.deepStrictEqual(JSON.parse(n.stdout).repos.map((x) => x.result), ['sirve', 'no_medido']);
  // sin repos declarados no hay verde
  const vacio = mundo([]);
  const v = correr(vacio, ['check-declared']);
  assert.strictEqual(v.code, 2, v.out);
});

/** El ítem del doctor, con el árbol de la prueba: las líneas que agrega y su clave de --json. */
function doctor(m, fetch) {
  const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
  const items = []; const extra = {};
  H.doctorBranchApprovalItems({ env: m.env, opts: { fetch } }, ROOT, (level, text) => items.push({ level, text }), extra);
  return { items, extra };
}

test('Doctor_SinFetch_UnaLineaQueDiceComoMirarlo', () => {
  const m = mundo();
  sembrar(m, []);
  const d = doctor(m, false);
  assert.deepStrictEqual(d.items.map((i) => i.level), ['ok']);
  assert.match(d.items[0].text, /no se miró .*harness\.js doctor --fetch/);
  assert.strictEqual(d.extra.branch_approval.measured, false);
  // nada salió a preguntar
  assert.ok(!fs.existsSync(path.join(m.fix, 'llamadas.log')), 'sin --fetch no se llama a la plataforma');
});

test('Doctor_ConFetch_AvisaElRepoSinReglaYElNoMedido_NuncaRojo', () => {
  const FRONT = { ...AZ, repo: 'Frontend' };
  const OTRO = { ...AZ, repo: 'Otro' };
  const m = mundo([AZ, FRONT, OTRO]);
  sembrar(m, [politica()]);
  sembrar(m, [], 'id-Frontend');
  const d = doctor({ ...m, env: { ...m.env, TYCON_AZ_FAIL: 'politicas:id-Otro' } }, true);
  assert.ok(!d.items.some((i) => i.level === 'fail'), 'nunca en rojo');
  assert.ok(d.items.some((i) => i.level === 'warn' && /acme\/Producto\/Frontend · main: no hay regla de aprobación/.test(i.text)), JSON.stringify(d.items));
  assert.ok(d.items.some((i) => i.level === 'warn' && /acme\/Producto\/Otro: no medido/.test(i.text)), JSON.stringify(d.items));
  assert.ok(d.items.some((i) => /1 de 3 repo\(s\) declarado\(s\) la tienen/.test(i.text)), JSON.stringify(d.items));
  assert.deepStrictEqual(d.extra.branch_approval.repos.map((x) => x.result), ['sirve', 'falta', 'no_medido']);
  // todos con la regla: un dato
  const ok = mundo([AZ]);
  sembrar(ok, [politica()]);
  const d2 = doctor(ok, true);
  assert.deepStrictEqual(d2.items.map((i) => i.level), ['ok']);
  // bajo la comprobación de salud no corre
  const d3 = doctor({ ...ok, env: { ...ok.env, TYCON_HARNESS_HEALTH: '1' } }, true);
  assert.deepStrictEqual([d3.items.length, d3.extra.branch_approval], [0, null]);
});
