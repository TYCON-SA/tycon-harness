#!/usr/bin/env node
/**
 * pipeline.js — comandos mecánicos del pipeline.
 *
 * Saca del LLM la DECISIÓN de qué advisors correr en el Step 5. El LLM no infiere
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
 * Fuente de verdad de la matriz: este archivo. step-05-advisors-parallel.md la
 * describe en prosa pero la AUTORIDAD es computeAdvisorSet() acá (el step la referencia).
 *
 * Determinismo de SELECCIÓN (mismo diff → mismo set), NO de output (los advisors son LLMs).
 *
 * Los revisores de un producto o de un cliente (convenciones de
 * plugins Bizuit, plugins hermanos, el adaptador de un cliente) NO están en este archivo: viven en `packs/<nombre>/pack.json`
 * (lib/packs.js) y se suman al set por manifiesto. La salida de `advisors` lleva `packs`.
 */

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const os = require('os');
const honesty = require('./lib/ledger-honesty.js');
const companionLib = require('./lib/companion-repos.js');   // el repo hermano de una story de dos repos
const codeFiles = require('./lib/code-files.js');         // qué es código, qué es prueba (una sola lista)
const stackConfig = require('./lib/stack-config.js');     // lo que sume la organización (team-repos.json → stack)

// ── log de invocaciones reales de advisors ─────────────────
// El hook on-advisor-run.js (PreToolUse Task) registra cada subagent spawneado acá.
// `advisors` marca el inicio del Step 5; `check-count` lee lo corrido DESDE esa marca
// como ground-truth, en vez de confiar en el `--ran` que el LLM redacta.
const RUNS_DIR = path.join(stateDirOf(os.homedir()), 'advisor-runs');
function sessionLogPath() {
  const sid = sessionIdFileKey();
  return path.join(RUNS_DIR, `${sid}.jsonl`);
}
// `expected`: el set ESPERADO de esta iteración queda persistido en la línea step5-start.
// check-count valida contra ESE expected (que en un smart-reloop legítimo es el
// subset `rerun`), no contra el set completo recomputado — sin esto, tras un
// smart-reloop válido, check-count daría exit 2 siempre (o se ignoraría el gate).
function logStep5Start(expected, meta) {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.appendFileSync(sessionLogPath(), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'step5-start',
      expected: Array.isArray(expected) ? expected : undefined,
      ...(meta || {}),
    }) + '\n', 'utf8');
  } catch { /* best-effort */ }
}
// Estado del log DESDE el último step5-start. Devuelve:
//   { sawStart: bool, expected: string[]|null, ran: string[] }
// — sawStart=false → no hay log/marca (hook no instalado o pipeline.js no corrió).
// — sawStart=true + ran=[] → pipeline.js SÍ corrió pero el hook no registró NINGÚN
//   spawn: o no se corrieron los advisors o la registración está rota. El caller
//   (check-count) FALLA CERRADO en este caso: caer en silencio al --ran del LLM
//   dejaría pasar un Step 5 sin ningún spawn registrado.
function advisorsRunSinceStart() {
  let raw;
  try { raw = fs.readFileSync(sessionLogPath(), 'utf8'); } catch { return { sawStart: false, expected: null, ran: [] }; }
  const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (lines.length === 0) return { sawStart: false, expected: null, ran: [] };
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].event === 'step5-start') { startIdx = i; break; } }
  if (startIdx === -1) return { sawStart: false, expected: null, ran: [] };
  const ran = lines.slice(startIdx).filter((e) => e.advisor).map((e) => e.advisor);
  const expected = Array.isArray(lines[startIdx].expected) ? lines[startIdx].expected : null;
  return { sawStart: true, expected, ran: [...new Set(ran)] };
}

// ── helpers de lectura (todas fail-safe: nunca tiran) ────────────────────────
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
// Dónde nace la evidencia de cierre de una story: el repo que la CONTIENE.
const { evidenceDirForStory } = require('./lib/evidence-config.js');
const { evidenceKey, keyOr: evidenceKeyOr } = require('./lib/evidence-key.js');
// La sección «Reglas para revisores» del CLAUDE.md del repo, al principio del contexto.
const { reglasRevisores, bloqueParaContexto, resumen: resumenReglas } = require('./lib/reviewer-rules.js');
/**
 * PIPE-C2 · qué carpetas le faltan al `.gitignore` del repo, decidido carpeta por carpeta.
 *
 * 🔴 La pregunta NO es «¿existe la línea `.advisors/`?» sino «¿el repo ya decidió algo sobre esa
 *    carpeta?». Un repo que
 *    la ignora con `**\/.advisors/*` + `!**\/.advisors/dod-runtime/` —el patrón que deja viajar la
 *    evidencia de cierre—, comparado por línea exacta, parece no haber decidido nada, y el `.advisors/`
 *    que el preflight appendearía **anularía la negación** (git no re-incluye nada dentro de un
 *    directorio excluido). Resultado: la evidencia de cierre dejaría de viajar y el medidor SDLC la
 *    leería como 0%, en cada `start`, y habría que revertir el archivo a mano.
 *
 * Reglas, y las tres son deliberadas:
 *   · **Un comentario NO es una regla**: nombrar `.advisors` en un `#` no la ignora, así que la
 *     línea se agrega igual (mismo criterio que `check-artifact-paths.js`).
 *   · **Una carpeta con nombre parecido no cuenta**: `.advisors-viejo/` no cubre `.advisors`.
 *   · **Se decide carpeta por carpeta**: que una esté cubierta no dice nada de la otra.
 */
// El bloque canónico de `.advisors`, copiado del `.gitignore` del arnés. Es UNO y se
// escribe entero: `.advisors/` a secas excluye el
// directorio y con eso ANULA cualquier negación, así que la evidencia deja de viajar.
// El registro de aprobaciones de la corrida viaja también: el portón de CI lo lee.
const LINEA_APROBACIONES = '!**/.advisors/pipeline-runs/*/approvals.jsonl';
const GITIGNORE_ADVISORS = [
  '# TYCON — los artefactos efimeros de advisors NO viajan, pero la evidencia de cierre SI:',
  '# es auditable y el medidor SDLC la lee desde el servidor (si no viaja, mide 0% y miente).',
  '# Patron `dir/*` (no `dir/`) para que la negacion pueda re-incluir el subdirectorio.',
  '**/.advisors/*',
  '!**/.advisors/dod-runtime/',
  '# ...y de cada corrida del pipeline viajan SOLO el registro de revisores y sus hallazgos:',
  '# es lo que el porton de CI exige para pasar una story a `done` (2026-09-05).',
  '!**/.advisors/pipeline-runs/',
  '**/.advisors/pipeline-runs/*',
  '!**/.advisors/pipeline-runs/*/',
  '**/.advisors/pipeline-runs/*/*',
  '!**/.advisors/pipeline-runs/*/review-roster.json',
  '!**/.advisors/pipeline-runs/*/findings.json',
  LINEA_APROBACIONES,
];

/** Las sondas: rutas que NO existen en el disco, sólo para preguntarle a git qué haría con ellas. */
// 🔴 La sonda de lo efímero es un NIETO de `pipeline-runs/`, no un hijo directo: el
// bloque canónico re-incluye `pipeline-runs/` para que viaje el registro de revisores, así que un
// hijo directo podría no estar ignorado con el bloque puesto, el preflight leería "sin decisión" y
// volvería a agregar el bloque en CADA start. Un nieto está
// ignorado con el bloque viejo, con el nuevo y con `.advisors/` a secas, y no lo está sin regla.
const SONDA_EFIMERO = '.advisors/pipeline-runs/__sonda-pipe-c2__/__sonda__';
const SONDA_EVIDENCIA = '.advisors/dod-runtime/__sonda-pipe-c2__';
const SONDA_DASHBOARD = '.dashboard/__sonda-pipe-c2__';
// Lo que el portón de CI exige para `done`: el registro de revisores de la corrida.
const SONDA_ROSTER = '.advisors/pipeline-runs/__sonda-pipe-c2__/review-roster.json';
const SONDA_APROBACIONES = '.advisors/pipeline-runs/__sonda-pipe-c2__/approvals.jsonl';

/**
 * PIPE-C2 · qué le falta al `.gitignore`, preguntándole a GIT y no al texto.
 *
 * 🔴 Comparar TEXTO (¿el archivo menciona `.advisors`?) se equivoca del lado caro:
 *    con una negación suelta, una subruta (`FrontEnd/.advisors/x/`), un
 *    archivo suelto (`.advisors/tests-result.json`) o un comentario pegado al final de la línea,
 *    diría «ya está cubierta» y git NO ignoraría nada — el repo commitearía los artefactos efímeros.
 *    Muchos `.gitignore` plausibles reproducen el error. La única fuente de verdad sobre si una ruta
 *    está ignorada es git, así que se le pregunta a él.
 *
 * `probe(rutaRelativa)` devuelve `true` (git la ignora), `false` (no la ignora) o `null` (no se
 * pudo preguntar). **`null` NO se trata como «falta»**: no tocamos un `.gitignore` sin saber qué
 * hay, y se deja constancia — «no pude mirar» y «miré y falta» no se escriben igual.
 *
 * Devuelve `{ append: [líneas a agregar], notices: [avisos para la persona] }`.
 */
function computeGitignoreNeeds(probe) {
  const append = [];
  const notices = [];

  const efimero = probe(SONDA_EFIMERO);
  if (efimero === false) {
    append.push(...GITIGNORE_ADVISORS);
  } else if (efimero === null) {
    notices.push('PIPE-C2: no pude preguntarle a git si `.advisors/` está ignorada — no toco el '
      + '.gitignore. Revisalo a mano.');
  } else {
    // Cubierta, pero de más: se está tragando lo que SÍ tiene que viajar. NO se reescribe sola —
    // es una decisión del repo y pisarla en silencio sería el mismo pecado al revés. UN aviso con
    // todo lo que falta (el registro de revisores también viaja, por el `done` por PR).
    const traga = [];
    if (probe(SONDA_EVIDENCIA) === true) traga.push('`.advisors/dod-runtime/` (la evidencia de cierre de cada story NO viaja y el medidor SDLC la lee como 0%)');
    if (probe(SONDA_ROSTER) === true) traga.push('`.advisors/pipeline-runs/*/review-roster.json` + `findings.json` + `approvals.jsonl` (el registro de revisores y el de aprobaciones NO viajan y el portón de CI no deja pasar la story)');
    // Un repo con el bloque estándar (el registro de revisores viaja) y sin la línea del registro
    // de aprobaciones. Agregar esa única negación es aditivo —no cambia lo que el repo decidió ignorar— y corre antes
    // de toda aprobación, así que la línea llega en el mismo commit que el primer registro.
    if (probe(SONDA_ROSTER) === false && probe(SONDA_APROBACIONES) === true) {
      append.push('# ...y el registro de aprobaciones de la corrida (manual o automática), que el portón de CI lee:', LINEA_APROBACIONES);
    }
    if (traga.length) {
      notices.push('PIPE-C2 AVISO: el .gitignore de este repo ignora TAMBIÉN '
        + traga.join(' y ') + '. El bloque correcto es el de GITIGNORE_ADVISORS '
        + '(`**/.advisors/*` + `!**/.advisors/dod-runtime/` + la re-inclusión de '
        + '`pipeline-runs/*/review-roster.json` y `findings.json`). No lo cambio solo: decidilo vos.');
    }
  }

  const dash = probe(SONDA_DASHBOARD);
  if (dash === false) append.push('.dashboard/');
  else if (dash === null) {
    notices.push('PIPE-C2: no pude preguntarle a git si `.dashboard/` está ignorada — no toco el '
      + '.gitignore.');
  }

  return { append, notices };
}

/** El `probe` real: le pregunta a git. 0 = ignorada · 1 = no · cualquier otra cosa = no sé. */
function gitIgnoraProbe(repo) {
  // 🔴 `execFileSync` NO está en el scope del módulo (cada función lo requiere local). Sin esta
  // línea la sonda tiraría ReferenceError adentro del try, devolvería `null` en TODOS los casos, y el
  // preflight diría "no pude preguntarle a git" sin agregar ni avisar nada — un control muerto.
  const { execFileSync } = require('child_process');
  return (rel) => {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
      return true;
    } catch (e) {
      return e && e.status === 1 ? false : null;
    }
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
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

// ── Triggers sobre HUNKS, no archivo completo ──────────
// Evaluar el archivo ENTERO (readDiffContents) en los triggers de contenido haría que:
// silent-failure-hunter disparara en el 100% de los diffs (todo .cs tiene un `try`
// en alguna parte) y el set degenerara en 10-13 advisors → 2-3 tandas seriales
// bajo el cap de máquina (4-5 subagentes). Esto evalúa SOLO las líneas AGREGADAS
// (git diff -U0 HEAD): lo que el dev cambió, que es lo que los advisors auditan.
//
// Fallbacks conservadores (= archivo completo):
//   - archivo UNTRACKED (nuevo): todo el contenido ES agregado → full content.
//   - git falla / repo sin git / archivo tracked SIN diff vs HEAD (p.ej. ya
//     commiteado en un re-run): full content — preferimos un advisor de más a
//     un falso negativo.
// Cache por repo (1 solo spawn de git diff + 1 de ls-files por invocación).
const _addedLinesCache = new Map();
function gitAddedLinesByFile(repo) {
  if (_addedLinesCache.has(repo)) return _addedLinesCache.get(repo);
  const { execFileSync } = require('child_process');
  const result = { byFile: new Map(), untracked: new Set(), gitOk: false };
  try {
    const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', 'HEAD'], {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let current = null;
    for (const line of diff.split('\n')) {
      const fm = line.match(/^\+\+\+ b\/(.+)$/);
      if (fm) { current = fm[1]; if (!result.byFile.has(current)) result.byFile.set(current, []); continue; }
      if (current && line.startsWith('+') && !line.startsWith('+++')) {
        result.byFile.get(current).push(line.slice(1));
      }
    }
    const untracked = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const f of untracked.split('\n').filter(Boolean)) result.untracked.add(f);
    result.gitOk = true;
  } catch { /* sin git → fallback full content para todo */ }
  _addedLinesCache.set(repo, result);
  return result;
}

// Como readDiffContents pero content = SOLO líneas agregadas cuando git lo permite.
function readAddedContents(repo, files, exts) {
  const out = [];
  for (const f of files) {
    if (exts && !exts.some((e) => f.endsWith(e))) continue;
    const abs = path.isAbsolute(f) ? f : path.join(repo, f);
    let rel = path.isAbsolute(f) ? path.relative(repo, f) : f;
    let raiz = repo;
    // Un archivo del repo hermano (fuera de `--repo`) se mira con el git de SU repo. Sin esto quedaría
    // `../Front/…`, no aparecería en el diff de `--repo` y se leería el archivo entero: un `try` viejo del hermano
    // dispararía al cazador de fallos silenciosos como si fuera nuevo.
    if (path.relative(path.resolve(repo), path.resolve(abs)).startsWith('..')) {
      const o = companionLib.ownerOf(f, repo);
      if (o.root) { raiz = o.root; rel = o.rel; }
    }
    const git = gitAddedLinesByFile(raiz);
    if (git.gitOk && !git.untracked.has(rel) && git.byFile.has(rel)) {
      const added = git.byFile.get(rel).join('\n');
      if (added) out.push({ file: f, content: added.slice(0, 200000) });
      continue;
    }
    // untracked / sin git / tracked sin diff → archivo completo (conservador).
    const c = readText(abs);
    if (c) out.push({ file: f, content: c.slice(0, 200000) });
  }
  return out;
}

function anyFileMatches(files, re) {
  return files.some((f) => re.test(f));
}
function anyContentMatches(contents, re) {
  return contents.some((c) => re.test(c.content));
}

// ── gate de PROYECTO (no por-diff): .tycon/advisors.yaml → i18n.required ──────
// A diferencia de los triggers condicionales (que se gatillan por el diff), el
// i18n-hardcoded-text-reviewer se gatilla por una CAPACIDAD declarada del proyecto.
// Parse YAML mínimo sin dependencias: ubica el bloque top-level `i18n:` y, dentro
// de su indentación, busca `required: true`. Generaliza el principio "si el
// proyecto requiere i18n, que no se nos escape de nuevo".
function i18nRequired(repo) {
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return false;
  let inBlock = false;
  let blockIndent = 0;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (/^i18n\s*:/.test(line)) { inBlock = true; blockIndent = indent; }
      continue;
    }
    if (indent <= blockIndent) break; // siguiente key top-level → fin del bloque i18n
    if (/^\s*required\s*:\s*true\b/i.test(line)) return true;
  }
  return false;
}

// ── detección de specs Playwright (para el aviso "E2E sin gate declarado") ──
// Bounded: NO recorre node_modules ni dot-dirs; profundidad acotada (cubre monorepos como
// <repo>/<app>/tests/e2e en monorepos). Corta apenas encuentra config + al menos un spec.
function hasPlaywrightSpecs(repo) {
  let hasConfig = false, hasSpec = false;
  const walk = (dir, depth) => {
    if ((hasConfig && hasSpec) || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hasConfig && hasSpec) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isFile()) {
        if (/^playwright\.config\.[cm]?[jt]s$/.test(e.name)) hasConfig = true;
        // 🔴 `tests/e2e/` Y `e2e/`. Si el patrón exigiera la carpeta `tests/`
        // intermedia, un repo que pone los specs en `<app>/e2e/` quedaría INVISIBLE:
        // `e2eConfig` devolvería `{}` —"este repo no tiene E2E"— en vez del aviso "tenés specs
        // Playwright y NO declaraste el gate". El aviso es el único mecanismo de
        // descubrimiento que tiene un repo para enterarse de que le falta declarar el gate, así
        // que un layout no contemplado no da error: da silencio.
        else if (/\.spec\.ts$/.test(e.name) && /(^|\/)(tests\/)?e2e\//.test(path.join(dir, e.name))) hasSpec = true;
      } else if (e.isDirectory()) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(repo, 0);
  return hasConfig && hasSpec;
}

// ── gate E2E de PROYECTO (agnóstico) — .tycon/advisors.yaml → e2e.{gate,frontend_dir,critical_manifest} ──
// El gate E2E es OWNED por cada proyecto (script + specs + stack viven en SU repo). Los skills
// compartidos (step-07c, tycon-merge-to-main) lo resuelven acá y corren lo que el proyecto declare —
// sin conocer puertos/specs/stack de NINGÚN repo. Sin bloque `e2e:` (o sin `gate:`) → {} → no-op.
// Mismo parser-YAML-mínimo-sin-deps que i18nRequired (los valores son paths, sin espacios → \S+).
// Las llaves que el arnés LEE del bloque `e2e:`. Todo lo demás se avisa:
// si el lector aceptara llaves a CUALQUIER profundidad, un bloque anidado por error
// haría que la lista de pruebas críticas de un formulario se
// aplicara al OTRO, donde ese archivo no existe. Y una llave con el nombre mal escrito no
// produciría ningún error: se ignoraría, y el repo quedaría sin la config que cree tener.
const CLAVES_E2E = new Set([
  'gate', 'frontend_dir', 'frontend_dirs', 'critical_manifest', 'shared_paths', 'preconditions',
  // `bundle` la lee y la USA `e2e-gate.sh` (ver su cabecera y `leer_bundle`): compara la fecha del
  // artefacto que el navegador carga contra las fuentes y, con `rebuild:`, recompila sola. Tiene que estar
  // en esta lista: si no, este validador le diría al dev que su configuración no sirve —y de yapa que
  // moviera las hijas al primer nivel, al revés de lo que el gate parsea—. Quien obedeciera el aviso
  // ROMPERÍA una config correcta. Declarar `bundle` es el escape documentado cuando la autodetección apunta a
  // un archivo equivocado porque el bundle se carga con un `import()` dinámico que
  // ninguna heurística de `<script src>` puede ver.
  'bundle',
]);

// Las llaves que SÍ admiten hijas anidadas, y cuáles. El chequeo de anidamiento existe porque una
// lista de specs críticos colgada de un formulario se aplicaría al otro;
// el chequeo sigue vigente para todo lo demás. Esto no lo afloja: dice cuáles son las excepciones legítimas,
// y sus hijas al primer nivel siguen siendo un error, porque de ahí el gate no las lee.
const HIJAS_E2E = { bundle: new Set(['artifact', 'sources', 'rebuild']) };
const _e2eAvisado = new Set();

function e2eConfig(repo) {
  // Sin gate declarado: distinguir "el repo no tiene E2E" (ok → {}) de "tiene E2E pero se
  // OLVIDARON de declarar el gate" (gap → aviso ruidoso; discoverability).
  // El no-op silencioso ocultaría
  // que un repo con specs Playwright sin bloque `e2e:` NO corre E2E (ni el tier crítico frena).
  const noGate = () => (hasPlaywrightSpecs(repo)
    ? { gap: true, warning: 'El repo tiene specs Playwright (`**/e2e/*.spec.ts` o `**/tests/e2e/*.spec.ts` + playwright.config.*) pero NO declara `e2e.gate` en .tycon/advisors.yaml → el pipeline NO va a correr E2E para este repo (ni el tier crítico frena el merge). Declaralo agregando este bloque: `e2e: { gate: <ruta-a-tu-script-de-gate-relativa-al-repo>, frontend_dir: <dir-con-playwright.config>, critical_manifest: <ruta-a-tu-lista-de-specs-criticos (opcional)> }`. Schema + contrato del gate: tycon-pipeline/SKILL.md sección "Gate E2E del proyecto".' }
    : {});
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return noGate();
  let inBlock = false, blockIndent = 0, juntandoDirs = null;
  // Indentación del PRIMER nivel dentro de `e2e:`. En YAML, una llave sólo pertenece a este
  // bloque si está a ese nivel; más adentro es llave de OTRO objeto, y el arnés no la lee de ahí.
  let nivelHijo = null;
  let padre = null;   // la última llave de primer nivel vista: contra ella se juzgan sus anidadas
  const desconocidas = [];
  const anidadas = [];
  const out = {};
  const dirs = [];
  const shared = [];
  // Un valor del bloque es SIEMPRE un path sin espacios: quedarse con el primer token deja
  // afuera comentarios inline sin necesidad de parsear YAML de verdad (`\S+`).
  const token = (s) => String(s).trim().split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (/^e2e\s*:/.test(line)) { inBlock = true; blockIndent = indent; }
      continue;
    }
    if (indent <= blockIndent) break; // siguiente key top-level → fin del bloque e2e
    // Item de la lista `frontend_dirs:` que venimos juntando. La guarda `juntandoDirs` es la
    // que evita tragarse los items de OTRAS listas del bloque (ej. `preconditions:`).
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (juntandoDirs && item) { const d = token(item[1]); if (d) juntandoDirs.push(d); continue; }
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    juntandoDirs = null;
    const [, key, resto] = kv;
    if (nivelHijo === null) nivelHijo = indent;
    if (indent > nivelHijo) {
      // Llave ANIDADA dentro de otra. Aceptarla sin avisar hace que la lista de specs
      // críticos de un formulario termine aplicándose al otro.
      // Excepción declarada en `HIJAS_E2E`: hay llaves cuyas hijas el gate SÍ lee anidadas
      // (`bundle`). Avisar ahí mandaría al dev a romper una config correcta.
      const permitidas = HIJAS_E2E[padre];
      if (!(permitidas && permitidas.has(key)) && !anidadas.includes(key)) anidadas.push(key);
      continue;
    }
    padre = key;   // desde acá, las hijas anidadas se juzgan contra ESTA llave
    if (!CLAVES_E2E.has(key)) {
      if (!desconocidas.includes(key)) desconocidas.push(key);
      continue;
    }
    // `frontend_dirs:` — un monorepo tiene más de una app con
    // Playwright y declarar UNA sola haría que el gate del merge ejerciera la equivocada
    // sin fallar. Admite lista en bloque, flow style `[a, b]` y un valor suelto.
    if (key === 'frontend_dirs' || key === 'shared_paths') {
      const destino = key === 'frontend_dirs' ? dirs : shared;
      // El comentario inline se pela ANTES de mirar el flow style: si no, `[a, b]  # nota` cierra el
      // corchete DESPUÉS del comentario, el regex no matchea, cae al valor suelto y
      // guarda `[a,` como directorio — un dir basura + el resto de la lista descartado, en
      // silencio.
      const v = resto.replace(/\s+#.*$/, '').trim();
      if (v === '') { juntandoDirs = destino; continue; }
      const flow = v.match(/^\[(.*)\]$/);
      if (flow) { for (const d of flow[1].split(',').map(token).filter(Boolean)) destino.push(d); continue; }
      const d = token(v); if (d) destino.push(d);
      continue;
    }
    if (['gate', 'frontend_dir', 'critical_manifest'].includes(key) && resto.trim()) {
      out[key] = token(resto);
    }
  }
  // ── Avisos de la config ─────────────────────────────────────────────────────────────
  // RUIDOSOS y no bloqueantes: una config mal escrita no da error, da silencio — el repo cree
  // estar configurado y no lo está. Se emite una sola vez por repo y por proceso.
  const avisos = [];
  if (desconocidas.length) {
    avisos.push(
      `⚠ .tycon/advisors.yaml → bloque \`e2e:\`: el arnés NO conoce ${desconocidas.map((k) => `\`${k}\``).join(', ')}. ` +
      `Las llaves que lee son: ${[...CLAVES_E2E].join(', ')}. Una llave desconocida no da error: se ignora, ` +
      'y el repo queda sin la configuración que cree tener.',
    );
  }
  if (anidadas.length) {
    avisos.push(
      `⚠ .tycon/advisors.yaml → bloque \`e2e:\`: ${anidadas.map((k) => `\`${k}\``).join(', ')} ` +
      'está(n) ANIDADA(S) dentro de otra llave y el arnés no las lee de ahí. Movelas al primer ' +
      'nivel del bloque. (Caso real: una lista de specs críticos anidada hizo que las pruebas de ' +
      'un formulario se aplicaran al otro, donde ese archivo no existe.)',
    );
  }
  if (avisos.length && !_e2eAvisado.has(repo)) {
    _e2eAvisado.add(repo);
    for (const a of avisos) process.stderr.write(`${a}\n`);
  }

  // Lista efectiva de apps: la plural manda; el escalar de siempre se normaliza a una de uno,
  // así ningún consumidor tiene que saber cuál de las dos formas usó el repo.
  const dirsDeclarados = dirs.length ? dirs : (out.frontend_dir ? [out.frontend_dir] : []);
  // Gate por DEFAULT del harness: si el repo declara el bloque `e2e:` con su
  // frontend_dir pero NO un `gate:` propio, se usa el gate genérico del harness. Si cada
  // repo tuviera su copia del script, el CONTRATO de la evidencia se desincronizaría solo
  // (un repo escribiría "## Tests corridos" y otro no → DODRT-C8 lo bloquearía por un
  // detalle del script, no por su calidad). El `gate:` propio sigue valiendo como escape.
  if (!out.gate && dirsDeclarados.length) {
    out.gate = path.join(__dirname, 'e2e-gate.sh');
    out.gate_source = 'harness (default)';
  }
  if (!out.gate) return noGate();
  const resolve = (p) => (p ? (path.isAbsolute(p) ? p : path.join(repo, p)) : null);
  const efectivos = dirsDeclarados.length ? dirsDeclarados : ['.'];
  const cfg = {
    repo: path.resolve(repo),
    gate: resolve(out.gate),
    // Se mantiene el escalar para los consumidores que ya lo leen: es la PRIMERA de la lista.
    frontend_dir: resolve(efectivos[0]),
    frontend_dirs: efectivos.map(resolve),
    // Repo-relativos a propósito (se comparan contra paths repo-relativos en selectE2eApps).
    shared_paths: shared.slice(),
    critical_manifest: out.critical_manifest ? resolve(out.critical_manifest) : null,
    config_warnings: avisos,
  };
  // Parsear el manifest crítico EN JS (determinístico) — el merge skill consume el array,
  // NO un grep de shell (el `\s` de grep BSD/macOS no matchea whitespace).
  // Strip de comentarios (línea entera o inline `#...`) + whitespace; líneas vacías fuera.
  if (cfg.critical_manifest) {
    const mtxt = readText(cfg.critical_manifest);
    cfg.critical_specs = mtxt
      ? mtxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
      : [];
  }
  return cfg;
}

// ── qué apps del monorepo ejerce esta entrega ───────
//
// El agujero que cierra: en un monorepo con 4 apps, un gate que corra SIEMPRE la única
// declarada ejerce los E2E de esa app al mergear un cambio de otra:
// no falla, ejerce otra cosa. Un control que mira la app equivocada es
// indistinguible de un control que anda, y por eso es peor que no tenerlo.
//
// `changedFiles` son paths RELATIVOS al repo (lo que devuelve `git diff --name-only`).
// Fail-safe deliberado: sin lista de cambios (no se pudo computar el rango del merge) se
// devuelven TODAS. Errar por correr de más es perder minutos; errar por correr de menos es
// exactamente el bug que esto viene a arreglar.
function selectE2eApps(cfg, changedFiles) {
  const todas = (cfg && Array.isArray(cfg.frontend_dirs) && cfg.frontend_dirs.length)
    ? cfg.frontend_dirs
    : (cfg && cfg.frontend_dir ? [cfg.frontend_dir] : []);
  if (!todas.length) return [];
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return todas.slice();

  const raiz = (cfg && cfg.repo) ? cfg.repo : null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  // 🔴 NORMALIZACIÓN DE ENTRADA. Comparar los paths de
  // `changedFiles` TAL CUAL contra el path relativo de cada app sólo funcionaría con
  // entradas repo-relativas. Con paths ABSOLUTOS no matchearía NADA y devolvería `[]` — y el
  // consumidor no lo rescata, porque en JS `[] || fallback` devuelve `[]` (un array vacío es
  // truthy): el loop del gate iteraría CERO veces y saldría 0. O sea: el control diría verde
  // habiendo ejercido nada, la clase de bug que esta función existe para evitar.
  //
  // Y no es un caso teórico: `step-07c` documenta `marker.filesTouched` como fuente válida de
  // `--changed`, y esos paths son ABSOLUTOS por construcción (`on-edit.js` descarta los que no
  // lo son antes de guardarlos).
  //
  // También se contempla el caso "relativo a un ancestro del repo" (`FrontEnd/mi-app/…`,
  // que es lo que devuelve `git diff` cuando la raíz git está por ENCIMA de `--repo`), y el
  // entrecomillado con escapes octales de `git diff --name-only` (core.quotePath viene ON por
  // default: un path con acentos llega como `"mi-app/src/p\303\241gina.tsx"`).
  const desescapar = (p) => {
    let s = String(p);
    if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
      s = s.slice(1, -1)
        .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(["\\])/g, '$1');
      // Los octales de git son bytes UTF-8: re-decodificarlos como tal.
      try { s = Buffer.from(s, 'latin1').toString('utf8'); } catch { /* se deja como está */ }
    }
    return s;
  };
  // 🔴 Symlinks: en macOS `/tmp` es un symlink a `/private/tmp` y el
  // TMPDIR real vive bajo `/var/folders`. Si `--repo` y los paths de `--changed` vienen resueltos
  // DISTINTO, `path.relative` los ve fuera del repo y se descartan. Lo peligroso es el caso
  // PARCIAL: el fail-safe de "no sé → todas" sólo dispara si fallan TODOS, así que con uno solo
  // mal resuelto se pierde esa app en silencio. Se resuelven los dos lados, igual que ya hace
  // `mutation-check.js`. Un path inexistente (archivo borrado en el diff) no puede resolverse:
  // se cae al ancestro más cercano que sí exista y se le vuelve a pegar la cola.
  const realSafe = (p) => {
    try { return fs.realpathSync(p); } catch { /* no existe: probar por el directorio */ }
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
  };
  const raizReal = raiz ? realSafe(raiz) : null;

  const aRepoRelativo = (p) => {
    const s = norm(desescapar(p));
    if (!s) return null;
    if (!raiz) return s;
    if (path.isAbsolute(s)) {
      let rel = norm(path.relative(raiz, s));
      // Si con los paths tal cual quedó "fuera", reintentar con ambos lados resueltos.
      if (rel.startsWith('../') && raizReal) rel = norm(path.relative(raizReal, realSafe(s)));
      // Fuera del repo (scratchpad, otro repo) → no puede seleccionar ninguna app de ESTE.
      return (rel && !rel.startsWith('../')) ? rel : null;
    }
    // Relativo que se ESCAPA del repo (`../otro/x.ts`): tampoco puede seleccionar una app acá.
    if (s === '..' || s.startsWith('../')) return null;
    // Relativo a un ancestro: `<basename del repo>/resto` → `resto`.
    const base = norm(path.basename(raiz));
    if (base && (s === base || s.startsWith(base + '/'))) return norm(s.slice(base.length + 1)) || null;
    return s;
  };
  const tocados = changedFiles.map(aRepoRelativo).filter(Boolean);

  // Si NADA de lo que llegó cae dentro del repo, no se puede decidir qué apps ejercer. Eso NO
  // es "ninguna app tocada": es "no sé". Se cae al mismo fail-safe que la lista vacía —correr
  // todas— porque correr de más cuesta minutos y correr de menos es el bug de arriba.
  if (!tocados.length) return todas.slice();

  // Rutas de código COMPARTIDO entre apps (`e2e.shared_paths`). Un cambio ahí involucra a
  // TODAS, no sólo a la app en cuyo directorio vive el archivo. Esto no es teórico:
  // casi todo el código común puede vivir DENTRO de una app y las otras lo importan
  // (por eso existe el gate `docs/cross-form-imports-gate.sh`), así que sin esto un cambio en
  // una app dejaría a las otras sin ejercer.
  const compartidos = (cfg && Array.isArray(cfg.shared_paths) ? cfg.shared_paths : []).map(norm).filter(Boolean);

  // 🔴 La config del PROPIO control es compartida SIEMPRE. Un
  // commit que da de alta el tier crítico en un frontend y sólo toca `.tycon/advisors.yaml` + el manifest
  // no cae bajo ninguna app ni bajo `shared_paths`, así que esto devolvería `[]` ("0 apps tocadas") — y NO es
  // el fail-safe de arriba, porque sí hay archivos tocados; simplemente ninguna declaración
  // los cubre. Es la MISMA clase de bug que motiva `shared_paths`, un nivel más arriba:
  // en la config del control en vez de en código de producto. Una edición que rompa el
  // manifest (path mal escrito, substring que deja de matchear, puerto equivocado en una
  // precondition) se mergearía sin que el tier la detecte. Se trata como compartido sin
  // depender de que cada repo se acuerde de declararlo: la declaración manual es justo lo que
  // falla. Test: `GateMerge_LaConfigDelControlEsCompartida`.
  //
  // 🔴 PREFIJOS, no rutas exactas. Una lista como `['.tycon/advisors.yaml']`
  // + el manifest declarado obligaría a ACORDARSE de agregar cada archivo de config
  // nuevo — ése es el modo de falla de depender de una declaración manual, un nivel más
  // abajo. Con `.tycon` entero como prefijo, una precondición, un manifest nuevo o cualquier
  // config futura entran solas.
  //
  // Y se suma el SCRIPT DEL GATE que declara el repo (`e2e.gate`): sin él, un commit
  // que MODIFICA el ejecutor de las pruebas no seleccionaría ninguna app y saldría "ninguna de las
  // apps declaradas fue tocada" — se podría romper el runner de E2E sin que corra un solo E2E.
  // Con `frontend_dir: .` todo selecciona la app, así que ahí no hace falta.
  // Sólo cuenta si el gate vive DENTRO del repo — el gate por default del harness vive en el
  // skill y `path.relative` lo deja afuera, que es lo correcto: no es código de este repo.
  const propios = ['.tycon'];
  const relAlRepo = (p) => {
    const m = norm(p);
    const rel = path.isAbsolute(m) && raiz ? norm(path.relative(raiz, m)) : m;
    return (rel && !rel.startsWith('../')) ? rel : null;
  };
  for (const p of [cfg && cfg.critical_manifest, cfg && cfg.gate]) {
    if (!p) continue;
    const rel = relAlRepo(p);
    if (rel && !propios.includes(rel)) propios.push(rel);
  }
  if ([...compartidos, ...propios].some((sp) => tocados.some((f) => f === sp || f.startsWith(sp + '/')))) {
    return todas.slice();
  }

  return todas.filter((abs) => {
    const rel = raiz ? norm(path.relative(raiz, abs)) : norm(path.basename(abs));
    // App en la raíz del repo (`frontend_dir: .`): cualquier cambio la involucra.
    if (rel === '' || rel === '.') return true;
    return tocados.some((f) => f === rel || f.startsWith(rel + '/'));
  });
}

// ── detección de stack ───────────────────────────────────────────────────────
// Multi-root aware: leer sólo el package.json en la
// raíz de --repo daría un falso negativo SILENCIOSO en workspaces contenedores (sin
// package.json raíz, con los reales en subcarpetas) — react-conventions y el trigger React de
// feature-wiring se perderían. Por eso: por cada archivo modificado se busca el
// package.json ancestro más cercano (bounded al repo) y se mergean las deps;
// fallback adicional: subdirectorios de primer nivel del repo.
// Las secciones de un package.json que declaran dependencias. Un formulario de Bizuit declara React SÓLO en
// peerDependencies (lo provee el host): leer sólo dependencies y devDependencies daría hasReact:false y
// el revisor de React no entraría.
// Una sola lista para la detección y para dependenciaCambiada.
const SECCIONES_DE_DEPENDENCIAS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
// `sinPeerOptativos`: para DETECTAR el stack, un peer marcado optativo (`peerDependenciesMeta.<x>.optional`) no cuenta —
// una librería que se lleva bien con Next si el host lo tiene no es una app Next. Para dependenciaCambiada sí cuenta.
function depsDelPaquete(pkg, { sinPeerOptativos = false } = {}) {
  const out = {};
  for (const k of SECCIONES_DE_DEPENDENCIAS) Object.assign(out, (pkg && pkg[k]) || {});
  const meta = (pkg && pkg.peerDependenciesMeta) || {};
  if (sinPeerOptativos) {
    for (const [nombre, m] of Object.entries(meta)) {
      const enOtraSeccion = ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => pkg[k] && pkg[k][nombre]);
      if (m && m.optional === true && !enOtraSeccion) delete out[nombre];
    }
  }
  return out;
}
function collectPackageDeps(repo, files) {
  const deps = {};
  const seen = new Set();
  const leidos = [];   // los package.json que existían y se pudieron leer: el aviso de detectStack los nombra
  const mergeFrom = (pkgPath) => {
    if (seen.has(pkgPath)) return;
    seen.add(pkgPath);
    const pkg = readJson(pkgPath);
    if (pkg) { Object.assign(deps, depsDelPaquete(pkg, { sinPeerOptativos: true })); leidos.push(pkgPath); }
  };
  mergeFrom(path.join(repo, 'package.json'));
  const repoNorm = path.resolve(repo);
  const fueraDeGit = [];
  for (const f of files) {
    if (!/\.(tsx|ts|jsx|js)$/i.test(f)) continue;
    let dir = path.resolve(path.dirname(path.isAbsolute(f) ? f : path.join(repo, f)));
    // Walk-up acotado: no salir del repo, no pasar por node_modules.
    // Un archivo del repo hermano (fuera de `--repo`) sube hasta la raíz git de SU repo. Con el tope
    // siempre en `--repo`, su package.json no se leería nunca: «detección React/Next ciega» y, con ella, afuera
    // los revisores de React y de cableado.
    let tope = repoNorm;
    if (!dir.startsWith(repoNorm)) {
      const raizDelArchivo = companionLib.gitRootOf(dir);
      // Fuera de todo repo git no hay tope seguro para subir: no se busca, pero se DICE (detectStack lo pone en el aviso).
      if (!raizDelArchivo) { fueraDeGit.push(f); continue; }
      tope = raizDelArchivo;
      dir = companionLib.real(dir);   // ruta real también si la carpeta ya no existe (archivo borrado)
    }
    for (let depth = 0; depth < 12; depth++) {
      if (!path.resolve(dir).startsWith(tope)) break;
      if (path.basename(dir) !== 'node_modules') mergeFrom(path.join(dir, 'package.json'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Último fallback: subdirs de primer nivel (workspace contenedor sin files JS en el diff).
  if (Object.keys(deps).length === 0) {
    try {
      for (const sub of fs.readdirSync(repo)) {
        if (sub === 'node_modules' || sub.startsWith('.')) continue;
        mergeFrom(path.join(repo, sub, 'package.json'));
      }
    } catch { /* ignore */ }
  }
  // «Encontrado» es «se leyó alguno», aunque no traiga dependencias: pedir además alguna dependencia daría, con un
  // package.json sin ellas, el aviso falso «sin package.json encontrado».
  return { deps, packagesFound: leidos.length > 0, fueraDeGit, leidos };
}

// ── ¿el diff de un package.json toca una DEPENDENCIA? ────────────────────
// Medido en un frontend, 6 meses: 730 commits, 115 tocan `package.json` (16% — meter el set base
// ahí sería caro), pero sólo 8 cambian una línea de dependencia (7% de esos) y sólo 3 tocan
// react/next. O sea ~1% de los commits, con 1 revisor extra. Un bump de versión de script o un
// cambio de `"scripts"` NO cuenta.
//
// Se compara el MAPA de dependencias (nombre→versión) de lo commiteado contra el de la carpeta, en
// vez de caminar el diff: con `-U0` no hay contexto, así que una línea `+  "react": "18.3.0"` es
// indistinguible de una entrada de `"scripts"`. Comparar los objetos parseados dice exactamente lo
// que la regla quiere saber.
// Las cuatro secciones cuentan. peerDependencies cuenta a propósito: en un formulario de
// Bizuit el rango peer de react ES el React que tiene que poner el host, y cambiarlo cambia ese contrato — lo que mira
// REACT-W14 (peer desalineado). optionalDependencies se suma: se instalan cuando se puede, así que un cambio ahí cambia lo
// que corre igual que uno en dependencies.
function dependenciaCambiada(repo, files) {
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(String(f).replace(/\\/g, '/')));
  if (!pkgs.length) return false;
  const { execFileSync } = require('child_process');
  const mapa = depsDelPaquete;
  for (const f of pkgs) {
    const rel = path.isAbsolute(f) ? path.relative(repo, f) : f;
    const abs = path.isAbsolute(f) ? f : path.join(repo, f);
    let antes = null;
    try {
      antes = JSON.parse(execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      }));
    } catch (_e) {
      return true;   // package.json nuevo o sin historia: fail-safe hacia CORRER el revisor
    }
    const ahora = readJson(abs);
    if (!ahora) return true;
    const a = mapa(antes); const b = mapa(ahora);
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of claves) if (a[k] !== b[k]) return true;
  }
  return false;
}

function detectStack(repo, files) {
  const { deps, packagesFound, fueraDeGit, leidos } = collectPackageDeps(repo, files);
  const csModified = anyFileMatches(files, /\.(cs|csproj)$/i);
  const tsxModified = anyFileMatches(files, /\.(tsx|ts|jsx|js)$/i);
  // Un guion `.sh` es código. Los de CI despliegan y frenan en
  // producción, y un diff de sólo `.sh` saldría `onlyDocs`: cero revisores de código. Medido sobre
  // 296 corridas: 42 tocaron un `.sh`, 4 sólo `.sh`.
  const shModified = anyFileMatches(files, /\.sh$/); // minúsculas, como `matchGlob` en la tabla del re-loop
  // Python, Svelte, Vue y cualquier archivo fuente de lib/code-files.js (con lo que sume la organización) también son
  // código: un diff de sólo `.py` o sólo `.svelte` lleva los revisores del núcleo, no sale `onlyDocs`.
  const extraOrg = stackConfig.orgExtra();
  const pyModified = anyFileMatches(files, /\.py$/i);
  const svelteModified = anyFileMatches(files, /\.svelte$/i);
  const vueModified = anyFileMatches(files, /\.vue$/i);
  const sourceModified = files.some((f) => codeFiles.isSource(f, { extra: extraOrg }));
  const codeModified = csModified || tsxModified || shModified || sourceModified;
  // La superficie de CONFIG. El arnés publica una tabla que dice vigilar
  // `plugin.json`, los `appsettings*.json` y los `.env`; sin esto, su propia selección no los podría
  // entregar nunca: un diff de sólo config se clasificaría `onlyDocs` y el set quedaría vacío. O sea
  // que reglas escritas sobre secretos, cadenas de conexión y settings faltantes existirían,
  // documentadas, y no podrían dispararse por su propio objeto.
  const norm = (f) => String(f).replace(/\\/g, '/');
  const pluginCfgModified = files.some((f) => /(^|\/)plugin\.json(\.example)?$/i.test(norm(f)));
  // `appsettings.Development.json` queda AFUERA a propósito: hay repos que lo regeneran en cada
  // build local, y un disparador que se activa solo entrena a ignorarlo.
  const secretCfgModified = files.some((f) => {
    const n = norm(f);
    if (/(^|\/)appsettings\.Development\.json$/i.test(n)) return false;
    return /(^|\/)appsettings(\.[\w-]+)?\.json$/i.test(n) || /(^|\/)\.env(\.[\w-]+)?$/i.test(n);
  });
  const det = {
    hasNext: !!deps.next,
    hasReact: !!deps.react,
    csModified,
    tsxModified,
    shModified,
    pyModified,
    svelteModified,
    vueModified,
    sourceModified,
    codeModified,
    pluginCfgModified,
    secretCfgModified,
    depChanged: dependenciaCambiada(repo, files),
    onlyDocs: !codeModified,
  };
  // Warning explícito para el anuncio pre-flight del orquestador (regla B):
  // si hay JS/TS en el diff pero no se encontró NINGÚN package.json, la
  // detección de framework es ciega — que se vea, no que falle en silencio.
  if (tsxModified && !packagesFound) {
    det.warning = 'sin package.json encontrado (ni en raíz, ni ancestros de los files, ni subdirs) — detección React/Next ciega; verificá --repo';
  }
  // Con algún package.json leído y un .tsx/.jsx en el diff, que no aparezca ningún framework no puede pasar
  // callado: así el revisor de React quedaría afuera sin que nadie lo vea. Sólo .tsx/.jsx: un .ts de un backend
  // de Node no tiene por qué traer React.
  if (packagesFound && !det.hasReact && !det.hasNext && anyFileMatches(files, /\.(tsx|jsx)$/i)) {
    const nota = `hay .tsx/.jsx y no detecté React ni Next en ${leidos.slice(0, 4).join(', ')}${leidos.length > 4 ? ', …' : ''} (se leen dependencies, devDependencies, peerDependencies y optionalDependencies)`;
    det.warning = det.warning ? `${det.warning} · ${nota}` : nota;
  }
  // Un archivo JS/TS fuera de `--repo` y de todo repo git no tiene package.json que buscar. Se dice.
  if (fueraDeGit.length) {
    const nota = `${fueraDeGit.length} archivo(s) JS/TS fuera de --repo y de todo repo git (${fueraDeGit.slice(0, 3).join(', ')}${fueraDeGit.length > 3 ? ', …' : ''}): su package.json no se buscó`;
    det.warning = det.warning ? `${det.warning} · ${nota}` : nota;
  }
  return det;
}

// Las banderas que produce detectStack, publicadas para el vocabulario `detection` de
// los manifiestos de paquetes (lib/packs.js): una bandera que no está acá invalida el manifiesto,
// nunca se evalúa como falso. tests/packs.test.js verifica que coincidan con las claves reales.
// Viven en lib/packs.js: el instalador valida la capa del equipo con ese módulo solo, sin cargar
// este archivo; una sola fuente.
const BANDERAS_DETECCION = require('./lib/packs.js').BANDERAS;

// ── set BASE (matriz top-down de step-05) ─────────────────────────────────────
// `extras`: los revisores del grupo `base` de los paquetes activos cuya condición se cumplió.
// Van PRIMERO — el orden
// no es contrato (check-count y el marker comparan conjuntos).
function computeBase(det, extras = []) {
  const TC = 'tycon-plugin-tests-coverage';
  const SB = 'tycon-plugin-security-basics';

  // Sin archivos fuente: docs, config y/o guiones. (No se usa `det.onlyDocs`: con un
  // `.sh` contando como código, un guion junto a un `plugin.json` dejaría de entrar acá y la
  // config perdería a su revisor en silencio.)
  if (!det.csModified && !det.tsxModified && !det.sourceModified) {
    // 🔴 No es un `[]` a secas. Un diff sin código puede seguir
    // siendo puro docs —y ahí sí va vacío—, pero si tocó la superficie de CONFIG hay reglas
    // escritas sobre ella que no podrían dispararse por su propio objeto.
    // **UN revisor por tipo, no el set base**: el objetivo es hacer verdadera una declaración que
    // el arnés ya publica, no encarecer los commits de config. Los de convenciones (config de
    // plugin → .NET, DOTNET-C6/W7/W10; dependencia nueva → React/Next, REACT-W14) vienen en
    // `extras`: su condición vive en el manifiesto del paquete bizuit.
    const cfg = [...extras];
    if (det.secretCfgModified) cfg.push(SB);       // SEC-C2/C8/C9 — secretos, cadenas de conexión, fallbacks silenciosos
    // PIPE-DETECT: guiones `.sh` → UN revisor (seguridad), SUMADO a la config, nunca en su lugar.
    if (det.shModified) cfg.push(SB);
    return [...new Set(cfg)];
  }

  // Con código fuente (.cs, JS/TS, Python, Svelte, Vue…): las convenciones del stack las traen los paquetes; pruebas y
  // seguridad son del núcleo y NUNCA faltan (sin paquetes, un diff .cs sigue
  // teniendo revisor de pruebas y de seguridad).
  return [...new Set([...extras, TC, SB])];
}

// ── set COMPLETITUD (Mary+GOLD) ───────────────────────────────────────────────
function computeCompletitud(storyPath, repo, files) {
  const out = [];
  const story = storyPath ? readText(storyPath) : '';
  const sc = require('./lib/story-checks.js');
  const isGold = sc.storySection(story, 'criteria') !== null || sc.storySection(story, 'tests') !== null;

  // story-validator post-impl + spec-first SIEMPRE en Mary+GOLD (ver step-05)
  if (story) {
    out.push('tycon-story-validator');
    out.push('tycon-spec-first-checker');
  }
  // ac-coverage si hay tabla de pruebas o sección de criterios. Y falla cerrada: una story sin criterios
  // detectados lo lleva siempre — sin él, el control de criterios queda «ambiguo» y nadie lo resuelve.
  if (isGold || (story && !sc.criteriaOf(story).acs.length)) out.push('tycon-ac-coverage-checker');

  // deferral-tracker si la story tiene bloque `pipelines:` O el diff AGREGÓ *.skip()
  // (líneas agregadas, no archivo completo — un skip pre-existente no es deuda nueva).
  const hasPipelines = /^pipelines:/m.test(story);
  const testFiles = files.filter((f) => codeFiles.isTestFile(f));
  const skipContents = readAddedContents(repo, testFiles);
  const hasSkips = skipContents.some((c) => codeFiles.hasSkipMark(c.content, c.file));
  if (hasPipelines || hasSkips) out.push('tycon-deferral-tracker');

  return out;
}

// ── set CONDICIONAL (additive por triggers de file/contenido) ─────────────────
// Los triggers de CONTENIDO evalúan las líneas AGREGADAS del diff
// — un `try` pre-existente en el archivo no justifica re-auditar
// silent failures de código que el dev no tocó. Los triggers de PATH no cambian.
function computeConditional(repo, files, extras = []) {
  const out = [];
  const csFiles = files.filter((f) => /\.cs$/i.test(f));
  const csContents = readAddedContents(repo, csFiles, ['.cs']);
  // Svelte y Vue llevan JavaScript adentro; el resto de los archivos fuente (Python, Go, Java…) se mira con
  // las palabras de manejo de errores de su lenguaje.
  // `.mjs`/`.cjs`/`.mts`/`.cts` también: la superficie de este revisor ya los cubre y un `catch` mudo ahí es lo mismo.
  const jsTsContents = readAddedContents(repo, files, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.svelte', '.vue']);
  const extraOrg = stackConfig.orgExtra();
  // Los fuentes que no son .cs ni de la familia JS/TS (Python, Go, Java… y las extensiones de la organización).
  const esOtroFuente = (f) => codeFiles.isSource(f, { extra: extraOrg }) && !/\.(cs|[cm]?[jt]sx?|svelte|vue)$/i.test(f);
  const otherSrcFiles = files.filter(esOtroFuente);
  const otherSrcContents = readAddedContents(repo, otherSrcFiles);

  // (los revisores de un stack —.NET y BIZUIT, Next.js + Postgres— y los de clientes viven en sus paquetes: entran por `extras`)

  // e2e-realness: cualquier spec Playwright en el diff (stack-agnostic).
  // 🔴 Este advisor no puede omitirse: caza los E2E falsos-verdes.
  if (anyFileMatches(files, /(^|\/)tests\/e2e\/.*\.spec\.ts$/)) {
    out.push('tycon-e2e-realness-checker');
  }

  // silent-failure-hunter: stack-agnostic. Trigger sobre .cs/.ts/.tsx que contengan
  // keywords típicos de error handling. Si el diff toca código pero sin esos keywords,
  // no aplica (no hay nada que hunt). Inspirado en ECC silent-failure-hunter,
  // adaptado al stack TYCON (.NET / TS / React / Next.js).
  if (anyContentMatches(csContents, /\b(try|catch|async|Task\.Run|BackgroundService|EnsureSuccess|JSON\.parse|throw new)/) ||
      anyContentMatches(jsTsContents, /\b(try|catch|async|await|\.catch\(|JSON\.parse|throw new)/) ||
      anyContentMatches(otherSrcContents, /\b(try|catch|except|raise|async|await|throw|rescue|recover|panic)\b|\bif err != nil\b/) ||
      // PIPE-DETECT: en un guion no hay palabra clave que filtre — casi todo es «tragar un error»
      // (`|| true`, `2>/dev/null`, `set -e` ausente). Alcanza con que haya un `.sh` de producción;
      // la misma exclusión de pruebas que usa el re-loop (ADVISOR_AUDITED_SURFACE).
      files.some((f) => /\.sh$/.test(f) && advisorAffectedByDelta('tycon-silent-failure-hunter', [f]).affected)) {
    out.push('tycon-silent-failure-hunter');
  }

  // ── LLM ──
  if (anyContentMatches(jsTsContents, /@anthropic-ai\/sdk|voyageai|['"]openai['"]|cohere-ai|@openrouter\/sdk/) ||
      anyFileMatches(files, /(^|\/)src\/lib\/(llm|embeddings)\//) ||
      anyFileMatches(files, /(^|\/)src\/matcher\//)) {
    out.push('llm-cost-reviewer');
  }

  // ── i18n (PROJECT-gated, stack-agnostic) ──
  // Único advisor gatillado por capacidad del proyecto (.tycon/advisors.yaml →
  // i18n.required: true), no por el diff. Requiere además que el diff toque código
  // con texto visible posible. El advisor scopea al diff y devuelve OK si no hay
  // texto nuevo hardcodeado. Es ratchet de "no deuda nueva", no sweep del backlog.
  if (i18nRequired(repo) &&
      (anyFileMatches(files, /\.(tsx|ts|jsx|js)$/) || anyFileMatches(files, /\.cs$/i)
        || files.some((f) => /\.(svelte|vue)$/i.test(f) || (esOtroFuente(f) && !codeFiles.isTestFile(f))))) {
    out.push('i18n-hardcoded-text-reviewer');
  }

  // Los condicionales de los paquetes activos (hermanos, el adaptador de un cliente…) entran al final, con la
  // condición que declara su manifiesto.
  out.push(...extras);

  return out;
}

function unique(arr) {
  return [...new Set(arr)];
}

function computeAdvisorSet({ repo, story, files }) {
  const det = detectStack(repo, files);
  const activos = paquetesActivos(repo);              // PackError si un paquete está roto o falta
  const ctx = contextoCondicion(repo, files, det);
  const base = computeBase(det, revisoresDePaquetes(activos, 'base', ctx));
  const completitud = computeCompletitud(story, repo, files);
  const conditional = computeConditional(repo, files, revisoresDePaquetes(activos, 'condicional', ctx));
  const all = unique([...base, ...completitud, ...conditional]);
  const storyText = story ? readText(story) : '';
  const sinCriterios = storyText ? require('./lib/story-checks.js').criteriaOf(storyText) : null;
  return {
    base, completitud, conditional, all, required_count: all.length, detection: det,
    // por qué entró un revisor de completitud que la forma de la story no pedía (falla cerrada)
    completitud_motivos: sinCriterios && !sinCriterios.acs.length
      ? [`sin criterios detectados (${sinCriterios.reason}): entra el revisor de cobertura de criterios`] : [],
    // una terminación mal escrita en `stack.code_extensions` no se usa; que se vea en el anuncio del set
    // (casos: tests/code-files.test.js)
    stack_problems: stackConfig.codeExtensions().problems,
    // Que se vea en la primera corrida con qué paquetes se eligió el set, no al mes.
    // `packs_declarados`: null = el repo no restringe (activos todos los instalados); [] o lista = lo
    // que el repo fijó en `packs:` — así «restringido a ninguno» no se confunde con «ninguno instalado».
    packs: resumenPaquetes(activos), packs_dir: packsLib.dirPaquetes(),
    packs_declarados: packsLib.declaracionDelRepo(repo).declarados,
    // Sin paquetes activos, POR QUÉ (ninguno instalado ≠ ninguno activo); con activos, null
    packs_nota: packsLib.notaDePaquetes({ repo, instalados: paquetesInstalados(), activos }),
    story_path_para: necesitanStory(activos),
  };
}

// ── Los revisores del núcleo, declarados ──
// Las condiciones de arriba son código; esta tabla las dice como datos, para mostrarlas («Cómo trabaja», en el sitio de la
// organización). Una fila por revisor: el grupo (`always`: siempre que hay código · `story`: según la historia · `change`:
// según lo que toca el cambio), la clave del texto de «cuándo» (los textos viven en scripts/site/texts.js) y un caso
// que lo hace entrar: archivos con su contenido, una historia y, si hace falta, el `.tycon/advisors.yaml` del repo.
// `coreReviewersDrift` corre cada caso por `computeAdvisorSet` y frena si la tabla y el cálculo se separan.
const STORY_GOLD = '---\nstory: "9.9"\n---\n\n## Acceptance Criteria\n\n1. algo\n\n### Tests\n\n| # | Nombre | AC |\n|---|---|---|\n| T1 | `Algo` | 1 |\n';
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

// ── Smart re-loop advisors (refinement de regla D.i) ──
//
// Cuando iter N>1 del Step 5 corre (fix-loop post-HITL), regla D.i.1 obliga el set
// completo de iter 1 (no cherry-pick). Pero si los fixes son no-impl (specs, tests
// añadidos, docs), muchos advisors no tienen surface nueva que evaluar y devuelven
// reportes idénticos. El smart-reloop computa el delta de files iter N vs iter N-1 (snapshot
// en marker.iterations[N-1]) y skipea advisors cuya audited_surface no se tocó.
//
// Cada advisor declara su surface acá. `always: true` = re-correr siempre (frontmatter
// audit / spec compare / coverage count). `paths` = globs include. `excludePaths` =
// globs que se descartan (típicamente `**/tests/**` para advisors de prod code).
//
// Trade-off: si el mapping mal computa, un advisor con regresión silenciosa no se
// atrapa. Mitigación: log explícito + `--force-full-reloop` para override manual.
// Los archivos fuente que no son .cs ni JS/TS (Python, Svelte, Vue, Go…) y las pruebas de pytest y Go.
// Con las extensiones de la organización: un arreglo en un `.ex` también es superficie tocada en el re-loop.
const SOURCE_GLOBS = [...codeFiles.SOURCE_EXTS, ...stackConfig.orgExtra()]
  .filter((e) => !['.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e))
  .map((e) => `**/*${e}`);
const TEST_GLOBS_8_48 = ['**/test_*.py', '**/*_test.py', '**/*_test.go'];
const ADVISOR_AUDITED_SURFACE = {
  // ── Set base ── (los de convenciones por stack viven en packs/: su
  // `surface` está en el manifiesto y la lee superficieDe())
  // `.js`/`.mjs`/`.cjs`: el arnés MISMO es JavaScript sin transpilar (scripts/,
  // hooks, el tablero). Sin ellos, un re-loop cuyo fix vive en un `.js` saltearía a este advisor
  // por «superficie no tocada», aunque el hallazgo del cazador de fallos silenciosos
  // se arreglara justamente en un `.js`.
  // Más los archivos fuente de Python, Svelte, Vue y los demás lenguajes de lib/code-files.js.
  'tycon-plugin-security-basics': { paths: ['**/*.cs', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.sh', ...SOURCE_GLOBS, '**/appsettings*.json', '**/.env*'] },
  'tycon-plugin-tests-coverage': { always: true }, // recuento de tests + coverage cambia con cualquier test edit

  // ── Set completitud (Mary+GOLD) ──
  // Todos always: frontmatter / spec body / pipelines / tests table evolucionan con cada iter.
  'tycon-story-validator': { always: true },
  'tycon-spec-first-checker': { always: true },
  'tycon-ac-coverage-checker': { always: true },
  'tycon-deferral-tracker': { always: true },

  // ── Set condicional ──
  // silent-failure-hunter: solo auditá si código prod cambió. Tests añadidos NO afectan
  // (los specs no son superficie para silent failures en prod).
  'tycon-silent-failure-hunter': {
    // `.js`/`.mjs`/`.cjs`: ver el comentario de security-basics — el arnés es JavaScript, y un
    // `catch` mudo en un `.js` es exactamente lo que este advisor existe para cazar.
    paths: ['**/*.cs', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.sh', ...SOURCE_GLOBS],
    excludePaths: ['**/tests/**', '**/Tests/**', '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.sh', '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/__tests__/**', ...TEST_GLOBS_8_48],
  },
  // e2e-realness: solo specs Playwright.
  'tycon-e2e-realness-checker': { paths: ['**/tests/e2e/**/*.spec.ts', '**/tests/e2e/**/*.spec.tsx'] },

  // (los revisores de un stack declaran su `surface` en el manifiesto de su paquete: la lee superficieDe())
  // llm-cost: sin '**/*.ts' genérico — cualquier .ts del repo
  // NO es superficie de costo LLM; los paths específicos + el trigger por contenido
  // (@anthropic-ai/sdk etc.) cubren el caso real.
  'llm-cost-reviewer': { paths: ['**/lib/llm/**', '**/lib/embeddings/**', '**/matcher/**'] },
  // i18n: texto visible en código FE/BE. Excluye tests/stories (no son UI prod).
  'i18n-hardcoded-text-reviewer': {
    paths: ['**/*.tsx', '**/*.ts', '**/*.jsx', '**/*.js', '**/*.cs', ...SOURCE_GLOBS],
    excludePaths: ['**/tests/**', '**/Tests/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/__tests__/**', '**/*.stories.tsx', ...TEST_GLOBS_8_48],
  },
};

// ── Model tier hints (opt-in via --cost-tier lean) ─────
//
// Patrón Anthropic "executor + advisor on-demand": el executor barato corre la
// inspección mecánica; el advisor caro entra solo en juicio sintético. Acá lo
// aplicamos al nivel del set Step 5 — cada advisor declara su `tier`:
//   - 'lean': grep/parse/checks binarios. Haiku safe.
//   - 'standard': razonamiento intermedio. Sonnet.
//   - 'deep': juicio sintético, judgment calls, cross-file synthesis. Opus.
//
// El output de `advisors --cost-tier lean` agrega un campo `model_hints` con
// `{ advisor_name: "haiku"|"sonnet"|"opus" }` SOLO para advisors `tier: lean`.
// El orchestrator (skill tycon-pipeline) puede leerlo y pasar `model:` override
// a `Agent()`; si lo ignora, el frontmatter del advisor decide (default actual).
//
// DEFAULT (`--cost-tier standard` o sin flag): output sin `model_hints`. Cero
// riesgo de regresión. Opt-in solo cuando el dev/equipo lo pide explícito.
//
// Fuente del mapping: misma lógica que el `model:` field del
// frontmatter del agent. Si en producción los advisors `lean`
// muestran falsos negativos, revertir acá (single source of truth) y los
// frontmatters individuales.
const ADVISOR_COST_TIER = {
  // Lean (grep + parse + checks binarios) → Haiku
  'tycon-ac-coverage-checker': 'lean',
  'tycon-deferral-tracker': 'lean',
  // Standard (default Sonnet — donde está la mayoría). Los de convenciones por stack, hermanos
  // y el adaptador de un cliente declaran su `depth` en su manifiesto (packs/) y la lee tierDe().
  'tycon-plugin-tests-coverage': 'standard',
  'tycon-plugin-security-basics': 'standard',
  'tycon-story-validator': 'standard',
  'tycon-dod-runtime-checker': 'standard',
  'tycon-e2e-realness-checker': 'standard',
  'tycon-signed-scope-audit': 'standard',
  'tycon-retrospective-capturer': 'standard',
  'tycon-silent-failure-hunter': 'standard',
  'llm-cost-reviewer': 'standard',
  'i18n-hardcoded-text-reviewer': 'standard', // judgment: label vs comentario/log/identificador → Sonnet
  // Deep (judgment sintético) → Opus
  'tycon-spec-first-checker': 'deep',
};

// Los valores viven en lib/models.js: un solo lugar para el modelo de cada trabajo.
const MODELOS = require('./lib/models.js');
const TIER_TO_MODEL = MODELOS.TIERS;

// ── Paquetes de revisores ─────────────────────────────────────
//
// Los revisores de un producto o de un cliente (convenciones de plugins Bizuit; plugins hermanos;
// el adaptador de un cliente) no viven en las tablas de arriba: viven en `packs/<nombre>/pack.json` (agent-skills, o
// `TYCON_PACKS_DIR`) y entran al set según la condición de su manifiesto, en el grupo que declaran,
// con su superficie para las vueltas y su profundidad de modelo. El cargador (`lib/packs.js`) falla
// fuerte: un paquete roto, un agente inexistente o un revisor repetido FRENAN el comando (exit 2,
// nombrando archivo · revisor · motivo) — nunca degradan a «sin ese paquete», que es exactamente la
// falla silenciosa que esto existe para impedir. La salida de `advisors` / `smart-reloop` lleva
// `packs` para que se vea en la primera corrida, no al mes. La carga es PEREZOSA: los hooks que
// importan este módulo por otras funciones no la disparan.
const packsLib = require('./lib/packs.js');

// Los que necesitan la story completa además del contexto compartido (step-05). Los de paquetes lo
// declaran con `needsStory: true` en su manifiesto.
const NECESITAN_STORY_NUCLEO = ['tycon-spec-first-checker'];

function revisoresDelNucleo() {
  return unique([
    'tycon-plugin-tests-coverage', 'tycon-plugin-security-basics',
    ...Object.keys(ADVISOR_AUDITED_SURFACE), ...Object.keys(ADVISOR_COST_TIER),
    ...NECESITAN_STORY_NUCLEO,
  ]);
}
function paquetesInstalados() {
  return packsLib.cargarPaquetes({ nucleo: revisoresDelNucleo(), banderas: BANDERAS_DETECCION });
}
function paquetesActivos(repo) {
  return packsLib.paquetesActivos({ repo, instalados: paquetesInstalados() });
}
// Lo que viaja en la salida: nombre, carpeta y cada revisor con lo que declara. Las claves de la salida
// están en castellano aunque el manifiesto las escriba en inglés:
// lib/packs.js entrega cada paquete con esos nombres.
function resumenPaquetes(activos) {
  return activos.map((p) => ({
    nombre: p.nombre, dir: p.dir, descripcion: p.descripcion, guias: p.guias,
    revisores: p.revisores.map((r) => ({
      agente: r.agente, grupo: r.grupo, superficie: r.superficie, profundidad: r.profundidad,
      prefijos: r.prefijos, necesitaStory: r.necesitaStory,
    })),
  }));
}
// La entrada del paso 5 de un revisor de paquete (la del grupo validacion no tiene superficie ni
// profundidad: el paso 1 no tiene vueltas).
function revisorDePaquete(nombre) {
  for (const p of paquetesInstalados()) {
    for (const r of p.revisores) if (r.agente === nombre && r.grupo !== 'validacion') return r;
  }
  return null;
}
// Superficie y profundidad: primero el núcleo (sin cargar paquetes), después los manifiestos.
function superficieDe(nombre) {
  if (ADVISOR_AUDITED_SURFACE[nombre]) return ADVISOR_AUDITED_SURFACE[nombre];
  const r = revisorDePaquete(nombre);
  return r ? r.superficie : undefined;
}
function tierDe(nombre) {
  if (ADVISOR_COST_TIER[nombre]) return ADVISOR_COST_TIER[nombre];
  const r = revisorDePaquete(nombre);
  return r ? r.profundidad : undefined;
}
// El contexto con el que se evalúa la condición `when` del manifiesto: las banderas, las rutas del diff y las líneas AGREGADAS
// (mismo criterio que los triggers de contenido del núcleo).
function contextoCondicion(repo, files, det) {
  return { det, files, agregado: (exts) => readAddedContents(repo, files, exts) };
}
function revisoresDePaquetes(activos, grupo, ctx) {
  const out = [];
  for (const p of activos) {
    for (const r of p.revisores) {
      if (r.grupo === grupo && packsLib.evaluarCondicion(r.cuando, ctx)) out.push(r.agente);
    }
  }
  return out;
}
function necesitanStory(activos) {
  return unique([
    ...NECESITAN_STORY_NUCLEO,
    ...activos.flatMap((p) => p.revisores.filter((r) => r.necesitaStory && r.grupo !== 'validacion').map((r) => r.agente)),
  ]);
}

// ── pipeline.js validators — los revisores de validación del paso 1 ────────────────
// El paso 1 lanza al validador de stories y, si la story es de backend, a los revisores del grupo
// `validacion` de los paquetes activos (hoy: el de plugins hermanos, del paquete clients). El step corre
// este comando y lanza lo que
// devuelve. «Story de backend» = la story nombra .cs/.csproj, o el repo tiene *.csproj / *Plugin.cs:
// esos archivos son el contexto sobre el que se evalúa `when` (`added` lee el archivo entero:
// en el paso 1 no hay diff).
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
  let motivo = null;
  try {
    const r = require(path.join(packsLib.raizAgentSkills(), 'scripts', 'lib', 'repos-root.js')).resolveReposRoot();
    raiz = r.root || null;
    if (!raiz) motivo = r.motivo || 'sin raíz de repos';
  } catch (e) { motivo = `no pude leer la raíz de repos (${e.message})`; }
  const lista = packsLib.hermanosResueltos({ paquetes: activos, reposRoot: raiz });
  return { raiz, motivo, lista, texto: packsLib.textoDeHermanos(lista, { reposRoot: raiz }) };
}

function computeValidadores({ story, repo }) {
  if (!story) throw new Error('validators: falta --story <spec.md>');
  // Una ruta mal tipeada no puede dar un set «válido» a medias:
  // sin story legible o sin repo no hay contexto sobre el que decidir nada.
  const content = readText(story);
  if (!content) throw new Error(`validators: no se pudo leer la story ${story}`);
  let repoEsDir = false;
  try { repoEsDir = fs.statSync(repo).isDirectory(); } catch (_e) { repoEsDir = false; }
  if (!repoEsDir) throw new Error(`validators: --repo no es una carpeta: ${repo}`);
  const declarados = [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')]
    .map((f) => f.replace(/^\([^)]*\)\s*/, ''));   // "(agent-skills) ruta" → ruta
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
  return {
    story, repo,
    validadores: ['tycon-story-validator', ...lanzamientos.map((l) => l.agente)],
    lanzamientos,
    packs: resumenPaquetes(activos), packs_dir: packsLib.dirPaquetes(),
    packs_nota: packsLib.notaDePaquetes({ repo, instalados: paquetesInstalados(), activos }),
    contexto: { files, detection: det },
    dependencias_de_pruebas: require('./lib/test-deps.js').dependenciasDePruebas({ repo, storyText: content }),
  };
}

// ── mech-check descuenta advisors ──
//
// computeAdvisorSet integra mech-check (lib/story-checks.js): sin eso, el expected[] persistido EXIGIRÍA
// los advisors LLM que el script
// reemplaza — aunque el orquestador corriera mech-check, igual tendría que spawnear
// los lean para que check-count diera verde. Acá el descuento es AUTOMÁTICO y coherente con
// el expected[]: si mech-check corre limpio (sin ambiguos de esa familia), el
// advisor se DESCUENTA del set y del expected — sus checks corrieron a costo 0.
//
// Matriz de descuento (deliberadamente conservadora). Descontar deferral desde iter 1
// con la claim FALSA "mech cubre DEFTR-C1/C2 completos" sería un error: story-checks
// solo hace un includes() global del storyId en todo.md, mientras el advisor chequea
// CADA item per-item + engram + W1/W2/W3; y como story-checks JAMÁS emite ambiguos
// DEFTR, el advisor quedaría muerto PERMANENTE:
//   - deferral-tracker: iter 1 SIEMPRE corre (per-item + engram + DEFTR-W1..W3 son
//     juicio LLM no mecanizado). En re-loops (iter≥2) se descuenta si mech salió
//     limpio: el delta lo cubren DEFTR-C2 mecánico (skips nuevos sin anotación) +
//     la mención global C1; el pase profundo ya corrió en iter 1.
//   - ac-coverage: ídem — mech cubre ACCOV-C1/C5; C2/C3/C6 son juicio LLM que corre
//     en iter 1; en re-loops el delta lo cubren los checks mecánicos.
//   - feature-wiring: NO se descuenta NUNCA — mech solo cubre WIRING-C1; C2..C5/W1..W3
//     (callsites, testids, endpoints sin caller) son del advisor (un store action sin UI
//     vive exactamente ahí).
const MECH_DISCOUNTABLE = {
  'tycon-deferral-tracker': { minIter: 2, family: 'DEFTR' },
  'tycon-ac-coverage-checker': { minIter: 2, family: 'ACCOV' },
};

function computeMechDiscount(allList, args) {
  if (!args.story) return null;
  let mech;
  try {
    const { runStoryChecks } = require('./lib/story-checks.js');
    mech = runStoryChecks({ repo: args.repo, storyPath: args.story, files: args.files });
  } catch {
    return null; // sin mech-check disponible → sin descuento (conservador)
  }
  const escalateFams = new Set((mech.ambiguous || []).map((a) => String(a.rule || '').split('-')[0]));
  // Ambiguo de familia MECH = mech-check
  // NO PUDO correr (story ilegible/parse roto) → NINGÚN check queda cubierto → cero
  // descuentos. Descontar igual daría la razón falsa "checks cubiertos mecánicamente".
  if (escalateFams.has('MECH')) return null;
  const discounted = [];
  // una story sin criterios detectados no tiene nada que el control mecánico haya cubierto
  const sinCriterios = !mech.stats || !mech.stats.acs;
  for (const [adv, cfg] of Object.entries(MECH_DISCOUNTABLE)) {
    if (!allList.includes(adv)) continue;
    if ((args.iter || 1) < cfg.minIter) continue;
    if (escalateFams.has(cfg.family)) continue; // ambiguos → el advisor LLM resuelve esa familia
    if (cfg.family === 'ACCOV' && sinCriterios) continue;
    discounted.push({
      name: adv,
      reason: `mech-check sin ambiguos ${cfg.family}-* → delta cubierto mecánicamente (0 tokens) ` +
              `[descuento solo iter≥${cfg.minIter}: el pase LLM profundo corrió en iter 1]`,
    });
  }
  return {
    discounted,
    kept: allList.filter((a) => !discounted.some((d) => d.name === a)),
    mech_findings: mech.findings || [],
    mech_ambiguous_count: (mech.ambiguous || []).length,
  };
}

// ── El validador de stories en los re-loops ──────────────────────
//
// Medido: en los re-loops, después de
// DOS veredictos limpios seguidos del validador tras implementar, trajo algo nuevo en 2 de 24 lanzamientos
// (ninguno bloqueante); con menos veredictos limpios seguidos, trajo algo nuevo en 62 de 125. Entonces, desde la vuelta 2: si sus dos últimos
// veredictos sobre ESTA story desde el arranque del paso 5 dicen `limpio` y VAL-C5/VAL-C6 salen limpios sin
// modelo, el validador sale del set (y del `expected`). Todo lo demás INVOCA: no poder leer la
// conversación, faltar el arnés o el arranque del paso 5, un chequeo que no pudo mirar. La duda va hacia más
// control. Cualquier veredicto que no sea `limpio` —hallazgos, inconsistente, sin
// veredicto, un lanzamiento que no volvió— corta la racha.
//
// Lee la conversación con las libs del ARNÉS (reviewers-cost.js, que ya carga tokens-digest.js): la
// constancia del medidor y esta decisión son la MISMA lectura. Pura respecto del registro: anota la CLI.
const VALIDADOR_STORIES = 'tycon-story-validator';
const RACHA_PARA_SOLTAR = 2;

function libsDelArnes(guidesDir) {
  // Dónde está el arnés lo dice UN lector (lib/harness-path.js): la variable o el enlace; nunca una carpeta a mano.
  const r = guidesDir ? { dir: guidesDir } : require('./lib/harness-path.js').rutaArnesHook();
  if (!r.dir) return { error: `${r.aviso}: no puedo leer los veredictos` };
  const base = r.dir;
  // El medidor del arnés por su nombre y, con un arnés desactualizado, por el nombre viejo (armado por
  // pedazos: el nombre viejo no se escribe entero). Buscarlo sólo por el nuevo funciona en el equipo por el reemplazo que
  // deja el renombre; en una copia sin reemplazos dejaría al pipeline sin leer los veredictos, callado.
  const costo = ['reviewers-cost.js', `${['costo', 'revisores'].join('-')}.js`]
    .map((n) => path.join(base, 'scripts', 'metrics', n)).find((p) => fs.existsSync(p));
  if (!costo) return { error: `sin las libs del arnés en ${base}: no puedo leer los veredictos` };
  try {
    return { costo: require(costo), digest: require(path.join(base, 'scripts', 'metrics', 'tokens-digest.js')) };
  } catch (e) {
    return { error: `las libs del arnés no cargan (${(e && e.code) || (e && e.message) || 'error'}): no puedo leer los veredictos` };
  }
}

/** → { invoca, limpias_seguidas, motivo, mech_findings, anotar? } — NUNCA tira. */
function decidirValidadorEnReloop({ args, marker, sessionId, guidesDir, projectsDir } = {}) {
  const invoca = (motivo, extra = {}) => ({ invoca: true, limpias_seguidas: null, motivo, mech_findings: [], ...extra });
  try {
    if (!(Number(args && args.iter) >= 2)) return { ...invoca('vuelta 1: el validador corre siempre'), anotar: false };
    if (args.forceFullReloop) return invoca('re-loop forzado');
    const desde = Date.parse((marker && marker.stepTimings && marker.stepTimings['5'] && marker.stepTimings['5'].startedAt) || '');
    if (!Number.isFinite(desde)) return invoca('no sé cuándo arrancó el paso 5 (el marcador no lo anotó): se invoca');
    const libs = libsDelArnes(guidesDir);
    if (libs.error) return invoca(`${libs.error}: se invoca`);
    const ubi = libs.digest.ubicarTranscripcion(sessionId, projectsDir || path.join(os.homedir(), '.claude', 'projects'));
    if (!ubi.ruta) return invoca(`no pude leer los veredictos: ${ubi.motivo || 'conversación no ubicada'}; se invoca`);
    const leida = libs.digest.leerTranscripcion(ubi.ruta);
    if (leida.error) return invoca(`no pude leer los veredictos: ${leida.error}; se invoca`);
    if (!leida.lineas.length) return invoca(`no pude leer los veredictos: la conversación no tiene renglones legibles (${leida.ilegibles} ilegible(s)); se invoca`);
    const storyPath = (args.story && path.resolve(args.story)) || (marker && marker.storyPath) || null;
    const propios = libs.costo.veredictosDeConversacion(leida.lineas, { storyPath })
      .filter((v) => { const t = Date.parse(v.ts || ''); return Number.isFinite(t) && t >= desde && v.sobre_otra_story !== true; });
    let racha = 0;
    for (let i = propios.length - 1; i >= 0 && propios[i].veredicto === 'limpio'; i--) racha += 1;
    const { runValidatorChecks } = require('./lib/story-checks.js');
    // La MISMA story que la racha (con el fallback al marcador): con `args.story` crudo, sin --story el chequeo
    // saldría «no pude mirar» e invocaría por un motivo falso.
    const chk = runValidatorChecks({ repo: args.repo, storyPath, files: args.files || [] });
    if (chk.findings.length) return invoca(`los chequeos sin modelo encontraron ${[...new Set(chk.findings.map((f) => f.rule))].join(', ')}: se invoca`, { limpias_seguidas: racha, mech_findings: chk.findings });
    if (chk.ambiguous.length) return invoca(`los chequeos sin modelo no pudieron mirar (${chk.ambiguous[0].detail}): se invoca`, { limpias_seguidas: racha });
    if (racha >= RACHA_PARA_SOLTAR) {
      return { invoca: false, limpias_seguidas: racha, motivo: `${racha} veredictos limpios seguidos después de implementar (story 7.3): no se relanza`, mech_findings: [] };
    }
    return invoca(`${racha} veredicto(s) limpio(s) seguido(s) después de implementar; hacen falta ${RACHA_PARA_SOLTAR}`, { limpias_seguidas: racha });
  } catch (e) {
    return invoca(`la decisión falló (${(e && e.message) || e}): se invoca`);
  }
}

/**
 * Aplica la decisión a la salida de `advisors` (clave `all`) o `smart-reloop` (clave `rerun`) y la anota.
 * Sólo CLI. `anotar: false` la recalcula sin escribir `gates.log` (el recálculo de `check-count`, que no decide
 * nada nuevo: reproduce lo que el re-loop ya decidió y anotó).
 */
function aplicarDecisionValidador(salida, clave, args, { anotar = true } = {}) {
  if (!(Number(args.iter) >= 2) || !Array.isArray(salida[clave]) || !salida[clave].includes(VALIDADOR_STORIES)) return;
  const dv = decidirValidadorEnReloop({ args, marker: readSessionMarker(), sessionId: resolveSessionId() });
  salida.validador_reloop = { invoca: dv.invoca, limpias_seguidas: dv.limpias_seguidas, motivo: dv.motivo };
  if (!dv.invoca) {
    salida[clave] = salida[clave].filter((a) => a !== VALIDADOR_STORIES);
    if (clave === 'all') salida.required_count = salida.all.length;
    else {
      salida.rerun_count = salida.rerun.length;
      salida.skipped = [...(Array.isArray(salida.skipped) ? salida.skipped : []), { name: VALIDADOR_STORIES, reason: dv.motivo }];
    }
  }
  if (dv.mech_findings.length) salida.mech_findings = [...(salida.mech_findings || []), ...dv.mech_findings];
  if (!anotar) return;
  logGate({ name: 'validador-reloop', repoPath: args.repo ? path.resolve(args.repo) : null, storyId: deriveStoryId(args.story), iter: Number(args.iter), invoca: dv.invoca, limpias_seguidas: dv.limpias_seguidas, motivo: dv.motivo });
}

// Hints de modelo para re-loops: los emite CUALQUIER iteración N>1, no sólo
// el path mode='smart-reloop'. Sin ellos, los paths force-full-reloop y `advisors --iter N>1`
// (exactamente los que se usan cuando smart-reloop no aplica, el caso más caro)
// correrían los tier 'deep' a Opus precio pleno.
// El orquestador DEBE pasarlos como `model:` al Agent() (step-05) salvo
// que el delta toque specs (juicio de scope nuevo → Opus se justifica).
function reloopHintsFor(list, iter, costTier) {
  if (!iter || iter <= 1) return null;
  // Precedencia: `--cost-tier deep` es el
  // escape hatch "auditoría paranoica → todo a Opus" — gana sobre los hints de re-loop.
  // Sin este guard el output traería dos directivas opuestas para los mismos advisors.
  if (costTier === 'deep') return null;
  const hints = {};
  for (const adv of list) {
    if (tierDe(adv) === 'deep') hints[adv] = MODELOS.DEFAULTS.reviewers_reloop;
  }
  return Object.keys(hints).length ? hints : null;
}

// ── Los modelos de la organización ─────────────────────────────────────────────────────────────────
// Con `team-repos.json → models` declarado (o un pedido del dev en el marcador), `advisors` y `smart-reloop` dan
// `reviewer_models` —un modelo por revisor, con su origen y, en las vueltas siguientes, `first_round`— y dejan de dar
// `model_hints`/`reloop_model_hints`: un solo campo con modelos por revisor. Sin nada de eso, siguen esos campos.
// Las funciones que deciden reciben la configuración por argumento (`args.orgModels`, `args.modelRequests`); sólo las
// ramas de línea de comandos la leen (`orgModels`, `pedidosDeModelos`), así las pruebas nunca ven la de la máquina.
const CODEX_NOTE = 'en Codex los revisores usan el modelo con que se desplegaron; el pedido de esta corrida y las vueltas siguientes no aplican ahí';
const SIN_ORG = { declared: false, data: null, problem: null };

/**
 * La configuración `models` de la organización, del arnés que ve esta corrida (el camino de `harnessIntegrations`):
 * `{ declared, data, problem }`. Nunca tira. opts: env · home · tree (el árbol, para las pruebas).
 */
function orgModels(opts = {}) {
  const env = opts.env || process.env;
  try {
    const dir = opts.tree || require('./lib/harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
    if (!dir) return SIN_ORG;
    const lector = path.join(dir, 'scripts', 'lib', 'team-repos.js');
    if (!fs.existsSync(lector)) {
      // un árbol sin lector con un team-repos.json: no se puede validar, y se dice (no es «sin configuración»)
      return fs.existsSync(path.join(dir, 'team-repos.json'))
        ? { ...SIN_ORG, problem: `no pude leer la configuración de la organización (${path.join(dir, 'team-repos.json')}: el arnés no trae su lector, ${lector}): uso los valores de hoy` }
        : SIN_ORG;
    }
    return MODELOS.readOrgModels({ dir, teamRepos: require(lector) });
  } catch (e) {
    return { ...SIN_ORG, problem: `no pude leer la configuración de la organización (${String((e && e.message) || e).split('\n')[0]}): uso los valores de hoy` };
  }
}

/** El pedido del dev para esta corrida (`marker.js set-models`), o null. */
function pedidosDeModelos(marker) {
  const v = marker && marker.modelRequests && marker.modelRequests.values;
  return v && typeof v === 'object' && Object.keys(v).length ? v : null;
}

/**
 * Suma `reviewer_models` (y `codex_note`) a la salida de `advisors`/`smart-reloop` para la lista de revisores, cuando
 * hay configuración o pedido; saca `model_hints`/`reloop_model_hints`. Devuelve los avisos (`{ key, message }`).
 */
function aplicarModelosDeRevisores(out, list, args, fullSet = list) {
  const org = args.orgModels && args.orgModels.declared ? args.orgModels.data : null;
  const requests = args.modelRequests || null;
  if (!org && !requests) return [];
  const warnings = [];
  out.reviewer_models = MODELOS.resolveReviewers({
    org, requests, costTier: args.costTier, tierOf: tierDe, set: list, fullSet, iter: args.iter, agentsDir: args.agentsDir, warnings,
  });
  delete out.model_hints;
  delete out.reloop_model_hints;
  delete out.reloop_model_hints_note;
  delete out.cost_tier;
  if (requests || (args.iter && args.iter > 1)) out.codex_note = CODEX_NOTE;
  return warnings;
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

/**
 * Lo que la línea de comandos dice de los modelos: `models_problem` (la configuración no se pudo leer) y
 * `models_warnings` (lo que se bajó al techo, un pedido que no aplica…), cada aviso una sola vez por corrida: con
 * marcador, lo ya avisado queda en `modelsWarned` (la misma lógica que `marker.js mark-models-warned`); sin marcador,
 * en cada salida. Nunca cambia el código de salida.
 */
function decirModelos(out, org, warnings) {
  if (org && org.problem) out.models_problem = org.problem;
  if (!warnings || !warnings.length) return;
  const marker = readSessionMarker();
  const ya = new Set((marker && Array.isArray(marker.modelsWarned)) ? marker.modelsWarned : []);
  const vistos = new Set();
  const nuevos = warnings.filter((w) => !ya.has(w.key) && !vistos.has(w.key) && vistos.add(w.key));
  if (!nuevos.length) return;
  out.models_warnings = nuevos.map((w) => w.message);
  if (marker) anotarModelosAvisados(nuevos.map((w) => w.key));
}

/** Anota en el marcador de esta sesión las claves ya avisadas (`modelsWarned`). Nunca tira. */
function anotarModelosAvisados(keys) {
  try {
    const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`);
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    m.modelsWarned = [...new Set([...(Array.isArray(m.modelsWarned) ? m.modelsWarned : []), ...keys])];
    const tmp = `${markerPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch (_) { /* sin marcador o ilegible: se vuelve a avisar, que es lo de menos */ }
}

/** Lo que la línea de comandos le pasa a las funciones que deciden: la configuración y el pedido de la corrida. */
function conModelosDeLaCorrida(args) {
  return { ...args, orgModels: orgModels(), modelRequests: pedidosDeModelos(readSessionMarker()) };
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

// Glob-to-regex simple matcher (no deps). Soporta:
//   **/  → cualquier dir prefix (0+ dirs)
//   **   → cualquier path (con o sin /)
//   *    → cualquier filename char excepto /
//   {a,b} → alternancia
// Match anchored al final + opcional dir prefix al inicio (para que `**/*.cs` matchee `Services/X.cs`).
function matchGlob(filePath, pattern) {
  // Normalizar barras (Windows defensive).
  const f = String(filePath).replace(/\\/g, '/');
  const p = String(pattern).replace(/\\/g, '/');
  // Escapar metachars regex excepto los nuestros.
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // ** o **/
        if (p[i + 2] === '/') {
          re += '(?:.*/)?'; // **/  → optional dir prefix
          i += 2;
        } else {
          re += '.*'; // ** → cualquier path
          i += 1;
        }
      } else {
        re += '[^/]*'; // * → no slash
      }
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        const alts = p.slice(i + 1, end).split(',').map((a) => a.replace(/([.+?^${}()|[\]\\])/g, '\\$1'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else if ('.+?^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // Anchor: full path match (no permitir prefijo random), pero permitir que el archivo
  // viva en cualquier subdir si el pattern empieza con **/.
  const fullRe = new RegExp(`^${re}$`);
  if (fullRe.test(f)) return true;
  // Fallback: match contra basename si el pattern no tiene `/` (ej `*.cs` matchea `foo/bar.cs`)
  if (!p.includes('/')) {
    const base = f.split('/').pop();
    return fullRe.test(base);
  }
  return false;
}

function advisorAffectedByDelta(advisorName, deltaFiles) {
  const surface = superficieDe(advisorName);
  if (!surface) return { affected: true, reason: 'advisor sin surface declarada → rerun conservador' };
  if (surface.always) return { affected: true, reason: 'always: true (frontmatter/spec/test-count audit)' };
  if (!Array.isArray(surface.paths) || surface.paths.length === 0) return { affected: true, reason: 'surface mal declarada → rerun conservador' };

  for (const f of deltaFiles) {
    const includeMatch = surface.paths.find((p) => matchGlob(f, p));
    if (!includeMatch) continue;
    const excludeMatch = (surface.excludePaths || []).find((p) => matchGlob(f, p));
    if (!excludeMatch) {
      return { affected: true, reason: `file '${f}' matches include '${includeMatch}'` };
    }
  }
  const includes = surface.paths.join(', ');
  const excludes = (surface.excludePaths || []).length ? ` (excluding ${surface.excludePaths.join(', ')})` : '';
  return { affected: false, reason: `audited surface [${includes}]${excludes} no tocada en iter delta` };
}

// Lee el marker de ESTA sesión desde ~/.claude/.tycon-pipeline/active/<sid>.json
// (read-only — pipeline.js no muta marker; eso lo hace marker.js).
function readSessionMarker() {
  const sid = sessionIdFileKey();
  const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sid}.json`);
  try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return null; }
}

// ── Lo que ve GIT — la 4ta fuente del delta, y la única que no depende del hook ──
// Las otras tres (nombres nuevos, fileEvents, mtime) salen todas de `marker.filesTouched`, que
// escribe on-edit.js desde PostToolUse matcher Edit|Write. Incluso el fallback por mtime ITERA
// sobre filesTouched — o sea que cubre "un archivo que el hook ya vio y se re-editó por fuera",
// NO "un archivo que el hook no vio nunca". Ese agujero deja ciego al re-loop (ver
// lib/ledger-honesty.js). git no tiene ese punto ciego: ve el working tree.
function gitArchivosDelWorkingTree(repo) {
  const { execFileSync } = require('child_process');
  const correr = (args) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).filter(Boolean);
    } catch { return []; }   // sin git / no es repo → fail-open: la ceguera no se puede diagnosticar
  };
  // 🔴 La base de los paths es la RAÍZ del repo git, NO el `--repo` que nos pasaron.
  // Con `--repo` apuntando a un subdirectorio —un monorepo, o el caso
  // normal de estos repos con varios proyectos adentro— `path.join(repo, f)` armaría rutas
  // inexistentes: la 4ta fuente quedaría inerte (ningún statSync encontraría nada) justo en los
  // repos donde más falta hace. Se pregunta la raíz y se recorta a lo que cae dentro de --repo.
  const raizGit = (correr(['rev-parse', '--show-toplevel'])[0] || repo);
  const rel = [
    ...correr(['diff', '--name-only', 'HEAD']),
    ...correr(['ls-files', '--others', '--exclude-standard']),
  ];
  // realpath en las DOS puntas: en macOS `os.tmpdir()` y `/tmp` son symlinks a `/private/...`, y
  // `git rev-parse --show-toplevel` devuelve el path YA resuelto. Comparar uno resuelto contra uno
  // sin resolver descartaría TODOS los archivos y dejaría la 4ta fuente inerte.
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const dentro = real(repo);
  return [...new Set(rel)]
    .map((f) => real(path.resolve(raizGit, f)))
    .filter((abs) => abs === dentro || abs.startsWith(`${dentro}${path.sep}`));
}

// Constancia de la ceguera en gates.log — para que la retrospectiva la lea sin que nadie escriba
// un reporte a mano. Un diagnóstico que sólo vive en el stdout de una corrida se pierde con ella.
function logGate(obj) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), sessionId: resolveSessionId(), ...obj })}\n`, 'utf8');
  } catch { /* el log nunca rompe el gate */ }
}

/**
 * El re-loop reducido, con los modelos de la organización: en sus tres caminos, `reviewer_models` para
 * los revisores que se vuelven a correr cuando hay configuración o pedido (`args.orgModels`, `args.modelRequests`);
 * sin eso, `reloop_model_hints`. Los avisos quedan en `_avisos` (los dice la línea de comandos).
 */
function computeSmartReloop(args) {
  const out = computeSmartReloopBase(args);
  const avisos = aplicarModelosDeRevisores(out, out.rerun || out.all || [], args, out.all || out.rerun || []);
  if (avisos.length) Object.defineProperty(out, '_avisos', { value: avisos, enumerable: false });
  return out;
}

function computeSmartReloopBase({ repo, story, files, iter, forceFullReloop, costTier }) {
  const fullSet = computeAdvisorSet({ repo, story, files });

  if (forceFullReloop || iter <= 1) {
    const out = {
      ...fullSet,
      iter,
      mode: forceFullReloop ? 'force-full-reloop' : 'iter1-full',
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
    };
    // El path force-full (el MÁS caro — set completo en
    // re-loop) sin reloop_model_hints haría que los tier deep corrieran a Opus pleno.
    const hints = reloopHintsFor(fullSet.all, iter, costTier);
    if (hints) {
      out.reloop_model_hints = hints;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  const marker = readSessionMarker();
  const prevSnapshot = marker?.iterations?.[String(iter - 1)]?.filesSnapshot;
  if (!prevSnapshot) {
    const out = {
      ...fullSet,
      iter,
      mode: 'no-prev-snapshot-fallback',
      warning: `no hay marker.iterations[${iter - 1}].filesSnapshot — fallback a set completo. ` +
               `Llamá 'marker.js snapshot-iter ${iter - 1}' después de invocar advisors de esa iter.`,
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
    };
    // Este es un path iter>1 con set
    // COMPLETO (el más caro) — también emite hints: TODA invocación iter>1 los emite.
    const hints = reloopHintsFor(fullSet.all, iter, costTier);
    if (hints) {
      out.reloop_model_hints = hints;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  // 🔴 Los probes se filtran ACÁ, no sólo en la foto. Filtrar
  // únicamente el `filesSnapshot` dejaría `filesTouched` con los probes adentro, y `deltaByName`
  // compara uno contra otro: cada probe aparecería como "archivo nuevo" en la iteración 2 — y en la
  // 3, y en todas, porque la foto se re-filtra y la lista cruda no. Efecto: delta fantasma
  // de 3 archivos sin que nadie haya editado nada, un advisor de más por iteración, y de yapa
  // apagaría el guard `suspect_empty_delta`. O sea que filtrar a medias reintroduciría la contaminación que viene a cerrar.
  // 🔴 Lo que cae FUERA del repo tampoco es trabajo del repo: los cazadores del pase 5b escriben
  // `/tmp/probe.*`, el hook de ediciones los registra y la
  // iteración 2 los contaría en el delta. Esos nombres no siguen la convención de probes, así que el filtro
  // por nombre no los ve; el filtro por lugar sí. Se conserva la carpeta de la story: en los productos
  // con repo de specs aparte, la story vive fuera de `--repo` y editarla es trabajo de la corrida.
  // 🔴 Los repos hermanos también: en una story de dos repos, los arreglos del hermano quedarían afuera del
  // delta y los revisores de su superficie se saltearían por «superficie no tocada».
  // Sus archivos entran por las mismas fuentes que los del repo.
  const hermanosDelDelta = companionLib.companionRoots(repo, story, {
    onMissing: (nombre, quien) => process.stderr.write(`⚠ el repo hermano «${nombre}» que declara ${companionLib.label(quien)}/.tycon/advisors.yaml no está en disco: sus ediciones no entran al delta\n`),
  });
  const raicesDelDelta = [repo, ...(story ? [path.dirname(path.resolve(String(story)))] : []), ...hermanosDelDelta];
  const workingTreeDeTodos = () => [repo, ...hermanosDelDelta].flatMap((r) => gitArchivosDelWorkingTree(r));
  const delRepo = (files) => files.filter((f) => raicesDelDelta.some((r) => honesty.esDelRepo(f, r)));
  const currentFiles = delRepo(honesty.sinProbes(marker.filesTouched || []));
  const prevSet = new Set(prevSnapshot);
  // Delta por NOMBRES nuevos (legacy) — atrapa archivos que aparecieron en iter N.
  const deltaByName = currentFiles.filter((f) => !prevSet.has(f));
  // Delta por EVENTOS de edición: un archivo YA tocado
  // en iter N-1 que se RE-EDITA en iter N (el caso típico del fix-loop) no aparece
  // en deltaByName porque filesTouched dedupea — sin eventos, el advisor que
  // reportó el finding NUNCA re-auditaría su propio fix.
  // marker.fileEvents (escritos por on-edit.js directo; marker.js append-file existe como CLI manual)
  // conserva cada edición con ts; delta = ediciones POSTERIORES al snapshot previo.
  const prevTs = marker.iterations[String(iter - 1)].ts;
  // ── SEGUNDA CAPA: el corte es el ÚLTIMO REVISOR, no la hora de la foto ────────────
  // La hora de la foto es justamente el dato que puede estar mal: si fecha la foto de una iteración a las 17:03 con
  // un arreglo de las 16:58 adentro, el delta de la siguiente
  // sale VACÍO → `security-basics` y `silent-failure-hunter` se saltean por «superficie no
  // tocada». La guarda de `marker.js snapshot-iter` cierra el caso en origen; ésta es la que cubre
  // lo que aquélla no puede ver: TYCON_SNAPSHOT_GUARD=0, una foto escrita a mano en el marker, o un
  // `snapshot-iter` viejo de una máquina con el arnés atrasado. Al momento de calcular, el último
  // `step5-start` del registro ES el de `iter-1` (acá se calcula; `logStep5Start` anota el nuevo
  // después). Sin registro → corte = la foto, como siempre.
  let ultimoRevisorMs = null;
  let lineasRegistro = null;
  try {
    const lp = path.join(stateDirOf(os.homedir()), 'advisor-runs', `${sessionIdFileKey()}.jsonl`);
    lineasRegistro = fs.readFileSync(lp, 'utf8').split('\n');
  } catch { /* sin registro de spawns → el corte sigue siendo la foto, y la vista por revisor no se mide */ }
  try {
    const { ultimoRevisorDeLaRonda } = require('./lib/late-snapshot.js');
    const ur = ultimoRevisorDeLaRonda(lineasRegistro || [], iter - 1);
    if (Number.isFinite(ur.ts)) ultimoRevisorMs = ur.ts;
  } catch { /* ídem */ }
  // Delta = UNIÓN de TRES fuentes (si fileEvents y mtime fueran either/or,
  // un fileEvents truncado, p.ej. por un
  // `marker.js set` mid-pipeline, o ediciones hechas SOLO por Bash
  // (sed/heredoc, fuera del hook Edit|Write), SUPRIMIRÍA el fallback por mtime y
  // las re-ediciones caerían del delta en silencio):
  //   1. nombres nuevos (deltaByName — archivos que aparecieron en iter N),
  //   2. fileEvents posteriores al snapshot (escritos por on-edit.js),
  //   3. mtime de filesystem > ts del snapshot (cubre ediciones fuera del hook).
  // Conservador en la dirección correcta: un falso positivo = un advisor de más;
  // un falso negativo = un fix sin re-auditar.
  let deltaByEvents = [];
  let deltaByMtime = [];
  const deltaByGit = [];
  const sources = ['nombres nuevos'];
  const prevTsMs = prevTs ? new Date(prevTs).getTime() : NaN;
  // ¿La foto se fechó DESPUÉS del último revisor? Entonces el corte honesto es el último revisor:
  // lo editado en el medio no lo vio nadie. Nunca al revés — un corte MÁS TARDE que la foto perdería
  // ediciones, que es exactamente el defecto.
  const fotoTardia = Number.isFinite(ultimoRevisorMs) && Number.isFinite(prevTsMs) && ultimoRevisorMs < prevTsMs;
  const horaDe = new Map();          // path → ms de la edición que lo mete en el delta
  if (prevTs) {
    const cutoff = fotoTardia ? ultimoRevisorMs : prevTsMs;
    if (Array.isArray(marker.fileEvents) && marker.fileEvents.length) {
      deltaByEvents = delRepo(honesty.sinProbes([...new Set(
        marker.fileEvents
          .filter((e) => e && e.path && e.ts && new Date(e.ts).getTime() > cutoff)
          .map((e) => e.path),
      )]));
      for (const e of marker.fileEvents) {
        if (!e || !e.path || !e.ts) continue;
        const t = new Date(e.ts).getTime();
        if (Number.isFinite(t) && t > cutoff && !horaDe.has(e.path)) horaDe.set(e.path, t);
      }
      sources.push('fileEvents post-snapshot');
    }
    for (const f of currentFiles) {
      try {
        const mt = fs.statSync(f).mtimeMs;
        if (mt > cutoff) { deltaByMtime.push(f); if (!horaDe.has(f)) horaDe.set(f, mt); }
      } catch { /* archivo borrado/inaccesible → names-only lo cubre si es nuevo */ }
    }
    sources.push('mtime de filesystem post-snapshot');
    // 4ta fuente: el working tree según git, filtrado por mtime posterior a la foto.
    // Las tres de arriba iteran sobre `filesTouched` — si el hook nunca vio el archivo, ninguna lo
    // encuentra. Ésta sí. Los probes del pase adversarial NO cuentan (no son trabajo del repo).
    for (const f of honesty.sinProbes(workingTreeDeTodos())) {
      try {
        const mt = fs.statSync(f).mtimeMs;
        if (mt > cutoff) { deltaByGit.push(f); if (!horaDe.has(f)) horaDe.set(f, mt); }
      } catch { /* ídem */ }
    }
    if (deltaByGit.length) sources.push('git working-tree post-snapshot');
    if (fotoTardia) sources.push('corte movido al último revisor (la foto se fechó después)');
  }
  const deltaSource = prevTs
    ? `unión(${sources.join(' ∪ ')})`
    : 'names-only (sin ts de snapshot previo — el delta puede PERDER re-ediciones → usá --force-full-reloop si hubo fixes sobre archivos existentes)';
  const delta = [...new Set([...deltaByName, ...deltaByEvents, ...deltaByMtime, ...deltaByGit])];

  // ── ¿El registro ve lo que ve git? ──
  // Antes de devolver un delta "chico", la pregunta honesta: ¿el registro de ediciones aportó
  // ALGO del repo? Si git ve trabajo y el registro no aporta nada, el delta no es chico: es
  // ciego, y el modo correcto es el set COMPLETO **anunciado con la razón**. Sin eso el orquestador
  // llegaría igual a force-full, pero a ciegas y más tarde, sin saber por qué.
  const diag = honesty.diagnosticar({
    repoPath: repo,
    registro: [...currentFiles, ...(Array.isArray(marker.fileEvents) ? marker.fileEvents.map((e) => e && e.path) : [])],
    gitCambiados: gitArchivosDelWorkingTree(repo),
  });
  if (diag.ciego) {
    logGate({
      repoPath: repo, name: 'smart-reloop', check: 'ledger-honesty', status: 'blind', iter,
      gitFiles: diag.gitUtil.length, registroFiles: 0,
      probesDescartados: diag.probesDescartados.length, fueraDelRepo: diag.fueraDelRepo.length,
    });
    const out = {
      ...fullSet,
      iter,
      mode: 'force-full-reloop',
      ledger_blind: true,
      ledger_blind_reason: diag.razon,
      git_sees: diag.gitUtil,
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
      note: 'set COMPLETO por registro ciego, no por elección — ver ledger_blind_reason. ' +
            'El delta que se habría devuelto NO medía nada: los archivos del repo no estaban en el registro.',
    };
    const hintsCiego = reloopHintsFor(fullSet.all, iter, costTier);
    if (hintsCiego) {
      out.reloop_model_hints = hintsCiego;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  // ── La versión del cambio que vio CADA revisor ─────────────────────────────────────
  // 🔴 El delta de arriba es de la VUELTA: mira desde la foto, y la foto se toma sola al lanzar el
  // último revisor. Un arreglo hecho mientras corrían los demás, antes de ese último lanzamiento, queda
  // adentro de la foto: el delta no lo trae y el revisor que se había lanzado ANTES del arreglo —que no
  // lo vio— se saltearía por «superficie no tocada». Por eso, para cada revisor, también cuenta lo
  // editado después de SU lanzamiento (la hora la escribe el hook en cada spawn real).
  // Sólo SUMA: el delta de la vuelta se sigue aplicando igual a todos, así que nadie que entre por él
  // puede quedar afuera por esto.
  //   · lanzado en la vuelta anterior → lo editado después de su lanzamiento;
  //   · no estaba en esa vuelta (la anterior lo había salteado) → lo editado desde que arrancó la vuelta;
  //   · estaba en la vuelta y no consta su lanzamiento, o no hay registro de la vuelta → no se sabe qué
  //     vio: se re-corre por las dudas, y se dice.
  let vista;
  try {
    vista = require('./lib/late-snapshot.js').vistaPorRevisor(lineasRegistro || [], iter - 1);
  } catch (e) {
    vista = { medible: false, motivo: `no se pudo leer el registro de lanzamientos (${(e && e.message) || e})` };
  }
  const ultimaEdicion = new Map();     // path → ms de su edición más reciente, por cualquiera de las fuentes
  if (vista.medible) {
    const anotarEdicion = (p, t) => {
      if (!p || !Number.isFinite(t)) return;
      const v = ultimaEdicion.get(p);
      if (v === undefined || t > v) ultimaEdicion.set(p, t);
    };
    // Las mismas fuentes que el delta (registro de ediciones, mtime, git), con los mismos filtros.
    for (const e of Array.isArray(marker.fileEvents) ? marker.fileEvents : []) {
      if (e && e.path && e.ts && delRepo(honesty.sinProbes([e.path])).length) anotarEdicion(e.path, new Date(e.ts).getTime());
    }
    for (const f of [...currentFiles, ...honesty.sinProbes(workingTreeDeTodos())]) {
      try { anotarEdicion(f, fs.statSync(f).mtimeMs); } catch { /* borrado → si es nuevo, lo cubre el delta por nombre */ }
    }
  }
  const enElDelta = new Set(delta);
  const noVistosDesde = (ms) => [...ultimaEdicion].filter(([p, t]) => t > ms && !enElDelta.has(p)).map(([p]) => p);
  const noVistosPorRevisor = {};       // revisor → archivos de su alcance editados después de su lanzamiento
  const sinVista = [];                 // revisores re-corridos porque no se sabe qué versión vieron

  const rerun = [];
  const skipped = [];
  for (const adv of fullSet.all) {
    let { affected, reason } = advisorAffectedByDelta(adv, delta);
    if (!affected && !vista.medible) {
      affected = true;
      reason = `no se sabe qué versión del cambio vio en la vuelta ${iter - 1} (${vista.motivo}) → se re-corre por las dudas`;
      sinVista.push(adv);
    } else if (!affected) {
      const lanzado = vista.lanzamientos.get(adv);
      if (lanzado === undefined && vista.esperados.has(adv)) {
        affected = true;
        reason = `estaba en la vuelta ${iter - 1} y no consta su lanzamiento → no se sabe qué vio: se re-corre por las dudas`;
        sinVista.push(adv);
      } else {
        const desde = lanzado !== undefined ? lanzado : vista.inicioMs;
        const enSuAlcance = noVistosDesde(desde).filter((f) => advisorAffectedByDelta(adv, [f]).affected);
        if (enSuAlcance.length) {
          affected = true;
          noVistosPorRevisor[adv] = enSuAlcance;
          reason = lanzado !== undefined
            ? `'${enSuAlcance[0]}' se editó después de su lanzamiento en la vuelta ${iter - 1} (${new Date(lanzado).toISOString()}): no lo vio`
            : `'${enSuAlcance[0]}' se editó durante la vuelta ${iter - 1}, que lo había salteado: no lo vio`;
        }
      }
    }
    if (affected) {
      rerun.push({ name: adv, reason });
    } else {
      skipped.push({ name: adv, reason });
    }
  }

  // Hint de modelo para re-loops:
  // los advisors tier 'deep' (Opus) corren en CADA iteración por ser always:true.
  // El juicio sintético grande ya pasó en iter 1; el re-check sobre un delta de fix
  // es más angosto → Sonnet alcanza. El orquestador DEBE aplicarlo (step-05) salvo
  // que el delta incluya specs editadas.
  const reloopModelHints = reloopHintsFor(rerun.map((r) => r.name), iter, costTier) || {};

  // GUARD delta-vacío: un smart-reloop es POR
  // DEFINICIÓN un re-loop que sigue a fixes de código — un delta VACÍO ahí casi siempre significa
  // que `snapshot-iter ${iter-1}` se tomó DESPUÉS de aplicar los fixes (la foto ya los contiene, así
  // que "qué cambió desde la foto" da vacío). Sin este guard el orquestador ve "N/M skip por surface
  // intacta", lo toma como legítimo y cae a --force-full-reloop (el set COMPLETO — el caso más caro),
  // repetido en cada iteración. El warning lo hace accionable en vez de degradar en silencio.
  // ── ¿La foto de la iteración anterior se fechó TARDE, y tapó código? ─────────────────────
  // Los archivos que entran al delta SÓLO porque el corte se movió al último revisor son, literalmente,
  // los que ningún revisor vio y la foto escondió. Con el corte en la hora de la foto el delta saldría
  // vacío (o más corto) y esos revisores se saltearían por «superficie no tocada».
  // 🔴 El aviso sale TAMBIÉN por stderr: el orquestador puede filtrar este JSON con un
  // `python3 -c` que imprime sólo `correr/hints/ctx`, y entonces la advertencia existe y no la lee nadie.
  // Un aviso que vive sólo dentro de un JSON que el llamador puede filtrar no es un control.
  const lateSnapshotFiles = fotoTardia
    ? delta.filter((f) => { const t = horaDe.get(f); return Number.isFinite(t) && t <= prevTsMs; })
    : [];
  if (lateSnapshotFiles.length) {
    process.stderr.write(
      `⚠ la foto de la iteración ${iter - 1} se fechó DESPUÉS del último revisor y tapó ` +
      `${lateSnapshotFiles.length} archivo(s) de código que nadie auditó: ` +
      `${lateSnapshotFiles.slice(0, 10).map((f) => path.basename(f)).join(', ')}` +
      `${lateSnapshotFiles.length > 10 ? ` y ${lateSnapshotFiles.length - 10} más` : ''}.\n` +
      `   El delta se calculó desde el último lanzamiento de revisores, así que ESTA vuelta los incluye.\n` +
      `   No repitas \`snapshot-iter\` después de arreglar: la foto se toma sola al lanzar el último revisor.\n`,
    );
  }

  // Por stderr también, por la misma razón que el aviso de arriba: el JSON lo puede filtrar quien llama.
  const revisoresNoVieron = Object.keys(noVistosPorRevisor);
  if (revisoresNoVieron.length) {
    process.stderr.write(
      `⚠ ${revisoresNoVieron.length} revisor(es) de la vuelta ${iter - 1} no vieron un arreglo hecho después de ` +
      `lanzarse (quedó adentro de la foto): ` +
      `${revisoresNoVieron.map((a) => `${a} (${noVistosPorRevisor[a].slice(0, 3).map((f) => path.basename(f)).join(', ')})`).join('; ')}.\n` +
      `   ESTA vuelta los re-corre.\n`,
    );
  }
  if (sinVista.length) {
    process.stderr.write(
      `⚠ no se sabe qué versión del cambio vieron ${sinVista.length} revisor(es) en la vuelta ${iter - 1}` +
      `${vista.medible ? ' (estaban en la vuelta y no consta su lanzamiento)' : ` (${vista.motivo})`}: ` +
      `se re-corren por las dudas — ${sinVista.join(', ')}.\n`,
    );
  }

  const suspectEmptyDelta = delta.length === 0;
  const emptyDeltaWarning = suspectEmptyDelta
    ? `⚠ DELTA VACÍO en un re-loop (iter ${iter}) — un re-loop sigue a fixes, así que un delta vacío ` +
      `casi siempre = 'snapshot-iter ${iter - 1}' tomado DESPUÉS de los fixes (debe tomarse al cierre ` +
      `de la tanda de advisors, ANTES de fixear). NO tomes el "todo skip por surface" como legítimo. ` +
      `Acción: re-snapshotear en el momento correcto la próxima iteración; para ESTA, --force-full-reloop.`
    : null;

  return {
    ...fullSet,
    iter,
    mode: 'smart-reloop',
    all_iter1: fullSet.all,
    rerun_count: rerun.length,
    rerun: rerun.map((r) => r.name),
    rerun_reasons: rerun,
    skipped_count: skipped.length,
    skipped,
    delta_files: delta,
    delta_source: deltaSource,
    ...(suspectEmptyDelta ? { suspect_empty_delta: true, warning: emptyDeltaWarning } : {}),
    ...(lateSnapshotFiles.length ? {
      suspect_late_snapshot: true,
      late_snapshot_files: lateSnapshotFiles,
      late_snapshot_note: `la foto de iter ${iter - 1} se fechó después del último lanzamiento de revisores: ` +
        `el delta se cortó por el último revisor y esos archivos entraron igual. La foto se toma SOLA al ` +
        `lanzar el último revisor — no la repitas a mano después de arreglar.`,
    } : {}),
    ...(Object.keys(reloopModelHints).length ? { reloop_model_hints: reloopModelHints, reloop_model_hints_note: 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint si el delta toca specs.' } : {}),
    ...(revisoresNoVieron.length ? { no_vistos_por_revisor: noVistosPorRevisor } : {}),
    vista_por_revisor: vista.medible
      ? { medible: true, ...(sinVista.length ? { sin_vista: sinVista } : {}) }
      : { medible: false, motivo: vista.motivo, sin_vista: sinVista },
    note: !vista.medible && sinVista.length
      ? `no se sabe qué versión del cambio vio cada revisor en la vuelta ${iter - 1} (${vista.motivo}): se re-corren todos los que el delta no traía. Ver vista_por_revisor.`
      : suspectEmptyDelta
      ? `delta vacío en un re-loop → ver "warning": snapshot probablemente post-fixes. NO degradar a "todo skip" en silencio.`
      : skipped.length > 0
        ? `${skipped.length}/${fullSet.all.length} advisors skip por surface intacta. Override con --force-full-reloop si dudás.`
        : `Todos los advisors de iter 1 tienen surface tocada en iter ${iter} delta → re-correr set completo.`,
  };
}

// ── Pre-flight hook validation ───────────────────────────
//
// Cuando el orquestador va a Edit el frontmatter para transicionar status a
// review/done o agregar pipelines.X.status: done, los hooks (on-frontmatter-write.js,
// hook-pre-edit.js, on-pre-commit.js) chequean pre-condiciones al momento del Edit
// y bloquean si no se cumplen. El orquestador descubre por failure (Edit →
// hook block → leer error → ajustar → retry = ~30-60s/ciclo).
//
// `preflight-frontmatter` simula el chequeo ANTES del Edit: lee la story actual,
// el target state, evalúa todas las pre-condiciones, devuelve qué falta + cómo
// satisfacerlo. El orquestador prepara TODO upfront en un solo paso.
//
// Ejemplo de dos ciclos de hook-block: pipelines.A.status: done sin evidence file → crear evidence; evidence
// sin `## Playwright Run verdict=PASS failed=0` → buscar regex en hook source + ajustar formato. Cuestan ~1.5 min de overhead.

function parseFrontmatterPipeline(content) {
  const m = (content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (km) fm[km[1]] = km[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

// Resuelve el/los repo-root(s) donde buscar la evidencia DoD de una story.
// Sacar el root con `storyPath.split('/specs/stories/')[0]` falla en
// repos con las stories en `docs/…` (no `specs/stories/`): devuelve el path del PROPIO .md como
// "root" → candidate dirs tipo `<story.md>/.advisors/dod-runtime` → PRE-1 falso negativo. Por eso
// es layout-agnóstico: honra `explicitRepo` (--repo) y, si no, camina hacia arriba hasta el `.git`.
function findRepoRootsForStory(storyPath, explicitRepo) {
  const roots = [];
  const seen = new Set();
  const add = (r) => { if (r && !seen.has(r)) { seen.add(r); roots.push(r); } };

  // 1. --repo explícito gana (si es un dir real).
  if (explicitRepo) {
    try {
      const abs = path.resolve(explicitRepo);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) add(abs);
    } catch { /* ignore */ }
  }

  // 2. Walk-up desde el .md hasta el repo-root (primer ancestro con `.git`) —
  //    funciona igual con specs/stories/ que con docs/…. `.git` puede ser file (worktree).
  let repoRoot = null;
  let dir = path.dirname(path.resolve(storyPath));
  const fsRoot = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) { repoRoot = dir; break; }
    if (dir === fsRoot) break;
    dir = path.dirname(dir);
  }
  // Fallback legacy: split por /specs/stories/ (checkout raro sin `.git` detectable).
  if (!repoRoot) {
    const specRoot = storyPath.split('/specs/stories/')[0];
    if (specRoot && specRoot !== storyPath) repoRoot = specRoot;
  }
  add(repoRoot);

  // 3. Repos hermanos (cross-repo: frontmatter en un repo, impl en otro).
  const base = repoRoot || (roots.length ? roots[0] : null);
  if (base) {
    const parent = path.dirname(base);
    try {
      for (const sibling of fs.readdirSync(parent)) {
        const candidate = path.join(parent, sibling);
        if (candidate !== base && fs.existsSync(path.join(candidate, '.git'))) add(candidate);
      }
    } catch { /* ignore */ }
  }
  return roots;
}

function storyRequiresRuntimeEvidenceCheck(content) {
  // Misma heurística que on-frontmatter-write.js#storyRequiresRuntimeEvidence
  if (!content) return false;
  return /tests_done_playwright|tests_done_smoke|smoke.*runtime|FullUI-|E2E-|tests\/e2e\/|verify.*runtime|playwright/i.test(content);
}

function storyNeedsPlaywrightCheck(content) {
  if (!content) return false;
  return /\b(FullUI-\d|E2E-\d|E\d+-[a-z])/.test(content) ||
         /tests_done_playwright_spec/.test(content) ||
         /tests\/e2e\//.test(content);
}

function storyIsExemptCheck(content) {
  return /^\s*dod_runtime_exempt:\s*true\b/m.test(content || '');
}

function computePreflightFrontmatter({ storyPath, targetStatus, targetPipelineDone, repo }) {
  if (!storyPath || !fs.existsSync(storyPath)) {
    return { error: 'storyPath inválido o no existe', storyPath };
  }
  const content = fs.readFileSync(storyPath, 'utf8');
  const fm = parseFrontmatterPipeline(content);
  const storyId = fm.story || path.basename(storyPath, '.md');

  // ¿La transición target dispara el gate?
  const targetIsReviewDone = ['review', 'done'].includes(targetStatus);
  const statusTransition = targetIsReviewDone && fm.status !== targetStatus;
  const pipelineTransition = !!targetPipelineDone;
  const triggersGate = statusTransition || pipelineTransition;

  if (!triggersGate) {
    return {
      story_id: storyId,
      story_path: storyPath,
      target_state: { status: targetStatus, pipeline_done: targetPipelineDone },
      ready_to_edit: true,
      preconditions: [],
      reason: 'Target state NO dispara el gate DoD (status actual ya es target / no es review-done / pipeline-done no declarado).',
    };
  }

  // Exención explícita
  if (storyIsExemptCheck(content)) {
    return {
      story_id: storyId,
      story_path: storyPath,
      target_state: { status: targetStatus, pipeline_done: targetPipelineDone },
      ready_to_edit: true,
      preconditions: [],
      reason: 'Story tiene dod_runtime_exempt: true — gate bypass válido.',
    };
  }

  // ¿Story declara runtime tests?
  if (!storyRequiresRuntimeEvidenceCheck(content)) {
    return {
      story_id: storyId,
      story_path: storyPath,
      target_state: { status: targetStatus, pipeline_done: targetPipelineDone },
      ready_to_edit: true,
      preconditions: [],
      reason: 'Story NO declara runtime tests (sin tests_done_*, sin E2E, sin tests/e2e/). Gate no aplica.',
    };
  }

  // Computar pre-condiciones
  const preconditions = [];
  const repoRoots = findRepoRootsForStory(storyPath, repo);
  const candidateDirs = repoRoots.map((r) => path.join(r, '.advisors', 'dod-runtime'));
  // El destino canónico de la evidencia: el repo de la STORY. Es el que le va a
  // pedir el portón de CI, así que el "cómo satisfacerla" apunta ahí y no a un `<repo>` genérico.
  const evidDir = evidenceDirForStory(storyPath, repo).dir || '<repo>/.advisors/dod-runtime';

  // Pre-condition 1: evidence file existe — buscada por la CLAVE de la story: con un número
  // repetido en el repo, `<id>-*` es la evidencia de cualquiera de las stories que lo comparten.
  const evKey = evidenceKeyOr(storyPath, storyId);
  const evPrefix = evKey.key ? `${evKey.key}-` : null;
  const evidenceFiles = [];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !evPrefix) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(evPrefix) && f.endsWith('.md')) {
          evidenceFiles.push(path.join(dir, f));
        }
      }
    } catch { /* ignore */ }
  }
  const evidenceExists = evidenceFiles.length > 0;
  preconditions.push({
    id: 'PRE-1-evidence-file-exists',
    type: 'file_exists',
    description: evKey.key
      ? `DoD runtime evidence file ${evKey.key}-*.md en alguno de los .advisors/dod-runtime/ de los repos hermanos.`
      : `DoD runtime evidence: no se pudo calcular la clave de la story (${evKey.error}) — sin clave no se da evidencia por buena.`,
    candidate_dirs: candidateDirs,
    found_at: evidenceFiles,
    satisfied: evidenceExists,
    blocking_hook: 'on-frontmatter-write.js + on-pre-commit.js + hook-pre-edit.js',
    how_to_satisfy: evidenceExists
      ? null
      : `Correr: node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/step-7c-macro.js --story ${storyPath} --scenario <scenario.json> --evidence-dir ${evidDir}  (o escribir el archivo manualmente con formato hook-compliant — ver PRE-2)`,
  });

  // Pre-condition 2: si la story declara E2E reales, el evidence debe tener
  // bloque "## Playwright Run" + verdict=PASS + failed=0 (macro) o "- failed: 0" (e2e-gate.sh
  // genérico) — mismo regex que on-frontmatter-write.js, para que el contrato no derive.
  const needsPlaywright = storyNeedsPlaywrightCheck(content);
  if (needsPlaywright) {
    const requiredLiterals = ['## Playwright Run', 'verdict=PASS', 'failed=0 | - failed: 0'];
    let satisfied = false;
    let matchingFile = null;
    for (const f of evidenceFiles) {
      try {
        const c = fs.readFileSync(f, 'utf8');
        if (/##\s*Playwright Run/i.test(c) && /verdict=PASS/.test(c) && /failed(?:=|:\s*)0\b/.test(c)) {
          satisfied = true;
          matchingFile = f;
          break;
        }
      } catch { /* ignore */ }
    }
    preconditions.push({
      id: 'PRE-2-playwright-run-literals',
      type: 'file_contains_all_literals',
      description: 'Evidence file debe contener bloque "## Playwright Run" con substrings literales (regex del hook: `/##\\s*Playwright Run/i` + `/verdict=PASS/` + `/failed(?:=|:\\s*)0\\b/` — acepta el macro y el gate genérico).',
      required_literals: requiredLiterals,
      file_pattern: `${evKey.key || '<clave>'}-*.md en .advisors/dod-runtime/`,
      satisfied,
      satisfied_by: matchingFile,
      blocking_hook: 'on-frontmatter-write.js (story declara E2E: FullUI-/E2E-/tests_done_playwright_spec/tests/e2e/)',
      how_to_satisfy: satisfied
        ? null
        : 'Si la story tiene E2E reales en pipeline activo: correr el gate E2E del PROYECTO (.tycon/advisors.yaml → e2e.gate; resolver con `pipeline.js e2e-config --repo <repo>` → `bash <gate> <frontend_dir> ' + storyPath + ' ' + evidDir + '`). Si los E2E están en pipeline B-frontend pending: agregar al evidence el bloque siguiente vacuamente:\n\n```\n## Playwright Run\n\nverdict=PASS failed=0 passed=0 skipped=0\n\n**Rationale**: E2E declarados en pipelines.B-frontend (status: pending) — diferidos. Vacuamente PASS para este pipeline.\n```',
    });
  }

  const unsatisfied = preconditions.filter((p) => !p.satisfied);
  return {
    story_id: storyId,
    story_path: storyPath,
    target_state: { status: targetStatus, pipeline_done: targetPipelineDone },
    triggers_gate: { status_transition: statusTransition, pipeline_transition: pipelineTransition },
    needs_playwright_block: needsPlaywright,
    ready_to_edit: unsatisfied.length === 0,
    preconditions,
    summary: unsatisfied.length === 0
      ? `✅ ${preconditions.length}/${preconditions.length} pre-condiciones satisfechas. Safe to write target state.`
      : `🛑 ${unsatisfied.length}/${preconditions.length} pre-condiciones NO satisfechas. Resolver ANTES del Edit (sino el hook bloquea + retry de ~30-60s).`,
  };
}

// ── Advisor context compartido ────────────────────────
// Si cada advisor del fan-out re-descubriera el mismo contexto: ~5-6 releerían la
// story completa (15-18K tokens en stories grandes) + cada uno correría su git diff.
// Esto genera UN artefacto por iteración con: digest de la story (solo las
// secciones operativas — sin Dev Notes/Change Log/narrativa), la lista de files
// y el diff unificado con hunks. Los advisors lo reciben como input primario;
// los que necesitan la story completa (spec-first; los de paquetes con `needsStory`,
// listados en `story_path_para` de la salida) siguen recibiendo además el story_path.
const KEEP_SECTION_RE = /tasks|file list|scope|qué hay que hacer|que hay que hacer|cómo verificar|como verificar|lo que no hay que hacer|patrón de referencia|patron de referencia|pipelines/i;

// Los criterios y la tabla de pruebas van enteros, como los lee story-checks.js: recortados por títulos, los criterios
// escritos con `### AC-1` y los que llevan un `#` dentro de un bloque de código quedarían afuera del resumen que
// reciben los revisores.
function buildStoryDigest(storyContent) {
  if (!storyContent) return '';
  const sc = require('./lib/story-checks.js');
  const fmMatch = storyContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const fm = fmMatch ? fmMatch[0] : '';
  const body = storyContent.slice(fm.length);
  const lines = body.split('\n');
  const out = [];
  let keeping = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      keeping = KEEP_SECTION_RE.test(h[2]);
    }
    if (keeping) out.push(line);
  }
  for (const kind of ['criteria', 'tests']) {
    const s = sc.storySection(storyContent, kind);
    if (s) out.push('', s.title, s.text);
  }
  return fm + out.join('\n');
}

function buildAdvisorContext({ repo, story, files, iter }) {
  const sid = sessionIdFileKey();
  const ctxDir = path.join(stateDirOf(os.homedir()), 'advisor-context');
  const outPath = path.join(ctxDir, `${sid}-iter${iter || 1}.md`);
  // Las reglas propias del repo (sección `## Reglas para revisores` de su CLAUDE.md)
  // van AL PRINCIPIO del contexto, marcadas como reglas a verificar. Sin sección, el archivo queda
  // byte a byte igual. La lectura nunca tira (lib/reviewer-rules.js).
  const reglas = reglasRevisores(repo);
  const bloqueReglas = bloqueParaContexto(reglas);
  try {
    fs.mkdirSync(ctxDir, { recursive: true });
    const { execFileSync } = require('child_process');
    const storyContent = story ? readText(story) : '';
    const digest = buildStoryDigest(storyContent);
    // ── El diff POR REPO ─────────────────────────────────────────────────────────────────────────
    // Un solo `git -C repo diff HEAD -- <todas las rutas>` fallaría: con UNA ruta del repo hermano, git sale con
    // «… is outside repository» y se perdería el diff de TODOS los archivos, también los del repo; el texto de reemplazo
    // diría «repo sin git» y un revisor lo repetiría como causa.
    // Por eso los archivos se agrupan por su repo git; el del `--repo` va como siempre y cada
    // hermano en su propia sección, con sus archivos escritos `(<nombre>) <ruta>`, la forma del step-05b. Si git falla
    // en un repo, se dice cuál y por qué, y los demás conservan su diff.
    const grupos = companionLib.groupByRepo(files, repo);
    const propios = grupos.filter((g) => g.propio).flatMap((g) => g.files.map((x) => x.original));
    const hermanos = grupos.filter((g) => !g.propio);
    const gitDiff = (cwd, rutas) => {
      const r = require('child_process').spawnSync('git', ['-C', cwd, 'diff', 'HEAD', '--', ...rutas], {
        encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.error || r.status !== 0) {
        const motivo = String((r.stderr || '').split('\n').find((l) => l.trim()) || (r.error && r.error.message) || `salió ${r.status}`).trim();
        return { text: '', error: motivo };
      }
      return { text: r.stdout || '', error: null };
    };
    // Con `--files` vacío el alcance es el working tree entero del repo (como siempre). Con `--files` sólo del
    // hermano, el repo no aporta diff: un `git diff HEAD --` sin rutas traería todo el working tree, que nadie pidió.
    const principal = files.length && !propios.length
      ? { text: '', error: null, sinArchivos: true }
      : gitDiff(repo, propios.map((f) => (path.isAbsolute(f) ? f : path.join(repo, f))));
    const rawDiff = principal.text;

    // ── Cap POR ARCHIVO, no global ────────────────────────
    // Un `.slice(0, 150000)` global cortaría por la cola A MITAD DE UN HUNK y en
    // silencio: los últimos archivos del diff desaparecerían y el advisor auditaría creyendo
    // que vio todo. Por ejemplo,
    // tycon-plugin-tests-coverage reportaría "`parallel-gateway.test.js` T10 queda truncado a
    // mitad de un assert.ok; no puedo confirmar que cubra los edge cases que declara".
    // Es truncación silenciosa, la misma clase que se evita en
    // la sección de untracked, aplicada al diff, que es el grueso del payload.
    // Por eso: cap por archivo + cap global que descarta ARCHIVOS ENTEROS, nunca media línea,
    // y todo lo recortado queda LISTADO explícito para que el advisor sepa qué abrir.
    const PER_FILE_CAP = 12000;
    const DIFF_TOTAL_CAP = 150000;
    const trocear = (texto, etiqueta) => {
      const out = [];
      for (const chunk of texto.split(/(?=^diff --git )/m)) {
        if (!chunk.trim()) continue;
        const m = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
        const file = m ? m[2] : null;
        out.push({ file: file && etiqueta ? `(${etiqueta}) ${file}` : file, text: chunk, grupo: null });
      }
      return out;
    };
    const diffChunks = trocear(rawDiff, null);
    // Los hermanos, cada uno con su git. `seccionesHermanos` conserva el orden y el error de cada uno.
    const seccionesHermanos = hermanos.map((g, i) => {
      const etiqueta = g.root ? companionLib.label(g.root) : null;
      if (!g.root) return { etiqueta: null, root: null, error: 'no están dentro de ningún repo git', files: g.files, diff: '' };
      const d = gitDiff(g.root, g.files.map((x) => x.abs));
      diffChunks.push(...trocear(d.text, etiqueta).map((c) => ({ ...c, grupo: i })));
      return { etiqueta, root: g.root, error: d.error, files: g.files, diff: '' };
    });
    const truncatedFiles = [];   // recortados a PER_FILE_CAP
    const droppedFiles = [];     // no pegados por cap global
    let diff = '';
    let pegado = 0;              // el cap global cuenta TODOS los repos juntos
    for (const c of diffChunks) {
      if (pegado >= DIFF_TOTAL_CAP) {
        droppedFiles.push(c.file || '(chunk sin archivo)');
        continue;
      }
      let text = c.text;
      if (text.length > PER_FILE_CAP) {
        // cortar en el último salto de línea antes del cap: nunca a mitad de línea
        const cut = text.lastIndexOf('\n', PER_FILE_CAP);
        text = text.slice(0, cut > 0 ? cut : PER_FILE_CAP) +
          `\n[… hunk recortado a ${Math.round(PER_FILE_CAP / 1000)}K — el archivo sigue; abrilo con Read si tu auditoría lo necesita]\n`;
        truncatedFiles.push(c.file || '(chunk sin archivo)');
      }
      pegado += text.length;
      if (c.grupo !== null) seccionesHermanos[c.grupo].diff += text;
      else diff += text;
    }
    if (!diffChunks.some((c) => c.grupo === null)) {
      diff = principal.error ? `(repo \`${companionLib.label(repo)}\`: git falló — ${principal.error})`
        : principal.sinArchivos ? '(ningún archivo de `--files` es de este repo: el cambio está en los repos hermanos, abajo)'
          : '(git diff vacío — sin cambios trackeados en estos archivos; los nuevos sin seguimiento van más abajo)';
    }

    // Lista de archivos REAL: la que se muestra sale del diff + los untracked, no del
    // `--files` recibido. Si `--files` viene vacío, el encabezado diría
    // "Archivos del diff (0)" con 42 archivos adentro. Esa
    // lista es la ÚNICA red de seguridad del context — es lo que le permite al advisor
    // saber qué existe y abrirlo. Vacía, el escape no existe.
    const filesFromDiff = diffChunks.map((c) => c.file).filter(Boolean);
    const git = gitAddedLinesByFile(repo);
    // Si `--files` vino vacío, el scope real del context es "todo el working tree" (que es
    // lo que el `git diff HEAD` de arriba ya devolvió) — así que los untracked también salen
    // de git, no de la lista vacía. Los caps de abajo siguen gobernando el peso.
    const untrackedCandidates = files.length ? propios : [...git.untracked];
    // `{ nombre, abs }`: el nombre es como se lista (relativo al repo, o `(<hermano>) <ruta>` para los del hermano).
    const untrackedInDiff = untrackedCandidates.filter((f) => {
      const rel = path.isAbsolute(f) ? path.relative(repo, f) : f;
      return git.untracked.has(rel);
    }).map((f) => ({ nombre: path.isAbsolute(f) ? path.relative(repo, f) : f, abs: path.isAbsolute(f) ? f : path.join(repo, f) }));
    // Los nuevos sin seguimiento de cada hermano, con el git de SU repo.
    const hermanosSinNuevos = [];   // hermanos cuyo git no pudo listar sus archivos nuevos: se dice, no se calla
    for (const s of seccionesHermanos) {
      if (!s.root) continue;
      const gh = gitAddedLinesByFile(s.root);
      if (!gh.gitOk) { hermanosSinNuevos.push(s.etiqueta); continue; }
      for (const x of s.files) if (gh.untracked.has(x.rel)) untrackedInDiff.push({ nombre: `(${s.etiqueta}) ${x.rel}`, abs: x.abs });
    }
    // Cap del payload: un context de 147KB (22 archivos con contenido completo, incl. CLAUDE.md y otra story .md)
    // que viaja a 41 spawns son ~1.5M tokens SOLO de payload repetido. Reglas: (a) contenido
    // completo SOLO para archivos de CÓDIGO nuevos (los .md/docs ya viajan vía story
    // digest o no son surface de los advisors — Read on demand); (b) cap GLOBAL
    // además del cap por archivo; (c) lo omitido queda LISTADO explícito (nunca
    // truncación silenciosa — el advisor sabe qué leer con Read si lo necesita).
    // código (lib/code-files.js, con lo que sume la organización) más lo que el revisor necesita leer entero
    const CODE_FULL_RE = { test: (f) => codeFiles.isCode(f, { extra: stackConfig.orgExtra() }) || /\.(sql|json|ps1|razor)$/i.test(f) };
    const UNTRACKED_TOTAL_CAP = 100000;
    let untrackedSection = '';
    const omittedFromContext = [];
    for (const { nombre: f, abs } of untrackedInDiff) {
      if (!CODE_FULL_RE.test(f)) {
        omittedFromContext.push(`${f} (no-código — usar Read si tu audit lo necesita)`);
        continue;
      }
      if (untrackedSection.length >= UNTRACKED_TOTAL_CAP) {
        omittedFromContext.push(`${f} (cap global ${Math.round(UNTRACKED_TOTAL_CAP / 1000)}K del context alcanzado — usar Read)`);
        continue;
      }
      const c = readText(abs).slice(0, 30000);
      if (c) untrackedSection += `\n### ${f} (archivo NUEVO — contenido completo)\n\n\`\`\`\n${c}\n\`\`\`\n`;
    }
    for (const h of hermanosSinNuevos) {
      omittedFromContext.push(`(repo hermano \`${h}\`: git no pudo listar sus archivos nuevos sin seguimiento — si la story crea alguno ahí, abrilo con Read)`);
    }
    if (omittedFromContext.length) {
      untrackedSection += `\n### Archivos del diff NO incluidos en este context (leélos con Read si tu audit los necesita)\n\n` +
        omittedFromContext.map((o) => `- ${o}`).join('\n') + '\n';
    }
    // Lista mostrada = unión de lo que el caller pidió + lo que el diff realmente trajo +
    // los untracked. Nunca puede quedar vacía teniendo contenido adentro.
    const shownFiles = [...new Set([
      ...propios.map((f) => (path.isAbsolute(f) ? path.relative(repo, f) : f)),
      ...seccionesHermanos.flatMap((s) => s.files.map((x) => (s.root ? `(${s.etiqueta}) ${x.rel}` : x.original))),
      ...filesFromDiff,
      ...untrackedInDiff.map((u) => u.nombre),
    ])].filter(Boolean).sort();
    // Una sección por hermano, después del diff del repo.
    const bloquesHermanos = seccionesHermanos.flatMap((s) => [
      '',
      s.root ? `## Diff del repo hermano \`${s.etiqueta}\` (git diff HEAD en ${s.root})` : '## Archivos fuera de todo repo git',
      '',
      '```diff',
      s.diff || (!s.root ? `(${s.files.map((x) => x.original).join(', ')}: ${s.error})`
        : s.error ? `(repo hermano \`${s.etiqueta}\`: git falló — ${s.error})`
          : '(git diff vacío — sin cambios trackeados en estos archivos; los nuevos sin seguimiento van más abajo)'),
      '```',
    ]);

    const recorteSection = [];
    if (truncatedFiles.length || droppedFiles.length) {
      recorteSection.push('', '## Qué de este diff quedó recortado (abrilo con Read si tu auditoría lo necesita)', '');
      if (truncatedFiles.length) {
        recorteSection.push(`**Recortados a ${Math.round(PER_FILE_CAP / 1000)}K** (el hunk sigue en el archivo):`, '');
        recorteSection.push(...truncatedFiles.map((f) => `- ${f}`), '');
      }
      if (droppedFiles.length) {
        recorteSection.push(`**No pegados** (cap global de ${Math.round(DIFF_TOTAL_CAP / 1000)}K alcanzado):`, '');
        recorteSection.push(...droppedFiles.map((f) => `- ${f}`), '');
      }
    }

    const content = [
      `# Advisor context — iter ${iter || 1}`,
      '',
      `> Artefacto generado por pipeline.js (1 vez por iteración). Es tu input primario:`,
      `> contiene el digest de la story (secciones operativas), la lista de archivos del`,
      `> diff y los hunks. Leé archivos completos SOLO si necesitás contexto adicional.`,
      `> Lo que quedó recortado está LISTADO — si una regla tuya depende de algo que no`,
      `> está pegado acá, abrí ese archivo en vez de darla por evaluada.`,
      '',
      `## Archivos del diff (${shownFiles.length})`,
      '',
      ...shownFiles.map((f) => `- ${f}`),
      '',
      '## Story digest (frontmatter + ACs + Tests + Tasks + verificación)',
      '',
      digest || '(sin story)',
      '',
      '## Diff unificado (git diff HEAD)',
      '',
      '```diff',
      diff || '(vacío)',
      '```',
      ...bloquesHermanos,
      ...recorteSection,
      untrackedSection,
    ].join('\n');
    fs.writeFileSync(outPath, bloqueReglas + content, 'utf8');

    // ── Context recortado para `tycon-story-validator` ─────────
    // Único recorte por advisor que se cablea, y por qué SOLO éste:
    //   - Paga en TODO stack: -44% de tokens medido en un backend .NET, donde el recorte
    //     general no ahorra NADA (todo el diff es código y le corresponde a todos).
    //   - Es el advisor que más corre: 90 de 96 iteraciones registradas.
    //   - Su superficie real es la STORY, no el código: valida frontmatter, ACs, tests,
    //     back-links. Del diff sólo necesita una cosa —VAL-C5, marcas de deuda abierta.
    // Un A/B mostró las dos caras: con el recorte encontró UN HALLAZGO MÁS
    // que con el contexto completo (VAL-W13, bloque bash vacío — menos ruido, más atención),
    // pero darle la story y CERO código lo cegaría para VAL-C5.
    // Por eso el filtro es POR CONTENIDO (líneas agregadas con marcas de deferral), no por
    // tipo de archivo: conserva la regla y sigue recortando ~85% de un diff de 42 archivos.
    const DEFERRAL_RE = /TODO\(Story|FIXME:\s*Story|HACK:\s*Story|\[DEF-|DEFERRED-|deferral|pendiente\s+Story/i;
    const chunksConDeuda = [];
    const chunksSinDeuda = [];
    for (const c of diffChunks) {
      const added = c.text.split('\n').filter((l) => l.startsWith('+')).join('\n');
      (DEFERRAL_RE.test(added) ? chunksConDeuda : chunksSinDeuda).push(c);
    }
    const svPath = path.join(ctxDir, `${sid}-iter${iter || 1}-tycon-story-validator.md`);
    const svContent = [
      `# Advisor context — iter ${iter || 1} · recortado para \`tycon-story-validator\``,
      '',
      '> Tu superficie es la STORY, no el diff. Acá está el digest completo de la story, la',
      '> lista COMPLETA de archivos del diff, y —para VAL-C5— **sólo los hunks cuyas líneas',
      '> agregadas contienen marcas de deuda diferida**. Los demás hunks NO están pegados',
      '> a propósito: si una regla tuya depende de uno, abrilo con Read en vez de darla por',
      '> evaluada. NO asumas "sin deuda" por ausencia de hunks: los que traen marcas están',
      '> todos acá; los otros fueron descartados por un filtro de contenido, no por muestreo.',
      '',
      `## Archivos del diff (${shownFiles.length})`,
      '',
      ...shownFiles.map((f) => `- ${f}`),
      '',
      '## Story digest (frontmatter + ACs + Tests + Tasks + verificación)',
      '',
      digest || '(sin story)',
      '',
      `## Hunks con marcas de deuda diferida (VAL-C5) — ${chunksConDeuda.length} de ${diffChunks.length} archivos`,
      '',
      '```diff',
      chunksConDeuda.length ? chunksConDeuda.map((c) => c.text).join('') : '(ningún archivo del diff agrega marcas de deuda)',
      '```',
      '',
      `## Archivos del diff sin marcas de deuda (${chunksSinDeuda.length}) — no pegados, abrilos con Read si los necesitás`,
      '',
      ...chunksSinDeuda.map((c) => `- ${c.file || '(chunk sin archivo)'}`),
      '',
      ...recorteSection,
    ].join('\n');
    try { fs.writeFileSync(svPath, bloqueReglas + svContent, 'utf8'); } catch { /* best-effort */ }

    return { context_file: outPath, overrides: { 'tycon-story-validator': svPath }, reglas };
  } catch {
    return null; // best-effort: sin contexto compartido, cada advisor descubre el contexto por su cuenta
  }
}

// ── Frontmatter helpers para next/start/risk-class ───────────────────────────
// parseFrontmatterPipeline (más abajo) es single-line; esto extrae LISTAS yaml
// (`files_to_modify:` seguido de `  - path`) del frontmatter.
function parseFrontmatterList(content, key) {
  const m = (content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const out = [];
  let inKey = false;
  let keyIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (!inKey) {
      const km = line.match(new RegExp(`^(\\s*)${key}\\s*:\\s*$`));
      if (km) { inKey = true; keyIndent = km[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    if (indent <= keyIndent) break;
    const im = line.match(/^\s*-\s*(.+?)\s*$/);
    if (im) out.push(im[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

// ── pipeline.js next — máquina de estados incremental ─────────────
// Primer comando de la máquina de estados: el LLM sigue siendo el loop
// pero le PREGUNTA al script cuál es el próximo step y qué
// skip-conditions se cumplen mecánicamente, en vez de derivarlo de la prosa del
// SKILL (fuente de los skips-por-inferencia E.i).
// La secuencia sale de la tabla única de pasos: los trece que recorre `next`, sin el 7b ni el 9.
const STEPS_TABLE = require('./lib/steps.js');
const STEP_SEQUENCE = STEPS_TABLE.STEPS.filter((s) => s.inSequence !== false).map(({ id, file }) => ({ id, file }));
const STEPS_DIR = path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'steps');
// Sub-steps que se cierran con un marker FLAG (no con complete-step N): computeNext lo usa para el hint.
const SUBSTEP_FLAG = { '0b': 'workSignalStarted', '0c': 'adoMarkedActive', '5b': 'deepReviewDone' };
// El nombre viejo de una bandera, que todavía puede traer el marker de una corrida en vuelo: también da el sub-paso por hecho.
const SUBSTEP_OLD_FLAG = { '0b': 'clockiStarted' };
// El 5b NO se cierra con `set-flag`: `deepReviewDone` la escriben sólo los dos comandos
// que dejan constancia. `SUBSTEP_FLAG` dice QUÉ bandera mira `next` para darlo por hecho;
// el texto le dice al orquestador cómo cerrarlo — sin esto, `next` mandaría a correr un
// comando que sale 2.
// ¿La story lleva maqueta? Con la detección de la revisión de la pantalla (mockup.screenStory, perezoso).
// Ante un error, el que frena «no pude leer la story» es `complete-step 3`, no este texto.
function storyNeedsMockup(storyPath) {
  try { return !!storyPath && require('./mockup.js').screenStory(storyPath).screen === true; } catch { return false; }
}
function notaCierre3(marker) {
  // una ruta relativa se resuelve contra el repo del marcador, como hace marker.js
  const sp = marker && marker.storyPath;
  const abs = sp && !path.isAbsolute(sp) ? path.join(marker.repoPath || process.cwd(), sp) : sp;
  const maqueta = storyNeedsMockup(abs)
    ? ' + --mockup-approved "<cita: quién aprobó la maqueta y por qué vía>" (story con pantalla: la maqueta la ve una persona, también con LOW — steps/step-03-hitl-plan.md §La maqueta)'
    : '';
  return `marker.js complete-step 3 --approved "<cita textual de la aprobación del user>" (Nivel 2 LOW-risk: --auto-approved "<criterios>")${maqueta}. Hasta entonces el portón de carril DENIEGA cualquier Edit/Write de código`;
}
const NOTA_CIERRE_5B = 'si el pase corrió, marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> '
  + '--tests <k> [--own <p> --in "<rutas>"] [--deferred <d> --reason "…"]; si no corre, marker.js mark-adversarial-skipped '
  + '--files <archivos de código del diff> (lo decide el portón). Los dos cierran el pase adversarial (la bandera ya no se escribe a mano)';
// El 7c tampoco se cierra con `complete-step`, ni se saltea en silencio. El cierre del paso 8 exige
// `dodRuntimeChecked` SIEMPRE —la story exenta la deja con «exenta: …»—, así que `next` no puede dar el 7c por
// salteado y mandar al 8: chocaría contra ese freno después de obedecer a `next`. El motivo mecánico del salteo sigue a la vista en `skip_mechanical`.
const NOTA_CIERRE_7C = 'marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"<ruta de la evidencia>"}\'';
const NOTA_7C_EXENTA = 'La story está exenta de la verificación en vivo (dod_runtime_exempt: true): no hay nada que correr, pero el cierre '
  + 'de «Preparar el commit» pide su constancia. Dejala con: marker.js mark-dod-runtime-checked \'{"verdict":"PASS","evidencePath":"exenta: <la razón del frontmatter>"}\'.';

/**
 * Qué le falta al pase adversarial, para `next`. Sólo con el paso 4 cerrado.
 *
 * El lanzamiento temprano es un párrafo del paso 4 que el agente no recuerda por sí solo (52 de 208 corridas con pase
 * lo lanzaron más de 2 minutos después del primer revisor): `next` lo pide, ANTES del primer revisor, con el
 * veredicto que el portón dejó anotado (`adversarialGate`): no lo recalcula, porque no tiene los archivos del cambio.
 * Sin veredicto, lo que pide es consultar el portón —la falta de veredicto no es «no corre»—.
 *
 * Nunca pide relanzar un pase atendido (relanzar uno cerrado bloquea el paso 8), y ante un lanzamiento de otra sesión
 * sin resultado aplica la regla de `lib/adversarial-verdict.js` sin preguntarle a nadie.
 * → `{ pending_action?: { kind, message, command?, rule?, why? }, adversarial_note?: string }`
 */
function accionDelPase(marker, story, { sidNow, nextStep } = {}) {
  const { veredictoPaseAdversarial, paseAtendido, reglaPaseAjeno } = require('./lib/adversarial-verdict.js');
  const v = veredictoPaseAdversarial(marker);
  if (v.motivo === 'pase-no-medido') {
    // El pase corrió y no revisó todo. No está atendido: se relanza (y en el mismo turno, --relaunch).
    const { SALIDA_APROBADA } = require('./lib/adversarial-verdict.js');
    const p = v.pase || {};
    return {
      pending_action: {
        kind: 'relanzar-pase-no-medido',
        message: `el pase adversarial quedó NO MEDIDO (${p.motivo_no_medido || 'no revisó todo'}; resultado en ${p.resultado || '?'}): relanzalo en su paso (5b) y anotalo con mark-adversarial-launched <runId> 5b --relaunch. Si Codex no contesta y no hay herramienta Workflow: ${SALIDA_APROBADA}.`,
      },
    };
  }
  if (paseAtendido(v)) {
    const skip = marker.adversarialSkip || {};
    if (v.motivo === 'abandonado' || skip.abandonado === true) {
      return { adversarial_note: `pase adversarial ABANDONADO con el interruptor (runId ${skip.runId || v.runId || '?'}), queda en bypass.log — no se pide lanzarlo` };
    }
    if (v.motivo === 'salteado-forzado') return { adversarial_note: 'salteo FORZADO, queda en bypass.log — no se pide lanzar el pase' };
    return {};
  }
  const adv = marker.adversarial && typeof marker.adversarial === 'object' ? marker.adversarial : null;
  if (adv && adv.sessionId !== sidNow) return { pending_action: reglaPaseAjeno(adv) };
  if (adv) return {};   // lanzado por esta sesión y en vuelo: el join es el paso del pase (5b)

  if (!marker.storyPath) {
    return { adversarial_note: 'no pude leer la story: el marcador está sin ruta de story — no se pide lanzar el pase (el portón la necesita)' };
  }
  if (!story) {
    return { adversarial_note: `no pude leer la story (${marker.storyPath}) — no se pide lanzar el pase (el portón la necesita)` };
  }

  const gate = marker.adversarialGate && typeof marker.adversarialGate === 'object' ? marker.adversarialGate : null;
  if (gate && gate.early_launch === false) {
    return { adversarial_note: `lanzamiento temprano APAGADO para esta corrida (${gate.early_origin || 'TYCON_5B_EARLY=0'}): el pase se lanza en su paso (5b)` };
  }
  const yo = path.join(__dirname, 'pipeline.js');
  if (!gate || typeof gate.run !== 'boolean') {
    const command = `node ${yo} deep-review-gate --repo ${marker.repoPath || '<repo>'} --story ${marker.storyPath} --files <archivos de código del diff>`;
    return {
      pending_action: {
        kind: 'consultar-porton',
        message: `falta el veredicto del portón del pase adversarial — consultalo con los MISMOS archivos que vas a pasar a los revisores: ${command}`,
        command,
      },
    };
  }
  if (gate.run !== true) return {};
  const archivos = Array.isArray(gate.files) ? gate.files : [];
  const cuando = String(nextStep) === '5' ? 'AHORA, antes del primer revisor' : 'AHORA';
  return {
    pending_action: {
      kind: 'lanzar-pase',
      message: `el portón dice que el pase CORRE (${archivos.length} archivo(s)): lanzalo ${cuando} — tool Workflow con los args de step-05b-adversarial-verify.md §Acción y esos archivos — y en el mismo turno: node ${path.join(__dirname, 'marker.js')} mark-adversarial-launched <runId> 4`,
      files: archivos,
    },
  };
}

/**
 * Lo que cambia en el paso por el tamaño de la corrida, o null. Paso 4 de una liviana: las tandas van
 * juntas. Paso 8 de una liviana: no se pide la validación pesada del repo, salvo que el dev la haya nombrado
 * (`marker.js set-flag heavyValidationRequested true`).
 */
function notaDelTamano(marker, nextStep) {
  if (!marker || marker.size !== 'liviana' || !nextStep) return null;
  if (String(nextStep.step) === '4') return 'Corrida liviana: las tandas van juntas en esta corrida (una sola implementación, una sola vuelta de pruebas).';
  if (String(nextStep.step) === '8') {
    return marker.heavyValidationRequested
      ? 'Corrida liviana, pero el dev nombró la validación pesada del repo: pedila antes del merge.'
      : 'Corrida liviana: no pidas la validación pesada del repo; se corre sólo si el dev la nombra (marker.js set-flag heavyValidationRequested true).';
  }
  return null;
}

function computeNext() {
  const marker = readSessionMarker();
  if (!marker || !marker.storyId) {
    return { error: 'sin marker activo en esta sesión — arrancá con `pipeline.js start --story <spec> --repo <dir>` (o marker.js set en el «Arranque»)' };
  }
  const story = marker.storyPath ? readText(marker.storyPath) : '';
  const fm = parseFrontmatterPipeline(story);
  const completedNums = new Set((marker.stepsCompleted || []).map(String));

  const stepState = [];
  let nextStep = null;
  let timeTool;
  for (const s of STEP_SEQUENCE) {
    let done = false;
    let skip = null;
    if (s.id === '0b') {
      done = marker[SUBSTEP_FLAG['0b']] === true || marker[SUBSTEP_OLD_FLAG['0b']] === true;
      // Sin herramienta de horas elegida (ninguna, una desconocida o una con el manifiesto roto) el paso dice «saltear»
      // con el motivo; `next` lo repetiría hasta una bandera que dejaría dicho «aviso dado» sin aviso.
      // `harnessTimeTool` es null si no se sabe (sin arnés o configuración rota): ahí, el texto general.
      if (!done && timeTool === undefined) timeTool = harnessTimeTool();
      if (!done && timeTool && !timeTool.chosen) skip = `${timeTool.reason} — skip-condition documentada del step`;
    } else if (s.id === '0c') {
      done = marker.adoMarkedActive === true;
      if (!done && story && !require(path.join(packsLib.raizAgentSkills(), 'scripts', 'lib', 'platform', 'work-item-field.js')).idOf(fm)) {
        skip = 'frontmatter sin work_item: — skip-condition documentada del step (verificable)';
      }
    } else if (s.id === '5b') {
      // deepReviewDone lo setea el orquestador SIEMPRE que manejó el step (corrió el workflow O
      // el gate dio run:false → skip). El skip real lo decide `deep-review-gate` (necesita --files,
      // que computeNext no tiene), por eso acá no se recomputa: el flag marca "5b atendido".
      done = marker.deepReviewDone === true;
    } else if (s.id === '7c') {
      done = marker.dodRuntimeChecked === true;
      if (!done && story) {
        if (storyIsExemptCheck(story)) skip = 'dod_runtime_exempt: true en frontmatter';
        else if (!storyRequiresRuntimeEvidenceCheck(story)) skip = 'story NO declara runtime tests (sin tests_done_*, sin E2E, sin tests/e2e/)';
      }
    } else {
      done = completedNums.has(s.id);
    }
    const entry = { step: s.id, name: STEPS_TABLE.stepName(s.id), file: path.join(STEPS_DIR, s.file), done, ...(skip ? { skip_mechanical: skip } : {}) };
    stepState.push(entry);
    // El 7c es el único sub-paso cuyo salteo deja constancia: sin ella el paso 8 no cierra (ver NOTA_CIERRE_7C).
    if (!nextStep && !done && (!skip || s.id === '7c')) nextStep = entry;
  }
  const exempt7c = !!nextStep && nextStep.step === '7c' && storyIsExemptCheck(story);

  // Pre-condiciones del next conocidas por el script.
  const preconditions = [];
  if (nextStep && nextStep.step === '8') {
    preconditions.push({ id: 'dodRuntimeChecked', satisfied: marker.dodRuntimeChecked === true, detail: '«Probar en vivo» debe haber pasado (marker.dodRuntimeChecked)' });
    const checks = marker.checks || {};
    for (const c of ['build', 'tests', 'advisors']) {
      // «sin-acotar» (tests) se acepta anunciándolo: la cubre la CI del pedido (complete-step 4 lo dijo y lo anotó).
      const sinAcotar = c === 'tests' && checks[c] === 'sin-acotar';
      // «sin-medir» (tests): el portón no sabe correr las pruebas del repo; se acepta diciéndolo, y el cierre
      // de la historia copia la línea (nunca un verde callado)
      const sinMedir = c === 'tests' && checks[c] === 'sin-medir';
      if (checks[c]) preconditions.push({ id: `check-${c}`, satisfied: checks[c] === 'green' || sinAcotar || sinMedir, detail: `marker.checks.${c}=${checks[c]} (provenance: ${(marker.checksProvenance || {})[c] || 'desconocida'})${sinAcotar ? ' — sin acotar: la cubre la CI del pedido, y el merge exige la CI completa en verde' : ''}${sinMedir ? ' — pruebas no medidas: el portón no sabe correr las pruebas de este repo; el cierre de la historia lo dice en una línea, y para medirlas se declara el comando en el sitio de la organización (Configuración → Tu tecnología → Cómo se corren las pruebas)' : ''}` });
    }
  }

  // El estado del pase adversarial viaja en el
  // comando canónico "¿qué sigue?" — el cap de ventana del Step 5 y el JOIN de 3 ramas del
  // step-05b dependen de él, y sin esto habría que acordarse de un `marker.js get` extra.
  const adv = marker.adversarial || null;
  const sidNow = resolveSessionId();
  const advIsOurs = adv ? adv.sessionId === sidNow : null;
  const pase = completedNums.has('4') ? accionDelPase(marker, story, { sidNow, nextStep: nextStep ? nextStep.step : null }) : {};
  const pending = pase.pending_action || null;

  return {
    story_id: marker.storyId,
    story_path: marker.storyPath,
    autonomous: marker.autonomous === true,
    checks: marker.checks || {},
    checks_provenance: marker.checksProvenance || {},
    adversarial: adv,
    adversarial_is_ours: advIsOurs,
    next_step: nextStep ? nextStep.step : null,
    // el nombre llano del paso: es lo que se le dice al dueño; `next_step` queda para los comandos
    step_name: nextStep ? nextStep.name : null,
    next_step_file: nextStep ? nextStep.file : null,
    preconditions,
    steps: stepState,
    ...(pending ? { pending_action: pending } : {}),
    ...(pase.adversarial_note ? { adversarial_note: pase.adversarial_note } : {}),
    ...(notaDelTamano(marker, nextStep) ? { run_size_note: notaDelTamano(marker, nextStep) } : {}),
    note: exempt7c
      ? `Sigue «${nextStep.name}». ${NOTA_7C_EXENTA}`
      : nextStep
      ? `${pending && ['consultar-porton', 'lanzar-pase'].includes(pending.kind) ? `ANTES, pase adversarial: ${pending.message} ` : ''}Sigue «${nextStep.name}». Leé SOLO ${path.basename(nextStep.file)} y ejecutalo. Los skips listados son mecánicos (verificables) — no infieras otros (regla E.i). Al completar: ${nextStep.step === '5b' ? NOTA_CIERRE_5B : nextStep.step === '7c' ? NOTA_CIERRE_7C : SUBSTEP_FLAG[nextStep.step] ? `marker.js set-flag ${SUBSTEP_FLAG[nextStep.step]} true` : nextStep.step === '3' ? notaCierre3(marker) : nextStep.step === '5' ? 'marker.js run-check advisors -- pipeline.js check-count … y recién después marker.js complete-step 5 (bloquea sin el verde real)' : `marker.js complete-step ${nextStep.step}`}.${pending && pending.kind.endsWith('-pase-ajeno') ? ` ⚠️ ${pending.message} Regla: ${pending.rule} (${pending.why}).` : ''}${notaDelTamano(marker, nextStep) ? ` ${notaDelTamano(marker, nextStep)}` : ''}`
      : 'No quedan pasos pendientes — cerrá con marker.js clear (o step-09-ado-story-closure.md si vas a cerrar la story en ADO: «Cerrar la historia»).',
  };
}

// ── pipeline.js start — preflight mecánico en UN comando ─
// Colapsa los 5 checks de step-00 (PIPE-C0 cross-session, C1 branch guard,
// C2 gitignore, C4 marker, C5 status in-progress) que el LLM ejecutaría
// check-por-check en prosa (5 turnos → 1). PAUSA (ready:false, sin mutar nada)
// solo ante conflicto cross-session, rama protegida o pipeline abandonado.
// ── Specs que envejecen sin revalidar ────────────────
// Una story queda `ready-for-dev` y se implementa MESES después. El spec no envejece solo: el
// código que cita se mueve abajo. Ejemplo: tras 2.5 meses en
// `ready-for-dev`, una revalidación puede encontrar correcciones de fondo, como un esqueleto que
// manda a llamar `PluginManager.GetLoadedPlugin(name)`, un método que NO EXISTE.
// Sin esa revisión, la story manda a escribir código que no compila. También pueden cambiar los
// hechos del dominio (un 3er plugin afectado que la story da por inexistente) y un bug que la
// story documenta como abierto puede estar cerrado.
//
// Esto AVISA, no frena: la antigüedad no es un defecto, es una señal de que conviene reverificar
// las anclas `archivo:línea` antes de codear. Frenar por una fecha sería castigar el backlog.
// Umbral configurable: TYCON_STALE_SPEC_DAYS (default 75). Apagado con 0.
function computeSpecStaleness(fm, hoyMs) {
  const dias = Number(process.env.TYCON_STALE_SPEC_DAYS || 75);
  if (!Number.isFinite(dias) || dias <= 0) return null;

  // `revalidated:` gana sobre `created:` — es exactamente el sello que deja esta revisión, así que
  // una story revalidada la semana pasada NO vuelve a avisar aunque se haya escrito hace un año.
  const campo = fm.revalidated ? 'revalidated' : 'created';
  const crudo = String(fm[campo] || '').trim().replace(/^["']|["']$/g, '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(crudo)) return null;   // sin fecha legible no se inventa antigüedad
  const t = Date.parse(crudo.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;

  const edad = Math.floor((hoyMs - t) / 86400000);
  if (edad < dias) return null;
  return {
    dias_sin_revalidar: edad,
    umbral: dias,
    campo_usado: campo,
    fecha: crudo.slice(0, 10),
    aviso: `Esta story tiene ${edad} días desde \`${campo}: ${crudo.slice(0, 10)}\` y todavía no se implementó. `
      + 'ANTES de codear, reverificá que las anclas `archivo:línea` del spec sigan resolviendo y que '
      + 'los hechos del dominio no hayan cambiado (métodos que ya no existen, casos nuevos que el spec '
      + 'no contempla, bugs que se cerraron por otra vía). No hace falta reescribir la story: alcanza '
      + 'con confirmar lo que cita y anotar las correcciones inline. Al terminar, sellá el frontmatter '
      + 'con `revalidated: <hoy>` para que este aviso no vuelva a salir. '
      + 'Caso de referencia (qué se encontró y cómo se documentó): epic-9 del repo del framework, §Revalidación.',
  };
}

function computeStart(args) {
  const { execFileSync } = require('child_process');
  const storyPath = args.story;
  const repo = args.repo;
  if (!storyPath || !fs.existsSync(storyPath)) {
    return { ready: false, error: `--story inválido o no existe: ${storyPath}` };
  }
  const content = readText(storyPath);
  const fm = parseFrontmatterPipeline(content);
  const storyId = fm.story || path.basename(storyPath, '.md');
  const pauses = [];
  const actions = [];
  // La identidad de una story es `story:` en todo el arnés: `storyId:` no se lee. Si el
  // archivo sólo trae ésa, se dice — si no, la corrida arranca con el nombre del archivo como número sin que nadie lo note.
  if (!fm.story && fm.storyId) {
    const aviso = `⚠️ ${path.basename(storyPath)} declara \`storyId:\` y no \`story:\`: para el arnés no es una story (el portón de Azure no la revisa). Renombrá la clave a \`story:\`; mientras tanto el número es el nombre del archivo (${storyId}).`;
    actions.push(aviso);
    process.stderr.write(`${aviso}\n`);
  }

  // PIPE-C0: cross-session conflict.
  // «La misma story» es el mismo número Y la misma ruta dentro de su repo: en los repos que numeran por
  // tema, dos sesiones sobre dos `1.1` distintas se frenarían entre sí. La ruta va RELATIVA al repo a propósito: dos
  // copias del repo (dos clones o worktrees) trabajando la misma story se siguen frenando. Un marcador sin ruta
  // legible se compara por el número: ante la duda, pausa de más.
  // Relativa al repo de la STORY (no al del marcador: el pipeline puede correr en el repo del código con la story en
  // otro). Sin repo git que la contenga, o si el archivo ya no está (la story se movió o se renombró después de que la
  // otra sesión arrancó), no hay ruta comparable → null, y se compara por el número: ante la duda, pausa de más.
  const rutaEnRepo = (sp, rp) => {
    try {
      const abs = path.isAbsolute(sp) ? sp : path.join(rp || repo, sp);
      if (!fs.existsSync(abs)) return null;
      // Como la guarda el disco: otras mayúsculas o la tilde en otra forma Unicode no hacen «otra story».
      const real = fs.realpathSync.native(abs);
      const raiz = require('./lib/evidence-config.js').discoverRepoRoot(path.dirname(real));
      return raiz ? path.relative(raiz, real).split(path.sep).join('/') : null;
    } catch { return null; }
  };
  const miRuta = rutaEnRepo(path.resolve(storyPath));
  const others = [];
  try {
    const sid = sessionIdFileKey();
    const activeDir = path.join(stateDirOf(os.homedir()), 'active');
    for (const f of (fs.existsSync(activeDir) ? fs.readdirSync(activeDir) : [])) {
      if (!f.endsWith('.json') || f === `${sid}.json`) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8'));
        if (!m || String(m.storyId) !== String(storyId)) continue;
        const suRuta = m.storyPath ? rutaEnRepo(m.storyPath, m.repoPath) : null;
        if (suRuta && miRuta && suRuta !== miRuta) continue; // otra story con el mismo número
        others.push({ sessionId: m.sessionId, lastTouch: m.lastTouch, stepsCompleted: m.stepsCompleted });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  if (others.length) {
    pauses.push({
      id: 'PIPE-C0-cross-session',
      detail: `Story ${storyId} YA tiene pipeline activo en otra sesión: ${JSON.stringify(others)}`,
      options: 'retomar con `marker.js adopt-session <sid>` (copia el estado completo) / clear-session / paralelo intencional / cancelar',
    });
  }

  // PIPE-C1: branch guard.
  let branch = null;
  try {
    branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* repo sin git */ }
  // La historia del modo primera vez de tycon-create-story arranca sola: sin git, `git init`; en main/master (o en un repo sin
  // commits), la rama `story/<n>`. Sólo con la marca `origin: first-time` Y la constancia que deja el guion que la
  // escribió (lib/first-time-record.js): la marca sola se escribe a mano, y en un checkout que comparten varias sesiones
  // cambiar de rama solo rompe el trabajo de la otra (caso de scripts/hooks/session-collision-guard.js). Lo que se
  // decide acá se hace después de juntar todas las pausas: con cualquier pausa, nada cambia.
  let firstTimeGit = null;
  const firstTimeMark = fm.origin === 'first-time';
  const firstTimeOk = firstTimeMark && require('./lib/first-time-record.js').isRecorded(os.homedir(), storyPath, storyId);
  if (firstTimeOk) {
    const gitOut = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const target = `story/${storyId}`;
    let hasGit = true;
    try { gitOut('rev-parse', '--git-dir'); } catch { hasGit = false; }
    // Una carpeta adentro de otro repo no es «sin git»: es el repo de otro. Ése no se toca (ni init ni rama).
    let ownRepo = !hasGit;
    if (hasGit) { try { ownRepo = fs.realpathSync(gitOut('rev-parse', '--show-toplevel')) === fs.realpathSync(repo); } catch { ownRepo = false; } }
    let current = null;
    if (hasGit) { try { current = gitOut('symbolic-ref', '--short', 'HEAD'); } catch { /* HEAD suelto: no se toca */ } }
    let unborn = !hasGit;
    if (hasGit) { try { gitOut('rev-parse', '--verify', '--quiet', 'HEAD'); } catch { unborn = true; } }
    if (ownRepo && (!hasGit || ['main', 'master'].includes(current) || (unborn && current && current !== target))) {
      let exists = false;
      if (hasGit) { try { gitOut('rev-parse', '--verify', '--quiet', `refs/heads/${target}`); exists = true; } catch { /* no existe */ } }
      if (exists) {
        pauses.push({ id: 'PIPE-C1-branch-guard', detail: `Estás en '${current}' y la rama de esta historia, '${target}', ya existe — NO la piso ni cambio a ella solo. Pasá a esa rama (o borrala) y re-corré start.` });
      } else {
        firstTimeGit = { init: !hasGit, unborn, target };
      }
    }
  }
  // Una carpeta sin NINGÚN git (ni ella ni de arriba) se inicia aunque la historia no traiga la marca: ahí
  // no hay rama de otra sesión que pisar, que es por lo que la marca hace falta. Sin esto, una historia escrita a mano
  // llegaría al commit sin git, con el chequeo de dependencias salteado sin aviso. No en la carpeta personal, ni en la raíz,
  // ni con la historia afuera: ahí pausa y da el comando a mano.
  if (!firstTimeGit && !firstTimeOk) {
    let hasGit = true;
    try { execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { hasGit = false; }
    if (!hasGit) {
      const target = `story/${storyId}`;
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const repoReal = real(repo);
      const storyReal = real(storyPath);
      const aMano = `git -C "${repo}" init && git -C "${repo}" symbolic-ref HEAD refs/heads/${target}`;
      let porque = null;
      if (repoReal === real(os.homedir())) porque = 'es tu carpeta personal';
      else if (repoReal === path.parse(repoReal).root) porque = 'es la raíz del disco';
      else if (path.relative(repoReal, storyReal).startsWith('..') || path.isAbsolute(path.relative(repoReal, storyReal))) porque = 'la historia está fuera de esa carpeta';
      if (porque) {
        pauses.push({ id: 'PIPE-C1-sin-git', detail: `La carpeta ${repo} no tiene git y no lo inicio solo: ${porque}. Si es la carpeta del proyecto, inicialo a mano y volvé a correr start: ${aMano}` });
      } else {
        firstTimeGit = { init: true, unborn: true, target, sinMarca: true };
      }
    }
  }
  if (branch && ['main', 'master'].includes(branch) && !firstTimeGit && !pauses.some((p) => p.id === 'PIPE-C1-branch-guard')) {
    const aMano = firstTimeMark && !firstTimeOk
      ? ' La marca `origin: first-time` de esta historia no la puso el guion del modo primera vez (no hay constancia): el recorrido no cambia de rama solo.'
      : '';
    pauses.push({ id: 'PIPE-C1-branch-guard', detail: `Estás en rama protegida '${branch}' — NO implementar acá. Creá/checkout una rama de trabajo primero.${aMano}` });
  }

  // PIPE-C5 (lectura): pipeline abandonado.
  if (fm.status === 'in-progress' && !others.length) {
    pauses.push({
      id: 'PIPE-C5-abandoned',
      detail: `La story ya está status: in-progress sin pipeline activo en otra sesión — probable pipeline abandonado (sesión que murió sin cerrar).`,
      options: 'retomar desde el último step (pipeline.js next tras adopt/re-set del marker) / resetear status y arrancar fresh',
    });
  }

  if (firstTimeGit && !pauses.length) {
    const { init, unborn, target, sinMarca } = firstTimeGit;
    try {
      const run = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (init) run('init', '-q');
      // Sin commits no hay desde dónde ramificar: se nombra la rama de HEAD, y el primer commit nace en ella.
      if (init || unborn) run('symbolic-ref', 'HEAD', `refs/heads/${target}`);
      else run('switch', '-q', '-c', target);
      branch = target;
      actions.push(sinMarca
        ? `PIPE-C1: tu carpeta no tenía git: lo inicié (git init) y creé la rama ${target} (lo que había sigue igual, sin commitear).`
        : `PIPE-C1: historia de primera vez → ${init ? 'git init y ' : ''}rama ${target} creada y activa (lo que no estaba commiteado sigue en el árbol).`);
    } catch (e) {
      const aMano = init ? ` A mano: git -C "${repo}" init && git -C "${repo}" symbolic-ref HEAD refs/heads/${target}` : '';
      pauses.push({ id: 'PIPE-C1-branch-guard', detail: `No pude preparar la rama ${target} para ${sinMarca ? 'esta historia' : 'la historia de primera vez'}: ${String(e.stderr || e.message || e).trim().split('\n')[0]}. Creala a mano y re-corré start.${aMano}` });
    }
  }

  // PIPE-C2: .gitignore fix (mutación segura e idempotente — se hace siempre).
  // 🔴 Y también sobre el repo de la STORY cuando es otro: la evidencia de
  // cierre nace ahí (ver `evidenceDirForStory`), así que ese `.gitignore` es el que decide si
  // viaja. Un repo de specs con `.advisors/` a secas se tragaría la evidencia y el portón daría rojo.
  const evid = evidenceDirForStory(storyPath, repo);
  const reposGitignore = [repo];
  if (evid.crossRepo && evid.storyRepo) reposGitignore.push(evid.storyRepo);
  for (const r of reposGitignore) {
    try {
      const giPath = path.join(r, '.gitignore');
      const gi = readText(giPath);
      const { append, notices } = computeGitignoreNeeds(gitIgnoraProbe(r));
      const donde = r === repo ? '' : ` (repo de la story: ${r})`;
      if (append.length) {
        fs.appendFileSync(giPath, (gi.endsWith('\n') || gi === '' ? '' : '\n') + append.join('\n') + '\n', 'utf8');
        actions.push(`PIPE-C2: agregado a .gitignore${donde}: ${append.filter((l) => !l.startsWith('#')).join(', ')}`);
      }
      for (const n of notices) actions.push(donde ? `${n}${donde}` : n);
    } catch { /* ignore */ }
  }
  if (evid.crossRepo) {
    actions.push(`EVIDENCIA-EN-REPO-DE-LA-STORY: la story vive en ${evid.storyRepo} y el código en ${repo} → `
      + `toda la evidencia de cierre (macro, gate E2E, smoke-run) va a ${evid.dir}, que es donde el `
      + 'portón de CI la va a buscar. Resolvela con `pipeline.js evidence-dir --story <spec> --repo <repo> --plain`.');
  } else if (evid.warning) {
    actions.push(`⚠️ EVIDENCIA: ${evid.warning}`);
  }

  if (pauses.length) {
    return { ready: false, story_id: storyId, branch, pauses, actions_done: actions, note: 'NADA mutado (salvo .gitignore idempotente). Resolvé las pausas y re-corré start.' };
  }

  // el tamaño de la corrida y su tiempo estimado, ANTES de lanzar nada; quedan en el marcador.
  const sizeCls = computeRunSize({ story: storyPath, repo, runSize: args.runSize });
  const est = runSizeLib.estimate({ size: sizeCls.size, historyDir: path.join(stateDirOf(os.homedir()), 'timing-history') });
  const runSize = { size: sizeCls.size, reason: sizeCls.reason, estimate_min: est.minutes, estimate_source: est.source };
  actions.push(`TAMAÑO: corrida ${runSize.size} (${runSize.reason}) · estimado ${runSize.estimate_min} min (${runSize.estimate_source})`);

  // PIPE-C4: marker set (vía marker.js — único owner de writes del marker).
  const markerJs = path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  try {
    // marker.js con el mismo Node que corre este programa, no el del PATH
    execFileSync(process.execPath, [markerJs, 'set', JSON.stringify({
      // storyPath ABSOLUTO: si `start` lo validara contra el cwd y el marker lo guardara
      // crudo, on-advisor-run.js y marker.js lo resolverían contra repoPath — coinciden sólo si
      // cwd == --repo. Con `--repo backend --story project/specs/x.md` desde el padre, la proyección
      // del roster resolvería un path inexistente y callaría con "mismo repo". Todo lector acepta absolutos.
      storyId, storyPath: path.resolve(storyPath), repoPath: repo, sprint: fm.sprint ? parseInt(fm.sprint, 10) || null : null,
      // Dónde nace la evidencia de cierre: el repo de la story, aunque el código
      // esté en otro. Lo leen los steps 7c/8 para no tener que adivinarlo.
      evidenceDir: evid.dir || null,
      // Commit de partida: la base de las «líneas tocadas» que mide test-gate.sh.
      // Sin git queda null y test-gate cae a HEAD diciéndolo.
      baseSha: (() => {
        try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; } catch (e) {
          // No frena el arranque (test-gate cae a HEAD y lo dice), pero no se calla.
          actions.push(`⚠️ BASE DE COBERTURA: no pude leer el commit de partida (${String((e.stderr || e.message || e)).trim().split('\n')[0]}); test-gate medirá contra HEAD`);
          return null;
        }
      })(),
      stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      size: runSize.size, size_reason: runSize.reason, estimate_min: runSize.estimate_min, estimate_source: runSize.estimate_source,
    })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, [markerJs, 'complete-step', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    actions.push('PIPE-C4: marker seteado (step 0 completado)');
  } catch (e) {
    return { ready: false, story_id: storyId, pauses: [{ id: 'marker-set-failed', detail: String(e.message || e) }], actions_done: actions };
  }

  // PIPE-C5 (escritura): status → in-progress.
  try {
    execFileSync(process.execPath, [markerJs, 'update-story-status', storyPath, 'in-progress'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    actions.push('PIPE-C5: frontmatter status → in-progress');
  } catch (e) {
    actions.push(`PIPE-C5 FALLÓ (no bloqueante): ${String(e.message || e)}`);
  }

  if (args.autonomous) {
    try {
      execFileSync(process.execPath, [markerJs, 'set-autonomous', 'true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      actions.push('PIPE-C6: modo autónomo Nivel 1 ACTIVO (default ON · Stop-gate DoD). Pánico: touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY');
    } catch { /* ignore */ }
  } else {
    actions.push('PIPE-C6: modo autónomo OFF (--no-autonomous o TYCON_PIPELINE_NO_AUTONOMOUS=1) → HITL puro');
  }

  // PIPE-C7 (discoverability): si el repo tiene specs Playwright pero NO declaró su
  // gate E2E en .tycon/advisors.yaml → avisar FUERTE acá (si no, el pipeline saltearía los E2E
  // en silencio y el tier crítico no frenaría el merge). El orquestador relaya el warning al user.
  const e2eCfg = e2eConfig(args.repo);
  if (e2eCfg.gap) actions.push(`⚠️ PIPE-C7 E2E-GAP — ${e2eCfg.warning}`);

  // Revalidación de specs viejas: `fm` es el frontmatter leído ARRIBA, antes de que PIPE-C5 pise el
  // status a in-progress — o sea que refleja cuánto tiempo estuvo la story esperando de verdad.
  const stale = computeSpecStaleness(fm, Date.now());
  if (stale) actions.push(`⚠️ SPEC-STALE — ${stale.aviso}`);

  return {
    ready: true,
    story_id: storyId,
    branch,
    run_size: runSize,
    risk: computeRiskClass({ story: storyPath, files: [], repo, runSize: args.runSize }),
    model_hint: computeModelHint({ story: storyPath, files: [], repo, runSize: args.runSize, orgModels: args.orgModels, sessionModel: args.sessionModel }),
    // El modelo de los ayudantes sueltos, con configuración de la organización o pedido
    ...((args.orgModels && args.orgModels.declared) || args.modelRequests
      ? { models: { helpers: MODELOS.resolveHelpers({ org: args.orgModels && args.orgModels.declared ? args.orgModels.data : null, requests: args.modelRequests }) } }
      : {}),
    tooling: computeToolingExpected(repo),
    actions_done: actions,
    e2e_gap: e2eCfg.gap ? e2eCfg.warning : null,
    spec_stale: stale,
    next: 'pipeline.js next te dice el próximo paso (el aviso de trabajo, el pedido en ADO o validar la story)',
  };
}

/**
 * Recorta la salida de `start` a lo que el orquestador realmente consume, y deja el JSON ENTERO en
 * un archivo cuya ruta viaja en la salida.
 *
 * Por qué: `start` devuelve ~4 KB de los que el orquestador usa una docena de campos — y ese texto
 * vuelve a entrar en contexto en CADA respuesta posterior del turno. Medido en un análisis de tokens:
 * el 10 % de lo releído es el texto de las propias llamadas del agente.
 *
 * 🔴 Recortar NO es perder: sin la ruta del archivo, el que necesite el detalle vuelve a correr
 *    `start` — y `start` MUTA (frontmatter de la story, marker, .gitignore). Por eso `completo`
 *    es parte del contrato, no un extra.
 * 🔴 El código de salida NO cambia: lo gatea el llamador (`ready ? 0 : 1`) y el recorte no opina.
 * 🔴 Sin el flag, `start` se comporta EXACTAMENTE como siempre — hay orquestadores ya escritos
 *    contra la forma vieja. El contrato viejo y el nuevo conviven; los dos tienen su caso en
 *    `tests/large-output.test.js`.
 */
function recortarStart(result) {
  let completo = null;
  try {
    const dir = path.join(stateDirOf(os.homedir()), 'salidas');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    completo = path.join(dir, `start-${result.story_id || 'sin-story'}-${ts}.json`);
    fs.writeFileSync(completo, JSON.stringify(result, null, 2) + '\n');
  } catch {
    // Fail-open: si no se pudo escribir el detalle, el modo breve no se lo come — devuelve el
    // objeto entero, que es peor en tokens pero nunca peor en información.
    return result;
  }

  const breve = { ready: result.ready, story_id: result.story_id, branch: result.branch };
  if (result.pauses && result.pauses.length) {
    breve.pauses = result.pauses.map((p) => ({ id: p.id, detail: p.detail }));
  }
  if (result.risk) {
    breve.riesgo = result.risk.risk;
    breve.auto_approve_plan = result.risk.auto_approve_plan === true;
    if (result.risk.risk === 'NORMAL') {
      breve.riesgo_por = (result.risk.criteria || []).filter((c) => !c.pass).map((c) => c.name);
    }
  }
  if (result.run_size) {
    breve.tamano = result.run_size.size;
    breve.tamano_por = result.run_size.reason;
    breve.estimado_min = result.run_size.estimate_min;
    breve.estimado_de = result.run_size.estimate_source;
  }
  if (result.models) breve.models = result.models;
  if (result.models_problem) breve.models_problem = result.models_problem;
  if (result.models_warnings) breve.models_warnings = result.models_warnings;
  if (result.model_hint) {
    breve.modelo = result.model_hint.recommended_session_model;
    breve.effort = result.model_hint.effort || null;
    if (result.model_hint.session_check) breve.session_check = result.model_hint.session_check;
    if (result.model_hint.session_warning) breve.session_warning = result.model_hint.session_warning;
  }
  if (result.tooling && Array.isArray(result.tooling.expected)) {
    // Sólo los NOMBRES: el orquestador es el único que puede saber cuáles tiene en su sesión, y el
    // cómo-levantarlo (que es el grueso del texto) vive en el archivo.
    breve.tools_esperadas = result.tooling.expected.map((x) => x.name);
    // Las skills de terceros que faltan: ésas sí las sabe el script, con su acción.
    const missing = result.tooling.expected.filter((x) => (x.kind === 'skill' || x.kind === 'manifest') && x.present === false);
    if (missing.length) breve.skills_faltantes = missing.map((x) => `${x.name} → ${x.action}`);
  }
  if (result.e2e_gap) breve.e2e_gap = result.e2e_gap;
  if (result.spec_stale) breve.spec_stale = result.spec_stale;
  breve.acciones = result.actions_done || [];
  breve.next = result.next || result.note || null;
  breve.completo = completo;
  return breve;
}

// ── pipeline.js risk-class — Autonomía Nivel 2 ───
// Clasifica la story para el auto-approve CONDICIONAL del plan (Step 3):
// LOW-risk → step-03 se auto-aprueba y el plan se muestra igual; cualquier criterio
// fallido → NORMAL → checkpoint HITL como siempre. Reglas de oro intactas:
// git push y cambios de scope firmado SIEMPRE human-gate (regla #0).
// Criterios del diseño pipeline-autonomy-design.md §9 (validator verde es
// pre-requisito del flujo — Step 1 corre antes que Step 3, no se re-evalúa acá).
// ── El tamaño de la corrida: liviana (sólo documentación) o completa. Lo clasifica lib/run-size.js por
// lo que la story DECLARA; `args.runSize` (el forzado del marcador, que sólo leen las ramas de línea de comandos)
// manda. Sin story legible, completa. El repo aporta sus superficies del pase adversarial.
const runSizeLib = require('./lib/run-size.js');
function computeRunSize(args) {
  if (args.runSize && runSizeLib.SIZES.includes(args.runSize.size)) {
    return { size: args.runSize.size, reason: `forzado a mano: ${args.runSize.reason || '(sin motivo)'}`, first_code_file: null, forced: true };
  }
  const content = args.story && fs.existsSync(args.story) ? readText(args.story) : '';
  const repo = args.repo && fs.existsSync(args.repo) ? args.repo : null;
  // Lo declarado Y lo que el cambio toca de verdad (`--files`, el diff): una story que declara un .md y toca código no
  // puede salir liviana (pase adversarial). Sin story no hay tamaño: sólo con el diff no se sabe qué faltó declarar.
  const declared = runSizeLib.declaredFiles(content);
  const rel = (f) => (repo && path.isAbsolute(f) && !path.relative(repo, f).startsWith('..') ? path.relative(repo, f) : f);
  const touched = Array.isArray(args.files) ? args.files.map(rel) : [];
  if (!declared.length) return runSizeLib.classifyStory({ files: [] });
  const files = [...new Set([...declared, ...touched])];
  return runSizeLib.classifyStory({
    files,
    alwaysPaths: repo ? deepReviewAlwaysPaths(repo) : [],
    deepReviewCfg: repo ? deepReviewConfig(repo) : null,
    roots: repo ? [repo] : [],
  });
}

/** El tamaño forzado a mano en el marcador de esta sesión, si es de la misma story: `{ size, reason }` o null. */
function runSizeDelMarcador(storyPath) {
  const m = readSessionMarker();
  if (!m || !m.sizeForced || !runSizeLib.SIZES.includes(m.size)) return null;
  if (storyPath && m.storyPath && path.resolve(m.storyPath) !== path.resolve(storyPath)) return null;
  return { size: m.size, reason: m.sizeForced.reason };
}

function computeRiskClass(args) {
  const storyPath = args.story;
  if (!storyPath || !fs.existsSync(storyPath)) {
    return { risk: 'NORMAL', error: `--story inválido: ${storyPath}`, auto_approve_plan: false };
  }
  const content = readText(storyPath);
  const fm = parseFrontmatterPipeline(content);
  const scopeFiles = args.files && args.files.length
    ? args.files
    : [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')];

  const criteria = [];
  const add = (name, pass, detail) => criteria.push({ name, pass, detail });

  add('sin-migraciones-sql', !scopeFiles.some((f) => /\.sql$|(^|\/)drizzle\//i.test(f)),
    'migraciones de schema cambian datos — siempre plan HITL');
  add('sin-scope-firmado', !fm.signed_for_sprint && !fm.signed_ac_ref,
    `signed_for_sprint=${fm.signed_for_sprint || '(ausente)'} signed_ac_ref=${fm.signed_ac_ref || '(ausente)'} — stories firmadas con cliente siempre plan HITL`);
  // en una corrida liviana (sólo documentación) el tamaño solo no sube el riesgo.
  const runSize = computeRunSize(args);
  if (runSize.size === 'liviana') {
    add('superficie-chica', scopeFiles.length > 0,
      `${scopeFiles.length} archivos en scope, todos documentación: corrida liviana, el tamaño no cuenta`);
  } else {
    add('superficie-chica', scopeFiles.length > 0 && scopeFiles.length <= 6,
      `${scopeFiles.length} archivos en scope (límite 6; 0 archivos = scope no declarado → NORMAL)`);
  }
  add('sin-paths-sensibles', !scopeFiles.some((f) => /auth|security|payment|crypto|secret|credential/i.test(f)),
    'archivos de auth/seguridad/pagos siempre plan HITL');
  add('sin-pipelines-multi-tanda', !/^pipelines:/m.test(content),
    'stories con entregas en tandas tienen interdependencias — plan HITL');

  const allPass = criteria.every((c) => c.pass);
  return {
    risk: allPass ? 'LOW' : 'NORMAL',
    run_size: runSize.size,
    auto_approve_plan: allPass,
    criteria,
    note: allPass
      ? 'LOW-risk: step-03 puede auto-aprobarse (Nivel 2), pero el plan se muestra siempre: primero un mensaje con el plan tal cual, después complete-step 3 --auto-approved (lee la conversación; sin poder leerla, se le pregunta a la persona). Push y scope firmado siguen human-gate SIEMPRE.'
      : 'NORMAL: checkpoint HITL del plan (step-03) como siempre.',
  };
}

// ── pipeline.js tooling-expected — aviso de tooling no disponible ──
// El pipeline ASUME herramientas del harness (CodeGraph para symbol lookup, engram
// para memoria persistente, la tool Workflow para el 5b). Si están declaradas pero
// NO disponibles en la sesión, el orquestador degrada a fallbacks (grep / sin
// memoria / sin pase adversarial), y sin aviso el user no se entera
// de que el run corre más lento o con menos cobertura. Contrato (PIPE-C9):
// este script detecta la EXPECTATIVA (mecánica, verificable); la disponibilidad
// real del MCP/tool la conoce SOLO el orquestador (las tools viven en su harness,
// no en el shell) → él la verifica y AVISA al user ANTES de degradar.
// ── Las skills de terceros que el pipeline invoca por nombre ──
// Lo ajeno sale de agent-skills y lo restituye el paso del instalador desde el manifiesto del arnés
// (scripts/publishing/third-party-skills.json). Si una skill que el pipeline invoca (Steps 2 y 4, el portón de
// stories, el Step 5 a pedido) no está, el pipeline no puede enterarse en silencio: se suma al tooling esperado con
// `present` y la acción. Sin manifiesto legible, una entrada que lo dice. opts: { skillsDir, manifestPath } (pruebas).
// El manifiesto vive en scripts/publishing; una copia atrasada del arnés lo tiene en scripts/publicacion (un `.json` no tiene reemplazo):
// primero publishing, luego publicacion; sin ninguna, publishing (el aviso la nombra).
function thirdPartyManifestPath(harnessDir) {
  if (!harnessDir) return null;
  const at = (dir) => path.join(harnessDir, 'scripts', dir, 'third-party-skills.json');
  if (fs.existsSync(at('publishing'))) return at('publishing');
  if (fs.existsSync(at('publicacion'))) return at('publicacion');
  return at('publishing');
}
function expectedThirdPartySkills(opts = {}) {
  const skillsDir = opts.skillsDir || path.resolve(__dirname, '..', '..');
  let manifestPath = opts.manifestPath;
  if (!manifestPath) manifestPath = thirdPartyManifestPath(require('./lib/harness-path.js').rutaArnesHook().dir);
  const common = {
    mcp_prefix: null, binary_found: null, cli_fallback: null,
    fallback: 'el paso del pipeline que la invoca no puede cargarla: se frena ahí o se sigue sin ella, con el dev avisado',
  };
  let m = null;
  let problem = manifestPath ? null : 'no encontré el arnés (TYCON_GUIDES_DIR o el enlace ~/.claude/tycon-harness)';
  if (!problem) {
    try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { problem = `no pude leer ${manifestPath} (${e.code || 'JSON inválido'})`; }
  }
  if (problem || !m || !Array.isArray(m.third_party)) {
    return [{
      ...common, name: 'third-party-manifest', kind: 'manifest', present: false,
      why: `manifiesto de skills de terceros ilegible: ${problem || 'sin la lista third_party'} — no puedo decir si están las skills que invoca el pipeline`,
      action: 'actualizá el arnés (harness.js update; en un clon, git pull) y corré su instalador',
      raise_it: 'AVISAR al user en 1 línea: sin manifiesto no se sabe si faltan skills de terceros; seguir.',
      if_unavailable: 'AVISAR al user en 1 línea y seguir: es una advertencia, no un freno.',
    }];
  }
  const usedByPipeline = (e) => Array.isArray(e.used_by) && e.used_by.includes('tycon-pipeline');
  const wanted = [
    ...m.third_party.filter(usedByPipeline).map((e) => ({ e, derived: false })),
    ...(Array.isArray(m.derived) ? m.derived : []).filter((d) => d.repo === 'agent-skills' && usedByPipeline(d)).map((e) => ({ e, derived: true })),
  ];
  return wanted.map(({ e, derived }) => {
    const name = path.basename(e.target);
    const present = fs.existsSync(path.join(skillsDir, name, 'SKILL.md'));
    const action = present ? null
      : e.install === 'official-plugin' ? `instalá el plugin oficial: /plugin install ${e.plugin}`
        : derived ? 'es del equipo y viaja en agent-skills: actualizalo (harness.js update; en un clon, git pull) y corré el instalador del arnés'
          : 'corré el instalador del arnés (install-tycon-hooks.sh): la restituye desde el manifiesto de terceros';
    return {
      ...common, name: `skill:${name}`, kind: 'skill', present, action,
      why: `tycon-pipeline la invoca por nombre (manifiesto de terceros: ${derived ? 'derivada' : e.install})`,
      raise_it: present ? 'nada que hacer' : `AVISAR al user en 1 línea: falta la skill ${name} → ${action}`,
      if_unavailable: `AVISAR al user en 1 línea ANTES del paso que la invoca: "falta la skill ${name}" y la acción.`,
    };
  });
}

/**
 * Las integraciones según el lector de configuración del arnés (`{ ado: false, engram: true, … }`), o `null` si no se
 * puede saber: arnés no encontrado, arnés sin lector o con uno anterior a las integraciones, configuración rota. Quien
 * llama trata `null` como todo esperado: no saber no es «apagada».
 * @param {object} [opts] env (default process.env) · home (default os.homedir())
 */
function harnessIntegrations(opts = {}) {
  const env = opts.env || process.env;
  const dir = require('./lib/harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
  if (!dir) return null;
  const reader = path.join(dir, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) return null;
  try {
    const cfg = require(reader);
    if (typeof cfg.leer !== 'function' || typeof cfg.integraciones !== 'function') return null;
    const all = cfg.integraciones(cfg.leer({ env, home: opts.home }));
    return all && typeof all === 'object' ? all : null;
  } catch (_) { return null; }   // rota o lector que no carga: la configuración la reclama el instalador; acá, todo esperado
}

/**
 * El evento neutro de trabajo del arnés que ve esta corrida (`scripts/lib/work-signal.js`), con su lector de
 * configuración: `{ ws, TC }`, o null si no está (arnés viejo, o sin arnés). El pipeline no sabe con qué herramienta se
 * registran las horas: se lo pregunta a ese evento.
 */
function harnessWorkSignal(opts = {}) {
  const env = opts.env || process.env;
  const dir = require('./lib/harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
  if (!dir) return null;
  const file = path.join(dir, 'scripts', 'lib', 'work-signal.js');
  if (!fs.existsSync(file)) return null;
  // presente y que no carga no es «no está»: se devuelve el motivo para que el aviso lo diga
  try {
    const ws = require(file);
    let TC = null;
    try { TC = require(path.join(dir, 'scripts', 'lib', 'tycon-config.js')); } catch (_) { TC = null; }
    if (typeof ws.chosen === 'function' && typeof ws.emit === 'function') return { ws, TC };
    return { loadError: 'no exporta chosen y emit' };
  } catch (e) { return { loadError: e.code || String(e.message || e).split('\n')[0] }; }
}

/**
 * La herramienta de horas que eligió la organización: `{ chosen: true, name }`, `{ chosen: false, reason }` (ninguna,
 * desconocida o con el manifiesto roto, con el motivo) o null si no se sabe (sin el evento, o la configuración rota).
 * `next` la pregunta en cada consulta: no anota el uso del nombre viejo de la llave.
 */
function harnessTimeTool(opts = {}) {
  const env = opts.env || process.env;
  const h = harnessWorkSignal(opts);
  if (!h || h.loadError) return null;
  let c;
  try {
    const ask = () => h.ws.chosen({ env, home: opts.home });
    c = h.TC && typeof h.TC.sinAnotar === 'function' ? h.TC.sinAnotar(ask) : ask();
  } catch (_) { return null; }
  if (c.manifest) return { chosen: true, name: c.manifest.name };
  if (c.value === 'none') return { chosen: false, reason: 'ninguna herramienta de horas elegida (integrations.timeTracking: none)' };
  if (!c.value) return null;
  return { chosen: false, reason: `ninguna herramienta de horas: ${c.warning}` };
}

/** Las horas para `CompletedWork` del pedido después de un `stop`: las que tenía más los segundos informados, o null. */
function completedWorkHours(current, stopResult) {
  const s = stopResult && stopResult.seconds;
  if (!Number.isInteger(s) || s < 0) return null;
  return Math.round(((Number(current) || 0) + s / 3600) * 100) / 100;
}

/**
 * `pipeline.js work-signal <start|stop> [--story <spec> --repo <dir>]`: el evento de trabajo de una historia (paso 0b y
 * paso 9), con la historia, el título, el repo y la sesión. Sin `--story`, los de la corrida (el marker); el paso 9 corre
 * después del merge, cuando el marker ya se borró, y pasa la story. → `{ ran, seconds?, hours?, action?, warnings }`;
 * `hours` son los segundos de `stop` en horas, para sumar a `CompletedWork`. Una herramienta que falla nunca frena la
 * historia.
 */
function workSignalForRun(event, opts = {}) {
  // un renglón por clave, sin cruzar al siguiente: una clave vacía es vacía, no la clave de abajo
  const field = (fm, key) => ((new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(fm) || [])[1] || '').replace(/^(["'])(.*)\1$/, '$2');
  // con los finales de renglón de Windows y la marca de orden de bytes, como los demás lectores de frontmatter
  const frontmatter = (p) => ((/^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(p ? readText(p) : '') || [])[1] || '').replace(/\r/g, '');
  // la sesión, con la misma cadena que el marker (Claude Code, el banco y Codex): el 0b abrió con ésa
  const sid = resolveSessionId();
  const session = sid === '_nosession' ? null : sid;
  let run;
  if (opts.storyPath) {
    const fm = frontmatter(opts.storyPath);
    const storyId = field(fm, 'story');
    if (!storyId) return { error: `la story ${opts.storyPath} no tiene \`story:\` en el frontmatter` };
    run = { storyId, title: field(fm, 'title'), repo: opts.repo || null, sessionId: session };
  } else {
    const marker = opts.marker || readSessionMarker();
    if (!marker || !marker.storyId) return { error: 'sin marker activo en esta sesión — pasá la story: pipeline.js work-signal <start|stop> --story <spec> --repo <dir>' };
    run = { storyId: String(marker.storyId), title: field(frontmatter(marker.storyPath), 'title'), repo: marker.repoPath || null,
      sessionId: marker.sessionId || session };
  }
  const h = harnessWorkSignal(opts);
  if (!h) return { ran: false, warnings: ['aviso de trabajo: el arnés de esta máquina no trae el evento de trabajo (scripts/lib/work-signal.js); sigo sin registrar'] };
  if (h.loadError) return { ran: false, warnings: [`aviso de trabajo: el evento de trabajo del arnés no carga (${h.loadError}); sigo sin registrar`] };
  const r = h.ws.emit(event, { storyId: run.storyId, title: run.title || null, repo: run.repo, sessionId: run.sessionId }, { env: opts.env || process.env });
  const out = { ran: r.ran, warnings: r.warnings };
  if (r.result.action) out.action = r.result.action;
  if (event === 'stop' && Number.isInteger(r.result.seconds)) {
    out.seconds = r.result.seconds;
    out.hours = completedWorkHours(0, r.result);
  }
  return out;
}

/**
 * @param {string} repo
 * @param {object} [opts] skillsDir · manifestPath (las skills de terceros) · integrations: objeto del lector o `null`
 *   («no se sabe»), para las pruebas; sin la clave se le pregunta al arnés (`env` y `home` van a esa pregunta).
 */
function computeToolingExpected(repo, opts = {}) {
  const integrations = 'integrations' in opts ? opts.integrations : harnessIntegrations(opts);
  const integrationOff = (name) => !!integrations && integrations[name] === false;
  // `where` en Windows y `which` en Mac y Linux, sin ruta fija: con el `which` de Unix por su ruta, en
  // Windows todas las herramientas saldrían «no está». `opts.platform` y `opts.exec` son para las pruebas.
  const findBinary = (cmd) => require('./lib/portable-tools.js').findBinary(cmd, { platform: opts.platform, exec: opts.exec });
  // CLIs conocidos: mismo índice/store que el MCP → sirven para ESTE run vía Bash
  // aunque el MCP server no haya levantado. `raise_install` re-cablea el MCP para
  // próximas sesiones (el server de una sesión ya iniciada solo se recarga con
  // /mcp o reiniciando la sesión — eso es acción del user, no del orquestador).
  const KNOWN_CLI = {
    codegraph: {
      bin: 'codegraph',
      cli: 'codegraph query "<símbolo>" | codegraph context "<task>" | codegraph status | codegraph affected — vía Bash, mismo índice que el MCP',
      // el instalador del arnés registra el servidor sin escribir en el repo; `codegraph install` deja .mcp.json, .claude/
      // y un enganche que corre en cada mensaje: no se recomienda
      raise_install: 'el instalador del arnés: bash scripts/setup/install-codegraph.sh desde la carpeta del arnés (en Windows, install-codegraph.ps1) — registra el servidor sin escribir en el repo; carga recién en la próxima sesión o tras /mcp',
    },
    'codebase_memory': {
      bin: path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp'),
      cli: 'codebase-memory-mcp cli <tool> [json] — tools: search_graph, search_code, trace_path, get_code_snippet, get_architecture, index_status — vía Bash, mismo store que el MCP',
      raise_install: '`codebase-memory-mcp install` (re-cablea el MCP server) — carga en la próxima sesión o tras /mcp',
    },
    engram: {
      bin: 'engram',
      cli: 'engram search --project <name> "<query>" | engram sync --project <name> — vía Bash, mismo store',
      raise_install: null,
    },
  };
  const knownFor = (name) => KNOWN_CLI[name] || (String(name).startsWith('codegraph') ? KNOWN_CLI.codegraph : null);
  const raisePlaybook = (binFound, k) => binFound
    ? `INTENTAR LEVANTARLO — el binario ESTÁ (${binFound}): (1) para ESTE run usá el CLI vía Bash: ${(k && k.cli) || 'el CLI de la tool'}; (2) para dejar el MCP cargado: ${(k && k.raise_install) || 'revisar la config MCP del repo/proyecto'} — y AVISAR al user en 1 línea qué pasó y qué acción le queda a él (/mcp reconnect o reiniciar sesión).`
    : 'NO se puede levantar acá — el binario NO está en esta máquina: AVISAR al user con la acción concreta de instalación (codegraph: guides/integrations/codegraph-mcp.md; codebase_memory: conseguir el binario e instalar con `codebase-memory-mcp install`). Mientras tanto, fallback.';

  const expected = [];
  // CodeGraph se espera si el repo tiene su índice, o si la integración está prendida (la organización la usa): ahí,
  // una máquina sin el binario se avisa aunque el repo todavía no tenga `.codegraph/`
  const hasIndex = fs.existsSync(path.join(repo, '.codegraph'));
  if (hasIndex || (integrations && integrations.codegraph === true)) {
    const bin = findBinary(KNOWN_CLI.codegraph.bin);
    expected.push({
      name: 'codegraph',
      mcp_prefix: 'mcp__codegraph__',
      why: hasIndex
        ? `.codegraph/ presente en ${repo} — el repo tiene índice CodeGraph (regla del equipo: "CodeGraph primero" para todo lookup de símbolos)`
        : 'integrations.codegraph prendida — tu organización usa CodeGraph; el índice lo arma cada máquina (scripts/setup/install-codegraph)',
      binary_found: bin,
      cli_fallback: KNOWN_CLI.codegraph.cli,
      fallback: 'grep/Glob (más lento, sin call-graph ni impact analysis)',
      raise_it: raisePlaybook(bin, KNOWN_CLI.codegraph),
      if_unavailable: 'AVISAR al user en 1 línea ANTES de degradar: "el repo tiene CodeGraph pero el MCP no está en esta sesión". Después seguir `raise_it` (CLI si el binario está; instalación si no).',
    });
  }
  // engram se espera salvo que su integración esté apagada: afuera, sin la integración,
  // el arranque no avisa que falta una herramienta que nadie pidió.
  if (!integrationOff('engram')) {
    const bin = findBinary(KNOWN_CLI.engram.bin);
    expected.push({
      name: 'engram',
      mcp_prefix: 'mcp__plugin_engram_engram__',
      why: 'protocolo de memoria persistente SIEMPRE activo (guides/integrations/engram-workflow.md) — el Step 2 inyecta gotchas previos del repo y el cierre guarda session_summary',
      binary_found: bin,
      cli_fallback: KNOWN_CLI.engram.cli,
      fallback: 'run sin memoria persistente (Step 2 pierde las lecciones previas; el cierre no guarda summary)',
      raise_it: raisePlaybook(bin, KNOWN_CLI.engram),
      if_unavailable: 'AVISAR al user en 1 línea ANTES de seguir: "engram MCP no disponible → este run pierde memoria persistente". Después seguir `raise_it` (el CLI engram cubre search/sync para este run).',
    });
  }
  expected.push({
    name: 'workflow-tool',
    mcp_prefix: 'Workflow',
    why: 'el Step 5b (adversarial deep-verify) corre vía la tool Workflow — sin ella el pase adversarial NO corre y se pierde la capa que cazó los bugs de E1',
    binary_found: null,
    cli_fallback: null,
    fallback: 'skip del 5b (cobertura reducida: solo los advisors single-pass)',
    raise_it: 'sin CLI alternativo (es una tool del harness) — si no está, PREGUNTAR al user si sigue sin el pase adversarial.',
    if_unavailable: 'AVISAR al user — esto NO es un skip silencioso legítimo: "la tool Workflow no está disponible → el pase adversarial 5b no puede correr; el run queda solo con los advisors single-pass. ¿Sigo igual?" El user decide.',
  });
  // Genérico: TODO MCP server que el
  // repo declare en su .mcp.json o en la config del proyecto (~/.claude.json →
  // projects[repo].mcpServers) es tooling esperado — cubre codebase_memory,
  // azure-devops, context7 y cualquier futuro sin tocar este script.
  const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const declared = {};
  const repoMcp = readJsonSafe(path.join(repo, '.mcp.json'));
  if (repoMcp && repoMcp.mcpServers) {
    for (const [n, cfg] of Object.entries(repoMcp.mcpServers)) declared[n] = { src: '.mcp.json del repo', command: (cfg && cfg.command) || null };
  }
  const userCfg = readJsonSafe(path.join(os.homedir(), '.claude.json'));
  const projCfg = userCfg && userCfg.projects && userCfg.projects[path.resolve(repo)];
  if (projCfg && projCfg.mcpServers) {
    for (const [n, cfg] of Object.entries(projCfg.mcpServers)) {
      if (!declared[n]) declared[n] = { src: 'config del proyecto (~/.claude.json)', command: (cfg && cfg.command) || null };
    }
  }
  for (const [name, info] of Object.entries(declared)) {
    if (expected.some((e) => e.name === name)) continue; // ya cubierto por una entry específica
    const k = knownFor(name);
    const bin = findBinary((k && k.bin) || info.command);
    expected.push({
      name,
      mcp_prefix: `mcp__${name}__`,
      why: `MCP server declarado en ${info.src} — el repo/equipo lo espera disponible`,
      binary_found: bin,
      cli_fallback: (k && k.cli) || null,
      fallback: 'depende de la tool (revisar qué step la usa)',
      raise_it: raisePlaybook(bin, k),
      if_unavailable: `AVISAR al user en 1 línea ANTES de degradar: "el repo declara el MCP ${name} pero no está disponible en esta sesión". Después seguir \`raise_it\`; si un step lo necesita y no hay fallback razonable → preguntar cómo seguir.`,
    });
  }
  expected.push(...expectedThirdPartySkills(opts));
  return {
    expected,
    note: 'El script detecta la EXPECTATIVA + si el BINARIO está (mecánico). La disponibilidad del MCP en el harness la verificás VOS (orquestador): tool esperada no disponible o que FALLA mid-run → avisar al user (1 línea) y seguir `raise_it` — CLI vía Bash si el binario está, aviso de instalación si no. Degradar en silencio = bug (PIPE-C9 / TOOL.i).',
  };
}

// ── pipeline.js model-hint — sugerencia de modelo de sesión por complejidad ──
// Los steps 2-4 (plan BMAD + implementación) corren
// INLINE en el main loop (tool Skill, no subagentes) → su modelo es el DE LA
// SESIÓN y solo el user puede cambiarlo con /model. Este comando computa la
// recomendación MECÁNICA para que el Step 0 (preflight) la compare con el modelo
// real de la sesión (el orquestador lo sabe por su system prompt) y sugiera el
// switch ANTES de gastar contexto — con sesión fresca por pipeline el
// preflight es el momento exacto para elegir modelo; /model conserva sesión y
// marker, no se pierde nada.
//
// Tiers (razón: el plan es el punto de mayor apalancamiento — un plan malo
// cascadea a re-loops del Step 5 — y la implementación es el mayor consumidor
// de tokens; opus ~1.7x sonnet):
//   LOW           → sonnet alcanza (opus también ok — no molestar si ya está ahí)
//   NORMAL común  → opus
//   NORMAL pesada → opus, con más esfuerzo (≥2 señales pesadas). Fable sólo si la organización lo declara
//                   (models.session.heavy): el arnés no lo sugiere solo.
// SIEMPRE advisory: el orquestador sugiere en 1 línea, el user decide, NUNCA bloquea.
function computeModelHint(args) {
  const rc = computeRiskClass(args);
  const content = args.story && fs.existsSync(args.story) ? readText(args.story) : '';
  const fm = parseFrontmatterPipeline(content);
  const created = parseFrontmatterList(content, 'files_to_create');
  const scopeFiles = args.files && args.files.length
    ? args.files
    : [...created, ...parseFrontmatterList(content, 'files_to_modify')];
  let acCount = 0;
  try { acCount = (require('./lib/story-checks.js').parseAcsFromSpec(content) || []).length; }
  catch { /* sin story-checks → señal muchos-acs queda en 0 (conservador) */ }

  const signals = [];
  const add = (name, hit, detail) => signals.push({ name, hit, detail });
  // en la liviana, cuántos archivos o ACs no piden un modelo mayor; en la completa, como siempre.
  const liviana = rc.run_size === 'liviana';
  add('superficie-grande', !liviana && scopeFiles.length > 12, `${scopeFiles.length} archivos en scope (umbral >12)${liviana ? ' — corrida liviana: no cuenta' : ''}`);
  add('muchos-acs', !liviana && acCount >= 10, `${acCount} ACs (umbral ≥10)${liviana ? ' — corrida liviana: no cuenta' : ''}`);
  add('codigo-nuevo-amplio', /CREATE/i.test(fm.approach || '') && created.length >= 5,
    `approach=${fm.approach || '(ausente)'} + ${created.length} files_to_create (umbral: CREATE y ≥5)`);
  add('multi-tanda', /^pipelines:/m.test(content), 'bloque pipelines: — entregas en tandas con interdependencias');
  add('migraciones-mas-codigo',
    scopeFiles.some((f) => /\.sql$|(^|\/)drizzle\//i.test(f)) && scopeFiles.some((f) => !/\.sql$/i.test(f)),
    'migración SQL + código en el mismo scope');
  add('scope-firmado', !!(fm.signed_for_sprint || fm.signed_ac_ref), 'scope firmado con cliente — costo de error alto');

  const heavyCount = signals.filter((s) => s.hit).length;
  const heavy = rc.risk === 'NORMAL' && heavyCount >= 2;
  // los valores salen de lib/models.js; con `models.session` de la organización, ésos (y also_ok
  // vacío); con techo obligatorio, recortados. La configuración llega por argumento: esta función no lee la máquina.
  const band = rc.risk === 'LOW' ? 'low' : (heavy ? 'heavy' : 'normal');
  const S = MODELOS.DEFAULTS.session;
  const hoy = { recommended: S[band], also_ok: band === 'normal' || S.normal === S[band] ? [] : [S.normal] };
  const org = args.orgModels && args.orgModels.declared ? args.orgModels.data : null;
  const avisos = [];
  const ses = org ? MODELOS.resolveSession({ org, band, today: hoy, warnings: avisos }) : { ...hoy, origin: 'default' };
  const recommended = ses.recommended;
  const alsoOk = ses.also_ok;
  const extra = {};
  if (org || args.sessionModel !== undefined) {
    const fam = MODELOS.normalizeSessionModel(args.sessionModel, equivalenciasDeModelos());
    const ceiling = MODELOS.ceilingOf(org);
    extra.session_check = fam
      ? { model: fam, ceiling, above: !!ceiling && MODELOS.rank(fam) > MODELOS.rank(ceiling) }
      : { model: null, reason: 'no se sabe el modelo de la sesión' };
    if (extra.session_check.above) {
      extra.session_warning = `la sesión corre en ${fam}, por encima del techo de la organización (${ceiling}): cambiá con /model o seguí; el arnés no la cambia`;
    }
  }
  const deLaOrg = ses.origin === 'organization' || recommended !== hoy.recommended;
  const out = {
    recommended_session_model: recommended,
    also_ok: alsoOk,
    risk: rc.risk,
    heavy,
    heavy_signal_count: heavyCount,
    signals,
    reason: rc.risk === 'LOW'
      ? 'risk LOW (superficie chica, sin firmas/SQL/paths sensibles) → sonnet alcanza; un modelo más caro acá es plata de más'
      : heavy
        ? `NORMAL + ${heavyCount} señales pesadas (${signals.filter((s) => s.hit).map((s) => s.name).join(', ')}) → ${recommended} con más esfuerzo`
        : 'NORMAL común → opus (sonnet se queda corto en el plan)',
    note: (deLaOrg ? `la sugerencia sale de la configuración de la organización (session.${band}${MODELOS.ceilingOf(org) ? `, techo ${MODELOS.ceilingOf(org)}` : ''}): ${recommended}. ` : '') +
      'ADVISORY para el MODELO DE SESIÓN (steps 2-4 corren inline). Orquestador: compará con tu modelo real (system prompt); si NO está en recommended+also_ok → sugerí `/model <recomendado>` en 1 línea (el switch conserva sesión y marker) y seguí con lo que el user decida. NUNCA bloquea.',
    ...extra,
  };
  if (avisos.length) Object.defineProperty(out, '_avisos', { value: avisos, enumerable: false });
  return out;
}

/** Las equivalencias Claude ↔ Codex del árbol de este skill (para reconocer el modelo de la sesión), o `{}`. */
function equivalenciasDeModelos() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'build', 'equivalences.json'), 'utf8')).models || {}; }
  catch (_) { return {}; }
}

// ── pipeline.js deep-review-gate — Step 5b adversarial ──
// Decide si corre el pase adversarial reproduce-or-refute (step-05b-adversarial-verify.md),
// que EJECUTA el código (bundlea/parsea/probe) en vez de LEER el diff como los 6 advisors
// single-pass: así encuentra falsos negativos (p.ej. un traversal en lanes/participants) que ellos no ven.
//
// Gate (siempre en NORMAL) = REUSA risk-class:
//   NORMAL → corre (donde el juicio de correctitud-en-runtime paga) · LOW → skip (superficie
//   chica ≤6 files, ya barata). Overrides, en orden de precedencia:
//   1) --no-deep-review / TYCON_NO_DEEP_REVIEW=1 (kill-switch, gana sobre todo)
//   2) .tycon/advisors.yaml `deep_review: always|off|auto`
//   3) --deep-review (fuerza on aun en LOW) / --ultracode (el orquestador lo pasa si ultracode ON)
//   4) .tycon/advisors.yaml `deep_review_always_paths:` — SUPERFICIE COMPARTIDA del repo: si el
//      diff toca una de esas rutas, corre AUNQUE el risk-class dé LOW. Está en el 4to
//      lugar a propósito: no puede pisar el kill-switch ni el `off` del dueño del repo, pero sí
//      gana sobre el criterio por tamaño de diff, que puede dejar pasar un defecto en superficie compartida.
//   5) default → risk-class (NORMAL run / LOW skip). Si el repo NO declaró superficie compartida,
//      el skip por LOW se decide a ciegas y el veredicto lo dice (`shared_surface_declared:false`).
// Corre UNA vez por corrida (default: se lanza al cierre del Step 4 y step-05b es el join; TYCON_5B_EARLY=0 → se lanza en 5b), NUNCA por re-loop D.i
// (re-correr el workflow sería ~N× su costo; los fixes los verifican los advisors del re-loop).
function deepReviewConfig(repo) {
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return null;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const m = line.match(/^deep_review\s*:\s*(always|off|auto)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ── Superficie compartida declarada por repo ─────────────────────
// El gate por risk-class mide TAMAÑO de diff (≤6 archivos → LOW → se saltea el pase adversarial).
// Hay defectos que no son función del tamaño sino de QUIÉN
// ejecuta el código roto: pueden terminar el proceso del host, o sea que se
// llevan puestos a todos los plugins cargados. Dos archivos en Services/Plugins/ no tienen el
// mismo radio de daño que dos archivos en una pantalla.
//
// Se declara POR REPO y no se adivina con una heurística global de nombres: el dueño del repo sabe
// cuál es su superficie compartida, y una regla que adivina acierta en unos repos y molesta en
// otros — un control que molesta se termina apagando. Costo de un falso positivo: un pase
// adversarial de más (~25 min, en background). Costo de un falso negativo: un hotfix.
//
//   .tycon/advisors.yaml
//   deep_review_always_paths:
//     - custom-forms/.../Services/Plugins/**
//
// La llave está dada de alta en lib/config-lint.js (si no, el lint la reportaría como desconocida
// en todos los repos que la usen — un control que grita en falso se apaga).
function deepReviewAlwaysPaths(repo) {
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return [];
  // 🔴 La lista se lee en sus tres formas, no sólo una. Leer UNA sola forma
  // de escribir la lista (bloque con guiones) descartaría en silencio las otras dos que YAML
  // acepta — y que el propio lib/config-lint.js ya soporta en su helper `lista()`:
  //     deep_review_always_paths: [Services/Plugins/**]      ← flow,    se leería VACÍA
  //     deep_review_always_paths: Services/Plugins/**        ← escalar, se leería VACÍA
  // Y un comentario al final del item quedaría pegado al glob (`- Services/Plugins/**  # el cargador`),
  // así que el patrón no matchearía nunca. Los tres casos terminan igual: el repo declaró su
  // superficie, el pase adversarial se saltea lo mismo, y el veredicto AFIRMA que no había nada
  // declarado. Una falla silenciosa en el control que existe para que no haya fallas silenciosas.
  const limpiar = (v) => String(v).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const out = [];
  let dentro = false;
  for (const linea of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(linea) || linea.trim() === '') continue;
    const cab = linea.match(/^deep_review_always_paths\s*:\s*(.*)$/);
    if (cab) {
      const valor = limpiar(cab[1]);
      const flow = valor.match(/^\[(.*)\]$/);
      if (flow) {                        // forma [a, b]
        for (const it of flow[1].split(',')) { const v = limpiar(it); if (v) out.push(v); }
        dentro = false;
      } else if (valor) {                // forma escalar en el mismo renglón
        out.push(valor);
        dentro = false;
      } else {                           // bloque: los items vienen abajo
        dentro = true;
      }
      continue;
    }
    if (dentro) {
      const item = linea.match(/^\s+-\s*(.+)$/);
      if (item) { const v = limpiar(item[1]); if (v) out.push(v); continue; }
      if (/^\S/.test(linea)) dentro = false;   // arrancó otra llave de primer nivel
    }
  }
  return out;
}

/** ¿Alguno de los archivos del diff cae en la superficie compartida declarada? */
function tocaSuperficieCompartida(repo, files) {
  const patrones = deepReviewAlwaysPaths(repo);
  if (!Array.isArray(files) || !files.length) return null;
  // 🔴 Stories de dos repos: un archivo de un repo hermano se juzga contra la superficie compartida que
  //    declara SU repo (su `.tycon/advisors.yaml`). Sin esto se saltearía («fuera del repo»): un cambio en la superficie
  //    compartida del frontend hermano nunca pediría el pase adversarial.
  for (const f of files) {
    const o = companionLib.ownerOf(f, repo);
    if (o.propio || !o.root) continue;
    for (const pat of deepReviewAlwaysPaths(o.root)) {
      if (matchGlob(o.rel, pat)) return { file: `${path.basename(o.root)}/${o.rel}`, pattern: pat, repo: o.root };
    }
  }
  if (!patrones.length) return null;
  // Normalizar antes de comparar: un absoluto con otro prefijo,
  // un `./` adelante o un `..` en el medio no matchearían NINGÚN patrón — falso negativo mudo, que
  // es justo el modo de falla que este control existe para cerrar.
  const raiz = path.resolve(repo);
  for (const f of files) {
    const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(raiz, f);
    const rel = path.relative(raiz, abs).replace(/\\/g, '/');
    if (rel.startsWith('../')) continue;        // fuera del repo: no es superficie de ESTE repo
    for (const pat of patrones) {
      if (matchGlob(rel, pat)) return { file: rel, pattern: pat };
    }
  }
  return null;
}

/**
 * Escribe una salida GRANDE por stdout y recién después sale.
 * `process.exit()` inmediato trunca lo que todavía no se volcó al pipe: el `--json` de la vista de
 * corridas (~1 MB) se cortaría en 64 KB. El callback del write se dispara cuando ese chunk salió,
 * y como los writes a stdout son ordenados, todo lo anterior ya salió también.
 */
function salidaGrande(texto, code) {
  // 🔴 `process.exitCode` + terminación natural, NUNCA `process.exit()` ni su callback.
  //
  // Dos riesgos en uno, los dos al intentar no truncar la salida:
  //   · `process.exit()` a secas TRUNCA una salida grande por pipe (el `--json` real pesa ~1 MB) —
  //     por eso no se vuelve a `exit()`.
  //   · El callback de `write()` es ASÍNCRONO: si `salidaGrande` retornara en el acto, el flujo del
  //     despachador seguiría de largo, no matchearía ningún otro comando y caería al texto de uso con
  //     `exit(1)` — que le ganaría la carrera al callback. O sea: JSON correcto, uso pegado abajo y
  //     salida 1. El orquestador parsea stdout e ignora el código, así que nadie lo vería; lo
  //     caza `tests/smart-reloop-blindness.test.js`.
  //
  // Con `exitCode` node termina solo cuando drena stdout: ni trunca ni miente el código.
  // 🔴 El llamador DEBE hacer `return` inmediatamente después — sin eso el flujo se vuelve a
  //    derramar al final del despachador. `tests/large-output.test.js` cubre las dos mitades.
  process.stdout.write(texto);
  process.exitCode = code;
}

let avisosDelPorton = [];
function computeDeepReviewGate(args) {
  avisosDelPorton = [];
  // 1) Kill-switch — gana sobre todo (flag ya volcado desde env en parseArgs).
  if (args.noDeepReview) {
    return { run: false, model: null, reason: 'forzado OFF (--no-deep-review / TYCON_NO_DEEP_REVIEW=1)' };
  }
  // Modelo — escalación mecánica por complejidad.
  // Default sonnet (recorta el $ ~5x vs Opus); story pesada (model-hint ≥2 señales)
  // → opus AUTOMÁTICO (anunciado). Fable no se ofrece nunca: sólo corre con --deep-review-fable,
  // el pedido explícito de quien corre el pipeline. Precedencia:
  // fable(flag) > opus(flag) > opus(ultracode) > opus(story pesada) > sonnet.
  const hint = computeModelHint({ ...args, orgModels: null });
  // El modelo sale de lib/models.js con la configuración de la organización y el pedido de la corrida, que llegan por
  // argumento (`args.orgModels`, `args.modelRequests`). Esta función no lee la máquina.
  // Precedencia: fable(flag) > opus(flag) > opus(ultracode) > pedido > organización > opus(pesada) > sonnet.
  const org = args.orgModels && args.orgModels.declared ? args.orgModels.data : null;
  const avisos = [];
  const adv = MODELOS.resolveAdversarial({
    org, requests: args.modelRequests || null, heavy: hint.heavy, warnings: avisos,
    flags: { fable: !!args.deepReviewFable, opus: !!args.deepReviewOpus, ultracode: !!args.ultracode },
  });
  const model = adv.model;
  let modelReason;
  if (adv.capped || (adv.origin !== 'default' && !adv.fromFlag)) modelReason = adv.reason;
  else if (args.deepReviewFable) modelReason = '--deep-review-fable (autorización explícita del user)';
  else if (args.deepReviewOpus) modelReason = '--deep-review-opus';
  else if (args.ultracode) modelReason = 'ultracode ON → hunters en Opus';
  else if (hint.heavy) modelReason = `story pesada (${hint.heavy_signal_count} señales model-hint) → hunters escalan a Opus (anunciar)`;
  else modelReason = 'default (recorta $ ~5x vs Opus)';
  // Lanzamiento temprano del 5b al cierre del Step 4 — DEFAULT ON con
  // kill-switch (las mitigaciones
  // están cableadas — cap 2 de ventana, verificadores en ventana de 3, candado
  // anti-full-suite — y la primera corrida NORMAL ES la medición del cap). El switch queda
  // MECÁNICO acá (mismo patrón que TYCON_NO_DEEP_REVIEW), no en prosa que nadie lee:
  // export TYCON_5B_EARLY=0 → lanzamiento clásico en 5b; sin la env → temprano en el Step 4.
  const extras = {
    model_reason: modelReason,
    early_launch: process.env.TYCON_5B_EARLY !== '0',
  };
  // los avisos del techo los dice la línea de comandos (una vez por corrida): se dejan a mano, sin tocar la salida
  avisosDelPorton = avisos;
  // 2) Config por repo.
  const cfg = deepReviewConfig(args.repo);
  if (cfg === 'off') {
    // Si el repo apagó el 5b Y declaró superficie compartida, las dos cosas no pueden convivir en
    // silencio: la lista queda publicada y muerta, y el dueño del repo cree tener una protección
    // que no tiene. El `off` gana —es la decisión explícita del
    // dueño— pero se dice.
    const decl = deepReviewAlwaysPaths(args.repo);
    return {
      run: false, model: null,
      ...(decl.length ? { shared_surface_overridden: decl.length } : {}),
      reason: '.tycon/advisors.yaml deep_review: off' +
        (decl.length
          ? ` — ⚠ este repo declara ${decl.length} ruta(s) de superficie compartida que el \`off\` está dejando SIN efecto: o se saca el off, o se saca la lista (hoy dice una cosa y hace otra)`
          : ''),
    };
  }
  if (cfg === 'always') return { run: true, model, ...extras, reason: '.tycon/advisors.yaml deep_review: always' };
  // 3) Force-on explícito.
  if (args.deepReview) return { run: true, model, ...extras, reason: 'forzado ON (--deep-review)' };
  if (args.ultracode) return { run: true, model, ...extras, reason: 'ultracode ON → fuerza deep-review (hunters en Opus)' };
  // 4) Superficie compartida declarada por el repo — gana sobre el LOW por tamaño.
  const compartida = tocaSuperficieCompartida(args.repo, args.files);
  if (compartida) {
    return {
      run: true, risk: 'shared-surface', model, ...extras,
      shared_surface: compartida,
      reason: `el diff toca superficie compartida declarada por el repo (${compartida.file} ` +
              `matchea \`${compartida.pattern}\`) → corre aunque el risk-class sea LOW: ` +
              'una falla ahí no rompe una pantalla, se lleva puesto el proceso del host.',
    };
  }

  // 4c) Corrida liviana: sólo documentación → sin pase adversarial. Las superficies del repo ya
  //     decidieron arriba y además vuelven completa la corrida (lib/run-size.js).
  const runSize = computeRunSize(args);
  if (runSize.size === 'liviana') {
    return { run: false, risk: 'liviana', model: null, run_size: 'liviana', reason: `corrida liviana (${runSize.reason}) → sin pase adversarial; override: --deep-review o marker.js set-size completa --reason "<por qué>"` };
  }
  // 5) Default: gate por risk-class (siempre en NORMAL).
  const rc = computeRiskClass(args);
  // `computeRiskClass` devuelve `{risk:'NORMAL', error, ...}` SIN `criteria` cuando --story es
  // inválido/inexistente. Sin este guard, el `.filter` de abajo tiraría un TypeError con stack —
  // fail-ugly en un GATE es justo lo que empuja al bypass. Fail-loud legible: run:true (NORMAL es
  // el default seguro) + el error a la vista.
  if (!Array.isArray(rc.criteria)) {
    return {
      run: true, risk: 'NORMAL', model, ...extras,
      reason: `risk-class no computable (${rc.error || 'sin criteria'}) → deep-review corre por default seguro (NORMAL)`,
    };
  }
  if (rc.risk === 'NORMAL') {
    const failed = rc.criteria.filter((c) => !c.pass).map((c) => c.name);
    return {
      run: true, risk: 'NORMAL', model, ...extras,
      reason: `risk-class NORMAL → deep-review corre (criterios NORMAL: ${failed.join(', ') || 'scope no declarado'})`,
    };
  }
  // 4b) Densidad: el LOW por tamaño cuenta ARCHIVOS, no lógica. Una
  //     story de 4 archivos de código puede salir LOW y tener 6 defectos
  //     reales en esos mismos 4 archivos. Un diff angosto pero denso —muchas líneas agregadas en
  //     archivos de código— corre igual. Umbral: `TYCON_DEEP_REVIEW_DENSE_LINES` (default 300); la
  //     medición viaja en el veredicto para que el skip también la muestre.
  // 🔴 «No me dijiste qué mirar» NO es «no cambió nada».
  //
  // `densidadDelDiff` recorre `args.files`. Con la lista vacía el resultado es 0, y el
  // gate lo publicaría como `lineas_agregadas: 0` y saltaría el pase con el motivo «0 líneas
  // agregadas < 300». Eso se lee como una medición y no lo es. Por ejemplo, una invocación
  // sin `--files` sobre un cambio de 839 líneas contesta cero;
  // el salto sólo se evita si el dev pidió la revisión a mano.
  //
  // Se CORTA en vez de «correr por las dudas»: una corrida del pase midió 6,5 M de tokens y 30
  // minutos, así que revisar de más no es el lado barato. El error está en la llamada y se arregla
  // ahí; las dos invocaciones reales de los steps ya pasan `--files`. Los overrides explícitos del
  // dev (`--deep-review`, `--no-deep-review`, `deep_review:` del repo) ya decidieron más arriba y no
  // llegan hasta acá: el corte no puede tapar la puerta que alguien usa a propósito.
  // 🔴 Devuelve el veredicto; NO mata el proceso. `computeDeepReviewGate` es una función pura que
  //    el banco llama directo — un `process.exit` acá se lleva puesto al test que la ejercita.
  //    Quien decide el código de salida es la rama de línea de comandos, más abajo.
  //
  //    Y distingue «no me pasaste `--files`» (`filesDeclarado` ausente) de «me pasaste la lista
  //    vacía a propósito», que es lo que hacen los casos del banco al probar el skip por LOW.
  if (args.filesDeclarado === false) {
    return {
      run: null, risk: 'no-medible', model: null, ...extras,
      densidad_medida: false,
      reason: 'no pude medir la densidad del diff: me invocaste sin `--files`. Sin la lista de '
        + 'archivos de código no hay nada que contar, y un «0 líneas» acá sería un número que nadie '
        + 'calculó — se usaría para saltear el pase adversarial sin haber mirado. Pasá los archivos '
        + 'del diff (ver step-04 §Lanzamiento temprano y step-05b), o decidí explícito con '
        + '`--deep-review` / `--no-deep-review`.',
    };
  }
  const densidad = densidadDelDiff(args.repo, args.files, { allowMissing: Boolean(args.allowMissingFiles) });
  const noMedidos = {
    ...(densidad.noMedidos.length ? { archivos_no_medidos: densidad.noMedidos } : {}),
    ...(densidad.ausentes.length ? { archivos_ausentes_permitidos: densidad.ausentes } : {}),
  };
  if (densidad.lineas >= densidad.umbral) {
    return {
      run: true, risk: 'dense', model, ...extras,
      lineas_agregadas: densidad.lineas, umbral_lineas: densidad.umbral, ...noMedidos,
      reason: `risk-class LOW por tamaño (${Array.isArray(args.files) ? args.files.length : 0} archivos) pero el diff es DENSO: ` +
              `${densidad.lineas} líneas agregadas en archivos de código (umbral ${densidad.umbral}) → deep-review corre`,
    };
  }
  // 🔴 Un archivo que no se pudo medir no es «0 líneas». Lo medido
  //    es un piso: si ya pasa el umbral corre arriba; si no, saltear el pase con archivos sin medir sería
  //    decidir a ciegas, igual que sin `--files`. Se corta con las rutas y el motivo a la vista.
  if (densidad.noMedidos.length) {
    return {
      run: null, risk: 'no-medible', model: null, ...extras,
      densidad_medida: false,
      lineas_agregadas_medidas: densidad.lineas, umbral_lineas: densidad.umbral, ...noMedidos,
      reason: `no pude medir ${densidad.noMedidos.length} archivo(s) de código del diff `
        + `(${densidad.noMedidos.map((n) => `${n.file}: ${n.motivo}`).join(' · ')}); lo medido da `
        + `${densidad.lineas} líneas agregadas (umbral ${densidad.umbral}), pero lo que no se midió no cuenta `
        + 'como 0. Pasá rutas que estén dentro de un repo git (el de la story o un companion), o decidí '
        + 'explícito con `--deep-review` / `--no-deep-review`.',
    };
  }
  // Constancia de que se decidió A CIEGAS.
  // La lista de superficie compartida es opt-in por repo, así que un repo que nunca la declaró NO
  // está cubierto — y sin esta línea eso se lee igual que "no hacía falta". Queda escrito en el
  // veredicto y en gates.log: "no está cubierto" tiene que ser visible, no silencioso.
  const sinDeclarar = deepReviewAlwaysPaths(args.repo).length === 0;
  if (sinDeclarar) {
    logGate({
      repoPath: args.repo, name: 'deep-review-gate', check: 'shared-surface', status: 'undeclared',
      decision: 'skip-por-LOW', files: Array.isArray(args.files) ? args.files.length : 0,
    });
  }
  return {
    run: false, risk: 'LOW', model: null,
    lineas_agregadas: densidad.lineas, umbral_lineas: densidad.umbral,
    ...(sinDeclarar ? {
      shared_surface_declared: false,
      shared_surface_note:
        'este repo NO declaró `deep_review_always_paths` en .tycon/advisors.yaml, así que el skip se ' +
        'decidió SÓLO por tamaño de diff: si el cambio toca código que corre en nombre de todos los ' +
        'plugins/clientes, este gate no lo puede saber. Declararlo es de una vez por repo.',
    } : { shared_surface_declared: true }),
    reason: `risk-class LOW → skip (superficie chica ≤6 files y ${densidad.lineas} líneas agregadas < ${densidad.umbral}; override: --deep-review)`,
  };
}

/**
 * Líneas AGREGADAS en los archivos de código del diff. Cada archivo se mide en SU
 * repo git, el de su propia carpeta (`companionLib.ownerOf`, la misma pieza que usa el pipeline para leer el diff de
 * un repo hermano): tracked → `git diff --numstat HEAD` (0 si no cambió); sin
 * trackear en su repo → el archivo entero (es nuevo). Sólo extensiones de código: un HTML generado o
 * un JSON de datos no es lógica que un hunter tenga que ejecutar.
 *
 * 🔴 Stories de dos repos: la story vive en el backend y el código en el
 *    frontend, un repo companion. Medido con `git -C <repo de la story>`, cada archivo del frontend daría
 *    «no trackeado» y se sumaría ENTERO (1464 líneas contra 221 reales), y el portón correría el pase por
 *    «denso». Lo que no se puede medir (fuera de todo repo git, git que no contesta, un numstat que no es
 *    un número) NO se cuenta como archivo entero ni como 0: vuelve en `noMedidos`, y el portón lo dice.
 */
function densidadDelDiff(repo, files, { allowMissing = false } = {}) {
  const env = Number(process.env.TYCON_DEEP_REVIEW_DENSE_LINES);
  const umbral = Number.isFinite(env) && env > 0 ? env : 300;
  const { spawnSync: sp } = require('child_process');
  let lineas = 0;
  const noMedidos = [];
  const ausentes = [];   // con --allow-missing-files: ausentes y sin trackear, contados 0 a sabiendas
  for (const f of (Array.isArray(files) ? files : [])) {
    // el código de lib/code-files.js (con lo que sume la organización) más `.sql`
    if (!codeFiles.isCode(f, { extra: stackConfig.orgExtra() }) && !/\.sql$/i.test(f)) continue;
    const o = companionLib.ownerOf(f, repo || process.cwd());
    const abs = o.abs;
    if (!o.root) {
      // `ownerOf` sube un número fijo de carpetas buscando `.git`: un archivo más hondo se le escapa. Se le pregunta a git
      // desde la carpeta existente más cercana.
      let dir = path.dirname(abs);
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const top = sp('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const raiz = top.status === 0 ? String(top.stdout || '').trim() : '';
      if (raiz) {
        o.root = raiz;
        o.rel = path.relative(fs.realpathSync(raiz), path.join(fs.realpathSync(dir), path.relative(dir, abs))).split(path.sep).join('/');
      }
    }
    // `ownerOf` da como raíz la carpeta de `--repo` aunque no sea un repo git: eso tampoco se puede medir
    if (!o.root || !companionLib.gitRootOf(o.root)) { noMedidos.push({ file: f, motivo: 'no está dentro de ningún repo git' }); continue; }
    const ls = sp('git', ['-C', o.root, 'ls-files', '--error-unmatch', '--', o.rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (ls.error) { noMedidos.push({ file: f, motivo: `no pude correr git (${ls.error.message})` }); continue; }
    // `ls-files --error-unmatch`: 0 = trackeado, 1 = no trackeado. Cualquier otra salida (128 por safe.directory o un repo
    // roto, una señal) es «git no pudo decir», no «no trackeado»: sumarlo entero sería un error.
    if (ls.status !== 0 && ls.status !== 1) { noMedidos.push({ file: f, motivo: `git no pudo decir si está trackeado en ${o.root} (salida ${ls.status === null ? `señal ${ls.signal}` : ls.status})` }); continue; }
    const tracked = ls.status === 0;
    if (tracked) {
      const r = sp('git', ['-C', o.root, 'diff', '--numstat', 'HEAD', '--', o.rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const salida = String(r.stdout || '').trim();
      if (r.status !== 0) { noMedidos.push({ file: f, motivo: `git diff falló en ${o.root}` }); continue; }
      if (!salida) continue;   // tracked y sin cambios respecto de HEAD: 0 agregadas, medido
      const a = Number(salida.split(/\s+/)[0]);
      if (Number.isFinite(a)) lineas += a;
      else noMedidos.push({ file: f, motivo: `git diff --numstat no dio un número («${salida.split(/\s+/)[0]}»: ¿binario?)` });
    } else {
      let texto;
      try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) {
        // con `--allow-missing-files` quien llama ya dijo que puede haber archivos que no están (borrados): ausente = 0
        // borrado por el cambio (`git rm`, o el nombre viejo de un `git mv`): no está en el índice ni en el disco, pero
        // sí en HEAD. Agrega 0 líneas, medido (sin esto, cortaría stories de un solo repo).
        if (e.code === 'ENOENT' && sp('git', ['-C', o.root, 'cat-file', '-e', `HEAD:${o.rel}`], { stdio: 'ignore' }).status === 0) continue;
        if (allowMissing && e.code === 'ENOENT') { ausentes.push(f); continue; }
        noMedidos.push({ file: f, motivo: `no está trackeado en ${o.root} y no lo pude leer (${e.code || e.message})` });
        continue;
      }
      lineas += texto.split('\n').length;
    }
  }
  return { lineas, umbral, noMedidos, ausentes };
}

// ── pipeline.js timing-report — instrumentación ─
// Desglosa dónde se fue el wall-clock de la corrida: steps (marker.stepTimings),
// iteraciones del Step 5 (marker.iterations) y gates ejecutados (gates.log).
// Sin esto, los "25 min" son anécdota y los speedups se priorizan a ciegas.
function computeTimingReport() {
  const marker = readSessionMarker();
  if (!marker || !marker.storyId) {
    return { error: 'sin marker activo en esta sesión — timing-report opera sobre la corrida en curso' };
  }
  const timings = marker.stepTimings || {};
  const events = [];
  if (marker.startedAt) events.push({ label: 'pipeline-start', ts: marker.startedAt });
  for (const [step, t] of Object.entries(timings)) {
    // El arranque también es un evento — sin él, delta_min del paso incluiría el hueco previo.
    if (t && t.startedAt) events.push({ label: `step-${step}-start`, ts: t.startedAt });
    if (t && t.completedAt) events.push({ label: `step-${step}-done`, ts: t.completedAt });
  }
  for (const [iter, snap] of Object.entries(marker.iterations || {})) {
    if (snap && snap.ts) events.push({ label: `step5-iter${iter}-snapshot`, ts: snap.ts });
  }
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const rows = events.map((e, i) => ({
    ...e,
    delta_min: i === 0 ? 0 : Math.round((new Date(e.ts) - new Date(events[i - 1].ts)) / 600) / 100,
  }));

  // Gates de esta sesión/story desde gates.log.
  let gates = [];
  try {
    const raw = fs.readFileSync(path.join(stateDirOf(os.homedir()), 'gates.log'), 'utf8');
    const sid = resolveSessionId();
    gates = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((g) => g && g.sessionId === sid && (!g.storyId || g.storyId === marker.storyId))
      .map((g) => ({ ts: g.ts, check: g.check, status: g.status, durationMs: g.durationMs, provenance: g.provenance }));
  } catch { /* sin gates.log */ }

  const totalMin = events.length >= 2
    ? Math.round((new Date(events[events.length - 1].ts) - new Date(events[0].ts)) / 600) / 100
    : 0;
  return {
    story_id: marker.storyId,
    total_min_so_far: totalMin,
    timeline: rows,
    gates,
    note: 'delta_min = minutos desde el evento anterior. Steps sin complete-step no aparecen (corré marker.js complete-step N al cerrar cada step).',
  };
}

// ── Validación de --files ─────────────────────────────
// Un --files mal expandido por el shell (p.ej. zsh NO hace word-split de
// variables sin comillas → N paths llegan como UN argumento inexistente) haría
// que detectStack viera 0 archivos de código → onlyDocs=true → set degradado a 3
// advisors, PERSISTIDO como expected[] (check-count validaría contra 3 con 13
// faltantes — fail-open silencioso). Acá: si >0 files no existen → ABORT exit 2.
// Override consciente para diffs con archivos borrados: --allow-missing-files.
/**
 * ¿`--files` llegó como UN solo argumento con espacios? (word-split del shell fallado)
 *
 * Vive aparte de `validateFilesExist`: los gates
 * `risk-class` y `deep-review-gate` necesitan ESTA guarda y NO la validación de existencia
 * (un diff que borra archivos pasa paths que ya no existen — legítimo, y con la validación de existencia esos
 * dos comandos abortarían en un diff válido). `advisors` y `smart-reloop` siguen corriendo las dos.
 *
 * @returns {string|null} el mensaje de error, o null si está bien
 */
function detectarWordSplit(args) {
  if (!args || !Array.isArray(args.files) || args.files.length !== 1) return null;
  const uno = args.files[0];
  // Las DOS condiciones son necesarias: un solo argumento CON espacios que además NO existe en
  // disco. Sin la de los espacios, un diff que borra su único archivo abortaría (caso legítimo);
  // sin la de existencia, un path real con espacios (macOS) abortaría también.
  if (!/\s/.test(String(uno))) return null;
  const absUno = path.isAbsolute(uno) ? uno : path.join(args.repo || '.', uno);
  if (!exists(absUno)) {
    const pedazos = uno.split(/\s+/).filter(Boolean);
    const existen = pedazos.filter((f) => exists(path.isAbsolute(f) ? f : path.join(args.repo || '.', f)));
    return (
    '🛑 --files llegó como UN SOLO argumento con espacios (word-split fallado).\n' +
    `  recibido: ${uno.length > 200 ? `${uno.slice(0, 200)}…` : uno}\n` +
    `  partido por espacios: ${pedazos.length} paths, ${existen.length} existen en disco.\n` +
    'Causa: zsh NO word-splitea $VAR sin comillas — usá ${=VAR} o pasá los paths explícitos.\n' +
    'Por qué ABORTA y no sigue: con 1 archivo contado, risk-class da LOW y eso apaga DOS frenos\n' +
    'a la vez — el checkpoint HITL del plan (auto_approve_plan) y el pase adversarial del 5b\n' +
    '(deep-review-gate) — sin dejar rastro de que se apagaron por un error de parseo.\n'
    );
  }

  return null;
}

/**
 * ¿Algún `--files` es un FANTASMA?
 *
 * Fantasma = no está en el disco Y git no lo conoce en `HEAD` del repo que lo contiene. Un archivo que el cambio BORRÓ
 * está en `HEAD`: es legítimo y pasa. Lo que no está en
 * ningún lado es una lista rota: `--files a.cs,b.cs` en un solo argumento, sin espacios, que `detectarWordSplit` no ve.
 * Con esa entrada `densidadDelDiff` contaría 0 líneas, el gate daría LOW y
 * `run:false` sobre un cambio de ~955 líneas, y nada lo diría. Las rutas absolutas de otro repo se juzgan en SU repo.
 * Override consciente: `--allow-missing-files`.
 *
 * @returns {string|null} el mensaje de error, o null si está bien
 */
function archivosFantasma(args) {
  if (!args || args.allowMissingFiles || !Array.isArray(args.files) || !args.files.length) return null;
  const { execFileSync } = require('child_process');
  // 'si' = git lo conoce en HEAD (un borrado) · 'no' = git respondió y no lo conoce · 'sin-git' = no hubo a quién
  // preguntarle (fuera de un repo, sin git, sin HEAD). Los dos últimos frenan, pero el mensaje dice cuál fue.
  const enHead = (abs) => {
    // el ancestro más cercano que existe: ahí se le pregunta a git (un archivo borrado puede dejar su carpeta vacía)
    let dir = path.dirname(abs);
    while (!exists(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    let raiz;
    try {
      raiz = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      execFileSync('git', ['-C', raiz, 'rev-parse', '--verify', '--quiet', 'HEAD'], { stdio: 'ignore' });
    } catch { return 'sin-git'; }
    const rel = path.relative(fs.realpathSync(raiz), path.join(fs.realpathSync(dir), path.relative(dir, abs))).split(path.sep).join('/');
    if (!rel || rel.startsWith('../')) return 'no';
    try { execFileSync('git', ['-C', raiz, 'cat-file', '-e', `HEAD:${rel}`], { stdio: 'ignore' }); return 'si'; } catch { return 'no'; }
  };
  const fantasmas = [];
  let sinGit = 0;
  for (const f of args.files) {
    const abs = path.isAbsolute(f) ? f : path.join(args.repo || '.', f);
    if (exists(abs)) continue;
    const v = enHead(path.resolve(abs));
    if (v === 'si') continue;
    if (v === 'sin-git') sinGit++;
    fantasmas.push(f);
  }
  if (!fantasmas.length) return null;
  return (
    `🛑 ${fantasmas.length}/${args.files.length} de los --files no están en el disco NI en HEAD (no son archivos borrados):\n` +
    fantasmas.slice(0, 8).map((m) => `  - ${m}`).join('\n') +
    (fantasmas.length > 8 ? `\n  ... y ${fantasmas.length - 8} más` : '') +
    '\n\nCausa típica: la lista separada por comas en un solo argumento, o una expansión de shell rota (zsh NO\n' +
    'word-splitea $VAR sin comillas — usá ${=VAR} o pasá los paths explícitos, separados por espacio).\n' +
    'Por qué FRENA: un archivo que no existe cuenta 0 líneas, y con 0 líneas el veredicto da LOW — eso apaga el\n' +
    'checkpoint del plan y el pase adversarial sin dejar rastro de que la entrada estaba rota.\n' +
    (sinGit ? `Ojo: para ${sinGit} de ellos no pude preguntarle a git (fuera de un repo, sin git o sin commits): si son\n` +
      'archivos BORRADOS por el cambio, no pude confirmarlo — revisá la lista y, si está bien, --allow-missing-files.\n' : '') +
    'Si de verdad hay que seguir con archivos que no están: --allow-missing-files.\n'
  );
}

function validateFilesExist(args, opts) {
  // `validarStory`: los gates `risk-class` / `deep-review-gate` reusan esta
  // validación SÓLO por los --files. La rama de --story NO se les aplica: para ellos, una story
  // ilegible tiene una decisión propia — devolver el default
  // SEGURO (`run:true` / NORMAL) con el error a la vista, porque un gate que aborta feo es justo
  // lo que empuja al bypass. Acá se respeta esa cerca en vez de pisarla de refilón.
  const validarStory = !opts || opts.validarStory !== false;
  if (args.allowMissingFiles) return null;
  // La variante "expansión a CERO args"
  // (`--files $VAR` con VAR vacía en zsh = empty removal) es el mismo fail-open que la
  // variante "1 arg fantasma" — set degradado a onlyDocs y expected[] corrupto persistido.
  if (!args.files.length) {
    return (
      '🛑 --files llegó VACÍO (0 paths).\n' +
      'Causa típica: variable de shell vacía/unset (`--files $VAR`). Pasá los archivos del diff explícitos —\n' +
      'un set computado sin files degrada a onlyDocs (~3 advisors) y PERSISTE un expected[] corrupto (caso 9.4).\n' +
      'Si la iteración legítimamente no tiene archivos (¿seguro?) → --allow-missing-files.\n'
    );
  }
  const aridadErr = detectarWordSplit(args);
  if (aridadErr) return aridadErr;
  // --story también se valida (misma clase de falla: typo en el path → mech-check no corre
  // ningún check y la story se trata como ilegible).
  if (validarStory && args.story && !exists(path.isAbsolute(args.story) ? args.story : path.join(args.repo, args.story))) {
    return (
      `🛑 --story NO existe en disco: ${args.story}\n` +
      'Con story ilegible mech-check no corre ningún check y el set/validaciones se computan a ciegas.\n'
    );
  }
  const missing = args.files.filter((f) => {
    const abs = path.isAbsolute(f) ? f : path.join(args.repo, f);
    return !exists(abs);
  });
  if (!missing.length) return null;
  return (
    `🛑 ${missing.length}/${args.files.length} de los --files NO existen en disco:\n` +
    missing.slice(0, 8).map((m) => `  - ${m}`).join('\n') +
    (missing.length > 8 ? `\n  ... y ${missing.length - 8} más` : '') +
    '\n\nCausa típica: expansión de shell rota (zsh NO word-splitea $VAR sin comillas — usá ${=VAR} o pasá los paths explícitos).\n' +
    'Un set computado sobre files fantasma degrada a onlyDocs y PERSISTE un expected[] corrupto (caso 9.4 2026-06-11).\n' +
    'Si el diff incluye archivos BORRADOS legítimos → re-corré con --allow-missing-files.\n'
  );
}

// ── pipeline.js dep-gate — gate mecánico de dependencias nuevas ─
// bmad-dev-story HALTea si la implementación agrega dependencias fuera del spec
// ("new dependencies beyond story specifications → HALT: need user approval"). TYCON no
// tiene check equivalente: los advisors de seguridad atrapan un paquete VULNERABLE, no un
// paquete legítimo que nadie aprobó. Corre en Step 4 (post-build): diffea las dependencias
// AGREGADAS en package.json / *.csproj / Directory.Packages.props vs HEAD contra el texto de
// la story. Un paquete nuevo cuyo nombre NO aparezca en la story → undeclared → PAUSA HITL.
// Regla mecánica y verificable (no inferencia, estilo E.i): "declarado" = el nombre del
// paquete aparece textualmente en la story (case-insensitive) — conservador a propósito.
function computeDepGate({ repo, story }) {
  const { execFileSync } = require('child_process');
  const storyAbs = story ? (path.isAbsolute(story) ? story : path.join(repo, story)) : null;
  const storyText = storyAbs ? readText(storyAbs) : '';
  // 🔴 Stories de dos repos: el código —y sus dependencias— pueden vivir en un repo hermano declarado
  //    (`evidence.companion_repos`). Mirando sólo el repo de la story, un paquete nuevo del hermano no se vería.
  let raices = [repo];
  let hermanosError = null;
  const hermanosFaltan = [];
  try {
    raices = [repo, ...companionLib.companionRoots(repo, storyAbs, { onMissing: (nombre, quien) => hermanosFaltan.push({ repo: nombre, motivo: `declarado en ${quien} y no está en disco` }) })];
  } catch (e) { hermanosError = e.message; }
  const diffs = [];
  const sinMedir = [];
  const MANIFIESTOS = ['package.json', '*/package.json', '**/package.json',
    '*.csproj', '**/*.csproj', 'Directory.Packages.props', '**/Directory.Packages.props'];
  const gitDe = (raiz, a, input) => execFileSync('git', ['-C', raiz, ...a], { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  for (const raiz of raices) {
    try {
      // Sin commits todavía (el repo recién iniciado al arrancar) la base es el árbol vacío: todo es nuevo.
      let base = 'HEAD';
      try { gitDe(raiz, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']); } catch {
        gitDe(raiz, ['rev-parse', '--git-dir']);   // sin git sigue al catch de afuera
        base = gitDe(raiz, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
      }
      let diff = gitDe(raiz, ['diff', base, '--unified=0', '--', ...MANIFIESTOS]);
      // Un manifiesto sin trackear no aparece en `git diff`: se lee entero, como agregado. De un package.json cuentan
      // sólo sus listas de dependencias (si no, `"version": "1.0.0"` pasaría por una).
      // Lo instalado no es del proyecto: en una carpeta recién iniciada todavía no hay .gitignore, y sin este filtro cada
      // node_modules/*/package.json pasaría sus dependencias como nuevas.
      const sinTrackear = gitDe(raiz, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...MANIFIESTOS]).split('\0')
        .filter((rel) => rel && !rel.split('/').includes('node_modules'));
      for (const rel of sinTrackear) {
        let txt;
        try { txt = fs.readFileSync(path.join(raiz, rel), 'utf8').replace(/^﻿/, ''); } catch (e) { hermanosFaltan.push({ repo: raiz, motivo: `no pude leer ${rel} (${e.code || e.message})` }); continue; }
        if (path.basename(rel) === 'package.json') {
          let pj;
          try { pj = JSON.parse(txt); } catch (e) { hermanosFaltan.push({ repo: raiz, motivo: `${rel} no es JSON válido (${e.message})` }); continue; }
          for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            for (const [n, v] of Object.entries((pj && typeof pj[k] === 'object' && pj[k]) || {})) diff += `\n+${JSON.stringify(n)}: ${JSON.stringify(String(v))}`;
          }
        } else {
          diff += `\n${txt.split(/\r?\n/).map((l) => `+${l}`).join('\n')}`;
        }
      }
      diffs.push(diff);
    } catch (e) {
      const causa = String((e && (e.stderr || e.message)) || e).trim().split('\n')[0];
      if (raiz === repo) return { gate: 'no-medido', reason: `la carpeta no tiene git (o git falló: ${causa}): no pude mirar qué dependencias son nuevas — lo que no se miró no cuenta como «sin dependencias nuevas»`, new_deps: [] };
      sinMedir.push({ raiz, causa });
    }
  }
  // Un paquete es NUEVO solo si su nombre aparece en líneas '+' pero NO en '−'. Esto
  // filtra el churn de coma (agregar una dep le suma ','  a la anterior → git la marca
  // cambiada) y los bumps de versión (misma dep, otro número — no es "nueva", no requiere
  // aprobación de dependencia). Semántica BMAD: "new dependencies", no "changed".
  const parseDepLine = (line, sign) => {
    if (!line.startsWith(sign) || line.startsWith(sign.repeat(3))) return [];
    const npm = line.match(new RegExp(`^\\${sign}\\s*"([^"]+)"\\s*:\\s*"([~^>=<*\\dvxX][^"]*)"\\s*,?\\s*$`));
    if (npm) return [{ name: npm[1], ecosystem: 'npm' }];
    const out = [];
    for (const m of line.matchAll(/<Package(?:Reference|Version)\s+Include="([^"]+)"/gi)) {
      out.push({ name: m[1], ecosystem: 'nuget' });
    }
    return out;
  };
  const seen = new Set();
  const deps = [];
  for (const diffDeUnRepo of diffs) {
    const added = [];
    const removedNames = new Set();
    for (const line of diffDeUnRepo.split(/\r?\n/)) {
      for (const d of parseDepLine(line, '+')) added.push(d);
      for (const d of parseDepLine(line, '-')) removedNames.add(d.name);
    }
    for (const d of added) if (!removedNames.has(d.name) && !seen.has(d.name)) { seen.add(d.name); deps.push(d); }
  }
  const declared = [];
  const undeclared = [];
  // `@playwright/test` lo instaló la preparación de la prueba con navegador con el ok de la persona (lib/browser-test.js):
  // esa aprobación ya está anotada para este repo, y no se le vuelve a preguntar
  const preparado = (() => {
    try {
      const bt = require('./lib/browser-test.js');
      const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); } };
      return bt.gates(require('./lib/story-gate-io.js').DEFAULT_STATE_DIR)
        .some((g) => g.name === bt.PREPARED && g.repoPath && real(g.repoPath) === real(repo));
    } catch (e) { process.stderr.write(`⚠️  dep-gate: no pude leer si la prueba con navegador se preparó con el ok de la persona (${e.message})\n`); return false; }
  })();
  for (const d of deps) {
    const re = new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    (re.test(storyText) || (preparado && d.name === '@playwright/test') ? declared : undeclared).push(d.name);
  }
  // un hermano que no se pudo diffear no es «sin dependencias nuevas»: se dice
  const noMedidos = [...sinMedir.map((r) => ({ repo: r.raiz, motivo: `git falló: ${r.causa}` })), ...hermanosFaltan,
    ...(hermanosError ? [{ repo: null, motivo: `no pude leer los repos hermanos declarados: ${hermanosError}` }] : [])];
  return {
    gate: undeclared.length ? 'pause' : 'pass',
    new_deps: deps.map((d) => d.name),
    declared,
    undeclared,
    repos: raices,
    ...(noMedidos.length ? { repos_no_medidos: noMedidos } : {}),
    note: undeclared.length
      ? `⚠️ ${undeclared.length} dependencia(s) NUEVA(s) no declarada(s) en la story: ${undeclared.join(', ')}. `
        + 'PAUSA HITL (adopción BMAD): confirmá con el user que la dependencia es aceptada y agregala al spec ANTES del commit. '
        + 'Falso positivo (paquete legítimo mencionado con otro nombre en la story) → override consciente, anotalo.'
      : (deps.length ? `${deps.length} dependencia(s) nueva(s), todas mencionadas en la story — OK.` : 'Sin dependencias nuevas en el diff.'),
    ...(noMedidos.length ? { note_no_medidos: `⚠️ no pude mirar las dependencias de ${noMedidos.map((n) => n.repo || 'los repos hermanos').join(', ')}: lo que no se miró no cuenta como «sin dependencias nuevas».` } : {}),
  };
}

// ── pipeline.js next-story — auto-discovery de la próxima story ─
// bmad-dev-story Step 1 lee sprint-status.yaml y encuentra la primera ready-for-dev en orden,
// con menú de recuperación si no hay ninguna. Esto evita pasar el path del spec a mano.
// Esto lo automatiza sobre la convención TYCON (specs/stories/N-M-*.md con status: en
// frontmatter). NO arranca el pipeline — devuelve el path para que el orquestador corra
// `start --story` (respeta la separación: discovery ≠ mutación).
// "2-10-foo" → [2, 10]; orden NUMÉRICO (no lexicográfico: "2-10" va después de "2-9").
// La clave sale de lib/story-discovery.js: el mismo criterio que usa el descubridor para ordenar
// las stories que encuentra. Dos copias de una regla de orden son la
// versión chiquita del problema que este archivo existe para evitar.
const { idSortKey: storyIdSortKey } = require('./lib/story-discovery.js');
const { resolveSessionId, sessionIdFileKey } = require("./lib/session-id.js");
function cmpStoryId(a, b) {
  const ka = storyIdSortKey(a);
  const kb = storyIdSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] === undefined ? Infinity : ka[i]) - (kb[i] === undefined ? Infinity : kb[i]);
    if (d) return d;
  }
  return a < b ? -1 : (a > b ? 1 : 0);
}
// next-story usa EL MISMO descubridor que el resto del arnés (lib/story-discovery.js).
// Si armara su propia lista con `readdirSync(<repo>/specs/stories)` filtrando por nombre de
// archivo (`/\d+-\d+/`): en todo repo con otro layout devolvería el error "no existe …/specs/stories"
// — por ejemplo, donde las stories viven en `specs/bizuit-bpmn-mcp/`. Dos buscadores
// distintos es garantía de que arreglar uno deje al otro roto.
function computeNextStory(args) {
  const { discoverStories, findRepoRoot } = require('./lib/story-discovery.js');
  const cwdRepo = path.resolve(args.repo || process.cwd());
  const repoRoot = findRepoRoot(cwdRepo) || cwdRepo;
  // `--specs-dir` sigue valiendo: acota el escaneo a ese subárbol (la config del repo se lee igual).
  const scanRoot = args.specsDir ? path.resolve(args.specsDir) : repoRoot;

  const recoveryOptions = (byStatus) => [
    (byStatus['in-progress'] && byStatus['in-progress'].length)
      ? `retomar una in-progress: ${byStatus['in-progress'].map((s) => s.story_id).join(', ')}`
      : null,
    'crear la próxima story (tycon-create-story) desde los epics',
    'validar/mejorar una story existente (tycon-story-validator) para pasarla a ready-for-dev',
    'pasar un path de story explícito a `pipeline.js start --story <spec>`',
  ].filter(Boolean);
  if (!exists(scanRoot)) {
    return { error: `no existe ${scanRoot} — pasá --specs-dir <dir> o corré desde un repo con stories`, options: recoveryOptions({}) };
  }

  // Presupuesto generoso: esto es un comando, no un hook por edición. Truncar acá sería peor que
  // tardar — un "no hay próxima story" falso manda a crear una que ya existe.
  const found = discoverStories(scanRoot, { configRoot: repoRoot, budgetMs: 15000, cache: false });

  const byStatus = { 'ready-for-dev': [], 'in-progress': [], review: [], done: [], blocked: [], other: [] };
  for (const s of found.stories) {
    const st = (s.status || 'other').toLowerCase();
    (byStatus[st] || byStatus.other).push({ story_id: s.id, story_path: s.path, sprint: s.sprint || null, title: s.title || null });
  }
  const scanned = {
    root: scanRoot,
    stories_found: found.stories.length,
    excluded: found.excluded.length,
    partial: found.partial,
    id_criterion: found.config && found.config.source ? `${found.config.source} (.tycon/advisors.yaml)` : 'default (id jerárquico numérico)',
  };
  const warnings = found.warnings.slice();
  if (found.stories.length === 0) {
    warnings.push(
      `0 stories Mary+GOLD bajo ${scanRoot}. Una story es un .md cuyo frontmatter declara \`story:\` y \`status:\`, ` +
      `y cuyo id tiene forma de trabajo (${scanned.id_criterion}). Diagnóstico: ` +
      'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/story-discovery.js --doctor --repo <dir>',
    );
  }

  const nextReady = byStatus['ready-for-dev'][0] || null;
  if (nextReady) {
    return {
      next_story: nextReady,
      in_progress: byStatus['in-progress'],
      ready_count: byStatus['ready-for-dev'].length,
      scanned,
      warnings,
      command: `pipeline.js start --story ${nextReady.story_path} --repo <dir>`,
      note: byStatus['in-progress'].length
        ? `⚠️ Hay ${byStatus['in-progress'].length} story(s) in-progress (${byStatus['in-progress'].map((s) => s.story_id).join(', ')}) — ¿retomar una antes de arrancar ${nextReady.story_id}? El user decide.`
        : `Próxima ready-for-dev: ${nextReady.story_id}. Arrancá con el command de arriba (el user confirma).`,
    };
  }
  return {
    next_story: null,
    in_progress: byStatus['in-progress'],
    review: byStatus.review,
    scanned,
    warnings,
    note: 'No hay stories ready-for-dev — menú de recuperación (mirror bmad-dev-story Step 1).',
    options: recoveryOptions(byStatus),
  };
}

// ── Review Follow-ups persistidos EN la story ────────
// La mejor idea de bmad-dev-story: el ciclo dev↔review vive DENTRO del artefacto
// (su sección "Review Follow-ups (AI)" con checkboxes por severidad) y sobrevive
// sesiones. Sin esto los findings viven solo en .advisors/pipeline-runs/ — si el
// pipeline muere post-Step 6 con un CRITICAL waived o WARNINGs abiertos, la próxima
// sesión no tiene lista accionable en la story (hay que arqueologizar el audit trail).
// Step 6/7 escribe los no-resueltos acá (write-followups); Step 0/1 los detecta al
// retomar (followups-status). Solo toca el BODY de la story — NUNCA el frontmatter
// contractual (esa transición sigue siendo exclusiva del orquestador vía marker.js).
const FOLLOWUPS_HEADING = '## Review Follow-ups (Advisors)';
// Normaliza un finding a la forma canónica del writer, tolerando tanto el shape del
// findings.json del Step 6 ({rule_id, severity, advisor, file, disposition, reason})
// como el shape directo ({ruleId, severity, file, line, summary, resolved}).
function normalizeFinding(f) {
  const disposition = String(f.disposition || '').toLowerCase();
  return {
    ruleId: String(f.ruleId || f.rule || f.rule_id || '?').trim(),
    severity: String(f.severity || 'WARNING').toUpperCase(),
    file: f.file ? String(f.file).trim() : '',
    line: f.line || null,
    summary: String(f.summary || f.title || f.reason || '').trim().replace(/\s+/g, ' '),
    // resolved = cerrado. 'fixed' (arreglado) y 'refuted' (investigado y descartado por falso)
    // van [x]; waived/deferred/open quedan [ ]. Un refuted como [ ] sería deuda fantasma en la story.
    resolved: f.resolved === true || disposition === 'fixed' || disposition === 'refuted',
  };
}
function followupKey(f) {
  return `${String(f.ruleId || f.rule || f.rule_id || '?').trim()}|${String(f.file || '?').trim()}`;
}
function renderFollowupItem(nf, checked) {
  const loc = nf.file ? `\`${nf.file}${nf.line ? ':' + nf.line : ''}\`` : '(sin archivo)';
  return `- [${checked ? 'x' : ' '}] **[${nf.severity}]** ${nf.ruleId} — ${loc} — ${nf.summary} <!-- fkey:${nf.ruleId}|${nf.file || '?'} -->`;
}
function parseFollowupsSection(content) {
  const lines = (content || '').split(/\r?\n/);
  const hIdx = lines.findIndex((l) => l.trim() === FOLLOWUPS_HEADING);
  if (hIdx === -1) return null;
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const items = [];
  for (let i = hIdx + 1; i < end; i++) {
    const m = lines[i].match(/^- \[([ xX])\]\s.*<!--\s*fkey:(.+?)\s*-->\s*$/);
    if (m) items.push({ key: m[2].trim(), checked: m[1].toLowerCase() === 'x', raw: lines[i] });
  }
  return { hIdx, end, items };
}
function computeFollowupsStatus(args) {
  const storyPath = args.story;
  if (!storyPath || !exists(storyPath)) return { error: `--story inválido o no existe: ${storyPath}` };
  const parsed = parseFollowupsSection(readText(storyPath));
  if (!parsed) return { has_section: false, total: 0, open: 0, resolved: 0, items: [] };
  const open = parsed.items.filter((i) => !i.checked);
  return {
    has_section: true,
    total: parsed.items.length,
    open: open.length,
    resolved: parsed.items.length - open.length,
    items: parsed.items.map((i) => ({ key: i.key, checked: i.checked })),
    note: open.length
      ? `⚠️ ${open.length} review follow-up(s) ABIERTO(s) en la story — resolverlos (o waivearlos con el user) ANTES de re-cerrar. `
        + 'Priorizarlos sobre tasks nuevas (regla bmad-dev-story Step 3).'
      : 'Todos los review follow-ups de la story están resueltos.',
  };
}
// ── Los helpers mecánicos del cierre de una story ────
// El cierre de una story no relee la evidencia con un modelo. Lo que queda para decidir es mecánico y deja rastro: no lo infiere el orquestador (E.i).

// Candidatos a worker: sólo fuentes .NET. `BackgroundService`/`IHostedService` son tipos de .NET: un `.md`, una guía
// o un `.js` que los NOMBRA —este mismo archivo, que es el más tocado del arnés— no es un worker (con la
// lista amplia, todo cambio a pipeline.js invocaría el checker caro).
const CODIGO_PARA_WORKER = /\.(cs|vb|fs)$/i;
const TOPE_WORKER_BYTES = 20 * 1024 * 1024;
const WORKER_RE = /\b(BackgroundService|IHostedService)\b/;
const TX_RE = /TransactionScope|transacci[oó]n.*(rollback|compensa)/i;

// Una cita en backticks con metacaracteres de regex es un PATRÓN nombrado, no una declaración: una story que
// escribe `TransactionScope|transacci[oó]n.*(rollback|compensa)` en su propio AC no es una story con
// transacciones. Una mención simple (`TransactionScope`) sigue contando.
function sinPatronesCitados(linea) {
  // 🔴 Las citas se emparejan DE A DOS, de izquierda a derecha, y después se decide cuáles borrar. Una sola regex
  // «backtick, algo con metacaracteres, backtick» emparejaría el backtick que CIERRA una cita con el que ABRE la
  // siguiente y borraría la prosa del medio (con sus `**When**`): transacciones reales quedarían invisibles.
  return linea.replace(/`[^`]*`/g, (cita) => (/[|[\]()*\\]/.test(cita.slice(1, -1)) ? '' : cita));
}

/**
 * ¿Hace falta el `tycon-dod-runtime-checker` con modelo? Tres preguntas sobre lo que SÓLO él cubre:
 * (a) el diff de la corrida toca un worker, (b) los ACs declaran una transacción compleja, (c) hay una
 * tanda `in-progress`/`blocked`. Si ninguna → no se invoca. 🔴 La duda va hacia invocar: story ilegible,
 * sin base de la corrida o `git` que falla → invoca, con el motivo. Nunca «no hace falta» por no poder mirar.
 * `deps` inyecta la lectura del marcador (tests).
 */
function computeDodCheckerNeeded(args, deps = {}) {
  const preguntas = {};
  const motivos = [];
  const repo = args.repo;
  const storyPath = args.story;
  if (!storyPath || !exists(storyPath)) {
    return { invoca: true, motivos: [`no pude leer la story (${storyPath || 'falta --story'}): se invoca`], preguntas, story_id: null };
  }
  const story = readText(storyPath);
  const storyId = deriveStoryId(storyPath);

  // (b) transacción compleja declarada en los ACs
  const { acSectionOf, parsePipelinesBlock } = require('./lib/story-checks.js');
  const acs = acSectionOf(story);
  if (acs === null) {
    motivos.push('no pude leer la sección de Acceptance Criteria de la story: se invoca');
    preguntas.transaccion = { respuesta: null, detalle: 'sin sección de ACs legible' };
  } else {
    const linea = acs.split('\n').map(sinPatronesCitados).find((l) => TX_RE.test(l));
    preguntas.transaccion = { respuesta: !!linea, detalle: linea ? linea.trim().slice(0, 160) : 'ningún AC declara TransactionScope ni transacción con rollback/compensación' };
    if (linea) motivos.push('los ACs declaran una transacción compleja (rollback/compensación): lo verifica en runtime sólo el checker');
  }

  // (c) tandas en vuelo
  const abiertas = parsePipelinesBlock(story).filter((t) => /^(in-progress|blocked)$/i.test(String(t.status || '')));
  preguntas.tandas = { respuesta: abiertas.length > 0, detalle: abiertas.length ? abiertas.map((t) => `${t.name}: ${t.status}`).join(', ') : 'sin tandas in-progress/blocked' };
  if (abiertas.length) motivos.push(`hay tandas en vuelo (${preguntas.tandas.detalle}): multi-pipeline lo mira sólo el checker`);

  // (a) worker en el diff de la corrida
  const { resolver } = require('./lib/coverage-base.js');
  let base;
  let marcador = null;
  try {
    const lm = deps.leerMarcador ? deps.leerMarcador() : leerMarcadorDeLaCorrida();
    marcador = lm.marker;
    base = resolver({ repo, env: { TYCON_COVERAGE_BASE: args.base || '' }, marker: lm.marker, markerError: lm.error });
  } catch (e) {
    base = { ref: null, source: null, descartadas: [{ source: 'base', motivo: e.message }] };
  }
  // Lo que la corrida tocó en REPOS COMPAÑEROS (Backend/FrontEnd/Project) no está en el diff de --repo: lo trae el
  // marcador de la misma story: un worker creado en el backend saldría «no invocar».
  const deLaCorrida = marcador && Array.isArray(marcador.filesTouched)
    && (!marcador.storyId || String(marcador.storyId) === String(storyId))
    ? marcador.filesTouched.filter((f) => typeof f === 'string' && path.isAbsolute(f) && CODIGO_PARA_WORKER.test(f))
    : [];
  if (!base.ref || (base.source !== 'env' && base.source !== 'marcador')) {
    const por = (base.descartadas || []).map((d) => d.motivo).join('; ') || 'sin --base ni marcador de la corrida en este repo';
    motivos.push(`no pude mirar el diff de la corrida (sin base: ${por}): se invoca`);
    preguntas.worker = { respuesta: null, detalle: 'sin base de la corrida' };
  } else {
    const { spawnSync } = require('child_process');
    // Todo desde la RAÍZ del repo y sin comillas: `ls-files` desde una subcarpeta sólo lista esa subcarpeta, y con
    // `core.quotePath` por defecto una ruta con tilde sale entre comillas y con escapes.
    const t = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const top = t.error || t.status !== 0 ? null : t.stdout.trim();
    const git = (argv) => spawnSync('git', ['-C', top || repo, '-c', 'core.quotePath=false', ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const d = top ? git(['diff', '--name-only', '-z', base.ref]) : null;
    const u = top ? git(['ls-files', '--others', '--exclude-standard', '-z']) : null;
    const falla = [t, d, u].find((r) => !r || r.error || r.status !== 0);
    if (falla) {
      motivos.push(`no pude mirar el diff (${(falla && falla.error && falla.error.code) || (falla && (falla.stderr || '').trim().split('\n')[0]) || (falla ? `git salió ${falla.status}` : 'sin raíz del repo')}): se invoca`);
      preguntas.worker = { respuesta: null, detalle: 'git diff falló' };
    } else {
      const delDiff = [...d.stdout.split('\0'), ...u.stdout.split('\0')].filter(Boolean)
        .filter((f) => CODIGO_PARA_WORKER.test(f)).map((f) => path.join(top, f));
      const tocados = [...new Set([...delDiff, ...deLaCorrida])];
      const workers = [];
      const ilegibles = [];
      for (const abs of tocados) {
        if (!exists(abs)) continue; // borrado en la corrida: no hay worker que verificar
        const rel = abs.startsWith(top + path.sep) ? abs.slice(top.length + 1) : abs;
        try {
          if (fs.statSync(abs).size > TOPE_WORKER_BYTES) { ilegibles.push(rel); continue; }
          if (WORKER_RE.test(fs.readFileSync(abs, 'utf8'))) workers.push(rel);
        } catch { ilegibles.push(rel); }
      }
      if (ilegibles.length) motivos.push(`no pude leer ${ilegibles.length} archivo(s) .NET del diff (ilegibles o de más de 20 MB): se invoca`);
      preguntas.worker = { respuesta: workers.length > 0, detalle: workers.length ? workers.slice(0, 5).join(', ') : `ningún archivo .NET del diff ni de la corrida (${tocados.length}) es un worker` };
      if (workers.length) motivos.push(`el diff toca un worker (BackgroundService/IHostedService): ${workers.slice(0, 3).join(', ')}`);
    }
  }

  const invoca = motivos.length > 0;
  if (!invoca) motivos.push('ninguna de las tres superficies que sólo el checker cubre: no se invoca (story 7.2)');
  return { invoca, motivos, preguntas, story_id: storyId, base: base ? { ref: base.ref, source: base.source } : null };
}

// { marker, error }: un marker.js que falla se DICE, no se lee como «sin corrida» (patrón de coverage-base.js).
function leerMarcadorDeLaCorrida() {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'marker.js'), 'get'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (r.error) return { marker: null, error: `marker.js get no corrió (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { marker: null, error: `marker.js get salió ${r.status}` };
  try { return { marker: JSON.parse(r.stdout || '{}'), error: null }; } catch (e) { return { marker: null, error: `marker.js get devolvió algo ilegible (${e.message})` }; }
}

/**
 * ¿Quedan deudas abiertas de la story? En el step 9 evita relanzar dos revisores con modelo para
 * contestar lo que es un grep: tags `[story-<id>-…]` vivos en `tasks/todo.md` (no tachados ni marcados
 * `[x]`) o tandas del bloque `pipelines:` con `status != done`. `open` en true = hay deuda.
 */
// Lee la story SIN tragar el error: `readText` devuelve '' ante cualquier falla, y una story ilegible (una carpeta, un
// permiso) leída como vacía es «sin tandas» → «sin deuda».
function leerStoryOError(storyPath) {
  if (!storyPath) return { error: 'falta --story' };
  try { return { texto: fs.readFileSync(storyPath, 'utf8') }; } catch (e) { return { error: `${storyPath}: ${e.code || e.message}` }; }
}

function computeDeferralsOpen(args) {
  const storyPath = args.story;
  const leida = leerStoryOError(storyPath);
  if (leida.error) return { error: `no pude leer la story (${leida.error}): no se puede afirmar que no haya deuda` };
  const storyId = deriveStoryId(storyPath);
  const { parsePipelinesBlock } = require('./lib/story-checks.js');
  const tandas = parsePipelinesBlock(leida.texto).filter((t) => String(t.status || '').toLowerCase() !== 'done')
    .map((t) => ({ name: t.name, status: t.status || null }));
  const todoPath = path.join(args.repo || process.cwd(), 'tasks', 'todo.md');
  let tags = [];
  if (exists(todoPath)) {
    let texto;
    try { texto = fs.readFileSync(todoPath, 'utf8'); } catch (e) { return { error: `no pude leer tasks/todo.md (${e.code || e.message}): no se puede afirmar que no haya deuda` }; }
    // Dos formas del tag: con el id tal cual (`[story-<N.M>-…]`) y con guiones (`[story-<N-M>-…]`,
    // ACCOV-C4). En la de guiones, un segmento numérico más es OTRA story (`[story-<N-M-K>-…]` es
    // de la N.M.K). Vivo = no marcado `[x]` y FUERA de todo par `~~…~~` (los pares se quitan de a dos: un `~~` de
    // cierre anterior no puede tachar el tag).
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const formas = [new RegExp(`\\[story-${esc(storyId)}-`)];
    if (storyId.includes('.')) formas.push(new RegExp(`\\[story-${esc(storyId.replace(/\./g, '-'))}-(?!\\d+[-\\]])`));
    tags = texto.split('\n')
      .filter((l) => !/^\s*[-*]\s*\[[xX]\]/.test(l))
      .filter((l) => { const sinTachado = l.replace(/~~[\s\S]*?~~/g, ''); return formas.some((re) => re.test(sinTachado)); })
      .map((l) => l.trim().slice(0, 200));
  }
  const open = tags.length > 0 || tandas.length > 0;
  return { story_id: storyId, open, tags, tandas, todo: exists(todoPath) ? todoPath : null };
}

function writeFollowups(args) {
  const storyPath = args.story;
  if (!storyPath || !exists(storyPath)) return { error: `--story inválido o no existe: ${storyPath}` };
  let findings = [];
  if (args.findings) {
    const raw = readText(args.findings);
    try { findings = JSON.parse(raw); } catch (e) { return { error: `--findings no es JSON válido: ${e.message}` }; }
  }
  if (!Array.isArray(findings)) {
    return { error: '--findings debe apuntar a un array JSON de {severity,ruleId,file,line,summary,resolved?}' };
  }
  const content = readText(storyPath);
  const parsed = parseFollowupsSection(content);
  const prevChecked = new Map();
  if (parsed) for (const it of parsed.items) prevChecked.set(it.key, it.checked);

  const seen = new Set();
  const merged = [];
  for (const raw of findings) {
    const f = normalizeFinding(raw);
    const k = `${f.ruleId}|${f.file || '?'}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Preservar el checkbox previo por fkey (idempotente en re-loops); resolved lo fuerza a [x].
    const checked = f.resolved ? true : (prevChecked.has(k) ? prevChecked.get(k) : false);
    merged.push(renderFollowupItem(f, checked));
  }
  // Conservar TODOS los items previos que no vienen en el nuevo set — resueltos [x] (historial)
  // Y abiertos [ ] (deuda viva). Conservar SOLO los
  // `it.checked` haría que un follow-up ABIERTO que el advisor deja de reportar (típico de un item
  // deferred/gated como TEST-W4a, que el advisor no re-flaggea) se dropeara SILENCIOSAMENTE →
  // deuda técnica trackeada borrada sin rastro. Un item sale de [ ] SOLO explícitamente: viene en
  // un findings posterior con resolved:true (→ [x]), o un humano lo marca [x] a mano. Nunca por omisión.
  if (parsed) {
    for (const it of parsed.items) {
      if (!seen.has(it.key)) { merged.push(it.raw); seen.add(it.key); }
    }
  }
  if (!merged.length && !parsed) {
    return { wrote: false, note: 'Sin findings y sin sección previa — no se escribió nada.' };
  }
  const banner = '<!-- tycon-pipeline: generado por Step 6/7. Cada item = finding advisor no resuelto (CRITICAL waived o WARNING). Al resolver el finding en el código, marcá [x]. Step 0/1 detecta los abiertos al retomar (pipeline.js followups-status). -->';
  const sectionLines = [FOLLOWUPS_HEADING, '', banner, '', ...merged, ''];
  const lines = content.split(/\r?\n/);
  let out;
  if (parsed) {
    out = [...lines.slice(0, parsed.hIdx), ...sectionLines, ...lines.slice(parsed.end)];
  } else {
    const tail = content.endsWith('\n') ? [] : [''];
    out = [...lines, ...tail, '', ...sectionLines];
  }
  fs.writeFileSync(storyPath, out.join('\n'), 'utf8');
  const open = merged.filter((l) => /^- \[ \]/.test(l)).length;
  return { wrote: true, story_path: storyPath, total: merged.length, open, resolved: merged.length - open };
}

// ── findings.json del Step 6 — write determinista + gate de existencia ──────
// El findings.json ({rule_id, severity, advisor, file, disposition, reason}) es el insumo
// machine-parseable del retrospective-capturer (advisor_warnings_per_story / actioned_ratio,
// determinista sin LLM). Como WRITE MANUAL del orquestador en Step 6 se olvidaría y rompería el conteo.
// `write-findings` lo
// vuelve una llamada de script validada + ubicada sola; `findings-status` lo enforcea como
// pre-condición mecánica de Step 8 (exit 3 si falta → el orquestador lo escribe antes del commit).
const VALID_SEVERITY = new Set(['CRITICAL', 'WARNING']);
// 'refuted': hallazgo reportado,
// investigado y RETIRADO por falso (típicamente por el propio advisor). No es 'fixed' (no hubo
// arreglo) ni 'open' (no queda deuda). Exige reason con la refutación — sin reason degrada a
// 'open' con warning, porque un "es falso" sin evidencia es indistinguible de un "no lo miré".
const VALID_DISPOSITION = new Set(['fixed', 'waived', 'deferred', 'open', 'refuted']);
const DISPOSITION_ALIAS = { 'false-positive': 'refuted', 'false_positive': 'refuted', 'falso-positivo': 'refuted', 'falso positivo': 'refuted', 'refutado': 'refuted' };

function deriveStoryId(storyPath) {
  if (!storyPath || !exists(storyPath)) return null;
  const fm = parseFrontmatterPipeline(readText(storyPath)) || {};
  return String(fm.story || path.basename(storyPath, '.md')).trim() || null;
}

// La clave con que se nombra la carpeta de corrida, con el MOTIVO si no se puede calcular: `resolveRunDir` devuelve
// null en los dos casos («no hay carpeta» y «no hay clave»), y quien tiene que explicarle al dev qué pasó pregunta acá.
function runDirKey(storyId, storyPath) {
  return require('./lib/evidence-key.js').keyInfoOr(storyPath, storyId);
}

// Resuelve el dir de la corrida: el más reciente `<clave>-*` (o exactamente `<clave>`, o
// `story-<clave>-*`) bajo <repo>/.advisors/pipeline-runs/. Con create=true y ninguno → crea
// `<clave>-<UTC-stamp>`. Sin create y ninguno → null.
// La clave es la de la evidencia (`lib/evidence-key.js`): el número solo si es único en el repo de la
// story, `<tema>__<número>` si se repite. Con número repetido, otra story del mismo número tiene SU carpeta y retomar
// por el número elegiría la más nueva de las dos. Sin `storyPath` (quien sólo tiene el número) es el número.
// Con `storyPath` y sin poder calcular la clave → null: no se elige ni se crea una carpeta a ciegas.
function resolveRunDir(repo, storyId, create, storyPath) {
  const runsBase = path.join(repo, '.advisors', 'pipeline-runs');
  const { key } = runDirKey(storyId, storyPath);
  if (!key) return null;
  const { ownsName } = require('./lib/evidence-key.js');
  let names = [];
  try {
    names = fs.readdirSync(runsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => ownsName(n, key, storyId));
  } catch { names = []; }
  if (names.length) {
    // Puntuar por [tiene-archivos, mtime del archivo interno más reciente] — así un dir vacío/stray
    // (ej. creado por un `mkdir` accidental con RUNDIR sin resolver) PIERDE contra el dir que tiene
    // los reportes reales del run. Sin esto, "el dir con mtime más nuevo" elegiría la carpeta equivocada.
    let best = null; let bestHas = -1; let bestM = -1;
    for (const n of names) {
      const p = path.join(runsBase, n);
      let has = 0; let newest = 0;
      try {
        for (const f of fs.readdirSync(p)) {
          has = 1;
          try { newest = Math.max(newest, fs.statSync(path.join(p, f)).mtimeMs); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (!has) { try { newest = fs.statSync(p).mtimeMs; } catch { newest = 0; } }
      if (has > bestHas || (has === bestHas && newest > bestM)) { bestHas = has; bestM = newest; best = p; }
    }
    return best;
  }
  if (!create) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const dir = path.join(runsBase, `${key}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// El marcador de la sesión, con su estado: `ausente` (no existe), `ilegible` (existe y no se puede leer como objeto) u `ok`.
// 🔴 «no existe» y «no se puede leer» no son lo mismo: lo primero lo cubre la carpeta de la corrida, lo segundo frena.
function readSessionMarkerStrict() {
  const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`);
  if (!fs.existsSync(markerPath)) return { estado: 'ausente', marcador: null };
  try {
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (m && typeof m === 'object' && !Array.isArray(m)) return { estado: 'ok', marcador: m };
    return { estado: 'ilegible', marcador: null, motivo: 'no es un objeto' };
  } catch (e) { return { estado: 'ilegible', marcador: null, motivo: String(e.message).slice(0, 80) }; }
}

// El tope de vueltas de revisores (lib/review-rounds.js): null si la vuelta `iter` puede servirse, o el mensaje llano de
// por qué no. Al tope con algo abierto, un crítico de seguridad o de datos lo decide una persona (una vuelta extra con su
// ok, que se anota en gates.log, o eximirlo); lo demás queda como deuda visible y el recorrido sigue sin otra vuelta.
function topeDeVueltas({ args, iter, rr, marcador, runDir, repoAbs, storyId }) {
  const tope = rr.tope({ repo: repoAbs });
  const stateDir = stateDirOf(os.homedir());
  const anotar = (g) => { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), story: storyId, iter, ...g })}\n`); };
  if (iter <= tope.value) {
    // la variable de la máquina puede subir el tope por encima del de la organización y el repo: pasa, pero queda anotado
    if (tope.source === 'maquina') {
      const sinMaquina = rr.tope({ repo: repoAbs, sinMaquina: true });
      if (iter > sinMaquina.value) {
        anotar({ name: 'review-cap-machine', status: 'ok', value: tope.value, sin_la_maquina: sinMaquina.value });
        process.stderr.write(`⚠️  La vuelta ${iter} pasa el tope de ${sinMaquina.value} porque el ajuste de esta máquina (review-max-rounds.json) lo sube a ${tope.value}: queda anotado.\n`);
      }
    }
    return null;
  }
  if (rr.extras({ stateDir, story: storyId }).some((e) => e.iter === iter)) return null;
  const h = rr.hallazgosDe(runDir);
  const pre = rr.prefijos();
  const ab = rr.abiertos(h.lista, { prefijos: pre });
  const bloquean = ab.filter((a) => a.bloquea);
  const deuda = ab.filter((a) => !a.bloquea);
  const de = { maquina: 'de esta máquina', repo: 'del repo', organizacion: 'de la organización', fabrica: 'de fábrica' }[tope.source] || '';
  // «no pude mirar» no es «no quedó nada abierto»
  const noMirado = h.error || (!runDir ? 'no encontré la carpeta de la corrida' : null);
  const avisos = [...tope.problems, ...pre.problems].map((p) => `   ⚠️  ${p}`);
  if (args.extraRound) {
    // el ok responde al aviso del tope de ESTA vuelta (lo anota el arnés al decirlo) y autoriza otra vuelta, sin negarla
    const cw = require('./lib/critical-waivers.js');
    const aviso = rr.avisoDelTope({ stateDir, story: storyId, iter });
    const r = cw.okDeUnaPersona({ approvedBy: args.approvedBy, quote: args.quote, desde: marcador && marcador.startedAt,
      respuesta: { desde: aviso && aviso.ts, juez: rr.juezDeLaVuelta(), sinAviso: 'todavía no se avisó el tope de esta vuelta: pedí el set sin --extra-round, el arnés dice qué quedó abierto, y recién ahí vale el ok de la persona' } });
    if (!r.ok) return `🛑 No se autorizó la vuelta extra ${iter}: ${r.motivo}. Una vuelta más allá del tope la autoriza una persona, con sus palabras en esta conversación, después del aviso del tope.\n`;
    const e = r.entrada;
    anotar({ name: 'extra-round', status: 'ok', quien: e.quien, cita: e.cita, via: e.via });
    return null;
  }
  const renglones = [`🛑 Llegaste al tope de ${tope.value} vueltas de revisores (${de}): no devuelvo el set de la vuelta ${iter}.`, ...avisos];
  if (noMirado) renglones.push(`   No pude mirar lo abierto (${noMirado}): escribí los hallazgos con pipeline.js write-findings y volvé a pedirlo.`);
  else if (!ab.length) renglones.push('   No quedó nada abierto: seguí con «Probar en vivo» y «Preparar el commit».');
  if (bloquean.length) {
    renglones.push(`   Quedó abierto algo de seguridad o de datos (${bloquean.length}): lo decide una persona. Mostrale esto y preguntale qué hace:`);
    for (const l of rr.resumen(bloquean)) renglones.push(`     · ${l}`);
    renglones.push('   (a) Una vuelta más para arreglarlo: con su ok, el mismo comando con');
    renglones.push(`       --extra-round --approved-by "<la persona>" --quote "<sus palabras, textuales>"`);
    renglones.push('   (b) Eximirlo: marker.js waive-critical --rule <regla> --file <archivo> --reason "<por qué>" (el arnés le muestra el crítico y ella contesta).');
  }
  if (deuda.length) {
    renglones.push(`   ${bloquean.length ? 'El resto' : 'Lo abierto'} queda como deuda visible (${deuda.length}) y el recorrido sigue sin otra vuelta:`);
    for (const l of rr.resumen(deuda)) renglones.push(`     · ${l}`);
    renglones.push('   Anotalo: en findings.json cada uno con "disposition": "deferred" y "deuda": "tope" (pipeline.js write-findings), después');
    renglones.push('   pipeline.js write-followups; el cierre lo dice con pipeline.js review-rounds.');
  }
  // el aviso queda anotado: el ok de una vuelta extra tiene que ser posterior
  anotar({ name: 'review-cap-shown', status: 'blocked', tope: tope.value, abiertos: ab.map((a) => a.regla) });
  return `${renglones.join('\n')}\n`;
}

// El freno de la tercera vuelta de `smart-reloop` y `advisors`: null si puede seguir, o el mensaje llano de por qué no.
// Si sigue, anota la vuelta servida en la carpeta de la corrida (rethink/served.json). La corrida se busca como en el
// resto del pipeline (`resolveRunDir`); sin story o sin carpeta no hay nota posible. Ante la duda, frena.
function rethinkGate(args) {
  const rt = require('./lib/rethink.js');
  // La vuelta que vale es la MAYOR entre la que declara quien llama, la que cuenta el marcador (las fotos de iteración
  // guardadas: la última + 1, o el `iter` que lleve alguna) y la de la propia carpeta de la corrida: si ya se sirvió alguna
  // vuelta, la pedida cuenta como mínimo la siguiente a la última servida (repetir una vuelta servida es una vuelta nueva). Un `--iter` menor, o ninguno, no
  // esquiva la nota, tampoco sin marcador.
  const declarada = args.iter === undefined ? 1 : Number(args.iter);
  const { estado, marcador, motivo } = readSessionMarkerStrict();
  if (estado === 'ilegible') {
    return `🛑 El marcador de la sesión existe y no se puede leer (${motivo}): sin él no sé cuántas vueltas de revisores lleva la corrida, y ante la duda no devuelvo el set. Arreglá o borrá el marcador (marker.js) y volvé a pedirlo.\n`;
  }
  const fotos = Object.entries((marcador && marcador.iterations) || {});
  const delMarcador = fotos.reduce((m, [k, v]) => {
    const n = Number(k);
    const propio = v && Number.isInteger(v.iter) ? v.iter : 0;
    return Math.max(m, Number.isInteger(n) ? n + 1 : 0, propio);
  }, 0);
  // --story relativa se resuelve contra --repo, igual que `marker.js rethink`: los dos tienen que dar la misma carpeta.
  // Sin --story vale la del marcador de la sesión (igual que `marker.js rethink`); sin ninguna de las dos no se sabe de qué
  // corrida es la vuelta, y ante la duda el freno frena.
  const repoAbs = path.resolve(args.repo || (marcador && marcador.repoPath) || '.');
  const storyArg = args.story || (marcador && typeof marcador.storyPath === 'string' && marcador.storyPath) || null;
  const storyAbs = storyArg ? (path.isAbsolute(storyArg) ? storyArg : path.join(repoAbs, storyArg)) : null;
  const storyId = storyAbs ? deriveStoryId(storyAbs) : null;
  const propia = storyId ? resolveRunDir(repoAbs, storyId, false, storyAbs) : null;
  // El freno es de las corridas del pipeline: hay corrida si el marcador trae story, o si --story resuelve una carpeta de
  // corrida. Fuera de una corrida no hay vueltas que contar: --iter ausente, 1 o 2 pasa como siempre; desde la tercera (la que pide nota) frena.
  const marcadorConStory = !!(marcador && typeof marcador.storyPath === 'string' && marcador.storyPath);
  if (!marcadorConStory && !propia) {
    // el tope vale también fuera de una corrida (con tope 1, la vuelta 2 no pasa)
    const iterSin = Math.max(Number.isInteger(declarada) ? declarada : 0, delMarcador);
    if (iterSin < rt.FIRST_ITER) {
      const bloqueo = topeDeVueltas({ args, iter: iterSin, rr: require('./lib/review-rounds.js'), marcador, runDir: null, repoAbs, storyId });
      if (bloqueo) return bloqueo;
    }
    if (Math.max(Number.isInteger(declarada) ? declarada : 0, delMarcador) >= rt.FIRST_ITER) {
      return `🛑 Pediste la vuelta ${Math.max(declarada, delMarcador)} de revisores pero no hay corrida del pipeline que la respalde: ni el marcador de la sesión trae la story ni --story da una carpeta de corrida${storyId ? ` («${storyId}»)` : ''}. Sin carpeta de corrida no se pueden contar las vueltas, y ante la duda no devuelvo el set. Pasá --story <spec.md> (y --repo <repo>) de una corrida abierta, o corré pipeline.js run-dir --story <spec> --repo <repo> --create.\n`;
    }
    return null;
  }
  let runDir = propia;
  let ajena = null;
  if (args.runDir) {
    // --run-dir tiene que ser EXACTAMENTE la carpeta que `resolveRunDir` da para esta story y este repo (mismo realpath):
    // otra corrida de la misma story, aunque lleve el mismo número, no vale.
    const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
    const rd = path.resolve(args.runDir);
    if (propia && real(rd) === real(propia)) runDir = propia; else { ajena = rd; runDir = null; }
  }
  const servidas = rt.readServed(runDir);
  if (!servidas.ok) {
    return `🛑 El registro de vueltas servidas de la corrida (${rt.servedPath(runDir)}) existe y no se puede leer: ${servidas.reason}. Sin él no sé cuántas vueltas de revisores lleva, y ante la duda no devuelvo el set. Corregilo o borralo.\n`;
  }
  const pedida = Math.max(Number.isInteger(declarada) ? declarada : 0, delMarcador);
  // Una vuelta es un número de iteración que llegó a lanzar revisores (la foto que el arnés toma al lanzar el último).
  // Pedir de nuevo el set de la última vuelta servida, sin que se haya lanzado, es la MISMA vuelta; con sus revisores
  // lanzados, pedirla otra vez es una vuelta nueva: max(declarada, marcador, última servida + 1). Sin marcador con la story
  // no hay fotos que mirar: ahí cada pedido es una vuelta nueva, para que repetir no esquive la nota.
  const rr = require('./lib/review-rounds.js');
  const ultimaLanzada = servidas.last > 0 && (!marcadorConStory || rr.lanzada(marcador, servidas.last));
  const iter = servidas.last > 0 ? Math.max(pedida, ultimaLanzada ? servidas.last + 1 : servidas.last) : pedida;
  // El tope de vueltas: más allá, sólo una vuelta extra que autorizó una persona.
  const bloqueoDelTope = topeDeVueltas({ args, iter, rr, marcador, runDir, repoAbs, storyId });
  if (bloqueoDelTope) return bloqueoDelTope;
  if (iter >= rt.FIRST_ITER) {
    const dice = [];
    if (iter !== declarada) {
      dice.push(`Pediste la vuelta ${args.iter === undefined ? '(sin --iter)' : declarada}, pero ${iter === pedida
        ? `el marcador de la sesión lleva ${iter - 1} vuelta(s) cerrada(s)`
        : `ya se sirvió la vuelta ${servidas.last} en esta corrida`}: vale la mayor, la ${iter}.`);
    }
    const diceAmbas = dice.length ? `\n${dice.join(' ')}` : '';
    const leida = rt.readNote(runDir, iter);
    if (!leida.ok) {
      if (ajena) {
        return `🛑 --run-dir ${ajena} no es la carpeta de corrida de esta story${storyId ? ` (${storyId})` : ''}: no vale para decidir si la nota existe. Quitá --run-dir o pasá la carpeta de .advisors/pipeline-runs/ de esta story.${diceAmbas}\n`;
      }
      const why = leida.reason === 'no existe' || leida.reason === 'no hay carpeta de corrida' ? null : leida.reason;
      return rt.blockMessage({ iter, runDir, repeated: rt.repeatedFindings(runDir), why }) + (diceAmbas ? diceAmbas.slice(1) + '\n' : '');
    }
  } else if (ajena) {
    return `🛑 --run-dir ${ajena} no es la carpeta de corrida de esta story${storyId ? ` (${storyId})` : ''}: quitá --run-dir o pasá la carpeta de .advisors/pipeline-runs/ de esta story.\n`;
  }
  // Pasó: se anota la vuelta servida en la carpeta de la corrida (la crea si todavía no existe).
  const donde = runDir || (storyId && !ajena ? resolveRunDir(repoAbs, storyId, true, storyAbs) : null);
  if (donde) {
    const anotada = rt.recordServed(donde, iter);
    if (!anotada.ok) return `🛑 No pude anotar la vuelta ${iter} en la carpeta de la corrida (${rt.servedPath(donde)}): ${anotada.reason}. Sin ese registro la próxima vuelta no se puede contar, y ante la duda no devuelvo el set.\n`;
  } else {
    // Sin carpeta de corrida no hay dónde contar las vueltas: un `--iter 1` repetido podría ser la tercera. Ante la duda,
    // no se devuelve el set.
    return `🛑 No hay carpeta de corrida donde contar las vueltas (la story no da una clave de corrida${storyId ? `: «${storyId}»` : ''}). Sin ella no se puede saber si ésta es la tercera vuelta, y ante la duda no devuelvo el set. Corré pipeline.js run-dir --story <spec> --repo <repo> --create, o arreglá el número de la story.\n`;
  }
  return null;
}

// ── El firmante de un hallazgo se ELIGE, no se tipea ──────────────────
// El nombre del revisor se escribe en DOS lados con dos criterios: el roster lo proyecta un hook
// desde el ledger de spawns (id pelado, kebab-case) y el `advisor` de acá lo tipea el orquestador
// con la vuelta o el modelo pegados (`tycon-silent-failure-hunter (iter 3)`). Si el cruce comparara
// esos dos textos letra por letra, que coincidan sería suerte, y la suerte se agota.
//
// Se resuelve del lado de QUIEN ESCRIBE, no de quien compara: acá el id se valida contra los
// revisores que ESA corrida tuvo, la anotación se muda a campos propios, y el hallazgo queda con su
// tramo. Perseguir cada adorno nuevo con una regex más en el cruce es el camino opuesto.
// Es la misma familia que `severity` y `disposition` dos funciones más arriba: vocabulario cerrado,
// y cuando no se puede decidir, se DICE.
function resolverFirmante(crudo, roster) {
  const rlib = require('./lib/review-roster.js');
  const partes = rlib.separarAnotacion(crudo);
  // Sin roster legible no se puede validar. No se frena (dejaría al dev sin poder escribir su
  // evidencia por un archivo que todavía no existe) y no se aprueba en silencio: se avisa.
  if (!roster) return { ...partes, tramo: null };
  const tramo = rlib.tramoDeFirmante(roster, partes.advisor);
  return { ...partes, tramo };
}

// El destino de un hallazgo frente a la constancia del verificador. Devuelve la `disposition` final y el resumen de la
// constancia (o null). Un `refuted` sin constancia válida queda `open` con el motivo; con un verificador que
// reprodujo el hallazgo, ni `refuted` ni `waived` se aceptan (se rechaza la escritura entera: `errores`).
// «No existe» y «está rota» no son lo mismo: una constancia que está y no se lee podría decir «reproducido», así que
// `refuted` y `waived` se rechazan igual que con «reproducido». Y lo que no se puede verificar (el registro de spawns, el
// roster) se DICE y deja el `refuted` en `open`: nunca se apaga el chequeo en silencio.
function judgeRefutation({ disposition, ruleId, advisor, file, line, runDir, roster, warnings, errores }) {
  const lib = require('./lib/refutation.js');
  const quien = `${ruleId} (${advisor || '?'}, ${file || '?'})`;
  const hallazgo = lib.identity({ reviewer: advisor, rule: ruleId, file, line });
  const leida = lib.readConstancia(runDir, hallazgo);
  const avisar = (m) => { if (Array.isArray(warnings)) warnings.push(m); };
  const aOpen = (m) => { avisar(`${m}${disposition === 'refuted' ? " → 'refuted' queda 'open'" : ''}.`); return { disposition: disposition === 'refuted' ? 'open' : disposition, refutation: null }; };
  // LA regla (una sola, un solo lugar): un hallazgo con una constancia «reproducido», ilegible o mal escrita —en la línea que
  // sea— no queda `refuted` ni `waived`. Va primero: lo que sigue sólo decide si un «refutado» vale.
  if (disposition === 'refuted' || disposition === 'waived') {
    const b = lib.blocksDismissal(runDir, hallazgo);
    if (b.blocks) {
      if (Array.isArray(errores)) {
        errores.push(`${quien}: ${b.motivos.join('; ')}: no se puede dejar como '${disposition}'. Tiene que quedar 'fixed' (con su prueba) u 'open'. `
          + "Si la constancia está rota, borrala y volvé a correr verify-finding / record-refutation.");
      }
      return { disposition, refutation: null };
    }
  }
  if (leida.estado === 'rota') {
    avisar(`constancia ilegible del verificador de ${quien} (${leida.motivo}): no se usa.`);
    return { disposition, refutation: null };
  }
  const c = leida.constancia;
  // La constancia vale para UN hallazgo (revisor, regla, archivo y línea): la de otro, o la de un hallazgo sin línea, no cuenta.
  if (c && !lib.sameFinding(c.finding, hallazgo)) {
    return aOpen(`la constancia hallada para ${quien} es de otro hallazgo o el hallazgo no trae línea (revisor, regla, archivo y línea tienen que coincidir)`);
  }
  if (!c) {
    if (disposition !== 'refuted') return { disposition, refutation: null };
    avisar(`'refuted' sin constancia del verificador en ${quien} → queda 'open': un "es falso" sólo vale si otro agente corrió el código `
      + `y lo confirmó (pipeline.js verify-finding, y después record-refutation).`);
    return { disposition: 'open', refutation: null };
  }
  const impl = roster && roster.implementer;
  const v = lib.validate(c, { implementer: impl, finding: hallazgo });
  if (!v.ok) {
    const porque = [...v.errores, ...(v.faltan.length ? [`faltan: ${v.faltan.join(', ')}`] : [])].join('; ');
    return aOpen(`la constancia del verificador de ${quien} no vale (${porque})`);
  }
  // El verificador se revalida acá contra el registro de spawns (lo mismo que record-refutation): una constancia escrita a
  // mano con un agente que nunca se lanzó no vale.
  const lanzado = launchInLedger(c.verifier.agent);
  if (lanzado === LANZAMIENTO.ilegible) {
    return aOpen(`no se pudo verificar quién verificó ${quien}: el registro de spawns no se pudo leer`);
  }
  if (lanzado === LANZAMIENTO.no) {
    return aOpen(`el verificador '${c.verifier.agent}' de ${quien} no figura en el registro de spawns: sin un lanzamiento real de otro agente la constancia no vale`);
  }
  if (!impl || typeof impl !== 'object') {
    return aOpen(`no se pudo verificar quién implementó ${quien}: el review-roster.json de la corrida falta, está ilegible o no trae el implementador`);
  }
  return { disposition, refutation: lib.summary(c) };
}

function normalizeFindingRecord(raw, warnings, ctx) {
  let severity = String(raw.severity || 'WARNING').toUpperCase().trim();
  if (!VALID_SEVERITY.has(severity)) severity = 'WARNING';
  let disposition = String(raw.disposition || 'open').toLowerCase().trim();
  // Sinónimos de «refuted»:
  // el orquestador escribe naturalmente «false-positive» cuando un CRITICAL de mech-check lo
  // refuta el advisor especializado (p.ej. ACCOV-C1 sobre una suite bash). Sin el alias, se
  // coaccionaría a 'open' con un aviso que nadie lee y la story quedaría con deuda fantasma.
  if (DISPOSITION_ALIAS[disposition]) disposition = DISPOSITION_ALIAS[disposition];
  if (!VALID_DISPOSITION.has(disposition)) {
    // Aplanar EN SILENCIO ('refuted' → 'open' sin aviso) dejaría al falso
    // positivo contando como deuda no accionada. Se coacciona igual, pero se DICE.
    if (Array.isArray(warnings)) warnings.push(`disposition desconocida '${disposition}' en ${raw.rule_id || raw.ruleId || raw.rule || '?'} → coaccionada a 'open'. Válidas: ${[...VALID_DISPOSITION].join('/')}`);
    disposition = 'open';
  }
  const reasonStr = String(raw.reason || raw.summary || raw.title || '').trim();
  if (disposition === 'refuted' && !reasonStr) {
    if (Array.isArray(warnings)) warnings.push(`'refuted' sin reason en ${raw.rule_id || raw.ruleId || raw.rule || '?'} → degradado a 'open' (la refutación se documenta o no vale)`);
    disposition = 'open';
  }
  const ruleId = String(raw.rule_id || raw.ruleId || raw.rule || '?').trim();
  const crudo = String(raw.advisor || raw.owner || '').trim();
  const firmante = resolverFirmante(crudo, ctx && ctx.roster);
  // Un «falso» sólo vale con la constancia de otro agente que corrió el código (lib/refutation.js). Sin `ctx.runDir`
  // (quien normaliza un hallazgo suelto, fuera de write-findings) no hay dónde buscarla y no se evalúa.
  let refutation = null;
  if (ctx && ctx.runDir) {
    const verdict = judgeRefutation({ disposition, ruleId, advisor: firmante.advisor, file: String(raw.file || '').trim(), line: Number.isInteger(raw.line) ? raw.line : undefined,
      runDir: ctx.runDir, roster: ctx.roster, warnings, errores: ctx.errores });
    disposition = verdict.disposition;
    refutation = verdict.refutation;
  }
  // Con el veredicto «reproducido» el hallazgo es real: `fixed` exige la prueba que lo cubre (`test`: ruta o nombre).
  const prueba = String(raw.test || raw.prueba || '').trim().replace(/\s+/g, ' ');
  if (refutation && refutation.verdict === 'reproducido' && disposition === 'fixed' && !prueba) {
    if (Array.isArray(warnings)) warnings.push(`${ruleId} (${firmante.advisor || '?'}): el verificador reprodujo el hallazgo y 'fixed' exige la prueba que lo cubre `
      + "(`test`: la ruta o el nombre de la prueba) → queda 'open'.");
    disposition = 'open';
  }
  if (!crudo && Array.isArray(warnings)) {
    // Un hallazgo SIN firmante no es un firmante inválido (no hay nada contra qué validar), pero
    // tampoco es un hallazgo completo: no se sabe quién lo vio. Atravesaría la validación sin
    // decir una palabra. Avisa y no frena: hay
    // llamadores legítimos que escriben hallazgos sin `advisor`.
    warnings.push(`${ruleId} no dice quién lo encontró (\`advisor\` vacío): queda sin firmante. `
      + 'El firmante se elige de los revisores que corrieron o de las fuentes propias del pipeline.');
  }
  if (ctx && ctx.roster && !firmante.tramo && crudo) {
    // Firmante que esta corrida no tuvo. Se FRENA y se dice con qué se puede firmar.
    const v = require('./lib/review-roster.js').firmantesValidos(ctx.roster);
    ctx.errores.push(
      `firmante desconocido '${crudo}' en ${ruleId}: esta corrida no lo tuvo. `
      + `Revisores de la ronda: ${v.revision.join(', ') || '(ninguno)'}. `
      + `Agentes de los pasos previos: ${v.previo.join(', ') || '(ninguno)'}. `
      + 'Fuentes propias del pipeline (no son spawns y no están en el roster): '
      + `${v.pipeline.join(' ')}. `
      + 'Si lo firmó el propio pipeline, usá una de las fuentes propias (p. ej. `orquestador`); '
      + 'el firmante se elige de los que corrieron, no se escribe libre.',
    );
  }
  return {
    rule_id: ruleId,
    severity,
    advisor: firmante.advisor,
    file: String(raw.file || '').trim(),
    ...(Number.isInteger(raw.line) && raw.line >= 0 ? { line: raw.line } : {}),
    disposition,
    reason: String(raw.reason || raw.summary || raw.title || '').trim().replace(/\s+/g, ' '),
    // La anotación no se pierde: se muda. Y el tramo dice contra qué lista compararlo.
    // 🔴 sale rojo si se pierde el `iter` que trae el hallazgo: sin él `repeatedFindings` no sabe qué volvió. Gana la
    // anotación del firmante («… (iter 2)»); si no hay, el campo `iter` del propio hallazgo.
    ...(firmante.iter !== undefined ? { iter: firmante.iter } : (Number.isInteger(raw.iter) && raw.iter >= 1 ? { iter: raw.iter } : {})),
    ...(firmante.model ? { model: firmante.model } : {}),
    ...(firmante.nota ? { nota: firmante.nota } : {}),
    ...(firmante.tramo ? { tramo: firmante.tramo } : {}),
    ...(prueba ? { test: prueba } : {}),
    ...(refutation ? { refutation } : {}),
    // lo que quedó abierto al llegar al tope de vueltas: deuda visible (lib/review-rounds.js)
    ...(disposition === 'deferred' && String(raw.deuda || '').trim() === 'tope' ? { deuda: 'tope' } : {}),
  };
}

// write-findings: escribe (validado) el findings.json del Step 6 en el run dir. Input via --findings
// (archivo JSON o '-' = stdin). Tolera el shape {ruleId|rule} y normaliza severity/disposition.
// ── La constancia de los revisores viaja al repo de la STORY ────────────────
// El run dir (`.advisors/pipeline-runs/<story>-<sello>/`) nace en el repo donde CORRE el pipeline
// —el del código—, y es pesado (reportes de cada advisor). Pero el portón de CI exige, para pasar
// una story a `done`, que en el repo de la STORY exista ese run dir con `review-roster.json`
// coherente con `findings.json`. Cuando son dos repos distintos, se proyectan SÓLO esos dos
// archivos al repo de la story, con el mismo nombre de corrida. Mismo repo → no hace nada.
// Nunca rompe a quien lo llama: es evidencia, y una copia que falla se DICE (`warning`).
function projectRunToStoryRepo(runDir, storyPath) {
  if (!runDir || !storyPath) return { projected: false, reason: 'sin run dir o sin story' };
  const ec = require('./lib/evidence-config.js');
  const storyRepo = ec.discoverRepoRoot(storyPath);
  const runRepo = ec.discoverRepoRoot(runDir);
  if (!storyRepo) return { projected: false, reason: 'la story no está en un repo git' };
  const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; } };
  if (runRepo && same(storyRepo, runRepo)) return { projected: false, reason: 'mismo repo' };
  const dest = path.join(storyRepo, '.advisors', 'pipeline-runs', path.basename(runDir));
  const copied = [];
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['review-roster.json', 'findings.json']) {
      const src = path.join(runDir, f);
      if (!fs.existsSync(src)) continue;
      if (f === 'review-roster.json') {
        // 🔴 El roster proyectado dice DE DÓNDE viene: el freno local del repo de la
        // story cruza el roster contra el ledger de spawns filtrando por repo, y los spawns están
        // estampados con el repo del CÓDIGO. Sin esta anotación daría `sin-testigo` con el testigo
        // en la misma máquina, bajo el otro repo.
        const roster = JSON.parse(fs.readFileSync(src, 'utf8'));
        roster.projected_from = { repo: runRepo || path.dirname(path.dirname(path.dirname(runDir))), run_dir: runDir };
        fs.writeFileSync(path.join(dest, f), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
      } else {
        fs.copyFileSync(src, path.join(dest, f));
      }
      copied.push(f);
    }
  } catch (e) {
    return { projected: false, dest, reason: `no se pudo copiar: ${e.message}` };
  }
  return { projected: copied.length > 0, dest, copied };
}

// Lo que la corrida no pudo medir, para que el informe de «Hallazgos» lo diga: el chequeo de dependencias
// que quedó `no-medido` (o con repos sin mirar) y las líneas tocadas sin cobertura. Una constancia ilegible no se lee
// como «medido»: sale como sin medir, con el motivo. Una constancia que no está es un paso que no corrió: no se inventa.
function sinMedirDeLaCorrida(runDir, repo) {
  const out = [];
  const leer = (f) => {
    if (!exists(f)) return { ausente: true };
    try { return { valor: JSON.parse(readText(f)) }; } catch (e) { return { error: `no pude leer ${f} (${String(e.message).slice(0, 120)})` }; }
  };
  const dep = leer(path.join(runDir, 'dep-gate.json'));
  if (dep.error) out.push({ que: 'las dependencias nuevas', motivo: dep.error });
  else if (dep.valor) {
    if (dep.valor.gate === 'no-medido') out.push({ que: 'las dependencias nuevas', motivo: dep.valor.reason || 'el chequeo no pudo mirar el repo' });
    for (const n of dep.valor.repos_no_medidos || []) out.push({ que: `las dependencias nuevas de ${n.repo || 'los repos hermanos'}`, motivo: n.motivo });
  }
  if (repo) {
    const tr = leer(path.join(repo, '.advisors', 'tests-result.json'));
    if (tr.error) out.push({ que: 'la cobertura de las líneas tocadas', motivo: tr.error });
    else if (tr.valor && tr.valor.coverage && tr.valor.coverage.touched_lines_pct === null) {
      out.push({ que: 'la cobertura de las líneas tocadas', motivo: tr.valor.coverage.touched_no_cross_check || 'el reporte de pruebas no trae el porcentaje' });
    }
  }
  return out;
}

function writeFindings(args) {
  const storyId = deriveStoryId(args.story);
  if (!storyId) return { error: `--story inválido o sin frontmatter: ${args.story}` };
  const src = args.findings;
  if (!src) return { error: "Falta --findings <archivo.json | ->  (array de {rule_id,severity,advisor,file,disposition,reason}; '-' = stdin)" };
  let raw;
  try { raw = src === '-' ? fs.readFileSync(0, 'utf8') : readText(src); }
  catch (e) { return { error: `no se pudo leer --findings: ${e.message}` }; }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return { error: `--findings no es JSON válido: ${e.message}` }; }
  if (!Array.isArray(arr)) return { error: '--findings debe ser un array JSON (puede ser [] si 0 findings — un run sin findings igual escribe el artefacto)' };
  const normWarnings = [];
  // 🔴 El run dir y el roster se resuelven ANTES de normalizar: el firmante se valida contra los
  // revisores de ESTA corrida, y un finding con firmante inválido no tiene que llegar a escribirse.
  const runDir = args.runDir || resolveRunDir(args.repo, storyId, true, args.story);
  if (!runDir) return { error: 'no se pudo resolver/crear el run dir bajo .advisors/pipeline-runs/ (si el número de la story se repite en su repo, la carpeta lleva la clave: `pipeline.js evidence-key --story <ruta>` dice por qué no se pudo calcular)' };
  fs.mkdirSync(runDir, { recursive: true });
  const rlib = require('./lib/review-roster.js');
  // Los tres modos de «no puedo validar» (AC 7/8). Ninguno frena —el roster se escribe cuando el
  // hook cierra la ronda de revisores, o sea DESPUÉS de que el dev quiera anotar lo que encontró—
  // pero los tres lo DICEN, y dicen cuál de los tres es. Un control que no puede correr no aprueba.
  let roster = null;
  const rosterPath = path.join(runDir, 'review-roster.json');
  if (!exists(rosterPath)) {
    normWarnings.push('el firmante de cada hallazgo NO se pudo validar: todavía no existe '
      + `${rosterPath} (el roster lo escribe el hook al cerrar la ronda de revisores). Se acepta lo que vino.`);
  } else {
    try {
      const leido = JSON.parse(readText(rosterPath));
      if (!leido || !Array.isArray(leido.reviewers)) {
        normWarnings.push('el firmante de cada hallazgo NO se pudo validar: el review-roster.json no trae '
          + 'lista de revisores (`reviewers`). Se acepta lo que vino.');
      } else { roster = leido; }
    } catch (e) {
      normWarnings.push('el firmante de cada hallazgo NO se pudo validar: el review-roster.json es '
        + `ilegible (${String(e.message).slice(0, 120)}). Se acepta lo que vino.`);
    }
  }
  const errores = [];
  const records = arr.map((r) => normalizeFindingRecord(r, normWarnings, { roster, errores, runDir }));
  if (errores.length) {
    return { error: errores.join('\n'), firmantes_invalidos: errores.length, run_dir: runDir,
      note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
  }
  // Un crítico lo decide una persona: un CRITICAL `waived` necesita la constancia del ok
  // (`marker.js waive-critical`). El agente solo no se exime, se firme como se firme.
  {
    const cw = require('./lib/critical-waivers.js');
    const rev = cw.revisar(records, runDir, { reverificar: true, story: storyId });
    const faltan = rev.faltan;
    if (faltan.length) {
      const rs = cw.sesionQueReenvia();
      const relay = rs.valor;
      const marker = path.join(__dirname, 'marker.js');
      const lineas = [`Un crítico lo decide una persona: ${faltan.length} CRITICAL marcado(s) como waived sin el ok de una persona:`];
      lineas.push(...cw.renglonesDeFaltantes(rev));
      lineas.push('Arreglalo, o pedile el ok al dev y anotalo antes de escribir los hallazgos. Los caminos:');
      for (const f of faltan) lineas.push(...cw.caminos({ marker, ruleId: f.rule_id, file: f.file || '<archivo>', relaySession: relay }));
      if (rs.aviso) lineas.push(`   (sin reenvío: ${rs.aviso})`);
      return { error: lineas.join('\n'), criticos_sin_ok: faltan, run_dir: runDir,
        note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
    }
  }
  const outPath = path.join(runDir, 'findings.json');
  fs.writeFileSync(outPath, JSON.stringify(records, null, 2) + '\n', 'utf8');
  // Story en otro repo → el portón de CI de ESE repo va a pedir esta constancia.
  const proyeccion = projectRunToStoryRepo(runDir, args.story);
  // La tasa de falsas alarmas por revisor (últimas 20 corridas del repo): sólo cuentan los «falsos» que un verificador
  // confirmó. Marcar no apaga a nadie; lo decide una persona.
  const tasas = require('./lib/refutation.js').reviewerRates(path.dirname(runDir));
  if (tasas.valor === null) normWarnings.push(`la tasa de falsas alarmas por revisor NO se midió: ${tasas.motivo}.`);
  else if (tasas.no_leidas) normWarnings.push(`la tasa de falsas alarmas por revisor se midió sin ${tasas.no_leidas} corrida(s) cuyo findings.json no se pudo leer.`);
  const marcados = (tasas.valor || []).filter((t) => t.flagged);
  for (const t of marcados) {
    normWarnings.push(`${t.reviewer}: marcado para revisión — ${t.refuted} de ${t.total} hallazgos en las últimas 20 corridas `
      + `fueron falsos confirmados por un verificador (${Math.round(t.rate * 100)} %, el tope es 30 %).`);
  }
  const counts = {
    critical: records.filter((f) => f.severity === 'CRITICAL').length,
    warning: records.filter((f) => f.severity === 'WARNING').length,
    fixed: records.filter((f) => f.disposition === 'fixed').length,
    waived: records.filter((f) => f.disposition === 'waived').length,
    deferred: records.filter((f) => f.disposition === 'deferred').length,
    open: records.filter((f) => f.disposition === 'open').length,
    refuted: records.filter((f) => f.disposition === 'refuted').length,
  };
  // Las notas de «repensar el enfoque» de la corrida, con la cantidad de vueltas: van al informe de «Hallazgos».
  // Las vueltas salen de lo más alto que se sepa: la vuelta anotada en los hallazgos, las notas y las fotos del marcador.
  const rt = require('./lib/rethink.js');
  const { notes: notas, broken: notasRotas } = rt.readAll(runDir);
  for (const b of notasRotas) normWarnings.push(rt.brokenWarning(b));
  let vueltas = null;
  if (notas.length) {
    const marcador = readSessionMarker();
    const deFotos = Object.keys((marcador && marcador.iterations) || {}).map(Number).filter(Number.isInteger);
    const todas = [...records.map((f) => f.iter), ...notas.map((n) => n.iter), ...deFotos].filter(Number.isInteger);
    vueltas = Math.max(...todas);
  }
  const sinMedir = sinMedirDeLaCorrida(runDir, args.repo);
  for (const x of sinMedir) normWarnings.push(`sin medir: ${x.que} — ${x.motivo}`);
  const rethink = notas.length ? {
    rounds: vueltas,
    notes_count: notas.length,
    notes: notas.map((n0) => { const n = rt.sanearNota(n0); return { iter: n.iter, at: n.at, repeated: n.repeated, ...(n.change ? { change: n.change } : {}), ...(n.keep ? { keep: n.keep } : {}), ...(n.story_change ? { story_change: n.story_change } : {}) }; }),
  } : null;
  return {
    wrote: true, path: outPath, story_id: storyId, total: records.length, counts,
    ...(rethink ? { rethink } : {}),
    ...(sinMedir.length ? { sin_medir: sinMedir } : {}),
    ...(marcados.length ? { reviewers_flagged: marcados.map((t) => t.reviewer) } : {}),
    ...(proyeccion.projected ? { projected_to_story_repo: proyeccion.dest } : {}),
    ...(proyeccion.reason && proyeccion.reason.startsWith('no se pudo') ? { warnings: [...normWarnings, `proyección al repo de la story: ${proyeccion.reason}`] } : (normWarnings.length ? { warnings: normWarnings } : {})),
    note: `findings.json escrito (${records.length} findings: ${counts.critical} CRITICAL / ${counts.warning} WARNING). `
      + (rethink ? `La corrida lleva ${rethink.rounds} vueltas de revisores y ${rethink.notes_count} nota${rethink.notes_count === 1 ? '' : 's'} de repensar el enfoque (vueltas ${rethink.notes.map((n) => n.iter).join(', ')}): van al informe de «Hallazgos». ` : '')
      + `Siguiente: pipeline.js write-followups --story ${args.story} --findings ${outPath} (persiste los no-resueltos EN la story).`,
  };
}

// ── «Falso» lo confirma otro, corriendo el código ────────────────────────────────────────────────
// verify-finding: arma el lanzamiento del verificador de UN hallazgo que el autor propone descartar. El texto sale del
// guion del pase adversarial (modo `single-finding`, mismo criterio reproducir-o-refutar), corrido sólo para armarlo.
// record-refutation: con lo que devolvió el verificador arma la constancia, la valida y la guarda en
// `<corrida>/refutations/<id>.json`, que es lo que `write-findings` exige para dejar un hallazgo como `refuted`.
function readJsonArg(file, nombre) {
  if (!file) return { error: `falta ${nombre} <archivo.json>` };
  try { return { value: JSON.parse(readText(file)) }; } catch (e) { return { error: `${nombre} no se pudo leer como JSON: ${e.message}` }; }
}

function findingFromInput(v) {
  const x = v && typeof v === 'object' ? v : {};
  const id = require('./lib/refutation.js').identity({ reviewer: String(x.reviewer || x.advisor || ''), rule: String(x.rule || x.rule_id || ''), file: String(x.file || '') });
  return { reviewer: id.reviewer, rule: id.rule,
    file: String(x.file || '').trim(), line: x.line, summary: String(x.summary || x.reason || '').trim(),
    author_reason: String(x.author_reason || x.reason || '').trim() };
}

function workflowRequest(finding, model, repo) {
  const source = readText(path.join(__dirname, 'adversarial-verify.workflow.js')).replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const noop = () => { throw new Error('el armado del pedido no lanza agentes'); };
  return fn({ modo: 'single-finding', soloPedido: true, hallazgo: finding, files: [finding.file], model, repo }, () => {}, noop, noop, noop);
}

async function verifyFinding(args) {
  const f = readJsonArg(args.finding, '--finding');
  if (f.error) return { error: f.error };
  const finding = findingFromInput(f.value);
  const faltan = ['reviewer', 'rule', 'file', 'author_reason'].filter((k) => !finding[k]);
  // La misma regla que record-refutation (`validate`): sin línea entera no hay constancia posible, así que no se arma el lanzamiento.
  if (!Number.isInteger(finding.line) || finding.line < 0) faltan.push('line');
  if (faltan.length) return { error: `--finding no trae: ${faltan.join(', ')}` };
  // el modelo por defecto del verificador es el del pase adversarial (lib/models.js, el único lugar de los modelos)
  const model = args.modelo || MODELOS.DEFAULTS.adversarial.model;
  const pedido = await workflowRequest(finding, model, path.resolve(args.repo || process.cwd()));
  const id = require('./lib/refutation.js').idOf(finding);
  return {
    id, subagent_type: 'general-purpose', model: pedido.model, prompt: pedido.prompt,
    note: 'Lanzá UN agente general-purpose con este prompt y modelo (no lo hagas vos: el verificador tiene que ser otro agente que el que implementó). '
      + `Con lo que devuelva: pipeline.js record-refutation --finding ${args.finding} --result <json con refuted, command, output> `
      + '--verifier <agente@ts de su lanzamiento en el registro de spawns> --verifier-model <modelo> --run-dir <corrida>.',
  };
}

// El lanzamiento del verificador en el registro de spawns del hook (`<agente>@<ts>`): sin esa línea no hubo un agente
// distinto, sólo alguien que dice haberlo sido. Tres respuestas: figura, no figura, o el registro no se pudo leer
// («no sé» no es «no figura»).
const LANZAMIENTO = { si: 'si', no: 'no', ilegible: 'ilegible' };
function launchInLedger(id) {
  const m = String(id || '').match(/^(.+)@(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/);
  if (!m) return LANZAMIENTO.no;
  const ledger = require('./lib/advisor-ledger.js');
  let dir; let files;
  try { dir = ledger.runsDirPath(); files = fs.readdirSync(dir); } catch (e) {
    return e && e.code === 'ENOENT' ? LANZAMIENTO.no : LANZAMIENTO.ilegible; // sin carpeta nunca se lanzó nada; otro error, no se sabe
  }
  let ilegible = false;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { ilegible = true; continue; }
    if (ledger.parseJsonl(raw).some((r) => r && r.advisor === m[1] && r.ts === m[2])) return LANZAMIENTO.si;
  }
  return ilegible ? LANZAMIENTO.ilegible : LANZAMIENTO.no;
}

function recordRefutation(args) {
  const f = readJsonArg(args.finding, '--finding');
  if (f.error) return { error: f.error };
  const r = readJsonArg(args.resultado, '--result');
  if (r.error) return { error: r.error };
  const finding = findingFromInput(f.value);
  if (!args.runDir) return { error: 'falta --run-dir <carpeta de la corrida>' };
  if (!args.verificador) return { error: 'falta --verifier <agente@ts del lanzamiento del verificador>' };
  const lib = require('./lib/refutation.js');
  const lanzado = launchInLedger(args.verificador);
  if (lanzado === LANZAMIENTO.ilegible) {
    return { error: 'no se pudo leer el registro de spawns: no se puede verificar quién verificó, así que no hay constancia (reintentá cuando se pueda leer).' };
  }
  if (lanzado === LANZAMIENTO.no) {
    return { error: `el verificador '${args.verificador}' no figura en el registro de spawns: sin un lanzamiento real de otro agente no hay constancia (el id es <agente>@<ts> de la línea que escribió el hook al lanzarlo).` };
  }
  // Sin roster legible la constancia se guarda igual (valen los nombres del orquestador) pero se DICE: write-findings
  // es quien deja el `refuted` en `open` mientras no se pueda verificar quién implementó.
  let implementer = null;
  const avisos = [];
  const rosterPath = path.join(args.runDir, 'review-roster.json');
  if (!exists(rosterPath)) avisos.push('no se pudo verificar quién implementó: todavía no existe el review-roster.json de la corrida; write-findings no aceptará el refuted hasta que exista.');
  else {
    try { implementer = JSON.parse(readText(rosterPath)).implementer || null; } catch (e) { avisos.push(`no se pudo verificar quién implementó: el review-roster.json es ilegible (${String(e.message).slice(0, 80)}).`); }
    if (!implementer && !avisos.length) avisos.push('no se pudo verificar quién implementó: el review-roster.json no trae el implementador.');
  }
  const c = lib.build({ finding, authorReason: finding.author_reason, verifier: { agent: args.verificador, model: args.modeloVerificador || '' },
    verdict: lib.decide(r.value), command: r.value && r.value.command, output: r.value && r.value.output });
  const v = lib.validate(c, { implementer });
  if (!v.ok) return { error: `la constancia no vale: ${[...v.errores, ...(v.faltan.length ? [`faltan: ${v.faltan.join(', ')}`] : [])].join('; ')}` };
  const dest = lib.constanciaPath(args.runDir, finding);
  // Un «reproducido» (o una constancia que no se puede leer, que podría serlo) nunca se pisa: se resuelve con fixed u open.
  if (c.verdict !== 'reproducido') {
    const previa = lib.readConstancia(args.runDir, finding);
    if (previa.estado === 'rota' || (previa.estado === 'ok' && previa.constancia.verdict !== 'refutado')) {
      return { error: `ya hay una constancia ${previa.estado === 'rota' ? `ilegible (${previa.motivo})` : '«reproducido» (o mal escrita)'} de este hallazgo y no se pisa con un «refutado»: el reproducido se resuelve dejando el hallazgo 'fixed' (con su prueba) u 'open'. Si está rota, borrala a mano.` };
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
  return { recorded: true, path: dest, verdict: c.verdict, ...(avisos.length ? { warnings: avisos } : {}),
    note: c.verdict === 'refutado'
      ? "El verificador demostró que no se da: ahora write-findings acepta 'refuted' para este hallazgo."
      : "El verificador reprodujo el hallazgo: queda 'fixed' (con su prueba) u 'open'; 'refuted' y 'waived' se rechazan." };
}

// findings-status: pre-condición mecánica de Step 8. ¿El run tiene findings.json válido?
function computeFindingsStatus(args) {
  const storyId = deriveStoryId(args.story);
  if (!storyId) return { error: `--story inválido o sin frontmatter: ${args.story}` };
  const runDir = args.runDir || resolveRunDir(args.repo, storyId, false, args.story);
  const sinClave = !runDir && !args.runDir ? runDirKey(storyId, args.story).error : null;
  if (sinClave) {
    // «No pude calcular dónde buscar» no es «no hay carpeta»: el motivo se dice.
    return { exists: false, valid: false, story_id: storyId, run_dir: null, key_error: sinClave,
      note: `⚠️ No pude calcular la clave de la carpeta de corrida de ${storyId}: ${sinClave}. No es «falta el findings.json»: es «no sé dónde mirar».` };
  }
  if (!runDir) {
    return { exists: false, valid: false, story_id: storyId, run_dir: null,
      note: `⚠️ No hay run dir bajo .advisors/pipeline-runs/ para ${storyId}. Escribí el findings.json del Step 6: pipeline.js write-findings --story ${args.story} --findings <array.json|->.` };
  }
  const p = path.join(runDir, 'findings.json');
  if (!exists(p)) {
    return { exists: false, valid: false, story_id: storyId, run_dir: runDir, path: p,
      note: `🛑 findings.json FALTA en ${runDir}. Escribilo antes del commit (Step 6): pipeline.js write-findings --story ${args.story} --findings <array.json|->. Es el insumo del retrospective-capturer (advisor_warnings_per_story) — sin él el conteo degrada a reconstrucción manual (BUG-PIPELINE-006).` };
  }
  let arr = null;
  try { arr = JSON.parse(readText(p)); } catch { arr = null; }
  const valid = Array.isArray(arr);
  return {
    exists: true, valid, story_id: storyId, run_dir: runDir, path: p, count: valid ? arr.length : null,
    note: valid ? `✅ findings.json presente (${arr.length} findings).` : '⚠️ findings.json existe pero no es un array JSON válido — reescribir con write-findings.',
  };
}

const LANGUAGE_NAMES = { es: 'castellano', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán' };

/**
 * El pedido para el sub-agente «tester no técnico» del paso «Probar en vivo». `scope` = `guide` (los pasos de la guía
 * de QA) o `ui` (los textos y capturas de la pantalla). La línea del idioma sale de la regla `ui_language` de la
 * organización: con ella, el texto en otro idioma es una marca; sin ella, el idioma no se juzga. Si la configuración
 * no se pudo leer, el pedido lo dice en vez de tomarla como «sin declarar». Devuelve `{ text, problems }`.
 */
function readabilityBrief({ scope = 'guide', opts } = {}) {
  const { rules, problems } = require('./lib/stack-config.js').orgRules(opts);
  const lang = rules.ui_language.value;
  const name = lang ? (LANGUAGE_NAMES[lang.split('-')[0]] || lang) : null;
  const unread = !lang && problems.length > 0;
  const what = scope === 'ui'
    ? 'Leé los textos visibles de cada pantalla y sus capturas. Juzgá si se entienden y si anticipan el resultado; no la estética.'
    : 'Leé cada paso de la guía de QA. Marcá lo que te dejaría preguntándole a un dev: jerga, ambigüedad («buscá una orden» sin decir cómo), conocimiento que el paso da por sabido.';
  const language = name
    ? `El texto tiene que estar en ${name}: marcá todo lo que esté en otro idioma.`
    : unread
      ? 'La regla de idioma de la organización no se pudo leer: no juzgues el idioma del texto, y avisá que la regla falta.'
      : 'La organización no declaró el idioma de la app: no juzgues el idioma del texto.';
  const text = [
    'Sos un tester no técnico: trabajás en QA de laboratorio y no sabés programar.',
    what,
    language,
    'Cada marca, en su línea: «<texto citado>» — qué confunde.',
  ].join('\n');
  return { text, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // El modo autónomo Nivel 1 viene PRENDIDO por
  // default: el freno lo cubre test-stop-dod-gate.sh.
  const a = { repo: process.cwd(), story: null, files: [], filesDeclarado: false, ran: [], iter: 1, forceFullReloop: false, storyPath: null, targetStatus: null, targetPipelineDone: null, costTier: null, trustRan: false, autonomous: true, allowMissingFiles: false, specsDir: null, findings: null, runDir: null, deepReview: false, noDeepReview: false, deepReviewOpus: false, deepReviewFable: false, ultracode: false, changed: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--repo') a.repo = argv[++i];
    else if (t === '--story') a.story = argv[++i];
    else if (t === '--files') { a.filesDeclarado = true; while (argv[i + 1] && !argv[i + 1].startsWith('--')) a.files.push(argv[++i]); }
    else if (t === '--ran') a.ran = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--iter') a.iter = parseInt(argv[++i], 10) || 1;
    else if (t === '--force-full-reloop') a.forceFullReloop = true;
    else if (t === '--story-path') a.storyPath = argv[++i];
    else if (t === '--target-status') a.targetStatus = argv[++i];
    else if (t === '--target-pipeline-done') a.targetPipelineDone = argv[++i];
    else if (t === '--cost-tier') a.costTier = argv[++i];
    else if (t === '--trust-ran') a.trustRan = true;
    else if (t === '--autonomous') a.autonomous = true;
    else if (t === '--no-autonomous') a.autonomous = false;   // opt-out por corrida (default es ON)
    else if (t === '--allow-missing-files') a.allowMissingFiles = true;
    else if (t === '--session') a.session = argv[++i];   // cost-report
    else if (t === '--limit') a.limit = argv[++i];       // cost-report
    else if (t === '--days') a.days = Number.parseInt(argv[++i], 10);  // advisor-runs: ventana
    else if (t === '--json') a.json = true;              // advisor-runs / lint-config: salida cruda
    else if (t === '--strict') a.strict = true;          // lint-config: exit 1 si hay hallazgos
    else if (t === '--specs-dir') a.specsDir = argv[++i];
    else if (t === '--findings') a.findings = argv[++i];
    else if (t === '--finding') a.finding = argv[++i];             // verify-finding / record-refutation: el hallazgo propuesto como falso (JSON)
    else if (t === '--result') a.resultado = argv[++i];            // record-refutation: lo que devolvió el verificador (JSON: refuted, command, output)
    else if (t === '--verifier') a.verificador = argv[++i];        // record-refutation: el id del lanzamiento del verificador (<agente>@<ts> del registro de spawns)
    else if (t === '--verifier-model') a.modeloVerificador = argv[++i];
    else if (t === '--model') a.modelo = argv[++i];                // verify-finding: modelo del verificador (default sonnet)
    else if (t === '--deep-review') a.deepReview = true;           // fuerza ON el step-05b (aun en LOW)
    else if (t === '--no-deep-review') a.noDeepReview = true;      // fuerza OFF el step-05b
    else if (t === '--deep-review-opus') a.deepReviewOpus = true;  // hunters/verifiers en Opus (default sonnet)
    else if (t === '--deep-review-fable') a.deepReviewFable = true; // hunters en Fable — SOLO con autorización explícita del user
    else if (t === '--ultracode') a.ultracode = true;             // el orquestador lo pasa si ultracode está ON
    else if (t === '--brief') a.breve = true;                      // start: salida recortada + ruta del JSON entero
    else if (t === '--session-model') a.sessionModel = argv[++i] ?? '';   // start / model-hint: el modelo de la sesión
    else if (t === '--run-dir') a.runDir = argv[++i];              // write-findings/findings-status: dir de la corrida (default: auto-resolve)
    else if (t === '--extra-round') a.extraRound = true;          // smart-reloop / advisors: la vuelta más allá del tope que autoriza una persona
    else if (t === '--approved-by') a.approvedBy = argv[++i];     // con --extra-round: quién la autorizó
    else if (t === '--quote') a.quote = argv[++i];                // con --extra-round: sus palabras, textuales
    else if (t === '--base') a.base = argv[++i];                  // dod-checker-needed: base explícita del diff
    else if (t === '--scope') a.scope = argv[++i] ?? '';          // qa-readability: `ui` = la revisión de la pantalla; sin valor no es «sin --scope»
    else if (t === '--marks') a.marcas = argv[++i];               // qa-readability: marcas resueltas
    // e2e-config: archivos que la entrega tocó (repo-relativos) para elegir qué apps del
    // monorepo ejerce el gate. Admite `--changed a b c` y `--changed a,b,c`.
    else if (t === '--changed') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        a.changed.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
      }
    }
  }
  // Kill-switch global del deep-review sin editar código (gana sobre cualquier flag).
  if (process.env.TYCON_NO_DEEP_REVIEW === '1') a.noDeepReview = true;
  // Kill-switch global del modo autónomo sin editar código (gana sobre cualquier flag):
  // export TYCON_PIPELINE_NO_AUTONOMOUS=1 → todas las corridas vuelven a HITL puro.
  if (process.env.TYCON_PIPELINE_NO_AUTONOMOUS === '1') a.autonomous = false;
  // El tier puede venir por flag --cost-tier O por env var TYCON_PIPELINE_COST_TIER.
  // Flag gana sobre env. Valores válidos: lean | standard | deep. Cualquier otro → ignorado (null).
  if (!a.costTier && process.env.TYCON_PIPELINE_COST_TIER) {
    const env = String(process.env.TYCON_PIPELINE_COST_TIER).toLowerCase().trim();
    if (['lean', 'standard', 'deep'].includes(env)) a.costTier = env;
  }
  return a;
}

function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  // La línea del cierre: cuántas vueltas de revisores hubo, el tope y qué quedó abierto (lib/review-rounds.js).
  if (cmd === 'review-rounds') {
    const rr = require('./lib/review-rounds.js');
    const { marcador } = readSessionMarkerStrict();
    const repoAbs = path.resolve(args.repo || (marcador && marcador.repoPath) || '.');
    const storyArg = args.story || (marcador && marcador.storyPath) || null;
    const storyAbs = storyArg ? (path.isAbsolute(storyArg) ? storyArg : path.join(repoAbs, storyArg)) : null;
    const storyId = storyAbs ? deriveStoryId(storyAbs) : null;
    const runDir = storyId ? resolveRunDir(repoAbs, storyId, false, storyAbs) : null;
    const tope = rr.tope({ repo: repoAbs });
    const h = rr.hallazgosDe(runDir);
    const pre = rr.prefijos();
    const ab = rr.abiertos(h.lista, { prefijos: pre });
    // «no pude mirar» no es «no quedó nada abierto»
    const noMirado = h.error || (!runDir ? 'no encontré la carpeta de la corrida' : null);
    const out = { vueltas: rr.vueltas(marcador), tope: tope.value, tope_de: tope.source, problemas: [...tope.problems, ...pre.problems, ...(noMirado ? [noMirado] : [])], abiertos: ab };
    out.linea = rr.linea({ n: out.vueltas, max: out.tope, abiertos: ab, noMirado, de: tope.source });
    if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      process.stdout.write(`${out.linea}\n`);
      for (const p of out.problemas) process.stderr.write(`⚠️  ${p}\n`);
    }
    process.exit(0);
  }

  if (cmd === 'advisors') {
    // Files fantasma (shell quoting roto) degradarían el set
    // a onlyDocs y PERSISTIRÍAN un expected[] corrupto. Abort explícito, no fail-open.
    // 🔴 La vuelta 3 en adelante pide su nota también por acá: `advisors --iter N` devuelve el set completo y es el
    // fallback del re-loop; sin este freno la nota se esquivaría pidiendo el set por este camino.
    // El freno corre DESPUÉS de las validaciones propias del comando: sus errores salen como siempre.
    const filesErr = validateFilesExist(args);
    if (filesErr) { process.stderr.write(filesErr); process.exit(2); }
    const rethinkBlock = rethinkGate(args);
    if (rethinkBlock) { process.stderr.write(rethinkBlock); process.exit(3); }
    const set = computeAdvisorSet(args);
    // Descuento automático de advisors cubiertos por mech-check (coherente
    // con el expected[] que se persiste abajo — check-count valida contra el set
    // YA descontado, así el orquestador no spawnea LLMs para checks que corren gratis).
    const disc = computeMechDiscount(set.all, args);
    if (disc && disc.discounted.length) {
      set.all = disc.kept;
      set.required_count = disc.kept.length;
      set.mech_discounted = disc.discounted;
      set.mech_findings = disc.mech_findings;
      set.mech_note = `mech-check descontó ${disc.discounted.length} advisor(s) del set/expected (checks mecánicos, 0 tokens). ` +
        (disc.mech_findings.length ? `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS — van DIRECTO al reporte consolidado del Step 6.` : 'Sin findings mecánicos.');
    } else if (disc && disc.mech_findings.length) {
      set.mech_findings = disc.mech_findings;
      set.mech_note = `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS (mech-check) — van DIRECTO al reporte consolidado.`;
    }
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
    const ctx = buildAdvisorContext({ repo: args.repo, story: args.story, files: args.files, iter: args.iter });
    // El estado de la sección «Reglas para revisores» del repo (el orquestador avisa al
    // dev en una línea si no está `presente`; nunca frena — step-05 §Reglas del repo).
    set.reglas_revisores = resumenReglas(ctx && ctx.reglas ? ctx.reglas : reglasRevisores(args.repo));
    if (ctx) {
      set.context_file = ctx.context_file;
      // Overrides por advisor: si un advisor figura acá, se le pasa ESTE archivo en vez del
      // compartido (sólo `tycon-story-validator` — ver comentario en buildAdvisorContext).
      set.context_file_overrides = ctx.overrides;
    }
    // Regla de batcheo (máquina dev 8c/16GB): ventana deslizante de ≤4 vivos.
    set.batch_rule = 'Ventana deslizante: MÁXIMO 4 subagentes VIVOS a la vez (máquina 8c/16GB). Al llegar la notificación de que uno terminó, lanzar el siguiente del set en ese turno — no esperar a que termine el grupo entero. NUNCA lanzar el set completo en un solo mensaje paralelo si supera 4. ⚠️ Si el pase adversarial 5b fue lanzado en el Step 4 y sigue en vuelo, el cap baja a 2 — este string no conoce ese estado: el step-05 §Cap reducido manda. Avisos al dev agrupados por hito (mitad del set y set completo), no por advisor.';
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
    logStep5Start(set.all, { mode: 'advisors', iter: args.iter }); // expected persistido (post-descuento)
    salidaGrande(JSON.stringify(set, null, 2) + '\n', 0);
    return;
  }

  // Los revisores de validación del paso 1 salen de acá, no de la prosa del step.
  //   node pipeline.js validators --story <spec.md> --repo <dir>
  //     → { validadores: ['tycon-story-validator', ...], lanzamientos: [{agente, paquete, modelo, prompt, nota}], packs }
  // siblings — los hermanos declarados de los paquetes activos en el repo, en su ruta esperada (para el revisor que no
  // recibe {siblings} en su pedido). Un paquete roto sale 2, como en validators.
  if (cmd === 'siblings') {
    let repoEsDir = false;
    try { repoEsDir = fs.statSync(args.repo).isDirectory(); } catch (_e) { repoEsDir = false; }
    if (!repoEsDir) { process.stderr.write(`🛑 siblings: --repo no es una carpeta: ${args.repo}\n`); process.exit(2); }
    const h = hermanosDelRepo(paquetesActivos(args.repo));
    process.stdout.write(JSON.stringify({ repo: args.repo, raiz: h.raiz, ...(h.motivo ? { motivo: h.motivo } : {}), hermanos: h.lista, texto: h.texto }, null, 2) + '\n');
    return;
  }

  if (cmd === 'validators') {
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

  // Smart re-loop de advisors en iter N>1.
  // Usage:
  //   node pipeline.js smart-reloop --iter 2 --repo <r> --story <s> --files a.cs b.tsx
  //     → JSON con { rerun: [...], skipped: [{name, reason}], delta_files }.
  //     Lee marker.iterations[iter-1].filesSnapshot para computar el delta.
  //   Flag --force-full-reloop overridea y devuelve set completo.
  //
  // Workflow esperado:
  //   1. iter 1: pipeline.js advisors → set completo, orquestador corre todos.
  //   2. marker.js snapshot-iter 1 → snapshot filesTouched al cierre de iter 1.
  //   3. ...HITL + fixes...
  //   4. iter 2: pipeline.js smart-reloop --iter 2 → set reducido. Orquestador
  //      corre solo `rerun` + anuncia `skipped` con razones (regla B verbosity).
  //   5. marker.js snapshot-iter 2 (si hay más iters previstas).
  if (cmd === 'smart-reloop') {
    // Desde la tercera vuelta (y en cada una de las siguientes) hace falta la nota de «repensar el enfoque» de ESA vuelta,
    // también con --force-full-reloop. Sin ella no se devuelve ningún set.
    // Misma validación que `advisors` — files fantasma
    // corromperían el recompute de force-full-reloop.
    const filesErr = validateFilesExist(args);
    if (filesErr) { process.stderr.write(filesErr); process.exit(2); }
    const rethinkBlock = rethinkGate(args);
    if (rethinkBlock) { process.stderr.write(rethinkBlock); process.exit(3); }
    const conModelos = conModelosDeLaCorrida(args);
    const result = computeSmartReloop(conModelos);
    const avisosModelos = result._avisos || [];
    // El descuento aplica también al subset rerun del re-loop.
    const disc = computeMechDiscount(result.rerun, args);
    if (disc && disc.discounted.length) {
      if (result.reviewer_models) for (const d of disc.discounted) delete result.reviewer_models[d.name];
      result.rerun = disc.kept;
      result.rerun_count = disc.kept.length;
      result.mech_discounted = disc.discounted;
      result.mech_findings = disc.mech_findings;
      result.mech_note = `mech-check descontó ${disc.discounted.length} advisor(s) del rerun/expected. ` +
        (disc.mech_findings.length ? `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS — al reporte del Step 6.` : 'Sin findings mecánicos.');
    } else if (disc && disc.mech_findings.length) {
      result.mech_findings = disc.mech_findings;
      result.mech_note = `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS (mech-check) — al reporte del Step 6.`;
    }
    const ctx = buildAdvisorContext({ repo: args.repo, story: args.story, files: args.files, iter: args.iter });
    result.reglas_revisores = resumenReglas(ctx && ctx.reglas ? ctx.reglas : reglasRevisores(args.repo));
    if (ctx) {
      result.context_file = ctx.context_file;
      result.context_file_overrides = ctx.overrides;
    }
    result.batch_rule = 'Ventana deslizante: MÁXIMO 4 subagentes VIVOS a la vez (máquina 8c/16GB); reponer el slot al llegar cada notificación de término. ⚠️ Cap 2 si el pase adversarial 5b sigue en vuelo (el step-05 §Cap reducido manda).';
    // expected = el SUBSET legítimo de esta iteración (rerun) — check-count valida
    // contra esto, no contra el set completo.
    // El validador de stories en los re-loops: se decide ANTES de persistir el expected.
    aplicarDecisionValidador(result, 'rerun', args);
    if (result.reviewer_models) {
      // el validador de stories puede entrar o salir en la decisión de arriba: el modelo va para cada uno del rerun
      const faltan = (result.rerun || []).filter((r) => !result.reviewer_models[r]);
      if (faltan.length) {
        const extra = {};
        avisosModelos.push(...aplicarModelosDeRevisores(extra, faltan, conModelos, result.all || result.rerun));
        Object.assign(result.reviewer_models, extra.reviewer_models || {});
      }
      for (const r of Object.keys(result.reviewer_models)) if (!(result.rerun || []).includes(r)) delete result.reviewer_models[r];
    }
    decirModelos(result, conModelos.orgModels, avisosModelos);
    logStep5Start(result.rerun, { mode: result.mode, iter: args.iter });
    salidaGrande(JSON.stringify(result, null, 2) + '\n', 0);
    return;
  }

  // Pre-flight hook validation (anti-retry).
  // Usage:
  //   node pipeline.js preflight-frontmatter --story-path <spec.md> --target-status done
  //   node pipeline.js preflight-frontmatter --story-path <spec.md> --target-pipeline-done A-backend
  //     → JSON con { preconditions: [{ satisfied, how_to_satisfy }], ready_to_edit }
  // Resuelve qué pre-condiciones bloquearían el Edit ANTES de intentarlo. Si
  // ready_to_edit=true, el Edit pasa. Si false, satisfacer las preconditions
  // primero (cada una con how_to_satisfy explícito).
  if (cmd === 'preflight-frontmatter') {
    const result = computePreflightFrontmatter(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ready_to_edit === false ? 1 : 0);
  }

  if (cmd === 'check-count') {
    const state = advisorsRunSinceStart();
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
      const disc = computeMechDiscount(recomputed.all, args);
      expected = (disc && disc.discounted.length) ? disc.kept : recomputed.all;
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
      // Sin marca step5-start: pipeline.js advisors no corrió (o log inaccesible).
      // Único caso donde el --ran del LLM es admisible — con warning fuerte.
      ran = args.ran;
      source = '⚠️ --ran self-reportado por el LLM (sin step5-start en el log — ¿corriste pipeline.js advisors?)';
    } else if (state.ran.length === 0 && expected.length === 0) {
      ran = [];
      source = 'set esperado vacío — nada que correr';
    } else if (state.ran.length === 0) {
      // FAIL-CLOSED: pipeline.js corrió (hay step5-start) pero
      // el hook on-advisor-run.js no registró NINGÚN spawn. El fallback silencioso al
      // --ran dejaría pasar un set sin spawns (ej.: 6 step5-start, 0 spawns, todo
      // "pasó"). Override consciente: --trust-ran (queda en el output, auditable).
      if (args.trustRan && args.ran.length) {
        ran = args.ran;
        source = '⚠️⚠️ --trust-ran EXPLÍCITO: el log no registró spawns pero el caller pidió confiar en --ran (sin verificación real)';
      } else {
        process.stderr.write(
          '🛑 check-count FALLÓ CERRADO — hay step5-start en el log pero CERO spawns registrados.\n' +
          'O los advisors NO se corrieron, o el hook on-advisor-run.js está roto/no instalado.\n' +
          'Verificá:\n' +
          '  1. ¿Invocaste los Agent(...) después de correr pipeline.js advisors?\n' +
          '  2. ¿on-advisor-run.js está en settings.json (PreToolUse Task|Agent)? → install-tycon-hooks.sh --check\n' +
          'Override consciente (queda auditable): re-corré con --trust-ran --ran a,b,c\n',
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
        missing.map((m) => `  - ${m}`).join('\n') + '\n\n' +
        `Fuente del "corridos": ${source}\n` +
        `Esperado [${expectedSource}] (${expected.length}): ${expected.join(', ')}\n` +
        `Corridos (${ran.length}): ${ran.join(', ') || '(ninguno)'}\n` +
        (extra.length ? `Corridos de más (OK pero raro): ${extra.join(', ')}\n` : '') +
        discrepancy +
        `\nNO avanzar a Step 6 hasta correr los faltantes.\n`,
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
  if (cmd === 'lint-config') {
    const cl = require('./lib/config-lint.js');
    const cfgsrc = require('./lib/config-source.js');
    const raiz = (() => {
      try { return require('./lib/evidence-config.js').discoverRepoRoot(args.repo) || args.repo; }
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
  if (cmd === 'advisor-runs') {
    const ledger = require('./lib/advisor-ledger.js');
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

  // ── Máquina de estados incremental + Nivel 2 + instrumentación ─────────────
  if (cmd === 'next') {
    // Si este comando trae el interruptor del temprano explícito, queda para la corrida —en una
    // sesión de agente el entorno no pasa de un comando al siguiente—. Lo anota marker.js; sin corrida, nada.
    if (process.env.TYCON_5B_EARLY === '0' || process.env.TYCON_5B_EARLY === '1') {
      try {
        require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'mark-adversarial-gate',
          JSON.stringify({ early_env: process.env.TYCON_5B_EARLY })], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      } catch (e) {
        // se dice: sin la anotación, el próximo `next` sin la variable vuelve a pedir el temprano que se apagó
        const detalle = String((e && e.stderr) || (e && e.message) || '').trim().split('\n')[0];
        process.stderr.write(`next: no pude anotar TYCON_5B_EARLY=${process.env.TYCON_5B_EARLY} en la corrida (${detalle}) — vale sólo para este comando\n`);
      }
    }
    const result = computeNext();
    // Consultar `next` es el momento en que el orquestador ARRANCA ese paso — se anota la
    // hora. Lo escribe marker.js (un solo escritor del marker); él decide no mover un arranque ya
    // anotado ni arrancar un paso completo. Los sub-pasos (0b/0c/5b/7c) también: su trabajo no puede
    // caer como «tiempo entre pasos». Best-effort: medir nunca puede romper la consulta.
    if (!result.error && /^(\d|0b|0c|5b|7c)$/.test(String(result.next_step || ''))) {
      try {
        require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'start-step', String(result.next_step)],
          { stdio: 'ignore', timeout: 10000 });
      } catch { /* sin arranque: la cuenta lo rotula «estimada», no lo inventa */ }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }
  if (cmd === 'work-signal') {
    const event = process.argv[3];
    if (!['start', 'stop'].includes(event)) {
      process.stderr.write('uso: pipeline.js work-signal <start|stop> [--story <spec> --repo <dir>]   (paso 0b: start · paso 9: stop)\n');
      process.exit(2);
    }
    let r;
    try { r = workSignalForRun(event, args.story ? { storyPath: path.resolve(args.story), repo: args.repo ? path.resolve(args.repo) : null } : {}); } catch (e) { r = { ran: false, warnings: [`aviso de trabajo: falló (${e.code || e.message}); sigo sin registrar`] }; }
    if (r.error) { process.stderr.write(`work-signal: ${r.error}\n`); process.exit(1); }
    for (const w of r.warnings) process.stderr.write(`${w}\n`);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  }
  if (cmd === 'start') {
    const conModelos = conModelosDeLaCorrida(args);
    const result = computeStart(conModelos);
    if (result.model_hint && result.model_hint.session_warning) process.stderr.write(`start: ${result.model_hint.session_warning}\n`);
    decirModelos(result, conModelos.orgModels, (result.model_hint && result.model_hint._avisos) || []);
    const salida = args.breve ? recortarStart(result) : result;
    process.stdout.write(JSON.stringify(salida, null, 2) + '\n');
    // exitCode y no exit(): con la salida en un pipe, exit() corta lo que todavía no se
    // escribió. Con un arnés presente el JSON de `start` pasa los ~8 KB y llegaría truncado (large-output.test.js 5 y 8).
    process.exitCode = result.ready ? 0 : 1;
    return;
  }
  if (cmd === 'risk-class') {
    // Guarda de aridad/existencia: sin esto un --files mal expandido cuenta 1
    // archivo → LOW → `auto_approve_plan: true` (se saltea el checkpoint del plan) Y skip del
    // 5b, los dos en silencio. Sólo si vino --files: sin el flag, risk-class cae legítimamente
    // al frontmatter de la story (files_to_create/files_to_modify) y no hay nada que validar.
    // SÓLO la guarda de aridad, no la validación de existencia completa.
    // Estos dos comandos salen `exit 0` salvo por esta guarda, y un diff que BORRA
    // archivos pasa `--files` con paths que ya no existen — un caso legítimo y frecuente que
    // `advisors` cubre con `--allow-missing-files` pero que acá no tiene forma de declararse.
    // Abortar por eso sería romper corridas válidas; lo que hay que atajar es el word-split, que
    // es el que produce un LOW falso y apaga dos frenos.
    const wsErr = detectarWordSplit(args);
    if (wsErr) { process.stderr.write(wsErr); process.exit(2); }
    // Tampoco un archivo que no está ni en el disco ni en HEAD (la lista con comas). Un borrado pasa.
    const fantasmaErr = archivosFantasma(args);
    if (fantasmaErr) { process.stderr.write(fantasmaErr); process.exit(2); }
    const result = computeRiskClass({ ...args, runSize: runSizeDelMarcador(args.story) });
    // Una story con pantalla pide aprobar la maqueta aunque el plan se apruebe
    // solo. `computeRiskClass` es pura (no sabe la raíz del repo): la maqueta se suma acá, sin tocar el riesgo.
    if (storyNeedsMockup(args.story)) {
      result.mockup_required = true;
      if (result.risk === 'LOW') result.note = `${result.note} Story con pantalla: el plan se aprueba solo; la maqueta no (--mockup-approved, steps/step-03-hitl-plan.md §La maqueta).`;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'tooling-expected') {
    // PIPE-C9: qué tooling ESPERA el pipeline en este repo. El orquestador
    // cruza contra su harness real y avisa al user si algo esperado no está disponible.
    const result = computeToolingExpected(args.repo);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'model-hint') {
    // Sugerencia de modelo de SESIÓN por complejidad. Advisory puro:
    // exit 0 siempre; el orquestador compara con su propio modelo y sugiere /model.
    const conModelos = conModelosDeLaCorrida({ ...args, runSize: runSizeDelMarcador(args.story) });
    const result = computeModelHint(conModelos);
    if (result.session_warning) process.stderr.write(`model-hint: ${result.session_warning}\n`);
    decirModelos(result, conModelos.orgModels, result._avisos || []);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'deep-review-gate') {
    // Step 5b: ¿corre el pase adversarial reproduce-or-refute? {run, model, reason}. Gate = risk-class
    // NORMAL + overrides. exit 0 siempre (informativo); el orquestador lee `run`.
    // Misma guarda que risk-class: el default de este gate ES risk-class, así que
    // un --files mal expandido produce un LOW silencioso y sella el 5b como hecho
    // (`deepReviewDone`). Abortar es correcto AUNQUE el comando sea informativo: un veredicto
    // computado sobre entrada rota es peor que no tener veredicto.
    const wsErr = detectarWordSplit(args);   // ídem risk-class: la guarda de aridad…
    if (wsErr) { process.stderr.write(wsErr); process.exit(2); }
    const fantasmaErr = archivosFantasma(args);   // …y la de archivos fantasma
    if (fantasmaErr) { process.stderr.write(fantasmaErr); process.exit(2); }
    // Sólo esta rama lee la máquina —la configuración de la organización y el pedido de la corrida— y se los pasa al
    // portón; los avisos también salen de acá.
    const conModelos = conModelosDeLaCorrida({ ...args, runSize: runSizeDelMarcador(args.story) });
    const result = computeDeepReviewGate(conModelos);
    if (result) decirModelos(result, conModelos.orgModels, avisosDelPorton);
    if (result && result.run === null) {
      // 🔴 No se pudo medir: se dice y se CORTA. «Correr por las dudas» tampoco es gratis — una
      // corrida del pase adversarial midió 6,5 M de tokens y 30 minutos, así que el lado barato no
      // es revisar de más: es arreglar la llamada, que es donde está el error.
      process.stderr.write(`deep-review-gate: ${result.reason}\n`);
      process.exit(2);
    }
    // Con una corrida activa de ESTA story y el paso 4 cerrado, el veredicto queda anotado
    // (`adversarialGate`) para que `next` pida el lanzamiento sin recalcular el portón. Lo escribe marker.js (un
    // solo escritor del marker); `computeDeepReviewGate` sigue sin tocarlo. Sin corrida no se anota ni se avisa. El
    // temprano que se imprime es el que vale para la corrida: visto apagado una vez, sigue apagado.
    const corrida = readSessionMarker();
    const mismaStory = !args.story || !corrida || !corrida.storyPath || path.resolve(args.story) === path.resolve(corrida.storyPath);
    // Un pase que quedó NO MEDIDO (alguna lente sin su cazador, algún hallazgo sin su verificador) es un
    // pase que falta. El portón dice que corre —así el salteo se niega— salvo el interruptor del dev, que gana siempre.
    if (corrida && mismaStory && !args.noDeepReview && result && typeof result.run === 'boolean') {
      const { veredictoPaseAdversarial, SALIDA_APROBADA } = require('./lib/adversarial-verdict.js');
      const v = veredictoPaseAdversarial(corrida);
      if (v.motivo === 'pase-no-medido') {
        const p = v.pase || {};
        const porque = `el pase anterior quedó NO MEDIDO (${p.motivo_no_medido || 'no revisó todo'}): un pase que no revisó todo es un pase que falta — relanzalo (--relaunch), o ${SALIDA_APROBADA}`;
        result.reason = result.run ? `${porque} · ${result.reason}` : `${porque} · el portón por sí solo decía: ${result.reason}`;
        if (!result.run) { result.run = true; result.model = result.model || p.modelo || MODELOS.DEFAULTS.adversarial.model; }
        result.previous_pass = 'no-medido';
      }
    }
    if (corrida && corrida.storyId && mismaStory && (corrida.stepsCompleted || []).map(String).includes('4')
        && Array.isArray(args.files) && args.files.length && typeof result.run === 'boolean') {
      try {
        const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'mark-adversarial-gate',
          JSON.stringify({ run: result.run, files: args.files, early_env: process.env.TYCON_5B_EARLY ?? null })],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
        const anotado = JSON.parse(out || '{}');
        if ('early_launch' in result && typeof anotado.early_launch === 'boolean' && anotado.early_launch !== result.early_launch) {
          result.early_launch = anotado.early_launch;
          result.early_launch_origin = anotado.early_origin || 'la corrida';
        }
      } catch (e) {
        process.stderr.write(`deep-review-gate: no pude anotar el veredicto en la corrida (${e.message.split('\n')[0]}) — \`next\` va a pedir consultar el portón otra vez\n`);
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'timing-report') {
    const result = computeTimingReport();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }
  if (cmd === 'cost-report') {
    // Termómetro de costo del pipeline. Lee los logs de spawns reales que
    // escribe `on-advisor-run.js` y reporta
    // la palanca real: CUÁNTOS agentes se abren, cuántos son de exploración libre, y en qué
    // fase. NO estima tokens — el dato de tokens por spawn no está en el log; la referencia
    // medida es ~60-100K por spawn, así que el conteo YA es el proxy de costo.
    // Uso: pipeline.js cost-report [--session <sid>] [--limit N]
    const ADHOC_SET = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
    const runsDir = path.join(stateDirOf(os.homedir()), 'advisor-runs');
    const out = { sessions: [], totals: { runs: 0, spawns: 0, adhoc: 0, adhoc_pre_step5: 0, sin_model: 0 } };
    let archivos = [];
    try { archivos = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')); } catch { archivos = []; }
    if (args.session) archivos = archivos.filter((f) => f.startsWith(args.session));
    for (const fn of archivos) {
      let lineas = [];
      try { lineas = fs.readFileSync(path.join(runsDir, fn), 'utf8').split('\n'); } catch { continue; }
      const s = { session: fn.replace(/\.jsonl$/, ''), spawns: 0, adhoc: 0, adhoc_pre_step5: 0, sin_model: 0, iteraciones: 0, por_tipo: {} };
      let vistoStep5 = false;
      for (const l of lineas) {
        if (!l.trim()) continue;
        let d; try { d = JSON.parse(l); } catch { continue; }
        if (d.event === 'step5-start') { vistoStep5 = true; s.iteraciones++; continue; }
        if (!d.advisor) continue;
        s.spawns++;
        s.por_tipo[d.advisor] = (s.por_tipo[d.advisor] || 0) + 1;
        if (ADHOC_SET.has(d.advisor)) {
          s.adhoc++;
          if (!vistoStep5) s.adhoc_pre_step5++;
          // `model` no existe en las líneas viejas del log: es undefined y NO
          // se cuenta como "sin model" (sería ruido histórico, no una omisión real).
          if ('model' in d && !d.model) s.sin_model++;
        }
      }
      if (!s.spawns) continue;
      out.sessions.push(s);
      out.totals.runs++;
      out.totals.spawns += s.spawns;
      out.totals.adhoc += s.adhoc;
      out.totals.adhoc_pre_step5 += s.adhoc_pre_step5;
      out.totals.sin_model += s.sin_model;
    }
    out.sessions.sort((a, b) => b.spawns - a.spawns);
    const limite = Number.parseInt(args.limit || '10', 10);
    out.sessions = out.sessions.slice(0, limite);
    const t = out.totals;
    out.resumen = t.spawns
      ? `${t.spawns} spawns en ${t.runs} runs · ${t.adhoc} de exploración libre (${Math.round((t.adhoc / t.spawns) * 100)}%) · ` +
        `${t.adhoc_pre_step5} de ésos ANTES de los advisors · referencia: ~60-100K tokens por spawn`
      : 'sin spawns registrados';
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'org-rules') {
    // Las reglas de la organización (stack.rules): cada una con su valor y de dónde salió, y los problemas. Nunca tira:
    // sin configuración salen las de fábrica.
    const r = require('./lib/stack-config.js').orgRules();
    // La guía de historias, con su ruta absoluta: el validador no corre comandos y con «~» adivinaba la carpeta personal.
    let tree = null;
    try {
      const h = require('./lib/harness-path.js').rutaArnesHook({ env: process.env, home: os.homedir() });
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
        const ui = require('./lib/ui-signal.js');
        const repoRoot = require('./lib/evidence-config.js').discoverRepoRoot(sp);
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
  if (cmd === 'readability-brief') {
    // El pedido para el lector de legibilidad del paso «Probar en vivo»: la guía del tester (por defecto) o los textos
    // de la pantalla (`--scope ui`). El idioma sale de la regla ui_language de la organización; sin ella, no se juzga.
    if (args.scope !== undefined && args.scope !== 'ui') { process.stderr.write(`--scope sólo acepta «ui» (vino «${args.scope}»)\n`); process.exit(2); }
    const brief = readabilityBrief({ scope: args.scope === 'ui' ? 'ui' : 'guide' });
    for (const p of brief.problems) process.stderr.write(`⚠️  ${p}\n`);
    process.stdout.write(brief.text + '\n');
    process.exit(0);
  }
  if (cmd === 'evidence-key') {
    // Con qué CLAVE se nombra la evidencia de esta story: el número solo si es único en su
    // repo, `<tema>__<número>` si se repite. `--json` da además el tema y las stories que comparten número.
    if (!args.story) { process.stderr.write('uso: pipeline.js evidence-key --story <spec.md> [--json]\n'); process.exit(2); }
    try {
      const k = evidenceKey(path.resolve(args.story));
      if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(k, null, 2) + '\n');
      else process.stdout.write(k.key + '\n');
      process.exit(0);
    } catch (e) {
      process.stderr.write(`evidence-key: ${e.message}\n`);
      process.exit(2);
    }
  }
  if (cmd === 'run-dir') {
    // La carpeta de la corrida de ESTA story: `.advisors/pipeline-runs/<clave>-<sello>/`, la misma que
    // usan el registro de revisores, el findings.json y los frenos. Los pasos del pipeline la piden acá en vez de armar
    // `<número>-<sello>` a mano: con un número repetido, una corrida quedaría partida en dos carpetas.
    // Imprime la ruta (exit 0) · sin carpeta y sin --create: exit 3, nada en stdout · sin clave calculable: exit 2 + motivo.
    if (!args.story) { process.stderr.write('uso: pipeline.js run-dir --story <spec.md> [--repo <repo>] [--create]\n'); process.exit(2); }
    const storyId = deriveStoryId(path.resolve(args.story));
    if (!storyId) { process.stderr.write(`run-dir: no pude leer la story ${args.story}\n`); process.exit(2); }
    const k = runDirKey(storyId, path.resolve(args.story));
    if (!k.key) { process.stderr.write(`run-dir: no pude calcular la clave de la carpeta: ${k.error}\n`); process.exit(2); }
    const dir = resolveRunDir(path.resolve(args.repo || process.cwd()), storyId, process.argv.includes('--create'), path.resolve(args.story));
    if (!dir) { process.stderr.write(`run-dir: todavía no hay carpeta de corrida para ${k.key} (pasá --create para crearla)\n`); process.exit(3); }
    process.stdout.write(dir + '\n');
    process.exit(0);
  }
  if (cmd === 'evidence-dir') {
    // Dónde va la evidencia de cierre de ESTA story: el repo git que la contiene,
    // aunque el código (y el cwd del pipeline) esté en otro. Es lo que el portón de CI del repo
    // de la story va a buscar. `--plain` imprime sólo la ruta, para meterla en un script.
    if (!args.story) { process.stderr.write('uso: pipeline.js evidence-dir --story <spec.md> [--repo <dir>] [--plain]\n'); process.exit(2); }
    const r = evidenceDirForStory(path.resolve(args.story), args.repo);
    if (!r.dir) { process.stderr.write(`evidence-dir: ${r.warning}\n`); process.exit(1); }
    if (process.argv.includes('--plain')) { process.stdout.write(r.dir + '\n'); process.exit(0); }
    const out = {
      evidence_dir: r.dir, story_repo: r.storyRepo, repo: r.repo, cross_repo: r.crossRepo, source: r.source,
      ...(r.warning ? { warning: r.warning } : {}),
    };
    // ¿Ese repo deja viajar la evidencia? Si su .gitignore la traga, el portón va a dar rojo igual.
    try {
      const { notices } = computeGitignoreNeeds(gitIgnoraProbe(r.storyRepo || r.repo));
      if (notices.length) out.gitignore_notices = notices;
    } catch { /* sin git no hay aviso */ }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  }

  if (cmd === 'e2e-config') {
    // Resuelve el gate E2E del proyecto (.tycon/advisors.yaml → e2e.*). Salida JSON
    // {gate, frontend_dir, frontend_dirs, critical_manifest} con paths absolutos, o {} si el
    // repo no declara gate. Lo consumen step-07c (scoped) y tycon-merge-to-main (critical+full).
    //
    // Con `--changed <archivos...>` agrega `frontend_dirs_selected`: las apps del
    // monorepo que ESA entrega tocó. Sin el flag, `selected` == todas (fail-safe: correr de más
    // cuesta minutos, correr de menos deja pasar la regresión).
    const cfg = e2eConfig(args.repo);
    if (cfg && cfg.gate) {
      cfg.frontend_dirs_selected = selectE2eApps(cfg, args.changed);
      // El consumidor hace `(selected || [frontend_dir])` y en JS `[] || x` devuelve `[]` (un
      // array vacío es truthy), así que un `selected` vacío NO cae al fallback: el loop del gate
      // itera cero veces y sale 0. Cuando eso pasa es porque la entrega de verdad no tocó
      // ninguna app — legítimo, pero tiene que ser RUIDOSO, no un verde mudo.
      if (!cfg.frontend_dirs_selected.length) {
        cfg.warning = 'Ninguna de las apps declaradas fue tocada por los archivos de --changed → ' +
          'el gate E2E no va a correr NADA. Si eso te sorprende, revisá que los paths de --changed ' +
          'sean del repo (absolutos o repo-relativos, ambos valen) antes de dar el gate por verde.';
      }
    }
    process.stdout.write(JSON.stringify(cfg) + '\n');
    process.exit(0);
  }

  // ── dep-gate — gate mecánico de dependencias nuevas ─
  // Corre en Step 4 (post-build). exit 2 si hay dependencias no declaradas en la story
  // (PAUSA HITL), exit 0 si pass/skip. Ver computeDepGate.
  if (cmd === 'dep-gate') {
    const result = computeDepGate({ repo: args.repo, story: args.story });
    // La constancia queda en la carpeta de la corrida: `write-findings` la lee para decir lo que no se midió.
    // Sin la constancia, `write-findings` no sabría que algo quedó sin medir: si no se puede guardar, sale 1 y lo dice.
    if (args.story) {
      let motivo = null;
      try {
        const rd = resolveRunDir(args.repo, deriveStoryId(args.story), true, args.story);
        if (rd) { fs.mkdirSync(rd, { recursive: true }); fs.writeFileSync(path.join(rd, 'dep-gate.json'), JSON.stringify(result, null, 2) + '\n'); }
        else motivo = 'no encontré ni pude crear la carpeta de la corrida';
      } catch (e) { motivo = e.message; }
      if (motivo) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.stderr.write(`🔴 dep-gate: no pude dejar la constancia en la carpeta de la corrida (${motivo}): el informe de hallazgos no sabría qué quedó sin medir.\n`);
        process.exit(1);
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.gate === 'pause' ? 2 : 0);
  }

  // ── next-story — auto-discovery de la próxima story ready-for-dev ─
  if (cmd === 'next-story') {
    const result = computeNextStory(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }

  // ── Review Follow-ups persistidos en la story ────────
  // write-followups: Step 6/7 escribe los findings no resueltos como sección checkbox.
  // followups-status: Step 0/1 detecta los abiertos al retomar.
  if (cmd === 'write-followups') {
    const result = writeFollowups(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }
  // ── findings.json del Step 6 ─────────────────────────────────
  // write-findings: escribe el artefacto machine-parseable (Step 6). findings-status:
  // pre-condición de Step 8 — exit 3 si falta (para que el orquestador lo escriba).
  if (cmd === 'write-findings') {
    const result = writeFindings(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }
  if (cmd === 'verify-finding') {
    verifyFinding(args).then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.error ? 1 : 0);
    }, (e) => { process.stderr.write(`verify-finding: ${e.message}\n`); process.exit(1); });
    return;
  }
  if (cmd === 'record-refutation') {
    const result = recordRefutation(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }
  if (cmd === 'findings-status') {
    const result = computeFindingsStatus(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : (result.exists && result.valid ? 0 : 3));
  }
  // ── Los helpers mecánicos del cierre recortado ──────────────────────────────
  // Uso: pipeline.js dod-checker-needed --story <spec> --repo <repo> [--base <ref>]   exit 0 = invocar · 3 = no
  if (cmd === 'dod-checker-needed') {
    let r;
    try { r = computeDodCheckerNeeded(args); } catch (e) { r = { invoca: true, motivos: [`el helper falló (${e.message}): se invoca`], preguntas: {} }; }
    logGate({ name: 'dod-checker-decision', repoPath: args.repo ? path.resolve(args.repo) : null, storyId: r.story_id || null, invoca: r.invoca, motivos: r.motivos });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.invoca ? 0 : 3);
  }
  // Uso: pipeline.js deferrals-open --story <spec> --repo <repo>   exit 0 = sin deuda · 3 = con deuda (lista) · 1 = no pude mirar
  if (cmd === 'deferrals-open') {
    let r;
    try { r = computeDeferralsOpen(args); } catch (e) { r = { error: `el helper falló (${e.message}): no se puede afirmar que no haya deuda` }; }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.error ? 1 : (r.open ? 3 : 0));
  }
  // Uso: pipeline.js qa-readability --story <spec> --repo <repo> --marks <n> [--scope ui]   deja la marca de la capa 4
  // de la guía de QA (la marca se graba como `qa-legibilidad` en gates.log: la lee qa-guide.js --check).
  // Con `--scope ui`, la de la revisión de la PANTALLA (`qa-legibilidad-ui`).
  if (cmd === 'qa-readability') {
    const n = /^\d+$/.test(String(args.marcas || '')) ? Number(args.marcas) : NaN;
    if (!Number.isInteger(n)) { process.stderr.write(`--marks tiene que ser un entero ≥ 0 (vino «${args.marcas}»): no se anota nada\n`); process.exit(2); }
    if (args.scope !== undefined && args.scope !== 'ui') { process.stderr.write(`--scope sólo acepta «ui» (vino «${args.scope}»): no se anota nada\n`); process.exit(2); }
    const leida = leerStoryOError(args.story);
    const storyId = leida.error ? null : deriveStoryId(args.story);
    if (!storyId) { process.stderr.write(`no pude leer la story (${leida.error || args.story}): no se anota nada\n`); process.exit(2); }
    const name = args.scope === 'ui' ? 'qa-legibilidad-ui' : 'qa-legibilidad';
    logGate({ name, repoPath: args.repo ? path.resolve(args.repo) : null, storyId, marcas: n });
    process.stdout.write(JSON.stringify({ anotado: true, storyId, marcas: n, ...(args.scope ? { scope: args.scope } : {}) }) + '\n');
    process.exit(0);
  }
  if (cmd === 'followups-status') {
    const result = computeFollowupsStatus(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : (result.open > 0 ? 3 : 0));
  }

  // ── mech-check — executor determinista de los advisors 'lean' ─
  // Corre INLINE (~ms, 0 tokens) los checks mecánicos que de otro modo cuestan 3 subagentes
  // Sonnet por iteración: ACCOV-C1/C5, DEFTR-C1/C2, WIRING-C1. El orquestador invoca
  // el advisor LLM correspondiente SOLO si `ambiguous` no está vacío (escalation),
  // y los `findings` confirmados son infakeables (script, no self-report).
  if (cmd === 'mech-check') {
    const { runStoryChecks } = require('./lib/story-checks.js');
    const result = runStoryChecks({ repo: args.repo, storyPath: args.story, files: args.files });
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
      : ' Sin ambiguos → en re-loops (iter≥2) ac-coverage y deferral-tracker quedan descontados del set (MECH-2); en iter 1 SÍ corren (juicio LLM completo). El revisor de cableado, si su paquete está activo, se invoca siempre (mech solo cubre WIRING-C1).';
    if (sinEscalar.length) result.note += ` Sin escalar: ${sinEscalar.join('; ')} — el hallazgo queda en el reporte tal cual.`;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.findings.some((f) => f.severity === 'CRITICAL') ? 2 : 0);
  }

  process.stderr.write(
    'pipeline.js (H17 §4 + §5 incremental) — uso:\n' +
    '  node pipeline.js start          --story <spec.md> --repo <dir> [--autonomous] [--brief]\n' +
    '       (preflight mecánico en 1 comando: cross-session + branch guard + gitignore +\n' +
    '       marker + status in-progress. Pausa sin mutar ante conflicto/rama protegida.\n' +
    '       --brief: devuelve sólo lo que el orquestador consume y la RUTA del JSON entero\n' +
    '       (~4 KB → ~600 B; el detalle queda en ~/.claude/.tycon-pipeline/salidas/). Sin el\n' +
    '       flag, salida idéntica a siempre. Story 7.10.)\n' +
    '  node pipeline.js next\n' +
    '       (próximo step + step_file + skips MECÁNICOS evaluados + checks del marker.\n' +
    '       El LLM sigue siendo el loop (H17): lee SOLO el step file que esto indica.)\n' +
    '  node pipeline.js risk-class     --story <spec.md> [--files ...]\n' +
    '       (Nivel 2 autonomía: LOW → step-03 plan auto-aprobado con anuncio; cualquier\n' +
    '       criterio fallido → NORMAL → HITL. Push/scope firmado SIEMPRE human-gate.)\n' +
    '  node pipeline.js tooling-expected --repo <dir>\n' +
    '       (PIPE-C9: qué tooling ESPERA el pipeline acá — codegraph si hay .codegraph/, engram,\n' +
    '       tool Workflow p/ 5b. El orquestador cruza contra su harness y AVISA al user si algo\n' +
    '       esperado no está disponible ANTES de degradar al fallback. `start` ya lo incluye.)\n' +
    '  node pipeline.js model-hint     --story <spec.md> [--files ...]\n' +
    '       (sugerencia de modelo de SESIÓN por complejidad: LOW→sonnet · NORMAL→opus ·\n' +
    '       NORMAL+≥2 señales pesadas→opus. Advisory: el orquestador compara con su modelo\n' +
    '       real y sugiere /model al user en Step 0. NUNCA bloquea. `start` ya lo incluye.)\n' +
    '  node pipeline.js deep-review-gate --repo <dir> --story <spec.md> [--files ...]\n' +
    '                                  [--deep-review|--no-deep-review|--ultracode|--deep-review-opus|--deep-review-fable]\n' +
    '       (Step 5b: ¿corre el pase adversarial reproduce-or-refute? Gate = risk-class NORMAL.\n' +
    '       {run, model, model_reason, reason}. Modelo: sonnet default; story pesada → opus\n' +
    '       automático. Fable no se ofrece nunca: sólo corre con --deep-review-fable.\n' +
    '       Kill-switch: TYCON_NO_DEEP_REVIEW=1. Repo: .tycon/advisors.yaml deep_review:)\n' +
    '  node pipeline.js advisors       --repo <dir> --story <spec.md> --files a.cs b.tsx ...\n' +
    '                                  [--iter N] [--cost-tier lean|standard|deep] [--allow-missing-files]\n' +
    '       (valida que los --files existan — abort exit 2 ante paths fantasma/vacíos; corre\n' +
    '       mech-check inline y DESCUENTA advisors cubiertos (MECH-2) del set/expected;\n' +
    '       --iter N>1 emite reloop_model_hints (deep→sonnet). Genera context_file compartido\n' +
    '       + persiste expected[] en el log para check-count. Triggers sobre líneas AGREGADAS.)\n' +
    '  node pipeline.js check-count    [--trust-ran --ran a,b,c]\n' +
    '       (valida contra el expected persistido del último step5-start; FALLA CERRADO\n' +
    '       si hay step5-start sin spawns registrados — override consciente: --trust-ran)\n' +
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
    '       (adopción BMAD — Step 4: dependencias NUEVAS (package.json/*.csproj) no declaradas\n' +
    '       en la story → exit 2 PAUSA HITL. Match conservador por nombre en el texto de la story.)\n' +
    '  node pipeline.js next-story     [--specs-dir <dir>] [--repo <dir>]\n' +
    '       (adopción BMAD — próxima story ready-for-dev en specs/stories/ (orden numérico) +\n' +
    '       menú de recuperación si no hay. NO arranca el pipeline: devuelve el path para `start`.)\n' +
    '  node pipeline.js write-findings    --story <spec.md> --repo <dir> --findings <array.json|->\n' +
    '       (Step 6 — escribe el findings.json machine-parseable en el run dir (auto-resuelto):\n' +
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
    '       (pre-condición de Step 8 — exit 3 si falta el findings.json del run. El orquestador lo\n' +
    '       corre antes del commit-prep y, si falta, lo escribe con write-findings.)\n' +
    '  node pipeline.js write-followups   --story <spec.md> --findings <findings.json>\n' +
    '       (adopción BMAD — persiste findings advisor no resueltos como sección checkbox EN la\n' +
    '       story (idempotente por fkey ruleId|file, preserva [x] previos). Solo toca el body.)\n' +
    '  node pipeline.js followups-status  --story <spec.md>\n' +
    '       (adopción BMAD — Step 0/1: cuenta review follow-ups abiertos/resueltos. exit 3 si\n' +
    '       hay abiertos (priorizarlos sobre tasks nuevas), 0 si limpio.)\n' +
    '  node pipeline.js validators        --story <spec.md> --repo <dir>\n' +
    '       (story 8.2 — Step 1: el validador de stories + los revisores del grupo `validacion`\n' +
    '       de los paquetes activos (packs/), con su prompt rendido y su modelo. Un paquete roto\n' +
    '       o uno que el repo nombra y no está instalado → exit 2 con archivo, revisor y motivo.)\n',
  );
  process.exit(cmd ? 1 : 0);
}

// Exports para la suite de tests de la capa determinista (las funciones
// más evadibles/sutiles tienen tests). require() NO ejecuta main().
module.exports = {
  matchGlob,
  // La configuración `models` de la organización (la usa también on-advisor-run.js)
  orgModels,
  aplicarModelosDeRevisores,
  // El cartel de la corrida (mods/harness-mods) copia la lista de pasos; harness-mods.test.js T16 la ata a ésta.
  STEP_SEQUENCE,
  SUBSTEP_FLAG, SUBSTEP_OLD_FLAG, completedWorkHours, harnessTimeTool,
  // tests/unit.test.js «T43 ThirdPartyManifestPath_*».
  thirdPartyManifestPath,
  // El hook on-advisor-run.js escribe el review-roster en el MISMO run dir que usa el pipeline:
  // se exporta la función en vez de duplicar el criterio de scoring, para que las dos capas no
  // puedan elegir carpetas distintas (pieza "revisor ≠ autor").
  resolveRunDir,
  // PIPE-C2 — tests: tests/unit.test.js "PipeC2_*".
  computeGitignoreNeeds,
  gitIgnoraProbe,
  GITIGNORE_ADVISORS,
  projectRunToStoryRepo,
  // Specs que envejecen — test: tests/unit.test.js "SpecStale_*".
  computeSpecStaleness,
  advisorAffectedByDelta,
  advisorsRunSinceStart,
  computeAdvisorSet,
  detectStack,
  // los revisores del núcleo declarados («Cómo trabaja», en el sitio): tests/how-it-works.test.js T4 y T5
  CORE_REVIEWERS,
  coreReviewersDrift,
  coreReviewerNames,
  storyRequiresRuntimeEvidenceCheck,
  parseFrontmatterPipeline,
  revisoresDelNucleo,
  // tests/code-files.test.js — la densidad cuenta todos los archivos fuente
  densidadDelDiff,
  // Paquetes de revisores: tests/packs.test.js y package-equivalence.js.
  BANDERAS_DETECCION,
  computeValidadores,
  paquetesInstalados,
  paquetesActivos,
  superficieDe,
  tierDe,
  buildStoryDigest,
  // tests/reviewer-rules.test.js (T5, T6): el contexto de cada revisor.
  buildAdvisorContext,
  parseFrontmatterList,
  computeRiskClass,
  computeRunSize,
  aplicarTamanoALosRevisores,
  notaDelTamano,
  // Exportadas para unit tests (lógica sutil: fail-open
  // por familia, orden mutación-vs-log, precedencia de tiers).
  validateFilesExist,
  archivosFantasma,
  computeMechDiscount,
  reloopHintsFor,
  computeSmartReloop,
  MECH_DISCOUNTABLE,
  // Adopciones BMAD — exportadas para unit tests.
  computeDepGate,
  computeNextStory,
  cmpStoryId,
  writeFollowups,
  computeFollowupsStatus,
  parseFollowupsSection,
  followupKey,
  // Exportados para regresión.
  findRepoRootsForStory,
  computePreflightFrontmatter,
  // Step 5b adversarial — exportado para unit test del gate.
  computeDeepReviewGate,
  deepReviewConfig,
  // model-hint por complejidad — exportado para unit tests.
  computeModelHint,
  // tooling-expected PIPE-C9 — exportado para unit tests.
  computeToolingExpected,
  // findings.json determinista — exportados para regresión.
  writeFindings,
  computeFindingsStatus,
  resolveRunDir,
  deriveStoryId,
  normalizeFindingRecord,
  // gate E2E multi-app — exportados para unit tests.
  e2eConfig,
  selectE2eApps,
  // la 4ta fuente del delta — exportada para que `lib/late-snapshot.js` pregunte lo
  // MISMO que el consumidor de su resultado. Una guarda que mira menos que el re-loop deja pasar
  // en silencio justo lo que no ve.
  gitArchivosDelWorkingTree,
  // helpers del cierre recortado.
  computeDodCheckerNeeded,
  computeDeferralsOpen,
  // el validador de stories en los re-loops.
  decidirValidadorEnReloop,
};

if (require.main === module) {
  // Las opciones y subcomandos viejos siguen andando hasta el retiro
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
