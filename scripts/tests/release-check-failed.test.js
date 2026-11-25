'use strict';
// release-check-failed.test.js — una máquina con una actualización que falló no está «al día».
//
// Lo que no se puede perder:
//   · con una versión que falló al instalarse (`state.failed`, más nueva que la instalada), la mirada que daría «al día»
//     —la punta todavía sin número, o con el mismo número en otro commit— dice la falla: qué versión, el motivo y la hora;
//   · el estado es el de «ya falló» (`skipped`), no `up_to_date`: ni `update --check` ni el arranque borran el aviso de
//     que la actualización viene fallando;
//   · se decide después del refresco de la capa del equipo: con otra punta del equipo la falla se borró y no se dice;
//   · una falla vieja (la versión que falló no es más nueva que la instalada) o una cortada (`interrupted`, que el
//     arranque reintenta solo) no cambian nada, y una mirada que no es «al día» tampoco.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js'));
const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
const HTTP = require(path.join(ROOT, 'scripts', 'lib', 'http-get.js'));

const src = { version: '2026.11.23.76' };
const pendiente = { status: 'up_to_date', code: 0, lines: ['arnés al día (2026.11.23.76; la punta de main, abc1234, recién entró y todavía no tiene su número: se baja cuando lo tenga)', 'una nota'] };
const fallo = { commit: '2026.11.24.42', sources: { harness: 'f'.repeat(40) }, at: '2026-11-24T13:59:12.345Z', reason: 'team-invalid' };

// 🔴 Falla con: la mirada que dice «arnés al día» con una actualización fallida en el estado.
test('T1 CheckConFalla_NoDiceAlDia — dice la versión, el motivo y la hora, y queda como «ya falló»', () => {
  const r = RL.failedNotUpToDate({ ...pendiente, team: { status: 'same' } }, { failed: fallo }, src);
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(r.code, 0);
  assert.ok(!r.lines.some((l) => /al día/.test(l)), r.lines.join(' | '));
  assert.match(r.lines[0], /^la última actualización falló: la versión 2026\.11\.24\.42 no se instaló \(team-invalid\), a las 2026-11-24 13:59 UTC; la máquina sigue en 2026\.11\.23\.76/);
  assert.ok(r.lines.includes('una nota'), 'las notas de la mirada siguen');
  assert.deepStrictEqual(r.team, { status: 'same' }, 'el resultado de la capa del equipo sigue');
});

test('T2 CheckConFalla_MismoNumeroEnOtroCommit — tampoco dice «al día»', () => {
  const mismo = { status: 'up_to_date', code: 0, lines: ['arnés al día (2026.11.23.76; la punta de main tiene el mismo número en otro commit, abc1234)'] };
  const r = RL.failedNotUpToDate(mismo, { failed: fallo }, src);
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!r.lines.some((l) => /al día/.test(l)));
});

test('T3 CheckSinFallaQueCuente_NoCambia — sin falla, falla vieja, cortada, hora ilegible o mirada que no es «al día»', () => {
  assert.strictEqual(RL.failedNotUpToDate(pendiente, {}, src), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: null }, src), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: '2026.11.23.70' } }, src), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: '2026.11.23.76' } }, src), pendiente);
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, reason: 'interrupted' } }, src), pendiente);
  const nueva = { status: 'new', code: 3, lines: ['hay versión nueva'] };
  assert.strictEqual(RL.failedNotUpToDate(nueva, { failed: fallo }, src), nueva);
  // sin hora legible se dice igual, con un guion
  const sinHora = RL.failedNotUpToDate(pendiente, { failed: { ...fallo, at: null } }, src);
  assert.match(sinHora.lines[0], /a las —/);
  // un número que no se puede ordenar (una falla anotada con un commit) cuenta: se dice
  assert.strictEqual(RL.failedNotUpToDate(pendiente, { failed: { ...fallo, commit: 'a'.repeat(40) } }, src).status, 'skipped');
});

// ── update() de verdad, con la red de mentira: la punta de main recién entró y no tiene su etiqueta ──────────────────
const INST = '1'.repeat(40);
const FALLIDA = '2'.repeat(40);
const PUNTA = '3'.repeat(40);
const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
const infoRefs = () => Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${PUNTA} refs/heads/main\n`)}${pkt(`${INST} refs/tags/v2026.11.23.76\n`)}${pkt(`${FALLIDA} refs/tags/v2026.11.24.42\n`)}0000`, 'latin1');

function laboratorio(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-failed-'));
  const getSync = HTTP.getSync;
  const openSource = TEAM.openSource;
  t.after(() => { HTTP.getSync = getSync; TEAM.openSource = openSource; fs.rmSync(home, { recursive: true, force: true }); });
  HTTP.getSync = (url) => {
    if (/info\/refs/.test(url)) return { ok: true, status: 200, headers: {}, body: infoRefs(), url };
    if (url.includes(`/${PUNTA}/version.json`)) return { ok: true, status: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2026.11.20.1', numbering: 'merge-tag' })), url };
    return { ok: true, status: 404, headers: {}, body: Buffer.alloc(0), url };
  };
  const env = { HOME: home, TYCON_HOME: path.join(home, '.tycon'), PATH: process.env.PATH,
    TYCON_RELEASE_GIT: 'http://git.invalid', TYCON_RELEASE_RAW: 'http://raw.invalid', TYCON_RELEASE_ARCHIVE: 'http://codeload.invalid' };
  const state = {
    sources: [{ kind: 'release', repo: 'o/n', url: 'https://github.com/o/n', ref: 'main', commit: INST, version: '2026.11.23.76' }],
    version: { number: '2026.11.23.76' }, channel: 'stable', mode: 'managed',
    failed: { commit: '2026.11.24.42', sources: { harness: FALLIDA }, at: '2026-11-24T13:59:12.345Z', reason: 'team-invalid', team_commit: 'a'.repeat(40) },
    team: { repo: 'o/team' },
  };
  const H = { releaseApplyHint: 'npx @tyconsa/harness@latest', REEVALUATED_NOTICE: /^$x/, availableText: () => 'hay nueva',
    policyOf: () => ({ errors: [], enabled: true, apply: 'auto', channel: 'stable' }), applyPolicy: () => ({}) };
  return { home, ctx: { home, env, opts: {} }, state, H };
}

// 🔴 Falla con: update() que no pasa su mirada por la falla anotada (la función suelta anda, pero nadie la llama).
test('T4 UpdateCheck_PuntaSinNumero_ConFalla_NoDiceAlDiaNiBorraLaFalla — el camino de verdad, con la red de mentira', (t) => {
  const L = laboratorio(t);
  const u = RL.update(L.ctx, L.state, L.H, { mode: 'check' });
  assert.strictEqual(u.status, 'skipped', u.lines.join(' | '));
  assert.ok(!u.lines.some((l) => /al día/.test(l)), u.lines.join(' | '));
  assert.match(u.lines[0], /la última actualización falló: la versión 2026\.11\.24\.42/);
  // `update --check` a mano no borra el aviso de que la actualización viene fallando
  R.recordUpdateFailure(L.home, 'team-invalid: tres arranques');
  const c = RL.cmdUpdate({ ...L.ctx, opts: { check: true } }, L.state, L.H, { log: () => {} });
  assert.ok(!c.lines.some((l) => /al día/.test(l)), c.lines.join(' | '));
  assert.ok(R.readUpdateFailure(L.home), 'la falla anotada sigue');
});

// 🔴 Falla con: decidir antes del refresco de la capa: con otra punta del equipo la falla ya se borró y la versión se
// vuelve a mirar, pero la salida diría «falló» y no borraría el aviso.
test('T5 UpdateConOtraPuntaDelEquipo_LaFallaSeBorra_NoSeDice — se decide con lo que dejó el refresco', (t) => {
  const L = laboratorio(t);
  TEAM.openSource = () => ({ ok: true, resolve: () => ({ ok: true, unchanged: true, commit: 'c'.repeat(40) }) });
  const u = RL.update(L.ctx, L.state, L.H, { mode: 'apply', teamRefresh: true });
  assert.strictEqual(L.state.failed, null, 'el refresco borró la falla');
  assert.strictEqual(u.status, 'up_to_date', u.lines.join(' | '));
  assert.ok(!u.lines.some((l) => /la última actualización falló/.test(l)), u.lines.join(' | '));
});

// 🔴 Falla con: doctorItems que llama a check() directo: «red: arnés al día» con la falla anotada (fila 213).
test('T6 DoctorFetch_ConFalla_NoDiceAlDia — la línea de la red dice la falla y queda como aviso', (t) => {
  const L = laboratorio(t);
  const items = RL.doctorItems(L.ctx, L.state, { fetch: true, channel: 'stable' });
  const red = items.find((i) => /^red: /.test(i.text));
  assert.ok(red, items.map((i) => i.text).join(' | '));
  assert.doesNotMatch(red.text, /al día/);
  assert.match(red.text, /la última actualización falló: la versión 2026\.11\.24\.42/);
  assert.strictEqual(red.level, 'warn');
  // sin falla anotada, sigue diciendo «al día» como antes
  const sin = RL.doctorItems(L.ctx, { ...L.state, failed: undefined }, { fetch: true, channel: 'stable' });
  const redSin = sin.find((i) => /^red: /.test(i.text));
  assert.match(redSin.text, /al día/);
  assert.strictEqual(redSin.level, 'ok');
});
