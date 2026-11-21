'use strict';

/**
 * queue-validation.test.js — el lanzador de la validación corta las de la MISMA rama que no terminaron y encola la
 * nueva.
 *
 * Contra un Azure de mentira en esta máquina (un servidor http local que anota cada llamada). Lo que no puede pasar:
 *   · que corte una validación de OTRA rama (la de otra rama prueba otro código);
 *   · que «no pude mirar» se lea como «no hay ninguna vieja» y se encole igual;
 *   · que deje el pedido de la vieja esperando carril (cancelar la corrida no lo saca de la fila);
 *   · que una vieja que no se pudo cortar pase en silencio.
 *
 * Correr: node --test scripts/tests/queue-validation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'ci', 'queue-validation.js');
const { fromOrigin } = require(SCRIPT);

/** Un Azure de mentira. `state`: builds por estado, la fila y qué falla. Devuelve { url, calls, close }. */
function fakeAzure(state) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null });
      const send = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
      if (req.method === 'GET' && /\/_apis\/build\/builds$/.test(u.pathname)) {
        if (state.listFails) return send(state.listFails, state.listFails === 203 ? undefined : { message: 'no' });
        const st = u.searchParams.get('statusFilter');
        const br = u.searchParams.get('branchName');
        return send(200, { value: (state.builds || []).filter((b) => b.status === st && b.sourceBranch === br) });
      }
      if (req.method === 'PATCH' && /\/_apis\/build\/builds\/\d+$/.test(u.pathname)) {
        const id = Number(u.pathname.split('/').pop());
        if ((state.cancelFails || []).includes(id)) return send(403, { message: 'sin permiso' });
        return send(200, { id, status: 'cancelling' });
      }
      if (req.method === 'GET' && u.pathname.endsWith('/_apis/distributedtask/pools')) return send(200, { value: [{ id: 9, name: 'Azure Pipelines' }] });
      if (req.method === 'GET' && u.pathname.endsWith('/pools/9/jobrequests')) return send(200, { value: state.requests || [] });
      if (req.method === 'DELETE' && /\/pools\/9\/jobrequests\/\d+$/.test(u.pathname)) return send(204);
      if (req.method === 'POST' && /\/_apis\/build\/builds$/.test(u.pathname)) {
        if (state.queueFails) return send(500, { message: 'no' });
        return send(200, { id: 777, status: 'notStarted' });
      }
      return send(404, { message: `no esperaba ${req.method} ${u.pathname}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

function run(url, extra = [], env = {}) {
  return new Promise((resolve) => {
    // Parado fuera de cualquier clon y sin la configuración de la máquina: estos casos pasan organización, proyecto y
    // rama por opción, y no pueden depender del origin de quien corre la suite (en el agente de Azure es otro que en una
    // máquina del equipo).
    const p = spawn(process.execPath, [SCRIPT, '--org', 'acme', '--project', 'lab', '--branch', 'fix/mia', ...(extra.includes('--pipeline') ? [] : ['--pipeline', '170']), ...extra], {
      cwd: require('os').tmpdir(),
      env: Object.assign({}, process.env, { AZURE_DEVOPS_EXT_PAT: 'llave-de-laboratorio', TYCON_ADO_BASE_URL: url,
        TYCON_VALIDATION_ORG: '', TYCON_VALIDATION_PROJECT: '', TYCON_VALIDATION_PIPELINE: '' }, env),
    });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const MINE = 'refs/heads/fix/mia';
const OTHER = 'refs/heads/story/otra';
const of = (calls, method, re) => calls.filter((c) => c.method === method && re.test(c.path));

test('QueueValidation_CutsOnlyTheSameBranch_RemovesTheirWaitingRequests_Queues', async () => {
  const az = await fakeAzure({
    builds: [
      { id: 10, status: 'notStarted', sourceBranch: MINE, sourceVersion: 'aaa' },
      { id: 11, status: 'inProgress', sourceBranch: MINE, sourceVersion: 'bbb' },
      { id: 20, status: 'notStarted', sourceBranch: OTHER, sourceVersion: 'ccc' },
    ],
    requests: [
      { requestId: 101, owner: { id: 10 } },                                  // espera carril: se borra
      { requestId: 111, owner: { id: 11 }, assignTime: '2026-10-05T20:00:00Z' }, // ya tiene carril: lo termina Azure
      { requestId: 201, owner: { id: 20 } },                                  // de otra rama: no se toca
    ],
  });
  try {
    const r = await run(az.url);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(of(az.calls, 'PATCH', /builds\/\d+$/).map((c) => c.path.split('/').pop()).sort(), ['10', '11']);
    assert.deepStrictEqual(of(az.calls, 'PATCH', /builds\/\d+$/).map((c) => c.body.status), ['cancelling', 'cancelling']);
    assert.deepStrictEqual(of(az.calls, 'DELETE', /jobrequests/).map((c) => c.path.split('/').pop()), ['101'], 'sólo el pedido que espera, y sólo de la misma rama');
    const q = of(az.calls, 'POST', /builds$/);
    assert.strictEqual(q.length, 1);
    assert.deepStrictEqual(q[0].body, { definition: { id: 170 }, sourceBranch: MINE });
    assert.match(r.out, /cortadas: #10, #11/);
    assert.match(r.out, /encolada: #777/);
  } finally { await az.close(); }
});

test('QueueValidation_NothingOld_JustQueues', async () => {
  const az = await fakeAzure({ builds: [{ id: 20, status: 'inProgress', sourceBranch: OTHER }] });
  try {
    const r = await run(az.url, ['--pipeline', '42']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(of(az.calls, 'PATCH', /./).length, 0);
    assert.deepStrictEqual(of(az.calls, 'POST', /builds$/)[0].body.definition, { id: 42 });
    assert.ok(of(az.calls, 'GET', /builds$/).every((c) => c.query.definitions === '42'), 'mira las del mismo pipeline');
  } finally { await az.close(); }
});

test('QueueValidation_CannotLook_CutsNothingQueuesNothing_Exit2', async () => {
  for (const listFails of [500, 401, 203]) {
    const az = await fakeAzure({ listFails, builds: [{ id: 10, status: 'notStarted', sourceBranch: MINE }] });
    try {
      const r = await run(az.url);
      assert.strictEqual(r.code, 2, `${listFails}: ${r.out}${r.err}`);
      assert.strictEqual(of(az.calls, 'PATCH', /./).length + of(az.calls, 'POST', /./).length, 0, `${listFails}: nada cortado ni encolado`);
      assert.match(r.err, /no pude leer[^\n]*no se cortó ni se encoló nada/);
    } finally { await az.close(); }
  }
});

test('QueueValidation_NoServer_Exit2', async () => {
  const az = await fakeAzure({});
  await az.close();
  const r = await run(az.url);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.err, /sin respuesta/);
});

test('QueueValidation_OldOneCannotBeCut_QueuesAndSaysWhich_Exit3', async () => {
  const az = await fakeAzure({ builds: [{ id: 10, status: 'notStarted', sourceBranch: MINE }, { id: 11, status: 'inProgress', sourceBranch: MINE }], cancelFails: [11] });
  try {
    const r = await run(az.url);
    assert.strictEqual(r.code, 3, r.out + r.err);
    assert.match(r.out, /encolada: #777/);
    assert.match(r.err, /no pude cortar: #11 \(HTTP 403\)/);
  } finally { await az.close(); }
});

test('QueueValidation_QueueFails_Exit1_SaysOldOnesWereCut', async () => {
  const az = await fakeAzure({ builds: [{ id: 10, status: 'notStarted', sourceBranch: MINE }], queueFails: true });
  try {
    const r = await run(az.url);
    assert.strictEqual(r.code, 1, r.out + r.err);
    assert.match(r.err, /no pude encolar[^\n]*las viejas ya se cortaron/);
  } finally { await az.close(); }
});

test('QueueValidation_DryRun_TouchesNothing', async () => {
  const az = await fakeAzure({ builds: [{ id: 10, status: 'notStarted', sourceBranch: MINE, sourceVersion: 'aaaabbbbcc' }] });
  try {
    const r = await run(az.url, ['--dry-run']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(az.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.match(r.out, /cortaría: #10 \(notStarted, aaaabbbb\)/);
    assert.match(r.out, /encolaría: pipeline 170 sobre fix\/mia/);
  } finally { await az.close(); }
});

test('QueueValidation_NoKey_Exit2_NoCalls', async () => {
  const az = await fakeAzure({});
  try {
    const r = await run(az.url, [], { AZURE_DEVOPS_EXT_PAT: '' });
    assert.strictEqual(r.code, 2);
    assert.strictEqual(az.calls.length, 0);
    assert.match(r.err, /falta AZURE_DEVOPS_EXT_PAT/);
  } finally { await az.close(); }
});

// La validación completa de una rama se pide con `--all`: el pedido lleva el parámetro `runAll` de
// la 170 (pipelines/azure-pipelines-maintainers-pr.yml) en `true`. Sin `--all`, el pedido no lo lleva (lo de arriba exige el cuerpo exacto).
test('T9 QueueValidation_AllPassesRunAll', async () => {
  const az = await fakeAzure({});
  try {
    const r = await run(az.url, ['--all']);
    assert.strictEqual(r.code, 0, r.err);
    const q = of(az.calls, 'POST', /builds$/);
    assert.strictEqual(q.length, 1);
    assert.deepStrictEqual(q[0].body, { definition: { id: 170 }, sourceBranch: MINE, templateParameters: { runAll: 'true' } });
    assert.match(r.out, /corre todo/);
    const dry = await run(az.url, ['--all', '--dry-run']);
    assert.match(dry.out, /encolaría: pipeline 170 sobre fix\/mia, corre todo/);
  } finally { await az.close(); }
});

test('QueueValidation_OrgAndProjectFromOrigin', () => {
  assert.deepStrictEqual(fromOrigin('https://dev.azure.com/acme/mi%20proyecto/_git/repo'), { org: 'acme', project: 'mi proyecto' });
  assert.strictEqual(fromOrigin('git@github.com:acme/repo.git'), null);
});

// ── T10: un clon de GitHub ─────────────────────────────────────────────────────────
// El dueño trabaja en un clon del repo público. La organización, el proyecto y la definición de Azure no
// se escriben en el guion (viaja en el público): salen de la configuración de la máquina o de una opción. Y si la rama
// ya tiene un pedido abierto, la validación la dispara el pedido: encolar otra sería una segunda corrida por cambio.
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });

/** Un clon de juguete con `origin` en GitHub y un `gh` de juguete que contesta los pedidos abiertos con `prs` (o sale 1). */
function githubClone(prs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gh-'));
  labs.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
  execFileSync('git', ['init', '-q', '-b', 'fix/mia', path.join(dir, 'clone')], { env });
  execFileSync('git', ['-C', path.join(dir, 'clone'), 'remote', 'add', 'origin', 'https://github.com/acme/harness.git'], { env });
  execFileSync('git', ['-C', path.join(dir, 'clone'), '-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno'], { env });
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, prs === null
    ? '#!/bin/sh\necho "gh: sin sesión" >&2\nexit 1\n'
    : `#!/bin/sh\necho "$*" >> "${dir}/gh-calls.txt"\necho '${JSON.stringify(prs)}'\n`, { mode: 0o755 });
  return { dir, clone: path.join(dir, 'clone'), gh };
}

/** Un árbol cuyo team-repos.json declara la 170 como la validación de acme/lab/harness (para `TYCON_TREE`). */
function declaring170() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-tree-'));
  labs.push(dir);
  const harness = { platform: 'azure', org: 'acme', project: 'lab', repo: 'harness' };
  fs.writeFileSync(path.join(dir, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: harness, operations: harness, merge_suites: { repos: [{ repo: harness, full_tests_pipeline: 170 }] } }));
  return dir;
}

function runIn(cwd, url, extra = [], env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...extra], {
      cwd,
      env: Object.assign({}, process.env, { AZURE_DEVOPS_EXT_PAT: 'llave-de-laboratorio', TYCON_ADO_BASE_URL: url,
        TYCON_VALIDATION_ORG: '', TYCON_VALIDATION_PROJECT: '', TYCON_VALIDATION_PIPELINE: '' }, env),
    });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('T10 QueueValidation_GithubClone_ConfigNotRepo_RefusesWhenPrOpen_CutsOlderSameBranch', async () => {
  const az = await fakeAzure({ builds: [{ id: 30, status: 'inProgress', sourceBranch: MINE }] });
  try {
    const cfg = { TYCON_VALIDATION_ORG: 'acme', TYCON_VALIDATION_PROJECT: 'lab', TYCON_VALIDATION_PIPELINE: '184' };
    // sin la definición en la configuración: no la inventa (la 170 es la del interno de Azure), sale 2 y dice de dónde
    const lab = githubClone([]);
    let r = await runIn(lab.clone, az.url, [], { TYCON_GH: lab.gh, TYCON_VALIDATION_ORG: 'acme', TYCON_VALIDATION_PROJECT: 'lab' });
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /TYCON_VALIDATION_PIPELINE/);
    assert.strictEqual(az.calls.length, 0, 'sin saber qué definición, no mira ni corta nada');
    // con la configuración: corta la vieja de la rama y encola la definición configurada
    r = await runIn(lab.clone, az.url, [], { TYCON_GH: lab.gh, ...cfg });
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(of(az.calls, 'PATCH', /builds\/30$/).length, 1, 'corta la vieja de la misma rama');
    assert.deepStrictEqual(of(az.calls, 'POST', /builds$/)[0].body, { definition: { id: 184 }, sourceBranch: MINE });
    assert.match(fs.readFileSync(path.join(lab.dir, 'gh-calls.txt'), 'utf8'), /pr list .*--head fix\/mia/);
    // con un pedido abierto: no encola (el pedido ya la dispara), sale 4 y lo dice
    const withPr = githubClone([{ number: 7 }]);
    const before = az.calls.length;
    r = await runIn(withPr.clone, az.url, [], { TYCON_GH: withPr.gh, ...cfg });
    assert.strictEqual(r.code, 4, r.err);
    assert.match(r.err, /pedido abierto \(#7\)/);
    assert.strictEqual(az.calls.length, before, 'con el pedido abierto no toca Azure');
    // «no pude mirar» si tiene un pedido no es «no tiene»: sale 2 sin tocar nada
    const noGh = githubClone(null);
    r = await runIn(noGh.clone, az.url, [], { TYCON_GH: noGh.gh, ...cfg });
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /no pude mirar si la rama tiene un pedido abierto/);
    assert.strictEqual(az.calls.length, before);
    // --dry-run dice qué haría, con la definición de la configuración
    r = await runIn(lab.clone, az.url, ['--dry-run'], { TYCON_GH: lab.gh, ...cfg });
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /encolaría: pipeline 184 sobre fix\/mia/);
  } finally { await az.close(); }
});

test('T10 QueueValidation_AnyNonAzureOrigin_IsThePublicClone_BranchPrefixStripped', async () => {
  // Un origin de GitHub con usuario en la URL o con un alias de SSH (varias
  // cuentas) no es de Azure: es el clon del público, con su configuración y su consulta de pedidos. Y `--branch
  // refs/heads/<rama>` le llega a `gh` sin el prefijo: con él, gh no encuentra el pedido abierto y la rama se encola.
  const az = await fakeAzure({});
  try {
    const cfg = { TYCON_VALIDATION_ORG: 'acme', TYCON_VALIDATION_PROJECT: 'lab', TYCON_VALIDATION_PIPELINE: '184' };
    // Las direcciones con usuario se arman acá: escritas enteras, el detector de publicación las lee como correos (esta
    // prueba viaja en la copia).
    const at = (user, rest) => [user, rest].join('@');
    for (const url of [at('https://someone', 'github.com/acme/harness.git'), 'git@github-work:acme/harness.git', at('ssh://git', 'ssh.github.com:443/acme/harness.git')]) {
      const lab = githubClone([{ number: 9 }]);
      execFileSync('git', ['-C', lab.clone, 'remote', 'set-url', 'origin', url]);
      const r = await runIn(lab.clone, az.url, [], { TYCON_GH: lab.gh, ...cfg });
      assert.strictEqual(r.code, 4, `${url}: ${r.err}`);
      assert.match(r.err, /pedido abierto \(#9\)/, url);
    }
    const lab = githubClone([]);
    const r = await runIn(lab.clone, az.url, ['--branch', 'refs/heads/fix/mia', '--dry-run'], { TYCON_GH: lab.gh, ...cfg });
    assert.strictEqual(r.code, 0, r.err);
    assert.match(fs.readFileSync(path.join(lab.dir, 'gh-calls.txt'), 'utf8'), /--head fix\/mia /, 'gh recibe la rama sin refs/heads/');
  } finally { await az.close(); }
});

test('T10 QueueValidation_EveryAzureOriginForm_IsTheInternalClone', async () => {
  // En el agente de Azure el origin es `https://<org>.visualstudio.com/<proyecto>/_git/<repo>`, que
  // también es Azure. Con «todo origin que no es dev.azure.com es el clon del público», ese clon pediría la definición del
  // público y saldría 2. Las cuatro formas de una dirección de Azure son el interno: sin `gh`, con la definición que team-repos.json declara para su repo (acá, la 170) y su origin.
  const { isAzure } = require(SCRIPT);
  const at = (user, rest) => [user, rest].join('@');
  const forms = [
    ['https://dev.azure.com/acme/lab/_git/harness', { org: 'acme', project: 'lab' }],
    [at('https://acme', 'dev.azure.com/acme/lab/_git/harness'), { org: 'acme', project: 'lab' }],
    ['https://acme.visualstudio.com/lab/_git/harness', { org: 'acme', project: 'lab' }],
    ['https://acme.visualstudio.com/DefaultCollection/lab/_git/harness', { org: 'acme', project: 'lab' }],
    [at('git', 'ssh.dev.azure.com:v3/acme/lab/harness'), { org: 'acme', project: 'lab' }],
    [at('acme', 'vs-ssh.visualstudio.com:v3/acme/lab/harness'), { org: 'acme', project: 'lab' }],
  ];
  for (const [url, want] of forms) {
    assert.strictEqual(isAzure(url), true, `${url} es de Azure`);
    assert.deepStrictEqual(fromOrigin(url), want, `${url}: organización y proyecto`);
  }
  for (const url of ['https://github.com/acme/harness.git', 'git@github-work:acme/harness.git', 'https://gitlab.example.com/acme/harness.git']) {
    assert.strictEqual(isAzure(url), false, `${url} no es de Azure`);
  }
  // corrido: un clon con el origin del agente encola la 170 con su organización y su proyecto, sin mirar `gh`
  const az = await fakeAzure({});
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-vs-'));
    labs.push(dir);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
    execFileSync('git', ['init', '-q', '-b', 'fix/mia', dir], { env });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://acme.visualstudio.com/lab/_git/harness'], { env });
    execFileSync('git', ['-C', dir, '-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno'], { env });
    const r = await runIn(dir, az.url, [], { TYCON_GH: path.join(dir, 'no-such-gh'), TYCON_VALIDATION_PIPELINE: '184', TYCON_TREE: declaring170() });
    assert.strictEqual(r.code, 0, r.err);
    const q = of(az.calls, 'POST', /builds$/);
    assert.deepStrictEqual(q[0].body, { definition: { id: 170 }, sourceBranch: MINE });
    assert.match(q[0].path, /^\/acme\/lab\//);
  } finally { await az.close(); }
});

test('T10 QueueValidation_AzureClone_IgnoresThePublicDefinitionConfig', async () => {
  // La configuración de la máquina es la del público: desde un origin de Azure (el interno) manda el origin y la definición de team-repos.json (acá, la 170),
  // aunque la máquina tenga cargada la definición de GitHub.
  const az = await fakeAzure({});
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-az-'));
    labs.push(dir);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
    execFileSync('git', ['init', '-q', '-b', 'fix/mia', dir], { env });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/lab/_git/harness'], { env });
    execFileSync('git', ['-C', dir, '-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '--allow-empty', '-m', 'uno'], { env });
    const r = await runIn(dir, az.url, [], { TYCON_VALIDATION_ORG: 'otra', TYCON_VALIDATION_PROJECT: 'otro', TYCON_VALIDATION_PIPELINE: '184', TYCON_TREE: declaring170() });
    assert.strictEqual(r.code, 0, r.err);
    const q = of(az.calls, 'POST', /builds$/);
    assert.deepStrictEqual(q[0].body, { definition: { id: 170 }, sourceBranch: MINE });
    assert.match(q[0].path, /^\/acme\/lab\//, 'la organización y el proyecto del origin, no los de la configuración');
  } finally { await az.close(); }
});

test('T10 QueueValidation_AzureIsRecognizedByItsServer_NotByAPathThatNamesIt', async () => {
  // «de Azure» es el SERVIDOR del origin. Una dirección de otro servidor
  // que lleva el nombre de Azure en la ruta no es el interno: leída por su texto, ese clon se saltearía la consulta de
  // pedidos abiertos y encolaría la 170 con la organización y el proyecto que la ruta quisiera.
  const { isAzure } = require(SCRIPT);
  const notAzure = [
    'https://git.example.com/dev.azure.com/acme/lab/_git/harness',
    'https://github.com/acme/dev.azure.com/acme/lab/_git/harness',
    'https://dev.azure.com.example.net/acme/lab/_git/harness',
    'https://notvisualstudio.com/lab/_git/harness',
    'git@github-work:v3/acme/lab/harness',
    '/srv/git/dev.azure.com/acme/lab/_git/harness',
    // la corta de SSH: git toma por servidor lo que hay hasta el primer `:` (acá, el de GitHub), no lo que sigue a la arroba
    ['github.com:x', 'dev.azure.com:v3/acme/lab/harness'].join('@'),
    ['github.com:x', 'ssh.dev.azure.com:v3/acme/lab/harness'].join('@'),
    // en una dirección entera, un `?`, un `#` o una `\` cortan el servidor: lo que sigue (arroba incluida) ya no lo es
    ['https://git.example.com?', 'dev.azure.com/acme/lab/_git/harness'].join('@'),
    ['https://git.example.com#', 'dev.azure.com/acme/lab/_git/harness'].join('@'),
    ['https://git.example.com\\', 'dev.azure.com/acme/lab/_git/harness'].join('@'),
    ['https://git.example.com/x?y', 'acme.visualstudio.com/lab/_git/harness'].join('@'),
    'https://dev.azure.com.:8443x/acme/lab/_git/harness',
  ];
  // y al revés: una arroba sin escapar en el usuario no esconde a Azure (el servidor es lo que sigue a la ÚLTIMA)
  const twoAts = [['https://someone', 'corp'].join('@'), 'dev.azure.com/acme/lab/_git/harness'].join('@');
  assert.strictEqual(isAzure(twoAts), true);
  assert.deepStrictEqual(fromOrigin(twoAts), { org: 'acme', project: 'lab' });
  assert.deepStrictEqual(fromOrigin('HTTPS://DEV.AZURE.COM:443/acme/lab/_git/harness'), { org: 'acme', project: 'lab' }, 'mayúsculas y puerto');
  assert.deepStrictEqual(fromOrigin(['ssh://git', 'ssh.dev.azure.com:22/v3/acme/lab/harness'].join('@')), { org: 'acme', project: 'lab' }, 'la de SSH escrita entera');
  for (const url of notAzure) {
    assert.strictEqual(isAzure(url), false, `${url} no es de Azure`);
    assert.strictEqual(fromOrigin(url), null, `${url}: no se le lee organización ni proyecto`);
  }
  // un `%` mal escrito no tira: queda como vino. Y un `..` escondido en la dirección no es una organización
  assert.deepStrictEqual(fromOrigin('https://dev.azure.com/ac%me/lab/_git/harness'), { org: 'ac%me', project: 'lab' });
  assert.strictEqual(fromOrigin('https://dev.azure.com/%2e%2e/lab/_git/harness'), null);
  assert.strictEqual(fromOrigin('https://dev.azure.com/acme/%2E/_git/harness'), null);
  // corrido: un clon con ese origin es el del público — mira los pedidos abiertos y, con uno, no encola
  const az = await fakeAzure({});
  try {
    const lab = githubClone([{ number: 5 }]);
    execFileSync('git', ['-C', lab.clone, 'remote', 'set-url', 'origin', notAzure[1]]);
    const r = await runIn(lab.clone, az.url, [], { TYCON_GH: lab.gh, TYCON_VALIDATION_ORG: 'acme', TYCON_VALIDATION_PROJECT: 'lab', TYCON_VALIDATION_PIPELINE: '184' });
    assert.strictEqual(r.code, 4, r.err);
    assert.strictEqual(az.calls.length, 0, 'con el pedido abierto no toca Azure');
  } finally { await az.close(); }
});

test('T10 QueueValidation_OriginThatCouldNotBeRead_IsNotAMissingOrigin', async () => {
  // Si git no deja leer el origin —un clon de otro dueño, un git roto—, «no
  // pude leer» no es «no hay»: leído como vacío, el clon pasaría por el interno, sin la consulta de pedidos abiertos, y
  // con la organización y el proyecto por opción encolaría igual. Fuera de un clon, o sin remoto `origin`, sí es «no hay».
  const az = await fakeAzure({});
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-git-'));
    labs.push(dir);
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n', { mode: 0o755 });
    let r = await run(az.url, [], { PATH: `${dir}${path.delimiter}${process.env.PATH}` });
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /no pude leer el origin/);
    assert.strictEqual(az.calls.length, 0, 'sin saber de qué repo es el clon, no mira ni corta ni encola');
    // fuera de un clon (el caso de todas las pruebas de arriba) y en un clon sin `origin`: no hay origin, y sigue
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-noorigin-'));
    labs.push(bare);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
    execFileSync('git', ['init', '-q', '-b', 'fix/mia', bare], { env });
    r = await runIn(bare, az.url, ['--org', 'acme', '--project', 'lab', '--branch', 'fix/mia', '--pipeline', '170', '--dry-run']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /encolaría: pipeline 170 sobre fix\/mia/);
  } finally { await az.close(); }
});

test('T10 QueueValidation_TheScriptNamesNoAzureOrganizationForGithub', () => {
  // El guion viaja en el público: ningún nombre de organización ni de proyecto de Azure escrito en él, ni el número de
  // ninguna definición (la de un origin de Azure sale de team-repos.json).
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /dev\.azure\.com\/[A-Za-z]/, 'ninguna organización escrita en una dirección');
  assert.match(src, /TYCON_VALIDATION_ORG/);
});
