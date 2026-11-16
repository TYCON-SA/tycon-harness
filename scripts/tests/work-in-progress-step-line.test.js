#!/usr/bin/env node
'use strict';
// work-in-progress-step-line.test.js — la columna Estado de /wip trae el renglón del paso (el ● del paso en curso, o el ✗
// del último cerrado), sacado de run-lines.js. La fila guarda `state` como siempre; el renglón va en `stepLine`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildWip, jsonOf } = require(path.join(__dirname, '..', 'tools', 'work-in-progress.js'));

const NOW = '2026-11-16T12:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const TODOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'];

function maquina() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-step-line-'));
  const state = path.join(root, 'state');
  const sessions = path.join(root, 'sessions');
  const home = path.join(root, 'home');
  for (const d of [path.join(state, 'active'), path.join(state, 'timing-history'), sessions, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  return { root, state, sessions, home };
}
function corrida(m, sid, id, fields) {
  const story = path.join(m.root, `story-${id}.md`);
  fs.writeFileSync(story, `---\nstory: "${id}"\ntitle: "historia ${id}"\n---\n# Story\n`);
  fs.writeFileSync(path.join(m.state, 'active', `${sid}.json`), JSON.stringify({
    sessionId: sid, storyId: id, storyPath: story, repoPath: m.root, stepScheme: 2, startedAt: at(90), lastTouch: at(1), iterations: {}, checks: {}, ...fields,
  }));
  fs.writeFileSync(path.join(m.sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: `sesion-${id}`, status: 'busy', statusUpdatedAt: Date.parse(NOW) }));
}

test('WP1 Wip_StateColumn_HasStepLine @story-8.293 @ac-7', () => {
  const m = maquina();
  // una en curso: Implementar, empezado hace 20 min
  corrida(m, 'curso-1', '9.1', { stepsCompleted: TODOS.slice(0, 4), stepsPending: TODOS.slice(4), stepTimings: { implement: { startedAt: at(20) } } });
  // otra con el último cerrado en rojo: Correr las pruebas cerrado con el portón en rojo, Revisores sin empezar
  corrida(m, 'rojo-1', '9.2', { stepsCompleted: TODOS.slice(0, 6), stepsPending: TODOS.slice(6), checks: { tests: 'red:exit=1' } });
  const w = buildWip({ home: m.home, stateDir: m.state, sessionsDir: m.sessions, now: NOW });
  const fila = (id) => w.extra.findIndex((x) => x.storyId === id);
  const a = fila('9.1');
  const b = fila('9.2');
  assert.ok(a >= 0 && b >= 0, JSON.stringify(w.rows));
  assert.strictEqual(w.extra[a].stepLine, `● Implementar — en curso desde las ${hhmm(at(20))}`);
  assert.strictEqual(w.extra[b].stepLine, '✗ Correr las pruebas — sin motivo registrado');
  // las otras columnas, iguales: `state` sigue con el nombre del paso y la fila con sus cinco campos
  assert.strictEqual(w.rows[a].state, 'Implementar');
  assert.deepStrictEqual(Object.keys(w.rows[a]).sort(), ['end', 'folder', 'session', 'state', 'work']);
  // la tabla muestra el renglón en Estado; el JSON lo trae en la fila
  assert.ok(w.text.split('\n').some((l) => l.includes('| ● Implementar — en curso desde las ')), w.text);
  assert.ok(w.text.split('\n').some((l) => l.includes('| ✗ Correr las pruebas — sin motivo registrado')), w.text);
  assert.strictEqual(jsonOf(w).rows[a].stepLine, w.extra[a].stepLine);
});
