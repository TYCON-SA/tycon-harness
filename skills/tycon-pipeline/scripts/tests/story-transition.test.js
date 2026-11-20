'use strict';
/**
 * story-transition.test.js — el cambio a mano del estado de una historia lo ve el freno en CADA tanda del bloque
 * `pipelines`, no sólo en la última.
 *
 * 🔴 El caso (riesgo 59, una historia de noviembre): con el formato de lista que manda la guía
 *    (`- name: A1` y debajo `status:`), el lector tomaba la clave `name` como nombre de la tanda. Todas las tandas
 *    quedaban bajo el mismo nombre y cada una pisaba a la anterior: pasar a `done` a mano cualquier tanda que no fuera
 *    la última no lo veía nadie (ni la herramienta de edición ni la consola, que usan esta misma pieza).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'lib', 'story-transition.js'));

const FILE = '/w/specs/stories/9.9-una.md';
const story = (pipelines) => `---\nstory: 9.9\nstatus: in-progress\npipelines:\n${pipelines}---\n\n# Historia\n`;

test('Tandas_EnLista_CadaUnaConSuNombre', () => {
  const s = T.estadosDe(story('  - name: A1\n    status: done\n  - name: A2\n    status: pending\n  - name: A3\n    status: pending\n'));
  assert.deepStrictEqual([...s.tandas], [['A1', 'done'], ['A2', 'pending'], ['A3', 'pending']]);
});

test('ATuMano_CualquierTandaEnLista_LaVeElFreno', () => {
  const antes = story('  - name: A1\n    status: pending\n  - name: A2\n    status: pending\n  - name: A3\n    status: pending\n');
  for (const [i, nombre] of ['A1', 'A2', 'A3'].entries()) {
    const lineas = ['A1', 'A2', 'A3'].map((n, k) => `  - name: ${n}\n    status: ${k === i ? 'done' : 'pending'}\n`).join('');
    assert.deepStrictEqual(T.transicionAMano(FILE, antes, story(lineas)), { storyId: '9.9', estado: `pipelines.${nombre}` }, `la tanda ${nombre} a done`);
  }
});

test('ATuMano_ElEstadoAntesQueElNombre_TambienLoVe', () => {
  const antes = story('  - status: pending\n    name: A1\n  - status: pending\n    name: A2\n');
  const despues = story('  - status: done\n    name: A1\n  - status: pending\n    name: A2\n');
  assert.deepStrictEqual(T.transicionAMano(FILE, antes, despues), { storyId: '9.9', estado: 'pipelines.A1' });
});

test('ATuMano_ConIdEnVezDeName_YSinNombre', () => {
  const conId = (a) => story(`  - id: B1\n    status: ${a}\n  - id: B2\n    status: pending\n`);
  assert.deepStrictEqual(T.transicionAMano(FILE, conId('pending'), conId('done')), { storyId: '9.9', estado: 'pipelines.B1' });
  // sin nombre: cuenta por su lugar en la lista
  const sinNombre = (a) => story(`  - status: ${a}\n  - status: pending\n`);
  assert.ok(T.transicionAMano(FILE, sinNombre('pending'), sinNombre('done')), 'una tanda sin nombre que pasa a done');
});

test('Mapa_SigueComoAntes', () => {
  const mapa = (a) => story(`  A-backend:\n    status: ${a}\n  B-front:\n    status: pending\n`);
  assert.deepStrictEqual(T.transicionAMano(FILE, mapa('pending'), mapa('done')), { storyId: '9.9', estado: 'pipelines.A-backend' });
  assert.deepStrictEqual([...T.estadosDe(mapa('done')).tandas], [['A-backend', 'done'], ['B-front', 'pending']]);
});

test('SinCambioDeEstado_NoFrena', () => {
  const a = story('  - name: A1\n    status: done\n  - name: A2\n    status: pending\n');
  assert.strictEqual(T.transicionAMano(FILE, a, a.replace('# Historia', '# Historia, con otro título')), null);
});
