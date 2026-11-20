#!/usr/bin/env node
'use strict';
/**
 * discard-check.js — ¿este comando borra o esconde trabajo sin commitear? Lo pregunta el freno de mano
 * (scripts/hooks/safety-guard-pre.sh, regla GIT-C6) antes de un `git reset --hard` o un `git stash`.
 *
 * POR QUÉ: en una copia que comparten varias sesiones (o la de la persona), los cambios sin commitear pueden ser de
 * otro. `git reset --hard` los borra sin vuelta atrás; `git stash` los esconde en una pila que comparten todas las
 * copias del repo, donde otra sesión los puede sacar o tirar; `git stash clear` y `git stash drop` sin decir cuál
 * tiran lo escondido. Quién escribió cada cambio no se sabe desde acá (no hay registro por sesión), así que se frena
 * cuando hay algo que perder, y se deja pasar cuando no hay nada: la copia limpia, la pila vacía.
 *
 * Qué mira, por cada `git` del comando, en la carpeta donde corre (la lee el lector del freno de guardar, con sus
 * `cd`, `-C` y subshells):
 *   · `reset --hard` (también `--hard` pegado en cualquier lugar): cambios con seguimiento sin commitear;
 *   · `stash`, `stash push`, `stash save`: lo mismo, más lo nuevo sin agregar si lleva `-u`/`--include-untracked`/
 *     `-a`/`--all`. Pasa si nombra sus archivos (`-- <rutas>`): esconde sólo lo que nombra;
 *   · `stash clear`, y `stash drop` sin decir cuál: la pila no vacía.
 * Una carpeta que no es un repo pasa (el comando falla solo). Si git no contesta, frena: no pude mirar no es limpio.
 *
 * Uso: `node discard-check.js --command-stdin --cwd <dir>` imprime un renglón `frena=<motivo>` por cada `git` que
 * frena, y nada si pasa. Sale 0; con un error propio, distinto de 0 (el freno lo cuenta como «no pude mirar»).
 *
 * Red: los casos `git-c6-*` del banco (scripts/controls-bench/cases/hooks/01-frenos-duros.json).
 */
const path = require('path');
const { spawnSync } = require('child_process');

const UNTRACKED_FLAGS = new Set(['-u', '--include-untracked', '-a', '--all']);

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// `null` si la carpeta no es un repo; si no, las líneas de `status --porcelain` (con o sin lo nuevo sin agregar).
function pending(dir, withUntracked) {
  const r = git(dir, ['status', '--porcelain', `--untracked-files=${withUntracked ? 'all' : 'no'}`]);
  if (r.status === 128 && /not a git repository/i.test(r.err)) return null;
  if (r.status !== 0) throw new Error(`git status no contestó en ${dir} (${r.err.trim().split('\n')[0] || `salida ${r.status}`})`);
  return r.out.split('\n').filter(Boolean);
}

function stashCount(dir) {
  const r = git(dir, ['stash', 'list']);
  if (r.status === 128 && /not a git repository/i.test(r.err)) return null;
  if (r.status !== 0) throw new Error(`git stash list no contestó en ${dir} (${r.err.trim().split('\n')[0] || `salida ${r.status}`})`);
  return r.out.split('\n').filter(Boolean).length;
}

const lost = (lines) => `${lines.length} cambio(s) sin commitear (${lines.slice(0, 3).map((l) => l.slice(3)).join(', ')}${lines.length > 3 ? ', …' : ''})`;

/** Los motivos para frenar, uno por cada `git` que borra o esconde algo. */
function check(command, cwd, home) {
  const { gitsDelShell } = require('./save-brake.js');
  const reasons = [];
  for (const g of gitsDelShell(command, cwd, home)) {
    if (!g.sub || !Array.isArray(g.dirs) || !g.dirs.length) continue;
    const dir = path.resolve(cwd || process.cwd(), g.dirs[0]);
    const rest = g.resto || [];
    if (g.sub === 'reset' && rest.includes('--hard')) {
      const p = pending(dir, false);
      if (p && p.length) reasons.push(`git reset --hard borraría ${lost(p)} en ${dir}, sin vuelta atrás`);
      continue;
    }
    if (g.sub !== 'stash') continue;
    const action = rest[0] && !rest[0].startsWith('-') ? rest[0] : 'push';
    if (action === 'push' || action === 'save') {
      if (rest.includes('--')) continue;   // nombra sus archivos: esconde sólo eso
      const p = pending(dir, rest.some((w) => UNTRACKED_FLAGS.has(w)));
      if (p && p.length) reasons.push(`git stash escondería ${lost(p)} de ${dir} en la pila que comparten todas las copias del repo, donde otra sesión los puede sacar o tirar`);
    } else if (action === 'clear' || (action === 'drop' && rest.length < 2)) {
      const n = stashCount(dir);
      if (n) reasons.push(`git stash ${action} tiraría ${action === 'clear' ? `las ${n} entradas` : 'la última entrada'} de la pila de ${dir}, que puede ser trabajo de otra sesión`);
    }
  }
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
