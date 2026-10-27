#!/usr/bin/env node
/**
 * agents-per-run.test.js — red de `scripts/metrics/agents-per-run.js`.
 *
 * Lo que fija, y por qué cada caso:
 *   · T10: el contexto inicial de un agente es entrada + caché creada + caché leída de su PRIMERA respuesta, y una
 *     respuesta que llega en varias líneas con el mismo id se cuenta una vez (si no, los tokens salen inflados), con la
 *     salida de su última línea (la de las primeras es parcial);
 *   · T11: cada agente cae en su clase (validador, revisor, pase adversarial, ayudante, otro) y la ejecución da su
 *     mediana y su p90;
 *   · T11b: el pase adversarial es el workflow que nombra el marcador archivado (el último, si se relanzó); los demás
 *     workflows de la ventana se listan aparte y no se suman, y sus agentes no se cuentan como ayudantes; si el pase
 *     corrió en otra sesión, se busca en la que anota el marcador;
 *   · T12: con todas las sesiones, la tabla por ejecución, el resumen, la línea «fuera de una ejecución» y la
 *     ejecución cuya sesión ya no está;
 *   · T13: un agente sin conversación o sin números de consumo sale «no medido» con su motivo, nunca un cero;
 *   · 🔴 T14: la salida no trae NINGÚN texto de conversación: el medidor lee sólo los números de consumo. Cada campo de
 *     texto de las sesiones armadas lleva una marca, y la prueba sale en rojo si la marca aparece en la salida o si
 *     algo de la salida trae un campo fuera de la lista permitida.
 *
 * Todo contra sesiones armadas en un tmpdir: no se lee ninguna conversación real.
 *
 * Correr: node scripts/tests/agents-per-run.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MOD = path.resolve(__dirname, '..', 'metrics', 'agents-per-run.js');
const CONVERSATION_TEXT = 'TEXTO-DE-CONVERSACION-QUE-NO-SALE';

let n = 0;
function t(name, fn) {
  n++;
  try { fn(); console.log(`  ok ${n} - ${name}`); }
  catch (e) { console.error(`  FAIL ${n} - ${name}\n    ${e && e.message}`); process.exitCode = 1; }
}

const usage = (input, created, read, output = 10) => ({
  input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output,
});

/** El padrón de revisores sale de una carpeta de agentes: acá, dos revisores falsos. */
function makeAgentsDir(root) {
  const d = path.join(root, 'agents');
  fs.mkdirSync(d, { recursive: true });
  for (const name of ['tycon-ac-coverage-checker', 'tycon-plugin-security-basics']) {
    fs.writeFileSync(path.join(d, `${name}.md`), `---\nname: ${name}\nmodel: sonnet\n---\n${CONVERSATION_TEXT}\n`);
  }
  return d;
}

/**
 * La conversación y el meta de un agente. Cada respuesta puede repetirse en varias líneas (`lines`), como las escribe
 * el modelo. Todo campo de texto lleva la marca.
 */
function writeAgent(dir, id, { type, start, responses = [], noConversation = false }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({
    agentType: type, description: CONVERSATION_TEXT, toolUseId: `tu-${id}`,
  }));
  if (noConversation) return;
  const lines = [
    { type: 'user', timestamp: start, uuid: `${id}-u`, message: { role: 'user', content: CONVERSATION_TEXT } },
    { type: 'attachment', timestamp: start, uuid: `${id}-a`, attachment: { text: CONVERSATION_TEXT } },
  ];
  // `streamed`: la misma respuesta en varias líneas, cada una con su consumo (la salida crece hasta la última)
  responses.forEach((r, i) => {
    const count = r.streamed ? r.streamed.length : (r.lines || 1);
    for (let k = 0; k < count; k++) {
      lines.push({
        type: 'assistant', timestamp: r.ts || start, uuid: `${id}-r${i}-${k}`,
        message: {
          id: `msg-${id}-${i}`, role: 'assistant', model: r.model || 'claude-sonnet-5-5', usage: r.streamed ? r.streamed[k] : r.usage,
          content: [{ type: 'text', text: CONVERSATION_TEXT }],
        },
      });
    }
  });
  fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function makeSession(projectsDir, sid) {
  const d = path.join(projectsDir, '-proyecto-falso', sid);
  fs.mkdirSync(path.join(d, 'subagents'), { recursive: true });
  return d;
}

function writeWorkflow(sesDir, runId, { agentCount, totalTokens, startTime }) {
  fs.mkdirSync(path.join(sesDir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(sesDir, 'workflows', `${runId}.json`), JSON.stringify({
    runId, agentCount, totalTokens, startTime: Date.parse(startTime), timestamp: startTime,
    script: CONVERSATION_TEXT, summary: CONVERSATION_TEXT, result: CONVERSATION_TEXT, logs: [CONVERSATION_TEXT],
  }));
}

function writeDump(historyDir, { story, sid, startedAt, archivedAt, runId, passSid }) {
  fs.mkdirSync(historyDir, { recursive: true });
  const adversarial = passSid ? { runId, sessionId: passSid } : { runId };
  fs.writeFileSync(path.join(historyDir, `${story}-${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    archivedAt,
    marker: { storyId: story, sessionId: sid, startedAt, ...(runId ? { adversarial } : {}), notes: CONVERSATION_TEXT },
  }));
}

/**
 * La ejecución de la story de prueba en la sesión s1, de 10:00 a 12:00: un validador (su respuesta en tres líneas), dos revisores, un ayudante,
 * un tipo desconocido y el pase relanzado — wf-old a las 10:15 y wf-1, el último, a las 10:20 (5 agentes). Un agente
 * a las 14:00, fuera de toda ejecución.
 */
function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-'));
  const projectsDir = path.join(root, 'projects');
  const historyDir = path.join(root, 'history');
  const s1 = makeSession(projectsDir, 's1');
  const sub = path.join(s1, 'subagents');
  writeAgent(sub, 'val', { type: 'tycon-story-validator', start: '2026-10-20T10:05:00.000Z', responses: [{ usage: usage(1, 1000, 0), lines: 3 }] });
  writeAgent(sub, 'rev1', { type: 'tycon-ac-coverage-checker', start: '2026-10-20T10:30:00.000Z', responses: [{ usage: usage(2, 2000, 0) }] });
  writeAgent(sub, 'rev2', { type: 'tycon-plugin-security-basics', start: '2026-10-20T10:31:00.000Z', responses: [{ usage: usage(3, 3000, 0) }] });
  writeAgent(sub, 'help', { type: 'general-purpose', start: '2026-10-20T10:10:00.000Z', responses: [{ usage: usage(4, 4000, 0) }] });
  writeAgent(sub, 'odd', { type: 'tipo-que-nadie-conoce', start: '2026-10-20T10:40:00.000Z', responses: [{ usage: usage(5, 5000, 0) }] });
  writeAgent(sub, 'late', { type: 'Explore', start: '2026-10-20T14:00:00.000Z', responses: [{ usage: usage(6, 6000, 0) }] });
  writeWorkflow(s1, 'wf-old', { agentCount: 9, totalTokens: 900000, startTime: '2026-10-20T10:15:00.000Z' });
  writeWorkflow(s1, 'wf-1', { agentCount: 5, totalTokens: 500000, startTime: '2026-10-20T10:20:00.000Z' });
  writeWorkflow(s1, 'wf-after', { agentCount: 3, totalTokens: 300000, startTime: '2026-10-20T15:00:00.000Z' });
  writeDump(historyDir, { story: '1.1', sid: 's1', startedAt: '2026-10-20T10:00:00.000Z', archivedAt: '2026-10-20T12:00:00.000Z', runId: 'wf-1' });
  return { root, projectsDir, historyDir, s1, agentsDir: makeAgentsDir(root) };
}

const measure = (sc, extra = {}) => require(MOD).measure({
  projectsDir: sc.projectsDir, historyDir: sc.historyDir, agentsDir: sc.agentsDir, session: 's1', ...extra,
});

t('T10 StartingContext_SumsFirstResponse: contexto inicial de la primera respuesta, cada respuesta una vez', () => {
  const sc = scenario();
  writeAgent(path.join(sc.s1, 'subagents'), 'three', {
    type: 'tycon-ac-coverage-checker', start: '2026-10-20T11:00:00.000Z',
    responses: [
      { ts: '2026-10-20T11:00:01.000Z', usage: usage(7, 12000, 300, 40), lines: 2 },
      { ts: '2026-10-20T11:00:05.000Z', usage: usage(1, 500, 12300, 60) },
      { ts: '2026-10-20T11:00:09.000Z', usage: usage(1, 200, 12800, 80) },
    ],
  });
  const a = measure(sc).runs[0].agents.find((x) => x.id === 'three');
  assert.strictEqual(a.startingContext, 7 + 12000 + 300);
  assert.strictEqual(a.model, 'claude-sonnet-5-5');
  assert.strictEqual(a.startedAt, '2026-10-20T11:00:00.000Z');
  assert.strictEqual(a.responses, 3, 'la primera respuesta llegó en dos líneas y cuenta una vez');
  assert.strictEqual(a.tokens, (7 + 12000 + 300 + 40) + (1 + 500 + 12300 + 60) + (1 + 200 + 12800 + 80));
  assert.strictEqual(a.reason, null);

  // la respuesta que llega en varias líneas trae la salida final en la última: ésa es la que cuenta
  writeAgent(path.join(sc.s1, 'subagents'), 'streamed', {
    type: 'tycon-ac-coverage-checker', start: '2026-10-20T11:05:00.000Z',
    responses: [{ streamed: [usage(2, 2833, 9437, 16), usage(2, 2833, 9437, 205)] }],
  });
  const st = measure(sc).runs[0].agents.find((x) => x.id === 'streamed');
  assert.strictEqual(st.responses, 1);
  assert.strictEqual(st.startingContext, 2 + 2833 + 9437);
  assert.strictEqual(st.tokens, 2 + 2833 + 9437 + 205, 'la salida de la última línea, no la parcial de la primera');
  // la última línea sin consumo deja la anterior, y se dice; una respuesta entera sin consumo, también
  writeAgent(path.join(sc.s1, 'subagents'), 'lastzero', {
    type: 'Explore', start: '2026-10-20T11:06:00.000Z',
    responses: [{ streamed: [usage(2, 100, 0, 16), usage(0, 0, 0, 0)] }, { usage: usage(1, 10, 0) }, { usage: usage(0, 0, 0, 0) }],
  });
  const lz = measure(sc).runs[0].agents.find((x) => x.id === 'lastzero');
  assert.strictEqual(lz.tokens, (2 + 100 + 16) + (1 + 10 + 10));
  assert.match(lz.reason, /medido parcial: 1 respuesta sin consumo en su última línea · 1 respuesta sin ningún consumo/);
  assert.strictEqual(lz.startingContext, 2 + 100, 'la primera respuesta se quedó con su línea anterior');
  // la primera respuesta sin consumo: el contexto inicial no sale de la segunda
  writeAgent(path.join(sc.s1, 'subagents'), 'firstzero', {
    type: 'Explore', start: '2026-10-20T11:07:00.000Z',
    responses: [{ usage: usage(0, 0, 0, 0) }, { usage: usage(1, 10, 0) }],
  });
  const fz = measure(sc).runs[0].agents.find((x) => x.id === 'firstzero');
  assert.strictEqual(fz.startingContext, null, 'no se toma la segunda como si fuera la primera');
  assert.strictEqual(fz.tokens, 1 + 10 + 10);
  assert.match(fz.reason, /contexto inicial no medido: la primera respuesta no trae consumo/);
  // lo medido parcial suma, y el total lo dice: es un piso
  const partialRun = measure(sc).runs[0];
  assert.ok(partialRun.partialAgents >= 2);
  assert.match(require(MOD).render(measure(sc)), /tokens de los agentes: [\d.]+ · \d+ medidos parcial \(el total es un piso\)/);
  assert.deepStrictEqual(Object.keys(require(MOD)).sort(), ['measure', 'render'], 'el módulo exporta sólo measure y render');

  // una línea con consumo que no se puede leer: lo medido se suma y el motivo dice que es parcial
  const sub = path.join(sc.s1, 'subagents');
  writeAgent(sub, 'broken', { type: 'Explore', start: '2026-10-20T11:10:00.000Z', responses: [{ usage: usage(2, 200, 0) }] });
  fs.appendFileSync(path.join(sub, 'agent-broken.jsonl'), '{"type":"assistant","message":{"usage":{"input_tokens":5\n');
  const b = measure(sc).runs[0].agents.find((x) => x.id === 'broken');
  assert.strictEqual(b.tokens, 2 + 200 + 0 + 10);
  assert.match(b.reason, /parcial: 1 línea/);
});

t('T11 PerRun_CountsByClass: validador 1, revisor 2, ayudante 1, otro 1 con su tipo; mediana y p90', () => {
  const run = measure(scenario()).runs[0];
  assert.strictEqual(run.story, '1.1');
  assert.deepStrictEqual(run.byClass, { validator: 1, reviewer: 2, adversarial: 5, helper: 1, other: 1 });
  assert.deepStrictEqual(run.otherTypes, { 'tipo-que-nadie-conoce': 1 });
  assert.strictEqual(run.totalAgents, 10, '5 propios y 5 del pase');
  assert.ok(!run.agents.some((a) => a.id === 'late'), 'el de las 14:00 no es de esta ejecución');
  // contextos iniciales medidos: 1001, 2002, 3003, 4004, 5005
  assert.strictEqual(run.startingContext.measured, 5);
  assert.strictEqual(run.startingContext.median, 3003);
  assert.strictEqual(run.startingContext.p90, 4604.6);
  assert.strictEqual(run.agents.find((x) => x.id === 'val').tokens, 1 + 1000 + 0 + 10, 'tres líneas, una respuesta');

  // los bordes de la ventana son de la ejecución; un milisegundo después, no. El revisor adversarial de la story es validador
  const sc = scenario();
  const sub = path.join(sc.s1, 'subagents');
  writeAgent(sub, 'atstart', { type: 'tycon-story-adversarial-reviewer', start: '2026-10-20T10:00:00.000Z', responses: [{ usage: usage(1, 1, 0) }] });
  writeAgent(sub, 'atend', { type: 'Explore', start: '2026-10-20T12:00:00.000Z', responses: [{ usage: usage(1, 1, 0) }] });
  writeAgent(sub, 'after', { type: 'Explore', start: '2026-10-20T12:00:00.001Z', responses: [{ usage: usage(1, 1, 0) }] });
  const edges = measure(sc).runs[0];
  assert.ok(edges.agents.some((a) => a.id === 'atstart') && edges.agents.some((a) => a.id === 'atend'));
  assert.ok(!edges.agents.some((a) => a.id === 'after'));
  assert.strictEqual(edges.agents.find((a) => a.id === 'atstart').class, 'validator');
});

t('T11b AdversarialPass_FromWorkflowRunId: el pase es el último runId; los otros workflows, aparte y sin sumar', () => {
  const sc = scenario();
  let run = measure(sc).runs[0];
  assert.strictEqual(run.adversarial.runId, 'wf-1');
  assert.strictEqual(run.adversarial.agents, 5);
  assert.strictEqual(run.adversarial.tokens, 500000);
  // sin las conversaciones del pase guardadas: no medido, con su motivo
  assert.strictEqual(run.adversarial.startingContext.measured, 0);
  assert.strictEqual(run.adversarial.startingContext.median, null);
  assert.match(run.adversarial.reason, /no medido/);
  // el relanzado queda a la vista y no se suma; el de las 15:00 cae fuera de la ventana
  assert.deepStrictEqual(run.otherWorkflows, [{ runId: 'wf-old', agents: 9, tokens: 900000, startTime: '2026-10-20T10:15:00.000Z' }]);
  const own = run.agents.reduce((s, a) => s + a.tokens, 0);
  assert.strictEqual(run.tokens, own + 500000);
  assert.match(require(MOD).render(measure(sc)), /wf-old.*no se suma/);

  // con las conversaciones del pase guardadas, su contexto inicial se mide y no se cuentan como ayudantes
  const wfDir = path.join(sc.s1, 'subagents', 'workflows', 'wf-1');
  writeAgent(wfDir, 'p1', { type: 'general-purpose', start: '2026-10-20T10:21:00.000Z', responses: [{ usage: usage(1, 100, 0) }] });
  writeAgent(wfDir, 'p2', { type: 'general-purpose', start: '2026-10-20T10:22:00.000Z', responses: [{ usage: usage(1, 300, 0) }] });
  run = measure(sc).runs[0];
  assert.strictEqual(run.adversarial.startingContext.measured, 2);
  assert.strictEqual(run.adversarial.startingContext.median, 201);
  assert.strictEqual(run.adversarial.reason, null);
  assert.strictEqual(run.byClass.helper, 1);
  assert.strictEqual(run.totalAgents, 10, 'el pase sigue contando por su workflow, una vez');

  // el workflow del pase sin totalTokens: el total de la ejecución lo dice
  writeWorkflow(sc.s1, 'wf-1', { agentCount: 5, startTime: '2026-10-20T10:20:00.000Z' });
  run = measure(sc).runs[0];
  assert.strictEqual(run.adversarial.tokens, null);
  assert.match(require(MOD).render(measure(sc)), /tokens de los agentes: [\d.]+ \+ el pase no medido/);

  // el pase corrió en otra sesión (el marcador lo dice): su workflow se busca ahí
  const other = scenario();
  const s9 = makeSession(other.projectsDir, 's9');
  writeWorkflow(s9, 'wf-9', { agentCount: 4, totalTokens: 400 });
  writeAgent(path.join(s9, 'subagents', 'workflows', 'wf-9'), 'q1', { type: 'general-purpose', start: '2026-10-20T10:25:00.000Z', responses: [{ usage: usage(1, 50, 0) }] });
  writeDump(other.historyDir, { story: '1.1', sid: 's1', startedAt: '2026-10-20T10:00:00.000Z', archivedAt: '2026-10-20T12:00:00.000Z', runId: 'wf-9', passSid: 's9' });
  const moved = measure(other).runs[0];
  assert.strictEqual(moved.adversarial.agents, 4, 'el pase de la otra sesión se mide');
  assert.strictEqual(moved.adversarial.tokens, 400);
  assert.strictEqual(moved.adversarial.startingContext.median, 51);
  assert.strictEqual(moved.adversarial.reason, null);
  assert.ok(!measure(other, { session: null, all: true }).readErrors.some((e) => e.name === 'wf-9'), 'el pase de otra sesión no necesita hora');

  // la sesión del pase que no está en la máquina se nombra: no se cae en silencio a la de la ejecución
  writeDump(other.historyDir, { story: '1.1', sid: 's1', startedAt: '2026-10-20T10:00:00.000Z', archivedAt: '2026-10-20T12:00:00.000Z', runId: 'wf-9', passSid: 's-borrada' });
  assert.match(measure(other).runs[0].adversarial.reason, /la sesión del pase \(s-borrada\) no está en la máquina/);
  // aunque la sesión de la ejecución tenga un workflow con ese runId: el pase no se busca en otra
  writeWorkflow(other.s1, 'wf-9', { agentCount: 7, totalTokens: 700, startTime: '2026-10-20T10:25:00.000Z' });
  const strict = measure(other).runs[0].adversarial;
  assert.strictEqual(strict.agents, null);
  assert.match(strict.reason, /s-borrada/);
  // una sesión del pase anotada que no es texto no se adivina
  fs.writeFileSync(path.join(other.historyDir, '1.1-2026-10-20T10-00-00-000Z.json'), JSON.stringify({
    archivedAt: '2026-10-20T12:00:00.000Z', marker: { storyId: '1.1', sessionId: 's1', startedAt: '2026-10-20T10:00:00.000Z', adversarial: { runId: 'wf-9', sessionId: 9 } },
  }));
  assert.match(measure(other).runs[0].adversarial.reason, /sesión del pase sin un id legible/);

  // las conversaciones del pase que no se pueden leer van a lo no leído, y no pisan el otro motivo
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  // la carpeta de workflows de la sesión del pase que no se puede leer: el pase lo dice con su código
  const wfLocked = path.join(s9, 'workflows');
  writeDump(other.historyDir, { story: '1.1', sid: 's1', startedAt: '2026-10-20T10:00:00.000Z', archivedAt: '2026-10-20T12:00:00.000Z', runId: 'wf-9', passSid: 's9' });
  fs.chmodSync(wfLocked, 0o000);
  try {
    assert.match(measure(other).runs[0].adversarial.reason, /no se pudo leer la carpeta de workflows \(EACCES\)/);
  } finally {
    fs.chmodSync(wfLocked, 0o755);
  }
  const locked = path.join(sc.s1, 'subagents', 'workflows', 'wf-1');
  fs.chmodSync(locked, 0o000);
  try {
    const lr = measure(sc);
    assert.ok(lr.readErrors.some((e) => e.where === 'subagents' && e.name === 'wf-1' && e.reason === 'EACCES'));
    assert.match(lr.runs[0].adversarial.reason, /agentCount o totalTokens.*EACCES/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

t('T12 All_SummaryAcrossSessions: tabla, resumen, «fuera de una ejecución» y la ejecución sin sesión', () => {
  const sc = scenario();
  const s2 = makeSession(sc.projectsDir, 's2');
  writeAgent(path.join(s2, 'subagents'), 'x', { type: 'tycon-ac-coverage-checker', start: '2026-10-21T09:10:00.000Z', responses: [{ usage: usage(1, 90000, 0, 5000000) }] });
  writeDump(sc.historyDir, { story: '2.2', sid: 's2', startedAt: '2026-10-21T09:00:00.000Z', archivedAt: '2026-10-21T10:00:00.000Z' });
  writeDump(sc.historyDir, { story: '3.3', sid: 'sesion-borrada', startedAt: '2026-10-22T09:00:00.000Z', archivedAt: '2026-10-22T10:00:00.000Z' });
  const r = measure(sc, { session: null, all: true });
  assert.deepStrictEqual(r.runs.map((x) => x.story), ['1.1', '2.2']);
  assert.strictEqual(r.unmeasuredRuns.length, 1);
  assert.strictEqual(r.unmeasuredRuns[0].story, '3.3');
  assert.match(r.unmeasuredRuns[0].reason, /sesión/);
  assert.strictEqual(r.summary.runs, 2);
  assert.strictEqual(r.summary.agentsPerRun.median, 5.5, 'mediana de 10 y 1');
  assert.strictEqual(r.summary.agentsPerRun.p90, 9.1);
  assert.strictEqual(r.summary.heaviestClass, 'reviewer', 'el revisor de 5 M pesa más que el pase de 500 k');
  assert.strictEqual(r.outsideRuns.agents, 1, 'el de las 14:00');
  assert.deepStrictEqual(r.outsideRuns.byClass, { helper: 1 });
  assert.strictEqual(r.outsideRuns.tokens, 6 + 6000 + 0 + 10);
  const text = require(MOD).render(r);
  assert.match(text, /1\.1/);
  assert.match(text, /2\.2/);
  assert.match(text, /fuera de una ejecución/);
  assert.match(text, /3\.3.*no medid/);
  assert.match(text, /clase que más pesa.*en las ejecuciones/);
  const usageErr = spawnSync(process.execPath, [MOD], { encoding: 'utf8' });
  assert.strictEqual(usageErr.status, 2, 'sin --session ni --all sale 2');
  assert.match(usageErr.stderr, /--session|--all/);
  const noValue = spawnSync(process.execPath, [MOD, '--session', '--json'], { encoding: 'utf8' });
  assert.strictEqual(noValue.status, 2, '--session sin valor sale 2');
  const cli = (args) => spawnSync(process.execPath, [MOD, ...args, '--projects-dir', sc.projectsDir, '--history-dir', sc.historyDir], { encoding: 'utf8' });
  const unknown = cli(['--session', 'sesion-que-no-existe']);
  assert.strictEqual(unknown.status, 1, 'una sesión que no está no es «0 ejecuciones»');
  assert.match(unknown.stderr, /no se encontró/);
  const both = cli(['--session', 's1', '--all']);
  assert.strictEqual(both.status, 2, '--session y --all juntos no se adivinan');
  for (const k of ['--projects-dir', '--history-dir']) {
    assert.strictEqual(spawnSync(process.execPath, [MOD, '--all', k], { encoding: 'utf8' }).status, 2, `${k} sin valor sale 2`);
  }
  // una opción mal escrita no se ignora: leería la carpeta de por defecto sin decirlo
  const typo = cli(['--all', '--history-folder', sc.historyDir]);
  assert.strictEqual(typo.status, 2);
  assert.match(typo.stderr, /opción desconocida: --history-folder/);
  // sin la carpeta de agentes, los revisores salen como «otro»: se dice
  const noAgents = require(MOD).measure({ projectsDir: sc.projectsDir, historyDir: sc.historyDir, agentsDir: path.join(sc.root, 'sin-agentes'), session: 's1' });
  assert.ok(noAgents.readErrors.some((e) => e.where === 'agents' && /ENOENT: los revisores salen como «otro»/.test(e.reason)));
  // el historial de por defecto que no existe no se dice: una máquina sin ejecuciones no tiene nada roto
  const quiet = require(MOD).measure({ projectsDir: sc.projectsDir, historyDir: path.join(sc.root, 'no-existe'), agentsDir: sc.agentsDir, all: true });
  assert.ok(!quiet.readErrors.some((e) => e.where === 'history'));
  const noHistory = spawnSync(process.execPath, [MOD, '--all', '--json', '--projects-dir', sc.projectsDir, '--history-dir', path.join(sc.root, 'no-existe')], { encoding: 'utf8' });
  assert.strictEqual(noHistory.status, 0);
  assert.ok(JSON.parse(noHistory.stdout).readErrors.some((e) => e.where === 'history' && e.reason === 'ENOENT'), 'un historial pedido que no está se dice');
  overlapsAndUnreadable();
  edgesOfTheRun();
});

/** T12, segunda parte: ventanas que se pisan, sesión sin agentes y lo que no se pudo leer. */
function overlapsAndUnreadable() {
  // dos ejecuciones de s1 que se pisan: cada agente va a la última que arrancó antes que él, una sola vez
  const sc = scenario();
  writeDump(sc.historyDir, { story: '1.2', sid: 's1', startedAt: '2026-10-20T10:30:00.000Z', archivedAt: '2026-10-20T11:30:00.000Z' });
  let r = measure(sc);
  const ids = (story) => r.runs.find((x) => x.story === story).agents.map((a) => a.id).sort();
  assert.deepStrictEqual(ids('1.1'), ['help', 'val']);
  assert.deepStrictEqual(ids('1.2'), ['odd', 'rev1', 'rev2']);

  // una sesión que sigue en la máquina sin carpeta de agentes: medida, con cero agentes
  fs.writeFileSync(path.join(sc.projectsDir, '-proyecto-falso', 's3.jsonl'), '');
  writeDump(sc.historyDir, { story: '3.1', sid: 's3', startedAt: '2026-10-23T09:00:00.000Z', archivedAt: '2026-10-23T10:00:00.000Z' });
  // un volcado ilegible y otro sin sesión: «no medida» con su motivo, no desaparecen
  fs.writeFileSync(path.join(sc.historyDir, '9.9-roto.json'), '{"marker": {"storyId": "9.9"');
  fs.writeFileSync(path.join(sc.historyDir, '9.8-sin-sesion.json'), JSON.stringify({ archivedAt: '2026-10-24T10:00:00.000Z', marker: { storyId: '9.8' } }));
  r = measure(sc, { session: null, all: true });
  const s3 = r.runs.find((x) => x.story === '3.1');
  assert.ok(s3, 'la sesión sin agentes se mide');
  assert.strictEqual(s3.totalAgents, 0);
  const broken = r.unmeasuredRuns.find((u) => u.file === '9.9-roto.json');
  assert.ok(broken, 'el volcado ilegible queda a la vista');
  assert.match(broken.reason, /ilegible/);
  assert.match(r.unmeasuredRuns.find((u) => u.file === '9.8-sin-sesion.json').reason, /sesión/);

  // una carpeta que no se puede leer no es «no hay»
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const project = path.join(sc.projectsDir, '-proyecto-falso');
  fs.chmodSync(project, 0o000);
  fs.chmodSync(sc.historyDir, 0o000);
  try {
    r = measure(sc, { session: null, all: true });
    assert.ok(r.readErrors.some((e) => e.where === 'project' && /EACCES|EPERM/.test(e.reason)), 'el proyecto ilegible se dice');
    assert.ok(r.readErrors.some((e) => e.where === 'history' && /EACCES|EPERM/.test(e.reason)), 'el historial ilegible se dice');
    assert.match(require(MOD).render(r), /no se pudo leer/);
    const lost = spawnSync(process.execPath, [MOD, '--session', 's1', '--projects-dir', sc.projectsDir, '--history-dir', sc.historyDir], { encoding: 'utf8' });
    assert.strictEqual(lost.status, 1);
    assert.match(lost.stderr, /no se pudo leer: project/, 'el «no se encontró» dice qué no se pudo leer');
  } finally {
    fs.chmodSync(project, 0o755);
    fs.chmodSync(sc.historyDir, 0o755);
  }
}

/** T12, tercera parte: los bordes de la ventana, del pase y de las carpetas. */
function edgesOfTheRun() {
  const sc = scenario();
  // una ventana al revés y un pase con un runId que no es texto: a la vista, con su motivo
  writeDump(sc.historyDir, { story: '4.1', sid: 's1', startedAt: '2026-10-20T13:00:00.000Z', archivedAt: '2026-10-20T12:30:00.000Z' });
  writeDump(sc.historyDir, { story: '4.2', sid: 's1', startedAt: '2026-10-20T16:00:00.000Z', archivedAt: '2026-10-20T17:00:00.000Z', runId: 42 });
  // al pase no le hace falta la hora; a otro workflow sí, para ubicarlo
  writeWorkflow(sc.s1, 'wf-1', { agentCount: 5, totalTokens: 500000 });
  writeWorkflow(sc.s1, 'wf-sin-hora', { agentCount: 2, totalTokens: 20 });
  // la misma sesión en otro proyecto y un proyecto enlazado
  fs.mkdirSync(path.join(sc.projectsDir, '-zeta-proyecto', 's1', 'subagents'), { recursive: true });
  const real = path.join(sc.root, 'proyecto-real');
  fs.mkdirSync(path.join(real, 's5', 'subagents'), { recursive: true });
  fs.symlinkSync(real, path.join(sc.projectsDir, '-enlazado'));
  writeDump(sc.historyDir, { story: '5.1', sid: 's5', startedAt: '2026-10-25T09:00:00.000Z', archivedAt: '2026-10-25T10:00:00.000Z' });
  // la memoria que cada proyecto guarda en su carpeta no es una sesión
  for (const p of ['-proyecto-falso', '-zeta-proyecto']) {
    fs.mkdirSync(path.join(sc.projectsDir, p, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(sc.projectsDir, p, 'memory', 'MEMORY.md'), CONVERSATION_TEXT);
  }
  assert.strictEqual(measure(sc, { session: 'memory' }).missingSession, true, 'la carpeta de memoria no es una sesión');
  const r = measure(sc, { session: null, all: true });
  assert.ok(!r.readErrors.some((e) => e.name === 'memory'), 'la carpeta de memoria no sale como sesión repetida');
  assert.match(r.unmeasuredRuns.find((u) => u.story === '4.1').reason, /ventana/);
  const bad = r.runs.find((x) => x.story === '4.2');
  assert.strictEqual(bad.adversarial.runId, '(ilegible)');
  assert.strictEqual(bad.adversarial.agents, null);
  assert.match(bad.adversarial.reason, /runId/);
  assert.strictEqual(r.runs.find((x) => x.story === '1.1').adversarial.agents, 5, 'el pase sin hora se mide igual');
  assert.ok(!r.readErrors.some((e) => e.name === 'wf-1'), 'al pase no le hace falta la hora');
  assert.ok(r.readErrors.some((e) => e.name === 'wf-sin-hora' && /startTime/.test(e.reason)), 'otro workflow sin hora se dice');
  assert.ok(r.readErrors.some((e) => e.where === 'session' && e.name === 's1' && /repetida/.test(e.reason)), 'la sesión repetida se dice');
  assert.ok(r.runs.some((x) => x.story === '5.1'), 'la sesión del proyecto enlazado se mide');

  // enlaces rotos, de proyecto o de sesión: se dicen, no desaparecen
  fs.symlinkSync(path.join(sc.root, 'no-existe'), path.join(sc.projectsDir, '-roto'));
  fs.symlinkSync(path.join(sc.root, 'no-existe'), path.join(sc.projectsDir, '-proyecto-falso', 's-rota'));
  const links = measure(sc, { session: null, all: true });
  assert.ok(links.readErrors.some((e) => e.where === 'project' && e.name === '-roto' && e.reason === 'ENOENT'), 'el proyecto enlazado roto se dice');
  assert.ok(links.readErrors.some((e) => e.where === 'session' && e.name === 's-rota' && e.reason === 'ENOENT'), 'la sesión enlazada rota se dice');
  // la conversación de una sesión que es un enlace a un archivo también la hace sesión
  const target = path.join(sc.root, 'conversacion-real.jsonl');
  fs.writeFileSync(target, '');
  fs.symlinkSync(target, path.join(sc.projectsDir, '-proyecto-falso', 's-enlazada.jsonl'));
  writeDump(sc.historyDir, { story: '5.2', sid: 's-enlazada', startedAt: '2026-10-25T11:00:00.000Z', archivedAt: '2026-10-25T12:00:00.000Z' });
  assert.ok(measure(sc, { session: null, all: true }).runs.some((x) => x.story === '5.2'), 'la sesión enlazada a un archivo se mide');

  // un meta que no se puede leer no es «sin tipo»
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  // una carpeta de sesión sin permiso no desaparece: se dice con su código
  const closed = path.join(sc.projectsDir, '-proyecto-falso', 's-cerrada');
  fs.mkdirSync(path.join(closed, 'subagents'), { recursive: true });
  fs.chmodSync(closed, 0o000);
  try {
    assert.ok(measure(sc, { session: null, all: true }).readErrors.some((e) => e.where === 'session' && e.name === 's-cerrada' && e.reason === 'EACCES'));
  } finally {
    fs.chmodSync(closed, 0o755);
  }
  // la carpeta de agentes de la sesión que no se puede leer: la ejecución no se mide, con su código
  const s1sub = path.join(sc.s1, 'subagents');
  fs.chmodSync(s1sub, 0o000);
  try {
    const u = measure(sc).unmeasuredRuns.find((x) => x.story === '1.1');
    assert.ok(u, 'la ejecución queda a la vista');
    assert.match(u.reason, /no se pudo leer la carpeta de agentes \(EACCES\)/);
  } finally {
    fs.chmodSync(s1sub, 0o755);
  }
  const meta = path.join(sc.s1, 'subagents', 'agent-help.meta.json');
  fs.chmodSync(meta, 0o000);
  try {
    assert.strictEqual(measure(sc).runs[0].agents.find((a) => a.id === 'help').type, '(meta ilegible)');
  } finally {
    fs.chmodSync(meta, 0o644);
  }
}

t('T13 MissingUsage_NotMeasuredWithReason: sin conversación o sin consumo, «no medido» con motivo', () => {
  const sc = scenario();
  const sub = path.join(sc.s1, 'subagents');
  writeAgent(sub, 'noconv', { type: 'tycon-ac-coverage-checker', start: '2026-10-20T11:00:00.000Z', noConversation: true });
  const at = new Date('2026-10-20T11:00:00.000Z');
  fs.utimesSync(path.join(sub, 'agent-noconv.meta.json'), at, at);
  writeAgent(sub, 'nouse', { type: 'tycon-ac-coverage-checker', start: '2026-10-20T11:01:00.000Z', responses: [] });
  const run = measure(sc).runs[0];
  const noconv = run.agents.find((a) => a.id === 'noconv');
  const nouse = run.agents.find((a) => a.id === 'nouse');
  assert.ok(noconv && nouse, 'los dos caen en la ejecución');
  for (const a of [noconv, nouse]) {
    assert.strictEqual(a.startingContext, null, 'nunca un cero');
    assert.strictEqual(a.tokens, null, 'nunca un cero');
  }
  assert.match(noconv.reason, /conversación/);
  assert.match(nouse.reason, /consumo/);
  assert.strictEqual(run.startingContext.unmeasured, 2);
  assert.strictEqual(run.startingContext.measured, 5, 'los no medidos no entran en la mediana');
  assert.strictEqual(run.unmeasuredAgents, 2, 'el total de tokens dice cuántos no suma');
  assert.match(require(MOD).render(measure(sc)), /tokens de los agentes: [\d.]+ · 2 no medidos/);

  // un consumo en cero o sin números es «sin consumo», no un cero medido; un meta ilegible no es «sin tipo»
  writeAgent(sub, 'zero', { type: 'Explore', start: '2026-10-20T11:02:00.000Z', responses: [{ usage: usage(0, 0, 0, 0) }] });
  writeAgent(sub, 'words', { type: 'Explore', start: '2026-10-20T11:03:00.000Z', responses: [{ usage: { input_tokens: 'mucho' } }] });
  writeAgent(sub, 'badmeta', { type: 'Explore', start: '2026-10-20T11:04:00.000Z', responses: [{ usage: usage(1, 1, 0) }] });
  fs.writeFileSync(path.join(sub, 'agent-badmeta.meta.json'), '{"agentType": ');
  // el workflow del pase ilegible: el pase no se mide y el total de agentes lo dice
  fs.writeFileSync(path.join(sc.s1, 'workflows', 'wf-1.json'), '{"agentCount": 5,');
  const r = measure(sc);
  const again = r.runs[0];
  for (const id of ['zero', 'words']) {
    const a = again.agents.find((x) => x.id === id);
    assert.strictEqual(a.startingContext, null, `${id}: nunca un cero`);
    assert.match(a.reason, /consumo/);
  }
  assert.strictEqual(again.agents.find((x) => x.id === 'badmeta').type, '(meta ilegible)');
  assert.strictEqual(again.adversarial.agents, null);
  assert.match(again.adversarial.reason, /ilegible/);
  assert.strictEqual(r.summary.agentsPerRun.excluded, 1, 'la ejecución sin su pase no entra en agentes por ejecución');
  assert.strictEqual(r.summary.agentsPerRun.median, null);
  assert.match(require(MOD).render(r), /agentes: 10 \+ el pase no medido/);

  // sin hora de arranque, sin salida, o un JSON que es null: nada tira el medidor ni pasa por medido completo
  writeAgent(sub, 'nohour', { type: 'Explore', start: 'no-es-una-fecha', responses: [{ usage: usage(1, 1, 0) }] });
  writeAgent(sub, 'noout', { type: 'Explore', start: '2026-10-20T11:06:00.000Z', responses: [{ usage: { input_tokens: 3, cache_creation_input_tokens: 30 } }] });
  writeAgent(sub, 'nullmeta', { type: 'Explore', start: '2026-10-20T11:07:00.000Z', responses: [{ usage: usage(1, 1, 0) }] });
  fs.writeFileSync(path.join(sub, 'agent-nullmeta.meta.json'), 'null');
  fs.writeFileSync(path.join(sub, 'agent-nullconv.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  fs.writeFileSync(path.join(sub, 'agent-nullconv.jsonl'), 'null\n');
  fs.writeFileSync(path.join(sc.s1, 'workflows', 'wf-after.json'), 'null');
  const edge = measure(sc);
  const outside = edge.outsideRuns.list;
  assert.match(outside.find((a) => a.id === 'nohour').reason, /sin hora de arranque/);
  assert.ok(outside.some((a) => a.id === 'nullconv'), 'una conversación que es null no tira el medidor');
  const noout = edge.runs[0].agents.find((a) => a.id === 'noout');
  assert.strictEqual(noout.tokens, 33);
  assert.match(noout.reason, /parcial.*sin salida/);
  assert.strictEqual(edge.runs[0].agents.find((a) => a.id === 'nullmeta').type, '(meta ilegible)');
  assert.ok(edge.readErrors.some((e) => e.name === 'wf-after' && e.reason === 'JSON ilegible'));
  // el resumen por clase dice cuánto no suma
  assert.strictEqual(edge.summary.unmeasuredAgents, 4);
  assert.strictEqual(edge.summary.unmeasuredPasses, 1);
  assert.match(require(MOD).render(edge), /clase que más pesa.*sin sumar: 4 agentes no medidos y 1 pase no medido/);

  // sin nada medido no hay clase que más pese: se dice «no medido», no se nombra una ganadora en cero
  const empty = scenario();
  for (const f of fs.readdirSync(path.join(empty.s1, 'subagents'))) {
    if (!f.endsWith('.jsonl')) continue;
    const conv = path.join(empty.s1, 'subagents', f);
    fs.writeFileSync(conv, fs.readFileSync(conv, 'utf8').split('\n')[0] + '\n');
  }
  writeWorkflow(empty.s1, 'wf-1', { agentCount: 5, startTime: '2026-10-20T10:20:00.000Z' });
  const none = measure(empty);
  assert.ok(none.runs[0].agents.length > 0 && none.runs[0].unmeasuredAgents === none.runs[0].agents.length, 'agentes en la ejecución, ninguno medido');
  assert.strictEqual(none.summary.heaviestClass, null);
  assert.deepStrictEqual(none.summary.tokensByClass, {}, 'una clase sin medir no es una clase en cero');
  assert.doesNotMatch(require(MOD).render(none), /(validador|revisor|ayudante|otro) 0\b/);
  assert.match(require(MOD).render(none), /clase que más pesa[^\n]*: no medido/);

  // la conversación que no se puede mirar no es «sin conversación»; la hora del meta que falla, tampoco en silencio
  const odd = scenario();
  const osub = path.join(odd.s1, 'subagents');
  writeAgent(osub, 'loop', { type: 'Explore', start: '2026-10-20T11:00:00.000Z', noConversation: true });
  fs.symlinkSync('agent-loop.jsonl', path.join(osub, 'agent-loop.jsonl'));
  fs.symlinkSync(path.join(odd.root, 'no-existe'), path.join(osub, 'agent-ghost.meta.json'));
  // sin tipo y sin modelo: se dicen con su nombre
  fs.writeFileSync(path.join(osub, 'agent-notype.meta.json'), JSON.stringify({ description: CONVERSATION_TEXT }));
  const inWindow = new Date('2026-10-20T11:00:00.000Z');
  fs.utimesSync(path.join(osub, 'agent-notype.meta.json'), inWindow, inWindow);
  const o = measure(odd, { session: null, all: true });
  const all = [...o.runs.flatMap((x) => x.agents), ...o.outsideRuns.list];
  assert.match(all.find((a) => a.id === 'loop').reason, /no se pudo leer la conversación \(ELOOP\)/);
  assert.match(all.find((a) => a.id === 'ghost').reason, /hora del meta \(ENOENT\)/);
  assert.strictEqual(all.find((a) => a.id === 'notype').type, '(sin tipo)');
  assert.match(require(MOD).render(o), /modelo no medido/);
});

const AGENT_FIELDS = ['id', 'type', 'class', 'model', 'startedAt', 'startingContext', 'tokens', 'responses', 'reason'];
const PASS_FIELDS = ['runId', 'agents', 'tokens', 'startTime', 'startingContext', 'reason'];
const WORKFLOW_FIELDS = ['runId', 'agents', 'tokens', 'startTime'];

function onlyAllowed(obj, allowed, what) {
  for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `campo no permitido en ${what}: ${k}`);
}

t('T14 ReadsOnlyUsageFields: la salida no trae ningún texto de conversación', () => {
  const sc = scenario();
  writeAgent(path.join(sc.s1, 'subagents', 'workflows', 'wf-1'), 'p1', { type: 'general-purpose', start: '2026-10-20T10:21:00.000Z', responses: [{ usage: usage(1, 100, 0) }] });
  writeAgent(path.join(sc.s1, 'subagents'), 'noconv', { type: 'tycon-ac-coverage-checker', start: '2026-10-20T11:00:00.000Z', noConversation: true });
  const s2 = makeSession(sc.projectsDir, 's2');
  writeAgent(path.join(s2, 'subagents'), 'x', { type: 'tycon-ac-coverage-checker', start: '2026-10-21T09:10:00.000Z', responses: [{ usage: usage(1, 9, 0) }] });
  writeDump(sc.historyDir, { story: '2.2', sid: 's2', startedAt: '2026-10-21T09:00:00.000Z', archivedAt: '2026-10-21T10:00:00.000Z' });
  writeDump(sc.historyDir, { story: '3.3', sid: 'sesion-borrada', startedAt: '2026-10-22T09:00:00.000Z', archivedAt: '2026-10-22T10:00:00.000Z' });
  // la marca también en los caminos de error y en los campos que sí se copian
  const sub = path.join(sc.s1, 'subagents');
  writeAgent(sub, 'tsmark', { type: 'Explore', start: CONVERSATION_TEXT, responses: [{ ts: CONVERSATION_TEXT, usage: usage(1, 1, 0) }] });
  writeAgent(sub, 'typemark', { type: `${CONVERSATION_TEXT} con texto`, start: '2026-10-20T11:05:00.000Z', responses: [{ model: `${CONVERSATION_TEXT}\u001b[31m`, usage: usage(1, 1, 0) }] });
  fs.writeFileSync(path.join(sc.s1, 'workflows', 'wf-roto.json'), `{"runId": "wf-roto", "summary": "${CONVERSATION_TEXT}`);
  fs.writeFileSync(path.join(sc.historyDir, '9.9-roto.json'), `{"marker": {"notes": "${CONVERSATION_TEXT}`);
  // la marca en los nombres: el agente, el volcado, la story, la sesión, el pase y las carpetas que no se leen
  const MARK = `${CONVERSATION_TEXT} nombre`;
  writeAgent(sub, MARK, { type: 'Explore', start: '2026-10-20T11:06:00.000Z', responses: [{ usage: usage(1, 1, 0) }] });
  fs.writeFileSync(path.join(sc.historyDir, `${MARK}.json`), '{');
  fs.writeFileSync(path.join(sc.historyDir, '9.7-marca.json'), JSON.stringify({
    archivedAt: '2026-10-24T10:00:00.000Z',
    marker: { storyId: MARK, sessionId: MARK, startedAt: '2026-10-24T09:00:00.000Z', adversarial: { runId: MARK } },
  }));
  const locked = [];
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    const markProject = path.join(sc.projectsDir, `-${MARK}`);
    fs.mkdirSync(markProject);
    const markSession = path.join(sc.projectsDir, '-proyecto-falso', MARK);
    fs.mkdirSync(path.join(markSession, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(markSession, 'workflows'));
    locked.push(markProject, path.join(markSession, 'subagents'), path.join(markSession, 'workflows'));
    for (const d of locked) fs.chmodSync(d, 0o000);
  }
  try {
    readsOnlyUsage(sc, locked.length > 0);
  } finally {
    for (const d of locked) fs.chmodSync(d, 0o755);
  }
});

function readsOnlyUsage(sc, withLocked) {
  const env = { ...process.env, TYCON_AGENTS_DIR: sc.agentsDir };
  const common = ['--projects-dir', sc.projectsDir, '--history-dir', sc.historyDir];
  for (const args of [['--session', 's1'], ['--session', 's1', '--json'], ['--all'], ['--all', '--json']]) {
    const p = spawnSync(process.execPath, [MOD, ...args, ...common], { encoding: 'utf8', env });
    assert.strictEqual(p.status, 0, `${args.join(' ')} sale 0: ${p.stderr}`);
    assert.ok(p.stdout.length > 50, `${args.join(' ')} escribió algo`);
    assert.ok(!p.stdout.includes(CONVERSATION_TEXT) && !p.stderr.includes(CONVERSATION_TEXT), `${args.join(' ')}: la salida trae texto de una conversación`);
  }
  // un campo nuevo con texto tiene que pasar por esta lista
  const r = measure(sc, { session: null, all: true });
  for (const a of [...r.runs.flatMap((x) => x.agents), ...r.outsideRuns.list]) onlyAllowed(a, AGENT_FIELDS, 'un agente');
  for (const run of r.runs) {
    if (run.adversarial) onlyAllowed(run.adversarial, PASS_FIELDS, 'el pase');
    for (const w of run.otherWorkflows) onlyAllowed(w, WORKFLOW_FIELDS, 'otro workflow');
  }
  for (const u of r.unmeasuredRuns) onlyAllowed(u, ['story', 'sessionId', 'startedAt', 'file', 'reason'], 'una ejecución no medida');
  for (const e of r.readErrors) onlyAllowed(e, ['where', 'name', 'reason'], 'un error de lectura');
  assert.ok(r.readErrors.some((e) => e.name === 'wf-roto'), 'el workflow ilegible se dice');
  if (withLocked) {
    for (const where of ['project', 'subagents', 'workflows']) {
      assert.ok(r.readErrors.some((e) => e.where === where && e.name === '(ilegible)'), `el error de ${where} sale sin el nombre`);
    }
  }
}

console.log(`${n} casos`);
