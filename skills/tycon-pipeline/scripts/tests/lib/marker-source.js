'use strict';
/**
 * marker-source.js — el texto de marker.js para las pruebas que lo leen: el despachador más sus partes de lib/
 * (`lib/marker-*.js`, sin marker-command.js, que es otra cosa), en ese orden, cada una con su ruta arriba.
 *
 * Por qué existe: marker.js está partido por responsabilidad, y lo que una prueba buscaba en su texto puede vivir en una
 * parte. Leer sólo el despachador daría un rojo falso, y cada prueba armando su propia lista dejaría afuera la parte que
 * se sume mañana. Un solo lugar junta el texto.
 *
 * Uso: const markerSource = require('./lib/marker-source.js'); const texto = markerSource(scriptsDir);
 * `scriptsDir`: la carpeta de marker.js (de fábrica, la de estas pruebas).
 */
const fs = require('fs');
const path = require('path');

function markerSource(scriptsDir = path.resolve(__dirname, '..', '..')) {
  const lib = path.join(scriptsDir, 'lib');
  const partes = fs.readdirSync(lib).filter((f) => /^marker-.+\.js$/.test(f) && f !== 'marker-command.js').sort();
  return [path.join(scriptsDir, 'marker.js'), ...partes.map((m) => path.join(lib, m))]
    .map((f) => `// ── ${path.relative(scriptsDir, f)}\n${fs.readFileSync(f, 'utf8')}`)
    .join('\n');
}

module.exports = markerSource;
