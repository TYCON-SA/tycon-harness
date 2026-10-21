#!/usr/bin/env node
'use strict';
/**
 * hook-comments.test.js — los comentarios de los controles del commit (`.githooks/pre-commit` y
 * `.githooks/pre-commit-checks`) dicen qué hace cada parte y por qué, en presente: sin número de story, código de tanda,
 * fecha, caso del registro de incidentes ni historia («se encontró cuando…»). La regla vive en
 * guides/maintaining/estilo-de-codigo.md, y su guía tiene su propia prueba (style-guide.test.js).
 *
 * Uso: node --test scripts/tests/hook-comments.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const FILES = ['.githooks/pre-commit', '.githooks/pre-commit-checks'];

// Las formas son las del freno de historia interna en la zona de comentarios (scripts/publishing/internal-history.js).
// Estos dos archivos ya están limpios, así que esta prueba suma además las formas débiles que el freno no frena (en otros
// archivos dan falsos positivos; acá no hay ninguno): aflojarlas acá dejaría volver lo que ya se sacó.
const ih = require(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js'));
const EXTRA = [
  { re: /\btandas?\b/i, what: 'una tanda' },
  { re: /\bincident(?:e|es)\b/i, what: 'un caso del registro de incidentes' },
  { re: /\bhasta que\b/i, what: 'historia («hasta que …»)' },
  { re: /\bya no\b/i, what: 'historia («ya no …»)' },
  { re: /\bahora\b/i, what: 'historia («ahora …»)' },
  { re: /\b(?:pase adversarial|revisión del tramo)\b/i, what: 'el relato de cómo se encontró' },
];

/** Lo que encuentra en un texto: las formas del freno y las de EXTRA, con su línea. */
function findings(text, rel) {
  const own = ih.commentsOf(text, rel);
  const found = ih.scan(own, 'comment').map((f) => ({ n: f.line, what: f.form }));
  own.split('\n').forEach((l, i) => { for (const f of EXTRA) if (f.re.test(l)) found.push({ n: i + 1, what: f.what }); });
  return found;
}

test('T27 HookComments_NoHistoryForms', () => {
  const found = [];
  for (const rel of FILES) {
    const file = path.join(RAIZ, rel);
    assert.ok(fs.existsSync(file), `${rel}: no está`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(ih.commentsOf(text, rel).trim().length > 0, `${rel}: sin comentarios (la regla pide decir qué hace cada parte)`);
    for (const f of findings(text, rel)) found.push(`${rel}:${f.n} — ${f.what}: ${text.split('\n')[f.n - 1].trim().slice(0, 120)}`);
  }
  assert.deepStrictEqual(found, [], `comentarios con forma de historia:\n${found.join('\n')}`);
});

test('T27b HookComments_FormsCatchTheirCase', () => {
  // cada forma atrapa su caso, y una línea en presente pasa: sin esto la prueba de arriba podría quedar ciega
  const j = (...p) => p.join('');
  const bad = [j('# story ', '8.18: el despachador'), '# tanda B', j('# 20', '26-10-04'), j('# caso: incident-', 'log#algo'), '# antes era otro', '# hasta hoy', '# ya no corre', '# ahora frena', '# rojo previo verificado'];
  for (const l of bad) assert.ok(findings(`${l}\n`, 'x.sh').length > 0, `nadie atrapa «${l}»`);
  const good = '# El portón de cierre: una story que pasa a review trae su evidencia de cierre.';
  assert.deepStrictEqual(findings(`${good}\n`, 'x.sh'), [], 'una línea en presente no se atrapa');
});
