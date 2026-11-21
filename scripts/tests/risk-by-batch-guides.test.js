#!/usr/bin/env node
'use strict';
/**
 * risk-by-batch-guides.test.js — lo que el formato y las guías dicen del riesgo por parte.
 *
 *   T27 story-format.md describe `files:` y `sensible:` por parte y cuándo una parte vale; el lint acepta las dos claves
 *       y frena un `files:` que no es una lista
 *   T28 las guías dicen que el plan delegado es el de una parte, atado a su lista, que vuelve al dueño si el diff sale
 *       delicado, que el pase sigue por la historia entera y la nota de las partes sin `files:`; step-08 y SKILL.md dicen
 *       que el portón del pase usa el riesgo de la historia entera
 *
 * stable-data: sólo lee los archivos del repo y llama al lint en proceso.
 * Correr: node --test scripts/tests/risk-by-batch-guides.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

test('T27 Formato_DescribeYLintAcepta — @story-8.168 @ac-16', () => {
  const formato = leer('story-format.md');
  assert.match(formato, /\| `files` \| string\[\] \|/);
  assert.match(formato, /\| `sensible` \|/);
  assert.match(formato, /\*\*La parte que vale\.\*\*/);
  assert.match(formato, /set-batch/);
  const { filesDeParteMalos } = require(path.join(RAIZ, 'scripts', 'lib', 'lint-story-frontmatter.js'));
  const bloque = (partes) => `pipelines:\n${partes}`;
  // las dos formas de lista y `sensible:` valen
  assert.deepStrictEqual(filesDeParteMalos(bloque('  - name: A\n    status: pending\n    sensible: true\n    files:\n      - src/a.js\n  - name: B\n    files: [a.md, b.md]\n')), []);
  // un valor suelto, o una clave sin ítems, no
  assert.deepStrictEqual(filesDeParteMalos(bloque('  - name: A\n    files: src/a.js\n  - name: B\n    files:\n    status: pending\n')), ['A', 'B']);
  // sin bloque pipelines, nada
  assert.deepStrictEqual(filesDeParteMalos('files_to_modify:\n  - a.js\n'), []);
});

test('T28 Guias_DicenLaParteYLoQueAfloja — @story-8.168 @ac-17', () => {
  const firmas = leer('guides/firmas-del-arnes.md');
  const i = firmas.indexOf('**El plan de una parte.**');
  assert.ok(i >= 0, 'falta la sección del plan de una parte');
  const s = firmas.slice(i, i + 1600);
  for (const re of [/set-batch/, /coordinadora/, /atado a la lista/, /diff entero/, /vuelve al dueño/, /historia entera/, /no\s+declaran `files:`/, /82 de 115/]) {
    assert.match(s, re, String(re));
  }
  const coord = leer('guides/coordination.md');
  assert.match(coord, /\*\*El plan que aprueba es el de una parte\*\*/);
  assert.match(coord, /el plan vuelve al dueño/);
  assert.match(leer('guides/coordination.en.md'), /\*\*The plan she approves is a part's plan\*\*/);
  for (const rel of ['skills/tycon-pipeline/steps/step-08-adversarial-pass.md', 'skills/tycon-pipeline/SKILL.md']) {
    assert.match(leer(rel), /riesgo\s+de\s+la\s+historia\s+entera,\s+no\s+el\s+que\s+`risk-class`\s+da\s+para\s+la\s+parte/, rel);
  }
});
