'use strict';
// coordination-writes.js — la coordinadora no cambia archivos de los repos ni de la copia instalada del arnés.
//
// La sesión designada coordinadora (la última designación `ok` del registro del arnés, sin una retirada posterior de
// esa misma sesión) no escribe, edita ni borra archivos dentro de un repo: todo cambio va a una sesión, que lo hace con
// su portón y sus pruebas. Lo usan el freno de Edit y Write (skills/tycon-pipeline/scripts/on-coordination-write.js) y la
// puerta de la consola (on-bash-write-gate.js).
//
// «Dentro de un repo»: la ruta real cae bajo una carpeta con `.git` (carpeta o archivo: un worktree, un puesto o un
// submódulo cuentan), o en la copia instalada del arnés (las raíces de installed-tree.js, las mismas que niega el portón
// de carril). Antes de mirar eso, pasan siempre la carpeta del estado y la memoria de la herramienta
// (`<claude>/projects/*/memory/`). En la carpeta del estado, Edit y Write los sigue negando el portón de carril a toda
// sesión: acá no se agrega otra negativa, así el mensaje que se ve es el suyo.
//
// Es una regla de orden, no de seguridad: si algo no se puede leer, pasa y queda una línea en el registro de errores de
// ganchos. Se apaga con TYCON_COORDINATION_WRITE_GUARD=0.
//
// El registro pesa megas y el freno corre en cada edición y cada comando de todas las sesiones: quién coordina se lee
// con memoria (`<estado>/coordination/designation-memo.json`). Si el registro no cambió, alcanza la memoria; si sólo
// creció (y antes de lo agregado sigue diciendo lo mismo), se lee lo agregado; si se achicó, se reescribió o es otro
// archivo, se lee entero. La memoria llega hasta el último renglón completo: uno a medio escribir se lee al completarse.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const MEMO = 'designation-memo.json';
const ID = /^[\w-]+$/;

function waivers() { return require(path.join(PIPELINE_LIB, 'critical-waivers.js')); }
function tree() { return require(path.join(PIPELINE_LIB, 'installed-tree.js')); }
function stateDirOf(home) { return require(path.join(PIPELINE_LIB, 'state-dir.js')).stateDir(home || os.homedir()); }
function claudeDirOf(home) { return require(path.join(PIPELINE_LIB, 'state-dir.js')).claudeDir(home || os.homedir()); }

const apagado = (env = process.env) => String(env.TYCON_COORDINATION_WRITE_GUARD || '').trim() === '0';

/** Una línea en el registro de errores de ganchos; si no se puede, nada. */
function anotar(stateDir, texto) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'hook-errors.log'), `[${new Date().toISOString()}] coordination-write: ${texto}\n\n`, 'utf8');
  } catch { /* sin dónde anotarlo, pasa igual */ }
}

function leerMemo(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && Number.isInteger(m.size) && typeof m.mtimeMs === 'number' && (m.session === null || ID.test(String(m.session)))) return m;
  } catch { /* sin memoria */ }
  return null;
}

// la memoria que no se puede guardar se anota una vez por proceso: sin ella cada llamada lee el registro entero
let memoSinGuardarAnotada = false;
function guardarMemo(file, memo, stateDir) {
  try {
    // una máquina sin coordinadora no tiene la carpeta: sin ella cada llamada leería el registro entero
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memo), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    if (!memoSinGuardarAnotada) { memoSinGuardarAnotada = true; anotar(stateDir, `no pude guardar la memoria de quién coordina (${e.code || e.message}): cada llamada lee el registro entero`); }
  }
}

const COLA = 64;
/** Los últimos bytes del registro antes de `hasta`, para ver después si el registro se reescribió en el mismo archivo. */
function colaDe(log, hasta) {
  const n = Math.min(COLA, hasta);
  if (n <= 0) return '';
  const fd = fs.openSync(log, 'r');
  try {
    const buf = Buffer.alloc(n);
    const leido = fs.readSync(fd, buf, 0, n, hasta - n);
    return buf.subarray(0, leido).toString('base64');
  } finally { fs.closeSync(fd); }
}

/** Hasta dónde llega el último renglón completo de un registro de `size` bytes (lo de después está a medio escribir). */
function ultimoFinDeRenglon(log, size) {
  const n = Math.min(64 * 1024, size);
  if (n <= 0) return 0;
  const fd = fs.openSync(log, 'r');
  try {
    const buf = Buffer.alloc(n);
    const leido = fs.readSync(fd, buf, 0, n, size - n);
    const fin = buf.lastIndexOf(0x0a, leido - 1);
    return fin < 0 ? size - n : size - n + fin + 1;
  } finally { fs.closeSync(fd); }
}

/**
 * Recorre en orden renglones nuevos del registro con la regla de `designacionVigente`: una designación `ok` válida pone
 * su sesión; una retirada de la sesión vigente la deja en null; la de otra sesión no cambia nada.
 */
function plegar(session, texto) {
  const { DESIGNACION, RETIRADA } = waivers();
  let s = session;
  for (const l of texto.split('\n')) {
    if (!l.includes(DESIGNACION)) continue;
    let g;
    try { g = JSON.parse(l); } catch { continue; }
    if (!g || g.name !== DESIGNACION) continue;
    if (g.status === RETIRADA) { if (s && String(g.sesion || '') === s) s = null; continue; }
    if (g.status === 'ok' && ID.test(String(g.sesion || '')) && (g.cita || g.via)) s = g.sesion;
  }
  return s;
}

/** Lo agregado al registro desde `desde`, hasta el último fin de renglón: `{ texto, hasta }`. */
function leerAgregado(log, desde, size) {
  const fd = fs.openSync(log, 'r');
  try {
    const buf = Buffer.alloc(size - desde);
    let leido = 0;
    while (leido < buf.length) {
      const n = fs.readSync(fd, buf, leido, buf.length - leido, desde + leido);
      if (n <= 0) break;
      leido += n;
    }
    const fin = buf.lastIndexOf(0x0a, leido - 1);
    if (fin < 0) return { texto: '', hasta: desde };
    return { texto: buf.subarray(0, fin + 1).toString('utf8'), hasta: desde + fin + 1 };
  } finally { fs.closeSync(fd); }
}

/**
 * Quién coordina: `{ session }` (null si nadie) o `{ error }` si el registro no se pudo leer. Con memoria: ver la
 * cabecera.
 */
function currentCoordinator({ home, stateDir } = {}) {
  const dir = stateDir || stateDirOf(home);
  const log = path.join(dir, 'gates.log');
  const memoFile = path.join(dir, 'coordination', MEMO);
  let st;
  try { st = fs.statSync(log); } catch (e) {
    return e.code === 'ENOENT' ? { session: null } : { error: `no pude mirar el registro del arnés (${e.code || e.message})` };
  }
  if (!st.isFile()) return { error: 'el registro del arnés no es un archivo' };
  const memo = leerMemo(memoFile);
  const mismo = memo && memo.ino === st.ino;
  if (mismo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return { session: memo.session };
  // un registro vaciado y vuelto a escribir en el mismo archivo no termina, en `size`, con los mismos bytes
  let crecio = false;
  try { crecio = mismo && st.size > memo.size && colaDe(log, memo.size) === String(memo.tail || ''); } catch (e) {
    return { error: `no pude leer el registro del arnés (${e.code || e.message})` };
  }
  if (crecio) {
    try {
      const { texto, hasta } = leerAgregado(log, memo.size, st.size);
      const session = plegar(memo.session, texto);
      // el renglón a medio escribir queda para la próxima: la memoria guarda hasta el último fin de renglón
      guardarMemo(memoFile, { size: hasta, mtimeMs: hasta === st.size ? st.mtimeMs : -1, ino: st.ino, tail: colaDe(log, hasta), session }, dir);
      return { session };
    } catch (e) { return { error: `no pude leer lo agregado al registro del arnés (${e.code || e.message})` }; }
  }
  const d = waivers().designacionVigente({ dir });
  if (d && d.error) return { error: d.error };
  const session = d ? d.sesion : null;
  // lo leído entero vale hasta el último renglón completo: uno a medio escribir no se leyó y se lee al completarse
  try {
    const hasta = ultimoFinDeRenglon(log, st.size);
    guardarMemo(memoFile, { size: hasta, mtimeMs: hasta === st.size ? st.mtimeMs : -1, ino: st.ino, tail: colaDe(log, hasta), session }, dir);
  } catch { /* sin memoria: la próxima lee entero */ }
  return { session };
}

function isInside(root, file) {
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = String(file).replace(/\\/g, '/').toLowerCase();
  return f === r || f.startsWith(`${r}/`);
}

/** Las carpetas que siempre pasan: la del estado (las dos, la vigente y la de la casa propia) y la memoria de la herramienta. */
function siemprePasa(real, { home, stateDir }) {
  const t = tree();
  const estados = [stateDir || stateDirOf(home)];
  try { estados.push(...require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDirs(home || os.homedir())); } catch { /* sólo la vigente */ }
  if (estados.some((d) => isInside(d, real) || isInside(t.realPath(d), real))) return true;
  const proyectos = t.realPath(path.join(claudeDirOf(home), 'projects'));
  if (!isInside(proyectos, real)) return false;
  const partes = path.relative(proyectos, real).split(path.sep);
  return partes.length >= 2 && partes[1] === 'memory';
}

/**
 * ¿La ruta cae dentro de un repo o de la copia instalada del arnés? `{ inside, root }`. Se mira la ruta real (con los
 * enlaces del tramo que existe resueltos); para una que todavía no existe, desde su carpeta más cercana que exista. No
 * llama a git: busca `.git` hacia arriba.
 */
function insideRepo(file, { home, stateDir, installedRoots } = {}) {
  const t = tree();
  const real = t.realPath(path.resolve(String(file)));
  if (siemprePasa(real, { home, stateDir })) return { inside: false, root: null };
  const raices = Array.isArray(installedRoots) ? installedRoots : t.roots({ home: home || os.homedir() });
  const instalada = raices.find((r) => isInside(r, real));
  if (instalada) return { inside: true, root: instalada };
  let dir = real;
  for (let i = 0; i < 200; i++) {
    if (path.basename(dir) === '.git') return { inside: true, root: path.dirname(dir) };
    if (fs.existsSync(path.join(dir, '.git'))) return { inside: true, root: dir };
    const arriba = path.dirname(dir);
    if (arriba === dir) break;
    dir = arriba;
  }
  return { inside: false, root: null };
}

/** El texto de la negativa: qué no hace, dónde, y qué hacer en cambio. */
function refusal(file, session) {
  return [
    `⛔ Sos la coordinadora (${String(session).slice(0, 8)}): no cambiás archivos de los repos ni de la copia del arnés:`,
    `  ${file}`,
    '',
    'Encargáselo a una sesión (una libre, o una nueva con `coordination.js open`) con qué cambiar, dónde y por qué; ella lo',
    'hace con su portón y sus pruebas. Tu memoria y lo que está fuera de los repos sí los escribís; tu estado y el tablero,',
    'con sus guiones (`coordination.js`, `board.js`).',
  ].join('\n') + '\n';
}

/**
 * El juicio: `{ block }` si la sesión es la coordinadora y alguno de los archivos cae en un repo; si no, null.
 * `sessionId` es el del evento tal cual: sin él, pasa y lo anota. `files` es la lista, o una función que la da: la
 * consola la calcula sólo si la sesión es la coordinadora.
 */
function judge({ sessionId, files, home, stateDir, installedRoots, env = process.env } = {}) {
  if (apagado(env) || !files) return null;
  const dir = stateDir || stateDirOf(home);
  const sid = sessionId == null ? '' : String(sessionId);
  if (!ID.test(sid)) { anotar(dir, `el evento no trae un session_id legible (${JSON.stringify(sessionId)}): pasa`); return null; }
  const quien = currentCoordinator({ home, stateDir: dir });
  if (quien.error) { anotar(dir, `${quien.error}: pasa`); return null; }
  if (!quien.session || quien.session !== sid) return null;
  const lista = typeof files === 'function' ? files() : files;
  for (const f of lista || []) {
    let r;
    try { r = insideRepo(f, { home, stateDir: dir, installedRoots }); } catch (e) { anotar(dir, `no pude ubicar ${f} (${e.message}): pasa`); continue; }
    if (r.inside) return { block: refusal(f, sid) };
  }
  return null;
}

module.exports = { currentCoordinator, insideRepo, refusal, judge, MEMO };
