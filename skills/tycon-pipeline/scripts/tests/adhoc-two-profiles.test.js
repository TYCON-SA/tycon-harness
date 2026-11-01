#!/usr/bin/env node
'use strict';
/**
 * adhoc-two-profiles.test.js — los textos del camino rápido en los dos perfiles.
 *
 *   T48 el texto de `adhoc-high-risk`, «faltan los revisores y el pase» y el error del lint de `riesgo_alto_por:`:
 *       en un producto dicen «vos» y no nombran al dueño, la coordinadora, la delegación ni la constancia; en el
 *       arnés, sí.
 *
 * Los demás textos del camino rápido (el cierre, la lista, las pruebas y la rama) suman acá sus pruebas.
 * stable-data: sólo arma textos; no toca archivos.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-two-profiles.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const lint = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'lint-story-frontmatter.js'));

const DE_MANTENIMIENTO = /dueñ[oa]|coordinadora|delegaci[oó]n|delegad[oa]|constancia/i;

function dosFormas(armar) {
  const producto = armar(false);
  const arnes = armar(true);
  assert.ok(producto && arnes);
  assert.doesNotMatch(producto, DE_MANTENIMIENTO, producto);
  assert.match(producto, /\bvos\b/, producto);
  assert.match(arnes, DE_MANTENIMIENTO, arnes);
}

test('T48 MensajesB1_DosPerfiles — @story-8.174 @ac-45', () => {
  dosFormas((harness) => gate.blockMessage(
    { action: 'block', kind: 'adhoc-high-risk', reason: 'x', regla: 'rutas-sensibles', archivo: 'src/auth/x.ts' },
    { filePath: '/r/src/auth/x.ts', repoRoot: '/r', harness },
  ));
  dosFormas((harness) => saveBrake.textoFaltanRevisoresYPase({ harness, regla: 'rutas-sensibles', archivo: '/r/src/auth/x.ts' }));
  dosFormas((harness) => lint.mensajeRiesgoAltoPor({ harness, rel: 'specs/story-9.9.md', invalidos: ['otra'] }));
});
