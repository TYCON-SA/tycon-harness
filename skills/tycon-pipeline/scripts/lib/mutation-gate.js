'use strict';
/**
 * lib/mutation-gate.js — cableado del CHEQUEO DE MUTANTES en `marker.js
 * complete-step 4` (AVISA, NO FRENA).
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
 *     → BLOQUEA `complete-step 4`. Es el único caso que frena: los tests no
 *     ejercen el código nuevo.
 *   - exit 0 con sobrevivientes → AVISA (archivo:línea [operador]) y deja pasar.
 *   - exit 0 limpio / SIN_MUTANTES → sigue en silencio.
 *   - exit 2 (estructural: story sin tests declarados, etc.) → AVISA y deja
 *     pasar — una story de docs o de config no tiene por qué trabarse.
 *   - Cualquier cosa inesperada (script ausente, excepción, exit raro) →
 *     FAIL-OPEN avisando: un problema del chequeo mismo jamás rompe el cierre.
 *
 * El veredicto queda SIEMPRE en gates.log (total/killed/survived/verdict/
 * maxMutants) — «cuántas corridas tuvieron sobrevivientes» es medible, no una
 * impresión. Escapes: TYCON_MUTATION_CHECK=off (apaga todo) ·
 * `complete-step 4 --no-mutation` (saltea esa corrida, queda en bypass.log).
 *
 * Presupuesto (números medidos, no deseados): el
 * costo es (duración de la suite declarada) × (1 base + mutantes ejecutados) —
 * NO un fijo. Frenos: --max-mutants 12 · deadline 180s ENTRE mutantes (los
 * restantes quedan skipped) · cap 120s por corrida de suite · timeout duro del
 * spawn 300s. Peor caso: el cierre del Step 4 puede irse hasta ~5 minutos
 * con una suite lenta (medido); con la suite del harness (~10s) queda en ~1 min.
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
// El corte de presupuesto lo maneja el RUNNER entre mutantes (corta limpio
// y reporta los restantes como skipped). El timeout del spawn queda como red de
// ÚLTIMO recurso, MÁS ALTO que el deadline — si se dispara, el hijo murió por
// señal y sus handlers restauraron (o gritaron); el gate igual avisa.
const DEFAULT_DEADLINE_MS = 180000;
const HARD_TIMEOUT_MS = 300000;

// Borde real: spawnea mutation-check.js y devuelve { code, result, stderr,
// timedOut } con el exit code REAL y el JSON parseado (o null si no parseó).
function defaultInvokeCheck({ scriptPath, repo, storyPath, maxMutants, deadlineMs = DEFAULT_DEADLINE_MS }) {
  const r = spawnSync(
    process.execPath,
    [scriptPath, '--repo', repo, '--story', storyPath,
      '--max-mutants', String(maxMutants), '--deadline-ms', String(deadlineMs), '--json'],
    { encoding: 'utf8', timeout: HARD_TIMEOUT_MS },
  );
  const stderr = r.stderr || '';
  if (r.error && r.error.code === 'ETIMEDOUT') return { code: null, result: null, stderr, timedOut: true };
  if (r.error) throw r.error;
  if (r.signal) return { code: null, result: null, stderr, timedOut: true };
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { result = null; }
  return { code: r.status === null || r.status === undefined ? null : r.status, result, stderr, timedOut: false };
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
}) {
  // Apagado global: ni se invoca, ni se loguea.
  if (env.TYCON_MUTATION_CHECK === 'off') {
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
    total: res.total != null ? res.total : null,
    killed: res.killed != null ? res.killed : null,
    survived: survived.length,
    verdict: res.verdict || null,
    maxMutants,
  };
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
    log('  Escape consciente: marker.js complete-step run-tests --no-mutation   (queda en bypass.log)');
    return { invoked: true, block: true, reason: 'cero-muertos' };
  }

  // exit 0 — pasó; con sobrevivientes AVISA, limpio sigue en silencio.
  if (code === 0) {
    if (survived.length) {
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
    log(`⚠️  Chequeo de mutantes no aplicable (${motivo}) — sigue sin frenar.`);
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

module.exports = { runMutationGate, defaultInvokeCheck, DEFAULT_MAX_MUTANTS };
