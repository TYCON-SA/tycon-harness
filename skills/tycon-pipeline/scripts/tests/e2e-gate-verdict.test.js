'use strict';

/**
 * e2e-gate-verdict.test.js —el veredicto del gate E2E tiene TRES estados, no dos.
 *
 * 🔴 Sin el tercer estado, un gate crítico en ROJO que se arregla pasaría a reportar `PASS (0/4)`:
 * los tests se saltean solos cuando la base no tiene datos, Playwright devuelve exit 0, y un gate
 * que lee SÓLO ese exit code da verde. Un control que devuelve verde sin haber ejercido nada es peor
 * que uno rojo: el rojo se discute, el verde hueco se firma.
 *
 * Y un segundo agujero: si el set crítico declara 5 recorridos y la app elegida tiene UNO, la línea
 * final del gate sería idéntica a la de una corrida completa. Un control que no dice qué parte de
 * su set no encontró no se puede auditar.
 *
 * Parte PURA (sin Playwright, sin spawns): se le pasan totales y se mira el veredicto.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ev = require('../lib/e2e-evidence.js');

// ---------------------------------------------------------------- veredicto

test('corrió y pasó → PASS con exit 0', () => {
  const v = ev.veredicto({ exitCode: 0, total: 4, passed: 4, failed: 0, skipped: 0 });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.exit, 0);
});

test('corrió y falló → FAIL, y el exit de Playwright no se pisa', () => {
  const v = ev.veredicto({ exitCode: 1, total: 4, passed: 3, failed: 1, skipped: 0 });
  assert.equal(v.verdict, 'FAIL');
  assert.notEqual(v.exit, 0);
});

test('🔴 todo salteado → SIN_EJERCER y exit != 0, aunque Playwright diga 0', () => {
  // Es EXACTAMENTE la corrida que devolvía "PASS (0/4)".
  const v = ev.veredicto({ exitCode: 0, total: 4, passed: 0, failed: 0, skipped: 4 });
  assert.equal(v.verdict, 'SIN_EJERCER');
  assert.notEqual(v.exit, 0, 'un gate que no ejerció nada NO puede dejar pasar el merge');
});

test('salteado parcial con al menos uno ejecutado → PASS (no es un verde hueco)', () => {
  const v = ev.veredicto({ exitCode: 0, total: 4, passed: 1, failed: 0, skipped: 3 });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.exit, 0);
});

test('sin tests en absoluto → SIN_EJERCER (el filtro no matcheó nada)', () => {
  const v = ev.veredicto({ exitCode: 0, total: 0, passed: 0, failed: 0, skipped: 0 });
  assert.equal(v.verdict, 'SIN_EJERCER');
  assert.notEqual(v.exit, 0);
});

test('falla real con todo salteado igual es FAIL, no SIN_EJERCER', () => {
  // Si Playwright falló (config roto, timeout global), el rojo manda: no se degrada a "no ejerció".
  const v = ev.veredicto({ exitCode: 1, total: 0, passed: 0, failed: 0, skipped: 0 });
  assert.equal(v.verdict, 'FAIL');
});

test('el motivo explica por qué, en castellano llano y accionable', () => {
  const v = ev.veredicto({ exitCode: 0, total: 4, passed: 0, failed: 0, skipped: 4 });
  assert.match(v.motivo, /salte/i);
  assert.match(v.motivo, /4/);
});

// ------------------------------------------------- los códigos de salida, uno por uno
// 🔴 Por qué se fijan acá y no alcanza `notEqual(0)`: el orquestador del step 7c ACTÚA según el
// número, y `SIN_EJERCER` no puede pisar el 3, que significa «el stack no levantó»: mandaría a
// levantar servicios que están arriba y a re-correr para sacar 3 otra vez. El mapa vive en la
// cabecera de `veredicto()` y en `steps/step-07c-dod-runtime-gate.md`; estas tres pruebas son las
// que lo sostienen, así que un cambio de número tiene que pasar por acá.

test('🔴 todos los tests salteados → exit 4 (faltan datos), NUNCA 3 (el stack no levantó)', () => {
  const v = ev.veredicto({ exitCode: 0, total: 4, passed: 0, failed: 0, skipped: 4 });
  assert.equal(v.exit, 4, 'la acción es sembrar datos, no levantar el stack');
  assert.notEqual(v.exit, 3, 'el 3 es «el stack no levantó»: pisarlo manda a arreglar lo que no está roto');
});

test('el filtro no matcheó ningún test → exit 2 (nombre de spec mal escrito)', () => {
  const v = ev.veredicto({ exitCode: 0, total: 0, passed: 0, failed: 0, skipped: 0 });
  assert.equal(v.exit, 2);
});

test('los dos SIN_EJERCER se distinguen entre sí: filtro vacío y todo salteado no son el mismo caso', () => {
  const filtro = ev.veredicto({ exitCode: 0, total: 0, passed: 0, failed: 0, skipped: 0 });
  const salteado = ev.veredicto({ exitCode: 0, total: 4, passed: 0, failed: 0, skipped: 4 });
  assert.equal(filtro.verdict, salteado.verdict, 'el veredicto es el mismo…');
  assert.notEqual(filtro.exit, salteado.exit, '…pero el código tiene que separarlos: son dos arreglos distintos');
});

// ---------------------------------------------------------------- filtros no encontrados

function appConSpecs(nombres) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-'));
  fs.mkdirSync(path.join(dir, 'tests', 'e2e'), { recursive: true });
  for (const n of nombres) fs.writeFileSync(path.join(dir, 'tests', 'e2e', `${n}.spec.ts`), '// probe\n');
  return dir;
}

test('🔴 nombra los recorridos declarados que la app NO tiene', () => {
  // El caso: 5 declarados, sólo `story-a2-catalogo-detalle-de-ruta` existe en la app de catálogo.
  const app = appConSpecs(['story-a2-catalogo-detalle-de-ruta']);
  const f = ev.filtrosNoEncontrados(app, [
    'story-d1-pedidos-del-dia',
    'story-a2-detalle-de-ruta',
    'story-b2-entrega-sin-firma',
    'story-a2-catalogo-detalle-de-ruta',
    'story-c1-sin-stock',
  ]);
  assert.equal(f.length, 4);
  assert.ok(!f.includes('story-a2-catalogo-detalle-de-ruta'));
  assert.ok(f.includes('story-c1-sin-stock'));
});

test('con todos presentes, la lista viene vacía', () => {
  const app = appConSpecs(['a', 'b']);
  assert.deepEqual(ev.filtrosNoEncontrados(app, ['a', 'b']), []);
});

test('un filtro que es una ruta se resuelve igual que un nombre', () => {
  const app = appConSpecs(['fix-p1-pedidos-por-zona']);
  assert.deepEqual(ev.filtrosNoEncontrados(app, ['tests/e2e/fix-p1-pedidos-por-zona.spec.ts']), []);
});

test('sin carpeta de specs no inventa faltantes (no puede saber)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-vacio-'));
  assert.deepEqual(ev.filtrosNoEncontrados(dir, ['a']), []);
});
