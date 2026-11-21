#!/usr/bin/env node
'use strict';

/**
 * on-owner-away-claude-dir.js — con el dueño ausente, no se edita a mano dentro de la carpeta de Claude Code.
 *
 * Corre en la cadena de antes de editar del despachador (`dispatch.js`), en cualquier paso. Claude Code pide confirmación
 * para escribir en su carpeta aun sin permisos; con la marca del dueño ausente puesta (scripts/lib/owner-away.js) nadie la
 * da, y la sesión queda esperando hasta que vuelve. Frena antes y dice qué hacer: los guiones del arnés escriben ahí por
 * su cuenta, y lo demás queda para la vuelta.
 *
 * No cuentan las dos subcarpetas donde Claude Code deja escribir sin preguntar: `jobs/` (la carpeta de trabajo de cada
 * sesión de fondo) y `projects/` (las memorias). En macOS y Windows la caja de las letras no cuenta (`~/.Claude` es la misma
 * carpeta). Sin poder leer la marca, el dueño cuenta como presente (lo decide owner-away).
 *
 * Límites declarados: mira Edit y Write (el gancho del despachador no recibe NotebookEdit), y la carpeta es la de la casa
 * (`~/.claude`), no otra elegida con CLAUDE_CONFIG_DIR. Se apaga con TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD=0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const LIBRES = ['jobs', 'projects'];

const real = (p) => {
  // el archivo todavía no existe: se resuelve su carpeta más cercana que sí
  let dir = p;
  const resto = [];
  for (let i = 0; i < 64; i++) {
    // la versión nativa devuelve la caja real del disco: con la de JS, `~/.Claude` no se reconoce como `~/.claude`
    try { return path.join(fs.realpathSync.native(dir), ...[...resto].reverse()); } catch (_) { /* sube */ }
    const padre = path.dirname(dir);
    if (padre === dir) break;
    resto.push(path.basename(dir));
    dir = padre;
  }
  return path.resolve(p);
};

/** ¿`abs` cae dentro de la carpeta de Claude Code de `home`, fuera de sus subcarpetas libres? */
function enLaCarpetaDeClaude(abs, home) {
  const carpeta = real(require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).claudeDir(home));
  const sinCaja = process.platform === 'darwin' || process.platform === 'win32';
  const caja = (x) => (sinCaja ? x.toLowerCase() : x);
  const rel = path.relative(caja(carpeta), caja(real(abs)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !LIBRES.includes(rel.split(path.sep)[0]);
}

/** El texto del freno. */
function textoDelFreno(marca, archivo) {
  const hora = marca && typeof marca.setAt === 'string' ? `${marca.setAt.slice(11, 16)} UTC` : 'hace un rato';
  return [
    `⛔ El dueño está ausente (la marca se puso a las ${hora}) y ${archivo} está dentro de la carpeta de Claude Code:`,
    'Claude Code pide confirmación para escribir ahí, y nadie la va a dar. Usá el guion del arnés que lo escribe, o dejalo',
    'anotado para cuando vuelva y seguí con lo demás.',
  ].join(' ');
}

/** Para el despachador: `{ block }` si con el dueño ausente se edita la carpeta de Claude Code; null si no. */
function handle(event, opts = {}) {
  if (process.env.TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD === '0') return null;
  const file = event && event.tool_input && (event.tool_input.file_path || event.tool_input.notebook_path);
  if (!file) return null;
  const home = opts.home || os.homedir();
  const abs = path.isAbsolute(String(file)) ? String(file) : path.resolve(String(event.cwd || process.cwd()), String(file));
  if (!enLaCarpetaDeClaude(abs, home)) return null;
  let marca = null;
  try {
    const g = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js')).get({ home, estado: opts.stateDir });
    if (g.problem) process.stderr.write(`on-owner-away-claude-dir: la marca de ausente (${g.problem}): el dueño cuenta como presente\n`);
    marca = g.mark || null;
  } catch (e) {
    process.stderr.write(`on-owner-away-claude-dir: la marca de ausente (${(e && e.message) || e}): el dueño cuenta como presente\n`);
    return null;
  }
  return marca ? { block: textoDelFreno(marca, path.basename(abs)) } : null;
}

module.exports = { handle, enLaCarpetaDeClaude, textoDelFreno };
