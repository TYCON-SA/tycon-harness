#!/usr/bin/env node
'use strict';

/**
 * on-coordination-write.js — la coordinadora no cambia archivos de los repos con Edit ni Write.
 *
 * Corre en la cadena de antes de editar del despachador (`dispatch.js`), en cualquier paso, después de on-controls-off.
 * Si la sesión del evento es la coordinadora designada y el archivo cae en un repo o en la copia instalada del arnés,
 * frena y le dice que lo encargue a una sesión. El criterio vive en scripts/lib/coordination-writes.js; la consola la
 * mira on-bash-write-gate.js con el mismo criterio.
 *
 * El `session_id` se lee del evento tal cual: sin él, pasa y lo anota. Se apaga con TYCON_COORDINATION_WRITE_GUARD=0.
 */

const path = require('path');

const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'coordination-writes.js');

/** Para el despachador: `{ block }` si la coordinadora edita un archivo de un repo; null si no. */
function handle(event, opts = {}) {
  const file = event && event.tool_input && event.tool_input.file_path;
  if (!file) return null;
  const abs = path.isAbsolute(String(file)) ? String(file) : path.resolve(String(event.cwd || process.cwd()), String(file));
  const r = require(LIB).judge({
    sessionId: event.session_id, files: [abs], home: opts.home, stateDir: opts.stateDir, installedRoots: opts.installedRoots,
  });
  return r && r.block ? { block: r.block } : null;
}

module.exports = { handle };
