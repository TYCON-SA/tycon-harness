#!/usr/bin/env node
/**
 * instinct-observer.js — observador batch nightly.
 *
 * Lee las observations del JSONL del mes corriente + el anterior, agrupa por
 * proyecto, busca patterns repetidos (>=3 apariciones), y le pide a Haiku
 * (via el CLI de la herramienta que la máquina tenga — `claude`→Haiku, `codex`→gpt-5.4-mini,
 * o `ollama`→modelo local; usando la suscripción del dev, sin API key separada)
 * que proponga "instincts" — atomic rules accionables.
 *
 * Output: archivos YAML en `pending/<YYYYMMDD>-<slug>.yaml` del lugar donde se escribe: `inbox/instincts/` del
 * árbol si el árbol trae su buzón (el clon de mantenedor); si no, la casa de la persona. Dónde es cada lugar lo
 * sabe instinct-dirs.js: este guion nunca arma la ruta ni crea una carpeta antes de escribir en ella.
 *
 * Threshold:
 *   - >=3 apariciones en cualquier proyecto
 *   - Confidence sugerida por el LLM >=0.85 para considerar promote-ready
 *
 * Uso:
 *   node scripts/instincts/instinct-observer.js [--dry-run] [--since YYYY-MM]
 *
 * Flags:
 *   --dry-run    No escribe pending/, solo muestra qué hubiera generado
 *   --since      Mes desde el que leer (default: actual + anterior)
 *   --notify     Después de generar, dispara Telegram notify (solo si TYCON_INSTINCT_NOTIFY=1)
 *
 * Diseño:
 *   - Idempotente: cada instinct tiene un hash determinístico de su trigger.
 *     Si ya existe en pending/ o promoted/ → skip.
 *   - Fail-safe: si NINGÚN ejecutor está disponible, exit 0 limpio (corre detached; el instalador
 *     avisa aparte si el mining quedó registrado pero apagado). NO crashes.
 *   - Logging: stderr para diagnostics, stdout solo para output estructurado.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ============================================================
// Config
// ============================================================
// Este guion vive en scripts/instincts/: la raíz del arnés está dos niveles arriba.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Observations son LOCALES por máquina (no van al repo).
// Setup 50/50 multi-máquina: cada máquina analiza su propio JSONL.
const OBS_DIR = process.env.TYCON_INSTINCT_OBS_DIR || path.join(os.homedir(), '.claude', 'tycon-observations');
// Pending/promoted/archived/drafts viven en el buzón: `inbox/instincts/` del árbol si el árbol lo trae (ahí cruzan
// máquinas vía git), o la casa de la persona si no (un arnés instalado, la copia pública). `descartados/` es lo que la
// revisión descartó por repetir algo que ya existe: constancia local para quien revisa en esta máquina.
// Dónde es cada lugar lo contesta instinct-dirs.js, y se le pregunta AL USAR, nunca al cargar este archivo: quien sólo
// lo requiere (las pruebas, instinct-promote) no resuelve ni crea nada. Se ESCRIBE en un lugar; se LEE en todos.
const DIRS = require('./instinct-dirs.js');
const dondeEscribir = (sub) => path.join(DIRS.writePlace(), sub);
/** La carpeta `sub` de cada lugar de lectura (el de escritura primero). Sin poder resolverlos, ninguna: lo dice `main`. */
function dondeLeer(sub) {
  try { return DIRS.readPlaces().map((p) => path.join(p, sub)); } catch (e) { if (e && e.name === 'InstinctDirsError') return []; throw e; }
}
const MIN_OCCURRENCES = 3;
const MIN_CONFIDENCE = 0.85;

// ── Ejecutor del modelo — AGNÓSTICO de herramienta ──────────────────────────────
// El observer usa el modelo de la herramienta que la máquina tenga, no sólo el CLI `claude`: sin eso, un dev que trabaja
// SOLO en Codex no recibiría ninguna propuesta (el grabador graba, pero el cerebro estaría clavado a Claude).
// Equivalencias: `claude` → Haiku · `codex` →
// gpt-5.4-mini (la equivalencia del arnés, build/equivalences.json) · `ollama` → modelo local.
// El costo es el mismo (~$0 con suscripción en cualquiera de las dos herramientas).
const EXECUTOR = (process.env.TYCON_OBSERVER_EXECUTOR || 'auto').toLowerCase(); // auto|claude|codex|ollama
const CLAUDE_MODEL = process.env.TYCON_OBSERVER_MODEL || 'claude-haiku-4-5';
const CODEX_MODEL = process.env.TYCON_OBSERVER_CODEX_MODEL || 'gpt-5.4-mini';
const OLLAMA_MODEL = process.env.TYCON_OBSERVER_OLLAMA_MODEL || 'llama3.2:3b';
const OLLAMA_URL = process.env.TYCON_OLLAMA_URL || 'http://localhost:11434';

// ============================================================
// Args
// ============================================================
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const notify = args.includes('--notify');
const sinceIdx = args.indexOf('--since');
const sinceArg = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

// ============================================================
// Helpers
// ============================================================
function log(msg) {
  process.stderr.write(`[instinct-observer] ${msg}\n`);
}

function monthsToRead() {
  if (sinceArg) return [sinceArg];
  const now = new Date();
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(now);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const prevStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  return [prevStr, cur];
}

function loadObservations() {
  const obs = [];
  for (const month of monthsToRead()) {
    const p = path.join(OBS_DIR, `${month}.jsonl`);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        obs.push(JSON.parse(line));
      } catch (_) {}
    }
  }
  return obs;
}

function instinctHash(trigger, action) {
  return crypto.createHash('sha1').update(`${trigger}::${action}`).digest('hex').slice(0, 10);
}

function existingHashes() {
  const hashes = new Set();
  // lo propuesto o decidido en CUALQUIER lugar de lectura: lo que ya se rechazó en el clon no se vuelve a proponer acá
  // Una carpeta que existe y no se deja leer se DICE: callada, lo decidido ahí se volvería a proponer sin que nadie
  // sepa por qué.
  for (const d of [...dondeLeer('pending'), ...dondeLeer('promoted'), ...dondeLeer('archived')]) {
    for (const f of DIRS.listDir(d, (m) => log(`${m} — lo ya propuesto o decidido ahí puede volver a proponerse`))) {
      const m = f.match(/-([a-f0-9]{10})\.yaml$/);
      if (m) hashes.add(m[1]);
    }
  }
  return hashes;
}

function binAvailable(bin) {
  try {
    return spawnSync(bin, ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch (_) {
    return false;
  }
}

function ollamaUp() {
  try {
    const r = spawnSync('curl', ['-s', '-m', '2', `${OLLAMA_URL}/api/version`], { encoding: 'utf-8' });
    return r.status === 0 && /"version"/.test(r.stdout || '');
  } catch (_) {
    return false;
  }
}

// Resuelve QUÉ ejecutor usar. `auto` prefiere claude (Haiku, el más barato y conocido); si no
// está, cae a codex (gpt-5.4-mini) — el caso del dev SOLO-Codex; si tampoco, a ollama local.
// Devuelve null si no hay ninguno → el caller loguea y sale limpio (exit 0, no 1: corre detached
// y nadie ve el error; el instalador ya avisa si el mining está registrado pero apagado).
function resolveExecutor() {
  if (EXECUTOR === 'claude') return binAvailable('claude') ? 'claude' : null;
  if (EXECUTOR === 'codex') return binAvailable('codex') ? 'codex' : null;
  if (EXECUTOR === 'ollama') return ollamaUp() ? 'ollama' : null;
  // auto
  if (binAvailable('claude')) return 'claude';
  if (binAvailable('codex')) return 'codex';
  if (ollamaUp()) return 'ollama';
  return null;
}

// Etiqueta guardada en cada instinct (`proposed_by`) para poder medir aceptación por ejecutor
// (¿el 3B local rinde como Haiku? ¿gpt-5.4-mini como Haiku?) ANTES de mover el default.
function executorLabel(executor) {
  const model = executor === 'claude' ? CLAUDE_MODEL : executor === 'codex' ? CODEX_MODEL : OLLAMA_MODEL;
  return `${executor}/${model}`;
}

// Llama al modelo del ejecutor resuelto. Devuelve el texto de la respuesta (mismo contrato para
// los tres; el parser de YAML de abajo no cambia). Un fallo tira — el caller lo captura.
function callModel(prompt, executor) {
  if (executor === 'claude') {
    const r = spawnSync('claude', ['--model', CLAUDE_MODEL, '--print', '--output-format', 'text',
      // Effort explícito, para no depender del que tenga la sesión interactiva del dev.
      '--effort', 'medium',
      // Proponer y revisar no usa herramientas ni el contexto del arnés (todo va en el prompt, como para
      // codex y ollama): --safe-mode no carga el CLAUDE.md del dev, skills, plugins, hooks ni MCP.
      '--safe-mode', '--tools', ''], {
      // El arnés no le grita sus alarmas de arranque al agente que lanza: sin esto, los hooks
      // de SessionStart le inyectan "controls-bench EN ROJO — Correr: node .../runner.js" y el
      // modelo va y lo corre en vez de hacer su tarea.
      input: prompt, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120000,
      env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }),
    });
    if (r.status !== 0) throw new Error(`claude CLI failed (status ${r.status}): ${r.stderr}`);
    return r.stdout.trim();
  }
  if (executor === 'codex') {
    // codex exec: prompt por stdin, --skip-git-repo-check (el observer corre desde ~/.claude, no
    // un repo), -s read-only (solo genera texto, no ejecuta nada — exec ya es no-interactivo, no
    // pide aprobación), -o escribe SOLO el mensaje final a un archivo (evita el ruido de eventos).
    const outFile = path.join(os.tmpdir(), `instinct-codex-${process.pid}.txt`);
    const r = spawnSync('codex', [
      'exec', '-m', CODEX_MODEL, '--skip-git-repo-check', '-s', 'read-only', '-o', outFile,
    ], {
      input: prompt, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 180000,
      env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }), // ver nota en la rama claude
    });
    if (r.status !== 0) throw new Error(`codex exec failed (status ${r.status}): ${(r.stderr || '').slice(0, 500)}`);
    let text = '';
    try { text = fs.readFileSync(outFile, 'utf-8').trim(); } catch (_) { text = (r.stdout || '').trim(); }
    try { fs.unlinkSync(outFile); } catch (_) {}
    return text;
  }
  if (executor === 'ollama') {
    const bodyFile = path.join(os.tmpdir(), `instinct-ollama-${process.pid}.json`);
    fs.writeFileSync(bodyFile, JSON.stringify({
      model: OLLAMA_MODEL, stream: false,
      options: { temperature: 0.2, num_ctx: contextoOllama(prompt) },
      messages: [{ role: 'user', content: prompt }],
    }));
    const r = spawnSync('curl', ['-s', '-m', '600', `${OLLAMA_URL}/api/chat`, '-d', `@${bodyFile}`],
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    try { fs.unlinkSync(bodyFile); } catch (_) {}
    if (r.status !== 0) throw new Error(`ollama call failed (status ${r.status})`);
    const parsed = JSON.parse(r.stdout);
    return (parsed.message && parsed.message.content || '').trim();
  }
  throw new Error(`ejecutor desconocido: ${executor}`);
}

/**
 * El contexto de ollama se dimensiona con el prompt, con 8192 como piso.
 *
 * Ollama no falla cuando el prompt y la respuesta no entran en el contexto: sigue generando y descarta en
 * silencio el PRINCIPIO del prompt. Medido con llama3.2:3b sobre un prompt de 7.807 tokens (el que proponía
 * con el catálogo adentro): con 8192 contestó 474 tokens, con 16384 la misma
 * consulta contestó 930, y las dos terminaron con `done_reason: stop`. El prompt que propone (~17.700 caracteres) se queda en 8192; el de la
 * revisión (lista de decididos acotada a 8.000 caracteres para ollama, más el catálogo detallado) mide
 * 5.835 tokens y crece con el catálogo y con la cantidad de propuestas, así que se
 * dimensiona. Se estiman ~3 caracteres por token (medidos: 3,3 en aquel prompt con catálogo y 3,8 en el
 * de la revisión) más lugar para la respuesta; el techo de 32768 evita pedirle a una máquina de 16 GB un
 * contexto que no tiene.
 */
function contextoOllama(prompt) {
  const necesario = Math.ceil(String(prompt || '').length / 3) + 2048;
  return Math.min(32768, Math.max(8192, 2 ** Math.ceil(Math.log2(necesario))));
}

// ============================================================
// Pattern detection (cheap heuristic, pre-LLM)
// ============================================================
function findCandidates(observations) {
  // Group by (project, tool, summary-prefix) — buckets para detectar repetición.
  const buckets = new Map();
  for (const o of observations) {
    // Normalizar summary: primeras 60 chars + tool + project
    const sumNorm = (o.summary || '').slice(0, 60).trim();
    const key = `${o.project}|${o.tool}|${sumNorm}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  // Filtrar buckets con >= MIN_OCCURRENCES
  const cands = [];
  for (const [key, items] of buckets) {
    if (items.length >= MIN_OCCURRENCES) {
      cands.push({ key, items, count: items.length });
    }
  }
  // Ordenar por count desc (más recurrentes primero)
  cands.sort((a, b) => b.count - a.count);
  return cands;
}

// ============================================================
// Lo que YA existe — leído del disco en CADA corrida
// ============================================================

/**
 * 🔴 El observador no sabe qué existe, y propondría cablear lo que YA está cableado.
 *
 * Sin la lista de lo que ya existe, el modelo propone, por ejemplo, un hook que corra compilación y tests después de cada
 * edición de un `.cs`. Eso ya lo hacen el build-gate y el test-gate del Step 4, la consistencia
 * entre capas ya la revisa `tycon-feature-wiring-checker`, y correr tests sin scope mientras se
 * itera está PROHIBIDO por la regla de disciplina de tests, porque la suite entera congela la máquina.
 * Esa propuesta duplica dos controles y contradice una regla firmada.
 *
 * La lista se ARMA LEYENDO EL DISCO en cada corrida, nunca se escribe en el código: una lista a
 * mano se desactualiza y vuelve a proponer duplicados sin que nadie se entere. Un revisor nuevo
 * aparece solo la próxima vez que el observador corra.
 *
 * Y se le PASA armada en vez de mandar al modelo a buscarla: el ejecutor local (`ollama`) no tiene
 * herramientas, y con los otros dos el modelo se puede ir a hacer otra cosa
 * cuando algo lo invita a explorar (ver la nota de `TYCON_EVAL_SANDBOX` más arriba).
 *
 * Fail-open: si algo de esto no se puede leer, se devuelve vacío y el prompt sale sin la lista. Que
 * el observador no sepa qué existe empeora sus propuestas; que no corra, las elimina.
 */
function loQueYaExiste() {
  const nombres = (dir, re) => {
    try {
      return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => f.replace(re, '$1')).sort();
    } catch (_) { return []; }
  };
  const advisors = nombres(path.join(os.homedir(), '.claude', 'agent-skills', 'agents'), /^(tycon-.+)\.md$/);
  // Los hooks viven en DOS repos: los del arnés y los del pipeline (en agent-skills). Leer sólo uno
  // dejaría fuera justo los que gatean el commit — `on-pre-commit`, `on-atdd-preedit`,
  // `on-frontmatter-write` — que son los que más se re-proponen.
  const hooks = [...new Set([
    ...nombres(path.join(REPO_ROOT, 'scripts', 'hooks'), /^(.+)\.(?:js|sh)$/),
    ...nombres(path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts'), /^(on-.+)\.js$/),
  ])].sort();
  const skills = nombres(path.join(os.homedir(), '.claude', 'agent-skills', 'skills'), /^(tycon-.+)$/);
  if (!advisors.length && !hooks.length && !skills.length) return '';

  const linea = (t, xs) => (xs.length ? `${t} (${xs.length}): ${xs.join(', ')}\n` : '');
  return `\n## What the harness ALREADY has (read from disk on this run)\n\n`
    + `Do NOT propose an instinct or an artifact for something already covered here. If a pattern is\n`
    + `already handled, SKIP it — or, if the existing piece is clearly insufficient, say which one it\n`
    + `is and what it misses, in the reasoning field.\n\n`
    + linea('Advisors (code reviewers that run in the pipeline)', advisors)
    + linea('Hooks (run automatically on tool use, prompts, commits)', hooks)
    + linea('Skills (invocable workflows)', skills)
    + `\nAlso already enforced, do NOT re-propose: build gate and test gate at the end of the\n`
    + `implementation step; ATDD order gate (tests before code); mutation check; DoD runtime gate;\n`
    + `per-AC runtime matrix; advisors gate before a story can close. And a signed rule: while\n`
    + `iterating, tests run SCOPED to the touched file only — never the full suite, never on every\n`
    + `edit (it froze two machines).\n`;
}

// ============================================================
// LLM prompt
// ============================================================
function buildPrompt(candidates, totalObs) {
  const top = candidates.slice(0, 15); // cap para no inflar el prompt
  const blocks = top.map((c, i) => {
    const sample = c.items.slice(0, 3).map((o) => `  - ts:${o.ts} status:${o.status} summary:"${o.summary}"`).join('\n');
    return `### Candidate ${i + 1} (occurred ${c.count}× in last 60d)\nproject|tool|summary-prefix: ${c.key}\nsample observations:\n${sample}`;
  }).join('\n\n');

  return `You are an observer scanning patterns in a developer's tool-usage logs. Your job is to detect REPEATED behaviors that suggest a tacit rule worth documenting as an "instinct" — a short trigger-action pair that would help future sessions.

Total observations analyzed: ${totalObs}
Candidates (repeated tool-use patterns, count >= 3):

${blocks}
${loQueYaExiste()}

For each candidate that suggests a non-trivial rule (NOT obvious things like "user reads files often"), output a YAML block in this exact shape:

\`\`\`yaml
- trigger: "<concrete situation, when this rule applies>"
  action: "<what to do, concrete and actionable>"
  confidence: 0.0-1.0
  domain: "<area: testing|auth|ui|build|story-format|engram|...>"
  scope: project|global
  project: "<project name if scope=project, omit if global>"
  candidate_index: <the number N of the "Candidate N" this came from — REQUIRED>
  tycon_artifact_suggestion: null | "skill:<name>" | "advisor:<name>" | "hook:<event>" | "guide:<topic>"
  reasoning: "<1-2 sentences: why this pattern matters>"
\`\`\`

Rules:
- ONLY output YAML, no prose explanation outside the YAML.
- If a candidate is too trivial or noisy, SKIP it (don't force an instinct).
- Confidence < 0.7 → skip entirely.
- Be specific. "Run tests after editing" is bad. "After editing a .cs file in NimboBackend, run dotnet test on the matching Tests project" is good.
- tycon_artifact_suggestion: only if the pattern is strong enough to justify a new automation. Most patterns are just instincts (artifact_suggestion=null).
- candidate_index is REQUIRED and must be the number of the Candidate block this instinct came from.
  It is used to attach the REAL occurrence count; do not invent an evidence count.
- Output ONLY a single YAML array. If no instincts qualify, output an empty array: \`[]\`.`;
}

// ============================================================
// Revisión contra lo que ya existe — una segunda llamada, sólo sobre lo que llegaría a la bandeja
// ============================================================

/**
 * 🔴 Una SEGUNDA llamada revisa cada propuesta contra lo que ya existe. Con sólo el catálogo de nombres de arriba, la mayoría
 * de las propuestas repite algo que existe: unas son variantes de instintos ya aprobados (el
 * dedup por hash sólo frena el texto idéntico) y otras piden controles que ya corren (un nombre no dice
 * qué cubre, y lo que corre al commitear y en CI no es un hook).
 *
 * Por qué una segunda llamada y no más contexto en el prompt que propone (medido con Haiku sobre una foto
 * fija de 159.696 observaciones):
 *  - Con los decididos en el prompt que propone y la orden de no repetirlos, lo que llega a la bandeja
 *    son copias de lo que ese prompt muestra: el razonamiento cita el aprobado que las cubre
 *    («Approved instinct 75ee1790b0 already codifies this») y las propone igual. La lista funciona como
 *    ejemplos a imitar.
 *  - Pidiéndole además que declarara qué las cubría: nada llega a la bandeja (medido en 17 corridas), también con
 *    patrones nuevos inventados. Proponer y censurarse en la misma respuesta lo apaga, e inventa
 *    coberturas genéricas («lo cubre la infraestructura de build»).
 *  - Separado —propone como siempre; otra llamada sólo clasifica lo que pasó la confianza y el hash—
 *    descarta repeticiones con cita y deja pasar lo nuevo.
 *
 * El catálogo detallado (qué audita cada revisor, el pre-commit, scripts/ci/) y los instintos decididos
 * van SÓLO acá, donde se decide; el prompt que propone no los lleva. Todo se lee del disco en cada
 * corrida. Tres reglas sostienen la revisión:
 *  - La cita se verifica: `covered_by` tiene que EMPEZAR por un hash o una pieza que este prompt mostró.
 *    Una categoría, una frase («not the same as [hash]») o algo que no se mostró no descarta nada.
 *  - Una variante del mismo hábito en OTRO proyecto no es una repetición: el dev aprueba variantes por repo
 *    y generaliza fundiéndolas, y sus rechazos «repite lo aprobado» son del
 *    mismo proyecto que el aprobado (o el aprobado es global). Se le pide al modelo y además se verifica.
 *  - Lo descartado no desaparece: queda en `inbox/instincts/descartados/` con su cita (un archivo por propuesta,
 *    con cuántas veces se descartó) y `/tycon-instincts review` lo muestra. Si no, un descarte de más se
 *    vería igual que una semana sin nada nuevo.
 *
 * Fail-open: sin nada contra qué revisar no hay segunda llamada (y el log lo dice); si falla o no se
 * entiende, lo propuesto sigue su camino sin revisar.
 */

// «none» y sus parientes: una revisión que dice que nada lo cubre no «citó algo que no mostró» (sólo para el log).
const NEGACION = /^["'`\s]*(?:none|null|no|not|nothing|n\/a|ningun[oa]?|nada)(?![\w-])/i;

// Una sola línea: colapsa los espacios y corta en un borde de palabra. Lo largo se acorta, no se descarta.
function corto(texto, max) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const c = s.slice(0, max - 1);
  const i = c.lastIndexOf(' ');
  return `${(i > max * 0.6 ? c.slice(0, i) : c).replace(/[\s,;:.(—–-]+$/, '')}…`;
}

// Un campo de primer nivel de un YAML, sin dependencias: entre comillas dobles (así lo escriben el
// observador y /tycon-instincts), entre simples, suelto (con o sin comentario al final), o en bloque `|` /
// `>` (así quedó escrito a mano el motivo de ed8eb8ac54). null si no está.
function campoYaml(texto, clave) {
  const lineas = String(texto || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!m || m[1] !== clave) continue;
    const v = m[2].trim();
    if (/^[|>][-+]?(?:\s+#.*)?$/.test(v)) {
      const cuerpo = [];
      for (let j = i + 1; j < lineas.length && (!lineas[j].trim() || /^\s/.test(lineas[j])); j++) cuerpo.push(lineas[j]);
      return cuerpo.join(' ').replace(/\s+/g, ' ').trim() || null;
    }
    if (v.startsWith('"')) {
      const cerrada = v.match(/^"(?:[^"\\]|\\.)*"/);
      if (cerrada) {
        try { return String(JSON.parse(cerrada[0])); } catch (_) { return cerrada[0].slice(1, -1) || null; }
      }
      return v.slice(1) || null;
    }
    if (v.startsWith("'")) {
      const cerrada = v.match(/^'((?:[^']|'')*)'/);
      return cerrada ? cerrada[1].replace(/''/g, "'") || null : v.slice(1) || null;
    }
    return v.replace(/\s+#.*$/, '').trim() || null;
  }
  return null;
}

// Qué audita un revisor, en una línea, sacado del `description:` de su frontmatter. Se descarta lo que no
// dice QUÉ audita: el prefijo «Advisor Core <fase>.» y lo que sigue a la primera oración (IDs de reglas,
// cuándo invocarlo). La oración se corta fuera de paréntesis —ahí adentro va la lista que importa— y no en
// una abreviatura («vs.», «e.g.»). Tope 420: con 160 se cortarían 24 de los 28 revisores y se perdería justo esa
// lista; con 420 no se corta ninguno.
function descripcionDeRevisor(texto) {
  const fm = String(texto || '').replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const d = fm && campoYaml(fm[1], 'description');
  if (!d) return null;
  const s = d.replace(/^Advisor\b[^.]*?\.\s+/, '');
  let prof = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') prof++;
    else if (s[i] === ')') prof = Math.max(0, prof - 1);
    else if (s[i] === '.' && prof === 0 && /^\s+[A-ZÁÉÍÓÚÑ¿¡]/.test(s.slice(i + 1))
      && !/\b(?:vs|e\.g|i\.e|etc|cf|aprox)$/i.test(s.slice(0, i))) {
      return corto(s.slice(0, i), 420);
    }
  }
  return corto(s, 420);
}

// La primera frase del comentario de cabecera de un guion —lo que el propio guion dice que hace—, en una
// línea. Sin cabecera, null: se lista el nombre solo.
function lineaDeCabecera(archivo) {
  let texto;
  try { texto = fs.readFileSync(archivo, 'utf-8').slice(0, 8000); } catch (_) { return null; }
  const parrafo = [];
  for (const cruda of texto.split(/\r?\n/).slice(0, 60)) {
    const l = cruda.trim();
    if (!parrafo.length && (!l || l.startsWith('#!') || /^['"]use strict['"];?$/.test(l))) continue;
    if (!/^(?:#|\*|\/\/|\/\*)/.test(l)) break; // se terminó el comentario de cabecera
    const contenido = l.replace(/^(?:\/\*\*?|\*\/?|#+|\/\/)\s?/, '').trim();
    if (!contenido || /^[=─━\-–—_*#\s]+$/.test(contenido) || /^(?:shellcheck|eslint)\b/.test(contenido)) {
      if (parrafo.length) break; // un renglón vacío o un separador cierra el primer párrafo
      continue;
    }
    parrafo.push(contenido);
  }
  if (!parrafo.length) return null;
  const base = path.basename(archivo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return corto(parrafo.join(' ').replace(new RegExp(`^(?:[\\w.-]+/)*${base}\\s*[—–:-]+\\s*`), ''), 150);
}

// Lo que corre al commitear y no es un hook de la herramienta: los guiones que EJECUTAN el pre-commit del
// arnés y el global, más los `scripts/lint-*`, que los repos de producto llaman por ruta desde SU
// `.githooks/pre-commit` (que este observador no puede leer). Un guion nombrado en un comentario, en un
// `echo` o dentro de un heredoc no corre, y no cuenta.
function controlesDelPreCommit() {
  const rutas = new Set();
  for (const hook of ['.githooks/pre-commit', path.join('scripts', 'hooks', 'git-pre-commit-global.sh')]) {
    let texto;
    try { texto = fs.readFileSync(path.join(REPO_ROOT, hook), 'utf-8'); } catch (_) { continue; }
    let finDeHeredoc = null;
    for (const cruda of texto.split(/\r?\n/)) {
      if (finDeHeredoc) {
        if (cruda.trim() === finDeHeredoc) finDeHeredoc = null;
        continue;
      }
      if (/^\s*#/.test(cruda)) continue;
      const linea = cruda.replace(/\s+#.*$/, '').replace(/\$\(\([^)]*\)\)/g, '').replace(/<<<\s*(?:"[^"]*"|'[^']*'|\S+)/g, '');
      const heredoc = linea.match(/(?:^|[^<])<<(?!<)-?\s*['"]?([A-Za-z_]\w*)['"]?/);
      if (heredoc) finDeHeredoc = heredoc[1];
      // Por segmento: en `x && echo "corré scripts/ci/y.js"` corre x, no y.
      for (const segmento of linea.split(/;|&&|\|\||\|/)) {
        if (/^\s*(?:(?:then|do|else|elif|\{|\()\s+)?(?:echo|printf)\b/.test(segmento)) continue;
        for (const m of segmento.matchAll(/\b(?:scripts|build)\/[\w./-]+\.(?:js|sh)\b/g)) {
          if (!/^scripts\/(?:tests|hooks)\//.test(m[0])) rutas.add(m[0]);
        }
      }
    }
  }
  try {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, 'scripts'))) {
      if (/^lint-.+\.(?:js|sh)$/.test(f)) rutas.add(`scripts/${f}`);
    }
  } catch (_) {}
  return [...rutas].filter((r) => fs.existsSync(path.join(REPO_ROOT, r))).sort();
}

// El catálogo detallado, leído del disco: todos los revisores de agents/ con lo que audita cada uno (no sólo
// los `tycon-*`: los que se activan por stack también son controles), los hooks de los dos repos, los
// skills, lo que corre en el pre-commit y los guiones de scripts/ci/ con la primera frase de su cabecera.
// `nombres` es exactamente lo que el texto muestra: contra eso se verifica una cita.
function catalogoDetallado() {
  const listar = (dir, re) => {
    try {
      return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => f.replace(re, '$1')).sort();
    } catch (_) { return []; }
  };
  const leer = (archivo) => {
    try { return fs.readFileSync(archivo, 'utf-8'); } catch (_) { return ''; }
  };
  const agentSkills = path.join(os.homedir(), '.claude', 'agent-skills');
  const revisores = listar(path.join(agentSkills, 'agents'), /^(.+)\.md$/).filter((n) => n !== 'README')
    .map((n) => [n, descripcionDeRevisor(leer(path.join(agentSkills, 'agents', `${n}.md`)))]);
  const hooks = [...new Set([
    ...listar(path.join(REPO_ROOT, 'scripts', 'hooks'), /^(.+)\.(?:js|sh)$/),
    ...listar(path.join(agentSkills, 'skills', 'tycon-pipeline', 'scripts'), /^(on-.+)\.js$/),
  ])].sort();
  const skills = listar(path.join(agentSkills, 'skills'), /^(tycon-.+)$/);
  const preCommit = controlesDelPreCommit().map((r) => [r, lineaDeCabecera(path.join(REPO_ROOT, r))]);
  const ci = listar(path.join(REPO_ROOT, 'scripts', 'ci'), /^(.+\.(?:js|sh))$/)
    .filter((f) => !preCommit.some(([r]) => r === `scripts/ci/${f}`))
    .map((f) => [f, lineaDeCabecera(path.join(REPO_ROOT, 'scripts', 'ci', f))]);
  const nombres = [...revisores.map(([n]) => n), ...hooks, ...skills, ...preCommit.map(([r]) => r), ...ci.map(([f]) => f)];
  if (!nombres.length) return { texto: '', nombres };

  const linea = (t, xs) => (xs.length ? `${t} (${xs.length}): ${xs.join(', ')}\n` : '');
  const renglones = (t, xs) => (xs.length
    ? `${t} (${xs.length}):\n${xs.map(([n, d]) => `- ${n}${d ? `: ${d}` : ''}`).join('\n')}\n`
    : '');
  const texto = `\n## What the harness ALREADY has (read from disk on this run)\n\n`
    + renglones('Advisors (code reviewers that run in the pipeline) — what each one audits', revisores)
    + linea('Hooks (run automatically on tool use, prompts, commits)', hooks)
    + linea('Skills (invocable workflows)', skills)
    + renglones('Pre-commit checks (git runs them when committing, from any tool)', preCommit)
    + renglones('CI scripts (scripts/ci/ — the Azure DevOps pipelines run these)', ci);
  return { texto, nombres };
}

// Tope de la lista de decididos, en caracteres. Con Haiku o gpt-5.4-mini el contexto no es la restricción, y
// con 8000 el revisor vería un solo día de rechazos (entrarían los 25 aprobados y 6
// rechazados, todos del mismo día); ollama, con 8.192 tokens de contexto en máquinas de 16 GB, sí la tiene.
function topeDecididos(executor) {
  return executor === 'ollama' ? 8000 : 16000;
}

/**
 * Los instintos que el dev YA decidió — aprobados (con su acción) y rechazados (con su motivo) —, cada uno
 * con su proyecto, para que la revisión reconozca las variantes. Devuelve el texto y los hashes que muestra.
 *
 * Con tope, y el orden decide qué entra: primero los del mismo proyecto que algún candidato (o sin
 * proyecto), primero los aprobados, primero los más nuevos. Se corta en el primero que no entra, así que
 * todo lo mostrado pesa más que todo lo omitido; lo omitido se cuenta en el texto. Sin tope, la lista
 * crecería con cada semana de decisiones — 156 decididos son ~39.000 caracteres.
 *
 * Fail-open: sin carpetas, sin archivos legibles o sin triggers, texto vacío.
 */
function instintosYaDecididos(candidatos, tope = topeDecididos()) {
  const proyectosConCandidato = new Set((candidatos || [])
    .map((c) => String((c && c.key) || '').split('|')[0].trim().toLowerCase())
    .filter(Boolean));
  const leerCarpeta = (dir, aprobado) => {
    let archivos;
    try { archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort(); } catch (_) { return []; }
    const out = [];
    for (const f of archivos) {
      let t;
      try { t = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (_) { continue; }
      const trigger = campoYaml(t, 'trigger');
      if (!trigger) continue;
      const proyecto = campoYaml(t, 'project');
      const proyectos = String(proyecto || '').split(/[,|/]/).map((p) => p.trim().toLowerCase()).filter(Boolean);
      out.push({
        aprobado,
        trigger,
        proyectos,
        proyecto: proyecto || 'global',
        accion: aprobado ? campoYaml(t, 'action') : null,
        hash: campoYaml(t, 'hash') || (f.match(/-([a-f0-9]{10})\.yaml$/) || [])[1] || '',
        motivo: aprobado ? null : (campoYaml(t, 'rejection_reason') || campoYaml(t, 'motivo_rechazo')),
        fecha: String((aprobado ? campoYaml(t, 'approved_at') : (campoYaml(t, 'rejected_at') || campoYaml(t, 'rechazado')))
          || campoYaml(t, 'proposed_at') || ''),
        relevante: !proyectos.length || proyectos.some((p) => proyectosConCandidato.has(p)),
      });
    }
    return out;
  };
  // lo decidido en todos los lugares de lectura; el mismo instinto en dos lugares entra una vez (el primero que aparece)
  const vistos = new Set();
  const todos = [...dondeLeer('promoted').flatMap((d) => leerCarpeta(d, true)), ...dondeLeer('archived').flatMap((d) => leerCarpeta(d, false))]
    .filter((x) => { const k = `${x.aprobado}|${x.hash || x.trigger}`; if (vistos.has(k)) return false; vistos.add(k); return true; });
  if (!todos.length) return { texto: '', hashes: [], proyectosPorHash: new Map() };
  todos.sort((a, b) => (Number(b.relevante) - Number(a.relevante))
    || (Number(b.aprobado) - Number(a.aprobado))
    || b.fecha.localeCompare(a.fecha));

  const aprobados = [];
  const rechazados = [];
  const hashes = [];
  const proyectosPorHash = new Map();
  let usados = 0;
  for (const x of todos) {
    const renglon = `- ${x.hash ? `[${x.hash}] ` : ''}(${corto(x.proyecto, 60)}) ${corto(x.trigger, 150)}`
      + (x.aprobado && x.accion ? ` → ${corto(x.accion, 100)}` : '')
      + (!x.aprobado && x.motivo ? ` — rejected because: ${corto(x.motivo, 110)}` : '');
    if (usados + renglon.length + 1 > tope) break;
    (x.aprobado ? aprobados : rechazados).push(renglon);
    if (x.hash) {
      hashes.push(x.hash);
      proyectosPorHash.set(x.hash.toLowerCase(), x.proyectos);
    }
    usados += renglon.length + 1;
  }
  const omitidos = todos.length - aprobados.length - rechazados.length;
  const texto = `\n## Instincts the developer ALREADY decided (read from inbox/instincts/promoted and inbox/instincts/archived on this run)\n\n`
    + `An approved one is already a rule: more occurrences of its pattern do not make it new. A rejected one\n`
    + `was judged wrong for the reason given. Each line shows its project.\n\n`
    + (aprobados.length ? `Approved (${aprobados.length}):\n${aprobados.join('\n')}\n\n` : '')
    + (rechazados.length ? `Rejected by the developer (${rechazados.length}):\n${rechazados.join('\n')}\n\n` : '')
    + (omitidos ? `(${omitidos} more decided instincts not shown, to keep this prompt short: the ones from projects with no candidate here and the oldest.)\n` : '');
  return { texto, hashes, proyectosPorHash };
}

// El prompt de la revisión y lo que una cita puede nombrar (los hashes y las piezas que ese prompt muestra,
// en minúscula; también sin extensión, y por su nombre de archivo cuando tiene guion: «build/check.js» se
// cita por su ruta, pero «check» solo no descarta nada). Prompt vacío si no hay nada contra qué revisar.
function promptDeRevision(propuestas, candidatos, executor) {
  const catalogo = catalogoDetallado();
  const decididos = instintosYaDecididos(candidatos, topeDecididos(executor));
  const conocidas = new Set(decididos.hashes.map((h) => h.toLowerCase()));
  for (const nombre of catalogo.nombres) {
    const n = nombre.toLowerCase();
    const sinExtension = (x) => x.replace(/\.(?:js|sh|py|md)$/, '');
    conocidas.add(n);
    conocidas.add(sinExtension(n));
    if (path.basename(n).includes('-')) {
      conocidas.add(path.basename(n));
      conocidas.add(sinExtension(path.basename(n)));
    }
  }
  const proyectoDe = (p) => {
    const ci = Number(p.candidate_index);
    const c = Array.isArray(candidatos) && Number.isInteger(ci) && ci >= 1 ? candidatos[ci - 1] : null;
    return (c && String(c.key || '').split('|')[0]) || p.project || 'global';
  };
  const proyectos = propuestas.map(proyectoDe);
  const base = {
    conocidas, proyectos, proyectosPorHash: decididos.proyectosPorHash,
    sinCatalogo: !catalogo.texto, sinDecididos: !decididos.texto,
  };
  if (!catalogo.texto && !decididos.texto) return { prompt: '', ...base };

  const lista = propuestas.map((p, i) => `### P${i + 1}\nproject: ${proyectos[i]}\ntrigger: ${corto(p.trigger, 400)}\naction: ${corto(p.action, 400)}`).join('\n\n');
  const prompt = `You are checking proposed "instincts" (trigger → action rules mined from a developer's tool usage) against what ALREADY exists, so the developer never reviews the same thing twice. You do not judge whether a proposal is good — only whether it repeats something listed below.
${decididos.texto}${catalogo.texto}
## Proposed instincts to check (${propuestas.length})

${lista}

For EVERY proposal output one YAML entry, in order:

\`\`\`yaml
- p: <number of the proposal: P1 is 1>
  covered_by: none | "<[hash] copied from the decided list>" | "<piece name copied from the harness lists>"
  why: "<one short sentence>"
\`\`\`

Rules:
- Covered by a decided instinct: the same situation in the same project — or the decided one is global, or lists this project — even if reworded, with another tool in the action, or "confirming" it with more evidence. The same habit in a DIFFERENT project is NOT covered: the developer decides whether to generalize it.
- Covered by a harness piece: that piece already does this very action on its own — a hook or a check that already runs or blocks it, a skill whose own procedure is this action, or a reviewer whose line above says it audits exactly what the proposal asks to check.
- covered_by must START with the [hash] or the piece name, copied exactly from the lists above. If nothing listed covers it, write none — never a general category, a guide, a rule that is not listed, or a sentence.
- Output ONLY the YAML list, one entry per proposal, nothing else.`;
  return { prompt, ...base };
}

// Los veredictos de la revisión, por número de propuesta: { covered_by, why }. Acepta «p: 3» y «p: P3». Si
// numeró desde 0, se corre uno: si no, cada propuesta recibiría el veredicto de la siguiente.
function leerRevision(texto, cuantas) {
  let porNumero = new Map();
  let actual = null;
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const p = linea.match(/^\s*-\s+p:\s*["']?P?(\d+)/i);
    if (p) {
      actual = { covered_by: null, why: '' };
      porNumero.set(Number(p[1]), actual);
      continue;
    }
    const m = actual && linea.match(/^\s+(covered_by|why):\s*(.*)$/);
    if (m) actual[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (cuantas && porNumero.has(0) && !porNumero.has(cuantas)) {
    porNumero = new Map([...porNumero].map(([k, v]) => [k + 1, v]));
  }
  return porNumero;
}

// Una salvedad en las primeras palabras después de lo citado anula la cita: «[hash] — not the same»,
// «[hash] (different project)», «pieza — does not cover this». Seis palabras y no toda la frase: una cita
// legítima puede copiar el trigger del decidido, y ése sí puede decir «not».
const SALVEDAD = /(?:^|[^\w-])(?:not|no|never|none|n\/a|isn['’]?t|doesn['’]?t|don['’]?t|cannot|can['’]?t|won['’]?t|different|other|another|unrelated|partial(?:ly)?|nearby|closest|similar|instead)(?![\w-])/i;
// Una etiqueta de tipo delante de lo citado («advisor: X», «hook X», «Approved instinct [hash]») no es la cita.
const ETIQUETA = /^(?:(?:approved|rejected|decided)\s+(?:instinct\s*)?:?\s*|(?:advisor|reviewer|hook|skill|pre-commit(?:\s+check)?|ci(?:\s+script)?|piece)\s*:?\s+)/i;

// El hash o la pieza con que EMPIEZA la cita, si el prompt de la revisión lo mostró; null en todo otro caso.
// Empezar por lo citado vuelve inofensivas las frases («none (lo más parecido es X)», «similar to [hash]»);
// una salvedad justo después la anula; una ruta delante del nombre mostrado («scripts/ci/x.sh») no.
function citaVerificada(valor, conocidas) {
  const s = String(valor == null ? '' : valor).trim().replace(/^["'`«]+/, '').replace(ETIQUETA, '');
  const partes = s.match(/^(\S+)\s*([\s\S]*)$/);
  if (!partes || NEGACION.test(partes[1])) return null;
  if (SALVEDAD.test(partes[2].split(/\s+/).slice(0, 6).join(' '))) return null;
  const termino = partes[1].toLowerCase().replace(/^["'`«[(]+/, '').replace(/["'`»\])]+/g, '').replace(/:.*$/, '').replace(/[.;,]+$/, '');
  if (!termino) return null;
  const sinExtension = (x) => x.replace(/\.(?:js|sh|py|md)$/, '');
  return [termino, sinExtension(termino), path.basename(termino), sinExtension(path.basename(termino))]
    .find((x) => x && conocidas.has(x)) || null;
}

/**
 * Qué hace un veredicto con su propuesta: `{ cita }` si la descarta, `{ sigue }` con el motivo si la revisión
 * citó algo que no alcanza para descartar, o null si dijo que nada la cubre. La cita tiene que verificar
 * (`citaVerificada`); el `why` no puede negarla («different project, so NOT covered»); y un decidido de OTRO
 * proyecto no descarta: esa regla se le pide al modelo en el prompt, y acá se verifica con los proyectos que
 * el propio prompt mostró.
 */
function decidirDescarte(veredicto, revision, k) {
  if (!veredicto || !veredicto.covered_by || NEGACION.test(veredicto.covered_by)) return null;
  const cita = citaVerificada(veredicto.covered_by, revision.conocidas);
  if (!cita) return { sigue: `la revisión citó algo que su prompt no mostró, o lo negó: ${veredicto.covered_by}` };
  if (/\bnot\s+(?:covered|the\s+same)\b|\bdifferent\s+project\b/i.test(veredicto.why || '')) {
    return { sigue: `la revisión citó ${cita} pero dice que no la cubre: ${veredicto.why}` };
  }
  const suyos = revision.proyectosPorHash && revision.proyectosPorHash.get(cita);
  const propio = String((revision.proyectos || [])[k] || '').toLowerCase();
  if (suyos && suyos.length && propio && propio !== 'global' && !suyos.includes(propio)) {
    return { sigue: `la revisión citó ${cita}, que es de otro proyecto (${suyos.join(', ')}); decidís vos si se generaliza` };
  }
  return { cita };
}

// ============================================================
// YAML parsing (light — extracts the array from LLM response)
// ============================================================
function extractYamlArray(text) {
  // Buscar bloque YAML (fenced o no)
  let yaml = text;
  const fence = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  if (fence) yaml = fence[1];
  // Buscar lista al inicio
  yaml = yaml.trim();
  if (yaml.startsWith('[]')) return [];
  // Parse manual líneas que empiezan con "- trigger:"
  // (evitamos dep externa para simplificar)
  const items = [];
  let current = null;
  for (const line of yaml.split('\n')) {
    if (line.match(/^\s*-\s+trigger:/)) {
      if (current) items.push(current);
      current = { _raw: [line] };
      const m = line.match(/trigger:\s*["']?(.*?)["']?\s*$/);
      if (m) current.trigger = m[1];
    } else if (current) {
      current._raw.push(line);
      const m = line.match(/^\s+(\w+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        let val = m[2].trim().replace(/^["']|["']$/g, '');
        if (val === 'null') val = null;
        else if (val.match(/^-?\d+\.?\d*$/)) val = parseFloat(val);
        current[key] = val;
      }
    }
  }
  if (current) items.push(current);
  return items;
}

// ============================================================
// Write instinct YAML
// ============================================================
/**
 * 🔴 `evidence_count` sale del CONTEO REAL del candidato, no de lo que el modelo escriba.
 *
 * Transcribir `inst.evidence_count` tal cual deja pasar cifras como
 * «1982 ocurrencias» que nadie contó — el modelo la escribe y el guion la copia. Un
 * número que parece medido y no lo es, en un arnés cuya regla madre es que nada se afirma sin
 * medirlo. El dato verdadero YA existe (`candidates[i].count`, que el propio prompt le muestra al
 * modelo como «occurred N× in last 60d»): sólo hace falta usarlo.
 *
 * Si el modelo no dice de qué candidato salió, el campo queda `null` con su motivo — nunca un 0,
 * que se leería como «lo conté y no hay».
 */
function writeInstinct(inst, idx, ts, proposedBy, candidates, dir = dondeEscribir('pending'), extras = null) {
  const ci = Number(inst.candidate_index);
  const cand = (Array.isArray(candidates) && Number.isInteger(ci) && ci >= 1) ? candidates[ci - 1] : null;
  const conteoReal = cand && Number.isFinite(cand.count) ? cand.count : null;
  const trigger = (inst.trigger || `inst-${idx}`).toString();
  const action = (inst.action || '').toString();
  const hash = instinctHash(trigger, action);
  const slug = trigger.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `inst-${idx}`;
  const fname = `${ts}-${slug}-${hash}.yaml`;
  const fpath = path.join(dir, fname);

  const yaml = [
    `# Auto-generated by instinct-observer.js`,
    `# Review with: /tycon-instincts review`,
    `hash: ${hash}`,
    `trigger: ${JSON.stringify(trigger)}`,
    `action: ${JSON.stringify(action)}`,
    `confidence: ${inst.confidence ?? 0}`,
    `domain: ${JSON.stringify(inst.domain || 'unknown')}`,
    `scope: ${inst.scope || 'project'}`,
    inst.project ? `project: ${JSON.stringify(inst.project)}` : null,
    conteoReal !== null
      ? `evidence_count: ${conteoReal}`
      : `evidence_count: null   # el modelo no dijo de qué candidato salió: no se puede contar`,
    inst.evidence_count !== undefined && Number(inst.evidence_count) !== conteoReal
      ? `evidence_count_declarado_por_el_modelo: ${inst.evidence_count}   # sin verificar — se conserva para medir cuánto se aparta`
      : null,
    `tycon_artifact_suggestion: ${inst.tycon_artifact_suggestion ? JSON.stringify(inst.tycon_artifact_suggestion) : 'null'}`,
    `reasoning: ${JSON.stringify(inst.reasoning || '')}`,
    `proposed_at: ${new Date().toISOString()}`,
    `proposed_by: ${JSON.stringify(proposedBy || 'unknown')}`,
    ...Object.entries(extras || {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
    `engram_promoted: false`,
  ].filter(Boolean).join('\n') + '\n';

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fpath, yaml);
  return fpath;
}

// Lo descartado queda en `descartados/` del lugar donde se escribe: UN archivo por propuesta (reemplaza el de una corrida
// anterior y suma cuántas veces se descartó). El contador se lee de TODOS los lugares de lectura —la constancia anterior
// puede estar en el buzón de un clon o en el de otra copia del arnés—, pero sólo se borra la que está donde se
// escribe: el observador no toca lo de otro lugar. Nunca tumba al observador: si no puede escribir, lo dice y sigue — la
// constancia no puede costar las propuestas nuevas que vienen después.
const descartadosIlegiblesAvisados = new Set();
function dejarConstanciaDeDescarte(inst, idx, ts, proposedBy, candidates, cita, why) {
  let destino = null;
  try {
    destino = dondeEscribir('descartados');
    const hash = instinctHash(String(inst.trigger), String(inst.action || ''));
    let veces = 1;
    for (const dir of [destino, ...dondeLeer('descartados').filter((d) => d !== destino)]) {
      let anteriores;
      // el de escritura tiene que poder leerse (si no, tampoco se va a poder escribir: se dice abajo). Los demás, si se
      // puede; y si existen y no se dejan leer, se dice: el contador de esta propuesta puede quedar corto
      try { anteriores = fs.readdirSync(dir).filter((f) => f.endsWith(`-${hash}.yaml`)); } catch (e) {
        if (e.code === 'ENOENT') continue;
        if (dir === destino) throw e;
        // una vez por carpeta y por corrida, no una por cada propuesta que se descarta
        if (e.code !== 'ENOTDIR' && !descartadosIlegiblesAvisados.has(dir)) {
          descartadosIlegiblesAvisados.add(dir);
          log(`no pude leer ${DIRS.shown(dir)} (${e.code || e.message}): si una propuesta ya se había descartado ahí, su contador no suma esas veces`);
        }
        continue;
      }
      for (const f of anteriores) {
        let previas = 1;
        try { previas = Number(campoYaml(fs.readFileSync(path.join(dir, f), 'utf-8'), 'veces_descartada')) || 1; } catch (_) {}
        veces = Math.max(veces, previas + 1);
        if (dir === destino) fs.unlinkSync(path.join(dir, f));
      }
    }
    writeInstinct(inst, idx, ts, proposedBy, candidates, destino, {
      cubierto_por: cita, motivo_de_la_revision: why || '', descartado_at: new Date().toISOString(), veces_descartada: veces,
    });
  } catch (e) {
    log(`No pude dejar constancia en ${destino ? DIRS.shown(destino) : 'descartados'}/ (${e.message}): la descartada queda sólo en este log.`);
  }
}

// ── Los descartados de la carpeta anterior de datos ─────────────────────────────────────────────────────────────
// Los datos viven en inbox/instincts/. En una máquina que ya corrió el observador pueden quedar, en la carpeta vieja,
// archivos locales que nunca viajaron por git: el log se queda donde está (un log no se migra),
// pero `descartados/` es estado — con su `veces_descartada`, el observador sabe cuántas veces ya descartó lo mismo. La
// primera corrida después del pull (del observador o de instinct-promote) lleva esos archivos a la carpeta nueva y lo
// dice en una línea; la siguiente no encuentra nada. El nombre viejo sale del mapa de renombres (la entrada `folder`
// cuyo `new` es inbox/instincts): la copia pública no lleva el mapa, y ahí no hay nada que migrar.
// Un archivo con el mismo nombre en las dos carpetas: gana el de MÁS veces descartada (es la memoria que se quiere
// conservar: el siguiente descarte suma desde ahí); empate, el de `descartado_at` más nuevo; empate otra vez, el que
// ya estaba en la nueva. Dos archivos distintos con el mismo hash no son choque: dejarConstanciaDeDescarte y la lista
// de instinct-promote ya toman el máximo entre los archivos de una misma propuesta.
// Nunca tumba a quien la llama: si no puede, lo dice y sigue (el viejo queda donde estaba, nada se pierde).
function carpetaViejaDeInstintos() {
  let l;
  try { l = require(path.join(__dirname, '..', 'lib', 'legacy-names.js')); } catch (_) { return null; }
  const e = l.usableEntries(l.loadMap()).find((x) => x.kind === 'folder' && x.new === 'inbox/instincts' && x.repo !== 'agent-skills');
  if (!e || e.old === e.new) return null;
  return path.join(REPO_ROOT, e.old);
}

function ganaElViejo(viejo, nuevo) {
  const leer = (f) => { try { return fs.readFileSync(f, 'utf-8'); } catch (_) { return ''; } };
  const tv = leer(viejo);
  const tn = leer(nuevo);
  const veces = (t) => Number(campoYaml(t, 'veces_descartada')) || 1;
  if (veces(tv) !== veces(tn)) return veces(tv) > veces(tn);
  const cuando = (t) => String(campoYaml(t, 'descartado_at') || '');
  return cuando(tv) > cuando(tn);
}

function migrarDescartadosViejos(avisar = log) {
  // Sólo en un árbol que trae su buzón: la carpeta vieja existe en clones del repo de
  // mantenimiento, y es el único caso en que un comando que sólo lee puede crear `descartados/` en el árbol.
  if (!DIRS.treeBringsInbox()) return 0;
  const DESCARTADOS_DIR = path.join(DIRS.treeInbox(), 'descartados');
  const vieja = carpetaViejaDeInstintos();
  if (!vieja) return 0;
  const origen = path.join(vieja, 'descartados');
  const rel = path.relative(REPO_ROOT, origen).split(path.sep).join('/');
  let archivos;
  try {
    archivos = fs.readdirSync(origen, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return 0;
    avisar(`No pude mirar ${rel}/ (${e.code || e.message}): los descartados de antes de la mudanza no se migraron esta vez.`);
    return 0;
  }
  let movidos = 0;
  let choques = 0;
  try {
    if (archivos.length) fs.mkdirSync(DESCARTADOS_DIR, { recursive: true });
    for (const f of archivos) {
      const de = path.join(origen, f);
      const a = path.join(DESCARTADOS_DIR, f);
      if (fs.existsSync(a)) {
        if (ganaElViejo(de, a)) fs.copyFileSync(de, a);
        fs.unlinkSync(de);
        choques++;
      } else {
        fs.renameSync(de, a);
      }
      movidos++;
    }
    fs.rmdirSync(origen);
  } catch (e) {
    avisar(`No pude llevar los descartados de ${rel}/ a inbox/instincts/descartados/ (${e.code || e.message}): ${movidos} de ${archivos.length} pasaron; lo demás sigue en la carpeta vieja y se reintenta en la próxima corrida.`);
    return movidos;
  }
  if (movidos) {
    avisar(`Llevé ${movidos} descartado(s) de ${rel}/ a inbox/instincts/descartados/ (la carpeta de antes de la mudanza)`
      + (choques ? `; ${choques} con el mismo nombre en las dos: quedó el de más veces descartada (empate: el más nuevo).` : '.'));
  }
  return movidos;
}

// ============================================================
// Telegram notify
// ============================================================
/**
 * El aviso de instintos nuevos, por los canales de la organización (scripts/lib/notify.js, del lado de la sesión: las
 * credenciales de esta máquina). El bot y el chat propios de la grabadora (TYCON_INSTINCT_TELEGRAM_BOT_TOKEN y
 * TYCON_INSTINCT_TELEGRAM_CHAT_ID), si están, pisan los de la máquina sólo para este aviso. El token viaja en el entorno
 * del cliente de Telegram, nunca en la línea de comandos.
 */
function maybeNotify(count, descartados = 0, { notify: pedido = notify, env = process.env } = {}) {
  if (!pedido) return;
  if (env.TYCON_INSTINCT_NOTIFY !== '1') return;
  if (count === 0) return;
  const msg = `instinct-observer: ${count} nuevos instincts pending`
    + (descartados ? ` (y ${descartados} descartados por repetir algo que ya existe)` : '')
    + '. Review: /tycon-instincts review';
  const envAviso = { ...env };
  if (String(env.TYCON_INSTINCT_TELEGRAM_BOT_TOKEN || '').trim()) envAviso.TELEGRAM_BOT_TOKEN = env.TYCON_INSTINCT_TELEGRAM_BOT_TOKEN.trim();
  const N = require(path.join(__dirname, '..', 'lib', 'notify.js'));
  const s = N.canalesDeLaSesion({ env: envAviso });
  if (s.problema) { log(`no se manda el aviso: ${s.problema}`); return; }
  if (!s.canales.length) { log('ningún canal elegido en el perfil del equipo: no se manda el aviso'); return; }
  const chat = String(env.TYCON_INSTINCT_TELEGRAM_CHAT_ID || '').trim() || s.chat;
  const r = N.avisar({ canales: s.canales, texto: msg, env: envAviso, lado: 'sesion', mail: s.mail, chat });
  for (const x of r.resultados) log(x.entregado ? `aviso mandado por ${x.canal} (${count} pendientes)` : `el aviso no salió por ${x.canal}: ${N.limpiar(x.motivo, envAviso)}`);
}

// ============================================================
// Main
// ============================================================
function main() {
  // Antes de gastar una llamada al modelo: ¿hay dónde escribir? Sin poder resolver la casa de la persona en un árbol
  // que no trae su buzón no se escribe en ningún lado —nunca en el árbol—: se dice y se sale bien (corre desprendido).
  // Ninguna carpeta se crea acá: nacen al escribir el primer archivo (una corrida sin nada que proponer, o un
  // --dry-run, no deja rastro).
  try { DIRS.writePlace(); } catch (e) {
    if (!e || e.name !== 'InstinctDirsError') throw e;
    log(`${e.message}. No se escribe nada. Exit 0.`);
    process.exit(0);
  }
  // Lo que no se va a poder LEER se anota acá, una vez, antes de proponer: un clon declarado que no existe o una
  // configuración rota dejan lo ya decidido ahí sin mirar, y lo rechazado volvería a proponerse sin que nadie sepa por
  // qué. Las carpetas sueltas ilegibles las anota `existingHashes` (recorre las mismas que lee la revisión; por eso
  // `leerCarpeta`, que arma el pedido al modelo y no puede escribir en la salida de error, no las repite).
  for (const n of DIRS.readNotes()) log(`${n} — lo ya decidido ahí puede volver a proponerse`);
  // En --dry-run no se escribe nada, tampoco esta mudanza: la hace la próxima corrida de verdad.
  if (!dryRun) migrarDescartadosViejos();
  // Telegram: si se pidió avisar y no hay chat configurado, se dice UNA vez y al PRINCIPIO — al final,
  // con cero instintos nuevos, nunca se llegaría a saber. Configuración rota → un comando frena con archivo, clave y motivo.
  if (notify && process.env.TYCON_INSTINCT_NOTIFY === '1' && !process.env.TYCON_INSTINCT_TELEGRAM_CHAT_ID) {
    let chat = null;
    try { chat = chatConfigurado(); } catch (e) { if (e && e.name === 'ConfigError') { log(e.message); process.exit(2); } throw e; }
    if (!chat) log('Telegram apagado en esta máquina: sin chat configurado — el aviso de instintos nuevos no se va a mandar (prender: telegram.chat_id en ~/.claude/tycon.json, TYCON_TELEGRAM_CHAT_ID, o el plugin de Telegram)');
  }
  const executor = resolveExecutor();
  if (!executor) {
    log('Sin ejecutor de modelo disponible (ni claude, ni codex, ni ollama). Exit 0.');
    log('Instalá Claude Code o Codex, o corré Ollama; o exportá TYCON_INSTINCT_MINING=0.');
    process.exit(0);
  }
  const proposedBy = executorLabel(executor);

  const obs = loadObservations();
  log(`Loaded ${obs.length} observations from ${monthsToRead().join(', ')}`);
  if (obs.length === 0) {
    log('Sin observaciones, nada que analizar. Exit.');
    process.exit(0);
  }

  const candidates = findCandidates(obs);
  log(`Found ${candidates.length} candidate patterns (>=${MIN_OCCURRENCES} occurrences)`);
  if (candidates.length === 0) {
    log('Sin candidatos. Exit.');
    process.exit(0);
  }

  // El prompt muestra sólo los primeros 15 (cap de `buildPrompt`), así que «Candidate N» indexa
  // ESA lista. Se guarda aparte para que el conteo real se busque en la misma que vio el modelo.
  const candidatosMostrados = candidates.slice(0, 15);
  const prompt = buildPrompt(candidates, obs.length);
  log(`Calling ${proposedBy} (prompt ~${Math.round(prompt.length / 4)} tokens estimated)...`);

  let response;
  try {
    response = callModel(prompt, executor);
  } catch (e) {
    log(`ERROR calling ${proposedBy}: ${e.message}`);
    process.exit(2);
  }
  log(`Got response (${response.length} chars)`);

  const instincts = extractYamlArray(response);
  log(`Parsed ${instincts.length} instincts from response`);

  const existing = existingHashes();
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let written = 0;
  let skipped = 0;

  const aceptados = [];
  for (let i = 0; i < instincts.length; i++) {
    const inst = instincts[i];
    if (!inst.trigger || !inst.action) {
      skipped++;
      continue;
    }
    const conf = parseFloat(inst.confidence);
    if (isNaN(conf) || conf < MIN_CONFIDENCE) {
      log(`Skip "${inst.trigger}" — confidence ${conf} < ${MIN_CONFIDENCE}`);
      skipped++;
      continue;
    }
    const hash = instinctHash(inst.trigger, inst.action);
    if (existing.has(hash)) {
      log(`Skip "${inst.trigger}" — already exists (${hash})`);
      skipped++;
      continue;
    }
    aceptados.push({ inst, i, conf });
  }

  // Lo que llegaría a la bandeja se revisa contra lo que ya existe (ver promptDeRevision).
  let veredictos = null;
  let revision = null;
  if (aceptados.length) {
    revision = promptDeRevision(aceptados.map((a) => a.inst), candidatosMostrados, executor);
    if (!revision.prompt) {
      log('Sin catálogo ni instintos decididos legibles: lo propuesto va a la bandeja SIN revisar contra lo que ya existe.');
    } else {
      if (revision.sinDecididos) log('Sin instintos decididos legibles: la revisión compara sólo contra el catálogo.');
      if (revision.sinCatalogo) log('Sin catálogo legible: la revisión compara sólo contra los instintos decididos.');
      log(`Calling ${proposedBy} para revisar ${aceptados.length} propuesta(s) (prompt ~${Math.round(revision.prompt.length / 4)} tokens estimated)...`);
      try {
        const respuesta = callModel(revision.prompt, executor);
        veredictos = leerRevision(respuesta, aceptados.length);
        log(veredictos.size
          ? `Revisión: ${veredictos.size} veredicto(s) para ${aceptados.length} propuesta(s)`
          : `La revisión contestó algo que no se entendió — lo propuesto sigue sin revisar: ${respuesta.slice(0, 200).replace(/\s+/g, ' ')}`);
      } catch (e) {
        log(`La revisión contra lo que ya existe falló — lo propuesto sigue sin revisar: ${e.message}`);
      }
    }
  }

  let descartados = 0;
  for (let k = 0; k < aceptados.length; k++) {
    const { inst, i, conf } = aceptados[k];
    const veredicto = veredictos && veredictos.get(k + 1);
    const decision = veredicto ? decidirDescarte(veredicto, revision, k) : null;
    if (decision && decision.cita) {
      log(`Descartada "${inst.trigger}" — ya lo cubre ${decision.cita}${veredicto.why ? `: ${veredicto.why}` : ''}`);
      if (!dryRun) dejarConstanciaDeDescarte(inst, i, ts, proposedBy, candidatosMostrados, decision.cita, veredicto.why);
      skipped++;
      descartados++;
      continue;
    }
    if (decision && decision.sigue) log(`Sigue "${inst.trigger}" — ${decision.sigue}`);
    if (dryRun) {
      log(`[dry-run] Would write: ${inst.trigger} (conf=${conf})`);
    } else {
      const fpath = writeInstinct(inst, i, ts, proposedBy, candidatosMostrados);
      log(`Wrote ${path.basename(fpath)}`);
    }
    written++;
  }

  log(`Done. Written=${written} Descartadas=${descartados} Skipped=${skipped} (dry-run=${dryRun})`);
  if (!dryRun) maybeNotify(written, descartados);
  process.exit(0);
}

// Se exporta lo que arma y lee la revisión para probarlo sin modelo
// (scripts/tests/instinct-observer-catalog.test.sh); requerir el archivo no corre el observador.
module.exports = {
  buildPrompt, catalogoDetallado, instintosYaDecididos, topeDecididos, promptDeRevision, leerRevision,
  citaVerificada, decidirDescarte, contextoOllama, migrarDescartadosViejos, maybeNotify,
};

if (require.main === module) main();
