#!/usr/bin/env node
/**
 * response-style-notice.js — hook `UserPromptSubmit`: entrega el veredicto que dejó el medidor.
 *
 * Par de `response-style-meter.js` (hook Stop). El medidor no puede corregir el mensaje que el
 * user ya leyó; lo que sí puede es dejar el número anotado. Este hook lo cobra al inicio del
 * turno siguiente, cuando todavía sirve.
 *
 * Consume el pending (lo borra al emitirlo) → un aviso por infracción, nunca repetido.
 * Fail-open total: cualquier error → exit 0 sin output.
 *
 * Opt-out: TYCON_RESPONSE_METER=0 en la máquina, o `switches.response_meter: "off"` en el perfil (la variable gana).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'response-style', 'pending');

function emitReminder(text) {
  process.stdout.write(`<system-reminder>\n${text.trim()}\n</system-reminder>\n`);
}

// 🔇 Sandbox de EVALS: las corridas del banco spawnean `claude -p` y cada hook
// UserPromptSubmit le inyecta su reminder AL PROMPT del agente simulado, que lo lee como parte de
// la conversación. Eso sesga la medición (0-1 menciones en un brazo contra 6-10 en el otro).
// El arnés setea TYCON_EVAL_SANDBOX=1 al spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

// La organización puede apagar o encender este medidor desde el sitio (`switches.response_meter` del perfil); la variable
// TYCON_RESPONSE_METER de la máquina, si está puesta, gana. Sin lector, o con la configuración rota, sigue encendido: una clave
// que no se puede leer no lo apaga, y el aviso va a stderr.
function orgSwitchOn(name) {
  try {
    const C = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    return C.switchOn(name, { warn: (w) => process.stderr.write(`${w}\n`) });
  } catch { return true; }
}

function main() {
  if (process.env.TYCON_RESPONSE_METER === '0') return;
  if (!orgSwitchOn('response_meter')) return;

  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }

  const sessionId = event.session_id || event.sessionId || '_nosession';
  const file = path.join(PENDING_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return;

  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
  // Consumir siempre, incluso si vino corrupto: un pending ilegible no debe avisar para siempre.
  try { fs.unlinkSync(file); } catch { /* fail-open */ }
  if (!p) return;

  emitReminder(`estilo de respuesta — tu mensaje final del turno anterior se pasó de largo: ${p.reasons.join(' · ')}.

La regla es el bloque «REGLA ESTILO DE RESPUESTA» de tus instrucciones, con el estilo que eligió tu organización. El tope medido es ${p.maxProseChars || 1300} caracteres de prosa (≈ ${Math.ceil((p.maxProseChars || 1300) / 100)} renglones en pantalla) y ${p.maxHeaders} título(s) de sección — las tablas y los bloques de código NO cuentan (un artefacto que el user pidió no es verbosidad). 🔴 Ojo: se mide por CARACTERES, no por líneas — un párrafo largo sin cortes es 1 línea pero muchos renglones para el lector, así que "pocos párrafos" no equivale a "corto". Cada oración: ~20 palabras y una sola idea; el medidor cobra la que pasa de ${p.maxSentenceWords || 35}.
${p.savedTo ? `\nEl texto completo quedó guardado en ${p.savedTo} — si algo de eso hace falta, citá la ruta en vez de volver a pegarlo.\n` : ''}
En este turno aplicá ese bloque tal como está.

Excepciones legítimas (no fuerces el recorte si aplica alguna): algo bloqueante o roto donde el error crudo es necesario para actuar · una decisión del user donde el detalle es el insumo · un mensaje de commit o artefacto que tiene que leer entero para aprobar · el user pidió el detalle explícitamente.

Esto es una medición automática, no un reto del user — no le pidas perdón ni lo comentes en la respuesta salvo que él lo saque.`);
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
