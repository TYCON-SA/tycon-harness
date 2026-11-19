'use strict';
/**
 * home-command — el comando `node` que el arnés le muestra a una sesión o a un dev, con la carpeta de la persona.
 *
 * PowerShell no expande «~» en los argumentos de un programa: `node ~/<ruta>` da MODULE_NOT_FOUND. `$HOME` lo
 * expanden bash, zsh, Git Bash y PowerShell, también entre comillas dobles, y las comillas no dejan que una carpeta con
 * espacios parta el comando. Por eso el mismo texto sirve en todos, sin mirar el sistema.
 *
 * Un comando de firma no lleva `$HOME`: la forma de la firma (`canonica` de scripts/lib/owner-window.js) exige palabras
 * literales, para que lo que corre no dependa de una variable del entorno. Ese va con la carpeta absoluta, salvo que la
 * carpeta traiga un carácter que dentro de comillas dobles corte el comando o lo cambie (`"`, `$`, comilla invertida, `%`,
 * un salto de línea): entonces sale con `$HOME`, que no es una firma y se firma en la terminal.
 *
 * Uso: homeCommand('<ruta>/marker.js') → node "$HOME/<ruta>/marker.js"
 *      homePath('<ruta>/marker.js') → "$HOME/<ruta>/marker.js" (la ruta sola, para una constante que se
 *        interpola después de un `node`)
 *      signatureCommand('<ruta>/marker.js'[, carpeta]) → node "<carpeta>/<ruta>/marker.js"
 */

const os = require('os');

/** `"$HOME/<ruta>"`, entre comillas, con la ruta bajo la carpeta de la persona. */
function homePath(ruta) {
  return `"$HOME/${ruta}"`;
}

/** `node "$HOME/<ruta>"`, con la ruta bajo la carpeta de la persona. */
function homeCommand(ruta) {
  return `node ${homePath(ruta)}`;
}

/** `node "<carpeta>/<ruta>"` con la carpeta absoluta de la persona; con una carpeta que no se puede citar, la de `$HOME`. */
function signatureCommand(ruta, carpeta = os.homedir()) {
  // `%` lo expande cmd adentro de las comillas (`%USERNAME%`): tampoco se cita igual en las cuatro consolas (@story-8.319)
  if (!carpeta || /["$`%\r\n]/.test(carpeta)) return homeCommand(ruta);
  return `node "${carpeta}/${ruta}"`;
}

/** Por qué un cartel no da la forma de la terminal. */
const SIN_SESION_TERMINAL = 'la forma de tu terminal necesita la sesión del agente, que este freno no conoce';
const sesionConocida = (sesion) => typeof sesion === 'string' && sesion !== '' && sesion !== '_nosession';

/**
 * La forma de la terminal de la persona para cualquier comando de marker.js: la sesión va siempre, porque la terminal no
 * la tiene en el ambiente. Sin una sesión conocida, `null` (el cartel dice SIN_SESION_TERMINAL). Vive acá, y no en
 * owner-window.js, para que la pidan los carteles sin cargar la ventana (@story-8.318).
 */
function enLaTerminal(comando, sesion) {
  if (!sesionConocida(sesion)) return null;
  return `${comando} --terminal --for-session ${sesion}`;
}

module.exports = { homeCommand, homePath, signatureCommand, enLaTerminal, SIN_SESION_TERMINAL, sesionConocida };
