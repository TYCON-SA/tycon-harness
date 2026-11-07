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
 * `handle(event)` es exportable para que el dispatcher
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

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const { homeCommand } = require('./lib/home-command.js');
// Multi-sesión sin race: marker per-session en active/<sessionId>.json.
// on-edit.js de dos sesiones concurrentes escribe archivos distintos → sin race.
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const LEGACY_MARKER_PATH = path.join(STATE_DIR, 'active.json');

// Las stories se descubren POR REPO y POR ESTRUCTURA, no con una lista fija de rutas ni por el nombre
// de la carpeta. Una lista de rutas deja sin aviso a los layouts que no están en ella, y ese aviso es la
// ÚNICA capa que cubre el trabajo hecho a mano, justo el que se saltea el gate de ATDD. Por eso una story
// es un `.md` que declara `story:` y `status:` en su frontmatter, viva donde viva.
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
// otro archivo → cero contención.
function writeMarker(sessionId, marker) {
  if (!fs.existsSync(ACTIVE_DIR)) fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  const p = markerFilePath(sessionId);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}


/**
 * ¿Es una sonda del pase adversarial? La escribe un subagente (el evento trae `agent_id`) en su laboratorio, fuera de
 * los repos que el carril ya mide, o en la carpeta donde queda la prueba de un hallazgo
 * (`<raíz del repo>/.advisors/pipeline-runs/<corrida>/step-05b-probes/`). No es
 * trabajo del carril: anotarla sumaba repos y archivos que cambiaban la huella de las constancias de revisores y pase.
 * Lo demás que escribe un subagente se anota como siempre, y también cuando el carril todavía no mide ningún repo o
 * no se puede saber: ante la duda, se anota.
 */
function esSondaDeSubagente(event, filePath, sessionId, stateDir = STATE_DIR) {
  if (!event || !event.agent_id) return false;
  // un `..` después de un enlace lleva a otra carpeta que la que se ve al normalizar: no se puede saber dónde cae
  if (String(filePath).split(/[\\/]/).includes('..')) return false;
  try {
    const base = require('./lib/adhoc-base.js');
    // por la consola el archivo, y a veces sus carpetas, todavía no existen: se resuelve la carpeta más cercana que sí
    // existe y se le cuelga el resto, así un enlace en el camino (como /tmp en mac) no cambia la ruta
    const real = (p) => {
      let cerca = path.resolve(p);
      const resto = [];
      for (;;) {
        try { return path.join(fs.realpathSync(cerca), ...resto); } catch { /* sube una carpeta */ }
        const arriba = path.dirname(cerca);
        if (arriba === cerca) return path.resolve(p);
        resto.unshift(path.basename(cerca));
        cerca = arriba;
      }
    };
    // la ruta real, sin `..` ni enlaces: lo que se mide es dónde quedó el archivo, no cómo se lo nombró
    const archivo = real(filePath);
    // git que no contesta no prueba que el archivo esté fuera: se anota
    const donde = base.ubicar(archivo);
    if (donde.raiz) {
      const partes = path.relative(real(donde.raiz), archivo).split(path.sep);
      if (partes.length > 4 && partes[0] === '.advisors' && partes[1] === 'pipeline-runs' && partes[3] === 'step-05b-probes') return true;
    }
    const adhoc = require('./lib/story-gate-io.js').readAdhoc(stateDir, sessionId);
    if (!adhoc) return false;
    // una ruta del carril cuyo repo git no ubicó deja la lista incompleta: no prueba que el archivo esté fuera
    const repos = new Set(Object.keys(adhoc.bases || {}).map(real));
    for (const f of [...(adhoc.rutas || []), ...(adhoc.files || [])]) {
      const u = base.ubicar(f);
      if (u.falla) return false;
      if (u.raiz) repos.add(real(u.raiz));
    }
    if (!repos.size) return false;
    if (donde.fuera) return true;
    if (!donde.raiz) return false;
    return !repos.has(real(donde.raiz));
  } catch {
    return false;
  }
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

  // Marker de ESTA sesión (multi-sesión). Si otra sesión corre un
  // pipeline en el mismo repo, su marker vive bajo su sessionId — no lo tocamos.
  const sessionId = event.session_id || '_nosession';

  // La edición se registra SIEMPRE, haya o no corrida de pipeline. Es la evidencia que necesita el
  // gate de ATDD del commit para cubrir el trabajo hecho a mano: sin marker, el gate de
  // `complete-step implement` no tiene nada que leer y el orden test↔código queda sin control.
  atddGate.recordFileEvent(STATE_DIR, sessionId, filePath, Date.now());

  const marker = readMarker(sessionId);

  if (marker) {
    // Caso 1: marker activo de esta sesión — registrar archivo tocado + touch.
    if (!marker.filesTouched.includes(filePath)) {
      marker.filesTouched.push(filePath);
    }
    // El SELLO del contenido que esta edición deja (piso de frescura por contenido):
    // hash + hora. Con eso el piso de la evidencia E2E se decide comparando contenido —un
    // checkout, un rebase o un stash pop que dejan el mismo contenido NO lo mueven; un pull que
    // trae otro contenido sí—, sin adivinar por fechas del disco ni de commits.
    // `eol` (la huella con CRLF como LF) deja reconocer el mismo contenido reescrito con otro fin de línea.
    try {
      const { hash, eol } = require('./lib/content-seal.js').selloDeArchivo(filePath);
      if (!marker.filesTouchedAt || typeof marker.filesTouchedAt !== 'object') marker.filesTouchedAt = {};
      marker.filesTouchedAt[filePath] = { hash, eol, ts: Date.now() };
    } catch { /* ilegible o borrado: sin sello, el piso cae a la fecha del disco */ }
    // fileEvents: registrar CADA edición con ts — incluidas las RE-ediciones de archivos ya en
    // filesTouched. Es el data-path que computeSmartReloop (pipeline.js) usa para el delta por iteración.
    // Sin estos eventos, todo marker llega sin fileEvents, smart-reloop degrada a names-only, pierde los
    // fixes sobre archivos existentes, y el orquestador cae al set COMPLETO de advisors en cada re-loop.
    if (!Array.isArray(marker.fileEvents)) marker.fileEvents = []; // marker corrupto → normalizar (no romper el "exit 0 siempre")
    // `code`: si la edición pide otra vuelta de revisores (lib/reloop-code.js). Lo leen `next` y el cartel para decidir
    // lo mismo (el cartel corre sin el clasificador del arnés). Si la regla falla, pide: ante la duda, se revisa
    let code;
    try { code = require('./lib/reloop-code.js').pideOtraVuelta(filePath, { storyPath: marker.storyPath }); } catch (_) { code = true; }
    marker.fileEvents.push({ path: filePath, ts: new Date().toISOString(), code });
    if (marker.fileEvents.length > 500) {
      marker.fileEvents = marker.fileEvents.slice(-500);
    }
    // `otraVuelta`: la decisión de `next` sobre la otra vuelta, escrita para el cartel (lib/steps.js `otraVueltaDe`)
    try {
      const v = require('./lib/steps.js').otraVueltaDe(marker);
      if (v === undefined) delete marker.otraVuelta;
      else marker.otraVuelta = v;
    } catch (e) {
      // sin el campo, el cartel usa su regla de antes; `next` y el último paso deciden igual. El campo viejo se borra (el
      // cartel leería una decisión vieja) y queda el rastro
      delete marker.otraVuelta;
      try { fs.appendFileSync(path.join(STATE_DIR, 'hook-errors.log'), `[${new Date().toISOString()}] on-edit otraVuelta: ${(e && e.stack) || e}\n\n`, 'utf8'); } catch { /* noop */ }
    }
    marker.lastTouch = new Date().toISOString();
    try {
      writeMarker(sessionId, marker);
    } catch {
      // No bloquear — el marker es advisory, no critical.
    }
    return null;
  }

  // La sonda de un agente del pase no es del carril: no se anota ni suma al cupo
  if (esSondaDeSubagente(event, filePath, sessionId)) return null;
  // Sin marker pero con carril AD-HOC declarado: registrar el archivo de implementación bajo el ad-hoc.
  // El cupo del portón de carril se cuenta acá, en PostToolUse, sobre ediciones que EFECTIVAMENTE
  // ocurrieron. No en el PreToolUse, donde un Edit fallido o denegado por otro handler también contaría.
  try {
    const { isImplPath } = require('./lib/atdd-order.js');
    const sg = require('./lib/story-gate.js');
    const io = require('./lib/story-gate-io.js');
    if (isImplPath(filePath) && sg.isCodeFile(filePath)) {
      io.recordAdhocFile(STATE_DIR, sessionId, filePath);
    }
  } catch { /* best-effort */ }
  // Cada ruta que escribe el carril, en cualquier repo: su base al primer toque y la marca de riesgo alto, que piden
  // los revisores y el pase antes de guardar (lib/save-brake.js).
  let avisosDelCarril = [];
  try {
    const r = require('./lib/story-gate-io.js').anotarRutaDelCarril(STATE_DIR, sessionId, filePath);
    if (r) avisosDelCarril = r.avisos;
  } catch (e) {
    // sin anotar, el carril puede quedar sin su marca de riesgo alto: se dice y queda en gates.log
    avisosDelCarril = [`camino rápido: no pude anotar ${filePath} en el carril (${(e && e.message) || e}): su riesgo no se midió`];
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { name: 'adhoc-base', status: 'unknown', file: filePath, reason: avisosDelCarril[0] }); } catch { /* el aviso igual sale */ }
  }

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
        // Si trabajar fuera del pipeline es legítimo, al menos tiene que ser RUIDOSO: acá se enumera
        // lo que te estás perdiendo.
        `   • Escribir los tests ANTES del código (pruebas primero, en «Implementar y correr las pruebas»). El gate del commit avisa igual,\n` +
        `     pero recién cuando ya está escrito al revés.\n` +
        `   • Generar la guía de prueba manual derivada de los ACs:\n` +
        `     ${homeCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/qa-guide.js')} --story <story.md>\n` +
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

  return avisosDelCarril.length ? { reminder: avisosDelCarril.join('\n') } : null;
}

module.exports = { handle, esSondaDeSubagente };

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
