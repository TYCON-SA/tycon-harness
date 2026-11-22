'use strict';
// Una parte de test-gate-green-saved.test.js (esta carpeta): carga el archivo entero y corre sólo sus pruebas (lib/suite-parts.js;
// cuáles, lo dice suite-parts.json de esta carpeta). Para correr todo: node --test test-gate-green-saved.test.js
require('./lib/suite-parts.js').runPart(__filename);
