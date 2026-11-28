'use strict';
// runs-mobile-tables.test.js — las tablas del detalle de una ejecución se leen en el celular.
//
// En una pantalla angosta (hasta 640 px) la tabla de ejecuciones se rearma en tarjetas: cada fila en una grilla, sin
// encabezado. Esas reglas tienen que tocar sólo la tabla principal. Las tablas que hay dentro del detalle abierto
// («Controles…», «Archivos que tocó») son tablas comunes: si las reglas les llegan, sus celdas se apilan en la primera
// columna debajo de un encabezado de seis, y no se sabe qué número es cuál (visto en el recorrido del sitio, 27/11).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'nightly', 'dashboard', 'runs.js');

/** El bloque de reglas de la pantalla angosta de la tabla (`@media (max-width:640px){…}`), con sus llaves equilibradas. */
function bloqueAngosto(texto) {
  const i = texto.indexOf('@media (max-width:640px){.tabla');
  assert.ok(i >= 0, 'no encontré las reglas de pantalla angosta de la tabla');
  let n = 0;
  for (let j = texto.indexOf('{', i); j < texto.length; j += 1) {
    if (texto[j] === '{') n += 1;
    else if (texto[j] === '}' && --n === 0) return texto.slice(i, j + 1);
  }
  assert.fail('las llaves del bloque no cierran');
}

// 🔴 Falla con: reglas como `.tabla table{display:block}` o `.tabla .fila-det td{display:block}`, que también desarman
// las tablas del detalle.
test('M1 Celular_LasReglasDeTarjetasSoloTocanLaTablaPrincipal — las tablas del detalle conservan sus columnas', () => {
  const bloque = bloqueAngosto(fs.readFileSync(RUNS, 'utf8'));
  const sueltas = bloque.match(/\.tabla (?:table|thead|tbody)\b|\.tabla tbody tr\b|\.fila-det td\b/g);
  assert.strictEqual(sueltas, null, `reglas que también alcanzan a las tablas del detalle: ${JSON.stringify(sueltas)}`);
  assert.match(bloque, /\.tabla>table\{display:block/, 'la tabla principal sigue en tarjetas');
  assert.match(bloque, /\.fila-det>td\{display:block/, 'la celda del detalle sigue ocupando el ancho');
});

// 🔴 Falla con: «Controles» con sus columnas de ancho fijo en el celular. Medido a 360 px en un navegador: las cinco
// columnas de números suman 301 px en una caja de 280, y el nombre del control queda con ancho 0, escrito encima de los
// números. Y una ruta larga de «Archivos que tocó» se pasa de su caja si no se corta.
// Las reglas van en un bloque propio DESPUÉS de las de base de esas tablas: con la misma especificidad gana la última, y
// puestas antes no se aplicaban (medido: el nombre seguía en 0 px).
test('M2 Celular_ControlesSeArmaSegunSuContenido_YLosNombresLargosSeCortan', () => {
  const texto = fs.readFileSync(RUNS, 'utf8');
  const i = texto.indexOf('@media (max-width:640px){table.mt');
  assert.ok(i >= 0, 'falta el bloque de celular de las tablas del detalle');
  const base = texto.indexOf('table.mt.ctls{table-layout:fixed');
  const cols = texto.indexOf('table.mt.ctls col.c-veces{width:');
  assert.ok(base >= 0 && cols >= 0 && i > base && i > cols, 'el bloque va después de las reglas de base de Controles');
  const bloque = texto.slice(i, texto.indexOf('}}', i) + 2);
  assert.match(bloque, /table\.mt\.ctls\{table-layout:auto\}/, 'en el celular, Controles no tiene columnas fijas');
  assert.match(bloque, /table\.mt\.ctls col\[class\]\{width:auto\}/, 'ni anchos fijos por columna (le gana a col.c-…)');
  assert.match(bloque, /table\.mt td:first-child\{overflow-wrap:anywhere\}/, 'el nombre o la ruta se corta');
});
