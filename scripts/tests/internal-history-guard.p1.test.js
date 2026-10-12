'use strict';
// Una parte de scripts/tests/internal-history-guard.test.js: carga el archivo entero y corre sólo sus pruebas (scripts/tests/lib/suite-parts.js;
// cuáles, lo dice scripts/tests/suite-parts.json). Para correr todo: node --test scripts/tests/internal-history-guard.test.js
require('./lib/suite-parts.js').runPart(__filename);
