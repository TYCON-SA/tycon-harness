'use strict';
// Corrector de la historia de juguete «guía de las tareas» de la prueba de resta.
const { juguete, cambiados } = require('./toy-commit.js');

module.exports = juguete(Object.assign({"guion": "scripts/publishing/internal-history.js", "llave": "TYCON_INTERNAL_HISTORY"}, {
  verificar: (dir, base) => {
    const fs = require('fs'); const path = require('path');
    const leer = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
    const s = leer('guides/tasks.md');
    return cambiados(dir, base).some((c) => c.ruta === 'guides/tasks.md') && /vencid|overdue/i.test(s) ? null : 'no agregó a guides/tasks.md el subcomando de las vencidas';
  },
}));
