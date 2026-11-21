'use strict';
// La biblioteca que parte una suite de Node sin mover sus pruebas, para las suites de esta carpeta: es la de las suites del
// arnés (en la raíz del repo, scripts/tests/lib), la misma instancia. Cada parte lee el registro de su propia carpeta
// (suite-parts.json, al lado de la suite).
const path = require('path');

module.exports = require(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'tests', 'lib', 'suite-parts.js'));
