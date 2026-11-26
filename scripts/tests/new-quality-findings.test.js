'use strict';
/**
 * new-quality-findings.test.js — el aviso de la CI cuando un pedido agrega hallazgos de calidad de CodeQL.
 *
 *   T1 QualityNew_ChangedLines — los renglones que el pedido agrega o cambia, por archivo, desde `git diff -U0`
 *   T2 QualityNew_OnlyNewFindings — de los hallazgos del análisis, sólo los que caen en esos renglones
 *   T3 QualityNew_WarnsNeverRed — con hallazgos nuevos avisa (anotación y resumen) y sale 0; sin ellos lo dice
 *   T4 QualityNew_NotMeasured_Says — sin el resultado del análisis, o sin poder comparar con la base, dice «no medido»
 *      y sale 0: un aviso que no pudo medir no se calla
 *
 * 🔴 Falla con: un hallazgo viejo avisado como nuevo, uno nuevo que no avisa, un aviso que pone la CI en rojo, o un
 *    análisis que no corrió y queda en silencio.
 * stable-data: repos y archivos de juguete en el temporal; no lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'new-quality-findings.js');
const Q = require(SCRIPT);

const tmp = (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calidad-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const resultado = (uri, line, ruleId = 'js/unused-local-variable', text = 'Unused variable x.') =>
  ({ ruleId, message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }] });
const sarif = (results) => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, results }] });

test('T1 QualityNew_ChangedLines — los renglones agregados o cambiados de cada archivo', () => {
  const diff = [
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js',
    '@@ -3,0 +4,2 @@', '+uno', '+dos',
    '@@ -10 +12 @@', '-viejo', '+nuevo',
    '@@ -20,3 +23,0 @@', '-borrado', '-borrado', '-borrado',
    'diff --git a/b c.js b/b c.js', 'new file mode 100644', '--- /dev/null', '+++ b/b c.js', '@@ -0,0 +1 @@', '+hola',
    'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
  ].join('\n');
  const c = Q.changedLines(diff);
  assert.deepEqual([...c.keys()].sort(), ['a.js', 'b c.js']);
  assert.deepEqual([...c.get('a.js')].sort((x, y) => x - y), [4, 5, 12]);
  assert.deepEqual([...c.get('b c.js')], [1]);
});

test('T2 QualityNew_OnlyNewFindings — sólo los hallazgos en renglones del pedido', () => {
  const changed = new Map([['a.js', new Set([4, 12])]]);
  const s = sarif([resultado('a.js', 4), resultado('a.js', 5), resultado('otro.js', 4), resultado('a.js', 12, 'js/useless-assignment-to-local', 'Useless.')]);
  const nuevos = Q.newFindings(s, changed);
  assert.deepEqual(nuevos.map((f) => `${f.file}:${f.line}:${f.rule}`), ['a.js:4:js/unused-local-variable', 'a.js:12:js/useless-assignment-to-local']);
  // una ruta con `./` o como URI de archivo se reconoce igual; un resultado sin ubicación no rompe
  const raiz = path.posix.join('/', 'raiz', 'repo');
  const raras = sarif([resultado('./a.js', 4), resultado(`file://${raiz}/a.js`, 12), { ruleId: 'x', message: { text: 'y' } }]);
  assert.equal(Q.newFindings(raras, changed, { root: raiz }).length, 2);
});

function repo(t) {
  const d = tmp(t);
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\n');
  g('add', '-A');
  g('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\nconst b = 2;\n');
  g('add', '-A');
  g('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'pedido');
  return { d, base };
}
const correr = (cwd, args) => {
  const summary = path.join(cwd, 'resumen.md');
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, resumen: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
};

test('T3 QualityNew_WarnsNeverRed — avisa lo nuevo y sale 0', (t) => {
  const { d, base } = repo(t);
  const f = path.join(d, 'q.sarif');
  fs.writeFileSync(f, JSON.stringify(sarif([resultado('a.js', 1), resultado('a.js', 2, 'js/unused-local-variable', 'Unused variable b, with: a comma')])));
  const r = correr(d, ['--sarif', f, '--base', base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^::warning file=a\.js,line=2,title=CodeQL calidad \(js\/unused-local-variable\)::Unused variable b, with: a comma$/m);
  assert.doesNotMatch(r.out, /line=1,/, 'el renglón 1 no es del pedido');
  assert.match(r.resumen, /1 hallazgo/);
  assert.match(r.resumen, /a\.js:2/);
  // sin hallazgos nuevos: lo dice, sin anotaciones
  fs.writeFileSync(f, JSON.stringify(sarif([resultado('a.js', 1)])));
  const limpio = correr(d, ['--sarif', f, '--base', base]);
  assert.equal(limpio.code, 0, limpio.out);
  assert.doesNotMatch(limpio.out, /::warning/);
  assert.match(limpio.resumen, /sin hallazgos de calidad nuevos/i);
});

test('T4 QualityNew_NotMeasured_Says — sin análisis o sin base, «no medido» y sale 0', (t) => {
  const { d, base } = repo(t);
  const falta = correr(d, ['--sarif', path.join(d, 'no-esta.sarif'), '--base', base]);
  assert.equal(falta.code, 0, falta.out);
  assert.match(falta.out, /^::warning title=Calidad de CodeQL NO MEDIDA::/m);
  assert.match(falta.resumen, /no medid/i);
  const f = path.join(d, 'q.sarif');
  fs.writeFileSync(f, JSON.stringify(sarif([resultado('a.js', 2)])));
  const sinBase = correr(d, ['--sarif', f, '--base', '0123456789abcdef0123456789abcdef01234567']);
  assert.equal(sinBase.code, 0, sinBase.out);
  assert.match(sinBase.out, /NO MEDIDA/);
  fs.writeFileSync(f, '{ esto no es json');
  assert.match(correr(d, ['--sarif', f, '--base', base]).out, /NO MEDIDA/);
});
