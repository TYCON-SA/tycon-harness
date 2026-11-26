/**
 * pipeline-next.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: el paso siguiente de una corrida, la historia siguiente y lo que se le pide al paso (tamaño, riesgo, modelo).
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, STEPS_TABLE, anotarEnMarker, esLaStoryDelMarcador, exists, fs, harnessWorkSignal, homeCommand, os, packsLib, parseFrontmatterPipeline, path, readSessionMarker, readText, resolveSessionId, sessionIdFileKey, stateDirOf, storyDelMarcador, storyIsExemptCheck, storyRequiresRuntimeEvidenceCheck } = require('./pipeline-shared.js');
const { pipelineRel } = require('./home-command.js');
const { archivosFantasma, detectarWordSplit, senalesDe } = require('./pipeline-deep-review.js');
const { computeModelHint, conModelosDeLaCorrida, decirModelos } = require('./pipeline-models.js');
const { computeRiskClass, runSizeDelMarcador } = require('./pipeline-risk.js');
const STEPS_DIR = path.join(require('./state-dir.js').installedSkillsDir(), 'skills', 'tycon-pipeline', 'steps');
// El pase adversarial NO se cierra con `set-flag`: `deepReviewDone` la escriben sólo los dos comandos que dejan
// constancia, y el texto de `next` le dice al orquestador cuáles — sin esto, mandaría a correr un comando que sale 2.
// ¿La story lleva maqueta? Con la detección de la revisión de la pantalla (mockup.screenStory, perezoso).
// Ante un error, el que frena «no pude leer la story» es `complete-step approve-plan`, no este texto.
function storyNeedsMockup(storyPath) {
  try { return !!storyPath && require('../mockup.js').screenStory(storyPath).screen === true; } catch { return false; }
}
function notaCierre3(marker) {
  // una ruta relativa se resuelve contra el repo del marcador, como hace marker.js
  const sp = marker && marker.storyPath;
  const abs = sp && !path.isAbsolute(sp) ? path.join(marker.repoPath || process.cwd(), sp) : sp;
  const maqueta = storyNeedsMockup(abs)
    ? ` + --mockup-approved "<cita: quién aprobó la maqueta y por qué vía>" (story con pantalla: la maqueta la ve una persona, también con LOW — steps/${STEPS_TABLE.byId('approve-plan').file} §La maqueta)`
    : '';
  return `marker.js complete-step approve-plan --approved "<cita textual de la aprobación del user>"${maqueta}. Un plan de rutina lo aprueba el «aprobado» de su revisión automática (con o sin coordinadora); uno delicado, o con plan_review.routine_approval: person, una persona (steps/${STEPS_TABLE.byId('approve-plan').file}). Hasta entonces el portón de carril DENIEGA cualquier Edit/Write de código`;
}
const NOTA_CIERRE_5B = 'si el pase corrió, marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> '
  + '--tests <k> [--own <p> --in "<rutas>"] [--deferred <d> --reason "…"]; si no corre, marker.js mark-adversarial-skipped '
  + '--files <archivos de código del diff> (lo decide el portón). Los dos cierran el pase adversarial (la bandera ya no se escribe a mano)';
// La prueba en vivo tampoco se cierra con `complete-step`, ni se saltea en silencio. El cierre de «Preparar el pull request» exige
// `dodRuntimeChecked` SIEMPRE —la story exenta la deja con «exenta: …»—, así que `next` no puede dar la prueba en vivo por
// salteado y mandar al 8: chocaría contra ese freno después de obedecer a `next`. El motivo mecánico del salteo sigue a la vista en `skip_mechanical`.
const NOTA_CIERRE_7C = 'marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"<ruta de la evidencia>"}\'';
const NOTA_7C_EXENTA = 'La story está exenta de la verificación en vivo (dod_runtime_exempt: true): no hay nada que correr, pero el cierre '
  + 'de «Preparar el pull request» pide su constancia. Dejala con: marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"exenta: <la razón del frontmatter>"}\'.';

/**
 * Qué le falta al pase adversarial, para `next`. Sólo con «Correr las pruebas» cerrado.
 *
 * El lanzamiento temprano es un párrafo de la guía de «Correr las pruebas» que el agente no recuerda por sí solo (52 de 208 corridas con pase
 * lo lanzaron más de 2 minutos después del primer revisor): `next` lo pide, ANTES del primer revisor, con el
 * veredicto que el portón dejó anotado (`adversarialGate`): no lo recalcula, porque no tiene los archivos del cambio.
 * Sin veredicto, lo que pide es consultar el portón —la falta de veredicto no es «no corre»—.
 *
 * Nunca pide relanzar un pase atendido (relanzar uno cerrado bloquea «Preparar el pull request»), y ante un lanzamiento de otra sesión
 * sin resultado aplica la regla de `lib/adversarial-verdict.js` sin preguntarle a nadie.
 * → `{ pending_action?: { kind, message, command?, rule?, why? }, adversarial_note?: string }`
 */
function accionDelPase(marker, story, { sidNow, nextStep } = {}) {
  const { veredictoPaseAdversarial, paseAtendido, reglaPaseAjeno } = require('./adversarial-verdict.js');
  const v = veredictoPaseAdversarial(marker);
  if (v.motivo === 'pase-no-medido') {
    // El pase corrió y no revisó todo. No está atendido: se relanza (y en el mismo turno, --relaunch).
    const { SALIDA_APROBADA } = require('./adversarial-verdict.js');
    const p = v.pase || {};
    return {
      pending_action: {
        kind: 'relanzar-pase-no-medido',
        message: `el pase adversarial quedó NO MEDIDO (${p.motivo_no_medido || 'no revisó todo'}; resultado en ${p.resultado || '?'}): relanzalo en su paso («Pase adversarial») y anotalo con mark-adversarial-launched <runId> 5b --relaunch. Si Codex no contesta y no hay herramienta Workflow: ${SALIDA_APROBADA}.`,
      },
    };
  }
  if (paseAtendido(v)) {
    const skip = marker.adversarialSkip || {};
    if (v.motivo === 'abandonado' || skip.abandonado === true) {
      return { adversarial_note: `pase adversarial ABANDONADO con el interruptor (runId ${skip.runId || v.runId || '?'}), queda en bypass.log — no se pide lanzarlo` };
    }
    if (v.motivo === 'salteado-forzado') return { adversarial_note: 'salteo FORZADO, queda en bypass.log — no se pide lanzar el pase' };
    return {};
  }
  const adv = marker.adversarial && typeof marker.adversarial === 'object' ? marker.adversarial : null;
  if (adv && adv.sessionId !== sidNow) return { pending_action: reglaPaseAjeno(adv) };
  if (adv) {
    // lanzado por esta sesión: si su Workflow ya terminó y nadie anotó el resultado, se anota antes de seguir (para las
    // demás sesiones ya no ocupa la máquina); si sigue corriendo, el join es el paso del pase adversarial
    let terminado = false;
    try {
      terminado = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'tools', 'coordination.js')).passFinished({ home: require('os').homedir(), sessionId: adv.sessionId, runId: adv.runId });
    } catch (e) {
      process.stderr.write(`next: no pude ver si terminó el pase adversarial de esta sesión (${String(e.message).split('\n')[0]})\n`);
    }
    if (!terminado) return {};
    const command = `node ${path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js')} mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run ${adv.runId} --model <modelo> …`;
    return {
      pending_action: {
        kind: 'anotar-resultado-del-pase',
        message: `el pase adversarial de esta sesión terminó (runId ${adv.runId}) y falta anotar su resultado: anotalo antes de seguir — ${NOTA_CIERRE_5B}`,
        command,
      },
    };
  }

  if (!marker.storyPath) {
    return { adversarial_note: 'no pude leer la story: el marcador está sin ruta de story — no se pide lanzar el pase (el portón la necesita)' };
  }
  if (!story) {
    return { adversarial_note: `no pude leer la story (${marker.storyPath}) — no se pide lanzar el pase (el portón la necesita)` };
  }

  const gate = marker.adversarialGate && typeof marker.adversarialGate === 'object' ? marker.adversarialGate : null;
  if (gate && gate.early_launch === false) {
    return { adversarial_note: `lanzamiento temprano APAGADO para esta ejecución (${gate.early_origin || 'TYCON_5B_EARLY=0'}): el pase se lanza en su paso («Pase adversarial»)` };
  }
  const yo = path.join(estadoPipeline.SCRIPTS_DIR, 'pipeline.js');
  if (!gate || typeof gate.run !== 'boolean') {
    const command = `node ${yo} deep-review-gate --repo ${marker.repoPath || '<repo>'} --story ${marker.storyPath} --files <archivos de código del diff>`;
    return {
      pending_action: {
        kind: 'consultar-porton',
        message: `falta el veredicto del portón del pase adversarial — consultalo con los MISMOS archivos que vas a pasar a los revisores: ${command}`,
        command,
      },
    };
  }
  if (gate.run !== true) {
    // «preguntar» o «esperar» al dueño no es un salteo: queda pendiente hasta que alguien conteste
    if (gate.decision === 'ask' || gate.decision === 'wait') {
      return { pending_action: { kind: 'preguntar-revision-del-codigo',
        message: gate.decision === 'ask'
          ? 'el portón pide preguntarle a la persona si revisar el código: anotá la pregunta (marker.js review-ask --kind code) y esperá la respuesta (marker.js review-answer); con «review» se lanza el pase, con «skip» se anota el salteo'
          : 'el portón pide esperar a la persona para decidir la revisión del código: no se lanza ni se saltea hasta su respuesta (marker.js review-answer)' } };
    }
    return {};
  }
  // con otra sesión en su pase, o una ejecución grande en curso, `next` tampoco pide lanzarlo: el mismo turno que frena al portón
  try {
    const turno = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'tools', 'coordination.js')).adversarialTurn({ sessionId: sidNow });
    if (turno && turno.waiting_turn === true) {
      return { pending_action: { kind: 'esperar-turno-pase', message: `${turno.turn} No lo lances todavía: seguí con el paso que sigue. La coordinadora te avisa cuando se libere el lugar, y \`next\` deja de decir esto.` } };
    }
  } catch (e) {
    process.stderr.write(`next: no pude ver si hay otro pase adversarial en vuelo o una ejecución grande de pruebas (${String(e.message).split('\n')[0]})\n`);
  }
  const archivos = Array.isArray(gate.files) ? gate.files : [];
  const cuando = String(nextStep) === 'reviewers' ? 'AHORA, antes del primer revisor' : 'AHORA';
  return {
    pending_action: {
      kind: 'lanzar-pase',
      message: `el portón dice que el pase CORRE (${archivos.length} archivo(s)): lanzalo ${cuando} — tool Workflow con los args de step-08-adversarial-pass.md §Acción y esos archivos — y en el mismo turno: node ${path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js')} mark-adversarial-launched <runId> 4`,
      files: archivos,
    },
  };
}

/**
 * Lo que cambia en el paso por el tamaño de la corrida, o null. «Correr las pruebas» de una liviana: las tandas van
 * juntas. «Preparar el pull request» de una liviana: no se pide la validación pesada del repo, salvo que el dev la haya nombrado
 * (`marker.js set-flag heavyValidationRequested true`).
 */
function notaDelTamano(marker, nextStep) {
  if (!marker || marker.size !== 'liviana' || !nextStep) return null;
  if (String(nextStep.step) === 'implement') return 'Corrida liviana: las tandas van juntas en esta corrida (una sola implementación, una sola vuelta de pruebas).';
  if (String(nextStep.step) === 'prepare-commit') {
    return marker.heavyValidationRequested
      ? 'Corrida liviana, pero el dev nombró la validación pesada del repo: pedila antes del merge.'
      : 'Corrida liviana: no pidas la validación pesada del repo; se corre sólo si el dev la nombra (marker.js set-flag heavyValidationRequested true).';
  }
  return null;
}

function computeNext() {
  const marker = readSessionMarker();
  if (!marker || !marker.storyId) {
    return { error: 'sin marker activo en esta sesión — arrancá con `pipeline.js start --story <spec> --repo <dir>` (o marker.js set en el «Arranque»)' };
  }
  // Los dos marcadores se leen con la misma tabla: el viejo, con la equivalencia. Uno que no es ninguno de los dos no
  // se adivina.
  const scheme = STEPS_TABLE.schemeOf(marker);
  if (scheme === null) {
    return { error: 'el marcador de esta ejecución es ilegible o de un esquema desconocido (sus listas de pasos no son de la tabla de lib/steps.js): no sé qué paso sigue. Mirá `marker.js get`.' };
  }
  const story = marker.storyPath ? readText(marker.storyPath) : '';
  const fm = parseFrontmatterPipeline(story);

  // Las partes opcionales del Arranque: el aviso de trabajo, si la organización eligió una herramienta de horas
  // (`harnessTimeTool` es null si no se sabe: ahí se pide, como antes); el pedido en ADO, si la story lo trae.
  const timeTool = harnessTimeTool();
  const startParts = STEPS_TABLE.startPartsPending(marker, {
    'time-tracking': timeTool === null || timeTool.chosen === true,
    ado: !!(story && require(path.join(packsLib.raizAgentSkills(), 'scripts', 'lib', 'platform', 'work-item-field.js')).idOf(fm)),
  });
  const warnings = STEPS_TABLE.startWarningLines(marker);

  // Un arreglo después de Hallazgos (una edición de código posterior al último cierre de los revisores) pide otra vuelta.
  // Si los revisores cerraron después de «Preparar el pull request», lo preparado ya no es lo revisado: se prepara de nuevo.
  const reloop = STEPS_TABLE.reviewersRound(marker);
  const ultimoViejo = STEPS_TABLE.prepareCommitStale(marker);

  const stepState = [];
  let nextStep = null;
  for (const s of STEPS_TABLE.STEPS) {
    let done = STEPS_TABLE.isDone(marker, s.id);
    let skip = null;
    if (s.id === 'reviewers' && reloop) done = false;
    if (s.id === 'prepare-commit' && ultimoViejo) done = false;
    if (s.id === 'live-check' && !done && story) {
      // el único salteo que deja constancia: sin ella «Preparar el pull request» no cierra (ver NOTA_CIERRE_7C)
      if (storyIsExemptCheck(story)) skip = 'dod_runtime_exempt: true en frontmatter';
      else if (!storyRequiresRuntimeEvidenceCheck(story)) skip = 'story NO declara runtime tests (sin tests_done_*, sin E2E, sin tests/e2e/)';
    }
    const round = s.id === 'reviewers' && reloop ? reloop.round : undefined;
    const entry = { step: s.id, number: s.number, name: STEPS_TABLE.stepName(s.id, round), file: path.join(STEPS_DIR, s.file), done, ...(skip ? { skip_mechanical: skip } : {}),
      ...(round ? { to_review: reloop.archivos } : {}), ...(round && reloop.chica ? { small_round: true } : {}),
      ...(s.id === 'prepare-commit' && ultimoViejo ? { again: 'los revisores cerraron después: lo preparado ya no es lo revisado' } : {}) };
    stepState.push(entry);
    if (!nextStep && !done) nextStep = { ...entry, ...(round ? { round } : {}) };
  }
  const exempt7c = !!nextStep && nextStep.step === 'live-check' && storyIsExemptCheck(story);
  const etiqueta = nextStep ? `«${nextStep.name}» (paso ${nextStep.number} de ${STEPS_TABLE.TOTAL})` : null;
  // lo que falta revisar, por su nombre (hasta cinco), o por qué se prepara el commit otra vez
  const faltaRevisar = nextStep && nextStep.to_review
    ? ` Falta revisar lo cambiado después de los revisores: ${nextStep.to_review.slice(0, 5).join(', ')}${nextStep.to_review.length > 5 ? ` y ${nextStep.to_review.length - 5} más` : ''}.`
      + (nextStep.small_round ? ' Sólo cambiaron textos: es una vuelta chica (smart-reloop devuelve sólo el revisor de seguridad, sin firma aunque se haya pasado el tope).' : '')
    : nextStep && nextStep.again ? ` Otra vez: ${nextStep.again}.` : '';

  // Pre-condiciones del next conocidas por el script.
  const preconditions = [];
  if (nextStep && nextStep.step === 'prepare-commit') {
    preconditions.push({ id: 'dodRuntimeChecked', satisfied: marker.dodRuntimeChecked === true, detail: '«Probar en vivo» debe haber pasado (marker.dodRuntimeChecked)' });
    const checks = marker.checks || {};
    for (const c of ['build', 'tests', 'advisors']) {
      // «sin-acotar» (tests) se acepta anunciándolo: la cubre la CI del pedido (complete-step run-tests lo dijo y lo anotó).
      const sinAcotar = c === 'tests' && checks[c] === 'sin-acotar';
      // «sin-medir» (tests): el portón no sabe correr las pruebas del repo; se acepta diciéndolo, y el cierre
      // de la historia copia la línea (nunca un verde callado)
      const sinMedir = c === 'tests' && checks[c] === 'sin-medir';
      // «sin-turno» (tests): el portón no corrió porque otra sesión tenía el turno; no se cumple, y se dice sin llamarlo rojo
      const sinTurno = c === 'tests' && checks[c] === 'sin-turno';
      // «rojo-esperado» (expect-red): lo aceptan el cierre del turno y prepare-commit sólo con la deuda escrita; acá, igual
      const esperado = /^rojo-esperado/.test(String(checks[c])) && !!marker.cierre && marker.cierre.estado === 'deuda';
      if (checks[c]) preconditions.push({ id: `check-${c}`, satisfied: checks[c] === 'green' || sinAcotar || sinMedir || esperado, detail: `marker.checks.${c}=${checks[c]} (provenance: ${(marker.checksProvenance || {})[c] || 'desconocida'})${sinAcotar ? ' — sin acotar: la cubre la CI del pedido; antes del merge hay que mirar que salga verde (esta máquina no lo comprueba)' : ''}${sinMedir ? ' — pruebas no medidas: el portón no sabe correr las pruebas de este repo; el cierre de la historia lo dice en una línea, y para medirlas se declara el comando en el sitio de la organización (Configuración → Tu tecnología → Cómo se corren las pruebas)' : ''}${esperado ? ` — rojo esperado por la deuda ${marker.cierre.deuda}` : ''}${sinTurno ? ' — sin turno: el portón no corrió porque otra sesión tenía el turno de las ejecuciones grandes; no hay pruebas que arreglar, se corre el portón cuando la coordinadora dé el turno' : ''}` });
    }
  }

  // El estado del pase adversarial viaja en el
  // comando canónico "¿qué sigue?" — el cap de ventana del paso de revisores y el JOIN de 3 ramas del
  // el paso «Pase adversarial» dependen de él, y sin esto habría que acordarse de un `marker.js get` extra.
  const adv = marker.adversarial || null;
  const sidNow = resolveSessionId();
  const advIsOurs = adv ? adv.sessionId === sidNow : null;
  const pase = STEPS_TABLE.isDone(marker, 'run-tests') ? accionDelPase(marker, story, { sidNow, nextStep: nextStep ? nextStep.step : null }) : {};
  const pending = pase.pending_action || null;
  // lo del pase que va antes del paso, en las tres formas de la instrucción: un pedido que viaja sólo en el JSON no se lee
  const antesDelPase = pending && ['consultar-porton', 'lanzar-pase', 'esperar-turno-pase', 'anotar-resultado-del-pase'].includes(pending.kind)
    ? `ANTES, pase adversarial: ${pending.message} ` : '';

  // Cómo se cierra el paso que sigue.
  const cierre = (st) => {
    if (st.step === 'adversarial-pass') return NOTA_CIERRE_5B;
    if (st.step === 'live-check') return NOTA_CIERRE_7C;
    if (st.step === 'approve-plan') return notaCierre3(marker);
    if (st.step === 'reviewers') return 'marker.js run-check advisors -- pipeline.js check-count … y recién después marker.js complete-step reviewers (bloquea sin el verde real)';
    return `marker.js complete-step ${st.step}`;
  };
  // El arnés viejo (lib/harness-freshness.js): pasos leídos de otra carpeta que la del arnés que corre frenan; el aviso
  // de una versión nueva o de una actualización que falló sale una vez por ejecución, antes de las partes del Arranque.
  let avisoArnes = null;
  // con el enchufe agent-skills presente se mira siempre (un enlace roto o una carpeta sin los pasos son el arnés viejo);
  // sin él (una casa de prueba, una CI) no hay de dónde leer pasos que comparar
  let hayAgentSkills = false;
  try { fs.lstatSync(require('./state-dir.js').installedSkillsDir()); hayAgentSkills = true; } catch (_) { hayAgentSkills = false; }
  if (hayAgentSkills) {
    const f = require('./harness-freshness.js').revisar({ stepsDir: STEPS_DIR, nextFile: nextStep ? nextStep.file : null, scriptDir: estadoPipeline.SCRIPTS_DIR });
    if (f.error) return { error: f.error, harness_stale: true };
    const linea = f.aviso || f.sinEstado;
    if (linea && marker.harnessFreshnessNoted !== true) {
      avisoArnes = linea;
      // sin la marca el aviso se repite en cada `next`: que diga por qué
      const a = anotarEnMarker({ harnessFreshnessNoted: true });
      if (!a.ok) avisoArnes = `${linea} (se va a repetir: ${a.motivo})`;
    }
  }
  // Las partes del Arranque que corren y faltan se hacen antes de seguir (o mientras valida la story, como dice su paso).
  const partes = (avisoArnes ? `${avisoArnes} ` : '') + (startParts.length
    ? `ANTES, lo que falta del Arranque: ${startParts.map((p) => p.name).join(' y ')} (${STEPS_TABLE.byId('start').file}); si una parte falla, marker.js start-warning <time-tracking|ado> "<motivo>" y seguí. `
    : '');

  return {
    story_id: marker.storyId,
    story_path: marker.storyPath,
    autonomous: marker.autonomous === true,
    checks: marker.checks || {},
    checks_provenance: marker.checksProvenance || {},
    adversarial: adv,
    adversarial_is_ours: advIsOurs,
    // el paso por su nombre de máquina (lo que tipean los comandos), su número seguido y su nombre llano (lo que se le
    // dice al dueño)
    next_step: nextStep ? nextStep.step : null,
    step_number: nextStep ? nextStep.number : null,
    step_total: STEPS_TABLE.TOTAL,
    // la vuelta de los revisores viaja en el nombre («Revisores, vuelta 2»)
    step_name: nextStep ? nextStep.name : null,
    next_step_file: nextStep ? nextStep.file : null,
    step_scheme: scheme,
    preconditions,
    steps: stepState,
    ...(avisoArnes ? { harness_notice: avisoArnes } : {}),
    ...(startParts.length ? { start_parts: startParts } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(pending ? { pending_action: pending } : {}),
    ...(pase.adversarial_note ? { adversarial_note: pase.adversarial_note } : {}),
    ...(notaDelTamano(marker, nextStep) ? { run_size_note: notaDelTamano(marker, nextStep) } : {}),
    note: exempt7c
      ? `${partes}${antesDelPase}Sigue ${etiqueta}. ${NOTA_7C_EXENTA}`
      : nextStep
      ? `${partes}${antesDelPase}Sigue ${etiqueta}.${faltaRevisar} Leé SOLO ${path.basename(nextStep.file)} y ejecutalo. Los skips listados son mecánicos (verificables) — no infieras otros (regla E.i). Al completar: ${cierre(nextStep)}.${pending && pending.kind.endsWith('-pase-ajeno') ? ` ⚠️ ${pending.message} Regla: ${pending.rule} (${pending.why}).` : ''}${notaDelTamano(marker, nextStep) ? ` ${notaDelTamano(marker, nextStep)}` : ''}${warnings.length ? ` ${warnings.join(' · ')}.` : ''}`
      : `${antesDelPase}No quedan pasos pendientes — cerrá con marker.js clear (o ${STEPS_TABLE.CLOSE_STEP.file} si vas a cerrar la story en ADO: «${STEPS_TABLE.CLOSE_STEP.name}»).`,
  };
}

/** La parte anotada en el marcador de esta sesión, si es de la misma story; si no, undefined. La lee sólo `risk-class`. */
function batchDelMarcador(storyPath) {
  const m = readSessionMarker();
  if (!m || !m.batch || !storyDelMarcador(m)) return undefined;
  return esLaStoryDelMarcador(storyPath, m) ? m.batch : undefined;
}

/**
 * La herramienta de horas que eligió la organización: `{ chosen: true, name }`, `{ chosen: false, reason }` (ninguna,
 * desconocida o con el manifiesto roto, con el motivo) o null si no se sabe (sin el evento, o la configuración rota).
 * `next` la pregunta en cada consulta: no anota el uso del nombre viejo de la llave.
 */
function harnessTimeTool(opts = {}) {
  const env = opts.env || process.env;
  const h = harnessWorkSignal(opts);
  if (!h || h.loadError) return null;
  let c;
  try {
    const ask = () => h.ws.chosen({ env, home: opts.home });
    c = h.TC && typeof h.TC.sinAnotar === 'function' ? h.TC.sinAnotar(ask) : ask();
  } catch (_) { return null; }
  if (c.manifest) return { chosen: true, name: c.manifest.name };
  if (c.value === 'none') return { chosen: false, reason: 'ninguna herramienta de horas elegida (integrations.timeTracking: none)' };
  if (!c.value) return null;
  return { chosen: false, reason: `ninguna herramienta de horas: ${c.warning}` };
}

// ── pipeline.js next-story — auto-discovery de la próxima story ─
// bmad-dev-story Step 1 lee sprint-status.yaml y encuentra la primera ready-for-dev en orden,
// con menú de recuperación si no hay ninguna. Esto evita pasar el path del spec a mano.
// Esto lo automatiza sobre la convención TYCON (specs/stories/N-M-*.md con status: en
// frontmatter). NO arranca el pipeline — devuelve el path para que el orquestador corra
// `start --story` (respeta la separación: discovery ≠ mutación).
// "2-10-foo" → [2, 10]; orden NUMÉRICO (no lexicográfico: "2-10" va después de "2-9").
// La clave sale de lib/story-discovery.js: el mismo criterio que usa el descubridor para ordenar
// las stories que encuentra. Dos copias de una regla de orden son la
// versión chiquita del problema que este archivo existe para evitar.
const { idSortKey: storyIdSortKey } = require('./story-discovery.js');
function cmpStoryId(a, b) {
  const ka = storyIdSortKey(a);
  const kb = storyIdSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] === undefined ? Infinity : ka[i]) - (kb[i] === undefined ? Infinity : kb[i]);
    if (d) return d;
  }
  return a < b ? -1 : (a > b ? 1 : 0);
}
// next-story usa EL MISMO descubridor que el resto del arnés (lib/story-discovery.js).
// Si armara su propia lista con `readdirSync(<repo>/specs/stories)` filtrando por nombre de
// archivo (`/\d+-\d+/`): en todo repo con otro layout devolvería el error "no existe …/specs/stories"
// — por ejemplo, donde las stories viven en `specs/bizuit-bpmn-mcp/`. Dos buscadores
// distintos es garantía de que arreglar uno deje al otro roto.
function computeNextStory(args) {
  const { discoverStories, findRepoRoot } = require('./story-discovery.js');
  const cwdRepo = path.resolve(args.repo || process.cwd());
  const repoRoot = findRepoRoot(cwdRepo) || cwdRepo;
  // `--specs-dir` sigue valiendo: acota el escaneo a ese subárbol (la config del repo se lee igual).
  const scanRoot = args.specsDir ? path.resolve(args.specsDir) : repoRoot;

  const recoveryOptions = (byStatus) => [
    (byStatus['in-progress'] && byStatus['in-progress'].length)
      ? `retomar una in-progress: ${byStatus['in-progress'].map((s) => s.story_id).join(', ')}`
      : null,
    'crear la próxima story (tycon-create-story) desde los epics',
    'validar/mejorar una story existente (tycon-story-validator) para pasarla a ready-for-dev',
    'pasar un path de story explícito a `pipeline.js start --story <spec>`',
  ].filter(Boolean);
  if (!exists(scanRoot)) {
    return { error: `no existe ${scanRoot} — pasá --specs-dir <dir> o corré desde un repo con stories`, options: recoveryOptions({}) };
  }

  // Presupuesto generoso: esto es un comando, no un hook por edición. Truncar acá sería peor que
  // tardar — un "no hay próxima story" falso manda a crear una que ya existe.
  const found = discoverStories(scanRoot, { configRoot: repoRoot, budgetMs: 15000, cache: false });

  const byStatus = { 'ready-for-dev': [], 'in-progress': [], review: [], done: [], blocked: [], other: [] };
  for (const s of found.stories) {
    const st = (s.status || 'other').toLowerCase();
    (byStatus[st] || byStatus.other).push({ story_id: s.id, story_path: s.path, sprint: s.sprint || null, title: s.title || null });
  }
  const scanned = {
    root: scanRoot,
    stories_found: found.stories.length,
    excluded: found.excluded.length,
    partial: found.partial,
    id_criterion: found.config && found.config.source ? `${found.config.source} (.tycon/advisors.yaml)` : 'default (id jerárquico numérico)',
  };
  const warnings = found.warnings.slice();
  if (found.stories.length === 0) {
    warnings.push(
      `0 stories Mary+GOLD bajo ${scanRoot}. Una story es un .md cuyo frontmatter declara \`story:\` y \`status:\`, ` +
      `y cuyo id tiene forma de trabajo (${scanned.id_criterion}). Diagnóstico: ` +
      `${homeCommand(pipelineRel('scripts/lib/story-discovery.js'))} --doctor --repo <dir>`,
    );
  }

  const nextReady = byStatus['ready-for-dev'][0] || null;
  if (nextReady) {
    return {
      next_story: nextReady,
      in_progress: byStatus['in-progress'],
      ready_count: byStatus['ready-for-dev'].length,
      scanned,
      warnings,
      command: `pipeline.js start --story ${nextReady.story_path} --repo <dir>`,
      note: byStatus['in-progress'].length
        ? `⚠️ Hay ${byStatus['in-progress'].length} story(s) in-progress (${byStatus['in-progress'].map((s) => s.story_id).join(', ')}) — ¿retomar una antes de arrancar ${nextReady.story_id}? El user decide.`
        : `Próxima ready-for-dev: ${nextReady.story_id}. Arrancá con el command de arriba (el user confirma).`,
    };
  }
  return {
    next_story: null,
    in_progress: byStatus['in-progress'],
    review: byStatus.review,
    scanned,
    warnings,
    note: 'No hay stories ready-for-dev — menú de recuperación (mirror bmad-dev-story Step 1).',
    options: recoveryOptions(byStatus),
  };
}


// ── Máquina de estados incremental + Nivel 2 + instrumentación ─────────────
function cmdNext(cmd, args) {
  // Si este comando trae el interruptor del temprano explícito, queda para la corrida —en una
  // sesión de agente el entorno no pasa de un comando al siguiente—. Lo anota marker.js; sin corrida, nada.
  if (process.env.TYCON_5B_EARLY === '0' || process.env.TYCON_5B_EARLY === '1') {
    try {
      require('child_process').execFileSync(process.execPath, [path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js'), 'mark-adversarial-gate',
        JSON.stringify({ early_env: process.env.TYCON_5B_EARLY })], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
    } catch (e) {
      // se dice: sin la anotación, el próximo `next` sin la variable vuelve a pedir el temprano que se apagó
      const detalle = String((e && e.stderr) || (e && e.message) || '').trim().split('\n')[0];
      process.stderr.write(`next: no pude anotar TYCON_5B_EARLY=${process.env.TYCON_5B_EARLY} en la corrida (${detalle}) — vale sólo para este comando\n`);
    }
  }
  const result = computeNext();
  // La revisión automática del plan que rechazó el plan de esta corrida (la más nueva, de cualquier sesión que la haya
  // lanzado): se muestra mientras el plan siga igual. Best-effort: leerla nunca rompe la consulta.
  try {
    const m = readSessionMarker();
    const pr = require('./plan-review.js');
    const c = m && pr.ultimaDelDestino({ estado: stateDirOf(os.homedir()), destino: sessionIdFileKey() });
    const plan = c && c.veredicto === 'rechazado' ? pr.planDe(m) : null;
    if (plan && plan.texto && require('crypto').createHash('sha256').update(plan.texto).digest('hex') === c.huellas.plan
      && c.corrida && c.corrida.startedAt === (m.startedAt || null)) {
      result.plan_review = { veredicto: c.veredicto, lanzo: c.lanzo, hora: c.hora, hallazgos: c.hallazgos };
      result.note = `${result.note ? `${result.note} ` : ''}La revisión automática rechazó el plan (${c.hallazgos.length} hallazgo(s), plan_review): corregilo antes de que lo apruebe alguien.`;
    }
    if (c && c.aviso) result.plan_review_aviso = c.aviso;
    // al llegar a «Aprobar el plan» con el plan cerrado: qué toca con su revisión según la matriz de la organización
    if (m && result.next_step === 'approve-plan') {
      const a = pr.accionDelPlan({ estado: stateDirOf(os.homedir()), sesion: sessionIdFileKey(), marker: m, home: os.homedir() });
      if (a && a.decision) result.plan_review_action = a;
    }
  } catch { /* sin la revisión, next sale igual */ }
  // en un punto de control, lo que falta en disco para retomar en una sesión nueva sin releer la conversación
  try {
    const m = readSessionMarker();
    const CD = require('./resume-state.js');
    if (m && CD.PUNTOS_DE_CONTROL.has(result.next_step)) {
      let lineas = [];
      if (result.next_step === 'findings') {
        try { lineas = fs.readFileSync(path.join(stateDirOf(os.homedir()), 'advisor-runs', `${sessionIdFileKey()}.jsonl`), 'utf8').split('\n'); } catch { lineas = []; }
      }
      const falta = CD.faltantes({ marker: m, paso: result.next_step, lanzados: CD.lanzadosDe({ lineas, marker: m }) });
      result.checkpoint_disk = falta;
      const a = CD.aviso(falta);
      if (a) result.note = `${result.note ? `${result.note} ` : ''}${a}`;
    }
  } catch (e) { result.checkpoint_disk_aviso = `no pude mirar qué falta en disco (${e.message})`; }
  // Consultar `next` es el momento en que el orquestador ARRANCA ese paso — se anota la
  // hora. Lo escribe marker.js (un solo escritor del marker); él decide no mover un arranque ya
  // anotado ni arrancar un paso completo. Las partes del arranque, el pase adversarial y la prueba en vivo también: su trabajo no puede
  // caer como «tiempo entre pasos». Best-effort: medir nunca puede romper la consulta.
  // el paso por su nombre de máquina (o el número de un marcador viejo): marker.js decide qué arranque anotar
  if (!result.error && (STEPS_TABLE.byId(result.next_step) || /^(\d|0b|0c|5b|7c)$/.test(String(result.next_step || '')))) {
    try {
      require('child_process').execFileSync(process.execPath, [path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js'), 'start-step', String(result.next_step)],
        { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } catch { /* sin arranque: la cuenta lo rotula «estimada», no lo inventa */ }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.harness_stale) process.stderr.write(`next: ${result.error}\n`);
  process.exit(result.harness_stale ? 2 : result.error ? 1 : 0);
}

function cmdEstimateReal(cmd, args) {
  // lo real de la historia al cerrarla, con las horas de la constancia de work-signal stop (nunca un número a mano)
  const { code, result } = require('./real-hours.js').estimateReal({
    storyPath: args.story ? path.resolve(args.story) : null, run: args.run, hoursGiven: !!args.hoursGiven,
    repo: process.argv.includes('--repo') ? args.repo : null, home: os.homedir(),
  });
  if (code !== 0) process.stderr.write(`estimate-real: ${result.reason}\n`);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = code;
  return;
}

function cmdRiskClass(cmd, args) {
  // Guarda de aridad/existencia: sin esto un --files mal expandido cuenta 1
  // archivo → LOW → se saltea la revisión adversarial de la story Y skip del
  // pase adversarial, los dos en silencio. Sólo si vino --files: sin el flag, risk-class cae legítimamente
  // al frontmatter de la story (files_to_create/files_to_modify) y no hay nada que validar.
  // SÓLO la guarda de aridad, no la validación de existencia completa.
  // Estos dos comandos salen `exit 0` salvo por esta guarda, y un diff que BORRA
  // archivos pasa `--files` con paths que ya no existen — un caso legítimo y frecuente que
  // `advisors` cubre con `--allow-missing-files` pero que acá no tiene forma de declararse.
  // Abortar por eso sería romper corridas válidas; lo que hay que atajar es el word-split, que
  // es el que produce un LOW falso y apaga dos frenos.
  const wsErr = detectarWordSplit(args);
  if (wsErr) { process.stderr.write(wsErr); process.exit(2); }
  // Tampoco un archivo que no está ni en el disco ni en HEAD (la lista con comas). Un borrado pasa.
  const fantasmaErr = archivosFantasma(args);
  if (fantasmaErr) { process.stderr.write(fantasmaErr); process.exit(2); }
  // la parte anotada mide el plan; sólo este comando y la revisión del plan la pasan (el pase, el modelo y la revisión
  // de la historia siguen por la historia entera)
  const batch = args.batch || batchDelMarcador(args.story);
  const result = computeRiskClass({ ...args, runSize: runSizeDelMarcador(args.story), batch });
  // las dos señales, como aviso: no cambian el riesgo ni la delicada
  const avisos = senalesDe(args.story, args.repo, batch);
  if (avisos.length) result.warnings = [...(result.warnings || []), ...avisos];
  // Una story con pantalla pide aprobar la maqueta con el plan. `computeRiskClass` es pura (no sabe la raíz del
  // repo): la maqueta se suma acá, sin tocar el riesgo.
  if (storyNeedsMockup(args.story)) {
    result.mockup_required = true;
    result.note = `${result.note} Story con pantalla: la maqueta la aprueba quien aprueba el plan (--mockup-approved, steps/${STEPS_TABLE.byId('approve-plan').file} §La maqueta).`;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

function cmdModelHint(cmd, args) {
  // Sugerencia de modelo de SESIÓN por complejidad. Advisory puro:
  // exit 0 siempre; el orquestador compara con su propio modelo y sugiere /model.
  const conModelos = conModelosDeLaCorrida({ ...args, runSize: runSizeDelMarcador(args.story) });
  const result = computeModelHint(conModelos);
  if (result.session_warning) process.stderr.write(`model-hint: ${result.session_warning}\n`);
  decirModelos(result, conModelos.orgModels, result._avisos || []);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}


// ── next-story — auto-discovery de la próxima story ready-for-dev ─
function cmdNextStory(cmd, args) {
  const result = computeNextStory(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : 0);
}

module.exports = { cmdNext, cmdNextStory, cmdEstimateReal, cmdModelHint, cmdRiskClass, harnessTimeTool, notaDelTamano, computeNextStory, cmpStoryId };
