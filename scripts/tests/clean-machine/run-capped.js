#!/usr/bin/env node
'use strict';
/**
 * run-capped.js — corre un comando bajo un tope de tiempo.
 *
 *   node run-capped.js <paso> <segundos> [--container <nombre>] -- <comando…>
 *
 * Sale con el código del comando. Si el tope vence sale 124 (el de `timeout`), después de:
 *   · matar el GRUPO de procesos del comando (matar sólo al hijo deja vivos a sus nietos, que retienen la salida);
 *   · con `--container`, sacar ese contenedor con `docker rm -f`: matar al cliente de docker no frena al contenedor,
 *     que sigue corriendo en el servicio.
 *
 * Por qué no `timeout`: en macOS no está (ni `gtimeout`), y `node` ya es requisito del arnés. Es el patrón de
 * `portable-suites.test.sh` (`detached` + matar `-pid`).
 *
 * La entrada y la salida del comando son las de quien llama: este envoltorio no escribe nada salvo una línea en
 * stderr cuando corta. `<paso>` es sólo el nombre con que lo dice.
 */
const { spawn, spawnSync } = require('child_process');

const EXIT_CAP = 124;
const EXIT_USAGE = 2;
/** tope del propio `docker rm -f`: un servicio colgado no puede dejar colgado al que corta */
const REMOVE_CAP_MS = 30000;

function usage(msg) {
  process.stderr.write(`run-capped: ${msg}\nuso: node run-capped.js <paso> <segundos> [--container <nombre>] -- <comando…>\n`);
  process.exit(EXIT_USAGE);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 2) usage('faltan el paso, los segundos o el «--»');
const [stepName, secondsRaw, ...opts] = argv.slice(0, sep);
const command = argv.slice(sep + 1);
if (!command.length) usage('falta el comando después de «--»');
if (!/^[0-9]+$/.test(secondsRaw) || Number(secondsRaw) < 1) usage(`los segundos tienen que ser un entero de 1 o más: «${secondsRaw}»`);
let container = '';
if (opts.length) {
  if (opts.length !== 2 || opts[0] !== '--container' || !opts[1]) usage(`opción que no conozco: «${opts.join(' ')}»`);
  container = opts[1];
}
// El reloj de Node guarda el plazo en un entero de 32 bits: pasado de 2^31-1 ms lo baja a 1 ms y el paso se corta al
// instante. Un tope más grande que eso (unos 24 días) se queda en el máximo: es «sin tope» a todo efecto.
const MAX_SECONDS = 2147483;
const seconds = Math.min(Number(secondsRaw), MAX_SECONDS);

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true });
let capped = false;
let done = false;

function killGroup() {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* ya murió */ }
  }
}
function removeContainer() {
  if (!container) return;
  // `docker` sale del PATH de quien llama; con tope propio y sin mirar su resultado: si no existe, no hay nada que sacar
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: REMOVE_CAP_MS, killSignal: 'SIGKILL' });
}
function cut(reason, code) {
  if (done) return;
  done = true;
  killGroup();
  removeContainer();
  process.stderr.write(`run-capped: ${stepName} ${reason}\n`);
  process.exit(code);
}

const timer = setTimeout(() => { capped = true; cut(`pasó el tope de ${seconds} s`, EXIT_CAP); }, seconds * 1000);
// si cortan a quien llama (Ctrl-C, el tope del job), el comando y su contenedor no quedan huérfanos
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => cut(`cortado por ${sig}`, 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]));
}

child.on('error', (e) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  process.stderr.write(`run-capped: ${stepName} no pudo arrancar «${command[0]}»: ${e.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (done || capped) return;
  done = true;
  clearTimeout(timer);
  // nietos que hayan quedado vivos en el grupo no sobreviven al paso
  killGroup();
  if (signal) {
    process.stderr.write(`run-capped: ${stepName} terminó por la señal ${signal}\n`);
    process.exit(128 + (require('os').constants.signals[signal] || 0));
  }
  process.exit(code === null ? 1 : code);
});
