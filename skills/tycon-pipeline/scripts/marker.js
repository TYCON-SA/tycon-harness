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

// lo que comparten los módulos: el estado, las rutas de este despachador (las mismas de siempre, también por un
// enlace) y lo que el despacho usa
const shared = require('./lib/marker-shared.js');
shared.estado.SCRIPTS_DIR = __dirname;
shared.estado.MARKER_JS = __filename;
const { paraOtraSesion } = shared;

// cada grupo de subcomandos vive en su módulo de lib/, con la ruta escrita entera (el freno de guiones y
// control-size.js siguen sólo una ruta literal). Se carga cuando un subcomando lo necesita: si falta o no carga,
// lo dice en una línea y sale 2, nunca sigue como si el subcomando no existiera
const CARGAS = {
  'marker-lifecycle.js': () => require('./lib/marker-lifecycle.js'),
  'marker-sessions.js': () => require('./lib/marker-sessions.js'),
  'marker-complete-step.js': () => require('./lib/marker-complete-step.js'),
  'marker-steps.js': () => require('./lib/marker-steps.js'),
  'marker-checks.js': () => require('./lib/marker-checks.js'),
  'marker-adversarial.js': () => require('./lib/marker-adversarial.js'),
  'marker-signatures.js': () => require('./lib/marker-signatures.js'),
  'marker-adhoc.js': () => require('./lib/marker-adhoc.js'),
};
function cargar(modulo) {
  try { return CARGAS[modulo](); } catch (e) {
    console.error(`marker.js: falta el módulo lib/${modulo} o no carga (${String((e && e.message) || e).split('\n')[0]})`);
    process.exit(2);
  }
}


// Las opciones viejas siguen andando hasta el retiro (también desde una sesión abierta con las
// instrucciones de antes en la memoria)
require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/marker.js');
const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
paraOtraSesion(process.argv);

switch (cmd) {
  case 'set':
    cargar('marker-lifecycle.js').cmdSet(arg1);
    break;
  case 'get':
    cargar('marker-lifecycle.js').cmdGet();
    break;
  case 'touch':
    cargar('marker-lifecycle.js').cmdTouch();
    break;
  case 'complete-step':
    cargar('marker-complete-step.js').cmdCompleteStep(arg1, process.argv.slice(4));
    break;
  case 'start-step':
    cargar('marker-steps.js').cmdStartStep(arg1);
    break;
  case 'append-file':
    cargar('marker-lifecycle.js').cmdAppendFile(arg1);
    break;
  case 'clear':
    cargar('marker-lifecycle.js').cmdClear(process.argv.slice(3));
    break;
  case 'is-active':
    cargar('marker-lifecycle.js').cmdIsActive();
    break;
  case 'list-all':
    cargar('marker-sessions.js').cmdListAll();
    break;
  case 'find-by-story':
    cargar('marker-sessions.js').cmdFindByStory(arg1);
    break;
  case 'clear-session':
    cargar('marker-sessions.js').cmdClearSession(arg1, process.argv.slice(4));
    break;
  case 'restore':
    if (!arg1) { console.error('marker.js restore: sessionId requerido'); process.exit(2); }
    cargar('marker-sessions.js').cmdSalidaPerdida('restore', String(arg1).replace(/[/\\]/g, '_'));
    break;
  case 'adopt-session':
    cargar('marker-sessions.js').cmdAdoptSession(arg1);
    break;
  case 'update-story-status':
    cargar('marker-steps.js').cmdUpdateStoryStatus(arg1, arg2);
    break;
  case 'update-pipeline-status':
    cargar('marker-steps.js').cmdUpdatePipelineStatus(arg1, arg2, process.argv[5]);
    break;
  case 'mark-dod-runtime-checked':
    cargar('marker-checks.js').cmdMarkDodRuntimeChecked(arg1);
    break;
  case 'set-autonomous':
    cargar('marker-checks.js').cmdSetAutonomous(arg1);
    break;
  case 'set-batch':
    cargar('marker-steps.js').cmdSetBatch(arg1);
    break;
  case 'set-check':
    // la bandera puede ir en cualquier lugar después del estado (`--for-session <D> --force-manual`)
    cargar('marker-checks.js').cmdSetCheck(arg1, arg2, ['--force-manual', '--manual'].find((f) => process.argv.slice(5).includes(f)) || process.argv[5]);
    break;
  case 'run-check':
    cargar('marker-checks.js').cmdRunCheck(process.argv.slice(3));
    break;
  case 'mark-tests-not-scoped':
    cargar('marker-checks.js').cmdMarkTestsNotScoped(arg1);
    break;
  case 'tests-failed':
    cargar('marker-checks.js').cmdTestsFailed(process.argv.slice(3));
    break;
  case 'mark-tests-not-measured':
    cargar('marker-checks.js').cmdMarkTestsNotMeasured(arg1);
    break;
  case 'set-flag':
    cargar('marker-checks.js').cmdSetFlag(arg1, arg2, process.argv.slice(5));
    break;
  case 'start-warning':
    cargar('marker-checks.js').cmdStartWarning(arg1, arg2);
    break;
  case 'close-as-debt':
    cargar('marker-checks.js').cmdCloseAsDebt(process.argv.slice(3));
    break;
  case 'lift-debt':
    cargar('marker-checks.js').cmdLiftDebt(process.argv.slice(3));
    break;
  case 'expect-red':
    cargar('marker-checks.js').cmdExpectRed(process.argv.slice(3));
    break;
  case 'note-red-test':
    cargar('marker-checks.js').cmdNoteRedTest(process.argv.slice(3));
    break;
  case 'set-size':
    cargar('marker-steps.js').cmdSetSize(process.argv.slice(3));
    break;
  case 'set-models':
    cargar('marker-steps.js').cmdSetModels(process.argv.slice(3));
    break;
  case 'mark-models-warned':
    cargar('marker-steps.js').cmdMarkModelsWarned(process.argv.slice(3));
    break;
  case 'snapshot-iter':
    cargar('marker-steps.js').cmdSnapshotIter(arg1, process.argv.slice(4));
    break;
  case 'runtime-waiver':
    // sin la story, la primera palabra ya es una bandera (`runtime-waiver --terminal`): la story sale del marcador
    if (arg1 && arg1.startsWith('--')) cargar('marker-signatures.js').cmdRuntimeWaiver(null, process.argv.slice(3));
    else cargar('marker-signatures.js').cmdRuntimeWaiver(arg1, process.argv.slice(4));
    break;
  case 'waive-critical':
    cargar('marker-signatures.js').cmdWaiveCritical(process.argv.slice(3));
    break;
  case 'compare-waiver':
    cargar('marker-signatures.js').cmdCompareWaiver(process.argv.slice(3));
    break;
  case 'sign-adversarial-skip':
    cargar('marker-signatures.js').cmdSignAdversarialSkip(process.argv.slice(3));
    break;
  case 'approve-pending':
    cargar('marker-signatures.js').cmdApprovePending(process.argv.slice(3));
    break;
  case 'approve-save':
    cargar('marker-signatures.js').cmdApproveSave(process.argv.slice(3));
    break;
  case 'plan-review':
    cargar('marker-signatures.js').cmdPlanReview(process.argv.slice(3));
    break;
  case 'review-ask':
    cargar('marker-signatures.js').cmdReviewAsk(process.argv.slice(3));
    break;
  case 'review-answer':
    cargar('marker-signatures.js').cmdReviewAnswer(process.argv.slice(3));
    break;
  case 'owner-away':
    cargar('marker-signatures.js').cmdOwnerAway(process.argv.slice(3));
    break;
  case 'save-check':
    cargar('marker-signatures.js').cmdSaveCheck(process.argv.slice(3));
    break;
  case 'designate-relay':
    cargar('marker-signatures.js').cmdDesignateRelay(process.argv.slice(3));
    break;
  case 'withdraw-relay':
    cargar('marker-signatures.js').cmdWithdrawRelay();
    break;
  case 'mark-tested':
    cargar('marker-signatures.js').cmdMarkTested(process.argv.slice(3));
    break;
  case 'mark-adversarial-launched':
    cargar('marker-adversarial.js').cmdMarkAdversarialLaunched(arg1, arg2);
    break;
  case 'freeze-adversarial':
    cargar('marker-adversarial.js').cmdFreezeAdversarial();
    break;
  case 'mark-adversarial-result':
    cargar('marker-adversarial.js').cmdMarkAdversarialResult(arg1);
    break;
  case 'mark-adversarial-skipped':
    cargar('marker-adversarial.js').cmdMarkAdversarialSkipped(process.argv.slice(3));
    break;
  case 'mark-adversarial-gate':
    cargar('marker-adversarial.js').cmdMarkAdversarialGate(arg1);
    break;
  case 'promote-probe':
    cargar('marker-adversarial.js').cmdPromoteProbe(arg1);
    break;
  case 'adhoc':
    cargar('marker-adhoc.js').cmdAdhoc(arg1, arg2);
    break;
  case 'doing':
    cargar('marker-sessions.js').cmdDoing(arg1, arg2);
    break;
  case 'story-skill-bypass':
    cargar('marker-steps.js').cmdStorySkillBypass();
    break;
  case 'sign-file':
    cargar('marker-signatures.js').cmdSignFile(arg1, arg2);
    break;
  case 'approve-mockup':
    cargar('marker-steps.js').cmdApproveMockup(process.argv.slice(3));
    break;
  case 'rethink':
    cargar('marker-steps.js').cmdRethink(process.argv.slice(3));
    break;
  case 'park':
    cargar('marker-sessions.js').cmdPark(arg1, process.argv.slice(4));
    break;
  case 'unpark':
    cargar('marker-sessions.js').cmdUnpark(arg1);
    break;
  default:
    console.error(`marker.js: comando desconocido '${cmd}'`);
    console.error(
      'Usage: marker.js <set|get|touch|complete-step|append-file|clear|is-active|' +
        'list-all|find-by-story|clear-session|park|unpark|adopt-session|update-story-status|' +
        'mark-dod-runtime-checked|set-autonomous|set-check|run-check|set-flag|set-size|snapshot-iter|' +
        'mark-adversarial-launched|mark-adversarial-result|mark-adversarial-skipped|mark-adversarial-gate|promote-probe|adhoc|story-skill-bypass|' +
        'approve-mockup|rethink|lift-debt> [arg] [arg2]',
    );
    process.exit(2);
}
