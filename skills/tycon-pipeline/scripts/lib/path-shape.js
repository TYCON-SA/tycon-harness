'use strict';
/**
 * path-shape.js — una ruta de Windows puede llegar escrita de tres formas; los portones miran UNA.
 *
 * EL PROBLEMA. En Windows la misma carpeta se escribe `C:\a\b` (la nativa), `C:/a/b` (la que escribe casi todo guion) y
 * `/c/a/b` (la de Git Bash, que es con lo que el asistente corre sus comandos). Con las dos primeras los portones dan el veredicto de siempre; con `/c/a/b`, cuatro
 * de ellos dejarían pasar lo que tienen que frenar. Para Node en Windows `/c/a/b` es `C:\c\a\b`: una carpeta que no
 * existe, fuera de cualquier repo — y un portón que no encuentra el repo no tiene nada que frenar.
 *
 * LA REGLA. Toda ruta que llega de afuera (el `file_path` y el `cwd` de un evento, el destino de una escritura por la
 * terminal) pasa por `nativePath()` ANTES de que la mire un portón. Una sola función: cada portón no vuelve a decidir
 * qué forma entiende.
 *
 * Fuera de Windows no hace nada: `/c/a/b` ahí es una carpeta, no una unidad.
 *
 * Lo que resigna, a sabiendas: en Windows una carpeta de UNA letra en la raíz de la unidad actual (`\c\datos`) se lee
 * como la unidad `C:`. Es la lectura de Git Bash, y es la que usa quien escribe esa forma.
 */
const path = require('path');

/** La ruta en su forma nativa. Fuera de Windows, o si no es un texto con algo, la devuelve tal cual. */
function nativePath(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string' || !p) return p;
  // `/c/a/b` y `/cygdrive/c/a/b`: una barra, UNA letra, y otra barra o el final. `//servidor/x` (red) no entra.
  const drive = /^[\\/](?:cygdrive[\\/])?([A-Za-z])(?:[\\/](.*))?$/.exec(p);
  const native = path.win32.normalize(drive ? `${drive[1]}:\\${drive[2] || ''}` : p);
  // la letra de la unidad, siempre en mayúscula: `c:/a/b` y `/c/a/b` son el mismo archivo y tienen que dar el mismo texto
  return native.replace(/^[a-z]:/, (unit) => unit.toUpperCase());
}

/**
 * El evento con sus rutas en forma nativa: la carpeta de trabajo y la ruta del archivo de la herramienta. No modifica
 * el evento que recibe; fuera de Windows (o sin nada que cambiar) devuelve el mismo objeto.
 */
function nativeEvent(event, platform = process.platform) {
  if (platform !== 'win32' || !event || typeof event !== 'object') return event;
  const out = Object.assign({}, event);
  if (typeof event.cwd === 'string') out.cwd = nativePath(event.cwd, platform);
  const input = event.tool_input;
  if (input && typeof input === 'object') {
    out.tool_input = Object.assign({}, input);
    for (const k of ['file_path', 'notebook_path']) if (typeof input[k] === 'string') out.tool_input[k] = nativePath(input[k], platform);
  }
  return out;
}

module.exports = { nativePath, nativeEvent };
