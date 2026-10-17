#!/usr/bin/env node
'use strict';
// new-names.js — el freno de nombres reales NUEVOS en lo que se publica (épica 8, story 8.10 · 2026-09-28)
//
// POR QUÉ EXISTE: el núcleo se escribe sin nombres reales (decisión del 2026-09-28) y hasta hoy eso lo cuidaba sólo
// quien escribía. Medido el último mes: la mitad de los commits que tocaron archivos que salen en la copia pública
// metió un nombre (2.803 menciones netas en 30 días). La tabla de reemplazos del exportador los tapa al publicar, pero
// sólo mientras esté completa; y limpiar lo ya escrito no dura si el mes siguiente entra otro tanto. Este freno corre al
// commitear (y en el pull request del arnés) y no deja entrar un nombre NUEVO en un archivo que sale.
//
// QUÉ MIRA, archivo por archivo, «antes» contra «después»:
//   · DESPUÉS = el índice que git le pasa al hook (`GIT_INDEX_FILE`: con `git commit -a` o `git commit <ruta>` no es el
//     de siempre) o la punta de `--range`. ANTES = `HEAD` (cada padre en un merge) o la base del rango.
//   · Qué sale y con qué contenido lo decide el EXPORTADOR (`whatShips` de export.js): la misma lista blanca,
//     exclusiones fijas, `afuera` privados, revisores de paquete y transformaciones que arman la copia. Cada foto se
//     clasifica con su propia configuración (lo que salía antes, con la de antes); la lista de nombres es siempre la
//     del después (AC 9: sumar un término no hace frenar las menciones que ya estaban).
//   · Neto: una categoría y texto (sin distinguir caja) que aparece más veces después que antes —en un merge, más que
//     en CUALQUIERA de los padres—. Retocar, mover o renombrar lo que ya estaba no frena: así se apaga un freno.
//   · Además: los nombres pegados (`<Término>Backend`, la regla del exportador), la ruta de un archivo nuevo, una
//     entrada de primer nivel sin clasificar que el commit estrena, el techo del termómetro que sube sin un término
//     nuevo, un producto de `product-parity.json` que la lista no ve, un término de la lista sin su par, y una
//     excepción (`permitidos`, un `out` de la lista o un `afuera` privado) que viaja en el mismo commit que el nombre
//     que la necesita.
//   · Sólo nombres (cliente, persona, host-interno, maquina, interno): secretos, correos y rutas de máquina los sigue
//     mirando el detector del exportador.
//
// CÓMO FALLA: exit 0 = pasa · 1 = hallazgos (el commit no se crea) · 2 = no pude mirar (tampoco se crea). «No pude
// mirar» nunca es verde. Sin la lista de denegación ni el perfil del equipo (`team-profile.json`, o `perfil-equipo.json`; un laboratorio; la copia pública tiene su
// modo, más abajo) no dice nada: ahí no hay lista por diseño. Sin el otro repo (agent-skills para un commit del arnés),
// avisa fuerte y deja pasar. `TYCON_NEW_NAMES=0` lo apaga y lo dice en cada commit. Cada commit que tuvo algo que mirar
// deja una línea de conteos —nunca un texto encontrado— en ~/.claude/.tycon-pipeline/new-names.jsonl y en el registro
// de frenos.
//
// EN EL REPO UNIDO (story 8.18: el arnés con agent-skills adentro) no hay «otro repo»: el pre-commit corre el freno una
// vez por fuente sobre la misma raíz, cada corrida mira lo de SU fuente lógica (por ruta) y cada hallazgo sale una vez.
// Un rango cuya base es de antes de la unión compara la mitad que esa base no trae con su propia historia.
//
// EN EL ÁRBOL QUE ES LA FORMA PUBLICADA (story 8.26, tanda H1c). Quien mantiene el arnés commitea en un clon del repo
// PÚBLICO. Ese árbol no trae la lista, la tabla ni el perfil —son privados—, y el freno callaba («no hay lista por
// diseño»): un nombre real se veía recién al empujar, con el commit ya hecho. Ahí corre un modo aparte:
//   · CUÁNDO: el árbol que se commitea trae scripts/setup/public-remotes.json (sólo existe en la copia publicada) y no
//     trae lista propia. Es una señal positiva: «sin lista ni perfil» también lo cumple cualquier laboratorio de prueba.
//     La forma es la que el árbol ERA —el commit de antes; el índice, sólo si no hay ninguno—: un commit no cambia de
//     modo borrando la señal, trayéndola, ni sacando o trayendo una lista. Sólo con lo preparado: `--range` es de la
//     validación. Un árbol interno al que le falta la lista NO cae acá: sigue siendo «no pude mirar».
//   · CON QUÉ LISTA: la de la MÁQUINA, nunca la del árbol que se commitea (el commit elegiría con qué lista se lo mira).
//     Los lugares y la regla son los del freno antes de publicar (scripts/hooks/public-push-guard.js): la variable
//     TYCON_PUBLISH_DENYLIST, el clon de mantenimiento que la máquina declara (`paths.maintainers`) y el clon que
//     mantiene (`paths.maintained`). Declarada y ausente, o ilegible: «no pude mirar». Si sale de la variable, se dice en
//     cada commit y el que pasa queda anotado como un escape. Si la lista vive en un clon atrasado, se avisa (sin salir a
//     la red) y el veredicto no cambia.
//   · SIN LISTA EN NINGÚN LUGAR: si la máquina es del equipo (su arnés INSTALADO trae el perfil), lo dice en una línea
//     —«no miré», que no es «miré y está limpio»— y deja pasar: lo mira el freno al empujar. Si no (alguien de afuera con
//     su copia), calla.
//   · QUÉ MIRA: lo que el commit agrega, neto y archivo por archivo, y la ruta de un archivo nuevo o renombrado. TODO lo
//     tocado cuenta como que sale tal cual —también `tasks/` o `specs/`: ahí no hay exportador que los saque—, sin
//     transformaciones ni tabla de reemplazos. Las excepciones de la lista (`permitidos`) valen como en el detector.
//   · QUÉ NO MIRA: secretos, correos, rutas de máquina, binarios y enlaces. Este freno es de nombres; lo demás lo mira el
//     freno al empujar, con el detector completo. Un binario, un enlace o un submódulo no se leen, y NO frenan. Tampoco
//     corre lo que es del árbol interno: el techo del termómetro, los pares, los productos, la excepción que viaja en el
//     mismo commit.
//   · QUÉ DICE: dónde (archivo y línea) y la categoría; nunca el texto encontrado, ni una ruta que lo traiga. De un freno
//     falso se sale con una excepción con motivo en `permitidos` de la lista privada, o con `TYCON_NEW_NAMES=0`.
//   · UNA VEZ: el pre-commit lo corre por las dos fuentes; la del arnés mira todo y la otra calla.
//
// A mano:
//   node scripts/publishing/new-names.js [--repo <dir>] [--source arnes|agent-skills]            (lo stageado)
//   node scripts/publishing/new-names.js --range <base>...<punta> [--config-from tip|disk] [--json]
// Guía: guides/maintaining/publicacion-espejo.md §«El núcleo sin nombres»

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const crypto = require('crypto');
const Module = require('module');
const { spawnSync } = require('child_process');
const exporter = require('../publishing/export.js');
const detector = require('./detector.js');

const HARNESS_ROOT = path.resolve(__dirname, '..', '..');
const EXPORTER_PATH = path.join(HARNESS_ROOT, 'scripts', 'publishing', 'export.js');
const SOURCES = ['arnes', 'agent-skills'];
const NAME_CATEGORIES = new Set(['cliente', 'persona', 'host-interno', 'maquina', 'interno']);
const CONFIG = {
  list: 'scripts/publishing/allowlist.json',
  table: 'scripts/publishing/replacements.json',
  denied: 'scripts/publishing/denylist.json',
  exporter: 'scripts/publishing/export.js',
  ceiling: 'scripts/publishing/names-ceiling.json',
  parity: 'scripts/ci/product-parity.json',   // su ruta de antes de la tanda D1 sale del mapa (legacyPathsOf)
  profile: 'team-profile.json',
  legacyProfile: 'perfil-equipo.json',   // el nombre de antes del perfil: sigue diciendo «este árbol es del equipo»
};
/** El perfil que trae `dir` (el nombre de hoy primero), o undefined. */
const profileIn = (dir) => [CONFIG.profile, CONFIG.legacyProfile].find((n) => fs.existsSync(path.join(dir, n)));
const hasProfile = (dir) => Boolean(profileIn(dir));
// El exportador se mudó en la tanda C2 de la story 8.9: en una foto de antes vive en su ruta vieja, que sale del mapa
// de renombres —nunca escrita acá—. Sin mapa (la copia pública) no hay rutas viejas.
const legacyNames = require('../lib/legacy-names.js');
const EXPORTER_PATHS = [CONFIG.exporter, ...legacyNames.usableEntries(legacyNames.loadMap())
  .filter((e) => e.kind === 'file' && (e.repo || 'arnes') === 'arnes' && e.new === CONFIG.exporter).map((e) => e.old)];
// La configuración se mudó (y la lista, la tabla y la de denegación cambiaron de nombre) en la tanda C4: una foto de antes
// —la base de un `--range`, el HEAD de un pre-commit— la tiene en su ruta vieja. La vieja sale del mapa, nunca escrita
// acá: la entrada `file` con ese nombre nuevo, o la `folder` que lo contiene. Primero la ruta nueva; la vieja, sólo si en
// esa foto no está. Sin mapa (la copia pública) no hay rutas viejas.
function legacyPathsOf(ruta, map = legacyNames.loadMap()) {
  const files = [];
  const folders = [];
  for (const e of legacyNames.usableEntries(map)) {
    if ((e.repo || 'arnes') !== 'arnes' || typeof e.old !== 'string' || typeof e.new !== 'string') continue;
    if (e.kind === 'file' && e.new === ruta) files.push(e.old);
    else if (e.kind === 'folder' && ruta.startsWith(`${e.new}/`)) folders.push(`${e.old}/${ruta.slice(e.new.length + 1)}`);
  }
  return [...new Set([...files, ...folders])].filter((x) => x !== ruta);
}
const CONFIG_LEGACY = new Map(Object.values(CONFIG).map((ruta) => [ruta, legacyPathsOf(ruta)]));
const LEGACY_CONFIG_PATHS = new Set([...CONFIG_LEGACY.values()].flat());
/** La ruta con que una foto (un Map ruta → entrada) tiene esa configuración: la nueva, o la vieja del mapa; null si ninguna. */
function configPathIn(harness, ruta) {
  for (const r of [ruta, ...(CONFIG_LEGACY.get(ruta) || legacyPathsOf(ruta))]) {
    const e = harness.get(r);
    if (e && e.tipo === 'blob') return r;
  }
  return null;
}
/** ¿`p` es esa configuración, por su ruta nueva o por una vieja del mapa? Un rango cuya punta es de antes de la mudanza
 *  (repetir un rango histórico con el código de hoy) la toca por la vieja: lo tocado se reconoce por las dos (pase
 *  adversarial de la C4). */
const legacyOf = (ruta) => CONFIG_LEGACY.get(ruta) || legacyPathsOf(ruta);
const isConfigPath = (ruta, p) => typeof p === 'string' && (p === ruta || legacyOf(ruta).includes(p));
const withLegacy = (rutas) => rutas.flatMap((r) => [r, ...legacyOf(r)]);
const PACK = /^packs\/[^/]+\/pack\.json$/;
// Lo que reclasifica los dos repos (un archivo que no salía puede empezar a salir) y lo que dispara el freno aunque no
// salga (la lista, el techo, los productos). Los demás archivos que no salen no cargan nada (AC 14).
const RECLASSIFY = { arnes: [...withLegacy([CONFIG.list, CONFIG.table]), ...EXPORTER_PATHS], 'agent-skills': [] };
const TRIGGERS = { arnes: [...RECLASSIFY.arnes, ...withLegacy([CONFIG.denied, CONFIG.ceiling, CONFIG.parity])], 'agent-skills': [] };
const isReclassify = (source, ruta) => RECLASSIFY[source].includes(ruta) || (source === 'agent-skills' && PACK.test(ruta));
const isTrigger = (source, ruta) => TRIGGERS[source].includes(ruta) || isReclassify(source, ruta);
const SPECIAL = (ruta, lista) => ruta === 'adapters/codex/agents/MANIFEST.json' || ruta === 'guides/advisor-rules-catalog.md'
  || ruta === 'scripts/tests/suites.json' || ruta === '.gitignore' || /^scripts\/controls-bench\/baseline\/[^/]+\.json$/.test(ruta)
  || Object.prototype.hasOwnProperty.call((lista && lista.empty) || {}, ruta);

class CouldNotLook extends Error {}
const say = (s) => process.stderr.write(`${s}\n`);

// ── las claves de la lista blanca (story 8.9, tanda D1) ──────────────────────────────────────────────────────────
// Las claves de la lista cambiaron de nombre en la D1. Una foto de antes (la base de un rango, el HEAD del commit que la
// muda, la punta de un rango histórico) la trae con las viejas: el freno la lee siempre con las de hoy (`readKeysDeep`,
// con el mapa), y a un exportador de esa misma foto —que lee las suyas— se la devuelve con las de su época. Las viejas
// salen del mapa, nunca escritas acá; sin mapa (la copia pública) no hay viejas y todo es paso directo.
const listKeyEntries = () => legacyNames.usableEntries(legacyNames.loadMap())
  .filter((e) => e.kind === 'key' && e.where === CONFIG.list && typeof e.old === 'string' && typeof e.new === 'string');
/** La lista con las claves de hoy. Una clave vieja y su nueva con valores distintos: «no pude mirar». */
function normalizeKeys(lista) {
  if (!lista || typeof lista !== 'object') return lista;
  try {
    // la lista sale siempre de una foto de git (índice, base o punta de un rango): es historia, no un uso (no se anota)
    return legacyNames.readKeysDeep(lista, CONFIG.list, { record: false });
  } catch (e) {
    if (e instanceof legacyNames.LegacyNamesError) throw new CouldNotLook(e.message);
    throw e;
  }
}
/** La lista con las claves y los paquetes de hoy (para comparar dos fotos: el mismo paquete con dos nombres es uno). */
function normalizeList(lista) {
  const keyed = normalizeKeys(lista);
  return typeof exporter.paquetesConNombresNuevos === 'function' ? exporter.paquetesConNombresNuevos(keyed) : keyed;
}
/** ¿El texto de una lista usa alguna clave vieja? (así se sabe con qué claves lee el exportador de esa foto) */
function usesLegacyKeys(text) {
  const old = new Set(listKeyEntries().map((e) => e.old));
  if (!old.size || typeof text !== 'string') return false;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }   // el error lo da parseJson, con su mensaje
  const walk = (v) => (Array.isArray(v) ? v.some(walk) : !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => old.has(k) || walk(x)));
  return walk(parsed);
}
/** La lista (con las claves de hoy) con las claves viejas, para el exportador de una foto de antes de la D1. */
function toLegacyKeys(lista) {
  const back = new Map(listKeyEntries().map((e) => [e.new, e.old]));
  if (!back.size) return lista;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [back.get(k) || k, walk(x)]));
  };
  return walk(lista);
}
/** La lista como la lee el exportador de la foto: el de hoy, con las claves de hoy; uno de antes de la D1, con las suyas. */
const listForMod = (snap, lista) => (snap.mod !== exporter && snap.legacyKeys ? toLegacyKeys(lista) : lista);
const azure = () => /^true$/i.test(process.env.TF_BUILD || '');
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── git ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Dos gits: el del HOOK (con el entorno que git le pasa, para leer el índice del commit en curso: `GIT_INDEX_FILE`) y
// el AISLADO del exportador (sin ningún `GIT_*`), para leer objetos por sha. El aislado no sirve para el índice: borra
// `GIT_INDEX_FILE` y con `git commit -a` no vería nada (AC 10).
function hookGit(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new CouldNotLook(`no pude correr git ${args[0]} (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new CouldNotLook(`git ${args.join(' ')} falló en ${dir}: ${String(r.stderr).trim() || `salió ${r.status}`}`);
  return r.stdout;
}
function isolated(dir, args, { tolerate = false, input } = {}) {
  const r = exporter.git(dir, args, { input });
  if (!tolerate && r.status !== 0) throw new CouldNotLook(`git ${args.join(' ')} falló en ${dir}: ${String(r.stderr).trim()}`);
  return r;
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function indexTree(dir) {
  const out = hookGit(dir, ['ls-files', '-s', '-z']);
  const entries = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [modo, obj, stage] = rec.slice(0, tab).split(' ');
    if (stage !== '0') throw new CouldNotLook(`el índice tiene conflictos sin resolver (${rec.slice(tab + 1)})`);
    entries.push({ modo, tipo: modo === '160000' ? 'commit' : 'blob', obj, ruta: rec.slice(tab + 1) });
  }
  return entries;
}
const commitTree = (dir, sha) => (sha ? exporter.listarArbol({ dir }, sha) : []);

/** Cambios de `name-status -z -M`: `[{ status, path, oldPath }]`. */
function parseChanges(out) {
  const t = out.split('\0');
  const changes = [];
  for (let i = 0; i < t.length && t[i];) {
    const status = t[i][0];
    if (status === 'R' || status === 'C') { changes.push({ status, oldPath: t[i + 1], path: t[i + 2] }); i += 3; } else { changes.push({ status, path: t[i + 1] }); i += 2; }
  }
  return changes;
}

// ── argumentos ───────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: 'staged', source: 'arnes', configFrom: null, json: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i] === '' || argv[i].startsWith('--')) throw new CouldNotLook(`${flag} necesita un valor`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = value(++i, x);
    else if (x === '--source') a.source = value(++i, x);
    else if (x === '--staged') a.mode = 'staged';
    else if (x === '--range') { a.mode = 'range'; a.range = value(++i, x); } else if (x === '--config-from') a.configFrom = value(++i, x);
    else if (x === '--json') a.json = true;
    else throw new CouldNotLook(`opción desconocida: ${x}`);
  }
  if (!SOURCES.includes(a.source)) throw new CouldNotLook(`--source es arnes o agent-skills (no «${a.source}»)`);
  a.configFrom = a.configFrom || (a.mode === 'staged' ? 'index' : 'tip');
  const valid = a.mode === 'staged' ? ['index', 'disk'] : ['tip', 'disk'];
  if (!valid.includes(a.configFrom)) throw new CouldNotLook(`--config-from ${a.configFrom} no vale con ${a.mode === 'staged' ? 'lo stageado' : '--range'} (${valid.join(' | ')})`);
  return a;
}

// ── los repos y sus fotos ────────────────────────────────────────────────────────────────────────────────────────
const expand = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// La ruta real COMO LA NOMBRA EL DISCO. `fs.realpathSync` sigue los enlaces pero deja las mayúsculas como se las pasaron;
// en un disco que no las distingue (macOS, Windows) la misma carpeta escrita con otra caja «era» otra para quien compara
// letra por letra. La usa el modo de la forma publicada para decir cuál es el árbol que se commitea.
const realNative = (p) => { try { return fs.realpathSync.native(p); } catch { return realOr(p); } };

/** El otro repo, por su HEAD. null = no está (aviso fuerte y se deja pasar, AC 8). */
function otherRepo(source) {
  const dir = source === 'arnes'
    ? require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo
    : (process.env.TYCON_GUIDES_DIR && process.env.TYCON_GUIDES_DIR.trim() ? expand(process.env.TYCON_GUIDES_DIR.trim()) : HARNESS_ROOT);
  if (!fs.existsSync(dir)) return { dir, missing: true };
  const r = isolated(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { tolerate: true });
  if (r.status !== 0) return { dir, missing: true };
  return { dir: realOr(dir), head: r.stdout.trim() };
}

// ── el repo unido (story 8.18): una fuente física, dos lógicas partidas por ruta ───────────────────────────────────
// Desde que el arnés y agent-skills son UN repo, su pre-commit corre este freno dos veces sobre la misma raíz, una por
// fuente. Cada corrida mira lo de SU fuente lógica y arma «el otro repo» con la otra mitad del mismo árbol: no lee
// ningún otro clon y no hay «other-repo-missing». Las rutas de agent-skills son las de siempre, porque entró con cada
// archivo en su lugar. Sin esto, la corrida de agent-skills veía cada carpeta del arnés como «sin clasificar» y la del
// arnés lo mismo con `skills/`: ningún commit que agregara un archivo se podía crear.
const SKILLS_FOLDERS = /^(?:agents|skills|packs)\//;
const SKILLS_FILES = new Set(['.tycon/post-commit-ignore', '.githooks/pre-commit-skills']);
/** La fuente lógica de una ruta del repo unido. */
const sourceOfPath = (ruta) => (SKILLS_FOLDERS.test(ruta) || SKILLS_FILES.has(ruta) ? 'agent-skills' : 'arnes');
/** El árbol de un commit (o el índice) del repo unido, partido en sus dos fuentes lógicas. */
function splitTree(tree) {
  const out = { arnes: [], 'agent-skills': [] };
  for (const e of tree) out[sourceOfPath(e.ruta)].push(e);
  return out;
}
/** Los cambios que le tocan a una fuente. Un renombre que cruza de una a la otra es, para cada una, un alta o una baja. */
function ownChanges(changes, source) {
  const out = [];
  for (const c of changes) {
    const here = sourceOfPath(c.path) === source;
    const from = c.oldPath ? sourceOfPath(c.oldPath) === source : here;
    if (here && from) out.push(c);
    else if (here) out.push({ status: 'A', path: c.path });
    else if (from && c.status === 'R') out.push({ status: 'D', path: c.oldPath });
  }
  return out;
}
/**
 * ¿Este checkout es el repo unido? El arnés del equipo —trae la lista blanca y el perfil— con agent-skills adentro (el
 * criterio de `isSingleRepo`: skills/tycon-pipeline y agents/ en su raíz). La copia pública no entra acá: no tiene
 * perfil, y ahí todo lo del repo cuenta como que sale. El clon viejo de agent-skills tampoco: no trae la lista.
 */
function unifiedCheckout(repo) {
  return require('../lib/canonical-path.js').isSingleRepo(repo)
    && fs.existsSync(path.join(repo, CONFIG.list)) && hasProfile(repo);
}
/** La forma de lo que trae un commit: el repo unido, el arnés solo, agent-skills solo, u otra cosa. */
const shapeOf = (pipeline, agents, list) => (pipeline && agents ? (list ? 'unified' : 'skills') : (list ? 'harness' : 'other'));
/** La forma de una foto (una lista de entradas de `ls-tree`). */
function treeShape(tree) {
  let pipeline = false; let agents = false; let list = false;
  for (const e of tree) {
    if (e.ruta.startsWith('skills/tycon-pipeline/')) pipeline = true;
    else if (e.ruta.startsWith('agents/')) agents = true;
    else if (e.ruta === CONFIG.list) list = true;
  }
  return shapeOf(pipeline, agents, list);
}
/** ¿La foto es del repo unido? La punta de un `--range` puede ser de antes de la unión, o de la historia de agent-skills. */
const unifiedTree = (tree) => treeShape(tree) === 'unified';

// ── un rango que cruza la unión (story 8.18, AC 25) ────────────────────────────────────────────────────────────────
// El pull request del corte sale de un `main` de ANTES de la unión: a la base de su rango le falta una mitad entera.
// Esa mitad no es nueva: entró con su historia por el merge de la unión, y cada commit de esa historia ya pasó por
// estos frenos en su repo. Tomarla por nueva frenaba lo que ya estaba —medido sobre la base de la story: las 7
// variables de agent-skills que su techo ya contaba salían «nuevas» para el pull request— y hacía mirar de nuevo
// cientos de archivos. El antes de la mitad que falta es el commit desde donde entró: el padre, con la forma del otro
// repo, de un merge del rango cuyo árbol ya es el del repo unido. Lo que ese merge (o un commit posterior) cambia sobre
// ese padre se mira como cualquier cambio: nada se saltea. Sin ese merge —la mitad agregada por un commit común, sin su
// historia— no hay antes con que comparar, y la mitad es toda nueva.
const SHAPE_PROBES = ['skills/tycon-pipeline', 'agents', CONFIG.list];
const SHAPE_TYPES = ['tree', 'tree', 'blob'];
/** La forma de varios commits, en una sola llamada a git. */
function commitShapes(repo, shas) {
  const out = new Map();
  if (!shas.length) return out;
  const asked = shas.flatMap((sha) => SHAPE_PROBES.map((p) => `${sha}:${p}`));
  const types = isolated(repo, ['cat-file', '--batch-check=%(objecttype)'], { input: `${asked.join('\n')}\n` }).stdout.split('\n');
  if (types.length < asked.length) throw new CouldNotLook(`git cat-file contestó ${types.length} de ${asked.length} preguntas sobre la forma de los commits del rango`);
  shas.forEach((sha, i) => out.set(sha, shapeOf(...SHAPE_TYPES.map((type, j) => types[i * SHAPE_PROBES.length + j] === type))));
  return out;
}
/**
 * De qué commit sale cada mitad en cada «antes» de un rango del repo unido. Casi siempre uno solo, con la base para las
 * dos. Si a la base le falta una mitad (es de antes de la unión), esa mitad sale de cada lado por donde entró al rango;
 * un lado contenido en otro no suma (el antes es la punta de esa historia). Con más de un lado, cada uno es un «antes»,
 * como los padres de un merge: es nuevo lo que no estaba en ninguno.
 *
 * Pero un lado VIEJO no vale entero (story 8.18, pase adversarial del tramo 2, clase 10). La topología real del pull
 * request del corte: el lado de skills de la unión sale de una rama aparte, y el main de agent-skills siguió desde el
 * mismo punto y se mezcló después; ninguno contiene al otro. Un nombre que la última punta limpió seguía «estando» en el
 * lado viejo, que nunca lo limpió, y volver a meterlo pasaba la red. Ahora el primer lado es el de la mezcla más nueva
 * (la última punta) y cada lado viejo lleva `overlay`: de él vale sólo lo que él mismo cambió desde el punto común con
 * la última punta (lo demás, como en la última punta). Ver `staleSideHalf`.
 */
function rangeBefores(repo, base, tip, baseTree) {
  const whole = [{ arnes: base, 'agent-skills': base }];
  const shape = treeShape(baseTree);
  const missing = shape === 'harness' ? 'agent-skills' : shape === 'skills' ? 'arnes' : null;
  if (!missing) return whole;
  const wanted = missing === 'agent-skills' ? 'skills' : 'harness';
  // --topo-order: las mezclas de la más nueva a la más vieja, siempre (sin depender de las fechas de los commits)
  const merges = isolated(repo, ['rev-list', '--topo-order', '--merges', '--parents', `${base}..${tip}`]).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  if (!merges.length) return whole;
  const shapes = commitShapes(repo, [...new Set(merges.flat())]);
  const sides = [...new Set(merges.filter(([merge]) => shapes.get(merge) === 'unified')
    .flatMap(([, ...merged]) => merged.filter((p) => shapes.get(p) === wanted)))];
  const within = (a, b) => {
    const r = isolated(repo, ['merge-base', '--is-ancestor', a, b], { tolerate: true });
    if (r.status > 1) throw new CouldNotLook(`git merge-base --is-ancestor ${a} ${b} falló en ${repo}: ${String(r.stderr).trim()}`);
    return r.status === 0;
  };
  const tips = sides.filter((s) => !sides.some((o) => o !== s && within(s, o)));
  if (!tips.length) return whole;
  const [latest] = tips;
  return tips.map((s) => {
    const from = { ...whole[0], [missing]: s };
    if (s === latest) return from;
    // el punto común con la última punta (sin ninguno —historias sin relación—, todo lo del lado viejo es suyo)
    const mb = isolated(repo, ['merge-base', s, latest], { tolerate: true });
    if (mb.status > 1) throw new CouldNotLook(`git merge-base ${s} ${latest} falló en ${repo}: ${String(mb.stderr).trim()}`);
    return { ...from, overlay: { half: missing, latest, base: mb.status === 0 ? mb.stdout.trim() : null } };
  });
}

const sameEntry = (x, y) => (x ? `${x.modo} ${x.tipo} ${x.obj}` : null) === (y ? `${y.modo} ${y.tipo} ${y.obj}` : null);
const staleMemo = new Map();
/**
 * La mitad `half` de un lado VIEJO de un rango (`overlay` de `rangeBefores`): de cada ruta, la del lado si el lado la
 * cambió desde el punto común con la última punta (incluido borrarla); si no, la de la última punta. Devuelve el árbol
 * y las rutas donde difiere del lado tal cual (`replaced`): ahí los cambios hasta la punta se vuelven a calcular.
 */
function staleSideHalf(repo, overlay, side) {
  const key = [repo, overlay.half, overlay.latest, overlay.base || '', side].join('\0');
  if (staleMemo.has(key)) return staleMemo.get(key);
  const byPath = (sha) => new Map((sha ? splitTree(commitTree(repo, sha))[overlay.half] : []).map((e) => [e.ruta, e]));
  const own = byPath(side);
  const latest = byPath(overlay.latest);
  const common = byPath(overlay.base);
  const tree = [];
  const replaced = new Set();
  for (const ruta of new Set([...own.keys(), ...latest.keys(), ...common.keys()])) {
    const changedBySide = !sameEntry(own.get(ruta), common.get(ruta));
    const e = changedBySide ? own.get(ruta) : latest.get(ruta);
    if (e) tree.push(e);
    if (!sameEntry(e, own.get(ruta))) replaced.add(ruta);
  }
  tree.sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
  const out = { tree, replaced };
  staleMemo.set(key, out);
  return out;
}
/**
 * El filtro de git que deja sólo una mitad del repo unido: la de agent-skills son sus carpetas y archivos
 * (`SKILLS_FOLDERS`, `SKILLS_FILES`); la del arnés, todo lo demás. Literal y desde la raíz: `skills/` no toma
 * `skillsfile` ni nada parecido. Un cambio que el filtro deja pasar de más lo vuelve a ordenar `ownChanges`.
 */
const SKILLS_PATHSPEC = ['agents/', 'skills/', 'packs/', ...SKILLS_FILES];
const halfPathspec = (source) => SKILLS_PATHSPEC.map((p) => (source === 'agent-skills' ? `:(top,literal)${p}` : `:(top,literal,exclude)${p}`));
/**
 * Los padres de una corrida del repo unido, con los cambios de CADA fuente lógica (`all`) y los de la propia (`changes`).
 * En un rango, cada «antes» de `rangeBefores` es un padre: la mitad que la base no trae se compara con su historia.
 *
 * Los cambios de cada mitad salen de un `diff -M` restringido a ESA mitad (story 8.18, pase adversarial del tramo 2,
 * clase 14): git empareja un renombre sólo dentro de lo que mira. Antes la detección corría sobre el árbol entero y
 * recién después se partía: un archivo de la otra mitad con el mismo texto se quedaba con el origen del renombre, y el
 * movido dentro de la propia mitad pasaba a ser un alta (sus nombres de siempre, «nuevos»). Un renombre que cruza de una
 * mitad a la otra sale, igual que antes, como una baja para una y un alta para la otra.
 */
function unifiedParents(repo, parents, source, range) {
  // lo stageado: el índice que va a commitear el hook (`hookGit`, con su entorno); un rango: commits (`isolated`)
  const diff = range
    ? (from, half) => parseChanges(isolated(repo, ['diff', '-M', '-z', '--name-status', from, range.tip, '--', ...halfPathspec(half)]).stdout)
    : (from, half) => parseChanges(hookGit(repo, ['diff-index', '--cached', '-M', '-z', '--name-status', from || EMPTY_TREE, '--', ...halfPathspec(half)]));
  const memo = new Map();
  const halfFrom = (sha, half) => {
    const k = `${sha}\0${half}`;
    if (!memo.has(k)) memo.set(k, diff(sha, half));
    return memo.get(k);
  };
  // la mitad de un lado viejo (clase 10): lo que git dice desde el lado, salvo en las rutas donde su «antes» es el de la
  // última punta; ahí, el «antes» contra la punta, ruta por ruta (un renombre que toca una de esas rutas se parte en
  // baja y alta: la otra ruta conserva su sentido)
  let tipHalves = null;
  const staleChanges = (from, half) => {
    const raw = halfFrom(from[half], half);
    const { tree, replaced } = staleSideHalf(repo, from.overlay, from[half]);
    if (!replaced.size) return raw;
    if (!tipHalves) tipHalves = splitTree(commitTree(repo, range.tip));
    const before = new Map(tree.map((e) => [e.ruta, e]));
    const after = new Map(tipHalves[half].map((e) => [e.ruta, e]));
    const changes = [];
    for (const c of raw) {
      if (!replaced.has(c.path) && !(c.oldPath && replaced.has(c.oldPath))) { changes.push(c); continue; }
      if (c.status === 'R' && !replaced.has(c.oldPath)) changes.push({ status: 'D', path: c.oldPath });
      if ((c.status === 'R' || c.status === 'C') && !replaced.has(c.path)) changes.push({ status: 'A', path: c.path });
    }
    for (const ruta of [...replaced].sort()) {
      const b = before.get(ruta);
      const a = after.get(ruta);
      if (!sameEntry(a, b)) changes.push({ status: !b ? 'A' : !a ? 'D' : 'M', path: ruta });
    }
    return changes;
  };
  // lo stageado: un antes por padre, las dos mitades de su commit; un rango: los «antes» de `rangeBefores`
  const out = range
    ? rangeBefores(repo, range.base, range.tip, commitTree(repo, range.base)).map((from) => ({ sha: range.base, from }))
    : parents.map((p) => ({ sha: p.sha }));
  for (const p of out) {
    const from = p.from || { arnes: p.sha, 'agent-skills': p.sha };
    p.all = Object.fromEntries(SOURCES.map((half) => [half, ownChanges(
      from.overlay && from.overlay.half === half ? staleChanges(from, half) : halfFrom(from[half], half), half)]));
    p.changes = p.all[source];
  }
  return out;
}
/** El antes de un padre en el repo unido, partido en sus dos fuentes: cada mitad, del commit de donde sale (la de un
 *  lado viejo de un rango, con `staleSideHalf`). */
function beforeHalves(repo, p) {
  const from = p.from || { arnes: p.sha, 'agent-skills': p.sha };
  const whole = splitTree(commitTree(repo, from.arnes));
  const halves = from.arnes === from['agent-skills'] ? whole
    : { arnes: whole.arnes, 'agent-skills': splitTree(commitTree(repo, from['agent-skills']))['agent-skills'] };
  if (!from.overlay) return halves;
  return { ...halves, [from.overlay.half]: staleSideHalf(repo, from.overlay, from[from.overlay.half]).tree };
}
/**
 * Quién mira un archivo que «empieza a salir» ([DEF-8.18-doble-aviso]). Con dos repos la otra fuente no cambia entre el
 * antes y el después, y todo lo que empieza a salir lo causa el propio commit. En el repo unido las dos mitades cambian
 * en el mismo commit y las dos corridas lo ven: el mismo hallazgo salía dos veces. Cada archivo lo mira UNA corrida: lo
 * que el commit toca, la de su fuente; lo que no toca —empieza a salir porque cambió qué se publica—, la de la fuente
 * que lo reclasifica (el arnés si tocó la lista, la tabla o el exportador; si no, agent-skills con sus paquetes) y, si
 * no reclasifica ninguna (un merge), la de su fuente.
 */
function startsHere(source, parents) {
  const touchedBy = { arnes: new Set(), 'agent-skills': new Set() };
  let owner = null;
  for (const f of SOURCES) {
    for (const p of parents) {
      for (const c of p.all[f]) {
        if (c.status !== 'D') touchedBy[f].add(c.path);
        if (owner !== 'arnes' && (isReclassify(f, c.path) || (c.oldPath && isReclassify(f, c.oldPath)))) owner = f;
      }
    }
  }
  return (f, ruta) => (touchedBy[f].has(ruta) ? f === source : (owner || f) === source);
}

/** Un lector de objetos por sha, con memoria, por repo. */
function blobReader(dirs) {
  return (source, obj) => exporter.leerObjetos({ dir: dirs[source] }, [obj]).get(obj);   // recuerda lo ya leído
}

const gitBlobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
let diskExporterSha = null;
const compiled = new Map();
/** La ruta del exportador en una foto: la nueva si ya está, si no la vieja (una foto de antes de la mudanza). */
function exporterIn(harness) {
  return EXPORTER_PATHS.find((ruta) => { const e = harness.get(ruta); return e && e.tipo === 'blob'; }) || null;
}
/**
 * El código del exportador de una foto: si es otro que el de este disco, se compila el de la foto (AC 8(c)). Se compila
 * en la carpeta donde vivía en esa foto: sus `require` relativos (el detector, el freno de castellano) resuelven desde
 * ahí, y uno de antes de la mudanza los busca junto a su ruta vieja.
 */
function exporterFor(ruta, entry, text) {
  if (!entry) return exporter;
  if (diskExporterSha === null) diskExporterSha = gitBlobSha(fs.readFileSync(EXPORTER_PATH));
  if (entry.obj === diskExporterSha) return exporter;
  if (!compiled.has(entry.obj)) {
    let mod;
    // El código de una foto de antes de la mudanza (tanda C4) pide sus vecinos por la carpeta vieja, donde hoy hay un
    // reemplazo generado: ese reemplazo es para los llamadores de afuera, y cargado por el freno anotaba un uso falso del
    // nombre viejo (y en Azure, un aviso por stderr). Mientras se compila, un `require` que cae en un reemplazo va directo
    // a su destino, que es el mismo código (pase adversarial de la C4).
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function resolveSkippingShims(...args) {
      const f = resolve.apply(this, args);
      if (typeof f !== 'string' || !path.isAbsolute(f) || !f.startsWith(`${HARNESS_ROOT}${path.sep}`)) return f;
      let head = '';
      try { head = fs.readFileSync(f, 'utf8'); } catch { return f; }
      if (!legacyNames.isGeneratedShim(path.relative(HARNESS_ROOT, f).split(path.sep).join('/'), head)) return f;
      return legacyNames.shimTarget(f) || f;
    };
    try {
      const file = path.join(HARNESS_ROOT, ruta);
      const m = new Module(file, module);
      m.filename = file;
      m.paths = Module._nodeModulePaths(path.dirname(file));
      m._compile(text(), file);
      mod = m.exports;
    } catch (e) {
      throw new CouldNotLook(`el exportador de esa foto no carga (${e.message}): sin él no sé qué sale`);
    } finally {
      Module._resolveFilename = resolve;
    }
    // Un exportador de antes de esta story no trae la clasificación exportada: se usa la de hoy con los datos de esa foto.
    compiled.set(entry.obj, typeof mod.whatShips === 'function' ? mod : exporter);
  }
  return compiled.get(entry.obj);
}

/**
 * Una foto: los árboles de las dos fuentes y la configuración con que se clasifican. `trees` son listas de entradas
 * como las de `ls-tree` (`{ modo, tipo, obj, ruta }`); la configuración sale del árbol del arnés de la foto o, con
 * `--config-from disk`, del disco del arnés (los manifiestos de paquetes, del HEAD de agent-skills).
 */
function snapshot(name, trees, { dirs, read, disk, harnessDisk, allowMissing }) {
  const harness = new Map(trees.arnes.map((e) => [e.ruta, e]));
  const text = (ruta) => {
    if (disk) {
      const p = path.join(harnessDisk, ruta);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
    const e = harness.get(ruta);
    return e && e.tipo === 'blob' ? read('arnes', e.obj).toString('utf8') : null;
  };
  // la lista y la tabla de una foto de antes de la mudanza (tanda C4), en su ruta vieja; con disk, siempre la de hoy
  const configText = (ruta) => (disk ? text(ruta) : text(configPathIn(harness, ruta) || ruta));
  const listText = configText(CONFIG.list);
  const tableText = configText(CONFIG.table);
  if (listText === null || tableText === null) {
    // un antes sin configuración propia (un commit de antes de la lista blanca) se clasifica con la del después
    if (allowMissing) return { name, trees, harness, text, missingConfig: true, mod: exporter, dirs, read };
    throw new CouldNotLook(`${name}: no está ${listText === null ? CONFIG.list : CONFIG.table} — sin la lista blanca y la tabla no sé qué sale (para repetir commits viejos: --config-from disk)`);
  }
  const exporterPath = disk ? null : exporterIn(harness);
  return { name, trees, harness, text, listText, tableText, legacyKeys: usesLegacyKeys(listText), mod: disk || !exporterPath ? exporter : exporterFor(exporterPath, harness.get(exporterPath), () => text(exporterPath)), dirs, read };
}

/** El contexto que espera el exportador (el mismo que arma su `prepararFuentes`), desde una foto. */
function contextFor(snap, { lista: given, table, strict }) {
  const mod = snap.mod;
  // con las claves de hoy (la de una foto de antes de la D1 trae las viejas); el exportador de la foto la recibe con las
  // suyas. Los paquetes quedan como vienen: los renombra quien compara dos fotos (run).
  const lista = normalizeKeys(given);
  try {
    mod.validarLista(listForMod(snap, lista), CONFIG.list);
  } catch (e) {
    throw new CouldNotLook(`${snap.name}: ${e.message}`);
  }
  // Lo declarado en la lista tiene que existir en la foto: en el DESPUÉS es un error (el exportador saldría 2); en el
  // ANTES es historia, y se saca de la cuenta.
  const has = (ruta) => snap.trees.arnes.some((e) => e.ruta === ruta);
  const problems = [];
  const keep = (x, ruta, what) => { if (has(ruta)) return true; problems.push(`${what}: ${ruta} no existe`); return false; };
  const clean = { ...lista };
  clean.casesOutside = (lista.casesOutside || []).filter((c) => keep(c, c.path, 'casesOutside'));
  clean.synthetic = (lista.synthetic || []).filter((s) => keep(s, s.from, 'synthetic'));
  clean.empty = {};
  for (const [file, keys] of Object.entries(lista.empty || {})) {
    if (file.startsWith('__')) continue;
    const e = snap.harness.get(file);
    const t = e && e.tipo === 'blob' ? snap.read('arnes', e.obj).toString('utf8') : null;
    if (t === null) continue;   // el archivo no está en la foto: nada que vaciar
    let parsed;
    try { parsed = JSON.parse(t); } catch { problems.push(`empty: ${file} no es JSON válido`); continue; }
    // una ruta con puntos («a.b») baja a una clave anidada, como en el exportador (story 8.10.3, pase adversarial)
    const hasPath = (obj, k) => String(k).split('.').every((tramo) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.prototype.hasOwnProperty.call(obj, tramo)) return false;
      obj = obj[tramo];
      return true;
    });
    const present = keys.filter((k) => parsed && hasPath(parsed, k));
    if (present.length !== keys.length) problems.push(`empty: ${file} no tiene ${keys.filter((k) => !present.includes(k)).join(', ')}`);
    if (present.length) clean.empty[file] = present;
  }
  if (strict && problems.length) throw new CouldNotLook(`${snap.name}: la lista blanca declara lo que no está — ${problems.join(' · ')}`);
  const afueraPrivado = (table.afuera || []).map((x) => {
    const bar = String(x.glob || '').indexOf('/');
    return { fuente: String(x.glob).slice(0, bar), glob: String(x.glob).slice(bar + 1), motivo: x.motivo };
  });
  // `estricto: false` (la foto de ANTES): un mapa de renombres roto no puede trabar el commit que lo arregla (story 8.9)
  return { repos: { arnes: { dir: snap.dirs.arnes }, 'agent-skills': { dir: snap.dirs['agent-skills'] } }, arboles: snap.trees, lista: listForMod(snap, clean), afueraPrivado, estricto: !!strict };
}

// Las dos listas privadas y el registro de productos: su contenido NUNCA sale en un mensaje. El error de parseo de V8
// puede traer un pedazo del texto, y los errores de validación nombran los valores; la terminal del commit y el log del
// pipeline de PR no son canales privados (revisor de seguridad, vuelta 3). Se dice el archivo y la posición, y dónde verlo.
const PRIVATE = [CONFIG.denied, CONFIG.table, CONFIG.parity];
const isPrivate = (what) => PRIVATE.some((f) => String(what).startsWith(f));
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CouldNotLook(isPrivate(what)
      ? `${what} no es JSON válido — el detalle no se imprime (es privado): miralo en tu terminal, por ejemplo abriéndolo en el editor`
      : `${what} no es JSON válido (${e.message})`);
  }
}

/** Qué sale en una foto, con su propio código del exportador. Cualquier error del exportador es «no pude mirar». */
function ships(snap, ctx) {
  const guard = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof CouldNotLook) throw e;
      throw new CouldNotLook(`${snap.name}: la clasificación del exportador tiró (${e.message})`);
    }
  };
  const sh = guard(() => snap.mod.whatShips(ctx));
  return { packages: sh.packages, ofFile: (f, ruta) => guard(() => sh.ofFile(f, ruta)), preload: (pairs) => guard(() => sh.preload(pairs)) };
}

// ── lo que se encuentra en un texto ──────────────────────────────────────────────────────────────────────────────
const PATHS_LIST = 'rutas-de-la-copia.txt';   // el nombre con que se miran las rutas (el mismo que usa el exportador)
const reviewed = new Map();   // detector → rel → texto → hallazgos: la foto de antes y la de después comparten mucho texto
function namesIn(pieces, det, terms, rel) {
  const out = [];
  for (const piece of pieces) {
    if (!reviewed.has(det)) reviewed.set(det, new Map());
    const byRel = reviewed.get(det);
    const key = `${rel}\0${piece.text}`;
    if (byRel.has(key)) { out.push(...byRel.get(key)); continue; }
    const start = out.length;
    const lines = piece.text.split(/\r?\n/);
    for (const h of detector.reviewText(det, piece.text, rel, { categorias: NAME_CATEGORIES }).hallazgos) {
      if (!NAME_CATEGORIES.has(h.categoria)) continue;
      out.push({ key: `${h.categoria}\0${h.texto.toLowerCase()}`, category: h.categoria, text: h.texto, line: h.linea, lineText: lines[h.linea - 1] });
    }
    // (story 8.10.3, AC 12) con las mismas excepciones exactas que respeta el exportador: un pegado declarado no es nombre
    // nuevo. En una RUTA no hay excepción, igual que allá: un nombre pegado en una ruta se arregla renombrando.
    for (const g of exporter.nombresPegados([[rel, piece.text]], terms, rel === PATHS_LIST ? [] : det && det.permitidos)) {
      const term = terms.find((t) => t.patron === g.termino) || {};
      out.push({ key: `glued\0${g.identificador.toLowerCase()}`, category: term.categoria || 'cliente', text: g.identificador, term: g.termino, glued: true, line: g.linea, lineText: lines[g.linea - 1] });
    }
    byRel.set(key, out.slice(start));
  }
  return out;
}

/** Lo que el después agrega sobre el antes (en un merge, sobre el máximo de los padres), con las líneas más probables. */
function netNew(after, befores) {
  const count = (list) => list.reduce((m, f) => m.set(f.key, (m.get(f.key) || 0) + 1), new Map());
  const a = count(after);
  const bs = befores.map(count);
  const out = [];
  for (const [key, n] of a) {
    let max = 0;
    let most = -1;
    bs.forEach((b, i) => { if ((b.get(key) || 0) > max) { max = b.get(key); most = i; } });
    if (n <= max) continue;
    const mine = after.filter((f) => f.key === key);
    // las ocurrencias cuya línea no estaba antes (en el padre que más tenía) son las nuevas; si no alcanzan, las últimas
    const old = new Map();
    for (const f of most < 0 ? [] : befores[most].filter((x) => x.key === key)) old.set(f.lineText, (old.get(f.lineText) || 0) + 1);
    const fresh = [];
    const stale = [];
    for (const f of mine) {
      const k = old.get(f.lineText) || 0;
      if (k > 0) { old.set(f.lineText, k - 1); stale.push(f); } else fresh.push(f);
    }
    out.push(...[...fresh, ...stale.reverse()].slice(0, n - max));
  }
  return out;
}

/** La línea real en el archivo (el texto que se mira puede estar transformado: sin secciones, sin claves). */
function realLine(raw, f, used) {
  if (raw !== null) {
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === f.lineText && !used.has(i)) { used.add(i); return i + 1; }
    }
  }
  return f.line;
}

/** El nombre inventado que la tabla le da a un texto encontrado (null = no tiene par). */
function pairFor(pairs, text) {
  const low = String(text).toLowerCase();
  for (const p of pairs) {
    const forms = p.formas || [];
    const exact = forms.find((f) => f && f.texto === text);
    if (exact) return exact.anonimo;
  }
  for (const p of pairs) {
    const forms = p.formas || [];
    const any = forms.find((f) => f && typeof f.texto === 'string' && f.texto.toLowerCase() === low);
    if (any || String(p.real).toLowerCase() === low) {
      const anon = (any || forms[0] || {}).anonimo;
      if (!anon) return null;
      if (text === text.toUpperCase() && /[A-Za-z]/.test(text)) return anon.toUpperCase();
      if (text === text.toLowerCase() && /[A-Za-z]/.test(text)) return anon.toLowerCase();
      return anon;
    }
  }
  return null;
}

const termKey = (t) => JSON.stringify([t && t.patron, t && t.categoria]);

// ── la forma publicada (story 8.26, tanda H1c · AC 65 c) ─────────────────────────────────────────────────────────
// El porqué, qué mira y qué no, en la cabecera («EN EL ÁRBOL QUE ES LA FORMA PUBLICADA»). Acá, las tres piezas: cuándo
// aplica (`isPublishedForm`), si la máquina es del equipo (`isTeamMachine`) y la corrida (`publishedRun`).
const PUBLISHED_MARK = 'scripts/setup/public-remotes.json';   // sólo existe en la copia publicada (lo pone el exportador)
const PUSH_GUARD = path.join(__dirname, '..', 'hooks', 'public-push-guard.js');
const HOME_LIB = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
const MODE_LINK = '120000';

/**
 * ¿El árbol que se commitea ES la forma publicada del arnés? Una señal POSITIVA: trae `PUBLISHED_MARK` y no trae lista
 * propia (ni en su ruta vieja). «No tiene lista ni perfil» no alcanza: eso también lo cumple cualquier laboratorio de
 * prueba, que en la máquina de quien mantiene pasaría a mirarse con la lista de verdad. Un árbol interno al que le
 * borraron la lista no cae acá (no trae la señal): sigue saliendo «no pude mirar».
 *
 * La forma es la que el árbol ERA: la del commit de antes (cada padre), y la del índice sólo cuando no hay ninguno. Un
 * commit no cambia de modo con lo que él mismo trae o saca:
 *   · no se saca el freno borrando la señal, ni elige con qué lista se lo mira trayéndose una (la que trae se mira como
 *     cualquier archivo): alcanza con que algún padre trajera la señal;
 *   · y el antes VETA: si algún padre traía lista propia —un árbol interno, o uno al que ya le plantaron una—, no es la
 *     forma publicada y sigue el camino de siempre. Pasó al revés: mirando sólo cómo quedaba el índice, un commit en un
 *     clon interno que sacaba la lista y agregaba la señal salía 0, cuando el freno de siempre decía «no pude mirar»;
 *   · por lo mismo, la señal que llega con el commit no cuenta: un árbol interno que ya había perdido su lista (y salía
 *     2) pasaba a 0 con sólo agregar ese archivo.
 * El antes sale de deshacer los cambios que `run` ya leyó: no le cuesta otra pregunta a git.
 */
function isPublishedForm(repo, parents) {
  const lists = [CONFIG.denied, ...legacyOf(CONFIG.denied)];
  // (rutas tal cual, desde la raíz —`hookGit` corre parado ahí—: sin magia de git, que una variable de ambiente puede apagar)
  const staged = new Set(hookGit(repo, ['ls-files', '-z', '--', PUBLISHED_MARK, ...lists]).split('\0').filter(Boolean));
  const published = (has) => has(PUBLISHED_MARK) && !lists.some(has);
  // el antes de cada padre: lo que hay en el índice, deshaciendo lo que el commit le hace a esas rutas
  const befores = parents.filter((p) => p.sha).map((p) => (ruta) => {
    const now = p.changes.find((c) => c.path === ruta);
    if (now) return !['A', 'R', 'C'].includes(now.status);   // llega con este commit; si no (cambia o se borra), ya estaba
    if (p.changes.some((c) => c.oldPath === ruta)) return true;   // el commit lo mueve a otra ruta: estaba
    return staged.has(ruta);
  });
  if (!befores.length) return published((ruta) => staged.has(ruta));   // el primer commit de un repo: no hay antes, vale el índice
  if (befores.some((had) => lists.some(had))) return false;            // el veto: traía lista propia
  return befores.some((had) => had(PUBLISHED_MARK));
}

/**
 * ¿La máquina es del equipo? Lo dice su arnés INSTALADO, si trae el perfil. No sirve la regla del freno antes de publicar
 * tal cual: mira el perfil en su propia raíz, que acá es el clon del público que se commitea (sin perfil, por diseño).
 * El instalado se le pide a tycon-home.js en sus dos formas: la versión bajada (la carpeta propia del arnés) y el clon
 * (el lugar del arnés).
 */
function isTeamMachine(env) {
  if (!fs.existsSync(HOME_LIB)) throw new CouldNotLook('este árbol es la forma publicada del arnés y no trae scripts/setup/harness/tycon-home.js: sin él no sé dónde está el arnés instalado de esta máquina');
  const home = require(HOME_LIB);
  const places = [];
  try { places.push(home.ownPaths({ env }).harness); } catch (e) { throw new CouldNotLook(`no pude ubicar el arnés instalado de esta máquina (${e.message})`); }
  const placed = home.harnessDir(os.homedir());
  if (placed) places.push(placed);
  return places.some((dir) => hasProfile(dir));
}

/** El aviso de la lista atrasada, si lo hay (una línea). Sin red: un commit no sale a la red. Nunca cambia el veredicto. */
function staleListNote(guard, file, env) {
  try {
    const f = guard.listFreshness(file, { env });
    const t = guard.freshnessText(f);
    if (t.level !== 'warn') return [];
    // qué hacer lo dice el freno antes de publicar (`advice`: traerlo · mirarlo primero · subir lo propio), que es quien
    // midió: un «traé ese clon» fijo no sirve para un clon que está ADELANTE de su remoto
    const why = t.kind === 'ahead' ? 'Los demás, y la validación del pedido, miran con la lista que tiene el remoto'
      : 'Con una lista vieja se escapa un término que se sumó después, y frena lo que ya tiene su excepción';
    return [`⚠️  nombres nuevos: ${t.text}. ${why}: ${t.advice}.`];
  } catch (_) {
    return [];   // es un aviso: si no se puede medir, el veredicto es el mismo
  }
}

/**
 * La corrida en la forma publicada. TODO lo tocado sale tal cual: sin la clasificación del exportador, sin
 * transformaciones y sin tabla de reemplazos. Mira lo que el commit agrega, neto y archivo por archivo, y la ruta de un
 * archivo nuevo o renombrado; sólo nombres. La lista es la de la MÁQUINA (los lugares y la regla del freno antes de
 * publicar), nunca la del árbol que se commitea.
 * → { outcome: 'quiet' } | { published: true, outcome: 'no-list' | 'clean' | 'blocked', list, label, findings, files, notes }
 */
function publishedRun(args, repo, parents, afterTree) {
  // El pre-commit corre el freno una vez por fuente (el arnés y agent-skills, que en la copia son un solo repo): esta
  // corrida mira TODO lo tocado y la otra calla. Una línea por commit, cada hallazgo una vez.
  if (args.source !== 'arnes') return { outcome: 'quiet' };

  // qué se mira: lo que cambió contra TODOS los padres (en un merge, lo que no viene de ninguno)
  const changedIn = parents.map((p) => new Map(p.changes.map((c) => [c.path, c])));
  const looked = [];
  for (const c of parents[0].changes) {
    if (c.status === 'D') continue;
    if (!changedIn.every((m) => m.has(c.path) && m.get(c.path).status !== 'D')) continue;
    looked.push({ ruta: c.path, beforePaths: changedIn.map((m) => { const x = m.get(c.path); return x.status === 'A' ? null : (x.oldPath || c.path); }) });
  }
  if (!looked.length) return { outcome: 'quiet' };   // un commit que sólo borra (o vacío) no agrega nada

  // la lista de la máquina. `pushing` con la raíz de este repo descarta todo lugar que caiga ADENTRO de él: el último
  // lugar del freno es «el arnés desde el que corre», que acá es el propio árbol que se commitea.
  if (!fs.existsSync(PUSH_GUARD)) {
    throw new CouldNotLook(`este árbol es la forma publicada del arnés (trae ${PUBLISHED_MARK}) y no trae el freno antes de publicar `
      + '(scripts/hooks/public-push-guard.js), que es quien sabe dónde está la lista privada de esta máquina');
  }
  const guard = require(PUSH_GUARD);
  const env = process.env;
  let list;
  try {
    // la raíz, como la nombra el disco (`realNative`): el freno descarta por ruta lo que cae adentro de este árbol
    list = guard.resolveList(realNative(repo), env, { pushing: true, optional: true });
  } catch (e) {
    if (!(e instanceof guard.Blind)) throw e;
    // el motivo del freno no cita nada privado (ni un término, ni un pedazo de la lista, ni de la configuración)
    const blind = new CouldNotLook(`${String(e.message).replace('que se empuja', 'que se commitea')} (este árbol es la forma publicada del arnés: se mira con la `
      + 'lista privada de esta máquina. Si la declaración quedó vieja: harness.js config set paths.maintainers <clon de mantenimiento>)');
    blind.extra = { form: 'published', list: e.listSource || null };
    blind.notes = e.listFile ? staleListNote(guard, e.listFile, env) : [];
    throw blind;
  }
  if (list.generic) {
    // ningún lugar da la lista. En una máquina del equipo se DICE (no es «miré y está limpio») y pasa: lo mira el freno
    // al empujar. Alguien de afuera con su copia no tiene lista por diseño: calla, como siempre.
    return isTeamMachine(env) ? { published: true, outcome: 'no-list', list: null, findings: [], files: 0, notes: [] } : { outcome: 'quiet' };
  }
  // los términos tal como están escritos (los pide el control de nombres pegados); el freno ya validó que la lista se lee
  let terms;
  try { terms = JSON.parse(fs.readFileSync(list.file, 'utf8')).terminos; } catch (_) { terms = null; }
  if (!Array.isArray(terms)) throw new CouldNotLook(`la lista de ${list.label} no se puede leer (no es una lista válida)`);
  const det = list.cfg;

  // el después (el índice que git le pasa al hook) y un antes por padre; todo lo que se va a leer, en una sola lectura
  const after = new Map(afterTree().map((e) => [e.ruta, e]));
  const befores = parents.map((p) => new Map(commitTree(repo, p.sha).map((e) => [e.ruta, e])));
  const read = blobReader({ arnes: repo });
  const isFile = (e) => !!e && e.tipo === 'blob' && e.modo !== MODE_LINK;   // un enlace y un submódulo no son de este freno
  const wanted = new Set();
  for (const x of looked) {
    if (isFile(after.get(x.ruta))) wanted.add(after.get(x.ruta).obj);
    x.beforePaths.forEach((bp, i) => { const e = bp && befores[i].get(bp); if (isFile(e)) wanted.add(e.obj); });
  }
  if (wanted.size) exporter.leerObjetos({ dir: repo }, [...wanted]);
  // un binario no se mira (y no frena): no hay texto contra el cual comparar
  const textOf = (e) => {
    if (!isFile(e)) return null;
    const buf = read('arnes', e.obj);
    return detector.esBinario(buf) ? null : buf.toString('utf8');
  };

  const findings = [];
  let files = 0;
  for (const x of looked.sort((a, b) => byCode(a.ruta, b.ruta))) {
    // la ruta: la de antes descuenta (renombrar lo que ya traía el nombre en su ruta no frena)
    const inPath = namesIn([{ text: x.ruta }], det, terms, PATHS_LIST);
    const pathNet = inPath.length ? netNew(inPath, x.beforePaths.map((bp) => (bp ? namesIn([{ text: bp }], det, terms, PATHS_LIST) : []))) : [];
    // una ruta que trae un nombre ES lo hallado: no se imprime, tampoco al decir en qué línea está otro hallazgo
    const masked = inPath.length > 0;
    for (const f of pathNet) findings.push({ ...f, kind: 'path', source: 'arnes', ruta: x.ruta, masked });
    // el contenido, neto contra cada padre
    const text = textOf(after.get(x.ruta));
    if (text === null) continue;
    files++;
    const now = namesIn([{ text }], det, terms, x.ruta);
    if (!now.length) continue;
    const was = x.beforePaths.map((bp, i) => {
      const t = bp ? textOf(befores[i].get(bp)) : null;
      return t === null ? [] : namesIn([{ text: t }], det, terms, bp);
    });
    for (const f of netNew(now, was)) findings.push({ ...f, kind: 'name', source: 'arnes', ruta: x.ruta, masked });
  }

  const notes = [];
  // la variable cambia con qué lista se mira sin que nada más lo diga: como apagar el freno, se dice en cada commit
  if (list.source === 'env') notes.push('⚠️  nombres nuevos: se miró con la lista de TYCON_PUBLISH_DENYLIST, no con la que declara esta máquina — queda anotado.');
  notes.push(...staleListNote(guard, list.file, env));
  return { published: true, outcome: findings.length ? 'blocked' : 'clean', list: list.source, label: list.label, findings, files, notes };
}

/** El mensaje de un freno en la forma publicada: dónde (archivo y línea) y la categoría; NUNCA el texto encontrado. */
function publishedReport(result) {
  const lines = new Map();
  for (const f of result.findings) {
    const glued = f.glued ? ' (pegado a otra palabra)' : '';
    const line = f.kind === 'path' ? `  (ruta) un archivo nuevo o renombrado, cuya ruta no se imprime  [${f.category}]${glued}`
      : `  ${f.masked ? 'un archivo cuya ruta no se imprime' : f.ruta}:${f.line}  [${f.category}]${glued}`;
    lines.set(line, (lines.get(line) || 0) + 1);
  }
  const l = [`🛑 nombres reales nuevos en lo que se publica — el commit no se crea (${result.findings.length} hallazgo(s)):`, ''];
  for (const [line, n] of lines) l.push(n > 1 ? `${line}  ×${n}` : line);
  l.push('',
    'Este árbol es la forma publicada del arnés: todo lo que se commitea acá se publica.',
    result.list === 'env' ? 'Se miró con la lista de TYCON_PUBLISH_DENYLIST.' : `Se miró con la lista privada de esta máquina: ${result.label}.`,
    'El texto encontrado no se imprime: está en la línea que se nombra. De una ruta que no se imprime, `git status` dice',
    'cuáles son los archivos nuevos o renombrados.',
    '', 'Cómo salir, en este orden:',
    '  (a) Un nombre neutro: `acme` o «Cliente A» para un cliente, `example.com` para un dominio, «el dev» para una persona,',
    '      o un sujeto genérico («un cliente», «un servidor interno»). Que no conserve del real ni la inicial ni el rubro.',
    '  (b) Si es un freno falso —el texto no es un nombre real, o tiene que quedar—: una excepción con motivo en «permitidos»',
    '      de la lista privada, en su clon (nunca en este árbol), y ese clon al día en esta máquina.',
    '  (c) TYCON_NEW_NAMES=0 apaga el freno para ese commit, y lo dice. El freno al empujar lo mira igual.',
    '', 'Guía: guides/maintaining/publicacion-espejo.md §«El núcleo sin nombres».');
  return l.join('\n');
}

// ── la corrida ───────────────────────────────────────────────────────────────────────────────────────────────────
function run(args) {
  const t0 = Date.now();
  const source = args.source;
  const other = source === 'arnes' ? 'agent-skills' : 'arnes';
  const startDir = args.repo ? path.resolve(args.repo) : process.cwd();
  if (!fs.existsSync(startDir)) throw new CouldNotLook(`--repo ${startDir} no existe`);
  const repo = realOr(hookGit(startDir, ['rev-parse', '--show-toplevel']).trim());

  // 1 · qué cambia, contra cada padre
  let parents;   // [{ sha|null, changes }]
  let afterTree;
  let range = null;
  if (args.mode === 'range') {
    const m = /^(.+?)(\.{2,3})(.+)$/.exec(args.range);
    if (!m) throw new CouldNotLook(`--range ${args.range}: tiene que ser <base>...<punta> o <base>..<punta>`);
    const rev = (ref) => {
      const r = isolated(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: true });
      if (r.status !== 0) throw new CouldNotLook(`no encuentro el commit «${ref}» en ${repo}`);
      return r.stdout.trim();
    };
    const tip = rev(m[3]);
    const base = m[2] === '...' ? isolated(repo, ['merge-base', rev(m[1]), tip]).stdout.trim() : rev(m[1]);
    const commits = Number(isolated(repo, ['rev-list', '--count', `${base}..${tip}`]).stdout.trim());
    if (!commits) return { outcome: 'not-measured', message: `nombres: no medido: el rango no trae commits (${args.range}) — la red de esta corrida es el termómetro nocturno` };
    parents = [{ sha: base, changes: parseChanges(isolated(repo, ['diff', '-M', '-z', '--name-status', base, tip]).stdout) }];
    afterTree = () => commitTree(repo, tip);
    range = { base, tip };
  } else {
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo, env: process.env, encoding: 'utf8' });
    const shas = head.status === 0 ? [head.stdout.trim()] : [null];
    const mergeFile = hookGit(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim();
    const mergeAbs = path.resolve(repo, mergeFile);
    if (shas[0] && fs.existsSync(mergeAbs)) shas.push(...fs.readFileSync(mergeAbs, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));
    parents = shas.map((sha) => ({ sha, changes: parseChanges(hookGit(repo, ['diff-index', '--cached', '-M', '-z', '--name-status', sha || EMPTY_TREE])) }));
    afterTree = () => indexTree(repo);
    // story 8.26 (tanda H1c): el árbol que ES la forma publicada se mira aparte, con la lista de la máquina. Se decide
    // ACÁ, antes del atajo «nada de lo tocado sale» del paso 2: ahí no hay exportador que saque `tasks/` o `specs/`, todo
    // lo que se commitea se publica. Sólo con lo preparado: `--range` es de la validación, que trae su configuración.
    if (isPublishedForm(repo, parents)) return publishedRun(args, repo, parents, afterTree);
  }
  // story 8.18: en el repo unido esta corrida mira sólo los cambios de su fuente lógica (ver «el repo unido», arriba).
  // Con lo stageado alcanza el disco, que es lo que el índice va a commitear; en un rango se confirma con la punta, y
  // si el rango cruza la unión, la mitad que la base no trae se compara con su historia (ver «un rango que cruza la unión»).
  let afterMemo = null;
  const afterOnce = () => (afterMemo || (afterMemo = afterTree()));
  const unified = unifiedCheckout(repo) && (args.mode !== 'range' || unifiedTree(afterOnce()));
  if (unified) parents = unifiedParents(repo, parents, source, range);

  // 2 · AC 14: si nada de lo tocado sale ni dispara, no se carga nada
  // con el `salvo` de cada exclusión fija (story 8.26, tanda C): las rutas que salen igual no son «nada de lo tocado sale»
  const covers = exporter.cubreFija || ((x, ruta) => exporter.coincide(x.glob, ruta));
  const fixed = (ruta) => exporter.EXCLUIDOS_SIEMPRE.some((x) => x.fuente === source && covers(x, ruta));
  const touched = parents.flatMap((p) => p.changes);
  const relevant = touched.some((c) => isTrigger(source, c.path) || (c.oldPath && isTrigger(source, c.oldPath))
    || (c.status !== 'D' && !fixed(c.path)));
  if (!relevant) return { outcome: 'quiet' };

  // 3 · los dos repos y la configuración del después
  const own = { dir: repo };
  // en el repo unido «el otro repo» es este mismo: su otra mitad, en la misma foto
  const otherInfo = unified ? { dir: repo } : otherRepo(source);
  const dirs = { [source]: repo, [other]: otherInfo.dir };
  const read = blobReader(dirs);
  const harnessDisk = source === 'arnes' ? repo : otherInfo.dir;
  const disk = args.configFrom === 'disk';
  if (otherInfo.missing && source === 'agent-skills') return { outcome: 'other-repo-missing', otherDir: otherInfo.dir, other };
  const trees = unified ? splitTree(afterOnce()) : { [source]: afterOnce() };
  const harnessAfter = unified || source === 'arnes' ? trees.arnes : commitTree(otherInfo.dir, otherInfo.head);
  const harnessMap = new Map(harnessAfter.map((e) => [e.ruta, e]));
  // la punta de un --range anterior a la mudanza (tanda C4) tiene la configuración en su ruta vieja: la del mapa
  const afterText = (ruta) => {
    if (disk) { const p = path.join(harnessDisk, ruta); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
    const e = harnessMap.get(configPathIn(harnessMap, ruta) || ruta);
    return e && e.tipo === 'blob' ? read('arnes', e.obj).toString('utf8') : null;
  };
  // el techo y el registro de productos son CONTENIDO del commit (no configuración): siempre del árbol, también con disk
  const afterTreeText = (ruta) => { const e = harnessMap.get(configPathIn(harnessMap, ruta) || ruta); return e && e.tipo === 'blob' ? read('arnes', e.obj).toString('utf8') : null; };
  const deniedText = afterText(CONFIG.denied);
  if (deniedText === null) {
    // El perfil es del ARNÉS (su disco), no de la foto: un commit viejo sin lista, en el arnés del equipo, no es una copia.
    const profile = profileIn(harnessDisk);
    if (!profile) return { outcome: 'quiet' };   // la copia pública o un laboratorio: no hay lista por diseño
    throw new CouldNotLook(`no está ${CONFIG.denied} y el arnés tiene ${profile}: el equipo tiene lista, y sin ella no se mira`);
  }
  if (otherInfo.missing) return { outcome: 'other-repo-missing', otherDir: otherInfo.dir, other };
  if (!unified) trees[other] = commitTree(otherInfo.dir, otherInfo.head);
  if (disk && source === 'agent-skills') {
    // los manifiestos de paquetes, del HEAD de agent-skills (la configuración de hoy)
    const headPacks = commitTree(repo, 'HEAD').filter((e) => PACK.test(e.ruta));
    trees[source] = [...trees[source].filter((e) => !PACK.test(e.ruta)), ...headPacks];
  }

  const base = parents[0];
  const beforeTrees = parents.map((p) => {
    // en el repo unido el antes de las dos fuentes sale del mismo padre (o, en un rango que cruza la unión, de su historia)
    const t = unified ? beforeHalves(repo, p) : { [source]: commitTree(repo, p.sha), [other]: trees[other] };
    if (disk && source === 'agent-skills') t[source] = [...t[source].filter((e) => !PACK.test(e.ruta)), ...trees[source].filter((e) => PACK.test(e.ruta))];
    return t;
  });
  // Una sola lectura de git por repo para lo que se va a leer seguro: la configuración, lo que transforma la copia y lo
  // que el commit cambia, en las dos fotos. Después todo sale de la memoria de leerObjetos (antes eran ~14 lecturas).
  const wanted = (ruta) => /^scripts\/publishing\/[^/]+\.json$/.test(ruta) || ruta === CONFIG.parity || EXPORTER_PATHS.includes(ruta)
    || LEGACY_CONFIG_PATHS.has(ruta)
    || PACK.test(ruta) || /^scripts\/controls-bench\/cases\/hooks\//.test(ruta) || SPECIAL(ruta, null);
  const changedPaths = new Set(touched.flatMap((c) => [c.path, c.oldPath].filter(Boolean)));
  for (const f of SOURCES) {
    const objs = new Set();
    for (const tree of [trees[f], ...beforeTrees.map((t) => t[f])]) {
      for (const e of tree || []) if (e.tipo === 'blob' && ((f === 'arnes' && wanted(e.ruta)) || (f === source && changedPaths.has(e.ruta)))) objs.add(e.obj);
    }
    if (objs.size) exporter.leerObjetos({ dir: dirs[f] }, [...objs]);
  }
  const beforeHarness = (i) => new Map((unified || source === 'arnes' ? beforeTrees[i].arnes : trees.arnes).map((e) => [e.ruta, e]));
  // la configuración de la foto de antes: la ruta nueva o, si esa foto es de antes de la mudanza (tanda C4), la vieja
  const beforeText = (i, ruta) => {
    const h = beforeHarness(i);
    const e = h.get(configPathIn(h, ruta) || ruta);
    return e && e.tipo === 'blob' ? read('arnes', e.obj).toString('utf8') : null;
  };

  // 4 · las fotos: el después (con su configuración y con «lo que tapaba la base») y un antes por padre
  const afterSnap = snapshot('el después', trees, { dirs, read, disk, harnessDisk });
  // story 8.9 (AC 29): cada lista con los paquetes por su nombre nuevo. En el commit del renombre la base nombra al núcleo
  // con el viejo y la punta con el nuevo: son el MISMO paquete, y compararlas como dos haría «empezar a salir» todo. Lo
  // mismo con las claves (tanda D1): las dos listas se comparan con las de hoy (normalizeList).
  const newPackageNames = normalizeList;
  const afterList = newPackageNames(parseJson(afterSnap.listText, CONFIG.list));
  const afterTable = parseJson(afterSnap.tableText, CONFIG.table);
  // Una configuración del antes que no se deja leer (sólo pasa si alguien salteó el freno) no se reemplaza callada: se
  // dice qué control queda a ciegas, sin citar su contenido (revisor de fallos silenciosos, vuelta 4).
  const beforeJson = (ruta, blind) => {
    const t = beforeText(0, ruta);
    if (t === null) return { value: null, broken: false };
    try { return { value: JSON.parse(t), broken: false }; } catch {
      say(`⚠️  nombres nuevos: ${ruta} del antes no es JSON válido — ${blind}`);
      return { value: null, broken: true };
    }
  };
  const sameBlind = 'las excepciones que este commit agregue ahí no se distinguen de las que ya estaban: se compara con la del después';
  const baseList = (!disk && newPackageNames(beforeJson(CONFIG.list, sameBlind).value)) || afterList;
  const baseTable = (!disk && beforeJson(CONFIG.table, sameBlind).value) || afterTable;
  // AC 9: lo que el commit agrega para TAPAR algo —un afuera de la lista o privado, una clave en `empty`, un caso o una
  // suite fuera, un sintético— no vale para su propio nombre. La vista «efectiva» es la del después con lo que tapaba la
  // base: un nombre que ahí aparece y con la configuración del commit no, lo tapa una excepción de este mismo commit.
  // Editar un afuera que ya tapaba el archivo (ensancharlo, moverlo a la tabla privada) no es una excepción: la base ya lo
  // tapaba (hallazgo del pase adversarial: identificarlo por el texto del glob frenaba sin salida).
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const effectiveList = clone(afterList);
  for (const [pkg, def] of Object.entries(effectiveList.packages || {})) {
    if (pkg.startsWith('__') || !def) continue;
    for (const f of SOURCES) {
      if (!def[f]) continue;
      const was = (((baseList.packages || {})[pkg] || {})[f] || {}).out;
      def[f].out = Array.isArray(was) ? clone(was) : [];
    }
  }
  for (const k of ['empty', 'casesOutside', 'suitesOutside', 'synthetic']) {
    if (baseList[k] === undefined) delete effectiveList[k];
    else effectiveList[k] = clone(baseList[k]);
  }
  // story 8.9 (tanda C2): una suite o un caso que la base dejaba fuera y que este cambio RENOMBRA sigue tapado con su
  // nombre nuevo: es el mismo archivo y la base ya lo tapaba (el criterio de arriba). Sólo vale para un `file` del mapa de
  // renombres cuyo viejo existía en la base y cuyo nuevo existe en el después (mudado de verdad, no una entrada suelta).
  // Sin esto, renombrar una prueba con datos que no salen frena el PR entero sin salida: su excepción con el nombre
  // nuevo es «una excepción de este mismo commit» (pase adversarial de la C2).
  // viejo → nuevo de los archivos del arnés que el mapa (el del después) declara mudados y que de verdad se mudaron. Un mapa
  // que no se deja leer no tapa nada: el freno queda como antes (más estricto), nunca más permisivo.
  const movedFiles = (before, after) => {
    const out = new Map();
    const m = after.get('scripts/lib/renames.json');
    if (!m || m.tipo !== 'blob') return out;
    const text = read('arnes', m.obj).toString('utf8');   // un error de git al leer NO se traga: es «no pude mirar»
    let map;
    try { map = JSON.parse(text); } catch {
      say('⚠️  nombres nuevos: scripts/lib/renames.json del después no es JSON válido — una prueba renombrada que la base dejaba fuera cuenta como excepción nueva');
      return out;
    }
    for (const e of Array.isArray(map && map.entries) ? map.entries : []) {
      if (!e || e.kind !== 'file' || (e.repo && e.repo !== 'arnes') || typeof e.old !== 'string' || typeof e.new !== 'string') continue;
      const was = before.get(e.old);
      const now = after.get(e.new);
      if (was && was.tipo === 'blob' && now && now.tipo === 'blob') out.set(e.old, e.new);
    }
    return out;
  };
  const renamedFiles = movedFiles(beforeHarness(0), new Map(trees.arnes.map((e) => [e.ruta, e])));
  for (const k of ['casesOutside', 'suitesOutside']) {
    if (!Array.isArray(effectiveList[k]) || !renamedFiles.size) continue;
    const prefix = k === 'suitesOutside' ? 'scripts/' : '';
    for (const x of [...effectiveList[k]]) {
      if (!x || (x.root && x.root !== 'arnes') || typeof x.path !== 'string') continue;
      const nuevo = renamedFiles.get(`${prefix}${x.path}`);
      if (nuevo && nuevo.startsWith(prefix)) effectiveList[k].push({ ...x, path: nuevo.slice(prefix.length) });
    }
  }
  // story 8.12 (tanda R5): lo mismo con un `out` de un paquete que nombraba EXACTO un archivo que el cambio muda (una guía
  // privada que pasa a guides/decisions/): sigue tapado con su ruta nueva. Sólo la ruta exacta, nunca un patrón: un `out`
  // del después que de paso tape otro archivo sigue siendo una excepción de este commit (pase adversarial de la R5).
  if (renamedFiles.size) {
    for (const def of Object.values(effectiveList.packages || {})) {
      const out = def && def.arnes && def.arnes.out;
      if (!Array.isArray(out)) continue;
      for (const x of [...out]) {
        const nuevo = x && typeof x.glob === 'string' && renamedFiles.get(x.glob);
        if (nuevo) out.push({ ...x, glob: nuevo });
      }
    }
  }
  // (tanda D1) lo mismo con un archivo que la base vaciaba y este cambio renombra: se sigue vaciando con su nombre nuevo.
  // Si el cambio también renombró sus claves (la D1 lo hace), las de la base ya no están: valen las del después para ese
  // archivo sólo si CADA una es una clave de la base o su nombre nuevo según el mapa (entradas `key` cuyo where es el
  // archivo, por su nombre nuevo o el viejo). Cualquier otra —aunque sean las mismas en cantidad— es una excepción de este
  // commit (pase adversarial de la D1, false-negative-classification-1): se queda con las de la base.
  if (effectiveList.empty && typeof effectiveList.empty === 'object' && renamedFiles.size) {
    const afterEmpty = (afterList && afterList.empty) || {};
    const keyEntries = legacyNames.usableEntries(legacyNames.loadMap()).filter((e) => e.kind === 'key' && typeof e.old === 'string' && typeof e.new === 'string');
    for (const [file, keys] of Object.entries({ ...effectiveList.empty })) {
      const nuevo = renamedFiles.get(file);
      if (!nuevo || Object.prototype.hasOwnProperty.call(effectiveList.empty, nuevo) || !Array.isArray(keys)) continue;
      const renamedKey = new Map(keyEntries.filter((e) => e.where === nuevo || e.where === file).map((e) => [e.old, e.new]));
      const allowed = new Set(keys.flatMap((k) => (renamedKey.has(k) ? [k, renamedKey.get(k)] : [k])));
      const now = afterEmpty[nuevo];
      effectiveList.empty[nuevo] = clone(Array.isArray(now) && now.every((k) => allowed.has(k)) ? now : keys);
    }
  }
  const effectiveTable = { ...afterTable, afuera: clone(baseTable.afuera || []) };
  // y lo mismo con un afuera privado (`arnes/<ruta exacta>`) del archivo mudado (la misma clase, R5)
  for (const x of [...effectiveTable.afuera]) {
    const nuevo = x && typeof x.glob === 'string' && x.glob.startsWith('arnes/') && renamedFiles.get(x.glob.slice('arnes/'.length));
    if (nuevo) effectiveTable.afuera.push({ ...x, glob: `arnes/${nuevo}` });
  }
  const hiding = (l, t) => JSON.stringify([Object.entries(l.packages || {}).map(([pk, d]) => [pk, SOURCES.map((f) => ((d || {})[f] || {}).out || [])]),
    l.empty || {}, l.casesOutside || [], l.suitesOutside || [], l.synthetic || [], t.afuera || []]);
  const newHiding = hiding(effectiveList, effectiveTable) !== hiding(afterList, afterTable);

  // Con --config-from disk la configuración es la de hoy y el árbol, el de un commit viejo: lo que la lista declara y ese
  // árbol todavía no tenía es historia, no un error.
  const afterCtx = contextFor(afterSnap, { lista: afterList, table: afterTable, strict: !disk });
  const afterShips = ships(afterSnap, afterCtx);
  const effShips = newHiding ? ships(afterSnap, contextFor(afterSnap, { lista: effectiveList, table: effectiveTable, strict: false })) : afterShips;
  const beforeShips = parents.map((p, i) => {
    // sin configuración propia (un commit de antes de la lista blanca), o con una que no se deja leer ni cargar (el commit
    // que la ARREGLA), el antes se clasifica con la del después: si no, el arreglo no se podría commitear
    let snap;
    try {
      snap = snapshot(`el antes (${p.sha ? p.sha.slice(0, 12) : 'sin HEAD'})`, beforeTrees[i], { dirs, read, disk, harnessDisk, allowMissing: true });
      if (!snap.missingConfig) {
        return ships(snap, contextFor(snap, {
          lista: newPackageNames(parseJson(snap.listText, `${CONFIG.list} (${snap.name})`)), table: parseJson(snap.tableText, `${CONFIG.table} (${snap.name})`), strict: false,
        }));
      }
    } catch (e) {
      if (!(e instanceof CouldNotLook)) throw e;
      // el atajo se dice: si «salva» algo que debía frenar, que quede la pista (revisor de fallos silenciosos, vuelta 2)
      say(`⚠️  nombres nuevos: ${snap ? snap.name : 'la foto de antes'} no se pudo clasificar con su propia configuración (${e.message}) — se usa la del después`);
    }
    const s = { name: `el antes (${p.sha ? p.sha.slice(0, 12) : 'sin HEAD'})`, trees: beforeTrees[i], harness: beforeHarness(i), dirs, read, mod: afterSnap.mod, legacyKeys: afterSnap.legacyKeys };
    return ships(s, contextFor(s, { lista: afterList, table: afterTable, strict: false }));
  });

  // 5 · qué se mira: lo que cambió contra TODOS los padres, y lo que empieza a salir
  const changedIn = parents.map((p) => new Map(p.changes.map((c) => [c.path, c])));
  const looked = new Map();   // key → { source, ruta, beforePaths: [ruta|null por padre] }
  const lookAt = (f, ruta, beforePaths) => { const k = `${f}\0${ruta}`; if (!looked.has(k)) looked.set(k, { source: f, ruta, beforePaths }); };
  for (const c of base.changes) {
    if (c.status === 'D') continue;
    if (!changedIn.every((m) => m.has(c.path) && m.get(c.path).status !== 'D')) continue;
    lookAt(source, c.path, changedIn.map((m) => { const x = m.get(c.path); return x.status === 'A' ? null : (x.oldPath || c.path); }));
  }
  // Un sintético sale con el contenido de su `from`: si el commit toca el `from`, se mira también el destino (`target`; el
  // `from` puede no salir en su propia ruta).
  if (source === 'arnes') {
    for (const sx of [...(afterList.synthetic || []), ...(baseList.synthetic || [])]) {
      if (sx && touched.some((c) => c.path === sx.from || c.oldPath === sx.from)) lookAt('arnes', sx.target, parents.map(() => sx.target));
    }
  }
  const reclassifies = touched.some((c) => isReclassify(source, c.path) || (c.oldPath && isReclassify(source, c.oldPath)));
  // Agregar, borrar o mover archivos cambia transformaciones que dependen de OTRO archivo (una entrada de suites.json sale
  // si su suite sale; la línea base saca los casos de casosFuera): esos archivos se vuelven a mirar.
  const structural = source === 'arnes' && touched.some((c) => c.status !== 'M' || /^scripts\/(tests|controls-bench)\//.test(c.path));
  const special = (ruta) => SPECIAL(ruta, afterList) || SPECIAL(ruta, baseList);
  if (structural) for (const e of trees.arnes) if (special(e.ruta)) lookAt('arnes', e.ruta, parents.map(() => e.ruta));
  // Lo que empieza a salir —por la configuración del commit, o en un merge, porque un padre no lo publicaba— se mira entero
  // (AC 8(c)), también su ruta. Por paquete: salir en un paquete más también es salir.
  if (reclassifies || newHiding || parents.length > 1) {
    const shipped = (sh, tr) => {
      const keys = new Set();
      for (const pk of sh.packages) {
        for (const [, a] of pk.files) if (a.kind !== 'translation') keys.add(`${pk.pkg}\0${a.fuente}\0${a.ruta}`);
        for (const pend of pk.pending) {
          const hash = pend.ruta.indexOf('#');
          if (hash >= 0) { const c = pend.ruta.slice(0, hash); keys.add(`${pk.pkg}#\0${c.slice(0, c.indexOf('/'))}\0${c.slice(c.indexOf('/') + 1)}`); continue; }
          for (const f of SOURCES) for (const e of tr[f]) if (exporter.coincide(pend.ruta, `${f}/${e.ruta}`)) keys.add(`${pk.pkg}#\0${f}\0${e.ruta}`);
        }
      }
      return keys;
    };
    // en el repo unido, cada archivo que empieza a salir lo mira una sola de las dos corridas (startsHere)
    const mine = unified ? startsHere(source, parents) : () => true;
    const now = new Set([...shipped(afterShips, trees), ...shipped(effShips, trees)]);
    const then = beforeShips.map((sh, i) => shipped(sh, beforeTrees[i]));
    for (const k of now) {
      const [, f, ruta] = k.split('\0');
      if (then.every((t) => t.has(k)) && !(f === 'arnes' && special(ruta))) continue;
      if (mine(f, ruta)) lookAt(f, ruta, parents.map(() => ruta));
    }
    if (reclassifies) for (const e of trees.arnes) if (special(e.ruta) && mine('arnes', e.ruta)) lookAt('arnes', e.ruta, parents.map(() => e.ruta));
  }

  // una entrada de primer nivel sin clasificar que el commit estrena (AC 7)
  let unclassified;
  try {
    unclassified = new Set(afterSnap.mod.primerNivel(afterCtx, source).filter((r) => !r.reglas.length).map((r) => r.nombre));
  } catch (e) {
    throw new CouldNotLook(`no pude clasificar el primer nivel (${e.message})`);
  }
  const entries = new Set();
  for (const c of base.changes) {
    if (!['A', 'R', 'C'].includes(c.status)) continue;
    if (!changedIn.every((m) => m.has(c.path) && ['A', 'R', 'C'].includes(m.get(c.path).status))) continue;
    const top = c.path.split('/')[0];
    if (unclassified.has(top)) entries.add(top);
  }

  // AC 14: si nada de lo que el commit toca sale, no estrena una entrada sin clasificar ni toca un disparador, la lista de
  // nombres no se carga: un commit que sólo toca lo que la lista blanca deja afuera sale acá, callado y sin registro.
  const triggered = touched.some((c) => isTrigger(source, c.path) || (c.oldPath && isTrigger(source, c.oldPath)));
  if (!triggered && !entries.size && ![...looked.values()].some((x) => afterShips.ofFile(x.source, x.ruta).length || effShips.ofFile(x.source, x.ruta).length)) {
    return { outcome: 'quiet' };
  }

  // la lista de nombres: la del después, siempre (AC 9)
  const denied = parseJson(deniedText, CONFIG.denied);
  const terms = Array.isArray(denied.terminos) ? denied.terminos : [];
  // Con --config-from disk la lista es la de hoy para las dos fotos: el commit que se repite no «trae» excepciones.
  const deniedBefore = disk ? { value: denied, broken: false }
    : beforeJson(CONFIG.denied, 'todos sus permisos cuentan como nuevos y el techo no se excusa (no se sabe qué términos suma el commit)');
  const baseDenied = deniedBefore.value || {};

  // AC 9: las excepciones que trae ESTE commit no valen para su propio nombre
  // Un permitido se identifica por archivo y patrón: reordenar sus claves o reescribir su motivo no lo vuelve nuevo.
  const permitKey = (x) => JSON.stringify([x && x.archivo, (x && x.patron) || null]);
  const samePermits = new Set((baseDenied.permitidos || []).map(permitKey));
  const newPermits = (denied.permitidos || []).filter((x) => !samePermits.has(permitKey(x)));
  // Sacar un término (o un patrón) de la lista en el mismo commit que trae su mención también es una excepción: en la
  // vista efectiva siguen contando (lo encontró el pase adversarial; sin esto el commit pasaba callado).
  // (story 8.10.2, AC 18) `glued: false` apaga las formas pegadas: también cambia qué se ve, así que también es una
  // excepción
  const termId = (t) => JSON.stringify([t && t.patron, t && t.categoria, !!(t && t.palabra), !!(t && t.mayusculas), !!(t && t.glued === false)]);
  const patternId = (x) => JSON.stringify([x && x.regex, x && x.categoria]);
  const nowTerms = new Set((denied.terminos || []).map(termId));
  const nowPatterns = new Set((denied.patrones || []).map(patternId));
  const removedTerms = (baseDenied.terminos || []).filter((t) => t && typeof t.patron === 'string' && !nowTerms.has(termId(t)));
  const removedPatterns = (baseDenied.patrones || []).filter((x) => x && x.regex && !nowPatterns.has(patternId(x)));
  const detFull = loadDetector(deniedText);
  const detEffective = newPermits.length || removedTerms.length || removedPatterns.length
    ? loadDetector(JSON.stringify({
      ...denied,
      terminos: [...(denied.terminos || []), ...removedTerms],
      patrones: [...(denied.patrones || []), ...removedPatterns],
      permitidos: (denied.permitidos || []).filter((x) => samePermits.has(permitKey(x))),
    }))
    : detFull;
  // La tabla se valida sólo si el commit la toca (o toca la lista, que fija sus categorías): la de HEAD ya pasó por acá, y
  // validarla compila y cruza todos sus pares (lo más caro del freno después de git).
  let compiledPairs = null;
  if (touched.some((c) => [CONFIG.table, CONFIG.denied].some((ruta) => isConfigPath(ruta, c.path) || isConfigPath(ruta, c.oldPath)))) {
    try {
      compiledPairs = exporter.validarTabla(afterTable, CONFIG.table, [...new Set(['cliente', 'persona', 'host-interno', 'maquina', 'interno',
        ...terms.map((t) => t && t.categoria), ...(denied.patrones || []).map((p) => p && p.categoria)])].filter(Boolean));
    } catch (e) {
      const problems = (String(e.message).match(/\n {2}· /g) || []).length || 1;
      throw new CouldNotLook(`la tabla de reemplazos no es válida (${problems} problema(s)) — el detalle nombra valores privados: `
        + 'miralo en tu terminal con node scripts/publishing/export.js --explain');
    }
  }

  // 6 · el conteo neto, archivo por archivo. Un mismo texto que sale en dos paquetes es una sola exposición.
  const pairs = afterTable.pares || [];
  const findings = [];
  const files = [...looked.values()].sort((a, b) => byCode(`${a.source}/${a.ruta}`, `${b.source}/${b.ruta}`));
  afterShips.preload(files.map((x) => [x.source, x.ruta]));
  beforeShips.forEach((sh, i) => sh.preload(files.map((x) => [x.source, x.beforePaths[i] || x.ruta])));
  const textsOf = (pieces) => { const seen = new Set(); return pieces.filter((pc) => pc.text !== null && !seen.has(pc.text) && seen.add(pc.text)); };
  const exceptionsOn = effShips !== afterShips || detEffective !== detFull;
  const effTerms = removedTerms.length ? [...terms, ...removedTerms] : terms;
  let looked_n = 0;
  for (const x of files) {
    const full = textsOf(afterShips.ofFile(x.source, x.ruta));
    const eff = effShips === afterShips ? full : textsOf(effShips.ofFile(x.source, x.ruta));
    if (!full.length && !eff.length) continue;
    looked_n++;
    const befores = beforeShips.map((sh, i) => (x.beforePaths[i] ? textsOf(sh.ofFile(x.source, x.beforePaths[i])) : []));
    const beforeNames = (det) => befores.map((b, i) => namesIn(b, det, terms, x.beforePaths[i] || x.ruta));
    const fullNet = full.length ? netNew(namesIn(full, detFull, terms, x.ruta), beforeNames(detFull)) : [];
    const effBefore = befores.map((bb, i) => namesIn(bb, detEffective, effTerms, x.beforePaths[i] || x.ruta));
    const effNet = exceptionsOn && eff.length ? netNew(namesIn(eff, detEffective, effTerms, x.ruta), effBefore) : [];
    // lo que aparece con lo que tapaba la base y no con la configuración del commit: lo tapa una excepción de este commit
    const left = new Map();
    for (const f of fullNet) left.set(f.key, (left.get(f.key) || 0) + 1);
    const exceptions = effNet.filter((f) => { const n = left.get(f.key) || 0; if (n > 0) { left.set(f.key, n - 1); return false; } return true; });
    if (!fullNet.length && !exceptions.length) continue;
    const tree = x.source === source ? trees[source] : trees[other];
    const entry = tree.find((e) => e.ruta === x.ruta);
    const raw = entry && entry.tipo === 'blob' ? read(x.source, entry.obj).toString('utf8') : null;
    const used = new Set();
    // la línea REAL va después de `...f`: la de `f` es la del texto transformado (sin secciones, sin claves)
    for (const f of fullNet) findings.push({ ...f, kind: 'name', source: x.source, ruta: x.ruta, line: realLine(raw, f, used) });
    for (const f of exceptions) findings.push({ ...f, kind: 'exception', source: x.source, ruta: x.ruta, line: realLine(raw, f, used) });
  }

  // 7 · las rutas (AC 5): de todo lo que se mira y sale. La ruta de antes descuenta sólo si ESA ruta salía: un git mv desde
  // algo que no se publica, o un archivo que empieza a salir por la configuración, estrena su ruta.
  for (const x of files) {
    if (!afterShips.ofFile(x.source, x.ruta).length) continue;
    const befores = beforeShips.map((sh, i) => (x.beforePaths[i] && sh.ofFile(x.source, x.beforePaths[i]).length ? [{ text: `${x.source}/${x.beforePaths[i]}` }] : []));
    const net = netNew(namesIn([{ text: `${x.source}/${x.ruta}` }], detFull, terms, PATHS_LIST), befores.map((b) => namesIn(b, detFull, terms, PATHS_LIST)));
    for (const f of net) findings.push({ ...f, kind: 'path', source: x.source, ruta: x.ruta });
  }

  // 8 · las entradas sin clasificar que el commit estrena
  for (const e of [...entries].sort(byCode)) findings.push({ kind: 'unclassified', source, entry: e });

  // 9 · la lista, el techo y los productos (sólo en el arnés, sólo si el commit los toca)
  const touches = (ruta) => source === 'arnes' && base.changes.some((c) => isConfigPath(ruta, c.path) || isConfigPath(ruta, c.oldPath));
  const baseTerms = new Set((Array.isArray(baseDenied.terminos) ? baseDenied.terminos : []).map(termKey));
  const addedTerms = terms.map((t, i) => ({ t, i })).filter(({ t }) => !baseTerms.has(termKey(t)));
  if (touches(CONFIG.denied)) {
    for (const { t, i } of addedTerms) if (t && typeof t.patron === 'string' && !exporter.termHasPair(t, compiledPairs || [])) findings.push({ kind: 'term-without-pair', index: i, category: t.categoria });
  }
  if (touches(CONFIG.ceiling)) {
    const beforeC = beforeText(0, CONFIG.ceiling);
    const afterC = afterTreeText(CONFIG.ceiling);
    if (beforeC !== null && afterC !== null) {
      const b = parseJson(beforeC, `${CONFIG.ceiling} (antes)`);
      const a = parseJson(afterC, CONFIG.ceiling);
      const raised = [];
      // Se recorren las cifras del ANTES: una que desaparece o deja de ser un número queda sin límite, y eso también es subir.
      for (const [pkg, nums] of Object.entries(b)) {
        if (pkg.startsWith('__') || !nums || typeof nums !== 'object') continue;
        for (const [k, was] of Object.entries(nums)) {
          if (typeof was !== 'number') continue;
          const now = a[pkg] && typeof a[pkg] === 'object' ? a[pkg][k] : undefined;
          if (typeof now !== 'number') raised.push({ what: `${pkg}.${k}`, from: was, to: now === undefined ? 'sin cifra' : JSON.stringify(now) });
          else if (now > was) raised.push({ what: `${pkg}.${k}`, from: was, to: now });
        }
      }
      if (raised.length && (!addedTerms.length || deniedBefore.broken)) findings.push({ kind: 'ceiling', raised });
    } else if (afterC !== null) parseJson(afterC, CONFIG.ceiling);
  }
  if (touches(CONFIG.parity)) {
    const products = (text) => exporter.productsOf(parseJson(text, CONFIG.parity));
    const afterP = afterTreeText(CONFIG.parity);
    const parityBefore = beforeJson(CONFIG.parity, 'todos sus productos cuentan como nuevos');
    const was = parityBefore.value === null ? new Set() : exporter.productsOf(parityBefore.value);
    const added = afterP === null ? [] : [...products(afterP)].filter((v) => !was.has(v));
    for (const value of exporter.unseenValues(added, detFull)) {
      const withPair = pairs.some((p) => [p.real, ...(p.formas || []).map((f) => f && f.texto)].some((x) => typeof x === 'string' && x.toLowerCase() === value.toLowerCase()));
      findings.push({ kind: 'product', value, missing: [`${CONFIG.denied} (su término)`, ...(withPair ? [] : [`${CONFIG.table} (su par)`])] });
    }
  }

  return { outcome: findings.length ? 'blocked' : 'clean', findings, files: looked_n, pairs, source, ms: Date.now() - t0, own };
}

function loadDetector(text) {
  try {
    return detector.cargarConfig(CONFIG.denied, text);
  } catch (e) {
    const where = (String(e.message).match(/^(?:terminos|patrones|permitidos)\[\d+\]/) || [])[0];
    throw new CouldNotLook(`la lista de denegación no sirve${where ? ` (${where})` : ''} — el detalle nombra valores privados: miralo en tu `
      + `terminal con node scripts/publishing/detector.js --config ${CONFIG.denied} README.md`);
  }
}

// ── el mensaje ───────────────────────────────────────────────────────────────────────────────────────────────────
function report(result, ownSource) {
  const { findings, pairs } = result;
  const where = (f) => `${f.source === ownSource ? '' : `${f.source}: `}${f.ruta}`;
  const suggestion = (f) => {
    const anon = pairFor(pairs, f.glued ? f.term : f.text);
    // (story 8.10.1) el de la tabla se muestra como lo que la copia va a poner si el real queda, no como lo que hay que
    // escribir: un inventado de la tabla corresponde uno a uno a un real
    return anon ? ` → escribí un nombre neutro; si queda, la tabla lo tapa con «${anon}»` : ` → sin par en la tabla: un sujeto genérico o un par nuevo en ${CONFIG.table}`;
  };
  const l = [`🛑 nombres reales nuevos en lo que se publica — el commit no se crea (${findings.length} hallazgo(s)):`, ''];
  const names = findings.filter((f) => f.kind === 'name' || f.kind === 'path');
  for (const f of findings) {
    if (f.kind === 'name') l.push(`  ${where(f)}:${f.line}  [${f.category}]  «${f.text}»${f.glued ? ` (nombre pegado; término ${f.term})` : ''}${suggestion(f)}`);
    else if (f.kind === 'path') l.push(`  (ruta) ${where(f)}  [${f.category}]  «${f.text}»${f.glued ? ` (nombre pegado; término ${f.term})` : ''}${suggestion(f)}`);
    else if (f.kind === 'exception') {
      l.push(`  ${where(f)}:${f.line}  [${f.category}]  «${f.text}» — la excepción va en un commit aparte, y la decide una persona: sacá el nombre de este commit (o la excepción, y proponela sola)`);
    } else if (f.kind === 'unclassified') {
      l.push(`  ${f.entry}/  sin clasificar: el commit le agrega archivos y la lista blanca no dice si sale. Clasificala en ${CONFIG.list}: en «in» de un paquete, o en «out» con su motivo`);
    } else if (f.kind === 'term-without-pair') {
      l.push(`  ${CONFIG.denied}: terminos[${f.index}] (${f.category}) no tiene par en ${CONFIG.table} — cada término necesita un par cuyo real o alguna forma coincida con él: sin par, un nombre con una excepción sale en la copia`);
    } else if (f.kind === 'ceiling') {
      l.push(`  ${CONFIG.ceiling}: ${f.raised.map((r) => (typeof r.to === 'number' ? `${r.what} sube de ${r.from} a ${r.to}` : `${r.what} pasa de ${r.from} a ${r.to}`)).join(' · ')} sin que el commit sume un término a ${CONFIG.denied} — el techo sólo baja, salvo en el commit que le enseña un nombre a la lista (y ahí lo dice su __last_change)`);
    } else if (f.kind === 'product') {
      l.push(`  ${CONFIG.parity}: el producto «${f.value}» no lo ve la lista — le falta ${f.missing.join(' y ')}. El alta de un producto trae su término, y su par, en el mismo commit`);
    }
  }
  if (names.length) {
    l.push('', 'Cómo salir, en este orden:',
      '  (a) Un nombre neutro: `acme` o «Cliente A» para un cliente, `acme-sql.database.windows.net` para un servidor,',
      '      `example.com` para un dominio, «el dev» para una persona. Que no conserve del real ni la inicial, ni el sufijo,',
      '      ni el largo, ni una palabra, ni el rubro. O un sujeto genérico («un cliente», «un producto del equipo», «un',
      `      servidor interno»). Los inventados de ${CONFIG.table} NO se usan para un texto nuevo: cada uno corresponde`,
      '      a un real, y la tabla sólo tapa lo que quedó escrito. Sin par en la tabla: el sujeto genérico, o un par nuevo.',
      '  (b) Si es un caso (un incidente, una story, un PR): la regla y su porqué, sin el nombre. El caso —con el nombre—',
      '      va al registro de incidentes (guides/maintaining/incident-log.md, que no se publica). En un guion se lo cita por su',
      '      entrada; en una guía, una portada, una skill o un revisor no se enlaza ni se cuenta (eso lo mira',
      '      scripts/publishing/internal-history.js).',
      `  (c) Sólo si lo decide una persona, en un commit aparte: un «out» con motivo en ${CONFIG.list}`,
      `      (el archivo no debería salir) o una excepción de valor exacto en «permitidos» de ${CONFIG.denied}.`);
  }
  l.push('', 'Guía: guides/maintaining/publicacion-espejo.md §«El núcleo sin nombres».');
  return l.join('\n');
}

// ── los registros (AC 13): conteos y huella, nunca un texto encontrado ───────────────────────────────────────────
// `extra` (tanda H1c): en la forma publicada, `{ form: 'published', list }` — de qué lugar salió la lista (`maintainers`,
// `maintained`, `env`, `harness`; null si no hubo), nunca su contenido ni su ruta.
function record(args, { outcome, verdict, rule, files = 0, findings = [], ms = 0, extra = null }) {
  if (args.mode !== 'staged') return;   // el pull request y las repeticiones no son commits de una máquina
  const counts = {};
  const other = {};
  for (const f of findings) {
    if (f.kind === 'name' || f.kind === 'path' || f.kind === 'exception') counts[f.category] = (counts[f.category] || 0) + 1;
    else other[f.kind] = (other[f.kind] || 0) + 1;
  }
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'new-names.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(), repo: args.source, mode: args.mode, files, findings: counts, other, blocked: verdict === 'bloqueo', outcome, ms, ...(extra || {}),
    })}\n`);
  } catch { /* medir nunca rompe el commit */ }
  const print = JSON.stringify([args.source, findings.map((f) => [f.kind, f.source || '', f.ruta || f.entry || '', f.line || 0, f.category || ''])]);
  try {
    require('../lib/guard-record.js').anotar({ freno: 'new-names', regla: rule, veredicto: verdict, cmd: print });
  } catch { /* es ayuda, no evidencia */ }
}

/** El cierre de una corrida en la forma publicada: los mismos códigos (0 pasa · 1 hallazgos), su línea en el registro. */
function finishPublished(args, result, t0) {
  const ms = Date.now() - t0;
  const extra = { form: 'published', list: result.list };
  const json = (outcome, blocked, more = {}) => { if (args.json) process.stdout.write(`${JSON.stringify({ outcome, blocked, ...more, ...extra, ms })}\n`); };
  if (result.outcome === 'no-list') {
    say('⚠️  nombres nuevos: esta máquina no tiene la lista privada: no miré los nombres de este commit; se miran al empujar. '
      + 'Si mantenés el arnés: harness.js config set paths.maintainers <clon de mantenimiento>');
    record(args, { outcome: 'no-list', verdict: 'paso', rule: 'no-list', ms, extra });
    json('no-list', false);
    return 0;
  }
  const blocked = result.findings.length > 0;
  // con la lista de la variable, un commit que pasa no pasó por la lista de la máquina: se anota como un escape
  const escaped = !blocked && result.list === 'env';
  record(args, {
    outcome: blocked ? 'blocked' : 'clean', verdict: blocked ? 'bloqueo' : escaped ? 'escape' : 'paso',
    rule: blocked ? 'new-name' : escaped ? 'list-from-env' : 'clean', files: result.files, findings: result.findings, ms, extra,
  });
  const counts = {};
  for (const f of result.findings) counts[f.category] = (counts[f.category] || 0) + 1;
  json(blocked ? 'blocked' : 'clean', blocked, { files: result.files, findings: counts });
  if (blocked) say(publishedReport(result));
  for (const note of result.notes) say(note);
  return blocked ? 1 : 0;
}

function main() {
  const t0 = Date.now();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    say(`⛔ nombres nuevos: no pude mirar — ${e.message}`);
    return 2;
  }
  if (process.env.TYCON_NEW_NAMES === '0') {
    // (se decide antes de saber qué árbol es: la línea vale para el repo del equipo y para un clon del público)
    say('⚠️  nombres nuevos: APAGADO (TYCON_NEW_NAMES=0) — no se miró si entran nombres reales en lo que se publica. Lo que entre así queda para el control siguiente: el termómetro nocturno en el repo del equipo, el freno al empujar en un clon del público.');
    record(args, { outcome: 'disabled', verdict: 'escape', rule: 'disabled', ms: Date.now() - t0 });
    return 0;
  }
  let result;
  try {
    result = run(args);
  } catch (e) {
    const known = e instanceof CouldNotLook || e instanceof exporter.NoPudo || e instanceof detector.ErrorDeConfig;
    say(`⛔ nombres nuevos: no pude mirar — ${known ? e.message : (e && e.stack) || e}. No poder mirar no es verde: el commit no se crea.`);
    for (const note of (e && e.notes) || []) say(note);   // la forma publicada: la lista ilegible de un clon atrasado
    record(args, { outcome: 'could-not-look', verdict: 'bloqueo', rule: 'could-not-look', ms: Date.now() - t0, extra: (e && e.extra) || null });
    if (args.json) process.stdout.write(`${JSON.stringify({ outcome: 'could-not-look', blocked: true, ms: Date.now() - t0 })}\n`);
    return 2;
  }
  if (result.published) return finishPublished(args, result, t0);
  if (result.outcome === 'not-measured') {
    say(`${azure() ? '##vso[task.logissue type=warning]' : '⚠️  '}${result.message}`);
    if (args.json) process.stdout.write(`${JSON.stringify({ outcome: 'not-measured', blocked: false, ms: Date.now() - t0 })}\n`);
    return 0;
  }
  if (result.outcome === 'quiet') {
    if (args.json) process.stdout.write(`${JSON.stringify({ outcome: 'quiet', blocked: false, ms: Date.now() - t0 })}\n`);
    return 0;
  }
  if (result.outcome === 'other-repo-missing') {
    say(`⚠️⚠️ nombres nuevos: no encontré ${result.other} (${result.otherDir}) — no se miró si entran nombres en lo que se publica. `
      + `Cloná o ubicá ${result.other}${result.other === 'agent-skills' ? ' o seteá TYCON_SKILLS_DIR' : ' o seteá TYCON_GUIDES_DIR'}.`);
    record(args, { outcome: 'other-repo-missing', verdict: 'paso', rule: 'other-repo-missing', ms: Date.now() - t0 });
    return 0;
  }
  const blocked = result.findings.length > 0;
  const kinds = new Set(result.findings.map((f) => f.kind));
  const rule = !blocked ? 'clean' : kinds.has('name') || kinds.has('path') ? 'new-name' : kinds.has('exception') ? 'exception-same-commit'
    : kinds.has('unclassified') ? 'unclassified-entry' : kinds.has('term-without-pair') ? 'term-without-pair'
      : kinds.has('product') ? 'product-without-term' : 'ceiling-raised';
  record(args, { outcome: blocked ? 'blocked' : 'clean', verdict: blocked ? 'bloqueo' : 'paso', rule, files: result.files, findings: result.findings, ms: Date.now() - t0 });
  if (args.json) {
    const counts = {};
    for (const f of result.findings) counts[f.category || f.kind] = (counts[f.category || f.kind] || 0) + 1;
    process.stdout.write(`${JSON.stringify({ outcome: blocked ? 'blocked' : 'clean', blocked, files: result.files, findings: counts, ms: Date.now() - t0 })}\n`);
  }
  if (blocked) say(report(result, args.source));
  return blocked ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  parseArgs, netNew, pairFor, parseChanges,
  // story 8.9: el freno de nombres en castellano (spanish-names.js) arma las mismas fotos con la misma clasificación del
  // exportador; se reusan de acá en vez de copiarlas.
  // story 8.26 (tanda H1c): las dos preguntas del modo de la forma publicada, para poder hacerlas sueltas en las pruebas
  isPublishedForm, isTeamMachine,
  CouldNotLook, CONFIG, legacyPathsOf, configPathIn, isConfigPath, exporterFor, SOURCES, EMPTY_TREE, hookGit, isolated, indexTree, commitTree, otherRepo, blobReader, snapshot,
  contextFor, ships, parseJson, realOr,
  // story 8.18: el repo unido, partido por ruta (lo reusa spanish-names.js)
  sourceOfPath, splitTree, ownChanges, unifiedCheckout, unifiedTree,
  // el rango que cruza la unión y el archivo que empieza a salir, mirado una sola vez (AC 25)
  treeShape, rangeBefores, unifiedParents, beforeHalves, startsHere,
};
