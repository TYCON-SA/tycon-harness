#!/usr/bin/env node
/**
 * coordination-notice.js — hook `UserPromptSubmit`: el aviso del tope de sesiones y de las firmas viejas, sólo para la
 * coordinadora, y el de la lista de firmas. Hook `SessionStart`: después de compactar o de limpiar la conversación, le
 * pide a la coordinadora que lea sus reglas otra vez; si limpiarla le quitó la designación, le dice cómo recuperarla.
 *
 * En cada turno de la sesión designada como coordinadora (guides/coordination.md) cuenta las sesiones que trabajan.
 * En el tope dice quiénes son; pasado el tope, por cuánto y cuál trabaja hace menos. Debajo del tope, nada. Las firmas
 * por la terminal que esperan hace más de un día salen en una línea, una vez por día. Sin suite completa en curso y con
 * sesiones que anotaron que esperan su turno (de suite, de portón), nombra a la que espera hace más para que arranque. Con
 * la lista de firmas encendida, si escribió la persona y hay renglones sin avisar, pide pasarlos de a uno: a la
 * coordinadora viva o, sin ella, a la sesión destino de cada uno. Cualquier otra sesión no ve nada: sin coordinadora
 * designada, o en otra sesión, el hook calla. El
 * tope no abre conversaciones; la lista mira la de esta sesión, sólo en una de fondo, para no contar su encargo como la persona.
 * Un error propio nunca frena el turno. Opt-out: TYCON_COORDINATION_NOTICE=0
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Las corridas del banco lanzan `claude -p`: un aviso acá se leería como parte del caso.
if (process.env.TYCON_EVAL_SANDBOX === '1' || process.env.TYCON_COORDINATION_NOTICE === '0') process.exit(0);

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch {
    // Sin el evento no se sabe qué sesión es, y el aviso es sólo para la coordinadora: no hay a quién decírselo.
    return;
  }
  const sessionId = event.session_id || event.sessionId || null;
  if (!sessionId) return;
  const { capNotice, guideNotice, listNotice } = require(path.join(__dirname, '..', 'tools', 'coordination.js'));
  const notices = [];
  if (event.hook_event_name === 'SessionStart') {
    notices.push(guideNotice({ sessionId, env: process.env, source: event.source, title: event.session_title, transcript: event.transcript_path }));
  } else {
    notices.push(capNotice({ sessionId, env: process.env }));
    // Codex firma por terminal: no entra a la lista
    if (!event.turn_id) notices.push(listNotice({ sessionId, env: process.env, prompt: event.prompt, transcript: event.transcript_path }));
  }
  const notice = notices.filter(Boolean).join('\n');
  if (notice) process.stdout.write(`<system-reminder>\n${notice}\n</system-reminder>\n`);
}

try { main(); } catch (e) {
  // Sólo la coordinadora llega hasta acá con algo que decir; un error inesperado va a stderr, que el turno no lee.
  try { process.stderr.write(`coordination-notice: ${String((e && e.message) || e).split('\n')[0]}\n`); } catch { /* nada */ }
}
process.exit(0);
