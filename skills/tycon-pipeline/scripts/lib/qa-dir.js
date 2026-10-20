'use strict';
/**
 * qa-dir.js — la carpeta donde viven la maqueta, la guía del tester, sus pasos, las revisiones de legibilidad y el
 * preámbulo de una historia. Es la única regla: la guía, el freno del commit y la maqueta la usan.
 *
 *   - historia en una carpeta de historias (`stories/`, `historias/`): `qa/` al lado de esa carpeta;
 *   - historia suelta en `specs/`: `specs/qa/`, salvo que el repo ya use `qa/` al lado de `specs/` y no tenga
 *     `specs/qa/`: ahí sigue al lado, para no partir la carpeta de un repo que ya la usa;
 *   - cualquier otra carpeta: `qa/` al lado de la carpeta de la historia.
 *
 * Una historia empezada no se muda: si la carpeta elegida no tiene archivos suyos y `qa/` al lado de su carpeta sí,
 * se queda ahí.
 */
const fs = require('fs');
const path = require('path');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** ¿La carpeta tiene algún archivo de la historia? Los archivos empiezan con una de sus claves y un guion. */
function hasStoryFiles(dir, keys) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((n) => keys.some((k) => k && n.startsWith(`${k}-`)));
}

/**
 * La carpeta qa/ de una historia. `keys`: los prefijos de sus archivos (la clave, el número, el nombre del archivo de
 * la historia sin `.md`); con ellos se reconoce una historia empezada en el lugar de antes.
 */
function qaDirFor(storyPath, keys = []) {
  const abs = path.resolve(storyPath);
  const storyDir = path.dirname(abs);
  const sibling = path.join(path.dirname(storyDir), 'qa');
  let chosen = sibling;
  if (path.basename(storyDir).toLowerCase() === 'specs') {
    const inside = path.join(storyDir, 'qa');
    chosen = isDir(sibling) && !isDir(inside) ? sibling : inside;
  }
  const allKeys = [...keys, path.basename(abs, '.md')].filter(Boolean).map(String);
  if (chosen !== sibling && !hasStoryFiles(chosen, allKeys) && hasStoryFiles(sibling, allKeys)) return sibling;
  return chosen;
}

module.exports = { qaDirFor };
