'use strict';
// session-names.test.js — los nombres con que la coordinadora abre las sesiones nuevas: los temas de fábrica, la regla
// de un nombre y el próximo libre.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const N = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).sessionNames;

test('SessionNames_ThemesAreValidLists: cada tema de fábrica pasa la misma regla que una lista propia', () => {
  assert.ok(Object.keys(N.THEMES).length >= 3);
  for (const [id, names] of Object.entries(N.THEMES)) {
    assert.strictEqual(N.problem(id), null, id);
    assert.strictEqual(N.problem(names.slice()), null, id);
    assert.ok(names.length >= 8, `${id}: ${names.length} nombres`);
  }
});

test('SessionNames_Problem_SaysWhy: un tema desconocido, una lista vacía, un nombre raro, largo o repetido', () => {
  assert.match(N.problem('dinosaurios'), /tema de fábrica/);
  assert.match(N.problem([]), /lista no vacía/);
  assert.match(N.problem(['con espacio']), /no sirve como nombre/);
  assert.match(N.problem(['Río']), /no sirve como nombre/);
  assert.match(N.problem(['-n']), /no sirve como nombre/);
  assert.match(N.problem(['a'.repeat(41)]), /es largo/);
  assert.match(N.problem(['Uno', 'UNO']), /repite/);
  assert.match(N.problem(Array.from({ length: 201 }, (_, i) => `n${i}`)), /máximo/);
  assert.strictEqual(N.problem([' Norte ', 'Sur_1', 'x-2']), null);
});

test('SessionNames_ThemeIdIgnoresCase_TwoThemesAreNotAList: «Animals» es el tema; «animals,rivers» no es una lista de nombres; un nombre solo dice cómo ponerlo', () => {
  assert.strictEqual(N.problem('Animals'), null);
  assert.deepStrictEqual(N.namesOf(' Animals '), N.THEMES.animals.slice());
  assert.match(N.problem(['animals', 'rivers']), /va uno solo/);
  assert.match(N.problem('Pepe'), /terminalo con una coma: «Pepe,»/);
  assert.doesNotMatch(N.problem('con espacio'), /terminalo/);
});

test('SessionNames_NextFree_InOrderThenNumbered: el primero libre; agotada la lista, con número y en orden', () => {
  const names = ['Norte', 'Sur'];
  assert.strictEqual(N.nextFree(names, new Set()), 'Norte');
  assert.strictEqual(N.nextFree(names, new Set(['norte'])), 'Sur', 'sin mayúsculas');
  assert.strictEqual(N.nextFree(names, new Set(['Norte', 'Sur'])), 'Norte-2');
  assert.strictEqual(N.nextFree(names, new Set(['Norte', 'Sur', 'Norte-2', 'Sur-2'])), 'Norte-3');
  assert.strictEqual(N.nextFree([], new Set()), null);
  // un nombre que con número se pasaría del largo no se usa con número
  const largo = 'a'.repeat(40);
  assert.strictEqual(N.nextFree([largo], new Set([largo])), null);
  assert.strictEqual(N.nextFree([largo, 'b'], new Set([largo, 'b'])), 'b-2');
});

test('SessionNames_NamesOf: el tema da una copia de sus nombres; la lista, recortada; sin valor, ninguno', () => {
  const a = N.namesOf('animals');
  a.push('x');
  assert.ok(!N.THEMES.animals.includes('x'), 'la copia no toca el tema');
  assert.deepStrictEqual(N.namesOf([' Uno ', 'Dos']), ['Uno', 'Dos']);
  assert.deepStrictEqual(N.namesOf(null), []);
});
