/**
 * pipeline-shared.js — una parte de pipeline.js (la cargan todas las demás).
 *
 * Responsabilidad: el estado de pipeline.js y lo que comparten sus partes.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
// lo que cambia mientras corre, y las rutas del despachador (que las fija al cargar este módulo): se leen de acá en
// el momento de usarlas, nunca copiadas
const path_ = require('path');
const estadoPipeline = {
  avisosDelPorton: [],
  paraOtra: null,
  SCRIPTS_DIR: path_.join(__dirname, '..'),
  PIPELINE_JS: path_.join(__dirname, '..', 'pipeline.js'),
};
// Sin `?.` ni `??`: este guion lo tiene que poder leer un Node viejo hasta llegar a la guarda. Misma semántica: sólo null
// y undefined cuentan como «no hay» (0, '' y false se quedan).
const isNil = (v) => v === undefined || v === null;
const nn = (v, d) => (isNil(v) ? d : v);
const at = (o, k) => (isNil(o) ? undefined : o[k]);

/**
 * `--codex-session '{"oss":true,"provider":"ollama","model":"<m>","config":["k=v"]}'`: la sesión de Codex con que
 * corren los revisores de `reviewers-run`. Una forma que no se entiende frena: lanzar con otro modelo en silencio
 * sería peor que no arrancar.
 */
function parseCodexSession(raw) {
  let s;
  try { s = JSON.parse(String(raw)); } catch (e) { process.stderr.write(`--codex-session no es JSON (${e.message})\n`); process.exit(2); }
  const ok = s && typeof s === 'object' && !Array.isArray(s)
    && (s.oss === undefined || typeof s.oss === 'boolean')
    && ['provider', 'model'].every((k) => s[k] === undefined || (typeof s[k] === 'string' && s[k].trim() && !s[k].startsWith('-')))
    && (s.config === undefined || (Array.isArray(s.config) && s.config.every((c) => typeof c === 'string' && /^[\w.-]+=/.test(c))));
  if (!ok) {
    process.stderr.write('--codex-session: se espera {"oss":bool,"provider":"…","model":"…","config":["clave=valor"]}\n');
    process.exit(2);
  }
  // un proveedor sólo se pasa con `--oss`: aceptarlo sin él lanzaría con el proveedor por defecto de Codex en silencio
  if (s.provider && s.oss !== true) {
    process.stderr.write('--codex-session: "provider" va con "oss": true (sin él Codex usa su proveedor por defecto)\n');
    process.exit(2);
  }
  // los revisores corren con el sandbox y la aprobación de su perfil: una opción de la sesión no los afloja
  const floja = (s.config || []).filter((c) => /^(sandbox|approval)/i.test(c));
  if (floja.length) {
    process.stderr.write(`--codex-session: ${floja.join(', ')} cambiaría el sandbox o la aprobación de los revisores; eso lo fija su perfil\n`);
    process.exit(2);
  }
  return s;
}

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // la carpeta del estado, de una sola pieza
const { homeCommand } = require('./home-command.js');
const os = require('os');
const companionLib = require('./companion-repos.js');   // el repo hermano de una story de dos repos
const codeFiles = require('./code-files.js');         // qué es código, qué es prueba (una sola lista)
const stackConfig = require('./stack-config.js');     // lo que sume la organización (team-repos.json → stack)

// ── log de invocaciones reales de advisors ─────────────────
// El hook on-advisor-run.js (PreToolUse Task) registra cada subagent spawneado acá.
// `advisors` marca el inicio del paso de revisores; `check-count` lee lo corrido DESDE esa marca
// como ground-truth, en vez de confiar en el `--ran` que el LLM redacta.
const RUNS_DIR = path.join(stateDirOf(os.homedir()), 'advisor-runs');
function sessionLogPath() {
  const sid = sessionIdFileKey();
  return path.join(RUNS_DIR, `${sid}.jsonl`);
}

// Bajo Codex los revisores no los lanza el modelo: los lanza `reviewers-run`. La salida de `advisors` y `smart-reloop`
// y el error de `check-count` dan el comando listo para pegar; un modelo sin la herramienta de agentes no lo deduce.
const esCodex = () => require('./external-flags.js').esCodex(process.env);

// ── helpers de lectura (todas fail-safe: nunca tiran) ────────────────────────
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
// Dónde nace la evidencia de cierre de una story: el repo que la CONTIENE.
const { evidenceDirForStory } = require('./evidence-config.js');
const { evidenceKey, keyOr: evidenceKeyOr } = require('./evidence-key.js');
function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ── Los revisores del núcleo, declarados ──
// Las condiciones de arriba son código; esta tabla las dice como datos, para mostrarlas («Cómo trabaja», en el sitio de la
// organización). Una fila por revisor: el grupo (`always`: siempre que hay código · `story`: según la historia · `change`:
// según lo que toca el cambio), la clave del texto de «cuándo» (los textos viven en scripts/site/texts.js) y un caso
// que lo hace entrar: archivos con su contenido, una historia y, si hace falta, el `.tycon/advisors.yaml` del repo.
// `coreReviewersDrift` corre cada caso por `computeAdvisorSet` y frena si la tabla y el cálculo se separan.
const STORY_GOLD = '---\nstory: "9.9"\n---\n\n## Acceptance Criteria\n\n1. algo\n\n### Tests\n\n| # | Nombre | AC |\n|---|---|---|\n| T1 | `Algo` | 1 |\n';

// Los valores viven en lib/models.js: un solo lugar para el modelo de cada trabajo.
const MODELOS = require('./models.js');

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
const packsLib = require('./packs.js');

/**
 * Escribe campos en el marcador de esta sesión (y, si viene, aplica `cambio`). → `{ ok, marker }` o `{ ok: false,
 * motivo }`: un marcador que no está no es lo mismo que uno que no se pudo leer o escribir, y el motivo lo dice.
 */
function anotarEnMarker(campos, cambio) {
  const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`);
  let m;
  try { m = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (e) {
    return { ok: false, motivo: e && e.code === 'ENOENT' ? 'no hay marker activo para esta sesión' : `no pude leer el marcador de esta sesión (${(e && (e.code || e.message)) || 'error'})` };
  }
  Object.assign(m, campos);
  if (cambio) cambio(m);
  m.lastTouch = new Date().toISOString();
  try {
    const tmp = `${markerPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch (e) { return { ok: false, motivo: `no pude escribir el marcador de esta sesión (${(e && (e.code || e.message)) || 'error'})` }; }
  return { ok: true, marker: m };
}

const { matchGlob } = require('./match-glob.js');   // la comparación de rutas contra globs (también la usa la lista de deprecados)

// Lee el marker de ESTA sesión desde ~/.claude/.tycon-pipeline/active/<sid>.json
// (read-only — pipeline.js no muta marker; eso lo hace marker.js).
function readSessionMarker() {
  const sid = sessionIdFileKey();
  const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sid}.json`);
  // las rutas de la corrida, absolutas contra su repo (lib/run-dir.js): un marcador de antes con rutas relativas se lee
  // igual desde cualquier carpeta
  try { return require('./run-dir.js').marcadorConRutas(JSON.parse(fs.readFileSync(markerPath, 'utf8'))); } catch { return null; }
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

function storyRequiresRuntimeEvidenceCheck(content) {
  // Misma heurística que on-frontmatter-write.js#storyRequiresRuntimeEvidence
  if (!content) return false;
  return /tests_done_playwright|tests_done_smoke|smoke.*runtime|FullUI-|E2E-|tests\/e2e\/|verify.*runtime|playwright/i.test(content);
}

function storyIsExemptCheck(content) {
  return /^\s*dod_runtime_exempt:\s*true\b/m.test(content || '');
}

// ── pipeline.js next — máquina de estados incremental ─────────────
// Primer comando de la máquina de estados: el LLM sigue siendo el loop
// pero le PREGUNTA al script cuál es el próximo step y qué
// skip-conditions se cumplen mecánicamente, en vez de derivarlo de la prosa del
// SKILL (fuente de los skips-por-inferencia E.i).
// La secuencia, los nombres, las banderas que dan un paso por hecho y la equivalencia con el marcador viejo salen de la
// tabla única de pasos (lib/steps.js): los once que recorre `next`; el cierre en ADO va aparte.
const STEPS_TABLE = require('./steps.js');

/**
 * El evento neutro de trabajo del arnés que ve esta corrida (`scripts/lib/work-signal.js`), con su lector de
 * configuración: `{ ws, TC }`, o null si no está (arnés viejo, o sin arnés). El pipeline no sabe con qué herramienta se
 * registran las horas: se lo pregunta a ese evento.
 */
function harnessWorkSignal(opts = {}) {
  const env = opts.env || process.env;
  const dir = require('./harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
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

// ── pipeline.js deep-review-gate — pase adversarial ──
// Decide si corre el pase adversarial reproduce-or-refute (la guía del paso «Pase adversarial»),
// que EJECUTA el código (bundlea/parsea/probe) en vez de LEER el diff como los 6 advisors
// single-pass: así encuentra falsos negativos (p.ej. un traversal en lanes/participants) que ellos no ven.
//
// Gate (siempre en NORMAL) = REUSA risk-class:
//   NORMAL → corre (donde el juicio de correctitud-en-runtime paga) · LOW → skip (superficie
//   chica ≤6 files, ya barata). Overrides, en orden de precedencia:
//   1) la constancia firmada por el dueño para esta ejecución (lib/adversarial-skip.js): saltea, con el pedido o sin él.
//      `--no-deep-review`, `TYCON_NO_DEEP_REVIEW=1` y `deep_review: off` son PEDIDOS: sin constancia el pase corre.
//   2) .tycon/advisors.yaml `deep_review: always|auto` (`off` es un pedido, punto 1)
//   3) --deep-review (fuerza on aun en LOW) / --ultracode (el orquestador lo pasa si ultracode ON)
//   4) .tycon/advisors.yaml `deep_review_always_paths:` — SUPERFICIE COMPARTIDA del repo: si el
//      diff toca una de esas rutas, corre AUNQUE el risk-class dé LOW. Está en el 4to
//      lugar a propósito: no puede pisar el kill-switch ni el `off` del dueño del repo, pero sí
//      gana sobre el criterio por tamaño de diff, que puede dejar pasar un defecto en superficie compartida.
//   4d) el código va a un repo hermano con su corrida a la vista (lib/delegated-pass.js): esa corrida decide el pase.
//   5) default → risk-class (NORMAL run / LOW skip). Si el repo NO declaró superficie compartida,
//      el skip por LOW se decide a ciegas y el veredicto lo dice (`shared_surface_declared:false`).
// Corre UNA vez por corrida (default: se lanza al cierre de «Correr las pruebas» y el paso del pase adversarial es el join; TYCON_5B_EARLY=0 → se lanza en su paso), NUNCA por re-loop D.i
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

// avisosDelPorton: vive en estadoPipeline.avisosDelPorton
// El camino del pedido de saltear el pase, o null: la bandera, la variable o `deep_review: off` del repo. La política de
// la organización (`args.orgDeepReview`) nunca es un pedido: sólo puede ser always o auto.
function pedidoDeSalteo(args) {
  if (args.noDeepReview) return args.noDeepReviewFrom || '--no-deep-review';
  return deepReviewConfig(args.repo) === 'off' ? 'deep_review: off' : null;
}

// La ejecución de la corrida que el portón mira: story, carpeta y comienzo. Sin corrida de esta story, null.
// La story del marcador resuelta contra su repo, como en marker.js, o null.
function storyDelMarcador(m) {
  return m && m.storyPath ? path.resolve(m.repoPath || process.cwd(), m.storyPath) : null;
}

// ¿Es `story` la del marcador? Las dos sin enlaces; sin una de las dos, sí.
function esLaStoryDelMarcador(story, m) {
  const delMarcador = storyDelMarcador(m);
  if (!story || !delMarcador) return true;
  const { carpetaReal } = require('./adversarial-skip.js');
  return carpetaReal(story) === carpetaReal(delMarcador);
}

function ejecucionDeLaCorrida(args, corrida) {
  if (!corrida || !corrida.storyId || !corrida.startedAt) return null;
  const { carpetaReal } = require('./adversarial-skip.js');
  if (!esLaStoryDelMarcador(args.story, corrida)) return null;
  const repo = corrida.repoPath || args.repo;
  const rd = repo ? resolveRunDir(path.resolve(repo), corrida.storyId, false, storyDelMarcador(corrida) || args.story, { marker: corrida }) : null;
  const carpeta = rd ? carpetaReal(rd) : null;
  return { story: String(corrida.storyId), carpeta, ejecucion: corrida.startedAt };
}
const { resolveSessionId, sessionIdFileKey } = require("./session-id.js");

// { marker, error }: un marker.js que falla se DICE, no se lee como «sin corrida» (patrón de coverage-base.js).
function leerMarcadorDeLaCorrida() {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js'), 'get'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (r.error) return { marker: null, error: `marker.js get no corrió (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { marker: null, error: `marker.js get salió ${r.status}` };
  try { return { marker: JSON.parse(r.stdout || '{}'), error: null }; } catch (e) { return { marker: null, error: `marker.js get devolvió algo ilegible (${e.message})` }; }
}

function deriveStoryId(storyPath) {
  if (!storyPath || !exists(storyPath)) return null;
  const fm = parseFrontmatterPipeline(readText(storyPath));
  return String(fm.story || path.basename(storyPath, '.md')).trim() || null;
}

// La clave y la carpeta de la corrida viven en `lib/run-dir.js` (módulos livianos las piden sin cargar el pipeline);
// acá quedan con los mismos nombres para quien ya las usa.
function runDirKey(storyId, storyPath) {
  return require('./run-dir.js').runDirKey(storyId, storyPath);
}

// `opts` ({ marker, sessionId }) va tal cual: es el que decide qué marcador mira la regla (lib/run-dir.js)
function resolveRunDir(repo, storyId, create, storyPath, opts) {
  return require('./run-dir.js').resolveRunDir(repo, storyId, create, storyPath, opts);
}

// La firma pedida para otra sesión (`--for-session <D>`): acá la vuelta extra de revisores y contar los revisores sin la
// constancia de que corrieron (`check-count --trust-ran`). Hasta la firma el guion
// sólo lee la corrida de <D>; la firma la pide la sesión que corre el guion (PROPIA, la de antes de cambiar nada), y
// recién después `fijarDestino` deja el proceso, y los guiones que lance, trabajando sobre <D>.
const PROPIA = sessionIdFileKey();
// paraOtra: vive en estadoPipeline.paraOtra   // { pedida, storyId } mientras el guion trabaja para otra sesión
const ownerWindow = () => require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
function paraOtraSesion(cmd, args, argv) {
  const i = argv.indexOf('--for-session');
  const pedida = i >= 0 ? argv[i + 1] : null;
  if (!pedida || pedida === PROPIA) return null;
  // sin variable de sesión y sin terminal no hay quién pida la firma para otra sesión
  if (PROPIA === '_nosession' && !argv.includes('--terminal')) return '🛑 Sin variable de sesión, la firma para una sesión se da en la terminal de la persona (--terminal). No escribí nada.\n';
  const contar = cmd === 'check-count';
  if (contar && !args.trustRan) return '🛑 --for-session en check-count va sólo con --trust-ran: contar los revisores de otra sesión sin firma no es una firma. No escribí nada.\n';
  if (!contar && (!['smart-reloop', 'advisors'].includes(cmd) || !args.extraRound)) {
    return `🛑 --for-session con otra sesión vale acá sólo para la vuelta extra de revisores (smart-reloop --extra-round) y para check-count --trust-ran: ${cmd || '(sin subcomando)'} se corre desde la sesión destino. No escribí nada.\n`;
  }
  if (!/^[\w-]+$/.test(pedida)) return '🛑 La sesión de --for-session no se puede leer. No escribí nada.\n';
  if (pedida === '_nosession') return '🛑 «_nosession» es el nombre de «sin sesión», no una sesión: la firma se pide para la sesión destino por su id. No escribí nada.\n';
  let abierta;
  const noEncontre = (motivo) => `🛑 No encontré la corrida de la sesión ${pedida}: ${motivo}. No escribí nada.\n`;
  try { abierta = ownerWindow().marcadorEn(path.join(stateDirOf(os.homedir()), 'active', `${pedida}.json`)); } catch (e) { return noEncontre(e.message); }
  if (!abierta && !contar) return noEncontre('no está su marcador');
  if (!abierta || !abierta.storyId) {
    return `🛑 La sesión ${pedida} no tiene una ejecución abierta: no hay corrida ${contar ? 'que contar' : 'para la vuelta extra'}. No escribí nada.\n`;
  }
  estadoPipeline.paraOtra = { pedida, storyId: String(abierta.storyId) };
  if (contar) {
    // la historia que se cuenta es la de la corrida de <D>; el registro de sus revisores se lee recién con la firma
    const repoAbs = path.resolve(args.repo || '.');
    const storyAbs = args.story ? (path.isAbsolute(args.story) ? args.story : path.join(repoAbs, args.story)) : null;
    const nombrada = storyAbs ? deriveStoryId(storyAbs) : null;
    if (!nombrada || String(nombrada) !== estadoPipeline.paraOtra.storyId) {
      return `🛑 La corrida de la sesión ${pedida} es de la story ${estadoPipeline.paraOtra.storyId}, y --story ${args.story ? `nombra la ${nombrada || args.story}` : 'no está'}. No escribí nada.\n`;
    }
    // el mismo número no alcanza: tiene que ser el archivo de la corrida, como en runtime-waiver
    if (!require('./waiver-display.js').esLaDelMarcador(storyAbs, abierta)) {
      return `🛑 ${path.basename(storyAbs)} no es el archivo de la historia de la corrida de la sesión ${pedida} (${abierta.storyPath || 'sin ruta en su marcador'}). No escribí nada.\n`;
    }
    return null;
  }
  // la vuelta es de la corrida de <D>, no de la carpeta desde donde se pide: sin --repo, el de su marcador; lo relativo,
  // contra ese repo; sin --files, lo que su corrida tocó en ese repo
  const repoDeLaCorrida = typeof abierta.repoPath === 'string' && abierta.repoPath ? abierta.repoPath : null;
  if (!argv.includes('--repo') || !path.isAbsolute(String(args.repo))) {
    if (!repoDeLaCorrida) return `🛑 La corrida de la sesión ${pedida} no dice su repo: pasá --repo con la ruta completa. No escribí nada.\n`;
    args.repo = argv.includes('--repo') ? path.resolve(repoDeLaCorrida, String(args.repo)) : repoDeLaCorrida;
  }
  if (!args.story && typeof abierta.storyPath === 'string' && abierta.storyPath) args.story = abierta.storyPath;
  else if (args.story && !path.isAbsolute(String(args.story))) args.story = path.resolve(args.repo, String(args.story));
  if (!args.files.length) {
    // lo que la corrida tocó en su repo y en sus repos hermanos (el código de una historia del privado vive en el
    // público), sin los probes del pase, sin lo de la carpeta de la corrida y sin lo que ya no está
    const raiz = path.resolve(args.repo);
    const lh = require('./ledger-honesty.js');
    let hermanos = [];
    try { hermanos = require('./companion-repos.js').companionRoots(raiz, args.story || null); } catch (e) {
      process.stderr.write(`⚠️  No pude leer los repos hermanos de ${raiz} (${e.message}): la vuelta va sólo con los archivos de ese repo.\n`);
      hermanos = [];
    }
    const dentro = (f, r) => { const rel = path.relative(r, f); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    const suyos = lh.sinRuido((Array.isArray(abierta.filesTouched) ? abierta.filesTouched : []).map((f) => path.resolve(raiz, String(f))))
      .filter((f) => exists(f) && (dentro(f, raiz) || hermanos.some((h) => dentro(f, path.resolve(h)))))
      .map((f) => (dentro(f, raiz) ? path.relative(raiz, f) : f));
    if (!suyos.length) return `🛑 La corrida de la sesión ${pedida} no tocó archivos en ${raiz} ni en sus repos hermanos: pasá --files con los de la vuelta. No escribí nada.\n`;
    args.files = [...new Set(suyos)];
    args.filesDeclarado = true;
  }
  // hasta la firma, sólo para leer su corrida: nada se escribe antes (topeDeVueltas)
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) if (k === 'CLAUDE_CODE_SESSION_ID' || process.env[k]) process.env[k] = pedida;
  return null;
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
    else if (t === '--to') a.to = argv[++i];                         // move-story: la ruta nueva de la historia
    else if (t === '--files') { a.filesDeclarado = true; while (argv[i + 1] && !argv[i + 1].startsWith('--')) a.files.push(argv[++i]); }
    else if (t === '--ran') a.ran = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--iter') a.iter = parseInt(argv[++i], 10) || 1;
    else if (t === '--force-full-reloop') a.forceFullReloop = true;
    else if (t === '--story-path') a.storyPath = argv[++i];
    else if (t === '--target-status') a.targetStatus = argv[++i];
    else if (t === '--target-pipeline-done') a.targetPipelineDone = argv[++i];
    else if (t === '--cost-tier') a.costTier = argv[++i];
    else if (t === '--trust-ran') a.trustRan = true;
    else if (t === '--adhoc') a.adhoc = true;
    else if (t === '--reopen') a.reopen = true;                      // ado-mark-active: reabrir un pedido cerrado
    else if (t === '--assign-to') a.assignTo = argv[++i];            // ado-mark-active: con auto_assign, a quién
    else if (t === '--action-done') a.actionDone = nn(argv[++i], ''); // work-signal start: el id que devolvió la herramienta
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
    else if (t === '--validators') a.validadores = argv[++i];      // validation-record: los validadores que corrieron, separados por coma
    else if (t === '--verifier-model') a.modeloVerificador = argv[++i];
    else if (t === '--model') a.modelo = argv[++i];                // verify-finding: modelo del verificador (default sonnet)
    else if (t === '--deep-review') a.deepReview = true;           // fuerza ON el pase adversarial (aun en LOW)
    else if (t === '--no-deep-review') { a.noDeepReview = true; a.noDeepReviewFrom = '--no-deep-review'; }   // un pedido: sin la firma del dueño el pase corre
    else if (t === '--deep-review-opus') a.deepReviewOpus = true;  // hunters/verifiers en Opus (default sonnet)
    else if (t === '--deep-review-fable') a.deepReviewFable = true; // hunters en Fable — SOLO con autorización explícita del user
    else if (t === '--ultracode') a.ultracode = true;             // el orquestador lo pasa si ultracode está ON
    else if (t === '--brief') a.breve = true;                      // start: salida recortada + ruta del JSON entero
    else if (t === '--batch') a.batch = nn(argv[++i], '');         // start: la tanda de una historia paraguas
    else if (t === '--session-model') a.sessionModel = nn(argv[++i], '');   // start / model-hint: el modelo de la sesión
    else if (t === '--codex-session') a.codexSession = parseCodexSession(argv[++i]); // start: la sesión de Codex (proveedor y modelo)
    else if (t === '--run-dir') a.runDir = argv[++i];              // write-findings/findings-status: dir de la corrida (default: auto-resolve)
    else if (t === '--extra-round') a.extraRound = true;          // smart-reloop / advisors: la vuelta más allá del tope que autoriza una persona
    else if (t === '--approved-by') a.approvedBy = argv[++i];     // con --extra-round: quién la autorizó
    else if (t === '--quote') a.quote = argv[++i];                // con --extra-round: sus palabras, textuales
    else if (t === '--delegated') a.delegated = true;             // con --extra-round: ya no la autoriza; se reconoce para negarlo
    else if (t === '--base') a.base = argv[++i];                  // dod-checker-needed: base explícita del diff
    else if (t === '--scope') a.scope = nn(argv[++i], '');          // qa-readability: `ui` = la revisión de la pantalla; sin valor no es «sin --scope»
    else if (t === '--marks') a.marcas = argv[++i];               // qa-readability: marcas resueltas
    else if (t === '--reason') a.motivo = argv[++i];              // story-review-record: el motivo de un salteo
    else if (t === '--model-reason') a.modelReason = argv[++i];   // story-review-record: de dónde salió el modelo
    else if (t === '--tokens') a.tokens = argv[++i];              // story-review-record: lo que gastó el revisor
    else if (t === '--duration-ms') a.duracionMs = argv[++i];     // story-review-record: lo que tardó
    else if (t === '--risk') a.riesgo = argv[++i];                // story-review-record: el riesgo que dio el portón
    else if (t === '--run') a.run = argv[++i];                    // estimate-real: la ejecución que cierra la historia
    else if (t === '--hours') { a.hoursGiven = true; i++; }        // estimate-real: no existe; se reconoce para negarlo
    // e2e-config: archivos que la entrega tocó (repo-relativos) para elegir qué apps del
    // monorepo ejerce el gate. Admite `--changed a b c` y `--changed a,b,c`.
    else if (t === '--changed') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        a.changed.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
      }
    }
  }
  // La variable es un pedido de saltear el pase, igual que la bandera: sin la firma del dueño el pase corre.
  if (process.env.TYCON_NO_DEEP_REVIEW === '1') { a.noDeepReview = true; a.noDeepReviewFrom = a.noDeepReviewFrom || 'TYCON_NO_DEEP_REVIEW=1'; }
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

module.exports = { estadoPipeline, isNil, nn, at, parseCodexSession, fs, path, stateDirOf, homeCommand, os, companionLib, codeFiles, stackConfig, RUNS_DIR, sessionLogPath, esCodex, readText, evidenceDirForStory, evidenceKey, evidenceKeyOr, exists, STORY_GOLD, MODELOS, packsLib, anotarEnMarker, matchGlob, readSessionMarker, logGate, parseFrontmatterPipeline, storyRequiresRuntimeEvidenceCheck, storyIsExemptCheck, STEPS_TABLE, harnessWorkSignal, deepReviewConfig, pedidoDeSalteo, storyDelMarcador, esLaStoryDelMarcador, ejecucionDeLaCorrida, resolveSessionId, sessionIdFileKey, leerMarcadorDeLaCorrida, deriveStoryId, runDirKey, resolveRunDir, PROPIA, ownerWindow, paraOtraSesion, parseArgs };
