#!/usr/bin/env node
/**
 * owner-email-notice.js — «tu máquina le informa al equipo tu correo de git», dicho UNA vez.
 *
 * Hook SessionStart. Una máquina que sube al buzón manda en `place.json` el correo global de git de quien la usa
 * (`owner`, lo arma `upload-runs.js`), para que un mantenedor confirme de quién es cada máquina y la persona vea sus
 * corridas en el sitio de la organización. Este aviso se lo dice al dev en UN renglón, con cómo verlo y cómo cambiarlo,
 * y deja un sello por máquina (`owner-email-notice.json` en la carpeta de estado) con la HUELLA sha256 del correo
 * normalizado (minúsculas, sin espacios). Con el sello de ese correo calla; si el correo cambia, lo dice otra
 * vez con el nuevo y renueva el sello.
 *
 * 🔴 EL SELLO NUNCA GUARDA EL CORREO: sólo su huella. Es un dato de la persona y la carpeta de estado no es su lugar.
 * 🔴 EL CORREO SE LEE CON LA MISMA FUNCIÓN QUE ARMA `owner` (`correoDeGitGlobal` de `upload-runs.js`), como archivo y sin
 *    invocar git: lo que se avisa es exactamente lo que sale de la máquina.
 * 🔴 PRIMERO SE SELLA, DESPUÉS SE DICE: si la carpeta de estado no se deja escribir, el aviso calla. Sin sello saldría en
 *    cada arranque, y un aviso de todos los días se deja de leer.
 * 🔴 CALLA Y NO SELLA cuando la máquina no informa nada: sin correo (`no_medido`), con el buzón apagado o roto, con la
 *    subida apagada (`TYCON_NO_UPLOAD_RUNS=1`) o dentro de un agente de compilación (TF_BUILD sin
 *    TYCON_MAILBOX_URL_BASE, la misma guarda que `subir()`: un agente de CI no es una máquina del equipo).
 *
 * Fail-open total: nunca frena el arranque ni tira. Una falla calla, sale 0 y queda en `owner-email-notice.log`, en la
 * carpeta de estado (sin el correo).
 * Apagado: TYCON_OWNER_EMAIL_NOTICE=0.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SELLO = 'owner-email-notice.json';
const REGISTRO = 'owner-email-notice.log';
const DONDE = 'scripts/hooks/owner-email-notice.js';
// controles C0 y C1 y los separadores de línea (armados con fromCharCode: escritos literales en el fuente cortarían la
// expresión regular): el correo sale de un archivo de la máquina y va a la terminal
const NO_IMPRIMIBLES = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-'
  + String.fromCharCode(0x9f) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');

/** La carpeta de estado: la pide a la biblioteca de la casa del arnés, que viaja con este hook (nunca una ruta escrita). */
function carpetaDeEstado(home) {
  return require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
}

/** La huella del correo normalizado: la misma cuenta que `huellaDeCorreo` de people.js. */
function huellaDeCorreo(correo) {
  return crypto.createHash('sha256').update(String(correo).trim().toLowerCase()).digest('hex');
}

function renglon(correo) {
  return `Tu máquina le informa al equipo tu correo de git (${correo}) para que veas tus ejecuciones en el sitio de la organización. `
    + 'Es tu correo global de git: lo ves con `git config --global user.email` y lo cambiás con `git config --global user.email <otro>`.';
}

/** La huella sellada, o null si no hay sello o no se deja leer (entonces se vuelve a decir y se renueva). */
function huellaSellada(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, SELLO), 'utf8'));
    return s && typeof s.email_sha256 === 'string' ? s.email_sha256 : null;
  } catch (_) { return null; }
}

/** Escribe el sello de una vez (archivo temporal y renombre): un corte a mitad no deja medio sello. */
function sellar(dir, huella, ahora) {
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, SELLO);
  const temporal = `${destino}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporal, `${JSON.stringify({ email_sha256: huella, notified_at: ahora }, null, 2)}\n`);
    fs.renameSync(temporal, destino);
  } catch (e) {
    try { fs.rmSync(temporal, { force: true }); } catch (_) { /* nada que limpiar */ }
    throw e;
  }
}

function main({ env = process.env, home = os.homedir(), escribir = (t) => console.log(t) } = {}) {
  if (env.TYCON_OWNER_EMAIL_NOTICE === '0' || env.TYCON_EVAL_SANDBOX === '1') return 0;
  const { readEnv } = require('../lib/legacy-names.js');
  if (readEnv('TYCON_NO_UPLOAD_RUNS', { where: DONDE, env }) === '1') return 0;
  if (/^true$/i.test(String(env.TF_BUILD || '').trim()) && !readEnv('TYCON_MAILBOX_URL_BASE', { where: DONDE, env })) return 0;

  const subida = require('../metrics/upload-runs.js');
  const integ = subida.integracionBuzon();
  if (integ.error || !integ.prendida) return 0;

  const leido = subida.correoDeGitGlobal({ home, env });
  if (!leido || typeof leido.email !== 'string' || !leido.email) return 0;   // no_medido: la máquina no informa correo
  const correo = leido.email.replace(NO_IMPRIMIBLES, '');
  const huella = huellaDeCorreo(correo);

  const dir = carpetaDeEstado(home);
  if (huellaSellada(dir) === huella) return 0;
  sellar(dir, huella, new Date().toISOString());
  escribir(renglon(correo));
  return 0;
}

/** Una falla queda en el registro propio, sin el correo. Si tampoco se deja escribir, nada. */
function anotarFalla(e) {
  try {
    const dir = carpetaDeEstado(os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    const motivo = String(e && e.message ? e.message : e).replace(NO_IMPRIMIBLES, ' ').slice(0, 300);
    fs.appendFileSync(path.join(dir, REGISTRO), `[${new Date().toISOString()}] ${(e && e.code) || 'error'}: ${motivo}\n`);
  } catch (_) { /* fail-open: el arranque no se entera */ }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { anotarFalla(e); process.exitCode = 0; }
}
module.exports = { main, renglon, huellaDeCorreo, SELLO };
