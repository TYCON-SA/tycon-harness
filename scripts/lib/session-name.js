'use strict';
/**
 * session-name.js — el nombre de una sesión por su id, con los lectores de /wip (scripts/tools/work-in-progress.js).
 *
 * En Claude, el nombre del archivo de sesión (`<claude>/sessions/<pid>.json`, con el id adentro, en `sessionId`) y, sin
 * archivo, el último /rename de su conversación (`custom-title`). Si Claude no conoce la sesión, el nombre que le puso la
 * persona en Codex (`threads.name` de su base). Se mira sólo la entrada de esta sesión: un archivo roto de otra no
 * cambia nada. Un nombre armado de la carpeta (`nameSource: "derived"`) cuenta como sin nombre, como en la coordinadora.
 *
 *   nombreDeSesion({ sid, home, codexHome }) → { nombre, cortado, fuente, problema }
 *     nombre   en una línea y de hasta 40 caracteres (como /wip), o null
 *     cortado  true si el original era más largo
 *     fuente   'claude', 'codex' o null
 *     problema un código de una lista cerrada, nunca un texto: 'carpeta-ilegible', 'codex-ilegible' o null
 *   conSesion(lista, entrada) → la lista de sesiones de una corrida con la entrada puesta al día: una por id, hasta 10;
 *     salen las de `visto` más viejo
 *
 * Nunca tira.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const wip = require('../tools/work-in-progress.js');
const { claudeDir } = require('../../skills/tycon-pipeline/scripts/lib/state-dir.js');

const PROBLEMAS = ['carpeta-ilegible', 'codex-ilegible'];
const TOPE_SESIONES = 10;

// El último /rename de una sesión sin archivo de sesión: su conversación está en la carpeta del proyecto donde arrancó,
// que no se sabe; se busca en todas. El nombre de la carpeta ya viene con la forma que espera el lector de /wip.
function tituloSinArchivo(projectsDir, sid) {
  let carpetas;
  try { carpetas = fs.readdirSync(projectsDir); } catch (_e) { return null; }
  for (const c of carpetas) {
    if (!fs.existsSync(path.join(projectsDir, c, `${sid}.jsonl`))) continue;
    const t = wip.sessionTitle(projectsDir, c, sid, []);
    if (t) return t;
  }
  return null;
}

function resultado(nombre, fuente, problema = null) {
  const cortado = !!nombre && nombre.endsWith('…') && Array.from(nombre).length === wip.NAME_MAX;
  return { nombre: nombre || null, cortado, fuente: nombre ? fuente : null, problema: PROBLEMAS.includes(problema) ? problema : null };
}

function nombreDeSesion(opts = {}) {
  try {
    const sid = typeof opts.sid === 'string' ? opts.sid : '';
    if (!wip.SAFE_SID.test(sid)) return resultado(null, null);
    const home = opts.home || os.homedir();
    const claude = claudeDir(home);
    const sessionsDir = path.join(claude, 'sessions');
    const projectsDir = path.join(claude, 'projects');
    const ilegibles = [];
    const sesiones = wip.sessionsBySid(sessionsDir, ilegibles, projectsDir);
    // la carpeta entera ilegible es un problema; un archivo roto de otra sesión, no
    const carpeta = ilegibles.some((l) => String(l).startsWith(`${sessionsDir}: `));
    const s = sesiones.get(sid);
    if (s) return resultado(s.nameSource === 'derived' ? null : s.name, 'claude');
    const titulo = tituloSinArchivo(projectsDir, sid);
    if (titulo) return resultado(titulo, 'claude');
    const deCodex = [];
    const codex = wip.codexNames(opts.codexHome || path.join(home, '.codex'), deCodex);
    const nombre = codex.get(sid) || null;
    if (nombre) return resultado(nombre, 'codex');
    return resultado(null, null, carpeta ? 'carpeta-ilegible' : (deCodex.length ? 'codex-ilegible' : null));
  } catch (_e) {
    return resultado(null, null);
  }
}

function conSesion(lista, entrada) {
  const previas = Array.isArray(lista) ? lista.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id !== entrada.id) : [];
  const nueva = { id: entrada.id, nombre: entrada.nombre || null, visto: entrada.visto, ...(entrada.cortado ? { cortado: true } : {}) };
  const todas = [...previas, nueva].sort((a, b) => String(a.visto || '').localeCompare(String(b.visto || '')));
  return todas.slice(-TOPE_SESIONES);
}

module.exports = { nombreDeSesion, conSesion, PROBLEMAS, TOPE_SESIONES };
