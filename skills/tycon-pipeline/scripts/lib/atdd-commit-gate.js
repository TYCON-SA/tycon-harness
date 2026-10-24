/**
 * atdd-commit-gate.js — extiende el freno de ATDD al trabajo hecho FUERA del pipeline.
 *
 * ── EL AGUJERO QUE TAPA ──────────────────────────────────────────────────────────────────────────
 * El gate de ATDD (`marker.js complete-step implement` + `lib/atdd-order.js`) lee
 * `marker.fileEvents`, que sólo existe durante una corrida del pipeline. Si el trabajo se hace a
 * mano —sin `tycon-pipeline`— no hay marker, no hay eventos, y el gate no tiene nada que leer.
 * No falla: nunca se lo consulta.
 *
 * Caso que cubre: stories implementadas a mano en la misma sesión. Escribir la implementación y después
 * los tests es el orden que el gate del pipeline bloquea, pero a mano no bloquea nada porque el gate no está
 * en el camino. Sin este control, la única capa de detección es una persona que pregunte por qué no se
 * hicieron los tests primero.
 *
 * ── CÓMO LO TAPA ─────────────────────────────────────────────────────────────────────────────────
 *   1. `recordFileEvent` — `on-edit.js` graba CADA edición por sesión aunque NO haya marker.
 *      Append a un `.jsonl` por sesión: barato, sin lock, sin race entre sesiones.
 *   2. `computeCommitGate` — al commitear se computa el MISMO veredicto que usa el pipeline
 *      (`lib/atdd-order.js`, función pura reusada, no reimplementada) sobre esos eventos.
 *
 * ── POR QUÉ AVISA Y NO BLOQUEA POR DEFAULT ───────────────────────────────────────────────────────
 * Es la misma calibración que el gate del pipeline, un paso más conservadora. Adentro del pipeline,
 * "estoy implementando una story" es un hecho declarado. Afuera, una sesión puede estar tocando
 * código por diez motivos que no son una story (un hotfix, una prueba, este mismo harness), y un
 * gate que bloquea de más termina apagado — que es el peor resultado posible. Así que:
 *
 *   · default `warn`  → avisa y queda medido en `gates.log`.
 *   · `block`         → opt-in del repo (`.tycon/atdd-gate` con la palabra `block`) o env
 *                       `TYCON_ATDD_COMMIT_GATE=block`.
 *   · `off`           → `TYCON_ATDD_COMMIT_GATE=off`.
 *
 * Aun en `warn` el dato queda registrado, así que "cuántos commits se hicieron con los tests
 * después" pasa a ser medible en vez de una impresión — que es lo que permitió detectar esto.
 */

const fs = require('fs');
const path = require('path');
const { isInsideRepo } = require('./path-forms.js');

/** Carpeta de eventos por sesión, bajo el state dir del pipeline. */
function eventsDir(stateDir) {
  return path.join(stateDir, 'file-events');
}

function eventsFile(stateDir, sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(eventsDir(stateDir), `${safe}.jsonl`);
}

/**
 * Registra una edición. Append puro (una línea JSON) — sin read-modify-write, así que dos
 * sesiones concurrentes no se pisan ni necesitan lock.
 */
function recordFileEvent(stateDir, sessionId, filePath, ts = new Date().toISOString()) {
  // El `ts` va como STRING ISO, no epoch: `computeAtddOrder` descarta todo evento cuyo `ts` no
  // sea string (`typeof e.ts === 'string'`), y con la lista vacía devuelve `warn-unknown` — o sea
  // que el gate quedaría siempre mudo sin que nada falle: los eventos se graban bien y el
  // veredicto sale "pass" igual.
  const iso = typeof ts === 'string' ? ts : new Date(ts).toISOString();
  try {
    fs.mkdirSync(eventsDir(stateDir), { recursive: true });
    fs.appendFileSync(eventsFile(stateDir, sessionId), JSON.stringify({ path: filePath, ts: iso }) + '\n', 'utf8');
  } catch { /* nunca romper una edición por no poder registrarla */ }
}

/** Lee los eventos de UNA sesión, en orden. Líneas corruptas se ignoran. */
function readFileEvents(stateDir, sessionId) {
  try {
    return fs.readFileSync(eventsFile(stateDir, sessionId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Borra los eventos de una sesión (post-commit: lo commiteado ya se juzgó). */
function clearFileEvents(stateDir, sessionId) {
  try { fs.unlinkSync(eventsFile(stateDir, sessionId)); } catch { /* no existía */ }
}

/** Eventos de la sesión que caen DENTRO de un repo. */
function eventsForRepo(stateDir, sessionId, repoRoot) {
  return readFileEvents(stateDir, sessionId).filter((e) => isInsideRepo(e.path, repoRoot));
}

/**
 * Descarta los eventos de UN repo y conserva el resto.
 *
 * Una sesión toca varios repos a la vez; borrar el archivo entero al commitear en uno dejaría al
 * siguiente commit —en otro repo— sin evidencia que juzgar.
 */
function pruneFileEvents(stateDir, sessionId, repoRoot) {
  // lo que se limpia es lo mismo que eventsForRepo juzgó
  const keep = readFileEvents(stateDir, sessionId).filter((e) => !isInsideRepo(e.path, repoRoot));
  try {
    const file = eventsFile(stateDir, sessionId);
    if (keep.length === 0) {
      try { fs.unlinkSync(file); } catch { /* si no existe, no hay nada que borrar */ }
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* nunca romper el commit por no poder limpiar */ }
}

/**
 * Resuelve el modo del gate: env > archivo del repo > default.
 * @returns 'off' | 'warn' | 'block'
 */
function modoDeArchivo(repoRoot, relativo) {
  if (!repoRoot) return null;
  let raw = null;
  try { raw = require('./config-source.js').archivoParaFreno(repoRoot, relativo); }
  catch (_e) { raw = null; }
  if (raw === null) return null;
  const t = String(raw).toLowerCase();
  if (t.includes('block')) return 'block';
  if (t.includes('off')) return 'off';
  return null;
}

/**
 * Modo del gate de ATDD ("la prueba antes que el código").
 *
 * 🔴 La escotilla se lee de lo COMMITEADO, no de la carpeta: si se leyera de la carpeta,
 * `echo off > .tycon/atdd-gate` sin commitear apagaría el control, y crear ese archivo
 * tampoco genera evento de implementación (`.tycon` está en NEVER_CODE_SEGMENTS y los archivos sin
 * extensión no están en CODE_EXTS) — o sea que nada lo miraría. Apagar es aflojar: va commiteado.
 */
function resolveMode(repoRoot, env = process.env) {
  const fromEnv = String(env.TYCON_ATDD_COMMIT_GATE || '').toLowerCase();
  if (fromEnv === 'off' || fromEnv === 'warn' || fromEnv === 'block') return fromEnv;
  return modoDeArchivo(repoRoot, '.tycon/atdd-gate') || 'warn';
}

/**
 * Modo del gate de EVIDENCIA DE STORY ("estos criterios de aceptación no están verificados").
 *
 * 🔴 LLAVE PROPIA: si este control heredara el modo del gate de ATDD, **apagar "la prueba antes que el
 * código" apagaría también, de yapa, el aviso de criterios sin verificar**, sin que nada lo diga. Por eso
 * cada control se apaga por su cuenta:
 *
 *   `.tycon/story-evidence-gate` (commiteado) · env `TYCON_STORY_EVIDENCE_GATE`
 */
function resolveEvidenceMode(repoRoot, env = process.env) {
  const fromEnv = String(env.TYCON_STORY_EVIDENCE_GATE || '').toLowerCase();
  if (fromEnv === 'off' || fromEnv === 'warn' || fromEnv === 'block') return fromEnv;
  return modoDeArchivo(repoRoot, '.tycon/story-evidence-gate') || 'warn';
}

/**
 * Decide qué hacer con un veredicto de `computeAtddOrder`.
 * PURA — recibe el veredicto y el modo, devuelve la acción. Es lo que se testea.
 *
 * @param {{verdict: object, mode: 'off'|'warn'|'block'}} args
 * @returns {{action: 'pass'|'warn'|'block', message: string}}
 */
function computeCommitGate({ verdict, mode = 'warn' }) {
  if (mode === 'off') return { action: 'pass', message: '' };
  // El contrato lo define `computeAtddOrder`: 'blocked' | 'green' | 'warn-no-tests' | 'warn-unknown'.
  // Sólo la inversión inequívoca ('blocked') hace algo; el resto pasa — un refactor sobre red
  // preexistente ('warn-no-tests') es legítimo y bloquearlo haría que se apague el gate.
  if (!verdict || verdict.verdict !== 'blocked') return { action: 'pass', message: '' };

  const first = verdict.firstImpl || '?';
  const test = verdict.firstTest || '?';
  const message =
    `ATDD: en esta sesión el código se escribió ANTES que los tests.\n` +
    `  primer código: ${first}\n` +
    `  primer test:   ${test}\n` +
    `Los tests escritos después no pueden fallar por el motivo correcto: ya nacen verdes.\n` +
    `Si el orden fue a propósito, seguí — esto queda registrado, no es un reproche.`;

  return { action: mode === 'block' ? 'block' : 'warn', message };
}

// ── Guía de QA ───────────────────────────────────────────────────────────────────────────────────
// `qa-guide.js` (regla DODRT-C7) genera la guía de prueba manual DERIVADA de los ACs de la story.
// La genera un paso del pipeline; trabajando a mano nadie avisa que existe, y se escribe una guía a mano,
// con otro formato y sin derivarla de los ACs.
//
// El control **avisa**, no la genera solo. Generarla sola es cómodo pero vuelve a esconder que se salió
// del pipeline, que es el problema de fondo.

/** Path de la guía para una story — la carpeta sale de la MISMA regla que usa qa-guide.js (`lib/qa-dir.js`). */
function qaGuidePathFor(storyAbsPath) {
  let id = null;
  try { id = (fs.readFileSync(storyAbsPath, 'utf8').match(/^story:\s*["']?([^"'\s#]+)/m) || [])[1] || null; } catch { /* sin historia legible: sólo el nombre del archivo */ }
  const dir = require('./qa-dir.js').qaDirFor(storyAbsPath, [id]);
  return path.join(dir, path.basename(storyAbsPath, '.md') + '-guia-qa.html');
}

// ── ¿Hay algo que una PERSONA pueda operar a mano? ──────────────────────────────────────────────
// El aviso de arriba no puede dispararse con CUALQUIER story que tenga criterios de aceptación sin
// preguntarse si hay algo que probar a mano. En un paquete cuyo único cliente es un agente —un MCP
// sin una sola pantalla— la guía sale hablando de "usuarios" y "roles" que no
// existen, y lo que de verdad verifica los criterios es un smoke que corre contra el binario
// publicado. Un aviso que pide algo sin sentido es un aviso que se aprende a ignorar, y ahí se lleva
// puestos también a los que sí importan.
//
// 🔴 El corte NO es "¿tiene front?" sino **"¿hay una superficie que una persona pueda manejar?"**.
// Un backend sin pantalla pero con endpoints SÍ se beneficia de una guía con pasos (curl, un cliente
// HTTP); una librería que sólo llama otro programa, no. Por eso la señal incluye la superficie HTTP
// además de la de UI.
//

/** Señales de UI: fuente única lib/ui-signal.js (genérico + evidence.fe_paths
 *  del repo; sin nombres de producto). */
const uiSignal = require('./ui-signal.js');
// Señales de superficie HTTP: algo que se puede ejercer con curl o un cliente, aunque no haya pantalla.
const HTTP_FRONTMATTER_RE = /(Controllers?|Endpoints?|\/api\/|route\.ts|actions\.ts|Api\/)/;
const HTTP_BODY_RE = /\bcurl\b|https?:\/\/localhost|\bGET \/|\bPOST \/|\bendpoint\b/i;

/**
 * ¿La story declara algo que una PERSONA pueda operar a mano (pantalla o superficie HTTP)?
 * `repoRoot` (opcional) habilita los tokens FE declarados en `.tycon/advisors.yaml →
 * evidence.fe_paths`; omitirlo deja solo la señal genérica (compat con callers viejos).
 * Ante la duda **devuelve true**: el default sigue siendo pedir la guía, y sólo se calla
 * cuando no hay ninguna señal — un gate nuevo que se equivoca callándose es peor que uno ruidoso.
 */
function storyIsHandOperable(storyText, repoRoot) {
  if (typeof storyText !== 'string' || storyText.trim() === '') return true;
  if (uiSignal.storyTouchesUi(storyText, repoRoot)) return true;
  const parts = storyText.split(/^---\s*$/m);
  const fm = parts.length >= 3 ? parts[1] : '';
  if (HTTP_FRONTMATTER_RE.test(fm)) return true;
  if (HTTP_BODY_RE.test(storyText)) return true;
  return false;
}

/**
 * Modo de la guía declarado por el repo en `.tycon/advisors.yaml` → `qa_guide: auto|off|always`.
 * Parse mínimo sin dependencias (mismo estilo que `i18nRequired` de pipeline.js). Ausente → 'auto'.
 * Es el escape para repos donde NADA es operable a mano y el aviso es puro ruido — o, al revés, para
 * repos que quieren la guía siempre.
 */
function qaGuideMode(advisorsYamlText) {
  if (typeof advisorsYamlText !== 'string') return 'auto';
  // 🔴 ANCLADO AL PRIMER NIVEL. Un regex que arrancara con `^\s*` ignoraría la indentación:
  // `qa_guide: off` ANIDADO por error dentro de otro bloque (`e2e:`, o un item de lista) apagaría
  // exactamente igual que puesto a propósito en el primer nivel. Un error de tipeo sería indistinguible
  // de una decisión — y el efecto es silencioso: desaparece el aviso de guía de pruebas y un tercio del
  // aviso de evidencia de story, sin que nada diga que se apagó. En YAML `qa_guide` sólo es una llave
  // del documento si está en la columna 0; anidada es una llave de OTRO objeto, y el arnés no la lee de ahí.
  const m = advisorsYamlText.match(/^qa_guide\s*:\s*["']?(auto|off|always)["']?\s*(?:#.*)?$/mi);
  return m ? m[1].toLowerCase() : 'auto';
}

/**
 * Estado de la guía respecto de la story. PURO.
 * `handOperable` (default true) y `mode` ('auto'|'off'|'always') son aditivos: omitirlos preserva
 * el comportamiento anterior exacto.
 * @returns 'ok' | 'missing' | 'stale'
 */
function computeQaGuideStatus({ hasAcs, guideExists, guideOlderThanStory, handOperable = true, mode = 'auto' }) {
  if (mode === 'off') return 'ok';   // el repo declaró que acá la guía no aplica
  if (!hasAcs) return 'ok';          // sin criterios que probar no hay guía que generar
  // `always` fuerza la guía aunque no haya superficie operable a mano.
  if (mode !== 'always' && !handOperable) return 'ok';
  if (!guideExists) return 'missing';
  if (guideOlderThanStory) return 'stale';
  return 'ok';
}

/** Mensaje accionable — dice CÓMO generarla, no sólo que falta. */
function qaGuideMessage(status, { storyPath, guidePath }) {
  if (status === 'ok') return '';
  const qué = status === 'missing'
    ? 'la story tiene criterios de aceptación y NO hay guía de QA generada'
    : 'la guía de QA quedó más vieja que la story (cambiaron los criterios)';
  return (
    `Guía de QA: ${qué}.\n` +
    `  story: ${storyPath}\n` +
    `  guía:  ${guidePath}\n` +
    `Generarla (no la escribas a mano — se deriva de los ACs):\n` +
    `  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/qa-guide.js --story ${storyPath}`
  );
}

module.exports = {
  qaGuidePathFor,
  computeQaGuideStatus,
  qaGuideMessage,
  storyIsHandOperable,
  qaGuideMode,
  eventsDir,
  eventsFile,
  recordFileEvent,
  readFileEvents,
  clearFileEvents,
  eventsForRepo,
  pruneFileEvents,
  resolveMode,
  resolveEvidenceMode,
  computeCommitGate,
};
