/**
 * marker-lifecycle.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: crear, leer, anotar y cerrar el marcador de la sesión.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  HARNESS_INVALID_ARGS, HARNESS_OLD_OPTION, LEGACY_MARKER_PATH, OLD_FLAGS,
  SCRIPTS_DIR, STATE_DIR, STEPS_LIB, anotarArranque, anotarOtraVuelta,
  appendLog, at, avisarOficina, cerrarEjecucion, doingFileOf, estado,
  frenarSiIlegible, frenarSiPerdida, fs, idsDeEspera, markerFilePath, nn,
  nowIso, opcion, os, path, readMarker, readOwnMarkerRaw, reposParaComparar,
  resolveStoryPath, sinFirmaNoSeEscribe, syncSessionState, writeMarker,
} = require('./marker-shared.js');

function clearMarker() {
  sinFirmaNoSeEscribe();
  const own = markerFilePath(estado.SID);
  if (fs.existsSync(own)) {
    try { fs.unlinkSync(own); } catch (_e) { /* ignore */ }
  }
  // Limpiar también de legacy si la entry de esta sesión vivía ahí.
  if (fs.existsSync(LEGACY_MARKER_PATH)) {
    try {
      const obj = JSON.parse(fs.readFileSync(LEGACY_MARKER_PATH, 'utf8'));
      if (obj && !obj.storyId && obj[estado.SID]) {
        delete obj[estado.SID];
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
  avisarOficina();
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
  // `set` (y `set --replace`) pisa el marcador: si el que hay no se lee, no se puede anotar lo que deja
  frenarSiIlegible(markerFilePath(estado.SID), estado.SID, 'set');
  let existing = readMarker();
  // un marcador escrito a mano sobre una ejecución perdida la daría por sana
  frenarSiPerdida(estado.SID, 'set', (existing && existing.repoPath) || payload.repoPath);
  const existingBefore = existing;
  // La detención del modo autónomo y su resolución las escriben el control de cierre y `resume-autonomy`: un `set` no
  // las toca, en ninguna historia.
  for (const k of ['needs_human', 'escalation', 'escalation_reason']) {
    if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
    delete payload[k];
    console.error(`marker.js set: «${k}» no se cambia con set (lo escriben el control de cierre y resume-autonomy): se descartó.`);
    appendLog('bypass.log', { kind: 'MARKER_SET_FIELD_DISCARDED', field: k, storyId: payload.storyId });
  }
  // Una ejecución detenida espera la decisión del dueño: cambiarla de historia no es una salida (la cierra `clear` con
  // su firma, o la retoma `resume-autonomy`). Renumerarla conserva la detención.
  if (existing && existing.needs_human === true && payload.storyId !== existing.storyId && !process.argv.includes('--renumber')) {
    console.error('marker.js set: Esta ejecución se detuvo y espera la decisión de una persona: marker.js resume-autonomy (o clear, con su firma). No se reemplazó nada.');
    process.exit(1);
  }
  // Las banderas de hechos externos tampoco se escriben con set: las pone el arnés cuando hizo el trabajo. Un
  // `get | … | set` que las trae como estaban no cambia nada y pasa.
  {
    const ext = require('./external-flags.js');
    for (const k of [...ext.EXTERNAL_FLAGS, ...Object.keys(OLD_FLAGS)]) {
      if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
      const tenia = existing && existing.storyId === payload.storyId ? existing[k] : undefined;
      if (payload[k] === tenia) continue;
      delete payload[k];
      console.error(`marker.js set: «${k}» no se escribe con set (la pone el arnés: ${ext.HARNESS_COMMAND[nn(OLD_FLAGS[k], k)]}): se descartó.`);
      appendLog('bypass.log', { kind: 'MARKER_SET_EXTERNAL_FLAG_DISCARDED', flag: k, storyId: payload.storyId });
    }
  }
  // La tanda de la ejecución achica la matriz de «Preparar el commit»: la escribe sólo `set-batch`, que la valida
  // contra la historia y no la cambia. Un `get | … | set` que la trae como estaba pasa.
  for (const k of ['batch', 'batchSetAt']) {
    if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
    const tenia = existing && existing.storyId === payload.storyId ? existing[k] : undefined;
    if (tenia !== undefined && payload[k] === tenia) continue;
    console.error(`marker.js set: «${k}» no se escribe con set: la tanda se anota con marker.js set-batch <tanda>, una vez. No escribí nada.`);
    process.exit(2);
  }
  // 🔴 Anti-leak cross-story: el spread de abajo preserva
  // campos ante un `set` de la MISMA story — pero si esta sesión arranca una story NUEVA sobre un
  // marker viejo sin clear (pipeline cancelado, crash, "listo" antes de «Preparar el commit»), la story B
  // heredaría el ciclo de vida de la A: `deepReviewDone=true` heredado → computeNext saltea el pase adversarial
  // de B EN SILENCIO; `checks.build=green` y `dodRuntimeChecked` heredados → gates mintiendo.
  // Por eso, al cambiar de storyId, los campos de CICLO DE VIDA DE
  // CORRIDA se resetean (la identidad de sesión y el startedAt se conservan).
  // `--renumber`: la MISMA corrida con otro número (un choque de número obliga a renumerar la story). Cambia el
  // `storyId` (y el `storyPath` si viene) y conserva el ciclo de vida entero: pasos, controles, pase adversarial,
  // ediciones. Deja la copia del marcador anterior y lo anota en gates.log, como el reemplazo.
  if (existing && payload.storyId && payload.storyId !== existing.storyId && process.argv.includes('--renumber')) {
    const copia = path.join(STATE_DIR, 'replaced', `${estado.SID}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.writeFileSync(copia, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    appendLog('gates.log', { name: 'marker-renumber', from: existing.storyId, to: payload.storyId, copy: copia });
    console.error(`marker.js set: la corrida de la story ${existing.storyId} sigue como ${payload.storyId}, con sus pasos, controles y ediciones. La copia del marcador anterior quedó en ${copia}`);
    existing = { ...existing, storyId: payload.storyId };
  }
  if (existing && payload.storyId !== existing.storyId) {
    // Una ejecución que ya avanzó no se reemplaza sin pedirlo: el reinicio borraría sus pasos, sus controles y su
    // pase adversarial sin que nadie lo vea. Con `--replace` se reemplaza; siempre queda la copia del anterior.
    const hechos = Array.isArray(existing.stepsCompleted) ? existing.stepsCompleted.length : 0;
    if (hechos > 0 && !process.argv.includes('--replace')) {
      console.error(`marker.js set: esta sesión tiene la ejecución de la story ${existing.storyId} con ${hechos} paso(s) hecho(s), y el pedido es de la ${payload.storyId}: no la reemplazo.`);
      console.error('  Si es la MISMA story con otro número (renumerada por un choque): el mismo set con --renumber conserva la corrida (pasos, controles, ediciones).');
      console.error('  Si la de antes terminó o se abandona: marker.js clear y volvé a pedirlo, o el mismo set con --replace (deja una copia del marcador anterior).');
      process.exit(3);
    }
    const copia = path.join(STATE_DIR, 'replaced', `${estado.SID}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.writeFileSync(copia, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    appendLog('gates.log', { name: 'marker-replace', from: existing.storyId, to: payload.storyId, stepsCompleted: hechos, copy: copia });
    console.error(`marker.js set: la copia del marcador de la ${existing.storyId} quedó en ${copia}`);
    // Otra historia sobre una ejecución que no terminó: la anterior queda dicha como abortada. Sin esto, el reset de
    // abajo la lavaría y un `clear` después la archivaría como completa.
    // El cierre se anota siempre, terminada o no: la apertura de la anterior queda cerrada y su copia, borrada.
    try {
      const rc = require('./run-close.js');
      // una con `cierre` escrito (la deuda) ya dijo cómo terminó
      const abierta = !existing.cierre && rc.abierta(rc.estado(existing));
      const c = rc.cierreDe(existing, { sid: estado.SID });
      cerrarEjecucion(estado.SID, existing, { registrar: false, estado: c.estado, via: c.via || null,
        motivo: abierta ? `reemplazada por la historia ${payload.storyId} sin cerrarla: ${c.motivo || ''}` : `reemplazada por la historia ${payload.storyId}` });
      if (abierta) console.error(`marker.js set: la ejecución de ${existing.storyId} no había terminado (${c.motivo}): queda anotada como ${c.estado}.`);
    } catch (e) {
      cerrarEjecucion(estado.SID, existing, { registrar: false, estado: 'abortada', motivo: `reemplazada por la historia ${payload.storyId}; no pude calcular su estado (${e.message})` });
    }
    const {
      adversarial, deepReviewDone, workSignalStarted, clockiStarted, adoMarkedActive, atddBypass, atddBypassReason,
      checks, checksProvenance, dodRuntimeChecked, iterations, fileEvents, filesTouched, filesTouchedAt,
      // la otra vuelta de revisores es de los cambios de la corrida: heredada, la story nueva pediría revisar lo de la vieja
      otraVuelta,
      stepsCompleted, stepsPending, startedAt, evidenceDir, baseSha,
      // la carpeta de la corrida es de la corrida: heredada, la story nueva escribiría su constancia en la de la vieja;
      // y la otra sesión en paralelo es de la story
      runDir, parallelWith,
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
      // (76) por suites que sólo rompió la anterior. Lo guardado de una completa verde, igual: la nueva compararía su
      // carpeta con una completa de otra historia. La nota de la última corrida, igual: la primera de la story nueva
      // saldría «entera», con el motivo de la vieja. Lo guardado de una completa roja, igual: la nueva repetiría primero
      // las rojas de otra historia
      testsFailed, testsGreenFull, testsRedFull, testsSavedNote,
      // la tanda es de la historia: heredada, la matriz de la nueva mediría una tanda que no es suya
      batch, batchSetAt,
      // el pedido es de la corrida: heredado, el cierre de la nueva anunciaría un pedido que no es suyo
      pr,
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
  // Ni marcar hechos los que no lo estaban: un paso se cierra con `complete-step`, que corre sus frenos. Un `set` de la
  // misma historia con «Preparar el commit» en `stepsCompleted` se saltearía el de código sin revisar.
  // Listas sin esquema legible (números y nombres mezclados) no se tocan: las rechaza entera la validación de más abajo.
  const esquemaDelPedido = () => STEPS_LIB.schemeOf({ stepScheme: payload.stepScheme !== undefined ? payload.stepScheme : existing.stepScheme,
    stepsCompleted: payload.stepsCompleted, stepsPending: Array.isArray(payload.stepsPending) ? payload.stepsPending : (existing.stepsPending || []) });
  if (existing && payload.storyId === existing.storyId && Array.isArray(payload.stepsCompleted) && esquemaDelPedido() !== null) {
    const nuevos = payload.stepsCompleted.filter((x) => !(existing.stepsCompleted || []).map(String).includes(String(x)) && !STEPS_LIB.isDone(existing, String(x)));
    if (nuevos.length) {
      payload.stepsCompleted = payload.stepsCompleted.filter((x) => !nuevos.includes(x));
      console.error(`marker.js set: ${nuevos.join(', ')} no se marca(n) hecho(s) con set (se cierra con marker.js complete-step <paso>): se descartó.`);
      appendLog('bypass.log', { kind: 'MARKER_SET_STEPS_DISCARDED', steps: nuevos.map(String), storyId: payload.storyId });
    }
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
  // El repo que queda guardado. Uno relativo o que falta, con la carpeta absoluta, sale de la carpeta (lib/run-dir.js);
  // si no, es el argumento de este mismo proceso y se resuelve acá, al entrar, como el --repo de `start`.
  const repoGuardado = (() => {
    const pedido = payload.repoPath;
    if (!(pedido && path.isAbsolute(pedido))) {
      const deLaCarpeta = require('./run-dir.js').rutasDeLaCorrida({ runDir: payload.runDir }).repoPath;
      if (deLaCarpeta && path.isAbsolute(deLaCarpeta)) return deLaCarpeta;
    }
    return path.resolve(pedido || at(existing, 'repoPath') || process.cwd());
  })();
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
    repoPath: repoGuardado,
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
    // La carpeta de la corrida (`.advisors/pipeline-runs/<clave>-<sello>`), que crea `pipeline.js start`: la piden todos
    // los que escriben o leen la constancia de esta corrida (lib/run-dir.js). Como la base, gana la EXISTENTE: retomar
    // la misma story no abre otra carpeta. Es estado de corrida: el bloque de arriba la descarta al cambiar de story.
    // La existente gana mientras siga en disco y sea del mismo repo que la que trae el pedido; si ya no está (o es de
    // otro repo), la que abrió `start` la reemplaza: si no, la carpeta nueva quedaría sin marcador que la nombre.
    runDir: (() => {
      // las dos, absolutas ANTES de mirar el disco: la vieja contra el repo del marcador existente (ya la trae así
      // `readMarker`), la nueva contra el que queda guardado; un `set` desde otra carpeta no pierde la vieja
      const rd = require('./run-dir.js');
      const ubicada = rd.rutasDeLaCorrida({ repoPath: at(existing, 'repoPath'), runDir: at(existing, 'runDir') }).runDir;
      // una vieja que no se pudo ubicar no se toma (no se busca en la carpeta del proceso): gana la nueva
      const vieja = typeof ubicada === 'string' && path.isAbsolute(ubicada) ? ubicada : null;
      const nueva = rd.rutasDeLaCorrida({ repoPath: repoGuardado, runDir: payload.runDir }).runDir;
      // por la ruta real: un enlace (/var y /private/var en macOS) no hace de la misma carpeta una de otro repo
      const real = (p) => { try { return fs.realpathSync(path.dirname(path.resolve(p))); } catch (_e) { return path.dirname(path.resolve(p)); } };
      const sigue = !!vieja && fs.existsSync(vieja) && (!nueva || real(vieja) === real(nueva));
      return sigue ? vieja : (nueva || vieja || null);
    })(),
    sprint: nn(payload.sprint, nn(at(existing, 'sprint'), null)),
    sessionId: estado.SID,
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
    // la otra sesión de la misma story que trabaja en otra copia y otra rama (PIPE-C0 por hechos, `pipeline.js start`)
    ...(payload.parallelWith !== undefined ? { parallelWith: payload.parallelWith } : {}),
    // la hora de este paso sigue valiendo si se retoma la misma story; una story nueva no la hereda
    ...(at(existing, 'horaDelPaso') ? { horaDelPaso: at(existing, 'horaDelPaso') } : {}),
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
  // un set que retoma con otros pasos o reemplaza la story cambia lo que el archivo de estado dice
  syncSessionState(estado.SID);
  process.stdout.write(JSON.stringify(marker, null, 2));
}

function cmdGet(opcion) {
  const marker = readMarker();
  process.stdout.write(JSON.stringify(nn(marker, {}), null, 2));
  // `{}` dice lo mismo sin corrida que con un marcador roto: con --strict, el roto sale 3 para quien tiene que distinguirlos
  if (opcion === '--strict' && !marker) {
    let crudo = null;
    try { crudo = fs.readFileSync(markerFilePath(estado.SID), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; }
    let m = null;
    try { m = crudo === null ? null : JSON.parse(crudo); } catch (_e) { m = null; }
    if (m && typeof m === 'object' && !Array.isArray(m) && m.storyId) return;
    console.error(`marker.js get: el marcador de la sesión ${estado.SID} no se puede leer o no dice de qué story es`);
    process.exitCode = 3;
  }
}

function cmdTouch() {
  const marker = readMarker();
  if (!marker) process.exit(0);
  marker.lastTouch = nowIso();
  writeMarker(marker);
}

/**
 * Las esperas a main de la corrida: una entrada por repo (`{ repo, tree, id, sha, suites, since, run }`), el de la historia
 * o un hermano. Un marcador de antes guardaba una sola, como objeto: se lee como una lista de una.
 */
function esperasMain(marker) {
  const w = marker && marker.waitingOnMain;
  if (Array.isArray(w)) return w.filter((x) => x && typeof x === 'object');
  return w && typeof w === 'object' ? [w] : [];
}

/**
 * La corrida espera a main (`checks.tests === 'espera-main'`, con `waitingOnMain` en el marcador): el rojo del portón es de
 * main, no de la historia (lib/main-check.js). Ni verde ni rojo: el paso no cierra, y la historia no avanza hasta que
 * main pase y su portón salga verde. Nunca cuenta como verde.
 */
function frenarEsperaMain(marker, n) {
  const checks = marker.checks || {};
  if (checks.tests !== 'espera-main' && checks['tests-suite'] !== 'espera-main') return;
  const esperas = esperasMain(marker);
  const id = idsDeEspera(esperas);
  const rutas = esperas.flatMap((w) => (Array.isArray(w.suites) ? w.suites : []));
  const suites = rutas.length ? [...new Set(rutas.map((r) => path.basename(String(r))))].join(', ') : 'las suites del registro';
  appendLog('gates.log', { name: 'tests-waiting-on-main', status: 'blocked', story: marker.storyId || null, step: n, id });
  console.error(`marker.js complete-step ${n} BLOQUEADO — espera a main (${id}): la historia no avanza hasta que main pase y su portón salga verde.`);
  console.error(`  main está roto en ${suites}: no es un rojo de la historia (no toques esas pruebas ni el código por eso).`);
  console.error('  Cuando main pase (node <skills>/tycon-pipeline/scripts/lib/main-check.js status --repo <repo>), traé main y volvé a correr el portón.');
  process.exit(1);
}

/** Lo mismo para pasar la historia a `review`/`done` o una tanda a `done`: con la corrida de esta sesión esperando a main, no. */
function frenarEstadoSiEsperaMain(comando, storyPath) {
  let m = null;
  try { m = readMarker(); } catch (_e) { m = null; }
  if (!m || !m.checks || m.checks.tests !== 'espera-main') return;
  // sólo la historia de la corrida: otra historia no carga con esta espera
  const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(String(p)); } };
  if (m.storyPath && real(m.storyPath) !== real(storyPath)) return;
  const id = idsDeEspera(esperasMain(m));
  appendLog('gates.log', { name: 'tests-waiting-on-main', status: 'blocked', story: m.storyId || null, step: comando, id });
  console.error(`marker.js ${comando} BLOQUEADO — espera a main (${id}): la historia no avanza hasta que main pase y su portón salga verde.`);
  process.exit(1);
}
function anotarEsperaMainEnDoing(id, now) {
  if (!estado.SID) return;
  const file = doingFileOf(estado.SID);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_e) { prev = {}; }
  const waitingFor = `espera a main (${id})`;
  const waitingSince = prev.waitingFor === waitingFor && prev.waitingSince ? prev.waitingSince : now;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...prev, at: now, waitingFor, waitingSince, waitingKind: 'main' }));
  avisarOficina();
  appendLog('doing.log', { kind: 'DOING_SET', waitingFor, waitingKind: 'main' });
}
// Una medición nueva de las pruebas reemplaza la espera a main: la nota deja de decir que espera (si no tenía texto, se borra).
function limpiarEsperaMainEnDoing() {
  if (!estado.SID) return;
  const file = doingFileOf(estado.SID);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return; }
  if (!prev || prev.waitingKind !== 'main') return;
  const { waitingFor, waitingSince, waitingKind, ...rest } = prev;
  if (rest.text) fs.writeFileSync(file, JSON.stringify({ ...rest, at: nowIso() }));
  else { try { fs.unlinkSync(file); } catch (_e) { /* ya no estaba */ } }
  avisarOficina();
}

/**
 * `marker.js waiting-on-main`: la espera a main de la corrida (la salida 78 del portón: lo rojo está roto también en la
 * punta de main, con los mismos casos; lib/main-check.js). Sólo lo llama test-gate.sh (TYCON_TEST_GATE=1). La espera es
 * una lista con una entrada por repo (el de la historia o un hermano): `{ repo, tree, id, sha, suites, since, run }`.
 *
 * `set --repo <r> --tree <árbol> --summary <suites.json> [--run <id>] [--merge] [--single-suite]`: suma la sesión al registro de main roto
 *   del repo del árbol medido (lo crea si no hay uno abierto) y anota la entrada del repo. Con el mismo `run` (las partes
 *   de una misma corrida, que heredan TYCON_TEST_GATE_RUN) o con `--merge` (la repetición de una suite sola) suma las
 *   suites a la entrada que había; si no, la reemplaza. Saca esas suites de la lista de «repetir primero» del repo y, si
 *   no queda otra roja de ese repo en la lista, deja el check `tests` (y `tests-suite`, si está) en `espera-main`: ni verde
 *   ni rojo; con `--single-suite` (la repetición de una suite sola), sólo `tests-suite`. Anota la espera en el archivo
 *   `doing` de la sesión. La entrada de un repo que ya esperaba se reemplaza en su lugar.
 * `clear --repo <r> --measured <resumen>`: saca de la entrada del repo sólo las suites que corrieron en esta corrida (las
 *   de `suites` y `fallas` del resumen, por su entrada): una corrida que salió 0 sin correrlas (una cruzada, la de un
 *   hermano, una acotada) no las borra. Una entrada vacía se borra; sin ninguna, un check que dice `espera-main` pasa a
 *   rojo («falta volver a correr el portón»).
 * `suites --repo <r> [--list <suites.json>]`: imprime `{ id, tree, suites }`: las de la entrada del repo más las de la
 *   lista de las que fallaron de ese repo marcadas como de main; con `--list`, sólo las que están en esa lista de suites.
 *   No escribe.
 * `mark`: con alguna espera anotada, deja el check `tests` en `espera-main` (el total de partes y hermanos, que pudieron
 *   dejarlo verde). Sin ninguna, no marca, lo dice y sale 1.
 * Sin corrida abierta no anota nada y lo dice (`suites` imprime la lista vacía).
 */
function cmdWaitingOnMain(argv) {
  const accion = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const uso = 'marker.js waiting-on-main: uso — set --repo <repo> --tree <árbol medido> --summary <suites.json> [--run <id>] [--merge] | clear --repo <repo> --measured <resumen> | suites --repo <repo> [--list <suites.json>] | mark';
  const falta = { set: ['--repo', '--tree', '--summary'], clear: ['--repo', '--measured'], suites: ['--repo'], mark: [] }[accion];
  if (!falta || falta.some((k) => !opt(k))) {
    console.error(uso);
    process.exit(2);
  }
  if (process.env.TYCON_TEST_GATE !== '1') {
    console.error(`marker.js waiting-on-main ${accion}: sólo lo usa test-gate.sh (TYCON_TEST_GATE=1)`);
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    if (accion === 'suites') { process.stdout.write(`${JSON.stringify({ id: null, tree: null, suites: [] })}\n`); return; }
    process.stdout.write(`marker.js waiting-on-main ${accion}: sin corrida abierta en esta sesión, no anoto nada\n`);
    if (accion === 'mark') process.exit(1);
    return;
  }
  const real = (x) => { try { return fs.realpathSync(x); } catch (_e) { return path.resolve(x); } };
  const esperas = esperasMain(marker);
  const repo = opt('--repo') ? real(opt('--repo')) : null;
  const deEste = esperas.find((w) => w.repo === repo) || null;
  const nombres = (xs) => xs.map((r) => path.basename(String(r))).join(', ');
  const guardar = (lista, now) => {
    if (lista.length) marker.waitingOnMain = lista;
    else delete marker.waitingOnMain;
    marker.lastTouch = now;
    writeMarker(marker);
    if (lista.length) anotarEsperaMainEnDoing(idsDeEspera(lista), now);
    else limpiarEsperaMainEnDoing();
  };

  if (accion === 'suites') {
    const deMain = (Array.isArray(marker.testsFailed) ? marker.testsFailed : []).filter((x) => x && x.repo === repo && x.main && x.main.sha).map((x) => x.ruta);
    let rutas = [...new Set([...(deEste && Array.isArray(deEste.suites) ? deEste.suites : []), ...deMain])];
    if (opt('--list')) {
      let lista;
      try {
        const d = JSON.parse(fs.readFileSync(opt('--list'), 'utf8'));
        lista = new Set([...(d.diarias || []), ...(d.semanales || [])].map((e) => e && e.ruta));
      } catch (e) {
        console.error(`marker.js waiting-on-main suites: no pude leer la lista de suites ${opt('--list')} (${e.message})`);
        process.exit(1);
      }
      rutas = rutas.filter((r) => lista.has(r));
    }
    process.stdout.write(`${JSON.stringify({ id: deEste ? deEste.id || null : null, tree: deEste ? deEste.tree || null : null, suites: rutas })}\n`);
    return;
  }

  if (accion === 'mark') {
    if (!esperas.length) {
      console.error('marker.js waiting-on-main mark: sin espera anotada: no dejo el check tests en espera-main');
      process.exit(1);
    }
    const now = nowIso();
    marker.checks = { ...(marker.checks || {}), tests: 'espera-main' };
    marker.checksProvenance = { ...(marker.checksProvenance || {}), tests: 'test-gate' };
    marker.checksAt = { ...(marker.checksAt || {}), tests: now };
    guardar(esperas, now);
    appendLog('gates.log', { name: 'waiting-on-main', status: 'marked', story: marker.storyId || null, id: idsDeEspera(esperas) });
    return;
  }

  if (accion === 'clear') {
    let medidas;
    try {
      const r = JSON.parse(fs.readFileSync(opt('--measured'), 'utf8'));
      const ruta = (x) => (x && x.entrada && typeof x.entrada.ruta === 'string' ? x.entrada.ruta : null);
      medidas = new Set([...(r.suites || []), ...(r.fallas || [])].map(ruta).filter(Boolean));
    } catch (e) {
      console.error(`marker.js waiting-on-main clear: no pude leer el resumen ${opt('--measured')} (${e.message}): la espera queda como estaba`);
      process.exit(1);
    }
    if (!deEste) return;
    const quedan = (Array.isArray(deEste.suites) ? deEste.suites : []).filter((r) => !medidas.has(r));
    const sacadas = (deEste.suites || []).filter((r) => medidas.has(r));
    if (!sacadas.length) return;
    // en su lugar: el orden de las esperas no cambia por cuál se escribió último (la nota de la sesión y su hora dependen de él)
    const lista = esperas.flatMap((w) => (w !== deEste ? [w] : quedan.length ? [{ ...deEste, suites: quedan }] : []));
    const now = nowIso();
    if (!lista.length) {
      for (const k of ['tests', 'tests-suite']) {
        if ((marker.checks || {})[k] !== 'espera-main') continue;
        marker.checks[k] = 'red:falta volver a correr el portón';
        marker.checksProvenance = { ...(marker.checksProvenance || {}), [k]: 'test-gate' };
        marker.checksAt = { ...(marker.checksAt || {}), [k]: now };
      }
    }
    guardar(lista, now);
    appendLog('gates.log', { name: 'waiting-on-main', status: quedan.length ? 'partial-clear' : 'cleared', story: marker.storyId || null, repo, id: deEste.id || null, suites: sacadas });
    return;
  }

  let w = null;
  try { w = JSON.parse(fs.readFileSync(opt('--summary'), 'utf8')).waiting_on_main || null; } catch (e) {
    console.error(`marker.js waiting-on-main set: no pude leer el resumen ${opt('--summary')} (${e.message})`);
    process.exit(1);
  }
  if (!w || !Array.isArray(w.suites) || !w.suites.length) {
    console.error('marker.js waiting-on-main set: el resumen no trae waiting_on_main: la corrida no espera a main');
    process.exit(1);
  }
  let joined;
  try {
    joined = require('./main-check.js').broken.join({ tree: opt('--tree'), sha: w.sha, suites: w.suites, session: estado.SID, story: marker.storyId || null });
  } catch (e) {
    console.error(`marker.js waiting-on-main set: no pude anotar el registro de main roto (${e.message})`);
    process.exit(1);
  }
  if (joined.broke) process.stderr.write(`[test-gate] ${joined.broke}\n`);
  const rec = joined.record;
  const run = opt('--run') || process.env.TYCON_TEST_GATE_RUN || null;
  const rutas = new Set(w.suites.map((s) => s.ruta));
  // otra parte de la misma corrida, o una repetición sola, suman; una corrida nueva volvió a medir todo: reemplaza
  const suma = deEste && (argv.includes('--merge') || (run && deEste.run === run));
  if (suma) for (const r of deEste.suites || []) rutas.add(r);
  const todas = Array.isArray(marker.testsFailed) ? marker.testsFailed : [];
  marker.testsFailed = todas.filter((x) => !(x.repo === repo && rutas.has(x.ruta)));
  // las que quedan marcadas como de main tampoco son rojas de la historia
  const otrasRojas = marker.testsFailed.filter((x) => x.repo === repo && !(x.main && x.main.sha));
  const since = nowIso();
  const entrada = { repo, tree: real(opt('--tree')), id: rec.id, sha: w.sha, suites: [...rutas], since: suma && deEste.since ? deEste.since : since, run };
  marker.checks = marker.checks || {};
  // la repetición de una suite sola (`--single-suite`) no es la completa: deja en espera sólo su check. El de la completa
  // sigue como lo dejó ella: la lista de las que fallaron no trae sus ausentes ni lo que no midió
  const singleSuite = argv.includes('--single-suite');
  if (!otrasRojas.length || singleSuite) {
    for (const k of singleSuite ? ['tests-suite'] : ['tests', ...(marker.checks['tests-suite'] ? ['tests-suite'] : [])]) {
      marker.checks[k] = 'espera-main';
      marker.checksProvenance = { ...(marker.checksProvenance || {}), [k]: 'test-gate' };
      marker.checksAt = { ...(marker.checksAt || {}), [k]: since };
    }
  }
  guardar(deEste ? esperas.map((w) => (w === deEste ? entrada : w)) : [...esperas, entrada], since);
  appendLog('gates.log', { name: 'waiting-on-main', status: otrasRojas.length ? 'partial' : 'waiting', story: marker.storyId || null, repo, id: rec.id, sha: w.sha, suites: [...rutas] });
  process.stdout.write(`main está roto en ${nombres([...rutas])}: espero a main (${rec.id})${otrasRojas.length ? `; siguen rojas de la historia: ${nombres(otrasRojas.map((x) => x.ruta))}` : ''}\n`);
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
/**
 * Las firmas de la corrida para su volcado (`run-signatures.js` del arnés, con su saneador). Sin el arnés o sin el
 * guion, `no_medido` con el motivo: nunca tira, y nunca sube un texto sin sanear.
 */
function firmasDelVolcado(dump) {
  try {
    const { dir: guias, aviso } = require('./harness-path.js').rutaArnesHook();
    if (!guias) return { estado: 'no_medido', motivo: `${aviso}: las firmas no se subieron` };
    return require(path.join(guias, 'scripts', 'lib', 'run-signatures.js')).deVolcado(dump);
  } catch (e) {
    return { estado: 'no_medido', motivo: `no pude cargar run-signatures.js del arnés (${e.code || 'error'}): las firmas no se subieron` };
  }
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
  // `code`: si pide otra vuelta de revisores, como en on-edit; si la regla falla, pide (ante la duda, se revisa).
  marker.fileEvents = marker.fileEvents || [];
  let code;
  try { code = require('./reloop-code.js').pideOtraVuelta(absPath, { storyPath: marker.storyPath }); } catch (_) { code = true; }
  marker.fileEvents.push({ path: absPath, ts: nowIso(), code });
  if (marker.fileEvents.length > 500) {
    marker.fileEvents = marker.fileEvents.slice(-500);
  }
  anotarOtraVuelta(marker);
  marker.lastTouch = nowIso();
  writeMarker(marker);
}

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

  if (require('./legacy-names.js').readEnv('TYCON_NO_THREAD_RESCUE', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '1') {
    return anotar('el rescate del hilo está apagado en esta máquina (TYCON_NO_THREAD_RESCUE=1)');
  }

  const arnes = require('./harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
  if (!arnes.dir) return anotar(`${arnes.aviso} — la corrida se archivó igual`);
  const script = path.join(arnes.dir, 'scripts', 'metrics', 'tokens-digest.js');
  if (!fs.existsSync(script)) {
    return anotar(`no encontré tokens-digest.js en ${script} — el arnés de esta máquina puede estar atrasado; la corrida se archivó igual`);
  }

  try {
    const { execFileSync } = require('child_process');
    const resto = process.env.TYCON_PROJECTS_DIR ? ['--projects-dir', process.env.TYCON_PROJECTS_DIR] : [];
    const llamar = (opcion) => execFileSync(process.execPath, [script, opcion, archivo, ...resto], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
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

  const { readEnv } = require('./legacy-names.js');
  if (readEnv('TYCON_NO_RUN_CHANGE', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '1') {
    return noMedido('el cambio de git de la corrida está apagado en esta máquina (TYCON_NO_RUN_CHANGE=1)');
  }
  const arnes = require('./harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
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
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: tope, killSignal: 'SIGKILL' });
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
      const git = (args) => spawnSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
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

// ── Los renglones de la corrida (lib/run-lines.js): lo que ve la persona al cerrar un paso y al cerrar la corrida ──
// Nunca frenan: un error dice una línea y el comando sigue igual.

function tituloDeLaHistoria(marker) {
  try {
    const sp = resolveStoryPath(marker.storyPath, marker) || marker.storyPath;
    const t = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fs.readFileSync(sp, 'utf8'));
    return t ? t[1] : null;
  } catch (_e) { return null; }
}

/** Al cerrar la corrida: sus renglones y el renglón final, y un aviso por los canales de la sesión (uno por corrida). */
function decirRenglonesDelCierre(marker, dump, runDir) {
  let RL;
  let ls = [];
  let fin = null;
  try {
    RL = require('./run-lines.js');
    ls = RL.lines({ marker, runDir: runDir || marker.runDir, stateDir: STATE_DIR });
    fin = RL.final({ dump, runDir: runDir || marker.runDir, stateDir: STATE_DIR });
    for (const l of ls) process.stderr.write(`[corrida] ${l.text}\n`);
    process.stderr.write(`[corrida] ${fin}\n`);
  } catch (e) {
    process.stderr.write(`[corrida] no pude armar los renglones de la corrida (${e.message})\n`);
    return;
  }
  try {
    const notify = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'notify.js'));
    const texto = RL.noticeText({ storyId: marker.storyId, title: tituloDeLaHistoria(marker), lines: ls, final: fin });
    const via = notify.canalesListos({ texto });
    if (via.problema) { process.stderr.write(`[corrida] el aviso del cierre no salió: ${via.problema}\n`); return; }
    if (via.fallidos && via.fallidos.length) process.stderr.write(`[corrida] el aviso del cierre no salió por ${via.fallidos.join(' · ')}\n`);
    if (!via.canales.length) return;
    const r = notify.avisar({ canales: via.canales, texto, lado: 'sesion', mail: via.mail, chat: via.chat, reintentar: false });
    const fallidos = r.resultados.filter((x) => !x.entregado).map((x) => `${x.canal}: ${x.motivo || 'no se entregó'}`);
    if (fallidos.length) process.stderr.write(`[corrida] el aviso del cierre no salió por ${fallidos.join(' · ')}\n`);
  } catch (e) { process.stderr.write(`[corrida] el aviso del cierre no salió (${e.message})\n`); }
}

// El renglón del registro de pedidos (lib/story-requests.js) para una historia dada por su ruta. Si no se puede saber su
// clave o no existe su carpeta de evidencia no escribe nada: con `estricto` sale con error; si no, lo avisa y sigue, y el
// pedido queda sólo en el marcador.
function anotarEnElRegistro({ storyFile, id, repo, numero, estricto }) {
  const noPude = (motivo) => {
    if (estricto) { console.error(`marker.js pr: ${motivo}`); process.exit(1); }
    process.stderr.write(`[marker] ${motivo}; el pedido queda sólo en la corrida\n`);
    return false;
  };
  if (!fs.existsSync(storyFile)) return noPude(`no encuentro la historia ${storyFile}: no anoté el pedido #${numero}`);
  const { key, error } = require('./evidence-key.js').keyInfoOr(storyFile, String(id));
  if (!key) return noPude(`no pude saber la clave de la historia ${id}: ${error || 'sin motivo'}`);
  const { dir } = require('./evidence-config.js').evidenceDirForStory(storyFile);
  let hayCarpeta = false;
  try { hayCarpeta = Boolean(dir) && fs.statSync(dir).isDirectory(); } catch (_e) { hayCarpeta = false; }
  if (!hayCarpeta) return noPude(`la historia ${id} no tiene carpeta de evidencia (${dir || 'sin repo'}): no anoté el pedido #${numero}`);
  const r = require('./story-requests.js').anotar({ dir, clave: key, historia: String(id), repo, pedido: numero });
  if (r.escrito) process.stderr.write(`[marker] pedido #${numero} de ${repo} anotado en ${path.basename(r.archivo)}\n`);
  return true;
}

/**
 * `marker.js pr <número> [--merged] [--story <id>] [--repo <carpeta>] [--story-path <ruta>]`: el pedido de la corrida. Con
 * marcador vivo lo guarda en él (`pr`). Sin marcador (el cierre de la historia corre después del merge, con el marcador ya
 * borrado), lo escribe en el último volcado de la historia y en su copia de la carpeta de la corrida, e imprime el renglón final.
 * El registro de pedidos: un pedido de otro repo se anota al abrirlo, para commitearlo antes del pedido de la historia. El del
 * repo de la historia no: dejaría un archivo sin commitear, y lo anota el cierre con `--story-path`, la ruta en su copia limpia.
 */
function cmdPr(numRaw, rest = []) {
  const numero = Number(numRaw);
  const opcion = (nombre) => { const k = rest.indexOf(nombre); return k >= 0 ? (rest[k + 1] || '') : null; };
  const story = opcion('--story');
  const repoArg = opcion('--repo');
  const storyPathArg = opcion('--story-path');
  if (!Number.isInteger(numero) || numero <= 0 || repoArg === '' || storyPathArg === '') {
    console.error('marker.js pr: uso — pr <número del pedido> [--merged] [--story <id>] [--repo <carpeta>] [--story-path <ruta de la historia>]');
    process.exit(2);
  }
  const merged = rest.includes('--merged');
  const SR = require('./story-requests.js');
  const repoNombre = repoArg ? SR.nombreDelRepo(repoArg) : null;
  if (repoArg && !repoNombre) {
    console.error(`marker.js pr: ${repoArg} no es un repo de git`);
    process.exit(2);
  }
  const vivo = readMarker();
  if (vivo && (!story || String(vivo.storyId) === String(story))) {
    // sin --repo no se sabe de qué repo es el número: queda sólo en la corrida
    if (repoNombre) {
      const storyFile = storyPathArg || resolveStoryPath(vivo.storyPath, vivo);
      const delaHistoria = storyFile ? SR.nombreDelRepo(path.dirname(storyFile)) : null;
      if (!storyFile) process.stderr.write(`[marker] no sé dónde está la historia ${vivo.storyId}: el pedido #${numero} queda sólo en la corrida\n`);
      else if (storyPathArg || repoNombre !== delaHistoria) anotarEnElRegistro({ storyFile, id: vivo.storyId, repo: repoNombre, numero, estricto: Boolean(storyPathArg) });
    }
    vivo.pr = { number: numero, merged, ...(repoNombre ? { repo: repoNombre } : {}) };
    // y por repo: el pedido de otro repo anotado después no pisa el de la historia (la espera de la compilación los
    // necesita todos). Sin --repo, el número es del repo de la corrida
    const delRepo = repoNombre || SR.nombreDelRepo(vivo.repoPath);
    if (delRepo) vivo.prs = { ...(vivo.prs || {}), [delRepo]: numero };
    vivo.lastTouch = nowIso();
    writeMarker(vivo);
    process.stderr.write(`[marker] pedido #${numero}${merged ? ' (mergeado)' : ''} anotado en la corrida de la ${vivo.storyId}\n`);
    return;
  }
  if (!story) {
    console.error('marker.js pr: no hay corrida viva en esta sesión: nombrá la historia con --story <id> para anotarlo en su último volcado');
    process.exit(2);
  }
  if (repoNombre && !storyPathArg) {
    console.error('marker.js pr: sin corrida viva, --repo necesita --story-path <ruta de la historia>: el número solo no alcanza para saber su clave');
    process.exit(2);
  }
  if (repoNombre) anotarEnElRegistro({ storyFile: storyPathArg, id: story, repo: repoNombre, numero, estricto: true });
  const RL = require('./run-lines.js');
  let repoDir = null;
  try { repoDir = require('./repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { repoDir = null; }
  const volcado = RL.ultimoVolcado({ stateDir: STATE_DIR, storyId: story, repoDir, pr: numero });
  if (!volcado) {
    if (repoNombre) {
      process.stderr.write(`[marker] no encontré el volcado de la historia ${story} en esta máquina: el pedido quedó en el registro, no en el volcado\n`);
      return;
    }
    console.error(`marker.js pr: no encontré ningún volcado de la historia ${story} de este repo en ${path.join(STATE_DIR, 'timing-history')}`);
    process.exit(1);
  }
  const { archivo: hist, dump } = volcado;
  const pedido = { number: numero, merged, ...(repoNombre ? { repo: repoNombre } : {}) };
  dump.marker = { ...dump.marker, pr: pedido };
  fs.writeFileSync(hist, JSON.stringify(dump, null, 2), 'utf8');
  // la copia en la carpeta de la corrida: el volcado con el mismo sello
  const ts = path.basename(hist, '.json').slice(`${String(story).replace(/[^\w.-]/g, '_')}-`.length);
  const runDir = RL.carpetaDe(dump.marker);
  if (runDir) {
    const copia = path.join(runDir, `timing-dump-${ts}.json`);
    try {
      const c = JSON.parse(fs.readFileSync(copia, 'utf8'));
      c.marker = { ...(c.marker || {}), pr: pedido };
      fs.writeFileSync(copia, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) { process.stderr.write(`[marker] no pude anotar el pedido en la copia del volcado (${copia}: ${e.code || e.message})\n`); }
  }
  try {
    process.stdout.write(`${RL.final({ dump, runDir, stateDir: STATE_DIR })}\n`);
  } catch (e) { process.stderr.write(`[marker] no pude armar el renglón final (${e.message})\n`); }
}

/**
 * Los pedidos de la corrida, por repo: `{ pedidos: [{ repo, nombre, numero, rama }], faltan: [nombre], problemas: [texto] }`.
 * `faltan`: los repos con commits propios (adelante de `origin/main`) cuyo pedido no quedó anotado; sin él, la regla de la
 * entrada no reconoce esa fusión como de esta historia, y el cierre no puede esperar su compilación. Nunca tira.
 */
function pedidosDeLaCorrida(marker) {
  const out = { pedidos: [], faltan: [], problemas: [] };
  try {
    const SR = require('./story-requests.js');
    const storyFile = resolveStoryPath(marker.storyPath, marker);
    const { key } = require('./evidence-key.js').keyInfoOr(storyFile, String(marker.storyId));
    const { dir } = require('./evidence-config.js').evidenceDirForStory(storyFile, marker.repoPath);
    // sólo cuenta un renglón de esta corrida: uno de un pedido anterior no cubre los commits de ahora
    const anotados = new Map();
    const deEstaCorrida = (f) => f.clave === key && (!marker.startedAt || (f.ts && f.ts >= marker.startedAt));
    for (const [k, filas] of SR.leer({ dirs: dir ? [dir] : [] }).porPedido) {
      if (!filas.some(deEstaCorrida)) continue;
      const i = k.lastIndexOf('#');
      anotados.set(k.slice(0, i), Number(k.slice(i + 1)));
    }
    for (const [nombre, n] of Object.entries(marker.prs || {})) if (Number.isInteger(n) && n > 0) anotados.set(nombre, n);
    const pr = marker.pr;
    if (pr && Number.isInteger(pr.number)) anotados.set(pr.repo || SR.nombreDelRepo(marker.repoPath), pr.number);
    const git = (repo, args) => require('child_process').spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    for (const repo of reposParaComparar(marker)) {
      const nombre = SR.nombreDelRepo(repo);
      if (!nombre) continue;
      if (anotados.has(nombre)) {
        const rama = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
        const punta = git(repo, ['rev-parse', 'HEAD']);
        out.pedidos.push({ repo, nombre, numero: anotados.get(nombre), rama: rama.status === 0 ? rama.stdout.trim() : null, commit: punta.status === 0 ? punta.stdout.trim() : null });
        continue;
      }
      if ((marker.noPr || {})[nombre]) continue;
      // sólo los commits de esta corrida: los de la historia escrita antes, o los de `dev` en un hermano, no piden pedido
      const r = git(repo, ['rev-list', '--count', ...(marker.startedAt ? [`--since=${marker.startedAt}`] : []), 'origin/main..HEAD']);
      if (r.status !== 0) out.problemas.push(`${nombre}: no pude ver si tiene commits sin pedido anotado (git no contestó)`);
      else if (Number(r.stdout.trim()) > 0) out.faltan.push(nombre);
    }
  } catch (e) { out.problemas.push(`no pude revisar los pedidos anotados (${e.message})`); }
  return out;
}

// Avisa, sin frenar, los repos de la corrida con commits propios cuyo pedido no quedó anotado. Nunca rompe el cierre.
function avisarPedidosSinAnotar(marker) {
  const p = pedidosDeLaCorrida(marker);
  for (const x of p.problemas) process.stderr.write(`[marker] ${x}\n`);
  for (const n of p.faltan) process.stderr.write(`[marker] ${n}: tiene commits de la corrida y sin pedido anotado (marker.js pr <número> --repo <carpeta>)\n`);
}

/**
 * Con «Preparar el pull request» cerrado, el cierre no da la corrida por terminada si un repo con commits no tiene su
 * pedido anotado: sin él no se espera su compilación, y el pedido se presentaría como listo con la CI sin ver (el
 * pedido del backend que nadie anotó). Sale 2 nombrando cada repo. Antes de ese paso, como siempre: sólo avisa.
 */
function frenarSiFaltanPedidos(marker) {
  if (!marker || !marker.storyId || !STEPS_LIB.isDone(marker, 'prepare-commit')) return;
  const p = pedidosDeLaCorrida(marker);
  if (!p.faltan.length) return;
  console.error(`marker.js clear: ${p.faltan.join(', ')} ${p.faltan.length === 1 ? 'tiene' : 'tienen'} commits de la corrida y sin pedido anotado. `
    + 'Sin el pedido de cada repo no se espera su compilación y la corrida no se puede dar por lista: abrí el pedido y anotalo con '
    + '`marker.js pr <número> --repo <carpeta>`; después, volvé a correr `marker.js clear`. Si ese repo no lleva pedido a '
    + 'propósito: `marker.js clear --no-pr <nombre del repo> --reason "<por qué>"` (queda en gates.log, y ese repo no cuenta como listo).');
  process.exit(2);
}

/**
 * `clear --no-pr <repo> --reason "<por qué>"` (repetible): los repos que a propósito no llevan pedido. Quedan en el
 * marcador (`noPr`) y en `gates.log`; la espera de la compilación no los cuenta. Sale 2 si falta el motivo.
 */
function reposSinPr(marker, rest) {
  const nombres = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--no-pr' && rest[i + 1]) nombres.push(rest[++i]);
  if (!nombres.length || !marker) return marker;
  const k = rest.indexOf('--reason');
  const motivo = k >= 0 ? String(rest[k + 1] || '').trim() : '';
  if (motivo.length < 8) { console.error('marker.js clear --no-pr: va con --reason "<por qué ese repo no lleva pedido>" (8 letras o más).'); process.exit(2); }
  marker.noPr = { ...(marker.noPr || {}) };
  for (const n of nombres) marker.noPr[n] = motivo;
  writeMarker(marker);
  appendLog('gates.log', { name: 'clear-no-pr', story: marker.storyId, repos: nombres, motivo });
  process.stderr.write(`[marker] sin pedido a propósito: ${nombres.join(', ')} («${motivo}»)\n`);
  return marker;
}

/**
 * Lanza de fondo la espera de la compilación de cada pedido de la corrida (lib/pr-build-wait.js). La lista va en un
 * archivo del estado: la espera lo lee y lo borra. Devuelve los pedidos que espera, o null si no lanzó nada.
 */
function lanzarEsperaDeCompilacion(marker) {
  if (!marker || !marker.storyId || !STEPS_LIB.isDone(marker, 'prepare-commit')) return null;
  const p = pedidosDeLaCorrida(marker);
  for (const x of p.problemas) process.stderr.write(`[marker] ${x}\n`);
  if (!p.pedidos.length) return null;
  try {
    const dir = path.join(STATE_DIR, 'pr-build-wait');
    fs.mkdirSync(dir, { recursive: true });
    const archivo = path.join(dir, `${estado.SID}-${Date.now()}.json`);
    fs.writeFileSync(archivo, JSON.stringify({ session: estado.SID, storyId: String(marker.storyId), pedidos: p.pedidos }), 'utf8');
    const hijo = require('child_process').spawn(process.execPath, [path.join(SCRIPTS_DIR, 'lib', 'pr-build-wait.js'), '--file', archivo], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    hijo.unref();
    return p.pedidos;
  } catch (e) {
    process.stderr.write(`[marker] no pude lanzar la espera de la compilación (${e.message}): los pedidos NO están listos hasta ver su compilación en verde\n`);
    return null;
  }
}

function cmdClear(rest = []) {
  // Timing dump automático: el cierre del
  // pipeline archiva el marker completo + los gates de la sesión ANTES de borrar —
  // es la única fuente de la curva de costo por run (stepTimings, iteraciones,
  // checks, gates con duración). Mecánico: no depende de que el orquestador se
  // acuerde de correr `pipeline.js timing-report` antes del clear. Best-effort:
  // un fallo acá JAMÁS bloquea el clear.
  let cerradaEnClear = false;
  let cierreDicho = false;
  let marcadorAntes = null;
  frenarSiIlegible(markerFilePath(estado.SID), estado.SID, 'clear');
  try { marcadorAntes = readMarker(); } catch (_e) { marcadorAntes = null; }
  frenarSiPerdida(estado.SID, 'clear', marcadorAntes && marcadorAntes.repoPath);
  marcadorAntes = reposSinPr(marcadorAntes, rest);
  frenarSiFaltanPedidos(marcadorAntes);
  // una ejecución detenida la cierra el dueño: el perfil puede delegar «cerrar la ejecución», pero esa firma por
  // delegación (o la automática) no alcanza para salir de una detención que espera su decisión
  let crudo = null;
  try { crudo = readOwnMarkerRaw(); } catch (_e) { crudo = null; /* frenarSiIlegible ya frenó uno que no se lee */ }
  if (crudo && crudo.needs_human === true) {
    const rc = require('./run-close.js');
    const frenos = rc.leerFrenos(os.homedir());
    const l = frenos ? rc.escapeDeCierre(frenos, estado.SID, crudo.startedAt) : null;
    if (!l || ['delegacion', 'automatica'].includes(l.via)) {
      console.error(`marker.js clear: una ejecución detenida la cierra una persona, no la delegación ni la firma automática (${l ? `la firma llegó por ${l.via}` : 'no hay constancia de su firma'}). No se borró nada.`);
      console.error('  O la retoma con su decisión: marker.js resume-autonomy');
      process.exit(1);
    }
  }
  try {
    const marker = readMarker();
    if (marker && marker.storyId) {
      let gates = [];
      try {
        const raw = fs.readFileSync(path.join(STATE_DIR, 'gates.log'), 'utf8');
        gates = raw.split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((g) => g && g.sessionId === estado.SID);
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
        const runLog = path.join(STATE_DIR, 'advisor-runs', `${estado.SID}.jsonl`);
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
      costo.iteraciones = require('./review-rounds.js').vueltas(marker);
      // La revisión adversarial de la historia antes de programar: su constancia, o null dicho. Lo no medido es null.
      let revisionPrevia = null;
      let notaPrevia = 'sin revisión previa';
      try {
        const sp = marker.storyPath && marker.repoPath && !path.isAbsolute(marker.storyPath) ? path.join(marker.repoPath, marker.storyPath) : marker.storyPath;
        revisionPrevia = require('./story-review-record.js').resumenVolcado(os.homedir(), sp);
      } catch (e) {
        // no poder leerla no es «no hubo»: se dice
        notaPrevia = `no se pudo leer la constancia de la revisión previa (${e.message})`;
        process.stderr.write(`[marker] ${notaPrevia}\n`);
      }
      // Cómo terminó la ejecución (lib/run-close.js): completa, o abortada con su motivo y quién autorizó cerrar. Un
      // cierre ya escrito (la deuda de close-as-debt) no se pisa. Que falle no frena el archivo: queda dicho.
      try {
        marker.cierre = require('./run-close.js').cierreDe(marker, { sid: estado.SID });
        const c = marker.cierre;
        cerradaEnClear = cerrarEjecucion(estado.SID, marker, { registrar: false, estado: c.estado, motivo: c.motivo || null, via: c.via || null, ...(c.deuda ? { extra: { deuda: c.deuda } } : {}) });
      } catch (e) {
        // sin poder calcularlo, la ejecución no cuenta como terminada: queda abortada y el motivo lo dice
        marker.cierre = { estado: 'abortada', motivo: `no pude determinar cómo terminó (${e.message})`, via: 'sin-registro', at: nowIso() };
        process.stderr.write(`[marker] no pude armar el cierre de la ejecución (${e.message}): queda como abortada\n`);
      }
      // El repo real de la carpeta (un worktree o un clon cuentan como su repo) para agrupar las ejecuciones en la vista.
      let repo = null;
      try { repo = require('./repo-attrib.js').realRepo(marker.repoPath); } catch (_e) { /* sin él, la vista deduce de la carpeta */ }
      const dump = {
        archivedAt: nowIso(), marker, gates, costo, ...(repo ? { repo } : {}),
        revision_previa: revisionPrevia, ...(revisionPrevia ? {} : { revision_previa_nota: notaPrevia }),
      };
      // Las firmas de la corrida, del registro común: las de sus sesiones entre el arranque y este cierre. Que falle no
      // frena el archivo: queda `no_medido` con su motivo.
      dump.firmas = firmasDelVolcado(dump);
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
      let carpetaDelVolcado = null;
      // 2) Copia en el repo (pipeline-runs del run, si resuelve) — viaja con los
      //    artefactos de la story para la retro / el retrospective-capturer.
      if (marker.repoPath && fs.existsSync(marker.repoPath)) {
        const runsDir = path.join(marker.repoPath, '.advisors', 'pipeline-runs');
        let target = null;
        try {
          // La carpeta de ESTA story: por la clave; con número repetido, `<id>-*` es la de otra.
          const sp = marker.storyPath ? (path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(marker.repoPath, marker.storyPath)) : null;
          const ki = require('./evidence-key.js').keyInfoOr(sp, String(marker.storyId));
          const clave = ki.key;
          // Sin clave el volcado cae en la raíz de pipeline-runs/ (como cuando no hay carpeta), pero se DICE por qué.
          if (!clave) process.stderr.write(`[marker] el volcado de tiempos va suelto a ${runsDir}: no pude calcular la clave de la carpeta de la story (${ki.error}).\n`);
          // la carpeta de la corrida que se limpia (su `runDir`, o la de su apertura): la misma regla que todos
          // (lib/run-dir.js); sin ninguna, la de la regla sin marcador
          if (clave) target = require('../pipeline.js').resolveRunDir(marker.repoPath, String(marker.storyId), false, sp || undefined, { marker }) || null;
        } catch (e) {
          process.stderr.write(`[marker] no pude calcular la carpeta de la corrida para el volcado de tiempos (${e.message}): va suelto a ${runsDir}.\n`);
        }
        if (!target) {
          target = runsDir;
          process.stderr.write(`[marker] el volcado de tiempos va suelto a ${runsDir}: no encontré la carpeta de la corrida de la story ${marker.storyId}.\n`);
          fs.mkdirSync(target, { recursive: true });
        }
        fs.writeFileSync(path.join(target, `timing-dump-${ts}.json`), JSON.stringify(dumpFinal, null, 2), 'utf8');
        carpetaDelVolcado = target;
      }
      process.stderr.write(`[marker] timing dump archivado: timing-history/${safeStory}-${ts}.json\n`);
      avisarCierreSinPasos(marker);
      avisarPedidosSinAnotar(marker);
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
      // Cómo terminó cada paso y con qué resultado cerró la corrida, después de la línea de costo; y un aviso
      if (STEPS_LIB.schemeOf(marker) === STEPS_LIB.SCHEME) decirRenglonesDelCierre(marker, dumpFinal, marker.runDir || carpetaDelVolcado);
      // la compilación de cada pedido se espera de fondo: el pedido no está listo para aprobar hasta verla en verde
      const esperados = lanzarEsperaDeCompilacion(marker);
      if (esperados) {
        process.stderr.write(`[corrida] pedidos abiertos, compilación corriendo: no están listos todavía (${esperados.map((x) => `#${x.numero} de ${x.nombre}`).join(', ')}). `
          + 'El aviso de «listos para aprobar» llega cuando todas den verde; no pidas la aprobación antes.\n');
      }
      // la historia terminó: la sesión se cierra. Va antes de la oferta, que tiene que quedar última (se lee con «| tail»)
      if (marker.storyId) { process.stdout.write(`${require('./resume-state.js').CIERRE_DE_SESION}\n`); cierreDicho = true; }
      // La oferta de la instalación completa al cerrar la primera historia: sale del cierre mecánico, después
      // de archivar el volcado (el volcado de ESTA corrida es la evidencia de que se cerró). Va a la salida estándar para
      // que el agente la muestre tal cual; un error se dice en un renglón y nunca frena el cierre.
      try {
        const offer = require('./first-story.js').afterClose({ home: os.homedir(), env: process.env, marker });
        for (const l of offer.lines) process.stdout.write(`${l}\n`);
        if (offer.warn) process.stderr.write(`[marker] ${offer.warn}\n`);
      } catch (e) { process.stderr.write(`[marker] la oferta de la instalación completa no se pudo evaluar: ${e.message}\n`); }
    }
  } catch { /* best-effort */ }
  // el archivo falló antes de anotar el cierre: se anota igual, para que la sesión no quede con su apertura sin marcador
  if (!cerradaEnClear && marcadorAntes && marcadorAntes.storyId) {
    cerrarEjecucion(estado.SID, marcadorAntes, { registrar: false, estado: 'abortada', motivo: 'clear: no pude archivar la ejecución ni calcular cómo terminó' });
  }
  clearMarker();
  // las copias congeladas de la corrida (historia 8.161): se les devuelve el permiso y se borran
  try { require('./frozen-tree.js').remove(STATE_DIR, estado.SID); } catch (e) { process.stderr.write(`[marker] no pude borrar las copias congeladas de la corrida (${e.message}): las barre la próxima vuelta\n`); }
  // y los clones de los humos comparados (historia 8.167)
  try { require('./compare-previous.js').limpiar(STATE_DIR, estado.SID); } catch (e) { process.stderr.write(`[marker] no pude borrar los clones de los humos comparados (${e.message}): los barre la próxima comparación\n`); }
  syncSessionState(estado.SID);
  // la historia terminó: la sesión se cierra, y la próxima arranca sin arrastrar esta conversación (si el archivo de la
  // ejecución falló antes de decirlo)
  if (!cierreDicho && marcadorAntes && marcadorAntes.storyId) process.stdout.write(`${require('./resume-state.js').CIERRE_DE_SESION}\n`);
}

function cmdIsActive() {
  const marker = readMarker();
  if (!marker) process.exit(1);
  process.stdout.write(marker.storyId);
  process.exit(0);
}

module.exports = {
  clearMarker, cmdSet, cmdGet, cmdTouch, esperasMain, frenarEsperaMain, frenarEstadoSiEsperaMain,
  anotarEsperaMainEnDoing, limpiarEsperaMainEnDoing, cmdWaitingOnMain, firmasDelVolcado, cmdAppendFile,
  rescatarHiloYConsumo, guardarCambioDeCorrida, avisarCierreSinPasos, tituloDeLaHistoria, decirRenglonesDelCierre,
  anotarEnElRegistro, cmdPr, pedidosDeLaCorrida, avisarPedidosSinAnotar, frenarSiFaltanPedidos, reposSinPr,
  lanzarEsperaDeCompilacion, cmdClear, cmdIsActive,
};
