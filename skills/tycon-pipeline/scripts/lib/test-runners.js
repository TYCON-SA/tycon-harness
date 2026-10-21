'use strict';

/**
 * test-runners.js — las herramientas de prueba que la puerta sabe correr además de las de siempre (.NET, Vitest, Jest,
 * `node --test` y las suites del arnés): las de fábrica (pytest, Go, Maven, Gradle, Karma, Playwright) y las que la organización
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
const { spawnSync } = require('child_process');

const RESULT_FORMATS = Object.freeze(['junit', 'jest-json', 'trx']);
// hasta dónde puede buscar su archivo detector una herramienta (`detect_depth`): 0 es sólo la carpeta que se prueba
const DETECT_DEPTH_MAX = 3;
// el detalle de un repo (`args`) va entre comillas en el comando: no puede cerrarlas ni expandir nada
const ARGS_PROHIBIDO = /["'$`\\\r\n]/;
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
const PLAYWRIGHT_CONFIGS = Object.freeze(['playwright.config.js', 'playwright.config.ts', 'playwright.config.mjs', 'playwright.config.cjs']);

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
  {
    // las pruebas de punta a punta de un front: con Vitest o Jest en la misma carpeta gana el de siempre (va antes)
    name: 'playwright',
    detect: (d) => PLAYWRIGHT_CONFIGS.some((f) => existe(d, f)),
    tool: () => 'npx',
    // el reportero junit escribe donde dice la variable; el comando lo lanza bash, así que la variable va adelante
    command: 'PLAYWRIGHT_JUNIT_OUTPUT_NAME={results}/junit.xml npx playwright test --reporter=junit',
    results: { format: 'junit', path: '{results}/junit.xml' },
    coverage: null,
    noCoverageReason: 'sin cobertura: las pruebas de punta a punta no la miden',
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
    mios.push(...detalleProblemas(r, p));
    if (typeof r.name === 'string') nombres.add(r.name);
    if (mios.length) problems.push(...mios); else runners.push(r);
  });
  return { runners, problems };
}

// Una nota en una entrada: `__x` con cualquier valor, o `_x` con texto (y un nombre que no parece una credencial). La
// misma regla que `fieldComment` de team-repos.js, que no se puede cargar acá sin el árbol del arnés.
const NOTA_SECRETO = /token|secret|sas|password|passwd|pwd|key|credential/i;
const esNota = (k, v) => k.startsWith('__')
  || (k.startsWith('_') && !NOTA_SECRETO.test(k) && (typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string'))));

/**
 * Los problemas de `detect_depth`, `args_default` y `repos` de una herramienta, con la ruta `<p>.<campo>`. Las mismas
 * reglas que `team-repos.js` (`runnersProblems`), que las repite porque no carga el skill.
 */
function detalleProblemas(r, p) {
  const out = [];
  if (r.detect_depth !== undefined && (!Number.isInteger(r.detect_depth) || r.detect_depth < 0 || r.detect_depth > DETECT_DEPTH_MAX)) {
    out.push({ path: `${p}.detect_depth`, message: `un entero de 0 a ${DETECT_DEPTH_MAX} (es ${JSON.stringify(r.detect_depth)})` });
  }
  const argsMalo = (v) => typeof v !== 'string' || ARGS_PROHIBIDO.test(v);
  const ARGS_MSG = 'texto sin comillas, $, comillas invertidas, barra invertida ni saltos de línea (va entre comillas en el comando)';
  if (r.args_default !== undefined && argsMalo(r.args_default)) out.push({ path: `${p}.args_default`, message: ARGS_MSG });
  if (r.repos === undefined) return out;
  if (!Array.isArray(r.repos)) return [...out, { path: `${p}.repos`, message: 'tiene que ser una lista de entradas { repo, args }' }];
  let lector = null;
  try { lector = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js')); } catch (_) { lector = null; }
  if (!lector) return [...out, { path: `${p}.repos`, message: 'no encontré el lector team-repos.js del arnés para validar los repos' }];
  const vistos = new Set();
  r.repos.forEach((e, j) => {
    const at = `${p}.repos.${j}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { out.push({ path: at, message: 'tiene que ser un objeto { repo, args }' }); return; }
    for (const k of Object.keys(e)) if (k !== 'repo' && k !== 'args' && !esNota(k, e[k])) out.push({ path: `${at}.${k}`, message: 'clave desconocida' });
    const malos = lector.repoProblems(e.repo, `${at}.repo`);
    if (malos.length) out.push(...malos);
    else {
      const clave = lector.identityKey(e.repo);
      if (vistos.has(clave)) out.push({ path: `${at}.repo`, message: 'este repo ya tiene una entrada en repos' });
      vistos.add(clave);
    }
    if (argsMalo(e.args)) out.push({ path: `${at}.args`, message: ARGS_MSG });
  });
  return out;
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
  const runner = elegir(projectDir, { results, org: v.runners, problems });
  return { runner, problems: [...new Set(problems)] };
}

/** El binario de un comando declarado: la primera palabra que no es una variable de entorno (`VAR=valor npx …` → npx). */
function herramientaDelComando(command) {
  const palabras = String(command).trim().split(/\s+/);
  return palabras.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) || palabras[0];
}

// las carpetas donde no se busca un archivo detector: lo que deja una compilación, las dependencias y lo oculto
const SIN_BUSCAR = new Set(['bin', 'obj', 'node_modules']);

/**
 * ¿Está el archivo `nombre` en `dir` o en sus subcarpetas, hasta `hondo` niveles? Una carpeta que no se pudo leer (que no
 * es lo mismo que no tenerlo) va a `problems`.
 */
function hallar(dir, nombre, hondo, problems) {
  try { fs.statSync(path.join(dir, nombre)); return true; } catch (e) {
    if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
      problems.push(`no pude leer ${dir} buscando ${nombre} (${e.code || e})`);
      return false;
    }
  }
  if (!hondo) return false;
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    problems.push(`no pude leer ${dir} buscando ${nombre} (${e && e.code ? e.code : e})`);
    return false;
  }
  return entradas.some((e) => e.isDirectory() && !e.name.startsWith('.') && !SIN_BUSCAR.has(e.name.toLowerCase())
    && hallar(path.join(dir, e.name), nombre, hondo - 1, problems));
}

/**
 * El repo de `dir` como lo declara `team-repos.json` (`{ platform, org, project?, repo }`), sacado de su remoto `origin`
 * (siguiendo la cadena si es el clon de un clon, como `resolverRemoto` de harness-repo.js): `{ id }`, con `id: null` sin
 * remoto o con uno que no es de Azure ni de GitHub, o `{ id: null, problema }` si no se pudo mirar. El remoto sólo elige
 * la entrada de la configuración: del repo probado no sale nada más.
 */
function repoDe(dir) {
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).error) return { id: null, problema: `no pude correr git para leer el remoto de ${dir}` };
  let r;
  try { r = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'harness-repo.js')).resolverRemoto(dir); } catch (e) {
    return { id: null, problema: `no pude cargar harness-repo.js del arnés para reconocer el remoto (${e && e.code ? e.code : e})` };
  }
  if (r.por === 'remoto-ilegible' || r.por === 'tope-de-saltos') return { id: null, problema: `no reconozco el remoto de ${dir} (${r.por}${r.url ? `: ${r.url}` : ''})` };
  const id = r.id;
  if (!id) return { id: null };
  if (id.proyecto) return { id: { platform: 'azure', org: id.org, project: id.proyecto, repo: id.repo } };
  const partes = String(id.ruta || '').split('/');
  return { id: id.host === 'github.com' && partes.length === 2 ? { platform: 'github', org: partes[0], repo: partes[1] } : null };
}

/**
 * El `{args}` de una herramienta para el repo de `dir`: el de su entrada en `repos`, si no `args_default`, si no vacío.
 * Si no se pudo saber qué repo es, se usa el de por defecto y el motivo va a `problems`.
 */
function argsPara(r, dir, problems) {
  const porDefecto = typeof r.args_default === 'string' ? r.args_default : '';
  if (!Array.isArray(r.repos) || !r.repos.length) return porDefecto;
  const { id, problema } = repoDe(dir);
  if (problema) problems.push(`${r.name}: ${problema}; uso args_default`);
  if (!id) return porDefecto;
  const { identityKey } = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));
  const quiero = identityKey(id);
  const entrada = r.repos.find((e) => identityKey(e.repo) === quiero);
  return entrada ? entrada.args : porDefecto;
}

/**
 * ¿La carpeta ya es el proyecto de otra herramienta (Vitest, Jest, `node --test`, las suites del arnés o una de
 * fábrica)? Un archivo detector encontrado sólo en una subcarpeta no le quita la carpeta a esa herramienta.
 */
function esDeOtraHerramienta(dir) {
  const pkg = lee(dir, 'package.json');
  if (pkg && (/"(vitest|jest)"/.test(pkg) || /"test"\s*:\s*"[^"]*node --test/.test(pkg))) return true;
  if (existe(dir, path.join('scripts', 'tests', 'suites.json'))) return true;
  return FACTORY.some((f) => { try { return f.detect(dir); } catch (_) { return false; } });
}

function elegir(projectDir, { results, org, problems = [] }) {
  const res = results || '{results}';
  for (const r of org) {
    if (!hallar(projectDir, r.detect, 0, problems)) {
      // encontrado sólo más abajo: vale si la carpeta no es ya de otra herramienta
      if (!r.detect_depth || !hallar(projectDir, r.detect, r.detect_depth, problems) || esDeOtraHerramienta(projectDir)) continue;
    }
    return {
      name: r.name, source: 'organizacion', tool: herramientaDelComando(r.command),
      command: conResults(r.command, res).split('{args}').join(argsPara(r, projectDir, problems)),
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
      ...(f.noCoverageReason ? { noCoverageReason: f.noCoverageReason } : {}),
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
    ...PLAYWRIGHT_CONFIGS.map((file) => ({ file, name: 'playwright' })),
  ];
}

// el archivo que se usa para declarar una copia de la de fábrica (una herramienta de la organización se detecta por un
// solo archivo) y la herramienta que se escribe en su comando
const DECLARE_AS = Object.freeze({
  pytest: { detect: 'pyproject.toml', tool: 'python' }, go: { detect: 'go.mod' }, maven: { detect: 'pom.xml' },
  gradle: { detect: 'build.gradle', tool: './gradlew' }, karma: { detect: 'karma.conf.js' },
  playwright: { detect: 'playwright.config.ts' },
});

/**
 * Las de fábrica como las ve quien configura: nombre, los archivos que la detectan, y la forma de una herramienta de la
 * organización (detect, command, results, coverage) para que «Cambiar» arranque desde ella. La lee el sitio.
 */
function factoryTable() {
  const files = detectorFiles(undefined);
  return FACTORY.map((f) => {
    const d = DECLARE_AS[f.name] || {};
    const tool = d.tool || f.tool('.');
    const strip = (x) => (x ? { format: x.format, path: x.path } : undefined);
    const out = {
      name: f.name,
      files: files.filter((x) => x.name === f.name).map((x) => x.file),
      detect: d.detect || files.find((x) => x.name === f.name).file,
      command: f.command.split('{tool}').join(tool),
      results: strip(f.results),
    };
    if (f.coverage) out.coverage = strip(f.coverage);
    return out;
  });
}

module.exports = { FACTORY, RESULT_FORMATS, COVERAGE_FORMATS, NAME_RE, validateRunners, resolve, inspect, detectorFiles, factoryTable };

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
