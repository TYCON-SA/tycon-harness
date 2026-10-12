'use strict';
// detach.js — la actualización del arranque, fuera del tope del hook (story 8.23, tanda L, AC 38).
//
// ── EL CASO (2026-10-06) ──────────────────────────────────────────────────────────────────────────────────────────
// La línea de arranque es un hook de Claude Code, y Claude Code lo corta cuando pasa su tope. En una máquina Windows del
// equipo, con 240 commits de atraso, la actualización (fetch, merge, aplicador, salud) tardaba más que eso: el hook moría
// con el candado tomado, el arranque siguiente lo veía «ocupado» y se iba, y la máquina no se actualizaba nunca.
//
// ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// `runDetached` lanza el mismo programa como proceso APARTE (desprendido del hook: otro grupo de procesos, sin ventana en
// Windows) y espera hasta `waitMs` a que termine:
//   · si termina a tiempo, devuelve su código y sus líneas — así un error temprano (una versión rota) sigue saliendo ≠ 0 y
//     la línea de arranque cae al respaldo en shell, como siempre;
//   · si no, vuelve con `detached: true` y código 0: el hook termina y la actualización sigue sola, con su candado y su
//     registro (startup.log). Si después la cortan igual, el candado queda con un PID muerto y el arranque siguiente lo
//     pisa en el acto (lock.js, AC 37).
// El hijo anota su resultado en `resultFile` (escritura atómica) con `writeResult`, o al salir por cualquier motivo con el
// manejador que instala `adoptDetachedRun`. La espera es por ese archivo y no por el proceso: mientras el hook espera no corre su
// bucle de eventos y el hijo terminado no se recoge (en POSIX un hijo sin recoger sigue «existiendo»).
//
// Sin dependencias: sólo módulos de Node (viaja con la copia fija del programa).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DETACHED_VAR = 'TYCON_STARTUP_DETACHED';   // marca la corrida desprendida: no se vuelve a desprender
const RESULT_VAR = 'TYCON_STARTUP_RESULT';       // dónde anota su resultado
// ── EL RELEVO EN WINDOWS (2026-10-07, reporte de un dev del equipo: 20 o más ventanas de consola por arranque) ────────
// En Windows el proceso desprendido (`detached: true` = DETACHED_PROCESS) queda SIN consola, y cada programa de consola
// que lanza sin `windowsHide` (git, pwsh, node) recibe una consola nueva y VISIBLE. Antes de la tanda L todo corría dentro
// del hook, con la consola oculta que le da Claude Code; por eso nunca se vio. Arreglo (variante E del reporte, medida en
// la máquina del dev): el desprendido NO hace el trabajo. Lanza al que lo hace SIN desprender y con `windowsHide: true`
// —ese hijo recibe una consola propia sin ventana, y todo lo que él lance la hereda— y se queda vivo esperándolo (un hijo
// sin desprender muere con quien lo lanzó). El candado, la marca de arranque y el resultado son del que trabaja; para el
// hook no cambia nada. `TYCON_STARTUP_SHIM=1` lo fuerza en cualquier sistema (las pruebas); `0` lo apaga.
const WORKER_VAR = 'TYCON_STARTUP_WORKER';       // marca al que trabaja detrás del relevo: no se relanza otra vez
const SHIM_VAR = 'TYCON_STARTUP_SHIM';
const GONE_SUFFIX = '.gone';                     // el hook ya se fue: nadie lo va a leer
const STARTED_SUFFIX = '.started';               // el hijo arrancó (lo primero que hace)

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readResult(file) {
  try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r && typeof r.code === 'number' ? r : null; } catch (_) { return null; }
}

/**
 * @returns {{ detached: boolean, code: number, lines: string[], pid: number } | null} null = no se pudo lanzar (el
 *   llamador corre en el lugar, como antes).
 */
function runDetached({ script, args = [], env = process.env, resultFile, waitMs = 20000, pollMs = 100, startWaitMs = 10000 }) {
  try { for (const s of ['', GONE_SUFFIX, STARTED_SUFFIX]) fs.rmSync(resultFile + s, { force: true }); } catch (_) { /* nada */ }
  let child;
  try {
    child = spawn(process.execPath, [script, ...args], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, env, { [DETACHED_VAR]: '1', [RESULT_VAR]: resultFile }),
    });
  } catch (_) { return null; }
  if (!child || !child.pid) return null;
  child.on('error', () => { /* sin el hijo: la espera vence y el arranque siguiente reintenta */ });
  child.unref();
  const t0 = Date.now();
  const deadline = t0 + waitMs;
  for (;;) {
    const r = readResult(resultFile);
    if (r) {
      try { fs.rmSync(resultFile, { force: true }); fs.rmSync(resultFile + STARTED_SUFFIX, { force: true }); } catch (_) { /* nada */ }
      return { detached: false, code: r.code, lines: Array.isArray(r.lines) ? r.lines.map(String) : [], pid: child.pid };
    }
    // sin la marca de arranque a los pocos segundos, el hijo no arrancó (el programa no está, Node no lo carga): no es
    // «sigue aparte» (revisor de fallos silenciosos de la tanda L) — sale ≠ 0 y la línea cae al respaldo en shell
    if (Date.now() - t0 >= startWaitMs && !fs.existsSync(resultFile + STARTED_SUFFIX)) {
      // y se corta: uno que sólo era LENTO para arrancar no puede quedar actualizando a la vez que el respaldo en shell
      // (pase adversarial de la tanda L)
      try { process.kill(child.pid, 'SIGKILL'); } catch (_) { /* ya no está */ }
      try { fs.writeFileSync(resultFile + GONE_SUFFIX, `${child.pid}\n`); } catch (_) { /* nada */ }
      return { detached: false, notStarted: true, code: 1, lines: [`la actualización aparte no arrancó en ${startWaitMs / 1000} s (pid ${child.pid}, ${script})`], pid: child.pid };
    }
    if (Date.now() >= deadline) break;
    sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  try { fs.writeFileSync(resultFile + GONE_SUFFIX, `${child.pid}\n`); } catch (_) { /* el hijo deja su resultado y queda */ }
  return { detached: true, code: 0, lines: [], pid: child.pid };
}

let written = false;
let adopted = false;
let resultFile = null;
/**
 * En el hijo, lo primero: toma la marca de la corrida desprendida y su archivo de resultado, y los BORRA del ambiente —lo
 * que este proceso lance (el aplicador, sus hijos) no los hereda: un `harness.js startup` nieto se creería la corrida
 * desprendida y le escribiría el resultado al hook—. Anota el código con que sale aunque no pase por `writeResult`.
 * @returns {boolean} si éste es el hijo desprendido.
 */
function adoptDetachedRun() {
  if (adopted) return true;
  if (process.env[DETACHED_VAR] !== '1') return false;
  if (wantsShim(process.env) && process.env[WORKER_VAR] !== '1') {
    // el relevo: mismo programa, mismos argumentos, sin desprender y con la ventana oculta; este proceso espera y sale
    // con el código del que trabajó (si no pudo lanzarlo, 1: el hook lo lee como «no arrancó» y cae al respaldo)
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { [WORKER_VAR]: '1' }) });
    process.exit(typeof r.status === 'number' ? r.status : 1);
  }
  delete process.env[WORKER_VAR];
  adopted = true;
  resultFile = process.env[RESULT_VAR] || null;
  if (resultFile) { try { fs.writeFileSync(resultFile + STARTED_SUFFIX, `${process.pid}\n`); } catch (_) { /* el hook lo va a dar por no arrancado */ } }
  delete process.env[DETACHED_VAR];
  delete process.env[RESULT_VAR];
  process.on('exit', (code) => writeResult(typeof code === 'number' ? code : 1, []));
  return true;
}
function isDetachedRun() { return adopted; }
/** Si la corrida desprendida pasa por el relevo: en Windows siempre (salvo SHIM=0); en los demás, sólo con SHIM=1. */
function wantsShim(env = process.env) { return env[SHIM_VAR] === '1' || (env[SHIM_VAR] !== '0' && process.platform === 'win32'); }
/** El hijo anota su resultado (una vez). Si el hook ya se fue, no deja nada. */
function writeResult(code, lines = []) {
  const file = resultFile;
  if (!file || written) return;
  written = true;
  try {
    if (fs.existsSync(file + GONE_SUFFIX)) { for (const s of [GONE_SUFFIX, STARTED_SUFFIX]) fs.rmSync(file + s, { force: true }); return; }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ code, lines }));
    fs.renameSync(tmp, file);
    // el hook pudo irse entre la mirada y la escritura: lo que quedó lo barre el arranque siguiente (sweep)
  } catch (_) { /* sin resultado: el hook espera hasta su tope y sale 0 */ }
}
/** Barre los resultados que nadie leyó (de hooks que se fueron) con más de una hora. */
function sweep(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^startup-result\.\d+\.json(?:\.gone|\.started|\.\d+\.tmp)?$/.test(n)); } catch (_) { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { force: true }); } catch (_) { /* nada */ }
  }
}

module.exports = { DETACHED_VAR, RESULT_VAR, WORKER_VAR, SHIM_VAR, runDetached, adoptDetachedRun, isDetachedRun, wantsShim, writeResult, sweep };
