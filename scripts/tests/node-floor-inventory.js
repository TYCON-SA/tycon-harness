'use strict';
/**
 * node-floor-inventory.js — los scripts que las instrucciones (skills, comandos, pasos) mandan correr con `node <ruta>`.
 *
 * Lo comparten node-floor.test.js (cada uno arranca por el piso y no usa `?.` ni `??`) y node-old-real.test.sh (cada uno
 * lo lee un Node 12 de verdad). Una sola lista: un script nuevo en una instrucción entra a las dos pruebas sin tocarlas.
 *
 * Correr suelto:   node scripts/tests/node-floor-inventory.js   → una ruta relativa por línea
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// los scripts que todavía no arrancan por el piso (vacía: lo hacen todos)
const PENDING = new Set([]);

/** Nombre de script → la instrucción donde aparece primero. */
function namedInInstructions() {
  const out = new Map();
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (n !== 'node_modules' && n !== 'tests') walk(p); continue; }
      if (!n.endsWith('.md')) continue;
      const text = fs.readFileSync(p, 'utf8');
      // la ruta, cualquier cosa sin espacios ni comillas: `<arnés>/…` con acento y `${TYCON_GUIDES_DIR:-$HOME/…}/…` también
      for (const m of text.matchAll(/\bnode\s+["']?[^\s"'`]*\/([A-Za-z0-9_.-]+\.js)\b/g)) {
        if (!out.has(m[1])) out.set(m[1], path.relative(ROOT, p));
      }
    }
  };
  for (const d of ['skills', 'commands']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out;
}

/** Dónde vive cada uno en este árbol: los archivos con ese nombre fuera de las pruebas y de las copias de la producción. */
function locate(name) {
  // los rastreados y los nuevos sin agregar todavía: un script recién escrito también entra
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', `*${name}`], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(String(r.stdout || '').split('\n'))].filter((f) => f && path.basename(f) === name && !/\/tests?\//.test(f) && !/guard-libs/.test(f));
}

/** `[{ rel, name, where, pending }]`: cada script del arnés que una instrucción manda correr. */
function inventory() {
  const out = [];
  for (const [name, where] of namedInInstructions()) {
    for (const rel of locate(name)) out.push({ rel, name, where, pending: PENDING.has(name) });
  }
  return out;
}

module.exports = { ROOT, PENDING, inventory, namedInInstructions };

if (require.main === module) {
  for (const s of inventory()) if (!s.pending) process.stdout.write(`${s.rel}\n`);
}
