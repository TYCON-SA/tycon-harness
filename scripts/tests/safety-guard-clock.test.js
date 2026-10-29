#!/usr/bin/env node
'use strict';
// safety-guard-clock.test.js — el freno de seguridad tiene su propio reloj: si algo lo deja esperando, frena (sale 2)
// antes de que venza el tope de la herramienta. Con el tope de la herramienta vencido, el comando corre sin mirar:
// medido con Claude Code (un freno de juguete que dormía más que su tope dejó correr el comando; con tope holgado frenó).
// stable-data: lee el reloj sólo para medir cuánto tarda el freno; no depende de la fecha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'hooks', 'safety-guard-pre.sh');
const SKIP = process.platform === 'win32' && 'el jq de mentira es un guion sin .exe y Windows no lo lanza; el freno es el mismo guion, se mide en la Mac';

function binConJqLento(extra) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-clock-bin-'));
  // jq de juguete (safety-guard-clock.test.js): se queda esperando, y deja un nieto que también espera con la salida abierta
  fs.writeFileSync(path.join(bin, 'jq'), `#!/bin/sh\n${extra || ''}\nsleep 30\n`, { mode: 0o755 });
  return bin;
}

function correr(command, { bin, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-clock-home-'));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'sg-clock', cwd: os.tmpdir() });
  const t0 = Date.now();
  const r = spawnSync('bash', [GUARD], {
    input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH, ...env },
  });
  return { ...r, ms: Date.now() - t0 };
}

test('SafetyGuardClock_StuckReader_Blocks — un freno que se queda esperando frena a su tope, no deja pasar', { skip: SKIP }, () => {
  // 🔴 rojo si: el freno no tiene reloj → espera los 30 s del jq y la herramienta, con su tope vencido, corre el comando.
  const r = correr('ls', { bin: binConJqLento(), env: { TYCON_SAFETY_TIMEOUT_S: '2' } });
  assert.strictEqual(r.status, 2, `salió ${r.status} en ${r.ms} ms\n${r.stderr}`);
  assert.match(r.stderr, /no terminó de mirar el comando en 2 s/);
  assert.ok(r.ms < 15000, `tardó ${r.ms} ms`);
});

test('SafetyGuardClock_GrandchildHoldsOutput_IsCut — un nieto colgado con la salida abierta no estira la espera', { skip: SKIP }, () => {
  // 🔴 rojo si: sólo se mata al hijo → el nieto sigue con la salida del freno abierta y la herramienta espera hasta su tope.
  const r = correr('ls', { bin: binConJqLento('sleep 30 &'), env: { TYCON_SAFETY_TIMEOUT_S: '2' } });
  assert.strictEqual(r.status, 2, `salió ${r.status} en ${r.ms} ms\n${r.stderr}`);
  assert.ok(r.ms < 15000, `tardó ${r.ms} ms: algo dejó la salida abierta`);
});

test('SafetyGuardClock_NormalCommand_DoesNotWait — un comando común pasa enseguida: el reloj no deja la salida abierta', { skip: SKIP }, () => {
  // 🔴 rojo si: el reloj queda con la salida del freno abierta → cada comando espera el tope entero.
  const r = correr('ls', { env: { TYCON_SAFETY_TIMEOUT_S: '20' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.ms < 10000, `tardó ${r.ms} ms`);
  const bloqueo = correr('rm -rf /', { env: { TYCON_SAFETY_TIMEOUT_S: '20' } });
  assert.strictEqual(bloqueo.status, 2, 'el freno dejó de frenar lo de siempre');
});

test('SafetyGuardClock_BadValue_UsesDefault — un tope fuera de rango usa el de fábrica', { skip: SKIP }, () => {
  // 🔴 rojo si: un tope de 0 o enorme se acepta → el reloj no corta nunca o corta todo.
  for (const v of ['0', '9999', 'abc']) {
    const r = correr('ls', { env: { TYCON_SAFETY_TIMEOUT_S: v } });
    assert.strictEqual(r.status, 0, `${v}: ${r.stderr}`);
  }
});

test('SafetyGuardClock_LeadingZero_UsesDefault — «02» o «060» no se leen como segundos', { skip: SKIP }, () => {
  // 🔴 rojo si: un cero adelante pasa el rango → la cuenta falla o lee base 8 y el vigía espera otra cosa que la pedida.
  const r = correr('ls', { bin: binConJqLento(), env: { TYCON_SAFETY_TIMEOUT_S: '02' } });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no terminó de mirar el comando en 20 s/);
});