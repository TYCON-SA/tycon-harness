'use strict';
/**
 * real-hours.js — las horas reales de una historia, con constancia: lo que informó la herramienta de horas al cerrarla.
 *
 * POR QUÉ EXISTE: lo real es el dato contra el que se mide cuánto erró cada estimación, así que no puede ser un número
 * que escriba el modelo. `work-signal stop` anota acá, en cada `stop`, los segundos que devolvió la integración de horas
 * (o que no devolvió ninguno), y `estimate-real` lee sólo eso: no acepta horas a mano. Vale la última constancia de la
 * historia: un `stop` posterior sin segundos deja la historia sin horas, no con las de antes.
 *
 * Una herramienta que informa por una acción (la maneja el agente con su servidor de MCP) no deja segundos: su total lo
 * suma el modelo y no tiene constancia, así que no se anota como real. Limitación: con una herramienta así no hay horas
 * reales hasta que la acción deje su propia evidencia (el id de la llamada real a la herramienta).
 *
 * La constancia vive en el estado de la máquina (`<estado>/horas-reales/<clave>.jsonl`, una línea por `stop`), con la
 * ruta del spec como clave: el mismo id de historia puede repetirse en dos productos.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { stateDir } = require('./state-dir.js');

const SALIDA = { ok: 0, invalid: 2, read: 3 };

/**
 * `estimates.js` del arnés: el mismo árbol en el que `work-signal stop` encontró su evento (en un clon de skills aparte no
 * está al lado); sin arnés encontrado, el de este clon.
 */
function estimatesDe(env, home) {
  let dir = null;
  try { dir = require('./harness-path.js').rutaArnesHook({ env, home }).dir; } catch (_) { dir = null; }
  const delArnes = dir ? path.join(dir, 'scripts', 'lib', 'estimates.js') : null;
  if (delArnes && fs.existsSync(delArnes)) return delArnes;
  return path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'estimates.js');
}

function archivo(home, storyPath) {
  let real = path.resolve(storyPath);
  // `.native` devuelve la ruta con la caja del disco: en un disco que no distingue mayúsculas, specs/ y SPECS/ son la misma
  try { real = fs.realpathSync.native(real); } catch (_) { /* un spec que ya no está se busca por su ruta tal cual */ }
  const clave = crypto.createHash('sha1').update(real).digest('hex').slice(0, 16);
  return path.join(stateDir(home), 'horas-reales', `${clave}.jsonl`);
}

/** Anota un `stop`: los segundos que informó la herramienta (o null) y si contestó con una acción. */
function record(home, storyPath, stopResult) {
  const s = stopResult && stopResult.seconds;
  const linea = {
    spec: path.resolve(storyPath),
    seconds: Number.isInteger(s) && s >= 0 ? s : null,
    accion: !!(stopResult && stopResult.action),
    cuando: new Date().toISOString(),
  };
  const f = archivo(home, storyPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify(linea)}\n`);
  return linea;
}

/** La última constancia de la historia, o null si nunca hubo un `stop`. Tira con código 3 si no se lee. */
function latest(home, storyPath) {
  const f = archivo(home, storyPath);
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw Object.assign(new Error(`no pude leer la constancia de horas ${f}: ${(e && e.code) || e}`), { code: SALIDA.read });
  }
  const lineas = text.split('\n').filter((l) => l.trim());
  if (!lineas.length) return null;
  try { return JSON.parse(lineas[lineas.length - 1]); } catch (_) {
    throw Object.assign(new Error(`la última línea de la constancia de horas ${f} no se lee`), { code: SALIDA.read });
  }
}

/** El repo de historias: el que se pasa, o la raíz de git de la carpeta del spec. */
function repoDe(storyPath, repo) {
  if (repo) return path.resolve(repo);
  try {
    return execFileSync('git', ['-C', path.dirname(path.resolve(storyPath)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    throw Object.assign(new Error(`el spec ${storyPath} no está en un repo de git: pasá --repo <repo de historias>`), { code: SALIDA.invalid });
  }
}

const sinHoras = (motivo) => ({ code: SALIDA.ok, result: { ok: false, reason: 'sin_horas', motivo } });

/**
 * `pipeline.js estimate-real`: anota lo real de la historia con las horas de su última constancia. Devuelve
 * `{ code, result }`; nunca escribe sin constancia con segundos.
 */
function estimateReal(opts) {
  // el paso de cierre conoce las salidas 0, 2 y 3: nada sale de acá como un error crudo
  try { return anotar(opts); } catch (e) {
    return { code: SALIDA.read, result: { ok: false, reason: `no pude anotar lo real: ${(e && (e.code || e.message)) || e}` } };
  }
}
function anotar({ storyPath, run, repo, home, hoursGiven, env }) {
  const mal = (message) => ({ code: SALIDA.invalid, result: { ok: false, reason: message } });
  if (hoursGiven) return mal('--hours no existe: las horas reales salen del registro de horas (la constancia de work-signal stop), no de un número escrito a mano');
  if (!storyPath) return mal('falta --story <spec>');
  if (!run) return mal('falta --run (la ejecución que cierra la historia: el sha del merge)');
  let texto;
  try { texto = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return mal(`no pude leer el spec ${storyPath}: ${(e && e.code) || e}`); }
  const id = require('./story-discovery.js').declaredStoryId(texto);
  if (!id) return mal(`el spec ${storyPath} no tiene story: en su frontmatter`);
  let ultima;
  let raiz;
  try {
    ultima = latest(home, storyPath);
    raiz = repoDe(storyPath, repo);
  } catch (e) { return { code: e.code || SALIDA.read, result: { ok: false, reason: e.message } }; }
  if (!ultima) return sinHoras('no hay constancia de horas: work-signal stop no corrió para esta historia, o no pudo dejarla (lo dijo en su aviso)');
  if (ultima.seconds === null) {
    return sinHoras(ultima.accion
      ? 'la herramienta de horas informa por una acción, sin segundos: esas horas no tienen constancia del arnés y no se anotan como real'
      : 'la herramienta de horas no informó tiempo (o no hay una elegida)');
  }
  const horas = Math.round(ultima.seconds / 36) / 100;
  if (!horas) return sinHoras('la herramienta de horas informó 0 segundos');
  const E = require(estimatesDe(env || process.env, home));
  try {
    // con la ruta del spec: dos historias del repo pueden tener el mismo id
    return { code: SALIDA.ok, result: E.run(['real', '--repo', raiz, '--story', String(id), '--spec', path.resolve(storyPath), '--hours', String(horas), '--run', String(run)]) };
  } catch (e) {
    // un error de la máquina (sin permiso, disco lleno) también se dice en una línea: el cierre no conoce otra salida
    if (e && typeof e.code === 'number') return { code: e.code, result: { ok: false, reason: e.message } };
    return { code: SALIDA.read, result: { ok: false, reason: `no pude anotar lo real: ${(e && (e.code || e.message)) || e}` } };
  }
}

module.exports = { record, latest, estimateReal, archivo };
