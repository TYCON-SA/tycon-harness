'use strict';
// tycon-home.js — dónde vive el arnés en la máquina: la única pieza que lo sabe.
//
// ── EL CASO ──────────────────────────────────────────────────────────────────────────────────────────────────────
// El arnés puede vivir en `~/.tycon`, fuera de la carpeta de cualquier herramienta. Para que cinco piezas (place.js,
// harness-path.js, state.js, skills-dir.js, tycon-config.js) no resuelvan cada una su pedazo de la ruta, con `.claude`
// adentro, la ruta se pide a UN lugar: este archivo.
//
// ── QUÉ HAY ACÁ ───────────────────────────────────────────────────────────────────────────────────────────────────
// Una función por ruta. En una máquina sin casa propia cada una vale lo de siempre, bajo `~/.claude`:
//   · harnessDir(home)          el arnés: lo que resuelve el lugar (resolvePlace: primero el lugar, después el nombre viejo)
//   · stateDir(home)            el estado del mecanismo y del pipeline: ~/.claude/.tycon-pipeline
//   · configFile(home)          la configuración de la máquina: ~/.claude/tycon.json
//   · backupsDir(home)          las copias de seguridad: ~/.claude/.tycon-pipeline/harness/backups
//   · installedSkillsDir(home)  las skills instaladas: ~/.claude/agent-skills
//   · home({ env })             la carpeta propia del arnés, ~/.tycon (o TYCON_HOME): la usan las instalaciones `release`
//
// ── LA MÁQUINA QUE VIVE EN ~/.tycon ──────────────────────────────────────────────────────────────────────────────────
// Una máquina SIN Claude Code no puede guardar nada en la carpeta de Claude Code: su estado nace en
// `~/.tycon/state`. La regla es una sola y la lee el disco: **si existe `~/.tycon/state`, el estado, las copias y la
// configuración son los de `~/.tycon`; si no, los de `~/.claude`**. La crea `install --version` en una máquina que no enchufa a
// Claude Code (`adoptOwnHome`), y es la misma regla con que la mudanza pasa a las demás (mover y crear esa carpeta). Una
// máquina sin esa carpeta contesta lo de siempre, byte a byte.
// Acá vive también el lugar del arnés (place.js queda como fachada): los dos nombres, sus rutas y
// resolvePlace. Las variables parciales (TYCON_GUIDES_DIR, TYCON_SKILLS_DIR, TYCON_HARNESS_SNAPSHOT_DIR, …) las
// sigue leyendo cada pieza ANTES de pedir acá: ganan en su pedazo, como siempre.
//
// ── POR QUÉ VIVE ACÁ Y NO EN scripts/lib/ ─────────────────────────────────────────────────────────────────────────
// La copia fija del programa (`~/.claude/.tycon-pipeline/harness/program/harness/`) se refresca copiando esta carpeta
// entera, y la copia la hace el código VIEJO en memoria. Un archivo de otra carpeta no llegaría a la copia en la primera
// actualización y `rollback`/`uninstall` de emergencia quedarían rotos hasta la versión siguiente. Acá viaja solo.
// El instalador del freno de producción copia esta pieza a /opt/tycon/setup/harness/, para cuando
// skills-dir.js y tycon-config.js le pidan su ruta.
//
// Sin dependencias: sólo módulos de Node. Corre suelto desde la copia fija y desde la del freno.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLACE_NAME = 'tycon-harness';
const LEGACY_PLACE_NAME = 'tycon-claude-guides';
const OWN_DIR_NAME = '.tycon';

class TyconHomeError extends Error {
  constructor(message) { super(message); this.name = 'TyconHomeError'; }
}

// la carpeta de Claude Code bajo el HOME: el arnés vive adentro, salvo en una máquina con casa propia
function claudeDir(home) { return path.join(home || os.homedir(), '.claude'); }

function placePath(home) { return path.join(claudeDir(home), PLACE_NAME); }
function legacyPlacePath(home) { return path.join(claudeDir(home), LEGACY_PLACE_NAME); }

/** «Clon válido del arnés» = existe y tiene el instalador. */
function isHarnessClone(dir) { return !!dir && fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh')); }

function realOrNull(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function exists(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }

/**
 * El lugar del arnés: primero el lugar, después el nombre viejo.
 * @returns {{dir:string|null, via:'place'|'legacy'|null, path:string|null, tried:string[], invalid:{path:string,real:string}[], present:string[]}}
 *   `dir`: la carpeta real del clon (o null) · `via`: por cuál nombre se encontró · `path`: la ruta de ese nombre ·
 *   `tried`: las dos rutas, en orden · `invalid`: los nombres que resuelven a algo que no es un clon · `present`: los
 *   nombres en los que hay algo (sirve para nombrar el viejo SÓLO si existe).
 */
function resolvePlace({ home, isValid = isHarnessClone } = {}) {
  const tried = [placePath(home), legacyPlacePath(home)];
  const out = { dir: null, via: null, path: null, tried, invalid: [], present: tried.filter(exists) };
  for (const [i, p] of tried.entries()) {
    const r = realOrNull(p);
    if (!r) continue;
    if (!isValid(r)) { out.invalid.push({ path: p, real: r }); continue; }
    Object.assign(out, { dir: r, via: i === 0 ? 'place' : 'legacy', path: p });
    return out;
  }
  return out;
}

/** La casa propia del arnés vista desde un HOME: `TYCON_HOME` si está (y vale), o `<home>/.tycon`. Nunca tira. */
function ownRootOf(home) {
  const v = process.env.TYCON_HOME === undefined ? '' : String(process.env.TYCON_HOME).trim();
  return v && path.isAbsolute(v) ? v : path.join(home || os.homedir(), OWN_DIR_NAME);
}
/** El estado de una máquina que vive en la casa propia: `~/.tycon/state`. */
function ownStateDir(home) { return path.join(ownRootOf(home), 'state'); }
/** El estado donde vivió siempre (y vive, hasta la mudanza, en una máquina con Claude Code). */
function legacyStateDir(home) { return path.join(claudeDir(home), '.tycon-pipeline'); }
/** ¿Esta máquina vive en la casa propia del arnés? (existe `~/.tycon/state`: la regla de la cabecera) */
function livesInOwnHome(home) {
  try { return fs.statSync(ownStateDir(home)).isDirectory(); } catch (_) { return false; }
}
/**
 * La máquina pasa a vivir en la casa propia: crea `~/.tycon/state`. Lo llama `install --version` en una máquina que no
 * enchufa a Claude Code y no tiene estado donde siempre, y la mudanza. Devuelve la carpeta. Tira si
 * no la puede crear: sin ella el estado caería en la carpeta de Claude Code.
 */
/** ¿`~/.tycon/state` existe pero no tiene estado? Es el resto de una instalación cortada (Ctrl-C en «¿Instalo?»): la
 *  máquina NO vive ahí. */
function ownHomeStale(home) {
  return livesInOwnHome(home) && !fs.existsSync(path.join(ownStateDir(home), 'harness-state.json'));
}
/** Saca ese resto. Devuelve true si había algo que sacar. */
function dropStaleOwnHome(home, { log = null } = {}) {
  if (!ownHomeStale(home)) return false;
  try { fs.rmSync(ownStateDir(home), { recursive: true, force: true }); return true; } catch (e) { if (log) log(`no pude sacar ${ownStateDir(home)} (${e.code || e.message}): queda, y la máquina sigue contando como «vive en ~/.tycon»`); return false; }
}
function adoptOwnHome(home) {
  const dir = ownStateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function harnessDir(home) { return resolvePlace({ home }).dir; }
function stateDir(home) { return livesInOwnHome(home) ? ownStateDir(home) : legacyStateDir(home); }
/** La configuración de la máquina donde siempre estuvo (la carpeta de Claude Code): lo que la mudanza funde y deja como enlace. */
function legacyConfigFile(home) { return path.join(claudeDir(home), 'tycon.json'); }
function configFile(home) { return livesInOwnHome(home) ? path.join(ownRootOf(home), 'config.json') : legacyConfigFile(home); }
// las copias de seguridad: en la casa propia van aparte del estado (`~/.tycon/backups`), así desinstalar puede quitar el
// estado entero y dejarlas; donde siempre, adentro de la carpeta del mecanismo
function backupsDir(home) { return livesInOwnHome(home) ? path.join(ownRootOf(home), 'backups') : path.join(stateDir(home), 'harness', 'backups'); }
function installedSkillsDir(home) { return path.join(claudeDir(home), 'agent-skills'); }
/** Las carpetas del estado que el arnés puede estar usando o va a usar: la vigente y la de la casa propia (sin repetir). */
function stateDirs(home) { return [...new Set([stateDir(home), ownStateDir(home)])]; }
/**
 * ¿La máquina instaló una versión BAJADA? Se lee del estado del mecanismo (una fuente `kind:
 * release`), sin cargar state.js (que carga este archivo). Un estado ilegible o ausente es «no» (un clon, o nada).
 */
function isReleaseMachine(home) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir(home), 'harness-state.json'), 'utf8'));
    return Boolean(s && Array.isArray(s.sources) && s.sources.some((x) => x && x.kind === 'release'));
  } catch (_) { return false; }
}

/** `paths.maintained` de `~/.tycon/config.json` (la ruta del clon que esta máquina MANTIENE), o null. */
function maintainedPath({ env = process.env } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(ownPaths({ env }).config, 'utf8'));
    const v = j && j.paths && typeof j.paths.maintained === 'string' ? j.paths.maintained.trim() : '';
    return v && path.isAbsolute(v) && fs.existsSync(v) ? v : null;
  } catch (_) { return null; }
}

/**
 * `paths.maintainers` de `~/.tycon/config.json`: el clon del repo PRIVADO de mantenimiento que la máquina declara. → `{ declared, path, problem }`. A diferencia de `maintainedPath`, distingue «no declara
 * ninguno» (`declared: false`, sin `problem`) de «declara uno que no sirve» (`problem` dice por qué, sin citar nada del
 * archivo): quien reconoce los repos del arnés o lee de ahí la configuración del merge tiene que poder DECIRLO, no
 * callar. Una configuración que no se deja leer es `declared: false` con `problem` (no se sabe si declaraba). Nunca
 * tira, y `problem` nunca cita el contenido del archivo (trae un permiso en texto plano).
 */
function maintainersClone({ env = process.env } = {}) {
  const none = (problem = null) => ({ declared: false, path: null, problem });
  let file;
  try { file = ownPaths({ env }).config; } catch (e) { return none(`no pude ubicar la configuración de la máquina (${e.message})`); }
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return none();
    return none('la configuración de la máquina (config.json del arnés) no se puede leer: no sé si declara paths.maintainers');
  }
  const raw = j && typeof j === 'object' && j.paths && typeof j.paths === 'object' ? j.paths.maintainers : undefined;
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return none();
  const bad = (problem) => ({ declared: true, path: v, problem });
  if (!path.isAbsolute(v)) return bad('paths.maintainers no es una ruta absoluta');
  let st = null;
  try { st = fs.statSync(v); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return bad('paths.maintainers nombra una carpeta que no está');
  return { declared: true, path: v, problem: null };
}

/**
 * El árbol que se MANTIENE: de ahí leen los avisos de la máquina lo que escriben los
 * nocturnos en el repo (`.dashboard/…`). En un clon es el árbol de quien pregunta (`ownTree`), como siempre; en una
 * instalación `release` es el clon que la máquina declara como el que mantiene (`paths.maintained`), o
 * null: ningún aviso corre git sobre `~/.tycon`, y sin clon declarado calla.
 */
function maintainedDir(home, ownTree) {
  if (isReleaseMachine(home)) return maintainedPath();
  return ownTree || null;
}

/**
 * Dónde se escribe y se lee `.dashboard` (lo de los nocturnos y las corridas) en esta máquina: en un clon, adentro del árbol de quien pregunta (`<tree>/.dashboard`, como siempre); en una instalación
 * `release` —que vive en `~/.tycon` y cuyo árbol se reemplaza entero en cada actualización—, `~/.tycon/state/dashboard`
 * (la mudanza copia ahí lo que el clon traía).
 */
function dashboardDir(home, ownTree) {
  if (isReleaseMachine(home)) {
    // con un clon declarado como el que se mantiene, lo escrito va AHÍ (de ahí se commitea y de ahí leen los avisos:
    // retro-pending.js); sin clon declarado, en el estado propio
    const m = maintainedPath();
    return m ? path.join(m, '.dashboard') : path.join(stateDir(home), 'dashboard');
  }
  return ownTree ? path.join(ownTree, '.dashboard') : null;
}

/**
 * La carpeta propia del arnés: `TYCON_HOME` si está, o `os.homedir()` + `.tycon` (en Windows, la de USERPROFILE).
 * Una `TYCON_HOME` relativa o vacía es un error que la nombra: no se adivina contra qué carpeta resolverla.
 */
function home({ env = process.env } = {}) {
  if (Object.prototype.hasOwnProperty.call(env, 'TYCON_HOME') && env.TYCON_HOME !== undefined) {
    const v = String(env.TYCON_HOME).trim();
    if (!v) throw new TyconHomeError('TYCON_HOME está definida pero vacía: poné una ruta absoluta o sacala');
    if (!path.isAbsolute(v)) throw new TyconHomeError(`TYCON_HOME tiene que ser una ruta absoluta (dice «${v}»)`);
    return v;
  }
  return path.join(os.homedir(), OWN_DIR_NAME);
}

/**
 * Las carpetas de la casa propia del arnés: lo que una instalación `release` escribe adentro de
 * `~/.tycon`. `harness` es la versión activa (siempre la misma ruta real), `previous` la anterior, `incoming` donde se
 * arma una nueva, `trash` lo que se borra en el arranque siguiente, `thirdParty` la caché de las skills de terceros,
 * `config` el permiso de GitHub y `paths.maintained`, `journal` el diario del cambio de versión.
 */
function ownPaths({ env = process.env } = {}) {
  const root = home({ env });
  return {
    root,
    harness: path.join(root, 'harness'),
    previous: path.join(root, 'previous'),
    incoming: path.join(root, 'incoming'),
    trash: path.join(root, 'trash'),
    thirdParty: path.join(root, 'third-party'),
    config: path.join(root, 'config.json'),
    journal: path.join(root, 'swap.json'),
    // la forma con enlaces: las versiones, cada una en su carpeta numerada, y el diario del cambio de enlaces
    versions: path.join(root, 'versions'),
    linkJournal: path.join(root, 'link-swap.json'),
  };
}

/**
 * El Node propio del arnés: `<casa>/node/` con cada versión en `versions/<v>/` y el enlace `current` a la
 * que está en uso (simbólico en Mac y Linux, unión en Windows). Lo que dura escrito —el comando de un hook, el plist del
 * examen— nombra `current`, nunca la carpeta numerada: cambiar de versión de Node no cambia ningún comando. `bin` es el
 * binario por `current` (`bin/node`, o `node.exe` en Windows, que se baja suelto). Esta regla está escrita también en
 * bootstrap.js, scripts/lib/harness-node.sh, install-tycon-hooks.ps1 y periodic-exam.js (copias declaradas en
 * scripts/tests/fixtures/harness-node-copies.json, que tycon-home.test.js compara).
 */
function harnessNode({ env = process.env, platform = process.platform } = {}) {
  const dir = path.join(home({ env }), 'node');
  const current = path.join(dir, 'current');
  return {
    dir,
    versions: path.join(dir, 'versions'),
    trash: path.join(dir, 'trash'),
    current,
    bin: platform === 'win32' ? path.join(current, 'node.exe') : path.join(current, 'bin', 'node'),
    binIn: (versionDir) => (platform === 'win32' ? path.join(versionDir, 'node.exe') : path.join(versionDir, 'bin', 'node')),
  };
}

// ── LA FORMA CON ENLACES ─────────────────────────────────────────────────────────────────
// En Windows renombrar una carpeta con un archivo abierto, con un proceso parado adentro o con un vigilante falla: con
// otra sesión o un VS Code abiertos, el cambio de versión por `rename` esperaría para siempre. En Windows `harness` y
// `previous` son UNIONES a `versions/<v>/`, y cambiar de versión es cambiar la unión, que anda con la carpeta vieja tomada de las tres formas.
// Mac y Linux siguen con carpetas reales y `rename`; las pruebas de Mac ejercitan esta forma con `TYCON_RELEASE_LINKS=1` (sólo de pruebas), con
// enlaces simbólicos. Las funciones viven acá porque viajan con la copia fija del programa (ver la cabecera).

/** ¿Esta máquina usa la forma con enlaces? Windows siempre; en otra plataforma, sólo la variable de pruebas. */
function linksMode({ env = process.env, platform = process.platform } = {}) {
  return platform === 'win32' || String(env.TYCON_RELEASE_LINKS || '') === '1';
}
/** ¿`p` es un enlace (simbólico o unión)? Sin seguirlo. */
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
/** A dónde apunta el enlace `p`, como ruta absoluta (o null si no es un enlace). Una unión de Windows se lee sin `\\?\`. */
function linkTarget(p) {
  if (!isLink(p)) return null;
  try {
    const t = fs.readlinkSync(p).replace(/^\\\\\?\\/, '');
    return path.resolve(path.dirname(p), t);
  } catch (_) { return null; }
}
/** Crea el enlace `at` → `target` (una unión en Windows: un enlace simbólico de carpeta pide privilegios). */
function makeLink(target, at, { platform = process.platform } = {}) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, platform === 'win32' ? 'junction' : 'dir');
}
/** Quita el enlace `at` sin tocar a dónde apunta (nunca un borrado recursivo: en Windows una unión se quita como carpeta). */
function removeLink(at) {
  if (!isLink(at)) return false;
  try { fs.unlinkSync(at); } catch (_) { fs.rmdirSync(at); }
  return true;
}
const TMP_LINK_MARK = '.tycon-new-';
/**
 * Pone el enlace `at` apuntando a `target`. Crea antes el nuevo con un nombre temporal: si eso falla, no se tocó nada.
 * En posix el temporal reemplaza al viejo con un `rename` atómico (nadie ve `at` ausente); en Windows `rename` sobre una
 * unión no anda, así que se quita la vieja y se renombra la temporal (un hueco de ~1 ms, medido). Si el reemplazo falla,
 * `at` se recrea hacia lo que era y tira. Un `at` que existe y NO es un enlace no se toca: tira.
 */
function pointLink(at, target, { platform = process.platform } = {}) {
  let present = true;
  try { fs.lstatSync(at); } catch (_) { present = false; }
  if (!present) { makeLink(target, at, { platform }); return; }
  const before = linkTarget(at);
  if (!before) throw new Error(`${at} no es un enlace: no lo reemplazo`);
  const tmp = `${at}${TMP_LINK_MARK}${process.pid}`;
  removeLink(tmp);
  makeLink(target, tmp, { platform });
  try {
    if (platform === 'win32') { removeLink(at); fs.renameSync(tmp, at); } else fs.renameSync(tmp, at);
  } catch (e) {
    try { fs.lstatSync(at); } catch (_) { try { makeLink(before, at, { platform }); } catch (_e) { /* lo repara el diario */ } }
    try { removeLink(tmp); } catch (_) { /* nada */ }
    throw e;
  }
}
/**
 * El ambiente para los procesos que ESCRIBEN rutas del árbol (el aplicador, el enchufe de Codex) en la forma con
 * enlaces: Node resuelve el enlace en `__dirname`, y una ruta así escrita en un archivo
 * ataría la máquina a esa versión. Con `--preserve-symlinks` y `--preserve-symlinks-main` en `NODE_OPTIONS` (los
 * heredan todos los Node que se lancen abajo), `__dirname` queda en `~/.tycon/harness`. Fuera de esa forma, `env` tal cual.
 */
function keepLinkPathsEnv(env = process.env) {
  if (!linksMode({ env })) return env;
  const flags = ['--preserve-symlinks', '--preserve-symlinks-main'];
  const now = String(env.NODE_OPTIONS || '');
  const add = flags.filter((f) => !now.split(/\s+/).includes(f));
  return add.length ? Object.assign({}, env, { NODE_OPTIONS: [now, ...add].filter(Boolean).join(' ') }) : env;
}

/** Los enlaces temporales que dejó un `pointLink` cortado al lado de `at` (los saca la reparación). */
function strayTempLinks(at) {
  const dir = path.dirname(at), base = `${path.basename(at)}${TMP_LINK_MARK}`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => n.startsWith(base)).map((n) => path.join(dir, n)).filter(isLink);
}

module.exports = {
  PLACE_NAME, LEGACY_PLACE_NAME, OWN_DIR_NAME, TyconHomeError, ownRootOf,
  placePath, legacyPlacePath, isHarnessClone, resolvePlace, claudeDir,
  harnessDir, stateDir, configFile, backupsDir, installedSkillsDir, maintainedDir, dashboardDir, home, ownPaths, isReleaseMachine, maintainedPath,
  harnessNode,
  maintainersClone,
  linksMode, isLink, linkTarget, makeLink, removeLink, pointLink, strayTempLinks, keepLinkPathsEnv,
  ownStateDir, legacyStateDir, legacyConfigFile, livesInOwnHome, ownHomeStale, dropStaleOwnHome, adoptOwnHome, stateDirs,
};
