'use strict';
// pipeline-status-pending.test.js — al cerrar una tanda, sus pendientes pasan a lo hecho.
//
// Una tanda en `done` no puede seguir declarando criterios, tareas o pruebas pendientes (story-format.md §1.1: esas listas
// valen en `blocked` o `pending`), y el control de historias frena el commit que la deja así. El cierre de una tanda
// (`marker.js update-pipeline-status <tanda> done`) dejaba las listas como estaban: pasaba la tanda a `done` y el commit
// de cierre quedaba frenado. Ahora pasa los números a `acs` / `tasks` / `tests` (los suma a los que ya estaban) y vacía
// los pendientes. Un pendiente escrito como lista de renglones no se toca, y se dice.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/pipeline-status-pending.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { fakeHomeEnv } = require(path.join(__dirname, 'lib', 'fake-home.js'));

const MARKER = path.join(__dirname, '..', 'marker.js');
const env = (home) => ({ env: { ...process.env, ...fakeHomeEnv(home), CLAUDE_CODE_SESSION_ID: 'pipes-pend' }, encoding: 'utf8' });
const lab = (lines) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pipes-pend-'));
  const story = path.join(home, 'story-lab.md');
  fs.writeFileSync(story, `${['---', 'story: "9.99"', 'status: review', 'pipelines:', ...lines, '---', '', '# cuerpo', ''].join('\n')}`);
  return { home, story };
};
const fm = (story) => fs.readFileSync(story, 'utf8').split('\n---\n')[0];

test('T1 PipelineStatusDone_MovesPendingToDone: los pendientes de la tanda pasan a acs, tasks y tests', () => {
  const { home, story } = lab(['  - name: A-medir', '    status: in-progress', '    acs: [1, 2]', '    acs_pending: [3, 4]  # quedan',
    '    tasks_pending: [2]', '    tests_pending: ["T5", "T6"]', '  - name: B-otra', '    status: blocked', '    acs_pending: [7]']);
  const out = execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A-medir', 'done'], env(home));
  const f = fm(story);
  assert.match(f, /- name: A-medir\n {4}status: done\n {4}acs: \[1, 2, 3, 4\]\n {4}tasks: \[2\]\n {4}tests: \["T5", "T6"\]\n {2}- name: B-otra/, f);
  assert.match(f, /- name: B-otra\n {4}status: blocked\n {4}acs_pending: \[7\]/, 'la otra tanda no se toca');
  assert.doesNotMatch(f.split('- name: B-otra')[0], /_pending/);
  assert.match(out, /A-medir: done \(pasan a hechos: acs 3, 4 · tasks 2 · tests T5, T6\)/);
  assert.ok(fs.readFileSync(story, 'utf8').endsWith('\n# cuerpo\n'), 'el cuerpo no se toca');
});

test('T2 PipelineStatusDone_NoDuplicates: un número que ya estaba hecho no se repite', () => {
  const { story, home } = lab(['  - name: A', '    status: in-progress', '    acs: [1, 3]', '    acs_pending: [3, 4]']);
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'done'], env(home));
  assert.match(fm(story), /acs: \[1, 3, 4\]/);
});

test('T3 PipelineStatusOther_KeepsPending: pasar a otro estado no mueve nada', () => {
  const { story, home } = lab(['  - name: A', '    status: pending', '    acs_pending: [3]']);
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'blocked'], env(home));
  assert.match(fm(story), /status: blocked\n {4}acs_pending: \[3\]/);
});

test('T4 PipelineStatusDone_BlockListPending_SaysIt: una lista de renglones no se toca, y se dice', () => {
  const { story, home } = lab(['  - name: A', '    status: pending', '    tasks_pending:', '      - 3']);
  const r = spawnSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'done'], env(home));
  assert.match(fm(story), /status: done\n {4}tasks_pending:\n {6}- 3/);
  assert.match(`${r.stdout}${r.stderr}`, /tasks_pending.*a mano/);
});

test('T5 PipelineStatusDone_KeepsNonIntegerIds: un id como "2b" o "S" pasa tal cual, y los que ya estaban no se pierden', () => {
  const { story, home } = lab(['  - name: A', '    status: blocked', '    acs: [1, "1b"]', '    acs_pending: [2, "2b"]', '    tasks_pending: ["S", 0]']);
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'done'], env(home));
  const f = fm(story);
  assert.match(f, /acs: \[1, "1b", 2, "2b"\]/, f);
  assert.match(f, /tasks: \["S", 0\]/, f);
});

test('T6 PipelineStatusDone_StaysInItsBatch: sacar renglones no hace entrar la búsqueda en la tanda de abajo', () => {
  const { story, home } = lab(['  - name: A', '    status: in-progress', '    acs: [1]', '    acs_pending: [2]', '    tasks: [1]', '    tasks_pending: [2]',
    '    tests: ["T1"]', '  - name: B', '    tests_pending: ["T9"]', '    status: blocked']);
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'done'], env(home));
  const f = fm(story);
  assert.match(f, /- name: B\n {4}tests_pending: \["T9"\]/, f);
  assert.match(f, /tests: \["T1"\]\n {2}- name: B/, f);
});

test('T7 PipelineStatusDone_OddShapes_LeftForAHuman: una base que no es lista, o una lista partida, se dicen y no se tocan', () => {
  const a = lab(['  - name: A', '    status: in-progress', '    acs: 2', '    acs_pending: [3]']);
  const r = spawnSync(process.execPath, [MARKER, 'update-pipeline-status', a.story, 'A', 'done'], env(a.home));
  assert.match(fm(a.story), /acs: 2\n {4}acs_pending: \[3\]/);
  assert.match(`${r.stdout}${r.stderr}`, /acs_pending.*a mano/);
  const b = lab(['  - name: A', '    status: in-progress', '    acs_pending: [', '      2, 3]']);
  spawnSync(process.execPath, [MARKER, 'update-pipeline-status', b.story, 'A', 'done'], env(b.home));
  assert.match(fm(b.story), /acs_pending: \[\n {6}2, 3\]/);
});

test('T8 PipelineStatusDone_EmptyPending_Removed: un pendiente vacío (null, ~, []) se saca', () => {
  const { story, home } = lab(['  - name: A', '    status: in-progress', '    acs: [1]', '    acs_pending: null', '    tests_pending: []']);
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A', 'done'], env(home));
  assert.doesNotMatch(fm(story), /_pending/);
});
