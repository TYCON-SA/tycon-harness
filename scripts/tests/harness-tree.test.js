'use strict';
// harness-tree.test.js — la huella del código que mide un pipeline de operaciones y su guarda (story 8.30, T6 y T7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'harness-tree.js');

function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|HARNESS_)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'harness-tree-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', ...extra };
}
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tree-'));
  dirs.push(d);
  git(d, ['init', '--quiet', '-b', 'main']);
  write(d, { 'scripts/a.js': 'module.exports = 1;\n', 'README.md': 'el arnés de juguete\n', '.dashboard/x.json': '{}\n' });
  commit(d, 'base');
  return d;
}
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
function commit(dir, msg) { git(dir, ['add', '-A', '-f']); git(dir, ['commit', '--quiet', '-m', msg]); }
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: cleanEnv(env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const hashOf = (d) => { const r = run(['--tree', '--repo', d]); assert.strictEqual(r.code, 0, r.err); return r.out.split('@')[0]; };

test('T6 HarnessTree_DataDoesNotMoveTheHash: tocar una carpeta de datos no mueve la huella; tocar código, sí', () => {
  const d = repo();
  const first = run(['--tree', '--repo', d]);
  assert.strictEqual(first.code, 0, first.err);
  assert.match(first.out, /^[0-9a-f]{64}@[0-9a-f]{40}$/);
  const base = first.out.split('@')[0];
  for (const rel of ['.dashboard/y.json', 'inbox/q/pending/a.yaml', 'artifacts/page.html', '.engram/chunks/a.jsonl', '.advisors/run/x.json', 'scripts/controls-bench/ultimo-banco.json']) {
    write(d, { [rel]: `${rel}\n` });
    commit(d, `dato ${rel}`);
    assert.strictEqual(hashOf(d), base, `${rel} es dato: la huella no cambia`);
  }
  write(d, { 'scripts/a.js': 'module.exports = 2;\n' });
  commit(d, 'código');
  assert.notStrictEqual(hashOf(d), base, 'con un archivo de código cambiado, la huella es otra');
});

test('T7 HarnessTree_CheckTree_Red: el checkout movido sale 1 nombrando lo que cambió; sin huella, 2; con el disco sucio y --worktree, 1', () => {
  const d = repo();
  const tree = run(['--tree', '--repo', d]).out;
  let r = run(['--check-tree', '--repo', d], { HARNESS_TREE: tree });
  assert.strictEqual(r.code, 0, r.err);
  // un dato nuevo, commiteado (lo que hace guardar): sigue en verde
  write(d, { 'inbox/q/b.yaml': 'id: b\n' });
  commit(d, 'dato');
  r = run(['--check-tree', '--repo', d], { HARNESS_TREE: tree });
  assert.strictEqual(r.code, 0, r.err);
  // sin la huella, o con otra forma: 2
  for (const v of [undefined, 'otra-cosa', '##vso[task.complete result=Succeeded;]']) {
    r = run(['--check-tree', '--repo', d], v === undefined ? {} : { HARNESS_TREE: v });
    assert.strictEqual(r.code, 2, `${v}: ${r.err}`);
    assert.doesNotMatch(r.err, /##vso\[/i, 'lo que vino no puede leerse como una orden de Azure');
  }
  // el disco sucio con --worktree: 1; sin --worktree: 0
  write(d, { 'scripts/a.js': 'module.exports = 3;\n' });
  r = run(['--check-tree', '--worktree', '--repo', d], { HARNESS_TREE: tree });
  assert.strictEqual(r.code, 1, r.err);
  assert.match(r.err, /scripts\/a\.js/);
  assert.strictEqual(run(['--check-tree', '--repo', d], { HARNESS_TREE: tree }).code, 0, 'sin --worktree el disco no se mira');
  // el checkout movido a otro código: 1, nombrando el archivo
  commit(d, 'otro código');
  r = run(['--check-tree', '--repo', d], { HARNESS_TREE: tree });
  assert.strictEqual(r.code, 1, r.err);
  assert.match(r.err, /scripts\/a\.js/);
  assert.match(r.err, /movió el checkout/);
});

test('T7 HarnessTree_Usage: sin modo, sin --repo, o con --worktree en --tree, sale 2 y explica el uso', () => {
  for (const args of [[], ['--tree'], ['--repo', '.'], ['--tree', '--worktree', '--repo', '.'], ['--tree', '--check-tree', '--repo', '.'], ['--bogus']]) {
    const r = run(args);
    assert.strictEqual(r.code, 2, `${JSON.stringify(args)}: ${r.err}`);
  }
});
