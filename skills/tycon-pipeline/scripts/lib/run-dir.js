'use strict';
/**
 * run-dir.js — la carpeta de la corrida de una historia: `<repo>/.advisors/pipeline-runs/<clave>-<sello>/`.
 *
 * Vive aparte de `pipeline.js` para que la pidan módulos livianos (la procedencia de `frozen-tree.js`, que carga el
 * tablero del sitio) sin arrastrar el pipeline entero. `pipeline.js` la reexporta con los mismos nombres.
 */
const fs = require('fs');
const path = require('path');

// La clave con que se nombra la carpeta de corrida, con el MOTIVO si no se puede calcular: `resolveRunDir` devuelve
// null en los dos casos («no hay carpeta» y «no hay clave»), y quien tiene que explicarle al dev qué pasó pregunta acá.
function runDirKey(storyId, storyPath) {
  return require('./evidence-key.js').keyInfoOr(storyPath, storyId);
}

// Resuelve el dir de la corrida: el más reciente `<clave>-*` (o exactamente `<clave>`, o
// `story-<clave>-*`) bajo <repo>/.advisors/pipeline-runs/. Con create=true y ninguno → crea
// `<clave>-<UTC-stamp>`. Sin create y ninguno → null.
// La clave es la de la evidencia (`lib/evidence-key.js`): el número solo si es único en el repo de la
// story, `<tema>__<número>` si se repite. Con número repetido, otra story del mismo número tiene SU carpeta y retomar
// por el número elegiría la más nueva de las dos. Sin `storyPath` (quien sólo tiene el número) es el número.
// Con `storyPath` y sin poder calcular la clave → null: no se elige ni se crea una carpeta a ciegas.
function resolveRunDir(repo, storyId, create, storyPath) {
  const runsBase = path.join(repo, '.advisors', 'pipeline-runs');
  const { key } = runDirKey(storyId, storyPath);
  if (!key) return null;
  const { ownsName } = require('./evidence-key.js');
  let names = [];
  try {
    names = fs.readdirSync(runsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => ownsName(n, key, storyId));
  } catch { names = []; }
  if (names.length) {
    // Puntuar por [tiene-archivos, mtime del archivo interno más reciente] — así un dir vacío/stray
    // (ej. creado por un `mkdir` accidental con RUNDIR sin resolver) PIERDE contra el dir que tiene
    // los reportes reales del run. Sin esto, "el dir con mtime más nuevo" elegiría la carpeta equivocada.
    let best = null; let bestHas = -1; let bestM = -1;
    for (const n of names) {
      const p = path.join(runsBase, n);
      let has = 0; let newest = 0;
      try {
        for (const f of fs.readdirSync(p)) {
          has = 1;
          try { newest = Math.max(newest, fs.statSync(path.join(p, f)).mtimeMs); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (!has) { try { newest = fs.statSync(p).mtimeMs; } catch { newest = 0; } }
      if (has > bestHas || (has === bestHas && newest > bestM)) { bestHas = has; bestM = newest; best = p; }
    }
    return best;
  }
  if (!create) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const dir = path.join(runsBase, `${key}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { runDirKey, resolveRunDir };
