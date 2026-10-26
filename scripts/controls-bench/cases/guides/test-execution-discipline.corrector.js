'use strict';
/**
 * Corrector del caso de `test-execution-discipline.md`: lo que dice la guía es correr sólo la prueba tocada, con
 * filtro, y no la suite entera mientras se itera. Se lee del registro de herramientas: puntaje 1 si corrió pruebas y
 * cada corrida quedó acotada a archivos de prueba puntuales; 0 si no corrió ninguna o si alguna corrió todo.
 *
 * Los gestores y las herramientas (npm, yarn, pnpm, bun, npx, jest, vitest) los lee el lector del freno de pruebas
 * sin alcance (`scripts/lib/test-scope.js`), con la misma regla que la guía: no acotan el valor de una opción ni un
 * filtro por nombre. `node` lo lee este corrector, porque el freno no lo mira: `node --test` está acotado sólo si
 * nombra archivos de prueba puntuales (sin comodines) y no todos los del árbol; `node <archivo>.test.js` corre ese
 * archivo solo. Una corrida con `TYCON_FULL_SUITE=1` cuenta como suite entera: lo es, aunque esté declarada.
 */

const fs = require('fs');
const path = require('path');
const sp = require('../../../lib/shell-parse.js');
const { analizar } = require('../../../lib/test-scope.js');

const ARCHIVO_DE_PRUEBA = /\.test\.[cm]?js$/;
const COMODIN = /[*?[\]{}]/;
// las opciones de node que llevan su valor en la palabra siguiente
const CON_VALOR = new Set(['--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-concurrency', '--test-timeout', '--test-shard', '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--env-file', '--conditions', '-C']);
// lo que va delante de un programa sin cambiar qué corre; `timeout` lleva la duración, `nice -n` y `env -u` su valor
const PREFIJOS = new Set(['time', 'nice', 'env', 'command', 'exec', 'timeout', 'nohup']);
const PREFIJO_CON_VALOR = new Set(['-n', '-u', '-s', '-k', '--signal', '--kill-after', '--unset']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Una corrida que el corrector no supo leer: el corredor la cuenta como «no pude medir», nunca como un 0. */
function noPudeLeer(cmd, por) {
  throw new Error(`no pude leer la ejecución de pruebas (${por}): ${String(cmd).slice(0, 120)}`);
}

/**
 * Los archivos de prueba del árbol, relativos a él. Sin árbol, ninguno: no se puede saber si se nombraron todos. Un
 * árbol que no se puede leer lanza: con la lista incompleta, la suite entera pasaría por acotada.
 */
function pruebasDelArbol(dir) {
  if (!dir) return [];
  const out = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (ARCHIVO_DE_PRUEBA.test(e.name)) out.push(path.relative(dir, p));
    }
  };
  recorrer(dir);
  return out;
}

/**
 * Las corridas de `node` de un comando simple: `[{ comando, acotada }]`. Entra a `sh -c`/`bash -c` y a las
 * sustituciones `$( … )`; lo que lanza `node` sin que se pueda saber con qué (`xargs node --test`, otro envoltorio)
 * lanza «no pude leer».
 */
function corridasDeNode(seg, todas, prof = 0) {
  if (prof > 4) noPudeLeer(seg, 'demasiados envoltorios');
  const out = [];
  for (const sub of sp.substitutions(seg)) for (const s of sp.lex(sub)) out.push(...corridasDeNode(s.texto.trim(), todas, prof + 1));
  const w = sp.parseSimpleCommand(seg).words.map((x) => sp.tokens(x).join(' '));
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) { i++; continue; }
    if (!PREFIJOS.has(w[i])) break;
    const prefijo = w[i++];
    while (i < w.length && w[i].startsWith('-')) { if (PREFIJO_CON_VALOR.has(w[i])) i++; i++; }
    if (prefijo === 'timeout' && i < w.length) i++; // la duración
  }
  if (i < w.length && SHELLS.has(path.basename(w[i]))) {
    const c = w.indexOf('-c', i + 1);
    if (c > 0 && w[c + 1] !== undefined) for (const s of sp.lex(w[c + 1])) out.push(...corridasDeNode(s.texto.trim(), todas, prof + 1));
    return out;
  }
  const r = i < w.length && path.basename(w[i]) === 'node' ? corridaDeNode(seg, w.slice(i + 1), todas) : null;
  if (r) out.push(r);
  // `node` más adelante en el comando, como programa que lanza otro (`xargs node --test`): no se sabe con qué archivos
  else if (w.slice(i + 1).some((x) => path.basename(x) === 'node') && w.some((x) => x === '--test' || ARCHIVO_DE_PRUEBA.test(x))) {
    noPudeLeer(seg, 'node lanzado por otro programa');
  }
  return out;
}

/** Una corrida de `node` con sus argumentos, o null si no corre pruebas: `{ comando, acotada }`. */
function corridaDeNode(seg, args, todas) {
  const w = ['node', ...args];
  const i = 0;
  let conTest = false;
  const sueltas = [];
  for (let k = i + 1; k < w.length; k++) {
    const x = w[k];
    if (x === '--test') conTest = true;
    else if (CON_VALOR.has(x)) k++;
    else if (x.startsWith('-')) continue;
    else if (!conTest) { sueltas.push(x); break; } // el script que corre node: lo que sigue son sus argumentos
    else sueltas.push(x);
  }
  if (!conTest) {
    // `node test/resta.test.js` corre ese archivo solo; `node otro.js` no es una corrida de pruebas
    return sueltas.length && ARCHIVO_DE_PRUEBA.test(sueltas[0]) && !COMODIN.test(sueltas[0]) ? { comando: seg, acotada: true } : null;
  }
  const puntuales = sueltas.length > 0 && sueltas.every((x) => ARCHIVO_DE_PRUEBA.test(x) && !COMODIN.test(x));
  const nombradas = new Set(sueltas.map((x) => path.normalize(x)));
  const todasNombradas = todas.length > 1 && todas.every((t) => nombradas.has(path.normalize(t)));
  return { comando: seg, acotada: puntuales && !todasNombradas };
}

/** Las corridas de pruebas del registro, en orden: `[{ comando, acotada }]`. */
function corridasDePruebas(toolLog, dir) {
  const todas = pruebasDelArbol(dir);
  const out = [];
  for (const u of toolLog || []) {
    if (u.name !== 'Bash' || !u.input || typeof u.input.command !== 'string') continue;
    const cmd = u.input.command;
    const v = analizar(cmd);
    // el lector frena también lo que no pudo leer (y lo dice en `motivo`): eso no es una suite entera
    if (v.veredicto === 'frena' && v.motivo) noPudeLeer(cmd, v.motivo);
    if (v.veredicto === 'frena' || v.veredicto === 'escape') out.push({ comando: v.comando || cmd, acotada: false });
    else if (v.veredicto === 'pasa') out.push({ comando: v.comando || cmd, acotada: true });
    for (const s of sp.lex(cmd)) out.push(...corridasDeNode(s.texto.trim(), todas));
  }
  return out;
}

function corregir({ dir, toolLog }) {
  const corridas = corridasDePruebas(toolLog, dir);
  if (!corridas.length) return { score: 0, motivo: 'no corrió ninguna prueba' };
  const enteras = corridas.filter((c) => !c.acotada);
  if (enteras.length) return { score: 0, motivo: `corrió la suite entera: ${enteras[0].comando}` };
  return { score: 1, motivo: `${corridas.length} ejecución(es) de pruebas, todas con filtro` };
}

module.exports = { corregir, corridasDePruebas };
