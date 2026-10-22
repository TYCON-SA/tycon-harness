'use strict';
// story-review-record.js — la constancia de la revisión adversarial de una historia antes de programar.
//
// La deja `pipeline.js story-review-record` en la carpeta de estado del arnés, donde el agente no escribe (el portón
// de escrituras niega esa carpeta): una marca en la historia se podría escribir a mano y no probaría nada. Se guarda
// por la ruta real de la historia, como la de first-time-record.js. Vale mientras la huella de la historia sea la misma;
// la huella ignora lo que el avance del trabajo cambia (el Change Log, el Dev Agent Record, los follow-ups de los
// revisores y el estado), así una corrida no invalida la revisión y un criterio cambiado sí.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('./state-dir.js');

const RECORD_DIR = 'story-reviews';
const RESULTS = ['limpio', 'corregido', 'preguntado', 'saltado', 'pendiente', 'no-medido'];
const MOTIVOS = ['riesgo-bajo', 'apagado'];
const DESTINOS = ['corregido', 'preguntado', 'descartado'];
// las secciones que cambian con el avance del trabajo, a cualquier nivel de título
const SECCIONES_DE_AVANCE = ['change log', 'dev agent record', 'review follow-ups (advisors)'];

// `.native` devuelve las mayúsculas guardadas en el disco: en uno que no las distingue, la misma historia escrita de
// dos formas tiene una sola constancia
function realPath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function recordFile(home, storyPath) {
  const real = realPath(storyPath) || path.resolve(storyPath);
  const key = crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
  return path.join(stateDir(home), RECORD_DIR, `${key}.json`);
}

/**
 * La huella de la historia sin lo que cambia con el avance: las secciones de avance, los `status:` del frontmatter
 * (también el de cada tanda de `pipelines:`), la línea `Status:` de la historia y el tilde de las casillas. Dentro de
 * un bloque de código nada es título ni estado: un ejemplo cuenta como texto.
 */
function huella(texto) {
  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  const fuera = [];
  let enFrontmatter = lineas[0] === '---';
  let cerca = null;   // la marca del bloque de código abierto (``` o ~~~), o null
  let salto = 0;      // nivel del título de la sección que se está salteando (0 = ninguna)
  let statusVisto = false;
  lineas.forEach((l, i) => {
    if (enFrontmatter) {
      if (i > 0 && l === '---') enFrontmatter = false;
      else if (/^\s*status:/.test(l)) return;
      fuera.push(l);
      return;
    }
    const valla = l.match(/^\s*(`{3,}|~{3,})/);
    if (valla) cerca = cerca === null ? valla[1][0] : (valla[1][0] === cerca ? null : cerca);
    else if (cerca === null) {
      const t = l.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (t) {
        const nivel = t[1].length;
        if (salto && nivel <= salto) salto = 0;
        if (!salto && SECCIONES_DE_AVANCE.includes(t[2].toLowerCase())) { salto = nivel; return; }
      }
      if (!salto && !statusVisto && /^Status:\s/.test(l)) { statusVisto = true; return; }
    }
    if (salto) return;
    fuera.push(cerca === null ? l.replace(/^(\s*[-*]\s+)\[[xX ]\]/, '$1[ ]') : l);
  });
  return crypto.createHash('sha256').update(fuera.join('\n').trim()).digest('hex');
}

/** Los problemas de una constancia por escribir; [] si está bien. */
function problemas(datos) {
  const out = [];
  if (!RESULTS.includes(datos.resultado)) out.push(`--result tiene que ser ${RESULTS.join(' · ')} (es ${JSON.stringify(datos.resultado)})`);
  if (datos.resultado === 'saltado' && !MOTIVOS.includes(datos.motivo)) out.push(`un salteo lleva --reason ${MOTIVOS.join(' · ')} (es ${JSON.stringify(datos.motivo)})`);
  if (datos.resultado !== 'saltado' && datos.motivo != null) out.push('--reason va sólo con --result saltado');
  if (!Array.isArray(datos.hallazgos)) out.push('--findings tiene que ser una lista JSON');
  else datos.hallazgos.forEach((h, i) => {
    if (!h || typeof h !== 'object' || !/^SADV-[CW]\d+$/.test(String(h.regla || ''))) out.push(`hallazgo ${i}: falta la regla (SADV-…)`);
    else if (!DESTINOS.includes(h.destino)) out.push(`hallazgo ${i}: destino tiene que ser ${DESTINOS.join(' · ')}`);
  });
  for (const k of ['tokens', 'duracion_ms']) {
    if (datos[k] != null && !(Number.isInteger(datos[k]) && datos[k] >= 0)) out.push(`${k} tiene que ser un entero ≥ 0`);
  }
  return out;
}

/**
 * Escribe la constancia. `datos`: { resultado, motivo?, hallazgos?, modelo?, model_reason?, tokens?, duracion_ms?,
 * riesgo? }. Lanza con los problemas si no vale (no escribe nada).
 */
function writeRecord(home, storyPath, datos) {
  const texto = fs.readFileSync(storyPath, 'utf8');
  const rec = {
    path: realPath(storyPath),
    resultado: datos.resultado,
    motivo: datos.motivo == null ? null : datos.motivo,
    hallazgos: datos.hallazgos == null ? [] : datos.hallazgos,
    modelo: datos.modelo || null,
    model_reason: datos.model_reason || null,
    huella: huella(texto),
    hora: new Date().toISOString(),
    duracion_ms: datos.duracion_ms == null ? null : datos.duracion_ms,
    tokens: datos.tokens == null ? null : datos.tokens,
    riesgo: datos.riesgo || null,
  };
  // lo que no se midió es null y se dice: un cero se leería como «no gastó nada»
  rec.medido = rec.tokens !== null && rec.duracion_ms !== null;
  const p = problemas(rec);
  if (p.length) { const e = new Error(p.join('\n')); e.problemas = p; throw e; }
  const f = recordFile(home, storyPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`);
  return f;
}

/**
 * La constancia de una historia y su estado: none (no hay) · unmeasured (no-medido: no cuenta) · stale (la historia
 * cambió) · current. Una constancia ilegible es none: ante la duda, se revisa.
 */
function readRecord(home, storyPath) {
  let record;
  try { record = JSON.parse(fs.readFileSync(recordFile(home, storyPath), 'utf8')); } catch { return { estado: 'none', record: null }; }
  if (!record || !RESULTS.includes(record.resultado)) return { estado: 'none', record: null };
  if (record.resultado === 'no-medido') return { estado: 'unmeasured', record };
  let actual = null;
  try { actual = huella(fs.readFileSync(storyPath, 'utf8')); } catch { actual = null; }
  return { estado: actual && actual === record.huella ? 'current' : 'stale', record };
}

/** Lo que va al volcado de la corrida: null sin constancia; los hallazgos contados por regla y por destino. */
function resumenVolcado(home, storyPath) {
  if (!storyPath) return null;
  const { record } = readRecord(home, storyPath);
  if (!record) return null;
  const contar = (campo) => record.hallazgos.reduce((acc, h) => { acc[h[campo]] = (acc[h[campo]] || 0) + 1; return acc; }, {});
  return {
    resultado: record.resultado,
    modelo: record.modelo,
    hallazgos: { total: record.hallazgos.length, por_regla: contar('regla'), por_destino: contar('destino') },
    duracion_ms: record.duracion_ms,
    tokens: record.tokens,
    medido: record.medido,
  };
}

module.exports = { RECORD_DIR, RESULTS, MOTIVOS, DESTINOS, huella, recordFile, problemas, writeRecord, readRecord, resumenVolcado };
