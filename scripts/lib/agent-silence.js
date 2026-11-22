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

/**
 * La sesión que dice que trabaja pero no escribe su conversación hace `silentMs` y no corre nada: ningún archivo de agente
 * suyo cambió en `agentMs` (un comando no pasa de su tope de 10 min, así que una hora callada sin agentes no es un comando
 * largo). `{ minutos, herramienta }` con su último paso; null si escribe, si corre un agente o si no tiene conversación;
 * `{ problem }` si no se pudo leer.
 */
function busySilence({ projectsDir, cwd, sid, now = Date.now(), silentMs, agentMs }) {
  if (!projectsDir || typeof cwd !== 'string' || !cwd || !SAFE.test(String(sid))) return null;
  const dir = projectDirOf(projectsDir, cwd);
  const conversacion = path.join(dir, `${sid}.jsonl`);
  let st;
  try { st = fs.statSync(conversacion); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    return { problem: `no pude leer la conversación de ${sid} (${e.code || e.message})` };
  }
  if (now - st.mtimeMs < silentMs) return null;
  if (agentWroteSince(path.join(dir, String(sid), 'subagents'), now, agentMs)) return null;
  return { minutos: Math.floor((now - st.mtimeMs) / 60000), herramienta: lastToolOf(conversacion) };
}

module.exports = { silentAgents, busySilence, projectDirOf };
