/**
 * pipeline-lane.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: los revisores y el pase sobre el carril de arreglo rápido de la sesión, sin corrida.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { deepReviewConfig, fs, os, path, sessionIdFileKey, sessionLogPath, stateDirOf } = require('./pipeline-shared.js');
const { computeAdvisorSet, salidaGrande } = require('./pipeline-advisor-set.js');
const { computeDeepReviewGate } = require('./pipeline-deep-review.js');
const { conModelosDeLaCorrida } = require('./pipeline-models.js');
const { deepReviewAlwaysPaths, runSizeLib } = require('./pipeline-risk.js');

// ── --adhoc: los revisores y el pase del camino rápido ──
// Sin corrida, con el carril firmado de la sesión. `advisors` arma los archivos con los del carril y el diff de cada
// repo contra su base, mide contra el primer repo del carril (o `--repo`), y guarda el `expected` y la hora en el
// registro del carril. `check-count` cuenta los revisores lanzados por la sesión desde esa hora y, completo, escribe la
// constancia de revisores con la huella del carril. `deep-review-gate` decide el pase con el criterio de siempre; un
// pase que no corre por el portón deja su constancia de salteo. No corren las guardas de vuelta ni la marca de inicio
// del paso de revisores, que son de una corrida.
function cmdRevisoresDelCarril(cmd, args) {
  const io = require('./story-gate-io.js');
  const base = require('./adhoc-base.js');
  const dir = stateDirOf(os.homedir());
  const sid = sessionIdFileKey();
  const salir = (texto, codigo = 2) => { process.stderr.write(`🛑 ${cmd} --adhoc: ${texto}\n`); process.exit(codigo); };
  if (io.readMarker(dir, sid)) salir('hay una corrida abierta en esta sesión: manda la corrida. Corré el comando sin --adhoc.');
  const a = io.adhocFirmado(dir, sid, io.readAdhoc(dir, sid));
  if (!a) salir('esta sesión no tiene un camino rápido abierto con su firma (marker.js adhoc set).');
  // lo que miran los revisores: la medida del carril, con las dos rutas de cada cambio, lo anotado y lo que git no sigue
  const medida = base.medirLoPropio(a);
  const porRepo = base.rutasDe(medida, a, { como: 'todo' });
  for (const av of medida.avisos) process.stderr.write(`⚠️  ${av}\n`);
  const repos = Object.keys(porRepo);
  let repo = repos[0] || null;
  if (process.argv.includes('--repo')) {
    // sólo un repo del carril: con una carpeta ajena, su configuración decidiría por el carril
    let pedido;
    try { pedido = fs.realpathSync(path.resolve(args.repo)); } catch (e) { salir(`--repo ${args.repo}: no existe (${e.code || e.message}).`); }
    if (!repos.includes(pedido)) salir(`--repo ${args.repo} no es un repo del camino rápido (${repos.join(', ') || 'ninguno anotado'}).`);
    repo = pedido;
  }
  if (!repo) salir('el camino rápido todavía no anotó ningún archivo: no hay nada que revisar.');
  const files = [...new Set(repos.flatMap((r) => porRepo[r].map((rel) => path.join(r, rel))))];
  const escribir = (cambios) => io.writeAdhoc(dir, sid, { ...io.readAdhoc(dir, sid), ...cambios });

  if (cmd === 'advisors') {
    const set = computeAdvisorSet({ repo, story: null, files });
    set.files = files;
    set.repo = repo;
    set.adhoc = true;
    // la huella de lo que van a ver los revisores: si cambia antes de contarlos, lo que miraron ya no es lo que se guarda
    escribir({ revisoresEsperados: { expected: set.all, desde: new Date().toISOString(), repo, huella: base.huellaDelCarril(io.readAdhoc(dir, sid)) } });
    set.nota = 'camino rápido: lanzá los revisores de `all` y después `pipeline.js check-count --adhoc`.';
    salidaGrande(JSON.stringify(set, null, 2) + '\n', 0);
    return;
  }
  if (cmd === 'check-count') {
    const esperado = a.revisoresEsperados;
    if (!esperado || !Array.isArray(esperado.expected)) salir('el camino rápido todavía no pidió sus revisores: corré `pipeline.js advisors --adhoc` y lanzá los que devuelve.');
    const desde = Date.parse(esperado.desde);
    let lineas = [];
    if (esperado.expected.length) {
      try { lineas = fs.readFileSync(sessionLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch (e) {
        salir(`no pude leer el registro de revisores de la sesión (${sessionLogPath()}: ${e.code || e.message}): no hay contra qué contar.`);
      }
    }
    const ran = [...new Set(lineas.filter((e) => e.advisor && Date.parse(e.ts) >= desde).map((e) => e.advisor))];
    const faltan = esperado.expected.filter((r) => !ran.includes(r));
    if (faltan.length) salir(`faltan ${faltan.length} de ${esperado.expected.length} revisores lanzados desde ${esperado.desde}: ${faltan.join(', ')}`);
    const huella = base.huellaDelCarril(io.readAdhoc(dir, sid));
    if (!base.huellaCompleta(huella)) salir('git no contestó al medir el carril: la huella quedó incompleta y no sirve de constancia. Reintentá.');
    if (esperado.huella && esperado.huella !== huella) salir('los archivos del carril cambiaron después de pedir los revisores: lo que revisaron no es lo que se guarda. Volvé a correr `pipeline.js advisors --adhoc` y lanzalos de nuevo.');
    escribir({ revisores: { huella, at: new Date().toISOString(), ran, expected: esperado.expected } });
    process.stdout.write(`${JSON.stringify({ ok: true, ran: ran.length, expected: esperado.expected.length, huella }, null, 2)}\n`);
    return;
  }
  // deep-review-gate: se decide en CADA repo del carril con sus propios archivos y su configuración, y manda el más
  // estricto (si en uno corre, corre). Sin historia, el tamaño (liviana: sólo documentación) se mide sobre esos
  // archivos, con el mismo clasificador; el portón lo mira donde siempre, después de la configuración y la superficie.
  const decisiones = [];
  for (const r of repos) {
    const deEse = porRepo[r].map((rel) => path.join(r, rel));
    const tam = runSizeLib.classifyStory({
      files: porRepo[r], alwaysPaths: deepReviewAlwaysPaths(r), deepReviewCfg: deepReviewConfig(r), roots: [r],
    });
    const runSize = { size: tam.size, reason: `archivos del camino rápido: ${tam.reason}`, firmado: true };
    const conModelos = conModelosDeLaCorrida({ ...args, repo: r, files: deEse, story: null, runSize });
    // lo del carril se mide desde la base de su medida en ese repo (la misma que leen los frenos), aunque ya esté
    // commiteado. Sin base (lo anotado y el commit) no sirve, y se mide contra la bifurcación de coverage-base.
    let salida = null;
    const suBase = medida.porRepo[r] && medida.porRepo[r].base;
    if (suBase && suBase.de !== 'sin-base' && suBase.sha) salida = suBase.sha;
    else process.stderr.write(`⚠️  deep-review-gate: ${r} no tiene la base del carril medida; mido contra la bifurcación con la rama principal\n`);
    const marcador = salida ? { baseSha: salida, repoPath: r } : null;
    const res = computeDeepReviewGate({ ...conModelos, repo: r, files: deEse, story: null, runSize, marcador });
    if (!res || res.run === null) salir(`${r}: ${(res && res.reason) || 'no pude decidir el pase'}`);
    decisiones.push({ repo: r, res });
  }
  const corre = decisiones.find((d) => d.res.run === true);
  const result = { ...(corre || decisiones[0]).res, repo: (corre || decisiones[0]).repo };
  if (!corre) {
    const huella = base.huellaDelCarril(io.readAdhoc(dir, sid));
    if (!base.huellaCompleta(huella)) salir('git no contestó al medir el carril: la huella quedó incompleta y no sirve de constancia. Reintentá.');
    escribir({ pase: { huella, at: new Date().toISOString(), salteado: true, motivo: decisiones.map((d) => `${d.repo}: ${d.res.reason}`).join(' · ') } });
  }
  process.stdout.write(`${JSON.stringify({ ...result, adhoc: true, files, por_repo: decisiones.map((d) => ({ repo: d.repo, run: d.res.run, reason: d.res.reason })) }, null, 2)}\n`);
}

module.exports = { cmdRevisoresDelCarril };
