'use strict';
/**
 * node-floor.js (lado skills) — el piso de Node del arnés, visto desde las skills.
 *
 * El piso vive en `scripts/lib/node-floor.js` del árbol del arnés. Las skills están en ese mismo árbol (la forma de hoy) o
 * en un clon aparte: se busca primero al lado y después en la casa del arnés. Sintaxis que Node 12 lee, como el piso.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');

var candidates = [
  path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'node-floor.js'),
  path.join(process.env.TYCON_HOME && path.isAbsolute(String(process.env.TYCON_HOME)) ? String(process.env.TYCON_HOME) : path.join(os.homedir(), '.tycon'), 'harness', 'scripts', 'lib', 'node-floor.js'),
];
var found = null;
for (var i = 0; i < candidates.length && !found; i++) if (fs.existsSync(candidates[i])) found = candidates[i];

var oldNode = parseInt(String(process.versions.node).split('.')[0], 10) < 20;
module.exports = found ? require(found) : {
  // sin el árbol del arnés no hay a quién pedirle el Node: con uno bueno el guion sigue; con uno viejo se dice y se sale,
  // en vez de morir más adelante con un SyntaxError
  guard: function (opts) {
    if (!oldNode) return;
    process.stderr.write('Node ' + process.versions.node + ': el arnés necesita Node 20 o más y no encontré su árbol para pedirle el suyo\n');
    process.exit(opts && opts.gate ? 2 : opts && opts.hook ? 0 : 1);
  },
  launch: function (mainFile) {
    process.argv = [process.argv[0], mainFile].concat(process.argv.slice(2));
    require('module').runMain(mainFile);
  },
};
