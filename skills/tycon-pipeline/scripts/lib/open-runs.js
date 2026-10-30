'use strict';
/**
 * open-runs — las tres piezas de una ejecución abierta y la pregunta «¿a esta sesión le falta una?» (@story-8.121).
 *
 * Una ejecución abierta deja el marcador de la sesión (`active/<sesión>.json`), su apertura en `gates.log` (`run-open`)
 * y una copia de la apertura en la carpeta de la ejecución del repo (`<carpeta>/run-open.json`). Cada cierre legítimo
 * (`clear`, `clear-session`, `adopt-session`, las dos podas, el reemplazo por otra historia) anota `run-close` con la
 * sesión y la carpeta, y borra la copia. Las aperturas y los cierres se emparejan por la sesión de la ejecución, nunca
 * por la historia: para cada sesión vale su último evento.
 *
 * `perdida` contesta si falta una pieza:
 *   - a: el último evento de la sesión es una apertura y no está su marcador (se borró con cualquier comando);
 *   - b: en el repo hay una copia de la sesión sin la apertura de la misma hora en el registro (se borró o se movió
 *     `gates.log`, o la carpeta entera del estado). Una copia cuya apertura ya tiene su cierre es de una ejecución
 *     terminada que volvió a traer git: no frena;
 *   - c: la copia de la apertura vigente falta, no se puede leer, trae campos de cierre o no coincide (otra sesión sin
 *     su propia apertura vigente, otra historia, otra hora u otra carpeta);
 *   - ilegible: el registro existe y no se puede leer, con un marcador o una copia de la sesión a la vista.
 * Sin ninguna de las tres piezas de la sesión, no hay ejecución y nada cambia.
 *
 * La salida es del dueño: `marker.js clear-session <sesión> --lost` o `marker.js restore <sesión>`, la firma `lost-run`
 * en la ventana de permiso o en su terminal. Desde la sesión designada, para otra sesión (`--for-session <sesión>`),
 * corre sin ventana si el perfil la delega: lo decide la ventana con `approvals.delegated_signing`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir } = require('./state-dir.js');

// los campos que sólo trae un cierre: una copia con alguno de ellos fue editada
const CAMPOS_DE_CIERRE = ['estado', 'cierre', 'close', 'closed', 'closedAt', 'via', 'cita'];

const gatesPath = (home) => path.join(stateDir(home || os.homedir()), 'gates.log');
// la misma clave de archivo que los ganchos (decisión 11): una distinta frenaría una ejecución sana
const { sessionIdFileKey } = require('./session-id.js');
const markerPath = (sid, home) => path.join(stateDir(home || os.homedir()), 'active', `${sessionIdFileKey(sid)}.json`);
const copiaPath = (runDir) => path.join(runDir, 'run-open.json');

/** La misma carpeta, comparada como el sistema: en Windows sin distinguir barras ni mayúsculas. */
function mismaRuta(a, b, platform = process.platform) {
  if (!a || !b) return false;
  if (platform === 'win32') {
    const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return n(a) === n(b);
  }
  return path.resolve(String(a)) === path.resolve(String(b));
}

/**
 * Las aperturas y los cierres del registro, en orden: `{ ok: true, eventos }`, `{ ok: false, ausente: true }` si no hay
 * registro o `{ ok: false, error }` si existe y no se puede leer. Sólo se parsean los renglones que nombran un evento de
 * ejecución: el registro tiene megas de otros controles.
 */
function leerEventos(home) {
  let raw;
  try { raw = fs.readFileSync(gatesPath(home)); } catch (e) {
    return e && e.code === 'ENOENT' ? { ok: false, ausente: true } : { ok: false, error: (e && (e.code || e.message)) || 'error' };
  }
  // corre en cada comando de consola: se buscan los dos nombres en los bytes y se parsea sólo su renglón, porque partir
  // megas en renglones cuesta más que el comando
  const inicios = new Set();
  for (const k of ['"run-open"', '"run-close"']) {
    for (let i = raw.indexOf(k); i !== -1; i = raw.indexOf(k, i + k.length)) inicios.add(raw.lastIndexOf(10, i) + 1);
  }
  const eventos = [];
  for (const s of [...inicios].sort((a, b) => a - b)) {
    const fin = raw.indexOf(10, s);
    let o;
    try { o = JSON.parse(raw.toString('utf8', s, fin === -1 ? raw.length : fin)); } catch { continue; }
    if (o && (o.name === 'run-open' || o.name === 'run-close') && o.sesion) eventos.push(o);
  }
  return { ok: true, eventos };
}

/** El último evento (apertura o cierre) de la sesión, o null. */
function vigente(sid, { home, eventos } = {}) {
  const ev = eventos || (() => { const r = leerEventos(home); return r.ok ? r.eventos : []; })();
  for (let i = ev.length - 1; i >= 0; i--) if (ev[i].sesion === String(sid)) return ev[i];
  return null;
}

function anotar(home, linea) {
  const dir = stateDir(home || os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'gates.log'), JSON.stringify(linea) + '\n', 'utf8');
}

/** Anota la apertura en el registro y escribe su copia en la carpeta de la ejecución (retomar la sobrescribe). */
function abrir({ sid, story, storyPath, repo, runDir, motivo, home, ahora = new Date().toISOString() } = {}) {
  if (!sid || !runDir) throw new Error('abrir: faltan la sesión o la carpeta de la ejecución');
  // absoluta: los frenos leen la copia desde otro directorio de trabajo
  runDir = path.resolve(runDir);
  const apertura = { sesion: String(sid), story: String(story), ...(storyPath ? { storyPath } : {}), ...(repo ? { repo } : {}), runDir, ts: ahora };
  anotar(home, { ts: ahora, sessionId: String(sid), name: 'run-open', ...apertura, ...(motivo ? { motivo } : {}) });
  fs.mkdirSync(runDir, { recursive: true });
  const tmp = `${copiaPath(runDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(apertura, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, copiaPath(runDir));
  return apertura;
}

/**
 * Anota el cierre de la ejecución de `sesion` (por defecto, la que llama) y borra su copia. La carpeta sale de la
 * apertura vigente de esa sesión, o de la que se pasa. Una copia de otra sesión no se toca.
 */
// `soloAbierta`: las podas no anotan nada para una sesión sin apertura vigente (un marcador de antes del registro).
function cerrar({ sid, sesion, runDir, story, estado, motivo, via, cita, home, extra = {}, soloAbierta = false, ahora = new Date().toISOString() } = {}) {
  const quien = String(sesion || sid);
  const ult = vigente(quien, { home });
  if (soloAbierta && !(ult && ult.name === 'run-open')) return false;
  const carpeta = runDir || (ult && ult.name === 'run-open' ? ult.runDir : null);
  const historia = story != null ? String(story) : ult && ult.story != null ? String(ult.story) : null;
  anotar(home, { ts: ahora, sessionId: String(sid || quien), ...extra, name: 'run-close', sesion: quien, story: historia, runDir: carpeta || null,
    estado: estado || null, motivo: motivo || null, via: via || null, ...(cita ? { cita } : {}) });
  if (carpeta) {
    try {
      const c = JSON.parse(fs.readFileSync(copiaPath(carpeta), 'utf8'));
      if (c && c.sesion === quien) fs.unlinkSync(copiaPath(carpeta));
    } catch { /* sin copia, o ilegible: queda para que la pregunta la vea */ }
  }
}

/** La raíz de git de la carpeta (sube hasta encontrar `.git`), o null. */
function raizDeGit(cwd) {
  let d = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

/**
 * Las copias de la sesión en `<raíz>/.advisors/pipeline-runs/*`. Las que no se pueden leer van aparte, en `.ilegibles`:
 * `propia: true` si el texto nombra la sesión, `null` si no se sabe de quién son (o no se pudo listar la carpeta).
 */
function copiasDe(raiz, sid) {
  const base = path.join(raiz, '.advisors', 'pipeline-runs');
  const out = [];
  out.ilegibles = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
    if (e && e.code !== 'ENOENT') out.ilegibles.push({ archivo: base, propia: null });
    return out;
  }
  for (const n of dirs) {
    const archivo = path.join(base, n, 'run-open.json');
    let txt;
    try { txt = fs.readFileSync(archivo, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') out.ilegibles.push({ archivo, propia: null });
      continue;
    }
    let c;
    try { c = JSON.parse(txt); } catch {
      out.ilegibles.push({ archivo, propia: txt.includes(JSON.stringify(String(sid))) || null });
      continue;
    }
    if (c && c.sesion === String(sid)) out.push({ archivo, copia: c });
  }
  // por la hora de la apertura, no por el nombre de la carpeta: la última es la más nueva
  out.sort((a, b) => (Date.parse(a.copia.ts) || 0) - (Date.parse(b.copia.ts) || 0));
  return out;
}

/**
 * ¿A la ejecución de la sesión le falta una pieza? null, o `{ caso, falta, sesion, story, desde, runDir }`. `cwd` puede
 * ser una lista (el directorio de trabajo y el del archivo tocado): las copias se buscan en la raíz de git de cada uno.
 */
function perdida({ sid, cwd, home, platform = process.platform } = {}) {
  if (!sid) return null;
  const s = String(sid);
  const hayMarcador = fs.existsSync(markerPath(s, home));
  const dirs = [].concat(cwd || []);
  const raices = [...new Set((dirs.length ? dirs : [undefined]).map((d) => raizDeGit(d)).filter(Boolean))];
  const copias = [];
  copias.ilegibles = [];
  for (const raiz of raices) {
    const de = copiasDe(raiz, s);
    copias.push(...de);
    copias.ilegibles.push(...de.ilegibles);
  }
  copias.sort((a, b) => (Date.parse(a.copia.ts) || 0) - (Date.parse(b.copia.ts) || 0));
  const reg = leerEventos(home);
  const r = (caso, falta, de) => ({ caso, falta, sesion: s, story: de && de.story != null ? String(de.story) : null, desde: (de && de.ts) || null, runDir: (de && de.runDir) || null });
  if (!reg.ok && !reg.ausente) {
    return hayMarcador || copias.length ? r('ilegible', 'registro-ilegible', copias.length ? copias[copias.length - 1].copia : null) : null;
  }
  const mios = reg.ok ? reg.eventos.filter((e) => e.sesion === s) : [];
  // una copia que no se puede leer no es una copia ausente: si es de esta sesión, o no se sabe de quién es y la sesión
  // tiene ejecución, frena como ilegible
  const tieneEjecucion = hayMarcador || mios.some((e) => e.name === 'run-open');
  const ilegible = (copias.ilegibles || []).find((x) => x.propia === true || (x.propia === null && tieneEjecucion));
  if (ilegible) return r('ilegible', `copia-ilegible: ${ilegible.archivo}`, mios[mios.length - 1]);
  // de la más nueva a la más vieja: el cartel nombra la ejecución de ahora
  for (const { copia } of [...copias].reverse()) {
    const suya = mios.some((e) => e.name === 'run-open' && e.ts === copia.ts);
    if (!suya) return r('b', reg.ausente ? 'registro' : 'apertura', copia);
  }
  const ult = mios[mios.length - 1];
  if (!ult || ult.name !== 'run-open') return null;
  if (!hayMarcador) return r('a', 'marcador', ult);
  let copia;
  try { copia = JSON.parse(fs.readFileSync(copiaPath(ult.runDir), 'utf8')); } catch (e) {
    return r('c', e && e.code === 'ENOENT' ? 'copia' : 'copia-ilegible', ult);
  }
  if (!copia || typeof copia !== 'object' || CAMPOS_DE_CIERRE.some((k) => k in copia)) return r('c', 'copia-cerrada', ult);
  if (copia.sesion !== s) {
    // la carpeta la retomó otra sesión: vale si es la copia de la apertura vigente de esa sesión
    const otra = vigente(copia.sesion, { eventos: reg.eventos });
    const deOtra = otra && otra.name === 'run-open' && otra.ts === copia.ts && String(otra.story) === String(copia.story) && mismaRuta(otra.runDir, copia.runDir, platform);
    return deOtra ? null : r('c', 'copia-distinta', ult);
  }
  if (copia.ts !== ult.ts || String(copia.story) !== String(ult.story) || !mismaRuta(copia.runDir, ult.runDir, platform)) return r('c', 'copia-distinta', ult);
  return null;
}

const FALTA = {
  marcador: 'falta su marcador (el archivo de la sesión en la carpeta del estado): se borró o se movió',
  registro: 'falta el registro de aperturas (gates.log): se borró o se movió, y la copia de la apertura sigue en el repo',
  apertura: 'falta su apertura en el registro (gates.log), y la copia de la apertura sigue en el repo',
  copia: 'falta la copia de la apertura (run-open.json) en la carpeta de la ejecución',
  'copia-ilegible': 'la copia de la apertura (run-open.json) no se puede leer',
  'copia-cerrada': 'la copia de la apertura (run-open.json) trae campos de un cierre: fue editada',
  'copia-distinta': 'la copia de la apertura (run-open.json) no coincide con el registro: fue editada',
  'registro-ilegible': 'el registro de aperturas (gates.log) existe y no se puede leer',
};

/** El cartel del freno: qué pieza falta, de qué historia, desde cuándo y la salida. */
function cartel(r, { markerJs = 'marker.js' } = {}) {
  return [
    `🔴 EJECUCIÓN PERDIDA — la ejecución de la story ${r.story || '?'} (sesión ${r.sesion}), abierta ${r.desde || 'en una hora que no se pudo leer'}: ${FALTA[r.falta] || r.falta}.`,
    'Hasta resolverla no se edita, no se escribe por consola, no se cierra el turno ni se commitea. Leer sí: cat, ls, grep, head, tail, git status/diff/log, marker.js get.',
    'La salida la decide una persona, no el agente: la firma en la ventana de permiso o en su terminal (--terminal), con uno de estos comandos:',
    `  node ${markerJs} clear-session ${r.sesion} --lost   (la cierra como perdida)`,
    `  node ${markerJs} restore ${r.sesion}                (la reabre desde la copia de la apertura)`,
  ].join('\n');
}

module.exports = { CAMPOS_DE_CIERRE, mismaRuta, leerEventos, vigente, abrir, cerrar, raizDeGit, copiasDe, perdida, cartel, gatesPath, markerPath };
