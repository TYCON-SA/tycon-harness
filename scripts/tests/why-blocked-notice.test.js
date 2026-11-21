#!/usr/bin/env node
/**
 * why-blocked-notice.test.js — cuando la persona pregunta por qué la frenó el arnés, el asistente recibe el último freno
 * del hilo para explicarlo en llano.
 *
 * Cada caso arma un hilo de juguete con la forma real de cada herramienta: en Claude Code, el resultado con error que
 * empieza «PreToolUse:<herramienta> hook error: [<gancho>]: <mensaje>»; en Codex, la salida de la herramienta con
 * «Command blocked by PreToolUse hook: <mensaje>» (las dos, copiadas de hilos reales).
 *
 * 🔴 Las mutaciones que más pesan: T4 (tomar como freno un texto que sólo lo cita: una búsqueda, un mensaje del
 * asistente), T3 (quedarse con el primer freno y no con el último), T6 (pasar la credencial del comando sin tapar).
 *
 * Correr: node --test scripts/tests/why-blocked-notice.test.js
 *
 * stable-data: la hora de cada registro de juguete sale del reloj real sólo para que el hilo tenga la forma de uno de
 * verdad; ningún valor esperado depende de ella.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'why-blocked-notice.js');

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-')); }
function thread(h, recs) {
  const p = path.join(h, 'thread.jsonl');
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
function run(h, tp, prompt, extraEnv = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TYCON_|CLAUDE_)/.test(k)) env[k] = v;
  Object.assign(env, { HOME: h, USERPROFILE: h }, extraEnv);
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: tp, prompt }),
    env, encoding: 'utf8', timeout: 20000,
  });
}

// ── las formas de cada herramienta ─────────────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const user = (text) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: ts() });
const bash = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, timestamp: ts() });
const result = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] }, timestamp: ts() });
const blocked = (id, msg) => result(id, `PreToolUse:Bash hook error: [node /home/dev/.tycon/harness/scripts/hooks/guard.js]: ${msg}`, true);
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts() });
const codexCall = (callId) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input: 'git commit --no-verify' } });
const codexBlocked = (callId, msg) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script failed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: `Script error:\nCommand blocked by PreToolUse hook: ${msg}` }] } });
const codexBlockedPlain = (callId, msg) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: `Command blocked by PreToolUse hook: ${msg}` } });
const codexUser = (text) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

const WHY = '¿por qué me frenaste?';

test('T1 Claude_LastBrake_Injected — la pregunta trae el mensaje del freno, sin la ruta del gancho, y el pedido de explicarlo en llano', () => {
  const h = home();
  const tp = thread(h, [user('borrá la rama'), bash('t1', 'git push --force origin main'), blocked('t1', '⛔ `git push --force` FRENADO — reescribe la historia de main; pedí la firma así: …'), said('El freno lo paró.')]);
  const r = run(h, tp, WHY);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /FRENADO — reescribe la historia de main/);
  assert.doesNotMatch(r.stdout, /scripts\/hooks\/guard\.js/, 'la ruta del gancho no le sirve a la persona');
  assert.match(r.stdout, /llano/);
  assert.match(r.stdout, /git push --force origin main/, 'el comando que frenó, para que el asistente diga qué hacía');
});

test('T2 Codex_LastBrake_Injected — en Codex el freno se lee de la salida de la herramienta, en sus dos formas', () => {
  for (const [name, rec] of [['custom', codexBlocked('c1', '🛑 TYCON safety-guard BLOCK [GIT-C2]\n\nComando: git commit --no-verify')], ['function', codexBlockedPlain('c1', '🛑 TYCON safety-guard BLOCK [GIT-C2]\n\nComando: git commit --no-verify')]]) {
    const h = home();
    const tp = thread(h, [codexUser('commiteá'), codexCall('c1'), rec]);
    const r = run(h, tp, 'why did you block me?');
    assert.strictEqual(r.status, 0, name);
    assert.match(r.stdout, /safety-guard BLOCK \[GIT-C2\]/, name);
    assert.match(r.stdout, /git commit --no-verify/, name);
  }
});

test('T3 LastOneWins — con dos frenos en el hilo, el que se explica es el último', () => {
  const h = home();
  const tp = thread(h, [bash('a', 'rm -rf /'), blocked('a', '⛔ PRIMERO borra la raíz'), user('ok'), bash('b', 'git push --force'), blocked('b', '⛔ SEGUNDO reescribe main')]);
  const r = run(h, tp, '¿Por qué se frenó?');
  assert.match(r.stdout, /SEGUNDO reescribe main/);
  assert.doesNotMatch(r.stdout, /PRIMERO/);
});

test('T4 QuotedIsNotABrake — un texto que sólo cita un freno (una búsqueda, un mensaje) no cuenta: se dice que no hubo y que no lo invente', () => {
  const h = home();
  const tp = thread(h, [bash('g', 'grep -r hook logs'), result('g', 'log.txt: PreToolUse:Bash hook error: [x]: ⛔ CITADO', false), said('PreToolUse:Bash hook error: [x]: ⛔ DICHO'), said('Command blocked by PreToolUse hook: ⛔ DICHO2')]);
  const r = run(h, tp, WHY);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CITADO|DICHO/);
  assert.match(r.stdout, /no hay ningún freno/i);
  assert.match(r.stdout, /no lo inventes/i);
});

test('T5 OnlyOnTheQuestion — sin la pregunta, nada; con sus formas en castellano y en inglés, sí', () => {
  const h = home();
  const tp = thread(h, [bash('t1', 'x'), blocked('t1', '⛔ FRENO')]);
  for (const p of ['seguí', 'dale con la tanda', 'arreglá el freno de pruebas', '']) assert.strictEqual(run(h, tp, p).stdout, '', JSON.stringify(p));
  for (const p of ['¿por qué me frenaste?', 'por que me frenó el arnés', '¿Por qué se bloqueó el commit?', 'why did you block me', 'Why was it blocked?', '¿por qué me paraste?']) assert.match(run(h, tp, p).stdout, /FRENO/, p);
});

test('T6 SecretsMasked_LongCut — una credencial del comando sale tapada; un mensaje larguísimo se corta', () => {
  const h = home();
  const tok = 'ghp_' + 'A'.repeat(36);
  const tp = thread(h, [bash('t1', `curl -H "Authorization: Bearer ${tok}" https://x`), blocked('t1', `⛔ FRENADO ${tok} ${'y'.repeat(5000)}`)]);
  const r = run(h, tp, WHY);
  assert.doesNotMatch(r.stdout, /ghp_A{10}/);
  assert.ok(r.stdout.length < 4000, `cortado: ${r.stdout.length}`);
});

test('T7 FailOpen_Off — sin hilo dice que no lo pudo leer; apagado, nada; siempre sale 0', () => {
  const h = home();
  const r = run(h, path.join(h, 'no-existe.jsonl'), WHY);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no pude leer/i);
  const tp = thread(h, [bash('t1', 'x'), blocked('t1', '⛔ FRENO')]);
  assert.strictEqual(run(h, tp, WHY, { TYCON_WHY_BLOCKED_NOTICE: '0' }).stdout, '');
  const bad = spawnSync(process.execPath, [HOOK], { input: 'no es json', encoding: 'utf8' });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout, '');
});
