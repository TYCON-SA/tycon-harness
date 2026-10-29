#!/usr/bin/env node
'use strict';
// private-inventory.test.js — al commitear en el público, el inventario de los controles se compara con el pre-commit del
// repo privado (scripts/lib/private-inventory.js, regla 4 de scripts/ci/check-staged-ci-rules.js).
// stable-data: los commits de la prueba fijan sus fechas y apagan el mantenimiento.
//
// Lo que no se puede perder:
//   · un control del inventario que el pre-commit propio del privado no corre se nombra, el mismo día;
//   · el pre-commit del privado sale de su `origin/main` y de su lista de copias propias, no del disco;
//   · sin clon declarado no dice nada; un clon declarado que no se lee es «no pude mirar», nunca «cuadra»;
//   · en el privado (sin inventario en el índice) no aplica;
//   · en el commit avisa y no frena, y sólo corre si el commit toca el inventario o el pre-commit;
//   · no deja nada en las ramas ni en el índice de ninguno de los dos repos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const PI = require(path.join(RAIZ, 'scripts', 'lib', 'private-inventory.js'));
const FRENO = path.join(RAIZ, 'scripts', 'ci', 'check-staged-ci-rules.js');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
delete ENV.GIT_DIR; delete ENV.GIT_INDEX_FILE; delete ENV.GIT_WORK_TREE;

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); LABS.push(d); return d; }
function put(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

const HOOK_CON = '#!/usr/bin/env bash\nnode "$REPO_ROOT/scripts/ci/toy.js"\n';
const HOOK_SIN = '#!/usr/bin/env bash\necho nada\n';
const INVENTARIO = JSON.stringify({
  hook: '.githooks/pre-commit-checks',
  passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }],
  controls: [{ name: 'toy', script: 'scripts/ci/toy.js', rules: [] }],
  content: [], workflows: [], approvals: [],
}, null, 2);

/** El público de juguete: el guion real de la comparación, un inventario con un control y su pre-commit que lo llama. */
function publico() {
  const d = tmpdir('pinv-pub-');
  git(d, 'init', '-q');
  put(d, 'scripts/ci/run-base-controls.sh', fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh'), 'utf8'));
  put(d, 'scripts/ci/toy.js', "'use strict';\nprocess.exit(0);\n");
  put(d, '.githooks/pre-commit-checks', HOOK_CON);
  put(d, PI.INVENTORY, INVENTARIO);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'base');
  return d;
}
/** El privado de juguete: su pre-commit propio declarado en `own`, en `origin/main` (y otro distinto en el disco). */
function privado(hook, { propio = true } = {}) {
  const origen = tmpdir('pinv-origen-');
  git(origen, 'init', '-q');
  put(origen, '.githooks/pre-commit-checks', hook);
  put(origen, '.tycon/internal-forms.json', JSON.stringify({ layout: 'thin', own: propio ? { '.githooks/pre-commit-checks': 'el suyo' } : {}, mirror: {} }));
  git(origen, 'add', '-A');
  git(origen, 'commit', '-q', '-m', 'privado');
  const d = path.join(tmpdir('pinv-priv-'), 'clon');
  const r = spawnSync('git', ['clone', '-q', origen, d], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return d;
}
/** Una casa del arnés que declara el clon privado (o no declara nada). */
function casa(clon) {
  const d = tmpdir('pinv-casa-');
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(clon === undefined ? {} : { paths: { maintainers: clon } }));
  return { ...ENV, TYCON_HOME: d };
}

test('PrivateInventory_Toca — corre sólo si el commit toca el inventario o el pre-commit', () => {
  assert.strictEqual(PI.toca(['scripts/ci/controls-from-base.json']), true);
  assert.strictEqual(PI.toca(['guides/x.md', '.githooks/pre-commit-checks']), true);
  assert.strictEqual(PI.toca(['scripts/ci/toy.js', '.githooks/pre-commit']), false);
});

test('PrivateInventory_PrivateRunsTheControl_Cuadra — el privado corre el control: cuadra, y no deja ramas ni índice tocados', () => {
  const pub = publico();
  const clon = privado(HOOK_CON);
  const antes = { ramas: git(pub, 'for-each-ref'), indice: git(pub, 'ls-files', '-s'), privado: git(clon, 'status', '--porcelain') };
  const r = PI.comparar({ repo: pub, privado: clon });
  assert.strictEqual(r.estado, 'cuadra', JSON.stringify(r));
  assert.strictEqual(r.fecha, '2026-01-01');
  assert.strictEqual(PI.aviso(r), null);
  assert.deepStrictEqual({ ramas: git(pub, 'for-each-ref'), indice: git(pub, 'ls-files', '-s'), privado: git(clon, 'status', '--porcelain') }, antes);
});

test('PrivateInventory_PrivateLacksTheControl_Named — un control que el privado no corre se nombra, con qué hacer', () => {
  const pub = publico();
  const clon = privado(HOOK_SIN);
  const r = PI.comparar({ repo: pub, privado: clon });
  assert.strictEqual(r.estado, 'no-cuadra', JSON.stringify(r));
  assert.ok(r.problemas.some((p) => p.includes('scripts/ci/toy.js')), r.problemas.join('\n'));
  const msg = PI.aviso(r);
  assert.match(msg, /no cuadra con el pre-commit del privado \(origin\/main del 2026-01-01\)/);
  assert.match(msg, /scripts\/ci\/toy\.js/);
  assert.match(msg, /pedido al privado/);
});

test('PrivateInventory_ReadsOriginMain_NotTheDisk — el pre-commit del privado sale de origin/main, no del disco', () => {
  const pub = publico();
  const clon = privado(HOOK_SIN);
  put(clon, '.githooks/pre-commit-checks', HOOK_CON);
  assert.strictEqual(PI.comparar({ repo: pub, privado: clon }).estado, 'no-cuadra');
});

test('PrivateInventory_NotOwn_UsesPublicHook — si el privado no declara su pre-commit como propio, vale el del público', () => {
  const pub = publico();
  const clon = privado(HOOK_SIN, { propio: false });
  assert.strictEqual(PI.comparar({ repo: pub, privado: clon }).estado, 'cuadra');
});

test('PrivateInventory_StagedInventory_IsWhatCounts — cuenta el inventario del índice, no el del último commit', () => {
  const pub = publico();
  const clon = privado(HOOK_CON);
  const inv = JSON.parse(INVENTARIO);
  inv.controls.push({ name: 'nuevo', script: 'scripts/ci/nuevo.js', rules: [] });
  put(pub, PI.INVENTORY, JSON.stringify(inv, null, 2));
  put(pub, 'scripts/ci/nuevo.js', "'use strict';\n");
  put(pub, '.githooks/pre-commit-checks', `${HOOK_CON}node "$REPO_ROOT/scripts/ci/nuevo.js"\n`);
  git(pub, 'add', '-A');
  const r = PI.comparar({ repo: pub, privado: clon });
  assert.strictEqual(r.estado, 'no-cuadra', JSON.stringify(r));
  assert.ok(r.problemas.some((p) => p.includes('scripts/ci/nuevo.js')), r.problemas.join('\n'));
});

test('PrivateInventory_MachineDeclaration — sin clon declarado no dice nada; uno que no está es «no pude mirar»', () => {
  const pub = publico();
  const sin = PI.comparar({ repo: pub, env: casa(undefined) });
  assert.strictEqual(sin.estado, 'sin-clon');
  assert.strictEqual(PI.aviso(sin), null);
  const roto = PI.comparar({ repo: pub, env: casa(path.join(os.tmpdir(), 'no-esta-este-clon-privado')) });
  assert.strictEqual(roto.estado, 'no-pude', JSON.stringify(roto));
  assert.match(PI.aviso(roto), /no pude mirar/);
  const declarado = PI.comparar({ repo: pub, env: casa(privado(HOOK_SIN)) });
  assert.strictEqual(declarado.estado, 'no-cuadra', JSON.stringify(declarado));
});

test('PrivateInventory_MissingRef_NotRunNeverGreen — una ref que el clon no tiene es «no pude mirar»', () => {
  const r = PI.comparar({ repo: publico(), privado: privado(HOOK_CON), ref: 'origin/no-existe' });
  assert.strictEqual(r.estado, 'no-pude');
  assert.match(r.motivo, /origin\/no-existe no está en el clon privado/);
});

test('PrivateInventory_InThePrivateRepo_NotApplicable — en un repo sin inventario en el índice no aplica', () => {
  const clon = privado(HOOK_SIN);
  assert.strictEqual(PI.comparar({ repo: clon, privado: clon }).estado, 'no-aplica');
});

test('PrivateInventory_PreCommit_WarnsAndPasses — en el commit avisa y no frena; sin tocar el inventario, ni corre', () => {
  const pub = publico();
  const env = casa(privado(HOOK_SIN));
  put(pub, 'guides/una.md', 'texto\n');
  git(pub, 'add', '-A');
  let r = spawnSync(process.execPath, [FRENO, '--repo', pub], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /inventario/);
  put(pub, '.githooks/pre-commit-checks', `${HOOK_CON}# otra línea\n`);
  git(pub, 'add', '-A');
  r = spawnSync(process.execPath, [FRENO, '--repo', pub], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /no cuadra con el pre-commit del privado[\s\S]*scripts\/ci\/toy\.js/);
});
