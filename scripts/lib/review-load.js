#!/usr/bin/env node
'use strict';
/**
 * review-load.js — cuántas cosas de esta máquina esperan la revisión de la persona: el segundo tope de la coordinación.
 * El tope de sesiones (`coordination.max_working`) mide lo que aguanta la máquina; éste mide lo que una persona puede
 * revisar. Junta cuatro lecturas que ya existen, sólo mirando:
 *   · firmas: las que esperan a la persona en la lista de firmas (`terminal`, `firma`, `permiso`; las delegadas no);
 *   · terminados: ejecuciones y caminos cortos terminados sin cerrar (finished-open.js `machine`);
 *   · carpetas: carpetas de trabajo con cambios sin commitear y sin sesión (`unsavedFolderItems`), salvo las copias de
 *     prueba de un trabajo de fondo, en la carpeta `jobs` de Claude Code (state-dir.js `claudeDir`);
 *   · pedidos: los de `stuck-prs.json` trabados hace una hora o más; un borrador no, salvo en choque. No sale a la red.
 * Lo que no se pudo mirar va aparte (`noMedido`) y nunca suma ni se dice como cero. Una fuente que no se lee queda en
 * null, con su motivo en `problems`.
 *
 * Quien decide (open, el freno de sesiones, fillCheck) cuenta de nuevo con `reviewLoadSync`, un proceso hijo con tope:
 * nunca con la foto (`review-load.json`), que el agente puede escribir y sirve sólo para avisar.
 *
 *   node review-load.js --json [--timeout-ms <n>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// El modo con que entra el tope de revisión: 'warn' avisa y abre igual; 'block' no abre. Pasar a 'block' es un commit que
// cambia esta constante; ninguna variable ni archivo lo cambia. El código lo lee de `module.exports` en cada decisión.
const MODO_TOPE_DE_REVISION = 'warn';
// el tope de tiempo para decidir: `open` tiene el candado de las aperturas mientras cuenta
const TOPE_DE_DECISION_MS = 4000;
// el de la foto del arranque, que no apura a nadie
const TOPE_DE_FOTO_MS = 10000;
const HORA_MS = 3600000;
const FIRMAS_QUE_ESPERAN = ['terminal', 'firma', 'permiso'];
const PARTES = ['firmas', 'terminados', 'carpetas', 'pedidos'];
const FINISHED_OPEN = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'finished-open.js');

const motivo = (e) => String((e && e.message) || e).split('\n')[0];
const stateDirDe = (home) => require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);
const fotoDe = (stateDir) => path.join(stateDir, 'review-load.json');

/** El tope de lo que espera revisión: `{ value, origin }` de la configuración, o 8 de fábrica si no se lee. */
function topeDeRevision({ home, env }) {
  try {
    const cfgLib = require('./tycon-config.js');
    const cfg = cfgLib.cargar({ home, env });
    return cfgLib.coordinacion(cfg).max_awaiting_review;
  } catch (_) { return { value: 8, origin: 'sin-valor' }; }
}

/** Los pedidos de `stuck-prs.json` trabados hace una hora o más. Sin archivo, 0; roto, tira con su motivo. */
function contarPedidos(stateDir, ahora) {
  let crudo;
  try { crudo = fs.readFileSync(path.join(stateDir, 'stuck-prs.json'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  const d = JSON.parse(crudo);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('stuck-prs.json no es un objeto');
  return Object.values(d).filter((p) => {
    if (!p || typeof p.estado !== 'string') return false;
    const desde = Date.parse(p.vistoDesde);
    if (!Number.isFinite(desde) || ahora - desde < HORA_MS) return false;
    // un borrador no espera a nadie, salvo que esté en choque: la misma regla que el aviso
    return !p.estado.endsWith('+borrador') || p.estado.startsWith('conflict');
  }).length;
}

/** Los terminados que cuentan y los que no se pudieron medir, de los items de `machine()`. */
function contarTerminados(items) {
  let cuentan = 0;
  let sinMedir = 0;
  for (const i of items || []) {
    if (i.tipo === 'ejecucion' || i.tipo === 'camino-corto') cuentan += 1;
    else if (i.tipo === 'ilegible') sinMedir += 1;
    else if (i.tipo === 'sin-medir') {
      // uno con su sesión es uno; el renglón que junta lo que no se llegó a mirar dice cuántos
      if (i.sid) sinMedir += 1;
      else for (const m of String(i.texto || '').matchAll(/(\d+) (?:camino|ejecuci)/g)) sinMedir += Number(m[1]);
    }
  }
  return { cuentan, sinMedir };
}

const dentroDe = (hijo, padre) => hijo === padre || hijo.startsWith(padre.endsWith(path.sep) ? padre : padre + path.sep);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(String(p)); } };

/**
 * La cuenta: `{ total, partes: { firmas, terminados, carpetas, pedidos }, noMedido: { terminados, carpetas }, tope,
 * problems }`. `topeMs` se reparte: la mitad para los terminados y lo que quede para las carpetas. `deps` reemplaza las
 * lecturas en las pruebas (`abiertos`, `machine`, `folderItems`, `tope`).
 */
async function reviewLoad({ home = os.homedir(), stateDir, ahora = Date.now(), env = process.env, topeMs = TOPE_DE_FOTO_MS, deps = {} } = {}) {
  const desde = Date.now();
  const sdir = stateDir || stateDirDe(home);
  const partes = { firmas: null, terminados: null, carpetas: null, pedidos: null };
  const noMedido = { terminados: 0, carpetas: 0 };
  const problems = [];
  const tope = deps.tope || topeDeRevision({ home, env });

  try {
    const abiertos = deps.abiertos || ((casa, o) => require('./signature-list.js').abiertos(casa, o));
    const tipoDe = deps.tipoDe || require('./signature-list.js').tipoDe;
    const a = abiertos(home, { env, ahora });
    partes.firmas = (a.filas || []).filter((f) => FIRMAS_QUE_ESPERAN.includes(tipoDe(f))).length;
  } catch (e) { problems.push(`las firmas (${motivo(e)})`); }

  try { partes.pedidos = contarPedidos(sdir, ahora); } catch (e) { problems.push(`los pedidos trabados (${motivo(e)})`); }

  try {
    const machine = deps.machine || require(FINISHED_OPEN).machine;
    const m = machine({ home, stateDir: sdir, now: ahora, env, topeMs: Math.max(1, Math.floor(topeMs / 2)) });
    const t = contarTerminados(m && m.items);
    partes.terminados = t.cuentan;
    noMedido.terminados = t.sinMedir;
  } catch (e) { problems.push(`los terminados sin cerrar (${motivo(e)})`); }

  const resta = Math.max(1, topeMs - (Date.now() - desde));
  try {
    const leer = deps.folderItems || require(FINISHED_OPEN).unsavedFolderItems;
    let timer;
    const agotado = new Promise((ok) => { timer = setTimeout(() => ok({ agotado: true }), resta + 200); });
    const r = await Promise.race([Promise.resolve(leer({ home, now: ahora, env, topeMs: resta })), agotado]);
    clearTimeout(timer);
    if (r.agotado) problems.push(`las carpetas sin commitear (no contestaron en ${Math.round(resta / 100) / 10} s)`);
    else if (r.vivasDesconocidas) problems.push(`las carpetas sin commitear (no sé qué sesiones viven: ${r.vivasDesconocidas})`);
    else {
      const jobs = real(path.join(require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).claudeDir(home), 'jobs'));
      partes.carpetas = (r.carpetas || []).filter((c) => !dentroDe(real(c.dir), jobs)).length;
      noMedido.carpetas = (r.sinMirar || 0) + (r.problemas || []).length;
    }
  } catch (e) { problems.push(`las carpetas sin commitear (${motivo(e)})`); }

  const total = PARTES.reduce((n, k) => n + (partes[k] || 0), 0);
  return { total, partes, noMedido, tope, problems };
}

/** La cuenta sin tocar nada: todas las partes en null, con el motivo. */
const sinCuenta = (tope, problema) => ({ total: 0, partes: { firmas: null, terminados: null, carpetas: null, pedidos: null }, noMedido: { terminados: 0, carpetas: 0 }, tope, problems: [problema] });

/**
 * La HOME y la casa del arnés con que cuenta el hijo, sacadas del `env` de quien llama y no del ambiente de este proceso:
 * `{ home, tyconHome }`. Como en `ownRootOf` de tycon-home.js, el `TYCON_HOME` de un ambiente vale sólo para la HOME de
 * ese ambiente (su `HOME`, o `USERPROFILE` en Windows; si no la dice, la de este proceso) y sólo si es absoluto. Con otra
 * HOME la casa es `<home>/.tycon`: la cuenta de una casa de prueba no lee ni escribe la casa real de quien la pide. Una
 * HOME vacía es la del ambiente; una relativa se resuelve.
 */
function casaDelHijo(home, env) {
  const { OWN_DIR_NAME } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  const delAmbiente = path.resolve(String((process.platform === 'win32' ? env.USERPROFILE : env.HOME) || '').trim() || os.homedir());
  const casa = String(home || '').trim() ? path.resolve(String(home).trim()) : delAmbiente;
  const v = env.TYCON_HOME == null ? '' : String(env.TYCON_HOME).trim();
  return { home: casa, tyconHome: casa === delAmbiente && v && path.isAbsolute(v) ? v : path.join(casa, OWN_DIR_NAME) };
}

/**
 * La cuenta para quien decide sin `await` (capCheck, fillCheck): corre este archivo en un proceso hijo con tope
 * (`topeMs` + 1 s). Si el hijo se pasa, sale con error o con salida ilegible, las partes quedan en null y el motivo va a
 * `problems`: la cuenta de revisión nunca impide abrir por no poder contarse. `script` reemplaza el hijo en las pruebas.
 */
function reviewLoadSync({ home, env = process.env, topeMs = module.exports.TOPE_DE_DECISION_MS, script = __filename } = {}) {
  let casa;
  try { casa = casaDelHijo(home, env); } catch (e) { return sinCuenta(topeDeRevision({ home: home || os.homedir(), env }), `la cuenta no corrió (${motivo(e)})`); }
  const tope = topeDeRevision({ home: casa.home, env });
  const r = require('child_process').spawnSync(process.execPath, [script, '--json', '--timeout-ms', String(topeMs)], {
    encoding: 'utf8', timeout: topeMs + 1000, killSignal: 'SIGKILL', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, HOME: casa.home, USERPROFILE: casa.home, TYCON_HOME: casa.tyconHome },
  });
  if (r.error) return sinCuenta(tope, r.error.code === 'ETIMEDOUT' ? `la cuenta no terminó en ${(topeMs + 1000) / 1000} s` : `la cuenta no corrió (${motivo(r.error)})`);
  if (r.status !== 0) return sinCuenta(tope, `la cuenta salió con ${r.status === null ? r.signal : r.status}`);
  try {
    const j = JSON.parse(r.stdout);
    if (!j || typeof j.total !== 'number' || !j.partes) throw new Error('sin total');
    return j;
  } catch (e) { return sinCuenta(tope, `la cuenta devolvió algo que no leo (${motivo(e)})`); }
}

/** ¿Lo contado llega al tope? Lo no medido no suma: con lo contado debajo, no llega. */
const enElTope = (r) => !!r && Number.isFinite(r.total) && !!r.tope && r.total >= r.tope.value;

/** Lo que no se pudo mirar, en palabras, o '' si se miró todo. */
function noMedidoEnPalabras(r) {
  const que = [];
  for (const k of PARTES) if (r.partes[k] === null) que.push(k);
  if (r.noMedido.terminados) que.push(`${r.noMedido.terminados} terminado${r.noMedido.terminados === 1 ? '' : 's'}`);
  if (r.noMedido.carpetas) que.push(`${r.noMedido.carpetas} carpeta${r.noMedido.carpetas === 1 ? '' : 's'}`);
  return que.length ? `no pude mirar: ${que.join(', ')}` : '';
}

/** La línea de la cuenta: «N cosas esperan revisión de la persona (tope M): …», con lo que no se pudo mirar. */
function lineaDeRevision(r, { origen = null } = {}) {
  const n = (k) => (r.partes[k] === null ? '?' : r.partes[k]);
  const tope = `tope ${r.tope.value}${origen ? `, ${origen}` : ''}`;
  const falta = noMedidoEnPalabras(r);
  return `${r.total} cosa${r.total === 1 ? '' : 's'} esperan revisión de la persona (${tope}): ${n('firmas')} firmas, ${n('terminados')} terminados, ${n('carpetas')} carpetas, ${n('pedidos')} pedidos${falta ? ` (${falta})` : ''}. Se miran con /wip`;
}

/** Deja la foto de la cuenta, con su hora. Sólo para avisar: nadie decide con ella. */
function escribirFoto(stateDir, r, ahora = Date.now()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${fotoDe(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: new Date(ahora).toISOString(), ...r }));
  fs.renameSync(tmp, fotoDe(stateDir));
}

/** La foto y su edad: `{ cuenta, edadMs }`, o null si no hay o no se lee. */
function leerFoto(stateDir, ahora = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(fotoDe(stateDir), 'utf8'));
    const at = Date.parse(j.at);
    // una foto con otra forma (escrita a mano) no es una foto: quien la muestra no tiene que caerse con ella
    const parte = (v) => v === null || (Number.isInteger(v) && v >= 0);
    const entero = (v) => Number.isInteger(v) && v >= 0;
    if (!Number.isFinite(at) || !entero(j.total) || !j.partes || !PARTES.every((k) => parte(j.partes[k]))
      || !j.noMedido || !entero(j.noMedido.terminados) || !entero(j.noMedido.carpetas) || !j.tope || !Number.isInteger(j.tope.value)) return null;
    return { cuenta: j, edadMs: Math.max(0, ahora - at) };
  } catch (_) { return null; }
}

/** El renglón de una decisión en aviso, sin rutas ni nombres: el total, el tope y las cuatro partes. */
function anotarAviso(stateDir, r, donde) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'review-cap', status: 'warn', donde,
    total: r.total, tope: r.tope.value, partes: r.partes, noMedido: r.noMedido })}\n`);
}

module.exports = { MODO_TOPE_DE_REVISION, TOPE_DE_DECISION_MS, TOPE_DE_FOTO_MS, reviewLoad, reviewLoadSync, enElTope, lineaDeRevision,
  noMedidoEnPalabras, escribirFoto, leerFoto, anotarAviso, contarPedidos, contarTerminados, topeDeRevision };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--timeout-ms');
  const ms = i >= 0 && /^[1-9]\d*$/.test(argv[i + 1] || '') ? Number(argv[i + 1]) : TOPE_DE_FOTO_MS;
  reviewLoad({ topeMs: ms }).then((r) => {
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(r)}\n` : `${lineaDeRevision(r)}\n`);
    // `unsavedFolders` deja consultas a git que no terminaron: la cuenta ya está, no se las espera
    process.exit(0);
  }, (e) => { process.stderr.write(`review-load: ${motivo(e)}\n`); process.exit(1); });
}
