#!/usr/bin/env node
'use strict';
// legacy-names.js — que un nombre viejo siga andando mientras dura el renombre a inglés (story 8.9, tanda A2 · 2026-09-30)
//
// POR QUÉ EXISTE: la story 8.9 renombra a inglés lo que ejecuta la máquina (archivos, opciones, subcomandos, valores,
// variables, claves, archivos de configuración y de estado). Esos nombres viven también FUERA del commit que los cambia:
// en el settings.json de cada máquina, en los pipelines de los productos, en el .zshrc de alguien, en otro repo que se
// actualiza con otro pull. Esta biblioteca hace que el nombre viejo haga lo mismo que el nuevo, sin decir nada, hasta la
// fecha de retiro (`retire_after` del mapa), y anota cada uso para saber cuándo se puede retirar.
//
// EL MAPA: scripts/lib/renames.json (`entries`: kind, old, new, where, batch, callers; ver AC 13 de la story). En la copia
// pública no viaja: sin el mapa, todo esto es paso directo y no cuesta nada. Las rutas del mapa son relativas a la raíz
// del repo (o `~/…` en config-file/state-file) y se validan: una entrada con una ruta que podría salir de la raíz o de la
// HOME no se usa nunca (el validador `spanish-names.js --check-map` la rechaza en el pre-commit).
//
// LO QUE USA UN SCRIPT:
//   readEnv('TYCON_NEW')                 la variable, o la vieja si sólo está la vieja (distintas: gana la nueva)
//   envNames('TYCON_NEW')                [nuevo, viejo]: para buscar la variable en el texto de un comando
//   aliasOptions(argv, where)            el argv con opciones, subcomandos y valores viejos pasados a los nuevos
//   aliasArgv(where, { exitCode })       lo mismo sobre process.argv, en el lugar: la línea al entrar de un script
//   resolveFile(nuevo) · readKeys(obj, where) · readKeysDeep(obj, where) · prepareStateWrite(nuevo)   configuración y estado
// Anotar un uso nunca tira ni demora: una línea por (nombre viejo, script, día) en
// ~/.claude/.tycon-pipeline/legacy-names.jsonl, sin valores ni rutas de la máquina; en Azure DevOps (TF_BUILD), además un
// warning en la corrida, que es donde se ve el uso desde los pipelines de los productos.
//
// A mano:
//   node scripts/lib/legacy-names.js --write-shims [--map <archivo>] [--root <arnés>] [--skills-root <agent-skills>]
//   node scripts/lib/legacy-names.js --migrate-machine [--check] [--guides <arnés>] [--skills <agent-skills>] [--home <dir>]
//   node scripts/lib/legacy-names.js --migrate-machine --reroot <de> <a> [--check] [--json] [--only-existing] [--home <dir>]
//                                    (cambia la raíz de lo escrito en la máquina; anda sin el mapa: story 8.19, tanda B)
//   node scripts/lib/legacy-names.js --migrate-bench [--check] [--root <arnés>]   (claves del banco y de las suites)
//   node scripts/lib/legacy-names.js --shell <where>                (lo que carga legacy-names.sh)
//   node scripts/lib/legacy-names.js --prepare-state <ruta>… [--where <script>]   (prepareStateWrite para bash: tanda D2)
//   node scripts/lib/legacy-names.js --log-use <kind> <old> <new> <script> [--conflict]
// Guía: guides/nombres-en-ingles.md

const fs = require('fs');
const os = require('os');
const path = require('path');
// la carpeta del estado la sabe scripts/setup/harness/tycon-home.js (story 8.23, tanda D): se carga si está al lado (en el
// repo, y en /opt/tycon/setup/harness/ por el instalador del freno); si no, la de siempre
function stateDirOf(home) {
  try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(home); } catch (_) { /* la de siempre */ }
  return path.join(claudeDirOf(home), '.tycon-pipeline');
}
// la carpeta de Claude Code en la casa del usuario: también la sabe tycon-home.js; sin él al lado, la de siempre
function claudeDirOf(home) {
  try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.claudeDir === 'function') return TH.claudeDir(home); } catch (_) { /* la de siempre */ }
  return path.join(home, '.claude');
}
const crypto = require('crypto');

const HARNESS_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MAP = path.join(__dirname, 'renames.json');
const KINDS = ['file', 'folder', 'option', 'subcommand', 'value', 'env', 'key', 'config-file', 'state-file'];
const PATH_KINDS = ['file', 'folder', 'config-file', 'state-file'];
// `ado`: lo nombra un pipeline de Azure DevOps por su ruta (un .yml): no hay reemplazo posible, su cambio es tarea humana
const CALLERS = ['machine', 'other-repo', 'products', 'docs', 'same-repo', 'ado'];
const NO_SHIM_CALLERS = ['same-repo', 'ado'];
const SHIM_EXTS = ['.js', '.cjs', '.mjs', '.sh', '.command', '.bash', '', '.ps1', '.md'];
const SHIM_MARK = 'tycon-legacy-shim:';
// Los dos nombres del lugar del arnés (story 8.19): ~/.claude/tycon-harness y el viejo, que sigue resolviendo. ESCRITOS
// acá, no importados de scripts/setup/harness/place.js: este archivo viaja solo a la copia del freno de producción en
// /opt. Copia declarada en scripts/tests/fixtures/harness-place-names.json; una prueba frena si se desfasa.
const PLACE_NAME = 'tycon-harness';
const LEGACY_PLACE_NAME = 'tycon-claude-guides';
// la marca, en la segunda línea: `// …` (js), `# …` (shell, ps1) o `<!-- … -->` (md)
const REROOT_USAGE = 'uso: node scripts/lib/legacy-names.js --migrate-machine --reroot <de> <a> [--check] [--json] [--only-existing] [--home <dir>]';
const SHIM_LINE = /^\s*(?:\/\/|#|<!--)\s*tycon-legacy-shim:\s*(\S+?)\s*(?:-->)?\s*$/;

class LegacyNamesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyNamesError';
  }
}

// ── las rutas del mapa ──────────────────────────────────────────────────────────────────────────────────────────
const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
/**
 * Por qué una ruta del mapa no sirve (null si sirve): relativa a la raíz del repo (o `~/…` en config-file y state-file),
 * sin segmentos vacíos, `.` ni `..`, y sólo con letras, dígitos, `.`, `_`, `-` y `/`. Así ninguna entrada puede hacer que
 * la biblioteca escriba fuera de la raíz o de la HOME, ni meter comillas en un reemplazo generado.
 */
function pathProblem(p, kind) {
  if (typeof p !== 'string' || !p) return 'vacía';
  let rel = p;
  if (kind === 'config-file' || kind === 'state-file') {
    if (rel.startsWith('~/')) rel = rel.slice(2);
  }
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'es absoluta (va relativa a la raíz del repo)';
  if (!PATH_CHARS.test(rel)) return 'tiene caracteres que no son de ruta (van letras, dígitos, «.», «_», «-» y «/»)';
  const segs = rel.split('/');
  if (segs.some((s) => s === '')) return 'tiene un segmento vacío (barra al final o doble)';
  if (segs.some((s) => s === '.' || s === '..')) return 'tiene un segmento «.» o «..»';
  return null;
}
const isPathKind = (k) => PATH_KINDS.includes(k);
const entryUsable = (e) => !!e && typeof e === 'object' && (!isPathKind(e.kind) || (pathProblem(e.old, e.kind) === null && pathProblem(e.new, e.kind) === null));
/** ¿`abs` queda adentro de `root`? */
function within(root, abs) {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// una opción del mapa se compara sin los guiones (el validador los rechaza; acá se toleran)
const bare = (e) => (e.kind === 'option' ? { ...e, old: String(e.old).replace(/^-+/, ''), new: String(e.new).replace(/^-+/, '') } : e);

// ── el mapa ─────────────────────────────────────────────────────────────────────────────────────────────────────
const maps = new Map();
let warnedBroken = false;
function mapFile(opts = {}) {
  return opts.mapFile || process.env.TYCON_LEGACY_NAMES_MAP || DEFAULT_MAP;
}
/** El mapa (objeto) o null si no hay. Un mapa roto en tiempo de ejecución es paso directo, dicho una vez: un script no se
 *  puede caer por el mapa (lo valida `spanish-names.js --check-map` en el pre-commit). */
function loadMap(opts = {}) {
  if (opts.map !== undefined) return opts.map;
  const f = mapFile(opts);
  let st;
  try { st = fs.statSync(f); } catch (e) {
    // «no existe» es la copia pública: nada que decir. Cualquier otro error (un permiso, un disco que falla) es «no pude
    // mirar» y se avisa una vez, como el mapa roto: si no, quien busca una ruta vieja por el mapa la daría por ausente
    // en silencio (revisor de fallos silenciosos, tanda C4). Sigue siendo paso directo: un script no se cae por el mapa.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    if (!warnedBroken) {
      warnedBroken = true;
      process.stderr.write(`⚠️  legacy-names: ${f} no se deja leer (${(e && e.code) || (e && e.message) || e}) — los nombres viejos no se traducen hasta que se arregle\n`);
    }
    return null;
  }
  const cached = maps.get(f);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.map;
  let map = null;
  try {
    map = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (!warnedBroken) {
      warnedBroken = true;
      process.stderr.write(`⚠️  legacy-names: ${f} no se deja leer (${e.message}) — los nombres viejos no se traducen hasta que se arregle\n`);
    }
    map = null;
  }
  maps.set(f, { mtimeMs: st.mtimeMs, map });
  return map;
}
/** Todas las entradas con forma de objeto (el validador las mira todas). */
const entriesOf = (map) => (map && Array.isArray(map.entries) ? map.entries.filter((e) => e && typeof e === 'object') : []);
/** Las que se usan en tiempo de ejecución: una ruta inválida nunca se usa (la barra final de una carpeta se tolera acá; el
 *  validador la rechaza al commitear). */
const stripSlash = (s) => (typeof s === 'string' ? s.replace(/\/+$/, '') : s);
const usableEntries = (map) => entriesOf(map).map((e) => (e.kind === 'folder' ? { ...e, old: stripSlash(e.old), new: stripSlash(e.new) } : e)).filter(entryUsable);

// ── rutas ───────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * La raíz de agent-skills: la que diga scripts/lib/skills-dir.js (la variable › el propio clon si es unido › lo instalado).
 *
 * 🔴 El valor de siempre (`~/.claude/agent-skills`) es SÓLO para la copia que viaja sin skills-dir.js al lado (un
 *    laboratorio con esta biblioteca sola). Antes era un `catch` que tragaba cualquier error (pase adversarial del tramo 1
 *    de la story 8.18, 2026-10-04): skills-dir.js TIRA cuando su vecina canonical-path.js está y no carga, justamente para
 *    que nadie pase a leer las skills instaladas sin decirlo, y acá se lo tapaba —medido: en un clon unido con un
 *    `require` roto, `--migrate-machine --check` salía 0 sin una línea, mirando lo instalado—. Se mira si el archivo ESTÁ,
 *    no el mensaje del error: el «Require stack» de un MODULE_NOT_FOUND nombra a skills-dir.js aunque falte otro.
 *    El `require` sigue literal: el control de cierre del freno de producción (T25) lo lee para exigir que viaje a /opt.
 */
function skillsRepoRoot(opts = {}) {
  if (opts.skillsRoot) return opts.skillsRoot;
  if (!fs.existsSync(path.join(__dirname, 'skills-dir.js'))) return path.join(os.homedir(), '.claude', 'agent-skills');
  return require('./skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo;
}
function rootOf(entry, opts = {}) {
  return entry && entry.repo === 'agent-skills' ? skillsRepoRoot(opts) : (opts.root || HARNESS_ROOT);
}
function expand(p, entry, opts = {}) {
  const home = opts.home || os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.join(rootOf(entry, opts), p);
}
/** El script que usa el nombre viejo, relativo a su repo; afuera del arnés, sólo su nombre (nunca una ruta de la máquina). */
function scriptOf(where) {
  if (where) return String(where);
  const f = require.main && require.main.filename;
  if (!f) return 'desconocido';
  const rel = path.relative(HARNESS_ROOT, f);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(f);
}

// ── el registro de usos ─────────────────────────────────────────────────────────────────────────────────────────
const warnedCi = new Set();
let warnedLog = false;
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/**
 * Anota que se usó un nombre viejo: una línea por (nombre viejo, script, día) —un conflicto es otra línea—. La marca por
 * día (`legacy-names.d/`) se crea con `wx`, así que dos procesos que leen mil veces a la vez escriben una sola línea. Nunca
 * tira ni demora; si no puede escribir, lo dice una vez por proceso (el registro de esa máquina queda incompleto).
 */
function recordUse({ kind, old, new: nu, script, conflict = false } = {}, opts = {}) {
  const env = opts.env || process.env;
  const where = scriptOf(script);
  if (/^true$/i.test(String(env.TF_BUILD || '')) && !warnedCi.has(`${kind}\0${old}\0${where}`)) {
    warnedCi.add(`${kind}\0${old}\0${where}`);
    try {
      process.stderr.write(`##vso[task.logissue type=warning]nombre viejo «${old}» (${kind}) en ${where}: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «${nu}» (el viejo se retira: guides/nombres-en-ingles.md)\n`);
    } catch { /* anotar nunca rompe */ }
  }
  try {
    const dir = stateDirOf(opts.home || os.homedir());
    const marks = path.join(dir, 'legacy-names.d');
    fs.mkdirSync(marks, { recursive: true });
    const day = dayOf(new Date());
    const key = crypto.createHash('sha1').update([day, kind, old, where, conflict ? 'c' : ''].join('\0')).digest('hex').slice(0, 20);
    let fd;
    try {
      fd = fs.openSync(path.join(marks, `${day}-${key}`), 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') return;   // ya anotado hoy
      throw e;
    }
    fs.closeSync(fd);
    const line = { day, kind, old, new: nu, script: where };
    if (conflict) line.conflict = true;
    fs.appendFileSync(path.join(dir, 'legacy-names.jsonl'), `${JSON.stringify(line)}\n`);
    // las marcas de días viejos se van (sólo quien anota algo nuevo paga el barrido, una vez por nombre y día)
    const yesterday = dayOf(new Date(Date.now() - 86400000));
    for (const f of fs.readdirSync(marks)) if (f.slice(0, 10) < day && f.slice(0, 10) !== yesterday) { try { fs.unlinkSync(path.join(marks, f)); } catch { /* otro proceso */ } }
  } catch (e) {
    if (!warnedLog) {
      warnedLog = true;
      try { process.stderr.write(`⚠️  legacy-names: no pude anotar el uso de un nombre viejo (${(e && e.code) || (e && e.message) || e}) — el registro de usos de esta máquina queda incompleto\n`); } catch { /* nada */ }
    }
  }
}

// ── variables ───────────────────────────────────────────────────────────────────────────────────────────────────
/** La variable `name` (su nombre nuevo). Sólo la vieja → su valor; las dos iguales → el valor; distintas → gana la nueva
 *  y se anota `conflict`; ninguna → undefined. Un interruptor de apagado con el nombre viejo sigue apagando. */
function readEnv(name, opts = {}) {
  const env = opts.env || process.env;
  const entry = usableEntries(loadMap(opts)).find((e) => e.kind === 'env' && e.new === name);
  const nv = env[name];
  if (!entry) return nv;
  const ov = env[entry.old];
  if (ov === undefined) return nv;
  const use = { kind: 'env', old: entry.old, new: name, script: opts.where };
  if (nv === undefined) { recordUse(use, opts); return ov; }
  recordUse({ ...use, conflict: nv !== ov }, opts);
  return nv;
}

/** Los nombres de una variable renombrada, el nuevo primero: `[nuevo, viejo]` (o `[nuevo]` si el mapa no la tiene). Para el
 *  que busca la variable en el TEXTO de un comando (`NOMBRE=1 az …`) y no en el entorno: el viejo pegado al comando sigue
 *  valiendo hasta el retiro. Quien la encuentra por el viejo anota el uso con `recordUse`. */
function envNames(name, opts = {}) {
  const entry = usableEntries(loadMap(opts)).find((e) => e.kind === 'env' && e.new === name);
  return entry ? [name, entry.old] : [name];
}

// ── opciones, subcomandos y valores ─────────────────────────────────────────────────────────────────────────────
/**
 * El argv de `where` con los nombres viejos pasados a los nuevos: `--viejo` y `--viejo=x` (opciones), el primer argumento
 * (subcomando) y los argumentos que son un valor viejo (valores). Después de `--`, nada. El viejo y el nuevo de una opción
 * que no se repite, juntos, lanzan LegacyNamesError: el script lo trata como a su opción desconocida.
 */
function aliasOptions(argv, where, opts = {}) {
  const args = Array.from(argv || []);
  const mine = usableEntries(loadMap(opts)).filter((e) => e.where === where && ['option', 'subcommand', 'value'].includes(e.kind)).map(bare);
  if (!mine.length) return args;
  const byOld = (kind, x) => mine.find((e) => e.kind === kind && e.old === x);
  const seen = new Map();   // entrada de opción → { old, new }
  const note = (e, which) => { const s = seen.get(e) || {}; s[which] = true; seen.set(e, s); };
  const used = (e) => recordUse({ kind: e.kind, old: e.old, new: e.new, script: where }, opts);
  // un valor con `option` (tanda B3a) se traduce sólo como valor de ESA opción (ya con su nombre nuevo); uno sin
  // `option` —mapas anteriores a la B3a— en cualquier argumento, como antes
  const value = (v, opt) => {
    const e = mine.find((x) => x.kind === 'value' && x.old === v && (typeof x.option !== 'string' || x.option === opt));
    if (!e) return v;
    used(e);
    return e.new;
  };
  const out = [];
  let done = false;
  let prevOption = null;   // la opción (nombre nuevo) del argumento anterior, si era `--x` sin `=`
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const after = prevOption;
    prevOption = null;
    if (done) { out.push(a); continue; }
    if (a === '--') { done = true; out.push(a); continue; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const old = byOld('option', name);
      const nuName = old ? old.new : name;
      const rest = eq < 0 ? '' : `=${value(a.slice(eq + 1), nuName)}`;
      if (eq < 0) prevOption = nuName;
      if (old) { note(old, 'old'); used(old); out.push(`--${old.new}${rest}`); continue; }
      const nu = mine.find((e) => e.kind === 'option' && e.new === name);
      if (nu) note(nu, 'new');
      out.push(`--${name}${rest}`);
      continue;
    }
    if (i === 0) {
      const sub = byOld('subcommand', a);
      if (sub) { used(sub); out.push(sub.new); continue; }
    }
    out.push(value(a, after));
  }
  for (const [e, s] of seen) {
    if (s.old && s.new && e.repeatable !== true) throw new LegacyNamesError(`la misma opción dos veces: --${e.old} y --${e.new} (--${e.old} es el nombre viejo de --${e.new})`);
  }
  return out;
}

/**
 * La línea que suma un script al entrar (tanda B3a): reescribe `process.argv` en el lugar con `aliasOptions`, así el
 * script lee sus opciones como siempre —con `indexOf`, con un parser propio o con un `switch`— y ya le llegan con los
 * nombres nuevos. Con el viejo y el nuevo de una opción juntos escribe el error (con `prefix`, el que el script usa en
 * su stderr) y sale con `exitCode`: el código de opción desconocida del script, 2 si no tiene uno.
 */
function aliasArgv(where, { exitCode = 2, prefix = '', ...opts } = {}) {
  try {
    process.argv = [...process.argv.slice(0, 2), ...aliasOptions(process.argv.slice(2), where, opts)];
  } catch (e) {
    if (!(e instanceof LegacyNamesError)) throw e;
    process.stderr.write(`${prefix}${e.message}\n`);
    process.exit(exitCode);
  }
}

// ── archivos de configuración y de estado ───────────────────────────────────────────────────────────────────────
function fileEntry(p, opts) {
  const abs = path.resolve(expand(String(p), null, opts));
  const entry = usableEntries(loadMap(opts)).find((e) => (e.kind === 'config-file' || e.kind === 'state-file') && path.resolve(expand(e.new, e, opts)) === abs);
  return { abs, entry, old: entry ? path.resolve(expand(entry.old, entry, opts)) : null };
}
const sameContent = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
/** La ruta vieja de un archivo de configuración o de estado (por su ruta nueva), o null si no está en el mapa. Para el
 *  lector que tiene que mirar los dos mientras dura el renombre (tanda D2: una carpeta en la que todavía escribe una
 *  sesión con el código de antes). No anota uso: mirar no es usar el nombre viejo. */
function oldPathOf(p, opts = {}) {
  return fileEntry(p, opts).old;
}
/** ¿Existe? «No está» (ENOENT, ENOTDIR) es false; cualquier otro error (un permiso, un disco que falla) es «no pude
 *  mirar» y tira: tomarlo por «no está» dejaría un estado viejo sin migrar, o el nuevo vacío, en silencio (revisor de
 *  fallos silenciosos, tanda D2). `fs.existsSync` se traga ese error. */
function exists(p) {
  try { fs.statSync(p); return true; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    throw new LegacyNamesError(`no pude mirar ${p} (${(e && e.code) || (e && e.message) || e}) — revisá los permisos`);
  }
}
/** Qué archivo leer: el nuevo si existe, si no el viejo. Configuración con los dos y contenidos distintos → error que
 *  nombra los dos (el script sale 2); estado con los dos → gana el nuevo. */
function resolveFile(p, opts = {}) {
  const { abs, entry, old } = fileEntry(p, opts);
  if (!entry) return abs;
  const hasNew = exists(abs);
  const hasOld = exists(old);
  if (!hasOld) return abs;
  if (!hasNew) { recordUse({ kind: entry.kind, old: entry.old, new: entry.new, script: opts.where }, opts); return old; }
  if (entry.kind === 'config-file' && !sameContent(abs, old)) {
    throw new LegacyNamesError(`hay dos archivos de configuración con contenido distinto: ${abs} (el nombre nuevo) y ${old} (el viejo) — dejá uno solo`);
  }
  return abs;
}
/** Antes de la primera escritura de un estado con nombre nuevo: si sólo está el viejo, su contenido pasa al nuevo (el
 *  viejo queda intacto hasta el retiro). Devuelve la ruta nueva, que es donde se escribe. Si la copia falla por otra cosa
 *  que «otro proceso ya lo migró», lanza: escribir el nuevo vacío perdería la historia del viejo para siempre.
 *  Una carpeta (tanda D2) se lleva entera: se copia a una hermana temporal y recién ahí toma el nombre nuevo, así que
 *  quien escribe en ella nunca la ve a medias; si dos procesos la migran a la vez, gana uno y el otro borra su copia. */
function prepareStateWrite(p, opts = {}) {
  const { abs, entry, old } = fileEntry(p, opts);
  if (!entry || exists(abs) || !exists(old)) return abs;
  const fail = (e) => new LegacyNamesError(`no pude llevar el estado viejo ${old} a ${abs} (${(e && e.code) || (e && e.message) || e}) — sin eso el nuevo nace sin su historia; revisá los permisos o copialo a mano`);
  let isDir = false;
  try { isDir = fs.statSync(old).isDirectory(); } catch (e) { if (e && e.code === 'ENOENT') return abs; throw fail(e); }
  if (isDir) {
    const tmpDir = `${abs}.migrating-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.cpSync(old, tmpDir, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      fs.renameSync(tmpDir, abs);
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* lo que no se pudo borrar no cambia el veredicto */ }
      if (fs.existsSync(abs)) return abs;   // otro proceso ya la migró (ENOTEMPTY / EEXIST al renombrar)
      throw fail(e);
    }
  } else {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(old, abs, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e && e.code === 'EEXIST') return abs;   // otro proceso ya lo migró
      throw fail(e);
    }
  }
  recordUse({ kind: entry.kind, old: entry.old, new: entry.new, script: opts.where }, opts);
  return abs;
}
/** Igualdad por contenido, sin importar el orden de las claves de un objeto. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}
/** Las claves de primer nivel de un objeto leído de un archivo de `where`, con las viejas pasadas a las nuevas. Las dos con
 *  valores distintos → error. */
function readKeys(obj, where, opts = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const mine = usableEntries(loadMap(opts)).filter((e) => e.kind === 'key' && e.where === where);
  if (!mine.length) return obj;
  const out = { ...obj };
  for (const e of mine) {
    if (!Object.prototype.hasOwnProperty.call(out, e.old)) continue;
    if (Object.prototype.hasOwnProperty.call(out, e.new) && !sameValue(out[e.new], out[e.old])) {
      throw new LegacyNamesError(`${where}: la clave «${e.new}» y su nombre viejo «${e.old}» tienen valores distintos — dejá una sola`);
    }
    if (!Object.prototype.hasOwnProperty.call(out, e.new)) out[e.new] = out[e.old];
    delete out[e.old];
    recordUse({ kind: 'key', old: e.old, new: e.new, script: where }, opts);
  }
  return out;
}
/** Lo mismo que readKeys en TODOS los niveles (los objetos dentro de listas también), para un archivo cuyas claves
 *  anidadas cambiaron de nombre (tanda D1: la lista blanca de la base de un rango, un pack.json de afuera). Nunca toca
 *  valores ni claves que no están en el mapa (ids, vocabularios); devuelve una copia. Las dos con valores distintos en
 *  el mismo objeto → error que nombra las dos. `opts.record: false`: no anota el uso — para lo que se lee de una FOTO de
 *  git (la base de un rango, el árbol de un sha): ahí nadie usa el nombre viejo, es la historia, y anotarlo ensuciaría el
 *  registro que decide el retiro y llenaría de warnings las corridas de Azure (el mismo defecto que la tanda C4 cerró
 *  para los reemplazos). */
function readKeysDeep(obj, where, opts = {}) {
  const mine = usableEntries(loadMap(opts)).filter((e) => e.kind === 'key' && e.where === where);
  if (!mine.length) return obj;
  const byOld = new Map(mine.map((e) => [e.old, e]));
  const used = new Set();
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const e = byOld.get(k);
      const nu = e ? e.new : k;
      const val = walk(x, at ? `${at}.${nu}` : nu);
      if (e && Object.prototype.hasOwnProperty.call(v, e.new)) {
        if (!sameValue(v[e.new], x)) {
          throw new LegacyNamesError(`${where}: la clave «${e.new}» y su nombre viejo «${e.old}»${at ? ` (en ${at})` : ''} tienen valores distintos — dejá una sola`);
        }
        used.add(e);
        continue;   // queda la nueva, que se copia en su propia vuelta
      }
      if (e) used.add(e);
      out[nu] = val;
    }
    return out;
  };
  const result = walk(obj, '');
  if (opts.record !== false) for (const e of used) recordUse({ kind: 'key', old: e.old, new: e.new, script: where }, opts);
  return result;
}

// ── los reemplazos ──────────────────────────────────────────────────────────────────────────────────────────────
/** ¿Es un reemplazo generado? La marca va en la segunda línea. */
function isShim(text) {
  const lines = String(text || '').split('\n', 3);
  return lines.length > 1 && SHIM_LINE.test(lines[1]);
}
/**
 * ¿Es un reemplazo GENERADO tal cual, en la ruta `rel` de su repo? La marca sola se puede escribir a mano: un archivo
 * que la trae pero no es idéntico a lo que escribe `--write-shims` para esa ruta y su destino no es un reemplazo (el
 * freno de nombres no lo saltea; revisor de seguridad, tanda C1). Se compara con las dos formas (arnés y agent-skills).
 */
function isGeneratedShim(rel, text) {
  if (!isShim(text)) return false;
  const target = SHIM_LINE.exec(String(text).split('\n', 3)[1])[1];
  if (path.isAbsolute(target) || path.isAbsolute(rel)) return false;
  const root = path.join(path.sep, 'r');
  return [undefined, 'agent-skills'].some((repo) => {
    try { return shimText({ kind: 'file', old: rel, new: target, repo }, path.join(root, rel), path.join(root, target), root) === text; } catch { return false; }
  });
}
/** El destino de un reemplazo que está en `shimAbs`: la marca trae la ruta nueva (absoluta, o relativa a su repo). */
function shimTarget(shimAbs) {
  let text;
  try { text = fs.readFileSync(shimAbs, 'utf8'); } catch { return null; }
  if (!isShim(text)) return null;
  const rel = SHIM_LINE.exec(text.split('\n', 3)[1])[1];
  if (path.isAbsolute(rel)) return rel;
  for (let dir = path.dirname(shimAbs); ; dir = path.dirname(dir)) {
    const cand = path.join(dir, rel);
    if (fs.existsSync(cand)) return cand;
    if (path.dirname(dir) === dir) return null;
  }
}
/** Un comando con cada ruta absoluta a un reemplazo cambiada por su destino (para comparar lo desplegado con lo esperado). */
function resolveShimsInCommand(cmd) {
  return String(cmd).replace(/(["']?)(\/[^"'\s]+)\1/g, (m, q, p) => {
    const t = fs.existsSync(p) ? shimTarget(p) : null;
    return t ? `${q}${t}${q}` : m;
  });
}
/** ¿Hay forma de reemplazo para esta extensión? (.yml, .json y demás no: se nombran con `callers: ado` o se mueven con
 *  sus referencias en el mismo commit). */
const supportsShim = (rel) => SHIM_EXTS.includes(path.extname(rel));
// Sin forma de reemplazo (un .yml), tampoco lo pide `docs`: la guía que lo cita se actualiza en el mismo commit y nadie lo
// ejecuta por esa ruta. `machine`, `other-repo` y `products` sí lo siguen pidiendo —y como no hay forma, --check-map
// sale 2— (decisión del dueño, story 8.12 AC 1, 2026-10-01). Un `old` que no es texto se juzga como antes: lo frena la
// validación de rutas.
const NO_SHIM_WITHOUT_FORM_CALLERS = [...NO_SHIM_CALLERS, 'docs'];
const needsShim = (e) => {
  if (e.kind !== 'file' || !Array.isArray(e.callers)) return false;
  const exempt = typeof e.old === 'string' && !supportsShim(e.old) ? NO_SHIM_WITHOUT_FORM_CALLERS : NO_SHIM_CALLERS;
  return e.callers.some((c) => !exempt.includes(c));
};
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;   // comillas simples de sh
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;      // comillas simples de PowerShell
const slash = (p) => p.split(path.sep).join('/');

function shimText(entry, oldAbs, newAbs, root) {
  const ext = path.extname(entry.old);
  const rel = slash(path.relative(path.dirname(oldAbs), newAbs));
  const head = 'Reemplazo generado por scripts/lib/legacy-names.js --write-shims (story 8.9): no se edita a mano. El nombre viejo sigue andando hasta el retiro del mapa (scripts/lib/renames.json).';
  // dónde está la biblioteca para anotar el uso: la del mismo repo (arnés), o la del arnés de la máquina (agent-skills)
  const libRel = entry.repo === 'agent-skills' ? null : slash(path.relative(path.dirname(oldAbs), path.join(root, 'scripts', 'lib', 'legacy-names.js')));
  // si el destino no está en el repo del reemplazo (un clon del repo privado de mantenimiento, que no trae lo público),
  // el del arnés instalado: así un nombre viejo que llama un producto sigue andando contra ese clon
  const installed = [entry.repo === 'agent-skills' ? 'agent-skills' : PLACE_NAME, ...entry.new.split('/')];
  // la carpeta de Claude Code en la casa del usuario, donde vive el lugar del arnés: el texto de los reemplazos la nombra
  // en siete lugares y acá se escribe una vez (scripts/tests/tycon-home.test.js T3 cuenta cada mención de la carpeta)
  const claude = path.basename(claudeDirOf('/'));
  const warn = `##vso[task.logissue type=warning]nombre viejo «${entry.old}» (file): sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «${entry.new}»`;
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    return [
      '#!/usr/bin/env node',
      `// ${SHIM_MARK} ${entry.new}`,
      "'use strict';",
      `// ${head}`,
      "const path = require('path');",
      '// el destino del mismo repo; si no está, el del arnés instalado (un clon del repo privado no trae lo público)',
      'const target = (() => {',
      `  const here = path.join(__dirname, ${JSON.stringify(rel)});`,
      `  const inst = path.join(require('os').homedir(), '${claude}', ${installed.map((x) => JSON.stringify(x)).join(', ')});`,
      "  return !require('fs').existsSync(here) && require('fs').existsSync(inst) ? inst : here;",
      '})();',
      '// anotar el uso nunca rompe: la biblioteca del mismo repo, la de TYCON_GUIDES_DIR o la del lugar del arnés',
      '(() => {',
      "  const fs = require('fs');",
      '  const cands = [',
      libRel ? `    path.join(__dirname, ${JSON.stringify(libRel)}),` : '',
      "    process.env.TYCON_GUIDES_DIR && path.join(process.env.TYCON_GUIDES_DIR, 'scripts', 'lib', 'legacy-names.js'),",
      `    path.join(require('os').homedir(), '${claude}', '${PLACE_NAME}', 'scripts', 'lib', 'legacy-names.js'),`,
      '  ];',
      `  const use = { kind: 'file', old: ${JSON.stringify(entry.old)}, new: ${JSON.stringify(entry.new)}, script: ${JSON.stringify(entry.old)} };`,
      '  for (const c of cands) { try { if (c && fs.existsSync(c)) { require(c).recordUse(use); return; } } catch { /* sigue */ } }',
      `  if (/^true$/i.test(process.env.TF_BUILD || '')) process.stderr.write(${JSON.stringify(`${warn}\n`)});`,
      '})();',
      'if (require.main === module) {',
      "  const r = require('child_process').spawnSync(process.execPath, [...process.execArgv, target, ...process.argv.slice(2)], { stdio: 'inherit' });",
      "  if (r.error) { process.stderr.write(`no pude correr ${target}: ${r.error.message}\\n`); process.exit(1); }",
      '  if (r.signal) process.kill(process.pid, r.signal);',
      '  process.exitCode = r.status === null ? 1 : r.status;',
      '} else {',
      '  module.exports = require(target);',
      '}',
      '',
    ].filter((l) => l !== '').join('\n') + '\n';
  }
  if (['.sh', '.command', '.bash', ''].includes(ext)) {
    const run = ext === '' ? 'exec "$_legacy_target" "$@"' : 'exec bash "$_legacy_target" "$@"';
    return [
      '#!/usr/bin/env bash',
      `# ${SHIM_MARK} ${entry.new}`,
      `# ${head}`,
      '_legacy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      `_legacy_target="$_legacy_dir/"${shq(rel)}`,
      '# si el destino no está en este repo (un clon del repo privado no trae lo público), el del arnés instalado',
      // la ruta del instalado, de corrido entre comillas dobles (pathProblem sólo deja letras, dígitos, «.», «_», «-» y
      // «/»): partida en dos comillas, el control del nombre público (mirror-pipeline T36) no la reconoce como ruta del lugar
      `if [ ! -e "$_legacy_target" ] && [ -e "\${HOME:-/nonexistent}/${claude}/${installed.join('/')}" ]; then _legacy_target="\${HOME}/${claude}/${installed.join('/')}"; fi`,
      `case "\${TF_BUILD:-}" in [Tt][Rr][Uu][Ee]) printf '%s\\n' ${shq(warn)} >&2 ;; esac`,
      '# anotar el uso, de fondo (nunca demora): la biblioteca del mismo repo, la de TYCON_GUIDES_DIR o la del lugar',
      `for _legacy_lib in ${libRel ? `"$_legacy_dir/"${shq(libRel)} ` : ''}"\${TYCON_GUIDES_DIR:-/nonexistent}/scripts/lib/legacy-names.js" "\${HOME:-/nonexistent}/${claude}/${PLACE_NAME}/scripts/lib/legacy-names.js"; do`,
      `  if [ -f "$_legacy_lib" ]; then ( TF_BUILD= node "$_legacy_lib" --log-use file ${shq(entry.old)} ${shq(entry.new)} ${shq(entry.old)} >/dev/null 2>&1 & ) 2>/dev/null; break; fi`,
      'done',
      '# cargado con `source`: se carga el nuevo en el mismo shell, sin reemplazarlo',
      'if [ "${BASH_SOURCE[0]}" != "$0" ]; then . "$_legacy_target" "$@"; return $?; fi',
      run,
      '',
    ].join('\n');
  }
  if (ext === '.ps1') {
    return [
      `# ${head}`,
      `# ${SHIM_MARK} ${entry.new}`,
      `if ("$env:TF_BUILD" -match '^(?i)true$') { [Console]::Error.WriteLine(${psq(warn)}) }`,
      '# anotar el uso, de fondo (nunca demora): la biblioteca del mismo repo, la de TYCON_GUIDES_DIR o la del lugar',
      '$legacyLibs = @(' + [
        libRel ? `(Join-Path $PSScriptRoot ${psq(libRel)})` : null,
        "$(if ($env:TYCON_GUIDES_DIR) { Join-Path $env:TYCON_GUIDES_DIR 'scripts/lib/legacy-names.js' })",
        `(Join-Path $HOME '${claude}/${PLACE_NAME}/scripts/lib/legacy-names.js')`,
      ].filter(Boolean).join(', ') + ')',
      '$legacyLib = $legacyLibs | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1',
      'if ($legacyLib -and (Get-Command node -ErrorAction SilentlyContinue)) {',
      "  try { $psi = [System.Diagnostics.ProcessStartInfo]::new('node'); foreach ($a in @($legacyLib, '--log-use', 'file', " + `${psq(entry.old)}, ${psq(entry.new)}, ${psq(entry.old)}`
        + ")) { $psi.ArgumentList.Add($a) }; $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.Environment['TF_BUILD'] = ''; [void][System.Diagnostics.Process]::Start($psi) } catch { }",
      '}',
      '# si el destino no está en este repo (un clon del repo privado no trae lo público), el del arnés instalado',
      `$legacyTarget = Join-Path $PSScriptRoot ${psq(rel)}`,
      `if (-not (Test-Path -LiteralPath $legacyTarget)) { $legacyInst = Join-Path $HOME ${psq(`${claude}/${installed.join('/')}`)}; if (Test-Path -LiteralPath $legacyInst) { $legacyTarget = $legacyInst } }`,
      '& $legacyTarget @args',
      'exit $LASTEXITCODE',
      '',
    ].join('\n');
  }
  if (ext === '.md') {
    return `Movida a [\`${entry.new}\`](${rel}): este archivo queda en la ruta vieja hasta el retiro de los nombres viejos (story 8.9).\n<!-- ${SHIM_MARK} ${entry.new} -->\n`;
  }
  throw new LegacyNamesError(`${entry.old}: no hay forma de reemplazo para la extensión «${ext}» (hay para .js, .sh, .command, .ps1, .md y sin extensión); si lo nombra un pipeline de Azure DevOps, va con callers: ["ado"] (tarea humana)`);
}
/**
 * Escribe el reemplazo de cada `file` con un llamador de afuera ya movido. Una entrada que todavía no se movió (el viejo es
 * el archivo real y el nuevo no existe) se saltea: su reemplazo se genera en la mudanza. Una ruta inválida, un choque
 * (viejo y nuevo reales) o ni viejo ni nuevo: error. Devuelve { written, pending }.
 */
function writeShims(opts = {}) {
  const map = loadMap(opts);
  if (!map) throw new LegacyNamesError(`no hay mapa (${mapFile(opts)}): no hay reemplazos que escribir`);
  const written = [];
  const pending = [];
  for (const e of entriesOf(map).filter(needsShim)) {
    for (const side of ['old', 'new']) {
      const why = pathProblem(e[side], e.kind);
      if (why) throw new LegacyNamesError(`${e[side]}: la ruta ${why} — no genero reemplazos con ella`);
    }
    const root = rootOf(e, opts);
    const oldAbs = expand(e.old, e, opts);
    const newAbs = expand(e.new, e, opts);
    if (!within(root, oldAbs) || !within(root, newAbs)) throw new LegacyNamesError(`${e.old} → ${e.new}: sale de la raíz del repo (${root})`);
    const oldReal = fs.existsSync(oldAbs) && !isShim(fs.readFileSync(oldAbs, 'utf8'));
    if (!fs.existsSync(newAbs)) {
      if (oldReal) { pending.push(e.old); continue; }   // todavía no se movió
      throw new LegacyNamesError(`${e.new} no existe (y ${e.old} tampoco es el archivo real): renombrá el archivo antes de generar su reemplazo`);
    }
    if (oldReal) throw new LegacyNamesError(`${e.old} existe y no es un reemplazo, y ${e.new} también existe: movelo (git mv) antes de generar su reemplazo`);
    if (!supportsShim(e.old)) throw new LegacyNamesError(`${e.old}: no hay forma de reemplazo para la extensión «${path.extname(e.old)}»; si lo nombra un pipeline de Azure DevOps, va con callers: ["ado"] (tarea humana)`);
    fs.mkdirSync(path.dirname(oldAbs), { recursive: true });   // una carpeta renombrada entera se recrea para el reemplazo
    fs.writeFileSync(oldAbs, shimText(e, oldAbs, newAbs, root));
    const mode = path.extname(e.old) === '.md' ? 0o644 : (fs.statSync(newAbs).mode & 0o777) | 0o444;
    fs.chmodSync(oldAbs, mode);
    written.push(e.old);
  }
  return { written, pending };
}

// ── la máquina: settings.json, settings.local.json, Codex, ~/.git-hooks y LaunchAgents ─────────────────────────────
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Las formas en que una raíz aparece escrita en la máquina: absoluta, real (sin enlaces), con `~/`, `$HOME/`, y en Windows
 *  también con `/` (el instalador .ps1 escribe los comandos así aunque la raíz llegue con `\`). */
function rootForms(dir, home, extra = []) {
  const forms = new Set([dir]);
  try { forms.add(fs.realpathSync(dir)); } catch { /* no existe */ }
  for (const f of [...forms]) {
    for (const sep of ['/', '\\']) {
      if (f.startsWith(`${home}${sep}`)) {
        const rel = f.slice(home.length + 1).split('\\').join('/');
        forms.add(`~/${rel}`); forms.add(`$HOME/${rel}`); forms.add(`\${HOME}/${rel}`);
      }
    }
  }
  for (const x of extra) forms.add(x);
  for (const f of [...forms]) if (f.includes('\\')) forms.add(f.split('\\').join('/'));
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}
/** Todas las formas de escribir la raíz de un repo en la máquina, incluidos los enlaces que deja el instalador (los dos
 *  nombres del lugar del arnés —story 8.19—, ~/.claude/agent-skills) si apuntan a esa raíz, y `$TCG` en los guiones del
 *  arnés. */
function repoForms(root, repo, home) {
  const extra = repo === 'agent-skills' ? [] : ['$TCG', '${TCG}'];
  const links = (repo === 'agent-skills' ? ['agent-skills'] : [PLACE_NAME, LEGACY_PLACE_NAME]).map((n) => path.join(home, '.claude', n));
  let real = null;
  try { real = fs.realpathSync(root); } catch { /* no existe */ }
  for (const link of links) {
    try { if (real && fs.realpathSync(link) === real) extra.push(...rootForms(link, home)); } catch { /* sin enlace */ }
  }
  return rootForms(root, home, extra);
}
/** Para comparar: cada forma de una raíz —también `$HOME/…` y `$TCG`—, llevada a su ruta real. */
function rootNormalizer(roots, home) {
  const pairs = [];
  for (const [root, repo] of roots) {
    if (!root) continue;
    let real;
    try { real = fs.realpathSync(root); } catch { continue; }
    for (const f of repoForms(root, repo, home)) pairs.push([`${f}/`, `${real}/`]);
  }
  if (!pairs.length) return (s) => s;
  pairs.sort((a, b) => b[0].length - a[0].length);
  const to = new Map(pairs);
  // una sola pasada (la más larga primero): `/var/…` está adentro de `/private/var/…` y no se puede reemplazar dos veces
  const re = new RegExp(`(?<![\\w.~-])(?:${pairs.map(([f]) => escapeRe(f)).join('|')})`, 'g');
  return (s) => s.replace(re, (m) => to.get(m) || m);
}

/**
 * Los reemplazos de texto de la máquina: por cada `file`/`folder` del mapa, la ruta completa (raíz + ruta relativa)
 * seguida de algo que no puede ser parte de un nombre —comilla, espacio, `:`, `)`, `<`, fin; en carpetas también `/`—,
 * y precedida de algo que tampoco (una `/` sí: los permisos de Claude Code escriben las rutas absolutas como `//…`).
 * Nunca una subcadena: `…/metrics/corridas.js` no toca `…/metrics/subir-corridas.js`. Sólo si el nuevo existe: nunca se
 * apunta a la nada. Del más específico al más general: un archivo renombrado adentro de una carpeta renombrada va antes
 * que la carpeta (si no, la carpeta se come el texto y el archivo queda con su nombre viejo en la carpeta nueva).
 */
function machineRewrites(map, { guides, skills, home, exists = fs.existsSync }) {
  const out = [];
  const entries = usableEntries(map).filter((e) => e.kind === 'file' || e.kind === 'folder')
    .sort((a, b) => b.old.length - a.old.length);
  for (const e of entries) {
    const root = e.repo === 'agent-skills' ? skills : guides;
    if (!root || !exists(path.join(root, e.new)) || oldStillReal(path.join(root, e.old), e.kind, root)) continue;
    const after = e.kind === 'folder' ? '(?![\\w.@+~-])' : '(?![\\w.@+~/\\\\-])';
    for (const form of repoForms(root, e.repo === 'agent-skills' ? 'agent-skills' : 'arnes', home)) {
      // una raíz de Windows escrita con `\` lleva la ruta relativa con `\`; su variante con `/` ya está entre las formas
      const sep = form.includes('\\') ? '\\' : '/';
      const oldP = sep === '\\' ? e.old.split('/').join('\\') : e.old;
      const newP = sep === '\\' ? e.new.split('/').join('\\') : e.new;
      out.push({ re: new RegExp(`(?<![\\w.~-])${escapeRe(`${form}${sep}${oldP}`)}${after}`, 'g'), to: `${form}${sep}${newP}` });
    }
  }
  return out;
}
/**
 * Los reemplazos de los permisos RELATIVOS (story 8.12, AC 9): un permiso de Claude Code escrito como
 * `Bash(bash scripts/x.sh --check)` no lleva ninguna forma de la raíz y `machineRewrites` no lo ve. Sólo entradas del
 * arnés (las rutas relativas de un permiso se resuelven contra el proyecto abierto, y el que nombra `scripts/…` es el
 * arnés) cuyo `old` empieza con `scripts/`, ya mudadas con el mismo criterio que `machineRewrites`. Borde estricto
 * delante —ni `/`, ni letra, dígito, `_`, `.`, `~` o `-`—: `otros/scripts/x.sh` y la forma absoluta (que ya reescribió
 * `machineRewrites`) no se tocan. Atrás, el mismo borde que `machineRewrites`. Se aplican SÓLO a los textos de
 * permissions.{allow,ask,deny}: en un hook o en Codex el relativo depende del directorio en que corre y no se adivina.
 */
function relativePermissionRewrites(map, { guides, exists = fs.existsSync }) {
  const out = [];
  if (!guides) return out;
  const entries = usableEntries(map)
    .filter((e) => (e.kind === 'file' || e.kind === 'folder') && (!e.repo || e.repo === 'arnes') && e.old.startsWith('scripts/'))
    .sort((a, b) => b.old.length - a.old.length);
  for (const e of entries) {
    if (!exists(path.join(guides, e.new)) || oldStillReal(path.join(guides, e.old), e.kind, guides)) continue;
    const after = e.kind === 'folder' ? '(?![\\w.@+~-])' : '(?![\\w.@+~/\\\\-])';
    out.push({ re: new RegExp(`(?<![\\w.~/-])${escapeRe(e.old)}${after}`, 'g'), to: e.new });
  }
  return out;
}
/** Pasa los reemplazos relativos por los textos de permissions.{allow,ask,deny} de un settings ya parseado. */
function rewriteRelativePermissions(data, rewrites, count, rewritten) {
  const perms = data && typeof data === 'object' && data.permissions;
  if (!rewrites.length || !perms || typeof perms !== 'object') return;
  for (const k of ['allow', 'ask', 'deny']) {
    if (!Array.isArray(perms[k])) continue;
    perms[k] = perms[k].map((r) => {
      if (typeof r !== 'string') return r;
      const x = rewriteText(r, rewrites);
      count.n += x.n;
      if (x.n) rewritten.add(x.text);
      return x.text;
    });
  }
}
function rewriteText(text, rewrites) {
  let n = 0;
  let t = text;
  for (const r of rewrites) t = t.replace(r.re, () => { n++; return r.to; });
  return { text: t, n };
}
function rewriteStrings(v, rewrites, count, rewritten) {
  if (typeof v === 'string') {
    const r = rewriteText(v, rewrites);
    count.n += r.n;
    if (r.n) rewritten.add(r.text);
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => rewriteStrings(x, rewrites, count, rewritten));
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = rewriteStrings(v[k], rewrites, count, rewritten); return v; }
  return v;
}
/**
 * ¿El nombre viejo sigue siendo el de verdad? Un archivo que existe y no es un reemplazo; una carpeta con algún archivo
 * que no es un reemplazo. Una entrada nace antes de su mudanza (tanda C0, AC 59), y la carpeta nueva puede existir antes
 * que la mudanza de la vieja (un archivo que se renombra en C1-C3 va directo a su destino final): «el nuevo existe» solo
 * no alcanza para darla por mudada.
 */
// Sólo «no existe» es un «no»: un permiso, un enlace roto o un disco que falla es «no pude mirar» y frena — si no, el viejo
// ilegible se leería como «ya no está» y la entrada quedaría mudada en silencio (revisor de fallos silenciosos, tanda C0).
const NO_EXISTE = new Set(['ENOENT', 'ENOTDIR']);
function mirar(fn, p) {
  try { return fn(); } catch (e) {
    if (e && NO_EXISTE.has(e.code)) return null;
    throw new LegacyNamesError(`no pude mirar ${p} (${(e && e.code) || (e && e.message) || e}) para saber si ya se mudó — revisá los permisos`);
  }
}
/**
 * Lo que git VERSIONA bajo una carpeta (sus rutas relativas a `root`), o null si `root` no es la raíz de un repo de git (o
 * no hay git): entonces se mira el disco, como antes. Sólo lo versionado, ni lo ignorado ni lo que nunca se agregó
 * (pase adversarial de la story 8.12, R2): tras el pull de una mudanza git borra lo suyo de la carpeta vieja y deja lo que
 * nunca siguió —el log del grabador, sus descartados—, y eso no es la carpeta de verdad. Lo ignorado y lo sin seguir son lo
 * mismo para esta pregunta: los restos de cada máquina quedan ignorados o no según el `.gitignore` de turno. La raíz tiene
 * que ser la del repo: una carpeta de laboratorio adentro de otro repo (una HOME versionada) no es ese repo. Si git está y
 * no contesta, frena, como `mirar`: «no pude preguntar» no es «no hay nada».
 */
/**
 * git en `root`, sin el GIT_DIR de un hook (no manda acá) y con los mensajes en inglés (LC_ALL=C), para poder leer el
 * «not a git repository». `notARepo`: git no está en la máquina, o dice que `root` no es un repo — ahí quien llama mira el
 * disco. Cualquier otro fallo («dubious ownership», un permiso, un repo roto, una señal) es `failed`, y quien llama frena
 * (pase adversarial de la story 8.12, R2, revisor de fallos silenciosos): «no pude preguntar» no es «no hay nada», y caer
 * callado al disco volvía a contar los restos de la máquina como lo versionado.
 */
function gitAt(root, args) {
  const { spawnSync } = require('child_process');
  const env = { LC_ALL: 'C' };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && k !== 'LC_ALL' && k !== 'LANGUAGE') env[k] = v;
  const r = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const stderr = String(r.stderr || '').trim();
  const notARepo = (!!r.error && r.error.code === 'ENOENT') || (r.status === 128 && /not a git repository/i.test(stderr));
  const failed = !notARepo && (!!r.error || r.status !== 0);
  const why = failed ? (r.error ? (r.error.code || r.error.message) : stderr || (r.signal ? `señal ${r.signal}` : `salió ${r.status}`)) : '';
  return { r, notARepo, failed, why };
}
function trackedUnder(root, abs) {
  if (!root) return null;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const stop = (g) => new LegacyNamesError(`no pude preguntarle a git qué versiona ${rel} en ${root} (${g.why}) para saber si ya se mudó — «no pude preguntar» no es «no hay nada»`);
  const top = gitAt(root, ['rev-parse', '--show-toplevel']);
  if (top.notARepo) return null;
  if (top.failed) throw stop(top);
  let same = false;
  try { same = fs.realpathSync(top.r.stdout.trim()) === fs.realpathSync(root); } catch { same = false; }
  if (!same) return null;
  const ls = gitAt(root, ['ls-files', '-z', '--', `:(literal)${rel}`]);
  if (ls.notARepo || ls.failed) throw stop(ls);
  return ls.r.stdout.split('\0').filter(Boolean);
}
/**
 * `root` (la raíz del repo de la entrada) habilita el criterio de carpeta de `trackedUnder`; sin ella, el disco entero.
 */
function oldStillReal(abs, kind, root) {
  const st = mirar(() => fs.statSync(abs), abs);
  if (!st) return false;
  // un archivo que desaparece entre el listado y la lectura ya no es el de verdad; cualquier otro error frena
  const real = (p) => { const t = mirar(() => fs.readFileSync(p, 'utf8'), p); return t !== null && !isShim(t); };
  if (kind !== 'folder') return st.isFile() && real(abs);
  if (!st.isDirectory()) return false;
  // la basura que deja el sistema (el Finder, el Explorador) no es un archivo de la carpeta: git la ignora y sola no la
  // vuelve «real» (pase adversarial de la C4: un `.DS_Store` callaba al control de nombres viejos y al instalador)
  const junk = (n) => n === '.DS_Store' || n.startsWith('._') || n === 'Thumbs.db' || n === 'desktop.ini';
  const tracked = trackedUnder(root, abs);
  if (tracked) {
    return tracked.some((rel) => {
      if (junk(path.posix.basename(rel))) return false;
      const p = path.join(root, rel);
      const s = mirar(() => fs.statSync(p), p);
      // un submódulo versionado es una carpeta: real. Uno borrado del árbol (sin commitear) ya no lo es
      return !!s && (s.isDirectory() || real(p));
    });
  }
  const walk = (d) => (mirar(() => fs.readdirSync(d, { withFileTypes: true }), d) || [])
    .some((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : !junk(f.name) && real(path.join(d, f.name))));
  return walk(abs);
}
/** Una entrada de archivo o carpeta está mudada cuando el nuevo existe y el viejo ya no es el de verdad. */
function isMoved(e, root) {
  if (!root || typeof e.new !== 'string' || typeof e.old !== 'string') return false;
  const abs = path.join(root, e.new.replace(/\/+$/, ''));
  const st = mirar(() => fs.statSync(abs), abs);
  if (!st || (e.kind === 'folder' ? !st.isDirectory() : !st.isFile())) return false;
  return !oldStillReal(path.join(root, e.old.replace(/\/+$/, '')), e.kind, root);
}

/**
 * Sin duplicar lo que la migración reescribió: un hook o un permiso reescrito que ya estaba (en cualquier forma de su raíz)
 * queda una vez. Lo que la migración no tocó queda como estaba, aunque esté repetido: no es asunto de este renombre.
 */
function dedupeSettings(s, norm = (x) => x, rewritten = new Set()) {
  if (s && s.hooks && typeof s.hooks === 'object') {
    for (const ev of Object.keys(s.hooks)) {
      const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      const seen = new Map();   // clave → ¿el que quedó fue reescrito?
      const keep = [];
      for (const g of groups) {
        const hooks = Array.isArray(g && g.hooks) ? g.hooks : [];
        const kept = hooks.filter((h) => {
          if (!h || typeof h.command !== 'string') return true;
          const k = `${String((g && g.matcher) || '').split('|').map((x) => x.trim()).sort().join('|')}\0${norm(h.command)}`;
          const mine = rewritten.has(h.command);
          if (seen.has(k) && (mine || seen.get(k))) return false;
          if (!seen.has(k)) seen.set(k, mine);
          return true;
        });
        if (kept.length || !hooks.length) keep.push({ ...g, hooks: kept });
      }
      s.hooks[ev] = keep;
    }
  }
  if (s && s.permissions && typeof s.permissions === 'object') {
    for (const k of ['allow', 'ask', 'deny']) {
      if (!Array.isArray(s.permissions[k])) continue;
      const seen = new Map();
      s.permissions[k] = s.permissions[k].filter((r) => {
        if (typeof r !== 'string') return true;
        const n = norm(r);
        const mine = rewritten.has(r);
        if (seen.has(n) && (mine || seen.get(n))) return false;
        if (!seen.has(n)) seen.set(n, mine);
        return true;
      });
    }
  }
  return s;
}
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    try { fs.chmodSync(tmp, fs.statSync(file).mode & 0o777); } catch { /* nuevo */ }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no llegó a crearse */ }
    throw e;
  }
}
function realHome() {
  try { return os.userInfo().homedir || null; } catch { return null; }
}

/**
 * Reescribe las rutas viejas de la máquina. `check`: cuenta y no escribe. Devuelve { renamed, files, notes }.
 * Un archivo que no parsea no se toca (se dice). Un LaunchAgent cambiado se recarga SÓLO si estaba cargado, y nunca con
 * una HOME que no es la real sin un LAUNCHCTL_BIN de prueba (una HOME temporal no aísla launchd). Un plist binario no se
 * toca: reescribirlo como texto lo corrompe (se dice).
 */
function migrateMachine(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const map = loadMap(opts);
  const res = { renamed: 0, files: [], notes: [] };
  if (!map) return res;
  const guides = opts.guides || HARNESS_ROOT;
  const skills = opts.skills || skillsRepoRoot(opts);
  const rewrites = machineRewrites(map, { guides, skills, home });
  if (!rewrites.length) return res;
  const relRewrites = relativePermissionRewrites(map, { guides });
  const norm = rootNormalizer([[guides, 'arnes'], [skills, 'agent-skills']], home);
  const why = (e) => (e && e.code) || (e && e.message) || e;
  const touch = (file, n, text) => {
    if (!n) return false;
    if (!opts.check) {
      // respaldo al lado, una vez por corrida que cambia algo (el retiro, AC 54, los barre). Sin respaldo no se toca: la
      // ruta vieja sigue andando por su reemplazo, y reescribir la configuración del dev sin red no vale ese riesgo.
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '');
      try { fs.copyFileSync(file, `${file}.bak-legacy-names-${stamp}`); } catch (e) {
        res.notes.push(`${file}: no pude respaldarlo (${why(e)}) — no lo reescribí; sigue con las rutas viejas, que andan por su reemplazo`);
        return false;
      }
      try { writeAtomic(file, text); } catch (e) {
        res.notes.push(`${file}: no pude reescribirlo (${why(e)}) — sigue con las rutas viejas, que andan por su reemplazo`);
        return false;
      }
    }
    res.renamed += n;
    res.files.push(file);
    return true;
  };
  // 1 · los JSON: settings.json, settings.local.json, ~/.codex/hooks.json
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const claudeSettings = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')];
  for (const f of [...claudeSettings, path.join(codexHome, 'hooks.json')]) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { res.notes.push(`${f} no parsea (${e.message}): no lo toqué`); continue; }
    const count = { n: 0 };
    const rewritten = new Set();
    rewriteStrings(data, rewrites, count, rewritten);
    // los permisos relativos, sólo en los settings de Claude Code (story 8.12, AC 9)
    if (claudeSettings.includes(f)) rewriteRelativePermissions(data, relRewrites, count, rewritten);
    if (count.n) dedupeSettings(data, norm, rewritten);
    touch(f, count.n, `${JSON.stringify(data, null, 2)}\n`);
  }
  // 2 · los hooks globales de git y sus .local
  const gitDir = env.TYCON_GIT_HOOKS_DIR || path.join(home, '.git-hooks');
  for (const name of ['pre-commit', 'post-commit', 'pre-push']) {
    for (const f of [path.join(gitDir, name), path.join(gitDir, `${name}.local`)]) {
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (raw.includes('\0')) continue;
      const r = rewriteText(raw, rewrites);
      touch(f, r.n, r.text);
    }
  }
  // 3 · los LaunchAgents que nombran una ruta vieja
  const agents = env.TYCON_LAUNCHAGENTS_DIR || path.join(home, 'Library', 'LaunchAgents');
  let plists = [];
  try { plists = fs.readdirSync(agents).filter((f) => f.endsWith('.plist')); } catch { /* no hay */ }
  const launchctl = env.LAUNCHCTL_BIN || null;
  const isRealHome = realHome() && path.resolve(realHome()) === path.resolve(home);
  const { spawnSync } = require('child_process');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  for (const name of plists) {
    const f = path.join(agents, name);
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    const raw = buf.toString('utf8');
    if (buf.subarray(0, 6).toString('latin1') === 'bplist' || buf.includes(0)) {
      if (rewriteText(buf.toString('latin1'), rewrites).n) res.notes.push(`${name}: plist binario con una ruta vieja — no lo toqué (reescribirlo como texto lo corrompe); convertilo con plutil -convert xml1 y volvé a correr el instalador`);
      continue;
    }
    const r = rewriteText(raw, rewrites);
    if (!r.n) continue;
    if (!touch(f, r.n, r.text) || opts.check) continue;
    const label = (/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(raw) || [])[1];
    if (!label) continue;
    const bin = launchctl || (isRealHome ? 'launchctl' : null);
    if (!bin) { res.notes.push(`${name}: reescrito; no toqué launchd (la HOME no es la real y no hay LAUNCHCTL_BIN)`); continue; }
    const loaded = spawnSync(bin, ['print', `gui/${uid}/${label}`], { stdio: 'ignore' }).status === 0;
    if (!loaded) continue;
    spawnSync(bin, ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
    const boot = spawnSync(bin, ['bootstrap', `gui/${uid}`, f], { stdio: 'ignore' });
    if (boot.status !== 0) res.notes.push(`${label}: no pude volver a cargarlo (launchctl bootstrap salió ${boot.status}) — cargalo a mano: launchctl bootstrap gui/${uid} ${f}`);
  }
  return res;
}

// ── --reroot: cambiar la raíz de lo escrito en la máquina (story 8.19, tanda B · AC 15 y 16) ───────────────────────
// El lugar del arnés pasó a llamarse como el repo público (place.js) y el nombre viejo sigue resolviendo. Lo que una máquina
// registró por el nombre viejo sigue andando, pero el día que el viejo se retire se rompe: `--reroot <de> <a>` lo pasa a
// la raíz nueva. `migrateMachine` (arriba) renombra lo de ADENTRO de una raíz y sale sin hacer nada sin el mapa; esto
// cambia la raíz misma y anda sin el mapa, que no viaja a la copia pública. Lo usa `harness.js relocate` (a mano,
// <viejo> → <lugar>) y lo va a reusar la story 8.13.1 con `--only-existing`. `doctor` cuenta con la MISMA expresión
// (`countRegistered`). Las reglas que no se negocian:
//   · NO resuelve enlaces: trabaja con las formas ESCRITAS de `<de>` (placeForms). Si siguiera el enlace, reescribiría
//     también los hooks registrados por la ruta real del clon (`rootForms` suma la ruta real: por eso no se usa acá).
//   · compara la ruta completa: `<de>` seguido de fin de ruta o de un separador; `<de>-viejo/…` no se toca.
//   · en los hooks (y en todo lo demás) reescribe; en `permissions.*` AGREGA la forma nueva al lado de la vieja: un
//     permiso es un patrón contra el comando que escribe otro, y mientras algún texto mande el nombre viejo, sacar la
//     forma vieja vuelve a preguntar. El retiro del nombre viejo (8.15) saca la vieja.
//   · un hook reescrito que ya estaba por la ruta real del clon (o por el lugar) se va: queda el de antes, y se dice uno
//     por uno; dos reescritos que quedan iguales quedan una vez. Nunca agrega un `$`: cada forma se reescribe en la suya.
/** Las formas escritas de una carpeta, con su tipo (el tipo empareja la forma de `<de>` con la de `<a>`). */
function placeFormKinds(dir, home, platform = process.platform) {
  const win = platform === 'win32';
  const out = [];
  const add = (kind, text) => { if (text && !out.some((f) => f.kind === kind)) out.push({ kind, text }); };
  const clean = (p) => {
    let s = String(p || '');
    if (win) s = s.replace(/\//g, '\\');
    while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:\\$/.test(s)) s = s.slice(0, -1);
    return s;
  };
  const d = clean(dir);
  if (!d) return out;
  add('abs', d);
  if (win) {
    add('abs-slash', d.replace(/\\/g, '/'));
    const m = /^([A-Za-z]):(.*)$/.exec(d);
    if (m) {
      const up = m[1].toUpperCase(); const lo = m[1].toLowerCase(); const rest = m[2];
      add('abs-upper', `${up}:${rest}`); add('abs-upper-slash', `${up}:${rest.replace(/\\/g, '/')}`);
      add('abs-lower', `${lo}:${rest}`); add('abs-lower-slash', `${lo}:${rest.replace(/\\/g, '/')}`);
      add('gitbash', `/${lo}${rest.replace(/\\/g, '/')}`);
    }
  }
  const h = home ? clean(home) : '';
  const sep = win ? '\\' : '/';
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (h && d.length > h.length && same(d.slice(0, h.length), h) && d[h.length] === sep) {
    const rel = d.slice(h.length + 1);
    const relSlash = rel.split(sep).join('/');
    add('tilde', `~/${relSlash}`); add('home', `$HOME/${relSlash}`); add('home-braces', `\${HOME}/${relSlash}`);
    if (win) {
      const relBack = rel.split('/').join('\\');
      add('userprofile', `%USERPROFILE%\\${relBack}`); add('env-userprofile', `$env:USERPROFILE\\${relBack}`);
      add('userprofile-slash', `%USERPROFILE%/${relSlash}`); add('tilde-back', `~\\${relBack}`);
    }
  }
  // las `\` escapadas como `\\` (TOML, un plist o un JSON leído como texto)
  for (const f of out.slice()) if (f.text.includes('\\')) add(`${f.kind}-esc`, f.text.replace(/\\/g, '\\\\'));
  return out;
}
/** Todas las formas escritas de `dir` (sin resolver enlaces), de la más larga a la más corta. */
function placeForms(dir, home, platform = process.platform) {
  return [...new Set(placeFormKinds(dir, home, platform).map((f) => f.text))].sort((a, b) => b.length - a.length);
}
// el borde de una ruta: delante, nada que pueda ser parte de un nombre (una `/` sí: los permisos escriben `//…`); atrás,
// fin de ruta o un separador (nunca otra letra: `<de>-viejo` no es `<de>`)
const REROOT_BEFORE = '(?<![\\w.~-])';
const REROOT_AFTER = '(?![\\w.@+~-])';
// en Windows una ruta no distingue mayúsculas (como `samePath`): la expresión tampoco, y el reemplazo se busca en minúscula
const winKey = (platform) => (platform === 'win32' ? (x) => String(x).toLowerCase() : (x) => x);
// Las formas que empiezan con `$`, `%` o `~` llevan un borde delante más corto: en `${VAR:-$HOME/…}` el `-` va pegado
// (pase adversarial de la tanda B: el pre-commit global de git se escribe así), y lo único que no puede ir delante es una
// letra o un dígito (`x~/…` no es la HOME).
function formsRegex(forms, platform = process.platform) {
  const sorted = [...forms].sort((a, b) => b.length - a.length);
  const lead = sorted.filter((f) => /^[$%~]/.test(f)); const plain = sorted.filter((f) => !/^[$%~]/.test(f));
  const alt = [];
  if (lead.length) alt.push(`(?<![\\w])(?:${lead.map(escapeRe).join('|')})`);
  if (plain.length) alt.push(`${REROOT_BEFORE}(?:${plain.map(escapeRe).join('|')})`);
  return new RegExp(`(?:${alt.join('|')})${REROOT_AFTER}`, platform === 'win32' ? 'gi' : 'g');
}
/** Los pares [forma de <de>, la misma forma de <a>] y la expresión que los encuentra. */
function rerootRule({ from, to, home, platform = process.platform, keep = null }) {
  const T = new Map(placeFormKinds(to, home, platform).map((f) => [f.kind, f.text]));
  const key = winKey(platform);
  const map = new Map();
  const forms = [];
  for (const f of placeFormKinds(from, home, platform)) {
    const t = T.get(f.kind);
    if (t && !map.has(key(f.text))) { map.set(key(f.text), t); forms.push(f.text); }
  }
  forms.sort((a, b) => b.length - a.length);
  return { map, key, re: forms.length ? formsRegex(forms, platform) : null, keep };
}
/** Reescribe `<de>` → `<a>` en un texto, cada forma en la suya. `rule` es un `rerootRule` o sus parámetros. */
function rerootText(text, ruleOrOpts) {
  const rule = ruleOrOpts && ruleOrOpts.map instanceof Map ? ruleOrOpts : rerootRule(ruleOrOpts);
  if (!rule.re) return { text, n: 0 };
  let n = 0;
  const out = String(text).replace(rule.re, (m, offset, str) => {
    if (rule.keep && rule.keep(str.slice(offset + m.length))) return m;
    n++;
    return rule.map.get(rule.key ? rule.key(m) : m);
  });
  return { text: out, n };
}
/** Lo que sigue a `<de>` en un texto, como ruta relativa (`/scripts/x.js` → `scripts/x.js`); '' si va pelado. */
function restOfPath(after) {
  const m = /^(?:\\\\|[\\/])[^\s"'<>|;,)\]`]*/.exec(after);
  if (!m) return '';
  return m[0].replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
const expandTilde = (p, home) => (typeof p === 'string' && /^~(?=$|[\\/])/.test(p) ? path.join(home, p.slice(1)) : p);

/** Los archivos de la máquina que mira `--reroot` (y `doctor`), con un nombre que no lleva la carpeta de la persona. */
function rerootFiles({ home, env = process.env, tree = null }) {
  const settings = env.TYCON_SETTINGS_PATH || path.join(home, '.claude', 'settings.json');
  const out = [
    { file: settings, label: 'settings.json', type: 'claude' },
    { file: path.join(path.dirname(settings), 'settings.local.json'), label: 'settings.local.json', type: 'claude' },
  ];
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  out.push({ file: path.join(codex, 'hooks.json'), label: 'codex/hooks.json', type: 'json' });
  out.push({ file: path.join(codex, 'config.toml'), label: 'codex/config.toml', type: 'text' });
  // Una COPIA que el arnés gestiona no es un registro (pase adversarial de la tanda B, B1): el pre-commit y el
  // post-commit globales son copias de scripts/hooks/git-{pre,post}-commit-global.sh y los comandos de barra que trae el
  // árbol, copias de <árbol>/commands/. Nombran la ruta vieja si su fuente la nombra, las pone al día el instalador, y
  // reescribirlas no sirve (la próxima copia las pisa). Con su fuente en el árbol no se cuentan ni se reescriben.
  const source = (rel) => (tree ? fs.existsSync(path.join(tree, rel)) : false);
  const git = env.TYCON_GIT_HOOKS_DIR || path.join(home, '.git-hooks');
  const gitSource = { 'pre-commit': 'scripts/hooks/git-pre-commit-global.sh', 'post-commit': 'scripts/hooks/git-post-commit-global.sh' };
  for (const n of ['pre-commit', 'post-commit', 'pre-push']) {
    for (const f of [n, `${n}.local`]) {
      if (f === n && gitSource[n] && source(gitSource[n])) continue;
      out.push({ file: path.join(git, f), label: `git-hooks/${f}`, type: 'text' });
    }
  }
  const agents = env.TYCON_LAUNCHAGENTS_DIR || path.join(home, 'Library', 'LaunchAgents');
  let plists = [];
  try { plists = fs.readdirSync(agents).filter((f) => f.endsWith('.plist')).sort(); } catch { /* no hay */ }
  for (const n of plists) out.push({ file: path.join(agents, n), label: `LaunchAgents/${n}`, type: 'plist' });
  // los comandos de barra PROPIOS de la persona (los que trae el árbol son copias gestionadas: arriba)
  let names = [];
  try { names = fs.readdirSync(path.join(home, '.claude', 'commands')).filter((n) => n.endsWith('.md')).sort(); } catch { /* sin comandos */ }
  for (const n of names) if (!source(path.join('commands', n))) out.push({ file: path.join(home, '.claude', 'commands', n), label: `commands/${n}`, type: 'text' });
  return out;
}
const isBinaryPlist = (buf) => buf.subarray(0, 6).toString('latin1') === 'bplist' || buf.includes(0);
// como `normMatcher` de managed.js: vacío y «*» son lo mismo, y `|` o `,` separan
const matcherKey = (g) => String((g && g.matcher) || '').split(/[|,]/).map((x) => x.trim()).filter((x) => x && x !== '*').sort().join('|');
/** Para comparar hooks: cada forma de `<a>` y de su ruta real, llevada a la ruta real. */
function rerootNormalizer(to, realTo, home, platform) {
  const forms = [...new Set([...placeForms(to, home, platform), ...placeForms(realTo, home, platform)])].sort((a, b) => b.length - a.length);
  const re = forms.length ? formsRegex(forms, platform) : null;
  return (s) => {
    const x = re ? String(s).replace(re, realTo) : String(s);
    return platform === 'win32' ? x.replace(/\//g, '\\').toLowerCase() : x;
  };
}
/**
 * Reescribe los hooks de un settings parseado y saca los gemelos: un hook reescrito que ya estaba (por la ruta real, por
 * el lugar o por otra forma no reescrita) se va; dos reescritos iguales quedan uno. Devuelve { n, dropped }.
 */
function rerootHooks(data, rule, norm) {
  const dropped = [];
  let n = 0;
  const hooks = data && data.hooks;
  if (!hooks || typeof hooks !== 'object') return { n, dropped };
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const changed = new Set();
    for (const g of hooks[ev]) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        if (!h || typeof h.command !== 'string') continue;
        const r = rerootText(h.command, rule);
        if (r.n) { n += r.n; h.command = r.text; changed.add(h); }
      }
    }
    if (!changed.size) continue;
    // las comillas no cambian qué corre: `node /x` y `node "/x"` son el mismo hook
    const key = (g, h) => `${matcherKey(g)}\0${norm(h.command).replace(/["']/g, '')}`;
    const plain = new Set();
    for (const g of hooks[ev]) for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) if (h && typeof h.command === 'string' && !changed.has(h)) plain.add(key(g, h));
    const seen = new Set();
    hooks[ev] = hooks[ev].map((g) => {
      if (!g || !Array.isArray(g.hooks)) return g;
      const kept = g.hooks.filter((h) => {
        if (!changed.has(h)) return true;
        const k = key(g, h);
        if (plain.has(k)) { dropped.push({ event: ev, command: h.command, why: 'twin' }); return false; }
        if (seen.has(k)) { dropped.push({ event: ev, command: h.command, why: 'repeated' }); return false; }
        seen.add(k);
        return true;
      });
      return kept.length === g.hooks.length ? g : { ...g, hooks: kept };
    }).filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
  }
  return { n, dropped };
}
/** En permissions.{allow,ask,deny}: al lado de cada permiso por `<de>`, la forma nueva (si no estaba). Devuelve cuántas agregó. */
function rerootPermissions(data, rule) {
  const perms = data && data.permissions;
  let added = 0;
  if (!perms || typeof perms !== 'object') return added;
  for (const k of ['allow', 'ask', 'deny']) {
    if (!Array.isArray(perms[k])) continue;
    const all = new Set(perms[k].filter((x) => typeof x === 'string'));
    const out = [];
    for (const p of perms[k]) {
      out.push(p);
      if (typeof p !== 'string') continue;
      const r = rerootText(p, rule);
      if (r.n && r.text !== p && !all.has(r.text)) { out.push(r.text); all.add(r.text); added++; }
    }
    perms[k] = out;
  }
  return added;
}
/** Reescribe todas las cadenas de un objeto salvo `skip` (claves de primer nivel). */
function rerootStrings(v, rule, skip = []) {
  let n = 0;
  const walk = (x, top) => {
    if (typeof x === 'string') { const r = rerootText(x, rule); n += r.n; return r.text; }
    if (Array.isArray(x)) return x.map((y) => walk(y, false));
    if (x && typeof x === 'object') { for (const k of Object.keys(x)) if (!(top && skip.includes(k))) x[k] = walk(x[k], false); return x; }
    return x;
  };
  const out = walk(v, true);
  return { value: out, n };
}
function findPlutil(env) {
  if (env.PLUTIL_BIN) return fs.existsSync(env.PLUTIL_BIN) ? env.PLUTIL_BIN : null;
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, 'plutil');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* no está acá */ }
  }
  return null;
}

/**
 * `--reroot <de> <a>`: la raíz de lo escrito en la máquina, de `<de>` a `<a>`. `check`: cuenta y no escribe.
 * `onlyExisting`: reescribe una ruta sólo si existe bajo `<a>` (8.13.1). Devuelve
 * { rerooted, files: [{ path, label, rerooted, permissions_added, dropped, note }], notes, dropped }. Tira un
 * LegacyNamesError con `exitCode = 1` si `<a>` no resuelve a una carpeta (y entonces no escribió nada).
 */
function rerootMachine(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const from = expandTilde(opts.from, home);
  const to = expandTilde(opts.to, home);
  let realTo;
  try {
    if (!fs.statSync(to).isDirectory()) throw new Error('no es una carpeta');
    realTo = fs.realpathSync(to);
  } catch (e) {
    throw Object.assign(new LegacyNamesError(`--reroot: ${to} no resuelve a una carpeta (${(e && e.code) || (e && e.message) || e}) — no toqué nada`), { exitCode: 1 });
  }
  const keep = opts.onlyExisting ? (after) => { const rel = restOfPath(after); return rel !== '' && !fs.existsSync(path.join(realTo, rel)); } : null;
  const rule = rerootRule({ from, to, home, platform, keep });
  const norm = rerootNormalizer(to, realTo, home, platform);
  const res = { rerooted: 0, files: [], notes: [], dropped: [] };
  const why = (e) => (e && e.code) || (e && e.message) || e;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '');
  // un plist no se respalda al lado: launchd podría cargar el respaldo como un segundo trabajo con la ruta vieja
  const plistBak = path.join(stateDirOf(home), 'reroot-bak');
  const bakOf = (file) => (path.extname(file) === '.plist' ? path.join(plistBak, `${path.basename(file)}.bak-reroot-${stamp}`) : `${file}.bak-reroot-${stamp}`);
  const backup = (file) => { if (path.extname(file) === '.plist') fs.mkdirSync(plistBak, { recursive: true }); fs.copyFileSync(file, bakOf(file)); };
  const record = (entry, n, extra = {}) => {
    const f = { path: entry.file, label: entry.label, rerooted: n, ...extra };
    res.files.push(f);
    res.rerooted += n;
    if (f.dropped) res.dropped.push(...f.dropped.map((d) => ({ ...d, label: entry.label })));
    return f;
  };
  const write = (entry, text) => {
    if (opts.check) return true;
    try { backup(entry.file); } catch (e) { res.notes.push(`${entry.label} (${entry.file}): no pude respaldarlo (${why(e)}) — no lo toqué; sigue por el nombre viejo, que resuelve`); return false; }
    try { writeAtomic(entry.file, text); } catch (e) { res.notes.push(`${entry.label} (${entry.file}): no pude reescribirlo (${why(e)}) — sigue por el nombre viejo, que resuelve`); return false; }
    return true;
  };
  const launchctl = env.LAUNCHCTL_BIN || null;
  const isRealHome = realHome() && path.resolve(realHome()) === path.resolve(home);
  const { spawnSync } = require('child_process');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  for (const entry of rerootFiles({ home, env, tree: realTo })) {
    let buf;
    try { buf = fs.readFileSync(entry.file); } catch (e) {
      if (!NO_EXISTE.has(e && e.code)) res.notes.push(`${entry.label} (${entry.file}): no pude leerlo (${why(e)}) — no lo toqué`);
      continue;
    }
    if (entry.type === 'claude' || entry.type === 'json') {
      let data;
      try { data = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch (e) { res.notes.push(`${entry.label} (${entry.file}) no parsea (${e.message}): no lo toqué`); continue; }
      const hk = rerootHooks(data, rule, norm);
      const added = entry.type === 'claude' ? rerootPermissions(data, rule) : 0;
      // lo demás —también lo que un hook lleva fuera de `command`—; los `command` ya no nombran `<de>`
      const rest = rerootStrings(data, rule, entry.type === 'claude' ? ['permissions'] : []);
      const n = hk.n + added + rest.n;
      if (!n) continue;
      if (write(entry, `${JSON.stringify(rest.value, null, 2)}\n`)) record(entry, n, { permissions_added: added, dropped: hk.dropped });
      continue;
    }
    if (entry.type === 'text') {
      if (buf.includes(0)) continue;
      const r = rerootText(buf.toString('utf8'), rule);
      if (r.n && write(entry, r.text)) record(entry, r.n);
      continue;
    }
    // un LaunchAgent
    let text = buf.toString('utf8');
    if (isBinaryPlist(buf)) {
      const n = rerootText(buf.toString('latin1'), rule).n;
      if (!n) continue;
      if (opts.check) { record(entry, n, { note: 'plist binario: se convierte con plutil -convert xml1 antes de reescribirlo' }); continue; }
      const plutil = findPlutil(env);
      if (!plutil) { res.notes.push(`${entry.label}: plist binario con el nombre viejo y sin plutil — no lo toqué (reescribirlo como texto lo corrompe); convertilo con plutil -convert xml1 y volvé a correrlo`); continue; }
      try { backup(entry.file); } catch (e) { res.notes.push(`${entry.label} (${entry.file}): no pude respaldarlo (${why(e)}) — no lo toqué`); continue; }
      const c = spawnSync(plutil, ['-convert', 'xml1', entry.file], { stdio: 'ignore' });
      let after = null;
      try { after = fs.readFileSync(entry.file); } catch { after = null; }
      if (c.status !== 0 || !after || isBinaryPlist(after)) {
        try { fs.copyFileSync(bakOf(entry.file), entry.file); } catch { /* quedó como lo dejó plutil */ }
        res.notes.push(`${entry.label}: plutil no lo pudo convertir (salió ${c.status}) — lo dejé como estaba`);
        continue;
      }
      text = after.toString('utf8');
      const r = rerootText(text, rule);
      try { writeAtomic(entry.file, r.text); } catch (e) { res.notes.push(`${entry.label}: convertido a XML pero no pude reescribirlo (${why(e)})`); continue; }
      record(entry, r.n, { note: 'plist binario convertido a XML con plutil' });
    } else {
      const r = rerootText(text, rule);
      if (!r.n || !write(entry, r.text)) continue;
      record(entry, r.n);
    }
    if (opts.check) continue;
    // recargarlo SÓLO si estaba cargado, y nunca con una HOME que no es la real sin un LAUNCHCTL_BIN de prueba
    const label = (/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text) || [])[1];
    if (!label) continue;
    const bin = launchctl || (isRealHome ? 'launchctl' : null);
    if (!bin) { res.notes.push(`${entry.label}: reescrito; no toqué launchd (la HOME no es la real y no hay LAUNCHCTL_BIN)`); continue; }
    if (spawnSync(bin, ['print', `gui/${uid}/${label}`], { stdio: 'ignore' }).status !== 0) continue;
    spawnSync(bin, ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
    const boot = spawnSync(bin, ['bootstrap', `gui/${uid}`, entry.file], { stdio: 'ignore' });
    if (boot.status !== 0) res.notes.push(`${label}: no pude volver a cargarlo (launchctl bootstrap salió ${boot.status}) — cargalo a mano: launchctl bootstrap gui/${uid} ${entry.file}`);
    else res.notes.push(`${label}: recargado en launchd (si estaba corriendo, se cortó y vuelve a correr en su próximo turno)`);
  }
  return res;
}

/**
 * Cuánto queda registrado por `<de>` en la máquina, archivo por archivo, con la MISMA expresión que `--reroot`: lo que
 * cuenta `doctor` y lo que sube al buzón. Sólo lee. `extra`: [{ file, label }] de texto (CLAUDE.md, que muda `relocate`).
 * Devuelve { total, files: [{ file: <label>, count, permissions }], notes }.
 */
function countRegistered(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const from = expandTilde(opts.from, home);
  const re = formsRegex(placeForms(from, home, platform), platform);
  const count = (s) => (String(s).match(re) || []).length;
  const out = { total: 0, files: [], notes: [] };
  const entries = [...rerootFiles({ home, env, tree: opts.tree || null }), ...(opts.extra || []).map((x) => ({ ...x, type: 'text' }))];
  for (const entry of entries) {
    let buf;
    try { buf = fs.readFileSync(entry.file); } catch (e) {
      if (!NO_EXISTE.has(e && e.code)) out.notes.push(`${entry.label}: no se pudo leer (${(e && e.code) || 'error'})`);
      continue;
    }
    let n = 0; let perms = 0;
    if (entry.type === 'claude' || entry.type === 'json') {
      let data;
      try { data = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch (_) { out.notes.push(`${entry.label}: no parsea`); continue; }
      const walk = (x, inPerms) => {
        if (typeof x === 'string') { const c = count(x); n += c; if (inPerms) perms += c; return; }
        if (Array.isArray(x)) { x.forEach((y) => walk(y, inPerms)); return; }
        if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], inPerms || (entry.type === 'claude' && x === data && k === 'permissions'));
      };
      walk(data, false);
    } else if (entry.type === 'plist' && isBinaryPlist(buf)) n = count(buf.toString('latin1'));
    else if (!buf.includes(0)) n = count(buf.toString('utf8'));
    if (!n) continue;
    out.files.push({ file: entry.label, count: n, permissions: perms });
    out.total += n;
  }
  return out;
}

// ── lo que carga legacy-names.sh ────────────────────────────────────────────────────────────────────────────────
/** Líneas separadas por tabuladores: `env old new` (todas), y `option|subcommand|value old new repeatable` de `where`. */
function shellLines(where, opts = {}) {
  const lines = [];
  for (const e0 of usableEntries(loadMap(opts))) {
    const e = bare(e0);
    if (typeof e.old !== 'string' || typeof e.new !== 'string' || /[\t\n]/.test(e.old + e.new)) continue;
    if (e.kind === 'env') lines.push(['env', e.old, e.new, ''].join('\t'));
    // cuarto campo: en una opción, si se repite; en un valor (tanda B3a), la opción de la que es —vacío: cualquiera—
    else if (e.kind === 'value' && e.where === where) lines.push([e.kind, e.old, e.new, typeof e.option === 'string' && !/[\t\n]/.test(e.option) ? e.option : ''].join('\t'));
    else if (['option', 'subcommand'].includes(e.kind) && e.where === where) lines.push([e.kind, e.old, e.new, e.repeatable === true ? '1' : '0'].join('\t'));
  }
  return lines;
}

// ── las claves del banco y de las suites (tanda C1, AC 33) ──────────────────────────────────────────────────────
// La identidad de un caso del banco es `<nombre del script>::<id>` (runner.js → claveDeCaso) y la de una suite, el nombre
// de su archivo: renombrar un hook o una prueba cambia la clave. Para que el banco corrido después no reporte casos
// nuevos ni perdidos, el commit del renombre migra las líneas de base y las fotos nocturnas (--migrate-bench), y
// pr-verdict.js pasa las dos fotos por el mismo mapa antes de comparar.
/**
 * Nombre de archivo viejo → nuevo de las entradas `file` que cambian de nombre. `moved` (opcional) filtra por mudanza. Un
 * nombre viejo que el mapa lleva a dos nombres nuevos distintos no se traduce: sería adivinar cuál de los dos es.
 */
function basenameRenames(map, { moved } = {}) {
  // cada nombre viejo con TODOS sus destinos, también el suyo propio (una mudanza de carpeta sin cambio de nombre): si un
  // archivo sólo se mudó y otro con el mismo nombre se renombró, la clave no dice cuál de los dos es (pase adversarial, C1)
  const targets = new Map();
  for (const e of usableEntries(map)) {
    if (e.kind !== 'file' || (moved && !moved(e))) continue;
    const o = path.posix.basename(e.old);
    if (!targets.has(o)) targets.set(o, new Set());
    targets.get(o).add(path.posix.basename(e.new));
  }
  const out = new Map();
  for (const [o, ns] of targets) {
    const [n] = ns;
    if (ns.size === 1 && n !== o) out.set(o, n);
  }
  return out;
}
/** Una clave del banco (`<script>::<id>`) o el nombre de una suite, con el nombre nuevo de su archivo. */
function renameKey(key, renames) {
  const s = String(key);
  const i = s.indexOf('::');
  const nu = renames.get(i < 0 ? s : s.slice(0, i));
  return nu ? nu + (i < 0 ? '' : s.slice(i)) : s;
}
/**
 * Migra las claves de lo que se commitea del banco: líneas de base, fotos nocturnas y los casos (su `script` y el nombre
 * con que empieza su `hook`). Reemplaza en el texto, sólo strings JSON enteros o el principio `"<nombre>::`, así el formato
 * de cada archivo queda como está y la prosa (los motivos de una suite) no se toca. Sólo lo ya mudado. Idempotente.
 */
function migrateBench(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const map = loadMap(opts);
  const files = usableEntries(map).filter((e) => e.kind === 'file');
  const moved = new Set(files.filter((e) => isMoved(e, rootOf(e, { ...opts, root }))));
  const renames = basenameRenames(map, { moved: (e) => moved.has(e) });
  const paths = [...moved].filter((e) => (e.repo || 'arnes') === 'arnes').map((e) => [e.old, e.new]);
  const bench = path.join(root, 'scripts', 'controls-bench');
  const targets = [];
  const walk = (d) => (mirar(() => fs.readdirSync(d, { withFileTypes: true }), d) || [])
    .forEach((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith('.json') && targets.push(path.join(d, f.name))));
  walk(path.join(bench, 'baseline'));
  walk(path.join(bench, 'cases'));
  for (const f of ['ultimo-banco.json', 'ultimo-suites.json']) if (mirar(() => fs.statSync(path.join(bench, f)), f)) targets.push(path.join(bench, f));
  const changed = [];
  for (const file of targets) {
    const before = fs.readFileSync(file, 'utf8');
    let text = before;
    if (file.startsWith(path.join(bench, 'cases') + path.sep)) {
      // En un caso, sólo lo que nombra el ARCHIVO REAL del arnés: su `script` y lo que copia o corre desde la raíz
      // (`$TCG/…`, `${TCG}/…`, `${FIXTURE}/tcg/…`). Los nombres que un caso inventa para su laboratorio y la prosa de
      // un incidente quedan como están: no son el archivo renombrado.
      const root = '(\\$TCG/|\\$\\{TCG\\}/|\\$\\{FIXTURE\\}/tcg/)';
      for (const [o, n] of paths) text = text.replace(new RegExp(`${root}${escapeRe(o)}(?![\\w.\\-])`, 'g'), `$1${n}`);
      // el `hook` es prosa para --list, pero empieza con el nombre del script: «<script>.js (…)»
      for (const [o, n] of renames) text = text.replace(new RegExp(`("hook"\\s*:\\s*")${escapeRe(o)}(?![\\w.\\-])`, 'g'), `$1${n}`);
    } else {
      for (const [o, n] of renames) text = text.replace(new RegExp(`"${escapeRe(o)}(?="|::)`, 'g'), `"${n}`);
    }
    if (text === before) continue;
    JSON.parse(text);   // nunca se escribe un JSON roto
    if (!opts.check) writeAtomic(file, text);
    changed.push(slash(path.relative(root, file)));
  }
  return { changed, renames: renames.size };
}

// ── la línea de comandos ────────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const a = { flags: new Set(), val: {} };
  const need = (i, flag) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new LegacyNamesError(`${flag} necesita un valor`);
    return argv[i];
  };
  let mode = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--reroot') {
      // story 8.19 (AC 15): las dos rutas van pegadas a la opción
      const pair = argv.slice(i + 1, i + 3);
      if (pair.length < 2 || pair.some((p) => String(p).startsWith('--'))) throw new LegacyNamesError(`--reroot necesita dos rutas\n${REROOT_USAGE}`);
      a.reroot = pair; i += 2;
    } else if (x === '--json') a.flags.add('json');
    else if (x === '--only-existing') a.flags.add('only-existing');
    else if (x === '--write-shims' || x === '--migrate-machine' || x === '--migrate-bench') mode = x.slice(2);
    else if (x === '--prepare-state') { mode = 'prepare-state'; while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) rest.push(argv[++i]); } else if (x === '--where') a.val.where = need(++i, x);
    else if (x === '--shell') { mode = 'shell'; a.val.where = need(++i, x); } else if (x === '--log-use') { mode = 'log-use'; rest.push(...argv.slice(i + 1, i + 5)); i += 4; } else if (x === '--check') a.flags.add('check');
    else if (x === '--conflict') a.flags.add('conflict');
    else if (['--map', '--root', '--skills-root', '--guides', '--skills', '--home'].includes(x)) a.val[x.slice(2)] = need(++i, x);
    else throw new LegacyNamesError(`opción desconocida: ${x}`);
  }
  const opts = { mapFile: a.val.map, root: a.val.root, skillsRoot: a.val['skills-root'], home: a.val.home };
  if ((a.reroot || a.flags.has('json') || a.flags.has('only-existing')) && mode !== 'migrate-machine') throw new LegacyNamesError(`--reroot, --json y --only-existing van con --migrate-machine\n${REROOT_USAGE}`);
  if (mode === 'migrate-machine' && a.reroot) {
    // story 8.19 (AC 15 y 16): antes de la salida «sin mapa no hay nada que hacer» de migrateMachine: anda sin el mapa
    const check = a.flags.has('check');
    let r;
    try {
      r = rerootMachine({ from: a.reroot[0], to: a.reroot[1], home: a.val.home, check, onlyExisting: a.flags.has('only-existing') });
    } catch (e) {
      if (e instanceof LegacyNamesError && e.exitCode === 1) { process.stderr.write(`⛔ legacy-names: ${e.message}\n`); return 1; }
      throw e;
    }
    process.stdout.write(`REROOTED:${r.rerooted}\n`);
    for (const f of r.files) process.stdout.write(`  ${check ? 'por cambiar' : 'cambiado'}: ${f.label} (${f.rerooted}${f.permissions_added ? `, ${f.permissions_added} permiso(s) con la forma nueva al lado` : ''})${f.note ? ` — ${f.note}` : ''}\n`);
    for (const d of r.dropped) process.stdout.write(`  ${check ? 'saldría' : 'sacado'} de ${d.label} (${d.event}): ${d.command} — ${d.why === 'twin' ? 'ya estaba por la ruta real del clon' : 'quedaba repetido'}\n`);
    for (const n of r.notes) process.stdout.write(`  ⚠ ${n}\n`);
    if (a.flags.has('json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  if (mode === 'write-shims') {
    const w = writeShims(opts);
    process.stdout.write(w.written.length ? `reemplazos escritos (${w.written.length}): ${w.written.join(', ')}\n` : 'ningún archivo del mapa necesita reemplazo todavía\n');
    if (w.pending.length) process.stdout.write(`todavía no movidos (su reemplazo se genera en la mudanza): ${w.pending.join(', ')}\n`);
    return 0;
  }
  if (mode === 'migrate-machine') {
    const r = migrateMachine({ ...opts, check: a.flags.has('check'), guides: a.val.guides, skills: a.val.skills });
    process.stdout.write(`RENAMED:${r.renamed}\n`);
    for (const f of r.files) process.stdout.write(`  ${a.flags.has('check') ? 'por reescribir' : 'reescrito'}: ${f}\n`);
    for (const n of r.notes) process.stdout.write(`  ⚠ ${n}\n`);
    return 0;
  }
  if (mode === 'migrate-bench') {
    const r = migrateBench({ ...opts, check: a.flags.has('check') });
    process.stdout.write(`${a.flags.has('check') ? 'por migrar' : 'migrados'}: ${r.changed.length} archivo(s) del banco (${r.renames} nombre(s) de archivo cambiados)\n`);
    for (const f of r.changed) process.stdout.write(`  ${f}\n`);
    return 0;
  }
  if (mode === 'shell') {
    const lines = shellLines(a.val.where, opts);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (mode === 'prepare-state') {
    // Lo que abre bash con `>>` (o launchd) antes de que corra node: la copia tiene que estar ANTES de abrirlo (tanda D2).
    // Prueba todas las rutas aunque una falle; una que no está en el mapa es paso directo.
    if (!rest.length) throw new LegacyNamesError('--prepare-state necesita al menos una ruta');
    const errors = [];
    for (const p of rest) {
      try { prepareStateWrite(p, { ...opts, where: a.val.where || 'scripts/lib/legacy-names.js' }); } catch (e) {
        if (!(e instanceof LegacyNamesError)) throw e;
        errors.push(e.message);
      }
    }
    if (errors.length) throw new LegacyNamesError(errors.join(' · '));
    return 0;
  }
  if (mode === 'log-use') {
    const [kind, old, nu, script] = rest;
    if (KINDS.includes(kind) && old && nu) recordUse({ kind, old, new: nu, script, conflict: a.flags.has('conflict') }, { ...opts, env: { ...process.env, TF_BUILD: '' } });   // el warning de CI ya lo dio el guion
    return 0;
  }
  throw new LegacyNamesError('falta qué hacer: --write-shims, --migrate-machine, --migrate-bench, --shell <where>, --prepare-state <ruta>… o --log-use <kind> <old> <new> <script>');
}

module.exports = {
  basenameRenames, renameKey, migrateBench, isGeneratedShim,
  LegacyNamesError, KINDS, CALLERS, NO_SHIM_CALLERS, SHIM_MARK, DEFAULT_MAP, loadMap, entriesOf, usableEntries, expand, needsShim,
  supportsShim, pathProblem, within, readEnv, envNames, aliasOptions, aliasArgv, resolveFile, prepareStateWrite, oldPathOf, readKeys, readKeysDeep, recordUse,
  isShim, shimTarget, resolveShimsInCommand, writeShims, migrateMachine, machineRewrites, relativePermissionRewrites, shellLines, oldStillReal, isMoved, gitAt,
  repoForms, placeForms, rerootText, rerootMachine, countRegistered, rerootFiles, cli,
};

/**
 * La línea de comandos entera, como función (story 8.36): lo mismo que corre el arranque de este archivo como programa,
 * con su `try/catch`. Devuelve el código de salida. La llama la tanda del aplicador (scripts/setup/applier-batch.js).
 */
function cli(argv) {
  try {
    return main(argv);
  } catch (e) {
    process.stderr.write(`⛔ legacy-names: ${e instanceof LegacyNamesError ? e.message : (e && e.stack) || e}\n`);
    return 2;
  }
}

// DESPUÉS del `module.exports`, no antes (pase adversarial del tramo 1 de la story 8.18, hallazgos 10 y 11): como módulo
// principal, `main()` llega a skills-dir.js → canonical-path.js, que importa ESTE archivo; con las exportaciones todavía
// sin asignar, Node escribía dos avisos de dependencia circular por stderr en cada corrida en un clon unido.
if (require.main === module) process.exitCode = cli(process.argv.slice(2));
