#!/usr/bin/env node
'use strict';
/**
 * team-after-swap.js — la capa del equipo evaluada con el código de ESTA versión, recién instalada.
 *
 * Lo corre `refreshTeamWithNewCode` (release.js) de la versión que instaló a ésta, en un proceso aparte: ese proceso tiene
 * cargado el código de la versión de antes, y su lista cerrada de la capa no conoce lo que ésta acepta. Acá el código es
 * el de esta versión: `refreshTeam` resuelve la punta del repo del equipo, la valida con el lector de este árbol y, si
 * vale, la apila en el lugar.
 *
 * Entrada (stdin): `{ "home": "<HOME>", "state": <el estado del mecanismo> }`. No escribe el estado: lo escribe quien
 * llama, con lo que este guion devuelve.
 * Salida (stdout, una línea JSON): `{ "result": { status, lines }, "team": <state.team después>, "log": [<líneas>] }`.
 * Sale 0 con esa línea, también si la capa no se pudo apilar (eso va en `result.status`); 2 si la entrada no se lee.
 */
const os = require('os');
const path = require('path');

function main() {
  let input = '';
  try { input = require('fs').readFileSync(0, 'utf8'); } catch (e) { process.stderr.write(`team-after-swap: no pude leer la entrada (${e.message})\n`); return 2; }
  let data;
  try { data = JSON.parse(input); } catch (e) { process.stderr.write(`team-after-swap: la entrada no es JSON (${e.message})\n`); return 2; }
  if (!data || typeof data !== 'object' || !data.state || typeof data.state !== 'object') {
    process.stderr.write('team-after-swap: falta el estado en la entrada\n');
    return 2;
  }
  const R = require('./release.js');
  const state = data.state;
  const ctx = { tree: path.resolve(__dirname, '..', '..', '..'), home: typeof data.home === 'string' && data.home ? data.home : os.homedir(), env: process.env, opts: {}, args: [], platform: process.platform };
  const log = [];
  let result;
  try { result = R.refreshTeam(ctx, state, { log: (l) => log.push(String(l)) }); } catch (e) { result = { status: 'failed', lines: [`capa del equipo: no se pudo evaluar (${e.message})`] }; }
  process.stdout.write(`${JSON.stringify({ result: { status: result.status, lines: result.lines || [] }, team: state.team || null, log })}\n`);
  return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
