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

test('T19 StoryGate_ProductoAlPasarElTope_HablaDeVos @story-8.181 @ac-8', () => {
  dosFormas((harness) => gate.blockMessage({ action: 'block', kind: 'adhoc-cap', reason: 'x', tocados: 8, cupo: 8 }, { filePath: '/r/src/x.ts', repoRoot: '/r', harness }));
  dosFormas((harness) => gate.textoDelTope({ harness, tocados: 9, cupo: 8, archivos: ['/r/a.ts'] }));
});

test('T48 MensajesB1_DosPerfiles — @story-8.174 @ac-45', () => {
  dosFormas((harness) => gate.blockMessage(
    { action: 'block', kind: 'adhoc-high-risk', reason: 'x', regla: 'rutas-sensibles', archivo: 'src/auth/x.ts' },
    { filePath: '/r/src/auth/x.ts', repoRoot: '/r', harness },
  ));
  dosFormas((harness) => saveBrake.textoFaltanRevisoresYPase({ harness, regla: 'rutas-sensibles', archivo: '/r/src/auth/x.ts' }));
  dosFormas((harness) => lint.mensajeRiesgoAltoPor({ harness, rel: 'specs/story-9.9.md', invalidos: ['otra'] }));
});

test('T55 MensajesA2_DosPerfiles — @story-8.174 @ac-52', () => {
  const LISTA = require(path.join(SCRIPTS, 'lib', 'adhoc-list.js'));
  // el portón fuera de la lista y el freno de la lista al guardar
  dosFormas((harness) => gate.blockMessage(
    { action: 'block', kind: 'adhoc-out-of-list', reason: 'x', archivo: '/r/src/b.ts', lista: ['/r/src/a.ts'] },
    { filePath: '/r/src/b.ts', repoRoot: '/r', harness },
  ));
  dosFormas((harness) => saveBrake.textoFueraDeLaLista({ harness, archivos: ['/r/src/b.ts'] }));
  // los rechazos de `adhoc set`: el salto de línea, varios temas, vago, la ampliación y otro carril en el repo
  dosFormas((harness) => LISTA.problemaDelMotivo('arreglo del combo\nde clientes', { harness }));
  dosFormas((harness) => LISTA.sinUnaPersona({ reason: 'el combo, la grilla y el filtro', harness }));
  dosFormas((harness) => LISTA.sinUnaPersona({ reason: 'arreglos varios del combo', harness }));
  dosFormas((harness) => LISTA.textoDeAmpliar(['src/a.ts'], { harness }));
  dosFormas((harness) => LISTA.textoOtroCarril('s1', '/r', { harness }));
  // una lista inválida o fuera de los topes: el problema es el mismo en los dos; en un producto, habla de vos
  for (const problema of [
    LISTA.normalizar([]).problema, LISTA.normalizar(['src/*.ts']).problema,
    LISTA.problemaDeTopes(['/r/a.js', '/r/b.js', '/r/c.js'], 2, { esCod: () => true }),
  ]) {
    const producto = LISTA.rechazoDeLaLista(problema, { harness: false });
    assert.doesNotMatch(producto, DE_MANTENIMIENTO, producto);
    assert.match(producto, /\bvos\b/, producto);
  }
});

test('T56 MensajesA3_DosPerfiles — @story-8.174 @ac-53', () => {
  // «faltan las pruebas» y «creá una rama» son los mismos en los dos perfiles: hablan de vos y no nombran la capa de
  // mantenimiento (la sección de la guía la mira adhoc-guides.test.js, T46)
  for (const texto of [
    saveBrake.textoFaltanLasPruebas({ archivos: ['/r/src/a.js'] }),
    saveBrake.textoFaltanLasPruebas({ porque: 'la última corrida salió con 1', archivos: ['/r/src/a.js'], comando: 'npm test' }),
    saveBrake.textoCreaUnaRama({ rama: 'main', repo: '/r' }),
  ]) {
    assert.doesNotMatch(texto, DE_MANTENIMIENTO, texto);
    assert.match(texto, /\bvos\b/, texto);
  }
});
