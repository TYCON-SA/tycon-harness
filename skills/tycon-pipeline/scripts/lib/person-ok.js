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
// `browser_instruction` lo pega la extensión con lo que viene del navegador, que puede traer texto de una página.
const BLOQUES_AJENOS = ['task-notification', 'cross-session-message', 'agent-message', 'local-command-stdout', 'local-command-stderr',
  'bash-stdout', 'bash-stderr', 'command-stdout', 'command-stderr', 'browser_instruction'];
const RE_AJENO = new RegExp(`</?(?:${BLOQUES_AJENOS.join('|')})\\b`, 'i');
const ENCABEZADO_OTRA_SESION = /^\s*Another Claude session sent a message:\s*/;

// Claude Code escribe el registro con el pedido al mismo tiempo que corre el freno, y a veces después (medido: hasta 1,5 s
// tarde). Sin el pedido no hay punta: se vuelve a leer cada `RELECTURA_MS` hasta `ESPERA_PASO_MS`. Sólo espera cuando
// falta el pedido; el camino normal no suma nada.
// Lo que la espera no prueba: que el pedido que aparece lo escribió Claude Code. Para forjar uno hace falta su id, y el id
// no se ve afuera del freno: el freno se lo pasa al lector por la entrada, nunca en la línea de comandos (`ps`).
const ESPERA_PASO_MS = 3000;
const RELECTURA_MS = 100;
const MOTIVO_PASO_NO_UBICADO = 'no pude ubicar este paso en la conversación: el registro de esta llamada no llegó a escribirse a tiempo; reintentá el mismo comando';
const MOTIVO_PASO_DUPLICADO = 'no pude ubicar este paso en la conversación: hay más de un registro con este pedido, y uno no lo escribió Claude Code';
const MOTIVO_PASO_OTRO_ARCHIVO = 'no pude ubicar este paso en la conversación: el pedido también está en otro archivo de esta sesión, y uno no lo escribió Claude Code';
const MOTIVO_ARCHIVO_AJENO = 'no pude ubicar este paso en la conversación: el archivo que dice la herramienta no es el registro de esta sesión';
const MOTIVO_ARCHIVO_ILEGIBLE = 'no pude ubicar este paso en la conversación: el registro de esta sesión está donde dice la herramienta, pero no se puede leer';
// los pedidos que ya se esperaron sin suerte en este proceso: otra lectura del mismo no vuelve a esperar
const pasosNoUbicados = new Set();
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

/** ¿La ruta está dentro de la carpeta de proyectos de Claude Code, escrita tal cual o con la ruta real de la carpeta? */
function enProyectos(ruta, root) {
  const dentro = (raiz) => {
    const rel = path.relative(raiz, path.resolve(ruta));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (dentro(path.resolve(root))) return true;
  try { return dentro(fs.realpathSync(root)); } catch (_e) { return false; }
}

/**
 * El archivo que la herramienta dice que es el registro de esta sesión (`transcript_path` de la entrada del freno), si
 * es `<projects>/<carpeta>/<sesión>.jsonl` con la ruta real: otro archivo, aunque se llame igual, no vale (`null`).
 */
function archivoDeLaHerramienta(transcript, root, sid) {
  let real;
  let raiz;
  try { real = fs.realpathSync(transcript); raiz = fs.realpathSync(root); } catch (_e) { return null; }
  const partes = path.relative(raiz, real).split(path.sep);
  if (partes.length !== 2 || !partes[0] || partes[0] === '..' || partes[1] !== `${sid}.jsonl`) return null;
  if (!esArchivoComun(real)) return null;
  return real;
}

/**
 * ¿El pedido aparece en otro archivo de esta sesión? Los otros `<carpeta>/<sesión>.jsonl` (la misma sesión puede tener
 * registro en dos carpetas) y todo `.jsonl` debajo de `<carpeta>/<sesión>/` (sus subagentes). Un pedido lo escribe
 * Claude Code una sola vez: si está en dos archivos, uno es una copia. Lo que no se puede leer, o no es un archivo común
 * (una tubería dejaría al freno esperando), cuenta como que está.
 */
function pedidoEnOtroArchivo(root, sid, propio, pedido) {
  const contiene = (f) => {
    try { return fs.realpathSync(f) !== propio && leerArchivoComun(f).includes(pedido); } catch (_e) { return true; }
  };
  const recorrer = (dir) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return e.code !== 'ENOENT'; }
    for (const e of entradas) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() ? recorrer(f) : e.name.endsWith('.jsonl') && (!e.isFile() || contiene(f))) return true;
    }
    return false;
  };
  let carpetas;
  try { carpetas = fs.readdirSync(root); } catch (_e) { return true; }
  for (const d of carpetas) {
    const f = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(f) && contiene(f)) return true;
    if (recorrer(path.join(root, d, sid))) return true;
  }
  return false;
}

/**
 * El registro de la conversación de esta sesión: `{ legible, motivo?, registros }`. Con `transcript` (la ruta que da la
 * herramienta), ese archivo, si es el de esta sesión; si no, el primero que aparece en las carpetas de proyectos.
 * Una ruta fuera de la carpeta de proyectos es la conversación de otra herramienta (Codex): `legible: false`, como sin
 * ruta. Una ruta adentro es de Claude Code: si no es el registro de esta sesión o no se puede leer (el permiso quitado,
 * demasiado grande), vuelve `pasoNoUbicado`, nunca `legible: false`, que dejaría pasar sin mirar.
 *
 * Con `soloCadena`, sólo los registros de la cadena de la conversación (`enLaCadena`), con la punta en `pedido` si
 * viene: lo que se agregó por fuera no cuenta. Vuelve `pasoNoUbicado` con su motivo, y la cadena vacía, si el pedido no
 * aparece dentro de la espera, si aparece más de una vez o si aparece también en otro archivo de la sesión: no se busca
 * otra punta, porque el último renglón del archivo puede ser uno forjado. Cuando el pedido llega durante la espera, se
 * sigue mirando hasta el final de la espera: una copia forjada puede llegar antes o después que el real.
 */
function leerConversacion({ env = process.env, home = os.homedir(), sesion, soloCadena = false, pedido, transcript } = {}) {
  const sid = String(sesion || env.CLAUDE_CODE_SESSION_ID || '');
  if (!/^[\w-]+$/.test(sid)) return { legible: false, motivo: 'la sesión no dice su identificador' };
  const root = path.join(home, '.claude', 'projects');
  let file = null;
  const deLaHerramienta = !!transcript && enProyectos(String(transcript), root);
  if (transcript && !deLaHerramienta) return { legible: false, motivo: 'la conversación es de otra herramienta, que no sé leer' };
  if (deLaHerramienta) {
    file = archivoDeLaHerramienta(String(transcript), root, sid);
    if (!file) return { legible: true, registros: [], pasoNoUbicado: true, motivo: MOTIVO_ARCHIVO_AJENO };
  } else {
    try {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${sid}.jsonl`);
        if (esArchivoComun(f)) { file = fs.realpathSync(f); break; }
      }
    } catch (e) { return { legible: false, motivo: `no pude leer ${root} (${e.code || e.message})` }; }
    if (!file) return { legible: false, motivo: 'no encontré su registro' };
  }
  let registros;
  try { registros = leerRegistros(file); } catch (e) {
    if (deLaHerramienta) return { legible: true, registros: [], archivo: file, pasoNoUbicado: true, motivo: `${MOTIVO_ARCHIVO_ILEGIBLE} (${e.code || e.message})` };
    return { legible: false, motivo: `no pude leer su registro (${e.code || e.message})` };
  }
  if (!soloCadena) return { legible: true, registros, archivo: file };
  const noUbicado = (motivo) => ({ legible: true, registros: [], archivo: file, pasoNoUbicado: true, motivo });
  // lo que invalida la punta: el pedido dos veces en el archivo, o también en otro archivo de la sesión
  const sospecha = (regs) => {
    if (registrosDelPedido(regs, pedido) > 1) return MOTIVO_PASO_DUPLICADO;
    if (pedidoEnOtroArchivo(root, sid, file, pedido)) return MOTIVO_PASO_OTRO_ARCHIVO;
    return null;
  };
  if (!pedido) return { legible: true, registros: enLaCadena(registros), archivo: file };
  let cadena = enLaCadena(registros, { pedido });
  const ya = sospecha(registros);
  if (ya) return noUbicado(ya);
  if (cadena.length) return { legible: true, registros: cadena, archivo: file };
  const clave = `${file}\0${pedido}`;
  if (pasosNoUbicados.has(clave)) return noUbicado(MOTIVO_PASO_NO_UBICADO);
  const hasta = Date.now() + ESPERA_PASO_MS;
  while (Date.now() < hasta) {
    dormir(Math.min(RELECTURA_MS, Math.max(0, hasta - Date.now())));
    let regs;
    try { regs = leerRegistros(file); } catch (_e) { continue; /* se reintenta hasta el tope */ }
    const motivo = sospecha(regs);
    if (motivo) return noUbicado(motivo);
    if (!cadena.length) cadena = enLaCadena(regs, { pedido });
  }
  if (cadena.length) return { legible: true, registros: cadena, archivo: file };
  pasosNoUbicados.add(clave);
  return noUbicado(MOTIVO_PASO_NO_UBICADO);
}

/** Cuántos registros distintos (por uuid) del agente, fuera de los subagentes, traen el `tool_use` con ese id. */
function registrosDelPedido(registros, pedido) {
  const uuids = new Set();
  for (const x of registros) {
    if (!x || x.isSidechain || x.type !== 'assistant' || typeof x.uuid !== 'string') continue;
    const c = x.message && Array.isArray(x.message.content) ? x.message.content : [];
    if (c.some((b) => b && b.type === 'tool_use' && b.id === pedido)) uuids.add(x.uuid);
  }
  return uuids.size;
}

/**
 * Los registros que son parte de la conversación: los que se alcanzan desde la punta siguiendo el padre de cada uno
 * (`parentUuid`, o `logicalParentUuid` después de una compactación).
 *
 * La punta es el pedido del agente que se está juzgando: el registro que trae el `tool_use` con ese id (`pedido`, el
 * `tool_use_id` que la herramienta le pasa al freno). Sin `pedido`, el último registro con uuid (la sesión designada,
 * que no tiene un pedido en curso). Un renglón agregado por fuera queda afuera: ningún registro que escribe Claude
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

const norm = (s) => String(s).toLowerCase().replace(/[«»"“”'‘’`]/g, ' ').replace(/\s+/g, ' ').trim();
const letras = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;

// `desde`: la hora a partir de la cual vale el ok (el arranque de la corrida, o la muestra del crítico). Una frase
// vieja del dev no aprueba lo que todavía no existía. `juzgar(texto)`: si viene, el mensaje entero que trae la cita
// tiene que pasarlo (null); si no, su motivo vuelve como `rechazo` (el del mensaje más nuevo).
// `entero`: una cita más corta que `CITA_MINIMA` (un «ok», un «dale») vale si es el mensaje entero; sin él, no vale.
function buscar(cita, candidatos, desde, juzgar, entero = false) {
  const c = norm(cita);
  const corta = letras(c) < CITA_MINIMA;
  if (corta && (!entero || !letras(c))) return { encontrada: false, corta: true };
  const t0 = desde ? Date.parse(desde) : NaN;
  let vieja = false;
  let rechazo = null;
  // la última vez que se dijo: la hora que se anota es la del ok más reciente
  for (let i = candidatos.length - 1; i >= 0; i--) {
    const dicho = norm(candidatos[i].texto);
    if (corta ? dicho !== c : !dicho.includes(c)) continue;
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
  // `sinPegado`: lo que pegó no cuenta como dicho por ella (la designación de la sesión que reenvía)
  const propios = textosDeUsuario(conv.registros).filter((t) => (!t.origen || t.origen.kind === 'human') && !t.sistema)
    .map((t) => ({ texto: escritoPorLaPersona(opts.sinPegado ? sinTextoPegado(t.texto) : t.texto), cuando: t.cuando })).filter((t) => t.texto !== null);
  const paso = conv.pasoNoUbicado ? { pasoNoUbicado: true, motivo: conv.motivo } : {};
  return { legible: true, archivo: conv.archivo, ...paso, ...buscar(cita, propios, opts.desde, opts.juzgar, opts.enteroSiCorta === true) };
}

/**
 * Lo que dijo la sesión designada en esta máquina para el rol `sesion` (por ejemplo «coordinadora»), leído de las dos
 * conversaciones: `{ legible, motivo?, archivo?, rechazo?, duenio?, reenviados? }`.
 *   duenio      lo que tipeó la persona en la conversación designada (no lo pegado, ni lo de otra sesión, ni lo de una
 *               herramienta): `[{ texto, cuando }]`
 *   reenviados  los mensajes de esa sesión que llegaron a ESTA conversación: `[{ texto, cuando }]`
 * Cuenta un mensaje de otra sesión cuyo número de mensaje (`origin.msg_id`, lo pone Claude Code al entregarlo) figura
 * entre los que mandó la conversación designada (el `msg_id` del resultado de cada envío, en su registro). El nombre de
 * la sesión que manda no cuenta: lo pone el sistema, cambia al reiniciar y otra sesión puede llevar el mismo. La
 * designación vale mientras la frase del dev que la nombra siga en esa conversación (lib/critical-waivers.js).
 */
function laDesignada(sesion, opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo };
  const rol = String(sesion || '').trim();
  const cw = require('./critical-waivers.js');
  const d = cw.designacionVigente({ home: opts.home });
  if (!d || d.error) {
    return { legible: true, archivo: conv.archivo, rechazo: d && d.error ? d.error
      : `ninguna sesión de esta máquina está designada como «${rol}»: el dev escribe en el chat de esa sesión «Esta sesión es la ${rol}» y la sesión corre marker.js designate-relay con su frase` };
  }
  if (d.rol && d.rol.toLowerCase() !== rol.toLowerCase()) {
    return { legible: true, archivo: conv.archivo, rechazo: `la sesión designada en esta máquina es la «${d.rol}», no la «${rol}»` };
  }
  // una sesión no se reenvía a sí misma: su propio ok tiene que ser del dev, en su chat
  const propia = String((opts.env || process.env).CLAUDE_CODE_SESSION_ID || '');
  if (d.sesion === propia) {
    return { legible: true, archivo: conv.archivo, rechazo: `esta sesión es la «${rol}» designada: no puede reenviarse un ok a sí misma` };
  }
  const juez = cw.juezDesignacion(rol);
  if (juez(d.cita)) return { legible: true, archivo: conv.archivo, rechazo: `la designación de esta máquina no vale: ${juez(d.cita)}` };
  // con `soloCadena`, también la conversación designada: un renglón forjado ahí (la designación, un envío) no cuenta
  const designada = leerConversacion({ ...opts, sesion: d.sesion, pedido: undefined, transcript: undefined });
  if (!designada.legible) return { legible: true, archivo: conv.archivo, rechazo: `no puedo leer la conversación designada como «${rol}» (${designada.motivo})` };
  const duenio = textosDeUsuario(designada.registros).filter((t) => (!t.origen || t.origen.kind === 'human') && !t.sistema)
    .map((t) => ({ texto: escritoPorLaPersona(sinTextoPegado(t.texto)), cuando: t.cuando })).filter((t) => t.texto !== null);
  const frase = buscar(d.cita, duenio, null, juez);
  if (!frase.encontrada) {
    return { legible: true, archivo: conv.archivo, rechazo: frase.rechazo
      ? `la designación de esta máquina no vale: ${frase.rechazo}`
      : `la designación de esta máquina no vale: la frase del dev que nombra la sesión «${rol}» no está en esa conversación` };
  }
  // los mensajes que mandó la conversación designada: el número que devuelve cada envío, fuera de sus subagentes
  const enviados = new Set();
  // con `soloCadena`, un envío cuenta si la conversación siguió después (algún registro lo tiene como padre): en una
  // sesión quieta, un renglón forjado al final del archivo es la punta de su propia cadena, pero no tiene hijos
  const conHijos = new Set();
  if (opts.soloCadena) for (const r of designada.registros) if (r && typeof r.parentUuid === 'string') conHijos.add(r.parentUuid);
  for (const r of designada.registros) {
    if (!r || r.isSidechain || !r.toolUseResult || typeof r.toolUseResult.msg_id !== 'string') continue;
    if (opts.soloCadena && !conHijos.has(r.uuid)) continue;
    enviados.add(r.toolUseResult.msg_id);
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
  return { legible: true, archivo: conv.archivo, designada: d.sesion, duenio, reenviados };
}

/**
 * ¿La cita llegó dentro de un mensaje de la sesión designada en esta máquina para el rol `sesion`? `{ legible, motivo?,
 * encontrada, cuando?, corta?, rechazo? }` (laDesignada dice qué mensaje cuenta).
 */
function citaReenviada(cita, sesion, opts = {}) {
  const l = laDesignada(sesion, opts);
  if (!l.legible) return { legible: false, motivo: l.motivo, encontrada: false };
  if (l.rechazo) return { legible: true, archivo: l.archivo, encontrada: false, rechazo: l.rechazo };
  return { legible: true, archivo: l.archivo, ...buscar(cita, l.reenviados, opts.desde, opts.juzgar, opts.enteroSiCorta === true) };
}

/**
 * Las respuestas que la persona eligió (o escribió en «Otra») en una pregunta con opciones de la sesión principal: el
 * resultado estructurado (`toolUseResult.answers`) de un registro que contesta un `tool_use` de `AskUserQuestion` del
 * agente. Lo escribe Claude Code cuando la persona contesta en la pantalla; un texto del agente que lo imite no es eso.
 */
function respuestasDeOpciones(registros) {
  const preguntas = new Set();
  for (const r of registros) {
    const c = r && r.type === 'assistant' && !r.isSidechain && r.message && r.message.content;
    if (Array.isArray(c)) for (const x of c) if (x && x.type === 'tool_use' && x.name === 'AskUserQuestion' && x.id) preguntas.add(x.id);
  }
  const out = [];
  for (const r of registros) {
    const res = r && r.type === 'user' && !r.isSidechain && r.toolUseResult;
    if (!res || typeof res.answers !== 'object' || !res.answers) continue;
    const c = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    if (!c.some((x) => x && x.type === 'tool_result' && preguntas.has(x.tool_use_id))) continue;
    // una pregunta de selección múltiple guarda la lista de las opciones elegidas: cada una cuenta
    for (const v of Object.values(res.answers)) {
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') out.push({ texto: x, cuando: r.timestamp || null });
    }
  }
  return out;
}

/** ¿La cita es una respuesta que la persona eligió en una pregunta con opciones? `{ legible, encontrada, … }`. */
function citaDeOpciones(cita, opts = {}) {
  const conv = leerConversacion(opts);
  if (!conv.legible) return { legible: false, motivo: conv.motivo, encontrada: false };
  return { legible: true, archivo: conv.archivo, ...buscar(cita, respuestasDeOpciones(conv.registros), opts.desde, opts.juzgar, opts.enteroSiCorta === true) };
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

module.exports = { CITA_MINIMA, ESPERA_PASO_MS, MOTIVO_PASO_NO_UBICADO, MOTIVO_PASO_DUPLICADO, MOTIVO_PASO_OTRO_ARCHIVO, leerConversacion, enLaCadena, citaDeLaPersona, citaReenviada, laDesignada, citaDeOpciones, planEnLaConversacion };
