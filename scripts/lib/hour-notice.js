'use strict';
/**
 * hour-notice.js — el recordatorio de la hora de fin: una sesión sin ejecución abierta que no anotó a qué hora termina sale
 * en la oficina «sin hora estimada», aunque la haya dicho en un mensaje. Lo dice blocking-notice.js con el mensaje de la persona:
 * nunca frena, y si no hace falta no dice nada.
 *
 * Tiene su hora la nota con `--until` que todavía no pasó y el arreglo rápido con su hora; quien anotó `--waiting-for` no la
 * necesita. Se repite cada media hora mientras falte, sin insistir en cada mensaje. Off: TYCON_HOUR_NOTICE=0.
 */
const fs = require('fs');
const path = require('path');

const REPEAT_MS = 30 * 60000;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** El texto del recordatorio, o null si no hace falta. `stateDir` es la carpeta del estado; deja anotado que avisó. */
function hourNotice({ stateDir, sessionId, markerJs, env = process.env, now = Date.now() }) {
  if (env.TYCON_HOUR_NOTICE === '0' || !sessionId || sessionId === '_nosession') return null;
  const safe = String(sessionId).replace(/[/\\]/g, '_');
  // sólo la sesión que la oficina muestra: la que tiene su archivo de estado
  if (!fs.existsSync(path.join(stateDir, 'sessions', `${safe}.json`))) return null;
  // con una ejecución abierta, la hora la da su paso
  if (fs.existsSync(path.join(stateDir, 'active', `${safe}.json`))) return null;
  const note = readJson(path.join(stateDir, 'doing', `${safe}.json`)) || {};
  if (note.waitingFor) return null;
  const adhoc = readJson(path.join(stateDir, 'adhoc', `${safe}.json`)) || {};
  const hours = [Date.parse(note.endAt), Date.parse(adhoc.until)].filter(Number.isFinite);
  if (hours.some((h) => h >= now)) return null;
  const stamp = path.join(stateDir, 'hour-notice', safe);
  try { if (now - fs.statSync(stamp).mtimeMs < REPEAT_MS) return null; } catch { /* todavía no avisó */ }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, '');
  const cmd = `node ${markerJs} doing`;
  return `hora: ${hours.length ? 'la hora de fin que anotó esta sesión ya pasó' : 'esta sesión no anotó a qué hora termina'}, y la oficina no la sabe aunque se diga en un mensaje. ` +
    `Si va a trabajar, anotala: ${cmd} "<qué hago>" --until HH:MM (si cambia, ${cmd} --until HH:MM). ` +
    `Si espera a otra sesión: ${cmd} "<qué hago>" --waiting-for "<qué espera>". Si es una pregunta suelta, ignoralo.`;
}

module.exports = { hourNotice, REPEAT_MS };
