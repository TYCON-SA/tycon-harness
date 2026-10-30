#!/usr/bin/env node
'use strict';
/**
 * private-tree.js — el árbol que mide el portón en el repo privado ADELGAZADO.
 *
 * El privado adelgazado (`.tycon/internal-forms.json` con `layout: thin`, y su `scripts/ci/overlay-harness.js`) no trae
 * lo que es del público. Medido solo, sus suites cargaban código que no está, salían ausentes las del público y las de
 * `agent-skills` corrían sobre el arnés INSTALADO (`~/.claude/agent-skills`): el verde no decía nada de la rama
 * (medido sobre el privado real: 21 rojas, 241 ausentes). El portón mide en cambio el árbol que miden la validación de cada
 * pedido y los nocturnos: lo privado con el público de la rama debajo.
 *
 * Cómo se arma, en una carpeta que da quien llama (y que borra él, también si la corrida se corta):
 *   1. El público: el repo hermano declarado en `.tycon/advisors.yaml → evidence.companion_repos`, en el worktree de la
 *      rama de la story si existe (el criterio de lib/companion-repos.js), que traiga `version.json` y `scripts/`. Si la
 *      carpeta encontrada no está en la rama de la story (la que está al lado: el main local de un clon que nadie pone al
 *      día, la rama de otra sesión), debajo va la versión del servidor, su `origin/main`, sin su disco, y la story no
 *      tocó nada del público (`source: server`). Sin `origin/main` en esa carpeta, lo que hay (`source: disk`).
 *   2. Cada repo se clona ahí (`git clone --shared`, con su historia: varias suites comparan contra commits viejos) en su
 *      HEAD, y lo que su disco tiene sin commitear (cambiado, nuevo sin ignorar, borrado) se copia encima y queda en un
 *      commit local: el portón corre antes del commit, y desde HEAD mediría lo viejo. Nunca se superpone sobre el
 *      checkout de la story: el guion de superposición deja un commit en el repo que recibe.
 *      Su `origin/*` es el `origin/*` del repo de origen, si lo tiene: el de lo que está en el servidor.
 *   3. `scripts/ci/overlay-harness.js --after-cut --stale warn [--team-from <clon del perfil>]` del privado pone el
 *      público encima del clon del privado. El clon del perfil del equipo es `HARNESS_TEAM_DIR` si está; si no, el que
 *      la máquina declara en `paths.team` de su configuración (`harness.js config set paths.team`), si es un clon del
 *      perfil (ver teamLayer).
 *
 * CLI:
 *   node private-tree.js detect <repo>                       → sale 0 si es el privado adelgazado, 10 si no, 4 si su
 *                                                              lista no se deja leer o le falta el guion (el motivo)
 *   node private-tree.js build <repo> <story|-> <carpeta>    → imprime el JSON del árbol; sale 4 sin público (no se
 *                                                              corre nada), 1 si no se pudo armar (el motivo en stderr)
 *   node private-tree.js touched <repo> <público|-> <story|-> <salida.json>   (`-`: debajo fue la versión del servidor)
 *        → lo tocado en los dos repos, en las rutas del árbol (el formato de touched-files.js, más `bases`: la base de
 *          cada repo para contar las líneas tocadas); siempre sale 0
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FORMS = path.join('.tycon', 'internal-forms.json');
const OVERLAY = path.join('scripts', 'ci', 'overlay-harness.js');

class NoPublic extends Error {}
// La salida de `detect` cuando el repo NO es el privado adelgazado. No es 1: es lo que da node al caerse.
const NOT_THIN = 10;

// Lanzado desde un gancho de git, el ambiente trae GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE del repo real: con ellos, el
// `add` y el `commit` del clon caerían en ese repo. Cada comando de acá apunta con -C y nada más.
const SIN_GIT_DEL_LLAMADOR = (() => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) delete e[k];
  return e;
})();

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env || SIN_GIT_DEL_LLAMADOR,
    maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]} no se pudo ejecutar en ${cwd} (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} en ${cwd}: ${(r.stderr || '').trim().split('\n')[0] || `salió ${r.status}`}`);
  return r.stdout;
}
const lista0 = (s) => s.split('\0').filter(Boolean);

/**
 * ¿Es el privado adelgazado? → { thin, problem }. Lo es con la lista en `layout: thin` y el guion que pone el público
 * encima. Una lista que no se deja leer, o que dice `thin` sin el guion, no es «no lo es»: medir solo ese repo leería el
 * arnés instalado (el defecto que este guion corrige), así que vuelve el motivo y el portón frena. Sin lista, o con la lista
 * de formas de antes (sin `layout`), es otro repo.
 */
function detectThin(repo) {
  const lista = path.join(repo, FORMS);
  if (!fs.existsSync(lista)) return { thin: false, problem: null };
  let layout;
  try { layout = JSON.parse(fs.readFileSync(lista, 'utf8')).layout; } catch (e) {
    return { thin: false, problem: `no pude leer ${FORMS} (${e.message}): no sé si es el privado adelgazado, y medirlo solo leería el arnés instalado` };
  }
  if (layout !== 'thin') return { thin: false, problem: null };
  if (!fs.existsSync(path.join(repo, OVERLAY))) {
    return { thin: false, problem: `${FORMS} dice que es el privado adelgazado pero falta ${OVERLAY}: no puedo poner el público debajo, y medirlo solo leería el arnés instalado` };
  }
  return { thin: true, problem: null };
}
const isThinPrivate = (repo) => detectThin(repo).thin;

/** El público que va debajo: el primer hermano declarado (en la rama de la story) que trae version.json y scripts/. */
function findPublic(repo, story) {
  const { companionRoots } = require('./companion-repos.js');
  const faltan = [];
  const roots = companionRoots(repo, story || null, { onMissing: (nombre) => faltan.push(nombre) });
  const base = roots.find((r) => fs.existsSync(path.join(r, 'version.json')) && fs.existsSync(path.join(r, 'scripts')));
  if (!base) {
    const visto = roots.length ? `los hermanos declarados (${roots.join(', ')}) no traen version.json y scripts/` : 'no hay un repo hermano declarado';
    throw new NoPublic(`no encontré el público para poner debajo del privado adelgazado: ${visto}${faltan.length ? `; declarados y no en disco: ${faltan.join(', ')}` : ''} (.tycon/advisors.yaml → evidence.companion_repos). Sin él, medir el privado solo da ausentes y lee el arnés instalado: no corro nada`);
  }
  let rama = null;
  try { rama = git(base, ['symbolic-ref', '-q', '--short', 'HEAD']).trim() || null; } catch (_e) { rama = null; }
  // Del público vale la rama de la story; si no la tiene, lo que está en el servidor, no la carpeta que haya al lado.
  const { ramaDe, ramaNombraLaStory, numeroDeLaStory } = require('./companion-repos.js');
  const ramaPrivada = ramaDe(repo);
  const deLaStory = !!rama && rama !== 'main' && (rama === ramaPrivada || ramaNombraLaStory(rama, numeroDeLaStory(story || null)));
  let servidor = null;
  if (!deLaStory) {
    const leer = () => { try { return git(base, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/main^{commit}']).trim() || null; } catch (_e) { return null; } };
    // El origin/main de un clon que nadie pone al día está tan atrás como su main: se trae antes, con un tope y sin
    // pedir credenciales. Sin red, el que había (el renglón del portón dice su fecha).
    if (leer()) {
      spawnSync('git', ['-C', base, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { stdio: 'ignore',
        timeout: 30000, env: { ...SIN_GIT_DEL_LLAMADOR, GIT_TERMINAL_PROMPT: '0' } });
    }
    servidor = leer();
  }
  if (servidor) {
    let fecha = null;
    try { fecha = git(base, ['log', '-1', '--format=%cI', servidor]).trim() || null; } catch (_e) { fecha = null; }
    return { root: base, branch: rama, commit: servidor, date: fecha, source: 'server' };
  }
  return { root: base, branch: rama, commit: git(base, ['rev-parse', 'HEAD']).trim(), source: deLaStory ? 'story' : 'disk' };
}

/**
 * Clona `src` en `dest` en su HEAD y le pone encima lo que su disco tiene sin commitear (en un commit local). Con `at`,
 * en ese commit y sin el disco: la versión del servidor.
 */
function cloneWithDisk(src, dest, { at = null } = {}) {
  const head = at || git(src, ['rev-parse', 'HEAD']).trim();
  git(path.dirname(dest), ['clone', '-q', '--shared', '--no-checkout', src, dest]);
  git(dest, ['checkout', '-q', '--detach', head]);
  // El origin/main del clon sería la rama main local del repo de origen, que puede estar atrás del servidor: las suites
  // que cortan «lo propio de la rama» en `merge-base origin/main HEAD` verían como propio lo que ya entró a main. Con
  // --prune salen antes las ramas locales copiadas: una `story` local chocaría con una `story/x` del servidor.
  if (git(src, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/']).trim()) {
    git(dest, ['fetch', '-q', '--prune', src, '+refs/remotes/origin/*:refs/remotes/origin/*']);
  }
  if (at) return { head, uncommitted: false };
  // modificados y borrados respecto de HEAD (índice o disco), y lo nuevo que el .gitignore no ignora
  const cambiados = lista0(git(src, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']));
  const nuevos = lista0(git(src, ['ls-files', '--others', '--exclude-standard', '-z']));
  const omitidos = [];
  for (const rel of [...new Set([...cambiados, ...nuevos])]) {
    const de = path.join(src, rel);
    const a = path.join(dest, rel);
    const st = lstatOrNull(de);
    const enDestino = lstatOrNull(a);
    if (!st) { if (enDestino) fs.rmSync(a, { recursive: true, force: true }); continue; }
    if (st.isDirectory()) {
      // Un archivo de HEAD que en el disco es una carpeta: el archivo sale (lo que la carpeta trae entra como nuevo).
      // Una carpeta en los dos lados es un submódulo o un repo anidado: no es un archivo de esta rama, y se dice.
      if (enDestino && !enDestino.isDirectory()) fs.rmSync(a, { force: true });
      else omitidos.push(rel);
      continue;
    }
    sinTropiezos(dest, rel);
    fs.rmSync(a, { recursive: true, force: true });   // una carpeta de HEAD que en el disco es un archivo
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(de), a);
    else { fs.copyFileSync(de, a); fs.chmodSync(a, st.mode & 0o777); }
  }
  const sucio = git(dest, ['status', '--porcelain']).trim() !== '';
  if (sucio) {
    git(dest, ['add', '-A', '-f']);
    git(dest, ['-c', 'user.name=test-gate', '-c', 'user.email=test-gate@localhost', 'commit', '-q', '--no-verify', '-m',
      'los cambios sin commit de la rama (foto del portón de pruebas; no se empuja)']);
  }
  for (const rel of omitidos) process.stderr.write(`[test-gate] ⚠️  ${path.basename(src)}: ${rel} es una carpeta con su propio git (un submódulo o un repo anidado): sus cambios no entran al árbol que se mide\n`);
  return { head, uncommitted: sucio };
}

/** El lstat, o null si NO EXISTE. Otro error (permisos, disco) sube: leerlo como «borrado» sacaría el archivo del árbol callado. */
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw new Error(`no pude mirar ${p} (${(e && e.code) || e}): no lo doy por borrado`);
  }
}

/** Que el camino a `rel` dentro de `dest` sea de carpetas: un archivo de HEAD donde el disco tiene una carpeta, sale. */
function sinTropiezos(dest, rel) {
  const partes = rel.split('/').slice(0, -1);
  let actual = dest;
  for (const p of partes) {
    actual = path.join(actual, p);
    const st = lstatOrNull(actual);
    if (st && !st.isDirectory()) fs.rmSync(actual, { force: true });
  }
  fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
}

/**
 * El clon del repo del perfil del equipo que va como capa del equipo (`--team-from`). → `{ dir, source, problem }`.
 * `source`: 'env' (`HARNESS_TEAM_DIR`, que gana siempre y se usa tal cual), 'machine' (`paths.team` de la configuración
 * de la máquina) o null (nada declarado). Sin esa capa, las suites que leen el perfil o el texto del alta dan rojo en el
 * árbol armado, y la capa INSTALADA no sirve: no trae el texto del alta. Lo declarado que no sirve no se usa y vuelve en
 * `problem`, para que el portón lo diga: nunca se pone otra cosa en silencio, y no frena la corrida. La configuración
 * trae un permiso en texto plano: `problem` nunca cita su contenido. Nunca tira.
 */
function teamLayer({ env = process.env } = {}) {
  const fromEnv = (env.HARNESS_TEAM_DIR || '').trim();
  if (fromEnv) return { dir: fromEnv, source: 'env', problem: null };
  const none = (problem = null) => ({ dir: null, source: problem ? 'machine' : null, problem });
  let file;
  try { file = machineConfigFile(env); } catch (e) { return none(`no pude ubicar la configuración de la máquina (${e.message}): no sé si declara paths.team`); }
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return none();
    return none('la configuración de la máquina (config.json del arnés) no se puede leer: no sé si declara paths.team');
  }
  const raw = j && typeof j === 'object' && j.paths && typeof j.paths === 'object' ? j.paths.team : undefined;
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return none();
  const bad = (why) => ({ dir: null, source: 'machine', problem: `la máquina declara paths.team y no sirve: ${why}` });
  if (!path.isAbsolute(v)) return bad('paths.team no es una ruta absoluta');
  let st = null;
  try { st = fs.statSync(v); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return bad(`paths.team nombra una carpeta que no está (${v})`);
  if (!fs.existsSync(path.join(v, '.git'))) return bad(`${v} no es un clon de git`);
  // lo que el guion de superposición exige al clon del perfil (--team-from): el perfil y el texto del alta
  if (!['team-profile.json', 'perfil-equipo.json'].some((n) => fs.existsSync(path.join(v, n)))) return bad(`${v} no trae team-profile.json: no es un clon del repo del perfil del equipo`);
  let alta = [];
  try { alta = fs.readdirSync(path.join(v, 'onboarding')).filter((n) => n.endsWith('.md')); } catch (_) { alta = []; }
  if (!alta.length) return bad(`${v} no trae el texto del alta (onboarding/*.md)`);
  return { dir: v, source: 'machine', problem: null };
}

/**
 * La configuración de la máquina: la ruta que da tycon-home.js (`ownPaths().config`) si está al lado, como en el repo
 * unido; en un clon de skills aparte, `TYCON_HOME` o `~/.tycon`, con su misma regla.
 */
function machineConfigFile(env) {
  const lib = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
  if (fs.existsSync(lib)) return require(lib).ownPaths({ env }).config;
  const h = env.TYCON_HOME !== undefined ? String(env.TYCON_HOME).trim() : path.join(require('os').homedir(), '.tycon');
  if (!h || !path.isAbsolute(h)) throw new Error('TYCON_HOME no es una ruta absoluta');
  return path.join(h, 'config.json');
}

function build(repo, story, dir) {
  const t0 = Date.now();
  const pub = findPublic(repo, story);
  const arbol = path.join(dir, 'arbol');
  const publico = path.join(dir, 'publico');
  const priv = cloneWithDisk(repo, arbol);
  const pubFoto = cloneWithDisk(pub.root, publico, { at: pub.source === 'server' ? pub.commit : null });
  const layer = teamLayer();
  const team = layer.dir || '';
  const report = path.join(dir, 'superpuesto.json');
  const args = [path.join(arbol, OVERLAY), '--after-cut', '--stale', 'warn', ...(team ? ['--team-from', team] : []),
    '--repo', arbol, '--from', publico, '--report', report];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: SIN_GIT_DEL_LLAMADOR,
    maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const motivo = r.error ? r.error.message : `${(r.stderr || r.stdout || '').trim().split('\n').pop() || `salió ${r.status}`}`;
    throw new Error(`no pude poner el público (${pub.root}) debajo del privado: ${motivo}`);
  }
  // la superposición deja el público en un commit local: su punta commiteada queda como rama del servidor, así el freno
  // de guiones (on-bash-write-gate.js) reconoce como publicado lo que llegó igual a ella, y no lo sin commit
  fs.appendFileSync(path.join(arbol, '.git', 'objects', 'info', 'alternates'), `${path.join(publico, '.git', 'objects')}\n`);
  git(arbol, ['update-ref', 'refs/remotes/publico/punta', pubFoto.head]);
  return {
    tree: arbol, skills: path.join(arbol, 'skills'),
    base: { ...pub, uncommitted: pubFoto.uncommitted },
    private: { root: repo, commit: priv.head, uncommitted: priv.uncommitted },
    team: team || null, teamSource: layer.source, teamProblem: layer.problem, seconds: Math.round((Date.now() - t0) / 100) / 10,
    overlay: (r.stdout || '').trim().split('\n').pop() || '',
  };
}

/** Lo tocado en un repo: la base de coverage-base.js (con la bifurcación si no hay marcador de este repo) y touched-files. */
function touchedIn(repo, story) {
  const base = spawnSync(process.execPath, [path.join(__dirname, 'coverage-base.js'), repo],
    { encoding: 'utf8', env: { ...process.env, TYCON_TEST_GATE_CROSS_REPO: '1' }, cwd: repo });
  let ref = null, source = null, sinBase = null;
  try { const j = JSON.parse(base.stdout); ref = j.ref; source = j.source; } catch (e) {
    // sin base, touched-files contesta «no sé» (se corre sin acotar); el motivo viaja en `reason`
    sinBase = `coverage-base.js no dio una base en ${repo} (salió ${base.status}: ${(base.stderr || e.message || '').trim().split('\n')[0]})`;
  }
  const { touchedFiles } = require('./touched-files.js');
  let r;
  try {
    r = touchedFiles({ repo, storyPath: story || '', baseRef: ref, baseSource: source });
  } catch (e) {
    r = { known: false, files: [], sources: {}, reason: `touched-files falló en ${repo}: ${e.message}` };
  }
  if (sinBase) r.reason = r.reason ? `${sinBase}; ${r.reason}` : sinBase;
  return { ...r, base: { repo, ref, source } };
}

function touchedBoth(repo, pub, story) {
  const a = touchedIn(repo, story);
  // `pub` nulo: debajo fue la versión del servidor, y la story no tocó nada del público
  const b = pub ? touchedIn(pub, story) : { known: true, files: [], sources: {}, base: null };
  const known = a.known && b.known;
  const reason = known ? null : [!a.known && `en el privado: ${a.reason}`, !b.known && `en el público: ${b.reason}`].filter(Boolean).join('; ');
  // `bases`: contra qué commit de cada repo se cuentan las líneas tocadas (test-gate-report.js): en el árbol armado, la
  // base del privado sola contaba todo el público como tocado
  return { known, files: [...new Set([...(a.files || []), ...(b.files || [])])], sources: { private: a.sources, public: b.sources },
    bases: [a.base, b.base].filter(Boolean), reason };
}

module.exports = { isThinPrivate, detectThin, findPublic, cloneWithDisk, teamLayer, build, touchedBoth, NoPublic };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const sinStory = (s) => (s && s !== '-' ? path.resolve(s) : null);
  try {
    if (cmd === 'detect' && rest[0]) {
      const d = detectThin(path.resolve(rest[0]));
      if (d.problem) { process.stderr.write(`[test-gate] 🔴 ${d.problem}: no corro nada\n`); process.exit(4); }
      // «no es» tiene su propio código: un 1 (node que se cae, un error al cargar) no se lee como «no es»
      process.exit(d.thin ? 0 : NOT_THIN);
    }
    if (cmd === 'build' && rest.length === 3) {
      process.stdout.write(`${JSON.stringify(build(path.resolve(rest[0]), sinStory(rest[1]), path.resolve(rest[2])))}\n`);
      process.exit(0);
    }
    if (cmd === 'touched' && rest.length === 4) {
      fs.writeFileSync(rest[3], `${JSON.stringify(touchedBoth(path.resolve(rest[0]), rest[1] === '-' ? null : path.resolve(rest[1]), sinStory(rest[2])))}\n`);
      process.exit(0);
    }
    process.stderr.write('uso: private-tree.js detect <repo> · build <repo> <story|-> <carpeta> · touched <repo> <público|-> <story|-> <salida.json>\n');
    process.exit(2);
  } catch (e) {
    process.stderr.write(`[test-gate] 🔴 ${e.message}\n`);
    // el detector que se cae es «no sé» (4), como la lista rota: nunca «no es»
    process.exit(e instanceof NoPublic || cmd === 'detect' ? 4 : 1);
  }
}
