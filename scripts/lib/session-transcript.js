'use strict';
/**
 * session-transcript.js — qué hace una sesión sin pipeline, leído de su conversación: el encargo (su primer mensaje de la
 * persona), lo que está haciendo (la última frase que escribió en su chat) y su última acción (la última herramienta, con
 * el nombre del archivo que tocó y hace cuánto).
 *
 * Se lee sólo el principio (64 KB) y el final (256 KB) del archivo, nunca entero; de ahí sólo esos tres datos, recortados
 * y en llano. Nada se guarda en disco: quien llama los pone en la foto local de la oficina, detrás de su token.
 *
 * Claude guarda un JSON por renglón con `type` (`user`, `assistant`, y muchos que acá no cuentan) y `message.content`, un
 * texto o una lista de `{type: text | tool_use | tool_result}`. No cuentan como encargo los mensajes de otro agente
 * (`isSidechain`), los que no escribió la persona (`isMeta`, los avisos de los ganchos) ni los que empiezan con `<`.
 *
 * Codex (medido con codex-cli 0.162, en `~/.codex/sessions/AAAA/MM/DD/rollout-*-<sesión>.jsonl`) guarda
 * `{timestamp, type, payload}`: `type: response_item` con `payload.type` `message` (`role` user, assistant o developer y
 * `content` una lista de `{type: input_text | output_text, text}`) o `custom_tool_call` y `function_call` (`name`). El
 * primer mensaje de `user` son sus instrucciones («# AGENTS.md instructions»): no es el encargo. Sus primeros renglones
 * pueden pasar los 64 KB: entonces no hay encargo, y lo demás sale igual. Un formato que no se reconoce no da nada.
 */
const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const ENCARGO_MAX = 140;
const FRASE_MAX = 160;

// Las herramientas en llano. Una que no está acá se dice sin su nombre: los nombres de las herramientas de afuera no dicen nada.
const ACTIONS = {
  Edit: 'Editar', MultiEdit: 'Editar', Write: 'Escribir', NotebookEdit: 'Editar', Read: 'Leer', Grep: 'Buscar', Glob: 'Buscar',
  Bash: 'Ejecutar un comando', exec: 'Ejecutar un comando', exec_command: 'Ejecutar un comando', shell: 'Ejecutar un comando',
  apply_patch: 'Editar', Agent: 'Lanzar un agente', Task: 'Lanzar un agente', WebFetch: 'Mirar una página', WebSearch: 'Buscar en la web',
};

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => { const c = Array.from(s); return c.length > n ? `${c.slice(0, n - 1).join('')}…` : s; };
const plainText = (t) => require(path.join(__dirname, '..', 'tools', 'office.js')).plain(t);
const textsOf = (content) => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string').map((c) => c.text);
};
// lo que no escribió una persona: avisos de ganchos y etiquetas de la herramienta, y las instrucciones que le carga Codex
const notFromPerson = (t) => /^\s*(<|# AGENTS\.md instructions)/.test(t);
const sinceText = (min) => (min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`);

// La última frase de un texto, en llano y recortada: sin el formato del chat ni los renglones de antes.
function lastSentence(text) {
  // sin los bloques de código ni las filas de una tabla: no son una frase
  const prose = String(text).replace(/^\s*```[\s\S]*?(?:^\s*```.*$|(?![\s\S]))/gm, '').split('\n').filter((l) => !/^\s*\|/.test(l));
  const lines = prose.map((l) => l.replace(/^[\s>#*`-]+|[*`]+\s*$/g, '').trim()).filter(Boolean);
  if (!lines.length) return null;
  const parts = oneLine(lines[lines.length - 1]).split(/(?<=[.!?…])\s+(?=[\p{Lu}¿¡«"])/u).filter(Boolean);
  const said = plainText(parts[parts.length - 1]);
  return said ? cut(said, FRASE_MAX) : null;
}

// Un renglón de Claude o de Codex como `{ who, texts, tool, file, at }`; null si no cuenta o no se reconoce.
function entryOf(line) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const at = Date.parse(d.timestamp);
  if (d.type === 'response_item' && d.payload && typeof d.payload === 'object') {
    const p = d.payload;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) return { who: p.role, texts: textsOf(p.content), tools: [], at };
    if (p.type === 'custom_tool_call' || p.type === 'function_call') return { who: 'assistant', texts: [], tools: [{ name: String(p.name || ''), input: null }], at };
    return null;
  }
  if ((d.type === 'user' || d.type === 'assistant') && !d.isSidechain && d.message && typeof d.message === 'object') {
    const content = d.message.content;
    if (d.type === 'user') return { who: 'user', texts: d.isMeta || d.toolUseResult ? [] : textsOf(content), tools: [], at };
    const tools = Array.isArray(content) ? content.filter((c) => c && c.type === 'tool_use').map((c) => ({ name: String(c.name || ''), input: c.input })) : [];
    return { who: 'assistant', texts: textsOf(content), tools, at };
  }
  return null;
}

// Los renglones enteros de un tramo: el que quedó cortado en un borde se saltea.
function wholeLines(text, cutStart, cutEnd) {
  const lines = text.split('\n');
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines;
}

/**
 * Lee una conversación: `{ encargo, haciendoAhora, ultimaAccion, lastWriteMs, problem }`. Sin el archivo, vacía o con un
 * formato desconocido, los tres datos en null; si no se puede leer, además `problem` con su motivo y nunca su texto.
 * `opts`: `now` (ms) e `io` (`{ readSync }`, para contar lo que se lee).
 */
function readTranscript(file, { now = Date.now(), io = fs } = {}) {
  const out = { encargo: null, haciendoAhora: null, ultimaAccion: null, lastWriteMs: null, problem: null };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') out.problem = `no se pudo leer (${e.code || 'error'})`;
    return out;
  }
  try {
    const st = fs.fstatSync(fd);
    out.lastWriteMs = st.mtimeMs;
    const size = st.size;
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    if (headLen) io.readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(Math.max(0, size - headLen), TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    if (tailLen) io.readSync(fd, tail, 0, tailLen, size - tailLen);
    // si los dos tramos cubren el archivo entero, se pegan; si no, el renglón cortado de cada borde se saltea
    const all = headLen + tailLen === size ? wholeLines(Buffer.concat([head, tail]).toString('utf8'), false, false) : null;
    const headLines = all || wholeLines(head.toString('utf8'), false, true);
    const tailLines = all || wholeLines(tail.toString('utf8'), true, false);

    for (const line of headLines) {
      const e = entryOf(line);
      if (!e || e.who !== 'user') continue;
      const t = e.texts.find((x) => x.trim() && !notFromPerson(x));
      if (t) { const said = plainText(oneLine(t)); if (said) { out.encargo = cut(said, ENCARGO_MAX); break; } }
    }
    for (let i = tailLines.length - 1; i >= 0 && !(out.haciendoAhora && out.ultimaAccion); i -= 1) {
      const e = entryOf(tailLines[i]);
      if (!e || e.who !== 'assistant') continue;
      if (!out.haciendoAhora) {
        const t = [...e.texts].reverse().find((x) => x.trim());
        if (t) out.haciendoAhora = lastSentence(t);
      }
      if (!out.ultimaAccion && e.tools.length) {
        const tool = e.tools[e.tools.length - 1];
        const input = tool.input && typeof tool.input === 'object' ? tool.input : {};
        const target = [input.file_path, input.notebook_path, input.path].find((v) => typeof v === 'string' && v);
        const parts = [ACTIONS[tool.name] || 'Usar una herramienta'];
        if (target) parts.push(path.basename(target));
        if (Number.isFinite(e.at)) parts.push(sinceText(Math.max(0, Math.round((now - e.at) / 60000))));
        out.ultimaAccion = parts.join(' · ');
      }
    }
  } catch (e) {
    out.problem = `no se pudo leer (${e.code || 'error'})`;
    out.encargo = null; out.haciendoAhora = null; out.ultimaAccion = null;
  } finally { fs.closeSync(fd); }
  return out;
}

/**
 * El archivo de conversación de una sesión de Codex, por su id en el nombre, en las carpetas por día de los últimos
 * `days` días; null si no está. Sólo mira nombres: no abre ninguno.
 */
function codexTranscript(codexHome, sid, { now = Date.now(), days = 3 } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sid))) return null;
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now - i * 86400000);
    const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(`-${sid}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

module.exports = { readTranscript, codexTranscript, HEAD_BYTES, TAIL_BYTES, ENCARGO_MAX, FRASE_MAX };
