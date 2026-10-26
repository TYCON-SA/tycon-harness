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

/** Nombre de script → la instrucción donde aparece primero y las rutas con que lo nombran las instrucciones. */
function collectNamed(root = ROOT) {
  const out = new Map();
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (n !== 'node_modules' && n !== 'tests') walk(p); continue; }
      if (!n.endsWith('.md')) continue;
      const text = fs.readFileSync(p, 'utf8');
      // la ruta, cualquier cosa sin espacios ni comillas: `<arnés>/…` con acento y `${TYCON_GUIDES_DIR:-$HOME/…}/…` también
      for (const m of text.matchAll(/\bnode\s+["']?([^\s"'`]*\/([A-Za-z0-9_.-]+\.js))\b/g)) {
        if (!out.has(m[2])) out.set(m[2], { where: path.relative(root, p), paths: new Set() });
        out.get(m[2]).paths.add(m[1]);
      }
    }
  };
  for (const d of ['skills', 'commands']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  return out;
}

/** Nombre de script → la instrucción donde aparece primero. */
function namedInInstructions(root = ROOT) {
  return new Map([...collectNamed(root)].map(([name, v]) => [name, v.where]));
}

/** Dónde vive cada uno en este árbol: los archivos con ese nombre fuera de las pruebas y de las copias de la producción. */
function locate(name, root = ROOT) {
  // los rastreados y los nuevos sin agregar todavía: un script recién escrito también entra
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', `*${name}`], { cwd: root, encoding: 'utf8' });
  return [...new Set(String(r.stdout || '').split('\n'))].filter((f) => f && path.basename(f) === name && !/\/tests?\//.test(f) && !/guard-libs/.test(f));
}

/**
 * `[{ rel, name, where, pending }]`: cada script del arnés que una instrucción manda correr. Se busca por la ruta que
 * nombra la instrucción: un atajo viejo o un archivo que se llama igual en otra carpeta no es lo que se corre. Si ningún
 * archivo calza con una de esas rutas, por esa ruta entran todos los que se llaman igual.
 */
function inventory(root = ROOT) {
  const out = [];
  for (const [name, { where, paths }] of collectNamed(root)) {
    const all = locate(name, root);
    // cada ruta nombrada por su cuenta; una relativa a la carpeta de la skill calza con el archivo que termina en ella
    const keep = new Set();
    for (const p of paths) {
      const hit = all.filter((rel) => p === rel || p.endsWith(`/${rel}`) || rel.endsWith(`/${p}`));
      for (const rel of hit.length ? hit : all) keep.add(rel);
    }
    for (const rel of all.filter((x) => keep.has(x))) out.push({ rel, name, where, pending: PENDING.has(name) });
  }
  return out;
}

module.exports = { ROOT, PENDING, inventory, namedInInstructions };

if (require.main === module) {
  for (const s of inventory()) if (!s.pending) process.stdout.write(`${s.rel}\n`);
}
