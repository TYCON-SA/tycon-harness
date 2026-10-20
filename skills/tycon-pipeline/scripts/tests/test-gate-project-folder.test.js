'use strict';

/**
 * test-gate-project-folder.test.js — la puerta de pruebas con la forma del laboratorio del capítulo 4: el back en pytest en
 * `backend/` y el front con Playwright en `frontend/`, sin nada en la raíz. Corre lo que reconoce, y lo que no sabe correr
 * lo dice: deja constancia, el check `tests` queda «sin medir» y el cierre lo anuncia; nunca un verde callado.
 *
 * Herramientas falsas en el PATH (ni Python ni Playwright de verdad): dejan el reporte JUnit que dejaría la real.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const PIPELINE_JS = path.join(SCRIPTS, 'pipeline.js');
const STOP_GATE = path.join(SCRIPTS, 'on-stop-dod-gate.js');
const RAIZ_ARNES = path.resolve(SCRIPTS, '..', '..', '..');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY'];

/** Herramientas falsas: `python -m pytest` y `npx playwright test` escriben un JUnit con FAKE_CASES pruebas. */
function herramientas() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tgs-bin-'));
  const sh = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  const escribe = `node -e 'const n=+(process.env.FAKE_CASES||2);require("fs").mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});require("fs").writeFileSync(process.argv[1], ${JSON.stringify('<?xml version="1.0"?><testsuites><testsuite name="s">')}+Array.from({length:n},(_,i)=>"<testcase name=\\"t"+i+"\\"/>").join("")+"</testsuite></testsuites>")'`;
  sh('python', `
for a in "$@"; do case "$a" in --junitxml=*) J="\${a#--junitxml=}";; --cov) echo "pytest: error: unrecognized arguments: --cov" >&2; exit 4;; esac; done
echo "pytest en $PWD" >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
${escribe} "$J"`);
  sh('npx', `
if [ "$1" = "playwright" ] && [ "$2" = "test" ]; then
  [ -n "$PLAYWRIGHT_JUNIT_OUTPUT_NAME" ] || { echo "sin PLAYWRIGHT_JUNIT_OUTPUT_NAME" >&2; exit 2; }
  case " $* " in *" --reporter=junit "*) ;; *) echo "sin --reporter=junit" >&2; exit 2;; esac
  echo "playwright en $PWD" >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
  ${escribe} "$PLAYWRIGHT_JUNIT_OUTPUT_NAME"; exit 0
fi
echo "npx falso: no sé correr $*" >&2; exit 127`);
  return bin;
}

const STORY = (archivos) => ['---', 'epic: 9', 'story: "9.45"', 'title: "laboratorio del capítulo 4"', 'status: in-progress',
  'files_to_create: []', 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', '# Story 9.45', '',
  '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '', '### Tests', '',
  '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `prueba` | 1 | unit | x | y |', ''].join('\n');

const BACK = { 'backend/pytest.ini': '[pytest]\n', 'backend/app/precios.py': 'a = 1\n', 'backend/tests/test_precios.py': 'def test_a(): pass\n' };
const FRONT = {
  'frontend/package.json': JSON.stringify({ name: 'tienda-front', private: true, devDependencies: { '@playwright/test': '^1.64.1' } }) + '\n',
  'frontend/playwright.config.js': "export default { testDir: 'tests/e2e' };\n",
  'frontend/src/lib/precio.js': 'export const p = 1;\n',
  'frontend/tests/e2e/precio.spec.ts': "import { test } from '@playwright/test';\n",
};

/** Un repo con git y los archivos dados; `tocar` queda cambiado sin commitear. */
function repo(archivos, tocar = []) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgs-repo-')));
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
  git('init', '-q'); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), c);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  for (const rel of tocar) fs.appendFileSync(path.join(d, rel), '\n// tocado\n');
  return d;
}

function entorno(home, sid, bin, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, PATH: `${bin}:${process.env.PATH}`, ...extra };
}
const casa = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgs-home-')));

function markerFalso(home, sid, repoDir, extra = {}) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.json`);
  // stable-data: el marcador de una corrida activa lleva la hora de ahora; con una vieja, la corrida se lee abandonada
  fs.writeFileSync(f, JSON.stringify({
    storyId: '9.45', storyPath: '', repoPath: repoDir, sessionId: sid, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {}, ...extra,
  }));
  return f;
}

function correr(dir, { bin, home = casa(), sid = 'tgs', story, extra } = {}) {
  const args = [TEST_GATE, dir]; if (story) args.push(story);
  const r = spawnSync('bash', args, { encoding: 'utf8', cwd: dir, env: entorno(home, sid, bin, extra) });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art };
}

test('T1 Playwright_Recognized_JunitTotals @story-7.45 @ac-1 — una carpeta con playwright.config corre Playwright y cuenta sus pruebas', () => {
  const bin = herramientas();
  const d = repo({ 'playwright.config.ts': 'export default {};\n', 'src/a.js': 'export const a = 1;\n',
    'package.json': JSON.stringify({ name: 'f', devDependencies: { '@playwright/test': '1' } }) }, ['src/a.js']);
  const r = correr(d, { bin, extra: { FAKE_CASES: '2' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'playwright');
  assert.equal(r.art.totals.total, 2);
  assert.equal(r.art.totals.passed, 2);
  assert.equal(r.art.suite_green, true);
  assert.match(JSON.stringify(r.art.coverage), /punta a punta/, 'dice por qué no hay cobertura');
});

test('T2 Playwright_IsScopeCandidate @story-7.45 @ac-2 — el deductor lista el back pytest y el front Playwright', () => {
  const d = repo({ ...BACK, ...FRONT });
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'test-scope.js'), d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const cands = j.candidates.map((c) => `${c.dir}:${c.runner}`).sort();
  assert.deepEqual(cands, ['backend:pytest', 'frontend:playwright']);
});

test('T3 SingleSubfolderProject_Runs @story-7.45 @ac-3 — el único proyecto con pruebas, en una subcarpeta, se corre', () => {
  // 🔴 rojo antes del arreglo: salía 3 «No se detectó stack de tests» buscando en la raíz.
  const bin = herramientas();
  const lanz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgs-l-')), 'n');
  const d = repo(BACK, ['backend/app/precios.py']);
  const r = correr(d, { bin, extra: { FAKE_LANZAMIENTOS: lanz } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'pytest');
  assert.equal(r.art.totals.total, 2);
  assert.match(r.out, /el único proyecto con pruebas, backend\//);
  assert.match(fs.readFileSync(lanz, 'utf8'), /pytest en .*\/backend$/m);
});

test('T4 Chapter4Shape_BothParts @story-7.45 @ac-4 — back pytest y front Playwright, una story que toca los dos: corren las dos partes', () => {
  const bin = herramientas();
  const d = repo({ ...BACK, ...FRONT, 'specs/s.md': STORY(['backend/app/precios.py', 'frontend/src/lib/precio.js']) },
    ['backend/app/precios.py', 'frontend/src/lib/precio.js']);
  const r = correr(d, { bin, story: path.join(d, 'specs', 's.md'), extra: { FAKE_CASES: '3' } });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.art.parts.map((p) => `${p.scope}:${p.runner && p.runner}`).sort(), ['backend:pytest', 'frontend:playwright']);
  assert.equal(r.art.totals.total, 6);
  assert.equal(r.art.suite_green, true);
});

test('T5 NoStack_WritesPlainArtifact @story-7.45 @ac-5 — lo que no sabe correr deja constancia en llano', () => {
  // 🔴 rojo antes del arreglo: la salida 3 no escribía tests-result.json y el revisor marcaba TEST-C1.
  const bin = herramientas();
  const d = repo({ 'cypress.config.js': 'module.exports = {};\n', 'src/a.js': 'x\n', 'tests/a.cy.js': 'x\n' }, ['src/a.js']);
  const r = correr(d, { bin });
  assert.equal(r.status, 3, r.out);
  assert.ok(r.art, 'escribió tests-result.json');
  assert.equal(r.art.no_stack, true);
  assert.equal(r.art.suite_green, false);
  assert.match(r.art.no_stack_reason, /no sabe correr/);
  assert.match(r.art.no_stack_reason, /miré \., src\/, tests\//, 'nombra las carpetas que miró');
  assert.match(r.art.no_stack_reason, /Configuración/);
  assert.match(r.art.no_stack_reason, /Cómo se corren las pruebas/);
});

test('T6 NoStack_MarksNotMeasured_OverPreviousGreen @story-7.45 @ac-6 — tras una salida 3 el check queda «sin medir», aunque fuera verde', () => {
  const bin = herramientas();
  const d = repo({ 'src/a.js': 'x\n' }, ['src/a.js']);
  const home = casa();
  const mk = markerFalso(home, 'tgs6', d, { checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' } });
  const r = correr(d, { bin, home, sid: 'tgs6' });
  assert.equal(r.status, 3, r.out);
  const m = JSON.parse(fs.readFileSync(mk, 'utf8'));
  assert.equal(m.checks.tests, 'sin-medir', `checks.tests=${m.checks.tests}`);
  assert.equal(m.checksProvenance.tests, 'test-gate');
});

test('T7 NoStack_NeverGreen @story-7.45 @ac-7 — el paso 4, el paso 8 y el corte del turno dicen «pruebas no medidas»', () => {
  // 🔴 rojo antes del arreglo: con la salida 3 el check quedaba ausente y el paso 8 no ponía ninguna condición de pruebas.
  const bin = herramientas();
  const d = repo({ 'src/a.js': 'x\n' }, ['src/a.js']);
  const home = casa();
  const mk = markerFalso(home, 'tgs7', d, { autonomous: true, iter: 0 });
  const r = correr(d, { bin, home, sid: 'tgs7' });
  assert.equal(r.status, 3, r.out);
  assert.equal(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests, 'sin-medir');
  const env = entorno(home, 'tgs7', bin, { TYCON_MUTATION_CHECK: 'off' });

  // el corte del turno: no es un rojo que el agente pueda arreglar, así que no frena; tampoco lo vuelve verde
  const stop = spawnSync(process.execPath, [STOP_GATE], { encoding: 'utf8', env, input: JSON.stringify({ session_id: 'tgs7', hook_event_name: 'Stop' }) });
  assert.doesNotMatch(stop.stdout, /"decision":"block"/, stop.stdout);
  assert.equal(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests, 'sin-medir');

  // el paso 4 cierra, pero lo dice y lo anota
  const c4 = spawnSync(process.execPath, [MARKER_JS, 'complete-step', '4', '--no-atdd'], { encoding: 'utf8', env, cwd: d });
  assert.equal(c4.status, 0, `${c4.stdout}\n${c4.stderr}`);
  assert.match(c4.stdout + c4.stderr, /pruebas no medidas: el portón no sabe correr/);
  assert.match(c4.stdout + c4.stderr, /Cómo se corren las pruebas/);
  const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(log, /"name":"tests-not-measured"/);

  // el paso 8: la condición de pruebas está y dice que no se midió
  const m = JSON.parse(fs.readFileSync(mk, 'utf8'));
  m.stepsCompleted = [0, 1, 2, 3, 4, 5, 6, 7, '7b']; m.stepsPending = [8]; m.dodRuntimeChecked = true;
  m.clockiStarted = true; m.adoMarkedActive = true; m.deepReviewDone = true;
  fs.writeFileSync(mk, JSON.stringify(m));
  const nx = spawnSync(process.execPath, [PIPELINE_JS, 'next'], { encoding: 'utf8', env, cwd: d });
  const cond = (JSON.parse(nx.stdout).preconditions || []).find((p) => p.id === 'check-tests');
  assert.ok(cond, `sin condición de pruebas en el paso 8: ${nx.stdout}`);
  assert.match(cond.detail, /pruebas no medidas/);
});

test('T11 NoStackHere_CompanionMeasured_NotNotMeasured @story-7.45 @ac-10 — sin pruebas acá pero con el repo hermano medido, no es «sin medir»', () => {
  const bin = herramientas();
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgs-hermano-')));
  const mover = (d, destino) => { fs.renameSync(d, destino); return destino; };
  const back = mover(repo({ '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n', 'specs/s.md': STORY(['Front/backend/app/precios.py']) }), path.join(raiz, 'Back'));
  mover(repo(BACK, ['backend/app/precios.py']), path.join(raiz, 'Front'));
  const home = casa();
  const mk = markerFalso(home, 'tgs11', back);
  const r = correr(back, { bin, home, sid: 'tgs11', story: path.join(back, 'specs', 's.md') });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.no_stack, undefined, 'el repo hermano midió: no queda «sin medir»');
  assert.equal(r.art.no_suite_here, true);
  assert.equal(r.art.all_green, true);
  assert.equal(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests, 'green');
});

test('T8 CoverageReviewer_NoStack_W11NotC1 @story-7.45 @ac-8 @ac-9 — el revisor da un aviso con cómo medirlo; el paso 8 pide la línea', () => {
  const agente = fs.readFileSync(path.join(RAIZ_ARNES, 'agents', 'tycon-plugin-tests-coverage.md'), 'utf8');
  const fila = (id) => agente.split('\n').find((l) => l.startsWith(`| **${id}** |`)) || '';
  assert.match(fila('TEST-W11'), /no_stack/);
  assert.match(fila('TEST-W11'), /Configuración/);
  assert.match(fila('TEST-C1'), /no_stack.*TEST-W11/, 'TEST-C1 deja `no_stack` a TEST-W11');
  const catalogo = fs.readFileSync(path.join(RAIZ_ARNES, 'guides', 'advisor-rules-catalog.md'), 'utf8');
  assert.match(catalogo, /\| \*\*TEST-W11\*\* \|/);
  const paso8 = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-08-commit-prep.md'), 'utf8');
  assert.match(paso8, /pruebas no medidas: el portón no sabe correr/);
});
