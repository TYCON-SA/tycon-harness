/**
 * marker-adversarial.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: el pase adversarial: lanzarlo, congelarlo, anotar su resultado o su salteo y promover sus pruebas.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  SCRIPTS_DIR, STATE_DIR, anotarSalteoEnElRegistro, appendLog,
  carpetaDeLaCorrida, estado, fs, nn, nowIso, paseAtendido, path, posixRelative,
  quitarSalteoDelRegistro, readMarker, resolveStoryPath, sellosDe,
  veredictoPaseAdversarial, writeMarker,
} = require('./marker-shared.js');

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
/**
 * Sella y congela los repos de la corrida para el pase adversarial (lib/frozen-tree.js). Sin sello o sin copia, el
 * comando frena: el pase no lee la carpeta viva.
 */
function congelarPase(marker, etiqueta, quien) {
  const ft = require('./frozen-tree.js');
  // el pase mira también el código de los repos hermanos: se sellan con los de la vuelta
  const rutas = ft.reposDelPase({ story: resolveStoryPath(marker.storyPath, marker) || marker.storyPath, repo: marker.repoPath });
  const congelada = rutas.error ? rutas
    : rutas.repos.length ? ft.sealAndFreeze({ stateDir: STATE_DIR, sid: estado.SID, etiqueta, repos: rutas.repos, tipo: 'pase', story: marker.storyId || null })
      : { repos: [] };
  if (congelada.error) {
    appendLog('gates.log', { name: 'frozen-copy', status: 'blocked', quien, motivo: congelada.error });
    console.error(`marker.js ${quien} BLOQUEADO — ${congelada.error}. El pase no lee la carpeta viva: no se anotó nada.`);
    process.exit(2);
  }
  return congelada;
}

// `freeze-adversarial`: congela lo que va a mirar el pase ANTES de lanzarlo, para pasarle sus sellos (y sus copias) en
// los args. `mark-adversarial-launched` usa estos mismos sellos; el resultado del pase los tiene que devolver.
function cmdFreezeAdversarial() {
  const marker = readMarker();
  if (!marker) {
    console.error('marker.js freeze-adversarial: no hay marker activo para esta sesión');
    process.exit(1);
  }
  const congelada = congelarPase(marker, `pase-${Date.now()}`, 'freeze-adversarial');
  const { sellos, copias } = sellosDe(congelada);
  if (Object.keys(sellos).length) marker.adversarialFrozen = { sellos, copias, at: nowIso() };
  marker.lastTouch = nowIso();
  writeMarker(marker);
  process.stdout.write(JSON.stringify({ sellos, copias }, null, 2) + '\n');
}

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
  if (marker.adversarial && marker.adversarial.sessionId === estado.SID && !relaunch) {
    console.error(
      `marker.js mark-adversarial-launched: el pase adversarial YA se lanzó en esta sesión ` +
      `(runId ${marker.adversarial.runId}, step ${marker.adversarial.launchedAtStep}). ` +
      `Corre UNA vez por corrida — el join es el paso «Pase adversarial», no un re-lanzamiento. ` +
      `Si el relanzamiento es legítimo (no-op por files vacío / diff stale), usá --relaunch (queda en bypass.log).`
    );
    process.exit(2);
  }
  if (marker.adversarial && marker.adversarial.sessionId === estado.SID && relaunch) {
    appendLog('bypass.log', {
      kind: 'ADVERSARIAL_RELAUNCH', story: marker.storyId,
      prevRunId: marker.adversarial.runId, newRunId: String(runId),
    });
    console.error('⚠️  Relanzamiento same-session con --relaunch (queda en bypass.log).');
  }
  if (marker.adversarial && marker.adversarial.sessionId !== estado.SID) {
    // Adopción de huérfano: la sesión que lo lanzó ya no existe, así que el overwrite es legítimo.
    process.stdout.write(
      `adversarial huérfano detectado (sesión ${marker.adversarial.sessionId}, ` +
      `runId ${marker.adversarial.runId}) → overwrite con relanzamiento de esta sesión\n`
    );
  }
  // Lo que mira el pase, congelado por repo (historia 8.161): un sello y una copia de sólo lectura de cada repo de la
  // corrida. Los de `freeze-adversarial`, si se congeló antes de lanzar (así el pase los recibe en sus args); si no, se
  // congela acá. El resultado del pase tiene que traer estos sellos; sin sello o sin copia, el pase no se anota lanzado.
  const previa = marker.adversarialFrozen && marker.adversarialFrozen.sellos && Object.keys(marker.adversarialFrozen.sellos).length
    ? { sellos: marker.adversarialFrozen.sellos, copias: marker.adversarialFrozen.copias || {} } : null;
  const congelada = previa ? null : congelarPase(marker, `pase-${String(runId).replace(/[^\w.-]/g, '_')}`, 'mark-adversarial-launched');
  delete marker.adversarialFrozen;
  marker.adversarial = {
    // 4 = lanzamiento temprano (cierre de «Correr las pruebas») · '5b' = fallback / relanzamiento.
    launchedAtStep: stepArg === '5b' ? '5b' : 4,
    runId: String(runId),
    sessionId: estado.SID,
    launchedAt: nowIso(),
    ...(previa || (congelada.repos.length ? sellosDe(congelada) : {})),
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
  const sk = require('./adversarial-skip.js');
  const lanzado = marker.adversarial ? (typeof marker.adversarial === 'object' ? marker.adversarial : {}) : null;
  if (lanzado) {
    // Un pase lanzado se abandona sólo con la constancia firmada por el dueño para esta ejecución.
    const p = sk.pedirFirma({ story: String(marker.storyId), carpeta: carpetaDeLaCorrida(marker), ejecucion: marker.startedAt, camino: 'abandonar el pase lanzado' });
    if (!p.ok) {
      console.error(`marker.js mark-adversarial-skipped: el pase adversarial YA se lanzó (runId ${lanzado.runId || '?'}, ${lanzado.launchedAt || 'sin fecha'}) — un pase lanzado se cierra con su resultado:`);
      console.error('    marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --tests <k> …');
      console.error(`  Abandonarlo lo firma una persona, no el agente (${p.motivo}), y queda en bypass.log como ADVERSARIAL_ABANDONADO.`);
      process.stderr.write(p.texto);
      process.exit(2);
    }
  }
  if (!args.includes('--repo')) args.push('--repo', marker.repoPath || process.cwd());
  const story = resolveStoryPath(marker.storyPath, marker);
  if (!args.includes('--story') && story) args.push('--story', story);
  // spawnSync y no execFileSync: con exit 0 execFileSync no devuelve el stderr.
  const r = require('child_process').spawnSync(process.execPath,
    [path.join(SCRIPTS_DIR, 'pipeline.js'), 'deep-review-gate', ...args],
    { windowsHide: true, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let gate = null;
  // la salida 3 es «corre, y espera su turno»: un veredicto legible, que niega el salteo como cualquier otro `run: true`
  if (r.status === 0 || r.status === 3) { try { gate = JSON.parse(r.stdout); } catch (_e) { gate = null; } }
  if (!gate || typeof gate !== 'object') {
    const detalle = String(r.stderr || '').trim()
      || (r.error && r.error.message)
      || `el portón salió ${r.status} sin decir por qué${r.stdout ? ` (stdout: ${String(r.stdout).trim().slice(0, 200)})` : ''}`;
    console.error(`marker.js mark-adversarial-skipped: no pude evaluar el portón — ${detalle}`);
    console.error('  «No pude mirar» no es «se puede saltear»: arreglá la llamada (los --files del diff, partidos) y repetí. No se anotó nada.');
    process.exit(2);
  }
  // «preguntar» y «esperar» no son un salteo: el pase queda pendiente hasta que alguien conteste la pregunta
  if (gate.run === false && (gate.decision === 'ask' || gate.decision === 'wait')) {
    console.error(`marker.js mark-adversarial-skipped: el portón no saltea el pase, ${gate.decision === 'ask' ? 'pide preguntarle a la persona' : 'pide esperar a la persona'} — ${gate.reason || '(sin reason)'}`);
    console.error('  Se anota la pregunta (marker.js review-ask --kind code) y se espera la respuesta (marker.js review-answer); con «review» se');
    console.error('  lanza, con «skip» se vuelve a correr este comando. No se anotó nada.');
    process.exit(3);
  }
  if (gate.run !== false) {
    console.error(`marker.js mark-adversarial-skipped: el portón dice que el pase CORRE — ${gate.reason || '(sin reason)'}`);
    if (Array.isArray(gate.sign_commands) && gate.sign_commands.length) {
      console.error('  El pedido de saltear no alcanza: lo firma una persona, no el agente, y después se repite este comando:');
      console.error(`    en la ventana de permiso: ${gate.sign_commands[0]}`);
      if (gate.sign_commands[1]) console.error(`    en su terminal:           ${gate.sign_commands[1]}`);
    }
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
  if (abandonado && !gate.adversarial_skip) {
    console.error('marker.js mark-adversarial-skipped: el pase ya se lanzó y el portón no trae la constancia firmada: no se abandona. No se anotó nada.');
    process.exit(2);
  }
  const runId = abandonado ? (lanzado.runId || null) : null;
  const at = nowIso();
  const salteo = sk.salteoDelPorton(gate, { archivos, abandonado, runId, at });
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
    archivos, abandonado, runId, ...(salteo.firmado ? { firmado: salteo.firmado } : {}),
  });
  // El registro de autoría lo dice, se haya escrito antes o se escriba después.
  if (salteo.firmado) anotarSalteoEnElRegistro(marker, salteo.firmado);
  if (abandonado) {
    appendLog('bypass.log', { kind: 'ADVERSARIAL_ABANDONADO', storyId: marker.storyId, runId, motivo: salteo.motivo, firmado: salteo.firmado });
    console.error(`⚠️  pase adversarial ABANDONADO (runId ${runId || '?'}) con la constancia firmada por una persona — queda en bypass.log.`);
  } else if (salteo.firmado) {
    appendLog('bypass.log', { kind: 'ADVERSARIAL_SKIP_FIRMADO', storyId: marker.storyId, motivo: salteo.motivo, firmado: salteo.firmado });
    console.error(`⚠️  pase adversarial salteado con la constancia firmada por el ${salteo.firmado.quien} (huella ${salteo.firmado.huella}) — queda en bypass.log.`);
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
    ...(traeVeredicto ? { run: d.run, files: Array.isArray(d.files) ? d.files.map(String) : [],
      // «preguntar» o «esperar» al dueño: `next` lo pide en vez de leer el run:false como salteo
      decision: d.decision === 'ask' || d.decision === 'wait' ? d.decision : null } : {}),
    early_launch: early,
    at: nowIso(),
    sessionId: estado.SID,
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
/**
 * `mark-adversarial-result <N> --adhoc --result <archivo>`: la constancia del pase del camino rápido de la sesión, en el
 * registro del carril, con la huella de sus archivos de código. Como en una corrida, el número sale del resultado y un
 * pase sin medir no deja constancia; cada confirmado va a la suite o se difiere con motivo (`--tests`, `--own`,
 * `--deferred` + `--reason`). Se anota después de arreglar: la huella es la de ese momento.
 */
function anotarPaseDelCarril({ confirmados, marker, flag }) {
  const salir = (t) => { console.error(`marker.js mark-adversarial-result --adhoc: ${t}`); process.exit(2); };
  if (marker) salir('hay una corrida abierta en esta sesión: manda la corrida. Anotalo sin --adhoc.');
  const io = require('./story-gate-io.js');
  const a = io.adhocFirmado(STATE_DIR, estado.SID, io.readAdhoc(STATE_DIR, estado.SID));
  if (!a) salir('esta sesión no tiene un camino rápido abierto con su firma (marker.js adhoc set).');
  const ruta = flag('--result');
  if (!ruta) salir('el pase se anota con --result <archivo>: el JSON que devolvió. El número sale de ahí, no del que anota.');
  let medicion;
  try {
    medicion = require('./adversarial-verdict.js').medicionDelResultado(JSON.parse(fs.readFileSync(path.resolve(ruta), 'utf8')),
      { resultado: path.resolve(ruta), repo: process.cwd() });
  } catch (e) {
    salir(`--result ${ruta}: no lo pude leer (${String(e.message).split('\n')[0]}) — no se anotó nada.`);
  }
  if (medicion.confirmados !== confirmados) salir(`<N> = ${confirmados} pero el resultado trae ${medicion.confirmados} confirmado(s) — no se anotó nada.`);
  if (!medicion.medido) salir(`el pase quedó sin medir (${medicion.motivo}): relanzalo; un pase que no revisó todo no deja constancia.`);
  const num = (k) => { const v = flag(k); if (v === undefined) return 0; if (!/^\d+$/.test(String(v))) salir(`${k} '${v}' tiene que ser un entero ≥ 0`); return parseInt(v, 10); };
  const pruebas = num('--tests'), propias = num('--own'), diferidos = num('--deferred');
  if (confirmados > 0 && pruebas + propias + diferidos !== confirmados) salir(`--tests ${pruebas} + --own ${propias} + --deferred ${diferidos} ≠ ${confirmados} confirmados: cada hallazgo va a la suite o se difiere con motivo.`);
  if (diferidos > 0 && !String(flag('--reason') || '').trim()) salir(`${diferidos} diferido(s) sin --reason.`);
  const ab = require('./adhoc-base.js');
  const huella = ab.huellaDelCarril(a);
  if (!ab.huellaCompleta(huella)) salir('git no contestó al medir el carril: la huella quedó incompleta y no sirve de constancia. Reintentá.');
  io.writeAdhoc(STATE_DIR, estado.SID, { ...io.readAdhoc(STATE_DIR, estado.SID), pase: {
    huella, at: new Date().toISOString(), confirmados, pruebas, propias, diferidos, motivo: flag('--reason') || null,
    modelo: flag('--model') || null, resultado: path.resolve(ruta),
  } });
  console.log(JSON.stringify({ ok: true, adhoc: true, confirmados, huella }, null, 2));
}

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
  if (argv.includes('--adhoc')) { anotarPaseDelCarril({ confirmados, marker, flag }); return; }
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
  // los hermanos que cambiaron después del lanzamiento y quedan para la próxima vuelta de revisores
  let alReloop = null;
  if (tipo === '5b' || resultadoRuta !== undefined) {
    const { medicionDelResultado, SALIDA_APROBADA } = require('./adversarial-verdict.js');
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
    // El resultado tiene que ser de lo que se congeló al lanzar el pase: los mismos sellos, repo por repo, y las copias
    // intactas (historia 8.161). Un lanzamiento sin sellos (de antes) no se compara.
    const lanzado = corrida && corrida.adversarial && typeof corrida.adversarial === 'object' ? corrida.adversarial : null;
    if (tipo === '5b' && lanzado && lanzado.sellos && Object.keys(lanzado.sellos).length) {
      const traidos = obj.sellos && typeof obj.sellos === 'object' && !Array.isArray(obj.sellos) ? obj.sellos : null;
      const motivoSellos = !traidos ? 'no trae `sellos` (los del lanzamiento, repo por repo)'
        : (() => {
          const faltan = Object.keys(lanzado.sellos).filter((r) => !(r in traidos));
          const sobran = Object.keys(traidos).filter((r) => !(r in lanzado.sellos));
          const otros = Object.keys(lanzado.sellos).filter((r) => r in traidos && traidos[r] !== lanzado.sellos[r]);
          if (faltan.length) return `le falta el sello de ${faltan.join(', ')}`;
          if (sobran.length) return `trae el sello de un repo que no se lanzó: ${sobran.join(', ')}`;
          if (otros.length) return `trae otro sello para ${otros.map((r) => `${r} (${traidos[r]}, se lanzó ${lanzado.sellos[r]})`).join(', ')}`;
          return null;
        })();
      if (motivoSellos) {
        console.error(`marker.js mark-adversarial-result: --result ${abs} ${motivoSellos}: no es el resultado de lo que se congeló al lanzar el pase — no se anotó nada.`);
        process.exit(2);
      }
      const ft = require('./frozen-tree.js');
      for (const [repo, tree] of Object.entries(lanzado.sellos)) {
        const copia = (lanzado.copias || {})[repo];
        const c = copia ? ft.verify(repo, copia, tree) : { ok: false, error: `la copia de la vuelta no está anotada: repo ${repo}, sello ${tree}` };
        if (!c.ok) {
          appendLog('gates.log', { name: 'frozen-copy', status: 'blocked', quien: 'mark-adversarial-result', repo, tree });
          console.error(`marker.js mark-adversarial-result BLOQUEADO — ${c.error}. No se anotó nada.`);
          process.exit(2);
        }
      }
      // El código de los repos hermanos (los sellados que no son la historia ni el repo de la corrida) no puede haber
      // cambiado desde el lanzamiento: el pase daría por bueno algo que no miró. Las pruebas propias que este cierre
      // declara (`--in`) se escriben a propósito después del pase y no cuentan. Con hallazgos, el cambio es el arreglo:
      // como en el repo principal, lo cubre la vuelta de revisores que sigue, si la última sella ese hermano (así
      // «Preparar» frena si lo guardado no es lo que revisó). Un hermano que no se pudo comparar frena siempre.
      const principales = ft.reposDe([resolveStoryPath(corrida.storyPath, corrida) || corrida.storyPath, corrida.repoPath]);
      const hermanos = principales.error ? Object.keys(lanzado.sellos) : Object.keys(lanzado.sellos).filter((r) => !principales.repos.includes(r));
      const iIn = argv.indexOf('--in');
      const permitidos = rutasDeLasPropias(iIn >= 0 ? String(nn(argv[iIn + 1], '')).split(',').map((s) => s.trim()).filter(Boolean) : [], corrida);
      const cambiados = ft.hermanosCambiados({ sellos: lanzado.sellos, hermanos, permitidos });
      const vuelta = cambiados.length && confirmados > 0 ? ft.ultimaVuelta(STATE_DIR, estado.SID, 'revisores') : null;
      const sellaLaVuelta = (r) => Boolean(vuelta && (vuelta.repos || []).some((x) => x.repo === r && x.tree));
      if (vuelta && cambiados.every((x) => !x.error && sellaLaVuelta(x.repo))) {
        alReloop = cambiados;
        console.error(`ℹ️  marker.js mark-adversarial-result: un repo hermano tiene cambios desde el lanzamiento del pase; con ${confirmados} hallazgo(s) es el arreglo, y lo revisa la próxima vuelta de revisores: «Preparar» frena si lo guardado no es lo revisado.`);
        for (const x of cambiados) console.error(`   · ${path.basename(x.repo)}: ${x.files.join(', ')}`);
      } else if (cambiados.length) {
        appendLog('gates.log', { name: 'frozen-sibling', status: 'blocked', quien: 'mark-adversarial-result', repos: cambiados.map((x) => x.repo) });
        console.error('marker.js mark-adversarial-result BLOQUEADO — el código de un repo hermano cambió después de lanzar el pase: el pase no miró esto.');
        for (const x of cambiados) console.error(`   · ${path.basename(x.repo)}: ${x.error || x.files.join(', ')}`);
        console.error('  Relanzá el pase sobre lo de ahora (freeze-adversarial y mark-adversarial-launched --relaunch). No se anotó nada.');
        process.exit(2);
      }
    }
    const lanz = lanzado ? Date.parse(lanzado.launchedAt) : NaN;
    // la prueba de cada lente limpia se mira en disco: junto al resultado, de este pase (desde su lanzamiento)
    try { medicion = medicionDelResultado(obj, { resultado: abs, repo: (corrida && corrida.repoPath) || process.cwd(), desde: lanz }); } catch (e) {
      console.error(`marker.js mark-adversarial-result: --result ${abs}: ${e.message} — no se anotó nada.`);
      process.exit(2);
    }
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
      { windowsHide: true, cwd: (corrida && corrida.repoPath) || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
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
    ...(alReloop ? { hermanos_al_reloop: alReloop.map((x) => ({ repo: x.repo, files: x.files })) } : {}),
  };
  if (alReloop) appendLog('gates.log', { name: 'frozen-sibling', status: 'al-re-loop', quien: 'mark-adversarial-result', storyId, repos: pase.hermanos_al_reloop });
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
    // Un pase que corrió y midió: si la ejecución no tiene un salteo firmado, el registro de autoría no puede decirlo.
    if (tipo === '5b' && corrida.deepReviewDone && !require('./adversarial-skip.js').firmasDelSalteo(corrida).length) quitarSalteoDelRegistro(corrida);
  }
  process.stdout.write(JSON.stringify({ storyId, ...pase }, null, 2) + '\n');
}

/**
 * Las rutas absolutas de las pruebas propias que declara `--in`, resueltas como las resuelve `verificarPruebasPropias`:
 * relativas al repo de la corrida, o `(<repo>) <ruta>` dentro de ese repo. Una que no resuelve queda tal cual: no libera
 * nada, y `verificarPruebasPropias` la rechaza con su motivo.
 */
function rutasDeLasPropias(rutas, marker) {
  let base = (marker && marker.repoPath) || null;
  if (!base) {
    try { base = require('./repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { base = null; }
  }
  base = base || process.cwd();
  const companionLib = require('./companion-repos.js');
  let hermanos = null;
  return rutas.map((ruta) => {
    const conRepo = companionLib.parseRepoPrefixed(ruta);
    if (!conRepo) return path.resolve(base, ruta);
    if (!hermanos) hermanos = companionLib.companionRoots(base, marker && marker.storyPath);
    const { root } = companionLib.resolveRepoRef(conRepo.ref, base, hermanos);
    return root ? path.resolve(root, conRepo.rest) : ruta;
  });
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
    try { base = require('./repo-attrib.js').gitRoot(process.cwd()); } catch (_e) { base = null; }
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
  const { isTestPath } = require('./atdd-order.js');
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
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
  const companionLib = require('./companion-repos.js');
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
      let mtime;
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
  if (require('./ledger-honesty.js').esProbe(dest)) {
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

module.exports = {
  congelarPase, cmdFreezeAdversarial, cmdMarkAdversarialLaunched, cmdMarkAdversarialSkipped, cmdMarkAdversarialGate,
  anotarPaseDelCarril, cmdMarkAdversarialResult, verificarPruebasPropias, cmdPromoteProbe,
};
