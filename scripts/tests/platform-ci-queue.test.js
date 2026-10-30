'use strict';
// platform-ci-queue.test.js — leer la CI y la cola por la capa de plataforma (Azure DevOps y GitHub), los guiones que
// sólo existen en Azure DevOps cuando la organización es de GitHub, y el pipeline de validación que sale de la
// configuración. Todo contra los dobles de az, de gh y de curl: ninguna prueba sale a la red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
const C = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const CI = path.join(ROOT, 'scripts', 'ci');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const TEAM = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } };

/** Una carpeta de integraciones con los dos conectores de verdad (copias). */
function integraciones() {
  const d = tmp('plataformas-');
  for (const n of ['azure-devops', 'github']) fs.cpSync(path.join(ROOT, 'integrations', n), path.join(d, n), { recursive: true });
  return d;
}
/** Un árbol con su perfil vacío, una casa vacía y el entorno que los apunta. `team` null: sin team-repos.json. */
function mundo(team = TEAM) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  if (team) fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(team));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_INTEGRATIONS_DIR: integraciones(), TYCON_TREE: tree };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|ALLOW_UNSUPPORTED|VALIDATION_.*)$|^ADO_ORG$|^AZURE_DEVOPS_EXT_PAT$|^GH_(TOKEN|REPO|HOST)$|^FAKE_GH_/.test(k)) delete env[k];
  env.TYCON_HOME = path.join(home, '.tycon');
  return { tree, home, env };
}
/** El az de mentira, copiado y ejecutable; `fix` es su carpeta de respuestas. */
function conAz(m) {
  const fix = tmp('fixaz-');
  const az = path.join(tmp('az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  Object.assign(m.env, { TYCON_ADO_CMD: az, FIXAZ: fix });
  const poner = (nombre, valor) => fs.writeFileSync(path.join(fix, nombre), JSON.stringify(valor));
  const llamadas = () => { try { return fs.readFileSync(path.join(fix, 'llamadas.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]); } catch (_) { return []; } };
  return { fix, poner, llamadas };
}
/** El gh de mentira con su estado. */
function conGh(m, estado) {
  const f = path.join(tmp('gh-'), 'estado.json');
  fs.writeFileSync(f, JSON.stringify({ user: 'arnes-bot', now: '2026-10-30T10:00:00Z', ...estado }));
  Object.assign(m.env, { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: f });
}

const AZ = { platform: 'azure', org: 'acme', project: 'Producto', repo: 'Backend' };
const GH = { platform: 'github', org: 'acme', repo: 'widgets' };
const ci = (m, args, repo) => P().run('ci.read', args, { env: m.env, repo });
const cola = (m, args = {}) => P().run('queue.read', args, { env: m.env });
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const corrida = (id, o = {}) => ({ id, status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', sourceVersion: SHA, definition: { id: 7, name: 'Backend CI' }, repository: { name: 'Backend' }, queueTime: `2026-10-30T0${id % 10}:00:00Z`, ...o });
const etapa = (name, result, state = 'completed') => ({ type: 'Stage', name, identifier: name, state, result: state === 'completed' ? result : null });

// ── la CI ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Ci_Read_ReturnsStagesNotJustBuild @story-8.85 @ac-17', async () => {
  // Azure DevOps: la más nueva del pipeline de ESTE repo; la vieja del mismo pipeline y la de otro repo no cuentan
  const m = mundo();
  const az = conAz(m);
  az.poner('runs-Producto.json', [
    corrida(40, { result: 'failed', sourceVersion: 'dead000beef000dead000beef000dead000beef0' }),
    corrida(50),
    corrida(60, { result: 'failed', definition: { id: 9, name: 'Otro CI' }, repository: { name: 'Otro' } }),
  ]);
  az.poner('timeline-50.json', { records: [etapa('Build', 'succeeded'), { type: 'Job', name: 'compilar', state: 'completed', result: 'succeeded' }, etapa('Production', 'skipped')] });
  const r = await ci(m, { branch: 'main' }, AZ);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.deepStrictEqual(r, { ok: true, value: { state: 'succeeded', stages: [
    { pipeline: 'Backend CI', name: 'Build', result: 'succeeded' },
    { pipeline: 'Backend CI', name: 'Production', result: 'skipped' },
  ] } });
  // «succeeded» de la corrida no es «desplegado»: el valor sólo trae las etapas
  assert.doesNotMatch(JSON.stringify(r.value), /desplegad|deployed/i);
  // con un commit: sólo las corridas de ese commit (el completo o su comienzo); sin ninguna en una ventana incompleta, none
  assert.deepStrictEqual((await ci(m, { commit: SHA }, AZ)).value.state, 'succeeded');
  assert.deepStrictEqual((await ci(m, { commit: 'ABC1234' }, AZ)).value.state, 'succeeded', 'abreviado y en mayúsculas');
  assert.deepStrictEqual(await ci(m, { commit: 'fff9999' }, AZ), { ok: true, value: { state: 'none', stages: [] } });
  // un commit o una rama sin su forma no llegan a az
  for (const malo of [{ commit: 'otro' }, { commit: 'abc' }, { branch: '--org=x' }]) {
    const r2 = await ci(m, malo, AZ);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify([malo, r2]));
  }
  // la corrida más nueva terminó mal: failed, con sus etapas
  az.poner('runs-Producto.json', [corrida(52, { result: 'failed' })]);
  az.poner('timeline-52.json', { records: [etapa('Build', 'failed')] });
  assert.deepStrictEqual(await ci(m, { branch: 'main' }, AZ), { ok: true, value: { state: 'failed', stages: [{ pipeline: 'Backend CI', name: 'Build', result: 'failed' }] } });
  // una etapa sin terminar es running, aunque las demás estén bien
  az.poner('runs-Producto.json', [corrida(51, { status: 'inProgress', result: null })]);
  az.poner('timeline-51.json', { records: [etapa('Build', 'succeeded'), etapa('Production', null, 'inProgress')] });
  const corriendo = await ci(m, { branch: 'main' }, AZ);
  assert.strictEqual(corriendo.value.state, 'running');
  assert.deepStrictEqual(corriendo.value.stages[1], { pipeline: 'Backend CI', name: 'Production', result: null });
  // la ventana llena (100) sin la corrida del repo: pudo quedar más atrás, no es none
  az.poner('runs-Producto.json', Array.from({ length: 100 }, (_, i) => corrida(100 + i, { repository: { name: 'Otro' } })));
  const llena = await ci(m, { branch: 'main' }, AZ);
  assert.deepStrictEqual([llena.ok, llena.reason], [false, 'no_medido'], JSON.stringify(llena));
  // llena CON corridas del repo: la de otro pipeline del repo pudo quedar afuera, tampoco es verde
  az.poner('runs-Producto.json', Array.from({ length: 100 }, (_, i) => corrida(200 + i)));
  const llenaDelRepo = await ci(m, { branch: 'main' }, AZ);
  assert.deepStrictEqual([llenaDelRepo.ok, llenaDelRepo.reason], [false, 'no_medido'], JSON.stringify(llenaDelRepo));
  // sólo con el commit, la ventana llena dice cómo achicarla: con la rama
  const llenaPorCommit = await ci(m, { commit: SHA }, AZ);
  assert.deepStrictEqual([llenaPorCommit.ok, llenaPorCommit.reason], [false, 'no_medido'], JSON.stringify(llenaPorCommit));
  assert.match(llenaPorCommit.detail, /rama/, llenaPorCommit.detail);
  // un repo sin organización válida, sin proyecto o con un proyecto que empieza con «-» no llega a az
  for (const malo of [{ ...AZ, org: 'https://dev.azure.com/acme' }, { ...AZ, project: '' }, { ...AZ, project: '-x' }]) {
    const r2 = await ci(m, { branch: 'main' }, malo);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify([malo, r2]));
  }

  // GitHub: cada check-run y cada estado de la punta es una etapa
  const g = mundo();
  conGh(g, {
    checks: { s1: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'deploy', status: 'completed', conclusion: 'skipped' }] },
    statuses: { s1: [{ context: 'ext/ci', state: 'success' }, { context: 'ext/ci', state: 'failure' }] },
  });
  const rg = await ci(g, { commit: 's1' }, GH);
  assert.deepStrictEqual(rg, { ok: true, value: { state: 'succeeded', stages: [
    { pipeline: null, name: 'build', result: 'success' },
    { pipeline: null, name: 'deploy', result: 'skipped' },
    { pipeline: null, name: 'ext/ci', result: 'success' },
  ] } }, JSON.stringify(rg));
  assert.doesNotMatch(JSON.stringify(rg.value), /desplegad|deployed/i);
  assert.deepStrictEqual(await ci(g, { commit: 's2' }, GH), { ok: true, value: { state: 'none', stages: [] } });
  conGh(g, { checks: { s3: [{ name: 'build', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }] } });
  assert.strictEqual((await ci(g, { commit: 's3' }, GH)).value.state, 'running');
  conGh(g, { checks: { s4: [{ name: 'build', status: 'completed', conclusion: 'failure' }] } });
  assert.strictEqual((await ci(g, { commit: 's4' }, GH)).value.state, 'failed');
  // con fechas, el estado más nuevo de cada contexto vale aunque GitHub los dé en otro orden
  conGh(g, { statuses: { s5: [
    { id: 1, context: 'ext/ci', state: 'success', updated_at: '2026-10-30T08:00:00Z' },
    { id: 2, context: 'ext/ci', state: 'failure', updated_at: '2026-10-30T09:00:00Z' },
  ] } });
  assert.deepStrictEqual(await ci(g, { commit: 's5' }, GH), { ok: true, value: { state: 'failed', stages: [{ pipeline: null, name: 'ext/ci', result: 'failure' }] } });
  // la rama también es una punta; la que no tiene forma de rama, o falta, no llega a gh
  conGh(g, { checks: { main: [{ name: 'build', status: 'completed', conclusion: 'success' }] } });
  assert.strictEqual((await ci(g, { branch: 'main' }, GH)).value.state, 'succeeded');
  for (const malo of [{}, { branch: '-x' }, { branch: 'a..b' }]) {
    const r2 = await ci(g, malo, GH);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify([malo, r2]));
  }
  // un repo sin forma de dueño/nombre no llega a gh
  for (const malo of [{ ...GH, repo: '..' }, { ...GH, org: '-x' }, { platform: 'github', org: 'acme' }]) {
    const r2 = await ci(g, { branch: 'main' }, malo);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify([malo, r2]));
  }
});

test('Ci_Read_ReadFailure_NoMedido @story-8.85 @ac-17', async () => {
  const m = mundo();
  conAz(m);
  m.env.TYCON_AZ_FAIL = 'builds';
  const r = await ci(m, { branch: 'main' }, AZ);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
  assert.ok(r.detail, 'con el motivo');
  // la línea de tiempo que no se lee tampoco es «sin etapas»
  const t = mundo();
  const az = conAz(t);
  az.poner('runs-Producto.json', [corrida(50)]);
  t.env.TYCON_AZ_FAIL = 'timeline';
  const rt = await ci(t, { branch: 'main' }, AZ);
  assert.deepStrictEqual([rt.ok, rt.reason], [false, 'no_medido'], JSON.stringify(rt));
  // una línea de tiempo sin sus registros, o una lista que no es lista, tampoco
  delete t.env.TYCON_AZ_FAIL;
  az.poner('timeline-50.json', { sinRegistros: true });
  const sinReg = await ci(t, { branch: 'main' }, AZ);
  assert.deepStrictEqual([sinReg.ok, sinReg.reason], [false, 'no_medido'], JSON.stringify(sinReg));
  az.poner('runs-Producto.json', { value: 'no es una lista' });
  const noLista = await ci(t, { branch: 'main' }, AZ);
  assert.deepStrictEqual([noLista.ok, noLista.reason], [false, 'no_medido'], JSON.stringify(noLista));
  // la línea de tiempo vacía de una corrida terminada no es «sin etapas»: no se leyó
  az.poner('runs-Producto.json', [corrida(50)]);
  fs.writeFileSync(path.join(az.fix, 'timeline-50.json'), '');
  const vacia = await ci(t, { branch: 'main' }, AZ);
  assert.deepStrictEqual([vacia.ok, vacia.reason], [false, 'no_medido'], JSON.stringify(vacia));
  // la de una corrida que todavía no arrancó sí: corre, sin etapas
  az.poner('runs-Producto.json', [corrida(50, { status: 'notStarted', result: null })]);
  assert.deepStrictEqual(await ci(t, { branch: 'main' }, AZ), { ok: true, value: { state: 'running', stages: [] } });

  const g = mundo();
  conGh(g, { fail: { 'GET repos/acme/widgets/commits': { status: 500, message: 'Server Error' } } });
  const rg = await ci(g, { commit: 's1' }, GH);
  assert.deepStrictEqual([rg.ok, rg.reason], [false, 'no_medido'], JSON.stringify(rg));
  assert.match(rg.detail, /500|Server Error/);
  // los check-runs se leen y los estados no: tampoco es verde
  conGh(g, { checks: { s1: [{ name: 'build', status: 'completed', conclusion: 'success' }] }, fail: { 'GET repos/acme/widgets/commits/s1/statuses': { status: 502, message: 'Bad Gateway' } } });
  const sinEstados = await ci(g, { commit: 's1' }, GH);
  assert.deepStrictEqual([sinEstados.ok, sinEstados.reason], [false, 'no_medido'], JSON.stringify(sinEstados));
  // la sesión que GitHub no acepta y la red caída se dicen como tales, en la CI y en la cola
  g.env.TYCON_PLATFORM = 'github';
  for (const [falla, reason] of [[{ status: 401, message: 'Bad credentials' }, 'sin_credencial'], [{ status: 500, message: 'error connecting to api.github.com' }, 'red']]) {
    conGh(g, { fail: { 'GET repos/acme/widgets/commits': falla, 'GET repos/acme/arnes/actions/runs': falla } });
    const enCi = await ci(g, { commit: 's1' }, GH);
    assert.deepStrictEqual([enCi.ok, enCi.reason], [false, reason], JSON.stringify(enCi));
    const enCola = await cola(g, { repos: ['acme/arnes'] });
    assert.deepStrictEqual([enCola.ok, enCola.reason], [false, reason], JSON.stringify(enCola));
  }
});

// ── la cola ───────────────────────────────────────────────────────────────────────────────────────────────────────
function colaAzure() {
  const m = mundo();
  Object.assign(m.env, { TYCON_PLATFORM: 'azure-devops', TYCON_ADO_ORG: 'acme' });
  const az = conAz(m);
  const enlace = (n) => ({ id: n, _links: { self: { href: `https://dev.azure.com/acme/Producto/_apis/build/Builds/${n}` } } });
  az.poner('pools.json', { count: 2, value: [{ id: 3, name: 'Otro' }, { id: 9, name: 'Azure Pipelines' }] });
  az.poner('jobrequests-9.json', { count: 3, value: [
    { requestId: 1, queueTime: '2026-10-30T09:00:00Z', assignTime: '2026-10-30T09:01:00Z', owner: enlace(50) },
    { requestId: 2, queueTime: '2026-10-30T09:05:00Z', owner: enlace(51) },
    { requestId: 3, queueTime: '2026-10-30T08:00:00Z', assignTime: '2026-10-30T08:01:00Z', finishTime: '2026-10-30T08:30:00Z', owner: enlace(49) },
  ] });
  az.poner('corrida-50.json', { id: 50, requestedFor: { uniqueName: 'Ana@Example.com' }, repository: { name: 'Backend' } });
  az.poner('corrida-51.json', { id: 51, requestedFor: { uniqueName: 'beto@example.com' }, repository: { name: 'Portal' } });
  return { m, az };
}

test('Queue_Read_Azure_UnfinishedJobRequests @story-8.85 @ac-18', async () => {
  const { m, az } = colaAzure();
  const r = await cola(m);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  assert.deepStrictEqual(r, { ok: true, value: [
    { id: 1, requestedBy: 'ana@example.com', project: 'Producto', repo: 'Backend', run: 50, since: '2026-10-30T09:00:00Z', state: 'running' },
    { id: 2, requestedBy: 'beto@example.com', project: 'Producto', repo: 'Portal', run: 51, since: '2026-10-30T09:05:00Z', state: 'queued' },
  ] }, JSON.stringify(r));
  // el que terminó no se pregunta
  assert.ok(!az.llamadas().includes('desconocido'), az.llamadas().join(','));
  // otro grupo, por su nombre
  az.poner('jobrequests-3.json', { count: 0, value: [] });
  assert.deepStrictEqual(await cola(m, { pool: 'Otro' }), { ok: true, value: [] });
  // un grupo que no existe no es una cola vacía
  const sin = await cola(m, { pool: 'No existe' });
  assert.deepStrictEqual([sin.ok, sin.reason], [false, 'no_medido'], JSON.stringify(sin));
  // una corrida que no se lee hace no_medido la cola entera
  fs.rmSync(path.join(az.fix, 'corrida-51.json'));
  const rota = await cola(m);
  assert.deepStrictEqual([rota.ok, rota.reason], [false, 'no_medido'], JSON.stringify(rota));
  // sin la organización de la máquina: sin_credencial con cómo ponerla
  delete m.env.TYCON_ADO_ORG;
  const sinOrg = await cola(m);
  assert.deepStrictEqual([sinOrg.ok, sinOrg.reason], [false, 'sin_credencial'], JSON.stringify(sinOrg));

  // cada lectura que falla, o que no trae lo suyo, hace no_medido la cola entera
  const noMedida = async (preparar, que) => {
    const x = colaAzure();
    preparar(x);
    const r2 = await cola(x.m);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'no_medido'], `${que}: ${JSON.stringify(r2)}`);
  };
  await noMedida(({ m: y }) => { y.env.TYCON_AZ_FAIL = 'grupos-agentes'; }, 'los grupos no se leen');
  await noMedida(({ az: y }) => y.poner('pools.json', { count: 1 }), 'los grupos sin su lista');
  await noMedida(({ az: y }) => fs.rmSync(path.join(y.fix, 'jobrequests-9.json')), 'los pedidos no se leen');
  await noMedida(({ az: y }) => y.poner('jobrequests-9.json', { count: 0 }), 'los pedidos sin su lista');
  await noMedida(({ m: y }) => { y.env.TYCON_ADO_ORG = 'no es una org'; }, 'una organización sin forma');
  await noMedida(({ m: y }) => {
    const cfg = path.join(y.home, '.claude', 'tycon.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{ esto no es json');
  }, 'la configuración de la máquina que no se lee');
  // la organización como dirección de dev.azure.com, con o sin barra final, es la misma
  for (const org of ['https://dev.azure.com/acme', 'https://dev.azure.com/acme/']) {
    const x = colaAzure();
    x.m.env.TYCON_ADO_ORG = org;
    const r2 = await cola(x.m);
    assert.strictEqual(r2.ok, true, `${org}: ${JSON.stringify(r2)}`);
    assert.strictEqual(r2.value.length, 2, org);
  }
  // un pedido sin corrida reconocible no dice quién lo pidió: no es un pedido «sin dueño»
  await noMedida(({ az: y }) => y.poner('jobrequests-9.json', { value: [{ requestId: 7, queueTime: '2026-10-30T09:00:00Z', owner: { _links: { self: { href: 'https://vsrm.dev.azure.com/acme/Producto/_apis/Release/releases/3' } } } }] }), 'un release clásico');
  // un proyecto que empieza con «-» (o mal codificado) no llega a az como opción
  for (const proyecto of ['%2D-org', '%E0%A4%A']) {
    const x = colaAzure();
    x.az.poner('jobrequests-9.json', { value: [{ requestId: 8, queueTime: '2026-10-30T09:00:00Z', owner: { _links: { self: { href: `https://dev.azure.com/acme/${proyecto}/_apis/build/Builds/50` } } } }] });
    const r2 = await cola(x.m);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'no_medido'], `${proyecto}: ${JSON.stringify(r2)}`);
    assert.ok(!x.az.llamadas().includes('corrida'), `${proyecto}: no preguntó la corrida`);
  }
});

test('Queue_Read_Github_QueuedRuns @story-8.85 @ac-18', async () => {
  const m = mundo();
  conGh(m, { runs: {
    'acme/arnes': [
      { id: 1, status: 'queued', created_at: '2026-10-30T09:00:00Z', triggering_actor: { login: 'Ana' }, actor: { login: 'otra' } },
      { id: 2, status: 'in_progress', created_at: '2026-10-30T09:05:00Z', actor: { login: 'Beto' } },
      { id: 3, status: 'completed', created_at: '2026-10-30T08:00:00Z', actor: { login: 'Ana' } },
    ],
    'acme/operaciones': [{ id: 4, status: 'queued', created_at: '2026-10-30T09:10:00Z', actor: { login: 'Cata' } }],
  } });
  const r = await cola(m);
  assert.strictEqual(C().shapeProblem(r), null, JSON.stringify(r));
  const ordenados = [...r.value].sort((a, b) => a.id - b.id);
  assert.deepStrictEqual(ordenados, [
    { id: 1, requestedBy: 'ana', repo: 'acme/arnes', since: '2026-10-30T09:00:00Z', state: 'queued' },
    { id: 2, requestedBy: 'beto', repo: 'acme/arnes', since: '2026-10-30T09:05:00Z', state: 'running' },
    { id: 4, requestedBy: 'cata', repo: 'acme/operaciones', since: '2026-10-30T09:10:00Z', state: 'queued' },
  ], JSON.stringify(r));
  // los repos que pide quien llama
  assert.deepStrictEqual((await cola(m, { repos: ['acme/operaciones'] })).value.map((x) => x.id), [4]);
  // un repo que no se lee hace no_medido la cola entera
  conGh(m, { runs: {}, fail: { 'GET repos/acme/perfil/actions/runs': { status: 500, message: 'Server Error' } } });
  const rota = await cola(m);
  assert.deepStrictEqual([rota.ok, rota.reason], [false, 'no_medido'], JSON.stringify(rota));
  // lo que falla en «en curso», después de leer «en espera», también
  conGh(m, { runs: {}, fail: { 'GET repos/acme/arnes/actions/runs?status=in_progress': { status: 500, message: 'Server Error' } } });
  const aMedias = await cola(m);
  assert.deepStrictEqual([aMedias.ok, aMedias.reason], [false, 'no_medido'], JSON.stringify(aMedias));
  // ningún repo de GitHub declarado no es una cola libre
  const enAzure = (repo) => ({ platform: 'azure', org: 'acme', project: 'Producto', repo });
  const azul = mundo({ version: 1, public: enAzure('Arnes'), profile: enAzure('Perfil'), operations: enAzure('Ops') });
  azul.env.TYCON_PLATFORM = 'github';
  conGh(azul, { runs: {} });
  const sinRepos = await cola(azul);
  assert.deepStrictEqual([sinRepos.ok, sinRepos.reason], [false, 'no_medido'], JSON.stringify(sinRepos));
  assert.match(sinRepos.detail, /ningún repo de GitHub/);
  // sin team-repos.json legible, tampoco
  const sinArchivo = mundo(null);
  sinArchivo.env.TYCON_PLATFORM = 'github';
  conGh(sinArchivo, { runs: {} });
  const ilegible = await cola(sinArchivo);
  assert.deepStrictEqual([ilegible.ok, ilegible.reason], [false, 'no_medido'], JSON.stringify(ilegible));
  // un repo de GitHub de team-repos.json sin forma de dueño/nombre no se pregunta: la cola no se midió
  const torcido = mundo({ ...TEAM, operations: { platform: 'github', org: 'acme', repo: '..' } });
  conGh(torcido, { runs: {} });
  const sinForma = await cola(torcido);
  assert.deepStrictEqual([sinForma.ok, sinForma.reason], [false, 'no_medido'], JSON.stringify(sinForma));
  assert.match(sinForma.detail, /acme\/\.\./);
  // los repos de GitHub de las listas de team-repos.json (copias del arnés, suites del merge) también se leen
  const conListas = mundo({ ...TEAM,
    harness_copies: [{ platform: 'github', org: 'acme', repo: 'copia' }],
    merge_suites: { repos: [{ repo: { platform: 'github', org: 'acme', repo: 'producto' }, full_tests_pipeline: 'ci' }] } });
  conGh(conListas, { runs: {
    'acme/producto': [{ id: 9, status: 'queued', created_at: '2026-10-30T09:20:00Z', actor: { login: 'Ana' } }],
    'acme/copia': [{ id: 8, status: 'in_progress', created_at: '2026-10-30T09:25:00Z', actor: { login: 'Beto' } }],
  } });
  const listas = await cola(conListas);
  assert.deepStrictEqual(listas.ok && listas.value.map((x) => `${x.repo}#${x.id}`).sort(), ['acme/copia#8', 'acme/producto#9'], JSON.stringify(listas));
  const copiaTorcida = mundo({ ...TEAM, harness_copies: [{ platform: 'github', org: 'acme', repo: '..' }] });
  conGh(copiaTorcida, { runs: {} });
  const malCopia = await cola(copiaTorcida);
  assert.deepStrictEqual([malCopia.ok, malCopia.reason], [false, 'no_medido'], JSON.stringify(malCopia));
  // la corrida que arranca entre las dos lecturas (en espera en la primera, en curso en la segunda) sale una vez, en curso
  conGh(m, { runs: { 'acme/arnes': [
    { id: 7, status: 'queued', created_at: '2026-10-30T09:00:00Z', actor: { login: 'Ana' } },
    { id: 7, status: 'in_progress', created_at: '2026-10-30T09:00:00Z', actor: { login: 'Ana' } },
  ] } });
  const unaVez = await cola(m, { repos: ['acme/arnes'] });
  assert.deepStrictEqual(unaVez.value, [{ id: 7, requestedBy: 'ana', repo: 'acme/arnes', since: '2026-10-30T09:00:00Z', state: 'running' }], JSON.stringify(unaVez));
  // los repos que pide quien llama, con su forma
  for (const malos of ['acme/arnes', ['acme/..'], ['sin-barra'], [7]]) {
    const r2 = await cola(m, { repos: malos });
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify([malos, r2]));
  }
});

// ── los guiones con la organización en GitHub ─────────────────────────────────────────────────────────────────────
/** Corre un guion con el entorno del mundo; `curl` de mentira que anota y falla (sin red). */
function guion(m, cmd, args, extra = {}) {
  const bin = tmp('bin-');
  const log = path.join(bin, 'curl.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "$*" >> "${log}"\nexit 7\n`, { mode: 0o755 });
  const env = { ...m.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYCON_PROFILE: '0', ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const r = spawnSync(cmd, args, { cwd: tmp('cwd-'), env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, curl: fs.existsSync(log) };
}
const labelPrs = (m, extra) => guion(m, 'bash', [path.join(CI, 'label-prs.sh')], extra);
const validar = (m, args, extra) => guion(m, 'bash', [path.join(CI, 'validate-pipeline-in-ado.sh'), '--project', 'Producto', '--pipeline', '7', ...args], extra);
const permisos = (m, extra) => guion(m, process.execPath, [path.join(CI, 'grant-new-product-permissions.js'), '--project', 'Producto', '--verify'], extra);
function vigilante(m, extra) {
  const q = path.join(tmp('colas-'), 'watcher');
  fs.mkdirSync(q);
  return guion(m, 'bash', [path.join(CI, 'open-pr-per-finding.sh'), '--platform', 'github', '--queue', q, '--branch', 'vigilante', '--script', 'x.js', '--repo', 'acme/widgets'], extra);
}

test('AzureOnly_Ops_Github_NoSoportadoWithReason @story-8.85 @ac-19', async () => {
  const gh = mundo();  // team-repos.json: el repo de operaciones en GitHub, así que la cola es de GitHub
  const una = (o) => o.split('\n').filter((l) => /no_soportado:/.test(l));
  for (const [nombre, r, code] of [
    ['label-prs.sh', labelPrs(gh), 0],
    ['validate-pipeline-in-ado.sh', validar(gh, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira' }), 2],
    ['grant-new-product-permissions.js', permisos(gh, { TYCON_ADO_ORG: 'acme', AZURE_DEVOPS_EXT_PAT: 'de-mentira' }), 2],
  ]) {
    assert.strictEqual(r.code, code, `${nombre}: ${r.out}`);
    assert.strictEqual(una(r.out).length, 1, `${nombre} lo dice en una línea: ${r.out}`);
    assert.match(una(r.out)[0], /no_soportado: .*\S{8,}/, `${nombre} con la razón`);
    assert.strictEqual(r.curl, false, `${nombre} no consulta a Azure`);
  }
  // label-prs.sh es trazabilidad: el aviso va como warning de la corrida, nunca la frena
  assert.match(labelPrs(gh).out, /##vso\[task\.logissue type=warning\].*no_soportado/);
  // sin elección (ni perfil ni team-repos.json): siguen como hoy
  const nada = mundo(null);
  for (const r of [labelPrs(nada), validar(nada, []), permisos(nada)]) assert.doesNotMatch(r.out, /no_soportado/, r.out);
  // la organización en Azure DevOps: siguen, y validar consulta a Azure
  const azul = mundo();
  azul.env.TYCON_PLATFORM = 'azure-devops';
  const enAzul = validar(azul, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira' });
  assert.doesNotMatch(enAzul.out, /no_soportado|no_medido/, enAzul.out);
  assert.strictEqual(enAzul.curl, true, 'con Azure elegido, consultó');
  assert.strictEqual(require(path.join(CI, 'azure-only.js')).check('x', { env: azul.env }), null);
  // la elección rota no es Azure: no_medido, frena siempre (también con TYCON_ALLOW_UNSUPPORTED=1), sin consultar
  const rota = mundo();
  rota.env.TYCON_PLATFORM = 'no-existe';
  for (const extra of [{}, { TYCON_ALLOW_UNSUPPORTED: '1' }]) {
    const r = validar(rota, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira', ...extra });
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /no_medido: validate-pipeline-in-ado\.sh: no sé la plataforma/, r.out);
    assert.strictEqual(r.curl, false, 'no consulta a Azure');
    const p = permisos(rota, { TYCON_ADO_ORG: 'acme', AZURE_DEVOPS_EXT_PAT: 'de-mentira', ...extra });
    assert.strictEqual(p.code, 2, p.out);
    assert.match(p.out, /no_medido: grant-new-product-permissions\.js/, p.out);
  }
  // label-prs.sh, con la elección rota: aviso, nunca frena
  const lr = labelPrs(rota);
  assert.strictEqual(lr.code, 0, lr.out);
  assert.match(lr.out, /##vso\[task\.logissue type=warning\].*no_medido/, lr.out);
  assert.match(lr.out, /no etiqueté: el directorio no es un repo git/, `no_medido no corta: etiqueta como siempre: ${lr.out}`);
  // azure-only.js que no puede contestar (node que se cae): validar frena, label-prs avisa y sigue
  const binRoto = tmp('node-roto-');
  fs.writeFileSync(path.join(binRoto, 'node'), `#!/bin/sh\ncase "$1" in *azure-only.js) exit 1 ;; esac\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const caido = validar(azul, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira', PATH: `${binRoto}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(caido.code, 2, caido.out);
  assert.match(caido.out, /no_medido: .*no pude preguntar la plataforma .*salió 1/, caido.out);
  const lrCaido = labelPrs(azul, { PATH: `${binRoto}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(lrCaido.code, 0, lrCaido.out);
  assert.match(lrCaido.out, /no pude preguntar la plataforma/, lrCaido.out);
  // sin node en el PATH, la pregunta no se hizo: validar frena, label-prs avisa y sigue
  const sinNode = tmp('sin-node-');
  for (const dir of String(process.env.PATH).split(path.delimiter)) {
    let nombres = [];
    try { nombres = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of nombres) {
      if (n === 'node' || fs.existsSync(path.join(sinNode, n))) continue;
      try { fs.symlinkSync(path.join(dir, n), path.join(sinNode, n)); } catch (_) { /* un nombre repetido en otra carpeta */ }
    }
  }
  const vSinNode = validar(azul, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira', PATH: sinNode });
  assert.strictEqual(vSinNode.code, 2, vSinNode.out);
  assert.match(vSinNode.out, /no_medido: .*no pude preguntar la plataforma .*node/, vSinNode.out);
  const lrSinNode = labelPrs(azul, { PATH: sinNode });
  assert.strictEqual(lrSinNode.code, 0, lrSinNode.out);
  assert.match(lrSinNode.out, /##vso\[task\.logissue type=warning\].*no pude preguntar la plataforma .*node/, lrSinNode.out);
  // azure-only.js sin la capa al lado (el artefacto de la CI): sigue, sin decir nada
  const suelto = path.join(tmp('suelto-'), 'scripts', 'ci');
  fs.mkdirSync(suelto, { recursive: true });
  fs.copyFileSync(path.join(CI, 'azure-only.js'), path.join(suelto, 'azure-only.js'));
  const sinCapa = spawnSync(process.execPath, [path.join(suelto, 'azure-only.js'), 'x.sh'], { env: gh.env, encoding: 'utf8' });
  assert.deepStrictEqual([sinCapa.status, sinCapa.stdout], [0, ''], sinCapa.stderr);
  // la capa que lanza: no_medido en UNA línea, aunque el mensaje traiga saltos (una orden ##vso[ no queda sola)
  const capaRota = path.join(path.dirname(path.dirname(suelto)), 'scripts', 'lib', 'platform');
  fs.mkdirSync(capaRota, { recursive: true });
  fs.writeFileSync(path.join(capaRota, 'platform.js'), "module.exports = { choose: () => { throw new Error('x\\n##vso[task.complete result=Succeeded]'); } };\n");
  const lanza = spawnSync(process.execPath, [path.join(suelto, 'azure-only.js'), 'x.sh'], { env: gh.env, encoding: 'utf8' });
  assert.strictEqual(lanza.status, 2, lanza.stdout);
  assert.strictEqual(lanza.stdout.trimEnd().split('\n').length, 1, lanza.stdout);
  assert.match(lanza.stdout, /^no_medido: x\.sh: no pude preguntar la plataforma/, lanza.stdout);
  // la cola del vigilante en GitHub: no_soportado, sale 2
  const v = vigilante(gh);
  assert.strictEqual(v.code, 2, v.out);
  assert.match(v.out, /no_soportado: .*vigilante|no_soportado: .*dependencias/i);
  // en GitHub --repo tiene la forma del conector: un dueño que empieza con «-» o con un punto, o una mitad «.», no pasa
  for (const malo of ['-x/y', 'a.b/c', 'acme/.', 'acme/..']) {
    const q2 = path.join(tmp('colas-'), 'dependencies');
    fs.mkdirSync(q2);
    const r2 = guion(gh, 'bash', [path.join(CI, 'open-pr-per-finding.sh'), '--platform', 'github', '--queue', q2, '--branch', 'dep', '--script', 'x.js', '--repo', malo]);
    assert.strictEqual(r2.code, 2, `${malo}: ${r2.out}`);
    assert.match(r2.out, /--repo es <dueño>\/<repo>/, malo);
  }
  // pr-verdict.js lee archivos: no nombra ninguna plataforma
  const verdict = fs.readFileSync(path.join(CI, 'pr-verdict.js'), 'utf8');
  assert.doesNotMatch(verdict, /['"`](az|gh)['"`]|\b(az|gh) (repos|pr|api|pipelines|boards|devops)\b/);
  // queue-validation.js con un pedido abierto en GitHub: no encola, sale 4
  const lab = tmp('qv-');
  const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete genv[k];
  execFileSync('git', ['init', '-q', '-b', 'fix/mia', path.join(lab, 'clone')], { env: genv });
  execFileSync('git', ['-C', path.join(lab, 'clone'), 'remote', 'add', 'origin', 'https://github.com/acme/harness.git'], { env: genv });
  execFileSync('git', ['-C', path.join(lab, 'clone'), '-c', 'maintenance.auto=false', '-c', 'user.email=lab@example.com', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno'], { env: genv });
  fs.writeFileSync(path.join(lab, 'gh'), '#!/bin/sh\necho \'[{"number":9}]\'\n', { mode: 0o755 });
  const q = spawnSync(process.execPath, [path.join(CI, 'queue-validation.js'), '--org', 'acme', '--project', 'lab'], {
    cwd: path.join(lab, 'clone'), encoding: 'utf8',
    env: { ...gh.env, TYCON_GH: path.join(lab, 'gh'), AZURE_DEVOPS_EXT_PAT: 'de-mentira', TYCON_VALIDATION_PIPELINE: '184', TYCON_ADO_BASE_URL: 'http://127.0.0.1:9' },
  });
  assert.strictEqual(q.status, 4, `${q.stdout}${q.stderr}`);
});

// ── el pipeline de validación sale de la configuración ────────────────────────────────────────────────────────────
function azureVacio() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value: [] })); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
function encolar(m, url, extra = [], guionQv = path.join(CI, 'queue-validation.js')) {
  const dir = tmp('qv-az-');
  const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete genv[k];
  execFileSync('git', ['init', '-q', '-b', 'fix/mia', dir], { env: genv });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/lab/_git/harness'], { env: genv });
  execFileSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'user.email=lab@example.com', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno'], { env: genv });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [guionQv, '--dry-run', ...extra], {
      cwd: dir, env: { ...m.env, AZURE_DEVOPS_EXT_PAT: 'de-mentira', TYCON_ADO_BASE_URL: url, TYCON_VALIDATION_PIPELINE: '999' },
    });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const conSuites = (pipeline) => ({ ...TEAM, merge_suites: { repos: [{ repo: { platform: 'azure', org: 'acme', project: 'lab', repo: 'harness' }, full_tests_pipeline: pipeline }] } });

test('QueueValidation_PipelineIdFromConfig @story-8.85 @ac-19', async () => {
  const az = await azureVacio();
  try {
    // el del repo del clon en team-repos.json (la configuración de la máquina es la del público: no cuenta acá)
    const r = await encolar(mundo(conSuites(184)), az.url);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /encolaría: pipeline 184 sobre fix\/mia/);
    // --pipeline gana
    const o = await encolar(mundo(conSuites(184)), az.url, ['--pipeline', '222']);
    assert.match(o.out, /encolaría: pipeline 222 sobre fix\/mia/, o.out);
    // sin declarar: sale 2 con la línea que hay que declarar
    const sin = await encolar(mundo(), az.url);
    assert.strictEqual(sin.code, 2, sin.out);
    assert.match(sin.out, /full_tests_pipeline/);
    assert.match(sin.out, /acme\/lab\/harness|harness/);
    // un nombre no es una definición de Azure
    const nombre = await encolar(mundo(conSuites('Harness CI')), az.url);
    assert.strictEqual(nombre.code, 2, nombre.out);
    assert.match(nombre.out, /Harness CI/);
    // un número escrito como texto es el mismo número
    const texto = await encolar(mundo(conSuites(' 184 ')), az.url);
    assert.match(texto.out, /encolaría: pipeline 184 sobre fix\/mia/, texto.out);
    // un team-repos.json ilegible: sale 2, no encola nada
    const ilegible = mundo();
    fs.writeFileSync(path.join(ilegible.tree, 'team-repos.json'), '{ esto no es json');
    const rotoRepos = await encolar(ilegible, az.url);
    assert.strictEqual(rotoRepos.code, 2, rotoRepos.out);
    assert.doesNotMatch(rotoRepos.out, /encolaría/);
    // sin el lector de team-repos.json al lado: sale 2 diciéndolo, no encola nada; con --pipeline, sí
    const solo = path.join(tmp('qv-solo-'), 'scripts', 'ci');
    fs.mkdirSync(solo, { recursive: true });
    fs.copyFileSync(path.join(CI, 'queue-validation.js'), path.join(solo, 'queue-validation.js'));
    const sinLector = await encolar(mundo(conSuites(184)), az.url, [], path.join(solo, 'queue-validation.js'));
    assert.strictEqual(sinLector.code, 2, sinLector.out);
    assert.match(sinLector.out, /no pude cargar el lector de team-repos\.json/, sinLector.out);
    assert.doesNotMatch(sinLector.out, /encolaría/);
    const conPipeline = await encolar(mundo(conSuites(184)), az.url, ['--pipeline', '222'], path.join(solo, 'queue-validation.js'));
    assert.match(conPipeline.out, /encolaría: pipeline 222 sobre fix\/mia/, conPipeline.out);
  } finally { await az.close(); }
  assert.doesNotMatch(fs.readFileSync(path.join(CI, 'queue-validation.js'), 'utf8'), /\b170\b/);
});

// ── no_soportado nunca es verde ───────────────────────────────────────────────────────────────────────────────────
test('NoSoportado_NeverGreen_ForAGate @story-8.85 @ac-19', async () => {
  const c = C();
  // el veredicto: todo «no» es no_medido; verde sólo con una corrida succeeded
  for (const reason of c.REASONS) assert.strictEqual(c.verdictOf({ ok: false, reason, detail: 'x' }), 'no_medido', reason);
  assert.strictEqual(c.verdictOf({ ok: true, value: { state: 'succeeded', stages: [] } }), 'verde');
  assert.strictEqual(c.verdictOf({ ok: true, value: { state: 'failed', stages: [] } }), 'rojo');
  assert.strictEqual(c.verdictOf({ ok: true, value: { state: 'running', stages: [] } }), 'corriendo');
  assert.strictEqual(c.verdictOf({ ok: true, value: { state: 'none', stages: [] } }), 'ninguna');
  for (const raro of [null, undefined, {}, { ok: true }, { ok: true, value: { state: 'desplegado' } }, { ok: 'true', value: { state: 'succeeded' } }]) {
    assert.strictEqual(c.verdictOf(raro), 'no_medido', JSON.stringify(raro));
  }
  assert.strictEqual(c.verdictOf({ ok: true, value: [] }), 'medido', 'la cola leída');
  // un conector que no atiende la lectura: no_soportado, y el veredicto es no_medido
  const m = mundo();
  const dir = path.join(m.env.TYCON_INTEGRATIONS_DIR, 'otra');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'integration.json'), JSON.stringify({ __doc: 'de prueba', name: 'otra', label: 'Otra', kind: 'platform', connector: 'scripts/connector.js', operations: ['work-item.create'], capabilities: {}, rawCommands: ['otra pr create'] }));
  fs.writeFileSync(path.join(dir, 'scripts', 'connector.js'), "module.exports = { run: () => ({ ok: true, value: { state: 'succeeded', stages: [] } }) };\n");
  m.env.TYCON_PLATFORM = 'otra';
  const r = await cola(m);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_soportado'], JSON.stringify(r));
  assert.strictEqual(c.verdictOf(r), 'no_medido');
  // lo mismo con la CI de un repo de esa plataforma: el conector «contestaría succeeded», y no se le pregunta
  const rc = await ci(m, { branch: 'main' }, { org: 'acme', repo: 'widgets' });   // sin plataforma propia: la de fábrica
  assert.deepStrictEqual([rc.ok, rc.reason], [false, 'no_soportado'], JSON.stringify(rc));
  assert.strictEqual(c.verdictOf(rc), 'no_medido');

  // los guiones: sin variable salen 2 con no_soportado; con TYCON_ALLOW_UNSUPPORTED=1, 0 con la misma línea
  const gh = mundo();
  for (const [nombre, correr] of [
    ['validate-pipeline-in-ado.sh', (x) => validar(gh, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira', ...x })],
    ['grant-new-product-permissions.js', (x) => permisos(gh, { TYCON_ADO_ORG: 'acme', AZURE_DEVOPS_EXT_PAT: 'de-mentira', ...x })],
    ['open-pr-per-finding.sh (vigilante)', (x) => vigilante(gh, x)],
  ]) {
    const estricto = correr({});
    assert.strictEqual(estricto.code, 2, `${nombre} sin variable: ${estricto.out}`);
    assert.match(estricto.out, /no_soportado:/, nombre);
    const informativo = correr({ TYCON_ALLOW_UNSUPPORTED: '1' });
    assert.strictEqual(informativo.code, 0, `${nombre} con la variable: ${informativo.out}`);
    assert.match(informativo.out, /no_soportado:/, nombre);
    assert.strictEqual(estricto.curl || informativo.curl, false, `${nombre} no consulta a Azure`);
  }

  // «Azure apagado» (decisión de la máquina) no se confunde con «prendido y la lectura falla»
  const nada = mundo(null);
  const apagado = validar(nada, []);
  assert.strictEqual(apagado.code, 0, apagado.out);
  assert.match(apagado.out, /apagado/);
  const falla = validar(nada, ['--org', 'https://dev.azure.com/acme'], { AZURE_DEVOPS_EXT_PAT: 'de-mentira' });
  assert.strictEqual(falla.code, 2, falla.out);
  assert.strictEqual(falla.curl, true, 'con la organización, consultó');
  assert.doesNotMatch(falla.out, /apagado|✅|válido para/);
});
