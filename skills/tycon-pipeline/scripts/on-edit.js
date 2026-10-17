#!/usr/bin/env node
/**
 * tycon-pipeline PostToolUse hook (matcher: Edit|Write).
 *
 * Cuando el orquestador hace Edit/Write sobre un archivo:
 *
 *   1. Si HAY marker activo: append al `filesTouched` del marker + touch
 *      lastTouch (el marker pasa a ser la fuente de verdad de "qué archivos
 *      tocó esta story").
 *
 *   2. Si NO HAY marker activo Y el archivo está listado en
 *      `files_to_create` / `files_to_modify` de alguna story Mary+GOLD DEL
 *      MISMO REPO → emitir reminder: "estás editando archivos de una story
 *      sin invocar tycon-pipeline".
 *
 * El check del 2 es defensivo y best-effort: las stories se descubren por
 * ESTRUCTURA (un .md cuyo frontmatter declara `story:` y `status:`), no por
 * el nombre de la carpeta que las contiene — ver lib/story-discovery.js. El
 * escaneo tiene presupuesto de tiempo (200ms, `TYCON_STORY_SCAN_BUDGET_MS`) y
 * el índice se cachea por repo, así que el costo por edición es ~1ms.
 *
 * Output: system-reminder o nada. Exit 0 siempre (no bloqueante).
 *
 * H10 2026-05-21: refactor a `handle(event)` exportable para que el dispatcher
 * lo corra in-process. El shim CLI del fondo preserva el comportamiento standalone.
 *
 * Schema del evento Claude Code PostToolUse Edit/Write (stdin):
 *   {
 *     "hook_event_name": "PostToolUse",
 *     "tool_name": "Edit" | "Write",
 *     "tool_input": { "file_path": "/abs/path/file" }
 *   }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
// Multi-sesión sin race (2026-05-17): marker per-session en active/<sessionId>.json.
// on-edit.js de dos sesiones concurrentes escribe archivos distintos → sin race.
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const LEGACY_MARKER_PATH = path.join(STATE_DIR, 'active.json');

// 2026-07-28 — las stories se descubren POR REPO, no con una lista fija de rutas.
// 2026-08-15 — y POR ESTRUCTURA, no por el nombre de la carpeta.
//
// Primero esto era un array de TRES paths absolutos terminados en `specs/stories`; los layouts de
// un producto del equipo no estaban ahí, así que el aviso "estás editando una story sin pipeline" nunca salía
// para ese repo — y ese aviso es la ÚNICA capa que cubre el trabajo hecho a mano, justo el que se
// saltea el gate de ATDD. El arreglo de entonces cambió las tres rutas por DOS NOMBRES de carpeta
// (`stories`, `epic-*`): el mismo defecto un nivel más arriba, que se cayó en otro producto
// (`specs/bizuit-bpmn-mcp/` → cero stories, aviso mudo otra vez). Ahora una story es un `.md` que
// declara `story:` y `status:` en su frontmatter, viva donde viva.
// Casos disparadores: 2026-07-28 (un producto del equipo) y 2026-08-15 (otro producto) — guides/maintaining/incident-log.md#story-discovery-nombres
const { findStoryReferencing } = require('./lib/story-discovery.js');
const atddGate = require('./lib/atdd-commit-gate.js');

// ============================================================
// Helpers
// ============================================================

function markerFilePath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}

// Marker de UNA sesión: archivo per-session + fallback legacy single-file (readonly).
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

// Escribe el marker de ESTA sesión en su archivo propio. Otra sesión escribe
// otro archivo → cero contención (fix race 2026-05-17).
function writeMarker(sessionId, marker) {
  if (!fs.existsSync(ACTIVE_DIR)) fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  const p = markerFilePath(sessionId);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}


/**
 * Handler dispatchable. Recibe el evento RAW y devuelve:
 *   null               → nada (exit 0)
 *   { reminder: text } → advisory (el caller envuelve en <system-reminder>)
 * Tiene side-effects (actualiza el marker de la sesión) — eso es intencional.
 */
function handle(event) {
  if (!event || !event.tool_input || !event.tool_input.file_path) return null;

  const filePath = event.tool_input.file_path;
  if (!filePath || !path.isAbsolute(filePath)) return null;

  // Skip changes within ~/.claude/* — son tooling/config, no impl de story.
  if (filePath.startsWith(path.join(os.homedir(), '.claude'))) return null;

  // Marker de ESTA sesión (multi-sesión, 2026-05-17). Si otra sesión corre un
  // pipeline en el mismo repo, su marker vive bajo su sessionId — no lo tocamos.
  const sessionId = event.session_id || '_nosession';

  // 2026-07-28 — la edición se registra SIEMPRE, haya o no corrida de pipeline. Es la evidencia
  // que necesita el gate de ATDD del commit para cubrir el trabajo hecho a mano: sin marker, el
  // gate de `complete-step 4` no tiene nada que leer y el orden test↔código queda sin control.
  atddGate.recordFileEvent(STATE_DIR, sessionId, filePath, Date.now());

  const marker = readMarker(sessionId);

  if (marker) {
    // Caso 1: marker activo de esta sesión — registrar archivo tocado + touch.
    if (!marker.filesTouched.includes(filePath)) {
      marker.filesTouched.push(filePath);
    }
    // El SELLO del contenido que esta edición dejó (2026-09-06, piso de frescura por contenido):
    // hash + hora. Con eso el piso de la evidencia E2E se decide comparando contenido —un
    // checkout, un rebase o un stash pop que dejan el mismo contenido NO lo mueven; un pull que
    // trae otro contenido sí—, sin adivinar por fechas del disco ni de commits.
    try {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
      if (!marker.filesTouchedAt || typeof marker.filesTouchedAt !== 'object') marker.filesTouchedAt = {};
      marker.filesTouchedAt[filePath] = { hash, ts: Date.now() };
    } catch { /* ilegible o borrado: sin sello, el piso cae a la fecha del disco */ }
    // fileEvents (fix auditoría 2026-06-11, run 9.4): registrar CADA edición con ts —
    // incluidas las RE-ediciones de archivos ya en filesTouched. Es el data-path que
    // computeSmartReloop (pipeline.js) usa para el delta por iteración (SPEED-1).
    // Antes esto solo lo escribía `marker.js append-file` (código muerto, sin callers)
    // → TODO marker llegaba sin fileEvents y smart-reloop degradaba a names-only,
    // perdiendo los fixes sobre archivos existentes → el orquestador caía al set
    // COMPLETO de advisors en cada re-loop (caso 9.4: 2 iteraciones full de 13 de más).
    if (!Array.isArray(marker.fileEvents)) marker.fileEvents = []; // marker corrupto → normalizar (no romper el "exit 0 siempre")
    marker.fileEvents.push({ path: filePath, ts: new Date().toISOString() });
    if (marker.fileEvents.length > 500) {
      marker.fileEvents = marker.fileEvents.slice(-500);
    }
    marker.lastTouch = new Date().toISOString();
    try {
      writeMarker(sessionId, marker);
    } catch {
      // No bloquear — el marker es advisory, no critical.
    }
    return null;
  }

  // Caso 1b (2026-08-19): sin marker pero con carril AD-HOC declarado — registrar el archivo de
  // implementación bajo el ad-hoc (el cupo del portón de carril se cuenta acá, en PostToolUse, sobre
  // ediciones que EFECTIVAMENTE ocurrieron — no en el PreToolUse, donde un Edit fallido o denegado por
  // otro handler también contaría; hallazgo R13 del review adversarial).
  try {
    const { isImplPath } = require('./lib/atdd-order.js');
    const sg = require('./lib/story-gate.js');
    const io = require('./lib/story-gate-io.js');
    if (isImplPath(filePath) && sg.isCodeFile(filePath) && !io.isHarnessRepo(filePath)) {
      io.recordAdhocFile(STATE_DIR, sessionId, filePath);
    }
  } catch { /* best-effort */ }

  // Caso 2: sin marker — chequear si el archivo está referenciado por una story.
  const story = findStoryReferencing(filePath);
  if (story) {
    return {
      reminder:
        `tycon-pipeline EDIT-detect: estás editando un archivo referenciado por una story Mary+GOLD ` +
        `(\`${story.storyId}\` en \`${story.storyPath}\`) **sin marker activo del pipeline**.\n\n` +
        `Esto significa que ningún hook va a recordarte:\n` +
        `   • Correr los revisores en paralelo cuando termines.\n` +
        `   • Bloquear "done" si quedan pasos pendientes.\n` +
        `   • Asociar este archivo al diff de la story para el commit prep.\n` +
        // 2026-07-28 — las tres de abajo se perdieron EN SILENCIO en la misma sesión, una por una,
        // y las tres las detectó el dev leyendo el transcript. Si trabajar fuera del pipeline es
        // legítimo, al menos tiene que ser RUIDOSO: acá se enumera lo que te estás perdiendo.
        `   • Escribir los tests ANTES del código (pruebas primero, en «Implementar y correr las pruebas»). El gate del commit avisa igual,\n` +
        `     pero recién cuando ya está escrito al revés.\n` +
        `   • Generar la guía de prueba manual derivada de los ACs:\n` +
        `     node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/qa-guide.js --story <story.md>\n` +
        `     (NO la escribas a mano — sale de los ACs, no de la memoria.)\n` +
        `   • La matriz de DoD por AC (qué se verificó corriendo y qué no).\n\n` +
        `Acción recomendada — arrancar el pipeline de verdad (setea el marker y recorre los steps en orden):\n` +
        `   Skill(skill="tycon-pipeline", args="implementemos la story ${story.storyId}")\n` +
        `   (retomando una corrida previa: \`pipeline.js start --story ${story.storyPath} --repo <dir>\` ofrece adopt/resume).\n` +
        `   Un marker a mano con stepsPending parcial (sin 3 y 4) se saltea el plan aprobado y queda en bypass.log.\n\n` +
        `Si esto NO es impl de la story (hotfix, refactor independiente) → el carril ad-hoc ya declarado lo cubre; ` +
        `si no hay ninguno, el portón de carril te lo va a pedir en el próximo archivo de código.`,
    };
  }

  return null;
}

module.exports = { handle };

// ── CLI shim (standalone) ──
if (require.main === module) {
  let event = null;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : null;
  } catch {
    event = null;
  }
  const r = handle(event);
  if (r && r.reminder) {
    process.stdout.write(`<system-reminder>\n${r.reminder}\n</system-reminder>\n`);
  }
  process.exit(0);
}
