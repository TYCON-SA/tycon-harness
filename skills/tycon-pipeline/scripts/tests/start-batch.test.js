#!/usr/bin/env node
'use strict';
// start-batch.test.js — el arranque de una historia paraguas con su tanda: `pipeline.js start --batch <tanda>`.
//
// Caso: en una paraguas ya `in-progress` (otra tanda la arrancó antes), `start` pausaba como pipeline abandonado, y
// la tanda se anotaba a mano después con `marker.js set-batch`. Con `--batch` el arranque valida la tanda antes de
// tocar nada, no confunde la paraguas en curso con una corrida perdida, y anota la tanda después del marcador.
//
//   T20  la paraguas en curso arranca con su tanda
//   T21  una tanda que no está, una hecha o nombres repetidos: pausa sin mutar nada
//   T22  la misma sesión, otra vez: la misma tanda no cambia nada; otra pausa; sin tanda anotada, la anota
//   T23  otra sesión sobre la misma historia: con otra tanda arranca; con la misma, o sin tanda, pausa
//   T24  el marker.js instalado sin set-batch: sale 1 con el comando a mano y el marcador sin tanda
//
// Corre `pipeline.js` real con un HOME temporal y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/start-batch.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

// La paraguas: tres tandas; `estados` cambia el de alguna, `extra` agrega renglones al bloque.
function historia({ status = 'in-progress', estados = {}, extra = [] } = {}) {
  const st = (n) => estados[n] || 'pending';
  return ['---', 'story: "9.9"', 'title: "paraguas"', `status: ${status}`, 'pipelines:',
    '  - name: A-la-primera', `    status: ${st('A-la-primera')}`, '    acs: [1]',
    '  - name: B-la-segunda', `    status: ${st('B-la-segunda')}`, '    acs: [2]',
    '  - name: C-la-tercera', `    status: ${st('C-la-tercera')}`, '    acs: [3]', ...extra,
    '---', '# Story 9.9', '', '## Acceptance Criteria', '',
    '1. **Given** algo, **Then** resultado.', '2. **Given** otra cosa, **Then** otro resultado.', '3. **Given** una tercera, **Then** su resultado.', '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `a.caso1` | 1 | unit | x | y |', '| T2 | `a.caso2` | 2 | unit | x | y |', '| T3 | `a.caso3` | 3 | unit | x | y |', ''].join('\n');
}

// `markerViejo`: el marker.js que llama `start` (el instalado) es una copia que no conoce set-batch.
function entorno({ contenido = historia(), markerViejo = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'start-batch-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const as = path.join(home, '.claude', 'agent-skills');
  if (markerViejo) {
    const dir = path.join(as, 'skills', 'tycon-pipeline', 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.js'), [
      "'use strict';",
      "if (process.argv[2] === 'set-batch') { console.error('marker.js: subcomando desconocido: set-batch'); process.exit(2); }",
      `require(${JSON.stringify(path.join(SCRIPTS, 'marker.js'))});`, ''].join('\n'));
  } else {
    fs.symlinkSync(RAIZ, as);
  }
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-paraguas.md');
  fs.writeFileSync(story, contenido);
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none' });
  const correr = (args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), ...args], { encoding: 'utf8', env: env(sid), input: '', cwd: repo });
  const arrancar = (sid, ...extra) => correr(['start', '--story', story, '--repo', repo, ...extra], sid);
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')))
    || path.join(home, '.claude', '.tycon-pipeline');
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => (fs.existsSync(activo(sid)) ? JSON.parse(fs.readFileSync(activo(sid), 'utf8')) : null);
  const escribir = (sid, m) => { fs.mkdirSync(path.dirname(activo(sid)), { recursive: true }); fs.writeFileSync(activo(sid), JSON.stringify(m)); };
  const gates = () => { try { return fs.readFileSync(path.join(dir(), 'gates.log'), 'utf8'); } catch { return ''; } };
  const gitignore = () => { try { return fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'); } catch { return null; } };
  return { base, home, repo, story, correr, arrancar, leer, escribir, gates, gitignore };
}

const json = (r) => { try { return JSON.parse(r.stdout); } catch { return {}; } };
const pausas = (r) => (json(r).pauses || []).map((p) => p.id);
const salida = (r) => `${r.stdout}\n${r.stderr}`;

test('T20 Start_Batch_InProgressUmbrella_Starts @story-8.240 @ac-13 — la paraguas en curso arranca con su tanda', () => {
  const E = entorno();
  const r = E.arrancar('s-20', '--batch', 'B-la-segunda');
  assert.strictEqual(r.status, 0, salida(r));
  assert.ok(!pausas(r).includes('PIPE-C5-abandoned'), salida(r));
  assert.strictEqual(E.leer('s-20').batch, 'B-la-segunda');
  assert.match(E.gates(), /"name":"set-batch"[^\n]*"batch":"B-la-segunda"/);
  assert.ok((json(r).actions_done || []).some((a) => /B-la-segunda/.test(a)), salida(r));
  // sin --batch, la pausa de hoy
  const E2 = entorno();
  const r2 = E2.arrancar('s-20b');
  assert.notStrictEqual(r2.status, 0, salida(r2));
  assert.ok(pausas(r2).includes('PIPE-C5-abandoned'), salida(r2));
});

test('T21 Start_Batch_Invalid_NothingMutated @story-8.240 @ac-13 — una tanda inválida pausa sin tocar nada', () => {
  const casos = [
    [historia(), 'Z-ninguna'],
    [historia({ estados: { 'B-la-segunda': 'done' } }), 'B-la-segunda'],
    [historia({ extra: ['  - name: B-la-segunda', '    status: pending', '    acs: [2]'] }), 'B-la-segunda'],
  ];
  for (const [contenido, tanda] of casos) {
    const E = entorno({ contenido });
    const antesHistoria = fs.readFileSync(E.story, 'utf8');
    const antesIgnore = E.gitignore();
    const r = E.arrancar('s-21', '--batch', tanda);
    assert.notStrictEqual(r.status, 0, salida(r));
    const detalle = (json(r).pauses || []).map((p) => p.detail).join('\n');
    assert.match(detalle, /A-la-primera/, `la pausa lista las tandas:\n${salida(r)}`);
    assert.strictEqual(E.leer('s-21'), null, 'sin marcador');
    assert.strictEqual(fs.readFileSync(E.story, 'utf8'), antesHistoria, 'la historia sin cambios');
    assert.strictEqual(E.gitignore(), antesIgnore, 'el .gitignore sin cambios');
  }
});

test('T22 Start_Batch_Rerun_SameAndOther @story-8.240 @ac-14 — la misma sesión otra vez', () => {
  const E = entorno();
  assert.strictEqual(E.arrancar('s-22', '--batch', 'B-la-segunda').status, 0);
  const antes = JSON.stringify(E.leer('s-22'));
  // la misma tanda: sale 0 y no cambia nada
  let r = E.arrancar('s-22', '--batch', 'B-la-segunda');
  assert.strictEqual(r.status, 0, salida(r));
  assert.strictEqual(JSON.stringify(E.leer('s-22')), antes, 'el marcador sin cambios');
  // otra tanda: pausa y no muta
  r = E.arrancar('s-22', '--batch', 'C-la-tercera');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match((json(r).pauses || []).map((p) => p.detail).join('\n'), /ya anotó la tanda B-la-segunda/, salida(r));
  assert.strictEqual(JSON.stringify(E.leer('s-22')), antes, 'el marcador sin cambios');
  // un arranque sin --batch, y después con la tanda: la anota
  const E2 = entorno({ contenido: historia({ status: 'ready-for-dev' }) });
  assert.strictEqual(E2.arrancar('s-22b').status, 0);
  assert.ok(!E2.leer('s-22b').batch);
  r = E2.arrancar('s-22b', '--batch', 'B-la-segunda');
  assert.strictEqual(r.status, 0, salida(r));
  assert.strictEqual(E2.leer('s-22b').batch, 'B-la-segunda');
});

test('T23 Start_Batch_OtherSession_ByBatch @story-8.240 @ac-14 — otra sesión sobre la misma historia', () => {
  for (const [suya, pausa] of [['C-la-tercera', false], ['B-la-segunda', true], [null, true]]) {
    const E = entorno();
    // stable-data: la otra sesión tiene que estar viva, y `start` mide la vida de un marcador contra el reloj real
    E.escribir('s-otra', { storyId: '9.9', storyPath: E.story, repoPath: E.repo, sessionId: 's-otra', lastTouch: new Date().toISOString(), stepsCompleted: ['start'], ...(suya ? { batch: suya } : {}) });
    const r = E.arrancar('s-23', '--batch', 'B-la-segunda');
    if (pausa) {
      assert.notStrictEqual(r.status, 0, `${suya}: ${salida(r)}`);
      assert.ok(pausas(r).includes('PIPE-C0-cross-session'), `${suya}: ${salida(r)}`);
    } else {
      assert.strictEqual(r.status, 0, `${suya}: ${salida(r)}`);
      assert.strictEqual(E.leer('s-23').batch, 'B-la-segunda');
    }
  }
});

test('T24 Start_Batch_SetBatchFails_PauseWithCommand @story-8.240 @ac-15 — el marker.js instalado sin set-batch', () => {
  const E = entorno({ markerViejo: true });
  const r = E.arrancar('s-24', '--batch', 'B-la-segunda');
  assert.strictEqual(r.status, 1, salida(r));
  const detalle = (json(r).pauses || []).map((p) => p.detail).join('\n');
  assert.match(detalle, /marker\.js set-batch B-la-segunda/, salida(r));
  assert.match(detalle, /mide todas las tandas/, salida(r));
  const m = E.leer('s-24');
  assert.ok(m, 'el marcador quedó puesto');
  assert.ok(!m.batch, 'sin tanda');
});
