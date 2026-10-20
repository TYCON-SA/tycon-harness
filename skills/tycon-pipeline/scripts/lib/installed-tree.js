'use strict';
// installed-tree.js — el árbol instalado del arnés y si una ruta cae adentro, por ruta real.
//
// En una máquina con instalación por versión, el arnés vive en la casa propia (`~/.tycon/harness`, con `team`,
// `third-party` y `previous` al lado) y se entra también por los enlaces de `~/.claude`. Ese árbol lo reemplaza entero
// cada actualización: el agente no lo escribe, y el arnés se cambia con un pedido a su repo. En modo automático Claude
// Code aprueba solo las escrituras fuera del proyecto, así que el que frena es el portón de escrituras.
//
// Una máquina cuyo arnés enlazado es un clon de trabajo no tiene árbol instalado: ese clon es de quien lo mantiene.
// Las rutas salen de scripts/setup/harness/tycon-home.js; en un clon de skills aparte (sin scripts/ al lado) no hay
// árbol que negar.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TYCON_HOME_LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
const tyconHome = fs.existsSync(TYCON_HOME_LIB) ? require(TYCON_HOME_LIB) : null;

const SIBLINGS = ['team', 'third-party', 'previous'];

/**
 * La ruta real de `p`, como la resuelve el sistema al escribir: cada parte se sigue en orden, así que un `..` después
 * de un enlace sube desde el destino del enlace, y un enlace roto se sigue hasta su destino aunque todavía no exista.
 * Lo que no existe se agrega tal cual.
 */
function realPath(p, depth = 0) {
  const s = String(p);
  const abs = path.isAbsolute(s) ? s : `${process.cwd()}${path.sep}${s}`;
  const root = path.parse(abs).root;
  let cur = root;
  try { cur = fs.realpathSync(root); } catch (_) { /* la raíz queda como vino */ }
  for (const part of abs.slice(root.length).split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') { cur = path.dirname(cur); continue; }
    cur = follow(path.join(cur, part), depth);
  }
  return cur;
}

function follow(p, depth) {
  try { return fs.realpathSync(p); } catch (_) { /* no existe, o es un enlace roto */ }
  let st = null;
  try { st = fs.lstatSync(p); } catch (_) { return p; }
  if (!st.isSymbolicLink() || depth >= 40) return p;
  let target;
  try { target = fs.readlinkSync(p); } catch (_) { return p; }
  return realPath(path.isAbsolute(target) ? target : `${path.dirname(p)}${path.sep}${target}`, depth + 1);
}

/**
 * Las raíces reales del árbol instalado, o `[]` si la máquina no tiene instalación por versión. Sin tycon-home.js al
 * lado (un clon de skills aparte, de antes de la casa propia) tampoco hay instalación por versión: no hay árbol que negar.
 */
function roots({ home = os.homedir() } = {}) {
  if (!tyconHome || !tyconHome.isReleaseMachine(home)) return [];
  const out = [];
  const harness = tyconHome.harnessDir(home);
  if (harness) out.push(realPath(harness));
  const own = path.dirname(tyconHome.ownStateDir(home));   // `~/.tycon` o TYCON_HOME
  for (const d of SIBLINGS) {
    const p = path.join(own, d);
    if (fs.existsSync(p)) out.push(realPath(p));
  }
  return [...new Set(out)];
}

function isInside(root, file) {
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = String(file).replace(/\\/g, '/').toLowerCase();
  return f === r || f.startsWith(r + '/');
}

/** ¿`file` (ruta cualquiera, o ya real con `{ real: true }`) cae bajo alguna de las raíces? */
function inside(rootList, file, { real = false } = {}) {
  if (!Array.isArray(rootList) || !rootList.length || !file) return false;
  const f = real ? file : realPath(file);
  return rootList.some((r) => isInside(r, f));
}

module.exports = { roots, inside, realPath };
