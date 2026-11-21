#!/usr/bin/env node
// tycon hook entry — PreToolUse matcher Edit|Write.
// Path único para que el installer lo registre como hook plano (sin args).
// Corre los controles de antes de editar en UN solo proceso node. Ver dispatch.js.
// Si el despachador no carga o tira, la edición no pasa: con el despachador roto no corrió ningún control, y antes de
// editar es la única barrera de varios de ellos. Sin dispatch.js no hay de dónde sacar la carpeta del registro: sólo
// stderr.
const unaLinea = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

let d;
try {
  d = require('./dispatch.js');
} catch (e) {
  process.stderr.write(`⛔ el despachador de ediciones no carga (${unaLinea(e)}): esta edición no pasa. Reparalo: /tycon-harness\n`);
  process.exit(2);
}
try {
  d.dispatch('pre-edit');
} catch (e) {
  try { d.cerrarConsumos({ paso: false }); } catch { /* las firmas reservadas quedan como estén */ }
  try { d.logDispatchFailure(null, 'closed', e); } catch { /* el registro es ayuda, no la decisión */ }
  process.stderr.write(`⛔ el despachador de ediciones tiró (${unaLinea(e)}): esta edición no pasa. Reparalo: /tycon-harness dice si el arnés quedó bien instalado\n`);
  process.exit(2);
}
