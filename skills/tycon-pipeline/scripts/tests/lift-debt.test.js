#!/usr/bin/env node
'use strict';
// lift-debt.test.js — una deuda que se pagó antes del commit se levanta con `marker.js lift-debt --debt <DEF-id>`: el
// marcador pierde el cierre en deuda y cada rojo esperado vuelve a ser el rojo que dejaría `run-check`, así que
// «Preparar» vuelve a pedir todo en verde y el commit no lleva la línea «Deuda:». No pide firma: no afloja nada.
//
//   T4  saca el cierre y los rojos esperados, conserva la hora de la constancia usada, lo anota y lo dice
//   T5  con otro id, o sin deuda, sale 2 y no toca nada
//   T6  levantada la deuda, «Preparar» frena por el rojo y no lleva «Deuda:»; un rojo esperado sin deuda también frena
//
// Corre los comandos reales con un HOME temporal y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/lift-debt.test.js < /dev/null

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function entorno(sid) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-debt-'));
  tmpDirs.push(base);
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-deuda.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "deuda"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '',
    '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', '',
    '- Deuda: DEF-9.9-acme — la librería no tenía versión compatible', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '',
  };
  delete env.NODE_TEST_CONTEXT;
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: repo });
  const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = () => path.join(dir(), 'active', `${sid}.json`);
  const leer = () => JSON.parse(fs.readFileSync(activo(), 'utf8'));
  const escribir = (m) => fs.writeFileSync(activo(), JSON.stringify(m));
  const gates = () => {
    try { return fs.readFileSync(path.join(dir(), 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { correr, leer, escribir, activo, gates };
}

const DEUDA = { estado: 'deuda', motivo: 'la librería no tenía versión compatible', deuda: 'DEF-9.9-acme', via: 'persona', at: '2026-11-10T20:00:00Z' };
const ROJO_ESPERADO = {
  acmatrix: { tests: ['T1'], deuda: 'DEF-9.9-acme', at: '2026-11-10T20:05:00Z', until: '2026-11-20', via: 'persona', constanciaTs: '2026-11-10T20:04:00Z' },
  tests: { tests: ['T1'], deuda: 'DEF-9.9-acme', at: '2026-11-10T20:06:00Z' },
};
// una ejecución en deuda con dos rojos esperados: la matriz (con lista, vencimiento y constancia) y las pruebas
function enDeuda(E) {
  E.escribir({ ...E.leer(), cierre: DEUDA, checks: { acmatrix: 'rojo-esperado:exit=1', tests: 'rojo-esperado:exit=3', build: 'green' }, expectedRed: ROJO_ESPERADO });
}
const levantar = (E, id = 'DEF-9.9-acme') => E.correr('marker.js', ['lift-debt', '--debt', id]);

test('T4 LiftDebt_ClearsClosureAndExpectedRed @story-8.277 @ac-4 — saca el cierre y deja cada control en el rojo de su exit', () => {
  const E = entorno('s-lift-t4');
  enDeuda(E);
  const r = levantar(E);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const m = E.leer();
  assert.strictEqual(m.cierre, undefined, 'sin cierre en deuda');
  assert.strictEqual(m.checks.acmatrix, 'red:exit=1');
  assert.strictEqual(m.checks.tests, 'red:exit=3');
  assert.strictEqual(m.checks.build, 'green', 'lo verde no se toca');
  // de la matriz queda sólo la hora de la constancia ya usada: la firma no vuelve a valer
  assert.deepStrictEqual(m.expectedRed.acmatrix, { constanciaTs: '2026-11-10T20:04:00Z' });
  assert.strictEqual(m.expectedRed.tests, undefined, 'sin lista ni vencimiento');
  const g = E.gates().filter((l) => l.name === 'lift-debt');
  assert.strictEqual(g.length, 1, JSON.stringify(E.gates()));
  assert.strictEqual(g[0].deuda, 'DEF-9.9-acme');
  assert.deepStrictEqual(g[0].checks.sort(), ['acmatrix', 'tests']);
  assert.match(r.stdout, /Preparar.*verde/);
});

test('T5 LiftDebt_WrongIdOrNoDebt_Exit2 @story-8.277 @ac-5 — otro id, o sin deuda: sale 2 con el motivo y no toca nada', () => {
  const E = entorno('s-lift-t5');
  enDeuda(E);
  const antes = fs.readFileSync(E.activo(), 'utf8');
  let r = levantar(E, 'DEF-9.9-otra');
  assert.strictEqual(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /DEF-9\.9-acme/, 'dice cuál es la deuda del cierre');
  assert.strictEqual(fs.readFileSync(E.activo(), 'utf8'), antes, 'el marcador igual');
  E.escribir({ ...E.leer(), cierre: undefined });
  const sinDeuda = fs.readFileSync(E.activo(), 'utf8');
  r = levantar(E);
  assert.strictEqual(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /no está en deuda/);
  assert.strictEqual(fs.readFileSync(E.activo(), 'utf8'), sinDeuda, 'el marcador igual');
  assert.strictEqual(E.gates().filter((l) => l.name === 'lift-debt').length, 0, 'nada anotado');
});

test('T6 LiftDebt_PrepareAsksGreenAgain @story-8.277 @ac-6 @ac-19 — levantada la deuda, «Preparar» frena por el rojo y no lleva «Deuda:»', () => {
  const E = entorno('s-lift-t6');
  enDeuda(E);
  assert.strictEqual(levantar(E).status, 0);
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /red:exit=\d sin una ejecución en deuda/);
  assert.doesNotMatch(r.stderr, /Deuda:/);
});

test('T6 ExpectedRedWithoutDebt_StillBlocks @story-8.277 @ac-19 — un rojo esperado puesto sin la deuda sigue frenando «Preparar»', () => {
  const E = entorno('s-lift-t6b');
  E.escribir({ ...E.leer(), checks: { tests: 'rojo-esperado:exit=1' }, expectedRed: { tests: { tests: ['T1'] } } });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /rojo-esperado.*sin una ejecución en deuda/);
});
