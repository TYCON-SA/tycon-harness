'use strict';
/**
 * hook-ask.js — la salida de un gancho que le pide a la persona la ventana de permiso (`ask`).
 *
 * En Claude Code, `ask` abre la ventana. Codex no soporta `ask`: cuenta el gancho como fallido y el comando corre, y
 * `deny` sí frena con su motivo. Por eso, en Codex la pregunta sale como `deny`, con el texto de la pregunta y cómo
 * aprobarlo a mano. La medición está en guides/maintaining/codex-divergence-inventory.md.
 */

/** ¿El evento es de Codex? Su evento trae `turn_id`; sin evento, la sesión de Codex sin la de Claude Code. */
function esCodex(evento, env = process.env) {
  if (evento && typeof evento.turn_id === 'string') return true;
  return !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
}

/**
 * El JSON que emite el gancho para preguntar. `texto`: la pregunta. `aMano`: cómo se aprueba sin ventana (por defecto,
 * que la persona corra el comando del evento en su terminal). `extra`: campos más del JSON (`systemMessage`).
 */
function salidaDePregunta({ evento, texto, aMano, extra = {}, env = process.env } = {}) {
  if (!esCodex(evento, env)) {
    return JSON.stringify({ ...extra, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: texto } });
  }
  const comando = evento && evento.tool_input && typeof evento.tool_input.command === 'string' ? evento.tool_input.command : '';
  const como = aMano || (comando
    ? `que la persona lo corra en su terminal: ${comando.length > 500 ? `${comando.slice(0, 499)}…` : comando}`
    : 'que la persona lo apruebe a mano');
  const motivo = `${texto}\nCodex no muestra la ventana de permiso, y pedirla deja correr el comando: no sigue. Para aprobarlo, ${como}`;
  return JSON.stringify({ ...extra, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } });
}

module.exports = { esCodex, salidaDePregunta };
