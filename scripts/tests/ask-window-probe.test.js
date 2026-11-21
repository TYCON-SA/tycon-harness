'use strict';
/**
 * ask-window-probe.test.js — la sonda de la ventana de permiso (scripts/controls-bench/ask-window-probe.exp) no da verde
 * cuando no puede medir: sin `claude` o sin `expect` en el camino dice «NO MEDIDO» y sale distinto de 0.
 *
 * La medición de verdad pide una sesión de Claude Code con una persona delante; acá sólo se prueba la salida sin
 * herramientas, con un PATH armado a mano. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SONDA = path.join(__dirname, '..', 'controls-bench', 'ask-window-probe.exp');

function correr(PATH) {
  return spawnSync('/bin/sh', [SONDA], { env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'awp-home-')), PATH }, encoding: 'utf8', timeout: 20000 });
}

// AskWindowProbe_SinClaude_NoMedido
// 🔴 Falla con: una sonda que, sin la herramienta que mide, sale en 0 o calla: el banco la contaría como la ventana
//    medida y en verde.
test('T31 AskWindowProbe_SinClaude_NoMedido @story-8.139 @ac-31 — sin claude o sin expect en el camino: «NO MEDIDO», nunca 0', (t) => {
  if (process.platform === 'win32') { t.skip('la sonda corre con sh y expect: no en Windows'); return; }
  // sin expect: una carpeta vacía de camino
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-vacio-'));
  const sinExpect = correr(vacio);
  assert.notEqual(sinExpect.status, 0, sinExpect.stdout + sinExpect.stderr);
  assert.match(sinExpect.stdout + sinExpect.stderr, /NO MEDIDO: no hay expect/);
  // con expect y sin claude: el camino sólo trae expect
  const expect = spawnSync('/bin/sh', ['-c', 'command -v expect'], { encoding: 'utf8' }).stdout.trim();
  if (!expect) { t.diagnostic('esta máquina no tiene expect: el caso sin claude se mide donde lo haya'); return; }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-bin-'));
  fs.symlinkSync(expect, path.join(bin, 'expect'));
  const sinClaude = correr(bin);
  assert.notEqual(sinClaude.status, 0, sinClaude.stdout + sinClaude.stderr);
  assert.match(sinClaude.stdout + sinClaude.stderr, /NO MEDIDO: no hay claude/);
  assert.doesNotMatch(sinClaude.stdout + sinClaude.stderr, /\bVERDE\b/);
});

// Un `claude` de juguete que se porta como el 2.1.312: dibuja el menú de confianza con saltos del cursor, le pregunta a
// la terminal quién es en la misma tanda y no lee teclas hasta la respuesta; después muestra la ventana y, con Enter,
// corre el `touch` del pedido.
const CLAUDE_DE_JUGUETE = `#!${process.execPath}
const fs = require('fs');
const pedido = process.argv[process.argv.length - 1];
const archivo = (pedido.match(/touch (\\S+)/) || [])[1];
const S = '\\x1b[8G';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?1000h\\x1b[?1006h');
process.stdout.write(' No, exit\\r\\n Yes,' + S + 'I' + S + 'trust' + S + 'this' + S + 'folder\\r\\n Enter to confirm\\r\\n\\x1b[c');
let leido = '', estado = 'quien';
process.stdin.on('data', (d) => {
  leido += d.toString('latin1');
  if (estado === 'quien') {
    const fin = leido.search(/\\x1b\\[\\?[0-9;]*c/);
    if (fin < 0) return;
    estado = 'confianza';
    leido = leido.slice(leido.indexOf('c', fin) + 1);
  }
  if (estado === 'confianza') {
    const abajo = leido.indexOf('\\x1b[B');
    if (abajo < 0 || leido.indexOf('\\r', abajo) < 0) return;
    estado = 'ventana'; leido = '';
    process.stdout.write('Do' + S + 'you' + S + 'want' + S + 'to' + S + 'proceed?\\r\\n');
    return;
  }
  if (estado === 'ventana' && leido.length) {
    if (leido.startsWith('\\r') && archivo) fs.writeFileSync(archivo, '');
    estado = 'fin';
  }
  if (leido.includes('\\x03')) process.exit(0);
});
`;

// AskWindowProbe_ClaudeQuePreguntaALaTerminal_Verde
// 🔴 Falla con: la sonda que manda las teclas desde una función sin `-i` (le escriben a la terminal de quien la corre,
//    no a `claude`), o que contesta la pregunta a la terminal y pierde el menú dibujado en la misma tanda: se traba en
//    la pregunta de confianza y nunca llega a la ventana.
test('AskWindowProbe_ClaudeQuePreguntaALaTerminal_Verde @story-8.139 @ac-31 — pasa la confianza, llega a la ventana y mide Sí y No', (t) => {
  if (process.platform === 'win32') { t.skip('la sonda corre con sh y expect: no en Windows'); return; }
  const expect = spawnSync('/bin/sh', ['-c', 'command -v expect'], { encoding: 'utf8' }).stdout.trim();
  if (!expect) { t.diagnostic('esta máquina no tiene expect: el caso se mide donde lo haya'); return; }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-bin-'));
  fs.symlinkSync(expect, path.join(bin, 'expect'));
  fs.writeFileSync(path.join(bin, 'claude'), CLAUDE_DE_JUGUETE, { mode: 0o755 });
  const r = spawnSync('/bin/sh', [SONDA], {
    env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'awp-home-')), PATH: `${bin}:/usr/bin:/bin`, USER: 'prueba', ASK_WINDOW_PROBE_WAIT: '3' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERDE/);
  assertTerminalRestaurada(r.stdout);
});

// Lo que `claude` escribe pasa a la terminal de quien corre la sonda: si prende el seguimiento del mouse y la sesión se
// corta antes de que lo apague, cada movimiento escribe secuencias en el prompt. Después del último encendido tienen que
// venir los apagados de los modos del mouse y del pegado entre corchetes, y el cursor visible.
function assertTerminalRestaurada(salida) {
  const desde = salida.lastIndexOf('\x1b[?1000h');
  assert.ok(desde >= 0, 'el claude de juguete no prendió el mouse: la prueba no mide nada');
  const despues = salida.slice(desde);
  for (const modo of ['1000', '1002', '1003', '1006', '1015', '2004']) assert.ok(despues.includes(`\x1b[?${modo}l`), `falta apagar el modo ${modo} al salir`);
  assert.ok(despues.includes('\x1b[?25h'), 'falta volver a mostrar el cursor al salir');
}

// Un `claude` que prende el mouse y después sale enseguida («exit») o se queda colgado sin mostrar nada («hang»).
const CLAUDE_QUE_PRENDE_EL_MOUSE = `#!${process.execPath}
process.stdout.write('\\x1b[?1000h\\x1b[?1003h\\x1b[?1006h');
if (process.env.FAKE_CLAUDE_MODE === 'exit') process.exit(0);
setInterval(() => {}, 1000);
`;

function binConClaude(expect, fuente) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-bin-'));
  fs.symlinkSync(expect, path.join(bin, 'expect'));
  fs.writeFileSync(path.join(bin, 'claude'), fuente, { mode: 0o755 });
  return bin;
}

// AskWindowProbe_RestauraLaTerminal_AlSalirConFalla
// 🔴 Falla con: una sonda que restaura el modo de la terminal sólo cuando termina en verde: la que sale por «NO MEDIDO»
//    deja el mouse prendido en la terminal de la persona.
test('AskWindowProbe_RestauraLaTerminal_AlSalirConFalla — «NO MEDIDO» también apaga el seguimiento del mouse', (t) => {
  if (process.platform === 'win32') { t.skip('la sonda corre con sh y expect: no en Windows'); return; }
  const expect = spawnSync('/bin/sh', ['-c', 'command -v expect'], { encoding: 'utf8' }).stdout.trim();
  if (!expect) { t.diagnostic('esta máquina no tiene expect: el caso se mide donde lo haya'); return; }
  const r = spawnSync('/bin/sh', [SONDA], {
    env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'awp-home-')), PATH: `${binConClaude(expect, CLAUDE_QUE_PRENDE_EL_MOUSE)}:/usr/bin:/bin`, USER: 'prueba', FAKE_CLAUDE_MODE: 'exit' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /NO MEDIDO/);
  assertTerminalRestaurada(r.stdout);
});

// AskWindowProbe_RestauraLaTerminal_AlCortarla
// 🔴 Falla con: una sonda que, cortada con una señal (la persona la interrumpe, o la terminal se cierra), sale sin
//    pasar por la restauración.
test('AskWindowProbe_RestauraLaTerminal_AlCortarla — cortada con una señal, también apaga el seguimiento del mouse', async (t) => {
  if (process.platform === 'win32') { t.skip('la sonda corre con sh y expect: no en Windows'); return; }
  const expect = spawnSync('/bin/sh', ['-c', 'command -v expect'], { encoding: 'utf8' }).stdout.trim();
  if (!expect) { t.diagnostic('esta máquina no tiene expect: el caso se mide donde lo haya'); return; }
  const { spawn } = require('child_process');
  const p = spawn('/bin/sh', [SONDA], {
    env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'awp-home-')), PATH: `${binConClaude(expect, CLAUDE_QUE_PRENDE_EL_MOUSE)}:/usr/bin:/bin`, USER: 'prueba', FAKE_CLAUDE_MODE: 'hang' },
  });
  let salida = '';
  const fin = new Promise((resolve) => p.on('close', resolve));
  p.stdout.on('data', (d) => {
    salida += d.toString('latin1');
    if (salida.includes('\x1b[?1000h')) p.kill('SIGTERM');
  });
  const corte = setTimeout(() => p.kill('SIGKILL'), 30000);
  await fin;
  clearTimeout(corte);
  assertTerminalRestaurada(salida);
});
