#!/usr/bin/env node
'use strict';
// team-repos.js — dónde vive cada repo del arnés de una organización.
//
// POR QUÉ EXISTE: el nombre de cada repo del arnés no se escribe a mano en lugares distintos —ni en una lista
// del repo de mantenimiento, ni en variables de las definiciones de Azure—: una organización necesita un solo lugar
// donde decir los suyos. `team-repos.json`, en la raíz del perfil del equipo, los declara a todos. Lo leen el
// instalador, los avisos de arranque y los pipelines de operaciones; nadie más escribe un nombre de repo.
//
// LA FORMA (versión 1):
//   { "version": 1,
//     "public":      <repo>,            obligatorio — el repo público del arnés
//     "profile":     <repo>,            obligatorio — el perfil del equipo (este mismo repo)
//     "operations":  <repo>,            obligatorio — el repo de operaciones de la organización (no se instala)
//     "maintainers": <repo>,            opcional — el de mantenimiento, sólo para quien mantiene el arnés
//     "harness_copies": [<repo>, …] }   opcional — los repos de la organización que son copias del arnés: las métricas
//                                       de la noche no los miden, salvo el de `maintainers` si está en la lista
//     "merge_suites": {                 opcional — dónde corren las suites completas al mergear cada repo
//       "default"?: <regla>,            la de la organización; sin ella, «automatico»
//       "repos"?: [ { "repo": <repo>, "rule"?: <regla>, "full_tests_pipeline"?: <texto> | <entero ≥ 1, sólo Azure> } ] }
//                                       cada entrada trae al menos `rule` o `full_tests_pipeline`; un repo, una vez
//   <regla> = «automatico» | «siempre-en-la-maquina» | «confiar-en-el-servidor» (MERGE_RULES; las decidió el dueño así).
//   `full_tests_pipeline` es «el pipeline de pruebas completas» del repo: en Azure, por nombre o por id; en GitHub, el
//   nombre del control obligatorio. Lo usa el skill de merge (scripts/tools/merge-pr.js); sin la clave, el skill lee
//   `merge.mode` del repo. La clave es opcional: no sube la versión del archivo.
//     "models": {                       opcional — el modelo de cada trabajo del pipeline
//       "mandatory_ceiling"?: <bool>, "ceiling"?: <modelo>,   techo obligatorio (paga la organización): van juntos
//       "reviewers"?: <modelo>, "reviewer"?: { "<revisor>": <modelo> }, "reviewers_reloop"?: <modelo>,
//       "adversarial"?: { "model"?, "heavy"?: <modelo>, "fable_question"?: «ask» | «never» }, "helpers"?: <modelo>,
//       "session"?: { "low"?, "normal"?, "heavy"?: <modelo> } }
//   <modelo> = un nivel, «economy» | «balanced» | «strong» | «max» (MODEL_LEVELS), o el nombre del
//   modelo, «haiku» | «sonnet» | «opus» | «fable» (MODEL_NAMES), en el mismo orden; copias de models.js del skill. Quien la resuelve
//   es skills/tycon-pipeline/scripts/lib/models.js (`readOrgModels`, el único que la lee).
//     "weekly_review": {                opcional — la revisión de la semana (scripts/nightly/weekly-review/)
//       "enabled"?: <bool>, "budget_usd"?: <número, más de 0 y hasta 100>, "max_chars"?: <entero, 10.000 a 2.000.000> }
//                                       por defecto prendida, US$5 y 600.000; uno mal escrito cae al de por defecto
//   <repo> = { "platform": "azure", "org", "project", "repo" } o { "platform": "github", "org", "repo" }.
//   Las claves que empiezan con `__` son comentarios. Cualquier otra clave es un problema, en su propia ruta: así un
//   nombre mal escrito no queda ignorado en silencio.
//   La lista de responsables NO va acá (este archivo llega a todas las máquinas): va en `operations.json`, en el repo
//   de operaciones (scripts/lib/operations-config.js).
//
// EL CONTRATO: `parse(text)` → `{ ok, data, problems }`. Cada problema es `{ path, message }`, con la ruta de la clave
// en puntos e índices (`operations.project`, `harness_copies.1.repo`; `''` para el archivo entero). Con un problema,
// `data` es `null`: nunca hay datos a medias. Excepción: un problema DENTRO de `models` no
// anula el archivo —un modelo mal escrito dejaría a todas las máquinas sin la capa—; sale aparte, en
// `sectionProblems.models`, `ok` no cambia por eso y `data` viene sin `models` (se usan los valores por defecto). `load(file)` suma `couldNotRead: true` cuando el archivo no se pudo leer:
// «no pude leer» nunca es «no hay repo».
//
// LAS COPIAS DEL ARNÉS, PARA LAS MÉTRICAS: las declara este archivo, como el resto de los repos, y no una variable de
// cada definición: un lugar menos que configurar. `harnessCopies(data, platform)`
// las da con la que se mide marcada: la de mantenimiento, si está en la lista —es donde se escriben las stories del
// arnés—; las demás se saltean, así sus stories no cuentan dos veces. Sin clave nueva: la que cuenta ya está declarada.
//
// A mano: node scripts/lib/team-repos.js <archivo> [--json]   → exit 0 válido · 1 con problemas · 2 no pude leer
//         node scripts/lib/team-repos.js <archivo> --harness-copies <azure|github>
//             → una línea por copia de esa plataforma, `measure<TAB><id>` o `skip<TAB><id>` (`<proyecto>/<repo>` en Azure,
//               `<org>/<repo>` en GitHub); los problemas, por la salida de errores. Mismos códigos de salida.

const fs = require('fs');

const VERSION = 1;
const PLATFORMS = ['azure', 'github'];
const REPO_KEYS = { azure: ['org', 'project', 'repo'], github: ['org', 'repo'] };
const REQUIRED = ['public', 'profile', 'operations'];
const OPTIONAL = ['maintainers', 'harness_copies', 'merge_suites', 'models', 'wait_notice', 'coverage', 'review', 'stack', 'weekly_review'];
// La revisión de la semana: prendida o no, el tope en dólares de su única corrida del agente y el tope de material en
// caracteres. Lo lee scripts/nightly/weekly-review/weekly-review.js; sin la clave, prendida, 5 y 600.000: con 600.000
// entra casi toda una semana de mucho movimiento por menos de la mitad del tope en dólares.
const WEEKLY_REVIEW_KEYS = ['enabled', 'budget_usd', 'max_chars'];
const WEEKLY_REVIEW_DEFAULTS = Object.freeze({ enabled: true, budget_usd: 5, max_chars: 600000 });
const WEEKLY_REVIEW_MAX_USD = 100;
const WEEKLY_REVIEW_CHARS = [10000, 2000000];
// El plazo del aviso de espera: minutos enteros de 1 a 120. Lo lee scripts/hooks/wait-notice.js.
const WAIT_NOTICE_KEYS = ['minutes'];
const WAIT_NOTICE_MAX = 120;
// El umbral de cobertura de las líneas tocadas: un entero de 1 a 100. Lo lee
// skills/tycon-pipeline/scripts/lib/test-gate-report.js, después de TYCON_COVERAGE_MIN de la máquina y antes del 75.
const COVERAGE_KEYS = ['min_touched_lines_pct'];
// Las vueltas de revisores de una story: `max_rounds` = el tope, un entero de 1 a 6 (de fábrica 2);
// `blocking_prefixes` = prefijos de reglas que la organización suma a los de fábrica como «seguridad o datos»
// (SEC, TENANT, AUTH, NEXTSEC, SIGNALR-C, MIGRATION, DRIZZLE no se configuran, sólo se suman). Cada prefijo: mayúsculas,
// dígitos y guiones, y puede terminar en -C o -W.
const REVIEW_KEYS = ['max_rounds', 'blocking_prefixes'];
const REVIEW_PREFIX_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
// La tecnología de la organización: `code_extensions` = terminaciones que también son código, además de las
// del núcleo (skills/tycon-pipeline/scripts/lib/code-files.js, que la lee con lib/stack-config.js). Misma forma que
// `EXT_RE` de code-files.js: este lector no carga el skill, y stack-config.test.js compara las dos.
// `test_runners` = las herramientas de prueba que declara la organización; misma validación que `validateRunners` de
// skills/tycon-pipeline/scripts/lib/test-runners.js (test-runners.test.js compara los dos).
// `rules` = las reglas que otro equipo tiene distintas: cómo se nombran las pruebas, qué cuenta como pantalla para la
// prueba E2E obligatoria, y en qué idioma está la app. Una regla sin declarar vale lo de fábrica (stack-config.js).
const STACK_KEYS = ['code_extensions', 'test_runners', 'rules'];
const STACK_EXT_RE = /^\.[a-z0-9]+(?:\.[a-z0-9]+)?$/;
const RULE_VALUES = { test_names: ['any', 'pascal', 'snake'], screen_test: ['ui', 'react', 'off'] };
const UI_LANGUAGE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const RUNNER_RESULT_FORMATS = ['junit', 'jest-json', 'trx'];
const RUNNER_DETECT_DEPTH_MAX = 3;
const RUNNER_ARGS_FORBIDDEN = /["'$`\\\r\n]/;
const RUNNER_COVERAGE_FORMATS = ['cobertura', 'lcov', 'istanbul-json', 'jacoco', 'go-cover'];
const RUNNER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Los problemas de cada herramienta de `stack.test_runners`, con la ruta `stack.test_runners.<i>.<campo>`. */
function runnersProblems(value) {
  if (!Array.isArray(value)) return [{ path: 'stack.test_runners', message: 'tiene que ser una lista de herramientas de prueba' }];
  const out = []; const nombres = new Set();
  value.forEach((r, i) => {
    const p = `stack.test_runners.${i}`;
    if (!isObject(r)) { out.push({ path: p, message: 'tiene que ser un objeto' }); return; }
    if (typeof r.name !== 'string' || !RUNNER_NAME.test(r.name)) out.push({ path: `${p}.name`, message: `minúsculas, números y guiones (es ${JSON.stringify(r.name)})` });
    else if (nombres.has(r.name)) out.push({ path: `${p}.name`, message: `${r.name} está repetido` });
    if (typeof r.detect !== 'string' || !r.detect || r.detect.startsWith('/') || r.detect.startsWith('\\') || /^[A-Za-z]:/.test(r.detect) || r.detect.split(/[\\/]/).includes('..')) {
      out.push({ path: `${p}.detect`, message: 'el nombre de un archivo del proyecto, sin «..» ni ruta absoluta' });
    }
    if (typeof r.command !== 'string' || !r.command.trim()) out.push({ path: `${p}.command`, message: 'falta el comando que corre las pruebas' });
    if (!isObject(r.results) || !RUNNER_RESULT_FORMATS.includes(r.results.format) || typeof r.results.path !== 'string') {
      out.push({ path: `${p}.results.format`, message: `el reporte tiene que ser ${RUNNER_RESULT_FORMATS.join(' o ')}, con su path` });
    }
    if (r.coverage !== undefined && (!isObject(r.coverage) || !RUNNER_COVERAGE_FORMATS.includes(r.coverage.format) || typeof r.coverage.path !== 'string')) {
      out.push({ path: `${p}.coverage.format`, message: `la cobertura tiene que ser ${RUNNER_COVERAGE_FORMATS.join(', ')}, con su path` });
    }
    out.push(...runnerDetailProblems(r, p));
    if (typeof r.name === 'string') nombres.add(r.name);
  });
  return out;
}

/**
 * Los problemas de `detect_depth`, `args_default` y `repos` de una herramienta: hasta dónde busca su archivo detector y
 * el detalle de cada repo (`{args}` en el comando). Las mismas reglas que `detalleProblemas` de test-runners.js del skill.
 */
function runnerDetailProblems(r, p) {
  const out = [];
  if (r.detect_depth !== undefined && (!Number.isInteger(r.detect_depth) || r.detect_depth < 0 || r.detect_depth > RUNNER_DETECT_DEPTH_MAX)) {
    out.push({ path: `${p}.detect_depth`, message: `un entero de 0 a ${RUNNER_DETECT_DEPTH_MAX} (es ${JSON.stringify(r.detect_depth)})` });
  }
  const argsBad = (v) => typeof v !== 'string' || RUNNER_ARGS_FORBIDDEN.test(v);
  const ARGS_MSG = 'texto sin comillas, $, comillas invertidas, barra invertida ni saltos de línea (va entre comillas en el comando)';
  if (r.args_default !== undefined && argsBad(r.args_default)) out.push({ path: `${p}.args_default`, message: ARGS_MSG });
  if (r.repos === undefined) return out;
  if (!Array.isArray(r.repos)) return [...out, { path: `${p}.repos`, message: 'tiene que ser una lista de entradas { repo, args }' }];
  const seen = new Set();
  r.repos.forEach((e, j) => {
    const at = `${p}.repos.${j}`;
    if (!isObject(e)) { out.push({ path: at, message: 'tiene que ser un objeto { repo, args }' }); return; }
    for (const k of Object.keys(e)) if (k !== 'repo' && k !== 'args' && !fieldComment(k, e[k])) out.push({ path: `${at}.${k}`, message: 'clave desconocida' });
    const bad = repoProblems(e.repo, `${at}.repo`);
    if (bad.length) out.push(...bad);
    else {
      const key = identityKey(e.repo);
      if (seen.has(key)) out.push({ path: `${at}.repo`, message: 'este repo ya tiene una entrada en repos' });
      seen.add(key);
    }
    if (argsBad(e.args)) out.push({ path: `${at}.args`, message: ARGS_MSG });
  });
  return out;
}
// Copia de `MODELS` de skills/tycon-pipeline/scripts/lib/models.js, en su orden: este lector
// no puede cargar el skill —lo valida el instalador con el lector del árbol que va a quedar— y T21 compara las dos.
const MODEL_NAMES = ['haiku', 'sonnet', 'opus', 'fable'];
// Copia de `LEVELS` de models.js: lo que escribe la organización, en el mismo orden que MODEL_NAMES. Los nombres de
// Claude también valen, así un archivo guardado con ellos se lee sin tocarlo
const MODEL_LEVELS = ['economy', 'balanced', 'strong', 'max'];
/** La posición de un nivel o de un nombre (los dos en el mismo orden); -1 si no es ninguno. */
const modelRank = (v) => (MODEL_LEVELS.includes(v) ? MODEL_LEVELS.indexOf(v) : MODEL_NAMES.indexOf(v));
const levelName = (v) => MODEL_LEVELS[modelRank(v)];
const MODELS_KEYS = ['mandatory_ceiling', 'ceiling', 'reviewers', 'reviewer', 'reviewers_reloop', 'adversarial', 'helpers', 'session'];
const MODELS_SUBKEYS = { adversarial: ['model', 'heavy', 'fable_question'], session: ['low', 'normal', 'heavy'] };
const FABLE_QUESTION = ['ask', 'never'];
const REVIEWER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MERGE_RULES = ['automatico', 'siempre-en-la-maquina', 'confiar-en-el-servidor'];
const MERGE_ENTRY_KEYS = ['repo', 'rule', 'full_tests_pipeline'];
const KEYS = ['version', ...REQUIRED, ...OPTIONAL];
// Los nombres: letras, números, punto, guion, guion bajo, y espacios adentro. Azure acepta letras de cualquier idioma
// (un proyecto «Arnés del equipo» es válido); GitHub, sólo ASCII.
const NAME = {
  azure: /^[\p{L}\p{N}._-](?:[\p{L}\p{N}._ -]*[\p{L}\p{N}._-])?$/u,
  github: /^[A-Za-z0-9._-](?:[A-Za-z0-9._ -]*[A-Za-z0-9._-])?$/,
};

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// `comment`: la clave de un dato (un revisor) que es un comentario; `fieldComment`: la de un objeto de campos fijos,
// donde un nombre con «_» no puede ser un campo (`_comment`, `_lea_esto_primero`). Un comentario es texto: un «_» con
// forma de secreto, o que guarda un objeto, se revisa como cualquier otra clave. «__» sigue siendo comentario con
// cualquier valor.
const comment = (k) => k.startsWith('__');
const COMMENT_SECRET = /token|secret|sas|password|passwd|pwd|key|credential/i;
const fieldComment = (k, v) => comment(k) || (k.startsWith('_') && !COMMENT_SECRET.test(k) && (typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string'))));

/** Los problemas de un repo en `at`; `[]` si está bien. */
function repoProblems(value, at) {
  if (!isObject(value)) return [{ path: at, message: 'tiene que ser un objeto con platform y la dirección del repo' }];
  const { platform } = value;
  if (!PLATFORMS.includes(platform)) {
    return [{ path: `${at}.platform`, message: `tiene que ser ${PLATFORMS.map((p) => `«${p}»`).join(' o ')} (es ${JSON.stringify(platform)})` }];
  }
  const out = [];
  const wanted = REPO_KEYS[platform];
  for (const k of Object.keys(value)) {
    if (k === 'platform' || fieldComment(k, value[k])) continue;
    if (!wanted.includes(k)) out.push({ path: `${at}.${k}`, message: platform === 'github' && k === 'project' ? 'un repo de GitHub no lleva project' : `clave desconocida en un repo de ${platform}` });
  }
  for (const k of wanted) {
    const v = value[k];
    if (v === undefined) out.push({ path: `${at}.${k}`, message: 'falta' });
    else if (typeof v !== 'string' || !v.trim()) out.push({ path: `${at}.${k}`, message: 'tiene que ser un texto no vacío' });
    else if (!NAME[platform].test(v)) out.push({ path: `${at}.${k}`, message: `«${v}» tiene caracteres que no van en un nombre de ${platform} (letras${platform === 'github' ? ' sin tilde' : ''}, números, punto, guion, guion bajo; espacios sólo adentro)` });
  }
  return out;
}

const ruleProblem = (rule, at) => (MERGE_RULES.includes(rule) ? [] : [{ path: at, message: `tiene que ser ${MERGE_RULES.map((r) => `«${r}»`).join(', ')} (es ${JSON.stringify(rule)})` }]);

/** La identidad de un repo para compararlo: plataforma y nombres, sin mayúsculas y con los espacios decodificados. */
function identityKey(r) {
  if (!isObject(r) || !PLATFORMS.includes(r.platform)) return null;
  const plain = (v) => { const s = String(v == null ? '' : v); try { return decodeURIComponent(s).toLowerCase(); } catch (_) { return s.toLowerCase(); } };
  return [r.platform, ...REPO_KEYS[r.platform].map((k) => plain(r[k]))].join('/');
}

/** Los problemas de `merge_suites`; `[]` si está bien. */
function mergeSuitesProblems(value) {
  if (!isObject(value)) return [{ path: 'merge_suites', message: 'tiene que ser un objeto con default y repos' }];
  const out = [];
  for (const k of Object.keys(value)) {
    if (!fieldComment(k, value[k]) && k !== 'default' && k !== 'repos') out.push({ path: `merge_suites.${k}`, message: 'clave desconocida' });
  }
  if (value.default !== undefined) out.push(...ruleProblem(value.default, 'merge_suites.default'));
  if (value.repos === undefined) return out;
  if (!Array.isArray(value.repos)) return [...out, { path: 'merge_suites.repos', message: 'tiene que ser una lista de entradas { repo, rule, full_tests_pipeline }' }];
  const seen = new Set();
  value.repos.forEach((e, i) => {
    const at = `merge_suites.repos.${i}`;
    if (!isObject(e)) { out.push({ path: at, message: 'tiene que ser un objeto { repo, rule, full_tests_pipeline }' }); return; }
    for (const k of Object.keys(e)) if (!fieldComment(k, e[k]) && !MERGE_ENTRY_KEYS.includes(k)) out.push({ path: `${at}.${k}`, message: 'clave desconocida' });
    if (e.rule === undefined && e.full_tests_pipeline === undefined) out.push({ path: at, message: 'tiene que traer rule o full_tests_pipeline (sin ninguno, la entrada no dice nada)' });
    if (e.rule !== undefined) out.push(...ruleProblem(e.rule, `${at}.rule`));
    const repoErrs = e.repo === undefined ? [{ path: `${at}.repo`, message: 'falta' }] : repoProblems(e.repo, `${at}.repo`);
    out.push(...repoErrs);
    const p = e.full_tests_pipeline;
    if (p !== undefined) {
      const azure = isObject(e.repo) && e.repo.platform === 'azure';
      // en Azure un texto sólo de dígitos es un id (merge-pr.js): tiene que ser uno de verdad, mayor que cero
      const okText = typeof p === 'string' && p.trim() !== '' && !(azure && /^\d+$/.test(p) && Number(p) < 1);
      const okId = azure && Number.isInteger(p) && p >= 1;
      if (!okText && !okId) {
        out.push({ path: `${at}.full_tests_pipeline`, message: typeof p === 'number' && !azure
          ? 'en un repo de GitHub es el nombre del control obligatorio (un texto), no un número'
          : 'tiene que ser un texto no vacío (el nombre) o, en Azure, un entero mayor que cero (el id)' });
      }
    }
    if (!repoErrs.length) {
      const key = identityKey(e.repo);
      if (seen.has(key)) out.push({ path: `${at}.repo`, message: 'este repo ya tiene una entrada en merge_suites.repos' });
      seen.add(key);
    }
  });
  return out;
}

/**
 * Qué declara `merge_suites` para un repo: `{ declared, rule, ruleFrom, pipeline }`. `declared` = el archivo trae la clave
 * (también `{}`); sin ella, todo `null`. La regla: la de la entrada del repo (`repo`), si no el `default`
 * (`organization`), si no «automatico» (`default`). `identity` = `{ platform, org, project?, repo }`, como un <repo>.
 */
function mergeSuitesFor(data, identity) {
  if (!isObject(data) || data.merge_suites === undefined) return { declared: false, rule: null, ruleFrom: null, pipeline: null };
  const ms = isObject(data.merge_suites) ? data.merge_suites : {};
  const want = identityKey(identity);
  const entry = (Array.isArray(ms.repos) ? ms.repos : []).find((e) => isObject(e) && want !== null && identityKey(e.repo) === want) || null;
  const pipeline = entry && entry.full_tests_pipeline !== undefined ? entry.full_tests_pipeline : null;
  if (entry && entry.rule !== undefined) return { declared: true, rule: entry.rule, ruleFrom: 'repo', pipeline };
  if (ms.default !== undefined) return { declared: true, rule: ms.default, ruleFrom: 'organization', pipeline };
  return { declared: true, rule: 'automatico', ruleFrom: 'default', pipeline };
}

const modelProblem = (v, at) => (modelRank(v) >= 0 ? [] : [{ path: at, message: `tiene que ser ${MODEL_LEVELS.map((m) => `«${m}»`).join(', ')} (es ${JSON.stringify(v)})` }]);

/** Los problemas de `models`; `[]` si está bien. Cada uno con la ruta de su clave. */
function modelsProblems(value) {
  if (!isObject(value)) return [{ path: 'models', message: 'tiene que ser un objeto (los modelos de cada trabajo del pipeline)' }];
  const out = [];
  for (const k of Object.keys(value)) {
    if (fieldComment(k, value[k])) continue;
    if (!MODELS_KEYS.includes(k)) { out.push({ path: `models.${k}`, message: 'clave desconocida' }); continue; }
    const v = value[k];
    const at = `models.${k}`;
    if (k === 'mandatory_ceiling') {
      if (typeof v !== 'boolean') out.push({ path: at, message: `tiene que ser true o false (es ${JSON.stringify(v)})` });
    } else if (k === 'reviewer') {
      if (!isObject(v)) { out.push({ path: at, message: 'tiene que ser un objeto { "<revisor>": <modelo> }' }); continue; }
      for (const [r, m] of Object.entries(v)) {
        if (comment(r)) continue;
        if (!REVIEWER_NAME.test(r)) out.push({ path: `${at}.${r}`, message: 'el nombre de un revisor va en minúsculas, números y guiones' });
        else out.push(...modelProblem(m, `${at}.${r}`));
      }
    } else if (MODELS_SUBKEYS[k]) {
      if (!isObject(v)) { out.push({ path: at, message: `tiene que ser un objeto con ${MODELS_SUBKEYS[k].join(', ')}` }); continue; }
      for (const [s, m] of Object.entries(v)) {
        if (fieldComment(s, m)) continue;
        if (!MODELS_SUBKEYS[k].includes(s)) out.push({ path: `${at}.${s}`, message: 'clave desconocida' });
        else if (s === 'fable_question') {
          if (!FABLE_QUESTION.includes(m)) out.push({ path: `${at}.${s}`, message: `tiene que ser «ask» o «never» (es ${JSON.stringify(m)})` });
        } else out.push(...modelProblem(m, `${at}.${s}`));
      }
    } else out.push(...modelProblem(v, at));
  }
  // el techo es un solo modelo y vale sólo con mandatory_ceiling: true: uno sin el otro es un problema
  if (value.ceiling !== undefined && value.mandatory_ceiling !== true) out.push({ path: 'models.ceiling', message: 'un techo sin «mandatory_ceiling: true» no limita nada' });
  if (value.mandatory_ceiling === true && value.ceiling === undefined) out.push({ path: 'models.mandatory_ceiling', message: 'con techo obligatorio falta «ceiling»' });
  return out;
}

/**
 * Los trabajos que la organización declaró por encima de su tope obligatorio: `[{ path, message }]`. Sólo con
 * `mandatory_ceiling: true` y un `ceiling` válido, y sólo lo declarado: un trabajo sin declarar usa el valor por defecto,
 * que el pipeline baja al tope. NO entra en `modelsProblems`: con un problema ahí, cada máquina descarta toda la
 * configuración de modelos (también el tope); en las máquinas un modelo por encima se baja al tope y se avisa. Lo usa el
 * sitio, que no deja proponerlo.
 */
function modelsAboveCeiling(value) {
  if (!isObject(value) || value.mandatory_ceiling !== true || modelRank(value.ceiling) < 0) return [];
  // por posición: un nivel y un nombre se comparan igual, de cualquier lado; el tope se nombra por su nivel
  const tope = modelRank(value.ceiling);
  const out = [];
  const ver = (m, at) => { if (modelRank(m) > tope) out.push({ path: at, message: `pasa el tope obligatorio (${levelName(value.ceiling)})` }); };
  for (const k of ['reviewers', 'reviewers_reloop', 'helpers']) ver(value[k], `models.${k}`);
  for (const k of Object.keys(MODELS_SUBKEYS)) {
    if (!isObject(value[k])) continue;
    for (const s of MODELS_SUBKEYS[k]) if (s !== 'fable_question') ver(value[k][s], `models.${k}.${s}`);
  }
  if (isObject(value.reviewer)) for (const [r, m] of Object.entries(value.reviewer)) if (REVIEWER_NAME.test(r)) ver(m, `models.reviewer.${r}`);
  return out;
}

/**
 * Qué pasa con las suites completas de un repo SIN pipeline declarado, según su regla: `'machine'` (corren
 * en la máquina del dev) o `'server-if-any-check'` (las corre el servidor si la rama exige un control; si no, la
 * máquina); `null` con una regla desconocida. Es lo que decide `suitesDecision` de scripts/tools/merge-pr.js antes de
 * preguntarle a la plataforma; una prueba de merge-pr.test.js compara las dos.
 */
function suitesWithoutPipeline(rule) {
  if (rule === 'automatico' || rule === 'siempre-en-la-maquina') return 'machine';
  if (rule === 'confiar-en-el-servidor') return 'server-if-any-check';
  return null;
}

/**
 * Qué hace cada regla con las suites al mergear, como lo decide `suitesDecision` de `scripts/tools/merge-pr.js`:
 * `server-if-required` (automático: el servidor si la rama exige las pruebas; si no, la máquina), `machine-always`
 * (siempre en la máquina, aunque el servidor también las corra), `server-only` (confiar en el servidor); `null` si la
 * regla no existe. La pantalla de configuración lo dice debajo de cada selector.
 */
function suitesWithRule(rule) {
  if (rule === 'automatico') return 'server-if-required';
  if (rule === 'siempre-en-la-maquina') return 'machine-always';
  if (rule === 'confiar-en-el-servidor') return 'server-only';
  return null;
}

/** Los problemas de `wait_notice`; `[]` si está bien. */
function waitNoticeProblems(value) {
  if (!isObject(value)) return [{ path: 'wait_notice', message: 'tiene que ser un objeto (el plazo del aviso de espera)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!fieldComment(k, value[k]) && !WAIT_NOTICE_KEYS.includes(k)) out.push({ path: `wait_notice.${k}`, message: 'clave desconocida' });
  const m = value.minutes;
  if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= WAIT_NOTICE_MAX)) {
    out.push({ path: 'wait_notice.minutes', message: `tiene que ser un número entero de minutos, de 1 a ${WAIT_NOTICE_MAX} (es ${JSON.stringify(m)})` });
  }
  return out;
}

/** Los problemas de `weekly_review`; `[]` si está bien. Casos: scripts/tests/weekly-review.test.js T12. */
function weeklyReviewProblems(value) {
  if (!isObject(value)) return [{ path: 'weekly_review', message: 'tiene que ser un objeto (la revisión de la semana)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!comment(k) && !WEEKLY_REVIEW_KEYS.includes(k)) out.push({ path: `weekly_review.${k}`, message: 'clave desconocida' });
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') out.push({ path: 'weekly_review.enabled', message: `tiene que ser true o false (es ${JSON.stringify(value.enabled)})` });
  const b = value.budget_usd;
  if (b !== undefined && !(typeof b === 'number' && Number.isFinite(b) && b > 0 && b <= WEEKLY_REVIEW_MAX_USD)) {
    out.push({ path: 'weekly_review.budget_usd', message: `tiene que ser un monto en dólares mayor que 0 y hasta ${WEEKLY_REVIEW_MAX_USD} (es ${JSON.stringify(b)})` });
  }
  const c = value.max_chars;
  if (c !== undefined && !(Number.isInteger(c) && c >= WEEKLY_REVIEW_CHARS[0] && c <= WEEKLY_REVIEW_CHARS[1])) {
    out.push({ path: 'weekly_review.max_chars', message: `tiene que ser un número entero de caracteres, de ${WEEKLY_REVIEW_CHARS[0]} a ${WEEKLY_REVIEW_CHARS[1]} (es ${JSON.stringify(c)})` });
  }
  return out;
}

/** Los problemas de `coverage`; `[]` si está bien. */
function coverageProblems(value) {
  if (!isObject(value)) return [{ path: 'coverage', message: 'tiene que ser un objeto (el umbral de cobertura de las líneas tocadas)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!fieldComment(k, value[k]) && !COVERAGE_KEYS.includes(k)) out.push({ path: `coverage.${k}`, message: 'clave desconocida' });
  const p = value.min_touched_lines_pct;
  if (p !== undefined && !(Number.isInteger(p) && p >= 1 && p <= 100)) {
    out.push({ path: 'coverage.min_touched_lines_pct', message: `tiene que ser un porcentaje entero, de 1 a 100 (es ${JSON.stringify(p)})` });
  }
  return out;
}

/** Los problemas de `review`; `[]` si está bien. */
function reviewProblems(value) {
  if (!isObject(value)) return [{ path: 'review', message: 'tiene que ser un objeto (las vueltas de revisores de una story)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!fieldComment(k, value[k]) && !REVIEW_KEYS.includes(k)) out.push({ path: `review.${k}`, message: 'clave desconocida' });
  const n = value.max_rounds;
  if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 6)) {
    out.push({ path: 'review.max_rounds', message: `tiene que ser un número entero de vueltas, de 1 a 6 (es ${JSON.stringify(n)})` });
  }
  const b = value.blocking_prefixes;
  if (b !== undefined) {
    if (!Array.isArray(b)) out.push({ path: 'review.blocking_prefixes', message: 'tiene que ser una lista de prefijos de reglas' });
    else {
      const vistos = new Set();
      b.forEach((x, i) => {
        if (typeof x !== 'string' || !REVIEW_PREFIX_RE.test(x)) {
          out.push({ path: `review.blocking_prefixes.${i}`, message: `tiene que ser un prefijo de regla: mayúsculas, dígitos y guiones, como SEC o SIGNALR-C (es ${JSON.stringify(x)})` });
        } else if (vistos.has(x)) out.push({ path: `review.blocking_prefixes.${i}`, message: `repetido (${x})` });
        else vistos.add(x);
      });
    }
  }
  return out;
}

/** Los problemas de `stack`, con la ruta de cada clave; `[]` si está bien. */
function stackProblems(value) {
  if (!isObject(value)) return [{ path: 'stack', message: 'tiene que ser un objeto (la tecnología de la organización)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!fieldComment(k, value[k]) && !STACK_KEYS.includes(k)) out.push({ path: `stack.${k}`, message: 'clave desconocida' });
  const ex = value.code_extensions;
  if (ex !== undefined) {
    if (!Array.isArray(ex)) out.push({ path: 'stack.code_extensions', message: 'tiene que ser una lista de terminaciones, por ejemplo [".ex"]' });
    else {
      const vistos = new Set();
      ex.forEach((v, i) => {
        if (typeof v !== 'string' || !STACK_EXT_RE.test(v)) out.push({ path: `stack.code_extensions.${i}`, message: `cada terminación va con punto y en minúsculas, por ejemplo ".ex" (es ${JSON.stringify(v)})` });
        else if (vistos.has(v)) out.push({ path: `stack.code_extensions.${i}`, message: `${v} está repetida` });
        vistos.add(v);
      });
    }
  }
  if (value.test_runners !== undefined) out.push(...runnersProblems(value.test_runners));
  if (value.rules !== undefined) out.push(...rulesProblems(value.rules));
  return out;
}

/** Los problemas de `stack.rules`: claves cerradas, cada regla con sus valores. */
function rulesProblems(value) {
  if (!isObject(value)) return [{ path: 'stack.rules', message: 'tiene que ser un objeto con las reglas de la organización' }];
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (fieldComment(k, v)) continue;
    const p = `stack.rules.${k}`;
    if (RULE_VALUES[k]) {
      if (!RULE_VALUES[k].includes(v)) out.push({ path: p, message: `tiene que ser ${RULE_VALUES[k].join(', ')} (es ${JSON.stringify(v)})` });
    } else if (k === 'ui_language') {
      if (v !== null && (typeof v !== 'string' || !UI_LANGUAGE_RE.test(v))) out.push({ path: p, message: `el código del idioma, como "es" o "pt-BR", o null para no juzgarlo (es ${JSON.stringify(v)})` });
    } else out.push({ path: p, message: 'clave desconocida' });
  }
  return out;
}

/**
 * `stack` sin lo que tiene problemas: una terminación mal escrita no apaga lo demás de la sección, y una herramienta de
 * prueba mal escrita se descarta sola (las demás siguen).
 */
function stackSinProblemas(value, problemas) {
  const malas = new Set(problemas.map((p) => p.path.split('.')[1]).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!STACK_KEYS.includes(k)) continue;
    if (k === 'test_runners' && Array.isArray(v)) {
      const indices = new Set(problemas.map((p) => p.path.match(/^stack\.test_runners\.(\d+)/)).filter(Boolean).map((m) => Number(m[1])));
      out[k] = v.filter((_, i) => !indices.has(i));
    } else if (k === 'rules' && isObject(v)) {
      // una regla mal escrita sale sola: vale lo de fábrica, y las demás siguen
      const reglasMalas = new Set(problemas.map((p) => p.path.match(/^stack\.rules\.([^.]+)/)).filter(Boolean).map((m) => m[1]));
      out[k] = Object.fromEntries(Object.entries(v).filter(([r, x]) => !fieldComment(r, x) && !reglasMalas.has(r)));
    } else if (!malas.has(k)) out[k] = v;
  }
  return out;
}

/** Valida un objeto ya leído. */
function validate(doc) {
  if (!isObject(doc)) return [{ path: '', message: 'el archivo tiene que ser un objeto JSON' }];
  const problems = [];
  for (const k of Object.keys(doc)) {
    if (!fieldComment(k, doc[k]) && !KEYS.includes(k)) problems.push({ path: k, message: k === 'owners' ? 'la lista de responsables no va acá (este archivo llega a todas las máquinas): va en operations.json, en el repo de operaciones' : 'clave desconocida' });
  }
  if (doc.version === undefined) problems.push({ path: 'version', message: 'falta' });
  else if (doc.version !== VERSION) problems.push({ path: 'version', message: `tiene que ser ${VERSION} (es ${JSON.stringify(doc.version)})` });
  for (const k of REQUIRED) {
    if (doc[k] === undefined) problems.push({ path: k, message: 'falta' });
    else problems.push(...repoProblems(doc[k], k));
  }
  if (doc.maintainers !== undefined) problems.push(...repoProblems(doc.maintainers, 'maintainers'));
  if (doc.harness_copies !== undefined) {
    if (!Array.isArray(doc.harness_copies)) problems.push({ path: 'harness_copies', message: 'tiene que ser una lista de repos' });
    else doc.harness_copies.forEach((r, i) => problems.push(...repoProblems(r, `harness_copies.${i}`)));
  }
  if (doc.merge_suites !== undefined) problems.push(...mergeSuitesProblems(doc.merge_suites));
  return problems;
}

/** `{ ok, data, problems }` del texto de un team-repos.json. */
function parse(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) {
    return { ok: false, data: null, problems: [{ path: '', message: `no es JSON válido: ${String((e && e.message) || e).split('\n')[0]}` }] };
  }
  const problems = validate(doc);
  // un problema dentro de `models` no invalida el archivo: va aparte y `data` sale sin `models`
  const sectionModels = isObject(doc) && doc.models !== undefined ? modelsProblems(doc.models) : [];
  // lo mismo con `wait_notice`: un plazo mal escrito no deja a todas las máquinas sin el archivo
  const sectionWait = isObject(doc) && doc.wait_notice !== undefined ? waitNoticeProblems(doc.wait_notice) : [];
  // y con `coverage`: un umbral mal escrito cae al valor por defecto, no deja sin el archivo
  const sectionCoverage = isObject(doc) && doc.coverage !== undefined ? coverageProblems(doc.coverage) : [];
  // y con `review`: un tope mal escrito cae al de fábrica (2), no deja sin el archivo
  const sectionReview = isObject(doc) && doc.review !== undefined ? reviewProblems(doc.review) : [];
  // y con `stack`: se descarta sólo la subclave con el problema, el resto de la sección sigue
  const sectionStack = isObject(doc) && doc.stack !== undefined ? stackProblems(doc.stack) : [];
  // y con `weekly_review`: un tope mal escrito deja la revisión con los valores por defecto, y lo dice
  const sectionWeekly = isObject(doc) && doc.weekly_review !== undefined ? weeklyReviewProblems(doc.weekly_review) : [];
  let data = problems.length ? null : doc;
  if (data && (sectionModels.length || sectionWait.length || sectionCoverage.length || sectionReview.length || sectionStack.length || sectionWeekly.length)) {
    data = { ...doc };
    if (sectionModels.length) delete data.models;
    if (sectionWait.length) delete data.wait_notice;
    if (sectionWeekly.length) delete data.weekly_review;
    if (sectionCoverage.length) delete data.coverage;
    if (sectionReview.length) delete data.review;
    if (sectionStack.length) {
      if (isObject(doc.stack)) data.stack = stackSinProblemas(doc.stack, sectionStack);
      else delete data.stack;
    }
  }
  const sections = {
    ...(sectionModels.length ? { models: sectionModels } : {}),
    ...(sectionWait.length ? { wait_notice: sectionWait } : {}),
    ...(sectionCoverage.length ? { coverage: sectionCoverage } : {}),
    ...(sectionReview.length ? { review: sectionReview } : {}),
    ...(sectionStack.length ? { stack: sectionStack } : {}),
    ...(sectionWeekly.length ? { weekly_review: sectionWeekly } : {}),
  };
  return { ok: problems.length === 0, data, problems, ...(Object.keys(sections).length ? { sectionProblems: sections } : {}) };
}

/** Lo mismo desde un archivo; si no se pudo leer, `couldNotRead: true` con el motivo. */
function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, data: null, couldNotRead: true, problems: [{ path: '', message: `no pude leer ${file}: ${(e && e.code) || (e && e.message) || e}` }] };
  }
  return { ...parse(text), couldNotRead: false };
}

/** La URL de un repo ya validado. */
function url(repo) {
  if (!isObject(repo)) return null;
  if (repo.platform === 'azure') return `https://dev.azure.com/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repo)}`;
  if (repo.platform === 'github') return `https://github.com/${repo.org}/${repo.repo}`;
  return null;
}

/** El id de un repo para comparar con lo que lista la organización: `<project>/<repo>` en Azure, `<org>/<repo>` en GitHub. */
function repoId(repo) {
  return repo.platform === 'azure' ? `${repo.project}/${repo.repo}` : `${repo.org}/${repo.repo}`;
}

/**
 * Las copias del arnés de una plataforma, de un archivo ya validado: `[{ id, measured }]`. Se mide sólo la de
 * mantenimiento (`maintainers`), si está en la lista; sin ella, ninguna. Las mayúsculas no distinguen (Azure y GitHub no
 * las distinguen en los nombres).
 */
function harnessCopies(data, platform) {
  if (!isObject(data) || !Array.isArray(data.harness_copies)) return [];
  const full = (r) => REPO_KEYS[r.platform].map((k) => String(r[k]).toLowerCase()).join('/');
  const m = isObject(data.maintainers) && PLATFORMS.includes(data.maintainers.platform) ? data.maintainers : null;
  return data.harness_copies
    .filter((r) => isObject(r) && r.platform === platform)
    .map((r) => ({ id: repoId(r), measured: !!m && m.platform === r.platform && full(m) === full(r) }));
}

/** La referencia `<project>/_git/<repo>` del repo de mantenimiento (la que piden las validaciones), o null. */
function privateRepoRef(data) {
  const m = data && data.maintainers;
  if (!isObject(m) || m.platform !== 'azure') return null;
  return `${m.project}/_git/${m.repo}`;
}

module.exports = { VERSION, PLATFORMS, REPO_KEYS, KEYS, MERGE_RULES, MODEL_NAMES, MODEL_LEVELS, STACK_KEYS, STACK_EXT_RE, RULE_VALUES, UI_LANGUAGE_RE, WEEKLY_REVIEW_DEFAULTS, modelsProblems, reviewProblems, modelsAboveCeiling, suitesWithoutPipeline, suitesWithRule, stackProblems, weeklyReviewProblems, parse, load, url, privateRepoRef, repoProblems, identityKey, harnessCopies, mergeSuitesFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--harness-copies');
  const platform = at >= 0 ? args[at + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  if (!file || (at >= 0 && !PLATFORMS.includes(platform))) {
    process.stderr.write('uso: node scripts/lib/team-repos.js <team-repos.json> [--json | --harness-copies <azure|github>]\n');
    process.exit(2);
  }
  const r = load(file);
  if (at >= 0) {
    // para los pipelines: la lista por la salida, los problemas por la de errores (no se mezclan con la lista)
    if (r.ok) for (const c of harnessCopies(r.data, platform)) process.stdout.write(`${c.measured ? 'measure' : 'skip'}\t${c.id}\n`);
    else for (const p of r.problems) process.stderr.write(`❌ ${file} · ${p.path || '(el archivo)'}: ${p.message}\n`);
  } else if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.ok) process.stdout.write(`✅ ${file}: válido\n`);
  else for (const p of r.problems) process.stdout.write(`❌ ${p.path || '(el archivo)'}: ${p.message}\n`);
  process.exit(r.ok ? 0 : (r.couldNotRead ? 2 : 1));
}
