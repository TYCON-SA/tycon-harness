'use strict';

/**
 * real-home.js — la casa de la cuenta que corre el proceso, sacada de la base de usuarios del sistema.
 *
 * `os.homedir()` obedece a `HOME` (y en Windows a `USERPROFILE`): con esa variable cambiada, quien firma y quien
 * verifica leen la misma casa falsa y todo coincide. `os.userInfo().homedir` la toma del sistema (`getpwuid` en Mac y
 * Linux; el perfil de la cuenta en Windows) y no mira esas variables. Si no se puede resolver, falla: nunca cae en
 * `os.homedir()`.
 */

const os = require('os');
const path = require('path');

/** La casa de la cuenta; `userInfo` se inyecta sólo en proceso (las pruebas). */
function casaDeLaCuenta({ userInfo = os.userInfo } = {}) {
  let casa;
  try { casa = userInfo().homedir; } catch (e) { throw new Error(`no se pudo resolver la casa de la cuenta: ${(e && e.message) || e}`); }
  if (typeof casa !== 'string' || !casa || !path.isAbsolute(casa)) throw new Error(`no se pudo resolver la casa de la cuenta: el sistema devolvió ${JSON.stringify(casa)}`);
  return casa;
}

module.exports = { casaDeLaCuenta };
