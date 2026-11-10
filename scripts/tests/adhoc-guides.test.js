#!/usr/bin/env node
'use strict';
/**
 * adhoc-guides.test.js — lo que las guías dicen del camino rápido.
 *
 *   T53 la lista: todo camino rápido lleva la suya, qué motivo no se delega, uno delegado por repo, el riesgo alto no se
 *       delega y el límite de la consola (firmas-del-arnes.md); cómo se pide con su lista (coordination.md y su par)
 *   T46 las pruebas y la rama: la sección las dice, habla de vos y no nombra las piezas de mantenimiento
 *
 * stable-data: sólo lee las guías del repo.
 * Correr: node --test scripts/tests/adhoc-guides.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

test('T53 Guias_LaLista — @story-8.174 @ac-50', () => {
  const firmas = leer('guides/firmas-del-arnes.md');
  const seccion = firmas.slice(firmas.indexOf('**La lista de archivos.**'));
  assert.ok(seccion.length > 0 && firmas.includes('**La lista de archivos.**'), 'falta la sección de la lista');
  const parte = seccion.slice(0, 2500);
  assert.match(parte, /allowedFiles/);
  assert.match(parte, /--file <ruta>/);
  assert.match(parte, /salto de l[ií]nea/);
  assert.match(parte, /vago/);
  assert.match(parte, /varios temas/);
  assert.match(parte, /uno por repo/);
  assert.match(parte, /riesgo alto/);
  assert.match(parte, /consola/);
  assert.match(parte, /freno de guardar/);
  // la forma de la terminal lleva la lista
  assert.match(firmas, /--data sin-cambio\s+--file <ruta>/);
  for (const [rel, re] of [['guides/coordination.md', /\*\*Se pide con su lista\.\*\*/], ['guides/coordination.en.md', /\*\*It is asked for with its list\.\*\*/]]) {
    const g = leer(rel);
    assert.match(g, re, rel);
    assert.match(g, /adhoc set '\{"reason":"[^"]+","datos":"sin-cambio","allowedFiles":\["[^"]+"/, rel);
  }
});

test('T46 Guias_PruebasYRama — @story-8.174 @ac-44 @ac-53', () => {
  const firmas = leer('guides/firmas-del-arnes.md');
  const i = firmas.indexOf('**Las pruebas y la rama del camino rápido.**');
  assert.ok(i >= 0, 'falta la sección de las pruebas y la rama');
  const fin = firmas.indexOf('\n\n', firmas.indexOf('\n- ', firmas.indexOf('\n- ', i) + 1) + 1);
  const seccion = firmas.slice(i, fin > i ? fin : undefined);
  assert.match(seccion, /adhoc test -- /);
  assert.match(seccion, /se vence/);
  assert.match(seccion, /gu[ií]as o datos/);
  assert.match(seccion, /rama principal/);
  assert.match(seccion, /git switch -c/);
  assert.match(seccion, /`main` y `master`/);
  // la lee un dev de producto: habla de vos y no nombra las piezas de mantenimiento
  assert.match(seccion, /\bvos\b/);
  assert.doesNotMatch(seccion, /dueñ[oa]|coordinadora|delegaci[oó]n|delegad[oa]|constancia/i);
});
