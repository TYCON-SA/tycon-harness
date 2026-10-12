'use strict';
// Fixture: cubre esPar A PROPÓSITO y deja nuncaTesteada sin cubrir.
const { test } = require('node:test');
const assert = require('node:assert');
const { esPar } = require('./calc.js');

test('esPar distingue pares de impares', () => {
  assert.equal(esPar(2), true);
  assert.equal(esPar(3), false);
});
