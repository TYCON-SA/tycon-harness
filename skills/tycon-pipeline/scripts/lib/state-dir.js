'use strict';
// state-dir.js — la carpeta del estado del pipeline, vista desde las skills.
//
// Dónde vive el estado lo sabe scripts/setup/harness/tycon-home.js. En el repo unido está en el mismo clon que este
// archivo y se le pregunta; en un clon de skills APARTE (máquinas en transición) no hay scripts/ al lado y vale la
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

/** La carpeta del estado (hoy, ~/.tycon/state). */
function stateDir(home) {
  return tyconHome ? tyconHome.stateDir(home || os.homedir()) : path.join(claudeDir(home), '.tycon-pipeline');
}

/** Las skills instaladas: el enchufe de Claude Code que lleva al arnés (`agent-skills`, en su carpeta). */
function installedSkillsDir(home) {
  return tyconHome ? tyconHome.installedSkillsDir(home || os.homedir()) : path.join(claudeDir(home), 'agent-skills');
}

/** El nombre de la carpeta de Claude Code, la misma que tiene también cada repo (`<repo>/<nombre>/worktrees`). */
function claudeDirName() {
  return path.basename(claudeDir(os.homedir()));
}

/** Una ruta como se le muestra a la persona: `~/` y su camino desde la carpeta de la persona. */
function paraMostrar(p, home = os.homedir()) {
  return `~/${path.relative(home, p).split(path.sep).join('/')}`;
}

module.exports = { stateDir, claudeDir, installedSkillsDir, claudeDirName, paraMostrar };

// suelto, desde un guion de shell: imprime la carpeta del estado
if (require.main === module) process.stdout.write(`${stateDir()}\n`);
