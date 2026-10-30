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

test('CarpetasDelArnes_NoPiden', (t) => {
  const { dir, story } = repo(t);
  for (const rel of ['.advisors/dod-runtime/smoke.py', '.tycon/x.js', 'node_modules/a/index.js']) {
    assert.equal(pideOtraVuelta(path.join(dir, rel), { storyPath: story }), false, rel);
  }
});
