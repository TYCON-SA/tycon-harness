'use strict';
// Corrector de la historia de juguete «guía de los datos» de la prueba de resta.
const { juguete } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/internal-history.js", "llave": "TYCON_INTERNAL_HISTORY"}, {
  verificar: (dir, base) => {
    const fs = require('fs'); const path = require('path');
    const leer = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
    const s = leer('guides/data.md');
    return s.length >= 200 && s.includes('rows.json') ? null : 'no escribió guides/data.md con el formato de data/rows.json';
  },
}));
