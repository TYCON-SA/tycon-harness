#!/usr/bin/env node
'use strict';
// matrix-out-of-bound-message.test.js — un criterio con cota (`@measure`) que corrió fuera de la cota, o sin su medida,
// no sale verde, y quien frena lo dice con lo medido y la cota: la matriz (`compute`), «Preparar el commit»
// (`marker.js complete-step prepare-commit`) y el control del commit (`on-pre-commit.js`). La deuda de una ejecución no
// lo exime, y el pedido de firma por terminal muestra lo medido.
//
//   T26  MatrixRed_NamesOutOfBoundAndUnmeasured
//   T29  RuntimeWaiver_TerminalPrompt_ShowsMeasured
//
// Corre los comandos reales con un HOME temporal y el id de sesión fijado en el proceso hijo (como matrix-by-batch.test.js).
// Correr: node --test skills/tycon-pipeline/scripts/tests/matrix-out-of-bound-message.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const LEDGER = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));

const DECL1 = ['runtime_not_verifiable:', '  - ac: 1', '    reason: "el laboratorio no deja medir"', '    covered_by: T1'];

function historia({ status = 'ready-for-dev', decl = [] } = {}) {
  return [
    '---', 'story: "9.9"', 'title: "cota"', `status: ${status}`, 'files_to_modify:', '  - src/a.js', ...decl, '---',
    // «smoke runtime» es la marca que hace pedir evidencia en vivo al commitear (on-pre-commit.js, storyRequiresRuntimeEvidence)
    '# Story 9.9', '', 'Cada criterio se prueba con smoke runtime.', '', '## Acceptance Criteria', '',
    '1. **Given** la consulta, **Then** responde en menos de 2 s. @measure(duration < 2s)',
    '2. **Given** la consulta, **Then** el p95 no pasa de 200 ms. @measure(p95 <= 200ms)',
    '3. **Given** otra cosa, **Then** su resultado.', '',
    '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `a.caso1` | 1 | integration | x | y |',
    '| T2 | `a.caso2` | 2 | integration | x | y |',
    '| T3 | `a.caso3` | 3 | integration | x | y |', '',
  ].join('\n');
}

function entorno({ decl = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-msg-'));
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
  const story = path.join(repo, 'specs', 'story-9.9-cota.md');
  fs.writeFileSync(story, historia({ decl }));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  // stable-data: la matriz descarta la evidencia más vieja que el código; una hora fija se pudriría con el tiempo
  const viejo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(repo, 'src', 'a.js'), viejo, viejo);
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '',
  });
  const correr = (script, args, sid, antes = []) => spawnSync(process.execPath, [...antes, path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid), input: '', cwd: repo,
  });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(activo(sid), JSON.stringify(m));
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  const dodDir = path.join(repo, '.advisors', 'dod-runtime');
  const gatesLog = () => path.join(dir() || path.join(home, '.claude', '.tycon-pipeline'), 'gates.log');
  // los humos: el criterio 1 tardó 3010 ms (cota < 2 s); el 2 corrió sin emitir p95
  const humos = () => {
    fs.mkdirSync(path.dirname(gatesLog()), { recursive: true });
    fs.mkdirSync(dodDir, { recursive: true });
    LEDGER.append({ dodDir, gatesLog: gatesLog(), story: '9.9', acs: [1], durationMs: 3010 });
    LEDGER.append({ dodDir, gatesLog: gatesLog(), story: '9.9', acs: [2], durationMs: 100 });
  };
  const pruebasVerdes = () => {
    fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.9', suite_green: true }));
  };
  return { home, repo, story, git, correr, leer, escribir, arrancar, humos, pruebasVerdes, gatesLog };
}

// Lleva la ejecución hasta «Preparar el commit», con «Probar en vivo» hecho: el freno que queda es el de la matriz.
const HECHOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
function hastaPrepararElCommit(E, sid, extra = {}) {
  const m = E.leer(sid);
  const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', E.story, '--repo', E.repo, '--findings', '-'], {
    encoding: 'utf8', input: '[]', cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(w.status, 0, w.stderr + w.stdout);
  E.escribir(sid, { ...m, stepScheme: 2, stepsCompleted: HECHOS, stepsPending: ['prepare-commit'],
    dodRuntimeChecked: true, deepReviewDone: true, checks: { tests: 'green', build: 'green', advisors: 'green', ...(extra.checks || {}) },
    adversarial: { launchedAtStep: 'adversarial-pass', runId: 'r1', sessionId: sid, launchedAt: hace(30) },
    adversarialPasses: [{ tipo: '5b', ts: hace(5), confirmados: 0 }], ...(extra.marker || {}) });
}
const MATRIZ_ROJA = /matriz de verificación runtime \(DODRT-C6\) ROJA/;
const NOMBRA = (txt) => /AC #1: medido 3010 ms; la cota es < 2000 ms/.test(txt) && /AC #2: sin medición/.test(txt)
  && /se mide de nuevo/.test(txt) && /se cambia el criterio/.test(txt) && /lo firma una persona/.test(txt);

test('MatrixRed_NamesOutOfBoundAndUnmeasured @story-8.260 @ac-24', () => {
  const E = entorno();
  E.arrancar('s-cota');
  E.humos();
  // la matriz: las dos listas nuevas, en pendientes y no en notRun
  const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const r = rm.compute({ storyPath: E.story, gatesLogPath: E.gatesLog() });
  assert.deepStrictEqual(r.fueraDeCota, [1], JSON.stringify(r.perAc[1]));
  assert.deepStrictEqual(r.sinMedicion, [2], JSON.stringify(r.perAc[2]));
  assert.ok(r.pendientes.includes(1) && r.pendientes.includes(2) && !r.notRun.includes(1) && !r.notRun.includes(2), JSON.stringify(r.pendientes));
  // «Preparar el commit» frena y nombra cada criterio con lo medido, la cota y las tres salidas
  hastaPrepararElCommit(E, 's-cota');
  const p = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-cota');
  assert.match(p.stderr, MATRIZ_ROJA, p.stderr);
  assert.ok(NOMBRA(p.stderr), p.stderr);
  // el control del commit, al pasar la historia a review
  const dod = path.join(E.repo, '.advisors', 'dod-runtime');
  LEDGER.append({ dodDir: dod, gatesLog: E.gatesLog(), story: '9.9', acs: [3] });
  fs.writeFileSync(E.story, historia({ status: 'review' }));
  E.git('add', E.story);
  const env = { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: 's-cota', TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.TYCON_WAIVER_LOG;
  const commitear = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    cwd: E.repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-cota', cwd: E.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "story 9.9"' } }),
  });
  // frena primero la cobertura de cierre (el criterio fuera de cota no cuenta por su humo), y ya dice lo medido
  const antes = commitear();
  assert.strictEqual(antes.status, 2, antes.stderr);
  assert.match(antes.stderr, /Criterios sin evidencia/, antes.stderr);
  assert.ok(NOMBRA(antes.stderr), antes.stderr);
  // con un `-cierre.md` que nombra todo, la que frena es la matriz, y lo dice
  fs.writeFileSync(path.join(dod, '9.9-cierre.md'), '# Cierre 9.9\n- AC #1 verificado\n- AC #2 verificado\n- AC #3 verificado\n');
  const c = commitear();
  assert.strictEqual(c.status, 2, c.stderr);
  assert.match(c.stderr, /matriz de verificación runtime ROJA/, c.stderr);
  assert.ok(NOMBRA(c.stderr), c.stderr);
});

test('MatrixRed_DeclaredMeasuredAc_WaitsSignatureWithMeasured @story-8.260 @ac-24', () => {
  const E = entorno({ decl: DECL1 });
  E.arrancar('s-decl');
  E.humos();
  E.pruebasVerdes();
  hastaPrepararElCommit(E, 's-decl');
  const p = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-decl');
  assert.match(p.stderr, /imposibles-declarados[^\n]*#1/, p.stderr);
  assert.match(p.stderr, /espera firma — AC #1: medido 3010 ms; la cota es < 2000 ms/, p.stderr);
});

test('MatrixRed_DebtDoesNotExemptOutOfBound @story-8.260 @ac-24', () => {
  const E = entorno();
  E.arrancar('s-deuda');
  E.humos();
  // una ejecución en deuda con el rojo esperado de la matriz: la lista cubre el criterio 3 (sin correr)
  const hasta = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  hastaPrepararElCommit(E, 's-deuda', {
    checks: { acmatrix: 'rojo-esperado' },
    marker: { cierre: { estado: 'deuda', deuda: 'DEF-9.9-x', motivo: 'el laboratorio cerrado' }, expectedRed: { acmatrix: { tests: ['T3'], until: hasta } } },
  });
  const p = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-deuda');
  assert.match(p.stderr, MATRIZ_ROJA, p.stderr);
  assert.match(p.stderr, /la deuda no exime los criterios fuera de la cota: #1/, p.stderr);
  assert.match(p.stderr, /la deuda no exime los criterios sin medición: #2/, p.stderr);
});

test('RuntimeWaiver_TerminalPrompt_ShowsMeasured @story-8.260 @ac-25', () => {
  // la pregunta que hace `marker.js runtime-waiver` por terminal, por criterio, sale de una sola función
  const wd = require(path.join(SCRIPTS, 'lib', 'waiver-display.js'));
  const con = wd.preguntaDeTerminal({ ac: 1, texto: 'responde en menos de 2 s', reason: 'x', cov: 'T1', medida: 'medido 3010 ms; la cota es < 2000 ms' });
  assert.match(con, /Lo medido: medido 3010 ms; la cota es < 2000 ms[\s\S]*¿Aprobás saltar/);
  const sin = wd.preguntaDeTerminal({ ac: 1, texto: 'algo', reason: 'x', cov: 'T1', medida: null });
  assert.doesNotMatch(sin, /Lo medido/);
  // y el comando la muestra: corre con la terminal reemplazada, que contesta «no» a todo, así que no se firma nada
  const E = entorno({ decl: DECL1 });
  E.arrancar('s-tty');
  E.humos();
  E.pruebasVerdes();
  LEDGER.append({ dodDir: path.join(E.repo, '.advisors', 'dod-runtime'), gatesLog: E.gatesLog(), story: '9.9', acs: [3] });
  const visto = path.join(E.home, 'terminal.txt');
  const terminal = path.join(E.home, 'terminal-de-juguete.js');
  fs.writeFileSync(terminal, [
    `const W = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'runtime-waiver.js'))});`,
    'W.esWindows = () => false;',
    'W.hasTty = () => true;',
    `W.promptTty = (t) => { require('fs').appendFileSync(${JSON.stringify(visto)}, t + '\\n'); return 'no'; };`,
  ].join('\n'));
  const r = E.correr('marker.js', ['runtime-waiver', E.story, '--terminal'], 's-tty', ['-r', terminal]);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(fs.readFileSync(visto, 'utf8'), /Lo medido: medido 3010 ms; la cota es < 2000 ms[\s\S]*¿Aprobás saltar/);
  assert.match(r.stderr, /sin waiver/, r.stderr);
});
