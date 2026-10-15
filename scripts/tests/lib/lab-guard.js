'use strict';
/**
 * lab-guard.js — la guarda del laboratorio: la carpeta de prueba no puede caer en un clon del arnés ni en las
 * herramientas de la máquina (2026-10-15).
 *
 * Por qué existe: diecinueve suites de shell, el laboratorio del instalador (harness-lab.sh) y cinco suites de
 * JavaScript escribían la misma guarda a mano, con el nombre viejo del lugar adentro. Ese nombre se define una sola vez,
 * en scripts/setup/harness/place.js. Quien escribía una suite nueva copiaba la guarda de una vieja, y el control de lo
 * publicado (harness-place.test.js, T49) la frenaba recién en el pedido: pasó en siete ramas. Ahora el nombre sale de
 * place.js y ninguna suite lo escribe (lo cuida T60 de harness-place.test.js).
 *
 * Qué frena: una carpeta cuya ruta contiene el nombre viejo del lugar, `agent-skills` o `.claude` (en cualquier lugar de la
 * ruta: la más estricta de las guardas que había). Con `place: true` (`--place` en la línea de comandos), también el
 * nombre nuevo. No va siempre porque es además el prefijo con que varias suites nombran su carpeta temporal
 * (`tycon-harness-state-…`): ahí frenaría al laboratorio mismo.
 *
 * Uso desde JavaScript (tira un Error):
 *   require('./lib/lab-guard.js').labGuard(BASE, 'harness-state');
 * Uso desde shell (sale 0 si la carpeta está fuera; 1 con «❌ <suite>: el laboratorio cayó en <carpeta>»; 2 mal llamado):
 *   node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-eol || exit 1
 *   node "$RAIZ/scripts/tests/lib/lab-guard.js" "$T" harness-profile --place || exit 1
 * Si node no puede cargar place.js, sale distinto de 0: sin los nombres no se sabe, y «no sé» nunca deja correr.
 */
const path = require('path');
const { PLACE_NAME, LEGACY_PLACE_NAME } = require(path.join(__dirname, '..', '..', 'setup', 'harness', 'place.js'));

/** ¿En qué parte de la ruta cae la carpeta? null si está fuera. Las barras de Windows cuentan como `/`. */
function fallsIn(dir, { place = false } = {}) {
  const p = String(dir).replace(/\\/g, '/');
  const parts = [LEGACY_PLACE_NAME, 'agent-skills', '.claude'];
  if (place) parts.push(PLACE_NAME);
  return parts.find((part) => p.includes(part)) || null;
}

/** Tira si la carpeta del laboratorio cae en un clon del arnés o en las herramientas de la máquina. */
function labGuard(dir, who, opts = {}) {
  if (!dir || !who) throw new Error('lab-guard: uso: labGuard(<carpeta>, <suite>, { place })');
  if (fallsIn(dir, opts)) throw new Error(`${who}: el laboratorio cayó en ${dir}`);
}

module.exports = { labGuard, fallsIn };

if (require.main === module) {
  const [dir, who, opt, ...rest] = process.argv.slice(2);
  if (!dir || !who || rest.length || (opt !== undefined && opt !== '--place')) {
    console.error('lab-guard: uso: node lab-guard.js <carpeta> <suite> [--place]');
    process.exit(2);
  }
  if (fallsIn(dir, { place: opt === '--place' })) {
    console.log(`❌ ${who}: el laboratorio cayó en ${dir}`);
    process.exit(1);
  }
}
