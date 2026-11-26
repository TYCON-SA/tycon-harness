#!/usr/bin/env node
/**
 * tycon-pipeline marker — state CRUD utility.
 *
 * El marker indica "hay una story Mary+GOLD mid-impl bajo tycon-pipeline". Los
 * hooks (`on-prompt.js`, `on-edit.js`) lo consultan para emitir reminders al
 * orquestador (Claude) cuando detectan patrones de bypass.
 *
 * 🔴 Multi-sesión sin carreras: cada sesión de Claude Code tiene su
 * propio archivo `~/.tycon/state/active/<sessionId>.json` que contiene
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
 *   marker.js get --strict → igual, y sale 3 si el marcador de esta sesión existe y no se deja leer
 *   marker.js touch        → actualiza lastTouch
 *   marker.js complete-step <N>  → mueve step N pending→completed
 *   marker.js append-file <abs-path>  → agrega path a filesTouched (dedup)
 *   marker.js clear        → borra el marker de esta sesión
 *   marker.js is-active    → exit 0 si esta sesión tiene marker, 1 si no
 *
 * Antes de pedir la firma de un criterio imposible de probar en vivo:
 *   marker.js check-runtime-waiver <spec> [--acs n,m] → si la firma de runtime-waiver pasaría, sin firmar
 *                                                  (0 pasaría · 1 no, con el porqué · 2 sin la historia)
 *
 * Cross-session discovery:
 *   marker.js list-all                        → JSON array con TODOS los markers activos
 *                                                  (todas las sesiones), stale-filtered
 *   marker.js find-by-story <storyId>           → JSON array con markers que matcheen
 *                                                  ese storyId (cualquier sesión)
 *   marker.js clear-session <sessionId>         → borra el marker de OTRA sesión
 *                                                  (recovery / admin); sin marker, lo dice y sale 1
 *   marker.js clear-session <sessionId> --lost  → cierra como perdida una ejecución a la que le falta una pieza
 *                                                  (lib/open-runs.js); pide la frase del dueño
 *   marker.js restore <sessionId>               → rearma en esta sesión el marcador de una ejecución perdida, desde
 *                                                  la copia de su apertura; pide la frase del dueño
 *   marker.js park <historia> --queue | --until AAAA-MM-DD [--session <id>] → marca una corrida dejada a propósito («en
 *                                                  fila» o «en pausa»), aunque su sesión esté cerrada: nunca se ofrece
 *                                                  limpiarla, y clear-session se niega. Sin firma: la marca no autoriza nada.
 *   marker.js unpark <historia>                 → saca esa marca
 *   marker.js adhoc clear-orphan <sessionId>    → borra el ad-hoc de OTRA sesión, sólo si no está viva
 *                                                  y lleva más de 24 h sin tocarse
 *   marker.js doing "<qué hago>" | doing clear  → anota (o borra) qué hace esta sesión sin story, para /wip; NO es un
 *                                                  permiso. `doing clear-orphan <sid>`: la de otra sesión que no vive.
 *                                                  Con una story abierta sólo anota `doing --waiting-for "<qué espera>"`.
 *   marker.js conditions "<texto>"              → anota en la ejecución las condiciones que puso el dev al pedirla
 *                                                  (o «ninguna»): `next` las pide antes de cada punto de control
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
 *                                                  Loguea a ~/.tycon/state/gates.log
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
 *   marker.js lift-debt --debt <DEF-id>          → levanta la deuda del cierre ya pagada: cada rojo esperado vuelve a
 *                                                  ser rojo y «Preparar» pide todo en verde. Sin firma: no afloja nada.
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

// las partes de marker.js (lib/marker-*.js): si falta una, se dice en una línea y sale 2
const parte = (cargar, nombre) => {
  try { return cargar(); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].indexOf(nombre) >= 0) {
      console.error('marker.js: falta una parte suya, lib/' + nombre + ' (reinstalá el arnés; `/tycon-harness` dice si quedó bien instalado)');
      process.exit(2);
    }
    throw e;
  }
};
const { arg1, arg2, cmd } = parte(() => require('./lib/marker-shared.js'), 'marker-shared.js');
const cmdAdhoc = (...a) => parte(() => require('./lib/marker-adhoc.js'), 'marker-adhoc.js').cmdAdhoc(...a);
const cmdFreezeAdversarial = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdFreezeAdversarial(...a);
const cmdMarkAdversarialGate = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdMarkAdversarialGate(...a);
const cmdMarkAdversarialLaunched = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdMarkAdversarialLaunched(...a);
const cmdMarkAdversarialResult = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdMarkAdversarialResult(...a);
const cmdMarkAdversarialSkipped = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdMarkAdversarialSkipped(...a);
const cmdPromoteProbe = (...a) => parte(() => require('./lib/marker-adversarial.js'), 'marker-adversarial.js').cmdPromoteProbe(...a);
const cmdCloseAsDebt = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdCloseAsDebt(...a);
const cmdExpectRed = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdExpectRed(...a);
const cmdLiftDebt = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdLiftDebt(...a);
const cmdMarkDodRuntimeChecked = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdMarkDodRuntimeChecked(...a);
const cmdMarkTestsNotMeasured = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdMarkTestsNotMeasured(...a);
const cmdMarkTestsNotScoped = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdMarkTestsNotScoped(...a);
const cmdNoteRedTest = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdNoteRedTest(...a);
const cmdRunCheck = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdRunCheck(...a);
const cmdSetAutonomous = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdSetAutonomous(...a);
const cmdSetCheck = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdSetCheck(...a);
const cmdSetFlag = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdSetFlag(...a);
const cmdStartWarning = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdStartWarning(...a);
const cmdTestsFailed = (...a) => parte(() => require('./lib/marker-checks.js'), 'marker-checks.js').cmdTestsFailed(...a);
const cmdCompleteStep = (...a) => parte(() => require('./lib/marker-complete-step.js'), 'marker-complete-step.js').cmdCompleteStep(...a);
const cmdAppendFile = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdAppendFile(...a);
const cmdClear = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdClear(...a);
const cmdGet = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdGet(...a);
const cmdIsActive = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdIsActive(...a);
const cmdPr = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdPr(...a);
const cmdSet = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdSet(...a);
const cmdTouch = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdTouch(...a);
const cmdWaitingOnMain = (...a) => parte(() => require('./lib/marker-lifecycle.js'), 'marker-lifecycle.js').cmdWaitingOnMain(...a);
const cmdAdoptSession = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdAdoptSession(...a);
const cmdClearSession = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdClearSession(...a);
const cmdConditions = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdConditions(...a);
const cmdDoing = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdDoing(...a);
const cmdFindByStory = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdFindByStory(...a);
const cmdListAll = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdListAll(...a);
const cmdPark = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdPark(...a);
const cmdSalidaPerdida = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdSalidaPerdida(...a);
const cmdUnpark = (...a) => parte(() => require('./lib/marker-sessions.js'), 'marker-sessions.js').cmdUnpark(...a);
const cmdApprovePending = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdApprovePending(...a);
const cmdApproveSave = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdApproveSave(...a);
const cmdCompareWaiver = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdCompareWaiver(...a);
const cmdReleaseWriteAfter = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdReleaseWriteAfter(...a);
const cmdDeclarePending = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdDeclarePending(...a);
const cmdDesignateRelay = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdDesignateRelay(...a);
const cmdMarkTested = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdMarkTested(...a);
const cmdOwnerAway = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdOwnerAway(...a);
const cmdPlanReview = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdPlanReview(...a);
const cmdReviewAnswer = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdReviewAnswer(...a);
const cmdReviewAsk = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdReviewAsk(...a);
const cmdRuntimeWaiver = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdRuntimeWaiver(...a);
const cmdCheckRuntimeWaiver = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdCheckRuntimeWaiver(...a);
const cmdSaveCheck = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdSaveCheck(...a);
const cmdSignAtddSkip = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdSignAtddSkip(...a);
const cmdSignAdversarialSkip = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdSignAdversarialSkip(...a);
const cmdSignFile = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdSignFile(...a);
const cmdWaiveCritical = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdWaiveCritical(...a);
const cmdWithdrawRelay = (...a) => parte(() => require('./lib/marker-signatures.js'), 'marker-signatures.js').cmdWithdrawRelay(...a);
const cmdApproveMockup = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdApproveMockup(...a);
const cmdMarkModelsWarned = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdMarkModelsWarned(...a);
const cmdResumeAutonomy = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdResumeAutonomy(...a);
const cmdRethink = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdRethink(...a);
const cmdSetBatch = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdSetBatch(...a);
const cmdSetModels = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdSetModels(...a);
const cmdSetSize = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdSetSize(...a);
const cmdSnapshotIter = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdSnapshotIter(...a);
const cmdStartStep = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdStartStep(...a);
const cmdStorySkillBypass = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdStorySkillBypass(...a);
const cmdUpdatePipelineStatus = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdUpdatePipelineStatus(...a);
const cmdUpdateStoryStatus = (...a) => parte(() => require('./lib/marker-steps.js'), 'marker-steps.js').cmdUpdateStoryStatus(...a);

switch (cmd) {
  case 'set':
    cmdSet(arg1);
    break;
  case 'get':
    cmdGet(arg1);
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
    cmdClear(process.argv.slice(3));
    break;
  case 'pr':
    cmdPr(arg1, process.argv.slice(4));
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
    cmdClearSession(arg1, process.argv.slice(4));
    break;
  case 'restore':
    if (!arg1) { console.error('marker.js restore: sessionId requerido'); process.exit(2); }
    cmdSalidaPerdida('restore', String(arg1).replace(/[/\\]/g, '_'));
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
  case 'resume-autonomy':
    cmdResumeAutonomy(process.argv.slice(3));
    break;
  case 'set-batch':
    cmdSetBatch(arg1);
    break;
  case 'set-check':
    // la bandera puede ir en cualquier lugar después del estado (`--for-session <D> --force-manual`)
    cmdSetCheck(arg1, arg2, ['--force-manual', '--manual'].find((f) => process.argv.slice(5).includes(f)) || process.argv[5]);
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
    cmdSetFlag(arg1, arg2, process.argv.slice(5));
    break;
  case 'start-warning':
    cmdStartWarning(arg1, arg2);
    break;
  case 'close-as-debt':
    cmdCloseAsDebt(process.argv.slice(3));
    break;
  case 'lift-debt':
    cmdLiftDebt(process.argv.slice(3));
    break;
  case 'expect-red':
    cmdExpectRed(process.argv.slice(3));
    break;
  case 'note-red-test':
    cmdNoteRedTest(process.argv.slice(3));
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
    // sin la story, la primera palabra ya es una bandera (`runtime-waiver --terminal`): la story sale del marcador
    if (arg1 && arg1.startsWith('--')) cmdRuntimeWaiver(null, process.argv.slice(3));
    else cmdRuntimeWaiver(arg1, process.argv.slice(4));
    break;
  case 'check-runtime-waiver':
    // sólo mira: si la firma de runtime-waiver pasaría, sin firmar (fila 233)
    if (arg1 && arg1.startsWith('--')) cmdCheckRuntimeWaiver(null, process.argv.slice(3));
    else cmdCheckRuntimeWaiver(arg1, process.argv.slice(4));
    break;
  case 'waive-critical':
    cmdWaiveCritical(process.argv.slice(3));
    break;
  case 'compare-waiver':
    cmdCompareWaiver(process.argv.slice(3));
    break;
  case 'release-write-after':
    cmdReleaseWriteAfter(process.argv.slice(3));
    break;
  case 'sign-adversarial-skip':
    cmdSignAdversarialSkip(process.argv.slice(3));
    break;
  case 'declare-pending':
    cmdDeclarePending(process.argv.slice(3));
    break;
  case 'approve-pending':
    cmdApprovePending(process.argv.slice(3));
    break;
  case 'sign-atdd-skip':
    cmdSignAtddSkip(process.argv.slice(3));
    break;
  case 'approve-save':
    cmdApproveSave(process.argv.slice(3));
    break;
  case 'plan-review':
    cmdPlanReview(process.argv.slice(3));
    break;
  case 'review-ask':
    cmdReviewAsk(process.argv.slice(3));
    break;
  case 'review-answer':
    cmdReviewAnswer(process.argv.slice(3));
    break;
  case 'owner-away':
    cmdOwnerAway(process.argv.slice(3));
    break;
  case 'save-check':
    cmdSaveCheck(process.argv.slice(3));
    break;
  case 'designate-relay':
    cmdDesignateRelay(process.argv.slice(3));
    break;
  case 'withdraw-relay':
    cmdWithdrawRelay(process.argv.slice(3));
    break;
  case 'mark-tested':
    cmdMarkTested(process.argv.slice(3));
    break;
  case 'mark-adversarial-launched':
    cmdMarkAdversarialLaunched(arg1, arg2);
    break;
  case 'freeze-adversarial':
    cmdFreezeAdversarial();
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
  case 'conditions':
    cmdConditions(process.argv.slice(3));
    break;
  case 'waiting-on-main':
    cmdWaitingOnMain(process.argv.slice(3));
    break;
  case 'story-skill-bypass':
    cmdStorySkillBypass();
    break;
  case 'sign-file':
    cmdSignFile(arg1, arg2);
    break;
  case 'approve-mockup':
    cmdApproveMockup(process.argv.slice(3));
    break;
  case 'rethink':
    cmdRethink(process.argv.slice(3));
    break;
  case 'park':
    cmdPark(arg1, process.argv.slice(4));
    break;
  case 'unpark':
    cmdUnpark(arg1);
    break;
  default:
    console.error(`marker.js: comando desconocido '${cmd}'`);
    console.error(
      'Usage: marker.js <set|get|touch|complete-step|append-file|clear|pr|is-active|' +
        'list-all|find-by-story|clear-session|park|unpark|adopt-session|update-story-status|' +
        'mark-dod-runtime-checked|set-autonomous|set-check|run-check|set-flag|set-size|snapshot-iter|' +
        'mark-adversarial-launched|mark-adversarial-result|mark-adversarial-skipped|mark-adversarial-gate|promote-probe|adhoc|story-skill-bypass|' +
        'approve-mockup|rethink|lift-debt> [arg] [arg2]',
    );
    process.exit(2);
}
