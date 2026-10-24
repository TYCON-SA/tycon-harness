'use strict';

/**
 * machine-id.test.js — la huella de la máquina y la casa de la cuenta.
 *
 * La firma por delegación vale sólo en las máquinas que la organización eligió. Para reconocerlas hace falta algo que
 * el agente no pueda reescribir: el id del sistema (IOPlatformUUID en Mac, MachineGuid en Windows, /etc/machine-id en
 * Linux), leído por su ruta fija y guardado como resumen. Lo mismo con la casa de la cuenta: sale de la base de
 * usuarios del sistema, no de `HOME`, que el agente puede cambiar.
 *
 * Las fuentes se inyectan como parámetros, en proceso: ninguna variable del ambiente elige qué se lee.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const MID = path.join(SCRIPTS, 'lib', 'machine-id.js');
const CASA = path.join(SCRIPTS, 'lib', 'real-home.js');
const mid = () => require(MID);
const esperada = (valor) => crypto.createHash('sha256').update(`tycon-machine:v1:${valor}`).digest('hex').slice(0, 16);

const IOREG = '| |   "IOPlatformSerialNumber" = "C0FFEE"\n    "IOPlatformUUID" = "1A2B3C4D-0000-1111-2222-ABCDEFABCDEF"\n';
const REG = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    5f1e2d3c-aaaa-bbbb-cccc-0123456789ab\r\n\r\n';

/** Un ejecutor que anota con qué lo llamaron y devuelve la salida del caso. */
function ejecutorFalso(salida) {
  const llamadas = [];
  const ejecutar = (cmd, args, opts) => { llamadas.push({ cmd, args, opts }); if (salida instanceof Error) throw salida; return salida; };
  return { ejecutar, llamadas };
}

// T24 MachineId_TresSistemas_HuellaYFuente @story-8.116 @ac-24
// 🔴 Falla con: una huella que no es el resumen fijo del id normalizado, o una fuente ilegible que devuelve algo.
test('8.116 T24 MachineId_TresSistemas_HuellaYFuente', () => {
  const mac = ejecutorFalso(IOREG);
  let r = mid().huella({ platform: 'darwin', ejecutar: mac.ejecutar });
  assert.deepStrictEqual(r, { huella: esperada('1a2b3c4d-0000-1111-2222-abcdefabcdef'), fuente: '/usr/sbin/ioreg IOPlatformUUID' });
  assert.match(r.huella, /^[0-9a-f]{16}$/);
  const win = ejecutorFalso(REG);
  r = mid().huella({ platform: 'win32', ejecutar: win.ejecutar, existe: () => true });
  assert.deepStrictEqual(r, { huella: esperada('5f1e2d3c-aaaa-bbbb-cccc-0123456789ab'), fuente: 'C:\\Windows\\System32\\reg.exe MachineGuid' });
  r = mid().huella({ platform: 'linux', leer: (f) => (f === '/etc/machine-id' ? '0F1E2D3C4B5A69788796A5B4C3D2E1F0\n' : null) });
  assert.deepStrictEqual(r, { huella: esperada('0f1e2d3c4b5a69788796a5b4c3d2e1f0'), fuente: '/etc/machine-id' });
  const DBUS = 'aabbccddeeff00112233445566778899';
  r = mid().huella({ platform: 'linux', leer: (f) => (f === '/var/lib/dbus/machine-id' ? `${DBUS}\n` : null) });
  assert.deepStrictEqual(r, { huella: esperada(DBUS), fuente: '/var/lib/dbus/machine-id' });
  // un /etc/machine-id sin forma de id no da huella: se prueba el siguiente, y si ninguno sirve, el motivo de cada uno
  r = mid().huella({ platform: 'linux', leer: (f) => (f === '/etc/machine-id' ? 'uninitialized\n' : `${DBUS}\n`) });
  assert.deepStrictEqual(r, { huella: esperada(DBUS), fuente: '/var/lib/dbus/machine-id' });
  r = mid().huella({ platform: 'linux', leer: (f) => (f === '/etc/machine-id' ? { error: 'EACCES' } : '0'.repeat(32)) });
  assert.equal(r.huella, undefined);
  assert.match(r.error, /\/etc\/machine-id: EACCES/);
  assert.match(r.error, /\/var\/lib\/dbus\/machine-id: el id no tiene la forma/);
  // ilegible: sin huella y con el motivo
  for (const caso of [
    { platform: 'darwin', ejecutar: ejecutorFalso(new Error('no anda')).ejecutar },
    { platform: 'darwin', ejecutar: ejecutorFalso('sin el campo').ejecutar },
    { platform: 'darwin', ejecutar: ejecutorFalso('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"').ejecutar },
    { platform: 'darwin', ejecutar: ejecutorFalso('"IOPlatformUUID" = "no-es-un-uuid"').ejecutar },
    { platform: 'win32', ejecutar: ejecutorFalso(REG).ejecutar, existe: () => false },
    { platform: 'linux', leer: () => null },
    { platform: 'linux', leer: () => '   \n' },
    { platform: 'aix' },
  ]) {
    r = mid().huella(caso);
    assert.equal(r.huella, undefined, JSON.stringify(caso.platform));
    assert.ok(r.error, `${caso.platform}: dice el motivo`);
  }
  // la línea de comandos: una huella de 16 hex y su fuente, o sale 1
  const cli = spawnSync(process.execPath, [MID], { encoding: 'utf8' });
  if (cli.status === 0) {
    const o = JSON.parse(cli.stdout);
    assert.match(o.huella, /^[0-9a-f]{16}$/);
    assert.ok(o.fuente);
  } else {
    assert.equal(cli.status, 1, cli.stderr);
    assert.doesNotMatch(cli.stdout, /[0-9a-f]{16}/);
  }
});

// T25 MachineId_IgnoraPathYAmbiente @story-8.116 @ac-24
// 🔴 Falla con: el programa buscado en el PATH, la ruta de Windows armada con SystemRoot, o el hijo con el ambiente.
test('8.116 T25 MachineId_IgnoraPathYAmbiente', (t) => {
  const mac = ejecutorFalso(IOREG);
  mid().huella({ platform: 'darwin', ejecutar: mac.ejecutar });
  assert.equal(mac.llamadas[0].cmd, '/usr/sbin/ioreg');
  const win = ejecutorFalso(REG);
  const viejo = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Otro';
  t.after(() => { if (viejo === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = viejo; });
  mid().huella({ platform: 'win32', ejecutar: win.ejecutar, existe: () => true });
  assert.equal(win.llamadas[0].cmd, 'C:\\Windows\\System32\\reg.exe', 'la ruta fija, no la de SystemRoot');
  // el ejecutor real corre al hijo con el ambiente vacío
  assert.deepStrictEqual(mid().opcionesDelHijo().env, {});
  // la línea de comandos con un `ioreg` falso primero en el PATH: la huella no cambia
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-path-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const nombre of ['ioreg', 'reg', 'reg.exe']) fs.writeFileSync(path.join(bin, nombre), '#!/bin/sh\necho \'"IOPlatformUUID" = "FALSO"\'\n', { mode: 0o755 });
  const limpia = spawnSync(process.execPath, [MID], { encoding: 'utf8' });
  const sucia = spawnSync(process.execPath, [MID], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SystemRoot: bin } });
  assert.equal(sucia.status, limpia.status);
  assert.equal(sucia.stdout, limpia.stdout, 'el PATH y SystemRoot no cambian la huella');
  if (limpia.status === 0) assert.notEqual(JSON.parse(sucia.stdout).huella, esperada('falso'));
});

// T26 MachineId_NuncaGuardaElValorCrudo @story-8.116 @ac-24
// 🔴 Falla con: el id del sistema impreso o devuelto tal cual.
test('8.116 T26 MachineId_NuncaGuardaElValorCrudo', () => {
  const r = mid().huella({ platform: 'darwin', ejecutar: ejecutorFalso(IOREG).ejecutar });
  const todo = JSON.stringify(r).toLowerCase();
  assert.ok(!todo.includes('1a2b3c4d'), 'ni un pedazo del valor crudo');
  assert.ok(!todo.includes('c0ffee'));
  const cli = spawnSync(process.execPath, [MID], { encoding: 'utf8' });
  if (cli.status === 0) assert.deepStrictEqual(Object.keys(JSON.parse(cli.stdout)).sort(), ['fuente', 'huella']);
});

// T47 RealHome_IgnoraHomeYUserprofile @story-8.116 @ac-45
// 🔴 Falla con: la casa sacada de HOME o USERPROFILE, o un fallo que cae en os.homedir().
test('8.116 T47 RealHome_IgnoraHomeYUserprofile', (t) => {
  const { casaDeLaCuenta } = require(CASA);
  const viejos = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const falsa = fs.mkdtempSync(path.join(os.tmpdir(), 'casa-falsa-'));
  process.env.HOME = falsa; process.env.USERPROFILE = falsa;
  t.after(() => {
    for (const [k, v] of Object.entries(viejos)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(falsa, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), falsa, 'la prueba de verdad cambió HOME');
  assert.equal(casaDeLaCuenta(), os.userInfo().homedir);
  assert.notEqual(casaDeLaCuenta(), falsa);
  assert.throws(() => casaDeLaCuenta({ userInfo: () => { throw new Error('sin cuenta'); } }), /casa de la cuenta.*sin cuenta/);
  assert.throws(() => casaDeLaCuenta({ userInfo: () => ({ homedir: '' }) }), /casa de la cuenta/);
  assert.throws(() => casaDeLaCuenta({ userInfo: () => ({ homedir: 'relativa' }) }), /casa de la cuenta/);
});
