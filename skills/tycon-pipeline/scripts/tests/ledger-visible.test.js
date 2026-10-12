#!/usr/bin/env node
/**
 * ledger-visible.test.js — el portón no deja editar código por Bash con el pipeline abierto,
 * porque esa edición el registro NO la ve.
 *
 * Caso disparador (Story OC-1 del backend de un producto del equipo, 2026-09-21): la corrida editó casi todo con
 * `sed`/heredocs —lo que el modo bypass del arnés INSTRUYE hacer— y al re-loopear `smart-reloop`
 * no pudo calcular el delta: set COMPLETO, 7 revisores en vez de 2-3. El aviso existía y era
 * honesto, pero llegaba con el trabajo ya hecho.
 *
 * Decisión del dev: frenar la edición invisible en vez de enseñarle al arnés a leerla — atacar el
 * origen, sin relajar la garantía de `ledger-honesty` ni meter fechas inferidas en el registro que
 * usa el gate ATDD para el orden test-antes-que-código.
 *
 * Correr: node --test .../scripts/tests/ledger-visible.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const lv = require('../lib/ledger-visible.js');

const REPO = '/repo';
const dentro = (f, r) => String(f).startsWith(String(r) + '/');
const abierto = { repoPath: REPO, storyId: 'OC-1', stepsPending: [5, 6, 7, 8] };
const cerrado = { repoPath: REPO, storyId: 'OC-1', stepsPending: [] };

test('pipelineAbierto distingue corrida viva de corrida terminada', () => {
  assert.equal(lv.pipelineAbierto(abierto), true);
  assert.equal(lv.pipelineAbierto(cerrado), false, 'sin steps pendientes la corrida terminó');
  assert.equal(lv.pipelineAbierto({ repoPath: REPO }), false, 'sin stepsPending no hay corrida');
  assert.equal(lv.pipelineAbierto(null), false);
  assert.equal(lv.pipelineAbierto('nope'), false);
});

test('EL CASO: código del repo + pipeline abierto → frena', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, true);
  assert.deepEqual(r.files, ['/repo/src/Foo.cs']);
  const m = lv.mensaje(r.files, abierto.storyId);
  assert.match(m, /Edit/, 'tiene que decir QUÉ hacer, no sólo que está prohibido');
  assert.match(m, /smart-reloop|set COMPLETO/, 'y la consecuencia concreta');
  assert.match(m, /OC-1/, 'y de qué corrida se trata');
  assert.match(m, /TYCON_LEDGER_VISIBLE=off/, 'y el escape');
});

test('con el pipeline CERRADO pasa (no hay re-loop que proteger)', () => {
  const r = lv.evaluarVisibilidad({
    marker: cerrado, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /sin pipeline abierto/);
});

test('sin marker pasa (edición suelta, fuera de toda corrida)', () => {
  assert.equal(lv.evaluarVisibilidad({ marker: null, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro }).block, false);
});

test('código FUERA del repo de la corrida pasa (scratchpad, otro repo)', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto,
    codeTargets: ['/tmp/scratch/probe.cs', '/otro-repo/src/Bar.cs'],
    dentroDelRepo: dentro,
  });
  assert.equal(r.block, false, 'el registro sólo mide el repo de la corrida');
});

test('sin targets de código pasa (.md, config y demás los filtra el llamador)', () => {
  assert.equal(lv.evaluarVisibilidad({ marker: abierto, codeTargets: [], dentroDelRepo: dentro }).block, false);
});

test('mezcla: frena SÓLO por los de adentro, y los nombra', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto,
    codeTargets: ['/tmp/scratch/x.cs', '/repo/src/A.cs', '/repo/tests/B.cs'],
    dentroDelRepo: dentro,
  });
  assert.equal(r.block, true);
  assert.deepEqual(r.files, ['/repo/src/A.cs', '/repo/tests/B.cs'], 'el de scratchpad no entra');
});

test('kill-switch off deja pasar todo, y lo dice', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro, off: 'off',
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /kill-switch/);
});

test('marker sin repoPath no frena (no hay contra qué comparar)', () => {
  const r = lv.evaluarVisibilidad({
    marker: { stepsPending: [5] }, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /repoPath/);
});
