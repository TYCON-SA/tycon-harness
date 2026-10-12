#!/usr/bin/env node
// clocki/scripts/sweep.js
//
// Invocado por el hook SessionStart. Cierra (vía reminder a Claude) timers idle:
// el de ESTA sesión, y los HUÉRFANOS de sesiones demostrablemente MUERTAS.
//
// 🔴 POLÍTICA — evolución en dos pasos, leer completo antes de tocar:
//
// (2026-06-05, pedido del usuario) El sweep NUNCA debe tocar el timer de otra sesión
// VIVA. Disparador: cerró un timer `_legacy` de una sesión de otro producto que estaba
// trabajando en paralelo — guides/incident-log.md#case-sweep-closed-live-session-timer-2026-06-05. La regla que se escribió fue "nunca tocar otra sesión,
// aunque luzca muerta", y delegaba los zombies a que "ESA misma sesión resuma".
//
// (2026-07-25, auditoría con el dev — guides/incident-log.md#case-orphan-timers-never-closed-2026-07-25) Esa delegación no ocurre NUNCA: un sessionId no
// se reusa — cerrás la ventana y ese id no vuelve. O sea que un timer huérfano no lo
// cerraba nadie jamás. Encontrados 3 timers de julio en 0 segundos (~14h de trabajo
// real sin facturar) y 87 archivos de estado acumulados.
//
// Lo que faltaba ya estaba construido: el HEARTBEAT por sesión (lib.js) existe
// literalmente para esto — su comentario dice que distingue "timer idle de sesión
// muerta (cerrable)" de "timer idle de sesión viva trabajando (NO cerrable)". Estaba
// exportado y sin usar acá. Cuando se escribió la regla de 2026-06-05 no había forma
// de saber si la otra sesión seguía viva; ahora sí, así que la regla se ajusta a su
// intención original en vez de quedar más amplia de lo necesario:
//
//   - Timer de ESTA sesión, idle >idleTimeout           → cerrable (trim a lastActivity).
//   - Timer de OTRA sesión SIN heartbeat reciente
//     (>deadSessionMinutes, default 2h)                 → cerrable (trim a lastActivity).
//   - Timer de OTRA sesión CON heartbeat reciente       → 🔴 INTOCABLE. Sigue vigente
//     la regla vieja: es una sesión trabajando en paralelo.
//   - `_legacy` / `_nosession` (pseudo-sesiones)        → 🔴 NUNCA auto-cerrar. Se listan
//     aparte para que decida el humano. No son sesiones reales, así que JAMÁS tienen
//     heartbeat y siempre "lucen muertas": ése fue literalmente el bug de 2026-06-05.
//     El heartbeat resuelve el caso de sesiones REALES, no éste.
//
// El cierre SIEMPRE trimea a `lastActivity`, nunca a "ahora": un huérfano de hace
// 3 semanas no puede inventar 3 semanas de trabajo.
//
// NO llama a Clockify directamente — solo gestiona estado local y delega el cierre real
// a Claude (que tiene el MCP configurado con la API key).
//
// Cross-platform. Exit 0 siempre (no romper la sesión por fallos de tracking).

const {
  readActive,
  readSettings,
  minutesBetween,
  nowIso,
  emitReminder,
  flattenActive,
  parseHookInput,
  touchHeartbeat,
  heartbeatIdleMinutes,
  cleanStaleHeartbeats,
  cleanEmptyActiveFiles,
} = require('./lib');

function main() {
  // La sesión que arranca está viva — registrá su heartbeat.
  const hookInput = parseHookInput();
  const startingSession = hookInput.session_id || null;
  if (startingSession) touchHeartbeat(startingSession);

  // Sin sessionId no podemos identificar "mi" timer de forma confiable → no tocar
  // nada (jamás cerrar a ciegas un timer que podría ser de otra sesión).
  if (!startingSession) process.exit(0);

  let active, settings;
  try {
    active = readActive();
    settings = readSettings();
  } catch (_err) {
    process.exit(0);
  }

  cleanStaleHeartbeats();     // housekeeping: heartbeats >24h
  cleanEmptyActiveFiles();    // housekeeping: archivos de active/ vacíos >24h

  const now = nowIso();
  const timeout = settings.idleTimeoutMinutes || 15;
  const deadAfter = settings.deadSessionMinutes || 120;
  const mine = [];
  const orphans = [];
  const pseudo = [];

  // flattenActive recorre todas las sesiones de todos los cwds.
  for (const { cwd, sessionId, entry } of flattenActive(active)) {
    if (!entry || !entry.lastActivity || !entry.entryId) continue;

    const idleMin = minutesBetween(entry.lastActivity, now);
    if (idleMin <= timeout) continue;  // timer con actividad reciente — no se toca

    const row = { cwd, sessionId, ...entry, idleMinutes: Math.round(idleMin) };

    if (sessionId === startingSession) {
      mine.push(row);
      continue;
    }

    // 🔴 PSEUDO-SESIONES (`_legacy` del formato single-file viejo, `_nosession`): NUNCA
    // se auto-cierran. No son sesiones reales, así que JAMÁS tienen heartbeat y por lo
    // tanto siempre "lucen muertas" — ese es EXACTAMENTE el bug de 2026-06-05, donde el
    // gate de liveness cerró un `_legacy` de Totora que estaba vivo. Se listan aparte
    // para que decida el humano; el script no las toca solo.
    if (sessionId === '_legacy' || sessionId === '_nosession') {
      pseudo.push(row);
      continue;
    }

    // Otra sesión real: sólo si está MUERTA. heartbeatIdleMinutes devuelve Infinity si
    // no hay archivo de heartbeat (sesión vieja cuyo heartbeat ya limpió el housekeeping
    // de 24h) → cuenta como muerta, que es lo correcto para un sessionId real.
    const hbIdle = heartbeatIdleMinutes(sessionId);
    if (hbIdle <= deadAfter) continue;  // 🔴 sesión VIVA en paralelo — INTOCABLE

    orphans.push({ ...row, heartbeatIdle: hbIdle === Infinity ? 'sin heartbeat' : `${Math.round(hbIdle)}min` });
  }

  if (mine.length === 0 && orphans.length === 0 && pseudo.length === 0) {
    process.exit(0);
  }

  const fmt = (s, extra) =>
    `- cwd: ${s.cwd}\n  sessionId: ${s.sessionId}\n  entryId: ${s.entryId}\n  workspaceId: ${s.workspaceId}\n` +
    `  projectId: ${s.projectId || '(ausente — leelo de la entry en Clockify)'}\n` +
    `  description: ${s.description}\n  lastActivity: ${s.lastActivity} (idle ${s.idleMinutes}min)${extra || ''}`;

  const blocks = [];

  if (mine.length) {
    blocks.push(`## Tu propio timer (sessionId ${startingSession}) — idle >${timeout}min

${mine.map((s) => fmt(s)).join('\n')}`);
  }

  if (orphans.length) {
    blocks.push(`## Timers HUÉRFANOS de sesiones MUERTAS (sin heartbeat >${deadAfter}min)

${orphans.map((s) => fmt(s, `\n  heartbeat: ${s.heartbeatIdle}`)).join('\n')}

Estas sesiones ya no existen: un sessionId no se reusa, así que nadie más los va a
cerrar. Sin esto quedan en 0 segundos para siempre (caso real 2026-07-25: ~14h de
trabajo sin facturar).`);
  }

  if (pseudo.length) {
    blocks.push(`## Entradas heredadas (\`_legacy\`/\`_nosession\`) — NO las cierres solo

${pseudo.map((s) => fmt(s)).join('\n')}

No son sesiones reales: nunca tienen heartbeat, así que es IMPOSIBLE saber por acá si
la sesión dueña está viva. Cerrar una de estas a ciegas fue el incidente de 2026-06-05.
PREGUNTALE al usuario antes de tocarlas.`);
  }

  emitReminder(`clocki sweep — hay ${mine.length + orphans.length} timer(s) para cerrar${pseudo.length ? ` + ${pseudo.length} que requieren tu confirmación` : ''}.

${blocks.join('\n\n')}

## Acción, por cada uno

1. mcp__clockify__update-clockify-time-entry con workspaceId, projectId, timeEntryId,
   description, start = startedAt, **end = lastActivity**.
   🔴 end = lastActivity, NUNCA "ahora": un huérfano viejo inventaría días de trabajo.
2. Borrar la entry del state de SU PROPIA sesión: ~/.claude/clocki/active/<sessionId>.json,
   key [cwd]. Si el archivo queda {} vacío, borralo. Nunca escribas '{}' a mano.

## Lo que sigue siendo INTOCABLE

Timers de otras sesiones CON heartbeat reciente (<${deadAfter}min) — son sesiones
trabajando en paralelo AHORA. El sweep ni siquiera los lista. Si el usuario te pide
cerrar uno de esos, confirmá con él primero.

Si un cierre falla, dejá la entry: se reintenta en el próximo arranque de sesión.`);

  process.exit(0);
}

try {
  main();
} catch (_err) {
  process.exit(0);
}
