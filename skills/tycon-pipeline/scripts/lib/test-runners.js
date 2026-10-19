'use strict';

/**
 * test-runners.js — las herramientas de prueba que la puerta sabe correr además de las de siempre (.NET, Vitest, Jest,
 * `node --test` y las suites del arnés): las de fábrica (pytest, Go, Maven, Gradle, Karma) y las que la organización
 * declara en `team-repos.json → stack.test_runners`.
 *
 * Todas se describen igual: qué archivo del proyecto las detecta, qué herramienta tiene que estar, qué comando corren,
 * qué reporte dejan y qué cobertura. `{results}` en el comando y en las rutas es la carpeta de resultados de la corrida.
 *
 * El comando sale SÓLO de esta tabla y de la configuración de la organización (la que lee stack-config.js desde el
 * árbol del arnés): nunca de un archivo del repo que se prueba. Un repo clonado de afuera no puede hacer correr nada.
 */

const fs = require('fs');
const path = require('path');

const RESULT_FORMATS = Object.freeze(['junit', 'jest-json']);
const COVERAGE_FORMATS = Object.freeze(['cobertura', 'lcov', 'istanbul-json', 'jacoco', 'go-cover']);
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const lee = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
/** ¿Hay un ejecutable con ese nombre en el PATH? */
function enElPath(nombre) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .some((d) => exts.some((e) => { try { return fs.statSync(path.join(d, nombre + e)).isFile(); } catch (_) { return false; } }));
}
const existe = (dir, f) => fs.existsSync(path.join(dir, f));

/** Las de fábrica, en orden. `detect(dir)` dice si el proyecto es de ese stack; `tool(dir)` qué binario tiene que estar. */
const FACTORY = Object.freeze([
  {
    name: 'pytest',
    // un pyproject.toml cuenta si menciona pytest (su sección o la dependencia): uno de Poetry sin pruebas no es pytest
    detect: (d) => existe(d, 'pytest.ini') || existe(d, 'conftest.py')
      || /\bpytest\b/.test(lee(d, 'pyproject.toml') || '') || /\[tool:pytest\]/.test(lee(d, 'setup.cfg') || ''),
    // `python` si está; si no, `python3` (en una Mac sólo viene python3)
    tool: () => (enElPath('python') || !enElPath('python3') ? 'python' : 'python3'),
    command: '{tool} -m pytest --junitxml={results}/junit.xml --cov --cov-report=xml:{results}/coverage.xml',
    // sin pytest-cov, pytest rechaza --cov: la puerta corre de nuevo con este comando y lo dice
    commandWithoutCoverage: '{tool} -m pytest --junitxml={results}/junit.xml',
    results: { format: 'junit', path: '{results}/junit.xml' },
    coverage: { format: 'cobertura', path: '{results}/coverage.xml' },
  },
  {
    name: 'go',
    detect: (d) => existe(d, 'go.mod'),
    tool: () => 'gotestsum',
    command: 'gotestsum --junitfile {results}/junit.xml -- -coverprofile={results}/cover.out ./...',
    results: { format: 'junit', path: '{results}/junit.xml' },
    coverage: { format: 'go-cover', path: '{results}/cover.out' },
  },
  {
    name: 'maven',
    detect: (d) => existe(d, 'pom.xml'),
    tool: () => 'mvn',
    command: 'mvn -B -q test',
    // en el proyecto, no en {results}: sólo cuentan los escritos en esta corrida (uno viejo de otra no es de ésta)
    // `alt`: un proyecto de varios módulos deja el reporte en cada módulo
    results: { format: 'junit', path: 'target/surefire-reports/*.xml', alt: '*/target/surefire-reports/*.xml', writtenDuringRun: true },
    coverage: { format: 'jacoco', path: 'target/site/jacoco/jacoco.xml', alt: '*/target/site/jacoco/jacoco.xml', optional: true, writtenDuringRun: true },
  },
  {
    name: 'gradle',
    detect: (d) => existe(d, 'build.gradle') || existe(d, 'build.gradle.kts'),
    tool: (d) => (existe(d, 'gradlew') ? './gradlew' : 'gradle'),
    // `cleanTest`: con la tarea «al día» o tomada del caché, Gradle no corre ni reescribe el reporte, y la corrida
    // saldría «sin pruebas» estando verde
    command: '{tool} cleanTest test',
    results: { format: 'junit', path: 'build/test-results/test/*.xml', alt: '*/build/test-results/test/*.xml', writtenDuringRun: true },
    coverage: { format: 'jacoco', path: 'build/reports/jacoco/test/jacocoTestReport.xml', alt: '*/build/reports/jacoco/test/jacocoTestReport.xml', optional: true, writtenDuringRun: true },
  },
  {
    name: 'karma',
    detect: (d) => existe(d, 'karma.conf.js'),
    tool: () => 'npx',
    command: 'npx karma start --single-run',
    // el reporte lo deja karma-junit-reporter donde su configuración diga: se buscan los escritos en la corrida
    results: { format: 'junit', path: '**/TESTS-*.xml', alt: '**/junit*.xml', writtenDuringRun: true },
    coverage: { format: 'lcov', path: 'coverage/**/lcov.info', optional: true, writtenDuringRun: true },
  },
]);

/**
 * Los problemas de `stack.test_runners` y los corredores que sí valen. Misma forma que `stackProblems` de
 * scripts/lib/team-repos.js (que no carga el skill): test-runners.test.js compara los dos.
 */
function validateRunners(value, base = 'stack.test_runners') {
  if (value === undefined) return { runners: [], problems: [] };
  if (!Array.isArray(value)) return { runners: [], problems: [{ path: base, message: 'tiene que ser una lista de herramientas de prueba' }] };
  const problems = []; const runners = []; const nombres = new Set();
  value.forEach((r, i) => {
    const p = `${base}.${i}`;
    const mios = [];
    if (!r || typeof r !== 'object' || Array.isArray(r)) { problems.push({ path: p, message: 'tiene que ser un objeto' }); return; }
    if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) mios.push({ path: `${p}.name`, message: `minúsculas, números y guiones (es ${JSON.stringify(r.name)})` });
    else if (nombres.has(r.name)) mios.push({ path: `${p}.name`, message: `${r.name} está repetido` });
    // misma regla que team-repos.js en todas las plataformas: ni «/x», ni «C:\x», ni «..»
    if (typeof r.detect !== 'string' || !r.detect || r.detect.startsWith('/') || r.detect.startsWith('\\') || /^[A-Za-z]:/.test(r.detect) || r.detect.split(/[\\/]/).includes('..')) {
      mios.push({ path: `${p}.detect`, message: 'el nombre de un archivo del proyecto, sin «..» ni ruta absoluta' });
    }
    if (typeof r.command !== 'string' || !r.command.trim()) mios.push({ path: `${p}.command`, message: 'falta el comando que corre las pruebas' });
    if (!r.results || !RESULT_FORMATS.includes(r.results.format) || typeof r.results.path !== 'string') {
      mios.push({ path: `${p}.results.format`, message: `el reporte tiene que ser ${RESULT_FORMATS.join(' o ')}, con su path` });
    }
    if (r.coverage !== undefined && (!r.coverage || !COVERAGE_FORMATS.includes(r.coverage.format) || typeof r.coverage.path !== 'string')) {
      mios.push({ path: `${p}.coverage.format`, message: `la cobertura tiene que ser ${COVERAGE_FORMATS.join(', ')}, con su path` });
    }
    if (typeof r.name === 'string') nombres.add(r.name);
    if (mios.length) problems.push(...mios); else runners.push(r);
  });
  return { runners, problems };
}

const conResults = (s, results) => String(s).split('{results}').join(results);

/**
 * El corredor que aplica a la carpeta `projectDir`, o null. Primero los de la organización (por su archivo detector),
 * después los de fábrica; uno de la organización con el mismo nombre que uno de fábrica lo reemplaza.
 * `stack` es la clave de la organización ya leída (stack-config.js); sin ella, sólo las de fábrica.
 */
function resolve(projectDir, opts = {}) {
  return inspect(projectDir, opts).runner;
}

/**
 * `{ runner, problems }`: el corredor que aplica y los problemas de las herramientas que declaró la organización (una
 * mal escrita no se usa, y quien la declaró se entera por acá, no por un corredor de fábrica que corre en su lugar).
 */
function inspect(projectDir, { results, stack } = {}) {
  const v = validateRunners(stack && stack.test_runners);
  const problems = v.problems.map((p) => `${p.path}: ${p.message}; no se usa`);
  return { runner: elegir(projectDir, { results, org: v.runners }), problems };
}

function elegir(projectDir, { results, org }) {
  const res = results || '{results}';
  for (const r of org) {
    if (!existe(projectDir, r.detect)) continue;
    return {
      name: r.name, source: 'organizacion', tool: r.command.trim().split(/\s+/)[0],
      command: conResults(r.command, res),
      results: { ...r.results, path: conResults(r.results.path, res) },
      coverage: r.coverage ? { ...r.coverage, path: conResults(r.coverage.path, res) } : null,
    };
  }
  const reemplazadas = new Set(org.map((r) => r.name));
  for (const f of FACTORY) {
    if (reemplazadas.has(f.name) || !f.detect(projectDir)) continue;
    const tool = f.tool(projectDir);
    return {
      name: f.name, source: 'fabrica', tool,
      command: conResults(f.command.split('{tool}').join(tool), res),
      commandWithoutCoverage: f.commandWithoutCoverage ? conResults(f.commandWithoutCoverage.split('{tool}').join(tool), res) : null,
      results: { ...f.results, path: conResults(f.results.path, res) },
      coverage: f.coverage ? { ...f.coverage, path: conResults(f.coverage.path, res) } : null,
    };
  }
  return null;
}

/** Los nombres de archivo que detectan un corredor (de fábrica o declarado): los usa test-scope.js para los candidatos. */
function detectorFiles(stack) {
  const org = validateRunners(stack && stack.test_runners).runners.map((r) => ({ file: r.detect, name: r.name }));
  return [
    ...org,
    { file: 'pytest.ini', name: 'pytest' }, { file: 'conftest.py', name: 'pytest' }, { file: 'pyproject.toml', name: 'pytest' },
    { file: 'setup.cfg', name: 'pytest' }, { file: 'go.mod', name: 'go' }, { file: 'pom.xml', name: 'maven' },
    { file: 'build.gradle', name: 'gradle' }, { file: 'build.gradle.kts', name: 'gradle' }, { file: 'karma.conf.js', name: 'karma' },
  ];
}

module.exports = { FACTORY, RESULT_FORMATS, COVERAGE_FORMATS, NAME_RE, validateRunners, resolve, inspect, detectorFiles };

// CLI para test-gate.sh: `node test-runners.js resolve <carpeta> [--results <carpeta>]` → JSON `{ runner, problems }`,
// con la configuración de la organización leída del árbol del arnés (stack-config.js), nunca del repo probado.
if (require.main === module) {
  const [cmd, dir, ...resto] = process.argv.slice(2);
  if (cmd !== 'resolve' || !dir) {
    process.stderr.write('uso: test-runners.js resolve <carpeta> [--results <carpeta>]\n');
    process.exit(2);
  }
  const i = resto.indexOf('--results');
  const results = i >= 0 ? resto[i + 1] : undefined;
  const leido = require('./stack-config.js').readStack();
  const r = inspect(dir, { results, stack: leido.stack });
  process.stdout.write(`${JSON.stringify({ runner: r.runner, problems: [...leido.problems, ...r.problems] })}\n`);
}
