'use strict';
/**
 * closing-evidence-merge.test.js — el freno de cierre no le cobra a un commit de merge lo que trae de main.
 *
 * El caso: una rama trae main con un merge, y main pasó una historia X a `review` en su propio pedido. El índice del
 * merge tiene a X igual que en main (`MERGE_HEAD`), así que ese cambio no es de este commit; si el freno lo juzgara,
 * frenaría el merge pidiendo la evidencia de una historia que ya pasó por su propio pedido.
 *
 * Estas pruebas corren el hook DE VERDAD (on-pre-commit.js por stdin, como lo llama Claude Code) sobre un repo armado
 * en una carpeta temporal, con una HOME temporal. Los casos:
 *   T1. X viene de main tal cual → no se juzga y el merge pasa;
 *   T2. además la historia propia Y pasa a `review` sin evidencia → frena sólo por Y, en el merge y en un commit común;
 *   T3. X se resolvió a mano (distinta de la rama y de main) → se juzga como cualquier cambio del commit.
 * Y los bordes que encontró el pase adversarial: una historia propia con nombre no ASCII (git la cita sin `-z`), el
 * commit lanzado desde una subcarpeta, y un archivo que main borró.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'on-pre-commit.js');

const FECHA = '2026-11-05T12:00:00Z';

function storyMd(id, status, extra = '') {
  return [
    '---',
    `story: ${id}`,
    `status: ${status}`,
    '---',
    '',
    `# Story ${id} — Fixture del merge`,
    '',
    '## Acceptance Criteria',
    '',
    '1. **Given** un catálogo, **Then** el listado lo muestra con su nombre.',
    '',
    'Se verifica con un smoke runtime contra la app.',
    '',
    extra,
  ].join('\n');
}

/** Arma un repo con X (9.9) e Y (9.8) en `ready-for-dev`; main pasa X a `review` y la rama queda en un merge en curso. */
function armar(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-merge-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, HOME: home };
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...a],
    { cwd: repo, stdio: 'ignore', env });
  const x = 'specs/stories/9-9-x.md';
  const y = 'specs/stories/9-8-y.md';
  const escribir = (rel, txt) => fs.writeFileSync(path.join(repo, rel), txt);
  git('init', '-q', '-b', 'main', '.');
  escribir(x, storyMd('9.9', 'ready-for-dev'));
  escribir(y, storyMd('9.8', 'ready-for-dev'));
  git('add', '.'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'rama');
  escribir('notas.txt', 'trabajo de la rama\n');
  git('add', 'notas.txt'); git('commit', '-q', '-m', 'rama');
  git('checkout', '-q', 'main');
  escribir(x, storyMd('9.9', 'review'));
  git('add', x); git('commit', '-q', '-m', 'main pasa X a review');
  git('checkout', '-q', 'rama');
  git('merge', '--no-commit', '--no-ff', '-q', 'main');
  return { repo, home, x, y, escribir, git };
}

function correrHook({ repo, home }, dir = repo) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.TYCON_WAIVER_LOG;
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: dir, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'merge-test', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git commit --no-edit' } }),
  });
  return { code: r.status, err: r.stderr || '' };
}

test('T1 MergeDeMain_HistoriaQueTraeMain_NoSeCobra', (t) => {
  const f = armar(t);
  assert.ok(fs.existsSync(path.join(f.repo, '.git', 'MERGE_HEAD')), 'el laboratorio deja un merge en curso');
  const r = correrHook(f);
  assert.equal(r.code, 0, `esperaba 0 y salió ${r.code}:\n${r.err}`);
  assert.doesNotMatch(r.err, /9-9-x|9\.9/);
});

test('T2 MergeDeMain_HistoriaPropiaSinEvidencia_Frena', async (t) => {
  await t.test('en el merge', (t) => {
    const f = armar(t);
    f.escribir(f.y, storyMd('9.8', 'review'));
    f.git('add', f.y);
    const r = correrHook(f);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /9-8-y/);
    assert.doesNotMatch(r.err, /9-9-x/);
  });
  await t.test('en un commit común', (t) => {
    const f = armar(t);
    f.git('merge', '--abort');
    f.escribir(f.y, storyMd('9.8', 'review'));
    f.git('add', f.y);
    const r = correrHook(f);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /9-8-y/);
    assert.doesNotMatch(r.err, /9-9-x/);
  });
});

test('T3 MergeDeMain_ResueltaAMano_SeJuzga', (t) => {
  const f = armar(t);
  f.escribir(f.x, storyMd('9.9', 'review', 'Nota agregada al resolver el merge.\n'));
  f.git('add', f.x);
  const r = correrHook(f);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /9-9-x/);
});

// getStagedDiff directo: sin `-z`, git cita un nombre no ASCII y con un merge en curso ese archivo se perdía. La lista
// sale en la misma forma que sin merge (lo que lee el resto del freno), y lo propio no se pierde.
test('MergeDeMain_NombreNoAscii_SigueEnLaLista', (t) => {
  const f = armar(t);
  const propia = 'specs/stories/9-7-ñandú.md';
  f.escribir(propia, storyMd('9.7', 'review'));
  f.git('add', propia);
  const lista = require(HOOK).getStagedDiff(f.repo).split('\n').filter(Boolean);
  const sinMerge = execFileSync('git', ['diff', '--cached', '--name-only', '--', propia], { cwd: f.repo, encoding: 'utf8' }).trim();
  assert.deepEqual(lista, [sinMerge], 'sólo la propia, con el nombre que da git sin merge');
});

test('MergeDeMain_CommitDesdeUnaSubcarpeta_JuzgaIgual', (t) => {
  const f = armar(t);
  f.escribir(f.y, storyMd('9.8', 'review'));
  f.git('add', f.y);
  const r = correrHook(f, path.join(f.repo, 'specs'));
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /9-8-y/);
  assert.doesNotMatch(r.err, /9-9-x/);
});

test('MergeDeMain_ArchivoQueMainBorro_NoSeCobra', (t) => {
  const f = armar(t);
  f.git('merge', '--abort');
  f.git('checkout', '-q', 'main');
  f.git('rm', '-q', f.y);
  f.git('commit', '-q', '-m', 'main borra Y');
  f.git('checkout', '-q', 'rama');
  f.git('merge', '--no-commit', '--no-ff', '-q', 'main');
  const enElIndice = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: f.repo, encoding: 'utf8' });
  assert.match(enElIndice, /9-8-y/, 'el borrado está en el diff del índice');
  const lista = require(HOOK).getStagedDiff(f.repo);
  assert.doesNotMatch(lista, /9-8-y|9-9-x/);
});
