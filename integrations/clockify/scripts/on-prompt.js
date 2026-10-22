#!/usr/bin/env node
// integrations/clockify/scripts/on-prompt.js
//
// Invocado por el hook UserPromptSubmit. Hace dos cosas:
//   1. Sweep — cierra timers idle (>idleTimeoutMinutes) emitiendo reminder a Claude.
//   2. Intent detection — si no hay timer activo en este cwd Y el prompt contiene
//      keywords de "intent de trabajo", emite reminder pidiendo a Claude que proponga
//      abrir un timer (con confirmación del usuario).
//
// Lee el JSON de input del hook desde stdin. Campos relevantes: cwd, prompt | user_prompt.
//
// Cross-platform. Exit 0 siempre.

const {
  readActive,
  readSettings,
  normalizeCwd,
  minutesBetween,
  nowIso,
  emitReminder,
  parseHookInput,
  findActiveEntryForCwd,
  flattenActive,
  touchHeartbeat,
  heartbeatIdleMinutes,
} = require('./lib');

// Keywords de intent/stop: FUENTE ÚNICA en lib.js (DEFAULT_SETTINGS, narrow/precision-first).
// readSettings() las provee siempre — si el disco trae `[]` o nada, cae al narrow default.
// (Una lista ANCHA duplicada acá —'plan'/'fix'/'add'/'build'/'setup' pelados— dispararía sobre charla/meta-discusión.)

function detectIntent(prompt, keywords) {
  if (!prompt || typeof prompt !== 'string') return null;
  const lower = prompt.toLowerCase();
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Match como palabra completa o al inicio de palabra
    // (evita falsos positivos como "fixate" matcheando "fix")
    const re = new RegExp(`(^|[^a-z0-9_])${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
    if (re.test(prompt)) {
      return kw;
    }
  }
  return null;
}

// 🔇 Sandbox de EVALS: las corridas del banco de pruebas spawnean `claude -p` y CADA
// hook UserPromptSubmit del harness le inyecta su reminder AL PROMPT del agente simulado — que lo
// lee como parte de la conversación y lo contesta ahí adentro ("No corresponde timer de Clockify"
// en medio de una entrevista simulada). Eso no es cosmético: le come turnos al presupuesto
// de la entrevista y SESGA la medición, con distinta intensidad por brazo (unas pocas menciones en un brazo
// contra muchas en el otro, sobre la misma cantidad de turnos).
// El arnés setea TYCON_EVAL_SANDBOX=1 al spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

function main() {
  const hookInput = parseHookInput();
  const cwd = normalizeCwd(hookInput.cwd || process.cwd());
  const sessionId = hookInput.session_id || null;
  const sessionKey = sessionId || '_nosession';
  const prompt = hookInput.prompt || hookInput.user_prompt || '';

  // Contenido NO humano: task-notifications de background/
  // workflows y outputs de slash-commands llegan como "prompt" y pueden citar keywords
  // de cierre ("listo", "pusheado") → STOP-detect en falso (por ejemplo, la notificación de
  // un workflow que cita "listo" del transcript). Salir en silencio.
  if (/<task-notification>|<local-command-stdout>|<command-name>|SYSTEM NOTIFICATION - NOT USER INPUT|<system-reminder>/.test(prompt)) {
    process.exit(0);
  }

  // 🔴 Heartbeat: marca esta sesión como VIVA ahora (housekeeping + visibilidad
  // para /clocki status). El sweep no lo usa como gate: scopea por
  // sessionId (solo cierra el timer de ESTA sesión, ver abajo).
  touchHeartbeat(sessionKey);

  let active, settings;
  try {
    active = readActive();
    settings = readSettings();
  } catch (_err) {
    process.exit(0);
  }

  const now = nowIso();
  const timeout = settings.idleTimeoutMinutes || 15;
  // readSettings() garantiza listas no-vacías (narrow defaults de lib.js si el disco
  // trae `[]` o nada). Fuente única de keywords — ver DEFAULT_SETTINGS en lib.js.
  const keywords = settings.intentKeywords;
  const stopKeywords = settings.stopKeywords;

  // Multi-sesión sin race: cada sesión tiene su archivo propio.
  // El timer de esta sesión vive en este archivo, con forma { "<cwd>": <entry> }:
  const sessionFile = `~/.claude/clocki/active/${sessionKey}.json`;

  // 1. Sweep — SOLO el timer idle de ESTA sesión.
  //    🔴 POLÍTICA: el sweep NUNCA toca timers de OTRAS sesiones (ni
  //    los cierra ni los lista), aunque luzcan muertos. Cerrar el timer de otra
  //    sesión es un anti-pattern (ver sweep.js + CLAUDE.md global). Solo el propio:
  //    caso típico, esta sesión volvió a actividad tras estar idle >timeout.
  const stale = [];
  if (sessionId) {
    for (const { cwd: k, sessionId: sid, entry } of flattenActive(active)) {
      if (!entry || !entry.lastActivity || !entry.entryId) continue;
      if (sid !== sessionId) continue;                        // 🔴 nunca otra sesión
      const idleMin = minutesBetween(entry.lastActivity, now);
      if (idleMin <= timeout) continue;                       // timer activo
      stale.push({ cwd: k, sessionId: sid, ...entry, idleMinutes: Math.round(idleMin) });
    }
  }

  if (stale.length > 0) {
    const lines = stale.map((s) =>
      `- cwd: ${s.cwd}\n  entryId: ${s.entryId}\n  workspaceId: ${s.workspaceId}\n  description: ${s.description}\n  lastActivity: ${s.lastActivity} (idle ${s.idleMinutes}min)`
    );
    emitReminder(`clocki sweep — TU PROPIO timer (esta sesión) quedó idle >${timeout}min:

${lines.join('\n')}

Es el timer de ESTA sesión (session_id "${sessionKey}"). Cerralo:
mcp__clockify__update-clockify-time-entry con end=lastActivity (trim al último activity),
luego borrá la entry del state: ~/.claude/clocki/active/${sessionKey}.json — eliminá la key
[cwd] (si queda {}, borralo).

🔴 NUNCA cierres timers de OTRAS sesiones, aunque luzcan idle/muertos. El usuario los
gestiona con /clocki.`);
  }

  // 1b. /clocki manual — exponer session_id + archivo para que el flujo del skill lo use.
  if (/(^|\s)\/clocki(\s|$)/i.test(prompt)) {
    emitReminder(`clocki: comando manual detectado. session_id de esta sesión: "${sessionKey}".
El timer de esta sesión vive en ${sessionFile} — un archivo propio con forma { "<cwd>": <entry> }.
Leé/escribí SOLO ese archivo. Cada sesión tiene el suyo, así que no hay riesgo de pisar
timers de otras sesiones (fix race 2026-05-17). NO toques active/*.json de otras sesiones.`);
  }

  // Timer activo de ESTA sesión (walk-up por parents + scope por sessionId).
  const found = findActiveEntryForCwd(active, cwd, sessionId);
  const activeForCwd = found ? found.entry : null;

  // 2. STOP-DETECTION — si HAY timer activo de esta sesión y el prompt
  //    contiene stop-keywords, emitir reminder para cierre/transición.
  if (activeForCwd && activeForCwd.entryId) {
    const matchedStop = detectIntent(prompt, stopKeywords);
    if (matchedStop) {
      emitReminder(`clocki: el prompt parece fin de tarea ("${matchedStop}") y esta sesión tiene el timer "${activeForCwd.description}" abierto (entryId ${activeForCwd.entryId}, workspaceId ${activeForCwd.workspaceId}, projectId ${activeForCwd.projectId}, lastActivity ${activeForCwd.lastActivity}).
- Terminó: cerralo con update-clockify-time-entry (end = ahora, o lastActivity si hubo pausa) y sacá la key ["${found.matchedKey}"] de ${sessionFile}.
- Pasa a otra tarea: cerrá este y abrí el nuevo en el mismo paso, sin hueco.
- Si no está claro, preguntá antes de cerrar. Nunca dejes el timer corriendo con la tarea terminada.
Los pasos, en la skill clocki («Flujo de stop» y «Regla atómica close+open»).`);
      process.exit(0);
    }

    // 3. TASK-CHANGE-DETECTION — timer activo + nuevo intent que NO matchea
    //    la descripción current. Heurística: keyword de intent presente + ninguna palabra
    //    significativa de la descripción está en el prompt (excluye stopwords cortos).
    const matchedIntentMidTask = detectIntent(prompt, keywords);
    if (matchedIntentMidTask) {
      const descWords = (activeForCwd.description || '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 4); // ignora palabras cortas tipo "de", "la", "fix"
      const promptLower = prompt.toLowerCase();
      const referencesCurrentDesc = descWords.some((w) => promptLower.includes(w));

      if (!referencesCurrentDesc) {
        emitReminder(`clocki: el prompt parece una tarea nueva ("${matchedIntentMidTask}") y esta sesión tiene abierto "${activeForCwd.description}" (entryId ${activeForCwd.entryId}).
Preguntá si es la misma tarea u otra tarea. Si es otra: cerrá este y abrí el nuevo en el mismo paso, sin hueco, y actualizá la key ["${found.matchedKey}"] de ${sessionFile}. Si es la misma, o era sólo una pregunta, seguí.
Los pasos, en la skill clocki («Regla atómica close+open»).`);
        process.exit(0);
      }
    }

    // Ya hay timer corriendo para esta sesión; touch-activity actualizará lastActivity.
    process.exit(0);
  }

  // 4. Intent detection (start) — solo si no hay timer activo de ESTA sesión en este cwd.
  //    Nota: otra sesión PUEDE tener un timer en el mismo cwd — no importa, esta sesión
  //    necesita el suyo propio bajo su sessionId.
  const matchedKeyword = detectIntent(prompt, keywords);
  if (!matchedKeyword) {
    process.exit(0);
  }

  emitReminder(`clocki: el prompt parece trabajo ("${matchedKeyword}") y esta sesión no tiene timer en ${cwd}. Si de verdad arranca trabajo:
- Preguntá antes de abrir: «Detecté trabajo: <descripción corta>. ¿Abro timer en el proyecto <proyecto>?» (el proyecto, de ~/.claude/clocki/project-cache.json o de la lista de Clockify). Sin un sí, no se abre.
- Con el sí: create-clockify-time-entry con start en hora local, sin Z ni offset (\`date "+%Y-%m-%dT%H:%M:%S"\`, nunca UTC), y end igual al inicio.
- Guardá la entry en ${sessionFile}, bajo la key ["${cwd}"] (entryId, workspaceId, projectId, description, startedAt, lastActivity, source="hook-intent"); es el archivo de esta sesión, no toques los de otras.
Si era una pregunta o una charla, ignoralo. Los pasos, en la skill clocki («Flujo de start»).`);

  process.exit(0);
}

try {
  main();
} catch (_err) {
  process.exit(0);
}
