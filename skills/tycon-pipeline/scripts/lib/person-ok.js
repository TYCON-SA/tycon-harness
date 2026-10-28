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

module.exports = { leerConversacion, enLaCadena, planEnLaConversacion };
