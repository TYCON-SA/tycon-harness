#!/usr/bin/env node
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría.
// Un criterio que una prueba de Nivel `staging` nombra se comprueba en staging, después del merge: antes de done no frena
// ni pide firma de deuda; para done pide un humo corrido con `smoke-run.sh --environment staging`, y el freno de done lo
// exige aunque haya constancia de la matriz verde.
// 🔴 Falla con: pedir firma antes del merge, pasar a done sin el humo de staging (también con una constancia de la
//    corrida o con el entorno escrito sólo en el registro), o frenar sin decir cómo se corre el humo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
const ledgerLine = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const SMOKE_RUN = path.join(SCRIPTS, 'smoke-run.sh');
const TYCON_HOME = path.join(SCRIPTS, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
const stateDirOf = fs.existsSync(TYCON_HOME) ? require(TYCON_HOME).stateDir : (h) => path.join(h, '.claude', '.tycon-pipeline');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// AC 1 corre en local (humo); AC 2 se comprueba en staging
const HISTORIA = (estado) => `---
epic: 9
story: "9.1"
title: "x"
status: ${estado}
---

# Story 9.1: x

Status: ${estado}

## Acceptance Criteria

1. **Given** una cosa **When** pasa otra **Then** se ve.
2. **Given** el despliegue **When** se llama al servicio de afuera **Then** responde.

### Tests

| ID | Test | AC | Nivel | Escenario | Esperado |
|---|---|---|---|---|---|
| E1 | \`curl la pantalla\` | 1 | smoke | x | y |
| S1 | \`curl el servicio en staging\` | 2 | staging | x | y |
`;

function corral(estado = 'review') {
  const home = tmp('staging-home-');
  const repo = tmp('staging-repo-');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.1-x.md');
  fs.writeFileSync(story, HISTORIA(estado));
  spawnSync('git', ['init', '-q', repo]);
  const state = stateDirOf(home);
  fs.mkdirSync(state, { recursive: true });
  const dod = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const gatesLog = path.join(state, 'gates.log');
  fs.appendFileSync(gatesLog, '');
  const humo = (acs, extra = {}) => ledgerLine.append({ dodDir: dod, gatesLog, story: '9.1', acs, cmd: 'curl -s http://localhost:5000/x', mirror: true, ...extra });
  const matriz = (extra = {}) => rm.compute({ storyPath: story, gatesLogPath: gatesLog, testsResults: [], ...extra });
  return { home, repo, story, state, dod, gatesLog, humo, matriz };
}

function marker(c, ...args) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TYCON_|CLAUDE_CODE_SESSION_ID|CODEX_SESSION_ID|NODE_TEST_CONTEXT)/.test(k)) env[k] = v;
  return spawnSync(process.execPath, [MARKER_JS, ...args], { cwd: c.repo, encoding: 'utf8', env: { ...env, HOME: c.home, TYCON_SESSION_ID: 'staging' } });
}
const estadoDe = (c) => (fs.readFileSync(c.story, 'utf8').match(/^status: (\S+)/m) || [])[1];
const avisos = (r) => r.warnings.join('\n');

test('T1 CriterioDeStaging_SinCorrer_NoFrenaAntesDeDone', () => {
  const c = corral();
  c.humo([1]);
  const r = c.matriz();
  assert.strictEqual(r.perAc[2].verdict, 'EN-STAGING', avisos(r));
  assert.deepStrictEqual(r.pendientes, [], avisos(r));
  assert.strictEqual(r.green, true, avisos(r));
  assert.match(avisos(r), /AC#2 se comprueba en staging.*--environment staging/);
  assert.deepStrictEqual(r.notVerifiable, [], 'no pide firma de deuda');
});

test('T2 CriterioDeStaging_ParaDone_SinHumoDeStaging_Rojo', () => {
  const c = corral();
  c.humo([1, 2]);
  const r = c.matriz({ paraDone: true });
  assert.strictEqual(r.green, false, avisos(r));
  assert.deepStrictEqual(r.stagingFalta, [2], 'corrido en local no alcanza: la prueba pide staging');
  assert.match(avisos(r), /smoke-run\.sh .* --acs 2 --environment staging/);
});

test('T3 CriterioDeStaging_ConHumoDeStaging_VerdeParaDone', () => {
  const c = corral();
  c.humo([1]);
  c.humo([2], { environment: 'staging' });
  const r = c.matriz({ paraDone: true });
  assert.deepStrictEqual(r.stagingFalta, [], avisos(r));
  assert.strictEqual(r.green, true, avisos(r));
});

test('T4 EntornoSoloEnElRegistro_NoCuenta', () => {
  // el registro viaja con el código y se edita: el entorno vale sólo si el espejo lo trae
  const c = corral();
  c.humo([1]);
  c.humo([2], { enRegistro: { environment: 'staging' } });
  assert.deepStrictEqual(c.matriz({ paraDone: true }).stagingFalta, [2]);
  const otro = corral();
  otro.humo([1]);
  otro.humo([2], { environment: 'produccion' });
  assert.deepStrictEqual(otro.matriz({ paraDone: true }).stagingFalta, [2], 'otro entorno no es staging');
});

test('T5 Done_SinHumoDeStaging_FrenaAunqueHayaConstancia_YDiceComoSeCorre', () => {
  const c = corral();
  c.humo([1]);
  fs.appendFileSync(c.gatesLog, `${JSON.stringify({ ts: new Date().toISOString(), name: 'acmatrix-green', story: '9.1', storyPath: c.story, storyRel: 'specs/story-9.1-x.md', repoCommon: path.join(c.repo, '.git') })}\n`);
  const r = marker(c, 'update-story-status', c.story, 'done');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(estadoDe(c), 'review');
  assert.match(r.stderr, /AC#2 se comprueba\(n\) en staging/);
  assert.match(r.stderr, /smoke-run\.sh .* --acs 2 --environment staging --/, 'dice cómo correr el humo');
  c.humo([2], { environment: 'staging' });
  const ok = marker(c, 'update-story-status', c.story, 'done');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(estadoDe(c), 'done');
});

test('T6 SmokeRun_Environment_VaAlRegistroYAlEspejo', () => {
  const c = corral();
  const correr = (...args) => spawnSync('bash', [SMOKE_RUN, c.dod, '9.1', '--acs', '2', ...args], { cwd: c.repo, encoding: 'utf8', env: { ...process.env, HOME: c.home } });
  const mal = correr('--environment', 'Staging;x', '--', 'true');
  assert.strictEqual(mal.status, 2, mal.stderr);
  assert.match(mal.stderr, /--environment necesita/);
  const bien = correr('--environment', 'staging', '--pass-if', 'sale 0', '--', 'true');
  assert.strictEqual(bien.status, 0, bien.stderr);
  const registro = fs.readFileSync(path.join(c.dod, '9.1-smoke-ledger.jsonl'), 'utf8');
  assert.match(registro, /"environment":"staging"/);
  const espejo = fs.readFileSync(path.join(c.home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(espejo, /"type":"smoke-run".*"environment":"staging"/);
});

// del pase: la celda Nivel con formato y la de criterios con rango o «todos»
test('T8 NivelConFormato_YCeldaConRangoOTodos_SonDeStaging', () => {
  for (const [nivel, ac] of [['`staging`', '2'], ['**staging**', '2'], ['staging', '2-2'], ['staging', 'todos']]) {
    const c = corral();
    fs.writeFileSync(c.story, HISTORIA('review').replace('| S1 | `curl el servicio en staging` | 2 | staging | x | y |', `| S1 | \`curl el servicio en staging\` | ${ac} | ${nivel} | x | y |`));
    c.humo([1, 2]);
    const r = c.matriz({ paraDone: true });
    assert.ok(r.stagingFalta.includes(2), `${nivel} / ${ac}: ${avisos(r)}`);
  }
});

// el freno del commit: pasar a review con un criterio de staging sin correr no frena; pasar a done sin su humo, sí
function commitDeEstado(c, de, a) {
  const git = (...x) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...x], { cwd: c.repo, encoding: 'utf8' });
  fs.writeFileSync(c.story, HISTORIA(de));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(c.story, HISTORIA(a));
  git('add', 'specs/story-9.1-x.md');
  const env = { ...process.env, HOME: c.home, USERPROFILE: c.home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.TYCON_WAIVER_LOG;
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    cwd: c.repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'staging-test', cwd: c.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "story 9.1"' } }),
  });
}

test('T9 FrenoDelCommit_AReviewNoFrena_ADoneSinHumoDeStagingFrena', () => {
  const rev = corral();
  rev.humo([1]);
  const r = commitDeEstado(rev, 'in-progress', 'review');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Criterios sin evidencia: [^\n]*#2\b|matrix-red/, r.stderr);
  const done = corral();
  done.humo([1, 2]);
  // review → done por commit avisa (y frena con TYCON_REVIEW_A_DONE=block): la matriz se calcula para done
  const d = commitDeEstado(done, 'review', 'done');
  assert.match(d.stderr, /review → done sin evidencia completa[\s\S]*matrix-red/, d.stderr);
});

test('T7 HistoriaSinPruebaDeStaging_ComoAntes', () => {
  const c = corral();
  fs.writeFileSync(c.story, HISTORIA('review').replace('| S1 | `curl el servicio en staging` | 2 | staging | x | y |', '| E2 | `curl el servicio` | 2 | smoke | x | y |'));
  c.humo([1]);
  const r = c.matriz({ paraDone: true });
  assert.deepStrictEqual(r.notRun, [2], avisos(r));
  assert.deepStrictEqual(r.stagingFalta, []);
  assert.deepStrictEqual(r.enStaging, []);
});
