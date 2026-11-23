#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * temp-sweep.js — las carpetas temporales que nadie usa se borran solas, de a poco y con la máquina prendida.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * Las pruebas y las sesiones del arnés crean carpetas en la carpeta temporal del usuario, y no todas las borran. Se
 * juntan de a miles, y el sistema las vacía al arrancar la máquina: en macOS esa limpieza corre antes de mostrar el
 * escritorio y, con días de pruebas acumuladas, el ingreso tarda minutos.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Al arrancar sesión (SessionStart), como mucho una vez por día y con un tope de tiempo: mira el PRIMER NIVEL de las
 * carpetas temporales y borra las entradas que cumplen todo esto:
 *   · el nombre termina en el sufijo al azar de mkdtemp (`algo-AbC123`) o es el de mktemp (`tmp.Ab3dEfGh1j`);
 *   · es una carpeta o un archivo común, y es del usuario;
 *   · ni ella ni nada de adentro cambió en el plazo (24 horas): mira la fecha de modificación y la de cambio;
 *   · no tiene sockets adentro;
 *   · ningún proceso vivo del usuario la tiene de carpeta de trabajo, ni tiene abierto algo de adentro.
 * Dice una línea si borró algo, si algo no se dejó borrar, si no pudo mirar o si el tope lo cortó. Silencio si no
 * hay nada. Si el tope lo corta, vuelve a pasar en la próxima sesión que arranque después de una hora.
 *
 * ── LO QUE NUNCA TOCA ────────────────────────────────────────────────────────────────────────────────────────────
 *   · un nombre sin sufijo al azar. El sufijo tiene que mezclar al menos dos de minúsculas, mayúsculas y dígitos,
 *     con dos letras o más, y no ser una palabra con mayúscula inicial: `mi-server`, `log-261117`, `x-Backup` y
 *     `rel-v12345` también terminan en seis caracteres, y de los sufijos al azar menos de dos en cien quedan afuera.
 *     El nombre de mktemp tiene que traer las tres clases: `tmp.screenshot` y `tmp.2024backup` tienen su misma forma;
 *   · lo de otras aplicaciones y lo de las sesiones del asistente: `com.*`, `mcp-*`, `vscode*`, `claude*`, `cc-*`,
 *     `engram-*`, y todo nombre que empieza con punto;
 *   · un enlace simbólico del primer nivel, y lo que está del otro lado de un enlace de adentro;
 *   · una entrada que otro usuario puede alcanzar (con permisos para el grupo o para otros) si adentro tiene algo
 *     que no es del usuario o una carpeta donde otro puede escribir: ahí otro podría cambiar una carpeta por un
 *     enlace mientras se borra;
 *   · una entrada con otro disco montado adentro;
 *   · una carpeta de adentro que no se deja leer y sí atravesar: no se sabe qué tiene. A una sin permiso de paso
 *     para nadie no se entra por ruta: lo de adentro no cambió desde que quedó así, y se borra sin mirarlo;
 *   · nada, si no puede saber qué usan los procesos vivos: sin esa lista no borra, y prueba de nuevo al otro día.
 *
 * ── DÓNDE MIRA ───────────────────────────────────────────────────────────────────────────────────────────────────
 *   · macOS: la carpeta temporal del usuario, la que da `getconf`, y `/private/tmp`;
 *   · Linux: `/tmp`;
 *   · Windows: `AppData\Local\Temp`, en la carpeta del usuario.
 * No usa la variable TMPDIR: quien lanza la sesión la puede apuntar a cualquier carpeta, y este guion borra.
 * `TYCON_TEMP_SWEEP_ROOTS` (rutas separadas como en el PATH) sólo sirve para mirar MENOS: cada ruta tiene que estar
 * dentro de una de esas carpetas (en Windows, también dentro de la que dice el sistema); otra se saltea y se dice.
 * Una carpeta donde cualquiera puede escribir y que no protege lo de cada uno (sin «sticky») tampoco se mira.
 *
 * ── CÓMO SABE QUE ALGO ESTÁ EN USO ───────────────────────────────────────────────────────────────────────────────
 *   · Linux: las carpetas de trabajo y los archivos abiertos de los procesos del usuario, de `/proc`;
 *   · macOS: lo mismo, de `lsof`;
 *   · Windows: le cambia el nombre y se lo devuelve antes de borrar. El sistema se niega si un proceso está parado
 *     en la carpeta, y entonces la deja. Un archivo de adentro abierto por otro proceso puede no frenarlo.
 * Límites conocidos: no ve los procesos de otro usuario ni los del administrador, ni la carpeta de trabajo de un
 * proceso propio que no la deja leer (los de un navegador en su encierro); y no distingue un montaje que comparte
 * disco con la carpeta temporal (un «bind» de Linux, que sólo arma el administrador).
 *
 * Mac, Linux y Windows: sólo Node; en macOS, además, `getconf` y `lsof`, que vienen con el sistema.
 *
 * Apagar: TYCON_TEMP_SWEEP=0. Plazo en horas, de 1 para arriba: TYCON_TEMP_SWEEP_HOURS (24). Forzar la pasada de
 * hoy: --force. Probar sin borrar: --dry-run. Otro tope de tiempo, hasta 600 segundos, para una primera pasada con
 * mucho acumulado: --budget-seconds <n>. Para las pruebas, la fecha contra la que se mide el plazo:
 * TYCON_TEMP_SWEEP_NOW. Fail-open: un hook de arranque nunca frena ni tira; si no pudo barrer, lo dice.
 *
 * Uso:
 *   node scripts/hooks/temp-sweep.js                                   ← el hook de arranque
 *   node scripts/hooks/temp-sweep.js --force [--dry-run] [--json] [--budget-seconds <n>]
 *
 * Casos: scripts/tests/temp-sweep.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STAMP_NAME = 'temp-sweep-last-run';
const HOUR_MS = 60 * 60 * 1000;
const EVERY_MS = 24 * HOUR_MS;
const RETRY_MS = HOUR_MS;
const BUDGET_MS = 20 * 1000;
const MAX_BUDGET_MS = 600 * 1000;
const DEFAULT_HOURS = 24;
const LSOF_TIMEOUT_MS = 5 * 1000;
// sin `-n` y `-P`, lsof traduce cada dirección y cada puerto de red a un nombre: en una máquina con muchas conexiones
// tarda decenas de segundos (medido: 26 s contra medio segundo) y se pasa del tope, y entonces no se barre nada
const LSOF_ARGS = ['-n', '-P', '-u', String(process.getuid ? process.getuid() : ''), '-Fn'];
// el borrado de una entrada no se puede cortar: no se empieza si no queda varias veces lo que tardó en mirarse
const REMOVE_COST = 4;
const MAX_NAMES = 5;
const PROBE_SUFFIX = '.tycon-sweep';
const WIN = process.platform === 'win32';

const MKDTEMP_SUFFIX = /-([A-Za-z0-9]{6})$/;
const MKTEMP_NAME = /^tmp\.([A-Za-z0-9]{10})$/;
const FOREIGN = /^(\.|com\.|mcp-|vscode|claude|cc-|engram-)/i;

function kinds(text) { return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(text)).length; }

/** ¿Los seis caracteres parecen sacados al azar, y no una palabra, una fecha o una versión? */
function mixed(suffix) {
  if (kinds(suffix) < 2) return false;
  if ((suffix.match(/[A-Za-z]/g) || []).length < 2) return false;
  return !/^[A-Z][a-z]+$/.test(suffix);
}

/** ¿El nombre es de los que arman mkdtemp o mktemp, y no es de otra aplicación? */
function looksRandom(name) {
  if (FOREIGN.test(name)) return false;
  // en diez caracteres al azar casi siempre hay minúsculas, mayúsculas y dígitos; en un nombre escrito a mano, no
  const whole = MKTEMP_NAME.exec(name);
  if (whole) return kinds(whole[1]) === 3;
  const m = MKDTEMP_SUFFIX.exec(name);
  return !!m && mixed(m[1]);
}

function real(p) { try { return fs.realpathSync.native(p); } catch (_) { return null; } }
function same(a, b) { return WIN ? a.toLowerCase() === b.toLowerCase() : a === b; }
function under(p, parent) { return same(p, parent) || (WIN ? p.toLowerCase().startsWith(parent.toLowerCase() + path.sep) : p.startsWith(parent + path.sep)); }

/** Las carpetas temporales de esta máquina, sin pasar por TMPDIR. */
function defaultRoots() {
  if (WIN) return [path.join(os.homedir(), 'AppData', 'Local', 'Temp')];
  if (process.platform !== 'darwin') return ['/tmp'];
  // el nombre que pide getconf empieza con el de la plataforma, en mayúsculas
  const r = spawnSync('/usr/bin/getconf', [`${process.platform.toUpperCase()}_USER_TEMP_DIR`], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  const user = r.status === 0 ? (r.stdout || '').trim() : '';
  return [...(user ? [user] : []), '/private/tmp'];
}

/** De las rutas pedidas, las que están dentro de una carpeta temporal conocida y las que no. */
function allowedRoots(asked, known) {
  const bases = known.map(real).filter(Boolean);
  const inside = [], outside = [];
  for (const p of asked) {
    const r = real(p);
    if (r && bases.some((b) => under(r, b))) inside.push(p); else outside.push(p);
  }
  return { inside, outside };
}

/**
 * La raíz por su ruta real, con su disco, o null si no sirve: no es una carpeta, o cualquiera puede escribir en ella
 * y no protege lo de cada uno (ahí otro podría cambiar una entrada por un enlace entre que se mira y se borra). Con
 * «sticky» vale si es del usuario o del administrador: al dueño de la carpeta el «sticky» no lo frena.
 */
function usableRoot(p, uid) {
  const r = real(p);
  if (!r) return null;
  let st;
  try { st = fs.statSync(r); } catch (_) { return null; }
  if (!st.isDirectory()) return null;
  if (uid !== null) {
    const sticky = (st.mode & 0o1000) !== 0;
    if (sticky ? (st.uid !== uid && st.uid !== 0) : (st.uid !== uid || (st.mode & 0o022) !== 0)) return null;
  }
  return { path: r, dev: st.dev };
}

function fromProc() {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { return null; }
  const out = new Set();
  for (const pid of pids) {
    const base = path.join('/proc', pid);
    // el de otro usuario no se deja leer, y uno que terminó ya no está: ninguno de los dos cuenta
    try { out.add(fs.readlinkSync(path.join(base, 'cwd'))); } catch (_) { continue; }
    let fds;
    try { fds = fs.readdirSync(path.join(base, 'fd')); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ESRCH') continue;
      // un proceso propio que no deja ver sus archivos abiertos: la lista quedaría incompleta
      return null;
    }
    for (const fd of fds) {
      try { const t = fs.readlinkSync(path.join(base, 'fd', fd)); if (t.startsWith('/')) out.add(t); } catch (_) { /* se cerró */ }
    }
  }
  return out;
}

function fromLsof() {
  // por su ruta del sistema: uno encontrado en el PATH podría ser otro programa
  const bin = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p));
  if (!bin) return null;
  const r = spawnSync(bin, LSOF_ARGS, { windowsHide: true, encoding: 'utf8', timeout: LSOF_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  // lsof sale 1 cuando no pudo leer algún proceso y la lista sirve igual; cortado por una señal, queda por la mitad
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1) || !r.stdout) return null;
  const out = new Set();
  for (const line of r.stdout.split('\n')) if (line.startsWith('n/')) out.add(line.slice(1));
  return out;
}

/** La lista se cree sólo si trae la carpeta de este mismo proceso: con una lista recortada se borraría algo en uso. */
function trusted(found, own) { return found && own && found.has(own) ? [...found] : null; }

/**
 * Las rutas que usan los procesos vivos del usuario: su carpeta de trabajo y sus archivos abiertos. `null` si no se
 * pudo saber. En Windows devuelve una lista vacía: ahí lo dice el cambio de nombre, al borrar.
 */
function livePaths({ win = WIN } = {}) {
  if (win) return [];
  let found = process.platform === 'linux' ? fromProc() : null;
  if (!found) found = fromLsof();
  return trusted(found, real(process.cwd()));
}

/**
 * Qué se puede decir de una entrada, mirándola entera y sin seguir enlaces:
 *   'stale'    ni ella ni nada de adentro cambió después de `cutoff`, y no hay sockets;
 *   'in-use'   algo cambió, hay un socket, o desapareció mientras se miraba;
 *   'unsafe'   otro usuario puede alcanzarla y adentro hay algo ajeno o una carpeta donde otro escribe, o tiene otro
 *              disco montado adentro;
 *   'unknown'  algo de adentro no se pudo leer;
 *   'timeout'  se acabó el tiempo antes de saberlo.
 */
function inspect(entry, { cutoff, deadline, uid, dev }) {
  const stack = [entry];
  let top = true;
  let shared = false;
  while (stack.length) {
    if (Date.now() >= deadline) return 'timeout';
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { return e.code === 'ENOENT' ? 'in-use' : 'unknown'; }
    if (st.isSocket()) return 'in-use';
    // la fecha de cambio también: lo que se desempaqueta conserva fechas de modificación viejas
    if (Math.max(st.mtimeMs, st.ctimeMs) > cutoff) return 'in-use';
    if (st.dev !== dev) return 'unsafe';
    if (uid !== null) {
      // una entrada sin permisos para el grupo ni para otros no la alcanza nadie más: lo de adentro no hace falta mirarlo
      if (top) shared = (st.mode & 0o077) !== 0;
      if (shared && (st.uid !== uid || (st.isDirectory() && (st.mode & 0o022) !== 0))) return 'unsafe';
    }
    top = false;
    if (!st.isDirectory()) continue;
    // sin permiso de paso para nadie no se entra por ruta, tampoco este guion: lo de adentro no cambió desde que la
    // carpeta quedó así, y eso ya lo dijo su fecha de cambio. Con permiso de paso sólo para otros sigue de largo y,
    // si no la puede leer, queda sin saber. Al administrador los permisos no lo frenan: él sí mira adentro
    if (uid !== null && uid !== 0 && (st.mode & 0o111) === 0) continue;
    let kids;
    try { kids = fs.readdirSync(cur); } catch (e) { return e.code === 'ENOENT' ? 'in-use' : 'unknown'; }
    for (const k of kids) stack.push(path.join(cur, k));
  }
  return 'stale';
}

function gone(p) { try { fs.lstatSync(p); return false; } catch (e) { return e.code === 'ENOENT'; } }

/**
 * Devuelve el permiso a las carpetas de adentro: una prueba puede dejarlas sin permiso de escritura. Cambia el
 * permiso sobre la carpeta ya abierta, sin seguir enlaces. Una que no se deja abrir (sin permiso de lectura) sólo
 * admite el cambio por su ruta, que sí seguiría un enlace puesto en ese instante: por eso corre sólo sobre una
 * entrada que `inspect` dio por segura, donde nadie más que el usuario puede poner ese enlace.
 */
function unlock(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let fd = null;
    try {
      fd = fs.openSync(cur, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_DIRECTORY || 0));
      fs.fchmodSync(fd, 0o700);
    } catch (_) {
      try { fs.chmodSync(cur, 0o700); } catch (__) { /* no es nuestra: el borrado lo dirá */ }
    } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ya estaba cerrada */ } } }
    try { for (const k of fs.readdirSync(cur)) stack.push(path.join(cur, k)); } catch (_) { /* sigue sin leerse */ }
  }
}

/**
 * Borra la entrada: 'removed'; 'gone' si otro la borró antes; 'in-use' (Windows: un proceso la tiene abierta);
 * 'stranded' (Windows: quedó con el nombre de paso); 'failed'.
 */
function remove(entry, { win = WIN } = {}) {
  if (gone(entry)) return 'gone';
  if (win) {
    const probe = entry + PROBE_SUFFIX;
    // el cambio de nombre pisaría sin avisar algo que ya se llame así
    if (!gone(probe)) return 'failed';
    try { fs.renameSync(entry, probe); } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code) ? 'in-use' : 'failed'; }
    try { fs.renameSync(probe, entry); } catch (_) { return 'stranded'; }
  }
  const rm = () => { try { fs.rmSync(entry, { recursive: true, force: true }); } catch (_) { /* lo dice gone() */ } };
  rm();
  if (!gone(entry)) { unlock(entry); rm(); }
  return gone(entry) ? 'removed' : 'failed';
}

/**
 * Mira el primer nivel de cada raíz y borra lo viejo que nadie usa (o lo cuenta, con `dryRun`).
 * Devuelve { removed: [nombres], failed: [nombres], inUse, unsafe, unknown, pending, gone, checked, skippedRoots: [rutas] }.
 * Cada entrada mirada (`checked`) cae en uno solo de los demás: `unknown` son las que quedaron porque no se supo qué
 * usan los procesos vivos o no se pudieron leer; `pending`, las que el tope de tiempo no dejó mirar o borrar; `gone`,
 * las que otro borró antes (otra sesión que arrancó a la vez).
 * `live`: las rutas en uso (por defecto, las de los procesos vivos); `null` es «no se sabe».
 */
function sweep(opts) {
  const { roots, hours = DEFAULT_HOURS, now = Date.now(), budgetMs = BUDGET_MS, dryRun = false, win = WIN } = opts;
  const uid = 'uid' in opts ? opts.uid : (process.getuid ? process.getuid() : null);
  const res = { removed: [], failed: [], inUse: 0, unsafe: 0, unknown: 0, pending: 0, gone: 0, checked: 0, skippedRoots: [] };
  const deadline = Date.now() + budgetMs;
  const cutoff = now - hours * HOUR_MS;
  const dirs = [];
  for (const p of roots) {
    const root = usableRoot(p, uid);
    if (!root) res.skippedRoots.push(p);
    else if (!dirs.some((d) => same(d.path, root.path))) dirs.push(root);
  }
  const live = 'live' in opts ? opts.live : livePaths({ win });
  const busy = live ? live.filter((p) => dirs.some((d) => under(p, d.path))) : null;
  for (const root of dirs) {
    let names;
    try { names = fs.readdirSync(root.path).sort(); } catch (_) { res.skippedRoots.push(root.path); continue; }
    for (const name of names) {
      if (!looksRandom(name)) continue;
      const entry = path.join(root.path, name);
      let st;
      try { st = fs.lstatSync(entry); } catch (e) {
        if (e.code !== 'ENOENT') { res.checked++; res.unknown++; }
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) continue;
      if (uid !== null && st.uid !== uid) continue;
      res.checked++;
      if (Date.now() >= deadline) { res.pending++; continue; }
      const began = Date.now();
      const verdict = inspect(entry, { cutoff, deadline, uid, dev: root.dev });
      const took = Date.now() - began;
      if (verdict === 'timeout') { res.pending++; continue; }
      if (verdict === 'in-use') { res.inUse++; continue; }
      if (verdict === 'unsafe') { res.unsafe++; continue; }
      if (verdict !== 'stale' || !busy) { res.unknown++; continue; }
      if (busy.some((p) => under(p, entry))) { res.inUse++; continue; }
      if (dryRun) { res.removed.push(name); continue; }
      if (deadline - Date.now() < took * REMOVE_COST) { res.pending++; continue; }
      const did = remove(entry, { win });
      if (did === 'removed') res.removed.push(name);
      else if (did === 'in-use') res.inUse++;
      else if (did === 'gone') res.gone++;
      else res.failed.push(did === 'stranded' ? name + PROBE_SUFFIX : name);
    }
  }
  return res;
}

function names(list) {
  const shown = list.slice(0, MAX_NAMES).join(', ');
  return list.length > MAX_NAMES ? `${shown} y ${list.length - MAX_NAMES} más` : shown;
}

/** La línea del arranque; null si no hay nada que decir. `notes`: lo que no se pudo usar tal como se pidió. */
function startupLine(res, { dryRun = false, hours = DEFAULT_HOURS, notes = [] } = {}) {
  const parts = [];
  if (res.removed.length) parts.push(`${dryRun ? 'borraría' : 'borré'} ${res.removed.length} que nadie usa hace ${hours} h`);
  if (res.failed.length) parts.push(`${res.failed.length} no se dejaron borrar (${names(res.failed)})`);
  if (res.unknown) parts.push(`dejé ${res.unknown}: no pude saber si están en uso`);
  if (res.pending) parts.push(`${res.pending} quedaron sin mirar por el tope de tiempo${dryRun ? '' : ': vuelvo a pasar en la próxima sesión que arranque después de una hora'}`);
  if (res.skippedRoots.length) parts.push(`no miré ${names(res.skippedRoots)}: no es una carpeta que se pueda barrer`);
  parts.push(...notes);
  return parts.length ? `temporales viejos: ${parts.join(' · ')}. Apagar: TYCON_TEMP_SWEEP=0` : null;
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

function main() {
  if (process.env.TYCON_TEMP_SWEEP === '0' || process.env.TYCON_EVAL_SANDBOX === '1') return 0;
  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  const notes = [];
  // la carpeta del estado la sabe tycon-home.js; sin él no hay dónde sellar el día, y sin sello no se barre
  const { stateDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  const stamp = path.join(stateDir(os.homedir()), STAMP_NAME);
  if (!process.argv.includes('--force')) {
    // un sello con fecha futura (el reloj se corrigió para atrás) cuenta como vencido
    try { const age = Date.now() - fs.statSync(stamp).mtimeMs; if (age >= 0 && age < EVERY_MS) return 0; } catch (_) { /* sin sello: toca hoy */ }
  }

  // el sello va antes de todo: si el barrido muere a mitad de camino no se repite en cada sesión, y otra sesión que
  // arranca a la vez ya lo encuentra
  let stamped = false;
  if (!dryRun) {
    try {
      fs.mkdirSync(path.dirname(stamp), { recursive: true });
      fs.writeFileSync(stamp, new Date().toISOString() + '\n');
      stamped = true;
    } catch (_) { notes.push('no pude sellar el día: vuelvo a pasar en la próxima sesión'); }
  }

  let hours = DEFAULT_HOURS;
  const askedHours = process.env.TYCON_TEMP_SWEEP_HOURS;
  if (askedHours) {
    if (Number.isFinite(Number(askedHours)) && Number(askedHours) >= 1) hours = Number(askedHours);
    else notes.push(`TYCON_TEMP_SWEEP_HOURS «${askedHours}» no vale (un número de 1 para arriba): uso ${DEFAULT_HOURS}`);
  }
  let budgetMs = BUDGET_MS;
  if (process.argv.includes('--budget-seconds')) {
    const asked = arg('--budget-seconds');
    if (asked !== null && asked !== undefined && Number.isFinite(Number(asked)) && Number(asked) >= 0) budgetMs = Math.min(Number(asked) * 1000, MAX_BUDGET_MS);
    else notes.push(`--budget-seconds «${asked}» no vale (segundos, de 0 a ${MAX_BUDGET_MS / 1000}): uso ${BUDGET_MS / 1000}`);
  }
  let now = Date.now();
  const askedNow = process.env.TYCON_TEMP_SWEEP_NOW;
  if (askedNow) {
    const at = /^\d+$/.test(askedNow) ? Number(askedNow) : Date.parse(askedNow);
    if (Number.isFinite(at)) now = at;
    else notes.push(`TYCON_TEMP_SWEEP_NOW «${askedNow}» no es una fecha: uso la de ahora`);
  }

  const known = defaultRoots();
  if (process.platform === 'darwin' && known.length < 2) notes.push('no pude saber la carpeta temporal del usuario (getconf): sólo miro /private/tmp');
  let roots = known;
  if (process.env.TYCON_TEMP_SWEEP_ROOTS) {
    const split = allowedRoots(process.env.TYCON_TEMP_SWEEP_ROOTS.split(path.delimiter).filter(Boolean), WIN ? [...known, os.tmpdir()] : known);
    roots = split.inside;
    if (split.outside.length) notes.push(`TYCON_TEMP_SWEEP_ROOTS: ${names(split.outside)} no está dentro de una carpeta temporal y no se mira`);
  }

  const res = sweep({ roots, hours, now, budgetMs, dryRun });
  if (stamped && res.pending) {
    // cortado por el tope: el sello se atrasa para que la próxima pasada sea en una hora y no mañana
    try { const at = new Date(Date.now() - (EVERY_MS - RETRY_MS)); fs.utimesSync(stamp, at, at); } catch (_) { notes.push('no pude atrasar el sello: lo que quedó sin mirar espera a mañana'); }
  }
  const line = startupLine(res, { dryRun, hours, notes });
  if (json) process.stdout.write(JSON.stringify({ dryRun, hours, roots, notes, ...res }, null, 2) + '\n');
  else if (line) process.stdout.write(line + '\n');
  return 0;
}

if (require.main === module) {
  // un hook de arranque nunca frena una sesión; si el barrido falló, lo dice en una línea (con --json, en JSON)
  try { main(); } catch (e) {
    const why = String((e && e.message) || e).split('\n')[0];
    try {
      process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify({ error: why })}\n` : `temporales viejos: el barrido falló (${why}). Apagar: TYCON_TEMP_SWEEP=0\n`);
    } catch (_) { /* sin salida no hay a quién decírselo */ }
  }
  process.exit(0);
}

module.exports = { LSOF_ARGS, sweep, looksRandom, defaultRoots, allowedRoots, livePaths, trusted, inspect, remove, startupLine };
