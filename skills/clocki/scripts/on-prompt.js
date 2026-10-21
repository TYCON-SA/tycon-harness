#!/usr/bin/env node
// clocki/scripts/on-prompt.js
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
      emitReminder(`clocki STOP-detect: el prompt parece fin/transición de tarea (keyword detectado: "${matchedStop}").

Timer activo de ESTA sesión (session_id "${sessionKey}") en cwd "${found.matchedKey}":
  - entryId: ${activeForCwd.entryId}
  - description: "${activeForCwd.description}"
  - startedAt: ${activeForCwd.startedAt}
  - lastActivity: ${activeForCwd.lastActivity}

ACCIÓN MANDATORY antes de seguir con el prompt:
1. Si la tarea TERMINÓ (no hay continuación inmediata) → cerrá el timer:
   - mcp__clockify__update-clockify-time-entry con timeEntryId="${activeForCwd.entryId}", end=now (o lastActivity si hubo idle), workspaceId="${activeForCwd.workspaceId}", projectId="${activeForCwd.projectId}", description=la actual
   - Borrá la entry del archivo de esta sesión: en ${sessionFile} eliminá la key ["${found.matchedKey}"]. Si el archivo queda {}, borralo. Es tu archivo — no afecta a otras sesiones. NUNCA \`printf '{}'\`.

2. Si el user transiciona a OTRA tarea (ej. "ahora hagamos X") → cerrar previa Y abrir nueva ATÓMICAMENTE (regla anti-billing-gap):
   - update-clockify-time-entry (cerrar previa con end=now)
   - create-clockify-time-entry (nueva con start=now + desc nueva)
   - Write ${sessionFile}: reemplazá la entry bajo la key ["${found.matchedKey}"] con el nuevo entryId

3. Si el prompt fue ambiguo (no sabés si terminó o sigue), PREGUNTÁ al user antes de cerrar:
   "Veo que dijiste '${matchedStop}'. ¿Cerro el timer de '${activeForCwd.description}' o seguimos?"

NUNCA dejes el timer corriendo si la tarea ya terminó. El user MARCÓ ESTO COMO PROBLEMA PRINCIPAL.`);
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
        emitReminder(`clocki TASK-CHANGE detect: timer activo "${activeForCwd.description}" (session_id "${sessionKey}") pero el prompt contiene NUEVO intent (keyword "${matchedIntentMidTask}") sin referenciar la descripción actual.

Posible cambio de tarea. ACCIÓN antes de seguir:
1. Confirmá con el user: "Veo nuevo intent ('${matchedIntentMidTask}') que parece distinto al timer actual ('${activeForCwd.description}'). ¿Es continuación de la misma tarea, o transición a otra? Si transición → cerrar previo + abrir nuevo."
2. Si el user confirma transition → cerrar previo + crear nuevo timer ATÓMICAMENTE (regla anti-billing-gap):
   - update-clockify-time-entry (cerrar previa con end=now, timeEntryId="${activeForCwd.entryId}")
   - create-clockify-time-entry (nueva con desc nueva)
   - Write ${sessionFile}: reemplazá la entry bajo la key ["${found.matchedKey}"]
3. Si el user dice "es la misma tarea, solo otro angle" → IGNORAR este reminder, seguir.

Si el prompt fue una pregunta exploratoria que NO arranca trabajo nuevo, IGNORAR este reminder.`);
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

  emitReminder(`clocki: el prompt del user parece intent de trabajo (keyword detectado: "${matchedKeyword}") y NO hay timer activo para esta sesión (session_id "${sessionKey}") en cwd "${cwd}".

Si efectivamente vas a empezar a trabajar (no es pregunta exploratoria, charla, ni meta-discusión sobre el proceso), antes de hacer cualquier otra cosa:

1. Inferí una descripción corta del trabajo (5-10 palabras, ej: "fix bug login redirect", "refactor service X", "story 2.3 webhook handler").
2. Resolvé el project: leé ~/.claude/clocki/project-cache.json. Si hay entry para cwd, usala. Si no, llamá mcp__clockify__list-clockify-projects y matcheá basename del cwd contra los project names (case-insensitive, exact > parcial). Si no hay match único, ofrecé top 5 al user.
3. PREGUNTÁ al user antes de abrir: "Detecté trabajo: <desc>. ¿Abro timer en Clockify project <project-name>? (sí / cambiar desc / cambiar project / no)".
4. Si el user confirma: llamá mcp__clockify__create-clockify-time-entry con (workspaceId, projectId, description, start=<now-local-bare>, end=<MISMO-valor-que-start>, billable=true). 🔴 TIMEZONE: start DEBE estar en hora LOCAL, formato bare yyyy-MM-ddTHH:mm:ss (sin Z, sin offset) — obtenelo con \`date "+%Y-%m-%dT%H:%M:%S"\` (SIN -u). El MCP convierte local→UTC al guardar. NUNCA pases UTC (date -u / toISOString): el MCP lo trata como local y la entry queda corrida por tu offset (caso 2026-05-17). 🔴 end NO es null, NO es futuro — usá el MISMO timestamp que start (la duración real se extiende vía touch-activity hook). Schema MCP requiere end como string obligatorio.
   Persistí en ${sessionFile} (archivo propio de esta sesión, forma { "<cwd>": <entry> }) la entry bajo la key ["${cwd}"] con: entryId, workspaceId, projectId, description, startedAt=now, lastActivity=now, source="hook-intent". Es tu archivo exclusivo — Read, set la key, Write. NO toca timers de otras sesiones. Cacheá el project resolution en project-cache.json.
5. Si el user dice "no" o ignora, NO abrir.

Si el prompt era una pregunta o discusión y NO trabajo concreto, ignorá este reminder.`);

  process.exit(0);
}

try {
  main();
} catch (_err) {
  process.exit(0);
}
