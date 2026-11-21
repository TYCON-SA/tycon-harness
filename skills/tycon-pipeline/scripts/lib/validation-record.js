'use strict';
// validation-record.js — la constancia de la última validación de una historia, antes de programar.
//
// La deja `pipeline.js validation-record` en la carpeta de estado del arnés, donde el agente no escribe, al cerrar
// «Validar la historia» o la creación de la historia. Lleva el resultado (verde: sin CRITICAL; rojo: con alguno) y los
// validadores que corrieron. Vale mientras la huella de la historia sea la misma, con la misma huella que la revisión
// previa (story-review-record.js): el avance del trabajo no la invalida y un criterio cambiado sí. Con la constancia
// vigente y en verde, `validators` no vuelve a lanzar los validadores que ya corrieron sobre esa misma historia.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { stateDir } = require('./state-dir.js');
const { huella } = require('./story-review-record.js');

const RECORD_DIR = 'story-validations';
const RESULTS = ['verde', 'rojo'];

function realPath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

const archivoDeClave = (home, texto) => path.join(stateDir(home), RECORD_DIR, `${crypto.createHash('sha256').update(texto).digest('hex').slice(0, 32)}.json`);

/** El repo de la historia: su remota `origin` normalizada o, sin `origin`, la ruta real de su raíz. null sin git. */
function repoDe(storyReal) {
  const git = (args) => {
    const r = spawnSync('git', ['-C', path.dirname(storyReal), ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const raiz = git(['rev-parse', '--show-toplevel']);
  if (!raiz) return null;
  const raizReal = realPath(raiz) || raiz;
  let origin = git(['config', '--get', 'remote.origin.url']);
  // una remota local («../x.git», «file://…») es una carpeta: relativa, nombra otra cosa en cada repo
  const local = origin && !/^(?:https?|ssh|git):\/\//i.test(origin) && !/^(?:[^@/]+@)?[^/:]{2,}:(?!\/)/.test(origin);
  if (local) origin = realPath(path.resolve(raizReal, origin.replace(/^file:\/\//i, ''))) || path.resolve(raizReal, origin.replace(/^file:\/\//i, ''));
  const forma = origin ? require('./adhoc-base.js').formaDeLaRemota(origin) : '';
  return { repo: forma || raizReal, rel: path.relative(raizReal, storyReal).split(path.sep).join('/') };
}

/**
 * La clave de una historia: su repo y su ruta dentro del repo, así la constancia escrita en una copia vale en otra del
 * mismo repo. null fuera de git. La usa también la constancia de la revisión previa (story-review-record.js).
 */
function claveDeHistoria(storyPath) {
  const r = repoDe(realPath(storyPath) || path.resolve(storyPath));
  return r ? `${r.repo}\n${r.rel}` : null;
}

/**
 * La constancia de una historia, por su clave. Una historia fuera de git usa la clave de antes (la ruta real), la misma
 * que `readRecord` busca después de la nueva.
 */
function recordFile(home, storyPath) {
  const clave = claveDeHistoria(storyPath);
  return clave ? archivoDeClave(home, clave) : recordFileViejo(home, storyPath);
}

/** La clave de antes: la ruta real de la historia. Las constancias escritas así se siguen leyendo. */
function recordFileViejo(home, storyPath) {
  return archivoDeClave(home, realPath(storyPath) || path.resolve(storyPath));
}

/** Los problemas de una constancia por escribir; [] si está bien. */
function problemas(datos) {
  const out = [];
  if (!RESULTS.includes(datos.resultado)) out.push(`--result tiene que ser ${RESULTS.join(' · ')} (es ${JSON.stringify(datos.resultado)})`);
  if (!Array.isArray(datos.validadores) || !datos.validadores.length || datos.validadores.some((v) => !/^[\w:-]+$/.test(String(v)))) {
    out.push('--validators tiene que nombrar los validadores que corrieron, separados por coma');
  }
  return out;
}

/** Escribe la constancia. `datos`: { resultado, validadores }. Lanza con los problemas si no vale (no escribe nada). */
function writeRecord(home, storyPath, datos) {
  const texto = fs.readFileSync(storyPath, 'utf8');
  const rec = {
    path: realPath(storyPath),
    resultado: datos.resultado,
    validadores: Array.isArray(datos.validadores) ? [...new Set(datos.validadores)] : datos.validadores,
    huella: huella(texto),
    hora: new Date().toISOString(),
  };
  const p = problemas(rec);
  if (p.length) { const e = new Error(p.join('\n')); e.problemas = p; throw e; }
  const f = recordFile(home, storyPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`);
  return f;
}

/** La constancia y su estado: none (no hay, o ilegible: ante la duda, se valida) · stale (la historia cambió) · current. */
function readRecord(home, storyPath) {
  // la clave nueva primero; después la de antes, mientras quede alguna constancia escrita así
  const leer = (f) => { try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); return r && !problemas(r).length ? r : null; } catch { return null; } };
  const nueva = recordFile(home, storyPath);
  const vieja = recordFileViejo(home, storyPath);
  const record = leer(nueva) || (vieja !== nueva ? leer(vieja) : null);
  if (!record) return { estado: 'none', record: null };
  let actual = null;
  try { actual = huella(fs.readFileSync(storyPath, 'utf8')); } catch { actual = null; }
  return { estado: actual && actual === record.huella ? 'current' : 'stale', record };
}

/**
 * Saca de la salida de `validators` los validadores que ya corrieron en verde sobre esta misma historia. Un validador
 * que no está en la constancia (uno de un paquete que se activó después, por ejemplo) se lanza igual.
 */
function omitirVigentes(salida, leida) {
  const ok = leida && leida.estado === 'current' && leida.record && leida.record.resultado === 'verde';
  const ya = new Set(ok ? leida.record.validadores : []);
  const omitidos = salida.validadores.filter((v) => ya.has(v));
  return {
    validadores: salida.validadores.filter((v) => !ya.has(v)),
    lanzamientos: salida.lanzamientos.filter((l) => !ya.has(l.agente)),
    omitidos,
  };
}

/** El renglón para el log del paso, o null si no se omite nada. */
function linea(leida, omitidos) {
  if (!omitidos.length) return null;
  return `validación previa vigente: verde, ${leida.record.hora}, no se vuelve a lanzar ${omitidos.join(', ')}`;
}

module.exports = { RECORD_DIR, RESULTS, claveDeHistoria, recordFile, recordFileViejo, problemas, writeRecord, readRecord, omitirVigentes, linea };
