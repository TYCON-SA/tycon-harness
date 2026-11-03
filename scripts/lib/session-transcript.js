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
 * abre su ventana; el texto no se guarda y las claves se tapan (`coverSecrets`). Codex no se manda mensajes. El mensaje con el
 * que arranca una sesión de fondo se guarda como si lo hubiera escrito una persona: no dice quién la abrió.
 *
 * Los tokens también salen de acá (`countTokens`): cada turno trae su `usage` y puede ocupar varios renglones con el mismo
 * `message.id`, así que se cuenta una vez por mensaje. Los agentes de una sesión están en `<sesión>/subagents/`. Codex trae
 * sus totales y su ventana en cada `token_count`. Se lee por tramos y sólo lo que creció: hay conversaciones de más de 500 MB.
 */
const fs = require('fs');
const os = require('os');
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

// «Sos Ortega.»: el nombre que le dan a la sesión, no lo que le piden.
const OWN_NAME = /^Sos\s+(?:la\s+|el\s+)?\S+\.?$/iu;
// cómo trabajar, no qué hacer: «Avisale a la Coordinadora al arrancar», «Antes de pedir firma, medí…»
const METHOD = /^(?:avis[aá]|actualiz[aá] tu fila|antes de|al arrancar|dec[ií]\b|ped[ií]\b|mand[aá]|no\b|se dice)/iu;
// «Hacé el encargo de <archivo>» o «Leé y hacé <archivo>»: el archivo es el encargo. Si sólo lo nombra de paso, no lo es.
const ENCARGO_FILE = /^(?:hac[eé]\s+el\s+encargo\s|le[eé]\s+y\s+hac[eé]\s).*?((?:~|\/)[^\s«»"']*encargo[^\s«»"']*\.md)(?=[\s.,:;]|$)/iu;
const ENCARGO_FILE_MAX = 4096;
const ENCARGO_WORD = /^Encargo:\s*/iu;

// El primer título de un archivo de encargo: sólo un `.md` con «encargo» en el nombre, y sólo su principio.
function titleOfEncargo(ruta) {
  const file = ruta.startsWith('~') ? path.join(os.homedir(), ruta.slice(1)) : ruta;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(ENCARGO_FILE_MAX);
    const n = fs.readSync(fd, buf, 0, ENCARGO_FILE_MAX, 0);
    const title = /^#\s+(.+)$/m.exec(buf.subarray(0, n).toString('utf8'));
    return title ? plainWhole(title[1].replace(ENCARGO_WORD, '')) : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Lo que le piden a una sesión en su primer mensaje: sin «Sos X.». Si apunta a un archivo de encargo, su título; si una oración
// no se puede decir entera por una ruta, lo que dice antes de los dos puntos; si no, la siguiente que se pueda decir.
function encargoOf(text) {
  for (const part of oneLine(text).split(SENTENCES).map((s) => s.trim()).filter((s) => s && !OWN_NAME.test(s) && !METHOD.test(s))) {
    const pointer = ENCARGO_FILE.exec(part);
    const title = pointer && titleOfEncargo(pointer[1]);
    if (title) return title;
    const said = plainWhole(part) || (part.includes(':') ? plainWhole(part.slice(0, part.indexOf(':'))) : null);
    if (said) return said.replace(ENCARGO_WORD, '') || said;
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
        const said = encargoOf(t);
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

// El primer mensaje de la conversación, de lo que se guarda como escrito por una persona; null si no se lee.
function startingMessage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of wholeLines(buf.subarray(0, n).toString('utf8'), false, n === HEAD_BYTES)) {
      const d = parsed(line);
      const said = d ? personOf(d) : null;
      if (said) return said;
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const TOKEN_STEP_BYTES = 1024 * 1024;
const newCount = () => ({ offset: 0, byMessage: new Map(), lectura: 0, escritura: 0, cache: 0, ultimo: null, codex: null });

function addTurn(count, id, u) {
  const now = { lectura: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), escritura: u.output_tokens || 0, cache: u.cache_read_input_tokens || 0 };
  const was = count.byMessage.get(id) || { lectura: 0, escritura: 0, cache: 0 };
  for (const k of ['lectura', 'escritura', 'cache']) count[k] += now[k] - was[k];
  count.byMessage.set(id, now);
}

function countLine(line, count, isAgent) {
  const claude = line.includes('"usage"');
  if (!claude && !line.includes('"token_count"')) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object') return;
  if (d.type === 'assistant' && d.message && d.message.usage && typeof d.message.usage === 'object') {
    const m = d.message;
    if (m.model === '<synthetic>' || (d.isSidechain && !isAgent)) return;
    addTurn(count, m.id || d.uuid, m.usage);
    if (!isAgent) count.ultimo = { contexto: (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0) + (m.usage.cache_read_input_tokens || 0), modelo: typeof m.model === 'string' ? m.model : null };
    return;
  }
  const p = d.type === 'event_msg' && d.payload;
  if (p && p.type === 'token_count' && p.info && p.info.total_token_usage && p.info.last_token_usage) {
    count.codex = { total: p.info.total_token_usage, contexto: p.info.last_token_usage.input_tokens, ventana: p.info.model_context_window };
  }
}

/** Suma a `count` lo que creció el archivo desde la última vez. Un renglón a medio escribir queda para la próxima. */
function countTokens(file, count, { isAgent = false } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return count; }
  try {
    const size = fs.fstatSync(fd).size;
    // más chico que antes: la conversación se reescribió, y se cuenta de nuevo
    if (size < count.offset) Object.assign(count, newCount());
    let carry = Buffer.alloc(0);
    let at = count.offset;
    while (at < size) {
      const chunk = Buffer.alloc(Math.min(TOKEN_STEP_BYTES, size - at));
      const n = fs.readSync(fd, chunk, 0, chunk.length, at);
      if (!n) break;
      at += n;
      const whole = Buffer.concat([carry, chunk.subarray(0, n)]);
      const lastEnd = whole.lastIndexOf(10);
      if (lastEnd < 0) { carry = whole; continue; }
      for (const line of whole.subarray(0, lastEnd).toString('utf8').split('\n')) if (line) countLine(line, count, isAgent);
      carry = whole.subarray(lastEnd + 1);
    }
    count.offset = at - carry.length;
  } catch { /* lo que no se pudo leer queda sin contar: se reintenta en la próxima foto */ } finally { fs.closeSync(fd); }
  return count;
}

// La ventana publicada de cada modelo (al 6/10/2026). Un modelo que no está acá no tiene porcentaje: no se inventa.
const PUBLISHED_WINDOW = {
  'claude-fable-5-1': 1000000, 'claude-fable-5': 1000000, 'claude-opus-5-5': 1000000, 'claude-opus-5': 1000000, 'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000, 'claude-opus-4-6': 1000000, 'claude-sonnet-5-5': 1000000, 'claude-sonnet-5': 1000000, 'claude-sonnet-4-6': 1000000,
  'claude-haiku-5-5': 1000000, 'claude-haiku-4-5': 200000,
};

/**
 * Contra qué se mide el contexto: el límite donde la sesión se compacta sola, que es lo que dice cuánto le queda; sin él, la
 * ventana del modelo. Si el contexto pasó el límite, éste no vale para esa sesión: se usa la ventana. null si ninguno sirve.
 */
function contextLimit(modelo, contexto, modelSettings) {
  if (!modelo) return null;
  const bare = modelo.replace(/\[[^\]]*\]$/, '');
  const conf = modelSettings && modelSettings[bare];
  const own = conf && Number.isFinite(conf.autoCompactWindow) && conf.autoCompactWindow > 0 ? conf.autoCompactWindow : null;
  const published = PUBLISHED_WINDOW[bare] || null;
  return [own, published].find((v) => v && contexto <= v) || null;
}

/**
 * Los tokens de una sesión: `{ contexto, limite, lectura, escritura, cache, agentes }`, o `{ noMedido: true }` sin un conteo
 * legible. `counts` recuerda por archivo hasta dónde se leyó, y vive lo que viva quien llama.
 */
function readSessionTokens(file, counts, { modelSettings } = {}) {
  const countOf = (f) => { if (!counts.has(f)) counts.set(f, newCount()); return counts.get(f); };
  const main = countTokens(file, countOf(file));
  if (main.codex) {
    const t = main.codex.total;
    const cached = t.cached_input_tokens || 0;
    const ventana = Number.isFinite(main.codex.ventana) && main.codex.ventana > 0 ? main.codex.ventana : null;
    return { contexto: main.codex.contexto, limite: ventana, lectura: Math.max(0, (t.input_tokens || 0) - cached), escritura: t.output_tokens || 0, cache: cached, agentes: 0 };
  }
  if (!main.ultimo) return { noMedido: true };
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { /* sin agentes */ }
  const total = { lectura: main.lectura, escritura: main.escritura, cache: main.cache };
  for (const n of names) {
    const f = path.join(dir, n);
    const a = countTokens(f, countOf(f), { isAgent: true });
    for (const k of Object.keys(total)) total[k] += a[k];
  }
  const { contexto, modelo } = main.ultimo;
  return { contexto, limite: contextLimit(modelo, contexto, modelSettings), ...total, agentes: names.length };
}

/**
 * Los últimos mensajes de una sesión con la coordinadora, en orden: `{ conCoordinadora: [{ de, texto, at, propio }] }`.
 * De la coordinadora: `{ conVos: [{ quien: 'vos' | 'coordinadora', texto, at }], conSesiones: [{ de, a, texto, at }] }`.
 * Lee hacia atrás y termina al juntarlos, o en el tope. Sin el nombre de la coordinadora, no hay con quién cruzar.
 */
function readConversation(file, { coordinator, isCoordinator = false, background = false, maxBytes } = {}) {
  if (!coordinator) return { sinCoordinadora: true };
  if (!isCoordinator) {
    const arranque = background ? startingMessage(file) : null;
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
    return { conCoordinadora: out.slice(0, WITH_COORDINATOR).reverse(), ...(arranque ? { arranque } : {}) };
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

module.exports = { readTranscript, codexTranscript, peerMessagesSince, readConversation, coverSecrets, readSessionTokens, contextLimit, encargoOf, HEAD_BYTES, TAIL_BYTES, ENCARGO_MAX, FRASE_MAX };
