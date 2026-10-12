'use strict';
// state.js — el estado del mecanismo de instalación: ~/.claude/.tycon-pipeline/harness-state.json (story 8.13, AC 2).
//
// Lo que guarda: `schema`, `mode` (managed | developer), `tree` (a qué apunta el enlace), `sources` (una lista: en los
// repos internos son dos —`harness` y `agent_skills`—, en el repo único de la 8.7 es una), `channel`, `version`, `managed`
// (las piezas que el aplicador escribió; lo llena la tanda B), `hold` (la retención de un rollback; tanda C), `notice` (el
// aviso pendiente que imprime el hook síncrono), `last_fetch` / `last_apply` / `last_health`, `failed` y `bootstrap` (la
// copia fija de arranque y sus sha256).
//
// Lo que suma la story 8.13.1 (AC 2), sin subir el `schema`: campos ADITIVOS. `source` (`internal` | `public`: de dónde
// instala la máquina), `sources[].kind` (`tree` | `layer`: el árbol o la capa que se apila encima) y `sources[].reference`
// (sólo en una capa: el clon interno de la persona, si existe; el clon de lectura del mecanismo va en su `dir`). Las
// fuentes se llaman `harness` (el árbol) e `internal` (la capa); la ref de vuelta de la capa sale de la regla de
// siempre (`refs/tycon/previous/<name>`, sources.js). Además `layer` (`manifest`, `version`, `at`, `minimum`,
// `lag_hours`), `migration` (`tree_before`, `journal`) y `migration_hold` (`at`, `reason`): no reusan `tree_before` ni
// `hold` de la 8.13. Un estado de la 8.13, sin nada de esto, se lee como `source: internal` sin capa; una fuente sin
// `kind` es el árbol (`kindOf`). Leer no escribe: los campos se completan en memoria.
//
// Las dos reglas que importan:
//   · Un estado ILEGIBLE no es «no instalado» (misma regla que la configuración, 8.3 AC 2): `read` distingue `missing`
//     (sin archivo: «no instalado», 3) de `broken` / `unsupported_schema` / `tree_missing` (algo está y no sirve: 2, con
//     el motivo). Nunca tira: devuelve `{ status, state, reason }`.
//   · Se escribe ATÓMICO (temporal + rename, tres reintentos ante EPERM/EACCES: Windows reserva el archivo mientras un
//     antivirus lo mira) y SIEMPRE dentro del candado (lock.js), releyendo adentro: dos sesiones nunca se pisan.
//
// Funciones puras respecto del HOME: reciben `home`; sólo `os.homedir()` como valor por defecto.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir } = require('./tycon-home.js');   // story 8.23: la ruta del estado la sabe una sola pieza

const SCHEMA = 1;
const FILE_NAME = 'harness-state.json';
// story 8.13.1 (AC 2): de dónde instala la máquina, qué es cada fuente y cómo se llaman las dos
const SOURCE_VALUES = Object.freeze(['internal', 'public']);
// story 8.23 (tanda B): `release` es la versión BAJADA como archivos (sin git), al lado de `tree` (el clon). Una máquina
// con un clon no cambia nada: la forma la decide `isRelease`, y cada comando bifurca al principio.
const KINDS = Object.freeze(['tree', 'layer', 'release']);
const TREE_SOURCE = 'harness';
const LAYER_SOURCE = 'internal';
// los campos de la 8.13.1 que un estado de la 8.13 no trae, y con qué se leen
// `team` (story 8.25, AC 2): la capa del equipo apilada sobre la versión bajada — `{ repo, ref, commit, tree, etag, name,
// files, applied_at }` o null (una máquina sin capa, que se lee como hoy). Aditivo: ni una sección en config.json ni un
// `kind` nuevo en sources[] (D2 de la story).
const ADDED_FIELDS = Object.freeze({ source: 'internal', layer: null, migration: null, migration_hold: null, team: null });

/** Dónde vive cada cosa: el estado, la carpeta del mecanismo (candado, registro, copia fija). */
function paths(home = os.homedir()) {
  const dir = stateDir(home);
  const harnessDir = path.join(dir, 'harness');
  return {
    dir,
    file: path.join(dir, FILE_NAME),
    harnessDir,
    lockDir: path.join(harnessDir, 'harness.lock'),
    // story 8.23 (tanda L, AC 39): desde cuándo y por qué el arranque no pudo actualizar; lo escribe el que NO pudo
    // (también el que encontró el candado tomado, sin tomarlo) y lo borra una actualización sana
    failuresFile: path.join(harnessDir, 'update-failures.json'),
    log: path.join(harnessDir, 'startup.log'),
    bootstrapDir: harnessDir,
    // story 8.13.1 (AC 7): los clones de lectura del mecanismo, uno por fuente `layer` (`sources/<nombre>`, --bare), y
    // el manifiesto de la capa apilada
    sourcesDir: path.join(harnessDir, 'sources'),
    layerManifest: path.join(harnessDir, 'layer.json'),
  };
}

/** El estado completo con los valores de arranque. `version`, si viene, ya derivada por quien instala. */
function defaults({ tree, sources, mode = 'managed', channel = 'stable', version = null, source = ADDED_FIELDS.source } = {}) {
  return {
    schema: SCHEMA,
    mode,
    source,
    tree: tree || null,
    tree_before: null,
    sources: Array.isArray(sources) ? sources.map((s) => Object.assign({ previous: null }, s)) : [],
    channel,
    version: Object.assign({ number: null, installed_at: new Date().toISOString() }, version || {}),
    managed: [],
    hold: null,
    layer: null,
    migration: null,
    migration_hold: null,
    team: null,
    notice: null,
    last_fetch: null,
    last_apply: null,
    last_health: null,
    failed: null,
    bootstrap: { version: null, sha256: {} },
  };
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Qué es una fuente: `tree` o `layer`. Una fuente sin `kind` (la 8.13) es el árbol. */
function kindOf(source) { return (source && source.kind) || 'tree'; }
/** Las fuentes que son capa (ninguna en un estado de la 8.13, ni en una máquina de afuera). */
function layerSources(state) { return (state && Array.isArray(state.sources) ? state.sources : []).filter((s) => kindOf(s) === 'layer'); }
/** La fuente `release` (story 8.23, tanda B), o null: una instalación de versión bajada tiene exactamente una. */
function releaseSource(state) { return (state && Array.isArray(state.sources) ? state.sources : []).find((s) => kindOf(s) === 'release') || null; }
/** ¿La máquina instaló una versión bajada (sin git)? Si no, es un clon: todo sigue como hoy. */
function isRelease(state) { return releaseSource(state) !== null; }

/** El motivo por el que los campos de la 8.13.1 no sirven, o null. Un valor inventado es un estado roto, no el default. */
function addedFieldsProblem(state) {
  if (state.source !== undefined && !SOURCE_VALUES.includes(state.source)) {
    return `«source» vale ${JSON.stringify(state.source)}; tiene que ser ${SOURCE_VALUES.join(' o ')}`;
  }
  for (const k of ['layer', 'migration', 'migration_hold', 'team']) {
    if (state[k] !== undefined && state[k] !== null && !isObject(state[k])) return `«${k}» tiene que ser un objeto o null (vale ${JSON.stringify(state[k])})`;
  }
  for (const s of state.sources) {
    const name = isObject(s) && s.name ? `«${s.name}»` : 'sin nombre';
    if (isObject(s) && s.kind !== undefined && !KINDS.includes(s.kind)) return `la fuente ${name} tiene «kind» ${JSON.stringify(s.kind)}; tiene que ser ${KINDS.join(' o ')}`;
    if (isObject(s) && s.reference !== undefined && kindOf(s) !== 'layer') return `la fuente ${name} trae «reference» y no es una capa: el clon de la persona va sólo en una fuente layer`;
  }
  return null;
}

/**
 * Lee el estado sin tirar.
 * @returns {{ status: 'ok'|'missing'|'broken'|'unsupported_schema'|'tree_missing', state: object|null, reason: string|null, file: string }}
 */
function read(home = os.homedir()) {
  const { file } = paths(home);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', state: null, reason: null, file };
    return { status: 'broken', state: null, reason: `no se pudo leer (${(e && e.code) || e.message})`, file };
  }
  let state;
  try {
    state = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { status: 'broken', state: null, reason: `JSON ilegible (${e.message})`, file };
  }
  if (!isObject(state)) return { status: 'broken', state: null, reason: 'el contenido tiene que ser un objeto JSON', file };
  if (!Number.isInteger(state.schema) || state.schema < 1) {
    return { status: 'broken', state, reason: `sin «schema» entero (vale ${JSON.stringify(state.schema)})`, file };
  }
  if (state.schema > SCHEMA) {
    return { status: 'unsupported_schema', state, reason: `schema ${state.schema} es más nuevo que el ${SCHEMA} que este programa conoce: actualizá el arnés`, file };
  }
  if (typeof state.tree !== 'string' || !state.tree) {
    return { status: 'broken', state, reason: 'sin «tree» (a qué clon apunta el enlace)', file };
  }
  if (!fs.existsSync(state.tree)) {
    return { status: 'tree_missing', state, reason: `el árbol ${state.tree} no existe`, file };
  }
  if (!Array.isArray(state.sources)) return { status: 'broken', state, reason: '«sources» tiene que ser una lista', file };
  const problem = addedFieldsProblem(state);
  if (problem) return { status: 'broken', state, reason: problem, file };
  // un estado de la 8.13 se lee como `source: internal` sin capa (story 8.13.1, AC 2): en memoria, sin escribir
  for (const [k, v] of Object.entries(ADDED_FIELDS)) if (state[k] === undefined) state[k] = v;
  return { status: 'ok', state, reason: null, file };
}

const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin SharedArrayBuffer: sin espera */ } };

/**
 * Escribe un archivo atómico: temporal al lado + rename. Tres reintentos ante EPERM/EACCES (Windows, mientras otro
 * proceso tiene el archivo abierto). Devuelve la ruta escrita; tira si no pudo.
 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      lastError = e;
      if (!(e && (e.code === 'EPERM' || e.code === 'EACCES')) || attempt === 3) break;
      nap(50 * attempt);
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch (_) { /* el temporal ya no está */ }
  throw lastError;
}

/** Escribe el estado (atómico). Sólo dentro de `lock.withLock`: ésa es la regla, no la impone este archivo. */
function write(home, state) {
  const { file } = paths(home);
  const out = Object.assign({}, state, { schema: Number.isInteger(state.schema) ? state.schema : SCHEMA });
  return writeAtomic(file, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * El mensaje y el código de salida que un comando usa cuando el estado no sirve.
 * @param {string|{status:string, reason?:string, file?:string}} status — el `status` o el resultado entero de `read`
 */
function fail(status, extra = {}) {
  const r = typeof status === 'string' ? Object.assign({ status }, extra) : status;
  const file = r.file || paths(extra.home || os.homedir()).file;
  const why = r.reason ? `: ${r.reason}` : '';
  switch (r.status) {
    case 'missing':
      return { code: 3, line: 'harness.js: no instalado: harness.js install (primera instalación desde un clon)' };
    case 'unsupported_schema':
      return { code: 2, line: `harness.js: el estado ${file} es de una versión más nueva${why}` };
    case 'tree_missing':
      return { code: 2, line: `harness.js: el estado ${file} apunta a un árbol que no está${why} (link --managed, o install desde otro clon)` };
    case 'broken':
      return { code: 2, line: `harness.js: el estado ${file} no se puede leer${why} — un estado ilegible no se lee como «sin instalar»: arreglalo, o borralo y volvé a correr install` };
    default:
      return { code: 0, line: '' };
  }
}

module.exports = {
  SCHEMA, FILE_NAME, SOURCE_VALUES, KINDS, TREE_SOURCE, LAYER_SOURCE,
  paths, defaults, read, write, writeAtomic, fail, kindOf, layerSources, releaseSource, isRelease,
};
