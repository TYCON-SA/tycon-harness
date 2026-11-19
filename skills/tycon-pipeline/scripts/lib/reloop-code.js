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
 * `.git` más cercana: una carpeta `tests` por encima del repo no hace prueba al código. Sin raíz (fuera de todo repo),
 * no pide otra vuelta: no está en ningún pedido y el sello de lo guardado no lo mira (un guion de ayuda que la sesión
 * deja en una carpeta sin git). Un archivo borrado dentro de un repo sigue encontrando la raíz: la búsqueda sube por las
 * carpetas aunque la suya ya no exista.
 *
 * Con el repo de la corrida (`repoPath`), tampoco pide otra vuelta un archivo de un repo que no es el de la corrida, ni
 * el de la historia, ni un hermano declarado (`evidence.companion_repos`): una prueba del pase en un laboratorio con su
 * propio git. Un repo se reconoce por su carpeta git común, así que cualquier copia (worktree) de uno de ellos, en la
 * rama que sea, sigue contando. Si algo de eso no se puede leer, pide: ante la duda, se revisa.
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

/**
 * La carpeta git común de una raíz de repo, la misma para todas sus copias: `.git` si es carpeta; si es archivo (una
 * copia), la que dice su `commondir`. Sin git (sólo el sistema de archivos: corre en cada edición). null si no se lee.
 */
function comunDe(raiz) {
  // la versión nativa devuelve las mayúsculas del disco: en uno que no las distingue, «MiRepo» y «mirepo» son el mismo
  const realDe = (p) => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try {
    const g = path.join(raiz, '.git');
    if (fs.statSync(g).isDirectory()) return realDe(g);
    const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const dir = path.resolve(raiz, m[1]);
    const comun = path.join(dir, 'commondir');
    return realDe(fs.existsSync(comun) ? path.resolve(dir, fs.readFileSync(comun, 'utf8').trim()) : dir);
  } catch (_) { return null; }
}

/** ¿El repo de `raiz` no es ninguno de la corrida? false si no se puede saber. */
function fueraDeLaCorrida(raiz, { storyPath, repoPath }) {
  const propio = comunDe(raiz);
  if (!propio) return false;
  const deLaCorrida = [repoPath, storyPath ? path.dirname(path.resolve(String(storyPath))) : null]
    .filter(Boolean).map((d) => raizDelRepo(path.join(path.resolve(String(d)), '_')));
  if (deLaCorrida.includes(null)) return false;
  const { parseEvidenceConfig } = require('./evidence-config.js');
  const repos = new Set(deLaCorrida);
  for (const r of deLaCorrida) {
    const cfg = parseEvidenceConfig(r);
    // un hermano declarado que no está en disco: no se sabe dónde está su código, y un archivo de otro repo puede ser suyo
    if (cfg.missing.length) return false;
    for (const h of cfg.roots) repos.add(path.resolve(r, String(h)));
  }
  const comunes = new Set();
  for (const r of repos) {
    // un hermano que no está en disco: no se sabe si el archivo es suyo
    const rr = raizDelRepo(path.join(r, '_'));
    const c = rr && comunDe(rr);
    if (!c) return false;
    comunes.add(c);
  }
  return !comunes.has(propio);
}

function pideOtraVuelta(file, { storyPath, repoPath } = {}) {
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
  if (raiz === null) return false;
  if (require('./atdd-order.js').isTestPath(path.relative(raiz, abs).split(path.sep).join('/'))) return false;
  if (repoPath) { try { if (fueraDeLaCorrida(raiz, { storyPath, repoPath })) return false; } catch (_) { /* pide */ } }
  return true;
}

module.exports = { pideOtraVuelta, raizDelRepo };
