#!/usr/bin/env node
'use strict';
/**
 * discard-check.js — ¿este comando borra o esconde trabajo sin commitear? Lo pregunta el freno de mano
 * (scripts/hooks/safety-guard-pre.sh, regla GIT-C6) antes de cada comando que nombra git.
 *
 * POR QUÉ: en una copia que comparten varias sesiones (o la de la persona), los cambios sin commitear pueden ser de
 * otro. `git reset --hard` los borra sin vuelta atrás; `git stash` los esconde en una pila que comparten todas las
 * copias del repo, donde otra sesión los puede sacar o tirar; `git stash clear` y `git stash drop` sin decir cuál
 * tiran lo escondido. Quién escribió cada cambio no se sabe desde acá (no hay registro por sesión), así que se frena
 * cuando hay algo que perder, y se deja pasar cuando no hay nada: la copia limpia, la pila vacía.
 *
 * Qué mira, por cada `git` del comando, en la carpeta donde corre (la lee el lector del freno de guardar, con sus
 * `cd`, `-C` y subshells), con los alias resueltos (los de `-c alias.x=…` y los de la configuración del repo):
 *   · `reset` con `--hard` (también abreviado, `--ha`, como lo acepta git) o con una palabra que no se lee (`$X`):
 *     cambios con seguimiento sin commitear;
 *   · `stash`, `stash push`, `stash save`: lo mismo, más lo nuevo sin agregar si lleva `-u`/`--include-untracked`/
 *     `-a`/`--all`. Pasa sólo si nombra sus archivos uno por uno (`-- a.js b.js`, archivos que existen): una carpeta,
 *     `.` o un comodín esconden de más;
 *   · `stash clear`, y `stash drop` sin decir cuál (`-q` no dice cuál): la pila no vacía;
 *   · `submodule foreach …` que nombra `reset` o `stash`: los cambios del repo y de sus submódulos.
 * Y si el comando nombra `reset` o `stash` pero no se deja leer (el programa en una variable, `eval`, `cmd /c`, un
 * alias que corre otra cosa), frena si la carpeta donde corre tiene cambios: lo que no se pudo leer no pasa callado.
 * Una carpeta que no existe o no es un repo pasa (el comando falla solo). Si git no contesta, frena.
 *
 * Uso: `node discard-check.js --command-stdin --cwd <dir>` imprime un renglón `frena=<motivo>` por cada `git` que
 * frena, y nada si pasa. Sale 0; con un error propio, distinto de 0 (el freno lo cuenta como «no pude mirar»).
 *
 * Red: los casos `git-c6-*` del banco (scripts/controls-bench/cases/hooks/01-frenos-duros.json).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const UNTRACKED_FLAGS = new Set(['-u', '--include-untracked', '-a', '--all']);
const HARD = /^--ha(r(d)?)?$/;
const NAMES_DISCARD = /(^|[^\w-])(reset|stash)([^\w-]|$)/;
// programas que corren otro texto sin que el lector lo vea entero
const OPAQUE_PROGRAMS = new Set(['eval', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'xargs', 'sudo', 'exec', 'nohup', 'time', 'watch', 'parallel', 'find']);
const unreadable = (w) => /[$`]/.test(String(w));

function git(dir, args) {
  // con el idioma fijo: `notARepo` lee la frase de git, que en otro idioma cambia
  const env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo();
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, env });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const notARepo = (r) => r.status === 128 && /not a git repository/i.test(r.err);

// `null` si la carpeta no existe o no es un repo; si no, las líneas de `status --porcelain`.
function pending(dir, withUntracked) {
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['status', '--porcelain', `--untracked-files=${withUntracked ? 'all' : 'no'}`]);
  if (notARepo(r)) return null;
  if (r.status !== 0) throw new Error(`git status no contestó en ${dir} (${r.err.trim().split('\n')[0] || `salida ${r.status}`})`);
  return r.out.split('\n').filter(Boolean);
}

function stashCount(dir) {
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['stash', 'list']);
  if (notARepo(r)) return null;
  if (r.status !== 0) throw new Error(`git stash list no contestó en ${dir} (${r.err.trim().split('\n')[0] || `salida ${r.status}`})`);
  return r.out.split('\n').filter(Boolean).length;
}

// El alias `sub` (del comando con `-c alias.<sub>=…`, o de la configuración del repo): sus palabras, `{ shell: true }`
// si corre otro programa (`!…`), o null si no es un alias.
function aliasOf(ps, sub, dir) {
  let value = null;
  for (let i = 1; i < ps.length; i++) {
    if (ps[i] === '-c' && typeof ps[i + 1] === 'string') {
      const m = /^alias\.([^=]+)=(.*)$/i.exec(ps[i + 1]);
      if (m && m[1].toLowerCase() === String(sub).toLowerCase()) value = m[2];
    }
  }
  if (value === null && fs.existsSync(dir)) {
    const r = git(dir, ['config', '--get', `alias.${sub}`]);
    if (r.status === 0) value = r.out.trim();
  }
  if (value === null) return null;
  if (value.startsWith('!')) return { shell: true, text: value };
  return { words: value.split(/\s+/).filter(Boolean) };
}

const lost = (lines) => `${lines.length} cambio(s) sin commitear (${lines.slice(0, 3).map((l) => l.slice(3)).join(', ')}${lines.length > 3 ? ', …' : ''})`;

// ¿El `git stash push -- <rutas>` nombra sólo archivos, uno por uno? Una carpeta, `.`, un comodín o una ruta que no
// existe como archivo esconden de más (o no se sabe qué).
function onlyFiles(dir, paths) {
  return paths.length > 0 && paths.every((p) => !/[*?[\]:]/.test(p) && p !== '.' && (() => {
    try { return fs.statSync(path.resolve(dir, p)).isFile(); } catch (_) { return false; }
  })());
}

/** Los motivos para frenar, uno por cada `git` que borra o esconde algo. */
function check(command, cwd, home) {
  const { gitsDelShell } = require('./save-brake.js');
  const base = cwd || process.cwd();
  const reasons = [];
  let handled = false;
  let opaque = false;
  const unreadableCommand = (dir, why) => {
    const p = pending(dir, false);
    if (p && p.length) reasons.push(`${why}, y ${dir} tiene ${lost(p)}: lo que no se pudo leer no pasa`);
  };
  for (const g of gitsDelShell(command, cwd, home)) {
    if (!g.sub) {
      const prog = path.basename(String(g.otro || '')).toLowerCase();
      if (unreadable(g.otro) || OPAQUE_PROGRAMS.has(prog)) opaque = true;
      continue;
    }
    if (!Array.isArray(g.dirs) || !g.dirs.length) { opaque = true; continue; }
    // la última carpeta posible: la del último `cd`/`-C` (si no existe, el git no corre ahí o corre en algo recién creado)
    const dir = path.resolve(base, g.dirs[g.dirs.length - 1]);
    let sub = g.sub;
    let rest = g.resto || [];
    if (unreadable(sub)) { opaque = true; continue; }
    if (!['reset', 'stash', 'submodule'].includes(sub)) {
      const a = aliasOf(g.ps || [], sub, dir);
      if (a && a.shell) {
        if (NAMES_DISCARD.test(a.text)) { handled = true; unreadableCommand(dir, `el alias «${sub}» corre otro programa que nombra reset o stash`); }
        continue;
      }
      if (a && a.words.length) { sub = a.words[0]; rest = [...a.words.slice(1), ...rest]; }
    }
    if (sub === 'submodule' && rest.includes('foreach')) {
      const inner = rest.slice(rest.indexOf('foreach') + 1).join(' ');
      if (NAMES_DISCARD.test(inner)) {
        handled = true;
        const p = pending(dir, false);
        if (p && p.length) reasons.push(`git submodule foreach con reset o stash borraría o escondería trabajo: ${dir} tiene ${lost(p)} (con sus submódulos)`);
      }
      continue;
    }
    if (sub === 'reset') {
      handled = true;
      const hard = rest.some((w) => HARD.test(w));
      if (!hard && !rest.some(unreadable)) continue;
      const p = pending(dir, false);
      if (p && p.length) reasons.push(`git reset ${hard ? '--hard' : 'con una opción que no se lee'} borraría ${lost(p)} en ${dir}, sin vuelta atrás`);
      continue;
    }
    if (sub !== 'stash') continue;
    handled = true;
    const action = rest[0] && !rest[0].startsWith('-') ? rest[0] : 'push';
    const args = rest[0] === action ? rest.slice(1) : rest;
    if (action === 'push' || action === 'save') {
      const at = args.indexOf('--');
      if (at >= 0 && onlyFiles(dir, args.slice(at + 1))) continue;   // nombra sus archivos uno por uno
      const p = pending(dir, args.some((w) => UNTRACKED_FLAGS.has(w)));
      if (p && p.length) reasons.push(`git stash escondería ${lost(p)} de ${dir} en la pila que comparten todas las copias del repo, donde otra sesión los puede sacar o tirar`);
    } else if (action === 'clear' || (action === 'drop' && !args.some((w) => !w.startsWith('-')))) {
      const n = stashCount(dir);
      if (n) reasons.push(`git stash ${action} tiraría ${action === 'clear' ? `las ${n} entradas` : 'la última entrada'} de la pila de ${dir}, que puede ser trabajo de otra sesión`);
    }
  }
  // nombra reset o stash, pero algo del comando no se deja leer: frena si hay algo que perder donde corre
  if (!handled && opaque && NAMES_DISCARD.test(String(command))) unreadableCommand(path.resolve(base), 'el comando nombra reset o stash y no se deja leer entero');
  return reasons;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--cwd');
  const cwd = at >= 0 ? argv[at + 1] : process.cwd();
  let text = '';
  process.stdin.on('data', (d) => { text += d; }).on('end', () => {
    try {
      for (const r of check(text, cwd)) process.stdout.write(`frena=${r.replace(/\n/g, ' ')}\n`);
    } catch (e) {
      process.stderr.write(`discard-check: ${e.message}\n`);
      process.exitCode = 2;
    }
  });
}

module.exports = { check };
