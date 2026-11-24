/**
 * pipeline-preflight.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: lo que se mira y se anota antes de trabajar: la señal de trabajo, el pedido de la plataforma, las dependencias y el frontmatter de la historia.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, STEPS_TABLE, anotarEnMarker, companionLib, deriveStoryId, evidenceDirForStory, evidenceKeyOr, fs, harnessWorkSignal, homeCommand, isNil, logGate, nn, os, parseFrontmatterPipeline, path, readSessionMarker, readText, resolveRunDir, resolveSessionId, storyIsExemptCheck, storyRequiresRuntimeEvidenceCheck } = require('./pipeline-shared.js');

/**
 * Pone una bandera de hecho externo en el marcador de esta sesión (y saca el aviso de su parte, si lo había), con una
 * línea en gates.log. La llaman sólo los comandos del arnés que hicieron el trabajo. → true si escribió.
 */
function marcarHechoExterno(flag, detalle, campos = {}) {
  const r = anotarEnMarker(campos, (x) => STEPS_TABLE.setExternalFlag(x, flag));
  if (!r.ok) return r;
  logGate({ name: 'external-flag', flag, storyId: nn(r.marker.storyId, null), ...detalle });
  return r;
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

function storyNeedsPlaywrightCheck(content) {
  if (!content) return false;
  return /\b(FullUI-\d|E2E-\d|E\d+-[a-z])/.test(content) ||
         /tests_done_playwright_spec/.test(content) ||
         /tests\/e2e\//.test(content);
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
      : `Correr: ${homeCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/step-7c-macro.js')} --story ${storyPath} --scenario <scenario.json> --evidence-dir ${evidDir}  (o escribir el archivo manualmente con formato hook-compliant — ver PRE-2)`,
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

/** Las horas para `CompletedWork` del pedido después de un `stop`: las que tenía más los segundos informados, o null. */
function completedWorkHours(current, stopResult) {
  const s = stopResult && stopResult.seconds;
  if (!Number.isInteger(s) || s < 0) return null;
  return Math.round(((Number(current) || 0) + s / 3600) * 100) / 100;
}

/**
 * `pipeline.js work-signal <start|stop> [--story <spec> --repo <dir>]`: el evento de trabajo de una historia (el aviso de trabajo del Arranque y
 * «Cerrar la historia»), con la historia, el título, el repo y la sesión. Sin `--story`, los de la corrida (el marker); «Cerrar la historia» corre
 * después del merge, cuando el marker ya se borró, y pasa la story. → `{ ran, seconds?, hours?, action?, warnings }`;
 * `hours` son los segundos de `stop` en horas, para sumar a `CompletedWork`. Una herramienta que falla nunca frena la
 * historia.
 */
function workSignalForRun(event, opts = {}) {
  // un renglón por clave, sin cruzar al siguiente: una clave vacía es vacía, no la clave de abajo
  const field = (fm, key) => ((new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(fm) || [])[1] || '').replace(/^(["'])(.*)\1$/, '$2');
  // con los finales de renglón de Windows y la marca de orden de bytes, como los demás lectores de frontmatter
  const frontmatter = (p) => ((/^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(p ? readText(p) : '') || [])[1] || '').replace(/\r/g, '');
  // la sesión, con la misma cadena que el marker (Claude Code, el banco y Codex): el Arranque abrió con ésa
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
    // la ruta del marker puede estar escrita contra su repo: se resuelve como la resuelve marker.js, no contra la carpeta
    const spec = marker.storyPath ? path.resolve(marker.repoPath || process.cwd(), marker.storyPath) : null;
    run = { storyId: String(marker.storyId), title: field(frontmatter(spec), 'title'), repo: marker.repoPath || null,
      sessionId: marker.sessionId || session, spec };
  }
  const spec = opts.storyPath || run.spec || null;
  const h = harnessWorkSignal(opts);
  if (!h) return constanciaDeHoras(event, spec, {}, opts, { ran: false, warnings: ['aviso de trabajo: el arnés de esta máquina no trae el evento de trabajo (scripts/lib/work-signal.js); sigo sin registrar'] });
  if (h.loadError) return constanciaDeHoras(event, spec, {}, opts, { ran: false, warnings: [`aviso de trabajo: el evento de trabajo del arnés no carga (${h.loadError}); sigo sin registrar`] });
  let r;
  try { r = h.ws.emit(event, { storyId: run.storyId, title: run.title || null, repo: run.repo, sessionId: run.sessionId }, { env: opts.env || process.env }); } catch (e) {
    constanciaDeHoras(event, spec, {}, opts, { warnings: [] });
    throw e;
  }
  const out = { ran: r.ran, warnings: r.warnings };
  if (r.result.action) out.action = r.result.action;
  if (event === 'stop' && Number.isInteger(r.result.seconds)) {
    out.seconds = r.result.seconds;
    out.hours = completedWorkHours(0, r.result);
  }
  return constanciaDeHoras(event, spec, r.result, opts, out);
}

/**
 * La constancia de lo real de un `stop`: lo que contestó la herramienta (o nada, si no contestó), para que estimate-real
 * no dependa del modelo y valga siempre el último `stop`. Devuelve `out` con el aviso si no se pudo dejar.
 */
function constanciaDeHoras(event, spec, result, opts, out) {
  if (event !== 'stop') return out;
  if (!spec) return { ...out, warnings: [...out.warnings, 'horas reales: sin la ruta de la historia no dejo constancia; lo real no se va a anotar (pasá --story <spec>)'] };
  try { require('./real-hours.js').record(opts.home || os.homedir(), spec, result); } catch (e) {
    return { ...out, warnings: [...out.warnings, `horas reales: no pude dejar la constancia (${e.code || e.message}); lo real de esta historia no se va a anotar`] };
  }
  return out;
}

// ── pipeline.js dep-gate — gate mecánico de dependencias nuevas ─
// bmad-dev-story HALTea si la implementación agrega dependencias fuera del spec
// ("new dependencies beyond story specifications → HALT: need user approval"). TYCON no
// tiene check equivalente: los advisors de seguridad atrapan un paquete VULNERABLE, no un
// paquete legítimo que nadie aprobó. Corre en «Correr las pruebas» (post-build): diffea las dependencias
// AGREGADAS en package.json / *.csproj / Directory.Packages.props vs HEAD contra el texto de
// la story. Un paquete nuevo cuyo nombre NO aparezca en la story → undeclared → PAUSA HITL.
// Regla mecánica y verificable (no inferencia, estilo E.i): "declarado" = el nombre del
// paquete aparece textualmente en la story (case-insensitive) — conservador a propósito.
function computeDepGate({ repo, story }) {
  const { execFileSync } = require('child_process');
  const storyAbs = story ? (path.isAbsolute(story) ? story : path.join(repo, story)) : null;
  const storyText = storyAbs ? readText(storyAbs) : '';
  // 🔴 Stories de dos repos: el código —y sus dependencias— pueden vivir en un repo hermano declarado
  //    (`evidence.companion_repos`). Mirando sólo el repo de la story, un paquete nuevo del hermano no se vería. Se
  //    miran los hermanos que la story toca (con archivos declarados): uno declarado y sin tocar no es de esta story.
  let raices = [repo];
  let hermanosError = null;
  const hermanosFaltan = [];
  try {
    raices = [repo, ...companionLib.touchedRoots(repo, storyAbs, { onMissing: (nombre, quien) => hermanosFaltan.push({ repo: nombre, motivo: `declarado en ${quien} y no está en disco` }) })];
  } catch (e) { hermanosError = e.message; }
  const diffs = [];
  const sinMedir = [];
  const MANIFIESTOS = ['package.json', '*/package.json', '**/package.json',
    '*.csproj', '**/*.csproj', 'Directory.Packages.props', '**/Directory.Packages.props'];
  const gitDe = (raiz, a, input) => execFileSync('git', ['-C', raiz, ...a], { windowsHide: true, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
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
      const bt = require('./browser-test.js');
      const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); } };
      return bt.gates(require('./story-gate-io.js').DEFAULT_STATE_DIR)
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


// Pre-flight hook validation (anti-retry).
// Usage:
//   node pipeline.js preflight-frontmatter --story-path <spec.md> --target-status done
//   node pipeline.js preflight-frontmatter --story-path <spec.md> --target-pipeline-done A-backend
//     → JSON con { preconditions: [{ satisfied, how_to_satisfy }], ready_to_edit }
// Resuelve qué pre-condiciones bloquearían el Edit ANTES de intentarlo. Si
// ready_to_edit=true, el Edit pasa. Si false, satisfacer las preconditions
// primero (cada una con how_to_satisfy explícito).
function cmdPreflightFrontmatter(cmd, args) {
  const result = computePreflightFrontmatter(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ready_to_edit === false ? 1 : 0);
}

function cmdWorkSignal(cmd, args) {
  const event = process.argv[3];
  if (!['start', 'stop'].includes(event)) {
    process.stderr.write('uso: pipeline.js work-signal <start|stop> [--story <spec> --repo <dir>]   (Arranque: start · «Cerrar la historia»: stop)\n');
    process.exit(2);
  }
  // la acción que hizo el agente con la herramienta de horas: marca sólo con el id en un resultado de la conversación
  if (event === 'start' && !isNil(args.actionDone)) {
    const EF = require('./external-flags.js');
    const marker = readSessionMarker();
    const sid = resolveSessionId();
    const abierta = EF.entradaAbierta({ repo: marker ? nn(marker.repoPath, null) : null, sessionId: (marker && marker.sessionId) || (sid === '_nosession' ? null : sid) });
    const v = EF.actionDone({ id: args.actionDone, abierta });
    if (!v.ok) {
      // la entrada está abierta y nada la confirma: no marca, y el cartel lo dice en vez de «no se pudo abrir»
      if (v.sinConfirmar) {
        anotarEnMarker({}, (x) => {
          const otras = (Array.isArray(x.startWarnings) ? x.startWarnings : []).filter((w) => w && w.part !== 'time-tracking');
          x.startWarnings = [...otras, { part: 'time-tracking', message: v.motivo.slice(0, 300), unconfirmed: true }];
        });
      }
      process.stderr.write(`work-signal start --action-done: no marco — ${v.motivo}\n`);
      process.exit(1);
    }
    if (!v.verificado) process.stderr.write(`work-signal start --action-done: marco sin verificar — ${v.motivo}\n`);
    // sin verificar (Codex) queda dicho también en el marcador, no sólo en gates.log
    const m = marcarHechoExterno('workSignalStarted', { via: 'action-done', id: String(args.actionDone).trim().slice(0, 120), herramienta: nn(v.herramienta, null), verificado: v.verificado },
      { workSignalVerified: v.verificado });
    if (!m.ok) { process.stderr.write(`work-signal start --action-done: no marco — ${m.motivo}\n`); process.exit(1); }
    process.stdout.write(JSON.stringify({ marked: true, verificado: v.verificado, herramienta: nn(v.herramienta, null) }) + '\n');
    process.exit(0);
  }
  // la entrada que cerró el agente: sus horas, leídas del resultado de la llamada, son la constancia de lo real
  if (event === 'stop' && !isNil(args.actionDone)) {
    const marker = args.story ? null : readSessionMarker();
    const spec = args.story ? path.resolve(args.story)
      : marker && marker.storyPath ? path.resolve(marker.repoPath || process.cwd(), marker.storyPath) : null;
    if (!spec) { process.stderr.write('work-signal stop --action-done: sin marker activo en esta sesión — pasá --story <spec>\n'); process.exit(2); }
    const v = require('./external-flags.js').horasDeLaAccion({ id: args.actionDone });
    if (!v.ok) { process.stderr.write(`work-signal stop --action-done: no anoto horas — ${v.motivo}\n`); process.exit(1); }
    // las horas son de la historia de ese stop (la que nombró, o la del marcador si no nombró ninguna): el cierre de una no
    // se anota en otra
    const delMarcador = () => { const m = readSessionMarker(); return m && m.storyPath ? path.resolve(m.repoPath || process.cwd(), m.storyPath) : null; };
    const delStop = v.storyDelStop ? path.resolve(v.storyDelStop.replace(/^~(?=$|[\\/])/, os.homedir())) : delMarcador();
    if (!delStop || delStop !== spec) {
      process.stderr.write(`work-signal stop --action-done: no anoto horas — el work-signal stop fue de ${delStop || 'una historia que no sé'}, no de ${spec}\n`);
      process.exit(1);
    }
    try { require('./real-hours.js').record(os.homedir(), spec, { seconds: v.segundos, action: true }, { herramienta: v.herramienta }); } catch (e) {
      process.stderr.write(`work-signal stop --action-done: no pude dejar la constancia (${e.code || e.message})\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ recorded: true, seconds: v.segundos, hours: Math.round(v.segundos / 36) / 100, herramienta: v.herramienta }) + '\n');
    process.exit(0);
  }
  let r;
  try { r = workSignalForRun(event, args.story ? { storyPath: path.resolve(args.story), repo: args.repo ? path.resolve(args.repo) : null } : {}); } catch (e) { r = { ran: false, warnings: [`aviso de trabajo: falló (${e.code || e.message}); sigo sin registrar`] }; }
  if (r.error) { process.stderr.write(`work-signal: ${r.error}\n`); process.exit(1); }
  for (const w of r.warnings) process.stderr.write(`${w}\n`);
  // la bandera del aviso de trabajo la pone el arnés: con el evento atendido sin avisos y sin acción pendiente
  if (event === 'start' && !args.story && r.ran && !r.warnings.length) {
    if (r.action) process.stderr.write('work-signal start: hacé la acción y cerrá con pipeline.js work-signal start --action-done "<id que devolvió la herramienta>" (si no se puede, marker.js start-warning time-tracking "<motivo>")\n');
    else {
      const m = marcarHechoExterno('workSignalStarted', { via: 'work-signal' });
      r.marked = m.ok;
      if (!m.ok) process.stderr.write(`work-signal start: el aviso salió pero no marqué la parte — ${m.motivo}\n`);
    }
  }
  if (event === 'stop' && r.ran && r.action) process.stderr.write('work-signal stop: hacé la acción y dejá las horas con pipeline.js work-signal stop --action-done "<id de la entrada que cerraste>" (con --story si lo pasaste acá)\n');
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(0);
}


// El pedido de Azure DevOps de la historia, a su estado activo, con la estimación vigente de la historia: el arnés lo
// transiciona y recién ahí marca.
function cmdAdoMarkActive(cmd, args) {
  const marker = readSessionMarker();
  const storyPath = args.story ? path.resolve(args.story) : (marker && marker.storyPath) || null;
  if (!storyPath) { process.stderr.write('ado-mark-active: sin marker activo en esta sesión — pasá --story <spec>\n'); process.exit(1); }
  // el id con el lector común (`work_item:` y su nombre viejo), y la capa de plataforma del árbol que corre
  const raiz = path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..');
  let wi = null;
  let storyId = null;
  let contenidoStory = '';
  // directo del archivo: `readText` devuelve '' cuando no puede leer, y eso se vería como «no tiene pedido»
  try {
    contenidoStory = fs.readFileSync(storyPath, 'utf8');
    wi = require(path.join(raiz, 'scripts', 'lib', 'platform', 'work-item-field.js')).idOf(contenidoStory);
  } catch (e) {
    // no poder leerlo no es «no tiene pedido»: se dice
    process.stderr.write(`ado-mark-active: no pude leer el pedido de trabajo de la historia (${(e && (e.code || e.message)) || 'error'}); si no se puede, marker.js start-warning ado "<motivo>"\n`);
    process.exit(1);
  }
  // la estimación nunca frena el paso: sin el número de la historia, el pedido se marca igual y la línea lo dice
  let estimateMotivo = null;
  try {
    storyId = require('./test-scope.js').storyIdOf(contenidoStory);
    if (!storyId) estimateMotivo = 'la historia no trae `story:` en su frontmatter';
  } catch (e) {
    estimateMotivo = `no pude leer el número de la historia (${(e && (e.code || e.message)) || 'error'})`;
  }
  let repoDir = path.dirname(path.dirname(storyPath));
  try { repoDir = require('child_process').execFileSync('git', ['-C', path.dirname(storyPath), 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || repoDir; } catch (_) { /* sin git: la carpeta de arriba */ }
  const r = require('./external-flags.js').adoMarkActive({ workItem: wi, repoDir, reopen: !!args.reopen, assignTo: args.assignTo || null,
    platformJs: path.join(raiz, 'scripts', 'lib', 'platform', 'platform.js'), storyId, estimateMotivo });
  if (r.marked) {
    const m = marcarHechoExterno('adoMarkedActive', { via: 'ado-mark-active', workItem: wi });
    if (!m.ok) { process.stderr.write(`ado-mark-active: el pedido quedó activo pero no marqué la parte — ${m.motivo}\n`); process.exit(1); }
  }
  (r.code === 0 ? process.stdout : process.stderr).write(`${r.line}\n`);
  if (r.code === 3) process.stdout.write(`${r.line}\n`);
  process.exit(r.code);
}


// ── dep-gate — gate mecánico de dependencias nuevas ─
// Corre en «Correr las pruebas» (post-build). exit 2 si hay dependencias no declaradas en la story
// (PAUSA HITL), exit 0 si pass/skip. Ver computeDepGate.
function cmdDepGate(cmd, args) {
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

module.exports = { cmdWorkSignal, cmdAdoMarkActive, cmdDepGate, cmdPreflightFrontmatter, completedWorkHours, computeDepGate, findRepoRootsForStory, computePreflightFrontmatter };
