'use strict';
/**
 * prompt.js — la única forma en que el programa de instalación le pregunta algo a una persona. La usan `install` («¿Instalo?»), `update` («¿Aplico ahora?»), `uninstall` y el paso a `latest`.
 *
 *   · «hay terminal» es `process.stdin.isTTY` y nada más: sin terminal (la herramienta Bash de un agente, un pipeline) no
 *     se imprime ninguna pregunta y la respuesta es no;
 *   · un sí es `s`, `si`, `sí`, `y` o `yes` (con mayúsculas o espacios alrededor); CUALQUIER otra cosa es no: vacío, fin
 *     de entrada, una terminal que se cerró a mitad de la lectura;
 *   · sin tiempo límite, sin colores, sin biblioteca de pantalla: texto por stdout y una línea leída de stdin.
 *
 * La lectura es sincrónica (`fs.readSync` sobre el descriptor 0) porque los comandos del programa son sincrónicos; se
 * inyecta para probarla sin una terminal de verdad (harness-prompt.test.js).
 */
const fs = require('fs');

const YES = /^\s*(s|si|sí|y|yes)\s*$/i;

/** ¿La respuesta es un sí? Todo lo que no es una de las cinco formas es no. */
function saidYes(answer) {
  return typeof answer === 'string' && YES.test(answer);
}

/** ¿Hay una persona delante? `isTTY` del stdin, y nada más. */
function isTerminal(stdin = process.stdin) {
  return Boolean(stdin) && stdin.isTTY === true;
}

// una pausa sincrónica corta (sin ocupar el procesador) mientras la terminal todavía no tiene nada escrito
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Una línea de la entrada (sin el salto), sincrónica. Fin de entrada o una lectura que tira: vacío. Una terminal sin nada
 * escrito todavía dice EAGAIN (Node la deja sin bloqueo): eso no es un «no», es que la persona todavía no tipeó; se
 * espera sin tiempo límite, en pausas cortas.
 */
function readLine(opts = {}) {
  return readAnswer(opts).text;
}

/**
 * Lo mismo que `readLine`, diciendo además si la entrada se terminó (`eof`): fin de entrada, o una terminal cerrada o
 * ilegible, antes de leer nada. Las preguntas de la instalación lo necesitan: en una terminal, la
 * lectura que sigue a un fin de entrada vuelve a esperar, y una pregunta que se repite se quedaría esperando sin que
 * nadie conteste.
 * @returns {{ text: string, eof: boolean }}
 */
function readAnswer({ fd = 0, readSync = fs.readSync, wait = pause } = {}) {
  const buf = Buffer.alloc(256);
  // los bytes se juntan y se decodifican al final: un carácter de varios bytes («í») partido entre dos lecturas no se
  // vuelve un carácter roto
  const chunks = [];
  let ended = false, error = null;
  for (;;) {
    let n;
    try { n = readSync(fd, buf, 0, buf.length, null); } catch (e) {
      if (e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK')) { wait(50); continue; }
      ended = true; error = (e && e.code) || (e && e.message) || 'error de lectura';
      break;   // terminal cerrada o ilegible: no (y quien necesite distinguirlo de «nada escrito» tiene `error`)
    }
    if (!n || n <= 0) { ended = true; break; }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    if (buf.subarray(0, n).includes(10)) break;
  }
  const out = { text: Buffer.concat(chunks).toString('utf8').split('\n')[0].replace(/\r$/, ''), eof: ended && chunks.length === 0 };
  if (error) out.error = error;
  return out;
}

/**
 * Un valor SECRETO de la terminal: sin eco y sin la basura del pegado. Sin esto, un permiso de GitHub pegado en
 * `config set github.token` queda a la vista en la terminal y se guarda junto con las marcas del pegado
 * (`ESC[200~ … ESC[201~`) que la terminal manda alrededor de lo pegado, y el permiso deja de valer (401).
 * En modo crudo (`setRawMode`) cada tecla llega sola: se juntan los bytes hasta Enter (CR o LF), se descartan las
 * secuencias de escape enteras (las marcas del pegado, una flecha) y los controles sueltos, Backspace borra, y un salto
 * de línea que viene ADENTRO del pegado no termina la lectura (es parte de lo pegado, que la terminal entrega entero).
 * Ctrl-C y Ctrl-D abortan; también el fin de entrada sin Enter. El modo crudo se apaga siempre, pase lo que pase.
 * Una terminal sin modo crudo (no es una tty de verdad) se lee con eco, como una línea, y se dice (`echoed: true`) para
 * que quien pregunta avise. Un carácter de varios bytes partido entre lecturas no se rompe: se decodifica al final.
 * @returns {{ text: string, aborted: boolean, echoed: boolean }}
 */
function readSecret({ stdin = process.stdin, fd = 0, readSync = fs.readSync, write = (s) => process.stdout.write(s), wait = pause } = {}) {
  const raw = Boolean(stdin) && typeof stdin.setRawMode === 'function';
  if (!raw) { const r = readAnswer({ fd, readSync, wait }); return { text: r.text, aborted: false, echoed: true }; }
  const bytes = [];
  let aborted = false, done = false, paste = 0, error = null;
  const buf = Buffer.alloc(256);
  const MAX_PENDING = 32;   // una secuencia de escape más larga que esto no es una secuencia: se descarta
  stdin.setRawMode(true);
  try {
    let pending = Buffer.alloc(0);   // una secuencia de escape a medias entre dos lecturas
    while (!done) {
      let n;
      try { n = readSync(fd, buf, 0, buf.length, null); } catch (e) {
        if (e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK')) { wait(50); continue; }
        aborted = true; error = (e && e.code) || (e && e.message) || 'error de lectura'; break;   // un error real se dice como tal
      }
      if (!n || n <= 0) { aborted = true; break; }   // fin de entrada sin Enter: no hay valor
      let chunk = Buffer.concat([pending, buf.subarray(0, n)]); pending = Buffer.alloc(0);
      for (let i = 0; i < chunk.length && !done; i++) {
        const b = chunk[i];
        if (b === 0x1b) {
          // Las secuencias de la terminal: CSI (ESC [ … <final 0x40-0x7e>; las marcas del pegado son ESC[200~ y
          // ESC[201~), SS3 (ESC O <una tecla>: una flecha en modo aplicación) y Alt+tecla (ESC <un byte>). Ninguna entra
          // al valor. Una que llega CORTADA al final de lo leído se completa con la lectura siguiente; nunca más de
          // MAX_PENDING bytes, y nunca si no es el final del pedazo (un Esc suelto seguido de texto deja la lectura
          // colgada esperando el cierre de una secuencia que no viene: ni Enter ni Ctrl-C salen)
          const rest = chunk.subarray(i);
          if (rest.length === 1) continue;   // un Esc SOLO al final de lo leído: una tecla Esc suelta; se descarta (no se espera nada)
          if (rest[1] === 0x5b) {   // ESC [
            const m = /^\x1b\[([0-9;?]*)([\x40-\x7e])/.exec(rest.toString('latin1'));
            if (m) {
              if (m[2] === '~' && m[1] === '200') paste++; else if (m[2] === '~' && m[1] === '201') paste = Math.max(0, paste - 1);
              i += m[0].length - 1;
              continue;
            }
            if (rest.length <= MAX_PENDING && /^\x1b\[[0-9;?]*$/.test(rest.toString('latin1'))) { pending = rest; break; }   // CSI cortada al final
            i += 1; continue;   // ESC [ seguido de otra cosa: se descartan los dos bytes y sigue el texto
          }
          if (rest[1] === 0x4f) { if (rest.length < 3) { pending = rest; break; } i += 2; continue; }   // ESC O <tecla>
          i += 1; continue;   // Alt+tecla: ESC y el byte que sigue
        }
        if (b === 0x03 || b === 0x04) { aborted = true; done = true; break; }
        if ((b === 0x0d || b === 0x0a) && !paste) { done = true; break; }
        // Backspace: el carácter entero, aunque tenga varios bytes — primero los bytes de continuación (10xxxxxx) y después el que
        // encabeza (si se saca un byte y después las continuaciones, queda el primero)
        if (b === 0x7f || b === 0x08) { while (bytes.length && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop(); bytes.pop(); continue; }
        if (b < 0x20) continue;   // otro control suelto (un salto adentro del pegado, un tabulador): no es parte del valor
        bytes.push(b);
      }
    }
  } finally { try { stdin.setRawMode(false); } catch (_) { /* la terminal se cerró */ } }
  write('\n');
  const out = { text: aborted ? '' : Buffer.from(bytes).toString('utf8'), aborted, echoed: false };
  if (error) out.error = error;   // sólo cuando la lectura falló de verdad (no Ctrl-C, no fin de entrada)
  return out;
}

/**
 * Pregunta una vez y devuelve si la respuesta fue sí. Sin terminal no imprime nada, no lee y devuelve false: quien llama
 * decide qué decir en ese caso (casi siempre, «sin --yes y sin terminal no …»).
 */
function ask(question, { tty = isTerminal(), read = readLine, write = (s) => process.stdout.write(s) } = {}) {
  if (!tty) return false;
  write(question);
  return saidYes(read());
}

module.exports = { saidYes, isTerminal, readLine, readAnswer, readSecret, ask };
