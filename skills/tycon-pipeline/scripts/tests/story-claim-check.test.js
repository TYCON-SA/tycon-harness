#!/usr/bin/env node
/**
 * story-claim-check.test.js — no se cierra el turno diciendo «creé la historia» sin la historia escrita.
 *
 * El caso que lo motivó: un modelo corrió la skill de historias, mandó la escritura como si fuera un comando de la
 * terminal («Write {…}» por Bash), falló y cerró con «He creado la historia». Los transcripts de acá reproducen esa
 * forma con nombres inventados.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/story-claim-check.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { claimWithoutStory } = require('../lib/story-claim-check.js');
const GATE = path.join(__dirname, '..', 'on-stop-dod-gate.js');

const STORY = '---\nepic: 6\nstory: "6.6"\nstatus: draft\n---\n# Historia\n';
const CLAIM = 'He creado la historia para la funcionalidad de CBU/CVU y Alias en la gestión de gestores.';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'claim-')); }
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const result = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
function transcript(d, records) {
  const p = path.join(d, 'sesion.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
/** El turno del caso: la skill, la escritura mandada por la terminal que falla y el «creé». */
function turnoFallido(d, final = CLAIM) {
  const f = path.join(d, 'specs', 'story-6.6-cbu.md');
  return transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'tycon-create-story' } }]),
    result('t1', 'Launching skill', false),
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `Write {"file_path": "${f}", "content": "..."}` } }]),
    result('t2', '(eval):1: command not found: Write', true),
    assistant([{ type: 'text', text: final }]),
  ]);
}

test('T1 Claim_EscrituraFallida_Frena: «he creado» con la escritura fallida no deja cerrar', () => {
  const d = dir();
  const r = claimWithoutStory({ transcript_path: turnoFallido(d), cwd: d }, { hasMark: true });
  assert.match(r || '', /no se escribió ningún archivo de historia/);
  assert.match(r, /tool Write/);
});

test('T2 Claim_HistoriaEscrita_Pasa: con un Write que no falló y el archivo en disco, cierra', () => {
  const d = dir();
  const f = path.join(d, 'specs', 'story-6.6-cbu.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, STORY);
  const p = transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: f, content: STORY } }]),
    result('t1', 'File created successfully', false),
    assistant([{ type: 'text', text: CLAIM }]),
  ]);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: true }), null);
  // escribir otro .md (unas notas) no es escribir la historia
  const notas = path.join(d, 'notas.md');
  fs.writeFileSync(notas, '# notas\n');
  const p2 = transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: notas, content: '# notas\n' } }]),
    result('t1', 'File created successfully', false),
    assistant([{ type: 'text', text: CLAIM }]),
  ]);
  assert.notStrictEqual(claimWithoutStory({ transcript_path: p2, cwd: d }, { hasMark: true }), null);
  // un transcript que no se puede leer deja cerrar: no se toma por «no escribió»
  assert.strictEqual(claimWithoutStory({ transcript_path: path.join(d, 'no-existe.jsonl'), cwd: d }, { hasMark: true }), null);
});

test('T3 Claim_NombraHistoriaQueExiste_Pasa: escrita en otro turno y nombrada en el mensaje, cierra', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'specs'));
  fs.writeFileSync(path.join(d, 'specs', 'story-6.6-cbu.md'), STORY);
  const p = turnoFallido(d, `${CLAIM} Está en specs/story-6.6-cbu.md.`);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: true }), null);
  // la misma ruta sin el archivo: frena y la nombra
  const d2 = dir();
  assert.match(claimWithoutStory({ transcript_path: turnoFallido(d2, `${CLAIM} Está en specs/story-6.6-cbu.md.`), cwd: d2 }, { hasMark: true }), /story-6\.6-cbu\.md no existe/);
});

test('T4 Claim_FueraDeAlcance_Pasa: sin la skill, en el segundo cierre o sin decir «creé», no frena', () => {
  const d = dir();
  const p = turnoFallido(d);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: false }), null);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d, stop_hook_active: true }, { hasMark: true }), null);
  assert.strictEqual(claimWithoutStory({ transcript_path: turnoFallido(d, 'La historia NO quedó escrita: falló la escritura.'), cwd: d }, { hasMark: true }), null);
  // una negación en una oración no tapa la afirmación de la otra
  assert.notStrictEqual(claimWithoutStory({ transcript_path: turnoFallido(d, `No encontré la tabla. ${CLAIM}`), cwd: d }, { hasMark: true }), null);
});

test('T5 Claim_HookDeCierre_Frena: el cierre de Claude Code devuelve «block» con la constancia de la skill', () => {
  const home = dir();
  const d = dir();
  const sid = 'sesion-claim';
  const marks = path.join(home, '.claude', '.tycon-pipeline', 'skill-marks');
  fs.mkdirSync(marks, { recursive: true });
  // stable-data: la constancia tiene que ser de ahora: el cierre la compara con su propio reloj y vence a las 2 horas
  fs.writeFileSync(path.join(marks, `${sid}.json`), JSON.stringify({ skill: 'tycon-create-story', at: new Date().toISOString(), sessionId: sid }));
  const input = JSON.stringify({ session_id: sid, transcript_path: turnoFallido(d), cwd: d, hook_event_name: 'Stop' });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, [GATE], { input, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).decision, 'block');
  // sin la constancia, el mismo cierre pasa callado
  fs.rmSync(path.join(marks, `${sid}.json`));
  const r2 = spawnSync(process.execPath, [GATE], { input, env, encoding: 'utf8' });
  assert.strictEqual(r2.stdout, '');
});
