'use strict';
/**
 * jsonl-lines — los renglones de un registro `.jsonl` (la conversación o la transcripción de una sesión de Claude Code),
 * leídos de a trozos: nunca se arma un texto con el archivo entero, que en Node no puede pasar de ~512 MB.
 *
 * Lo usan lib/person-ok.js (la conversación) y scripts/lib/owner-approvals.js (la transcripción donde se busca el click o
 * el «aprobado»). Vive aparte de person-ok.js: esa biblioteca no la importa un guion de firmas.
 */
const fs = require('fs');

/**
 * El tope de lo que se lee de una conversación entera (`bytes`: un texto de Node no pasa de ~512 MB) y el tamaño de cada
 * lectura (`trozo`). Es un objeto para que las pruebas lo bajen sin escribir archivos enormes.
 */
const LIMITE = { bytes: 512 * 1024 * 1024, trozo: 1024 * 1024 };

/** El tope dicho para una persona: en MB, o en bytes si es menos de uno (sólo pasa en las pruebas). */
function tamanoDelTope() {
  return LIMITE.bytes >= 1024 * 1024 ? `${Math.round(LIMITE.bytes / (1024 * 1024))} MB` : `${LIMITE.bytes} bytes`;
}

/**
 * Los renglones de un registro `.jsonl`, convertidos en objetos, leídos de a trozos: nunca se arma un texto con el
 * archivo entero. Un renglón partido entre dos lecturas se une antes de interpretarse; uno a medio escribir no tapa a los
 * demás. Un archivo especial (una tubería, un dispositivo) es un error, no una espera: se abre sin bloquear y se mira lo
 * que se abrió, así el cambio entre mirar y leer no cuenta.
 *   · `filtro`: sólo se interpretan los renglones cuyo texto crudo lo trae; el resto no se convierte en objetos.
 *   · `tope`: con el archivo más grande que `LIMITE.bytes`, no se lee y tira un error con `code: 'ETOPE'`.
 */
function leerRenglones(file, { filtro = null, tope = false } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('no es un archivo común'), { code: 'ENOTREG' });
    if (tope && st.size > LIMITE.bytes) throw Object.assign(new Error(`pasa de ${tamanoDelTope()}`), { code: 'ETOPE' });
    const busca = filtro == null ? null : Buffer.from(String(filtro), 'utf8');
    const registros = [];
    const interpretar = (b) => {
      if (busca && !b.includes(busca)) return;
      const l = b.toString('utf8');
      if (!l.trim()) return;
      try { registros.push(JSON.parse(l)); } catch (_e) { /* un renglón a medio escribir no tapa a los demás */ }
    };
    const buf = Buffer.alloc(Math.max(1, LIMITE.trozo));
    let resto = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      // el buffer se reusa en la próxima lectura: lo que queda de un renglón se copia
      const junto = resto.length ? Buffer.concat([resto, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let desde = 0;
      for (let i = junto.indexOf(10); i >= 0; i = junto.indexOf(10, desde)) {
        interpretar(junto.subarray(desde, i));
        desde = i + 1;
      }
      resto = junto.subarray(desde);
    }
    if (resto.length) interpretar(resto);
    return registros;
  } finally { fs.closeSync(fd); }
}

module.exports = { LIMITE, tamanoDelTope, leerRenglones };
