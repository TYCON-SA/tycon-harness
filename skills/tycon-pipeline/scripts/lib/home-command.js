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
 * carpeta traiga un carácter que dentro de comillas dobles corte el comando o lo cambie (`"`, `$`, comilla invertida, un
 * salto de línea): entonces sale con `$HOME`, que no es una firma y se firma en la terminal.
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
  if (!carpeta || /["$`\r\n]/.test(carpeta)) return homeCommand(ruta);
  return `node "${carpeta}/${ruta}"`;
}

module.exports = { homeCommand, homePath, signatureCommand };
