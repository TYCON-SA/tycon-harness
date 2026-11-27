/**
 * pipeline-advisor-context.js — una parte de pipeline.js (la cargan otras partes).
 *
 * Responsabilidad: lo que comparten la selección de revisores y la vuelta inteligente: el contexto de cada revisor y el tope de vueltas.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, PROPIA, RUNS_DIR, codeFiles, companionLib, deriveStoryId, esCodex, exists, fs, leerMarcadorDeLaCorrida, os, parseFrontmatterPipeline, path, readText, resolveRunDir, resolveSessionId, sessionIdFileKey, sessionLogPath, stackConfig, stateDirOf } = require('./pipeline-shared.js');
const { ADVISOR_COST_TIER, gitAddedLinesByFile, lanzadorCodex, readSessionMarkerStrict, revisorDePaquete, revisoresPorConfirmar } = require('./pipeline-advisor-set.js');
const { detectarWordSplit } = require('./pipeline-deep-review.js');
const BATCH_RULE_CODEX = 'Bajo Codex los revisores NO los lanza el modelo: correr el comando de `launch` (pipeline.js reviewers-run). ' +
  'Aplica la ventana (4 vivos; 2 con el pase adversarial en vuelo), anota cada lanzamiento para check-count y deja los reportes ' +
  'en step-05-advisor-reports/. Necesita red: si la caja de arena no la tiene, sale 2 sin lanzar y dice qué hacer.';
function conLanzadorCodex(out, args) {
  if (!esCodex()) return;
  out.launch = lanzadorCodex(args);
  out.batch_rule = BATCH_RULE_CODEX;
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
// La sección «Reglas para revisores» del CLAUDE.md del repo, al principio del contexto.
const { reglasRevisores, bloqueParaContexto, resumen: resumenReglas } = require('./reviewer-rules.js');
function tierDe(nombre) {
  if (ADVISOR_COST_TIER[nombre]) return ADVISOR_COST_TIER[nombre];
  const r = revisorDePaquete(nombre);
  return r ? r.profundidad : undefined;
}

// Hints de modelo para re-loops: los emite CUALQUIER iteración N>1, no sólo
// el path mode='smart-reloop'. Sin ellos, los paths force-full-reloop y `advisors --iter N>1`
// (exactamente los que se usan cuando smart-reloop no aplica, el caso más caro)
// correrían los tier 'deep' a Opus precio pleno.
// El orquestador DEBE pasarlos como `model:` al Agent() (paso de revisores) salvo
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
  const sc = require('./story-checks.js');
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
    const storyContent = story ? readText(story) : '';
    const digest = buildStoryDigest(storyContent);
    // ── El diff POR REPO ─────────────────────────────────────────────────────────────────────────
    // Un solo `git -C repo diff HEAD -- <todas las rutas>` fallaría: con UNA ruta del repo hermano, git sale con
    // «… is outside repository» y se perdería el diff de TODOS los archivos, también los del repo; el texto de reemplazo
    // diría «repo sin git» y un revisor lo repetiría como causa.
    // Por eso los archivos se agrupan por su repo git; el del `--repo` va como siempre y cada
    // hermano en su propia sección, con sus archivos escritos `(<nombre>) <ruta>`, la forma del paso «Pase adversarial». Si git falla
    // en un repo, se dice cuál y por qué, y los demás conservan su diff.
    const grupos = companionLib.groupByRepo(files, repo);
    const propios = grupos.filter((g) => g.propio).flatMap((g) => g.files.map((x) => x.original));
    const hermanos = grupos.filter((g) => !g.propio);
    // El diff no se mide contra HEAD: lo que la story ya commiteó también lo revisa el revisor, y lo sin commitear viene
    // encima. La base es el commit en que arrancó la corrida (`baseSha` del marcador, si es de este repo y ancestro de
    // HEAD, y de esta story); si no, la bifurcación con la rama principal; sin ninguna de las dos, HEAD. El encabezado
    // dice cuál fue y por qué se descartó cada una de las anteriores.
    const { resolver, bifurcacion } = require('./coverage-base.js');
    let marcadorDeLaCorrida = null;
    let sinMarcador = null;
    try {
      const lm = leerMarcadorDeLaCorrida();
      marcadorDeLaCorrida = lm.marker;
      sinMarcador = lm.error;
    } catch (e) { sinMarcador = e.message; }
    const deEstaStory = story ? deriveStoryId(story) : null;
    if (marcadorDeLaCorrida && marcadorDeLaCorrida.baseSha && deEstaStory && String(marcadorDeLaCorrida.storyId || '') !== String(deEstaStory)) {
      sinMarcador = `el marcador es de la story ${marcadorDeLaCorrida.storyId || '(sin id)'}, no de la ${deEstaStory}`;
      marcadorDeLaCorrida = null;
    }
    const baseDe = (cwd) => {
      const r = resolver({ repo: cwd, env: {}, marker: marcadorDeLaCorrida, markerError: sinMarcador });
      if (r.source === 'marcador') return { ref: r.ref, nombre: `el arranque de la corrida (${r.ref.slice(0, 12)})` };
      const porQue = [...(r.descartadas || []).map((d) => d.motivo), ...(sinMarcador && !(r.descartadas || []).length ? [sinMarcador] : [])];
      const b = bifurcacion(cwd);
      if (b.sha) return { ref: b.sha, nombre: `la bifurcación con ${b.rama}${porQue.length ? ` (sin el arranque de la corrida: ${porQue.join('; ')})` : ''}` };
      return { ref: 'HEAD', nombre: `HEAD — respaldo: lo ya commiteado en la rama NO está en este diff (${[...porQue, b.motivo].join('; ')})` };
    };
    const gitDiff = (cwd, rutas) => {
      const base = baseDe(cwd);
      const r = require('child_process').spawnSync('git', ['-C', cwd, 'diff', base.ref, '--', ...rutas], {
        windowsHide: true,
        encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.error || r.status !== 0) {
        const motivo = String((r.stderr || '').split('\n').find((l) => l.trim()) || (r.error && r.error.message) || `salió ${r.status}`).trim();
        return { text: '', error: motivo, base: base.nombre };
      }
      return { text: r.stdout || '', error: null, base: base.nombre };
    };
    // Con `--files` vacío el alcance es el working tree entero del repo (como siempre). Con `--files` sólo del
    // hermano, el repo no aporta diff: un `git diff <base> --` sin rutas traería todo el working tree, que nadie pidió.
    const principal = files.length && !propios.length
      ? { text: '', error: null, sinArchivos: true, base: 'HEAD' }
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
      return { etiqueta, root: g.root, error: d.error, files: g.files, diff: '', base: d.base };
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
      s.root ? `## Diff del repo hermano \`${s.etiqueta}\` (git diff contra ${s.base} en ${s.root})` : '## Archivos fuera de todo repo git',
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
      // los del repo que están deprecados, marcados (los de un hermano se leen con la lista de su propio repo)
      require('./deprecated.js').seccionParaRevisores({ repo, files: shownFiles.filter((f) => !f.startsWith('(')) }),
      // las pruebas viejas que estaban en rojo y se editaron, cada una con su razón (marker.js note-red-test)
      require('./red-test-edit.js').bloqueParaRevisores(marcadorDeLaCorrida),
      '## Story digest (frontmatter + ACs + Tests + Tasks + verificación)',
      '',
      digest || '(sin story)',
      '',
      `## Diff unificado (git diff contra ${principal.base})`,
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

/**
 * Congela la vuelta de revisores (historia 8.161): sella el repo de la historia, el del código y cada repo hermano
 * declarado, y arma la copia de sólo lectura de cada uno en la carpeta de estado (lib/frozen-tree.js). Los hermanos
 * entran como en el pase: así «Preparar» compara también su código con lo revisado, y el arreglo de un hallazgo del
 * pase en un hermano lo cubre la vuelta siguiente. `{ repos, aviso? }` o `{ error }`: sin sello o sin copia de la
 * historia o del código la vuelta no se lanza, nunca se revisa la carpeta viva en silencio. Un hermano que no se deja
 * sellar no frena la vuelta: se lee vivo, como antes, y `aviso` lo dice; entonces el arreglo de un hallazgo del pase
 * en ese hermano sigue frenando el cierre del pase. Una ruta fuera de todo repo de git no tiene árbol que sellar: no
 * suma copia.
 */
function congelarVuelta({ story, repo, iter }) {
  const ft = require('./frozen-tree.js');
  const base = ft.reposDe([story, repo]);
  if (base.error) return { error: base.error };
  if (!base.repos.length) return { repos: [] };
  let storyId = null;
  try { storyId = story ? parseFrontmatterPipeline(readText(story)).story || null : null; } catch { storyId = null; }
  // la vuelta nueva borra las copias de las anteriores, menos las del pase abierto: una vuelta anterior puede haber
  // reusado una copia que el pase sigue leyendo (historia 8.330)
  const lm = leerMarcadorDeLaCorrida();
  const noBorrar = lm.error ? null : copiasDelPaseAbierto(lm.marker);
  const congelar = (repos) => ft.sealAndFreeze({
    stateDir: stateDirOf(os.homedir()), sid: sessionIdFileKey(), etiqueta: `rev-iter${iter || 1}`, repos, tipo: 'revisores', story: storyId, noBorrar,
  });
  const pase = ft.reposDelPase({ story, repo });
  const conHermanos = !pase.error && pase.repos.length > base.repos.length ? congelar(pase.repos) : null;
  if (conHermanos && !conHermanos.error) return conHermanos;
  const sinHermanos = congelar(base.repos);
  const motivo = pase.error || (conHermanos && conHermanos.error);
  if (!motivo || sinHermanos.error) return sinHermanos;
  return { ...sinHermanos, aviso: `los repos hermanos no se sellaron (${motivo}): los revisores los leen vivos, y un arreglo del pase en ellos frena su cierre` };
}

/**
 * Las copias del pase abierto: las congeladas antes de lanzarlo (`adversarialFrozen`) y las del pase lanzado
 * (`adversarial`) mientras no se anotó su resultado: una entrada de `adversarialPasses` del pase de la ejecución (su
 * `tipo`), desde el lanzamiento.
 */
function copiasDelPaseAbierto(m) {
  if (!m || typeof m !== 'object') return [];
  const out = [];
  if (m.adversarialFrozen && m.adversarialFrozen.copias) out.push(...Object.values(m.adversarialFrozen.copias));
  const a = m.adversarial;
  const desde = a ? Date.parse(a.launchedAt) : NaN;
  const anotado = !!a && (m.adversarialPasses || []).some((p) => p && p.tipo === '5b' && !(Date.parse(p.ts) < desde));
  if (a && a.copias && !anotado) out.push(...Object.values(a.copias));
  return out.filter((c) => typeof c === 'string' && c);
}

/** Suma al contexto de los revisores (el compartido y los recortados) la copia y el sello de cada repo. */
function contextoConLaCopia(ctx, repos) {
  if (!ctx || !repos.length) return;
  const seccion = require('./frozen-tree.js').seccionDelContexto(repos);
  for (const f of [ctx.context_file, ...Object.values(ctx.overrides || {})].filter(Boolean)) {
    try { fs.appendFileSync(f, seccion, 'utf8'); } catch { /* el contexto es best-effort; la copia ya está y la salida la nombra */ }
  }
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
// el chequeo antes de la ventana de firma (owner-window.js): comprueba lo que la firma exige sin hacer lo que autoriza
const PRECHEQUEO = 'TYCON_SIGN_PRECHECK';

// El tope de vueltas de revisores (lib/review-rounds.js): null si la vuelta `iter` puede servirse, o el mensaje llano de
// por qué no. Al tope con algo abierto, un crítico de seguridad o de datos lo decide el dueño (una vuelta extra con su
// firma, que se anota en gates.log, o eximirlo); lo demás queda como deuda visible y el recorrido sigue sin otra vuelta.
// La vuelta extra no es firma de trámite ni la firma la coordinadora por delegación.
function topeDeVueltas({ args, iter, rr, runDir, repoAbs, storyId, vueltaChica = false, sinCodigo = false }) {
  const tope = rr.tope({ repo: repoAbs });
  const stateDir = stateDirOf(os.homedir());
  const anotar = (g) => { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), story: storyId, iter, ...g })}\n`); };
  // pedida para otra sesión sin firma que dar: se dice por qué no la necesita y quién la pide
  const laPideLaCorrida = 'La pide la sesión de la corrida, con el set sin --extra-round ni --for-session';
  // la vuelta extra para otra sesión es de la historia de su corrida, no de la que diga --story
  if (estadoPipeline.paraOtra && estadoPipeline.paraOtra.storyId !== String(storyId)) {
    process.stderr.write(`🛑 La corrida de la sesión ${estadoPipeline.paraOtra.pedida} es de la story ${estadoPipeline.paraOtra.storyId}, y --story nombra la ${storyId}. No escribí nada.\n`);
    process.exit(2);
  }
  if (iter <= tope.value) {
    if (estadoPipeline.paraOtra) return `🛑 La vuelta ${iter} está dentro del tope de ${tope.value}: no necesita la vuelta extra ni la firma. ${laPideLaCorrida}.\n`;
    if (args.extraRound) return `🛑 La vuelta ${iter} no necesita la vuelta extra ni la firma: está dentro del tope de ${tope.value}. Pedí el set sin --extra-round.\n`;
    for (const p of tope.problems || []) process.stderr.write(`⚠️  ${p}\n`);
    return null;
  }
  // una vuelta sin código no lanza revisores: se cierra sola, sin tope ni firma. Queda anotada
  // pasado el tope, sólo si «Preparar» pasaría: la misma comparación con lo revisado (lib/reviewed-diff.js). Lo que el
  // re-loop no revisa y se ejecuta (la configuración, un workflow), o código que el delta por horas no vio, frena acá
  const sinCambiosRevisables = sinCodigo && !estadoPipeline.paraOtra ? cambiosDesdeLoRevisado({ storyId, repoAbs, args }) : null;
  if (sinCambiosRevisables && !sinCambiosRevisables.vacio) {
    process.stderr.write(`⚠️  La vuelta ${iter} no trae revisores, pero no se cierra sola pasado el tope: ${sinCambiosRevisables.motivo}.\n`);
  }
  if (sinCodigo && !estadoPipeline.paraOtra && sinCambiosRevisables && sinCambiosRevisables.vacio) {
    if (args.extraRound) return `🛑 La vuelta ${iter} no trae código: se cierra sola, sin la vuelta extra ni la firma. Pedí el set sin --extra-round.\n`;
    anotar({ name: 'no-code-round', status: 'ok', tope: tope.value });
    process.stderr.write(`ℹ️  La vuelta ${iter} pasa el tope de ${tope.value} sin revisores: desde la última vuelta no cambió código, y se cierra sola, sin firma.\n`);
    return null;
  }
  if (rr.extras({ stateDir, story: storyId }).some((e) => e.iter === iter)) {
    if (estadoPipeline.paraOtra) return `🛑 La vuelta extra ${iter} ya está autorizada. ${laPideLaCorrida}, sin otra firma.\n`;
    return args.extraRound ? `🛑 La vuelta extra ${iter} ya está autorizada: pedí el set sin --extra-round, sin otra firma.\n` : null;
  }
  const h = rr.hallazgosDe(runDir);
  const pre = rr.prefijos();
  const ab = rr.abiertos(h.lista, { prefijos: pre });
  const bloquean = ab.filter((a) => a.bloquea);
  const deuda = ab.filter((a) => !a.bloquea);
  const de = { maquina: 'de esta máquina', repo: 'del repo', organizacion: 'de la organización', fabrica: 'de fábrica' }[tope.source] || '';
  // «no pude mirar» no es «no quedó nada abierto»
  const noMirado = h.error || (!runDir ? 'no encontré la carpeta de la corrida' : null);
  // sólo textos desde la última vuelta: la vuelta chica pasa el tope sin firma (lib/review-change-policy.js). No con un
  // crítico de seguridad o de datos abierto, ni sin poder mirar lo abierto: eso lo sigue decidiendo una persona
  if (vueltaChica && !estadoPipeline.paraOtra && !noMirado && !bloquean.length) {
    if (args.extraRound) return `🛑 La vuelta ${iter} es una vuelta chica (sólo cambiaron textos): pasa el tope sin la vuelta extra ni la firma. Pedí el set sin --extra-round.\n`;
    anotar({ name: 'small-round', status: 'ok', tope: tope.value });
    process.stderr.write(`ℹ️  La vuelta ${iter} pasa el tope de ${tope.value} como vuelta chica: desde la última vuelta sólo cambiaron textos, y la revisan ${require('./review-change-policy.js').REVISORES_DE_LA_VUELTA_CHICA.join(', ')}, sin firma.\n`);
    return null;
  }
  // al tope sin nada abierto no hay nada que decidir: no frena, no devuelve revisores y dice que siga. Sin poder leer los
  // hallazgos no es «nada abierto», y un crítico arreglado que su revisor todavía no confirmó necesita una vuelta más:
  // los dos frenan como siempre
  const porConfirmar = !ab.length ? revisoresPorConfirmar({ ...args, iter }) : null;
  const nadaPorConfirmar = !!porConfirmar && !porConfirmar.error && !porConfirmar.agregar.length && !porConfirmar.fuera.length;
  if (!estadoPipeline.paraOtra && !noMirado && h.existe && !ab.length && nadaPorConfirmar) {
    if (args.extraRound) return `🛑 La vuelta ${iter} no necesita la vuelta extra ni la firma: no quedó nada abierto. Pedí el set sin --extra-round.\n`;
    anotar({ name: 'review-cap-shown', status: 'ok', tope: tope.value, abiertos: [] });
    return { sinAbiertos: `ℹ️  Llegaste al tope de ${tope.value} vueltas de revisores (${de}) y no quedó nada abierto: no hace falta otra vuelta. Seguí con «Probar en vivo» y «Preparar el pull request».\n` };
  }
  const avisos = [...tope.problems, ...pre.problems].map((p) => `   ⚠️  ${p}`);
  if (args.extraRound && args.delegated) {
    return `🛑 No se autorizó la vuelta extra ${iter}: --delegated ya no la autoriza. Va el mismo comando sin --delegated: el dueño lo aprueba en la ventana de permiso, o en su terminal con --terminal.\n`;
  }
  if (args.extraRound) {
    // la aprueba la persona en la ventana de permiso (o con --terminal), después del aviso del tope de ESTA vuelta
    const aviso = rr.avisoDelTope({ stateDir, story: storyId, iter });
    if (!aviso || !aviso.ts) return `🛑 No se autorizó la vuelta extra ${iter}: todavía no se avisó el tope de esta vuelta. Pedí el set sin --extra-round, el arnés dice qué quedó abierto, y recién ahí vale la aprobación.\n`;
    if (args.quote) return `🛑 No se autorizó la vuelta extra ${iter}: la cita ya no la autoriza. La aprueba el dueño en la ventana de permiso (este comando sin --quote) o en su terminal (--terminal).\n`;
    // desde la tercera vuelta, la nota de repensar se pide antes de gastar la firma: sin ella el set no se sirve igual
    const rt = require('./rethink.js');
    const antes = () => {
      if (iter < rt.FIRST_ITER) return null;
      const leida = rt.readNote(runDir, iter);
      if (leida.ok) return null;
      const why = leida.reason === 'no existe' || leida.reason === 'no hay carpeta de corrida' ? null : leida.reason;
      return { codigo: 3, motivo: rt.blockMessage({ iter, runDir, repeated: rt.repeatedFindings(runDir), why }).trim() };
    };
    const ow = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
    const r = ow.exigir({ firma: 'extra-round', argv: process.argv.slice(1), resumen: `vuelta extra ${iter} de revisores de la story ${storyId}`,
      propia: PROPIA, anotar: (g) => anotar(g), antes });
    if (r.codigo !== 0) return `🛑 No se autorizó la vuelta extra ${iter}: ${r.motivo}.\n`;
    const f = ow.fijarDestino({ r, propia: PROPIA, necesitaMarcador: !!estadoPipeline.paraOtra, leerMarcador: (sid) => ow.marcadorEn(path.join(stateDir, 'active', `${sid}.json`)) });
    if (f.codigo !== 0) { process.stderr.write(`🛑 No se sirvió la vuelta extra ${iter}: ${f.motivo}. No escribí nada.\n`); process.exit(f.codigo); }
    anotar({ name: 'extra-round', status: 'ok', quien: args.approvedBy || process.env.USER || 'persona', via: r.via, ...(f.constancia.por ? { por: f.constancia.por } : {}) });
    return null;
  }
  const renglones = [`🛑 Llegaste al tope de ${tope.value} vueltas de revisores (${de}): no devuelvo el set de la vuelta ${iter}.`, ...avisos];
  if (noMirado) renglones.push(`   No pude mirar lo abierto (${noMirado}): escribí los hallazgos con pipeline.js write-findings y volvé a pedirlo.`);
  else if (porConfirmar && porConfirmar.error) renglones.push(`   No quedó nada abierto en findings.json, pero no pude mirar lo que queda por confirmar (${porConfirmar.error}).`);
  else if (porConfirmar && (porConfirmar.agregar.length || porConfirmar.fuera.length)) {
    renglones.push('   No quedó nada abierto en findings.json, pero un crítico arreglado espera que su revisor lo confirme:');
    for (const r of porConfirmar.agregar) renglones.push(`     · ${r.name}: ${r.reason}`);
    for (const l of porConfirmar.fuera) renglones.push(`     · ${l}`);
    renglones.push('   Una vuelta más con --extra-round lo confirma; si no, el cierre pide eximirlo.');
  } else if (!ab.length) renglones.push('   No quedó nada abierto: seguí con «Probar en vivo» y «Preparar el pull request».');
  if (bloquean.length) {
    renglones.push(`   Quedó abierto algo de seguridad o de datos (${bloquean.length}): lo decide una persona. Mostrale esto y preguntale qué hace:`);
    for (const l of rr.resumen(bloquean)) renglones.push(`     · ${l}`);
    renglones.push('   (a) Una vuelta más para arreglarlo: el mismo comando con --extra-round, y el dueño lo aprueba en la ventana de permiso');
    renglones.push('       (o lo corre en su terminal con --terminal). No es trámite ni la firma la coordinadora por delegación.');
    renglones.push('   (b) Eximirlo: marker.js waive-critical --rule <regla> --file <archivo> --reason "<por qué>" (la persona lo aprueba en la ventana de permiso).');
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

/**
 * La foto de la vuelta que se lanza (`marker.js snapshot-iter N --at-launch`): la vuelta siguiente calcula su delta desde
 * ella aunque esta ronda no se complete. Nunca frena el lanzamiento; si no se pudo, lo dice. Una vuelta servida para otra
 * sesión (`--for-session`) no toca su marcador: la firma autoriza la vuelta, no escribir la corrida ajena.
 */
function fotoAlLanzar(iter, horaDelSello) {
  if (estadoPipeline.paraOtra) return;
  const n = parseInt(iter, 10) || 1;
  try {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'marker.js'), 'snapshot-iter', String(n), '--at-launch', '--at', horaDelSello], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
  } catch (e) {
    process.stderr.write(`⚠️  no pude guardar la foto de la vuelta ${n} al lanzarla (${String((e && (e.stderr || e.message)) || e).trim().split('\n')[0]}): ` +
      'si la ronda no se completa, la vuelta siguiente re-corre el set completo.\n');
  }
}

// ¿Cambió algo desde la última vuelta sellada de esta sesión que «Preparar» contaría? `{ vacio: true }` si nada, o
// `{ vacio: false, motivo }` (lo cambiado, o por qué no se pudo mirar: ante la duda, no está vacío).
function cambiosDesdeLoRevisado({ storyId, repoAbs, args }) {
  try {
    const ft = require('./frozen-tree.js');
    const sid = sessionIdFileKey();
    const v = ft.ultimaVuelta(stateDirOf(os.homedir()), sid, 'revisores');
    if (!v || !(v.repos || []).length) return { vacio: false, motivo: 'no hay una vuelta sellada con qué comparar' };
    if (v.story !== undefined && v.story !== null && String(v.story) !== String(storyId)) return { vacio: false, motivo: 'la última vuelta sellada es de otra historia' };
    const { marcador } = readSessionMarkerStrict();
    const marker = marcador || { storyId, repoPath: repoAbs };
    const storyArg = args.story || marker.storyPath || null;
    const storyAbs = storyArg ? (path.isAbsolute(storyArg) ? storyArg : path.join(repoAbs, storyArg)) : null;
    const { STEPS_TABLE } = require('./pipeline-shared.js');
    const c = require('./reviewed-diff.js').comparar({ marker, v, storyAbs, stateDir: stateDirOf(os.homedir()), cierre: STEPS_TABLE.reviewersClose(marker) });
    if (c.error) return { vacio: false, motivo: c.error };
    if (!c.distintos.length) return { vacio: true };
    const lista = c.distintos.map((d) => d.f);
    return { vacio: false, motivo: `cambió después de la última vuelta revisada ${lista.slice(0, 5).join(', ')}${lista.length > 5 ? '…' : ''}` };
  } catch (e) { return { vacio: false, motivo: `no pude comparar con lo revisado (${(e && e.message) || e})` }; }
}

// El freno de la carpeta sin trabajo: antes de una vuelta de revisores, si la carpeta de la story no tiene ningún cambio
// contra la rama principal (ni commits propios ni cambios sin commitear), los revisores leerían la principal y dirían
// «no está el código». Pasa cuando algo aparta los cambios mientras corre la vuelta (un `git stash` de fondo). Null si
// puede seguir, o el mensaje de por qué no. Sin git, sin rama principal conocida o ante un error de git, no frena: no
// puede afirmar que la carpeta está vacía. Tampoco frena parada en la propia rama principal. Los commits desde el
// `baseSha` del marcador también cuentan como trabajo.
function emptyWorkGate(args) {
  const { spawnSync } = require('child_process');
  const repo = path.resolve(args.repo || '.');
  const git = (a) => spawnSync('git', ['-C', repo, ...a], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return null;
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  if (status.error || status.status !== 0 || String(status.stdout).trim()) return null;
  const ahead = (ref) => {
    const r = git(['rev-list', '--count', `${ref}..HEAD`]);
    return r.error || r.status !== 0 ? null : Number(String(r.stdout).trim());
  };
  let marcador = null;
  try { marcador = readSessionMarkerStrict().marcador; } catch (_e) { marcador = null; }
  if (marcador && typeof marcador.baseSha === 'string' && marcador.baseSha) {
    const n = ahead(marcador.baseSha);
    if (n === null || n > 0) return null;
  }
  const principal = ['origin/main', 'main', 'origin/master', 'master']
    .find((ref) => { const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return !r.error && r.status === 0; });
  if (!principal) return null;
  // Parado en la propia rama principal no hay contra qué comparar: el trabajo pudo commitearse ahí antes de la corrida.
  const rama = git(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!rama.error && rama.status === 0 && String(rama.stdout).trim() === principal.replace(/^origin\//, '')) return null;
  const n = ahead(principal);
  if (n === null || n > 0) return null;
  return `🛑 La carpeta de la story no tiene ningún cambio contra ${principal}: ni commits propios ni cambios sin commitear (${repo}).\n` +
    '   Los revisores leerían la rama principal y dirían «no está el código»: la vuelta se perdería.\n' +
    '   Causa típica: algo apartó los cambios mientras tanto (un `git stash` de fondo, un checkout). Recuperalos y volvé a pedir la vuelta.\n';
}

// Lo que devuelve el freno de abajo: el tope sin nada abierto (`{ sinAbiertos }`) no frena: sale 0, sin revisores, con
// su aviso; un texto frena (sale 3).
function salidaDelFreno(r) {
  if (r && r.sinAbiertos) {
    process.stderr.write(r.sinAbiertos);
    process.stdout.write(`${JSON.stringify({ mode: 'cap-nothing-open', rerun: [], all: [], note: r.sinAbiertos.trim() }, null, 2)}\n`);
    process.exit(0);
  }
  if (r) { process.stderr.write(r); process.exit(3); }
}

/** Los revisores que el set de una vuelta puede traer: los del núcleo y los de los paquetes instalados (si cargan). */
function revisoresDelCatalogo() {
  const nombres = new Set(require('./pipeline-reviewers.js').coreReviewerNames());
  try { for (const p of require('./pipeline-advisor-set.js').paquetesInstalados()) for (const r of p.revisores) nombres.add(r.agente); } catch { /* paquete roto: quedan los del núcleo */ }
  return nombres;
}

// Las corridas abiertas en el repo (lib/open-runs.js: el último evento de cada sesión es su apertura), las de esta sesión
// también: quien llama ya sabe que el pedido no es de la corrida de su marcador. `{ lista }` o `{ error }` si el registro
// existe y no se puede leer. El repo se compara por su raíz de git (una subcarpeta es el mismo repo; una copia de trabajo
// anidada es otro); una apertura sin repo, por la raíz de git de su carpeta.
function corridasAbiertasDelRepo(repoAbs) {
  const or = require('./open-runs.js');
  const r = or.leerEventos(os.homedir());
  if (!r.ok) return r.ausente ? { lista: [] } : { error: r.error };
  const ultimo = new Map();
  for (const e of r.eventos) ultimo.set(e.sesion, e);
  const raiz = or.raizDeGit(repoAbs) || repoAbs;
  const mismo = (p) => or.dentroDe(p, raiz) && or.dentroDe(raiz, p);
  const lista = [...ultimo.values()].filter((e) => e.name === 'run-open'
    && (typeof e.repo === 'string' ? mismo(or.raizDeGit(e.repo) || e.repo)
      : typeof e.runDir === 'string' && mismo(or.raizDeGit(e.runDir) || e.runDir)));
  return { lista };
}

// La hora (ms) en que se escribió un archivo, o null.
function horaDe(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// ¿Desde `desde` (ms) se lanzó algún revisor en esta sesión o cambió algún archivo de la corrida? Sin hora, no.
function movidaDesde(desde, marcador) {
  if (!desde) return false;
  if (Object.values((marcador && marcador.filesTouchedAt) || {}).some((v) => v && Number(v.ts) > desde)) return true;
  let lineas = [];
  try { lineas = fs.readFileSync(sessionLogPath(), 'utf8').split('\n'); } catch { return false; }
  // revisor = del set (núcleo y paquetes) y no de otra etapa: lo mismo que cuenta el gancho de lanzamientos
  const { esRevisor } = require('./late-snapshot.js');
  const catalogo = revisoresDelCatalogo();
  const parsed = lineas.map((l) => { if (!l.trim()) return null; try { return JSON.parse(l); } catch { return null; } });
  // sólo lo anotado después del último pedido de vuelta (su `step5-start`): lo de antes es de vueltas anteriores, aunque
  // su hora diga otra cosa
  let desdeIdx = 0;
  for (let i = parsed.length - 1; i >= 0; i -= 1) if (parsed[i] && parsed[i].event === 'step5-start') { desdeIdx = i + 1; break; }
  return parsed.slice(desdeIdx).some((d) => d && esRevisor(d.advisor) && catalogo.has(d.advisor) && Date.parse(d.ts) > desde);
}

// El freno de la tercera vuelta de `smart-reloop` y `advisors`: null si puede seguir, o el mensaje llano de por qué no.
// Si sigue, anota la vuelta servida en la carpeta de la corrida (rethink/served.json). La corrida se busca como en el
// resto del pipeline (`resolveRunDir`); sin story o sin carpeta no hay nota posible. Ante la duda, frena.
// `vueltaChica`: el re-loop ya calculó que desde la última vuelta sólo cambiaron textos. Esa vuelta pasa el tope sin firma
// y no pide la nota de repensar: no es un arreglo que se repite. `sinCodigo`: la vuelta no trae código ni revisores que
// lanzar; se cierra sola, sin tope, sin firma y sin nota.
function rethinkGate(args, { vueltaChica = false, sinCodigo = false } = {}) {
  const rt = require('./rethink.js');
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
  const propia = storyId ? resolveRunDir(repoAbs, storyId, false, storyAbs, { marker: marcador || null }) : null;
  // El freno es de las corridas del pipeline: hay corrida si el marcador trae story, o si --story resuelve una carpeta de
  // corrida. Fuera de una corrida no hay vueltas que contar: --iter ausente, 1 o 2 pasa como siempre; desde la tercera (la que pide nota) frena.
  const marcadorConStory = !!(marcador && typeof marcador.storyPath === 'string' && marcador.storyPath);
  // ¿El pedido es de la corrida del marcador de esta sesión (el mismo repo, por su raíz de git, y la misma historia)?
  const orLib = require('./open-runs.js');
  const raizDe = (p) => orLib.raizDeGit(p) || path.resolve(p);
  const mismaRaiz = (a, b) => orLib.dentroDe(raizDe(a), raizDe(b)) && orLib.dentroDe(raizDe(b), raizDe(a));
  const storyDelMarcador = marcadorConStory
    ? deriveStoryId(path.isAbsolute(marcador.storyPath) ? marcador.storyPath : path.join(path.resolve(marcador.repoPath || repoAbs), marcador.storyPath))
    : null;
  const deEstaCorrida = marcadorConStory && mismaRaiz(marcador.repoPath || repoAbs, repoAbs)
    && (!storyId || String(storyId) === String(storyDelMarcador));
  // Fuera de la corrida de su marcador, el pedido no usa la cuenta de vueltas de ninguna: si el repo tiene una corrida
  // abierta, la vuelta se pide desde la sesión de esa corrida y con su historia. Si no, otra sesión (con o sin marcador
  // propio), la variable de sesión cambiada en el comando o una copia de la historia con otro número sacaban el set de
  // una corrida al tope.
  if (!deEstaCorrida) {
    const abiertas = corridasAbiertasDelRepo(repoAbs);
    if (abiertas.error) {
      return `🛑 No pude leer el registro de corridas abiertas (${abiertas.error}): sin él no sé si ${repoAbs} tiene una corrida abierta, y ante la duda no devuelvo el set.\n`;
    }
    const yo = resolveSessionId();
    const propias = abiertas.lista.filter((e) => e.sesion === yo);
    if (propias.length) {
      // la corrida de esta sesión en el repo es de otra historia que la pedida (una copia con otro número, otra ruta)
      return `🛑 Esta sesión tiene una corrida abierta en ${repoAbs} (story ${propias.map((e) => e.story).join(', ')}) y el pedido es de otra historia: las vueltas de revisores se piden con la historia de la corrida, que es la que las cuenta.\n`;
    }
    if (abiertas.lista.length) {
      const nombradas = abiertas.lista.map((e) => `sesión ${e.sesion}, story ${e.story}`).join('; ');
      return `🛑 ${repoAbs} tiene una corrida abierta de otra sesión (${nombradas}) y esta sesión no tiene el marcador de esa corrida: sus vueltas de revisores las cuenta su marcador, y desde acá no se ven. Pedilo desde la sesión de la corrida.\n`;
    }
  }
  if (!marcadorConStory && !propia) {
    // el tope vale también fuera de una corrida (con tope 1, la vuelta 2 no pasa)
    const iterSin = Math.max(Number.isInteger(declarada) ? declarada : 0, delMarcador);
    if (iterSin < rt.FIRST_ITER) {
      const bloqueo = topeDeVueltas({ args, iter: iterSin, rr: require('./review-rounds.js'), marcador, runDir: null, repoAbs, storyId });
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
  // la copia de fuera del repo: borrar o achicar served.json no baja la cuenta
  const espejo = rt.readServedMirror({ stateDir: stateDirOf(os.homedir()), runDir });
  if (!espejo.ok) {
    return `🛑 El registro de vueltas servidas de la carpeta de estado (gates.log) existe y no se puede leer: ${espejo.reason}. Sin él no sé cuántas vueltas de revisores lleva la corrida, y ante la duda no devuelvo el set.\n`;
  }
  const ultima = Math.max(servidas.last, espejo.last);
  const pedida = Math.max(Number.isInteger(declarada) ? declarada : 0, delMarcador);
  // Una vuelta es un número de iteración que llegó a lanzar revisores (la foto que el arnés toma al lanzar el último).
  // Pedir de nuevo el set de la última vuelta servida, sin que se haya lanzado, es la MISMA vuelta; con sus revisores
  // lanzados, pedirla otra vez es una vuelta nueva: max(declarada, marcador, última servida + 1). También es nueva si desde
  // que se sirvió se lanzó algún revisor o cambió algún archivo: si no, dejar un revisor sin lanzar repetía la vuelta con
  // arreglos en el medio. Sin el marcador de esta corrida no hay fotos que mirar (las de otra historia no cuentan): ahí cada
  // pedido es una vuelta nueva, para que repetir no esquive la nota.
  const rr = require('./review-rounds.js');
  const servidaEn = espejo.last === ultima && espejo.ts ? espejo.ts : (runDir ? horaDe(rt.servedPath(runDir)) : null);
  const ultimaLanzada = ultima > 0 && (!deEstaCorrida || rr.lanzada(marcador, ultima) || movidaDesde(servidaEn, marcador));
  const iter = ultima > 0 ? Math.max(pedida, ultimaLanzada ? ultima + 1 : ultima) : pedida;
  // El tope de vueltas: más allá, sólo una vuelta extra que autorizó una persona.
  const bloqueoDelTope = topeDeVueltas({ args, iter, rr, marcador, runDir, repoAbs, storyId, vueltaChica, sinCodigo });
  if (bloqueoDelTope) return bloqueoDelTope;
  if (iter >= rt.FIRST_ITER && !vueltaChica && !sinCodigo) {
    const dice = [];
    if (iter !== declarada) {
      dice.push(`Pediste la vuelta ${args.iter === undefined ? '(sin --iter)' : declarada}, pero ${iter === pedida
        ? `el marcador de la sesión lleva ${iter - 1} vuelta(s) cerrada(s)`
        : `ya se sirvió la vuelta ${ultima} en esta corrida`}: vale la mayor, la ${iter}.`);
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
  const donde = runDir || (storyId && !ajena ? resolveRunDir(repoAbs, storyId, true, storyAbs, { marker: marcador || null }) : null);
  if (donde) {
    const anotada = rt.recordServed(donde, iter);
    if (!anotada.ok) return `🛑 No pude anotar la vuelta ${iter} en la carpeta de la corrida (${rt.servedPath(donde)}): ${anotada.reason}. Sin ese registro la próxima vuelta no se puede contar, y ante la duda no devuelvo el set.\n`;
    const copia = rt.recordServedMirror({ stateDir: stateDirOf(os.homedir()), runDir: donde, iter, story: storyId, sessionId: resolveSessionId() || null });
    if (!copia.ok) return `🛑 No pude anotar la vuelta ${iter} en el gates.log de la carpeta de estado: ${copia.reason}. Sin esa copia, borrar served.json bajaría la cuenta, y ante la duda no devuelvo el set.\n`;
  } else {
    // Sin carpeta de corrida no hay dónde contar las vueltas: un `--iter 1` repetido podría ser la tercera. Ante la duda,
    // no se devuelve el set.
    return `🛑 No hay carpeta de corrida donde contar las vueltas (la story no da una clave de corrida${storyId ? `: «${storyId}»` : ''}). Sin ella no se puede saber si ésta es la tercera vuelta, y ante la duda no devuelvo el set. Corré pipeline.js run-dir --story <spec> --repo <repo> --create, o arreglá el número de la story.\n`;
  }
  return null;
}

module.exports = { fotoAlLanzar, topeDeVueltas, revisoresDelCatalogo, aplicarModelosDeRevisores, tierDe, buildStoryDigest, buildAdvisorContext, validateFilesExist, reloopHintsFor, emptyWorkGate, salidaDelFreno, rethinkGate, PRECHEQUEO, congelarVuelta, contextoConLaCopia, resumenReglas, reglasRevisores, conLanzadorCodex, logStep5Start };
