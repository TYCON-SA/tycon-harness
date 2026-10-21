'use strict';
/**
 * person-ok — lo que una persona dijo en la conversación de la sesión, leído del registro que guarda Claude Code
 * (`~/.claude/projects/<carpeta>/<sesión>.jsonl`).
 *
 * Tres preguntas:
 *   · `citaDeLaPersona(cita)`: ¿la escribió el dev? Cuenta un mensaje de usuario de la sesión principal escrito como
 *     texto. NO cuenta lo que escribió el agente, la salida de una herramienta, un subagente (ni el aviso con que vuelve
 *     su resultado), un mensaje de otra sesión, un aviso del sistema ni la salida de un comando local o de `!`: todo
 *     eso también se guarda como «mensaje de usuario», y el agente podría imprimir la cita para después encontrarla.
 *   · `citaReenviada(cita, rol)`: ¿llegó dentro de un mensaje que mandó la sesión designada en esta máquina para ese rol?
 *     Es la variante en la que una sesión coordinadora reenvía textual el ok del dev.
 *   · `planEnLaConversacion(plan)`: ¿el agente le mostró el plan a la persona (en un mensaje, en una pregunta con opciones
 *     o en el modo plan)?
 *
 * La cita se compara sin mayúsculas, con los espacios juntados y sin comillas alrededor, y tiene que tener al menos
 * `CITA_MINIMA` letras o dígitos: un «sí» suelto aparece en cualquier conversación.
 *
 * Lo que esto NO prueba: quién está detrás de la sesión que reenvía, más allá de la frase del dev que la designó, ni
 * que el registro no se haya editado (lo puede editar el mismo usuario del sistema). Es el nivel de la firma por
 * terminal: no hay camino cómodo ni accidental, y forzarlo queda a la vista. Sin registro legible (Codex, u otra herramienta) devuelve `legible: false` y quien llama
 * falla cerrado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CITA_MINIMA = 10;

// Bloques que el arnés pega a un mensaje de usuario y que no escribió la persona: se sacan y lo demás cuenta.
const BLOQUES_DEL_ARNES = ['system-reminder', 'command-name', 'command-message', 'command-args', 'local-command-caveat'];
// Bloques cuyo contenido puede haber escrito el agente (el resultado de un subagente, la salida de un comando, el
// mensaje de otra sesión). Un texto que trae alguno —abierto o cerrado, bien armado o no— no cuenta entero: si sólo se
// sacara el bloque, un cierre impreso a propósito («</task-notification> <la cita>») dejaría la cita afuera.
const BLOQUES_AJENOS = ['task-notification', 'cross-session-message', 'agent-message', 'local-command-stdout', 'local-command-stderr',
  'bash-stdout', 'bash-stderr', 'command-stdout', 'command-stderr'];
const RE_AJENO = new RegExp(`</?(?:${BLOQUES_AJENOS.join('|')})\\b`, 'i');
const ENCABEZADO_OTRA_SESION = /^\s*Another Claude session sent a message:\s*/;

/** El registro de la conversación de esta sesión: `{ legible, motivo?, registros }`. */
function leerConversacion({ env = process.env, home = os.homedir(), sesion } = {}) {
  const sid = String(sesion || env.CLAUDE_CODE_SESSION_ID || '');
  if (!/^[\w-]+$/.test(sid)) return { legible: false, motivo: 'la sesión no dice su identificador' };
  const root = path.join(home, '.claude', 'projects');
  let file = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) { file = f; break; }
    }
  } catch (e) { return { legible: false, motivo: `no pude leer ${root} (${e.code || e.message})` }; }
  if (!file) return { legible: false, motivo: 'no encontré su registro' };
  const registros = [];
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { registros.push(JSON.parse(l)); } catch (_e) { /* un renglón a medio escribir no tapa a los demás */ }
    }
  } catch (e) { return { legible: false, motivo: `no pude leer su registro (${e.code || e.message})` }; }
  return { legible: true, registros, archivo: file };
}

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

/** Lo que escribió la persona en un texto de usuario, o null si el texto trae algo que pudo haber escrito el agente. */
function escritoPorLaPersona(texto) {
  const t = sinBloquesDelArnes(texto);
  return RE_AJENO.test(t) ? null : t;
}

/**
 * El cuerpo de un mensaje de otra sesión, si el texto es EXACTAMENTE uno (el encabezado y el bloque, nada más afuera
 * salvo avisos del arnés, y nada ajeno adentro): `{ de, cuerpo }` o null.
 */
function mensajeDeOtraSesion(texto) {
  const t = sinBloquesDelArnes(texto).replace(ENCABEZADO_OTRA_SESION, '').trim();
  const m = /^<cross-session-message\b([^>]*)>([\s\S]*)<\/cross-session-message>$/.exec(t);
  if (!m || RE_AJENO.test(m[2])) return null;
  const de = /\bfrom-name="([^"]*)"/.exec(m[1]);
  return de ? { de: de[1].trim(), cuerpo: m[2] } : null;
}

const norm = (s) => String(s).toLowerCase().replace(/[«»"“”'‘’]/g, ' ').replace(/\s+/g, ' ').trim();
const letras = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;

// `desde`: la hora a partir de la cual vale el ok (el arranque de la corrida, o la muestra del crítico). Una frase
// vieja del dev no aprueba lo que todavía no existía. `juzgar(texto)`: si viene, el mensaje entero que trae la cita
// tiene que pasarlo (null); si no, su motivo vuelve como `rechazo` (el del mensaje más nuevo).
function buscar(cita, candidatos, desde, juzgar) {
  const c = norm(cita);
  if (letras(c) < CITA_MINIMA) return { encontrada: false, corta: true };
  const t0 = desde ? Date.parse(desde) : NaN;
  let vieja = false;
  let rechazo = null;
  // la última vez que se dijo: la hora que se anota es la del ok más reciente
  for (let i = candidatos.length - 1; i >= 0; i--) {
    if (!norm(candidatos[i].texto).includes(c)) continue;
    const t = Date.parse(candidatos[i].cuando || '');
    if (!Number.isNaN(t0) && !(t >= t0)) { vieja = true; continue; }
    const motivo = typeof juzgar === 'function' ? juzgar(candidatos[i].texto) : null;
    if (motivo) { if (!rechazo) rechazo = motivo; continue; }
    // un mensaje posterior que se echa atrás tumba el ok, aunque la cita sea de uno anterior
    if (juzgar && typeof juzgar.retracta === 'function' && candidatos.slice(i + 1).some((c) => juzgar.retracta(c.texto))) {
      return { encontrada: false, rechazo: 'después de ese ok, la persona se echó atrás (un mensaje posterior lo niega o le pone una condición)' };
    }
    return { encontrada: true, cuando: candidatos[i].cuando };
  }
  if (rechazo) return { encontrada: false, rechazo };
  return vieja ? { encontrada: false, anterior: true } : { encontrada: false };
}

/** ¿El dev escribió la cita? `{ legible, motivo?, encontrada, cuando?, corta? }`. */
function citaDeLaPersona(cita, opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo, encontrada: false };
  // lo que tipeó la persona: sin marca de origen ni de sistema, y sin nada adentro que pudo haber escrito el agente
  // (la extensión de VS Code marca lo que tipea la persona con `origin.kind: human`; la terminal no le pone marca)
  const propios = textosDeUsuario(conv.registros).filter((t) => (!t.origen || t.origen.kind === 'human') && !t.sistema)
    .map((t) => ({ texto: escritoPorLaPersona(t.texto), cuando: t.cuando })).filter((t) => t.texto !== null);
  return { legible: true, archivo: conv.archivo, ...buscar(cita, propios, opts.desde, opts.juzgar) };
}

/**
 * ¿La cita llegó dentro de un mensaje de la sesión designada en esta máquina para el rol `sesion` (por ejemplo
 * «coordinadora»)? `{ legible, motivo?, encontrada, cuando?, corta?, rechazo? }`.
 * Cuenta un mensaje de otra sesión cuyo número de mensaje (`origin.msg_id`, lo pone Claude Code al entregarlo) figura
 * entre los que mandó la conversación designada (el `msg_id` del resultado de cada envío, en su registro). El nombre de
 * la sesión que manda no cuenta: lo pone el sistema, cambia al reiniciar y otra sesión puede llevar el mismo. La
 * designación vale mientras la frase del dev que la nombra siga en esa conversación (lib/critical-waivers.js).
 */
function citaReenviada(cita, sesion, opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo, encontrada: false };
  const rol = String(sesion || '').trim();
  const cw = require('./critical-waivers.js');
  const d = cw.designacionVigente({ home: opts.home });
  if (!d || d.error) {
    return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: d && d.error ? d.error
      : `ninguna sesión de esta máquina está designada como «${rol}»: el dev escribe en el chat de esa sesión «Esta sesión es la ${rol}» y la sesión corre marker.js designate-relay con su frase` };
  }
  if (d.rol && d.rol.toLowerCase() !== rol.toLowerCase()) {
    return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: `la sesión designada en esta máquina es la «${d.rol}», no la «${rol}»` };
  }
  // una sesión no se reenvía a sí misma: su propio ok tiene que ser del dev, en su chat
  const propia = String((opts.env || process.env).CLAUDE_CODE_SESSION_ID || '');
  if (d.sesion === propia) {
    return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: `esta sesión es la «${rol}» designada: no puede reenviarse un ok a sí misma` };
  }
  const juez = cw.juezDesignacion(rol);
  if (juez(d.cita)) return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: `la designación de esta máquina no vale: ${juez(d.cita)}` };
  const designada = leerConversacion({ ...opts, sesion: d.sesion });
  if (!designada.legible) return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: `no puedo leer la conversación designada como «${rol}» (${designada.motivo})` };
  const frase = buscar(d.cita, textosDeUsuario(designada.registros).filter((t) => (!t.origen || t.origen.kind === 'human') && !t.sistema)
    .map((t) => ({ texto: escritoPorLaPersona(t.texto), cuando: t.cuando })).filter((t) => t.texto !== null), null, juez);
  if (!frase.encontrada) {
    return { legible: true, archivo: conv.archivo, encontrada: false, rechazo: frase.rechazo
      ? `la designación de esta máquina no vale: ${frase.rechazo}`
      : `la designación de esta máquina no vale: la frase del dev que nombra la sesión «${rol}» no está en esa conversación` };
  }
  // los mensajes que mandó la conversación designada: el número que devuelve cada envío, fuera de sus subagentes
  const enviados = new Set();
  for (const r of designada.registros) {
    if (r && !r.isSidechain && r.toolUseResult && typeof r.toolUseResult.msg_id === 'string') enviados.add(r.toolUseResult.msg_id);
  }
  const reenviados = [];
  // el mensaje de otra sesión lo marca Claude Code (`origin.kind: peer`, con su número y el cuerpo): se lee la marca, no
  // las etiquetas del texto, que el agente puede imprimir
  for (const t of textosDeUsuario(conv.registros)) {
    const o = t.origen;
    if (!o || o.kind !== 'peer' || typeof o.msg_id !== 'string' || !enviados.has(o.msg_id)) continue;
    const m = typeof o.body === 'string' ? { cuerpo: o.body } : mensajeDeOtraSesion(t.texto);
    if (m && !RE_AJENO.test(m.cuerpo)) reenviados.push({ texto: m.cuerpo, cuando: t.cuando });
  }
  return { legible: true, archivo: conv.archivo, ...buscar(cita, reenviados, opts.desde, opts.juzgar) };
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

module.exports = { CITA_MINIMA, leerConversacion, citaDeLaPersona, citaReenviada, planEnLaConversacion };
