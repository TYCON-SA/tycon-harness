'use strict';
/**
 * path-forms.js — las decisiones del pipeline que dependen de la forma de una ruta.
 *
 * En Windows una ruta llega con `\` (la herramienta), con `/` (git), con letra de unidad o en otra caja, y el mismo
 * archivo puede escribirse de varias formas. Una decisión que compara texto, o que usa una expresión que sólo entiende
 * `/`, da otra respuesta según quién escribió la ruta, y a veces esa respuesta es «nada»: un aviso que no sale, una
 * selección vacía. Cada función recibe el módulo `path` (por omisión, el de la plataforma) para que la prueba la mida
 * con `path.win32` desde cualquier sistema. Ante la duda, la respuesta es la que hace avisar o correr más.
 */

const path = require('path');

const aBarras = (s) => String(s).replace(/\\/g, '/');

/** ¿Es un archivo de pruebas de navegador (`*.spec.ts` bajo una carpeta `e2e`, sola o dentro de `tests`)? */
function isE2eSpecPath(file) {
  const f = aBarras(file);
  return /\.spec\.ts$/.test(f) && /(^|\/)(tests\/)?e2e\//.test(f);
}

/**
 * La ruta de `file` relativa a `root`, con `/`, o `null` si queda fuera del repo. Fuera es subir (`..`) y también
 * seguir siendo absoluta: entre dos unidades de Windows `path.relative` devuelve la ruta de la otra unidad, no un `..`.
 * La raíz misma no es un archivo del repo.
 */
function relativeInsideRepo(root, file, p = path) {
  const rel = p.relative(root, file);
  if (!rel || p.isAbsolute(rel)) return null;
  const r = aBarras(rel);
  return (r === '..' || r.startsWith('../')) ? null : r;
}

/** La ruta de `file` relativa a `root`, escrita con `/` como las demás rutas relativas al repo. */
function posixRelative(root, file, p = path) {
  return aBarras(p.relative(root, file));
}

/**
 * ¿`file` está dentro de `root`? Con el separador final siempre (`/repos/back` no es `/repos/back2`), las barras
 * unificadas donde el separador es `\`, y sin distinguir mayúsculas en ningún sistema: Windows y la Mac las ignoran por
 * defecto, y encontrar de más hace avisar más, nunca menos.
 */
function isInsideRepo(file, root, p = path) {
  const forma = (s) => (p.sep === '\\' ? String(s).replace(/\//g, '\\') : String(s)).toLowerCase();
  const r = forma(root);
  const prefijo = r.endsWith(p.sep) ? r : r + p.sep;
  return forma(file).startsWith(prefijo);
}

module.exports = { isE2eSpecPath, relativeInsideRepo, posixRelative, isInsideRepo };
