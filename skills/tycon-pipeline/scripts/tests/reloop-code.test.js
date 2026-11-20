#!/usr/bin/env node
'use strict';
// reloop-code.test.js — qué edición pide otra vuelta de revisores: el código del proyecto sí, aunque viva en una
// carpeta que se llama como una salida de compilación; la carpeta qa de la historia, las del arnés, una prueba y un
// texto, no. Una prueba se reconoce por su ruta desde la raíz de su repo; un archivo sin raíz (fuera de todo repo) no
// pide otra vuelta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { pideOtraVuelta } = require('../lib/reloop-code.js');
const { reviewersRound } = require('../lib/steps.js');

function repo(t, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'specs', 'qa'), { recursive: true });
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  return { dir, story: path.join(dir, 'specs', 'story-9-9.md') };
}

// Un marcador con Hallazgos cerrado y los revisores cerrados a las 10:00; los cambios van después.
const HECHOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings'];
function marcador(dir, story, archivos) {
  return {
    storyId: '9.9', storyPath: story, repoPath: dir, stepScheme: 2, stepsCompleted: HECHOS, stepsPending: ['live-check', 'prepare-commit'],
    stepTimings: { reviewers: { completedAt: '2026-11-03T10:00:00.000Z', rounds: 1 } },
    fileEvents: archivos.map((p, i) => ({ path: path.join(dir, p), ts: `2026-11-03T10:0${i + 1}:00.000Z` })),
  };
}

test('CodigoEnBinOBuild_PideOtraVuelta', (t) => {
  const { dir, story } = repo(t, { git: true });
  assert.equal(pideOtraVuelta(path.join(dir, 'scripts', 'bin', 'cli.js'), { storyPath: story }), true);
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'build', 'x.ts'), { storyPath: story }), true);
});

test('QaDeLaHistoria_NoPide_OtraQaDelRepo_Si', (t) => {
  const { dir, story } = repo(t, { git: true });
  assert.equal(pideOtraVuelta(path.join(dir, 'specs', 'qa', 'ayuda.js'), { storyPath: story }), false);
  // otra carpeta qa del repo: su código pide otra vuelta; una prueba ahí, no
  assert.equal(pideOtraVuelta(path.join(dir, 'qa', 'e2e', 'helper.ts'), { storyPath: story }), true);
  assert.equal(pideOtraVuelta(path.join(dir, 'qa', 'e2e', 'login.spec.ts'), { storyPath: story }), false);
});

test('T5 OtraVuelta_SoloPruebas_NoPide @story-8.195 @ac-5 — cada forma de prueba, desde la raíz de su repo, no pide otra vuelta', (t) => {
  const { dir, story } = repo(t, { git: true });
  const pruebas = ['src/a.test.ts', 'src/b.spec.ts', 'web/c.test.jsx', 'test_d.py', 'pkg/e_test.go', 'Api.Tests/FooTests.cs',
    'scripts/f.test.sh', 'tests/helper.js', '__tests__/g.js'];
  for (const p of pruebas) assert.equal(pideOtraVuelta(path.join(dir, p), { storyPath: story }), false, p);
  assert.equal(reviewersRound(marcador(dir, story, pruebas)), null, 'sólo pruebas: no hay otra vuelta');
});

test('T6 OtraVuelta_SoloTextos_NoPide @story-8.195 @ac-6 — un .md y un .json no piden otra vuelta', (t) => {
  const { dir, story } = repo(t, { git: true });
  for (const p of ['docs/guia.md', 'config/x.json']) assert.equal(pideOtraVuelta(path.join(dir, p), { storyPath: story }), false, p);
  assert.equal(reviewersRound(marcador(dir, story, ['docs/guia.md', 'config/x.json'])), null);
});

test('T7 OtraVuelta_CarpetaTestsArribaDelRepo_EsCodigo @story-8.195 @ac-7 — una carpeta tests por encima de la raíz no hace prueba al código', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const raiz = path.join(base, 'tests', 'repo');
  fs.mkdirSync(path.join(raiz, '.git'), { recursive: true });
  const story = path.join(raiz, 'specs', 'story-9-9.md');
  assert.equal(pideOtraVuelta(path.join(raiz, 'src', 'a.ts'), { storyPath: story }), true);
  const r = reviewersRound(marcador(raiz, story, ['src/a.ts']));
  assert.ok(r, 'pide otra vuelta');
  assert.deepEqual(r.archivos, ['src/a.ts']);
});

test('T8 OtraVuelta_PruebaYCodigo_NombraSoloElCodigo @story-8.195 @ac-8 — pide otra vuelta y nombra sólo el código, con desde cuándo', (t) => {
  const { dir, story } = repo(t, { git: true });
  const r = reviewersRound(marcador(dir, story, ['src/a.test.ts', 'src/a.ts', 'src/a.ts']));
  assert.deepEqual(r, { round: 2, archivos: ['src/a.ts'], desde: '2026-11-03T10:02:00.000Z' });
});

test('T8b OtraVuelta_DosReposMismaRuta_NombraLosDos @story-8.195 @ac-2 — dos archivos con la misma ruta en repos distintos son dos, y se distinguen', (t) => {
  // lo cazó el pase adversarial: juntados por la ruta desde su raíz, el de un repo hermano se perdía
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const r of ['back', 'front']) fs.mkdirSync(path.join(base, r, '.git'), { recursive: true });
  const back = path.join(base, 'back');
  // front es el hermano declarado: sin declararlo, sus archivos no son de la corrida
  fs.mkdirSync(path.join(back, '.tycon'));
  fs.writeFileSync(path.join(back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - ../front\n');
  const story = path.join(back, 'specs', 'story-9-9.md');
  const m = marcador(back, story, []);
  m.fileEvents = [path.join(back, 'src', 'index.ts'), path.join(base, 'front', 'src', 'index.ts'), path.join(back, 'src', 'index.ts')]
    .map((p, i) => ({ path: p, ts: `2026-11-03T10:0${i + 1}:00.000Z`, code: true }));
  const r = reviewersRound(m);
  assert.deepEqual(r.archivos, ['back/src/index.ts', 'front/src/index.ts']);
  // sin choque, el nombre sigue siendo la ruta desde su raíz
  m.fileEvents = [{ path: path.join(base, 'front', 'src', 'app.ts'), ts: '2026-11-03T10:05:00.000Z', code: true }];
  assert.deepEqual(reviewersRound(m).archivos, ['src/app.ts']);
});

test('T12 OtraVuelta_SinRaizDeRepo_NoPide @story-8.195 @story-8.270 @ac-12 @ac-24 — sin .git arriba (o en una carpeta que ya no existe), no pide otra vuelta', (t) => {
  // la 8.270 cambia la regla de la 8.195: un archivo fuera de todo repo no está en ningún pedido y el sello no lo mira
  const { dir, story } = repo(t);
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'a.test.ts'), { storyPath: story }), false);
  assert.equal(pideOtraVuelta(path.join(dir, 'ya-no-existe', 'tests', 'b.test.ts'), { storyPath: story }), false);
  assert.equal(reviewersRound(marcador(dir, story, ['src/a.test.ts'])), null);
});

test('Reloop_FileOutsideAnyRepo_NoRound @story-8.270 @ac-24 — un guion escrito en una carpeta sin repo no pide otra vuelta', (t) => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-fuera-'));
  t.after(() => fs.rmSync(fuera, { recursive: true, force: true }));
  const guion = path.join(fuera, 'firmar-constancia.sh');
  fs.writeFileSync(guion, 'echo hola\n');
  const { dir, story } = repo(t, { git: true });
  assert.equal(pideOtraVuelta(guion, { storyPath: story }), false);
  assert.equal(pideOtraVuelta(path.join(fuera, 'ayuda.js'), { storyPath: story }), false, 'también un .js');
  const m = marcador(dir, story, []);
  m.fileEvents = [{ path: guion, ts: '2026-11-03T10:05:00.000Z', code: true }];
  assert.equal(reviewersRound(m), null, 'sin otra vuelta, aunque el evento diga código');
  // un archivo borrado dentro del repo sigue encontrando la raíz: sigue contando
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'borrado', 'x.js'), { storyPath: story }), true);
});

// 🔴 Falla con: una prueba del pase escrita en un laboratorio con su propio git (una carpeta temporal con `git init`), fuera
//    del repo de la corrida y de sus hermanos declarados, contada como código: reabre «Revisores».
test('Reloop_ProbeInLabRepoOutsideTheRun_NoRound', (t) => {
  const { dir, story } = repo(t, { git: true });
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-lab-'));
  t.after(() => fs.rmSync(lab, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', lab]);
  const prueba = path.join(lab, 'p1.js');
  assert.equal(pideOtraVuelta(prueba, { storyPath: story, repoPath: dir }), false);
  // sin el repo de la corrida no se sabe qué repos son suyos: sigue pidiendo, como antes
  assert.equal(pideOtraVuelta(prueba, { storyPath: story }), true);
  const m = marcador(dir, story, []);
  m.fileEvents = [{ path: prueba, ts: '2026-11-03T10:05:00.000Z', code: true }];
  assert.equal(reviewersRound(m), null, 'la prueba del laboratorio no pide otra vuelta');
  // el código del repo de la corrida sigue pidiendo
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'a.js'), { storyPath: story, repoPath: dir }), true);
});

// 🔴 Falla con: un archivo en otra copia (worktree) de un repo hermano declarado, en otra rama, tomado como «fuera de la
//    corrida»: el código de la story en el hermano dejaría de reabrir «Revisores».
test('Reloop_CodeInAnotherWorktreeOfADeclaredSibling_StillRounds', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-hermano-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const specs = path.join(base, 'specs-repo');
  const codigo = path.join(base, 'codigo');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  for (const r of [specs, codigo]) { fs.mkdirSync(r); execFileSync('git', ['init', '-q', '-b', 'main', r]); }
  fs.mkdirSync(path.join(specs, '.tycon'));
  fs.writeFileSync(path.join(specs, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - ../codigo\n');
  fs.writeFileSync(path.join(codigo, 'a.js'), 'a\n');
  g(codigo, 'add', '.'); g(codigo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b');
  const copia = path.join(base, 'codigo--wt-otra');
  g(codigo, 'worktree', 'add', '-q', '-b', 'otra-rama', copia);
  const story = path.join(specs, 'specs', 'story-9-9.md');
  assert.equal(pideOtraVuelta(path.join(copia, 'src', 'b.js'), { storyPath: story, repoPath: specs }), true);
  assert.equal(pideOtraVuelta(path.join(codigo, 'src', 'b.js'), { storyPath: story, repoPath: specs }), true);
  // la corrida en el repo del código, con la historia en el de specs: el código cuenta
  assert.equal(pideOtraVuelta(path.join(copia, 'src', 'b.js'), { storyPath: story, repoPath: copia }), true);
});

// 🔴 Falla con (pase adversarial): un hermano declarado que no está en disco, escrito con un nombre suelto o con «~/»,
//    resuelto como una carpeta DENTRO del repo de la corrida: no genera duda, y el código del hermano clonado en otro
//    lado deja de pedir otra vuelta.
test('Reloop_DeclaredSiblingMissing_StillRounds', (t) => {
  for (const forma of ['zzfront', '~/zzfront', '../zzfront']) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-falta-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const back = path.join(base, 'wts', 'back--wt-x');
    fs.mkdirSync(path.join(back, '.tycon'), { recursive: true });
    execFileSync('git', ['init', '-q', back]);
    fs.writeFileSync(path.join(back, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${forma}\n`);
    const otro = path.join(base, 'otra', 'zzfront');
    fs.mkdirSync(otro, { recursive: true });
    execFileSync('git', ['init', '-q', otro]);
    const story = path.join(back, 'specs', 'story-9-9.md');
    assert.equal(pideOtraVuelta(path.join(otro, 'src', 'a.js'), { storyPath: story, repoPath: back }), true, forma);
  }
});

// 🔴 Falla con (pase adversarial): el repo de la corrida escrito con otras mayúsculas, en un disco que no las distingue:
//    su propio código sale «de otro repo» y no pide otra vuelta.
test('Reloop_RunRepoWithOtherCase_StillRounds', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-may-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'MiRepo');
  execFileSync('git', ['init', '-q', real]);
  const otra = path.join(base, 'mirepo');
  if (!fs.existsSync(otra)) return console.log('⏭ el disco distingue mayúsculas: NO MEDIDO');
  assert.equal(pideOtraVuelta(path.join(real, 'src', 'a.js'), { storyPath: path.join(otra, 'specs', 's.md'), repoPath: otra }), true);
  assert.equal(pideOtraVuelta(path.join(otra, 'src', 'a.js'), { storyPath: path.join(real, 'specs', 's.md'), repoPath: real }), true);
});

test('Reloop_CodeInRepoOrWorktree_StillRounds @story-8.270 @ac-25 — código en un repo o en un worktree (con .git archivo) sigue pidiendo otra vuelta', (t) => {
  const { dir, story } = repo(t, { git: true });
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'a.js'), { storyPath: story }), true);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-wt-'));
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /tmp/en-otro-lado/.git/worktrees/x\n');
  assert.equal(pideOtraVuelta(path.join(wt, 'lib', 'b.js'), { storyPath: story }), true);
  assert.ok(reviewersRound(marcador(dir, story, ['src/a.js'])), 'pide otra vuelta');
});

test('T32 ReloopReducido_SoloPruebas_NoDispara @story-8.195 @ac-32 — un delta de sólo pruebas no repite revisores; con código, sí', (t) => {
  const PIPELINE = path.join(__dirname, '..', 'pipeline.js');
  const SID = 'test-reloop-code-t32';
  const vuelta = (archivos) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-t32-'));
    t.after(() => fs.rmSync(r, { recursive: true, force: true }));
    const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', r, ...a], {
      stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' },
    });
    fs.mkdirSync(path.join(r, 'src'));
    fs.writeFileSync(path.join(r, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(r, 'src', 'a.test.js'), '// prueba\n');
    fs.writeFileSync(path.join(r, 'story.md'), ['---', 'story: 9.9', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = Date.parse('2026-10-15T12:00:00Z');
    const ts = (s) => new Date(base + s * 1000).toISOString();
    const reales = archivos.map((f) => path.join(r, f));
    // lo de la base, antes de la foto de la vuelta 1: sólo cambia lo que se arregla
    for (const f of ['src/a.js', 'src/a.test.js']) fs.utimesSync(path.join(r, f), (base - 10000) / 1000, (base - 10000) / 1000);
    for (const [i, f] of reales.entries()) {
      fs.appendFileSync(f, '// arreglo\n');
      fs.utimesSync(f, (base + (40 + i) * 1000) / 1000, (base + (40 + i) * 1000) / 1000);
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-t32-home-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const est = path.join(home, '.claude', '.tycon-pipeline');
    fs.mkdirSync(path.join(est, 'active'), { recursive: true });
    fs.mkdirSync(path.join(est, 'advisor-runs'), { recursive: true });
    fs.writeFileSync(path.join(est, 'active', `${SID}.json`), JSON.stringify({
      storyId: '9.9', repoPath: r, filesTouched: [path.join(r, 'src', 'a.js'), ...reales],
      fileEvents: reales.map((f, i) => ({ path: f, ts: ts(40 + i) })),
      iterations: { 1: { ts: ts(30.3), filesSnapshot: [path.join(r, 'src', 'a.js')] } },
    }));
    fs.writeFileSync(path.join(est, 'advisor-runs', `${SID}.jsonl`), [
      { ts: ts(0), event: 'step5-start', iter: 1, expected: [], mode: 'advisors' },
      { ts: ts(30.2), event: 'auto-snapshot', iter: 1 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const out = spawnSync(process.execPath, [PIPELINE, 'smart-reloop', '--iter', '2', '--repo', r, '--story', path.join(r, 'story.md'), '--files', 'src/a.js'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_HOME: '', TYCON_PACKS_DEFAULT: 'all' } });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const soloPruebas = vuelta(['src/a.test.js']);
  assert.deepEqual(soloPruebas.rerun, [], `sólo pruebas: nadie repite (delta ${JSON.stringify(soloPruebas.delta_files)})`);
  assert.equal(soloPruebas.no_code_delta, true);
  const conCodigo = vuelta(['src/a.test.js', 'src/a.js']);
  assert.ok(conCodigo.rerun.length > 0, 'con código, la vuelta corre');
  assert.notEqual(conCodigo.no_code_delta, true);
});

test('CarpetasDelArnes_NoPiden', (t) => {
  const { dir, story } = repo(t);
  for (const rel of ['.advisors/dod-runtime/smoke.py', '.tycon/x.js', 'node_modules/a/index.js']) {
    assert.equal(pideOtraVuelta(path.join(dir, rel), { storyPath: story }), false, rel);
  }
});
