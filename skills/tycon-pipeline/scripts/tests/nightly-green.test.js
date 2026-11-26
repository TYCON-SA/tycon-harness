#!/usr/bin/env node
'use strict';
// nightly-green.test.js — un criterio declarado imposible de probar en vivo queda cubierto sin la firma del dueño si la
// última noche corrió en verde su prueba, y esa prueba ya estaba en el commit de main que midió la noche.
// Nada mira la foto real: cada prueba arma la suya y la pasa por argumento (`file`, o `nightPhoto` a la matriz).
// stable-data: la hora de cada foto se arma desde la hora real, porque la matriz la compara con su propio reloj; los
// commits de juguete llevan fecha fija.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const NG = require(path.join(SCRIPTS, 'lib', 'nightly-green.js'));
const { coberturaDeLaUnion } = require(path.join(SCRIPTS, 'lib', 'closing-evidence.js'));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete GIT_ENV[k];

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function tmp(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Un repo con la lista de suites, una prueba de las diarias que marca el primer criterio de la historia de juguete y un código; el commit queda en `sha`. */
function lab(t) {
  const repo = tmp(t, 'nightly-green-');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', ...a], { env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  write('scripts/tests/suites.json', JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/aviso.test.js' }] }));
  write('scripts/tests/aviso.test.js', "test('T1 Aviso_QuedaRegistrado @story-9.95 @ac-1', () => {});\n");
  write('scripts/lib/aviso.js', 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { repo, git, write, sha: git('rev-parse', 'HEAD'), test: path.join(repo, 'scripts', 'tests', 'aviso.test.js') };
}

const photo = (sha, more = {}) => ({ ts: new Date(NOW - 2 * HOUR).toISOString(), ran: ['aviso.test.js'], failures: [], unmeasured: [], harness: { source: 'github', commit: sha }, ...more });

test('NG1 NightlyGreen_TheThreeConditions', (t) => {
  const L = lab(t);
  const covered = (rep, acs = [1], tests = [L.test]) => NG.nightlyCovered({ rep, story: '9.95', acs, tests, nowMs: NOW });
  // las tres cosas juntas: cubre, con la suite y la noche
  const ok = covered(photo(L.sha));
  assert.deepStrictEqual([...ok.covered.keys()], [1]);
  assert.strictEqual(ok.covered.get(1).suite, 'aviso.test.js');
  assert.strictEqual(ok.covered.get(1).noche, new Date(NOW - 2 * HOUR).toISOString().slice(0, 10));
  // un criterio que la prueba no marca no se cubre, y una prueba que no marca a nadie no se queja
  assert.strictEqual(covered(photo(L.sha), [2]).covered.size, 0);
  assert.deepStrictEqual(covered(photo(L.sha), [2]).problems, []);
  // la suite en rojo, sin medir o que no corrió esa noche: vuelve a pedir la firma, y dice por qué
  for (const [more, why] of [[{ failures: ['aviso.test.js'] }, /quedó en rojo/], [{ unmeasured: ['aviso.test.js(no-medida)'] }, /no se midió/], [{ ran: ['otra.test.js'] }, /no corrió/]]) {
    const r = covered(photo(L.sha, more));
    assert.strictEqual(r.covered.size, 0, JSON.stringify(more));
    assert.match(r.problems.join('; '), why);
  }
  // la foto vieja (más de 36 h), del futuro, sin hora o sin el commit que midió: no cubre
  assert.match(covered(photo(L.sha, { ts: new Date(NOW - 37 * HOUR).toISOString() })).problems[0], /más de 36 h/);
  assert.strictEqual(covered(photo(L.sha, { ts: new Date(NOW - 35 * HOUR).toISOString() })).covered.size, 1, 'a las 35 h todavía vale');
  assert.match(covered(photo(L.sha, { ts: new Date(NOW + 2 * HOUR).toISOString() })).problems[0], /futuro/);
  assert.match(covered(photo(L.sha, { ts: undefined })).problems[0], /no trae su hora/);
  assert.match(covered(photo(L.sha, { harness: {} })).problems[0], /qué commit de main midió/);
  // la marca entró después de la noche: la noche no corrió esa prueba con esa marca
  L.write('scripts/tests/aviso.test.js', "test('T1 Aviso_QuedaRegistrado @story-9.95 @ac-1', () => {});\ntest('T3 Otro @story-9.95 @ac-3', () => {});\n");
  L.git('commit', '-qam', 'la marca del 3');
  const later = covered(photo(L.sha), [1, 3]);
  assert.deepStrictEqual([...later.covered.keys()], [1], 'el 3 no estaba en el commit que midió la noche');
  // un commit que no está a mano no cubre
  assert.match(covered(photo('0123456789abcdef0123456789abcdef01234567')).problems[0], /no está en el commit que midió la noche/);
});

test('NG2 NightlyGreen_ReadPhoto_SameWayAsTheNotice', (t) => {
  const dir = tmp(t, 'nightly-photo-');
  const file = path.join(dir, 'ultimo-suites.json');
  fs.writeFileSync(file, JSON.stringify({ ts: 'x' }));
  // el archivo que pasa una prueba manda
  assert.deepStrictEqual(NG.readPhoto({ root: dir, file }).rep, { ts: 'x' });
  assert.match(NG.readPhoto({ root: dir, file: path.join(dir, 'no') }).problem, /no hay foto/);
  // la máquina que mantiene el arnés: lo publicado en su clon de mantenimiento
  const published = (state, text) => ({ resolve: () => ({ source: 'maintainers', dir }), readPublished: (d, rel) => { assert.strictEqual(rel, NG.PHOTO); return { state, text }; } });
  assert.deepStrictEqual(NG.readPhoto({ root: dir, nightData: published('ok', '{"ts":"y"}') }).rep, { ts: 'y' });
  assert.match(NG.readPhoto({ root: dir, nightData: published('missing', null) }).problem, /no hay foto/);
  // la variable del aviso no apunta la matriz a otra foto: con una foto buena en TYCON_SUITES_REPORT, sigue sin foto
  assert.match(NG.readPhoto({ root: dir, env: { TYCON_SUITES_REPORT: file }, nightData: published('missing', null) }).problem, /no hay foto/);
  fs.writeFileSync(file, '{roto');
  assert.match(NG.readPhoto({ root: dir, file }).problem, /no se deja leer/);
  // una máquina sin los procesos nocturnos no tiene foto; la de un dev lee la que está al lado del arnés
  assert.match(NG.readPhoto({ root: dir, nightData: { resolve: () => ({ source: null, dir: null, problem: null }) } }).problem, /no recibe los procesos nocturnos/);
  fs.mkdirSync(path.join(dir, 'scripts', 'controls-bench'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'controls-bench', 'ultimo-suites.json'), '{"ts":"z"}');
  assert.deepStrictEqual(NG.readPhoto({ root: dir, nightData: { resolve: () => ({ source: 'own', dir }) } }).rep, { ts: 'z' });
});

test('NG3 Matrix_DeclaredImpossible_CoveredByTheNight', (t) => {
  const L = lab(t);
  const story = path.join(L.repo, 'specs', 'story-9.95-juguete.md');
  L.write('specs/story-9.95-juguete.md', ['---', 'story: "9.95"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:',
    '  - scripts/lib/aviso.js', '  - scripts/tests/aviso.test.js', 'runtime_not_verifiable:', '  - ac: 1', '    reason: "lo manda un servicio de afuera"',
    '    covered_by: T1', '---', '', '# Story 9.95', '', '## Acceptance Criteria', '', '1. **Given** un pedido **Then** el aviso queda registrado.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Aviso_QuedaRegistrado` | 1 | unit | x | y |', ''].join('\n'));
  L.git('add', '.');
  L.git('commit', '-qm', 'la historia');
  fs.mkdirSync(path.join(L.repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(L.repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.95', suite_green: true }));
  const report = path.join(L.repo, '..', `${path.basename(L.repo)}-suites.json`);
  t.after(() => fs.rmSync(report, { force: true }));
  const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const matrix = (rep) => {
    fs.writeFileSync(report, JSON.stringify(rep));
    return rm.compute({ storyPath: story, nightPhoto: report });
  };
  const green = matrix(photo(L.git('rev-parse', 'HEAD')));
  assert.strictEqual(green.perAc[1].verdict, 'COVERED-NIGHTLY', JSON.stringify(green.warnings));
  assert.strictEqual(green.green, true, JSON.stringify(green.warnings));
  assert.strictEqual(green.stats.nightly, 1);
  assert.deepStrictEqual(coberturaDeLaUnion(green).porAc.get(1), ['noche'], 'el cierre lo cuenta como cubierto');
  assert.match(rm.renderMd(green), /🌙 COVERED-NIGHTLY \| .*aviso\.test\.js en verde la noche del/);
  // la noche roja vuelve a pedir la firma, y lo dice
  const red = matrix(photo(L.git('rev-parse', 'HEAD'), { failures: ['aviso.test.js'] }));
  assert.strictEqual(red.perAc[1].verdict, 'NOT-VERIFIABLE');
  assert.strictEqual(red.green, false);
  assert.match(red.warnings.join('\n'), /AC#1: la noche no lo cubre \(aviso\.test\.js quedó en rojo.*sigue esperando la firma/);
});
