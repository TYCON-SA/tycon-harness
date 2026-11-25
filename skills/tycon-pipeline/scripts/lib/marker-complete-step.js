/**
 * marker-complete-step.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: cerrar un paso del pipeline con los frenos de ese paso.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  CONTROLES_DEL_PASO, MARKER_JS, ORDER_REQUIRES_OLD, PEDIDA, PROPIA,
  SCRIPTS_DIR, STATE_DIR, STEPS_LIB, anotarAprobacion, anotarFirma,
  anotarOtraVuelta, antesDeLaRevision, appendLog, avisarBajaDePantalla,
  comprobarLoRevisado, conHoraDelPaso, deudaDeLaMatriz, dondeViveLaHistoria,
  estado, firmaDelDueno, formasDeFirmarArchivo, fs, hermanosDeLaCorrida,
  homeCommand, huellaDelPlan, markerFilePath, markerScreenRule, markerStoryIsUi,
  mensajeDelPaseAdversarial, motivoDe, nn, nowIso, os, path, planDeLaCorrida,
  planParaLaPersona, planVisto, porDe, quienDeLasOpciones, readMarker,
  citaDe, conPersona, hechaSinPersona, modoDeLaFirma, quienDeLaMaqueta, reemplazada, soloLaPersona, aprobadaPorPersona, noPisaLaPersona,
  reposParaComparar, resolveStoryPath, signatureCommand, syncSessionState,
  testsNotMeasuredLine, veredictoPaseAdversarial, writeMarker,
} = require('./marker-shared.js');
const frenarEsperaMain = (...a) => require('./marker-lifecycle.js').frenarEsperaMain(...a);

// Las pruebas que fallan según el informe del gate (`.advisors/tests-result.json`), para que el aviso diga qué falta.
// Sin informe, o sin la lista (los corredores que sólo cuentan), null: el aviso sale igual, sin nombres.
function pruebasQueFallan(repo) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(repo || process.cwd(), '.advisors', 'tests-result.json'), 'utf8')).totals || {};
    const lista = Array.isArray(t.failures) ? t.failures.map(String) : [];
    if (!lista.length) return null;
    return lista.slice(0, 10).join(', ') + (lista.length > 10 ? ` y ${lista.length - 10} más` : '');
  } catch { return null; }
}
// Quién corre la suite completa cuando el repo acota el portón (`scoped_by_repo` del informe del gate), o null.
function portonAcotadoPorElRepo(repo) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repo || process.cwd(), '.advisors', 'tests-result.json'), 'utf8'));
    return j.scoped_by_repo && j.scoped_by_repo.full_suite_by ? String(j.scoped_by_repo.full_suite_by) : null;
  } catch { return null; }
}

/**
 * Las pruebas sin turno (`checks.tests === 'sin-turno'`): el portón no corrió porque otra sesión tenía el turno de las
 * ejecuciones grandes. Frena el paso diciendo eso, sin llamarlo rojo: no hay prueba que arreglar, hay que esperar el
 * turno. La deuda no lo cubre: no es un rojo que se deja a propósito, es una medición que falta.
 */
function frenarSinTurno(marker, n) {
  if (!marker.checks || marker.checks.tests !== 'sin-turno') return;
  appendLog('gates.log', { name: 'tests-no-turn', status: 'blocked', story: marker.storyId || null, step: n });
  console.error(`marker.js complete-step ${n} BLOQUEADO — las pruebas no corrieron: el portón no tuvo el turno de las ejecuciones grandes.`);
  console.error('  No hay pruebas que fallaran: falta medirlas. Cuando la coordinadora te dé el turno, corré el portón:');
  console.error('    bash <skills>/tycon-pipeline/scripts/test-gate.sh <repo> <ruta de la story>');
  process.exit(1);
}

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

  // Declarar un control a mano es de `set-check`: acá el flag no hace nada, y cerrar el paso igual confundiría
  if (opts.includes('--force-manual') || opts.includes('--manual')) {
    console.error('marker.js complete-step: --force-manual y --manual no van acá: van en set-check, sobre el control');
    console.error('  (por ejemplo, marker.js set-check tests green --force-manual). Declararlo a mano lo decide la persona:');
    console.error('  no le dictes cómo; si pregunta cómo seguir, señalale la guía del freno (guides/safety-guard.md, regla ESC-C3).');
    process.exit(2);
  }

  // La corrida que espera a main no cierra «Correr las pruebas» ni «Preparar el pull request»: su rojo es de main.
  if (controles.has('tests') || controles.has('commit')) frenarEsperaMain(marker, n);

  // Saltear los mutantes va con su motivo, y sólo en el paso que corre las pruebas: se niega antes de pedir la firma
  const motivoSinMutantes = opts.includes('--no-mutation') ? optVal('--reason') : null;
  if (opts.includes('--no-mutation')) {
    if (!motivoSinMutantes || !motivoSinMutantes.trim() || motivoSinMutantes.startsWith('--')) {
      console.error('marker.js complete-step: --no-mutation va con su motivo: --reason "<por qué esta vez no se miden los mutantes>". No se escribió nada.');
      process.exit(2);
    }
    if (!controles.has('tests')) {
      console.error(`marker.js complete-step: --no-mutation sólo va en el paso que corre las pruebas («Correr las pruebas»); ${n} no las corre. No se escribió nada.`);
      process.exit(2);
    }
  }

  // El aviso de una parte del Arranque que falló sale en el resumen del cierre: queda a la vista hasta el final.
  if (controles.has('commit')) for (const l of STEPS_LIB.startWarningLines(marker)) console.error(`⚠️  ${l}`);
  // Cada prueba vieja que estaba en rojo y se editó llega al mensaje del commit con su razón (note-red-test).
  if (controles.has('commit')) {
    for (const l of require('./red-test-edit.js').renglonesParaElCommit(marker)) console.error(`📌 El mensaje de commit lleva esta línea: ${l}`);
  }

  // Un rojo esperado (`expect-red`) vale sólo en una ejecución en deuda: sin la deuda escrita es un rojo como cualquiera.
  if (controles.has('commit')) {
    const esperados = Object.entries(marker.checks || {}).filter(([, v]) => /^rojo-esperado/.test(String(v)));
    const enDeuda = !!marker.cierre && marker.cierre.estado === 'deuda';
    if (esperados.length && !enDeuda) {
      appendLog('gates.log', { name: 'expected-red', status: 'blocked', story: marker.storyId, checks: esperados.map(([k]) => k) });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${esperados.map(([k, v]) => `${k}=${v}`).join(', ')} sin una ejecución en deuda.`);
      console.error('  Un rojo esperado vale sólo con la historia cerrada como deuda (marker.js close-as-debt, con el permiso de la persona en la ventana de permiso).');
      process.exit(1);
    }
    for (const [k, v] of esperados) {
      appendLog('gates.log', { name: 'expected-red', status: 'accepted', story: marker.storyId, check: k, deuda: marker.cierre.deuda });
      console.error(`⚠️  ${k}: ${v} — aceptado por la deuda ${marker.cierre.deuda} (${((marker.expectedRed || {})[k] || {}).tests || []})`);
    }
    // Las pruebas sin turno tampoco llegan al commit, ni con la deuda: no es un rojo que se deja, es una medición que falta.
    frenarSinTurno(marker, n);
    // Un control en rojo común tampoco llega al commit sin la deuda: o se arregla, o se cierra como deuda con la frase.
    const rojos = Object.entries(marker.checks || {}).filter(([, v]) => /^red\b/.test(String(v)));
    if (rojos.length && !enDeuda) {
      appendLog('gates.log', { name: 'red-check', status: 'blocked', story: marker.storyId, checks: rojos.map(([k]) => k) });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${rojos.map(([k, v]) => `${k}=${v}`).join(', ')} sin una ejecución en deuda.`);
      if (rojos.some(([k]) => k === 'tests')) {
        const fallas = pruebasQueFallan(marker.repoPath);
        if (fallas) console.error(`  Fallan: ${fallas}.`);
        console.error('  Arreglalas (el código o la prueba) y volvé a medir con test-gate.sh <repo> <ruta de la story>.');
      } else {
        console.error('  Arreglalo y volvé a correr el control.');
      }
      console.error('  Si la historia no se puede terminar, cerrarla como deuda (marker.js close-as-debt) lo decide la persona, en la ventana de permiso.');
      process.exit(1);
    }
    for (const [k, v] of rojos) {
      appendLog('gates.log', { name: 'red-check', status: 'accepted', story: marker.storyId, check: k, deuda: marker.cierre.deuda });
      console.error(`⚠️  ${k}: ${v} — aceptado por la deuda ${marker.cierre.deuda}`);
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

  // ── «Armar el plan» de una historia con código no cierra sin lo que da por cierto del código ──
  // La sección «## Suposiciones sobre el código», cada renglón con su archivo:línea comprobado en el repo
  // (plan-assumptions.js). Sin plan escrito no se mira acá: eso lo dice «Aprobar el plan».
  if (nuevo && ids.includes('plan')) {
    const plan = planDeLaCorrida(marker);
    let texto = null;
    try { texto = plan.file ? fs.readFileSync(plan.file, 'utf8') : null; } catch (_) { texto = null; }
    if (texto && texto.trim()) {
      const repo = marker.repoPath || process.cwd();
      // los hermanos de la ejecución: la historia del repo de historias cita el código del repo hermano
      let raices = [];
      try {
        const cr = require('./companion-repos.js');
        const story = resolveStoryPath(marker.storyPath, marker) || undefined;
        raices = [...(story ? [cr.gitRootOf(story)] : []), ...cr.companionRoots(repo, story)].filter(Boolean);
      } catch (_) { raices = []; }
      const r = require('./plan-assumptions.js').revisar(texto, { repo, raices });
      if (r.problemas.length) {
        appendLog('gates.log', { name: 'plan-assumptions', status: 'blocked', story: marker.storyId, problemas: r.problemas.length });
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${r.problemas[0]}`);
        for (const p of r.problemas.slice(1, 6)) console.error(`  · ${p}`);
        if (r.problemas.length > 6) console.error(`  · y ${r.problemas.length - 6} más`);
        console.error(`  El plan: ${plan.file}`);
        process.exit(2);
      }
    }
  }

  // ── «Preparar el pull request» no cierra con código sin revisar ──
  // Un cambio de código posterior al último cierre de los revisores (la regla de `next`, lib/steps.js) pide otra vuelta
  // antes: lo que se commitea es lo revisado. Una prueba o un texto no la piden. `--out-of-order` no lo saltea: no es
  // el orden, es lo que se commitea. Con Hallazgos abierto también frena: `next` espera a que cierre, este paso no.
  // ── con el plan aprobado por la coordinadora, el diff entero se vuelve a medir al cerrar ──
  if (nuevo && ids.includes('prepare-commit')) {
    const cierre = require('./batch-scope.js').frenoDelCierre({ markerPath: markerFilePath(estado.SID), estado: STATE_DIR, sid: estado.SID });
    if (cierre) { console.error(`marker.js complete-step ${n} BLOQUEADO — ${cierre.texto.replace(/^🔒 cierre: /, '')}`); process.exit(2); }
  }
  if (nuevo && ids.includes('prepare-commit')) {
    const vuelta = STEPS_LIB.reviewersRound(marker, { aunConHallazgos: true });
    if (vuelta) {
      const nombres = vuelta.archivos.slice(0, 5).join(', ') + (vuelta.archivos.length > 5 ? ` y ${vuelta.archivos.length - 5} más` : '');
      appendLog('gates.log', { name: 'unreviewed-code', status: 'blocked', story: marker.storyId, step: n, files: vuelta.archivos.length, round: vuelta.round });
      console.error(`marker.js complete-step ${n} BLOQUEADO — cambió código después de los revisores: ${nombres}.`);
      console.error('  Corré los revisores sobre lo cambiado (`pipeline.js next` dice cómo) y volvé a cerrar.');
      process.exit(2);
    }
    // Y lo que se guarda es lo revisado: el sello de la última vuelta contra el de ahora (historia 8.161). Convive con
    // el de arriba, que decide con los eventos de edición; éste decide con el sello.
    comprobarLoRevisado(marker, `complete-step ${n}`);
  }

  // ── «Aprobar el plan» — lo aprueba una persona, o la revisión automática en un plan de rutina ──
  // `--approved "<cita>"` en la ventana o `--terminal`. Por la delegación del perfil (la coordinadora, para otra
  // sesión), sólo con el veredicto «aprobado» de la revisión que ella lanzó sobre este mismo plan; sin `--approved`, con
  // el de la revisión que lanzó la propia sesión. Nunca el de una story delicada, ni con `routine_approval: person`
  // (lib/plan-review.js). Sin aprobación de nadie, cerrar el paso sería un comando vacío y el portón de carril (código
  // antes del plan) se abría sin que nadie hubiera aprobado nada.
  if (controles.has('plan')) {
    const approved = citaDe(optVal('--approved'));
    // el dueño lo aprueba en su terminal: la cita es esa firma
    const enTerminal = opts.includes('--terminal');
    // ── --replace-delegated: el plan (y su maqueta) que se aprobaron sin persona los vuelve a aprobar el dueño ──
    // Sólo con su click o su «aprobado» a este pedido, o en su terminal (`soloLaPersona`, el control previo de la firma);
    // con cualquier otra vía sale sin escribir nada. Guarda la firma que reemplazó y no mueve la hora del paso.
    const reemplaza = opts.includes('--replace-delegated');
    const planPrevia = marker.planApproval || null;
    const maquetaPrevia = marker.mockupApproval || null;
    if (reemplaza) {
      const motivo = !STEPS_LIB.isDone(marker, 'approve-plan') || !planPrevia ? 'no hay un plan aprobado que reemplazar'
        : !hechaSinPersona(planPrevia) ? `el plan ya lo aprobó una persona (${planPrevia.via || planPrevia.mode}): no hay una firma por delegación que reemplazar`
          : !approved && !enTerminal ? 'falta la aprobación de una persona: --approved "<su cita>", con su click o su «aprobado» a este pedido, o --terminal'
            : null;
      if (motivo) {
        appendLog('gates.log', { name: 'approval-replaced', status: 'blocked', story: marker.storyId, que: 'plan', motivo });
        console.error(`marker.js complete-step ${n} BLOQUEADO — --replace-delegated: ${motivo}. No se escribió nada.`);
        process.exit(1);
      }
    }
    if (opts.includes('--auto-approved')) {
      appendLog('gates.log', { name: 'plan-auto-approve', status: 'blocked', story: marker.storyId, motivo: 'ya no existe' });
      console.error(`marker.js complete-step ${n} BLOQUEADO — --auto-approved no aprueba: un plan de rutina lo aprueba el «aprobado» de su revisión automática (con o sin coordinadora); uno delicado, una persona.`);
      console.error(`  Mostrale el plan a la persona y cerrá con --approved "<su respuesta>". Ver steps/${STEPS_LIB.byId('approve-plan').file}.`);
      process.exit(2);
    }
    // ── Sin --approved: un plan de rutina se aprueba con el «aprobado» de la revisión que lanzó la propia sesión ──
    // (lib/plan-review.js antesDeAprobar, con la propia sesión como firmante y destino: la misma corrida, la misma huella
    // del plan, de la story y de la parte, no delicada, `routine_approval: review`). Sin delegación del perfil: sin
    // coordinadora no hay a quién delegar. Una historia con pantalla no: la maqueta la ve una persona.
    let autoRevision = null;
    let sinRevision = null;
    if (!approved && !enTerminal && !(PEDIDA && PEDIDA !== PROPIA)) {
      let r;
      try { r = require('./plan-review.js').antesDeAprobar({ estado: STATE_DIR, firmante: estado.SID, destino: estado.SID, marker }); } catch (e) { r = { codigo: 2, motivo: `no pude comprobar la revisión (${String((e && e.message) || e).split('\n')[0]})` }; }
      if (!r.codigo) {
        let pantalla;
        try { pantalla = require('../mockup.js').screenStory(resolveStoryPath(marker.storyPath, marker) || marker.storyPath).screen; } catch (_e) { pantalla = true; }
        if (pantalla) sinRevision = 'la historia tiene pantalla: la maqueta la aprueba una persona (--approved y --mockup-approved)';
        else autoRevision = r.constancia;
      } else sinRevision = r.motivo;
    }
    if (!approved && !enTerminal && !autoRevision) {
      console.error(`marker.js complete-step ${n} BLOQUEADO — falta la aprobación del plan.`);
      if (sinRevision) console.error(`  No se aprueba sin click: ${sinRevision}`);
      console.error(`  marker.js complete-step ${n} --approved "<cita textual de la aprobación del user>"`);
      console.error(`  No se aprueba el plan sin decir QUIÉN aprobó. Ver steps/${STEPS_LIB.byId('approve-plan').file}.`);
      process.exit(1);
    }
    // ── En una story con pantalla, la maqueta y su aprobación (también con LOW) ──
    // La detección es la de la revisión de la pantalla (mockup.screenStory, raíz del repo de la STORY), no la de
    // markerStoryIsUi. «No pude leer la story» frena: nunca es «sin pantalla». Nada se escribe hasta el final.
    const mockupCita = citaDe(optVal('--mockup-approved')) || (enTerminal ? 'firmado en la terminal' : null);
    const mk = require('../mockup.js');
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
          `Armala: node ${path.join(SCRIPTS_DIR, 'mockup.js')} render --data <modelo.json> --story ${sc.story}   (la forma: mockup.js schema)`,
          'Mostrásela a la persona que aprueba con el plan (la ruta y la lista de mockup.js texts) y cerrá con --mockup-approved "<cita>". Ver la guía del paso «Aprobar el plan».',
        ]);
      }
      const v = mk.validateMockupHtml(html);
      if (!v.ok) bloquear3(`la maqueta no pasa mockup.js check (${p.mockup}):`, v.findings.map((x) => `- ${x.line ? `línea ${x.line}: ` : ''}${x.what}`));
      // la maqueta se mira con un navegador antes de pedir su aprobación: lo que se pisa, desborda o parte una palabra frena
      const shots = require('./mockup-shots.js');
      const mirada = shots.problemaDeLaRevision({ mockupPath: p.mockup, html, mockupJs: path.join(SCRIPTS_DIR, 'mockup.js') });
      if (mirada) bloquear3(mirada.motivo, mirada.extra);
      if (!mockupCita) {
        const capturas = Object.values(shots.shotsPaths(p.mockup).shots);
        bloquear3(`story con pantalla: mostrale la maqueta (${p.mockup}) y pasá su aprobación con --mockup-approved`, [
          `Mandale a la persona que aprueba —o a quien tenga su delegación— las dos capturas a la conversación, no sólo la ruta: ${capturas.join(' · ')}`,
          `La maqueta entera: ${p.mockup}. Cerrá con --mockup-approved "<cita: quién aprobó y por qué vía>".`,
        ]);
      }
      mockupPlan = { p, sha: mk.mockupHash(html) };
    }
    // Con riesgo bajo el plan queda escrito en la corrida: un ok a una pregunta que no lo traía no aprueba (medido: el
    // agente preguntó «¿lo apruebo?» a secas y la persona aprobó sin verlo). Sin conversación legible no hay cómo saber:
    // la cita alcanza, como antes. Con riesgo normal no cambia. Devuelve el motivo para no firmar, o null.
    // `porElCuadro`: la aprobación llegó, o todavía puede llegar, por el click en el cuadro de la firma
    const sinVerElPlan = (porElCuadro) => {
      if (!approved) return null;
      const plan = planDeLaCorrida(marker);
      let planTxt = '';
      if (!plan.error) {
        try { planTxt = fs.readFileSync(plan.file, 'utf8'); } catch (e) {
          // sin plan escrito no hay qué comparar: la cita alcanza, como antes; una lectura que falla por otra cosa queda anotada
          if (e.code !== 'ENOENT') appendLog('gates.log', { name: 'plan-approval', status: 'skipped', story: marker.storyId, motivo: 'no pude leer el plan', error: String(e.code || e.message).slice(0, 200) });
        }
      }
      const visto = planTxt.trim() ? planVisto(marker, planTxt, { porElCuadro }) : null;
      if (!visto || !visto.legible || visto.mostrado) return null;
      let rc = null;
      try { rc = require('../pipeline.js').computeRiskClass({ story: resolveStoryPath(marker.storyPath, marker) }); } catch (e) { rc = { error: e.message }; }
      if (!rc || !rc.risk || rc.error) {
        // sin el riesgo no se sabe si este control aplica: no frena, pero queda anotado y se dice
        appendLog('gates.log', { name: 'plan-approval', status: 'skipped', story: marker.storyId, motivo: 'no pude calcular el riesgo', error: String((rc && rc.error) || 'sin riesgo').slice(0, 200) });
        console.error(`⚠️  no pude calcular el riesgo de la story (${(rc && rc.error) || 'sin riesgo'}): no comprobé que la persona haya visto el plan.`);
      }
      if (!rc || rc.risk !== 'LOW') return null;
      appendLog('gates.log', { name: 'plan-approval', status: 'blocked', story: marker.storyId, motivo: 'ok sin plan a la vista' });
      planParaLaPersona(planTxt);
      return `complete-step ${n} BLOQUEADO — la persona aprobó sin ver el plan: ninguno de tus mensajes ni tus preguntas lo trae. Mostráselo entero (en un mensaje o dentro de la pregunta), preguntale de nuevo y cerrá con --approved "<su respuesta>".`;
    };
    // en la propia sesión, antes de pedir nada (como siempre); para otra sesión, con el pedido a la vista: por la
    // delegación no hay persona que mire, y lo que cuenta es la revisión automática
    const paraOtra = !!(PEDIDA && PEDIDA !== PROPIA);
    // sin la vía todavía: un click en el cuadro puede llegar (con la terminal, no). La vía se mira antes de firmar
    if (!paraOtra) {
      const m = sinVerElPlan(!process.argv.includes('--terminal'));
      if (m) { console.error(`marker.js ${m}`); process.exit(1); }
      // pedir la aprobación cierra el plan: qué toca con su revisión según la matriz (se dice; no frena la firma)
      try {
        const a = require('./plan-review.js').accionDelPlan({ estado: STATE_DIR, sesion: estado.SID, marker, home: os.homedir() });
        if (a && a.decision && !a.revisado) console.error(`ℹ️  revisión del plan: ${a.decision}${a.comando ? ` — ${a.comando}` : ''} (${a.reason})`);
      } catch (e) {
        // sin la matriz, la aprobación sigue como siempre; se dice que no se supo qué toca con la revisión
        console.error(`ℹ️  revisión del plan: no pude calcular qué toca (${String((e && e.message) || e).split('\n')[0]})`);
      }
    }
    let revision = autoRevision;
    // la revisión en rechazo que el dueño vence con su click, para el texto de la aprobación
    let rechazoVencido = null;
    const porLaRevision = antesDeLaRevision({ marker });
    const antesDelPlan = (via, registro) => {
      // un plan delicado con su revisión en rechazo lo aprueba sólo el dueño con su click en el cuadro, que lo ata a lo
      // que vio: ni la terminal, ni su «aprobado» escrito, ni la delegación. Antes de dar el cuadro el click todavía puede llegar
      const enContra = require('./plan-review.js').revisionEnContra({ estado: STATE_DIR, destino: estado.SID, marker });
      if (enContra) {
        const porElClick = registro ? registro.via === 'click' : !['terminal', 'delegacion', 'mensaje'].includes(via);
        if (!porElClick || !enContra.revision) return { codigo: enContra.codigo, motivo: `${enContra.motivo}. Sólo una persona puede aprobarlo igual, con su click en el cuadro` };
        rechazoVencido = enContra.revision;
      }
      if (via === 'delegacion') {
        const r = porLaRevision(via);
        if (r.codigo) return r;
        // por la revisión, el texto lo arma el arnés: un --approved propio podría atribuir una firma que nadie dio
        const propio = require('./plan-review.js').textoPropioPorLaRevision(approved);
        if (propio) return { codigo: 2, motivo: propio };
        revision = r.constancia;
        return { via: r.via, resumen: r.resumen };
      }
      // con la aprobación a la vista, sólo su click en el cuadro cuenta como ver el plan; sin ella (el chequeo previo del
      // freno, antes de dar el cuadro), el click todavía puede llegar
      const m = sinVerElPlan(registro ? registro.via === 'click' : via !== 'terminal');
      return m ? { codigo: 1, motivo: m } : null;
    };
    // lo que aprueba una persona (el plan y la maqueta) es una firma del dueño; por delegación, con la revisión
    // sin click, la firma es de la revisión de la propia sesión: su renglón -signed y el del registro común (via: review)
    const porLaPropia = () => {
      const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
      ow.firmar({ firma: 'plan-approval', via: 'revision', sesion: estado.SID, destino: estado.SID, anotar: anotarFirma,
        resumen: `plan de ${marker.storyId}: revisión ${autoRevision.id} ${autoRevision.veredicto} (${autoRevision.modelo}), lanzada por la propia sesión` });
      return { via: 'revision', constancia: { via: 'revision' } };
    };
    // lo que ya aprobó una persona para la huella de ahora (el plan, su maqueta) no lo reescribe una firma sin persona
    const loDeLaPersona = [
      ...(aprobadaPorPersona(planPrevia, huellaDelPlan(marker).sha, 'planSha') ? ['plan'] : []),
      ...(mockupPlan && aprobadaPorPersona(maquetaPrevia, mockupPlan.sha, 'sha256', planPrevia) ? ['maqueta'] : []),
    ];
    const noPisa = (via) => noPisaLaPersona(loDeLaPersona, via);
    if (autoRevision && noPisa('delegacion')) {
      appendLog('gates.log', { name: 'plan-approval', status: 'blocked', story: marker.storyId, motivo: 'ya lo aprobó una persona', que: loDeLaPersona });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${noPisa('delegacion').motivo}`);
      process.exit(2);
    }
    const antesDeFirmar = (via, registro) => noPisa(via) || (reemplaza ? soloLaPersona(via, registro) : null) || antesDelPlan(via, registro);
    const firmaPlan = autoRevision ? porLaPropia() : firmaDelDueno('plan-approval', `plan de ${marker.storyId}${approved ? `: ${approved}` : ''}`, { antes: antesDeFirmar });
    // lo comprobó el control previo; si igual llegara otra vía sin persona, lo de la persona no se reescribe
    if (loDeLaPersona.length && !conPersona(firmaPlan.via)) {
      appendLog('gates.log', { name: 'plan-approval', status: 'blocked', story: marker.storyId, motivo: 'ya lo aprobó una persona', que: loDeLaPersona, via: firmaPlan.via || null });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${noPisa('delegacion').motivo}`);
      process.exit(2);
    }
    // lo comprobó el control previo; si igual llegara otra vía, no se escribe una firma de persona sin ella
    if (reemplaza && !conPersona(firmaPlan.via)) {
      appendLog('gates.log', { name: 'approval-replaced', status: 'blocked', story: marker.storyId, que: 'plan', via: firmaPlan.via || null });
      console.error(`marker.js complete-step ${n} BLOQUEADO — --replace-delegated: la firma llegó por ${firmaPlan.via || 'otra vía'}, no de la persona. No se escribió nada.`);
      process.exit(2);
    }
    const at3 = nowIso();
    if (mockupPlan) {
      // El archivo de aprobación viaja con la story (va en el commit); la cita queda sólo en el marcador.
      try {
        mk.writeApproval({ approvalPath: mockupPlan.p.approval, mockupPath: mockupPlan.p.mockup, story: marker.storyId, sha256: mockupPlan.sha, approvedAt: at3 });
      } catch (e) { bloquear3(`no pude escribir la aprobación de la maqueta (${mockupPlan.p.approval}): ${e.code || e.message}`); }
    }
    const porRevision = !!revision;
    // por la revisión, el texto lo arma el arnés con quién la lanzó y su veredicto; por una persona, su cita
    const textoPlan = porRevision ? require('./plan-review.js').textoDeLaAprobacion(revision)
      : rechazoVencido ? `rechazo vencido por decisión de la persona, con su click en el cuadro: la revisión del ${rechazoVencido.ts || 'sin fecha'}`
        + `${rechazoVencido.sesion ? ` (lanzada por la sesión ${rechazoVencido.sesion})` : ''} dijo ${rechazoVencido.veredicto}`
      : (approved || 'firmado en la terminal');
    // la huella del plan aprobado: con ella, anotar la parte después no lo reabre si no cambió (set-batch)
    const planSha = huellaDelPlan(marker).sha;
    marker.planApproval = { mode: porRevision ? 'revision' : 'user', text: textoPlan, at: at3, ...(planSha ? { planSha } : {}),
      ...(porRevision ? { revision: { id: revision.id, veredicto: revision.veredicto, modelo: revision.modelo, lanzo: revision.lanzo } } : {}),
      // un plan delicado que aprobó la coordinadora por delegación (`plan-approval:delicada`): el cierre no lo reabre por delicado
      ...(porRevision && revision.delicate && revision.delicate.value === true ? { delicada: true } : {}), ...firmaPlan.constancia,
      ...(reemplaza ? { reemplaza: reemplazada(planPrevia) } : {}) };
    appendLog('gates.log', { name: 'plan-approval', status: 'ok', story: marker.storyId, mode: marker.planApproval.mode, text: marker.planApproval.text, ...firmaPlan.constancia });
    // `--approved` sin `--approved-by` ni `--delegated-by` queda automática «sin nombrar»; por la revisión, automática a
    // nombre de la revisión. La maqueta la aprueba quien aprobó el plan, en el mismo comando.
    // con su click, su «aprobado» o «firmo» en su terminal, aprobó la persona: a nombre del usuario de la máquina, porque
    // un nombre escrito en el comando no lo vio nadie. La vía la pone owner-window.js al firmar, no una opción del comando
    const delDueno = require('./approvals.js').deLaPersona(firmaPlan.via, process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona');
    // la revisión que lanzó la propia sesión no es una delegación de nadie: se anota como lo que es
    const quienPlan = autoRevision ? { tipo: 'automatica', quien: `revisión automática (${revision.modelo})` }
      // la firma de trámite la dio el arnés (automatic-signing.js): no hay coordinadora que nombrar
      : porRevision && firmaPlan.automatica ? { tipo: 'automatica', quien: `revisión automática (${revision.modelo})`, delegacion: 'arnés (firma de trámite)' }
      : porRevision ? { tipo: 'automatica', quien: `revisión automática (${revision.modelo})`, delegacion: `coordinadora (sesión ${PROPIA})` }
        : delDueno || quienDeLasOpciones(optVal);
    const viaPlan = autoRevision ? '· revisión automática de la propia sesión' : porRevision ? '· revisión automática' : reemplaza ? '--replace-delegated --approved' : '--approved';
    anotarAprobacion(marker, { que: 'plan', cuando: at3, via: `complete-step ${n} ${viaPlan}`, ...quienPlan, ...porDe(firmaPlan) });
    if (mockupPlan) {
      anotarAprobacion(marker, { que: 'maqueta', cuando: at3, via: `complete-step ${n} --mockup-approved`, ...quienDeLaMaqueta(firmaPlan, optVal), ...porDe(firmaPlan) });
    }
    // La decisión se anota SIEMPRE, para que «Preparar el pull request» vea una pantalla que apareció después del plan.
    marker.mockupDecision = { screen: sc.screen, signal: sc.signal || null, at: at3 };
    if (mockupPlan) {
      // `user` sólo con la vía de una persona (modoDeLaFirma); con la vía en la constancia
      marker.mockupApproval = { file: mockupPlan.p.mockup, sha256: mockupPlan.sha, mode: modoDeLaFirma(firmaPlan), text: mockupCita, at: at3, ...(firmaPlan.constancia || porDe(firmaPlan)),
        ...(reemplaza && maquetaPrevia ? { reemplaza: reemplazada(maquetaPrevia) } : {}) };
      appendLog('gates.log', { name: 'mockup-approval', status: 'ok', story: marker.storyId, sha256: mockupPlan.sha.slice(0, 12), reapproval: false });
    } else {
      if (mockupCita) console.error('ℹ️  la story no tiene pantalla: no hay maqueta que aprobar (--mockup-approved no se usa).');
      // La baja de pantalla por prosa (7.18), con la raíz del repo de la story: la misma detección que decidió acá.
      const linea = require(path.join(SCRIPTS_DIR, 'lib', 'ui-signal.js')).proseDropNotice(sc.detail);
      if (linea) console.error(linea);
    }
    // el reemplazo no vuelve a cerrar el paso: la aprobación cambia de firma; el paso y su hora quedan como estaban
    if (reemplaza) {
      appendLog('gates.log', { name: 'approval-replaced', status: 'ok', story: marker.storyId, que: mockupPlan ? 'plan y maqueta' : 'plan', via: firmaPlan.via, previous: planPrevia.via || planPrevia.mode || null });
      marker.lastTouch = nowIso();
      writeMarker(marker);
      syncSessionState(estado.SID);
      process.stdout.write(JSON.stringify(marker, null, 2));
      return;
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
      console.error(`    marker.js run-check advisors -- ${homeCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js')} check-count \\`);
      console.error('      --repo <repo> --story <story_path> --files <archivos modificados…>');
      console.error('  Set esperado vacío (mech-check sin advisors aplicables): check-count sale 0 con el expected:[] persistido.');
      console.error('  Una lista de revisores dada por vos (provenance trust-ran = self-report) NO alcanza. Declarar el control');
      console.error('  a mano lo decide la persona, no el agente: si quiere, lo firma en la ventana de permiso o en su terminal.');
      process.exit(1);
    }
  }

  // ── Implementar — freno ATDD: los tests se escriben ANTES del código ───────────────
  // Sin gate mecánico el ATDD es la regla que se saltea.
  // La evidencia NO es nueva: `marker.fileEvents` ya registra cada edición con `{path, ts}`. Detalle del calibrado (qué bloquea y qué sólo avisa, para no dar falsos
  // positivos con un refactor legítimo): `lib/atdd-order.js`.
  if (controles.has('atdd')) {
    const { computeAtddOrder, atddBlockMessage } = require('./atdd-order.js');
    // 🔴 Stories de dos repos: el código vive en un repo hermano declarado
    //    (`evidence.companion_repos`). Si se mira sólo el repo de la story, toda edición del hermano queda
    //    afuera y el portón dice «ningún fileEvent cae dentro del repo de la story»: no gatea nada. Cuentan también los hermanos.
    let raices = marker.repoPath;
    let hermanosError = null;
    if (marker.repoPath) {
      try {
        const companionLib = require('./companion-repos.js');
        const storyAbs = marker.storyPath ? path.resolve(marker.repoPath, marker.storyPath) : null;
        const faltan = [];
        raices = [marker.repoPath, ...companionLib.companionRoots(marker.repoPath, storyAbs, { onMissing: (nombre) => faltan.push(nombre) })];
        if (faltan.length) hermanosError = `declarados y no están en disco: ${faltan.join(', ')}`;
      } catch (e) { hermanosError = e.message; }
    }
    // un guion de medición del repo que la story no declara no es el primer código
    let declarados = [];
    const storyDeclarada = marker.storyPath ? path.resolve(marker.repoPath || '', marker.storyPath) : null;
    if (storyDeclarada) {
      let texto = null;
      try { texto = fs.readFileSync(storyDeclarada, 'utf8'); } catch (e) {
        // sin story legible, ningún guion de medición cuenta: se dice, para que la lista vacía no pase callada
        console.error(`⚠️  freno ATDD: no pude leer la historia (${storyDeclarada}: ${e.code || e.message}); cuento sin la lista de archivos declarados.`);
      }
      if (texto !== null) declarados = require('./run-size.js').declaredFiles(texto);
    }
    const r = computeAtddOrder(marker.fileEvents, raices, { declarados });
    if (hermanosError) {
      r.reason = `${r.reason} (repos hermanos: ${hermanosError}; esos no se miraron)`;
      console.error(`⚠️  freno ATDD: repos hermanos — ${hermanosError}; esos no se miraron.`);
    }
    // `--no-atdd` y la marca `atddBypass` (la del portón previo) son el mismo pedido, y saltean sólo con la firma del
    // dueño para esta ejecución (lib/atdd-skip.js): una firma cubre la ejecución entera. Se pide sólo si el freno frena.
    const pide = opts.includes('--no-atdd') || marker.atddBypass === true;
    let bypass = false;
    let pedido = null;
    if (r.verdict === 'blocked' && pide) {
      const d = require('./atdd-skip.js').decidir({ marker, pide, camino: opts.includes('--no-atdd') ? 'complete-step implement --no-atdd' : 'la marca atddBypass' });
      bypass = d.saltea;
      if (!bypass) pedido = d.texto;
    } else if (opts.includes('--no-atdd')) {
      console.error('ℹ️  --no-atdd no hizo falta: el freno de pruebas primero no frena esta ejecución.');
    }
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
      if (pedido) console.error(pedido);
      process.exit(1);
    }
    if (r.verdict === 'blocked' && bypass) {
      // El bypass NO es silencioso: queda en bypass.log con el detalle, igual que DOD_BYPASS.
      appendLog('bypass.log', { kind: 'ATDD_BYPASS', story: marker.storyId, firstTest: r.firstTest, firstImpl: r.firstImpl,
        reason: marker.atddBypassReason || motivoDe(opts) || null });
      console.error('⚠️  ATDD saltado con la firma de una persona (queda en bypass.log).');
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
      console.error('  No le dictes cómo: si pregunta cómo seguir, señalale la guía del freno (guides/safety-guard.md, regla ESC-C3).');
      process.exit(1);
    }

    // ── «Sin turno»: frena, sin llamarlo rojo ─────────────────────────────────────────────────
    frenarSinTurno(marker, n);

    // ── Registro vacío: el portón nunca anotó nada en esta corrida ───────────────────────────
    // Sin `checks.tests` no hay verde, ni rojo, ni «sin medir»: nadie corrió el portón, y cerrar el paso así lo daba
    // por hecho. Sólo con el marcador nuevo: el 4 viejo cerraba implementar y probar juntos.
    if (nuevo && ids.includes('run-tests') && (testsCheck === undefined || testsCheck === null || testsCheck === '')) {
      appendLog('gates.log', { name: 'tests-missing', status: 'blocked', story: marker.storyId || null, step: n });
      console.error(`marker.js complete-step ${n} BLOQUEADO — falta el verde del portón de pruebas: en esta corrida no corrió nunca.`);
      console.error('  Corré el portón, que corre las suites y anota el resultado:');
      console.error('    bash <skills>/tycon-pipeline/scripts/test-gate.sh <repo> <ruta de la story>');
      process.exit(1);
    }

    // ── «Sin acotar»: se acepta anunciándolo ──────────────────────────────────────────────────
    // La corrida del repo hermano no se pudo acotar a lo tocado y no corrió nada (salida 7 de test-gate.sh). Correr la
    // suite completa del hermano en la máquina del dev no es la salida: la cubre la CI del pedido, y queda escrito.
    if (testsCheck === 'sin-acotar') {
      appendLog('gates.log', {
        name: 'tests-unscoped', status: 'accepted', story: marker.storyId || null,
        reason: 'sin acotar: la cubre la CI del pedido; antes del merge hay que mirar que salga verde (esta máquina no lo comprueba)',
      });
      console.error('⚠️  la suite no se acotó (sin acotar: no se supo qué se tocó en el repo hermano, o ninguna suite lo lee):');
      console.error('   la cubre la CI del pedido: antes del merge, mirá que salga verde (esta máquina no lo comprueba). El motivo está en .advisors/tests-result.json.');
    }

    // ── Acotada por el repo: el verde es el de las suites que leen lo tocado, y se dice quién corre la completa ──
    if (testsCheck === 'green') {
      const acotada = portonAcotadoPorElRepo(marker.repoPath);
      if (acotada) console.error(`ℹ️  la suite completa la corre ${acotada}: el portón de esta máquina corrió sólo las suites que leen lo tocado.`);
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
    // `--no-mutation` pide la firma `escape:no-mutation` desde la fecha de corte de TYCON_MUTATION_CHECK en la lista
    // única de interruptores; antes, pasa avisando, y el renglón dice que lo decidió el agente. Se pide acá, justo antes
    // de saltear: el chequeo previo de la ventana recorre el mismo camino que el cierre.
    {
      const { runMutationGate } = require('./mutation-gate.js');
      let sinMutantes = null;
      if (opts.includes('--no-mutation')) {
        const ES = require('./controls-off.js').listaDeInterruptores();
        if (ES.antesDelCorte('TYCON_MUTATION_CHECK')) {
          console.error(`⚠️  --no-mutation: desde ${ES.corteDe('TYCON_MUTATION_CHECK')} esto pide la firma de una persona (escape:no-mutation); hasta entonces pasa, avisado y anotado.`);
          sinMutantes = { via: 'agente', motivo: motivoSinMutantes };
        } else {
          const f = firmaDelDueno('escape:no-mutation', `cerrar ${n} de ${marker.storyId || 'la historia'} sin el chequeo de mutantes: ${motivoSinMutantes}`);
          sinMutantes = { via: f.via || 'ventana', motivo: motivoSinMutantes };
        }
      }
      const g = runMutationGate({ marker, opts, appendLog, sinMutantes });
      if (g.block) process.exit(1);
    }
  }

  // ── Hallazgos y «Preparar el pull request» — un crítico lo decide una persona ──
  // Cada CRITICAL `waived` de findings.json tiene que tener su constancia (`waive-critical`, con el ok de una persona).
  // No hay exención automática «sin nombrar»: dejaría que el agente se eximiera solo. El 8 lo vuelve a mirar porque el 7 sólo corre con críticos y findings.json se puede
  // reescribir a mano después. No poder leer los hallazgos se dice (en el 7 siempre tienen que estar).
  // Hallazgos frena sin findings.json; Preparar el pull request lo vuelve a mirar (como hoy el 7 y el 8 del marcador viejo).
  if (controles.has('waivers')) {
    const cierraHallazgos = controles.has('findings-close');
    let rd = null;
    let motivo = null;
    try {
      const storyAbs78 = resolveStoryPath(marker.storyPath, marker) || undefined;
      rd = require('../pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, storyAbs78, { marker });
      if (!rd) motivo = 'no encontré la carpeta de la corrida';
    } catch (e) { motivo = `no pude calcular la carpeta de la corrida (${e.message || e})`; }
    // Un salteo firmado del pase (mark-adversarial-skipped o set-size liviana) se sostiene sólo si su constancia sigue
    // valiendo en el cierre.
    const skLib = require('./adversarial-skip.js');
    if (skLib.firmasDelSalteo(marker).length) {
      const noVale = rd ? skLib.reverificar({ marker, carpeta: rd }) : (motivo || 'no encontré la carpeta de la corrida');
      if (noVale) {
        appendLog('gates.log', { name: 'adversarial-skip-recheck', status: 'blocked', story: marker.storyId, step: n, error: noVale });
        console.error(`marker.js complete-step ${n} BLOQUEADO — el pase adversarial se salteó con una constancia que ya no vale: ${noVale}. Se lanza el pase, o una persona lo vuelve a firmar.`);
        process.exit(1);
      }
    }
    const cw = require('./critical-waivers.js');
    const v = rd ? cw.verificarExenciones(rd, { story: marker.storyId }) : { faltan: [], ilegibles: 0, existe: false };
    if (cierraHallazgos && !motivo && rd && !v.existe) motivo = 'falta findings.json (pipeline.js write-findings)';
    if (motivo) {
      // Hallazgos no se cierra sin hallazgos que mirar; Preparar el pull request lo dice y sigue (sin corrida que mirar lo
      // frenan sus propios portones)
      appendLog('gates.log', { name: 'critical-waivers', status: cierraHallazgos ? 'blocked' : 'not-checked', story: marker.storyId, step: n, error: motivo });
      if (cierraHallazgos) {
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${motivo}: Hallazgos no puede mirar si algún crítico quedó eximido sin el ok de una persona.`);
        process.exit(1);
      }
      console.error(`⚠️  complete-step ${n}: ${motivo}: no pude mirar si hay críticos eximidos sin el ok de una persona.`);
    }
    // un findings.json que está y no se lee frena: es justo el que se pudo reescribir a mano. En Preparar el pull request lo
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
      console.error('   Un crítico lo decide una persona: arreglalo, o que el dev lo exima. Los caminos:');
      for (const f of cw.agrupar(v.faltan)) for (const l of cw.caminos({ marker: MARKER_JS, ruleId: f.rule_id, file: f.file || '<archivo>' })) console.error(l);
      process.exit(1);
    }
    // Los críticos que reportó cada revisor, anotados por el arnés (lib/reported-criticals.js): findings.json se pudo
    // reescribir a mano después de write-findings, así que el cruce se repite acá, con los `refuted` vueltos a comprobar
    // contra la constancia del verificador (la misma función que write-findings).
    if (rd && v.existe && !v.error) {
      const rcLib = require('./reported-criticals.js');
      let lista = null;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(rd, 'findings.json'), 'utf8'));
        lista = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
      } catch (_e) { lista = null; }
      let roster = null;
      try { roster = JSON.parse(fs.readFileSync(path.join(rd, 'review-roster.json'), 'utf8')); } catch (_e) { roster = null; }
      const P = require('../pipeline.js');
      const refutedHolds = (f) => {
        try { return P.normalizeFindingRecord(f, [], { roster, errores: [], runDir: rd }).disposition === 'refuted'; } catch (_e) { return false; }
      };
      // sólo lo de esta corrida: lo que anotó otra sesión sobre la misma historia no se pide acá
      const cruce = lista ? rcLib.checkRun({ stateDir: STATE_DIR, story: marker.storyId, since: marker.startedAt || null, ...rcLib.corridaDelMarcador(marker, rd), findings: lista, runDir: rd, refutedHolds })
        : { error: 'findings.json no es una lista de hallazgos', problemas: [] };
      if (cruce.error) {
        appendLog('gates.log', { name: 'reported-criticals', status: 'blocked', story: marker.storyId, step: n, error: cruce.error });
        console.error(`marker.js complete-step ${n} BLOQUEADO — no pude cruzar findings.json con lo que reportaron los revisores (${cruce.error}): «no lo pude leer» no es «no hay críticos».`);
        process.exit(1);
      }
      if (cruce.problemas.length) {
        appendLog('gates.log', { name: 'reported-criticals', status: 'blocked', story: marker.storyId, step: n, problemas: cruce.problemas.map((p) => ({ tipo: p.tipo, rule: p.rule || null, advisor: p.advisor })) });
        console.error(`marker.js complete-step ${n} BLOQUEADO — findings.json no trae lo que reportaron los revisores:`);
        for (const l of rcLib.renglones(cruce, { marker: MARKER_JS })) console.error(l);
        process.exit(1);
      }
      if (cruce.sinRegistro) console.error(`ℹ️  complete-step ${n}: ${rcLib.NO_REGISTRY_NOTE}.`);
      if (cruce.unreadable) console.error(`⚠️  complete-step ${n}: el registro de críticos reportados tiene ${cruce.unreadable} renglón(es) ilegible(s): no cuentan.`);
      if (cruce.unreadableSpawns) console.error(`⚠️  complete-step ${n}: el registro de lanzamientos de revisores tiene ${cruce.unreadableSpawns} renglón(es) ilegible(s): esas salidas no se cruzaron.`);
      appendLog('gates.log', { name: 'reported-criticals', status: cruce.sinRegistro ? 'no-registry' : 'ok', story: marker.storyId, step: n });
    } else {
      // sin carpeta de la corrida o sin findings.json no hay con qué cruzar: se dice, no se calla
      const porque = !rd ? 'no encontré la carpeta de la corrida' : (v.error ? `no pude leer findings.json (${v.error})` : 'no hay findings.json');
      console.error(`ℹ️  complete-step ${n}: no crucé lo que reportaron los revisores: ${porque}.`);
      appendLog('gates.log', { name: 'reported-criticals', status: 'not-checked', story: marker.storyId, step: n, motivo: porque });
    }
  }

  // Gate de DoD — «Preparar el pull request». El orquestador puede llegar a
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
      const uc = require('./undeclared-changes.js');
      const registrados = [].concat(marker.filesTouched || [], (marker.fileEvents || []).map((e) => e && e.path)).filter(Boolean);
      const consola = uc.consoleWritesOf(STATE_DIR, estado.SID);
      const { readEnv } = require('./legacy-names.js');
      const r = uc.computeUndeclared({
        repo: marker.repoPath || null, baseSha: marker.baseSha || null, startedAt: marker.startedAt || null,
        // una historia que no se encuentra no es «nada declarado»: la ruta llega igual y el control dice que no la leyó
        storyPath: resolveStoryPath(marker.storyPath, marker) || marker.storyPath || null, registrados,
        consola: consola.lineas, consolaProblemas: consola.problemas, consolaApagada: readEnv('TYCON_NO_RUN_CHANGE', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '1',
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
    // La comparación con main (historia 8.167): cada comando existente que la historia modifica necesita un humo comparado
    // que lo cubra o una exención firmada, y una diferencia con main se declara en «Cambios de comportamiento». Va junto
    // al de cambios sin declarar y sale 1 como él; no vuelve a «Hallazgos» (sería un bucle de revisores). Sin candidatos,
    // nada: ni comparaciones ni renglón.
    {
      const storyAbs = resolveStoryPath(marker.storyPath, marker);
      let f = null;
      let noMedido = null;
      if (storyAbs) {
        try {
          const rdc = require('../pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, storyAbs, { marker });
          f = require('./compare-previous.js').freno({ storyPath: storyAbs, repos: reposParaComparar(marker), runDir: rdc, stateDir: STATE_DIR, story: marker.storyId, marker });
        } catch (e) { noMedido = String(e.message || e).split('\n')[0]; }
      } else {
        noMedido = `no encuentro la historia (${marker.storyPath || 'el marcador no la nombra'})`;
      }
      if (f && !f.medido) noMedido = f.motivo;
      if (noMedido) {
        // no poder mirarlo no es «no hay candidatos»: se dice y se anota
        console.error(`⚠️  complete-step ${n}: comparación con main: no medido (${noMedido}). No es «no hay nada que comparar»: es «no lo pude mirar».`);
        appendLog('gates.log', { name: 'compare-previous-gate', action: 'no-medido', story: marker.storyId || null, motivo: noMedido });
      } else if (f && (f.candidatos.length || (f.sinRepo || []).length)) {
        for (const a of f.avisos) console.error(`⚠️  complete-step ${n}: ${a}`);
        // lo que no se pudo mirar junto a los demás candidatos también queda en el renglón, no sólo en pantalla
        const noMedidos = (f.noMedidos || []).map((x) => ({ archivo: x.archivo, motivo: x.motivo }));
        if (f.bloquea) {
          appendLog('gates.log', { name: 'compare-previous-gate', action: 'bloqueo', story: marker.storyId || null,
            faltan: f.juicio.faltan.map((x) => x.archivo), noDeclaradas: f.juicio.noDeclaradas.map((x) => x.cmd), ...(noMedidos.length ? { noMedidos } : {}) });
          console.error(`marker.js complete-step ${n} BLOQUEADO — ${f.lineas[0]}`);
          for (const l of f.lineas.slice(1)) console.error(l.startsWith('comparación con main') ? `   ${l}` : l);
          process.exit(1);
        }
        for (const l of f.lineas) console.error(`   ${l.trim()}`);
        appendLog('gates.log', { name: 'compare-previous-gate', action: 'verde', story: marker.storyId || null, candidatos: f.candidatos.map((x) => x.archivo), avisos: f.juicio.avisos.length, ...(noMedidos.length ? { noMedidos } : {}) });
      }
    }
    // Un crítico de seguridad o de datos abierto o diferido no cierra callado: lo arregla una vuelta (extra, si se llegó al
    // tope, con el ok de una persona) o lo exime una persona (waive-critical). Venga del revisor o del pase adversarial.
    {
      const rr = require('./review-rounds.js');
      let rd8 = null;
      let noMirado = null;
      try { rd8 = require('../pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, resolveStoryPath(marker.storyPath, marker) || undefined, { marker }); } catch (e) { noMirado = `no pude calcular la carpeta de la corrida (${e.message || e})`; }
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
        if (rr.vueltaExtraDeTramite()) {
          // la vuelta extra la da el arnés: el cartel no puede decir que la aprueba una persona (fila 80)
          console.error('   Arreglarlo: si se llegó al tope, una vuelta más con pipeline.js smart-reloop --extra-round. Es una firma de');
          console.error('   trámite del perfil del equipo (approvals.delegated_signing): la da el arnés solo, sin ventana ni cuadro; no la');
          console.error('   firma una persona. O eximirlo: eso lo decide una persona (marker.js waive-critical, con su permiso a ese crítico).');
        } else {
          console.error('   Lo decide una persona: arreglarlo (si se llegó al tope, una vuelta más con pipeline.js smart-reloop --extra-round,');
          console.error('   que le pide el permiso en la ventana de permiso), o eximirlo (marker.js waive-critical, con su permiso a ese crítico).');
        }
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
    const maqueta = require('../mockup.js').mockupStep8(marker, resolveStoryPath(marker.storyPath, marker) || marker.storyPath);
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
    // que vive sólo en el markdown de la guía de «Preparar el pull request» dependen de que el orquestador se acuerde de correrlo:
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
        const { computeFindingsStatus } = require('../pipeline.js');
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
        console.error(`    ${homeCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js')} write-findings --story ${storyPathF} --findings -`);
        console.error('    (el array sale del reporte consolidado del paso de hallazgos, con la disposition final de cada hallazgo)');
        anotar('bloqueo', st.exists ? 'findings.json inválido' : 'findings.json ausente');
      }
    }
    // 🔴 El pase adversarial ATENDIDO. Lanzado → su resultado anotado después del último
    // lanzamiento; no lanzado → el salteo que decidió el portón. Sin este control, un pase cerrado sin
    // resultado pasa a «Preparar el pull request». Se evalúa SIEMPRE (no sólo si
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
    // 🔴 Las aprobaciones en el repo de la STORY, con la regla del portón de CI: se copian otra vez (pone al día una
    // corrida que anotó sólo en el repo del código) y lo que siga faltando frena acá, no en el merge. Con la maqueta
    // aprobada se exige además su línea, también con un solo repo. Como el del pase, se evalúa siempre y no se abre con
    // DOD_BYPASS: el arreglo siempre está a mano.
    let bloqueoAprobaciones = null;
    {
      const storyAbs = resolveStoryPath(marker.storyPath, marker);
      const codeRepo = marker.repoPath || process.cwd();
      let r = null;
      let error = null;
      try {
        const pl = require('../pipeline.js');
        const runDir = storyAbs ? pl.resolveRunDir(codeRepo, String(marker.storyId), false, storyAbs, { marker }) : null;
        r = pl.aprobacionesEnElRepoDeLaStory({ runDir, storyPath: storyAbs, storyId: String(marker.storyId), codeRepo, maquetaAprobada: !!marker.mockupApproval });
      } catch (e) { error = String(e.message || e).slice(0, 200); }
      if (error) {
        bloqueoAprobaciones = `no pude mirar las aprobaciones en el repo de la story (${error})`;
        appendLog('gates.log', { name: 'approvals-story-repo', status: 'blocked', story: marker.storyId || null, step: 8, error });
        console.error(`marker.js complete-step ${n} BLOQUEADO — ${bloqueoAprobaciones}. No es «están todas»: es «no lo pude mirar».`);
      } else if (!r.medido) {
        appendLog('gates.log', { name: 'approvals-story-repo', status: 'no-medido', story: marker.storyId || null, step: 8, motivo: r.motivo });
        console.error(`⚠️  complete-step ${n}: aprobaciones en el repo de la story: no medido (${r.motivo}). No es «están todas»: es «no lo pude mirar»; el portón de CI las mira en el merge.`);
      } else if (r.faltas.length) {
        bloqueoAprobaciones = r.faltas.map((f) => `${f.corrida}: ${f.regla}`).join(', ');
        appendLog('gates.log', { name: 'approvals-story-repo', status: 'blocked', story: marker.storyId || null, step: 8, faltas: r.faltas.map((f) => ({ corrida: f.corrida, regla: f.regla })) });
        console.error(`marker.js complete-step ${n} BLOQUEADO — aprobaciones en el repo de la story (${r.storyRepo}): el portón de CI frenaría el merge por esto.`);
        for (const f of r.faltas) console.error(`   · ${f.corrida}: ${f.regla} — ${f.detalle}`);
        // `approve-plan` anota en la corrida abierta: para una vieja, el arreglo es otro.
        if (r.faltas.some((f) => f.abierta)) {
          console.error('   En la corrida abierta, si se aprobó y no quedó anotado, se anota con la frase de quien aprobó:');
          console.error('     marker.js complete-step approve-plan --approved "<cita>" --out-of-order');
        }
        const viejas = [...new Set(r.faltas.filter((f) => !f.abierta).map((f) => f.corrida))];
        if (viejas.length) {
          console.error(`   En una corrida vieja (${viejas.join(', ')}), \`approve-plan\` no sirve: anota en la abierta. Si su plan se`);
          console.error('   aprobó, se trae su línea desde la carpeta del mismo nombre del repo del código.');
        }
        console.error('   Si la story se cerró sin pipeline, la exención de los revisores (`advisors_exempt`) la decide la persona, con su firma sobre la historia.');
      } else {
        appendLog('gates.log', { name: 'approvals-story-repo', status: 'ok', story: marker.storyId || null, step: 8, proyecciones: r.proyecciones.length });
      }
    }
    if (isUi) {
      const dodCheck = marker.checks && marker.checks.dod;
      const dodProv = marker.checksProvenance && marker.checksProvenance.dod;
      const okUi = dodCheck === 'green' && (dodProv === 'run-check' || dodProv === 'manual-forced');
      // La prueba con navegador que la persona dejó pendiente (lib/browser-test.js): sólo con las dos marcas, la de la
      // historia y la constancia que escribió e2e-setup.js en gates.log. Se dice siempre.
      const bt = require('./browser-test.js');
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
        console.error('    (lo firma en la ventana de permiso o en su terminal; queda manual-forced en gates.log).');
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
      console.error('  (b) Story exenta (sin UI ni endpoints — «Probar en vivo»): eximirla lo decide la');
      console.error('      persona, con dod_runtime_exempt_reason en el frontmatter. La firma:');
      for (const l of formasDeFirmarArchivo('dod_runtime_exempt', resolveStoryPath(marker.storyPath, marker) || null, estado.SID)) console.error(`        · ${l}`);
      console.error('      Después:');
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
          // en una historia paraguas, la tanda que anotó `set-batch`, con la lista de lo que cambió el repo del código
          // desde el arranque: la matriz mide sus criterios y los de las tandas que la corrida tocó
          const rmx = require('../runtime-matrix.js');
          matrix = rmx.compute({ storyPath, ...rmx.opcionesDeTandaDelMarcador({ ...marker, storyPath }, storyPath) });
        } catch (e) {
          blocked = 'acmatrix-error';
          console.error(`marker.js complete-step ${n} BLOQUEADO — la matriz runtime no computó (fail-closed): ${e.message}`);
        }
        if (matrix && matrix.batch) {
          console.error(`marker.js complete-step ${n}: la matriz mide la tanda ${matrix.batch}${matrix.fueraDeTanda.length ? `; fuera de esta tanda: ${matrix.fueraDeTanda.join(' · ')}` : ''}${(matrix.returnedBy || []).length ? `; vuelven a la matriz: ${matrix.returnedBy.join(' · ')}` : ''}. Pasar la historia a review las pide todas.`);
        } else if (matrix && marker.batch && !matrix.structuralError) {
          const sinLista = (matrix.warnings || []).find((w) => /sin la lista de cambios de la corrida no achico/.test(w));
          if (sinLista) console.error(`marker.js complete-step ${n}: ${sinLista}`);
        }
        // en una ejecución en deuda con el rojo esperado de la matriz: los criterios sin correr que cubre su lista llegan al
        // commit, con su fecha; todo lo demás frena como siempre (la matriz se recalcula igual, nunca se lee el control)
        const deudaEnVivo = matrix && !matrix.structuralError && !matrix.green ? deudaDeLaMatriz(marker, matrix) : null;
        if (matrix && matrix.structuralError) {
          blocked = 'acmatrix-struct';
          console.error(`marker.js complete-step ${n} BLOQUEADO — matriz runtime no computable: ${matrix.structuralError}`);
        } else if (deudaEnVivo && deudaEnVivo.acepta) {
          const acs = deudaEnVivo.acs.join(', ');
          // el renglón es lo único que hace hablar al aviso de la deuda vencida: sin él, la deuda no se acepta. Lleva
          // dónde vive la historia en su repo, para encontrarla cuando esta carpeta de trabajo ya no esté
          try {
            appendLog('gates.log', { name: 'acmatrix-debt', story: nn(marker.storyId, null), storyPath, ...dondeViveLaHistoria(storyPath), deuda: marker.cierre.deuda, acs: deudaEnVivo.acs, tests: deudaEnVivo.tests, until: deudaEnVivo.until }, { estricto: true });
            console.error(`⚠️  matriz (DODRT-C6): AC ${acs} sin evidencia en vivo — aceptados por la deuda ${marker.cierre.deuda}, vence ${deudaEnVivo.until}`);
            console.error(`📌 El mensaje de commit lleva esta línea: Sin evidencia en vivo: AC ${acs} — deuda ${marker.cierre.deuda}, vence ${deudaEnVivo.until}`);
            // lo aceptado por la deuda cuenta como la matriz verde para pasar a done, con la deuda nombrada
            appendLog('gates.log', { name: 'acmatrix-green', story: nn(marker.storyId, null), storyPath: path.resolve(storyPath), ...dondeViveLaHistoria(storyPath), deuda: marker.cierre.deuda, ...(matrix.batch ? { batch: matrix.batch } : {}) });
          } catch (e) {
            blocked = 'acmatrix-debt-log';
            console.error(`marker.js complete-step ${n} BLOQUEADO — no pude anotar la deuda de evidencia en vivo en gates.log (${e.code || e.message}): sin ese renglón nadie avisa cuando venza. Revisá la carpeta de estado y reintentá.`);
          }
        } else if (matrix && matrix.green) {
          // la constancia de la matriz verde: con ella, la historia puede pasar a done fuera de la corrida en esta máquina
          appendLog('gates.log', { name: 'acmatrix-green', story: nn(marker.storyId, null), storyPath: path.resolve(storyPath), ...dondeViveLaHistoria(storyPath), ...(matrix.batch ? { batch: matrix.batch } : {}) });
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
            // con tanda anotada, la firma nombra la sesión: así la terminal mide la misma tanda que esta matriz
            console.error(`     ${signatureCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js')} runtime-waiver ${storyPath}${matrix.batch && estado.SID !== '_nosession' ? ` --for-session ${estado.SID}` : ''}`);
          }
          // los criterios con cota: lo medido y la cota de cada uno, y las tres salidas
          for (const l of require('../runtime-matrix.js').lineasDeMedida(matrix)) console.error(`  ${l}`);
          // La firma que existe pero se descartó se DICE: sin esto, «esperan waiver» parece que el dev no firmó.
          for (const l of require('../runtime-matrix.js').avisoFirmasDescartadas(matrix, storyPath)) console.error(`  ${l}`);
          if (matrix.chainOk === false) console.error('  🚨 hay líneas de esta story descartadas por la cadena del registro de firmas — causa probable: una edición a mano.');
          // en deuda con el rojo esperado de la matriz: lo que la deuda no acepta, dicho
          if (deudaEnVivo) for (const l of deudaEnVivo.motivos) console.error(`  ${l}`);
        }
      }
    }
    // DODRT-C7 — para una story de UI, la GUÍA DE PRUEBA MANUAL del
    // tester tiene que estar lista: pasos en criollo, que cubran los ACs corridos, SIN jerga de
    // software (determinístico), y con la review de legibilidad independiente "veredicto: OK".
    // qa-guide.js --check chequea los 4 y sale !=0 si falta algo.
    const qaStoryPath = resolveStoryPath(marker.storyPath, marker);
    // Con la maqueta aprobada también corre aunque la story no tenga pantalla (la revisión sí ve
    // pantalla), y le pasa la huella aprobada: borrar el archivo de aprobación no saltea la comparación.
    // Mira la story entera: con la pantalla en una tanda bloqueada, la guía de backend se sigue pidiendo.
    if (!blocked && (markerStoryHasScreens(marker) || (marker.mockupApproval && maqueta.compare)) && qaStoryPath) {
      try {
        require('child_process').execFileSync(
          'node',
          require('../mockup.js').qaGuideCheckArgs(qaStoryPath, marker),
          { windowsHide: true, stdio: 'inherit' },
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
        const esPantalla = markerStoryHasScreens(marker) || !!(marker.mockupApproval && maqueta.compare);
        const rdMc = require('../pipeline.js').resolveRunDir(marker.repoPath || process.cwd(), String(marker.storyId), false, qaStoryPath, { marker });
        const f = require('./manual-checks.js').freno({ storyPath: qaStoryPath, storyId: String(marker.storyId), runDir: rdMc, stateDir: STATE_DIR, esPantalla });
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
    if (bloqueoAprobaciones) {
      console.error('');
      console.error('  🔒 El bloqueo de las aprobaciones no se abre con DOD_BYPASS: sin ellas el portón de CI frena el merge igual.');
      process.exit(2);
    }
    if (blocked) {
      // 🔴 Los bloqueos de la matriz runtime (acmatrix*) y de la guía de tester (qaguide) NO tienen
      // bypass por env var: DOD_BYPASS lo puede setear el agente, y el agente no puede saltear ni la
      // verificación runtime ni dejar la guía sin criollo. Los bloqueos
      // legacy (ui / non-ui) mantienen su escape DOD_BYPASS.
      if (String(blocked).startsWith('acmatrix') || blocked === 'qaguide' || blocked === 'manualcheck') {
        console.error('');
        console.error('  🔒 Este bloqueo NO tiene bypass para el agente (ni DOD_BYPASS ni --no-verify lo saltean limpiamente).');
        // cada bloqueo dice su salida: la exención por terminal existe sólo para la matriz
        if (String(blocked).startsWith('acmatrix')) console.error('     La verificación runtime es obligatoria: la única salida es el waiver TTY del usuario.');
        else if (blocked === 'qaguide') console.error('     La salida es lo que dice la guía de tester, arriba: corregí la pantalla, o actualizá la maqueta y pedí que la aprueben de nuevo, o declará la diferencia con una línea `- «texto» — differs: <por qué>` en la revisión de la pantalla.');
        else console.error('     La salida es la marca a mano de una persona, arriba dice cuál falta.');
        process.exit(2);
      }
      console.error('  Saltear este bloqueo lo decide la persona, no el agente: si quiere, lo firma en la ventana de');
      console.error('  permiso o en su terminal; queda had_dod_bypass=true en bypass.log.');
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

  // La foto del pedido: lo que sale hacia el equipo (el pedido, el empuje a una rama compartida) tiene que ser lo de esta
  // foto (lib/save-brake.js), y el ok de guardar por delegación exige lo mismo. Antes de tomarla corren los controles del
  // commit en sólo lectura: un pre-commit que regeneraría un archivo y lo sumaría al commit la vencería después, sin que
  // nadie tocara nada. La foto anterior sale primero: un re-cierre que falla no deja la vieja para comparar. En un
  // marcador del esquema viejo el paso se cierra con su número (el 8): también toma la foto.
  if (STEPS_LIB.closesStep(marker, ids, 'prepare-commit')) {
    delete marker.prepareCommitHuellas;
    const so = require('./save-ok.js');
    let foto;
    try {
      const repos = so.reposDeLaCorrida({ marker, hermanos: hermanosDeLaCorrida(marker) });
      // con la historia, los controles del privado encuentran el público de la rama que la nombra (save-ok.js)
      foto = repos.length ? so.fotoDelPedido({ repos, story: resolveStoryPath(marker.storyPath, marker) || null }) : { codigo: 2, motivo: 'no pude ubicar los repos de la corrida para la foto del pull request (ninguno)' };
    } catch (e) {
      foto = { codigo: 2, motivo: `no pude ubicar los repos de la corrida para la foto del pull request (${e.message})` };
    }
    if (foto.codigo) {
      // lo único que queda escrito es que ya no hay foto: el resto del cierre no pasó. Sin foto el pull request no sale,
      // así que el paso tampoco cierra
      const enDisco = readMarker();
      if (enDisco && enDisco.prepareCommitHuellas) { delete enDisco.prepareCommitHuellas; writeMarker(enDisco); }
      else if (!enDisco) console.error('⚠️  complete-step prepare-commit: no pude leer el marcador para sacar la foto anterior.');
      appendLog('gates.log', { name: 'prepare-commit-controls', status: 'blocked', story: marker.storyId || null, motivo: String(foto.motivo).slice(0, 300) });
      console.error(`marker.js complete-step ${n} BLOQUEADO — ${foto.motivo}`);
      process.exit(2);
    }
    marker.prepareCommitHuellas = foto.huellas;
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
  anotarOtraVuelta(marker);
  marker.lastTouch = nowIso();
  writeMarker(conHoraDelPaso(marker));
  syncSessionState(estado.SID);
  process.stdout.write(JSON.stringify(marker, null, 2));
  if (nuevo) decirRenglonDelPaso(marker, paso);
  avisarContextoAlCerrar(ids);
}

// Al cerrar un paso pesado con la sesión sobre el umbral de contexto, que es el momento de compactar o de abrir una
// sesión nueva (scripts/hooks/context-size-notice.js). Avisa, nunca frena.
function avisarContextoAlCerrar(ids) {
  try {
    const aviso = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'hooks', 'context-size-notice.js'))
      .avisoAlCerrarPaso({ pasos: ids, sessionId: estado.SID, home: os.homedir() });
    if (aviso) process.stderr.write(`${aviso}\n`);
  } catch (e) { process.stderr.write(`🧠 contexto: no pude medir la sesión al cerrar el paso (${e.message})\n`); }
}

// ¿La story tiene pantalla, aunque sea de una tanda bloqueada? Decide el disparo de la guía del tester y la marca a
// mano: la guía de los criterios de backend se sigue pidiendo.
function markerStoryHasScreens(marker) {
  return markerScreenRule(marker, {});
}

/** El renglón del paso recién cerrado, último por la salida de errores (la estándar es el marcador en JSON). */
function decirRenglonDelPaso(marker, paso) {
  try {
    const l = require('./run-lines.js').stepLine({ marker, stateDir: STATE_DIR }, paso);
    if (l) process.stderr.write(`[paso] ${l}\n`);
  } catch (e) { process.stderr.write(`[paso] no pude armar el renglón del paso (${e.message})\n`); }
}

module.exports = {
  pruebasQueFallan, portonAcotadoPorElRepo, frenarSinTurno, cmdCompleteStep, avisarContextoAlCerrar,
  markerStoryHasScreens, decirRenglonDelPaso,
};
