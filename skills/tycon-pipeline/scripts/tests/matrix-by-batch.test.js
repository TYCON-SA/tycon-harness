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
function historia({ estados = {}, status = 'ready-for-dev', archivos = [] } = {}) {
  const st = (n, def) => estados[n] || def;
  return [
    '---', 'story: "9.9"', 'title: "paraguas"', `status: ${status}`, 'files_to_modify:', '  - src/a.js', ...archivos,
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
  // un set de OTRA historia que trae la misma tanda no la escribe: la tanda es de la historia que la anotó
  r = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.10', storyPath: E.story, stepsPending: ['start'], batch: A }), '--replace'], 's-t9');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(E.leer('s-t9').storyId, '9.9');
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

// Los dos frenos del commit, por su texto: la Capa 5 («Criterios sin evidencia: …») y la matriz (DODRT-C6).
const CAPA5 = /Criterios sin evidencia: ([^\n]*)/;
const salida = (r) => r.stderr + r.stdout;
const faltan = (r) => ((salida(r).match(CAPA5) || [])[1] || '');

test('T11 PreCommit_ToReview_AsksAllBatches @story-8.239 @ac-8 — pasar a review pide todas, aunque el marcador tenga tanda', () => {
  const E = entorno();
  E.arrancar('s-t11');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-t11').status, 0);
  E.humo([1]);
  const r = commitear(E, historia({ status: 'review' }), 's-t11');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r), /#2\b/, salida(r));
  assert.doesNotMatch(faltan(r), /#1\b/, salida(r));
});

test('T12 PreCommit_BatchToDone_MeasuresThatBatch @story-8.239 @ac-9 — cerrar una tanda mide ésa (matriz y Capa 5)', () => {
  // la primera tanda a done, con su humo y la segunda sin evidencia: ni la Capa 5 ni la matriz frenan
  let E = entorno();
  E.humo([1]);
  let r = commitear(E, historia({ estados: { [A]: 'done' } }), 's-t12');
  assert.doesNotMatch(salida(r), CAPA5, salida(r));
  assert.doesNotMatch(salida(r), /DODRT-C6/, salida(r));
  assert.strictEqual(r.status, 0, salida(r));
  assert.match(salida(r), new RegExp(`cierra la tanda ${A}`));
  // dos tandas a done, con la humo de las dos
  E = entorno();
  E.humo([1, 3]);
  r = commitear(E, historia({ estados: { [A]: 'done', [C]: 'done' } }), 's-t12b');
  assert.strictEqual(r.status, 0, salida(r));
  // la tanda a done sin su evidencia (hay de otra tanda): la Capa 5 frena por su criterio, no por los de las otras
  E = entorno();
  E.humo([3]);
  r = commitear(E, historia({ estados: { [A]: 'done' } }), 's-t12c');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r), /#1\b/, salida(r));
  assert.doesNotMatch(faltan(r), /#2\b/, salida(r));
  // la tanda a done y la historia a review en el mismo commit: manda review, mide todas y frena por la segunda
  E = entorno();
  E.humo([1]);
  r = commitear(E, historia({ estados: { [A]: 'done' }, status: 'review' }), 's-t12d');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r), /#2\b/, salida(r));
  // una tanda que se cierra sin criterios (tampoco en HEAD) no achica: mide todas y frena por la segunda
  E = entorno();
  E.humo([1]);
  const sinCriterios = (estado) => historia({ estados: { [A]: estado } }).replace(`  - name: ${A}\n    status: ${estado}\n    acs: [1]`, `  - name: ${A}\n    status: ${estado}`);
  fs.writeFileSync(E.story, sinCriterios('pending'));
  E.git('commit', '-qam', 'la primera tanda sin criterios');
  r = commitear(E, sinCriterios('done'), 's-t12e');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r), /#2\b/, salida(r));
  // una tanda que aparece ya done no se cerró en este commit: mide todas
  E = entorno();
  E.humo([3]);
  const conNueva = historia().replace('---\n# Story', `  - name: D-la-nueva\n    status: done\n    acs: [3]\n---\n# Story`);
  r = commitear(E, conNueva, 's-t12f');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(salida(r), /agrega la tanda D-la-nueva ya done/, salida(r));
  assert.match(faltan(r), /#1\b/, salida(r));
  // mover un criterio a otra tanda en el commit que cierra la primera no lo saca: se miden los que tenía en HEAD
  E = entorno();
  E.humo([3]);
  const movido = historia({ estados: { [A]: 'done' } }).replace(`status: done\n    acs: [1]`, 'status: done\n    acs: [3]')
    .replace(`  - name: ${C}\n    status: pending\n    acs: [3]`, `  - name: ${C}\n    status: pending\n    acs: [1]`);
  r = commitear(E, movido, 's-t12g');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r), /#1\b/, salida(r));
  // sin la historia en HEAD no se sabe qué tanda se cierra: mide todas
  E = entorno();
  E.humo([1]);
  E.git('rm', '-q', '--cached', E.story);
  E.git('commit', '-qm', 'sin la historia');
  r = commitear(E, historia({ estados: { [A]: 'done' } }), 's-t12h');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(salida(r), /no pude leer las tandas de la historia en HEAD/, salida(r));
});

// ── 8.240: la tanda se ata a lo que la corrida toca ──────────────────────────────────────────────────────────────

const B_ARCH = ['  - src/b.js  # tanda B'];
const VUELVE_B = new RegExp(`vuelven a la matriz: ${B} \\(AC 2\\)`);

// La historia con el archivo de la segunda tanda, ya commiteada antes del arranque de la corrida.
function conArchivoDeB(E, extra = {}) {
  fs.writeFileSync(E.story, historia({ archivos: B_ARCH, ...extra }));
  E.git('commit', '-qam', 'la historia ata src/b.js a la segunda tanda');
}

test('T6 PrepareCommit_Batch_CommittedMidRunFile_Returns @story-8.240 @ac-4 — un archivo de otra tanda commiteado a mitad de la corrida devuelve sus criterios', () => {
  const E = entorno();
  conArchivoDeB(E);
  E.arrancar('s-a6');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a6').status, 0);
  hastaPrepararElCommit(E, 's-a6');
  E.humo([1]);
  fs.writeFileSync(path.join(E.repo, 'src', 'b.js'), 'module.exports = 2;\n');
  E.git('add', 'src/b.js');
  E.git('commit', '-qm', 'la corrida toca la segunda tanda');
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-a6');
  assert.match(r.stderr, MATRIZ_ROJA, r.stderr);
  assert.match(r.stderr, /SIN CORRER[^\n]*#2/, r.stderr);
  assert.match(r.stderr + r.stdout, VUELVE_B, r.stderr);
});

test('T7 PrepareCommit_Batch_NoBaseSha_MeasuresAll @story-8.240 @ac-4 — sin baseSha no hay lista: mide todas y lo dice', () => {
  const E = entorno();
  E.arrancar('s-a7');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a7').status, 0);
  hastaPrepararElCommit(E, 's-a7');
  const m = E.leer('s-a7');
  delete m.baseSha;
  E.escribir('s-a7', m);
  E.humo([1]);
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-a7');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, MATRIZ_ROJA, r.stderr);
  assert.match(r.stderr + r.stdout, /sin la lista de cambios de la corrida no achico: mido todas las tandas/, r.stderr);
  assert.match(r.stderr, /SIN CORRER[^\n]*#2[^\n]*#3/, r.stderr);
});

test('T8 Matrix_Batch_CrossRepoPaths_Match @story-8.240 @ac-5 — historia en un repo y código en otro: la ruta se ata igual', () => {
  const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const E = entorno();
  // el repo del código, hermano del de la historia
  const C = path.join(path.dirname(E.repo), 'codigo');
  fs.mkdirSync(path.join(C, 'src'), { recursive: true });
  const gitC = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-C', C, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gitC('init', '-q', '-b', 'feat/x'); gitC('config', 'user.email', 't@t'); gitC('config', 'user.name', 't');
  fs.writeFileSync(path.join(C, 'src', 'b.js'), 'module.exports = 1;\n');
  gitC('add', '.'); gitC('commit', '-qm', 'inicio');
  for (const renglon of ['  - codigo/src/b.js  # tanda B', '  - src/b.js  # tanda B']) {
    fs.writeFileSync(E.story, historia({ archivos: [renglon] }));
    const r = rm.compute({ storyPath: E.story, batch: A, changed: ['src/b.js'], codeRepo: C });
    assert.deepStrictEqual(r.returnedAcs, [2], `${renglon}: ${JSON.stringify(r.structuralError || r.warnings)}`);
  }
  // un marcador cuyo repo del código es C: «Preparar el commit» toma la lista de C
  fs.writeFileSync(E.story, historia({ archivos: ['  - src/b.js  # tanda B'] }));
  E.git('commit', '-qam', 'la historia con el archivo de C');
  E.arrancar('s-a8');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a8').status, 0);
  hastaPrepararElCommit(E, 's-a8');
  const base = gitC('rev-parse', 'HEAD').trim();
  E.escribir('s-a8', { ...E.leer('s-a8'), repoPath: C, baseSha: base });
  E.humo([1]);
  fs.writeFileSync(path.join(C, 'src', 'b.js'), 'module.exports = 2;\n');
  gitC('commit', '-qam', 'la corrida toca la segunda tanda en el repo del código');
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-a8');
  assert.match(r.stderr + r.stdout, VUELVE_B, r.stderr);
});

test('T11 PreCommit_BatchToDone_TouchesOtherBatch_Returns @story-8.240 @ac-7 — cerrar una tanda con un archivo de otra en el commit pide la otra', () => {
  const E = entorno();
  conArchivoDeB(E);
  // el humo de la primera, posterior al cambio del archivo de la segunda: la evidencia de A sigue contando
  // stable-data: la hora del humo va en segundos; el archivo, un minuto antes, para que la evidencia sea posterior
  fs.writeFileSync(path.join(E.repo, 'src', 'b.js'), 'module.exports = 2;\n');
  const antes = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(path.join(E.repo, 'src', 'b.js'), antes, antes);
  E.git('add', 'src/b.js');
  E.humo([1]);
  let r = commitear(E, historia({ archivos: B_ARCH, estados: { [A]: 'done' } }), 's-a11');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(faltan(r) + salida(r), /#2\b/, salida(r));
  // sin src/b.js en el commit, cerrar la primera no pide la segunda
  const E2 = entorno();
  fs.writeFileSync(path.join(E2.repo, 'src', 'b.js'), 'module.exports = 2;\n');
  fs.utimesSync(path.join(E2.repo, 'src', 'b.js'), antes, antes);
  E2.git('add', 'src/b.js');
  conArchivoDeB(E2);
  E2.humo([1]);
  r = commitear(E2, historia({ archivos: B_ARCH, estados: { [A]: 'done' } }), 's-a11b');
  assert.strictEqual(r.status, 0, salida(r));
});

// La línea de comando de la matriz, con el HOME y la sesión de la corrida.
function cli(E, args, sid, sinSesion = false) {
  const env = { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; delete env.CODEX_SESSION_ID;
  if (!sinSesion) env.CLAUDE_CODE_SESSION_ID = sid;
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'runtime-matrix.js'), '--story', E.story, '--no-write', ...args], { encoding: 'utf8', env, cwd: E.repo });
}
const primera = (r) => r.stdout.split('\n')[0];

test('T12 MatrixCli_ReadsMarkerBatch @story-8.240 @ac-8 — la línea de comando lee la tanda del marcador de la misma historia', () => {
  const E = entorno();
  E.arrancar('s-a12');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a12').status, 0);
  E.humo([1]);
  let r = cli(E, [], 's-a12');
  assert.match(primera(r), new RegExp(`mide la tanda ${A}`), r.stdout + r.stderr);
  // el marcador de otra historia: mide todas
  E.escribir('s-a12', { ...E.leer('s-a12'), storyPath: path.join(E.repo, 'specs', 'otra.md') });
  r = cli(E, [], 's-a12');
  assert.doesNotMatch(primera(r), /mide la tanda/, r.stdout);
});

test('T13 MatrixCli_BatchFlags @story-8.240 @ac-8 — --batch, --all-batches, --code-repo y --base', () => {
  const E = entorno();
  conArchivoDeB(E);
  E.arrancar('s-a13');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a13').status, 0);
  E.humo([1]);
  // otra tanda que la del marcador: sale 2 sin medir
  let r = cli(E, ['--batch', B], 's-a13');
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  // --all-batches: todas
  r = cli(E, ['--all-batches'], 's-a13');
  assert.doesNotMatch(primera(r), /mide la tanda/, r.stdout);
  assert.match(r.stdout, /NOT-RUN/, r.stdout);
  // sin marcador (otra sesión), con --code-repo y --base: mide A con la vuelta de B
  const base = E.git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(E.repo, 'src', 'b.js'), 'module.exports = 2;\n');
  E.git('add', 'src/b.js');
  E.git('commit', '-qm', 'toca la segunda tanda');
  r = cli(E, ['--batch', A, '--code-repo', E.repo, '--base', base], 's-otra');
  assert.match(primera(r), new RegExp(`mide la tanda ${A}`), r.stdout + r.stderr);
  assert.match(r.stdout, VUELVE_B, r.stdout);
  // --base sin --code-repo: sale 2
  r = cli(E, ['--base', base], 's-otra');
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  // --batch sin marcador ni --code-repo: mide todas y lo dice
  r = cli(E, ['--batch', A], 's-otra');
  assert.match(primera(r), /mido todas las tandas/, r.stdout);
  // sin sesión, con el marcador en A: mide todas y lo dice
  r = cli(E, [], 's-a13', true);
  assert.match(primera(r), /mido todas las tandas/, r.stdout);
});

// La historia con la pantalla en la segunda tanda: su nombre la nombra y su .tsx está declarado y commiteado, viejo. En
// una historia de pantalla un criterio sin marca es de pantalla: el de la primera tanda lleva `@sin-pantalla`.
const B_PANT = 'B-frontend';
const historiaConPantalla = (o = {}) => historia({ ...o, archivos: ['  - web/src/Panel.tsx  # tanda B'] }).split(B).join(B_PANT)
  .replace('**Then** resultado.', '**Then** resultado. @sin-pantalla');
function conPantallaEnB(E) {
  const tsx = path.join(E.repo, 'web', 'src', 'Panel.tsx');
  fs.mkdirSync(path.dirname(tsx), { recursive: true });
  fs.writeFileSync(tsx, 'export const Panel = 1;\n');
  // stable-data: el código, una hora antes, para que el humo de ahora sea posterior
  const viejo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(tsx, viejo, viejo);
  fs.writeFileSync(E.story, historiaConPantalla());
  E.git('add', '.');
  E.git('commit', '-qm', 'la pantalla es de la segunda tanda');
}
const BAJA_A = new RegExp(`tanda ${B_PANT}; esta corrida, de la tanda ${A}`, 'g');

test('T15 PrepareCommit_Batch_ScreenInOtherBatch_NoBrowserBlock @story-8.240 @ac-9 — la pantalla de otra tanda no pide la prueba con navegador', () => {
  const E = entorno();
  conPantallaEnB(E);
  E.arrancar('s-a15');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's-a15').status, 0);
  hastaPrepararElCommit(E, 's-a15');
  // la guía del tester se sigue pidiendo (es de los criterios, no de la pantalla): lista y commiteada antes de la base,
  // para que el cierre llegue a la matriz
  const qa = path.join(E.repo, 'specs', 'qa');
  fs.mkdirSync(qa, { recursive: true });
  fs.writeFileSync(path.join(qa, 'story-9.9-paraguas-guia-qa.html'), '<!doctype html><title>guía</title>\n');
  fs.writeFileSync(path.join(qa, '9.9-pasos.md'), ['Usuario por defecto: administrador', '', '## AC 1', 'Probar el primero.', '',
    '## AC 2', 'Probar el segundo.', '', '## AC 3', 'Probar el tercero.', ''].join('\n'));
  fs.writeFileSync(path.join(qa, '9.9-legibilidad.md'), 'veredicto: OK\n');
  E.git('add', '.');
  E.git('commit', '-qm', 'la guía del tester');
  E.escribir('s-a15', { ...E.leer('s-a15'), repoPath: E.repo, baseSha: E.git('rev-parse', 'HEAD').trim() });
  E.humo([1]);
  const r =E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-a15');
  const out = r.stderr + r.stdout;
  assert.doesNotMatch(out, /story de UI sin el gate/, out);
  assert.strictEqual((out.match(BAJA_A) || []).length, 1, `la baja se dice una vez:\n${out}`);
  // la matriz llega a medir la tanda (la revisión de la pantalla de la guía del tester no es de esta historia)
  assert.match(out, new RegExp(`la matriz mide la tanda ${A}`), out);
  assert.doesNotMatch(out, MATRIZ_ROJA, out);
});

test('T16 PreCommit_BatchToDone_ScreenOfClosingBatch @story-8.240 @ac-10 — cerrar la tanda de backend no pide la evidencia de navegador', () => {
  const E = entorno();
  conPantallaEnB(E);
  E.humo([1]);
  let r = commitear(E, historiaConPantalla({ estados: { [A]: 'done' } }), 's-a16');
  assert.doesNotMatch(salida(r), /DODRT-C5\.1/, salida(r));
  assert.strictEqual(r.status, 0, salida(r));
  // pasar la historia a review: la pide
  const E2 = entorno();
  conPantallaEnB(E2);
  E2.humo([1, 2, 3]);
  r = commitear(E2, historiaConPantalla({ status: 'review' }), 's-a16b');
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(salida(r), /DODRT-C5\.1/, salida(r));
});

// El criterio de la primera tanda declarado imposible de probar en vivo, cubierto por su prueba; la corrida, en esa tanda.
const historiaConFirma = (o = {}) => historia(o).replace('pipelines:', ['runtime_not_verifiable:', '  - ac: 1',
  '    reason: "el servicio externo no tiene ambiente de prueba"', '    covered_by: T1', 'pipelines:'].join('\n'));
function conFirmaEnA(E, sid) {
  fs.writeFileSync(E.story, historiaConFirma());
  E.git('commit', '-qam', 'el criterio de la primera tanda no se prueba en vivo');
  E.arrancar(sid);
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], sid).status, 0);
  E.escribir(sid, { ...E.leer(sid), repoPath: E.repo, baseSha: E.git('rev-parse', 'HEAD').trim() });
  // la suite en verde: la prueba que cubre el criterio declarado cuenta como su evidencia de código
  fs.mkdirSync(path.join(E.repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(E.repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.9', suite_green: true }));
}
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

test('T17 RuntimeWaiver_Session_Batch_SignsOwnCriterion @story-8.240 @ac-11 — la firma en la ventana mide la tanda del marcador', () => {
  const E = entorno();
  conFirmaEnA(E, 's-a17');
  const ventana = conVentana({});
  // un criterio de otra tanda: sale 2 sin firmar
  let r = E.correr('marker.js', ['runtime-waiver', E.story, '--acs', '2', '--approved-by', 'Dev de Prueba'], 's-a17', ventana);
  assert.strictEqual(r.status, 2, salida(r));
  assert.match(salida(r), /no es de la tanda medida/, salida(r));
  // el de la tanda: firma, aunque la otra tanda no tenga evidencia
  r = E.correr('marker.js', ['runtime-waiver', E.story, '--acs', '1', '--approved-by', 'Dev de Prueba'], 's-a17', ventana);
  assert.strictEqual(r.status, 0, salida(r));
  // la firma se ancla a la declaración: la matriz sin tanda la cuenta
  const todas = require(path.join(SCRIPTS, 'runtime-matrix.js')).compute({ storyPath: E.story });
  assert.strictEqual(todas.perAc[1].verdict, 'WAIVED-USER', JSON.stringify(todas.perAc[1]));
});

test('T19 RuntimeWaiver_Terminal_ForSession_ReadsBatch @story-8.240 @ac-12 — la firma por terminal lee la tanda de la sesión nombrada', () => {
  const E = entorno();
  conFirmaEnA(E, 's-a19');
  const wd = require(path.join(SCRIPTS, 'lib', 'waiver-display.js'));
  const m = E.leer('s-a19');
  assert.strictEqual(wd.matrixForSignature(E.story, m).batch, A);
  // con el marcador de otra historia, o sin marcador, mide todas
  for (const x of [wd.matrixForSignature(E.story, { ...m, storyPath: path.join(E.repo, 'specs', 'otra.md') }), wd.matrixForSignature(E.story, null)]) {
    assert.strictEqual(x.batch, null);
    assert.ok((x.notRun || []).length, 'las otras tandas quedan sin correr');
  }
  // el rechazo por las otras tandas nombra --for-session con la sesión de la corrida
  assert.match(String(wd.pistaDeSesion({ stateDir: E.dir(), storyPath: E.story })), /--for-session s-a19/);
  // «Preparar el commit» con la matriz roja por el criterio de la tanda: el comando de la firma lleva la sesión
  hastaPrepararElCommit(E, 's-a19');
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-a19');
  assert.match(salida(r), MATRIZ_ROJA, salida(r));
  assert.match(salida(r), /runtime-waiver \S+ --for-session s-a19/, salida(r));
});

// ── 8.245: una tanda bloqueada no vuelve por un archivo que comparte ─────────────────────────────────────────────────

test('T7 TandaBloqueada_ArchivoCompartido_NoVuelve_SuPantallaSi @story-8.245 @ac-7 — vuelve la hecha; la bloqueada, sólo por un archivo que nombra sólo ella', () => {
  const E = entorno();
  // la segunda tanda bloqueada (con su pendiente) y la tercera hecha; src/comun.js atado a las dos, no a la medida
  const texto = historia({ estados: { [C]: 'done' }, archivos: ['  - src/comun.js  # tanda B, tanda C', '  - web/src/Panel.tsx  # tanda B'] })
    .replace(`status: pending\n    acs: [2]`, 'status: blocked\n    blocked_by: "la reemplaza otra historia"\n    acs_pending: [2]')
    // la regla de la pantalla de hoy: la tanda bloqueada se nombra como de pantalla
    .split(B).join(B_PANT).replace('**Then** resultado.', '**Then** resultado. @sin-pantalla');
  fs.writeFileSync(E.story, texto);
  fs.mkdirSync(path.join(E.repo, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(E.repo, 'src', 'comun.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(E.repo, 'web', 'src', 'Panel.tsx'), 'export const Panel = 1;\n');
  E.git('add', '.');
  E.git('commit', '-qm', 'el archivo compartido y la pantalla de la bloqueada');
  const base = E.git('rev-parse', 'HEAD').trim();
  E.humo([1]);
  // la corrida cambia el archivo compartido: vuelve la hecha (AC 3) y la bloqueada queda afuera, con su aviso
  fs.writeFileSync(path.join(E.repo, 'src', 'comun.js'), 'module.exports = 2;\n');
  E.git('commit', '-qam', 'toca el archivo compartido');
  let r = cli(E, ['--batch', A, '--code-repo', E.repo, '--base', base], 's-otra');
  assert.match(r.stdout, new RegExp(`vuelven a la matriz: ${C} \\(AC 3\\)`), r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, new RegExp(`${B_PANT} \\(AC 2\\), porque la corrida cambió`), r.stdout);
  assert.match(r.stdout, new RegExp(`EXCLUIDOS del gate por tanda blocked[^\\n]*${B_PANT}: ACs 2`), r.stdout);
  assert.doesNotMatch(r.stdout, /\| #2 \| 🔴/, r.stdout);
  // la corrida cambia también un archivo que sólo nombra la bloqueada (su pantalla): sus criterios vuelven, como antes
  fs.writeFileSync(path.join(E.repo, 'web', 'src', 'Panel.tsx'), 'export const Panel = 2;\n');
  E.git('commit', '-qam', 'toca la pantalla de la bloqueada');
  r = cli(E, ['--batch', A, '--code-repo', E.repo, '--base', base], 's-otra');
  assert.match(r.stdout, new RegExp(`${B_PANT} \\(AC 2\\), porque la corrida cambió web/src/Panel\\.tsx`), r.stdout + r.stderr);
  assert.match(r.stdout, /\| #2 \| 🔴/, r.stdout);
});
