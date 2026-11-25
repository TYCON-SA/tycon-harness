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
 *   - No-progreso (una vuelta que no resuelve ninguno de los fallos de la anterior) → escala a humano con el rojo crudo.
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
const MAX_NO_PROGRESS = 1;   // la primera vuelta que no resuelve ningún fallo escala: repetir el mismo intento no aprende nada
// cierres seguidos con la misma medición (nada se volvió a correr) antes de escalar: no cuentan como vueltas, pero tampoco
// dejan al agente cerrar en rojo para siempre
const MAX_SAME_MEASURE = 3;
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');

/**
 * La corrida de un control de esta sesión que todavía está en marcha (`marker.js run-check` toma un candado por control y
 * repo, con la sesión y el proceso del comando), o null. Mientras corre, el resultado anotado es el de la corrida
 * anterior: medirlo cuenta dos veces el mismo rojo. Sin el módulo del candado (un árbol sin el arnés) no se sabe: null.
 */
// Una corrida en marcha sirve para no medir sólo mientras es creíble: pasada una hora, o con su arranque ilegible, se
// mide igual (un candado que nadie suelta no deja cerrar en rojo para siempre).
const RUN_IN_FLIGHT_MAX_MS = 60 * 60 * 1000;
function runInFlight(sessionId, now = Date.now()) {
  let lock;
  try { lock = require(path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'lock.js')); } catch (_) { return null; }
  const dir = path.join(STATE_DIR, 'run-check-locks');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const n of names) {
    const owner = lock.readOwner(path.join(dir, n));
    const e = owner && owner.extra;
    if (!e || e.session !== sessionId || lock.ownerIsDead(owner)) continue;
    const since = Date.parse(e.startedAt);
    if (!Number.isFinite(since) || now - since > RUN_IN_FLIGHT_MAX_MS) continue;
    return { check: e.check || n, since: e.startedAt, key: `${n}@${e.startedAt}` };
  }
  return null;
}

// Lo que se midió: el estado y la hora de cada control, la cantidad de pruebas en rojo y los fallos. Si es igual al de
// la vuelta anterior, nada se volvió a correr: no hay vuelta nueva que juzgar.
const measureOf = (marker, failedNow, failures) => JSON.stringify({ checks: marker.checks || {}, at: marker.checksAt || {}, failed: failedNow, failures });

function markerPath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}
// El pedido de la exención de la matriz para la historia de la corrida, como lo da «Preparar el pull request»: lo corre el
// agente, y el arnés le pone el renglón y el cuadro en la lista del dueño.
function waiverCommand(marker) {
  const raw = marker && marker.storyPath ? String(marker.storyPath) : '<historia>';
  const story = path.isAbsolute(raw) || !marker.repoPath ? raw : path.join(marker.repoPath, raw);
  // marker.js vive al lado de este guion: la ruta sale de acá, sin escribir la carpeta de la herramienta
  const cmd = `node "${path.join(__dirname, 'marker.js')}"`;
  return `${cmd} runtime-waiver ${/\s/.test(story) ? `"${story}"` : story}`;
}

/**
 * La firma que esta sesión ya pidió y que en Windows va sólo a la terminal de la persona: el renglón «solo terminal» de la
 * lista del dueño (owner-window.js `anotarEnWindows`), abierto y para esta sesión. null si no hay, o si la lista no se
 * puede leer: sin saber, el cierre frena como siempre.
 */
function firmaDeTerminalPendiente(sessionId) {
  try {
    const sl = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'signature-list.js'));
    const { filas } = sl.abiertos(os.homedir());
    return filas.find((f) => f && f.tipo === 'firma' && f.windows === 'solo-terminal' && f.destino === sessionId && f.id) || null;
  } catch (_) { return null; }
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

// El contador del freno de la ejecución perdida: un archivo por sesión con la apertura que frenó (@story-8.318). Tope 1:
// frena el primer cierre y deja pasar el segundo seguido. `stop_hook_active` no decide nada: lo pone cualquier gancho de
// Stop. A diferencia de coordination-fill-gate.js, un contador que no se puede leer o anotar frena (lo indecidible frena,
// 8.121 decisión 13): el bucle vuelve, pero no se abre el freno sin saber.
const LOST_DIR = path.join(STATE_DIR, 'lost-run-stop');
const contadorPath = (sid) => path.join(LOST_DIR, `${String(sid || '_nosession').replace(/[^\w.-]/g, '_')}.json`);
const aperturaDe = (p) => (p.desde ? String(p.desde) : `caso:${p.caso}`);
function borrarContador(sid) {
  try { fs.unlinkSync(contadorPath(sid)); } catch (e) {
    if (e && e.code !== 'ENOENT') process.stderr.write(`[tycon-pipeline] no pude borrar el contador de la ejecución perdida (${e.code || e.message})\n`);
  }
}
/** ¿Este cierre ya frenó una vez por la misma apertura? Si sí, borra el contador; si no, lo anota en 1. */
function yaFreno(sid, p) {
  const f = contadorPath(sid);
  let c = null;
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code !== 'ENOENT' && !(e instanceof SyntaxError)) {
      process.stderr.write(`[tycon-pipeline] no pude leer el contador de la ejecución perdida (${e.code || e.message}): frena\n`);
      return false;
    }
  }
  if (c && c.sesion === String(sid) && c.apertura === aperturaDe(p) && Number(c.frenos) >= 1) {
    borrarContador(sid);
    return true;
  }
  try {
    fs.mkdirSync(LOST_DIR, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sesion: String(sid), apertura: aperturaDe(p), frenos: 1, at: new Date().toISOString() }) + '\n', 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    process.stderr.write(`[tycon-pipeline] no pude anotar el contador de la ejecución perdida (${e.code || e.message}): frena igual\n`);
  }
  return false;
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
// Las esperas a main anotadas (marker.js waiting-on-main): una lista por repo; la de un marcador de antes, un objeto.
function esperasMain(marker) {
  const w = marker && marker.waitingOnMain;
  if (Array.isArray(w)) return w.filter((x) => x && typeof x === 'object');
  return w && typeof w === 'object' ? [w] : [];
}
function computeGate(marker) {
  const checks = marker.checks || {};
  const failures = [];
  for (const [name, status] of Object.entries(checks)) {
    // «sin-acotar» (tests): no se corrió nada a propósito y la cubre la CI del pedido; no es un rojo que el agente arregle.
    // «sin-medir» (tests): el portón no sabe correr las pruebas del repo; tampoco lo arregla el agente: lo dicen el
    // cierre de «Correr las pruebas» y el cierre de la historia.
    // «sin-turno» (tests): el portón no corrió porque otra sesión tenía el turno de las ejecuciones grandes; el agente no
    // lo arregla, espera el turno. Lo frenan los cierres de los pasos, no el del turno.
    // «rojo-esperado» (expect-red): un rojo que la historia en deuda deja a propósito; sin la deuda escrita es un rojo.
    const esperado = /^rojo-esperado/.test(String(status)) && !!marker.cierre && marker.cierre.estado === 'deuda';
    // «espera-main» (tests, tests-suite): el rojo del portón es de main (lib/main-check.js) y la espera está anotada en el
    // marcador: el agente no lo arregla, espera a main. Sin la espera anotada es un rojo como cualquiera.
    const esperaMain = (name === 'tests' || name === 'tests-suite') && status === 'espera-main' && esperasMain(marker).length > 0;
    if (status !== 'green' && !esperado && !esperaMain && !(name === 'tests' && ['sin-acotar', 'sin-medir', 'sin-turno'].includes(status))) failures.push(`${name} → ${status}`);
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
 * con otras palabras no la dispara; para ése la red es el freno de orden de «Preparar el pull request».
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

// Cuántas pruebas quedaron en rojo según el resultado que escribe el portón de pruebas, o null si `tests` no está en rojo,
// no hay repo, o el archivo no trae la cantidad (otra herramienta): null hace caer a la regla del rótulo.
function testsFailedCount(marker) {
  const st = marker.checks && marker.checks.tests;
  if (!st || !/^red/.test(String(st)) || !marker.repoPath) return null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(marker.repoPath, '.advisors', 'tests-result.json'), 'utf8'));
    const n = r && r.totals && r.totals.failed;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

function hardEscape() {
  if (process.env.STOP_AUTONOMY === '1') return true;
  try { return fs.existsSync(path.join(STATE_DIR, 'STOP_AUTONOMY')); } catch { return false; }
}

function escalate(sessionId, marker, reason, failures) {
  const fallos = Array.isArray(failures) ? failures : [];
  marker.autonomous = false;       // desactiva el modo → el próximo stop se permite (no trap)
  marker.needs_human = true;
  marker.escalation_reason = reason;
  // la detención entera, con su hora: de ahí salen el cuadro del dueño y la huella que ata su click a esta detención
  marker.escalation = { reason, failures: fallos, iter: marker.iter || 0, at: new Date().toISOString() };
  writeMarker(sessionId, marker);
  // La decisión de seguir le llega al dueño como un pendiente (lib/autonomy-decision.js): el renglón en su lista, con el
  // cuadro que sale de la detención. El botón de pánico no: lo saca una persona a mano. Si la lista no se pudo escribir,
  // el cierre se deja pasar igual, y la decisión queda en la sesión o en la terminal del dueño.
  const ad = require('./lib/autonomy-decision.js');
  const markerJs = path.join(__dirname, 'marker.js');
  const terminal = ad.comandoDeLaTerminal(markerJs, sessionId);
  let decision;
  if (/^hard-escape/.test(String(reason))) decision = ad.textoDelPanico(ad.panico(STATE_DIR, process.env) || 'STOP_AUTONOMY');
  else {
    let anotado;
    try { anotado = ad.anotar({ casa: os.homedir(), sesion: sessionId, marker, cwd: marker.repoPath || process.cwd(), markerJs }); } catch (e) { anotado = { ok: false, motivo: String((e && e.message) || e) }; }
    if (!anotado.ok) require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: marker.repoPath || null, name: 'autonomy-decision', status: 'error', motivo: anotado.motivo });
    decision = ad.textoDelBloqueo({ anotado, terminal });
  }
  // La persona ve el rojo tal como quedó registrado, sin depender de que el agente lo transcriba, y cómo sigue desde su terminal.
  const crudo = `🛑 El modo autónomo se detuvo: ${reason}. Sigue en rojo, tal cual:\n${fallos.map((f) => `  - ${f}`).join('\n')}\n` +
    `Para que siga en autónomo, desde tu terminal: ${terminal}`;
  toPerson = toPerson ? `${toPerson}\n${crudo}` : crudo;
  // Un block de un solo tiro: fuerza a Claude a relayear al humano ANTES de cerrar; como
  // autonomous ya es false, el próximo intento de stop se permite.
  blockStop(
    `🛑 AUTONOMÍA DETENIDA — ${reason}. El loop NO converge.\n` +
    `Fallos residuales:\n${fallos.map((f) => `  - ${f}`).join('\n')}\n\n` +
    `Reportá esto al humano y NO sigas iterando solo — necesita decisión humana.\n${decision}`,
  );
}

function main() {
  let event;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return allowStop(); }

  const sessionId = resolveSessionId(event.session_id);

  // Una ejecución abierta a la que le falta una pieza no deja cerrar el turno (lib/open-runs.js): la salida es del dueño.
  // Frena una vez por turno: el segundo cierre seguido pasa, con el cartel para la persona (@story-8.318). Editar, la
  // consola, el commit y `marker.js clear` siguen frenados hasta la firma.
  {
    const or = require('./lib/open-runs.js');
    let p;
    try { p = or.perdida({ sid: sessionId, cwd: event.cwd || process.cwd() }); } catch (e) {
      p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})`, sesion: String(sessionId) };
    }
    if (!p) { borrarContador(sessionId); }
    else {
      const texto = or.cartel(p);
      if (yaFreno(sessionId, p)) {
        try {
          require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'story-gate', status: 'allowed', kind: 'ejecucion-perdida-espera', story: p.story || null, reason: `el turno se cierra a la segunda con la ejecución perdida (${p.caso}): ${p.falta}` });
        } catch (e) { process.stderr.write(`[tycon-pipeline] no pude anotar la espera de la ejecución perdida (${e.message})\n`); }
        toPerson = `${texto}\nEl turno se cerró a la segunda: la ejecución sigue perdida hasta que una persona firme la salida.`;
        return allowStop();
      }
      return blockStop(texto);
    }
  }

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
  // ningún paso. Es un aviso; el freno es el de «Preparar el pull request».
  try {
    const line = pendingStepsLine(marker, event);
    if (line) toPerson = toPerson ? `${toPerson}\n${line}` : line;
  } catch (e) {
    // el aviso no traba el cierre, pero su falta queda anotada (no es «no había pasos pendientes»)
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'pending-steps-line', status: 'unknown', kind: 'unknown-error', reason: String(e && e.message) }); } catch { /* el registro tampoco traba */ }
  }

  // Lo terminado sin cerrar de esta sesión (lib/finished-open.js): su ejecución con todos los pasos hechos, o su camino
  // corto con el pedido abierto o la rama ya en main. Un aviso a la persona en cada turno, en toda sesión, autónoma o no;
  // nunca frena ni cierra nada. No se junta con la línea de pasos pendientes: ésa sale sólo con pasos pendientes.
  try {
    const lines = require('./lib/finished-open.js').stopLines({ sid: sessionId, stateDir: STATE_DIR });
    if (lines.length) toPerson = toPerson ? `${toPerson}\n${lines.join('\n')}` : lines.join('\n');
  } catch (e) {
    // el aviso no traba el cierre, pero su falta queda anotada (no es «nada terminado sin cerrar»)
    try { require('./lib/story-gate-io.js').appendLog(STATE_DIR, 'gates.log', sessionId, { repoPath: null, name: 'finished-open', status: 'unknown', kind: 'unknown-error', reason: String(e && e.message) }); } catch { /* el registro tampoco traba */ }
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

  const last = Array.isArray(marker.lastFailures) ? marker.lastFailures : [];
  const gate = computeGate(marker);
  if (gate.green) {                     // objetivo cumplido → deja cerrar
    // Un verde cierra el lazo: el próximo rojo es un primer rojo, aunque repita uno de antes.
    if (last.length || marker.noProgressStreak || 'lastTestsFailed' in marker || marker.lastMeasure || marker.sameMeasureStreak || marker.waitedRun) {
      marker.lastFailures = []; marker.noProgressStreak = 0; delete marker.lastTestsFailed;
      delete marker.lastMeasure; delete marker.sameMeasureStreak; delete marker.waitedRun;
      writeMarker(sessionId, marker);
    }
    if ((marker.checks || {}).tests === 'sin-turno') {
      toPerson = [toPerson, 'Las pruebas esperan el turno de la coordinadora: el portón no corrió y falta medirlas.'].filter(Boolean).join('\n');
    }
    const esperas = esperasMain(marker);
    if ((marker.checks || {}).tests === 'espera-main' && esperas.length) {
      const rutas = esperas.flatMap((w) => (Array.isArray(w.suites) ? w.suites : []));
      const suites = rutas.length ? [...new Set(rutas.map((r) => path.basename(String(r))))].join(', ') : 'las suites del registro';
      const ids = [...new Set(esperas.map((w) => w.id).filter(Boolean))].join(', ') || 'sin id';
      toPerson = [toPerson, `main está roto en ${suites}: espero a main (${ids}). No es un rojo de la historia; la historia sigue cuando main pase.`].filter(Boolean).join('\n');
    }
    return allowStop();
  }

  // Rojo, con una firma que la sesión ya pidió y que en Windows va sólo a la terminal de la persona (su renglón «solo
  // terminal» en la lista del dueño): el agente ya preguntó y espera, como con `waitingForHuman`, sin marcarlo a mano. Una
  // vez por renglón: el cierre siguiente con el mismo renglón vuelve a frenar, y la corrida sigue vigilada.
  const pedida = firmaDeTerminalPendiente(sessionId);
  if (pedida && marker.waitedSignature !== pedida.id) {
    marker.waitedSignature = pedida.id;
    writeMarker(sessionId, marker);
    toPerson = [toPerson, `La corrida espera tu firma en la terminal: ${pedida.title || pedida.firma}. Está en tu lista de firmas, con su comando.`].filter(Boolean).join('\n');
    return allowStop();
  }

  // Rojo. Sin vuelta anterior no hay con qué comparar: el primer rojo es el intento, no una vuelta sin progreso.
  // Con vuelta anterior, progresa si al menos un fallo previo desapareció, o si bajó la cantidad de pruebas en rojo
  // (el rótulo de `tests` es sólo el código de salida: arreglar 9 de 10 no lo cambia). Sin cantidad, vale el rótulo.
  const failedNow = testsFailedCount(marker);
  // Una corrida de esta sesión en marcha: lo anotado es el resultado anterior. No se mide ni se cuenta; el turno cierra y
  // el aviso de la corrida que termina lo vuelve a abrir.
  // Una vez por corrida: si el turno se vuelve a cerrar con la misma corrida en marcha, se mide (y una medición igual a la
  // anterior no cuenta, abajo).
  const enCurso = runInFlight(sessionId);
  if (enCurso && marker.waitedRun !== enCurso.key) {
    marker.waitedRun = enCurso.key;
    writeMarker(sessionId, marker);
    toPerson = [toPerson, `El portón no mide: la corrida de «${enCurso.check}» sigue en marcha (desde ${enCurso.since}). Se mide cuando termine.`].filter(Boolean).join('\n');
    return allowStop();
  }
  // La misma medición que la vuelta anterior (nada se volvió a correr): no es una vuelta nueva. No suma al tope ni a las
  // vueltas sin progreso; tres seguidas escalan, para que el rojo no quede sin mirar.
  const medida = measureOf(marker, failedNow, gate.failures);
  if (last.length && marker.lastMeasure === medida) {
    marker.sameMeasureStreak = (marker.sameMeasureStreak || 0) + 1;
    if (marker.sameMeasureStreak >= MAX_SAME_MEASURE) {
      return escalate(sessionId, marker, `${MAX_SAME_MEASURE} cierres seguidos sin volver a correr nada`, gate.failures);
    }
    writeMarker(sessionId, marker);
    return blockStop(
      `⛔ DoD todavía rojo, y es la misma medición que la vuelta anterior: nada se volvió a correr, así que no cuenta como ` +
      `vuelta (iter ${marker.iter || 0}/${CAP}). Arreglá y volvé a correr lo que falla:\n` +
      gate.failures.map((f) => `  - ${f}`).join('\n'),
    );
  }
  marker.lastMeasure = medida;
  marker.sameMeasureStreak = 0;
  const failedBefore = Number.isInteger(marker.lastTestsFailed) ? marker.lastTestsFailed : null;
  const fewerTests = failedNow !== null && failedBefore !== null && failedNow < failedBefore;
  const progressed = last.some((f) => !gate.failures.includes(f)) || fewerTests;
  marker.noProgressStreak = (last.length === 0 || progressed) ? 0 : (marker.noProgressStreak || 0) + 1;
  if (failedNow !== null) marker.lastTestsFailed = failedNow; else delete marker.lastTestsFailed;
  marker.iter = (marker.iter || 0) + 1;
  marker.lastFailures = gate.failures;

  // Frenos.
  if (marker.iter >= CAP) return escalate(sessionId, marker, `cap de ${CAP} iteraciones`, gate.failures);
  if (marker.noProgressStreak >= MAX_NO_PROGRESS) {
    return escalate(sessionId, marker, 'la vuelta no resolvió ninguno de los fallos de la anterior', gate.failures);
  }

  // Hay margen → forzar otra vuelta del loop.
  writeMarker(sessionId, marker);
  // El ÚNICO rojo que el agente no puede poner en verde es la matriz esperando la exención de la persona
  // (marker.js runtime-waiver). Sin esta pista el hook loopearía y el agente descubriría STOP_AUTONOMY por prueba y error.
  // El comando lo corre el agente: así deja el renglón en la lista del dueño, que lo firma con su cuadro (owner-window.js);
  // mandarlo «a su terminal» no deja renglón y la firma se pierde.
  const soloMatriz = gate.failures.length > 0 && gate.failures.every((f) => /^acmatrix\b/.test(f));
  const pista = soloMatriz
    ? '\n  ℹ Si la matriz está roja SÓLO porque hay criterios declarados no verificables esperando la exención ' +
      'de la persona, vos no podés ponerla en verde. Pedila corriendo vos ' +
      `\`${waiverCommand(marker)}\`: deja el renglón en la lista de firmas de la persona, que la aprueba con su cuadro. ` +
      'Para poder cerrar el turno y esperar, corré `marker.js set-flag waitingForHuman true` — deja pasar ESE ' +
      'cierre, no apaga la autonomía, se consume solo y no saltea la matriz: «Preparar» la sigue pidiendo. ' +
      'NO uses `touch STOP_AUTONOMY`: ese archivo frena TODAS las corridas de la máquina ' +
      'y les apaga el portón de DoD hasta que alguien las vuelva a prender a mano.'
    : '';
  blockStop(
    `⛔ DoD todavía rojo (iter ${marker.iter}/${CAP}). NO cierres — arreglá y re-corré:\n` +
    gate.failures.map((f) => `  - ${f}`).join('\n') + pista,
  );
}

try { main(); } catch { allowStop(); }
