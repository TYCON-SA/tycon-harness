#!/usr/bin/env node
// clocki/scripts/touch-activity.js
//
// Invocado por el hook PostToolUse (async=true). Actualiza lastActivity del timer
// activo de ESTA sesión en el cwd actual. Si no hay timer activo, no hace nada.
//
// 🔴 Multi-sesión sin race (2026-05-17): cada sesión tiene su propio archivo
// `~/.claude/clocki/active/<sessionId>.json`. touch-activity escribe SOLO ese
// archivo — nunca un archivo compartido — así dos sesiones concurrentes no se
// pisan el write (el bug read-modify-write del modelo single-file quedó cerrado).
//
// Diseñado para ser MUY rápido (<10ms) — solo file I/O.
// Cross-platform. Exit 0 siempre.

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

function main() {
  const hookInput = parseHookInput();
  const cwd = normalizeCwd(hookInput.cwd || process.cwd());
  const sessionId = hookInput.session_id || '_nosession';

  // 🔴 Heartbeat: marca esta sesión como VIVA ahora. Señal de liveness
  // independiente del timer — el sweep la usa para no cerrar timers de sesiones
  // que están trabajando aunque su lastActivity luzca stale (fix 2026-05-17).
  // Se escribe SIEMPRE, haya timer o no.
  touchHeartbeat(sessionId);

  let active;
  try {
    active = readActive();
  } catch (_err) {
    process.exit(0);
  }

  // Walk-up parent dirs: si el usuario abrió timer en un root pero está editando
  // un subdir, igual encontramos el entry. Scopeado a ESTA sesión.
  const found = findActiveEntryForCwd(active, cwd, sessionId);
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
      // ANTES esto se ignoraba ("transición esperada: la entry legacy se cerrará
      // por idle-sweep") — falso: una sesión VIVA puede tener su timer en el
      // legacy (lo abrió con el clocki viejo). Su lastActivity quedaba congelado
      // → el sweep la cerraba como idle estando la sesión viva y trabajando.
      // Incidente 2026-05-17 (Story 3.3). La migración cierra ese gap.
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
