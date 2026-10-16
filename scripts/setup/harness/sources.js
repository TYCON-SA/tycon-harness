'use strict';
// sources.js — las fuentes del arnés: cada clon que `update` trae y avanza (story 8.13, AC 6).
//
// Una fuente es `{ name, url, ref, rewrites, dir, commit, previous }`: en los repos internos son dos —`harness` (el clon
// al que apunta el enlace) y `agent_skills` (`~/.claude/agent-skills`)—; en el repo único de la 8.7 (skills/ y agents/ en
// la raíz del clon) es una. `url` es el origin fijado en `install`: si el origin del clon cambió, nada sale a la red
// (AC 29a nace acá; `install --source <url>` lo cambia a propósito).
//
// Dos tipos de ref:
//   · FIJA (`main` interno hoy; `rewrites:false`): `git fetch origin <ref>` y `merge --ff-only`, con las mismas reglas que
//     `guides-heal.js advance()` de agent-skills: lo local trackeado se aparta en un stash propio (`tycon-harness`) y se
//     reaplica; los no trackeados que lo publicado agrega se apartan SÓLO si son regenerables (`.dashboard/`: los produce
//     el nocturno y el respaldo local los reescribe —el caso medido que dejó una máquina 158 commits atrás—) y NO se
//     reaplican (lo publicado es lo bueno; lo local queda en `git stash list`); si divergió (commits propios) o está en
//     otra rama no se toca nada y se nombra el motivo con el comando para arreglarlo a mano.
//   · REESCRITA (el repo público, tanda D; `rewrites:true`): rama local `tycon/installed` y `reset --hard` a lo traído.
//     Los dos canales se consumen igual: `latest` es `mirror/sync` y `stable` es `main` (`channelRef`); la ref sale de la
//     política en cada `check`, y si `mirror/sync` no está, o su número es menor que el de `main`, `latest` lee `main`.
//     «No bajar» se decide por NÚMERO (`version.json` de cada commit, `version-order.js`), no por ancestría: el commit de
//     una rama reescrita deja de ser ancestro de todo. Un `version.json` que está y NO SE PUDO LEER no es «sin número»:
//     es «no pude mirar», en los dos canales (`versionAt` distingue número / ausente / problema), y no se aplica.
//     Se mueve sólo desde `tycon/installed` (o la primera vez, con HEAD en
//     el commit registrado o en un avance simple de la rama por defecto: lo que deja un `git pull` a mano o el respaldo
//     en shell — `offInstalledBranch`); lo modificado en archivos que el arnés sigue traba el reset —fuera de las carpetas de skills
//     de terceros que `~/.claude/.tycon-pipeline/third-party-state.json` declara—, y se dice. Los archivos SIN SEGUIR que
//     la persona creó no lo traban, salvo el que choca con una ruta que la versión nueva trae: ahí no se toca nada y se
//     nombra la ruta (`reset --hard` lo pisaría sin avisar). «Choca» incluye una carpeta sin seguir que es un repo de git
//     propio y una ruta que difiere sólo en la caja o en la forma de los acentos (`collidingPaths`).
//   Que una fuente se reescriba lo decide el remoto: es el repo público si su `origin` está en la lista que el exportador
//   deja en la copia (`scripts/setup/public-remotes.json`), comparado por identidad (host + ruta, con o sin `.git`, https
//   o ssh). En un clon interno ese archivo no existe: nunca es público, y los dos canales son `main` sin reescritura.
// Antes de mover, `previous` queda en el estado y en una ref local `refs/tycon/previous/<name>` (`gc` no la poda).
// Nunca `git pull`. La red tiene tope: `spawnSync({ timeout })` con `TYCON_UPDATE_NETWORK_BUDGET_S` (15 s por defecto);
// sin red se dice «sin red» y se vuelve dentro del tope —también cuando git falla al instante por la red (8.7, C1)—.
// `check` distingue al día / hay nueva / no pude mirar: un fetch que falló NUNCA es «al día».
//
// Funciones puras respecto del HOME: reciben `home`/`env`; los procesos hijos corren con el `env` que les pasan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./tycon-home.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { spawnSync } = require('child_process');
const versionOrder = require('./version-order.js');

const STASH_MSG = 'tycon-harness';
const REGENERABLE = [/^\.dashboard\//];
const INSTALLED_BRANCH = 'tycon/installed';
const MAIN_REF = 'main';              // el canal estable (y el único de un clon interno)
const SYNC_REF = 'mirror/sync';       // el canal `latest` del repo público: la rama que la sincronización reescribe
const DEFAULT_BUDGET_S = 15;
const PUBLIC_REMOTES_FILE = path.join('scripts', 'setup', 'public-remotes.json');
const VERSION_FILE = 'version.json';
/** Cuánto puede esperar una punta su etiqueta antes de que se diga (la pone un proceso de GitHub en un minuto). */
const PENDING_TAG_SAY_MS = 6 * 60 * 60 * 1000;
const THIRD_PARTY_STATE = 'third-party-state.json';   // en la carpeta del estado (tycon-home.js stateDir())
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const previousRef = (name) => `refs/tycon/previous/${name}`;
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
const lines = (s) => String(s || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

// sin preguntar NADA: ni la terminal ni el gestor de credenciales, que en Windows abre un login invisible que deja al
// arranque esperando hasta que Claude Code lo corta con el candado tomado (story 8.23, AC 38)
function gitEnv(env) {
  return Object.assign({}, env || process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });
}

/** Corre git en `dir` con tope de tiempo. Nunca tira: `{ ok, out, raw, err, status, timedOut }`. `out` va recortado;
 *  `raw` no (el `status --porcelain` empieza con un espacio que es parte del formato: recortarlo le come un carácter al
 *  primer archivo — pase adversarial de la tanda A, clase 20). */
function git(dir, args, { env, timeout = 30000, input } = {}) {
  // `maxBuffer`: el tope por defecto de Node (1 MB) corta a git cuando lista un árbol grande o lo que un clon no sigue
  // (un `node_modules` ignorado); cortado, la lista sale vacía con error, y eso es «no pude mirar», no «no hay nada».
  // `input`: lo que va por stdin (una lista para `--stdin`); sin él, stdin cerrado como siempre
  // `timeout` en milisegundos ENTEROS (Node rechaza otro): el tope que le queda a una fuente puede llegar con decimales
  // (8.13.1, C7). Un entero pasa igual que antes
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { windowsHide: true,
    encoding: 'utf8', env: gitEnv(env), timeout: Number.isFinite(timeout) ? Math.max(1, Math.round(timeout)) : timeout, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input,
    maxBuffer: GIT_MAX_BUFFER,
  });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT') || (r.status === null && r.signal === 'SIGTERM');
  return {
    ok: r.status === 0 && !r.error,
    out: (r.stdout || '').trim(),
    raw: r.stdout || '',
    err: r.error ? (r.error.code === 'ENOENT' ? 'git no está en el PATH' : r.error.message) : (r.stderr || '').trim(),
    status: r.status,
    timedOut,
  };
}
const value = (dir, args, opts) => { const r = git(dir, args, opts); return r.ok ? r.out : null; };

function head(dir, opts = {}) { return value(dir, ['rev-parse', 'HEAD'], opts); }

// ── «no existe» / «no se pudo leer» ───────────────────────────────────────────────────────────────
// Un `.ok` falso de git NO dice «no hay»: sale igual cuando la ref está y no se deja leer (basura en su archivo, un commit
// que falta, un tope de tiempo, un clon roto). Leer eso como «no existe» era dar vía libre sin saber (segunda vuelta de
// revisores de la tanda D: una rama `tycon/installed` corrompida pasaba por «la primera vez»). Estas tres funciones
// contestan en TRES estados, y lo que decide si algo se mueve pasa por ellas. Ninguna mira el TEXTO de un error de git
// (no dependen del idioma): miran el código de salida, si git dijo algo, y lo que hay en disco.
const why = (r) => (r.timedOut ? 'git no contestó a tiempo' : (firstLine(r.err) || `git salió ${r.status}`));
/** ¿git contestó «no», a secas? `rev-parse --verify -q` y `merge-base --is-ancestor` salen 1 y callados; lo demás habla. */
const quietNo = (r) => r.status === 1 && !r.timedOut && !r.err;

/**
 * Un commit del clon, por su nombre o su sha:
 *   · `ok` (con `sha`) · `absent` — git contestó que no está · `problem` — no se pudo mirar (`reason` dice por qué).
 * @returns {{ status: 'ok'|'absent'|'problem', sha: string|null, reason: string|null }}
 */
function commitState(dir, rev, { env, timeout = 10000 } = {}) {
  const r = git(dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { env, timeout });
  if (r.ok && r.out) return { status: 'ok', sha: r.out, reason: null };
  if (quietNo(r)) return { status: 'absent', sha: null, reason: null };
  return { status: 'problem', sha: null, reason: why(r) };
}

/**
 * Una ref del clon (`refs/heads/…`, `refs/remotes/…`, `HEAD`), en tres estados que no se confunden:
 *   · `ok`      — existe y apunta a un commit que está en el clon (`sha`);
 *   · `absent`  — de verdad no existe: git contestó «no» sin decir nada más, y en disco no hay rastro de ella;
 *   · `problem` — no se pudo leer: git falló o agotó su tope, avisó algo (una ref rota), el archivo de la ref está y git
 *                 no lo leyó, quedó su `.lock` (otra operación la está escribiendo), o apunta a un commit que no está.
 * @returns {{ status: 'ok'|'absent'|'problem', sha: string|null, reason: string|null }}
 */
function refState(dir, ref, { env, timeout = 10000 } = {}) {
  const problem = (reason) => ({ status: 'problem', sha: null, reason });
  const r = git(dir, ['rev-parse', '--verify', '-q', ref], { env, timeout });
  if (r.ok && r.out) {
    const c = commitState(dir, r.out, { env, timeout });
    if (c.status === 'ok') return { status: 'ok', sha: c.sha, reason: null };
    return problem(c.status === 'absent' ? `apunta a ${r.out.slice(0, 7)}, que no es un commit que esté en el clon` : c.reason);
  }
  if (!quietNo(r)) return problem(why(r));
  // git dijo «no está», callado. Que en disco esté su archivo —o su .lock— lo desmiente (y no depende de que esa versión
  // de git avise de una ref rota)
  const where = git(dir, ['rev-parse', '--git-path', ref], { env, timeout });
  if (!where.ok || !where.out) return problem(`no pude ubicar la ref en el clon (${why(where)})`);
  const file = path.resolve(dir, where.out);
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return problem(`no pude mirar ${file} (${e.code || e.message})`); }
  if (stat && !stat.isDirectory()) return problem(`su archivo está (${file}) y git no lo pudo leer`);
  if (fs.existsSync(`${file}.lock`)) return problem(`otra operación de git la está escribiendo (${file}.lock)`);
  return { status: 'absent', sha: null, reason: null };
}

/** ¿`a` es ancestro de `b`? `true` / `false` / `null` = no se pudo saber (un commit que falta, un objeto roto, un tope de
 *  tiempo): `merge-base --is-ancestor` sale 0, 1, u otra cosa. `null` NO es «no es ancestro». */
function ancestor(dir, a, b, env) {
  const s = ancestorState(dir, a, b, env);
  return s.status === 'unknown' ? null : s.status === 'yes';
}
/** Lo mismo, con la causa cuando no se pudo saber (para decirla): `{ status: 'yes'|'no'|'unknown', reason }`. */
function ancestorState(dir, a, b, env) {
  if (!a || !b) return { status: 'unknown', reason: 'falta uno de los dos commits' };
  const r = git(dir, ['merge-base', '--is-ancestor', String(a), String(b)], { env });
  if (r.ok) return { status: 'yes', reason: null };
  return quietNo(r) ? { status: 'no', reason: null } : { status: 'unknown', reason: `git merge-base --is-ancestor: ${why(r)}` };
}
function origin(dir, opts = {}) { return value(dir, ['remote', 'get-url', 'origin'], opts); }
/** La rama actual, o null si está «detached». */
function branch(dir, opts = {}) {
  const b = value(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], opts);
  return b || null;
}
function isRepo(dir, opts = {}) { return Boolean(dir) && fs.existsSync(dir) && value(dir, ['rev-parse', '--is-inside-work-tree'], opts) === 'true'; }
/** ¿Es un repo `--bare`? El clon de lectura de una capa (story 8.13.1) lo es: no tiene árbol de trabajo. */
function isBare(dir, opts = {}) { return Boolean(dir) && fs.existsSync(dir) && value(dir, ['rev-parse', '--is-bare-repository'], opts) === 'true'; }
function gitDir(dir, opts = {}) {
  const g = value(dir, ['rev-parse', '--git-dir'], opts);
  return g ? path.resolve(dir, g) : null;
}
/** La punta traída de la ref de la fuente, o `null` si no está O no se pudo leer: para DECIDIR, `refState` (tres estados). */
function remoteTip(src, opts = {}) { const t = refState(src.dir, `refs/remotes/origin/${src.ref}`, opts); return t.status === 'ok' ? t.sha : null; }

// ── detectar ─────────────────────────────────────────────────────────────────────────────────────

const stripSlashes = (p) => String(p).replace(/[\\/]+$/, '');
const stripGit = (p) => stripSlashes(stripSlashes(p).replace(/\.git$/i, ''));
/** La ruta real de una carpeta local; si no existe, la real de su carpeta padre más su nombre; si no, la absoluta. */
function realish(p) {
  const abs = path.resolve(p);
  const r = real(abs);
  if (r) return r;
  const parent = real(path.dirname(abs));
  return parent ? path.join(parent, path.basename(abs)) : abs;
}
/** Las partes de un remoto: `{ host, path }` (https, ssh, o la forma `usuario@host:ruta`) o `{ local }` (una carpeta). */
function remoteParts(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) return null;
  const file = /^file:\/\/(.*)$/i.exec(u);
  if (file) return { local: file[1] };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
  if (withScheme) return { host: withScheme[1], path: withScheme[2] };
  // `usuario@host:org/repo` (la forma corta de ssh); una letra de unidad de Windows (`C:\…`) es una carpeta
  const short = /^(?:[^@/\\\s]+@)?([^/\\:\s]+):(?![\\/]{2})(.+)$/.exec(u);
  if (short && !/^[A-Za-z]:[\\/]/.test(u)) return { host: short[1], path: short[2] };
  return { local: u };
}
/**
 * La identidad de un remoto, para comparar dos URL del mismo repo: `host/ruta` en minúsculas, sin usuario, sin puerto y
 * sin `.git` (https y ssh dan lo mismo); una carpeta local, su ruta real sin `.git`. Sin URL: `null`.
 */
function remoteIdentity(url) {
  const p = remoteParts(url);
  if (!p) return null;
  if (p.local !== undefined) return `local:${stripGit(realish(stripSlashes(p.local) || p.local))}`;
  return `${p.host.toLowerCase()}/${stripGit(p.path.replace(/^\/+/, '')).toLowerCase()}`;
}
/** La página web del remoto (base del enlace de «cambios»): `https://host/ruta` sin `.git`; una carpeta local, tal cual. */
function webBase(url) {
  const p = remoteParts(url);
  if (!p) return null;
  if (p.local !== undefined) return stripSlashes(p.local) || p.local;
  return `https://${p.host}/${stripGit(p.path.replace(/^\/+/, ''))}`;
}

/** La lista de remotos públicos que el árbol declara (`{ "remotes": ["<url>", …] }`), o `null` si no la trae o no se
 *  puede leer: un clon interno no la tiene. `null` no es «lista vacía»: `doctor` distingue «clon interno» de «copia». */
function publicRemotes(tree) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, PUBLIC_REMOTES_FILE), 'utf8'));
    if (!j || !Array.isArray(j.remotes)) return null;
    return j.remotes.filter((r) => typeof r === 'string' && r.trim());
  } catch (_) { return null; }
}

/** ¿El `origin` es el repo público? Sólo si el árbol trae la lista y la URL es uno de sus remotos, por identidad (A1). */
function isPublicRemote(tree, url) {
  const id = remoteIdentity(url);
  if (!id) return false;
  const list = publicRemotes(tree);
  return Boolean(list) && list.some((r) => remoteIdentity(r) === id);
}

/** La ref de un canal: en una fuente que se reescribe, `latest` → `mirror/sync` y `stable` → `main`; si no, `main`. */
function channelRef(src, channel) {
  return src && src.rewrites && channel === 'latest' ? SYNC_REF : MAIN_REF;
}

/**
 * La ref que se sigue es `main` al instalar, NUNCA la rama en la que el clon esté parado: un clon en una rama de trabajo
 * queda con `ref: main` y `update` lo encuentra «en otra rama» —no se toca y se avisa (AC 8)—. Antes la rama actual
 * pasaba a ser la ref y `rewrites` se deducía de ella, y `update` sacaba al dev de su rama con `checkout -B` +
 * `reset --hard` (pase adversarial de la tanda A, clases 1, 7 y 8). Que la ref se reescriba lo decide sólo el remoto
 * (`isPublicRemote`); la ref de cada canal la pone `check`, con la política vigente (tanda D).
 */
function describe(name, dir, { tree, env }) {
  const url = origin(dir, { env });
  return { name, url, ref: MAIN_REF, rewrites: isPublicRemote(tree, url), dir, commit: head(dir, { env }), previous: null };
}

/**
 * Las fuentes de esta máquina: `harness` siempre; `agent_skills` si `~/.claude/agent-skills` es OTRO clon (una sola fuente
 * cuando el clon trae skills/ y agents/ en la raíz, 8.7 AC 18). Que falte agent-skills del todo lo grita `install`, no esto.
 */
function detect({ tree, home = os.homedir(), env = process.env }) {
  const t = real(tree) || path.resolve(tree);
  const out = [describe('harness', t, { tree: t, env })];
  const skills = path.join(home, '.claude', 'agent-skills');
  const rs = real(skills);
  if (rs && rs !== t && isRepo(rs, { env })) out.push(describe('agent_skills', rs, { tree: t, env }));
  return out;
}

// ── limpio / excluido ────────────────────────────────────────────────────────────────────────────

/** Las carpetas de skills de terceros declaradas (relativas al clon de agent-skills). Sin archivo o roto: ninguna. */
function thirdPartyDirs(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDirOf(home), THIRD_PARTY_STATE), 'utf8'));
    return j && j.entries && typeof j.entries === 'object' ? Object.keys(j.entries) : [];
  } catch (_) { return []; }
}
function excludedFor(src, { home = os.homedir() } = {}) {
  const skills = real(path.join(home, '.claude', 'agent-skills'));
  const isSkills = src.name === 'agent_skills' || (skills && real(src.dir) === skills);
  return isSkills ? thirdPartyDirs(home) : [];
}
const under = (file, dirs) => dirs.some((d) => file === d || file.startsWith(`${d.replace(/\/+$/, '')}/`));

/** Limpio fuera de lo ignorado (`.gitignore`, `.git/info/exclude`) y de `excluded` (carpetas relativas). Con
 *  `untracked: false` mira sólo lo que git sigue (lo sin seguir lo juzga `untrackedInTheWay`). */
function isClean(dir, { env, excluded = [], untracked = true } = {}) {
  const r = git(dir, ['status', '--porcelain=v1', `--untracked-files=${untracked ? 'all' : 'no'}`], { env });
  if (!r.ok) return { clean: false, files: [], reason: `git status falló: ${firstLine(r.err)}` };
  const files = lines(r.raw)
    .map((l) => { const p = l.slice(3); const i = p.indexOf(' -> '); return i >= 0 ? p.slice(i + 4) : p; })
    .map((p) => p.replace(/^"(.*)"$/, '$1'))
    .filter((p) => !under(p, excluded));
  return { clean: files.length === 0, files, reason: null };
}
/** ¿Hay cambios sin commitear en lo que git sigue? `true` / `false` / `null` = `git status` no pudo contestar (no es
 *  «no hay»: quien llama no mueve nada sin saberlo). */
function dirtyTracked(dir, env) {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=no'], { env });
  return r.ok ? lines(r.out).length > 0 : null;
}
/** Los no trackeados que lo publicado agrega (el merge se niega a pisarlos). */
function collidingUntracked(dir, ref, env) {
  const untracked = new Set(lines(value(dir, ['ls-files', '--others', '--exclude-standard'], { env })));
  const upstream = lines(value(dir, ['diff', '--name-only', 'HEAD', `refs/remotes/origin/${ref}`], { env }));
  return upstream.filter((f) => untracked.has(f));
}
const zlist = (s) => String(s || '').split('\0').filter(Boolean);
/** La clave con la que se comparan dos rutas: iguala la caja y la forma Unicode (NFC/NFD, «ſ»/«s»). El disco de Mac y el
 *  de Windows no las distinguen: `Notes.md` y `notes.md` son ahí el MISMO archivo. Es el criterio de `caseCollisions` del
 *  exportador (`scripts/publishing/export.js`), copiado: este módulo corre desde la copia fija y no puede requerirlo. */
const foldPath = (p) => String(p).normalize('NFC').toUpperCase().toLowerCase();
/**
 * De las rutas sin seguir (`untracked`, como las lista `git ls-files --others`), las que CHOCAN con una ruta que la
 * versión nueva trae (`incoming`: sus archivos), y con cuál: `[{ path, with }]`. Choca (D3):
 *   · el mismo archivo;
 *   · un archivo donde la versión nueva trae una carpeta, y uno bajo lo que la versión nueva trae como archivo;
 *   · una CARPETA sin seguir —git la lista con barra final cuando es un repo de git propio (una skill clonada dentro
 *     del clon), y no dice qué hay adentro—: con cualquier ruta nueva igual a ella o por debajo, y con un archivo que se
 *     llame como ella o como una de sus carpetas madre;
 * todo comparado con `foldPath`. En un disco que sí distingue mayúsculas frena de más (no se toca nada y se nombran las
 * dos rutas); pisar de menos, nunca. Función pura: no mira el disco.
 */
function collidingPaths(untracked, incoming) {
  const files = new Map();   // clave → la ruta nueva, tal como viene
  const dirs = new Map();    // clave de cada carpeta que la versión nueva trae → la primera ruta nueva que hay bajo ella
  for (const f of incoming) {
    const k = foldPath(f);
    if (!files.has(k)) files.set(k, f);
    for (let i = k.lastIndexOf('/'); i > 0; i = k.lastIndexOf('/', i - 1)) {
      const d = k.slice(0, i);
      if (dirs.has(d)) break;
      dirs.set(d, f);
    }
  }
  const out = [];
  for (const u of untracked) {
    const k = foldPath(String(u).replace(/\/+$/, ''));   // una carpeta (barra final) se compara por su nombre
    if (!k) continue;
    let hit = files.has(k) ? files.get(k) : (dirs.has(k) ? dirs.get(k) : null);
    for (let i = k.lastIndexOf('/'); hit === null && i > 0; i = k.lastIndexOf('/', i - 1)) {
      const d = k.slice(0, i);
      if (files.has(d)) hit = files.get(d);
    }
    if (hit !== null) out.push({ path: u, with: hit });
  }
  return out;
}
/** Lo sin seguir (y no ignorado) de `dir` que choca con el commit `to`, con la ruta nueva con la que choca; `null` si git
 *  no pudo listar (no se sabe: no se mueve). Las listas se piden con `-z`: rutas con espacios o no ASCII llegan enteras. */
function untrackedCollisions(dir, to, env) {
  const others = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { env });
  if (!others.ok) return null;
  const untracked = zlist(others.raw);
  if (!untracked.length) return [];
  const tree = git(dir, ['ls-tree', '-r', '--name-only', '-z', to], { env });
  if (!tree.ok) return null;
  return collidingPaths(untracked, zlist(tree.raw));
}
/**
 * Las rutas sin seguir (y no ignoradas) que CHOCAN con una ruta que trae el commit `to` (D3; el criterio, en
 * `collidingPaths`). Son las que `reset --hard` pisaría sin avisar; las demás no traban nada. Una carpeta sale con su
 * barra final, como la lista git. `null` si git no pudo listar (no se sabe: no se mueve).
 */
function untrackedInTheWay(dir, to, env) {
  const hits = untrackedCollisions(dir, to, env);
  return hits === null ? null : hits.map((h) => h.path);
}

// ── las versiones de un commit ───────────────────────────────────────────────────────────────────

/** El motivo, para la persona, de una comparación de ascendencia que git no pudo hacer. */
const cannotCompare = (a, b) => `git no pudo comparar ${a} con ${b} (un commit que falta o un objeto ilegible): no se sabe cuál es más nueva`;
/**
 * El número publicado de un commit, leído de su `version.json`. TRES casos, que no se confunden (revisión de la tanda D:
 * antes «no lo pude leer» se devolvía igual que «no lo trae», y `assess` aplicaba un commit cuyo número nunca leyó):
 *   · `ok`      — `version` es el número;
 *   · `absent`  — ese commit de verdad no trae el archivo (un clon interno; la primera publicación): legítimo;
 *   · `problem` — no se pudo leer: la rev no está en el clon, git falló o agotó su tope, el JSON es ilegible, o `version`
 *                 no tiene la forma de un número publicado (sin forma es un problema y no «sin número», igual que para
 *                 quien lo estampa: `readVersionFile` de `mirror.js`). `reason` dice cuál.
 * «Ausente» se decide por lo que git LISTA en ese commit (`ls-tree`), no por el texto de un error: no depende del idioma.
 * @returns {{ status: 'ok'|'absent'|'problem', version: string|null, reason: string|null }}
 */
function versionAt(dir, rev, { env } = {}) {
  const problem = (reason) => ({ status: 'problem', version: null, reason });
  const why = (r) => (r.timedOut ? 'git no contestó a tiempo' : (firstLine(r.err) || `git salió ${r.status}`));
  const commit = git(dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { env, timeout: 10000 });
  // `rev-parse --verify -q` sale 1 y callado cuando esa rev no existe; cualquier otra falla (no es un clon, tope) habla
  if (!commit.ok) {
    const short = String(rev).slice(0, 12);
    return problem(commit.timedOut || commit.err ? `no pude mirar el commit ${short} (${why(commit)})` : `el commit ${short} no está en el clon`);
  }
  // el número de la etiqueta que puso el merge, si el commit la tiene (las trae el fetch: `fetchRef`)
  // sólo las LIVIANAS (`objecttype` commit), como en `info/refs` y en la API: una anotada puesta a mano no numera
  const tagged = git(dir, ['for-each-ref', '--points-at', commit.out, '--format=%(objecttype) %(refname)', `refs/tags/${versionOrder.TAG_PREFIX}*`], { env, timeout: 10000 });
  const byTag = tagged.ok ? versionOrder.bestTag(lines(tagged.out).filter((l) => l.startsWith('commit ')).map((l) => l.slice('commit '.length))) : null;
  if (byTag) return { status: 'ok', version: byTag, reason: null, tagged: true };
  const listed = git(dir, ['ls-tree', '--name-only', commit.out, '--', VERSION_FILE], { env, timeout: 10000 });
  if (!listed.ok) return problem(`no pude listar el commit ${commit.out.slice(0, 7)} (${why(listed)})`);
  if (!lines(listed.out).includes(VERSION_FILE)) return { status: 'absent', version: null, reason: null };
  const shown = git(dir, ['show', `${commit.out}:${VERSION_FILE}`], { env, timeout: 10000 });
  if (!shown.ok) return problem(`no pude leer el archivo (${why(shown)})`);
  let j;
  try { j = JSON.parse(shown.out); } catch (e) { return problem(`JSON ilegible (${e.message})`); }
  const v = j && j.version;
  if (!versionOrder.isOrdered(v)) return problem(`«version» no tiene la forma de un número publicado (${JSON.stringify(v === undefined ? null : v)})`);
  // sin etiqueta y con la marca: el merge recién entró y su número (la etiqueta) todavía no llegó; `version` es el piso
  return versionOrder.numberedByTag(j) ? { status: 'ok', version: v, reason: null, pending: true } : { status: 'ok', version: v, reason: null };
}
/** El motivo, para la persona, de un `version.json` que no se pudo leer: nombra la ref y el archivo. */
function unreadableVersion(label, rev, v) {
  return `no pude leer ${VERSION_FILE} de ${label}${label.includes(String(rev).slice(0, 7)) ? '' : ` (${String(rev).slice(0, 7)})`}: ${v.reason} — sin su número no se sabe si es más nueva o más vieja: no se aplica`;
}

/**
 * Lo traído (`to`) contra lo instalado (`from`), sin salir a la red (A3). Ref fija: por ancestría, como siempre. Ref
 * reescrita: por NÚMERO — menor → `older` (no se baja); mayor, o IGUAL con otro sha → `new` (el merge del pull request
 * deja en `main` el mismo número que traía la rama); sin número en un lado PORQUE ESE COMMIT NO TRAE EL ARCHIVO → en
 * `stable` decide la ancestría (`main` no se reescribe: si lo instalado ya la contiene, no se baja) y en `latest` se
 * aplica. Un número que NO SE PUDO LEER, en cualquiera de los dos lados y en los dos canales, es `unknown` («no sé»):
 * no se aplica ni se da por «al día», y `reason` nombra la ref (`labels`) y el archivo.
 * @returns {{ status: 'up_to_date'|'new'|'older'|'unknown', numbers: { from: string|null, to: string|null }, reason: string|null }}
 */
function assess(src, from, to, { env = process.env, channel = 'stable', labels = {} } = {}) {
  const numbers = { from: null, to: null };
  if (to === from) return { status: 'up_to_date', numbers, reason: null };
  if (!src.rewrites) {
    // ref fija con lo traído ya contenido (el clon está adelante): no hay nada nuevo que traer. Una comparación que git
    // no pudo hacer no es «no está contenido»: «no sé»
    const contained = ancestor(src.dir, to, from, env);
    if (contained === null) return { status: 'unknown', numbers, reason: cannotCompare(labels.to || 'lo traído', labels.from || 'lo instalado (HEAD)') };
    return { status: contained ? 'up_to_date' : 'new', numbers, reason: null };
  }
  const vTo = versionAt(src.dir, to, { env });
  if (vTo.status === 'problem') return { status: 'unknown', numbers, reason: unreadableVersion(labels.to || 'lo traído', to, vTo) };
  const vFrom = versionAt(src.dir, from, { env });
  if (vFrom.status === 'problem') {
    return { status: 'unknown', numbers, reason: `${unreadableVersion(labels.from || 'lo instalado (HEAD)', from, vFrom)} (para salir: harness.js rollback, o volvé a clonar)` };
  }
  numbers.from = vFrom.version;
  numbers.to = vTo.version;
  // lo traído espera su etiqueta (el merge recién entró): todavía no tiene número; se aplica cuando lo tenga
  if (vTo.pending) return { status: 'up_to_date', numbers, reason: null, pending: true };
  const order = versionOrder.compare(numbers.to, numbers.from);
  if (order !== null) return { status: order < 0 ? 'older' : 'new', numbers, reason: null };
  if (channel !== 'latest') {
    const contained = ancestor(src.dir, to, from, env);
    if (contained === null) return { status: 'unknown', numbers, reason: cannotCompare(labels.to || 'lo traído', labels.from || 'lo instalado (HEAD)') };
    if (contained) return { status: 'older', numbers, reason: null };
  }
  return { status: 'new', numbers, reason: null };
}

/** En `latest`: ¿se lee `mirror/sync`? No si es más vieja que `main` por número; sin número en algún lado (el commit no
 *  trae el archivo), no si `main` ya la contiene (la rama quedó atrás después del merge). Un número que no se pudo leer
 *  no es «sin número»: `{ problem }`, y quien llama no elige rama.
 *  @returns {{ sync: boolean, problem: string|null }} */
function preferSync(dir, syncTip, mainTip, env) {
  const pick = (sync) => ({ sync, problem: null });
  if (!syncTip) return pick(false);
  if (!mainTip) return pick(true);
  if (syncTip === mainTip) return pick(false);
  const vs = versionAt(dir, syncTip, { env });
  if (vs.status === 'problem') return { sync: false, problem: unreadableVersion(`origin/${SYNC_REF}`, syncTip, vs) };
  const vm = versionAt(dir, mainTip, { env });
  if (vm.status === 'problem') return { sync: false, problem: unreadableVersion(`origin/${MAIN_REF}`, mainTip, vm) };
  const order = versionOrder.compare(vs.version, vm.version);
  if (order !== null) return pick(order >= 0);
  const merged = ancestor(dir, syncTip, mainTip, env);
  if (merged === null) return { sync: false, problem: cannotCompare(`origin/${SYNC_REF}`, `origin/${MAIN_REF}`) };
  return pick(!merged);
}

// ── traer / mirar ────────────────────────────────────────────────────────────────────────────────

function budgetOf(budgetS, env) {
  const fromEnv = parseInt(String((env || {}).TYCON_UPDATE_NETWORK_BUDGET_S || ''), 10);
  const b = budgetS !== undefined && budgetS !== null ? Number(budgetS) : (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_BUDGET_S);
  return Number.isFinite(b) && b > 0 ? b : DEFAULT_BUDGET_S;
}
/** Un tope en segundos para los mensajes: entero si lo es («15»), si no con un decimal («14.3»). Lo que le queda del tope
 *  a la última fuente ya no es un número redondo (8.13.1, C7: el tope cuenta desde que arrancó el comando). */
function secondsText(s) { return Number.isInteger(s) ? String(s) : String(Math.round(s * 10) / 10); }

/** El origin del clon tiene que ser el fijado: si no, nada sale a la red. */
function originMismatch(src, env) {
  const o = origin(src.dir, { env });
  if (!src.url) return null;
  if (o === src.url) return null;
  return `el origin de ${src.name} cambió: ahora es ${o || '(ninguno)'} y el estado fijó ${src.url} — no se actualiza (install --source <url> lo cambia a propósito)`;
}

/**
 * Los errores de git que son LA RED (story 8.7, tanda C · decisión C1): no resolvió el nombre, conexión rechazada, sin
 * ruta al host, red inalcanzable, tiempo agotado. Es una lista POSITIVA, con los textos de git, curl y ssh en inglés
 * (`gitEnv` corre git con `LC_ALL=C`): lo que no está acá —un repo que no existe, una ref que falta, un certificado, una
 * credencial— NO es «sin red» y deja su aviso. Tomar por red todo lo que no se reconoce callaría un repo roto.
 */
const NETWORK_ERRORS = [
  /Could(?: not|n't) resolve (?:host|proxy)/i, /unable to look up /i, /Temporary failure in name resolution/i,
  /Name or service not known/i, /nodename nor servname provided/i,                                     // el nombre
  /Connection refused/i, /Could(?: not|n't) connect to server/i,                                        // rechazada
  /No route to host/i, /Network is unreachable/i,                                                       // sin ruta / red
  /(?:Connection|Operation|Resolving) timed out/i,                                                      // tiempo agotado
];
/** ¿El stderr de git dice que la falla fue de red? Mira todas las líneas (el motivo de `git://` viene en la segunda). */
function isNetworkError(stderr) {
  const text = String(stderr || '');
  return NETWORK_ERRORS.some((re) => re.test(text));
}

/**
 * `git fetch origin <ref>` con tope. Sin red → `{ ok:false, offline:true, reason:'sin red: …' }` dentro del tope: por el
 * tope agotado (`timedOut`) o por una falla de red inmediata (`isNetworkError`: la notebook sin wifi no espera nada).
 * `missing`: el remoto contestó y esa rama no existe (no es «no pude mirar»: `latest` sin `mirror/sync` lee `main`).
 * @returns {{ ok: boolean, reason: string|null, to: string|null, timedOut: boolean, offline: boolean, missing: boolean }}
 */
function fetchRef(src, ref, { budgetS, env = process.env } = {}) {
  const no = (reason, extra) => Object.assign({ ok: false, reason, to: null, timedOut: false, offline: false, missing: false }, extra || {});
  const mismatch = originMismatch(src, env);
  if (mismatch) return no(mismatch);
  // un clon de lectura `--bare` (la capa de la story 8.13.1) también se trae: no tiene árbol, pero sí sus refs
  if (!isRepo(src.dir, { env }) && !isBare(src.dir, { env })) return no(`${src.name}: ${src.dir} no es un clon de git`);
  const budget = budgetOf(budgetS, env);
  // con las etiquetas de número: el número de un commit que numeró el merge es su etiqueta (`versionAt`)
  const r = git(src.dir, ['fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`, `+refs/tags/${versionOrder.TAG_PREFIX}*:refs/tags/${versionOrder.TAG_PREFIX}*`], { env, timeout: Math.round(budget * 1000) });
  if (r.timedOut) {
    // el fetch matado es el propio: si dejó su lock, se limpia (sólo ése)
    const g = gitDir(src.dir, { env });
    if (g) { try { fs.rmSync(path.join(g, 'FETCH_HEAD.lock'), { force: true }); } catch (_) { /* no quedó */ } }
    return no(`sin red: el fetch de ${src.name} no contestó en ${secondsText(budget)} s`, { timedOut: true, offline: true });
  }
  if (!r.ok && isNetworkError(r.err)) return no(`sin red: no pude llegar al origin de ${src.name} (${firstLine(r.err)})`, { offline: true });
  if (!r.ok) return no(`no pude traer ${src.name} (origin/${ref}): ${firstLine(r.err) || 'git fetch falló'}`, { missing: /couldn't find remote ref/i.test(r.err) });
  // el fetch salió bien: la ref traída tiene que poder leerse. Si no, no es «la rama no está» (eso lo dice `missing`, que
  // sale del remoto): es «no pude mirar»
  const tip = refState(src.dir, `refs/remotes/origin/${ref}`, { env });
  if (tip.status !== 'ok') return no(`no pude leer refs/remotes/origin/${ref} de ${src.name} después del fetch (${tip.reason || 'la ref no quedó en el clon'})`);
  return { ok: true, reason: null, to: tip.sha, timedOut: false, offline: false, missing: false };
}
function fetch(src, opts = {}) { return fetchRef(src, src.ref, opts); }

/**
 * Mira sin mover: al día / hay nueva / más vieja (no se baja) / no pude mirar. Un fetch que falló no es «al día».
 * Con `channel` (la política vigente) y una fuente que se reescribe, la ref se calcula ACÁ y queda en `src.ref`: `stable`
 * trae `main`; `latest` trae `main` y `mirror/sync`, y lee `main` si la rama no está o es más vieja (`note` lo dice).
 * Sin `channel` se mira la ref que la fuente ya trae.
 * @returns {{ status: 'up_to_date'|'new'|'older'|'unknown', from, to, reason, ref, mainTip, numbers: {from, to}, note }}
 */
function check(src, { budgetS, env = process.env, channel } = {}) {
  const from = head(src.dir, { env });
  const out = (o) => Object.assign({ status: 'unknown', from, to: null, reason: null, ref: src.ref, mainTip: null, numbers: { from: null, to: null }, note: null }, o);
  // un HEAD que no se puede leer (su rama rota) no es «nada instalado»: sin saber qué hay no se compara, ni se sale a la
  // red. (Una carpeta que no es un clon sigue por el camino de siempre: lo dice el fetch.)
  if (!from && isRepo(src.dir, { env })) {
    const h = refState(src.dir, 'HEAD', { env });
    return out({ reason: `no pude mirar ${src.name}: no pude leer HEAD de ${src.dir} (${h.reason || 'no apunta a ningún commit'})` });
  }
  if (!src.rewrites || !channel) {
    if (channel) src.ref = channelRef(src, channel);
    const f = fetch(src, { budgetS, env });
    if (!f.ok) return out({ reason: f.reason });
    if (!f.to) return out({ reason: `no pude mirar ${src.name}: origin/${src.ref} no existe después del fetch` });
    const a = assess(src, from, f.to, { env, channel, labels: { to: `origin/${src.ref}` } });
    if (a.status === 'unknown') return out({ reason: `no pude mirar ${src.name}: ${a.reason}`, to: f.to });
    return out({ status: a.status, to: f.to, ref: src.ref, numbers: a.numbers });
  }
  // fuente que se reescribe: `main` siempre (el estable, y la base del enlace de cambios); en `latest`, además la rama
  const m = fetchRef(src, MAIN_REF, { budgetS, env });
  if (!m.ok) return out({ reason: m.reason });
  if (!m.to) return out({ reason: `no pude mirar ${src.name}: origin/${MAIN_REF} no existe después del fetch` });
  let ref = MAIN_REF; let to = m.to; let note = null;
  if (channelRef(src, channel) === SYNC_REF) {
    const s = fetchRef(src, SYNC_REF, { budgetS, env });
    if (s.ok && s.to) {
      // el número de una de las dos puntas no se pudo leer: no se elige rama a ciegas («no pude mirar»)
      const prefer = preferSync(src.dir, s.to, m.to, env);
      if (prefer.problem) return out({ reason: `no pude mirar ${src.name}: ${prefer.problem}`, mainTip: m.to });
      if (prefer.sync) { ref = SYNC_REF; to = s.to; } else note = `latest lee ${MAIN_REF}: ${SYNC_REF} no trae nada más nuevo que ${MAIN_REF}`;
    } else if (s.missing) {
      // la rama no está en el remoto (se borró al mergear): la copia local de esa rama ya no dice nada
      git(src.dir, ['update-ref', '-d', `refs/remotes/origin/${SYNC_REF}`], { env });
      note = `latest lee ${MAIN_REF}: el remoto no tiene ${SYNC_REF}`;
    } else return out({ reason: s.reason || `no pude mirar ${src.name}: origin/${SYNC_REF} no se pudo leer después del fetch`, mainTip: m.to });
  }
  src.ref = ref;
  const a = assess(src, from, to, { env, channel, labels: { to: `origin/${ref}` } });
  if (a.status === 'unknown') return out({ reason: `no pude mirar ${src.name}: ${a.reason}`, to, ref, mainTip: m.to });
  if (a.pending) {
    // la punta espera su etiqueta: recién entró, o el proceso que etiqueta no corrió. Se mide por la hora del commit (el
    // merge): pasadas unas horas ninguna máquina se actualiza, y eso se dice como algo que no se pudo mirar
    const ct = git(src.dir, ['log', '-1', '--format=%ct', to], { env, timeout: 10000 });
    const ageMs = ct.ok ? Date.now() - Number(ct.out) * 1000 : 0;
    if (ageMs >= PENDING_TAG_SAY_MS) {
      return out({ reason: `no pude mirar ${src.name}: la punta de origin/${ref} (${to.slice(0, 7)}) lleva ${Math.floor(ageMs / 3600000)} h sin su número (la etiqueta v<número> que pone el merge): el proceso que la pone no corrió y ninguna máquina se actualiza — avisá a quien mantiene el arnés`, to, ref, mainTip: m.to });
    }
    return out({ status: 'up_to_date', to, ref, mainTip: m.to, numbers: a.numbers, note: `la punta de origin/${ref} (${to.slice(0, 7)}) recién entró y todavía no tiene su número: se aplica cuando lo tenga` });
  }
  return out({ status: a.status, to, ref, mainTip: m.to, numbers: a.numbers, note });
}

// ── planear / avanzar / volver ───────────────────────────────────────────────────────────────────

/**
 * Qué pasaría al avanzar (después de `fetch`): si se puede, desde dónde a dónde, si hay que apartar algo.
 * @returns {{ ok, reason, from, to, dirty, divergent, upToDate, setAside: string[], excluded: string[] }}
 */
// `also`: rutas que quien llama sabe suyas y no cuentan como «cambios sin commitear» (story 8.13.1: los archivos que la
// capa pisó a propósito, cuyo sha256 es el del manifiesto; la capa se re-apila después de mover el árbol).
function plan(src, { env = process.env, home = os.homedir(), also = [] } = {}) {
  const from = head(src.dir, { env });
  // lo traído, en tres estados: una ref remota que no se deja leer no es «todavía no se trajo nada»
  const tip = refState(src.dir, `refs/remotes/origin/${src.ref}`, { env });
  const to = tip.sha;
  const base = { from, to, dirty: false, divergent: false, upToDate: false, setAside: [], excluded: [] };
  if (!from) {
    if (!isRepo(src.dir, { env })) return Object.assign(base, { ok: false, reason: `${src.name}: ${src.dir} no es un clon de git` });
    return Object.assign(base, { ok: false, reason: `${src.name}: no pude leer HEAD de ${src.dir} (${refState(src.dir, 'HEAD', { env }).reason || 'no apunta a ningún commit'}): no se toca nada` });
  }
  if (tip.status === 'problem') return Object.assign(base, { ok: false, reason: `${src.name}: no pude leer refs/remotes/origin/${src.ref} (${tip.reason}): no se toca nada` });
  if (!to) return Object.assign(base, { ok: false, reason: `${src.name}: no hay origin/${src.ref} traída (fetch primero)` });
  const g = `git -C ${src.dir}`;
  if (!src.rewrites) {
    const cur = branch(src.dir, { env });
    const dirty = dirtyTracked(src.dir, env);
    if (dirty === null) return Object.assign(base, { ok: false, reason: `${src.name}: no pude mirar si hay cambios sin commitear en ${src.dir} (git status falló): no se toca nada` });
    base.dirty = dirty;
    if (cur !== src.ref) return Object.assign(base, { ok: false, reason: `${src.name} está en la rama ${cur || '(sin rama)'} y no en ${src.ref}: no se toca (${g} checkout ${src.ref})` });
    if (from === to) return Object.assign(base, { ok: true, reason: null, upToDate: true });
    // los commits propios: una cuenta que git no pudo hacer no es «cero»
    const counted = git(src.dir, ['rev-list', '--count', `refs/remotes/origin/${src.ref}..HEAD`], { env });
    const ahead = counted.ok ? parseInt(counted.out, 10) : NaN;
    if (!Number.isFinite(ahead)) return Object.assign(base, { ok: false, reason: `${src.name}: no pude contar los commits propios sobre origin/${src.ref} (${why(counted)}): no se toca nada` });
    if (ahead > 0) {
      return Object.assign(base, { ok: false, divergent: true, reason: `${src.name} divergió: ${ahead} commit(s) propios sobre ${src.ref} que origin no tiene — no se toca (${g} log origin/${src.ref}..HEAD; branch-guard-notice sigue avisando)` });
    }
    const colliding = collidingUntracked(src.dir, src.ref, env);
    const blocking = colliding.filter((f) => !REGENERABLE.some((re) => re.test(f)));
    if (blocking.length) {
      return Object.assign(base, { ok: false, reason: `${src.name}: lo publicado agrega archivos que acá existen sin trackear: ${blocking.join(', ')} — movelos o borralos (${g} stash push -u -- ${blocking.join(' ')})` });
    }
    return Object.assign(base, { ok: true, reason: null, setAside: colliding });
  }
  const excluded = [...excludedFor(src, { home }), ...also];
  base.excluded = excluded;
  if (from === to) return Object.assign(base, { ok: true, reason: null, upToDate: true });
  // se mueve sólo desde `tycon/installed`, o la primera vez, con HEAD en el commit registrado o en un avance simple de
  // la rama por defecto (A5): de cualquier otra rama `checkout -B` + `reset --hard` sacaría a la persona de su rama
  const off = offInstalledBranch(src, { env, home });
  if (off) return Object.assign(base, { ok: false, reason: off });
  // lo modificado en archivos que el arnés sigue traba el reset (se perdería), fuera de las skills de terceros declaradas
  const c = isClean(src.dir, { env, excluded, untracked: false });
  if (!c.clean) {
    return Object.assign(base, { ok: false, dirty: true, reason: c.reason || `${src.name}: hay cambios sin commitear en archivos que el arnés sigue: ${shown(c.files)} — con una ref que se reescribe no se hace reset (commiteá en una rama tuya, o apartá con ${g} stash push)` });
  }
  // lo sin seguir no traba (D3), salvo lo que choca con una ruta que la versión nueva trae: el reset lo pisaría
  const hits = untrackedCollisions(src.dir, to, env);
  if (hits === null) return Object.assign(base, { ok: false, reason: `${src.name}: no pude listar los archivos sin seguir de ${src.dir}: no se toca nada` });
  if (hits.length) {
    // la ruta de acá y, si no es letra por letra la misma (una carpeta, otra caja, otra forma de los acentos), la nueva
    const named = hits.map((h) => (h.with === h.path ? h.path : `${h.path} (choca con ${h.with} de la versión nueva)`));
    return Object.assign(base, { ok: false, dirty: true, colliding: hits.map((h) => h.path), reason: `${src.name}: ${shown(named)} existe acá sin seguir y la versión nueva trae esa misma ruta: no se toca nada (movelo o borralo, y volvé a correr update)` });
  }
  return Object.assign(base, { ok: true, reason: null });
}
const shown = (files) => files.slice(0, 6).join(', ') + (files.length > 6 ? ` y ${files.length - 6} más` : '');

/** Cuántos commits tiene HEAD que NINGUNA rama traída de `origin` tiene (los propios de la persona); `null` si git no
 *  pudo contestar («no sé» no es «ninguno»). Un `git pull` deja HEAD en lo traído: 0. */
function ownCommits(dir, env) {
  const r = git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], { env });
  const n = r.ok ? parseInt(r.out, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** La rama por defecto del clon: la que dejó `git clone` (a la que apunta `origin/HEAD`); si no se sabe, `main`. */
function defaultBranch(dir, env) {
  const r = value(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { env });
  return r && r.startsWith('origin/') ? r.slice('origin/'.length) : MAIN_REF;
}

/**
 * En una fuente que se reescribe: el motivo por el que NO se mueve desde donde está parada, o `null` si se puede:
 *   · está en `tycon/installed`; o
 *   · es la primera vez (esa rama todavía no existe) y HEAD es el commit registrado; o
 *   · es la primera vez y HEAD es un AVANCE SIMPLE del commit registrado: el clon sigue en su rama por defecto (la que
 *     dejó `git clone`), lo que el arnés sigue está sin modificar, HEAD desciende del commit registrado y no trae commits
 *     propios (todo lo suyo está en lo traído de `origin`). Es lo que deja un `git pull` a mano o el respaldo en shell
 *     (`git pull --ff-only`) antes de la primera actualización: no es trabajo de la persona (pase adversarial de la
 *     tanda D: sin esto ese clon quedaba bloqueado para siempre).
 * Una rama propia, commits propios o archivos seguidos modificados no se tocan: el motivo dice qué hay y un comando que
 * SE PUEDE correr —nunca `checkout tycon/installed` cuando esa rama no existe—.
 *
 * `onlyFromInstalled`: para quien mueve SÓLO desde la rama del mecanismo (`rollback`: vuelve con `reset --hard` sobre la
 * rama, y nunca sobre la rama por defecto de un clon del público). Ahí «la primera vez» no alcanza: donde `update`
 * pasaría, el motivo es que la rama todavía no existe, y el remedio es crearla donde está parado. `who` es el comando que
 * se nombra en el remedio. Un solo lugar arma estos textos: el de `update`, el de `doctor` y el de `rollback` no divergen.
 */
function offInstalledBranch(src, { env = process.env, home = os.homedir(), onlyFromInstalled = false, who = 'update' } = {}) {
  // la rama del mecanismo, en tres estados: «no existe» (la primera vez) se decide sólo si git lo CONTESTÓ. Una rama que
  // no se pudo leer no es «la primera vez»: no se mueve nada, no se aconseja nada sobre ella, y se nombra la ref
  const installed = refState(src.dir, `refs/heads/${INSTALLED_BRANCH}`, { env });
  const unreadable = (ref, reason, unknown) => `${src.name}: no pude leer ${ref} en ${src.dir} (${reason}): no se sabe ${unknown} — no se toca nada hasta que se pueda leer`;
  if (installed.status === 'problem') return unreadable(`refs/heads/${INSTALLED_BRANCH}`, installed.reason, 'si la rama del mecanismo existe');
  const cur = branch(src.dir, { env });
  if (cur === INSTALLED_BRANCH) return null;
  const g = `git -C ${src.dir}`;
  if (installed.status === 'ok') {
    return `${src.name} está en la rama ${cur || '(sin rama)'} y no en ${INSTALLED_BRANCH}: no se toca (${g} checkout ${INSTALLED_BRANCH})`;
  }
  // la primera vez
  const where = cur ? `en la rama ${cur}` : 'en un commit suelto (sin rama)';
  const kept = cur ? `la rama ${cur}` : 'ese commit';
  const missing = `la rama ${INSTALLED_BRANCH} todavía no existe (la crea la primera actualización)`;
  // donde `update` pasa: nada que decir, salvo para quien sólo mueve desde la rama (crearla acá no cambia ningún archivo)
  const passes = () => (onlyFromInstalled
    ? `${src.name} está ${where} y ${missing}: no se toca (para que ${who} lo mueva, dejando ${kept} como está: ${g} checkout -b ${INSTALLED_BRANCH})`
    : null);
  const h = head(src.dir, { env });
  if (!h) return unreadable('HEAD', refState(src.dir, 'HEAD', { env }).reason || 'no apunta a ningún commit', 'qué hay instalado');
  if (src.commit && h === src.commit) return passes();
  const own = ownCommits(src.dir, env);
  const onDefault = Boolean(cur) && cur === defaultBranch(src.dir, env);
  // ¿HEAD desciende del commit registrado? Que ese commit no esté en el clon se sabe (no desciende); que git no haya
  // podido compararlos, no: «no sé» no es «no desciende», y tampoco «sí»
  const registered = src.commit ? commitState(src.dir, src.commit, { env }) : null;
  if (registered && registered.status === 'problem') return unreadable(`el commit registrado ${String(src.commit).slice(0, 7)}`, registered.reason, 'si HEAD desciende de él');
  const descends = !registered ? true : (registered.status === 'absent' ? false : ancestor(src.dir, src.commit, h, env));
  if (descends === null) return `${src.name}: ${cannotCompare(`el commit registrado ${String(src.commit).slice(0, 7)}`, `HEAD (${h.slice(0, 7)})`)} — no se toca nada`;
  const c = isClean(src.dir, { env, excluded: excludedFor(src, { home }), untracked: false });
  if (own === 0 && onDefault && descends) {
    if (c.clean || onlyFromInstalled) return passes();
    return `${src.name} está en la rama ${cur}, más adelante que el commit registrado, y tiene cambios sin commitear en archivos que el arnés sigue (${c.reason || shown(c.files)}): no se toca (apartalos con ${g} stash push, o commiteá en una rama tuya, y volvé a correr ${who})`;
  }
  const what = own === null ? ', y no pude ver si tiene commits propios'
    : own > 0 ? `, con ${own} commit(s) que origin no tiene`
      : !onDefault ? `, en un commit que no es el registrado (${String(src.commit).slice(0, 7)})`
        : `, en un commit que no desciende del registrado (${String(src.commit).slice(0, 7)})`;
  const base = `${src.name} está ${where}${what}, y ${missing}: no se toca`;
  // sin rama, lo propio no quedaría en ningún lado: primero a una rama de la persona
  if (!cur && own !== 0) return `${base} (guardá ese trabajo en una rama tuya —${g} checkout -b <nombre>— y volvé a correr ${who})`;
  // el commit registrado como punto de partida, si está en el clon: la rama de la persona queda como está
  const start = registered && registered.status === 'ok' ? ` ${src.commit}` : '';
  const aside = c.clean ? '' : `apartá antes tus cambios sin commitear con ${g} stash push; `;
  return `${base} (para que ${who} lo mueva, ${aside}dejando ${kept} como está: ${g} checkout -b ${INSTALLED_BRANCH}${start})`;
}

function savePrevious(src, from, env) {
  return git(src.dir, ['update-ref', previousRef(src.name), from], { env }).ok;
}

/**
 * Reaplica el stash propio. Primero CON el índice (`--index`): lo que la persona tenía agregado vuelve agregado. Sin eso
 * volvía como «modificado sin agregar» —el contenido intacto, el índice no—, y la ida y vuelta de la llave de la 8.18
 * promete dejar el clon como estaba (pase adversarial del tramo 3, clases 16 y 19). Si el índice guardado no entra sobre
 * el commit de ahora, git se niega ANTES de tocar nada («Conflicts in index»): ahí se reaplica sin él, como siempre, y lo
 * agregado vuelve sin agregar. Si el intento con índice dejó algo a medias no se insiste: quien llama limpia y lo local
 * queda en el stash.
 * @returns el resultado de `git()` del intento que valió
 */
function popStash(dir, env) {
  const withIndex = git(dir, ['stash', 'pop', '-q', '--index'], { env });
  if (withIndex.ok) return withIndex;
  if (dirtyTracked(dir, env) !== false) return withIndex;
  return git(dir, ['stash', 'pop', '-q'], { env });
}
/** Lo que se dice cuando `popStash` no pudo reaplicar en un camino de ERROR: lo local no se perdió, quedó en el stash, y
 *  hay que decirlo con el comando para verlo. Antes esos dos caminos (el merge de `advance` que falló, el reset de
 *  `revert` que falló) ignoraban el resultado y lo del dev quedaba en el stash sin aviso (segunda vuelta del revisor de
 *  fallos silenciosos del tramo 3). */
const keptInStash = (dir, pop) => `lo que tenías sin commitear no se pudo reaplicar (${firstLine(pop.err) || `git salió ${pop.status}`}): no se perdió, quedó en git -C ${dir} stash list`;

/**
 * Avanza la fuente a lo traído. Ref fija: stash propio + `merge --ff-only` + pop; ref reescrita: `tycon/installed` +
 * `reset --hard`. Antes guarda `previous` en `refs/tycon/previous/<name>`.
 * @returns {{ ok, reason, from, to, stashed, kept, setAside, unchanged }}
 *   kept = lo local no se pudo reaplicar y quedó en el stash · setAside = regenerables apartados (no se reaplican)
 */
function advance(src, { env = process.env, home = os.homedir() } = {}) {
  const p = plan(src, { env, home });
  const out = { ok: false, reason: p.reason, from: p.from, to: p.to, stashed: false, kept: false, setAside: [], unchanged: false };
  if (!p.ok) return out;
  if (p.upToDate) return Object.assign(out, { ok: true, reason: null, unchanged: true });
  if (!savePrevious(src, p.from, env)) return Object.assign(out, { reason: `${src.name}: no pude guardar previous (${previousRef(src.name)})` });
  const g = `git -C ${src.dir}`;

  if (src.rewrites) {
    if (branch(src.dir, { env }) !== INSTALLED_BRANCH) {
      const co = git(src.dir, ['checkout', '-q', '-B', INSTALLED_BRANCH], { env });
      if (!co.ok) return Object.assign(out, { reason: `${src.name}: no pude pararme en ${INSTALLED_BRANCH}: ${firstLine(co.err)}` });
    }
    const rs = git(src.dir, ['reset', '-q', '--hard', `refs/remotes/origin/${src.ref}`], { env, timeout: 60000 });
    if (!rs.ok) return Object.assign(out, { reason: `${src.name}: el reset a ${p.to.slice(0, 7)} falló: ${firstLine(rs.err)} (volver: ${g} reset --hard ${p.from})` });
    return Object.assign(out, { ok: true, reason: null });
  }

  // ref fija: como guides-heal.js advance()
  for (const f of p.setAside) {
    const st = git(src.dir, ['stash', 'push', '-q', '-u', '-m', `${STASH_MSG} (no trackeado que lo publicado agrega)`, '--', f], { env });
    if (st.ok) out.setAside.push(f);
  }
  if (p.dirty) {
    const st = git(src.dir, ['stash', 'push', '-q', '-m', STASH_MSG], { env });
    if (!st.ok) return Object.assign(out, { reason: `${src.name}: no pude apartar lo local en un stash: ${firstLine(st.err)}` });
    out.stashed = true;
  }
  const m = git(src.dir, ['merge', '-q', '--ff-only', `refs/remotes/origin/${src.ref}`], { env, timeout: 60000 });
  if (!m.ok) {
    let kept = '';
    if (out.stashed) {
      const pop = popStash(src.dir, env);
      if (!pop.ok) { out.kept = true; kept = ` — ${keptInStash(src.dir, pop)}`; }
    }
    return Object.assign(out, { reason: `${src.name}: el merge --ff-only a ${p.to.slice(0, 7)} falló: ${firstLine(m.err)} (a mano: ${g} merge --ff-only origin/${src.ref})${kept}` });
  }
  if (out.stashed) {
    const pop = popStash(src.dir, env);
    if (!pop.ok) {
      // el pop chocó: el índice queda en conflicto y el stash guardado; se limpia y lo local sigue en el stash
      git(src.dir, ['reset', '-q', '--hard', 'HEAD'], { env });
      out.kept = true;
    }
  }
  return Object.assign(out, { ok: true, reason: null });
}

/** Los archivos de texto que el repo quiere con `\n` y en disco están con `\r\n`: las rutas, o `null` si git no contestó.
 *  Sólo lectura (`git ls-files --eol`). Cuenta lo versionado con `\n` (`i/lf`) cuya regla pide `eol=lf` y cuyo archivo
 *  tiene `\r\n` (`w/crlf`, `w/mixed`): lo declarado `eol=crlf` a propósito (un `.bat`) y lo binario no entran. */
function crlfOnDisk(dir, env) {
  // con -z: sin él, git cita un nombre con eñe o comillas («"a\303\261o.txt"») y la receta no lo encontraría
  const r = git(dir, ['ls-files', '--eol', '-z'], { env, timeout: 60000 });
  if (!r.ok) return null;
  const out = [];
  for (const row of zlist(r.raw)) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const info = row.slice(0, tab);
    if (/^i\/lf\s/.test(info) && /\sw\/(crlf|mixed)\s/.test(info) && /(^|\s)eol=lf(\s|$)/.test(info)) out.push(row.slice(tab + 1));
  }
  return out;
}

/** Los archivos marcados `--assume-unchanged` (letra en minúscula en `ls-files -v`) o `--skip-worktree` (`S`): sus
 *  cambios locales no salen en `git status`. Las rutas, o `null` si git no contestó. */
function hiddenFromStatus(dir, env) {
  const r = git(dir, ['ls-files', '-v', '-z'], { env, timeout: 60000 });
  if (!r.ok) return null;
  return zlist(r.raw).filter((e) => /^([a-z]|S) /.test(e)).map((e) => e.slice(2));
}
/** ¿El índice está vacío y HEAD tiene archivos? Los de HEAD (0 = no; también si no se pudo mirar: eso lo dice otro paso).
 *  Es lo que deja la receta vieja (`rm --cached -r .` + `reset --hard`) si moría entre sus dos pasos. */
function emptyIndexWithHead(dir, env) {
  const idx = git(dir, ['ls-files', '-z'], { env, timeout: 60000 });
  if (!idx.ok || idx.raw.length) return 0;
  const inHead = git(dir, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { env, timeout: 60000 });
  return inHead.ok ? zlist(inHead.raw).length : 0;
}

/**
 * Los finales de línea de un clon viejo, ANTES de aplicar (story 8.17, AC 71). Un clon de Windows anterior a
 * `.gitattributes` conserva `\r\n` en todo lo que el `pull` no toca, y un hook `.sh` así no corre: un freno sale distinto
 * de 2 y no frena. `git checkout -- .` y `git reset --hard` solos no lo arreglan (git da esos archivos por no
 * modificados). La receta que se le IMPRIME a la persona es la de `.gitattributes` (`git rm --cached -r -q .` y
 * `git reset --hard -q`); la que corre acá reescribe SÓLO los archivos con `\r\n` desde el índice, sin vaciarlo nunca
 * (pase adversarial de la W3a, B4): se les cambia la fecha —así git ya no los da por al día— y `git checkout-index -f -u`
 * los vuelve a escribir con `\n`. Medido contra la receta impresa: mismos bytes en disco, `git status` limpio y ningún
 * `w/crlf`. Si muere a mitad, el índice sigue entero y la corrida siguiente vuelve a ver los que faltan.
 *   · sólo en Windows (`platform`, que se recibe para poder probarlo sin Windows) y sólo en modo instalado (`managed`):
 *     en `developer` no se toca el git del dev;
 *   · sólo con el árbol limpio (la receta descarta lo que está sin commitear); sucio, no toca nada y dice qué correr. Y
 *     tampoco con un archivo marcado `--assume-unchanged` o `--skip-worktree`: `git status` no ve sus cambios (B3);
 *   · un índice vacío con un HEAD que tiene archivos no es «limpio»: es un clon roto, y se dice cómo rearmarlo (B4);
 *   · nunca tira y nunca frena a quien llama: si un paso falla, lo dice en `line`.
 * @returns {{ status: 'skipped'|'clean'|'normalized'|'dirty'|'broken'|'failed', files: number, line: string|null }}
 *   `line` = lo que hay que decirle a la persona (null si no hay nada que decir)
 */
function normalizeEol(dir, { env = process.env, platform = process.platform, mode = 'managed' } = {}) {
  if (platform !== 'win32' || mode !== 'managed') return { status: 'skipped', files: 0, line: null };
  const before = crlfOnDisk(dir, env);
  if (before === null) return { status: 'failed', files: 0, line: `no pude mirar los finales de línea de ${dir} (git ls-files --eol falló): sigo sin normalizar` };
  if (!before.length) {
    const inHead = emptyIndexWithHead(dir, env);
    if (inHead) return { status: 'broken', files: 0, line: `el índice de git de ${dir} está vacío y HEAD tiene ${inHead} archivo(s): para git todo figura «borrado» (una normalización anterior que se cortó a mitad), y así no se ven los finales de línea ni se puede actualizar. No toqué nada. Para rearmarlo, sin tocar tus archivos:  git -C "${dir}" reset -q` };
    return { status: 'clean', files: 0, line: null };
  }
  const n = before.length;
  const what = `${n} archivo(s) de texto con \\r\\n en ${dir} (un clon anterior a .gitattributes; un hook .sh así no corre)`;
  // la ruta entre comillas: una carpeta con un espacio (lo común en una carpeta de usuario de Windows) rompería el remedio
  const recipe = `git -C "${dir}" rm --cached -r -q .   y después   git -C "${dir}" reset --hard -q`;
  // Cómo comprobarlo. Después de un intento que quedó a medias, `git status` y `git diff` salen LIMPIOS aunque un archivo
  // siga con \r\n (git compara ya convertido): quien compruebe con ellos no ve nada y descarta el aviso.
  const verify = `Para comprobarlo:  git -C "${dir}" ls-files --eol  — los que digan w/crlf siguen con \\r\\n (git status y git diff NO los muestran)`;
  const dirty = dirtyTracked(dir, env);
  if (dirty === null) return { status: 'failed', files: n, line: `hay ${what} y no pude mirar si hay cambios sin commitear (git status falló): no toqué nada` };
  if (dirty) return { status: 'dirty', files: n, line: `hay ${what} y el árbol tiene cambios sin commitear: no toqué nada. Guardá o descartá tus cambios y corré: ${recipe}` };
  // un cambio local que `git status` no muestra (B3): «árbol limpio» no alcanza, y la receta lo pisaría
  const hidden = hiddenFromStatus(dir, env);
  if (hidden === null) return { status: 'failed', files: n, line: `hay ${what} y no pude mirar si hay archivos con cambios que git status no muestra (git ls-files -v falló): no toqué nada` };
  if (hidden.length) {
    const named = hidden.slice(0, 3).join(', ') + (hidden.length > 3 ? ` y ${hidden.length - 3} más` : '');
    return { status: 'dirty', files: n, line: `hay ${what}, y ${hidden.length} archivo(s) marcados --assume-unchanged o --skip-worktree (${named}): git status no muestra sus cambios y la normalización podría pisarlos, así que no toqué nada. Quitales la marca (git -C "${dir}" update-index --no-assume-unchanged <archivo>, o --no-skip-worktree), guardá o descartá sus cambios y corré: ${recipe}` };
  }
  // la receta (B4). `read-tree HEAD` rearma el índice de una vez (con el árbol limpio, es el mismo contenido) y deja sus
  // datos de disco en cero: así `checkout-index -f` ya no da esos archivos por al día y los reescribe desde el índice, por
  // lista y con -z. El índice nunca queda vacío: si algo muere a mitad, `git status` sigue limpio y la corrida siguiente
  // ve los que faltan. (Medido: cambiarles sólo la fecha no alcanza —un `git status` en el medio la vuelve a dar por buena—,
  // y si `checkout-index` falla no escribe el índice y `git status` mostraba como modificado lo ya reescrito.)
  const rt = git(dir, ['read-tree', 'HEAD'], { env, timeout: 60000 });
  if (!rt.ok) return { status: 'failed', files: n, line: `hay ${what} y no pude normalizarlos (git read-tree HEAD: ${why(rt)}): no toqué nada. A mano: ${recipe}` };
  const co = git(dir, ['checkout-index', '-f', '-u', '-z', '--stdin'], { env, timeout: 120000, input: before.map((f) => `${f}\0`).join('') });
  if (!co.ok) {
    // lo que de verdad sigue con \r\n DESPUÉS del intento (no la cuenta de antes): pudo reescribir una parte
    const left = crlfOnDisk(dir, env);
    const still = left === null ? 'no pude comprobar cuántos siguen con \\r\\n' : (left.length ? `siguen con \\r\\n: ${left.length} (${shown(left)})` : 'ya no queda ninguno con \\r\\n');
    return { status: 'failed', files: n, line: `hay ${what} y no pude normalizarlos todos (git checkout-index: ${why(co)}; ¿un archivo abierto por otro programa?): ${still}. ${verify}. A mano, con ese archivo ya libre: ${recipe}` };
  }
  const after = crlfOnDisk(dir, env);
  if (after === null || after.length) return { status: 'failed', files: n, line: `corrí la normalización sobre ${what} y ${after === null ? 'no pude comprobar cómo quedó' : `quedaron ${after.length} (${shown(after)})`}: no pude dejarlos todos con \\n. ${verify}. A mano: ${recipe}` };
  return { status: 'normalized', files: n, line: `normalicé ${what}: ahora están con \\n` };
}

/**
 * Vuelve la fuente a `previous`. Lo local NO se pierde: `advance` ya reaplicó lo que el dev tenía sin commitear, así que
 * antes del `reset --hard` se aparta en un stash propio y después se reaplica, con su índice (`popStash`); si la
 * reaplicación choca, queda en el stash y se dice (pase adversarial de la tanda A, clases 9 y 23: el reset a secas lo
 * borraba sin copia). Lo SIN SEGUIR no se aparta: quien llama mira antes que nada suyo esté en el camino (`reset --hard`
 * pisa sin avisar un archivo sin seguir en una ruta que vuelve — `repoint.js` lo frena en la vuelta de la llave).
 * @returns {{ ok, reason, kept }}  kept = lo local quedó en `git stash list` (no se pudo reaplicar sobre previous)
 */
function revert(src, previous, { env = process.env } = {}) {
  if (!previous) return { ok: false, reason: `${src.name}: sin previous a dónde volver`, kept: false };
  let stashed = false;
  const dirty = dirtyTracked(src.dir, env);
  // sin saber si hay cambios sin commitear no se hace `reset --hard`: los borraría sin copia
  if (dirty === null) return { ok: false, reason: `${src.name}: no pude mirar si hay cambios sin commitear en ${src.dir} (git status falló) — no se tocó nada`, kept: false };
  if (dirty) {
    const st = git(src.dir, ['stash', 'push', '-q', '-m', `${STASH_MSG} (antes de volver a ${String(previous).slice(0, 7)})`], { env });
    if (!st.ok) return { ok: false, reason: `${src.name}: no pude apartar lo local antes de volver: ${firstLine(st.err)} — no se tocó nada`, kept: false };
    stashed = true;
  }
  const r = git(src.dir, ['reset', '-q', '--hard', previous], { env, timeout: 60000 });
  if (!r.ok) {
    const pop = stashed ? popStash(src.dir, env) : null;
    const kept = Boolean(pop && !pop.ok);
    return { ok: false, reason: `${src.name}: no pude volver a ${String(previous).slice(0, 7)}: ${firstLine(r.err)}${kept ? ` — ${keptInStash(src.dir, pop)}` : ''}`, kept };
  }
  if (!stashed) return { ok: true, reason: null, kept: false };
  const pop = popStash(src.dir, env);
  if (pop.ok) return { ok: true, reason: null, kept: false };
  git(src.dir, ['reset', '-q', '--hard', previous], { env });
  return { ok: true, kept: true, reason: `${src.name}: lo que tenías sin commitear no se pudo reaplicar sobre ${String(previous).slice(0, 7)}: quedó en git -C ${src.dir} stash list` };
}

module.exports = {
  STASH_MSG, REGENERABLE, INSTALLED_BRANCH, MAIN_REF, SYNC_REF, DEFAULT_BUDGET_S, PUBLIC_REMOTES_FILE, previousRef,
  git, head, origin, branch, isRepo, isBare, remoteTip, detect, thirdPartyDirs, excludedFor, isClean,
  fetch, check, plan, advance, revert, budgetOf, secondsText, originMismatch, isNetworkError,
  remoteIdentity, webBase, publicRemotes, isPublicRemote, channelRef, versionAt, assess, offInstalledBranch, untrackedInTheWay,
  collidingPaths, ownCommits, defaultBranch, refState, commitState, ancestor, ancestorState,
  crlfOnDisk, normalizeEol, gitEnv,
};
