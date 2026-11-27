#!/usr/bin/env node
'use strict';
// state.js — anota y saca la entrada abierta de la sesión, y guarda el proyecto de una carpeta, en el estado del registro
// de horas (lib.js: `<estado>/active/<sesión>.json` y `<estado>/project-cache.json`).
//
// El estado vive en la carpeta del estado del arnés, y el freno de esa carpeta no deja escribirla con Write ni por
// consola: la escribe este comando. Escribe el archivo de la sesión del proceso (CLAUDE_CODE_SESSION_ID, TYCON_SESSION_ID
// o CODEX_SESSION_ID). Eso ordena el camino de siempre; no es un control: quien fija otra sesión en el ambiente escribe
// la de ésa. `--session` distinta de la del proceso se rechaza. La de una sesión muerta (sin latido hace más de
// `deadSessionMinutes`, la regla del barrido) se saca con `close --orphan <sesión>`.
//
//   node state.js open --entry <id> [--workspace <id>] [--project <id>] [--story <id> | --description <texto>]
//                      [--cwd <carpeta>] [--started <hora local>] [--source <contexto>]
//   node state.js close [--cwd <carpeta>] [--orphan <sesión muerta>]
//   node state.js cache --workspace <id> --project <id> [--name <proyecto>] [--cwd <carpeta>]
//   node state.js show [--cwd <carpeta>]
//
// `--cwd` es la carpeta del trabajo (por defecto, la actual); `close` y `show` la buscan subiendo por las carpetas madre,
// como el aviso de trabajo, y también en el archivo viejo único (active.json), del que la entrada se muda al de la sesión.
// Sin `--workspace` ni `--project`, `open` los toma del proyecto guardado de la carpeta. Sale 0 si anotó, 1 si no había
// nada que sacar o mostrar, 2 si el uso está mal o no pudo escribir.
// Casos: scripts/tests/clocki-state-dir.test.js (T5, T6).

const path = require('path');
const lib = require('./lib.js');

// las opciones cuyo valor es texto libre: lo que sigue se toma tal cual, aunque empiece con `--`
const TEXTO_LIBRE = new Set(['description', 'name', 'source']);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('--') && !TEXTO_LIBRE.has(k))) { out[k] = true; continue; }
    out[k] = v;
    i++;
  }
  return out;
}

const salir = (codigo, texto) => {
  if (texto) (codigo === 0 ? process.stdout : process.stderr).write(`${texto}\n`);
  process.exit(codigo);
};

const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
// un id de la herramienta o de una sesión: sin barras ni espacios, para que no arme otra ruta ni otro comando
const id = (v) => { const t = texto(v); return t && /^[A-Za-z0-9_.:-]{1,100}$/.test(t) ? t : null; };
// lo que no es un objeto llano (un archivo roto: `[]`, `null`) se lee como vacío
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** La entrada de `sesion` para `cwd`, subiendo por las carpetas madre: `{ clave, entry }` o null. La del archivo viejo se muda. */
function buscar(sesion, cwd) {
  const found = lib.findActiveEntryForCwd(lib.readActive(), cwd, sesion);
  if (!found) return null;
  const suyo = objeto(lib.readSessionActive(sesion));
  if (!suyo[found.matchedKey]) lib.migrateLegacyEntry(sesion, found.matchedKey, found.entry);
  return { clave: found.matchedKey, entry: found.entry };
}

function main(argv) {
  const a = args(argv);
  const cmd = a._[0];
  if (!['open', 'close', 'cache', 'show'].includes(cmd)) salir(2, 'uso: state.js open --entry <id> … | close [--orphan <sesión>] | cache --workspace <id> --project <id> | show   [--cwd <carpeta>]');
  if (lib.stateMissing()) salir(2, 'clocki: no sé dónde guardar el estado: no anoto nada');
  const propia = process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || null;
  if (!propia) salir(2, 'clocki: no sé de qué sesión es este proceso (falta CLAUDE_CODE_SESSION_ID): no anoto nada');
  if (a.session !== undefined && a.session !== propia) salir(2, 'clocki: una sesión anota sólo su propio archivo: --session de otra no se acepta');
  const cwd = lib.normalizeCwd(path.resolve(texto(a.cwd) || process.cwd()));

  if (cmd === 'cache') {
    const workspaceId = id(a.workspace);
    const projectId = id(a.project);
    if (!workspaceId || !projectId) salir(2, 'clocki: cache pide --workspace y --project (ids sin espacios ni barras)');
    const cache = objeto(lib.readJson(lib.CACHE_PATH, {}));
    cache[cwd] = { workspaceId, projectId, ...(texto(a.name) ? { matchedName: texto(a.name).slice(0, 200) } : {}), matchedAt: new Date().toISOString() };
    lib.writeJsonAtomic(lib.CACHE_PATH, cache);
    salir(0, `clocki: proyecto de ${cwd} guardado (${projectId})`);
  }

  if (cmd === 'show') {
    const f = buscar(propia, cwd);
    if (!f) salir(1, `clocki: no hay entrada abierta de esta sesión en ${cwd}`);
    salir(0, JSON.stringify({ cwd: f.clave, ...f.entry }));
  }

  if (cmd === 'close') {
    let sesion = propia;
    if (a.orphan !== undefined) {
      sesion = id(a.orphan);
      if (!sesion || sesion === propia) salir(2, 'clocki: --orphan pide la sesión muerta (otra, no la tuya)');
      const muerta = Number((objeto(lib.readSettings()).deadSessionMinutes)) || 120;
      const quieta = lib.heartbeatIdleMinutes(sesion);
      if (!(quieta > muerta)) salir(2, `clocki: la sesión ${sesion} no está muerta (su último latido fue hace ${Math.round(quieta)} min; muerta es más de ${muerta}): su entrada la saca ella`);
    }
    const f = buscar(sesion, cwd);
    if (!f) salir(1, `clocki: no hay entrada abierta de ${sesion === propia ? 'esta sesión' : `la sesión ${sesion}`} en ${cwd}: no saco nada`);
    const suyo = objeto(lib.readSessionActive(sesion));
    delete suyo[f.clave];
    lib.writeSessionActive(sesion, suyo);
    salir(0, `clocki: entrada ${f.entry.entryId} sacada de ${f.clave}`);
  }

  // open
  const entryId = id(a.entry);
  if (!entryId) salir(2, 'clocki: open pide --entry <id de la entrada que devolvió la herramienta>');
  const ahora = lib.nowIso();
  const started = texto(a.started);
  if (started && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(started)) salir(2, 'clocki: --started va en hora local, AAAA-MM-DDTHH:MM:SS, sin zona');
  const suyo = objeto(lib.readSessionActive(propia));
  const previa = suyo[cwd] && typeof suyo[cwd] === 'object' ? suyo[cwd] : null;
  if (previa && previa.entryId !== entryId) {
    salir(2, `clocki: ya hay otra entrada abierta de esta sesión en ${cwd} (${previa.entryId}): cerrala en la herramienta y sacala con state.js close antes`);
  }
  const guardado = objeto(objeto(lib.readJson(lib.CACHE_PATH, {}))[cwd]);
  const historia = id(a.story);
  const descripcion = texto(a.description) || (historia ? `Story ${historia}` : null) || (previa && previa.description) || '';
  const ws = id(a.workspace) || (previa && previa.workspaceId) || id(guardado.workspaceId);
  const pr = id(a.project) || (previa && previa.projectId) || id(guardado.projectId);
  suyo[cwd] = {
    entryId,
    ...(ws ? { workspaceId: ws } : {}),
    ...(pr ? { projectId: pr } : {}),
    description: String(descripcion).slice(0, 200),
    startedAt: started || (previa && previa.startedAt) || ahora,
    lastActivity: ahora,
    source: (texto(a.source) || (previa && previa.source) || 'state.js').slice(0, 100),
  };
  lib.writeSessionActive(propia, suyo);
  salir(0, `clocki: entrada ${entryId} anotada en ${cwd}`);
}

try { main(process.argv.slice(2)); } catch (e) {
  salir(2, `clocki: no pude escribir el estado (${(e && e.code) || (e && e.message) || 'error'})`);
}
