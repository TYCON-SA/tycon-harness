// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * story-discovery.js — el ÚNICO descubridor de stories Mary+GOLD del arnés.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * `on-edit.js` tiene un segundo freno además del marker: cuando NO hay corrida de pipeline activa y
 * el archivo editado está declarado en el `files_to_create`/`files_to_modify` de alguna story, avisa
 * "estás editando archivos de una story sin invocar tycon-pipeline". Ese aviso es la única capa que
 * cubre el trabajo hecho a mano — justo el que se saltea el gate de ATDD, que vive dentro del
 * pipeline (`complete-step implement`).
 *
 * ── CÓMO DECIDE QUÉ ES UNA STORY ──────────────────────────────────────────────────────────────────
 * La pertenencia la decide la ESTRUCTURA, nunca el nombre ni la ubicación: **una story es un `.md`
 * cuyo frontmatter declara `story:` y `status:`**. Es el mismo principio que el repo aplica
 * en todos lados (el frontmatter es el contrato; el layout es decoración).
 * Una lista de rutas o de nombres de carpeta se queda vieja el día que alguien crea otra: dos stories
 * hechas a mano fuera de la lista no dispararían el aviso y el ATDD se saltaría en silencio. Con un repo
 * cuyas stories viven en `specs/<producto>/`, el escaneo por nombre encontraría CERO carpetas: el
 * aviso de on-edit mudo, `pipeline.js next-story` en null, y `tycon-backfill-followups.js`
 * reportando "0 stories Mary+GOLD encontradas".
 *
 * ── DOS COSAS QUE LA ESTRUCTURA SOLA NO RESUELVE ─────────────────────────────────────────────────
 * 1. **No todo lo que tiene forma de story es trabajo.** `mcp/eval/bancos/…/ev*.md` declara
 *    `story: "EV-1"` + `status: ready-for-dev` y es INSUMO de las evals, no backlog del repo. El
 *    discriminador también es estructural, pero de otro eje: la FORMA del id (`4.43` es una story,
 *    `EV-1` es material). Si algún repo usa otra forma, la declara —una vez, explícita— en
 *    `.tycon/advisors.yaml → stories.id_pattern`. Lo excluido se CUENTA (`result.excluded`): un
 *    filtro que descarta en silencio es el próximo "0 stories encontradas".
 * 2. **Esto corre en CADA edición**, con presupuesto de tiempo. Por eso: se leen sólo los primeros
 *    bytes de cada `.md` (el frontmatter, no el cuerpo), no se baja a carpetas ocultas ni a las que
 *    nunca tienen specs, se recorre primero lo que suele tener specs (`specs/`, `docs/`… — el
 *    nombre decide el ORDEN, jamás la pertenencia), y el resultado se cachea por raíz de repo.
 *    Un resultado incompleto se marca `partial` y, si además vino VACÍO, NO se persiste: cachear
 *    un cero dejaría el repo mudo una hora entera.
 *
 * Diagnóstico: `node lib/story-discovery.js --doctor [--repo <dir>]`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./state-dir.js');   // La carpeta del estado, de una sola pieza
/**
 * Tope de tiempo del escaneo FRÍO (el caliente sale del cache y cuesta ~2ms).
 *
 * 🔴 Es un TOPE, no un costo: en una máquina sana el escaneo completo del repo más grande del
 * equipo (1215 carpetas / 1331 `.md`) mide ~330ms, y los otros entre 60 y
 * 100ms — o sea que este número casi nunca se toca. Con la máquina
 * cargada (load average 40 sobre 8 cpus), 200ms no alcanzan
 * ni para llegar a `specs/`, y el escaneo devolvería CERO stories: el síntoma que se evita
 * con un presupuesto de tiempo en vez de un filtro por nombre. Subirlo no cuesta nada cuando
 * las cosas van bien y evita quedarse mudo cuando no.
 */
const DEFAULT_BUDGET_MS = 500;
// El que se usa: la variable del dev si la puso, si no el default. Separados: con uno solo, la prueba del
// default leería la variable del ambiente, y el dev que la subiera —como le recomienda el aviso de abajo— dejaría la suite
// del arranque en «FALLÓ» y el arnés sin actualizarse.
const BUDGET_MS = Number(process.env.TYCON_STORY_SCAN_BUDGET_MS) || DEFAULT_BUDGET_MS;
const MAX_DEPTH = 6;
/** `v`, o `d` si `v` es null o undefined (sin `??`: este guion lo tiene que poder leer un Node viejo). */
const nn = (v, d) => (v === undefined || v === null ? d : v);

/** Bytes de cabecera que se leen para ver el frontmatter. Es una optimización, no un límite. */
const HEAD_BYTES = 8192;
/** Tope de la relectura completa cuando el frontmatter no cerró en la cabecera. */
const FULL_READ_LIMIT = 256 * 1024;

/** Carpetas que nunca contienen specs y sí contienen decenas de miles de archivos. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'coverage',
  'target', 'vendor', 'venv', '__pycache__', 'TestResults', 'Pods',
]);

/**
 * Las carpetas OCULTAS no llevan specs: `.git`, `.next`, `.venv`, `.engram`, `.github`, `.vscode`
 * y —la que más pesaba— `.advisors`, que es la SALIDA del propio arnés (700+ `.md` de reportes de
 * corridas en un repo del equipo). Es una regla general, no una lista de nombres que haya que mantener:
 * mismo criterio que `hasPlaywrightSpecs` de pipeline.js.
 *
 * 🔴 …salvo `.specs/`: la premisa "las ocultas no llevan
 * specs" es FALSA en algunos repos, que guardan sus fichas en `.specs/<área>/stories/`; sin la excepción
 * el buscador devolvería 0 stories para ellos. La excepción es,
 * a sabiendas, una lista-de-nombres del tipo que el párrafo de arriba evita — se acepta como
 * escape CONSCIENTE y mínimo (1 nombre, convención propia del equipo, con sus casos en la suite);
 * si aparece otro nombre oculto con specs, ahí se repiensa el criterio, no se agranda la lista.
 */
const HIDDEN_WITH_SPECS = new Set(['.specs']);
const isHidden = (name) => name.startsWith('.') && !HIDDEN_WITH_SPECS.has(name);

/**
 * Orden de recorrido (NO de pertenencia): las carpetas que suelen tener specs se visitan primero,
 * así un escaneo que se queda sin presupuesto igual devuelve las stories de verdad en vez de
 * haberse gastado el tiempo en la salida de un banco de evals. Cambiar esta lista no puede
 * cambiar QUÉ se encuentra con presupuesto suficiente — sólo en qué orden.
 */
const LIKELY_SPEC_DIR = /^(?:specs?|docs?|stories|epics?|sprints?|planning|backlog|requirements)(?:[-_.]|$)/i;

/** Forma canónica de un id de trabajo: jerárquico numérico (`4.43`, `1.11`, `2-10`, `9`). */
const DEFAULT_ID_RE = /^\d+(?:[.-]\d+)*$/;

const CACHE_PATH = path.join(stateDirOf(os.homedir()), 'story-dirs-cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — el árbol de carpetas casi no cambia
const CACHE_VERSION = 4;             // subir el número invalida al instante los índices cacheados con otro criterio:
                                     // uno que dijera "0 stories" COMPLETO (no parcial) se serviría 1h más.

/** Sube desde un archivo/carpeta hasta encontrar la raíz del repo git. Null si no hay. */
function findRepoRoot(startPath) {
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  for (let i = 0; i < 30; i++) {
    // `.git` puede ser un archivo (worktree) — existsSync cubre ambos.
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * ¿Este id tiene forma de trabajo del repo, o es material que sólo LUCE como story?
 * `pattern` (opcional) es el escape declarado por el repo en `.tycon/advisors.yaml`.
 */
function isWorkStoryId(id, pattern) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  return (pattern || DEFAULT_ID_RE).test(trimmed);
}

// ── Config del repo: `.tycon/advisors.yaml → stories.id_pattern` ──────────────────────────────
// Mismo parser-YAML-mínimo-sin-deps que i18nRequired/e2eConfig de pipeline.js y evidence-config.js.
/**
 * Desenvuelve un escalar YAML respetando el tipo de comilla. El valor acá es un REGEX, o sea que
 * está lleno de barras invertidas y la diferencia importa: en YAML, `'\d+'` (comilla simple) llega
 * tal cual, mientras que `"\\d+"` (comilla doble) llega como `\d+`. Un parser que sólo pela las
 * comillas convierte el segundo en `\\d+` —"barra literal seguida de d"— y el patrón deja de
 * matchear sin decir por qué. La forma recomendada es la comilla simple; las dos funcionan.
 */
function unquoteScalar(rawValue) {
  const v = rawValue.replace(/\s+#.*$/, '').trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * El bloque `stories:` de un TEXTO de config (no de un archivo). Separado del lector para que el
 * modo-freno pueda parsear la versión commiteada y la de la carpeta con el MISMO parser —
 * dos parsers del mismo bloque es el drift de mañana.
 */
function parseStoriesConfigText(txt) {
  const out = { idPattern: null, source: null, warnings: [] };
  if (!txt) return out;

  let inBlock = false; let blockIndent = 0; let raw = null;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (/^stories\s*:/.test(line)) { inBlock = true; blockIndent = indent; }
      continue;
    }
    if (indent <= blockIndent) break; // otra key top-level → fin del bloque
    const m = line.match(/^\s*id_pattern\s*:\s*(.+?)\s*$/);
    if (m) { raw = unquoteScalar(m[1]); break; }
  }
  if (!raw) return out;

  try {
    out.idPattern = new RegExp(raw);       // sin flag `g`: un regex con estado daría falsos negativos alternados
    out.source = raw;
  } catch (e) {
    // Fail-closed y RUIDOSO: un regex roto NO puede degradar a "todo entra" (eso convertiría el
    // material de un banco de evals en backlog) ni desaparecer sin que nadie se entere.
    out.warnings.push(
      `.tycon/advisors.yaml → stories.id_pattern es un regex inválido (${JSON.stringify(raw)}: ${e.message}) — ` +
      'IGNORADO, se usa la forma por default (id jerárquico numérico). Corregilo o sacá la clave.',
    );
  }
  return out;
}

/** El bloque `stories:` del yaml de la CARPETA de trabajo. Es lo correcto para DESCUBRIR stories. */
function storiesConfig(repoRoot) {
  if (!repoRoot) return { idPattern: null, source: null, warnings: [] };
  let txt = null;
  for (const name of ['advisors.yaml', 'advisors.yml']) {
    try { txt = fs.readFileSync(path.join(repoRoot, '.tycon', name), 'utf8'); break; } catch { /* siguiente */ }
  }
  return parseStoriesConfigText(txt);
}

/**
 * 🔴 La versión que deben usar los FRENOS.
 *
 * `storiesConfig` lee la carpeta de trabajo, y eso convierte a este archivo en un interruptor:
 * escribir `stories.id_pattern: '^ZZZ-[0-9]+$'` —sin commitear— haría que **ninguna story fuera una
 * story**, y los dos frenos que impiden cerrar una sin evidencia se apagarían con exit 0 y cero
 * mensajes. Acá se gatea si el id matchea el patrón COMMITEADO **o** el de la
 * carpeta: recortar el alcance del freno exige un commit, ampliarlo vale al toque.
 *
 * La UNIÓN, y no "manda lo commiteado": el commit que *introduce* un patrón nuevo (por ejemplo
 * un repo que adopta `AP-*`/`CO-*`) dejaría esas stories fuera del freno justo en ese
 * commit. Ver `lib/config-source.js` para la regla completa.
 *
 * @returns {{idPattern: (RegExp|{test:Function}|null), warnings: string[], difieren: boolean}}
 */
function storiesConfigForGate(repoRoot) {
  const out = { idPattern: null, warnings: [], difieren: false };
  if (!repoRoot) return out;
  // El llamador puede pasar un SUBDIR (un `cd sub && git commit`). Sin normalizar, la versión de
  // la carpeta no se encuentra y la de HEAD sí, y la unión queda desbalanceada sin motivo.
  const root = findRepoRoot(repoRoot) || repoRoot;

  let ambas;
  try { ambas = require('./config-source.js').leerAmbas(root); } catch (_e) { ambas = null; }
  // Sin git utilizable no hay contra qué contrastar: se cae al comportamiento por defecto.
  if (!ambas || !ambas.hayHistoria) {
    const w = storiesConfig(root);
    return { idPattern: w.idPattern, warnings: w.warnings, difieren: false };
  }

  const head = parseStoriesConfigText(ambas.commiteado);
  const work = parseStoriesConfigText(ambas.carpeta);
  out.warnings = [...new Set([...head.warnings, ...work.warnings])];

  // Ninguno declara patrón → la forma por default (y sin costo).
  if (!head.idPattern && !work.idPattern) return out;

  const pHead = head.idPattern || DEFAULT_ID_RE;
  const pWork = work.idPattern || DEFAULT_ID_RE;
  if (String(pHead) === String(pWork)) { out.idPattern = pHead; return out; }

  out.difieren = true;
  out.idPattern = { test: (v) => pHead.test(v) || pWork.test(v) };
  out.warnings.push(
    '⚠ .tycon/advisors.yaml → stories.id_pattern DIFIERE entre lo commiteado y la carpeta ' +
    `(commiteado: ${head.source ? JSON.stringify(head.source) : 'sin declarar'} · ` +
    `carpeta: ${work.source ? JSON.stringify(work.source) : 'sin declarar'}). ` +
    'El freno usa la UNIÓN de los dos: recortar el alcance del freno recién tiene efecto una vez ' +
    'commiteado el cambio. Si estás ampliándolo, commiteá el yaml y este aviso desaparece.',
  );
  return out;
}

// ── Lectura del frontmatter ───────────────────────────────────────────────────────────────────
/** Cuerpo del frontmatter de un texto que arranca con `---`, o null si no cerró. */
function frontmatterBody(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? null : text.slice(3, end);
}

/** Escalar del frontmatter — MISMO regex que usan el resto de las tools del arnés. */
function fmScalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * ¿Este TEXTO (contenido completo de un `.md`) declara identidad de story — `story:` en su
 * frontmatter cerrado? Es el lado-CONTENIDO del criterio que decide todo el arnés desde
 * lint-story-frontmatter.js `DECLARES_STORY`: **la identidad la declara el
 * frontmatter, jamás la ruta**. Lo usa el `spawnIf` del despachador de edición: un guard que exigiera el segmento
 * `/specs/stories/` dejaría sin correr los hooks de story-create en cada repo que guarda sus stories en otra carpeta.
 *
 * Deliberadamente TOLERANTE (indentación, mayúsculas) y deliberadamente BARATO (regex en memoria,
 * cero IO): quien llama decide spawnear/avisar y las hojas re-verifican con su propia exigencia —
 * acá un falso positivo cuesta un spawn que sale 0; un falso negativo es un hook mudo. El cierre
 * del frontmatter sí se exige, igual que en las hojas: un `.md` con el frontmatter sin cerrar es
 * jurisdicción del lint de pre-commit, y spawnear una hoja que va a salir 0 no arregla nada.
 */
function declaresStoryIdentity(text) {
  const fm = frontmatterBody(String(text || '').replace(/^\uFEFF/, ''));
  return fm !== null && /^[ \t]*story[ \t]*:[ \t]*\S/im.test(fm);
}

/**
 * El id que declara ese texto (`story: "AS-1"` → `AS-1`), o null si no declara identidad. Es el
 * mismo escalar que lee `probeStoryFile` desde disco, para el caso en que el archivo TODAVÍA no
 * existe (el freno de story-a-mano decide sobre el content del Write / el cuerpo del heredoc).
 * Un solo lector del frontmatter: si esto y `probeStoryFile` divergieran, una story sería story
 * para un freno y no para otro.
 */
function declaredStoryId(text) {
  const fm = frontmatterBody(String(text || '').replace(/^\uFEFF/, ''));
  return fm === null ? null : fmScalar(fm, 'story');
}

/**
 * ¿Este `.md` es una story? Lee sólo la cabecera; si el frontmatter no cerró ahí, relee el archivo
 * (acotado) — la lectura corta es una optimización y no puede convertirse en un falso negativo.
 * Devuelve `{ id, status, epic, title }` o null.
 */
function probeStoryFile(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.toString('utf8', 0, n);
    if (!head.startsWith('---')) return null;

    let fm = frontmatterBody(head);
    if (fm === null && n === HEAD_BYTES) {
      const big = Buffer.allocUnsafe(FULL_READ_LIMIT);
      const total = fs.readSync(fd, big, 0, FULL_READ_LIMIT, 0);
      fm = frontmatterBody(big.toString('utf8', 0, total));
    }
    if (fm === null) return null;

    const id = fmScalar(fm, 'story');
    const status = fmScalar(fm, 'status');
    if (!id || !status) return null;
    return {
      id, status, epic: fmScalar(fm, 'epic'), title: fmScalar(fm, 'title'), sprint: fmScalar(fm, 'sprint'),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  }
}

// ── Orden de los ids (numérico, no lexicográfico: `2.9` va ANTES que `2.10`) ───────────────────
function idSortKey(id) {
  const nums = (String(id).match(/\d+/g) || []).map(Number);
  return nums.length ? nums : [Infinity];
}
function cmpStories(a, b) {
  const ka = idSortKey(a.id); const kb = idSortKey(b.id);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] === undefined ? Infinity : ka[i]) - (kb[i] === undefined ? Infinity : kb[i]);
    if (d) return d;
  }
  return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
}

/**
 * Escanea un árbol y devuelve las stories que encuentra.
 *
 * @param {string} root         raíz del escaneo (normalmente la raíz del repo).
 * @param {object} opts
 *   - budgetMs  presupuesto de tiempo (0 → no escanea nada, `partial: true`).
 *   - maxDepth  profundidad máxima.
 *   - idPattern RegExp que define qué id es trabajo.
 * @returns {{stories: Array, excluded: Array, partial: boolean, stats: object}}
 */
function scanTree(root, opts = {}) {
  const budget = nn(opts.budgetMs, BUDGET_MS);
  const maxDepth = nn(opts.maxDepth, MAX_DEPTH);
  const pattern = opts.idPattern || null;
  const start = Date.now();
  const expired = () => Date.now() - start >= budget;

  const stories = [];
  const excluded = [];
  let partial = false;
  let dirsSeen = 0;
  let filesProbed = 0;

  // Dos colas: `hot` (subárboles que suelen tener specs) se drena primero. Sólo afecta el ORDEN.
  // La raíz entra en `hot` para que sus propios `.md` se lean primero, pero NO marca a sus hijas
  // (si lo hiciera, todo el repo sería "hot" y la prioridad no ordenaría nada).
  const hot = [{ dir: root, depth: 0, inherited: false }];
  const cold = [];
  const nextDir = () => (hot.length ? hot.shift() : cold.shift());

  while (hot.length || cold.length) {
    if (expired()) { partial = true; break; }
    const { dir, depth, inherited } = nextDir();
    dirsSeen++;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (isHidden(entry.name) || SKIP_DIRS.has(entry.name)) continue;
        const priority = inherited || LIKELY_SPEC_DIR.test(entry.name) || HIDDEN_WITH_SPECS.has(entry.name);
        (priority ? hot : cold).push({ dir: path.join(dir, entry.name), depth: depth + 1, inherited: priority });
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (expired()) { partial = true; break; }

      const full = path.join(dir, entry.name);
      filesProbed++;
      const probed = probeStoryFile(full);
      if (!probed) continue;

      const record = {
        id: probed.id, status: probed.status, epic: probed.epic, title: probed.title,
        sprint: probed.sprint, path: full, dir,
      };
      if (isWorkStoryId(probed.id, pattern)) stories.push(record);
      else excluded.push({ id: probed.id, path: full, reason: 'id sin forma de story' });
    }
    if (partial) break;
  }

  stories.sort(cmpStories);
  return { stories, excluded, partial, stats: { dirs: dirsSeen, files: filesProbed, ms: Date.now() - start } };
}

// ── Cache por raíz de repo ────────────────────────────────────────────────────────────────────
function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && parsed.v === CACHE_VERSION ? parsed : { v: CACHE_VERSION };
  } catch {
    return { v: CACHE_VERSION };
  }
}

function writeCache(cache, cachePath) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, cachePath);
  } catch { /* el cache es una optimización: si falla, se re-escanea */ }
}

/**
 * Descubre las stories de un repo. Es LA función: todo lo demás del arnés pasa por acá.
 *
 * @param {string} repoRoot
 * @param {object} opts
 *   - budgetMs / maxDepth   límites del escaneo.
 *   - cache (default true)  usar y escribir el índice cacheado (TTL 1h).
 *   - cachePath             archivo de cache (inyectable para tests).
 *   - now                   reloj inyectable (tests de TTL).
 *   - configRoot            de dónde leer `.tycon/advisors.yaml` cuando se escanea un SUBdirectorio
 *                           del repo (`--specs-dir`): la config es del repo, no del subárbol.
 * @returns {{stories, excluded, partial, fromCache, warnings, stats, config}}
 */
function discoverStories(repoRoot, opts = {}) {
  const warnings = [];
  if (!repoRoot) {
    return { stories: [], excluded: [], partial: false, fromCache: false, warnings: ['repoRoot vacío'], stats: { dirs: 0, files: 0, ms: 0 }, config: {} };
  }
  const cfg = storiesConfig(opts.configRoot || repoRoot);
  warnings.push(...cfg.warnings);

  const useCache = opts.cache !== false;
  const cachePath = opts.cachePath || CACHE_PATH;
  const now = nn(opts.now, Date.now());
  // Firma del criterio: si el repo cambia su `id_pattern`, el índice cacheado deja de servir.
  const sig = `${cfg.source || 'default'}|${nn(opts.maxDepth, MAX_DEPTH)}`;

  if (useCache) {
    const cache = readCache(cachePath);
    const hit = cache[repoRoot];
    if (hit && hit.sig === sig && now - hit.at < CACHE_TTL_MS) {
      return {
        stories: hit.stories || [], excluded: hit.excluded || [], partial: !!hit.partial,
        fromCache: true, warnings, stats: hit.stats || { dirs: 0, files: 0, ms: 0 }, config: cfg,
      };
    }
  }

  const scanned = scanTree(repoRoot, { ...opts, idPattern: cfg.idPattern });

  // 🔴 Un parcial VACÍO no se persiste. Cachear un cero durante una hora dejaría al descubridor
  // mudo y a nadie enterándose.
  if (useCache && !(scanned.partial && scanned.stories.length === 0)) {
    const cache = readCache(cachePath);
    cache[repoRoot] = {
      at: now, sig, partial: scanned.partial, stats: scanned.stats,
      stories: scanned.stories, excluded: scanned.excluded,
    };
    writeCache(cache, cachePath);
  }

  if (scanned.partial) {
    warnings.push(
      `escaneo INCOMPLETO de ${repoRoot} (presupuesto ${nn(opts.budgetMs, BUDGET_MS)}ms, ` +
      `${scanned.stats.dirs} carpetas / ${scanned.stats.files} .md vistos) — puede faltar alguna story. ` +
      'Subilo con TYCON_STORY_SCAN_BUDGET_MS si el repo es grande.',
    );
  }
  return { ...scanned, fromCache: false, warnings, config: cfg };
}

/** Las carpetas donde HAY stories (se deriva del descubrimiento, no al revés). */
function findStoryDirs(repoRoot, opts = {}) {
  const seen = new Set();
  for (const s of discoverStories(repoRoot, opts).stories) seen.add(s.dir);
  return [...seen].sort();
}

/** Compat: findStoryDirs con cache por raíz de repo. `now` inyectable para tests. */
function storyDirsCached(repoRoot, now = Date.now()) {
  return findStoryDirs(repoRoot, { now });
}

/** Extrae los paths declarados en files_to_create / files_to_modify del frontmatter. */
function declaredFiles(content) {
  const out = [];
  const re = /^\s*files_to_(?:create|modify):\s*$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const rest = content.slice(m.index + m[0].length);
    for (const line of rest.split('\n').slice(1)) {
      const item = line.match(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/);
      if (!item) break;              // se terminó la lista
      out.push(item[1].trim());
    }
  }
  return out;
}

/**
 * Busca una story del MISMO repo que declare el archivo editado.
 * Devuelve `{ storyId, storyPath }` o null.
 */
function findStoryReferencing(editedAbsPath, opts = {}) {
  const repoRoot = opts.repoRoot === undefined || opts.repoRoot === null ? findRepoRoot(editedAbsPath) : opts.repoRoot;
  if (!repoRoot) return null;

  const rel = path.relative(repoRoot, editedAbsPath);
  if (!rel || rel.startsWith('..')) return null;
  const relPosix = rel.split(path.sep).join('/');

  const start = Date.now();
  const budget = nn(opts.budgetMs, BUDGET_MS);
  const stories = opts.stories === undefined || opts.stories === null ? discoverStories(repoRoot, opts).stories : opts.stories;

  for (const story of stories) {
    if (Date.now() - start >= budget) return null;
    let content;
    try {
      content = fs.readFileSync(story.path, 'utf8');
    } catch {
      continue;
    }
    if (!content.startsWith('---')) continue;

    const fm = frontmatterBody(content);
    const declared = declaredFiles(fm === null ? content.slice(0, 4000) : fm);
    const match = declared.some((d) => {
      const dp = d.split(path.sep).join('/');
      return relPosix === dp || relPosix.endsWith(`/${dp}`) || dp.endsWith(`/${relPosix}`);
    });
    if (!match) continue;

    return { storyId: story.id, storyPath: story.path };
  }

  return null;
}

module.exports = {
  findRepoRoot, findStoryDirs, storyDirsCached, findStoryReferencing, declaredFiles,
  discoverStories, isWorkStoryId, storiesConfig, storiesConfigForGate, parseStoriesConfigText,
  probeStoryFile, declaresStoryIdentity, declaredStoryId, idSortKey, unquoteScalar,
  DEFAULT_ID_RE, DEFAULT_BUDGET_MS, BUDGET_MS,
};

// ── CLI de diagnóstico ────────────────────────────────────────────────────────────────────────
// `node lib/story-discovery.js --doctor [--repo <dir>]` — para cuando el arnés dice "0 stories" y
// hay que saber si es el layout, el presupuesto o el `id_pattern` del repo.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const repo = findRepoRoot(path.resolve(at('--repo') || process.cwd())) || process.cwd();
  const budgetMs = Number(at('--budget')) || BUDGET_MS;
  const r = discoverStories(repo, { cache: false, budgetMs });

  console.log(`repo:        ${repo}`);
  console.log(`presupuesto: ${budgetMs}ms   escaneo: ${r.stats.ms}ms (${r.stats.dirs} carpetas, ${r.stats.files} .md leídos)`);
  console.log(`criterio id: ${r.config.source ? `${r.config.source}  (.tycon/advisors.yaml)` : `${DEFAULT_ID_RE}  (default)`}`);
  console.log(`stories:     ${r.stories.length}${r.partial ? '   ⚠️ ESCANEO INCOMPLETO' : ''}`);
  const byDir = new Map();
  for (const s of r.stories) byDir.set(path.relative(repo, s.dir) || '.', (byDir.get(path.relative(repo, s.dir) || '.') || 0) + 1);
  for (const [d, n] of [...byDir].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${d}`);
  if (r.excluded.length) {
    console.log(`excluidos:   ${r.excluded.length} (.md con frontmatter de story cuyo id no tiene forma de trabajo)`);
    for (const e of r.excluded.slice(0, 5)) console.log(`   ${e.id.padEnd(12)} ${path.relative(repo, e.path)}`);
    if (r.excluded.length > 5) console.log(`   … y ${r.excluded.length - 5} más`);
  }
  for (const w of r.warnings) console.log(`⚠️  ${w}`);
  process.exit(0);
}
