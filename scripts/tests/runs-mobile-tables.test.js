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
