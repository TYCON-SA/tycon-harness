'use strict';
/**
 * Los agentes de fondo que una sesión lanzó y que no escriben hace rato. Una sesión que espera a su propio agente queda
 * quieta, y si el agente se trabó (un comando que nunca vuelve, un permiso que no le sale a nadie) nadie se entera: la
 * sesión no lo ve y la coordinadora la ve «esperando». Acá se lee el final de la conversación de la sesión (qué agentes
 * lanzó que no avisaron que terminaron) y la fecha del archivo de cada uno en `<conversación>/subagents/`.
 */
const fs = require('fs');
const path = require('path');
const T = require('./session-transcript.js');

// el final de la conversación que se lee: los agentes lanzados y sus avisos de fin quedan ahí
const TAIL_BYTES = 512 * 1024;
const SAFE = /^[A-Za-z0-9_-]+$/;
// por conversación: la marca (fecha y tamaño) con que se leyó y los agentes pendientes que tenía
const LEIDOS = new Map();

/** La carpeta de conversaciones de un cwd, como la arma Claude Code. */
const projectDirOf = (projectsDir, cwd) => path.join(projectsDir, String(cwd).replace(/[^A-Za-z0-9-]/g, '-'));

function tailLines(file) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    if (len) fs.readSync(fd, buf, 0, len, st.size - len);
    return T.wholeLines(buf.toString('utf8'), st.size > len, false);
  } finally { fs.closeSync(fd); }
}

// el último paso del agente: la herramienta de su último mensaje, o null
function lastToolOf(file) {
  let lines;
  try { lines = tailLines(file); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    const content = d && d.type === 'assistant' && d.message && Array.isArray(d.message.content) ? d.message.content : null;
    const tool = content && [...content].reverse().find((c) => c && c.type === 'tool_use');
    if (tool) return String(tool.name || '').slice(0, 40) || null;
  }
  return null;
}

/**
 * `{ pendientes, callados: [{ agente, minutos, herramienta }] }` de la sesión `sid` (que corre en `cwd`), o `{ problem }`
 * si no se pudo leer su conversación. `pendientes`: agentes lanzados sin aviso de fin (los comandos de fondo, sin archivo
 * de agente, no cuentan). `callados`: los pendientes cuyo archivo no cambió en `calladoMs`.
 */
function silentAgents({ projectsDir, cwd, sid, now = Date.now(), calladoMs }) {
  if (!projectsDir || typeof cwd !== 'string' || !cwd || !SAFE.test(String(sid))) return { pendientes: 0, callados: [] };
  const dir = projectDirOf(projectsDir, cwd);
  const conversacion = path.join(dir, `${sid}.jsonl`);
  // los agentes lanzados sin aviso de fin, leídos de nuevo sólo si la conversación cambió (owner-wait mira cada 2 s)
  let ids;
  try {
    const st = fs.statSync(conversacion);
    const marca = `${st.mtimeMs}:${st.size}`;
    const guardado = LEIDOS.get(conversacion);
    if (guardado && guardado.marca === marca) ids = guardado.ids;
    else {
      ids = [...T.backgroundPendingIds(tailLines(conversacion))];
      LEIDOS.set(conversacion, { marca, ids });
    }
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { pendientes: 0, callados: [] };
    return { problem: `no pude leer la conversación de ${sid} (${e.code || e.message})` };
  }
  let pendientes = 0;
  const callados = [];
  for (const id of ids) {
    if (!SAFE.test(id)) continue;
    const archivo = path.join(dir, String(sid), 'subagents', `agent-${id}.jsonl`);
    let st;
    try { st = fs.statSync(archivo); } catch { continue; }
    pendientes += 1;
    if (now - st.mtimeMs >= calladoMs) callados.push({ agente: id, minutos: Math.floor((now - st.mtimeMs) / 60000), herramienta: lastToolOf(archivo) });
  }
  return { pendientes, callados };
}

/** Si algún archivo de agente de `root` (o de un lote de flujo, en `root/workflows/<lote>`) cambió en los últimos `ms`. */
function agentWroteSince(root, now, ms) {
  const fresh = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return false; }
    return names.some((n) => /^agent-.*\.jsonl$/.test(n) && (() => { try { return now - fs.statSync(path.join(dir, n)).mtimeMs < ms; } catch { return false; } })());
  };
  if (fresh(root)) return true;
  let lotes;
  try { lotes = fs.readdirSync(path.join(root, 'workflows')); } catch { return false; }
  return lotes.some((l) => fresh(path.join(root, 'workflows', l)));
}

// Claude Code corta el nombre de la carpeta de un cwd largo a 200 caracteres y le suma una marca al final: la conversación
// se busca por ese principio. null si no está
const DIR_NAME_MAX = 200;
function conversationFile(projectsDir, cwd, sid) {
  const name = String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  const direct = path.join(projectsDir, name, `${sid}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  if (name.length <= DIR_NAME_MAX) return null;
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  const prefix = name.slice(0, DIR_NAME_MAX);
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${sid}.jsonl`);
    if (d.startsWith(prefix) && fs.existsSync(file)) return file;
  }
  return null;
}

// por conversación: la marca (fecha y tamaño) con que se leyó y la hora de su último paso propio
const OWN_LEIDOS = new Map();
// La hora del último paso de la sesión: un mensaje suyo o el resultado de una herramienta suya. Lo que Claude Code agrega
// solo (un mensaje que le llega, el aviso de una tarea de fondo) también toca el archivo y no es la sesión trabajando.
// null si no hay ninguno en el final o no se pudo leer
function lastOwnAt(file, st) {
  const mark = `${st.mtimeMs}:${st.size}`;
  const prev = OWN_LEIDOS.get(file);
  if (prev && prev.mark === mark) return prev.at;
  let at = null;
  let lines;
  try { lines = tailLines(file); } catch { return null; }
  for (let i = lines.length - 1; i >= 0 && at == null; i -= 1) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (!d || d.isSidechain) continue;
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
    const own = d.type === 'assistant' || (d.type === 'user' && (d.toolUseResult !== undefined || content.some((c) => c && c.type === 'tool_result')));
    const t = own ? Date.parse(d.timestamp) : NaN;
    if (Number.isFinite(t)) at = t;
  }
  OWN_LEIDOS.set(file, { mark, at });
  return at;
}

/**
 * La sesión que dice que trabaja pero no da un paso suyo hace `silentMs` y no corre nada: ningún archivo de agente suyo
 * cambió en `agentMs` (un comando no pasa de su tope de 10 min, así que una hora callada sin agentes no es un comando
 * largo). `{ minutos, herramienta }` con su último paso; null si trabaja, si corre un agente, si no tiene conversación o si
 * no se pudo leer: no saber no es un problema que frene los avisos de las demás. Con `readSteps: false` no abre la
 * conversación y cuenta la hora del archivo, que también cambia con un mensaje que le llega.
 */
function busySilence({ projectsDir, cwd, sid, now = Date.now(), silentMs, agentMs, readSteps = true }) {
  if (!projectsDir || typeof cwd !== 'string' || !cwd || !SAFE.test(String(sid))) return null;
  const conversacion = conversationFile(projectsDir, cwd, sid);
  if (!conversacion) return null;
  let st;
  try { st = fs.statSync(conversacion); } catch { return null; }
  const last = readSteps ? lastOwnAt(conversacion, st) : st.mtimeMs;
  if (last == null || now - last < silentMs) return null;
  if (agentWroteSince(path.join(path.dirname(conversacion), String(sid), 'subagents'), now, agentMs)) return null;
  return { minutos: Math.floor((now - last) / 60000), herramienta: lastToolOf(conversacion) };
}

module.exports = { silentAgents, busySilence, projectDirOf };
