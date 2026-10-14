'use strict';
// team.js — la capa del equipo sobre la versión bajada (story 8.25, tanda A1a).
//
// Qué resuelve: la versión publicada es la copia pública y no trae lo que es del equipo —el perfil (team-profile.json; el
// nombre de antes, perfil-equipo.json, sigue valiendo)
// y la llave del buzón (scripts/metrics/corridas-buzon.json)—; la primera máquina mudada (2026-10-08) quedó con las
// integraciones, el paquete por defecto y la política de fábrica. Acá vive la capa: un segundo repo privado (GitHub o Azure),
// chico, con esos dos archivos y su declaración (team-layer.json), que `install --version … --team <org>/<repo>`, `update` y
// `migrate --to-home` bajan con el mismo permiso que el arnés, verifican contra el commit SEGÚN GITHUB y apilan sobre la
// versión pública en `incoming/<versión>/` ANTES del cambio. Nada se funde en `~/.tycon/config.json`: los valores quedan
// con origen «perfil» y un cambio futuro del repo del equipo le llega a cada máquina.
//
// Dos momentos, a propósito (revisión adversarial de la spec, W1): `resolveTeam` RESUELVE y valida —ref, commit, lista del
// árbol, lista cerrada, declaración, perfil— sin escribir ni registrar (así `install` y `migrate` pueden salir 1 con la HOME
// idéntica); `fetchTeam` + `stackTeam` bajan y apilan, después del «¿Instalo?» y de las skills de terceros.
//
// La lista cerrada se juzga sobre la lista del árbol de GitHub (`git/trees/<tree>?recursive=1`), que trae el MODO de cada
// ruta: un enlace (120000) o un submódulo (160000) se nombran ahí; del comprimido no se puede saber que una ruta es un
// submódulo (W/C3). Nada ejecutable entra: ni hooks, ni `scripts/**` salvo dos rutas exactas de datos —la llave y el mapa de
// renombres (AC 33), que se valida contra la versión que va a quedar con el lector de ESA versión (`renamesProblems`)—.
//
// Sólo `require` dentro de scripts/setup/harness/ al cargar (la copia fija de arranque copia la carpeta entera); el lector
// de comprimidos y el hash de árbol se cargan al usarlos, y release.js (que a su vez carga este archivo) también.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TH = require('./tycon-home.js');
const VO = require('./version-order.js');
const GA = require('./github-auth.js');

const lib = (name) => require(path.join(__dirname, '..', '..', 'lib', name));
// release.js carga este archivo y este archivo usa release.js (readManifest, explainFailure): la vuelta se resuelve al usarlo,
// y se nombra por ruta armada para que la copia fija de arranque (que ordena los módulos por sus `require('./…')`) no vea un
// ciclo: team.js va antes que release.js en esa copia (170 #12506, tycon-home T2b)
const rel = () => require(path.join(__dirname, 'release.js'));

/**
 * El perfil del equipo se llama `team-profile.json` (lo que lee la máquina se nombra en inglés: guides/nombres-en-ingles.md).
 * El nombre de antes, `perfil-equipo.json`, sigue valiendo sin fecha de retiro: vive en repos del equipo que el arnés no
 * controla, y una máquina con una versión anterior sólo conoce ése. Se busca primero el nuevo; si no está, el de antes, con
 * un aviso de una línea que dice cómo renombrarlo. Con los dos, gana el nuevo, el de antes no se apila y se avisa.
 */
const PROFILE_PATH = 'team-profile.json';
const LEGACY_PROFILE_PATH = 'perfil-equipo.json';
const PROFILE_PATHS = Object.freeze([PROFILE_PATH, LEGACY_PROFILE_PATH]);
const isProfilePath = (p) => PROFILE_PATHS.includes(p);
/** El perfil entre los archivos de una lista (`[{ path }]`): el del nombre nuevo si está; si no, el de antes; o undefined. */
const profileFileOf = (files) => (files || []).find((f) => f && f.path === PROFILE_PATH) || (files || []).find((f) => f && f.path === LEGACY_PROFILE_PATH);
/**
 * El perfil del equipo en la raíz de un árbol: `{ file, name, exists, legacy, both }`. Sin ninguno, `file` es la ruta del
 * nombre nuevo y `exists` es false. Nunca tira.
 */
function profileIn(dir) {
  const has = (n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch (_) { return false; } };
  const fresh = has(PROFILE_PATH);
  const legacy = has(LEGACY_PROFILE_PATH);
  const name = fresh || !legacy ? PROFILE_PATH : LEGACY_PROFILE_PATH;
  return { file: path.join(dir, name), name, exists: fresh || legacy, legacy: legacy && !fresh, both: fresh && legacy };
}
/**
 * El aviso de una línea sobre el nombre del perfil, o null. `where`: 'layer' (el repo del equipo: el cambio va con la versión
 * mínima de team-layer.json, o una máquina con una versión anterior rechazaría la capa entera) o 'tree' (un clon con el perfil).
 */
function profileNameNotice({ legacy = false, both = false } = {}, where = 'tree') {
  if (both) return `el perfil del equipo está con los dos nombres: vale ${PROFILE_PATH} y ${LEGACY_PROFILE_PATH} no se usa — borralo (git rm ${LEGACY_PROFILE_PATH})`;
  if (!legacy) return null;
  const gate = where === 'layer' ? ' en el repo del equipo, y en el mismo commit subí requires.harness de team-layer.json a la versión de este arnés' : '';
  return `el perfil del equipo usa el nombre de antes (${LEGACY_PROFILE_PATH}): sigue andando; para pasarlo al nuevo, git mv ${LEGACY_PROFILE_PATH} ${PROFILE_PATH}${gate}`;
}
/** Los archivos de la A1, por su ruta exacta (D3): se aceptan aunque la versión no traiga su manifiesto. El perfil, con sus dos nombres. */
const A1_PATHS = Object.freeze([PROFILE_PATH, LEGACY_PROFILE_PATH, 'scripts/metrics/corridas-buzon.json']);
/** El mapa de renombres (tanda A2b-AC33, AC 33): un dato que lee scripts/lib/legacy-names.js, validado contra la versión. */
const RENAMES_PATH = 'scripts/lib/renames.json';
/** Dónde vive cada repo del arnés de la organización (story 8.26, tanda J): la escribe la página de configuración y la valida
 * el lector de la versión que va a quedar (scripts/lib/team-repos.js). */
const TEAM_REPOS_PATH = 'team-repos.json';
/** Las rutas exactas de la lista cerrada. La copia que leen las personas y las pruebas vive junto a harness-team.test.js (que comprueba que coinciden). */
const CLOSED_PATHS = Object.freeze([...A1_PATHS, RENAMES_PATH, TEAM_REPOS_PATH]);
/**
 * Tanda A2a (AC 17): además, por patrón —el manifiesto de un paquete, un agente y los `.md` de una skill—; sólo texto, nunca
 * un guion, un hook, un comando ni una traducción a Codex. Es la regla POR RUTA; la del conjunto (cada archivo de skills/
 * con su SKILL.md a una, dos o tres carpetas, nada dentro de una skill de la versión, rutas iguales sin caja, los topes) la
 * aplica `planTeam`. La copia que leen las personas: scripts/tests/fixtures/team-layer-paths.json (T17 compara las dos).
 *
 * Y el texto del alta del equipo (story 8.26, tanda H1c · AC 66): los `.md` de la RAÍZ de onboarding/ —lo que un dev nuevo le
 * pega al asistente—, que con la versión pública ya no llegan a ninguna máquina. Un solo nivel y sólo `.md`: la charla
 * (onboarding/mini-class/, con HTML) y cualquier otra cosa bajo onboarding/ siguen afuera y rechazan la capa. Nadie lo ejecuta
 * ni lo carga como agente o skill, así que no se juzga por su contenido; la versión no trae esa carpeta (`TEAM_ONLY_TOPS`).
 */
const SEG = '[A-Za-z0-9._-]+';
// En onboarding/ no entran los nombres que un asistente carga SOLO como instrucciones cuando alguien abre una sesión
// parada en esa carpeta (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`…), se escriban
// con la caja que se escriban: el texto del alta se lee, no se obedece (revisor de seguridad de la tanda H1c). Va en el
// patrón, sin banderas, para que la copia que leen las personas (team-layer-paths.json) diga exactamente lo mismo.
// (`agents?`: `AGENTS.md` y el singular `AGENT.md`, que cargan otras herramientas; el `?` va tal cual al patrón)
const LOADED_ALONE = Object.freeze(['claude', 'agents?', 'gemini', 'qwen', 'crush', 'warp']);
const anyCase = (word) => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join('');
const LAYER_PATTERNS = Object.freeze([
  new RegExp(`^packs/${SEG}/pack\\.json$`),
  new RegExp(`^agents/${SEG}\\.md$`),
  new RegExp(`^skills/(?:${SEG}/){1,5}${SEG}\\.md$`),
  new RegExp(`^onboarding/(?!(?:${LOADED_ALONE.map(anyCase).join('|')})(?:\\.[A-Za-z0-9_-]+)*\\.md$)${SEG}\\.md$`),
]);
/** Las carpetas de primer nivel que existen SÓLO por la capa (la versión no las trae): vacías, se van ellas también (`pruneEmptyDirs`). */
const TEAM_ONLY_TOPS = Object.freeze(['onboarding']);
const MANIFEST_NAME = '.tycon-team.json';
const DECLARATION = 'team-layer.json';
const TEAM_REF = 'main';
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 300;
/** Cuántas carpetas por debajo de skills/ puede estar la raíz de una skill de la capa (`skills/<s>`, `skills/<g>/<s>`, `skills/projects/<c>/<s>`). */
const MAX_SKILL_DEPTH = 3;
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const TARBALL_BUDGET_S = 120;
const PER_ITEM_BUDGET_S = 3;
const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const REQUIRES_RE = /^>=\s*(\d{4}\.\d{2}\.\d{2}\.\d+)$/;
// (.gitattributes NO: `git archive` —el comprimido que GitHub arma— aplica export-ignore, export-subst y eol, y entonces el
// árbol calculado de lo bajado nunca da el del commit: la capa se rechazaría siempre. Pase adversarial, clases 9 y 10)
const ROOT_NOT_STACKED = /^(?:team-layer\.json|README[^/]*|LICENSE[^/]*|\.gitignore)$/;
/** Las tres llaves que no viajan en la capa hasta la A2: dos describen la transición de los clones; la otra muda solo a todo el equipo. */
const FORBIDDEN_PROFILE_KEYS = Object.freeze(['update.source', 'update.skills_source', 'install.home']);
const CACHE_DIR_NAME = 'team';

// ── la lista FIJA de skills con algo más que texto (tanda A2c · AC 31) ───────────────────────────────────────────────
/** Un dato de la versión, al lado de este archivo: la capa no lo trae ni lo puede cambiar. */
const EXTRAS_FILE = path.join(__dirname, 'team-skill-extras.json');
const MAX_EXTRAS = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REL_RE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
/** Los problemas de la lista (vacía si vale): la forma de cada entrada y el máximo de 3 lo decide el código, no el archivo. */
function validateExtras(j) {
  const out = [];
  if (!isObject(j) || j.schema !== 1 || !Array.isArray(j.entries)) return ['la lista fija tiene que ser { schema: 1, entries: [...] }'];
  if (j.entries.length > MAX_EXTRAS) out.push(`la lista fija trae ${j.entries.length} entradas: como máximo ${MAX_EXTRAS} (sumar una es una decisión revisada de la versión)`);
  const seen = new Set();
  j.entries.forEach((e, i) => {
    const at = `entrada ${i + 1}`;
    if (!isObject(e)) { out.push(`${at}: no es un objeto`); return; }
    if (typeof e.skill !== 'string' || !/^skills\/(?:[A-Za-z0-9._-]+\/){0,2}[A-Za-z0-9._-]+$/.test(e.skill)) out.push(`${at}: skill tiene que ser skills/<s> (hasta tres carpetas)`);
    else if (seen.has(foldPath(e.skill))) out.push(`${at}: ${e.skill} está dos veces`); else seen.add(foldPath(e.skill));
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) out.push(`${at}: falta su motivo (reason)`);
    // una fecha que no existe (`2027-13-45`) dejaría el aviso de la revisión apagado para siempre: se valida que sea un día real
    // (pase adversarial de la A2c, clases 6 y 12)
    const realDay = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
    if (!isObject(e.review) || !Number.isInteger(e.review.every_months) || e.review.every_months < 1 || typeof e.review.next !== 'string' || !realDay(e.review.next)) out.push(`${at}: review tiene que traer every_months y next (YYYY-MM-DD, un día que exista)`);
    const rels = (k, need) => { const v = e[k] === undefined && !need ? [] : e[k]; if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && REL_RE.test(x) && !x.split('/').some((s) => /^\.+$/.test(s)))) out.push(`${at}: ${k} tiene que ser una lista de rutas relativas a la skill`); };
    rels('folders', true); rels('except', false); rels('allow', false); rels('data', true); rels('legacyData', true);
    if (Array.isArray(e.legacyData) && e.legacyData.some((x) => typeof x === 'string' && x.includes('/'))) out.push(`${at}: legacyData son nombres de la raíz de la skill`);
    if (e.userContent !== undefined && !(Array.isArray(e.userContent) && e.userContent.every((x) => typeof x === 'string' && x))) out.push(`${at}: userContent tiene que ser una lista`);
    if (!Number.isInteger(e.maxBytes) || e.maxBytes < 1 || e.maxBytes > 4 * MAX_TOTAL_BYTES) out.push(`${at}: maxBytes tiene que ser un entero positivo (hasta 4 MB)`);
    const dh = e.dataHome;
    if (!isObject(dh) || typeof dh.env !== 'string' || !/^[A-Z][A-Z0-9_]{2,40}$/.test(dh.env) || typeof dh.dir !== 'string' || !/^\.[A-Za-z0-9._-]+$/.test(dh.dir) || typeof dh.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(dh.file)) out.push(`${at}: dataHome tiene que ser { env, dir: .<carpeta>, file }`);
  });
  return out;
}
let extrasCache = null;
/** La lista de la versión: `{ ok, entries, problem }`. Inválida → sin entradas y con su motivo (la capa con skills se rechaza: falla cerrada). Nunca tira. */
function loadExtras(file = EXTRAS_FILE) {
  if (file === EXTRAS_FILE && extrasCache) return extrasCache;
  let r;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = validateExtras(j);
    r = bad.length ? { ok: false, entries: [], problem: `la lista fija de la versión (${path.basename(file)}) no vale: ${bad.join(' · ')}` } : { ok: true, entries: j.entries, problem: null };
  } catch (e) { r = { ok: false, entries: [], problem: `la lista fija de la versión (${path.basename(file)}) no se lee (${(e && (e.code || e.message)) || e})` }; }
  if (file === EXTRAS_FILE) extrasCache = r;
  return r;
}
/** La entrada de la lista cuya carpeta contiene la ruta (sin caja), o null. */
function extrasEntryFor(p, entries = loadExtras().entries) {
  const f = foldPath(p);
  return entries.find((e) => f.startsWith(`${foldPath(e.skill)}/`)) || null;
}
/** Una ruta dentro de una skill de la lista: `null` si su lista blanca la admite; si no, el motivo. */
const EXTRAS_PATH_RE = new RegExp(`^skills/(?:${SEG}/){1,5}${SEG}$`);
function extrasPathProblem(p, e) {
  const why = `${e.skill} es de la lista fija de la versión (team-skill-extras.json): sólo entran los .md de su raíz y de ${e.folders.join('/, ')}/${(e.except || []).length ? ` (salvo ${e.except.join('/, ')}/)` : ''} y sus datos ${(e.data || []).join(', ')}`;
  // el mismo juego de caracteres y la misma profundidad que las demás skills (pase adversarial de la A2c, clase 10): lo que
  // Windows no puede escribir (`?`, `<`, `|`, un salto de línea, una letra fuera de ASCII) o más de 5 carpetas, no entra
  if (!EXTRAS_PATH_RE.test(String(p))) return `${why} — la ruta trae caracteres o carpetas que la capa no admite ([A-Za-z0-9._-], hasta 5 carpetas): en Windows no se podría escribir igual`;
  // todo SIN caja y sin puntos ni espacios finales por tramo (foldPath), como lo compara un disco de Mac o Windows: una carpeta
  // excluida escrita con otra caja (`rules/Custom/`) cae en la misma carpeta (pase adversarial de la A2c, clases 1, 11 y 14)
  const rel = foldPath(String(p).slice(e.skill.length + 1));
  const F = (xs) => (xs || []).map(foldPath);
  const inDir = (d) => rel === d || rel.startsWith(`${d}/`);
  if (F(e.data).includes(rel)) return null;
  if (F(e.allow).includes(rel)) return null;
  if (F(e.legacyData).includes(rel)) return `${why} — ${String(p).slice(e.skill.length + 1)} es la conexión de un dev: su lugar es ~/${e.dataHome.dir}/${e.dataHome.file}`;
  if (!rel.endsWith('.md')) return why;
  if (!rel.includes('/')) return null;
  if (F(e.except).some(inDir)) return why;
  if (F(e.folders).some((d) => rel.startsWith(`${d}/`))) return null;
  return why;
}
/** ¿Pasó la fecha de revisión de la entrada? (informativa: nunca rechaza nada) */
function extrasReviewDue(e, now = new Date()) {
  const t = Date.parse(`${e && e.review && e.review.next}T00:00:00Z`);
  return Number.isFinite(t) && now.getTime() >= t;
}
/**
 * La casa de los datos de una entrada, con el HOME y el entorno de QUIEN LLAMA (nunca los de la máquina): la variable de la
 * entrada si es una ruta absoluta; si no, `<home>/<dir>`. `{ dir, file, from: 'env'|'default', ignored }` (`ignored`: el
 * motivo por el que la variable no se usó).
 */
function dataHomeOf(e, { home = os.homedir(), env = process.env } = {}) {
  const v = env && typeof env[e.dataHome.env] === 'string' ? env[e.dataHome.env].trim() : '';
  let ignored = null;
  if (v && path.isAbsolute(v)) return { dir: v, file: path.join(v, e.dataHome.file), from: 'env', ignored };
  if (v) ignored = `${e.dataHome.env} dice «${v}» y no es una ruta absoluta: se ignora`;
  const dir = path.join(home, e.dataHome.dir);
  return { dir, file: path.join(dir, e.dataHome.file), from: 'default', ignored };
}

/** ¿La ruta puede ser de la capa (regla POR RUTA)? `null` si sí; si no, el motivo. Pura: no requiere nada fuera de esta carpeta. */
// los nombres que Windows reserva para dispositivos (con o sin extensión: `con.md` también es CON)
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
function layerPathProblem(p) {
  const s = String(p || '');
  // dentro de una skill de la lista fija, manda SU lista blanca (tanda A2c · AC 31)
  const ex = s.startsWith('skills/') ? extrasEntryFor(s) : null;
  if (ex) { const why = extrasPathProblem(s, ex); if (why) return why; }
  else if (!CLOSED_PATHS.includes(s) && !LAYER_PATTERNS.some((re) => re.test(s))) return `fuera de la lista cerrada de la capa (${CLOSED_PATHS.join(', ')}; packs/<paquete>/pack.json, agents/<nombre>.md, onboarding/<nombre>.md y los .md de una skill bajo skills/)`;
  // en Windows `x.` es la carpeta `x` y `con.md` es un dispositivo: una ruta así pisaría otra sin que nada lo vea (revisor de seguridad, A2a)
  const bad = s.split('/').find((seg) => seg.endsWith('.') || WINDOWS_RESERVED.test(seg));
  if (bad) return `el tramo «${bad}» termina en punto o es un nombre reservado de Windows: en ese disco sería otro archivo`;
  return null;
}
const isLayerPath = (p) => layerPathProblem(p) === null;
/** La forma de comparar dos rutas o dos nombres como los compara un disco de Mac o Windows: sin caja, normalizada (NFC), sin puntos finales por tramo. */
const foldPath = (s) => String(s || '').normalize('NFC').toLowerCase().split('/').map((seg) => seg.replace(/[. ]+$/, '')).join('/');
/** Los nombres se comparan además sin acentos (`diseño` y `diseno` son el mismo para quien lee la lista). */
const foldName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const nowIso = () => new Date().toISOString();
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const isSafe = (p) => require('./layer.js').isSafeLayerPath(p);
/**
 * El blob de git de unos bytes (`sha1("blob <n>\0" + bytes)`), calculado ACÁ y no con scripts/lib/git-tree-hash.js: `uninstall` y
 * `rollback` también corren desde la copia fija de arranque, que trae scripts/setup/harness/ y no scripts/lib/ (A1b, revisión
 * adversarial C2: el `require` del hash tiraba con la máquina desinstalada a medias).
 */
const blobOf = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
/** El prefijo de los temporales del refresco en el lugar: `doctor` no los cuenta «de más» y el refresco siguiente los borra. */
const TMP_PREFIX = '.tycon-team.tmp-';
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin espera */ } };

// ── el nombre del repo del equipo ─────────────────────────────────────────────────────────────────────────────────

/**
 * El repo del equipo, en una de sus formas: `org/nombre` o `https://github.com/<org>/<repo>` (GitHub) o
 * `https://dev.azure.com/<org>/<proyecto>/_git/<repo>` (Azure DevOps; la fuente de TYCON). `{ ok, host, org, name, repo, url
 * [, project] }` —`repo` es el identificador que guarda el estado: `org/nombre` en GitHub, la URL en Azure— o `{ ok: false, problem }`.
 */
function parseTeam(option) {
  const s = option === undefined || option === null ? '' : String(option).trim();
  if (/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\//i.test(s)) {
    const a = require('./team-azure.js').parseAzureUrl(s);
    return a.ok ? { ok: true, host: 'azure', org: a.org, project: a.project, name: a.name, repo: a.url, url: a.url } : { ok: false, problem: a.problem };
  }
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(s) || /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s);
  // «.» y «..» pasan la forma pero no son nombres: en la URL del pedido cambiarían de endpoint (pase adversarial, clase 7)
  if (!m || [m[1], m[2]].some((x) => /^\.+$/.test(x))) return { ok: false, problem: `--team tiene que ser org/nombre o la URL del repo del equipo (https://github.com/<org>/<repo>, o https://dev.azure.com/<org>/<proyecto>/_git/<repo>); dice «${s.replace(/^(https?:\/\/)[^@/]+@/, '$1')}»` };
  return { ok: true, host: 'github', org: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` };
}

/**
 * Abre la fuente del repo del equipo según su forma: la credencial, el cliente y las dos operaciones (`resolve`, `fetch`) con
 * la misma firma para GitHub y Azure DevOps. `{ ok: false, code, reason, missing? }` cuando la forma no vale (2) o falta la
 * credencial de Azure (1, con la acción: nunca se calla). `publicRepo` (GitHub): el otro repo que el permiso tiene que ver.
 */
function openSource(ident, { ctx, deadlineAt = null, publicRepo = null } = {}) {
  const src = parseTeam(ident);
  if (!src.ok) return { ok: false, code: 2, reason: src.problem };
  // `deadlineAt` es el reloj de MIRAR (`resolve`). La BAJADA (`fetch`) arranca el suyo cuando empieza: no hereda lo que sobró de
  // la mirada ni de lo que quien llama hizo antes con el mismo reloj (2026-10-09: 113 archivos de Azure con el reloj de mirar)
  if (src.host === 'azure') {
    const AZ = require('./team-azure.js');
    const cred = AZ.credential(src, { env: ctx.env });
    if (!cred.ok) return { ok: false, code: 1, missing: 'credential', host: 'azure', src, reason: cred.reason };
    const c = AZ.client(src, cred, { env: ctx.env, deadlineAt });
    const down = { deadlineFor: (pending) => downloadDeadline(ctx.env, pending), itemTimeoutMs: lookBudgetS(ctx.env) * 1000 };
    return { ok: true, host: 'azure', src, credentialSource: cred.source, resolve: (o) => AZ.resolve(c, o), fetch: (r, o) => AZ.fetch(c, r, Object.assign({}, down, o)) };
  }
  const c = rel().client(ctx, { deadlineAt });
  if (c.tokenProblem) return { ok: false, code: 2, host: 'github', src, reason: c.tokenProblem };
  c.repos = publicRepo ? [publicRepo, src.repo] : [src.repo];
  return { ok: true, host: 'github', src, client: c, resolve: (o) => resolveTeam(c, src.repo, o), fetch: (r, o) => fetchTeam(c, r, Object.assign({ deadlineFor: () => downloadDeadline(ctx.env, 0) }, o)) };
}

/** El tope de MIRAR, en segundos (el de release.js: `TYCON_UPDATE_NETWORK_BUDGET_S`, 15). */
function lookBudgetS(env) { const n = Number((env || {}).TYCON_UPDATE_NETWORK_BUDGET_S); return n > 0 ? n : 15; }

/**
 * Hasta cuándo puede correr la BAJADA de la capa, contado desde ahora. Con `TYCON_RELEASE_DOWNLOAD_BUDGET_S` puesta, eso (nunca
 * menos que el de mirar). Sin ella: 120 s, o más si la fuente baja archivo por archivo (Azure) y faltan muchos — 3 s por cada
 * uno: medido contra el Azure real, 113 archivos llevaron unos 65 s (0,6 s por archivo, un proceso y una conexión por pedido).
 */
function downloadDeadline(env, pending = 0) {
  const set = Number((env || {}).TYCON_RELEASE_DOWNLOAD_BUDGET_S);
  const s = set > 0 ? set : Math.max(TARBALL_BUDGET_S, Math.ceil(pending) * PER_ITEM_BUDGET_S);
  return Date.now() + Math.max(lookBudgetS(env), s) * 1000;
}

/**
 * De dónde sale el repo del equipo, en este orden: la opción `--team`; el campo `team` del estado (ya registrado); y, sólo
 * en la mudanza, la clave `team` del `public-repos.json` del clon que la máquina deja (ese archivo no viaja en la copia).
 * `{ repo, origin }` (repo null si no hay equipo declarado) o `{ problem }`.
 */
function teamOf({ option = undefined, state = null, cloneTree = null } = {}) {
  if (option !== undefined && option !== null) {
    const p = parseTeam(option);
    return p.ok ? { repo: p.repo, origin: 'option' } : { problem: p.problem, code: 2 };   // una opción mal escrita: 2
  }
  if (state && isObject(state.team) && typeof state.team.repo === 'string' && state.team.repo) return { repo: state.team.repo, origin: 'state' };
  if (cloneTree) {
    const file = path.join(cloneTree, 'scripts', 'publishing', 'public-repos.json');
    let j = null;
    if (exists(file)) {
      // un archivo que está pero no se lee NO es «sin equipo»: es una precondición fallida (cazador de fallos silenciosos)
      // (el archivo del clon que no se lee es una precondición fallida: 1, no 2)
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { problem: `${file} del clon no se lee como JSON (${e.message}): no sé si esta máquina tiene repo del equipo; arreglalo antes de mudar`, code: 1 }; }
      if (!isObject(j)) return { problem: `${file} del clon no es un objeto: no sé si esta máquina tiene repo del equipo`, code: 1 };
    }
    if (isObject(j) && j.team !== undefined && j.team !== null) {
      const raw = String(j.team).trim();
      const full = raw.includes('/') ? raw : (typeof j.org === 'string' && j.org ? `${j.org}/${raw}` : raw);
      const p = parseTeam(full);
      if (!p.ok) return { problem: `la clave team de scripts/publishing/public-repos.json del clon no es org/nombre ni la URL del repo del equipo (https://github.com/<org>/<repo> o https://dev.azure.com/<org>/<proyecto>/_git/<repo>); dice «${raw.replace(/^(https?:\/\/)[^@/]+@/, '$1')}»`, code: 1 };
      return { repo: p.repo, origin: 'clone' };
    }
  }
  return { repo: null, origin: null };
}

// ── la lista cerrada, sobre la lista del árbol ────────────────────────────────────────────────────────────────────

/**
 * Juzga la lista del árbol del repo del equipo (la forma de `git/trees/<sha>?recursive=1`: `{ path, mode, type, sha, size }`).
 * `{ ok, files: [{ path, mode, sha, size }], problems: [{ path, reason }], declaration: { sha, size } | null, totalBytes }`.
 * Con UN problema la capa entera se rechaza (`files: []`) y todos los problemas quedan nombrados.
 */
function planTeam(entries, { publicPaths = [], thirdPartyRoots = [], truncated = false } = {}) {
  const problems = [];
  const files = [];
  let declaration = null;
  let total = 0;
  const byExtra = new Map();
  const publicFolded = new Set(publicPaths.map(foldPath));
  if (truncated) problems.push({ path: '(lista)', reason: 'GitHub devolvió la lista del árbol cortada (truncated): no se juzga una lista incompleta' });
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObject(e) || typeof e.path !== 'string' || !e.path) { problems.push({ path: JSON.stringify(e && e.path !== undefined ? e.path : e), reason: 'entrada sin ruta' }); continue; }
    if (e.type === 'tree' || e.mode === '040000') continue;
    if (e.mode === '160000' || e.type === 'commit') { problems.push({ path: e.path, reason: 'es un submódulo (160000): la capa no trae otros repos' }); continue; }
    if (e.mode === '120000') { problems.push({ path: e.path, reason: 'es un enlace (120000): la capa no trae enlaces' }); continue; }
    if (!isSafe(e.path)) { problems.push({ path: e.path, reason: 'no es una ruta segura dentro del árbol (absoluta, con «..», «.git», «\\» o «:»)' }); continue; }
    if (e.path === '.gitattributes' || e.path.endsWith('/.gitattributes')) { problems.push({ path: e.path, reason: 'un .gitattributes cambia el comprimido que GitHub arma (export-ignore, eol) y el árbol ya no da el del commit: el repo del equipo no puede traerlo' }); continue; }
    if (!e.path.includes('/') && ROOT_NOT_STACKED.test(e.path)) {
      if (e.path === DECLARATION) declaration = { sha: e.sha, size: Number(e.size) || 0 };
      continue;   // del repo del equipo, no de la máquina
    }
    // sin caja ni forma Unicode: en Mac y Windows `Skills/x` cae sobre `skills/x` (AC 17)
    if (publicFolded.has(foldPath(e.path))) { problems.push({ path: e.path, reason: 'la versión pública que va a quedar instalada ya la trae: la capa no pisa nada de la copia' }); continue; }
    const why = layerPathProblem(e.path);
    if (why) { problems.push({ path: e.path, reason: why }); continue; }
    if (e.mode && e.mode !== '100644') { problems.push({ path: e.path, reason: `tiene modo ${e.mode}: la capa trae sólo archivos de texto comunes (100644), nada que la máquina ejecute` }); continue; }
    const size = Number(e.size) || 0;
    files.push({ path: e.path, mode: e.mode || '100644', sha: e.sha, size });
    // una skill de la lista fija cuenta contra SU presupuesto, no contra el tope de 1 MB del resto (AC 31)
    const ex = e.path.startsWith('skills/') ? extrasEntryFor(e.path) : null;
    if (ex) byExtra.set(ex.skill, (byExtra.get(ex.skill) || 0) + size); else total += size;
  }
  // la lista fija que no se lee o no vale: ninguna skill de la capa entra (falla cerrada; nunca «sin excepciones» callado)
  const ext = loadExtras();
  if (!ext.ok && files.some((f) => f.path.startsWith('skills/'))) problems.push({ path: '(lista fija)', reason: `${ext.problem}: la capa con skills no se apila` });
  for (const [skill, bytes] of byExtra) {
    const ex = ext.entries.find((x) => x.skill === skill);
    if (ex && bytes > ex.maxBytes) problems.push({ path: skill, reason: `${skill} pesa ${bytes} bytes: más que su presupuesto de la lista fija (maxBytes ${ex.maxBytes})` });
  }
  // el perfil con los dos nombres: gana el nuevo y el de antes no se apila; con sólo el de antes, vale igual. Las dos cosas se
  // avisan en una línea (`notes`, que la línea del plan y la salida de install/update dicen)
  const notes = [];
  const legacyAt = files.findIndex((f) => f.path === LEGACY_PROFILE_PATH);
  if (legacyAt >= 0) {
    if (files.some((f) => f.path === PROFILE_PATH)) { total -= files[legacyAt].size; files.splice(legacyAt, 1); notes.push(profileNameNotice({ both: true }, 'layer')); }
    else notes.push(profileNameNotice({ legacy: true }, 'layer'));
  }
  problems.push(...setProblems(files.map((f) => f.path), { publicPaths, thirdPartyRoots }));
  if (!declaration) problems.push({ path: DECLARATION, reason: 'falta la declaración de la capa (team-layer.json en la raíz del repo del equipo)' });
  if (total > MAX_TOTAL_BYTES) problems.push({ path: '(total)', reason: `la capa pesa ${total} bytes${byExtra.size ? ' (sin las skills de la lista fija, que tienen su presupuesto)' : ''}: más de 1 MB en total (tope ${MAX_TOTAL_BYTES})` });
  if (files.length > MAX_FILES) problems.push({ path: '(total)', reason: `la capa trae ${files.length} archivos: más de ${MAX_FILES} archivos (tope)` });
  return { ok: problems.length === 0, files: problems.length ? [] : files, problems, declaration, totalBytes: total, notes };
}

/**
 * La regla del CONJUNTO de la lista cerrada (tanda A2a · AC 17), sobre rutas que ya pasaron la regla por ruta: dos rutas de la
 * capa que difieren sólo en la caja; cada archivo de skills/ con su SKILL.md más cercano a una, dos o tres carpetas de skills/
 * y sin otro SKILL.md de la capa más arriba; la carpeta de la skill no existe en la versión que va a quedar, no está dentro de
 * una skill suya ni de una de terceros. `[{ path, reason }]`.
 */
function setProblems(paths, { publicPaths = [], thirdPartyRoots = [] } = {}) {
  const problems = [];
  const byFold = new Map();
  for (const p of paths) { const k = foldPath(p); byFold.set(k, [...(byFold.get(k) || []), p]); }
  for (const same of byFold.values()) if (same.length > 1) for (const p of same) problems.push({ path: p, reason: `otra ruta de la capa difiere sólo en la caja (${same.filter((x) => x !== p).join(', ')}): en Mac y Windows son el mismo archivo` });
  const roots = new Set(paths.filter((p) => p.startsWith('skills/') && path.posix.basename(p) === 'SKILL.md').map((p) => path.posix.dirname(p)));
  const publicDirs = new Set();
  const publicSkills = new Set();
  for (const p of publicPaths) {
    const f = foldPath(p);
    for (let d = path.posix.dirname(f); d !== '.' && d !== ''; d = path.posix.dirname(d)) publicDirs.add(d);
    if (path.posix.basename(f) === 'skill.md') publicSkills.add(path.posix.dirname(f));
  }
  const thirdParty = thirdPartyRoots.map(foldPath);
  const ancestors = (d) => { const out = []; for (let a = path.posix.dirname(d); a !== 'skills' && a !== '.' && a !== ''; a = path.posix.dirname(a)) out.push(a); return out; };
  for (const p of paths) {
    if (!p.startsWith('skills/')) continue;
    let root = null;
    for (let d = path.posix.dirname(p); d !== 'skills' && d !== '.'; d = path.posix.dirname(d)) if (roots.has(d)) { root = d; break; }
    if (!root) { problems.push({ path: p, reason: 'no pertenece a ninguna skill de la capa: ninguna carpeta de arriba (hasta skills/) trae un SKILL.md' }); continue; }
    if (path.posix.basename(p) !== 'SKILL.md') continue;
    // de acá en adelante, una vez por skill (su SKILL.md)
    const depth = root.split('/').length - 1;
    if (depth > MAX_SKILL_DEPTH) problems.push({ path: p, reason: `la skill ${root} está a ${depth} carpetas de skills/ (hasta ${MAX_SKILL_DEPTH}: skills/<s>, skills/<grupo>/<s>, skills/projects/<cliente>/<s>)` });
    const above = ancestors(root).find((a) => roots.has(a));
    if (above) problems.push({ path: p, reason: `la skill ${root} está dentro de otra skill de la capa (${above}/SKILL.md más arriba)` });
    const r = foldPath(root);
    if (publicDirs.has(r)) problems.push({ path: p, reason: `la carpeta ${root} ya existe en la versión pública que va a quedar: la capa no mete archivos en ella` });
    const inPublic = ancestors(r).find((a) => publicSkills.has(a));
    if (inPublic) problems.push({ path: p, reason: `la skill ${root} quedaría dentro de una skill de la versión pública (${inPublic})` });
    const tp = thirdParty.find((t) => r === t || r.startsWith(`${t}/`) || t.startsWith(`${r}/`));
    if (tp) problems.push({ path: p, reason: `la skill ${root} se pisa con una skill de terceros de la versión (${tp})` });
  }
  return problems;
}

// ── el contenido de la capa (tanda A2a · AC 17, 18, 19, 26) ───────────────────────────────────────────────────────────────

/** Los saltos de línea de Unicode que un lector de YAML 1.1 corta: NEL, LS y PS (armados por código: escritos crudos romperían la expresión). */
const UNICODE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);
/** Dónde cierra un escalar entre comillas que empieza en `s[0]` (`"` con `\` de escape; `'` con `''` de escape), o -1. */
function closingQuote(s, q, from = 1) {
  for (let i = from; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } return i; }
  }
  return -1;
}
/**
 * Las claves de PRIMER NIVEL del frontmatter YAML de un `.md`, leídas como las lee un lector de YAML en lo que importa acá
 * (pase adversarial de la A2a, clases 4, 8, 10 y 11): una clave entre comillas o con espacios antes de los dos puntos es la
 * misma clave; lo indentado (un mapa anidado, un texto en bloque `|`/`>`) y lo que sigue a una comilla que abre y no cierra en
 * la línea (un texto de varias líneas) es VALOR, no clave; el comentario `# …` de un valor sin comillas no es parte de él; el
 * `---` de cierre admite espacios al final. `{ keys: { clave: valor | null }, dupes: [claves repetidas], flow }` (`flow`: el
 * bloque entero en forma de flujo `{…}`, que no se juzga) o null si no hay frontmatter. `valor` es null si es de varias líneas.
 * Exportado: build/generate.js lee con ESTE lector los agentes que traduce a Codex (tanda A2b · AC 30 b), así un agente que pasó
 * la validación de la máquina no se cae al generarse por leerse distinto.
 */
function frontmatterKeys(text) {
  const m = /^(?:﻿)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const first = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  const keys = {};
  const dupes = [];
  const exotic = [];
  // un retorno de carro SUELTO (sin \n) es salto de línea para un lector de YAML y no para este: lo que siga podría ser una clave
  // de primer nivel escondida en un valor o un comentario (revisor de seguridad, A2a, vuelta 3)
  if (/\r(?!\n)/.test(m[1])) exotic.push('retorno de carro suelto (\\r sin \\n)');
  // y los saltos de línea de Unicode (NEL, LS, PS) que un lector de YAML 1.1 también corta (vuelta 4)
  if (UNICODE_BREAKS.test(m[1])) exotic.push('salto de línea Unicode (U+0085, U+2028 o U+2029)');
  let openQuote = null;
  for (const line of lines) {
    if (openQuote) { if (closingQuote(line, openQuote, 0) >= 0) openQuote = null; continue; }   // sigue un texto de varias líneas
    if (!line.trim() || /^\s/.test(line) || line.startsWith('#')) continue;                    // anidado, bloque o comentario
    // lo que un lector de YAML convierte en una clave de primer nivel sin que se vea acá —una clave compleja (`? k` / `: v`), un
    // ancla, tag o alias delante de la clave, la fusión `<<`, un escape dentro de una clave entre comillas—: el frontmatter no se
    // juzga (revisor de seguridad, A2a, vuelta 2: `&a hooks:`, `"\x68ooks":`, `? hooks`, `<<: *a`)
    if (/^[?:]/.test(line) || /^[&!*]/.test(line) || /^(?:"[^"]*\\|<<\s*:)/.test(line)) { exotic.push(line.trim().slice(0, 40)); continue; }
    const k = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s:#'"][^:#]*?))\s*:(?:[ \t]+(.*)|$)/.exec(line);
    if (!k) continue;   // un ítem de lista u otra cosa que no es una clave de primer nivel
    const key = (k[1] !== undefined ? k[1] : k[2] !== undefined ? k[2].replace(/''/g, "'") : k[3]).trim();
    if (/^[&!*]|<</.test(key)) { exotic.push(line.trim().slice(0, 40)); continue; }
    const raw = (k[4] || '').trimStart();
    let value;
    if (raw[0] === '"' || raw[0] === "'") {
      const end = closingQuote(raw, raw[0]);
      // el valor, sin sus escapes (como lo lee un lector de YAML): '' en comillas simples; \" \\ \n \t en dobles (pase
      // adversarial de la A2b: la description llegaba a Codex con las barras)
      const SIMPLE = { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f' };
      const unescape = (v, q) => (q === "'" ? v.replace(/''/g, "'")
        : v.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["\\\/ntr0bf]))/g, (_, u, x, c) => (u ? String.fromCharCode(parseInt(u, 16)) : x ? String.fromCharCode(parseInt(x, 16)) : (SIMPLE[c] !== undefined ? SIMPLE[c] : c))));
      if (end < 0) { openQuote = raw[0]; value = null; } else value = unescape(raw.slice(1, end), raw[0]);
    } else value = raw.replace(/(^|\s)#.*$/, '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, key)) dupes.push(key);
    keys[key] = value;
  }
  return { keys, dupes, exotic, flow: Boolean(first && /^\s*[{[]/.test(first)) };
}

/**
 * Lo que se juzga de la capa SOLA, sobre lo bajado (momento 1 del AC 26): el `name:` de cada agente coincide con su archivo,
 * el de cada SKILL.md con su carpeta y el de cada pack.json con la suya (AC 18), y ningún agente ni SKILL.md trae `hooks:` en
 * su frontmatter (Claude Code los corre: AC 17). `[{ path, reason }]`, vacía si todo vale. Nunca tira.
 */
function contentProblems(dir, files) {
  const problems = [];
  const read = (p) => { try { return fs.readFileSync(path.join(dir, ...p.split('/')), 'utf8'); } catch (_) { return null; } };
  for (const f of files) {
    const p = f.path;
    const isAgent = /^agents\/[^/]+\.md$/.test(p);
    const isSkill = p.startsWith('skills/') && path.posix.basename(p) === 'SKILL.md';
    const isPack = /^packs\/[^/]+\/pack\.json$/.test(p);
    if (!isAgent && !isSkill && !isPack) continue;
    const text = read(p);
    if (text === null) { problems.push({ path: p, reason: 'no se pudo leer lo bajado' }); continue; }
    const want = isAgent ? path.posix.basename(p, '.md') : path.posix.basename(path.posix.dirname(p));
    if (isPack) {
      let j = null;
      try { j = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { problems.push({ path: p, reason: `el manifiesto del paquete es ilegible (${e.message})` }); continue; }
      // el nombre con su clave vieja (`nombre`) también vale: el cargador la traduce (pase adversarial de la A2a, a verificar aparte)
      const nm = isObject(j) ? (j.name !== undefined ? j.name : j.nombre) : null;
      if (isObject(j) && j.name !== undefined && j.nombre !== undefined && j.name !== j.nombre) problems.push({ path: p, reason: `el paquete trae name (${JSON.stringify(j.name)}) y su nombre viejo nombre (${JSON.stringify(j.nombre)}) distintos: dejá uno` });
      else if (nm !== want) problems.push({ path: p, reason: `el name del paquete (${JSON.stringify(nm)}) tiene que ser el de su carpeta (${want})` });
      continue;
    }
    const fm = frontmatterKeys(text);
    if (!fm) { problems.push({ path: p, reason: `no trae frontmatter con name: (tiene que ser ${want})` }); continue; }
    if (fm.flow) { problems.push({ path: p, reason: 'su frontmatter está en forma de flujo ({…}): no se juzga y la capa no lo trae' }); continue; }
    if (fm.exotic.length) { problems.push({ path: p, reason: `su frontmatter usa claves complejas, anclas, tags, alias, fusión (<<) o escapes en una clave (${fm.exotic.slice(0, 3).join(' · ')}): no se juzga y la capa no lo trae` }); continue; }
    // lo que Claude Code ejecuta desde un frontmatter (`hooks`, `mcpServers` con su comando) como clave de PRIMER NIVEL, escrita
    // como sea (entre comillas, con espacios, en otra caja); el mismo texto dentro de un valor no es la clave (revisor de
    // seguridad y pase adversarial de la A2a)
    const runs = Object.keys(fm.keys).filter((k) => /^(?:hooks|mcpservers)$/i.test(k));
    if (runs.length) problems.push({ path: p, reason: `trae ${runs.join(' y ')} en su frontmatter: Claude Code los corre, y la capa no trae nada que la máquina ejecute` });
    if (fm.dupes.length) problems.push({ path: p, reason: `su frontmatter repite ${[...new Set(fm.dupes)].join(', ')}: un lector de YAML lo rechaza o se queda con uno; la capa no adivina cuál` });
    const name = fm.keys.name;
    if (name === undefined || name === null || name === '') { problems.push({ path: p, reason: `no trae name: en su frontmatter, en una línea (tiene que ser ${want})` }); continue; }
    if (name !== want) problems.push({ path: p, reason: `su name: (${name}) tiene que ser el de su ${isAgent ? 'archivo' : 'carpeta'} (${want}): Claude Code identifica ${isAgent ? 'un agente' : 'una skill'} por su name` });
  }
  return problems;
}

/**
 * La versión que va a quedar, como LISTA (nunca la carpeta, que ya puede traer la capa vieja): las rutas de su
 * `.tycon-release.json`, los destinos de sus skills de terceros, y los nombres de sus agentes, skills y paquetes. null si
 * la carpeta no trae su manifiesto.
 */
function versionIndex(versionDir) {
  const relm = rel().readManifest(versionDir);
  if (!relm) return null;
  const paths = relm.files.map((f) => f.path).filter((p) => typeof p === 'string');
  let thirdPartyRoots = [];
  let thirdPartyError = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(versionDir, 'scripts', 'publishing', 'third-party-skills.json'), 'utf8'));
    thirdPartyRoots = (raw.thirdParty || raw.third_party || []).filter((e) => isObject(e) && typeof e.target === 'string' && e.target).map((e) => e.target);
  } catch (e) {
    // sin el archivo, la versión no trae skills de terceros; uno ilegible es «no sé dónde caen», que se dice (fallos silenciosos, A2a)
    if (!e || e.code !== 'ENOENT') thirdPartyError = `scripts/publishing/third-party-skills.json de la versión no se puede leer (${(e && (e.code || e.message)) || e}): no sé dónde caen sus skills de terceros`;
  }
  const agents = paths.filter((p) => /^agents\/[^/]+\.md$/.test(p)).map((p) => path.posix.basename(p, '.md'));
  const skills = [...paths.filter((p) => p.startsWith('skills/') && path.posix.basename(p) === 'SKILL.md').map((p) => path.posix.basename(path.posix.dirname(p))), ...thirdPartyRoots.map((t) => path.posix.basename(t))];
  const packs = paths.filter((p) => /^packs\/[^/]+\/pack\.json$/.test(p)).map((p) => p.split('/')[1]);
  return { version: relm.version || null, paths, thirdPartyRoots, thirdPartyError, agents, skills, packs };
}

/**
 * Lo que se juzga de la capa CONTRA la versión que va a quedar (momento 2 del AC 26): la regla del conjunto con su lista (una
 * skill en una carpeta suya o de terceros), los nombres contra los de la versión sin caja ni acentos (AC 18; un revisor del
 * núcleo es un agente de la versión) y, si la capa trae paquetes, el cargador DE ESA VERSIÓN (`validateTree`) sobre el árbol
 * armado: los paquetes y agentes de su lista más los de la capa, en una temporal (AC 19). `{ ok, problems }`; nunca tira.
 */
function checkAgainstVersion(layerDir, files, versionDir, { env = process.env } = {}) {
  void env;   // a propósito: el cargador corre con carpetas explícitas, ninguna variable decide qué se valida
  const paths = files.map((f) => f.path);
  const idx = versionIndex(versionDir);
  // sin la lista de la versión no hay contra qué comparar nombres ni paquetes: una capa de la A1 (perfil y llave) no los tiene
  if (!idx) return paths.every((p) => A1_PATHS.includes(p)) ? { ok: true, problems: [] } : { ok: false, problems: [{ path: '(versión)', reason: `${versionDir} no trae el manifiesto de su versión: no hay contra qué validar los revisores, las skills ni el mapa de renombres de la capa` }] };
  const problems = setProblems(paths, { publicPaths: idx.paths, thirdPartyRoots: idx.thirdPartyRoots }).filter((x) => /versión|terceros/.test(x.reason));
  if (idx.thirdPartyError && paths.some((p) => p.startsWith('skills/'))) problems.push({ path: '(versión)', reason: idx.thirdPartyError });
  const clash = (list, kind) => (name) => { const hit = list.find((n) => foldName(n) === foldName(name)); return hit ? `se llama como ${kind} de la versión que va a quedar (${hit}): sin caja ni acentos son el mismo nombre` : null; };
  const vAgent = clash(idx.agents, 'un agente'); const vSkill = clash(idx.skills, 'una skill'); const vPack = clash(idx.packs, 'un paquete');
  for (const p of paths) {
    let why = null;
    if (/^agents\/[^/]+\.md$/.test(p)) why = vAgent(path.posix.basename(p, '.md'));
    else if (p.startsWith('skills/') && path.posix.basename(p) === 'SKILL.md') why = vSkill(path.posix.basename(path.posix.dirname(p)));
    else if (/^packs\/[^/]+\/pack\.json$/.test(p)) why = vPack(p.split('/')[1]);
    if (why) problems.push({ path: p, reason: why });
  }
  const layerPacks = paths.filter((p) => /^packs\/[^/]+\/pack\.json$/.test(p));
  // el revisor que nombra un paquete de la capa y su agente, con la MISMA caja: en Mac y Windows el cargador lo encuentra igual
  // (el disco no distingue) y en Linux no; y en ejecución el pipeline lo pide por su nombre exacto (pase adversarial, clase 7)
  const exactAgents = new Set([...idx.agents, ...paths.filter((p) => /^agents\/[^/]+\.md$/.test(p)).map((p) => path.posix.basename(p, '.md'))]);
  for (const pp of layerPacks) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(layerDir, ...pp.split('/')), 'utf8')); } catch (_) { j = null; }   // ilegible: lo dice contentProblems
    const revs = isObject(j) ? (j.reviewers || j.revisores || []) : [];
    for (const r of Array.isArray(revs) ? revs : []) {
      const agent = isObject(r) ? (r.agent !== undefined ? r.agent : r.agente) : null;
      if (typeof agent !== 'string' || exactAgents.has(agent)) continue;
      const near = [...exactAgents].find((a) => a.toLowerCase() === agent.toLowerCase());
      if (near) problems.push({ path: pp, reason: `el revisor ${agent} y su agente ${near} difieren sólo en la caja: el pipeline lo pide por su nombre exacto` });
    }
  }
  if (layerPacks.length) problems.push(...packProblems(layerDir, paths, versionDir, idx));
  if (paths.includes(RENAMES_PATH)) problems.push(...renamesProblems(layerDir, versionDir, idx));
  return { ok: problems.length === 0, problems };
}

/**
 * El mapa de renombres de la capa contra la versión que va a quedar (tanda A2b-AC33, AC 33), con el lector DE ESA versión
 * (`scripts/lib/legacy-names.js`: sus tipos y su regla de rutas). (a) La forma del mapa; (b) la de cada entrada; (c) el nombre
 * nuevo presente en la versión, para lo que la versión lista: un `file` o `folder` cuyo nuevo no está entra sólo si el viejo
 * tampoco (una herramienta del mantenedor que no viaja), y una opción, subcomando, valor o clave cuyo `where` es un archivo
 * de la versión trae su nombre nuevo en el texto de ese archivo. Variables, archivos de estado y de configuración, y claves de
 * un archivo que no es de la versión: sólo la forma (esos nombres viven en el entorno y la HOME). `[{ path, reason }]`; nunca tira.
 */
const PATH_KINDS_MAP = Object.freeze(['file', 'folder', 'config-file', 'state-file']);
/** La forma de cada tipo de nombre del mapa (revisor de seguridad de la tanda A2b-AC33; el mapa real las cumple, medido). */
const NAME_SHAPES = Object.freeze({
  env: /^[A-Z][A-Z0-9_]*$/,
  option: /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]*$/,
  subcommand: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  value: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  key: /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
});
/** La carpeta de Claude Code en la HOME, como la escribe el mapa (`~/<carpeta>/`): el nombre lo sabe tycon-home.js. */
const MAP_HOME_PREFIX = `~/${path.basename(TH.claudeDir(path.sep))}/`;
/** Lo que el mapa de la capa no puede nombrar aunque el lector lo acepte: un tramo `.git`, o una ruta de la HOME fuera de la carpeta de Claude Code. */
function mapPathProblem(p) {
  // como lo compara un disco de Mac o Windows (sin caja, sin puntos ni espacios finales): `.git.` y `.GIT` son `.git` (pase adversarial)
  if (String(p).split('/').some((seg) => foldPath(seg) === '.git')) return 'tiene un tramo .git';
  if (String(p).startsWith('~') && !String(p).startsWith(MAP_HOME_PREFIX)) return `es de la HOME y no cuelga de ${MAP_HOME_PREFIX} (un mapa no lleva un estado a otra carpeta de la persona)`;
  return null;
}
function renamesProblems(layerDir, versionDir, idx) {
  const at = (reason) => ({ path: RENAMES_PATH, reason });
  const readerFile = path.join(versionDir, 'scripts', 'lib', 'legacy-names.js');
  if (!idx.paths.includes('scripts/lib/legacy-names.js')) return [at('la versión que va a quedar no trae su lector (scripts/lib/legacy-names.js): nadie usaría el mapa, y no hay contra qué validarlo')];
  let LN = null;
  // fresco, como el cargador de paquetes: el proceso puede haber cargado antes el lector de OTRA versión desde la misma ruta
  try { delete require.cache[require.resolve(readerFile)]; LN = require(readerFile); } catch (e) { return [at(`el lector de la versión que va a quedar no carga (scripts/lib/legacy-names.js: ${(e && (e.code || e.message)) || e})`)]; }
  if (!LN || !Array.isArray(LN.KINDS) || typeof LN.pathProblem !== 'function') return [at('el lector de la versión que va a quedar (scripts/lib/legacy-names.js) no expone KINDS ni pathProblem: no sabe validar el mapa')];
  let map;
  let text;
  try { text = fs.readFileSync(path.join(layerDir, ...RENAMES_PATH.split('/')), 'utf8'); } catch (e) { return [at(`el mapa no se pudo leer (${e.code || e.message})`)]; }
  // se lee como lo lee el lector (loadMap: JSON.parse sin quitar nada): un BOM que acá se tolerara dejaría en la máquina un mapa
  // que el lector da por roto, y ningún nombre viejo se traduciría (pase adversarial)
  if (text.charCodeAt(0) === 0xFEFF) return [at('el mapa empieza con un BOM: el lector de la versión no lo lee (guardalo como UTF-8 sin BOM)')];
  try { map = JSON.parse(text); } catch (e) { return [at(`el mapa es ilegible (no es JSON: ${e.message})`)]; }
  if (!isObject(map)) return [at('el mapa tiene que ser un objeto con entries y retire_after')];
  const problems = [];
  const r = map.retire_after;
  const realDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!(r === null || (typeof r === 'string' && realDate(r)))) problems.push(at(`retire_after tiene que ser una fecha AAAA-MM-DD que exista, o null (es ${JSON.stringify(r)})`));
  if (!Array.isArray(map.entries)) { problems.push(at('entries tiene que ser una lista')); return problems; }
  const inVersion = new Set(idx.paths);
  const folderInVersion = (p) => { const pre = `${String(p).replace(/\/+$/, '')}/`; return idx.paths.some((x) => x.startsWith(pre)); };
  const present = (kind, p) => (kind === 'folder' ? folderInVersion(p) : inVersion.has(p));
  const texts = new Map();
  const textOf = (p) => {
    if (!texts.has(p)) { try { texts.set(p, fs.readFileSync(path.join(versionDir, ...p.split('/')), 'utf8')); } catch (e) { texts.set(p, { error: (e && (e.code || e.message)) || String(e) }); } }
    return texts.get(p);
  };
  // la regla de rutas del lector, envuelta: es código de la versión y esta función nunca tira (fallos silenciosos de la tanda)
  const pathWhy = (p, kind) => { try { return LN.pathProblem(p, kind); } catch (err) { return `no se pudo juzgar con el lector de la versión (${(err && err.message) || err})`; } };
  map.entries.forEach((e, i) => {
    const who = `entries[${i}]${isObject(e) && typeof e.old === 'string' ? ` (${e.old})` : ''}`;
    if (!isObject(e)) { problems.push(at(`${who}: no es un objeto`)); return; }
    if (!LN.KINDS.includes(e.kind)) { problems.push(at(`${who}: kind ${JSON.stringify(e.kind)} desconocido para el lector de la versión (${LN.KINDS.join(', ')})`)); return; }
    // un tipo que el lector conoce y este instalador no sabe juzgar (una versión más nueva) no entra sin sus frenos (pase adversarial)
    if (!PATH_KINDS_MAP.includes(e.kind) && !NAME_SHAPES[e.kind]) { problems.push(at(`${who}: kind ${JSON.stringify(e.kind)}: este instalador no sabe validarlo (lo conoce una versión más nueva del lector)`)); return; }
    if (typeof e.old !== 'string' || !e.old || typeof e.new !== 'string' || !e.new) { problems.push(at(`${who}: old y new tienen que ser texto no vacío`)); return; }
    // una opción se compara sin sus guiones, como la compara el lector (`bare`): `--type` → `type` es la misma (pase adversarial)
    const same = e.kind === 'option' ? e.old.replace(/^-+/, '') === e.new.replace(/^-+/, '') : e.old === e.new;
    if (same) { problems.push(at(`${who}: old y new son iguales${e.kind === 'option' ? ' (sin los guiones)' : ''}`)); return; }
    if (e.repo !== undefined && !['arnes', 'agent-skills'].includes(e.repo)) { problems.push(at(`${who}: repo es arnes o agent-skills (no ${JSON.stringify(e.repo)})`)); return; }
    if (e.where !== undefined && (typeof e.where !== 'string' || pathWhy(e.where, 'config-file'))) { problems.push(at(`${who}: where tiene que ser una ruta relativa sana (o ~/…): ${JSON.stringify(e.where)}`)); return; }
    if (PATH_KINDS_MAP.includes(e.kind)) {
      const bad = ['old', 'new'].map((side) => [side, pathWhy(e[side], e.kind) || mapPathProblem(e[side])]).filter(([, why]) => why);
      if (bad.length) { problems.push(at(`${who}: ${bad.map(([side, why]) => `la ruta ${side} «${e[side]}» ${why}`).join('; ')}`)); return; }
    } else if (NAME_SHAPES[e.kind]) {
      const bad = ['old', 'new'].filter((side) => !NAME_SHAPES[e.kind].test(e[side]));
      if (bad.length) { problems.push(at(`${who}: ${bad.map((side) => `el ${side} «${e[side]}»`).join(' y ')} no tiene la forma de un nombre de ${e.kind}`)); return; }
    }
    if (e.kind === 'file' || e.kind === 'folder') {
      if (!present(e.kind, e.new) && present(e.kind, e.old)) problems.push(at(`${who}: el nombre nuevo ${e.new} no está en la versión y el viejo sí: el mapa llevaría un nombre que anda a uno que no existe`));
      return;
    }
    if (['option', 'subcommand', 'value', 'key'].includes(e.kind) && typeof e.where === 'string' && inVersion.has(e.where)) {
      const t = textOf(e.where);
      const name = e.kind === 'option' ? e.new.replace(/^-+/, '') : e.new;
      if (typeof t !== 'string') problems.push(at(`${who}: no pude leer ${e.where} de la versión (${t.error}) para buscar ${name}`));
      else if (!t.includes(name)) problems.push(at(`${who}: el nombre nuevo ${name} no está en ${e.where} de la versión`));
    }
  });
  return problems;
}

/** El cargador de paquetes de la versión que va a quedar sobre el árbol armado (AC 19). `[{ path, reason }]`. */
function packProblems(layerDir, layerPaths, versionDir, idx) {
  const loader = path.join(versionDir, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js');
  let PK = null;
  let loadError = null;
  // fresco: el proceso puede haber cargado antes el cargador de OTRA versión desde la misma ruta (harness/ durante un refresco)
  try { delete require.cache[require.resolve(loader)]; PK = require(loader); } catch (e) { PK = null; loadError = (e && (e.code || e.message)) || String(e); }
  if (loadError) return [{ path: '(paquetes)', reason: `el cargador de paquetes de la versión que va a quedar no carga (${loader}: ${loadError}): la capa con paquetes no se apila` }];
  if (!PK || typeof PK.validateTree !== 'function') return [{ path: '(paquetes)', reason: `la versión que va a quedar no sabe validar paquetes (${loader} no trae validateTree: es anterior a la tanda A2a de la story 8.25): la capa con paquetes no se apila` }];
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-team-packs-')); } catch (e) { return [{ path: '(paquetes)', reason: `no pude armar el árbol temporal para validar los paquetes (${e.code || e.message})` }]; }
  try {
    const copy = (fromRoot, rel) => { const to = path.join(tmp, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(fromRoot, ...rel.split('/')), to); };
    const isPackOrAgent = (p) => /^packs\/[^/]+\/pack\.json$/.test(p) || /^agents\/[^/]+\.md$/.test(p);
    const fromVersion = idx.paths.filter(isPackOrAgent);
    for (const p of fromVersion) {
      // un archivo de la lista que no está: el cargador lo dice como agente inexistente; cualquier otro error se dice tal cual
      try { copy(versionDir, p); } catch (e) { if (!e || e.code !== 'ENOENT') return [{ path: p, reason: `no se pudo leer de la versión para validar los paquetes (${(e && (e.code || e.message)) || e})` }]; }
    }
    for (const p of layerPaths.filter(isPackOrAgent)) {
      try { copy(layerDir, p); } catch (e) { return [{ path: p, reason: `no se pudo leer de lo bajado para validar los paquetes (${e.code || e.message})` }]; }
    }
    try { fs.mkdirSync(path.join(tmp, 'packs'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true }); } catch (e) { return [{ path: '(paquetes)', reason: `no pude armar el árbol temporal para validar los paquetes (${e.code || e.message})` }]; }
    // el núcleo de esa versión: sus agentes que ningún paquete PÚBLICO declara
    const declared = new Set();
    for (const p of fromVersion.filter((x) => x.startsWith('packs/'))) {
      // con sus claves viejas también (`revisores`/`agente`), como las lee el cargador: si no, ese agente caería en el núcleo
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(versionDir, ...p.split('/')), 'utf8')); } catch (e) { if (!e || e.code !== 'ENOENT') return [{ path: p, reason: `el manifiesto de un paquete de la versión no se puede leer (${(e && (e.code || e.message)) || e}): no sé qué agentes son de paquetes` }]; }
      const revs = isObject(j) ? (j.reviewers || j.revisores || []) : [];
      for (const r of Array.isArray(revs) ? revs : []) { const a = isObject(r) ? (r.agent !== undefined ? r.agent : r.agente) : null; if (typeof a === 'string') declared.add(a); }
    }
    const nucleo = idx.agents.filter((a) => !declared.has(a));
    let errs;
    try { errs = PK.validateTree({ packsDir: path.join(tmp, 'packs'), agentsDir: path.join(tmp, 'agents'), nucleo }); } catch (e) { errs = [{ archivo: '(paquetes)', revisor: null, motivo: `el cargador de la versión tiró (${e.message})` }]; }
    return (Array.isArray(errs) ? errs : []).map((e) => {
      const relFile = String(e.archivo || '').startsWith(tmp) ? path.relative(tmp, e.archivo).split(path.sep).join('/') : String(e.archivo || '(paquetes)');
      const pack = /^packs\/([^/]+)\//.exec(relFile);
      return { path: relFile, reason: `${pack ? `paquete ${pack[1]}` : 'paquetes'}${e.revisor ? ` · revisor ${e.revisor}` : ''}: ${String(e.motivo || '').split(tmp).join('<árbol armado>')}` };
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* queda en la temporal */ }
  }
}

/** `team-layer.json`: sólo `schema` (1), `name` ([A-Za-z0-9._-]{1,40}) y `requires.harness` («>= YYYY.MM.DD.N», cumplida por la versión que va a quedar). */
function validateDeclaration(text, versionToInstall) {
  if (text === null || text === undefined) return { ok: false, reason: `falta ${DECLARATION} (la declaración de la capa) en la raíz del repo del equipo` };
  let j;
  try { j = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { return { ok: false, reason: `${DECLARATION} es ilegible (no es JSON: ${e.message})` }; }
  if (!isObject(j)) return { ok: false, reason: `${DECLARATION} tiene que ser un objeto con schema, name y requires` };
  const extra = Object.keys(j).filter((k) => !['schema', 'name', 'requires'].includes(k));
  if (extra.length) return { ok: false, reason: `${DECLARATION} trae clave(s) que no conozco: ${extra.join(', ')} (sólo schema, name y requires)` };
  if (j.schema !== 1) return { ok: false, reason: `${DECLARATION}: schema tiene que ser 1 (dice ${JSON.stringify(j.schema)})` };
  if (typeof j.name !== 'string' || !NAME_RE.test(j.name)) return { ok: false, reason: `${DECLARATION}: name tiene que ser [A-Za-z0-9._-] de 1 a 40 caracteres (dice ${JSON.stringify(j.name)})` };
  if (!isObject(j.requires) || typeof j.requires.harness !== 'string') return { ok: false, reason: `${DECLARATION}: falta requires.harness («>= YYYY.MM.DD.N»: la versión mínima del arnés que entiende la capa)` };
  const extraReq = Object.keys(j.requires).filter((k) => k !== 'harness');
  if (extraReq.length) return { ok: false, reason: `${DECLARATION}: requires trae clave(s) que no conozco: ${extraReq.join(', ')} (sólo harness)` };
  const m = REQUIRES_RE.exec(j.requires.harness.trim());
  if (!m || !VO.isOrdered(m[1])) return { ok: false, reason: `${DECLARATION}: requires.harness tiene que tener la forma «>= YYYY.MM.DD.N» (dice «${j.requires.harness}»)` };
  const cmp = VO.compare(versionToInstall, m[1]);
  if (cmp === null || cmp < 0) return { ok: false, reason: `la capa del equipo pide el arnés ${m[1]} o posterior y la versión que va a quedar es ${versionToInstall || 'sin número'}: no se apila` };
  return { ok: true, name: j.name, requires: m[1] };
}

/**
 * El perfil candidato, validado con el lector de LA VERSIÓN QUE VA A QUEDAR (`readerTree`), sobre una carpeta temporal y
 * con un entorno sin TYCON_PROFILE (la variable desviaría la lectura a otro archivo). Rechaza lo que el lector rechaza
 * (ilegible, clave fuera del vocabulario, valor personal) y las tres llaves que no viajan en la capa.
 */
function validateProfile(text, { readerTree, home = os.homedir(), env = process.env, name = PROFILE_PATH } = {}) {
  void env;   // a propósito: el lector corre con un entorno vacío (ninguna variable decide qué archivo es «el perfil»)
  const readerFile = path.join(readerTree || '', 'scripts', 'lib', 'tycon-config.js');
  let TC;
  try { TC = require(readerFile); } catch (e) { return { ok: false, reason: `el lector de configuración de la versión que va a quedar no carga (${readerFile}: ${(e && e.code) || e.message})` }; }
  if (typeof TC.leerPerfil !== 'function') return { ok: false, reason: 'el lector de configuración de la versión que va a quedar no sabe leer el perfil solo (es de antes de la tanda G de la story 8.23)' };
  let parsed;
  try { parsed = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { return { ok: false, reason: `${name} es ilegible (no es JSON: ${e.message})` }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-team-profile-'));
  try {
    // en la temporal va con el nombre de antes A PROPÓSITO: el lector de una versión anterior (el de `readerTree`) sólo busca
    // ése, y el de hoy lee los dos
    fs.writeFileSync(path.join(tmp, LEGACY_PROFILE_PATH), `${JSON.stringify(parsed, null, 2)}\n`);
    const r = TC.leerPerfil({ arnes: tmp, home, env: {} });
    if (r.estado !== 'leido') {
      const why = (r.errores || []).map((e) => `${e.clave ? `${e.clave} · ` : ''}${e.motivo}`).join(' | ') || `estado ${r.estado}`;
      return { ok: false, reason: `${name} de la capa: ${why}`, errors: r.errores || [] };
    }
    const forbidden = r.entradas.filter((e) => FORBIDDEN_PROFILE_KEYS.includes(e.ruta)).map((e) => e.ruta);
    if (forbidden.length) return { ok: false, reason: `${name} de la capa trae ${forbidden.join(', ')}: no viaja(n) en la capa del equipo hasta la A2 (describen la transición de los clones o mudan solas a toda máquina)` };
    return { ok: true, entries: r.entradas };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* queda en la temporal */ }
  }
}

/**
 * `team-repos.json` de la capa, con el lector de la versión que va a quedar (`readerTree`): una versión que no lo trae no lo
 * puede validar, y una capa que no se puede validar no se apila. `{ ok: true }` o `{ ok: false, reason }` con cada problema
 * y la ruta de su clave.
 */
function validateTeamRepos(text, { readerTree } = {}) {
  const readerFile = path.join(readerTree || '', 'scripts', 'lib', 'team-repos.js');
  let TR;
  try { TR = require(readerFile); } catch (e) { return { ok: false, reason: `${TEAM_REPOS_PATH}: la versión que va a quedar no trae su lector (${readerFile}: ${(e && e.code) || e.message})` }; }
  if (typeof TR.parse !== 'function') return { ok: false, reason: `${TEAM_REPOS_PATH}: el lector de la versión que va a quedar no sabe validarlo` };
  if (text === null || text === undefined) return { ok: false, reason: `${TEAM_REPOS_PATH}: no se pudo leer` };
  const r = TR.parse(String(text).replace(/^\uFEFF/, ''));
  if (r.ok) return { ok: true };
  return { ok: false, reason: `${TEAM_REPOS_PATH} de la capa: ${r.problems.map((x) => `${x.path || '(el archivo)'} · ${x.message}`).join(' | ')}` };
}

// ── resolver (sin escribir), bajar y apilar ───────────────────────────────────────────────────────────────────────

/** Un pedido que no sirvió, dicho: 404 y 403 (sin ser el límite de la API) son «sin acceso» al repo del equipo. */
function failure(c, r, repo, what) {
  const repos = Array.isArray(c.repos) && c.repos.length ? c.repos : [repo];
  if (r.ok && (r.status === 404 || (r.status === 403 && String((r.headers || {})['x-ratelimit-remaining']) !== '0'))) {
    let userStatus = null;
    if (c.token) { try { const u = c.get('/user'); userStatus = u.ok ? u.status : null; } catch (_) { userStatus = null; } }
    return { ok: false, status: 'blocked', missing: 'team', reason: GA.explain404({ token: c.token, userStatus, repo, repos, status: r.status }) };
  }
  if (r.ok && r.status === 401) return { ok: false, status: 'blocked', reason: GA.explain401({ repos }) };
  const f = rel().explainFailure(c, r, { what: `${what} (${repo})`, probeUser: false });
  return { ok: false, status: f.status, reason: f.reason };
}

/** El contenido de un archivo en un commit, por la API (`contents/`): `{ ok, text }`, `{ ok: true, text: null }` si no está, o el motivo. */
function contentsAt(c, repo, file, sha) {
  const r = c.get(`/repos/${repo}/contents/${file}?ref=${sha}`);
  if (r.ok && r.status === 404) return { ok: true, text: null };
  if (!r.ok || r.status !== 200 || !r.json) return failure(c, r, repo, `el archivo ${file}`);
  let buf = Buffer.alloc(0);
  try { buf = Buffer.from(String(r.json.content || ''), 'base64'); } catch (_) { buf = Buffer.alloc(0); }
  return { ok: true, text: buf.toString('utf8'), buf, sha: r.json.sha || null };
}

/** Los archivos que se juzgan por su CONTENIDO antes de escribir nada (momento 1 del AC 26): el perfil, los agentes, los SKILL.md y los manifiestos de paquete. */
const isContentChecked = (p) => isProfilePath(p) || p === TEAM_REPOS_PATH || /^agents\/[^/]+\.md$/.test(p)
  || (p.startsWith('skills/') && path.posix.basename(p) === 'SKILL.md') || /^packs\/[^/]+\/pack\.json$/.test(p);
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* queda en la temporal del sistema */ } };
// las temporales de lo leído que todavía no se movieron a la caché: se borran al salir pase lo que pase (`--dry-run`, un aborto)
const STAGED = new Set();
let stagedHook = false;
function trackStaged(dir) {
  STAGED.add(dir);
  if (!stagedHook) { stagedHook = true; process.once('exit', () => { for (const d of STAGED) rmQuiet(d); }); }
  return dir;
}
function dropStaged(dir) { if (dir) { STAGED.delete(dir); rmQuiet(dir); } }

/**
 * El momento 1 del AC 26, igual para las dos fuentes: lee (con `read(path, sha)` → `{ ok, buf }`) la declaración y los archivos
 * que se juzgan por su contenido, cada uno verificado por el blob que la lista del árbol declara, a una carpeta temporal FUERA
 * del HOME, y ahí juzga la declaración (contra `version`), el perfil (con el lector de `readerTree`) y los nombres y `hooks:`
 * (AC 17, 18). `{ ok: true, dir, declaration, profileEntries }` —quien llama se queda con `dir` (Azure la reusa al bajar) o la
 * borra— o el rechazo, sin dejar nada.
 */
function judgeContent(plan, read, opts) {
  let dir = null;
  try { dir = trackStaged(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-team-check-'))); } catch (e) { return { ok: false, status: 'blocked', reason: `${opts.head}: no pude armar la carpeta temporal para revisar la capa (${e.code || e.message})` }; }
  // nunca tira: un error del disco al escribir lo leído es un motivo, y la temporal se borra (fallos silenciosos, A2a vuelta 2)
  try { return judgeContentIn(dir, plan, read, opts); } catch (e) { dropStaged(dir); return { ok: false, status: 'blocked', reason: `${opts.head}: no pude revisar la capa (${e.code || e.message})` }; }
}
function judgeContentIn(dir, plan, read, { version, readerTree, home, env, head, commit }) {
  const fail = (o) => { dropStaged(dir); return o; };
  const wanted = [{ path: DECLARATION, sha: plan.declaration && plan.declaration.sha }, ...plan.files.filter((f) => isContentChecked(f.path)).map((f) => ({ path: f.path, sha: f.sha }))];
  for (const w of wanted) {
    const got = read(w.path, w.sha);
    if (!got.ok) return fail(Object.assign({}, got, { reason: `${head}: ${got.reason}` }));
    if (got.buf === null || got.buf === undefined) { if (w.path === DECLARATION) continue; return fail({ ok: false, status: 'blocked', reason: `${head}: ${w.path} está en la lista del árbol y no se pudo leer` }); }
    if (w.sha && blobOf(got.buf) !== w.sha) return fail({ ok: false, status: 'blocked', reason: `${head}: ${w.path} no es el blob que la lista del árbol declara (${sha7(blobOf(got.buf))} ≠ ${sha7(w.sha)}): no se usa` });
    const to = path.join(dir, ...w.path.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, got.buf);
  }
  const readText = (p) => { try { return fs.readFileSync(path.join(dir, ...p.split('/')), 'utf8'); } catch (_) { return null; } };
  const d = validateDeclaration(readText(DECLARATION), version);
  if (!d.ok) return fail({ ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: ${d.reason}` });
  let profileEntries = null;
  const pfile = profileFileOf(plan.files);
  if (pfile) {
    const v = validateProfile(readText(pfile.path), { readerTree, home, env, name: pfile.path });
    if (!v.ok) return fail({ ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: ${v.reason} — la capa no se apila (${plan.files.length} archivo(s) declarados)` });
    profileEntries = v.entries;
  }
  if (plan.files.some((f) => f.path === TEAM_REPOS_PATH)) {
    const v = validateTeamRepos(readText(TEAM_REPOS_PATH), { readerTree });
    if (!v.ok) return fail({ ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: ${v.reason} — la capa no se apila (${plan.files.length} archivo(s) declarados)` });
  }
  const cp = contentProblems(dir, plan.files.filter((f) => isContentChecked(f.path)));
  if (cp.length) return fail({ ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: no se apila — ${cp.map((x) => `${x.path}: ${x.reason}`).join(' · ')}` });
  return { ok: true, dir, declaration: { name: d.name, requires: d.requires }, profileEntries };
}

/**
 * Resuelve y valida la capa SIN escribir ni registrar: la punta de `main` del repo del equipo, el commit y su árbol, la lista
 * del árbol (lista cerrada), la declaración (contra `version`) y el perfil (con el lector de `readerTree`).
 * `{ ok: true, repo, ref, commit, tree, etag, files, declaration: { name, requires }, totalBytes }` o `{ ok: false, status, reason }`.
 */
function resolveTeam(c, repo, { version, readerTree, home = os.homedir(), env = process.env, publicPaths = [], knownCommits = [] } = {}) {
  const head = `capa del equipo (${repo})`;
  const ref = c.get(`/repos/${repo}/git/ref/heads/${TEAM_REF}`);
  if (!ref.ok || ref.status !== 200 || !ref.json || !ref.json.object || typeof ref.json.object.sha !== 'string') {
    const f = failure(c, ref, repo, `la ref ${TEAM_REF} del repo del equipo`);
    return Object.assign(f, { reason: `${head}: ${f.reason}` });
  }
  const commit = ref.json.object.sha;
  // lo que GitHub contesta se usa en la URL del pedido siguiente y en una ruta del disco (la caché): sólo un sha de 40
  // hexadecimales pasa (revisor de seguridad de la A1a: una respuesta manipulada no sale de la caché ni cambia el pedido)
  if (!SHA40.test(commit)) return { ok: false, status: 'blocked', reason: `${head}: la ref ${TEAM_REF} apunta a algo que no tiene forma de commit (${JSON.stringify(String(commit).slice(0, 48))}): no se usa` };
  const etag = ref.headers && ref.headers.etag ? ref.headers.etag : null;
  // el refresco en el lugar (A1b, AC 10 (a) y W10): si la punta es un commit que quien llama ya conoce —el de harness/, o uno
  // rechazado antes—, la ref sola alcanza: una mirada cuesta un pedido
  if (Array.isArray(knownCommits) && knownCommits.includes(commit)) return { ok: true, unchanged: true, repo, host: 'github', commit, etag };
  const meta = c.get(`/repos/${repo}/git/commits/${commit}`);
  if (!meta.ok || meta.status !== 200 || !meta.json || !meta.json.tree || typeof meta.json.tree.sha !== 'string') {
    const f = failure(c, meta, repo, `el commit ${sha7(commit)} del repo del equipo`);
    return Object.assign(f, { reason: `${head}: ${f.reason}` });
  }
  const tree = meta.json.tree.sha;
  if (!SHA40.test(tree)) return { ok: false, status: 'blocked', reason: `${head}: el commit ${sha7(commit)} declara un árbol sin forma de sha (${JSON.stringify(String(tree).slice(0, 48))}): no se usa` };
  const list = c.get(`/repos/${repo}/git/trees/${tree}?recursive=1`);
  if (!list.ok || list.status !== 200 || !list.json || !Array.isArray(list.json.tree)) {
    const f = failure(c, list, repo, `la lista del árbol ${sha7(tree)} del repo del equipo`);
    return Object.assign(f, { reason: `${head}: ${f.reason}` });
  }
  const plan = planTeam(list.json.tree, { publicPaths, truncated: Boolean(list.json.truncated) });
  // `invalid` (A1b, W10): una punta que no pasa la validación no se vuelve a validar hasta que cambie (un fallo de red, sí)
  if (!plan.ok) return { ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: no se apila — ${plan.problems.map((p) => `${p.path}: ${p.reason}`).join(' · ')}` };
  // el momento 1 (AC 26): lo que se juzga por su contenido, leído por la API (sin el comprimido: el choque con la versión se mira
  // antes de bajarlo, AC 3) y verificado por blob; la temporal no se reusa (el comprimido trae todo)
  const judged = judgeContent(plan, (p) => {
    const r = contentsAt(c, repo, p, commit);
    return r.ok ? { ok: true, buf: r.text === null ? null : r.buf } : r;
  }, { version, readerTree, home, env, head, commit });
  if (!judged.ok) return judged;
  dropStaged(judged.dir);
  return { ok: true, repo, host: 'github', ref: TEAM_REF, commit, tree, etag, files: plan.files, declaration: judged.declaration, totalBytes: plan.totalBytes, profileEntries: judged.profileEntries, notes: plan.notes };
}

/**
 * Las rutas de la capa resuelta que la versión bajada en `incomingDir` YA trae (choque): se mira ANTES de bajar la capa, así
 * un choque no deja nada escrito (ni la caché). `[]` si no choca nada o la versión no tiene manifiesto.
 */
function collisionWith(resolved, incomingDir) {
  return foldedCollision(resolved.files.map((f) => f.path), rel().readManifest(incomingDir));
}
/** Las rutas de la capa que la versión (su manifiesto) ya trae, sin caja ni forma Unicode (AC 17: en Mac y Windows son el mismo archivo). */
function foldedCollision(layerPaths, relm) {
  const pub = new Set(relm && Array.isArray(relm.files) ? relm.files.map((f) => foldPath(f.path)) : []);
  return layerPaths.filter((p) => pub.has(foldPath(p)));
}
function collisionReason(resolved, incomingDir, collision) {
  const relm = rel().readManifest(incomingDir);
  return `la versión ${relm && relm.version ? relm.version : 'bajada'} trae ${collision.join(', ')}: choca con la capa del equipo (${resolved.repo}) y no se instala`;
}

/** La línea del plan (`--dry-run`) y de la salida. */
function planLine(resolved) {
  const notes = Array.isArray(resolved.notes) && resolved.notes.length ? ` — aviso: ${resolved.notes.join(' · ')}` : '';
  return `capa del equipo ${resolved.repo} @ ${sha7(resolved.commit)}: ${resolved.files.length} archivo(s) (${resolved.declaration.name}; pide el arnés ${resolved.declaration.requires} o posterior) — ${resolved.files.map((f) => f.path).join(', ')}${notes}`;
}

/** La carpeta de la caché de un commit; un commit sin forma de sha tira (nunca arma una ruta con él). */
function cacheDirOf(env, commit) {
  if (!SHA40.test(String(commit))) throw new Error(`capa del equipo: ${JSON.stringify(String(commit).slice(0, 48))} no tiene forma de commit: no se arma una ruta con eso`);
  return path.join(TH.ownPaths({ env }).root, CACHE_DIR_NAME, String(commit).slice(0, 12));
}

/**
 * El manifiesto de una carpeta (la caché, `incoming/<v>/`, `harness/`), o null. Una entrada sin forma (no es objeto, sin ruta, sin
 * blob de 40 hexadecimales) hace que el manifiesto entero no sirva: «sin capa», nunca un volcado (A1b, W5: `doctor` corre
 * dentro de la salud). `kept` (A1b) son rutas editadas a mano que el refresco conservó aunque el commit ya no las traiga.
 */
function readTeamManifest(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
    if (!isObject(j) || !Array.isArray(j.files) || typeof j.commit !== 'string' || !SHA40.test(j.commit)) return null;
    if (!j.files.every((f) => isObject(f) && typeof f.path === 'string' && f.path && SHA40.test(String(f.blob || f.sha || '')))) return null;
    if (j.kept !== undefined && !(Array.isArray(j.kept) && j.kept.every((p) => typeof p === 'string' && p))) return null;
    return j;
  } catch (_) { return null; }
}

/**
 * Lo que la máquina ya tiene, por blob (tanda A2c · AC 39): los archivos de la capa en `harness/` y en cada caché
 * `~/.tycon/team/*` (por sus manifiestos), y la declaración que guardó cada caché. `get(sha)` → los bytes, recalculados y
 * verificados por su blob (un archivo editado a mano no se usa), o null. Sólo lee; nunca tira.
 */
function blobStore(env = process.env) {
  const where = new Map();
  try {
    const own = TH.ownPaths({ env });
    const dirs = [own.harness];
    try { for (const n of fs.readdirSync(path.join(own.root, CACHE_DIR_NAME))) if (/^[0-9a-f]{12}$/.test(n)) dirs.push(path.join(own.root, CACHE_DIR_NAME, n)); } catch (_) { /* sin cachés */ }
    for (const d of dirs) {
      const m = readTeamManifest(d);
      if (!m) continue;
      for (const f of m.files) if (isSafe(f.path)) where.set(f.blob || f.sha, [...(where.get(f.blob || f.sha) || []), path.join(d, ...f.path.split('/'))]);
      if (SHA40.test(String(m.declaration_blob || ''))) where.set(m.declaration_blob, [...(where.get(m.declaration_blob) || []), path.join(d, DECLARATION)]);
    }
  } catch (_) { /* sin casa del arnés: nada que reusar */ }
  return {
    size: () => where.size,
    get: (sha) => {
      for (const file of where.get(sha) || []) {
        try { const buf = fs.readFileSync(file); if (blobOf(buf) === sha) return buf; } catch (_) { /* sigue con el próximo */ }
      }
      return null;
    },
  };
}

/** ¿La carpeta tiene cada archivo de la capa con el blob declarado (recalculado, no leído del manifiesto)? → los archivos, o null. */
function filesIntact(dir, files) {
  const out = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, ...f.path.split('/'))); } catch (_) { return null; }
    const blob = blobOf(buf);
    if (blob !== (f.blob || f.sha)) return null;
    out.push({ path: f.path, mode: f.mode || '100644', blob });
  }
  return out;
}

/**
 * Baja el comprimido del commit resuelto, lo verifica por el árbol (recalculado) y deja los archivos de la capa en
 * `~/.tycon/team/<commit>/` con su manifiesto; si la caché ya tiene ese commit entero, no pide nada.
 * `{ ok, cacheDir, files: [{ path, mode, blob }], fromCache, resolved }` o `{ ok: false, status, reason }` sin dejar nada.
 */
function fetchTeam(c, resolved, { env = process.env, log = null, deadlineFor = null } = {}) {
  if (!SHA40.test(String(resolved.commit)) || !SHA40.test(String(resolved.tree))) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): el commit o el árbol resueltos no tienen forma de sha: no se baja nada` };
  const cacheDir = cacheDirOf(env, resolved.commit);
  const m = readTeamManifest(cacheDir);
  // la caché sirve si es de ESTE repo y este commit (dos repos con el mismo commit12 no se confunden; clase 3 del pase adversarial)
  if (m && m.commit === resolved.commit && m.repo === resolved.repo && m.tree === resolved.tree) {
    const intact = filesIntact(cacheDir, resolved.files);
    if (intact) { if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} desde la caché (${intact.length} archivo(s))`); return { ok: true, cacheDir, files: intact, fromCache: true, resolved }; }
  }
  // bajar tiene su reloj, que empieza acá (mirar es corto, bajar es largo): el comprimido no hereda lo que sobró de la mirada
  if (typeof deadlineFor === 'function' && typeof c.setDeadline === 'function') c.setDeadline(deadlineFor());
  const tar = c.get(`/repos/${resolved.repo}/tarball/${resolved.commit}`, { maxBytes: MAX_TARBALL_BYTES, timeoutMs: TARBALL_BUDGET_S * 1000 });
  if (!tar.ok || tar.status !== 200) { const f = failure(c, tar, resolved.repo, 'el comprimido del repo del equipo'); return Object.assign(f, { reason: `capa del equipo (${resolved.repo}): ${f.reason}` }); }
  const TR = lib('tar-reader.js');
  const GH = lib('git-tree-hash.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-team-'));
  try {
    const x = TR.extractTarGz(tar.body, tmp, { stripRoot: true });
    if (!x.ok) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): el comprimido de ${sha7(resolved.commit)} no se usa: ${x.reason}` };
    const got = TR.treeOf(x.manifest);
    if (got !== resolved.tree) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): lo bajado no coincide con el commit ${sha7(resolved.commit)}: el árbol calculado es ${sha7(got)} y el del commit ${sha7(resolved.tree)} — no se apila nada` };
    const files = [];
    const staged = [];
    for (const f of resolved.files) {
      const src = path.join(tmp, ...f.path.split('/'));
      let buf;
      try { buf = fs.readFileSync(src); } catch (e) { return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): ${f.path} no está en el comprimido (${e.code || e.message})` }; }
      const blob = GH.blobSha(buf);
      if (blob !== f.sha) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): ${f.path} no es el blob que la lista del árbol declara (${sha7(blob)} ≠ ${sha7(f.sha)})` };
      files.push({ path: f.path, mode: f.mode || '100644', blob });
      staged.push({ path: f.path, buf });
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const s of staged) { const to = path.join(cacheDir, ...s.path.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, s.buf); }
    const manifest = { schema: 1, repo: resolved.repo, ref: resolved.ref, commit: resolved.commit, tree: resolved.tree, etag: resolved.etag || null, name: resolved.declaration.name, requires: resolved.declaration.requires, files, fetched_at: nowIso() };
    fs.writeFileSync(path.join(cacheDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
    if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} bajada y verificada en ${cacheDir} (${files.length} archivo(s), árbol ${sha7(resolved.tree)})`);
    return { ok: true, cacheDir, files, fromCache: false, resolved };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* queda en la temporal */ }
  }
}

/** Un destino relativo, sin «..» ni «.git», que quede dentro del árbol (la misma defensa que las skills de terceros). */
function saneTarget(incomingDir, t) {
  return typeof t === 'string' && t && !path.isAbsolute(t) && !t.includes('\\') && !t.includes('\0') && !t.includes(':')
    && !t.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')
    && path.resolve(incomingDir, t).startsWith(`${path.resolve(incomingDir)}${path.sep}`);
}
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/**
 * Apila la capa bajada sobre `incomingDir` (la versión que va a quedar): comprueba que la versión no traiga ninguna ruta de
 * la capa (colisión), vuelve a validar el perfil con el lector DE ESA versión, copia cada archivo (atómico) y deja
 * `.tycon-team.json`. `{ ok, files, manifest }` o `{ ok: false, reason, collision? }` sin escribir nada.
 */
function stackTeam(fetched, incomingDir, { home = os.homedir(), env = process.env, log = null } = {}) {
  const resolved = fetched.resolved;
  const relm = rel().readManifest(incomingDir);
  const collision = foldedCollision(fetched.files.map((f) => f.path), relm);
  if (collision.length) return { ok: false, collision, reason: `la versión ${relm && relm.version ? relm.version : 'bajada'} trae ${collision.join(', ')}: choca con la capa del equipo (${resolved.repo}) y no se instala` };
  for (const f of fetched.files) if (!saneTarget(incomingDir, f.path)) return { ok: false, reason: `capa del equipo: ${JSON.stringify(f.path)} no es un destino dentro del árbol: no se apila nada` };
  const pf = profileFileOf(fetched.files);
  if (pf) {
    let text;
    try { text = fs.readFileSync(path.join(fetched.cacheDir, ...pf.path.split('/')), 'utf8'); } catch (e) { return { ok: false, reason: `capa del equipo: no pude leer ${pf.path} de la caché (${e.code || e.message})` }; }
    const v = validateProfile(text, { readerTree: incomingDir, home, env, name: pf.path });
    if (!v.ok) return { ok: false, invalid: true, reason: `capa del equipo (${resolved.repo}): ${v.reason} — la capa no se apila` };
  }
  // el momento 2 (AC 26): los nombres y los paquetes contra la versión que va a quedar
  const cv = checkAgainstVersion(fetched.cacheDir, fetched.files, incomingDir, { env });
  if (!cv.ok) return { ok: false, invalid: true, reason: `capa del equipo (${resolved.repo}) @ ${sha7(resolved.commit)}: no vale para la versión que va a quedar — ${cv.problems.map((x) => `${x.path}: ${x.reason}`).join(' · ')} — la capa no se apila` };
  for (const f of fetched.files) {
    const buf = fs.readFileSync(path.join(fetched.cacheDir, ...f.path.split('/')));
    writeAtomic(path.join(incomingDir, ...f.path.split('/')), buf);
  }
  // el manifiesto apilado dice lo RESUELTO ahora (repo, etag, declaración); de la caché sólo cuándo se bajó (clase 3: la caché no
  // puede pisar lo resuelto, o el estado dependería de corridas anteriores)
  const cached = readTeamManifest(fetched.cacheDir) || {};
  const manifest = { schema: 1, repo: resolved.repo, host: resolved.host || 'github', ref: resolved.ref, commit: resolved.commit, tree: resolved.tree, etag: resolved.etag || null, name: resolved.declaration.name, requires: resolved.declaration.requires, files: fetched.files, fetched_at: cached.fetched_at || nowIso(), applied_at: nowIso() };
  writeAtomic(path.join(incomingDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
  if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} apilada en ${incomingDir} (${fetched.files.length} archivo(s))`);
  return { ok: true, files: fetched.files.length, manifest };
}

/**
 * Sin acceso al repo del equipo, la capa que YA está en `harnessDir` pasa a `incomingDir` (comprobada contra su manifiesto,
 * blob por blob). `{ ok, files, manifest }` o `{ ok: false, reason }`.
 */
function carryTeam(harnessDir, incomingDir, { home = os.homedir(), env = process.env, log = null } = {}) {
  const m = readTeamManifest(harnessDir);
  if (!m) return { ok: false, reason: `${harnessDir} no trae ${MANIFEST_NAME}: no hay capa que arrastrar` };
  const intact = filesIntact(harnessDir, m.files);
  if (!intact) return { ok: false, reason: `la capa del equipo instalada (${m.repo} @ ${sha7(m.commit)}) no está entera en ${harnessDir}: no se arrastra una capa editada o incompleta` };
  // lo arrastrado se valida como lo apilado (AC 6, D4): la lista cerrada y el perfil con el lector de la versión que va a quedar
  // —un vocabulario más chico en la versión nueva vuelve «roto» un perfil que hoy vale— (pase adversarial, clases 1, 4 y 12)
  const outside = intact.map((f) => f.path).filter((p) => !isLayerPath(p));
  if (outside.length) return { ok: false, reason: `la capa del equipo instalada trae ${outside.join(', ')}, fuera de la lista cerrada: no se arrastra` };
  const setBad = setProblems(intact.map((f) => f.path)).filter((x) => !/versión|terceros/.test(x.reason));
  if (setBad.length) return { ok: false, reason: `la capa del equipo instalada no cumple la lista cerrada (${setBad.map((x) => `${x.path}: ${x.reason}`).join(' · ')}): no se arrastra` };
  const pf = profileFileOf(intact);
  if (pf) {
    const v = validateProfile(fs.readFileSync(path.join(harnessDir, ...pf.path.split('/')), 'utf8'), { readerTree: incomingDir, home, env, name: pf.path });
    if (!v.ok) return { ok: false, invalid: true, reason: `la capa del equipo instalada (${m.repo} @ ${sha7(m.commit)}) no vale para la versión que va a quedar: ${v.reason} — no se arrastra` };
  }
  // los nombres y los paquetes contra la versión nueva (AC 19): una versión cuyo cargador no acepta la capa instalada tampoco la recibe
  const cv = checkAgainstVersion(harnessDir, intact, incomingDir, { env });
  if (!cv.ok) return { ok: false, invalid: true, reason: `la capa del equipo instalada (${m.repo} @ ${sha7(m.commit)}) no vale para la versión que va a quedar: ${cv.problems.map((x) => `${x.path}: ${x.reason}`).join(' · ')} — no se arrastra` };
  const relm = rel().readManifest(incomingDir);
  const collision = foldedCollision(intact.map((f) => f.path), relm);
  if (collision.length) return { ok: false, collision, reason: `la versión ${relm && relm.version ? relm.version : 'bajada'} trae ${collision.join(', ')}: choca con la capa del equipo (${m.repo}) y no se instala` };
  for (const f of intact) {
    if (!saneTarget(incomingDir, f.path)) return { ok: false, reason: `capa del equipo: ${JSON.stringify(f.path)} no es un destino dentro del árbol: no se arrastra nada` };
    writeAtomic(path.join(incomingDir, ...f.path.split('/')), fs.readFileSync(path.join(harnessDir, ...f.path.split('/'))));
  }
  // (lo que el refresco conservó editado —`kept`— no viaja: queda en harness/, que pasa a previous/)
  const manifest = Object.assign({}, m, { files: intact, kept: undefined, carried_at: nowIso() });
  writeAtomic(path.join(incomingDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
  if (log) log(`team: ${m.repo} @ ${sha7(m.commit)} arrastrada de ${harnessDir} a ${incomingDir} (sin acceso al repo del equipo)`);
  return { ok: true, files: intact.length, manifest };
}

// ── el refresco EN EL LUGAR (tanda A1b · AC 10) ─────────────────────────────────────────────────────────────────────

/** Renombrar con un reintento corto: en Windows un archivo recién escrito o abierto por otro proceso traba el rename un rato. */
function renameRetry(from, to) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(from, to); return; } catch (e) { last = e; if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break; nap(150 * (i + 1)); }
  }
  throw last;
}
/**
 * ¿Puede la carpeta `dir` (relativa, con «/»; '' es la raíz) tener un archivo de la capa? Lo decide la MISMA regla de
 * pertenencia (`layerPathProblem`), probada con un archivo de cada forma que la lista admite: una sola fuente (AC 17).
 */
function dirCanHoldLayer(dir) {
  if (dir === '') return true;
  return [...CLOSED_PATHS.map((p) => path.posix.basename(p)), 'x.md', 'pack.json'].some((name) => isLayerPath(`${dir}/${name}`));
}
/**
 * ¿Es `rel` (relativa al árbol, con «/») un temporal del refresco? Sólo un ARCHIVO con el prefijo, directamente en una carpeta
 * que puede tener un archivo de la capa: nada más se le esconde a `doctor` (pase adversarial de la A1b, S-1).
 */
function isLayerTemp(rel) {
  const s = String(rel || '');
  const dir = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : '';
  return path.posix.basename(s).startsWith(TMP_PREFIX) && dirCanHoldLayer(dir);
}
/**
 * Los temporales del refresco que quedaron de un corte, borrados: en la raíz, en scripts/metrics y agents, y en las carpetas de
 * los archivos de la capa (los del manifiesto instalado, los conservados, los del pendiente y los de `extra`, la capa nueva) que
 * la regla de pertenencia admite.
 */
function dropTemps(harnessDir, extra = []) {
  const m = readTeamManifest(harnessDir);
  const pending = readPending(harnessDir);
  const from = [...((m && m.files) || []).map((f) => f.path), ...((m && m.kept) || []), ...(pending ? [...pending.blobs.keys()] : []), ...extra];
  const dirs = new Set(['', 'scripts/metrics', 'agents']);
  for (const p of from.map(String).filter(isLayerPath)) { const d = path.posix.dirname(p); if (d !== '.') dirs.add(d); }
  for (const d of dirs) {
    const abs = path.join(harnessDir, ...d.split('/').filter(Boolean));
    let names = [];
    try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const n of names) if (n.isFile() && n.name.startsWith(TMP_PREFIX)) { try { fs.rmSync(path.join(abs, n.name), { force: true }); } catch (_) { /* queda: doctor no lo cuenta */ } }
  }
}
/**
 * El refresco EN CURSO (pase adversarial de la A1b, FP-1): antes de los renames se escribe `.tycon-team.pending.json` con el commit
 * y los blobs nuevos, y se borra después del manifiesto. Si el proceso muere en el medio (o el deshacer no pudo reponer algo), un
 * archivo con el blob del pendiente es «del arnés, a medio refrescar», nunca «editado a mano»: el refresco siguiente lo completa,
 * `doctor` lo dice como tal y `uninstall` no lo conserva como edición.
 */
const PENDING_NAME = '.tycon-team.pending.json';
/** El pendiente: null si no hay; `{ corrupt: true, blobs: (vacío) }` si está y no se puede leer (se DICE en doctor, no se calla). */
function readPending(dir) {
  const file = path.join(dir, PENDING_NAME);
  if (!exists(file)) return null;
  const corrupt = { corrupt: true, commit: null, blobs: new Map() };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(j) || !SHA40.test(String(j.commit)) || !Array.isArray(j.files)) return corrupt;
    const blobs = new Map();
    for (const f of j.files) if (isObject(f) && typeof f.path === 'string' && SHA40.test(String(f.blob))) blobs.set(f.path, f.blob);
    return { corrupt: false, commit: j.commit, blobs };
  } catch (_) { return corrupt; }
}
let tmpSeq = 0;
const tmpFor = (file) => path.join(path.dirname(file), `${TMP_PREFIX}${path.basename(file)}-${process.pid}-${(++tmpSeq).toString(36)}`);

/**
 * La capa bajada (`fetched`: la caché de un commit nuevo) reemplaza a la de `harnessDir` —la versión que corre—, como una
 * transacción chica (revisión adversarial de la A1b, C1): cada archivo se arma en un temporal al lado de su destino y se verifica
 * por su blob; recién entonces se renombra cada uno (con reintento corto); si uno no se puede, se repone lo ya cambiado, se borran
 * los temporales y se dice; el manifiesto se escribe ÚLTIMO. Reglas: un archivo cuyo blob en disco no es ni el del manifiesto
 * instalado ni el nuevo (editado a mano) no se pisa; lo que el commit nuevo ya no trae se borra sólo si conserva su blob (si no,
 * se conserva y queda en `kept`); sólo se escribe o borra una ruta de la lista cerrada que pasa `saneTarget` y que la versión
 * pública instalada NO trae (W7: el manifiesto viejo es un archivo local); tras un corte, «blob = el del commit nuevo» es bien
 * puesto. El perfil se valida con el lector de `harnessDir` antes de tocar nada.
 * `{ ok, manifest, written, removed, kept, keptRemoved, from }` o `{ ok: false, reason, collision? }`. Nunca tira.
 */
function refreshInPlace(fetched, harnessDir, { home = os.homedir(), env = process.env, log = null } = {}) {
  const resolved = fetched.resolved;
  try {
    dropTemps(harnessDir, fetched.files.map((f) => f.path));
    const relm = rel().readManifest(harnessDir);
    const publicPaths = new Set(relm && Array.isArray(relm.files) ? relm.files.map((f) => foldPath(f.path)) : []);
    const collision = foldedCollision(fetched.files.map((f) => f.path), relm);
    if (collision.length) return { ok: false, collision, reason: `la versión instalada${relm && relm.version ? ` ${relm.version}` : ''} trae ${collision.join(', ')}: choca con la capa del equipo (${resolved.repo}) y la capa no se refresca` };
    const ours = (p) => isLayerPath(p) && saneTarget(harnessDir, p) && !publicPaths.has(foldPath(p));
    for (const f of fetched.files) if (!ours(f.path)) return { ok: false, reason: `capa del equipo: ${JSON.stringify(f.path)} no es un destino de la capa dentro del árbol: no se refresca nada` };
    const pf = profileFileOf(fetched.files);
    if (pf) {
      let text;
      try { text = fs.readFileSync(path.join(fetched.cacheDir, ...pf.path.split('/')), 'utf8'); } catch (e) { return { ok: false, reason: `capa del equipo: no pude leer ${pf.path} de la caché (${e.code || e.message})` }; }
      const v = validateProfile(text, { readerTree: harnessDir, home, env, name: pf.path });
      if (!v.ok) return { ok: false, invalid: true, reason: `capa del equipo (${resolved.repo}): ${v.reason} — la capa no se refresca` };
    }
    // el momento 2 (AC 26) contra la versión INSTALADA, por su lista: la capa vieja que ya está en harnessDir no cuenta (AC 18)
    const cv = checkAgainstVersion(fetched.cacheDir, fetched.files, harnessDir, { env });
    if (!cv.ok) return { ok: false, invalid: true, reason: `capa del equipo (${resolved.repo}) @ ${sha7(resolved.commit)}: no vale para la versión instalada — ${cv.problems.map((x) => `${x.path}: ${x.reason}`).join(' · ')} — la capa no se refresca` };
    const old = readTeamManifest(harnessDir);
    const oldBlob = new Map(((old && old.files) || []).map((f) => [f.path, f.blob || f.sha]));
    const abs = (p) => path.join(harnessDir, ...p.split('/'));
    const readOrNull = (p) => { try { return fs.readFileSync(abs(p)); } catch (_) { return null; } };
    // un blob «del arnés»: el del manifiesto instalado, o el de un refresco anterior que quedó a medias (FP-1)
    const pending = readPending(harnessDir);
    const fromHarness = (p, blob) => blob === oldBlob.get(p) || Boolean(pending && pending.blobs.get(p) === blob);
    // el plan, sin escribir nada
    const writes = [], removes = [], kept = [], keptRemoved = [];
    for (const f of fetched.files) {
      const cur = readOrNull(f.path);
      const disk = cur === null ? null : blobOf(cur);
      if (disk === f.blob) continue;                                                  // ya está (también tras un corte)
      if (disk !== null && !fromHarness(f.path, disk)) { kept.push(f.path); continue; }   // editado a mano: no se pisa
      writes.push({ path: f.path, blob: f.blob, before: cur });
    }
    const now = new Set(fetched.files.map((f) => f.path));
    for (const p of [...oldBlob.keys(), ...((old && old.kept) || []), ...(pending ? pending.blobs.keys() : [])]) {
      if (now.has(p) || !ours(p) || removes.some((r) => r.path === p) || keptRemoved.includes(p)) continue;
      const cur = readOrNull(p);
      if (cur === null) continue;
      if (fromHarness(p, blobOf(cur))) removes.push({ path: p, before: cur }); else keptRemoved.push(p);
    }
    // 1. los temporales, verificados por su blob
    const staged = [];
    const cleanup = () => { for (const s of staged) { try { fs.rmSync(s.tmp, { force: true }); } catch (_) { /* dropTemps lo hace la próxima */ } } };
    try {
      for (const w of writes) {
        const buf = fs.readFileSync(path.join(fetched.cacheDir, ...w.path.split('/')));
        if (blobOf(buf) !== w.blob) { cleanup(); return { ok: false, reason: `capa del equipo: ${w.path} de la caché no es el blob del commit ${sha7(resolved.commit)}: no se refresca nada` }; }
        fs.mkdirSync(path.dirname(abs(w.path)), { recursive: true });
        const tmp = tmpFor(abs(w.path));
        fs.writeFileSync(tmp, buf);
        staged.push(Object.assign({ tmp }, w));
      }
    } catch (e) { cleanup(); return { ok: false, reason: `capa del equipo: no pude preparar el refresco en ${harnessDir} (${e.code || e.message}) — no se cambió nada` }; }
    // 2. lo que está por cambiar queda anotado (FP-1), y los cambios; si uno falla, se repone lo hecho
    const pendingFile = abs(PENDING_NAME);
    try {
      const pt = tmpFor(pendingFile);
      fs.writeFileSync(pt, `${JSON.stringify({ schema: 1, commit: resolved.commit, files: fetched.files.map((f) => ({ path: f.path, blob: f.blob })), at: nowIso() }, null, 1)}\n`);
      renameRetry(pt, pendingFile);
    } catch (e) { cleanup(); return { ok: false, reason: `capa del equipo: no pude anotar el refresco en ${harnessDir} (${e.code || e.message}) — no se cambió nada` }; }
    const done = [];
    // devuelve lo que NO pudo reponer (dicho en el motivo, nunca callado); si repuso todo, el pendiente se borra
    const undo = () => {
      const notRestored = [];
      for (const d of done.reverse()) {
        try { if (d.before === null) fs.rmSync(abs(d.path), { force: true }); else { const t = tmpFor(abs(d.path)); fs.writeFileSync(t, d.before); renameRetry(t, abs(d.path)); } } catch (e) { notRestored.push(`${d.path} (${e.code || e.message})`); }
      }
      cleanup();
      if (!notRestored.length) { try { fs.rmSync(pendingFile, { force: true }); } catch (_) { /* el próximo refresco lo trata como a medias: inofensivo */ } }
      return notRestored;
    };
    let current = null;
    try {
      for (const s of staged) { current = s.path; renameRetry(s.tmp, abs(s.path)); done.push(s); }
      for (const r of removes) { current = r.path; fs.rmSync(abs(r.path), { force: true }); done.push(r); }
      current = MANIFEST_NAME;
      const cached = readTeamManifest(fetched.cacheDir) || {};
      const manifest = { schema: 1, repo: resolved.repo, host: resolved.host || 'github', ref: resolved.ref, commit: resolved.commit, tree: resolved.tree, etag: resolved.etag || null, name: resolved.declaration.name, requires: resolved.declaration.requires, files: fetched.files, fetched_at: cached.fetched_at || nowIso(), applied_at: nowIso() };
      if (keptRemoved.length) manifest.kept = keptRemoved;
      const mt = tmpFor(abs(MANIFEST_NAME));
      fs.writeFileSync(mt, `${JSON.stringify(manifest, null, 1)}\n`);
      try { renameRetry(mt, abs(MANIFEST_NAME)); } catch (e) { try { fs.rmSync(mt, { force: true }); } catch (_) { /* dropTemps */ } throw e; }
      try { fs.rmSync(pendingFile, { force: true }); } catch (_) { /* con el manifiesto nuevo, un pendiente viejo del mismo commit no cambia nada */ }
      pruneEmptyDirs(harnessDir, removes.map((r) => r.path), relm);
      if (log) log(`team: ${resolved.repo} ${sha7(old && old.commit)} → ${sha7(resolved.commit)} refrescada en ${harnessDir} (escritos ${staged.length}, borrados ${removes.length}, editados a mano sin pisar ${kept.length + keptRemoved.length})`);
      return { ok: true, manifest, written: staged.map((s) => s.path), removed: removes.map((r) => r.path), kept, keptRemoved, from: old ? old.commit : null };
    } catch (e) {
      const notRestored = undo();
      return { ok: false, reason: `capa del equipo: no pude reemplazar ${current} en ${harnessDir} (${e.code || e.message}) — ${notRestored.length ? `y no pude reponer ${notRestored.join(', ')}: queda a medio refrescar, el próximo refresco lo completa (harness.js doctor lo detalla)` : 'no se cambió nada'}` };
    }
  } catch (e) {
    return { ok: false, reason: `capa del equipo: el refresco no se pudo hacer (${e.message}) — no se cambió nada` };
  }
}

/**
 * Las carpetas que el refresco dejó vacías al sacar archivos de la capa (una skill que el commit nuevo ya no trae), borradas de
 * abajo hacia arriba (tanda A2a · AC 27): sólo debajo de skills/, agents/ o packs/, nunca esas tres, nunca una carpeta que la
 * versión pública trae, y sólo si está VACÍA (un archivo editado a mano que quedó la sostiene). Nunca tira.
 * La carpeta del texto del alta (`TEAM_ONLY_TOPS`, story 8.26 · AC 66) sí se borra ELLA: la versión no la trae, existe sólo
 * mientras la capa trae sus archivos, y vacía quedaría en el árbol sin dueño. Las mismas dos defensas: vacía, y no de la versión.
 */
function pruneEmptyDirs(harnessDir, removedPaths, relm) {
  const publicDirs = new Set();
  for (const f of (relm && Array.isArray(relm.files) ? relm.files : [])) for (let d = path.posix.dirname(foldPath(f.path)); d !== '.' && d !== ''; d = path.posix.dirname(d)) publicDirs.add(d);
  const tops = new Set(['skills', 'agents', 'packs']);
  const under = (d) => { const top = d.split('/')[0]; return tops.has(top) || TEAM_ONLY_TOPS.includes(top); };
  for (const p of removedPaths) {
    for (let d = path.posix.dirname(String(p)); d !== '.' && d !== '' && !tops.has(d) && under(d); d = path.posix.dirname(d)) {
      if (publicDirs.has(foldPath(d))) break;
      try { fs.rmdirSync(path.join(harnessDir, ...d.split('/'))); } catch (e) { if (e.code === 'ENOENT') continue; break; }   // ya no está: sigue arriba; no vacía: se para ahí
    }
  }
}

/**
 * Lo que `doctor` dice de la capa de un árbol (A1b · AC 11), sin red y sin tirar nunca: `{ present, manifest, edited, missing,
 * kept }`; `{ present: false, broken }` si hay un `.tycon-team.json` que no sirve; `{ present: false, error }` si algo tiró.
 */
function teamStatus(tree) {
  try {
    const m = readTeamManifest(tree);
    if (!m) return { present: false, broken: exists(path.join(tree, MANIFEST_NAME)) };
    const edited = [], missing = [], halfDone = [];
    const pending = readPending(tree);
    for (const f of m.files) {
      if (!isLayerPath(f.path) || !isSafe(f.path)) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(tree, ...f.path.split('/'))); } catch (_) { missing.push(f.path); continue; }
      const blob = blobOf(buf);
      if (blob === (f.blob || f.sha)) continue;
      // con el blob de un refresco que quedó a medias: del arnés, no editado (FP-1)
      if (pending && pending.blobs.get(f.path) === blob) halfDone.push(f.path); else edited.push(f.path);
    }
    const kept = (m.kept || []).filter((p) => isLayerPath(p) && isSafe(p) && exists(path.join(tree, ...p.split('/'))));
    return { present: true, manifest: m, edited, missing, kept, halfDone, pendingCommit: pending ? pending.commit : null, pendingCorrupt: Boolean(pending && pending.corrupt) };
  } catch (e) {
    return { present: false, error: e.message };
  }
}

/**
 * Antes de que `uninstall` quite los árboles (A1b · AC 12): cada archivo de la capa editado a mano —blob distinto del de su
 * manifiesto— se copia a `<keepRoot>/kept-YYYYMMDD-HHMMSS/<rótulo>/<ruta>` (sin «:», que Windows no admite; la misma ruta en
 * dos árboles no se pisa; nunca se pisa una carpeta que ya existe). Sólo rutas de la lista cerrada que pasan `saneTarget`. Nunca
 * tira: `{ ok, dir, copied: ['<rótulo>/<ruta>'], failedTrees: ['<rótulo>'], problems }` — un árbol con algo que no se pudo
 * copiar no se tiene que quitar.
 */
/**
 * Lo que está dentro de la carpeta de una skill de la lista fija en un árbol y no es de la versión (su `.tycon-release.json`)
 * ni de la capa (su `.tycon-team.json`, con lo conservado y un refresco a medias): una conexión, una spec escrita ahí por error
 * (tanda A2c · AC 36). `[{ entry, path }]` (ruta relativa al árbol, con «/»). Nunca tira. Una carpeta que está y no se puede
 * listar NO es «nada ajeno»: queda en `out.unreadable` (`['<ruta> (<código>)']`) para que quien llama lo diga y no descarte
 * a ciegas (cazador de fallos silenciosos, A2c); una que no está (ENOENT) sí es «nada».
 */
function extrasForeign(tree, { entries = loadExtras().entries } = {}) {
  const out = [];
  out.unreadable = [];
  try {
    const relm = rel().readManifest(tree);
    const known = new Set((relm && Array.isArray(relm.files) ? relm.files : []).map((f) => foldPath(f.path)));
    const tm = readTeamManifest(tree);
    for (const p of tm ? [...tm.files.map((f) => f.path), ...(tm.kept || [])] : []) known.add(foldPath(p));
    const pending = readPending(tree);
    if (pending) for (const p of pending.blobs.keys()) known.add(foldPath(p));
    for (const e of entries) {
      const walk = (abs, relp, depth) => {
        let ents = [];
        try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) { if (!err || err.code !== 'ENOENT') out.unreadable.push(`${relp} (${(err && (err.code || err.message)) || err})`); return; }
        for (const d of ents) {
          const r = `${relp}/${d.name}`;
          if (d.isDirectory()) { if (depth < 12) walk(path.join(abs, d.name), r, depth + 1); else out.unreadable.push(`${r} (más de 12 carpetas de profundidad)`); continue; }
          if (d.name.startsWith(TMP_PREFIX) || d.name === '.DS_Store' || known.has(foldPath(r))) continue;
          out.push({ entry: e, path: r });
        }
      };
      walk(path.join(tree, ...e.skill.split('/')), e.skill, 0);
    }
  } catch (err) { out.unreadable.push(`${tree} (${(err && err.message) || err})`); }   // nunca tira: doctor corre dentro de la salud
  return out;
}

/** El contenido de un `VERSION` (la primera línea), o null. */
const versionIn = (dir) => { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').split(/\r?\n/)[0].trim() || null; } catch (_) { return null; } };
/** Lo que una carpeta propia trae de `userContent`/`legacyData` de la entrada (nombres, nunca contenidos) que la capa no trae. */
function userStuffIn(dir, e, layerSet) {
  const out = [];
  for (const pat of [...(e.userContent || []), ...e.legacyData]) {
    if (pat.endsWith('/')) { if (exists(path.join(dir, pat.slice(0, -1)))) out.push(pat); continue; }
    const star = pat.indexOf('*');
    if (star < 0) { if (exists(path.join(dir, pat))) out.push(pat); continue; }
    const sub = path.posix.dirname(pat); const re = new RegExp(`^${path.posix.basename(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let names = [];
    // una carpeta que está y no se pudo listar se nombra igual (no se calla como «no trae nada»)
    try { names = fs.readdirSync(path.join(dir, ...sub.split('/'))); } catch (err) { names = []; if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') out.push(`${sub}/ (no se pudo listar: ${err.code || err.message})`); }
    for (const n of names) if (re.test(n) && !layerSet.has(foldPath(`${e.skill}/${sub}/${n}`))) out.push(`${sub}/${n}`);
  }
  return out;
}
/**
 * Lo que `doctor` dice de las skills de la lista fija que la capa de `tree` trae (tanda A2c · AC 36), siempre `warn` u `ok`, nunca
 * `fail` y nunca tira: lo ajeno dentro de su carpeta (con su lugar), la carpeta propia del dev que la tapa en ~/.claude/skills y
 * —con Codex enchufado— en $CODEX_HOME/skills (con las dos VERSION y lo ajeno que trae), el original que la mudanza ya copió, la
 * casa que se resolvió, y la revisión vencida. `{ items, foreign: Set<ruta> }` (las rutas que reemplazan la línea «de más»).
 */
function skillDataDoctor({ home = os.homedir(), env = process.env, tree, team = null, codex = false, now = new Date() } = {}) {
  const items = [];
  const foreignSet = new Set();
  try {
    const layer = layerFilesOf(tree);
    const layerSet = new Set(layer.map(foldPath));
    const entries = extrasInLayer(layer);
    if (!entries.length) return { items, foreign: foreignSet };
    const ownRoot = realOrNull(TH.ownPaths({ env }).root) || TH.ownPaths({ env }).root;
    const strays = extrasForeign(tree, { entries });
    for (const u of strays.unreadable) items.push({ level: 'warn', text: `${u}: dentro de la carpeta de una skill de la lista fija, no se pudo listar — lo que haya ahí no se revisó (y se pierde con la próxima versión)` });
    for (const x of strays) {
      foreignSet.add(x.path);
      const base = path.posix.basename(x.path);
      const dh = dataHomeOf(x.entry, { home, env });
      items.push({ level: 'warn', text: x.entry.legacyData.includes(base) && path.posix.dirname(x.path) === x.entry.skill
        ? `${x.path}: la conexión de un dev dentro de la carpeta de la skill — su lugar es ${dh.file} (se pierde con la próxima versión)`
        : `${x.path}: dentro de la carpeta de una skill de la lista fija — se pierde con la próxima versión: copialo afuera (las specs van en la carpeta del proyecto)` });
    }
    for (const e of entries) {
      const name = e.skill.slice('skills/'.length);
      const layerVersion = versionIn(path.join(tree, ...e.skill.split('/'))) || 'sin VERSION';
      const places = [path.join(home, '.claude', 'skills', ...name.split('/'))];
      if (codex) places.push(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', ...name.split('/')));
      for (const p of places) {
        const real = realOrNull(p);
        if (!real || isUnderDir(real, ownRoot)) continue;
        const stuff = userStuffIn(real, e, layerSet);
        items.push({ level: 'warn', text: `${p} es una carpeta propia y tapa la ${name} de la capa (la tuya: ${versionIn(real) || 'sin VERSION'}; la de la capa: ${layerVersion})${stuff.length ? ` — trae lo que no es de la skill: ${stuff.join(', ')}: copialo antes de sacarla` : ''}; sacarla es tuyo (el arnés no la toca)` });
      }
      const dh = dataHomeOf(e, { home, env });
      const moved = isObject(team) && isObject(team.data_moved) ? team.data_moved[name] : null;
      if (moved && typeof moved.from === 'string' && moved.from && exists(moved.from)) {
        let cmp = '';
        try { if (exists(dh.file) && !fs.readFileSync(dh.file).equals(fs.readFileSync(moved.from))) cmp = '; las dos difieren y gana la casa nueva'; } catch (err) { cmp = `; no pude compararlas (${err.code || err.message})`; }
        items.push({ level: 'warn', text: `${name}: su conexión vieja sigue en ${moved.from}${moved.copied === false ? ` (no se copió: ${moved.reason || 'ver la salida de la actualización'})` : ` y ya está en ${dh.file}`}${cmp} — borrala de ahí cuando confirmes que anda` });
      }
      // la casa que se resolvió, como `warn` (AC 36: «avisa, con warn y nunca fail»): así una diferencia entre lo que mira el arnés
      // y lo que mira la skill —otra BIZUIT_SDD_HOME en la sesión— se ve en cada doctor
      items.push({ level: 'warn', text: `${name}: la casa de sus datos es ${dh.file} (${exists(dh.file) ? 'existe' : 'todavía no existe'}${dh.from === 'env' ? `, por ${e.dataHome.env}` : ''})${dh.ignored ? ` — ${dh.ignored}` : ''}` });
      if (extrasReviewDue(e, now)) items.push({ level: 'warn', text: `la skill ${name} tiene su revisión vencida (${e.review.next}): quien la revisa corre la fecha ${e.review.every_months} meses o decide el retiro (primero el repo del equipo, después la versión)` });
    }
  } catch (err) {
    items.push({ level: 'warn', text: `skills de la lista fija: no pude revisarlas (${err.message})` });
  }
  return { items, foreign: foreignSet };
}

function keepEdited(pairs, keepRoot, { now = new Date(), edited = true, foreign = false } = {}) {
  const copied = [], failedTrees = [], problems = [];
  let dir = null;
  const makeDir = () => {
    const stampText = now.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
    fs.mkdirSync(keepRoot, { recursive: true });
    for (let i = 1; i < 100; i++) {
      const d = path.join(keepRoot, `kept-${stampText}${i > 1 ? `-${i}` : ''}`);
      try { fs.mkdirSync(d); return d; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw new Error(`no encontré un nombre libre para kept-${stampText} en ${keepRoot}`);
  };
  for (const [label, tree] of pairs) {
    let m = null;
    try { m = readTeamManifest(tree); } catch (_) { m = null; }
    // lo ajeno dentro de una skill de la lista fija (tanda A2c · AC 36): se guarda con las mismas reglas que lo editado; una
    // carpeta de esas que no se pudo listar es un problema de ESE árbol (no se quita), nunca «nada ajeno»
    // sólo las skills de la lista que la capa DE ESE ÁRBOL trae: un árbol sin capa no se recorre (AC 16; pase adversarial de la
    // A2c, clase 13 — antes recorría la lista entera y podía negarse a quitar un árbol sin capa)
    const found = foreign ? extrasForeign(tree, { entries: extrasInLayer(layerFilesOf(tree)) }) : null;
    const strays = found ? found.map((x) => ({ path: x.path, blob: null, stray: true, max: x.entry.maxBytes })) : [];
    if (found && found.unreadable.length) {
      for (const u of found.unreadable) problems.push(`${label}/${u}: no se pudo listar (lo de adentro de una skill de la lista fija no se pudo revisar)`);
      if (!failedTrees.includes(label)) failedTrees.push(label);
    }
    if (!m && !strays.length) continue;
    const pending = m ? readPending(tree) : null;
    const entries = [...(m && edited ? [...m.files.map((f) => ({ path: f.path, blob: f.blob || f.sha })), ...(m.kept || []).map((p) => ({ path: p, blob: null }))] : []), ...strays];
    for (const f of entries) {
      // un ajeno con un nombre que saneTarget no admite (`:` o `\`, válidos en Mac y Linux) no se saltea callado: se dice y ese
      // árbol no se quita (pase adversarial de la A2c, clase 2 — una spec «notas 10:00.md» se perdía sin aviso)
      if (f.stray && !saneTarget(tree, f.path)) { problems.push(`${label}/${f.path}: su nombre no se puede copiar a ${keepRoot} — no se guardó; copialo a mano`); if (!failedTrees.includes(label)) failedTrees.push(label); continue; }
      if ((!f.stray && !isLayerPath(f.path)) || !saneTarget(tree, f.path)) continue;
      // lo ajeno puede ser la conexión de un dev o una spec: un enlace no se sigue (copiaría el contenido de OTRO archivo), lo que
      // no es un archivo regular no se lee, y nada pasa del presupuesto de la skill; se dice y ese árbol no se quita (revisor de
      // seguridad, A2c)
      if (f.stray) {
        let st = null;
        try { st = fs.lstatSync(path.join(tree, ...f.path.split('/'))); } catch (e) { if (e && e.code === 'ENOENT') continue; st = null; }
        const why = !st ? 'no se pudo mirar' : st.isSymbolicLink() ? 'es un enlace: no se sigue' : !st.isFile() ? 'no es un archivo' : (f.max && st.size > f.max ? `pesa ${st.size} bytes, más que el presupuesto de su skill` : null);
        if (why) { problems.push(`${label}/${f.path}: ${why} — no se guardó`); if (!failedTrees.includes(label)) failedTrees.push(label); continue; }
      }
      let buf;
      // un archivo que ya no está no hay que conservarlo; uno que está y no se puede leer puede ser una edición: ese árbol no se
      // quita (fallos silenciosos, A2a vuelta 3 — antes se salteaba callado y `uninstall` lo borraba)
      try { buf = fs.readFileSync(path.join(tree, ...f.path.split('/'))); } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        problems.push(`${label}/${f.path}: ${(e && (e.code || e.message)) || e}`);
        if (!failedTrees.includes(label)) failedTrees.push(label);
        continue;
      }
      if (f.blob && blobOf(buf) === f.blob) continue;
      if (pending && f.blob && pending.blobs.get(f.path) === blobOf(buf)) continue;   // a medio refrescar: del arnés (FP-1)
      try {
        if (!dir) dir = makeDir();
        const to = path.join(dir, label, ...f.path.split('/'));
        // lo ajeno, sólo para el usuario (puede ser su conexión: la mudanza la deja 0600 y acá no se puede abrir más)
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: f.stray ? 0o700 : undefined });
        fs.writeFileSync(to, buf, { flag: 'wx', mode: f.stray ? 0o600 : undefined });
        if (f.stray) { try { fs.chmodSync(to, 0o600); fs.chmodSync(dir, 0o700); } catch (_) { /* Windows: hereda los de la carpeta del usuario */ } }
        copied.push(`${label}/${f.path}`);
      } catch (e) {
        problems.push(`${label}/${f.path}: ${e.code || e.message}`);
        if (!failedTrees.includes(label)) failedTrees.push(label);
      }
    }
  }
  return { ok: problems.length === 0, dir, copied, failedTrees, problems };
}

/**
 * Lo que el estado guarda (`state.team`). `previous` (la entrada que reemplaza): lo que la máquina ya mudó de las skills de la
 * lista fija (`data_moved`, tanda A2c · AC 35) se conserva, así una capa nueva no repite la mudanza.
 */
function stateEntry(manifest, previous = null) {
  const host = manifest.host || (/^https:\/\/dev\.azure\.com\//i.test(String(manifest.repo || '')) ? 'azure' : 'github');
  const out = { repo: manifest.repo, host, ref: manifest.ref || TEAM_REF, commit: manifest.commit, tree: manifest.tree || null, etag: manifest.etag || null, name: manifest.name || null, files: Array.isArray(manifest.files) ? manifest.files.length : 0, applied_at: manifest.applied_at || manifest.carried_at || nowIso() };
  if (isObject(previous) && isObject(previous.data_moved)) out.data_moved = previous.data_moved;
  return out;
}

// ── los datos de una skill de la lista, fuera de su carpeta (tanda A2c · AC 35) ───────────────────────────────────────
const LEGACY_MAX_BYTES = 64 * 1024;
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const isUnderDir = (p, d) => Boolean(p && d) && (p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
/** Las skills de la lista que la capa trae (por las rutas de la capa). */
function extrasInLayer(layerPaths, entries = loadExtras().entries) {
  const ps = (layerPaths || []).map(String);
  return entries.filter((e) => ps.some((p) => foldPath(p).startsWith(`${foldPath(e.skill)}/`)));
}
/** Las rutas de la capa instalada en un árbol (su `.tycon-team.json`), o []. */
const layerFilesOf = (tree) => { const m = tree ? readTeamManifest(tree) : null; return m ? m.files.map((f) => f.path) : []; };
/**
 * Dónde puede estar lo que la skill escribía en su carpeta, en el ORDEN FIJO del AC 35: la carpeta propia del dev en
 * `~/.claude/skills/<s>` (carpeta real, o enlace cuya ruta real no cae bajo la casa del arnés); la carpeta apartada por la
 * mudanza (`aside`, y las `<carpeta de skills>.before-migrate-*`, la más nueva primero); el clon que la máquina dejó; y
 * `previous/`. `[{ file, where }]`, sólo lo que existe, sin repetir el mismo archivo real. Sólo lee.
 */
function findLegacyData(e, { home, env, migrateHome = null, previousDir = null }) {
  const sub = e.skill.slice('skills/'.length).split('/');
  const ownRoot = realOrNull(TH.ownPaths({ env }).root) || TH.ownPaths({ env }).root;
  const dirs = [];
  const own = path.join(home, '.claude', 'skills', ...sub);
  const ownReal = realOrNull(own);
  if (ownReal && !isUnderDir(ownReal, ownRoot)) dirs.push({ dir: own, where: 'tu carpeta propia de la skill' });
  const skillsDir = TH.installedSkillsDir(home);
  const asides = [];
  const out = [];
  // lo que está y no se pudo mirar NO es «no está» (cazador de fallos silenciosos, A2c): se junta en `out.unreadable` y se dice
  out.unreadable = [];
  if (migrateHome && typeof migrateHome.aside === 'string' && migrateHome.aside) asides.push(migrateHome.aside);
  try {
    const base = path.basename(skillsDir);
    for (const n of fs.readdirSync(path.dirname(skillsDir)).filter((x) => x.startsWith(`${base}.before-migrate-`)).sort().reverse()) asides.push(path.join(path.dirname(skillsDir), n));
  } catch (err) { if (!err || err.code !== 'ENOENT') out.unreadable.push(`${path.dirname(skillsDir)} (${(err && (err.code || err.message)) || err})`); }
  for (const a of asides) dirs.push({ dir: path.join(a, ...e.skill.split('/')), where: 'la carpeta apartada por la mudanza' });
  const clones = migrateHome ? (Array.isArray(migrateHome.from) ? migrateHome.from : [migrateHome.from]) : [];
  for (const c of clones) if (typeof c === 'string' && c) dirs.push({ dir: path.join(c, ...e.skill.split('/')), where: 'el clon que esta máquina dejó' });
  if (previousDir) dirs.push({ dir: path.join(previousDir, ...e.skill.split('/')), where: 'la versión anterior (previous/)' });
  const seen = new Set();
  for (const d of dirs) {
    for (const name of e.legacyData) {
      const file = path.join(d.dir, name);
      try { fs.lstatSync(file); } catch (err) {
        // ENOENT (y ENOTDIR: un tramo del camino no es carpeta) es «no está»; cualquier otro, «no pude mirar»
        if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') out.unreadable.push(`${file} (${err.code || err.message})`);
        continue;
      }
      const key = realOrNull(file) || file;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, where: d.where });
    }
  }
  return out;
}
/** ¿Trae una clave de primer nivel sensible? (sin caja; nunca se devuelve el valor) */
// (con o sin BOM al principio del archivo: pase adversarial de la A2c, clase 8)
const SENSITIVE_RE = /^(?:﻿)?["']?(password|secret|token)["']?\s*:/im;
/**
 * La mudanza de los datos de las skills de la lista que la capa trae (AC 35): por skill, UNA vez (`team.data_moved[<s>] =
 * { at, from }`), el primer archivo viejo del orden fijo va a la casa nueva —sólo si la casa no tiene uno; sólo un archivo
 * regular de hasta 64 KB (un enlace no se sigue); carpeta 700 y archivo 600; el original queda—. El CONTENIDO nunca va a una
 * línea, al registro ni al estado. Lo que no se pudo escribir se dice y no se registra (se reintenta); lo que no se copia por
 * su forma (enlace, tamaño) se dice y se registra. `dryRun`: sólo dice qué haría. `team` se modifica (salvo `dryRun`).
 * `{ lines, changed }`. Nunca tira.
 */
function moveSkillData({ home = os.homedir(), env = process.env, team, layerPaths = null, harnessDir = null, migrateHome = null, previousDir = null, dryRun = false, now = new Date() } = {}) {
  const lines = [];
  let changed = false;
  if (!isObject(team)) return { lines, changed };
  let entries = [];
  // «no pude leer la lista fija» no es «no hay skills con datos»: se dice, y la próxima actualización vuelve a intentar (no se
  // registra nada) — cazador de fallos silenciosos, A2c vuelta 2
  try { entries = extrasInLayer(layerPaths || layerFilesOf(harnessDir)); } catch (err) { lines.push(`skills de la lista fija: no pude leer qué trae la capa (${(err && err.message) || err}): la conexión vieja no se revisó; se vuelve a intentar en la próxima actualización`); return { lines, changed }; }
  const ext = loadExtras();
  if (!ext.ok && (layerPaths || layerFilesOf(harnessDir)).some((p) => String(p).startsWith('skills/'))) lines.push(`skills de la lista fija: ${ext.problem}: la conexión vieja no se revisó; se vuelve a intentar en la próxima actualización`);
  for (const e of entries) {
    const name = e.skill.slice('skills/'.length);
    if (isObject(team.data_moved) && team.data_moved[name]) continue;
    try {
      const dh = dataHomeOf(e, { home, env });
      const head = `${name}: su conexión`;
      if (dh.ignored) lines.push(`${name}: ${dh.ignored} (la casa es ${dh.dir})`);
      const found = findLegacyData(e, { home, env, migrateHome, previousDir });
      // lo que no se pudo mirar se dice (y, sin nada encontrado, no se registra: la próxima actualización vuelve a mirar)
      if (found.unreadable.length) lines.push(`${head} vieja: no pude mirar ${found.unreadable.join(', ')} — si estaba ahí, no se mudó`);
      const record = (from, extra = {}) => { if (dryRun) return; team.data_moved = Object.assign({}, team.data_moved, { [name]: Object.assign({ at: now.toISOString(), from }, extra) }); changed = true; };
      // sin nada que mudar no se registra: la próxima actualización vuelve a mirar (unas pocas miradas al disco), así una
      // conexión vieja que aparece después de instalar —una carpeta propia restaurada, la mudanza hecha más tarde— también llega
      if (!found.length) continue;
      const first = found[0];
      const rest = found.slice(1).map((f) => `${f.file} (${f.where})`);
      const restLine = rest.length ? ` · también hay en ${rest.join(', ')}: no se copian` : '';
      const st = fs.lstatSync(first.file);
      if (st.isSymbolicLink()) { lines.push(`${head} en ${first.file} es un enlace: no se sigue ni se copia — copiala a mano a ${dh.file}${restLine}`); record(first.file, { copied: false, reason: 'enlace' }); continue; }
      if (!st.isFile()) { lines.push(`${head} en ${first.file} no es un archivo: no se copia${restLine}`); record(first.file, { copied: false, reason: 'no es un archivo' }); continue; }
      if (st.size > LEGACY_MAX_BYTES) { lines.push(`${head} en ${first.file} pesa ${st.size} bytes, más de 64 KB: no se copia — revisala y copiala a mano a ${dh.file}${restLine}`); record(first.file, { copied: false, reason: 'más de 64 KB' }); continue; }
      if (exists(dh.file)) {
        let same = null;
        let cmpErr = null;
        try { same = fs.readFileSync(dh.file).equals(fs.readFileSync(first.file)); } catch (err) { cmpErr = err.code || err.message; }
        // sin poder comparar no se afirma que difieren (cazador de fallos silenciosos, A2c): se dice que no se pudo, y gana la casa
        lines.push(cmpErr ? `${head}: ${dh.file} ya existe y no pude compararla con ${first.file} (${cmpErr}): gana la casa nueva (no se pisa)${restLine}`
          : same ? `${head} ya está en ${dh.file}: el original en ${first.file} se puede borrar${restLine}` : `${head}: ${dh.file} ya existe y es distinta de ${first.file}: gana la casa nueva (no se pisa); revisá la vieja y borrala${restLine}`);
        record(first.file, { copied: false, reason: cmpErr ? 'la casa ya tenía una (no se pudo comparar)' : same ? 'ya estaba' : 'la casa ya tenía otra' });
        continue;
      }
      if (dryRun) { lines.push(`${head}: se copiaría ${first.file} (${first.where}) a ${dh.file}${restLine}`); continue; }
      const buf = fs.readFileSync(first.file);
      const tmp = path.join(dh.dir, `.tycon-tmp-${process.pid}-${Date.now()}`);
      try {
        fs.mkdirSync(dh.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows: hereda los de la carpeta del usuario */ }
        if (exists(dh.file)) throw Object.assign(new Error('la casa nueva apareció mientras se copiaba'), { code: 'EEXIST' });
        fs.renameSync(tmp, dh.file);
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* queda un temporal oculto */ }
        lines.push(`${head}: no pude copiar ${first.file} a ${dh.file} (${err.code || err.message}): sigue donde estaba; se vuelve a intentar en la próxima actualización`);
        continue;
      }
      lines.push(`${head} pasó de ${first.file} (${first.where}) a ${dh.file} (sólo para tu usuario); el original queda: borralo cuando confirmes que anda${restLine}`);
      if (SENSITIVE_RE.test(buf.toString('utf8'))) lines.push(`${head} trae una clave sensible: borrala de ${first.file} y de ${dh.file} (la contraseña nunca va a disco)`);
      record(first.file);
    } catch (err) {
      lines.push(`${name}: no pude revisar su conexión vieja (${err.code || err.message}): se vuelve a intentar en la próxima actualización`);
    }
  }
  return { lines, changed };
}

/**
 * `state.team` puesto al día con lo que HAY en `harnessDir` (tras una vuelta a previous/ hecha por el arranque o el respaldo en
 * shell, que no tocan el estado): la capa del manifiesto que quedó, o —si el árbol que quedó no trae capa— el repo que el
 * estado recordaba, sin commit (así `update` la vuelve a traer). Sin `team` en el estado, nada cambia.
 */
function syncStateWithTree(state, harnessDir, { adopt = false } = {}) {
  if (!isObject(state)) return false;
  // `adopt` (A1b, rollback): un estado SIN team y un árbol que quedó CON capa la toma (la capa la apiló alguien que la registró)
  if (!isObject(state.team)) {
    const m0 = adopt ? readTeamManifest(harnessDir) : null;
    if (!m0) return false;
    state.team = stateEntry(m0, state.team);
    return true;
  }
  const m = readTeamManifest(harnessDir);
  if (m) {
    const entry = stateEntry(m, state.team);
    if (entry.commit === state.team.commit && entry.repo === state.team.repo) return false;
    state.team = entry;
    return true;
  }
  if (state.team.commit === null && state.team.files === 0) return false;
  state.team = Object.assign({}, state.team, { commit: null, tree: null, etag: null, files: 0, applied_at: null });
  return true;
}

/**
 * Las rutas del árbol que son de la capa (para que `doctor` no las cuente «de más»): el manifiesto, el pendiente de un refresco a
 * medias, y las del manifiesto y las conservadas QUE SON DE LA LISTA CERRADA — el manifiesto es un archivo local en el que no se
 * confía: `kept: ["scripts"]` no puede esconder una carpeta entera (pase adversarial de la A1b, S-1).
 */
function layerPaths(tree) {
  const m = readTeamManifest(tree);
  if (!m) return [];
  const own = [...m.files.map((f) => f.path), ...(m.kept || [])].filter((p) => isLayerPath(p));
  return [MANIFEST_NAME, ...(exists(path.join(tree, PENDING_NAME)) ? [PENDING_NAME] : []), ...own];
}

module.exports = {
  PROFILE_PATH, LEGACY_PROFILE_PATH, PROFILE_PATHS, isProfilePath, profileFileOf, profileIn, profileNameNotice,
  CLOSED_PATHS, MANIFEST_NAME, DECLARATION, TEAM_REF, MAX_TOTAL_BYTES, MAX_FILES, FORBIDDEN_PROFILE_KEYS, TMP_PREFIX, PENDING_NAME, isLayerTemp,
  EXTRAS_FILE, MAX_EXTRAS, validateExtras, loadExtras, extrasEntryFor, extrasPathProblem, extrasReviewDue, dataHomeOf,
  extrasInLayer, findLegacyData, moveSkillData, extrasForeign, skillDataDoctor, blobStore,
  layerPathProblem, contentProblems, frontmatterKeys, versionIndex, checkAgainstVersion, judgeContent, dropStaged, isContentChecked, pruneEmptyDirs,
  parseTeam, openSource, teamOf, planTeam, validateDeclaration, validateProfile, validateTeamRepos, TEAM_REPOS_PATH, resolveTeam, planLine, collisionWith, collisionReason, fetchTeam, stackTeam, carryTeam,
  stateEntry, readTeamManifest, layerPaths, cacheDirOf, syncStateWithTree, refreshInPlace, teamStatus, keepEdited, blobOf, filesIntact,
};
