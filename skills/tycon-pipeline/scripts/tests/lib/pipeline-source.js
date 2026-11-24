'use strict';
/**
 * pipeline-source.js — el texto de pipeline.js para las pruebas que lo leen: el despachador más sus partes de lib/
 * (`lib/pipeline-*.js`), en ese orden, cada una con su ruta arriba.
 *
 * Por qué existe: pipeline.js está partido por responsabilidad, y lo que una prueba buscaba en su texto puede vivir en
 * una parte. Leer sólo el despachador daría un rojo falso, y cada prueba armando su propia lista dejaría afuera la parte
 * que se sume mañana. Un solo lugar junta el texto.
 *
 * Uso: const pipelineSource = require('./lib/pipeline-source.js'); const texto = pipelineSource(scriptsDir);
 * `scriptsDir`: la carpeta de pipeline.js (de fábrica, la de estas pruebas).
 */
const fs = require('fs');
const path = require('path');

function pipelineSource(scriptsDir = path.resolve(__dirname, '..', '..')) {
  const lib = path.join(scriptsDir, 'lib');
  const partes = fs.readdirSync(lib).filter((f) => /^pipeline-.+\.js$/.test(f)).sort();
  return [path.join(scriptsDir, 'pipeline.js'), ...partes.map((m) => path.join(lib, m))]
    .map((f) => `// ── ${path.relative(scriptsDir, f)}\n${fs.readFileSync(f, 'utf8')}`)
    .join('\n');
}

module.exports = pipelineSource;
