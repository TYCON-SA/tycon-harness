'use strict';
/**
 * session-transcript.js — qué hace una sesión sin pipeline, leído de su conversación: el encargo (su primer mensaje de la
 * persona, su primera oración), lo que está haciendo (la primera oración de su último mensaje, que es su conclusión; una
 * pregunta o un consejo no dicen qué hace) y su última acción (la última herramienta, con el nombre del archivo que tocó y a
 * qué hora). De los mensajes sólo se dicen las oraciones que quedan enteras sin rutas ni código.
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
 *
 * Los mensajes entre sesiones también están en la conversación. Lo que recibe una sesión es un renglón `user` con
 * `origin: { kind: 'peer', name, body, msg_id }`: es la prueba de que llegó, y por eso es la única fuente de los sobres
 * (`peerMessagesSince`, sin el texto). Lo que manda es un `tool_use` de `SendMessage`. Lo que escribe la persona lleva
 * `origin.kind: 'human'`, y un turno termina en un renglón `system` con `subtype: 'stop_hook_summary'`, así que la respuesta a
 * un mensaje es el último texto de su turno. `readConversation` lee esos mensajes hacia atrás y con tope, sólo cuando alguien
 * toca a una persona; el texto no se guarda y las claves se tapan (`coverSecrets`). Codex no se manda mensajes.
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
// Sólo oraciones enteras: a la que le faltaría una ruta o un código no se la muestra a medias.
const plainWhole = (t) => require(path.join(__dirname, '..', 'tools', 'office.js')).plainWhole(t, { keepPrs: true });
const textsOf = (content) => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string').map((c) => c.text);
};
// lo que no escribió una persona: avisos de ganchos y etiquetas de la herramienta, y las instrucciones que le carga Codex
const notFromPerson = (t) => /^\s*(<|# AGENTS\.md instructions)/.test(t);
// La hora de la última acción: la foto de la oficina puede quedar abierta, y un «hace 0 min» se queda ahí para siempre.
const atHour = (ms) => { const d = new Date(ms); return `a las ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// un punto de una abreviatura («Sr. García») no corta la oración
const SENTENCES = /(?<!\b(?:Sr|Sra|Dr|Dra|Ing|Lic|Prof|Av|Art|art|núm|pág)\.)(?<=[.!?…])\s+(?=[\p{Lu}¿¡«"])/u;

// Lo que no dice qué hace una sesión: una pregunta, un consejo, un pedido a quien lee o un «listo» suelto.
const NOT_WHAT_IT_DOES = /\?\s*$|^¿|^(?:listo|ok|dale|bien|bueno|perfecto|hecho|entendido|sí)[.!]?$|^(?:te\s+)?(?:conviene|recomiendo|sugiero|propongo)\b|^(?:querés|decime|avisame|confirmame|habría que|deberías|podés)\b/iu;

// La primera oración de un texto que diga qué hace, en llano y recortada: sin el formato del chat. null si ninguna lo dice.
function firstSentence(text) {
  // sin los bloques de código ni las filas de una tabla: no son una frase
  const prose = String(text).replace(/^\s*```[\s\S]*?(?:^\s*```.*$|(?![\s\S]))/gm, '').split('\n').filter((l) => !/^\s*\|/.test(l));
  const lines = prose.map((l) => l.replace(/^[\s>#*`-]+|[*`]+\s*$/g, '').trim()).filter(Boolean);
  if (!lines.length) return null;
  for (const line of lines) {
    for (const part of oneLine(line).split(SENTENCES).filter(Boolean)) {
      const said = plainWhole(part);
      if (said && !NOT_WHAT_IT_DOES.test(said)) return cut(said, FRASE_MAX);
    }
  }
  return null;
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
 * `opts`: `io` (`{ readSync }`, para contar lo que se lee).
 */
function readTranscript(file, { io = fs } = {}) {
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
      if (t) {
        const said = oneLine(t).split(SENTENCES).map(plainWhole).find(Boolean);
        if (said) { out.encargo = cut(said, ENCARGO_MAX); break; }
      }
    }
    // sólo su último mensaje: uno anterior ya no dice qué hace ahora
    let lastMessageSeen = false;
    for (let i = tailLines.length - 1; i >= 0 && !(lastMessageSeen && out.ultimaAccion); i -= 1) {
      const e = entryOf(tailLines[i]);
      if (!e || e.who !== 'assistant') continue;
      if (!lastMessageSeen) {
        const t = [...e.texts].reverse().find((x) => x.trim());
        if (t) { out.haciendoAhora = firstSentence(t); lastMessageSeen = true; }
      }
      if (!out.ultimaAccion && e.tools.length) {
        const tool = e.tools[e.tools.length - 1];
        const input = tool.input && typeof tool.input === 'object' ? tool.input : {};
        const target = [input.file_path, input.notebook_path, input.path].find((v) => typeof v === 'string' && v);
        const parts = [ACTIONS[tool.name] || 'Usar una herramienta'];
        if (target) parts.push(path.basename(target));
        if (Number.isFinite(e.at)) parts.push(atHour(e.at));
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

const COVER = '••••••';
// una palabra larga con letras y números: una clave o un token. Una ruta tiene barras o puntos, y no entra
const LONG_KEY = /(?<![\w+=/.-])(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{24,}(?![\w+=/-]|\.\w)/g;
const NAMED_KEY = /\b(contrase[nñ]a|clave|password|passwd|pwd|token|secret|api[-_ ]?key|pat)(\s*(?:es|:|=)\s*)["'«]?[^\s"'»,;]+/giu;
/** El texto con lo que parece una contraseña o una clave tapado. Las rutas, los números de pedido y las horas quedan. */
function coverSecrets(text) {
  return String(text).replace(NAMED_KEY, (_, word, sep) => `${word}${sep}${COVER}`).replace(LONG_KEY, COVER);
}

// Los mensajes de una sesión que no se van a leer enteros en la pantalla.
const MESSAGE_MAX = 2000;
const NO_TEXT = 'Mensaje sin texto';
const shownText = (t) => {
  const clean = String(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return clean ? cut(coverSecrets(clean), MESSAGE_MAX) : NO_TEXT;
};
const atOf = (d) => { const t = Date.parse(d.timestamp); return Number.isFinite(t) ? t : null; };
// `Coordinadora` o `Coordinadora [8e42be]`: el destinatario sin su referencia
const bareName = (to) => String(to || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
const parsed = (line) => { try { const d = JSON.parse(line); return d && typeof d === 'object' && !d.isSidechain ? d : null; } catch { return null; } };

/**
 * Los mensajes que recibió una sesión desde `offset`: `{ offset, items: [{ id, de, at }] }`, sin su texto. Sólo lee lo
 * que creció, y a lo sumo el último `maxBytes`; un renglón a medio escribir queda para la próxima. Si el archivo no creció,
 * no lee nada.
 */
function peerMessagesSince(file, offset, { maxBytes = 1024 * 1024 } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { offset, items: [] }; }
  try {
    const size = fs.fstatSync(fd).size;
    // más chico que antes: la conversación se reescribió, y se sigue desde el final
    if (size < offset) return { offset: size, items: [] };
    if (size === offset) return { offset, items: [] };
    const start = Math.max(offset, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lastEnd = buf.lastIndexOf(10);
    if (lastEnd < 0) return { offset: start === offset ? offset : start, items: [] };
    const items = [];
    const lines = buf.subarray(0, lastEnd).toString('utf8').split('\n');
    if (start !== offset) lines.shift();
    for (const line of lines) {
      if (!line.includes('"kind":"peer"')) continue;
      const d = parsed(line);
      const o = d && d.type === 'user' ? d.origin : null;
      if (o && o.kind === 'peer' && o.name && o.msg_id) items.push({ id: String(o.msg_id), de: String(o.name), at: atOf(d) });
    }
    return { offset: start + lastEnd + 1, items };
  } catch { return { offset, items: [] }; } finally { fs.closeSync(fd); }
}

// Los renglones de un archivo del final hacia el principio, de a `step` bytes y hasta `maxBytes`. Corta por el salto de
// renglón, que en UTF-8 nunca cae en medio de una letra. `visit` devuelve true para terminar antes.
function eachLineBackward(file, { maxBytes, step = 1024 * 1024 }, visit) {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    let read = 0;
    let carry = Buffer.alloc(0);
    while (end > 0 && read < maxBytes) {
      const len = Math.min(step, end);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, end - len);
      end -= len; read += len;
      const whole = Buffer.concat([chunk, carry]);
      const firstEnd = end > 0 ? whole.indexOf(10) : -1;
      carry = end > 0 ? (firstEnd >= 0 ? whole.subarray(0, firstEnd) : whole) : Buffer.alloc(0);
      const body = end > 0 ? (firstEnd >= 0 ? whole.subarray(firstEnd + 1) : null) : whole;
      if (!body) continue;
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i] && visit(lines[i])) return;
    }
  } finally { fs.closeSync(fd); }
}

const SESSION_CONVERSATION_BYTES = 16 * 1024 * 1024;
const COORDINATOR_CONVERSATION_BYTES = 64 * 1024 * 1024;
const WITH_COORDINATOR = 10;
const FROM_PERSON = 20;
const WITH_SESSIONS = 10;

// Lo que se saca de un renglón: quién habló y qué dijo. Los textos citados llevan las comillas escapadas, así que estas
// marcas sólo aparecen en el renglón que es de verdad eso; igual se confirma después de leerlo.
const peerOf = (d) => (d.type === 'user' && d.origin && d.origin.kind === 'peer' && d.origin.name ? { de: String(d.origin.name), texto: shownText(d.origin.body || ''), at: atOf(d) } : null);
const sentOf = (d) => {
  if (d.type !== 'assistant' || !d.message || !Array.isArray(d.message.content)) return [];
  return d.message.content.filter((c) => c && c.type === 'tool_use' && c.name === 'SendMessage' && c.input && typeof c.input.message === 'string' && c.input.message)
    .map((c) => ({ a: bareName(c.input.to), texto: shownText(c.input.message), at: atOf(d) }));
};
const personOf = (d) => {
  if (d.type !== 'user' || d.isMeta || d.toolUseResult || !d.origin || d.origin.kind !== 'human' || !d.message) return null;
  const t = textsOf(d.message.content).find((x) => x.trim());
  // una orden del programa (`<local-command…>`) no es un mensaje de la persona
  return t && notFromPerson(t) && !/^\s*<system-reminder>/.test(t) ? null : { texto: t ? shownText(t) : NO_TEXT, at: atOf(d) };
};

/**
 * Los últimos mensajes de una sesión con la coordinadora, en orden: `{ conCoordinadora: [{ de, texto, at, propio }] }`.
 * De la coordinadora: `{ conVos: [{ quien: 'vos' | 'coordinadora', texto, at }], conSesiones: [{ de, a, texto, at }] }`.
 * Lee hacia atrás y termina al juntarlos, o en el tope. Sin el nombre de la coordinadora, no hay con quién cruzar.
 */
function readConversation(file, { coordinator, isCoordinator = false, maxBytes } = {}) {
  if (!coordinator) return { sinCoordinadora: true };
  if (!isCoordinator) {
    const out = [];
    eachLineBackward(file, { maxBytes: maxBytes || SESSION_CONVERSATION_BYTES }, (line) => {
      if (!line.includes('"kind":"peer"') && !line.includes('"SendMessage"')) return false;
      const d = parsed(line);
      if (!d) return false;
      const got = peerOf(d);
      if (got && got.de === coordinator) out.push({ de: got.de, texto: got.texto, at: got.at, propio: false });
      for (const s of sentOf(d).reverse()) if (s.a === coordinator) out.push({ de: null, texto: s.texto, at: s.at, propio: true });
      return out.length >= WITH_COORDINATOR;
    });
    return { conCoordinadora: out.slice(0, WITH_COORDINATOR).reverse() };
  }
  const conVos = [];
  const conSesiones = [];
  let answer = null;
  let persons = 0;
  eachLineBackward(file, { maxBytes: maxBytes || COORDINATOR_CONVERSATION_BYTES }, (line) => {
    if (line.includes('"stop_hook_summary"')) {
      // un turno que terminó: lo que se vea de acá para atrás ya es de otro
      answer = null;
      return false;
    }
    const isPerson = line.includes('"kind":"human"');
    const isPeer = line.includes('"kind":"peer"');
    const isSend = line.includes('"SendMessage"');
    const isText = line.includes('"type":"assistant"') && line.includes('"type":"text"');
    if (!isPerson && !isPeer && !isSend && !isText) return false;
    const d = parsed(line);
    if (!d) return false;
    if (conSesiones.length < WITH_SESSIONS) {
      const got = peerOf(d);
      if (got) conSesiones.push({ de: got.de, a: coordinator, texto: got.texto, at: got.at });
      for (const s of sentOf(d).reverse()) if (conSesiones.length < WITH_SESSIONS) conSesiones.push({ de: coordinator, a: s.a, texto: s.texto, at: s.at });
    }
    if (d.type === 'assistant' && answer === null && d.message) {
      const t = [...textsOf(d.message.content)].reverse().find((x) => x.trim());
      if (t) answer = { quien: 'coordinadora', texto: shownText(t), at: atOf(d) };
    }
    const person = persons < FROM_PERSON ? personOf(d) : null;
    if (person) {
      if (answer) conVos.push(answer);
      conVos.push({ quien: 'vos', texto: person.texto, at: person.at });
      answer = null;
      persons += 1;
    }
    return persons >= FROM_PERSON && conSesiones.length >= WITH_SESSIONS;
  });
  return { conVos: conVos.reverse(), conSesiones: conSesiones.reverse() };
}

module.exports = { readTranscript, codexTranscript, peerMessagesSince, readConversation, coverSecrets, HEAD_BYTES, TAIL_BYTES, ENCARGO_MAX, FRASE_MAX };
