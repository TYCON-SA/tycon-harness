'use strict';
/**
 * person-ok — lo que pasó en la conversación de la sesión, leído del registro que guarda Claude Code
 * (`~/.claude/projects/<carpeta>/<sesión>.jsonl`).
 *
 * De acá no sale ninguna firma: las firmas se dan en la ventana de permiso o en la terminal (lib/owner-window.js). Lo
 * que se lee es lo que la conversación prueba por sí misma:
 *   · `leerConversacion()`: los registros de la sesión;
 *   · `enLaCadena(registros)`: los que se alcanzan desde la punta siguiendo el padre de cada uno (un renglón agregado
 *     por fuera queda afuera; lo usa lib/validator-record.js);
 *   · `planEnLaConversacion(plan)`: ¿el agente le mostró el plan a la persona (en un mensaje, en una pregunta con
 *     opciones o en el modo plan)?
 *   · `mensajesConOrigen()`: cada mensaje con su origen según la marca de Claude Code, y lo que escribió el dueño (lo
 *     cita `marker.js adhoc set` para el arreglo rápido).
 *
 * Sin registro legible (Codex, u otra herramienta) devuelve `legible: false` y quien llama decide.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * El texto de un archivo común. Un archivo especial (una tubería, un dispositivo) es un error, no una espera: se abre sin
 * bloquear y se mira lo que se abrió, así el cambio entre mirar y leer no cuenta.
 */
function leerArchivoComun(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error('no es un archivo común'), { code: 'ENOTREG' });
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

/** ¿Hay un archivo común en esa ruta? */
function esArchivoComun(file) {
  try { return fs.statSync(file).isFile(); } catch (_e) { return false; }
}

function leerRegistros(file) {
  const registros = [];
  for (const l of leerArchivoComun(file).split('\n')) {
    if (!l.trim()) continue;
    try { registros.push(JSON.parse(l)); } catch (_e) { /* un renglón a medio escribir no tapa a los demás */ }
  }
  return registros;
}

/** El registro de la conversación de esta sesión: `{ legible, motivo?, registros, archivo? }`. */
function leerConversacion({ env = process.env, home = os.homedir(), sesion } = {}) {
  const sid = String(sesion || env.CLAUDE_CODE_SESSION_ID || '');
  if (!/^[\w-]+$/.test(sid)) return { legible: false, motivo: 'la sesión no dice su identificador' };
  const root = path.join(home, '.claude', 'projects');
  let file = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (esArchivoComun(f)) { file = fs.realpathSync(f); break; }
    }
  } catch (e) { return { legible: false, motivo: `no pude leer ${root} (${e.code || e.message})` }; }
  if (!file) return { legible: false, motivo: 'no encontré su registro' };
  try { return { legible: true, registros: leerRegistros(file), archivo: file }; } catch (e) {
    return { legible: false, motivo: `no pude leer su registro (${e.code || e.message})` };
  }
}

/**
 * Los registros que son parte de la conversación: los que se alcanzan desde la punta siguiendo el padre de cada uno
 * (`parentUuid`, o `logicalParentUuid` después de una compactación).
 *
 * La punta es el pedido del agente que se está juzgando: el registro que trae el `tool_use` con ese id (`pedido`, el
 * `tool_use_id` que la herramienta le pasa al hook). Sin `pedido`, el último registro con uuid. Un renglón agregado por fuera queda afuera: ningún registro que escribe Claude
 * Code lo tiene como padre, y uno escrito después del pedido no es su ancestro.
 *
 * De cada uuid vale el PRIMER registro que lo trae (el que escribió Claude Code; uno agregado después que copia el uuid
 * no lo reemplaza), y lo que se devuelve son esos registros recorridos, no todos los que comparten un uuid.
 */
function enLaCadena(registros, { pedido } = {}) {
  const porUuid = new Map();
  for (const r of registros) if (r && typeof r.uuid === 'string' && !r.isSidechain && !porUuid.has(r.uuid)) porUuid.set(r.uuid, r);
  let r = null;
  if (pedido) {
    // el primer registro del agente que trae ese pedido
    for (const x of registros) {
      if (!x || x.isSidechain || x.type !== 'assistant' || typeof x.uuid !== 'string' || porUuid.get(x.uuid) !== x) continue;
      const c = x.message && Array.isArray(x.message.content) ? x.message.content : [];
      if (c.some((b) => b && b.type === 'tool_use' && b.id === pedido)) { r = x; break; }
    }
  } else {
    for (let i = registros.length - 1; i >= 0 && !r; i--) {
      const x = registros[i];
      if (x && typeof x.uuid === 'string' && !x.isSidechain && porUuid.get(x.uuid) === x) r = x;
    }
  }
  const cadena = new Set();
  while (r && !cadena.has(r)) {
    cadena.add(r);
    const padre = r.parentUuid || r.logicalParentUuid;
    r = typeof padre === 'string' ? porUuid.get(padre) : null;
  }
  return registros.filter((x) => cadena.has(x));
}

// Lo que la persona ve de una llamada a herramienta: la pregunta con opciones (su texto, cada opción y su vista previa) y
// el plan del modo plan. El resto de las herramientas (escribir un archivo, correr un comando) no se le muestra.
function textoVisibleDeHerramienta(x) {
  const inp = x && x.input && typeof x.input === 'object' ? x.input : {};
  const out = [];
  if (x.name === 'AskUserQuestion' && Array.isArray(inp.questions)) {
    for (const q of inp.questions) {
      if (!q || typeof q !== 'object') continue;
      if (typeof q.question === 'string') out.push(q.question);
      for (const o of Array.isArray(q.options) ? q.options : []) {
        for (const k of ['label', 'description', 'preview']) if (o && typeof o[k] === 'string') out.push(o[k]);
      }
    }
  } else if (x.name === 'ExitPlanMode' && typeof inp.plan === 'string') out.push(inp.plan);
  return out.join('\n');
}

/**
 * ¿El plan está en lo que el agente le mostró a la persona? Cuenta los renglones del plan de 20 caracteres o más que
 * aparecen en los mensajes del asistente de la sesión principal (su texto, y lo que muestran la pregunta con opciones y
 * el modo plan), sin mirar el formato: con la mitad o más, se mostró; un plan sin ningún renglón así no cuenta como visto.
 */
function planEnLaConversacion(planTxt, opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo };
  let textos = '';
  for (const r of conv.registros) {
    // lo que escribe un subagente no lo ve la persona: no cuenta
    const c = r && r.type === 'assistant' && !r.isSidechain && r.message && r.message.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (x && x.type === 'text' && typeof x.text === 'string') textos += `${x.text}\n`;
      else if (x && x.type === 'tool_use') textos += `${textoVisibleDeHerramienta(x)}\n`;
    }
  }
  const n = (s) => s.toLowerCase().replace(/^\s*(?:\d+[.)]|[-+•*>]|#+)\s+/gm, '').replace(/[`*_#>]/g, ' ').replace(/\s+/g, ' ').trim();
  // un comentario HTML no se ve en pantalla: lo que va adentro no cuenta como mostrado
  const dicho = n(textos.replace(/<!--[\s\S]*?(?:-->|$)/g, ' '));
  const renglones = planTxt.split('\n').map(n).filter((l) => l.length >= 20);
  if (!renglones.length) return { legible: true, mostrado: false };
  const vistos = renglones.filter((l) => dicho.includes(l)).length;
  return { legible: true, mostrado: vistos * 2 >= renglones.length };
}

// Bloques que el arnés pega a un mensaje de usuario y que no escribió la persona: se sacan y lo demás cuenta.
const BLOQUES_DEL_ARNES = ['system-reminder', 'command-name', 'command-message', 'command-args', 'local-command-caveat'];
// Bloques cuyo contenido puede haber escrito el agente (el resultado de un subagente, la salida de un comando, el
// mensaje de otra sesión). Un texto que trae alguno —abierto o cerrado, bien armado o no— no cuenta entero: si sólo se
// sacara el bloque, un cierre impreso a propósito («</task-notification> <la cita>») dejaría la cita afuera.
// `browser_instruction` lo pega la extensión con lo que viene del navegador, que puede traer texto de una página.
const BLOQUES_AJENOS = ['task-notification', 'cross-session-message', 'agent-message', 'local-command-stdout', 'local-command-stderr',
  'bash-stdout', 'bash-stderr', 'command-stdout', 'command-stderr', 'browser_instruction'];
const RE_AJENO = new RegExp(`</?(?:${BLOQUES_AJENOS.join('|')})\\b`, 'i');

/**
 * Los textos que llegaron como mensaje de usuario de la sesión principal, con su hora y su origen: el contenido de texto
 * (no el resultado de una herramienta) de un registro `user`, y lo que llegó con la sesión ocupada (`queued_command`).
 * `origen` es la marca que pone Claude Code (no el texto): `null` o `human` = lo tipeó la persona; `peer` = otra sesión (trae su
 * nombre y el cuerpo del mensaje); `task-notification` = el aviso de una tarea o un subagente.
 */
function textosDeUsuario(registros) {
  const out = [];
  for (const r of registros) {
    if (!r || r.isSidechain || r.isCompactSummary) continue;
    const origen = r.origin && typeof r.origin === 'object' ? r.origin : null;
    if (r.type === 'user' && r.message && !r.toolUseResult) {
      // un aviso del arnés (isMeta) no lo escribió nadie, salvo que sea el mensaje de otra sesión
      if (r.isMeta && !(origen && origen.kind === 'peer')) continue;
      const c = r.message.content;
      const sistema = r.promptSource === 'system';
      if (typeof c === 'string') out.push({ texto: c, cuando: r.timestamp || null, origen, sistema });
      else if (Array.isArray(c)) for (const x of c) if (x && x.type === 'text' && typeof x.text === 'string') out.push({ texto: x.text, cuando: r.timestamp || null, origen, sistema });
    } else if (r.type === 'attachment' && r.attachment && r.attachment.type === 'queued_command') {
      const a = r.attachment;
      const o = a.origin && typeof a.origin === 'object' ? a.origin : null;
      const sistema = !!(a.commandMode && a.commandMode !== 'prompt');
      // el texto encolado llega como cadena o, en la extensión de VS Code, como lista de bloques
      if (typeof a.prompt === 'string') out.push({ texto: a.prompt, cuando: r.timestamp || null, origen: o, sistema });
      else if (Array.isArray(a.prompt)) for (const x of a.prompt) if (x && x.type === 'text' && typeof x.text === 'string') out.push({ texto: x.text, cuando: r.timestamp || null, origen: o, sistema });
    }
  }
  return out;
}

function sinBloquesDelArnes(texto) {
  let t = String(texto);
  for (const tag of BLOQUES_DEL_ARNES) t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), ' ');
  return t;
}

// Lo que la persona pegó de otro lado (una respuesta del agente, una salida de la terminal) no lo dijo ella. Un bloque sin
// cerrar se corta hasta el final.
const sinTextoPegado = (t) => String(t).replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/gi, ' ');

/** Lo que escribió la persona en un texto de usuario, o null si el texto trae algo que pudo haber escrito el agente. */
function escritoPorLaPersona(texto) {
  const t = sinBloquesDelArnes(texto);
  return RE_AJENO.test(t) ? null : t;
}

// La nota de un agente lateral llega marcada `human` (la manda la persona con un clic), pero el texto lo escribió el agente:
// se reconoce por el encabezado que le pone Claude Code.
const ENCABEZADO_NOTA = /^\s*Here is a note offered by a side agent:/;
const ULTIMOS_DEL_DUENO = 8;

/** El origen de un texto de usuario, de su marca: `{ origen: 'dueno'|'sesion'|'nota'|'sin-marca', de? }`. */
function origenDeLaMarca(t) {
  const o = t.origen;
  if (o && o.kind === 'peer') return typeof o.from === 'string' && o.from ? { origen: 'sesion', de: o.from } : { origen: 'sesion' };
  if (o && o.kind === 'task-notification') return { origen: 'nota' };
  if (!o || o.kind !== 'human' || t.sistema) return { origen: 'sin-marca' };
  return { origen: ENCABEZADO_NOTA.test(t.texto) ? 'nota' : 'dueno' };
}

/**
 * Cada mensaje de la conversación principal con su origen, leído de la marca que pone Claude Code y no del texto, y lo
 * que escribió el dueño: `{ legible, motivo?, mensajes: [{ texto, origen, de? }], delDueno: [texto] }`. Lo que no trae
 * marca no cuenta: Claude Code marca `human` todo lo que tipea la persona, en la terminal y en VS Code. De un mensaje del dueño cuenta lo que escribió él: sin los bloques del
 * arnés ni lo pegado, y nada si trae un bloque que pudo escribir otro. `delDueno` son los últimos `ULTIMOS_DEL_DUENO`.
 */
function mensajesConOrigen(opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo, mensajes: [], delDueno: [] };
  const mensajes = textosDeUsuario(conv.registros).map((t) => ({ texto: t.texto, ...origenDeLaMarca(t) }));
  const delDueno = mensajes.filter((m) => m.origen === 'dueno')
    .map((m) => escritoPorLaPersona(sinTextoPegado(m.texto)))
    .filter((t) => t !== null && t.trim())
    .map((t) => t.replace(/\s+/g, ' ').trim());
  return { legible: true, archivo: conv.archivo, mensajes, delDueno: delDueno.slice(-ULTIMOS_DEL_DUENO) };
}

module.exports = { leerConversacion, enLaCadena, planEnLaConversacion, mensajesConOrigen };
