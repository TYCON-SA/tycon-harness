/**
 * marker-steps.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: los pasos, la tanda, el tamaño, la foto de la vuelta, la maqueta y el estado de la historia (todo menos cerrar un paso).
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  MARKER_JS, PASO_ARRANCABLE, PREVIO, PROPIA, SCRIPTS_DIR, STATE_DIR, STEPS_LIB,
  VALID_PIPELINE_STATUSES, VALID_STATUSES, anotarAprobacion, anotarArranque,
  anotarSalteoEnElRegistro, antesDeLaRevision, appendLog, at,
  carpetaDeLaCorrida, conHoraDelPaso, dondeViveLaHistoria, estado,
  firmaDelDueno, formasDeFirmarArchivo, fs, huellaDelPlan, nn, nowIso, os,
  ownerWindow, path, porDe, quienDeLasOpciones, quitarSalteoDelRegistro,
  readMarker, readOwnMarkerRaw, resolveStoryPath, sellosDe, syncSessionState,
  trabajarSobreElDestino, vueltaCongeladaComprobada, writeMarker,
  citaDe, conPersona, hechaSinPersona, modoDeLaFirma, quienDeLaMaqueta, reemplazada, soloLaPersona,
} = require('./marker-shared.js');
const frenarEstadoSiEsperaMain = (...a) => require('./marker-lifecycle.js').frenarEstadoSiEsperaMain(...a);

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
  // el sello de la vuelta es el de su lanzamiento: la foto lo copia, nunca lo recalcula sobre la carpeta viva
  const congelada = vueltaCongeladaComprobada('revisores', 'snapshot-iter');
  marker.iterations = marker.iterations || {};
  // Los probes transitorios del pase adversarial NO entran a la foto: son archivos `__probe*`/`_probe_*`
  // que nadie escribió y se borran solos. Contaminan el insumo del re-loop y hacen parecer sano un
  // registro ciego. Convención de nombres: la guía del paso «Pase adversarial».
  const honesty = require('./ledger-honesty.js');
  const todos = [...(marker.filesTouched || [])];
  const foto = honesty.sinProbes(todos);
  const probesFuera = todos.length - foto.length;

  // ── ¿Se tocó código después del último revisor? ───────────────────────────────────────────────
  // La guarda NUNCA rompe la foto: si no puede correr, el comportamiento es el de siempre y se DICE
  // (un «no medido» que se lee como «ok» es peor que no medir).
  let g = null;
  let motivoSinMedir = null;
  if (require('./legacy-names.js').readEnv('TYCON_SNAPSHOT_GUARD', { where: 'skills/tycon-pipeline/scripts/marker.js' }) === '0') {
    motivoSinMedir = 'guarda de foto tardía apagada por el dev (TYCON_SNAPSHOT_GUARD=0)';
  } else {
    try {
      const ft = require('./late-snapshot.js');
      let lineas = [];
      try {
        lineas = fs.readFileSync(path.join(STATE_DIR, 'advisor-runs', `${estado.SID}.jsonl`), 'utf8').split('\n');
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

  const ft = (() => { try { return require('./late-snapshot.js'); } catch (_e) { return null; } })();
  const nom = g && ft ? ft.nombrados(g.posteriores) : { lista: [], resto: 0, corto: '' };
  const hhmmss = (iso) => (typeof iso === 'string' && iso.length >= 19 ? `${iso.slice(11, 19)} UTC` : String(iso));
  const escribir = (ts) => {
    marker.iterations[String(n)] = {
      ts,
      filesSnapshot: foto,
      ...(probesFuera ? { probes_excluidos: probesFuera } : {}),
      ...(congelada ? { ...sellosDe(congelada), vuelta: congelada.etiqueta } : {}),
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

/**
 * Con el plan ya aprobado, ¿anotar la parte lo deja aprobado? Sólo si lo aprobó una persona (su aprobación no congela
 * una lista para la parte, la de la revisión sí) y ni el plan ni la maqueta aprobada cambiaron: `{ mantener, caso }`.
 */
function planSigueAprobado(marker) {
  const ap = marker.planApproval || {};
  if (ap.mode !== 'user') return { mantener: false, caso: 'la aprobación fue de la revisión automática: con la parte la da de nuevo quien la dio' };
  if (!ap.planSha) return { mantener: false, caso: 'la aprobación es de antes de guardar la huella del plan' };
  const ahora = huellaDelPlan(marker);
  if (!ahora.sha) return { mantener: false, caso: `no pude leer el plan de ahora (${ahora.motivo})` };
  if (ahora.sha !== ap.planSha) return { mantener: false, caso: 'el plan cambió desde que lo aprobó una persona' };
  const maqueta = marker.mockupApproval;
  if (maqueta) {
    let sha = null;
    try { sha = require('../mockup.js').mockupHash(fs.readFileSync(maqueta.file, 'utf8')); } catch (_) { sha = null; }
    if (!sha || sha !== maqueta.sha256) return { mantener: false, caso: 'la maqueta aprobada cambió o no se puede leer' };
  }
  return { mantener: true, caso: 'el plan no cambió desde que lo aprobó una persona' };
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
  writeMarker(conHoraDelPaso(nuevo));
  syncSessionState(estado.SID);
}

/**
 * `set-batch <tanda>`: anota la tanda de la ejecución en una historia paraguas. «Preparar el commit» le pasa esa tanda
 * a la matriz, que mide sólo sus criterios. Se anota una vez: el mismo nombre otra vez no cambia nada; otro, o
 * `--clear`, se niega (para otra tanda, otra ejecución). La tanda tiene que estar en el bloque `pipelines` de la
 * historia del marcador y no estar `done`. Es la única forma de escribirla: `set` no la acepta.
 */
function cmdSetBatch(nombre) {
  const uso = 'Uso: marker.js set-batch <tanda>';
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-batch: no hay una ejecución abierta en esta sesión (pipeline.js start primero).');
    process.exit(2);
  }
  if (!nombre || nombre === '--clear') {
    console.error(nombre === '--clear'
      ? `marker.js set-batch: la tanda no se borra (anotada: ${marker.batch || 'ninguna'}). Para otra tanda, otra ejecución: marker.js clear y arrancar de nuevo.`
      : `marker.js set-batch: falta la tanda. ${uso}`);
    process.exit(2);
  }
  if (marker.batch !== undefined && marker.batch !== null) {
    if (marker.batch === nombre) { process.stdout.write(`batch: ${nombre} (ya estaba anotada)\n`); return; }
    console.error(`marker.js set-batch: esta ejecución ya anotó la tanda ${marker.batch}; no se cambia por ${nombre}. Para otra tanda, otra ejecución: marker.js clear y arrancar de nuevo.`);
    process.exit(2);
  }
  const storyPath = resolveStoryPath(marker.storyPath, marker);
  let texto;
  try { texto = fs.readFileSync(storyPath, 'utf8'); } catch (e) {
    console.error(`marker.js set-batch: no pude leer la historia del marcador (${nn(marker.storyPath, '(vacía)')}: ${e.code || e.message}): no anoté nada.`);
    process.exit(2);
  }
  const tandas = require('./story-checks.js').parsePipelinesBlock(texto);
  const lista = tandas.map((t) => `${t.name} (${t.status || 'sin estado'})`).join(', ') || '(la historia no tiene bloque pipelines)';
  const tanda = tandas.find((t) => t.name === nombre);
  if (!tanda) {
    console.error(`marker.js set-batch: la tanda «${nombre}» no está en la historia ${marker.storyId}. Tandas: ${lista}`);
    process.exit(2);
  }
  if (String(tanda.status || '').toLowerCase() === 'done') {
    console.error(`marker.js set-batch: la tanda ${nombre} está done: una tanda hecha no se entrega de nuevo. Tandas: ${lista}`);
    process.exit(2);
  }
  // ¿la parte vale para medir el riesgo? Se anota igual (la matriz mide sus criterios); si no vale, el riesgo, la
  // delicada y el tamaño del plan se miden por la historia entera
  const scope = require('./batch-scope.js');
  const valida = scope.validarParte(texto, nombre);
  // con el plan ya aprobado sin parte, anotarla lo deja pendiente otra vez (la aprobación era de otra cosa), salvo que lo
  // haya aprobado una persona y no haya cambiado
  const conPlan = require('./steps.js').isDone(marker, 'approve-plan');
  const decision = conPlan ? planSigueAprobado(marker) : null;
  if (decision && decision.mantener) {
    appendLog('gates.log', { name: 'plan-kept', status: 'ok', story: marker.storyId || null, batch: nombre, motivo: decision.caso });
  } else if (decision) {
    scope.volverAlPlan(marker);
    appendLog('gates.log', { name: 'plan-reopened', status: 'ok', story: marker.storyId || null, batch: nombre, motivo: `se anotó la parte con el plan ya aprobado sin parte: ${decision.caso}` });
  }
  marker.batch = nombre;
  marker.batchSetAt = nowIso();
  marker.batchValid = !!valida.valid;
  if (valida.valid) delete marker.batchInvalidReason; else marker.batchInvalidReason = valida.reason;
  marker.lastTouch = marker.batchSetAt;
  writeMarker(marker);
  appendLog('gates.log', { name: 'set-batch', story: marker.storyId || null, batch: nombre, valid: marker.batchValid, ...(valida.valid ? {} : { reason: valida.reason }), ts: marker.batchSetAt });
  process.stdout.write(`batch: ${nombre}\n`);
  // sin `files:`, la lista sale de lo que la historia le ata: se dice cuál es, para que se vea qué se mide
  if (valida.valid && valida.derivada) process.stdout.write(`batch: archivos de la parte: ${valida.files.join(', ')}\n`);
  if (!valida.valid) process.stdout.write(`batch: la parte no vale para medir el riesgo (${valida.reason}): el plan se mide por la historia entera\n`);
  if (decision && decision.mantener) process.stdout.write(`batch: ${decision.caso}: «Aprobar el plan» sigue hecho\n`);
  else if (decision) process.stdout.write(`batch: el plan estaba aprobado sin parte (${decision.caso}): «Aprobar el plan» queda pendiente otra vez\n`);
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
  const cita = (i >= 0 && citaDe(opts[i + 1])) || (opts.includes('--terminal') ? 'firmado en la terminal' : '');
  // --replace-delegated: la maqueta aprobada sin persona la vuelve a aprobar el dueño, sólo con su click o su «aprobado»
  // a este pedido, o en su terminal (`soloLaPersona`); con cualquier otra vía sale sin escribir nada
  const reemplaza = opts.includes('--replace-delegated');
  const maquetaPrevia = marker.mockupApproval || null;
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
  if (reemplaza && !hechaSinPersona(maquetaPrevia, marker.planApproval)) {
    no(maquetaPrevia ? `--replace-delegated: la maqueta ya la aprobó una persona (${maquetaPrevia.via || maquetaPrevia.mode}): no hay una firma por delegación que reemplazar. No se escribió nada.`
      : '--replace-delegated: no hay una maqueta aprobada que reemplazar. No se escribió nada.');
  }
  const mk = require('../mockup.js');
  let sc;
  try { sc = mk.screenStory(resolveStoryPath(marker.storyPath, marker) || marker.storyPath); } catch (e) {
    no(`no pude leer la story (${marker.storyPath || '(sin ruta en el marcador)'}: ${e.code || e.message}): no pude saber si tiene pantalla.`);
  }
  if (!sc.screen) no('la story no tiene pantalla: no hay maqueta que aprobar.');
  let p;
  try { p = mk.mockupPaths(sc.story); } catch (e) { no(`no pude calcular la clave de la story (${e.message}).`); }
  let html = null;
  try { html = fs.readFileSync(p.mockup, 'utf8'); } catch (_e) {
    no(`falta la maqueta (${p.mockup}).`, [`Armala: node ${path.join(SCRIPTS_DIR, 'mockup.js')} render --data <modelo.json> --story ${sc.story}`]);
  }
  const v = mk.validateMockupHtml(html);
  if (!v.ok) no(`la maqueta no pasa mockup.js check (${p.mockup}):`, v.findings.map((x) => `- ${x.line ? `línea ${x.line}: ` : ''}${x.what}`));
  const mirada = require('./mockup-shots.js').problemaDeLaRevision({ mockupPath: p.mockup, html, mockupJs: path.join(SCRIPTS_DIR, 'mockup.js') });
  if (mirada) no(mirada.motivo, mirada.extra);
  const sha = mk.mockupHash(html);
  const prev = marker.mockupApproval && marker.mockupApproval.sha256;
  // sin persona, la maqueta la reaprueba sólo la coordinadora con la revisión que ella lanzó; la de la propia sesión no
  // cuenta para una pantalla (como la aprobación del plan sin --approved: una historia con pantalla no se aprueba sola)
  const porLaRevision = antesDeLaRevision({ marker });
  const antesDeLaMaqueta = (via, registro) => {
    if (reemplaza) { const n = soloLaPersona(via, registro); if (n) return n; }
    if (via !== 'delegacion') return null;
    if (PROPIA === estado.SID) return { codigo: 1, motivo: 'la maqueta de una pantalla la reaprueba una persona o la coordinadora: la revisión que lanzó la propia sesión no cuenta para una pantalla' };
    return porLaRevision(via);
  };
  const firma = firmaDelDueno('plan-approval', `maqueta de ${marker.storyId}: ${cita}`, { antes: antesDeLaMaqueta });
  // lo comprobó el control previo; si igual llegara otra vía, no se escribe una firma de persona sin ella
  if (reemplaza && !conPersona(firma.via)) no(`--replace-delegated: la firma llegó por ${firma.via || 'otra vía'}, no de la persona. No se escribió nada.`);
  const at = nowIso();
  try { mk.writeApproval({ approvalPath: p.approval, mockupPath: p.mockup, story: marker.storyId, sha256: sha, approvedAt: at }); } catch (e) {
    no(`no pude escribir la aprobación de la maqueta (${p.approval}): ${e.code || e.message}`);
  }
  // `user` sólo con la vía de una persona (modoDeLaFirma); con la vía en la constancia
  marker.mockupApproval = { file: p.mockup, sha256: sha, mode: modoDeLaFirma(firma), text: cita, at, ...firma.constancia,
    ...(reemplaza && maquetaPrevia ? { reemplaza: reemplazada(maquetaPrevia) } : {}) };
  if (!marker.mockupDecision || marker.mockupDecision.screen !== true) marker.mockupDecision = { screen: true, signal: sc.signal || null, at };
  appendLog('gates.log', { name: 'mockup-approval', status: 'ok', story: marker.storyId, sha256: sha.slice(0, 12), reapproval: !!prev, ...(prev ? { previous: prev.slice(0, 12) } : {}),
    ...(reemplaza ? { replaced: maquetaPrevia.via || maquetaPrevia.mode || null } : {}) });
  {
    const optVal = (name) => { const k = opts.indexOf(name); return k >= 0 ? nn(opts[k + 1], '') : null; };
    // la persona a su nombre; sin persona, quien firmó de verdad (como la maqueta aprobada con el plan)
    anotarAprobacion(marker, { que: 'maqueta', cuando: at, via: `approve-mockup${reemplaza ? ' --replace-delegated' : ''}`, ...quienDeLaMaqueta(firma, optVal), ...porDe(firma) });
  }
  writeMarker(marker);
  console.log(JSON.stringify({ ok: true, file: p.mockup, approval: p.approval, sha256: sha, reapproval: !!prev }, null, 2));
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
    declared = require('../pipeline.js').computeRunSize({ story: marker.storyPath, repo: marker.repoPath });
  } catch (e) {
    console.error(`marker.js set-size: no pude clasificar lo que declara la story (${String(e.message || e).split('\n')[0]})`);
  }
  // Forzar a liviana una story con código (o que no se pudo clasificar) apaga el pase: es un pedido, y sin la
  // constancia firmada por el dueño no cambia nada.
  let firmado = null;
  if (size === 'liviana' && !(declared && declared.size === 'liviana')) {
    const p = require('./adversarial-skip.js').pedirFirma({
      story: String(marker.storyId), carpeta: carpetaDeLaCorrida(marker), ejecucion: marker.startedAt, camino: 'set-size liviana',
    });
    if (!p.ok) {
      process.stderr.write(p.texto);
      console.error(`marker.js set-size: no se cambió el tamaño — ${p.motivo}.`);
      process.exit(1);
    }
    firmado = { via: p.linea.via, quien: p.linea.quien, cuando: p.linea.ts, huella: p.linea.huella };
  }
  const prev = marker.size || null;
  marker.size = size;
  marker.size_reason = `forzado a mano: ${reason}`;
  marker.sizeForced = { by, reason, at: nowIso(), from: prev, ...(firmado ? { firmado } : {}) };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  if (!firmado && !require('./adversarial-skip.js').firmasDelSalteo(marker).length) quitarSalteoDelRegistro(marker);
  if (firmado) {
    anotarSalteoEnElRegistro(marker, firmado);
    appendLog('bypass.log', { kind: 'SIZE_FORCED_LIGHT_WITH_CODE', storyId: marker.storyId, by, reason, declared: declared ? declared.reason : null, firmado });
    console.error(`⚠️  liviana con código, con la constancia firmada por el ${firmado.quien} (huella ${firmado.huella}) — queda en bypass.log`);
  }
  process.stdout.write(`size: ${size} (${reason})\n`);
}

// El pedido para esta corrida: `set-models <trabajo>=<modelo> … | --clear`. `<trabajo>` es
// reviewers, reviewers_reloop, adversarial, helpers o el nombre de un revisor; `<modelo>`, un nivel o un nombre del
// vocabulario de lib/models.js, y se guarda el modelo de Claude. Con techo obligatorio, pipeline.js lo recorta y lo
// dice. Se valida todo antes de escribir nada.
function cmdSetModels(args) {
  const M = require('./models.js');
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
  // con la corrida esperando a main, la historia no pasa a review ni a done (el mismo freno que el rojo)
  if (newStatus === 'review' || newStatus === 'done') frenarEstadoSiEsperaMain('update-story-status', storyPath);
  const content = fs.readFileSync(storyPath, 'utf8');
  // done pide la matriz de evidencia en vivo (DODRT-C6), también fuera de una corrida: verde en esta carpeta, o la
  // constancia que dejó la corrida de esta historia al pasarla en verde. Repetir done sobre una historia en done no frena
  // el `status:` de la historia es el de la raíz del encabezado, no el de una tanda de `pipelines:`
  const estadoActual = ((content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '').match(/^status\s*:\s*["']?([\w-]+)/m);
  if (newStatus === 'done' && !(estadoActual && estadoActual[1] === 'done')) frenarDoneSinMatriz(storyPath);
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
  // cada cambio de estado queda anotado: una vuelta a in-progress invalida la constancia de la matriz anterior
  appendLog('gates.log', { name: 'story-status', status: newStatus, storyPath: path.resolve(storyPath), ...dondeViveLaHistoria(storyPath) });
  process.stdout.write(`status: ${newStatus}\n`);
}

/**
 * Con la matriz de evidencia en vivo roja en esta carpeta y sin constancia de la matriz verde de esta historia (de su
 * repo y su ruta en el repo, posterior a su última vuelta a in-progress) en el registro de esta máquina, la historia no
 * pasa a done: frena y dice cómo se sale.
 */
function frenarDoneSinMatriz(storyPath) {
  let matrix = null;
  try { matrix = require('../runtime-matrix.js').compute({ storyPath, paraDone: true }); } catch (_e) { matrix = null; }
  if (matrix && !matrix.structuralError && matrix.green) return;
  const donde = dondeViveLaHistoria(storyPath);
  // un criterio que se comprueba en staging sin su humo de staging frena aunque haya constancia: la constancia de la
  // corrida es de antes del merge, cuando staging todavía no tenía el código
  const faltaStaging = matrix && !matrix.structuralError ? matrix.stagingFalta || [] : [];
  if (faltaStaging.length) {
    appendLog('gates.log', { name: 'story-done', status: 'blocked', storyPath: path.resolve(storyPath), ...donde, motivo: 'sin-humo-de-staging' });
    console.error(`marker.js update-story-status BLOQUEADO — ${faltaStaging.map((n) => `AC#${n}`).join(', ')} se comprueba(n) en staging y no tiene(n) un humo corrido contra staging.`);
    console.error('  Cómo se sale: desplegá el código a staging y corré el humo de cada uno contra staging, con --environment staging:');
    for (const n of faltaStaging) {
      console.error(`   · bash ${path.join(SCRIPTS_DIR, 'smoke-run.sh')} ${(matrix.evidenceDirs || [])[0] || '<carpeta de evidencia>'} ${storyPath} --acs ${n} --environment staging -- <el comando contra staging>`);
    }
    console.error('  Con el humo verde, este mismo comando la pasa a done. Si staging falla, la historia queda en review: arreglalo y volvé a desplegar.');
    process.exit(1);
  }
  const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(String(p)); } };
  const misma = (l) => (donde.storyRel && donde.repoCommon && l.storyRel && l.repoCommon
    ? l.storyRel === donde.storyRel && real(l.repoCommon) === real(donde.repoCommon)
    : Boolean(l.storyPath) && real(l.storyPath) === real(storyPath));
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(STATE_DIR, 'gates.log'), 'utf8').split('\n'); } catch (_e) { lineas = []; }
  let verde = null;
  let reabierta = null;
  // la constancia de una tanda (historia paraguas) mide sólo sus criterios: vale si cada tanda de la historia tiene la suya
  const porTanda = new Map();
  for (const t of lineas) {
    let l;
    try { l = JSON.parse(t); } catch (_e) { continue; }
    if (!l || typeof l.ts !== 'string' || !misma(l)) continue;
    if (l.name === 'acmatrix-green' && l.batch) { if (!porTanda.has(l.batch) || l.ts > porTanda.get(l.batch)) porTanda.set(l.batch, l.ts); continue; }
    if (l.name === 'acmatrix-green' && (!verde || l.ts > verde)) verde = l.ts;
    if (l.name === 'story-status' && l.status === 'in-progress' && (!reabierta || l.ts > reabierta)) reabierta = l.ts;
  }
  if (verde && (!reabierta || verde > reabierta)) return;
  const tandas = [...String(((fs.readFileSync(storyPath, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '').split(/^pipelines\s*:/m)[1] || '')
    .split(/^\S/m)[0].matchAll(/^\s*-\s+name\s*:\s*["']?([^"'#\s]+)/gm)].map((m) => m[1]);
  const deCadaTanda = tandas.length && tandas.every((b) => porTanda.has(b) && (!reabierta || porTanda.get(b) > reabierta));
  if (deCadaTanda) return;
  if (!verde && porTanda.size) verde = [...porTanda.values()].sort().pop();
  appendLog('gates.log', { name: 'story-done', status: 'blocked', storyPath: path.resolve(storyPath), ...donde, motivo: verde ? 'constancia-anterior-a-reabrir' : 'sin-matriz' });
  console.error('marker.js update-story-status BLOQUEADO — la historia no pasa a done sin la matriz de evidencia en vivo (DODRT-C6).');
  if (matrix && matrix.structuralError) console.error(`  La matriz no se pudo calcular acá: ${matrix.structuralError}`);
  else if (matrix) console.error(`  En esta carpeta la matriz está roja: ${matrix.stats.runtime}/${matrix.stats.total} corridos${(matrix.notRun || []).length ? ` · sin correr: ${matrix.notRun.map((n) => `#${n}`).join(', ')}` : ''}.`);
  console.error(verde
    ? `  La constancia de la matriz verde de esta historia (${verde}) es anterior a su última vuelta a in-progress (${reabierta}): no vale.`
    : '  Tampoco hay en esta máquina una constancia de la matriz verde de esta historia (la deja la corrida al pasarla).');
  console.error('  Cómo se sale:');
  console.error(`   · Si la evidencia está en esta carpeta, mirá qué falta: node ${path.join(SCRIPTS_DIR, 'runtime-matrix.js')} --story ${storyPath}`);
  console.error('     Con la matriz verde acá, este mismo comando la pasa a done.');
  console.error('   · Si la corrida fue en otra carpeta o en otra máquina, cerrala allá con la corrida: /tycon-pipeline close <id>.');
  console.error('   · Un criterio imposible de probar en vivo lo firma la persona: marker.js runtime-waiver <historia>.');
  process.exit(1);
}

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
  // con la corrida esperando a main, ninguna tanda pasa a done
  if (newStatus === 'done') frenarEstadoSiEsperaMain('update-pipeline-status', storyPath);
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
 * `resume-autonomy [--ask-again] [--terminal --for-session <sesión>]`: la decisión de seguir en autónomo, que toma la
 * sesión detenida (lib/autonomy-decision.js). Sin detención abierta, con el botón de pánico puesto o con un «No» del dueño
 * ya dado (y sin `--ask-again`) sale 1 sin pedir nada. Con un permiso de la terminal vigente y de esta detención, lo
 * consume. Si no, pide la firma `autonomy-resume`, que aprueba sólo el click del dueño (en esta pestaña o en la de la
 * coordinadora) o su terminal. Con `--terminal --for-session`, deja el permiso para esa sesión y no toca su marcador.
 * Con la decisión, relee el marcador, comprueba que la detención es la misma y vuelve a prender el modo con las vueltas
 * en cero; la detención resuelta queda en `escalationsResolved` y en gates.log.
 */
function cmdResumeAutonomy(argv) {
  const ad = require('./autonomy-decision.js');
  const ow = ownerWindow();
  let askAgain = false;
  let terminal = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ask-again') { askAgain = true; continue; }
    if (argv[i] === '--terminal') { terminal = true; continue; }
    if (argv[i] === '--for-session') { i++; continue; }
    console.error(`marker.js resume-autonomy: no conozco «${String(argv[i]).slice(0, 60)}». Uso: marker.js resume-autonomy [--ask-again] [--terminal --for-session <sesión>]`);
    process.exit(2);
  }
  const comandoTerminal = ad.comandoDeLaTerminal(MARKER_JS, estado.SID);
  const no = (codigo, motivo) => { console.error(`🔒 marker.js resume-autonomy: ${motivo}`); process.exit(codigo); };
  const cual = ad.panico(STATE_DIR, process.env);
  if (cual) no(1, `el botón de pánico sigue puesto (${cual}): sacalo antes. No pido la firma.`);
  // la detención puede ser de un marcador sin historia: se lee tal como está
  let marker = null;
  try { marker = readOwnMarkerRaw(); } catch (e) { no(2, `no pude leer el marcador de esta sesión (${e.code || e.message}): no pido la firma.`); }
  const d = ad.detencionDe(marker);
  if (!d) no(1, `No hay una detención que retomar en esta sesión (${estado.SID}): el modo autónomo no está detenido esperando a una persona, o no hay marcador.${terminal && estado.SID === '_nosession' ? ' Desde la terminal, la sesión detenida va en --for-session <sesión>.' : ''} No pido la firma.`);
  // la decisión se aplica sobre el marcador de ahora: si la detención cambió entre el cuadro y el click, no vale
  const aplicar = ({ via, by, at }) => {
    let fresco = null;
    try { fresco = readOwnMarkerRaw(); } catch (_e) { fresco = null; }
    const ahora = ad.detencionDe(fresco);
    if (!ahora || ahora.huella !== d.huella) no(1, 'lo que se mostró cambió: pedí el cuadro de nuevo (la detención ya no es la misma). No toqué nada.');
    fresco.autonomous = true;
    fresco.iter = 0;
    fresco.noProgressStreak = 0;
    fresco.lastFailures = [];
    delete fresco.needs_human;
    delete fresco.escalation_reason;
    delete fresco.escalation;
    const resueltas = Array.isArray(fresco.escalationsResolved) ? fresco.escalationsResolved : [];
    fresco.escalationsResolved = [...resueltas, { reason: ahora.reason, failures: ahora.failures, iter: ahora.iter, at: ahora.at, decision: { via, by, at } }].slice(-ad.RESUELTAS_MAX);
    fresco.lastTouch = nowIso();
    writeMarker(fresco);
    syncSessionState(estado.SID);
    appendLog('gates.log', { name: 'autonomy-resume', status: 'ok', via, by, huella: d.huella, reason: ahora.reason, detenidaEn: ahora.at });
    process.stdout.write(estado.SID === PROPIA ? `Una persona decidió seguir (por ${via}, ${ad.horaCorta(at)}): corré los controles de nuevo antes de cerrar el turno.\n`
      : `Una persona decidió seguir (por ${via}, ${ad.horaCorta(at)}): la sesión ${estado.SID} volvió al modo autónomo. Avisale que siga: corre los controles de nuevo antes de cerrar el turno.\n`);
    process.exit(0);
  };
  // pedida por la coordinadora para la sesión detenida: el permiso de la terminal es de esa sesión, que lo consume ella
  const paraOtra = estado.SID !== PROPIA && !terminal;
  if (!terminal && !paraOtra) {
    const p = ad.tomarPermiso(STATE_DIR, estado.SID, d.huella, { seco: PREVIO });
    if (p.permiso) {
      if (PREVIO) { process.stdout.write(`${ow.PRECHEQUEO_OK}\n`); process.exit(0); }
      return aplicar({ via: 'terminal', by: p.permiso.by || 'terminal', at: p.permiso.at || nowIso() });
    }
    if (p.motivo) console.error(`ℹ️ marker.js resume-autonomy: ${p.motivo}.`);
    if (!askAgain) {
      const r = ad.rechazoDe({ casa: os.homedir(), sesion: estado.SID, detencion: d });
      if (r && r.ilegible) no(1, `no pude leer si una persona ya dijo que no (${r.ilegible}): no pido la firma. Si la persona está en la sesión y pide seguir: marker.js resume-autonomy --ask-again`);
      if (r) no(1, `Una persona dijo que no a esta detención (${ad.horaCorta(r.at)}): la sesión queda detenida hasta que la persona entre. Si entró y pide seguir: marker.js resume-autonomy --ask-again`);
    }
  }
  const r = ow.exigir({ firma: 'autonomy-resume', argv: process.argv.slice(1),
    resumen: `que la ejecución ${marker.storyId ? `de la historia ${marker.storyId} ` : ''}(sesión ${estado.SID}) vuelva al modo autónomo, con las vueltas en cero`,
    propia: PROPIA, anotar: (renglon) => appendLog('gates.log', renglon) });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js resume-autonomy: la persona no decidió seguir — ${r.motivo}`);
    console.error('   Lo decide sólo su click, en esta pestaña o en la de la coordinadora, o su terminal:');
    console.error(`     ${comandoTerminal}`);
    process.exit(r.codigo === 2 ? 2 : 1);
  }
  if (!['click', 'terminal'].includes(r.via)) no(1, `esto lo decide sólo el click de una persona o su terminal, y volvió por ${r.via}; no toqué nada.`);
  if (terminal) {
    // la terminal deja el permiso para la sesión detenida: su marcador es de sólo lectura desde acá, y lo consume ella
    const permiso = { huella: d.huella, via: 'terminal', by: process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'terminal', at: nowIso() };
    ad.escribirPermiso(STATE_DIR, estado.SID, permiso);
    appendLog('gates.log', { name: 'autonomy-resume-permit', status: 'ok', destino: estado.SID, huella: d.huella, by: permiso.by });
    process.stdout.write(`Una persona decidió seguir desde su terminal: el permiso quedó para la sesión ${estado.SID}. Cuando esa sesión corra marker.js resume-autonomy, vuelve al modo autónomo.\n`);
    process.exit(0);
  }
  // para otra sesión, con la firma se escribe su marcador: el que vio el dueño en el cuadro
  if (paraOtra) trabajarSobreElDestino(ow, r);
  return aplicar({ via: r.via, by: (r.registro && r.registro.aprobada_en) || r.sesion || estado.SID, at: nowIso() });
}

// Escape consciente del freno de STORY A MANO (lib/story-skill-gate.js): deja la misma
// marca que dejaría la invocación de tycon-create-story, pero con skill:'bypass' + la razón, y queda
// en bypass.log (STORY_SKILL_BYPASS). La razón tiene que venir del USER (mismo contrato que
// `adhoc set`): es el user quien decide que ESTA story se escribe a mano, no el agente.
function cmdStorySkillBypass() {
  // Escribir una historia sin la skill lo decide la persona, y este comando ya no deja constancia: un modelo frenado lo
  // corrió solo con una razón inventada («el usuario lo pidió»). La firma se pide sobre el archivo, en la ventana.
  console.error('🚫 marker.js story-skill-bypass: no deja constancia — escribir la historia sin la skill lo decide la persona.');
  console.error('   Usá la skill tycon-create-story. Si la persona la quiere sin la skill, la firma sobre el archivo:');
  for (const l of formasDeFirmarArchivo('story-skill-bypass', null, estado.SID)) console.error(`     · ${l}`);
  process.exit(1);
}

// La nota de «repensar el enfoque» de una vuelta de revisores (desde la tercera la exige `pipeline.js smart-reloop`).
// Uso: marker.js rethink --iter N --repeated "<qué se repitió>" (--change "<qué cambia>" | --keep "<por qué sigue igual>")
//        [--story-change "<qué cambia de la story>"] [--repo <repo> --story <spec.md>] [--run-dir <corrida>]
// Se guarda en <corrida>/rethink/iter-N.json con su hora. La corrida sale del marcador de la sesión o de --repo/--story,
// con el mismo criterio que usa pipeline.js para elegir la carpeta.
function cmdRethink(argv) {
  const rt = require('./rethink.js');
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
    const { resolveRunDir, deriveStoryId } = require('../pipeline.js');
    const storyId = deriveStoryId(storyPath) || (marker && marker.storyId ? String(marker.storyId) : null);
    if (!storyId) {
      console.error(`marker.js rethink: no pude leer la story ${storyPath}, así que no sé en qué carpeta guardar la nota.`);
      process.exit(2);
    }
    runDir = resolveRunDir(repo, storyId, !runDirArg, storyPath, { marker: marker || null });
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

module.exports = {
  cmdSnapshotIter, planSigueAprobado, cmdStartStep, cmdSetBatch, cmdApproveMockup, cmdSetSize, cmdSetModels,
  cmdMarkModelsWarned, withBodyStatus, cmdUpdateStoryStatus, frenarDoneSinMatriz, cmdUpdatePipelineStatus,
  cmdResumeAutonomy, cmdStorySkillBypass, cmdRethink,
};
