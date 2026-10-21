'use strict';
// repoint.js — la llave `update.skills_source`: re-apuntar el clon viejo de agent-skills al repo unificado, deshacerlo,
// y la pregunta «¿esta versión trae las skills?».
//
// Los dos repos internos —el arnés y agent-skills— se unieron en uno, con las dos historias
// enteras. Cada máquina del equipo sigue con sus DOS clones: el del arnés, que trae `skills/` y `agents/`,
// y `~/.claude/agent-skills`, del que la máquina lee las skills. Mudar cada máquina a un solo árbol es mover miles de
// archivos sin versionar (lo propio del dev, las skills de terceros, los stash): queda fuera de esto. Re-apuntar es un cambio de
// configuración: como la historia está unida, el clon viejo avanza EN LÍNEA RECTA al repo unificado y nada se mueve en
// el disco. Es el único paso que el equipo nota, y se deshace con uno: la llave de vuelta en `separate`.
//
// La ida (`forward`), con la llave en `unified` y la máquina en `managed`, desde `startup` o `update`:
//   1. Sólo lecturas, y si algo no cierra NO SE TOCA NADA y se nombra la causa con su comando: el clon del arnés ya trae
//      las skills, está en `main` y sin commits propios; el clon viejo está en `main`, sin commits propios, sin conflictos
//      y sin una vista reducida propia; el repo unificado contesta (la única salida a la red, con el tope de siempre).
//   2. Los commits se traen del CLON DEL ARNÉS de esta máquina, por su carpeta, sin red: es el mismo repo, ya está
//      bajado, y así el clon viejo queda en el MISMO commit que el arnés. (Traerlos del remoto es bajar otra vez el
//      repo entero dentro del tope de red de 15 s: en una máquina con mala conexión no pasaría nunca.)
//   3. Con el commit de destino ya en el clon: avanza en línea recta (si no, «historia sin unir»); ninguna ruta que
//      llega existe acá sin versionar NI ignorada (git pisa lo ignorado sin avisar); y nada modificado sin commitear
//      choca con lo que llega. Un archivo del dev en el camino frena la mudanza: no se aparta solo.
//   4. Copia de seguridad, la mudanza anotada «en curso» en el estado (con de dónde venía: URL, commit y lo que había
//      en la configuración de git), y recién ahí se mueve: la vista reducida, `merge --ff-only`, el `origin`, y la ref
//      de lo traído. Si un paso falla se deshace lo hecho; si la sesión muere en el medio, el arranque siguiente
//      encuentra la mudanza «en curso» y la deshace antes de decidir nada.
//
// La vista reducida: el clon re-apuntado muestra sólo `agents/`, `skills/`, `packs/` y los archivos de la
// raíz, así nadie corre el instalador desde ahí (duplicaría los hooks). Es `sparse-checkout` SIN «cono», puesto por
// configuración y aplicado con `git sparse-checkout reapply`, y se pone ANTES del merge. Las tres decisiones salen de
// medirlo (git 2.50): (a) en modo cono, la próxima vez que la vista se vuelve a aplicar sobre el clon ya
// re-apuntado (`git sparse-checkout reapply`, o `set`), git BORRA las carpetas de afuera de la vista que el repo sigue y
// que sólo tienen archivos ignorados —el `.advisors/` de un dev, entero—; sin cono sólo saca lo que sigue; (b) `git
// sparse-checkout set` y `disable` prenden `extensions.worktreeConfig` y escriben `.git/config.worktree`, y `disable` no
// lo deshace; por configuración, la vuelta deja `.git/config` byte a byte como estaba; (c) con la vista puesta antes, el
// merge no escribe ni mira ninguna ruta de afuera: los miles de archivos del arnés no pasan por el disco.
// Dónde se lee y dónde se escribe esa configuración: `.git/config.worktree` LE GANA a `.git/config`, y es donde escriben
// los comandos estándar. Por eso «¿hay una vista prendida?» se contesta con el valor EFECTIVO (`git config --get`), nunca
// con el de `.git/config` solo; y la llave se escribe en el alcance que manda —`config.worktree` si el clon ya tiene ahí
// esa clave, `.git/config` si no—, guardando lo que había en cada uno para dejarlo igual a la vuelta. Leerla y escribirla
// sólo en `.git/config` deja tres agujeros: una vista propia hecha
// con `git sparse-checkout set` no se detecta y se pisa; con `core.sparseCheckout=false` en `config.worktree` (lo
// que deja cualquier `sparse-checkout disable`) `reapply` muere en la ida y al deshacer, y la mudanza queda «en curso»
// para siempre; y el remedio que nombra el aviso (`git sparse-checkout disable`) no destraba.
//
// La vuelta (`back`), con la llave en `separate` y la mudanza registrada: mira que el remoto viejo CONTESTE (si no, no
// toca nada y lo dice: se reintenta en el arranque siguiente) y que nada del dev esté en una ruta que vuelve —sin
// versionar o ignorado: `reset --hard` lo pisa sin avisar, igual que el merge de la ida—, y deshace con `undo`: la rama
// `main` al commit guardado (`sources.revert`: stash propio, con su índice, y `reset --hard`, nunca `checkout` de un
// commit), el clon mostrando todo, el `origin` en su URL, las refs que la ida movió, y el estado sin rastro. Ida y vuelta
// dejan la máquina byte a byte como estaba. `undo` no deshace nada sobre otra rama que `main` ni encima de un archivo
// del dev: es el mismo `undo` de una ida que falló a mitad de camino y de una mudanza que quedó «en curso».
//
// Sobre QUÉ clon: que el estado liste la fuente `agent_skills` no prueba
// que haya un clon aparte. Si `~/.claude/agent-skills` pasó a ser un enlace al clon del arnés (el dev borró el clon viejo
// y el aplicador lo enlazó), la ida le pondría la vista reducida AL CLON DEL ARNÉS —desaparecería `scripts/`, con este
// programa adentro— y la vuelta le haría `reset --hard` al commit viejo de agent-skills. Antes de decidir nada se
// compara ese clon con el del arnés (`sameClone`: la ruta real y el `.git` de cada uno): si es el mismo, no se toca, se
// dice, y el remedio es `harness.js install`, que vuelve a detectar las fuentes. Y el estado se contrasta con el clon de
// verdad en cada pasada: una mudanza «aplicada» cuyo clon ya no sigue al repo unificado (lo volvieron a clonar del repo
// viejo, o le cambiaron el `origin` a mano) se suelta del estado — el clon manda.
//
// Lo que NO se reintenta: una causa permanente (otra rama, commits propios, un archivo que choca) queda anotada con
// una huella de lo que se miró; mientras la huella no cambie, el arranque no vuelve a intentar (ni sale a la red) y el
// aviso sigue. `harness.js update` a mano reintenta siempre. Una causa pasajera —sin red, o un archivo del clon tomado
// por otro programa, lo corriente en Windows— se reintenta en cada arranque.
//
// Dónde queda escrito de dónde venía el clon: en el estado del mecanismo (`repoint.applied.from`) y, la misma
// constancia, dentro del `.git` del clon (`tycon-repoint.json`): el estado se pierde al desinstalar y el clon no.
//
// Núcleo público, sin dependencias; corre también desde la copia fija. Funciones puras respecto del HOME: reciben `env`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SRC = require('./sources.js');

const MAIN = SRC.MAIN_REF;
const VISIBLE = Object.freeze(['agents', 'packs', 'skills']);   // lo que el clon re-apuntado muestra, además de la raíz
const SKILLS_MARK = 'skills/tycon-pipeline';                     // «trae las skills»: el mismo criterio que isSingleRepo
const SPARSE_TEXT = `${['/*', '!/*/', ...VISIBLE.map((d) => `/${d}/`)].join('\n')}\n`;
const SPARSE_ALL = '/*\n';
const NS = 'refs/tycon/repoint';                                 // las refs de trabajo de la mudanza: se borran al salir
const TARGET_REF = `${NS}/target`;
const UPSTREAM_REF = `${NS}/upstream`;
const CLONE_RECORD = 'tycon-repoint.json';                       // la constancia de la mudanza, dentro del .git del clon
const SEED_TIMEOUT_MS = 10 * 60 * 1000;
const TREE_TIMEOUT_MS = 5 * 60 * 1000;
const HARNESS_JS = `node ~/.claude/${require('./place.js').PLACE_NAME}/scripts/setup/harness.js`;   // el lugar
const UPDATE_CMD = `${HARNESS_JS} update`;
const INSTALL_CMD = `${HARNESS_JS} install`;
const OLD_URL = '<URL-del-repo-viejo>';                         // lo que la persona reemplaza en un remedio a mano
const PHRASE = Object.freeze({
  unified: 'la llave pide el repo unificado y este clon sigue en el viejo',
  separate: 'la llave volvió a «separate» y este clon sigue en el repo unificado',
});
// Los avisos que deja esta pieza: cada arranque los vuelve a calcular (harness.js los suma a su lista)
// Lo que dice git cuando no pudo escribir porque OTRO tiene el archivo o el clon (otra sesión, un antivirus, un editor —
// lo corriente en Windows—): es pasajero, y se reintenta en el arranque siguiente. Con `LC_ALL=C`, en inglés
const BUSY = /\.lock\b|unable to unlink|unable to create|Permission denied|resource busy|used by another process/i;
const NOTICE = /^(skills re-apuntadas|skills de vuelta en el repo viejo|la llave pide el repo unificado|la llave volvió a «separate»|la llave update\.skills_source|una mudanza del clon de skills)/;

const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
const zlist = (s) => String(s || '').split('\0').filter(Boolean);
const nowIso = () => new Date().toISOString();
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const sourceOf = (state, name) => ((state && state.sources) || []).find((s) => s && s.name === name) || null;
const inView = (p) => !String(p).includes('/') || VISIBLE.includes(String(p).split('/')[0]);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s);
// Un valor que va a git como argumento suelto (una URL, una carpeta) y empieza con «-» se leería como una OPCIÓN:
// `git ls-remote --upload-pack=<comando> …` corre ese comando (medido). Esos valores salen del estado y de la constancia
// del clon —archivos que cualquiera puede editar—: van detrás del separador `--` y, además, uno que empieza con «-» se
// rechaza con su causa antes de llegar a git
const dashed = (v) => typeof v === 'string' && v.trim().startsWith('-');
const dashedText = (what, v) => `${what} («${v}») empieza con «-»: git la leería como una opción — no la uso`;

// ── ¿trae las skills? (la guarda) ──────────────────────────────────────────────────────────────────────────
// Las dos preguntas de la guarda contestan en TRES estados, con los mismos nombres que sus mellizas de los respaldos de
// arranque (`skills_at` de `bootstrap-fallback.sh` y `.ps1`): `yes` (las trae) · `no` (git contestó que no) · `unknown`
// (no se pudo mirar; `reason` dice por qué). «No pude mirar» nunca es «no»: quien pregunta no avanza y lo dice (si
// «no pude leer el árbol de lo instalado» se leyera como «de acá no salen las
// skills», la guarda se saltearía y una punta sin skills seguiría su camino). `hasSkills` y `providesSkills` son la misma
// respuesta en `true` / `false` / `null`, como `brings` en `guides-heal.js`.

/** ¿El árbol de ese commit trae `skills/tycon-pipeline`? @returns {{ status: 'yes'|'no'|'unknown', reason: string|null }} */
function skillsAt(dir, rev, { env } = {}) {
  const r = SRC.git(dir, ['ls-tree', '-d', '--name-only', `${rev}^{tree}`, '--', SKILLS_MARK], { env, timeout: 10000 });
  if (!r.ok) return { status: 'unknown', reason: r.timedOut ? 'git no contestó a tiempo' : (firstLine(r.err) || `git salió ${r.status}`) };
  return { status: r.out.split('\n').map((l) => l.trim()).includes(SKILLS_MARK) ? 'yes' : 'no', reason: null };
}
/** Lo mismo, en `true` / `false` / `null` = no se pudo mirar (no es «no»). */
function hasSkills(dir, rev, opts) {
  const at = skillsAt(dir, rev, opts);
  return at.status === 'unknown' ? null : at.status === 'yes';
}

/**
 * ¿De esa fuente salen las skills de esta máquina? La de agent-skills, siempre (el clon viejo, re-apuntado o no). La
 * del arnés, sólo cuando no hay un clon aparte —la máquina de un solo árbol— y lo instalado trae las skills. En la
 * máquina de dos clones el arnés NO lo es: tiene que poder seguir a `main` aunque `main` vuelva a un árbol anterior a
 * la unión (el retorno previo a la llave), y las skills siguen en el otro clon.
 * @returns {{ status: 'yes'|'no'|'unknown', reason: string|null }}  `unknown`: no se pudo leer el árbol de lo instalado
 */
function skillsFrom(state, src, { env } = {}) {
  if (!src) return { status: 'no', reason: null };
  if (src.name === 'agent_skills') return { status: 'yes', reason: null };
  if (sourceOf(state, 'agent_skills')) return { status: 'no', reason: null };
  const at = skillsAt(src.dir, 'HEAD', { env });
  return at.status === 'unknown' ? { status: 'unknown', reason: `no pude leer el árbol de lo instalado (HEAD) en ${src.dir} (${at.reason})` } : at;
}
/** Lo mismo, en `true` / `false` / `null` = no se pudo mirar (no es «no salen»: quien pregunta no avanza). */
function providesSkills(state, src, opts) {
  const from = skillsFrom(state, src, opts);
  return from.status === 'unknown' ? null : from.status === 'yes';
}

// ── ¿qué clon es? ────────────────────────────────────────────────────────────────────────────────────────────────────

// Cada pregunta de esta sección contesta en TRES estados, y «no pude mirar» nunca es «no»: con `sameClone` en dos, si
// git no contesta a tiempo (o un `.git` no se deja leer) la respuesta sería «no es el mismo clon», y con
// `~/.claude/agent-skills` enlazado al clon del arnés por una ruta que no es letra por letra la misma (otra caja) la
// vuelta le haría `reset --hard` al clon del arnés, al commit viejo de agent-skills.

/** La ruta real de una carpeta: `{ status: 'ok', path }` · `absent` (no existe) · `unknown` (no se pudo resolver:
 *  permisos, un disco que no responde; `reason` dice cuál y por qué). Un ENOENT es una respuesta; un EACCES, no. */
function realState(p) {
  try { return { status: 'ok', path: fs.realpathSync(p), reason: null }; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'absent', path: null, reason: null };
    return { status: 'unknown', path: null, reason: `${p} (${(e && (e.code || e.message)) || e})` };
  }
}
/** ¿Hay un `.git` en esa carpeta o en alguna de sus madres? `false` es una respuesta (no hay ninguno: no es un clon);
 *  `null`, no (no se pudo mirar alguna). */
function underAnyRepo(at) {
  for (let p = at; ; p = path.dirname(p)) {
    try { fs.lstatSync(path.join(p, '.git')); return true; } catch (e) { if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null; }
    if (path.dirname(p) === p) return false;
  }
}
/** La identidad de un repo en el disco: la ruta real de su `.git` y el archivo que hay ahí (dispositivo e inodo: en un
 *  disco que no distingue mayúsculas, la misma carpeta escrita con otra caja es otra ruta y el mismo inodo). El `.git`
 *  COMÚN: un árbol de trabajo enlazado comparte remotos y ramas con su repo.
 *  @returns {{ status: 'ok'|'none'|'unknown', path?: string, inode?: string|null, reason?: string }}  `none`: la carpeta
 *    no existe o no hay un `.git` en ninguna carpeta de su ruta (no es un clon); `unknown`: git no contestó y no se sabe */
function repoIdentity(dir, env) {
  const r = SRC.git(dir, ['rev-parse', '--git-common-dir'], { env, timeout: 10000 });
  if (!r.ok || !r.out) {
    const at = realState(dir);
    if (at.status === 'absent' || (at.status === 'ok' && underAnyRepo(at.path) === false)) return { status: 'none' };
    return { status: 'unknown', reason: `git rev-parse --git-common-dir en ${dir}: ${r.timedOut ? 'git no contestó a tiempo' : (firstLine(r.err) || `git salió ${r.status}`)}` };
  }
  const gitAt = path.resolve(dir, r.out);
  try {
    const at = fs.realpathSync(gitAt);
    const st = fs.statSync(at);
    return { status: 'ok', path: at, inode: st.ino ? `${st.dev}:${st.ino}` : null };
  } catch (e) { return { status: 'unknown', reason: `${gitAt} (${(e && (e.code || e.message)) || e})` }; }
}
/**
 * ¿El «clon de skills» que lista el estado es, en el disco, el clon del arnés (o una carpeta de adentro)? Pasa cuando el
 * dev borra su clon viejo y el aplicador enlaza `~/.claude/agent-skills` al clon del arnés: el estado sigue listando la
 * fuente hasta que `install` vuelve a detectarlas. Sobre ese clon no se re-apunta ni se deshace NADA (ver la cabecera).
 * Se compara por la ruta real y por el `.git` de cada uno. Tres respuestas: `same` · `distinct` (una carpeta que no
 * existe, o que no es un clon, no es el otro clon: lo que sigue se niega solo) · `unknown` (no se pudo mirar; `reason`):
 * con ésa no se re-apunta, no se vuelve, no se deshace ni se reconoce nada.
 * @returns {{ status: 'same'|'distinct'|'unknown', reason: string|null }}
 */
function cloneRelation(skills, harness, env) {
  const distinct = { status: 'distinct', reason: null };
  if (!skills || !skills.dir || !harness || !harness.dir) return distinct;
  const a = realState(skills.dir); const b = realState(harness.dir);
  const blind = [a, b].find((x) => x.status === 'unknown');
  if (blind) return { status: 'unknown', reason: `no pude resolver la carpeta ${blind.reason}` };
  if (a.status === 'absent' || b.status === 'absent') return distinct;
  if (a.path === b.path || a.path.startsWith(b.path + path.sep)) return { status: 'same', reason: null };
  const ia = repoIdentity(skills.dir, env); const ib = repoIdentity(harness.dir, env);
  const unread = [ia, ib].find((x) => x.status === 'unknown');
  if (unread) return { status: 'unknown', reason: unread.reason };
  if (ia.status === 'none' || ib.status === 'none') return distinct;
  return ia.path === ib.path || Boolean(ia.inode && ia.inode === ib.inode) ? { status: 'same', reason: null } : distinct;
}
/** Lo mismo, en `true` / `false` / `null` = no se pudo mirar (no es «no es el mismo»). */
function sameClone(skills, harness, env) {
  const rel = cloneRelation(skills, harness, env);
  return rel.status === 'unknown' ? null : rel.status === 'same';
}

// ── la vista reducida ────────────────────────────────────────────────────────────────────────────────────────────────

const SPARSE_KEY = 'core.sparseCheckout';
const CONE_KEY = 'core.sparseCheckoutCone';

/**
 * Un valor de la configuración de git del clon: en UN alcance (`local` = `.git/config`, `worktree` =
 * `.git/config.worktree`) o, sin alcance, el EFECTIVO (el que git va a usar). `{ ok, value }`: `value` es `null` cuando
 * la clave no está (git sale 1 y callado); `ok: false` cuando no se pudo mirar — que no es «no está».
 */
function readConfig(dir, scope, key, env, { bool = false } = {}) {
  const r = SRC.git(dir, ['config', ...(scope ? [`--${scope}`] : []), ...(bool ? ['--type=bool'] : []), '--get', key], { env, timeout: 10000 });
  if (r.ok) return { ok: true, value: r.out };
  return r.status === 1 && !r.timedOut && !r.err ? { ok: true, value: null } : { ok: false, value: null };
}
/** ¿El clon tiene prendida la configuración por árbol de trabajo (`extensions.worktreeConfig`)? La prenden
 *  `git sparse-checkout set` y `disable`; sin ella `.git/config.worktree` no se lee. `null` = no se pudo mirar. */
function worktreeScope(dir, env) {
  const r = readConfig(dir, 'local', 'extensions.worktreeConfig', env, { bool: true });
  return r.ok ? r.value === 'true' : null;
}
/** ¿La vista reducida está prendida DE VERDAD? El valor efectivo de `core.sparseCheckout`: `true` / `false` / `null` =
 *  no se pudo mirar. Nunca el de `.git/config` solo (ver la cabecera). */
function sparseEffective(dir, env) {
  const r = readConfig(dir, null, SPARSE_KEY, env, { bool: true });
  return r.ok ? r.value === 'true' : null;
}
function sparseFile(dir, env) {
  const r = SRC.git(dir, ['rev-parse', '--git-path', 'info/sparse-checkout'], { env, timeout: 10000 });
  return r.ok && r.out ? path.resolve(dir, r.out) : null;
}
/** Las dos claves de la vista en un alcance: `{ value, cone }`, o `null` si no se pudo mirar. */
function scopedView(dir, scope, env) {
  const v = readConfig(dir, scope, SPARSE_KEY, env); const c = readConfig(dir, scope, CONE_KEY, env);
  return v.ok && c.ok ? { value: v.value, cone: c.value } : null;
}
/**
 * Cómo está la vista de ese clon ANTES de tocarla: lo que la vuelta tiene que dejar igual. `value` y `cone` son los de
 * `.git/config`; `worktree`, los de `.git/config.worktree` (`null` si el clon no tiene ese archivo prendido); `on`, si
 * la vista está prendida de verdad (el valor efectivo); `file`, el texto de `info/sparse-checkout`. `null` = no se pudo leer.
 */
function sparseBefore(dir, env) {
  const file = sparseFile(dir, env);
  let text = null;
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null; } }
  const perTree = worktreeScope(dir, env);
  const on = sparseEffective(dir, env);
  const local = scopedView(dir, 'local', env);
  const worktree = perTree ? scopedView(dir, 'worktree', env) : null;
  if (perTree === null || on === null || !local || (perTree && !worktree)) return null;
  return { value: local.value, cone: local.cone, worktree, on, file: text };
}
/** Deja `key` en `value` en ESE alcance (o la saca, con `null`). No escribe si ya está así. */
function setScoped(dir, scope, key, value, env) {
  const cur = readConfig(dir, scope, key, env);
  if (!cur.ok) return false;
  if (value === null || value === undefined) return cur.value === null ? true : SRC.git(dir, ['config', `--${scope}`, '--unset', key], { env, timeout: 10000 }).ok;
  return cur.value === value ? true : SRC.git(dir, ['config', `--${scope}`, key, value], { env, timeout: 10000 }).ok;
}
/** Deja `key` valiendo `value` DE VERDAD: lo escribe en el alcance que manda —`config.worktree` si el clon ya tiene ahí
 *  esa clave (le gana a `.git/config`), `.git/config` si no— y comprueba el valor efectivo después. */
function setEffective(dir, key, value, env) {
  const perTree = worktreeScope(dir, env);
  if (perTree === null) return false;
  let scope = 'local';
  if (perTree) {
    const there = readConfig(dir, 'worktree', key, env);
    if (!there.ok) return false;
    if (there.value !== null) scope = 'worktree';
  }
  if (!setScoped(dir, scope, key, value, env)) return false;
  const now = readConfig(dir, null, key, env, { bool: true });
  return now.ok && now.value === value;
}
/** Cuántos archivos que git sigue no se muestran en el clon (la marca «S» de `ls-files -t`): `{ count, reason }`, con
 *  `count: null` si no se pudo listar (`reason` dice por qué). `null` no es cero: quien pregunta no da nada por mostrado. */
function hiddenFiles(dir, env) {
  const listed = SRC.git(dir, ['ls-files', '-t'], { env, timeout: 60000 });
  if (!listed.ok) return { count: null, reason: listed.timedOut ? 'git no contestó a tiempo' : (firstLine(listed.err) || `git salió ${listed.status}`) };
  return { count: listed.raw.split('\n').filter((l) => l.startsWith('S ')).length, reason: null };
}
/** Por qué falló `git sparse-checkout reapply`. La versión de git se nombra sólo si es la causa (un git sin ese comando). */
function reapplyFailure(r) {
  const old = /is not a git command|unknown subcommand|usage: git sparse-checkout/i.test(String(r.err || ''));
  return `git sparse-checkout reapply falló: ${firstLine(r.err) || `salió ${r.status}`}${old ? ' (hace falta git 2.27 o más nuevo)' : ''}`;
}
/** Deja el clon mostrando sólo `VISIBLE` y la raíz. Sin «cono» y por configuración (ver la cabecera). */
function sparseOn(dir, env) {
  const no = (reason) => ({ ok: false, reason });
  const file = sparseFile(dir, env);
  if (!file) return no('no pude ubicar info/sparse-checkout en el clon');
  if (!setEffective(dir, SPARSE_KEY, 'true', env) || !setEffective(dir, CONE_KEY, 'false', env)) return no(`no pude dejar prendida la vista en la configuración de git del clon (${SPARSE_KEY})`);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, SPARSE_TEXT); } catch (e) { return no(`no pude escribir ${file} (${e.code || e.message})`); }
  const r = SRC.git(dir, ['sparse-checkout', 'reapply'], { env, timeout: TREE_TIMEOUT_MS });
  if (!r.ok) return no(reapplyFailure(r));
  return { ok: true, reason: null };
}
/**
 * El clon vuelve a mostrar todo, y la configuración y el archivo de la vista quedan como en `before`. Se puede correr
 * sobre un clon que ya muestra todo —también si alguien apagó la vista a mano en el clon re-apuntado (`git
 * sparse-checkout disable` deja `.git/config` en `true` y `config.worktree` en `false`: ahí no hay nada que volver a
 * mostrar, y pedir `reapply` muere)—. Lo que decide es el valor efectivo y lo que el clon tiene oculto, no `.git/config`.
 * `hidden`: cuántos archivos quedaron sin mostrarse (git no pisa uno que el dev creó en ese lugar): se dice, no es una falla.
 * Si no se pudo CONTAR lo oculto es una falla, con su causa: contarlo como cero saltearía volver a mostrar y
 * la vuelta diría «muestra todo» sin saberlo.
 */
function sparseOff(dir, env, before) {
  const no = (reason) => ({ ok: false, reason, hidden: 0 });
  const uncounted = (h) => no(`no pude contar qué archivos oculta la vista del clon (git ls-files -t: ${h.reason}); sin saberlo la vuelta no se da por terminada`);
  const was = before || { value: null, cone: null, file: null };
  const file = sparseFile(dir, env);
  const on = sparseEffective(dir, env);
  if (on === null) return no(`no pude leer la configuración de la vista (${SPARSE_KEY}) del clon`);
  const hiddenNow = on ? null : hiddenFiles(dir, env);
  if (hiddenNow && hiddenNow.count === null) return uncounted(hiddenNow);
  if (on || hiddenNow.count > 0) {
    if (!file) return no('no pude ubicar info/sparse-checkout en el clon');
    // con la vista apagada y archivos todavía ocultos (alguien cambió la clave a mano), se prende para poder mostrarlos
    if (!on && !setEffective(dir, SPARSE_KEY, 'true', env)) return no('no pude prender la vista del clon para volver a mostrar todo');
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, SPARSE_ALL); } catch (e) { return no(`no pude escribir ${file} (${e.code || e.message})`); }
    const r = SRC.git(dir, ['sparse-checkout', 'reapply'], { env, timeout: TREE_TIMEOUT_MS });
    if (!r.ok) return no(reapplyFailure(r));
  }
  const left = hiddenFiles(dir, env);
  if (left.count === null) return uncounted(left);
  const hidden = left.count;
  const asWas = 'no pude dejar la configuración de git del clon como estaba';
  if (!setScoped(dir, 'local', SPARSE_KEY, was.value, env) || !setScoped(dir, 'local', CONE_KEY, was.cone, env)) return no(asWas);
  const perTree = worktreeScope(dir, env);
  if (perTree === null) return no(asWas);
  if (perTree && was.worktree) {
    if (!setScoped(dir, 'worktree', SPARSE_KEY, was.worktree.value, env) || !setScoped(dir, 'worktree', CONE_KEY, was.worktree.cone, env)) return no(asWas);
  } else if (perTree) {
    // `config.worktree` apareció DESPUÉS de la ida (un `git sparse-checkout set` o `disable` del dev sobre el clon
    // re-apuntado): es suyo y no se toca, salvo que deje la vista prendida — el clon de vuelta muestra todo
    const there = readConfig(dir, 'worktree', SPARSE_KEY, env, { bool: true });
    if (!there.ok || (there.value === 'true' && !setScoped(dir, 'worktree', SPARSE_KEY, 'false', env))) return no(asWas);
  }
  if (file) {
    try { if (was.file === null || was.file === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, was.file); } catch (e) { return no(`no pude dejar ${file} como estaba (${e.code || e.message})`); }
  }
  return { ok: true, reason: null, hidden };
}

// ── lo que se mira antes de mover ────────────────────────────────────────────────────────────────────────────────────

/** Los commits de HEAD que lo último traído de `origin` no tiene; `null` si no se pudo contar (no es «cero»). */
function ownCommits(dir, env) {
  const tip = SRC.refState(dir, `refs/remotes/origin/${MAIN}`, { env });
  if (tip.status !== 'ok') return null;
  const r = SRC.git(dir, ['rev-list', '--count', `refs/remotes/origin/${MAIN}..HEAD`], { env });
  const n = r.ok ? parseInt(r.out, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** Lo que git no sigue en ese clon, archivo por archivo: `{ untracked, ignored }`, o `null` si no se pudo listar. */
function notTracked(dir, env) {
  const all = SRC.git(dir, ['ls-files', '--others', '-z'], { env, timeout: TREE_TIMEOUT_MS });
  const plain = SRC.git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { env, timeout: TREE_TIMEOUT_MS });
  if (!all.ok || !plain.ok) return null;
  const untracked = zlist(plain.raw);
  const seen = new Set(untracked);
  return { untracked, ignored: zlist(all.raw).filter((p) => !seen.has(p)) };
}
/** Las rutas que cambian entre dos commits: `{ added, changed }` (las que llegan nuevas, y las que cambian o se van);
 *  `null` si git no pudo compararlos. */
function pathsBetween(dir, from, to, env) {
  if (from === to) return { added: [], changed: [] };
  // los dos commits salen del estado: nunca llegan a git como opción (`--output=<archivo>` le haría pisar un archivo)
  if (!isSha(from) || !isSha(to)) return null;
  const r = SRC.git(dir, ['diff', '--no-renames', '--name-status', '-z', '--end-of-options', from, to, '--'], { env, timeout: TREE_TIMEOUT_MS });
  if (!r.ok) return null;
  const parts = r.raw.split('\0');
  const added = []; const changed = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i + 1]) continue;
    (parts[i] === 'A' ? added : changed).push(parts[i + 1]);
  }
  return { added, changed };
}
/** Lo modificado sin commitear en lo que git sigue (contra HEAD); `null` si no se pudo mirar. Con `--no-renames`: un
 *  renombre en el índice (`git mv README.md LEEME.md`) se lista como la ruta que se va MÁS la que llega; sin eso git
 *  nombra sólo la nueva, la vieja no aparece entre lo modificado, y el control «tenés cambios en algo que la versión
 *  nueva también cambia» no la ve: la frenaría el merge, con la mudanza ya arrancada. */
function dirtyPaths(dir, env) {
  const r = SRC.git(dir, ['diff', '--no-renames', '--name-only', '-z', 'HEAD'], { env, timeout: TREE_TIMEOUT_MS });
  return r.ok ? zlist(r.raw) : null;
}
/** Las rutas de una lista de choques, para un aviso: hasta cuatro, y con cuál choca cada una si no es letra por letra la misma. */
function named(hits) {
  return hits.slice(0, 4).map((h) => (h.with === h.path ? h.path : `${h.path} (choca con ${h.with})`)).join(', ') + (hits.length > 4 ? ` y ${hits.length - 4} más` : '');
}
/**
 * Lo del dev que quedaría PISADO al llevar el clon de `head` al commit `target` con `reset --hard` (la vuelta, y deshacer
 * una mudanza en curso): un archivo sin versionar, o ignorado, en una ruta que `target` trae y `head` no. `reset --hard`
 * lo reemplaza sin avisar y sin copia —igual que el merge de la ida, que por eso lo frena—: la ida lo mira y la vuelta
 * también. Hace falta que el repo unificado haya retirado o movido, después de la ida, una
 * ruta que el commit viejo sigue. `null` = nada en el camino; si no, la causa lista para `block`.
 */
function inTheWayBack(dir, head, target, env) {
  const coming = pathsBetween(dir, head, target, env);
  const loose = coming ? notTracked(dir, env) : null;
  if (!coming || !loose) return { cause: 'unreadable', reason: 'no pude listar lo que vuelve o lo que este clon no sigue', transient: true };
  const hitU = SRC.collidingPaths(loose.untracked, coming.added);
  if (hitU.length) return { cause: 'untracked-collision', reason: `${named(hitU)} existe acá sin versionar y el commit al que se vuelve (${sha7(target)}) trae esa misma ruta: git lo pisaría sin avisar`, fix: 'movelo o borralo' };
  const hitI = SRC.collidingPaths(loose.ignored, coming.added);
  if (hitI.length) return { cause: 'ignored-collision', reason: `${named(hitI)} existe acá (ignorado por git) y el commit al que se vuelve (${sha7(target)}) trae esa misma ruta: git lo pisaría sin avisar`, fix: 'movelo o borralo' };
  return null;
}
/** ¿Ese remoto contesta, y tiene `main`? La única salida a la red de esta pieza, con el tope de `update`. La URL va
 *  detrás de `--`, y una que empieza con «-» ni llega a git (ver `dashed`). */
function remoteAnswers(dir, url, { env, budgetS } = {}) {
  if (dashed(url)) return { ok: false, offline: false, reason: dashedText('la URL del remoto', url) };
  const budget = SRC.budgetOf(budgetS, env);
  const r = SRC.git(dir, ['ls-remote', '--heads', '--', url, `refs/heads/${MAIN}`], { env, timeout: budget * 1000 });
  if (r.timedOut) return { ok: false, offline: true, reason: `sin red: ${url} no contestó en ${budget} s` };
  if (!r.ok) {
    return SRC.isNetworkError(r.err)
      ? { ok: false, offline: true, reason: `sin red: no pude llegar a ${url} (${firstLine(r.err)})` }
      : { ok: false, offline: false, reason: `${url} no contesta (${firstLine(r.err) || 'git ls-remote falló'})` };
  }
  const sha = (r.out.split(/\s+/)[0] || '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, offline: false, reason: `${url} no tiene la rama ${MAIN}` };
  return { ok: true, offline: false, reason: null, sha };
}
/** Lo que se mira del disco antes de intentar: si nada de esto cambió, una causa permanente sigue siendo la misma. */
function localFacts(skills, harness, env) {
  const others = SRC.git(skills.dir, ['ls-files', '--others', '-z'], { env, timeout: TREE_TIMEOUT_MS });
  const dirty = SRC.git(skills.dir, ['status', '--porcelain=v1', '--untracked-files=no'], { env, timeout: TREE_TIMEOUT_MS });
  return [
    SRC.head(skills.dir, { env }), SRC.branch(skills.dir, { env }), SRC.origin(skills.dir, { env }),
    harness ? SRC.head(harness.dir, { env }) : null, harness ? SRC.branch(harness.dir, { env }) : null,
    readConfig(skills.dir, null, SPARSE_KEY, env).value, digest(others.raw), digest(dirty.raw),
    // lo que el estado fija de cada fuente también se mira: una causa que se arregla en el estado (`install --source`)
    // tiene que reintentarse sola en el arranque siguiente
    skills.url || null, harness ? harness.url || null : null,
  ];
}
function dropOwnRefs(dir, env) {
  for (const ref of [TARGET_REF, UPSTREAM_REF]) {
    if (SRC.refState(dir, ref, { env }).status !== 'absent') SRC.git(dir, ['update-ref', '-d', ref], { env });
  }
}
/** Una ref del clon, como estaba: en ese commit, o borrada si no existía. */
function restoreRef(dir, ref, sha, env) {
  const cur = SRC.refState(dir, ref, { env });
  if (sha) return cur.sha === sha ? true : SRC.git(dir, ['update-ref', ref, sha], { env }).ok;
  return cur.status === 'absent' ? true : SRC.git(dir, ['update-ref', '-d', ref], { env }).ok;
}

// ── la constancia dentro del clon ────────────────────────────────────────────────────────────────────────────────────
// De dónde venía el clon (URL, commit, lo que había en su configuración) se guarda en el estado del mecanismo — y el
// estado se pierde: `uninstall` lo borra y NO toca el clon, que queda re-apuntado; y ante un estado ilegible el consejo
// es borrarlo y reinstalar. Sin otra constancia, la máquina reinstalada tendría un clon re-apuntado que nadie sabe
// deshacer; y con la llave prendida el arranque lo encontraría «con una vista reducida propia», no podría pasar y —por la
// regla «ninguna fuente se mueve»— la máquina dejaría de actualizarse. Por eso la ida deja la misma constancia DENTRO del
// `.git` del clon (un archivo que git no mira), la vuelta la saca, y `adopt` la lee cuando el estado no sabe nada.

function recordFile(dir, env) {
  const r = SRC.git(dir, ['rev-parse', '--git-path', CLONE_RECORD], { env, timeout: 10000 });
  return r.ok && r.out ? path.resolve(dir, r.out) : null;
}
function writeCloneRecord(dir, env, rec) {
  const file = recordFile(dir, env);
  if (!file) return false;
  try { fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`); return true; } catch (_) { return false; }
}
/** La constancia de la mudanza que el clon guarda, o `null` si no la tiene o no se puede leer. */
function readCloneRecord(dir, env) {
  const file = recordFile(dir, env);
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.from && typeof j.from.url === 'string' && typeof j.from.commit === 'string' ? j : null;
  } catch (_) { return null; }
}
function dropCloneRecord(dir, env) {
  const file = recordFile(dir, env);
  if (file) { try { fs.rmSync(file, { force: true }); } catch (_) { /* queda: la próxima vuelta la saca */ } }
}

/**
 * El estado no registra ninguna mudanza y el clon YA apunta al repo unificado. Si trae su constancia, la mudanza es
 * nuestra: se registra tal cual (la vuelta sabe a dónde volver). Sin constancia y con la llave en `unified`, se registra
 * sin origen —no hay nada que re-apuntar, y no puede frenar a nadie—; con la llave en `separate` no es una mudanza del
 * mecanismo (alguien clonó así): no se toca. Sólo lecturas del clon; cambia `state` en memoria.
 */
function adopt(ctx, state, skills, want, log) {
  const env = ctx.env;
  const harness = sourceOf(state, 'harness');
  if (!harness || !harness.url || !SRC.isRepo(skills.dir, { env })) return false;
  const here = SRC.origin(skills.dir, { env });
  if (!here || SRC.remoteIdentity(here) !== SRC.remoteIdentity(harness.url)) return false;
  const rec = readCloneRecord(skills.dir, env);
  if (!rec && want !== 'unified') return false;
  // sin constancia, sólo si el estado ya dice lo mismo que el clon: un origin que cambió sin que el estado lo sepa es
  // otra cosa («el origen cambió»), y la dicen `update` y `doctor`
  if (!rec && SRC.remoteIdentity(skills.url) !== SRC.remoteIdentity(here)) return false;
  if (rec) skills.url = here;
  const blocked = state.repoint && state.repoint.blocked && state.repoint.blocked.direction === 'separate' ? state.repoint.blocked : null;
  state.repoint = { applied: { at: (rec && rec.at) || nowIso(), from: rec ? rec.from : null, to: { url: here, commit: SRC.head(skills.dir, { env }) }, adopted: true } };
  if (blocked) state.repoint.blocked = blocked;
  if (log) log(`repoint: ${skills.dir} ya apunta al repo unificado y el estado no lo sabía: ${rec ? `lo registro con la constancia del clon (venía de ${rec.from.url} @ ${sha7(rec.from.commit)})` : 'lo registro sin origen (el clon no guarda de dónde venía: la vuelta no se puede hacer sola)'}`);
  return true;
}

// ── el aviso de lo que no pudo pasar ─────────────────────────────────────────────────────────────────────────────────

/** El aviso de una causa: la frase de la llave, el clon, la causa, lo que la arregla (`fix`: cuando es un comando va
 *  SOLO, sin más texto, entre « — » y «; » — las pruebas lo sacan de ahí y lo corren tal cual: si no destraba, es un
 *  bug) y qué sigue (`then`: si la causa no lo dice, el `update` de siempre). */
function blockedText(direction, dir, b) {
  const then = b.then || (b.transient ? `se reintenta en el próximo arranque (ya: ${UPDATE_CMD})` : `después: ${UPDATE_CMD}`);
  return `${PHRASE[direction]} (${dir}): ${b.reason}${b.fix ? ` — ${b.fix}` : ''}; ${then}`;
}
/** Anota en el estado por qué no pasó (salvo en `--dry-run`) y devuelve el resultado: ninguna fuente se mueve. El
 *  resultado lleva la `cause`: quien llama decide con ella, no con el texto. */
function block(state, direction, dir, { cause, reason, fix = null, then = null, transient = false, facts = [] }, { dryRun = false, log = null } = {}) {
  const b = { direction, cause, reason, fix, transient, fingerprint: transient ? null : digest(JSON.stringify(facts)), at: nowIso() };
  if (then) b.then = then;
  const text = blockedText(direction, dir, b);
  if (log) log(`repoint: ${cause}: ${reason}`);
  if (dryRun) return { status: 'blocked', proceed: false, lines: [`no se re-apuntaría — ${text}`], notice: null, cause };
  state.repoint = Object.assign({}, state.repoint || {}, { blocked: b });
  return { status: 'blocked', proceed: false, lines: [text], notice: text, cause };
}
/** ¿La causa anotada es permanente y nada de lo que se miró cambió? Entonces no se reintenta sola. */
function sameAsBefore(state, direction, facts) {
  const b = state.repoint && state.repoint.blocked;
  return Boolean(b && b.direction === direction && !b.transient && b.fingerprint && b.fingerprint === digest(JSON.stringify(facts)));
}
function tidy(state) {
  const rp = state.repoint;
  if (rp && !rp.applied && !rp.pending && !rp.blocked) delete state.repoint;
}

// ── deshacer ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un merge que murió a medias (un archivo tomado por otro programa: lo corriente en Windows) deja HEAD donde estaba y
 * algunos archivos ya escritos. Vuelven sólo ésos: de las rutas de la vista que cambian entre los dos commits, las que
 * hoy difieren de HEAD y tienen el contenido de la versión nueva (o faltan); y las que la versión nueva agrega y quedaron
 * en el disco con su contenido. Lo que el dev tocó no entra: esas rutas estaban limpias (se miró antes de mover).
 * «El commit nuevo no está en el clon» (el merge ni empezó) lo dice git, en sus tres estados: si no se pudo mirar, o no
 * se pudo listar lo que cambia o lo modificado, es una falla con su causa — leer cualquiera de las tres como
 * «nada que limpiar» daría la mudanza por deshecha (la misma clase de falla que en `sameClone` y en lo oculto).
 * Cada archivo se compara con la versión nueva también en tres estados (`fileVsTarget`): si no se pudo mirar si está en el
 * disco, leerlo, o leer su versión nueva, no se toca NINGÚN archivo y es una falla con la causa. Una lectura que
 * falla y da vacío es peligrosa: con las dos vacías, «vacío == vacío» se tomaría como «es de la versión nueva» y la limpieza pisaría
 * (`checkout -f`) o borraría un archivo que no se pudo leer; con una sola, «distinto», y la ida se daría por deshecha con
 * lo de la versión nueva todavía en el disco; y `existsSync` contesta «no está» ante un error de permisos.
 */
function restorePartial(dir, from, to, env) {
  const there = SRC.commitState(dir, to, { env });
  if (there.status === 'absent') return { ok: true };   // el commit nuevo no está en el clon: el merge ni empezó
  if (there.status !== 'ok') return { ok: false, reason: `no pude mirar si el commit al que iba la ida (${sha7(to)}) está en el clon (${there.reason})` };
  const d = pathsBetween(dir, from, to, env);
  if (!d) return { ok: false, reason: `no pude listar lo que cambia entre ${sha7(from)} y ${sha7(to)} para limpiar el merge a medias` };
  const dirtyList = dirtyPaths(dir, env);
  if (dirtyList === null) return { ok: false, reason: 'no pude mirar lo modificado del clon (git diff falló) para limpiar el merge a medias' };
  const dirty = new Set(dirtyList);
  // primero se mira todo y después se toca: una lectura que falla a mitad de la lista no deja la limpieza a medias
  const back = []; const drop = [];
  const blindOn = (s) => ({ ok: false, reason: `${s.reason}: no toco ningún archivo para limpiar el merge a medias` });
  for (const p of d.changed.filter((q) => inView(q) && dirty.has(q))) {
    const s = fileVsTarget(dir, to, p, env);
    if (s.status === 'unknown') return blindOn(s);
    if (s.status === 'absent' || s.status === 'target') back.push(p);
  }
  for (const p of d.added.filter(inView)) {
    const s = fileVsTarget(dir, to, p, env);
    if (s.status === 'unknown') return blindOn(s);
    if (s.status === 'target') drop.push(p);
  }
  for (let i = 0; i < back.length; i += 100) {
    const r = SRC.git(dir, ['checkout', '-q', '-f', 'HEAD', '--', ...back.slice(i, i + 100)], { env, timeout: TREE_TIMEOUT_MS });
    if (!r.ok) return { ok: false, reason: `no pude dejar como estaban ${back.slice(i, i + 3).join(', ')}: ${firstLine(r.err)}` };
  }
  for (const p of drop) {
    try { fs.rmSync(path.join(dir, p), { force: true }); } catch (e) { return { ok: false, reason: `no pude sacar ${p} (${e.code || e.message})` }; }
  }
  return { ok: true };
}
/**
 * Lo que hay en el disco en la ruta `p` del clon, comparado con esa ruta en el commit `to`:
 *   · `absent` — no hay nada (el disco lo dice: ENOENT/ENOTDIR);
 *   · `target` — está, y es byte a byte el de `to`;
 *   · `other`  — está y es otra cosa (o `to` no trae esa ruta: lo del disco no es de la versión nueva);
 *   · `unknown` — no se pudo mirar si está, leerlo, o leer su versión en `to` (`reason` dice cuál y por qué).
 * `lstat` y no `existsSync`: éste dice «no existe» ante cualquier error. Y no sigue enlaces: un enlace roto ESTÁ.
 */
function fileVsTarget(dir, to, p, env) {
  const unknown = (reason) => ({ status: 'unknown', reason });
  const gitWhy = (r) => (r.timedOut ? 'git no contestó a tiempo' : (firstLine(r.err) || `git salió ${r.status}`));
  try { fs.lstatSync(path.join(dir, p)); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'absent' };
    return unknown(`no pude mirar si ${p} está en el disco (${(e && (e.code || e.message)) || e})`);
  }
  const disk = SRC.git(dir, ['hash-object', '--', p], { env, timeout: 10000 });
  if (!disk.ok || !disk.out) return unknown(`no pude leer ${p} del disco (git hash-object: ${gitWhy(disk)})`);
  const blob = SRC.git(dir, ['rev-parse', '--verify', '-q', `${to}:${p}`], { env, timeout: 10000 });
  if (blob.ok && blob.out) return { status: disk.out === blob.out ? 'target' : 'other' };
  // `rev-parse --verify -q` sale 1 y callado cuando esa ruta no está en `to`: eso es una respuesta; lo demás, no
  if (blob.status === 1 && !blob.timedOut && !blob.err) return { status: 'other' };
  return unknown(`no pude leer ${p} de la versión nueva ${sha7(to)} (git rev-parse: ${gitWhy(blob)})`);
}

/** Lo que no cierra en la constancia de dónde venía el clon (el estado, o el archivo dentro de su `.git`): sale de un
 *  archivo que cualquiera puede editar y va a parar a `git reset --hard`, `update-ref` y `remote set-url`. `null` = sirve. */
function recordProblem(from) {
  if (!from || typeof from.url !== 'string' || !from.url) return 'la constancia de la mudanza no dice de qué remoto venía el clon';
  if (dashed(from.url)) return dashedText('la URL guardada de dónde venía este clon', from.url);
  if (!isSha(from.commit)) return 'la constancia de la mudanza no trae un commit válido al que volver';
  for (const key of ['remote_main', 'previous_ref']) {
    if (from[key] !== null && from[key] !== undefined && !isSha(from[key])) return `la constancia de la mudanza trae en ${key} algo que no es un commit`;
  }
  return null;
}

/**
 * Deja el clon como estaba antes de la ida. Mira cada paso antes de tocarlo: se puede correr dos veces, y sobre una ida
 * que quedó a medias. `to`: el commit al que iba la ida (para limpiar un merge que murió en el medio).
 * Lo que NO deshace, y devuelve por qué con su comando: sobre otra rama que `main` —el `reset --hard` movería la rama en
 * la que esté parado el dev, y su commit quedaría sólo en el reflog—, y encima de un archivo del dev en una ruta que vuelve.
 * @returns {{ ok: boolean, reason: string|null, notes: string[] }}
 */
function undo(skills, from, { env, to = null } = {}) {
  const dir = skills.dir;
  const notes = [];
  const no = (reason) => ({ ok: false, reason, notes });
  const bad = recordProblem(from);
  if (bad) return no(bad);
  // el commit al que iba la ida también sale del estado: si no es un commit, no se usa para nada (si llegara a `git diff`,
  // un `--output=<archivo>` haría que git pisara ese archivo)
  if (to !== null && to !== undefined && !isSha(to)) return no('la mudanza en curso guardó como destino algo que no es un commit: no lo uso');
  const head = SRC.head(dir, { env });
  if (!head) return no(`no pude leer HEAD de ${dir}`);
  const cur = SRC.branch(dir, { env });
  if (cur !== MAIN) return no(`el clon está en la rama ${cur || '(sin rama)'} y no en ${MAIN}, y sobre esa rama no se deshace nada — git -C ${dir} checkout ${MAIN}`);
  if (head !== from.commit) {
    const there = SRC.commitState(dir, from.commit, { env });
    if (there.status !== 'ok') return no(there.status === 'absent' ? `el commit guardado ${sha7(from.commit)} no está en el clon` : `no pude mirar el commit guardado ${sha7(from.commit)} (${there.reason})`);
    const way = inTheWayBack(dir, head, from.commit, env);
    if (way) return no(`${way.reason}${way.fix ? ` — ${way.fix}` : ''}`);
    const rv = SRC.revert(skills, from.commit, { env });
    if (!rv.ok) return no(rv.reason);
    if (rv.kept) notes.push(rv.reason);
  } else if (to && to !== from.commit) {
    const fix = restorePartial(dir, from.commit, to, env);
    if (!fix.ok) return no(fix.reason);
  }
  const off = sparseOff(dir, env, from.sparse);
  if (!off.ok) return no(off.reason);
  if (off.hidden) notes.push(`${off.hidden} archivo(s) no volvieron a mostrarse porque en su lugar hay algo tuyo: git -C ${dir} status los nombra`);
  if (SRC.origin(dir, { env }) !== from.url) {
    const r = SRC.git(dir, ['remote', 'set-url', '--', 'origin', from.url], { env });
    if (!r.ok) return no(`no pude volver el origin a ${from.url}: ${firstLine(r.err)}`);
  }
  if (!restoreRef(dir, `refs/remotes/origin/${MAIN}`, from.remote_main, env)) return no(`no pude dejar refs/remotes/origin/${MAIN} como estaba`);
  if (!restoreRef(dir, SRC.previousRef(skills.name), from.previous_ref, env)) return no(`no pude dejar ${SRC.previousRef(skills.name)} como estaba`);
  dropOwnRefs(dir, env);
  dropCloneRecord(dir, env);
  return { ok: true, reason: null, notes };
}

// ── la ida ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function forward(ctx, state, o) {
  const env = ctx.env;
  const log = o.log || (() => {});
  const skills = sourceOf(state, 'agent_skills');
  const harness = sourceOf(state, 'harness');
  const dir = skills.dir;
  const g = `git -C ${dir}`;
  const facts = localFacts(skills, harness, env);
  const stop = (b) => block(state, 'unified', dir, Object.assign({ facts }, b), o);
  const cleanStop = (b) => { dropOwnRefs(dir, env); return stop(b); };

  if (!o.manual && !o.dryRun && sameAsBefore(state, 'unified', facts)) {
    const b = state.repoint.blocked;
    log(`repoint: ${b.cause}: nada de lo que se miró cambió desde ${b.at}: no se reintenta (lo reintenta ${UPDATE_CMD})`);
    return { status: 'skipped', proceed: false, lines: [], notice: blockedText('unified', dir, b) };
  }
  if (!harness || !harness.url || !harness.dir) return stop({ cause: 'no-harness-source', reason: 'el estado no dice de qué remoto sale el arnés' });
  // la URL y la carpeta del arnés salen del estado y van a git como argumentos: una que empieza con «-» no se usa
  const unsafe = [['la URL del repo unificado que guarda el estado', harness.url], ['la carpeta del clon del arnés que guarda el estado', harness.dir]].find(([, v]) => dashed(v));
  if (unsafe) return stop({ cause: 'unsafe-value', reason: dashedText(unsafe[0], unsafe[1]), fix: `${INSTALL_CMD} --source <la URL de ese repo>` });
  if (!SRC.isRepo(dir, { env })) return stop({ cause: 'not-a-clone', reason: `${dir} no es un clon de git` });

  // el clon del arnés: ¿ya trae las skills? Si no, todavía no hay a dónde re-apuntar, y es ÉL el que tiene que avanzar
  const treeHead = SRC.head(harness.dir, { env });
  const brings = treeHead ? hasSkills(harness.dir, 'HEAD', { env }) : null;
  if (brings === null) return stop({ cause: 'tree-unreadable', reason: `no pude mirar el clon del arnés (${harness.dir})`, transient: true });
  if (brings === false) {
    log(`repoint: el clon del arnés (${sha7(treeHead)}) todavía no trae ${SKILLS_MARK}: no hay a dónde re-apuntar; se intenta cuando llegue`);
    if (state.repoint && state.repoint.blocked) { delete state.repoint.blocked; tidy(state); }
    return { status: 'waiting-tree', proceed: true, lines: [], notice: null };
  }
  if (harness.rewrites) return stop({ cause: 'not-internal', reason: 'el arnés de esta máquina sigue una copia pública: no hay un clon aparte que re-apuntar' });
  const treeBranch = SRC.branch(harness.dir, { env });
  if (treeBranch !== MAIN) return stop({ cause: 'tree-branch', reason: `el clon del arnés (${harness.dir}) está en la rama ${treeBranch || '(sin rama)'} y no en ${MAIN}`, fix: `git -C ${harness.dir} checkout ${MAIN}` });
  const treeOwn = ownCommits(harness.dir, env);
  if (treeOwn === null) return stop({ cause: 'tree-unreadable', reason: `no pude contar los commits propios del clon del arnés (${harness.dir})`, transient: true });
  if (treeOwn > 0) return stop({ cause: 'tree-own-commits', reason: `el clon del arnés (${harness.dir}) tiene ${treeOwn} commit(s) propios que origin no tiene`, fix: `git -C ${harness.dir} log origin/${MAIN}..HEAD` });

  // el clon viejo
  const from = SRC.head(dir, { env });
  if (!from) return stop({ cause: 'unreadable', reason: `no pude leer HEAD de ${dir} (${SRC.refState(dir, 'HEAD', { env }).reason || 'no apunta a ningún commit'})`, transient: true });
  const cur = SRC.branch(dir, { env });
  if (cur !== MAIN) return stop({ cause: 'branch', reason: `está en la rama ${cur || '(sin rama)'} y no en ${MAIN}`, fix: `${g} checkout ${MAIN}` });
  const before = sparseBefore(dir, env);
  if (!before) return stop({ cause: 'unreadable', reason: 'no pude leer la configuración de la vista (sparse-checkout) del clon', transient: true });
  // por el valor EFECTIVO: una vista hecha con `git sparse-checkout set` vive en config.worktree, no en .git/config. Y el
  // remedio destraba porque se lee así: `disable` deja config.worktree en false, que le gana a lo que diga .git/config
  if (before.on) return stop({ cause: 'own-sparse', reason: 'el clon ya tiene una vista reducida propia (sparse-checkout): re-apuntarlo la pisaría', fix: `${g} sparse-checkout disable` });
  const unmerged = SRC.git(dir, ['ls-files', '-u'], { env });
  if (!unmerged.ok) return stop({ cause: 'unreadable', reason: 'no pude mirar el índice del clon', transient: true });
  if (unmerged.out) return stop({ cause: 'unmerged', reason: 'tiene conflictos sin resolver', fix: `${g} status` });
  const own = ownCommits(dir, env);
  if (own === null) return stop({ cause: 'unreadable', reason: `no pude contar los commits propios sobre origin/${MAIN}`, transient: true });
  if (own > 0) return stop({ cause: 'own-commits', reason: `tiene ${own} commit(s) propios que origin no tiene`, fix: `guardalos en una rama tuya (${g} branch <nombre>) y volvé ${MAIN} a lo publicado (${g} reset --keep origin/${MAIN})` });
  const oldUrl = SRC.origin(dir, { env });
  if (!oldUrl) return stop({ cause: 'no-origin', reason: 'el clon no tiene origin' });
  if (dashed(oldUrl)) return stop({ cause: 'unsafe-value', reason: dashedText('el origin de este clon', oldUrl), fix: `${g} remote set-url origin <la URL de ese repo>` });
  // el clon sigue a OTRO remoto que el que fijó el estado (alguien le cambió el origin, o lo volvió a clonar de otro
  // lado): no se muda un clon sin saber cuál de los dos vale. Lo decide la persona, con el remedio de siempre
  if (skills.url && SRC.remoteIdentity(skills.url) !== SRC.remoteIdentity(oldUrl)) {
    return stop({ cause: 'origin-changed', reason: `el origin de este clon (${oldUrl}) no es el que fijó el estado (${skills.url}): no lo muevo sin saber cuál vale`, fix: `${INSTALL_CMD} --source ${oldUrl}` });
  }

  // la única salida a la red: ¿el repo unificado contesta?
  const remote = remoteAnswers(dir, harness.url, { env });
  if (!remote.ok) return stop({ cause: remote.offline ? 'offline' : 'remote', reason: remote.reason, transient: true });

  // los commits, del clon del arnés de esta máquina (sin red): el destino es SU commit
  const refspecs = [`+HEAD:${TARGET_REF}`];
  if (SRC.refState(harness.dir, `refs/remotes/origin/${MAIN}`, { env }).status === 'ok') refspecs.push(`+refs/remotes/origin/${MAIN}:${UPSTREAM_REF}`);
  const seed = SRC.git(dir, ['fetch', '-q', '--no-tags', '--', harness.dir, ...refspecs], { env, timeout: SEED_TIMEOUT_MS });
  if (!seed.ok) return cleanStop({ cause: 'seed', reason: `no pude traer los commits desde el clon del arnés (${firstLine(seed.err) || 'git fetch falló'})`, transient: BUSY.test(seed.err) });
  const target = SRC.refState(dir, TARGET_REF, { env }).sha;
  if (!target || target !== treeHead) return cleanStop({ cause: 'seed', reason: 'el clon del arnés se movió mientras lo miraba', transient: true });
  const upstream = SRC.refState(dir, UPSTREAM_REF, { env }).sha || target;

  // en línea recta
  const straight = SRC.ancestor(dir, from, target, env);
  if (straight === null) return cleanStop({ cause: 'unreadable', reason: `git no pudo comparar ${sha7(from)} con ${sha7(target)}`, transient: true });
  // El destino sale del clon LOCAL del arnés, y mientras este clon no pase el arranque no actualiza ninguna fuente
  // Si el repo unificado arregla la causa (mergea el commit que faltaba), el arranque solo no se entera nunca.
  // La salida es el comando que el aviso nombra: `update` pedido a mano trae primero el arnés —sólo si lo publicado ya
  // contiene este commit— y reintenta la mudanza en el mismo comando (harness.js)
  if (!straight) {
    return cleanStop({
      cause: 'not-fast-forward', fix: `${g} log -3`,
      reason: `la historia del repo unificado que tiene el clon del arnés (${sha7(target)}) no contiene el commit de este clon (${sha7(from)}): no avanza en línea recta (historia sin unir, o el repo viejo recibió commits después de la unión)`,
      then: `el arranque no lo reintenta solo; cuando el repo unificado ya contenga ese commit: ${UPDATE_CMD} — pedido a mano trae primero la versión nueva del arnés y reintenta la mudanza`,
    });
  }

  // nada del dev en el camino: ni sin versionar, ni ignorado (git lo pisa sin avisar), ni modificado sin commitear
  const incoming = pathsBetween(dir, from, target, env);
  const loose = incoming ? notTracked(dir, env) : null;
  const dirty = loose ? dirtyPaths(dir, env) : null;
  if (!incoming || !loose || dirty === null) return cleanStop({ cause: 'unreadable', reason: 'no pude listar lo que llega o lo que este clon no sigue', transient: true });
  const hitU = SRC.collidingPaths(loose.untracked, incoming.added);
  if (hitU.length) return cleanStop({ cause: 'untracked-collision', reason: `${named(hitU)} existe acá sin versionar y la versión nueva trae esa misma ruta`, fix: 'movelo o borralo' });
  const hitI = SRC.collidingPaths(loose.ignored, incoming.added);
  if (hitI.length) return cleanStop({ cause: 'ignored-collision', reason: `${named(hitI)} existe acá (ignorado por git) y la versión nueva trae esa misma ruta: git lo pisaría sin avisar`, fix: 'movelo o borralo' });
  const moving = new Set([...incoming.added, ...incoming.changed]);
  const overlap = dirty.filter((p) => moving.has(p));
  if (overlap.length) return cleanStop({ cause: 'dirty-overlap', reason: `tenés cambios sin commitear en ${overlap.slice(0, 4).join(', ')}${overlap.length > 4 ? ` y ${overlap.length - 4} más` : ''}, que la versión nueva también cambia`, fix: `commitealos en una rama tuya o apartalos (${g} stash push)` });

  if (o.dryRun) {
    dropOwnRefs(dir, env);
    return { status: 'would', proceed: true, lines: [`se re-apuntaría: ${dir} pasaría de ${oldUrl} @ ${sha7(from)} al repo unificado ${harness.url} @ ${sha7(target)}, mostrando sólo ${VISIBLE.join('/, ')}/ y la raíz`], notice: null };
  }

  // la copia de seguridad y la mudanza anotada «en curso», ANTES de mover
  const remoteMain = SRC.refState(dir, `refs/remotes/origin/${MAIN}`, { env });
  const prevRef = SRC.refState(dir, SRC.previousRef(skills.name), { env });
  const fromRec = {
    url: oldUrl, commit: from, previous: skills.previous === undefined ? null : skills.previous,
    remote_main: remoteMain.status === 'ok' ? remoteMain.sha : null, previous_ref: prevRef.status === 'ok' ? prevRef.sha : null, sparse: before,
  };
  const toRec = { url: harness.url, commit: target };
  const at = nowIso();
  const snap = o.backup ? o.backup('repoint', `agent_skills@${sha7(target)}`) : null;
  if (!snap) return cleanStop({ cause: 'no-backup', reason: 'no pude tomar la copia de seguridad de antes de mover', transient: true });
  const finish = () => { if (o.finish) o.finish(snap); };
  const kept = state.repoint && state.repoint.blocked;
  state.repoint = { pending: { step: 'forward', from: fromRec, to: toRec, at } };
  try { if (o.write) o.write(); } catch (e) {
    state.repoint = kept ? { blocked: kept } : undefined; tidy(state); if (state.repoint === undefined) delete state.repoint;
    finish();
    return cleanStop({ cause: 'state', reason: `no pude anotar la mudanza en el estado (${e.code || e.message})`, transient: true });
  }
  const fail = (step, why) => {
    const u = undo(skills, fromRec, { env, to: target });
    finish();
    if (u.ok) {
      delete state.repoint;
      return stop({ cause: `failed-${step}`, reason: `${why} — el clon quedó como estaba`, transient: BUSY.test(why) });
    }
    const text = `una mudanza del clon de skills (${dir}) quedó a medias (${why}) y no pude deshacerla (${u.reason}): el próximo arranque lo vuelve a intentar; ya: ${UPDATE_CMD}`;
    log(`repoint: ${text}`);
    return { status: 'blocked', proceed: false, lines: [text], notice: text };
  };
  if (!SRC.git(dir, ['update-ref', SRC.previousRef(skills.name), from], { env }).ok) return fail('previous', `no pude guardar ${SRC.previousRef(skills.name)}`);
  const view = sparseOn(dir, env);
  if (!view.ok) return fail('view', view.reason);
  if (from !== target) {
    const m = SRC.git(dir, ['merge', '-q', '--ff-only', '--no-overwrite-ignore', TARGET_REF], { env, timeout: TREE_TIMEOUT_MS });
    if (!m.ok) return fail('merge', `el merge --ff-only a ${sha7(target)} falló: ${firstLine(m.err) || `git salió ${m.status}`}`);
  }
  const su = SRC.git(dir, ['remote', 'set-url', '--', 'origin', harness.url], { env });
  if (!su.ok) return fail('origin', `no pude cambiar el origin: ${firstLine(su.err)}`);
  if (!SRC.git(dir, ['update-ref', `refs/remotes/origin/${MAIN}`, upstream], { env }).ok) return fail('remote-ref', `no pude dejar refs/remotes/origin/${MAIN} en lo traído`);
  dropOwnRefs(dir, env);
  if (!writeCloneRecord(dir, env, { at, from: fromRec, to: toRec })) log(`repoint: no pude dejar la constancia de la mudanza dentro del clon (${dir}): si el estado se pierde, la vuelta no se podrá hacer sola`);

  skills.url = harness.url; skills.commit = target; skills.previous = from;
  state.repoint = { applied: { at, from: fromRec, to: toRec } };
  try { if (o.write) o.write(); } catch (e) { log(`repoint: el clon ya está re-apuntado y no pude grabar el estado ahora (${e.code || e.message}): lo graba el final de esta ejecución`); }
  finish();
  const text = `skills re-apuntadas: ${dir} ahora sigue al repo unificado (${harness.url}) y quedó en el mismo commit que el arnés (${sha7(target)}); venía de ${oldUrl} @ ${sha7(from)}. Lo tuyo —sin versionar, ignorado, stash— no se movió. Se deshace con la llave update.skills_source en «separate»`;
  log(`repoint: ${text}`);
  return { status: 'done', proceed: true, lines: [text], notice: text };
}

// ── la vuelta ────────────────────────────────────────────────────────────────────────────────────────────────────────

function back(ctx, state, o) {
  const env = ctx.env;
  const log = o.log || (() => {});
  const skills = sourceOf(state, 'agent_skills');
  const dir = skills.dir;
  const g = `git -C ${dir}`;
  const applied = state.repoint.applied;
  const from = applied.from;
  const facts = localFacts(skills, null, env);
  const stop = (b) => block(state, 'separate', dir, Object.assign({ facts }, b), o);

  if (!from || !from.url || !from.commit) {
    // Sin constancia no hay vuelta que hacer; se dice (doctor, en rojo) y NO frena a nadie, en NINGÚN arranque: el clon
    // sigue al repo unificado, igual que el arnés, y la máquina se sigue actualizando. Va ANTES del atajo «nada cambió»:
    // ese atajo devuelve «no se mueve ninguna fuente» para cualquier causa anotada, y desde el segundo arranque congelaría
    // la máquina. El remedio es el comando entero, en orden: fijar el origen ANTES de
    // mover el clon (así la comprobación de salud de `install` lo encuentra en el commit registrado), traer el repo viejo
    // y llevar `main` a lo publicado sin pisar lo modificado (`reset --keep`). Hecho eso, el estado suelta la mudanza
    // solo: ya no sigue al repo unificado (`strayed`)
    const view = sparseEffective(dir, env) === true ? ` && ${g} sparse-checkout disable` : '';
    const b = {
      cause: 'no-record',
      reason: `no hay constancia de dónde venía este clon (ni en el estado ni en el clon): la vuelta no se puede hacer sola; para volverlo a mano, con la URL del repo viejo de agent-skills en lugar de ${OLD_URL}`,
      fix: `${g} remote set-url origin ${OLD_URL} && ${INSTALL_CMD} --source ${OLD_URL} && ${g} fetch origin && ${g} reset --keep origin/${MAIN}${view}`,
    };
    const known = state.repoint.blocked;
    if (!o.manual && !o.dryRun && known && known.cause === b.cause && sameAsBefore(state, 'separate', facts)) {
      return { status: 'skipped', proceed: true, lines: [], notice: blockedText('separate', dir, known), cause: b.cause };
    }
    return Object.assign(stop(b), { proceed: true });
  }
  if (!o.manual && !o.dryRun && sameAsBefore(state, 'separate', facts)) {
    const b = state.repoint.blocked;
    log(`repoint: ${b.cause}: nada de lo que se miró cambió desde ${b.at}: no se reintenta (lo reintenta ${UPDATE_CMD})`);
    return { status: 'skipped', proceed: false, lines: [], notice: blockedText('separate', dir, b) };
  }
  const bad = recordProblem(from);
  if (bad) return stop({ cause: 'unsafe-value', reason: bad });
  if (!SRC.isRepo(dir, { env })) return stop({ cause: 'not-a-clone', reason: `${dir} no es un clon de git` });
  const cur = SRC.branch(dir, { env });
  if (cur !== MAIN) return stop({ cause: 'branch', reason: `está en la rama ${cur || '(sin rama)'} y no en ${MAIN}`, fix: `${g} checkout ${MAIN}` });
  const own = ownCommits(dir, env);
  if (own === null) return stop({ cause: 'unreadable', reason: `no pude contar los commits propios sobre origin/${MAIN}`, transient: true });
  if (own > 0) return stop({ cause: 'own-commits', reason: `tiene ${own} commit(s) propios que origin no tiene`, fix: `guardalos en una rama tuya (${g} branch <nombre>) y volvé ${MAIN} a lo publicado (${g} reset --keep origin/${MAIN})` });
  const there = SRC.commitState(dir, from.commit, { env });
  if (there.status !== 'ok') return stop({ cause: 'commit-missing', reason: there.status === 'absent' ? `el commit guardado ${sha7(from.commit)} no está en el clon` : `no pude mirar el commit guardado ${sha7(from.commit)} (${there.reason})`, transient: there.status !== 'absent' });
  // nada del dev en una ruta que vuelve: la ida lo frena, y la vuelta lo pisaría sin aviso y sin copia
  const here = SRC.head(dir, { env });
  if (!here) return stop({ cause: 'unreadable', reason: `no pude leer HEAD de ${dir}`, transient: true });
  const way = here === from.commit ? null : inTheWayBack(dir, here, from.commit, env);
  if (way) return stop(way);

  // si el remoto viejo no contesta no se toca nada: volver a un remoto caído deja la máquina sin de dónde actualizar
  const remote = remoteAnswers(dir, from.url, { env });
  if (!remote.ok) return stop({ cause: remote.offline ? 'offline' : 'remote', reason: `el remoto viejo no contesta: ${remote.reason} — no toqué nada`, transient: true });

  if (o.dryRun) return { status: 'would', proceed: true, lines: [`se volvería al repo viejo: ${dir} pasaría de ${SRC.origin(dir, { env })} @ ${sha7(SRC.head(dir, { env }))} a ${from.url} @ ${sha7(from.commit)}, mostrando todo otra vez`], notice: null };

  const snap = o.backup ? o.backup('repoint-back', `agent_skills@${sha7(from.commit)}`) : null;
  if (!snap) return stop({ cause: 'no-backup', reason: 'no pude tomar la copia de seguridad de antes de mover', transient: true });
  const finish = () => { if (o.finish) o.finish(snap); };
  state.repoint = { applied, pending: { step: 'back', from, to: applied.to, at: nowIso() } };
  try { if (o.write) o.write(); } catch (e) {
    state.repoint = { applied };
    finish();
    return stop({ cause: 'state', reason: `no pude anotar la mudanza en el estado (${e.code || e.message})`, transient: true });
  }
  const u = undo(skills, from, { env });
  if (!u.ok) {
    finish();
    const text = `una mudanza del clon de skills (${dir}) quedó a medias (la vuelta al repo viejo: ${u.reason}): el próximo arranque lo vuelve a intentar; ya: ${UPDATE_CMD}`;
    log(`repoint: ${text}`);
    return { status: 'blocked', proceed: false, lines: [text], notice: text };
  }
  skills.url = from.url; skills.commit = from.commit; skills.previous = from.previous === undefined ? null : from.previous;
  delete state.repoint;
  try { if (o.write) o.write(); } catch (e) { log(`repoint: el clon ya volvió y no pude grabar el estado ahora (${e.code || e.message}): lo graba el final de esta ejecución`); }
  finish();
  for (const n of u.notes) log(`repoint: ${n}`);
  const text = `skills de vuelta en el repo viejo: ${dir} volvió a ${from.url} @ ${sha7(from.commit)} y muestra todo otra vez (la llave update.skills_source está en «separate»)${u.notes.length ? ` — ${u.notes.join('; ')}` : ''}`;
  log(`repoint: ${text}`);
  return { status: 'undone', proceed: true, lines: [text], notice: text };
}

// ── la entrada ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que `startup` y `update` corren ANTES de mirar si hay versión nueva. `want`: el valor de la llave (`unified` |
 * `separate`). `apply: false`: la política es `ask` y nadie dijo `--yes` → no se muda nada, se avisa. `manual`: lo corre
 * una persona (`update`): reintenta aunque la causa anotada sea la misma. `dryRun`: dice qué haría. `backup(reason, to)`
 * toma la copia de seguridad y devuelve algo, o `null`; `finish(copia)` la cierra; `write()` graba el estado.
 * Cambia `state` en memoria (y lo graba con `write` en los dos puntos que importan si la sesión muere).
 * @returns {{ status: string, proceed: boolean, lines: string[], notice: string|null }}  `proceed: false` = ninguna
 *   fuente se mueve en esta corrida
 */
function run(ctx, state, o = {}) {
  if (!o.dryRun) return decide(ctx, state, o);
  // `--dry-run` dice qué haría y NO deja nada: lo que la decisión anota en el estado en memoria (reconocer un clon ya
  // re-apuntado, soltar una constancia vieja) se saca antes de volver, porque quien llama graba el estado al terminar.
  // Sin esto, un `update --dry-run` con la llave de una sola vez deja grabada una adopción sin origen
  const skills = sourceOf(state, 'agent_skills');
  const had = Object.prototype.hasOwnProperty.call(state, 'repoint');
  const kept = had && state.repoint ? JSON.parse(JSON.stringify(state.repoint)) : state.repoint;
  const source = skills ? { url: skills.url, commit: skills.commit, previous: skills.previous } : null;
  try { return decide(ctx, state, o); } finally {
    if (had) state.repoint = kept; else delete state.repoint;
    if (skills && source) { skills.url = source.url; skills.commit = source.commit; if (source.previous === undefined) delete skills.previous; else skills.previous = source.previous; }
  }
}

/**
 * ¿El clon dejó de seguir al repo al que el estado dice que se re-apuntó? Devuelve su `origin` de ahora, o `null` si lo
 * sigue —o si no se pudo mirar: sin saberlo no se suelta nada—. «Lo sigue» = su origin es el repo unificado de ahora o
 * el que quedó anotado al re-apuntar. El caso al revés del que cubre `adopt`: el clon se volvió a clonar del repo viejo,
 * o alguien le devolvió el `origin` a mano, y el estado seguiría diciendo «re-apuntado».
 */
function strayed(state, skills, harness, env) {
  const applied = state.repoint && state.repoint.applied;
  if (!applied) return null;
  const here = SRC.origin(skills.dir, { env });
  if (!here) return null;
  const id = SRC.remoteIdentity(here);
  const follows = [applied.to && applied.to.url, harness && harness.url].filter(Boolean).some((u) => SRC.remoteIdentity(u) === id);
  return follows ? null : here;
}

function decide(ctx, state, o) {
  const none = { status: 'none', proceed: true, lines: [], notice: null };
  const log = o.log || (() => {});
  const skills = sourceOf(state, 'agent_skills');
  if (!skills || !skills.dir) return none;   // la máquina de un solo árbol: no hay clon aparte
  const harness = sourceOf(state, 'harness') || (state.tree ? { dir: state.tree } : null);

  // ANTES que nada: ¿ese «clon de skills» es el clon del arnés? Entonces no hay clon aparte, diga lo que diga el estado,
  // y acá no se toca nada: ni ida, ni vuelta, ni deshacer una mudanza en curso, ni reconocerla (ver la cabecera). Si no
  // se pudo MIRAR, tampoco: es pasajero (git que no contestó a tiempo, un disco que no responde) y se reintenta en el
  // arranque siguiente; lo anotado de la mudanza queda como estaba
  const rel = cloneRelation(skills, harness, ctx.env);
  if (rel.status !== 'distinct') {
    const applied = Boolean(state.repoint && state.repoint.applied);
    const pendingHere = Boolean(state.repoint && state.repoint.pending);
    if (!pendingHere && (o.want === 'unified') === applied) return none;   // nada que mudar: nada que decir acá
    if (rel.status === 'unknown') {
      return block(state, o.want === 'unified' ? 'unified' : 'separate', skills.dir, {
        cause: 'clone-unknown', transient: true,
        reason: `no pude mirar si ${skills.dir} es el clon del arnés (${harness.dir}): ${rel.reason}; sin saberlo no se re-apunta, no se vuelve ni se deshace nada`,
      }, o);
    }
    return block(state, o.want === 'unified' ? 'unified' : 'separate', skills.dir, {
      cause: 'same-clone', fix: INSTALL_CMD,
      reason: `${skills.dir} ya no es un clon aparte: es el clon del arnés (${harness.dir}), y sobre ese clon no se re-apunta ni se deshace nada; el estado todavía lo lista como otra fuente, e install vuelve a detectarlas`,
      facts: [real(skills.dir), real(harness.dir)],
    }, o);
  }

  // una mudanza que quedó «en curso» (la sesión murió en el medio): se deshace antes de decidir nada
  const pending = state.repoint && state.repoint.pending;
  if (pending && pending.from) {
    if (o.dryRun) return { status: 'pending', proceed: false, lines: [`hay una mudanza del clon de skills en curso (${pending.step}, ${pending.at}): update la deshace antes de seguir`], notice: null };
    log(`repoint: encontré una mudanza en curso (${pending.step}, ${pending.at}): la deshago antes de seguir`);
    const u = undo(skills, pending.from, { env: ctx.env, to: pending.to && pending.to.commit });
    if (!u.ok) {
      const text = `una mudanza del clon de skills (${skills.dir}) quedó a medias y no pude deshacerla (${u.reason}): el próximo arranque lo vuelve a intentar; ya: ${UPDATE_CMD}`;
      log(`repoint: ${text}`);
      return { status: 'blocked', proceed: false, lines: [text], notice: text };
    }
    skills.url = pending.from.url; skills.commit = pending.from.commit; skills.previous = pending.from.previous === undefined ? null : pending.from.previous;
    delete state.repoint;
    for (const n of u.notes) log(`repoint: ${n}`);
    try { if (o.write) o.write(); } catch (e) { log(`repoint: no pude grabar el estado ahora (${e.code || e.message})`); }
  }

  // el estado se contrasta con el clon de verdad en cada pasada: una mudanza «aplicada» cuyo clon ya no sigue al repo
  // unificado no es una mudanza aplicada. Se suelta (el clon manda), y lo que siga se decide con lo que hay. Si el clon
  // volvió justo al remoto del que venía (la URL que la propia ida anotó), la fuente queda fijada ahí otra vez: es lo que
  // habría dejado la vuelta. Cualquier otro origin no se fija solo: lo dicen `update` y `doctor` («el origen cambió»)
  const gone = strayed(state, skills, harness, ctx.env);
  if (gone) {
    const applied = state.repoint.applied;
    const home = applied.from && applied.from.url && SRC.remoteIdentity(applied.from.url) === SRC.remoteIdentity(gone);
    log(`repoint: el estado daba ${skills.dir} por re-apuntado al repo unificado y ese clon sigue a ${gone}: suelto esa constancia (el clon manda)${home ? '; es el remoto del que venía: la fuente queda fijada ahí' : ''}`);
    if (home) skills.url = gone;
    delete state.repoint.applied;
    if (state.repoint.blocked) delete state.repoint.blocked;
    tidy(state);
  }

  // el estado se perdió (desinstalar y volver a instalar) y el clon ya apunta al repo unificado: se reconoce
  if (!(state.repoint && state.repoint.applied)) adopt(ctx, state, skills, o.want, log);
  const applied = Boolean(state.repoint && state.repoint.applied);
  const need = o.want === 'unified' ? (applied ? null : 'forward') : (applied ? 'back' : null);
  if (!need) {
    // nada que mudar: lo que estuviera anotado como «no pudo pasar» ya no dice nada
    if (state.repoint && state.repoint.blocked) { delete state.repoint.blocked; tidy(state); }
    return none;
  }
  if (o.apply === false && !o.dryRun) {
    const text = need === 'forward'
      ? `la llave update.skills_source pide re-apuntar ${skills.dir} al repo unificado: la política es «ask», aplicalo con ${UPDATE_CMD} --yes`
      : `la llave update.skills_source volvió a «separate»: para llevar ${skills.dir} de vuelta al repo viejo, ${UPDATE_CMD} --yes (la política es «ask»)`;
    return { status: 'waiting', proceed: true, lines: o.manual ? [text] : [], notice: text };
  }
  return need === 'forward' ? forward(ctx, state, o) : back(ctx, state, o);
}

// ── lo que dice doctor ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los ítems de `doctor` sobre la llave y el clon de skills: `[{ level, text }]`. `want`: el valor de la llave (`null` si
 * la política está mal escrita). `health`: corre bajo la comprobación de salud — un intento anotado es historia, no la
 * salud de este árbol, y baja de rojo a aviso (como `failed`). `when`: quién va a hacer la mudanza pendiente, dicho por
 * quien conoce la política (en modo desarrollador o con la actualización apagada no la hace nadie; con `ask`, la persona).
 * Lo que dice del clon lo CONTRASTA con el clon (sólo lecturas, con `env`): «re-apuntado» se dice si su `origin` es de
 * verdad el del repo unificado, no porque el estado lo diga (un clon vuelto a clonar del repo viejo saldría con
 * un ✓). Si no se pudo mirar el clon, vale lo que dice el estado.
 */
function doctorItems(state, want, { health = false, when = null, env } = {}) {
  const skills = sourceOf(state, 'agent_skills');
  if (!skills || !skills.dir || !want) return [];
  const items = [];
  const red = health ? 'warn' : 'fail';
  const rp = state.repoint || {};
  const dir = skills.dir;
  const next = when || `lo hace el próximo arranque (ya: ${UPDATE_CMD})`;
  const harness = sourceOf(state, 'harness') || (state.tree ? { dir: state.tree } : null);
  const rel = cloneRelation(skills, harness, env);
  if (rel.status === 'unknown') {
    // sin saber si es el clon del arnés, nada de lo que sigue se puede afirmar del clon: se dice eso, y lo anotado
    items.push({ level: 'warn', text: `no pude mirar si ${dir} es el clon del arnés (${harness.dir}): ${rel.reason} — la mudanza del clon de skills no toca nada hasta poder mirarlo (se reintenta en cada arranque)` });
    if (rp.pending) items.push({ level: red, text: `una mudanza del clon de skills (${dir}) quedó en curso (${rp.pending.step}, ${rp.pending.at || '—'}): se deshace cuando se pueda mirar el clon; ya: ${UPDATE_CMD}` });
    if (rp.blocked && rp.blocked.cause === 'clone-unknown') items.push({ level: red, text: blockedText(rp.blocked.direction, dir, rp.blocked) });
    return items;
  }
  if (rel.status === 'same') {
    items.push({ level: 'warn', text: `${dir} ya no es un clon aparte (es el clon del arnés, ${harness.dir}) y el estado todavía lo lista como otra fuente: ${INSTALL_CMD} vuelve a detectarlas` });
    if (rp.blocked && rp.blocked.cause === 'same-clone') items.push({ level: red, text: blockedText(rp.blocked.direction, dir, rp.blocked) });
    return items;
  }
  if (rp.pending) items.push({ level: red, text: `una mudanza del clon de skills (${dir}) quedó en curso (${rp.pending.step}, ${rp.pending.at || '—'}): el próximo arranque la deshace; ya: ${UPDATE_CMD}` });
  const b = rp.blocked || null;
  const gone = rp.applied ? strayed(state, skills, harness, env) : null;
  if (gone) {
    // el estado dice «re-apuntado» y el clon sigue a otro remoto: no es un ✓, y tampoco «sigue en el repo unificado»
    if (want === 'unified') items.push({ level: 'warn', text: `la llave update.skills_source pide el repo unificado y ${dir} no lo sigue (su origin es ${gone}; el estado lo daba por re-apuntado) — ${next}` });
    else items.push({ level: 'warn', text: `${dir} ya no sigue al repo unificado (su origin es ${gone}) y el estado todavía lo da por re-apuntado: el próximo arranque suelta esa constancia (ya: ${UPDATE_CMD})` });
  } else if (rp.applied) {
    const a = rp.applied;
    if (want === 'unified') {
      const came = a.from && a.from.url ? `venía de ${a.from.url} @ ${sha7(a.from.commit)}; se deshace con la llave update.skills_source en «separate»` : 'sin constancia de dónde venía: la vuelta no se puede hacer sola';
      items.push({ level: 'ok', text: `dos clones, re-apuntados: ${dir} lee del repo unificado (${(a.to && a.to.url) || '—'}) desde ${a.at || '—'}; ${came}` });
      if (fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh'))) items.push({ level: 'warn', text: `el clon re-apuntado ${dir} muestra el instalador (perdió su vista reducida): no lo corras desde ahí — duplicaría los hooks` });
    } else if (b && b.direction === 'separate') items.push({ level: red, text: blockedText('separate', dir, b) });
    else if (!rp.pending) items.push({ level: 'warn', text: `la llave update.skills_source volvió a «separate» y ${dir} sigue en el repo unificado: todavía no volvió al repo viejo — ${next}` });
  } else if (want === 'unified') {
    if (b && b.direction === 'unified') items.push({ level: red, text: blockedText('unified', dir, b) });
    else if (!rp.pending) items.push({ level: 'warn', text: `la llave update.skills_source pide el repo unificado y ${dir} todavía no se re-apuntó — ${next}` });
  }
  return items;
}

/**
 * Lo que `doctor` dice de una fuente de la que salen las skills cuando lo último traído no las trae: el texto,
 * o `null`. Sólo lecturas del clon.
 */
function withoutSkillsNote(state, src, { env } = {}) {
  // «no pude leer» se DICE: callarlo sería darlo por «de acá no salen las skills»
  const from = skillsFrom(state, src, { env });
  if (from.status === 'unknown') return `fuente ${src.name}: no pude mirar si de acá salen las skills de esta máquina — ${from.reason}: update no avanza esta fuente hasta poder leerlo`;
  if (from.status !== 'yes') return null;
  const tip = SRC.refState(src.dir, `refs/remotes/origin/${src.ref || MAIN}`, { env });
  const head = SRC.head(src.dir, { env });
  if (tip.status !== 'ok' || !head || tip.sha === head) return null;
  const here = skillsAt(src.dir, 'HEAD', { env });
  const there = skillsAt(src.dir, tip.sha, { env });
  if (here.status === 'unknown' || there.status === 'unknown') {
    const what = here.status === 'unknown' ? `lo instalado (HEAD, ${sha7(head)})` : `lo publicado (origin/${src.ref || MAIN}, ${sha7(tip.sha)})`;
    return `fuente ${src.name}: no pude mirar si ${what} trae las skills (${(here.status === 'unknown' ? here : there).reason}): update no la aplica hasta poder leerlo`;
  }
  if (here.status !== 'yes' || there.status !== 'no') return null;
  if (SRC.ancestor(src.dir, tip.sha, head, env) === true) return null;   // lo traído ya está contenido: no hay nada que aplicar
  return `fuente ${src.name}: lo publicado (origin/${src.ref || MAIN}, ${sha7(tip.sha)}) no trae las skills (${SKILLS_MARK}): no se aplica; esta máquina sigue en ${sha7(head)}, con sus skills`;
}

module.exports = {
  VISIBLE, SKILLS_MARK, SPARSE_TEXT, PHRASE, NOTICE, UPDATE_CMD, INSTALL_CMD,
  skillsAt, skillsFrom, hasSkills, providesSkills, sameClone, cloneRelation, run, undo, doctorItems, withoutSkillsNote, blockedText,
  sparseOn, sparseOff, sparseBefore, sparseEffective, pathsBetween, notTracked, remoteAnswers, inView,
};
