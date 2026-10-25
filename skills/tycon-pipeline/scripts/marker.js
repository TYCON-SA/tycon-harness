#!/usr/bin/env node
/**
 * tycon-pipeline marker — state CRUD utility.
 *
 * El marker indica "hay una story Mary+GOLD mid-impl bajo tycon-pipeline". Los
 * hooks (`on-prompt.js`, `on-edit.js`) lo consultan para emitir reminders al
 * orquestador (Claude) cuando detectan patrones de bypass.
 *
 * 🔴 Multi-sesión sin carreras: cada sesión de Claude Code tiene su
 * propio archivo `~/.claude/.tycon-pipeline/active/<sessionId>.json` que contiene
 * el marker de esa sesión. Cada sesión lee/escribe SOLO su archivo:
 *   - No colisionan KEYS (cada pipeline su marker).
 *   - No colisionan ESCRITURAS (`on-edit.js` de dos sesiones concurrentes escribe
 *     archivos distintos, así que ninguna pisa el marker de la otra).
 *
 * El sessionId lo resuelve `lib/session-id.js`, que es la ÚNICA copia de esa
 * cadena en el skill (Claude Code → override del banco → Codex → `_nosession`).
 * El contrato un-archivo-por-sesión y la detección de workflows huérfanos
 * `adversarial_is_ours` funcionan igual en las dos herramientas.
 *
 * Estructura de cada archivo `active/<sessionId>.json` (el marker directo):
 *
 *   {
 *     "storyId": "3.3",
 *     "storyPath": "/abs/path/to/specs/stories/3-3-...md",
 *     "repoPath": "/abs/path/to/repo",
 *     "sprint": 3,
 *     "sessionId": "<sessionId>",
 *     "startedAt": "2026-05-17T09:45:11.000Z",
 *     "lastTouch": "2026-05-17T10:06:15.000Z",
 *     "stepsCompleted": [0, 1, 2, 3, 4],
 *     "stepsPending": [5, 6, 7, 8, 9],
 *     "filesTouched": ["/abs/path/file1.ts"]
 *   }
 *
 * Formato legacy: un `active.json` de un solo archivo (sea `{storyId,...}` plano
 * o `{sessionId: marker}`). readMarker() lo lee como respaldo para no perder un
 * pipeline mid-impl; los writes nuevos NUNCA lo tocan.
 *
 * Commands (resuelven el sessionId solos — la firma CLI no cambia):
 *   marker.js set '{"storyId":"...","stepsPending":[...]}'  → escribe el marker de esta sesión
 *   marker.js get          → marker de esta sesión, o `{}`
 *   marker.js touch        → actualiza lastTouch
 *   marker.js complete-step <N>  → mueve step N pending→completed
 *   marker.js append-file <abs-path>  → agrega path a filesTouched (dedup)
 *   marker.js clear        → borra el marker de esta sesión
 *   marker.js is-active    → exit 0 si esta sesión tiene marker, 1 si no
 *
 * Cross-session discovery:
 *   marker.js list-all                          → JSON array con TODOS los markers activos
 *                                                  (todas las sesiones), stale-filtered
 *   marker.js find-by-story <storyId>           → JSON array con markers que matcheen
 *                                                  ese storyId (cualquier sesión)
 *   marker.js clear-session <sessionId>         → borra el marker de OTRA sesión
 *                                                  (recovery / admin); sin marker, lo dice y sale 1
 *   marker.js adhoc clear-orphan <sessionId>    → borra el ad-hoc de OTRA sesión, sólo si no está viva
 *                                                  y lleva más de 24 h sin tocarse
 *   marker.js doing "<qué hago>" | doing clear  → anota (o borra) qué hace esta sesión sin story, para /wip; NO es un
 *                                                  permiso. `doing clear-orphan <sid>`: la de otra sesión que no vive.
 *   marker.js adopt-session <sessionId>         → ADOPTA el marker completo de otra
 *                                                  sesión (resume cross-session sin pérdida:
 *                                                  filesTouched/iterations/checks/dodRuntimeChecked
 *                                                  se copian) y borra el archivo viejo.
 *   marker.js update-story-status <path> <new>  → muta atómicamente el frontmatter
 *                                                  `status:` de una story Mary+GOLD.
 *                                                  Valores: ready-for-dev | in-progress
 *                                                  | review | done | blocked | abandoned.
 *   marker.js update-pipeline-status <path> <tanda|--all> <estado>
 *                                               → muta el `status:` de una tanda (o de todas)
 *                                                  del bloque `pipelines:` de la story.
 *                                                  Valores: done | in-progress | blocked | pending.
 *
 * Ground-truth de checks (cierra el gate fakeable del modo autónomo):
 *   marker.js run-check <name> -- <cmd> [args...] → EJECUTA el comando (proceso hijo, sin
 *                                                  shell/pipes), captura el exit code REAL y
 *                                                  setea marker.checks[name] = green|red:<exit>.
 *                                                  Loguea a ~/.claude/.tycon-pipeline/gates.log
 *                                                  (append-only: ts, cmd, exit, duración).
 *                                                  Exit code = el del comando (gateable).
 *                                                  Con el mismo check ya corriendo en el repo:
 *                                                  no lanza nada y sale 75.
 *   marker.js set-check <name> <status> --manual → override manual (EXIGE --manual;
 *                                                  sin el flag → RECHAZADO exit 2).
 *                                                  Queda provenance='manual' + entry en gates.log.
 *                                                  Para checks mecánicos usá run-check — set-check
 *                                                  --manual es la excepción auditable, no la regla.
 *   marker.js snapshot-iter <N> [--date-at-last-reviewer]
 *                                                → la FOTO del estado auditado de la iteración N.
 *                                                  La toma SOLA el hook al lanzar el último revisor;
 *                                                  si la llamás a mano con código editado después,
 *                                                  se niega (exit 2) o conserva la anterior y lo deja
 *                                                  en gates.log. `--date-at-last-reviewer` produce
 *                                                  el corte correcto cuando ese código YA fue
 *                                                  revisado. Kill-switch: TYCON_SNAPSHOT_GUARD=0.
 *   marker.js promote-probe <probe_dir> --file <x.txt> --a <tests/…>
 *                                                → la prueba con la que el pase adversarial
 *                                                  CONFIRMÓ un hallazgo pasa a la suite del repo
 *                                                  (archivo nuevo, nombre real). Sin esto,
 *                                                  mark-adversarial-result con confirmados exige
 *                                                  --tests k --deferred d --reason "…" (k+d=N,
 *                                                  k = lo promovido acá, no lo declarado).
 *   marker.js set-flag <flag> <true|false>       → las banderas de estado de la ejecución (lib/external-flags.js).
 *                                                  Las de hechos externos (workSignalStarted | adoMarkedActive) NO:
 *                                                  las ponen `pipeline.js work-signal start` y `ado-mark-active`.
 *                                                  `deepReviewDone` NO: el pase adversarial lo cierran
 *                                                  los dos comandos de abajo, con constancia.
 *   marker.js start-warning <time-tracking|ado> "<motivo>" → una parte del Arranque que falló (queda a la vista)
 *   marker.js mark-adversarial-result <N> --type 5b --tests k [--own p --in "<rutas>"]
 *                                   [--deferred d --reason "…"] [--classes k] [--separate n]
 *                                                → anota el resultado del pase y lo CIERRA
 *                                                  (k+p+d=N; p = pruebas escritas a mano, verificadas).
 *   marker.js mark-adversarial-skipped --files <archivos de código del diff>
 *                                                → cierra sin pase, si el PORTÓN lo decide
 *                                                  (deep-review-gate como proceso; con el pase
 *                                                  lanzado sólo con el interruptor = abandono).
 *   `complete-step prepare-commit` bloquea sin una de las dos constancias (freno adversarial-result-gate).
 *   marker.js mark-adversarial-gate '<json>'      → el veredicto del portón en `adversarialGate`.
 *                                                  Lo llaman deep-review-gate y next; no es una constancia.
 *
 * Timing (`pipeline.js timing-report` lo consume):
 *   `complete-step N` guarda marker.stepTimings[N].completedAt automáticamente.
 *   marker.js start-step <N>                     → anota marker.stepTimings[N].startedAt.
 *                                                  No mueve un arranque ya anotado ni arranca un paso
 *                                                  completo. `pipeline.js next` lo hace solo para el paso
 *                                                  que devuelve: sin el arranque, el tiempo muerto antes
 *                                                  de empezar un paso se contaría entero dentro de ese paso.
 *
 * Write atómico tmp+rename. Cada `set` purga archivos de sesiones stale (>24h),
 * advisor-runs/*.jsonl viejos (>7d) y *.tmp huérfanos (>1d).
 */

// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
// Sin `?.` ni `??`: este guion lo tiene que poder leer un Node viejo hasta llegar a la guarda. Misma semántica: sólo null
// y undefined cuentan como «no hay» (0, '' y false se quedan).
const isNil = (v) => v === undefined || v === null;
const nn = (v, d) => (isNil(v) ? d : v);
const at = (o, k) => (isNil(o) ? undefined : o[k]);

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { resolveSessionId } = require('./lib/session-id.js');
// la tabla de los pasos: nombres, orden, equivalencia con el marcador viejo
const STEPS_LIB = require('./lib/steps.js');
const { posixRelative } = require('./lib/path-forms.js');   // rutas relativas al repo con `/`, también en Windows
// la carpeta de Claude Code (la de sus archivos de sesión) la sabe state-dir.js, con el mismo respaldo
const { claudeDir: claudeDirOf } = require('./lib/state-dir.js');

const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const LEGACY_MARKER_PATH = path.join(STATE_DIR, 'active.json');
const STALE_HOURS = 24;

// sessionId de ESTA invocación — Claude Code lo expone a todo subproceso Bash.
const SID = resolveSessionId();

function ensureActiveDir() {
  if (!fs.existsSync(ACTIVE_DIR)) {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Path del archivo de una sesión. Sanitiza separadores por las dudas.
function markerFilePath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}

// Borra archivos de sesiones stale (>STALE_HOURS sin touch) — auto-recovery
// de pipelines huérfanos (sesión cerrada / Claude crasheó).
// Housekeeping: también purga advisor-runs/*.jsonl
// viejos (>7d, si no crecen sin límite) y *.tmp huérfanos (>1d)
// de writes atómicos interrumpidos.
function pruneStale() {
  if (!fs.existsSync(ACTIVE_DIR)) return;
  const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch (_e) { return; }
  for (const f of files) {
    const full = path.join(ACTIVE_DIR, f);
    if (f.endsWith('.tmp')) {
      // tmp huérfano de un write atómico interrumpido — borrar si >1d.
      try {
        if (fs.statSync(full).mtimeMs < Date.now() - 24 * 3600 * 1000) fs.unlinkSync(full);
      } catch (_e) { /* ignore */ }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (m && m.lastTouch && new Date(m.lastTouch).getTime() < cutoff) {
        fs.unlinkSync(full);
      }
    } catch (_e) { /* ignore */ }
  }
  // advisor-runs/*.jsonl > 7 días — check-count solo mira la corrida actual.
  // 🔴 RESUMEN DURABLE ANTES DE BORRAR. Esta poda borra el ÚNICO registro no falsificable de que
  // los revisores corrieron: el voluntario (`gates.log`) sólo se escribe si alguien tipea el comando.
  // Sin un resumen, a los 7 días la pregunta "¿corrieron los revisores de la story X?" queda sin
  // respuesta mecánica para siempre, y el silencio se lee como incumplimiento. Cada archivo deja una
  // línea-resumen en `advisor-runs-summary.jsonl` (repos, stories, advisors y conteos) que no se
  // borra nunca: ~10 KB por semana, menos de 1 MB al año.
  // Si el resumen NO se pudo escribir, el archivo NO se borra — se junta hasta la próxima pasada.
  // Perder unos KB es reversible; borrar la constancia en silencio, no.
  const runsDir = path.join(STATE_DIR, 'advisor-runs');
  if (fs.existsSync(runsDir)) {
    const runCutoff = Date.now() - 7 * 24 * 3600 * 1000;
    let runFiles = [];
    try { runFiles = fs.readdirSync(runsDir); } catch (_e) { runFiles = []; }
    let ledger = null;
    try { ledger = require('./lib/advisor-ledger.js'); } catch (_e) { ledger = null; }
    for (const f of runFiles) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const full = path.join(runsDir, f);
        if (fs.statSync(full).mtimeMs >= runCutoff) continue;
        if (ledger && !ledger.archive(full, f.replace(/\.jsonl$/, ''))) continue;
        fs.unlinkSync(full);
      } catch (_e) { /* ignore */ }
    }
  }
}

// Append-only logs en STATE_DIR — trazabilidad durable de gates y bypasses.
// gates.log: cada run-check/set-check (ts, name, status, cmd, exit, provenance).
// bypass.log: cada DOD_BYPASS / --no-verify detectado (rastro durable, no sólo stderr).
function appendLog(fileName, obj) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    // Namespace por repo: los logs son globales por máquina y
    // los ids cortos de story se repiten entre repos (una "S1" en cada uno) —
    // agrupar por storyId solo mezclaría proyectos en las métricas del retrospective-capturer.
    // Va ANTES de ...obj para que un `repoPath`/`repoRoot` explícito del caller gane.
    let repoPath = null;
    // La ruta de la story también: con un número que se repite en el repo, la constancia de revisores
    // de `gates.log` sólo cuenta para la story cuya ruta trae (on-pre-commit.js §findAdvisorsEvidence).
    let storyPath = null;
    try { const mk = readMarker() || {}; repoPath = mk.repoPath || null; storyPath = mk.storyPath || null; } catch (_e) { repoPath = null; }
    // Sin marker (gate corrido a mano, fuera del pipeline) la línea quedaría sin repo, y las métricas
    // por proyecto no se podrían armar. La raíz de git del
    // directorio actual lo contesta sin adivinar. Es un campo más en el log: no cambia ni un
    // bloqueo ni un veredicto.
    if (!repoPath) {
      try { repoPath = require('./lib/repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { /* sin git */ }
    }
    fs.appendFileSync(
      path.join(STATE_DIR, fileName),
      JSON.stringify({ ts: nowIso(), sessionId: SID, repoPath, ...(storyPath ? { storyPath } : {}), ...obj }) + '\n',
      'utf8',
    );
  } catch (_e) { /* logging nunca rompe el comando */ }
}

// Marker de ESTA sesión. Primero el archivo per-session; si no, fallback al
// legacy single-file (transición — readonly).
function readMarker() {
  const own = markerFilePath(SID);
  if (fs.existsSync(own)) {
    try {
      const m = JSON.parse(fs.readFileSync(own, 'utf8'));
      if (m && m.storyId) return m;
    } catch (_e) { /* ignore */ }
  }
  if (fs.existsSync(LEGACY_MARKER_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_MARKER_PATH, 'utf8').trim();
      if (raw && raw !== '{}') {
        const obj = JSON.parse(raw);
        if (obj && obj.storyId) {
          // legacy plano: pertenece a la sesión sintética `_legacy`.
          return SID === '_legacy' ? obj : null;
        }
        const m = obj && obj[SID];
        if (m && m.storyId) return m;
      }
    } catch (_e) { /* ignore */ }
  }
  return null;
}

function writeMarker(marker) {
  ensureActiveDir();
  pruneStale();
  const p = markerFilePath(SID);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function clearMarker() {
  const own = markerFilePath(SID);
  if (fs.existsSync(own)) {
    try { fs.unlinkSync(own); } catch (_e) { /* ignore */ }
  }
  // Limpiar también de legacy si la entry de esta sesión vivía ahí.
  if (fs.existsSync(LEGACY_MARKER_PATH)) {
    try {
      const obj = JSON.parse(fs.readFileSync(LEGACY_MARKER_PATH, 'utf8'));
      if (obj && !obj.storyId && obj[SID]) {
        delete obj[SID];
        if (Object.keys(obj).length === 0) {
          fs.unlinkSync(LEGACY_MARKER_PATH);
        } else {
          const tmp = `${LEGACY_MARKER_PATH}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
          fs.renameSync(tmp, LEGACY_MARKER_PATH);
        }
      }
    } catch (_e) { /* ignore */ }
  }
}

function cmdSet(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    console.error('marker.js set: invalid JSON payload —', err.message);
    process.exit(2);
  }
  if (!payload.storyId) {
    console.error('marker.js set: payload.storyId requerido');
    process.exit(2);
  }
  // Cómo terminó la ejecución lo escriben `clear` y el camino de la deuda, nunca un `set` a mano: con él, una ejecución
  // abierta quedaría archivada como completa.
  if (Object.prototype.hasOwnProperty.call(payload, 'cierre')) {
    delete payload.cierre;
    console.error('marker.js set: `cierre` no se escribe con set (lo deja `clear`): se descartó.');
    appendLog('bypass.log', { kind: 'MARKER_SET_CIERRE_DISCARDED', storyId: payload.storyId });
  }
  // Pasos por nombre sin `stepScheme` (un `set` a mano para retomar): es el esquema 2.
  if (payload.stepScheme === undefined) {
    const items = [payload.stepsCompleted, payload.stepsPending].filter(Array.isArray).flat().map(String);
    if (items.length && items.every((x) => STEPS_LIB.byId(x))) payload.stepScheme = STEPS_LIB.SCHEME;
  }
  // La aprobación de la maqueta la escriben sólo `complete-step approve-plan` y `approve-mockup`.
  for (const k of ['mockupApproval', 'mockupDecision']) {
    if (payload[k] !== undefined) console.error(`marker.js set: «${k}» no se acepta en el payload (lo escriben sólo complete-step approve-plan y approve-mockup): descartado.`);
  }
  let existing = readMarker();
  const existingBefore = existing;
  // Las banderas de hechos externos tampoco se escriben con set: las pone el arnés cuando hizo el trabajo. Un
  // `get | … | set` que las trae como estaban no cambia nada y pasa.
  {
    const ext = require('./lib/external-flags.js');
    for (const k of [...ext.EXTERNAL_FLAGS, ...Object.keys(OLD_FLAGS)]) {
      if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
      const tenia = existing && existing.storyId === payload.storyId ? existing[k] : undefined;
      if (payload[k] === tenia) continue;
      delete payload[k];
      console.error(`marker.js set: «${k}» no se escribe con set (la pone el arnés: ${ext.HARNESS_COMMAND[nn(OLD_FLAGS[k], k)]}): se descartó.`);
      appendLog('bypass.log', { kind: 'MARKER_SET_EXTERNAL_FLAG_DISCARDED', flag: k, storyId: payload.storyId });
    }
  }
  // 🔴 Anti-leak cross-story: el spread de abajo preserva
  // campos ante un `set` de la MISMA story — pero si esta sesión arranca una story NUEVA sobre un
  // marker viejo sin clear (pipeline cancelado, crash, "listo" antes de «Preparar el commit»), la story B
  // heredaría el ciclo de vida de la A: `deepReviewDone=true` heredado → computeNext saltea el pase adversarial
  // de B EN SILENCIO; `checks.build=green` y `dodRuntimeChecked` heredados → gates mintiendo.
  // Por eso, al cambiar de storyId, los campos de CICLO DE VIDA DE
  // CORRIDA se resetean (la identidad de sesión y el startedAt se conservan).
  if (existing && payload.storyId !== existing.storyId) {
    // Una ejecución que ya avanzó no se reemplaza sin pedirlo: el reinicio borraría sus pasos, sus controles y su
    // pase adversarial sin que nadie lo vea. Con `--replace` se reemplaza; siempre queda la copia del anterior.
    const hechos = Array.isArray(existing.stepsCompleted) ? existing.stepsCompleted.length : 0;
    if (hechos > 0 && !process.argv.includes('--replace')) {
      console.error(`marker.js set: esta sesión tiene la ejecución de la story ${existing.storyId} con ${hechos} paso(s) hecho(s), y el pedido es de la ${payload.storyId}: no la reemplazo.`);
      console.error('  Si la de antes terminó o se abandona: marker.js clear y volvé a pedirlo, o el mismo set con --replace (deja una copia del marcador anterior).');
      process.exit(3);
    }
    const copia = path.join(STATE_DIR, 'replaced', `${SID}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.writeFileSync(copia, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    appendLog('gates.log', { name: 'marker-replace', from: existing.storyId, to: payload.storyId, stepsCompleted: hechos, copy: copia });
    console.error(`marker.js set: la copia del marcador de la ${existing.storyId} quedó en ${copia}`);
    // Otra historia sobre una ejecución que no terminó: la anterior queda dicha como abortada. Sin esto, el reset de
    // abajo la lavaría y un `clear` después la archivaría como completa.
    try {
      const rc = require('./lib/run-close.js');
      // una con `cierre` escrito (la deuda) ya dijo cómo terminó
      if (!existing.cierre && rc.abierta(rc.estado(existing))) {
        const c = rc.cierreDe(existing, { sid: SID });
        appendLog('gates.log', { name: 'run-close', estado: c.estado, story: existing.storyId, motivo: `reemplazada por la historia ${payload.storyId} sin cerrarla: ${c.motivo || ''}`, via: c.via });
        console.error(`marker.js set: la ejecución de ${existing.storyId} no había terminado (${c.motivo}): queda anotada como ${c.estado}.`);
      }
    } catch (e) {
      appendLog('gates.log', { name: 'run-close', estado: 'abortada', story: existing.storyId, motivo: `reemplazada por la historia ${payload.storyId}; no pude calcular su estado (${e.message})` });
    }
    const {
      adversarial, deepReviewDone, workSignalStarted, clockiStarted, adoMarkedActive, atddBypass,
      checks, checksProvenance, dodRuntimeChecked, iterations, fileEvents, filesTouched, filesTouchedAt,
      stepsCompleted, stepsPending, startedAt, evidenceDir, baseSha,
      // el esquema de los pasos y los avisos del Arranque son de la corrida
      stepScheme, startWarnings,
      // Los arranques y fines de paso son de la corrida. Heredarlos le daría a la story
      // nueva arranques de la vieja, y `anotarArranque` se niega a pisar uno existente.
      stepTimings,
      // Lo del pase adversarial es de la corrida. Heredado, B contaría como suyas las pruebas
      // promovidas de A en `--tests`, y con el freno de «Preparar el commit» heredaría el salteo de A y cerraría ese
      // paso sin su propio pase adversarial.
      adversarialPasses, adversarialRegressions, adversarialSkip,
      // El veredicto del portón (y el temprano apagado) son de la corrida: heredado, `next` le pediría a
      // la story nueva lanzar el pase con los archivos de la vieja, o le dejaría apagado el temprano.
      adversarialGate,
      // La maqueta aprobada y la decisión de «Aprobar el plan» son de la story. Heredadas, la story B usaría la
      // maqueta de A (o su «sin pantalla») en «Preparar el commit».
      mockupApproval, mockupDecision,
      // el tamaño de la corrida (y su forzado a mano) es de la story.
      size, size_reason, estimate_min, estimate_source, sizeForced,
      // el modelo y la sesión de Codex son de la corrida: heredados, los revisores de la story nueva correrían con el
      // proveedor de la anterior
      sessionModel, codexSession,
      // las suites que fallaron son de la corrida: heredadas, la primera corrida completa de la story nueva se negaría
      // (76) por suites que sólo rompió la anterior
      testsFailed,
      ...carryOver
    } = existing;
    console.error(
      `marker.js set: story cambia (${existing.storyId} → ${payload.storyId}) — ` +
      `reset de ciclo de vida de corrida (adversarial/deepReviewDone/atddBypass/checks/flags/steps/iterations/fileEvents/sellos de contenido).`
    );
    existing = carryOver;
  }
  // 🔴 Mismo storyId + stepsPending entrante (típico: `pipeline.js start` re-corrido tras PIPE-C0/C5 o
  // tras una compactación): NO reabrir steps ya completados. Sin esto, `start` pisaría stepsPending con
  // [0..8] y el portón de plan volvería a cerrar en medio de la implementación, obligando a re-aprobar el plan.
  if (existing && payload.storyId === existing.storyId && Array.isArray(payload.stepsPending)) {
    const done = new Set((existing.stepsCompleted || []).map(String));
    payload.stepsPending = payload.stepsPending.filter((n) => !done.has(String(n)));
    // ni cerrar los que seguían pendientes: un paso se cierra con `complete-step`, no borrándolo de la lista
    const nuevos = new Set(payload.stepsPending.map(String));
    for (const p of existing.stepsPending || []) if (!nuevos.has(String(p))) payload.stepsPending.push(p);
  }
  // Los controles, el pase y el modo autónomo de la misma historia tienen sus comandos (`run-check`,
  // `mark-adversarial-*`, `set-autonomous`, que el freno de seguridad mira): un `set` no los pisa.
  if (existing && payload.storyId === existing.storyId) {
    for (const k of ['checks', 'checksProvenance', 'autonomous', 'adversarial']) {
      if (payload[k] === undefined) continue;
      delete payload[k];
      console.error(`marker.js set: «${k}» no se cambia con set en la misma historia (tiene su comando): se descartó.`);
      appendLog('bypass.log', { kind: 'MARKER_SET_FIELD_DISCARDED', field: k, storyId: payload.storyId });
    }
  }
  // Marker NUEVO que arranca sin el paso «Aprobar el plan» pendiente ni completado = un pipeline
  // "manual" que se saltea el HITL del plan. No se bloquea (adopt/resume legítimos pasan por acá),
  // pero queda en bypass.log y avisa; el portón de carril no frena código en esta sesión.
  // Dos formas de "saltearse el plan" con un set: un marker NUEVO (o de
  // OTRA story) que arranca sin «Aprobar el plan» pendiente ni completado, y un set de la MISMA story que OMITE ese paso
  // cuando estaba pendiente. Ninguna se bloquea (adopt/resume legítimos), pero las dos quedan en bypass.log.
  if (Array.isArray(payload.stepsPending)) {
    // el plan aprobado es `approve-plan` en un marcador nuevo y su equivalente en uno viejo: lo dice lib/steps.js
    const scheme = payload.stepScheme !== undefined ? payload.stepScheme : (existingBefore && existingBefore.storyId === payload.storyId ? existingBefore.stepScheme : undefined);
    const conPlan = (pend, done) => {
      const m = { stepScheme: scheme, stepsPending: pend || [], stepsCompleted: done || [] };
      return STEPS_LIB.isPending(m, 'approve-plan') || STEPS_LIB.isDone(m, 'approve-plan');
    };
    const sameStory = existingBefore && existingBefore.storyId === payload.storyId;
    const freshWithoutPlan = !sameStory && !conPlan(payload.stepsPending, payload.stepsCompleted);
    const dropsPlan = sameStory && STEPS_LIB.isPending(existingBefore, 'approve-plan')
      && !conPlan(payload.stepsPending, payload.stepsCompleted);
    if (freshWithoutPlan || dropsPlan) {
      appendLog('bypass.log', { kind: dropsPlan ? 'MARKER_DROPS_PLAN' : 'MARKER_SKIPS_PLAN', storyId: payload.storyId, stepsPending: payload.stepsPending, cwd: process.cwd() });
      console.error(`⚠️  marker.js set: el marker queda SIN el paso «Aprobar el plan» ${dropsPlan ? 'que estaba pendiente' : 'desde el arranque'} — el portón de carril`);
      console.error(`    no va a exigir aprobación del plan en esta sesión. Queda en bypass.log (${dropsPlan ? 'MARKER_DROPS_PLAN' : 'MARKER_SKIPS_PLAN'}).`);
      console.error('    Pipeline real → `pipeline.js start` (deja pendientes los pasos que siguen al Arranque). Retomando una ejecución que YA aprobó');
      console.error('    el plan → pasá `stepsCompleted` con los pasos hechos (incluido approve-plan) en el mismo set: así no avisa.');
    }
  }
  const marker = {
    // 🔴 Los campos DESCONOCIDOS del marker existente se PRESERVAN. Con una lista cerrada de campos,
    // todo lo que no estuviera enumerado acá se perdería en silencio: `checks`,
    // `checksProvenance`, `dodRuntimeChecked`, `deepReviewDone`, `workSignalStarted`, `adoMarkedActive`,
    // `autonomous`, `iter`, `noProgressStreak`, `lastFailures`, `stepTimings`… O sea que un `set`
    // mid-pipeline borraría toda la evidencia de verificación (los checks con provenance `run-check`,
    // el gate de DoD) y el pipeline quedaría obligado a re-correr suites enteras — o, peor, tentado a
    // re-poner los greens a mano con `set-check --manual`, que es exactamente lo que la capa
    // anti-green-falso existe para impedir.
    //
    // Así un campo nuevo en el marker no necesita acordarse de sumarlo acá.
    //
    // Es fácil no verlo: `cmdGet` emite el marker COMPLETO, así que el patrón natural
    // `marker.js get | jq '.x = y' | marker.js set` parece seguro. Lo que se preserva evita que un
    // `set` para corregir `storyPath` borre los 3 checks `run-check` y el flag de DoD, y obligue a
    // re-correr build + suite completa.
    ...(existing || {}),
    storyId: payload.storyId,
    storyPath: payload.storyPath || at(existing, 'storyPath') || null,
    repoPath: path.resolve(payload.repoPath || at(existing, 'repoPath') || process.cwd()),
    // Dónde nace la evidencia de cierre: el repo de la STORY, aunque el código viva en
    // otro. Lo escribe `pipeline.js start`; lo leen el paso «Probar en vivo», el macro y `mark-dod-runtime-checked`.
    // 🔴 El spread de arriba preserva lo EXISTENTE, no lo que trae el payload: sin esta línea el
    // campo se pierde en silencio, aunque la prosa prometa un `marker.js get → evidenceDir`. Es estado
    // de corrida: se resetea por story.
    evidenceDir: payload.evidenceDir || at(existing, 'evidenceDir') || null,
    // Commit en el que arrancó la corrida: la base contra la que
    // test-gate.sh mide las «líneas tocadas» (lib/coverage-base.js). Lo anota `pipeline.js start`.
    // Es estado de corrida: el bloque de arriba lo descarta al cambiar de story. Y gana el EXISTENTE:
    // re-correr `start` sobre la misma story (retomar) no puede mover la base al HEAD de ahora, o lo
    // commiteado durante la corrida dejaría de contar como tocado.
    baseSha: at(existing, 'baseSha') || payload.baseSha || null,
    sprint: nn(payload.sprint, nn(at(existing, 'sprint'), null)),
    sessionId: SID,
    startedAt: at(existing, 'startedAt') || nowIso(),
    lastTouch: nowIso(),
    // el esquema lo trae `pipeline.js start` (2: pasos por nombre); un marcador viejo sigue sin él hasta terminar
    ...(payload.stepScheme !== undefined ? { stepScheme: payload.stepScheme } : {}),
    stepsCompleted: payload.stepsCompleted || at(existing, 'stepsCompleted') || [],
    stepsPending: payload.stepsPending || at(existing, 'stepsPending') || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    filesTouched: payload.filesTouched || at(existing, 'filesTouched') || [],
    // Los sellos de contenido (hash + hora por toque, piso de frescura por contenido)
    // viven y mueren con la story: si cambia la story, los de la anterior no valen para ésta.
    filesTouchedAt: (payload.storyId && at(existing, 'storyId') && payload.storyId !== existing.storyId)
      ? (payload.filesTouchedAt || {})
      : (payload.filesTouchedAt || at(existing, 'filesTouchedAt') || {}),
    // Foto de archivos por iteración para los revisores del smart re-loop.
    // Map { "<N>": { ts, filesSnapshot: [abs-paths] } }. Permite computar delta
    // entre iters N y N-1 → pipeline.js smart-reloop decide qué advisors re-correr.
    iterations: payload.iterations || at(existing, 'iterations') || {},
    // fileEvents: un `set`
    // mid-pipeline NO debe borrar los eventos de edición de la iteración — si se
    // pierden, computeSmartReloop elige el path fileEvents con datos truncados y
    // SUPRIME el fallback por mtime (re-ediciones caen del delta en silencio).
    fileEvents: payload.fileEvents || at(existing, 'fileEvents') || [],
    // el tamaño de la corrida y su estimado los anota `pipeline.js start`. Un forzado a mano
    // (`set-size`) gana sobre un `start` re-corrido de la misma story: re-clasificar no deshace una decisión con motivo.
    ...(() => {
      const keep = existing && existing.sizeForced;
      const pick = (k) => (keep && k !== 'estimate_min' && k !== 'estimate_source' ? existing[k] : nn(payload[k], at(existing, k)));
      const out = {};
      for (const k of ['size', 'size_reason', 'estimate_min', 'estimate_source']) if (pick(k) !== undefined) out[k] = pick(k);
      return out;
    })(),
    // el modelo de la sesión y, en Codex, su proveedor: los anota `pipeline.js start` (los usan el registro de revisores y
    // `reviewers-run`)
    ...(payload.sessionModel !== undefined ? { sessionModel: payload.sessionModel } : {}),
    ...(payload.codexSession !== undefined ? { codexSession: payload.codexSession } : {}),
  };
  // Un marcador que no es de ningún esquema (números y nombres mezclados, o un paso que la tabla no conoce) no se
  // escribe: los portones no sabrían si el plan está aprobado.
  if (STEPS_LIB.schemeOf(marker) === null) {
    console.error('marker.js set: el marcador quedaría sin esquema de pasos legible (números y nombres mezclados, o un paso que lib/steps.js no conoce): no se escribe.');
    console.error(`  stepsCompleted=${JSON.stringify(marker.stepsCompleted)} stepsPending=${JSON.stringify(marker.stepsPending)}${marker.stepScheme !== undefined ? ` stepScheme=${marker.stepScheme}` : ''}`);
    process.exit(2);
  }
  // El Arranque arranca cuando nace la corrida. Nadie lo pide con `next` (start lo cierra
  // enseguida); sin esto el Arranque sale siempre «estimado» y toda corrida real «parcial».
  if (STEPS_LIB.isPending(marker, 'start')) {
    const conArranque = anotarArranque(marker, STEPS_LIB.schemeOf(marker) === 2 ? 'start' : '0', marker.startedAt);
    if (conArranque) marker.stepTimings = conArranque.stepTimings;
  }
  writeMarker(marker);
  process.stdout.write(JSON.stringify(marker, null, 2));
}

// Snapshot de los archivos al cierre de la iteración, para el smart re-loop.
// Llamado por el orquestador justo después de invocar el set de advisors de iter N
// (típicamente al final del paso de revisores, en cada vuelta). Idempotente: re-llamar para iter N
// re-toma el snapshot (overwrites). pipeline.js smart-reloop --iter N+1 lo lee
// para computar el delta.
//
// 🔴 NO ES IDEMPOTENTE A CIEGAS — ver `lib/late-snapshot.js` para el caso completo.
// La foto se toma SOLA en el spawn del último revisor. Una segunda llamada «al cierre del step» la
// PISARÍA sin mirar: el arreglo quedaría ADENTRO de la foto, el delta siguiente saldría vacío, y los
// revisores de seguridad y de fallos silenciosos se saltearían «por superficie no tocada».
// Por eso, antes de escribir, se pregunta si hay CÓDIGO con hora posterior al último lanzamiento de
// revisores, y la tabla de decisión de abajo manda. Kill-switch: TYCON_SNAPSHOT_GUARD=0 (y queda la
// segunda capa, el corte de `computeSmartReloop`).
function cmdSnapshotIter(nRaw, flags) {
  const fecharAlUltimo = Array.isArray(flags) && flags.includes('--date-at-last-reviewer');
  const n = parseInt(nRaw, 10);
  if (Number.isNaN(n) || n < 1) {
    console.error('marker.js snapshot-iter: N debe ser entero >= 1');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js snapshot-iter: no hay marker activo para esta sesión');
    process.exit(1);
  }
  marker.iterations = marker.iterations || {};
  // Los probes transitorios del pase adversarial NO entran a la foto: son archivos `__probe*`/`_probe_*`
  // que nadie escribió y se borran solos. Contaminan el insumo del re-loop y hacen parecer sano un
  // registro ciego. Convención de nombres: la guía del paso «Pase adversarial».
  const honesty = require('./lib/ledger-honesty.js');
  const todos = [...(marker.filesTouched || [])];
  const foto = honesty.sinProbes(todos);
  const probesFuera = todos.length - foto.length;

  // ── ¿Se tocó código después del último revisor? ───────────────────────────────────────────────
  // La guarda NUNCA rompe la foto: si no puede correr, el comportamiento es el de siempre y se DICE
  // (un «no medido» que se lee como «ok» es peor que no medir).
  let g = null;
  let motivoSinMedir = null;
  if (require('./lib/legacy-names.js').readEnv('TYCON_SNAPSHOT_GUARD', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '0') {
    motivoSinMedir = 'guarda de foto tardía apagada por el dev (TYCON_SNAPSHOT_GUARD=0)';
  } else {
    try {
      const ft = require('./lib/late-snapshot.js');
      let lineas = [];
      try {
        lineas = fs.readFileSync(path.join(STATE_DIR, 'advisor-runs', `${SID}.jsonl`), 'utf8').split('\n');
      } catch (_e) { lineas = []; }
      g = ft.codigoDespuesDelUltimoRevisor({
        ledgerLineas: lineas, marker, repoRoot: marker.repoPath || null, iter: n,
      });
      if (!g.medible) { motivoSinMedir = g.motivo; g = null; }
    } catch (e) {
      motivoSinMedir = `la guarda de foto tardía no pudo correr: ${e && e.message}`;
      g = null;
    }
  }

  const ft = (() => { try { return require('./lib/late-snapshot.js'); } catch (_e) { return null; } })();
  const nom = g && ft ? ft.nombrados(g.posteriores) : { lista: [], resto: 0, corto: '' };
  const hhmmss = (iso) => (typeof iso === 'string' && iso.length >= 19 ? `${iso.slice(11, 19)} UTC` : String(iso));
  const escribir = (ts) => {
    marker.iterations[String(n)] = {
      ts,
      filesSnapshot: foto,
      ...(probesFuera ? { probes_excluidos: probesFuera } : {}),
    };
    marker.lastTouch = nowIso();
    writeMarker(marker);
  };
  // Constancia AUTOMÁTICA de la iteración en gates.log. El registro por iteración no depende de que el
  // orquestador invoque `check-count` en cada vuelta: un control que hay que acordarse de invocar es
  // un control que no corre. snapshot-iter es el ancla: el orquestador YA
  // lo llama en cada iteración por interés propio (sin snapshot, smart-reloop degrada a
  // force-full, el camino caro). El consumidor (retrospective-capturer) cuenta **iters
  // DISTINTOS** por repoPath+storyId, no líneas: re-snapshotear el mismo N (permitido e
  // idempotente en el marker) escribe otra línea con el mismo `iter`.
  // 🔴 La línea dice ADEMÁS qué se decidió con la foto y si se pudo verificar. Si el orquestador
  // llama a este comando con la salida descartada, lo que no queda en gates.log no pasó.
  const constancia = (extra) => appendLog('gates.log', {
    name: 'advisors-iter',
    storyId: marker.storyId || null,
    iter: n,
    snapshot_size: (marker.iterations[String(n)] || { filesSnapshot: [] }).filesSnapshot.length,
    ...extra,
  });
  const salida = (obj, code) => {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    if (code) process.exit(code);
  };

  // ── Tabla de decisión ─────────────────────────────────────────────────────────────────────────
  // El escape explícito: fechar la foto en el último lanzamiento de revisores. NO es un bypass —
  // produce el corte CORRECTO (todo lo editado después entra al delta por las tres fuentes con
  // hora), por eso va a gates.log y no a bypass.log. No existe un `--force` que escriba «ahora»:
  // sería el defecto con bandera.
  if (fecharAlUltimo) {
    if (!g) {
      console.error(`🛑 marker.js snapshot-iter ${n} --date-at-last-reviewer: no puedo saber cuándo fue el último revisor (${motivoSinMedir}).`);
      console.error('   Sin esa hora, fechar la foto sería inventar un corte. Corré `snapshot-iter N` a secas (queda dicho que no se pudo verificar).');
      constancia({ foto: 'rechazada', verificada: false, motivo: motivoSinMedir });
      process.exit(2);
    }
    escribir(g.ultimoRevisor);
    constancia({
      foto: 'fechada-al-ultimo-revisor',
      verificada: true,
      ultimo_revisor: g.ultimoRevisor,
      posteriores: nom.lista,
      posteriores_total: g.posteriores.length,
    });
    console.error(`foto iter ${n} fechada a las ${hhmmss(g.ultimoRevisor)} (último revisor).`);
    return salida({ iter: n, foto: 'fechada-al-ultimo-revisor', snapshot_size: foto.length, ts: g.ultimoRevisor }, 0);
  }

  if (!g) {
    // No medible (o guarda apagada): se toma la foto como siempre, pero «no medido» ≠ «ok».
    escribir(nowIso());
    constancia({ foto: 'tomada', verificada: false, motivo: motivoSinMedir });
    console.error(`⚠ foto iter ${n} sin verificar: ${motivoSinMedir}`);
    console.error('   (¿retomaste la corrida en otra sesión sin copiar advisor-runs/<sid>.jsonl? La guarda no puede medir.)');
    return salida({
      iter: n, foto: 'tomada', verificada: false, motivo: motivoSinMedir,
      snapshot_size: foto.length, ...(probesFuera ? { probes_excluidos: probesFuera } : {}),
      ts: marker.iterations[String(n)].ts,
    }, 0);
  }

  if (g.posteriores.length === 0) {
    escribir(nowIso());
    constancia({ foto: 'tomada', verificada: true, ultimo_revisor: g.ultimoRevisor });
    return salida({
      iter: n, foto: 'tomada', verificada: true, snapshot_size: foto.length,
      ...(probesFuera ? { probes_excluidos: probesFuera } : {}),
      ts: marker.iterations[String(n)].ts,
    }, 0);
  }

  // Hay código posterior. ¿La foto que ya está es la BUENA (la automática, anterior a esas
  // ediciones)? Entonces no se pisa: el estado queda CORRECTO, así que exit 0 — un
  // `snapshot-iter && smart-reloop` encadenado sigue y usa la foto buena.
  const previaMs = g.fotoPrevia && g.fotoPrevia.ts ? Date.parse(g.fotoPrevia.ts) : NaN;
  const primeraEdicionMs = Math.min(...g.posteriores.map((e) => Date.parse(e.ts)));
  if (Number.isFinite(previaMs) && Number.isFinite(primeraEdicionMs) && previaMs <= primeraEdicionMs) {
    constancia({
      foto: 'conservada',
      verificada: true,
      ultimo_revisor: g.ultimoRevisor,
      foto_previa: g.fotoPrevia.ts,
      posteriores: nom.lista,
      posteriores_total: g.posteriores.length,
    });
    console.error(
      `📸 la foto de la iteración ${n} ya estaba tomada a las ${hhmmss(g.fotoPrevia.ts)} (al lanzar el último revisor) y no se pisa: ` +
      `${g.posteriores.length} archivo(s) de código editados después — ${nom.corto}${nom.resto ? ` y ${nom.resto} más` : ''}.\n` +
      '   Ningún revisor los vio; el re-loop los va a incluir.\n',
    );
    return salida({
      iter: n, foto: 'conservada', verificada: true, ts: g.fotoPrevia.ts,
      snapshot_size: (g.fotoPrevia.filesSnapshot || []).length,
      posteriores: nom.lista.map((e) => e.path),
    }, 0);
  }

  // No hay foto buena que conservar (la automática estaba apagada, la ronda fue informal, o la
  // previa también es posterior a la edición): escribir «ahora» sería escribir la mentira. Se
  // niega, y el próximo re-loop corre el set completo — más caro, nunca menos revisión.
  constancia({
    foto: 'rechazada',
    verificada: true,
    ultimo_revisor: g.ultimoRevisor,
    posteriores: nom.lista,
    posteriores_total: g.posteriores.length,
  });
  console.error(
    `🛑 no tomo la foto de la iteración ${n}: hay código editado después del último revisor ` +
    `(${hhmmss(nom.lista[0] && nom.lista[0].ts)} ${nom.corto}). smart-reloop --iter ${n + 1} va a correr el set completo.\n` +
    `   Si ese código YA fue revisado, fechá la foto en el último lanzamiento:\n` +
    `     marker.js snapshot-iter ${n} --date-at-last-reviewer   (queda en gates.log)\n`,
  );
  return salida({
    iter: n, foto: 'rechazada', verificada: true, ultimo_revisor: g.ultimoRevisor,
    posteriores: nom.lista.map((e) => e.path),
  }, 2);
}

function cmdGet() {
  const marker = readMarker();
  process.stdout.write(JSON.stringify(nn(marker, {}), null, 2));
}

function cmdTouch() {
  const marker = readMarker();
  if (!marker) process.exit(0);
  marker.lastTouch = nowIso();
  writeMarker(marker);
}

// ¿El pase adversarial quedó atendido? Vive en lib/adversarial-verdict.js: `next` lo usa también,
// y una segunda copia del criterio se separa sola.
const { veredictoPaseAdversarial, paseAtendido } = require('./lib/adversarial-verdict.js');

function mensajeDelPaseAdversarial(v) {
  const cmdResultado = `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run ${v.runId || '<runId>'} --model <modelo> --tests <k promovidas> [--own <p> --in "<rutas de prueba>"] [--deferred <d> --reason "<por qué>"]`;
  const cmdSalteo = 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-skipped --files <archivos de código del diff>';
  const e = (s) => console.error(s);
  if (v.motivo === 'registro-ilegible') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — no pude leer el registro de pases adversariales: el campo \`${v.campo}\` del marker no es una lista.`);
    e('  «No lo pude leer» no es «está». Revisá el marker (marker.js get): ese campo lo escriben sólo los comandos del pase.');
    return;
  }
  if (v.motivo === 'lanzamiento-sin-fecha') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el lanzamiento del pase adversarial no tiene fecha legible (\`${v.campo}\` = ${JSON.stringify(v.launchedAt)}).`);
    e('  Sin esa fecha no se puede saber si el resultado anotado es de este lanzamiento. Lo escribe mark-adversarial-launched.');
    return;
  }
  if (v.motivo === 'no-atendido') {
    e('marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial no está atendido: ni lanzado ni salteado por el portón.');
    e('  (la bandera deepReviewDone sola no cuenta: es la que se escribía suelta y dejaba el pase sin constancia)');
    e('  Si el pase corrió, anotá su resultado:');
    e(`    ${cmdResultado}`);
    e('  Si no corre, que lo decida el portón:');
    e(`    ${cmdSalteo}`);
    return;
  }
  const cuando = `${v.runId || 'sin runId'}, ${v.launchedAt}`;
  if (v.motivo === 'pase-no-medido') {
    // El pase corrió pero no revisó todo. Es un pase que falta, no uno «sin hallazgos».
    const { SALIDA_APROBADA } = require('./lib/adversarial-verdict.js');
    const p = v.pase || {};
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial (${cuando}) quedó NO MEDIDO: ${p.motivo_no_medido || 'no revisó todo'}.`);
    if (p.resultado) e(`  El resultado, con el texto de cada hallazgo: ${p.resultado}`);
    e('  Un pase que no revisó todo es un pase que falta. Relanzalo y anotá el resultado nuevo:');
    e('    node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-launched <runId nuevo> 5b --relaunch');
    e('    node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-result <N> --type 5b --result <RUN_DIR>/step-05b-adversarial.json …');
    e(`  Si Codex no contesta y no hay herramienta Workflow: ${SALIDA_APROBADA}.`);
    e('  Abandonarlo lo decide la persona, no el agente: lo dice ella en su mensaje («autorizo TYCON_NO_DEEP_REVIEW»).');
    return;
  }
  if (v.motivo === 'resultado-de-otro-lanzamiento') {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial se relanzó (${cuando}) y el resultado anotado es del lanzamiento anterior.`);
  } else {
    e(`marker.js complete-step prepare-commit BLOQUEADO — el pase adversarial se lanzó (${cuando}) y su resultado no está anotado.`);
  }
  e('  Cada confirmado va a la suite (prueba promovida o prueba propia) o se difiere con motivo:');
  e(`    ${cmdResultado}`);
  e('  Abandonarlo lo decide la persona, no el agente: lo dice ella en su mensaje («autorizo TYCON_NO_DEEP_REVIEW»).');
}

// Cada aprobación que el pipeline ya pide queda en `approvals.jsonl`, en la carpeta de la corrida, como
// manual (una persona con nombre) o automática (un agente o una regla). Si no se puede escribir, AVISA y no frena el
// paso: el registro no agrega interrupciones. Lo agarra el portón de CI en el merge, que exige la
// línea del plan en toda corrida que declara anotar aprobaciones.
const { PLAN_FILE } = require('./lib/plan-display.js');

/**
 * El plan escrito del paso «Armar el plan», en la carpeta de la corrida: `{ file }`, o `{ error }` si la carpeta no se puede
 * calcular (ahí pedir que se escriba el plan mandaría a buscar un archivo que no va a aparecer).
 */
function planDeLaCorrida(marker) {
  try {
    const repo = marker.repoPath || process.cwd();
    const storyAbs = resolveStoryPath(marker.storyPath, marker) || undefined;
    // con la carpeta creada, como anotarAprobacion: si todavía no existe, el mensaje dice dónde va el plan
    const runDir = require('./pipeline.js').resolveRunDir(repo, String(marker.storyId), true, storyAbs);
    return runDir ? { file: path.join(runDir, PLAN_FILE) } : { error: 'la story no da una clave para su carpeta de corrida' };
  } catch (e) { return { error: e.message }; }
}

/**
 * ¿El plan está en lo que el agente le escribió a la persona en esta sesión? La lectura de la conversación vive en
 * lib/person-ok.js (la misma lectura busca el ok de la persona). `{ legible: false, motivo }` cuando la
 * conversación no se encuentra o no se lee —otra herramienta, como Codex, o una sesión sin registro—: quien llama falla
 * cerrado.
 */
function planEnLaConversacion(planTxt, opts = {}) {
  return require('./lib/person-ok.js').planEnLaConversacion(planTxt, opts);
}

/**
 * El bloque del plan para la persona, por la salida normal: lo que un guion manda sólo por la salida de errores el agente
 * no se lo pasa a la persona (medido), y lo que la persona ve son los mensajes del agente.
 */
function planParaLaPersona(planTxt) {
  console.log([
    'Mostrale esto a la persona, en un mensaje tuyo o en la pregunta que le hagas, antes de seguir (el plan entero, tal cual):',
    '',
    planTxt.trim(),
    '',
    'Si creés que ya se lo mostraste: no alcanza, el control no lo encontró en lo que ella ve. Escribilo de nuevo tal cual.',
  ].join('\n'));
}

/**
 * ¿La persona vio el plan? En lo que le escribió el agente, o porque se lo mostró el arnés en pantalla antes de este
 * comando (la constancia `plan-shown` de lib/plan-display.js: la misma sesión, la misma historia y el mismo plan).
 */
function planVisto(marker, planTxt) {
  const visto = planEnLaConversacion(planTxt);
  if (!visto.legible || visto.mostrado) return visto;
  const pd = require('./lib/plan-display.js');
  return pd.mostradoPorElArnes({ stateDir: STATE_DIR, sessionId: SID, storyId: marker.storyId, planTxt }) ? { ...visto, mostrado: true, porElArnes: true } : visto;
}

function anotarAprobacion(marker, entrada) {
  try {
    const approvals = require('./lib/approvals.js');
    const repo = marker.repoPath || process.cwd();
    const storyAbs = resolveStoryPath(marker.storyPath, marker) || undefined;
    const runDir = require('./pipeline.js').resolveRunDir(repo, String(marker.storyId), true, storyAbs);
    if (!runDir) throw new Error('no pude calcular la carpeta de la corrida (clave de la story)');
    let commit = null;
    try {
      commit = require('child_process').execFileSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (_e) { /* repo sin commits: la línea va sin commit */ }
    const linea = approvals.anotar(runDir, { commit, ...entrada });
    appendLog('gates.log', { name: 'approval', status: 'ok', story: marker.storyId, que: linea.que, tipo: linea.tipo, quien: linea.quien });
    return linea;
  } catch (e) {
    appendLog('gates.log', { name: 'approval', status: 'not-recorded', story: marker.storyId, que: entrada && entrada.que, error: String(e.message || e).slice(0, 200) });
    console.error(`⚠️  no pude anotar la aprobación «${entrada && entrada.que}» en approvals.jsonl (${e.message || e}). El paso sigue; el portón de CI la va a pedir en el merge.`);
    return null;
  }
}

/** El tipo y el quién de una aprobación, de las opciones `--approved-by`, `--delegated-by` y `--agent`. */
function quienDeLasOpciones(optVal, extra) {
  return require('./lib/approvals.js').quienDesdeOpciones({
    approvedBy: optVal('--approved-by'), delegatedBy: optVal('--delegated-by'), agent: optVal('--agent'), ...(extra || {}),
  });
}

// Los controles que corren al cerrar cada paso. En un marcador nuevo, por nombre; en uno viejo, por su número de
// entonces. La tabla vive en lib/steps.js, que «Cómo trabaja» también lee para mostrar cada freno en su paso.
const CONTROLES_DEL_PASO = STEPS_LIB.closeControlsByStep();
// El orden del marcador viejo (cadena: 3 ← {1,2} · 4 ← {3} · 5 ← {4} · 8 ← {5}); el nuevo es STEPS_LIB.ORDER_REQUIRES.
const ORDER_REQUIRES_OLD = { 3: ['1', '2'], 4: ['3'], 5: ['4'], 8: ['5'] };

function cmdCompleteStep(nRaw, flags) {
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js complete-step: no hay marker activo para esta sesión');
    process.exit(1);
  }
  // El paso por su nombre de máquina. Con el marcador nuevo un número se niega: con la numeración nueva el mismo
  // número es otro paso, y cerrarlo en silencio sería cerrar el equivocado.
  const resuelto = STEPS_LIB.resolveStepArg(marker, nRaw);
  if (!resuelto.ok) {
    appendLog('gates.log', { name: 'step-arg', status: 'blocked', story: marker.storyId, arg: String(nRaw) });
    console.error(`marker.js complete-step: ${resuelto.message}`);
    process.exit(2);
  }
  const ids = resuelto.ids;
  const nuevo = resuelto.scheme === 2;
  // el paso como lo tipeó el agente, para los mensajes; `paso` es la clave del marcador (la última, si son dos)
  const n = String(nRaw);
  const paso = ids[ids.length - 1];
  const controles = new Set(ids.flatMap((id) => CONTROLES_DEL_PASO[id] || []));
  const opts = Array.isArray(flags) ? flags : [];
  const optVal = (name) => { const i = opts.indexOf(name); return i >= 0 ? nn(opts[i + 1], '') : null; };

  // El aviso de una parte del Arranque que falló sale en el resumen del cierre: queda a la vista hasta el final.
  if (controles.has('commit')) for (const l of STEPS_LIB.startWarningLines(marker)) console.error(`⚠️  ${l}`);

  // Un rojo esperado (`expect-red`) vale sólo en una ejecución en deuda: sin la deuda escrita es un rojo como cualquiera.
  if (controles.has('commit')) {
    const esperados = Object.entries(marker.checks || {}).filter(([, v]) => /^rojo-esperado/.test(String(v)));
    const enDeuda = !!marker.cierre && marker.cierre.estado === 'deuda';
    if (esperados.length && !enDeuda) {
      appendLog('gates.log', { name: 'expected-red', status: 'blocked', story: marker.storyId, checks: esperados.map(([k]) => k) });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${esperados.map(([k, v]) => `${k}=${v}`).join(', ')} sin una ejecución en deuda.`);
      console.error('  Un rojo esperado vale sólo con la historia cerrada como deuda (marker.js close-as-debt, con la frase de la persona).');
      process.exit(1);
    }
    for (const [k, v] of esperados) {
      appendLog('gates.log', { name: 'expected-red', status: 'accepted', story: marker.storyId, check: k, deuda: marker.cierre.deuda });
      console.error(`⚠️  ${k}: ${v} — aceptado por la deuda ${marker.cierre.deuda} (${((marker.expectedRed || {})[k] || {}).tests || []})`);
    }
    // la deuda llega al commit: la línea exacta que lleva el mensaje
    if (enDeuda) console.error(`📌 El mensaje de commit lleva esta línea: Deuda: ${marker.cierre.deuda} — ${marker.cierre.motivo}`);
  }

  // ── ORDEN — no se cierra un paso con su predecesor GATEADO todavía pendiente ────────
  // Frena el patrón "empieza el pipeline, toma confianza y se saltea etapas".
  // Sólo se exige contra los pasos que tienen control real: exigir «todo lo anterior» volvería rutina el --out-of-order.
  // Se mira stepsPending (no stepsCompleted): un marker manual/adoptado con pending parcial no traba.
  const pendingNow = (marker.stepsPending || []).map(String);
  const requeridos = nuevo ? (STEPS_LIB.ORDER_REQUIRES[paso] || []) : ids.flatMap((id) => ORDER_REQUIRES_OLD[id] || []);
  const missing = requeridos.filter((k) => pendingNow.includes(k));
  if (missing.length) {
    if (opts.includes('--out-of-order')) {
      appendLog('bypass.log', { kind: 'STEP_OUT_OF_ORDER', storyId: marker.storyId, step: n, pendingBefore: missing });
      console.error(`⚠️  complete-step ${n} con step(s) ${missing.join(',')} pendientes — --out-of-order (queda en bypass.log).`);
    } else {
      appendLog('gates.log', { name: 'step-order', status: 'blocked', story: marker.storyId, step: n, pendingBefore: missing });
      console.error(`marker.js complete-step ${n} BLOQUEADO — step(s) ${missing.join(', ')} todavía pendiente(s).`);
      console.error('  El pipeline se recorre EN ORDEN: `pipeline.js next` te dice cuál va. Cerrá ese primero (con su evidencia).');
      console.error('  Escape consciente (raro — p.ej. retomando una corrida que ya los hizo): --out-of-order (queda en bypass.log).');
      process.exit(1);
    }
  }

  // ── «Aprobar el plan» — la aprobación es del USER y queda citada ──────────────────────────
  // `--approved "<cita>"` (HITL) o `--auto-approved "<criterios>"` (Nivel 2, SOLO LOW-risk — se verifica
  // con risk-class, no se declara). Sin esto, cerrar el 3 sería un comando vacío y el
  // portón de carril (código antes del plan) se abría sin que nadie hubiera aprobado nada.
  let planParaMostrar = null;
  if (controles.has('plan')) {
    const approved = optVal('--approved');
    const auto = optVal('--auto-approved');
    if (!approved && !auto) {
      console.error(`marker.js complete-step ${n} BLOQUEADO — falta la aprobación del plan.`);
      console.error(`  HITL:     marker.js complete-step ${n} --approved "<cita textual de la aprobación del user>"`);
      console.error(`  Nivel 2:  marker.js complete-step ${n} --auto-approved "<criterios LOW-risk>"  (sólo si risk-class = LOW)`);
      console.error(`  No se aprueba el plan sin decir QUIÉN aprobó. Ver steps/${STEPS_LIB.byId('approve-plan').file}.`);
      process.exit(1);
    }
    // ── En una story con pantalla, la maqueta y su aprobación (también con LOW) ──
    // La detección es la de la revisión de la pantalla (mockup.screenStory, raíz del repo de la STORY), no la de
    // markerStoryIsUi. «No pude leer la story» frena: nunca es «sin pantalla». Nada se escribe hasta el final.
    const mockupCita = optVal('--mockup-approved');
    const mk = require('./mockup.js');
    const bloquear3 = (motivo, extra = []) => {
      appendLog('gates.log', { name: 'mockup-approval', status: 'blocked', story: marker.storyId, motivo });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${motivo}`);
      for (const l of extra) console.error(`  ${l}`);
      process.exit(1);
    };
    if (!marker.storyPath) bloquear3('el marcador no tiene la ruta de la story: `marker.js set` con `storyPath`');
    let sc;
    try { sc = mk.screenStory(resolveStoryPath(marker.storyPath, marker) || marker.storyPath); } catch (e) {
      bloquear3(`no pude leer la story (${marker.storyPath}: ${e.code || e.message}): no pude saber si tiene pantalla, y con pantalla lleva maqueta.`);
    }
    let mockupPlan = null;
    if (sc.screen) {
      let p;
      try { p = mk.mockupPaths(sc.story); } catch (e) { bloquear3(`no pude calcular la clave de la story (${e.message}): no pude saber dónde va su maqueta.`); }
      let html = null;
      try { html = fs.readFileSync(p.mockup, 'utf8'); } catch (_e) {
        bloquear3(`story con pantalla: falta su maqueta (${p.mockup}).`, [
          `Armala: node ${path.join(__dirname, 'mockup.js')} render --data <modelo.json> --story ${sc.story}   (la forma: mockup.js schema)`,
          'Mostrásela al dueño con el plan (la ruta y la lista de mockup.js texts) y cerrá con --mockup-approved "<cita>". Ver la guía del paso «Aprobar el plan».',
        ]);
      }
      const v = mk.validateMockupHtml(html);
      if (!v.ok) bloquear3(`la maqueta no pasa mockup.js check (${p.mockup}):`, v.findings.map((x) => `- ${x.line ? `línea ${x.line}: ` : ''}${x.what}`));
      if (!mockupCita) {
        bloquear3(auto && !approved
          ? 'el plan se aprueba solo; la maqueta no: una pantalla la ve una persona antes (decisión 8).'
          : `story con pantalla: mostrale la maqueta (${p.mockup}) y pasá su aprobación con --mockup-approved`, [
          `Mostrale la maqueta (${p.mockup}) al dueño —o a quien tenga su delegación— y cerrá con --mockup-approved "<cita: quién aprobó y por qué vía>".`,
        ]);
      }
      mockupPlan = { p, sha: mk.mockupHash(html) };
    }
    if (auto && !approved) {
      let rc = null;
      try {
        const { computeRiskClass } = require('./pipeline.js');
        rc = computeRiskClass({ story: resolveStoryPath(marker.storyPath, marker) });
      } catch (e) { rc = { risk: 'NORMAL', error: e.message }; }
      if (!rc || rc.risk !== 'LOW') {
        appendLog('gates.log', { name: 'plan-auto-approve', status: 'blocked', story: marker.storyId, risk: rc && rc.risk, error: rc && rc.error });
        console.error(`marker.js complete-step ${n} BLOQUEADO — --auto-approved pero risk-class = ${(rc && rc.risk) || '?'}${rc && rc.error ? ` (${rc.error})` : ''}.`);
        console.error('  La auto-aprobación Nivel 2 es SOLO para stories LOW-risk. Esta necesita aprobación del user:');
        console.error(`    marker.js complete-step ${n} --approved "<cita textual>"`);
        process.exit(1);
      }
      // Aprobado solo no es aprobado a escondidas: el plan tiene que estar escrito y la persona lo tiene que haber visto
      // en la respuesta del agente. Imprimirlo no alcanzó (medido: el agente siguió sin mostrarlo),
      // así que se lee la conversación; si no se puede leer, falla cerrado y se le pregunta a la persona.
      const plan = planDeLaCorrida(marker);
      if (plan.error) {
        appendLog('gates.log', { name: 'plan-auto-approve', status: 'blocked', story: marker.storyId, motivo: 'sin carpeta de corrida' });
        console.error(`marker.js complete-step ${n} BLOQUEADO — el plan se aprueba solo, pero se muestra igual, y no pude calcular la carpeta de la corrida donde va (${plan.error}).`);
        console.error('  Revisá la story del marcador (storyId y storyPath) o aprobá el plan con --approved "<cita>".');
        process.exit(1);
      }
      let planTxt = '';
      try { planTxt = fs.readFileSync(plan.file, 'utf8'); } catch (_e) { /* falta: se dice abajo */ }
      if (!planTxt.trim()) {
        appendLog('gates.log', { name: 'plan-auto-approve', status: 'blocked', story: marker.storyId, motivo: 'plan sin escribir' });
        console.error(`marker.js complete-step ${n} BLOQUEADO — el plan se aprueba solo, pero se muestra igual: falta escribirlo en ${plan.file}.`);
        console.error('  Escribí ahí el plan del paso «Armar el plan», mostráselo a la persona en tu respuesta y volvé a correr este comando.');
        process.exit(1);
      }
      const visto = planVisto(marker, planTxt);
      if (!visto.legible || !visto.mostrado) {
        appendLog('gates.log', { name: 'plan-auto-approve', status: 'blocked', story: marker.storyId, motivo: visto.legible ? 'plan sin mostrar' : 'conversación ilegible' });
        // lo que la persona ve son tus mensajes de texto; la salida de un comando, un archivo o tu razonamiento, no
        // (medido: el agente creyó haberlo mostrado porque el plan estaba en esos lugares)
        const queVe = '  La persona sólo ve tus mensajes de texto (y lo que trae una pregunta con opciones): no ve la salida de este comando, ni el archivo del plan, ni lo que pensaste.';
        if (visto.legible) {
          console.error(`marker.js complete-step ${n} BLOQUEADO — el plan se aprueba solo, pero la persona tiene que verlo: ninguno de tus mensajes de texto lo trae.`);
          console.error(queVe);
          console.error('  Escribí ahora un mensaje con el plan TAL CUAL (éste, entero, no un resumen) y después volvé a correr este comando:');
        } else {
          console.error(`marker.js complete-step ${n} BLOQUEADO — no puedo leer la conversación de esta sesión (${visto.motivo}), así que no sé si la persona vio el plan: no se aprueba solo.`);
          console.error(queVe);
          console.error('  Escribí un mensaje con el plan TAL CUAL (éste, entero, no un resumen), preguntale si lo aprueba y cerrá con --approved "<su respuesta>":');
        }
        console.error(`\n${planTxt.trim()}\n`);
        planParaLaPersona(planTxt);
        process.exit(1);
      }
      planParaMostrar = planTxt.trim();
    }
    // Con riesgo bajo el plan queda escrito en la corrida: un ok a una pregunta que no lo traía no aprueba (medido: el
    // agente preguntó «¿lo apruebo?» a secas y la persona aprobó sin verlo). Sin conversación legible no hay cómo saber:
    // la cita alcanza, como antes. Con riesgo normal no cambia.
    if (approved) {
      const plan = planDeLaCorrida(marker);
      let planTxt = '';
      if (!plan.error) {
        try { planTxt = fs.readFileSync(plan.file, 'utf8'); } catch (e) {
          // sin plan escrito no hay qué comparar: la cita alcanza, como antes; una lectura que falla por otra cosa queda anotada
          if (e.code !== 'ENOENT') appendLog('gates.log', { name: 'plan-approval', status: 'skipped', story: marker.storyId, motivo: 'no pude leer el plan', error: String(e.code || e.message).slice(0, 200) });
        }
      }
      const visto = planTxt.trim() ? planVisto(marker, planTxt) : null;
      if (visto && visto.legible && !visto.mostrado) {
        let rc = null;
        try { rc = require('./pipeline.js').computeRiskClass({ story: resolveStoryPath(marker.storyPath, marker) }); } catch (e) { rc = { error: e.message }; }
        if (!rc || !rc.risk || rc.error) {
          // sin el riesgo no se sabe si este control aplica: no frena, pero queda anotado y se dice
          appendLog('gates.log', { name: 'plan-approval', status: 'skipped', story: marker.storyId, motivo: 'no pude calcular el riesgo', error: String((rc && rc.error) || 'sin riesgo').slice(0, 200) });
          console.error(`⚠️  no pude calcular el riesgo de la story (${(rc && rc.error) || 'sin riesgo'}): no comprobé que la persona haya visto el plan.`);
        }
        if (rc && rc.risk === 'LOW') {
          appendLog('gates.log', { name: 'plan-approval', status: 'blocked', story: marker.storyId, motivo: 'ok sin plan a la vista' });
          console.error(`marker.js complete-step ${n} BLOQUEADO — la persona aprobó sin ver el plan: ninguno de tus mensajes ni tus preguntas lo trae.`);
          console.error('  Mostráselo entero (en un mensaje o dentro de la pregunta), preguntale de nuevo y cerrá con --approved "<su respuesta>".');
          planParaLaPersona(planTxt);
          process.exit(1);
        }
      }
    }
    const at3 = nowIso();
    if (mockupPlan) {
      // El archivo de aprobación viaja con la story (va en el commit); la cita queda sólo en el marcador.
      try {
        mk.writeApproval({ approvalPath: mockupPlan.p.approval, mockupPath: mockupPlan.p.mockup, story: marker.storyId, sha256: mockupPlan.sha, approvedAt: at3 });
      } catch (e) { bloquear3(`no pude escribir la aprobación de la maqueta (${mockupPlan.p.approval}): ${e.code || e.message}`); }
    }
    marker.planApproval = { mode: approved ? 'user' : 'auto-low-risk', text: approved || auto, at: at3 };
    appendLog('gates.log', { name: 'plan-approval', status: 'ok', story: marker.storyId, mode: marker.planApproval.mode, text: marker.planApproval.text });
    // `--approved` sin `--approved-by` ni `--delegated-by` queda automática «sin nombrar»; `--auto-approved`
    // es la regla de riesgo bajo. La maqueta la aprueba quien aprobó el plan, en el mismo comando.
    const quienPlan = approved ? quienDeLasOpciones(optVal) : quienDeLasOpciones(() => null, { regla: 'risk-class LOW' });
    anotarAprobacion(marker, { que: 'plan', cuando: at3, via: `complete-step ${n} ${approved ? '--approved' : '--auto-approved'}`, ...quienPlan });
    if (mockupPlan) {
      anotarAprobacion(marker, { que: 'maqueta', cuando: at3, via: `complete-step ${n} --mockup-approved`, ...quienDeLasOpciones(optVal) });
    }
    // La decisión se anota SIEMPRE, para que «Preparar el commit» vea una pantalla que apareció después del plan.
    marker.mockupDecision = { screen: sc.screen, signal: sc.signal || null, at: at3 };
    if (mockupPlan) {
      marker.mockupApproval = { file: mockupPlan.p.mockup, sha256: mockupPlan.sha, mode: 'user', text: mockupCita, at: at3 };
      appendLog('gates.log', { name: 'mockup-approval', status: 'ok', story: marker.storyId, sha256: mockupPlan.sha.slice(0, 12), reapproval: false });
    } else {
      if (mockupCita) console.error('ℹ️  la story no tiene pantalla: no hay maqueta que aprobar (--mockup-approved no se usa).');
      // La baja de pantalla por prosa (7.18), con la raíz del repo de la story: la misma detección que decidió acá.
      const linea = require(path.join(__dirname, 'lib', 'ui-signal.js')).proseDropNotice(sc.detail);
      if (linea) console.error(linea);
    }
  }

  // ── Revisores (advisors) — el set esperado corrió DE VERDAD, y en ESTA iteración ──────────────────
  // `checks.advisors` lo pone `run-check advisors -- pipeline.js check-count …` (ground-truth del log
  // de spawns, CF-2). Sin esto, cerrar el 5 no exigía nada y el Stop-gate sólo mira checks REGISTRADOS
  // en rojo (ausente = pasa). Se rechaza `trust-ran` (self-report) y el green de una iteración
  // anterior: al re-cerrar el 5 tras fixes (loop D.i) el check tiene que ser posterior
  // al cierre previo del 5. Declararlo a mano (`--force-manual`) lo decide la persona: lo frena ESC-C3 sin su frase.
  if (controles.has('advisors')) {
    const st = marker.checks && marker.checks.advisors;
    const prov = (marker.checksProvenance && marker.checksProvenance.advisors) || null;
    const at = (marker.checksAt && marker.checksAt.advisors) || null;
    const tPaso = marker.stepTimings && marker.stepTimings[paso];
    const prevClose = tPaso && (tPaso.lastCompletedAt || tPaso.completedAt);
    const okProv = prov === 'run-check' || prov === 'manual-forced';
    const fresh = !prevClose || (at && new Date(at).getTime() > new Date(prevClose).getTime());
    if (st !== 'green' || !okProv || !fresh) {
      appendLog('gates.log', { name: 'advisors-complete', status: 'blocked', story: marker.storyId, checks_advisors: st || '(ausente)', provenance: prov || '(ausente)', fresh });
      console.error(`marker.js complete-step ${n} BLOQUEADO — el check \`advisors\` no está en verde por conteo real`
        + (st === 'green' && !fresh ? ' de ESTA vuelta' : '') + '.');
      console.error(`  Estado: checks.advisors=${st || '(ausente)'} provenance=${prov || '(ausente)'}${prevClose ? ` · cierre previo de los revisores: ${prevClose}` : ''}`);
      console.error('  Registralo con el exit code REAL de check-count (lee el log de spawns, no tu --ran):');
      console.error('    marker.js run-check advisors -- node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js check-count \\');
      console.error('      --repo <repo> --story <story_path> --files <archivos modificados…>');
      console.error('  Set esperado vacío (mech-check sin advisors aplicables): check-count sale 0 con el expected:[] persistido.');
      console.error('  Una lista de revisores dada por vos (provenance trust-ran = self-report) NO alcanza. Declarar el control');
      console.error('  a mano lo decide la persona, no el agente: si quiere, lo dice en su mensaje («autorizo force-manual»).');
      process.exit(1);
    }
  }

  // ── Implementar — freno ATDD: los tests se escriben ANTES del código ───────────────
  // Sin gate mecánico el ATDD es la regla que se saltea.
  // La evidencia NO es nueva: `marker.fileEvents` ya registra cada edición con `{path, ts}`. Detalle del calibrado (qué bloquea y qué sólo avisa, para no dar falsos
  // positivos con un refactor legítimo): `lib/atdd-order.js`.
  if (controles.has('atdd')) {
    const { computeAtddOrder, atddBlockMessage } = require('./lib/atdd-order.js');
    // 🔴 Stories de dos repos: el código vive en un repo hermano declarado
    //    (`evidence.companion_repos`). Si se mira sólo el repo de la story, toda edición del hermano queda
    //    afuera y el portón dice «ningún fileEvent cae dentro del repo de la story»: no gatea nada. Cuentan también los hermanos.
    let raices = marker.repoPath;
    let hermanosError = null;
    if (marker.repoPath) {
      try {
        const companionLib = require('./lib/companion-repos.js');
        const storyAbs = marker.storyPath ? path.resolve(marker.repoPath, marker.storyPath) : null;
        const faltan = [];
        raices = [marker.repoPath, ...companionLib.companionRoots(marker.repoPath, storyAbs, { onMissing: (nombre) => faltan.push(nombre) })];
        if (faltan.length) hermanosError = `declarados y no están en disco: ${faltan.join(', ')}`;
      } catch (e) { hermanosError = e.message; }
    }
    const r = computeAtddOrder(marker.fileEvents, raices);
    if (hermanosError) {
      r.reason = `${r.reason} (repos hermanos: ${hermanosError}; esos no se miraron)`;
      console.error(`⚠️  freno ATDD: repos hermanos — ${hermanosError}; esos no se miraron.`);
    }
    // El flag `atddBypass` (el escape que dicta el portón pre-edit) vale también acá: un solo
    // bypass declarado cubre la corrida entera — obligar a declararlo dos veces con dos nombres
    // distintos dejaría al dev contra una segunda pared, y contradiría el texto del propio mensaje de bloqueo.
    const bypass = opts.includes('--no-atdd') || marker.atddBypass === true;
    appendLog('gates.log', {
      name: 'atdd',
      status: r.verdict,
      story: marker.storyId,
      firstTest: r.firstTest,
      firstImpl: r.firstImpl,
      reason: r.reason,
      bypassed: bypass || undefined,
    });
    if (r.verdict === 'blocked' && !bypass) {
      console.error(atddBlockMessage(r));
      process.exit(1);
    }
    if (r.verdict === 'blocked' && bypass) {
      // El bypass NO es silencioso: queda en bypass.log con el detalle, igual que DOD_BYPASS.
      appendLog('bypass.log', { kind: 'ATDD_BYPASS', story: marker.storyId, firstTest: r.firstTest, firstImpl: r.firstImpl });
      console.error('⚠️  ATDD saltado con --no-atdd (queda en bypass.log).');
      console.error(`   código primero: ${r.firstImpl} · test después: ${r.firstTest}`);
    }
    if (r.verdict === 'warn-no-tests' || r.verdict === 'warn-unknown') {
      // Avisa y sigue — pero queda medido en gates.log, así que "cuántas corridas hicieron ATDD de
      // verdad" pasa a tener respuesta en vez de impresión.
      console.error(`⚠️  ATDD: ${r.reason}`);
    }
  }

  // ── Correr las pruebas — la suite completa, «sin acotar», «sin medir» y los mutantes ─────────
  if (controles.has('tests')) {
    // ── El verde de `tests` tiene que salir de la suite COMPLETA ──────────────────────────────
    // Con sólo los tests que una story declara, el check puede quedar verde mientras la
    // suite entera está en rojo (por ejemplo, 872 tests verdes y 13 fallas en una suite de 2400,
    // dos de ellas de la propia story). La diferencia entre "los tests que la story declara" y "todos"
    // es exactamente donde se esconden las fallas.
    //
    // Se acepta `test-gate` (el gate corrió la suite entera y capturó el exit code real) y
    // `manual-forced` (declarado a mano y logueado; lo decide la persona: ESC-C3 frena `--force-manual` sin su frase).
    // Se RECHAZA `run-check` a secas y `manual`: son verdes parciales o auto-declarados.
    const testsCheck = marker.checks && marker.checks.tests;
    const testsProv = (marker.checksProvenance && marker.checksProvenance.tests) || null;
    if (testsCheck === 'green' && testsProv !== 'test-gate' && testsProv !== 'manual-forced') {
      appendLog('gates.log', {
        name: 'tests-scope', status: 'blocked', story: marker.storyId,
        provenance: testsProv || '(ausente)',
        reason: 'el verde de tests no vino de test-gate.sh (suite completa)',
      });
      console.error(`marker.js complete-step ${n} BLOQUEADO — el verde de \`tests\` no salió de la suite completa.`);
      console.error('');
      console.error(`  Estado actual: checks.tests=green provenance=${testsProv || '(ausente)'}`);
      console.error('  Correr sólo los tests que la story declara deja afuera las regresiones que');
      console.error('  la story causó en otro lado — y ahí es exactamente donde aparecen.');
      console.error('');
      console.error('  El control es el gate, que corre TODO y captura el exit code real:');
      console.error('    bash <skills>/tycon-pipeline/scripts/test-gate.sh <repo> <story-path>');
      console.error('');
      console.error('  Si el repo no tiene suite completa, o hay que cerrar igual: lo decide la persona, no el agente.');
      console.error('  Si quiere, lo dice en su mensaje («autorizo force-manual»); queda en gates.log.');
      process.exit(1);
    }

    // ── «Sin acotar»: se acepta anunciándolo ──────────────────────────────────────────────────
    // La corrida del repo hermano no se pudo acotar a lo tocado y no corrió nada (salida 7 de test-gate.sh). Correr la
    // suite completa del hermano en la máquina del dev no es la salida: la cubre la CI del pedido, y queda escrito.
    if (testsCheck === 'sin-acotar') {
      appendLog('gates.log', {
        name: 'tests-unscoped', status: 'accepted', story: marker.storyId || null,
        reason: 'sin acotar: la cubre la CI del pedido; el merge exige la CI completa en verde',
      });
      console.error('⚠️  la suite no se acotó (sin acotar: no se supo qué se tocó en el repo hermano, o ninguna suite lo lee):');
      console.error('   la cubre la CI del pedido, y el merge exige la CI completa en verde. El motivo está en .advisors/tests-result.json.');
    }

    // ── «Sin medir»: se acepta diciéndolo, nunca callado ─────────────────────────────────
    // El portón no reconoce ninguna herramienta de pruebas en el repo (salida 3 de test-gate.sh) y no corrió nada. No es
    // un rojo que el agente pueda arreglar; tampoco es verde: se dice en una línea, con cómo medirlo, y queda anotado.
    if (testsCheck === 'sin-medir') {
      appendLog('gates.log', {
        name: 'tests-not-measured', status: 'accepted', story: marker.storyId || null,
        reason: marker.testsNotMeasuredReason || 'el portón no reconoce ninguna herramienta de pruebas en el repo',
      });
      console.error(`⚠️  ${testsNotMeasuredLine(marker)}`);
      console.error('   Para medirlas: declará el comando de pruebas del repo en el sitio de la organización, pestaña Configuración →');
      console.error('   Tu tecnología → Cómo se corren las pruebas (stack.test_runners de team-repos.json). El detalle está en');
      console.error('   .advisors/tests-result.json.');
    }

    // ── Chequeo de MUTANTES (AVISA, NO FRENA) ─────────────────────
    // La suite en verde no prueba que los tests ejerzan el código nuevo; el chequeo lo rompe a
    // propósito y mira si algún test se pone rojo. El único caso que bloquea es exit 1 del chequeo
    // (CERO mutantes muertos). Sobrevivientes → aviso; estructural (story sin tests) o cualquier
    // problema del chequeo mismo → fail-open. Todo queda en gates.log. Escapes: --no-mutation
    // (bypass.log) · TYCON_MUTATION_CHECK=off. Semántica y tests: lib/mutation-gate.js.
    {
      const { runMutationGate } = require('./lib/mutation-gate.js');
      const g = runMutationGate({ marker, opts, appendLog });
      if (g.block) process.exit(1);
    }
  }

  // ── Hallazgos y «Preparar el commit» — un crítico lo decide una persona ──
  // Cada CRITICAL `waived` de findings.json tiene que tener su constancia (`waive-critical`, con el ok de una persona).
  // No hay exención automática «sin nombrar»: dejaría que el agente se eximiera solo. El 8 lo vuelve a mirar porque el 7 sólo corre con críticos y findings.json se puede
  // reescribir a mano después. No poder leer los hallazgos se dice (en el 7 siempre tienen que estar).
  // Hallazgos frena sin findings.json; Preparar el commit lo vuelve a mirar (como hoy el 7 y el 8 del marcador viejo).
  if (controles.has('waivers')) {
    const cierraHallazgos = controles.has('findings-close');
    let rd = null;
    let motivo = null;
    try {
      const storyAbs78 = resolveStoryPath(marker.storyPath, marker) || undefined;
      rd = require('./pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, storyAbs78);
      if (!rd) motivo = 'no encontré la carpeta de la corrida';
    } catch (e) { motivo = `no pude calcular la carpeta de la corrida (${e.message || e})`; }
    const cw = require('./lib/critical-waivers.js');
    const v = rd ? cw.verificarExenciones(rd, { story: marker.storyId }) : { faltan: [], ilegibles: 0, existe: false };
    if (cierraHallazgos && !motivo && rd && !v.existe) motivo = 'falta findings.json (pipeline.js write-findings)';
    if (motivo) {
      // Hallazgos no se cierra sin hallazgos que mirar; Preparar el commit lo dice y sigue (sin corrida que mirar lo
      // frenan sus propios portones)
      appendLog('gates.log', { name: 'critical-waivers', status: cierraHallazgos ? 'blocked' : 'not-checked', story: marker.storyId, step: n, error: motivo });
      if (cierraHallazgos) {
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${motivo}: Hallazgos no puede mirar si algún crítico quedó eximido sin el ok de una persona.`);
        process.exit(1);
      }
      console.error(`⚠️  complete-step ${n}: ${motivo}: no pude mirar si hay críticos eximidos sin el ok de una persona.`);
    }
    // un findings.json que está y no se lee frena: es justo el que se pudo reescribir a mano. En Preparar el commit lo
    // frena con su propio mensaje el control de findings.json que sigue (computeFindingsStatus); acá, Hallazgos
    if (v.error && v.existe && cierraHallazgos) {
      appendLog('gates.log', { name: 'critical-waivers', status: 'blocked', story: marker.storyId, step: n, error: v.error });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${v.error}: no puedo saber si hay críticos eximidos sin el ok de una persona. Volvé a escribirlo con pipeline.js write-findings.`);
      process.exit(1);
    }
    if (v.faltan.length) {
      appendLog('gates.log', { name: 'critical-waivers', status: 'blocked', story: marker.storyId, step: n, faltan: v.faltan });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${v.faltan.length} crítico(s) marcado(s) como eximido(s) sin el ok de una persona:`);
      for (const l of cw.renglonesDeFaltantes(v)) console.error(l);
      console.error('   Un crítico lo decide una persona: arreglalo, o pedile el ok al dev y anotalo. Los caminos:');
      const rs = cw.sesionQueReenvia();
      for (const f of v.faltan) for (const l of cw.caminos({ marker: __filename, ruleId: f.rule_id, file: f.file || '<archivo>', relaySession: rs.valor })) console.error(l);
      if (rs.aviso) console.error(`   (sin reenvío: ${rs.aviso})`);
      process.exit(1);
    }
  }

  // Gate de DoD — «Preparar el commit». El orquestador puede llegar a
  // ese paso sin pasar «Probar en vivo» (DoD). Dos regímenes:
  //   - Story de UI (DODRT-C5.1): exige el gate `dod` en VERDE por run-check
  //     (el exit code REAL de un `npx playwright test`, no falseable) o `--force-manual` (escape
  //     explícito y logueado). NO alcanza `dodRuntimeChecked` — ese flag lo satisface un archivo de
  //     evidencia de texto (agente-escribible), un agujero que esta regla cierra.
  //   - Story no-UI: mantiene el gate `dodRuntimeChecked` («Probar en vivo» corrido).
  if (controles.has('commit')) {
    // Lo que cambió en el repo y nadie declaró: un archivo reescrito por la terminal, por un gestor de paquetes o por un
    // comando que el freno no reconoce. Va primero y sin DOD_BYPASS: la salida es nombrarlo o revertirlo.
    {
      const uc = require('./lib/undeclared-changes.js');
      const registrados = [].concat(marker.filesTouched || [], (marker.fileEvents || []).map((e) => e && e.path)).filter(Boolean);
      const consola = uc.consoleWritesOf(STATE_DIR, SID);
      const r = uc.computeUndeclared({
        repo: marker.repoPath || null, baseSha: marker.baseSha || null, startedAt: marker.startedAt || null,
        // una historia que no se encuentra no es «nada declarado»: la ruta llega igual y el control dice que no la leyó
        storyPath: resolveStoryPath(marker.storyPath, marker) || marker.storyPath || null, registrados,
        consola: consola.lineas, consolaProblemas: consola.problemas, consolaApagada: process.env.TYCON_NO_RUN_CHANGE === '1',
      });
      for (const a of r.avisos) console.error(`⚠️  complete-step ${n}: ${a}`);
      if (!r.medido) {
        console.error(`⚠️  complete-step ${n}: cambios sin declarar: no medido: ${r.motivo}. No es «no sobra nada»: es «no lo pude mirar».`);
        appendLog('gates.log', { name: 'undeclared-changes', action: 'no-medido', story: marker.storyId || null, motivo: r.motivo, deletes: r.borrados.length });
      } else if (r.sobra.length) {
        appendLog('gates.log', { name: 'undeclared-changes', action: 'bloqueo', story: marker.storyId || null, files: r.sobra, deletes: r.borrados.length });
        console.error(`marker.js complete-step ${n} BLOQUEADO — cambios sin declarar: ${r.sobra.length} archivo(s) cambiaron en el repo sin pasar por Edit/Write y la historia no los nombra:`);
        for (const f of r.sobra) console.error(`   · ${f}`);
        console.error('   Si son parte de la historia, sumalos al File List del Dev Agent Record (o a files_to_modify); si no, revertilos.');
        console.error('   Un lock cuenta como declarado cuando su manifiesto lo está.');
        process.exit(1);
      } else {
        appendLog('gates.log', { name: 'undeclared-changes', action: 'verde', story: marker.storyId || null, deletes: r.borrados.length });
      }
    }
    // Un crítico de seguridad o de datos abierto o diferido no cierra callado: lo arregla una vuelta (extra, si se llegó al
    // tope, con el ok de una persona) o lo exime una persona (waive-critical). Venga del revisor o del pase adversarial.
    {
      const rr = require('./lib/review-rounds.js');
      let rd8 = null;
      let noMirado = null;
      try { rd8 = require('./pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, resolveStoryPath(marker.storyPath, marker) || undefined); } catch (e) { noMirado = `no pude calcular la carpeta de la corrida (${e.message || e})`; }
      const h = rr.hallazgosDe(rd8);
      // «no pude mirar» no es «no quedó nada abierto»: sin poder calcular la carpeta no se cierra. Un findings.json que
      // falta o no se lee lo frena el control de findings.json que sigue, con su propio mensaje.
      if (noMirado) {
        appendLog('gates.log', { name: 'review-cap-blocking', status: 'blocked', story: marker.storyId, step: 8, error: noMirado });
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${noMirado}: no puedo saber si quedó abierto un crítico de seguridad o de datos. Volvé a escribir los hallazgos con pipeline.js write-findings.`);
        process.exit(1);
      }
      const bloquean = rr.abiertos(h.lista).filter((a) => a.bloquea);
      if (bloquean.length) {
        appendLog('gates.log', { name: 'review-cap-blocking', status: 'blocked', story: marker.storyId, step: 8, abiertos: bloquean.map((a) => a.regla) });
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${bloquean.length} crítico(s) de seguridad o de datos abierto(s) o diferido(s):`);
        for (const l of rr.resumen(bloquean)) console.error(`   · ${l}`);
        console.error('   Lo decide una persona: arreglarlo (con su ok para una vuelta más, si se llegó al tope: smart-reloop --extra-round');
        console.error('   --approved-by "<la persona>" --quote "<sus palabras>"), o eximirlo (marker.js waive-critical, con su ok a ese crítico).');
        process.exit(1);
      }
    }
    const isUi = markerStoryIsUi(marker);
    avisarBajaDePantalla(marker);
    let blocked = null;
    // La maqueta en el cierre. Lo decide mockup.screenStory (la detección de la revisión de la pantalla)
    // ANTES de llamar a qa-guide.js, que sale 0 igual con «no toca UI» y con «todo bien»:
    //   - «Aprobar el plan» anotó «sin pantalla» y hoy la story tiene una → frena (sin DOD_BYPASS): nadie vio la maqueta.
    //   - con maqueta aprobada y sin pantalla detectada, no se compara, se dice y queda en gates.log.
    const maqueta = require('./mockup.js').mockupStep8(marker, resolveStoryPath(marker.storyPath, marker) || marker.storyPath);
    let bloqueoMaqueta = null;
    if (maqueta.block) {
      bloqueoMaqueta = maqueta.block;
      appendLog('gates.log', { name: 'mockup-new-screen', status: 'blocked', story: marker.storyId || null, step: 8 });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${maqueta.block}`);
    }
    // Con la maqueta aprobada y la story que no se encuentra, la comparación no puede correr: frena y lo dice
    // (Sin esto, un DOD_BYPASS de otro bloqueo lo dejaría pasar callado.)
    if (!bloqueoMaqueta && marker.mockupApproval && maqueta.compare && !resolveStoryPath(marker.storyPath, marker)) {
      bloqueoMaqueta = `la story tenía maqueta aprobada y no la encuentro (${marker.storyPath || '(sin ruta en el marcador)'}): no puedo compararla con la pantalla. Arreglá la ruta (\`marker.js set\` con \`storyPath\`) y volvé a cerrar.`;
      appendLog('gates.log', { name: 'mockup-compare', status: 'blocked', motivo: 'story-ilegible', story: marker.storyId || null, step: 8 });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${bloqueoMaqueta}`);
    }
    if (maqueta.skip) {
      console.error('ℹ️  la story tenía maqueta aprobada y ya no se detecta pantalla: no se compara');
      appendLog('gates.log', { name: 'mockup-compare', status: 'skipped', motivo: 'sin-pantalla', story: marker.storyId || null, step: 8 });
    }

    // 🔴 `findings.json` lo exige el FRENO, no una instrucción del step. Un artefacto que se puede
    // escribir vacío a propósito («un run sin hallazgos igual escribe el archivo») y un `findings-status`
    // que vive sólo en el markdown de la guía de «Preparar el commit» dependen de que el orquestador se acuerde de correrlo:
    // algunas corridas no lo dejan. Y
    // sin el archivo «no escribí» y «no encontré nada» son indistinguibles: la tabla por regla de
    // `poda.js` decide retiros con media muestra y puede retirar una regla porque su revisor «nunca
    // encontró nada» cuando en realidad nadie anotó. El criterio no se copia: lo computa
    // `computeFindingsStatus` de pipeline.js, que es el mismo que usa `findings-status`.
    // 🔴 Sin run dir NO se bloquea: no hay dónde buscar, y frenar ahí rompería una corrida cuyo run
    // dir se borró. Se dice por stderr y queda en gates.log — «no pude mirar» visible, no silencio.
    {
      const storyPathF = resolveStoryPath(marker.storyPath, marker);
      let st = null;
      try {
        const { computeFindingsStatus } = require('./pipeline.js');
        if (storyPathF) st = computeFindingsStatus({ story: storyPathF, repo: marker.repoPath || process.cwd() });
      } catch (e) { st = { error: e.message }; }
      const anotar = (veredicto, motivo) => appendLog('gates.log', {
        name: 'findings-json', action: veredicto, story: marker.storyId || null, step: 8, motivo,
      });
      if (!storyPathF || !st || st.error || st.key_error) {
        const motivoNoMedido = (st && (st.error || (st.key_error && `sin clave de la carpeta de corrida: ${st.key_error}`))) || 'sin story path en el marker';
        console.error(`⚠️  complete-step prepare-commit: NO pude mirar si está el findings.json del paso de hallazgos (${motivoNoMedido}). No es «está»: es «no lo vi».`);
        anotar('no-medido', motivoNoMedido);
      } else if (!st.run_dir) {
        console.error('⚠️  complete-step prepare-commit: no hay run dir bajo .advisors/pipeline-runs/, así que no pude mirar el findings.json.');
        anotar('no-medido', 'sin run dir');
      } else if (!st.exists || !st.valid) {
        blocked = 'findings';
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${st.exists ? 'el findings.json NO es un array JSON válido' : 'FALTA el findings.json del paso de hallazgos'} en ${st.run_dir}.`);
        console.error('  Sin ese archivo, «no encontré nada» y «no lo escribí» son lo mismo: el criterio de poda del catálogo');
        console.error('  decide retiros de reglas con media muestra. Un run sin hallazgos igual lo escribe, con [].');
        console.error(`    node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-findings --story ${storyPathF} --findings -`);
        console.error('    (el array sale del reporte consolidado del paso de hallazgos, con la disposition final de cada hallazgo)');
        anotar('bloqueo', st.exists ? 'findings.json inválido' : 'findings.json ausente');
      }
    }
    // 🔴 El pase adversarial ATENDIDO. Lanzado → su resultado anotado después del último
    // lanzamiento; no lanzado → el salteo que decidió el portón. Sin este control, un pase cerrado sin
    // resultado pasa a «Preparar el commit». Se evalúa SIEMPRE (no sólo si
    // los frenos de arriba pasaron: los dos mensajes salen en la misma corrida), deja su línea en toda llamada, y
    // NO se abre con DOD_BYPASS: el arreglo siempre está a mano y esa variable la puede poner el propio agente.
    let bloqueoAdversarial = null;
    {
      const v = veredictoPaseAdversarial(marker);
      appendLog('gates.log', {
        name: 'adversarial-result-gate', status: v.veredicto === 'paso' ? 'ok' : 'blocked',
        motivo: v.motivo, story: marker.storyId || null, step: 8, runId: v.runId || null,
      });
      if (v.veredicto === 'bloqueo') {
        bloqueoAdversarial = v.motivo;
        mensajeDelPaseAdversarial(v);
      }
    }
    if (isUi) {
      const dodCheck = marker.checks && marker.checks.dod;
      const dodProv = marker.checksProvenance && marker.checksProvenance.dod;
      const okUi = dodCheck === 'green' && (dodProv === 'run-check' || dodProv === 'manual-forced');
      // La prueba con navegador que la persona dejó pendiente (lib/browser-test.js): sólo con las dos marcas, la de la
      // historia y la constancia que escribió e2e-setup.js en gates.log. Se dice siempre.
      const bt = require('./lib/browser-test.js');
      const deuda = okUi ? null : bt.debtDeclared({ stateDir: STATE_DIR, storyPath: resolveStoryPath(marker.storyPath, marker) || marker.storyPath });
      if (deuda && deuda.declared) {
        console.log(bt.debtLine(deuda));
        bt.recordDebtUse(STATE_DIR, deuda, 'complete-step 8');
      } else if (!okUi) {
        if (deuda && deuda.motivo && !/no declara/.test(deuda.motivo)) console.error(`marker.js complete-step prepare-commit: la prueba con navegador pendiente no vale — ${deuda.motivo}.`);
        blocked = 'ui';
        console.error(`marker.js complete-step ${n} BLOQUEADO — story de UI sin el gate \`dod\` en verde por run-check.`);
        console.error('');
        console.error(`  Estado actual: checks.dod=${dodCheck || '(ausente)'} provenance=${dodProv || '(ausente)'}`);
        console.error('  Una story de UI exige el EXIT CODE REAL del Playwright — no un flag ni un archivo de texto:');
        console.error('    marker.js run-check dod -- npx playwright test <spec> --workers=1');
        console.error('  Marcada UI pero sin superficie de UI real: declararla a mano lo decide la persona, no el agente');
        console.error('    («autorizo force-manual» en su mensaje; queda manual-forced en gates.log).');
        console.error('  Si el repo no tiene cómo probar en un navegador: la persona decide en la oferta (e2e-setup.js prepare|defer).');
      }
    } else if (marker.dodRuntimeChecked !== true) {
      blocked = 'non-ui';
      console.error(`marker.js complete-step ${n} BLOQUEADO — «Probar en vivo» no se ejecutó.`);
      console.error('');
      console.error('El marker no tiene dodRuntimeChecked=true. Acciones permitidas:');
      console.error('  (a) Correr el paso «Probar en vivo» — invocar tycon-dod-runtime-checker advisor +');
      console.error('      ejecutar E2E specs + capturar evidencia. Después:');
      console.error('      marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"<path>"}\'');
      // Setear `marker.dodRuntimeChecked` a mano con `set` no es una exención válida: esta es la forma.
      // Queda escrito como exención (evidencePath «exenta: …») y sólo vale para una story sin UI.
      console.error('  (b) Story exenta (sin UI ni endpoints — «Probar en vivo»): eximirla ya en implementación lo decide la');
      console.error('      persona («autorizo dod_runtime_exempt» en su mensaje), con dod_runtime_exempt_reason en el frontmatter. Después:');
      console.error('      marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"exenta: <razón>"}\'');
    }
    // DODRT-C6 — la matriz
    // de verificación runtime por AC se RE-COMPUTA acá EN PROCESO, NO se confía en el check
    // `checks.acmatrix` (que `run-check acmatrix -- true` podría poner verde con un comando
    // trivial — vector de forja). Se computa runtime-matrix.js contra marker.storyPath y se exige
    // green: cada AC con evidencia de EJECUCIÓN real (gate E2E / smoke con exit code real) o
    // waiveado por el USUARIO desde su terminal (marker.js runtime-waiver, TTY-only). El agente
    // no puede forjar evidencia creíble ni producir un waiver (no tiene /dev/tty).
    if (!blocked) {
      const storyPath = resolveStoryPath(marker.storyPath, marker);
      if (!storyPath) {
        blocked = 'acmatrix-nostory';
        console.error(`marker.js complete-step ${n} BLOQUEADO — no puedo computar la matriz runtime: marker.storyPath ausente o inexistente (crudo: ${nn(marker.storyPath, '(vacío)')}; base: ${nn(marker.repoPath, process.cwd())}).`);
        console.error('  Seteá el path de la story en el marker (pipeline.js start lo hace) y reintentá.');
      } else {
        let matrix;
        try {
          matrix = require('./runtime-matrix.js').compute({ storyPath });
        } catch (e) {
          blocked = 'acmatrix-error';
          console.error(`marker.js complete-step ${n} BLOQUEADO — la matriz runtime no computó (fail-closed): ${e.message}`);
        }
        if (matrix && matrix.structuralError) {
          blocked = 'acmatrix-struct';
          console.error(`marker.js complete-step ${n} BLOQUEADO — matriz runtime no computable: ${matrix.structuralError}`);
        } else if (matrix && !matrix.green) {
          blocked = 'acmatrix';
          console.error(`marker.js complete-step ${n} BLOQUEADO — matriz de verificación runtime (DODRT-C6) ROJA.`);
          console.error('');
          console.error(`  (${matrix.stats.runtime}/${matrix.stats.total} corridos · ${matrix.stats.notRun} SIN CORRER · ${matrix.stats.notVerifiable} imposibles-declarados · ${matrix.stats.waived} waiveados)`);
          if ((matrix.notRun || []).length) {
            console.error(`  🔴 SIN CORRER (el agente DEBE correrlos — NO se pueden waivear): ${matrix.notRun.map((n) => '#' + n).join(', ')}`);
            console.error('     Corrélos (E2E Playwright / smoke-run.sh). Si son materialmente imposibles,');
            console.error('     declaralos en el frontmatter `runtime_not_verifiable:` (reason + covered_by).');
          }
          if ((matrix.notVerifiable || []).length) {
            console.error(`  🟪 imposibles-declarados (esperan waiver del USUARIO): ${matrix.notVerifiable.map((n) => '#' + n).join(', ')}`);
            console.error(`     node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js runtime-waiver ${storyPath}`);
          }
          // La firma que existe pero se descartó se DICE: sin esto, «esperan waiver» parece que el dev no firmó.
          for (const l of require('./runtime-matrix.js').avisoFirmasDescartadas(matrix, storyPath)) console.error(`  ${l}`);
          if (matrix.chainOk === false) console.error('  🚨 hay líneas de esta story descartadas por la cadena del registro de firmas — causa probable: una edición a mano.');
        }
      }
    }
    // DODRT-C7 — para una story de UI, la GUÍA DE PRUEBA MANUAL del
    // tester tiene que estar lista: pasos en criollo, que cubran los ACs corridos, SIN jerga de
    // software (determinístico), y con la review de legibilidad independiente "veredicto: OK".
    // qa-guide.js --check chequea los 4 y sale !=0 si falta algo.
    const qaStoryPath = resolveStoryPath(marker.storyPath, marker);
    // Con la maqueta aprobada también corre aunque markerStoryIsUi diga que no (la revisión sí ve
    // pantalla), y le pasa la huella aprobada: borrar el archivo de aprobación no saltea la comparación.
    if (!blocked && (markerStoryIsUi(marker) || (marker.mockupApproval && maqueta.compare)) && qaStoryPath) {
      try {
        require('child_process').execFileSync(
          'node',
          require('./mockup.js').qaGuideCheckArgs(qaStoryPath, marker),
          { stdio: 'inherit' },
        );
      } catch (e) {
        blocked = 'qaguide';
        console.error('');
        console.error(`marker.js complete-step ${n} BLOQUEADO — la guía de prueba manual del tester (DODRT-C7) NO está lista (ver arriba).`);
        console.error('  Escribí/corregí los pasos en criollo en specs/qa/<sid>-pasos.md y corré la review de legibilidad.');
        // La pantalla también se revisa; sus marcas se arreglan en el código, no reescribiendo la guía.
        console.error('  Y la de la PANTALLA (specs/qa/<sid>-legibilidad-ui.md, «Probar en vivo», parte 7): sus marcas se resuelven EN LA PANTALLA, no en la guía.');
      }
    }
    // La marca a mano: si la organización lo pide (qa.manual_check: required), una persona marca cada criterio de la guía
    // como probado a mano: con la misma condición de pantalla que la guía, después de ella. No se abre con DOD_BYPASS.
    if (!blocked && qaStoryPath) {
      try {
        const esPantalla = markerStoryIsUi(marker) || !!(marker.mockupApproval && maqueta.compare);
        const rdMc = require('./pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, qaStoryPath);
        const f = require('./lib/manual-checks.js').freno({ storyPath: qaStoryPath, storyId: String(marker.storyId), runDir: rdMc, stateDir: STATE_DIR, esPantalla });
        appendLog('gates.log', { name: 'manual-checks', status: f.status, story: marker.storyId, ...(f.faltan.length ? { faltan: f.faltan } : {}) });
        if (f.status === 'blocked') {
          blocked = 'manualcheck';
          console.error('');
          console.error(`marker.js complete-step ${n} BLOQUEADO — falta la marca a mano de una persona.`);
          for (const l of f.mensaje) console.error(`  ${l}`);
        }
      } catch (e) {
        blocked = 'manualcheck';
        console.error(`marker.js complete-step ${n} BLOQUEADO — no pude mirar si falta la marca a mano (${e.message}).`);
      }
    }
    if (bloqueoMaqueta) {
      console.error('');
      console.error('  🔒 El bloqueo de la maqueta no se abre con DOD_BYPASS: una pantalla la ve una persona antes de construirla.');
      process.exit(2);
    }
    if (bloqueoAdversarial) {
      console.error('');
      console.error('  🔒 El bloqueo del pase adversarial no se abre con DOD_BYPASS: el arreglo siempre está al alcance');
      console.error('     (anotar el resultado, o el salteo que decide el portón).');
      process.exit(2);
    }
    if (blocked) {
      // 🔴 Los bloqueos de la matriz runtime (acmatrix*) y de la guía de tester (qaguide) NO tienen
      // bypass por env var: DOD_BYPASS lo puede setear el agente, y el agente no puede saltear ni la
      // verificación runtime ni dejar la guía sin criollo. Los bloqueos
      // legacy (ui / non-ui) mantienen su escape DOD_BYPASS.
      if (String(blocked).startsWith('acmatrix') || blocked === 'qaguide' || blocked === 'manualcheck') {
        console.error('');
        console.error('  🔒 Este bloqueo NO tiene bypass para el agente (ni DOD_BYPASS ni --no-verify lo saltean');
        console.error('     limpiamente): la verificación runtime es obligatoria. La única salida es el waiver TTY del usuario.');
        process.exit(2);
      }
      console.error('  Saltear este bloqueo lo decide la persona, no el agente: si quiere, lo dice en su mensaje');
      console.error('  («autorizo DOD_BYPASS»); queda had_dod_bypass=true en bypass.log.');
      console.error('');
      console.error(`Ver: ~/.claude/agent-skills/skills/tycon-pipeline/steps/${STEPS_LIB.byId('live-check').file}`);
      if (process.env.DOD_BYPASS !== '1') {
        process.exit(2);
      }
      console.error(`⚠ DOD_BYPASS=1 detectado (lo autorizó la persona o lo puso el dev en su ambiente) — permitiendo complete-step ${n} con flag had_dod_bypass=true`);
      marker.hadDodBypass = true;
      // Rastro DURABLE del bypass: el marker se borra al cerrar el pipeline;
      // bypass.log sobrevive y on-prompt puede reportarlo.
      appendLog('bypass.log', {
        type: blocked === 'ui' ? 'DOD_BYPASS_UI' : blocked === 'acmatrix' ? 'DOD_BYPASS_ACMATRIX' : 'DOD_BYPASS',
        storyId: marker.storyId,
        step: n,
        cwd: process.cwd(),
      });
    }
  }

  // El marcador viejo guarda sus pasos principales como números; el nuevo, por nombre.
  const comoSeGuarda = (id) => (!nuevo && /^\d+$/.test(id) ? Number(id) : id);
  marker.stepsPending = (marker.stepsPending || []).filter((s) => !ids.includes(String(s)));
  marker.stepsCompleted = Array.isArray(marker.stepsCompleted) ? marker.stepsCompleted : [];
  for (const id of ids) if (!marker.stepsCompleted.map(String).includes(id)) marker.stepsCompleted.push(comoSeGuarda(id));
  if (nuevo) marker.stepsCompleted.sort((a, b) => STEPS_LIB.STEPS.findIndex((s) => s.id === a) - STEPS_LIB.STEPS.findIndex((s) => s.id === b));
  else marker.stepsCompleted.sort((a, b) => a - b);
  // Timestamp por step para que
  // `pipeline.js timing-report` desglose dónde se va el wall-clock de la corrida.
  marker.stepTimings = marker.stepTimings || {};
  // Se CONSERVA el arranque (y cualquier otro campo del paso): pisar el objeto entero con
  // `{completedAt}` perdería el arranque que `start-step`/`next` hubieran anotado.
  for (const id of ids) {
    const previo = marker.stepTimings[id] && typeof marker.stepTimings[id] === 'object' ? marker.stepTimings[id] : {};
    // Cada cierre de los revisores es una vuelta: `next` pide la siguiente si hubo arreglos después de Hallazgos. La
    // primera vuelta conserva su `completedAt` (la cuenta de tiempos corta por ahí; moverlo después de Hallazgos
    // juntaría los dos pasos y se comería la espera); las siguientes van en `lastCompletedAt`.
    if (nuevo && id === 'reviewers' && previo.completedAt) {
      marker.stepTimings[id] = { ...previo, lastCompletedAt: nowIso(), rounds: (Number(previo.rounds) || 1) + 1 };
    } else {
      marker.stepTimings[id] = { ...previo, completedAt: nowIso(), ...(nuevo && id === 'reviewers' ? { rounds: 1 } : {}) };
    }
  }
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(JSON.stringify(marker, null, 2));
  if (planParaMostrar) {
    // por la salida de errores: la estándar es el JSON del marcador, que otros leen
    console.error('\n📋 El plan se aprobó solo (riesgo bajo) y ya está en tu respuesta: la persona lo vio.');
  }
}

/**
 * La hora de ARRANQUE de un paso. Pura: devuelve el marker con el arranque anotado, o
 * `null` si no hay nada que anotar — el paso ya arrancó o ya está completo. Nunca mueve un arranque:
 * la primera consulta es la que marca, y las siguientes (el orquestador pregunta `next` varias veces)
 * no pueden correrlo hacia adelante y esconder el tiempo que ya pasó.
 */
// Los sub-pasos del marcador viejo (el reloj, el pedido en ADO, el pase adversarial y la prueba en vivo) se cierran con
// una BANDERA, no con complete-step: tienen arranque y no fin propio. Sin arranque, su trabajo (el pase adversarial
// dura ~30 min) caería como «tiempo
// entre pasos» en la cuenta.
// En un marcador nuevo arranca cualquier paso de la tabla, por su nombre.
const PASO_ARRANCABLE = /^(\d|0b|0c|5b|7c)$/;
const arrancable = (marker, k) => (STEPS_LIB.schemeOf(marker) === 2 ? !!STEPS_LIB.byId(k) : PASO_ARRANCABLE.test(k));
function anotarArranque(marker, n, ts) {
  const k = String(n);
  if (!marker || !arrancable(marker, k)) return null;
  const completos = (marker.stepsCompleted || []).map(String);
  if (completos.includes(k)) return null;
  const st = marker.stepTimings && typeof marker.stepTimings === 'object' ? marker.stepTimings : {};
  const previo = st[k] && typeof st[k] === 'object' ? st[k] : {};
  if (previo.startedAt || previo.completedAt) return null;
  return { ...marker, stepTimings: { ...st, [k]: { ...previo, startedAt: ts } } };
}

function cmdStartStep(nRaw) {
  let n = String(nRaw || '').trim();
  const marker = readMarker();
  // sin corrida no hay nada que medir: no es un error, pero un argumento que no es un paso sí
  if (!marker) {
    if (!STEPS_LIB.byId(n) && !PASO_ARRANCABLE.test(n)) {
      console.error(`marker.js start-step: «${n}» no es un paso. Los pasos: ${STEPS_LIB.STEPS.map((s) => s.id).join(', ')}.`);
      process.exit(2);
    }
    process.exit(0);
  }
  if (STEPS_LIB.schemeOf(marker) === 2) {
    if (!STEPS_LIB.byId(n)) {
      console.error(`marker.js start-step: ${STEPS_LIB.resolveStepArg(marker, n).message || `«${n}» no es un paso.`}`);
      process.exit(2);
    }
  } else if (STEPS_LIB.byId(n)) {
    // un marcador viejo, con el nombre nuevo: el arranque va a su número de entonces
    n = STEPS_LIB.byId(n).old[0];
  } else if (!PASO_ARRANCABLE.test(n)) {
    console.error('marker.js start-step: N debe ser un paso (0..9) o un sub-paso (0b, 0c, 5b, 7c)');
    process.exit(2);
  }
  const nuevo = anotarArranque(marker, n, nowIso());
  if (!nuevo) process.exit(0);
  nuevo.lastTouch = nowIso();
  writeMarker(nuevo);
}

// ============================================================
// Gate de DoD
// ============================================================

/**
 * Marca el marker actual como "DoD runtime verified" — el paso «Probar en vivo» del pipeline
 * pasó. Es pre-condición para `complete-step prepare-commit`.
 *
 * Payload JSON esperado:
 *   {
 *     "evidencePath": "<abs path al archivo .advisors/dod-runtime/...md>",
 *     "verdict": "PASS" | "PARTIAL" | "FAIL",
 *     "gatesRun": ["DODRT-C1", "DODRT-C2", ...]
 *   }
 *
 * Solo PASS desbloquea «Preparar el commit». PARTIAL requiere waiver explícito del user
 * (manejado en el step file).
 */
function cmdMarkDodRuntimeChecked(payloadJson) {
  if (!payloadJson) {
    console.error('marker.js mark-dod-runtime-checked: payload JSON requerido');
    process.exit(2);
  }
  let payload;
  try { payload = JSON.parse(payloadJson); } catch (e) {
    console.error('marker.js mark-dod-runtime-checked: payload JSON invalido:', e.message);
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js mark-dod-runtime-checked: no hay marker activo');
    process.exit(1);
  }
  const wantsPass = payload.verdict === 'PASS';
  avisarBajaDePantalla(marker);
  // DODRT-C5.1 — para una story de UI, un verdict PASS NO se acepta como
  // self-assertion a ciegas: exige que el evidencePath EXISTA y contenga evidencia Playwright real
  // (espejo del check del hook on-pre-commit). Sin esto, `mark-dod-runtime-checked
  // {verdict:PASS}` desbloquea complete-step prepare-commit SIN haber corrido el E2E. Un PASS
  // se valida por contenido, nunca por `verdict === 'PASS'` a secas.
  if (wantsPass && markerStoryIsUi(marker)) {
    const ev = verifyPlaywrightEvidence(marker, payload.evidencePath);
    if (!ev.ok) {
      console.error('marker.js mark-dod-runtime-checked: RECHAZADO — story de UI, verdict PASS exige');
      console.error('  evidencia Playwright REAL (DODRT-C5.1). ' + ev.reason);
      console.error('  Corré el E2E y apuntá evidencePath a un archivo .advisors/dod-runtime/<story>-*.md');
      console.error('  que documente el resultado (debe mencionar playwright / tests/e2e / @story- / E2E-N).');
      console.error('  Una story de UI no se exime («Probar en vivo»). Si está marcada UI y no tiene superficie de UI real,');
      console.error('  declararla a mano lo decide la persona («autorizo force-manual» en su mensaje; queda en gates.log).');
      process.exit(2);
    }
  }
  marker.dodRuntimeChecked = wantsPass;
  marker.dodRuntime = {
    verdict: payload.verdict,
    evidencePath: payload.evidencePath || null,
    gatesRun: payload.gatesRun || [],
    timestamp: nowIso(),
  };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(JSON.stringify(marker, null, 2));
}

// ============================================================
// Autonomía Nivel 1 (Stop-hook DoD gate)
// ============================================================
// `set-autonomous true|false` → opt-in del MODO AUTÓNOMO. El Stop hook
// `on-stop-dod-gate.js` SOLO atrapa el fin de turno si `marker.autonomous === true`.
// Inicializa el estado del loop (iter, noProgressStreak, lastFailures, checks).
//
// `set-check <name> <status>` → registra el resultado de un gate mecánico que el hook
// lee: name ∈ {build,tests,advisors,dod}; status = 'green' | 'red:<detalle>'. El hook
// bloquea el stop SOLO si algún check registrado está en rojo (ausente ≠ rojo — preserva
// pausas HITL). Ground-truth: el step debe pasar el resultado de exit codes / check-count
// REALES, no lo que el LLM "cree".

function cmdSetAutonomous(valRaw) {
  const on = valRaw === 'true' || valRaw === '1' || valRaw === 'on';
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-autonomous: no hay marker activo (corré `set` en el Arranque primero)');
    process.exit(1);
  }
  marker.autonomous = on;
  if (on) {
    // Inicializar/resetear el estado del loop al activar.
    marker.iter = 0;
    marker.noProgressStreak = 0;
    marker.lastFailures = [];
    if (!marker.checks) marker.checks = {};
  }
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(`autonomous: ${on}\n`);
}

// `tests-suite`: una suite sola de suites.json, repetida con `test-gate.sh --suite` después de un rojo. Nunca vale como
// `tests` (la corrida completa), pero comparte su candado: las dos corren las mismas suites del repo.
const VALID_CHECKS = ['build', 'tests', 'tests-suite', 'advisors', 'dod', 'acmatrix'];

// DODRT-C5.1 — verifica que el evidencePath de una story de UI sea evidencia
// Playwright REAL: el archivo EXISTE (resuelto relativo a marker.repoPath si el path es relativo) y su
// CONTENIDO menciona playwright / tests/e2e / @story- / E2E-N. Espejo del check del hook
// on-pre-commit.js:578 — así el gate del marker (complete-step prepare-commit) y el gate del commit exigen lo mismo.
/**
 * Resuelve el `storyPath` del marker a una ruta USABLE.
 *
 * 🔴 `pipeline.js start` lo guarda RELATIVO al repo (`specs/<epic>/<story>.md`), así que cualquier
 * `fs.existsSync(marker.storyPath)` falla salvo que el proceso corra parado justo en la raíz del
 * repo. Eso rompería en silencio 3 sitios distintos: el gate de `complete-step prepare-commit`, el check de la
 * guía de QA, y el fallback de `runtime-waiver` (que además le echaría la culpa al usuario con un
 * "el marker no lo tiene"). `runtime-matrix.js` resuelve lo mismo con su propio `path.resolve`.
 *
 * Mismo criterio que `evidencePath` más abajo: relativo ⇒ contra `marker.repoPath` (absoluto por
 * construcción, `readMarker` lo defaultea a `process.cwd()`), nunca contra el cwd del proceso.
 * @returns {string|null} la ruta absoluta si el archivo existe; `null` si no
 */
function resolveStoryPath(raw, marker) {
  if (!raw) { return null; }
  let p = String(raw);
  if (!path.isAbsolute(p)) {
    const base = (marker && marker.repoPath) || process.cwd();
    p = path.join(base, p);
  }
  return fs.existsSync(p) ? p : null;
}

function verifyPlaywrightEvidence(marker, evidencePath) {
  if (!evidencePath || String(evidencePath).trim() === '') {
    return { ok: false, reason: 'Falta evidencePath en el payload.' };
  }
  let p = String(evidencePath);
  if (!path.isAbsolute(p)) {
    // Relativo ⇒ primero contra el repo de la EVIDENCIA (el de la story, `marker.evidenceDir` =
    // <repo>/.advisors/dod-runtime → dos niveles arriba), después contra `marker.repoPath` (el del
    // código). Con la evidencia en otro repo, resolver sólo contra repoPath diría "no existe".
    const bases = [];
    if (marker && typeof marker.evidenceDir === 'string' && marker.evidenceDir) bases.push(path.resolve(marker.evidenceDir, '..', '..'));
    bases.push((marker && marker.repoPath) || process.cwd());
    const hallado = bases.map((b) => path.join(b, p)).find((c) => fs.existsSync(c));
    p = hallado || path.join(bases[bases.length - 1], p);
  }
  if (!fs.existsSync(p)) {
    return { ok: false, reason: `El evidencePath no existe: ${p}` };
  }
  let content;
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, reason: `No se pudo leer el evidencePath: ${e.message}` };
  }
  if (!/playwright|tests\/e2e\/|@story-|E2E[-\s]\d/i.test(content)) {
    return { ok: false, reason: 'La evidencia existe pero no menciona Playwright / tests/e2e / @story- / E2E-N.' };
  }
  return { ok: true, path: p };
}

// DODRT-C5.1 — ¿la story del marker toca UI? Si sí, el check `dod` NO se puede marcar
// manual: exige un run-check con Playwright (evidencia por-AC, no falseable). Sin esto, una UI
// podría declararse «probada en runtime» sin correr el E2E.
// Señal de UI: la decide lib/ui-signal.js (extensiones de pantalla, rutas del frente y nombres
// declarados en las listas de archivos, campos estructurados y tandas; la prosa sólo de respaldo;
// escenarios de navegador en el spec). Acá no se copia ninguna regla ni ningún nombre de producto.
// Volver a aprobar la maqueta (cambió después de aprobada, o un arreglo de legibilidad cambió un
// texto), o aprobarla por primera vez si la story ganó una pantalla después de aprobar el plan. La aprueba quien aprueba
// el plan: el dueño, o quien tenga su delegación en modo autónomo; la cita dice quién y por qué vía.
function cmdApproveMockup(flags) {
  const marker = readMarker();
  if (!marker) { console.error('marker.js approve-mockup: no hay marker activo para esta sesión'); process.exit(1); }
  const opts = Array.isArray(flags) ? flags : [];
  const i = opts.indexOf('--approved');
  const cita = i >= 0 ? (opts[i + 1] || '') : '';
  if (!STEPS_LIB.isDone(marker, 'approve-plan')) {
    console.error(`marker.js approve-mockup: la maqueta se aprueba con el plan: complete-step ${STEPS_LIB.schemeOf(marker) === 2 ? 'approve-plan' : '3'} --approved "<cita>" --mockup-approved "<cita>"`);
    process.exit(2);
  }
  const no = (msg, extra = []) => {
    appendLog('gates.log', { name: 'mockup-approval', status: 'blocked', story: marker.storyId, motivo: msg });
    console.error(`marker.js approve-mockup BLOQUEADO — ${msg}`);
    for (const l of extra) console.error(`  ${l}`);
    process.exit(1);
  };
  if (!cita.trim()) no('falta --approved "<cita: quién aprobó la maqueta y por qué vía>"');
  const mk = require('./mockup.js');
  let sc;
  try { sc = mk.screenStory(resolveStoryPath(marker.storyPath, marker) || marker.storyPath); } catch (e) {
    no(`no pude leer la story (${marker.storyPath || '(sin ruta en el marcador)'}: ${e.code || e.message}): no pude saber si tiene pantalla.`);
  }
  if (!sc.screen) no('la story no tiene pantalla: no hay maqueta que aprobar.');
  let p;
  try { p = mk.mockupPaths(sc.story); } catch (e) { no(`no pude calcular la clave de la story (${e.message}).`); }
  let html = null;
  try { html = fs.readFileSync(p.mockup, 'utf8'); } catch (_e) {
    no(`falta la maqueta (${p.mockup}).`, [`Armala: node ${path.join(__dirname, 'mockup.js')} render --data <modelo.json> --story ${sc.story}`]);
  }
  const v = mk.validateMockupHtml(html);
  if (!v.ok) no(`la maqueta no pasa mockup.js check (${p.mockup}):`, v.findings.map((x) => `- ${x.line ? `línea ${x.line}: ` : ''}${x.what}`));
  const sha = mk.mockupHash(html);
  const prev = marker.mockupApproval && marker.mockupApproval.sha256;
  const at = nowIso();
  try { mk.writeApproval({ approvalPath: p.approval, mockupPath: p.mockup, story: marker.storyId, sha256: sha, approvedAt: at }); } catch (e) {
    no(`no pude escribir la aprobación de la maqueta (${p.approval}): ${e.code || e.message}`);
  }
  marker.mockupApproval = { file: p.mockup, sha256: sha, mode: 'user', text: cita, at };
  if (!marker.mockupDecision || marker.mockupDecision.screen !== true) marker.mockupDecision = { screen: true, signal: sc.signal || null, at };
  appendLog('gates.log', { name: 'mockup-approval', status: 'ok', story: marker.storyId, sha256: sha.slice(0, 12), reapproval: !!prev, ...(prev ? { previous: prev.slice(0, 12) } : {}) });
  {
    const optVal = (name) => { const k = opts.indexOf(name); return k >= 0 ? nn(opts[k + 1], '') : null; };
    anotarAprobacion(marker, { que: 'maqueta', cuando: at, via: 'approve-mockup', ...quienDeLasOpciones(optVal) });
  }
  writeMarker(marker);
  console.log(JSON.stringify({ ok: true, file: p.mockup, approval: p.approval, sha256: sha, reapproval: !!prev }, null, 2));
}

function markerStoryIsUi(marker) {
  try {
    const p = marker && marker.storyPath;
    if (!p || !fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, 'utf8');
    // qué cuenta como pantalla lo dice la regla screen_test de la organización (ui de fábrica, react u off)
    return require(path.join(__dirname, 'lib', 'ui-signal.js'))
      .applyScreenRule(content, (marker && marker.repoPath) || process.cwd(), screenRule()).ui;
  } catch (e) {
    // no deja la exigencia de pantalla apagada en silencio
    console.error(`⚠️  no pude decidir si la story toca pantalla (${e && e.message ? e.message : e}): se trata como sin pantalla`);
    return false;
  }
}

function screenRule() {
  try { return require(path.join(__dirname, 'lib', 'stack-config.js')).orgRules().rules.screen_test.value; } catch (_e) { return 'ui'; }
}

// La baja de pantalla nunca es muda. Si la story dejó de contar como de pantalla porque la
// palabra del frente sólo está en la prosa o en documentos, se dice en UNA
// línea por stderr, sin bloquear. Se llama una sola vez por comando, al nivel del comando: NO dentro de
// markerStoryIsUi, que `complete-step prepare-commit` llama más de una vez.
function avisarBajaDePantalla(marker) {
  try {
    const p = marker && resolveStoryPath(marker.storyPath, marker);
    if (!p || !fs.existsSync(p)) return;
    const ui = require(path.join(__dirname, 'lib', 'ui-signal.js'));
    const content = fs.readFileSync(p, 'utf8');
    const linea = ui.proseDropNotice(ui.uiSignalDetail(content, marker.repoPath || process.cwd()));
    if (linea) console.error(linea);
    // con screen_test: off, el cierre dice que la prueba de pantalla no se exigió
    const regla = ui.applyScreenRule(content, marker.repoPath || process.cwd(), screenRule()).note;
    if (regla) console.error(regla);
  } catch (_e) { /* el aviso nunca rompe el comando */ }
}

/**
 * `mark-tests-not-scoped`: la salida 7 de test-gate.sh es «sin acotar» (una corrida cruzada no pudo acotarse a lo tocado
 * y no corrió nada). `run-check` la registra como `red:exit=7`; acá pasa a `sin-acotar`, que no es verde ni un rojo
 * para arreglar: la cubre la CI del pedido (complete-step run-tests lo anuncia). Sólo lo llama test-gate.sh, y sólo cambia un
 * `red:exit=7` puesto por el portón: no puede tapar ningún otro rojo.
 */
function cmdMarkTestsNotScoped(motivo) {
  if (process.env.TYCON_TEST_GATE !== '1') {
    console.error('marker.js mark-tests-not-scoped: sólo lo usa test-gate.sh (TYCON_TEST_GATE=1)');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) return;   // sin corrida activa no hay nada que marcar, como run-check
  const st = (marker.checks || {}).tests;
  const prov = (marker.checksProvenance || {}).tests;
  if (st !== 'red:exit=7' || prov !== 'test-gate') {
    console.error(`marker.js mark-tests-not-scoped: el check tests es ${st || '(ausente)'} (${prov || 'sin procedencia'}), no la salida 7 del portón: no lo cambio`);
    process.exit(2);
  }
  marker.checks.tests = 'sin-acotar';
  marker.checksAt = marker.checksAt || {};
  marker.checksAt.tests = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { sessionId: marker.sessionId || null, storyId: marker.storyId || null, check: 'tests',
    status: 'sin-acotar', provenance: 'test-gate', motivo: String(motivo || '').slice(0, 300) });
}

/**
 * `tests-failed`: la lista de suites que fallaron en la última corrida completa de la puerta (`marker.testsFailed`, al
 * lado de `checks`: el freno de cierre de turno recorre `checks` y una lista no es un check). La usa test-gate.sh:
 * Cada entrada lleva el repo de su corrida (`--repo`): la lista es de la sesión, y una corrida en otro repo no reemplaza,
 * no saca ni pide las de éste.
 *   · `record --summary <resumen> --repo <repo>`: reemplaza las de ese repo con las fallas del resumen de
 *     run-suites-json.js (sin resumen legible, ninguna) y borra `checks['tests-suite']`, para que no quede en pie el rojo
 *     de una suite sola anterior;
 *   · `clear --path <ruta> --repo <repo>`: saca esa ruta (la suite sola salió verde);
 *   · `pending --suites <suites.json> --gate <test-gate.sh> --repo <repo> [--story <story>]`: saca las rutas que ya no
 *     están en suites.json (y lo dice); si queda alguna, nombra cada una con su comando y sale 76.
 * `record` y `clear` escriben lo que mide la puerta: sólo los llama test-gate.sh (TYCON_TEST_GATE=1).
 * Sin corrida abierta: sale 0, no escribe nada y lo dice.
 */
const TESTS_FAILED_PENDING = 76;

function cmdTestsFailed(argv) {
  const accion = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const uso = 'marker.js tests-failed: uso — tests-failed record --summary <f> --repo <r> | clear --path <ruta> --repo <r> | pending --suites <json> --gate <test-gate.sh> --repo <r> [--story <s>]';
  if (!['record', 'clear', 'pending'].includes(accion) || !opt('--repo')
    || (accion === 'record' && !opt('--summary')) || (accion === 'clear' && !opt('--path'))
    || (accion === 'pending' && (!opt('--suites') || !opt('--gate')))) {
    console.error(uso);
    process.exit(2);
  }
  if (accion !== 'pending' && process.env.TYCON_TEST_GATE !== '1') {
    console.error(`marker.js tests-failed ${accion}: sólo lo usa test-gate.sh (TYCON_TEST_GATE=1)`);
    process.exit(2);
  }
  const ff = require('./lib/failed-first.js');
  const marker = readMarker();
  if (!marker) {
    process.stdout.write(`marker.js tests-failed ${accion}: sin corrida abierta en esta sesión, no anoto nada\n`);
    return;
  }
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const repo = real(opt('--repo'));
  const todas = Array.isArray(marker.testsFailed) ? marker.testsFailed : [];
  const ajenas = todas.filter((x) => x.repo !== repo);
  const lista = todas.filter((x) => x.repo === repo);
  if (accion === 'record') {
    let resumen = null;
    try { resumen = JSON.parse(fs.readFileSync(opt('--summary'), 'utf8')); } catch (e) {
      process.stderr.write(`[test-gate] ⚠️  no pude leer el resumen ${opt('--summary')} (${e.message}): la lista de las que fallaron en este repo queda vacía\n`);
    }
    marker.testsFailed = [...ajenas, ...ff.fromSummary(resumen, repo)];
    for (const campo of ['checks', 'checksAt', 'checksProvenance']) if (marker[campo]) delete marker[campo]['tests-suite'];
    marker.lastTouch = nowIso();
    writeMarker(marker);
    const nuevas = marker.testsFailed.filter((x) => x.repo === repo);
    if (nuevas.length) process.stderr.write(`[test-gate] suites que fallaron, anotadas para repetir primero: ${nuevas.map((x) => x.ruta).join(', ')}\n`);
    return;
  }
  if (accion === 'clear') {
    const ruta = opt('--path');
    if (!lista.some((x) => x.ruta === ruta)) return;
    const quedan = lista.filter((x) => x.ruta !== ruta);
    marker.testsFailed = [...ajenas, ...quedan];
    marker.lastTouch = nowIso();
    writeMarker(marker);
    process.stderr.write(`[test-gate] ${ruta} salió verde: fuera de la lista${quedan.length ? ` (quedan ${quedan.length})` : ' (no queda ninguna: la corrida completa ya puede arrancar)'}\n`);
    return;
  }
  if (!lista.length) return;
  let keep = lista;
  try {
    const p = ff.prune(lista, opt('--suites'));
    keep = p.keep;
    if (p.gone.length) {
      for (const x of p.gone) process.stderr.write(`[test-gate] ${x.ruta}: ya no está en suites.json, la saco de la lista\n`);
      marker.testsFailed = [...ajenas, ...keep];
      marker.lastTouch = nowIso();
      writeMarker(marker);
    }
  } catch (e) {
    process.stderr.write(`[test-gate] ⚠️  no pude leer ${opt('--suites')} (${e.message}): la lista queda como está\n`);
  }
  if (!keep.length) return;
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
  const base = ['bash', q(opt('--gate')), q(opt('--repo')), ...(opt('--story') ? [q(opt('--story'))] : [])].join(' ');
  process.stderr.write(`🟡 [test-gate] no corrí la suite completa: en la última fallaron ${keep.length} suite(s) y todavía no salieron verdes solas. Repetí primero cada una:\n`);
  for (const x of keep) process.stderr.write(`   ${base} --suite ${q(x.ruta)}\n`);
  process.stderr.write('   Cuando salgan todas verdes, la corrida completa arranca.\n');
  process.exit(TESTS_FAILED_PENDING);
}

/**
 * `mark-tests-not-measured`: la salida 3 de test-gate.sh es «sin medir» (no reconoce ninguna herramienta de pruebas en el
 * repo y no corrió nada). Pone `sin-medir` sobre cualquier estado anterior: un verde de otra corrida no puede quedar en
 * pie. No es verde ni un rojo para arreglar: complete-step run-tests y «Preparar el commit» lo anuncian (nunca un verde callado). Sólo lo
 * llama test-gate.sh.
 */
/** La línea que dicen «Correr las pruebas» y «Preparar el commit» cuando el check `tests` quedó «sin medir». */
function testsNotMeasuredLine(marker) {
  const r = String((marker && marker.testsNotMeasuredReason) || '');
  const m = r.match(/no encontré (un proyecto de [^.]*?)(?:\. |$)/);
  return `pruebas no medidas: el portón no sabe correr las pruebas de este repo${m ? ` (no encontré ${m[1]})` : ''}`;
}

function cmdMarkTestsNotMeasured(motivo) {
  if (process.env.TYCON_TEST_GATE !== '1') {
    console.error('marker.js mark-tests-not-measured: sólo lo usa test-gate.sh (TYCON_TEST_GATE=1)');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) return;   // sin corrida activa no hay nada que marcar, como run-check
  marker.checks = marker.checks || {};
  marker.checks.tests = 'sin-medir';
  marker.checksProvenance = marker.checksProvenance || {};
  marker.checksProvenance.tests = 'test-gate';
  marker.checksAt = marker.checksAt || {};
  marker.checksAt.tests = nowIso();
  marker.testsNotMeasuredReason = String(motivo || '').slice(0, 600);
  writeMarker(marker);
  appendLog('gates.log', { sessionId: marker.sessionId || null, storyId: marker.storyId || null, check: 'tests',
    status: 'sin-medir', provenance: 'test-gate', motivo: String(motivo || '').slice(0, 300) });
}

function cmdSetCheck(name, status, flag) {
  if (!name || !status) {
    console.error('marker.js set-check: <name> <status> requeridos');
    console.error(`  <name> ∈ ${VALID_CHECKS.join(' | ')}; <status> = green | red:<detalle>`);
    process.exit(2);
  }
  if (!VALID_CHECKS.includes(name)) {
    console.error(`marker.js set-check: name inválido '${name}' — válidos: ${VALID_CHECKS.join(' | ')}`);
    process.exit(2);
  }
  if (name === 'acmatrix') {
    // La matriz runtime NO se ASERTA — se COMPUTA. complete-step prepare-commit la re-computa en proceso;
    // un set-check acmatrix green sería un breadcrumb engañoso (y una vía de forja). Rechazado.
    console.error("marker.js set-check: 'acmatrix' no se puede setear a mano — se computa.");
    console.error('  Para VER el estado: run-check acmatrix -- node <skill>/scripts/runtime-matrix.js --story <spec>');
    console.error('  El gate real de complete-step prepare-commit re-computa la matriz solo; no confía en el check.');
    process.exit(2);
  }
  if (status !== 'green' && !status.startsWith('red')) {
    console.error(`marker.js set-check: status inválido '${status}' — esperaba 'green' o 'red:<detalle>'`);
    process.exit(2);
  }
  // set-check EXIGE --manual explícito. Sin ese flag, en modo autónomo un green colado por
  // self-report escaparía el loop (el Stop-gate confía en cualquier green de marker.checks). Un
  // override manual es un acto DELIBERADO y auditable; el ground-truth no-falseable es run-check.
  // Se aceptan --manual (override normal) y --force-manual (escape para el caso DoD-UI, ver abajo).
  const isManual = flag === '--manual' || flag === '--force-manual';
  if (!isManual) {
    console.error(`marker.js set-check '${name}': RECHAZADO — requiere --manual explícito.`);
    console.error('  Para checks mecánicos (no falseables) usá: marker.js run-check ' + name + ' -- <comando> [args...]');
    console.error('  (run-check ejecuta el comando y captura el exit code REAL — no se puede colar un green).');
    console.error('  Override manual real (ej: no hay build definido): agregá --manual (queda en gates.log).');
    process.exit(2);
  }
  const marker = readMarker();
  // Sin marker (sin pipeline) → no-op silencioso. El check solo importa con pipeline activo.
  if (!marker) process.exit(0);

  if (name === 'dod') avisarBajaDePantalla(marker);
  // DoD de una story de UI NO se puede marcar manual: exige Playwright real.
  if (name === 'dod' && flag !== '--force-manual' && status === 'green' && markerStoryIsUi(marker)) {
    console.error("marker.js set-check dod: RECHAZADO — la story toca una pantalla (.tsx, .jsx, .svelte, .vue / paths FE del repo / E2E).");
    console.error("  El DoD de una story de UI NO se marca a mano: exige un E2E Playwright que asserte");
    console.error("  CADA AC de UI (regla DODRT-C5.1). Usá:");
    console.error("    marker.js run-check dod -- npx playwright test <spec> --workers=1");
    console.error("  (captura el exit code real → provenance=run-check, no falseable).");
    console.error("  Una excepción (raro, p.ej. story sin superficie de UI real) la decide la persona («autorizo force-manual»).");
    console.error("  (queda logueado como provenance=manual-forced en gates.log).");
    process.exit(2);
  }

  if (!marker.checks) marker.checks = {};
  marker.checks[name] = status;
  const prov = flag === '--force-manual' ? 'manual-forced' : 'manual';
  // Provenance: override manual explícito y auditable. El ground-truth mecánico es run-check.
  marker.checksProvenance = marker.checksProvenance || {};
  marker.checksProvenance[name] = prov;
  marker.checksAt = marker.checksAt || {};
  marker.checksAt[name] = nowIso();
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { check: name, status, provenance: prov, storyId: marker.storyId });
  process.stdout.write(`check ${name}: ${status} (${prov})\n`);
}

/**
 * run-check — ground-truth de los gates del modo autónomo.
 *
 *   marker.js run-check <name> -- <cmd> [args...]
 *
 * Lanza el comando como proceso hijo SIN shell (no pipes, no `| tail` que enmascare
 * el exit code), captura el exit code REAL y setea
 * marker.checks[name] = 'green' | 'red:exit=N'. provenance='run-check'.
 * Loguea {check, cmd, exit, durationMs} a gates.log (append-only).
 * El exit code del proceso = el del comando → gateable con && / set -e.
 *
 * Una sola corrida de cada check por repo: antes de lanzar toma el candado
 * `run-check-locks/<check>-<huella de la raíz de git>`. Si otro lo tiene, no lanza nada, no escribe el marcador
 * ni gates.log, dice desde cuándo corre el otro y de quién, y sale 75. El candado guarda el pid propio y el del hijo, y
 * vale mientras viva cualquiera de los dos: no se libera por edad (una suite completa tarda más de diez minutos), sí
 * cuando los dos murieron en esta máquina; el de otra máquina no se toca. SIGINT, SIGTERM y SIGHUP se le pasan al
 * hijo; run-check espera a que el hijo cierre, suelta el candado y sale con 128 + la señal, sin registrar la corrida.
 * Un comando que sale 75 por su cuenta se anota y sale como 1. Las marcas en rojo de
 * test-gate.sh (TYCON_TEST_GATE_MARK=1) no toman el candado.
 *
 * 🔴 EN ROJO guarda además la COLA de la salida en `cola`. Si el comando lo lanzó un script o corre
 * en segundo plano, la conversación sólo muestra «Command running in background» y la salida va a un
 * archivo que se borra: este comando es el único que ve la salida, así que la guarda él.
 * La salida se sigue mostrando mientras corre (se copia a la consola a medida que llega) y se retienen
 * sólo los últimos bytes. Se sanea ANTES de escribirla con `colaDeSalida` de tokens-digest.js —el mismo
 * saneado y el mismo tope que el rescate—, porque gates.log viaja al buzón del equipo. Si ese archivo no
 * está (arnés atrasado), NO se guarda la salida cruda: queda `cola_motivo` y el veredicto no cambia.
 * En verde no se guarda nada.
 */
function colaParaElRegistro(crudo) {
  try {
    const { dir: guias, aviso } = require('./lib/harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
    if (!guias) return { cola_motivo: `${aviso} — la salida no se guardó sin sanear` };
    const digest = require(path.join(guias, 'scripts', 'metrics', 'tokens-digest.js'));
    if (typeof digest.colaDeSalida !== 'function') {
      return { cola_motivo: 'tokens-digest.js no tiene colaDeSalida (arnés atrasado): la salida no se guardó sin sanear' };
    }
    return { cola: digest.colaDeSalida(crudo) };
  } catch (e) {
    return { cola_motivo: `no pude cargar tokens-digest.js para sanear la salida (${e.code || 'error'}): no se guardó` };
  }
}

// Bytes crudos que se retienen de la salida para armar la cola. El tope publicado (700 caracteres
// saneados) es mucho menor; se retiene de más porque sanear achica y los colores ocupan.
const COLA_BYTES_RETENIDOS = 64 * 1024;

// «Ocupado, probá después» (EX_TEMPFAIL): no se confunde con un rojo ni con las salidas 3-7 de test-gate.sh.
const RUN_CHECK_BUSY = 75;
const SENALES_RUN_CHECK = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** El candado de `name` en el repo de la carpeta actual: la ruta real de la raíz de git (sin git, la carpeta). */
function runCheckLock(name) {
  let raiz = process.cwd();
  try { raiz = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || raiz; } catch (_) { /* sin git: la carpeta */ }
  try { raiz = fs.realpathSync(raiz); } catch (_) { /* la ruta tal cual */ }
  const huella = require('crypto').createHash('sha1').update(raiz).digest('hex').slice(0, 16);
  const clave = name === 'tests-suite' ? 'tests' : name;
  return { raiz, dir: path.join(STATE_DIR, 'run-check-locks', `${clave}-${huella}`) };
}

function runCheckBusyText(name, raiz, r) {
  const quien = r.owner;
  const sacar = `Si quedó colgado (ese proceso ya no es la corrida), sacá el candado a mano: ${r.lockDir}`;
  if (!quien) {
    return `marker.js run-check: otra corrida de «${name}» está arrancando en este repo (${raiz}): su candado todavía no tiene dueño escrito. No lancé nada: esperá su resultado. Si nadie lo escribe, se libera solo al minuto. ${sacar}\n`;
  }
  const e = quien.extra || {};
  const t = e.startedAt ? new Date(e.startedAt) : null;
  const desde = t && !Number.isNaN(t.getTime()) ? `desde las ${t.toTimeString().slice(0, 5)} (${e.startedAt})` : 'desde una hora que no quedó escrita';
  const maquina = quien.host && quien.host !== os.hostname() ? `, en la máquina ${quien.host}` : '';
  return `marker.js run-check: ya hay una corrida de «${name}» en marcha en este repo (${raiz}) ${desde} (pid ${quien.pid}${maquina}, sesión ${e.session || 'sin sesión'}). No lancé nada: esperá su resultado, otra corrida igual duplica la carga de la máquina. ${sacar}\n`;
}

function cmdRunCheck(argv) {
  const name = argv[0];
  const sep = argv.indexOf('--');
  if (!name || !VALID_CHECKS.includes(name) || sep === -1 || sep + 1 >= argv.length) {
    console.error('marker.js run-check: uso — run-check <name> -- <cmd> [args...]');
    console.error(`  <name> ∈ ${VALID_CHECKS.join(' | ')}`);
    process.exit(2);
  }
  const cmdArgv = argv.slice(sep + 1);
  const marker = readMarker();
  const { spawn } = require('child_process');
  // El candado: sin el módulo (un árbol de skills sin el mecanismo) se corre como antes, sin candado. Las marcas en
  // rojo de test-gate.sh (TYCON_TEST_GATE_MARK=1) no lo toman: no corren pruebas, y con el candado de otra sesión
  // la marca no se escribiría y quedaría en pie un verde viejo.
  const lockLib = path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'lock.js');
  const marcaDeLaPuerta = process.env.TYCON_TEST_GATE_MARK === '1';
  const lock = !marcaDeLaPuerta && fs.existsSync(lockLib) ? require(lockLib) : null;
  const { raiz, dir: lockDir } = runCheckLock(name);
  const duenio = { check: name, repo: raiz, startedAt: new Date().toISOString(), session: marker ? SID : 'sin sesión' };
  let tomado = false;
  if (lock) {
    const r = lock.acquire(os.homedir(), { lockDir, extra: duenio, staleMs: null });
    if (!r.ok) {
      process.stderr.write(runCheckBusyText(name, raiz, r));
      process.exit(RUN_CHECK_BUSY);
    }
    tomado = true;
  }
  const soltar = () => { if (tomado) { tomado = false; lock.release(os.homedir(), { lockDir }); } };
  process.on('exit', soltar);
  let hijo = null;
  let cortado = 0;
  for (const [senal, n] of Object.entries(SENALES_RUN_CHECK)) {
    process.on(senal, () => {
      // El hijo puede tardar en cerrar: si sigue vivo, se espera a que cierre y recién ahí se suelta el candado.
      // Soltarlo ya dejaría arrancar otra corrida con ésta todavía en marcha. La corrida cortada no se registra.
      if (hijo && hijo.exitCode === null && hijo.signalCode === null) {
        if (cortado) return;
        cortado = n;
        try { hijo.kill(senal); } catch (_) { /* ya terminó */ }
        return;
      }
      soltar();
      process.exit(128 + n);
    });
  }
  const t0 = Date.now();
  // Sin shell, como antes. La salida se copia a la consola a medida que llega (el dev/LLM la ve igual)
  // y se retienen los últimos COLA_BYTES_RETENIDOS para la cola del registro.
  const trozos = [];
  let retenidos = 0;
  const retener = (b) => {
    trozos.push(b);
    retenidos += b.length;
    while (trozos.length > 1 && retenidos - trozos[0].length >= COLA_BYTES_RETENIDOS) retenidos -= trozos.shift().length;
  };
  let terminado = false;
  const terminar = (exitCode) => {
    if (terminado) return;
    terminado = true;
    try {
      registrarRunCheck(name, cmdArgv, marker, exitCode, Date.now() - t0, Buffer.concat(trozos).toString('utf8'));
    } finally {
      soltar();
    }
  };
  // En Windows, un `bash` a secas se lanza con el bash de Git que devuelve `findGitBash()` del arnés, nunca con el
  // primero del PATH (puede ser el lanzador de WSL). Sin bash de Git no se lanza: el check sale rojo con el motivo
  // (story 8.17, W6 · AC 48). Un programa que en Windows es sólo un `.cmd` (`npx`) también va por el bash de Git: Node
  // no lo lanza sin shell. Fuera de Windows, y para un `.exe`, el comando va tal cual.
  const lanzar = require('./lib/portable-tools.js').runCheckLaunch(cmdArgv);
  if (!lanzar.file) {
    process.stderr.write(`marker.js run-check: ${lanzar.error}\n`);
    retener(Buffer.from(`${lanzar.error}\n`));
    terminar(1);
    return;
  }
  try {
    hijo = spawn(lanzar.file, lanzar.args, { stdio: ['inherit', 'pipe', 'pipe'] });
  } catch (err) {
    retener(Buffer.from(`${err.message}\n`));
    terminar(1);
    return;
  }
  // el pid del hijo, para que el candado siga puesto si run-check muere (SIGKILL) y la suite sigue
  if (tomado && hijo.pid !== undefined) lock.writeExtra(lockDir, { ...duenio, childPid: hijo.pid });
  hijo.stdout.on('data', (b) => { process.stdout.write(b); retener(b); });
  hijo.stderr.on('data', (b) => { process.stderr.write(b); retener(b); });
  // No se pudo lanzar (ENOENT, permiso): antes execFileSync lo daba como exit 1.
  hijo.on('error', (err) => { retener(Buffer.from(`${err.message}\n`)); if (hijo.pid === undefined) terminar(1); });
  hijo.on('close', (code) => {
    if (cortado) { soltar(); process.exit(128 + cortado); }
    let c = typeof code === 'number' && code >= 0 ? code : 1;
    // 75 es «ocupado, no lancé nada»: un comando que sale 75 por su cuenta sí corrió, y se anota como 1
    if (c === RUN_CHECK_BUSY) {
      process.stderr.write(`marker.js run-check: el comando salió ${RUN_CHECK_BUSY} por su cuenta; lo anoto como 1 para no confundirlo con «otra corrida en marcha»\n`);
      c = 1;
    }
    terminar(c);
  });
}

function registrarRunCheck(name, cmdArgv, marker, exitCode, durationMs, salida) {
  const status = exitCode === 0 ? 'green' : `red:exit=${exitCode}`;
  // 🔴 `tests` distingue QUIÉN corrió la suite (decisión del dev 2026-08-13, tag
  // `dec-2026-08-13-suite-completa-al-cerrar`). `test-gate.sh` exporta TYCON_TEST_GATE=1 y corre la
  // suite ENTERA; un `run-check tests -- node --test <lista de archivos>` a mano corre la parcial y
  // queda como 'run-check'. `complete-step 4` bloquea el verde parcial. Medido en el cierre de la
  // 4.30: 872 de 2400 en verde, y la corrida completa en rojo con 13 fallas (2 de la propia story).
  // `advisors`: el único verde que vale es el de `pipeline.js check-count` SIN `--ran`/`--trust-ran`
  // (con `--ran` y sin step5-start, check-count acepta el self-report del LLM y sale 0 — hallazgo H4,
  // review 2026-08-19). Otro comando (`-- true`) → `run-check-other`. El gate del complete-step 5 sólo
  // acepta `run-check` (y el escape explícito `manual-forced`).
  const invokesCheckCount = cmdArgv.some((a) => /pipeline\.js$/.test(a)) && cmdArgv.includes('check-count');
  const prov = name === 'tests' && process.env.TYCON_TEST_GATE === '1' ? 'test-gate'
    : name !== 'advisors' ? 'run-check'
      : (cmdArgv.includes('--trust-ran') || cmdArgv.includes('--ran')) ? 'trust-ran'
        : !invokesCheckCount ? 'run-check-other'
          : 'run-check';
  // 🔴 RELEER antes de escribir (2026-09-15). El marker leído arriba es una FOTO de antes de correr
  // el comando, y el comando puede tardar horas (medido: 16% de los run-check pasan de 2 minutos; el
  // mayor, 3h07). Escribir esa foto entera pisa TODO lo que haya cambiado en el medio: el apagado del
  // modo autónomo que hizo el dev, la escalada que escribió el Stop-hook (`needs_human`,
  // `escalation_reason`), y el contador `iter`, que RETROCEDÍA — o sea que el cap anti-loop se
  // rebobinaba solo con cada suite larga. En la corrida de la story 2.17 esto deshizo 4 apagados.
  // Ahora se relee y se aplica SÓLO el delta de este comando. `marker` (la foto) se sigue usando
  // como condición: si no había corrida al arrancar, este comando no escribe nada — y si la corrida
  // se cerró mientras el comando corría, tampoco la resucita.
  if (marker) {
    const fresh = readMarker();
    if (fresh) {
      fresh.checks = fresh.checks || {};
      fresh.checks[name] = status;
      fresh.checksProvenance = fresh.checksProvenance || {};
      fresh.checksProvenance[name] = prov;
      fresh.checksAt = fresh.checksAt || {};
      fresh.checksAt[name] = nowIso();
      fresh.lastTouch = nowIso();
      writeMarker(fresh);
    }
  }
  appendLog('gates.log', {
    check: name,
    status,
    provenance: prov,
    cmd: cmdArgv.join(' '),
    exit: exitCode,
    durationMs,
    storyId: marker ? marker.storyId : null,
    ...(exitCode === 0 ? {} : colaParaElRegistro(salida)),
  });
  process.stdout.write(`check ${name}: ${status} (${prov}, ${durationMs}ms)\n`);
  // exitCode y no process.exit(): con la salida a un pipe (macOS) process.exit puede cortar lo que la
  // consola todavía no escribió. El hijo ya cerró: no queda nada que mantenga vivo al proceso.
  process.exitCode = exitCode;
}

// Flags booleanos de las partes del Arranque (el reloj / el pedido en ADO) — el resume y
// `pipeline.js next` los leen para no re-ejecutar (evita doble timer / doble
// transición de WI al retomar cross-session).
// `atddBypass`: escape consciente del portón pre-edit de ATDD (on-atdd-preedit.js) —
// para el refactor legítimo sobre red preexistente. El uso queda en bypass.log, no es silencioso.
// `waitingForHuman` — EL TERCER ESTADO del portón de autonomía.
// El Stop-hook distingue dos cosas: "podés cerrar" (todo verde) y "no cierres, arreglá" (algo en
// rojo). Este flag cubre la tercera, que es la más común: "le pregunté al dev y estoy esperando". Y como
// preguntar ES terminar el turno, sin el flag el agente queda atrapado justo cuando necesita hablar — sobre
// todo con el único rojo que él NO puede poner en verde, la matriz esperando el waiver. La única salida
// sería el botón de pánico `STOP_AUTONOMY`, que es un archivo para TODA la máquina: frena
// también las corridas de al lado y les apaga el portón (una sesión lo pone y otra lo saca:
// las corridas de al lado quedan con el portón apagado sin saberlo).
// Este flag es de UN SOLO USO y lo CONSUME el Stop-hook: deja cerrar ese turno sin tocar
// `autonomous`, y se apaga solo. Mismo patrón que `ALLOW_DOD_EVIDENCE_WRITE`.
//
// 🔴 `deepReviewDone` NO se escribe a mano. Es la bandera que cierra el pase adversarial, y cualquiera que la escriba
// la cierra sin anotar qué encontró el pase, y «Preparar el commit» la da por buena. La escriben sólo los dos
// comandos que cierran el pase con constancia: `mark-adversarial-result` (el pase corrió y se anota su
// resultado) y `mark-adversarial-skipped` (el portón decidió que no corre).
// Las banderas, en dos listas (lib/external-flags.js): las de hechos externos las pone sólo el arnés cuando hizo el
// trabajo; las de estado de la ejecución, el modelo, cada una con su motivo. `next` y el cartel también leen el nombre
// viejo de la bandera del reloj en un marker de una corrida en vuelo (no se reabre el aviso de trabajo).
const { VALID_FLAGS, EXTERNAL_FLAGS, HARNESS_COMMAND } = require('./lib/external-flags.js');
// El nombre viejo de la bandera del reloj, de cuando el paso era el reloj de una herramienta.
const OLD_FLAGS = { clockiStarted: 'workSignalStarted' };

function cmdSetFlag(flag, valRaw) {
  if (flag === 'deepReviewDone') {
    // Antes de leer el marker: el comando no escribe NADA, ni el `lastTouch`.
    console.error('marker.js set-flag: `deepReviewDone` ya no se escribe a mano — cierra el pase adversarial uno de estos dos comandos:');
    console.error('  el pase corrió  → marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --tests <k> …');
    console.error('  el pase no corre → marker.js mark-adversarial-skipped --files <archivos de código del diff>   (decide el portón)');
    console.error('  (story 1.8: con la bandera suelta, 4 de 9 ejecuciones cerraron el pase sin anotar qué encontró el pase)');
    process.exit(2);
  }
  const real = OLD_FLAGS[flag] || flag;
  if (EXTERNAL_FLAGS.includes(real)) {
    // Antes de leer el marker: el comando no escribe NADA. La bandera dice que algo de afuera se hizo; la pone el arnés.
    console.error(`marker.js set-flag: \`${flag}\` no se escribe a mano — la pone el arnés cuando hizo el trabajo: ${HARNESS_COMMAND[real]}.`);
    console.error(`  Si la herramienta está caída o falta: marker.js start-warning ${real === 'adoMarkedActive' ? 'ado' : 'time-tracking'} "<motivo>" y seguí.`);
    process.exit(2);
  }
  if (!flag || !VALID_FLAGS.includes(flag)) {
    console.error(`marker.js set-flag: flag inválido '${flag}' — válidos: ${VALID_FLAGS.join(' | ')}`);
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-flag: no hay marker activo para esta sesión');
    process.exit(1);
  }
  marker[flag] = valRaw === 'true' || valRaw === '1';
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(`${flag}: ${marker[flag]}\n`);
}

// Una parte opcional del Arranque que corrió y falló: `start-warning <time-tracking|ado> "<motivo>"`. El Arranque
// cierra igual (la falla de una parte nunca frenó la ejecución), pero el aviso queda a la vista hasta el cierre: en
// `next`, en el cartel, en /pipeline y en la salida de `complete-step prepare-commit`. Sin motivo, o sobre una parte que
// ya corrió, no se escribe nada; el mismo motivo dos veces no suma otra línea a gates.log.
function cmdStartWarning(part, mensaje) {
  if (!STEPS_LIB.START_PARTS[part]) {
    console.error(`marker.js start-warning: parte inválida '${part}' — válidas: ${Object.keys(STEPS_LIB.START_PARTS).join(' | ')}`);
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js start-warning: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const motivo = String(nn(mensaje, '')).trim().slice(0, 300);
  if (!motivo) {
    console.error(`marker.js start-warning: falta el motivo — uso: start-warning ${part} "<qué no anduvo: el MCP no contesta, az no está, 401…>"`);
    process.exit(2);
  }
  if (STEPS_LIB.START_PARTS[part].flags.some((f) => marker[f] === true)) {
    console.error(`marker.js start-warning: ${STEPS_LIB.START_PARTS[part].name} ya corrió (su bandera está puesta): no hay nada que declarar`);
    process.exit(2);
  }
  const lista = Array.isArray(marker.startWarnings) ? marker.startWarnings : [];
  if (lista.some((w) => w && w.part === part && w.message === motivo)) {
    process.stdout.write(`${STEPS_LIB.startWarningLines({ startWarnings: [{ part }] })[0]}\n`);
    return;
  }
  marker.startWarnings = [...lista.filter((w) => w && w.part !== part), { part, message: motivo }];
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'start-warning', part, motivo, at: nowIso(), story: nn(marker.storyId, null) });
  process.stdout.write(`${STEPS_LIB.startWarningLines({ startWarnings: [{ part }] })[0]}\n`);
}

// El valor de una opción `--<nombre> <valor>` de la línea, recortado; '' si falta.
function opcion(args, nombre) {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 ? String(nn(args[i + 1], '')).trim() : '';
}

// Cerrar una historia por su salida prevista: `close-as-debt --reason "<texto>" --debt <DEF-id>`. La frase de la persona
// la pide el freno de seguridad (ESC-C4) antes de que esto corra. El marcador recibe `cierre = deuda` y la ejecución
// SIGUE: la deuda tiene que llegar al commit (revisores sobre lo que sí cambió, el pase y la línea `Deuda:`); el
// `clear` del final conserva el cierre escrito. La deuda tiene que estar anotada antes: en la historia o en el
// `tasks/todo.md` de su repo.
function cmdCloseAsDebt(args) {
  // el motivo y la deuda viajan en el volcado que sube al buzón: sin rutas, credenciales ni correos (el saneador de la
  // subida); sin él en este árbol, el texto como vino
  let sanear = (t) => t;
  try { sanear = require(path.join(__dirname, '..', '..', '..', 'scripts', 'metrics', 'tokens-digest.js')).sanear; } catch (_) { /* sin el saneador */ }
  const motivo = String(sanear(opcion(args, 'reason'))).slice(0, 300);
  const deuda = String(sanear(opcion(args, 'debt'))).slice(0, 80);
  if (!motivo || !deuda) {
    console.error('marker.js close-as-debt: uso: close-as-debt --reason "<qué quedó pendiente y por qué>" --debt <DEF-id>');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js close-as-debt: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const story = resolveStoryPath(marker.storyPath, marker);
  let raiz = story ? path.dirname(path.dirname(story)) : null;
  if (story) {
    try { raiz = require('child_process').execFileSync('git', ['-C', path.dirname(story), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || raiz; } catch (_) { /* sin git: la carpeta de arriba */ }
  }
  const todo = raiz ? path.join(raiz, 'tasks', 'todo.md') : null;
  // el id entero, como palabra: el comienzo de un id anotado no es ese id, y una letra suelta no es una deuda
  if (!/^[A-Za-z][\w.-]{3,}$/.test(deuda)) {
    console.error(`marker.js close-as-debt: «${deuda}» no parece el id de una deuda (por ejemplo DEF-9.9-angular): pasá el id entero que anotaste`);
    process.exit(2);
  }
  const palabra = new RegExp(`(^|[^\\w.-])${deuda.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-]|\\.(?![\\w-]))`);
  const tiene = (f) => { try { return palabra.test(fs.readFileSync(f, 'utf8')); } catch (_) { return false; } };
  if (!((story && tiene(story)) || (todo && tiene(todo)))) {
    console.error(`marker.js close-as-debt: la deuda ${deuda} no está anotada. Anotala antes en el Dev Agent Record de la historia`);
    console.error(`  (${story || marker.storyPath || 'la historia'})${todo ? ` o en ${todo}` : ''}, con lo que quedó pendiente, y volvé a correr esto.`);
    console.error('  El repo puede no tener tasks/todo.md: alcanza con la historia.');
    process.exit(2);
  }
  const frenos = require('./lib/run-close.js').leerFrenos();
  const l = frenos ? require('./lib/run-close.js').escapeDeCierre(frenos, SID, marker.startedAt, 'cerrar-como-deuda') : null;
  const via = l && ['persona', 'reenvio'].includes(l.via) ? l.via : null;
  // la frase la juzga el freno; acá se exige su constancia: si el freno no vio la llamada (un nombre armado, otra copia
  // del guion), la deuda no se cierra sin que una persona la haya autorizado
  if (!via) {
    console.error(frenos
      ? 'marker.js close-as-debt: no encuentro la constancia de que una persona autorizó esta deuda («autorizo cerrar como deuda», regla ESC-C4 del freno de seguridad). Pedile la frase y volvé a correr el comando tal cual.'
      : 'marker.js close-as-debt: no pude leer el registro de escapes del freno de seguridad: sin él no sé si una persona autorizó la deuda.');
    process.exit(2);
  }
  marker.cierre = { estado: 'deuda', motivo, deuda, via, ...(l.relevo ? { relevo: l.relevo } : {}), at: nowIso() };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'close-as-debt', story: nn(marker.storyId, null), deuda, motivo, via });
  process.stdout.write(`cierre: deuda (${deuda}) — la ejecución sigue hasta el commit: revisores sobre lo que sí cambió, el pase y la línea «Deuda:» del mensaje.\n`);
}

// Un control en rojo que la historia en deuda deja así a propósito: `expect-red <control> --tests <T2,T5>`. Sólo en una
// ejecución en deuda y sobre un control en rojo; queda `rojo-esperado:exit=N` con la lista, que el cierre del turno y
// `prepare-commit` aceptan sólo con la deuda escrita. Antes, el paso pide ajustar las pruebas para que verifiquen la
// deuda: esto es para cuando no se puede.
function cmdExpectRed(args) {
  const check = String(nn(args[0], '')).trim();
  const tests = opcion(args, 'tests').split(',').map((s) => s.trim()).filter(Boolean);
  if (!check || check.startsWith('--') || !tests.length) {
    console.error('marker.js expect-red: uso: expect-red <control> --tests <T2,T5>   (las pruebas que quedan en rojo a propósito)');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js expect-red: no hay marker activo para esta sesión');
    process.exit(1);
  }
  if (!marker.cierre || marker.cierre.estado !== 'deuda') {
    console.error('marker.js expect-red: sólo en una ejecución en deuda — primero marker.js close-as-debt --reason "<texto>" --debt <DEF-id> (con la frase de la persona)');
    process.exit(2);
  }
  const actual = String(nn(at(marker.checks, check), ''));
  const m = /^red:exit=(\d+)/.exec(actual);
  if (!m) {
    console.error(`marker.js expect-red: el control ${check} no está en rojo (${actual || 'sin registrar'}): no hay rojo que esperar`);
    process.exit(2);
  }
  marker.checks[check] = `rojo-esperado:exit=${m[1]}`;
  marker.expectedRed = Object.assign({}, marker.expectedRed, { [check]: { tests, deuda: marker.cierre.deuda, at: nowIso() } });
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'expect-red', story: nn(marker.storyId, null), check, tests, deuda: marker.cierre.deuda });
  process.stdout.write(`${check}: rojo-esperado:exit=${m[1]} (${tests.join(', ')}) — deuda ${marker.cierre.deuda}\n`);
}

// Forzar el tamaño de la corrida a mano: `set-size liviana|completa --reason "<texto>"`. Sin motivo no se
// escribe nada (nadie sabría después por qué se saltó el pase). Forzar a liviana una story que declara código queda en
// bypass.log: es apagar el pase adversarial a sabiendas.
function cmdSetSize(args) {
  const SIZES = ['liviana', 'completa'];
  const size = args[0];
  const i = args.indexOf('--reason');
  const reason = i >= 0 ? String(args[i + 1] || '').trim() : '';
  if (!SIZES.includes(size)) {
    console.error(`marker.js set-size: tamaño inválido '${size || ''}' — válidos: ${SIZES.join(' | ')}`);
    process.exit(2);
  }
  if (!reason) {
    console.error('marker.js set-size: falta el motivo — marker.js set-size <liviana|completa> --reason "<por qué>"');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-size: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const by = process.env.USER || process.env.USERNAME || marker.sessionId || 'desconocido';
  let declared = null;
  try {
    declared = require('./pipeline.js').computeRunSize({ story: marker.storyPath, repo: marker.repoPath });
  } catch (e) {
    console.error(`marker.js set-size: no pude clasificar lo que declara la story (${String(e.message || e).split('\n')[0]}); se guarda igual`);
  }
  const prev = marker.size || null;
  marker.size = size;
  marker.size_reason = `forzado a mano: ${reason}`;
  marker.sizeForced = { by, reason, at: nowIso(), from: prev };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  if (size === 'liviana' && declared && declared.size === 'completa') {
    appendLog('bypass.log', { kind: 'SIZE_FORCED_LIGHT_WITH_CODE', storyId: marker.storyId, by, reason, declared: declared.reason });
    console.error(`⚠️  la story declara algo que no es documentación (${declared.reason}): forzarla a liviana apaga el pase adversarial — queda en bypass.log`);
  }
  process.stdout.write(`size: ${size} (${reason})\n`);
}

// El pedido para esta corrida: `set-models <trabajo>=<modelo> … | --clear`. `<trabajo>` es
// reviewers, reviewers_reloop, adversarial, helpers o el nombre de un revisor; `<modelo>`, un nivel o un nombre del
// vocabulario de lib/models.js, y se guarda el modelo de Claude. Con techo obligatorio, pipeline.js lo recorta y lo
// dice. Se valida todo antes de escribir nada.
function cmdSetModels(args) {
  const M = require('./lib/models.js');
  const clear = args.includes('--clear');
  const pares = args.filter((a) => a !== '--clear');
  if (!clear && !pares.length) {
    console.error('uso: marker.js set-models <trabajo>=<nivel> … | --clear   (trabajos: reviewers, reviewers_reloop, adversarial, helpers o un revisor; niveles: ' + M.LEVELS.join(', ') + '; también ' + M.MODELS.join(', ') + ')');
    process.exit(2);
  }
  const values = {};
  for (const p of pares) {
    const [job, model, ...resto] = String(p).split('=');
    if (resto.length || !M.isJobName(job) || !M.modelOf(model)) {
      console.error(`marker.js set-models: «${p}» no es <trabajo>=<nivel> (trabajos: ${M.JOBS.join(', ')} o un revisor en minúsculas, números y guiones; niveles: ${M.LEVELS.join(', ')}; también ${M.MODELS.join(', ')}) — no escribí nada`);
      process.exit(2);
    }
    values[job] = M.modelOf(model);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-models: no hay marker activo para esta sesión (sin corrida, el pedido son sólo las banderas de cada comando)');
    process.exit(1);
  }
  if (clear) delete marker.modelRequests;
  else marker.modelRequests = { values: { ...((marker.modelRequests && marker.modelRequests.values) || {}), ...values }, at: nowIso(), sessionId: marker.sessionId || null };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'set-models', storyId: marker.storyId || null, ...(clear ? { clear: true } : { values }) });
  process.stdout.write(clear ? 'modelRequests: borrado\n' : `modelRequests: ${JSON.stringify(marker.modelRequests.values)}\n`);
}

// `mark-models-warned <clave> …`: lo ya avisado del techo en esta corrida (pipeline.js lo anota solo al
// emitir `models_warnings`; el subcomando queda para el orquestador y las pruebas).
function cmdMarkModelsWarned(keys) {
  if (!keys.length) { console.error('uso: marker.js mark-models-warned <clave> …'); process.exit(2); }
  const marker = readMarker();
  if (!marker) { console.error('marker.js mark-models-warned: no hay marker activo para esta sesión'); process.exit(1); }
  marker.modelsWarned = [...new Set([...(Array.isArray(marker.modelsWarned) ? marker.modelsWarned : []), ...keys])];
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(`modelsWarned: ${marker.modelsWarned.join(', ')}\n`);
}

// Estado estructurado del pase adversarial
// cuando se lanza TEMPRANO (al cierre de «Correr las pruebas», en paralelo con los revisores).
//
// marker.adversarial = { launchedAtStep, runId, sessionId, launchedAt }
//
// El sessionId es la clave de la DETECCIÓN DE ORFANDAD: el resume de un Workflow es
// same-session-only (memoria del equipo: un runId de otra sesión no se puede joinear
// ni resumir — re-corre todo). El paso «Pase adversarial» (join) compara adversarial.sessionId con la
// sesión actual: igual → join pasivo (esperar la notificación); distinto → el workflow
// quedó huérfano de una sesión muerta, se anuncia y se RELANZA (este comando permite el
// overwrite cross-session exactamente para eso). Sin este campo, la sesión nueva no
// puede distinguir "está corriendo acá" de "murió con la sesión anterior" — y el join
// colgaría esperando algo que jamás llega.
//
// Guard anti-doble-lanzamiento: re-llamar DESDE LA MISMA SESIÓN es un bug del
// orquestador (el pase corre UNA vez por ejecución) → exit 2. El campo NO se borra al
// completar el pase (deepReviewDone=true) — queda como evidencia de auditoría.
function cmdMarkAdversarialLaunched(runId, stepRaw) {
  if (!runId) {
    console.error('marker.js mark-adversarial-launched: runId requerido (1er argumento posicional)');
    process.exit(2);
  }
  // Whitelist explícita del step: el campo es evidencia de auditoría ("¿se lanzó temprano o en el
  // lugar clásico?") — basura o typos ('banana', '5B') NO caen a 4 en silencio.
  const stepArg = String(nn(stepRaw, '4')).toLowerCase();
  if (!['4', '5b'].includes(stepArg)) {
    console.error(`marker.js mark-adversarial-launched: step inválido '${stepRaw}' — debe ser 4 o 5b`);
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js mark-adversarial-launched: no hay marker activo para esta sesión');
    process.exit(1);
  }
  // Escape hatch del guard: --relaunch permite el overwrite same-session
  // para los relanzamientos LEGÍTIMOS (workflow que devolvió no-op por files vacío, diff stale por
  // gate ATDD post-lanzamiento). Queda auditado en bypass.log, mismo patrón que --no-atdd.
  const relaunch = process.argv.includes('--relaunch');
  if (marker.adversarial && marker.adversarial.sessionId === SID && !relaunch) {
    console.error(
      `marker.js mark-adversarial-launched: el pase adversarial YA se lanzó en esta sesión ` +
      `(runId ${marker.adversarial.runId}, step ${marker.adversarial.launchedAtStep}). ` +
      `Corre UNA vez por corrida — el join es el paso «Pase adversarial», no un re-lanzamiento. ` +
      `Si el relanzamiento es legítimo (no-op por files vacío / diff stale), usá --relaunch (queda en bypass.log).`
    );
    process.exit(2);
  }
  if (marker.adversarial && marker.adversarial.sessionId === SID && relaunch) {
    appendLog('bypass.log', {
      kind: 'ADVERSARIAL_RELAUNCH', story: marker.storyId,
      prevRunId: marker.adversarial.runId, newRunId: String(runId),
    });
    console.error('⚠️  Relanzamiento same-session con --relaunch (queda en bypass.log).');
  }
  if (marker.adversarial && marker.adversarial.sessionId !== SID) {
    // Adopción de huérfano: la sesión que lo lanzó ya no existe, así que el overwrite es legítimo.
    process.stdout.write(
      `adversarial huérfano detectado (sesión ${marker.adversarial.sessionId}, ` +
      `runId ${marker.adversarial.runId}) → overwrite con relanzamiento de esta sesión\n`
    );
  }
  marker.adversarial = {
    // 4 = lanzamiento temprano (cierre de «Correr las pruebas») · '5b' = fallback / relanzamiento.
    launchedAtStep: stepArg === '5b' ? '5b' : 4,
    runId: String(runId),
    sessionId: SID,
    launchedAt: nowIso(),
  };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(JSON.stringify(marker.adversarial, null, 2) + '\n');
}

// marker.js mark-adversarial-skipped --files <archivos de código del diff> [--no-deep-review]
//
// El cierre sin pase: lo decide el PORTÓN, no quien lo anota. Un salteo tiene que venir del portón: una
// bandera suelta sería igual para «el portón lo salteó», «me olvidé» y «lo dejé corriendo y no miré
// qué encontró». Mismo principio que `complete-step approve-plan --auto-approved`, que no cree en el «LOW»
// declarado y recomputa.
//
// 🔴 El portón se llama como PROCESO (`pipeline.js deep-review-gate`), no como función: así hereda su guarda
// de aridad (`--files` sin partir → exit 2, para no sellar el step con 1 archivo contado) y su «no
// pude medir» (`run: null` sin `--files`) sin copiarlos. Dos copias del criterio se separan solas.
//
// «Forzado» lo decide el interruptor presente (TYCON_NO_DEEP_REVIEW=1 o --no-deep-review), no el texto del
// `reason`. Con el pase ya lanzado, sin interruptor se niega (un pase lanzado se cierra con su resultado);
// con interruptor se anota como ABANDONO, con el runId del lanzamiento, y queda en bypass.log.
function cmdMarkAdversarialSkipped(argsGate) {
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js mark-adversarial-skipped: no hay corrida del pipeline en esta sesión — el salteo del pase adversarial se anota sobre una ejecución');
    process.exit(2);
  }
  const args = [...(argsGate || [])];
  const forzado = process.env.TYCON_NO_DEEP_REVIEW === '1' || args.includes('--no-deep-review');
  const lanzado = marker.adversarial ? (typeof marker.adversarial === 'object' ? marker.adversarial : {}) : null;
  if (lanzado && !forzado) {
    console.error(`marker.js mark-adversarial-skipped: el pase adversarial YA se lanzó (runId ${lanzado.runId || '?'}, ${lanzado.launchedAt || 'sin fecha'}) — un pase lanzado se cierra con su resultado:`);
    console.error('    marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --tests <k> …');
    console.error('  Abandonarlo lo decide la persona, no el agente: lo dice ella en su mensaje («autorizo TYCON_NO_DEEP_REVIEW»),');
    console.error('  y queda en bypass.log como ADVERSARIAL_ABANDONADO.');
    process.exit(2);
  }
  if (!args.includes('--repo')) args.push('--repo', marker.repoPath || process.cwd());
  const story = resolveStoryPath(marker.storyPath, marker);
  if (!args.includes('--story') && story) args.push('--story', story);
  // spawnSync y no execFileSync: con exit 0 execFileSync no devuelve el stderr.
  const r = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'pipeline.js'), 'deep-review-gate', ...args],
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gate = null;
  if (r.status === 0) { try { gate = JSON.parse(r.stdout); } catch (_e) { gate = null; } }
  if (!gate || typeof gate !== 'object') {
    const detalle = String(r.stderr || '').trim()
      || (r.error && r.error.message)
      || `el portón salió ${r.status} sin decir por qué${r.stdout ? ` (stdout: ${String(r.stdout).trim().slice(0, 200)})` : ''}`;
    console.error(`marker.js mark-adversarial-skipped: no pude evaluar el portón — ${detalle}`);
    console.error('  «No pude mirar» no es «se puede saltear»: arreglá la llamada (los --files del diff, partidos) y repetí. No se anotó nada.');
    process.exit(2);
  }
  if (gate.run !== false) {
    console.error(`marker.js mark-adversarial-skipped: el portón dice que el pase CORRE — ${gate.reason || '(sin reason)'}`);
    console.error('  No se saltea: se lanza (guía del pase adversarial §Lanzamiento temprano o §Acción) y se registra con');
    console.error('    marker.js mark-adversarial-launched <runId> 4');
    console.error('  No se anotó el salteo (el veredicto del portón sí queda en la corrida: `next` pide el lanzamiento).');
    process.exit(2);
  }
  // Se cuentan como los cuenta `parseArgs` de pipeline.js: todos los `--files`, cortando en un argumento
  // vacío o que empieza con `--`. Si no, el número anotado no es el que midió el portón.
  let archivos = 0;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--files') continue;
    while (args[i + 1] && !String(args[i + 1]).startsWith('--')) { archivos += 1; i += 1; }
  }
  const abandonado = !!lanzado;
  const runId = abandonado ? (lanzado.runId || null) : null;
  const at = nowIso();
  const salteo = { motivo: gate.reason || null, archivos, forzado, abandonado, runId, at };
  // Se relee: el portón que se acaba de lanzar anota su veredicto en el marker (`adversarialGate`), y
  // escribir la copia leída antes lo pisaría.
  const fresco = readMarker() || marker;
  // UNA escritura: el salteo y el cierre del pase nacen juntos — no hay un instante con uno y sin el otro.
  fresco.adversarialSkip = salteo;
  fresco.deepReviewDone = true;
  fresco.lastTouch = at;
  writeMarker(fresco);
  appendLog('gates.log', {
    name: 'adversarial-skip', status: 'ok', storyId: marker.storyId, motivo: salteo.motivo,
    archivos, forzado, abandonado, runId,
  });
  if (abandonado) {
    appendLog('bypass.log', { kind: 'ADVERSARIAL_ABANDONADO', storyId: marker.storyId, runId, motivo: salteo.motivo });
    console.error(`⚠️  pase adversarial ABANDONADO (runId ${runId || '?'}) con el interruptor — queda en bypass.log.`);
  } else if (forzado) {
    appendLog('bypass.log', { kind: 'ADVERSARIAL_SKIP_FORZADO', storyId: marker.storyId, motivo: salteo.motivo });
    console.error('⚠️  salteo del pase adversarial FORZADO con el interruptor — queda en bypass.log.');
  }
  process.stdout.write(JSON.stringify(salteo, null, 2) + '\n');
}

// marker.js mark-adversarial-gate '<json>'   ({ run?: bool, files?: [..], early_env?: '0'|'1'|null })
//
// El veredicto del portón del pase, anotado en la corrida. Lo llaman `pipeline.js
// deep-review-gate` (con `run` y `files`, después de «Correr las pruebas») y `pipeline.js next` (sólo `early_env`, cuando ve la
// variable): `next` no tiene los archivos del cambio y no recalcula el portón, lee esto.
//
// 🔴 Va en un campo PROPIO, `adversarialGate`, nunca dentro de `marker.adversarial`: para el salteo, el freno del
// «Preparar el commit», `next` y el paso de revisores, `adversarial` significa «lanzado» (con él, `mark-adversarial-skipped` se niega).
//
// El temprano apagado (`TYCON_5B_EARLY=0`) se lee del entorno de UN comando, y en una sesión de agente el entorno no
// pasa de un comando al siguiente (un `next` suelto no lleva la variable que tuvo el comando anterior).
// Visto una vez, vale para la corrida; `TYCON_5B_EARLY=1` explícito lo vuelve a prender. Las dos cosas quedan
// anotadas con su origen. Con el pase ya atendido no se reemplaza el veredicto: la consulta es de otro momento.
// Sale con el `adversarialGate` vigente en stdout (el portón imprime el temprano que vale para la corrida).
function cmdMarkAdversarialGate(raw) {
  const marker = readMarker();
  if (!marker) process.exit(0);   // sin corrida no se anota ni se avisa: el portón se consulta también a mano
  let d;
  try { d = JSON.parse(String(raw || '')); } catch (_e) { d = null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    console.error('marker.js mark-adversarial-gate: hace falta un JSON con { run?, files?, early_env? }');
    process.exit(2);
  }
  const prev = marker.adversarialGate && typeof marker.adversarialGate === 'object' ? marker.adversarialGate : null;
  const traeVeredicto = typeof d.run === 'boolean';
  if (traeVeredicto && paseAtendido(veredictoPaseAdversarial(marker))) {
    process.stdout.write(JSON.stringify(prev || {}, null, 2) + '\n');
    return;
  }
  let early = true;
  let origen = null;
  if (d.early_env === '0') { early = false; origen = 'TYCON_5B_EARLY=0'; }
  else if (d.early_env === '1') { early = true; origen = 'TYCON_5B_EARLY=1'; }
  else if (prev && prev.early_launch === false) { early = false; origen = prev.early_origin || null; }
  else if (prev && prev.early_origin) { origen = prev.early_origin; }
  const gate = {
    ...(prev || {}),
    ...(traeVeredicto ? { run: d.run, files: Array.isArray(d.files) ? d.files.map(String) : [] } : {}),
    early_launch: early,
    at: nowIso(),
    sessionId: SID,
  };
  if (origen) gate.early_origin = origen; else delete gate.early_origin;
  marker.adversarialGate = gate;
  marker.lastTouch = gate.at;
  writeMarker(marker);
  process.stdout.write(JSON.stringify(gate, null, 2) + '\n');
}

// Resultado de un pase adversarial. Un pase corrido DESPUÉS del cierre formal de los revisores puede
// encontrar defectos graves y, sin constancia, el merge sale igual. Sólo las iteraciones de revisores
// dejan línea en gates.log: sin esta constancia, el pase y su veredicto son invisibles para la retrospectiva.
//
// El veredicto sale de un NÚMERO, no de prosa: con hallazgos confirmados, lo que se revisó no estaba
// listo. Sirve igual para el pase adversarial del pipeline y para una revisión lanzada a mano después del cierre
// (sin marker hay que decir de qué story es: una línea sin story no la puede cruzar nadie).
// `head` es el commit sobre el que se anotó: lo que permite comparar después contra el merge.
function cmdMarkAdversarialResult(countRaw) {
  const argv = process.argv;
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!/^\d+$/.test(String(nn(countRaw, '')))) {
    console.error('marker.js mark-adversarial-result: <confirmados> tiene que ser un entero ≥ 0 (los hallazgos que el pase confirmó)');
    process.exit(2);
  }
  const confirmados = parseInt(countRaw, 10);
  const tipo = String(flag('--type') || '5b').toLowerCase();
  if (!['5b', 'revision'].includes(tipo)) {
    console.error(`marker.js mark-adversarial-result: --type inválido '${flag('--type')}' — 5b (el del pipeline) o revision (una lanzada a mano)`);
    process.exit(2);
  }
  const marker = readMarker();
  const storyId = flag('--story') || (marker && marker.storyId) || null;
  if (!storyId) {
    console.error('marker.js mark-adversarial-result: no hay corrida del pipeline en esta sesión — pasá --story <id> para saber de qué story es el pase');
    process.exit(2);
  }
  // El pase es de la corrida sólo si es de SU story: con
  // `--story B` en una corrida de A, el resultado de B se sumaba a A y le cerraba el pase. De otra story: sólo la
  // línea de gates.log, como una revisión sin corrida.
  const corrida = marker && storyId === marker.storyId ? marker : null;
  // 🔴 EL NÚMERO SALE DEL RESULTADO, NO DE QUIEN LO ANOTA. Con `<N>` solo, un pase cuyos
  // agentes murieron (Codex en su tope) se anotaba `0` y salía `listo`: nada leía lo que devolvió el pase. El pase adversarial exige
  // `--result <archivo>` —el JSON del pase, `<RUN_DIR>/step-05b-adversarial.json`—; de ahí salen los confirmados
  // (tienen que coincidir con `<N>`), las lentes sin medir y los hallazgos sin veredicto. Con alguno de los dos la
  // línea queda `no-medido`, que NO cierra el pase. Una revisión a mano (`--type revision`) no lo exige.
  const resultadoRuta = flag('--result');
  let medicion = null;
  if (tipo === '5b' || resultadoRuta !== undefined) {
    const { medicionDelResultado, SALIDA_APROBADA } = require('./lib/adversarial-verdict.js');
    if (!resultadoRuta) {
      console.error('marker.js mark-adversarial-result: el pase adversarial se anota con --result <archivo>: el JSON que devolvió el pase (<RUN_DIR>/step-05b-adversarial.json). El número sale de ahí, no del que anota.');
      console.error(`  Si el pase no corrió entero: relanzalo, o ${SALIDA_APROBADA}.`);
      process.exit(2);
    }
    const abs = path.resolve(resultadoRuta);
    let obj;
    try { obj = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) {
      console.error(`marker.js mark-adversarial-result: --result ${abs}: no lo pude leer como JSON (${e.message.split('\n')[0]}) — no se anotó nada.`);
      process.exit(2);
    }
    try { medicion = medicionDelResultado(obj); } catch (e) {
      console.error(`marker.js mark-adversarial-result: --result ${abs}: ${e.message} — no se anotó nada.`);
      process.exit(2);
    }
    const lanz = corrida && corrida.adversarial && typeof corrida.adversarial === 'object' ? Date.parse(corrida.adversarial.launchedAt) : NaN;
    if (!Number.isFinite(lanz)) {
      console.error(`⚠️  marker.js mark-adversarial-result: no hay lanzamiento del pase con fecha en esta corrida: no pude comprobar que ${abs} sea de este pase y no de otro.`);
    } else if (fs.statSync(abs).mtimeMs < lanz) {
      console.error(`marker.js mark-adversarial-result: --result ${abs} es anterior al lanzamiento vigente del pase (${corrida.adversarial.launchedAt}): es el resultado de otro lanzamiento — no se anotó nada.`);
      process.exit(2);
    }
    if (medicion.confirmados !== confirmados) {
      console.error(`marker.js mark-adversarial-result: <N> = ${confirmados} pero el resultado trae ${medicion.confirmados} confirmado(s) — se anota lo que devolvió el pase.`);
      process.exit(2);
    }
    medicion.ruta = abs;
  }
  // 🔴 CADA CONFIRMADO TERMINA EN LA SUITE O SE DIFIERE CON MOTIVO.
  // El paso «Pase adversarial» pide un test de regresión por cada bug confirmado, y este comando lo verifica: si el
  // verificador borrara su prueba, el pipeline no puede seguir. Con hallazgos, este comando no
  // anota el pase sin que se declare cuántos ya tienen su prueba en la suite (`--tests k`,
  // promovidas con `promote-probe`, que es lo que se cuenta — no lo que se dice) y cuántos se
  // difieren (`--deferred d --reason "…"`: un hallazgo en código preexistente que va a una story
  // aparte). k + d tiene que dar N: un confirmado sin destino
  // escrito es un bug que se pierde en silencio.
  // 🔴 LA PRUEBA ESCRITA A MANO TAMBIÉN CUENTA. Con sólo `--tests` (= lo que pasó por promote-probe),
  // un hallazgo ya arreglado con su prueba se declararía diferido. Las pruebas escritas dentro de suites
  // existentes son justo lo que promote-probe manda a hacer («editalo a mano»). `--own p --in
  // <rutas>` cuenta esas; y como `--tests`, no se cree: cada ruta tiene que estar en el repo, existir, ser una
  // prueba (el criterio del freno ATDD) y haberse editado en ESTA corrida después del lanzamiento del pase.
  // Una misma ruta cubre varios hallazgos: no se pide una por hallazgo.
  // `--in` trae su nombre ya traducido (aliasArgv, al entrar).
  const iEn = argv.indexOf('--in');
  const hayEn = iEn >= 0;
  const propiasRaw = flag('--own');
  if (propiasRaw !== undefined && !/^\d+$/.test(String(propiasRaw))) {
    console.error(`marker.js mark-adversarial-result: --own '${propiasRaw}' tiene que ser un entero ≥ 0 (cuántos confirmados se arreglaron con una prueba escrita a mano)`);
    process.exit(2);
  }
  const propias = propiasRaw !== undefined ? parseInt(propiasRaw, 10) : 0;
  const enPedidas = hayEn ? String(nn(argv[iEn + 1], '')).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (propias > 0 && !hayEn) {
    console.error(`marker.js mark-adversarial-result: --own ${propias} sin --in — decí en qué archivo(s) de prueba quedaron: --in "<ruta>[,<ruta>…]" (relativas al repo)`);
    process.exit(2);
  }
  if (hayEn && enPedidas.length === 0) {
    console.error('marker.js mark-adversarial-result: --in vacío — las rutas de las pruebas propias, separadas por coma');
    process.exit(2);
  }
  if (hayEn && propias === 0) {
    console.error('marker.js mark-adversarial-result: --in sin --own <p> — ¿cuántos confirmados cubren esas pruebas?');
    process.exit(2);
  }
  if (confirmados === 0 && propias > 0) {
    console.error(`marker.js mark-adversarial-result: --own ${propias} con 0 confirmados — no hay hallazgos que cubrir`);
    process.exit(2);
  }
  let pruebas = 0, diferidos = 0, motivo = null;
  if (confirmados > 0) {
    const k = flag('--tests'), d = flag('--deferred');
    if (!/^\d+$/.test(String(nn(k, '')))) {
      console.error(`marker.js mark-adversarial-result: con ${confirmados} confirmado(s) hace falta --tests <k> (cuántos ya tienen su prueba de regresión en la suite, promovida con promote-probe), --own <p> --in "<rutas>" para los arreglados con una prueba escrita a mano y, si falta alguno, --deferred <d> --reason "<por qué>"`);
      process.exit(2);
    }
    pruebas = parseInt(k, 10);
    diferidos = /^\d+$/.test(String(nn(d, ''))) ? parseInt(d, 10) : 0;
    motivo = flag('--reason') || null;
    if (pruebas + propias + diferidos !== confirmados) {
      console.error(`marker.js mark-adversarial-result: --tests ${pruebas} + --own ${propias} + --deferred ${diferidos} ≠ ${confirmados} confirmados — cada hallazgo confirmado termina en la suite (promovida o escrita a mano) o se difiere con motivo, no hay otra opción`);
      process.exit(2);
    }
    if (diferidos > 0 && !String(motivo || '').trim()) {
      console.error(`marker.js mark-adversarial-result: ${diferidos} diferido(s) sin --reason — un hallazgo que no entra a la suite lleva escrito por qué (story de seguimiento, código preexistente…)`);
      process.exit(2);
    }
    // Se cuentan las promovidas para el lanzamiento VIGENTE: tras un relanzamiento, las del pase anterior
    // son de otro resultado. Sin lanzamiento anotado, todas.
    let promovidas = null;
    if (corrida && tipo === '5b') {
      const desde = corrida.adversarial && typeof corrida.adversarial === 'object' ? Date.parse(corrida.adversarial.launchedAt) : NaN;
      promovidas = (corrida.adversarialRegressions || [])
        .filter((g) => !Number.isFinite(desde) || Date.parse(g && g.ts) >= desde).length;
    }
    if (promovidas !== null && promovidas !== pruebas) {
      console.error(`marker.js mark-adversarial-result: --tests ${pruebas} pero para este lanzamiento del pase se promovieron ${promovidas} prueba(s) con promote-probe — se cuenta lo promovido, no lo declarado`);
      process.exit(2);
    }
  }
  const { en, enSinFecha } = propias > 0 ? verificarPruebasPropias(enPedidas, corrida, tipo) : { en: [], enSinFecha: false };
  let head = null;
  try {
    head = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: (corrida && corrida.repoPath) || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (_e) { head = null; }
  // En cuántas CAUSAS distintas se agrupan esos hallazgos. Lo devuelve el propio pase
  // (`clases` de adversarial-verify.workflow.js). Sin el dato el volcado no puede decir cuánto se
  // ahorró, y el ratio de duplicación habría que medirlo a mano una corrida por vez. Opcional a
  // propósito: un pase de una versión anterior, o uno corrido con el agrupamiento apagado, no lo trae.
  const clasesRaw = flag('--classes');
  if (clasesRaw !== undefined && !/^\d+$/.test(String(clasesRaw))) {
    console.error(`marker.js mark-adversarial-result: --classes '${clasesRaw}' tiene que ser un entero ≥ 0 (en cuántas causas distintas se agruparon los ${confirmados} hallazgos)`);
    process.exit(2);
  }
  const clases = clasesRaw !== undefined ? parseInt(clasesRaw, 10) : null;
  if (clases !== null && clases > confirmados) {
    console.error(`marker.js mark-adversarial-result: --classes ${clases} con ${confirmados} confirmado(s) — no puede haber más causas que hallazgos`);
    process.exit(2);
  }
  // Y tampoco menos de una: con hallazgos confirmados, cero causas es imposible (el agrupador nunca
  // devuelve 0 clases con ≥1 hallazgo). Dejarlo pasar anota un ahorro igual al total y el ratio, que
  // se mide solo a partir de este volcado, quedaría mintiendo.
  if (clases !== null && confirmados > 0 && clases < 1) {
    console.error(`marker.js mark-adversarial-result: --classes ${clases} con ${confirmados} confirmado(s) — con hallazgos tiene que haber al menos una causa`);
    process.exit(2);
  }
  // Hallazgos que el verificador declaró distintos del que reprodujo: no heredaron su veredicto, o
  // sea que NADIE los miró. Se anotan para que queden en el volcado; hacerlos bloqueantes del cierre
  // no se hace acá.
  const aparteRaw = flag('--separate');
  if (aparteRaw !== undefined && !/^\d+$/.test(String(aparteRaw))) {
    console.error(`marker.js mark-adversarial-result: --separate '${aparteRaw}' tiene que ser un entero ≥ 0 (hallazgos que quedaron para verificar por separado)`);
    process.exit(2);
  }
  const aparte = aparteRaw !== undefined ? parseInt(aparteRaw, 10) : null;
  if (aparte !== null && aparte > confirmados) {
    console.error(`marker.js mark-adversarial-result: --separate ${aparte} con ${confirmados} confirmado(s) — no puede haber más hallazgos sin verificar que confirmados`);
    process.exit(2);
  }
  const pase = {
    tipo,
    confirmados,
    ...(clases !== null ? { clases, agentes_ahorrados: confirmados - clases } : {}),
    ...(aparte !== null ? { a_verificar_aparte: aparte } : {}),
    pruebas,
    propias,
    en,
    ...(enSinFecha ? { enSinFecha: true } : {}),
    diferidos,
    motivo,
    veredicto: medicion && !medicion.medido ? 'no-medido' : confirmados > 0 ? 'no-listo' : 'listo',
    ...(medicion ? { resultado: medicion.ruta } : {}),
    ...(medicion && !medicion.medido ? {
      motivo_no_medido: medicion.motivo, lentes_sin_medir: medicion.lentes_sin_medir, hallazgos_sin_veredicto: medicion.hallazgos_sin_veredicto,
    } : {}),
    runId: flag('--run') || null,
    modelo: flag('--model') || null,
    head,
  };
  appendLog('gates.log', { name: 'adversarial-pass', storyId, ...pase });
  if (corrida) {
    corrida.adversarialPasses = [...(corrida.adversarialPasses || []), { ts: nowIso(), ...pase }];
    // El resultado del pase CIERRA el pase, en la misma escritura que la entrada nueva: no hay un
    // instante con el pase anotado y el paso abierto, ni al revés. Una revisión a mano (`--type revision`) no
    // es el pase de la ejecución y no lo toca.
    // Un pase no medido NO lo cierra, y si ya estaba cerrado lo REABRE: el último resultado manda.
    if (tipo === '5b') corrida.deepReviewDone = pase.veredicto !== 'no-medido';
    corrida.lastTouch = nowIso();
    writeMarker(corrida);
  }
  process.stdout.write(JSON.stringify({ storyId, ...pase }, null, 2) + '\n');
}

/**
 * Las cuatro verificaciones de `--in`. Sale 2 con la ruta y la condición que falló;
 * devuelve las rutas (relativas a su repo) y si no se pudo fechar contra el lanzamiento.
 *
 * 🔴 Las rutas se comparan CANÓNICAS y sin distinguir mayúsculas: `fs.realpathSync` en JS conserva las mayúsculas como vienen y no resuelve una ruta que no
 * existe, así que `/tmp` ↔ `/private/tmp` o `Specs-Repo` ↔ `specs-repo` dejaban afuera al mismo archivo real, y
 * «fuera del repo» se decidía sobre la ruta ESCRITA contra el repo RESUELTO. Mismo criterio que
 * `lib/atdd-order.js adentroDelRepo` (APFS y NTFS no distinguen mayúsculas).
 *
 * La (d) —«se editó en esta corrida después del lanzamiento»— es la unión de dos evidencias: un evento de
 * edición posterior, o la fecha del archivo posterior. `marker.fileEvents` sólo lo escribe el hook de Edit|Write:
 * una prueba escrita con `sed` o un heredoc no deja evento (la misma ceguera que `lib/late-snapshot.js` ya documenta).
 *
 * Base: el repo de la corrida; sin marker (revisión a mano), la raíz git del directorio actual. Una ruta fuera de
 * esa base se acepta si vive en un repo git donde la corrida EDITÓ archivos (story de
 * dos repos) y se anota como `(<repo>) <ruta>`, la forma que usa la story para lo que vive en agent-skills.
 */
function verificarPruebasPropias(rutas, marker, tipo) {
  let base = (marker && marker.repoPath) || null;
  if (!base) {
    try { base = require('./lib/repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { base = null; }
  }
  base = base || process.cwd();
  // La ruta canónica: la real del sistema (`.native` resuelve enlaces Y mayúsculas); si no existe, la real del
  // ancestro que sí existe más el resto tal cual.
  const canon = (p) => {
    let actual = path.resolve(p);
    const resto = [];
    for (;;) {
      try { return path.join(fs.realpathSync.native(actual), ...resto); } catch (e) {
        // Sólo «no existe» sube al ancestro. Otro error (permisos) no es «no existe»: se usa la ruta tal cual y las
        // verificaciones de abajo dicen lo que ven, sin inventar un motivo.
        if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return path.join(actual, ...resto);
      }
      const padre = path.dirname(actual);
      if (padre === actual) return path.join(actual, ...resto);
      resto.unshift(path.basename(actual));
      actual = padre;
    }
  };
  const clave = (p) => canon(p).split(path.sep).join('/').toLowerCase();
  const adentro = (k, raiz) => k === raiz || k.startsWith(raiz.endsWith('/') ? raiz : `${raiz}/`);
  const falla = (ruta, por) => {
    console.error(`marker.js mark-adversarial-result: --in ${ruta}: ${por} — no se anotó nada.`);
    process.exit(2);
  };
  const { isTestPath } = require('./lib/atdd-order.js');
  const repo = canon(base);
  const repoClave = clave(repo);
  // Lo que la corrida tocó: define los repos hermanos aceptables y es la primera evidencia de la (d).
  const tocadasEventos = (marker && Array.isArray(marker.fileEvents) ? marker.fileEvents : []).filter((ev) => ev && ev.path);
  const tocadasRutas = [
    ...tocadasEventos.map((ev) => ev.path),
    ...(marker && Array.isArray(marker.filesTouched) ? marker.filesTouched : []),
  ].map((p) => clave(p));
  const raizGit = (archivo) => {
    const r = require('child_process').spawnSync('git', ['-C', path.dirname(archivo), 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && String(r.stdout || '').trim() ? canon(String(r.stdout).trim()) : null;
  };
  // La (d) sólo existe con un lanzamiento anotado del pase: una revisión a mano no tiene lanzamiento que anotar.
  const lanz = tipo === '5b' && marker && marker.adversarial && typeof marker.adversarial === 'object' ? marker.adversarial : null;
  const desde = lanz ? Date.parse(lanz.launchedAt) : NaN;
  const conFecha = Number.isFinite(desde);
  const editadasDespues = new Set(conFecha
    ? tocadasEventos.filter((ev) => Date.parse(ev.ts) > desde).map((ev) => clave(ev.path))
    : []);
  const en = [];
  // `(<repo>) <ruta>`: la forma que el paso «Pase adversarial» pide escribir para una prueba del repo hermano; sin este caso
  // se tomaría como una ruta relativa al repo («no existe»). <repo> se prueba como hermano declarado, como ruta y
  // como carpeta vecina (lib/companion-repos.js); lo que resuelve pasa por las mismas cuatro verificaciones.
  const companionLib = require('./lib/companion-repos.js');
  const hermanos = companionLib.companionRoots(base, marker && marker.storyPath, {
    onMissing: (nombre, quien) => console.error(`⚠ el repo hermano «${nombre}» que declara ${companionLib.label(quien)}/.tycon/advisors.yaml no está en disco`),
  });
  for (const ruta of rutas) {
    let abs = path.resolve(base, ruta);
    const conRepo = companionLib.parseRepoPrefixed(ruta);
    if (conRepo) {
      const { root, tried } = companionLib.resolveRepoRef(conRepo.ref, base, hermanos);
      if (!root) falla(ruta, `«${conRepo.ref}» no es un repo git que encontré (probé ${tried.join(' · ')})`);
      abs = path.resolve(root, conRepo.rest);
    }
    const k = clave(abs);
    let esArchivo = false;
    try { esArchivo = fs.statSync(abs).isFile(); } catch (_e) { esArchivo = false; }
    // (a) En el repo de la corrida, o en un repo hermano que la corrida editó.
    let raiz = null;
    let prefijo = '';
    if (adentro(k, repoClave)) {
      raiz = repo;
    } else if (esArchivo) {
      const r2 = raizGit(abs);
      const r2Clave = r2 ? clave(r2) : null;
      if (r2Clave && tocadasRutas.some((t) => adentro(t, r2Clave))) {
        raiz = r2;
        prefijo = `(${path.basename(r2)}) `;
      }
    }
    if (!raiz) falla(ruta, `queda fuera del repo (${repo}) y de los repos que esta corrida editó`);
    // (b)
    if (!esArchivo) falla(ruta, 'no existe (o no es un archivo)');
    const rel = path.relative(raiz, canon(abs)).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || rel === '..') falla(ruta, `queda fuera del repo por un enlace (apunta a ${canon(abs)})`);
    // (c)
    if (!isTestPath(rel)) falla(ruta, 'no es un archivo de prueba (el criterio de isTestPath, el mismo del freno ATDD)');
    // (d) evento posterior, o fecha del archivo posterior (la edición por consola no deja evento).
    if (conFecha) {
      let mtime = NaN;
      try { mtime = fs.statSync(abs).mtimeMs; } catch (_e) { mtime = NaN; }
      if (!editadasDespues.has(k) && !(mtime > desde)) {
        falla(ruta, `no se editó después del lanzamiento del pase (${lanz.launchedAt}): ni un evento de edición posterior en esta corrida ni una fecha de modificación posterior`);
      }
    }
    en.push(prefijo + rel);
  }
  if (!conFecha) {
    console.error(`⚠️  marker.js mark-adversarial-result: no pude verificar que se tocaron después del pase: no hay lanzamiento anotado${lanz ? ' con fecha legible' : ''}. Existen, están en el repo y son pruebas; la entrada lleva enSinFecha.`);
  }
  return { en, enSinFecha: !conFecha };
}

// marker.js promote-probe <probe_dir> --file <nombre.txt> --a <ruta del test, relativa al repo>
//
// La prueba con la que el verificador del pase adversarial CONFIRMÓ un hallazgo pasa a la suite
// del repo como prueba de regresión. El verificador la deja en
// `<RUN_DIR>/step-05b-probes/<lente>-<n>/` con `.txt` en el nombre (para que nada la compile
// mientras el pase sigue corriendo); acá se copia a su lugar definitivo, de a UNA, desde el
// orquestador — nunca desde los agentes del pase, que corren en paralelo y romperían la
// compilación si escribieran en el proyecto de tests. Nace en rojo: el arreglo
// del hallazgo la pone en verde y el test-gate del re-loop la corre.
//
// Lo que se niega, con motivo: un destino fuera del repo · un destino que ya existe (una prueba
// de regresión es nueva; pisar una existente es otra cosa) · 🔴 un destino con nombre de probe
// (`ZZProbe*`, `__probe*`): `lib/ledger-honesty.js` lo excluye de la foto de la iteración y el
// pipeline lo trataría como descartable — sería «promover» a un archivo invisible.
function cmdPromoteProbe(probeDir) {
  const argv = process.argv;
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const marker = readMarker();
  if (!marker || !marker.repoPath) {
    console.error('marker.js promote-probe: no hay corrida del pipeline en esta sesión (hace falta el repo del marker)');
    process.exit(2);
  }
  const archivo = flag('--file'), destRel = flag('--a');
  if (!probeDir || !archivo || !destRel) {
    console.error('marker.js promote-probe: uso: promote-probe <probe_dir> --file <nombre.txt> --a <ruta del test relativa al repo>');
    process.exit(2);
  }
  const src = path.join(probeDir, archivo);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    console.error(`marker.js promote-probe: no existe ${src} — ¿el verificador guardó la prueba? (probe_dir del hallazgo)`);
    process.exit(2);
  }
  const repo = path.resolve(marker.repoPath);
  const dest = path.resolve(repo, destRel);
  if (dest !== repo && !dest.startsWith(repo + path.sep)) {
    console.error(`marker.js promote-probe: el destino ${dest} queda fuera del repo ${repo}`);
    process.exit(2);
  }
  if (require('./lib/ledger-honesty.js').esProbe(dest)) {
    console.error(`marker.js promote-probe: ${path.basename(dest)} tiene nombre de probe descartable — el pipeline lo ignoraría (ledger-honesty). Dale nombre de test real`);
    process.exit(2);
  }
  if (fs.existsSync(dest)) {
    console.error(`marker.js promote-probe: ${destRel} ya existe — una prueba de regresión es un archivo nuevo; si querés sumarla a uno existente, editalo a mano`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const reg = { probeDir: path.resolve(probeDir), archivo, dest: posixRelative(repo, dest), ts: nowIso() };
  marker.adversarialRegressions = [...(marker.adversarialRegressions || []), reg];
  marker.lastTouch = nowIso();
  writeMarker(marker);
  // A propósito NO deja línea en gates.log: no es una evaluación de un control (no tiene veredicto),
  // y el tablero contaría un control «adversarial-regresion» sin estado. Queda en el marker —que
  // viaja entero en el volcado de la corrida— y en la línea `adversarial-pass` como `pruebas`.
  process.stdout.write(JSON.stringify({ storyId: marker.storyId, ...reg, promovidas: marker.adversarialRegressions.length }, null, 2) + '\n');
}

function cmdAppendFile(absPath) {
  if (!absPath) process.exit(0);
  const marker = readMarker();
  if (!marker) process.exit(0);
  if (!marker.filesTouched.includes(absPath)) {
    marker.filesTouched.push(absPath);
  }
  // EVENTOS de edición con timestamp:
  // filesTouched dedupea → un archivo RE-editado en iter N no entraría al delta
  // por nombres, y su fix no se re-auditaría. fileEvents conserva CADA edición con ts;
  // pipeline.js smart-reloop computa el delta como "archivos con evento posterior
  // al snapshot de la iter previa". Cap 500 entries (FIFO) para no crecer sin límite.
  marker.fileEvents = marker.fileEvents || [];
  marker.fileEvents.push({ path: absPath, ts: nowIso() });
  if (marker.fileEvents.length > 500) {
    marker.fileEvents = marker.fileEvents.slice(-500);
  }
  marker.lastTouch = nowIso();
  writeMarker(marker);
}

// Las opciones de los dos guiones del arnés que llama el cierre (`tokens-digest.js` y `run-change.js`), con sus nombres
// viejos (anteriores al renombre). El cierre llama con los de hoy; si el guion sale con su código de «argumentos
// inválidos» es un arnés atrasado, que sólo entiende los viejos, y se lo llama UNA vez más con ésos.
// Sin el mapa de renombres (la copia pública no lo trae), el guion sale 2 y cada cierre anotaría «no medido»:
// sin el cambio de git, sin el hilo y sin el consumo. Se arman por partes: no son nombres a usar.
// Los dos guiones salen 2 también cuando no pudieron escribir su salida: ahí la segunda vuelta repite el intento una vez,
// falla igual, y el motivo que queda anotado es el de esa última.
// Casos: `tests/marker-archive-change.test.js` (T13–T16).
const HARNESS_INVALID_ARGS = 2;
const HARNESS_OLD_OPTION = {
  run: `--${['co', 'rrida'].join('')}`,
  dump: `--${['vol', 'cado'].join('')}`,
  state: `--${['es', 'tado'].join('')}`,
};

/**
 * Rescate del hilo y el consumo de la corrida que cierra.
 *
 * El archivador guarda tiempos, frenos y costo; esta función suma el CONSUMO y el HILO, que
 * viven sólo en la conversación de Claude Code, que se borra a los 30 días: sin rescate, la mayoría
 * de las corridas archivadas perderían su conversación.
 *
 * 🔴 ESTA FUNCIÓN NO PUEDE ROMPER EL ARCHIVADO, y por eso está escrita al revés que el resto: el
 * volcado ya está en disco cuando se la llama, y todo camino de falla termina anotando el motivo
 * adentro del volcado en vez de propagar. `tokens-digest.js` vive en OTRO repo
 * (el arnés), que se actualiza por un camino distinto a éste: una máquina con el arnés
 * atrasado tiene este archivo nuevo y aquél ausente. Si el archivado dependiera de él, esa máquina
 * dejaría de archivar TAMBIÉN los tiempos, los frenos y el costo.
 * Casos: `tests/marker-archive-rescue.test.js` (T8 rescate roto · T8b script ausente · T8c sano) y
 * `tests/marker-archive-change.test.js` (T15, T16: con qué nombre de opción se lo llama).
 *
 * Devuelve el volcado ya actualizado, para que la copia del repo salga con lo mismo.
 * Apagar: TYCON_NO_THREAD_RESCUE=1
 */
function rescatarHiloYConsumo(archivo, dump) {
  const anotar = (motivo) => {
    try {
      const d = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      // Sin la clave `tokens`, a propósito: un cero se lee como «esta corrida no consumió nada».
      d.consumo = { estado: 'no_medido', motivo, medido_en: nowIso() };
      fs.writeFileSync(archivo, JSON.stringify(d, null, 2), 'utf8');
      return d;
    } catch { return dump; }
  };

  if (require('./lib/legacy-names.js').readEnv('TYCON_NO_THREAD_RESCUE', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '1') {
    return anotar('el rescate del hilo está apagado en esta máquina (TYCON_NO_THREAD_RESCUE=1)');
  }

  const arnes = require('./lib/harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
  if (!arnes.dir) return anotar(`${arnes.aviso} — la corrida se archivó igual`);
  const script = path.join(arnes.dir, 'scripts', 'metrics', 'tokens-digest.js');
  if (!fs.existsSync(script)) {
    return anotar(`no encontré tokens-digest.js en ${script} — el arnés de esta máquina puede estar atrasado; la corrida se archivó igual`);
  }

  try {
    const { execFileSync } = require('child_process');
    const resto = process.env.TYCON_PROJECTS_DIR ? ['--projects-dir', process.env.TYCON_PROJECTS_DIR] : [];
    const llamar = (opcion) => execFileSync(process.execPath, [script, opcion, archivo, ...resto], { stdio: 'ignore', timeout: 60000 });
    try {
      llamar('--run');
    } catch (err) {
      // sólo «argumentos inválidos» (un arnés de antes del renombre) merece la vuelta con el nombre viejo; cualquier otra
      // falla —rota, lenta, ausente— sigue su camino de siempre
      if (!err || err.status !== HARNESS_INVALID_ARGS) throw err;
      llamar(HARNESS_OLD_OPTION.run);
    }
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (err) {
    return anotar(`el rescate del hilo falló: ${err && (err.code || err.message) ? (err.code || err.message) : 'motivo desconocido'}`);
  }
}

/**
 * El cambio de la corrida según git: llama a
 * `scripts/metrics/run-change.js` del arnés, que deja `<volcado>.cambio.json.gz` al
 * lado del volcado (los commits que la corrida creó y lo que quedó sin commitear, en cada repo donde
 * escribió), y anota en el volcado SÓLO el resumen `cambio: {estado, repos, archivos, motivo}`.
 *
 * 🔴 Mismo contrato que `rescatarHiloYConsumo`, y por la misma razón: el guion vive en otro repo que se
 * actualiza por otro camino, así que ninguna falla suya —ausente, roto, lento— puede impedir el archivado.
 * Todo camino termina anotando `no_medido` con el motivo. Los parches nunca entran al volcado: el volcado
 * se copia al repo.
 * Casos: `tests/marker-archive-change.test.js` (T11 sano · T12 ausente, roto, lento, apagado · T13, T14: con qué
 * nombres de opción se lo llama).
 * Apagar: TYCON_NO_RUN_CHANGE=1 · tope: 30 s (TYCON_RUN_CHANGE_TIMEOUT_MS, para las pruebas)
 */
function guardarCambioDeCorrida(archivo, dump) {
  const anotar = (cambio) => {
    try {
      const d = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      d.cambio = cambio;
      fs.writeFileSync(archivo, JSON.stringify(d, null, 2), 'utf8');
      return d;
    } catch { return { ...dump, cambio }; }
  };
  const noMedido = (motivo) => anotar({ estado: 'no_medido', repos: 0, archivos: 0, motivo });

  const { readEnv } = require('./lib/legacy-names.js');
  if (readEnv('TYCON_NO_RUN_CHANGE', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '1') {
    return noMedido('el cambio de git de la corrida está apagado en esta máquina (TYCON_NO_RUN_CHANGE=1)');
  }
  const arnes = require('./lib/harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
  if (!arnes.dir) return noMedido(`${arnes.aviso} — la corrida se archivó igual`);
  // El nombre nuevo primero: por el viejo corre el reemplazo, que en Azure avisa «nombre viejo» en
  // cada corrida. El viejo sólo en un arnés que todavía no tiene el renombre (se arma por partes: no es un nombre a usar).
  const metricas = path.join(arnes.dir, 'scripts', 'metrics');
  const script = [path.join(metricas, 'run-change.js'), path.join(metricas, `${['cambio', 'de', 'corrida'].join('-')}.js`)].find((p) => fs.existsSync(p));
  if (!script) {
    return noMedido(`no encontré run-change.js en ${metricas} — el arnés de esta máquina puede estar atrasado; la corrida se archivó igual`);
  }
  const topePuesto = Number(readEnv('TYCON_RUN_CHANGE_TIMEOUT_MS', { where: 'skills/tycon-pipeline/scripts/marker.js' }));
  const tope = topePuesto > 0 ? topePuesto : 30000;
  try {
    const { spawnSync } = require('child_process');
    const llamar = (dumpOption, stateOption) => spawnSync(process.execPath, [script, dumpOption, archivo, stateOption, STATE_DIR],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: tope, killSignal: 'SIGKILL' });
    let r = llamar('--dump', '--state');
    // sólo «argumentos inválidos» (un arnés de antes del renombre) merece la vuelta con los nombres viejos
    if (!r.error && r.status === HARNESS_INVALID_ARGS) r = llamar(HARNESS_OLD_OPTION.dump, HARNESS_OLD_OPTION.state);
    if (r.error && r.error.code === 'ETIMEDOUT') return noMedido(`el cambio de git tardó más de ${Math.round(tope / 1000)} s y se cortó; la corrida se archivó igual`);
    if (r.error) return noMedido(`el cambio de git falló: ${r.error.code || r.error.message}`);
    if (r.status !== 0) return noMedido(`el cambio de git falló (salió ${r.status}); la corrida se archivó igual`);
    let s;
    try { s = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { s = null; }
    if (!s || typeof s !== 'object' || !s.estado) return noMedido('el cambio de git no devolvió un resumen legible; la corrida se archivó igual');
    return anotar({ estado: String(s.estado), repos: Number(s.repos) || 0, archivos: Number(s.archivos) || 0, motivo: s.motivo || null });
  } catch (err) {
    return noMedido(`el cambio de git falló: ${err && (err.code || err.message) ? (err.code || err.message) : 'motivo desconocido'}`);
  }
}

/**
 * Una ejecución que tocó archivos y no completó ningún paso después del arranque trabajó por fuera del pipeline: el
 * cierre lo dice en una línea y lo deja en bypass.log, para que se vea en el momento y en el tablero. No frena nada.
 * «Tocó archivos» es lo que registró el editor más lo que git ve cambiado contra el commit de arranque; lo de
 * `.advisors/` es del propio pipeline y no cuenta.
 */
function avisarCierreSinPasos(marker) {
  try {
    // el Arranque: `start` en un marcador nuevo; sus tres partes viejas, en uno viejo
    const arranque = (s) => String(s) === 'start' || String(s).startsWith('0');
    if ((marker.stepsCompleted || []).some((s) => !arranque(s))) return;
    const repo = marker.repoPath && fs.existsSync(marker.repoPath) ? marker.repoPath : null;
    const mostrar = (f) => (repo && f.startsWith(repo + path.sep) ? path.relative(repo, f) : f);
    const tocados = new Set((marker.filesTouched || []).map(String));
    if (repo && marker.baseSha) {
      const { spawnSync } = require('child_process');
      const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
      for (const r of [git(['diff', '--name-only', marker.baseSha]), git(['ls-files', '--others', '--exclude-standard'])]) {
        if (r.error || r.status !== 0) continue;
        for (const f of String(r.stdout).split('\n').filter(Boolean)) tocados.add(path.join(repo, f));
      }
    }
    const archivos = [...tocados].map(mostrar).filter((f) => !f.split(/[\\/]/).includes('.advisors'));
    if (!archivos.length) return;
    const desde = Date.parse(marker.startedAt || '');
    const minutos = Number.isFinite(desde) ? Math.max(1, Math.round((Date.now() - desde) / 60000)) : null;
    appendLog('bypass.log', { kind: 'RUN_CLOSED_WITHOUT_STEPS', storyId: marker.storyId, files: archivos.length, sample: archivos.slice(0, 5), minutes: minutos });
    process.stderr.write(`⚠️  la ejecución de la ${marker.storyId} tocó ${archivos.length} archivo(s) en ${minutos === null ? '?' : minutos} min y no anotó ningún paso después del arranque: el trabajo se hizo por fuera del pipeline (queda en bypass.log)\n`);
  } catch { /* el aviso nunca frena el cierre */ }
}

function cmdClear() {
  // Timing dump automático: el cierre del
  // pipeline archiva el marker completo + los gates de la sesión ANTES de borrar —
  // es la única fuente de la curva de costo por run (stepTimings, iteraciones,
  // checks, gates con duración). Mecánico: no depende de que el orquestador se
  // acuerde de correr `pipeline.js timing-report` antes del clear. Best-effort:
  // un fallo acá JAMÁS bloquea el clear.
  try {
    const marker = readMarker();
    if (marker && marker.storyId) {
      let gates = [];
      try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'gates.log'), 'utf8');
        gates = raw.split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((g) => g && g.sessionId === SID);
      } catch { /* sin gates.log */ }
      // Costo del run: el conteo de spawns es el proxy de costo, porque cada
      // agente cuesta ~60.000-100.000 tokens ANTES de leer nada (baseline medido en
      // ~/.claude/.tycon-pipeline/baseline/). Se calcula ACÁ, en el mismo cierre mecánico que
      // el timing dump, para que no dependa de que alguien se acuerde de correr
      // `pipeline.js cost-report`. Vara del historial (58 runs): ~14 spawns por run, 22% de
      // exploración libre, 2,6 de ésos antes de los advisors.
      const ADHOC = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
      const costo = { spawns: 0, adhoc: 0, adhoc_pre_step5: 0, iteraciones: 0, por_tipo: {}, sin_hora: 0 };
      try {
        const runLog = path.join(STATE_DIR, 'advisor-runs', `${SID}.jsonl`);
        // El registro es de la sesión, que puede haber corrido otras stories: cuenta sólo lo lanzado desde que arrancó
        // esta corrida y, si la línea nombra una story, sólo la de ésta. Una línea sin hora no se sabe de qué corrida es:
        // no cuenta, y queda dicho en `sin_hora`.
        // Sin la hora de arranque (un marcador viejo o editado) sólo cuentan las líneas que nombran esta story, y se dice.
        const desde = Date.parse(marker.startedAt || '');
        if (!Number.isFinite(desde)) costo.sin_arranque = true;
        const estaStory = String(marker.storyId || '');
        let vistoStep5 = false;
        for (const l of fs.readFileSync(runLog, 'utf8').split('\n')) {
          if (!l.trim()) continue;
          let d; try { d = JSON.parse(l); } catch { costo.ilegibles = (costo.ilegibles || 0) + 1; continue; }
          const nombra = d.story !== undefined && d.story !== null;
          if (nombra && String(d.story) !== estaStory) continue;
          if (!nombra && costo.sin_arranque) continue;
          const hora = Date.parse(d.ts || '');
          if (!Number.isFinite(hora)) { costo.sin_hora++; continue; }
          if (Number.isFinite(desde) && hora < desde) continue;
          if (d.event === 'step5-start') { vistoStep5 = true; continue; }
          if (!d.advisor) continue;
          costo.spawns++;
          costo.por_tipo[d.advisor] = (costo.por_tipo[d.advisor] || 0) + 1;
          if (ADHOC.has(d.advisor)) { costo.adhoc++; if (!vistoStep5) costo.adhoc_pre_step5++; }
        }
      } catch (e) {
        // sin registro, el costo queda en cero; un registro que está y no se lee lo dice, para no pasar por «cero agentes»
        if (e.code !== 'ENOENT') costo.registro = `no se pudo leer (${e.code || e.message})`;
      }
      // las vueltas: las que lanzaron revisores (las fotos de iteración), la misma cuenta que pipeline.js review-rounds; un
      // arranque del paso de revisores sin revisores no es una vuelta
      costo.iteraciones = require('./lib/review-rounds.js').vueltas(marker);
      // La revisión adversarial de la historia antes de programar: su constancia, o null dicho. Lo no medido es null.
      let revisionPrevia = null;
      let notaPrevia = 'sin revisión previa';
      try {
        const sp = marker.storyPath && marker.repoPath && !path.isAbsolute(marker.storyPath) ? path.join(marker.repoPath, marker.storyPath) : marker.storyPath;
        revisionPrevia = require('./lib/story-review-record.js').resumenVolcado(os.homedir(), sp);
      } catch (e) {
        // no poder leerla no es «no hubo»: se dice
        notaPrevia = `no se pudo leer la constancia de la revisión previa (${e.message})`;
        process.stderr.write(`[marker] ${notaPrevia}\n`);
      }
      // Cómo terminó la ejecución (lib/run-close.js): completa, o abortada con su motivo y quién autorizó cerrar. Un
      // cierre ya escrito (la deuda de close-as-debt) no se pisa. Que falle no frena el archivo: queda dicho.
      try {
        marker.cierre = require('./lib/run-close.js').cierreDe(marker, { sid: SID });
        const c = marker.cierre;
        appendLog('gates.log', { name: 'run-close', estado: c.estado, story: String(marker.storyId), motivo: c.motivo || null, via: c.via || null, ...(c.deuda ? { deuda: c.deuda } : {}) });
      } catch (e) {
        // sin poder calcularlo, la ejecución no cuenta como terminada: queda abortada y el motivo lo dice
        marker.cierre = { estado: 'abortada', motivo: `no pude determinar cómo terminó (${e.message})`, via: 'sin-registro', at: nowIso() };
        process.stderr.write(`[marker] no pude armar el cierre de la ejecución (${e.message}): queda como abortada\n`);
      }
      // El repo real de la carpeta (un worktree o un clon cuentan como su repo) para agrupar las ejecuciones en la vista.
      let repo = null;
      try { repo = require('./lib/repo-attrib.js').realRepo(marker.repoPath); } catch (_e) { /* sin él, la vista deduce de la carpeta */ }
      const dump = {
        archivedAt: nowIso(), marker, gates, costo, ...(repo ? { repo } : {}),
        revision_previa: revisionPrevia, ...(revisionPrevia ? {} : { revision_previa_nota: notaPrevia }),
      };
      const safeStory = String(marker.storyId).replace(/[^\w.-]/g, '_');
      const ts = nowIso().replace(/[:.]/g, '').slice(0, 15);
      // 1) Historia global (sobrevive aunque el repo no exista).
      const histDir = path.join(STATE_DIR, 'timing-history');
      fs.mkdirSync(histDir, { recursive: true });
      const histFile = path.join(histDir, `${safeStory}-${ts}.json`);
      fs.writeFileSync(histFile, JSON.stringify(dump, null, 2), 'utf8');
      // 1b) Rescate del hilo, el consumo y el mensaje de los errores. Se hace DESPUÉS
      //     de que el volcado ya está en disco, a propósito: si algo de esto falla, lo peor que pasa
      //     es que el volcado quede con `consumo.estado: "no_medido"` y su motivo.
      // 1c) El cambio según git, después del rescate y con el mismo contrato: nunca rompe.
      const dumpFinal = guardarCambioDeCorrida(histFile, rescatarHiloYConsumo(histFile, dump));
      // 2) Copia en el repo (pipeline-runs del run, si resuelve) — viaja con los
      //    artefactos de la story para la retro / el retrospective-capturer.
      if (marker.repoPath && fs.existsSync(marker.repoPath)) {
        const runsDir = path.join(marker.repoPath, '.advisors', 'pipeline-runs');
        let target = null;
        try {
          // La carpeta de ESTA story: por la clave; con número repetido, `<id>-*` es la de otra.
          const sp = marker.storyPath ? (path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(marker.repoPath, marker.storyPath)) : null;
          const ki = require('./lib/evidence-key.js').keyInfoOr(sp, String(marker.storyId));
          const clave = ki.key;
          // Sin clave el volcado cae en la raíz de pipeline-runs/ (como cuando no hay carpeta), pero se DICE por qué.
          if (!clave) process.stderr.write(`[marker] el volcado de tiempos va suelto a ${runsDir}: no pude calcular la clave de la carpeta de la story (${ki.error}).\n`);
          const candidates = (clave ? fs.readdirSync(runsDir) : [])
            .filter((d) => d.startsWith(`${clave}-`))
            .sort();
          if (candidates.length) target = path.join(runsDir, candidates[candidates.length - 1]);
        } catch { /* sin runs dir */ }
        if (!target) {
          target = runsDir;
          fs.mkdirSync(target, { recursive: true });
        }
        fs.writeFileSync(path.join(target, `timing-dump-${ts}.json`), JSON.stringify(dumpFinal, null, 2), 'utf8');
      }
      process.stderr.write(`[marker] timing dump archivado: timing-history/${safeStory}-${ts}.json\n`);
      avisarCierreSinPasos(marker);
      // Línea de costo al cierre — mecánica, siempre, sin flags. Compara contra la vara del
      // historial para que el número signifique algo sin tener que ir a buscarlo.
      if (costo.spawns) {
        const pct = Math.round((costo.adhoc / costo.spawns) * 100);
        const vs = (v, base, unidad) => {
          const d = v - base;
          if (Math.abs(d) < 0.05) return `= vara (${base}${unidad})`;
          return `${d > 0 ? '▲' : '▼'} vara ${base}${unidad}`;
        };
        process.stderr.write(
          `[marker] costo del run: ${costo.spawns} agentes en ${costo.iteraciones} iteración(es) de revisión · ` +
          `${costo.adhoc} de exploración libre (${pct}%, ${vs(pct, 22, '%')}) · ` +
          `${costo.adhoc_pre_step5} antes de los advisors (${vs(costo.adhoc_pre_step5, 2.6, '')}) · ` +
          `referencia ~60-100K tokens por agente · vara del historial: ~14 agentes/run\n`,
        );
      }
      // La oferta de la instalación completa al cerrar la primera historia: sale del cierre mecánico, después
      // de archivar el volcado (el volcado de ESTA corrida es la evidencia de que se cerró). Va a la salida estándar para
      // que el agente la muestre tal cual; un error se dice en un renglón y nunca frena el cierre.
      try {
        const offer = require('./lib/first-story.js').afterClose({ home: os.homedir(), env: process.env, marker });
        for (const l of offer.lines) process.stdout.write(`${l}\n`);
        if (offer.warn) process.stderr.write(`[marker] ${offer.warn}\n`);
      } catch (e) { process.stderr.write(`[marker] la oferta de la instalación completa no se pudo evaluar: ${e.message}\n`); }
    }
  } catch { /* best-effort */ }
  clearMarker();
}

function cmdIsActive() {
  const marker = readMarker();
  if (!marker) process.exit(1);
  process.stdout.write(marker.storyId);
  process.exit(0);
}

// ============================================================
// Cross-session discovery
// Sin esto, un pipeline iniciado en sessionA queda
// invisible para sessionB, porque `marker.js get` lee solo ESTA sesión.
// list-all + find-by-story permiten que cualquier hook detecte pipelines
// activos en otras sesiones antes de arrancar duplicado.
// ============================================================

function listAllMarkers() {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  pruneStale();
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch (_e) { return []; }
  const markers = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8'));
      if (m && m.storyId) markers.push(m);
    } catch (_e) { /* ignore */ }
  }
  return markers;
}

function cmdListAll() {
  process.stdout.write(JSON.stringify(listAllMarkers(), null, 2));
}

function cmdFindByStory(storyId) {
  if (!storyId) {
    console.error('marker.js find-by-story: storyId requerido');
    process.exit(2);
  }
  const all = listAllMarkers();
  const matches = all.filter((m) => m.storyId === storyId);
  process.stdout.write(JSON.stringify(matches, null, 2));
}

function cmdClearSession(sid) {
  if (!sid) {
    console.error('marker.js clear-session: sessionId requerido');
    process.exit(2);
  }
  const safe = String(sid).replace(/[/\\]/g, '_');
  const p = path.join(ACTIVE_DIR, `${safe}.json`);
  if (!fs.existsSync(p)) {
    console.error(`marker.js clear-session: no había marcador de esa sesión (${safe}): no se borró nada.`);
    process.exit(1);
  }
  try { fs.unlinkSync(p); } catch (e) {
    console.error(`marker.js clear-session: no pude borrar ${p}: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(`cleared: ${safe}.json\n`);
}

// ¿Está viva la sesión? Lo dicen los archivos de sesión de Claude Code (la carpeta de sesiones, <pid>.json, con su
// sessionId): viva si alguno la nombra y su proceso existe. Un archivo que no se puede leer podría ser el de esa
// sesión, así que no se la puede dar por muerta: se devuelve cuál.
function sessionLiveness(sid) {
  const dir = path.join(claudeDirOf(os.homedir()), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return { alive: false };
    return { unknown: `${dir}: ${e.message}` };
  }
  for (const n of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { return { unknown: `${path.join(dir, n)}: ${e.message}` }; }
    if (!s || s.sessionId !== sid) continue;
    const pid = Number(s.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { unknown: `${path.join(dir, n)}: pid ilegible` };
    try { process.kill(pid, 0); return { alive: true, pid }; } catch (e) { if (e.code === 'EPERM') return { alive: true, pid }; }
  }
  return { alive: false };
}

// `adhoc clear-orphan <sid>`: borra el ad-hoc que dejó una sesión que ya no está. Se borra sólo si la sesión no está viva
// y el ad-hoc lleva más de STALE_HOURS sin tocarse; cada borrado y cada negativa quedan en adhoc.log.
// `doing "<qué hago>"`: lo que hace una sesión sin story (un video, una medición), para que /wip lo diga. No es un
// permiso: no toca el portón de carril ni el ad-hoc. Otro `doing` la reemplaza; `doing clear` la borra;
// `doing clear-orphan <sid>` borra la nota de otra sesión que ya no vive. Archivo: doing/<sid>.json { text, at }; doing.log.
function cmdDoing(sub, arg) {
  const dir = path.join(STATE_DIR, 'doing');
  const safe = (s) => String(s).replace(/[/\\]/g, '_');
  if (sub === 'clear-orphan') {
    if (!arg) { console.error('marker.js doing clear-orphan: falta el id de la sesión — uso: doing clear-orphan <sessionId>'); process.exit(2); }
    const sid = safe(arg);
    if (sid === safe(SID)) { console.error('marker.js doing clear-orphan: es la nota de esta sesión — se borra con `marker.js doing clear`'); process.exit(3); }
    const file = path.join(dir, `${sid}.json`);
    if (!fs.existsSync(file)) { console.error('marker.js doing clear-orphan: no hay nota de esa sesión: no se borró nada'); process.exit(1); }
    const live = sessionLiveness(sid);
    if (live.unknown) { console.error(`marker.js doing clear-orphan: no se borró — no pude verificar que la sesión no esté viva (${live.unknown})`); process.exit(3); }
    if (live.alive) { console.error(`marker.js doing clear-orphan: no se borró — la sesión está viva (pid ${live.pid})`); process.exit(3); }
    // como `adhoc clear-orphan`: una sesión sin archivo de sesión (Codex no lo escribe) parece muerta; 24 h sin tocarse
    // es la segunda señal
    let at = NaN;
    try { at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at); } catch (_e) { /* sin fecha legible: la del archivo */ }
    if (!Number.isFinite(at)) { try { at = fs.statSync(file).mtimeMs; } catch (_e) { at = Date.now(); } }
    if (Date.now() - at < STALE_HOURS * 3600 * 1000) {
      const d = new Date(at + STALE_HOURS * 3600 * 1000);
      console.error(`marker.js doing clear-orphan: no se borró — la nota tiene menos de ${STALE_HOURS} h; se podrá borrar después de las ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      process.exit(3);
    }
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    appendLog('doing.log', { kind: 'DOING_CLEAR_ORPHAN', sessionId: sid, by: SID });
    process.stdout.write(`doing: borrada la nota de la sesión ${sid}\n`);
    return;
  }
  if (!SID) { console.error('marker.js doing: no sé qué sesión es (falta CLAUDE_CODE_SESSION_ID)'); process.exit(2); }
  const file = path.join(dir, `${safe(SID)}.json`);
  if (sub === 'clear') {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    appendLog('doing.log', { kind: 'DOING_CLEAR' });
    process.stdout.write('doing: borrada\n');
    return;
  }
  const text = String(sub || '').replace(/\s+/g, ' ').trim();
  if (text.length < 8 || text.length > 200) {
    console.error('marker.js doing: el texto va de 8 a 200 caracteres — uso: marker.js doing "<qué hago>" | doing clear');
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ text, at: new Date().toISOString() }));
  appendLog('doing.log', { kind: 'DOING_SET', text });
  process.stdout.write(`doing: ${text}\n`);
}

function cmdAdhocClearOrphan(sid) {
  if (!sid) {
    console.error('marker.js adhoc clear-orphan: falta el id de la sesión — uso: adhoc clear-orphan <sessionId>');
    process.exit(2);
  }
  const io = require('./lib/story-gate-io.js');
  // El id se compara ya saneado, igual que el nombre del archivo: un id con separadores no esquiva las comprobaciones.
  sid = String(sid).replace(/[/\\]/g, '_');
  const deny = (motivo, code = 3) => {
    appendLog('adhoc.log', { kind: 'ADHOC_CLEAR_ORPHAN_DENIED', sessionId: sid, motivo, by: SID });
    console.error(`marker.js adhoc clear-orphan: no se borró — ${motivo}`);
    process.exit(code);
  };
  if (sid === String(SID).replace(/[/\\]/g, '_')) deny('es el ad-hoc de esta misma sesión: se termina con `marker.js adhoc clear`');
  const file = io.adhocPath(STATE_DIR, sid);
  if (!fs.existsSync(file)) deny('no hay ad-hoc de esa sesión: no se borró nada', 1);
  let a = null;
  try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { a = null; }
  const reason = a && typeof a === 'object' ? a.reason || null : '(ilegible)';
  // La última vez tocado: la primera fecha legible entre lastTouch y declaredAt; sin ninguna, la del archivo.
  let touched = [a && a.lastTouch, a && a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
  if (touched === undefined) {
    try { touched = fs.statSync(file).mtimeMs; } catch (e) { deny(`no pude leer la fecha del ad-hoc: ${e.message}`); }
  }
  const live = sessionLiveness(sid);
  if (live.unknown) deny(`no pude verificar que la sesión no esté viva (${live.unknown})`);
  if (live.alive) deny(`la sesión está viva (pid ${live.pid})`);
  const until = touched + STALE_HOURS * 3600 * 1000;
  if (Date.now() < until) {
    const d = new Date(until);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    deny(`lleva menos de ${STALE_HOURS} h sin tocarse: se podrá después de las ${hhmm} del ${d.toISOString().slice(0, 10)}`);
  }
  try { fs.unlinkSync(file); } catch (e) { deny(`no pude borrar ${file}: ${e.message}`, 1); }
  // appendLog no frena si no puede escribir: se mira que la línea haya quedado y, si no, se avisa.
  const logFile = path.join(STATE_DIR, 'adhoc.log');
  const size = () => { try { return fs.statSync(logFile).size; } catch (_e) { return -1; } };
  const before = size();
  appendLog('adhoc.log', { kind: 'ADHOC_CLEAR_ORPHAN', sessionId: sid, reason, lastTouch: new Date(touched).toISOString(), by: SID });
  if (size() <= before) console.error(`marker.js adhoc clear-orphan: ⚠ se borró, pero no pude dejar la constancia en ${logFile}`);
  process.stdout.write(`adhoc: borrado el de la sesión ${sid} («${reason}»)\n`);
  process.exit(0);
}

/**
 * adopt-session — resume cross-session SIN pérdida de estado.
 *
 * Un resume manual (re-escribir el marker con `set` y un payload parcial) PERDERÍA
 * filesTouched/iterations/dodRuntimeChecked/checks (state lossy). adopt-session copia el marker COMPLETO de la otra sesión al
 * sessionId actual y borra el archivo viejo en la misma operación (atómico:
 * write-own-then-unlink-other; si el unlink falla, pruneStale lo limpia en 24h).
 *
 * Rechaza si ESTA sesión ya tiene marker activo (no pisar un pipeline propio).
 */
function cmdAdoptSession(sid) {
  if (!sid) {
    console.error('marker.js adopt-session: sessionId requerido');
    process.exit(2);
  }
  if (sid === SID) {
    console.error('marker.js adopt-session: esa YA es tu sesión');
    process.exit(2);
  }
  const own = readMarker();
  if (own && own.storyId) {
    console.error(`marker.js adopt-session: esta sesión ya tiene marker activo (story ${own.storyId}) — clear primero si querés adoptar otro`);
    process.exit(1);
  }
  const safe = String(sid).replace(/[/\\]/g, '_');
  const otherPath = path.join(ACTIVE_DIR, `${safe}.json`);
  if (!fs.existsSync(otherPath)) {
    console.error(`marker.js adopt-session: no existe marker de la sesión ${safe}`);
    process.exit(1);
  }
  let other;
  try {
    other = JSON.parse(fs.readFileSync(otherPath, 'utf8'));
  } catch (e) {
    console.error(`marker.js adopt-session: marker de ${safe} ilegible:`, e.message);
    process.exit(1);
  }
  const adopted = { ...other, sessionId: SID, lastTouch: nowIso(), adoptedFrom: safe, adoptedAt: nowIso() };
  writeMarker(adopted);
  try { fs.unlinkSync(otherPath); } catch (_e) { /* pruneStale lo limpia */ }
  process.stdout.write(JSON.stringify(adopted, null, 2));
}

// ============================================================
// Story `status:` frontmatter mutation (fix robusto capa 3)
// Source of truth durable cross-sesión y cross-máquina. Permite que el
// orquestador setee status: in-progress al arrancar y review/done al cerrar.
// Mutación atómica via tmp+rename.
// ============================================================

const VALID_STATUSES = ['ready-for-dev', 'in-progress', 'review', 'done', 'blocked', 'abandoned'];

// La guía del formato pide además `Status: <estado>` bajo el título (`# Story N: …`). Si el frontmatter cambia y esa
// línea no, la historia queda con dos estados y el validador lo marca. Sólo se toca la línea `Status:` que
// sigue al título, separada por renglones vacíos; sin ella, el cuerpo queda igual.
function withBodyStatus(content, newStatus) {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const start = fm ? fm[0].length : 0;
  const body = content.slice(start);
  // el primer título del cuerpo fuera de los bloques de código, y sólo si es el de la story: un ejemplo (adentro de
  // un bloque, antes o después del título) no se toca
  let at = -1, inFence = false, pos = 0;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^# /.test(line)) { at = /^# Story /.test(line) ? pos : -1; break; }
    pos += line.length + 1;
  }
  if (at < 0) return content;
  const rest = body.slice(at).replace(/^(# Story [^\n]*\r?\n(?:[ \t]*\r?\n)*Status:[ \t]*)[\w-]+/, (_, head) => `${head}${newStatus}`);
  return content.slice(0, start) + body.slice(0, at) + rest;
}

function cmdUpdateStoryStatus(storyPath, newStatus) {
  if (!storyPath || !newStatus) {
    console.error('marker.js update-story-status: <storyPath> <newStatus> requeridos');
    console.error(`  Valores válidos de <newStatus>: ${VALID_STATUSES.join(' | ')}`);
    process.exit(2);
  }
  if (!fs.existsSync(storyPath)) {
    console.error(`marker.js update-story-status: story file no existe: ${storyPath}`);
    process.exit(1);
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    console.error(`marker.js update-story-status: status inválido '${newStatus}' — valores: ${VALID_STATUSES.join(' | ')}`);
    process.exit(2);
  }
  const content = fs.readFileSync(storyPath, 'utf8');
  // Frontmatter YAML entre los dos '---' del inicio del archivo.
  const fmRegex = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/;
  const m = content.match(fmRegex);
  if (!m) {
    console.error('marker.js update-story-status: la story no tiene frontmatter YAML válido (esperaba bloque "---...---" al inicio)');
    process.exit(1);
  }
  const fmBody = m[2];
  // Match `status: X` con/sin quotes, preserve indent + trailing inline comment.
  // (las stories de este repo usan `status: ready-for-dev  # nota...` — el comentario
  //  trailing se captura en $2 y se preserva intacto.)
  const statusRegex = /^(\s*status\s*:\s*)["']?[\w-]+["']?([ \t]*(?:#.*)?)$/m;
  if (!statusRegex.test(fmBody)) {
    console.error('marker.js update-story-status: frontmatter no contiene línea `status:`');
    process.exit(1);
  }
  // Reemplazo con FUNCIÓN, nunca con texto: replace lee `$'`, `$&` y `$1` en el texto de reemplazo, y un título con
  // `$'` pegaría el resto del archivo adentro del frontmatter.
  const newFmBody = fmBody.replace(statusRegex, (_, head, tail) => `${head}${newStatus}${tail}`);
  const newContent = withBodyStatus(content.replace(fmRegex, (_, open, _body, close) => `${open}${newFmBody}${close}`), newStatus);
  // Atomic write.
  const tmp = `${storyPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, storyPath);
  process.stdout.write(`status: ${newStatus}\n`);
}

// El estado de una tanda del bloque `pipelines:` de la story (lista de `- name: X` con su `status:`). Lo usa el cierre
// («Cerrar la historia») para pasar a `done` las tandas que ya están en main: `deferrals-open` frena con cualquiera que no lo esté.
const VALID_PIPELINE_STATUSES = ['done', 'in-progress', 'blocked', 'pending'];

function cmdUpdatePipelineStatus(storyPath, which, newStatus) {
  const usage = `  Uso: marker.js update-pipeline-status <storyPath> <tanda|--all> <${VALID_PIPELINE_STATUSES.join(' | ')}>`;
  if (!storyPath || !which || !newStatus) {
    console.error('marker.js update-pipeline-status: faltan argumentos');
    console.error(usage);
    process.exit(2);
  }
  if (!VALID_PIPELINE_STATUSES.includes(newStatus)) {
    console.error(`marker.js update-pipeline-status: estado inválido '${newStatus}' — valores: ${VALID_PIPELINE_STATUSES.join(' | ')}`);
    process.exit(2);
  }
  if (!fs.existsSync(storyPath)) {
    console.error(`marker.js update-pipeline-status: story file no existe: ${storyPath}`);
    process.exit(1);
  }
  const content = fs.readFileSync(storyPath, 'utf8');
  const fmRegex = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/;
  const m = content.match(fmRegex);
  if (!m) {
    console.error('marker.js update-pipeline-status: la story no tiene frontmatter YAML válido');
    process.exit(1);
  }
  const lines = m[2].split('\n');
  const start = lines.findIndex((l) => /^pipelines\s*:\s*(#.*)?$/.test(l));
  if (start < 0) {
    console.error('marker.js update-pipeline-status: el frontmatter no tiene bloque `pipelines:`');
    process.exit(1);
  }
  // Las batches: cada `- name:` del bloque, hasta la próxima clave de nivel raíz.
  const batches = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const nm = lines[i].match(/^(\s*)-\s+name\s*:\s*["']?([^"'#\s]+)["']?/);
    if (nm) { batches.push({ name: nm[2], at: i, indent: nm[1].length, statusAt: -1 }); continue; }
    const cur = batches[batches.length - 1];
    if (cur && cur.statusAt < 0 && /^\s+status\s*:/.test(lines[i])) cur.statusAt = i;
  }
  const chosen = which === '--all' ? batches : batches.filter((t) => t.name === which);
  if (!chosen.length) {
    console.error(`marker.js update-pipeline-status: no hay una tanda '${which}' — las tandas son: ${batches.map((t) => t.name).join(', ') || '(ninguna)'}`);
    process.exit(2);
  }
  const missingStatus = chosen.filter((t) => t.statusAt < 0);
  if (missingStatus.length) {
    console.error(`marker.js update-pipeline-status: la tanda ${missingStatus.map((t) => t.name).join(', ')} no tiene línea \`status:\``);
    process.exit(1);
  }
  const statusRegex = /^(\s*status\s*:\s*)["']?[\w-]+["']?([ \t]*(?:#.*)?)$/;
  for (const t of chosen) {
    lines[t.statusAt] = lines[t.statusAt].replace(statusRegex, (_, head, tail) => `${head}${newStatus}${tail}`);
  }
  const newFmBody = lines.join('\n');
  const newContent = content.replace(fmRegex, (_, open, _body, close) => `${open}${newFmBody}${close}`);
  const tmp = `${storyPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, storyPath);
  for (const t of chosen) process.stdout.write(`${t.name}: ${newStatus}\n`);
}

/**
 * `runtime-waiver <spec> --acs n,m --approved-by "<el dev>" --quote "<cita>" [--relayed-by <sesión>]`: firma los
 * criterios declarados imposibles de probar en vivo con el ok de una persona, en la misma cadena que la firma por terminal
 * (la matriz la lee igual) y con su línea en approvals.jsonl. Sólo los criterios nombrados, y sólo si están pendientes.
 */
function runtimeWaiverConOk(storyPath, argv, m) {
  const waiver = require('./lib/runtime-waiver.js');
  const rm = require('./runtime-matrix.js');
  const cw = require('./lib/critical-waivers.js');
  const { val } = opcionesDe(argv);
  const pedidos = [...new Set(String(val('--acs') || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  if (!pedidos.length) { console.error('marker.js runtime-waiver: con --approved-by hay que nombrar los criterios: --acs <n,m>.'); process.exit(2); }
  // lo firma la persona que vio el criterio: el ok reenviado por otra sesión no vale acá
  if (argv.includes('--relayed-by')) {
    console.error('🚫 marker.js runtime-waiver: no se firmó — el ok para un criterio que no se puede probar en vivo no se acepta reenviado');
    console.error('   por otra sesión: lo da la persona que lo vio, en esta conversación o en su terminal.');
    process.exit(2);
  }
  const wd = require('./lib/waiver-display.js');
  // sólo la historia de la corrida abierta: una copia en otra ruta mostraría a la persona otra cosa que la que se firma
  if (!wd.esLaDelMarcador(storyPath, m)) {
    console.error(`🚫 marker.js runtime-waiver: no se firmó — ${storyPath} no es la historia de la corrida abierta en esta sesión${m && m.storyPath ? ` (${m.storyPath})` : ''}.`);
    process.exit(2);
  }
  const matrix = rm.compute({ storyPath });
  if (matrix.structuralError) { console.error(`marker.js runtime-waiver: la matriz no computa (${matrix.structuralError}).`); process.exit(2); }
  const notRun = matrix.notRun || [];
  if (notRun.length) {
    console.error(`🚫 marker.js runtime-waiver RECHAZADO — hay criterios SIN CORRER que no se pueden eximir: AC ${notRun.map((n) => '#' + n).join(', ')}. Los corre el agente.`);
    process.exit(2);
  }
  const pend = new Set(matrix.notVerifiable || []);
  const ajenos = pedidos.filter((n) => !pend.has(n));
  if (ajenos.length) { console.error(`marker.js runtime-waiver: AC ${ajenos.join(', ')} no está(n) declarado(s) imposible(s) de probar en vivo y pendiente(s) de firma.`); process.exit(2); }
  const criterios = { storyId: String(matrix.sid), sessionId: SID, stateDir: STATE_DIR,
    acs: pedidos.map((n) => ({ ac: n, sha: wd.huella(matrix.perAc[n].text, matrix.perAc[n].declReason, matrix.perAc[n].coveredBy) })) };
  const r = cw.okDeUnaPersona({ approvedBy: val('--approved-by'), quote: val('--quote'), desde: m && m.startedAt, criterios });
  if (!r.ok) {
    console.error(`🚫 marker.js runtime-waiver: no se firmó — ${r.motivo}.`);
    if (r.sinMuestra) {
      const runDir = m && m.storyId ? require('./pipeline.js').resolveRunDir((m && m.repoPath) || process.cwd(), String(m.storyId), true, storyPath) : null;
      console.error('   Si no apareció en pantalla un bloque «Te piden firmar … que no se puede probar en vivo», escribí con Write');
      console.error(`   (no por la terminal) ${runDir ? path.join(runDir, wd.PEDIDO) : wd.PEDIDO} con ${JSON.stringify({ acs: pedidos })}`);
      console.error('   y el arnés se lo muestra. Después, la persona contesta nombrando el criterio; recién ahí, este comando con su cita.');
      console.error(`   O que lo firme en su terminal: node ${__filename} runtime-waiver ${storyPath}`);
      process.exit(1);
    }
    console.error('   El agente nunca firma por su cuenta. El arnés le muestra al dev cada criterio; con su ok, que lo nombre:');
    console.error(`     node ${__filename} runtime-waiver ${storyPath} --acs ${pedidos.join(',')} --approved-by "<el dev>" --quote "<sus palabras, textuales>"`);
    console.error(`   O lo firma el dev en su terminal: node ${__filename} runtime-waiver ${storyPath}`);
    process.exit(1);
  }
  const declHashByAc = {};
  for (const n of pedidos) declHashByAc[n] = waiver.declHashFor(matrix.perAc[n].declReason, matrix.perAc[n].coveredBy);
  const repoRoot = matrix.repoRoot || null;
  const e = r.entrada;
  const entry = waiver.appendWaiver({
    story: matrix.key || matrix.sid, acs: pedidos, matrixHash: matrix.hash, approvedBy: e.delegacion || e.quien, nowIso: nowIso(), declHashByAc,
    logPath: repoRoot ? waiver.repoWaiverLogPath(repoRoot) : undefined,
    ok: { tipo: e.tipo, quien: e.quien, ...(e.delegacion ? { delegacion: e.delegacion } : {}), cita: e.cita, cita_cuando: e.cita_cuando, via: e.via },
  });
  appendLog('gates.log', { type: 'RUNTIME_WAIVER', story: matrix.sid, acs: pedidos, matrixHash: matrix.hash, approvedBy: e.quien, via: e.via });
  const mk = { ...(m || {}), repoPath: repoRoot || (m && m.repoPath) || null, storyId: (m && m.storyId) || matrix.sid, storyPath };
  for (const n of pedidos) {
    anotarAprobacion(mk, { que: `AC ${n} imposible de verificar en vivo`, via: e.via, tipo: e.tipo, quien: e.quien,
      ...(e.delegacion ? { delegacion: e.delegacion } : {}), cita: e.cita, cita_cuando: e.cita_cuando });
  }
  if (repoRoot) console.error(`📌 Firmado en ${waiver.repoWaiverLogPath(repoRoot)} — commitealo: así vale en otra máquina y en CI.`);
  console.error(`✅ Firmado (${e.tipo === 'manual' ? `ok de ${e.quien} en el chat` : `ok de ${e.delegacion} reenviado por ${e.quien}`}): story ${matrix.sid}, AC ${pedidos.join(',')}. Cadena: ${entry.chain}`);
  process.exit(0);
}

// ============================================================
// Un crítico lo decide una persona
// ============================================================
// `waive-critical --rule <id> --file <f> --reason "<r>"` deja la constancia de que una persona eximió ese CRITICAL, y
// sólo así `write-findings` y los cierres de «Hallazgos» y «Preparar el commit» aceptan un CRITICAL `waived`. Tres caminos, en este orden:
//   1. `--approved-by "<el dev>" --quote "<sus palabras>"`: la cita, textual, en un mensaje escrito por el dev en esta
//      conversación (lib/person-ok.js). Manual, a su nombre, con la cita y la hora del mensaje.
//   2. lo mismo + `--relayed-by <rol>`: la cita llegó en un mensaje de la sesión designada en esta máquina para el rol
//      que la organización declara en `approvals.relay_session` (`designate-relay`). Automática, por delegación del dev,
//      a nombre de la sesión.
//   3. `--terminal`: lo corre el dev en su terminal (o la ventana nueva en Windows), como `runtime-waiver`.
// El agente solo no exime: sin ok de nadie, a nombre de «orquestador» o de un agente, o con una cita que no aparece, frena.
function opcionesDe(argv) {
  // una bandera seguida de otra bandera no tiene valor: `--approved-by --quote x` no aprueba a nombre de «--quote»
  const val = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; return v === undefined || /^--/.test(v) ? '' : v; };
  return { val, tiene: (n) => argv.includes(n) };
}

function cmdWaiveCritical(argv) {
  const cw = require('./lib/critical-waivers.js');
  const { val, tiene } = opcionesDe(argv);
  const rule = (val('--rule') || '').trim();
  const file = (val('--file') || '').trim();
  const reason = (val('--reason') || '').trim();
  if (!rule || !reason) {
    console.error('marker.js waive-critical: faltan --rule <regla> y --reason "<por qué>" (y --file <archivo> si el hallazgo lo nombra).');
    process.exit(2);
  }
  const m = readMarker();
  if (!m) { console.error('marker.js waive-critical: no hay marker activo para esta sesión'); process.exit(1); }
  let runDir = null;
  try {
    const storyAbs = resolveStoryPath(m.storyPath, m) || undefined;
    runDir = require('./pipeline.js').resolveRunDir(m.repoPath || process.cwd(), String(m.storyId), true, storyAbs);
  } catch (e) { console.error(`marker.js waive-critical: no pude calcular la carpeta de la corrida (${e.message})`); process.exit(2); }
  if (!runDir) { console.error('marker.js waive-critical: la story no da una clave para su carpeta de corrida'); process.exit(2); }
  const caminos = () => {
    const rs = cw.sesionQueReenvia();
    return [...cw.caminos({ marker: __filename, ruleId: rule, file: file || '<archivo>', relaySession: rs.valor }), ...(rs.aviso ? [`   (sin reenvío: ${rs.aviso})`] : [])];
  };

  let entrada;
  if (tiene('--terminal')) {
    const waiver = require('./lib/runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
      const v = waiver.abrirVentana({ script: __filename, args: ['waive-critical', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js waive-critical: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`} — no se eximió nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) { waiver.anotarVentana(); process.on('exit', () => waiver.pausaFinal()); }
    if (!waiver.hasTty()) {
      console.error('🔒 marker.js waive-critical --terminal BLOQUEADO — necesita una terminal de verdad: lo corre el dev, no el agente.');
      console.error(`     node ${__filename} waive-critical ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      process.exit(2);
    }
    let resp;
    try {
      resp = waiver.promptTty(
        `\n════════ EXIMIR UN CRÍTICO · story ${m.storyId} ════════\n` +
        `Regla: ${rule}${file ? `\nArchivo: ${file}` : ''}\nPor qué: ${reason}\n\n¿Lo eximís? Un crítico eximido va al commit sin arreglar. (si / no) > `,
      );
    } catch (e) { console.error(`🔒 ${e.message}`); process.exit(2); }
    if (!/^s(i|í)?$/i.test(String(resp || '').trim())) { console.error('marker.js waive-critical: no lo eximiste — el crítico sigue abierto.'); process.exit(1); }
    if (waiver.esWindows() && !waiver.confirmarFrase()) { console.error('🔒 marker.js waive-critical: la frase no coincide — no se eximió nada.'); process.exit(1); }
    const quien = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'tty-user';
    entrada = { tipo: 'manual', quien, via: 'waive-critical (terminal)' };
  } else {
    const critico = { rule, file, reason, storyId: String(m.storyId), sessionId: SID, stateDir: STATE_DIR, runDir };
    const r = cw.okDeUnaPersona({ approvedBy: val('--approved-by'), quote: val('--quote'), relayedBy: val('--relayed-by'), desde: m.startedAt, critico });
    if (!r.ok) {
      console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — ${r.motivo}.`);
      if (r.sinConversacion) console.error('   Sin la conversación no puedo comprobar el ok: que el dev lo firme por la terminal (--terminal).');
      if (r.sinMuestra) {
        const pedido = path.join(runDir, require('./lib/critical-display.js').PEDIDO);
        console.error('   Si no apareció en pantalla un bloque «Te piden eximir un crítico» (o el comando llevaba variables de la terminal,');
        console.error('   que el arnés no puede leer: escribí los valores tal cual), escribí con Write (no por la terminal):');
        console.error(`     ${pedido}`);
        console.error(`     ${JSON.stringify({ rule, file, reason })}`);
        console.error('   y el arnés se lo muestra. Después, la persona contesta nombrando el crítico; recién ahí, este comando con su cita.');
        console.error('   O que lo firme en su terminal (--terminal).');
        process.exit(1);
      }
      console.error('   Un crítico lo decide una persona. Los caminos:');
      for (const l of caminos()) console.error(l);
      process.exit(1);
    }
    entrada = r.entrada;
  }
  // Primero el renglón del registro del arnés (que el agente no puede escribir): es lo que hace valer la constancia al
  // cerrar. Si no quedó escrito, no se anota nada ni se anuncia un éxito que después el cierre contradiría.
  const constancia = { ts: nowIso(), rule_id: rule, file, reason, ...entrada };
  appendLog('gates.log', { name: 'critical-waiver', status: 'ok', story: m.storyId, rule, file, ts: constancia.ts, tipo: constancia.tipo, quien: constancia.quien, via: constancia.via, huella: cw.huella(constancia) });
  const enRegistro = cw.fueraDelRegistro(constancia, { story: m.storyId });
  if (enRegistro) {
    console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — no pude dejar el renglón en el registro del arnés (${enRegistro}). Sin él la exención no vale.`);
    process.exit(2);
  }
  const linea = cw.anotar(runDir, constancia);
  anotarAprobacion(m, { que: `exencion ${rule}${file ? ` en ${file}` : ''}`, via: entrada.via, tipo: entrada.tipo, quien: entrada.quien,
    ...(entrada.delegacion ? { delegacion: entrada.delegacion } : {}), ...(entrada.cita ? { cita: entrada.cita, cita_cuando: entrada.cita_cuando } : {}) });
  console.error(`✅ ${rule}${file ? ` en ${file}` : ''} eximido (${linea.tipo === 'manual' ? 'manual' : 'automático, por delegación'}, ${linea.quien}${linea.delegacion ? ` por ${linea.delegacion}` : ''}). Ahora sí se puede anotar como waived en findings.json.`);
  process.exit(0);
}

// `designate-relay --approved-by "<el dev>" --quote "<su frase>"` designa ESTA sesión, en esta máquina, como la que
// reenvía el ok de un dev (el rol de `approvals.relay_session`). La frase la escribe el dev en el chat de esta sesión y
// nombra el rol («Esta sesión es la coordinadora»). Queda un renglón en el gates.log; una designación nueva reemplaza a
// la anterior. Cada reenvío vuelve a buscar la frase en esta conversación (lib/person-ok.js `citaReenviada`).
function cmdDesignateRelay(argv) {
  const cw = require('./lib/critical-waivers.js');
  const { val } = opcionesDe(argv);
  const r = cw.designar({ approvedBy: val('--approved-by'), quote: val('--quote') });
  if (!r.ok) {
    console.error(`🚫 marker.js designate-relay: no se designó nada — ${r.motivo}.`);
    console.error('   El dev escribe en el chat de ESTA sesión una frase que la nombra (por ejemplo «Esta sesión es la coordinadora»),');
    console.error(`   y con su cita: node ${__filename} designate-relay --approved-by '<el dev>' --quote '<su frase, textual>'`);
    process.exit(1);
  }
  const e = r.entrada;
  appendLog('gates.log', { name: cw.DESIGNACION, status: 'ok', ts: nowIso(), sesion: e.sesion, rol: e.rol, quien: e.quien, cita: e.cita, cita_cuando: e.cita_cuando });
  const quedo = cw.designacionVigente();
  if (!quedo || quedo.error || quedo.sesion !== e.sesion) {
    console.error(`🚫 marker.js designate-relay: no pude dejar la designación en el registro del arnés${quedo && quedo.error ? ` (${quedo.error})` : ''}.`);
    process.exit(2);
  }
  console.error(`✅ Esta sesión (${e.sesion}) es la «${e.rol}» de esta máquina, designada por ${e.quien}. Sus mensajes valen como reenvío del ok de un dev (--relayed-by ${cw.sh(e.rol)}).`);
  process.exit(0);
}

// `mark-tested --acs <n,m> (--approved-by <quién> --quote "<cita>" | --terminal)` deja la marca de que una persona probó
// a mano esos criterios de la guía, si la organización lo pide (`qa.manual_check: required`, lib/manual-checks.js). La
// respuesta tiene que ser posterior a la muestra del arnés y nombrar cada criterio. Un reenvío de otra sesión no marca:
// la marca es de quien probó.
function cmdMarkTested(argv) {
  const mc = require('./lib/manual-checks.js');
  const { val, tiene } = opcionesDe(argv);
  const acs = [...new Set(String(val('--acs') || '').split(/[,\s]+/).filter(Boolean).map(Number))];
  if (!acs.length || acs.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error('marker.js mark-tested: falta --acs <números de criterio, separados por coma> (y --approved-by <quién> --quote "<su respuesta>", o --terminal).');
    process.exit(2);
  }
  const p = mc.prendida();
  if (!p.prendida) { console.error('marker.js mark-tested: tu organización no pide la marca a mano; no anoté nada.'); process.exit(0); }
  const m = readMarker();
  if (!m) { console.error('marker.js mark-tested: no hay marker activo para esta sesión'); process.exit(1); }
  const storyAbs = resolveStoryPath(m.storyPath, m);
  if (!storyAbs) { console.error('marker.js mark-tested: no encontré la story de la corrida'); process.exit(2); }
  let runDir = null;
  try { runDir = require('./pipeline.js').resolveRunDir(m.repoPath || process.cwd(), String(m.storyId), true, storyAbs); } catch (e) {
    console.error(`marker.js mark-tested: no pude calcular la carpeta de la corrida (${e.message})`); process.exit(2);
  }
  if (!runDir) { console.error('marker.js mark-tested: la story no da una clave para su carpeta de corrida'); process.exit(2); }
  const todos = mc.criterios(storyAbs);
  const ajenos = acs.filter((n) => !todos.some((c) => c.n === n));
  if (ajenos.length) { console.error(`marker.js mark-tested: ${ajenos.join(', ')} no ${ajenos.length > 1 ? 'son criterios' : 'es un criterio'} de la historia ${m.storyId}.`); process.exit(2); }
  const lista = acs.map((n) => todos.find((c) => c.n === n));
  if (val('--relayed-by') !== null) {
    console.error('🚫 marker.js mark-tested: no se marcó nada — la prueba a mano la marca la persona que probó; un reenvío no la marca.');
    process.exit(1);
  }
  let entrada;
  if (tiene('--terminal')) {
    const waiver = require('./lib/runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la marca: seguí ahí.');
      const v = waiver.abrirVentana({ script: __filename, args: ['mark-tested', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js mark-tested: ${v.estado === 'vencida' ? 'la ventana venció sin marcar' : `no pude abrir la ventana (${v.motivo})`} — no se marcó nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) { waiver.anotarVentana(); process.on('exit', () => waiver.pausaFinal()); }
    if (!waiver.hasTty()) {
      console.error('🔒 marker.js mark-tested --terminal BLOQUEADO — necesita una terminal de verdad: lo corre la persona que probó, no el agente.');
      console.error(`     node ${__filename} mark-tested ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      process.exit(2);
    }
    let resp;
    try {
      resp = waiver.promptTty(`\n════════ PROBADO A MANO · historia ${m.storyId} ════════\n${lista.map((c) => `  Criterio ${c.n} — ${c.text}`).join('\n')}\n\n¿Los probaste a mano? (si / no) > `);
    } catch (e) { console.error(`🔒 ${e.message}`); process.exit(2); }
    if (!/^s(i|í)?$/i.test(String(resp || '').trim())) { console.error('marker.js mark-tested: no se marcó nada.'); process.exit(1); }
    if (waiver.esWindows() && !waiver.confirmarFrase()) { console.error('🔒 marker.js mark-tested: la frase no coincide — no se marcó nada.'); process.exit(1); }
    entrada = { quien: process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'tty-user', via: 'terminal' };
  } else {
    const cw = require('./lib/critical-waivers.js');
    const persona = cw.noEsPersona(val('--approved-by'));
    if (persona) { console.error(`🚫 marker.js mark-tested: no se marcó nada — ${persona}.`); process.exit(1); }
    const cita = String(val('--quote') || '').trim();
    if (!cita) { console.error('marker.js mark-tested: falta la cita (--quote "<la respuesta de la persona, textual>").'); process.exit(2); }
    const visto = mc.mostrado({ stateDir: STATE_DIR, sessionId: SID, storyId: String(m.storyId), acs });
    if (visto && visto.error) { console.error(`🚫 marker.js mark-tested: no pude leer el registro del arnés (${visto.error}): no sé si a la persona se le mostró qué marca.`); process.exit(1); }
    if (!visto) {
      const pok = require('./lib/person-ok.js');
      const conv = pok.leerConversacion({});
      if (!conv.legible) { console.error(`🚫 marker.js mark-tested: no puedo leer la conversación de esta sesión (${conv.motivo}): que la persona lo marque en su terminal (--terminal).`); process.exit(1); }
      console.error('🚫 marker.js mark-tested: no se marcó nada — a la persona no se le mostró qué va a marcar; el arnés se lo muestra al correr este comando (o al escribir marca-pedida.json), y después hace falta su respuesta nombrando los criterios.');
      console.error('   Si no apareció en pantalla el bloque «Vas a marcar como probado a mano», escribí con Write (no por la terminal):');
      console.error(`     ${path.join(runDir, mc.PEDIDO)}`);
      console.error(`     ${JSON.stringify({ acs })}`);
      console.error('   O que la persona lo marque en su terminal (--terminal).');
      process.exit(1);
    }
    let desde = m.startedAt;
    if (!desde || Date.parse(visto.ts) > Date.parse(desde)) desde = visto.ts;
    const r = require('./lib/person-ok.js').citaDeLaPersona(cita, { desde, juzgar: mc.juez(acs) });
    if (!r.legible) { console.error(`🚫 marker.js mark-tested: no puedo leer la conversación de esta sesión (${r.motivo}): que la persona lo marque en su terminal (--terminal).`); process.exit(1); }
    if (r.corta) { console.error('🚫 marker.js mark-tested: la cita es muy corta.'); process.exit(1); }
    if (!r.encontrada) {
      console.error(`🚫 marker.js mark-tested: no se marcó nada — ${r.rechazo || (r.anterior ? 'la respuesta es de antes de que se le mostrara qué marcaba: hace falta su respuesta a la muestra' : 'la cita no la encontré en un mensaje escrito por la persona en esta conversación')}.`);
      process.exit(1);
    }
    entrada = { quien: String(val('--approved-by')).trim(), cita, cita_cuando: r.cuando || null, via: 'ok de la persona en el chat' };
  }
  const ts = nowIso();
  const renglones = acs.map((ac) => ({ ac, story: String(m.storyId), ...entrada, ts }));
  // primero el par en el registro del arnés (que el agente no escribe): sin él la marca no cuenta al cerrar
  for (const r of renglones) appendLog('gates.log', { name: 'manual-check', status: 'ok', story: String(m.storyId), ac: r.ac, ts, quien: r.quien, via: r.via, huella: mc.huellaMarca(r) });
  mc.anotar(runDir, renglones);
  anotarAprobacion(m, { que: `prueba a mano de ${acs.length > 1 ? 'los criterios' : 'el criterio'} ${acs.join(', ')}`, via: entrada.via, tipo: 'manual', quien: entrada.quien, ...(entrada.cita ? { cita: entrada.cita, cita_cuando: entrada.cita_cuando } : {}) });
  console.error(`✅ ${acs.length > 1 ? 'Criterios' : 'Criterio'} ${acs.join(', ')} marcado${acs.length > 1 ? 's' : ''} como probado${acs.length > 1 ? 's' : ''} a mano por ${entrada.quien}.`);
  process.exit(0);
}

// ============================================================
// DODRT-C6 — waiver runtime USER-ONLY (llave TTY)
// ============================================================
// La ÚNICA vía para saltear la verificación runtime por-AC. TTY-only por construcción:
// el agente corre sin terminal controladora → promptTty() tira. El humano confirma en su
// terminal. El agente NO puede ejecutar esto con éxito. Ver lib/runtime-waiver.js.
function cmdRuntimeWaiver(storyArg, argv = []) {
  const waiver = require('./lib/runtime-waiver.js');
  const rm = require('./runtime-matrix.js');

  // Resolver el path de la story (arg explícito o del marker de la sesión).
  const m = readMarker();
  const crudo = storyArg || (m && (m.storyPath || m.specPath || m.storySpec));
  const storyPath = resolveStoryPath(crudo, m);
  if (!storyPath) {
    // 🔴 El mensaje no manda a `--story <abs path .md>`: ese flag NO EXISTE, el argumento es
    // POSICIONAL. Y no le echa la culpa al marker: el problema suele ser que el path guardado es relativo.
    console.error('marker.js runtime-waiver: no encuentro la story.');
    console.error(`  Recibido: ${nn(crudo, '(nada — ni argumento ni marker)')}`);
    console.error('  El path va POSICIONAL (no hay flag `--story`) y conviene ABSOLUTO:');
    console.error(`    node ${__filename} runtime-waiver /abs/path/a/la-story.md`);
    process.exit(2);
  }

  // Con el ok del dev escrito en el chat (o reenviado por la sesión que declara la organización), sin
  // terminal. El agente nunca firma por su cuenta: la cita tiene que estar en un mensaje de la persona.
  if (argv.includes('--approved-by') || argv.includes('--quote') || argv.includes('--relayed-by')) {
    runtimeWaiverConOk(storyPath, argv, m);
    return;
  }

  // 🔴 Windows: no hay /dev/tty. El comando se vuelve a lanzar en una ventana de consola
  // NUEVA y visible, y sólo ésa firma (lib/runtime-waiver.js, «WINDOWS»). Acá, fuera de la ventana, sólo se abre y se espera.
  if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
    console.error(`🪟 Abro una ventana nueva, «Firma del waiver»: seguí ahí. Tenés ${waiver.topeVentanaS() >= 60 ? `${Math.round(waiver.topeVentanaS() / 60)} minutos` : `${waiver.topeVentanaS()} segundos`}.`);
    const v = waiver.abrirVentana({ script: __filename, args: ['runtime-waiver', storyPath] });
    if (v.estado === 'vencida') {
      console.error(`🔒 marker.js runtime-waiver: la ventana venció a los ${v.tope} s sin firmar — no se firmó nada${v.pid ? ` (la ventana arrancó: pid ${v.pid})` : ' (la ventana no llegó a arrancar el comando)'}.`);
      process.exit(1);
    }
    if (v.estado === 'no-abrio') {
      console.error(`🔒 marker.js runtime-waiver: no pude abrir la ventana de la firma (${v.motivo}) — no se firmó nada.`);
      process.exit(2);
    }
    process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
  }
  if (waiver.esWindows()) {
    waiver.anotarVentana();
    // en la ventana, toda salida espera un Enter antes de cerrarse: que la persona lea el resultado (el tope igual corre)
    process.on('exit', () => waiver.pausaFinal());
  }

  // Freno físico ANTES de computar nada: si no hay terminal, ni arrancamos.
  if (!waiver.hasTty()) {
    // las dos vías, en llano: el agente no firma; firma la persona, en el chat o en su terminal
    let version = 'desconocida';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'version.json'), 'utf8')).version || version; } catch (_) { /* sin version.json: se dice desconocida */ }
    console.error(waiver.esWindows()
      ? '🔒 marker.js runtime-waiver BLOQUEADO — en Windows firma sólo la ventana NUEVA que abre este comando, sin otro proceso conectado: corrido desde el agente o con la entrada redirigida, no firma.'
      : '🔒 marker.js runtime-waiver BLOQUEADO — acá no hay una terminal de una persona (/dev/tty): el agente no puede firmar.');
    console.error('   Un criterio que no se puede probar en vivo lo firma una persona, de una de estas dos formas:');
    console.error('   (a) En el chat: pedile al agente la firma de ese criterio; el arnés te lo muestra y vos contestás «firmo el AC N».');
    console.error(`   (b) En tu terminal: node ${__filename} runtime-waiver ${storyPath}${waiver.esWindows() ? '  (en Windows abre una ventana para firmar)' : ''}`);
    console.error(`   Versión del arnés: ${version}. Si no está al día (en Windows la firma por ventana llegó el 2026-10-15), actualizalo con /tycon-harness.`);
    process.exit(2);
  }

  const matrix = rm.compute({ storyPath });
  if (matrix.structuralError) {
    console.error(`marker.js runtime-waiver: la matriz no computa (${matrix.structuralError}).`);
    process.exit(2);
  }
  if (matrix.green) {
    console.error('marker.js runtime-waiver: la matriz YA está verde — no hay nada que waivear.');
    process.exit(0);
  }

  // 🔴 REGLA: el waiver SÓLO aplica a los ACs declarados imposibles de
  // verificar corriendo (runtime_not_verifiable). Si hay ACs SIN CORRER (no declarados), se
  // REHÚSA — esos el agente los tiene que correr, no se pueden saltear.
  const notRun = matrix.notRun || [];
  if (notRun.length > 0) {
    console.error('🚫 marker.js runtime-waiver RECHAZADO — hay ACs SIN CORRER que NO se pueden waivear:');
    console.error(`   AC ${notRun.map((n) => '#' + n).join(', ')}`);
    console.error('   Estos NO están declarados como imposibles de verificar corriendo la app.');
    console.error('   El agente debe correrlos (E2E/smoke) — o, si de verdad son imposibles,');
    console.error('   declararlos en el frontmatter `runtime_not_verifiable:` (reason + covered_by test).');
    console.error('   El waiver es SÓLO para lo declarado-imposible, no para lo no-corrido.');
    process.exit(2);
  }

  const pend = matrix.notVerifiable || [];
  if (pend.length === 0) {
    console.error('marker.js runtime-waiver: no hay ACs declarados-imposibles pendientes de waiver.');
    process.exit(0);
  }

  // 🔴 CONFIRMACIÓN POR-AC: NO una frase que aprueba todo de golpe (rubber-stamp).
  // Se muestra CADA AC con su razón + el test que lo cubre, y el usuario aprueba UNO POR UNO. Sólo se
  // waivean los que aprobó explícitamente; si rechaza alguno, ése bloquea (el agente lo tiene que
  // resolver — correrlo, o corregir la razón). El detalle también se le presenta en la conversación
  // ANTES de correr esto (lo pide el SKILL.md); acá es el sello seguro, no la primera vez que lo ve.
  let intro;
  try {
    intro = waiver.promptTty(
      `\n════════ WAIVER RUNTIME · story ${matrix.sid} ════════\n` +
      `Hay ${pend.length} AC declarados IMPOSIBLES de verificar corriendo la app. Te los muestro UNO\n` +
      `POR UNO con su razón y el test que lo cubre; aprobás cada uno por separado (si / no).\n` +
      `(Enter para empezar) `,
    );
  } catch (e) {
    console.error(`🔒 ${e.message}`);
    process.exit(2);
  }
  void intro;

  const approved = [];
  const rejected = [];
  for (const n of pend) {
    const reason = matrix.perAc[n].declReason || '(sin razón declarada)';
    const cov = matrix.perAc[n].coveredBy || (matrix.perAc[n].code || []).join(', ') || 'test de código';
    // 🔴 El TEXTO del AC va PRIMERO. Sin él, el usuario aprobaría saltear la verificación de algo sin
    // nombre: la excusa sin el hecho. Es el mismo rubber-stamp que la confirmación por-AC evita, un
    // nivel más abajo.
    const texto = matrix.perAc[n].text;
    let ans;
    try {
      ans = waiver.promptTty(
        `\n──────── AC #${n} ────────\n` +
        `QUÉ DICE EL AC:\n  ${texto ? texto : '(no se pudo citar del spec — abrí la story antes de aprobar)'}\n\n` +
        `Por qué NO se puede verificar corriendo la app:\n  ${reason}\n` +
        `Cubierto por (test que ya corrió): ${cov}\n\n` +
        `¿Aprobás saltar la verificación POR-LA-APP de AC#${n}? (si / no) > `,
      );
    } catch (e) {
      console.error(`🔒 ${e.message}`);
      process.exit(2);
    }
    if (/^s(i|í)?$/i.test((ans || '').trim())) approved.push(n);
    else { rejected.push(n); console.error(`   → AC#${n} NO aprobado — queda bloqueado.`); }
  }

  if (approved.length === 0) {
    console.error('\nmarker.js runtime-waiver: no aprobaste ningún AC — sin waiver.');
    process.exit(1);
  }

  // En Windows, la última llave: la frase al azar que sólo se ve en la ventana.
  if (waiver.esWindows() && !waiver.confirmarFrase()) {
    console.error('\n🔒 marker.js runtime-waiver: la frase no coincide — no se firmó nada.');
    process.exit(1);
  }

  const approvedBy = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'tty-user';
  // 🔴 La aprobación se ancla a la DECLARACIÓN de cada AC (su razón + el test que lo cubre) y se firma
  // DENTRO del repo, en `.tycon/runtime-waivers.jsonl`: la declaración vive en la story y viaja con el
  // repo. El `matrixHash` pinnea la evidencia de `.advisors/` (gitignoreada), así que no sirve de ancla
  // entre máquinas ni en CI. NO se usa el frontmatter para el registro: un ack que el agente puede
  // escribir es un agujero.
  const declHashByAc = {};
  for (const n of approved) {
    declHashByAc[n] = waiver.declHashFor(matrix.perAc[n].declReason, matrix.perAc[n].coveredBy);
  }
  const repoRoot = matrix.repoRoot || null;
  // `story` lleva la CLAVE de la story: con número único es el número de siempre; con número repetido,
  // `<tema>__<número>`, para que la firma no le valga a otra story del mismo número.
  const entry = waiver.appendWaiver({
    story: matrix.key || matrix.sid, acs: approved, matrixHash: matrix.hash, approvedBy, nowIso: nowIso(),
    declHashByAc,
    logPath: repoRoot ? waiver.repoWaiverLogPath(repoRoot) : undefined,
  });
  if (repoRoot) {
    console.error(`\n📌 Firmado en ${waiver.repoWaiverLogPath(repoRoot)}`);
    console.error('   COMMITEALO: es lo que hace que tu aprobación valga en otra máquina y en CI.');
  }
  appendLog('gates.log', { type: 'RUNTIME_WAIVER', story: matrix.sid, acs: approved, rejected, matrixHash: matrix.hash, approvedBy });
  // La firma por terminal es de una persona (el agente no tiene terminal): manual, una línea por AC.
  {
    const mk = { ...(m || {}), repoPath: repoRoot || (m && m.repoPath) || null, storyId: (m && m.storyId) || matrix.sid, storyPath };
    for (const linea of require('./lib/approvals.js').lineasDeFirmaPorTerminal(approved, approvedBy)) anotarAprobacion(mk, linea);
  }
  console.error(`\n✅ Waiver registrado (TTY): story ${matrix.sid}, ACs aprobados ${approved.join(',')}${rejected.length ? ` · rechazados ${rejected.join(',')}` : ''}, hash ${matrix.hash}, por ${approvedBy}.`);
  console.error(`   Pinneado al hash actual: si el código/evidencia cambian, se invalida solo.`);
  console.error(`   Cadena: ${entry.chain}`);
  if (rejected.length) console.error(`   ⚠ AC ${rejected.join(',')} quedaron sin aprobar → la matriz sigue roja para esos; el agente los tiene que resolver.`);
  process.exit(0);
}

// ============================================================
// Carril AD-HOC — hotfix / ajuste chico SIN story, declarado por sesión.
// Es la salida (b) del portón de carril (lib/story-gate.js): un repo bajo el arnés no acepta
// código sin pipeline activo ni esta declaración. Archivo: adhoc/<sid>.json
//   { reason, maxFiles, files[], declaredAt, lastTouch }
// El cupo lo cuentan los archivos de IMPLEMENTACIÓN distintos (on-edit.js los registra en
// PostToolUse); al pasarse, el portón vuelve a cerrar (→ story + pipeline, o re-declarar con cupo
// mayor y motivo). Todo queda en adhoc.log. `adhoc clear` lo termina; `marker.js set` (pipeline)
// tiene prioridad sobre él aunque siga existiendo.
// ============================================================
function cmdAdhoc(sub, payloadJson) {
  if (sub === 'clear-orphan') return cmdAdhocClearOrphan(payloadJson);
  const io = require('./lib/story-gate-io.js');
  const existing = io.readAdhoc(STATE_DIR, SID);
  if (sub === 'get') {
    process.stdout.write(JSON.stringify(existing, null, 2) + '\n');
    process.exit(existing ? 0 : 1);
  }
  if (sub === 'clear') {
    try { fs.unlinkSync(io.adhocPath(STATE_DIR, SID)); } catch (_e) { /* el archivo no existe */ }
    appendLog('adhoc.log', { kind: 'ADHOC_CLEAR', reason: existing ? existing.reason : null, files: existing ? (existing.files || []).length : 0 });
    process.stdout.write('adhoc: cleared\n');
    process.exit(0);
  }
  if (sub === 'set') {
    let payload;
    try { payload = JSON.parse(payloadJson || ''); } catch (err) {
      console.error('marker.js adhoc set: payload JSON inválido —', err.message);
      console.error('  Uso: marker.js adhoc set \'{"reason":"<qué y por qué, en palabras del user>","maxFiles":8}\'');
      process.exit(2);
    }
    const reason = String(payload.reason || '').trim();
    if (reason.length < 8) {
      console.error('marker.js adhoc set: "reason" requerido (≥8 caracteres) — en palabras del USER, no tuyas.');
      process.exit(2);
    }
    // El carril NO se adivina por regex (ver el
    // comentario grande en lib/story-gate.js). El juicio de `adhoc set` queda en DOS capas:
    //   1. MECÁNICA: el reason tiene que ser un fragmento literal de lo que escribió el user
    //      (reasonInPrompts sobre el ring que sólo escribe on-prompt.js — el agente no puede
    //      inyectar ahí).
    //   2. MODELO: el clasificador (lib/lane-classifier.js) lee los prompts REALES y contesta qué
    //      autorizó el humano. Castellano lo interpreta un modelo, no un regex. Corre SIEMPRE que
    //      esté disponible — `adhoc set` pasa una vez por sesión, el costo es marginal — y su
    //      veredicto GANA sobre la cita: si dice 'pipeline' (el user pidió una story), citar al
    //      user no alcanza para el atajo; si dice 'adhoc', una cita fallida no traba.
    //   Sin modelo (tests, sin binario, timeout): decide la capa mecánica sola, como siempre.
    // Kill-switch del dev: TYCON_STORY_GATE=off.
    const gate = require('./lib/story-gate.js');
    const lane = io.readLane(STATE_DIR, SID);
    const recentAll = lane && Array.isArray(lane.recentPrompts) ? lane.recentPrompts : [];
    const gateOn = process.env.TYCON_STORY_GATE !== 'off';

    // Un ring vacío no cita nada: `quoted=true` ahí sería un fail-open doble (hook de prompt roto +
    // sin modelo = cualquier reason inventado pasaría). Un ring
    // vacío significa que NO HAY nada citable: la cita falla, y el mensaje de abajo dice cómo
    // seguir (preguntarle al user; si el user YA contestó y esto se repite, el hook on-prompt no
    // está corriendo y eso es lo que hay que arreglar).
    const quoted = gateOn ? (recentAll.length > 0 && gate.reasonInPrompts(reason, recentAll)) : true;
    let llm = { lane: null, via: 'sin-consulta' };
    if (gateOn && recentAll.length) {
      try { llm = require('./lib/lane-classifier.js').classifyLane(recentAll); } catch (_) { llm = { lane: null, via: 'error' }; }
    }

    const ask =
      `🔴 NO cierres el turno con este texto: está escrito para VOS. Preguntale al user en castellano ` +
      `llano, p. ej.: "Esto toca código del repo. ¿Lo hago como ajuste puntual —decime que es un ` +
      `hotfix y sigo— o querés que vaya con story y revisión completa?". Su respuesta es citable y ` +
      `destraba este comando. Prohibido nombrarle "carril", "marker", "ad-hoc", "el arnés" o esta ` +
      `salida: no significan nada para él.\n` +
      `   · SUBAGENTE (sin AskUserQuestion): no elijas vos — cerrá tu reporte pidiendo que le ` +
      `pregunten al user.`;

    if (gateOn && llm.lane === 'pipeline') {
      // El modelo leyó los prompts del user y dice que pidió una story: el atajo no corre, ni
      // siquiera citándolo (citar un pedido de story como motivo de un ad-hoc es
      // exactamente el anti-pattern que este freno existe para parar).
      console.error(
        `marker.js adhoc set: DENEGADO — leyendo los últimos mensajes del user, lo que pidió es una ` +
        `story/spec por el pipeline, no un ajuste suelto.\n\n` +
        `  (a) Si es así → Skill(skill="tycon-pipeline", args="implementemos …").\n` +
        `  (b) Si el user QUIERE el atajo, que lo diga en su próximo mensaje ("es un hotfix", "sin ` +
        `story") — eso cambia el veredicto.\n\n` + ask,
      );
      appendLog('adhoc.log', { kind: 'ADHOC_LLM_DENIED_LANE', reason, via: llm.via, cwd: process.cwd() });
      process.exit(2);
    }
    if (gateOn && !quoted && llm.lane !== 'adhoc') {
      console.error(
        `marker.js adhoc set: DENEGADO — "reason" tiene que ser un fragmento LITERAL de lo que escribió el user ` +
        `(≥${gate.ADHOC_REASON_MIN_CHARS} caracteres; se compara sin mayúsculas ni acentos), no una paráfrasis tuya.\n\n` +
        `CÓMO SE ARREGLA (es mecánico): copiá y pegá un pedazo del prompt del user TAL CUAL lo escribió — ` +
        `con sus typos, sin traducir, sin resumir. Ej: si escribió "actualiza el sp de desduplicación e ` +
        `incluilo en el repo", un reason válido es "actualiza el sp de desduplicacion" y uno inválido es ` +
        `"el user pidió actualizar un stored procedure".\n\n` +
        `SI NO HAY NADA CITABLE (el pedido quedó fuera de los últimos ${io.LANE_RECENT_PROMPTS || 8} mensajes, ` +
        `o sólo dijo "dale"/"si"): NO fabriques una cita. ` + ask,
      );
      appendLog('adhoc.log', { kind: 'ADHOC_DENIED_REASON', reason, via: llm.via, cwd: process.cwd() });
      process.exit(2);
    }
    // Sin modelo, citar el PROPIO pedido de story como motivo del atajo
    // pasaría la capa mecánica: es el anti-pattern que este freno existe para parar.
    // El veto no adivina nada: mira SOLO el prompt
    // que la declaración cita como su autorización, y si ese prompt es un pedido explícito de
    // story (STORY_INTENT_PATTERNS, fuente única con el reminder), el atajo no corre. El modelo
    // (ADHOC) puede abrirlo igual — el user pudo cambiar de idea en otro prompt.
    if (gateOn && quoted && llm.lane !== 'adhoc' && gate.quotedPromptAsksStory(reason, recentAll)) {
      console.error(
        `marker.js adhoc set: DENEGADO — el texto que citás como motivo ES un pedido de implementar ` +
        `una story ("${reason.slice(0, 80)}"). Citar el pedido de la story como autorización del atajo ` +
        `es exactamente el anti-pattern que este freno existe para parar.\n\n` +
        `  (a) Si es una story → Skill(skill="tycon-pipeline", args="implementemos …").\n` +
        `  (b) Si el user QUIERE el atajo, que lo diga: su próximo mensaje es citable.\n\n` + ask,
      );
      appendLog('adhoc.log', { kind: 'ADHOC_DENIED_STORY_QUOTE', reason, via: llm.via, cwd: process.cwd() });
      process.exit(2);
    }
    if (gateOn && quoted && llm.lane === null && llm.via !== 'sin-consulta') {
      // El atajo se abre por la cita SOLA, sin juez (modelo apagado/ausente/tímido). Es legal —
      // falla hacia lo mecánico— pero NO silencioso: queda su propia constancia para el --report
      // del medidor (¿cuántos atajos pasan sin juez? si son muchos, el juez no está juzgando).
      appendLog('adhoc.log', { kind: 'ADHOC_SET_UNJUDGED', reason, via: llm.via, cwd: process.cwd() });
    }
    if (gateOn && !quoted && llm.lane === 'adhoc') {
      // El modelo abrió lo que la capa mecánica había cerrado: constancia propia — es el único
      // evento del clasificador que merece revisión humana (lo grita lane-llm-notice al arranque).
      appendLog('adhoc.log', {
        kind: 'ADHOC_LLM_OVERRIDE_LANE', reason,
        lanePrompt: String(recentAll[recentAll.length - 1] || '').replace(/\s+/g, ' ').slice(0, 160),
        via: llm.via, cwd: process.cwd(),
      });
    }
    const maxFiles = Number.isFinite(Number(payload.maxFiles)) && Number(payload.maxFiles) > 0
      ? Number(payload.maxFiles) : (existing ? existing.maxFiles : 8);
    const obj = {
      reason, maxFiles,
      files: existing ? (existing.files || []) : [],
      declaredAt: existing ? existing.declaredAt : nowIso(),
      lastTouch: nowIso(),
      cwd: process.cwd(),
    };
    io.writeAdhoc(STATE_DIR, SID, obj);
    appendLog('adhoc.log', { kind: existing ? 'ADHOC_UPDATE' : 'ADHOC_SET', reason, maxFiles, prevMaxFiles: existing ? existing.maxFiles : null, files: obj.files.length, cwd: process.cwd() });
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    process.exit(0);
  }
  console.error('marker.js adhoc: uso — adhoc set \'{"reason":"…","maxFiles":N}\' | adhoc get | adhoc clear | adhoc clear-orphan <sessionId>');
  process.exit(2);
}

// Escape consciente del freno de STORY A MANO (lib/story-skill-gate.js): deja la misma
// marca que dejaría la invocación de tycon-create-story, pero con skill:'bypass' + la razón, y queda
// en bypass.log (STORY_SKILL_BYPASS). La razón tiene que venir del USER (mismo contrato que
// `adhoc set`): es el user quien decide que ESTA story se escribe a mano, no el agente.
function cmdStorySkillBypass() {
  // Escribir una historia sin la skill lo decide la persona, y este comando ya no deja constancia: un modelo frenado lo
  // corrió solo con una razón inventada («el usuario lo pidió»). Con «autorizo story-skill-bypass» escrita por la persona
  // en un turno suyo, el freno mismo deja pasar la historia: él sabe qué pedido juzga y lo ancla en la conversación.
  console.error('🚫 marker.js story-skill-bypass: no deja constancia — escribir la historia sin la skill lo decide la persona.');
  console.error('   Usá la skill tycon-create-story. Si la persona quiere la historia sin la skill, lo dice ella en su mensaje y el freno la deja pasar.');
  process.exit(1);
}

// La nota de «repensar el enfoque» de una vuelta de revisores (desde la tercera la exige `pipeline.js smart-reloop`).
// Uso: marker.js rethink --iter N --repeated "<qué se repitió>" (--change "<qué cambia>" | --keep "<por qué sigue igual>")
//        [--story-change "<qué cambia de la story>"] [--repo <repo> --story <spec.md>] [--run-dir <corrida>]
// Se guarda en <corrida>/rethink/iter-N.json con su hora. La corrida sale del marcador de la sesión o de --repo/--story,
// con el mismo criterio que usa pipeline.js para elegir la carpeta.
function cmdRethink(argv) {
  const rt = require('./lib/rethink.js');
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] === undefined ? '' : argv[i + 1]) : undefined; };
  const iterRaw = flag('--iter');
  const note = { iter: /^\d+$/.test(String(iterRaw)) ? Number(iterRaw) : iterRaw };
  for (const [key, opt] of [['repeated', '--repeated'], ['change', '--change'], ['keep', '--keep'], ['story_change', '--story-change']]) {
    const v = flag(opt);
    if (v !== undefined) note[key] = rt.clean(v);
  }
  const errors = rt.validateNote(note);
  if (errors.length) {
    console.error('marker.js rethink: la nota no se guardó.');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('  Uso: marker.js rethink --iter N --repeated "<qué se repitió>" (--change "<qué cambia del enfoque>" | --keep "<por qué sigue igual>") [--story-change "<qué cambia de la story>"]');
    process.exit(2);
  }
  let marker = null;
  try { marker = readMarker(); } catch (e) { marker = null; console.error(`marker.js rethink: no pude leer el marcador de la sesión (${String(e && e.message).slice(0, 80)}); sigo con lo que pasaste por argumento.`); }
  const repoArg = flag('--repo') || (marker && marker.repoPath);
  const storyArg = flag('--story') || (marker && marker.storyPath);
  const runDirArg = flag('--run-dir') || null;
  let runDir = null;
  // 🔴 Con o sin --run-dir, la carpeta es la que `resolveRunDir` da para esta story y este repo: --run-dir sólo la confirma.
  if (!repoArg || !storyArg) {
    console.error('marker.js rethink: no sé de qué corrida es la nota. Pasá --repo <repo> --story <spec.md>, o corré el comando dentro de la sesión del pipeline.');
    process.exit(2);
  }
  {
    const repo = path.resolve(repoArg);
    const storyPath = path.isAbsolute(storyArg) ? storyArg : path.join(repo, storyArg);
    const { resolveRunDir, deriveStoryId } = require('./pipeline.js');
    const storyId = deriveStoryId(storyPath) || (marker && marker.storyId ? String(marker.storyId) : null);
    if (!storyId) {
      console.error(`marker.js rethink: no pude leer la story ${storyPath}, así que no sé en qué carpeta guardar la nota.`);
      process.exit(2);
    }
    runDir = resolveRunDir(repo, storyId, !runDirArg, storyPath);
    if (!runDir) {
      console.error(runDirArg
        ? `marker.js rethink: --run-dir ${runDirArg} no es la carpeta de corrida de esta story (${storyId}): esta story todavía no tiene carpeta de corrida. Quitá --run-dir.`
        : 'marker.js rethink: no pude resolver la carpeta de la corrida bajo .advisors/pipeline-runs/ (si el número de la story se repite en su repo, la carpeta lleva la clave: `pipeline.js evidence-key --story <ruta>` dice por qué no se pudo calcular).');
      process.exit(2);
    }
    if (runDirArg) {
      const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
      if (real(path.resolve(runDirArg)) !== real(runDir)) {
        console.error(`marker.js rethink: --run-dir ${runDirArg} no es la carpeta de corrida de esta story (${storyId}): la que corresponde es ${runDir}. Quitá --run-dir o pasá esa.`);
        process.exit(2);
      }
    }
  }
  const file = rt.notePath(runDir, note.iter);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...note, at: nowIso() }, null, 2) + '\n', 'utf8');
  process.stdout.write(`${file}\n`);
}

// Las opciones viejas siguen andando hasta el retiro (también desde una sesión abierta con las
// instrucciones de antes en la memoria)
require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/marker.js');
const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch (cmd) {
  case 'set':
    cmdSet(arg1);
    break;
  case 'get':
    cmdGet();
    break;
  case 'touch':
    cmdTouch();
    break;
  case 'complete-step':
    cmdCompleteStep(arg1, process.argv.slice(4));
    break;
  case 'start-step':
    cmdStartStep(arg1);
    break;
  case 'append-file':
    cmdAppendFile(arg1);
    break;
  case 'clear':
    cmdClear();
    break;
  case 'is-active':
    cmdIsActive();
    break;
  case 'list-all':
    cmdListAll();
    break;
  case 'find-by-story':
    cmdFindByStory(arg1);
    break;
  case 'clear-session':
    cmdClearSession(arg1);
    break;
  case 'adopt-session':
    cmdAdoptSession(arg1);
    break;
  case 'update-story-status':
    cmdUpdateStoryStatus(arg1, arg2);
    break;
  case 'update-pipeline-status':
    cmdUpdatePipelineStatus(arg1, arg2, process.argv[5]);
    break;
  case 'mark-dod-runtime-checked':
    cmdMarkDodRuntimeChecked(arg1);
    break;
  case 'set-autonomous':
    cmdSetAutonomous(arg1);
    break;
  case 'set-check':
    cmdSetCheck(arg1, arg2, process.argv[5]);
    break;
  case 'run-check':
    cmdRunCheck(process.argv.slice(3));
    break;
  case 'mark-tests-not-scoped':
    cmdMarkTestsNotScoped(arg1);
    break;
  case 'tests-failed':
    cmdTestsFailed(process.argv.slice(3));
    break;
  case 'mark-tests-not-measured':
    cmdMarkTestsNotMeasured(arg1);
    break;
  case 'set-flag':
    cmdSetFlag(arg1, arg2);
    break;
  case 'start-warning':
    cmdStartWarning(arg1, arg2);
    break;
  case 'close-as-debt':
    cmdCloseAsDebt(process.argv.slice(3));
    break;
  case 'expect-red':
    cmdExpectRed(process.argv.slice(3));
    break;
  case 'set-size':
    cmdSetSize(process.argv.slice(3));
    break;
  case 'set-models':
    cmdSetModels(process.argv.slice(3));
    break;
  case 'mark-models-warned':
    cmdMarkModelsWarned(process.argv.slice(3));
    break;
  case 'snapshot-iter':
    cmdSnapshotIter(arg1, process.argv.slice(4));
    break;
  case 'runtime-waiver':
    cmdRuntimeWaiver(arg1, process.argv.slice(4));
    break;
  case 'waive-critical':
    cmdWaiveCritical(process.argv.slice(3));
    break;
  case 'designate-relay':
    cmdDesignateRelay(process.argv.slice(3));
    break;
  case 'mark-tested':
    cmdMarkTested(process.argv.slice(3));
    break;
  case 'mark-adversarial-launched':
    cmdMarkAdversarialLaunched(arg1, arg2);
    break;
  case 'mark-adversarial-result':
    cmdMarkAdversarialResult(arg1);
    break;
  case 'mark-adversarial-skipped':
    cmdMarkAdversarialSkipped(process.argv.slice(3));
    break;
  case 'mark-adversarial-gate':
    cmdMarkAdversarialGate(arg1);
    break;
  case 'promote-probe':
    cmdPromoteProbe(arg1);
    break;
  case 'adhoc':
    cmdAdhoc(arg1, arg2);
    break;
  case 'doing':
    cmdDoing(arg1, arg2);
    break;
  case 'story-skill-bypass':
    cmdStorySkillBypass();
    break;
  case 'approve-mockup':
    cmdApproveMockup(process.argv.slice(3));
    break;
  case 'rethink':
    cmdRethink(process.argv.slice(3));
    break;
  default:
    console.error(`marker.js: comando desconocido '${cmd}'`);
    console.error(
      'Usage: marker.js <set|get|touch|complete-step|append-file|clear|is-active|' +
        'list-all|find-by-story|clear-session|adopt-session|update-story-status|' +
        'mark-dod-runtime-checked|set-autonomous|set-check|run-check|set-flag|set-size|snapshot-iter|' +
        'mark-adversarial-launched|mark-adversarial-result|mark-adversarial-skipped|mark-adversarial-gate|promote-probe|adhoc|story-skill-bypass|' +
        'approve-mockup|rethink> [arg] [arg2]',
    );
    process.exit(2);
}
