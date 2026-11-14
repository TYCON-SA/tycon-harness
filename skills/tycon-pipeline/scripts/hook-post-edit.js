#!/usr/bin/env node
// tycon hook entry — PostToolUse matcher Edit|Write (dispatcher).
// Path único para que el installer lo registre como hook plano (sin args).
// Corre el control de la integración de horas elegida + on-edit (advisory) en UN solo proceso node.
// Los hooks de una integración que corren en cada tool, de fondo, no van acá: son hooks aparte.
// Si el despachador no carga o tira, la edición ya ocurrió y no se puede frenar: sale 0 y lo dice (y lo anota, si
// dispatch.js cargó).
const unaLinea = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

let d;
try {
  d = require('./dispatch.js');
} catch (e) {
  process.stderr.write(`⚠ el despachador de ediciones no carga (${unaLinea(e)}): los controles de después de editar no corrieron. Reparalo: /tycon-harness\n`);
  process.exit(0);
}
try {
  d.dispatch('post-edit');
} catch (e) {
  try { d.logDispatchFailure(null, 'open', e); } catch { /* el registro es ayuda, no la decisión */ }
  process.stderr.write(`⚠ el despachador de ediciones tiró (${unaLinea(e)}): los controles de después de editar no corrieron. Reparalo: /tycon-harness dice si el arnés quedó bien instalado\n`);
  process.exit(0);
}
