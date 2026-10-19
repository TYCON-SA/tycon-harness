#!/usr/bin/env node
'use strict';
// team-repos.js — dónde vive cada repo del arnés de una organización (story 8.26, tanda J · 2026-10-13).
//
// POR QUÉ EXISTE: el nombre de cada repo del arnés estaba escrito a mano en lugares distintos —el del público en una
// lista del repo de mantenimiento, el del perfil y el de mantenimiento al lado, las copias del arnés en una variable de
// una definición de Azure, el repo privado de las validaciones en otra—, y una organización nueva no tenía dónde
// decir los suyos. `team-repos.json`, en la raíz del perfil del equipo, los declara a todos en un solo lugar. Lo leen el
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
//     "merge_suites": {                 opcional (story 7.28) — dónde corren las suites completas al mergear cada repo
//       "default"?: <regla>,            la de la organización; sin ella, «automatico»
//       "repos"?: [ { "repo": <repo>, "rule"?: <regla>, "full_tests_pipeline"?: <texto> | <entero ≥ 1, sólo Azure> } ] }
//                                       cada entrada trae al menos `rule` o `full_tests_pipeline`; un repo, una vez
//   <regla> = «automatico» | «siempre-en-la-maquina» | «confiar-en-el-servidor» (MERGE_RULES; las decidió el dueño así).
//   `full_tests_pipeline` es «el pipeline de pruebas completas» del repo: en Azure, por nombre o por id; en GitHub, el
//   nombre del control obligatorio. Lo usa el skill de merge (scripts/tools/merge-pr.js); sin la clave, el skill lee
//   `merge.mode` del repo como antes. La clave es opcional: no sube la versión del archivo.
//     "models": {                       opcional (story 7.29) — el modelo de cada trabajo del pipeline
//       "mandatory_ceiling"?: <bool>, "ceiling"?: <modelo>,   techo obligatorio (paga la organización): van juntos
//       "reviewers"?: <modelo>, "reviewer"?: { "<revisor>": <modelo> }, "reviewers_reloop"?: <modelo>,
//       "adversarial"?: { "model"?, "heavy"?: <modelo>, "fable_question"?: «ask» | «never» }, "helpers"?: <modelo>,
//       "session"?: { "low"?, "normal"?, "heavy"?: <modelo> } }
//   <modelo> = «haiku» | «sonnet» | «opus» | «fable» (MODEL_NAMES, copia de models.js del skill). Quien la resuelve
//   es skills/tycon-pipeline/scripts/lib/models.js (`readOrgModels`, el único que la lee).
//   <repo> = { "platform": "azure", "org", "project", "repo" } o { "platform": "github", "org", "repo" }.
//   Las claves que empiezan con `__` son comentarios. Cualquier otra clave es un problema, en su propia ruta: así un
//   nombre mal escrito no queda ignorado en silencio.
//   La lista de responsables NO va acá (este archivo llega a todas las máquinas): va en `operations.json`, en el repo
//   de operaciones (scripts/lib/operations-config.js).
//
// EL CONTRATO: `parse(text)` → `{ ok, data, problems }`. Cada problema es `{ path, message }`, con la ruta de la clave
// en puntos e índices (`operations.project`, `harness_copies.1.repo`; `''` para el archivo entero). Con un problema,
// `data` es `null`: nunca hay datos a medias. Excepción (story 7.29, decisión 13): un problema DENTRO de `models` no
// anula el archivo —un modelo mal escrito dejaría a todas las máquinas sin la capa—; sale aparte, en
// `sectionProblems.models`, `ok` no cambia por eso y `data` viene sin `models` (se usan los valores de hoy). `load(file)` suma `couldNotRead: true` cuando el archivo no se pudo leer:
// «no pude leer» nunca es «no hay repo».
//
// LAS COPIAS DEL ARNÉS, PARA LAS MÉTRICAS (DEF-8.30-copias-del-arnes-en-team-repos · 2026-10-14, decisión del dueño):
// antes las declaraba una variable de cada definición (`HARNESS_COPIES`, y `HARNESS_MEASURED_COPY` la que cuenta); ahora
// las declara este archivo, como el resto de los repos: un lugar menos que configurar. `harnessCopies(data, platform)`
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
const OPTIONAL = ['maintainers', 'harness_copies', 'merge_suites', 'models', 'wait_notice', 'coverage', 'stack'];
// El plazo del aviso de espera (story 7.20, AC 14): minutos enteros de 1 a 120. Lo lee scripts/hooks/wait-notice.js.
const WAIT_NOTICE_KEYS = ['minutes'];
const WAIT_NOTICE_MAX = 120;
// El umbral de cobertura de las líneas tocadas: un entero de 1 a 100. Lo lee
// skills/tycon-pipeline/scripts/lib/test-gate-report.js, después de TYCON_COVERAGE_MIN de la máquina y antes del 75.
const COVERAGE_KEYS = ['min_touched_lines_pct'];
// La tecnología de la organización: `code_extensions` = terminaciones que también son código, además de las
// del núcleo (skills/tycon-pipeline/scripts/lib/code-files.js, que la lee con lib/stack-config.js). Misma forma que
// `EXT_RE` de code-files.js: este lector no carga el skill, y stack-config.test.js compara las dos.
const STACK_KEYS = ['code_extensions'];
const STACK_EXT_RE = /^\.[a-z0-9]+(?:\.[a-z0-9]+)?$/;
// Copia de `MODELS` de skills/tycon-pipeline/scripts/lib/models.js, en su orden (story 7.29, decisión 12): este lector
// no puede cargar el skill —lo valida el instalador con el lector del árbol que va a quedar— y T21 compara las dos.
const MODEL_NAMES = ['haiku', 'sonnet', 'opus', 'fable'];
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
const comment = (k) => k.startsWith('__');

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
    if (k === 'platform' || comment(k)) continue;
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
    if (!comment(k) && k !== 'default' && k !== 'repos') out.push({ path: `merge_suites.${k}`, message: 'clave desconocida' });
  }
  if (value.default !== undefined) out.push(...ruleProblem(value.default, 'merge_suites.default'));
  if (value.repos === undefined) return out;
  if (!Array.isArray(value.repos)) return [...out, { path: 'merge_suites.repos', message: 'tiene que ser una lista de entradas { repo, rule, full_tests_pipeline }' }];
  const seen = new Set();
  value.repos.forEach((e, i) => {
    const at = `merge_suites.repos.${i}`;
    if (!isObject(e)) { out.push({ path: at, message: 'tiene que ser un objeto { repo, rule, full_tests_pipeline }' }); return; }
    for (const k of Object.keys(e)) if (!comment(k) && !MERGE_ENTRY_KEYS.includes(k)) out.push({ path: `${at}.${k}`, message: 'clave desconocida' });
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

const modelProblem = (v, at) => (MODEL_NAMES.includes(v) ? [] : [{ path: at, message: `tiene que ser ${MODEL_NAMES.map((m) => `«${m}»`).join(', ')} (es ${JSON.stringify(v)})` }]);

/** Los problemas de `models` (story 7.29); `[]` si está bien. Cada uno con la ruta de su clave. */
function modelsProblems(value) {
  if (!isObject(value)) return [{ path: 'models', message: 'tiene que ser un objeto (los modelos de cada trabajo del pipeline)' }];
  const out = [];
  for (const k of Object.keys(value)) {
    if (comment(k)) continue;
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
        if (comment(s)) continue;
        if (!MODELS_SUBKEYS[k].includes(s)) out.push({ path: `${at}.${s}`, message: 'clave desconocida' });
        else if (s === 'fable_question') {
          if (!FABLE_QUESTION.includes(m)) out.push({ path: `${at}.${s}`, message: `tiene que ser «ask» o «never» (es ${JSON.stringify(m)})` });
        } else out.push(...modelProblem(m, `${at}.${s}`));
      }
    } else out.push(...modelProblem(v, at));
  }
  // el techo es un solo modelo y vale sólo con mandatory_ceiling: true (decisión 15): uno sin el otro es un problema
  if (value.ceiling !== undefined && value.mandatory_ceiling !== true) out.push({ path: 'models.ceiling', message: 'un techo sin «mandatory_ceiling: true» no limita nada' });
  if (value.mandatory_ceiling === true && value.ceiling === undefined) out.push({ path: 'models.mandatory_ceiling', message: 'con techo obligatorio falta «ceiling»' });
  return out;
}

/** Los problemas de `wait_notice` (story 7.20); `[]` si está bien. */
function waitNoticeProblems(value) {
  if (!isObject(value)) return [{ path: 'wait_notice', message: 'tiene que ser un objeto (el plazo del aviso de espera)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!comment(k) && !WAIT_NOTICE_KEYS.includes(k)) out.push({ path: `wait_notice.${k}`, message: 'clave desconocida' });
  const m = value.minutes;
  if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= WAIT_NOTICE_MAX)) {
    out.push({ path: 'wait_notice.minutes', message: `tiene que ser un número entero de minutos, de 1 a ${WAIT_NOTICE_MAX} (es ${JSON.stringify(m)})` });
  }
  return out;
}

/** Los problemas de `coverage`; `[]` si está bien. */
function coverageProblems(value) {
  if (!isObject(value)) return [{ path: 'coverage', message: 'tiene que ser un objeto (el umbral de cobertura de las líneas tocadas)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!comment(k) && !COVERAGE_KEYS.includes(k)) out.push({ path: `coverage.${k}`, message: 'clave desconocida' });
  const p = value.min_touched_lines_pct;
  if (p !== undefined && !(Number.isInteger(p) && p >= 1 && p <= 100)) {
    out.push({ path: 'coverage.min_touched_lines_pct', message: `tiene que ser un porcentaje entero, de 1 a 100 (es ${JSON.stringify(p)})` });
  }
  return out;
}

/** Los problemas de `stack`, con la ruta de cada clave; `[]` si está bien. */
function stackProblems(value) {
  if (!isObject(value)) return [{ path: 'stack', message: 'tiene que ser un objeto (la tecnología de la organización)' }];
  const out = [];
  for (const k of Object.keys(value)) if (!comment(k) && !STACK_KEYS.includes(k)) out.push({ path: `stack.${k}`, message: 'clave desconocida' });
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
  return out;
}

/** `stack` sin las subclaves con problemas: una terminación mal escrita no apaga lo demás de la sección. */
function stackSinProblemas(value, problemas) {
  const malas = new Set(problemas.map((p) => p.path.split('.')[1]).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(value)) if (STACK_KEYS.includes(k) && !malas.has(k)) out[k] = v;
  return out;
}

/** Valida un objeto ya leído. */
function validate(doc) {
  if (!isObject(doc)) return [{ path: '', message: 'el archivo tiene que ser un objeto JSON' }];
  const problems = [];
  for (const k of Object.keys(doc)) {
    if (!comment(k) && !KEYS.includes(k)) problems.push({ path: k, message: k === 'owners' ? 'la lista de responsables no va acá (este archivo llega a todas las máquinas): va en operations.json, en el repo de operaciones' : 'clave desconocida' });
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
  // un problema dentro de `models` no invalida el archivo (story 7.29, decisión 13): va aparte y `data` sale sin `models`
  const sectionModels = isObject(doc) && doc.models !== undefined ? modelsProblems(doc.models) : [];
  // lo mismo con `wait_notice` (story 7.20): un plazo mal escrito no deja a todas las máquinas sin el archivo
  const sectionWait = isObject(doc) && doc.wait_notice !== undefined ? waitNoticeProblems(doc.wait_notice) : [];
  // y con `coverage`: un umbral mal escrito cae al valor por defecto, no deja sin el archivo
  const sectionCoverage = isObject(doc) && doc.coverage !== undefined ? coverageProblems(doc.coverage) : [];
  // y con `stack`: se descarta sólo la subclave con el problema, el resto de la sección sigue
  const sectionStack = isObject(doc) && doc.stack !== undefined ? stackProblems(doc.stack) : [];
  let data = problems.length ? null : doc;
  if (data && (sectionModels.length || sectionWait.length || sectionCoverage.length || sectionStack.length)) {
    data = { ...doc };
    if (sectionModels.length) delete data.models;
    if (sectionWait.length) delete data.wait_notice;
    if (sectionCoverage.length) delete data.coverage;
    if (sectionStack.length) {
      if (isObject(doc.stack)) data.stack = stackSinProblemas(doc.stack, sectionStack);
      else delete data.stack;
    }
  }
  const sections = {
    ...(sectionModels.length ? { models: sectionModels } : {}),
    ...(sectionWait.length ? { wait_notice: sectionWait } : {}),
    ...(sectionCoverage.length ? { coverage: sectionCoverage } : {}),
    ...(sectionStack.length ? { stack: sectionStack } : {}),
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

module.exports = { VERSION, PLATFORMS, REPO_KEYS, KEYS, MERGE_RULES, MODEL_NAMES, STACK_KEYS, STACK_EXT_RE, modelsProblems, stackProblems, parse, load, url, privateRepoRef, repoProblems, harnessCopies, mergeSuitesFor };

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
