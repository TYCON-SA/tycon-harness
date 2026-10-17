#!/usr/bin/env node
'use strict';
/**
 * hook-comments.test.js — los comentarios de los controles del commit (`.githooks/pre-commit` y
 * `.githooks/pre-commit-checks`) dicen qué hace cada parte y por qué, en presente: sin número de story, código de tanda,
 * fecha, caso del registro de incidentes ni historia («antes era…»). Story 8.41, AC 34 (T27); la regla vive en
 * guides/estilo-de-codigo.md, y su guía tiene su propia prueba (T35, style-guide.test.js).
 *
 * Uso: node --test scripts/tests/hook-comments.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const FILES = ['.githooks/pre-commit', '.githooks/pre-commit-checks'];

// las formas que no van en un comentario: cada una con lo que dice cuando aparece
const FORMS = [
  { re: /\bstor(?:y|ies)\s+\d/i, what: 'un número de story' },
  { re: /\btandas?\b/i, what: 'una tanda' },
  { re: /\b20\d{2}-\d{2}-\d{2}\b/, what: 'una fecha' },
  { re: /\bincident(?:e|es|-log)\b/i, what: 'un caso del registro de incidentes' },
  { re: /\bantes (?:era|se|había|corría|daba|frenaba|salía)\b/i, what: 'historia («antes …»)' },
  { re: /\bhasta (?:hoy|que)\b/i, what: 'historia («hasta …»)' },
  { re: /\bya no\b/i, what: 'historia («ya no …»)' },
  { re: /\bahora\b/i, what: 'historia («ahora …»)' },
  { re: /\b(?:rojo previo|caso real|pase adversarial|revisión del tramo|medido el)\b/i, what: 'el relato de cómo se encontró' },
];

/** Las líneas de comentario de un guion de shell (sin el shebang): número y texto. */
function comments(text) {
  return text.split('\n').map((l, i) => ({ n: i + 1, l })).filter((x) => /^\s*#/.test(x.l) && !/^#!/.test(x.l));
}

test('T27 HookComments_NoHistoryForms', () => {
  const found = [];
  for (const rel of FILES) {
    const file = path.join(RAIZ, rel);
    assert.ok(fs.existsSync(file), `${rel}: no está`);
    const lines = comments(fs.readFileSync(file, 'utf8'));
    assert.ok(lines.length > 0, `${rel}: sin comentarios (la regla pide decir qué hace cada parte)`);
    for (const { n, l } of lines) for (const f of FORMS) if (f.re.test(l)) found.push(`${rel}:${n} — ${f.what}: ${l.trim().slice(0, 120)}`);
  }
  assert.deepStrictEqual(found, [], `comentarios con forma de historia:\n${found.join('\n')}`);
});

test('T27b HookComments_FormsCatchTheirCase', () => {
  // cada forma atrapa su caso, y una línea en presente pasa: sin esto la prueba de arriba podría quedar ciega
  const bad = ['# story 8.18: el despachador', '# tanda B', '# 2026-10-04', '# caso: incident-log#algo', '# antes era otro', '# hasta hoy', '# ya no corre', '# ahora frena', '# rojo previo verificado'];
  for (const l of bad) assert.ok(FORMS.some((f) => f.re.test(l)), `nadie atrapa «${l}»`);
  const good = '# El portón de cierre: una story que pasa a review trae su evidencia de cierre.';
  assert.ok(!FORMS.some((f) => f.re.test(good)), 'una línea en presente no se atrapa');
});
