#!/usr/bin/env node
/**
 * blocking-notice.js — hook `UserPromptSubmit`: entrega el veredicto que dejó `blocking-meter.js`.
 *
 * Par del medidor de bloqueo (hook Stop). El medidor no puede des-bloquear la espera que ya pasó;
 * lo que sí puede es dejar el número anotado. Este hook lo cobra al inicio del turno siguiente.
 * Consume el pending (lo borra al emitirlo) → un aviso por infracción, nunca repetido.
 * Dice también, cuando hace falta, que la sesión anote a qué hora termina (scripts/lib/hour-notice.js): es el otro lado de
 * la misma regla, que todo paso largo diga cuánto va a tardar.
 * Fail-open total. Opt-out: TYCON_BLOCKING_METER=0, o `switches.blocking_meter: "off"` en el perfil (la variable gana).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// donde lo deja blocking-meter.js: la carpeta de los registros sueltos (scripts/lib/loose-logs.js); sin ella, null
const LOOSE_DIR = (() => { try { return require('../lib/loose-logs.js').looseLogsDir(); } catch (_) { return null; } })();
const PENDING_DIR = LOOSE_DIR ? path.join(LOOSE_DIR, 'blocking-meter', 'pending') : null;

function fmt(ms) {
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

// 🔇 Sandbox de EVALS: las corridas del banco spawnean `claude -p` y cada hook
// UserPromptSubmit le inyecta su reminder AL PROMPT del agente simulado, que lo lee como parte de
// la conversación. Eso sesga la medición.
// El arnés setea TYCON_EVAL_SANDBOX=1 al spawnear; acá nos callamos.
if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

// La organización puede apagar o encender este medidor desde el sitio (`switches.blocking_meter` del perfil); la variable
// TYCON_BLOCKING_METER de la máquina, si está puesta, gana. Sin lector, o con la configuración rota, sigue encendido: una clave
// que no se puede leer no lo apaga, y el aviso va a stderr.
function orgSwitchOn(name) {
  try {
    const C = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    return C.switchOn(name, { warn: (w) => process.stderr.write(`${w}\n`) });
  } catch { return true; }
}

// El recordatorio de la hora de fin. Si falla, no dice nada.
function hourReminder(sessionId) {
  try {
    const root = path.join(__dirname, '..', '..');
    const pipeline = path.join(root, 'skills', 'tycon-pipeline', 'scripts');
    const { stateDir } = require(path.join(pipeline, 'lib', 'state-dir.js'));
    const notice = require(path.join(__dirname, '..', 'lib', 'hour-notice.js')).hourNotice({ stateDir: stateDir(os.homedir()), sessionId, markerJs: path.join(pipeline, 'marker.js') });
    if (notice) process.stdout.write(`<system-reminder>\n${notice}\n</system-reminder>\n`);
  } catch { /* fail-open */ }
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }

  const sessionId = event.session_id || event.sessionId || '_nosession';
  hourReminder(sessionId);

  if (process.env.TYCON_BLOCKING_METER === '0') return;
  if (!orgSwitchOn('blocking_meter')) return;
  if (!PENDING_DIR) return;

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
