#!/usr/bin/env node
'use strict';
// instinct-dirs.js — dónde viven las propuestas del grabador de aprendizajes: la única pieza que lo sabe (story 8.27).
//
// ── EL CASO (2026-10-09) ──────────────────────────────────────────────────────────────────────────────────────────
// El observador, el disparador del arranque y el comando de revisión armaban cada uno `<árbol>/inbox/instincts` y
// creaban la carpeta antes de mirar nada, también por listar o por ensayar. En un árbol que no la trae —una versión
// bajada, la copia pública— eso deja una carpeta que nadie le trajo: una prueba que mide «nadie escribe en el árbol»
// fallaba siempre a la primera sobre la copia, y en un arnés instalado lo escrito se pierde cuando la actualización
// reemplaza el árbol. Decisión del dueño: en un arnés instalado se escribe en la casa de la persona; en un clon de
// mantenedor, como siempre. Quien lee, encuentra las propuestas en los dos lugares.
//
// ── EL CASO (2026-10-15) ──────────────────────────────────────────────────────────────────────────────────────────
// En la máquina del mantenedor el arnés instalado no trae buzón, y el clon que declara mantener (`paths.maintained`, el
// público) tampoco: las propuestas iban a la casa, fuera de git y sin llegar a su otra máquina, aunque el clon del repo
// privado (`paths.maintainers`) trae el buzón versionado. Ahora ese clon cuenta: ahí se escribe y de ahí se lee.
//
// ── LA REGLA ──────────────────────────────────────────────────────────────────────────────────────────────────────
//   · El árbol TRAE su buzón si existe el archivo `inbox/instincts/README.md`. Lo versiona el repo de mantenimiento y
//     ningún guion lo crea. «La carpeta existe» no alcanza: una versión anterior ya la creó donde no la traían.
//   · Se ESCRIBE en el buzón del árbol si lo trae; si no, en el del clon del repo privado de mantenimiento que la máquina
//     declara (`paths.maintainers`), si ese clon trae el suyo; si no, en la casa de la persona: `<estado>/inbox/instincts`, con
//     `<estado>` contestado por scripts/setup/harness/tycon-home.js. Una carpeta de estado sin estado adentro (el resto
//     de una instalación cortada, que la instalación siguiente barre) no cuenta: se usa la de siempre.
//   · Se LEE en todos los lugares donde puede haber propuestas, sin repetir (se compara por ruta real): donde se
//     escribe, el buzón del clon privado (después del árbol, antes de la casa), el buzón del árbol si quedó una carpeta,
//     la casa de cada carpeta de estado que exista, y el buzón del clon que la máquina declara que mantiene
//     (`paths.maintained`), si ese clon trae el suyo.
//   · Un buzón del clon privado que no se deja mirar NO es «no lo trae»: `writePlace()` tira `InstinctDirsError` (nunca
//     se cae, callado, a la casa); `readPlaces()` no lo suma y sigue con la casa (lo de ahí se sigue viendo), y
//     `readNotes()` lo dice.
//   · Con la configuración de la máquina ilegible no se sabe si declara el clon privado: se escribe en la casa, como
//     antes, y `readNotes()` lo dice (frenar dejaría sin grabador a cualquier máquina con la configuración rota).
//   · Nada de acá crea una carpeta por contestar. La única función que crea es `prepareLog()`, para el disparador.
//   · Si tycon-home.js no está o no carga y el árbol no trae buzón, se tira `InstinctDirsError`: nadie cae al árbol.
//
// Responde por SU árbol (dos niveles arriba de este archivo) y por la carpeta de usuario del proceso (`os.homedir()` y
// el ambiente): quien quiera otra, corre la pieza desde ese árbol con ese ambiente — así lo hacen sus pruebas.
//
// A mano:  node scripts/instincts/instinct-dirs.js            → los lugares, el de escritura marcado
//          node scripts/instincts/instinct-dirs.js --json     → lo mismo, para otra pieza
//          node scripts/instincts/instinct-dirs.js --prepare-log   → crea el lugar de escritura y su registro vacío e
//                                                               imprime la ruta (con «/», un salto simple); error: sale 1
// Pruebas: scripts/tests/instinct-dirs.test.js · scripts/tests/instinct-outside-tree.test.sh
const fs = require('fs');
const os = require('os');
const path = require('path');

const TREE = path.resolve(__dirname, '..', '..');
const SUBDIRS = Object.freeze(['pending', 'promoted', 'archived', 'drafts', 'descartados']);
const LOG_NAME = 'observer.log';
const MARKER = 'README.md';
const HOME_LIB = path.join(TREE, 'scripts', 'setup', 'harness', 'tycon-home.js');

class InstinctDirsError extends Error {
  constructor(message) { super(message); this.name = 'InstinctDirsError'; }
}

const inboxOf = (base) => path.join(base, 'inbox', 'instincts');
/** «No existe» (o un pedazo de la ruta no es una carpeta) — lo único que se puede leer como «no hay». */
const missing = (e) => Boolean(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
/** Qué hay en `p`: 'dir', 'none' (no existe, o no es una carpeta) o, si no se pudo mirar, el código del error. */
const kindOf = (p) => { try { return fs.statSync(p).isDirectory() ? 'dir' : 'none'; } catch (e) { return missing(e) ? 'none' : String((e && e.code) || 'error'); } };
const isDir = (p) => kindOf(p) === 'dir';

/**
 * ¿El buzón `inbox` tiene su señal? `true`/`false` si se pudo mirar; si NO se pudo (permisos, disco), tira el error:
 * «no pude mirar» no es «no la trae» — con esa confusión un clon con la carpeta sin permisos escribiría, callado, en
 * la carpeta de usuario.
 */
function hasMarker(inbox) {
  try { return fs.statSync(path.join(inbox, MARKER)).isFile(); } catch (e) { if (missing(e)) return false; throw e; }
}

/** El buzón de un árbol, exista o no. */
function treeInbox() { return inboxOf(TREE); }
/** ¿Este árbol trae su buzón? (la señal es el archivo que versiona el repo de mantenimiento) */
function treeBringsInbox() {
  try { return hasMarker(treeInbox()); } catch (e) {
    throw new InstinctDirsError(`no puedo saber si este árbol trae su buzón: no pude mirar ${path.join(treeInbox(), MARKER)} (${e.code || e.message})`);
  }
}

/**
 * Los nombres de una carpeta de propuestas. Si no existe, ninguno. Si existe y NO se pudo leer (permisos, disco),
 * ninguno también, pero se AVISA por `warn`: una carpeta ilegible nunca se muestra, callada, como una vacía.
 */
function listDir(dir, warn) {
  try { return fs.readdirSync(dir); } catch (e) {
    if (!missing(e) && typeof warn === 'function') warn(`no pude leer ${shown(dir)} (${(e && e.code) || e}): lo que haya ahí no se cuenta`);
    return [];
  }
}

/** tycon-home.js del propio árbol. Tira `InstinctDirsError` si no está o no carga: sin él no se sabe dónde es la casa. */
function homeLib() {
  if (!fs.existsSync(HOME_LIB)) throw new InstinctDirsError(`no puedo saber dónde guardar las propuestas: falta ${HOME_LIB} (tycon-home.js, la pieza que dice dónde vive el estado) y este árbol no trae su buzón`);
  try { return require(HOME_LIB); } catch (e) {
    throw new InstinctDirsError(`no puedo saber dónde guardar las propuestas: ${HOME_LIB} (tycon-home.js) no carga (${String((e && e.message) || e).split('\n')[0]}) y este árbol no trae su buzón`);
  }
}

/** La casa de la persona: `<estado>/inbox/instincts`. No crea nada. */
function personInbox() {
  const TH = homeLib();
  const home = os.homedir();
  // una carpeta de estado propia sin estado adentro la barre la instalación siguiente: lo escrito ahí se perdería
  const state = TH.ownHomeStale(home) ? TH.legacyStateDir(home) : TH.stateDir(home);
  return inboxOf(state);
}

/**
 * El buzón del clon del repo privado de mantenimiento (`paths.maintainers`) si la máquina lo declara y trae su buzón;
 * si no, null. Si el buzón está y no se deja mirar, tira el error de `hasMarker` (quien llama decide). No crea nada.
 */
function maintainersInbox(TH) {
  const c = TH.maintainersClone();
  if (!c.declared || c.problem) return null;
  return hasMarker(inboxOf(c.path)) ? inboxOf(c.path) : null;
}

/** Igual que `maintainersInbox`, pero lo que no se pudo mirar es `InstinctDirsError`: para decidir dónde se escribe. */
function maintainersInboxOrThrow(TH) {
  try { return maintainersInbox(TH); } catch (e) {
    throw new InstinctDirsError(`no puedo saber si el clon del repo de mantenimiento trae su buzón: no pude mirar ${path.join(inboxOf(TH.maintainersClone().path), MARKER)} (${(e && e.code) || e})`);
  }
}

/** Dónde se escribe: el buzón del árbol si lo trae; si no, el del clon privado si lo trae; si no, la casa. No crea nada. */
function writePlace() {
  if (treeBringsInbox()) return treeInbox();
  return maintainersInboxOrThrow(homeLib()) || personInbox();
}

/** La ruta real de `p`; si todavía no existe, la de su primer ancestro que sí, más lo que falta. */
function realKey(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); } catch (_) { /* sube un nivel */ }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...tail);
    tail.unshift(path.basename(cur));
    cur = up;
  }
}

/**
 * Los lugares donde puede haber propuestas, el de escritura primero y ninguno repetido. No crea nada. En un árbol sin
 * buzón tira `InstinctDirsError` si no se puede resolver la casa; en uno con buzón, esa falla deja sólo el del árbol.
 * Si el buzón del clon privado no se deja mirar, el primero es la casa aunque `writePlace()` tire: quien marca el lugar
 * de escritura lo pregunta a `writePlace()`.
 */
function readPlaces() {
  const out = [];
  const seen = new Set();
  const add = (p) => { const k = realKey(p); if (!seen.has(k)) { seen.add(k); out.push(p); } };
  let TH;
  if (treeBringsInbox()) {
    add(treeInbox());
    try { TH = homeLib(); } catch (_) { return out; }
    // el clon privado, después del árbol: si no se puede mirar, no se suma (lo dice `readNotes()`)
    let m = null;
    try { m = maintainersInbox(TH); } catch (_) { m = null; }
    if (m) add(m);
  } else {
    TH = homeLib();
    // el clon privado que no se deja mirar no frena la lectura: lo de la casa se sigue viendo (lo dice `readNotes()`)
    let m = null;
    try { m = maintainersInbox(TH); } catch (_) { m = null; }
    add(m || personInbox());
    if (isDir(treeInbox())) add(treeInbox());   // lo que dejó una versión anterior: se lee, no se escribe
  }
  const home = os.homedir();
  // la casa de cada carpeta de estado que exista: si la casa cambió sin mudanza, lo de la otra se sigue viendo
  for (const state of [TH.ownStateDir(home), TH.legacyStateDir(home)]) if (isDir(inboxOf(state))) add(inboxOf(state));
  // el clon que la máquina declara que mantiene, si trae su buzón (el observador no escribe ahí: lo lee). Si no se
  // puede mirar, no se suma: lo dice `readNotes()`.
  const maintained = TH.maintainedPath();
  let brings = false;
  try { brings = Boolean(maintained) && hasMarker(inboxOf(maintained)); } catch (_) { brings = false; }
  if (brings) add(inboxOf(maintained));
  return out;
}

/**
 * Lo que `readPlaces()` no pudo sumar y por qué, en renglones para una persona. Sin esto, «no hay pendientes» se ve
 * igual si de verdad no hay que si un lugar entero quedó sin mirar. Vacío cuando todo se pudo leer. Nunca tira ni crea.
 */
function readNotes() {
  const out = [];
  let TH;
  try { TH = homeLib(); } catch (e) {
    // en un árbol sin buzón esto mismo frena todo (lo dice writePlace); con buzón se sigue, mirando sólo el árbol
    out.push(`no pude cargar tycon-home.js (${HOME_LIB}): sólo se mira el buzón de este árbol; lo que haya en la carpeta de usuario o en el clon que esta máquina mantiene no se ve`);
    return out;
  }
  // un lugar que existe y no se deja ni mirar (permisos) no entra a la lista: se dice, no se confunde con «no existe»
  const home = os.homedir();
  for (const p of [treeInbox(), inboxOf(TH.ownStateDir(home)), inboxOf(TH.legacyStateDir(home))]) {
    const k = kindOf(p);
    if (k !== 'dir' && k !== 'none') out.push(`no pude mirar ${shown(p)} (${k}): si hay propuestas ahí, no se ven`);
  }
  // el clon del repo privado de mantenimiento: si la máquina lo declara y no sirve, se dice (sin declararlo, nada)
  let privateBrings = false;
  const mc = TH.maintainersClone();
  if (mc.declared && mc.problem) out.push(`${mc.problem}: el buzón del clon del repo de mantenimiento no se lee`);
  else if (mc.declared) {
    try {
      privateBrings = hasMarker(inboxOf(mc.path));
      if (!privateBrings) out.push(`el clon del repo de mantenimiento que declara esta máquina (${mc.path}) no trae su buzón (${['inbox', 'instincts', MARKER].join('/')}): no se lee`);
    } catch (e) {
      out.push(`no pude mirar el buzón del clon del repo de mantenimiento (${inboxOf(mc.path)}: ${(e && e.code) || e}): no se lee`);
    }
  }
  // con la configuración ilegible no se sabe si declara el clon privado: si este árbol no trae buzón, lo nuevo va a la casa
  let toHome = false;
  try { toHome = !treeBringsInbox(); } catch (_) { toHome = false; }
  const privateUnknown = toHome ? ' (ni si declara el clon del repo de mantenimiento: lo nuevo se escribe en la casa)' : '';
  let cfg;
  try { cfg = TH.ownPaths().config; } catch (e) {
    out.push(`no pude saber dónde está la configuración de esta máquina (${String((e && e.message) || e).split('\n')[0]}): el clon que mantiene no se lee${privateUnknown}`);
    return out;
  }
  let raw;
  try { raw = fs.readFileSync(cfg, 'utf8'); } catch (e) {
    if (!missing(e)) out.push(`no pude leer ${cfg} (${(e && e.code) || e}): no sé qué clon mantiene esta máquina, y no se lee${privateUnknown}`);
    return out;
  }
  let declared;
  try { const j = JSON.parse(raw); declared = j && j.paths && j.paths.maintained; } catch (_) {
    out.push(`${cfg} no es JSON válido: no sé qué clon mantiene esta máquina, y no se lee${privateUnknown}`);
    return out;
  }
  if (typeof declared !== 'string' || !declared.trim()) return out;
  const maintained = TH.maintainedPath();
  if (!maintained) { out.push(`la configuración dice que esta máquina mantiene ${declared} y esa carpeta no existe (o no es una ruta completa): no se lee`); return out; }
  try {
    // con el buzón en el clon privado, que el clon mantenido no traiga el suyo no deja nada sin leer
    if (!hasMarker(inboxOf(maintained)) && !privateBrings) out.push(`el clon que esta máquina mantiene (${maintained}) no trae su buzón (${['inbox', 'instincts', MARKER].join('/')}): no se lee`);
  } catch (e) {
    out.push(`no pude mirar el buzón del clon que esta máquina mantiene (${inboxOf(maintained)}: ${(e && e.code) || e}): no se lee`);
  }
  return out;
}

/** Cómo se le muestra una carpeta a una persona: relativa al árbol (con «/») si está adentro; si no, entera. */
function shown(dir) {
  const rel = path.relative(TREE, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return dir;
}

/** Crea el lugar de escritura y su registro (vacío, si no existía) y devuelve la ruta del registro. */
function prepareLog() {
  const place = writePlace();
  fs.mkdirSync(place, { recursive: true });
  const log = path.join(place, LOG_NAME);
  fs.appendFileSync(log, '');
  return log;
}

/**
 * ¿La máquina instaló una versión bajada y no declara ni el clon que mantiene ni un clon privado con buzón? (lo dice
 * `status`: sólo se lee la casa; nunca tira)
 */
function releaseWithoutMaintained() {
  try {
    const TH = homeLib();
    if (!TH.isReleaseMachine(os.homedir()) || TH.maintainedPath()) return false;
    try { return !maintainersInbox(TH); } catch (_) { return false; }
  } catch (_) { return false; }
}

module.exports = {
  TREE, SUBDIRS, LOG_NAME, MARKER, InstinctDirsError,
  treeInbox, treeBringsInbox, personInbox, writePlace, readPlaces, readNotes, listDir, shown, prepareLog, releaseWithoutMaintained,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  // la ruta que lee el disparador (un guion de bash): con «/» y un salto simple, también en Windows
  const forShell = (p) => p.split(path.sep).join('/');
  try {
    if (args.includes('--prepare-log')) {
      process.stdout.write(`${forShell(prepareLog())}\n`);
    } else {
      const write = writePlace();
      const read = readPlaces();
      const notes = readNotes();
      // el lugar de escritura es el primero de la lista (la misma cadena); si no se sabe, ya salió por el error
      if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ tree: TREE, bringsInbox: treeBringsInbox(), write, read, notes })}\n`);
      else {
        read.forEach((p, i) => process.stdout.write(`${i === 0 ? '* ' : '  '}${p}${i === 0 ? '   (acá se escribe)' : ''}\n`));
        for (const n of notes) process.stdout.write(`! ${n}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`${e && e.name === 'InstinctDirsError' ? `InstinctDirsError: ${e.message}` : `instinct-dirs: ${(e && e.stack) || e}`}\n`);
    process.exit(1);
  }
}
