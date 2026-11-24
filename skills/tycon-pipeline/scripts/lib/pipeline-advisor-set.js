/**
 * pipeline-advisor-set.js — una parte de pipeline.js (la cargan otras partes).
 *
 * Responsabilidad: qué revisores tocan según lo que cambió: la base, los condicionales, la detección del stack y el descuento mecánico.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, codeFiles, companionLib, deriveStoryId, fs, logGate, matchGlob, os, packsLib, path, readSessionMarker, readText, resolveRunDir, resolveSessionId, sessionIdFileKey, stackConfig, stateDirOf } = require('./pipeline-shared.js');
const { normalizeFindingRecord } = require('./pipeline-findings.js');
function lanzadorCodex(args) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);
  // sin --story en la llamada, el comando tampoco lo lleva: reviewers-run toma la story del marcador
  return ['node', q(path.resolve(estadoPipeline.PIPELINE_JS)), 'reviewers-run', '--repo', q(path.resolve(args.repo || '.')),
    ...(args.story ? ['--story', q(args.story)] : [])].join(' ');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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
      windowsHide: true,
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
      windowsHide: true,
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
        windowsHide: true,
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
const BANDERAS_DETECCION = require('./packs.js').BANDERAS;

// ── set BASE (matriz top-down del paso de revisores) ─────────────────────────────────────
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
  const sc = require('./story-checks.js');
  const isGold = sc.storySection(story, 'criteria') !== null || sc.storySection(story, 'tests') !== null;

  // story-validator post-impl + spec-first SIEMPRE en Mary+GOLD (ver el paso de revisores)
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
  const sinCriterios = storyText ? require('./story-checks.js').criteriaOf(storyText) : null;
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

// ── Smart re-loop advisors (refinement de regla D.i) ──
//
// Cuando iter N>1 del paso de revisores corre (fix-loop post-HITL), regla D.i.1 obliga el set
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
// aplicamos al nivel del set del paso de revisores — cada advisor declara su `tier`:
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

// Los que necesitan la story completa además del contexto compartido (paso de revisores). Los de paquetes lo
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
// La entrada del paso de revisores de un revisor de paquete (la del grupo validacion no tiene superficie ni
// profundidad: el paso «Validar la historia» no tiene vueltas).
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
    const { runStoryChecks } = require('./story-checks.js');
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
    mech_ambiguous_rules: [...new Set((mech.ambiguous || []).map((a) => String(a.rule || '')))],
  };
}

// ── El revisor de un crítico abierto vuelve a confirmarlo ───────────────────────────────────────────────────────────
//
// El cruce de «Hallazgos» (lib/reported-criticals.js, su tercer control) da por bueno un crítico «arreglado» sólo con otra vuelta
// legible del revisor que lo reportó, o con la exención del dueño. Si el descuento mecánico o el cálculo por diferencias
// lo dejan afuera de la vuelta siguiente, la única salida es la exención: por eso vuelve, por encima de los dos. Cuenta
// también el crítico reportado que findings.json todavía no trae (lo normal: el agente arregla y relanza antes de escribir
// los hallazgos).
// `{ agregar: [{ name, reason }], fuera: [texto], error }`. Sin marcador de esta historia, sin registro o sin reportes,
// nada que confirmar. Un registro o un findings.json que no se leen dan `error`: quien llama no descuenta esa vuelta.
// lo que dicen los textos del descuento mecánico: el revisor de un crítico abierto vuelve igual
const MECH_NUNCA_SACA = 'El descuento nunca saca a un revisor con críticos abiertos por confirmar: ése vuelve (confirm_reviewers).';

function revisoresPorConfirmar(args) {
  const vacio = { agregar: [], fuera: [], error: null };
  if (!args.story || (args.iter || 1) < 2) return vacio;
  // un marcador que no se lee no es «sin corrida»: no sé qué hay por confirmar
  const leido = readSessionMarkerStrict();
  if (leido.estado === 'ilegible') return { ...vacio, error: `el marcador de la sesión (${leido.motivo})` };
  const marker = leido.marcador;
  if (!marker || !marker.storyPath) return vacio;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const suya = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.resolve(marker.repoPath || process.cwd(), marker.storyPath);
  if (real(suya) !== real(args.story)) return vacio;
  const rc = require('./reported-criticals.js');
  // la carpeta de la corrida que anota el marcador puede ser relativa al repo del código
  const runDir = marker.runDir ? path.resolve(marker.repoPath || args.repo || process.cwd(), marker.runDir)
    : resolveRunDir(marker.repoPath || args.repo || process.cwd(), String(marker.storyId), false, suya, { marker });
  const all = rc.readAll(stateDirOf(os.homedir()));
  if (all.error) return { ...vacio, error: `el registro de críticos (${all.error})` };
  const lines = rc.linesOfRun(all.lines, { story: marker.storyId, since: marker.startedAt || null, ...rc.corridaDelMarcador(marker, runDir) });
  // renglones rotos y ningún reporte legible de la corrida: el cruce lo da por «registro ilegible», no por «nada»
  if (!lines.some((l) => l.kind === 'report')) return all.unreadable ? { ...vacio, error: `el registro de críticos (${all.unreadable} renglón(es) ilegible(s) y ningún reporte legible de esta corrida)` } : vacio;
  const h = require('./review-rounds.js').hallazgosDe(runDir);
  if (h.error && h.existe) return { ...vacio, error: `los hallazgos de la corrida (${h.error})` };
  // un `refuted` resta sólo con la constancia del verificador: la misma comprobación que el cruce del cierre (marker.js)
  let roster = null;
  try { roster = JSON.parse(fs.readFileSync(path.join(runDir, 'review-roster.json'), 'utf8')); } catch (_e) { roster = null; }
  const refutedHolds = (f) => {
    try { return normalizeFindingRecord(f, [], { roster, errores: [], runDir }).disposition === 'refuted'; } catch (_e) { return false; }
  };
  const pc = rc.porConfirmar({ lines, findings: h.lista || [], runDir, home: os.homedir(), story: marker.storyId, refutedHolds });
  const out = { ...vacio };
  for (const r of pc.revisores) {
    // uno que esta sesión no puede lanzar se exigiría sin salida: no se suma, y el cierre pide la exención como hoy
    if (!MODELOS.reviewerExists(r.name, { agentsDir: args.agentsDir })) { out.fuera.push(`${r.name} tiene un crítico abierto por confirmar (${r.rules.join(', ')}) y su agente no se puede lanzar en esta sesión: no lo sumo; el cierre pedirá la exención`); continue; }
    out.agregar.push({ name: r.name, reason: `crítico abierto por confirmar (${r.rules.join(', ')})` });
  }
  return out;
}

/**
 * Suma a `lista` los revisores por confirmar: los saca de `skipped` y de `mech_discounted` de `salida` y los nombra en
 * `confirm_reviewers`. Devuelve la lista nueva. Los demás campos de `salida` no cambian.
 */
function sumarPorConfirmar(lista, salida, pc) {
  const nueva = [...lista];
  for (const a of pc.agregar) if (!nueva.includes(a.name)) nueva.push(a.name);
  if (!pc.agregar.length) return nueva;
  const nombres = new Set(pc.agregar.map((a) => a.name));
  if (Array.isArray(salida.skipped)) {
    salida.skipped = salida.skipped.filter((s) => !nombres.has(typeof s === 'string' ? s : s.name));
    if (salida.skipped_count != null) salida.skipped_count = salida.skipped.length;
  }
  if (Array.isArray(salida.mech_discounted)) {
    salida.mech_discounted = salida.mech_discounted.filter((d) => !nombres.has(d.name));
    if (!salida.mech_discounted.length) delete salida.mech_discounted;
  }
  salida.confirm_reviewers = pc.agregar;
  return nueva;
}

// ── El validador de stories en los re-loops ──────────────────────
//
// Medido: en los re-loops, después de
// DOS veredictos limpios seguidos del validador tras implementar, trajo algo nuevo en 2 de 24 lanzamientos
// (ninguno bloqueante); con menos veredictos limpios seguidos, trajo algo nuevo en 62 de 125. Entonces, desde la vuelta 2: si sus dos últimos
// veredictos sobre ESTA story desde el arranque del paso de revisores dicen `limpio` y VAL-C5/VAL-C6 salen limpios sin
// modelo, el validador sale del set (y del `expected`). Todo lo demás INVOCA: no poder leer la
// conversación, faltar el arnés o el arranque del paso de revisores, un chequeo que no pudo mirar. La duda va hacia más
// control. Cualquier veredicto que no sea `limpio` —hallazgos, inconsistente, sin
// veredicto, un lanzamiento que no volvió— corta la racha.
//
// Lee la conversación con las libs del ARNÉS (reviewers-cost.js, que ya carga tokens-digest.js): la
// constancia del medidor y esta decisión son la MISMA lectura. Pura respecto del registro: anota la CLI.
const VALIDADOR_STORIES = 'tycon-story-validator';
const RACHA_PARA_SOLTAR = 2;

function libsDelArnes(guidesDir) {
  // Dónde está el arnés lo dice UN lector (lib/harness-path.js): la variable o el enlace; nunca una carpeta a mano.
  const r = guidesDir ? { dir: guidesDir } : require('./harness-path.js').rutaArnesHook();
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
    // los revisores: `reviewers` en un marcador nuevo, el 5 en uno viejo
    const tRev = marker && marker.stepTimings && (marker.stepTimings.reviewers || marker.stepTimings['5']);
    const desde = Date.parse((tRev && tRev.startedAt) || '');
    if (!Number.isFinite(desde)) return invoca('no sé cuándo arrancó el paso de revisores (el marcador no lo anotó): se invoca');
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
    const { runValidatorChecks } = require('./story-checks.js');
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

// El marcador de la sesión, con su estado: `ausente` (no existe), `ilegible` (existe y no se puede leer como objeto) u `ok`.
// 🔴 «no existe» y «no se puede leer» no son lo mismo: lo primero lo cubre la carpeta de la corrida, lo segundo frena.
function readSessionMarkerStrict() {
  const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`);
  if (!fs.existsSync(markerPath)) return { estado: 'ausente', marcador: null };
  try {
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (m && typeof m === 'object' && !Array.isArray(m)) return { estado: 'ok', marcador: require('./run-dir.js').marcadorConRutas(m) };
    return { estado: 'ilegible', marcador: null, motivo: 'no es un objeto' };
  } catch (e) { return { estado: 'ilegible', marcador: null, motivo: String(e.message).slice(0, 80) }; }
}

module.exports = { revisoresPorConfirmar, readSessionMarkerStrict, advisorAffectedByDelta, computeAdvisorSet, detectStack, revisoresDelNucleo, BANDERAS_DETECCION, paquetesInstalados, paquetesActivos, superficieDe, computeMechDiscount, MECH_DISCOUNTABLE, decidirValidadorEnReloop, computeBase, computeCompletitud, computeConditional, unique, resumenPaquetes, MECH_NUNCA_SACA, sumarPorConfirmar, aplicarDecisionValidador, salidaGrande, lanzadorCodex, ADVISOR_COST_TIER, revisorDePaquete, gitAddedLinesByFile };
