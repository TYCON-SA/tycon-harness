'use strict';
// state-dir.js — la carpeta del estado del pipeline, vista desde las skills (story 8.23, tanda A2).
//
// Dónde vive el estado lo sabe scripts/setup/harness/tycon-home.js. En el repo unido está en el mismo clon que este
// archivo y se le pregunta; en un clon de skills APARTE (máquinas en transición, 8.18) no hay scripts/ al lado y vale la
// ruta de siempre, que es la misma (T5 de scripts/tests/tycon-home.test.js compara las dos). Si está y no carga, tira.
// Un solo lugar para todas las skills: así el respaldo no se repite en cada hook.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TYCON_HOME_LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
const tyconHome = fs.existsSync(TYCON_HOME_LIB) ? require(TYCON_HOME_LIB) : null;

/** La carpeta de Claude Code en el HOME (la que tycon-home.js nombra; el respaldo es la ruta de siempre). */
function claudeDir(home) {
  return tyconHome ? tyconHome.claudeDir(home || os.homedir()) : path.join(home || os.homedir(), '.claude');
}

/** La carpeta del estado (hoy, ~/.claude/.tycon-pipeline). */
function stateDir(home) {
  return tyconHome ? tyconHome.stateDir(home || os.homedir()) : path.join(claudeDir(home), '.tycon-pipeline');
}

module.exports = { stateDir, claudeDir };
