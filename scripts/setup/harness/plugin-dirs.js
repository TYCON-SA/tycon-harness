'use strict';
// plugin-dirs.js — la carpeta de los mods del arnés dentro de CLAUDE_CODE_PLUGIN_DIRS (story 7.27).
//
// Claude Code carga como plugin cada carpeta de esa variable (del entorno, o del `env` de ~/.claude/settings.json),
// separadas por el separador de listas de la plataforma (`:` en Mac y Linux, `;` en Windows). El dev puede tener las
// suyas: el arnés SUMA la propia, sin duplicar ni reordenar, y al desinstalar saca sólo la propia.
//
// La única entrada ajena que se saca es la del mod que el cartel tenía antes de entrar al arnés
// (`~/.claude/tycon-mods/tablero-corrida`), y sólo si esa carpeta ya no existe: una carpeta que no existe no carga nada.
//
// Vive en scripts/setup/harness/ porque la desinstalación corre desde la copia fija del programa, que sólo trae esa
// carpeta. La usan: scripts/setup/harness/shared.js (escribir y reconocer la pieza), scripts/setup/apply-hooks.js (el
// camino suelto), scripts/setup/harness.js (el plan), scripts/setup/harness/managed.js (¿está en su lugar?) y
// scripts/setup/harness/remove.js (desinstalar).

const fs = require('fs');
const path = require('path');

const PLUGIN_DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS';
const PLUGIN_DIRS_ID = `env.${PLUGIN_DIRS_KEY}`;
const OLD_MOD = path.join('.claude', 'tycon-mods', 'tablero-corrida');

/** La carpeta del plugin de los mods del arnés, por la ruta canónica del arnés instalado. */
function ourDir(home) {
  return path.join(home, '.claude', 'tycon-harness', 'mods', 'harness-mods');
}

/** El separador de la variable en la plataforma (`win32` como `process.platform`, o `windows` como el aplicador). */
function separator(platform = process.platform) {
  return platform === 'win32' || platform === 'windows' ? ';' : ':';
}

const expand = (entry, home) => (entry === '~' ? home : /^~[\\/]/.test(entry) ? path.join(home, entry.slice(2)) : entry);
const norm = (entry, home) => path.normalize(expand(entry, home)).replace(/[\\/]+$/, '');
const split = (value, sep) => (typeof value === 'string' ? value.split(sep).map((x) => x.trim()).filter(Boolean) : []);

/** ¿La lista tiene `dir`? (compara con `~` expandido y sin la barra final). */
function hasDir(value, dir, { sep = separator(), home }) {
  const want = norm(dir, home);
  return split(value, sep).some((e) => norm(e, home) === want);
}

/**
 * Suma `dir` a la lista. Devuelve `{ value, changed, dropped }`: `dropped` son las entradas del mod viejo que se sacaron.
 * `inherited`: la variable como la tiene exportada la terminal del dev. Si settings.json no la trae, se parte de esa:
 * la del `env` de settings.json le gana a la de la terminal, y escribir sólo la del arnés le haría perder sus carpetas
 * (pase adversarial de la 7.27, clase 3). `exists(path)` se puede pasar para probar; por defecto mira el disco.
 * Si la carpeta ya está y no sale nada, el valor queda tal cual (aunque traiga espacios o separadores de más: clase 12).
 */
function addDir(value, dir, { sep = separator(), home, exists = fs.existsSync, inherited = undefined }) {
  const base = typeof value === 'string' && value.trim() !== '' ? value : typeof inherited === 'string' ? inherited : value;
  const old = norm(path.join(home, OLD_MOD), home);
  const dropped = [];
  const kept = split(base, sep).filter((e) => {
    if (norm(e, home) === old && !exists(expand(e, home))) { dropped.push(e); return false; }
    return true;
  });
  const has = kept.some((e) => norm(e, home) === norm(dir, home));
  if (has && !dropped.length && base === value) return { value, changed: false, dropped };
  const next = (has ? kept : [...kept, dir]).join(sep);
  return { value: next, changed: next !== (typeof value === 'string' ? value : ''), dropped };
}

/** Saca `dir` de la lista. `value: null` = no queda nada (borrar la clave). */
function removeDir(value, dir, { sep = separator(), home }) {
  const before = split(value, sep);
  const after = before.filter((e) => norm(e, home) !== norm(dir, home));
  return { value: after.length ? after.join(sep) : null, changed: after.length !== before.length };
}

module.exports = { PLUGIN_DIRS_KEY, PLUGIN_DIRS_ID, ourDir, separator, hasDir, addDir, removeDir };
