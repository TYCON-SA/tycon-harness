'use strict';
/**
 * thin-private.js — ¿es este repo el privado ADELGAZADO? Sólo lee dos archivos, sin git ni procesos.
 *
 * Vive aparte de private-tree.js para que quien sólo pregunta (el ok de guardar) no cargue lo que arma el árbol.
 */
const fs = require('fs');
const path = require('path');

const FORMS = path.join('.tycon', 'internal-forms.json');
const OVERLAY = path.join('scripts', 'ci', 'overlay-harness.js');

/**
 * ¿Es el privado adelgazado? → { thin, problem }. Lo es con la lista en `layout: thin` y el guion que pone el público
 * encima. Una lista que no se deja leer, o que dice `thin` sin el guion, no es «no lo es»: medir solo ese repo leería el
 * arnés instalado, así que vuelve el motivo y el portón frena. Sin lista, o con la lista de formas de antes (sin
 * `layout`), es otro repo.
 */
function detectThin(repo) {
  const lista = path.join(repo, FORMS);
  if (!fs.existsSync(lista)) return { thin: false, problem: null };
  let layout;
  try { layout = JSON.parse(fs.readFileSync(lista, 'utf8')).layout; } catch (e) {
    return { thin: false, problem: `no pude leer ${FORMS} (${e.message}): no sé si es el privado adelgazado, y medirlo solo leería el arnés instalado` };
  }
  if (layout !== 'thin') return { thin: false, problem: null };
  if (!fs.existsSync(path.join(repo, OVERLAY))) {
    return { thin: false, problem: `${FORMS} dice que es el privado adelgazado pero falta ${OVERLAY}: no puedo poner el público debajo, y medirlo solo leería el arnés instalado` };
  }
  return { thin: true, problem: null };
}
const isThinPrivate = (repo) => detectThin(repo).thin;

module.exports = { FORMS, OVERLAY, detectThin, isThinPrivate };
