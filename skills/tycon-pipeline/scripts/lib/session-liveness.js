'use strict';
// session-liveness.js — si una sesión de Claude Code vive, por su registro en <carpeta de Claude>/sessions/*.json
// ({ sessionId, pid }). La usan marker.js (clear-session, adhoc clear-orphan) y lib/finished-open.js (el aviso de lo
// terminado sin cerrar), que no puede importar marker.js porque es un comando.
//
// Tres respuestas:
//   { alive: true, pid }                     su registro, con un proceso vivo
//   { alive: false, pid }                    su registro, con un proceso que ya no existe
//   { alive: false, sinRegistro: true }      sin registro: una sesión cerrada, o de Codex, que no lo escribe
//   { unknown: '<motivo>' }                  la carpeta o un registro no se pudo leer
// marker.js trata «sin registro» como muerta, como siempre; el aviso dice que no sabe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeDir } = require('./state-dir.js');

const procesoVivo = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function liveness(sid, { home = os.homedir(), isAlive = procesoVivo } = {}) {
  const dir = path.join(claudeDir(home), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return { alive: false, sinRegistro: true };
    return { unknown: `${dir}: ${e.message}` };
  }
  // se leen todos antes de decidir: un registro vivo de la sesión gana; uno ilegible (puede ser el suyo, a medio escribir)
  // da «no se sabe» sólo si no apareció el vivo. Así la respuesta no depende del orden de la carpeta
  let muerta = null;
  let ilegible = null;
  for (const n of names.sort()) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { ilegible = ilegible || `${path.join(dir, n)}: ${e.message}`; continue; }
    if (!s || s.sessionId !== sid) continue;
    const pid = Number(s.pid);
    if (!Number.isInteger(pid) || pid <= 0) { ilegible = ilegible || `${path.join(dir, n)}: pid ilegible`; continue; }
    if (isAlive(pid)) return { alive: true, pid };
    muerta = muerta || { alive: false, pid };
  }
  if (ilegible) return { unknown: ilegible };
  return muerta || { alive: false, sinRegistro: true };
}

/**
 * Las carpetas donde trabaja una sesión viva: { cwds, ilegibles } o { unknown: '<motivo>' } si la carpeta de registros no
 * se lee. `ilegibles`: los registros que no se pudieron leer (uno a medio escribir puede ser de una sesión viva).
 */
function liveCwds({ home = os.homedir(), isAlive = procesoVivo } = {}) {
  const dir = path.join(claudeDir(home), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    return e.code === 'ENOENT' ? { cwds: [], ilegibles: 0 } : { unknown: `${dir}: ${e.message}` };
  }
  const cwds = [];
  let ilegibles = 0;
  for (const n of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { ilegibles += 1; continue; }
    const pid = Number(s && s.pid);
    if (s && typeof s.cwd === 'string' && Number.isInteger(pid) && pid > 0 && isAlive(pid)) cwds.push(s.cwd);
  }
  return { cwds, ilegibles };
}

module.exports = { liveness, liveCwds };
