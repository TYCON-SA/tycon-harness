#!/usr/bin/env node
// clocki/scripts/touch-activity.js
//
// Invocado por el hook PostToolUse (async=true). Actualiza lastActivity del timer
// activo de ESTA sesión en el cwd actual. Si no hay timer activo, no hace nada.
//
// 🔴 Multi-sesión sin race: cada sesión tiene su propio archivo
// `~/.claude/clocki/active/<sessionId>.json`. touch-activity escribe SOLO ese
// archivo — nunca un archivo compartido — así dos sesiones concurrentes no se
// pisan el write (el read-modify-write del modelo single-file no ocurre).
//
// Diseñado para ser MUY rápido (<10ms) — solo file I/O.
// Cross-platform. Exit 0 siempre.

const os = require('os');
const path = require('path');
const {
  readActive,
  readSessionActive,
  writeSessionActive,
  normalizeCwd,
  nowIso,
  parseHookInput,
  findActiveEntryForCwd,
  touchHeartbeat,
  migrateLegacyEntry,
} = require('./lib');

// Las carpetas absolutas que nombra la tool: el archivo que edita o lee, la carpeta de
// trabajo del shell de Codex, y lo que sigue a `cd` o a `git -C` en un comando.
function toolDirs(input, cwd) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  for (const k of ['file_path', 'notebook_path', 'path', 'workdir', 'cwd']) {
    if (typeof input[k] === 'string') out.push(input[k]);
  }
  const command = Array.isArray(input.command) ? input.command.join(' ') : input.command;
  if (typeof command === 'string') {
    const re = /(?:^|[\s;&|(])(?:cd|-C)\s+(?:"([^"]+)"|'([^']+)'|([^"'\s;&|)]+))/g;
    let m;
    while ((m = re.exec(command)) !== null) out.push(m[1] || m[2] || m[3]);
  }
  return out
    .map((d) => d.replace(/^~(?=\/|$)/, os.homedir()))
    .filter((d) => path.isAbsolute(d))
    .map((d) => normalizeCwd(d))
    .filter((d) => d && d !== cwd);
}

function main() {
  const hookInput = parseHookInput();
  const cwd = normalizeCwd(hookInput.cwd || process.cwd());
  const sessionId = hookInput.session_id || '_nosession';

  // 🔴 Heartbeat: marca esta sesión como VIVA ahora. Señal de liveness
  // independiente del timer — el sweep la usa para no cerrar timers de sesiones
  // que están trabajando aunque su lastActivity luzca stale.
  // Se escribe SIEMPRE, haya timer o no.
  touchHeartbeat(sessionId);

  let active;
  try {
    active = readActive();
  } catch (_err) {
    process.exit(0);
  }

  // Walk-up parent dirs: si el usuario abrió timer en un root pero está editando
  // un subdir, igual encontramos el entry. Scopeado a ESTA sesión. Si la carpeta de
  // la sesión no tiene timer, se busca por las carpetas que tocó la tool: una sesión
  // que trabaja en un worktree sigue con el cwd del repo, y el timer está abierto
  // con la ruta del worktree.
  let found = findActiveEntryForCwd(active, cwd, sessionId);
  for (const dir of toolDirs(hookInput.tool_input, cwd)) {
    if (found) break;
    found = findActiveEntryForCwd(active, dir, sessionId);
  }
  if (!found) {
    process.exit(0);
  }

  try {
    const sessionObj = readSessionActive(sessionId);
    const entry = sessionObj[found.matchedKey];
    if (entry && entry.entryId) {
      // Entry ya en el archivo per-session — update normal de lastActivity.
      entry.lastActivity = nowIso();
      writeSessionActive(sessionId, sessionObj);
    } else if (found.entry && found.entry.entryId) {
      // 🔴 Entry encontrada pero NO en el archivo per-session → vive en el
      // `active.json` LEGACY. Migrarla al per-session (con lastActivity fresco)
      // así de acá en más se actualiza normal.
      //
      // Ignorarla ("transición esperada: la entry legacy se cerrará por idle-sweep") sería falso: una
      // sesión VIVA puede tener su timer en el legacy (lo abrió con el clocki viejo). Su lastActivity
      // quedaría congelado → el sweep la cerraría como idle estando la sesión viva y trabajando.
      // La migración cierra ese gap.
      migrateLegacyEntry(sessionId, found.matchedKey, found.entry);
    }
  } catch (_err) {
    // Si falla el write (race condition, disk full), exit 0 — no romper el hook.
  }

  process.exit(0);
}

try {
  main();
} catch (_err) {
  process.exit(0);
}
