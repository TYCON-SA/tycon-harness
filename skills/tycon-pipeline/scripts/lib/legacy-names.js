#!/usr/bin/env node
'use strict';
/**
 * lib/legacy-names.js — el puente de agent-skills a la biblioteca de nombres viejos del arnés. *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El arnés renombra a inglés las variables de entorno en castellano; el nombre viejo sigue andando hasta la fecha de
 * retiro gracias a su biblioteca (`scripts/lib/legacy-names.js` del arnés: el mapa, el registro de usos, el warning en
 * Azure DevOps). agent-skills también lee algunas de esas variables, y los dos repos se actualizan con pulls separados:
 * si agent-skills llega primero, el arnés de la máquina todavía no tiene la entrada en su mapa, y un interruptor de
 * apagado puesto con el nombre viejo en el .zshrc de alguien dejaría de apagar en silencio.
 *
 * Por eso dos caminos, en este orden:
 *   1. la biblioteca del arnés (por `harness-path.js`: TYCON_GUIDES_DIR o el enlace), si ya conoce la variable;
 *   2. si no hay arnés, o es de una versión sin esa biblioteca, la tabla propia de abajo (nuevo → viejo), sólo con las variables que lee
 *      agent-skills. Por este camino no se anota el uso: sin el arnés no hay dónde.
 *
 * Uso: const { readEnv } = require('./lib/legacy-names.js');   readEnv('TYCON_NEW', { env, where })
 *
 * ── OPCIONES Y SUBCOMANDOS ──────────────────────────────────────────────────────────────────────
 * Lo mismo para las opciones y los subcomandos de los scripts de agent-skills: cada uno suma una línea al entrar,
 * `require('./lib/legacy-names.js').aliasArgv('<su ruta en agent-skills>', { exitCode, prefix })`, que reescribe
 * `process.argv` con los nombres nuevos antes de que el script lo lea. Además de los dos repos que se actualizan por
 * separado, acá pesa otra cosa: una sesión del pipeline abierta tiene en la memoria las instrucciones de antes y sigue
 * mandando `marker.js … --tipo`. Tres caminos:
 *   1. el arnés con el mapa al día (trae cada par de la tabla propia de ese where): su `aliasArgv`, que además anota el uso;
 *   2. el arnés atrasado (su mapa no conoce el where, o le falta un par que se sumó después): su `aliasArgv`
 *      con la tabla propia como mapa (también anota);
 *   3. sin arnés, o de una versión sin mapa de opciones: la tabla propia, traducida acá, sin anotar.
 * La tabla propia es la misma que las entradas `repo: agent-skills` del mapa (lo prueba
 * tests/legacy-names-options.test.js); va sin guiones para que el freno de nombres no la cuente como opciones.
 * `nombreDePaquete` hace lo mismo con el nombre de un paquete de revisores (`packs:` de un repo de producto).
 *
 * ── LAS CLAVES DEL MANIFIESTO DE UN PAQUETE ─────────────────────────────────────────────────────
 * `readPackKeys(json)`: el manifiesto de un paquete de revisores con sus claves viejas pasadas a las nuevas, en todos
 * los niveles. Un paquete puede vivir fuera de agent-skills (`TYCON_PACKS_DIR`) y estar escrito con las claves de
 * antes. Los mismos tres caminos: el `readKeysDeep` del arnés con su mapa (anota el uso), con la tabla propia si su
 * mapa no conoce `PACK_KEYS_WHERE`, o la tabla propia traducida acá si no hay arnés o es de una versión sin esas claves. Una clave
 * vieja y su nueva con valores distintos en el mismo objeto TIRA: quien carga el paquete lo trata como paquete roto.
 *
 * ── EL ESTADO DE LA MÁQUINA ─────────────────────────────────────────────────────────────────────
 * `prepareStateWrite(ruta)`: antes de escribir un estado de `~/.claude/.tycon-pipeline/` con su nombre nuevo, se lleva
 * el viejo (la carpeta de las escrituras por consola, entera). Los mismos tres caminos (abajo, junto a la función).
 *
 * Las tablas se retiran con el resto de los nombres viejos.
 */

const path = require('path');

const os = require('os');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const OWN = Object.freeze({
  TYCON_SNAPSHOT_GUARD: 'TYCON_FOTO_GUARD',
  TYCON_NO_RUN_CHANGE: 'TYCON_NO_CAMBIO_DE_CORRIDA',
  TYCON_RUN_CHANGE_TIMEOUT_MS: 'TYCON_CAMBIO_TIMEOUT_MS',
  TYCON_CLOSURE_RECORD: 'TYCON_CONSTANCIA_CIERRE',
  TYCON_NO_THREAD_RESCUE: 'TYCON_NO_RESCATE_HILO',
  TYCON_ROSTER_NAMES: 'TYCON_ROSTER_NOMBRES',
  TYCON_TODAY: 'TYCON_HOY',
});

let harness;   // undefined = sin buscar · null = no hay · la biblioteca del arnés
function harnessLib() {
  if (harness !== undefined) return harness;
  harness = null;
  try {
    const r = require('./harness-path.js').rutaArnesHook();
    if (r && r.dir) {
      const lib = require(path.join(r.dir, 'scripts', 'lib', 'legacy-names.js'));
      if (lib && typeof lib.readEnv === 'function' && typeof lib.envNames === 'function') { harness = lib; harnessDir = r.dir; }
    }
  } catch (_) { /* sin arnés o de una versión sin la biblioteca: la tabla propia */ }
  return harness;
}
let harnessDir = null;
/** ¿El arnés trae su mapa de renombres? La copia pública no lo trae. */
const harnessHasMap = () => !!harnessDir && require('fs').existsSync(path.join(harnessDir, 'scripts', 'lib', 'renames.json'));

/** La variable `name` (su nombre nuevo), o la vieja si sólo está la vieja; distintas, gana la nueva. */
function readEnv(name, opts = {}) {
  const env = opts.env || process.env;
  const lib = harnessLib();
  if (lib && lib.envNames(name).length > 1) return lib.readEnv(name, { ...opts, env });
  const nv = env[name];
  if (nv !== undefined || !OWN[name]) return nv;
  return env[OWN[name]];
}

// ── opciones y subcomandos ─────────────────────────────────────────────────────────
const P = 'skills/tycon-pipeline/scripts';
/** where (relativo a agent-skills) → { option: { viejo: nuevo }, subcommand: { viejo: nuevo } }, sin guiones. */
const OWN_ARGS = Object.freeze({
  [`${P}/marker.js`]: {
    option: {
      tipo: 'type', pruebas: 'tests', propias: 'own', diferidos: 'deferred', motivo: 'reason', clases: 'classes',
      aparte: 'separate', modelo: 'model', archivo: 'file', 'fechar-al-ultimo-revisor': 'date-at-last-reviewer',
      // Las rutas de las pruebas propias de mark-adversarial-result. Dos letras que también son
      // inglés: el termómetro no la cuenta, y es lo único en castellano que el agente tipea en cada pase adversarial.
      en: 'in',
    },
  },
  [`${P}/pipeline.js`]: {
    option: { breve: 'brief', marcas: 'marks' },
    subcommand: { 'qa-legibilidad': 'qa-readability', validadores: 'validators' },
  },
  [`${P}/qa-guide.js`]: { option: { pasos: 'steps' } },
  [`${P}/package-equivalence.js`]: { option: { 'solo-casos': 'cases-only' }, subcommand: { foto: 'snapshot', informe: 'report' } },
  [`${P}/lib/group-findings.js`]: { option: { 'emitir-nucleo': 'emit-core' } },
  [`${P}/lib/harness-path.js`]: { option: { 'idioma-shell': 'shell-idiom' } },
  [`${P}/tests/test-skill-contract.js`]: { option: { generar: 'generate', historia: 'history' } },
  // Python: lleva su propia copia (el puente de Node no le alcanza); acá está para que la prueba la compare con el mapa
  'skills/bizuit-sdd/tests/census.py': { option: { verificar: 'verify', agregado: 'aggregate', 'por-archivo': 'per-file' } },
});
/** Paquetes de revisores renombrados (la carpeta `packs/<nombre>` y su `nombre`): viejo → nuevo. */
const OWN_PACKS = Object.freeze({ clientes: 'clients' });
const ARG_KINDS = ['option', 'subcommand'];

class OwnArgsError extends Error {}

/** Las entradas de la tabla propia de `where`, con la forma del mapa del arnés. */
function ownEntries(where) {
  const t = OWN_ARGS[where] || {};
  return ARG_KINDS.flatMap((kind) => Object.entries(t[kind] || {})
    .map(([old, nu]) => ({ kind, old, new: nu, where, batch: 'B3b', repo: 'agent-skills' })));
}

/** Sin el arnés: opciones (`--viejo`, `--viejo=x`) y el primer argumento como subcomando; después de `--`, nada. */
function ownAlias(argv, where) {
  const t = OWN_ARGS[where];
  if (!t) return argv;
  const opts = t.option || {};
  const seen = new Map();   // nuevo → { old, new }
  const out = argv.map((raw, i) => {
    const a = String(raw);
    if (argv.slice(0, i).includes('--')) return a;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const rest = eq < 0 ? '' : a.slice(eq);
      if (Object.prototype.hasOwnProperty.call(opts, name)) {
        const s = seen.get(opts[name]) || {};
        seen.set(opts[name], { ...s, old: name });
        return `--${opts[name]}${rest}`;
      }
      if (Object.values(opts).includes(name)) seen.set(name, { ...(seen.get(name) || {}), new: true });
      return a;
    }
    if (i === 0 && t.subcommand && Object.prototype.hasOwnProperty.call(t.subcommand, a)) return t.subcommand[a];
    return a;
  });
  for (const [nu, s] of seen) {
    if (s.old && s.new) throw new OwnArgsError(`la misma opción dos veces: --${s.old} y --${nu} (--${s.old} es el nombre viejo de --${nu})`);
  }
  return out;
}

/**
 * La línea al entrar de un script de agent-skills: `process.argv` con las opciones y el subcomando viejos pasados a los
 * nuevos. Con el viejo y el nuevo de una opción juntos escribe el error (con `prefix`) y sale con `exitCode`: el código
 * de opción desconocida del script, 2 si no tiene uno.
 */
function aliasArgv(where, { exitCode = 2, prefix = '' } = {}) {
  const lib = harnessLib();
  if (lib && typeof lib.aliasArgv === 'function' && typeof lib.usableEntries === 'function' && typeof lib.loadMap === 'function') {
    // «El mapa conoce el where» no alcanza: una opción que se suma a un guion que el mapa ya conocía —la de las
    // rutas de las pruebas propias de marker.js— no está en el mapa de un arnés un pull atrás, y delegar en él la dejaría
    // sin traducir. Se delega sólo si el mapa trae CADA par de la tabla propia de ese where; si le falta alguno, la tabla
    // propia entera por la misma biblioteca (que igual anota el uso).
    const own = ownEntries(where);
    let known = false;
    try {
      const theirs = lib.usableEntries(lib.loadMap()).filter((e) => e.where === where && ARG_KINDS.includes(e.kind));
      known = theirs.length > 0 && own.every((o) => theirs.some((e) => e.kind === o.kind && e.old === o.old && e.new === o.new));
    } catch (_) { known = false; }
    lib.aliasArgv(where, known ? { exitCode, prefix } : { exitCode, prefix, map: { entries: own } });
    return;
  }
  try {
    process.argv = [...process.argv.slice(0, 2), ...ownAlias(process.argv.slice(2), where)];
  } catch (e) {
    if (!(e instanceof OwnArgsError)) throw e;
    process.stderr.write(`${prefix}${e.message}\n`);
    process.exit(exitCode);
  }
}

/** El nombre actual de un paquete de revisores: el nuevo si `nombre` es uno viejo (y se anota el uso con el arnés). */
function nombreDePaquete(nombre, { where = `${P}/lib/packs.js` } = {}) {
  if (!Object.prototype.hasOwnProperty.call(OWN_PACKS, nombre)) return nombre;
  const nu = OWN_PACKS[nombre];
  const lib = harnessLib();
  if (lib && typeof lib.recordUse === 'function') {
    try { lib.recordUse({ kind: 'folder', old: `packs/${nombre}`, new: `packs/${nu}`, script: where }); } catch (_) { /* anotar nunca frena */ }
  }
  return nu;
}

// ── las claves del manifiesto de un paquete ──────────────────────────────────────────
/** El nombre lógico de lo que lee el validador del manifiesto (el `where` de sus entradas en el mapa del arnés). */
const PACK_KEYS_WHERE = 'packs/pack.json';
/** Claves del manifiesto renombradas, en todos los niveles: viejo → nuevo. La misma tabla que las entradas del mapa. */
const OWN_PACK_KEYS = Object.freeze({
  nombre: 'name', descripcion: 'description', guias: 'guides', revisores: 'reviewers', hermanos: 'siblings',
  agente: 'agent', grupo: 'group', cuando: 'when', superficie: 'surface', profundidad: 'depth', prefijos: 'prefixes',
  necesitaStory: 'needsStory', modelo: 'model', nota: 'note',
  todos: 'all', alguno: 'any', deteccion: 'detection', archivos: 'files', agregado: 'added',
  patron: 'pattern', extensiones: 'extensions',
  ruta: 'path',
});

class PackKeysError extends Error {
  constructor(message) { super(message); this.name = 'PackKeysError'; }
}

function ownPackKeyEntries() {
  return Object.entries(OWN_PACK_KEYS).map(([old, nu]) => ({ kind: 'key', old, new: nu, where: PACK_KEYS_WHERE, batch: 'D1', repo: 'agent-skills' }));
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

/** Sin el arnés: la tabla propia en todos los niveles, con la misma regla que `readKeysDeep` (copia; valores intactos). */
function ownReadPackKeys(obj) {
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const nu = Object.prototype.hasOwnProperty.call(OWN_PACK_KEYS, k) ? OWN_PACK_KEYS[k] : null;
      if (nu && Object.prototype.hasOwnProperty.call(v, nu)) {
        if (!sameValue(v[nu], x)) {
          throw new PackKeysError(`${PACK_KEYS_WHERE}: la clave «${nu}» y su nombre viejo «${k}»${at ? ` (en ${at})` : ''} tienen valores distintos — dejá una sola`);
        }
        continue;   // queda la nueva, que se copia en su propia vuelta
      }
      const key = nu || k;
      out[key] = walk(x, at ? `${at}.${key}` : key);
    }
    return out;
  };
  return walk(obj, '');
}

/** El manifiesto con las claves nuevas. Tira (LegacyNamesError del arnés o PackKeysError) si una vieja y su nueva difieren. */
function readPackKeys(json) {
  const lib = harnessLib();
  if (lib && typeof lib.readKeysDeep === 'function' && typeof lib.usableEntries === 'function' && typeof lib.loadMap === 'function') {
    let known = false;
    try { known = lib.usableEntries(lib.loadMap()).some((e) => e.kind === 'key' && e.where === PACK_KEYS_WHERE); } catch (_) { known = false; }
    return lib.readKeysDeep(json, PACK_KEYS_WHERE, known ? {} : { map: { entries: ownPackKeyEntries() } });
  }
  return ownReadPackKeys(json);
}

// ── el estado de la máquina ──────────────────────────────────────────────────────────
// Lo que agent-skills escribe en ~/.claude/.tycon-pipeline/ con nombre nuevo: nombre nuevo → viejo. La misma entrada
// `state-file` vive en el mapa del arnés (lo prueba tests/console-writes.test.js).
const OWN_STATES = Object.freeze({ 'console-writes': 'escrituras-consola' });
const STATE_DIR = () => path.join(stateDirOf(require('os').homedir()));

/** La ruta vieja de un estado por su ruta nueva (la del arnés si la conoce, si no la tabla propia), o null. */
function legacyStatePath(p) {
  const abs = path.resolve(String(p));
  const lib = harnessLib();
  if (lib && typeof lib.oldPathOf === 'function') {
    try { const o = lib.oldPathOf(abs); if (o) return o; } catch (_) { /* la tabla propia */ }
  }
  const name = path.basename(abs);
  return OWN_STATES[name] && path.dirname(abs) === STATE_DIR() ? path.join(STATE_DIR(), OWN_STATES[name]) : null;
}

/**
 * Antes de escribir un estado con su nombre nuevo (`p`, ruta absoluta): si sólo está el viejo, pasa al nuevo (una
 * carpeta, entera) y el viejo queda intacto. Devuelve la ruta DONDE ESCRIBIR. Tres caminos:
 *   1. el arnés conoce el nombre nuevo: su `prepareStateWrite`, que además anota el uso;
 *   2. el arnés es de una versión sin ese nombre: quien LEE ese estado es ese arnés, que mira sólo el nombre viejo — se devuelve el
 *      viejo y no se migra nada (migrar dejaría lo escrito donde nadie lo lee);
 *   3. sin arnés, o con uno sin mapa de renombres (la copia pública: su lector mira sólo el nombre nuevo): la tabla
 *      propia, copiada acá con el mismo cuidado (a una hermana temporal y recién ahí el nombre nuevo: nunca a medias) y
 *      sin anotar.
 * Una ruta que no es de la tabla pasa derecho. Tira si la copia falla: quien escribe decide.
 */
function prepareStateWrite(p, opts = {}) {
  const abs = path.resolve(String(p));
  const lib = harnessLib();
  if (lib && !(typeof lib.oldPathOf === 'function' && !harnessHasMap())) {
    if (typeof lib.prepareStateWrite === 'function' && typeof lib.oldPathOf === 'function' && lib.oldPathOf(abs)) {
      return lib.prepareStateWrite(abs, opts);
    }
    return legacyStatePath(abs) || abs;
  }
  const name = path.basename(abs);
  if (!OWN_STATES[name] || path.dirname(abs) !== STATE_DIR()) return abs;
  const fs = require('fs');
  const old = path.join(STATE_DIR(), OWN_STATES[name]);
  if (fs.existsSync(abs) || !fs.existsSync(old)) return abs;
  const tmp = `${abs}.migrating-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(old, tmp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* no cambia el veredicto */ }
    if (fs.existsSync(abs)) return abs;   // otro proceso ya la migró
    throw new Error(`no pude llevar el estado viejo ${old} a ${abs} (${(e && e.code) || (e && e.message) || e})`);
  }
  return abs;
}

/** Anota el uso de un nombre viejo en el registro del arnés (lo que decide el retiro). Sin arnés no anota; nunca frena. */
function recordUse(entry) {
  const lib = harnessLib();
  if (!lib || typeof lib.recordUse !== 'function') return false;
  try { lib.recordUse(entry); return true; } catch (_) { return false; }
}

module.exports = {
  readEnv, recordUse, OWN, OWN_ARGS, OWN_PACKS, aliasArgv, nombreDePaquete,
  PACK_KEYS_WHERE, OWN_PACK_KEYS, PackKeysError, readPackKeys,
  OWN_STATES, prepareStateWrite, legacyStatePath,
};
