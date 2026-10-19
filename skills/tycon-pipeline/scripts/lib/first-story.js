#!/usr/bin/env node
'use strict';
/**
 * first-story.js — ¿es la primera historia de esta máquina?, y la oferta de la instalación completa al cerrarla.
 *
 * El lector (lo reusa la corrida de primera vez):
 *   · closedStories({ home, env }) → { status: 'ok' | 'no_medido', count, files, reason }: las corridas TERMINADAS del
 *     historial de la máquina (los volcados de `<estado>/timing-history/` con `storyId`, sin pasos pendientes y con
 *     pasos hechos). Una carpeta o un volcado que no se leen dan `no_medido`. Es la cuenta cruda: no alcanza para
 *     decidir.
 *   · isFirstStory({ home, env }) → { status: 'ok' | 'no_medido', first, count, reason }. «Primera» ⟺ status 'ok' y
 *     first true, y eso exige las tres cosas: (a) la instalación es nueva —el estado trae `first_install.fresh`, que el
 *     instalador escribe sólo al crear el estado de cero en una carpeta sin rastros del pipeline—; (b) ninguna corrida
 *     cerrada; (c) ningún registro de un cierre anterior (si lo hay y no quedan volcados, el historial se podó).
 *     Una máquina instalada antes de esta versión, una instalación no fresca, un estado ilegible o un historial podado
 *     dan `no_medido`: con `no_medido` nadie decide nada (ni el modo de primera vez, ni la oferta). Nunca lo infiere el
 *     modelo.
 *
 * La oferta (la llama `marker.js clear` después de archivar el volcado):
 *   · afterClose({ home, env, marker }) anota el primer cierre y, si éste fue la primera historia de una máquina nueva
 *     con la instalación mínima elegida y la oferta nunca se mostró, devuelve los renglones que el cierre imprime: un
 *     título, los tres renglones de `upgradeOffer` (contados desde la lista de efectos) y las dos órdenes para contestar.
 *     Sin persona delante (sesión no atendida del agente o integración continua) devuelve un solo renglón con la orden,
 *     sin pregunta. Mostrada una vez —en cualquiera de las dos formas— queda anotada y no vuelve.
 *   · `node first-story.js offer accept` corre `harness.js install --profile full --yes` del árbol instalado;
 *     `offer decline` lo anota; `offer show` vuelve a mostrar entera la oferta pendiente, sin contestarla (un cierre
 *     leído recortado no la pierde); `offer status` muestra el lector y el registro.
 *
 * El registro vive en `<estado>/first-story.json`: { first_close: { at, story }, offer: { status, at, story, code? } },
 * con `status` en offered · accepted · failed · declined · no_person.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stateDir } = require('./state-dir.js');

const TREE = path.resolve(__dirname, '..', '..', '..', '..');
const RECORD_FILE = 'first-story.json';
const LOCK_FILE = 'first-story.lock';
const STATE_FILE = 'harness-state.json';
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 5 * 1000;
const CI_VARS = Object.freeze(['CI', 'TF_BUILD', 'GITHUB_ACTIONS']);

const setupMod = (tree, name) => require(path.join(tree, 'scripts', 'setup', 'harness', `${name}.js`));
const recordPath = (home) => path.join(stateDir(home), RECORD_FILE);
const hasSetup = (tree) => Boolean(tree) && fs.existsSync(path.join(tree, 'scripts', 'setup', 'harness', 'state.js'));

/**
 * El árbol del arnés instalado: el que trae este archivo si es un árbol entero; si no (un clon de skills aparte, de las
 * máquinas en transición), el que nombra el estado de la instalación. Sin ninguno, null: nadie decide.
 */
function treeOf(home) {
  if (hasSetup(TREE)) return TREE;
  try {
    const st = readJson(path.join(stateDir(home), STATE_FILE));
    return st && typeof st.tree === 'string' && hasSetup(st.tree) ? st.tree : null;
  } catch (_) { return null; }
}

/**
 * La decisión de la oferta, de a un proceso por vez: dos cierres a la vez (dos sesiones) leían el registro vacío y la
 * mostraban los dos. Candado por creación exclusiva de un archivo (igual en Windows); uno de más de 30 s es de un
 * proceso que murió y se pisa: lo pisa uno solo, el que toma un segundo candado corto, y sólo si sigue siendo el mismo
 * viejo. Cada candado lleva una marca propia, y al soltarlo sólo se borra si sigue siendo el propio. Sin candado en 5 s,
 * null: no se decide en este cierre.
 */
function withLock(home, fn) {
  const lock = path.join(stateDir(home), LOCK_FILE);
  const steal = `${lock}.pisar`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const mine = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // lstat, no stat: un enlace roto en lugar del candado existe para la creación exclusiva y no tiene que leerse como «no está»
  const isOld = (f) => Date.now() - fs.lstatSync(f).mtimeMs > LOCK_STALE_MS;
  const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  const until = Date.now() + LOCK_WAIT_MS;
  // todo reintento pasa por el plazo y la espera: un error que se repite (permiso, archivo tomado en Windows) no hace girar
  // el cierre sin fin, se agota a los 5 s y no se decide
  const gone = (e) => e && e.code === 'ENOENT';
  const exists = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
  for (;;) {
    try { fs.writeFileSync(lock, mine, { flag: 'wx' }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let seen = null;
    let old = false;
    // reintentar en el acto sólo si el candado de verdad ya no está (un enlace roto existe y no se puede leer)
    try { old = isOld(lock); seen = fs.readFileSync(lock, 'utf8'); } catch (e) { if (gone(e) && !exists(lock)) continue; }
    if (old) {
      // pisar un candado viejo lo hace uno solo: quien toma el candado corto de pisar, y recién después de comprobar
      // que el viejo sigue siendo el mismo (otro pudo pisarlo y tomar uno nuevo mientras tanto). Queda un hueco que no
      // se cierra sin candados del sistema: que el dueño de un candado de más de 30 s lo suelte justo entre la
      // comprobación y el borrado
      try { if (isOld(steal)) fs.rmSync(steal, { force: true }); } catch (_) { /* no hay */ }
      let got = false;
      try { fs.writeFileSync(steal, mine, { flag: 'wx' }); got = true; } catch (_) { /* otro está pisando */ }
      if (got) {
        let stolen = false;
        try { if (isOld(lock) && fs.readFileSync(lock, 'utf8') === seen) { fs.rmSync(lock); stolen = true; } } catch (_) { /* ya no está, o no se pudo */ }
        try { if (fs.readFileSync(steal, 'utf8') === mine) fs.rmSync(steal, { force: true }); } catch (_) { /* ya no está */ }
        if (stolen) continue;
      }
    }
    if (Date.now() > until) return null;
    nap();
  }
  try { return { value: fn() }; } finally {
    try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock, { force: true }); } catch (_) { /* ya no está */ }
  }
}
const isTrue = (v) => v !== undefined && v !== null && String(v).trim() !== '' && !/^(0|false|no)$/i.test(String(v).trim());

/** Las corridas terminadas del historial de la máquina. */
function closedStories({ home } = {}) {
  const dir = path.join(stateDir(home), 'timing-history');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'ok', count: 0, files: [], reason: null };
    return { status: 'no_medido', count: 0, files: [], reason: `no pude leer ${dir} (${e.code || 'error de lectura'})` };
  }
  const files = [];
  const unreadable = [];
  for (const f of names.filter((x) => x.endsWith('.json')).sort()) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).marker; } catch (_) { unreadable.push(f); continue; }
    if (m && m.storyId && Array.isArray(m.stepsPending) && m.stepsPending.length === 0
      && Array.isArray(m.stepsCompleted) && m.stepsCompleted.length > 0) files.push(f);
  }
  // un volcado ilegible puede ser el de una historia cerrada: sin leerlo, la cuenta no se sabe
  if (unreadable.length) return { status: 'no_medido', count: files.length, files, reason: `volcados ilegibles en ${dir}: ${unreadable.join(', ')}` };
  return { status: 'ok', count: files.length, files, reason: null };
}

/** El registro propio, o `{}` si no existe. Tira si existe y no se lee: un registro roto no es «nunca se ofreció». */
function readRecord(home) {
  let d;
  try { d = readJson(recordPath(home)); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${recordPath(home)} no es un objeto`);
  return d;
}

/**
 * Lee un JSON sin que el motivo de un error repita su contenido: el mensaje de `JSON.parse` trae un pedazo del texto, y
 * el estado o el registro pueden llegar a la salida del cierre. El motivo es la ruta y el código, nunca el texto.
 */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { const err = new Error(`no pude leer ${file} (${e.code || 'error de lectura'})`); err.code = e.code; throw err; }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) { throw new Error(`${file} no es JSON válido`); }
}

function writeRecord(home, rec) {
  const file = recordPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** `first_install` del estado de la instalación, leído del archivo tal cual (sin la validación del árbol). */
function firstInstallOf(home) {
  const st = readJson(path.join(stateDir(home), STATE_FILE));
  return st && st.first_install !== undefined ? st.first_install : null;
}

/** ¿Es la primera historia de esta máquina? Por evidencia; en la duda, `no_medido`. */
function isFirstStory({ home, env = process.env } = {}) {
  const no = (reason, count = 0) => ({ status: 'no_medido', first: false, count, reason });
  let fi;
  try { fi = firstInstallOf(home); } catch (e) { return no(`no pude leer el estado de la instalación (${e.message})`); }
  if (!fi || typeof fi !== 'object') return no('instalación anterior a esta versión: el estado no dice desde cuándo está instalada la máquina');
  if (fi.fresh !== true) return no('la instalación no es nueva: al instalar ya había rastros de uso del pipeline');
  const cs = closedStories({ home, env });
  if (cs.status !== 'ok') return no(cs.reason);
  let rec;
  try { rec = readRecord(home); } catch (e) { return no(e.message, cs.count); }
  if (rec.first_close && cs.count === 0) return no('historial podado: hay registro de un cierre y no quedan volcados');
  return { status: 'ok', first: cs.count === 0 && !rec.first_close, count: cs.count, reason: null };
}

/** ¿Hay una persona delante para contestar? No, en una sesión no atendida del agente o en integración continua. */
function personPresent(env = process.env) {
  if (CI_VARS.some((k) => isTrue(env[k]))) return false;
  if (String(env.CLAUDE_CODE_SESSION_ATTENDED || '').trim() === '0') return false;
  if (/^sdk/i.test(String(env.CLAUDE_CODE_ENTRYPOINT || ''))) return false;
  return true;
}

const harnessJsOf = (tree) => path.join(tree, 'scripts', 'setup', 'harness.js');
const self = () => path.join(__dirname, 'first-story.js');
/** Cómo se muestra harness.js en la orden para volver: en Windows, entero y entre comillas (PowerShell no expande `~`). */
const shownHarnessFor = (tree, platform = process.platform) => (platform === 'win32' ? `"${harnessJsOf(tree)}"` : null);
const fullCommand = (tree) => (tree ? `node "${harnessJsOf(tree)}" install --profile full --yes` : 'harness.js install --profile full --yes, desde la carpeta del arnés instalado');

/**
 * Después de archivar el volcado de un cierre: anota el primer cierre y decide la oferta.
 * Devuelve `{ lines, warn }`: `lines` va a la salida del cierre; `warn`, en un renglón aparte. Nunca tira.
 */
function afterClose({ home, env = process.env, marker = {}, tree = treeOf(home) } = {}) {
  try {
    const r = withLock(home, () => decide({ home, env, marker, tree }));
    return r ? r.value : { lines: [], warn: 'la oferta de la instalación completa no se evaluó: otro cierre tiene el candado hace más de 5 s' };
  } catch (e) {
    return { lines: [], warn: `la oferta de la instalación completa no se pudo evaluar: ${e.message}` };
  }
}

/** La decisión, ya con el candado. */
function decide({ home, env, marker, tree }) {
  const now = new Date().toISOString();
  const story = marker && marker.storyId ? String(marker.storyId) : null;
  try {
    const before = readRecord(home);
    let fi;
    try { fi = firstInstallOf(home); } catch (e) { return { lines: [], warn: `la oferta de la instalación completa no se evaluó: no pude leer el estado de la instalación (${e.message})` }; }
    // la oferta todavía podía salir: una máquina nueva sin cierre ni oferta anotados (en las demás, callar no esconde nada)
    const pending = Boolean(fi && fi.fresh === true && !before.first_close && !before.offer);
    const cs = closedStories({ home, env });
    if (cs.status !== 'ok') return { lines: [], warn: pending ? `la oferta de la instalación completa no se evaluó: ${cs.reason}` : null };
    const rec = Object.assign({}, before);
    const noteClose = () => { if (!rec.first_close) { rec.first_close = { at: now, story }; writeRecord(home, rec); } };
    if (cs.count < 1) return { lines: [], warn: null };
    // fuera de la primera historia de una instalación nueva, el cierre sólo se anota (es la evidencia del historial podado)
    if (!pending) { noteClose(); return { lines: [], warn: null }; }
    // el primer cierre de una instalación nueva: en una instalación fresca todo volcado es posterior a instalar, así que
    // no se exige «exactamente uno» (con cierres a la vez, el primero en decidir ya ve varios). Lo que falla y se puede
    // arreglar no anota el cierre: el siguiente vuelve a decidir
    if (!tree) return { lines: [], warn: 'la oferta de la instalación completa no se evaluó: no encuentro el árbol del arnés instalado' };
    const prof = setupMod(tree, 'profile').resolve({ tree, home, env });
    // el motivo del lector no se repite: puede traer datos de la configuración de la máquina
    if (!prof.ok) return { lines: [], warn: 'la oferta de la instalación completa no se evaluó: no pude leer el perfil de instalación de la máquina (harness.js doctor dice por qué)' };
    if (!prof.chosen || prof.value !== 'minimal') { noteClose(); return { lines: [], warn: null }; }
    rec.first_close = rec.first_close || { at: now, story };
    if (!personPresent(env)) {
      writeRecord(home, Object.assign(rec, { offer: { status: 'no_person', at: now, story } }));
      return { lines: [`Cerraste tu primera historia con el arnés. Cuando quieras la instalación completa: ${fullCommand(tree)}`], warn: null };
    }
    const shown = offerLines({ tree, home });
    if (shown.warn) return { lines: [], warn: shown.warn };
    writeRecord(home, Object.assign(rec, { offer: { status: 'offered', at: now, story } }));
    return { lines: shown.lines, warn: null };
  } catch (e) {
    return { lines: [], warn: `la oferta de la instalación completa no se pudo evaluar: ${e.message}` };
  }
}

/**
 * Los renglones de la oferta: el título, los tres renglones contados desde la lista de efectos y las órdenes para
 * contestar. El último renglón nombra `offer show`: un cierre leído recortado (`| tail`) igual dice cómo verla entera.
 */
function offerLines({ tree, home }) {
  const eff = setupMod(tree, 'managed').readEffects(tree);
  // el motivo de readEffects puede repetir un pedazo del archivo: se nombra el archivo y se manda al diagnóstico
  if (!eff.ok) return { warn: `la oferta de la instalación completa no se mostró: no pude leer la lista de efectos ${eff.file} (harness.js doctor dice por qué)` };
  const three = setupMod(tree, 'questions').upgradeOffer({ effects: eff.effects, tree, home, shownHarness: shownHarnessFor(tree) });
  return {
    lines: [
      'Cerraste tu primera historia con el arnés. ¿Querés pasar a la instalación completa? (se ofrece una sola vez)',
      ...three.map((l) => `  ${l}`),
      `Para contestar: sí → node "${self()}" offer accept · no → node "${self()}" offer decline · la oferta entera otra vez: node "${self()}" offer show`,
    ],
  };
}

/** La oferta pendiente, otra vez y entera, sin contestarla. Sin oferta pendiente, sale 2. */
function show({ home, tree = treeOf(home) } = {}) {
  let rec;
  try { rec = readRecord(home); } catch (e) { return { code: 2, lines: [`first-story: ${e.message}`] }; }
  if (!rec.offer || rec.offer.status !== 'offered') {
    return { code: 2, lines: [`first-story: no hay una oferta pendiente (${rec.offer ? `quedó «${rec.offer.status}»` : 'nunca se mostró'}).`] };
  }
  if (!tree) return { code: 2, lines: ['first-story: no encuentro el árbol del arnés instalado para armar la oferta'] };
  let shown;
  // un módulo del árbol que falta o falla sale como las demás ramas: un renglón y 2, no un volcado
  try { shown = offerLines({ tree, home }); } catch (e) { return { code: 2, lines: [`first-story: no pude armar la oferta (${e.code || e.message})`] }; }
  return shown.warn ? { code: 2, lines: [shown.warn] } : { code: 0, lines: shown.lines };
}

/** La respuesta de la persona. `accept` corre la instalación completa del árbol; los dos, sólo con la oferta pendiente. */
function answer(kind, { home, env = process.env, tree = treeOf(home), harnessJs = tree ? harnessJsOf(tree) : null, stdio = 'inherit' } = {}) {
  // anotar la respuesta no puede tapar lo que pasó: si el registro no se escribe, se dice y la respuesta se mantiene
  const note = (r, lines) => {
    try { writeRecord(home, r); return lines; } catch (e) { return [...lines, `Ojo: no pude anotar la respuesta en ${recordPath(home)} (${e.code || 'error de escritura'}); la oferta puede volver a aparecer.`]; }
  };
  let rec;
  try { rec = readRecord(home); } catch (e) { return { code: 2, lines: [`first-story: ${e.message}. No corrí nada`] }; }
  if (!rec.offer || rec.offer.status !== 'offered') {
    return { code: 2, lines: [`first-story: no hay una oferta pendiente (${rec.offer ? `quedó «${rec.offer.status}»` : 'nunca se mostró'}). No corrí nada. La instalación completa se pide así: ${fullCommand(tree)}`] };
  }
  const now = new Date().toISOString();
  if (kind === 'decline') {
    return { code: 0, lines: note(Object.assign(rec, { offer: Object.assign({}, rec.offer, { status: 'declined', answered_at: now }) }),
      [`Anotado: sigue la instalación mínima y no te lo vuelvo a ofrecer. Si un día la querés: ${fullCommand(tree)}`]) };
  }
  if (!harnessJs) return { code: 2, lines: ['first-story: no encuentro el árbol del arnés instalado (ni al lado de este archivo ni en el estado de la instalación). No corrí nada'] };
  const r = spawnSync(process.execPath, [harnessJs, 'install', '--profile', 'full', '--yes'], { env, stdio, encoding: 'utf8' });
  const code = r.status === null ? 1 : r.status;
  const out = stdio === 'pipe' ? [r.stdout, r.stderr].filter(Boolean).join('').trim() : '';
  if (code !== 0) {
    return { code, lines: note(Object.assign(rec, { offer: Object.assign({}, rec.offer, { status: 'failed', code, answered_at: now }) }),
      [...(out ? [out] : []), `La instalación completa no terminó (salió ${code}${r.error ? `: ${r.error.message}` : ''}). La máquina sigue como estaba; para reintentar: ${fullCommand(tree)}`]) };
  }
  return { code: 0, lines: note(Object.assign(rec, { offer: Object.assign({}, rec.offer, { status: 'accepted', code: 0, answered_at: now }) }),
    [...(out ? [out] : []), 'Listo: la máquina quedó con la instalación completa. Abrí una sesión nueva de tu agente de código para que entre.']) };
}

const accept = (opts) => answer('accept', opts);
const decline = (opts) => answer('decline', opts);

module.exports = { RECORD_FILE, treeOf, shownHarnessFor, closedStories, isFirstStory, personPresent, afterClose, accept, decline, readRecord };

if (require.main === module) {
  const [cmd, sub] = process.argv.slice(2);
  const home = require('os').homedir();
  let r;
  if (cmd === 'offer' && (sub === 'accept' || sub === 'decline')) r = answer(sub, { home });
  else if (cmd === 'offer' && sub === 'show') r = show({ home });
  else if (cmd === 'offer' && sub === 'status') {
    let rec; try { rec = readRecord(home); } catch (e) { rec = { error: e.message }; }
    r = { code: 0, lines: [JSON.stringify({ isFirstStory: isFirstStory({ home }), record: rec }, null, 2)] };
  } else r = { code: 2, lines: ['uso: node first-story.js offer accept|decline|show|status'] };
  for (const l of r.lines) (r.code === 0 ? process.stdout : process.stderr).write(`${l}\n`);
  process.exit(r.code);
}
