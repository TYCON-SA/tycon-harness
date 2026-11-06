'use strict';
/**
 * Cuándo una excepción de `pending-live-handles.json` ampara una prueba. Es la ÚNICA regla: la usan el detector (que
 * decide si una prueba con algo vivo falla) y el informe (que dice el estado de cada entrada). Si fueran dos, una
 * entrada que vence hoy podría salir amparada en jest y vencida en el informe.
 *
 * Una entrada: { form, file, test, reason, expires }. `file` es la ruta del archivo de prueba desde la carpeta del
 * formulario; `test`, el nombre completo de la prueba (el de `expect.getState().currentTestName`); `expires`, AAAA-MM-DD.
 * Ampara sólo si tiene `reason` y `expires`, y `expires` es hoy o después.
 */
const fs = require('fs');

/** AAAA-MM-DD y además una fecha que existe (el 30 de febrero no es una fecha: ampararía más de lo escrito). */
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Hoy como AAAA-MM-DD; `LIVE_HANDLES_TODAY` lo fija (para las pruebas). */
function today(env = process.env) {
  return isDate(env.LIVE_HANDLES_TODAY) ? env.LIVE_HANDLES_TODAY : new Date().toISOString().slice(0, 10);
}

const normalize = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');

/** `{ entries, error }`: sin ruta o sin archivo, ninguna entrada; ilegible, el motivo. */
function read(file) {
  if (!file || !fs.existsSync(file)) return { entries: [], error: null };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.entries)) {
      return { entries: [], error: `${file} tiene que ser { "entries": [ ... ] }: ninguna excepción ampara` };
    }
    return { entries: d.entries, error: null };
  } catch (e) {
    return { entries: [], error: `no pude leer ${file}: ${e.message}` };
  }
}

/** El estado de una entrada: `{ state: 'current' | 'expired' | 'malformed', why }`. */
function status(entry, day) {
  const missing = ['form', 'file', 'test', 'reason', 'expires'].filter((k) => !entry || typeof entry[k] !== 'string' || !entry[k].trim());
  if (missing.length) return { state: 'malformed', why: `falta ${missing.join(', ')}` };
  if (!isDate(entry.expires)) return { state: 'malformed', why: `expires no es una fecha AAAA-MM-DD («${entry.expires}»)` };
  if (entry.expires < day) return { state: 'expired', why: `venció el ${entry.expires}` };
  return { state: 'current', why: `vigente hasta el ${entry.expires}` };
}

/** La entrada vigente que ampara esta prueba de este archivo de este formulario, o null. */
function excuses(entries, { form, file, test }, day) {
  return entries.find((e) => status(e, day).state === 'current'
    && e.form === form && normalize(e.file) === normalize(file) && e.test === test) || null;
}

module.exports = { today, read, status, excuses, normalize, isDate };
