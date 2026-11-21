#!/usr/bin/env node
'use strict';
/**
 * atdd-skip.test.js — saltear «pruebas primero» pide la firma del dueño (`atdd-skip`, lib/atdd-skip.js).
 *
 *   T4 NoAtdd_PideFirma_YSinFirmaNoSaltea — sin firma no saltea ni con `--no-atdd`, ni con `set-flag atddBypass`, ni con
 *      una marca vieja, y dice cómo pedirla; con la firma de esta ejecución saltea, también en la segunda edición; la de
 *      otra ejecución no vale; desde una terminal sin sesión firma la ejecución de la muestra, y sin muestra no firma.
 *
 * Vive aparte de unit.test.js: esa suite tiene su lista de casos fija (scripts/tests/slow-suites-goal.test.js, T19).
 * Correr: node --test skills/tycon-pipeline/scripts/tests/atdd-skip.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const { fakeHomeEnv } = require(path.join(__dirname, 'lib', 'fake-home.js'));

function markerEnv(sid, fakeHome) {
  return { env: { ...process.env, ...fakeHomeEnv(fakeHome), CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' };
}
function writeFakeMarker(fakeHome, sid, extra) {
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const marker = {
    storyId: 'A', storyPath: 'specs/a.md', repoPath: '/tmp/repo', sessionId: sid,
    startedAt: '2026-07-30T10:00:00.000Z', lastTouch: '2026-07-30T10:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5], filesTouched: [], iterations: {}, fileEvents: [],
    ...extra,
  };
  fs.writeFileSync(path.join(activeDir, `${sid}.json`), JSON.stringify(marker));
  return marker;
}

// 🔴 Falla con: un escape de pruebas primero que el agente toma sin la firma del dueño, una marca vieja que saltea sin
// firma, o una firma que vale para otra ejecución.
test('T4 NoAtdd_PideFirma_YSinFirmaNoSaltea @story-8.283 @ac-7 @ac-8', (t) => {
  const sk = require('../lib/atdd-skip.js');
  const lab = require('./lib/atdd-skip-lab.js');
  const { SIGNATURES } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-firma-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const SID = 'atdd-firma';
  const stateDir = path.join(casa, '.claude', '.tycon-pipeline');
  const markerPath = path.join(stateDir, 'active', `${SID}.json`);
  const repo = path.join(casa, 'repo');
  const storyPath = path.join(repo, 'specs', 's.md');
  fs.mkdirSync(path.dirname(storyPath), { recursive: true });
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\nfiles_to_modify:\n  - src/a.cs\n---\n\n### Tests\n\n| T-ID | AC |\n');
  const EJECUCION = '2026-11-15T10:00:00.000Z';
  const carpeta = path.join(repo, '.advisors', 'pipeline-runs', '9.9-uno');
  fs.mkdirSync(carpeta, { recursive: true });
  const base = { storyId: '9.9', storyPath, repoPath: repo, stepScheme: 2, startedAt: EJECUCION, runDir: carpeta,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement'],
    fileEvents: [{ path: path.join(repo, 'src', 'a.cs'), ts: '2026-11-15T10:01:00.000Z' },
      { path: path.join(repo, 'tests', 'ATests.cs'), ts: '2026-11-15T10:02:00.000Z' }] };
  const correr = (args) => require('node:child_process').spawnSync(process.execPath, [MARKER, ...args], markerEnv(SID, casa));

  // la firma está en el catálogo, como las demás excepciones: nivel 2, con su comando de terminal y su «si sale mal»
  const s = SIGNATURES.find((x) => x.id === 'atdd-skip');
  assert.ok(s, 'atdd-skip en el catálogo');
  assert.strictEqual(s.level, 2);
  assert.match(s.command, /sign-atdd-skip/);
  assert.match(s.terminal, /--terminal/);
  assert.ok(s.ifWrong, 'con su «si sale mal»');

  // sin firma, por subproceso: --no-atdd no saltea, set-flag se niega y una marca vieja no saltea
  writeFakeMarker(casa, SID, base);
  const noAtdd = correr(['complete-step', 'implement', '--no-atdd', '--reason', 'refactor']);
  assert.notEqual(noAtdd.status, 0, '--no-atdd sin firma no saltea');
  assert.match(noAtdd.stderr, /sign-atdd-skip --story 9\.9/);
  const antes = fs.readFileSync(markerPath, 'utf8');
  const flag = correr(['set-flag', 'atddBypass', 'true', '--reason', 'refactor']);
  assert.strictEqual(flag.status, 2, flag.stderr);
  assert.match(flag.stderr, /sign-atdd-skip --story 9\.9/);
  assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), antes, 'set-flag sin firma no escribe');
  writeFakeMarker(casa, SID, { ...base, atddBypass: true, atddBypassReason: 'de antes del cambio' });
  const vieja = correr(['complete-step', 'implement']);
  assert.notEqual(vieja.status, 0, 'la marca vieja sin firma no saltea');
  assert.match(vieja.stderr, /sign-atdd-skip/);
  // --no-atdd cuando el freno no frena (la prueba antes del código): no pide firma
  writeFakeMarker(casa, SID, { ...base, fileEvents: [...base.fileEvents].reverse().map((e, i) => ({ ...e, ts: `2026-11-15T10:0${i + 1}:00.000Z` })) });
  const noHacia = correr(['complete-step', 'implement', '--no-atdd', '--reason', 'refactor']);
  assert.strictEqual(noHacia.status, 0, noHacia.stderr);

  // en proceso, con la casa de juguete: sin firma no saltea y anota la muestra
  const marker = { ...base, atddBypass: true, sessionId: SID };
  const d = sk.decidir({ marker, pide: true, camino: 'complete-step --no-atdd', casa });
  assert.strictEqual(d.saltea, false);
  assert.match(d.texto, /sign-atdd-skip --story 9\.9/);
  assert.ok(sk.ultimaMuestra({ story: '9.9', casa }), 'el pedido anotó la muestra');
  // con la firma de esta ejecución: saltea, también en la segunda edición (no se gasta)
  const f = lab.firmaDeJuguete({ casa, story: '9.9', carpeta, ejecucion: EJECUCION });
  assert.strictEqual(f.codigo, 0, f.motivo);
  assert.strictEqual(sk.decidir({ marker, pide: true, camino: 'on-atdd-preedit', casa }).saltea, true);
  assert.strictEqual(sk.decidir({ marker, pide: true, camino: 'on-atdd-preedit', casa }).saltea, true, 'la segunda edición también');
  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, fileEvents: [] }));
  const ed = (fp) => handler.handle({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: SID, tool_input: { file_path: fp } }, { stateDir, casa });
  assert.strictEqual(ed(path.join(repo, 'src', 'b.cs')), null, 'el portón previo deja pasar con la firma');
  assert.strictEqual(ed(path.join(repo, 'src', 'c.cs')), null, 'y en la segunda edición');
  // la firma de esta ejecución no vale para otra (otra hora de arranque, la misma carpeta)
  assert.strictEqual(sk.decidir({ marker: { ...marker, startedAt: '2026-11-15T12:00:00.000Z' }, pide: true, camino: 'x', casa }).saltea, false);

  // desde una terminal sin sesión ni marcador: la ejecución sale de la muestra
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-terminal-'));
  t.after(() => fs.rmSync(otra, { recursive: true, force: true }));
  const sinMuestra = sk.firmar({ story: '9.9', motivo: 'refactor', casa: otra, exigir: lab.exigirDeJuguete(otra, 'terminal'), aprobar: () => {} });
  assert.notStrictEqual(sinMuestra.codigo, 0, 'sin muestra no firma');
  assert.match(sinMuestra.motivo, /muestra/);
  sk.muestra({ story: '9.9', carpeta, ejecucion: '2026-11-15T13:00:00.000Z', camino: 'set-flag atddBypass', casa: otra });
  const enTerminal = sk.firmar({ story: '9.9', motivo: 'refactor', argv: ['--terminal'], casa: otra, exigir: lab.exigirDeJuguete(otra, 'terminal'), aprobar: () => {} });
  assert.strictEqual(enTerminal.codigo, 0, enTerminal.motivo);
  assert.strictEqual(enTerminal.linea.ejecucion, '2026-11-15T13:00:00.000Z', 'firmó la ejecución de la muestra');
  assert.strictEqual(sk.decidir({ marker: { ...marker, startedAt: '2026-11-15T13:00:00.000Z' }, pide: true, camino: 'x', casa: otra }).saltea, true, 'y la sesión la ve');
});
