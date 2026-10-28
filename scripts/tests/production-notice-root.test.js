#!/usr/bin/env node
/**
 * production-notice-root.test.js — el aviso de arranque del freno de producción nombra la raíz de repos sólo a una
 * sesión que corre dentro de ella.
 *
 * El caso: un modelo arrancó en una copia de laboratorio de un producto, leyó en el aviso de arranque «raíz de repos:
 * <la carpeta de los repos reales>» y fue a leer y escribir ahí, con rutas absolutas, en vez de en su copia.
 *
 * Correr: node --test scripts/tests/production-notice-root.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const { pieDeRaiz } = require(path.join(__dirname, '..', 'hooks', 'production-notice.js'));
// rutas de juguete armadas al correr, dentro de la carpeta temporal
const BASE = path.join(os.tmpdir(), 'acme');
const RAIZ = path.join(BASE, 'repos');
const LAB = path.join(BASE, 'laboratorio');
const INDICE = { raiz: RAIZ, fuente: 'sesiones', catalogos: [{}, {}] };
const nombra = (pie) => pie.includes(RAIZ);

test('T1 PieDeRaiz_SesionDentro_NombraLaRaiz', () => {
  const pie = pieDeRaiz(INDICE, 3, path.join(RAIZ, 'backend'), false);
  assert.ok(nombra(pie), pie);
  assert.ok(pie.endsWith(`${RAIZ} (sesiones) · catálogos: 2 · servidores de producción conocidos: 3`), pie);
  assert.ok(nombra(pieDeRaiz(INDICE, 3, RAIZ, false)));
});

test('T2 PieDeRaiz_SesionFuera_NoNombraLaRaiz: una copia de laboratorio no recibe la ruta de los repos reales', () => {
  const pie = pieDeRaiz(INDICE, 3, LAB, false);
  assert.ok(!nombra(pie), pie);
  assert.match(pie, /fuera de la de esta sesión · catálogos: 2/);
  // una carpeta que sólo empieza con el mismo nombre no está dentro
  assert.ok(!nombra(pieDeRaiz(INDICE, 3, `${RAIZ}-viejos`, false)));
});

test('T3 PieDeRaiz_ConReporte_LaNombraIgual: la persona que pide el reporte la ve', () => {
  assert.ok(nombra(pieDeRaiz(INDICE, 3, LAB, true)));
});
