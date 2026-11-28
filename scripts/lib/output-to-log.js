'use strict';
/**
 * scripts/lib/output-to-log.js — `--log <archivo>` de los guiones que el arranque de Windows lanza de fondo (la subida al
 * buzón y la recolección de hallazgos).
 *
 * La salida del proceso (la estándar y la de error) se AGREGA a ese archivo, que pasado ~512 KB se mueve a `.1`. Un
 * proceso de fondo de PowerShell no puede agregar a un archivo, y sobrescribir el registro borraría lo que sale una vez
 * por día (el aviso de vencimiento de la llave del buzón; la razón del `>>` y del `rotar` del instalador .sh, que no lo
 * usa). Lo que Node imprimiría por su cuenta (una excepción sin atrapar) también va al registro, y el proceso sale 1. Si
 * el registro no se puede abrir, la salida queda donde estaba y devuelve false.
 */
const fs = require('fs');
const path = require('path');

function toLog(archivo) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(archivo)), { recursive: true });
    try { if (fs.statSync(archivo).size > 524288) fs.renameSync(archivo, `${archivo}.1`); } catch (_) { /* no había registro */ }
    const fd = fs.openSync(archivo, 'a');
    const escribir = (trozo, enc, cb) => {
      // si el registro no se puede escribir (disco lleno, bloqueado), el trozo va a la salida de error de siempre
      try { fs.writeSync(fd, typeof trozo === 'string' ? trozo : Buffer.from(trozo)); } catch (_) { try { fs.writeSync(2, trozo); } catch (__) { /* sin salida */ } }
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    };
    process.stdout.write = escribir;
    process.stderr.write = escribir;
    // lo que Node imprimiría por su cuenta (una excepción o un rechazo sin atrapar) iría directo a la salida de error, que
    // en el arranque de Windows es una ventana oculta: va al registro, y la corrida sale 1
    const caida = (e) => { escribir(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] error inesperado: ${e && e.stack ? e.stack : e}\n`); process.exit(1); };
    process.on('uncaughtException', caida);
    process.on('unhandledRejection', caida);
    return true;
  } catch (e) {
    console.error(`no pude abrir el registro ${archivo}: ${e.message} — la salida sigue por la terminal`);
    return false;
  }
}

module.exports = { toLog };
