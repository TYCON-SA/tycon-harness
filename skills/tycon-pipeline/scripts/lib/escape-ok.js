#!/usr/bin/env node
'use strict';
/**
 * escape-ok — ¿una persona autorizó este escape de un freno?
 *
 * Un escape escrito en la línea del comando (`TYCON_SAFETY_OFF=1 <cmd>`, `TYCON_PROD_LINT=0 git commit`) lo puede
 * escribir el agente solo. Vale únicamente si la persona escribió «autorizo <VARIABLE>» en un turno suyo de esta
 * conversación, o si llegó textual en un mensaje de la sesión que la organización designó para reenviar el ok de un dev
 * (`approvals.relay_session` del perfil + `designate-relay`). La frase vale `VENTANA_MIN` minutos.
 * Los escapes que no son una variable van por su nombre en la misma frase (`NAMED`): «autorizo story-skill-bypass» deja
 * escribir una historia sin la skill, «autorizo set-autonomous» apagar el lazo de las pruebas, «autorizo cerrar la
 * ejecución» cerrarla con un control en rojo o con pasos sin correr, «autorizo cerrar como deuda» cerrar la historia
 * por su salida prevista o registrar un control en rojo como esperado, «autorizo force-manual» declarar un control en
 * verde a mano, «autorizo trust-ran» la constancia de revisores que el arnés no vio correr, «autorizo
 * ALLOW_DOD_EVIDENCE_WRITE» una escritura a mano de la evidencia de la prueba en vivo y «autorizo dod_runtime_exempt»
 * la exención de esa prueba en una historia que ya está en implementación. Apagar el pase adversarial tiene dos nombres
 * (`TYCON_NO_DEEP_REVIEW` y `no-deep-review`) y la frase de cualquiera de los dos vale para los dos. Pasar una historia
 * a review o done a mano también tiene dos: «autorizo cambiar el estado» y el interruptor `TYCON_STATUS_GATE`.
 *
 * Quién escribió qué lo decide `person-ok.js`: no cuenta lo que escribió el agente, la salida de una herramienta (un
 * archivo leído incluido), un subagente, lo que la persona pegó ni el mensaje de otra sesión que no es la designada.
 * Y sólo cuenta lo que está en la cadena de la conversación (`enLaCadena`): un renglón agregado al archivo por fuera no
 * lo tiene como padre ningún registro que escribe Claude Code.
 * Sin conversación legible (Codex, u otra herramienta) no hay frase que buscar: el escape no vale.
 *
 * La punta de la cadena es el pedido que se está juzgando (`tool_use_id` de la entrada del freno): sin él no vale.
 *
 * Uso desde el freno: node escape-ok.js --variable TYCON_SAFETY_OFF --session <id> --tool-use-id <id> [--shell]
 *   [--since <hora>] [--no-relay]   (la salida de una ejecución perdida: la frase posterior a su apertura, sin reenvío)
 *   imprime `{ ok, via, relevo?, motivo?, sinConversacion? }` y sale 0 si está autorizado, 3 si no.
 */
const path = require('path');

const VENTANA_MIN = 30;
// los escapes que piden la frase: la variable y el valor que apaga el freno (`TYCON_TEST_GATE` y `DOD_BYPASS` lo activan
// con cualquier valor que no sea 0 ni vacío; el 1 es el de siempre)
const ESCAPES = { TYCON_SAFETY_OFF: '1', TYCON_PROD_LINT: '0', TYCON_NEW_NAMES: '0', TYCON_TEST_GATE: '1', DOD_BYPASS: '1',
  TYCON_NO_DEEP_REVIEW: '1', TYCON_STATUS_GATE: 'off' };
// los que no son una variable: el nombre del escape va en la frase igual («autorizo story-skill-bypass»)
const NAMED = ['story-skill-bypass', 'set-autonomous', 'cerrar la ejecución', 'cerrar como deuda', 'force-manual',
  'trust-ran', 'ALLOW_DOD_EVIDENCE_WRITE', 'dod_runtime_exempt', 'no-deep-review', 'cambiar el estado'];
const esEscape = (v) => Object.prototype.hasOwnProperty.call(ESCAPES, v) || NAMED.includes(v);
// los nombres de un mismo escape: la frase de uno autoriza el otro (apagar el pase adversarial por la variable o por la
// bandera es la misma decisión; pasar una historia a review o done a mano, o apagar ese freno, también)
const SINONIMOS = { TYCON_NO_DEEP_REVIEW: ['no-deep-review'], 'no-deep-review': ['TYCON_NO_DEEP_REVIEW'],
  TYCON_STATUS_GATE: ['cambiar el estado'], 'cambiar el estado': ['TYCON_STATUS_GATE'] };

const frase = (variable) => `autorizo ${variable}`;

// Las palabras que niegan o retiran, en castellano y en inglés: con una en la misma oración, la frase no autoriza.
const NIEGA = /(?:^|[^\p{L}\p{N}_])(?:no|nunca|jam[aá]s|ni|sin|not|never|don'? ?t|doesn'? ?t|desautoriz\p{L}*|retiro|retir[aá]\p{L}*|olvid\p{L}*|anul\p{L}*|cancel\p{L}*|revoc\p{L}*)(?![\p{L}\p{N}_])/u;

// el texto como lo compara la búsqueda (sin comillas ni acentos graves, sin mayúsculas, con los espacios juntados), pero
// conservando la puntuación que separa oraciones
const plano = (texto) => String(texto || '').toLowerCase().replace(/[«»"“”'‘’`]/g, ' ').replace(/[ \t]+/g, ' ');

/**
 * El juez de la frase. Mira la oración que trae «autorizo <VARIABLE>» (hasta un punto, un signo de admiración, un punto
 * y coma o un salto de línea): la variable tiene que terminar ahí (una más larga no la autoriza), y la oración no puede
 * negarla ni ser una pregunta. `retracta` tumba la frase si un mensaje posterior nombra la variable y la niega o la retira.
 */
function juez(variable) {
  const esc = (n) => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const v = esc(variable);
  const frase = new RegExp(`(?:^|[^\\p{L}\\p{N}_])autorizo\\s+${v}(?![\\p{L}\\p{N}_])`, 'u');
  // el escape por cualquiera de sus nombres: una retractación con el otro nombre también la tumba
  const nombres = [variable, ...(SINONIMOS[variable] || [])].map(esc).join('|');
  const nombra = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${nombres})(?![\\p{L}\\p{N}_])`, 'u');
  // el texto sin los nombres del escape: el «no» de «no-deep-review» no es una negación
  const sinNombres = (t) => t.replace(new RegExp(nombra.source, 'gu'), ' ');
  const juzgar = (texto) => {
    // las oraciones con su signo de cierre: el «?» también corta (una pregunta antes en el renglón no tumba lo que sigue)
    const oraciones = plano(texto).match(/[^.!?;\n]+[.!?;\n]?/g) || [];
    const esPregunta = (o) => /¿/.test(o) || /\?$/.test(o.trim());
    const conLaFrase = oraciones.map((o, i) => ({ o, i })).filter((x) => frase.test(x.o));
    if (!conLaFrase.length) return `la frase no nombra ${variable} sola (una variable más larga no la autoriza)`;
    for (const { o, i } of conLaFrase) {
      if (esPregunta(o)) continue;
      if (NIEGA.test(sinNombres(o.replace(frase, ' ')))) continue;
      // una oración posterior del mismo mensaje que la nombra y la niega o la retira la tumba
      if (oraciones.slice(i + 1).some((d) => nombra.test(d) && !frase.test(d) && NIEGA.test(sinNombres(d)))) return 'la frase lo niega o lo retira';
      return null;
    }
    return conLaFrase.every((x) => esPregunta(x.o)) ? 'la frase es una pregunta' : 'la frase lo niega o lo retira';
  };
  juzgar.retracta = (texto) => {
    const t = plano(texto);
    return nombra.test(t) && NIEGA.test(sinNombres(t));
  };
  return juzgar;
}

/** ¿La persona, o la sesión designada, autorizó `variable` (o uno de sus sinónimos) en los últimos `ventanaMin` minutos? */
function escapeAutorizado(opciones = {}) {
  const r = autorizadoPorNombre(opciones);
  if (r.ok || r.sinConversacion) return r;
  for (const otro of SINONIMOS[opciones.variable] || []) {
    const s = autorizadoPorNombre({ ...opciones, variable: otro });
    if (s.ok) return s;
  }
  return r;
}

// `desdeTs`: la frase vale desde esa hora en vez de la ventana (la salida de una ejecución perdida: posterior a su
// apertura). `sinReenvio`: sólo la frase de la persona, no la reenviada por la sesión designada.
function autorizadoPorNombre({ variable, sesion, pedido, home, env = process.env, arnes, ahora = Date.now(), ventanaMin = VENTANA_MIN, desdeTs, sinReenvio = false } = {}) {
  if (!esEscape(variable)) return { ok: false, motivo: `${variable} no es un escape que se autorice con una frase` };
  if (!sesion || !/^[\w-]+$/.test(String(sesion))) return { ok: false, sinConversacion: true, motivo: 'la herramienta no dijo de qué sesión es el comando' };
  // la punta de la cadena: el pedido que se está juzgando. Sin él, un renglón agregado después del pedido sería la punta
  if (!pedido || !/^[\w-]+$/.test(String(pedido))) return { ok: false, sinConversacion: true, motivo: 'la herramienta no dijo qué pedido se está juzgando (tool_use_id)' };
  const pok = require('./person-ok.js');
  const cw = require('./critical-waivers.js');
  // una hora pedida que no se puede leer no cae a la ventana: no se sabría si la frase es posterior
  if (desdeTs && !Number.isFinite(Date.parse(desdeTs))) return { ok: false, motivo: `la hora de la apertura no se puede leer (${desdeTs})` };
  const apertura = desdeTs ? new Date(desdeTs).toISOString() : null;
  const desde = apertura || new Date(ahora - ventanaMin * 60000).toISOString();
  const cita = frase(variable);
  const juzgar = juez(variable);
  // la sesión de la conversación es la del comando: un reenvío a sí misma no cuenta (citaReenviada)
  const e = { ...env, CLAUDE_CODE_SESSION_ID: String(sesion) };
  // sólo la cadena de la conversación: un «turno de la persona» agregado al archivo por fuera no cuenta
  const propia = pok.citaDeLaPersona(cita, { sesion, home, env: e, desde, sinPegado: true, juzgar, soloCadena: true, pedido });
  if (!propia.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${propia.motivo})` };
  if (propia.encontrada) return { ok: true, via: 'persona', cuando: propia.cuando || null };
  const relevo = sinReenvio ? {} : cw.sesionQueReenvia({ env: e, home, ...(arnes ? { arnes } : {}) });
  if (relevo.valor) {
    const r = pok.citaReenviada(cita, relevo.valor, { sesion, home, env: e, desde, juzgar, soloCadena: true, pedido });
    if (r.encontrada) return { ok: true, via: 'reenvio', relevo: relevo.valor, cuando: r.cuando || null };
  }
  const vieja = apertura ? `la frase es anterior a la apertura de la ejecución (${apertura})` : `la frase es de hace más de ${ventanaMin} minutos`;
  const motivo = propia.rechazo || (propia.anterior ? vieja : `la persona no escribió «${cita}» en esta conversación`);
  return { ok: false, motivo };
}

module.exports = { ESCAPES, NAMED, VENTANA_MIN, frase, juez, escapeAutorizado };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  let r;
  try {
    // el perfil del equipo que declara la sesión que reenvía se lee del árbol de este archivo, nunca de una variable
    r = escapeAutorizado({ variable: arg('--variable'), sesion: arg('--session'), pedido: arg('--tool-use-id'), arnes: path.join(__dirname, '..', '..', '..', '..'),
      desdeTs: arg('--since'), sinReenvio: process.argv.includes('--no-relay') });
  } catch (e) {
    r = { ok: false, motivo: `no pude buscar la autorización (${e.message})` };
  }
  // `--shell`: un renglón `clave=valor` por campo, para que el freno (bash) lo lea sin jq ni sed
  if (process.argv.includes('--shell')) {
    const una = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
    process.stdout.write(`via=${una(r.via)}\nrelevo=${una(r.relevo)}\nsinConversacion=${r.sinConversacion ? 1 : 0}\nmotivo=${una(r.motivo)}\n`);
  } else {
    process.stdout.write(JSON.stringify(r));
  }
  process.exitCode = r.ok ? 0 : 3;
}
