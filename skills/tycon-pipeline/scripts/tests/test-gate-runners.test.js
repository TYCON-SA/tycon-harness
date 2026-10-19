'use strict';

/**
 * test-gate-runners.test.js — la puerta de pruebas corre pytest, Go, Maven, Gradle, Karma y las herramientas que declare
 * la organización, y una story que toca dos proyectos del mismo repo corre los dos.
 *
 * Herramientas falsas en el PATH (nada de Python, Go ni Java real): cada una deja en el disco el reporte JUnit y la
 * cobertura que dejaría la de verdad, y sale con el código que corresponde. Lo que se mide es la puerta: qué corre, qué
 * lee, qué informa y con qué salida termina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN'];

const junit = (casos, fallas = 0) => `<?xml version="1.0"?><testsuites><testsuite name="s">${
  Array.from({ length: casos }, (_, i) => (i < fallas ? `<testcase name="t${i}"><failure/></testcase>` : `<testcase name="t${i}"/>`)).join('')
}</testsuite></testsuites>`;

/** Una carpeta de herramientas falsas. Leen FAKE_CASES y FAKE_FAILURES; python rechaza --cov si FAKE_SIN_COV=1. */
function herramientas() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bin-'));
  const sh = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  const nodeEscribe = `node -e 'const n=+(process.env.FAKE_CASES||2),f=+(process.env.FAKE_FAILURES||0);require("fs").mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});require("fs").writeFileSync(process.argv[1], ${JSON.stringify('<?xml version="1.0"?><testsuites><testsuite name="s">')}+Array.from({length:n},(_,i)=>i<f?"<testcase name=\\"t"+i+"\\"><failure/></testcase>":"<testcase name=\\"t"+i+"\\"/>").join("")+"</testsuite></testsuites>")'`;
  sh('python', `
for a in "$@"; do
  case "$a" in
    --junitxml=*) J="\${a#--junitxml=}";;
    --cov-report=xml:*) C="\${a#--cov-report=xml:}";;
    --cov) COV=1;;
  esac
done
if [ -n "$COV" ] && [ "$FAKE_SIN_COV" = "1" ]; then echo "pytest: error: unrecognized arguments: --cov --cov-report=xml:$C" >&2; exit 4; fi
${nodeEscribe} "$J"
if [ -n "$C" ]; then printf '<coverage><sources><source>%s</source></sources><packages><package><classes><class filename="app/util.py"><lines><line number="1" hits="1"/><line number="2" hits="1"/><line number="3" hits="1"/><line number="4" hits="1"/></lines></class></classes></package></packages></coverage>' "$PWD" > "$C"; fi
echo x >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
[ "\${FAKE_FAILURES:-0}" = "0" ]`);
  sh('gotestsum', `
J="\${2}"; for a in "$@"; do case "$a" in -coverprofile=*) C="\${a#-coverprofile=}";; esac; done
${nodeEscribe} "$J"
printf 'mode: set\\nacme.io/x/main.go:1.1,2.2 1 1\\n' > "$C"
[ "\${FAKE_FAILURES:-0}" = "0" ]`);
  sh('mvn', `mkdir -p target/surefire-reports; ${nodeEscribe} target/surefire-reports/TEST-a.AppTest.xml; [ "\${FAKE_FAILURES:-0}" = "0" ]`);
  sh('gradle', `mkdir -p build/test-results/test; ${nodeEscribe} build/test-results/test/TEST-a.AppTest.xml; [ "\${FAKE_FAILURES:-0}" = "0" ]`);
  sh('npx', `
if [ "$1" = "karma" ]; then mkdir -p reports; ${nodeEscribe} reports/TESTS-Chrome.xml; [ "\${FAKE_FAILURES:-0}" = "0" ]; exit $?; fi
if [ "$1" = "vitest" ]; then
  for a in "$@"; do case "$a" in --outputFile=*) O="\${a#--outputFile=}";; esac; done
  prev=""; for a in "$@"; do [ "$prev" = "--outputFile" ] && O="$a"; prev="$a"; done
  printf '{"numTotalTests":3,"numPassedTests":3,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0}' > "$O"; exit 0
fi
echo "npx falso: no sé correr $*" >&2; exit 127`);
  return bin;
}

/** Un repo con git y los archivos dados, con un cambio sin commitear en `tocar` (para que la puerta sepa qué se tocó). */
function repo(archivos, tocar = []) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-repo-')));
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
  for (const rel of tocar) fs.appendFileSync(path.join(d, rel), '\n# tocado\n');
  return d;
}

function correr(dir, { bin, extra = {}, path: PATH } = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'));
  const r = spawnSync('bash', [TEST_GATE, dir], {
    encoding: 'utf8', cwd: dir,
    env: { ...env, HOME: home, CLAUDE_CODE_SESSION_ID: 'tg-runners', PATH: PATH || `${bin}:${process.env.PATH}`, ...extra },
  });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art };
}

test('@story-8.48 @ac-7 T8 TestGate_Pytest_Detected_RunsOnce', () => {
  const bin = herramientas();
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a = 1\nb = 2\n', 'tests/test_util.py': 'def test_a(): pass\n' }, ['app/util.py']);
  const lanzamientos = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-l-')), 'n');
  const r = correr(d, { bin, extra: { FAKE_LANZAMIENTOS: lanzamientos } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'pytest');
  assert.equal(r.art.totals.total, 2);
  assert.equal(r.art.suite_green, true);
  assert.equal(fs.readFileSync(lanzamientos, 'utf8').trim().split('\n').length, 1, 'pytest corre una sola vez');
  // la cobertura de pytest (Cobertura) se cruza con las líneas tocadas
  assert.ok(r.art.coverage.touched_lines.measurable > 0, JSON.stringify(r.art.coverage.touched_lines));
  assert.equal(r.art.coverage.touched_lines.covered, r.art.coverage.touched_lines.measurable);
});

test('@story-8.48 @ac-35 T8a TestGate_FactoryRunners_GoMavenGradleKarma', () => {
  const bin = herramientas();
  const casos = [
    ['go', { 'go.mod': 'module acme.io/x\n', 'main.go': 'package main\n' }, ['main.go']],
    ['maven', { 'pom.xml': '<project/>', 'src/main/java/a/App.java': 'class App {}\n' }, ['src/main/java/a/App.java']],
    ['gradle', { 'build.gradle': '', 'src/main/java/a/App.java': 'class App {}\n' }, ['src/main/java/a/App.java']],
    ['karma', { 'karma.conf.js': 'module.exports = () => {}\n', 'src/app.ts': 'export const a = 1\n' }, ['src/app.ts']],
  ];
  for (const [nombre, archivos, tocar] of casos) {
    const d = repo(archivos, tocar);
    const r = correr(d, { bin, extra: { FAKE_CASES: '3' } });
    assert.equal(r.status, 0, `${nombre}: ${r.out}`);
    assert.equal(r.art.runner, nombre, nombre);
    assert.equal(r.art.totals.total, 3, nombre);
  }
});

test('@story-8.48 @ac-8 T9 TestGate_Pytest_NoCov_RunsWithoutCoverage', () => {
  const bin = herramientas();
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a = 1\n' }, ['app/util.py']);
  const r = correr(d, { bin, extra: { FAKE_SIN_COV: '1' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.totals.total, 2);
  assert.match(String(r.art.coverage.no_cross_check || r.art.coverage_note || ''), /pytest-cov/);
});

test('@story-8.48 @ac-9 T11 TestGate_DeclaredRunner_UsedWithPlaceholder', () => {
  const bin = herramientas();
  // un árbol del arnés con la configuración de la organización: «elixir» declarado con su comando
  const arbol = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-arbol-')));
  fs.mkdirSync(path.join(arbol, 'scripts'));
  fs.writeFileSync(path.join(arbol, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' },
    stack: { code_extensions: ['.ex'], test_runners: [{ name: 'elixir', detect: 'mix.exs', command: 'mix test --junit {results}/j.xml', results: { format: 'junit', path: '{results}/j.xml' } }] } }));
  fs.writeFileSync(path.join(bin, 'mix'), `#!/usr/bin/env bash\nnode -e 'require("fs").writeFileSync(process.argv[1], ${JSON.stringify(junit(4))})' "$3"\n`);
  fs.chmodSync(path.join(bin, 'mix'), 0o755);
  const d = repo({ 'mix.exs': 'defmodule X do end\n', 'lib/a.ex': 'x\n' }, ['lib/a.ex']);
  const r = correr(d, { bin, extra: { TYCON_GUIDES_DIR: arbol } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'elixir');
  assert.equal(r.art.totals.total, 4);
  // una declarada con el detector de pytest gana sobre la de fábrica
  const conf = JSON.parse(fs.readFileSync(path.join(arbol, 'team-repos.json'), 'utf8'));
  conf.stack.test_runners.push({ name: 'uv-pytest', detect: 'pyproject.toml', command: 'mix test --junit {results}/j.xml', results: { format: 'junit', path: '{results}/j.xml' } });
  fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify(conf));
  const py = repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'app/util.py': 'a\n' }, ['app/util.py']);
  const rp = correr(py, { bin, extra: { TYCON_GUIDES_DIR: arbol } });
  assert.equal(rp.status, 0, rp.out);
  assert.equal(rp.art.runner, 'uv-pytest');
  assert.equal(rp.art.runner_source, 'organizacion');
});

test('@story-8.48 @ac-10 T12 TestGate_NewRunners_ZeroTests_NotGreen', () => {
  const bin = herramientas();
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a = 1\n' }, ['app/util.py']);
  const r = correr(d, { bin, extra: { FAKE_CASES: '0' } });
  assert.equal(r.status, 6, r.out);
  assert.equal(r.art.suite_green, false);
  assert.match(String(r.art.no_tests_run), /no corrió ninguna prueba/);
  // pytest que sale 0 sin dejar el JUnit: tampoco es verde, y dice por qué
  const sinJunit = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a = 1\n' }, ['app/util.py']);
  const binSin = herramientas();
  fs.writeFileSync(path.join(binSin, 'python'), '#!/usr/bin/env bash\nexit 0\n');
  const rs = correr(sinJunit, { bin: binSin });
  assert.equal(rs.status, 6, rs.out);
  assert.match(String(rs.art.totals_error), /no hay reporte JUnit/);
  // Karma sin karma-junit-reporter no deja reporte: lo dice y no es verde
  const k = repo({ 'karma.conf.js': 'module.exports = () => {}\n', 'src/a.ts': 'x\n' }, ['src/a.ts']);
  fs.writeFileSync(path.join(bin, 'npx'), '#!/usr/bin/env bash\nexit 0\n');
  const rk = correr(k, { bin });
  assert.notEqual(rk.status, 0, rk.out);
  assert.match(rk.out, /karma-junit-reporter/);
});

test('@story-8.48 @ac-11 T13 TestGate_NewRunners_MissingTool_Exit5', () => {
  // un PATH con node y git pero sin python ni gotestsum
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vacio-'));
  for (const t of ['node', 'git', 'bash', 'env', 'mktemp', 'dirname', 'basename', 'find', 'head', 'grep', 'ls', 'cat', 'rm', 'mkdir', 'date', 'sed', 'tr', 'sort', 'cp', 'awk', 'wc', 'pwd', 'tee', 'touch']) {
    const w = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(vacio, t));
  }
  for (const [archivos, tocar, falta] of [
    [{ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a\n' }, ['app/util.py'], 'python'],
    [{ 'go.mod': 'module acme.io/x\n', 'main.go': 'x\n' }, ['main.go'], 'gotestsum'],
    [{ 'pom.xml': '<project/>', 'src/main/java/a/App.java': 'x\n' }, ['src/main/java/a/App.java'], 'mvn'],
    [{ 'build.gradle': '', 'gradlew': '', 'src/main/java/a/App.java': 'x\n' }, ['src/main/java/a/App.java'], './gradlew'],
  ]) {
    const d = repo(archivos, tocar);
    const r = correr(d, { path: vacio });
    assert.equal(r.status, 5, r.out);
    assert.equal(r.art.missing_tool, falta);
    assert.equal(r.art.halted, true, 'no corrió nada');
    assert.deepEqual(r.art.totals, {});
  }
});

test('@story-8.48 @ac-10 @ac-12 TestGate_PartsAllWithoutTests_NotGreen', () => {
  // dos proyectos tocados y ninguno corre pruebas: el total no es verde (6), como en una corrida de un solo proyecto
  const bin = herramientas();
  const d = repo({ 'backend/pytest.ini': '[pytest]\n', 'backend/app/util.py': 'a\n', 'api/go.mod': 'module acme.io/x\n', 'api/main.go': 'x\n' },
    ['backend/app/util.py', 'api/main.go']);
  const r = correr(d, { bin, extra: { FAKE_CASES: '0' } });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.art.suite_green, false);
});

test('@story-8.48 @ac-12 T14 TestGate_TwoProjectsTouched_RunsBoth', () => {
  const bin = herramientas();
  const d = repo({
    'backend/pytest.ini': '[pytest]\n', 'backend/app/util.py': 'a = 1\n',
    'frontend/package.json': '{"name":"f","devDependencies":{"vitest":"1"}}', 'frontend/src/a.ts': 'export const a = 1\n',
  }, ['backend/app/util.py', 'frontend/src/a.ts']);
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.ok(Array.isArray(r.art.parts) && r.art.parts.length === 2, JSON.stringify(r.art));
  assert.deepEqual(r.art.parts.map((p) => p.scope).sort(), ['backend', 'frontend']);
  assert.equal(r.art.suite_green, true);
  // un rojo en UNA parte deja rojo el total: FAKE_FAILURES sólo lo lee el pytest falso; el vitest falso pasa igual
  const r2 = correr(d, { bin, extra: { FAKE_FAILURES: '1' } });
  assert.notEqual(r2.status, 0, r2.out);
  assert.notEqual(r2.status, 4, 'nunca el freno de alcance por tocar dos proyectos');
  assert.equal(r2.art.suite_green, false);
  const porScope = Object.fromEntries(r2.art.parts.map((p) => [p.scope, p.green]));
  assert.deepEqual(porScope, { backend: false, frontend: true }, 'sólo el back en rojo, y el total igual rojo');
});

// ── Bordes de la puerta con otros stacks: proyecto en la raíz, conftest suelto, reportes viejos, salidas reservadas ──

test('@story-8.48 @ac-35 TestGate_RootFactoryRunner_WinsOverSubdirNode', () => {
  // go.mod en la raíz y un front node en web/: tocando sólo el Go, corre Go (no el vitest de la subcarpeta)
  const bin = herramientas();
  const d = repo({ 'go.mod': 'module acme.io/x\n', 'main.go': 'package main\n', 'web/package.json': '{"devDependencies":{"vitest":"1"}}', 'web/a.ts': 'x\n' }, ['main.go']);
  const r = correr(d, { bin, extra: { FAKE_FAILURES: '1' } });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.art.runner, 'go');
});

test('@story-8.48 @ac-12 TestGate_RootPytestPlusFront_BothRun', () => {
  // pytest en la raíz (código en app/) y vitest en frontend/: tocando los dos, corren los dos, y un rojo del back cuenta
  const bin = herramientas();
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a\n', 'frontend/package.json': '{"devDependencies":{"vitest":"1"}}', 'frontend/a.ts': 'x\n' },
    ['app/util.py', 'frontend/a.ts']);
  const r = correr(d, { bin, extra: { FAKE_FAILURES: '1' } });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual((r.art.parts || []).map((p) => p.scope).sort(), ['.', 'frontend']);
});

test('@story-8.48 @ac-32 TestGate_LooseConftest_DoesNotMakeAProject', () => {
  // un repo node con vitest en la raíz y un conftest.py suelto en scripts/: sigue corriendo vitest, sin frenar
  const bin = herramientas();
  const d = repo({ 'package.json': '{"devDependencies":{"vitest":"1"}}', 'src/a.ts': 'x\n', 'scripts/conftest.py': '' }, ['src/a.ts']);
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'vitest');
});

test('@story-8.48 @ac-13 TestGate_StaleJacoco_NotCounted', () => {
  // un jacoco.xml de otra corrida que mvn no reescribe no cuenta como cobertura de ésta
  const bin = herramientas();
  const d = repo({ 'pom.xml': '<project/>', 'src/main/java/a/App.java': 'x\n',
    'target/site/jacoco/jacoco.xml': '<report><package name="a"><sourcefile name="App.java"><line nr="1" mi="0" ci="1"/></sourcefile></package></report>' },
  ['src/main/java/a/App.java']);
  const viejo = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(d, 'target', 'site', 'jacoco', 'jacoco.xml'), viejo, viejo);
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.match(JSON.stringify(r.art.coverage), /no dejó reporte de cobertura/);
});

test('@story-8.48 @ac-10 TestGate_PytestExit5_IsNoTestsNotMissingTool', () => {
  // pytest sale 5 cuando no encontró pruebas: la puerta sale 6 («cero pruebas»), no 5 («falta la herramienta»)
  const bin = herramientas();
  fs.writeFileSync(path.join(bin, 'python'), '#!/usr/bin/env bash\nexit 5\n');
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a\n' }, ['app/util.py']);
  const r = correr(d, { bin });
  assert.equal(r.status, 6, r.out);
  assert.match(String(r.art.no_tests_run), /no encontró ninguna prueba/);
});

test('@story-8.48 @ac-10 TestGate_ExitZeroWithFailuresInReport_IsRed', () => {
  // mvn sale 0 con una prueba fallida en el reporte (testFailureIgnore): no es verde
  const bin = herramientas();
  const d = repo({ 'pom.xml': '<project/>', 'src/main/java/a/App.java': 'x\n' }, ['src/main/java/a/App.java']);
  fs.writeFileSync(path.join(bin, 'mvn'), `#!/usr/bin/env bash\nmkdir -p target/surefire-reports\nprintf '%s' '${junit(3, 1)}' > target/surefire-reports/TEST-a.xml\nexit 0\n`);
  const r = correr(d, { bin });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.art.suite_green, false);
});

test('@story-8.48 @ac-35 TestGate_MavenMultiModule_ReportsFound', () => {
  // un pom.xml raíz con el reporte en mod-a/target/surefire-reports: se encuentra y se cuenta
  const bin = herramientas();
  fs.writeFileSync(path.join(bin, 'mvn'), `#!/usr/bin/env bash\nmkdir -p mod-a/target/surefire-reports\nprintf '%s' '${junit(5)}' > mod-a/target/surefire-reports/TEST-a.xml\nexit 0\n`);
  const d = repo({ 'pom.xml': '<project/>', 'mod-a/pom.xml': '<project/>', 'mod-a/src/main/java/a/App.java': 'x\n' }, ['mod-a/src/main/java/a/App.java']);
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.totals.total, 5);
});

test('@story-8.48 @ac-7 TestGate_PytestRootWithNestedCsproj_RunsPytest', () => {
  // pytest.ini en la raíz y un .csproj más abajo: el proyecto de la raíz es pytest, no .NET
  const bin = herramientas();
  const d = repo({ 'pytest.ini': '[pytest]\n', 'app/util.py': 'a\n', 'tools/x/X.csproj': '<Project/>' }, ['app/util.py']);
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'pytest');
});

test('@story-8.48 @ac-12 TestGate_Parts_SealedCopyIsTheTotal', () => {
  // con una parte roja, la copia que viaja (la que lee la matriz) dice el total: rojo
  const bin = herramientas();
  const d = repo({ 'backend/pytest.ini': '[pytest]\n', 'backend/app/util.py': 'a\n', 'frontend/package.json': '{"devDependencies":{"vitest":"1"}}', 'frontend/a.ts': 'x\n',
    'specs/story-9.48.md': '---\nstory: "9.48"\nfiles_to_modify:\n  - backend/app/util.py\n  - frontend/a.ts\n---\n# x\n' }, ['backend/app/util.py', 'frontend/a.ts']);
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, d, path.join(d, 'specs', 'story-9.48.md')], { encoding: 'utf8', cwd: d,
    env: { ...env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-')), CLAUDE_CODE_SESSION_ID: 'tg-sello', PATH: `${bin}:${process.env.PATH}`, FAKE_FAILURES: '1' } });
  assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const sello = path.join(d, '.advisors', 'dod-runtime', '9.48-tests-result.json');
  assert.ok(fs.existsSync(sello), `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(sello, 'utf8')).suite_green, false);
});
