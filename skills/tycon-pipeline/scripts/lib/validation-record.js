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
const { stateDir } = require('./state-dir.js');
const { huella } = require('./story-review-record.js');

const RECORD_DIR = 'story-validations';
const RESULTS = ['verde', 'rojo'];

function realPath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function recordFile(home, storyPath) {
  const real = realPath(storyPath) || path.resolve(storyPath);
  const key = crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
  return path.join(stateDir(home), RECORD_DIR, `${key}.json`);
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
  let record;
  try { record = JSON.parse(fs.readFileSync(recordFile(home, storyPath), 'utf8')); } catch { return { estado: 'none', record: null }; }
  if (!record || problemas(record).length) return { estado: 'none', record: null };
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

module.exports = { RECORD_DIR, RESULTS, recordFile, problemas, writeRecord, readRecord, omitirVigentes, linea };
