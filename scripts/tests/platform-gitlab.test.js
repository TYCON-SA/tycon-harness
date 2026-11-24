'use strict';
// platform-gitlab.test.js — el conector de GitLab (integrations/gitlab/) y lo que el núcleo aprende para usarlo: la forma
// de la identidad de un repo (host, namespace con grupos anidados, repo) y la deducción de un remoto por el conector.
//
// Lo que no se puede perder:
//   · el host público lo pone el conector, nunca el núcleo; el host y la ruta codificada entera llegan a glab;
//   · una lectura cortada, un glab que no está o la red caída no son una lista vacía;
//   · un remoto de un host que nadie declaró sigue siendo de otro servidor;
//   · merge-pr no le pregunta por un repo de GitLab a la CLI de otra plataforma.
// Las pruebas de GitHub y de Azure DevOps (team-repos, platform-contract, platform-github-only, merge-pr) siguen
// corriendo sin cambios en sus aserciones: es la otra mitad de la cobertura de este cambio.
//
// stable-data: no toca la red; habla con scripts/tests/lib/fake-glab.js y con repos de git de juguete.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const GITLAB = path.join(ROOT, 'integrations', 'gitlab');
const FAKE_GLAB = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-glab.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const github = (repo) => ({ platform: 'github', org: 'acme', repo });
const GL = { platform: 'gitlab', host: 'gitlab.example.com', namespace: 'producto/plataforma', repo: 'servicio' };
const GL_PUBLIC = { platform: 'gitlab', namespace: 'grupo', repo: 'web' };
const PROYECTO = 'producto/plataforma/servicio';
const RUTA = 'projects/producto%2Fplataforma%2Fservicio';
const teamDoc = (repos = [GL, GL_PUBLIC], extra = {}) => ({
  version: 1, public: github('arnes'), profile: github('perfil'), operations: github('operaciones'),
  merge_suites: { repos: repos.map((repo) => ({ repo, rule: 'automatico' })) }, ...extra,
});

/**
 * Un árbol con su perfil y su team-repos.json, una casa vacía, el glab de mentira con su estado y su registro, y una
 * carpeta de historias cuyos issues van al proyecto de prueba.
 */
function mundo({ platform = { default: 'gitlab' }, estado = {}, team = teamDoc() } = {}) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  const ints = tmp('plataformas-');
  fs.cpSync(GITLAB, path.join(ints, 'gitlab'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'integrations', 'github'), path.join(ints, 'github'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify(platform ? { integrations: { platform } } : {}));
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(team));
  const state = path.join(tmp('glab-'), 'estado.json');
  fs.writeFileSync(state, JSON.stringify(estado));
  const log = path.join(path.dirname(state), 'llamadas.jsonl');
  const historias = tmp('historias-');
  fs.mkdirSync(path.join(historias, '.tycon'));
  fs.writeFileSync(path.join(historias, '.tycon', 'work-items.yaml'), `repo: ${PROYECTO}\ntype: "Historia"\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: ints, TYCON_TREE: tree,
    TYCON_GLAB_CMD: FAKE_GLAB, FAKE_GLAB_STATE: state, FAKE_GLAB_LOG: log };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE)$/.test(k)) delete env[k];
  const llamadas = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const guardado = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  return { env, tree, historias, llamadas, guardado };
}
const pedir = (m, op, args = {}, repo = GL) => P().run(op, args, { env: m.env, repo });
const deTrabajo = (m, op, args = {}) => P().run(op, { repoDir: m.historias, ...args }, { env: m.env });

// ── la identidad en team-repos.json ──────────────────────────────────────────────────────────────────────────────────

test('T1 TeamRepos_GitlabIdentity_Valid @ac-1', () => {
  const r = TEAM.parse(JSON.stringify({ ...teamDoc([GL]), story_index: { repos: [{ repo: GL, mode: 'manual' }] } }));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(TEAM.connectorOf('gitlab'), 'gitlab');
  assert.deepStrictEqual(r.data.merge_suites.repos[0].repo, GL, 'conserva host, namespace con sus grupos y repo');
  assert.deepStrictEqual(r.data.story_index.repos[0].repo, GL);
  // los repos del propio arnés y los de las herramientas de prueba los leen piezas que identifican un repo por org y
  // project: ahí un repo de GitLab se rechaza diciendo dónde sí va, en vez de aceptarse y pisarse con otro
  for (const [doc, ruta] of [
    [{ ...teamDoc([]), operations: GL }, 'operations.platform'], [{ ...teamDoc([]), public: GL }, 'public.platform'],
    [{ ...teamDoc([]), maintainers: GL }, 'maintainers.platform'], [{ ...teamDoc([]), harness_copies: [GL] }, 'harness_copies.0.platform'],
  ]) {
    const mal = TEAM.parse(JSON.stringify(doc));
    assert.strictEqual(mal.data, null, ruta);
    const p = mal.problems.find((x) => x.path === ruta);
    assert.ok(p, `${ruta}: ${JSON.stringify(mal.problems)}`);
    assert.match(p.message, /merge_suites y en story_index/);
  }
  // una herramienta de prueba con el detalle de un repo de GitLab: antes de aceptarse sin que nadie lo lea, se rechaza
  const runner = { name: 'pytest-org', detect: 'pytest.ini', command: 'pytest {args} --junitxml={results}/r.xml', results: { format: 'junit', path: '{results}/r.xml' }, args_default: 'x', repos: [{ repo: GL, args: 'y' }] };
  const conRunner = TEAM.parse(JSON.stringify({ ...teamDoc([]), stack: { test_runners: [runner] } }));
  const todos = [...conRunner.problems, ...Object.values(conRunner.sectionProblems || {}).flat()];
  assert.ok(todos.some((x) => /test_runners\.0\.repos\.0\.repo\.platform$/.test(x.path) && /merge_suites y en story_index/.test(x.message)), JSON.stringify(todos).slice(0, 600));
  // la capa lo encuentra por su nombre, con o sin sus grupos, y elige su conector
  const m = mundo();
  for (const nombre of ['servicio', PROYECTO]) assert.deepStrictEqual(P().identityByName(nombre, { env: m.env }), GL, nombre);
  for (const repo of [PROYECTO, GL]) assert.strictEqual(P().choose('ci.read', { env: m.env, repo }).value.connector, 'gitlab');
  // y lo nombra con su namespace cuando no sabe qué hacer con él
  const sinPerfil = mundo({ platform: null });
  const desconocido = P().choose('ci.read', { env: sinPerfil.env, repo: 'otro/grupo/repo' });
  assert.strictEqual(desconocido.reason, 'sin_plataforma');
  assert.match(desconocido.detail, /otro\/grupo\/repo/);
});

test('T2 TeamRepos_GitlabNoHost_Valid @ac-2', () => {
  const r = TEAM.parse(JSON.stringify(teamDoc([GL_PUBLIC])));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.data.merge_suites.repos[0].repo, 'host'), false, 'el lector no inventa el host');
  // dos identidades se comparan por las claves declaradas
  assert.notStrictEqual(TEAM.identityKey(GL_PUBLIC), TEAM.identityKey({ ...GL_PUBLIC, host: 'gitlab.example.com' }));
  assert.strictEqual(TEAM.identityKey(GL), TEAM.identityKey({ ...GL, namespace: 'Producto/Plataforma' }));
});

test('T3 Gitlab_DefaultHost_FromConnector @ac-2', async () => {
  const m = mundo();
  const r = await pedir(m, 'ci.read', { branch: 'main' }, GL_PUBLIC);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const hosts = [...new Set(m.llamadas().map((l) => l.host))];
  assert.deepStrictEqual(hosts, ['gitlab.com']);
});

test('T4 TeamRepos_GitlabBadNamespace_Rejected @ac-3', () => {
  for (const namespace of ['', '/grupo', 'grupo/', 'grupo//sub', 'grupo/../sub', undefined]) {
    const repo = { ...GL };
    if (namespace === undefined) delete repo.namespace; else repo.namespace = namespace;
    const r = TEAM.parse(JSON.stringify(teamDoc([repo])));
    assert.strictEqual(r.ok, false, JSON.stringify(namespace));
    assert.strictEqual(r.data, null, 'sin datos a medias');
    const p = r.problems.find((x) => x.path === 'merge_suites.repos.0.repo.namespace');
    assert.ok(p, `${JSON.stringify(namespace)}: ${JSON.stringify(r.problems)}`);
    assert.ok(p.message.length > 3);
  }
  const malHost = TEAM.parse(JSON.stringify(teamDoc([{ ...GL, host: 'https://gitlab.example.com/x' }])));
  assert.deepStrictEqual(malHost.problems.map((x) => x.path), ['merge_suites.repos.0.repo.host']);
});

test('T5 TeamRepos_GitlabUnknownKey_Rejected @ac-3', () => {
  for (const clave of ['org', 'project']) {
    const r = TEAM.parse(JSON.stringify(teamDoc([{ ...GL, [clave]: 'acme' }])));
    assert.strictEqual(r.data, null);
    const p = r.problems.find((x) => x.path === `merge_suites.repos.0.repo.${clave}`);
    assert.ok(p, JSON.stringify(r.problems));
    assert.match(p.message, /namespace/, 'dice qué claves lleva un repo de GitLab');
  }
});

// ── el contrato ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SIN_SESION = { status: 401, message: '401 Unauthorized' };

test('T6 Gitlab_Conformance_DeclaredOps @ac-4', async () => {
  const m = mundo({ estado: { fail: { 'GET projects': SIN_SESION, 'POST projects': SIN_SESION, 'PUT projects': SIN_SESION, 'GET users': SIN_SESION } } });
  for (const repo of [undefined, GL]) {
    const r = await P().conformance('gitlab', { env: m.env, repo });
    assert.deepStrictEqual(r.problems, [], JSON.stringify(r));
  }
});

test('T7 Gitlab_NoSession_SinCredencial @ac-4', async () => {
  const m = mundo({ estado: { fail: { 'GET projects': SIN_SESION } } });
  for (const [op, args] of [['ci.read', { branch: 'main' }], ['change-request.read', { number: 1 }], ['change-request.list', {}]]) {
    const r = await pedir(m, op, args);
    assert.deepStrictEqual([r.ok, r.reason], [false, 'sin_credencial'], `${op}: ${JSON.stringify(r)}`);
    assert.match(r.detail, /glab auth login --hostname gitlab\.example\.com/);
  }
  const w = await deTrabajo(m, 'work-item.read', { id: 1 });
  assert.strictEqual(w.reason, 'sin_credencial', JSON.stringify(w));
});

test('T8 Gitlab_UndeclaredOps_NoSoportado @ac-5', async () => {
  const m = mundo();
  for (const op of ['queue.read', 'deployments.read']) {
    const r = await P().run(op, {}, { env: m.env });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_soportado'], `${op}: ${JSON.stringify(r)}`);
  }
  assert.deepStrictEqual(m.llamadas(), [], 'la capa contesta sola: glab no se entera');
});

// ── el pedido de trabajo ─────────────────────────────────────────────────────────────────────────────────────────────

test('T9 Gitlab_WorkItemCycle_Issues @ac-6', async () => {
  const m = mundo();
  const creado = await deTrabajo(m, 'work-item.create', { title: 'Una historia', description: 'El texto', tags: ['story-1.1'], epic: 12, priority: 2, estimate: { value: 16, unit: 'hours' } });
  assert.strictEqual(creado.ok, true, JSON.stringify(creado));
  const id = creado.value.id;
  assert.strictEqual(id, 1);
  assert.deepStrictEqual(creado.value.unsupported.map((u) => u.field).sort(), ['Prioridad', 'Épica']);
  assert.strictEqual(creado.value.estimateAs, 'field');
  let issue = m.guardado().issues[PROYECTO][0];
  assert.deepStrictEqual([...issue.labels].sort(), ['story-1.1', 'tipo:Historia']);
  assert.strictEqual(issue.time_estimate, 16 * 3600, 'la estimación es el tiempo estimado nativo');
  assert.match(creado.summary, /#1 creado en GitLab/);

  const cambiado = await deTrabajo(m, 'work-item.update', { id, state: 'en curso' });
  assert.deepStrictEqual([cambiado.value.changed, cambiado.value.estado, cambiado.value.previo], [true, 'en curso', 'abierto'], JSON.stringify(cambiado));
  assert.ok(m.guardado().issues[PROYECTO][0].labels.includes('estado:en curso'));

  const cerrado = await deTrabajo(m, 'work-item.close', { id, hours: 3 });
  assert.strictEqual(cerrado.ok, true, JSON.stringify(cerrado));
  assert.deepStrictEqual([cerrado.value.hours, cerrado.value.hoursAs], [3, 'field']);
  issue = m.guardado().issues[PROYECTO][0];
  assert.deepStrictEqual([issue.state, issue.total_time_spent], ['closed', 3 * 3600], 'las horas son tiempo trabajado nativo');
  assert.doesNotMatch(cerrado.summary, /como comentario/);

  const hallado = await deTrabajo(m, 'work-item.find', { tag: 'story-1.1' });
  assert.deepStrictEqual(hallado.value.ids, [1], JSON.stringify(hallado));
  const leido = await deTrabajo(m, 'work-item.read', { id });
  assert.deepStrictEqual([leido.value.estado, leido.value.cerrado], ['cerrado', true], JSON.stringify(leido));
  // todo fue al host declarado para ese proyecto, con la ruta codificada entera
  for (const l of m.llamadas()) assert.strictEqual(l.host, 'gitlab.example.com', l.ruta);
  assert.ok(m.llamadas().every((l) => l.ruta.startsWith('users') || l.ruta.startsWith(RUTA)));
  // con team-repos.json roto no se sabe en qué servidor vive el proyecto: no se manda nada al público
  const roto = mundo();
  fs.writeFileSync(path.join(roto.tree, 'team-repos.json'), JSON.stringify({ ...teamDoc(), version: 99 }));
  for (const [op, args] of [['work-item.create', { title: 'x' }], ['work-item.read', { id: 1 }], ['work-item.find', { tag: 'x' }]]) {
    const r = await P().run(op, { repoDir: roto.historias, ...args }, { env: roto.env });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], `${op}: ${JSON.stringify(r)}`);
    assert.match(r.detail, /team-repos\.json/);
  }
  assert.deepStrictEqual(roto.llamadas(), [], 'glab no se entera');
  // sin el archivo, el proyecto es del servidor público
  const sinArchivo = mundo();
  fs.rmSync(path.join(sinArchivo.tree, 'team-repos.json'));
  await P().run('work-item.read', { repoDir: sinArchivo.historias, id: 1 }, { env: sinArchivo.env });
  assert.deepStrictEqual(sinArchivo.llamadas().map((l) => l.host), ['gitlab.com']);
});

const muchos = (n, hacer) => Array.from({ length: n }, (_, i) => hacer(i + 1));

test('T10 Gitlab_WorkItemFind_AllPages @ac-6', async () => {
  const issues = muchos(150, (iid) => ({ iid, state: iid % 2 ? 'opened' : 'closed', title: `i${iid}`, labels: iid === 150 ? ['otra'] : ['story-9'] }));
  const m = mundo({ estado: { issues: { [PROYECTO]: issues } } });
  const r = await deTrabajo(m, 'work-item.find', { tag: 'story-9' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.ids.length, 149, 'abiertos y cerrados, de las dos páginas');
  assert.deepStrictEqual([r.value.ids[0], r.value.ids[148]], [1, 149]);
});

// ── el pedido de cambio ──────────────────────────────────────────────────────────────────────────────────────────────

const ABRIR = { sourceBranch: 'story/x', targetBranch: 'main', text: 'Un cambio\n\nCon su detalle', deleteSourceBranch: true, waitMinutes: 0, pollSeconds: 0 };

test('T11 Gitlab_ChangeRequestOpen_AutoMerge @ac-7', async () => {
  const m = mundo({ estado: { pipelines: { 'story/x': 'running' } } });
  const r = await pedir(m, 'change-request.open', ABRIR);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.value.id, r.value.modo, r.value.merged, r.value.conflict], [1, 'auto', false, undefined]);
  const mr = m.guardado().mrs[PROYECTO][0];
  assert.deepStrictEqual([mr.title, mr.force_remove_source_branch, mr.merge_when_pipeline_succeeds, mr.state], ['Un cambio', true, true, 'opened']);
  // abrirlo otra vez reusa el mismo pedido
  const otra = await pedir(m, 'change-request.open', { ...ABRIR, text: 'Otro título' });
  assert.deepStrictEqual([otra.value.id, otra.value.reused], [1, true], JSON.stringify(otra));
  assert.strictEqual(m.guardado().mrs[PROYECTO].length, 1);
  // sin pipeline, espera los estados de la punta y mergea atado a ella, con commit de merge
  const sha = 'b'.repeat(40);
  const w = mundo({ estado: { shas: { 'story/x': sha }, statuses: { [`${PROYECTO}@${sha}`]: [{ id: 1, name: 'build', status: 'success', created_at: '2030-01-15T12:00:00Z' }] } } });
  const esperado = await pedir(w, 'change-request.open', ABRIR);
  assert.deepStrictEqual([esperado.ok, esperado.value && esperado.value.modo, esperado.value && esperado.value.merged], [true, 'espera-y-mergea', true], JSON.stringify(esperado));
  const mergeo = w.llamadas().find((l) => l.method === 'PUT' && /\/merge$/.test(l.ruta));
  assert.deepStrictEqual([mergeo.cuerpo.sha, mergeo.cuerpo.squash, mergeo.cuerpo.should_remove_source_branch], [sha, false, true]);
  // un trabajo que GitLab deja fallar y uno manual sin disparar no frenan a un pipeline que pasó
  const opcionales = mundo({ estado: { shas: { 'story/x': sha }, statuses: { [`${PROYECTO}@${sha}`]: [
    { id: 1, name: 'build', status: 'success', created_at: '2030-01-15T12:00:00Z' },
    { id: 2, name: 'lint-opcional', status: 'failed', allow_failure: true, created_at: '2030-01-15T12:00:00Z' },
    { id: 3, name: 'deploy-manual', status: 'manual', allow_failure: true, created_at: '2030-01-15T12:00:00Z' },
  ] } } });
  const conOpcionales = await pedir(opcionales, 'change-request.open', ABRIR);
  assert.deepStrictEqual([conOpcionales.ok, conOpcionales.value && conOpcionales.value.merged], [true, true], JSON.stringify(conOpcionales));
  // uno que falla sin ese permiso sí lo frena
  const rojo = mundo({ estado: { shas: { 'story/x': sha }, statuses: { [`${PROYECTO}@${sha}`]: [{ id: 1, name: 'build', status: 'failed', created_at: '2030-01-15T12:00:00Z' }] } } });
  const frenado = await pedir(rojo, 'change-request.open', ABRIR);
  assert.deepStrictEqual([frenado.ok, frenado.reason], [false, 'rechazado'], JSON.stringify(frenado));
  assert.match(frenado.detail, /build terminó en failed/);
  // y sin ningún estado en el tiempo de espera, queda abierto y no se dice que entró
  const nada = await pedir(mundo(), 'change-request.open', ABRIR);
  assert.deepStrictEqual([nada.ok, nada.reason], [false, 'no_medido'], JSON.stringify(nada));
});

test('T12 Gitlab_ChangeRequestOpen_Conflict @ac-7', async () => {
  const m = mundo({ estado: { pipelines: { 'story/x': 'running' }, conflicts: ['story/x'] } });
  const r = await pedir(m, 'change-request.open', ABRIR);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.value.id, r.value.conflict, r.value.merged], [1, true, false]);
  assert.ok(!m.llamadas().some((l) => /\/merge$/.test(l.ruta)), 'con un choque no se pide la entrada');
});

const MR = (iid, extra = {}) => ({ iid, state: 'opened', title: `pedido ${iid}`, source_branch: `rama-${iid}`, target_branch: 'main', sha: String(iid).repeat(40).slice(0, 40), author: 'ana', ...extra });

test('T13 Gitlab_ChangeRequestListReadVote @ac-7', async () => {
  const MERGED = '2030-01-10T10:00:00Z';
  const m = mundo({ estado: { mrs: { [PROYECTO]: [
    MR(1), MR(2, { draft: true, has_conflicts: true }), MR(3, { state: 'merged', merged_at: MERGED, merge_commit_sha: 'd'.repeat(40) }), MR(4, { state: 'closed' }),
  ] }, statuses: { [`${PROYECTO}@${MR(1).sha}`]: [{ id: 1, name: 'build', status: 'running', created_at: '2030-01-15T12:00:00Z' }] } } });
  const lista = await pedir(m, 'change-request.list', {});
  assert.strictEqual(lista.ok, true, JSON.stringify(lista));
  assert.deepStrictEqual(lista.value.map((p) => p.number), [1, 2], 'sólo los abiertos');
  const [uno, dos] = lista.value;
  assert.deepStrictEqual([uno.sourceBranch, uno.sourceCommit, uno.author, uno.title, uno.draft, uno.mergeState, uno.ciRunning], ['rama-1', MR(1).sha, 'ana', 'pedido 1', false, 'clean', true]);
  assert.deepStrictEqual([dos.draft, dos.mergeState, dos.ciRunning], [true, 'conflict', false]);
  const deRama = await pedir(m, 'change-request.list', { sourceBranch: 'rama-2', checks: false });
  assert.deepStrictEqual(deRama.value.map((p) => [p.number, p.ciRunning]), [[2, null]]);

  const entro = await pedir(m, 'change-request.read', { number: 3 });
  assert.deepStrictEqual(entro.value, { number: 3, state: 'merged', draft: false, autoComplete: false, inQueue: false, mergedAt: MERGED, mergeCommit: 'd'.repeat(40), title: 'pedido 3' });
  assert.strictEqual((await pedir(m, 'change-request.read', { number: 4 })).value.state, 'closed');
  assert.strictEqual((await pedir(m, 'change-request.read', { number: 1 })).value.state, 'open');
  const noEsta = await pedir(m, 'change-request.read', { number: 99 });
  assert.deepStrictEqual([noEsta.ok, noEsta.reason], [false, 'no_encontrado'], JSON.stringify(noEsta));

  const voto = await pedir(m, 'change-request.vote', { number: 1, vote: 'approve' });
  assert.deepStrictEqual([voto.ok, voto.value && voto.value.number, voto.value && voto.value.vote], [true, 1, 'approve'], JSON.stringify(voto));
  assert.strictEqual(m.guardado().mrs[PROYECTO][0].approved, true);
  const otroVoto = await pedir(m, 'change-request.vote', { number: 1, vote: 'reject' });
  assert.strictEqual(otroVoto.reason, 'no_soportado', JSON.stringify(otroVoto));
});

// ── la CI ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T14 Gitlab_CiRead_FromCommitStatuses @ac-8', async () => {
  const s = (id, name, status, hora) => ({ id, name, status, created_at: `2030-01-15T${hora}:00:00Z` });
  const m = mundo({ estado: { statuses: {
    [`${PROYECTO}@bien`]: [s(1, 'build', 'success', '10'), s(2, 'pruebas', 'success', '10')],
    [`${PROYECTO}@corre`]: [s(1, 'build', 'success', '10'), s(2, 'pruebas', 'running', '10')],
    [`${PROYECTO}@mal`]: [s(1, 'build', 'failed', '10'), s(2, 'pruebas', 'success', '10')],
    // el mismo contexto dos veces: vale el más nuevo, venga en el orden que venga
    [`${PROYECTO}@repetido`]: [s(1, 'build', 'failed', '10'), s(2, 'build', 'success', '11')],
    [`${PROYECTO}@repetido-al-reves`]: [s(2, 'build', 'failed', '11'), s(1, 'build', 'success', '10')],
    // un trabajo que GitLab deja fallar y uno manual sin disparar: el pipeline de esa punta pasó
    [`${PROYECTO}@opcionales`]: [s(1, 'build', 'success', '10'), { ...s(2, 'lint-opcional', 'failed', '10'), allow_failure: true }, { ...s(3, 'deploy-manual', 'manual', '10'), allow_failure: true }],
    [`${PROYECTO}@cancelado`]: [s(1, 'build', 'canceled', '10')],
    [`${PROYECTO}@en-cola`]: [s(1, 'build', 'success', '10'), s(2, 'despues', 'scheduled', '10')],
  }, shas: { 'story/x': 'mal', rara: '..' }, gone: ['borrada'] } });
  const estado = async (commit) => { const r = await pedir(m, 'ci.read', { commit }); assert.strictEqual(r.ok, true, JSON.stringify(r)); return r.value; };
  assert.deepStrictEqual(await estado('bien'), { state: 'succeeded', stages: [{ pipeline: null, name: 'build', result: 'success' }, { pipeline: null, name: 'pruebas', result: 'success' }] });
  assert.strictEqual((await estado('corre')).state, 'running');
  assert.strictEqual((await estado('corre')).stages.find((x) => x.name === 'pruebas').result, null, 'lo que no terminó no tiene resultado');
  assert.strictEqual((await estado('mal')).state, 'failed');
  assert.deepStrictEqual(await estado('repetido'), { state: 'succeeded', stages: [{ pipeline: null, name: 'build', result: 'success' }] });
  assert.strictEqual((await estado('repetido-al-reves')).state, 'failed');
  const opcionales = await estado('opcionales');
  assert.strictEqual(opcionales.state, 'succeeded');
  assert.deepStrictEqual(opcionales.stages.map((x) => x.result), ['success', 'failed', 'manual'], 'cada etapa conserva su resultado');
  assert.strictEqual((await estado('cancelado')).state, 'failed');
  assert.strictEqual((await estado('en-cola')).state, 'running');
  assert.deepStrictEqual(await estado('sin-nada'), { state: 'none', stages: [] });
  // por rama: GitLab da los estados de un commit, y con el nombre de una rama contesta una lista vacía; la rama se
  // resuelve primero a su commit
  const porRama = await pedir(m, 'ci.read', { branch: 'story/x' });
  assert.deepStrictEqual([porRama.ok, porRama.value && porRama.value.state], [true, 'failed'], JSON.stringify(porRama));
  const rutas = m.llamadas().map((l) => l.ruta);
  assert.ok(rutas.includes(`${RUTA}/repository/commits/story%2Fx`), 'pide el commit de la rama');
  assert.ok(!rutas.some((r) => r.startsWith(`${RUTA}/repository/commits/story%2Fx/statuses`)), 'y no los estados por el nombre de la rama');
  // una rama que no está no es «ninguna CI»
  const noEsta = await pedir(m, 'ci.read', { branch: 'borrada' });
  assert.deepStrictEqual([noEsta.ok, noEsta.reason], [false, 'no_encontrado'], JSON.stringify(noEsta));
  // lo que el servidor devuelve como commit va en la ruta siguiente: algo que no puede ser un commit no se usa
  const rara = await pedir(m, 'ci.read', { branch: 'rara' });
  assert.deepStrictEqual([rara.ok, rara.reason], [false, 'no_medido'], JSON.stringify(rara));
  // y un control que lo lee concluye lo mismo que con cualquier otra plataforma
  const { verdictOf } = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));
  assert.deepStrictEqual([verdictOf(await pedir(m, 'ci.read', { commit: 'bien' })), verdictOf(await pedir(m, 'ci.read', { commit: 'corre' }))], ['verde', 'corriendo']);
});

test('T15 Gitlab_ReadCut_NoMedido @ac-9', async () => {
  const CAIDA = { status: 500, message: '500 Internal Server Error', page: 2 };
  const estado = {
    issues: { [PROYECTO]: muchos(120, (iid) => ({ iid, state: 'opened', title: `i${iid}`, labels: ['story-9'], assignees: ['ana'] })) },
    mrs: { [PROYECTO]: muchos(120, (n) => MR(1000 + n)) },
    statuses: { [`${PROYECTO}@punta`]: muchos(120, (id) => ({ id, name: `c${id}`, status: 'success', created_at: '2030-01-15T10:00:00Z' })) },
    users: { ana: 7 },
    fail: { [`GET ${RUTA}/issues`]: CAIDA, [`GET ${RUTA}/merge_requests`]: CAIDA, [`GET ${RUTA}/repository/commits`]: CAIDA },
  };
  const m = mundo({ estado });
  const cortadas = [
    await deTrabajo(m, 'work-item.find', { tag: 'story-9' }),
    await pedir(m, 'change-request.list', { checks: false }),
    await pedir(m, 'assigned.list', {}),
    await pedir(m, 'ci.read', { commit: 'punta' }),
  ];
  for (const r of cortadas) {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r).slice(0, 300));
    assert.strictEqual(r.value, undefined, 'nunca la lista cortada');
    assert.ok(r.detail.length > 5);
  }
  // un error del servidor en la primera página tampoco es una lista vacía
  const caido = mundo({ estado: { fail: { 'GET projects': { status: 502, message: '502 Bad Gateway' } } } });
  for (const r of [await pedir(caido, 'change-request.list', {}), await pedir(caido, 'assigned.list', {}), await pedir(caido, 'ci.read', { branch: 'main' }), await deTrabajo(caido, 'work-item.find', { tag: 'x' })]) {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
  }
  // el tope de pedidos en una lectura, igual
  const tope = mundo({ estado: { fail: { 'GET projects': { status: 429, message: '429 Too Many Requests' } } } });
  for (const r of [await pedir(tope, 'change-request.list', {}), await pedir(tope, 'assigned.list', {}), await pedir(tope, 'ci.read', { branch: 'main' }), await deTrabajo(tope, 'work-item.find', { tag: 'x' })]) {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
  }
});

// ── el remoto ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T16 Gitlab_RemoteIdentity_DeclaredHostOnly @ac-10 @ac-2', () => {
  const C = require(path.join(GITLAB, 'scripts', 'connector.js'));
  const declarados = [GL, GL_PUBLIC];
  for (const url of [
    'git@gitlab.example.com:producto/plataforma/servicio.git', 'ssh://git@gitlab.example.com:2222/producto/plataforma/servicio.git',
    'https://gitlab.example.com/producto/plataforma/servicio.git', 'https://usuario:clave@GitLab.Example.com/Producto/Plataforma/servicio',
    'git@gitlab.example.com:/producto/plataforma/servicio.git',
  ]) assert.deepStrictEqual(C.identityFromRemote(url, declarados), GL, url);
  // otro repo del mismo host declarado: la identidad sale de la dirección
  assert.deepStrictEqual(C.identityFromRemote('git@gitlab.example.com:otro/grupo/mas/repo.git', declarados), { platform: 'gitlab', host: 'gitlab.example.com', namespace: 'otro/grupo/mas', repo: 'repo' });
  // el declarado sin host vuelve sin host
  assert.deepStrictEqual(C.identityFromRemote('git@gitlab.com:grupo/web.git', declarados), GL_PUBLIC);
  // otro repo del servidor público, sin declarar: trae el servidor de su dirección, para que no se lo tome por un repo
  // de servidor desconocido (con un servidor propio declarado, uno sin host se rechaza)
  assert.deepStrictEqual(C.identityFromRemote('https://gitlab.com/grupo/otro.git', declarados), { platform: 'gitlab', host: 'gitlab.com', namespace: 'grupo', repo: 'otro' });
  // un host que nadie declaró, o una dirección sin grupo, no es de esta plataforma
  for (const url of ['https://gitlab.otro.example/producto/plataforma/servicio.git', 'git@gitlab.example.com:servicio.git', 'https://gitlab.com/grupo/web.git', '', '/una/carpeta']) {
    assert.strictEqual(C.identityFromRemote(url, [GL]), null, url);
  }
  // por la capa: lee los declarados de team-repos.json y le pregunta al conector
  const m = mundo();
  assert.deepStrictEqual(P().identityOfRemoteUrl('https://gitlab.example.com/producto/plataforma/servicio.git', { env: m.env }), GL);
  assert.strictEqual(P().identityOfRemoteUrl('https://gitlab.otro.example/producto/plataforma/servicio.git', { env: m.env }), null);
  assert.strictEqual(P().identityOfRemoteUrl('https://gitlab.example.com/a/b.git', { env: mundo({ team: teamDoc([]) }).env }), null, 'sin ningún repo de GitLab declarado');
  assert.deepStrictEqual(P().identityFromRemote({ host: 'platform', identity: GL }), GL);
  // «no pude mirar» no es «no es de ninguna»: un archivo que no valida o un conector que falla se dicen
  const roto = mundo();
  fs.writeFileSync(path.join(roto.tree, 'team-repos.json'), JSON.stringify({ ...teamDoc(), version: 99 }));
  assert.throws(() => P().identityOfRemoteUrl('https://gitlab.example.com/producto/plataforma/servicio.git', { env: roto.env }), /team-repos\.json/);
  const sinConector = mundo();
  fs.writeFileSync(path.join(sinConector.env.TYCON_INTEGRATIONS_DIR, 'gitlab', 'scripts', 'connector.js'), 'module.exports = { run() {}, identityFromRemote() { throw new Error("roto"); } };\n');
  assert.throws(() => P().identityOfRemoteUrl('https://gitlab.example.com/producto/plataforma/servicio.git', { env: sinConector.env }), /el conector gitlab/);
});

const gitEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k)) env[k] = v;
  return Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@example.invalid', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@example.invalid' });
};
/** Un clon de laboratorio cuyo `origin` es sólo una dirección, con la configuración de merge que se le pase. */
function clon(url, config) {
  const dir = tmp('clon-');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir], { env: gitEnv() });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url], { env: gitEnv() });
  if (config) { fs.mkdirSync(path.join(dir, '.tycon')); fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), config); }
  return dir;
}

test('T17 MergePr_GitlabRemote_UsesConnector @ac-10', () => {
  const M = require(path.join(ROOT, 'scripts', 'tools', 'merge-pr.js'));
  const espia = () => { const f = (args) => { f.calls.push(args); return { status: 1, stdout: '', stderr: 'no se le pregunta' }; }; f.calls = []; return f; };
  const con = (team) => ({ env: gitEnv(), az: espia(), gh: espia(), teamRepos: () => TEAM.parse(JSON.stringify(team)) });
  const PR = 'merge:\n  mode: pr\n  check: "validacion"\n';
  const dir = clon('git@gitlab.example.com:producto/plataforma/servicio.git', PR);
  // con la regla automatico y un pipeline declarado: la pregunta «qué exige la rama» no va a la CLI de otra plataforma
  const declarado = { ...teamDoc([]), merge_suites: { repos: [{ repo: GL, rule: 'automatico', full_tests_pipeline: 'build' }] } };
  const deps = con(declarado);
  const p = M.plan({ repo: dir, source: 'story/x', target: 'main' }, deps);
  assert.strictEqual(p.code, 0, JSON.stringify(p));
  assert.deepStrictEqual([p.host, p.mode, p.step], ['platform', 'pr', '9b'], JSON.stringify(p));
  assert.deepStrictEqual(p.repo, GL, 'el plan trae la identidad para el paso del pedido de cambio');
  assert.deepStrictEqual([p.suites, p.suitesRule, p.platform.answer], ['machine', 'automatico', 'could-not-ask'], JSON.stringify(p));
  assert.deepStrictEqual([deps.az.calls, deps.gh.calls], [[], []]);
  // con confiar-en-el-servidor va por pedido igual, diciendo que no se pudo confirmar
  const confia = con({ ...teamDoc([]), merge_suites: { repos: [{ repo: GL, rule: 'confiar-en-el-servidor' }] } });
  const c = M.plan({ repo: clon('https://gitlab.example.com/producto/plataforma/servicio.git'), source: 'story/x', target: 'main' }, confia);
  assert.deepStrictEqual([c.host, c.mode, c.step, c.suites], ['platform', 'pr', '9b', 'server'], JSON.stringify(c));
  assert.match(c.suitesReason, /no pude confirmar/);
  assert.deepStrictEqual([confia.az.calls, confia.gh.calls], [[], []]);
  // un host que nadie declaró sigue siendo de otro servidor: empuje directo
  const otro = M.plan({ repo: clon('https://gitlab.otro.example/producto/plataforma/servicio.git', PR), source: 'story/x', target: 'main' }, con(declarado));
  assert.deepStrictEqual([otro.host, otro.step, otro.repo], ['other', '9', undefined], JSON.stringify(otro));
  // y sin team-repos.json, también
  const sin = M.plan({ repo: dir, source: 'story/x', target: 'main' }, { env: gitEnv(), az: espia(), gh: espia(), teamRepos: () => ({ absent: true }) });
  assert.deepStrictEqual([sin.code, sin.host, sin.step], [0, 'other', '9']);
  // con el archivo ilegible no se sabe si el remoto es de una plataforma declarada: con el merge por pedido no se baja
  // a empuje directo; con el merge por empuje, nada cambia
  const ilegible = { env: gitEnv(), az: espia(), gh: espia(), teamRepos: () => ({ ok: false, data: null, problems: [{ path: 'version', message: 'no es 1' }] }) };
  const duda = M.plan({ repo: dir, source: 'story/x', target: 'main' }, ilegible);
  assert.strictEqual(duda.code, 2, JSON.stringify(duda));
  assert.match(duda.reason, /no sé si origin .* es de una plataforma que la organización declara: team-repos\.json: version: no es 1/);
  const empuja = M.plan({ repo: clon('git@gitlab.example.com:producto/plataforma/servicio.git'), source: 'story/x', target: 'main' }, ilegible);
  assert.deepStrictEqual([empuja.code, empuja.host, empuja.mode, empuja.step], [0, 'other', 'push', '9'], JSON.stringify(empuja));
});

test('T21 StoryIndex_GitlabRemote_ReadsMode @ac-10', () => {
  const archivo = path.join(tmp('equipo-'), 'team-repos.json');
  fs.writeFileSync(archivo, JSON.stringify({ ...teamDoc([GL]), story_index: { repos: [{ repo: GL, mode: 'generated' }] } }));
  const modo = (url) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'story-index.js'), '--repo', clon(url), '--mode', '--team-repos', archivo], { encoding: 'utf8', env: gitEnv() });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  };
  assert.strictEqual(modo('git@gitlab.example.com:producto/plataforma/servicio.git'), 'generated');
  assert.strictEqual(modo('https://gitlab.example.com/producto/plataforma/servicio.git'), 'generated');
  assert.strictEqual(modo('https://gitlab.otro.example/producto/plataforma/servicio.git'), 'manual');
  assert.strictEqual(modo('git@gitlab.example.com:producto/plataforma/otro.git'), 'manual', 'un repo sin entrada en story_index');
});

// ── la neutralidad del núcleo ────────────────────────────────────────────────────────────────────────────────────────

test('T18 Core_Neutrality_StillGreen @ac-11', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-core-neutrality.js'), '--repo', ROOT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const manifiesto = JSON.parse(fs.readFileSync(path.join(GITLAB, 'integration.json'), 'utf8'));
  for (const t of ['glab mr create --fill', 'glab api projects/1', 'glab issue close 3', 'https://gitlab.com/grupo/repo', 'un host /api/v4/projects']) {
    assert.ok(manifiesto.hardSignals.some((s) => new RegExp(s).test(t)), `ninguna señal declarada reconoce «${t}»`);
  }
  // la capa reconoce los comandos crudos del conector, también por sus alias (que el freno de guardar los pase por la
  // ventana lo mide T19)
  for (const cmd of ['glab mr create --fill', 'glab mr new', 'glab mr merge 5', 'glab mr accept 5', 'glab issue create -t x', 'glab issue new -t x', 'glab issue close 3']) {
    assert.strictEqual(P().rawCommandOf(cmd), 'gitlab', cmd);
  }
  assert.strictEqual(P().rawCommandOf('glab mr view 5'), null, 'una lectura no es un comando que la capa reemplaza');
  // ninguna casa hoy con una línea del núcleo: la lista de permitidos no nombra a GitLab
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'neutrality-allowlist.json'), 'utf8'));
  assert.ok(!JSON.stringify(lista.entries).toLowerCase().includes('gitlab'));
});

// 🔴 Falla con: un pedido de GitLab escrito a mano (`glab mr create`, `glab mr merge`) que el freno de guardar no lee
// como pedido, y que en una corrida sale sin pasar por la ventana de la persona; o un issue o una lectura que sí pasa
test('T19 Gitlab_RawChangeRequest_SaveBrakeAsks @ac-11', () => {
  const freno = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'save-brake.js'));
  const pedidos = (cmd) => freno.comandosQueGuardan(cmd, os.tmpdir()).filter((c) => c.tipo === 'pr');
  for (const [cmd, forma] of [['glab mr create --fill', 'glab mr create'], ['glab mr new -t x', 'glab mr new'], ['glab mr merge 5', 'glab mr merge'], ['glab mr accept 5', 'glab mr accept'], ['glab -R grupo/repo mr create --fill', 'glab mr create']]) {
    assert.deepStrictEqual(pedidos(cmd).map((c) => c.forma), [forma], cmd);
  }
  for (const cmd of ['glab issue create -t x', 'glab issue close 3', 'glab mr view 5', 'glab mr list']) {
    assert.deepStrictEqual(pedidos(cmd), [], `${cmd}: no crea ni junta un pedido`);
  }
});

test('T20 Gitlab_NestedNamespace_EncodedPath @ac-13', async () => {
  const A = require(path.join(GITLAB, 'scripts', 'glab-api.js'));
  assert.strictEqual(A.projectPath(GL), RUTA);
  assert.strictEqual(A.projectPath({ namespace: 'grupo', repo: 'web.site' }), 'projects/grupo%2Fweb.site');
  for (const mal of [{ namespace: 'a/../b', repo: 'x' }, { namespace: '', repo: 'x' }, { namespace: 'a', repo: 'x/y' }, { namespace: 'a', repo: '-x' }, { org: '..', repo: 'x' }, { repo: 'x' }, null]) {
    assert.strictEqual(A.projectPath(mal), null, JSON.stringify(mal));
  }
  // un repo sin declarar que llega por su nombre: con dos tramos o con más, va al mismo proyecto
  const porDefecto = mundo({ team: teamDoc([]) });
  for (const [nombre, ruta] of [['grupo/proyecto', 'projects/grupo%2Fproyecto'], ['grupo/sub/proyecto', 'projects/grupo%2Fsub%2Fproyecto']]) {
    const r = await P().run('ci.read', { branch: 'main' }, { env: porDefecto.env, repo: nombre });
    assert.strictEqual(r.ok, true, `${nombre}: ${JSON.stringify(r)}`);
    assert.ok(porDefecto.llamadas().some((l) => l.host === 'gitlab.com' && l.ruta.startsWith(`${ruta}/`)), nombre);
  }
  const m = mundo();
  await pedir(m, 'change-request.read', { number: 1 });
  const [llamada] = m.llamadas();
  assert.deepStrictEqual([llamada.host, llamada.ruta], ['gitlab.example.com', `${RUTA}/merge_requests/1`]);
  // un host con forma de opción no llega a la línea de comandos
  const r = await pedir(m, 'change-request.read', { number: 1 }, { ...GL, host: '--evil' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'rechazado'], JSON.stringify(r));
});

// ── lo asignado, y lo que no es una respuesta vacía ──────────────────────────────────────────────────────────────────

test('T22 Gitlab_AssignedList_IssuesAndMergeRequests @ac-14', async () => {
  const m = mundo({ estado: { users: { ana: 7, beto: 8 },
    issues: { [PROYECTO]: [
      { iid: 1, state: 'opened', title: 'con dos', assignees: ['ana', 'beto'] }, { iid: 2, state: 'opened', title: 'sin nadie' },
      { iid: 3, state: 'closed', title: 'cerrado', assignees: ['ana'] },
    ] },
    mrs: { [PROYECTO]: [MR(10, { assignees: ['Beto'] }), MR(11), MR(12, { state: 'merged', assignees: ['ana'] })] } } });
  const r = await pedir(m, 'assigned.list', {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value.map((f) => [f.tipo, f.id, f.asignado]), [['issue', 1, 'ana'], ['issue', 1, 'beto'], ['merge request', 10, 'beto']]);
  for (const f of r.value) assert.deepStrictEqual(Object.keys(f).sort(), ['asignado', 'enlace', 'estado', 'id', 'tipo', 'titulo']);
  assert.deepStrictEqual([r.value[0].titulo, r.value[0].estado], ['con dos', 'open']);
  assert.match(r.value[2].enlace, /merge_requests\/10$/);
});

test('T23 Gitlab_NoBinaryOrNoNetwork_NotEmpty @ac-15', async () => {
  const m = mundo();
  m.env.TYCON_GLAB_CMD = path.join(m.tree, 'no-esta', 'glab');
  for (const r of [await pedir(m, 'change-request.list', {}), await pedir(m, 'ci.read', { branch: 'main' }), await deTrabajo(m, 'work-item.find', { tag: 'x' })]) {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_medido'], JSON.stringify(r));
    assert.match(r.detail, /no se pudo ejecutar/);
  }
  const sinRed = mundo({ estado: { fail: { 'GET projects': { red: true }, 'POST projects': { red: true } } } });
  for (const r of [await pedir(sinRed, 'change-request.list', {}), await pedir(sinRed, 'assigned.list', {}), await pedir(sinRed, 'change-request.read', { number: 1 }),
    await deTrabajo(sinRed, 'work-item.create', { title: 'x' })]) {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'red'], JSON.stringify(r));
  }
  // una conexión que se corta al mergear tampoco es «GitLab lo rechazó»: no se sabe si entró
  const sha = 'e'.repeat(40);
  const cortada = mundo({ estado: { shas: { 'story/x': sha }, statuses: { [`${PROYECTO}@${sha}`]: [{ id: 1, name: 'build', status: 'success', created_at: '2030-01-15T12:00:00Z' }] },
    fail: { [`PUT ${RUTA}/merge_requests/1/merge`]: { red: 'ERROR: Get "https://gitlab.example.com/api": read tcp 10.0.0.2:51716->10.0.0.1:443: read: connection reset by peer' } } } });
  const m2 = await pedir(cortada, 'change-request.open', ABRIR);
  assert.deepStrictEqual([m2.ok, m2.reason], [false, 'red'], JSON.stringify(m2));
  assert.match(m2.detail, /pedido !1/);
  for (const texto of ['dial tcp 10.0.0.1:443: connect: connection refused', 'net/http: TLS handshake timeout', 'context deadline exceeded', 'Post "x": EOF']) {
    const caida = mundo({ estado: { fail: { 'GET projects': { red: texto } } } });
    const r = await pedir(caida, 'change-request.read', { number: 1 });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'red'], `${texto}: ${JSON.stringify(r)}`);
  }
});

// ── un repo sin declarar, el skill de merge y el freno de un pedido por repo ─────────────────────────────────────────

test('T24 Gitlab_UndeclaredRepo_DeclaredHosts_Refused @ac-2', async () => {
  // team-repos.json declara un repo con su propio servidor: uno sin declarar no se manda al público
  const m = mundo();
  const otro = { platform: 'gitlab', namespace: 'otro', repo: 'x' };
  const rechazado = (r, quien) => {
    assert.deepStrictEqual([r.ok, r.reason], [false, 'sin_plataforma'], `${quien}: ${JSON.stringify(r)}`);
    assert.match(r.detail, /otro\/x/, quien);
    assert.match(r.detail, /team-repos\.json/, quien);
    assert.match(r.detail, /host/, quien);
  };
  rechazado(await pedir(m, 'ci.read', { branch: 'main' }, otro), 'por su identidad');
  rechazado(await pedir(m, 'change-request.list', {}, 'otro/x'), 'por su nombre');
  fs.writeFileSync(path.join(m.historias, '.tycon', 'work-items.yaml'), 'repo: otro/x\ntype: "Historia"\n');
  rechazado(await deTrabajo(m, 'work-item.create', { title: 'Una historia' }), 'como proyecto de los issues');
  assert.deepStrictEqual(m.llamadas(), [], 'glab no se llama');
  // con su servidor explícito va a ese servidor
  const r = await pedir(m, 'ci.read', { branch: 'main' }, { ...otro, host: 'gitlab.otro.example' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([...new Set(m.llamadas().map((l) => l.host))], ['gitlab.otro.example']);
  // pedido por su nombre con el servidor en la mano: va a ese servidor, aunque el nombre esté declarado en otro
  const conHost = await pedir(m, 'change-request.list', { checks: false }, JSON.stringify({ namespace: 'producto/plataforma', repo: 'servicio', host: 'gitlab.otro.example' }));
  assert.strictEqual(conHost.ok, true, JSON.stringify(conHost));
  assert.strictEqual(m.llamadas().at(-1).host, 'gitlab.otro.example');
  // el mismo proyecto declarado en dos servidores: pedido por su nombre es un «no», en cualquier orden del archivo
  const B = { ...GL, host: 'gitlab.b.example' };
  for (const orden of [[GL, B], [B, GL], [GL_PUBLIC, { ...GL_PUBLIC, host: 'gitlab.b.example' }]]) {
    const dos = mundo({ team: teamDoc(orden) });
    const r2 = await pedir(dos, 'change-request.list', { checks: false }, `${orden[0].namespace}/${orden[0].repo}`);
    assert.deepStrictEqual([r2.ok, r2.reason], [false, 'rechazado'], JSON.stringify(r2));
    assert.match(r2.detail, /más de un servidor/);
    assert.deepStrictEqual(dos.llamadas(), []);
  }
  // un repo de GitLab declarado sólo en story_index también se encuentra por su nombre
  const indice = mundo({ platform: { default: 'github' }, team: teamDoc([], { story_index: { repos: [{ repo: GL, mode: 'manual' }] } }) });
  const ri = await pedir(indice, 'change-request.list', { checks: false }, PROYECTO);
  assert.strictEqual(ri.ok, true, JSON.stringify(ri));
  assert.ok(indice.llamadas().some((l) => l.host === 'gitlab.example.com' && l.ruta.startsWith(`${RUTA}/`)));
  // un remoto del público sin declarar trae su servidor, y con un servidor propio declarado no se rechaza
  const remoto = P().identityOfRemoteUrl('git@gitlab.com:grupo/otro.git', { env: m.env });
  const rr = await pedir(m, 'ci.read', { branch: 'main' }, remoto);
  assert.strictEqual(rr.ok, true, JSON.stringify(rr));
  assert.strictEqual(m.llamadas().at(-1).host, 'gitlab.com');
  // sin ningún servidor declarado, el público sigue valiendo
  const publico = mundo({ team: teamDoc([GL_PUBLIC]) });
  const p = await pedir(publico, 'ci.read', { branch: 'main' }, otro);
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  assert.deepStrictEqual([...new Set(publico.llamadas().map((l) => l.host))], ['gitlab.com']);
});

test('T25 MergeSkill_PlatformHost_StepUsesPlanRepo @ac-16', () => {
  const STEPS = path.join(ROOT, 'skills', 'tycon-merge-to-main', 'steps');
  const cero = fs.readFileSync(path.join(STEPS, 'step-00-preflight.md'), 'utf8');
  const nueveB = fs.readFileSync(path.join(STEPS, 'step-09b-create-change-request.md'), 'utf8');
  assert.match(cero, /`platform`[^\n]*`9b`|`9b`[^\n]*`platform`/, 'el paso 0 dice que 9b también es el de host platform');
  // el renglón de host platform de la lista del --repo usa el campo repo del plan, no un placeholder armado a mano
  const renglon = nueveB.split('\n').find((l) => /^- .*host `platform`/.test(l) || /^- Una plataforma por la capa/.test(l));
  assert.ok(renglon, 'el 9b trae el renglón del --repo de host platform');
  assert.match(renglon, /`repo` del plan/);
  for (const [nombre, texto] of [['paso 0', cero], ['paso 9b', nueveB]]) {
    assert.doesNotMatch(texto, /\bglab\b|gitlab/i, `${nombre}: no nombra comandos ni la plataforma`);
  }
});

test('T26 PrOnePerRepo_NestedRepo_UsesLayerReader @ac-17', () => {
  assert.deepStrictEqual(P().repoOf('acme/portal'), { org: 'acme', repo: 'portal' }, 'el lector de la capa se exporta');
  // una barra al final no cambia de repo
  assert.deepStrictEqual(P().repoOf(`${PROYECTO}/`), { namespace: 'producto/plataforma', repo: 'servicio' });
  assert.deepStrictEqual(P().repoOf('acme/portal/'), { org: 'acme', repo: 'portal' });
  const HOOK = path.join(ROOT, 'scripts', 'hooks', 'pr-one-per-repo-guard.js');
  const otro = MR(1);
  const estado = { mrs: { [PROYECTO]: [otro] }, statuses: { [`${PROYECTO}@${otro.sha}`]: [{ id: 1, name: 'build', status: 'running', created_at: '2030-01-15T12:00:00Z' }] } };
  const args = JSON.stringify({ sourceBranch: 'nueva', targetBranch: 'main', text: 't', deleteSourceBranch: true });
  for (const repo of [PROYECTO, JSON.stringify(GL)]) {
    const m = mundo({ estado });
    const command = `node platform.js change-request open --repo '${repo}' --auto-complete --args '${args}'`;
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_input: { command } }), env: { ...m.env, TYCON_PR_ONE_PER_REPO: '1' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `${repo}: ${r.stderr}`);
    assert.match(r.stderr, /producto\/plataforma\/servicio/, repo);
    assert.ok(m.llamadas().some((l) => l.host === 'gitlab.example.com' && l.ruta.startsWith(`${RUTA}/`)), `${repo}: ${JSON.stringify(m.llamadas())}`);
  }
});
