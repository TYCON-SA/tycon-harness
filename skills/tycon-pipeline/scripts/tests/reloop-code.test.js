#!/usr/bin/env node
'use strict';
// reloop-code.test.js — qué edición pide otra vuelta de revisores: el código del proyecto sí, aunque viva en una
// carpeta que se llama como una salida de compilación; la carpeta qa de la historia y las del arnés, no.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pideOtraVuelta } = require('../lib/reloop-code.js');

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-code-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'specs', 'qa'), { recursive: true });
  return { dir, story: path.join(dir, 'specs', 'story-9-9.md') };
}

test('CodigoEnBinOBuild_PideOtraVuelta', (t) => {
  const { dir, story } = repo(t);
  assert.equal(pideOtraVuelta(path.join(dir, 'scripts', 'bin', 'cli.js'), { storyPath: story }), true);
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'build', 'x.ts'), { storyPath: story }), true);
});

test('QaDeLaHistoria_NoPide_OtraQaDelRepo_Si', (t) => {
  const { dir, story } = repo(t);
  assert.equal(pideOtraVuelta(path.join(dir, 'specs', 'qa', 'ayuda.js'), { storyPath: story }), false);
  assert.equal(pideOtraVuelta(path.join(dir, 'qa', 'e2e', 'login.spec.ts'), { storyPath: story }), true);
});

// Un guion de ayuda en la carpeta temporal de la sesión no viaja en ningún commit: no es un arreglo. El código de
// cualquier repo de git sí lo es, aunque no sea el de la corrida (el worktree del público no siempre está declarado).
function suelta(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-suelta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('FueraDeTodoRepo_NoPideOtraVuelta', (t) => {
  // 🔴 rojo de antes: un .js del scratchpad daba true y abría «Revisores, vuelta 2»
  const { dir, story } = repo(t);
  const scratch = suelta(t);
  assert.equal(pideOtraVuelta(path.join(scratch, 'b0-vivo.js'), { storyPath: story, repoPath: dir }), false);
});

test('OtroRepoDeGit_PideOtraVuelta_TambienUnWorktree', (t) => {
  const { dir, story } = repo(t);
  const conCarpeta = suelta(t);
  fs.mkdirSync(path.join(conCarpeta, '.git'));
  assert.equal(pideOtraVuelta(path.join(conCarpeta, 'src', 'a.js'), { storyPath: story, repoPath: dir }), true);
  const worktree = suelta(t);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /en/otro/lado\n');
  assert.equal(pideOtraVuelta(path.join(worktree, 'scripts', 'x.js'), { storyPath: story, repoPath: dir }), true, 'un worktree tiene un archivo .git');
});

test('ElRepoDeLaCorrida_PideOtraVuelta_SinRepoDeclarado_ComoAntes', (t) => {
  const { dir, story } = repo(t);
  assert.equal(pideOtraVuelta(path.join(dir, 'src', 'a.js'), { storyPath: story, repoPath: dir }), true, 'el repo de la corrida, aunque no tenga .git');
  assert.equal(pideOtraVuelta(path.join(suelta(t), 'b.js'), { storyPath: story }), true, 'sin repoPath, la regla de antes');
});

test('ReviewersRound_UnGuionDelScratchpad_NoAbreOtraVuelta', (t) => {
  const { reviewersRound, SCHEME } = require('../lib/steps.js');
  const { dir, story } = repo(t);
  const t0 = Date.parse('2026-05-01T10:00:00Z');
  const iso = (min) => new Date(t0 + min * 60000).toISOString();
  const marker = {
    stepScheme: SCHEME, repoPath: dir, storyPath: story,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings'],
    stepTimings: { reviewers: { completedAt: iso(0) }, findings: { completedAt: iso(5) } },
    fileEvents: [{ path: path.join(suelta(t), 'b0-vivo.js'), ts: iso(8), code: true }],
  };
  assert.equal(reviewersRound(marker), null, 'el guion del scratchpad no es un arreglo');
  marker.fileEvents.push({ path: path.join(dir, 'src', 'a.js'), ts: iso(9) });
  assert.deepEqual(reviewersRound(marker), { round: 2 }, 'un arreglo en el repo de la corrida sí');
});

test('CarpetasDelArnes_NoPiden', (t) => {
  const { dir, story } = repo(t);
  for (const rel of ['.advisors/dod-runtime/smoke.py', '.tycon/x.js', 'node_modules/a/index.js']) {
    assert.equal(pideOtraVuelta(path.join(dir, rel), { storyPath: story }), false, rel);
  }
});
