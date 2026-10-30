'use strict';
/**
 * reloop-code.js — qué edición pide otra vuelta de revisores. Es la única regla: la usan `pipeline.js next`, la marca
 * `code` que on-edit pone en cada edición y el re-loop reducido; el cartel decide con esa marca.
 *
 * Pide otra vuelta un archivo de código (la lista de suite-freshness) que no está en una carpeta del arnés
 * (`.advisors`, `.tycon` y las demás de abajo), ni en la carpeta qa de la historia, ni es una prueba del pase
 * adversarial. La historia, sus marcas y su `runtime_not_verifiable:` son `.md`: no piden otra vuelta.
 */
const path = require('path');

// Sólo las carpetas del arnés y las dependencias. `bin`, `build`, `dist` y las demás salidas de compilación no están:
// un proyecto puede tener código propio en `scripts/bin/` o `src/build/`, y ese código pide otra vuelta.
const CARPETAS_DEL_ARNES = new Set(['node_modules', '.git', '.advisors', '.tycon', '.engram', '.dashboard', '.specs']);

function pideOtraVuelta(file, { storyPath } = {}) {
  if (!file) return false;
  const abs = path.resolve(String(file));
  if (abs.split(/[\\/]/).slice(0, -1).some((seg) => CARPETAS_DEL_ARNES.has(seg))) return false;
  if (require('./ledger-honesty.js').PROBE_RE.test(path.basename(abs))) return false;
  // La carpeta qa de ESTA historia, la que elige qa-dir.js; otra carpeta qa del repo puede tener pruebas de verdad.
  if (storyPath) {
    const qa = require('./qa-dir.js').qaDirFor(String(storyPath));
    if (abs.startsWith(`${qa}${path.sep}`)) return false;
  }
  return require('./suite-freshness.js').isCodeFile(abs);
}

module.exports = { pideOtraVuelta };
