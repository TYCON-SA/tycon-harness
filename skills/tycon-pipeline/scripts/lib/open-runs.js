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
 * en la ventana de permiso o en su terminal. El cartel da las dos formas con la ruta estable (`formasDeSalida`), y
 * `abiertasDentro` dice qué ejecución abierta se perdería al borrar o mover una carpeta (@story-8.318). Desde la sesión designada, para otra sesión (`--for-session <sesión>`),
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
function leerEventos(home, { archivo } = {}) {
  let raw;
  try { raw = fs.readFileSync(archivo || gatesPath(home)); } catch (e) {
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
  // absolutas contra el repo de la ejecución, nunca contra la carpeta del proceso (lib/run-dir.js): los frenos leen la
  // copia desde otro directorio de trabajo. Una carpeta relativa sin un repo absoluto no se anota.
  const r = require('./run-dir.js').rutasDeLaCorrida({ repoPath: repo, runDir, storyPath });
  if (!path.isAbsolute(r.runDir)) throw new Error(`abrir: no anoté la apertura: ${r.motivo}`);
  runDir = r.runDir;
  storyPath = r.storyPath;
  repo = r.repoPath && path.isAbsolute(r.repoPath) ? r.repoPath : null;
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
  // una carpeta relativa se ubica contra el repo que trae el cierre (`extra.repoPath`), nunca contra la carpeta del
  // proceso; sin él se anota tal cual y no se busca su copia
  const pedida = runDir ? require('./run-dir.js').rutasDeLaCorrida({ repoPath: extra && extra.repoPath, runDir }).runDir : null;
  const carpeta = pedida || (ult && ult.name === 'run-open' ? ult.runDir : null);
  const historia = story != null ? String(story) : ult && ult.story != null ? String(ult.story) : null;
  // una carpeta que no se pudo ubicar queda dicha en el cierre: su copia no se buscó y la pregunta la va a ver
  const sinUbicar = !!carpeta && !path.isAbsolute(carpeta);
  anotar(home, { ts: ahora, sessionId: String(sid || quien), ...extra, name: 'run-close', sesion: quien, story: historia, runDir: carpeta || null,
    estado: estado || null, motivo: motivo || null, via: via || null, ...(cita ? { cita } : {}), ...(sinUbicar ? { carpetaSinUbicar: true } : {}) });
  if (carpeta && path.isAbsolute(carpeta)) {
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

/**
 * La apertura de la ejecución de `sesion` para su salida perdida (`restore` o `clear-session --lost`), o null. Una sola
 * regla para el freno (run-close.js), la pregunta del cuadro (signature-sources.js) y marker.js. Con `modo: 'restore'`
 * manda primero lo que dice el marcador de `propia`, la sesión que el restore escribe, si tiene `restoredFrom` igual a la
 * sesión: con pasos en `restorePendiente` es un restore a medias (`a-medias`), y sin pasos, con su apertura nueva vigente
 * y la copia de esa apertura en su carpeta, uno terminado (`terminado`), que no se repite. Después, la apertura vigente
 * del registro; si no, la última copia del repo de `cwd`; y sólo al restaurar, la copia podada por vieja. Todo se lee de
 * una misma carpeta de estado: `estado`, o la de `home`. Devuelve los campos de la apertura más `ts` (su hora), `antes`
 * (la hora es el último toque de la podada, no su arranque) y `deDonde`.
 */
function aperturaParaSalida(sesion, { modo = 'lost', cwd, home, estado, propia } = {}) {
  if (!sesion) return null;
  const s = String(sesion);
  const dir = estado || stateDir(home || os.homedir());
  const reg = leerEventos(home, { archivo: path.join(dir, 'gates.log') });
  const eventos = reg.ok ? reg.eventos : [];
  if (modo === 'restore' && propia) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'active', `${sessionIdFileKey(propia)}.json`), 'utf8')); } catch { m = null; }
    if (m && String(m.restoredFrom) === s) {
      const campos = { sesion: s, storyPath: m.storyPath || null, repo: m.repoPath || null, runDir: m.runDir || null };
      const r = m.restorePendiente;
      if (r && Array.isArray(r.pasos) && r.pasos.length) {
        return { ...campos, name: 'restore-a-medias', story: String(r.story != null ? r.story : m.storyId), ts: r.ts || null, antes: !!r.antes, deDonde: 'a-medias' };
      }
      const nueva = vigente(propia, { eventos });
      let copia = null;
      try { copia = m.runDir ? JSON.parse(fs.readFileSync(copiaPath(m.runDir), 'utf8')) : null; } catch { copia = null; }
      if (nueva && nueva.name === 'run-open' && String(nueva.story) === String(m.storyId) && mismaRuta(nueva.runDir, m.runDir)
        && copia && copia.sesion === String(propia) && copia.ts === nueva.ts) {
        return { ...campos, name: 'restore-terminado', story: String(m.storyId), ts: m.restoredAt || nueva.ts, antes: false, deDonde: 'terminado' };
      }
    }
  }
  const ult = vigente(s, { eventos });
  if (ult && ult.name === 'run-open') return { ...ult, antes: false, deDonde: 'registro' };
  const raiz = raizDeGit(cwd);
  const copias = raiz ? copiasDe(raiz, s) : [];
  if (copias.length) return { ...copias[copias.length - 1].copia, antes: false, deDonde: 'copia' };
  if (modo !== 'restore') return null;
  // se lee acá y no con story-gate-io.js: esa pieza traería marker.js a todo lo que carga este módulo, también al sitio
  let p = null;
  try { p = JSON.parse(fs.readFileSync(path.join(dir, 'pruned', `${sessionIdFileKey(s)}.json`), 'utf8')); } catch { p = null; }
  if (p && p.storyId) {
    // la podada no siempre trae su carpeta: la da su última apertura del registro
    const abierta = p.runDir ? null : [...eventos].reverse().find((e) => e.sesion === s && e.name === 'run-open');
    return { name: 'pruned', sesion: s, story: String(p.storyId), storyPath: p.storyPath || null, repo: p.repoPath || null,
      runDir: p.runDir || (abierta && abierta.runDir) || null, ts: p.startedAt || p.lastTouch || null, antes: !p.startedAt, deDonde: 'podada' };
  }
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

// la ruta estable de marker.js bajo la carpeta de la persona: no cambia al actualizar (la carpeta numerada de la versión
// sí, y en Windows es la que ve `__dirname`) y no lleva `~`, que PowerShell no expande (@story-8.318). La carpeta de las
// skills instaladas la sabe tycon-home.js; sin él (este archivo viaja suelto), marker.js de al lado
const TYCON_HOME_LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
function markerRel(home) {
  if (!fs.existsSync(TYCON_HOME_LIB)) return null;
  const dir = require(TYCON_HOME_LIB).installedSkillsDir(home);
  return path.relative(home, path.join(dir, 'skills', 'tycon-pipeline', 'scripts', 'marker.js')).split(path.sep).join('/');
}

/**
 * El comando `node "<ruta estable>/marker.js" <resto>` y las dos formas de lanzarlo: `{ ventana, terminal, sinCitar }`.
 * `ventana` lo corre el agente por la consola Bash y la persona lo aprueba en el cuadro; `terminal` lo pega la persona,
 * con `--terminal --for-session <sesión>` (null sin una sesión conocida). Con una carpeta personal que no se puede citar,
 * `signatureCommand` lo da con `$HOME`, que no es una firma: `sinCitar` y sólo vale la terminal.
 */
/**
 * `node "<carpeta personal>/<skills instaladas>/…/marker.js"`: el comando de marker.js por la ruta estable, el mismo para
 * todos los carteles y firmas que lo imprimen (@story-8.318, 8.319). Con una carpeta que no se puede citar, con `$HOME`.
 */
function markerEstable(home) {
  const { signatureCommand } = require('./home-command.js');
  const casa = home || os.homedir();
  const rel = markerRel(casa);
  // sin tycon-home.js, la ruta de al lado: se imprime, no se carga
  return rel ? signatureCommand(rel, casa) : `node "${path.resolve(__dirname, '..', 'marker.js')}"`;
}

function formaDeMarker(resto, sesion, { home } = {}) {
  const { enLaTerminal } = require('./home-command.js');
  const base = markerEstable(home);
  const comando = `${base} ${resto}`;
  return { ventana: comando, terminal: enLaTerminal(comando, sesion), sinCitar: base.includes('$HOME') };
}

/**
 * La salida de una ejecución perdida, con sus dos formas: `{ salidas: [{ ventana, terminal, que }], renglones }`. Una sola
 * función para los seis lugares que la imprimen (el cierre de turno, la consola, editar, el commit, marker.js y el aviso
 * del arranque): ninguno arma la ruta a mano.
 */
function formasDeSalida(r, { home } = {}) {
  const s = String(r.sesion);
  const salidas = [
    { ...formaDeMarker(`clear-session ${s} --lost`, s, { home }), que: 'la cierra como perdida' },
    { ...formaDeMarker(`restore ${s}`, s, { home }), que: 'la reabre desde la copia de la apertura' },
  ];
  const { SIN_SESION_TERMINAL } = require('./home-command.js');
  const sinCitar = salidas[0].sinCitar;
  const renglones = [];
  if (!sinCitar) {
    renglones.push('En la ventana de permiso: el agente la lanza por la consola Bash y la persona la aprueba en el cuadro.');
    for (const x of salidas) renglones.push(`  ${x.ventana}   (${x.que})`);
  } else {
    renglones.push('Tu carpeta personal tiene un carácter que no se puede citar: el comando sale con $HOME, que no es una firma de la ventana, y va en la terminal.');
  }
  renglones.push('En la terminal de la persona: con la consola PowerShell de la herramienta o en Codex no hay cuadro, y va ésta.');
  for (const x of salidas) renglones.push(x.terminal ? `  ${x.terminal}   (${x.que})` : `  ${SIN_SESION_TERMINAL}`);
  return { salidas, renglones };
}

/** El cartel del freno: qué pieza falta, de qué historia, desde cuándo y la salida, con sus dos formas. */
function cartel(r, { home } = {}) {
  return [
    `🔴 EJECUCIÓN PERDIDA — la ejecución de la story ${r.story || '?'} (sesión ${r.sesion}), abierta ${r.desde || 'en una hora que no se pudo leer'}: ${FALTA[r.falta] || r.falta}.`,
    'Hasta resolverla no se edita, no se escribe por consola ni se commitea, y el turno se cierra a la segunda. Leer sí: cat, ls, grep, head, tail, git status/diff/log, marker.js get.',
    'La salida la firma una persona, con uno de estos comandos:',
    ...formasDeSalida(r, { home }).renglones,
  ].join('\n');
}

/**
 * Las ejecuciones abiertas cuya carpeta (`runDir`) está dentro de `carpeta`, o es ella: `{ ok: true, abiertas }` o
 * `{ ok: false, error }` si el registro existe y no se puede leer. «Abierta» se lee en gates.log: una sesión cuyo último
 * evento es `run-open` (decisión 4 de la 8.318). La copia del disco no decide: una vieja sin apertura vigente no deja la
 * carpeta pegada. `carpeta` puede ser una lista; cada abierta trae en `en` la carpeta que la contiene.
 */
function abiertasDentro(carpeta, { home, eventos, platform = process.platform, comodines = [] } = {}) {
  const carpetas = [].concat(carpeta || []).filter(Boolean);
  if (!carpetas.length && !comodines.length) return { ok: true, abiertas: [] };
  let ev = eventos;
  if (!ev) {
    const r = leerEventos(home);
    if (!r.ok && !r.ausente) return { ok: false, error: r.error };
    ev = r.ok ? r.eventos : [];
  }
  const ultimo = new Map();
  for (const e of ev) ultimo.set(e.sesion, e);
  const abiertas = [];
  for (const e of ultimo.values()) {
    if (e.name !== 'run-open' || !e.runDir) continue;
    const en = carpetas.find((c) => dentroDe(e.runDir, c, platform)) || comodines.find((g) => casaConComodin(e.runDir, g, platform));
    if (en) abiertas.push({ sesion: e.sesion, story: e.story != null ? String(e.story) : null, runDir: e.runDir, ts: e.ts || null, en });
  }
  return { ok: true, abiertas };
}

/**
 * ¿`ruta` o una carpeta de arriba casa con el comodín `patron` (`*`, `?`, `[…]` del shell, cada uno dentro de un tramo)?
 * Así un `rm -rf wt-*` se compara con cada ejecución abierta sin expandir la lista en el disco.
 */
function casaConComodin(ruta, patron, platform = process.platform) {
  const n = (p) => (platform === 'win32' ? String(p).replace(/\\/g, '/').toLowerCase() : String(p)).replace(/\/+$/, '');
  // la parte fija de adelante, con los enlaces resueltos: `/var/…` y `/private/var/…` en macOS son la misma
  const t0 = n(patron);
  const corte = t0.search(/[*?[]/);
  const fija = corte < 0 ? t0 : t0.slice(0, t0.lastIndexOf('/', corte) + 1);
  // con muchos comodines la comparación puede volverse lenta (cada `*` multiplica los intentos): con más de seis, vale la
  // carpeta fija de adelante, que es más de lo que borra (frena de más, nunca de menos ni colgado)
  if ((t0.match(/[*?[]/g) || []).length > 6) return dentroDe(ruta, fija || '/', platform);
  const patrones = [t0];
  try { const r = n(fs.realpathSync.native(fija || '/')); if (r && r + '/' !== fija && r !== fija) patrones.push(`${r}/${t0.slice(fija.length)}`); } catch { /* no existe: vale el patrón dicho */ }
  const compilar = (t) => {
    let re = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      // como el shell: un comodín al empezar el tramo no casa con un nombre que empieza con punto
      const alEmpezar = i === 0 || t[i - 1] === '/';
      if (c === '*') re += alEmpezar ? '(?!\\.)[^/]*' : '[^/]*';
      else if (c === '?') re += alEmpezar ? '[^/.]' : '[^/]';
      else if (c === '[') {
        const f = t.indexOf(']', i + 1);
        if (f > i) {
          const dentro = t.slice(i + 1, f);
          const niega = /^[!^]/.test(dentro);
          const cuerpo = dentro.replace(/^[!^]/, '').replace(/[\\\]]/g, '\\$&');
          // la clase nunca cruza de un tramo a otro
          re += `${alEmpezar ? '(?!\\.)' : ''}[${niega ? '^/' : ''}${cuerpo}]`;
          i = f;
        } else re += '\\[';
      } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    return new RegExp(`^${re}(?:/|$)`, platform === 'win32' ? 'i' : '');
  };
  const rxs = patrones.map(compilar);
  const hijos = [n(ruta)];
  try { hijos.push(n(fs.realpathSync.native(ruta))); } catch { /* ya no existe */ }
  return rxs.some((rx) => hijos.some((h) => rx.test(h)));
}

/** Cuántas ejecuciones abiertas hay en la máquina (en cualquier carpeta o unidad): `{ ok, n }` o `{ ok: false, error }`. */
function hayAbiertas({ home } = {}) {
  const r = leerEventos(home);
  if (!r.ok && !r.ausente) return { ok: false, error: r.error };
  const ultimo = new Map();
  for (const e of r.ok ? r.eventos : []) ultimo.set(e.sesion, e);
  return { ok: true, n: [...ultimo.values()].filter((e) => e.name === 'run-open').length };
}

/** ¿`hijo` es `padre` o está adentro? Como el sistema: en Windows sin distinguir barras ni mayúsculas; con los enlaces resueltos. */
function dentroDe(hijo, padre, platform = process.platform) {
  // con los enlaces resueltos aunque la ruta ya no exista (una carpeta podada): se resuelve la carpeta de arriba que
  // existe y se le suma el resto (`/var/…` y `/private/var/…` en macOS son la misma)
  const real = (p) => {
    let d = String(p);
    const resto = [];
    for (let i = 0; i < 64; i++) {
      try { return path.join(fs.realpathSync.native(d), ...[...resto].reverse()); } catch { /* sube */ }
      const arriba = path.dirname(d);
      if (arriba === d) return null;
      resto.push(path.basename(d));
      d = arriba;
    }
    return null;
  };
  const formas = (p) => {
    const out = [String(p)];
    const r = platform === process.platform ? real(p) : null;
    if (r) out.push(r);
    return out.map((x) => (platform === 'win32' ? x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : path.resolve(x)));
  };
  const sep = platform === 'win32' ? '/' : path.sep;
  for (const h of formas(hijo)) for (const q of formas(padre)) {
    if (h === q || h.startsWith(q.endsWith(sep) ? q : q + sep)) return true;
  }
  return false;
}

module.exports = { CAMPOS_DE_CIERRE, markerRel, markerEstable, mismaRuta, leerEventos, vigente, abrir, cerrar, raizDeGit, copiasDe, perdida, aperturaParaSalida, cartel, formaDeMarker, formasDeSalida, abiertasDentro, hayAbiertas, dentroDe, casaConComodin, gatesPath, markerPath };
