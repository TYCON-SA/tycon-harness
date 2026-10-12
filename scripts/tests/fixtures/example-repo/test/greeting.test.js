'use strict';
// Las pruebas del repo de ejemplo. Cada nombre empieza con el identificador de su fila en la tabla `### Tests` de la
// story 1.1 (T1, T2): así el control mecánico del pipeline encuentra la prueba de cada criterio sin adivinar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greeting.js');

test('T1 Greeting_WithName_GreetsByName', () => {
  assert.equal(greet('Acme'), 'Hello, Acme!');
  assert.equal(greet('  Acme  '), 'Hello, Acme!');
});

test('T2 Greeting_WithoutName_GreetsTheWorld', () => {
  assert.equal(greet(), 'Hello, world!');
  assert.equal(greet(''), 'Hello, world!');
  assert.equal(greet('   '), 'Hello, world!');
});
