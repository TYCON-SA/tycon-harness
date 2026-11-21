'use strict';
/**
 * stop-cap.js — el tope de cierres seguidos que retiene un freno del cierre del turno cuando no puede llevar su propia
 * cuenta. Un freno que retiene porque no pudo leer su estado (su contador, su memoria de lo ya avisado, un repo que git
 * no contesta) retendría en cada cierre y dejaría la sesión en un lazo. Esta cuenta vive en la carpeta temporal del
 * sistema, aparte del estado de la máquina, que puede ser justo lo que falló: pasados MAX_SEGUIDOS cierres seguidos, el
 * freno deja cerrar y lo dice. Si tampoco puede anotar ahí, deja cerrar cuando el cierre ya viene de un freno del
 * cierre (`stop_hook_active` en el evento).
 *
 *   otraVuelta({ freno, sesion, stopHookActive }) → { retener, vuelta, motivo }
 *   soltar({ freno, sesion })                       → la cuenta vuelve a cero (el freno dejó cerrar)
 *
 * TYCON_STOP_CAP_DIR fija la carpeta (las pruebas la ponen en su laboratorio).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SEGUIDOS = 3;
// una cuenta de hace rato no se suma a un lazo nuevo
const VENCE_MS = 30 * 60 * 1000;

function carpeta(env = process.env) {
  if (env.TYCON_STOP_CAP_DIR) return env.TYCON_STOP_CAP_DIR;
  let uid = 'x';
  try { uid = String(os.userInfo().uid); } catch (_) { /* sin usuario: una sola carpeta */ }
  return path.join(os.tmpdir(), `tycon-stop-cap-${uid}`);
}

const limpio = (s) => String(s || '_nosession').replace(/[^\w.-]/g, '_');
const archivo = (freno, sesion, env) => path.join(carpeta(env), `${limpio(freno)}--${limpio(sesion)}.json`);

/**
 * Otro cierre que el freno quiere retener sin poder contarlo con lo suyo. `retener: false` pasado el tope (la cuenta
 * vuelve a cero), o sin poder anotar la cuenta en un cierre que ya viene de un freno del cierre.
 */
function otraVuelta({ freno, sesion, stopHookActive = false, ahora = Date.now(), env = process.env }) {
  const f = archivo(freno, sesion, env);
  let n = 0;
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (c && ahora - Date.parse(c.at) < VENCE_MS) n = Number(c.vueltas) || 0;
  } catch (_) { /* sin cuenta: es la primera */ }
  if (n >= MAX_SEGUIDOS) {
    soltar({ freno, sesion, env });
    return { retener: false, vuelta: n, motivo: `retuvo ${MAX_SEGUIDOS} cierres seguidos sin poder leer su estado` };
  }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ vueltas: n + 1, at: new Date(ahora).toISOString() })}\n`);
  } catch (e) {
    if (stopHookActive) return { retener: false, vuelta: n, motivo: `no pude contar los cierres (${e.code || e.message}) y este ya viene de un freno del cierre` };
  }
  return { retener: true, vuelta: n + 1 };
}

function soltar({ freno, sesion, env = process.env }) {
  try { fs.unlinkSync(archivo(freno, sesion, env)); } catch (_) { /* no había cuenta */ }
}

module.exports = { otraVuelta, soltar, MAX_SEGUIDOS, carpeta };
