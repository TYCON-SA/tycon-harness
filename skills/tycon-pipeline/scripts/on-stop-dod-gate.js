#!/usr/bin/env node
/**
 * tycon-pipeline Stop hook — portón de Definition of Done para el MODO AUTÓNOMO (Nivel 1).
 *
 * Diseño: ~/.claude/tycon-harness/tasks/pipeline-autonomy-design.md.
 *
 * Cuando Claude intenta terminar su turno: si hay un pipeline en modo `autonomous` y el
 * portón DoD NO está verde, BLOQUEA el stop + devuelve los fallos → Claude está obligado a
 * iterar test→fix→re-test hasta verde. Convierte "Claude tiende a parar temprano" en
 * "no puede cerrar mientras esté rojo" — enforcement por código, no disciplina (causa raíz A1).
 *
 * Frenos (sin esto = loop infinito / thrashing):
 *   - CAP de iteraciones → escala a humano.
 *   - No-progreso (mismos fallos N veces) → escala a humano.
 *   - Hard-escape (env STOP_AUTONOMY=1 o archivo STOP_AUTONOMY) → botón de pánico.
 *
 * Scoping: SOLO actúa si `marker.autonomous === true`. Sesión normal / HITL → deja parar al
 * instante. El modo autónomo es opt-in explícito (`/tycon-pipeline implement <story> --autonomous`).
 *
 * Fail-OPEN: cualquier excepción → deja parar. Un bug del hook NUNCA debe atrapar a Claude
 * sin poder terminar (sería el peor foot-gun). Igual que los demás hooks bloqueantes.
 *
 * Contrato de salida (Stop hook Claude Code): sin output + exit 0 → Claude PARA.
 * `{"decision":"block","reason":"..."}` a stdout → Claude NO para, continúa con el reason.
 * (⚠️ Verificar este formato exacto contra el spec de Claude Code al wirear vivo.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // La carpeta del estado, de una sola pieza
const { resolveSessionId } = require('./lib/session-id.js');

const CAP = 6;               // máx iteraciones del loop antes de escalar
const MAX_NO_PROGRESS = 3;   // máx vueltas consecutivas sin resolver ningún fallo
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');

function markerPath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}
function readMarker(sessionId) {
  try { return JSON.parse(fs.readFileSync(markerPath(sessionId), 'utf8')); } catch { return null; }
}
function writeMarker(sessionId, m) {
  try {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
    const p = markerPath(sessionId);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* best-effort */ }
}

// Lo que la persona tiene que ver al cerrar (una historia que quedó en borrador sin validar): va con la salida que toque.
let toPerson = null;
function allowStop() {                                    // sin output → Claude para
  if (toPerson) process.stdout.write(JSON.stringify({ systemMessage: toPerson }) + '\n');
  process.exit(0);
}
function blockStop(reason) {                              // Claude NO para, continúa con `reason`
  process.stdout.write(JSON.stringify({ decision: 'block', reason, ...(toPerson ? { systemMessage: toPerson } : {}) }) + '\n');
  process.exit(0);
}

// Portón. Lee `marker.checks`: { build|tests|advisors|dod: 'green' | 'red:<detalle>' }.
// El pipeline los va poblando durante la corrida (build/tests = exit codes; advisors =
// pipeline.js check-count; dod = evidencia). Acá solo se evalúan.
//
// 🔴 SEMÁNTICA: BLOQUEAR SOLO ANTE UN CHECK REGISTRADO EN ROJO.
// Un check AUSENTE (todavía no medido) NO es rojo → NO bloquea. Razón crítica: el hook Stop
// dispara en CADA fin de turno, incluido cuando Claude PAUSA para preguntarle al humano
// (aprobar el plan, aprobar/waivear los hallazgos). Si tratáramos "sin checks" como rojo, el portón TRABARÍA esos checkpoints HITL legítimos — el peor
// foot-gun (Claude nunca podría pedir aprobación en una corrida autónoma).
//
// El loop test→fix vive en "hay un check que MEDÍ y está rojo → no cierres, arreglá". La
// COMPLETITUD del pipeline ("¿corrió advisors?, ¿hay evidencia DoD?") NO la enforza este
// hook — ya la enforzan `on-pre-commit.js` + `on-frontmatter-write.js` + `pipeline.js
// check-count` al momento del commit / escritura de frontmatter (la capa correcta). Separación
// de responsabilidades: Stop hook = "no pares con algo rojo"; hooks de commit = "no cierres
// sin evidencia completa".
function computeGate(marker) {
  const checks = marker.checks || {};
  const failures = [];
  for (const [name, status] of Object.entries(checks)) {
    // «sin-acotar» (tests): no se corrió nada a propósito y la cubre la CI del pedido; no es un rojo que el agente arregle.
    // «sin-medir» (tests): el portón no sabe correr las pruebas del repo; tampoco lo arregla el agente: lo dicen el
    // cierre de «Correr las pruebas» y el cierre de la historia.
    // «rojo-esperado» (expect-red): un rojo que la historia en deuda deja a propósito; sin la deuda escrita es un rojo.
    const esperado = /^rojo-esperado/.test(String(status)) && !!marker.cierre && marker.cierre.estado === 'deuda';
    if (status !== 'green' && !esperado && !(name === 'tests' && (status === 'sin-acotar' || status === 'sin-medir'))) failures.push(`${name} → ${status}`);
  }
  // Sin checks registrados o todos verdes → green → deja parar (preserva pausas HITL).
  return { green: failures.length === 0, failures };
}

// Un mensaje que da algo por terminado. Con límites de letra y no `\b`: `\b` no ve las tildes («terminé»).
// «lista» no: en castellano casi siempre es el sustantivo («la lista de archivos»).
const CLOSURE = /(^|[^\p{L}])(listo|listos|termin[eé]|terminad[oa]s?|terminamos|cerr[eé]|cerrad[oa]s?|cerramos|commit|commite[eé]|commitead[oa]|hech[oa]s?|done|finished|completed?)(?=$|[^\p{L}])/iu;

/**
 * La línea de pasos pendientes del marcador, o null. Sale sólo si el último mensaje afirma un cierre o el evento no trae
 * mensaje: así aparece cuando el modelo narra que terminó, y no en cada pausa normal del pipeline. Un modelo que narra
 * con otras palabras no la dispara; para ése la red es el freno de orden de «Preparar el commit».
 */
function pendingStepsLine(marker, event) {
  if (!marker || !marker.storyId) return null;
  const S = require('./lib/steps.js');
  const pend = S.pendingSteps(marker).filter((id) => id !== S.CLOSE_STEP.id);
  if (!pend.length) return null;
  const msg = event && typeof event.last_assistant_message === 'string' ? event.last_assistant_message.trim() : '';
  if (msg && !CLOSURE.test(msg)) return null;
  return `⚠️ [tycon-pipeline] la story ${marker.storyId} tiene pasos sin cerrar: ${S.stepNames(pend)}. ` +
    'Lo dicho en el mensaje no cierra ningún paso: cada uno se cierra con su constancia (`pipeline.js next` dice cuál sigue).';
}

function hardEscape() {
  if (process.env.STOP_AUTONOMY === '1') return true;
  try { return fs.existsSync(path.join(STATE_DIR, 'STOP_AUTONOMY')); } catch { return false; }
}

function escalate(sessionId, marker, reason, failures) {
  marker.autonomous = false;       // desactiva el modo → el próximo stop se permite (no trap)
  marker.needs_human = true;
  marker.escalation_reason = reason;
  writeMarker(sessionId, marker);
  // Un block de un solo tiro: fuerza a Claude a relayear al humano ANTES de cerrar; como
  // autonomous ya es false, el próximo intento de stop se permite.
  blockStop(
    `🛑 AUTONOMÍA DETENIDA — ${reason}. El loop NO converge.\n` +
    `Fallos residuales:\n${failures.map((f) => `  - ${f}`).join('\n')}\n\n` +
    `Reportá esto al humano y NO sigas iterando solo — necesita decisión humana.`,
  );
}

function main() {
  let event;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return allowStop(); }

  const sessionId = resolveSessionId(event.session_id);

  // Un borrador de la sesión sin validar: la orden concreta al agente, hasta un tope; después, el aviso a la persona.
  try {
    const r = require('./lib/story-claim-check.js').insistir(event, { stateDir: STATE_DIR, home: os.homedir() });
    if (r && r.aviso) toPerson = r.aviso;
    if (r && r.block) return blockStop(r.block);
  } catch (e) {
    // fail-open: un error acá no traba el cierre, pero queda anotado (no es «no había borradores»)
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'story-claim-check', status: 'unknown', kind: 'unknown-error', reason: String(e && e.message) }); } catch { /* el registro tampoco traba */ }
  }

  const marker = readMarker(sessionId);

  // «Creé la historia» sin la historia escrita: vale para toda sesión que corrió la skill o tiene un marcador, no sólo
  // el modo autónomo. Con la conversación legible decide como siempre; sin ella, con la evidencia del arnés.
  try {
    const { readMark } = require('./lib/story-skill-gate-io.js');
    const io = require('./lib/story-gate-io.js');
    const claim = require('./lib/story-claim-check.js');
    const reason = claim.claimWithoutStory(event, {
      hasMark: !!readMark(STATE_DIR, sessionId), marker, stateDir: STATE_DIR, sessionId,
      log: (r) => io.appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: (marker && marker.repoPath) || null, name: 'story-claim-check', ...r }),
    });
    // la hora de este cierre: el turno siguiente sin conversación sólo cuenta lo editado después
    claim.noteStop(STATE_DIR, sessionId);
    if (reason) return blockStop(reason);
  } catch (e) {
    // fail-open: un error acá no traba el cierre, pero queda anotado (no es «no afirmó nada»)
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'story-claim-check', status: 'unknown', kind: 'unknown-error', reason: String(e && e.message) }); } catch { /* el registro tampoco traba */ }
  }

  // Pasos del pipeline sin cerrar, cuando el mensaje afirma un cierre (o el evento no trae mensaje): lo dicho no cierra
  // ningún paso. Es un aviso; el freno es el de «Preparar el commit».
  try {
    const line = pendingStepsLine(marker, event);
    if (line) toPerson = toPerson ? `${toPerson}\n${line}` : line;
  } catch (e) {
    // el aviso no traba el cierre, pero su falta queda anotada (no es «no había pasos pendientes»)
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'pending-steps-line', status: 'unknown', kind: 'unknown-error', reason: String(e && e.message) }); } catch { /* el registro tampoco traba */ }
  }

  // Scoping: solo el modo autónomo es atrapado por el portón.
  if (!marker || marker.autonomous !== true) return allowStop();

  // EL TERCER ESTADO: "le pregunté al dev y estoy esperando".
  // El portón distingue "podés cerrar" y "no cierres, arreglá"; falta decir esto —
  // pero preguntar ES terminar el turno, así que con cualquier check en rojo el agente no podría
  // hablar. Peor: el único rojo que él NO puede poner en verde es el que necesita la firma del dev
  // (la matriz esperando el waiver), o sea que el agujero estaría justo donde más falta hace.
  // La otra salida sería `STOP_AUTONOMY`, un archivo para TODA la máquina que además apaga
  // el portón de la corrida para siempre. Acá se deja cerrar ESTE turno sin tocar `autonomous`: la
  // corrida sigue vigilada, y en el turno siguiente el portón vuelve a morder si el rojo sigue.
  // De un solo uso: se consume acá, igual que `ALLOW_DOD_EVIDENCE_WRITE`.
  if (marker.waitingForHuman === true) {
    delete marker.waitingForHuman;
    // Con «Hallazgos» abierto, ésta es la espera de una persona: se anota su arranque (una sola vez). Sin pregunta
    // no hay espera que contar.
    try { require('./lib/steps.js').noteFindingsWait(marker, new Date().toISOString()); } catch (_) { /* la medición no frena el cierre */ }
    writeMarker(sessionId, marker);
    return allowStop();
  }

  // Botón de pánico.
  if (hardEscape()) return escalate(sessionId, marker, 'hard-escape (STOP_AUTONOMY)', ['(detenido manualmente)']);

  const gate = computeGate(marker);
  if (gate.green) return allowStop();   // objetivo cumplido → deja cerrar

  // Rojo. ¿Progresó vs la vuelta anterior? (al menos un fallo previo desaparece)
  const last = Array.isArray(marker.lastFailures) ? marker.lastFailures : [];
  const progressed = last.length > 0 && last.some((f) => !gate.failures.includes(f));
  marker.noProgressStreak = progressed ? 0 : (marker.noProgressStreak || 0) + 1;
  marker.iter = (marker.iter || 0) + 1;
  marker.lastFailures = gate.failures;

  // Frenos.
  if (marker.iter >= CAP) return escalate(sessionId, marker, `cap de ${CAP} iteraciones`, gate.failures);
  if (marker.noProgressStreak >= MAX_NO_PROGRESS) {
    return escalate(sessionId, marker, `${MAX_NO_PROGRESS} vueltas sin resolver ningún fallo (thrashing)`, gate.failures);
  }

  // Hay margen → forzar otra vuelta del loop.
  writeMarker(sessionId, marker);
  // El ÚNICO rojo que el agente no puede poner en verde es la matriz
  // esperando el waiver TTY del dev (marker.js runtime-waiver). Sin esta pista el hook loopearía y
  // el agente descubriría STOP_AUTONOMY por prueba y error. Se dice, con la salida al lado.
  const soloMatriz = gate.failures.length > 0 && gate.failures.every((f) => /^acmatrix\b/.test(f));
  const pista = soloMatriz
    ? '\n  ℹ Si la matriz está roja SÓLO porque hay criterios declarados no verificables esperando el waiver ' +
      'del dev (lo aprueba él desde su terminal: marker.js runtime-waiver <story>), vos no podés ponerla ' +
      'en verde: pedile el waiver y, para poder cerrar el turno y esperar su respuesta, corré ' +
      '`marker.js set-flag waitingForHuman true` — deja pasar ESE cierre, no apaga la autonomía y se ' +
      'consume solo. NO uses `touch STOP_AUTONOMY`: ese archivo frena TODAS las corridas de la máquina ' +
      'y les apaga el portón de DoD hasta que alguien las vuelva a prender a mano.'
    : '';
  blockStop(
    `⛔ DoD todavía rojo (iter ${marker.iter}/${CAP}). NO cierres — arreglá y re-corré:\n` +
    gate.failures.map((f) => `  - ${f}`).join('\n') + pista,
  );
}

try { main(); } catch { allowStop(); }
