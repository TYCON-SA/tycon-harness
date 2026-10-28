'use strict';
// shared.js — las piezas COMPARTIDAS: las que hace quien corra, el aplicador suelto o `harness.js`.
//
// Tres cosas que tienen que quedar escritas igual desde `install-tycon-hooks.sh` y desde Windows (`.ps1`):
//   · `cleanupPeriodDays: 365` en settings.json        (bloque `TOP_CANONICAL` del `.sh`)
//   · `env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1"`  (bloque `ENV_CANONICAL`)
//   · la copia de `<árbol>/commands/*.md` a `~/.claude/commands/`  (bloque «Los comandos de barra del equipo»)
// El porqué de cada valor está en esos bloques del `.sh`: las dos listas tienen que decir lo mismo, y lo cuida
// scripts/tests/installer-shared-pieces.test.sh comparando byte a byte contra el instalador real.
//
// Acá viven en Node para que `harness.js` las haga en los dos sistemas cuando lanza el aplicador. Quien las hace las
// ANOTA: `applyShared` devuelve la lista con la forma del reporte del aplicador (`{ kind, where, id }`, y `value` en un
// ajuste), para que entren al registro (`managed`) con la misma clave que si las hubiera reportado el `.sh`. Son una
// tercera clase de pieza, «shared»: no son del aplicador (su reporte no las trae cuando las hizo `harness.js`) ni propias
// de `harness.js` (no las repone `install` sino `apply`, y se caen del registro si dejan de estar con su valor).
//
// Las reglas, idénticas a las del `.sh`:
//   · Si el dev ya fijó OTRO valor (o la clave está, valga lo que valga), gana él: no se pisa y no se anota.
//   · `TYCON_NO_COMMANDS_SYNC=1` apaga la copia de comandos (ni carpeta, ni piezas).
//   · Idempotente: si no falta nada, settings.json no se reescribe — ni un byte, ni un `.bak`.
//   · Un settings.json que no existe, vacío o con sólo espacios es `{}`. Uno ilegible, o que no es un objeto (o cuyo
//     `env` no lo es), NO se pisa: se dice y se vuelve sin escribir NADA (tampoco los comandos), como el `.sh`, que
//     ahí se cae antes de llegar a ellos.
//   · El archivo queda como lo deja el python del aplicador: `json.dump(indent=2, ensure_ascii=False)` más un salto
//     final, y las claves en su orden de inserción (`hooks` si faltaba, las de raíz, `env`). Por eso `hooks: {}` se
//     crea acá también: así el resultado es el mismo se llame a esto antes o después del aplicador.
//   · La copia previa: suelto, `settings.json.bak.<ts>` como siempre; con la copia del mecanismo ya tomada
//     (`TYCON_HARNESS_SNAPSHOT_DIR`, o `backup: false`), ninguna.
//
// Lo que NO iguala al python (viene de `JSON.stringify`, igual que startup-line.js y remove.js): un número escrito con
// decimales o exponente (`1.0`, `1e3`) sale como entero; un entero de más de 2^53 pierde dígitos; una clave que es un
// entero (`"1"`) pasa adelante de las demás. Ninguno aparece en un settings.json de Claude Code. Y dos entradas que el
// python no trata igual: con un BOM delante él se cae y esto lo lee (y lo conserva); un `NaN` él lo acepta y acá es
// «ilegible» (no se toca).
//
// La señal al aplicador: `DONE_ENV` es el nombre de la variable que pone un `harness.js` que YA hizo las piezas (el `.sh`
// la ve y saltea sus tres bloques). Un programa viejo no la pone y el `.sh` las sigue haciendo: por eso es una variable
// propia y no un tercer significado de `TYCON_HARNESS_LOCK_HELD`.
//
// Nunca tira: un fallo va en `ok: false` con su `reason`. Sólo módulos de Node (corre desde la copia fija). Funciones
// puras respecto del HOME: reciben `home`/`env`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const PD = require('./plugin-dirs.js');   // la carpeta de los mods del arnés en CLAUDE_CODE_PLUGIN_DIRS
const RP = require('./read-permissions.js');   // las reglas de lectura de las carpetas del arnés

/** La clase de estas piezas: el `when` de la lista declarada (scripts/tests/fixtures/harness-managed-pieces.json). */
const ORIGIN = 'shared';
/** La variable con que un `harness.js` que ya hizo las piezas se lo avisa al aplicador (`=1`). */
const DONE_ENV = 'TYCON_HARNESS_SHARED_DONE';
/** El interruptor de la copia de comandos (el mismo del `.sh`). */
const NO_COMMANDS_ENV = 'TYCON_NO_COMMANDS_SYNC';

/** Las claves de raíz y las variables de `env` canónicas: las mismas de `TOP_CANONICAL` y `ENV_CANONICAL` del `.sh`. */
const TOP_CANONICAL = { cleanupPeriodDays: 365 };
const ENV_CANONICAL = { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' };

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const readBytes = (file) => { try { return fs.readFileSync(file); } catch (_) { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const pieceKey = (p) => `${p.kind}\u0000${p.where}\u0000${p.id}`;

function settingsFile(home, env) {
  return path.resolve(env.TYCON_SETTINGS_PATH || path.join(home, '.claude', 'settings.json'));
}

/** El sello de las copias `.bak`: el del python del aplicador (`%Y-%m-%dT%H-%M-%S`, hora local). */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
/** Copia `file` a `<file>.bak.<sello>` sin pisar nunca otra copia: el sello es al segundo, y la línea de arranque puede
 *  haber copiado el mismo archivo en ese segundo; con el nombre ocupado suma `-1`, `-2`… Devuelve la ruta. */
function backupCopy(file) {
  const base = `${file}.bak.${stamp()}`;
  for (let n = 0; ; n++) {
    const p = n ? `${base}-${n}` : base;
    try { fs.copyFileSync(file, p, fs.constants.COPYFILE_EXCL); return p; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

/** Los códigos de «el archivo está ocupado» (Windows: otro proceso lo tiene abierto — un antivirus, Claude Code leyéndolo). */
const BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
/** Espera bloqueante corta, la misma de state.js (este módulo es síncrono de punta a punta). */
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin SharedArrayBuffer: sin espera */ } };

/**
 * Escritura atómica (temporal al lado + rename), con los permisos dados. Si el reemplazo falla por «ocupado», tres
 * intentos ESPERANDO entre uno y otro (50 y 100 ms, el criterio de state.js): sin la espera los tres pasan en
 * microsegundos, antes de que el otro proceso suelte el archivo. Otro código no se reintenta. Si no pudo —el reemplazo, o
 * antes la escritura del temporal (disco lleno)—, tira, y el temporal no queda tirado; si tampoco pudo borrarlo (lo
 * retiene el mismo programa), el error lleva su ruta en `leftover` para que quien llama la nombre.
 */
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const drop = (err) => {
    // el temporal hereda los permisos del archivo: si era de sólo lectura, en Windows no se deja borrar sin abrirlo antes
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* si no se pudo (o no llegó a existir), el rm de abajo lo intenta igual */ }
    try { fs.rmSync(tmp, { force: true }); } catch (_) { if (err && typeof err === 'object') err.leftover = tmp; }
    return err;
  };
  try { fs.writeFileSync(tmp, text, { encoding: 'utf8', mode }); } catch (e) { throw drop(e); }
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      last = e;
      if (!(e && BUSY_CODES.includes(e.code)) || attempt === 3) break;
      nap(50 * attempt);
    }
  }
  throw drop(last);
}

/**
 * Las dos claves de settings.json. Devuelve `{ ok, pieces, changed, notes, reason }`; con `ok: false` no escribió nada.
 */
function applySettings(file, { withBackup, home = os.homedir(), platform = process.platform, mods = true, inherited = undefined, canon = true, reads = false, tree = null, previous = [] }) {
  const out = { ok: true, pieces: [], changed: [], notes: [], reason: null };
  const fail = (reason) => Object.assign(out, { ok: false, pieces: [], changed: [], reason });
  let raw = null;
  let mode = 0o600;   // un archivo nuevo nace como lo deja el python del aplicador (su temporal es 600)
  try {
    raw = fs.readFileSync(file, 'utf8');
    mode = fs.statSync(file).mode & 0o777;   // uno que ya está conserva sus permisos: nunca se abren
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) return fail(`no pude leer ${file} (${(e && e.code) || e.message}): no lo toco`);
    raw = null;
  }
  // un BOM delante (Windows) no lo hace ilegible, y se conserva al escribir
  const bom = raw !== null && raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const body = raw === null ? '' : raw.slice(bom.length);
  let s;
  if (body.trim() === '') s = {};
  else {
    try { s = JSON.parse(body); } catch (e) { return fail(`${file} ilegible (${e.message}): no lo toco`); }
  }
  if (!isObject(s)) return fail(`${file} no es un objeto JSON: no lo toco`);
  if (has(s, 'env') && !isObject(s.env)) return fail(`«env» de ${file} no es un objeto: no lo toco`);

  // `canon: false` (perfil mínimo): ni las claves de raíz, ni la variable, ni la carpeta de los mods
  const needTop = canon ? Object.keys(TOP_CANONICAL).filter((k) => !has(s, k)) : [];
  const needEnv = canon ? Object.keys(ENV_CANONICAL).filter((k) => !has(s, 'env') || !has(s.env, k)) : [];
  // la carpeta de los mods del arnés se SUMA a la variable: las carpetas del dev quedan
  const sep = PD.separator(platform);
  const modsDir = PD.ourDir(home);
  // con TYCON_NO_MODS=1 (`mods: false`) no se toca la variable ni se anota la pieza
  const dirs = canon && mods ? PD.addDir(has(s, 'env') ? s.env[PD.PLUGIN_DIRS_KEY] : undefined, modsDir, { sep, home, inherited }) : { changed: false, dropped: [] };
  for (const d of dirs.dropped) out.notes.push(`saqué ${d} de env.${PD.PLUGIN_DIRS_KEY} en ${file}: es el cartel viejo y esa carpeta ya no existe (ahora viene con el arnés)`);
  // las reglas de lectura del arnés: en los dos perfiles; una lista con otra forma no se toca y se dice
  const skipped = [];
  const rules = reads ? RP.ourRules({ home, tree, platform, skipped }) : [];
  if (skipped.length) out.notes.push(`no permití leer sin preguntar ${skipped.join(', ')}: la ruta trae un carácter que el permiso leería como comodín; esas lecturas siguen preguntando`);
  const rp = reads ? RP.apply(s, rules, { previous }) : { ok: true, added: [], dropped: [], ours: [] };
  if (!rp.ok) out.notes.push(`${rp.reason} en ${file}: no lo toco, y el recorrido puede frenar con «Allow this read?» al leer el arnés`);
  out.notes.push(...RP.notes(rp, file));
  const readsChanged = rp.added.length > 0 || rp.dropped.length > 0;
  if (needTop.length || needEnv.length || dirs.changed || readsChanged) {
    // el orden de inserción del python del aplicador: `hooks` (su setdefault), las claves de raíz, `env`
    const canonChanged = needTop.length || needEnv.length || dirs.changed;
    if (canonChanged && !has(s, 'hooks')) s.hooks = {};
    for (const k of needTop) s[k] = TOP_CANONICAL[k];
    if (canonChanged && !has(s, 'env')) s.env = {};
    for (const k of needEnv) s.env[k] = ENV_CANONICAL[k];
    if (dirs.changed) s.env[PD.PLUGIN_DIRS_KEY] = dirs.value;
    let bak = null;
    try {
      if (withBackup && raw !== null) bak = backupCopy(file);
      writeAtomic(file, `${bom}${JSON.stringify(s, null, 2)}\n`, mode);
    } catch (e) {
      // la escritura no ocurrió: la copia que se tomó para ella sobra (si no, cada arranque ocupado dejaría un .bak)
      // y lo que no se pudo borrar queda en ~/.claude: se nombra, para que no se junte sin que nadie lo sepa
      const left = e && e.leftover ? [e.leftover] : [];
      if (bak) { try { fs.rmSync(bak, { force: true }); } catch (_) { left.push(bak); } }
      const kept = left.length ? `; no pude borrar ${left.join(' ni ')}: borralo a mano` : '';
      return fail(`no pude escribir ${file} (${(e && e.code) || e.message}): las claves del arnés no se agregaron${kept}`);
    }
    out.changed.push(...needTop, ...needEnv.map((k) => `env.${k}`), ...(dirs.changed ? [PD.PLUGIN_DIRS_ID] : []), ...rp.added.map(RP.pieceId));
  }
  // las reglas que quedan y son del arnés: una pieza cada una (la que ya tenía el dev no: es suya)
  for (const r of rp.ours) out.pieces.push({ kind: 'setting', where: file, id: RP.pieceId(r), value: r });
  if (!canon) return out;
  // del arnés sólo con SU valor (si el dev fijó otro, es suya y no se anota); el `value` va al registro para que doctor
  // vea si lo cambia después
  const env = isObject(s.env) ? s.env : {};
  for (const [k, v] of Object.entries(TOP_CANONICAL)) {
    if (s[k] === v) out.pieces.push({ kind: 'setting', where: file, id: k, value: v });
    else out.notes.push(`${k} ya vale ${JSON.stringify(s[k])} en ${file}: lo fijaste vos, gana tu valor (el arnés usa ${JSON.stringify(v)})`);
  }
  for (const [k, v] of Object.entries(ENV_CANONICAL)) {
    if (env[k] === v) out.pieces.push({ kind: 'setting', where: file, id: `env.${k}`, value: v });
    else out.notes.push(`env.${k} ya vale ${JSON.stringify(env[k])} en ${file}: lo fijaste vos, gana tu valor (el arnés usa ${JSON.stringify(v)})`);
  }
  // la carpeta de los mods: la pieza es la carpeta (un elemento de la lista), no el valor entero de la variable
  if (mods && PD.hasDir(env[PD.PLUGIN_DIRS_KEY], modsDir, { sep, home })) out.pieces.push({ kind: 'setting', where: file, id: PD.PLUGIN_DIRS_ID, value: modsDir });
  return out;
}

/**
 * Los comandos de barra: cada `<árbol>/commands/*.md` (sólo archivos de la raíz, no ocultos) a `~/.claude/commands/`,
 * si cambió. No toca los comandos propios del dev. Se anota sólo el que quedó igual al del árbol.
 */
function applyCommands({ home, env, tree }) {
  const out = { pieces: [], changed: [], notes: [] };
  if (env[NO_COMMANDS_ENV] === '1') { out.notes.push(`${NO_COMMANDS_ENV}=1: los comandos de barra no se copian`); return out; }
  const src = path.join(tree, 'commands');
  if (!isDir(src)) return out;
  const dstDir = path.join(home, '.claude', 'commands');
  try { fs.mkdirSync(dstDir, { recursive: true }); } catch (_) { /* si no se pudo, cada copia de abajo lo dice */ }
  let names = [];
  try { names = fs.readdirSync(src).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(); } catch (_) { names = []; }
  for (const name of names) {
    const from = path.join(src, name);
    if (!isFile(from)) continue;
    const want = readBytes(from);
    if (want === null) continue;
    const to = path.join(dstDir, name);
    let have = readBytes(to);
    if (have === null || !have.equals(want)) {
      try { fs.copyFileSync(from, to); out.changed.push(`command:${name}`); } catch (e) {
        out.notes.push(`no pude copiar el comando ${name} a ${to} (${(e && e.code) || e.message}): no se anota`);
      }
      have = readBytes(to);
    }
    if (have !== null && have.equals(want)) out.pieces.push({ kind: 'command', where: path.resolve(to), id: name });
  }
  return out;
}

/**
 * Hace las tres piezas compartidas y devuelve las que quedan en la máquina y son del arnés (las que escribió esta
 * corrida y las que ya estaban con su valor), con la forma del reporte del aplicador.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.home]    la HOME (por defecto, la del proceso)
 * @param {object}   [opts.env]     el ambiente: `TYCON_SETTINGS_PATH`, `TYCON_NO_COMMANDS_SYNC`, `TYCON_HARNESS_SNAPSHOT_DIR`
 * @param {string}   [opts.tree]    el árbol del arnés (de ahí salen los comandos); por defecto, el lugar (`place.js`: primero el lugar, después el nombre viejo)
 * @param {boolean}  [opts.backup]  la copia `settings.json.bak.<ts>` antes de escribir; por defecto, sí salvo que
 *                                  `TYCON_HARNESS_SNAPSHOT_DIR` esté puesta (el mecanismo ya tomó la suya)
 * @param {function} [opts.log]     recibe cada nota, una línea por vez
 * @returns {{ ok: boolean, origin: 'shared', pieces: {kind: string, where: string, id: string, value?: any}[],
 *            changed: string[], notes: string[], reason: string|null }}
 *   `pieces`: lo que va al registro. `changed`: lo que escribió ESTA corrida (`cleanupPeriodDays`, `env.<VAR>`,
 *   `command:<archivo>`). `ok: false` (con `reason`): settings.json no se pudo leer o escribir y no se hizo nada.
 */
function applyShared({ home = os.homedir(), env = process.env, tree = null, backup, log = null, settings = true, platform = process.platform, previous = [], reads: withReads = true } = {}) {
  const out = { ok: true, origin: ORIGIN, pieces: [], changed: [], notes: [], reason: null };
  const say = (line) => { try { if (log) log(line); } catch (_) { /* el registro nunca frena */ } };
  try {
    const withBackup = backup === undefined ? !env.TYCON_HARNESS_SNAPSHOT_DIR : Boolean(backup);
    const P = require('./place.js');
    const where = tree || P.resolvePlace({ home }).dir || P.placePath(home);
    // `settings: false`: fuera del perfil full los dos ajustes no se escriben ni se anotan; los
    // comandos sí (están en los dos perfiles). Si estaban, los saca el cambio de perfil de harness.js, con su copia.
    // Las reglas de lectura del arnés van en los dos perfiles; `TYCON_NO_READ_PERMISSIONS=1` las apaga.
    // `previous`: las piezas del registro, para sacar una regla anotada que ya no es del arnés.
    const canon = settings !== false;
    // `reads: false` (harness.js antes del aplicador): las suma `applyReadRules` después, con los enlaces ya hechos
    const reads = withReads && env[RP.OFF_ENV] !== '1';
    const s = !canon && !reads ? { ok: true, pieces: [], changed: [], notes: [], reason: null } : applySettings(settingsFile(home, env), { withBackup, home, platform, mods: env.TYCON_NO_MODS !== '1', inherited: env[PD.PLUGIN_DIRS_KEY], canon, reads, tree: where, previous });
    out.notes.push(...s.notes);
    if (!s.ok && canon) {
      out.ok = false; out.reason = s.reason;
      say(`piezas compartidas: ${s.reason}`);
      return out;
    }
    // en el perfil mínimo sólo estaban las reglas de lectura: si settings.json no se pudo tocar se dice y se sigue (los
    // comandos no dependen de él)
    if (!s.ok) out.notes.push(`${s.reason} (el permiso de lectura del arnés no se sumó)`);
    const c = applyCommands({ home, env, tree: where });
    out.pieces.push(...s.pieces, ...c.pieces);
    out.changed.push(...s.changed, ...c.changed);
    out.notes.push(...c.notes);
  } catch (e) {
    out.ok = false; out.reason = `las piezas compartidas no se pudieron hacer (${(e && e.code) || (e && e.message) || e})`;
    out.pieces = [];
  }
  for (const n of out.notes) say(`piezas compartidas: ${n}`);
  if (out.changed.length) say(`piezas compartidas: ${out.changed.join(', ')}`);
  return out;
}

/**
 * Sólo las reglas de lectura de las carpetas del arnés, con la misma forma de resultado que `applyShared`.
 * `harness.js` la llama después del aplicador, que crea los enlaces de ~/.claude que las reglas cubren. Nunca tira.
 */
function applyReadRules({ home = os.homedir(), env = process.env, tree = null, backup, log = null, platform = process.platform, previous = [] } = {}) {
  const out = { ok: true, origin: ORIGIN, pieces: [], changed: [], notes: [], reason: null };
  const say = (line) => { try { if (log) log(line); } catch (_) { /* el registro nunca frena */ } };
  if (env[RP.OFF_ENV] === '1') { out.notes.push(`${RP.OFF_ENV}=1: no se suman permisos de lectura`); say(`piezas compartidas: ${out.notes[0]}`); return out; }
  try {
    const withBackup = backup === undefined ? !env.TYCON_HARNESS_SNAPSHOT_DIR : Boolean(backup);
    const P = require('./place.js');
    const where = tree || P.resolvePlace({ home }).dir || P.placePath(home);
    const s = applySettings(settingsFile(home, env), { withBackup, home, platform, canon: false, reads: true, tree: where, previous });
    Object.assign(out, { ok: s.ok, reason: s.reason, pieces: s.pieces, changed: s.changed, notes: s.notes });
  } catch (e) {
    Object.assign(out, { ok: false, pieces: [], reason: `las reglas de lectura no se pudieron sumar (${(e && e.code) || (e && e.message) || e})` });
  }
  for (const n of out.notes) say(`piezas compartidas: ${n}`);
  if (!out.ok) say(`piezas compartidas: ${out.reason}`);
  if (out.changed.length) say(`piezas compartidas: ${out.changed.join(', ')}`);
  return out;
}

/** ¿Es una pieza de esta clase? Los dos ajustes canónicos y todo `command` (sólo se registran los del árbol). */
function isShared(piece) {
  if (!isObject(piece) || typeof piece.id !== 'string') return false;
  if (piece.kind === 'command') return true;
  if (piece.kind !== 'setting') return false;
  if (piece.id === PD.PLUGIN_DIRS_ID || RP.isRuleId(piece.id)) return true;
  return has(TOP_CANONICAL, piece.id) || (piece.id.startsWith('env.') && has(ENV_CANONICAL, piece.id.slice(4)));
}

/**
 * El reporte del aplicador más las piezas compartidas, sin duplicados: una que el aplicador también reportó (uno viejo,
 * que no conoce `DONE_ENV`) queda una sola vez, la suya. `report` puede ser `null` (sin reporte).
 */
function union(report, pieces) {
  const out = Array.isArray(report) ? report.slice() : [];
  const seen = new Set(out.filter(isObject).map(pieceKey));
  for (const p of Array.isArray(pieces) ? pieces : []) {
    if (!isObject(p) || seen.has(pieceKey(p))) continue;
    seen.add(pieceKey(p));
    out.push(p);
  }
  return out;
}

module.exports = { ORIGIN, DONE_ENV, NO_COMMANDS_ENV, TOP_CANONICAL, ENV_CANONICAL, applyShared, applyReadRules, isShared, union };
