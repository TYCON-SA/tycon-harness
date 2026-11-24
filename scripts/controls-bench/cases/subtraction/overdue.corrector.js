'use strict';
// Corrector de la historia de juguete «vencidas» de la prueba de resta.
const { juguete, cambiados } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/spanish-names.js", "llave": "TYCON_SPANISH_NAMES", "copiar": ["scripts/lib/spanish-words.json"]}, {
  verificar: (dir, base) => {
    return cambiados(dir, base).some((c) => c.ruta === 'scripts/tasks.js') ? null : 'no cambió scripts/tasks.js';
  },
}));
