#!/usr/bin/env node
'use strict';
// matrix-by-batch.test.js — en una historia paraguas, la ejecución de una tanda anota su tanda (`marker.js set-batch`)
// y «Preparar el commit» le pide la evidencia en vivo de esa tanda, no la de todas. El control del commit mide todas al
// pasar la historia a review, y al cerrar una tanda mide la que se cierra (la matriz y la Capa 5).
//
// Corre los comandos reales con un HOME temporal y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/matrix-by-batch.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const LEDGER = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));

const A = 'A-la-primera';
const B = 'B-la-segunda';
const C = 'C-la-tercera';

// Una paraguas de juguete: tres tandas, un criterio cada una (1, 2 y 3), cada uno con su fila de pruebas.
function historia({ estados = {}, status = 'ready-for-dev' } = {}) {
  const st = (n, def) => estados[n] || def;
  return [
    '---', 'story: "9.9"', 'title: "paraguas"', `status: ${status}`, 'files_to_modify:', '  - src/a.js',
    'pipelines:',
    `  - name: ${A}`, `    status: ${st(A, 'pending')}`, '    acs: [1]',
    `  - name: ${B}`, `    status: ${st(B, 'pending')}`, '    acs: [2]',
    `  - name: ${C}`, `    status: ${st(C, 'pending')}`, '    acs: [3]',
    // la marca que hace pedir evidencia en vivo al commitear (on-pre-commit.js, storyRequiresRuntimeEvidence)
    '---', '# Story 9.9', '', 'Cada criterio se prueba con smoke runtime.', '',
    '## Acceptance Criteria', '',
    '1. **Given** algo, **When** pasa, **Then** resultado.',
    '2. **Given** otra cosa, **Then** otro resultado.',
    '3. **Given** una tercera, **Then** su resultado.', '',
    '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `a.caso1` | 1 | integration | x | y |',
    '| T2 | `a.caso2` | 2 | integration | x | y |',
    '| T3 | `a.caso3` | 3 | integration | x | y |', '',
  ].join('\n');
}

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-by-batch-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-paraguas.md');
  fs.writeFileSync(story, historia());
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  // el código, viejo: la evidencia de ahora es posterior
  // stable-data: la matriz descarta la evidencia más vieja que el código; una hora fija se pudriría con el tiempo
  const viejo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(repo, 'src', 'a.js'), viejo, viejo);
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '',
  });
  const correr = (script, args, sid, extra = {}) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...env(sid), ...extra }, input: '', cwd: repo,
  });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(activo(sid), JSON.stringify(m));
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  // la humo de los criterios pedidos, con su espejo en el gates.log de la HOME temporal
  const humo = (acs) => {
    const gatesLog = path.join(dir() || path.join(home, '.claude', '.tycon-pipeline'), 'gates.log');
    fs.mkdirSync(path.dirname(gatesLog), { recursive: true });
    const dodDir = path.join(repo, '.advisors', 'dod-runtime');
    fs.mkdirSync(dodDir, { recursive: true });
    LEDGER.append({ dodDir, gatesLog, story: '9.9', acs });
  };
  return { home, repo, story, git, correr, leer, escribir, activo, arrancar, humo, dir };
}

// Lleva la ejecución hasta «Preparar el commit», con «Probar en vivo» hecho: el freno que queda es el de la matriz.
const HECHOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
function hastaPrepararElCommit(E, sid) {
  const m = E.leer(sid);
  // stable-data: el lanzamiento y el resultado del pase tienen que ser de esta ejecución, que arrancó recién
  const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
  // los hallazgos (ninguno) y el pase adversarial con su resultado: los frenos de antes de la matriz quedan atendidos
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', E.story, '--repo', E.repo, '--findings', '-'], {
    encoding: 'utf8', input: '[]', cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(w.status, 0, w.stderr + w.stdout);
  E.escribir(sid, { ...m, stepScheme: 2, stepsCompleted: HECHOS, stepsPending: ['prepare-commit'],
    dodRuntimeChecked: true, deepReviewDone: true, checks: { tests: 'green', build: 'green', advisors: 'green' },
    adversarial: { launchedAtStep: 'adversarial-pass', runId: 'r1', sessionId: sid, launchedAt: hace(30) },
    adversarialPasses: [{ tipo: '5b', ts: hace(5), confirmados: 0 }] });
}
const MATRIZ_ROJA = /matriz de verificación runtime \(DODRT-C6\) ROJA/;

test('T9 SetBatch_OnceAndValidated @story-8.239 @ac-5 — la tanda se anota una vez, validada, y sólo por set-batch', () => {
  const E = entorno();
  E.arrancar('s-t9');
  // set con batch sin tanda anotada: sale 2 y no escribe
  let r = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.9', batch: A })], 's-t9');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /set-batch/);
  assert.strictEqual(E.leer('s-t9').batch, undefined);
  // desconocida y hecha: sale 2 con la lista, sin escribir
  r = E.correr('marker.js', ['set-batch', 'Z'], 's-t9');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`${A}.*${B}`));
  fs.writeFileSync(E.story, historia({ estados: { [C]: 'done' } }));
  r = E.correr('marker.js', ['set-batch', C], 's-t9');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /done/);
  assert.strictEqual(E.leer('s-t9').batch, undefined);
  // la primera vez: anota, con su hora y su línea en gates.log
  r = E.correr('marker.js', ['set-batch', A], 's-t9');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = E.leer('s-t9');
  assert.strictEqual(m.batch, A);
  assert.ok(m.batchSetAt, JSON.stringify(m));
  const log = fs.readFileSync(path.join(E.dir(), 'gates.log'), 'utf8');
  assert.match(log, new RegExp(`"name":"set-batch".*"batch":"${A}"`));
  // la misma: sale 0 sin cambiar nada
  r = E.correr('marker.js', ['set-batch', A], 's-t9');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t9').batchSetAt, m.batchSetAt);
  // otra, o --clear: sale 2 sin escribir
  for (const otra of [[B], ['--clear']]) {
    r = E.correr('marker.js', ['set-batch', ...otra], 's-t9');
    assert.strictEqual(r.status, 2, `${otra}: ${r.stderr}`);
    assert.strictEqual(E.leer('s-t9').batch, A);
  }
  // set con otra tanda: sale 2; con la misma: pasa (get | set no rompe)
  r = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.9', batch: B })], 's-t9');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(E.leer('s-t9').batch, A);
  r = E.correr('marker.js', ['set', JSON.stringify({ ...E.leer('s-t9') })], 's-t9');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t9').batch, A);
  // un set de OTRA historia borra la tanda: no se hereda
  r = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.10', storyPath: E.story, stepsPending: ['start'] }), '--replace'], 's-t9');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t9').batch, undefined);
  assert.strictEqual(E.leer('s-t9').batchSetAt, undefined);
});

test('T10 PrepareCommit_Batch_PassesWithOtherBatchesPending @story-8.239 @ac-6 — con su tanda probada, la matriz no frena por las otras', () => {
  const E = entorno();
  E.arrancar('s-t10');
  hastaPrepararElCommit(E, 's-t10');
  E.humo([1]);
  // sin tanda: frena como hoy, con los criterios de las otras sin correr
  let r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t10');
  assert.match(r.stderr, MATRIZ_ROJA, r.stderr);
  assert.match(r.stderr, /SIN CORRER[^\n]*#2[^\n]*#3/, r.stderr);
  // con la primera tanda anotada: la matriz mide esa tanda y lo dice
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-t10').status, 0);
  r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t10');
  assert.doesNotMatch(r.stderr, MATRIZ_ROJA, r.stderr);
  assert.match(r.stderr + r.stdout, new RegExp(`tanda ${A}`));
  assert.match(r.stderr + r.stdout, new RegExp(`fuera de esta tanda: ${B} \\(AC 2\\)`));
});

// El commit en el repo de la historia, con el control del commit de verdad (on-pre-commit.js).
function commitear(E, contenido, sid) {
  fs.writeFileSync(E.story, contenido);
  E.git('add', E.story);
  const env = { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.TYCON_WAIVER_LOG;
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    cwd: E.repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, cwd: E.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "story 9.9"' } }),
  });
}

test('T11 PreCommit_ToReview_AsksAllBatches @story-8.239 @ac-8 — pasar a review pide todas, aunque el marcador tenga tanda', () => {
  const E = entorno();
  E.arrancar('s-t11');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-t11').status, 0);
  E.humo([1]);
  const r = commitear(E, historia({ status: 'review' }), 's-t11');
  assert.notStrictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, /AC ?#?2|\bAC2\b|ACs?[^\n]*\b2\b/, r.stderr + r.stdout);
});

test('T12 PreCommit_BatchToDone_MeasuresThatBatch @story-8.239 @ac-9 — cerrar una tanda mide ésa (matriz y Capa 5)', () => {
  // A a done, con su humo y B sin evidencia: no frena por B
  let E = entorno();
  E.humo([1]);
  let r = commitear(E, historia({ estados: { [A]: 'done' } }), 's-t12');
  assert.doesNotMatch(r.stderr + r.stdout, /incomplete-evidence|criterios? sin evidencia/i, r.stderr + r.stdout);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, new RegExp(`tanda ${A}`));
  // A y C a done, con la humo de los dos
  E = entorno();
  E.humo([1, 3]);
  r = commitear(E, historia({ estados: { [A]: 'done', [C]: 'done' } }), 's-t12b');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  // A a done sin su evidencia: frena
  E = entorno();
  r = commitear(E, historia({ estados: { [A]: 'done' } }), 's-t12c');
  assert.notStrictEqual(r.status, 0, r.stderr + r.stdout);
  // A a done y la historia a review en el mismo commit: manda review, mide todas y frena por B
  E = entorno();
  E.humo([1]);
  r = commitear(E, historia({ estados: { [A]: 'done' }, status: 'review' }), 's-t12d');
  assert.notStrictEqual(r.status, 0, r.stderr + r.stdout);
  // una tanda que se cierra sin criterios no achica: mide todas y frena por B
  E = entorno();
  E.humo([1]);
  const sinCriterios = historia({ estados: { [A]: 'done' } }).replace(`  - name: ${A}\n    status: done\n    acs: [1]`, `  - name: ${A}\n    status: done`);
  r = commitear(E, sinCriterios, 's-t12e');
  assert.notStrictEqual(r.status, 0, r.stderr + r.stdout);
});
