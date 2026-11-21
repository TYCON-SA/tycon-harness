'use strict';
// hour-notice.test.js — el recordatorio de la hora de fin de una sesión sin ejecución abierta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hourNotice, REPEAT_MS } = require(path.join(__dirname, '..', 'lib', 'hour-notice.js'));

// stable-data: el aviso compara contra la fecha real de un archivo que escribe la prueba
const NOW = Date.now();
const state = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hour-notice-'));
  fs.mkdirSync(path.join(stateDir, 'doing'));
  fs.mkdirSync(path.join(stateDir, 'adhoc'));
  fs.mkdirSync(path.join(stateDir, 'sessions'));
  fs.writeFileSync(path.join(stateDir, 'sessions', 's1.json'), '{}');
  return stateDir;
};
const ask = (stateDir, extra = {}) => hourNotice({ stateDir, sessionId: 's1', markerJs: '/x/marker.js', env: {}, now: NOW, ...extra });
const note = (stateDir, body) => fs.writeFileSync(path.join(stateDir, 'doing', 's1.json'), JSON.stringify(body));
const iso = (ms) => new Date(ms).toISOString();

test('T1 Reminds_OnceEachHalfHour: la que no anotó su hora se entera de cómo, sin insistir en cada mensaje', () => {
  const dir = state();
  const text = ask(dir);
  assert.match(text, /no anotó a qué hora termina/);
  assert.match(text, /doing "<qué hago>" --until HH:MM/);
  assert.match(text, /--waiting-for/);
  assert.strictEqual(ask(dir), null, 'el mensaje siguiente no repite');
  assert.match(ask(dir, { now: NOW + REPEAT_MS + 60000 }), /no anotó/, 'pasada la media hora, sí');
});

test('T2 HasHour_NoNotice: con hora por delante, o esperando a otra, no dice nada', () => {
  const dir = state();
  note(dir, { text: 'mido algo', at: iso(NOW), endAt: iso(NOW + 3600000) });
  assert.strictEqual(ask(dir), null);
  note(dir, { text: 'mido algo', at: iso(NOW), waitingFor: 'lo de Beto', waitingSince: iso(NOW) });
  assert.strictEqual(ask(dir), null);
  const lane = state();
  fs.writeFileSync(path.join(lane, 'adhoc', 's1.json'), JSON.stringify({ reason: 'x', until: iso(NOW + 60000) }));
  assert.strictEqual(ask(lane), null, 'el arreglo rápido también puede traerla');
});

test('T5 RunOpen_NoNotice: con una ejecución abierta, la hora la da su paso', () => {
  const dir = state();
  fs.mkdirSync(path.join(dir, 'active'));
  fs.writeFileSync(path.join(dir, 'active', 's1.json'), '{}');
  assert.strictEqual(ask(dir), null);
});

test('T3 PastHour_Reminds: la hora que ya pasó no alcanza', () => {
  const dir = state();
  note(dir, { text: 'mido algo', at: iso(NOW - 7200000), endAt: iso(NOW - 3600000) });
  assert.match(ask(dir), /ya pasó/);
});

test('T4 Off_And_NoSession: se apaga, y sin saber qué sesión es no dice nada', () => {
  assert.strictEqual(ask(state(), { env: { TYCON_HOUR_NOTICE: '0' } }), null);
  assert.strictEqual(ask(state(), { sessionId: '_nosession' }), null);
  assert.strictEqual(ask(state(), { sessionId: null }), null);
});

test('T6 Hook_SaysIt_OnlyAKnownSession: el aviso de ejecución lo dice una vez, y a una sesión sin archivo de estado no le dice nada', () => {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hour-notice-hook-'));
  const run = (event) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'blocking-notice.js')], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_EVAL_SANDBOX: '', TYCON_HOUR_NOTICE: '', TYCON_STATE_DIR: '' } }).stdout;
  assert.strictEqual(run({ session_id: 's1' }), '', 'sin archivo de estado');
  const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  fs.mkdirSync(path.join(stateDir(home), 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'sessions', 's1.json'), '{}');
  assert.match(run({ session_id: 's1' }), /<system-reminder>\nhora: esta sesión no anotó/);
  assert.strictEqual(run({ session_id: 's1' }), '', 'una vez');
});
