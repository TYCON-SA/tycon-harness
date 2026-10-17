#!/usr/bin/env node
/**
 * wait-notice.test.js — la corrida avisa por Telegram cuando queda esperando a una persona (story 7.20).
 *
 * Telegram es un servidor HTTP local (`TYCON_TELEGRAM_API`) con un permiso de bot falso: NUNCA se manda un mensaje de
 * verdad. Cada caso tiene su HOME temporal (el estado real de la máquina no se toca) y el plazo se acorta con
 * `TYCON_WAIT_NOTICE_MS`. El proceso del plazo es real: se lanza desprendido y la prueba espera su línea en el registro.
 *
 * 🔴 Las mutaciones que más pesan, dichas en su caso: T3 (comparar el tamaño del hilo, o saltear `stop_hook_active`),
 * T4 (sólo editar el primer mensaje: no suena), T8 (avisar por una sesión cerrada), T14 (un proceso dormido por cierre),
 * T17 (abrir la espera sin Telegram y callar recién al cumplirse el plazo).
 *
 * Correr: node --test scripts/tests/wait-notice.test.js
 *
 * stable-data: el hook mide un plazo de verdad (el proceso del plazo duerme y compara la edad del hilo y de la espera con
 * la hora actual), así que las pruebas usan el reloj real y fechas relativas a él (13 horas atrás, una hora atrás). Ningún
 * valor esperado depende de la hora: sólo de lo que pasó antes o después del plazo.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'wait-notice.js');
const BLOCKING_METER = path.join(ROOT, 'scripts', 'hooks', 'blocking-meter.js');
const CODEX_HOOKS = path.join(ROOT, 'adapters', 'codex', 'hooks.json');
const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const BOT = '123456789:FAKE-token-for-tests-only-aaaaaaaaaaaaaa';
const MS = 400;

// ── el Telegram de mentira ──────────────────────────────────────────────────────────────────────────────────────
function fakeTelegram({ status = 200 } = {}) {
  const calls = [];
  let next = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const method = req.url.split('/').pop();
      calls.push({ method, chat_id: p.get('chat_id'), text: p.get('text'), message_id: p.get('message_id') });
      if (status !== 200) { res.writeHead(status); res.end('{"ok":false,"description":"boom"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: method === 'sendMessage' ? ++next : Number(p.get('message_id')) } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)),
  })));
}

// ── el mundo de cada caso ───────────────────────────────────────────────────────────────────────────────────────
function world({ api, chat = '4242', bot = BOT, ms = MS, extraEnv = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-notice-'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TYCON_|TELEGRAM_|CLAUDE_)/.test(k)) continue;   // nada de la máquina real
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TYCON_WAIT_NOTICE_MS: String(ms) });
  if (api) env.TYCON_TELEGRAM_API = api;
  if (chat) env.TYCON_TELEGRAM_CHAT_ID = chat;
  if (bot) env.TELEGRAM_BOT_TOKEN = bot;
  Object.assign(env, extraEnv);
  const sd = stateDir(home);
  return { home, env, sd, dir: path.join(sd, 'wait-notice') };
}

function marker(w, sid, { storyId = '9.9', pending = [5, 6, 8], extra = {} } = {}) {
  const d = path.join(w.sd, 'active');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.json`), JSON.stringify({ storyId, storyPath: '/ruta/secreta/story-9.9-cliente-acme.md', sessionId: sid, stepsCompleted: [0, 1, 2, 3, 4], stepsPending: pending, ...extra }));
}

const userRec = (text) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() });
const agentRec = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date().toISOString() });
const agentToolRec = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: new Date().toISOString() });

function transcript(w, sid, recs) {
  const p = path.join(w.home, `${sid}.jsonl`);
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const append = (p, recs) => fs.appendFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

function hook(w, payload, args = []) {
  return spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(payload), env: w.env, encoding: 'utf8', timeout: 20000 });
}
const stop = (w, sid, tp, extra = {}) => hook(w, { hook_event_name: 'Stop', session_id: sid, transcript_path: tp, stop_hook_active: false, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function logLines(w) {
  try { return fs.readFileSync(path.join(w.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
async function waitFor(cond, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = cond(); if (v) return v; await sleep(50); }
  return cond();
}
const waitFile = (w, sid) => { try { return JSON.parse(fs.readFileSync(path.join(w.dir, 'waits', `${sid}.json`), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── T1 · AC 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 Stop_ActiveRun_NotifiesAfterThreshold — id de la story, «Revisores» y la línea de espera; el autónomo escalado lleva su motivo', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 's1');
    const tp = transcript(w, 's1', [userRec('implementemos'), agentRec('Listo el set.\n¿Sigo con los revisores?')]);
    const r = stop(w, 's1', tp);
    assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout + r.stderr, '');
    const sent = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage'));
    assert.ok(sent, 'esperaba un envío');
    assert.match(sent.text, /9\.9/);
    assert.match(sent.text, /Revisores/);
    assert.doesNotMatch(sent.text, /paso 5/i);
    assert.match(sent.text, /¿Sigo con los revisores\?/);
    assert.strictEqual(sent.chat_id, '4242');

    const w2 = world({ api: tg.url });
    marker(w2, 's2', { extra: { autonomous: true, needs_human: true, escalation_reason: 'el portón escaló: 3 vueltas sin progreso' } });
    const tp2 = transcript(w2, 's2', [userRec('dale'), agentRec('cualquier cosa')]);
    stop(w2, 's2', tp2);
    const sent2 = await waitFor(() => tg.calls.filter((c) => c.method === 'sendMessage')[1]);
    assert.ok(sent2);
    assert.match(sent2.text, /el portón escaló: 3 vueltas sin progreso/);
  } finally { await tg.close(); }
});

// ── T2 · AC 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T2 Question_NotifiesAfterThreshold — la primera línea de la pregunta; «permiso para <herramienta>»', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 'q1');
    const tp = transcript(w, 'q1', [userRec('hola'), agentRec('pregunto')]);
    const r = hook(w, { hook_event_name: 'PreToolUse', session_id: 'q1', transcript_path: tp, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '¿Mergeo el pedido 157?\nDetalle largo', header: 'Merge', options: [] }] } });
    assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
    const sent = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage'));
    assert.ok(sent); assert.match(sent.text, /¿Mergeo el pedido 157\?/); assert.doesNotMatch(sent.text, /Detalle largo/);

    const w2 = world({ api: tg.url });
    marker(w2, 'p1');
    const tp2 = transcript(w2, 'p1', [userRec('hola'), agentRec('corro')]);
    hook(w2, { hook_event_name: 'Notification', session_id: 'p1', transcript_path: tp2, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    const sent2 = await waitFor(() => tg.calls.filter((c) => c.method === 'sendMessage')[1]);
    assert.ok(sent2); assert.match(sent2.text, /permiso para Bash/);
  } finally { await tg.close(); }
});

// ── T3 · AC 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T3 Answered_BeforeThreshold_NoNotice — contestó · siguió · registros ajenos sí avisan · stop_hook_active sí avisa', async () => {
  const tg = await fakeTelegram();
  try {
    // (a) la persona escribe antes del plazo
    const a = world({ api: tg.url, ms: 1500 });
    marker(a, 'a'); const tpa = transcript(a, 'a', [userRec('x'), agentRec('¿sigo?')]);
    stop(a, 'a', tpa);
    append(tpa, [userRec('sí, seguí')]);
    hook(a, { hook_event_name: 'UserPromptSubmit', session_id: 'a', transcript_path: tpa, prompt: 'sí, seguí' });
    // (b) el agente suma un mensaje con una herramienta (sin pasar por ningún evento del hook)
    const b = world({ api: tg.url, ms: 800 });
    marker(b, 'b'); const tpb = transcript(b, 'b', [userRec('x'), agentRec('¿sigo?')]);
    stop(b, 'b', tpb);
    append(tpb, [agentToolRec()]);
    // (c) el hilo crece sólo con registros que no son ni la persona ni el agente
    const c = world({ api: tg.url, ms: 800 });
    marker(c, 'c'); const tpc = transcript(c, 'c', [userRec('x'), agentRec('¿sigo con c?')]);
    stop(c, 'c', tpc);
    append(tpc, [{ type: 'attachment', attachment: { x: 1 } }, { type: 'ai-title', title: 'algo' }, { type: 'system', content: 'nota' }, { type: 'queue-operation', op: 'x' }]);
    // (d) cierre con stop_hook_active (otro control frenó el anterior) y nadie escribe
    const d = world({ api: tg.url, ms: 800 });
    marker(d, 'd'); const tpd = transcript(d, 'd', [userRec('x'), agentRec('¿sigo con d?')]);
    stop(d, 'd', tpd, { stop_hook_active: true });

    const la = await waitFor(() => logLines(a).find((l) => l.session === 'a'));
    assert.strictEqual(la && la.result, 'answered');
    const lb = await waitFor(() => logLines(b).find((l) => l.session === 'b'));
    assert.strictEqual(lb && lb.result, 'kept-working');
    const sc = await waitFor(() => tg.calls.find((x) => x.method === 'sendMessage' && /¿sigo con c\?/.test(x.text)));
    assert.ok(sc, '(c) sólo registros ajenos: la espera sigue abierta y avisa');
    const sd = await waitFor(() => tg.calls.find((x) => x.method === 'sendMessage' && /¿sigo con d\?/.test(x.text)));
    assert.ok(sd, '(d) el cierre con stop_hook_active también abre la espera');
    await sleep(1200);
    assert.ok(!tg.calls.some((x) => /¿sigo\?/.test(x.text || '')), '(a) y (b) no mandan nada');
  } finally { await tg.close(); }
});

// ── T4 · AC 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T4 SecondWait_NewMessageListingBoth — un mensaje nuevo que lista las dos; el primero se reescribe', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 'u1', { storyId: '1.1' }); marker(w, 'u2', { storyId: '2.2' });
    const tp1 = transcript(w, 'u1', [userRec('x'), agentRec('¿uno?')]);
    stop(w, 'u1', tp1);
    const first = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage'));
    assert.ok(first);
    const tp2 = transcript(w, 'u2', [userRec('x'), agentRec('¿dos?')]);
    stop(w, 'u2', tp2);
    const second = await waitFor(() => tg.calls.filter((c) => c.method === 'sendMessage')[1]);
    assert.ok(second, 'la segunda espera manda un mensaje NUEVO (una edición no suena)');
    assert.match(second.text, /1\.1/); assert.match(second.text, /2\.2/);
    const edit = await waitFor(() => tg.calls.find((c) => c.method === 'editMessageText'));
    assert.ok(edit, 'el primero se reescribe');
    assert.strictEqual(edit.message_id, '101');
    assert.match(edit.text, /ver el mensaje siguiente/);
  } finally { await tg.close(); }
});

// ── T5 · AC 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T5 EveryWait_LeavesOneLine — la avisada y la contestada a tiempo dejan su línea', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 'v1'); marker(w, 'v2');
    const tp1 = transcript(w, 'v1', [userRec('x'), agentRec('¿v1?')]);
    stop(w, 'v1', tp1);
    await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage'));
    await waitFor(() => (waitFile(w, 'v1') || {}).notified);
    append(tp1, [userRec('volví')]);
    hook(w, { hook_event_name: 'UserPromptSubmit', session_id: 'v1', transcript_path: tp1, prompt: 'volví' });

    const w2 = world({ api: tg.url, ms: 2000 });
    marker(w2, 'v2');
    const tp2 = transcript(w2, 'v2', [userRec('x'), agentRec('¿v2?')]);
    stop(w2, 'v2', tp2);
    append(tp2, [userRec('ya')]);
    hook(w2, { hook_event_name: 'UserPromptSubmit', session_id: 'v2', transcript_path: tp2, prompt: 'ya' });

    const l1 = logLines(w).find((l) => l.session === 'v1');
    assert.ok(l1, 'línea de la avisada');
    assert.strictEqual(l1.notified, true); assert.strictEqual(l1.result, 'answered');
    for (const k of ['story', 'step', 'startedAt', 'returnedAt']) assert.ok(l1[k], `falta ${k}`);
    const l2 = logLines(w2).find((l) => l.session === 'v2');
    assert.ok(l2); assert.strictEqual(l2.notified, false); assert.strictEqual(l2.result, 'answered');
    assert.ok(l2.story && l2.step && l2.startedAt && l2.returnedAt);
  } finally { await tg.close(); }
});

// ── T6 · AC 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T6 NoBot_SkipsAndSaysSo — con chat y sin bot: no-channel; con el chat sólo en la configuración de la máquina: envío', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url, bot: null });
    marker(w, 'n1');
    stop(w, 'n1', transcript(w, 'n1', [userRec('x'), agentRec('¿n1?')]));
    const l = await waitFor(() => logLines(w).find((x) => x.session === 'n1'));
    assert.strictEqual(l && l.result, 'no-channel');
    assert.strictEqual(tg.calls.length, 0);

    const w2 = world({ api: tg.url, chat: null });
    fs.mkdirSync(path.join(w2.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(w2.home, '.claude', 'tycon.json'), JSON.stringify({ telegram: { chat_id: '777' } }));
    marker(w2, 'n2');
    stop(w2, 'n2', transcript(w2, 'n2', [userRec('x'), agentRec('¿n2?')]));
    const sent = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage'));
    assert.ok(sent, 'con el chat en la configuración de la máquina, avisa');
    assert.strictEqual(sent.chat_id, '777');
  } finally { await tg.close(); }
});

// ── T7 · AC 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T7 TelegramFails_NoRetry — 500 y sin respuesta: un intento, failed con el motivo', async () => {
  const tg = await fakeTelegram({ status: 500 });
  try {
    const w = world({ api: tg.url });
    marker(w, 'f1');
    stop(w, 'f1', transcript(w, 'f1', [userRec('x'), agentRec('¿f1?')]));
    const l = await waitFor(() => logLines(w).find((x) => x.session === 'f1'));
    assert.strictEqual(l && l.result, 'failed');
    assert.ok(l.reason && !l.reason.includes(BOT), 'motivo en una línea, sin el permiso del bot');
    await sleep(600);
    assert.strictEqual(tg.calls.filter((c) => c.method === 'sendMessage').length, 1, 'no se reintenta');
  } finally { await tg.close(); }
  // nadie escucha en ese puerto: curl falla al conectar
  const closed = await fakeTelegram(); const url = closed.url; await closed.close();
  const w = world({ api: url });
  marker(w, 'f2');
  stop(w, 'f2', transcript(w, 'f2', [userRec('x'), agentRec('¿f2?')]));
  const l = await waitFor(() => logLines(w).find((x) => x.session === 'f2'));
  assert.strictEqual(l && l.result, 'failed');
});

// ── T8 · AC 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T8 NoRunOrFinishedRun_Nothing — sin marcador · corrida terminada · SessionEnd · espera de 13 horas', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    stop(w, 'x1', transcript(w, 'x1', [userRec('x'), agentRec('¿?')]));                  // sin marcador
    marker(w, 'x2', { pending: [] });
    stop(w, 'x2', transcript(w, 'x2', [userRec('x'), agentRec('¿?')]));                  // todos los pasos cerrados
    marker(w, 'x2b', { pending: [9] });
    stop(w, 'x2b', transcript(w, 'x2b', [userRec('x'), agentRec('¿?')]));                // sólo el cierre en ADO, fuera de la secuencia
    assert.strictEqual(waitFile(w, 'x1'), null); assert.strictEqual(waitFile(w, 'x2'), null); assert.strictEqual(waitFile(w, 'x2b'), null);

    const w2 = world({ api: tg.url, ms: 1500 });
    marker(w2, 'x3');
    const tp3 = transcript(w2, 'x3', [userRec('x'), agentRec('¿x3?')]);
    stop(w2, 'x3', tp3);
    hook(w2, { hook_event_name: 'SessionEnd', session_id: 'x3', transcript_path: tp3, reason: 'exit' });
    const l3 = await waitFor(() => logLines(w2).find((l) => l.session === 'x3'));
    assert.strictEqual(l3 && l3.result, 'session-ended');

    // la sesión murió sin SessionEnd: su hilo no cambia hace más de lo que dura la espera
    const w3 = world({ api: tg.url, ms: 600 });
    marker(w3, 'x4');
    const tp4 = transcript(w3, 'x4', [userRec('x'), agentRec('¿x4?')]);
    stop(w3, 'x4', tp4);
    const viejo = (Date.now() - 3600 * 1000) / 1000; fs.utimesSync(tp4, viejo, viejo);
    const l4 = await waitFor(() => logLines(w3).find((l) => l.session === 'x4'));
    assert.strictEqual(l4 && l4.result, 'session-ended');

    // 13 horas abierta: stale, y sale de la lista de esperas abiertas
    const w4 = world({ api: tg.url, ms: 60000 });
    marker(w4, 'x5'); marker(w4, 'x6');
    const tp5 = transcript(w4, 'x5', [userRec('x'), agentRec('¿x5?')]);
    stop(w4, 'x5', tp5);
    const wf = waitFile(w4, 'x5');
    if (wf.pid) try { process.kill(wf.pid); } catch { /* ya no está */ }   // una espera avisada ya no tiene proceso vivo
    wf.openedAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString(); wf.notified = true; wf.pid = null;
    fs.writeFileSync(path.join(w4.dir, 'waits', 'x5.json'), JSON.stringify(wf));
    fs.writeFileSync(path.join(w4.dir, 'last-message.json'), JSON.stringify({ messageId: 55, sessions: ['x5'] }));
    stop(w4, 'x6', transcript(w4, 'x6', [userRec('x'), agentRec('¿x6?')]));               // cualquier evento barre
    const l5 = logLines(w4).find((l) => l.session === 'x5');
    assert.strictEqual(l5 && l5.result, 'stale');
    assert.strictEqual(waitFile(w4, 'x5'), null);
    const lm = JSON.parse(fs.readFileSync(path.join(w4.dir, 'last-message.json'), 'utf8'));
    assert.ok(!lm.sessions.includes('x5'));
    await sleep(300);
    assert.strictEqual(tg.calls.length, 0, 'nada de esto avisa');
    for (const x of [w2, w3, w4]) { const f = waitFile(x, 'x6'); if (f && f.pid) try { process.kill(f.pid); } catch { /* ya no está */ } }
  } finally { await tg.close(); }
});

// ── T9 · AC 9 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('T9 KillSwitch_Nothing — TYCON_WAIT_NOTICE=0', () => {
  const w = world({ api: 'http://127.0.0.1:9', extraEnv: { TYCON_WAIT_NOTICE: '0' } });
  marker(w, 'k1');
  const r = stop(w, 'k1', transcript(w, 'k1', [userRec('x'), agentRec('¿?')]));
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout + r.stderr, '');
  assert.ok(!fs.existsSync(w.dir), 'ni una carpeta');
});

// ── T10 · AC 10 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T10 BrokenState_FailsOpen — marcador que no es JSON; carpeta sin permiso de escritura', () => {
  const w = world({ api: 'http://127.0.0.1:9' });
  fs.mkdirSync(path.join(w.sd, 'active'), { recursive: true });
  fs.writeFileSync(path.join(w.sd, 'active', 'b1.json'), '{esto no es json');
  const r = stop(w, 'b1', transcript(w, 'b1', [userRec('x'), agentRec('¿?')]));
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout + r.stderr, '');

  const w2 = world({ api: 'http://127.0.0.1:9' });
  marker(w2, 'b2');
  fs.mkdirSync(w2.dir, { recursive: true });
  fs.chmodSync(w2.dir, 0o500);
  try {
    const r2 = stop(w2, 'b2', transcript(w2, 'b2', [userRec('x'), agentRec('¿?')]));
    assert.strictEqual(r2.status, 0); assert.strictEqual(r2.stdout + r2.stderr, '');
    const r3 = hook(w2, { hook_event_name: 'UserPromptSubmit', session_id: 'b2', prompt: 'x' });
    assert.strictEqual(r3.status, 0); assert.strictEqual(r3.stdout + r3.stderr, '');
  } finally { fs.chmodSync(w2.dir, 0o700); }
  const r4 = spawnSync(process.execPath, [HOOK], { input: 'no es json', env: w.env, encoding: 'utf8' });
  assert.strictEqual(r4.status, 0); assert.strictEqual(r4.stdout + r4.stderr, '');
});

// ── T12 · AC 12 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T12 Message_OnlyThreeFields — id sin título, nombre del paso, 200 caracteres de la primera línea, credencial tapada', () => {
  const { buildMessage } = require(HOOK);
  // el token de mentira se arma por partes: entero en el texto de la prueba, el freno de publicación lo toma por uno real
  const falso = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123'].join('');
  const larga = `Necesito el ok para seguir con ${falso} y ` + 'x'.repeat(900) + '\n```\n$ ls -la\ntotal 0\n```';
  const t = buildMessage([{ story: '9.9', step: '5', waiting: larga }], { botToken: BOT });
  assert.match(t, /9\.9/);
  assert.doesNotMatch(t, /cliente-acme|story-9\.9|\/ruta\//, 'ni título ni ruta');
  assert.match(t, /Revisores/);
  assert.ok(!t.includes(falso), 'la credencial queda tapada');
  assert.doesNotMatch(t, /ls -la|total 0/);
  const linea = t.split('\n').find((l) => /Necesito el ok/.test(l));
  assert.ok(linea && linea.length <= 260, `la línea esperada se corta (${linea && linea.length})`);
  const conBot = buildMessage([{ story: '9.9', step: '5', waiting: `falló con ${BOT}` }], { botToken: BOT });
  assert.doesNotMatch(conBot, new RegExp(BOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ── T13 · AC 13 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T13 Timer_LaunchedHidden — desprendido y oculto, y lo lanza el hook, no el arranque', () => {
  const { timerSpawnOptions } = require(HOOK);
  const o = timerSpawnOptions({});
  assert.strictEqual(o.windowsHide, true);
  assert.strictEqual(o.detached, true);
  assert.strictEqual(o.stdio, 'ignore');
  const startup = fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'harness-startup.js'), 'utf8');
  assert.doesNotMatch(startup, /wait-notice/, 'el arranque no lanza el proceso del plazo');
  const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install-tycon-hooks.ps1'), 'utf8');
  assert.doesNotMatch(ps1, /wait-notice\.js'.*Start-Process|Start-Process.*wait-notice/, 'el instalador de Windows tampoco');
});

// ── T14 · AC 13 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T14 Timer_OneSleeperPerSession — tres cierres seguidos: un solo proceso vivo', async () => {
  const w = world({ api: 'http://127.0.0.1:9', ms: 30000 });
  marker(w, 'o1');
  const tp = transcript(w, 'o1', [userRec('x'), agentRec('¿o1?')]);
  const pids = [];
  for (let i = 0; i < 3; i++) {
    stop(w, 'o1', tp);
    const f = await waitFor(() => waitFile(w, 'o1'));
    pids.push(f.pid);
  }
  await sleep(300);
  assert.strictEqual(new Set(pids).size, 3, 'cada cierre lanza su proceso');
  assert.ok(!alive(pids[0]) && !alive(pids[1]), 'los anteriores no siguen');
  assert.ok(alive(pids[2]), 'el último sigue esperando');
  process.kill(pids[2]);
});

// ── T15 · AC 1 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('T15 Steps_FromTheTable — el nombre de la tabla; un id desconocido, tal cual y anotado', () => {
  const { stepLabel } = require(HOOK);
  const { STEPS } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
  for (const s of STEPS) assert.strictEqual(stepLabel(s.id).name, s.name);
  assert.strictEqual(stepLabel(5).name, 'Revisores');
  const u = stepLabel('42z');
  assert.strictEqual(u.name, '42z'); assert.strictEqual(u.unknown, true);
});

// ── T16 · AC 2 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('T16 WaitTools_SameAsBlockingMeter — la misma lista que ESPERAN_AL_DEV', () => {
  const { WAIT_TOOLS } = require(HOOK);
  const m = /const ESPERAN_AL_DEV = new Set\(\[([^\]]*)\]\)/.exec(fs.readFileSync(BLOCKING_METER, 'utf8'));
  assert.ok(m, 'no encontré ESPERAN_AL_DEV en blocking-meter.js');
  const delMedidor = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  assert.deepStrictEqual([...WAIT_TOOLS].sort(), delMedidor);
});

// ── T17 · AC 6 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('T17 TelegramOff_DoesNothing — sin chat: ningún archivo y ningún proceso', async () => {
  const w = world({ api: 'http://127.0.0.1:9', chat: null });
  marker(w, 't1');
  const tp = transcript(w, 't1', [userRec('x'), agentRec('¿?')]);
  stop(w, 't1', tp);
  hook(w, { hook_event_name: 'PreToolUse', session_id: 't1', transcript_path: tp, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '¿?' }] } });
  hook(w, { hook_event_name: 'UserPromptSubmit', session_id: 't1', transcript_path: tp, prompt: 'x' });
  await sleep(MS + 400);
  assert.ok(!fs.existsSync(w.dir), 'sin Telegram no se crea la carpeta del hook');
  // control: el mismo caso CON chat sí abre la espera (si no, el caso de arriba pasaría sin hook)
  const c = world({ api: 'http://127.0.0.1:9', ms: 30000 });
  marker(c, 't2');
  stop(c, 't2', transcript(c, 't2', [userRec('x'), agentRec('¿?')]));
  const f = waitFile(c, 't2');
  assert.ok(f, 'con Telegram prendido la espera se abre');
  if (f.pid) try { process.kill(f.pid); } catch { /* ya no está */ }
});

// ── T18 · AC 14 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T18 OrgMinutes_FromTeamRepos — minutos de la organización; inválidos dan 5 y el problema; la variable gana', () => {
  const { thresholdMs } = require(HOOK);
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
  const tree = (wn) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-notice-tree-'));
    fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify(wn === undefined ? base : { ...base, wait_notice: wn }));
    return d;
  };
  assert.ok(TR.KEYS.includes('wait_notice'));
  const d2 = tree({ minutes: 2 });
  assert.ok(TR.parse(fs.readFileSync(path.join(d2, 'team-repos.json'), 'utf8')).ok, 'base válida');
  assert.deepStrictEqual(thresholdMs({ env: {}, tree: d2 }).ms, 2 * 60000);
  for (const malo of [{ minutes: 0 }, { minutes: 'x' }, { minutes: 121 }, { minutes: 2.5 }]) {
    const d = tree(malo);
    const p = TR.parse(fs.readFileSync(path.join(d, 'team-repos.json'), 'utf8'));
    assert.ok(p.ok, 'un wait_notice malo no anula el archivo');
    assert.ok(p.sectionProblems && p.sectionProblems.wait_notice && p.sectionProblems.wait_notice.length, JSON.stringify(malo));
    const r = thresholdMs({ env: {}, tree: d });
    assert.strictEqual(r.ms, 5 * 60000); assert.ok(r.problem);
  }
  assert.strictEqual(thresholdMs({ env: {}, tree: tree(undefined) }).ms, 5 * 60000);
  assert.strictEqual(thresholdMs({ env: { TYCON_WAIT_NOTICE_MS: '1234' }, tree: d2 }).ms, 1234);
});

// ── Los hallazgos del pase adversarial (2026-10-17): cada caso, rojo antes del arreglo ──────────────────────────
const codexUser = (text) => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const codexAgent = (text) => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const codexCall = () => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } });

test('T20 Codex_TranscriptCounts — el hilo de Codex se cuenta: prompts, mensajes y llamadas; lo inyectado no', () => {
  const { countRecords } = require(HOOK);
  const w = world({});
  const tp = transcript(w, 'cx', [
    codexUser('# AGENTS.md instructions\n<INSTRUCTIONS>…'), codexUser('<environment_context>\n<cwd>/</cwd>'),
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x' }] } },
    codexUser('implementemos la 9.9'), codexAgent('¿Sigo?'), codexCall(), { type: 'event_msg', payload: { type: 'token_count' } },
  ]);
  assert.deepStrictEqual(countRecords(tp), { records: 3, prompts: 1 });
});

test('T21 Codex_AnsweredCloses — en Codex la vuelta de la persona la ve el proceso del plazo y no avisa', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url, ms: 800 });
    marker(w, 'cx2');
    const tp = transcript(w, 'cx2', [codexUser('implementemos'), codexAgent('¿Sigo con los revisores de cx2?')]);
    stop(w, 'cx2', tp);
    append(tp, [codexUser('sí'), codexCall()]);
    const l = await waitFor(() => logLines(w).find((x) => x.session === 'cx2'));
    assert.strictEqual(l && l.result, 'answered');
    assert.ok(!tg.calls.some((c) => /cx2/.test(c.text || '')), 'no avisa');
  } finally { await tg.close(); }
});

test('T22 TwoTimersTogether_SecondListsBoth — dos plazos casi juntos: el segundo lista los dos y edita al primero', async () => {
  // Telegram lento: sin candado, los dos leen el archivo compartido antes de que el otro lo escriba
  const calls = []; let next = 100;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => setTimeout(() => {
      const p = new URLSearchParams(body); const method = req.url.split('/').pop();
      calls.push({ method, text: p.get('text'), message_id: p.get('message_id') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: method === 'sendMessage' ? ++next : Number(p.get('message_id')) } }));
    }, 700));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const w = world({ api: `http://127.0.0.1:${server.address().port}`, ms: 400 });
    marker(w, 'r1', { storyId: '1.1' }); marker(w, 'r2', { storyId: '2.2' });
    stop(w, 'r1', transcript(w, 'r1', [userRec('x'), agentRec('¿r1?')]));
    stop(w, 'r2', transcript(w, 'r2', [userRec('x'), agentRec('¿r2?')]));
    await waitFor(() => calls.filter((c) => c.method === 'sendMessage').length >= 2 && calls.some((c) => c.method === 'editMessageText'), 15000);
    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 2);
    assert.match(sends[1].text, /1\.1/); assert.match(sends[1].text, /2\.2/);
    assert.ok(calls.some((c) => c.method === 'editMessageText'), 'el primero se reescribe');
    const lm = await waitFor(() => { try { const x = JSON.parse(fs.readFileSync(path.join(w.dir, 'last-message.json'), 'utf8')); return x.sessions.length === 2 ? x : null; } catch { return null; } });
    assert.ok(lm, 'el archivo compartido termina con las dos esperas');
    assert.deepStrictEqual([...lm.sessions].sort(), ['r1', 'r2']);
  } finally { await new Promise((r) => server.close(r)); }
});

test('T23 Notified_ForgetsTheTimerPid — avisada la espera, su pid ya no se mata después', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 'pd');
    stop(w, 'pd', transcript(w, 'pd', [userRec('x'), agentRec('¿pd?')]));
    const f = await waitFor(() => { const x = waitFile(w, 'pd'); return x && x.notified ? x : null; });
    assert.ok(f, 'avisó');
    assert.strictEqual(f.pid, null, 'el proceso del plazo terminó: su pid no se guarda (otro proceso puede reusarlo)');
  } finally { await tg.close(); }
});

test('T24 BackgroundTaskPending_NotAWaitForThePerson — con una tarea de fondo sin terminar no avisa', async () => {
  const tg = await fakeTelegram();
  try {
    const w = world({ api: tg.url });
    marker(w, 'bg');
    const tp = transcript(w, 'bg', [
      userRec('corré la suite'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: bx7k2. Output is being written to: /tmp/x' }] } },
      agentRec('La suite corre de fondo; te aviso cuando termine.'),
    ]);
    stop(w, 'bg', tp);
    const l = await waitFor(() => logLines(w).find((x) => x.session === 'bg'));
    assert.strictEqual(l && l.result, 'kept-working', 'el agente espera su tarea, no a la persona');
    assert.strictEqual(tg.calls.length, 0);
    // control: la misma tarea ya terminada (llegó su aviso) sí deja avisar
    const w2 = world({ api: tg.url });
    marker(w2, 'bg2');
    const tp2 = transcript(w2, 'bg2', [
      userRec('corré la suite'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: bx7k3.' }] } },
      { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>bx7k3</task-id>\n<status>completed</status>\n</task-notification>' } },
      agentRec('¿Mergeo bg2?'),
    ]);
    stop(w2, 'bg2', tp2);
    assert.ok(await waitFor(() => tg.calls.find((c) => /bg2|Mergeo/.test(c.text || ''))), 'con la tarea terminada avisa');
  } finally { await tg.close(); }
});

test('T26 SyncSubagent_IsNotABackgroundTask — un subagente en primer plano también imprime su agentId: no calla el aviso', () => {
  const { backgroundPending } = require(HOOK);
  const w = world({});
  const tr = (txt) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: txt }] }] } });
  const sync = transcript(w, 'sy', [tr('[Subagent hand-back] The text below is the final report…\nagentId: a1b2c3d4e5 (internal ID)')]);
  assert.strictEqual(backgroundPending(sync), false, 'el informe de un subagente síncrono no es una tarea pendiente');
  const asy = transcript(w, 'as', [tr('Async agent launched successfully.\nagentId: f00ba4c0de (internal ID)')]);
  assert.strictEqual(backgroundPending(asy), true, 'control: el de fondo sí');
  const wf = transcript(w, 'wf', [tr('Workflow launched in background. Task ID: wiqpoux0v\nSummary: …')]);
  assert.strictEqual(backgroundPending(wf), true, 'control: un workflow de fondo sí');
});

test('T27 ErrorPaths_LeaveTheirLine — configuración rota, edición rechazada, plazo mal escrito, PostToolUse, otra Notification', async () => {
  // (a) la configuración de la máquina rota: config-error, y nada más
  const a = world({ api: 'http://127.0.0.1:9', chat: null });
  fs.mkdirSync(path.join(a.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(a.home, '.claude', 'tycon.json'), '{roto');
  marker(a, 'e1');
  stop(a, 'e1', transcript(a, 'e1', [userRec('x'), agentRec('¿?')]));
  assert.strictEqual((logLines(a).find((l) => l.session === 'e1') || {}).result, 'config-error');
  assert.strictEqual(waitFile(a, 'e1'), null);
  // (b) un plazo mal escrito en la máquina: config-problem, y el plazo de siempre
  const b = world({ api: 'http://127.0.0.1:9', extraEnv: { TYCON_WAIT_NOTICE_MS: 'cinco' } });
  marker(b, 'e2');
  stop(b, 'e2', transcript(b, 'e2', [userRec('x'), agentRec('¿?')]));
  assert.ok(logLines(b).some((l) => l.event === 'config-problem' && /TYCON_WAIT_NOTICE_MS/.test(l.problem)));
  const fb = waitFile(b, 'e2'); if (fb && fb.pid) try { process.kill(fb.pid); } catch { /* ya no está */ }
  // (c) PostToolUse de una pregunta: answered; (d) una Notification que no es de permiso: no abre nada
  const c = world({ api: 'http://127.0.0.1:9', ms: 30000 });
  marker(c, 'e3');
  const tp = transcript(c, 'e3', [userRec('x'), agentRec('¿?')]);
  hook(c, { hook_event_name: 'PreToolUse', session_id: 'e3', transcript_path: tp, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '¿e3?' }] } });
  hook(c, { hook_event_name: 'PostToolUse', session_id: 'e3', transcript_path: tp, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {} });
  assert.strictEqual((logLines(c).find((l) => l.session === 'e3') || {}).result, 'answered');
  hook(c, { hook_event_name: 'Notification', session_id: 'e3', transcript_path: tp, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.strictEqual(waitFile(c, 'e3'), null);
  // (e) Telegram rechaza la edición del mensaje anterior: edit-failed, y el aviso nuevo sale igual
  let n = 100; const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = req.url.split('/').pop(); calls.push(method);
      if (method === 'editMessageText') { res.writeHead(400); res.end('{"ok":false}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: ++n } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const e = world({ api: `http://127.0.0.1:${server.address().port}` });
    marker(e, 'e4'); marker(e, 'e5');
    stop(e, 'e4', transcript(e, 'e4', [userRec('x'), agentRec('¿e4?')]));
    await waitFor(() => (waitFile(e, 'e4') || {}).notified);
    stop(e, 'e5', transcript(e, 'e5', [userRec('x'), agentRec('¿e5?')]));
    const ef = await waitFor(() => logLines(e).find((l) => l.event === 'edit-failed'));
    assert.ok(ef, 'la edición rechazada deja su línea');
    assert.strictEqual(calls.filter((m) => m === 'sendMessage').length, 2);
  } finally { await new Promise((r) => server.close(r)); }
});

test('T25 RedactBeforeCut — una credencial partida por el corte de 200 caracteres no se escapa', () => {
  const { buildMessage } = require(HOOK);
  const tok = 'ghp_' + 'A'.repeat(36);
  const t = buildMessage([{ story: '9.9', step: '5', waiting: 'x'.repeat(185) + tok }], {});
  assert.doesNotMatch(t, /ghp_A/, 'ni el pedazo del token');
});

// ── T19 · AC 15 ────────────────────────────────────────────────────────────────────────────────────────────────
test('T19 Codex_OnlyStop — del lado Codex, sólo el cierre de turno', () => {
  const raw = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
  const events = Object.entries(raw.hooks || {}).filter(([, groups]) => JSON.stringify(groups).includes('wait-notice.js')).map(([e]) => e);
  assert.deepStrictEqual(events, ['Stop']);
});
