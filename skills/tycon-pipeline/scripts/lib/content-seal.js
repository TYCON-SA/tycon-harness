'use strict';
/**
 * content-seal.js — el sello del contenido que deja una edición, y la comparación «sólo cambió el fin de línea».
 *
 * El piso de frescura compara el contenido de hoy con el que dejó el último toque de la sesión. Por bytes no alcanza en
 * Windows: con `core.autocrlf=true` (el de fábrica) un checkout reescribe el archivo con CRLF, o con LF el que la sesión
 * dejó con CRLF, y los bytes cambian sin que cambie el contenido. Por eso el sello guarda también `eol`: el sha1 de los
 * bytes con cada CRLF leído como LF. Dos contenidos con el mismo `eol` difieren sólo en el fin de línea. No se usan los
 * filtros de git: un filtro de limpieza o el atributo `ident` hacen que contenidos distintos sean el mismo para git, y
 * una edición real pasaría por «el mismo contenido». El archivo no se reescribe: se compara una huella.
 */

const fs = require('fs');
const crypto = require('crypto');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
/** Los bytes con cada CRLF como LF (sólo ese par: un `\r` suelto es contenido). */
const sinCrlf = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

/** `{ hash, eol }` del contenido actual: el sha1 de los bytes y el de los bytes con CRLF como LF. */
function selloDeArchivo(f) {
  const buf = fs.readFileSync(f);
  return { hash: sha1(buf), eol: sha1(sinCrlf(buf)) };
}

/**
 * ¿El archivo de hoy difiere del sellado sólo en el fin de línea? Sin `eol` en el sello (uno viejo), o si el archivo no se
 * puede leer, no se sabe: la respuesta es no, y el piso cae a la fecha del disco (sube, nunca afloja).
 */
function soloCambioElFinDeLinea(f, sello) {
  if (!sello || typeof sello.eol !== 'string') return false;
  try { return selloDeArchivo(f).eol === sello.eol; } catch { return false; }
}

module.exports = { selloDeArchivo, soloCambioElFinDeLinea };
