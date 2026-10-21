#!/usr/bin/env node
'use strict';

/**
 * run-capped.js — corre un comando con un tope de segundos y, si lo pasa, lo corta entero: el comando y todo lo que
 * lanzó.
 *
 * POR QUÉ: en la validación de cada rama (pipelines/azure-pipelines-maintainers-pr.yml) una suite colgada se come el
 * trabajo entero: tardar 1185 s contra los ~161 de siempre, o terminar el trabajo cortado a los 45 min, sin veredicto.
 * Con un tope por suite, la colgada se corta, sale «NO se midió» y el trabajo sigue con las demás. El tope de cada
 * suite lo calcula `scripts/ci/suites-shard.js caps`.
 *
 * POR QUÉ NO `timeout`: el agente de Azure es Linux y lo tiene; la Mac del dev, donde corren las pruebas del paso que
 * lo usa, no. Y `timeout` sólo mata al proceso que lanzó: una suite que espera a un `git` o a un `node` hijo los deja
 * vivos, comiéndose la máquina del resto del trabajo. Acá el comando corre en su propio GRUPO de procesos y se corta
 * el grupo entero: TERM y, si a los 5 s queda algo, KILL. Lo que se va a otro grupo a propósito (`setsid`) queda
 * vivo; no cambia el resultado.
 *
 * Uso:  node scripts/ci/run-capped.js --seconds <n> --mark <archivo> -- <comando> [argumentos…]
 *   La entrada y las salidas son las de este proceso (quien llama las redirige).
 *   Sale con el código del comando; si lo mató una señal, 128 + su número. Si pasó el tope: escribe <archivo> con
 *   «pasó el tope de <n> s» y sale 124. La marca es lo que manda, no el 124: un comando puede salir 124 por su cuenta.
 *   Un pedido mal hecho (sin --seconds entero mayor que 0, sin --mark, sin comando) sale 2 y no corre nada. Un comando
 *   que no se puede lanzar sale 127. Un tope de más de 2147483 s también es un pedido mal hecho: el temporizador de Node
 *   no llega, y desbordado cortaría en 1 ms.
 *   Al cortar, si del grupo no queda nadie se sale enseguida; si algo ignoró el TERM, se espera la gracia y va el KILL.
 *
 * Red: scripts/tests/run-capped.test.js · scripts/tests/pr-verdict.test.sh (V18: el paso de la validación, sacado del
 * YAML, con una suite que se cuelga).
 */

const fs = require('fs');
const { spawn } = require('child_process');

const KILL_GRACE_MS = 5000;
const CAPPED_EXIT = 124;
const MAX_SECONDS = Math.floor((2 ** 31 - 1) / 1000);
const USAGE = 'uso: run-capped.js --seconds <n> --mark <archivo> -- <comando> [argumentos…]\n';

function parse(argv) {
  const dash = argv.indexOf('--');
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const value = (name) => { const i = own.indexOf(name); return i >= 0 && i + 1 < own.length ? own[i + 1] : null; };
  const secondsText = value('--seconds');
  const seconds = typeof secondsText === 'string' && /^[1-9]\d*$/.test(secondsText) ? Number(secondsText) : null;
  const mark = value('--mark');
  if (seconds === null) return { error: `--seconds tiene que ser un entero mayor que 0: ${JSON.stringify(secondsText)}` };
  // Un temporizador de Node no pasa de 2^31-1 ms: más grande, lo baja a 1 ms y el tope saltaría enseguida (pase
  // adversarial del tramo D). Ningún peso real llega cerca: es un pedido mal hecho.
  if (seconds > MAX_SECONDS) return { error: `--seconds no puede pasar de ${MAX_SECONDS} (el temporizador de Node): ${secondsText}` };
  if (!mark) return { error: 'falta --mark <archivo donde anotar que pasó el tope>' };
  if (!command.length) return { error: 'falta el comando, después de --' };
  return { seconds, mark, command };
}

/** Manda una señal al grupo entero; si el sistema no tiene grupos (Windows), al proceso. */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    if (e.code === 'ESRCH') return;
    try { child.kill(signal); } catch (_) { /* ya no está */ }
  }
}

/** ¿Queda algún proceso del grupo? Sin grupos (Windows), no se sabe: se dice que sí y se espera la gracia. */
function groupAlive(child) {
  if (process.platform === 'win32') return true;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function main(argv) {
  const request = parse(argv);
  if (request.error) {
    process.stderr.write(`run-capped: ${request.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { seconds, mark, command } = request;
  let capped = false;
  let launchFailed = false;
  let grace = null;
  let child;
  try {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: process.platform !== 'win32' });
  } catch (e) {
    process.stderr.write(`run-capped: no pude lanzar ${command[0]}: ${e.message}\n`);
    process.exitCode = 127;
    return;
  }
  const cap = setTimeout(() => {
    capped = true;
    try {
      fs.writeFileSync(mark, `pasó el tope de ${seconds} s\n`);
    } catch (e) {
      process.stderr.write(`run-capped: no pude escribir la marca ${mark}: ${e.message}\n`);
    }
    signalGroup(child, 'SIGTERM');
    // La gracia corre aunque el líder salga antes: lo que ignoró el TERM tiene sus 5 s y después se va con el KILL.
    // Este temporizador es lo que mantiene vivo al proceso hasta entonces.
    grace = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
  }, seconds * 1000);
  child.on('error', (e) => {
    clearTimeout(cap);
    launchFailed = true;
    process.stderr.write(`run-capped: no pude lanzar ${command[0]}: ${e.message}\n`);
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(cap);
    // Un lanzamiento fallido ya dijo 127: un `exit` que llegue después no lo pisa.
    if (launchFailed) return;
    if (capped) {
      process.exitCode = CAPPED_EXIT;
      // Si del grupo no queda nadie, no hay a quién esperar: se sale ya, sin consumir la gracia.
      if (grace && !groupAlive(child)) clearTimeout(grace);
      return;
    }
    const signals = require('os').constants.signals;
    process.exitCode = code !== null ? code : 128 + (signals[signal] || 0);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parse, CAPPED_EXIT };
