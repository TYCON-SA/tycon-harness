'use strict';
// site-cards-totals.test.js — el número grande de una ficha del sitio dice qué cuenta, y coincide con su propia lista.
//
// 🔴 Falla con: «Lo rehecho al lado de lo entregado, mes por mes: 11, n=11» con una lista que suma 13 rehechas
// (recorrido del sitio del 27/11). El 11 es lo rehecho sin la deuda declarada, que la lista sí muestra: la ficha no lo
// decía. Ahora el renglón de abajo del número dice qué cuenta y en cuántos meses.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const C = require(path.join(__dirname, '..', 'site', 'tabs', 'cards.js'));
const DEF = C.FICHAS.find((f) => f.id === 'rework_por_mes');
// lo que deja el tablero: el valor es la suma de las rehechas sin deuda de cada mes
const METRICA = {
  estado: 'medido', valor: 11, medidos: 11, total: 11, unidad: 'conteo', den_etiqueta: 'rehechas sin deuda en 2 meses · 3 de 4 repos',
  filas: [
    { mes: '2026-10', en_curso: false, entregadas: 12, causas: [{ clave: 'defecto-propio', n: 5 }, { clave: 'deuda-declarada', n: 2 }], sin_declarar: 1, sin_deuda: 6 },
    { mes: '2026-11', en_curso: true, entregadas: 10, causas: [{ clave: 'cambio-de-requisito', n: 5 }], sin_declarar: 0, sin_deuda: 5 },
  ],
  causa_aparte: 'deuda-declarada',
};
const sinTags = (h) => h.replace(/<[^>]+>/g, '|');

test('C1 ReworkPorMes_DiceQueCuenta — «rehechas sin la deuda declarada, en 2 meses», en los dos idiomas', () => {
  const f = C.proyectar(DEF, METRICA, {});
  const es = sinTags(C.tile(f, 'es'));
  assert.match(es, /\|11\|/, 'el número');
  assert.match(es, /rehechas sin contar la deuda declarada, en 2 meses/, es);
  assert.doesNotMatch(es, /n=11/, 'no un «n=» que no dice de qué');
  assert.match(sinTags(C.tile(f, 'en')), /reworked without the declared debt, over 2 months/);
});

test('C2 ReworkPorMes_ElNumeroCoincideConLaLista — la suma sin deuda de los meses es el número', () => {
  const f = C.proyectar(DEF, METRICA, {});
  const sinDeuda = f.meses.reduce((a, m) => a + m.causas.filter((c) => c.clave !== 'deuda-declarada').reduce((b, c) => b + c.n, 0) + m.sin_declarar, 0);
  assert.strictEqual(sinDeuda, f.valor, 'lo que se ve en la lista, sin la deuda, suma el número grande');
});
