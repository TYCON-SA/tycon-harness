'use strict';
// Corrector de la historia de juguete «guía del informe» de la prueba de resta.
const { juguete, cambiados } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/internal-history.js", "llave": "TYCON_INTERNAL_HISTORY"}, {
  verificar: (dir, base) => {
    const fs = require('fs'); const path = require('path');
    const leer = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
    const s = leer('guides/report.md');
    return s.length >= 200 && s.includes('report.js') ? null : 'no escribió guides/report.md con cómo se usa report.js';
  },
}));
