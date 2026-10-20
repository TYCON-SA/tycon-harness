'use strict';
// windows-stuck-update.test.js — una actualización trabada por un archivo tomado dice qué hacer; el registro del buzón trae el
// sistema de la máquina; la guía de Windows tiene la salida. Hogares de juguete en carpetas temporales; sin red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js'));

const held = { since: '2026-10-14T12:49:56.000Z', count: 26, kind: 'update', last: '2026-10-20T09:00:00.000Z',
  reason: 'no pude apartar la versión activa (EPERM: C:\\Users\\usuario\\.tycon\\harness → C:\\Users\\usuario\\.tycon\\previous): un archivo está tomado; la actualización espera al próximo arranque' };

test('T1 UpdateFailure_HeldFile_SaysWhatToDo @story-8.79 @ac-1: un archivo tomado dice qué cerrar y qué correr', () => {
  const t = R.updateFailureText(held);
  assert.match(t, /no se pudo actualizar desde 2026-10-14/);
  for (const words of ['VS Code', 'agente', 'terminales', 'npx @tyconsa/harness@latest', 'reinici']) assert.ok(t.includes(words), `falta «${words}»: ${t}`);
  // también con los otros códigos de un archivo tomado
  for (const code of ['EBUSY', 'EACCES']) assert.match(R.updateFailureText({ ...held, reason: `no pude apartar la versión activa (${code})` }), /npx @tyconsa\/harness@latest/);
});

test('T2 UpdateFailure_OtherReason_Unchanged @story-8.79 @ac-2: otro motivo queda como hoy, sin los pasos', () => {
  const t = R.updateFailureText({ since: '2026-10-06T10:00:00.000Z', count: 3, reason: 'sin red', kind: 'update' });
  assert.strictEqual(t, 'no se pudo actualizar desde 2026-10-06T10:00:00.000Z (3 arranques): sin red — harness.js doctor lo detalla');
  assert.strictEqual(R.updateFailureText({ ...held, count: 1 }), null, 'con un solo arranque fallido no se dice nada');
});

test('T3 PlaceFacts_HasPlatform @story-8.79 @ac-3: el registro del buzón trae el sistema de la máquina', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-home-'));
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const st = stateDir(home);
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'harness-state.json'), JSON.stringify({ mode: 'managed', version: { number: '2026.10.20.1' } }));
  const old = process.env.HOME; const oldUp = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const U = require(path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js'));
    const facts = U.placeFactsForMailbox('2026-10-20');
    assert.ok(facts, 'sin registro');
    assert.strictEqual(facts.platform, process.platform);
  } finally { process.env.HOME = old; if (oldUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUp; }
});

test('T5 InstallSuccess_ClearsOldFailure @story-8.79 @ac-5: una instalación que sale bien borra el aviso viejo', () => {
  const fs2 = require('fs');
  for (const file of ['scripts/setup/harness/release.js', 'scripts/setup/harness.js']) {
    const src = fs2.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, /una instalación que salió bien deja la máquina al día[\s\S]{0,200}clearUpdateFailure\(ctx\.home\)/, file);
  }
  // y el efecto: una falla anotada se borra con clearUpdateFailure
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-clear-'));
  R.recordUpdateFailure(home, 'no pude apartar la versión activa (EPERM)');
  R.recordUpdateFailure(home, 'no pude apartar la versión activa (EPERM)');
  assert.ok(R.updateFailureText(R.readUpdateFailure(home)));
  R.clearUpdateFailure(home);
  assert.strictEqual(R.readUpdateFailure(home), null);
});

test('T6 HarnessNode_HeldRename_RetriesThenSaysWhatToDo @story-8.79 @ac-6: el Node propio espera al archivo tomado y, si sigue, dice qué hacer', () => {
  const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
  const err = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  const twice = HN.renameWaiting('a', 'b', { rename: () => { calls += 1; if (calls < 3) throw err('EPERM'); }, sleep: () => {}, waitsMs: [1, 1, 1] });
  assert.deepStrictEqual([twice.ok, calls], [true, 3], 'reintenta y sale bien');
  const always = HN.renameWaiting('a', 'b', { rename: () => { throw err('EPERM'); }, sleep: () => {}, waitsMs: [1, 1] });
  assert.strictEqual(always.ok, false);
  assert.match(always.reason, /archivo está tomado.*npx @tyconsa\/harness@latest/);
  const other = HN.renameWaiting('a', 'b', { rename: () => { throw err('ENOSPC'); }, sleep: () => { throw new Error('no espera'); }, waitsMs: [1] });
  assert.strictEqual(other.ok, false);
  assert.doesNotMatch(other.reason, /npx/, 'otro error no reintenta ni da los pasos');
});

test('T4 WindowsGuide_StuckUpdateSection @story-8.79 @ac-4: la guía de Windows tiene la salida', () => {
  const g = fs.readFileSync(path.join(ROOT, 'getting-started', 'windows.md'), 'utf8');
  assert.match(g, /## Si el arnés no se actualiza/);
  const sec = g.split('## Si el arnés no se actualiza')[1].split('\n## ')[0];
  for (const words of ['npx @tyconsa/harness@latest', 'VS Code', 'Inicio', 'reinici', 'EPERM']) assert.ok(sec.includes(words), `falta «${words}»`);
});
