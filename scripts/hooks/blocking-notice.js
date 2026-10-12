#!/usr/bin/env node
/**
 * blocking-notice.js — hook `UserPromptSubmit`: entrega el veredicto que dejó `blocking-meter.js`.
 *
 * Par del medidor de bloqueo (hook Stop). El medidor no puede des-bloquear la espera que ya pasó;
 * lo que sí puede es dejar el número anotado. Este hook lo cobra al inicio del turno siguiente.
 * Consume el pending (lo borra al emitirlo) → un aviso por infracción, nunca repetido.
 * Fail-open total. Opt-out: TYCON_BLOCKING_METER=0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'blocking-meter', 'pending');

function fmt(ms) {
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

// 🔇 Sandbox de EVALS (2026-07-30): las corridas del banco spawnean `claude -p` y cada hook
// UserPromptSubmit le inyecta su reminder AL PROMPT del agente simulado, que lo lee como parte de
// la conversación. Eso sesga la medición (Story 3.40: 0-1 menciones en un brazo vs 6-10 en el otro).
// El arnés setea TYCON_EVAL_SANDBOX=1 al spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

function main() {
  if (process.env.TYCON_BLOCKING_METER === '0') return;

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
  try { fs.unlinkSync(file); } catch { /* fail-open */ }
  if (!p) return;

  const encolados = p.userMsgs > 0
    ? `\n🔴 Y lo que más duele: ${p.userMsgs} mensaje(s) del dev quedaron ESPERANDO durante esa llamada — al retomar tras una espera, contestarle es LO PRIMERO, antes de encadenar el paso siguiente.\n`
    : '\n';

  process.stdout.write(`<system-reminder>
ejecución en segundo plano — el turno anterior quedó bloqueado ${fmt(p.worstMs)} en una sola tool call (${p.worstTool}; tope ${fmt(p.maxMs)}).
${encolados}
La regla es la del bloque «REGLA EJECUCIÓN EN SEGUNDO PLANO» de tus instrucciones; aplicala en este turno.

Excepciones legítimas (no fuerces el fondo si aplica alguna): un gate mecánico que exige el exit code real en el paso siguiente (run-check/test-gate) · una espera deliberada única sobre trabajo ya de fondo (TaskOutput del cierre) cuando no queda nada más que hacer.

Esto es una medición automática, no un reto del user — no lo comentes en la respuesta salvo que él lo saque. Simplemente lanzá de fondo lo que sea largo.
</system-reminder>
`);
}

try { main(); } catch { /* fail-open */ }
process.exit(0);
