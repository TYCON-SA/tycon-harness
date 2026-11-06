'use strict';
/**
 * reloop-code.js — qué edición pide otra vuelta de revisores. Es la única regla: la usan `pipeline.js next`, la marca
 * `code` que on-edit pone en cada edición y el re-loop reducido; el cartel decide con esa marca.
 *
 * Pide otra vuelta un archivo de código (la lista de suite-freshness) que no está en una carpeta del arnés
 * (`.advisors`, `.tycon` y las demás de abajo), ni en la carpeta qa de la historia, ni es una prueba del pase
 * adversarial, ni es una prueba del proyecto. La historia, sus marcas y su `runtime_not_verifiable:` son `.md`: no piden
 * otra vuelta.
 *
 * Una prueba se reconoce con `isTestPath` (lib/atdd-order.js) sobre la ruta desde la raíz de su repo, la carpeta con
 * `.git` más cercana: una carpeta `tests` por encima del repo no hace prueba al código. Sin raíz (fuera de todo repo, o
 * en una carpeta que ya no existe), cuenta como código: ante la duda, se revisa.
 */
const fs = require('fs');
const path = require('path');

// Sólo las carpetas del arnés y las dependencias. `bin`, `build`, `dist` y las demás salidas de compilación no están:
// un proyecto puede tener código propio en `scripts/bin/` o `src/build/`, y ese código pide otra vuelta.
const CARPETAS_DEL_ARNES = new Set(['node_modules', '.git', '.advisors', '.tycon', '.engram', '.dashboard', '.specs']);

// La raíz de repo de cada carpeta ya mirada: una vuelta por los eventos de un marcador repite carpetas.
const raices = new Map();

/** La carpeta con `.git` (carpeta o archivo, como en un worktree) más cercana a `abs`, o `null` si no hay. */
function raizDelRepo(abs) {
  const vistas = [];
  let dir = path.dirname(path.resolve(String(abs)));
  for (;;) {
    if (raices.has(dir)) { const r = raices.get(dir); for (const v of vistas) raices.set(v, r); return r; }
    vistas.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) { for (const v of vistas) raices.set(v, dir); return dir; }
    const padre = path.dirname(dir);
    if (padre === dir) { for (const v of vistas) raices.set(v, null); return null; }
    dir = padre;
  }
}

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
  if (!require('./suite-freshness.js').isCodeFile(abs)) return false;
  const raiz = raizDelRepo(abs);
  if (raiz && require('./atdd-order.js').isTestPath(path.relative(raiz, abs).split(path.sep).join('/'))) return false;
  return true;
}

module.exports = { pideOtraVuelta, raizDelRepo };
