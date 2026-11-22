#!/usr/bin/env node
/**
 * provider-retry.js — hook `StopFailure`, de fondo (`asyncRewake`): cuando el proveedor corta el turno de una sesión
 * (sobrecarga, error del servidor o límite de pedidos), espera y la despierta para que siga, sin que nadie escriba.
 *
 * Claude Code dispara `StopFailure` en lugar de `Stop` cuando un error de la API terminó el turno (desde la versión
 * 2.1.78; el piso del arnés es más nuevo). En ese evento la herramienta ignora la salida y el código del gancho, salvo
 * en un gancho de fondo con `asyncRewake`: al terminar con 2 despierta a la sesión con lo que el gancho escribió por la
 * salida de error, como aviso del sistema. Es el mismo camino que el vigilante del buzón de la oficina
 * (office-inbox-watch.js).
 *
 * Reintenta a los 1, 2, 4 y 8 minutos del corte. Cada corte nuevo de la misma sesión es el intento siguiente; pasada
 * media hora sin cortes, la cuenta vuelve a cero. Al quinto corte seguido no hace nada: un corte largo (una cuota de
 * horas) no se cura reintentando, y el aviso de espera (wait-notice.js) sigue avisando como siempre. Otro error
 * (credenciales, facturación, desconocido) tampoco se reintenta.
 *
 * Si la sesión se movió durante la espera (la persona escribió, o terminó otro turno), no la despierta: su conversación
 * (`transcript_path` del evento) o su archivo de estado (scripts/lib/session-state.js) cambiaron después del corte. La
 * conversación vale aunque el archivo de estado esté apagado o no cambie. Nunca firma, aprueba ni contesta nada: sólo le pide a
 * la sesión que siga con lo que estaba haciendo.
 *
 * Sólo se arma si lo lanzó la herramienta, en una entrada donde un gancho de fondo despierta a la sesión (la misma
 * regla que el vigilante del buzón). Bajo `claude -p` o el SDK sale enseguida con 0. Codex no tiene un evento para el
 * corte del proveedor: ahí no corre. Cualquier error termina con 0 y sin escribir nada.
 *
 * Off: TYCON_PROVIDER_RETRY=0. Casos: scripts/tests/provider-retry.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DELAYS_MIN = [1, 2, 4, 8];
const RESET_AFTER_MS = 30 * 60 * 1000;
// los errores que un rato de espera cura; los demás (credenciales, facturación) no
const RETRYABLE = new Set(['overloaded', 'server_error', 'rate_limit']);

const safeSid = (sid) => String(sid || '').replace(/[^\w.-]/g, '_');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * Qué hacer con un corte: `{ attempt, delayMs }` para reintentar (attempt de 1 a 4) o null. Anota el intento en
 * `<estado>/provider-retry/<sesión>.json`.
 */
function plan(sdir, sid, error, now = Date.now()) {
  if (!RETRYABLE.has(String(error || ''))) return null;
  const file = path.join(sdir, 'provider-retry', `${safeSid(sid)}.json`);
  const prev = readJson(file);
  const recent = prev && Number.isFinite(prev.at) && now - prev.at < RESET_AFTER_MS;
  const attempt = (recent && Number.isInteger(prev.attempt) ? prev.attempt : 0) + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ attempt, at: now, error: String(error) }), { mode: 0o600 });
  if (attempt > DELAYS_MIN.length) return null;
  return { attempt, delayMs: DELAYS_MIN[attempt - 1] * 60 * 1000 };
}

// lo que la herramienta escribe en la conversación al cortar el turno cae antes de lanzar el gancho; un margen lo deja afuera
const TRANSCRIPT_SLACK_MS = 2000;

/**
 * ¿La sesión se movió después del corte? Lo dice su conversación, que crece con cada mensaje y cada turno, o su archivo
 * de estado.
 */
function movedSince(sdir, sid, since, transcript = null) {
  if (transcript) {
    try { if (fs.statSync(transcript).mtimeMs > since + TRANSCRIPT_SLACK_MS) return true; } catch { /* sin la conversación queda el archivo de estado */ }
  }
  try {
    const st = require(path.join(__dirname, '..', 'lib', 'session-state.js')).read(sdir, sid).state;
    const at = Date.parse(st && (st.lastEventAt || st.updatedAt));
    return Number.isFinite(at) && at > since;
  } catch { return false; }
}

const message = (error, attempt) => `El proveedor cortó el turno anterior (${error}). Reintento ${attempt} de ${DELAYS_MIN.length}: `
  + 'seguí con lo que estabas haciendo, desde donde quedó. Si el paso que se cortó escribía algo, mirá primero qué quedó escrito.';

function main(sdir, event, { now = Date.now(), env = process.env } = {}) {
  const sid = String(event.session_id || '');
  const p = plan(sdir, sid, event.error, now);
  if (!p) return Promise.resolve(0);
  const scale = Number(env.TYCON_PROVIDER_RETRY_SCALE);
  const wait = Number.isFinite(scale) && scale > 0 ? p.delayMs * scale : p.delayMs;
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, text) => { if (done) return; done = true; if (text) process.stderr.write(text); resolve(code); };
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => finish(0));
    setTimeout(() => {
      if (movedSince(sdir, sid, now, typeof event.transcript_path === 'string' ? event.transcript_path : null)) { finish(0); return; }
      finish(2, message(event.error, p.attempt));
    }, wait);
  });
}

async function run() {
  const env = process.env;
  if (env.TYCON_EVAL_SANDBOX === '1' || env.TYCON_PROVIDER_RETRY === '0') return 0;
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  if (event.hook_event_name && event.hook_event_name !== 'StopFailure') return 0;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(event.session_id || ''))) return 0;
  const watch = require(path.join(__dirname, 'office-inbox-watch.js'));
  if (!watch.wakes()) return 0;
  // TYCON_PROVIDER_RETRY_ANY_PARENT=1: corre aunque no lo haya lanzado la herramienta (sólo las pruebas de este gancho)
  if (watch.toolPid() === null && env.TYCON_PROVIDER_RETRY_ANY_PARENT !== '1') return 0;
  const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  return main(stateDir(os.homedir()), event, { env });
}

if (require.main === module) {
  run().then((code) => { process.exit(code); }, () => { process.exit(0); });
}

module.exports = { DELAYS_MIN, RESET_AFTER_MS, RETRYABLE, plan, movedSince, main };
