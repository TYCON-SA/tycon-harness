'use strict';
/**
 * atdd-skip-lab.js — la firma de juguete de saltear «pruebas primero» (`lib/atdd-skip.js`), para las pruebas.
 *
 * En una casa de juguete, anota la muestra del pedido y firma con un `exigir` de mentira que escribe el renglón firmado
 * como lo escribe la ventana (`owner-window.js`). Nada lee ni escribe la casa real: la casa se pasa siempre.
 */
const fs = require('fs');
const path = require('path');

const sk = require('../../lib/atdd-skip.js');
const { stateDir } = require('../../lib/state-dir.js');

/** El `exigir` de mentira: el renglón `atdd-skip-signed` en el registro de la casa, como lo deja la ventana. */
function exigirDeJuguete(casa, via = 'ventana') {
  return (o) => {
    fs.mkdirSync(stateDir(casa), { recursive: true });
    // stable-data: la hora del renglón es la de la firma, como la escribe la ventana; ninguna prueba la compara
    fs.appendFileSync(path.join(stateDir(casa), 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: `${o.firma}-signed`, status: 'ok', via, resumen: o.resumen })}\n`);
    return { codigo: 0, via };
  };
}

/**
 * Anota la muestra de la ejecución (`story`, `carpeta`, `ejecucion`) y la firma: `{ codigo, linea?, motivo? }`, el
 * resultado de `firmar`. Con `sinMuestra`, firma sin anotarla antes.
 */
function firmaDeJuguete({ casa, story, carpeta, ejecucion, motivo = 'refactor sobre pruebas que ya existían', sinMuestra = false, via = 'ventana' }) {
  if (!sinMuestra) sk.muestra({ story, carpeta, ejecucion, camino: 'complete-step --no-atdd', casa });
  return sk.firmar({ story, motivo, casa, exigir: exigirDeJuguete(casa, via), aprobar: () => {} });
}

module.exports = { exigirDeJuguete, firmaDeJuguete };
