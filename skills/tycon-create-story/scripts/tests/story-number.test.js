'use strict';

/**
 * story-number.test.js — el número de una historia nueva no repite el de otra sesión.
 *
 * Lo que no se puede perder:
 *   - El número sale de `main`, de las ramas remotas y de los worktrees de la máquina, también lo no commiteado.
 *   - Una rama que nombra un número sin historia, o ramas que no se pudieron traer, son duda: sale 3 y no se asigna.
 *   - Sólo cuentan los números de la épica pedida.
 *
 * Todo corre en repos de juguete en una carpeta temporal: nunca toca el árbol ni la casa de quien la corre.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUION = path.resolve(__dirname, '..', 'story-number.js');
const lib = require(GUION);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `numero-${p}-`));

function entorno() {
  const home = tmp('home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@example.invalid',
    GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  for (const k of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return env;
}
const ENV = entorno();

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function escribir(raiz, rel, texto = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
  fs.writeFileSync(path.join(raiz, rel), texto);
}

// un remoto con main (8.1 y 8.2) y un clon de él
function repos() {
  const base = tmp('repos');
  const remoto = path.join(base, 'remoto.git');
  const semilla = path.join(base, 'semilla');
  git(base, 'init', '-q', '--bare', '-b', 'main', remoto);
  git(base, 'init', '-q', '-b', 'main', semilla);
  escribir(semilla, 'specs/story-8.1-uno.md');
  escribir(semilla, 'specs/story-8.2-dos.md');
  escribir(semilla, 'specs/sprint-status.yaml', 'development_status:\n  8-1-uno: done\n  8-2-dos: draft\n  7-40-otra: done\n');
  git(semilla, 'add', '-A');
  git(semilla, 'commit', '-q', '-m', 'inicio');
  git(semilla, 'remote', 'add', 'origin', remoto);
  git(semilla, 'push', '-q', 'origin', 'main');
  const clon = path.join(base, 'clon');
  git(base, 'clone', '-q', remoto, clon);
  return { base, remoto, semilla, clon };
}

function correr(repo, ...extra) {
  const r = spawnSync(process.execPath, [GUION, 'next', '--repo', repo, '--epic', '8', ...extra], { env: ENV, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* sin JSON */ }
  return { status: r.status, json, stderr: r.stderr };
}

test('NumeroDeMain_ElSiguiente', () => {
  const { clon } = repos();
  const r = correr(clon);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.next, '8.3');
  assert.deepStrictEqual(r.json.doubts, []);
});

test('RamaRemotaConHistoria_CuentaAunqueNoEsteEnMain', () => {
  const { semilla, clon } = repos();
  git(semilla, 'checkout', '-q', '-b', 'story/cola');
  escribir(semilla, 'specs/story-8.7-cola.md');
  git(semilla, 'add', '-A');
  git(semilla, 'commit', '-q', '-m', 'cola');
  git(semilla, 'push', '-q', 'origin', 'story/cola');
  const r = correr(clon);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.next, '8.8');
});

test('WorktreeSinCommitear_Cuenta', () => {
  const { base, clon } = repos();
  const otro = path.join(base, 'otro-worktree');
  git(clon, 'worktree', 'add', '-q', '-b', 'story/otra', otro);
  escribir(otro, 'specs/story-8.5-sin-empujar.md');
  const r = correr(clon, '--no-fetch');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.next, '8.6');
  assert.ok(r.json.used.some((u) => u.n === 5 && [otro, fs.realpathSync(otro)].includes(u.where)), JSON.stringify(r.json.used));
});

test('RenglonDeSprintStatusEnUnWorktree_Cuenta', () => {
  const { base, clon } = repos();
  const otro = path.join(base, 'otro');
  git(clon, 'worktree', 'add', '-q', '-b', 'story/renglon', otro);
  escribir(otro, 'specs/sprint-status.yaml', 'development_status:\n  8-1-uno: done\n  8-9-reservada: draft\n');
  const r = correr(clon, '--no-fetch');
  assert.strictEqual(r.json.next, '8.10');
});

test('RamaQueNombraUnNumeroSinHistoria_EsDuda', () => {
  const { semilla, clon } = repos();
  git(semilla, 'checkout', '-q', '-b', 'docs/historia-8.4-borrador');
  git(semilla, 'push', '-q', 'origin', 'docs/historia-8.4-borrador');
  const r = correr(clon);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.json.next, '8.5');
  assert.ok(r.json.doubts.some((d) => d.includes('8.4')), JSON.stringify(r.json.doubts));
});

test('SinPoderTraerLasRamas_EsDuda', () => {
  const { clon } = repos();
  git(clon, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-existe-este-remoto.git'));
  const r = correr(clon);
  assert.strictEqual(r.status, 3);
  assert.ok(r.json.doubts.some((d) => d.includes('no pude traer')));
});

test('OtraEpica_NoCuenta', () => {
  assert.strictEqual(lib.numberOfFile('story-7.40-otra.md', 8), null);
  assert.strictEqual(lib.numberOfFile('story-8.40-esta.md', 8), 40);
  assert.strictEqual(lib.numberOfFile('8-41-bmad.md', 8), 41);
  assert.strictEqual(lib.numberOfFile('story-18.3-otra.md', 8), null);
  assert.deepStrictEqual(lib.numbersOfBranch('story/18.3-x', 8), []);
  assert.deepStrictEqual(lib.numbersOfBranch('story/8.153-cola', 8), [153]);
  assert.deepStrictEqual(lib.numbersOfSprintStatus('  7-40-x: done\n  8-12-y: draft\n', 8), [12]);
});

test('LlamadaMal_Sale2', () => {
  const r = spawnSync(process.execPath, [GUION, 'next', '--repo', os.tmpdir()], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

test('Workflow_LlamaAlGuionYPreguntaConDuda', () => {
  const wf = fs.readFileSync(path.resolve(__dirname, '..', '..', 'workflow.md'), 'utf8');
  assert.match(wf, /scripts\/story-number\.js next/);
  assert.match(wf, /sale 3/);
});
