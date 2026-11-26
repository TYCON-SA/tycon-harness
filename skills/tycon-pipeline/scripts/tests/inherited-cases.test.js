'use strict';

/**
 * inherited-cases.test.js — las pruebas que ya fallaban antes del cambio se miden caso por caso en los repos de producto
 * (historia 8.329).
 *
 * Repos de juguete con un remoto local (rama principal `master`) y herramientas falsas en el PATH: nada de jest, dotnet
 * ni red de verdad. Lo que se mide es el juez: qué base elige, qué corre en ella, con qué dependencias, cómo compara y
 * con qué salida termina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const H = require('../lib/inherited-cases.js');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FECHA = '2026-01-01T00:00:00Z';
const gitEn = (d) => (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
});

/**
 * Un repo con `master` publicado en un remoto local (origin/HEAD → origin/master), una rama `historia` y los archivos
 * dados: `base` va en master; `cambio`, commiteado en la historia.
 */
function repo({ base = {}, cambio = { 'nuevo.txt': 'x\n' }, rama = 'master', conHead = true } = {}) {
  const d = tmp('hc-repo-');
  const git = gitEn(d);
  git('init', '-q', '-b', rama); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  const escribir = (archivos) => { for (const [rel, c] of Object.entries(archivos)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), c); } };
  escribir({ 'leeme.txt': 'base\n', ...base });
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const origen = path.join(tmp('hc-origen-'), 'o.git');
  spawnSync('git', ['clone', '-q', '--bare', d, origen]);
  git('remote', 'add', 'origin', origen); git('fetch', '-q', 'origin');
  if (conHead) git('remote', 'set-head', 'origin', rama);
  git('switch', '-q', '-c', 'historia');
  escribir(cambio);
  git('add', '-A'); git('commit', '-q', '-m', 'historia');
  return d;
}

const trx = (casos) => `<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>${
  casos.map((c, i) => `<UnitTestResult testId="t${i}" testName="${c.name}" outcome="${c.outcome}"/>`).join('')
}</Results><TestDefinitions>${
  casos.map((c, i) => `<UnitTest id="t${i}"><TestMethod codeBase="/x/${c.project}/bin/${c.project}.dll" className="Acme.${c.project}" name="${c.name}"/></UnitTest>`).join('')
}</TestDefinitions></TestRun>`;
const jestJson = (archivos) => ({
  testResults: archivos.map((a) => ({ name: a.file, status: a.status || (a.casos.some((c) => c.status === 'failed') ? 'failed' : 'passed'),
    assertionResults: a.casos.map((c) => ({ fullName: c.name, status: c.status })) })),
});
const resultados = (archivos) => { const r = tmp('hc-res-'); for (const [n, c] of Object.entries(archivos)) fs.writeFileSync(path.join(r, n), typeof c === 'string' ? c : JSON.stringify(c)); return r; };
/** Una base simulada: devuelve los casos dados y anota con qué la llamaron. */
const baseFalsa = (casos, llamadas = []) => (a) => { llamadas.push(a); return typeof casos === 'function' ? casos(a) : { casos }; };

// ── la base ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('@story-8.329 @ac-1 T1 InheritedCases_BaseRef_OriginHeadMaster', () => {
  const d = repo();
  const b = H.ramaPrincipal(d);
  assert.equal(b.ref, 'origin/master', JSON.stringify(b));
  assert.equal(b.sha, gitEn(d)('merge-base', 'HEAD', 'origin/master').stdout.trim());
  const r = resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: [{ name: 'vieja', status: 'failed' }] }]) });
  const { resultado } = H.apply(d, r, { runner: 'jest', medir: baseFalsa([]) });
  assert.equal(resultado.base.ref, 'origin/master');
  assert.equal(resultado.base.sha, b.sha);
});

test('@story-8.329 @ac-2 T2 InheritedCases_NoMainBranch_NotMeasured', () => {
  const sinRemoto = tmp('hc-sin-');
  const git = gitEn(sinRemoto);
  git('init', '-q', '-b', 'trabajo'); git('config', 'user.email', 'p@e.invalid'); git('config', 'user.name', 'p');
  fs.writeFileSync(path.join(sinRemoto, 'a.txt'), 'a'); git('add', '-A'); git('commit', '-q', '-m', 'a');
  assert.match(H.ramaPrincipal(sinRemoto).motivo, /origin\/HEAD, origin\/main ni origin\/master/);
  const r = resultados({ 'jest.json': jestJson([{ file: 'a.test.js', casos: [{ name: 'x', status: 'failed' }] }]) });
  const llamadas = [];
  const { exit, resultado } = H.apply(sinRemoto, r, { runner: 'jest', medir: baseFalsa([], llamadas) });
  assert.equal(exit, 1);
  assert.equal(llamadas.length, 0, 'sin base no corre nada');
  assert.equal(resultado.blocking[0].reason, 'no medida');
  // el árbol igual a la base y sin cambios: tampoco hay qué juzgar
  const igual = repo(); gitEn(igual)('reset', '-q', '--hard', 'origin/master');
  assert.match(H.ramaPrincipal(igual).motivo, /el árbol es la base/);
});

// ── correr en la base, con herramientas de juguete ───────────────────────────────────────────────────────────────────

/** Una carpeta de herramientas falsas. Cada una anota sus argumentos y su carpeta en FAKE_LOG. */
function herramientas() {
  const bin = tmp('hc-bin-');
  const sh = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  // npx jest …: escribe en --outputFile que «vieja» falla y «otra» pasa en cada archivo pedido; anota si ve node_modules
  sh('npx', `
echo "npx $* | modulos=$([ -f node_modules/marca ] && echo si || echo no) | casa=$HOME" >> "$FAKE_LOG"
prev=""; for a in "$@"; do [ "$prev" = "--outputFile" ] && O="$a"; prev="$a"; done
ARGS="$*" OUTPUT_FILE="$O" node -e '
const args = process.env.ARGS.split(" "); const i = args.indexOf("--runTestsByPath"); const archivos = i >= 0 ? args.slice(i + 1) : [];
const r = { testResults: archivos.map((a) => ({ name: require("path").resolve(a), status: "failed",
  assertionResults: [{ fullName: "vieja", status: "failed" }, { fullName: "otra", status: "passed" }] })) };
require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(r));'
exit 1`);
  // dotnet test <csproj> [--filter F] --results-directory D: escribe un trx con «M1» fallando; el primer proyecto sale 1
  sh('dotnet', `
echo "dotnet $*" >> "$FAKE_LOG"
csproj="$2"; prev=""; for a in "$@"; do [ "$prev" = "--results-directory" ] && D="$a"; prev="$a"; done
p="$(basename "$csproj" .csproj)"; mkdir -p "$D"
printf '%s' "$FAKE_RESULT_TEMPLATE" | sed "s/PROYECTO/$p/g" > "$D/$p.trx"
[ "$p" = "A.Tests" ] && exit 1; exit 0`);
  // una herramienta genérica: escribe un junit con «c::vieja» fallando en la ruta que le dicen
  sh('herramienta', `
echo "herramienta $*" >> "$FAKE_LOG"
for a in "$@"; do case "$a" in --junit=*) J="\${a#--junit=}";; esac; done
mkdir -p "$(dirname "$J")"
printf '<testsuites><testsuite><testcase classname="c" name="vieja"><failure/></testcase><testcase classname="c" name="otra"/></testsuite></testsuites>' > "$J"
exit 1`);
  return bin;
}
function conPath(bin, fn) {
  const viejo = process.env.PATH;
  process.env.PATH = `${bin}:${viejo}`;
  try { return fn(); } finally { process.env.PATH = viejo; }
}

test('@story-8.329 @ac-3 T3 InheritedCases_Jest_OnlyFailedFiles_LinkedNodeModules', () => {
  const d = repo({ base: { 'a.test.js': '', 'b.test.js': '', 'c.test.js': '', '.gitignore': 'node_modules\n' } });
  fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'marca'), 'x');
  const r = resultados({ 'jest.json': jestJson([
    { file: path.join(d, 'a.test.js'), casos: [{ name: 'vieja', status: 'failed' }] },
    { file: path.join(d, 'b.test.js'), casos: [{ name: 'vieja', status: 'failed' }] },
    { file: path.join(d, 'c.test.js'), casos: [{ name: 'pasa', status: 'passed' }] },
  ]) });
  const log = path.join(tmp('hc-log-'), 'log');
  process.env.FAKE_LOG = log;
  const { exit, resultado } = conPath(herramientas(), () => H.apply(d, r, { runner: 'jest' }));
  delete process.env.FAKE_LOG;
  const linea = fs.readFileSync(log, 'utf8');
  assert.match(linea, /--runTestsByPath a\.test\.js b\.test\.js \|/, linea);
  assert.doesNotMatch(linea, /c\.test\.js/, 'no corre el archivo que pasó');
  assert.match(linea, /modulos=si/, 'node_modules enlazado en la copia');
  assert.doesNotMatch(linea, new RegExp(`casa=${os.homedir()}$`, 'm'), 'no corre con la casa real');
  assert.equal(exit, 0, JSON.stringify(resultado));
  assert.equal(resultado.inherited.length, 2);
  // la copia de la base ya no está
  const copias = gitEn(d)('worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(copias.length, 1, copias.join('\n'));
});

test('@story-8.329 @ac-4 T4 InheritedCases_Dotnet_PerProjectFilter_NoChain', () => {
  const d = repo({ base: { 'tests/A.Tests/A.Tests.csproj': '<Project/>', 'tests/B.Tests/B.Tests.csproj': '<Project/>' } });
  const ahora = (proyectos, n = 1) => resultados(Object.fromEntries(proyectos.map((p) => [`${p}.trx`,
    trx(Array.from({ length: n }, (_, i) => ({ project: p, name: i ? `M${i + 1}` : 'M1', outcome: 'Failed' })))])));
  process.env.FAKE_RESULT_TEMPLATE = trx([{ project: 'PROYECTO', name: 'M1', outcome: 'Failed' }]);
  const log = path.join(tmp('hc-log-'), 'log');
  process.env.FAKE_LOG = log;
  const bin = herramientas();
  const { exit, resultado } = conPath(bin, () => H.apply(d, ahora(['A.Tests', 'B.Tests']), { runner: 'dotnet', projects: 2 }));
  const corridas = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(corridas.length, 2, 'cada proyecto aparte, también después de uno que sale 1');
  assert.ok(corridas.every((l) => /--filter FullyQualifiedName=Acme\.[AB]\.Tests\.M1/.test(l)), corridas.join('\n'));
  assert.equal(exit, 0, JSON.stringify(resultado));
  // más de 60 casos en un proyecto: corre el proyecto entero
  fs.writeFileSync(log, '');
  conPath(bin, () => H.apply(d, ahora(['A.Tests'], H.TOPE_FILTRO_DOTNET + 1), { runner: 'dotnet', projects: 1 }));
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /--filter/);
  delete process.env.FAKE_LOG; delete process.env.FAKE_RESULT_TEMPLATE;
});

test('@story-8.329 @ac-5 T5 InheritedCases_GenericJunit_ScopedOrWhole', () => {
  const d = repo({ base: { 'pruebas/x.prueba': '' } });
  const junitAhora = '<testsuites><testsuite><testcase classname="c" name="vieja"><failure/></testcase></testsuite></testsuites>';
  const log = path.join(tmp('hc-log-'), 'log');
  process.env.FAKE_LOG = log;
  const bin = herramientas();
  const conScoped = { results: { format: 'junit', path: '{results}/junit.xml' }, scoped: 'herramienta {files} --junit={results}/junit.xml', command: 'herramienta --cov --junit={results}/junit.xml', commandWithoutCoverage: 'herramienta --junit={results}/junit.xml' };
  let r = resultados({ 'junit.xml': junitAhora });
  let out = conPath(bin, () => H.apply(d, r, { runner: 'otra', generico: conScoped }));
  assert.equal(out.exit, 0, JSON.stringify(out.resultado));
  assert.equal(out.resultado.inherited[0].key, 'junit:c::vieja');
  // sin `scoped`: el comando sin cobertura
  fs.writeFileSync(log, '');
  r = resultados({ 'junit.xml': junitAhora });
  out = conPath(bin, () => H.apply(d, r, { runner: 'otra', generico: { ...conScoped, scoped: undefined } }));
  assert.equal(out.exit, 0);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /--cov/);
  delete process.env.FAKE_LOG;
});

// ── el juicio ────────────────────────────────────────────────────────────────────────────────────────────────────────

const dosFallas = (d) => resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: [{ name: 'uno', status: 'failed' }, { name: 'dos', status: 'failed' }] }]) });

test('@story-8.329 @ac-6 T6 InheritedCases_AllInherited_Exit0', () => {
  const d = repo();
  const { exit, resultado } = H.apply(d, dosFallas(d), { runner: 'jest', medir: baseFalsa([
    { key: 'js:a.test.js::uno', failed: true }, { key: 'js:a.test.js::dos', failed: true }] ) });
  assert.equal(exit, 0);
  assert.deepEqual(resultado.inherited.map((c) => c.name), ['uno', 'dos']);
  assert.equal(resultado.blocking.length, 0);
});

test('@story-8.329 @ac-7 T7 InheritedCases_PassesInBase_IsNew', () => {
  const d = repo();
  const { exit, resultado } = H.apply(d, dosFallas(d), { runner: 'jest', medir: baseFalsa([
    { key: 'js:a.test.js::uno', failed: true }, { key: 'js:a.test.js::dos', failed: false }] ) });
  assert.equal(exit, 1);
  assert.deepEqual(resultado.blocking.map((c) => [c.name, c.reason]), [['dos', 'en la base pasa: la rompió el cambio']]);
  assert.deepEqual(resultado.inherited.map((c) => c.name), ['uno']);
});

test('@story-8.329 @ac-7 T8 InheritedCases_MissingInBase_IsNew', () => {
  const d = repo();
  const { exit, resultado } = H.apply(d, dosFallas(d), { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::uno', failed: true }]) });
  assert.equal(exit, 1);
  assert.match(resultado.blocking[0].reason, /no está en la base/);
});

test('@story-8.329 @ac-7 T9 InheritedCases_BaseCouldNotRun_NotMeasured', () => {
  const d = repo({ base: { 'a.test.js': '' } });
  // el npx de la base sale sin dejar el reporte
  const bin = tmp('hc-bin-');
  fs.writeFileSync(path.join(bin, 'npx'), '#!/usr/bin/env bash\necho "Cannot find module jest-environment-jsdom" >&2\nexit 1\n'); fs.chmodSync(path.join(bin, 'npx'), 0o755);
  const r = resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: [{ name: 'uno', status: 'failed' }] }]) });
  const { exit, resultado } = conPath(bin, () => H.apply(d, r, { runner: 'jest' }));
  assert.equal(exit, 1);
  assert.equal(resultado.blocking[0].reason, 'no medida');
  assert.match(resultado.blocking[0].detail, /jest-environment-jsdom/);
});

test('@story-8.329 @ac-8 T10 InheritedCases_PartialRun_NotForgiven', () => {
  const d = repo();
  const r = resultados({ 'A.trx': trx([{ project: 'A.Tests', name: 'M1', outcome: 'Failed' }]) });
  const llamadas = [];
  const { exit, resultado } = H.apply(d, r, { runner: 'dotnet', projects: 2, medir: baseFalsa([{ key: 'trx:A.Tests::Acme.A.Tests::M1', failed: true }], llamadas) });
  assert.equal(exit, 1);
  assert.equal(resultado.partial_run, true);
  assert.match(resultado.blocking[0].detail, /no dejaron su trx/);
  assert.equal(llamadas.length, 0);
});

test('@story-8.329 @ac-9 T11 InheritedCases_Off_Unchanged', () => {
  const d = repo();
  process.env.TYCON_INHERITED_BASE_MAX = '0';
  const llamadas = [];
  try {
    const { exit } = H.apply(d, dosFallas(d), { runner: 'jest', medir: baseFalsa([], llamadas) });
    assert.equal(exit, 10);
    assert.equal(llamadas.length, 0);
  } finally { delete process.env.TYCON_INHERITED_BASE_MAX; }
});

test('@story-8.329 @ac-4 @ac-13 T18 InheritedCases_Keys_DidNotRunAndTrxProject_TooManyNotMeasured', () => {
  const d = repo();
  // el mismo testName en dos proyectos: la clave lleva el proyecto
  const r = resultados({ 'x.trx': trx([{ project: 'A.Tests', name: 'M1', outcome: 'Failed' }, { project: 'B.Tests', name: 'M1', outcome: 'Failed' }]) });
  let out = H.apply(d, r, { runner: 'dotnet', medir: baseFalsa([{ key: 'trx:A.Tests::Acme.A.Tests::M1', failed: true }, { key: 'trx:B.Tests::Acme.B.Tests::M1', failed: false }]) });
  assert.deepEqual(out.resultado.inherited.map((c) => c.project), ['A.Tests']);
  assert.deepEqual(out.resultado.blocking.map((c) => c.project), ['B.Tests']);
  // un archivo que no corrió: heredado sólo si en la base tampoco corrió (la misma marca)
  const noCorrio = resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), status: 'failed', casos: [] }]) });
  out = H.apply(d, noCorrio, { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::#did_not_run', failed: true }]) });
  assert.equal(out.exit, 0, JSON.stringify(out.resultado));
  out = H.apply(d, noCorrio, { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::#file_failed', failed: true }]) });
  assert.equal(out.exit, 1);
  // más de 500 fallas: no se mide; 130: se miden las 130, sin el tope de 100 del informe
  const muchas = (n) => resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, status: 'failed' })) }]) });
  const llamadas = [];
  out = H.apply(d, muchas(H.TOPE_FALLAS + 1), { runner: 'jest', medir: baseFalsa([], llamadas) });
  assert.equal(out.exit, 1);
  assert.equal(llamadas.length, 0);
  assert.ok(out.resultado.blocking.every((c) => c.reason === 'no medida'));
  out = H.apply(d, muchas(130), { runner: 'jest', medir: baseFalsa((a) => ({ casos: a.fallas.map((f) => ({ key: f.key, failed: true })) }), llamadas) });
  assert.equal(llamadas[0].fallas.length, 130);
  assert.equal(out.exit, 0);
});

// ── el portón entero (test-gate.sh), con jest y dotnet de juguete ───────────────────────────────────────────────────

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_INHERITED_BASE_MAX'];

/**
 * Las herramientas del portón. `npx jest`: con `--runTestsByPath` es la corrida de la base y usa FAKE_JEST_BASE; sin él,
 * la de ahora, con FAKE_JEST_AHORA. Cada una es una lista de `[archivo, nombre, estado]`. `dotnet test`: FAKE_DOTNET_<proyecto>
 * dice qué falla en ese proyecto («M1:Failed,M2:Passed»), igual ahora y en la base; anota cada corrida en FAKE_LOG.
 */
function herramientasDelPorton() {
  const bin = tmp('hc-tg-bin-');
  const js = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env node\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  js('npx', `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] !== 'jest') { console.error('npx falso: ' + a.join(' ')); process.exit(127); }
const salida = a[a.indexOf('--outputFile') + 1];
const base = a.includes('--runTestsByPath');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, (base ? 'base ' : 'ahora ') + a.join(' ') + '\\n');
const casos = JSON.parse(process.env[base ? 'FAKE_JEST_BASE' : 'FAKE_JEST_AHORA'] || '[]');
const porArchivo = new Map();
for (const [f, n, s] of casos) { if (!porArchivo.has(f)) porArchivo.set(f, []); porArchivo.get(f).push({ fullName: n, status: s }); }
const testResults = [...porArchivo].map(([f, ar]) => ({ name: path.resolve(f), status: ar.some((x) => x.status === 'failed') ? 'failed' : 'passed', assertionResults: ar }));
const fallas = casos.filter((c) => c[2] === 'failed').length;
fs.writeFileSync(salida, JSON.stringify({ numTotalTests: casos.length, numPassedTests: casos.length - fallas, numFailedTests: fallas, numPendingTests: 0, numTodoTests: 0, testResults }));
if (!base && a.includes('--coverage')) {
  fs.mkdirSync('coverage', { recursive: true });
  fs.writeFileSync('coverage/coverage-summary.json', JSON.stringify({ total: { lines: { pct: 100 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 } } }));
  fs.writeFileSync('coverage/lcov.info', 'SF:' + path.resolve('lib/a.js') + '\\nDA:1,1\\nend_of_record\\n');
}
process.exit(fallas ? 1 : 0);`);
  js('dotnet', `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'dotnet ' + a.join(' ') + '\\n');
if (a[0] !== 'test') process.exit(0);
const csproj = a[1]; const p = path.basename(csproj, '.csproj');
const dir = a[a.indexOf('--results-directory') + 1];
const casos = String(process.env['FAKE_DOTNET_' + p.replace(/\\W/g, '_')] || 'M1:Passed').split(',').map((x) => x.split(':'));
fs.mkdirSync(dir, { recursive: true });
const res = casos.map(([n, o], i) => '<UnitTestResult testId="' + p + i + '" testName="' + n + '" outcome="' + o + '"/>').join('');
const def = casos.map(([n], i) => '<UnitTest id="' + p + i + '"><TestMethod codeBase="/x/' + p + '.dll" className="Acme" name="' + n + '"/></UnitTest>').join('');
const fallas = casos.filter(([, o]) => o !== 'Passed').length;
fs.writeFileSync(path.join(dir, p + '-' + process.pid + '.trx'), '<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><ResultSummary><Counters total="' + casos.length + '" executed="' + casos.length + '" passed="' + (casos.length - fallas) + '" failed="' + fallas + '"/></ResultSummary><Results>' + res + '</Results><TestDefinitions>' + def + '</TestDefinitions></TestRun>');
process.exit(fallas ? 1 : 0);`);
  return bin;
}

function marcadorFalso(home, sid, repoDir) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.json`);
  // stable-data: el marcador de una corrida activa lleva la hora de ahora; con una vieja, la corrida se lee abandonada
  fs.writeFileSync(f, JSON.stringify({ storyId: '9.329', storyPath: '', repoPath: repoDir, sessionId: sid, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8], filesTouched: [], iterations: {}, fileEvents: [], checks: {} }));
  return f;
}

function porton(dir, { bin, home = tmp('hc-tg-home-'), sid = 'hc329', story, extra = {} } = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const args = [TEST_GATE, dir]; if (story) args.push(story);
  const r = spawnSync('bash', args, { encoding: 'utf8', cwd: dir, env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, PATH: `${bin}:${process.env.PATH}`, ...extra } });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art };
}

const REPO_JEST = { base: { 'package.json': JSON.stringify({ name: 'x', jest: {} }), 'lib/a.js': 'module.exports = 1;\n', 'a.test.js': '', '.gitignore': 'node_modules\ncoverage\n.advisors\n' },
  cambio: { 'lib/a.js': 'module.exports = 2;\n', 'b.test.js': '' } };

test('@story-8.329 @ac-6 T17 TestGate_InheritedGreen_MarksTestsCheckGreen', () => {
  const d = repo(REPO_JEST);
  const home = tmp('hc-tg-home-');
  const mk = marcadorFalso(home, 'hc17', d);
  const vieja = ['a.test.js', 'vieja', 'failed'];
  const r = porton(d, { bin: herramientasDelPorton(), home, sid: 'hc17', extra: {
    FAKE_JEST_AHORA: JSON.stringify([vieja, ['b.test.js', 'nueva', 'passed']]), FAKE_JEST_BASE: JSON.stringify([vieja]) } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.suite_green, true, JSON.stringify(r.art));
  assert.equal(r.art.suite_green_by, 'heredadas');
  assert.deepEqual(r.art.inherited_cases.inherited.map((c) => c.name), ['vieja']);
  const m = JSON.parse(fs.readFileSync(mk, 'utf8'));
  assert.equal(m.checks.tests, 'green', JSON.stringify(m.checks));
  // con una falla del cambio, sigue rojo y nombra sólo esa
  const r2 = porton(d, { bin: herramientasDelPorton(), home, sid: 'hc17', extra: {
    FAKE_JEST_AHORA: JSON.stringify([vieja, ['b.test.js', 'rota', 'failed']]), FAKE_JEST_BASE: JSON.stringify([vieja]) } });
  assert.equal(r2.status, 1, r2.out);
  assert.notEqual(r2.art.suite_green_by, 'heredadas');
  assert.deepEqual(r2.art.inherited_cases.blocking.map((c) => c.name), ['rota']);
});

test('@story-8.329 @ac-9 T11b TestGate_InheritedOff_StaysRed', () => {
  const d = repo(REPO_JEST);
  const vieja = ['a.test.js', 'vieja', 'failed'];
  const r = porton(d, { bin: herramientasDelPorton(), extra: { TYCON_INHERITED_BASE_MAX: '0',
    FAKE_JEST_AHORA: JSON.stringify([vieja]), FAKE_JEST_BASE: JSON.stringify([vieja]) } });
  assert.equal(r.status, 1, r.out);
});

const SLN = 'Project("{X}") = "A.Tests", "tests\\A.Tests\\A.Tests.csproj", "{1}"\nEndProject\nProject("{X}") = "B.Tests", "tests\\B.Tests\\B.Tests.csproj", "{2}"\nEndProject\n';
const REPO_DOTNET = { base: { 'App.sln': SLN, 'tests/A.Tests/A.Tests.csproj': '<Project/>', 'tests/B.Tests/B.Tests.csproj': '<Project/>', 'src/App.cs': 'class A {}\n', '.gitignore': '.advisors\n' },
  cambio: { 'src/App.cs': 'class A { }\n' } };

test('@story-8.329 @ac-8 T16 TestGate_Dotnet_AllProjectsRun_NoChain', () => {
  const d = repo(REPO_DOTNET);
  const log = path.join(tmp('hc-log-'), 'log');
  const r = porton(d, { bin: herramientasDelPorton(), extra: { FAKE_LOG: log, TYCON_INHERITED_BASE_MAX: '0', FAKE_DOTNET_A_Tests: 'M1:Failed', FAKE_DOTNET_B_Tests: 'M1:Passed' } });
  const corridas = fs.readFileSync(log, 'utf8').split('\n').filter((l) => /^dotnet test /.test(l));
  assert.equal(corridas.length, 2, `el segundo proyecto corre aunque el primero salga rojo:\n${corridas.join('\n')}\n${r.out}`);
  assert.equal(r.status, 1, r.out);
  assert.notEqual(r.art.partial_run, true, 'los dos dejaron su trx');
});

test('@story-8.329 @ac-8 T16b TestGate_Dotnet_InheritedInFirstProject_Green', () => {
  const d = repo(REPO_DOTNET);
  const r = porton(d, { bin: herramientasDelPorton(), extra: { FAKE_DOTNET_A_Tests: 'M1:Failed', FAKE_DOTNET_B_Tests: 'M1:Passed' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.suite_green_by, 'heredadas', JSON.stringify(r.art));
});

test('@story-8.329 @ac-12 T15 TestGate_SuitesJson_StillUsesInheritedReds', () => {
  // el juez de los repos de producto no corre con las suites del arnés: el portón lo llama sólo fuera de suites-json
  const g = fs.readFileSync(TEST_GATE, 'utf8');
  const llamada = g.split('\n').findIndex((l) => /inherited-cases\.js" apply/.test(l));
  assert.ok(llamada > 0, 'el portón llama al juez de los repos de producto');
  const condicion = g.split('\n').slice(Math.max(0, llamada - 6), llamada).join('\n');
  assert.match(condicion, /RUNNER" != "suites-json"/, condicion);
  assert.match(g, /lib\/inherited-reds\.js" apply/, 'las suites del arnés siguen con su juez');
});

test('@story-8.329 @ac-10 T12 TestGate_Companion_InheritedOnMaster_GreenTotal', () => {
  const raiz = tmp('hc-hermanos-');
  const historia = '---\nstory: "9.329"\nstatus: in-progress\nfiles_to_modify:\n  - Hermano/lib/a.js\n---\n# h\n';
  const story = repo({ base: { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Hermano\n', 'specs/s.md': historia, 'leeme.md': 'x\n' }, cambio: { 'leeme.md': 'y\n' } });
  const hermano = repo(REPO_JEST);
  const back = path.join(raiz, 'Back'); fs.renameSync(story, back);
  fs.renameSync(hermano, path.join(raiz, 'Hermano'));
  const vieja = ['a.test.js', 'vieja', 'failed'];
  const r = porton(back, { bin: herramientasDelPorton(), story: path.join(back, 'specs', 's.md'), extra: {
    FAKE_JEST_AHORA: JSON.stringify([vieja, ['b.test.js', 'nueva', 'passed']]), FAKE_JEST_BASE: JSON.stringify([vieja]) } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.all_green, true, JSON.stringify(r.art));
  const delHermano = (r.art.companions || []).find((c) => /Hermano/.test(String(c.root)));
  assert.ok(delHermano && delHermano.artifact, JSON.stringify(r.art.companions));
  const informe = JSON.parse(fs.readFileSync(delHermano.artifact, 'utf8'));
  assert.equal(informe.suite_green_by, 'heredadas', JSON.stringify(informe));
  assert.deepEqual(informe.inherited_cases.inherited.map((c) => c.name), ['vieja']);
});

test('@story-8.329 @ac-11 T14 StepRunTests_SaysHowInheritedIsJudgedInProductRepos', () => {
  const guia = fs.readFileSync(path.resolve(__dirname, '..', '..', 'steps', 'step-06-run-tests.md'), 'utf8');
  assert.match(guia, /inherited_cases/);
  assert.match(guia, /«no medido»/);
  assert.match(guia, /Nada se declara heredado a mano/);
  assert.match(guia, /origin\/master/);
});

// ── de la revisión corta: lo que haría pasar por heredada una falla del cambio ───────────────────────────────────────

test('@story-8.329 @ac-7 T19 InheritedCases_SkippedInBase_IsNotAFailure', () => {
  // 🔴 rojo si: una prueba salteada en la base (NotExecuted) cuenta como falla de allá y la que el cambio activó y rompió pasa
  const base = H.casosDeTrx((() => { const f = path.join(tmp('hc-trx-'), 'b.trx'); fs.writeFileSync(f, trx([{ project: 'A.Tests', name: 'M1', outcome: 'NotExecuted' }])); return f; })());
  assert.equal(base[0].failed, false);
  const d = repo();
  const r = resultados({ 'a.trx': trx([{ project: 'A.Tests', name: 'M1', outcome: 'Failed' }]) });
  const { exit } = H.apply(d, r, { runner: 'dotnet', medir: baseFalsa(base) });
  assert.equal(exit, 1);
  // MSTest: el mismo método en dos clases no es la misma prueba
  const dos = H.casosDeTrx((() => { const f = path.join(tmp('hc-trx-'), 'c.trx'); fs.writeFileSync(f, trx([{ project: 'A.Tests', name: 'M1', outcome: 'Failed' }]).replace('className="Acme.A.Tests"', 'className="Acme.Otra"')); return f; })());
  assert.notEqual(dos[0].key, 'trx:A.Tests::Acme.A.Tests::M1');
});

test('@story-8.329 @ac-7 T20 InheritedCases_ChangeTouchesDependencies_NotMeasured', () => {
  const d = repo({ base: { 'package.json': '{"name":"x"}', '.gitignore': 'node_modules\n' }, cambio: { 'package.json': '{"name":"x","dependencies":{"y":"2"}}' } });
  fs.mkdirSync(path.join(d, 'node_modules'));
  const llamadas = [];
  const { exit, resultado } = H.apply(d, dosFallas(d), { runner: 'jest', medir: baseFalsa([], llamadas) });
  assert.equal(exit, 1);
  assert.equal(llamadas.length, 0);
  assert.match(resultado.blocking[0].detail, /toca las dependencias \(package\.json\)/);
  // un paquete del repo enlazado en node_modules que el cambio tocó: tampoco
  const m = repo({ base: { 'packages/lib/index.js': 'a\n', '.gitignore': 'node_modules\n' }, cambio: { 'packages/lib/index.js': 'b\n' } });
  fs.mkdirSync(path.join(m, 'node_modules', '@acme'), { recursive: true });
  fs.symlinkSync(path.join(m, 'packages', 'lib'), path.join(m, 'node_modules', '@acme', 'lib'), 'dir');
  const otra = H.apply(m, dosFallas(m), { runner: 'jest', medir: baseFalsa([], llamadas) });
  assert.equal(otra.exit, 1);
  assert.match(otra.resultado.blocking[0].detail, /paquete del repo que node_modules enlaza \(packages\/lib\/index\.js\)/);
});

test('@story-8.329 @ac-7 T21 InheritedCases_BaseFailsWhatPassesNow_NotForgiven', () => {
  // 🔴 rojo si: la base falla por su entorno (un .env que git no guarda) y eso hace pasar por heredada una del cambio
  const d = repo();
  const r = resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: [{ name: 'uno', status: 'failed' }, { name: 'sana', status: 'passed' }] }]) });
  const { exit, resultado } = H.apply(d, r, { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::uno', failed: true }, { key: 'js:a.test.js::sana', failed: true }]) });
  assert.equal(exit, 1);
  assert.match(resultado.blocking[0].detail, /la base falla 1 prueba\(s\) que ahora pasan/);
});

test('@story-8.329 @ac-7 T22 InheritedCases_FailureOutsideTests_And_RepeatedKeys_NotForgiven', () => {
  const d = repo();
  const r = dosFallas(d);
  fs.writeFileSync(path.join(r, 'run.log'), '⎯⎯ Unhandled Errors ⎯⎯\n');
  let out = H.apply(d, r, { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::uno', failed: true }, { key: 'js:a.test.js::dos', failed: true }]) });
  assert.equal(out.exit, 1);
  assert.match(out.resultado.blocking[0].detail, /fuera de las pruebas/);
  // dos pruebas con el mismo nombre en el archivo: no se sabe cuál falla allá
  const rep = resultados({ 'jest.json': jestJson([{ file: path.join(d, 'a.test.js'), casos: [{ name: 'uno', status: 'failed' }, { name: 'uno', status: 'failed' }] }]) });
  out = H.apply(d, rep, { runner: 'jest', medir: baseFalsa([{ key: 'js:a.test.js::uno', failed: true }]) });
  assert.equal(out.exit, 1);
  assert.match(out.resultado.blocking[0].detail, /más de una prueba con este nombre/);
});
