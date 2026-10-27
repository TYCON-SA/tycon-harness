#!/usr/bin/env node
/**
 * coordination-notice.js — hook `UserPromptSubmit`: el aviso del tope de sesiones, sólo para la coordinadora.
 *
 * En cada turno de la sesión designada como coordinadora (guides/coordination.md) cuenta las sesiones que trabajan.
 * En el tope dice quiénes son; pasado el tope, por cuánto y cuál trabaja hace menos. Debajo del tope, nada. Cualquier
 * otra sesión no ve nada: sin coordinadora designada, o en otra sesión, el hook calla. No abre conversaciones.
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
  } catch { return; }
  const sessionId = event.session_id || event.sessionId || null;
  if (!sessionId) return;
  const { capNotice } = require(path.join(__dirname, '..', 'tools', 'coordination.js'));
  const notice = capNotice({ sessionId, env: process.env });
  if (notice) process.stdout.write(`<system-reminder>\n${notice}\n</system-reminder>\n`);
}

try { main(); } catch (e) {
  // Sólo la coordinadora llega hasta acá con algo que decir; un error inesperado va a stderr, que el turno no lee.
  try { process.stderr.write(`coordination-notice: ${String((e && e.message) || e).split('\n')[0]}\n`); } catch { /* nada */ }
}
process.exit(0);
