'use strict';
// Corrector de la historia de juguete «promedio» de la prueba de resta.
const { juguete, cambiados } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/spanish-names.js", "llave": "TYCON_SPANISH_NAMES", "copiar": ["scripts/lib/spanish-words.json"]}, {
  verificar: (dir, base) => {
    const nuevos = cambiados(dir, base).filter((c) => c.estado === 'A' && /^scripts\/[^/]+\.js$/.test(c.ruta));
    return nuevos.length ? null : 'no agregó un guion en scripts/';
  },
}));
