#!/usr/bin/env node
'use strict';

/**
 * on-controls-off.js — editar la configuración de la herramienta para sacar un control del arnés frena antes (HARNESS-C2).
 *
 * Corre en la cadena de antes de editar del despachador (`dispatch.js`). Compara la configuración de Claude Code de antes
 * con la que deja la edición (lib/controls-off.js): si prende `disableAllHooks`, pone un interruptor que apaga en `env`
 * o saca un hook del arnés, frena y dice cuál. Cualquier otro cambio, y cualquier otro archivo, pasa. La terminal la
 * mira el freno de seguridad (safety-guard-pre.sh), con la misma pieza.
 *
 * El mensaje dice qué control se saca y de quién es la decisión, y nunca cómo apagar el freno.
 */

const CO = require('./lib/controls-off.js');

function mensaje(motivos) {
  return [
    '🛑 TYCON safety-guard BLOCK [HARNESS-C2]',
    '',
    'Esta edición saca un control del arnés de la configuración de la herramienta:',
    ...motivos.map((m) => `  - ${m}`),
    '',
    'Apagar un control lo decide el dev, y lo hace él a mano: el agente no saca controles. Si el control molesta, decíselo',
    'a la persona con el caso. Cualquier otro cambio a este archivo pasa.',
  ].join('\n') + '\n';
}

/** Para el despachador: `{ block }` si la edición saca un control; null si no. */
function handle(event) {
  if (!event || !event.tool_input) return null;
  const motivos = CO.juzgarEdicion({ toolName: event.tool_name, toolInput: event.tool_input, cwd: event.cwd ? String(event.cwd) : process.cwd() });
  return motivos.length ? { block: mensaje(motivos) } : null;
}

module.exports = { handle };
