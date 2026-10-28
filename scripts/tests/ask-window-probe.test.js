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
