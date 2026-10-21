'use strict';
/**
 * git-hooks-path.js — la carpeta GLOBAL de hooks de git (`core.hooksPath`) que hace correr los hooks del arnés.
 *
 * El caso que cubre: una máquina instalada desde la versión bajada, o mudada desde un clon, queda con los hooks de
 * git en `~/.git-hooks/` —entre ellos el pre-push, el freno antes de publicar— y git sin carpeta global de hooks: ningún
 * hook corre. `doctor` lo dice y manda a `harness.js apply`, pero el aplicador sólo AVISA (nunca toca esa clave), así
 * que el aviso seguiría igual después de correrlo.
 *
 * Lo que hace en `install`, `apply` y la mudanza, y de forma transparente también en el
 * arranque y en `update` de una máquina ya instalada: con la política de aplicación `auto` (la del perfil del equipo: el
 * equipo decidió que el arnés cambie cosas solo) la pone el arranque y lo dice una vez en el aviso; con `ask`, el aviso
 * lo pide y la pone `update --yes`. Si la puso el arnés y la persona la sacó, ni el arranque ni `update` la vuelven a
 * poner (`apply` sí: lo pide una persona). En cualquiera de esos caminos:
 *   · git no tiene ninguna  → la pone apuntando a la carpeta que llena el aplicador, si ahí quedó el pre-push del arnés,
 *                             en el perfil `full` y sin `TYCON_NO_GIT_HOOKS=1`. Lo anota en el estado: `uninstall` y el
 *                             paso al perfil mínimo la sacan, sólo si sigue siendo la que puso el arnés;
 *   · git tiene otra        → no la toca (puede ser de otra herramienta): el aviso del aplicador, con las dos rutas y el
 *                             comando, queda como está;
 *   · git no contesta       → no la toca: «no pude leer» no es «no tiene».
 *
 * Funciona igual en Mac, Linux y Windows: es Node y `git config`, no el aplicador de cada sistema. Nunca tira.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY = 'core.hooksPath';
/** La marca del pre-push del arnés (la misma que busca el freno: public-push-guard.js, HOOK_MARK). */
const PUSH_MARK = 'git-pre-push-global.sh';
/** El aviso del aplicador cuando git no tiene ninguna (los dos guiones dicen lo mismo): el renglón y su comando. */
const UNSET_WARNING = /^⚠ git no tiene core\.hooksPath global/;

// Los avisos de arranque (una línea llana cada uno, sin « · », que es lo que separa un aviso de otro): con qué empiezan
const NOTICE_SET = 'el arnés puso la carpeta global de hooks de git';
const NOTICE_FAILED = 'no pude poner la carpeta global de hooks de git';
const NOTICE_ASK = 'falta la carpeta global de hooks de git y sin ella no corre el freno antes de publicar: harness.js update --yes la pone';

/** La carpeta que llena el aplicador: `TYCON_GIT_HOOKS_DIR`, o `~/.git-hooks` (como install-tycon-hooks.sh y .ps1). */
function hooksDir({ home, env = process.env }) {
  return (typeof env.TYCON_GIT_HOOKS_DIR === 'string' && env.TYCON_GIT_HOOKS_DIR) || path.join(home, '.git-hooks');
}

/** Cómo se escribe en la configuración: en Windows con `/` (como el aviso del .ps1, y así git y Git Bash la leen igual). */
function valueFor(dir, platform) {
  return platform === 'win32' ? dir.replace(/\\/g, '/') : dir;
}

function git(args, env) {
  return spawnSync('git', args, { windowsHide: true, encoding: 'utf8', timeout: 10000, env: Object.assign({}, env, { GIT_TERMINAL_PROMPT: '0' }) });
}
const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0];

/**
 * La clave global, como la lee git al correr un hook (`--includes`: también desde un archivo incluido).
 * `{ status: 'unset' }` · `{ status: 'set', value }` · `{ status: 'unreadable', why }` (git falló o no está).
 */
function read({ env = process.env } = {}) {
  const r = git(['config', '--global', '--includes', KEY], env);
  if (r.error) return { status: 'unreadable', why: r.error.code === 'ENOENT' ? 'git no está en esta máquina' : `git no contestó (${r.error.code || r.error.message})` };
  if (r.status === 1) return { status: 'unset' };
  if (r.status !== 0) return { status: 'unreadable', why: `git config salió ${r.status}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ''}` };
  const value = String(r.stdout || '').trim();
  return value ? { status: 'set', value } : { status: 'unset' };
}

/** ¿Está el pre-push del arnés en esa carpeta? (sin él no se prende nada: el aplicador ya dijo por qué no quedó) */
function pushHookPlaced(dir) {
  try { return fs.readFileSync(path.join(dir, 'pre-push'), 'utf8').includes(PUSH_MARK); } catch (_) { return false; }
}

/**
 * La pone si git no tiene ninguna. `profile`: el perfil vigente (`full` o `minimal`; null si no se pudo leer).
 * Devuelve `{ status, line, value }`:
 *   · 'set'      → la puso (y la volvió a leer); `line` lo dice y cómo volver atrás;
 *   · 'failed'   → git no la dejó escribir; `line` es el aviso con el comando a mano;
 *   · 'skipped'  → no corresponde (apagado, otro perfil, sin el pre-push) o git ya tiene una: `line` null (lo que haya
 *                  que decir lo dice el aplicador).
 */
function ensure({ home, env = process.env, platform = process.platform, profile = null, log = null }) {
  const skip = (why) => { if (log) log(`carpeta global de hooks de git: no la toco (${why})`); return { status: 'skipped', line: null, value: null }; };
  try {
    if (env.TYCON_NO_GIT_HOOKS === '1') return skip('TYCON_NO_GIT_HOOKS=1');
    if (profile !== 'full') return skip(profile ? `el perfil es ${profile}` : 'no se pudo leer el perfil');
    const dir = hooksDir({ home, env });
    if (!pushHookPlaced(dir)) return skip(`el pre-push del arnés no está en ${dir}`);
    const now = read({ env });
    if (now.status === 'set') return skip(`git ya tiene una: ${now.value}`);
    if (now.status === 'unreadable') return skip(`no pude leerla: ${now.why}`);
    const value = valueFor(dir, platform);
    const w = git(['config', '--global', KEY, value], env);
    const after = read({ env });
    if (w.error || w.status !== 0 || after.status !== 'set' || after.value !== value) {
      const why = w.error ? (w.error.code || w.error.message) : (w.status !== 0 ? `git config salió ${w.status}${firstLine(w.stderr) ? `: ${firstLine(w.stderr)}` : ''}` : 'la escribí y git no la devuelve igual');
      if (log) log(`carpeta global de hooks de git: no pude ponerla (${why})`);
      return { status: 'failed', value, line: `⚠ git no tiene carpeta global de hooks y no pude ponerla (${why}): los hooks del arnés, incluido el freno antes de publicar, NO corren. A mano:\n    git config --global ${KEY} "${value}"`,
        notice: `${NOTICE_FAILED} (${why}): el freno antes de publicar no corre; a mano: git config --global ${KEY} "${value}"` };
    }
    if (log) log(`carpeta global de hooks de git: puesta en ${value} (git no tenía ninguna)`);
    return { status: 'set', value, line: `✓ git usa ahora la carpeta global de hooks del arnés (${KEY} = ${value}): sus hooks, incluido el freno antes de publicar, corren en todos tus repos, en lugar del .git/hooks/ de cada uno. Para volver atrás: git config --global --unset ${KEY}`,
      notice: `${NOTICE_SET} (${KEY} = ${value}): sus controles, incluido el freno antes de publicar, ya corren en todos tus repos; para volver atrás, git config --global --unset ${KEY}` };
  } catch (e) {
    return skip(`falló la mirada: ${(e && e.message) || e}`);
  }
}

/** ¿La pondría `ensure` ahora? Las mismas condiciones, sin escribir nada (para el aviso con la política `ask`). */
function wouldSet({ home, env = process.env, profile = null }) {
  try {
    if (env.TYCON_NO_GIT_HOOKS === '1' || profile !== 'full') return false;
    if (!pushHookPlaced(hooksDir({ home, env }))) return false;
    return read({ env }).status === 'unset';
  } catch (_) { return false; }
}

/** Un aviso de arranque sin los de este módulo (cada arranque los vuelve a decidir: no se arrastran del anterior). */
function stripNotices(text) {
  if (!text) return text || null;
  const kept = String(text).split(' · ').filter((x) => ![NOTICE_SET, NOTICE_FAILED, NOTICE_ASK].some((n) => x.startsWith(n)));
  return kept.length ? kept.join(' · ') : null;
}

/** Los avisos del aplicador sin el de «git no tiene» (y su comando): con la clave ya puesta, ese aviso es falso. */
function withoutUnsetWarning(lines) {
  const out = [];
  let inside = false;
  for (const l of lines || []) {
    if (UNSET_WARNING.test(l)) { inside = true; continue; }
    if (inside && /^\s+\S/.test(l)) continue;
    inside = false;
    out.push(l);
  }
  return out;
}

/**
 * La saca si la puso el arnés (`recorded`: lo anotado en el estado) y sigue siendo ésa. Si la persona la cambió, no se
 * toca. `{ status: 'removed'|'kept'|'none'|'unknown'|'failed', line }` — `unknown`: git no contestó (sigue anotada).
 */
function release({ env = process.env, recorded = null, log = null }) {
  if (!recorded || typeof recorded.value !== 'string' || !recorded.value) return { status: 'none', line: null };
  const now = read({ env });
  if (now.status !== 'set' || now.value !== recorded.value) {
    const line = now.status === 'set' ? `queda la carpeta global de hooks de git (${KEY} = ${now.value}): ya no es la que puso el arnés, no la toco`
      : (now.status === 'unset' ? null : `no pude mirar la carpeta global de hooks de git (${now.why}): si sigue en ${recorded.value}, sacala con git config --global --unset ${KEY}`);
    if (log) log(`carpeta global de hooks de git: no la saco (${now.status === 'set' ? `es ${now.value}` : now.status})`);
    return { status: now.status === 'unset' ? 'none' : (now.status === 'set' ? 'kept' : 'unknown'), line };
  }
  const r = git(['config', '--global', '--unset', KEY], env);
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message) : `git config salió ${r.status}`;
    return { status: 'failed', line: `no pude sacar la carpeta global de hooks de git que puso el arnés (${why}): git config --global --unset ${KEY}` };
  }
  if (log) log(`carpeta global de hooks de git: sacada (${recorded.value})`);
  return { status: 'removed', line: `quitado: la carpeta global de hooks de git que puso el arnés (${KEY} = ${recorded.value}); git vuelve a correr el .git/hooks/ de cada repo` };
}

module.exports = { KEY, PUSH_MARK, NOTICE_SET, NOTICE_FAILED, NOTICE_ASK, hooksDir, valueFor, read, pushHookPlaced, wouldSet, ensure, stripNotices, withoutUnsetWarning, release };
