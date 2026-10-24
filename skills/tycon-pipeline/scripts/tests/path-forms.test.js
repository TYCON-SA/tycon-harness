#!/usr/bin/env node
'use strict';
/**
 * path-forms.test.js — las decisiones de forma de ruta del pipeline, medidas con rutas de Windows desde cualquier sistema.
 *
 * QUÉ CUIDA: en Windows una ruta llega con `\`, con letra de unidad o con otra caja, y el arnés decidía con el `path` de
 * la plataforma o con expresiones que sólo entienden `/`. Dos de esas decisiones daban un verde falso: el aviso de
 * «tenés pruebas de navegador y no declaraste el portón» no salía nunca, y un archivo de otra unidad contaba como
 * «dentro del repo» y la selección de apps quedaba en cero en vez de «corré todas». Cada decisión vive en
 * `lib/path-forms.js` y recibe el módulo `path`: acá se le pasa `path.win32` o `path.posix`.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/path-forms.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const pf = require(path.join(LIB, 'path-forms.js'));

test('T14 RutasDeWindows_SinVerdeFalso @story-8.115 @ac-12 — la carpeta e2e se reconoce con cualquier separador', () => {
  for (const f of ['C:\\r\\e2e\\a.spec.ts', 'C:\\r\\app\\tests\\e2e\\a.spec.ts', '/r/e2e/a.spec.ts', '/r/app/tests/e2e/a.spec.ts', 'e2e/a.spec.ts']) {
    assert.strictEqual(pf.isE2eSpecPath(f), true, f);
  }
  for (const f of ['C:\\r\\src\\a.spec.ts', '/r/src/a.spec.ts', 'C:\\r\\e2e\\a.test.ts', 'C:\\r\\e2ework\\a.spec.ts']) {
    assert.strictEqual(pf.isE2eSpecPath(f), false, f);
  }
});

test('T14 RutasDeWindows_SinVerdeFalso @story-8.115 @ac-12 — un archivo de otra unidad no cuenta como dentro del repo', () => {
  const w = path.win32;
  assert.strictEqual(pf.relativeInsideRepo('C:\\repo', 'C:\\repo\\src\\a.ts', w), 'src/a.ts');
  // otra unidad: path.relative devuelve una ruta absoluta, no `..\`; eso es «fuera», y con nada adentro se corre todo
  assert.strictEqual(pf.relativeInsideRepo('C:\\repo', 'D:\\tmp\\a.ts', w), null);
  assert.strictEqual(pf.relativeInsideRepo('C:\\repo', 'C:\\otro\\a.ts', w), null);
  assert.strictEqual(pf.relativeInsideRepo('C:\\repo', 'C:\\repo', w), null, 'la raíz misma no es un archivo del repo');
  const p = path.posix;
  assert.strictEqual(pf.relativeInsideRepo('/repo', '/repo/src/a.ts', p), 'src/a.ts');
  assert.strictEqual(pf.relativeInsideRepo('/repo', '/otro/a.ts', p), null);
});

test('T14 RutasDeWindows_SinVerdeFalso @story-8.115 @ac-12 — la ruta relativa al repo se anota con /', () => {
  assert.strictEqual(pf.posixRelative('C:\\repo', 'C:\\repo\\tests\\Permisos.test.js', path.win32), 'tests/Permisos.test.js');
  assert.strictEqual(pf.posixRelative('/repo', '/repo/tests/Permisos.test.js', path.posix), 'tests/Permisos.test.js');
});

test('T14 RutasDeWindows_SinVerdeFalso @story-8.115 @ac-12 — el pipeline usa estas decisiones, no una copia propia', () => {
  // las funciones se miden acá con rutas de Windows; si un guion dejara de llamarlas, esa medición no lo cubriría
  const leer = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const pipeline = leer('pipeline.js');
  assert.match(pipeline, /require\('\.\/lib\/path-forms\.js'\)/, 'pipeline.js carga path-forms');
  assert.match(pipeline, /isE2eSpecPath\(path\.join\(dir, e\.name\)\)/, 'hasPlaywrightSpecs decide con isE2eSpecPath');
  assert.ok((pipeline.match(/relativeInsideRepo\(/g) || []).length >= 3, 'selectE2eApps decide «dentro del repo» con relativeInsideRepo');
  assert.match(leer('marker.js'), /dest: posixRelative\(repo, dest\)/, 'promote-probe anota dest con posixRelative');
  const atdd = leer(path.join('lib', 'atdd-commit-gate.js'));
  assert.ok((atdd.match(/isInsideRepo\(e\.path, repoRoot\)/g) || []).length === 2, 'eventsForRepo y pruneFileEvents comparan con isInsideRepo');
});

test('T16 AtddCommitGate_RutasMezcladas @story-8.115 @ac-14 — los eventos del repo se reconocen con barras y cajas mezcladas', () => {
  const w = path.win32;
  assert.strictEqual(pf.isInsideRepo('C:\\u\\repo\\src\\a.ts', 'C:/u/repo', w), true, 'raíz con / (git), archivo con \\ (la herramienta)');
  assert.strictEqual(pf.isInsideRepo('C:\\u\\repo\\src\\a.ts', 'c:/u/repo', w), true, 'la letra de unidad en otra caja');
  assert.strictEqual(pf.isInsideRepo('C:/u/repo/src/a.ts', 'C:\\u\\repo\\', w), true, 'raíz con separador final');
  assert.strictEqual(pf.isInsideRepo('C:\\u\\repo2\\x.ts', 'C:/u/repo', w), false, 'otro repo con el mismo comienzo');
  const p = path.posix;
  // la Mac también ignora mayúsculas por defecto: encontrar de más hace avisar más, nunca menos
  assert.strictEqual(pf.isInsideRepo('/Repo/a.ts', '/repo', p), true);
  assert.strictEqual(pf.isInsideRepo('/repos/back2/x.ts', '/repos/back', p), false);
});

test('T16 AtddCommitGate_RutasMezcladas @story-8.115 @ac-14 — atdd-commit-gate juzga y limpia los eventos del repo aunque cambie la caja', () => {
  const gate = require(path.join(LIB, 'atdd-commit-gate.js'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'path-forms-'));
  try {
    const sid = 's-caja';
    const root = path.join(state, 'repos', 'back');
    const otro = path.join(state, 'repos', 'back2');
    const enOtraCaja = path.join(state, 'repos', 'BACK', 'src', 'a.ts');
    gate.recordFileEvent(state, sid, enOtraCaja, '2026-10-24T10:00:00.000Z');
    gate.recordFileEvent(state, sid, path.join(root, 'tests', 'a.test.ts'), '2026-10-24T10:01:00.000Z');
    gate.recordFileEvent(state, sid, path.join(otro, 'x.ts'), '2026-10-24T10:02:00.000Z');
    const del = gate.eventsForRepo(state, sid, root).map((e) => e.path);
    assert.deepStrictEqual(del.sort(), [enOtraCaja, path.join(root, 'tests', 'a.test.ts')].sort(), 'los dos del repo, ninguno de back2');
    gate.pruneFileEvents(state, sid, root);
    assert.deepStrictEqual(gate.readFileEvents(state, sid).map((e) => e.path), [path.join(otro, 'x.ts')], 'se limpia lo que se juzgó');
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});
