/**
 * marker-signatures.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: las firmas y las exenciones que da una persona (o la coordinadora por delegación).
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  MARKER_JS, PEDIDA, PREVIO, PROPIA, SCRIPTS_DIR, STATE_DIR, anotarAprobacion,
  anotarFirma, appendLog, at, carpetaDeLaCorrida, comprobarLoRevisado,
  delegatedSigning, esFecha, estado, fechaLocal, firmaDelDueno, fs,
  hermanosDeLaCorrida, nn, nowIso, os, ownerWindow, path, porDe, readMarker,
  reposParaComparar, resolveStoryPath, trabajarSobreElDestino, writeMarker,
} = require('./marker-shared.js');

// La carpeta de la corrida, creada si falta. En el chequeo antes de la ventana no se crea: alcanza con que la story dé
// su clave (la crea el comando de verdad, después de la firma). Null si la story no da clave.
// `marker`: el de la corrida que se firma (puede ser de otra sesión, con --for-session): su carpeta es la de la regla.
function carpetaParaLaFirma(repo, storyId, storyAbs, marker) {
  const pl = require('../pipeline.js');
  if (!PREVIO) return pl.resolveRunDir(repo, storyId, true, storyAbs, { marker: marker || null });
  return pl.resolveRunDir(repo, storyId, false, storyAbs, { marker: marker || null }) || (pl.runDirKey(storyId, storyAbs).key ? path.join(repo, '.advisors', 'pipeline-runs') : null);
}

// Quién firmó, para la constancia: la coordinadora por delegación o la persona en la ventana (owner-window.js).
function quienFirmo(firma, persona) {
  return require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).quienFirmo(firma, persona);
}

// El renglón `<firma>-signed` de una firma que el guion ya confirmó en la terminal con su propia pregunta.
function firmadoEnLaTerminal(firma, resumen) {
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const sesion = PROPIA !== '_nosession' ? PROPIA : estado.SID || null;
  ow.firmar({ firma, via: 'terminal', sesion, destino: estado.SID || null, resumen, anotar: anotarFirma });
  return trabajarSobreElDestino(ow, { via: 'terminal', sesion, destino: estado.SID || null });
}

/**
 * Lo que la deuda acepta de una matriz en rojo (DODRT-C6), o null si no aplica: sin la ejecución en deuda o sin el rojo
 * esperado de la matriz. `{ acepta, acs, tests, until, motivos }`: acepta sólo los criterios sin correr que cubre la
 * lista, antes de su fecha, y nada más pendiente (imposibles sin firma, acción no ejercida, pantalla sin imagen, código
 * sin leer). `motivos`: lo que no acepta, dicho.
 */
/**
 * Los criterios sin correr que quedan fuera del rojo esperado vigente de la deuda: los que cubre la lista, antes de su
 * fecha, ya tienen su salida (la deuda), así que no frenan la exención de los imposibles-declarados. Sin deuda, sin rojo
 * esperado de la matriz o vencido, todos los sin correr, como siempre.
 */
function sinCorrerFueraDeLaDeuda(marker, matrix) {
  const notRun = matrix.notRun || [];
  const er = marker && (marker.expectedRed || {}).acmatrix;
  if (!notRun.length || !er || !marker.cierre || marker.cierre.estado !== 'deuda') return notRun;
  if (!/^rojo-esperado/.test(String(at(marker.checks, 'acmatrix') || ''))) return notRun;
  if (!esFecha(er.until) || fechaLocal(new Date()) > er.until) return notRun;
  const tests = Array.isArray(er.tests) ? er.tests.map(String) : [];
  const cubiertos = new Set(require('../runtime-matrix.js').debtCoverage(matrix, tests).covered);
  return notRun.filter((n) => !cubiertos.has(n));
}

/**
 * Las comprobaciones de la firma por la ventana, sin firmar: `{ matrix, pedidos }` si la firma pasaría, o `{ rechazo: { code,
 * lineas } }` con el porqué. Las usan la firma (`runtimeWaiverConOk`) y el chequeo previo (`check-runtime-waiver`), así
 * que el chequeo dice exactamente lo que la firma va a decir.
 */
function pedidoDeFirma(storyPath, argv, m) {
  const { val } = opcionesDe(argv);
  let pedidos = [...new Set(String(val('--acs') || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  const no = (code, ...lineas) => ({ rechazo: { code, lineas } });
  const wd = require('./waiver-display.js');
  const tanda = val('--batch');
  if (argv.includes('--batch') && (!tanda || String(tanda).startsWith('-'))) return no(2, 'marker.js runtime-waiver: --batch sin el nombre de la tanda.');
  if (m) {
    // con una corrida abierta, la tanda es la que anotó la corrida: otra pedida a mano mediría otra cosa
    if (tanda) return no(2, `🚫 marker.js runtime-waiver: no se firmó — hay una ejecución abierta en ${estado.SID !== PROPIA ? `la sesión ${estado.SID}` : 'esta sesión'}, y manda la tanda de la ejecución (${m.batch || 'sin tanda: todas'}): pedila sin --batch.`);
    // sólo la historia de la corrida abierta: una copia en otra ruta mostraría a la persona otra cosa que la que se firma
    if (!wd.esLaDelMarcador(storyPath, m)) return no(2, `🚫 marker.js runtime-waiver: no se firmó — ${storyPath} no es la historia de la corrida abierta en ${estado.SID !== PROPIA ? `la sesión ${estado.SID}` : 'esta sesión'}${m.storyPath ? ` (${m.storyPath})` : ''}.`);
  } else if (!require('../runtime-matrix.js').discoverRepoRoot(storyPath)) {
    // sin corrida, la constancia queda en el repo de la historia (`.tycon/runtime-waivers.jsonl`), para commitearla: el
    // mismo repo que la matriz toma como `repoRoot`. Fuera de git no hay dónde, y la firma va a la terminal
    return no(2, `🚫 marker.js runtime-waiver: no se firmó — ${storyPath} no está en un repo git: sin una corrida abierta, la firma desde la sesión deja su constancia en el repo de la historia, para commitearla.`,
      `   La firma una persona en su terminal: node ${MARKER_JS} runtime-waiver ${storyPath} --terminal`);
  }
  // la matriz de «Preparar el pull request»: con tanda anotada, los criterios sin correr de las otras tandas no niegan la firma.
  // Sin corrida, la tanda pedida con --batch, medida igual (el cuadro calcula la misma: scripts/lib/owner-window.js)
  const matrix = wd.matrixForSignature(storyPath, m, { batch: m ? null : tanda });
  if (matrix.structuralError) return no(2, `marker.js runtime-waiver: la matriz no computa (${matrix.structuralError}).`);
  // una tanda pedida que la matriz no pudo medir sola (sin criterios, o sin la lista de cambios): firmar con ella
  // dejaría pasar criterios de otras tandas
  if (tanda && !matrix.batch) {
    const porQue = (matrix.warnings || []).find((w) => /mido todas las tandas/.test(w));
    return no(2, `🚫 marker.js runtime-waiver: no se firmó — no pude medir sólo la tanda ${tanda}${porQue ? ` (${porQue})` : ''}.`);
  }
  const deOtraTanda = matrix.batch ? pedidos.filter((n) => !matrix.acs.includes(n)) : [];
  if (deOtraTanda.length) return no(2, `🚫 marker.js runtime-waiver: no se firmó — AC ${deOtraTanda.join(', ')} no es de la tanda medida (${matrix.batch}): se firma ${m ? 'en la corrida de su tanda' : 'con --batch de su tanda'}.`);
  // los que cubre el rojo esperado vigente de la deuda ya tienen su salida: no frenan la exención de los imposibles
  const notRun = sinCorrerFueraDeLaDeuda(m, matrix);
  if (notRun.length) {
    // la pista de qué declarar la imprime sólo el chequeo previo: la salida de la firma queda como estaba
    return { ...no(2, `🚫 marker.js runtime-waiver RECHAZADO — hay criterios SIN CORRER que no se pueden eximir: AC ${notRun.map((n) => '#' + n).join(', ')}. Los corre el agente.`),
      pista: '   O, si de verdad no se pueden probar en vivo, se declaran en el frontmatter `runtime_not_verifiable:` (reason + covered_by).' };
  }
  const pend = new Set(matrix.notVerifiable || []);
  // sin --acs, todos los pendientes: la ventana los muestra en el comando que la persona aprueba
  if (!pedidos.length) pedidos = [...pend].sort((a, b) => a - b);
  if (!pedidos.length) return no(2, 'marker.js runtime-waiver: no hay criterios declarados imposibles de probar en vivo pendientes de firma.');
  const ajenos = pedidos.filter((n) => !pend.has(n));
  if (ajenos.length) return no(2, `marker.js runtime-waiver: AC ${ajenos.join(', ')} no está(n) declarado(s) imposible(s) de probar en vivo y pendiente(s) de firma.`);
  return { matrix, pedidos };
}

/**
 * `runtime-waiver <spec> --acs n,m --approved-by "<el dev>"`: firma los criterios declarados imposibles de probar en vivo
 * con la aprobación de la persona en la ventana de permiso, en la misma cadena que la firma por terminal
 * (la matriz la lee igual) y con su línea en approvals.jsonl. Sólo los criterios nombrados, y sólo si están pendientes.
 */
function runtimeWaiverConOk(storyPath, argv, m) {
  const waiver = require('./runtime-waiver.js');
  const { val } = opcionesDe(argv);
  // lo firma la persona que vio el criterio: el ok reenviado por otra sesión no vale acá
  if (argv.includes('--relayed-by')) {
    console.error('🚫 marker.js runtime-waiver: no se firmó — el ok para un criterio que no se puede probar en vivo no se acepta reenviado');
    console.error('   por otra sesión: lo da la persona que lo vio, en la ventana de permiso o en su terminal.');
    process.exit(2);
  }
  const pedido = pedidoDeFirma(storyPath, argv, m);
  if (pedido.rechazo) { for (const l of pedido.rechazo.lineas) console.error(l); process.exit(pedido.rechazo.code); }
  const { matrix, pedidos } = pedido;
  // la persona lo aprueba en la ventana de permiso; la cita en la conversación ya no alcanza
  if (val('--quote')) {
    console.error('🚫 marker.js runtime-waiver: no se firmó — la cita ya no firma un criterio que no se puede probar en vivo: lo aprueba la persona');
    console.error(`   en la ventana de permiso (este comando sin --quote) o en su terminal: node ${MARKER_JS} runtime-waiver ${storyPath} --terminal`);
    process.exit(1);
  }
  const firma = firmaDelDueno('runtime-waiver', `criterios ${pedidos.join(', ')} de ${matrix.sid}, imposibles de probar en vivo`);
  const quien = String(val('--approved-by') || process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona').trim();
  const e = quienFirmo(firma, quien);
  const declHashByAc = {};
  for (const n of pedidos) declHashByAc[n] = waiver.declHashFor(matrix.perAc[n].declReason, matrix.perAc[n].coveredBy);
  const repoRoot = matrix.repoRoot || null;
  // la sesión que pidió la firma: va dentro del ok, que entra en la cadena (cambiarla a mano descarta la firma)
  const sesion = PROPIA !== '_nosession' ? PROPIA : null;
  const entry = waiver.appendWaiver({
    story: matrix.key || matrix.sid, acs: pedidos, matrixHash: matrix.hash, approvedBy: e.quien, nowIso: nowIso(), declHashByAc,
    logPath: repoRoot ? waiver.repoWaiverLogPath(repoRoot) : undefined,
    ok: { tipo: e.tipo, quien: e.quien, via: e.via, ...(sesion ? { sesion } : {}) },
  });
  appendLog('gates.log', { type: 'RUNTIME_WAIVER', story: matrix.sid, acs: pedidos, matrixHash: matrix.hash, approvedBy: e.quien, via: e.via,
    ...(sesion ? { sesion } : {}), ...(matrix.batch ? { batch: matrix.batch } : {}) });
  const mk = { ...(m || {}), repoPath: repoRoot || (m && m.repoPath) || null, storyId: (m && m.storyId) || matrix.sid, storyPath };
  for (const n of pedidos) {
    anotarAprobacion(mk, { que: `AC ${n} imposible de verificar en vivo`, via: e.via, tipo: e.tipo, quien: e.quien, ...(e.delegacion ? { delegacion: e.delegacion } : {}) });
  }
  if (repoRoot) console.error(`📌 Firmado en ${waiver.repoWaiverLogPath(repoRoot)} — commitealo: así vale en otra máquina y en CI.`);
  console.error(`✅ Firmado en la ventana de permiso (${e.quien}): story ${matrix.sid}, AC ${pedidos.join(',')}. Cadena: ${entry.chain}`);
  process.exit(0);
}

// ============================================================
// Un crítico lo decide una persona
// ============================================================
// `waive-critical --rule <id> --file <f> --reason "<r>"` deja la constancia de que una persona eximió ese CRITICAL, y
// sólo así `write-findings` y los cierres de «Hallazgos» y «Preparar el pull request» aceptan un CRITICAL `waived`. Dos caminos:
//   1. la ventana de permiso: el agente corre el comando (sin `--quote` ni `--relayed-by`) y el dev lo aprueba ahí; el
//      guion comprueba en el árbol de procesos que lo lanzó la herramienta con ese comando (scripts/lib/owner-window.js).
//   2. `--terminal`: lo corre el dev en su terminal (o la ventana nueva en Windows), como `runtime-waiver`.
// El agente solo no exime: la cita o el reenvío ya no firman, y sin la ventana ni la terminal frena.
function opcionesDe(argv) {
  // una bandera seguida de otra bandera no tiene valor: `--approved-by --quote x` no aprueba a nombre de «--quote»
  const val = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; return v === undefined || /^--/.test(v) ? '' : v; };
  return { val, tiene: (n) => argv.includes(n) };
}

// `plan-review [--for-session <D>]`: la revisión automática del plan (lib/plan-review.js). Con `--for-session` la lanza
// la sesión designada sobre el plan de otra; sin él, la propia sesión sobre el suyo (informativa sólo si no puede firmar:
// story delicada o `routine_approval: person`). No es una firma y no escribe el marcador destino. Sin `--result`, prepara
// y devuelve los args del pase en modo plan y el comando que lo corre con el revisor de la organización; con `--result
// <json del pase>` (o `--no-tool "<motivo>"`), anota el veredicto en la constancia de la sesión que la lanzó. El
// resultado vale sólo desde la ruta que nombró la preparación (el `--out` del comando): uno de otra ruta lo pudo escribir
// cualquiera, y queda sin veredicto.
function cmdPlanReview(argv) {
  const pr = require('./plan-review.js');
  const { val } = opcionesDe(argv);
  const destino = PEDIDA || PROPIA;
  const informativa = destino === PROPIA;
  const conSesion = informativa ? '' : ` --for-session ${destino}`;
  const resultado = val('--result');
  const sinHerramienta = val('--no-tool');
  if (resultado === null && sinHerramienta === null) {
    const p = pr.preparar({ lanza: PROPIA, destino, estado: STATE_DIR });
    if (p.codigo) { console.error(`🔒 marker.js plan-review: ${p.motivo}. No se escribió nada.`); process.exit(p.codigo); }
    const comando = pr.comandoLite(p.argsFile, pr.rutaResultado(STATE_DIR, PROPIA, destino));
    process.stdout.write(`${JSON.stringify({ scriptPath: path.join(SCRIPTS_DIR, 'adversarial-verify.workflow.js'), args: p.args, argsFile: p.argsFile, delicate: p.delicate,
      informativa: p.informativa, comando, lite: comando, despues: `marker.js plan-review${conSesion} --result <resultado.json> --model ${p.args.model}` }, null, 2)}\n`);
    if (p.informativa) console.error('ℹ️  revisión informativa (la story es delicada o la organización pide el click): informa, y el plan lo firma una persona.');
    if (p.delicate && p.delicate.value) console.error(`⚠️  la story es delicada (${p.delicate.reason}): la revisión ataca y avisa, pero el plan lo aprueba el dev.`);
    process.exit(0);
  }
  let res = null;
  let ilegible = false;
  let noVale = null;
  // sólo el resultado que dejó el corredor donde lo nombró la preparación; las dos rutas, resueltas
  const real = (r) => { try { return fs.realpathSync(r); } catch (_e) { return path.resolve(r); } };
  if (resultado !== null && real(resultado) !== real(pr.rutaResultado(STATE_DIR, PROPIA, destino))) {
    noVale = 'el resultado no vino del corredor';
    console.error(`🔒 marker.js plan-review: el resultado tiene que estar en ${pr.rutaResultado(STATE_DIR, PROPIA, destino)} (el --out del comando que devolvió la preparación): queda sin veredicto.`);
    ilegible = true;
  } else if (resultado !== null) {
    try { res = JSON.parse(fs.readFileSync(resultado, 'utf8')); } catch (e) {
      console.error(`🔒 marker.js plan-review: no pude leer el resultado del pase (${resultado}: ${e.code || e.message}): queda sin veredicto.`);
      res = null;
      ilegible = true;
    }
  }
  const c = pr.anotar({ lanza: PROPIA, destino, estado: STATE_DIR, resultado: res, sinHerramienta: sinHerramienta !== null ? (sinHerramienta || 'sin motivo') : null,
    noVale, modelo: val('--model') || 'opus', proveedor: val('--provider') || 'anthropic' });
  if (c.codigo) { console.error(`🔒 marker.js plan-review: ${c.motivo}`); process.exit(c.codigo); }
  const lineas = [`revisión automática del plan de ${c.storyId} (sesión ${destino}${c.informativa ? ', informativa' : ''}): ${c.veredicto}${c.motivo ? ` — ${c.motivo}` : ''}`];
  const renglon = (h) => `- [${h.lente || '?'}${h.severidad ? `, ${h.severidad}` : ''}] ${h.resumen}${h.archivo && h.archivo !== 'plan' ? ` (${h.archivo}${h.linea ? `:${h.linea}` : ''})` : ''}`;
  for (const h of c.hallazgos) lineas.push(renglon(h));
  if (c.notas && c.notas.length) {
    lineas.push(`Notas para implementar (no rechazan con el corte «${c.corte}»):`);
    for (const h of c.notas) lineas.push(renglon(h));
  }
  if (c.informativa) lineas.push('Es informativa: el plan lo firma una persona.');
  else if (!pr.APROBADOS.includes(c.veredicto)) lineas.push('El plan espera a una persona: esta revisión no lo aprueba.');
  if (c.reintentar) lineas.push(`El plan cambió mientras corría: se reintenta una vez sobre el plan cerrado (marker.js plan-review${conSesion}).`);
  if (ilegible) lineas.push(noVale ? `El resultado del pase no se puede usar (${noVale}): este comando sale 3.` : 'El resultado del pase no se pudo leer: este comando sale 3.');
  process.stdout.write(`${lineas.join('\n')}\n`);
  process.exit(ilegible ? 3 : 0);
}

// `review-ask --kind plan|code`: anota que se le pregunta al dueño si revisar el plan o el código de esta sesión, justo
// antes de mostrar el cuadro de opciones. No es una firma: sólo un renglón `review-ask` en gates.log.
function cmdReviewAsk(argv) {
  const pr = require('./plan-review.js');
  const { val } = opcionesDe(argv);
  const kind = val('--kind');
  const h = pr.huellaDe({ estado: STATE_DIR, sesion: PROPIA, kind });
  if (h.codigo) { console.error(`🔒 marker.js review-ask: ${h.motivo}. No se escribió nada.`); process.exit(h.codigo); }
  const r = pr.anotarPregunta({ estado: STATE_DIR, sesion: PROPIA, kind, huella: h.huella });
  if (r.codigo) { console.error(`🔒 marker.js review-ask: ${r.motivo}. No se escribió nada.`); process.exit(r.codigo); }
  process.stdout.write(`pregunta anotada: revisar el ${kind === 'plan' ? 'plan' : 'código'} de la sesión ${PROPIA}. Con la respuesta: marker.js review-answer --kind ${kind} --choice review|skip|wait\n`);
  process.exit(0);
}

// `review-answer --kind plan|code --choice review|skip|wait [--for-session <D>] [--by-profile]`: anota la respuesta a la
// pregunta de revisar. La corre quien la recibe: la propia sesión o, con `--for-session`, sólo la designada. No escribe el
// marcador destino: sólo un renglón `review-answer` en gates.log. «skip» del código lo contesta el dueño: pide la firma
// `review-skip` (su ventana, su click o su «aprobado», nunca la delegación), y su vía queda en el renglón. Con
// `--by-profile` lo anota sin firma, con `por: 'perfil'`, sólo si el dueño cuenta como ausente y la celda de «dueño
// ausente» dice `skip` para ese diff (plan-review.js skipPorElPerfil).
function cmdReviewAnswer(argv) {
  const pr = require('./plan-review.js');
  const { val } = opcionesDe(argv);
  const sesion = PEDIDA || PROPIA;
  const ajena = sesion !== PROPIA;
  if (ajena) {
    let d = null;
    let causa = null;
    try { d = pr.designadaDeVerdad(STATE_DIR); } catch (e) { causa = String((e && e.message) || e).split('\n')[0]; }
    if (d !== PROPIA) {
      const porque = causa ? ` (no se pudo saber cuál es: ${causa})` : d ? '' : ' (no hay designada)';
      console.error(`🔒 marker.js review-answer --for-session ${sesion}: la respuesta para otra sesión la anota la coordinadora designada, y ésta no lo es${porque}. No se escribió nada.`);
      process.exit(2);
    }
  }
  const kind = val('--kind');
  const h = pr.huellaDe({ estado: STATE_DIR, sesion, kind });
  if (h.codigo) { console.error(`🔒 marker.js review-answer: ${h.motivo}. No se escribió nada.`); process.exit(h.codigo); }
  const choice = val('--choice');
  const porPerfil = argv.includes('--by-profile');
  if (porPerfil && !(kind === 'code' && choice === 'skip')) {
    console.error('🔒 marker.js review-answer: --by-profile vale sólo para --kind code --choice skip. No se escribió nada.');
    process.exit(2);
  }
  let via = null;
  if (kind === 'code' && choice === 'skip') {
    if (porPerfil) {
      const c = pr.skipPorElPerfil({ estado: STATE_DIR, sesion, huella: h.huella });
      if (c.codigo) { console.error(`🔒 marker.js review-answer --by-profile: ${c.motivo}. No se escribió nada.`); process.exit(c.codigo); }
    } else {
      const f = firmaDelDueno('review-skip', `contestar «skip» a la pregunta del pase del código de la sesión ${sesion}`);
      via = f.via || null;
    }
  }
  const r = pr.anotarRespuesta({ estado: STATE_DIR, sesion, kind, choice, quien: ajena ? `coordinadora ${PROPIA}` : `sesión ${PROPIA}`, huella: h.huella, motivo: val('--reason') || null,
    via, por: porPerfil ? 'perfil' : null });
  if (r.codigo) { console.error(`🔒 marker.js review-answer: ${r.motivo}. No se escribió nada.`); process.exit(r.codigo); }
  process.stdout.write(`respuesta anotada para la sesión ${sesion}: ${val('--choice')} (${kind}).\n`);
  process.exit(0);
}

// `owner-away set --phrase "<lo que dijo>" | clear [--reason "<por qué>"] | get`: la marca del dueño ausente
// (scripts/lib/owner-away.js). La pone quien recibe el mensaje del dueño; no es una firma.
function cmdOwnerAway(argv) {
  const oa = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-away.js'));
  const { val } = opcionesDe(argv);
  const accion = argv[0];
  if (accion === 'set') {
    // la frase la tipeó la persona en esta sesión, en los últimos 30 minutos: el agente no se pone la marca solo
    const ap = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-approvals.js'));
    const r = oa.set({ estado: STATE_DIR, quien: `sesión ${PROPIA}`, frase: val('--phrase'), verificar: (frase) => ap.fraseTipeadaReciente({ sesion: PROPIA, frase }) });
    if (r.codigo) { console.error(`🔒 marker.js owner-away set: ${r.motivo}. No se escribió nada.`); process.exit(r.codigo); }
    process.stdout.write(`marca de ausente puesta (${r.mark.setAt}): las revisiones siguen la celda de «persona ausente» hasta que la persona vuelva o pasen 24 h.\n`);
    process.exit(0);
  }
  if (accion === 'clear') {
    const r = oa.clear({ estado: STATE_DIR, motivo: val('--reason') || `la sacó la sesión ${PROPIA}` });
    if (r.problem) { console.error(`marker.js owner-away clear: la marca sigue puesta: ${r.problem}.`); process.exit(1); }
    process.stdout.write(r.cleared ? 'marca de ausente sacada.\n' : 'no había marca de ausente.\n');
    process.exit(0);
  }
  if (accion === 'get') {
    const g = oa.get({ estado: STATE_DIR });
    if (g.problem) console.error(`marker.js owner-away get: ${g.problem}; la persona cuenta como presente.`);
    // la marca que no se pudo confirmar sigue puesta: se muestra aparte, para que no parezca que no hay ninguna
    if (g.unconfirmed) console.error(`marker.js owner-away get: marca de ausente sin confirmar (puesta ${g.unconfirmed.setAt}): no se borró; se va con el próximo mensaje de la persona o con clear.`);
    process.stdout.write(`${JSON.stringify({ mark: g.mark, ...(g.problem ? { problem: g.problem } : {}), ...(g.unconfirmed ? { unconfirmed: g.unconfirmed } : {}) })}\n`);
    process.exit(0);
  }
  console.error('uso: marker.js owner-away set --phrase "<lo que dijo la persona>" | clear [--reason "<por qué>"] | get');
  process.exit(2);
}

function cmdWaiveCritical(argv) {
  const cw = require('./critical-waivers.js');
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
    runDir = carpetaParaLaFirma(m.repoPath || process.cwd(), String(m.storyId), storyAbs, m);
  } catch (e) { console.error(`marker.js waive-critical: no pude calcular la carpeta de la corrida (${e.message})`); process.exit(2); }
  if (!runDir) { console.error('marker.js waive-critical: la story no da una clave para su carpeta de corrida'); process.exit(2); }
  let entrada;
  let firmaDada = null;
  if (tiene('--terminal')) {
    const waiver = require('./runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
      const v = waiver.abrirVentana({ script: MARKER_JS, args: ['waive-critical', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js waive-critical: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`} — no se eximió nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) waiver.dentroDeLaVentana();
    if (!waiver.hasTty()) {
      console.error('🔒 marker.js waive-critical --terminal BLOQUEADO — necesita una terminal de verdad: lo corre el dev, no el agente.');
      console.error(`     node ${MARKER_JS} waive-critical ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
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
    firmaDada = firmadoEnLaTerminal('critical-waiver', `${rule}${file ? ` en ${file}` : ''}: ${reason}`);
    entrada = { tipo: 'manual', quien, via: 'waive-critical (terminal)' };
  } else {
    // eximir un crítico lo aprueba la persona en la ventana de permiso; la cita en la conversación ya no alcanza
    if (val('--relayed-by') || val('--quote')) {
      console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — la cita o el reenvío ya no eximen un crítico: lo aprueba la persona en la ventana de permiso (este comando sin --quote ni --relayed-by) o en su terminal (--terminal).`);
      process.exit(1);
    }
    const firma = firmaDelDueno('critical-waiver', `${rule}${file ? ` en ${file}` : ''}: ${reason}`);
    firmaDada = firma;
    const quien = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona';
    if (firma.automatica) {
      // la de trámite la da el arnés porque el perfil del equipo delega critical-waiver: la constancia nombra a quien la
      // pidió (la coordinadora, si la pidió para otra sesión) y a la persona en cuyo nombre se firma, para que los
      // lectores de la exención la reconozcan como la delegación
      const pidio = firma.sesion && firma.sesion !== firma.destino ? `coordinadora (sesión ${firma.sesion})` : `sesión ${firma.sesion || PROPIA}`;
      const persona = (val('--approved-by') || '').trim() || quien;
      const noEs = cw.noEsPersona(persona);
      if (noEs) { console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — ${noEs}. Va el nombre de la persona en cuyo nombre se firma: --approved-by "<nombre>".`); process.exit(2); }
      entrada = { tipo: 'automatica', quien: `${pidio}, firma de trámite del arnés`,
        delegacion: `${persona}${cw.POR_EL_PERFIL} (approvals.delegated_signing)`, via: 'waive-critical (firma de trámite · arnés)' };
    } else {
      const q = quienFirmo(firma, quien);
      entrada = { ...q, via: `waive-critical (${q.via})` };
    }
  }
  // Primero el renglón del registro del arnés (que el agente no puede escribir): es lo que hace valer la constancia al
  // cerrar. Si no quedó escrito, no se anota nada ni se anuncia un éxito que después el cierre contradiría.
  const constancia = { ts: nowIso(), rule_id: rule, file, reason, ...entrada };
  // la constancia que los cierres van a rechazar no se anota ni se anuncia como eximida
  const mala = cw.constanciaInvalida(constancia);
  if (mala) { console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — la constancia no valdría (${mala}).`); process.exit(2); }
  appendLog('gates.log', { name: 'critical-waiver', status: 'ok', story: m.storyId, rule, file, ts: constancia.ts, tipo: constancia.tipo, quien: constancia.quien, via: constancia.via, huella: cw.huella(constancia) });
  const enRegistro = cw.fueraDelRegistro(constancia, { story: m.storyId });
  if (enRegistro) {
    console.error(`🚫 marker.js waive-critical: no se eximió ${rule} — no pude dejar el renglón en el registro del arnés (${enRegistro}). Sin él la exención no vale.`);
    process.exit(2);
  }
  const linea = cw.anotar(runDir, constancia);
  anotarAprobacion(m, { que: `exencion ${rule}${file ? ` en ${file}` : ''}`, via: entrada.via, tipo: entrada.tipo, quien: entrada.quien, ...porDe(firmaDada),
    ...(entrada.delegacion ? { delegacion: entrada.delegacion } : {}), ...(entrada.cita ? { cita: entrada.cita, cita_cuando: entrada.cita_cuando } : {}) });
  console.error(`✅ ${rule}${file ? ` en ${file}` : ''} eximido (${linea.tipo === 'manual' ? 'manual' : 'automático, por delegación'}, ${linea.quien}${linea.delegacion ? ` por ${linea.delegacion}` : ''}). Ahora sí se puede anotar como waived en findings.json.`);
  process.exit(0);
}

// `compare-waiver --story <historia> --command <candidato> --reason "<motivo>" [--terminal]`: la constancia de que una
// persona eximió a un candidato de la comparación con main (historia 8.167, lib/compare-waiver.js). Pide la firma
// `compare-waiver` (nivel 1): el dueño en la ventana o en su terminal, o la coordinadora si el perfil del equipo la
// delega. Un comando que no es candidato de la historia se niega antes de pedir la firma.
function cmdCompareWaiver(argv) {
  const cw = require('./compare-waiver.js');
  const { val, tiene } = opcionesDe(argv);
  const command = (val('--command') || '').trim();
  const reason = (val('--reason') || '').trim();
  if (!command || !reason) {
    console.error('marker.js compare-waiver: faltan --command <candidato> y --reason "<por qué>" (y --story <historia>).');
    process.exit(2);
  }
  const m = readMarker();
  if (!m) { console.error('marker.js compare-waiver: no hay marker activo para esta sesión'); process.exit(1); }
  const storyAbs = resolveStoryPath(val('--story') || m.storyPath, m);
  const deLaCorrida = resolveStoryPath(m.storyPath, m);
  if (!storyAbs || !deLaCorrida || path.resolve(storyAbs) !== path.resolve(deLaCorrida)) {
    console.error(`marker.js compare-waiver: la historia ${val('--story') || '(ninguna)'} no es la de la corrida abierta (${m.storyPath || 'sin historia'}). No se pidió la firma.`);
    process.exit(2);
  }
  // el candidato, antes de la firma: una exención de algo que no es candidato no exime nada y gastaría la firma
  // con la tanda de la corrida, los mismos candidatos que exige el freno de «Preparar»
  let c;
  let tanda;
  try {
    const cp = require('./compare-previous.js');
    tanda = cp.archivosDeLaTanda(m, storyAbs);
    c = cp.candidatos({ storyPath: storyAbs, repos: reposParaComparar(m), files: tanda.files });
  } catch (e) {
    console.error(`marker.js compare-waiver: no pude calcular los candidatos (${e.message}). No se pidió la firma.`);
    process.exit(2);
  }
  const nombres = [...c.candidatos.map((x) => x.archivo), ...c.sinRepo.map((x) => x.archivo)];
  if (!nombres.includes(command) && tanda.files) {
    // de otra tanda: está en la historia y no en la lista de la tanda de la corrida
    const cpv = require('./compare-previous.js');
    const norm = cpv.rutaDeLaLista;
    const deLaHistoria = cpv.rutasAModificar(fs.readFileSync(storyAbs, 'utf8')).map(norm);
    if (deLaHistoria.includes(norm(command)) && !tanda.files.map(norm).includes(norm(command))) {
      console.error(`marker.js compare-waiver: «${command}» no es de la tanda ${tanda.tanda}, la de esta corrida: la comparación con main mide sólo sus archivos. Los candidatos: ${nombres.length ? nombres.join(', ') : '(ninguno)'}. No se pidió la firma.`);
      process.exit(2);
    }
  }
  if (!nombres.includes(command)) {
    const noMedido = (c.noMedidos || []).find((x) => x.archivo === command);
    if (noMedido) {
      console.error(`marker.js compare-waiver: «${command}» no se pudo mirar (${noMedido.motivo}): el freno lo da «no medido», no pide exención. No se pidió la firma.`);
      process.exit(2);
    }
    console.error(`marker.js compare-waiver: «${command}» no es candidato de la comparación de esta historia. Los candidatos: ${nombres.length ? nombres.join(', ') : '(ninguno)'}. No se pidió la firma.`);
    process.exit(2);
  }
  let runDir = null;
  try { runDir = carpetaParaLaFirma(m.repoPath || process.cwd(), String(m.storyId), storyAbs, m); } catch (e) {
    console.error(`marker.js compare-waiver: no pude calcular la carpeta de la corrida (${e.message})`);
    process.exit(2);
  }
  if (!runDir) { console.error('marker.js compare-waiver: la historia no da una clave para su carpeta de corrida'); process.exit(2); }
  const resumen = `eximir ${command} de la comparación con main en ${m.storyId}: ${reason}`;
  let entrada;
  let firmaDada = null;
  if (tiene('--terminal')) {
    const waiver = require('./runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
      const v = waiver.abrirVentana({ script: MARKER_JS, args: ['compare-waiver', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js compare-waiver: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`} — no se eximió nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) waiver.dentroDeLaVentana();
    if (!waiver.hasTty()) {
      console.error('🔒 marker.js compare-waiver --terminal BLOQUEADO — necesita una terminal de verdad: lo corre el dev, no el agente.');
      process.exit(2);
    }
    let resp;
    try {
      resp = waiver.promptTty(`\n════════ EXIMIR DE LA COMPARACIÓN CON MAIN · story ${m.storyId} ════════\nComando: ${command}\nPor qué: ${reason}\n\n¿Lo eximís? El cambio de ese comando entra sin compararse con la versión de main. (si / no) > `);
    } catch (e) { console.error(`🔒 ${e.message}`); process.exit(2); }
    if (!/^s(i|í)?$/i.test(String(resp || '').trim())) { console.error('marker.js compare-waiver: no lo eximiste — el candidato sigue pidiendo su humo comparado.'); process.exit(1); }
    if (waiver.esWindows() && !waiver.confirmarFrase()) { console.error('🔒 marker.js compare-waiver: la frase no coincide — no se eximió nada.'); process.exit(1); }
    const quien = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'tty-user';
    firmaDada = firmadoEnLaTerminal('compare-waiver', resumen);
    entrada = { tipo: 'manual', quien, via: 'compare-waiver (terminal)' };
  } else {
    // por la delegación, sólo en una historia de rutina
    const firma = firmaDelDueno('compare-waiver', resumen, { antes: (via) => (via === 'delegacion' ? require('./plan-review.js').rutinaParaDelegar({ marker: m }) : null) });
    firmaDada = firma;
    const q = quienFirmo(firma, process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona');
    entrada = { ...q, via: `compare-waiver (${q.via})` };
  }
  const constancia = { ts: nowIso(), story: String(m.storyId), command, reason, ...entrada };
  const mala = cw.constanciaInvalida(constancia);
  if (mala) { console.error(`🚫 marker.js compare-waiver: no se eximió ${command} — la constancia no vale (${mala}).`); process.exit(2); }
  // primero el renglón del registro del arnés (que el agente no escribe): es lo que hace valer la constancia
  appendLog('gates.log', cw.renglonDelRegistro(constancia));
  if (cw.fueraDelRegistro(constancia, { stateDir: STATE_DIR, story: m.storyId })) {
    console.error(`🚫 marker.js compare-waiver: no se eximió ${command} — no pude dejar el renglón en el registro del arnés. Sin él la exención no vale.`);
    process.exit(2);
  }
  cw.anotar(runDir, constancia);
  anotarAprobacion(m, { que: `exencion de la comparacion ${command}`, via: entrada.via, tipo: entrada.tipo, quien: entrada.quien, ...porDe(firmaDada),
    ...(entrada.delegacion ? { delegacion: entrada.delegacion } : {}) });
  console.error(`✅ ${command} eximido de la comparación con main (${constancia.tipo === 'manual' ? 'manual' : 'por delegación'}, ${constancia.quien}). «Preparar el pull request» lo avisa, y el texto del pedido también.`);
  process.exit(0);
}

// `sign-atdd-skip --story S --reason R [--terminal]`: la firma del dueño que saltea «pruebas primero» en la ejecución
// de S (lib/atdd-skip.js). La ejecución sale de la última muestra de S que anotó el pedido (`--no-atdd`, `set-flag
// atddBypass` o el portón previo), no del marcador: en la terminal del dueño no hay sesión. Sin muestra sale 1 sin
// escribir nada; la cita, el reenvío y el --ok no firman.
function cmdSignAtddSkip(argv) {
  const sk = require('./atdd-skip.js');
  const { val, tiene } = opcionesDe(argv);
  if (tiene('--terminal')) {
    const waiver = require('./runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
      const v = waiver.abrirVentana({ script: MARKER_JS, args: ['sign-atdd-skip', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js sign-atdd-skip: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`} — no se firmó nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) waiver.dentroDeLaVentana();
  }
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const r = sk.firmar({
    story: (val('--story') || '').trim(), motivo: (val('--reason') || '').trim(), argv: process.argv.slice(1), sesion: estado.SID || null,
    exigir: (o) => ow.exigir(o),
    aprobar: (linea, entrada) => {
      const m = readMarker();
      if (m && String(m.storyId) === String(linea.story)) anotarAprobacion(m, entrada);
      else require('./approvals.js').anotar(linea.carpeta, entrada);
    },
  });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js sign-atdd-skip: no se firmó el salteo — ${r.motivo}`);
    process.exit(r.codigo);
  }
  if (r.aviso) console.error(`⚠️  ${r.aviso}`);
  appendLog('gates.log', { name: 'atdd-skip-recorded', status: 'ok', story: r.linea.story, camino: r.linea.camino, via: r.linea.via, huella: r.linea.huella });
  console.error(`✅ salteo de «pruebas primero» firmado (historia ${r.linea.story}, vía ${r.linea.via}, huella ${r.linea.huella}). Vale para esa ejecución entera.`);
  process.exit(0);
}

// `sign-adversarial-skip --story S --reason R [--terminal]`: la firma del dueño que saltea el pase adversarial de la
// ejecución de S (lib/adversarial-skip.js). La ejecución y el camino salen de la última muestra de S que anotó el
// pedido; sin muestra sale 1 sin escribir nada. La firma va por la ventana de permiso o por la terminal del dueño; la
// cita, el reenvío y el --ok no firman.
function cmdSignAdversarialSkip(argv) {
  const sk = require('./adversarial-skip.js');
  const { val, tiene } = opcionesDe(argv);
  const story = (val('--story') || '').trim();
  const motivo = (val('--reason') || '').trim();
  if (tiene('--terminal')) {
    const waiver = require('./runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la firma: seguí ahí.');
      const v = waiver.abrirVentana({ script: MARKER_JS, args: ['sign-adversarial-skip', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js sign-adversarial-skip: ${v.estado === 'vencida' ? 'la ventana venció sin firmar' : `no pude abrir la ventana (${v.motivo})`} — no se firmó nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) waiver.dentroDeLaVentana();
  }
  // Sin la huella la constancia va sin máquina (no es una de sus llaves), y se dice.
  let maquina = null;
  let sinHuella = null;
  try {
    const h = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'machine-id.js')).huella();
    maquina = h.huella || null;
    if (!maquina) sinHuella = h.error || 'la huella no se pudo medir';
  } catch (e) { sinHuella = String(e.message || e).split('\n')[0]; }
  if (sinHuella) console.error(`⚠️  la constancia va sin la huella de esta máquina (${sinHuella}).`);
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const r = sk.firmarSalteo({
    story, motivo, argv: process.argv.slice(1), sesion: estado.SID || null, maquina,
    exigir: (o) => ow.exigir(o),
    aprobar: (linea, entrada) => {
      const m = readMarker();
      if (m && String(m.storyId) === String(linea.story)) anotarAprobacion(m, entrada);
      else require('./approvals.js').anotar(linea.carpeta, entrada);
    },
  });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js sign-adversarial-skip: no se firmó el salteo — ${r.motivo}`);
    process.exit(r.codigo);
  }
  if (r.aviso) console.error(`⚠️  ${r.aviso}`);
  appendLog('gates.log', { name: 'adversarial-skip-recorded', status: 'ok', story: r.linea.story, camino: r.linea.camino, via: r.linea.via, huella: r.linea.huella });
  console.error(`✅ salteo del pase adversarial firmado (story ${r.linea.story}, ${r.linea.camino}, vía ${r.linea.via}, huella ${r.linea.huella}). El portón lo saltea en esta ejecución.`);
  process.exit(0);
}

// `approve-pending --id <CÓDIGO> [--repo <carpeta>] [--for-session <sesión>] [--terminal]`: la aprobación de un pendiente
// nuevo de la lista de pendientes (scripts/lib/pending-approvals.js). El pendiente tiene que estar abierto en la lista del
// repo; la firma va por la ventana de permiso, la terminal del dueño o la delegación del perfil: la coordinadora, desde
// su pestaña, con --for-session <la sesión que lo abrió> y sólo sobre un repo de esa sesión (delegated-signing.js).
// Recién con la firma se escribe la línea del registro.
// `declare-pending --id <CÓDIGO> [--repo <carpeta>]`: la sesión que abrió un pendiente en una copia que armó ella (modo
// ágil, sin ejecución ni arreglo rápido) lo declara suyo, para que la coordinadora lo apruebe por delegación con
// --for-session (delegated-signing.js motivoDelRepo). No aprueba nada: anota la sesión, el código y la carpeta real.
// La sesión es la del proceso: el freno niega este comando con una variable de sesión escrita en él.
function cmdDeclarePending(argv) {
  const PA = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'pending-approvals.js'));
  const DS = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js'));
  const { val, tiene } = opcionesDe(argv);
  const id = (val('--id') || '').trim();
  if (!id) { console.error('uso: marker.js declare-pending --id <código del pendiente> [--repo <carpeta>]'); process.exit(2); }
  if (tiene('--for-session')) { console.error('🚫 marker.js declare-pending: un pendiente lo declara la sesión que lo abrió, no otra por ella.'); process.exit(1); }
  if (PROPIA === '_nosession') { console.error('🚫 marker.js declare-pending: no sé de qué sesión es el pedido: se declara desde la sesión que abrió el pendiente.'); process.exit(1); }
  const r = DS.raizDelRepo(path.resolve(val('--repo') || process.cwd()));
  if (!r) { console.error(`marker.js declare-pending: ${val('--repo') || process.cwd()} no es un repo de git.`); process.exit(2); }
  let todo;
  try { todo = fs.readFileSync(path.join(r.ruta, PA.TODO), 'utf8'); } catch (e) { console.error(`marker.js declare-pending: no pude leer ${PA.TODO} de ${r.ruta} (${e.code || e.message}).`); process.exit(2); }
  if (!PA.pendientesAbiertos(todo).some((p) => p.codigo === id)) { console.error(`marker.js declare-pending: ${id} no es un pendiente abierto (\`- [ ] [${id}] …\`) en ${path.join(r.ruta, PA.TODO)}.`); process.exit(1); }
  try { appendLog('gates.log', { name: DS.DECLARADO, status: 'ok', sesion: PROPIA, id, repo: r.clave, ruta: r.ruta }, { estricto: true }); } catch (e) {
    console.error(`marker.js declare-pending: no pude anotarlo en el registro de firmas (${e.code || e.message}).`); process.exit(2);
  }
  console.error(`✅ ${id} declarado por esta sesión en ${r.ruta}. No lo apruebes desde acá: mandale a la coordinadora el código y la carpeta, y ella corre desde su pestaña \`marker.js approve-pending --id ${id} --repo ${r.ruta} --for-session ${PROPIA}\`. Sin coordinadora, lo aprueba la persona: corré \`marker.js approve-pending --id ${id} --repo ${r.ruta}\` solo y mostrale el cuadro que da el freno.`);
  process.exit(0);
}

function cmdApprovePending(argv) {
  const PA = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'pending-approvals.js'));
  const { val, tiene } = opcionesDe(argv);
  const id = (val('--id') || '').trim();
  if (!id) { console.error('uso: marker.js approve-pending --id <código del pendiente> [--repo <carpeta>] [--terminal]'); process.exit(2); }
  if (tiene('--quote') || tiene('--relayed-by') || tiene('--ok')) {
    console.error('🚫 marker.js approve-pending: la cita, el reenvío y --ok no aprueban: la aprobación es una firma (la delegación, la ventana o --terminal).');
    process.exit(1);
  }
  let repo = val('--repo');
  try {
    repo = require('child_process').execFileSync('git', ['-C', path.resolve(repo || process.cwd()), 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { console.error(`marker.js approve-pending: ${repo || process.cwd()} no es un repo de git.`); process.exit(2); }
  let todo; let registro;
  try { todo = fs.readFileSync(path.join(repo, PA.TODO), 'utf8'); } catch (e) { console.error(`marker.js approve-pending: no pude leer ${PA.TODO} de ${repo} (${e.code || e.message}).`); process.exit(2); }
  try { registro = PA.registroDelDisco(repo) || ''; } catch (e) {
    console.error(`marker.js approve-pending: no pude leer el registro de aprobaciones (${e.code || e.message}).`); process.exit(2);
  }
  const pendiente = PA.pendientesAbiertos(todo).find((p) => p.codigo === id);
  if (!pendiente) { console.error(`marker.js approve-pending: ${id} no es un pendiente abierto (\`- [ ] [${id}] …\`) en ${path.join(repo, PA.TODO)}: se aprueba lo que está escrito.`); process.exit(1); }
  const leido = PA.leerRegistro(registro);
  if (leido.ilegibles.length) { console.error(`marker.js approve-pending: el registro de aprobaciones tiene renglones que no se leen (${leido.ilegibles.join(', ')}): no se firma sobre un registro roto.`); process.exit(1); }
  // en el chequeo antes de la ventana sale 1: sin eso la ventana se abre para una firma que no escribe nada
  if (leido.lineas.some((x) => !PA.motivoDe(x.valor) && x.valor.id === id)) { console.error(`✅ ${id} ya estaba aprobado: no escribí nada.`); process.exit(PREVIO ? 1 : 0); }
  let maquina = null;
  try { maquina = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'machine-id.js')).huella().huella || null; } catch (_) { /* va sin máquina */ }
  const linea = PA.lineaNueva({ id, maquina });
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const { casaDeLaCuenta } = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'real-home.js'));
  // la firma va al registro de la casa de la cuenta: es el que lee el pre-commit
  // sin persona, los mismos controles que la delegación, comprobados acá y no sólo en el freno: la sesión que pide no es
  // la que abrió el pendiente, es la coordinadora confirmada, y el repo es de la sesión destino
  const DS = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js'));
  const antes = (via, reg) => DS.antesDelPendiente({ via, registro: reg, propia: PROPIA === '_nosession' ? null : PROPIA, pedida: PEDIDA, estado: STATE_DIR, cwd: process.cwd(), repo, pendiente: id });
  const r = ow.exigir({ firma: PA.FIRMA, argv: process.argv.slice(1), resumen: `huella ${linea.huella} · ${id} · ${pendiente.linea.slice(0, 140)}`, casa: casaDeLaCuenta(), propia: undefined, antes });
  if (r.codigo !== 0) { console.error(`🔒 marker.js approve-pending: no se aprobó ${id} — ${r.motivo}`); process.exit(r.codigo); }
  const persona = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona';
  const q = r.via === 'terminal' ? { tipo: 'manual', quien: persona } : quienFirmo(r, persona);
  const escrita = { ...linea, via: PA.viaDeLaFirma(r), quien: q.quien, ...(q.delegacion ? { delegacion: q.delegacion } : {}), ...(r.sesion ? { sesion: r.sesion } : {}) };
  // cada aprobación en su archivo: dos ramas que aprueban a la vez no chocan en el merge
  const archivo = PA.archivoDe(escrita);
  try {
    fs.mkdirSync(path.join(repo, PA.RECORD_DIR), { recursive: true });
    fs.writeFileSync(path.join(repo, archivo), `${JSON.stringify(escrita)}\n`, { flag: 'wx' });
  } catch (e) { console.error(`🔒 marker.js approve-pending: la firma se dio, pero no pude escribir ${archivo} (${e.code || e.message}).`); process.exit(2); }
  console.error(`✅ ${id} aprobado (${r.via}, ${escrita.quien}). Queda en ${archivo}: commitealo junto con la lista.`);
  process.exit(0);
}

// Las firmas `-signed` del gates.log de la corrida `m` (save-ok.js exencionesDeLaCorrida: su sesión, la que adoptó o
// su story): el ok por delegación mira si hubo una exención. El log no se lee a medias: si no se puede leer entero,
// tira, y el ok por delegación no se da.
function firmasDeLaCorrida(m) {
  const p = path.join(STATE_DIR, 'gates.log');
  // sin el registro no se sabe si hubo exenciones: tira, como un registro grande o un renglón de firma que no se lee
  // se lee entero: el registro de una máquina ya ronda los 6 MB y nada lo rota; el tope sólo frena uno desmedido
  const tam = fs.statSync(p).size;
  if (tam > 128 * 1024 * 1024) throw new Error(`${p} pasa de 128 MB: no lo leo entero, y una exención vieja quedaría afuera`);
  const texto = fs.readFileSync(p, 'utf8');
  const firmadas = [];
  for (const l of texto.split('\n')) {
    if (!l.includes('-signed')) continue;
    let j;
    try { j = JSON.parse(l); } catch (_) { throw new Error(`${p} tiene un renglón de firma que no se lee: podría ser una exención`); }
    if (j && /-signed$/.test(String(j.name))) firmadas.push(j);
  }
  return require('./save-ok.js').exencionesDeLaCorrida(firmadas, m);
}

// `approve-save [--for-session <D>] [--terminal]`: el ok de guardar la story (commit, push y los pedidos) es la firma
// `save` (lib/save-ok.js). La da el dueño en la ventana o en su terminal, o la coordinadora por la delegación del
// perfil: por delegación, antes de gastar el pedido, la corrida tiene que estar limpia, el cambio no tocar nada sensible
// y el aviso tiene que haberle llegado al dueño. La constancia `saveOk` (las huellas de cada repo) queda en el marcador
// de la corrida y en el renglón `save-signed`; `save-check` dice si sigue valiendo.
function cmdApproveSave(argv) {
  const { tiene } = opcionesDe(argv);
  if (tiene('--quote') || tiene('--relayed-by') || tiene('--ok')) {
    console.error('🚫 marker.js approve-save: la cita, el reenvío y --ok no dan el ok de guardar: es una firma (la delegación, la ventana o --terminal).');
    process.exit(1);
  }
  const m = readMarker();
  if (!m) { console.error(`marker.js approve-save: la sesión ${estado.SID} no tiene una ejecución abierta: el ok de guardar es de una corrida.`); process.exit(2); }
  const so = require('./save-ok.js');
  let repos;
  try { repos = so.reposDeLaCorrida({ marker: m, hermanos: hermanosDeLaCorrida(m) }); } catch (e) {
    console.error(`🔒 marker.js approve-save: no pude saber qué repos guarda la corrida (${e.message}): sin eso no hay ok de guardar.`);
    process.exit(2);
  }
  // lo que se firma, ¿es lo revisado? (historia 8.161): se dice, y si cambió después de la última vuelta, no se firma
  comprobarLoRevisado(m, 'approve-save');
  let previo = null;
  let ok = null;
  const antes = (via) => {
    let datos = {};
    if (via === 'delegacion') {
      const rd = carpetaDeLaCorrida(m);
      let findings;
      try { findings = rd ? JSON.parse(fs.readFileSync(path.join(rd, 'findings.json'), 'utf8')) : null; } catch (e) { findings = null; }
      if (!Array.isArray(findings)) return { codigo: 2, motivo: 'la coordinadora no puede dar el ok: no pude leer el findings.json de la corrida. Lo firma una persona: ni el agente ni la coordinadora' };
      let firmas;
      try { firmas = firmasDeLaCorrida(m); } catch (e) { return { codigo: 2, motivo: `la coordinadora no puede dar el ok: no pude leer el registro de firmas (${e.code || e.message}). Lo firma una persona: ni el agente ni la coordinadora` }; }
      const notify = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'notify.js'));
      // lo sensible: sólo si el perfil le delega a la coordinadora la forma `save:sensible`, con las mismas llaves
      let sensibleDelegado = false;
      try {
        const cat = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
        sensibleDelegado = !!require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js')).delegaSinVentana({ firma: cat.SAVE_SENSIBLE, sesion: PROPIA, destino: estado.SID, estado: STATE_DIR, home: os.homedir() }).ok;
      } catch (e) { sensibleDelegado = false; }
      datos = { findings, firmasDeLaCorrida: firmas, canales: () => notify.canalesDeLaSesion(), mandar: (o) => notify.avisar(o), sensibleDelegado };
    }
    const r = so.antesDeFirmar({ via, marker: m, repos, ...datos });
    if (r.codigo) return r;
    previo = r;
    return null;
  };
  const extra = ({ via, sesion, destino }) => {
    ok = so.constancia({ marker: m, via, por: sesion && sesion !== destino ? sesion : null, previo, ahora: nowIso() });
    return { storyId: ok.storyId, startedAt: ok.startedAt, huellas: ok.huellas, ...(ok.canales ? { canales: ok.canales } : {}) };
  };
  const firma = firmaDelDueno('save', `guardar la story ${m.storyId} (${repos.map((r) => path.basename(r)).join(', ')})`, { antes, extra });
  // con la firma, el destino quedó fijo y la corrida comparada: se relee para no pisar lo que cambió en el medio
  const fresco = readMarker() || m;
  fresco.saveOk = ok;
  fresco.lastTouch = nowIso();
  writeMarker(fresco);
  const persona = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona';
  const q = quienFirmo(firma, persona);
  anotarAprobacion(fresco, { que: 'el ok de guardar la story (commit, push y los pedidos)', via: q.via, tipo: q.tipo, quien: q.quien, ...porDe(firma), ...(q.delegacion ? { delegacion: q.delegacion } : {}) });
  console.error(`✅ ok de guardar la story ${fresco.storyId} (${q.via}${ok.canales ? `, avisado por ${ok.canales.join(', ')}` : ''}). Antes de cada commit, push y pedido: marker.js save-check.`);
  process.exit(0);
}

// `save-check [--push <remoto> <rama>]` (sólo lee): sale 0 si el ok de guardar de la corrida abierta sigue valiendo para
// el código de ahora; 1 con qué repo y qué cambió. Con --push, además, la rama de destino es la del ok y no es main.
function cmdSaveCheck(argv) {
  const i = argv.indexOf('--push');
  const push = i >= 0 ? { remoto: argv[i + 1], rama: argv[i + 2] } : null;
  if (push && (!push.remoto || !push.rama)) { console.error('uso: marker.js save-check [--push <remoto> <rama>]'); process.exit(2); }
  const m = readMarker();
  const so = require('./save-ok.js');
  const no = (motivo) => { console.error(`🔒 save-check: ${motivo}`); process.exit(1); };
  if (!m) no('no hay una ejecución abierta: el ok de guardar es de una corrida');
  if (m.saveOk && (m.saveOk.storyId !== m.storyId || m.saveOk.startedAt !== (m.startedAt || null))) no('el ok de guardar es de otra corrida: hay que pedir otro');
  const r = so.vigente({ saveOk: m.saveOk, push, repoActual: process.cwd() });
  if (!r.ok) no(r.motivo);
  console.error(`✅ save-check: el ok de guardar de ${m.storyId} sigue valiendo${push ? ` para empujar ${push.rama}` : ''}.`);
  process.exit(0);
}

// Los dos respaldos cuando el click no se pudo comprobar (o no se puede pedir): la terminal del dueño, o la frase.
function respaldosDeDesignar(sesion) {
  const ds = path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'delegated-signing.js');
  return [`   Respaldos: en la terminal de la persona, node ${MARKER_JS} designate-relay --terminal${sesion && sesion !== '_nosession' ? ` --for-session ${sesion}` : ''};`,
    `   o con su frase: node ${MARKER_JS} designate-relay --approved-by '<el dev>' --quote '<su frase>' y después node ${ds} confirm-designation --terminal`];
}

// La firma de nombrar o retirar: sólo el click del dueño en la pestaña de esa sesión, o su terminal (signatures.js
// `soloClick`). `{ via }`, o sale con el motivo.
function firmaDeLaDesignacion(firma, resumen, antes, alNegar) {
  const r = ownerWindow().exigir({ firma, argv: process.argv.slice(1), resumen, propia: PROPIA, antes });
  if (r.codigo !== 0) { alNegar(r.motivo); process.exit(r.codigo === 2 ? 2 : 1); }
  if (r.via !== 'click' && r.via !== 'terminal') {
    alNegar(`la firma volvió por ${r.via}, y esto lo firma la persona con su click o en su terminal`);
    process.exit(1);
  }
  return r;
}

// `designate-relay` designa ESTA sesión, en esta máquina, como la coordinadora: la que ordena las sesiones. Sin frase,
// con el click del dueño en el cuadro que dice qué sesión es y en qué carpeta (firma `designation-set`): el arnés no lee
// ninguna frase; con el rol del perfil anota la designación y su confirmación en un paso, y sin él sólo la designación
// (la sesión ordena y no firma por nadie). Con `--approved-by "<el dev>" --quote "<su frase>"`,
// el respaldo: la frase nombra el rol (el de `approvals.relay_session` o, sin perfil, «coordinadora») y, con el rol del
// perfil, la sesión firma en nombre del dueño cuando él la confirma (scripts/lib/delegated-signing.js
// `confirm-designation`); sin él, las firmas siguen yendo a la ventana del dueño. Una designación nueva reemplaza a la
// anterior; con otra confirmada en pie, la nueva por frase queda pendiente hasta que el dueño la confirme (historia 8.314).
function cmdDesignateRelay(argv) {
  const cw = require('./critical-waivers.js');
  const { val } = opcionesDe(argv);
  negarSiEsPruebaSobreLoReal('designate-relay');
  if (!argv.some((a) => a === '--quote' || a.startsWith('--quote='))) return designarPorClick(cw);
  const r = cw.designar({ approvedBy: val('--approved-by'), quote: val('--quote') });
  if (!r.ok) {
    console.error(`🚫 marker.js designate-relay: no se designó nada — ${r.motivo}.`);
    console.error(`   Con una frase que nombra el rol (por ejemplo «Esta sesión es la coordinadora», con o sin tildes): node ${MARKER_JS} designate-relay --approved-by '<el dev>' --quote '<la frase>'`);
    process.exit(1);
  }
  const e = r.entrada;
  // el rol se mira con sesionQueReenvia: es lo que pide confirm-designation para confirmar
  const tapa = confirmadaEnPie(cw, e.sesion, () => Boolean(cw.sesionQueReenvia().valor));
  if (tapa) {
    console.error(`🚫 marker.js designate-relay: no se designó nada — ${tapa}.`);
    process.exit(1);
  }
  appendLog('gates.log', { name: cw.DESIGNACION, status: 'ok', ts: nowIso(), sesion: e.sesion, rol: e.rol, quien: e.quien, cita: e.cita, cita_cuando: e.cita_cuando });
  // lo escrito se comprueba con la última designación: la vigente puede seguir siendo la confirmada
  const quedo = cw.ultimaDesignacion();
  if (!quedo || quedo.error || quedo.sesion !== e.sesion) {
    console.error(`🚫 marker.js designate-relay: no pude dejar la designación en el registro del arnés${quedo && quedo.error ? ` (${quedo.error})` : ''}.`);
    process.exit(2);
  }
  const vigente = cw.designacionVigente();
  if (vigente && !vigente.error && vigente.sesion !== e.sesion) {
    console.error(`⏳ La designación de esta sesión (${e.sesion}) quedó pendiente: la coordinadora sigue siendo ${vigente.sesion}, confirmada, hasta que una persona confirme ésta. Corré node scripts/lib/delegated-signing.js confirm-designation en esta pestaña y aprobala con un click, o confirmala en su terminal.`);
    process.exit(0);
  }
  if (r.firma) console.error(`✅ Esta sesión (${e.sesion}) es la «${e.rol}» de esta máquina, designada por ${e.quien}. Vale cuando una persona la confirma: corré node scripts/lib/delegated-signing.js confirm-designation en esta pestaña y aprobala con un click, o confirmala en su terminal`);
  else console.error(`✅ Esta sesión (${e.sesion}) es la «${e.rol}» de esta máquina, designada por ${e.quien}: ordena esta máquina, y las firmas siguen yendo a la ventana de la persona (${porQueNoFirma(r.aviso)}).`);
  console.error(`   Antes de seguir, leé tus reglas completas: ${path.join(SCRIPTS_DIR, '..', '..', '..', 'guides', 'coordination.md')}`);
  process.exit(0);
}

// Sin el rol en el perfil una designación nueva no se puede confirmar: con otra confirmada en pie, quedaría pendiente
// para siempre. El motivo para no designar, o null. `firma()` dice si el perfil nombra el rol; se mira sólo si hace falta.
function confirmadaEnPie(cw, sesion, firma) {
  const confirmada = cw.designacionConfirmada();
  if (!confirmada || confirmada.error || confirmada.sesion === sesion || firma()) return null;
  return `la sesión ${confirmada.sesion} es la coordinadora confirmada, y sin approvals.relay_session en el perfil esta designación no se puede confirmar. Primero hay que retirarla: desde su pestaña, node ${MARKER_JS} withdraw-relay; si ya no vive, desde ésta, node ${MARKER_JS} withdraw-relay --session ${confirmada.sesion}`;
}

// Por qué la sesión ordena y no firma: lo que no se pudo leer del perfil, o que el perfil no tiene la clave.
const porQueNoFirma = (aviso) => (aviso ? aviso.replace(/: nadie reenvía$/, '') : 'el perfil del equipo no tiene approvals.relay_session');

// Una prueba (`TYCON_TEST_RUN=1`, la marca que pone smoke-run.sh) no escribe la designación del estado real de la
// máquina (historia 8.314): sale 2 sin escribir. Si no se puede saber, también.
function negarSiEsPruebaSobreLoReal(cmd) {
  if (String(process.env.TYCON_TEST_RUN || '').trim() !== '1') return;
  let motivo;
  try { motivo = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'lab-home.js')).pruebaSobreLoReal(STATE_DIR); } catch (e) { motivo = `una prueba no escribe el estado sin saber si es el real (${e.message})`; }
  if (motivo) { console.error(`🚫 marker.js ${cmd}: ${motivo}. No se escribió nada.`); process.exit(2); }
}

function designarPorClick(cw) {
  const sesion = estado.SID;
  const noSeNombro = (motivo) => {
    console.error(`🚫 marker.js designate-relay: no se nombró a la coordinadora — no pude comprobar el click: ${motivo}.`);
    for (const l of respaldosDeDesignar(sesion)) console.error(l);
  };
  // el rol de ordenar: el del perfil, que firma por la persona, o sin perfil el de fábrica, que sólo ordena
  const coord = cw.rolDeCoordinar();
  // se lee de nuevo en cada llamada: lo que se anota es lo que el cuadro mostró, y sin el rol nunca se confirma
  const antes = () => {
    if (!/^[\w-]+$/.test(String(sesion || '')) || sesion === '_nosession') return { codigo: 1, motivo: 'la sesión no dice su identificador' };
    const ahora = cw.rolDeCoordinar();
    if (ahora.rol !== coord.rol || ahora.firma !== coord.firma) return { codigo: 1, motivo: 'el perfil del equipo cambió mientras se esperaba la firma: corré el comando de nuevo' };
    const tapa = confirmadaEnPie(cw, sesion, () => coord.firma);
    return tapa ? { codigo: 1, motivo: tapa, enPie: true } : null;
  };
  // antes de pedir la firma: sin id de sesión el click no tendría qué nombrar, y con otra confirmada en pie que esta
  // designación no puede reemplazar, el click se gastaría; los respaldos no sirven para eso: hay que retirarla
  const previo = antes();
  if (previo && previo.enPie) { console.error(`🚫 marker.js designate-relay: no se nombró a la coordinadora — ${previo.motivo}.`); process.exit(previo.codigo); }
  if (previo) { noSeNombro(previo.motivo); process.exit(previo.codigo); }
  const r = firmaDeLaDesignacion('designation-set', `la sesión ${sesion} pasa a ser la «${coord.rol}» de esta máquina`, antes, noSeNombro);
  appendLog('gates.log', { name: cw.DESIGNACION, status: 'ok', ts: nowIso(), sesion, rol: coord.rol, quien: 'la persona', via: r.via });
  const quedo = cw.ultimaDesignacion();
  if (!quedo || quedo.error || quedo.sesion !== sesion) {
    console.error(`🚫 marker.js designate-relay: no pude dejar la designación en el registro del arnés${quedo && quedo.error ? ` (${quedo.error})` : ''}.`);
    process.exit(2);
  }
  const con = r.via === 'click' ? 'su click' : 'su terminal';
  if (coord.firma) {
    // el mismo click la confirma: el renglón se ata a esta designación por su hora, sin frase
    appendLog('gates.log', delegatedSigning().confirmationRecord(quedo, nowIso(), { via: r.via }));
    console.error(`✅ Esta sesión (${sesion}) es la «${coord.rol}» de esta máquina, nombrada por la persona con ${con}.`);
  } else {
    // sin el rol en el perfil no hay confirmación: la sesión no firma por nadie
    console.error(`✅ Esta sesión (${sesion}) es la «${coord.rol}» de esta máquina, nombrada por la persona con ${con}: ordena esta máquina, y las firmas siguen yendo a la ventana de la persona (${porQueNoFirma(coord.aviso)}).`);
  }
  console.error(`   Antes de seguir, leé tus reglas completas: ${path.join(SCRIPTS_DIR, '..', '..', '..', 'guides', 'coordination.md')}`);
  process.exit(0);
}

// `withdraw-relay` retira a la coordinadora: lo corre ella misma, y el dueño lo firma con su click en el cuadro de
// esa sesión (`designation-withdraw`) o en su terminal. Queda un renglón `retirada`: el registro no se borra.
// Con `--session <id>`, otra sesión retira a una vigente que ya no vive (historia 8.314): así una coordinadora que murió
// no deja la máquina trabada. Una sesión cerrada no deja su archivo, así que «ya no vive» es no figurar viva en una lista
// de sesiones bien leída; si no se puede saber, no se retira. El renglón anota quién la pidió.
// `'viva'`, `'muerta'` o el motivo por el que no se sabe. Vale «muerta» sólo con la lista de sesiones leída sin archivos
// ilegibles y con viva la sesión que pide (o alguna, si no dice su id): una lista vacía o rota no prueba nada.
function vidaDeLaSesion(objetivo) {
  let wip;
  let claude;
  try {
    wip = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'tools', 'work-in-progress.js'));
    claude = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js')).claudeDir(require('os').homedir());
  } catch (e) { return `no pude cargar la lista de sesiones: ${e.message}`; }
  const ilegibles = [];
  let sesiones;
  try { sesiones = wip.sessionsBySid(path.join(claude, 'sessions'), ilegibles, path.join(claude, 'projects')); } catch (e) { return `no pude leer las sesiones: ${e.message}`; }
  if (ilegibles.length) return `hay archivos de sesión que no se leen: ${ilegibles[0]}`;
  const viva = (sid) => { const s = sesiones.get(sid); return !!(s && s.alive); };
  if (viva(objetivo)) return 'viva';
  const pideViva = estado.SID && estado.SID !== '_nosession' ? viva(estado.SID) : [...sesiones.values()].some((s) => s.alive);
  return pideViva ? 'muerta' : 'la lista de sesiones no muestra viva a la que pide';
}

function cmdWithdrawRelay(argv = []) {
  const cw = require('./critical-waivers.js');
  const sesion = estado.SID;
  const { val } = opcionesDe(argv);
  // la forma pegada (`--session=<id>`) no se lee como la separada: se niega, para que el cuadro y lo que se hace coincidan
  if (argv.some((a) => String(a).startsWith('--session='))) {
    console.error('🚫 marker.js withdraw-relay: no se retiró a la coordinadora — escribí la sesión separada: --session <id>.');
    process.exit(1);
  }
  const pedida = val('--session');
  const objetivo = pedida || sesion;
  const otra = objetivo !== sesion;
  negarSiEsPruebaSobreLoReal('withdraw-relay');
  const d = cw.designacionVigente();
  const noSeRetiro = (motivo) => console.error(`🚫 marker.js withdraw-relay: no se retiró a la coordinadora — ${motivo}.`);
  // se lee de nuevo en cada llamada: mientras la firma espera, otra sesión puede quedar nombrada
  const antes = () => {
    if (otra && !/^[\w-]+$/.test(String(objetivo))) return { codigo: 1, motivo: `--session ${objetivo} no es el identificador de una sesión` };
    const ahora = cw.designacionVigente();
    if (!ahora) return { codigo: 1, motivo: 'no hay coordinadora en esta máquina' };
    if (ahora.error) return { codigo: 2, motivo: ahora.error };
    if (ahora.sesion !== objetivo) return { codigo: 1, motivo: otra ? `la sesión ${objetivo} no es la coordinadora (la vigente es ${ahora.sesion})` : `esta sesión no es la coordinadora (la vigente es ${ahora.sesion})` };
    if (d && !d.error && ahora.ts !== d.ts) return { codigo: 1, motivo: 'la designación cambió mientras se esperaba la firma: corré el comando de nuevo' };
    if (otra) {
      const vida = vidaDeLaSesion(objetivo);
      if (vida !== 'muerta') return { codigo: 1, motivo: vida === 'viva' ? `la sesión ${objetivo} sigue viva: la retira ella, desde su pestaña` : `no se puede saber si la sesión ${objetivo} sigue viva (${vida}): no la retiro` };
    }
    return null;
  };
  const previo = antes();
  if (previo) { noSeRetiro(previo.motivo); process.exit(previo.codigo); }
  const resumenDeLaFirma = otra ? `la sesión ${objetivo}, que ya no vive, deja de ser la «${d.rol}» de esta máquina (la pide la sesión ${sesion})` : `la sesión ${sesion} deja de ser la «${d.rol}» de esta máquina`;
  const r = firmaDeLaDesignacion('designation-withdraw', resumenDeLaFirma, antes, noSeRetiro);
  const despues = antes();
  if (despues) { noSeRetiro(despues.motivo); process.exit(despues.codigo); }
  appendLog('gates.log', { name: cw.DESIGNACION, status: cw.RETIRADA, ts: nowIso(), sesion: objetivo, rol: d.rol, quien: 'la persona', via: r.via, ...(otra ? { pedida_por: sesion } : {}) });
  const quedo = cw.designacionVigente();
  if (quedo && !quedo.error && quedo.sesion === objetivo) {
    console.error('🚫 marker.js withdraw-relay: no pude dejar la retirada en el registro del arnés.');
    process.exit(2);
  }
  if (otra) console.error(`✅ La sesión ${objetivo} dejó de ser la «${d.rol}» de esta máquina (la pidió ${sesion}): las firmas vuelven a la persona hasta que nombre otra.`);
  else console.error(`✅ Esta sesión (${sesion}) dejó de ser la «${d.rol}» de esta máquina: las firmas vuelven a la persona hasta que nombre otra.`);
  process.exit(0);
}

// `mark-tested --acs <n,m> [--approved-by <quién>] [--terminal]` deja la marca de que una persona probó a mano esos
// criterios de la guía, si la organización lo pide (`qa.manual_check: required`, lib/manual-checks.js). La aprueba la
// persona en la ventana de permiso, con su click o su «aprobado», o en su terminal. Un reenvío de otra sesión no marca: la marca es de quien probó.
function cmdMarkTested(argv) {
  const mc = require('./manual-checks.js');
  const { val, tiene } = opcionesDe(argv);
  const acs = [...new Set(String(val('--acs') || '').split(/[,\s]+/).filter(Boolean).map(Number))];
  if (!acs.length || acs.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error('marker.js mark-tested: falta --acs <números de criterio, separados por coma> (la persona lo aprueba en la ventana de permiso, con un click o un «aprobado», o con --terminal).');
    process.exit(2);
  }
  const p = mc.prendida();
  if (!p.prendida) {
    // en el chequeo previo de la ventana se niega: si saliera 0 sin su ok, la ventana se abriría para una firma sin efecto
    const previo = process.env[require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).PRECHEQUEO] === '1';
    console.error(`marker.js mark-tested: tu organización no pide la marca a mano; no anoté nada${previo ? ' y no hace falta firmar' : ''}.`);
    process.exit(previo ? 1 : 0);
  }
  const m = readMarker();
  if (!m) { console.error('marker.js mark-tested: no hay marker activo para esta sesión'); process.exit(1); }
  const storyAbs = resolveStoryPath(m.storyPath, m);
  if (!storyAbs) { console.error('marker.js mark-tested: no encontré la story de la corrida'); process.exit(2); }
  let runDir = null;
  try { runDir = carpetaParaLaFirma(m.repoPath || process.cwd(), String(m.storyId), storyAbs, m); } catch (e) {
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
  let firmaDada = null;
  if (tiene('--terminal')) {
    const waiver = require('./runtime-waiver.js');
    if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
      console.error('🪟 Abro una ventana nueva para la marca: seguí ahí.');
      const v = waiver.abrirVentana({ script: MARKER_JS, args: ['mark-tested', ...argv] });
      if (v.estado === 'vencida' || v.estado === 'no-abrio') { console.error(`🔒 marker.js mark-tested: ${v.estado === 'vencida' ? 'la ventana venció sin marcar' : `no pude abrir la ventana (${v.motivo})`} — no se marcó nada.`); process.exit(1); }
      process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
    }
    if (waiver.esWindows()) waiver.dentroDeLaVentana();
    if (!waiver.hasTty()) {
      console.error('🔒 marker.js mark-tested --terminal BLOQUEADO — necesita una terminal de verdad: lo corre la persona que probó, no el agente.');
      console.error(`     node ${MARKER_JS} mark-tested ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      process.exit(2);
    }
    let resp;
    try {
      resp = waiver.promptTty(`\n════════ PROBADO A MANO · historia ${m.storyId} ════════\n${lista.map((c) => `  Criterio ${c.n} — ${c.text}`).join('\n')}\n\n¿Los probaste a mano? (si / no) > `);
    } catch (e) { console.error(`🔒 ${e.message}`); process.exit(2); }
    if (!/^s(i|í)?$/i.test(String(resp || '').trim())) { console.error('marker.js mark-tested: no se marcó nada.'); process.exit(1); }
    if (waiver.esWindows() && !waiver.confirmarFrase()) { console.error('🔒 marker.js mark-tested: la frase no coincide — no se marcó nada.'); process.exit(1); }
    firmaDada = firmadoEnLaTerminal('manual-test', `criterios ${acs.join(', ')} de ${m.storyId}`);
    entrada = { quien: process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'tty-user', via: 'terminal' };
  } else {
    // la persona que probó lo aprueba en la ventana de permiso; la cita en la conversación ya no alcanza
    const cw = require('./critical-waivers.js');
    const persona = val('--approved-by') !== null ? cw.noEsPersona(val('--approved-by')) : null;
    if (persona) { console.error(`🚫 marker.js mark-tested: no se marcó nada — ${persona}.`); process.exit(1); }
    if (val('--quote') || val('--relayed-by')) {
      console.error('🚫 marker.js mark-tested: no se marcó nada — la cita o el reenvío ya no firman: lo aprueba la persona en la ventana de permiso (este comando sin --quote ni --relayed-by) o en su terminal (--terminal).');
      process.exit(1);
    }
    const firma = firmaDelDueno('manual-test', `criterios ${acs.join(', ')} de ${m.storyId}`);
    firmaDada = firma;
    const quien = String(val('--approved-by') || process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona').trim();
    const q = quienFirmo(firma, quien);
    entrada = { quien: q.quien, via: q.via, ...(q.delegacion ? { delegacion: q.delegacion } : {}) };
  }
  const ts = nowIso();
  const renglones = acs.map((ac) => ({ ac, story: String(m.storyId), ...entrada, ts }));
  // primero el par en el registro del arnés (que el agente no escribe): sin él la marca no cuenta al cerrar
  for (const r of renglones) appendLog('gates.log', { name: 'manual-check', status: 'ok', story: String(m.storyId), ac: r.ac, ts, quien: r.quien, via: r.via, huella: mc.huellaMarca(r) });
  mc.anotar(runDir, renglones);
  anotarAprobacion(m, { que: `prueba a mano de ${acs.length > 1 ? 'los criterios' : 'el criterio'} ${acs.join(', ')}`, via: entrada.via, tipo: 'manual', quien: entrada.quien, ...porDe(firmaDada), ...(entrada.delegacion ? { delegacion: entrada.delegacion } : {}), ...(entrada.cita ? { cita: entrada.cita, cita_cuando: entrada.cita_cuando } : {}) });
  console.error(`✅ ${acs.length > 1 ? 'Criterios' : 'Criterio'} ${acs.join(', ')} marcado${acs.length > 1 ? 's' : ''} como probado${acs.length > 1 ? 's' : ''} a mano por ${entrada.quien}.`);
  process.exit(0);
}

// ============================================================
// DODRT-C6 — waiver runtime USER-ONLY (llave TTY)
// ============================================================
// La ÚNICA vía para saltear la verificación runtime por-AC. TTY-only por construcción:
// el agente corre sin terminal controladora → promptTty() tira. El humano confirma en su
// terminal. El agente NO puede ejecutar esto con éxito. Ver lib/runtime-waiver.js.
/**
 * `check-runtime-waiver [<spec>] [--acs n,m] [--batch <tanda>]`: si la firma por la ventana de esos criterios pasaría, sin
 * firmar nada. Corre las comprobaciones de la firma (`pedidoDeFirma`) y lo dice en la salida: 0 pasaría, 1 no pasaría
 * (con el porqué), 2 sin la historia. Es otro subcomando y no `runtime-waiver --check`: cualquier `runtime-waiver` es una
 * firma para el arnés y le abriría al dueño el cuadro. Lo corre la coordinadora antes de pasarle el pedido al dueño.
 */
function cmdCheckRuntimeWaiver(storyArg, argv = []) {
  const m = readMarker();
  const crudo = storyArg || (m && (m.storyPath || m.specPath || m.storySpec));
  const storyPath = resolveStoryPath(crudo, m);
  if (!storyPath) {
    console.error(`marker.js check-runtime-waiver: no encuentro la story (recibido: ${nn(crudo, '(nada — ni argumento ni marker)')}). El path va posicional y conviene absoluto.`);
    process.exit(2);
  }
  const pedido = pedidoDeFirma(storyPath, argv, m);
  if (pedido.rechazo) {
    console.log(`no pasaría — la firma de ${storyPath} saldría rechazada así:`);
    for (const l of pedido.rechazo.lineas) console.log(l);
    if (pedido.pista) console.log(pedido.pista);
    process.exit(1);
  }
  console.log(`pasaría: la firma de los criterios imposibles de probar en vivo AC ${pedido.pedidos.join(', ')} de ${pedido.matrix.sid} se aceptaría. No firmé nada.`);
  process.exit(0);
}

function cmdRuntimeWaiver(storyArg, argv = []) {
  const waiver = require('./runtime-waiver.js');

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
    console.error(`    node ${MARKER_JS} runtime-waiver /abs/path/a/la-story.md`);
    process.exit(2);
  }

  // Desde una sesión, sin terminal: lo aprueba la persona en la ventana de permiso. `--terminal` firma en la terminal.
  const desdeSesion = !argv.includes('--terminal') && process.env[waiver.MARCA_VENTANA] !== '1' && !waiver.hasTty();
  if (desdeSesion || argv.includes('--approved-by') || argv.includes('--quote') || argv.includes('--relayed-by')) {
    runtimeWaiverConOk(storyPath, argv, m);
    return;
  }

  // 🔴 Windows: no hay /dev/tty. El comando se vuelve a lanzar en una ventana de consola
  // NUEVA y visible, y sólo ésa firma (lib/runtime-waiver.js, «WINDOWS»). Acá, fuera de la ventana, sólo se abre y se espera.
  if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
    console.error(`🪟 Abro una ventana nueva, «Firma del waiver»: seguí ahí. Tenés ${waiver.topeVentanaS() >= 60 ? `${Math.round(waiver.topeVentanaS() / 60)} minutos` : `${waiver.topeVentanaS()} segundos`}.`);
    const v = waiver.abrirVentana({ script: MARKER_JS, args: ['runtime-waiver', storyPath] });
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
  // en la ventana, toda salida espera un Enter antes de cerrarse: que la persona lea el resultado (el tope igual corre)
  if (waiver.esWindows()) waiver.dentroDeLaVentana();

  // Freno físico ANTES de computar nada: si no hay terminal, ni arrancamos.
  if (!waiver.hasTty()) {
    // las dos vías, en llano: el agente no firma; firma la persona, en el chat o en su terminal
    let version = 'desconocida';
    try { version = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, '..', '..', '..', 'version.json'), 'utf8')).version || version; } catch (_) { /* sin version.json: se dice desconocida */ }
    console.error(waiver.esWindows()
      ? '🔒 marker.js runtime-waiver BLOQUEADO — en Windows firma sólo la ventana NUEVA que abre este comando, sin otro proceso conectado: corrido desde el agente o con la entrada redirigida, no firma.'
      : '🔒 marker.js runtime-waiver BLOQUEADO — acá no hay una terminal de una persona (/dev/tty): el agente no puede firmar.');
    console.error('   Un criterio que no se puede probar en vivo lo firma una persona, de una de estas dos formas:');
    console.error('   (a) Desde la sesión: el agente corre este comando sin --terminal y vos lo aprobás en la ventana de permiso.');
    // con tanda anotada, la terminal mide esa tanda sólo si nombra la sesión de la corrida
    const conSesion = m && m.batch && estado.SID !== '_nosession' ? ` --for-session ${estado.SID}` : '';
    console.error(`   (b) En tu terminal: node ${MARKER_JS} runtime-waiver ${storyPath} --terminal${conSesion}${waiver.esWindows() ? '  (en Windows abre una ventana para firmar)' : ''}`);
    console.error(`   Versión del arnés: ${version}. Si no está al día (en Windows la firma por ventana llegó el 2026-10-15), actualizalo con /tycon-harness.`);
    process.exit(2);
  }

  // con --for-session, el marcador de esa sesión: la matriz mide su tanda, como «Preparar el pull request»
  const matrix = require('./waiver-display.js').matrixForSignature(storyPath, m);
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
  // REHÚSA — esos el agente los tiene que correr, no se pueden saltear. Los que cubre el rojo esperado vigente de la
  // deuda ya tienen su salida.
  const notRun = sinCorrerFueraDeLaDeuda(m, matrix);
  if (notRun.length > 0) {
    console.error('🚫 marker.js runtime-waiver RECHAZADO — hay ACs SIN CORRER que NO se pueden waivear:');
    console.error(`   AC ${notRun.map((n) => '#' + n).join(', ')}`);
    console.error('   Estos NO están declarados como imposibles de verificar corriendo la app.');
    console.error('   El agente debe correrlos (E2E/smoke) — o, si de verdad son imposibles,');
    console.error('   declararlos en el frontmatter `runtime_not_verifiable:` (reason + covered_by test).');
    console.error('   El waiver es SÓLO para lo declarado-imposible, no para lo no-corrido.');
    // sin tanda medida, los sin correr pueden ser de otras tandas: la firma de una corrida por tanda nombra su sesión
    const pista = matrix.batch ? null : require('./waiver-display.js').pistaDeSesion({ stateDir: STATE_DIR, storyPath });
    if (pista) console.error(`   ${pista}`);
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
      ans = waiver.promptTty(require('./waiver-display.js').preguntaDeTerminal({ ac: n, texto, reason, cov,
        medida: require('../runtime-matrix.js').textoDeMedida(matrix.perAc[n]) }));
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
    for (const linea of require('./approvals.js').lineasDeFirmaPorTerminal(approved, approvedBy)) anotarAprobacion(mk, linea);
  }
  console.error(`\n✅ Waiver registrado (TTY): story ${matrix.sid}, ACs aprobados ${approved.join(',')}${rejected.length ? ` · rechazados ${rejected.join(',')}` : ''}, hash ${matrix.hash}, por ${approvedBy}.`);
  console.error(`   Pinneado al hash actual: si el código/evidencia cambian, se invalida solo.`);
  console.error(`   Cadena: ${entry.chain}`);
  if (rejected.length) console.error(`   ⚠ AC ${rejected.join(',')} quedaron sin aprobar → la matriz sigue roja para esos; el agente los tiene que resolver.`);
  process.exit(0);
}

// Una firma sobre un archivo (la exención de la prueba en vivo, cambiar el estado a mano, la evidencia a mano, una story
// sin la skill): se pide en la ventana de permiso, o con --terminal en la del dueño, y deja la constancia que consume el
// Edit o Write siguiente de esta sesión sobre ese archivo (scripts/lib/owner-window.js).
// Uso: marker.js sign-file <firma> <archivo> [--terminal --for-session <id>]
function cmdSignFile(firma, archivo) {
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const { FIRMAS_DE_ARCHIVO } = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
  if (!FIRMAS_DE_ARCHIVO.includes(firma) || !archivo || archivo.startsWith('--')) {
    console.error(`uso: marker.js sign-file <firma> <archivo> [--terminal --for-session <id>]; las firmas: ${FIRMAS_DE_ARCHIVO.join(', ')}`);
    process.exit(2);
  }
  // en la terminal del dueño no hay sesión: sin --for-session la constancia no la usaría ninguna escritura
  if (estado.SID === '_nosession' && process.argv.includes('--terminal')) {
    console.error('🔒 marker.js sign-file: sin --for-session no sé qué sesión va a escribir el archivo, y la firma no le serviría a ninguna.');
    console.error(`   Corré: ${ow.comoSeFirmaEnLaTerminal(firma, archivo, '<id de la sesión del agente>') || ow.sinFormaDeTerminal(archivo)}`);
    process.exit(2);
  }
  const r = firmaDelDueno(`escape:${firma}`, `${firma} sobre ${archivo}`);
  const sesion = r.destino || estado.SID;
  if (sesion === '_nosession') {
    console.error('🔒 marker.js sign-file: la firma no dice qué sesión va a escribir el archivo; no dejé constancia.');
    process.exit(1);
  }
  try {
    ow.firmarArchivo({ firma, via: r.via, sesion, archivo });
  } catch (e) {
    console.error(`🔒 marker.js sign-file: la firma se dio, pero no pude dejar su constancia (${e.message})`);
    process.exit(1);
  }
  console.log(`✅ ${firma} firmada (${r.via}) para ${ow.rutaReal(archivo)}: el próximo Edit o Write de la sesión ${sesion} sobre ese archivo la usa, dentro de ${ow.VENCE_MIN} minutos.`);
}

module.exports = {
  carpetaParaLaFirma, quienFirmo, firmadoEnLaTerminal, sinCorrerFueraDeLaDeuda, runtimeWaiverConOk, opcionesDe,
  cmdPlanReview, cmdReviewAsk, cmdReviewAnswer, cmdOwnerAway, cmdWaiveCritical, cmdCompareWaiver,
  cmdSignAdversarialSkip, cmdSignAtddSkip, cmdDeclarePending, cmdApprovePending, firmasDeLaCorrida, cmdApproveSave, cmdSaveCheck,
  respaldosDeDesignar, firmaDeLaDesignacion, cmdDesignateRelay, negarSiEsPruebaSobreLoReal, designarPorClick,
  vidaDeLaSesion, cmdWithdrawRelay, cmdMarkTested, cmdRuntimeWaiver, cmdCheckRuntimeWaiver, cmdSignFile,
};
