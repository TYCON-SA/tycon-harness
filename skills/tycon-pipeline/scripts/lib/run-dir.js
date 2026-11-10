'use strict';
/**
 * run-dir.js — la carpeta de la corrida de una historia: `<repo>/.advisors/pipeline-runs/<clave>-<sello>/`.
 *
 * Vive aparte de `pipeline.js` para que la pidan módulos livianos (la procedencia de `frozen-tree.js`, que carga el
 * tablero del sitio) sin arrastrar el pipeline entero. `pipeline.js` la reexporta con los mismos nombres.
 *
 * Una corrida, una carpeta: `pipeline.js start` crea la suya y la anota en el marcador (`runDir`). Dos corridas de la
 * misma historia (otra tanda, o la historia reabierta) no comparten carpeta, y lo que pide la carpeta de esa historia
 * recibe la del marcador. La regla vive acá y ningún llamador la repite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// La clave con que se nombra la carpeta de corrida, con el MOTIVO si no se puede calcular: `resolveRunDir` devuelve
// null en los dos casos («no hay carpeta» y «no hay clave»), y quien tiene que explicarle al dev qué pasó pregunta acá.
function runDirKey(storyId, storyPath) {
  return require('./evidence-key.js').keyInfoOr(storyPath, storyId);
}

const sello = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS

/** La carpeta de las corridas del repo. */
const runsBaseDe = (repo) => path.join(repo, '.advisors', 'pipeline-runs');

/** ¿`dir` es una carpeta de corrida directamente bajo las del repo pedido? */
function bajoElRepo(dir, repo) {
  if (typeof dir !== 'string' || !dir) return false;
  // la ruta real de la carpeta (o, si todavía no existe, la de su padre más su nombre): las dos puntas por la misma
  // regla, para que un repo nombrado por un enlace (/var → /private/var) no deje afuera una carpeta que falta
  const real = (p) => {
    try { return fs.realpathSync(p); } catch (_) { /* todavía no existe */ }
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_) { return path.resolve(p); }
  };
  return path.dirname(real(dir)) === real(runsBaseDe(repo));
}

const AVISADOS = new Set();

const esDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

/**
 * El marcador que mira la regla: el que pasa quien llama (`marker`, null = ninguno); si no pasa ninguno, el de
 * `sessionId`; si tampoco, el de la sesión del ambiente. `_nosession` es «sin sesión»: no se lee su marcador. Nunca tira.
 */
// Devuelve `{ marker, motivo }`: sin marcador, `marker: null`; uno que existe y no se lee, además el `motivo`, para que
// la regla sin marcador no elija callada.
function marcadorDe({ marker, sessionId } = {}, tieneMarker = false) {
  if (tieneMarker) return { marker: marker || null };
  let sid = sessionId;
  if (!sid) {
    try { sid = require('./session-id.js').resolveSessionId(); } catch (e) {
      return { marker: null, motivo: `no pude saber de qué sesión es este proceso (${e.message})` };
    }
  }
  if (!sid || sid === '_nosession') return { marker: null };
  let texto;
  try {
    const safe = String(sid).replace(/[/\\]/g, '_');
    texto = fs.readFileSync(path.join(require('./state-dir.js').stateDir(os.homedir()), 'active', `${safe}.json`), 'utf8');
  } catch (e) {
    return { marker: null, motivo: e.code === 'ENOENT' ? null : `el marcador de la sesión ${sid} no se puede leer (${e.code || e.message})` };
  }
  try {
    const m = JSON.parse(texto);
    return { marker: m && m.storyId ? m : null };
  } catch (e) {
    return { marker: null, motivo: `el marcador de la sesión ${sid} no es un JSON legible (${e.message})` };
  }
}

/**
 * La carpeta de la apertura vigente de la sesión del marcador (`run-open` de gates.log, lib/open-runs.js), si es de esa
 * historia, está en disco y bajo el repo pedido. Si no sirve, `{ motivo }`.
 */
function carpetaDeLaApertura(m, storyId, repo) {
  const sid = m.sessionId;
  if (!sid || sid === '_nosession') return { motivo: 'el marcador no dice de qué sesión es' };
  let ev;
  try { ev = require('./open-runs.js').vigente(sid); } catch (e) { return { motivo: `no pude leer la apertura en gates.log (${e.message})` }; }
  if (!ev) return { motivo: 'la sesión no tiene una apertura en gates.log' };
  if (ev.name !== 'run-open') return { motivo: `el último evento de la sesión en gates.log es un ${ev.name || 'evento sin nombre'}, no una apertura` };
  if (String(ev.story) !== String(storyId)) return { motivo: `la apertura vigente de la sesión es de la historia ${ev.story}` };
  if (!ev.runDir || !esDir(ev.runDir)) return { motivo: `la carpeta de la apertura (${ev.runDir || 'sin carpeta'}) ya no está` };
  if (!bajoElRepo(ev.runDir, repo)) return { motivo: 'la carpeta de la apertura es de otro repo' };
  return { dir: ev.runDir };
}

/**
 * La carpeta de la corrida de un marcador de esa historia: su `runDir` si está bajo el repo pedido (creada si falta y
 * `create`), o la de su apertura vigente si no tiene. `{ dir }`; `{ motivo }` si no sirve; `{}` si el `runDir` es de
 * otro repo (la historia en un repo y el código en otro: pedir la del otro repo no es un error).
 */
function carpetaDelMarcador(m, storyId, repo, { create = false } = {}) {
  if (m.runDir) {
    if (!bajoElRepo(m.runDir, repo)) return {};
    if (esDir(m.runDir)) return { dir: m.runDir };
    if (create) { fs.mkdirSync(m.runDir, { recursive: true }); return { dir: m.runDir }; }
    return { motivo: `la carpeta de la corrida del marcador (${m.runDir}) ya no está` };
  }
  const a = carpetaDeLaApertura(m, storyId, repo);
  if (a.dir) return a;
  return { motivo: `el marcador de la historia ${storyId} no tiene carpeta de corrida y no uso su apertura: ${a.motivo}` };
}

/**
 * Las carpetas de la historia sin marcador: entre las que tienen archivos gana la del sello más nuevo en el nombre; la
 * fecha de los archivos sólo desempata (el sello viaja con la carpeta; la fecha cambia con cada copia).
 */
function laMejorSinMarcador(runsBase, names) {
  // `<clave>-<sello>`, o `<clave>-<sello>-<n>` cuando dos arranques cayeron en el mismo segundo
  const selloDe = (n) => { const m = /-(\d{14})(?:-(\d+))?$/.exec(n); return m ? `${m[1]}-${String(m[2] || 1).padStart(4, '0')}` : ''; };
  let best = null; let bestHas = -1; let bestSello = ''; let bestM = -1;
  for (const n of names) {
    const p = path.join(runsBase, n);
    let has = 0; let newest = 0;
    try {
      for (const f of fs.readdirSync(p)) {
        has = 1;
        try { newest = Math.max(newest, fs.statSync(path.join(p, f)).mtimeMs); } catch { /* ignore */ }
      }
    } catch { /* una carpeta que no se lee cuenta como vacía: pierde contra las que se leen */ }
    if (!has) { try { newest = fs.statSync(p).mtimeMs; } catch { newest = 0; } }
    const s = selloDe(n);
    const gana = has > bestHas || (has === bestHas && (s > bestSello || (s === bestSello && newest > bestM)));
    if (gana) { bestHas = has; bestSello = s; bestM = newest; best = p; }
  }
  return best;
}

// Resuelve el dir de la corrida de `storyId` bajo <repo>/.advisors/pipeline-runs/:
//   1. el `runDir` del marcador, si el marcador es de esa historia y la carpeta está bajo el repo pedido;
//   2. un marcador de esa historia SIN `runDir` (de antes de este cambio): la carpeta de su apertura vigente; no se
//      escribe el marcador (lo anota `start` al retomar);
//   3. sin ninguna de las dos: entre las `<clave>-*` (o `<clave>`, o `story-<clave>-*`) la mejor (`laMejorSinMarcador`).
//      Con create=true y ninguna → crea `<clave>-<sello>`. Sin create y ninguna → null.
// El marcador lo da quien llama (`opts.marker`), o el de `opts.sessionId`, o el de la sesión del ambiente.
// La clave es la de la evidencia (`lib/evidence-key.js`): el número solo si es único en el repo de la story,
// `<tema>__<número>` si se repite. Con `storyPath` y sin poder calcular la clave → null: no se elige ni se crea una
// carpeta a ciegas.
function resolveRunDir(repo, storyId, create, storyPath, opts = {}) {
  const runsBase = runsBaseDe(repo);
  const { key } = runDirKey(storyId, storyPath);
  if (!key) return null;

  const leido = marcadorDe(opts || {}, !!opts && Object.prototype.hasOwnProperty.call(opts, 'marker'));
  const m = leido.marker;
  let motivo = leido.motivo || null;
  if (m && String(m.storyId) === String(storyId)) {
    const d = carpetaDelMarcador(m, storyId, repo, { create });
    if (d.dir) return d.dir;
    motivo = d.motivo || null;
  }

  const { ownsName } = require('./evidence-key.js');
  let names = [];
  try {
    names = fs.readdirSync(runsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => ownsName(n, key, storyId));
  } catch (e) {
    // sin carpeta de corridas no hay nada que elegir; una que está y no se lee no es «ninguna»: no se abre otra a ciegas
    if (e.code !== 'ENOENT') {
      process.stderr.write(`⚠️  no puedo leer ${runsBase} (${e.code || e.message}): no elijo ni abro una carpeta de corrida.\n`);
      return null;
    }
    names = [];
  }
  if (names.length) {
    // se dice sólo cuando la regla elige entre carpetas que ya están (si no hay ninguna, no hay nada que elegir), y una
    // vez por proceso: el aviso va en la salida de quien llama y no puede tapar lo que ese comando tiene que decir
    if (motivo && !AVISADOS.has(motivo)) {
      AVISADOS.add(motivo);
      process.stderr.write(`ℹ️  ${motivo}. Uso la regla sin marcador.\n`);
    }
    return laMejorSinMarcador(runsBase, names);
  }
  if (!create) return null;
  const dir = path.join(runsBase, `${key}-${sello()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * La carpeta NUEVA de una corrida que arranca: `<clave>-<sello>`, aunque la historia ya tenga otras. Null si no se puede
 * calcular la clave; tira si no se puede crear (sin permiso de escritura).
 */
function createRunDir(repo, storyId, storyPath) {
  const { key } = runDirKey(storyId, storyPath);
  if (!key) return null;
  const runsBase = runsBaseDe(repo);
  // dos arranques en el mismo segundo no comparten carpeta: la segunda lleva el mismo sello y `-<n>`
  const s = sello();
  let dir = path.join(runsBase, `${key}-${s}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(runsBase, `${key}-${s}-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { runDirKey, resolveRunDir, createRunDir, carpetaDelMarcador, bajoElRepo };
