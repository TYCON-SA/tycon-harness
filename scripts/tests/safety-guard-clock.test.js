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

test('T5 SafetyGuardClock_SaysWhatItWasDoingAndTheWayOut — el corte dice en qué estaba y cómo seguir', { skip: SKIP }, () => {
  // 🔴 rojo si: el corte sólo dice «algo deja esperando al freno», sin qué estaba haciendo ni qué hacer.
  const r = correr('ls', { bin: binConJqLento('printf "confirmando el click en una conversación de 20 MB" > "$TYCON_SAFETY_STAGE_FILE"'), env: { TYCON_SAFETY_TIMEOUT_S: '2' } });
  assert.strictEqual(r.status, 2, `salió ${r.status} en ${r.ms} ms\n${r.stderr}`);
  assert.match(r.stderr, /Estaba confirmando el click en una conversación de 20 MB/);
  assert.match(r.stderr, /TYCON_SAFETY_TIMEOUT_S/, 'la salida: subir el tope');
  assert.match(r.stderr, /sesión nueva/, 'o una sesión nueva');
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
/** El registro de fallas de la casa de prueba (la carpeta del estado depende de la casa), o '' si no hay. */
function registroDe(home) {
  const hallados = [];
  const buscar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) buscar(p); else if (e.name === 'hook-errors.log') hallados.push(p); } };
  buscar(home);
  return hallados.map((p) => fs.readFileSync(p, 'utf8')).join('');
}

function correrEnCasa(command, { bin, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-clock-home-'));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'sg-clock', cwd: os.tmpdir() });
  const r = spawnSync('bash', [GUARD], {
    input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH, ...env },
  });
  return { ...r, registro: registroDe(home) };
}

test('T6 SafetyGuardClock_SlowOrCut_LogsWhereItWas — el freno lento o cortado deja en el registro cuánto tardó y en qué paso', { skip: SKIP }, () => {
  // 🔴 rojo si: un freno que tarda más de la mitad de su reloj no deja rastro, o el corte sólo lo dice en la pantalla.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-clock-bin-'));
  // jq de juguete: la primera vez tarda 3 s y falla (el freno sigue con node); las demás, falla enseguida
  fs.writeFileSync(path.join(bin, 'jq'), `#!/bin/sh\nif [ ! -e "${bin}/ya" ]; then : > "${bin}/ya"; sleep 3; fi\nexit 1\n`, { mode: 0o755 });
  const lento = correrEnCasa('ls', { bin, env: { TYCON_SAFETY_TIMEOUT_S: '5' } });
  assert.strictEqual(lento.status, 0, lento.stderr);
  assert.match(lento.registro, /^\[[^\]]+\] safety-guard LENTO: tardó [3-4] s, con un tope de 5 s; el paso más lento: leyendo la entrada \([3-4] s\)\n/);
  const cortado = correrEnCasa('ls', { bin: binConJqLento('printf "confirmando el click en una conversación de 20 MB" > "$TYCON_SAFETY_STAGE_FILE"'), env: { TYCON_SAFETY_TIMEOUT_S: '2' } });
  assert.strictEqual(cortado.status, 2, cortado.stderr);
  assert.match(cortado.registro, /safety-guard FRENÓ POR FALLA: no terminó en 2 s; estaba confirmando el click en una conversación de 20 MB/);
  assert.doesNotMatch(cortado.registro, /LENTO/, 'el corte no se anota dos veces');
  const rapido = correrEnCasa('ls', { env: { TYCON_SAFETY_TIMEOUT_S: '20' } });
  assert.strictEqual(rapido.status, 0, rapido.stderr);
  assert.strictEqual(rapido.registro, '', 'uno rápido no deja renglón');
});
