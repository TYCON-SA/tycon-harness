#!/usr/bin/env node
'use strict';
/**
 * old-gate-results.js — borra las carpetas de resultados viejas de test-gate.sh.
 *
 * Cada corrida de la puerta deja su carpeta `test-gate-XXXXXX` en el temporal, con el resumen y la salida entera de
 * cada suite roja; nadie más la borra. Al arrancar, la puerta borra las suyas de más de 7 días: sólo carpetas reales
 * (no enlaces) colgadas directo del temporal, con ese nombre exacto y del usuario que corre. Lo demás no se toca.
 *
 * Uso: old-gate-results.js <temporal>  ·  sale 0 siempre: no poder limpiar no frena la puerta, se avisa.
 */
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// El nombre que deja `mktemp -d <temporal>/test-gate-XXXXXX`.
const NAME = /^test-gate-[A-Za-z0-9]{6}$/;

/** Borra las carpetas viejas de la puerta en `root`; devuelve las rutas borradas. */
function pruneOldResults(root, { now = Date.now(), maxAgeMs = MAX_AGE_MS, uid = process.getuid ? process.getuid() : null } = {}) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return removed; }
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const dir = path.join(root, name);
    let st;
    try { st = fs.lstatSync(dir); } catch (_) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (uid !== null && st.uid !== uid) continue;
    if (now - st.mtimeMs <= maxAgeMs) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (e) {
      console.error(`[test-gate] ⚠️  no pude borrar la carpeta vieja ${dir}: ${e.message}`);
    }
  }
  return removed;
}

if (require.main === module) {
  const root = process.argv[2];
  if (root) pruneOldResults(root);
  process.exit(0);
}
module.exports = { pruneOldResults, MAX_AGE_MS };
