#!/usr/bin/env node
/**
 * closing-evidence-codex.test.js — los cierres deciden con la evidencia del arnés, no con la conversación.
 *
 * El caso: Codex no deja leer la conversación. El chequeo de «historia afirmada sin story» salía con `null` antes de mirar
 * nada, el registro de revisores no sabía el modelo del implementador, y un modelo que narraba «cerré los hallazgos y el
 * commit» sin correrlos no dejaba ningún aviso. Ahora deciden el mensaje del evento de cierre, el marcador, el registro
 * de ediciones y el disco; la conversación, si existe, sólo suma.
 *
 * Todo con HOME temporal: el estado real no se toca.
 *
 * stable-data: las horas son relativas a ahora (el cierre anterior hace un minuto, una edición de hace dos) porque el
 * freno compara contra la hora real del cierre; las distancias quedan lejos de cualquier borde.
 *
 * 🔴 Mutaciones que los ponen en rojo: volver a salir sin conversación (T8), leer el modelo sólo de la conversación (T9),
 * sacar la línea de pasos pendientes o mostrarla sin afirmación de cierre (T10), cambiar el veredicto con conversación (T11).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const GATE = path.join(SCRIPTS, 'on-stop-dod-gate.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const SID = 'test-closing-evidence';

function mkEnv(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clev-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clev-repo-'));
  fs.mkdirSync(path.join(repo, 'specs'));
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'story-9.9.md');
  if (opts.marker !== false) {
    fs.writeFileSync(path.join(stateDir, 'active', `${SID}.json`), JSON.stringify({
      storyId: '9.9', storyPath, repoPath: repo, sessionId: SID, stepScheme: 2, startedAt: '2026-01-01T00:00:00.000Z',
      stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests'],
      stepsPending: ['reviewers', 'findings', 'prepare-commit'], filesTouched: [], fileEvents: [], checks: {},
      ...(opts.markerExtra || {}),
    }, null, 2));
  }
  if (opts.skillMark) {
    fs.mkdirSync(path.join(stateDir, 'skill-marks'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'skill-marks', `${SID}.json`), JSON.stringify({ skill: 'tycon-create-story', ts: new Date().toISOString(), cwd: repo }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; delete env.CODEX_SESSION_ID; delete env.CLAUDE_CONFIG_DIR;
  delete env.STOP_AUTONOMY; delete env.TYCON_PIPELINE_NO_AUTONOMOUS;
  return { home, repo, stateDir, storyPath, env };
}

const writeStory = (e) => fs.writeFileSync(e.storyPath, '---\nepic: 9\nstory: "9.9"\ntitle: "x"\nstatus: draft\n---\n# Story 9.9\n');

function stop(e, event) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: SID, cwd: e.repo, hook_event_name: 'Stop', ...event }), env: e.env, encoding: 'utf8', timeout: 30000 });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : null; } catch { out = { raw: r.stdout }; }
  return { status: r.status, out };
}

function gateLog(e) {
  const p = path.join(e.stateDir, 'gates.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
}

const codexEvent = (msg) => ({ turn_id: 'turn-1', model: 'gpt-5.6-luna', transcript_path: null, last_assistant_message: msg });

function claudeTranscript(e, msg, { writeTool } = {}) {
  const p = path.join(e.home, 'transcript.jsonl');
  const recs = [
    { type: 'user', message: { role: 'user', content: 'creá la historia 9.9' } },
    ...(writeTool ? [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: e.storyPath } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } },
    ] : []),
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: msg }] } },
  ];
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

test('ClaimCheck_NoTranscript_DecidesFromDiskAndMarker @story-8.97 @ac-5', () => {
  const e = mkEnv();
  const r = stop(e, codexEvent('He creado la historia specs/story-9.9.md y quedó lista.'));
  assert.ok(r.out && r.out.decision === 'block', `sin la historia en el disco tenía que frenar: ${JSON.stringify(r.out)}`);
  const linea = gateLog(e).filter((l) => l.name === 'story-claim-check').pop();
  assert.ok(linea && Array.isArray(linea.evidence) && linea.evidence.includes('marcador'), `el registro no dice de qué evidencia salió: ${JSON.stringify(linea)}`);

  writeStory(e);
  const r2 = stop(e, codexEvent('He creado la historia specs/story-9.9.md y quedó lista.'));
  assert.ok(!r2.out || r2.out.decision !== 'block', `con la historia escrita no tenía que frenar: ${JSON.stringify(r2.out)}`);

  // la historia que vino por el registro de ediciones, sin nombrarla en el mensaje ni en el marcador
  const e3 = mkEnv({ markerExtra: { storyPath: null } });
  writeStory(e3);
  fs.mkdirSync(path.join(e3.stateDir, 'file-events'), { recursive: true });
  // el turno arrancó en el cierre anterior; la historia se editó después
  fs.mkdirSync(path.join(e3.stateDir, 'last-stop'), { recursive: true });
  fs.writeFileSync(path.join(e3.stateDir, 'last-stop', `${SID}.txt`), new Date(Date.now() - 60000).toISOString());
  fs.writeFileSync(path.join(e3.stateDir, 'file-events', `${SID}.jsonl`), JSON.stringify({ path: e3.storyPath, ts: new Date().toISOString() }) + '\n');
  const r3 = stop(e3, codexEvent('Listo, he creado la historia.'));
  assert.ok(gateLog(e3).some((l) => l.name === 'story-claim-check' && Array.isArray(l.evidence) && l.evidence.includes('registro-de-ediciones')),
    'el registro no dice que la historia salió del registro de ediciones');
  assert.ok(!r3.out || r3.out.decision !== 'block', JSON.stringify(r3.out));

  // una historia editada en un turno ANTERIOR no respalda la afirmación de este: frena
  const e6 = mkEnv({ markerExtra: { storyPath: null } });
  writeStory(e6);
  fs.mkdirSync(path.join(e6.stateDir, 'file-events'), { recursive: true });
  fs.writeFileSync(path.join(e6.stateDir, 'file-events', `${SID}.jsonl`), JSON.stringify({ path: e6.storyPath, ts: new Date(Date.now() - 120000).toISOString() }) + '\n');
  fs.mkdirSync(path.join(e6.stateDir, 'last-stop'), { recursive: true });
  fs.writeFileSync(path.join(e6.stateDir, 'last-stop', `${SID}.txt`), new Date(Date.now() - 60000).toISOString());
  const r6 = stop(e6, codexEvent('Listo, he creado la historia.'));
  assert.ok(r6.out && r6.out.decision === 'block', `una edición de un turno anterior hizo pasar la afirmación: ${JSON.stringify(r6.out)}`);
  // y el cierre deja su hora para el turno siguiente
  assert.ok(fs.readFileSync(path.join(e6.stateDir, 'last-stop', `${SID}.txt`), 'utf8') > new Date(Date.now() - 30000).toISOString());

  // el mensaje nombra una historia que existe, sin marcador que la tenga ni registro de ediciones: pasa
  const e5 = mkEnv({ markerExtra: { storyPath: null } });
  writeStory(e5);
  const r5 = stop(e5, codexEvent('He creado la historia specs/story-9.9.md.'));
  assert.ok(!r5.out || r5.out.decision !== 'block', JSON.stringify(r5.out));
  assert.ok(gateLog(e5).some((l) => l.name === 'story-claim-check' && l.status === 'verde' && l.evidence.includes('mensaje-nombra')));

  // sin ninguna evidencia: no frena y queda «no medido»
  const e4 = mkEnv();
  const r4 = stop(e4, { turn_id: 'turn-1', transcript_path: null });
  assert.ok(!r4.out || r4.out.decision !== 'block');
  assert.ok(gateLog(e4).some((l) => l.name === 'story-claim-check' && l.status === 'no-medido'), 'sin evidencia tenía que quedar «no medido»');
});

test('Roster_ImplementerModel_FromMarker_ThenTranscript_ThenNotMeasured @story-8.97 @ac-6', () => {
  const roster = require(path.join(SCRIPTS, 'lib', 'review-roster.js'));
  const e = mkEnv();
  const tr = claudeTranscript(e, 'hola');
  assert.strictEqual(roster.implementerModel({ marker: { sessionModel: 'kimi-k2.7-code:cloud' }, transcriptPath: tr }), 'kimi-k2.7-code:cloud');
  assert.strictEqual(roster.implementerModel({ marker: {}, transcriptPath: tr }), 'claude-opus-5-5');
  assert.strictEqual(roster.implementerModel({ marker: null, transcriptPath: null }), 'no medido');
});

test('NarratedStep_WithoutRecord_IsNotDone @story-8.97 @ac-7', () => {
  const dicho = 'Listo: cerré los hallazgos y el commit quedó hecho.';
  for (const tool of ['codex', 'claude']) {
    const e = mkEnv();
    const event = tool === 'codex' ? codexEvent(dicho) : { transcript_path: claudeTranscript(e, dicho), last_assistant_message: dicho };
    const r = stop(e, event);
    const msg = (r.out && (r.out.systemMessage || r.out.reason)) || '';
    assert.match(msg, /Hallazgos/, `${tool}: la línea no nombra «Hallazgos»: ${JSON.stringify(r.out)}`);
    assert.match(msg, /Preparar el commit/, `${tool}: la línea no nombra «Preparar el commit»`);
    assert.ok(!r.out || r.out.decision !== 'block', `${tool}: la línea es un aviso, no frena el cierre`);
  }
  // un evento sin mensaje (Codex sin texto): la línea sale igual
  const e1 = mkEnv();
  const r1 = stop(e1, { turn_id: 'turn-1', transcript_path: null });
  assert.match((r1.out && r1.out.systemMessage) || '', /Preparar el commit/, 'sin mensaje en el evento la línea tenía que salir');

  // sin afirmación de cierre, en una pausa normal: no sale
  const e2 = mkEnv();
  const r2 = stop(e2, codexEvent('¿Apruebo el plan? Te dejo la lista de archivos y las dos opciones.'));
  // los femeninos y las otras formas del cierre sí la disparan
  for (const frase of ['La story quedó terminada.', 'Story cerrada, ya commiteé.']) {
    const ef = mkEnv();
    const rf = stop(ef, codexEvent(frase));
    assert.match((rf.out && rf.out.systemMessage) || '', /Preparar el commit/, `«${frase}» no disparó la línea`);
  }
  assert.ok(!r2.out || !/Preparar el commit/.test(r2.out.systemMessage || ''), 'la línea salió en una pausa sin afirmación de cierre');

  // el freno real: «Preparar el commit» se niega con un paso anterior abierto
  const e3 = mkEnv();
  const env = { ...e3.env, CLAUDE_CODE_SESSION_ID: SID };
  const pc = spawnSync(process.execPath, [MARKER, 'complete-step', 'prepare-commit'], { cwd: e3.repo, env, encoding: 'utf8', timeout: 30000 });
  assert.notStrictEqual(pc.status, 0, 'complete-step prepare-commit pasó con «Revisores» abierto');
});

test('ClaudeCode_ClosingGate_SameVerdicts @story-8.97 @ac-13', () => {
  // con la constancia de la skill y conversación: frena si no escribió la historia
  const e = mkEnv({ marker: false, skillMark: true });
  const r = stop(e, { transcript_path: claudeTranscript(e, 'He creado la historia specs/story-9.9.md.') });
  assert.ok(r.out && r.out.decision === 'block', JSON.stringify(r.out));
  // y deja pasar si la escribió con Write
  const e2 = mkEnv({ marker: false, skillMark: true });
  writeStory(e2);
  const r2 = stop(e2, { transcript_path: claudeTranscript(e2, 'He creado la historia.', { writeTool: true }) });
  assert.ok(!r2.out || r2.out.decision !== 'block', JSON.stringify(r2.out));
  // sin constancia de la skill ni marcador: no actúa (como hoy)
  const e3 = mkEnv({ marker: false });
  const r3 = stop(e3, { transcript_path: claudeTranscript(e3, 'He creado la historia specs/story-9.9.md.') });
  assert.ok(!r3.out || r3.out.decision !== 'block');
  // con conversación, una historia que la sesión editó antes (en el registro de ediciones) no cambia el veredicto: frena
  const e4 = mkEnv({ marker: false, skillMark: true });
  const otra = path.join(e4.repo, 'specs', 'story-1.1.md');
  fs.writeFileSync(otra, '---\nepic: 1\nstory: "1.1"\ntitle: "x"\nstatus: draft\n---\n# Story 1.1\n');
  fs.mkdirSync(path.join(e4.stateDir, 'file-events'), { recursive: true });
  fs.writeFileSync(path.join(e4.stateDir, 'file-events', `${SID}.jsonl`), JSON.stringify({ path: otra, ts: new Date().toISOString() }) + '\n');
  const r4 = stop(e4, { transcript_path: claudeTranscript(e4, 'He creado la historia specs/story-9.9.md.') });
  assert.ok(r4.out && r4.out.decision === 'block', `con conversación, el registro de ediciones de la sesión hizo pasar la afirmación: ${JSON.stringify(r4.out)}`);
});
