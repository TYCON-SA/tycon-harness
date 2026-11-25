/**
 * marker-checks.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: los checks de la corrida, las pruebas y las deudas.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  COLA_BYTES_RETENIDOS, EXTERNAL_FLAGS, HARNESS_COMMAND, OLD_FLAGS,
  RUN_CHECK_BUSY, SCRIPTS_DIR, SENALES_RUN_CHECK, STATE_DIR, STEPS_LIB,
  TESTS_FAILED_PENDING, TOPE_DE_LA_DEUDA_EN_VIVO, VALID_CHECKS, VALID_FLAGS,
  appendLog, at, avisarBajaDePantalla, esFecha, estado, fechaLocal,
  firmaDelDueno, fs, markerStoryIsUi, motivoDe, nn, nowIso, opcion, os, path,
  porDe, readMarker, resolveStoryPath, sumarDias, writeMarker,
} = require('./marker-shared.js');

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
 * Solo PASS desbloquea «Preparar el pull request». PARTIAL requiere waiver explícito del user
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
      console.error('  declararla a mano lo decide la persona (lo firma en la ventana de permiso o en su terminal; queda en gates.log).');
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
  let marker = readMarker();
  if (!marker) {
    console.error('marker.js set-autonomous: no hay marker activo (corré `set` en el Arranque primero)');
    process.exit(1);
  }
  // una ejecución que el control de cierre detuvo espera la decisión del dueño: prenderla sola no es una salida
  if (on && marker.needs_human === true) {
    console.error('marker.js set-autonomous: Esta ejecución se detuvo y espera la decisión de una persona: marker.js resume-autonomy. No se cambió nada.');
    process.exit(1);
  }
  // apagarlo saca el lazo que no deja cerrar el turno con un control en rojo: lo firma una persona, o la coordinadora por
  // delegación. Ya apagado, no hay nada que firmar ni que escribir
  let firma = null;
  if (!on) {
    if (marker.autonomous !== true) { process.stdout.write('autonomous: false (ya estaba apagado)\n'); return; }
    firma = firmaDelDueno('escape:set-autonomous', `apagar el modo autónomo de ${marker.storyId || 'la ejecución'}`);
    marker = readMarker();
    if (!marker) { console.error('🔒 marker.js set-autonomous: la ejecución se cerró mientras se firmaba. No se escribió nada.'); process.exit(2); }
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
  if (firma) appendLog('gates.log', { name: 'set-autonomous', story: nn(marker.storyId, null), autonomous: false, via: firma.constancia.via, ...porDe(firma) });
  process.stdout.write(`autonomous: ${on}\n`);
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

function cmdTestsFailed(argv) {
  const accion = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const uso = 'marker.js tests-failed: uso — tests-failed record --summary <f> --repo <r> [--full-ts <ts>] | clear --path <ruta> --repo <r> [--summary <f> --tree <árbol> [--coverage-file <f>]] [--result <f> [--story-id <id>] [--sealed <f>] [--inherited] [--full-suite-by <quién>]] | pending --suites <json> --gate <test-gate.sh> --repo <r> [--story <s>] | save-red|save-green --summary <f> --measured <f> [--coverage-file <f>] [--base <sha>] [--trim <t>] [--story-id <id>] [--after-inherited <f>] [--origin-at <ts>] --repo <r> | red-full|green-full --repo <r> | drop-red|drop-green --repo <r> | run-end --repo <r> --mode <m> --reason <t> --exit <n> --saved verde|rojo|no [--saved-reason <t>] [--origin-at <ts>] [--suites <n>] [--duration-ms <n>]';
  if (!['record', 'clear', 'pending', 'save-red', 'red-full', 'drop-red', 'save-green', 'green-full', 'drop-green', 'run-end'].includes(accion) || !opt('--repo')
    || (accion === 'record' && !opt('--summary')) || (accion === 'clear' && !opt('--path'))
    || (accion === 'pending' && (!opt('--suites') || !opt('--gate')))
    || ((accion === 'save-red' || accion === 'save-green') && (!opt('--summary') || !opt('--measured')))
    || (accion === 'run-end' && (!opt('--mode') || !opt('--reason') || !opt('--exit') || !['verde', 'rojo', 'no'].includes(opt('--saved'))))) {
    console.error(uso);
    process.exit(2);
  }
  if (!['pending', 'red-full', 'green-full'].includes(accion) && process.env.TYCON_TEST_GATE !== '1') {
    console.error(`marker.js tests-failed ${accion}: sólo lo usa test-gate.sh (TYCON_TEST_GATE=1)`);
    process.exit(2);
  }
  const ff = require('./failed-first.js');
  const marker = readMarker();
  if (accion === 'run-end') {
    // La nota de esta corrida (el portón la lee para decir «primera» y por qué no guardó la última) y su renglón en
    // gates.log (lo lee `suite-times.js repeats`). Sin corrida abierta, sólo el renglón: la medición no depende del marcador.
    const repoReal = (() => { try { return fs.realpathSync(opt('--repo')); } catch { return path.resolve(opt('--repo')); } })();
    const num = (k) => { const v = Number(opt(k)); return opt(k) !== null && Number.isFinite(v) ? v : null; };
    const guardo = opt('--saved');
    const motivoNo = guardo === 'no' ? (opt('--saved-reason') || 'sin motivo') : null;
    const story = marker ? (marker.storyId || null) : null;
    if (marker) {
      const notas = (Array.isArray(marker.testsSavedNote) ? marker.testsSavedNote : []).filter((x) => x && x.repo !== repoReal);
      marker.testsSavedNote = [...notas, { repo: repoReal, storyId: story, at: nowIso(), guardo, motivo: motivoNo }];
      marker.lastTouch = nowIso();
      writeMarker(marker);
    }
    // estricto: si el renglón no se escribe, sale 1 y el portón lo dice (el informe no vería esta corrida)
    try {
      appendLog('gates.log', { name: 'test-gate-run', story, modo: opt('--mode'), motivo: opt('--reason'), origen_at: opt('--origin-at'),
        suites: num('--suites'), duracion_ms: num('--duration-ms'), exit: num('--exit'), guardo, guardo_motivo: motivoNo }, { estricto: true });
    } catch (e) {
      process.stderr.write(`[test-gate] ⚠️  no pude escribir el renglón de esta corrida en gates.log (${e.message})\n`);
      process.exit(1);
    }
    return;
  }
  if (!marker) {
    // red-full y green-full los lee test-gate.sh como JSON: sin corrida, no hay nada guardado
    if (accion === 'red-full' || accion === 'green-full') process.stdout.write('null\n');
    else process.stdout.write(`marker.js tests-failed ${accion}: sin corrida abierta en esta sesión, no anoto nada\n`);
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
    // las que también están rojas en la punta de main (`main_fails`, del tercer juez) quedan marcadas: la lista no exige
    // repetirlas; cuando no quede otra roja, la completa espera a main
    const deMain = new Set(Array.isArray(resumen && resumen.main_fails) ? resumen.main_fails : []);
    const mainSha = resumen && resumen.main_check && resumen.main_check.sha ? resumen.main_check.sha : null;
    marker.testsFailed = [...ajenas, ...ff.fromSummary(resumen, repo, undefined, opt('--full-ts')).map((x) => (deMain.has(x.ruta) ? { ...x, main: { sha: mainSha } } : x))];
    for (const campo of ['checks', 'checksAt', 'checksProvenance']) if (marker[campo]) delete marker[campo]['tests-suite'];
    marker.lastTouch = nowIso();
    writeMarker(marker);
    const nuevas = marker.testsFailed.filter((x) => x.repo === repo);
    const propias = nuevas.filter((x) => !(x.main && x.main.sha));
    if (propias.length) process.stderr.write(`[test-gate] suites que fallaron, anotadas para repetir primero: ${propias.map((x) => x.ruta).join(', ')}\n`);
    if (nuevas.length > propias.length) process.stderr.write(`[test-gate] de main (no hace falta repetirlas): ${nuevas.filter((x) => x.main && x.main.sha).map((x) => x.ruta).join(', ')}\n`);
    return;
  }
  // Lo guardado de la última completa verde de este repo: como lo rojo de abajo, en `green-full/` y con
  // el campo `testsGreenFull`. Sus tres acciones terminan acá.
  if (['save-green', 'green-full', 'drop-green'].includes(accion)) {
    const verdes = Array.isArray(marker.testsGreenFull) ? marker.testsGreenFull : [];
    const propia = verdes.find((x) => x && x.repo === repo) || null;
    const otras = verdes.filter((x) => x && x.repo !== repo);
    const guardar = (l2) => { if (l2.length) marker.testsGreenFull = l2; else delete marker.testsGreenFull; };
    const casa = path.join(STATE_DIR, 'green-full') + path.sep;
    if (accion === 'green-full') { process.stdout.write(`${JSON.stringify(propia)}\n`); return; }
    if (accion === 'drop-green') {
      if (!propia) return;
      if (typeof propia.dir === 'string' && path.resolve(propia.dir).startsWith(casa)) {
        try { fs.rmSync(propia.dir, { recursive: true, force: true }); } catch (e) {
          process.stderr.write(`[test-gate] ⚠️  no pude borrar lo guardado de la completa verde (${e.message}): queda la carpeta, el marcador ya no la nombra\n`);
        }
      } else process.stderr.write(`[test-gate] ⚠️  lo guardado de la completa verde apunta fuera de ${casa}: no borro nada, sólo lo saco del marcador\n`);
      guardar(otras);
      marker.lastTouch = nowIso();
      writeMarker(marker);
      return;
    }
    const dir = path.join(STATE_DIR, 'green-full', `${marker.sessionId || 'sesion'}-${require('crypto').createHash('sha1').update(repo).digest('hex').slice(0, 12)}`);
    let hash;
    try {
      hash = ff.saveGreen({ dir, summaryFile: opt('--summary'), lcovFile: opt('--coverage-file'), measuredFile: opt('--measured'), base: opt('--base'),
        recorte: opt('--trim') || '', storyId: opt('--story-id') || marker.storyId || null, forgivenFile: opt('--after-inherited'), origenAt: opt('--origin-at') });
    } catch (e) {
      // lo de antes queda entero (saveGreen escribe al lado y cambia al final): la próxima corrida compara contra eso
      process.stderr.write(`[test-gate] ⚠️  no pude guardar este verde (${e.message}): queda lo guardado de antes\n`);
      process.exit(1);
    }
    guardar([...otras, { repo, dir, hash, at: nowIso() }]);
    marker.lastTouch = nowIso();
    writeMarker(marker);
    process.stderr.write('[test-gate] guardé lo que midió esta completa verde: la próxima corrida corre sólo las suites que leen lo que cambie\n');
    return;
  }
  // Lo guardado de la última completa roja de este repo («repetir solas cierra»): vive en la carpeta de
  // estado, `red-full/<sesión>-<repo>`, y el marcador anota su hash. Ver lib/failed-first.js.
  const rojas = Array.isArray(marker.testsRedFull) ? marker.testsRedFull : (marker.testsRedFull ? [marker.testsRedFull] : []);
  const roja = rojas.find((x) => x && x.repo === repo) || null;
  const otrasRojas = rojas.filter((x) => x && x.repo !== repo);
  const guardarRojas = (lista2) => { marker.testsRedFull = lista2.length ? lista2 : undefined; if (!lista2.length) delete marker.testsRedFull; };
  if (accion === 'red-full') {
    process.stdout.write(`${JSON.stringify(roja)}\n`);
    return;
  }
  if (accion === 'drop-red') {
    if (!roja) return;
    // sólo se borra lo que está en su carpeta: un `dir` de otro lado no se toca, se dice
    const casa = path.join(STATE_DIR, 'red-full') + path.sep;
    if (typeof roja.dir === 'string' && path.resolve(roja.dir).startsWith(casa)) {
      try { fs.rmSync(roja.dir, { recursive: true, force: true }); } catch (e) {
        process.stderr.write(`[test-gate] ⚠️  no pude borrar lo guardado de la completa roja (${e.message}): queda la carpeta, el marcador ya no la nombra\n`);
      }
    } else process.stderr.write(`[test-gate] ⚠️  lo guardado de la completa roja apunta fuera de ${casa}: no borro nada, sólo lo saco del marcador\n`);
    guardarRojas(otrasRojas);
    marker.lastTouch = nowIso();
    writeMarker(marker);
    return;
  }
  if (accion === 'save-red') {
    const dir = path.join(STATE_DIR, 'red-full', `${marker.sessionId || 'sesion'}-${require('crypto').createHash('sha1').update(repo).digest('hex').slice(0, 12)}`);
    let hash;
    try {
      hash = ff.saveRed({ dir, summaryFile: opt('--summary'), lcovFile: opt('--coverage-file'), measuredFile: opt('--measured'), base: opt('--base'), recorte: opt('--trim') || '', storyId: opt('--story-id') || marker.storyId || null, origenAt: opt('--origin-at') });
    } catch (e) {
      process.stderr.write(`[test-gate] ⚠️  no pude guardar la completa roja (${e.message}): repetir solas no va a cerrar «Correr las pruebas»\n`);
      process.exit(1);
    }
    guardarRojas([...otrasRojas, { repo, dir, hash, at: nowIso() }]);
    marker.lastTouch = nowIso();
    writeMarker(marker);
    process.stderr.write('[test-gate] guardé lo que midió esta completa roja: con las rojas repetidas solas en verde, la próxima completa cierra sin correr todo\n');
    return;
  }
  if (accion === 'clear') {
    const ruta = opt('--path');
    const propia = lista.find((x) => x.ruta === ruta);
    if (!propia) {
      if (opt('--result')) process.stderr.write(`[test-gate] constancia: ${ruta} no está en la lista de las que fallaron en la completa: no la toco\n`);
      return;
    }
    const quedan = lista.filter((x) => x.ruta !== ruta);
    // la constancia de la completa (y su copia que viaja) deja de nombrar esta falla: el revisor de pruebas la lee
    let constanciaVerde = false;
    if (opt('--result')) {
      try {
        const hecho = ff.rewriteResult(opt('--result'), { raiz: propia.raiz || null, ruta }, {
          fullTs: propia.full_ts || null, storyId: opt('--story-id'), inherited: argv.includes('--inherited'), sealed: opt('--sealed') });
        process.stderr.write(`[test-gate] constancia: ${hecho.reason}\n`);
        if (hecho.written) {
          try {
            const c = JSON.parse(fs.readFileSync(opt('--result'), 'utf8'));
            constanciaVerde = c.suite_green === true && c.suite_green_by === 'repeticiones';
          } catch (e) { process.stderr.write(`[test-gate] ⚠️  no pude leer la constancia reescrita (${e.message}): el check tests queda como estaba\n`); }
        }
      } catch (e) { process.stderr.write(`[test-gate] ⚠️  no pude reescribir la constancia (${e.message}): queda como la dejó la completa\n`); }
    }
    // La última roja repetida en verde deja `tests` en verde, con la constancia de la completa en verde por las
    // repeticiones, sólo en una corrida acotada (`--full-suite-by`: la completa la corre después la CI del pedido) y sin
    // lo guardado de la completa roja, de éste o de otro repo (con eso, la próxima completa cierra y vuelve a correr lo
    // que el arreglo cambió).
    // No tapa otro rojo: ni otra suite en la lista (de este repo o de otro), ni una ausente o sin medir, ni un repo
    // hermano rojo (la constancia no queda verde), ni una corrida de `tests` posterior a esa completa.
    const porRepeticiones = constanciaVerde && !!opt('--full-suite-by') && !roja && otrasRojas.length === 0 && quedan.length === 0 && ajenas.length === 0
      && /^red\b/.test(String((marker.checks || {}).tests)) && (marker.checksProvenance || {}).tests === 'test-gate'
      && Date.parse((marker.checksAt || {}).tests) <= Date.parse(propia.at);
    // con lo guardado de la completa roja, la repetición se suma con la foto de la carpeta en que corrió: la verde, y la
    // roja que el juez perdonó, con su falla (el juez la pasó a `inherited.suites` del resumen de la suite sola)
    if (roja && opt('--summary') && opt('--tree')) {
      try {
        const sola = JSON.parse(fs.readFileSync(opt('--summary'), 'utf8'));
        const entry = (sola.suites || [])[0] || null;
        const heredada = argv.includes('--inherited') && entry && entry.exit !== 0
          ? ((sola.inherited && sola.inherited.suites) || []).find((x) => x && x.entrada && x.entrada.ruta === ruta) || null : null;
        if (heredada) {
          const { measured_on: _medida, ...falla } = heredada;
          roja.hash = ff.addRepeat(roja.dir, ruta, { tree: opt('--tree'), entry, lcovFile: opt('--coverage-file'), falla });
        } else if (entry && entry.exit === 0) roja.hash = ff.addRepeat(roja.dir, ruta, { tree: opt('--tree'), entry, lcovFile: opt('--coverage-file') });
      } catch (e) { process.stderr.write(`[test-gate] ⚠️  no pude sumar la repetición a lo guardado (${e.message}): la completa va a correr entera\n`); }
    }
    marker.testsFailed = [...ajenas, ...quedan];
    marker.lastTouch = nowIso();
    const rojoAntes = porRepeticiones ? marker.checks.tests : null;
    if (porRepeticiones) {
      marker.checks.tests = 'green';
      marker.checksAt = { ...(marker.checksAt || {}), tests: marker.lastTouch };
      marker.checksProvenance = { ...(marker.checksProvenance || {}), tests: 'test-gate' };
    }
    writeMarker(marker);
    if (porRepeticiones) {
      appendLog('gates.log', { name: 'tests', status: 'green', by: 'repeticiones', story: marker.storyId || null, repo,
        before: rojoAntes, full_ts: propia.full_ts || null, full_suite_by: opt('--full-suite-by') });
      process.stderr.write(`[test-gate] ✅ no queda ninguna roja y la constancia de la completa quedó en verde: el check tests pasa a verde (la completa la corre ${opt('--full-suite-by')})\n`);
    }
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
  // las de main no se repiten: su rojo no es de la historia; con sólo ellas en la lista la completa corre y espera a main
  const deMain = keep.filter((x) => x.main && x.main.sha);
  if (deMain.length) process.stderr.write(`🟡 [test-gate] de main (no hace falta repetirlas: cuando no quede otra roja, la completa espera a main): ${deMain.map((x) => x.ruta).join(', ')}\n`);
  keep = keep.filter((x) => !(x.main && x.main.sha));
  if (!keep.length) return;
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
  const base = ['bash', q(opt('--gate')), q(opt('--repo')), ...(opt('--story') ? [q(opt('--story'))] : [])].join(' ');
  process.stderr.write(`🟡 [test-gate] no corrí la suite completa: en la última fallaron ${keep.length} suite(s) y todavía no salieron verdes solas. Repetí primero cada una:\n`);
  for (const x of keep) process.stderr.write(`   ${base} --suite ${q(x.ruta)}\n`);
  process.stderr.write('   Cuando salgan todas verdes, la corrida completa arranca.\n');
  process.exit(TESTS_FAILED_PENDING);
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
  let marker = readMarker();
  // Sin marker (sin pipeline) → no-op silencioso. El check solo importa con pipeline activo. Con --force-manual sale 2:
  // es una firma, y sin ejecución abierta no hay nada que firmar (el registro de la ventana no se gasta)
  if (!marker && flag === '--force-manual') {
    console.error(`🔒 marker.js set-check ${name}: la sesión ${estado.SID} no tiene una ejecución abierta. No se escribió nada.`);
    process.exit(2);
  }
  if (!marker) process.exit(0);
  let firma = null;
  if (flag === '--force-manual') {
    // el control declarado a mano lo firma el dueño, en cualquier estado; recién con la firma se escribe, sobre el
    // marcador que quedó después de firmar
    firma = firmaDelDueno('escape:force-manual', `${name} → ${status} a mano en ${marker.storyId || 'la ejecución'}`);
    marker = readMarker();
    if (!marker) { console.error(`🔒 marker.js set-check ${name}: la ejecución se cerró mientras se firmaba. No se escribió nada.`); process.exit(2); }
  }

  if (name === 'dod') avisarBajaDePantalla(marker);
  // DoD de una story de UI NO se puede marcar manual: exige Playwright real.
  if (name === 'dod' && flag !== '--force-manual' && status === 'green' && markerStoryIsUi(marker)) {
    console.error("marker.js set-check dod: RECHAZADO — la story toca una pantalla (.tsx, .jsx, .svelte, .vue / paths FE del repo / E2E).");
    console.error("  El DoD de una story de UI NO se marca a mano: exige un E2E Playwright que asserte");
    console.error("  CADA AC de UI (regla DODRT-C5.1). Usá:");
    console.error("    marker.js run-check dod -- npx playwright test <spec> --workers=1");
    console.error("  (captura el exit code real → provenance=run-check, no falseable).");
    console.error("  Una excepción (raro, p.ej. story sin superficie de UI real) la decide la persona (la firma en la ventana de permiso o en su terminal).");
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
  appendLog('gates.log', { check: name, status, provenance: prov, storyId: marker.storyId, ...porDe(firma) });
  process.stdout.write(`check ${name}: ${status} (${prov})\n`);
}

function colaParaElRegistro(crudo) {
  try {
    const { dir: guias, aviso } = require('./harness-path.js').rutaArnesHook();   // La variable o el enlace, nunca una carpeta escrita a mano
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

/** El candado de `name` en el repo de la carpeta actual: la ruta real de la raíz de git (sin git, la carpeta). */
function runCheckLock(name) {
  let raiz = process.cwd();
  try { raiz = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || raiz; } catch (_) { /* sin git: la carpeta */ }
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
  const lockLib = path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'setup', 'harness', 'lock.js');
  const marcaDeLaPuerta = process.env.TYCON_TEST_GATE_MARK === '1';
  const lock = !marcaDeLaPuerta && fs.existsSync(lockLib) ? require(lockLib) : null;
  const { raiz, dir: lockDir } = runCheckLock(name);
  const duenio = { check: name, repo: raiz, startedAt: new Date().toISOString(), session: marker ? estado.SID : 'sin sesión' };
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
      // el 77 del turno se anota aparte: `registrarRunCheck` sólo sabe de verde y rojo, y está congelada
      if (esSinTurno(name, cmdArgv, exitCode)) registrarSinTurno(name, cmdArgv, marker, exitCode, Date.now() - t0);
      else if (marcaQueNoPisaSinTurno(name, exitCode)) process.exitCode = exitCode;
      else {
        registrarRunCheck(name, cmdArgv, marker, exitCode, Date.now() - t0, Buffer.concat(trozos).toString('utf8'));
        // la corrida de un repo hermano es parte de la corrida que la lanzó: un renglón aparte, con el mismo comando, le
        // dice al informe de repeticiones que no la cuente como otra (`registrarRunCheck` está congelada)
        if (process.env.TYCON_TEST_GATE_COMPANION === '1') appendLog('gates.log', { name: 'run-check-companion', check: name, cmd: cmdArgv.join(' ') });
      }
    } finally {
      soltar();
    }
  };
  // En Windows, un `bash` a secas se lanza con el bash de Git que devuelve `findGitBash()` del arnés, nunca con el
  // primero del PATH (puede ser el lanzador de WSL). Sin bash de Git no se lanza: el check sale rojo con el motivo
  // (story 8.17, W6 · AC 48). Un programa que en Windows es sólo un `.cmd` (`npx`) también va por el bash de Git: Node
  // no lo lanza sin shell. Fuera de Windows, y para un `.exe`, el comando va tal cual.
  const lanzar = require('./portable-tools.js').runCheckLaunch(cmdArgv);
  if (!lanzar.file) {
    process.stderr.write(`marker.js run-check: ${lanzar.error}\n`);
    retener(Buffer.from(`${lanzar.error}\n`));
    terminar(1);
    return;
  }
  try {
    hijo = spawn(lanzar.file, lanzar.args, { windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });
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

/**
 * ¿Este comando es el corredor de suites? Es el único que pide el turno de las ejecuciones grandes, así que sólo su 77
 * es «sin turno». Se reconoce por un argumento cuyo nombre de archivo es exactamente `run-suites-json.js`, o por una
 * palabra con ese nombre dentro del texto que sigue a `-c` (el portón lo lanza también con `bash -c`).
 */
function esCorredorDeSuites(cmdArgv) {
  const es = (s) => path.basename(String(s || '').replace(/^['"]|['"]$/g, '')) === 'run-suites-json.js';
  return cmdArgv.some((a, i) => es(a) || (i > 0 && cmdArgv[i - 1] === '-c' && String(a).split(/[\s;&|()]+/).some(es)));
}

/** ¿Es el 77 del turno? El del corredor de suites, en el check `tests`, lanzado por el portón. */
function esSinTurno(name, cmdArgv, exitCode) {
  return exitCode === 77 && name === 'tests' && process.env.TYCON_TEST_GATE === '1' && esCorredorDeSuites(cmdArgv);
}

/**
 * ¿Es una marca en rojo del portón (`marcar_tests_en_rojo` de test-gate.sh: un hermano o una parte que salió 75, un
 * corte, el total en rojo) sobre un check que ya quedó `sin-turno`? Ese 75 puede venir del turno, y el rojo lo
 * volvería una prueba que arreglar. Los dos dicen «no se midió»: queda `sin-turno`, que además dice qué hacer, y se
 * anota en gates.log que la marca no lo pisó.
 */
function marcaQueNoPisaSinTurno(name, exitCode) {
  if (name !== 'tests' || exitCode === 0 || process.env.TYCON_TEST_GATE_MARK !== '1') return false;
  const m = readMarker();
  if (!m || !m.checks || m.checks.tests !== 'sin-turno') return false;
  appendLog('gates.log', { check: name, status: 'sin-turno', provenance: 'test-gate', exit: exitCode, storyId: m.storyId || null,
    motivo: 'la marca en rojo del portón no pisa el sin-turno: no se midió' });
  process.stdout.write(`check ${name}: sin-turno (la marca en rojo del portón no lo pisa)\n`);
  return true;
}

/**
 * Anota el 77 del turno: el portón no corrió nada porque otra sesión tiene el turno de las ejecuciones grandes. No es
 * verde (el verde de antes no queda en pie: el código pudo cambiar) ni rojo (no hay prueba que arreglar): `sin-turno`,
 * que los cierres de los pasos frenan pidiendo el turno. Relee el marcador antes de escribir, como `registrarRunCheck`.
 */
function registrarSinTurno(name, cmdArgv, marker, exitCode, durationMs) {
  if (marker) {
    const fresh = readMarker();
    if (fresh) {
      fresh.checks = fresh.checks || {};
      fresh.checks[name] = 'sin-turno';
      fresh.checksProvenance = fresh.checksProvenance || {};
      fresh.checksProvenance[name] = 'test-gate';
      fresh.checksAt = fresh.checksAt || {};
      fresh.checksAt[name] = nowIso();
      fresh.lastTouch = nowIso();
      writeMarker(fresh);
    }
  }
  appendLog('gates.log', { check: name, status: 'sin-turno', provenance: 'test-gate', cmd: cmdArgv.join(' '), exit: exitCode,
    durationMs, storyId: marker ? marker.storyId : null });
  process.stdout.write(`check ${name}: sin-turno (test-gate, ${durationMs}ms)\n`);
  process.exitCode = exitCode;
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

function cmdSetFlag(flag, valRaw, extra = []) {
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
  const valor = valRaw === 'true' || valRaw === '1';
  // El escape de las pruebas primero lleva su motivo: sin él, la constancia dice que se saltó, no por qué.
  const motivo = flag === 'atddBypass' && valor ? motivoDe(extra) : '';
  if (flag === 'atddBypass' && valor && !motivo) {
    console.error('marker.js set-flag: el escape de las pruebas primero pide el motivo — uso: set-flag atddBypass true --reason "<por qué>"');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js set-flag: no hay marker activo para esta sesión');
    process.exit(1);
  }
  // prender el escape es un pedido: sin la firma del dueño para esta ejecución no se escribe, y el pedido queda anotado
  // para que la pueda dar (lib/atdd-skip.js)
  if (flag === 'atddBypass' && valor) {
    const d = require('./atdd-skip.js').decidir({ marker, pide: true, camino: 'set-flag atddBypass' });
    if (!d.saltea) {
      console.error(d.texto);
      process.exit(2);
    }
  }
  marker[flag] = valor;
  if (flag === 'atddBypass') {
    if (valor) marker.atddBypassReason = motivo;
    else delete marker.atddBypassReason;
  }
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
  // las horas con una entrada abierta en la sesión (lo dice la integración): el registro está abierto, sin confirmar
  const aviso = { part, message: motivo };
  if (part === 'time-tracking' && require('./external-flags.js').entradaAbierta({ repo: nn(marker.repoPath, null), sessionId: nn(marker.sessionId, null) })) aviso.unconfirmed = true;
  if (lista.some((w) => w && w.part === part && w.message === motivo && !!w.unconfirmed === !!aviso.unconfirmed)) {
    process.stdout.write(`${STEPS_LIB.startWarningLines({ startWarnings: [aviso] })[0]}\n`);
    return;
  }
  marker.startWarnings = [...lista.filter((w) => w && w.part !== part), aviso];
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'start-warning', part, motivo, ...(aviso.unconfirmed ? { unconfirmed: true } : {}), at: nowIso(), story: nn(marker.storyId, null) });
  process.stdout.write(`${STEPS_LIB.startWarningLines({ startWarnings: [aviso] })[0]}\n`);
}

// Cerrar una historia por su salida prevista: `close-as-debt --reason "<texto>" --debt <DEF-id>`. El permiso de la
// persona lo pide el freno de seguridad (ESC-C4, en la ventana de permiso) antes de que esto corra. El marcador recibe `cierre = deuda` y la ejecución
// SIGUE: la deuda tiene que llegar al commit (revisores sobre lo que sí cambió, el pase y la línea `Deuda:`); el
// `clear` del final conserva el cierre escrito. La deuda tiene que estar anotada antes: en la historia o en el
// `tasks/todo.md` de su repo.
function cmdCloseAsDebt(args) {
  // el motivo y la deuda viajan en el volcado que sube al buzón: sin rutas, credenciales ni correos (el saneador de la
  // subida); sin él en este árbol, el texto como vino
  let sanear = (t) => t;
  try { sanear = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'metrics', 'tokens-digest.js')).sanear; } catch (_) { /* sin el saneador */ }
  const motivo = String(sanear(opcion(args, 'reason'))).slice(0, 300);
  const deuda = String(sanear(opcion(args, 'debt'))).slice(0, 80);
  if (!motivo || !deuda) {
    console.error('marker.js close-as-debt: uso: close-as-debt --reason "<qué quedó pendiente y por qué>" --debt <DEF-id>');
    process.exit(2);
  }
  let marker = readMarker();
  if (!marker) {
    console.error('marker.js close-as-debt: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const story = resolveStoryPath(marker.storyPath, marker);
  let raiz = story ? path.dirname(path.dirname(story)) : null;
  if (story) {
    try { raiz = require('child_process').execFileSync('git', ['-C', path.dirname(story), 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || raiz; } catch (_) { /* sin git: la carpeta de arriba */ }
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
  // lo firma una persona, o la coordinadora por delegación; recién con la firma se escribe, sobre el marcador que quedó
  const firma = firmaDelDueno('escape:cerrar-como-deuda', `cerrar ${marker.storyId || 'la ejecución'} como deuda ${deuda}: ${motivo}`);
  marker = readMarker();
  if (!marker) { console.error('🔒 marker.js close-as-debt: la ejecución se cerró mientras se firmaba. No se escribió nada.'); process.exit(2); }
  const via = firma.constancia.via;
  marker.cierre = { estado: 'deuda', motivo, deuda, via, ...porDe(firma), at: nowIso() };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'close-as-debt', story: nn(marker.storyId, null), deuda, motivo, via, ...porDe(firma) });
  process.stdout.write(`cierre: deuda (${deuda}) — la ejecución sigue hasta el commit: revisores sobre lo que sí cambió, el pase y la línea «Deuda:» del mensaje.\n`);
}

// Levantar una deuda que se pagó antes del commit: `lift-debt --debt <DEF-id>`, con el id de la deuda del cierre. Saca
// el cierre y deja cada control en rojo esperado como el rojo que dejaría `run-check` con ese exit: «Preparar» vuelve a
// pedir todo en verde. No pide firma porque no afloja nada. Del rojo esperado queda sólo la hora de la constancia ya
// usada, si el marcador la tenía.
function cmdLiftDebt(args) {
  const deuda = String(opcion(args, 'debt') || '').trim();
  if (!deuda) {
    console.error('marker.js lift-debt: uso: lift-debt --debt <DEF-id>   (el id de la deuda del cierre, ya pagada)');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js lift-debt: no hay marker activo para esta sesión');
    process.exit(1);
  }
  if (!marker.cierre || marker.cierre.estado !== 'deuda') {
    console.error('marker.js lift-debt: la ejecución no está en deuda: no hay nada que levantar');
    process.exit(2);
  }
  if (marker.cierre.deuda !== deuda) {
    console.error(`marker.js lift-debt: la deuda del cierre es ${marker.cierre.deuda}, no ${deuda}: sólo se levanta la deuda del cierre`);
    process.exit(2);
  }
  const checks = [];
  for (const [k, v] of Object.entries(marker.checks || {})) {
    const m = /^rojo-esperado:exit=(\d+)/.exec(String(v));
    if (!m) continue;
    marker.checks[k] = `red:exit=${m[1]}`;
    checks.push(k);
  }
  const usada = ((marker.expectedRed || {}).acmatrix || {}).constanciaTs;
  if (usada) marker.expectedRed = { acmatrix: { constanciaTs: usada } };
  else delete marker.expectedRed;
  delete marker.cierre;
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'lift-debt', story: nn(marker.storyId, null), deuda, checks });
  process.stdout.write(`deuda ${deuda} levantada${checks.length ? ` — ${checks.join(', ')} vuelve(n) a ser rojo(s)` : ''}: «Preparar» vuelve a pedir todo en verde y el commit no lleva «Deuda:».\n`);
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
    console.error('marker.js expect-red: sólo en una ejecución en deuda — primero marker.js close-as-debt --reason "<texto>" --debt <DEF-id> (con el permiso de la persona en la ventana de permiso)');
    process.exit(2);
  }
  const actual = String(nn(at(marker.checks, check), ''));
  if (check === 'acmatrix') return rojoEsperadoDeLaMatriz(marker, tests, args, actual);
  const m = /^red:exit=(\d+)/.exec(actual);
  if (!m) {
    console.error(`marker.js expect-red: el control ${check} no está en rojo (${actual || 'sin registrar'}): no hay rojo que esperar`);
    process.exit(2);
  }
  // lo firma una persona, o la coordinadora por delegación, con la firma de cerrar como deuda: es lo que falta de la
  // deuda. El de la matriz tiene la suya. Recién con la firma se escribe, sobre el marcador que quedó, y sólo si sigue
  // la misma deuda y el control sigue en ese rojo
  const firma = firmaDelDueno('escape:cerrar-como-deuda', `dejar ${check} en rojo esperado (${tests.join(', ')}) en la deuda ${marker.cierre.deuda}`);
  const fresco = readMarker();
  if (!fresco || !fresco.cierre || fresco.cierre.estado !== 'deuda' || fresco.cierre.deuda !== marker.cierre.deuda
    || String(nn(at(fresco.checks, check), '')) !== actual) {
    console.error('🔒 marker.js expect-red: la ejecución cambió mientras se firmaba (se cerró, cambió de deuda o el control ya no es ese rojo). No se escribió nada.');
    process.exit(2);
  }
  fresco.checks[check] = `rojo-esperado:exit=${m[1]}`;
  fresco.expectedRed = Object.assign({}, fresco.expectedRed, { [check]: { tests, deuda: fresco.cierre.deuda, at: nowIso() } });
  fresco.lastTouch = nowIso();
  writeMarker(fresco);
  appendLog('gates.log', { name: 'expect-red', story: nn(fresco.storyId, null), check, tests, deuda: fresco.cierre.deuda, via: firma.constancia.via, ...porDe(firma) });
  process.stdout.write(`${check}: rojo-esperado:exit=${m[1]} (${tests.join(', ')}) — deuda ${fresco.cierre.deuda}\n`);
}

// El rojo esperado de la matriz: `expect-red acmatrix --tests <T1,T2> --until <AAAA-MM-DD>`. Lleva al commit los criterios
// sin evidencia en vivo que cubre la lista, hasta la fecha, con un tope de 14 días desde el cierre en deuda. Pide su propia
// firma, sobre este comando: la lista y la fecha que vio la persona. Con el control ya en rojo esperado, el mismo comando
// renueva la fecha (y la lista) dentro del mismo tope.
function rojoEsperadoDeLaMatriz(marker, tests, args, actual) {
  const previo = (marker.expectedRed || {}).acmatrix || null;
  const m = /^red:exit=(\d+)/.exec(actual) || (previo ? /^rojo-esperado:exit=(\d+)/.exec(actual) : null);
  if (!m) {
    console.error(`marker.js expect-red: el control acmatrix no está en rojo (${actual || 'sin registrar'}): no hay rojo que esperar`);
    process.exit(2);
  }
  const hasta = opcion(args, 'until');
  const tope = TOPE_DE_LA_DEUDA_EN_VIVO;
  if (!hasta) {
    console.error(`marker.js expect-red: acmatrix pide --until <AAAA-MM-DD>: hasta cuándo quedan los criterios sin evidencia en vivo (como mucho ${tope} días desde el cierre en deuda)`);
    process.exit(2);
  }
  if (!esFecha(hasta)) {
    console.error(`marker.js expect-red: «${hasta}» no es una fecha AAAA-MM-DD`);
    process.exit(2);
  }
  const cerrada = new Date(marker.cierre.at || '');
  if (!Number.isFinite(cerrada.getTime())) {
    console.error('marker.js expect-red: no sé cuándo se cerró la ejecución en deuda (cierre.at): sin eso no hay tope para la fecha');
    process.exit(2);
  }
  const hoy = fechaLocal(new Date());
  const maximo = sumarDias(fechaLocal(cerrada), tope);
  if (hasta < hoy) {
    console.error(`marker.js expect-red: la fecha ${hasta} es anterior a hoy (${hoy})`);
    process.exit(2);
  }
  if (hasta > maximo) {
    console.error(`marker.js expect-red: la fecha ${hasta} pasa el tope de ${tope} días desde el cierre en deuda: la más lejana es ${maximo}. Pasado el tope, la deuda se paga corriendo la evidencia.`);
    process.exit(2);
  }
  const story = resolveStoryPath(marker.storyPath, marker);
  let enTabla;
  try {
    enTabla = require('./story-checks.js').parseTestsTable(fs.readFileSync(story, 'utf8')).rows.map((r) => r.tid).filter(Boolean);
  } catch (e) {
    console.error(`marker.js expect-red: no pude leer la tabla ### Tests de la historia (${story || marker.storyPath}): ${e.message}`);
    process.exit(2);
  }
  const ajenas = tests.filter((t) => !enTabla.includes(t));
  if (ajenas.length) {
    console.error(`marker.js expect-red: ${ajenas.join(', ')} no está(n) en la tabla ### Tests de la historia (${story}): la lista nombra pruebas de la tabla`);
    process.exit(2);
  }
  // lo firma una persona, o la coordinadora por delegación, sobre esta lista y esta fecha: la firma es de este comando
  const firma = firmaDelDueno('escape:rojo-esperado-de-la-matriz', `${marker.storyId || 'la ejecución'}: ${tests.join(', ')} sin evidencia en vivo hasta ${hasta} (deuda ${marker.cierre.deuda})`);
  const despues = readMarker();
  if (!despues || !despues.cierre || despues.cierre.estado !== 'deuda' || despues.cierre.deuda !== marker.cierre.deuda
    || String(nn(at(despues.checks, 'acmatrix'), '')) !== actual) {
    console.error('🔒 marker.js expect-red: la ejecución cambió mientras se firmaba (se cerró, cambió de deuda o la matriz ya no es ese rojo). No se escribió nada.');
    process.exit(2);
  }
  marker = despues;
  const renovada = !!previo && /^rojo-esperado/.test(actual);
  marker.checks.acmatrix = `rojo-esperado:exit=${m[1]}`;
  marker.expectedRed = Object.assign({}, marker.expectedRed, { acmatrix: { tests, deuda: marker.cierre.deuda, at: nowIso(), until: hasta, via: firma.constancia.via, ...porDe(firma) } });
  marker.lastTouch = nowIso();
  // el renglón va antes que el marcador y sin él no se guarda nada: es lo que hace hablar al aviso de la deuda vencida,
  // y un marcador con la fecha nueva sin su renglón dejaría el aviso con la vieja
  try {
    const quien = { via: firma.constancia.via, ...porDe(firma) };
    if (renovada) appendLog('gates.log', { name: 'acmatrix-debt-renewed', story: nn(marker.storyId, null), storyPath: story, deuda: marker.cierre.deuda, tests, until: hasta, antes: previo.until || null, ...quien }, { estricto: true });
    else appendLog('gates.log', { name: 'expect-red', story: nn(marker.storyId, null), check: 'acmatrix', tests, deuda: marker.cierre.deuda, until: hasta, ...quien }, { estricto: true });
  } catch (e) {
    console.error(`marker.js expect-red: no pude anotar el rojo esperado de la matriz en gates.log (${e.code || e.message}): sin ese renglón nadie avisa cuando venza la deuda. No guardé nada; revisá la carpeta de estado y reintentá.`);
    process.exit(2);
  }
  writeMarker(marker);
  process.stdout.write(`acmatrix: rojo-esperado:exit=${m[1]} (${tests.join(', ')}) — deuda ${marker.cierre.deuda}, vence ${hasta}${renovada ? ` (antes ${previo.until || 'sin fecha'})` : ''}\n`);
}

// Una prueba que ya existía y estaba en rojo se edita con su razón: `note-red-test --test <ruta> --reason "<motivo>"`.
// La nota deja pasar el freno on-red-test-edit.js, va al contexto de los revisores y al mensaje del commit. La prueba de
// un control no pasa con una nota: la firma el dueño (red-control-test-edit).
function cmdNoteRedTest(args) {
  const prueba = opcion(args, 'test');
  const motivo = motivoDe(args);
  if (!prueba || !motivo) {
    console.error('marker.js note-red-test: uso: note-red-test --test <ruta de la prueba> --reason "<por qué la prueba está mal>"');
    process.exit(2);
  }
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js note-red-test: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const abs = path.resolve(prueba);
  const notas = (Array.isArray(marker.redTestNotes) ? marker.redTestNotes : []).filter((n) => n && n.test !== abs);
  marker.redTestNotes = [...notas, { test: abs, reason: motivo, at: nowIso() }];
  marker.lastTouch = nowIso();
  writeMarker(marker);
  appendLog('gates.log', { name: 'red-test-edit', status: 'noted', story: nn(marker.storyId, null), file: abs, reason: motivo });
  process.stdout.write(`nota anotada: ${abs} — ${motivo}\n`);
}

module.exports = {
  cmdMarkDodRuntimeChecked, cmdSetAutonomous, verifyPlaywrightEvidence, cmdMarkTestsNotScoped, cmdTestsFailed,
  cmdMarkTestsNotMeasured, cmdSetCheck, colaParaElRegistro, runCheckLock, runCheckBusyText, cmdRunCheck,
  esCorredorDeSuites, esSinTurno, marcaQueNoPisaSinTurno, registrarSinTurno, registrarRunCheck, cmdSetFlag,
  cmdStartWarning, cmdCloseAsDebt, cmdLiftDebt, cmdExpectRed, rojoEsperadoDeLaMatriz,
  cmdNoteRedTest,
};
