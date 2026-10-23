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
 * ejecución» cerrarla con un control en rojo o con pasos sin correr, y «autorizo cerrar como deuda» cerrar la historia
 * por su salida prevista o registrar un control en rojo como esperado.
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
 *   imprime `{ ok, via, relevo?, motivo?, sinConversacion? }` y sale 0 si está autorizado, 3 si no.
 */
const path = require('path');

const VENTANA_MIN = 30;
// los escapes que piden la frase: la variable y el valor que apaga el freno
const ESCAPES = { TYCON_SAFETY_OFF: '1', TYCON_PROD_LINT: '0', TYCON_NEW_NAMES: '0' };
// los que no son una variable: el nombre del escape va en la frase igual («autorizo story-skill-bypass»)
const NAMED = ['story-skill-bypass', 'set-autonomous', 'cerrar la ejecución', 'cerrar como deuda'];
const esEscape = (v) => Object.prototype.hasOwnProperty.call(ESCAPES, v) || NAMED.includes(v);

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
  const v = variable.toLowerCase();
  const frase = new RegExp(`(?:^|[^\\p{L}\\p{N}_])autorizo\\s+${v}(?![\\p{L}\\p{N}_])`, 'u');
  const juzgar = (texto) => {
    const oraciones = plano(texto).split(/[.!;\n]+/);
    const conLaFrase = oraciones.filter((o) => frase.test(o));
    if (!conLaFrase.length) return `la frase no nombra ${variable} sola (una variable más larga no la autoriza)`;
    for (const o of conLaFrase) {
      if (/[?¿]/.test(o)) continue;
      if (NIEGA.test(o.replace(frase, ' '))) continue;
      return null;
    }
    return /[?¿]/.test(conLaFrase.join(' ')) && !conLaFrase.some((o) => !/[?¿]/.test(o)) ? 'la frase es una pregunta' : 'la frase lo niega o lo retira';
  };
  juzgar.retracta = (texto) => {
    const t = plano(texto);
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${v}(?![\\p{L}\\p{N}_])`, 'u').test(t) && NIEGA.test(t);
  };
  return juzgar;
}

/** ¿La persona, o la sesión designada, autorizó `variable` en los últimos `ventanaMin` minutos? */
function escapeAutorizado({ variable, sesion, pedido, home, env = process.env, arnes, ahora = Date.now(), ventanaMin = VENTANA_MIN } = {}) {
  if (!esEscape(variable)) return { ok: false, motivo: `${variable} no es un escape que se autorice con una frase` };
  if (!sesion || !/^[\w-]+$/.test(String(sesion))) return { ok: false, sinConversacion: true, motivo: 'la herramienta no dijo de qué sesión es el comando' };
  // la punta de la cadena: el pedido que se está juzgando. Sin él, un renglón agregado después del pedido sería la punta
  if (!pedido || !/^[\w-]+$/.test(String(pedido))) return { ok: false, sinConversacion: true, motivo: 'la herramienta no dijo qué pedido se está juzgando (tool_use_id)' };
  const pok = require('./person-ok.js');
  const cw = require('./critical-waivers.js');
  const desde = new Date(ahora - ventanaMin * 60000).toISOString();
  const cita = frase(variable);
  const juzgar = juez(variable);
  // la sesión de la conversación es la del comando: un reenvío a sí misma no cuenta (citaReenviada)
  const e = { ...env, CLAUDE_CODE_SESSION_ID: String(sesion) };
  // sólo la cadena de la conversación: un «turno de la persona» agregado al archivo por fuera no cuenta
  const propia = pok.citaDeLaPersona(cita, { sesion, home, env: e, desde, sinPegado: true, juzgar, soloCadena: true, pedido });
  if (!propia.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${propia.motivo})` };
  if (propia.encontrada) return { ok: true, via: 'persona', cuando: propia.cuando || null };
  const relevo = cw.sesionQueReenvia({ env: e, home, ...(arnes ? { arnes } : {}) });
  if (relevo.valor) {
    const r = pok.citaReenviada(cita, relevo.valor, { sesion, home, env: e, desde, juzgar, soloCadena: true, pedido });
    if (r.encontrada) return { ok: true, via: 'reenvio', relevo: relevo.valor, cuando: r.cuando || null };
  }
  const motivo = propia.rechazo || (propia.anterior ? `la frase es de hace más de ${ventanaMin} minutos` : `la persona no escribió «${cita}» en esta conversación`);
  return { ok: false, motivo };
}

module.exports = { ESCAPES, NAMED, VENTANA_MIN, frase, juez, escapeAutorizado };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  let r;
  try {
    // el perfil del equipo que declara la sesión que reenvía se lee del árbol de este archivo, nunca de una variable
    r = escapeAutorizado({ variable: arg('--variable'), sesion: arg('--session'), pedido: arg('--tool-use-id'), arnes: path.join(__dirname, '..', '..', '..', '..') });
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
