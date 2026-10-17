#!/usr/bin/env node
'use strict';
/**
 * style-guide.test.js — la regla de los comentarios del código (guides/maintaining/estilo-de-codigo.md) existe, trae dos ejemplos
 * buenos y dos malos, y el índice de guías (INDEX.md) tiene su fila. Story 8.41, AC 35 (T35).
 *
 * Uso: node --test scripts/tests/style-guide.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUIDE = 'guides/maintaining/estilo-de-codigo.md';

test('T35 StyleGuide_RuleWithExamples_InIndex', () => {
  const file = path.join(RAIZ, GUIDE);
  assert.ok(fs.existsSync(file), `${GUIDE}: no está`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^## La regla$/m, 'la guía trae la regla');
  const examples = text.slice(text.indexOf('## Ejemplos'));
  assert.ok(text.includes('## Ejemplos'), 'la guía trae sus ejemplos');
  const good = (examples.match(/^✅ /gm) || []).length;
  const bad = (examples.match(/^❌ /gm) || []).length;
  assert.equal(good, 2, `dos ejemplos buenos (hay ${good})`);
  assert.equal(bad, 2, `dos ejemplos malos (hay ${bad})`);
  // cada ejemplo trae su bloque de código
  const blocks = (examples.match(/^```/gm) || []).length / 2;
  assert.ok(blocks >= 4, `cada ejemplo con su bloque de código (hay ${blocks})`);
  const index = fs.readFileSync(path.join(RAIZ, 'INDEX.md'), 'utf8');
  const rows = index.split('\n').filter((l) => l.startsWith('|') && l.includes(`\`${GUIDE}\``));
  assert.equal(rows.length, 1, `INDEX.md: una fila que nombra ${GUIDE} (hay ${rows.length})`);
});
