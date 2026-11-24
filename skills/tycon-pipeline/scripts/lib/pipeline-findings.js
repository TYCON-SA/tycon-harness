/**
 * pipeline-findings.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: los hallazgos de los revisores y del pase: escribirlos, verificarlos, refutarlos, su estado y lo diferido.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, deriveStoryId, exists, fs, leerMarcadorDeLaCorrida, logGate, os, path, readSessionMarker, readText, resolveRunDir, runDirKey, stateDirOf } = require('./pipeline-shared.js');

// ── Review Follow-ups persistidos EN la story ────────
// La mejor idea de bmad-dev-story: el ciclo dev↔review vive DENTRO del artefacto
// (su sección "Review Follow-ups (AI)" con checkboxes por severidad) y sobrevive
// sesiones. Sin esto los findings viven solo en .advisors/pipeline-runs/ — si el
// pipeline muere después del paso de hallazgos con un CRITICAL waived o WARNINGs abiertos, la próxima
// sesión no tiene lista accionable en la story (hay que arqueologizar el audit trail).
// El paso de hallazgos escribe los no-resueltos acá (write-followups); el Arranque y «Validar la historia» los detectan al
// retomar (followups-status). Solo toca el BODY de la story — NUNCA el frontmatter
// contractual (esa transición sigue siendo exclusiva del orquestador vía marker.js).
const FOLLOWUPS_HEADING = '## Review Follow-ups (Advisors)';
// Normaliza un finding a la forma canónica del writer, tolerando tanto el shape del
// findings.json del paso de hallazgos ({rule_id, severity, advisor, file, disposition, reason})
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
// El texto de un item ya escrito (lo que sigue a la ubicación), para distinguir dos hallazgos de la misma regla y archivo.
function followupSummary(raw) {
  const m = String(raw).match(/^- \[[ xX]\]\s\*\*\[[^\]]*\]\*\*\s.*? — .*? — (.*?)\s*<!--\s*fkey:/);
  return m ? m[1].trim() : '';
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
  const { acSectionOf, parsePipelinesBlock } = require('./story-checks.js');
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
  const { resolver } = require('./coverage-base.js');
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
    const t = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const top = t.error || t.status !== 0 ? null : t.stdout.trim();
    const git = (argv) => spawnSync('git', ['-C', top || repo, '-c', 'core.quotePath=false', ...argv], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
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

/**
 * ¿Quedan deudas abiertas de la story? En «Cerrar la historia» evita relanzar dos revisores con modelo para
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
  const { parsePipelinesBlock } = require('./story-checks.js');
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
  // Un hallazgo es la regla, el archivo y su texto: en una story de varias tandas la misma regla sobre el mismo archivo
  // aparece una vez por tanda, con otro texto. La clave `regla|archivo` sola los juntaba y borraba los de las tandas
  // anteriores.
  const ident = (key, summary) => `${key}\u0000${summary || ''}`;
  const prevChecked = new Map();
  if (parsed) for (const it of parsed.items) prevChecked.set(ident(it.key, followupSummary(it.raw)), it.checked);

  const seen = new Set();
  const newKeys = new Set();
  const merged = [];
  for (const raw of findings) {
    const f = normalizeFinding(raw);
    const k = `${f.ruleId}|${f.file || '?'}`;
    const id = ident(k, f.summary);
    if (seen.has(id)) continue;
    seen.add(id);
    newKeys.add(k);
    // Preservar el checkbox previo del mismo hallazgo (idempotente en re-loops); resolved lo fuerza a [x].
    const checked = f.resolved ? true : (prevChecked.has(id) ? prevChecked.get(id) : false);
    merged.push(renderFollowupItem(f, checked));
  }
  // Conservar TODOS los items previos que no vienen en el nuevo set — resueltos [x] (historial)
  // Y abiertos [ ] (deuda viva). Conservar SOLO los
  // `it.checked` haría que un follow-up ABIERTO que el advisor deja de reportar (típico de un item
  // deferred/gated como TEST-W4a, que el advisor no re-flaggea) se dropeara SILENCIOSAMENTE →
  // deuda técnica trackeada borrada sin rastro. Un item sale de [ ] SOLO explícitamente: viene en
  // un findings posterior con resolved:true (→ [x]), o un humano lo marca [x] a mano. Nunca por omisión.
  // Con la misma regla y archivo en el nuevo set: el abierto lo reemplaza el reporte de ahora (es la misma deuda,
  // con su texto al día); el resuelto con otro texto queda, porque es el historial de otra tanda o corrida.
  if (parsed) {
    for (const it of parsed.items) {
      const id = ident(it.key, followupSummary(it.raw));
      if (seen.has(id)) continue;
      if (newKeys.has(it.key) && !it.checked) continue;
      merged.push(it.raw);
      seen.add(id);
    }
  }
  if (!merged.length && !parsed) {
    return { wrote: false, note: 'Sin findings y sin sección previa — no se escribió nada.' };
  }
  const banner = '<!-- tycon-pipeline: generado por el paso de hallazgos. Cada item = finding advisor no resuelto (CRITICAL waived o WARNING). Al resolver el finding en el código, marcá [x]. El Arranque y «Validar la historia» detectan los abiertos al retomar (pipeline.js followups-status). -->';
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

// ── findings.json del paso de hallazgos — write determinista + gate de existencia ──────
// El findings.json ({rule_id, severity, advisor, file, disposition, reason}) es el insumo
// machine-parseable del retrospective-capturer (advisor_warnings_per_story / actioned_ratio,
// determinista sin LLM). Como WRITE MANUAL del orquestador en el paso de hallazgos se olvidaría y rompería el conteo.
// `write-findings` lo
// vuelve una llamada de script validada + ubicada sola; `findings-status` lo enforcea como
// pre-condición mecánica de «Preparar el commit» (exit 3 si falta → el orquestador lo escribe antes del commit).
const VALID_SEVERITY = new Set(['CRITICAL', 'WARNING']);
// 'refuted': hallazgo reportado,
// investigado y RETIRADO por falso (típicamente por el propio advisor). No es 'fixed' (no hubo
// arreglo) ni 'open' (no queda deuda). Exige reason con la refutación — sin reason degrada a
// 'open' con warning, porque un "es falso" sin evidencia es indistinguible de un "no lo miré".
const VALID_DISPOSITION = new Set(['fixed', 'waived', 'deferred', 'open', 'refuted']);
const DISPOSITION_ALIAS = { 'false-positive': 'refuted', 'false_positive': 'refuted', 'falso-positivo': 'refuted', 'falso positivo': 'refuted', 'refutado': 'refuted' };

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
  const rlib = require('./review-roster.js');
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
  const lib = require('./refutation.js');
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
  // Un confirmado del pase trae la gravedad del verificador (`adjusted_severity`, o `severity` en su escala): frena
  // (CRITICAL) si está en el corte de la organización o por encima, y si no es WARNING. La misma regla que la revisión del plan.
  const delPase = String(raw.adjusted_severity || (/^(bug|robustness|nit)$/i.test(String(raw.severity || '')) ? raw.severity : '')).toLowerCase().trim();
  if (delPase) severity = require('./review-policy.js').blocks(delPase, (ctx && ctx.corte) || 'bug') ? 'CRITICAL' : 'WARNING';
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
    const v = require('./review-roster.js').firmantesValidos(ctx.roster);
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

// write-findings: escribe (validado) el findings.json del paso de hallazgos en el run dir. Input via --findings
// (archivo JSON o '-' = stdin). Tolera el shape {ruleId|rule} y normaliza severity/disposition.
// ── La constancia de los revisores viaja al repo de la STORY ────────────────
// El run dir (`.advisors/pipeline-runs/<story>-<sello>/`) nace en el repo donde CORRE el pipeline
// —el del código—, y es pesado (reportes de cada advisor). Pero el portón de CI exige, para pasar
// una story a `done`, que en el repo de la STORY exista ese run dir con `review-roster.json`
// coherente con `findings.json`, y que el registro de aprobaciones traiga el plan. Cuando son dos repos distintos, se
// proyectan SÓLO esos tres archivos al repo de la story, con el mismo nombre de corrida. El registro no se copia
// encima: se le suman las líneas que le faltan (lib/approvals.js → unir). Mismo repo → no hace nada.
// Nunca rompe a quien lo llama: es evidencia, y una copia que falla se DICE (`warning`).
function projectRunToStoryRepo(runDir, storyPath) {
  if (!runDir || !storyPath) return { projected: false, reason: 'sin run dir o sin story' };
  const ec = require('./evidence-config.js');
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
    const approvals = require('./approvals.js');
    if (fs.existsSync(path.join(runDir, approvals.FILE))) {
      approvals.unir(runDir, dest);
      copied.push(approvals.FILE);
    }
  } catch (e) {
    return { projected: false, dest, copied, reason: `no se pudo copiar: ${e.message}` };
  }
  return { projected: copied.length > 0, dest, copied };
}

// ── El cierre mira las aprobaciones donde las mira el portón ────────────────
// Antes de «Preparar el commit»: proyecta la corrida abierta y revisa, en el repo de la STORY, cada carpeta de corrida
// de la story con la regla del portón (lib/approvals.js → problemasDelRegistro, su primer problema, y la exención de
// `advisors_exempt`). Una carpeta a la que le falta algo y tiene su par con el mismo nombre en el repo del código se
// vuelve a proyectar y se vuelve a mirar: así se ponen al día las corridas que anotaron sólo en el repo del código. Con
// la maqueta aprobada, la corrida abierta trae además su línea, también con un solo repo. Las carpetas son las que mira
// el portón (`carpetasDeCorrida`: la raíz y las subcarpetas de primer nivel).
// Devuelve { medido, motivo?, storyRepo, mismo, proyecciones, faltas: [{ corrida, dir, regla, detalle, abierta }] }.
function aprobacionesEnElRepoDeLaStory({ runDir, storyPath, storyId, codeRepo, maquetaAprobada, ref = 'origin/main' }) {
  const ec = require('./evidence-config.js');
  const approvals = require('./approvals.js');
  const storyRepo = storyPath ? ec.discoverRepoRoot(storyPath) : null;
  if (!storyRepo) return { medido: false, motivo: storyPath ? 'la story no está en un repo git' : 'sin ruta de la story', faltas: [] };
  const runRepo = (runDir && ec.discoverRepoRoot(runDir)) || codeRepo || null;
  const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; } };
  const mismo = !!runRepo && same(storyRepo, runRepo);
  const proyecciones = [];
  const proyectar = (dir) => {
    const r = projectRunToStoryRepo(dir, storyPath);
    proyecciones.push({ corrida: path.basename(dir), ...r });
    return r;
  };
  if (runDir && !mismo) proyectar(runDir);
  const { key } = runDirKey(storyId, storyPath);
  if (!key) return { medido: false, motivo: 'no pude calcular la clave de la corrida', storyRepo, mismo, proyecciones, faltas: [] };
  // Las mismas carpetas que mira el portón (raíz y subcarpetas de primer nivel, mismo filtro). Una que existe y no se
  // lista es «no lo pude mirar»: lanza.
  const carpetas = approvals.carpetasDeCorrida(storyRepo, key, { estricto: true });
  const abierta = runDir ? path.basename(runDir) : null;
  // La corrida abierta en el repo de la story: con dos repos, la que lleva su nombre; con uno, la misma carpeta.
  const esLaAbierta = (c) => !!abierta && (mismo ? same(c.dir, runDir) : c.nombre === abierta);
  const hayAbierta = carpetas.some(esLaAbierta);
  // El par de una corrida vieja: la carpeta del mismo nombre en el repo del código, con la misma lista.
  const delCodigo = [];
  if (!mismo) {
    for (const r of [...new Set([runRepo, codeRepo].filter(Boolean))]) {
      try { delCodigo.push(...approvals.carpetasDeCorrida(r, key)); } catch (_e) { /* sin par: lo dice la falta */ }
    }
  }
  const exenta = (() => {
    try { return /^advisors_exempt:\s*true\b/m.test((fs.readFileSync(storyPath, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''); } catch { return false; }
  })();
  const juzgar = (dir, abiertaAca) => {
    let roster = null;
    const rosterPath = path.join(dir, 'review-roster.json');
    if (fs.existsSync(rosterPath)) {
      // Un roster que no se lee no dice si la corrida anota aprobaciones: no se toma por «sin declarar».
      try { roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8')); } catch (e) {
        return [{ regla: 'review-roster-ilegible', detalle: `review-roster.json no se puede leer (${String(e.message || e).slice(0, 120)})` }];
      }
    }
    const registro = approvals.leer(dir);
    // `advisors_exempt` perdona que falte el registro o el plan, como en el portón; un registro malo frena igual.
    const anterior = approvals.anteriorAlControl(dir, path.basename(dir), ref);
    const p = approvals.problemasDelRegistro({ registro, roster, anterior }).filter((x) => !(exenta && approvals.POR_FALTA.has(x.regla))).slice(0, 1);
    if (maquetaAprobada && abiertaAca && !p.length) {
      const m = approvals.faltaLaMaqueta(registro);
      if (m) p.push(m);
    }
    return p;
  };
  const faltas = [];
  for (const c of carpetas) {
    const aca = esLaAbierta(c);
    let p = juzgar(c.dir, aca);
    const par = p.length && !mismo ? delCodigo.find((d) => d.nombre === c.nombre) : null;
    if (par) {
      proyectar(par.dir);
      p = juzgar(c.dir, aca);
    }
    for (const x of p) faltas.push({ corrida: c.nombre, dir: c.dir, regla: x.regla, detalle: x.detalle, abierta: aca });
  }
  // Una copia que falló deja el repo de la story atrasado aunque lo que hay ahí parezca completo.
  for (const pr of proyecciones) {
    if (!pr.projected && pr.reason && pr.reason !== 'mismo repo' && !faltas.some((f) => f.corrida === pr.corrida && f.regla === 'proyeccion-fallida')) {
      faltas.push({ corrida: pr.corrida, dir: pr.dest || null, regla: 'proyeccion-fallida', detalle: pr.reason, abierta: pr.corrida === abierta });
    }
  }
  if (maquetaAprobada && !hayAbierta && !faltas.some((f) => f.corrida === abierta)) {
    faltas.push({ corrida: abierta || '(sin carpeta de la corrida)', dir: null, regla: 'sin-aprobacion-de-la-maqueta',
      detalle: 'la maqueta se aprobó y la corrida no está en el repo de la story', abierta: true });
  }
  return { medido: true, storyRepo, mismo, proyecciones, faltas };
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
  // Sin una corrida abierta de esta story en la sesión, la carpeta que da la regla es la de OTRA corrida: su
  // findings.json no se reemplaza sin nombrarla a propósito (`--run-dir`).
  if (!args.runDir) {
    const propio = readSessionMarker();
    if (!propio || String(propio.storyId) !== String(storyId)) {
      const ya = resolveRunDir(args.repo, storyId, false, args.story, { marker: null });
      if (ya && exists(path.join(ya, 'findings.json'))) {
        return { error: `sin una corrida abierta de la story ${storyId} en esta sesión no reemplazo ${path.join(ya, 'findings.json')}: `
          + `es la constancia de otra corrida. Si es la que querés reemplazar, nombrala a propósito con --run-dir ${ya}.` };
      }
    }
  }
  const runDir = args.runDir || resolveRunDir(args.repo, storyId, true, args.story);
  if (!runDir) return { error: 'no se pudo resolver/crear el run dir bajo .advisors/pipeline-runs/ (si el número de la story se repite en su repo, la carpeta lleva la clave: `pipeline.js evidence-key --story <ruta>` dice por qué no se pudo calcular)' };
  fs.mkdirSync(runDir, { recursive: true });
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
  // el corte de gravedad de la organización para los confirmados del pase (review.blocking_severity)
  let corte = 'bug';
  try { corte = require('./plan-review.js').configDeLaOrganizacion().values.review.blocking_severity; } catch (e) {
    corte = 'bug';
    normWarnings.push(`no pude leer review.blocking_severity de la organización (${String((e && e.message) || e).split('\n')[0]}): uso el corte de fábrica, bug`);
  }
  const records = arr.map((r) => normalizeFindingRecord(r, normWarnings, { roster, errores, runDir, corte }));
  if (errores.length) {
    return { error: errores.join('\n'), firmantes_invalidos: errores.length, run_dir: runDir,
      note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
  }
  // Un crítico lo decide una persona: un CRITICAL `waived` necesita la constancia del ok
  // (`marker.js waive-critical`). El agente solo no se exime, se firme como se firme.
  {
    const cw = require('./critical-waivers.js');
    const rev = cw.revisar(records, runDir, { reverificar: true, story: storyId });
    const faltan = rev.faltan;
    if (faltan.length) {
      const marker = path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js');
      const lineas = [`Un crítico lo decide una persona: ${faltan.length} CRITICAL marcado(s) como waived sin el ok de una persona:`];
      lineas.push(...cw.renglonesDeFaltantes(rev));
      lineas.push('Arreglalo, o que el dev lo exima antes de escribir los hallazgos. Los caminos:');
      for (const f of cw.agrupar(faltan)) lineas.push(...cw.caminos({ marker, ruleId: f.rule_id, file: f.file || '<archivo>' }));
      return { error: lineas.join('\n'), criticos_sin_ok: faltan, run_dir: runDir,
        note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
    }
  }
  // Los críticos que reportó cada revisor los anotó el arnés (lib/reported-criticals.js): findings.json tiene que traerlos
  // a todos, por regla y cantidad, y lo que da por cerrado tiene que tener con qué. Acá los `refuted` ya pasaron por la
  // constancia del verificador (normalizeFindingRecord los deja `open` sin ella). Una corrida sin registro lo dice en su
  // propio campo: no es un aviso sobre los hallazgos.
  let reportedNote = null;
  {
    const rcLib = require('./reported-criticals.js');
    const marcador = readSessionMarker();
    const deEsta = marcador && String(marcador.storyId) === String(storyId) ? marcador : null;
    const since = deEsta ? deEsta.startedAt : null;
    // sólo lo de esta corrida: lo que anotó otra sesión sobre la misma historia no se pide acá
    const cruce = rcLib.checkRun({ stateDir: stateDirOf(os.homedir()), story: storyId, since, ...rcLib.corridaDelMarcador(deEsta, runDir), findings: records, runDir });
    if (cruce.error) {
      return { error: `no pude leer el registro de críticos reportados (${cruce.error}): no sé qué reportaron los revisores, y eso no es «nada»`,
        run_dir: runDir, note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
    }
    if (cruce.problemas.length) {
      const lineas = ['findings.json no trae lo que reportaron los revisores:', ...rcLib.renglones(cruce, { marker: path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js') })];
      return { error: lineas.join('\n'), criticos_reportados: cruce.problemas, run_dir: runDir,
        note: 'No se escribió nada: el findings.json se escribe entero o no se escribe.' };
    }
    if (cruce.sinRegistro) reportedNote = rcLib.NO_REGISTRY_NOTE;
    if (cruce.unreadable) normWarnings.push(`el registro de críticos reportados tiene ${cruce.unreadable} renglón(es) ilegible(s): no cuentan`);
    if (cruce.unreadableSpawns) normWarnings.push(`el registro de lanzamientos de revisores tiene ${cruce.unreadableSpawns} renglón(es) ilegible(s): esas salidas no se cruzaron`);
  }
  const outPath = path.join(runDir, 'findings.json');
  fs.writeFileSync(outPath, JSON.stringify(records, null, 2) + '\n', 'utf8');
  // Story en otro repo → el portón de CI de ESE repo va a pedir esta constancia.
  const proyeccion = projectRunToStoryRepo(runDir, args.story);
  // La tasa de falsas alarmas por revisor (últimas 20 corridas del repo): sólo cuentan los «falsos» que un verificador
  // confirmó. Marcar no apaga a nadie; lo decide una persona.
  const tasas = require('./refutation.js').reviewerRates(path.dirname(runDir));
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
  const rt = require('./rethink.js');
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
    ...(reportedNote ? { reported_criticals: reportedNote } : {}),
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
  const id = require('./refutation.js').identity({ reviewer: String(x.reviewer || x.advisor || ''), rule: String(x.rule || x.rule_id || ''), file: String(x.file || '') });
  return { reviewer: id.reviewer, rule: id.rule,
    file: String(x.file || '').trim(), line: x.line, summary: String(x.summary || x.reason || '').trim(),
    author_reason: String(x.author_reason || x.reason || '').trim() };
}

function workflowRequest(finding, model, repo) {
  const source = readText(path.join(estadoPipeline.SCRIPTS_DIR, 'adversarial-verify.workflow.js')).replace(/^export const meta =/m, 'const meta =');
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
  const id = require('./refutation.js').idOf(finding);
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
  const ledger = require('./advisor-ledger.js');
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
  const lib = require('./refutation.js');
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

// findings-status: pre-condición mecánica de «Preparar el commit». ¿El run tiene findings.json válido?
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
      note: `⚠️ No hay run dir bajo .advisors/pipeline-runs/ para ${storyId}. Escribí el findings.json del paso de hallazgos: pipeline.js write-findings --story ${args.story} --findings <array.json|->.` };
  }
  const p = path.join(runDir, 'findings.json');
  if (!exists(p)) {
    return { exists: false, valid: false, story_id: storyId, run_dir: runDir, path: p,
      note: `🛑 findings.json FALTA en ${runDir}. Escribilo antes del commit (paso de hallazgos): pipeline.js write-findings --story ${args.story} --findings <array.json|->. Es el insumo del retrospective-capturer (advisor_warnings_per_story) — sin él el conteo degrada a reconstrucción manual (BUG-PIPELINE-006).` };
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
  const { rules, problems } = require('./stack-config.js').orgRules(opts);
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

function cmdReadabilityBrief(cmd, args) {
  // El pedido para el lector de legibilidad del paso «Probar en vivo»: la guía del tester (por defecto) o los textos
  // de la pantalla (`--scope ui`). El idioma sale de la regla ui_language de la organización; sin ella, no se juzga.
  if (args.scope !== undefined && args.scope !== 'ui') { process.stderr.write(`--scope sólo acepta «ui» (vino «${args.scope}»)\n`); process.exit(2); }
  const brief = readabilityBrief({ scope: args.scope === 'ui' ? 'ui' : 'guide' });
  for (const p of brief.problems) process.stderr.write(`⚠️  ${p}\n`);
  process.stdout.write(brief.text + '\n');
  process.exit(0);
}


// ── Review Follow-ups persistidos en la story ────────
// write-followups: el paso de hallazgos escribe los findings no resueltos como sección checkbox.
// followups-status: el Arranque y «Validar la historia» detectan los abiertos al retomar.
function cmdWriteFollowups(cmd, args) {
  const result = writeFollowups(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : 0);
}

// ── findings.json del paso de hallazgos ─────────────────────────────────
// write-findings: escribe el artefacto machine-parseable (paso de hallazgos). findings-status:
// pre-condición de «Preparar el commit» — exit 3 si falta (para que el orquestador lo escriba).
function cmdWriteFindings(cmd, args) {
  const result = writeFindings(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : 0);
}

function cmdVerifyFinding(cmd, args) {
  verifyFinding(args).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.error ? 1 : 0);
  }, (e) => { process.stderr.write(`verify-finding: ${e.message}\n`); process.exit(1); });
  return;
}

function cmdRecordRefutation(cmd, args) {
  const result = recordRefutation(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : 0);
}

function cmdFindingsStatus(cmd, args) {
  const result = computeFindingsStatus(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : (result.exists && result.valid ? 0 : 3));
}

// ── Los helpers mecánicos del cierre recortado ──────────────────────────────
// Uso: pipeline.js dod-checker-needed --story <spec> --repo <repo> [--base <ref>]   exit 0 = invocar · 3 = no
function cmdDodCheckerNeeded(cmd, args) {
  let r;
  try { r = computeDodCheckerNeeded(args); } catch (e) { r = { invoca: true, motivos: [`el helper falló (${e.message}): se invoca`], preguntas: {} }; }
  logGate({ name: 'dod-checker-decision', repoPath: args.repo ? path.resolve(args.repo) : null, storyId: r.story_id || null, invoca: r.invoca, motivos: r.motivos });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.invoca ? 0 : 3);
}

// Uso: pipeline.js deferrals-open --story <spec> --repo <repo>   exit 0 = sin deuda · 3 = con deuda (lista) · 1 = no pude mirar
function cmdDeferralsOpen(cmd, args) {
  let r;
  try { r = computeDeferralsOpen(args); } catch (e) { r = { error: `el helper falló (${e.message}): no se puede afirmar que no haya deuda` }; }
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.error ? 1 : (r.open ? 3 : 0));
}

// Uso: pipeline.js qa-readability --story <spec> --repo <repo> --marks <n> [--scope ui]   deja la marca de la capa 4
// de la guía de QA (la marca se graba como `qa-legibilidad` en gates.log: la lee qa-guide.js --check).
// Con `--scope ui`, la de la revisión de la PANTALLA (`qa-legibilidad-ui`).
function cmdQaReadability(cmd, args) {
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

function cmdFollowupsStatus(cmd, args) {
  const result = computeFollowupsStatus(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.error ? 1 : (result.open > 0 ? 3 : 0));
}

module.exports = { cmdWriteFollowups, cmdWriteFindings, cmdVerifyFinding, cmdRecordRefutation, cmdFindingsStatus, cmdFollowupsStatus, cmdDeferralsOpen, cmdDodCheckerNeeded, cmdQaReadability, cmdReadabilityBrief, projectRunToStoryRepo, aprobacionesEnElRepoDeLaStory, writeFollowups, computeFollowupsStatus, parseFollowupsSection, followupKey, writeFindings, computeFindingsStatus, normalizeFindingRecord, computeDodCheckerNeeded, computeDeferralsOpen };
