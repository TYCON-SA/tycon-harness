'use strict';
// Corrector de la historia de juguete «variable del informe» de la prueba de resta.
const { juguete, cambiados } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/spanish-names.js", "llave": "TYCON_SPANISH_NAMES", "copiar": ["scripts/lib/spanish-words.json"]}, {
  verificar: (dir, base) => {
    const fs = require('fs'); const path = require('path');
    const leer = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
    const s = leer('scripts/report.js');
    return /process\.env\./.test(s) && /--[a-z]/.test(s) ? null : 'report.js no lee una variable de entorno y una opción';
  },
}));
