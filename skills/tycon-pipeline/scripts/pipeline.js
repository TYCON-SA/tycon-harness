#!/usr/bin/env node
/**
 * pipeline.js — comandos mecánicos del pipeline.
 *
 * Saca del LLM la DECISIÓN de qué advisors correr en el paso de revisores. El LLM no infiere
 * ni cuenta a mano (reglas D.i/E.i/B/C); le pregunta a este script.
 *
 *   node pipeline.js advisors --repo <dir> --story <spec.md> --files a.cs b.tsx ...
 *     → JSON con { base, completitud, conditional, all, required_count, detection }.
 *       El LLM corre EXACTAMENTE `all` en paralelo (no elige).
 *
 *   node pipeline.js check-count --repo <dir> --story <spec.md> --files ... --ran x,y,z
 *     → exit 0 si `ran` ⊇ `all` esperado; exit 2 + lista de faltantes si no.
 *       Es el post-flight count-check, sin que el LLM lo haga a mano (Regla C).
 *
 * Fuente de verdad de la matriz: este archivo. La guía del paso de revisores la
 * describe en prosa pero la AUTORIDAD es computeAdvisorSet() acá (el step la referencia).
 *
 * Determinismo de SELECCIÓN (mismo diff → mismo set), NO de output (los advisors son LLMs).
 *
 * Los revisores de un producto o de un cliente (convenciones de
 * plugins Bizuit, plugins hermanos, el adaptador de un cliente) NO están en este archivo: viven en `packs/<nombre>/pack.json`
 * (lib/packs.js) y se suman al set por manifiesto. La salida de `advisors` lleva `packs`.
 */

// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }

// cada parte vive en lib/, con la ruta escrita entera (el freno de guiones y control-size.js siguen sólo una ruta
// literal). Se carga cuando hace falta: si falta o no carga, lo dice en una línea y sale 2, nunca sigue como si el
// subcomando no existiera
const CARGAS = {
  'pipeline-shared.js': () => require('./lib/pipeline-shared.js'),
  'pipeline-reviewers.js': () => require('./lib/pipeline-reviewers.js'),
  'pipeline-rounds.js': () => require('./lib/pipeline-rounds.js'),
  'pipeline-deep-review.js': () => require('./lib/pipeline-deep-review.js'),
  'pipeline-lane.js': () => require('./lib/pipeline-lane.js'),
  'pipeline-start.js': () => require('./lib/pipeline-start.js'),
  'pipeline-next.js': () => require('./lib/pipeline-next.js'),
  'pipeline-preflight.js': () => require('./lib/pipeline-preflight.js'),
  'pipeline-findings.js': () => require('./lib/pipeline-findings.js'),
  'pipeline-reports.js': () => require('./lib/pipeline-reports.js'),
  'pipeline-advisor-set.js': () => require('./lib/pipeline-advisor-set.js'),
  'pipeline-advisor-context.js': () => require('./lib/pipeline-advisor-context.js'),
  'pipeline-risk.js': () => require('./lib/pipeline-risk.js'),
  'pipeline-models.js': () => require('./lib/pipeline-models.js'),
};
function cargar(modulo) {
  try { return CARGAS[modulo](); } catch (e) {
    // importado por otro guion (un gancho, marker.js): el error sube y lo decide quien llama, que puede seguir sin él
    if (require.main !== module) throw e;
    console.error(`pipeline.js: falta el módulo lib/${modulo} o no carga (${String((e && e.message) || e).split('\n')[0]})`);
    process.exit(2);
  }
}

// lo que exporta pipeline.js: las mismas claves de siempre, cada una leída de la parte que la declara al pedirla
const EXPORTA = {
  'pipeline-shared.js': ['matchGlob', 'resolveRunDir', 'readSessionMarker', 'runDirKey', 'storyRequiresRuntimeEvidenceCheck', 'parseFrontmatterPipeline', 'deepReviewConfig', 'deriveStoryId'],
  'pipeline-advisor-set.js': ['revisoresPorConfirmar', 'readSessionMarkerStrict', 'advisorAffectedByDelta', 'computeAdvisorSet', 'detectStack', 'revisoresDelNucleo', 'BANDERAS_DETECCION', 'paquetesInstalados', 'paquetesActivos', 'superficieDe', 'computeMechDiscount', 'MECH_DISCOUNTABLE', 'decidirValidadorEnReloop'],
  'pipeline-models.js': ['orgModels', 'orgDeepReview', 'revisionDeLaOrganizacion', 'computeModelHint'],
  'pipeline-risk.js': ['frenosDelManifiesto', 'parseFrontmatterList', 'computeRiskClass', 'computeDelicate', 'tocaSuperficieCompartida', 'computeRunSize'],
  'pipeline-advisor-context.js': ['aplicarModelosDeRevisores', 'tierDe', 'buildStoryDigest', 'buildAdvisorContext', 'validateFilesExist', 'reloopHintsFor'],
  'pipeline-preflight.js': ['completedWorkHours', 'computeDepGate', 'findRepoRootsForStory', 'computePreflightFrontmatter'],
  'pipeline-next.js': ['harnessTimeTool', 'notaDelTamano', 'computeNextStory', 'cmpStoryId'],
  'pipeline-start.js': ['gitignoreAppendText', 'computeMissingBeforeStart', 'thirdPartyManifestPath', 'computeSpecStaleness', 'computeToolingExpected'],
  'pipeline-deep-review.js': ['deepReviewGateDeLaCorrida', 'densidadDelDiff', 'archivosFantasma', 'computeDeepReviewGate'],
  'pipeline-reports.js': ['computeGitignoreNeeds', 'gitIgnoraProbe', 'GITIGNORE_ADVISORS', 'e2eConfig', 'selectE2eApps'],
  'pipeline-findings.js': ['projectRunToStoryRepo', 'aprobacionesEnElRepoDeLaStory', 'writeFollowups', 'computeFollowupsStatus', 'parseFollowupsSection', 'followupKey', 'writeFindings', 'computeFindingsStatus', 'normalizeFindingRecord', 'computeDodCheckerNeeded', 'computeDeferralsOpen'],
  'pipeline-reviewers.js': ['advisorsRunSinceStart', 'CORE_REVIEWERS', 'coreReviewersDrift', 'coreReviewerNames', 'codeReviewerNames', 'computeValidadores', 'aplicarTamanoALosRevisores'],
  'pipeline-rounds.js': ['computeSmartReloop', 'gitArchivosDelWorkingTree'],
};
for (const [modulo, claves] of Object.entries(EXPORTA)) {
  for (const k of claves) Object.defineProperty(module.exports, k, { enumerable: true, configurable: true, get: () => cargar(modulo)[k] });
}

// lo que comparten las partes: el estado, las rutas de este despachador (las mismas de siempre, también por un
// enlace) y lo que usa el despacho
const shared = cargar('pipeline-shared.js');
shared.estadoPipeline.SCRIPTS_DIR = __dirname;
shared.estadoPipeline.PIPELINE_JS = __filename;
const { packsLib, paraOtraSesion, parseArgs } = shared;

function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const otra = paraOtraSesion(cmd, args, process.argv.slice(3));
  if (otra) { process.stderr.write(otra); process.exit(2); }
  if (cmd === 'review-rounds') return cargar('pipeline-rounds.js').cmdReviewRounds(cmd, args);

  // Los revisores y el pase sobre el camino rápido de la sesión, sin corrida (lib/adhoc-base.js arma sus archivos).
  if (args.adhoc && ['advisors', 'check-count', 'deep-review-gate'].includes(cmd)) {
    cargar('pipeline-lane.js').cmdRevisoresDelCarril(cmd, args);
    return;
  }
  if (cmd === 'advisors') return cargar('pipeline-reviewers.js').cmdAdvisors(cmd, args);
  if (cmd === 'siblings') return cargar('pipeline-reviewers.js').cmdSiblings(cmd, args);
  if (cmd === 'validators') return cargar('pipeline-reviewers.js').cmdValidators(cmd, args);
  if (cmd === 'smart-reloop') return cargar('pipeline-rounds.js').cmdSmartReloop(cmd, args);
  if (cmd === 'reviewer-agents') return cargar('pipeline-rounds.js').cmdReviewerAgents(cmd, args);
  if (cmd === 'preflight-frontmatter') return cargar('pipeline-preflight.js').cmdPreflightFrontmatter(cmd, args);
  if (cmd === 'reviewers-run') return cargar('pipeline-reviewers.js').cmdReviewersRun(cmd, args);
  if (cmd === 'check-count') return cargar('pipeline-reviewers.js').cmdCheckCount(cmd, args);
  if (cmd === 'lint-config') return cargar('pipeline-reviewers.js').cmdLintConfig(cmd, args);
  if (cmd === 'advisor-runs') return cargar('pipeline-reviewers.js').cmdAdvisorRuns(cmd, args);
  if (cmd === 'next') return cargar('pipeline-next.js').cmdNext(cmd, args);
  if (cmd === 'work-signal') return cargar('pipeline-preflight.js').cmdWorkSignal(cmd, args);
  if (cmd === 'ado-mark-active') return cargar('pipeline-preflight.js').cmdAdoMarkActive(cmd, args);
  if (cmd === 'estimate-real') return cargar('pipeline-next.js').cmdEstimateReal(cmd, args);
  if (cmd === 'start') return cargar('pipeline-start.js').cmdStart(cmd, args);
  if (cmd === 'risk-class') return cargar('pipeline-next.js').cmdRiskClass(cmd, args);
  if (cmd === 'story-review-gate') return cargar('pipeline-reviewers.js').cmdStoryReviewGate(cmd, args);
  if (cmd === 'story-review-record') return cargar('pipeline-reviewers.js').cmdStoryReviewRecord(cmd, args);
  if (cmd === 'validation-record') return cargar('pipeline-reviewers.js').cmdValidationRecord(cmd, args);
  if (cmd === 'move-story') return cargar('pipeline-reviewers.js').cmdMoveStory(cmd, args);
  if (cmd === 'tooling-expected') return cargar('pipeline-start.js').cmdToolingExpected(cmd, args);
  if (cmd === 'model-hint') return cargar('pipeline-next.js').cmdModelHint(cmd, args);
  if (cmd === 'deep-review-gate') return cargar('pipeline-deep-review.js').cmdDeepReviewGate(cmd, args);
  if (cmd === 'timing-report') return cargar('pipeline-reports.js').cmdTimingReport(cmd, args);
  if (cmd === 'cost-report') return cargar('pipeline-reports.js').cmdCostReport(cmd, args);
  if (cmd === 'org-rules') return cargar('pipeline-reviewers.js').cmdOrgRules(cmd, args);
  if (cmd === 'readability-brief') return cargar('pipeline-findings.js').cmdReadabilityBrief(cmd, args);
  if (cmd === 'evidence-key') return cargar('pipeline-reports.js').cmdEvidenceKey(cmd, args);
  if (cmd === 'compare-candidates') return cargar('pipeline-reports.js').cmdCompareCandidates(cmd, args);
  if (cmd === 'run-dir') return cargar('pipeline-reports.js').cmdRunDir(cmd, args);
  if (cmd === 'evidence-dir') return cargar('pipeline-reports.js').cmdEvidenceDir(cmd, args);
  if (cmd === 'e2e-config') return cargar('pipeline-reports.js').cmdE2eConfig(cmd, args);
  if (cmd === 'dep-gate') return cargar('pipeline-preflight.js').cmdDepGate(cmd, args);
  if (cmd === 'next-story') return cargar('pipeline-next.js').cmdNextStory(cmd, args);
  if (cmd === 'write-followups') return cargar('pipeline-findings.js').cmdWriteFollowups(cmd, args);
  if (cmd === 'write-findings') return cargar('pipeline-findings.js').cmdWriteFindings(cmd, args);
  if (cmd === 'verify-finding') return cargar('pipeline-findings.js').cmdVerifyFinding(cmd, args);
  if (cmd === 'record-refutation') return cargar('pipeline-findings.js').cmdRecordRefutation(cmd, args);
  if (cmd === 'findings-status') return cargar('pipeline-findings.js').cmdFindingsStatus(cmd, args);
  if (cmd === 'dod-checker-needed') return cargar('pipeline-findings.js').cmdDodCheckerNeeded(cmd, args);
  if (cmd === 'deferrals-open') return cargar('pipeline-findings.js').cmdDeferralsOpen(cmd, args);
  if (cmd === 'qa-readability') return cargar('pipeline-findings.js').cmdQaReadability(cmd, args);
  if (cmd === 'followups-status') return cargar('pipeline-findings.js').cmdFollowupsStatus(cmd, args);
  if (cmd === 'mech-check') return cargar('pipeline-reviewers.js').cmdMechCheck(cmd, args);

  process.stderr.write(
    'pipeline.js (H17 §4 + §5 incremental) — uso:\n' +
    '  node pipeline.js start          --story <spec.md> --repo <dir> [--autonomous] [--brief]\n' +
    '       (preflight mecánico en 1 comando: cross-session + branch guard + gitignore +\n' +
    '       marker + status in-progress. Pausa sin mutar ante conflicto/rama protegida.\n' +
    '       --brief: devuelve sólo lo que el orquestador consume y la RUTA del JSON entero\n' +
    `       (~4 KB → ~600 B; el detalle queda en ${(() => { const sd = require('./lib/state-dir.js'); return sd.paraMostrar(sd.stateDir()); })()}/salidas/). Sin el\n` +
    '       flag, salida idéntica a siempre. Story 7.10.)\n' +
    '  node pipeline.js next\n' +
    '       (próximo step + step_file + skips MECÁNICOS evaluados + checks del marker.\n' +
    '       El LLM sigue siendo el loop (H17): lee SOLO el step file que esto indica.)\n' +
    '  node pipeline.js risk-class     --story <spec.md> [--files ...] [--repo <dir>]\n' +
    '       (LOW o NORMAL, y `delicate`: el plan de una story delicada lo aprueba siempre el dev.\n' +
    '       Uno de rutina lo aprueba el «aprobado» de su revisión. Push/scope firmado SIEMPRE human-gate.)\n' +
    '  node pipeline.js tooling-expected --repo <dir>\n' +
    '       (PIPE-C9: qué tooling ESPERA el pipeline acá — codegraph si hay .codegraph/, engram,\n' +
    '       tool Workflow p/ el pase adversarial. El orquestador cruza contra su harness y AVISA al user si algo\n' +
    '       esperado no está disponible ANTES de degradar al fallback. `start` ya lo incluye.)\n' +
    '  node pipeline.js model-hint     --story <spec.md> [--files ...]\n' +
    '       (sugerencia de modelo de SESIÓN por complejidad: LOW→sonnet · NORMAL→opus ·\n' +
    '       NORMAL+≥2 señales pesadas→opus. Advisory: el orquestador compara con su modelo\n' +
    '       real y sugiere /model al user en el Arranque. NUNCA bloquea. `start` ya lo incluye.)\n' +
    '  node pipeline.js deep-review-gate --repo <dir> --story <spec.md> [--files ...]\n' +
    '                                  [--deep-review|--no-deep-review|--ultracode|--deep-review-opus|--deep-review-fable]\n' +
    '       (Pase adversarial: ¿corre el pase adversarial reproduce-or-refute? Gate = risk-class NORMAL.\n' +
    '       {run, model, model_reason, reason}. Modelo: sonnet default; story pesada → opus\n' +
    '       automático. Fable no se ofrece nunca: sólo corre con --deep-review-fable.\n' +
    '       Kill-switch: TYCON_NO_DEEP_REVIEW=1. Repo: .tycon/advisors.yaml deep_review:)\n' +
    '  node pipeline.js advisors       --repo <dir> --story <spec.md> --files a.cs b.tsx ...\n' +
    '                                  [--iter N] [--cost-tier lean|standard|deep] [--allow-missing-files]\n' +
    '       (valida que los --files existan — abort exit 2 ante paths fantasma/vacíos; corre\n' +
    '       mech-check inline y DESCUENTA advisors cubiertos (MECH-2) del set/expected;\n' +
    '       el descuento nunca saca a un revisor con críticos abiertos por confirmar;\n' +
    '       --iter N>1 emite reloop_model_hints (deep→sonnet). Genera context_file compartido\n' +
    '       + persiste expected[] en el log para check-count. Triggers sobre líneas AGREGADAS.)\n' +
    '  node pipeline.js reviewer-agents [--json]   (por revisor de la corrida: vuelta, agente y si su reporte se leyó)\n' +
    '  node pipeline.js check-count    [--ran a,b,c]\n' +
    '       (valida contra el expected persistido del último step5-start; FALLA CERRADO\n' +
    '       si hay step5-start sin spawns registrados — confiar en la lista lo decide la persona, en la ventana de permiso o en su terminal)\n' +
    '  node pipeline.js smart-reloop   --iter N --repo <r> --story <s> --files ... [--force-full-reloop]\n' +
    '                                  [--allow-missing-files]\n' +
    '       (SPEED-1 — delta = unión(nombres nuevos ∪ fileEvents ∪ mtime post-snapshot);\n' +
    '       requiere marker.js snapshot-iter (N-1) previo. Valida --files. Emite\n' +
    '       reloop_model_hints en TODOS los modos iter>1 y aplica descuento MECH-2.)\n' +
    '  node pipeline.js mech-check     --repo <dir> --story <spec.md> [--files ...]\n' +
    '       (checks deterministas ACCOV-C1/C5, DEFTR-C1/C2, WIRING-C1 — 0 tokens; findings\n' +
    '       confirmados van directo al reporte; ambiguos escalan al advisor LLM.)\n' +
    '  node pipeline.js preflight-frontmatter --story-path <spec.md> --target-status review|done\n' +
    '                                          --target-pipeline-done <pipeline-name>\n' +
    '       (SPEED-2 — pre-condiciones de los hooks ANTES del Edit del frontmatter.)\n' +
    '  node pipeline.js timing-report\n' +
    '       (Fase 0 — desglose de wall-clock por step/iter/gate de la corrida en curso.)\n' +
    '  node pipeline.js dep-gate       --repo <dir> --story <spec.md>\n' +
    '       (adopción BMAD — «Correr las pruebas»: dependencias NUEVAS (package.json/*.csproj) no declaradas\n' +
    '       en la story → exit 2 PAUSA HITL. Match conservador por nombre en el texto de la story.)\n' +
    '  node pipeline.js next-story     [--specs-dir <dir>] [--repo <dir>]\n' +
    '       (adopción BMAD — próxima story ready-for-dev en specs/stories/ (orden numérico) +\n' +
    '       menú de recuperación si no hay. NO arranca el pipeline: devuelve el path para `start`.)\n' +
    '  node pipeline.js write-findings    --story <spec.md> --repo <dir> --findings <array.json|->\n' +
    '       (paso de hallazgos — escribe el findings.json machine-parseable en el run dir (auto-resuelto):\n' +
    '       array de {rule_id,severity,advisor,file,disposition,reason}. Valida schema. Es el\n' +
    '       insumo del retrospective-capturer — reemplaza el WRITE MANUAL olvidable (BUG-PIPELINE-006).)\n' +
    '  node pipeline.js verify-finding    --finding <hallazgo.json> [--repo <dir>] [--model sonnet]\n' +
    '       (un hallazgo que el autor propone descartar como falso: imprime el lanzamiento — prompt y modelo — de UN\n' +
    '       verificador independiente que corre el código. {reviewer, rule, file, line, summary, author_reason}.)\n' +
    '  node pipeline.js record-refutation --finding <hallazgo.json> --result <resultado.json> --verifier <agente@ts>\n' +
    '                                     --verifier-model <modelo> --run-dir <corrida>\n' +
    '       (valida lo que devolvió el verificador {refuted, command, output} y guarda <corrida>/refutations/<id>.json:\n' +
    '       sin esa constancia write-findings no deja un hallazgo como refuted.)\n' +
    '  node pipeline.js findings-status   --story <spec.md> --repo <dir>\n' +
    '       (pre-condición de «Preparar el pull request» — exit 3 si falta el findings.json del run. El orquestador lo\n' +
    '       corre antes del commit-prep y, si falta, lo escribe con write-findings.)\n' +
    '  node pipeline.js write-followups   --story <spec.md> --findings <findings.json>\n' +
    '       (adopción BMAD — persiste findings advisor no resueltos como sección checkbox EN la\n' +
    '       story (idempotente por fkey ruleId|file, preserva [x] previos). Solo toca el body.)\n' +
    '  node pipeline.js followups-status  --story <spec.md>\n' +
    '       (adopción BMAD — Arranque y «Validar la historia»: cuenta review follow-ups abiertos/resueltos. exit 3 si\n' +
    '       hay abiertos (priorizarlos sobre tasks nuevas), 0 si limpio.)\n' +
    '  node pipeline.js validators        --story <spec.md> --repo <dir>\n' +
    '       (story 8.2 — «Validar la historia»: el validador de stories + los revisores del grupo `validacion`\n' +
    '       de los paquetes activos (packs/), con su prompt rendido y su modelo. Un paquete roto\n' +
    '       o uno que el repo nombra y no está instalado → exit 2 con archivo, revisor y motivo.)\n',
  );
  process.exit(cmd ? 1 : 0);
}


if (require.main === module) {
  // Las opciones y subcomandos viejos siguen andando hasta el retiro con sus nombres nuevos: --brief, --marks,
  // qa-readability y validators. Los nombres nuevos se escriben acá aunque los lean las
  // partes de lib/: el instalador busca el nombre nuevo de cada entrada del mapa de renombres en el texto de este
  // archivo, y sin él no instala la capa del equipo.
  require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/pipeline.js');
  try {
    main();
  } catch (e) {
    // un paquete de revisores roto o faltante frena CUALQUIER comando que lo cargue
    // (advisors, smart-reloop, check-count, validators): exit 2 con archivo · revisor · motivo, y
    // nada en stdout — el orquestador no recibe un set a medias.
    if (e instanceof packsLib.PackError) {
      process.stderr.write(e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
}
