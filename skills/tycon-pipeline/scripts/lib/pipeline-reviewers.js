/**
 * pipeline-reviewers.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: qué revisores y validadores corren y la cuenta de los que corrieron.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, PROPIA, STORY_GOLD, esCodex, fs, os, ownerWindow, packsLib, path, readSessionMarker, readText, sessionLogPath, stateDirOf } = require('./pipeline-shared.js');
const { PRECHEQUEO, aplicarModelosDeRevisores, buildAdvisorContext, conLanzadorCodex, congelarVuelta, contextoConLaCopia, emptyWorkGate, logStep5Start, reglasRevisores, reloopHintsFor, resumenReglas, rethinkGate, salidaDelFreno, tierDe, validateFilesExist } = require('./pipeline-advisor-context.js');
const { MECH_NUNCA_SACA, aplicarDecisionValidador, computeAdvisorSet, computeBase, computeCompletitud, computeConditional, computeMechDiscount, detectStack, lanzadorCodex, paquetesActivos, paquetesInstalados, resumenPaquetes, revisoresPorConfirmar, salidaGrande, sumarPorConfirmar, unique } = require('./pipeline-advisor-set.js');
const { conModelosDeLaCorrida, decirModelos, orgModels, pedidosDeModelos } = require('./pipeline-models.js');
const { computeRiskClass, computeRunSize, parseFrontmatterList, runSizeDelMarcador } = require('./pipeline-risk.js');
// Estado del log DESDE el último step5-start. Devuelve:
//   { sawStart: bool, expected: string[]|null, ran: string[] }
// — sawStart=false → no hay log/marca (hook no instalado o pipeline.js no corrió).
// — sawStart=true + ran=[] → pipeline.js SÍ corrió pero el hook no registró NINGÚN
//   spawn: o no se corrieron los advisors o la registración está rota. El caller
//   (check-count) FALLA CERRADO en este caso: caer en silencio al --ran del LLM
//   dejaría pasar un paso de revisores sin ningún spawn registrado.
function advisorsRunSinceStart() {
  let raw;
  try { raw = fs.readFileSync(sessionLogPath(), 'utf8'); } catch { return { sawStart: false, expected: null, ran: [] }; }
  const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (lines.length === 0) return { sawStart: false, expected: null, ran: [] };
  const startIdx = require('./advisor-round.js').inicioDeLaRonda(lines);
  // `nuevaCorrida`: el registro tiene una ronda, pero de la corrida anterior; ésta todavía no corrió `advisors`
  if (startIdx === -1) return { sawStart: false, expected: null, ran: [], nuevaCorrida: lines.some((e) => e.event === 'step5-start') };
  // Una línea del lanzador de Codex (`launcher: 'pipeline'`) cuenta sólo si el proceso salió 0 y dejó su reporte: una
  // línea escrita a mano, un tope de tiempo o una salida distinta no son un revisor corrido. Las que no cuentan quedan
  // nombradas con su motivo (las tapa una corrida buena posterior del mismo revisor).
  const ran = [];
  const fallidos = {};
  for (const e of lines.slice(startIdx)) {
    // un revisor que el lanzador de Codex no pudo correr: se nombra, salvo que una corrida posterior lo tape
    if (e.event === 'launch-failed' && e.failed_advisor) {
      if (!ran.includes(e.failed_advisor)) fallidos[e.failed_advisor] = motivoLanzamientoInvalido(e) || 'falló';
      continue;
    }
    if (!e.advisor) continue;
    const motivo = e.launcher === 'pipeline' ? motivoLanzamientoInvalido(e) : null;
    if (motivo) { fallidos[e.advisor] = motivo; continue; }
    ran.push(e.advisor);
    delete fallidos[e.advisor];
  }
  const expected = Array.isArray(lines[startIdx].expected) ? lines[startIdx].expected : null;
  return { sawStart: true, expected, ran: [...new Set(ran)], fallidos };
}

function motivoLanzamientoInvalido(e) {
  if (e.exit !== 0) return e.exit === 'timeout' ? 'timeout' : `salió ${e.exit}`;
  try { if (fs.statSync(e.report).size > 0) return null; } catch { /* sin archivo */ }
  return 'sin reporte';
}

// Contenido de los archivos del diff que son código (cap para no leer gigas).
function readDiffContents(repo, files, exts) {
  const out = [];
  for (const f of files) {
    if (exts && !exts.some((e) => f.endsWith(e))) continue;
    const abs = path.isAbsolute(f) ? f : path.join(repo, f);
    const c = readText(abs);
    if (c) out.push({ file: f, content: c.slice(0, 200000) });
  }
  return out;
}
const CORE_REVIEWERS = Object.freeze([
  { agent: 'tycon-plugin-tests-coverage', group: 'always', whenKey: 'revisorCuando.codigo', probe: { files: { 'src/a.js': 'module.exports = 1;\n' } } },
  { agent: 'tycon-plugin-security-basics', group: 'always', whenKey: 'revisorCuando.codigoOSecretos', probe: { files: { 'src/a.js': 'module.exports = 1;\n' } } },
  { agent: 'tycon-story-validator', group: 'story', whenKey: 'revisorCuando.hayHistoria', probe: { files: { 'README.md': '# x\n' }, story: STORY_GOLD } },
  { agent: 'tycon-spec-first-checker', group: 'story', whenKey: 'revisorCuando.hayHistoria', probe: { files: { 'README.md': '# x\n' }, story: STORY_GOLD } },
  { agent: 'tycon-ac-coverage-checker', group: 'story', whenKey: 'revisorCuando.criteriosOPruebas', probe: { files: { 'README.md': '# x\n' }, story: STORY_GOLD } },
  { agent: 'tycon-deferral-tracker', group: 'story', whenKey: 'revisorCuando.dejaParaDespues', probe: { files: { 'README.md': '# x\n' }, story: `${STORY_GOLD.replace('---\n\n', 'pipelines:\n  - name: A\n    status: in-progress\n---\n\n')}` } },
  { agent: 'tycon-e2e-realness-checker', group: 'change', whenKey: 'revisorCuando.puntaAPunta', probe: { files: { 'tests/e2e/a.spec.ts': "test('a', async () => {});\n" } } },
  { agent: 'tycon-silent-failure-hunter', group: 'change', whenKey: 'revisorCuando.manejaErrores', probe: { files: { 'src/a.js': 'try { x(); } catch (e) {}\n' } } },
  { agent: 'llm-cost-reviewer', group: 'change', whenKey: 'revisorCuando.modelos', probe: { files: { 'src/a.ts': "import Anthropic from '@anthropic-ai/sdk';\n" } } },
  { agent: 'i18n-hardcoded-text-reviewer', group: 'change', whenKey: 'revisorCuando.textosTraducibles', probe: { files: { 'src/a.tsx': 'export const A = () => <p>Hola</p>;\n' }, advisorsYaml: 'i18n:\n  required: true\n' } },
]);

/** Los nombres de revisor que el cálculo del núcleo puede devolver: los literales de las tres funciones que lo arman. */
function coreReviewerNames() {
  const fuente = [computeBase, computeCompletitud, computeConditional].map((f) => f.toString()).join('\n');
  return [...new Set([...fuente.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+){2,})'/g)].map((m) => m[1]))].sort();
}

/**
 * Si la tabla del núcleo y `computeAdvisorSet` dicen lo mismo: `missing` (el cálculo lo puede devolver y la tabla no lo
 * tiene), `extra` (la tabla lo nombra y el cálculo nunca lo devuelve) y `notTriggered` (el caso de la fila no lo hace
 * entrar). Los casos corren en carpetas aparte, sin paquetes: sólo cuenta el núcleo.
 */
function coreReviewersDrift({ table = CORE_REVIEWERS } = {}) {
  const nombres = coreReviewerNames();
  const enTabla = table.map((r) => r.agent);
  const notTriggered = [];
  const prev = process.env.TYCON_PACKS_DIR;
  const sinPaquetes = fs.mkdtempSync(path.join(os.tmpdir(), 'core-reviewers-packs-'));
  process.env.TYCON_PACKS_DIR = sinPaquetes;
  try {
    for (const r of table) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'core-reviewers-'));
      try {
        const files = Object.keys(r.probe.files || {});
        for (const f of files) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), r.probe.files[f]); }
        if (r.probe.advisorsYaml) { fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true }); fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), r.probe.advisorsYaml); }
        let story = null;
        if (r.probe.story) { story = path.join(repo, 'story.md'); fs.writeFileSync(story, r.probe.story); }
        if (!computeAdvisorSet({ repo, story, files }).all.includes(r.agent)) notTriggered.push(r.agent);
      } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    }
  } finally {
    if (prev === undefined) delete process.env.TYCON_PACKS_DIR; else process.env.TYCON_PACKS_DIR = prev;
    fs.rmSync(sinPaquetes, { recursive: true, force: true });
  }
  return {
    missing: nombres.filter((n) => !enTabla.includes(n)),
    extra: enTabla.filter((n) => !nombres.includes(n)),
    notTriggered,
  };
}
const TIER_TO_MODEL = MODELOS.TIERS;
/**
 * Los revisores de código: los que el cálculo del set de una vuelta puede devolver, del núcleo y de los paquetes activos
 * del repo (sin los de validación de la historia, que no tienen vueltas). Es la lista con la que un revisor lanzado fuera
 * del set de la vuelta cuenta como parte de ella (on-advisor-run.js): un agente de otra etapa, de exploración o de guía
 * no está. Casos: tests/smart-reloop-blindness.test.js (AdvisorRun_OutsideSet). Con un paquete roto o que falta, sólo los del núcleo: el freno de la vuelta ya lo dice.
 */
function codeReviewerNames(repo) {
  let dePaquetes = [];
  try { dePaquetes = paquetesActivos(repo).flatMap((p) => p.revisores.filter((r) => r.grupo !== 'validacion').map((r) => r.agente)); } catch (_e) { dePaquetes = []; }
  return unique([...coreReviewerNames(), ...dePaquetes]);
}

// ── pipeline.js validators — los revisores de validación del paso «Validar la historia» ────────────────
// El paso «Validar la historia» lanza al validador de stories y, si la story es de backend, a los revisores del grupo
// `validacion` de los paquetes activos (hoy: el de plugins hermanos, del paquete clients). El step corre
// este comando y lanza lo que
// devuelve. «Story de backend» = la story nombra .cs/.csproj, o el repo tiene *.csproj / *Plugin.cs:
// esos archivos son el contexto sobre el que se evalúa `when` (`added` lee el archivo entero:
// en «Validar la historia» no hay diff).
function archivosDotnetDelRepo(repo, tope = 200) {
  const out = [];
  const SALTAR = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'packages', '.advisors']);
  const walk = (dir, depth) => {
    if (out.length >= tope || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (out.length >= tope) return;
      if (e.isDirectory()) {
        if (!SALTAR.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (/\.csproj$/i.test(e.name) || /Plugin\.cs$/.test(e.name)) out.push(path.relative(repo, path.join(dir, e.name)));
    }
  };
  walk(repo, 0);
  return out;
}
/**
 * Los hermanos declarados de los paquetes activos, en su ruta esperada bajo la raíz de repos de la máquina
 * (scripts/lib/repos-root.js, que honra TYCON_REPOS_ROOT). Sin raíz, se dice; nunca se busca.
 */
function hermanosDelRepo(activos) {
  let raiz = null;
  let raices = [];
  let motivo = null;
  try {
    const r = require(path.join(packsLib.raizAgentSkills(), 'scripts', 'lib', 'repos-root.js')).resolveReposRoot();
    raiz = r.root || null;
    raices = Array.isArray(r.roots) ? r.roots : [];
    if (!raiz) motivo = r.motivo || 'sin raíz de repos';
  } catch (e) { motivo = `no pude leer la raíz de repos (${e.message})`; }
  // con varias carpetas de repos, el hermano se busca en todas
  const lista = packsLib.hermanosResueltos({ paquetes: activos, reposRoot: raiz, reposRoots: raices });
  return { raiz, motivo, lista, texto: packsLib.textoDeHermanos(lista, { reposRoot: raiz }) };
}

/** Con todos = true: la lista de lo que PUEDE correr en «Validar la historia» (la página del arnés), sin mirar la máquina ni la constancia. */
function computeValidadores({ story, repo, todos = false, deprecados = true }) {
  if (!story) throw new Error('validators: falta --story <spec.md>');
  // Una ruta mal tipeada no puede dar un set «válido» a medias:
  // sin story legible o sin repo no hay contexto sobre el que decidir nada.
  const content = readText(story);
  if (!content) throw new Error(`validators: no se pudo leer la story ${story}`);
  let repoEsDir = false;
  try { repoEsDir = fs.statSync(repo).isDirectory(); } catch (_e) { repoEsDir = false; }
  if (!repoEsDir) throw new Error(`validators: --repo no es una carpeta: ${repo}`);
  const declarados = [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')]
    .map((f) => f.replace(/^\([^)]*\)\s+/, ''));   // "(agent-skills) ruta" → ruta; `(app)/page.tsx` (un grupo de rutas, sin espacio) queda entera
  const files = unique([...declarados, ...archivosDotnetDelRepo(repo)]);
  const det = detectStack(repo, files);
  const activos = paquetesActivos(repo);
  const ctx = { det, files, agregado: (exts) => readDiffContents(repo, files, exts) };
  const lanzamientos = [];
  let hermanos = null;   // se resuelven una vez, y sólo si algún revisor de validación entra
  for (const p of activos) {
    for (const r of p.revisores) {
      if (r.grupo !== 'validacion' || !packsLib.evaluarCondicion(r.cuando, ctx)) continue;
      if (!hermanos) hermanos = hermanosDelRepo(activos);
      lanzamientos.push({
        agente: r.agente, paquete: p.nombre, modelo: r.modelo,
        prompt: packsLib.rendirPrompt(r.prompt, { story_path: story, repo_path: repo, siblings: hermanos.texto }),
        nota: r.nota,
      });
    }
  }
  // el revisor de historias entra cuando su portón dice que corre (NORMAL, sin constancia vigente, no apagado)
  const previa = todos
    ? { run: true, record: 'none', ...((m) => ({ model: m.model, model_reason: m.reason }))(MODELOS.resolveStoryReview({})) }
    : computeStoryReviewGate({ story });
  if (previa.run) {
    lanzamientos.push({
      agente: MODELOS.STORY_REVIEWER, paquete: null, modelo: previa.model,
      prompt: promptRevisorDeHistorias({ story, repo }),
      nota: `la revisión previa no tiene constancia vigente (${previa.record}): corre una vez, en el mismo mensaje que el validador; ` +
        `modelo: ${previa.model_reason}. Al terminar, story-review-record con --tokens y --duration-ms del resultado del lanzamiento.`,
    });
  }
  // una historia que no cambió desde su última validación verde no se vuelve a validar (lib/validation-record.js)
  let validadores = ['tycon-story-validator', ...lanzamientos.map((l) => l.agente)];
  let validacionPrevia = null;
  if (!todos) {
    let leida = validationRecord.readRecord(os.homedir(), story);
    // cambiada sólo en lo técnico después de un plan rechazado: la revalida la vuelta siguiente del plan
    if (leida.estado === 'stale') {
      const pr = require('./story-revalidation.js').porRevalidar({ home: os.homedir(), storyPath: story });
      if (pr.aplica) leida = pr.validacion;
    }
    const v = validationRecord.omitirVigentes({ validadores, lanzamientos }, leida);
    validadores = v.validadores;
    lanzamientos.splice(0, lanzamientos.length, ...v.lanzamientos);
    validacionPrevia = { estado: leida.estado, omitidos: v.omitidos, linea: validationRecord.linea(leida, v.omitidos) };
  }
  return {
    story, repo,
    validadores,
    lanzamientos,
    validacion_previa: validacionPrevia,
    packs: resumenPaquetes(activos), packs_dir: packsLib.dirPaquetes(),
    packs_nota: packsLib.notaDePaquetes({ repo, instalados: paquetesInstalados(), activos }),
    contexto: { files, detection: det },
    dependencias_de_pruebas: require('./test-deps.js').dependenciasDePruebas({ repo, storyText: content }),
    // los archivos declarados que están deprecados en el repo: el validador los reporta como VAL-C9. `deprecados: false`
    // lo pide quien sólo muestra qué validadores hay (la vista del sitio): consultar la lista lanza git y anota en gates.log
    archivos_deprecados: deprecados ? require('./deprecated.js').archivosDeHistoria({ repo, storyText: content }) : [],
  };
}

/**
 * Corrida liviana: el modelo barato para TODOS los revisores del set, lo de `--cost-tier lean` ampliado.
 * Con `--cost-tier deep` (la auditoría a pedido) no se toca. En una completa no cambia nada.
 */
function aplicarTamanoALosRevisores(set, args) {
  if (args.costTier === 'deep') return;
  const runSize = computeRunSize(args);
  set.run_size = runSize.size;
  if (runSize.size !== 'liviana') return;
  const barato = TIER_TO_MODEL.lean;
  if (set.reviewer_models) {
    for (const r of set.all) set.reviewer_models[r] = { ...(set.reviewer_models[r] || {}), model: barato, origin: 'run-size' };
  } else {
    set.model_hints = Object.fromEntries(set.all.map((r) => [r, barato]));
    delete set.reloop_model_hints;
    delete set.reloop_model_hints_note;
  }
  set.cost_tier = 'liviana';
  set.run_size_note = `corrida liviana (${runSize.reason}): todos los revisores en ${barato}`;
}

function modelHintsForSet({ all, tier }) {
  // tier: 'lean' (opt-in) | 'standard' (default — no hints) | 'deep' (force opus everywhere)
  if (tier === 'standard' || !tier) return null; // no hints — orchestrator usa frontmatter
  const hints = {};
  for (const advisor of all) {
    const declared = tierDe(advisor);
    if (!declared) continue; // sin tier declarado → orchestrator decide
    if (tier === 'lean') {
      // En modo lean: solo emitimos hint para los `lean` (haiku). Resto queda igual.
      if (declared === 'lean') hints[advisor] = TIER_TO_MODEL.lean;
    } else if (tier === 'deep') {
      // Modo deep: forzamos opus en todos (escape hatch para auditorías paranoicas).
      hints[advisor] = TIER_TO_MODEL.deep;
    }
  }
  return Object.keys(hints).length ? hints : null;
}

// ── pipeline.js story-review-gate — la revisión adversarial de la historia, antes de programar ──
// ¿Corre el revisor de historias? No tiene clasificador ni resolución de modelo propios: reusa `computeRiskClass` (LOW
// se saltea) y `models.js` (`adversarial.story`). Una constancia vigente (lib/story-review-record.js) no se relanza;
// `no-medido` y una historia cambiada sí. `TYCON_STORY_REVIEW=0` la apaga, y el salteo igual se registra con su motivo.
const storyReviewRecord = require('./story-review-record.js');
const validationRecord = require('./validation-record.js');
function computeStoryReviewGate({ story, env = process.env, home = os.homedir() }) {
  const { estado, record } = storyReviewRecord.readRecord(home, story);
  // un salteo no es una revisión: se vuelve a decidir cada vez (la revisión prendida otra vez, o la historia ya no LOW)
  // `pendiente` no se relanza (una sola pasada) pero tampoco es una revisión hecha: falta la respuesta a su pregunta
  if (estado === 'current' && record.resultado === 'pendiente') {
    return {
      run: false, record: estado, riesgo: record.riesgo, pendiente: true,
      linea: `revisión previa pendiente: falta la respuesta a su pregunta (${record.hallazgos.length} hallazgos, ${record.modelo || 'sin modelo'}); la historia no está lista para programar`,
    };
  }
  if (estado === 'current' && record.resultado !== 'saltado') {
    return {
      run: false, record: estado, riesgo: record.riesgo,
      linea: `revisión previa vigente: ${record.resultado}, ${record.hallazgos.length} hallazgos, ${record.modelo || 'sin modelo'}`,
    };
  }
  // cambiada sólo en lo técnico después de un plan rechazado: la revalida la vuelta siguiente del plan, que ve el cambio
  if (estado === 'stale' && record.resultado !== 'saltado') {
    const pr = require('./story-revalidation.js').porRevalidar({ home, storyPath: story });
    if (pr.aplica) {
      return {
        run: false, record: 'por-revalidar', riesgo: record.riesgo, por_revalidar: true,
        linea: `revisión previa a revalidar por la vuelta del plan: la historia cambió sólo en ${pr.cambios.map((c) => c.parte).join('; ')} después del plan rechazado (${pr.rechazo.ts})`,
      };
    }
  }
  const rc = computeRiskClass({ story });
  if (env.TYCON_STORY_REVIEW === '0') {
    // el salteo lo anota el portón, no el modelo
    // la lista se busca también con las skills en un clon aparte; sin ella no se puede anotar, y se dice
    const ES = require('./controls-off.js').listaDeInterruptores();
    if (typeof ES.anotarEscape === 'function') ES.anotarEscape({ home, sessionId: ES.sesionDe(env), kind: 'STORY_REVIEW_OFF', variable: 'TYCON_STORY_REVIEW', story: path.resolve(story), riesgo: rc.risk });
    else process.stderr.write('story-review-gate: TYCON_STORY_REVIEW=0, pero no encontré la lista de variables del arnés (scripts/lib/env-switches.js): el salteo no quedó anotado\n');
    // antes de la fecha de corte de la lista única, el agente lee el aviso; desde ese día la variable pide la firma
    if (typeof ES.antesDelCorte === 'function' && ES.antesDelCorte('TYCON_STORY_REVIEW')) {
      process.stderr.write(`⚠️  TYCON_STORY_REVIEW=0: desde ${ES.corteDe('TYCON_STORY_REVIEW')} esto pide la firma de una persona (escape:TYCON_STORY_REVIEW); hasta entonces pasa, avisado y anotado.\n`);
    }
    return { run: false, record: estado, riesgo: rc.risk, motivo: 'apagado', nota: 'TYCON_STORY_REVIEW=0' };
  }
  if (rc.risk === 'LOW') return { run: false, record: estado, riesgo: 'LOW', motivo: 'riesgo-bajo', criterios: rc.criteria };
  const warnings = [];
  const m = MODELOS.resolveStoryReview({ org: orgModels().data, requests: pedidosDeModelos(readSessionMarker()), warnings });
  return {
    run: true, record: estado, riesgo: rc.risk, model: m.model, model_origin: m.origin, model_reason: m.reason,
    ...(warnings.length ? { avisos: warnings.map((w) => w.message) } : {}),
  };
}

/** El pedido al revisor de historias en «Validar la historia», donde corre en el mismo mensaje que el validador (el de `tycon-create-story` lo trae su guía). */
function promptRevisorDeHistorias({ story, repo }) {
  return `Revisá la historia ${story} contra el repo ${repo}, antes de programarla. Una sola pasada, de sólo lectura. ` +
    'Corrés en paralelo con el validador de stories: no repitas lo que es de su catálogo (VAL-*). ' +
    'Cada hallazgo con su regla SADV, el criterio o la sección, y su evidencia; sin evidencia no es hallazgo. ' +
    'Cerrá con el renglón «Veredicto:».';
}

function cmdAdvisors(cmd, args) {
  // Files fantasma (shell quoting roto) degradarían el set
  // a onlyDocs y PERSISTIRÍAN un expected[] corrupto. Abort explícito, no fail-open.
  // 🔴 La vuelta 3 en adelante pide su nota también por acá: `advisors --iter N` devuelve el set completo y es el
  // fallback del re-loop; sin este freno la nota se esquivaría pidiendo el set por este camino.
  // El freno corre DESPUÉS de las validaciones propias del comando: sus errores salen como siempre.
  const filesErr = validateFilesExist(args);
  if (filesErr) { process.stderr.write(filesErr); process.exit(2); }
  const emptyWork = emptyWorkGate(args);
  if (emptyWork) { process.stderr.write(emptyWork); process.exit(2); }
  salidaDelFreno(rethinkGate(args));
  if (process.env[PRECHEQUEO] === '1') process.exit(0);
  const set = computeAdvisorSet(args);
  // Descuento automático de advisors cubiertos por mech-check (coherente
  // con el expected[] que se persiste abajo — check-count valida contra el set
  // YA descontado, así el orquestador no spawnea LLMs para checks que corren gratis).
  // Sin poder leer los críticos de la corrida no se descuenta: no saber si hay algo por confirmar no es «nada».
  const pc = revisoresPorConfirmar(args);
  const disc = pc.error ? null : computeMechDiscount(set.all, args);
  if (disc && disc.discounted.length) {
    set.all = disc.kept;
    set.required_count = disc.kept.length;
    set.mech_discounted = disc.discounted;
    set.mech_findings = disc.mech_findings;
    set.mech_note = `mech-check descontó ${disc.discounted.length} advisor(s) del set/expected (checks mecánicos, 0 tokens). ` +
      (disc.mech_findings.length ? `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS — van DIRECTO al reporte consolidado del paso de hallazgos.` : 'Sin findings mecánicos.') +
      ` ${MECH_NUNCA_SACA}`;
  } else if (disc && disc.mech_findings.length) {
    set.mech_findings = disc.mech_findings;
    set.mech_note = `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS (mech-check) — van DIRECTO al reporte consolidado.`;
  }
  // el revisor de un crítico arreglado vuelve, por encima del descuento: sin él, el cierre pide la exención del dueño
  set.all = sumarPorConfirmar(set.all, set, pc);
  set.required_count = set.all.length;
  for (const l of [...(pc.error ? [`no pude leer los críticos de la corrida (${pc.error}): no descuento`] : []), ...pc.fuera]) process.stderr.write(`⚠️  ${l}\n`);
  // Enriquecer con model_hints solo si el caller pidió un tier opt-in.
  // Default (tier=null o 'standard'): output sin model_hints (zero regresión).
  const hints = modelHintsForSet({ all: set.all, tier: args.costTier });
  if (hints) {
    set.model_hints = hints;
    set.cost_tier = args.costTier;
  }
  // Re-loop invocado vía `advisors --iter N>1` (el
  // fallback típico cuando smart-reloop no aplica) TAMBIÉN baja los tier
  // deep a sonnet — si no, este path correría spec-first/sibling a Opus pleno.
  const rHints = reloopHintsFor(set.all, args.iter, args.costTier);
  if (rHints) {
    set.reloop_model_hints = rHints;
    set.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
  }
  // Con la configuración de la organización o un pedido de la corrida, un modelo por revisor
  // (`reviewer_models`) en lugar de `model_hints`. La decisión del validador de abajo puede sumar uno: se completa.
  const conModelos = conModelosDeLaCorrida(args);
  const avisosModelos = aplicarModelosDeRevisores(set, set.all, conModelos);
  // Contexto compartido: UN artefacto por iteración con
  // digest de story + file list + hunks. Los advisors lo reciben como input
  // primario en vez de re-leer story completa + re-correr git diff cada uno.
  // Lo que se revisa, congelado: sin sello o sin copia, la vuelta no se lanza.
  const congelada = congelarVuelta({ story: args.story, repo: args.repo, iter: args.iter });
  if (congelada.error) {
    process.stderr.write(`🛑 pipeline.js advisors: la vuelta no se lanza — ${congelada.error}. Los revisores no leen la carpeta viva.\n`);
    process.exitCode = 2;
    return;
  }
  if (congelada.aviso) process.stderr.write(`⚠️  pipeline.js advisors: ${congelada.aviso}.\n`);
  set.frozen = congelada.repos;
  const ctx = buildAdvisorContext({ repo: args.repo, story: args.story, files: args.files, iter: args.iter });
  contextoConLaCopia(ctx, congelada.repos);
  // El estado de la sección «Reglas para revisores» del repo (el orquestador avisa al
  // dev en una línea si no está `presente`; nunca frena — guía del paso de revisores §Reglas del repo).
  set.reglas_revisores = resumenReglas(ctx && ctx.reglas ? ctx.reglas : reglasRevisores(args.repo));
  if (ctx) {
    set.context_file = ctx.context_file;
    // Overrides por advisor: si un advisor figura acá, se le pasa ESTE archivo en vez del
    // compartido (sólo `tycon-story-validator` — ver comentario en buildAdvisorContext).
    set.context_file_overrides = ctx.overrides;
  }
  // Regla de batcheo (máquina dev 8c/16GB): ventana deslizante de ≤4 vivos.
  set.batch_rule = 'Ventana deslizante: MÁXIMO 4 subagentes VIVOS a la vez (máquina 8c/16GB). Al llegar la notificación de que uno terminó, lanzar el siguiente del set en ese turno — no esperar a que termine el grupo entero. NUNCA lanzar el set completo en un solo mensaje paralelo si supera 4. ⚠️ Si el pase adversarial fue lanzado al cerrar «Correr las pruebas» y sigue en vuelo, el cap baja a 2 — este string no conoce ese estado: manda la guía del paso de revisores §Cap reducido. Avisos al dev agrupados por hito (mitad del set y set completo), no por advisor.';
  conLanzadorCodex(set, args);
  // El validador de stories en los re-loops: se decide ANTES de persistir el expected.
  aplicarDecisionValidador(set, 'all', args);
  if (set.reviewer_models) {
    const faltan = set.all.filter((r) => !set.reviewer_models[r]);
    if (faltan.length) {
      const extra = {};
      avisosModelos.push(...aplicarModelosDeRevisores(extra, faltan, conModelos, set.all));
      Object.assign(set.reviewer_models, extra.reviewer_models || {});
    }
    for (const r of Object.keys(set.reviewer_models)) if (!set.all.includes(r)) delete set.reviewer_models[r];
  }
  // en una corrida liviana todos los revisores van en el modelo barato (los de completitud siguen en el
  // set: el descuento mecánico de arriba no mira el tamaño).
  aplicarTamanoALosRevisores(set, { ...args, runSize: runSizeDelMarcador(args.story) });
  decirModelos(set, conModelos.orgModels, avisosModelos);
  // expected persistido (post-descuento); el contexto también, para que `reviewers-run` lance lo mismo
  logStep5Start(set.all, { mode: 'advisors', iter: args.iter, context_file: set.context_file, context_file_overrides: set.context_file_overrides });
  salidaGrande(JSON.stringify(set, null, 2) + '\n', 0);
  return;
}


// Los revisores de validación del paso «Validar la historia» salen de acá, no de la prosa del step.
//   node pipeline.js validators --story <spec.md> --repo <dir>
//     → { validadores: ['tycon-story-validator', ...], lanzamientos: [{agente, paquete, modelo, prompt, nota}], packs }
// siblings — los hermanos declarados de los paquetes activos en el repo, en su ruta esperada (para el revisor que no
// recibe {siblings} en su pedido). Un paquete roto sale 2, como en validators.
function cmdSiblings(cmd, args) {
  let repoEsDir = false;
  try { repoEsDir = fs.statSync(args.repo).isDirectory(); } catch (_e) { repoEsDir = false; }
  if (!repoEsDir) { process.stderr.write(`🛑 siblings: --repo no es una carpeta: ${args.repo}\n`); process.exit(2); }
  const h = hermanosDelRepo(paquetesActivos(args.repo));
  process.stdout.write(JSON.stringify({ repo: args.repo, raiz: h.raiz, ...(h.motivo ? { motivo: h.motivo } : {}), hermanos: h.lista, texto: h.texto }, null, 2) + '\n');
  return;
}

function cmdValidators(cmd, args) {
  let salida;
  try {
    salida = computeValidadores(args);
  } catch (e) {
    if (e instanceof packsLib.PackError) throw e;   // lo formatea el cierre de abajo (exit 2)
    process.stderr.write(`🛑 ${e.message}\n`);
    process.exit(2);
  }
  salidaGrande(JSON.stringify(salida, null, 2) + '\n', 0);
  return;
}


// ── reviewers-run — bajo Codex, el pipeline lanza los revisores de la vuelta ──
// Cada revisor del set de `advisors` como un proceso `codex exec` aparte; la constancia queda en el mismo registro que
// lee `check-count`. Bajo Claude Code el paso no lo usa: lanza con Agent(...). Ver lib/codex-reviewers.js.
function cmdReviewersRun(cmd, args) {
  require('./codex-reviewers.js').run({ repo: args.repo, story: args.story }).then((r) => {
    process.stdout.write(JSON.stringify({ launched: r.launched, skipped: r.skipped, results: r.results, reports_dir: r.reports_dir || null, ...(r.error ? { error: r.error } : {}) }, null, 2) + '\n');
    process.exitCode = r.code;
  }, (e) => { process.stderr.write(`reviewers-run: ${(e && e.message) || e}\n`); process.exitCode = 2; });
  return;
}

function cmdCheckCount(cmd, args) {
  // contar sin la constancia de que corrieron lo firma el dueño, siempre y antes de contar: con la firma, el registro
  // de revisores que se lee es el de la sesión destino (sessionLogPath lee la variable que fija fijarDestino)
  if (args.trustRan) {
    const ow = ownerWindow();
    const stateDir = stateDirOf(os.homedir());
    const anotar = (g) => { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...g })}\n`); };
    // lo que haría inútil la firma, antes de pedirla: sin lista no hay qué confiar, y con los revisores en el registro se
    // cuentan esos. El registro de otra sesión se lee recién con la firma, así que para ella sólo se mira la lista
    const antes = () => {
      if (!args.ran.length) return { codigo: 2, motivo: '--trust-ran confía en la lista de --ran, y el comando no trae --ran: no habría nada que contar' };
      if (estadoPipeline.paraOtra) return null;
      const s = advisorsRunSinceStart();
      if (s.nuevaCorrida) return { codigo: 2, motivo: 'esta ejecución todavía no lanzó revisores: corré `pipeline.js advisors` y lanzá los que devuelve' };
      if (s.sawStart && s.ran.length) return { codigo: 2, motivo: 'el registro ya tiene los revisores lanzados: se cuentan sin --trust-ran, sin firma' };
      return null;
    };
    const r = ow.exigir({ firma: 'escape:trust-ran', argv: process.argv.slice(1), propia: PROPIA, anotar, antes,
      resumen: `contar los revisores de ${args.story ? path.basename(args.story) : 'la corrida'} sin la constancia de que corrieron` });
    // lo firma la persona: sin su firma no se cuenta
    const noSeConto = (motivo, codigo) => { process.stderr.write(`🛑 check-count: no se contó sin la firma de la persona — ${motivo}.\n`); process.exit(codigo); };
    if (r.codigo !== 0) noSeConto(r.motivo, r.codigo);
    const f = ow.fijarDestino({ r, propia: PROPIA, necesitaMarcador: !!estadoPipeline.paraOtra, leerMarcador: (sid) => ow.marcadorEn(path.join(stateDir, 'active', `${sid}.json`)) });
    if (f.codigo !== 0) noSeConto(f.motivo, f.codigo);
  }
  const state = advisorsRunSinceStart();
  // Una corrida nueva sin `advisors`: la ronda que hay en el registro es de la anterior. Ni se cuenta (sus
  // revisores no vieron este código) ni se acepta el `--ran` declarado: se frena, como sin ningún spawn.
  if (state.nuevaCorrida) {
    process.stderr.write('check-count: esta ejecución todavía no lanzó revisores (la última ronda del registro es de la ejecución anterior de la sesión).\n' +
      '   Corré `pipeline.js advisors` y lanzá los revisores que devuelve.\n');
    process.exit(2);
  }
  // Expected: el set persistido en el step5-start de ESTA
  // iteración — en smart-reloop legítimo es el subset `rerun`, así el gate y
  // el smart-reloop no se anulan mutuamente. Fallback: recomputar set completo
  // (corridas viejas sin expected en el log).
  let expected;
  let expectedSource;
  if (state.sawStart && state.expected && state.expected.length) {
    expected = state.expected;
    expectedSource = 'expected persistido en step5-start (coherente con smart-reloop)';
  } else if (state.sawStart && Array.isArray(state.expected) && state.expected.length === 0) {
    // Set VACÍO persistido (mech-check sin advisors aplicables): no hay nada que correr → OK, sin
    // recompute: caer al recompute daría el fail-closed "CERO spawns".
    expected = [];
    expectedSource = 'set esperado VACÍO persistido en step5-start (mech-check: ningún advisor aplicable)';
  } else {
    // Fallback recompute — aplicar el MISMO descuento mech que advisors/smart-reloop
    // (sin esto, el fallback exigiría advisors
    // que el orquestador legítimamente no spawneó por descuento → exit 2 falso).
    const recomputed = computeAdvisorSet(args);
    const pc = revisoresPorConfirmar(args);
    const disc = pc.error ? null : computeMechDiscount(recomputed.all, args);
    // el revisor de un crítico arreglado: el mismo que suman advisors y smart-reloop
    expected = sumarPorConfirmar((disc && disc.discounted.length) ? disc.kept : recomputed.all, {}, pc);
    expectedSource = 'recomputado (step5-start sin expected — corrida pre-upgrade o log ausente)' +
      ((disc && disc.discounted.length) ? ` con descuento mech aplicado (${disc.discounted.map((d) => d.name).join(', ')})` : '');
    // El mismo descuento del validador que aplicó el re-loop —sin él,
    // el recálculo exigiría al validador que el re-loop soltó y daría un rojo falso—. Sin anotar: no es una decisión nueva.
    const conValidador = { all: expected };
    aplicarDecisionValidador(conValidador, 'all', args, { anotar: false });
    if (conValidador.all.length !== expected.length) {
      expected = conValidador.all;
      expectedSource += ` con el validador de stories descontado (${conValidador.validador_reloop.motivo})`;
    }
  }

  let ran;
  let source;
  if (!state.sawStart) {
    // Sin marca step5-start: `pipeline.js advisors` no corrió en esta corrida (o el registro no se puede leer). No
    // hay nada contra qué contar: un OK acá es un verde sobre nada, y la lista que pasa el agente (--ran) no es
    // evidencia. Falla cerrado; el único camino es el override consciente, que queda a la vista en la salida.
    if (args.trustRan && args.ran.length) {
      ran = args.ran;
      source = '⚠️⚠️ --trust-ran EXPLÍCITO sin step5-start: el caller pidió confiar en --ran (sin verificación real)';
    } else {
      process.stderr.write(
        '🛑 check-count FALLÓ CERRADO — no hay step5-start en el registro: `pipeline.js advisors` no corrió en esta corrida.\n' +
        'Sin ese registro no hay set esperado ni spawns contra qué contar, y un OK sería un verde sobre nada.\n' +
        'Corré `pipeline.js advisors --repo <r> --story <s> --files <…>`, lanzá los revisores y volvé a contar.\n' +
        'Confiar en una lista de revisores dada por vos lo decide la persona, no el agente: si quiere, lo firma en la ventana de permiso o en su terminal.\n',
      );
      process.exit(2);
    }
  } else if (state.ran.length === 0 && expected.length === 0) {
    ran = [];
    source = 'set esperado vacío — nada que correr';
  } else if (state.ran.length === 0) {
    // FAIL-CLOSED: pipeline.js corrió (hay step5-start) pero
    // el hook on-advisor-run.js no registró NINGÚN spawn. El fallback silencioso al
    // --ran dejaría pasar un set sin spawns (ej.: 6 step5-start, 0 spawns, todo
    // "pasó"). --trust-ran lo decide la persona: ESC-C3 lo frena sin su frase (queda en el output, auditable).
    if (args.trustRan && args.ran.length) {
      ran = args.ran;
      source = '⚠️⚠️ --trust-ran EXPLÍCITO: el log no registró spawns pero el caller pidió confiar en --ran (sin verificación real)';
    } else {
      process.stderr.write(
        '🛑 check-count FALLÓ CERRADO — hay step5-start en el log pero CERO spawns registrados.\n' +
        (Object.keys(state.fallidos || {}).length
          ? 'Lanzados por el pipeline que no cuentan:\n' + Object.entries(state.fallidos).map(([a, m]) => `  - ${a}: ${m}`).join('\n') + '\n'
          : '') +
        (esCodex()
          ? 'Bajo Codex los revisores los lanza el pipeline, no el modelo: corré\n' +
            `  ${lanzadorCodex(args)}\n` +
            'Si ya lo corriste y salió 2 porque la caja de arena no tiene red (sin red no llega al modelo), seguí la salida\n' +
            'que dio ese mensaje: volver a correr check-count no cambia nada.\n'
          : 'O los advisors NO se corrieron, o el hook on-advisor-run.js está roto/no instalado.\n' +
            'Verificá:\n' +
            '  1. ¿Invocaste los Agent(...) después de correr pipeline.js advisors?\n' +
            '  2. ¿on-advisor-run.js está en settings.json (PreToolUse Task|Agent)? → install-tycon-hooks.sh --check\n') +
        'Confiar en una lista de revisores dada por vos lo decide la persona, no el agente: si quiere, lo firma en la ventana de permiso o en su terminal.\n',
      );
      process.exit(2);
    }
  } else {
    ran = state.ran;
    source = 'invocaciones REALES (log on-advisor-run.js)';
  }

  const ranSet = new Set(ran);
  const missing = expected.filter((a) => !ranSet.has(a));
  const extra = ran.filter((a) => !expected.includes(a));

  // Si hay log Y el LLM pasó --ran y difieren → self-report inflado.
  let discrepancy = '';
  if (state.ran.length > 0 && args.ran.length) {
    const claimedNotRun = args.ran.filter((a) => !ranSet.has(a));
    if (claimedNotRun.length) {
      discrepancy = `\n⚠️ --ran declara advisors que el log NO registra como corridos: ${claimedNotRun.join(', ')} (self-report ≠ realidad).\n`;
    }
  }

  if (missing.length > 0) {
    process.stderr.write(
      `🛑 check-count FALLÓ — faltan ${missing.length} advisor(s) del set esperado:\n` +
      missing.map((m) => `  - ${m}${state.fallidos && state.fallidos[m] ? ` (lanzado por el pipeline: ${state.fallidos[m]})` : ''}`).join('\n') + '\n\n' +
      `Fuente del "corridos": ${source}\n` +
      `Esperado [${expectedSource}] (${expected.length}): ${expected.join(', ')}\n` +
      `Corridos (${ran.length}): ${ran.join(', ') || '(ninguno)'}\n` +
      (extra.length ? `Corridos de más (OK pero raro): ${extra.join(', ')}\n` : '') +
      discrepancy +
      `\nNO avanzar al paso de hallazgos hasta correr los faltantes.\n`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `✅ check-count OK — corrieron los ${expected.length} advisors esperados ` +
    `[corridos: ${source} | esperado: ${expectedSource}]` +
    (extra.length ? ` (+${extra.length} extra: ${extra.join(', ')})` : '') +
    discrepancy + '\n',
  );
  process.exit(0);
}


// ── lint-config — la superficie de config, revisada sin modelo ────────
// Cambiar `.tycon/advisors.yaml` cambia qué frenos corren y sobre qué, y nada la
// mira más que este lint. Determinístico, ~50ms, cero tokens, y AVISA: un lint de config que frena commits se
// apaga en una semana y se lleva puestos los casos donde sí importaba.
// Uso: pipeline.js lint-config [--repo <path>] [--json] [--strict]
function cmdLintConfig(cmd, args) {
  const cl = require('./config-lint.js');
  const cfgsrc = require('./config-source.js');
  const raiz = (() => {
    try { return require('./evidence-config.js').discoverRepoRoot(args.repo) || args.repo; }
    catch (_e) { return args.repo; }
  })();
  const ambas = cfgsrc.leerAmbas(raiz);
  const r = cl.lintConfig({
    repoRoot: raiz,
    txtCarpeta: ambas.carpeta,
    txtCommiteado: ambas.hayHistoria ? (ambas.commiteado || '') : null,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify({ repo: raiz, ...r }, null, 2) + '\n');
    process.exit(args.strict && !r.ok ? 1 : 0);
  }
  if (r.sinConfig) {
    process.stdout.write(`lint-config: ${raiz} no tiene .tycon/advisors.yaml — nada que revisar.\n`);
    process.exit(0);
  }
  if (r.ok) {
    process.stdout.write('✅ lint-config: la config del repo está limpia.\n');
    process.exit(0);
  }
  const ROTULO = {
    'llave-desconocida': 'LLAVE QUE NADIE LEE',
    'llave-anidada': 'LLAVE EN EL LUGAR EQUIVOCADO',
    'regla-muerta': 'REGLA DECLARADA Y MUERTA',
    'seam-invalida': 'PATRÓN INVÁLIDO',
    'cobertura-que-baja': 'BAJA DE COBERTURA',
  };
  process.stdout.write(
    `⚠ lint-config — ${r.hallazgos.length} cosa(s) para mirar en ${path.join(raiz, '.tycon/advisors.yaml')}:\n\n` +
    r.hallazgos.map((h) => `  · [${ROTULO[h.tipo] || h.tipo}] ${h.mensaje}`).join('\n') +
    '\n\nNinguna de estas rompe el commit. Todas se leen como "está configurado" cuando no lo está.\n',
  );
  process.exit(args.strict ? 1 : 0);
}


// ── ¿Corrieron los revisores de la story X? ─────────────
// El registro voluntario (gates.log check=advisors) sólo existe si alguien tipeó el comando,
// y muchas de sus entradas no tienen repo. Éste lee el registro AUTOMÁTICO —
// los spawns REALES que anota on-advisor-run.js, imposibles de falsificar sin desinstalar el
// hook— en sus dos capas: el detalle vivo (7 días) y el resumen durable (para siempre).
// Uso: pipeline.js advisor-runs [--story X] [--repo /ruta] [--days N] [--json]
function cmdAdvisorRuns(cmd, args) {
  const ledger = require('./advisor-ledger.js');
  // `args.repo` viene con default `process.cwd()` para todo el resto del CLI. Acá un default
  // silencioso FILTRA — y filtrar sin que nadie lo pidió es exactamente el modo de falla que
  // este comando existe para desmentir ("no aparece" leído como "no corrió"). Sólo filtra por
  // repo si el flag está escrito.
  const repoFiltro = process.argv.includes('--repo') ? args.repo : null;
  const r = ledger.query({ story: args.story, repo: repoFiltro, days: args.days });
  if (args.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(0);
  }
  const filtro = [
    args.story ? `story ${args.story}` : null,
    repoFiltro ? `repo ${repoFiltro}` : null,
    args.days ? `últimos ${args.days} días` : null,
  ].filter(Boolean).join(' · ') || 'todo el registro';

  if (r.spawns === 0) {
    process.stdout.write(
      `❓ Sin corridas de revisores registradas para: ${filtro}\n\n` +
      '   🔴 "Sin registro" NO prueba que no corrieron: prueba que no quedó constancia.\n' +
      '   El detalle por spawn se guarda 7 días; después queda sólo el resumen durable\n' +
      `   (${ledger.summaryPath()}), que agrupa por sesión y no baja al spawn individual.\n` +
      '   Una corrida anterior a que esto existiera (2026-08-25) tampoco tiene repo ni story.\n',
    );
    process.exit(0);
  }

  const top = Object.entries(r.advisores).sort((a, b) => b[1] - a[1]);
  const ultimo = r.vivos.filter((v) => v.ts).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  process.stdout.write(
    `📋 Corridas de revisores automáticos — ${filtro}\n\n` +
    `   ${r.spawns} spawn(s) · ${r.sesiones.length} sesión(es) · ` +
    `${r.vivos.length} con detalle vivo, ${r.spawns - r.vivos.length} sólo en resumen durable\n` +
    (r.repos.length ? `   Repos: ${r.repos.join(', ')}\n` : '') +
    (r.stories.length ? `   Stories: ${r.stories.join(', ')}\n` : '') +
    (r.sinAtribuir ? `   ⚠ ${r.sinAtribuir} spawn(s) vivos sin repo atribuido (anteriores al 2026-08-25)\n` : '') +
    '\n   Revisores:\n' +
    top.map(([a, n]) => `     ${String(n).padStart(3)} × ${a}`).join('\n') + '\n' +
    (ultimo ? `\n   Último spawn con detalle: ${ultimo.ts} (${ultimo.advisor}, sesión ${ultimo.sessionId})\n` : ''),
  );
  process.exit(0);
}

function cmdStoryReviewGate(cmd, args) {
  // ¿Corre el revisor de historias? {run, record, riesgo, model, model_reason | motivo, criterios | linea}. exit 0
  // siempre (informativo); sin story legible, exit 2.
  if (!args.story || !fs.existsSync(args.story)) { process.stderr.write(`story-review-gate: --story inválido: ${args.story}\n`); process.exit(2); }
  process.stdout.write(JSON.stringify(computeStoryReviewGate({ story: args.story }), null, 2) + '\n');
  process.exit(0);
}

function cmdStoryReviewRecord(cmd, args) {
  // La constancia de la revisión previa: el único que la escribe. Vocabulario cerrado; exit 2 sin escribir si no vale.
  if (!args.story || !fs.existsSync(args.story)) { process.stderr.write(`story-review-record: --story inválido: ${args.story}\n`); process.exit(2); }
  let hallazgos = [];
  if (args.findings != null) {
    try { hallazgos = JSON.parse(args.findings); } catch (e) { process.stderr.write(`story-review-record: --findings no es JSON (${e.message})\n`); process.exit(2); }
  }
  // vacío es «no medido» (null), nunca 0; un texto que no es número lo rechaza la validación de la constancia
  const entero = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
  try {
    const f = storyReviewRecord.writeRecord(os.homedir(), args.story, {
      resultado: args.resultado, motivo: args.motivo, hallazgos, modelo: args.modelo, model_reason: args.modelReason,
      tokens: entero(args.tokens), duracion_ms: entero(args.duracionMs), riesgo: args.riesgo,
    });
    process.stdout.write(JSON.stringify({ escrita: f, ...storyReviewRecord.readRecord(os.homedir(), args.story).record }, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`story-review-record: no escribí la constancia:\n${e.message}\n`);
    process.exit(2);
  }
}

function cmdValidationRecord(cmd, args) {
  // La constancia de la validación de la historia: el único que la escribe. Vocabulario cerrado; exit 2 sin escribir.
  if (!args.story || !fs.existsSync(args.story)) { process.stderr.write(`validation-record: --story inválido: ${args.story}\n`); process.exit(2); }
  const validadores = String(args.validadores || '').split(',').map((v) => v.trim()).filter(Boolean);
  try {
    const f = validationRecord.writeRecord(os.homedir(), args.story, { resultado: args.resultado, validadores });
    process.stdout.write(JSON.stringify({ escrita: f, ...validationRecord.readRecord(os.homedir(), args.story).record }, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`validation-record: no escribí la constancia:\n${e.message}\n`);
    process.exit(2);
  }
}

// ── move-story: mover una historia de carpeta con su validación ─────────────────────────────────────────────────────
// Las constancias de la validación y de la revisión previa se guardan con la clave de la ruta de la historia y valen
// mientras su huella coincida con el contenido; la de primera vez, con su ruta real. Un `mv` a mano las deja en la ruta
// vieja, y reescribir la historia en la ruta nueva no la deja igual byte a byte. `move-story` mueve el archivo tal cual
// (con `git mv` si git lo sigue) y pasa a la clave nueva cada constancia vigente. La que ya no coincide con el contenido
// queda donde estaba, y se dice: la historia se mueve sin ella.

const realDe = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const gitEn = (cwd, argv) => require('child_process').spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', timeout: 15000, windowsHide: true });

/** La raíz real del repo de una carpeta; null fuera de git. */
function raizDelRepo(dir) {
  const r = gitEn(dir, ['rev-parse', '--show-toplevel']);
  return r.status === 0 && r.stdout.trim() ? (realDe(r.stdout.trim()) || r.stdout.trim()) : null;
}

/** El número de la historia, del `story:` de su encabezado; null si el archivo no es una historia. */
function numeroDeHistoria(texto) {
  const fm = String(texto).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm && fm[1].match(/^story\s*:\s*["']?([^"'\s#]+)/m);
  return m ? m[1] : null;
}

/** Los marcadores de corrida de la máquina que nombran esta historia (la guardan relativa al repo de la corrida). */
function corridasDeLaHistoria(home, real) {
  const dir = path.join(stateDirOf(home), 'active');
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of nombres) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!m || !m.storyPath) continue;
    const p = path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || '', m.storyPath);
    if (realDe(p) === real) out.push(m.sessionId || f.replace(/\.json$/, ''));
  }
  return out;
}

/**
 * Mueve la historia `de` a `a`. Devuelve { codigo, lineas }: 0 movida, con su validación si tenía · 1 no se movió ·
 * 3 movida, y alguna constancia quedó en la ruta vieja porque el contenido cambió después de escribirla.
 */
function moverHistoria({ home, de, a }) {
  const FT = require('./first-time-record.js');
  const no = (motivo) => ({ codigo: 1, lineas: [`move-story: no se movió: ${motivo}`] });
  const deReal = realDe(de);
  if (!deReal || !fs.statSync(deReal).isFile()) return no(`no existe ${de}`);
  if (!/\.md$/i.test(a)) return no(`el destino tiene que ser un .md (${a})`);
  const aAbs = path.resolve(a);
  if (fs.existsSync(aAbs)) return no(`ya existe ${a}`);
  const aDir = realDe(path.dirname(aAbs));
  if (!aDir) return no(`no existe la carpeta de destino ${path.dirname(a)}`);
  const aReal = path.join(aDir, path.basename(aAbs));
  const numero = numeroDeHistoria(fs.readFileSync(deReal, 'utf8'));
  if (!numero) return no(`${de} no es una historia (no tiene \`story:\` en su encabezado)`);
  const raiz = raizDelRepo(path.dirname(deReal));
  if (raiz !== raizDelRepo(aDir)) return no('el destino está en otro repo: la validación es del repo y de la ruta de la historia');
  const abiertas = corridasDeLaHistoria(home, deReal);
  if (abiertas.length) return no(`la corrida abierta de la sesión ${abiertas.join(', ')} usa esta historia: terminala o sacala antes de moverla`);

  const rel = (p) => path.relative(raiz || process.cwd(), p).split(path.sep).join('/');
  // las constancias, leídas con la ruta de hoy. La clave es el repo más la ruta: la comparten las copias del mismo repo
  // (worktrees, ramas), así que la de la ruta vieja no se borra (otra copia puede tener la historia ahí) y la de la ruta
  // nueva no se pisa si es de otro contenido (otra copia puede tener otra historia ahí)
  const constancias = [['la validación', validationRecord], ['la revisión previa', storyReviewRecord]].map(([nombre, R]) => {
    const leida = R.readRecord(home, deReal);
    const nuevo = R.recordFile(home, aReal);
    let ya = null;
    try { ya = JSON.parse(fs.readFileSync(nuevo, 'utf8')); } catch { ya = null; }
    return { nombre, leida, nuevo, ya };
  });
  for (const c of constancias) {
    if (c.leida.estado === 'stale' || c.leida.estado === 'none' || !c.ya) continue;
    if (c.ya.huella !== c.leida.record.huella) return no(`${c.nombre} de ${rel(aReal)} ya existe para otro contenido (otra copia del repo tiene otra historia en esa ruta): elegí otra ruta`);
  }
  const primeraVez = FT.isRecorded(home, deReal, numero);

  // primero las constancias de la ruta nueva y después el archivo: si algo falla, se deshace lo escrito y no se movió nada
  const escritos = [];
  const deshacer = () => { for (const f of escritos) { try { fs.unlinkSync(f); } catch { /* ya no estaba */ } } };
  try {
    for (const c of constancias) {
      if (c.leida.estado === 'stale' || c.leida.estado === 'none' || c.ya) continue;
      fs.mkdirSync(path.dirname(c.nuevo), { recursive: true });
      fs.writeFileSync(c.nuevo, `${JSON.stringify({ ...c.leida.record, path: aReal }, null, 2)}\n`);
      escritos.push(c.nuevo);
    }
    if (primeraVez) {
      // se deshace sólo si la escribió este comando
      const existia = fs.existsSync(FT.recordFile(home, aReal));
      const f = FT.writeRecordAt(home, aReal, numero);
      if (!existia) escritos.push(f);
    }
  } catch (e) {
    deshacer();
    return no(`no pude escribir las constancias en la ruta nueva (${(e && (e.code || e.message)) || e}): no moví nada`);
  }
  const seguida = raiz && gitEn(raiz, ['ls-files', '--error-unmatch', '--', deReal]).status === 0;
  try {
    if (seguida) {
      const r = gitEn(raiz, ['mv', '--', deReal, aReal]);
      if (r.status !== 0) throw new Error(`git mv falló: ${(r.stderr || '').trim()}`);
    } else {
      fs.renameSync(deReal, aReal);
    }
  } catch (e) {
    deshacer();
    return no(`${(e && e.message) || e}: no moví nada`);
  }

  const lineas = [`move-story: ${rel(deReal)} → ${rel(aReal)}, el mismo contenido${seguida ? ' (git mv)' : ''}`];
  let codigo = 0;
  for (const c of constancias) {
    if (c.leida.estado === 'none') continue;
    if (c.leida.estado === 'stale') {
      codigo = 3;
      lineas.push(`⚠️  ${c.nombre}: la validación quedó en la ruta vieja: el contenido cambió después de escribirla. La historia se movió sin ella: hay que volver a validarla.`);
      continue;
    }
    lineas.push(`${c.nombre}: pasó a la ruta nueva${c.leida.estado === 'current' ? ', vigente' : ''}`);
  }
  if (constancias.every((c) => c.leida.estado === 'none')) lineas.push('no tenía validación: no había nada que pasar');
  if (primeraVez) lineas.push('la constancia de primera vez: pasó a la ruta nueva');

  // el estado del sprint que cuenta es el de la carpeta de la historia: un cambio de carpeta lo deja en la vieja
  const deDir = path.dirname(deReal);
  if (deDir !== aDir) {
    const sprint = path.join(deDir, 'sprint-status.yaml');
    const clave = `${numero.replace(/\./g, '-')}-`;
    let t = '';
    try { t = fs.readFileSync(sprint, 'utf8'); } catch { t = ''; }
    if (t.split(/\r?\n/).some((l) => l.trim().startsWith(clave))) {
      lineas.push(`ℹ️  el renglón de la historia en ${rel(sprint)} no se movió: el estado del sprint que cuenta es el de la carpeta de la historia (${rel(path.join(aDir, 'sprint-status.yaml'))})`);
    }
  }
  return { codigo, lineas };
}

function cmdMoveStory(cmd, args) {
  // Uso: pipeline.js move-story --story <ruta de hoy> --to <ruta nueva>. Sale con 0 movida, 1 no se movió y 3 movida con
  // alguna constancia que quedó en la ruta vieja.
  if (!args.story || !args.to) { process.stderr.write('move-story: --story <ruta de hoy> y --to <ruta nueva> requeridos\n'); process.exit(2); }
  const r = moverHistoria({ home: os.homedir(), de: args.story, a: args.to });
  for (const l of r.lineas) (r.codigo === 1 ? process.stderr : process.stdout).write(`${l}\n`);
  process.exit(r.codigo);
}

function cmdOrgRules(cmd, args) {
  // Las reglas de la organización (stack.rules): cada una con su valor y de dónde salió, y los problemas. Nunca tira:
  // sin configuración salen las de fábrica.
  const r = require('./stack-config.js').orgRules();
  // La guía de historias, con su ruta absoluta: el validador no corre comandos y con «~» adivinaba la carpeta personal.
  let tree = null;
  try {
    const h = require('./harness-path.js').rutaArnesHook({ env: process.env, home: os.homedir() });
    tree = h.dir;
    if (!tree && h.aviso) r.problems.push(h.aviso);
  } catch (e) {
    r.problems.push(`no pude ubicar el árbol del arnés para la guía de historias (${e && e.message ? e.message : e})`);
  }
  const guia = tree ? path.join(tree, 'story-format.md') : null;
  r.story_format = guia && fs.existsSync(guia) ? guia : null;
  // El veredicto de pantalla de la historia, con el mismo detector que los controles del cierre (Casos: tests/first-screen-story.test.js): el
  // revisor de la historia lo recibe en el pedido y no lo deduce por su cuenta.
  r.screen = null;
  if (args.story) {
    try {
      const sp = path.resolve(String(args.story));
      const content = fs.readFileSync(sp, 'utf8');
      const ui = require('./ui-signal.js');
      const repoRoot = require('./evidence-config.js').discoverRepoRoot(sp);
      const verdict = ui.applyScreenRule(content, repoRoot, r.rules.screen_test.value);
      const detail = ui.uiSignalDetail(content, repoRoot);
      const porSenal = {
        extension: 'nombra un archivo de pantalla (.tsx, .jsx, .vue o .svelte)',
        lista: 'sus archivos a tocar están en una carpeta de pantalla (frontend, src/app, src/components o las que declara el repo)',
        campo: 'un campo del frontmatter (repo, stack, área…) nombra el frente',
        tanda: 'una tanda del bloque pipelines nombra el frente',
        prosa: 'no declara archivos y su texto habla del frente',
        cuerpo: 'trae escenarios de prueba con navegador',
      };
      r.screen = {
        ui: verdict.ui === true,
        why: verdict.note || porSenal[detail.signal] || 'ninguna señal de pantalla: ni archivos de pantalla, ni carpetas del frente, ni escenarios con navegador',
      };
    } catch (e) {
      r.problems.push(`no pude calcular el veredicto de pantalla de ${args.story} (${e && e.message ? e.message : e})`);
    }
  }
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}


// ── mech-check — executor determinista de los advisors 'lean' ─
// Corre INLINE (~ms, 0 tokens) los checks mecánicos que de otro modo cuestan 3 subagentes
// Sonnet por iteración: ACCOV-C1/C5, DEFTR-C1/C2, WIRING-C1. El orquestador invoca
// el advisor LLM correspondiente SOLO si `ambiguous` no está vacío (escalation),
// y los `findings` confirmados son infakeables (script, no self-report).
function cmdMechCheck(cmd, args) {
  const { runStoryChecks } = require('./story-checks.js');
  const result = runStoryChecks({ repo: args.repo, storyPath: args.story, files: args.files });
  // DEPR-W1: lo vivo que nombra lo deprecado. Aviso: no frena ni escala a un revisor.
  try { result.findings.push(...require('./deprecated.js').vivoQueNombraDeprecado({ repo: args.repo, files: args.files || [] })); } catch (e) {
    // sin la lista no hay aviso, pero queda dicho: «no pude mirar» no es «no hay nada»
    result.ambiguous.push({ rule: 'DEPR-W1', detail: `no se pudo mirar lo deprecado: ${(e && e.message) || e}` });
  }
  const escalate = [...new Set(result.ambiguous.map((a) => a.rule.split('-')[0]))];
  const ESCALATION_ADVISOR = { ACCOV: 'tycon-ac-coverage-checker', DEFTR: 'tycon-deferral-tracker', MECH: 'tycon-ac-coverage-checker' };
  // una familia que no es del núcleo (WIRING: el revisor de cableado) la escala el revisor de un paquete ACTIVO que declara
  // ese prefijo; sin ese paquete, el hallazgo se reporta sin escalar y la salida lo dice
  const sinEscalar = [];
  const dePaquete = (familia) => {
    let activos;
    try { activos = paquetesActivos(args.repo); } catch (e) { sinEscalar.push(`${familia} (no pude leer los paquetes: ${e.message})`); return null; }
    const r = activos.flatMap((p) => p.revisores).find((x) => (x.prefijos || []).includes(familia) && x.grupo !== 'validacion');
    if (!r) sinEscalar.push(`${familia} (ningún paquete activo trae su revisor)`);
    return r ? r.agente : null;
  };
  result.llm_escalation = [...new Set(escalate.map((r) => ESCALATION_ADVISOR[r] || dePaquete(r)).filter(Boolean))];
  result.note = result.findings.length
    ? `${result.findings.length} finding(s) CONFIRMADOS mecánicamente — van directo al reporte (no necesitan advisor LLM).`
    : 'Sin findings mecánicos.';
  result.note += result.ambiguous.length
    ? ` ${result.ambiguous.length} ambiguo(s) → invocar SOLO: ${result.llm_escalation.join(', ') || 'ninguno'}.`
    : ` Sin ambiguos → en re-loops (iter≥2) ac-coverage y deferral-tracker quedan descontados del set (MECH-2); en iter 1 SÍ corren (juicio LLM completo). El revisor de cableado, si su paquete está activo, se invoca siempre (mech solo cubre WIRING-C1). ${MECH_NUNCA_SACA}`;
  if (sinEscalar.length) result.note += ` Sin escalar: ${sinEscalar.join('; ')} — el hallazgo queda en el reporte tal cual.`;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.findings.some((f) => f.severity === 'CRITICAL') ? 2 : 0);
}

module.exports = { cmdAdvisors, cmdSiblings, cmdValidators, cmdCheckCount, cmdLintConfig, cmdAdvisorRuns, cmdReviewersRun, cmdMechCheck, cmdOrgRules, cmdStoryReviewGate, cmdStoryReviewRecord, cmdValidationRecord, cmdMoveStory,advisorsRunSinceStart, CORE_REVIEWERS, coreReviewersDrift, coreReviewerNames, codeReviewerNames, computeValidadores, aplicarTamanoALosRevisores };
