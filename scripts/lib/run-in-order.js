#!/usr/bin/env node
'use strict';
/**
 * scripts/lib/run-in-order.js — corre varios guiones de Node uno después del otro, sin ventana.
 *
 * Uso: node run-in-order.js <programa> -- <argumentos…> [-- <argumentos…>]…
 * Cada tramo entre `--` es un comando: `<programa> <argumentos…>`. Corren en el orden dado, y uno que falla no corta los
 * siguientes: cada uno deja su propio registro. Sale 0 si todos salieron 0, y 1 si alguno no.
 *
 * Por qué: el arranque de Windows lanza lo de fondo con Start-Process, que lanza un solo proceso. La recolección de
 * hallazgos tiene que terminar antes de la subida al buzón, para que lo de hoy suba hoy (como la tanda de fondo del .sh).
 * El programa se pasa, no se toma el Node de este proceso: es el mismo con que el instalador lanza todo lo demás. Si no
 * se encuentra por su nombre, corre con el Node de este proceso.
 */
const { spawnSync } = require('child_process');

/** Los comandos de la línea: `{ programa, comandos: [[args…], …] }`, o null si está mal llamada. */
function parse(argv) {
  const [programa, ...resto] = argv;
  if (!programa || programa === '--' || resto[0] !== '--') return null;
  const comandos = [];
  for (const a of resto) {
    if (a === '--') comandos.push([]);
    else comandos[comandos.length - 1].push(a);
  }
  return comandos.some((c) => !c.length) ? null : { programa, comandos };
}

function run({ programa, comandos }, { spawn = spawnSync } = {}) {
  let todos = true;
  for (const args of comandos) {
    let r = spawn(programa, args, { stdio: 'ignore', windowsHide: true });
    // sin shell, un programa que sólo existe como `.cmd` (un `node` instalado así) no se encuentra por su nombre: corre con
    // el Node de este proceso, el mismo que lanzó el instalador
    if (r && r.error && r.error.code === 'ENOENT') r = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
    if (!r || r.error || r.status !== 0) todos = false;
  }
  return todos ? 0 : 1;
}

if (require.main === module) {
  const p = parse(process.argv.slice(2));
  if (!p) {
    console.error('run-in-order: uso: node run-in-order.js <programa> -- <argumentos…> [-- <argumentos…>]…');
    process.exit(2);
  }
  process.exit(run(p));
}

module.exports = { parse, run };
