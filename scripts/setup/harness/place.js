'use strict';
// place.js — dónde vive el arnés en la máquina: el nombre del lugar, el nombre viejo y cómo se los lee.
//
// ── EL PORQUÉ ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Quien clona el repo público lee después `~/.claude/tycon-claude-guides`: el nombre del repo interno, que afuera nadie
// conoce. Por eso el lugar se llama como el repo público,
// `~/.claude/tycon-harness`, y el nombre viejo sigue resolviendo en las máquinas ya instaladas. Esta es la
// definición única del nombre: nadie más lo escribe a mano.
//
// ── QUÉ HAY ACÁ ───────────────────────────────────────────────────────────────────────────────────────────────────
//   · PLACE_NAME y LEGACY_PLACE_NAME, placePath(home), legacyPlacePath(home) y resolvePlace({ home }): los de
//     tycon-home.js, re-exportados. Nadie más escribe los dos nombres, salvo las copias declaradas en
//     scripts/tests/fixtures/harness-place-names.json (lo que no puede importar: la copia fija de arranque, lo que se
//     copia fuera del repo y el lector de las skills). Una prueba frena si una copia se desfasa.
//   · samePath(a, b, platform): compara dos rutas como las compara el sistema: sin la barra final, con `/` y `\` iguales y
//     sin distinguir mayúsculas en Windows.
//
// Los dos nombres, sus rutas y resolvePlace viven en tycon-home.js, la única pieza que sabe
// dónde vive el arnés: este archivo queda como su fachada (la API de siempre, para los que ya lo cargan) más samePath.
// Vive en scripts/setup/harness/ porque harness.js copia esa carpeta entera a la copia fija del programa: viaja solo,
// con tycon-home.js al lado, a donde corren `rollback` y `uninstall` con el árbol roto.
const path = require('path');
const H = require('./tycon-home.js');

const { PLACE_NAME, LEGACY_PLACE_NAME, placePath, legacyPlacePath, isHarnessClone, resolvePlace } = H;

/** ¿Las dos rutas son la misma, como las compara el sistema? En Windows no distingue mayúsculas ni `/` de `\`. */
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p) => {
    let s = String(p);
    if (platform === 'win32') s = s.replace(/\//g, '\\');
    s = P.normalize(s);
    while (s.length > 1 && (s.endsWith(P.sep)) && !(platform === 'win32' && /^[A-Za-z]:\\$/.test(s))) s = s.slice(0, -1);
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

module.exports = { PLACE_NAME, LEGACY_PLACE_NAME, placePath, legacyPlacePath, resolvePlace, samePath, isHarnessClone };
