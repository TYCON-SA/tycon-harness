'use strict';
/**
 * La guía de piezas está partida: `guides/piezas-del-arnes.md` es el índice (el árbol «Dónde vive cada cosa» y la
 * lista de las piezas por grupo) y las fichas viven en `guides/pieces/<grupo>.md`, con su título `## <ruta>`.
 *
 * Las pruebas que buscan una ficha, o lo que dice una ficha, leen todo junto con `piecesText()`: así no dependen del
 * grupo donde cayó la pieza. Las que revisan archivo por archivo (que ninguno nombre algo) recorren `piecesFiles()`.
 */
const fs = require('node:fs');
const path = require('node:path');

const INDEX = 'guides/piezas-del-arnes.md';
const GROUPS_DIR = 'guides/pieces';

/**
 * Las rutas relativas del índice y de cada archivo de grupo, el índice primero y los grupos en orden alfabético.
 * Sin grupos falla: una prueba que revisa archivo por archivo pasaría en verde mirando sólo el índice.
 */
function piecesFiles(root) {
  const dir = path.join(root, GROUPS_DIR);
  const groups = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => `${GROUPS_DIR}/${f}`) : [];
  if (!groups.length) throw new Error(`no encontré las fichas de la guía de piezas en ${GROUPS_DIR}/: sin ellas no se mide nada`);
  return [INDEX, ...groups];
}

/**
 * El texto del índice y las fichas de todos los grupos, uno detrás del otro. De cada grupo va desde su primera ficha:
 * sin su encabezado, la última ficha de un grupo termina donde empieza la primera del siguiente.
 */
function piecesText(root) {
  return piecesFiles(root).map((rel) => {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (rel === INDEX) return text;
    const first = text.search(/^## /m);
    return first < 0 ? '' : text.slice(first);
  }).join('\n');
}

module.exports = { INDEX, GROUPS_DIR, piecesFiles, piecesText };
