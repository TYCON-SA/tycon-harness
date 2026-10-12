'use strict';

/**
 * run-capped.test.js — el tope de cada suite en la validación de cada rama (story 8.22, tramo D).
 *
 * `scripts/ci/run-capped.js` corre una suite con un tope de segundos y, si lo pasa, la corta entera: la suite y todo lo
 * que lanzó. El camino feliz del corte lo prueba el paso real del pipeline (pr-verdict.test.sh, V18a). Acá van los
 * bordes que encontraron la revisión y el pase adversarial del tramo D:
 *   · un pedido mal hecho no corre nada (sale 2), tampoco un tope que desborda el temporizador de Node: desbordado,
 *     Node lo baja a 1 ms y una suite sana saldría cortada;
 *   · un comando que no se puede lanzar sale 127, no 128;
 *   · el código de la suite pasa tal cual y, sin corte, no hay marca;
 *   · al cortar, lo que ignora el TERM tiene sus 5 s de gracia antes del KILL, y después no queda nada vivo.
 *
 * Sin red y en carpetas temporales. Los grupos de procesos son de POSIX: en Windows estas pruebas se saltean (la
 * validación corre en el agente Linux).
 *
 * Correr: node --test scripts/tests/run-capped.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'ci', 'run-capped.js');
const POSIX = process.platform !== 'win32';

const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });
function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-capped-'));
  labs.push(dir);
  return dir;
}
function run(args) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

test('RunCapped_BadRequest_Exits2AndRunsNothing', () => {
  const dir = lab();
  const touched = path.join(dir, 'touched');
  const cmd = ['--', process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(touched)}, "x")`];
  const mark = ['--mark', path.join(dir, 'mark')];
  for (const [args, pattern, what] of [
    [[...mark, ...cmd], /--seconds/, 'sin --seconds'],
    [['--seconds', '0', ...mark, ...cmd], /--seconds/, 'un tope de 0'],
    [['--seconds', '1.5', ...mark, ...cmd], /--seconds/, 'un tope que no es entero'],
    [['--seconds', '2147484', ...mark, ...cmd], /--seconds/, 'un tope que desborda el temporizador de Node'],
    [['--seconds', '5', ...cmd], /--mark/, 'sin --mark'],
    [['--seconds', '5', ...mark, '--'], /comando/, 'sin comando'],
  ]) {
    const r = run(args);
    assert.strictEqual(r.code, 2, `${what}: ${r.err}`);
    assert.match(r.err, pattern, what);
    assert.ok(!fs.existsSync(touched), `${what}: no corrió nada`);
  }
  // El tope más grande que entra en el temporizador sí vale.
  const big = run(['--seconds', '2147483', ...mark, '--', process.execPath, '-e', '']);
  assert.strictEqual(big.code, 0, big.err);
});

test('RunCapped_ExitCodePassesThroughAndNoMark', () => {
  const dir = lab();
  const mark = path.join(dir, 'mark');
  const r = run(['--seconds', '30', '--mark', mark, '--', process.execPath, '-e', 'process.exit(3)']);
  assert.strictEqual(r.code, 3, r.err);
  assert.ok(!fs.existsSync(mark), 'sin corte no hay marca');
  // Un 124 de la propia suite no es un corte: la señal es la marca.
  const own = run(['--seconds', '30', '--mark', mark, '--', process.execPath, '-e', 'process.exit(124)']);
  assert.strictEqual(own.code, 124);
  assert.ok(!fs.existsSync(mark), 'la suite salió 124 sola: no hay marca');
  // Una señal que no puso el tope (un OOM, un kill de afuera) sale 128 + su número, sin marca: no es un corte.
  if (POSIX) {
    const killed = run(['--seconds', '30', '--mark', mark, '--', process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")']);
    assert.strictEqual(killed.code, 128 + os.constants.signals.SIGTERM, killed.err);
    assert.ok(!fs.existsSync(mark), 'una señal de afuera no es un corte por tope');
  }
});

test('RunCapped_CannotLaunch_Exits127', () => {
  const dir = lab();
  const r = run(['--seconds', '30', '--mark', path.join(dir, 'mark'), '--', path.join(dir, 'no-existe')]);
  assert.strictEqual(r.code, 127, `un comando que no se puede lanzar sale 127, no ${r.code}: ${r.err}`);
  assert.match(r.err, /no pude lanzar/);
});

test('RunCapped_OverCap_KillsTheWholeGroupMarksAndExits124', { skip: !POSIX && 'grupos de procesos: sólo POSIX' }, () => {
  const dir = lab();
  const mark = path.join(dir, 'mark');
  const pidFile = path.join(dir, 'child.pid');
  // El líder lanza un hijo que duerme y lo espera: los dos son del grupo.
  const r = run(['--seconds', '1', '--mark', mark, '--', 'bash', '-c', `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`]);
  assert.strictEqual(r.code, 124, r.err);
  assert.strictEqual(fs.readFileSync(mark, 'utf8'), 'pasó el tope de 1 s\n');
  assert.ok(r.ms < 10000, `cortó al tope, no a los 30 s: ${r.ms} ms`);
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(!alive(child), 'el hijo que dormía también se fue');
});

test('RunCapped_OverCap_WhatIgnoresTermGetsTheGraceThenKill', { skip: !POSIX && 'grupos de procesos: sólo POSIX' }, () => {
  // Revisor de fallos silenciosos, tramo D: el KILL salía apenas el líder moría tras el TERM, sin los 5 s de gracia.
  // Un hijo que ignora el TERM y escribe al segundo tiene que llegar a escribir; después, nada queda vivo.
  const dir = lab();
  const late = path.join(dir, 'late');
  const pidFile = path.join(dir, 'child.pid');
  const r = run(['--seconds', '1', '--mark', path.join(dir, 'mark'), '--', 'bash', '-c',
    `(trap "" TERM; sleep 1; echo vivo > ${JSON.stringify(late)}; sleep 30) & echo $! > ${JSON.stringify(pidFile)}; wait`]);
  assert.strictEqual(r.code, 124, r.err);
  assert.ok(fs.existsSync(late), 'lo que ignora el TERM tuvo su gracia antes del KILL');
  assert.ok(r.ms < 10000, `el KILL llegó al final de la gracia, no a los 30 s: ${r.ms} ms`);
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'pasada la gracia, no queda nada vivo');
});
