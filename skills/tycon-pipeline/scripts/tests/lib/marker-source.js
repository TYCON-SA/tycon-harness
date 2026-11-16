'use strict';
/**
 * marker-source.js — el texto de marker.js para las pruebas que lo leen: el despachador más sus módulos de lib/
 * (`lib/marker-*.js`), en ese orden, cada uno con su ruta arriba.
 *
 * Por qué existe: marker.js quedó partido por responsabilidad; lo que una prueba buscaba en su texto ahora puede vivir en
 * un módulo. Leer sólo el despachador daría un rojo falso, y cada prueba armando su propia lista de módulos dejaría
 * afuera el que se sume mañana. Un solo lugar que junta el texto.
 *
 * Uso: const markerSource = require('./lib/marker-source.js'); const texto = markerSource(scriptsDir);
 * `scriptsDir`: la carpeta de marker.js (de fábrica, la del arnés de estas pruebas).
 */
const fs = require('fs');
const path = require('path');

function markerSource(scriptsDir = path.resolve(__dirname, '..', '..')) {
  const lib = path.join(scriptsDir, 'lib');
  const modulos = fs.readdirSync(lib).filter((f) => /^marker-.+\.js$/.test(f) && f !== 'marker-command.js').sort();
  return [path.join(scriptsDir, 'marker.js'), ...modulos.map((m) => path.join(lib, m))]
    .map((f) => `// ── ${path.relative(scriptsDir, f)}\n${fs.readFileSync(f, 'utf8')}`)
    .join('\n');
}

module.exports = markerSource;
