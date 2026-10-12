#!/usr/bin/env node
// clocki/scripts/clocki-enforce.js
//
// Invocado por hook PostToolUse (matcher Edit|Write). Verifica que haya un timer
// clocki activo para el cwd actual cuando Claude realiza un Edit/Write. Si no
// hay timer activo → emite system-reminder forzando al modelo a abrir uno.
//
// Diferencia con on-prompt.js (UserPromptSubmit):
//   - on-prompt.js detecta intent EN EL PROMPT del user (intentKeywords). Si el
//     user dice "segui" o "qué seguridad", on-prompt.js NO matchea y no emite.
//   - clocki-enforce.js detecta la EVIDENCIA de trabajo (Edit/Write tool calls).
//     Si Claude está editando archivos, debe haber un timer activo. Punto.
//
// Rate-limit: a lo sumo 1 reminder cada 10min por cwd para evitar spam en bursts
// de edits consecutivos (típico cuando se escribe un archivo grande).
//
// Anti-patrón histórico que motivó este hook (Story 2.3, 2026-05-12):
//   El modelo cerró el timer al final del Step 8 del tycon-pipeline "por
//   prolijidad". Luego el usuario pidió 27min adicionales de trabajo (smoke
//   check, commits, push, integration tests) — sin tracking. El usuario tuvo
//   que flagear "para, no estás registrando tiempo en clocki!" y se hizo
//   recuperación retroactiva. Este hook impide que vuelva a pasar.
//
// H10 2026-05-21: refactor a `handle(event)` exportable para que el dispatcher
// lo corra in-process. El shim CLI del fondo preserva el comportamiento standalone.
//
// Cross-platform (Mac/Linux/Windows). Exit 0 siempre (los errores no rompen el hook).

const fs = require('fs');
const path = require('path');
const os = require('os');

const lib = require('./lib');

const ENFORCE_STATE_PATH = path.join(os.homedir(), '.claude', 'clocki', 'enforce-state.json');
const RATE_LIMIT_MINUTES = 10;

function readEnforceState() {
  try {
    if (!fs.existsSync(ENFORCE_STATE_PATH)) return {};
    const raw = fs.readFileSync(ENFORCE_STATE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function writeEnforceState(state) {
  try {
    const tmp = `${ENFORCE_STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, ENFORCE_STATE_PATH);
  } catch (_err) { /* no-op */ }
}

/**
 * Handler dispatchable. Recibe el evento RAW (ya parseado) y devuelve:
 *   null               → nada (exit 0)
 *   { reminder: text } → advisory (el caller envuelve en <system-reminder>)
 * Side-effects: touchHeartbeat + persiste rate-limit state (intencional).
 */
function handle(hookInput) {
  hookInput = hookInput || {};
  const cwd = lib.normalizeCwd(hookInput.cwd || process.cwd());
  const sessionId = hookInput.session_id || null;
  const sessionKey = sessionId || '_nosession';

  // 🔴 Heartbeat: un Edit/Write es evidencia directa de que la sesión está VIVA
  // y trabajando. Marcala — el sweep usa el heartbeat para no cerrar timers de
  // sesiones activas (fix 2026-05-17).
  lib.touchHeartbeat(sessionKey);

  // No cwd = hook context broken, no podemos verificar nada.
  if (!cwd) return null;

  // 1. ¿Hay timer activo de ESTA sesión para este cwd (o cualquier parent)?
  let active;
  try {
    active = lib.readActive();
  } catch (_err) {
    return null;
  }

  // Walk-up: si el usuario abrió timer en monorepo root y está editando subproject,
  // el lookup directo `active[cwd]` falla. findActiveEntryForCwd sube por parents.
  // El match está scopeado a ESTA sesión: si otra sesión tiene timer activo en el
  // mismo cwd pero esta sesión no, igual emitimos el reminder — el trabajo de esta
  // sesión necesita su propio timer (multi-sesión, 2026-05-17).
  const found = lib.findActiveEntryForCwd(active, cwd, sessionId);
  if (found) {
    // Timer activo de esta sesión (en este cwd o algún parent), todo OK. Exit silent.
    return null;
  }

  // 2. No hay timer para esta sesión. Rate-limit por cwd + sessionId
  //    (así dos sesiones en el mismo cwd no se comen el reminder mutuamente).
  const enforceState = readEnforceState();
  const lastReminder = enforceState[cwd]?.[sessionKey]?.lastReminderAt;
  if (lastReminder) {
    const minutesAgo = lib.minutesBetween(lastReminder, lib.nowIso());
    if (minutesAgo < RATE_LIMIT_MINUTES) {
      // Ya emití un reminder recientemente, no spamear.
      return null;
    }
  }

  // 3. Emit reminder + persist timestamp.
  enforceState[cwd] = enforceState[cwd] || {};
  enforceState[cwd][sessionKey] = { lastReminderAt: lib.nowIso() };
  writeEnforceState(enforceState);

  const toolName = hookInput.tool_name || 'tool';
  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || '';
  const fileBasename = filePath ? path.basename(filePath) : '';

  return {
    reminder:
`clocki-enforce: detecté un ${toolName}${fileBasename ? ` sobre ${fileBasename}` : ''} en \`${cwd}\` SIN timer Clockify activo para esta sesión.

session_id de esta sesión: "${sessionKey}". El timer de esta sesión vive en su
archivo propio ~/.claude/clocki/active/${sessionKey}.json (forma { "<cwd>": <entry> })
— independiente de cualquier otra sesión que esté trackeando el mismo proyecto.

Si efectivamente estás haciendo trabajo trackeable (edits a código/specs/tests, NO solo exploración Read-only):
- Abrí un timer ANTES de la próxima Edit/Write: invocá la skill clocki con \`start "descripción corta del trabajo"\`.
- Si la tarea pertenece a una story TYCON, el clocki:start del tycon-pipeline ya debería haber abierto el timer. Si no está activo, el pipeline lo cerró antes de tiempo (anti-patrón documentado en step-08-commit-prep.md). Reabrir manualmente con la descripción real del trabajo en curso.

Si es exploración casual (Read sin modificar, debugging que no genera commits) → ignorar este reminder; rate-limit de 10min impide spam.

Próximos pasos sugeridos al user:
1. Confirmar descripción del trabajo en curso.
2. Abrir timer (skill clocki start).
3. Continuar con la siguiente acción.`,
  };
}

module.exports = { handle };

// ── CLI shim (standalone) — usa lib.emitReminder para output byte-idéntico ──
if (require.main === module) {
  try {
    const r = handle(lib.parseHookInput());
    if (r && r.reminder) lib.emitReminder(r.reminder);
  } catch (_err) { /* fail-open */ }
  process.exit(0);
}
