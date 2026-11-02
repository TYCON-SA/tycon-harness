'use strict';
/**
 * window-args.js — los argumentos que la consola de Windows no deja pasar, ya dentro de la ventana nueva de una firma.
 *
 * `start` no puede llevar entre comillas un argumento con comillas, con `%`, con un salto de línea o con una barra al
 * final. Para esos, `abrirVentana` (runtime-waiver.js) lanza `node -r window-args.js <guion>` y deja los argumentos en
 * el ambiente, en JSON. Esto corre antes que el guion y se los agrega a `process.argv`, así el guion los lee como
 * siempre. La variable se borra al leerla: un proceso hijo no la hereda.
 *
 * No afloja nada: quien pueda poner la variable puede pasar los mismos argumentos en la línea de comando. La firma la
 * siguen dando la consola nueva y las tres palabras, y lo que se firma se muestra leído de estos argumentos.
 *
 * Unos argumentos que no se pueden leer cortan acá: sin ellos, el guion correría otro comando.
 */
const VARIABLE = 'TYCON_WAIVER_WINDOW_ARGS';
const MARCA_VENTANA = 'TYCON_WAIVER_IN_WINDOW';

function leer(texto) {
  const a = JSON.parse(texto);
  if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) throw new Error('no es una lista de textos');
  return a;
}

const texto = process.env[VARIABLE];
delete process.env[VARIABLE];
if (texto !== undefined && process.env[MARCA_VENTANA] === '1') {
  try { process.argv.push(...leer(texto)); } catch (e) {
    process.stderr.write(`🔒 no pude leer los argumentos de la ventana (${e.message}): no se firmó nada.\n`);
    process.exit(2);
  }
}

module.exports = { VARIABLE };
