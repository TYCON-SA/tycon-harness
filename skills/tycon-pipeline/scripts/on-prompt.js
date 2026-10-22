#!/usr/bin/env node
/**
 * tycon-pipeline UserPromptSubmit hook.
 *
 * Dos modos de detección, basados en si hay marker activo:
 *
 *   1. INTENT-DETECT (sin marker activo) — el prompt del user matchea
 *      patrones típicos de "implementemos la story X.Y.Z" sin haber
 *      invocado el skill `tycon-pipeline`. Emite reminder sugiriendo
 *      el skill canonical para evitar saltearse Step 5 (advisors).
 *
 *   2. STOP-DETECT (con marker activo + steps pending) — el prompt
 *      del user matchea keywords de cierre ("listo", "done", "completo",
 *      "cerrá", "terminamos") pero el marker indica que aún hay steps
 *      pendientes del pipeline (especialmente Step 5 advisors). Emite
 *      reminder bloqueante: NO declarar "done" sin correr advisors o
 *      documentar deferral explícito.
 *
 * Output: system-reminder en stdout (Claude Code lo inyecta al contexto).
 *
 * Sigue el patrón del `on-prompt.js` de la integración de horas, que ya funciona bien en producción.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const { resolveSessionId } = require('./lib/session-id.js');
const { stepNames } = require('./lib/steps.js');   // al dueño, los pasos por su nombre llano

// Multi-sesión sin race: marker per-session en active/<sessionId>.json.
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const LEGACY_MARKER_PATH = path.join(STATE_DIR, 'active.json');

// TTL para markers huérfanos (6h). Las sesiones que terminan sin llamar `marker.js clear` (Claude crash / dev cerró
// ventana / context overflow) dejan markers vivos; con un TTL de 24h, la sesión siguiente
// que arranca sobre la misma story dispararía CROSS-SESSION CONFLICT falso positivo.
// 6h cubre el caso típico (dejaste la ventana abierta toda la jornada) sin romper
// paralelismo intencional (sesiones reales tocan lastTouch con cada Edit via on-edit.js).
const STALE_HOURS = 6;

function markerFilePath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}

// Cross-session discovery. Lee TODOS los markers
// activos no-stale para detectar pipelines en otras sesiones.
//
// Side-effect: markers stale (lastTouch > STALE_HOURS) son
// auto-eliminados del filesystem. Esto cierra el loop de orphans: un dev que
// nunca llamó `marker.js clear` antes de cerrar Claude no contamina sesiones
// futuras más allá de la ventana TTL. Skip la sesión actual (currentSessionId)
// para no auto-borrar nuestro propio archivo si llegara a estar stale.
function listAllMarkers(currentSessionId) {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch { return []; }
  const markers = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(ACTIVE_DIR, f);
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!m || !m.storyId) continue;
      const stale = m.lastTouch && new Date(m.lastTouch).getTime() < cutoff;
      if (stale) {
        // Auto-cleanup: skip nuestra propia sesión (safety) y borrar el resto.
        if (currentSessionId && m.sessionId === currentSessionId) continue;
        try { fs.unlinkSync(full); } catch { /* best-effort */ }
        continue;
      }
      markers.push(m);
    } catch { /* ignore */ }
  }
  return markers;
}

// Extrae story id (formato N.M[.K]) del prompt del usuario. Devuelve el primer
// match o null. Acota a los patrones de INTENT (no captura "Acme 2.4 está roto").
function extractStoryId(prompt) {
  // Buscamos solo dentro de los patrones INTENT — story id típicamente sigue a
  // "story" / "historia" / "tarea" / "implementemos" / "implementar".
  const re = /\b(?:story|historia|tarea|implement(?:emos|ar|á|alos?|emos))\s+(?:la\s+)?(\d+\.\d+(?:\.\d+)?)\b/i;
  const m = prompt.match(re);
  return m ? m[1] : null;
}

// ============================================================
// Keyword detection
// ============================================================

// INTENT keywords — usuario parece arrancando impl de story. Detección case-insensitive.
// Patrones específicos: "implementemos la story <id>" / "implementar <id>" / "story <id>"
// + verbos imperativos genéricos cuando van seguidos de un identifier de story.
// Fuente única en lib/story-gate.js (los mismos patrones alimentan el veto de marker.js).
const INTENT_PATTERNS = require('./lib/story-gate.js').STORY_INTENT_PATTERNS;

// NEW_FEATURE keywords — usuario pide funcionalidad nueva sin story Mary+GOLD existente.
// Caso: "vamos a hacer la funcionalidad para conciliar pagos a
// proveedores" — Claude entra en discovery-as-Claude (preguntas sueltas en chat) en vez
// de delegar a Mary/Bob (`bmad-agent-analyst` / `tycon-create-story`). El gap es que los
// INTENT_PATTERNS exigen story id N.M, así que el caso "feature nueva from scratch" no
// activaba ningún reminder. Estos patrones cubren ese hueco: verbo imperativo de creación
// + noun feature-y, sin requerir story id. Si matchea INTENT primero (story ya existe),
// se prioriza ese (Caso 2 corta el flow antes de llegar a Caso 3).
const NEW_FEATURE_PATTERNS = [
  /\b(vamos\s+a\s+hacer|hagamos|armemos|creemos|agreguemos|implementemos|construyamos|generemos|necesito|necesitamos|quiero|queremos|hay\s+que\s+(?:hacer|crear|armar|implementar|agregar))\b.{0,80}?\b(funcionalidad|feature|m[oó]dulo|pantalla|flujo|formulario|endpoint|integraci[oó]n|reporte|servicio|api|abm|crud|conciliaci[oó]n|listado)\b/i,
  /\b(podr[íi]amos|deber[íi]amos|tenemos\s+que)\b.{0,80}?\b(hacer|crear|armar|implementar|agregar|construir)\b.{0,80}?\b(funcionalidad|feature|m[oó]dulo|pantalla|flujo|formulario|endpoint|integraci[oó]n|reporte|abm|crud)\b/i,
];

// STOP keywords — usuario indica cierre/finalización de la tarea actual.
const STOP_PATTERNS = [
  /\b(listo|done|completo|completado|terminado|terminamos|cerr[áa])\b/i,
  /\bya\s+est[áa]\s+(listo|done|completo)?\b/i,
  /\b(merge\s+a\s+main|push(\s|$)|pusheado|mergeado)\b/i,
  /\b(siguiente|next)\s+(tarea|task|story|historia)\b/i,
  /\b(pasemos\s+a|cambiemos\s+a|ahora\s+hagamos)\b/i,
];

// ============================================================
// Helpers
// ============================================================

// Marker de UNA sesión: archivo per-session `active/<sessionId>.json`.
// Fallback al legacy single-file `active.json` (transición — readonly).
function readMarker(sessionId) {
  const own = markerFilePath(sessionId);
  if (fs.existsSync(own)) {
    try {
      const m = JSON.parse(fs.readFileSync(own, 'utf8'));
      if (m && m.storyId) return m;
    } catch { /* ignore */ }
  }
  if (fs.existsSync(LEGACY_MARKER_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_MARKER_PATH, 'utf8').trim();
      if (raw && raw !== '{}') {
        const obj = JSON.parse(raw);
        if (obj && obj.storyId) return null;  // legacy plano: no es de ESTA sesión
        const m = obj && sessionId ? obj[sessionId] : null;
        if (m && m.storyId) return m;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// 🔇 Sandbox de EVALS: las corridas del banco de pruebas spawnean `claude -p` y CADA
// hook UserPromptSubmit del harness le inyecta su reminder AL PROMPT del agente simulado — que lo
// lee como parte de la conversación y lo contesta ahí adentro ("No corresponde abrir el reloj de horas"
// en medio de una entrevista simulada). Eso no es cosmético: le come turnos al presupuesto
// de la entrevista y SESGA la medición, con distinta intensidad por brazo (0-1 menciones en un brazo
// contra 6-10 en el otro, sobre la misma cantidad de turnos).
// El arnés setea TYCON_EVAL_SANDBOX=1 al spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

function readEvent() {
  // Claude Code envía el evento UserPromptSubmit via stdin como JSON.
  // Schema: {"hook_event_name":"UserPromptSubmit","prompt":"...","session_id":"..."}
  // Si falla la lectura, devuelve objeto vacío (no bloquea).
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (!stdin) return {};
    const data = JSON.parse(stdin);
    return {
      prompt: (data.prompt || '').toString(),
      sessionId: resolveSessionId(data.session_id),
      transcriptPath: data.transcript_path || null,
    };
  } catch {
    return {};
  }
}

// Regla H.i — SESIÓN FRESCA. Proxy mecánico de
// "sesión ya cargada": el tamaño del transcript JSONL de la sesión actual. Un
// pipeline que arranca fresco pesa <100KB; una sesión con horas de otro trabajo
// encima pesa MBs — y cada turno del pipeline re-lee TODO ese contexto cacheado
// (por ejemplo: 2h14 previas → 835 turnos × ~478K tokens de cache reads = 399M).
const FRESH_SESSION_MB_THRESHOLD = 1.5;
function sessionLoadedMB(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    return fs.statSync(transcriptPath).size / (1024 * 1024);
  } catch {
    return null;
  }
}

function emit(reminder) {
  // System-reminder format: Claude Code interpreta cualquier salida como
  // context inyectado al próximo turn del modelo. Envolvemos en
  // <system-reminder> explícito para consistencia con otros hooks.
  process.stdout.write(`<system-reminder>\n${reminder}\n</system-reminder>\n`);
}

function matches(prompt, patterns) {
  return patterns.some((re) => re.test(prompt));
}

// ============================================================
// Main
// ============================================================


// Falsos positivos sobre contenido NO humano: las
// task-notifications de background/workflows y los outputs de slash-commands llegan
// al hook como "prompt" y pueden CITAR texto que matchea los patterns (por ejemplo, el
// resultado de un workflow de auditoría que trae "implementemos la story ... 9.4"
// literal en su evidencia → INTENT-detect dispararía en falso, ~400 tokens de
// ruido por disparo). Señales mecánicas de contenido no-humano → salir en silencio.
const NON_HUMAN_RE = /<task-notification>|<local-command-stdout>|<command-name>|SYSTEM NOTIFICATION - NOT USER INPUT|<system-reminder>/;
const { prompt, sessionId, transcriptPath } = readEvent();
if (!prompt) process.exit(0);
if (NON_HUMAN_RE.test(prompt)) process.exit(0);

// El self-upgrade del SessionStart hook no vive acá: reescribiría
// ~/.claude/settings.json en CADA prompt (read+parse siempre, write condicional) — foot-gun
// de config global + race cross-sesión. El bootstrap del SessionStart lo hace SOLO
// install-tycon-hooks.sh|.ps1 en SessionStart (one-time), no per-prompt.

// Ring de prompts del user (evidencia para reasonInPrompts y lane-classifier). Se registra en
// CADA prompt humano, antes de cualquier salida temprana. NO fija carril: no hay
// detección por regex — ver el comentario grande en lib/story-gate.js.
// Fail-open: si el registro falla, el hook sigue igual.
try {
  const io = require('./lib/story-gate-io.js');
  io.recordPrompt(STATE_DIR, sessionId, prompt);
} catch { /* fail-open */ }

// Constancia del skill creador de stories cuando el USER lo invoca por SLASH (freno de story-a-mano):
// `/tycon-create-story <id>` tipeado por el dev
// NO pasa por la tool Skill —Claude Code expande el skill en el propio mensaje como
// `<command-name>`— y por lo tanto on-skill-invoke.js (PostToolUse Skill) no ve nada. Sin esto, el
// flujo más directo del dev llegaría al primer Write de la story sin marca → denegado. El prompt
// llega CRUDO acá (con el slash), así que la marca se deja desde este hook con via:'slash'.
// Fail-open: si falla, el freno sigue con la marca de la tool (o el bypass).
try {
  const { CREATOR_SKILLS } = require('./lib/story-skill-gate.js');
  const m = String(prompt || '').match(/^\s*\/([a-z0-9-]+)\b/i);
  if (m && CREATOR_SKILLS.includes(m[1].toLowerCase())) {
    const sio = require('./lib/story-skill-gate-io.js');
    sio.writeMark(STATE_DIR, sessionId, { skill: m[1].toLowerCase(), at: new Date().toISOString(), sessionId, cwd: process.cwd(), via: 'slash' });
  }
} catch { /* fail-open */ }

// Reparación del clon atrasado del arnés — ver lib/guides-heal.js.
// Vive ACÁ y no en un hook propio porque este hook está enchufado en TODAS las máquinas
// y viaja por agent-skills, la carpeta que sí se actualiza; un hook nuevo lo registraría el
// instalador, que es justamente lo que esas máquinas no pueden bajar. Una vez por sesión; todo local (merge --ff-only contra el origin/main
// que el arranque ya trajo — sale a la red sólo si nadie hizo fetch en 3 días, con timeout de 15 s);
// el instalador corre detached — respeta lo anterior (nada pesado ni reescrituras de settings por prompt).
// Fail-open. Off: TYCON_GUIDES_HEAL=0.
try {
  const notice = require('./lib/guides-heal.js').heal({ sessionId, stateDir: STATE_DIR });
  if (notice) emit(notice);
} catch { /* fail-open */ }

// Marker de ESTA sesión. Si otra sesión corre un pipeline distinto, su marker
// vive bajo su propio sessionId y no interfiere con la detección de acá.
const marker = readMarker(sessionId);

// Caso 1: marker activo + steps pendientes + stop keywords detectados.
if (marker && Array.isArray(marker.stepsPending) && marker.stepsPending.length > 0) {
  if (matches(prompt, STOP_PATTERNS)) {
    const pendingList = stepNames(marker.stepsPending);
    const hasAdvisorsStep = marker.stepsPending.includes(5);
    emit(
      `tycon-pipeline STOP-detect: marker activo para Story ${marker.storyId} (sprint ${marker.sprint ?? '?'}) ` +
        `con pasos pendientes: ${pendingList}.\n\n` +
        `El prompt del user parece indicar cierre, pero el pipeline NO terminó.\n\n` +
        (hasAdvisorsStep
          ? `🔴 «Revisores» (advisors en paralelo) pendiente — NO declarar "done" sin correr el set ` +
            `completo (4 base + 3 completitud + condicionales). Ver SKILL.md sección ` +
            `"Revisores: checklist (MANDATORY)".\n\n`
          : ``) +
        `Acciones válidas:\n` +
        `  (a) Continuar pipeline: ejecutar los steps pendientes en orden.\n` +
        `  (b) Cerrar story con deferral explícito: agregar bloque \`acs_pending:\` / \`tasks_pending:\` ` +
        `al frontmatter \`pipelines:\` + entry en \`CeiboProject/tasks/todo.md\`, después \`marker.js clear\`.\n` +
        `  (c) Abandonar pipeline (story no se entrega): documentar motivo + \`marker.js clear\`.\n\n` +
        `NUNCA declarar "listo / done" con marker activo sin (b) o (c).`,
    );
    process.exit(0);
  }
  // Marker activo sin stop keywords → no emitir nada, dejar que el flujo continúe.
  process.exit(0);
}

// Caso 2: no hay marker activo + el prompt matchea intent de impl de story por id N.M
// (INTENT_PATTERNS — esto es un RECORDATORIO para invocar el skill, no un freno: un miss acá no
// abre ningún agujero, porque el portón de carril bloquea el primer toque de código igual).
if (!marker && matches(prompt, INTENT_PATTERNS)) {
  // Cross-session discovery:
  // extraer storyId del prompt y buscarla en markers de OTRAS sesiones activas.
  // Si hay match → emitir reminder distinto (PIPE-C0 en hook).
  const intentStoryId = extractStoryId(prompt);
  if (intentStoryId) {
    const all = listAllMarkers(sessionId);
    const otherSessions = all.filter((m) => m.storyId === intentStoryId && m.sessionId !== sessionId);
    if (otherSessions.length > 0) {
      const lines = otherSessions
        .map((m) => {
          const stepsPending = stepNames(m.stepsPending);
          const stepsDone = stepNames(m.stepsCompleted);
          const filesCount = Array.isArray(m.filesTouched) ? m.filesTouched.length : 0;
          const sid8 = (m.sessionId || '').slice(0, 8);
          return (
            `  • sessionId=${sid8}… started=${m.startedAt} lastTouch=${m.lastTouch}\n` +
            `    repoPath=${m.repoPath}\n` +
            `    hechos: ${stepsDone || '—'} · pendientes: ${stepsPending || '—'} · filesTouched=${filesCount}`
          );
        })
        .join('\n');
      emit(
        `🛑 tycon-pipeline CROSS-SESSION CONFLICT: Story ${intentStoryId} YA tiene pipeline activo ` +
          `en ${otherSessions.length} sesión${otherSessions.length > 1 ? 'es' : ''} distinta${otherSessions.length > 1 ? 's' : ''}:\n` +
          lines +
          `\n\n🔴 NO arrancar la corrida desde cero («Arranque») — vas a:\n` +
          `   • Re-ejecutar «Validar la historia» y «Armar el plan», ya hechos.\n` +
          `   • Re-preguntar decisiones ya tomadas al user.\n` +
          `   • Re-implementar archivos ya creados en la otra sesión (colisión Write).\n` +
          `   • Re-correr advisors innecesariamente.\n` +
          `   • Abrir un segundo reloj de horas encima del primero (doble cobro).\n\n` +
          `Opciones válidas (en orden de preferencia):\n` +
          `   (a) RETOMAR el pipeline de la otra sesión: \n` +
          `       1. mem_search project="<proyecto>" query="Story ${intentStoryId} session_summary" ` +
          `→ leé el último summary.\n` +
          `       2. \`git status\` en el/los repo/s — verificá archivos pending.\n` +
          `       3. Setear MARKER en TU sessionId con el state heredado:\n` +
          `          node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set '{...}'.\n` +
          `       4. Arrancar desde el primer paso pendiente (NO desde «Arranque»).\n\n` +
          `   (b) Si la otra sesión está MUERTA (Claude crasheó / dev cerró ventana): \n` +
          `       node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear-session <sessionId>\n` +
          `       después podés arrancar fresh.\n\n` +
          `   (c) Si efectivamente querés DOS sesiones en paralelo sobre la misma story \n` +
          `       (uso muy raro — implica branches Git distintas): documentar ` +
          `intencionalidad en engram + setear tu marker con notes='paralelo intencional con <sessionId>'.\n\n` +
          `❌ NO ignorar este reminder — el caso disparador real (Story 4.2 2026-05-20) ` +
          `perdió ~40min de re-trabajo + spec drift no detectado.`,
      );
      process.exit(0);
    }
  }

  // Regla H.i — chequeo mecánico de sesión fresca ANTES de arrancar el pipeline.
  const loadedMB = sessionLoadedMB(transcriptPath);
  const freshSessionBlock = (loadedMB !== null && loadedMB >= FRESH_SESSION_MB_THRESHOLD)
    ? `\n\n🟡 REGLA H.i — SESIÓN FRESCA (auditoría 2026-06-11): esta sesión ya lleva ` +
      `~${loadedMB.toFixed(1)}MB de transcript (trabajo previo sustancial). Correr el pipeline acá ` +
      `multiplica el costo: cada turno re-lee TODO el contexto acumulado (caso 9.4: 399M de cache ` +
      `reads + compactación a mitad de «Revisores»). ANTES del «Arranque», RECOMENDALE al user arrancar la ` +
      `story en una SESIÓN NUEVA (o /clear) — el estado vive en el marker + filesystem + engram, ` +
      `no se pierde nada. El user decide.`
    : '';

  emit(
    `tycon-pipeline INTENT-detect: el prompt del user parece arrancar implementación ` +
      `de una story Mary+GOLD, pero NO hay marker activo del pipeline.\n\n` +
      `🔴 Anti-pattern conocido — si vas paso a paso manual:\n` +
      `   • Te saltás «Revisores» (advisors en paralelo) por inferencia conversacional (caso real Story 1.7.1 2026-05-15).\n` +
      `   • No hay enforcement de DoD (smoke runtime + tests + advisors).\n` +
      `   • El commit prep no sabe qué archivos tocaste sin marker.\n\n` +
      `Acciones recomendadas (en orden de preferencia):\n` +
      `   (a) Invocar el skill canonical: Skill(skill="tycon-pipeline", args="implementemos la story X.Y.Z"). ` +
      `        El skill orquesta todos los pasos (incluidos los revisores) y setea el marker automáticamente.\n` +
      `   (b) Retomando una corrida previa (sesión nueva / crash): \`pipeline.js start --story <spec> --repo <dir>\` ` +
      `detecta el marker/in-progress y ofrece adopt-session o resume. NO armes un marker a mano con stepsPending ` +
      `parcial: sin «Aprobar el plan» pendiente te saltea la aprobación del plan (queda en bypass.log).\n\n` +
      `🔒 Portón de carril (2026-08-19): en un repo bajo el arnés, el primer Edit/Write de CÓDIGO sin marker ` +
      `(ni ad-hoc declarado) se DENIEGA — y con marker, se deniega hasta que «Aprobar el plan» esté cerrado. ` +
      `No es un aviso: es un portón.\n\n` +
      `🔒 Este prompt es un pedido de STORY (2026-08-27): declarar un ad-hoc CITÁNDOLO se deniega ` +
      `(veto mecánico ADHOC_DENIED_STORY_QUOTE — citar el pedido de la story como autorización del atajo es el ` +
      `anti-pattern del 2026-08-24), y con modelo disponible el juez lee los prompts reales. Las instrucciones ` +
      `operativas del pedido (tasks en orden, tests scoped) NO son un procedimiento manual: se pasan al pipeline ` +
      `como restricciones. El atajo sólo lo habilita el USER pidiéndolo en un prompt propio.\n\n` +
      `Ver SKILL.md sección "ANTI-PATTERN — NO bypass del orchestrator".` +
      freshSessionBlock,
  );
  process.exit(0);
}

// Caso 3: no hay marker activo + el prompt pide funcionalidad nueva sin story existente.
// Cubre el gap dejado por INTENT_PATTERNS (que exige story id N.M). Caso:
// "vamos a hacer la funcionalidad para conciliar pagos a proveedores" —
// sin este branch el hook no emite nada y Claude arranca discovery-as-Claude
// (preguntas sueltas en chat) en vez de delegar a Mary (`bmad-agent-analyst`) o
// Bob (`tycon-create-story`) que es el flujo Mary+GOLD spec-first.
if (!marker && matches(prompt, NEW_FEATURE_PATTERNS)) {
  emit(
    `tycon-pipeline NEW-FEATURE-detect: el prompt parece pedir una funcionalidad nueva ` +
      `desde cero, sin story Mary+GOLD existente.\n\n` +
      `🔴 Anti-pattern conocido — discovery-as-Claude:\n` +
      `   • Hacés preguntas sueltas en el chat en vez de aplicar el método de brainstorm de Mary.\n` +
      `   • La "spec" queda en el thread, no en \`.specs/\` con frontmatter + ACs numerados + tests con nombre.\n` +
      `   • Te saltás el formato Mary+GOLD (epic, story id, sprint, status, work_item, dev notes).\n` +
      `   • No se crea work item ADO ni back-link bidireccional con stories padre.\n` +
      `   • Caso disparador real (2026-06-09): "vamos a hacer la funcionalidad para conciliar pagos a proveedores" — ` +
      `Claude entró en modo preguntas-clarificadoras a mano en vez de invocar Mary/Bob.\n\n` +
      `Acciones recomendadas (en orden de preferencia):\n` +
      `   (a) Discovery con Mary (analista) — si el alcance/contexto aún no está claro:\n` +
      `        Skill(skill="bmad-agent-analyst", args="<descripción corta del feature>")\n` +
      `        Mary aplica brainstorming + brief + user journeys. Salida = input para create-story.\n` +
      `   (b) Crear la story directo — si el alcance ya está acordado:\n` +
      `        Skill(skill="tycon-create-story", args="<descripción corta del feature>")\n` +
      `        Genera el .md en \`.specs/\` con frontmatter Mary+GOLD + ACs + tests con nombres + dev notes.\n` +
      `   (c) Si fue pregunta exploratoria (no querés codear todavía): aclarar al user que ` +
      `NO vas a tirar código aún y proponerle (a) o (b) explícitamente antes de avanzar.\n\n` +
      `❌ NO arrancar discovery-as-Claude (preguntas sueltas en chat sin invocar Mary/Bob).\n` +
      `❌ NO empezar a editar código sin un \`.specs/**/*.md\` con \`status: ready-for-dev\`.\n\n` +
      `🔒 Portón de carril (2026-08-19): si igual intentás editar código en un repo bajo el arnés sin pipeline ` +
      `activo, el Edit/Write se DENIEGA (también por Bash: sed -i / heredoc / tee). Las salidas son (a) story + ` +
      `pipeline o (b) \`marker.js adhoc set\` SOLO si el user dijo que es un ajuste chico sin story — y si no lo ` +
      `dijo, se le pregunta, no se decide por él.\n\n` +
      `   La pregunta va en CASTELLANO LLANO, con las dos opciones concretas ("¿lo hago como ajuste puntual ` +
      `o querés que vaya con story y revisión completa?"). Nunca le pegues al user el texto del portón ni le ` +
      `nombres "carril", "marker", "ad-hoc" o "el arnés": lo deja frenado sin saber qué contestar. Alcanza con ` +
      `que conteste "es un hotfix" / "sin story" para destrabar.`,
  );
  process.exit(0);
}

process.exit(0);
