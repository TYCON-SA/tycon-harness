'use strict';
// git-tree-hash.js — el hash de git de un blob y de un árbol, calculado acá, sin git (story 8.23, tanda B).
//
// Nació en install-third-party.js (story 8.5): las skills de terceros se fijan por hash de árbol y cada máquina verifica
// lo que baja ANTES de escribirlo. La tanda B de la 8.23 lo necesita para otra cosa: una versión bajada como comprimido
// se da por buena sólo si el árbol que trae es el del commit publicado. Dos usos, una definición; install-third-party.js
// lo re-exporta tal cual (tar-reader.test.js lo comprueba).
//
// Las entradas son archivos [{ mode, path, sha }] con rutas relativas separadas por `/`; las carpetas se deducen. El modo
// es el de git (`100644`, `100755`, `120000`, `160000`): quien lo calcula lo toma de donde lo sepa de verdad —de la
// cabecera del tar, no del disco: Windows no guarda el bit de ejecutable (medición del 2026-10-07)—.
//
// Sin dependencias: sólo `crypto`.

const crypto = require('crypto');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/** El sha de un blob de git: `blob <largo>\0<bytes>`. */
function blobSha(buf) {
  return sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
}

/** Hash del árbol de git de una lista de archivos [{mode, path, sha}] (con sus subcarpetas). */
function treeSha(entries) {
  const root = new Map();
  for (const e of entries) {
    const parts = e.path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.has(p)) dir.set(p, new Map());
      dir = dir.get(p);
    }
    dir.set(parts[parts.length - 1], { mode: e.mode, sha: e.sha });
  }
  const hashDir = (dir) => {
    // git ordena las entradas por nombre, con `/` pegado a las carpetas (así `a-b` va antes que `a/` y `a.c` después)
    const items = [...dir].map(([name, v]) => (v instanceof Map ? { name, mode: '40000', sha: hashDir(v), key: `${name}/` } : { name, mode: v.mode, sha: v.sha, key: name }));
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = Buffer.concat(items.map((i) => Buffer.concat([Buffer.from(`${i.mode} ${i.name}\0`), Buffer.from(i.sha, 'hex')])));
    return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
  };
  return hashDir(root);
}

module.exports = { blobSha, treeSha };
