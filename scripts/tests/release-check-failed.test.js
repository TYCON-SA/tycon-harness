'use strict';
// release-check-failed.test.js — una máquina con una actualización que falló no está «al día».
//
// Lo que no se puede perder:
//   · con una versión que falló al instalarse (`state.failed`, más nueva que la instalada), la mirada que daría «al día»
//     —la punta todavía sin número, o con el mismo número en otro commit— dice la falla: qué versión, el motivo y la hora;
//   · el estado es el de «ya falló» (`skipped`), no `up_to_date`: ni `update --check` ni el arranque borran el aviso de
//     que la actualización viene fallando;
//   · una falla vieja (la versión que falló no es más nueva que la instalada) o una cortada (`interrupted`, que el
//     arranque reintenta solo) no cambian nada, y una mirada que no es «al día» tampoco.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));

const HINT = 'npx @tyconsa/harness@latest';
const src = { version: '2026.11.23.76' };
const pendiente = { status: 'up_to_date', code: 0, lines: ['arnés al día (2026.11.23.76; la punta de main, abc1234, recién entró y todavía no tiene su número: se baja cuando lo tenga)', 'una nota'] };
const fallo = { commit: '2026.11.24.42', sources: { harness: 'f'.repeat(40) }, at: '2026-11-24T13:59:12.345Z', reason: 'team-invalid' };

// 🔴 Falla con: la mirada que dice «arnés al día» con una actualización fallida en el estado.
test('T1 CheckConFalla_NoDiceAlDia — dice la versión, el motivo y la hora, y queda como «ya falló»', () => {
  const r = RL.failedNotUpToDate(pendiente, { failed: fallo }, src, HINT);
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(r.code, 0);
  assert.ok(!r.lines.some((l) => /al día/.test(l)), r.lines.join(' | '));
  assert.match(r.lines[0], /^la última actualización falló: la versión 2026\.11\.24\.42 no se instaló \(team-invalid\), a las 2026-11-24 13:59 UTC/);
  assert.match(r.lines[0], /npx @tyconsa\/harness@latest/);
  assert.ok(r.lines.includes('una nota'), 'las notas de la mirada siguen');
});

test('T2 CheckConFalla_MismoNumeroEnOtroCommit — tampoco dice «al día»', () => {
  const mismo = { status: 'up_to_date', code: 0, lines: ['arnés al día (2026.11.23.76; la punta de main tiene el mismo número en otro commit, abc1234)'] };
  const r = RL.failedNotUpToDate(mismo, { failed: fallo }, src, HINT);
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!r.lines.some((l) => /al día/.test(l)));
});

test('T3 CheckSinFallaQueCuente_NoCambia — sin falla, falla vieja, cortada, hora ilegible o mirada que no es «al día»', () => {
  assert.strictEqual(RL.failedNotUpToDate(pendiente, {}, src, HINT), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: null }, src, HINT), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: '2026.11.23.70' } }, src, HINT), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: '2026.11.23.76' } }, src, HINT), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, reason: 'interrupted' } }, src, HINT), pendiente);
  const nueva = { status: 'new', code: 3, lines: ['hay versión nueva'] };
  assert.strictEqual(RL.failedNotUpToDate(nueva, { failed: fallo }, src, HINT), nueva);
  // sin hora legible se dice igual, con un guion
  const sinHora = RL.failedNotUpToDate(pendiente, { failed: { ...fallo, at: null } }, src, HINT);
  assert.match(sinHora.lines[0], /a las —/);
  // un número que no se puede ordenar (una falla anotada con un commit) cuenta: se dice
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: 'a'.repeat(40) } }, src, HINT).status, 'skipped');
});
