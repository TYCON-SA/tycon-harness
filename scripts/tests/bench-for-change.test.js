'use strict';

/**
 * bench-for-change.test.js — ¿el banco de controles corre en la validación de este cambio?
 *
 * Lo que no puede pasar, y es lo que se mide acá:
 *   · que el banco deje de correr con un cambio que toca algo que lee (un freno, su biblioteca, una skill, un dato que
 *     un control lee): el banco sólo se saltea si TODO lo tocado es una suite o un dato de prueba que no lee;
 *   · que «no pude mirar» se lea como «no toca»: sin lista, con una lista vacía o ilegible, con `--all`, en `main` o con
 *     una ruta rara, corre;
 *   · que un control nuevo empiece a leer algo de `scripts/tests/` y la lista de lo que el banco no lee quede vieja:
 *     el código que el banco corre se recorre y un lector que no está anotado pone esto rojo.
 *
 * Sin bash, sin red: corre el guion con listas de laboratorio y lee el árbol.
 *
 * Correr: node --test scripts/tests/bench-for-change.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'bench-for-change.js');
const lib = require(SCRIPT);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function listFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-for-change-'));
  dirs.push(dir);
  const f = path.join(dir, 'changed.txt');
  fs.writeFileSync(f, text);
  return f;
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ask = (lines, extra = []) => run(['--changed', listFile(lines.map((l) => `${l}\n`).join('')), ...extra]);

function skips(r, why) {
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, 'no\n', `${why}: el banco no corre\n${r.err}`);
  assert.match(r.err, /^banco: no corre — /);
}
function runs(r, pattern, why) {
  assert.strictEqual(r.code, 0, `${why}: nunca sale distinto de 0 (${r.err})`);
  assert.strictEqual(r.out, 'si\n', `${why}: el banco corre\n${r.err}`);
  assert.match(r.err, pattern, `${why}: dice por qué`);
}

test('T1 BenchForChange_OnlyTestsOrTestData_TheBenchDoesNotRun — un pedido que sólo toca pruebas o datos de prueba', () => {
  skips(ask(['scripts/tests/fixtures/product-pipeline/BASE']), 'un dato de prueba en una subcarpeta');
  skips(ask(['scripts/tests/legacy-names-a.test.js', 'scripts/tests/legacy-names-b.test.js', 'scripts/tests/legacy-names-c.test.js']), 'tres suites');
  skips(ask(['scripts/tests/heavy-suites.p2.test.sh', 'scripts/tests/sub/x.test.js', 'scripts/tests/fixtures/a/b/c.json']), 'partes, subcarpetas, datos hondos');
  skips(ask(['scripts/tests/a.test.js'], ['--branch', 'refs/heads/wt/una-rama']), 'una rama que no es main');
  skips(run(['--changed', listFile('scripts/tests/a.test.js\r\n\r\nscripts/tests/b.test.sh\r\n')]), 'renglones de Windows y vacíos');
});

test('T2 BenchForChange_AnythingTheBenchReads_ItRuns — un freno, su biblioteca, las skills y cada excepción de la lista', () => {
  const reads = [
    'scripts/hooks/safety-guard-pre.sh', 'scripts/lib/skills-dir.js', 'scripts/controls-bench/cases/hooks/01-frenos-duros.json',
    'scripts/controls-bench/runner.js', 'skills/tycon-pipeline/scripts/marker.js', 'packs/bizuit/agents/x.md', 'agents/tycon-x.md',
    'integrations/clockify/hook.js', 'adapters/codex/x.js', 'build/check.js', 'pipelines/azure-pipelines-maintainers-pr.yml',
    'scripts/ci/suites-shard.js', 'guides/safety-guard.md', 'README.md', '.githooks/pre-commit',
    // dentro de scripts/tests/, lo que el código del banco sí lee
    'scripts/tests/windows/known-gaps.json', 'scripts/tests/windows/x.test.js', 'scripts/tests/lib/fake-gh.js', 'scripts/tests/lib/x.test.js',
    'scripts/tests/fixtures/codex-typed/caso.json', 'scripts/tests/fixtures/harness-managed-pieces.json',
    'scripts/tests/fixtures/stable-test-data-baseline.json', 'scripts/tests/fixtures/layer-public-wins.json',
    'scripts/tests/suites.json', 'scripts/tests/suite-parts.json', 'scripts/tests/helper.sh', 'scripts/tests/run.js',
    ...lib.PRE_PUSH_SUITES,
  ];
  for (const file of reads) runs(ask([file]), /^banco: corre — el cambio toca 1 archivo\(s\) que el banco lee/, file);
  // una sola entre muchas que no lee alcanza
  runs(ask(['scripts/tests/a.test.js', 'scripts/tests/fixtures/x/y', 'scripts/hooks/x.js']), /scripts\/hooks\/x\.js/, 'una de tres');
  const many = ask(['scripts/hooks/a.js', 'scripts/hooks/b.js', 'scripts/hooks/c.js', 'scripts/hooks/d.js']);
  runs(many, /toca 4 archivo\(s\).*\(y 1 más\)/, 'nombra tres y cuenta el resto');
});

test('T3 BenchForChange_CannotDecide_ItRuns — sin lista, vacía, ilegible, --all o main: corre, nunca «no toca»', () => {
  runs(run([]), /no hay lista del cambio/, 'sin --changed');
  runs(run(['--changed']), /no hay lista del cambio/, '--changed sin archivo');
  runs(run(['--changed', '--all']), /--all/, '--changed sin archivo y --all');
  runs(run(['--changed', path.join(os.tmpdir(), 'no-existe-bench-for-change.txt')]), /no hay lista del cambio.*no se deja leer/, 'una lista que no está');
  runs(run(['--changed', listFile('')]), /vacía/, 'una lista vacía');
  runs(run(['--changed', listFile('\n  \n\r\n')]), /vacía/, 'sólo renglones vacíos');
  runs(ask(['scripts/tests/a.test.js'], ['--all']), /no pudo acotar/, '--all');
  runs(ask(['scripts/tests/a.test.js'], ['--branch', 'main']), /la rama es main/, 'main');
  runs(ask(['scripts/tests/a.test.js'], ['--branch', 'refs/heads/main']), /la rama es main/, 'refs/heads/main');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-for-change-'));
  dirs.push(dir);
  runs(run(['--changed', dir]), /no se deja leer/, 'una carpeta en lugar de la lista');
});

test('T4 BenchForChange_OddPaths_ItRuns — una ruta que no es limpia no se juzga', () => {
  for (const odd of ['./scripts/tests/a.test.js', 'scripts/tests/../hooks/a.test.js', 'scripts/tests/./a.test.js', 'scripts/tests//a.test.js',
    '"scripts/tests/a\\303\\261o.test.js"', 'scripts\\tests\\a.test.js', '/scripts/tests/a.test.js', 'Scripts/Tests/a.test.js',
    'scripts/tests/fixtures/../../hooks/x.js', 'scripts/tests/a.test.js.bak', 'scripts/tests/fixtures/codex-typed/../x/y.json']) {
    runs(ask([odd]), /corre/, odd);
  }
});

test('T5 BenchForChange_Library_SameDecisionAsTheCommand — decide() y notRead() son lo que usa el guion', () => {
  assert.deepStrictEqual(lib.decide({ lines: ['scripts/tests/a.test.js'] }).run, false);
  assert.deepStrictEqual(lib.decide({ lines: null }).run, true);
  assert.strictEqual(lib.notRead('scripts/tests/a.test.js'), 'suite');
  assert.strictEqual(lib.notRead('scripts/tests/fixtures/x/y.json'), 'dato de prueba');
  assert.strictEqual(lib.notRead('scripts/tests/fixtures/y.json'), null);
  // un error adentro no se escapa: sale «si» con el motivo
  const out = []; const err = [];
  const code = lib.main(['--changed', listFile('scripts/tests/a.test.js\n'), '--branch', { toString() { throw new Error('rama rota'); } }], (t) => out.push(t), (t) => err.push(t));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(out, ['si\n'], err.join(''));
});

// ── la lista de lo que el banco no lee no puede quedar vieja ─────────────────────────────────────────────────────
// Busca, en el código que el banco corre (sin las carpetas de pruebas), cada renglón que no es comentario y nombra algo
// de `scripts/tests/` o arma esa ruta. Un archivo que lo hace y no está en READERS es un lector nuevo: hay que mirar qué
// lee y, si es una suite o un dato de una subcarpeta de fixtures, sacarlo de la lista de lo que el banco no lee.
const READ_PATTERN = /scripts\/tests\/|['"]tests['"]\s*,\s*['"](fixtures|windows|lib)['"]|['"]\.\.['"]\s*,\s*['"]tests['"]|['"]scripts['"]\s*,\s*['"]tests['"]/;
const COMMENT = /^\s*(\/\/|\*|\/\*|#)/;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'tests' || e.name === 'test') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs|sh)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('T6 BenchForChange_EveryReaderOfScriptsTests_IsDeclared — un control nuevo que lee scripts/tests/ pone esto rojo', () => {
  const found = new Set();
  for (const root of lib.READER_ROOTS) {
    for (const file of walk(path.join(ROOT, root), [])) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.split('\n').some((l) => !COMMENT.test(l) && READ_PATTERN.test(l))) found.add(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }
  const declared = new Set(Object.keys(lib.READERS));
  const fresh = [...found].filter((f) => !declared.has(f));
  assert.deepStrictEqual(fresh, [], `lector(es) nuevo(s) de scripts/tests/ en el código que corre el banco: ${fresh.join(' ')} — mirá qué leen y anotalos en READERS de scripts/ci/bench-for-change.js (si leen una suite o un dato de una subcarpeta de fixtures, sacalo de lo que el banco no lee)`);
  // y la lista no guarda lectores que ya no leen: así no se acumulan excepciones muertas
  const stale = [...declared].filter((f) => fs.existsSync(path.join(ROOT, f)) && !found.has(f));
  assert.deepStrictEqual(stale, [], `READERS nombra archivos que ya no leen scripts/tests/: ${stale.join(' ')}`);
});

test('T7 BenchForChange_PrePushSuites_AreTheOnesTheHookRuns — las suites del freno del empuje no se saltean', () => {
  const hook = path.join(ROOT, 'scripts', 'hooks', 'pre-push-repo-rules.js');
  if (!fs.existsSync(hook)) return;
  const named = [...new Set((fs.readFileSync(hook, 'utf8').match(/'scripts\/tests\/[^']+\.test\.(js|sh)'/g) || []).map((s) => s.slice(1, -1)))].sort();
  assert.deepStrictEqual(named, [...lib.PRE_PUSH_SUITES].sort(), 'PRE_PUSH_SUITES tiene que ser la lista que corre scripts/hooks/pre-push-repo-rules.js');
});

test('T8 BenchForChange_RealRunnerReadsKnownGaps — el corredor del banco lee scripts/tests/windows/: esa carpeta dispara', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'controls-bench', 'runner.js'), 'utf8');
  assert.match(runner, /'scripts', 'tests', 'windows', 'known-gaps\.json'/);
  assert.ok(lib.READ_TEST_FOLDERS.includes('scripts/tests/windows/'));
});
