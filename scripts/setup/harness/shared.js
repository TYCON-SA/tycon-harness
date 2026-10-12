'use strict';
// shared.js — las piezas COMPARTIDAS: las que hace quien corra, el aplicador suelto o `harness.js` (story 8.13, tanda D ·
// AC 28).
//
// Tres cosas las escribía sólo `install-tycon-hooks.sh`, y en Windows (`.ps1`) no las hacía nadie:
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
//     (`TYCON_HARNESS_SNAPSHOT_DIR`, o `backup: false`), ninguna (AC 18).
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
function applySettings(file, { withBackup }) {
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

  const needTop = Object.keys(TOP_CANONICAL).filter((k) => !has(s, k));
  const needEnv = Object.keys(ENV_CANONICAL).filter((k) => !has(s, 'env') || !has(s.env, k));
  if (needTop.length || needEnv.length) {
    // el orden de inserción del python del aplicador: `hooks` (su setdefault), las claves de raíz, `env`
    if (!has(s, 'hooks')) s.hooks = {};
    for (const k of needTop) s[k] = TOP_CANONICAL[k];
    if (!has(s, 'env')) s.env = {};
    for (const k of needEnv) s.env[k] = ENV_CANONICAL[k];
    let bak = null;
    try {
      if (withBackup && raw !== null) { bak = `${file}.bak.${stamp()}`; fs.copyFileSync(file, bak); }
      writeAtomic(file, `${bom}${JSON.stringify(s, null, 2)}\n`, mode);
    } catch (e) {
      // la escritura no ocurrió: la copia que se tomó para ella sobra (si no, cada arranque ocupado dejaría un .bak)
      // y lo que no se pudo borrar queda en ~/.claude: se nombra, para que no se junte sin que nadie lo sepa
      const left = e && e.leftover ? [e.leftover] : [];
      if (bak) { try { fs.rmSync(bak, { force: true }); } catch (_) { left.push(bak); } }
      const kept = left.length ? `; no pude borrar ${left.join(' ni ')}: borralo a mano` : '';
      return fail(`no pude escribir ${file} (${(e && e.code) || e.message}): las claves del arnés no se agregaron${kept}`);
    }
    out.changed.push(...needTop, ...needEnv.map((k) => `env.${k}`));
  }
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
function applyShared({ home = os.homedir(), env = process.env, tree = null, backup, log = null, settings = true } = {}) {
  const out = { ok: true, origin: ORIGIN, pieces: [], changed: [], notes: [], reason: null };
  const say = (line) => { try { if (log) log(line); } catch (_) { /* el registro nunca frena */ } };
  try {
    const withBackup = backup === undefined ? !env.TYCON_HARNESS_SNAPSHOT_DIR : Boolean(backup);
    // `settings: false` (story 8.16, tanda C): fuera del perfil full los dos ajustes no se escriben ni se anotan; los
    // comandos sí (están en los dos perfiles). Si estaban, los saca el cambio de perfil de harness.js, con su copia.
    const s = settings === false ? { ok: true, pieces: [], changed: [], notes: [], reason: null } : applySettings(settingsFile(home, env), { withBackup });
    out.notes.push(...s.notes);
    if (!s.ok) {
      out.ok = false; out.reason = s.reason;
      say(`piezas compartidas: ${s.reason}`);
      return out;
    }
    const P = require('./place.js');
    const c = applyCommands({ home, env, tree: tree || P.resolvePlace({ home }).dir || P.placePath(home) });
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

/** ¿Es una pieza de esta clase? Los dos ajustes canónicos y todo `command` (sólo se registran los del árbol). */
function isShared(piece) {
  if (!isObject(piece) || typeof piece.id !== 'string') return false;
  if (piece.kind === 'command') return true;
  if (piece.kind !== 'setting') return false;
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

module.exports = { ORIGIN, DONE_ENV, NO_COMMANDS_ENV, TOP_CANONICAL, ENV_CANONICAL, applyShared, isShared, union };
