'use strict';
/**
 * lib/mutation-gate.js — cableado del CHEQUEO DE MUTANTES en `marker.js
 * complete-step run-tests` (AVISA, NO FRENA).
 *
 * Por qué existe: `scripts/mutation-check.js` rompe el código nuevo a propósito
 * y verifica que algún test se ponga rojo — pero como script suelto depende de
 * que alguien se acuerde de correrlo, y la doctrina del equipo dice que un
 * control que hay que acordarse de invocar es un control que no corre. Este
 * módulo lo corre solo al cerrar la etapa de implementación.
 *
 * Semántica (deliberadamente MÁS BLANDA que el script standalone, como el gate
 * de ATDD fuera del pipeline):
 *   - exit 1 del chequeo (CERO mutantes muertos habiendo generado alguno)
 *     → BLOQUEA `complete-step run-tests`. Es el único caso que frena: los tests no
 *     ejercen el código nuevo. Con una receta que no es `node --test`, hasta
 *     MUTATION_NOTICE_UNTIL avisa y deja pasar (las recetas nuevas entran avisando).
 *   - exit 0 con sobrevivientes → AVISA (archivo:línea [operador]) y deja pasar.
 *   - exit 0 limpio / SIN_MUTANTES → sigue en silencio.
 *   - exit 0 con DEADLINE_SIN_CORRER o SIN_MEDIR (no se midió ningún mutante) → AVISA y deja pasar.
 *   - exit 2 (estructural: story sin tests declarados, etc.) → AVISA y deja
 *     pasar — una story de docs o de config no tiene por qué trabarse.
 *   - Cualquier cosa inesperada (script ausente, excepción, exit raro) →
 *     FAIL-OPEN avisando: un problema del chequeo mismo jamás rompe el cierre.
 *
 * El veredicto queda SIEMPRE en gates.log (total/killed/survived/verdict/
 * maxMutants) — «cuántas corridas tuvieron sobrevivientes» es medible, no una
 * impresión. Escapes: TYCON_MUTATION_CHECK=off (apaga todo; queda en bypass.log) ·
 * `complete-step run-tests --no-mutation` (saltea esa corrida, queda en bypass.log).
 *
 * Presupuesto (números medidos, no deseados): el
 * costo es (duración de las pruebas declaradas) × (1 base + mutantes ejecutados) —
 * NO un fijo. Frenos: --max-mutants 12 · los topes por receta del chequeo (.NET
 * 8 min en total y 3 por corrida; las demás 3 y 2; los restantes quedan skipped)
 * · timeout duro del spawn 12 min, igual para todas. Peor caso: el cierre de «Correr
 * las pruebas» puede irse hasta ~8 minutos en .NET; con la suite del harness (~10s), ~1 min.
 * Cada línea de gates.log dice su receta (`runner`).
 *
 * Testeable por inyección: `invokeCheck` (reemplaza el spawn), `appendLog` y
 * `log`. El borde real `defaultInvokeCheck` (flags del CLI, --json, parseo)
 * está cubierto por un test E2E que spawnea el chequeo DE VERDAD contra la
 * fixture — un rename de flag pone la suite en rojo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_MAX_MUTANTS = 12;
// El corte de presupuesto lo maneja el CHEQUEO, por receta (BUDGETS de mutation-check.js: .NET 8 min, las demás 3):
// sólo él sabe qué receta corre. El timeout del spawn queda como red de ÚLTIMO recurso, igual para todas y MÁS ALTO que
// el tope más largo — si se dispara, el hijo murió por señal y sus handlers restauraron (o gritaron); el gate igual avisa.
const HARD_TIMEOUT_MS = 720000;

// Las recetas nuevas del chequeo (todas menos `node --test`) entran avisando: hasta esta fecha, cero mutantes cazados
// avisa y deja pasar; desde esta fecha, frena como `node --test`. Son dos semanas desde que las recetas nuevas entran:
// el tiempo para que cada equipo agregue las pruebas que faltan antes de que el chequeo frene.
const MUTATION_NOTICE_UNTIL = '2026-11-18';

// Borde real: spawnea mutation-check.js y devuelve { code, result, stderr,
// timedOut } con el exit code REAL y el JSON parseado (o null si no parseó).
// La salida de errores del chequeo pasa en el momento (heredada): el aviso «Chequeo de mutantes: N mutantes en
// <receta>; puede tardar hasta M min» se ve antes de la espera, no al final.
function defaultInvokeCheck({ scriptPath, repo, storyPath, maxMutants, deadlineMs = null }) {
  const r = spawnSync(
    process.execPath,
    [scriptPath, '--repo', repo, '--story', storyPath,
      '--max-mutants', String(maxMutants), ...(deadlineMs ? ['--deadline-ms', String(deadlineMs)] : []), '--json'],
    { encoding: 'utf8', timeout: HARD_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const stderr = r.stderr || '';
  if (r.error && r.error.code === 'ETIMEDOUT') return { code: null, result: null, stderr, timedOut: true };
  if (r.error) throw r.error;
  if (r.signal) return { code: null, result: null, stderr, timedOut: true };
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { result = null; }
  return { code: r.status === null || r.status === undefined ? null : r.status, result, stderr, timedOut: false };
}

/** El `.git` común de un repo: dos worktrees del mismo repo lo comparten. null si git no contesta. */
function gitComun(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Los repos donde se miden los mutantes: los hermanos que la story toca (lib/companion-repos.js) y el de la story si
 * tiene ahí un archivo declarado que no es un `.md`. Un hermano se mide en el worktree donde la sesión escribió
 * (`tocados`, los archivos del marcador): el que elige companion-repos por la rama puede ser el checkout en `main`, que
 * no tiene el código de la story. Sin hermanos, el de la story. Un repo que no existe se pasa tal cual: el chequeo lo
 * dice. Si no se pueden leer los hermanos, se avisa y se mide el de la story.
 */
function destinosDeLaStory(repo, storyPath, log, tocados = []) {
  if (!fs.existsSync(repo)) return [repo];
  const cr = require('./companion-repos.js');
  let raices;
  let objetivos;
  let aqui;
  try {
    const opts = {
      warn: (t) => log(`⚠️  Chequeo de mutantes: ${t}`),
      // un hermano declarado que no está en disco no se mide: se dice, no se calla
      onMissing: (nombre, quien) => log(`⚠️  Chequeo de mutantes NO MEDIDO en ${nombre}: lo declara ${quien} y no está en disco`),
    };
    raices = cr.companionRoots(repo, storyPath, opts);
    objetivos = new Set(cr.companionTargets(repo, storyPath, { warn: opts.warn }).map((t) => cr.real(t.root)));
    aqui = cr.declaredHere(repo, storyPath).filter((f) => !/\.md$/i.test(f) && fs.existsSync(path.join(repo, f)));
  } catch (e) {
    log(`⚠️  Chequeo de mutantes: no pude leer los repos hermanos de la story (${(e && e.message) || e}): mido sólo ${repo}`);
    return [repo];
  }
  const propio = cr.real(repo);
  const escritos = [...new Set((tocados || []).map((f) => cr.gitRootOf(f)).filter(Boolean).map((r) => cr.real(r)))]
    .filter((r) => r !== propio);
  const hermanos = [];
  for (const raiz of raices) {
    const comun = gitComun(raiz);
    if (!comun && escritos.length) log(`⚠️  Chequeo de mutantes: git no contestó en ${raiz}: no sé si la sesión escribió en otro worktree suyo`);
    const donde = comun ? escritos.filter((r) => gitComun(r) === comun) : [];
    if (donde.length === 1) { hermanos.push(donde[0]); continue; }
    const deCompanion = objetivos.has(cr.real(raiz));
    if (deCompanion) hermanos.push(cr.real(raiz));
    if (donde.length > 1) {
      log(`⚠️  Chequeo de mutantes: la sesión escribió en ${donde.length} worktrees de ${path.basename(raiz)}; ${deCompanion ? `mido ${raiz}, el que elige companion-repos` : `NO MEDIDO en ${path.basename(raiz)}: no sé cuál es`}`);
    }
  }
  const destinos = [...new Set([...(aqui.length || !hermanos.length ? [propio] : []), ...hermanos])];
  return destinos;
}

/**
 * runMutationGate({ marker, opts, env, appendLog, log, maxMutants, scriptPath, invokeCheck })
 *   → { invoked, block, reason }
 * `block: true` SOLO en el caso exit 1 (cero muertos). Todo lo demás pasa.
 */
function runMutationGate({
  marker,
  opts = [],
  env = process.env,
  appendLog,
  log = (...a) => console.error(...a),
  maxMutants = DEFAULT_MAX_MUTANTS,
  scriptPath = path.join(__dirname, '..', 'mutation-check.js'),
  invokeCheck = null,
  today = new Date(),
  destinosDe = null,
}) {
  // Apagado global: no se invoca y no avisa, pero queda en bypass.log para que la revisión de la noche lo cuente.
  if (String(env.TYCON_MUTATION_CHECK || '').toLowerCase() === 'off') {
    appendLog('bypass.log', { kind: 'MUTATION_CHECK_OFF', story: marker.storyId });
    return { invoked: false, block: false, reason: 'off' };
  }
  // Bypass por corrida: no se invoca, pero NO es silencioso (mismo patrón --no-atdd).
  if (opts.includes('--no-mutation')) {
    appendLog('bypass.log', { kind: 'MUTATION_BYPASS', story: marker.storyId });
    log('⚠️  Chequeo de mutantes saltado con --no-mutation (queda en bypass.log).');
    return { invoked: false, block: false, reason: 'no-mutation' };
  }
  // Sin insumos no se puede correr — fail-open avisando (el cableado es blando).
  const repo = marker.repoPath;
  const storyRaw = marker.storyPath;
  if (!repo || !storyRaw) {
    log('⚠️  Chequeo de mutantes salteado: el marker no tiene repoPath/storyPath (fail-open).');
    appendLog('gates.log', {
      name: 'mutation', status: 'error', story: marker.storyId,
      reason: 'marker sin repoPath/storyPath', maxMutants,
    });
    return { invoked: false, block: false, reason: 'sin-insumos' };
  }
  const storyPath = path.isAbsolute(storyRaw) ? storyRaw : path.join(repo, storyRaw);
  // Script ausente: sólo aplica al invoke real; con invokeCheck inyectado no hay archivo.
  if (!invokeCheck && !fs.existsSync(scriptPath)) {
    log(`⚠️  Chequeo de mutantes salteado: script no encontrado (${scriptPath}) — fail-open.`);
    appendLog('gates.log', {
      name: 'mutation', status: 'error', story: marker.storyId,
      reason: `script no encontrado: ${scriptPath}`, maxMutants,
    });
    return { invoked: false, block: false, reason: 'script-ausente' };
  }

  // El código y sus pruebas pueden vivir en un repo hermano (`evidence.companion_repos`), no en el de la story: se
  // mide en cada hermano que la story toca, y en el de la story sólo si declara código ahí
  const destinos = (destinosDe || destinosDeLaStory)(repo, storyPath, log, marker.filesTouched);
  const ctx = { marker, storyPath, appendLog, log, maxMutants, scriptPath, invokeCheck, today };
  const resultados = destinos.map((r) => medirEn(r, ctx));
  // gana el que frena; si no frena ninguno, el que no salió limpio: un «no medido» en otro repo no queda tapado
  return resultados.find((x) => x.block) || resultados.find((x) => x.reason !== 'ok') || resultados[0];
}

/** Una corrida del chequeo en `repo`, con su veredicto en gates.log y su aviso: `{ invoked, block, reason }`. */
function medirEn(repo, { marker, storyPath, appendLog, log, maxMutants, scriptPath, invokeCheck, today }) {
  let out;
  try {
    out = (invokeCheck || defaultInvokeCheck)({ scriptPath, repo, storyPath, maxMutants });
  } catch (e) {
    log(`⚠️  Chequeo de mutantes falló inesperadamente (${e && e.message}) — fail-open, sigue sin frenar.`);
    appendLog('gates.log', {
      name: 'mutation', status: 'error', story: marker.storyId,
      reason: `excepción: ${e && e.message}`, maxMutants,
    });
    return { invoked: true, block: false, reason: 'excepcion' };
  }

  const res = (out && out.result) || {};
  const survived = Array.isArray(res.survived) ? res.survived : [];
  const code = out ? out.code : null;
  const entryBase = {
    name: 'mutation',
    story: marker.storyId,
    repo,
    total: res.total != null ? res.total : null,
    killed: res.killed != null ? res.killed : null,
    survived: survived.length,
    verdict: res.verdict || null,
    maxMutants,
    // la receta que corrió (del JSON del chequeo); sin JSON, no se sabe
    runner: res.runner || 'desconocido',
  };
  // «midió X de N»: un corte por tope dejó mutantes sin correr; el veredicto es sobre los medidos
  if (typeof res.mutants === 'number' && typeof res.total === 'number' && res.total < res.mutants) {
    log(`⚠️  Chequeo de mutantes: midió ${res.total} de ${res.mutants} (el tope de ${res.runner || 'la receta'} cortó antes; el veredicto es sobre los medidos).`);
  }
  // Cuando el chequeo falla, el stderr del hijo es la ÚNICA pista del dev
  // — capturarlo y no mostrarlo lo dejaría a ciegas. Acotado a 15 líneas.
  const volcarStderr = () => {
    const s = ((out && out.stderr) || '').trim();
    if (!s) return;
    log('  ── stderr del chequeo (acotado a 15 líneas) ──');
    for (const l of s.split('\n').slice(0, 15)) log(`  │ ${l}`);
  };

  // Timeout duro del spawn / muerte por señal. El hijo pudo morir con un
  // mutante aplicado (sus handlers restauran, pero acá NO hay confirmación) —
  // no bloquear está bien; no avisar, no.
  if (!out || out.timedOut || code === null) {
    appendLog('gates.log', {
      ...entryBase, status: 'timeout-posible-mutacion',
      reason: 'timeout duro del spawn o muerte por señal — sin confirmación de restore',
    });
    log('🔴 Chequeo de mutantes: TIMEOUT DURO — pudo quedar un archivo MUTADO en disco (el runner murió con un mutante aplicado sin confirmación de restore).');
    log(`   Revisá \`git status\` / \`git diff\` en ${repo}: si hay un cambio que no escribiste (=== por !==, && por ||), es del chequeo.`);
    log(`   Backups con los bytes originales: ${os.tmpdir()}/tycon-mutation-backup-*`);
    log('   El step sigue (no bloquea), pero NO prepares el commit sin mirar esto.');
    volcarStderr();
    return { invoked: true, block: false, reason: 'timeout' };
  }

  // exit 1 — el ÚNICO caso que frena: se rompió el código y NINGÚN test se
  // enteró. SOLO con veredicto COHERENTE del runner (result parseado +
  // verdict correcto + killed 0 + total > 0). exit 1 es también el default de
  // Node ante una excepción no atrapada: sin esta guarda, un crash del chequeo
  // bloquearía el step acusando en falso a los tests del dev (p. ej. EACCES).
  const veredictoCoherente = out.result != null
    && res.verdict === 'TESTS_NO_EJERCEN_EL_CODIGO'
    && res.killed === 0
    && typeof res.total === 'number' && res.total > 0;
  if (code === 1 && !veredictoCoherente) {
    appendLog('gates.log', {
      ...entryBase, status: 'error',
      reason: 'exit 1 SIN veredicto coherente — problema del chequeo, no de los tests',
    });
    log('⚠️  El chequeo de mutantes devolvió exit 1 SIN un veredicto coherente — es un problema del chequeo mismo, no de tus tests. Fail-open, sigue sin frenar.');
    volcarStderr();
    return { invoked: true, block: false, reason: 'exit1-incoherente' };
  }
  // Período de aviso de las recetas nuevas: cero cazados avisa y deja pasar hasta MUTATION_NOTICE_UNTIL.
  const hoy = (today instanceof Date ? today : new Date(today)).toISOString().slice(0, 10);
  if (code === 1 && res.runner && res.runner !== 'node-test' && hoy < MUTATION_NOTICE_UNTIL) {
    appendLog('gates.log', { ...entryBase, status: 'warn-notice', until: MUTATION_NOTICE_UNTIL });
    log(`⚠️  Chequeo de mutantes (${res.runner}): NINGÚN mutante murió — los tests no ejercen el código que la story agregó.`);
    for (const m of survived.slice(0, 3)) {
      log(`    · ${m.file}:${m.line} [${m.operator}] — ${String(m.before).trim()} → ${String(m.after).trim()}`);
    }
    log(`   Avisa y deja pasar: la receta ${res.runner} entra frenando el ${MUTATION_NOTICE_UNTIL}.`);
    return { invoked: true, block: false, reason: 'aviso-receta-nueva' };
  }
  if (code === 1) {
    appendLog('gates.log', { ...entryBase, status: 'blocked' });
    log('marker.js complete-step run-tests BLOQUEADO — chequeo de mutantes: NINGÚN mutante murió.');
    log('');
    log('  Se rompió el código nuevo a propósito (mutantes chicos: === por !==, && por ||, etc.)');
    log('  y la suite siguió en verde: los tests NO ejercen el código que la story agregó.');
    log('  Ejemplos de mutantes que sobrevivieron:');
    for (const m of survived.slice(0, 3)) {
      log(`    · ${m.file}:${m.line} [${m.operator}] — ${String(m.before).trim()} → ${String(m.after).trim()}`);
    }
    log('');
    log('  Agregá tests que cubran esas líneas (o arreglá los que dicen cubrirlas).');
    log('  Saltear este chequeo lo decide la persona, no el agente: no le dictes cómo. Si pregunta cómo seguir,');
    log('  señalale la guía del pipeline (skills/tycon-pipeline/SKILL.md, el chequeo de mutantes).');
    return { invoked: true, block: true, reason: 'cero-muertos' };
  }

  // exit 0 — pasó; con sobrevivientes AVISA, limpio sigue en silencio.
  if (code === 0) {
    if (res.verdict === 'DEADLINE_SIN_CORRER') {
      // un corte que no llegó a medir ninguno: avisa y deja pasar
      appendLog('gates.log', { ...entryBase, status: 'warn-deadline' });
      log(`⚠️  Chequeo de mutantes: el tope cortó antes de medir un solo mutante (${res.runner || 'receta desconocida'}) — no se verificó nada; sigue sin frenar.`);
    } else if (res.verdict === 'SIN_MEDIR') {
      // ningún mutante llegó a medirse (no compilan, o el resultado no se pudo leer): avisa, no es un verde
      const motivo = Array.isArray(res.skipped) && res.skipped[0] ? res.skipped[0].reason : 'sin motivo';
      appendLog('gates.log', { ...entryBase, status: 'warn-unmeasured', reason: motivo });
      log(`⚠️  Chequeo de mutantes: no se pudo medir ningún mutante (${res.runner || 'receta desconocida'}: ${motivo}) — no se verificó nada; sigue sin frenar.`);
    } else if (survived.length) {
      appendLog('gates.log', { ...entryBase, status: 'warn-survivors' });
      log(`⚠️  Chequeo de mutantes: ${survived.length} de ${entryBase.total} mutantes SOBREVIVIERON (nadie los probó). Avisa, no frena:`);
      for (const m of survived) log(`    · ${m.file}:${m.line} [${m.operator}]`);
    } else {
      appendLog('gates.log', { ...entryBase, status: 'pass' });
    }
    return { invoked: true, block: false, reason: 'ok' };
  }

  // exit 2 — estructural: avisa y deja pasar (deliberadamente más blando que el
  // script standalone; una story de docs no declara tests y no debe trabarse).
  if (code === 2) {
    const motivo = res.motivo || 'error estructural sin motivo';
    appendLog('gates.log', { ...entryBase, status: 'structural', reason: motivo });
    log(`⚠️  Chequeo de mutantes NO MEDIDO en ${repo} (${motivo}) — sigue sin frenar.`);
    // El stderr puede traer el grito de RESTORE FALLIDO del hijo — no tragarlo.
    volcarStderr();
    return { invoked: true, block: false, reason: 'estructural' };
  }

  // Exit raro — fail-open avisando.
  appendLog('gates.log', { ...entryBase, status: 'error', reason: `exit inesperado: ${code}` });
  log(`⚠️  Chequeo de mutantes devolvió un exit inesperado (${code}) — fail-open, sigue sin frenar.`);
  volcarStderr();
  return { invoked: true, block: false, reason: 'exit-raro' };
}

module.exports = { runMutationGate, destinosDeLaStory, defaultInvokeCheck, DEFAULT_MAX_MUTANTS, HARD_TIMEOUT_MS, MUTATION_NOTICE_UNTIL };
