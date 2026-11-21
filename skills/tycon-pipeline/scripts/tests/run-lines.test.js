#!/usr/bin/env node
'use strict';
// run-lines.test.js — los renglones de una corrida (un renglón por paso y el renglón final), y lo que imprimen y avisan
// `marker.js complete-step`, `marker.js clear` y `marker.js pr`. Todo con HOME vacía, marcadores y volcados de juguete y
// un Telegram falso (`TYCON_TELEGRAM_API`): nunca se mira una corrida real ni sale un aviso real.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync, spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const RL = require(path.join(SCRIPTS, 'lib', 'run-lines.js'));
const { buildWip } = require(path.join(RAIZ, 'scripts', 'tools', 'work-in-progress.js'));

const T0 = Date.parse('2026-11-16T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 52 min de trabajo; 10 de espera de la persona (aprobar el plan) y 4 entre pasos (50 → 54)
const TIEMPOS = {
  start: { startedAt: at(0), completedAt: at(2) },
  'validate-story': { startedAt: at(2), completedAt: at(10) },
  plan: { startedAt: at(10), completedAt: at(20) },
  'approve-plan': { startedAt: at(20), completedAt: at(30) },
  implement: { startedAt: at(30), completedAt: at(46) },
  'run-tests': { startedAt: at(46), completedAt: at(50) },
  reviewers: { startedAt: at(54), completedAt: at(66) },
};
const HASTA_REVISORES = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests'];
const TODOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'];

// una carpeta de juguete: repo con .advisors, carpeta de la corrida, carpeta de evidencia y carpeta de estado vacía
function juguete() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lines-'));
  const repo = path.join(base, 'repo');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.9-20261116100000');
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  const stateDir = path.join(base, 'state');
  for (const d of [runDir, evidence, stateDir]) fs.mkdirSync(d, { recursive: true });
  return { base, repo, runDir, evidence, stateDir };
}

const marcador = (j, extra = {}) => ({
  storyId: '9.9', sessionId: 'sid-1', repoPath: j.repo, runDir: j.runDir, evidenceDir: j.evidence, startedAt: at(0),
  stepScheme: 2, stepsCompleted: [], stepsPending: [...TODOS], stepTimings: {}, iterations: {}, checks: {}, ...extra,
});
const textos = (ls) => ls.map((l) => l.text);
const deUnPaso = (ls, id) => ls.find((l) => l.id === id);

test('RL1 Lines_OnePerStartedStep_InOrder_WithMark @story-8.293 @ac-1', () => {
  const j = juguete();
  const m = marcador(j, {
    stepsCompleted: HASTA_REVISORES, stepsPending: TODOS.slice(6),
    stepTimings: { ...TIEMPOS, reviewers: { startedAt: at(54) } },
    checks: { tests: 'red:exit=1' },
    adversarialSkip: { motivo: 'riesgo bajo' },
  });
  const ls = RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  assert.deepStrictEqual(ls.map((l) => l.id), [...HASTA_REVISORES, 'reviewers', 'adversarial-pass'], textos(ls).join('\n'));
  assert.deepStrictEqual(ls.map((l) => l.mark), ['✓', '✓', '✓', '✓', '✓', '✗', '●', '–']);
  for (const l of ls) assert.match(l.text, new RegExp(`^${l.mark} ${l.name} — .+`));
  assert.strictEqual(deUnPaso(ls, 'adversarial-pass').text, '– Pase adversarial — salteado: riesgo bajo');
  assert.ok(!ls.some((l) => ['findings', 'live-check', 'prepare-commit'].includes(l.id)), 'los no empezados no salen');
});

test('RL2 Motive_FromData_NeverInvented @story-8.293 @ac-2', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', cuando: at(30), tipo: 'manual', quien: 'Ana' })}\n`);
  fs.writeFileSync(path.join(j.repo, '.advisors', 'tests-result.json'), JSON.stringify({ story_id: '9.9', totals: { passed: 41, failed: 0, failures: [] } }));
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([{ rule: 'SEC-W1', severity: 'WARNING', disposition: 'open', file: 'a.js' }]));
  fs.writeFileSync(path.join(j.evidence, '9.9-runtime-matrix.md'), [
    '| AC | Veredicto | Evidencia runtime | Evidencia código | Razón (si imposible) |', '|---|---|---|---|---|',
    '| #1 | 🟢 RUNTIME | smoke | T1 | — |', '| #2 | 🟢 RUNTIME | smoke | T2 | — |', '| #3 | 🟢 RUNTIME | smoke | T3 | — |', ''].join('\n'));
  const gatesAntes = path.join(j.stateDir, 'gates.log');
  fs.writeFileSync(gatesAntes, `${JSON.stringify({ ts: at(70), name: 'extra-round', story: '9.9', iter: 4 })}\n`);
  const antes = fs.readFileSync(gatesAntes, 'utf8');
  const m = marcador(j, {
    stepsCompleted: [...TODOS], stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true,
    stepTimings: { ...TIEMPOS, findings: { startedAt: at(66), completedAt: at(70) }, 'prepare-commit': { startedAt: at(71), completedAt: at(75) } },
    iterations: { 1: { at: at(56) }, 2: { at: at(62) } }, checks: { tests: 'green' },
    adversarialPasses: [{ ts: at(68), confirmados: 3 }], pr: { number: 12, merged: false },
  });
  const aislado = { home: j.base, env: {} };
  const ls = RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, ...aislado });
  const motivo = (id) => deUnPaso(ls, id).text.split(' — ').slice(1).join(' — ');
  assert.strictEqual(motivo('validate-story'), 'validada; avisos sin registrar');
  assert.strictEqual(motivo('approve-plan'), 'aprobado por Ana');
  assert.strictEqual(motivo('run-tests'), '41 verdes');
  assert.match(motivo('reviewers'), /^2 vueltas de revisores \(tope 3\); quedó abierto: 1 como deuda \(SEC-W1\)/);
  assert.strictEqual(motivo('adversarial-pass'), '3 hallazgos confirmados');
  assert.strictEqual(motivo('live-check'), '3/3 criterios en verde');
  assert.strictEqual(motivo('prepare-commit'), 'pedido #12 abierto');
  assert.strictEqual(motivo('plan'), 'hecho en 10 min');
  assert.strictEqual(motivo('implement'), 'hecho en 16 min');
  for (const l of ls) assert.ok(l.text.split(' — ').slice(1).join(' — ').length <= 120, l.text);
  // sin dato: un hueco se ve como hueco
  const vacio = RL.lines({ marker: marcador(j, { stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: TODOS.slice(4), runDir: path.join(j.base, 'no-existe'), stepTimings: {} }), stateDir: j.stateDir, gatesLog: [] });
  assert.strictEqual(deUnPaso(vacio, 'approve-plan').text, '✓ Aprobar el plan — sin motivo registrado');
  assert.strictEqual(deUnPaso(vacio, 'plan').text, '✓ Armar el plan — sin motivo registrado');
  // una firma automática sin nombre no se atribuye a nadie
  const sinNombre = path.join(j.base, 'sin-nombre');
  fs.mkdirSync(sinNombre);
  fs.writeFileSync(path.join(sinNombre, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', cuando: at(30), tipo: 'automatica', quien: 'sin nombrar' })}\n`);
  const anonima = RL.lines({ marker: marcador(j, { stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: TODOS.slice(4), runDir: sinNombre }), stateDir: j.stateDir, gatesLog: [] });
  assert.strictEqual(deUnPaso(anonima, 'approve-plan').text, '✓ Aprobar el plan — aprobado; quién, sin registrar');
  // en rojo: el motivo dice qué falló
  fs.writeFileSync(path.join(j.repo, '.advisors', 'tests-result.json'), JSON.stringify({ story_id: '9.9', totals: { passed: 40, failed: 2, failures: ['scripts/tests/a.test.js', 'scripts/tests/b.test.js'] } }));
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([{ rule: 'SEC-C1', severity: 'CRITICAL', disposition: 'open', file: 'b.js' }]));
  fs.writeFileSync(path.join(j.evidence, '9.9-runtime-matrix.md'), ['| #1 | 🟢 RUNTIME | smoke | T1 | — |', '| #2 | 🟢 RUNTIME | smoke | T2 | — |', '| #3 | 🔴 SIN-EVIDENCIA | — | — | — |', ''].join('\n'));
  const rojo = RL.lines({ marker: { ...m, checks: { tests: 'red:exit=1', acmatrix: 'red' } }, runDir: j.runDir, stateDir: j.stateDir, ...aislado });
  assert.strictEqual(deUnPaso(rojo, 'run-tests').text, '✗ Correr las pruebas — 2 rojas: scripts/tests/a.test.js');
  assert.strictEqual(deUnPaso(rojo, 'reviewers').text, '✗ Revisores — vuelta 2 de 4: SEC-C1');
  assert.strictEqual(deUnPaso(rojo, 'live-check').text, '✗ Probar en vivo — 1 criterios sin evidencia: AC 3');
  // armar los renglones no escribe nada en gates.log (nota de la revisión del plan)
  assert.strictEqual(fs.readFileSync(gatesAntes, 'utf8'), antes);
  // un motivo largo se corta en 120 con «…»
  assert.strictEqual(RL.recortar('x'.repeat(130)).length, 120);
  assert.ok(RL.recortar('x'.repeat(130)).endsWith('…'));
});

const volcado = (j, extra = {}) => ({
  archivedAt: at(80),
  marker: marcador(j, { stepsCompleted: [...TODOS], stepsPending: [], stepTimings: TIEMPOS, iterations: { 1: {}, 2: {} }, cierre: { estado: 'completa' }, ...extra }),
  gates: [],
});

test('RL3 Final_EnteredWorkWaitRoundsSignatures @story-8.293 @ac-3', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), [
    { que: 'plan', cuando: at(30), tipo: 'manual', quien: 'Ana' },
    { que: 'guardar', cuando: at(75), tipo: 'automatica', quien: 'agente coordinadora', delegacion: 'ana@example.com' },
    { que: 'push', cuando: at(76), tipo: 'automatica', quien: 'agente coordinadora', delegacion: 'ana@example.com' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const gatesLog = [{ ts: at(70), name: 'extra-round', story: '9.9', iter: 3 }];
  const linea = RL.final({ dump: volcado(j, { pr: { number: 148, merged: true } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog });
  assert.strictEqual(linea, 'entró el pedido #148 — 52 min de trabajo, 14 min de espera, 2 vueltas (+1 extra), 1 firma de una persona y 2 de la coordinadora');
});

test('RL4 Final_NotEntered_And_NotMeasured @story-8.293 @ac-3', () => {
  const j = juguete();
  const sinFirmas = path.join(j.base, 'sin-corrida');
  // (a) cerrada sin pedido
  const a = RL.final({ dump: volcado(j, { cierre: { estado: 'abortada', motivo: 'la persona la canceló' } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  assert.match(a, /^no entró: la persona la canceló — /);
  // (b) sin tiempos, sin registro de firmas y sin pedido: la línea sale igual
  const b = RL.final({ dump: volcado(j, { stepTimings: undefined }), runDir: sinFirmas, stateDir: j.stateDir, gatesLog: [] });
  assert.strictEqual(b, 'pedido: no medido — trabajo no medido, espera no medida, 2 vueltas, firmas de una persona no medidas');
  // (c) pedido sin merge
  const c = RL.final({ dump: volcado(j, { pr: { number: 7 } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  assert.match(c, /^pedido #7 abierto, espera la cola — 52 min de trabajo, 14 min de espera, 2 vueltas, firmas de una persona no medidas$/);
});

test('RL5 SameText_SessionWipNotice @story-8.293 @ac-4', () => {
  const j = juguete();
  const sid = 'mismo-texto-1';
  const story = path.join(j.repo, 'story-9.9.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\ntitle: "el mismo texto"\n---\n# Story\n');
  const now = new Date(T0 + 60 * 60000).toISOString();
  const m = marcador(j, { sessionId: sid, storyPath: story, lastTouch: now, stepsCompleted: HASTA_REVISORES, stepsPending: TODOS.slice(6), stepTimings: { ...TIEMPOS, reviewers: { startedAt: at(54) } }, checks: { tests: 'green' } });
  // la sesión: el renglón del paso en curso
  const sesion = RL.stateLine({ marker: m, stateDir: j.stateDir, gatesLog: [] });
  assert.strictEqual(sesion, `● Revisores — en curso desde las ${hhmm(at(54))}`);
  // /wip: la misma corrida en una máquina de juguete con su sesión viva
  const sessions = path.join(j.base, 'sessions');
  const home = path.join(j.base, 'home');
  for (const d of [path.join(j.stateDir, 'active'), sessions, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(j.stateDir, 'active', `${sid}.json`), JSON.stringify(m));
  fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: 'mismo', status: 'busy', statusUpdatedAt: Date.parse(now) }));
  const w = buildWip({ home, stateDir: j.stateDir, sessionsDir: sessions, now });
  const i = w.extra.findIndex((x) => x.storyId === '9.9');
  assert.ok(i >= 0, JSON.stringify(w.rows));
  assert.strictEqual(w.extra[i].stepLine, sesion);
  // el aviso: el renglón final y los ✗ salen del mismo armado
  const ls = RL.lines({ marker: { ...m, checks: { tests: 'red:exit=1' } }, stateDir: j.stateDir, gatesLog: [] });
  const aviso = RL.noticeText({ storyId: '9.9', title: 'el mismo texto', lines: ls, final: 'pedido: no medido' });
  const rojo = deUnPaso(ls, 'run-tests').text;
  assert.ok(aviso.split('\n').includes(rojo), aviso);
  assert.ok(!aviso.includes('✓ '), 'el aviso lleva sólo los ✗');
});

test('RL6 Lines_FromDumpAfterClose @story-8.293 @ac-1 @ac-3', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', cuando: at(30), tipo: 'automatica', quien: 'revisión automática (opus)' })}\n`);
  const m = marcador(j, { stepsCompleted: HASTA_REVISORES, stepsPending: TODOS.slice(6), stepTimings: TIEMPOS, checks: { tests: 'green' } });
  const vivo = RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  const dump = JSON.parse(JSON.stringify({ archivedAt: at(90), marker: m, gates: [] }));
  const archivado = RL.lines({ marker: dump.marker, runDir: j.runDir, stateDir: j.stateDir, gatesLog: dump.gates });
  assert.deepStrictEqual(textos(archivado), textos(vivo));
  assert.strictEqual(deUnPaso(vivo, 'approve-plan').text, '✓ Aprobar el plan — aprobado por la revisión automática');
  assert.match(RL.final({ dump, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] }), /^pedido: no medido — 52 min de trabajo/);
});

// ── Integración: marker.js con HOME vacía ─────────────────────────────────────────────────────

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lines-mk-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
  const FECHA = '2026-11-16T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-renglones.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\ntitle: "los renglones"\nstatus: in-progress\n---\n# Story 9.9\n');
  git('add', '.'); git('commit', '-qm', 'inicio');
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', 'renglones__9.9-20261116100000');
  fs.mkdirSync(runDir, { recursive: true });
  const limpio = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TYCON_|TELEGRAM_|CLAUDE_)/.test(k)) limpio[k] = v;
  const env = (sid, extra) => ({ ...limpio, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', ...(extra || {}) });
  const correr = (args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), ...args], { encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo, timeout: 60000 });
  // sin bloquear: el Telegram falso vive en este mismo proceso y tiene que poder contestar
  const correrAsync = (args, sid, extra) => new Promise((resolve) => {
    const h = spawn(process.execPath, [path.join(SCRIPTS, 'marker.js'), ...args], { env: env(sid, extra), cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    h.stdout.on('data', (d) => { stdout += d; }); h.stderr.on('data', (d) => { stderr += d; });
    h.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const activo = (sid) => path.join(stateDir, 'active', `${sid}.json`);
  const escribir = (sid, m) => { fs.mkdirSync(path.dirname(activo(sid)), { recursive: true }); fs.writeFileSync(activo(sid), JSON.stringify(m)); };
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const base9 = (sid, extra) => ({
    storyId: '9.9', sessionId: sid, storyPath: story, repoPath: repo, runDir, startedAt: at(0),
    stepScheme: 2, iterations: {}, checks: {}, ...extra,
  });
  return { base, home, repo, story, stateDir, runDir, correr, correrAsync, escribir, leer, activo, base9 };
}

function telegramFalso({ status = 200 } = {}) {
  return new Promise((resolve) => {
    const recibidos = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; }).on('end', () => {
        recibidos.push(b);
        res.statusCode = status;
        res.end(status === 200 ? JSON.stringify({ ok: true, result: { message_id: 1 } }) : JSON.stringify({ ok: false, description: 'caído' }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, recibidos, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const conTelegram = (url) => ({ TYCON_TELEGRAM_API: url, TELEGRAM_BOT_TOKEN: '1:falso', TYCON_TELEGRAM_CHAT_ID: '5' });
const textoDe = (cuerpo) => { try { return JSON.parse(cuerpo).text || ''; } catch (_) { return new URLSearchParams(String(cuerpo)).get('text') || ''; } };

test('MK1 CompleteStep_PrintsStepLine @story-8.293 @ac-5', () => {
  const E = entorno();
  const sid = 'mk1-sesion';
  fs.writeFileSync(path.join(E.repo, '.advisors', 'tests-result.json'), JSON.stringify({ story_id: '9.9', totals: { passed: 7, failed: 0, failures: [] } }));
  E.escribir(sid, E.base9(sid, {
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'], stepsPending: TODOS.slice(5),
    checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' },
  }));
  const r = E.correr(['complete-step', 'run-tests'], sid);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).storyId, '9.9', 'la salida estándar sigue siendo el marcador en JSON');
  const ultima = r.stderr.trimEnd().split('\n').pop();
  assert.strictEqual(ultima, '[paso] ✓ Correr las pruebas — 7 verdes');
  // el mismo armado que usan /wip y el aviso
  assert.strictEqual(ultima, `[paso] ${RL.stepLine({ marker: E.leer(sid), stateDir: E.stateDir }, 'run-tests')}`);
  const skill =fs.readFileSync(path.join(SCRIPTS, '..', 'SKILL.md'), 'utf8');
  const paso11 = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.match(skill, /\[paso\]/);
  assert.match(paso11, /renglones de la corrida/);
});

test('MK2 Clear_PrintsLinesAndFinal @story-8.293 @ac-3 @ac-6', () => {
  const E = entorno();
  const sid = 'mk2-sesion';
  E.escribir(sid, E.base9(sid, { stepsCompleted: [...TODOS], stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true }));
  const pr = E.correr(['pr', '12'], sid);
  assert.strictEqual(pr.status, 0, pr.stderr);
  assert.deepStrictEqual(E.leer(sid).pr, { number: 12, merged: false });
  const c = E.correr(['clear'], sid);
  assert.strictEqual(c.status, 0, c.stderr);
  const err = c.stderr.split('\n');
  const iFinal = err.findIndex((l) => l.startsWith('[corrida] pedido #12 abierto, espera la cola — '));
  assert.ok(iFinal >= 0, c.stderr);
  assert.ok(err.findIndex((l) => l.startsWith('[corrida] ✓ Arranque')) < iFinal, 'los renglones van antes del renglón final');
  assert.ok(err.findIndex((l) => l.startsWith('[marker] timing dump archivado')) < iFinal);
  // después del merge, sin marcador vivo: el pedido entra al volcado
  const m = E.correr(['pr', '12', '--merged', '--story', '9.9'], 'otra-sesion');
  assert.strictEqual(m.status, 0, m.stderr);
  assert.match(m.stdout + m.stderr, /entró el pedido #12 — /);
  const hist = path.join(E.stateDir, 'timing-history');
  const archivo = fs.readdirSync(hist).filter((f) => f.startsWith('9.9-') && f.endsWith('.json')).sort().pop();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(hist, archivo), 'utf8')).marker.pr, { number: 12, merged: true });
  const copia = fs.readdirSync(E.runDir).filter((f) => f.startsWith('timing-dump-') && f.endsWith('.json')).sort().pop();
  assert.ok(copia, 'la copia del volcado en la carpeta de la corrida');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(E.runDir, copia), 'utf8')).marker.pr, { number: 12, merged: true });
  const paso11 = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  const cierre = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'close-work-item.md'), 'utf8');
  assert.match(paso11, /marker\.js pr /);
  assert.match(cierre, /marker\.js pr <n> --merged/);
  assert.match(cierre, /renglón final/);
});

test('MK3 Clear_Notice_OncePerRun_NoChannelNoFail @story-8.293 @ac-8', async (t) => {
  const cerrar = (E, sid, extra) => {
    E.escribir(sid, E.base9(sid, { stepsCompleted: TODOS.slice(0, 6), stepsPending: TODOS.slice(6), checks: { tests: 'red:exit=1' } }));
    return E.correrAsync(['clear'], sid, extra);
  };
  // (a) un canal que guarda lo que recibe: un aviso, con el título, el ✗ y el renglón final
  const tg = await telegramFalso();
  const roto = await telegramFalso({ status: 500 });
  t.after(async () => { await tg.close(); await roto.close(); });
  const a = await cerrar(entorno(), 'mk3-a', conTelegram(tg.url));
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(tg.recibidos.length, 1, a.stderr);
  const texto = textoDe(tg.recibidos[0]);
  assert.match(texto, /9\.9 · los renglones/);
  assert.match(texto, /✗ Correr las pruebas — /);
  assert.match(texto, /no entró: .* — trabajo no medido, /);
  assert.ok(!/✓ /.test(texto), texto);
  // (b) sin canal: nada, y sale 0
  const b = await cerrar(entorno(), 'mk3-b', { TYCON_TELEGRAM_API: tg.url });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(!/aviso del cierre/.test(b.stderr), b.stderr);
  assert.strictEqual(tg.recibidos.length, 1, 'sin canal no se manda nada');
  // (c) un canal que falla: una línea en la salida de errores, y sale 0
  const c = await cerrar(entorno(), 'mk3-c', conTelegram(roto.url));
  assert.strictEqual(c.status, 0, c.stderr);
  assert.strictEqual(c.stderr.split('\n').filter((l) => /aviso del cierre/.test(l)).length, 1, c.stderr);
  // (d) un canal prendido que no pasa el ensayo (hay chat y falta el token): una línea, nada enviado, y sale 0
  const antes = tg.recibidos.length;
  const d = await cerrar(entorno(), 'mk3-d', { TYCON_TELEGRAM_API: tg.url, TYCON_TELEGRAM_CHAT_ID: '5' });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.strictEqual(tg.recibidos.length, antes, 'no se mandó nada');
  assert.match(d.stderr, /\[corrida\] el aviso del cierre no salió por telegram: /);
});

// ── Lo que encontró el pase adversarial: cada causa con su prueba ──────────────────────────────

const aislado = (j) => ({ home: j.base, env: {} });
const hasta = (id) => TODOS.slice(0, TODOS.indexOf(id) + 1);
const escribirGates = (j, filas) => fs.writeFileSync(path.join(j.stateDir, 'gates.log'), filas.map((g) => `${typeof g === 'string' ? g : JSON.stringify(g)}\n`).join(''));

test('RG1 AdversarialSkip_RealMarker_SaysSkipped @story-8.293 @ac-1', () => {
  const j = juguete();
  // lo que deja `mark-adversarial-skipped`: el salteo y la bandera en la misma escritura
  const m = marcador(j, { stepsCompleted: hasta('reviewers'), stepsPending: TODOS.slice(7), adversarialSkip: { motivo: 'riesgo bajo: 2 archivos' }, deepReviewDone: true });
  const ls = RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) });
  assert.strictEqual(deUnPaso(ls, 'adversarial-pass').text, '– Pase adversarial — salteado: riesgo bajo: 2 archivos');
});

test('RG2 Reviewers_WithoutFindingsFile_DoesNotSayNothingOpen @story-8.293 @ac-2', () => {
  const j = juguete();
  const m = marcador(j, { stepsCompleted: hasta('reviewers'), stepsPending: TODOS.slice(7), iterations: { 1: {} } });
  const l = deUnPaso(RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'reviewers');
  assert.strictEqual(l.mark, '✓');
  assert.doesNotMatch(l.text, /quedó abierto: nada/);
  assert.match(l.text, /1 vuelta de revisores \(tope 3\); lo abierto no lo pude mirar: /);
  // con el archivo escrito y vacío sí se miró
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), '[]');
  assert.match(deUnPaso(RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'reviewers').text, /quedó abierto: nada/);
});

test('RG3 Reviewers_OtherRoundPending_IsTheCurrentStep @story-8.293 @ac-1 @ac-7', () => {
  const j = juguete();
  execFileSync('git', ['init', '-q', j.repo]);
  fs.mkdirSync(path.join(j.repo, 'scripts'));
  fs.writeFileSync(path.join(j.repo, 'scripts', 'a.js'), '// un arreglo\n');
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), '[]');
  const m = marcador(j, {
    stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], iterations: { 1: {} },
    stepTimings: { ...TIEMPOS, findings: { startedAt: at(66), completedAt: at(70) } },
    fileEvents: [{ ts: at(72), path: path.join(j.repo, 'scripts', 'a.js'), code: true }],
  });
  const o = { marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) };
  assert.strictEqual(deUnPaso(RL.lines(o), 'reviewers').text, '● Revisores — falta la vuelta 2: 1 archivo cambió después de los revisores');
  assert.strictEqual(RL.stateLine(o), '● Revisores — falta la vuelta 2: 1 archivo cambió después de los revisores');
});

// Renglón 555 de la lista semanal: si no se pudo saber si falta otra vuelta, /wip mostraba «Revisores» como paso actual.
// «No medido» no es «falta otra vuelta»: el paso es el real, y el renglón de los revisores dice que no se midió.
test('RG3b Reviewers_RoundNotMeasured_StepIsTheRealOne', () => {
  const j = juguete();
  const m = marcador(j, {
    stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], iterations: { 1: {} },
    stepTimings: { ...TIEMPOS, findings: { startedAt: at(66), completedAt: at(70) }, 'prepare-commit': { startedAt: at(72) } },
  });
  const STEPS_LIB = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const original = STEPS_LIB.reviewersRound;
  STEPS_LIB.reviewersRound = () => { throw new Error('git no contestó'); };
  try {
    const o = { marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) };
    // el primer paso sin hacer de esta corrida es el pase adversarial
    const estado = String(RL.stateLine(o));
    assert.doesNotMatch(estado, /Revisores/, 'no «Revisores»');
    assert.match(estado, /Pase adversarial/, 'el paso real');
    assert.match(deUnPaso(RL.lines(o), 'reviewers').text, /no medido/);
  } finally { STEPS_LIB.reviewersRound = original; }
});

test('RG4 PrepareBrake_OnlyItsOwnAndCurrent @story-8.293 @ac-2', () => {
  const j = juguete();
  const m = marcador(j, {
    stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], deepReviewDone: true, dodRuntimeChecked: true,
    stepTimings: { ...TIEMPOS, 'prepare-commit': { startedAt: at(80) } },
  });
  const linea = (gatesLog) => deUnPaso(RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog, ...aislado(j) }), 'prepare-commit');
  const base = { status: 'blocked', story: '9.9', repoPath: j.repo };
  // un freno de este cierre, de los que se anotan con su paso, y uno que se anota sin paso
  assert.strictEqual(linea([{ ...base, ts: at(81), name: 'review-cap-blocking', step: 8, error: 'no pude mirar lo abierto' }]).text, '✗ Preparar el pull request — no pude mirar lo abierto');
  assert.strictEqual(linea([{ ...base, ts: at(81), name: 'critical-waivers', step: 'prepare-commit' }]).text, '✗ Preparar el pull request — critical-waivers');
  assert.strictEqual(linea([{ ...base, ts: at(81), name: 'prepare-commit-controls', motivo: 'sin foto del pedido' }]).text, '✗ Preparar el pull request — sin foto del pedido');
  // no son de este paso, son de antes de que arrancara, o son de otro repo: no cuentan
  for (const g of [
    { ...base, ts: at(81), name: 'step-order', step: 'reviewers' },
    { ...base, ts: at(60), name: 'review-cap-blocking', step: 8 },
    { ...base, ts: at(81), name: 'review-cap-blocking', step: 8, repoPath: path.join(j.base, 'otro') },
    { ...base, ts: at(81), name: 'review-cap-blocking', step: 8, story: '1.1' },
  ]) assert.strictEqual(linea([g]).mark, '●', JSON.stringify(g));
});

test('RG5 Matrix_PartialIsNotGreen_AndUsesTheEvidenceKey @story-8.293 @ac-2', () => {
  const j = juguete();
  const fila = (n, v) => `| #${n} | ${v} | — | — | — |`;
  fs.writeFileSync(path.join(j.evidence, '9.9-runtime-matrix.md'), [fila(1, '🟢 RUNTIME'), fila(2, '🟠 RUNTIME-PARCIAL'), fila(3, '🔴 NOT-RUN'), ''].join('\n'));
  const m = marcador(j, { stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], stepTimings: { 'live-check': { startedAt: at(70) } }, checks: { acmatrix: 'red' } });
  const vivo = (marker) => deUnPaso(RL.lines({ marker, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'live-check');
  assert.strictEqual(vivo(m).text, '✗ Probar en vivo — 2 criterios sin evidencia: AC 2, 3');
  // con el número repetido en el repo, la matriz es la de la clave de la historia y no la del número solo
  execFileSync('git', ['init', '-q', j.repo]);
  fs.mkdirSync(path.join(j.repo, 'specs'), { recursive: true });
  const una = path.join(j.repo, 'specs', 'story-9.9-una.md');
  fs.writeFileSync(una, '---\nstory: "9.9"\ntitle: "una"\nstatus: in-progress\n---\n# Story\n');
  fs.writeFileSync(path.join(j.repo, 'specs', 'story-9.9-otra.md'), '---\nstory: "9.9"\ntitle: "otra"\nstatus: in-progress\n---\n# Story\n');
  const clave = require(path.join(SCRIPTS, 'lib', 'evidence-key.js')).evidenceKey(una).key;
  assert.notStrictEqual(clave, '9.9');
  fs.writeFileSync(path.join(j.evidence, `${clave}-runtime-matrix.md`), [fila(1, '🔴 SIN-EVIDENCIA'), ''].join('\n'));
  assert.strictEqual(vivo({ ...m, storyPath: una }).text, '✗ Probar en vivo — 1 criterios sin evidencia: AC 1');
});

test('RG6 ExpectedRed_IsRed @story-8.293 @ac-1 @ac-2', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.repo, '.advisors', 'tests-result.json'), JSON.stringify({ story_id: '9.9', totals: { passed: 40, failed: 1, failures: ['a.test.js'] } }));
  const m = marcador(j, { stepsCompleted: hasta('run-tests'), stepsPending: TODOS.slice(6), checks: { tests: 'rojo-esperado:exit=1' } });
  assert.strictEqual(deUnPaso(RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'run-tests').text, '✗ Correr las pruebas — 1 rojas: a.test.js');
});

test('RG7 AdversarialLine_FirstFindingNotClosed @story-8.293 @ac-1 @ac-2', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'step-05b-adversarial.json'), JSON.stringify({ confirmed: [
    { file: 'lib/a.js', line: 3, summary: 'el primero, ya arreglado' }, { file: 'lib/b.js', line: 9, summary: 'el segundo sigue abierto' },
  ] }));
  const hallazgo = (file, disposition) => ({ rule_id: 'ADV-BUG', severity: 'CRITICAL', advisor: 'adversarial-verify', file, disposition });
  const m = marcador(j, { stepsCompleted: hasta('reviewers'), stepsPending: TODOS.slice(7), deepReviewDone: true, adversarialPasses: [{ tipo: '5b', confirmados: 2 }, { tipo: 'revision', confirmados: 9 }] });
  const linea = (marker) => deUnPaso(RL.lines({ marker, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'adversarial-pass');
  // sin findings.json nada está cerrado todavía
  assert.strictEqual(linea(m).text, '✗ Pase adversarial — el primero, ya arreglado');
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([hallazgo('skills/x/lib/a.js', 'fixed'), hallazgo('skills/x/lib/b.js', 'open')]));
  assert.strictEqual(linea(m).text, '✗ Pase adversarial — el segundo sigue abierto');
  // reabierto: el mismo motivo, con ●
  assert.strictEqual(linea({ ...m, deepReviewDone: false, stepTimings: { 'adversarial-pass': { startedAt: at(60) } } }).text, '● Pase adversarial — el segundo sigue abierto');
  // todo cerrado: cuenta el pase del pipeline, no la revisión a mano posterior
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([hallazgo('skills/x/lib/a.js', 'fixed'), hallazgo('skills/x/lib/b.js', 'fixed')]));
  assert.strictEqual(linea(m).text, '✓ Pase adversarial — 2 hallazgos confirmados');
  // un pase que no se pudo medir lo dice
  assert.strictEqual(linea({ ...m, deepReviewDone: false, adversarialPasses: [{ tipo: '5b', confirmados: 0, veredicto: 'no-medido', motivo_no_medido: 'faltó una lente' }], stepTimings: { 'adversarial-pass': { startedAt: at(60) } } }).text, '● Pase adversarial — no medido: faltó una lente');
});

test('RG8 MarkerWithoutRunDir_SameTextAsWithIt @story-8.293 @ac-4', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([{ rule: 'SEC-C1', severity: 'CRITICAL', disposition: 'open', file: 'b.js' }]));
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', tipo: 'manual', quien: 'Ana' })}\n`);
  const m = marcador(j, { stepsCompleted: hasta('reviewers'), stepsPending: TODOS.slice(7), iterations: { 1: {} } });
  delete m.runDir;
  const o = { marker: m, stateDir: j.stateDir, gatesLog: [], ...aislado(j) };
  assert.deepStrictEqual(textos(RL.lines(o)), textos(RL.lines({ ...o, runDir: j.runDir })));
  assert.strictEqual(deUnPaso(RL.lines(o), 'reviewers').text, '✗ Revisores — vuelta 1 de 3: SEC-C1');
  assert.match(RL.final({ ...o, dump: { archivedAt: at(80), marker: m } }), /1 firma de una persona$/);
});

test('RG9 GatesSince_Bytes_Order_AndEnd @story-8.293 @ac-3 @ac-4', () => {
  const j = juguete();
  // un renglón con acentos cruzando el borde del bloque de lectura, en distintos puntos: siempre el mismo texto
  const motivo = 'la migración quedó sin revisión — ñandú áéíóú';
  const freno = JSON.stringify({ ts: at(5), name: 'prepare-commit-controls', status: 'blocked', motivo });
  const BLOQUE = 256 * 1024;
  for (let corte = 40; corte < 110; corte += 1) {
    const relleno = 'x'.repeat(BLOQUE - corte - 30);
    escribirGates(j, [freno, JSON.stringify({ ts: at(6), name: 'relleno', r: relleno })]);
    const { lineas, completo } = RL.gatesSince({ stateDir: j.stateDir, since: at(0) });
    assert.ok(completo);
    assert.strictEqual(lineas.find((l) => l.name === 'prepare-commit-controls').motivo, motivo, `corte ${corte}`);
  }
  // una línea con hora vieja escrita en el medio no corta la lectura
  escribirGates(j, [{ ts: at(40), name: 'extra-round', story: '9.9', iter: 3 }, { ts: at(-1440), name: 'story-gate' }, { ts: at(41), name: 'otra' }]);
  const r = RL.gatesSince({ stateDir: j.stateDir, since: at(0) });
  assert.deepStrictEqual(r.lineas.map((l) => l.name), ['extra-round', 'otra']);
  assert.ok(r.completo);
  // lo de antes del arranque no entra y la lectura termina
  escribirGates(j, [{ ts: at(-10), name: 'vieja' }, { ts: at(1), name: 'nueva' }]);
  assert.deepStrictEqual(RL.gatesSince({ stateDir: j.stateDir, since: at(0) }).lineas.map((l) => l.name), ['nueva']);
  // el renglón final de una corrida cerrada no suma las vueltas extra de una corrida posterior
  escribirGates(j, [{ ts: at(70), name: 'extra-round', story: '9.9', iter: 3 }, { ts: at(200), name: 'extra-round', story: '9.9', iter: 3 }]);
  assert.match(RL.final({ dump: volcado(j), runDir: j.runDir, stateDir: j.stateDir, ...aislado(j) }), /2 vueltas \(\+1 extra\)/);
});

test('RG10 Final_UnreadableApprovals_NotMeasured @story-8.293 @ac-3', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', tipo: 'manual', quien: 'Ana' })}\n{"que":"guardar","tipo":"manual","qui\n`);
  assert.match(RL.final({ dump: volcado(j), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), /firmas de una persona no medidas$/);
});

test('RG11 StateLine_CurrentStepUnlessLastClosedFailed @story-8.293 @ac-7', () => {
  const j = juguete();
  const linea = (extra) => RL.stateLine({ marker: marcador(j, extra), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) });
  // Implementar en curso, con las pruebas de un intento anterior en rojo: manda el paso en curso
  assert.strictEqual(linea({ stepsCompleted: hasta('approve-plan'), stepsPending: TODOS.slice(4), stepTimings: { implement: { startedAt: at(30) } }, checks: { tests: 'red:exit=1' } }), `● Implementar — en curso desde las ${hhmm(at(30))}`);
  // Preparar en curso, con Hallazgos cerrado en verde y un crítico abierto de los revisores: manda Preparar
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), JSON.stringify([{ rule: 'SEC-C1', severity: 'CRITICAL', disposition: 'open', file: 'b.js' }]));
  assert.strictEqual(linea({ stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], deepReviewDone: true, dodRuntimeChecked: true, iterations: { 1: {} }, stepTimings: { 'prepare-commit': { startedAt: at(80) } } }), `● Preparar el pull request — en curso desde las ${hhmm(at(80))}`);
  // el último cerrado salió ✗: manda ese
  assert.strictEqual(linea({ stepsCompleted: hasta('run-tests'), stepsPending: TODOS.slice(6), checks: { tests: 'red:exit=1' }, stepTimings: { reviewers: { startedAt: at(54) } } }), '✗ Correr las pruebas — sin motivo registrado');
  // el paso actual en rojo, sin cerrar, también se ve
  assert.strictEqual(linea({ stepsCompleted: hasta('implement'), stepsPending: TODOS.slice(5), checks: { tests: 'red:exit=1' } }), '✗ Correr las pruebas — sin motivo registrado');
});

test('RG12 Validate_And_PlanWaiting_Motives @story-8.293 @ac-2', () => {
  const j = juguete();
  execFileSync('git', ['init', '-q', j.repo]);
  const story = path.join(j.repo, 'story-9.9.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\ntitle: "x"\n---\n# Story\n');
  const home = path.join(j.base, 'home');
  const m = marcador(j, { storyPath: story, stepsCompleted: ['start'], stepsPending: TODOS.slice(1), stepTimings: { 'validate-story': { startedAt: at(2) } } });
  const o = { marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], home, env: {} };
  assert.strictEqual(deUnPaso(RL.lines(o), 'validate-story').text, '● Validar la historia — sin motivo registrado');
  require(path.join(SCRIPTS, 'lib', 'validation-record.js')).writeRecord(home, story, { resultado: 'rojo', validadores: ['tycon-story-validator'] });
  assert.strictEqual(deUnPaso(RL.lines(o), 'validate-story').text, '✗ Validar la historia — sin motivo registrado');
  const plan = marcador(j, { stepsCompleted: hasta('plan'), stepsPending: TODOS.slice(3), stepTimings: { 'approve-plan': { startedAt: at(20) } } });
  assert.strictEqual(deUnPaso(RL.lines({ ...o, marker: plan }), 'approve-plan').text, '● Aprobar el plan — espera la firma de quien aprueba el plan');
});

test('RG13 FreeText_SecretsCovered_BeforeLeaving @story-8.293 @ac-2 @ac-8', () => {
  const j = juguete();
  const secreto = ['abcdef', 'ghijkl', '123456', '7890'].join('');
  const m = marcador(j, { stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], deepReviewDone: true, dodRuntimeChecked: true, stepTimings: { 'prepare-commit': { startedAt: at(80) } } });
  const ls = RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, ...aislado(j), gatesLog: [{ ts: at(81), status: 'blocked', story: '9.9', name: 'prepare-commit-controls', motivo: `falló con TOKEN=${secreto}` }] });
  assert.ok(!deUnPaso(ls, 'prepare-commit').text.includes(secreto), deUnPaso(ls, 'prepare-commit').text);
  const fin = RL.final({ dump: volcado(j, { cierre: { estado: 'abortada', motivo: `Bearer ${secreto}` } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) });
  assert.ok(!fin.includes(secreto), fin);
  assert.ok(!RL.noticeText({ storyId: '9.9', title: `con TOKEN=${secreto}`, lines: [], final: 'x' }).includes(secreto));
  // campo por campo: ni rutas de la máquina ni ids de sesión salen en lo que arma el aviso
  const ruta = path.join(os.homedir(), 'Proyectos', 'Cliente', 'a.js');
  const sesion = '11111111-2222-4333-8444-555555555555';
  const sucio = `falló en ${ruta} (sesión ${sesion})`;
  const limpio = (t) => { assert.ok(!t.includes('Cliente') && !t.includes(sesion), t); };
  fs.writeFileSync(path.join(j.runDir, 'approvals.jsonl'), `${JSON.stringify({ que: 'plan', tipo: 'manual', quien: sucio })}\n`);
  fs.writeFileSync(path.join(j.runDir, 'step-05b-adversarial.json'), JSON.stringify({ confirmed: [{ file: 'a.js', summary: sucio }] }));
  const conTodo = marcador(j, { stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], deepReviewDone: true, dodRuntimeChecked: true, stepTimings: { 'prepare-commit': { startedAt: at(80) } } });
  const todos = RL.lines({ marker: conTodo, runDir: j.runDir, stateDir: j.stateDir, ...aislado(j), gatesLog: [{ ts: at(81), status: 'blocked', story: '9.9', name: 'prepare-commit-controls', motivo: sucio }] });
  for (const id of ['approve-plan', 'adversarial-pass', 'prepare-commit']) limpio(deUnPaso(todos, id).text);
  const finSucio = RL.final({ dump: volcado(j, { cierre: { estado: 'abortada', motivo: `${sucio} ${'x'.repeat(200)}` } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) });
  limpio(finSucio);
  assert.ok(finSucio.split(' — ')[0].length <= 'no entró: '.length + 120, finSucio);
  limpio(RL.noticeText({ storyId: '9.9', title: sucio, lines: [], final: 'x' }));
});

test('RG15 Reviewers_OtherRoundUnknown_NotGreen @story-8.293 @ac-2', () => {
  const j = juguete();
  fs.writeFileSync(path.join(j.runDir, 'findings.json'), '[]');
  const m = marcador(j, { stepsCompleted: hasta('findings'), stepsPending: ['prepare-commit'], iterations: { 1: {} }, stepTimings: { ...TIEMPOS, findings: { startedAt: at(66), completedAt: at(70) } } });
  Object.defineProperty(m, 'fileEvents', { enumerable: false, get() { throw new Error('ilegible'); } });
  assert.strictEqual(deUnPaso(RL.lines({ marker: m, runDir: j.runDir, stateDir: j.stateDir, gatesLog: [], ...aislado(j) }), 'reviewers').text, '● Revisores — si falta otra vuelta: no medido');
});

test('RG16 CanalesListos_ProfileList_And_BrokenConfig @story-8.293 @ac-8', () => {
  const notify = require(path.join(RAIZ, 'scripts', 'lib', 'notify.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lines-canales-'));
  fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const perfil = path.join(home, 'team-profile.json');
  const env = { PATH: process.env.PATH, HOME: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: perfil };
  // la lista del perfil: el canal sin credencial queda en `fallidos`, con su motivo
  fs.writeFileSync(perfil, JSON.stringify({ integrations: { notify: { channels: ['slack'] } } }));
  const r = notify.canalesListos({ env, home });
  assert.strictEqual(r.problema, null, JSON.stringify(r));
  assert.deepStrictEqual(r.canales, []);
  assert.strictEqual(r.fallidos.length, 1, JSON.stringify(r));
  assert.match(r.fallidos[0], /^slack: /);
  // una configuración rota no manda por ningún canal y lo dice
  fs.writeFileSync(perfil, '{ roto');
  const rota = notify.canalesListos({ env, home });
  assert.deepStrictEqual(rota.canales, []);
  assert.match(rota.problema, /configuración/);
  assert.deepStrictEqual(rota.fallidos, []);
});

test('RG14 Cli_PrefersOwnSessionAndTheNamedStory @story-8.293 @ac-4', () => {
  const E = entorno();
  const correr = (args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-lines.js'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_SESSION_ID: '', CODEX_SESSION_ID: '' }, cwd: E.repo });
  const otra = path.join(E.base, 'otro-repo', 'specs', 'story-9.9-otra.md');
  fs.mkdirSync(path.dirname(otra), { recursive: true });
  fs.writeFileSync(otra, '---\nstory: "9.9"\ntitle: "otra"\n---\n');
  E.escribir('aaa-otra', E.base9('aaa-otra', { storyPath: otra, repoPath: path.dirname(path.dirname(otra)), runDir: undefined, stepsCompleted: TODOS.slice(0, 5), stepsPending: TODOS.slice(5) }));
  E.escribir('zzz-mia', E.base9('zzz-mia', { stepsCompleted: ['start'], stepsPending: TODOS.slice(1) }));
  const nombres = (r) => JSON.parse(r.stdout).lines.map((l) => l.id);
  // por la ruta, la historia pedida aunque la pida otra sesión
  assert.deepStrictEqual(nombres(correr(['--story', E.story, '--json'], 'ninguna')), ['start', 'validate-story']);
  // por el número, la de la sesión que pregunta
  assert.deepStrictEqual(nombres(correr(['--story', '9.9', '--json'], 'zzz-mia')), ['start', 'validate-story']);
  assert.strictEqual(nombres(correr(['--story', '9.9', '--json'], 'aaa-otra')).length, 6);
});

test('MK4 Pr_Merged_PicksTheRightDump @story-8.293 @ac-3', () => {
  const E = entorno();
  const hist = path.join(E.stateDir, 'timing-history');
  fs.mkdirSync(hist, { recursive: true });
  const repoDe = (nombre) => { const r = path.join(E.base, nombre); fs.mkdirSync(r, { recursive: true }); execFileSync('git', ['init', '-q', r]); return r; };
  const otro = repoDe('otro');
  const v = (archivo, archivedAt, marker, extra) => { fs.writeFileSync(path.join(hist, archivo), JSON.stringify({ archivedAt, marker: { storyId: '9.9', stepScheme: 2, stepsCompleted: [], stepsPending: [], repoPath: E.repo, ...marker }, ...extra })); return path.join(hist, archivo); };
  const leerPr = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).marker.pr;
  const sinCerrar = v('9.9-20261101120000-sin-cerrar.json', at(-20000), {}, { sinCerrar: true });
  const ajeno = v('9.9-2026-11-18T0900.json', at(900), { repoPath: otro, pr: { number: 12, merged: false } });
  const propio = v('9.9-2026-11-17T2201.json', at(800), { pr: { number: 12, merged: false }, runDir: E.runDir });
  const copia = path.join(E.runDir, 'timing-dump-2026-11-17T2201.json');
  fs.writeFileSync(copia, fs.readFileSync(propio));
  const r = E.correr(['pr', '12', '--merged', '--story', '9.9'], 'sin-corrida');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^entró el pedido #12 — /);
  assert.deepStrictEqual(leerPr(propio), { number: 12, merged: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(copia, 'utf8')).marker.pr, { number: 12, merged: true });
  assert.strictEqual(leerPr(sinCerrar), undefined, 'el abandonado no se toca');
  assert.deepStrictEqual(leerPr(ajeno), { number: 12, merged: false }, 'el de otro repo no se toca');
  // sin runDir en el volcado, la copia se encuentra igual
  const sinCarpeta = v('9.9-2026-11-17T2300.json', at(860), { pr: { number: 13, merged: false } });
  const carpeta = path.join(E.repo, '.advisors', 'pipeline-runs', '9.9-20261117230000');
  fs.mkdirSync(carpeta, { recursive: true });
  const copia2 = path.join(carpeta, 'timing-dump-2026-11-17T2300.json');
  fs.writeFileSync(copia2, fs.readFileSync(sinCarpeta));
  assert.strictEqual(E.correr(['pr', '13', '--merged', '--story', '9.9'], 'sin-corrida').status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(copia2, 'utf8')).marker.pr, { number: 13, merged: true });
});

test('MK6 Pr_UsageAndMissingDump_Errors @story-8.293 @ac-3', () => {
  const E = entorno();
  assert.strictEqual(E.correr(['pr', 'doce'], 'sin-corrida').status, 2);
  assert.strictEqual(E.correr(['pr', '12'], 'sin-corrida').status, 2);
  const r = E.correr(['pr', '12', '--merged', '--story', '9.9'], 'sin-corrida');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no encontré ningún volcado de la historia 9\.9/);
});

test('MK7 Clear_NoticeSameTextAsPrinted_AfterCostLine @story-8.293 @ac-4 @ac-6 @ac-8', async (t) => {
  const tg = await telegramFalso();
  t.after(() => tg.close());
  const E = entorno();
  const sid = 'mk7-sesion';
  // un agente lanzado en la corrida: es lo que hace salir la línea de costo
  fs.mkdirSync(path.join(E.stateDir, 'advisor-runs'), { recursive: true });
  fs.writeFileSync(path.join(E.stateDir, 'advisor-runs', `${sid}.jsonl`), `${JSON.stringify({ ts: at(1), advisor: 'tycon-plugin-security-basics', story: '9.9' })}\n`);
  E.escribir(sid, E.base9(sid, { stepsCompleted: TODOS.slice(0, 6), stepsPending: TODOS.slice(6), checks: { tests: 'red:exit=1' } }));
  const c = await E.correrAsync(['clear'], sid, conTelegram(tg.url));
  assert.strictEqual(c.status, 0, c.stderr);
  const err = c.stderr.split('\n');
  const iCosto = err.findIndex((l) => l.startsWith('[marker] costo del run:'));
  const corrida = err.map((l, i) => [l, i]).filter(([l]) => l.startsWith('[corrida] '));
  assert.ok(iCosto >= 0 && corrida.length && corrida.every(([, i]) => i > iCosto), c.stderr);
  // lo que llegó al canal, renglón por renglón, es lo que imprimió el cierre
  const impresos = corrida.map(([l]) => l.slice('[corrida] '.length));
  const aviso = textoDe(tg.recibidos[0]).split('\n');
  assert.strictEqual(aviso[0], '9.9 · los renglones');
  assert.ok(aviso.length >= 3, aviso.join('\n'));
  for (const l of aviso.slice(1)) assert.ok(impresos.includes(l), `${l}\n---\n${impresos.join('\n')}`);
});

test('RG17 Cli_Final_FromDump @story-8.293 @ac-3', () => {
  const E = entorno();
  const hist = path.join(E.stateDir, 'timing-history');
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, '9.9-2026-11-17T2201.json'), JSON.stringify({ archivedAt: at(800), marker: E.base9('vieja', { stepsCompleted: ['start'], stepsPending: [], pr: { number: 12, merged: true } }) }));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-lines.js'), '--story', '9.9', '--final'], { encoding: 'utf8', env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: 'nadie' }, cwd: E.repo });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout.trimEnd().split('\n').pop(), /^entró el pedido #12 — /);
});

test('MK5 Set_NewStory_DropsThePr @story-8.293 @ac-3', () => {
  const E = entorno();
  const sid = 'mk5-sesion';
  E.escribir(sid, E.base9(sid, { stepsCompleted: ['start'], stepsPending: TODOS.slice(1) }));
  assert.strictEqual(E.correr(['pr', '12'], sid).status, 0);
  const r = E.correr(['set', JSON.stringify({ storyId: '9.10', storyPath: E.story, repoPath: E.repo }), '--replace'], sid);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer(sid).pr, undefined);
});

// ── el registro de pedidos ───────────────────────────────────────────────────────────────────

const REGISTRO = (E, clave = '9.9') => path.join(E.repo, '.advisors', 'dod-runtime', `${clave}-pedidos.jsonl`);
const renglones = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function repoAparte(E, nombre) {
  const r = path.join(E.base, nombre);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', r, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', `https://example.invalid/${nombre}.git`);
  fs.writeFileSync(path.join(r, 'a.js'), '1\n');
  g('add', '.'); g('commit', '-qm', 'inicio');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { r, g };
}
function conCommitPropio({ r, g }) {
  fs.writeFileSync(path.join(r, 'a.js'), '2\n');
  g('add', '.'); g('commit', '-qm', 'propio');
  return r;
}

test('T17 MarkerPr_ConCorrida_EscribeRenglonSinRepetir @story-8.310 @ac-17', () => {
  const E = entorno();
  fs.mkdirSync(path.dirname(REGISTRO(E)), { recursive: true });
  const sid = 't17';
  E.escribir(sid, E.base9(sid));
  const pub = repoAparte(E, 'publico').r;
  const otro = repoAparte(E, 'tercero').r;
  for (const a of [['pr', '12', '--repo', pub], ['pr', '12', '--repo', pub], ['pr', '13', '--repo', otro], ['pr', '14', '--repo', E.repo]]) {
    const x = E.correr(a, sid);
    assert.strictEqual(x.status, 0, x.stderr);
  }
  assert.deepStrictEqual(renglones(REGISTRO(E)).map((l) => [l.historia, l.clave, l.repo, l.pedido]), [['9.9', '9.9', 'publico', 12], ['9.9', '9.9', 'tercero', 13]]);
  assert.ok(renglones(REGISTRO(E)).every((l) => l.ts));
  assert.deepStrictEqual(E.leer(sid).pr, { number: 14, merged: false, repo: 'repo' });
  assert.strictEqual(E.correr(['pr', '15', '--repo', path.join(E.base, 'no-existe')], sid).status, 2);
});

test('T17b MarkerClear_RepoConCommitsNoAnotado_Avisa @story-8.310 @ac-17', () => {
  const E = entorno();
  fs.mkdirSync(path.dirname(REGISTRO(E)), { recursive: true });
  const conRenglon = conCommitPropio(repoAparte(E, 'con-renglon'));
  const sinNada = conCommitPropio(repoAparte(E, 'sin-nada'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', E.repo, ...a], { stdio: 'ignore' });
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('commit', '-q', '--allow-empty', '-m', 'propio');
  const sid = 't17b';
  const eventos = [conRenglon, sinNada].map((r) => ({ path: path.join(r, 'a.js'), ts: at(1) }));
  E.escribir(sid, E.base9(sid, { stepsCompleted: [...TODOS], stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true, fileEvents: eventos }));
  assert.strictEqual(E.correr(['pr', '20', '--repo', conRenglon], sid).status, 0);
  assert.strictEqual(E.correr(['pr', '21', '--repo', E.repo], sid).status, 0);
  const c = E.correr(['clear'], sid);
  assert.strictEqual(c.status, 0, c.stderr);
  const avisos = c.stderr.split('\n').filter((l) => /sin pedido anotado/.test(l));
  assert.strictEqual(avisos.length, 1, c.stderr);
  assert.match(avisos[0], /sin-nada/);
});

test('MarkerClear_RenglonDeUnPedidoViejo_AvisaIgual @story-8.310 @ac-17', () => {
  const E = entorno();
  fs.mkdirSync(path.dirname(REGISTRO(E)), { recursive: true });
  const viejo = conCommitPropio(repoAparte(E, 'viejo'));
  // un renglón de un pedido anterior a esta corrida no cubre los commits de ahora
  fs.writeFileSync(REGISTRO(E), `${JSON.stringify({ historia: '9.9', clave: '9.9', repo: 'viejo', pedido: 3, ts: new Date(T0 - 86400000).toISOString() })}\n`);
  const sid = 'clear-viejo';
  E.escribir(sid, E.base9(sid, { stepsCompleted: [...TODOS], stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true, fileEvents: [{ path: path.join(viejo, 'a.js'), ts: at(1) }] }));
  const c = E.correr(['clear'], sid);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(c.stderr, /viejo: tiene commits de la corrida y sin pedido anotado/);
});

test('MarkerPr_SinRepo_ConCorridaEnOtroRepo_SoloMarcador @story-8.310 @ac-17', () => {
  const E = entorno();
  fs.mkdirSync(path.dirname(REGISTRO(E)), { recursive: true });
  const codigo = repoAparte(E, 'codigo').r;
  const sid = 'pr-sin-repo';
  E.escribir(sid, E.base9(sid, { repoPath: codigo }));
  const x = E.correr(['pr', '40'], sid);
  assert.strictEqual(x.status, 0, x.stderr);
  assert.deepStrictEqual(renglones(REGISTRO(E)), [], 'sin --repo no se sabe de qué repo es el número: no va al registro');
  assert.strictEqual(E.leer(sid).pr.number, 40);
});

test('MarkerPr_ConCorrida_SinCarpetaDeEvidencia_AvisaYGuarda @story-8.310 @ac-17', () => {
  const E = entorno();
  const pub = repoAparte(E, 'publico').r;
  const sid = 'pr-sin-carpeta';
  E.escribir(sid, E.base9(sid));
  const x = E.correr(['pr', '41', '--repo', pub], sid);
  assert.strictEqual(x.status, 0, x.stderr);
  assert.match(x.stderr, /carpeta de evidencia/);
  assert.deepStrictEqual(E.leer(sid).pr, { number: 41, merged: false, repo: 'publico' });
});

test('MarkerPr_SinMarcador_ClaveIncalculable_NoEscribe @story-8.310 @ac-18', () => {
  const E = entorno();
  fs.mkdirSync(path.dirname(REGISTRO(E)), { recursive: true });
  const pub = repoAparte(E, 'publico').r;
  const x = E.correr(['pr', '42', '--merged', '--story', '9.9', '--repo', pub, '--story-path', path.join(E.repo, 'specs', 'no-existe.md')], 'z');
  assert.strictEqual(x.status, 1, x.stderr);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(REGISTRO(E))), []);
});

test('T18 MarkerPr_SinMarcador_ConHistoria_YSinCarpeta @story-8.310 @ac-18', () => {
  const E = entorno();
  const dod = path.dirname(REGISTRO(E));
  const pub = repoAparte(E, 'publico').r;
  // un número repetido: la clave de la historia lleva su tema
  const a = path.join(E.repo, 'specs', 'ventas', 'story-9.9-a.md');
  const b = path.join(E.repo, 'specs', 'compras', 'story-9.9-b.md');
  fs.rmSync(E.story);
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(a, '---\nstory: "9.9"\ntitle: "a"\nstatus: review\n---\n# a\n');
  fs.writeFileSync(b, '---\nstory: "9.9"\ntitle: "b"\nstatus: review\n---\n# b\n');
  const sid = 't18';
  E.escribir(sid, E.base9(sid, { storyPath: a, stepsCompleted: [...TODOS], stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true }));
  assert.strictEqual(E.correr(['clear'], sid).status, 0);
  const hist = path.join(E.stateDir, 'timing-history');
  const volcado = () => fs.readdirSync(hist).filter((f) => f.startsWith('9.9-')).map((f) => fs.readFileSync(path.join(hist, f), 'utf8')).join('');
  const antes = volcado();
  const base = ['pr', '30', '--merged', '--story', '9.9', '--repo', pub];
  // sin --story-path no se sabe la clave
  assert.strictEqual(E.correr(base, 'x').status, 2);
  // sin carpeta de evidencia, error y nada escrito
  assert.strictEqual(E.correr([...base, '--story-path', a], 'x').status, 1);
  assert.strictEqual(volcado(), antes, 'el volcado no se toca');
  fs.mkdirSync(dod, { recursive: true });
  const ok = E.correr([...base, '--story-path', a], 'x');
  assert.strictEqual(ok.status, 0, ok.stderr);
  const archivos = fs.readdirSync(dod).filter((f) => f.endsWith('-pedidos.jsonl'));
  assert.deepStrictEqual(archivos, ['ventas__9.9-pedidos.jsonl']);
  assert.deepStrictEqual(renglones(path.join(dod, archivos[0])).map((l) => [l.repo, l.pedido, l.clave]), [['publico', 30, 'ventas__9.9']]);
  // con un marcador vivo, --story-path escribe igual, también para el repo de la historia
  const vivo = 't18-vivo';
  E.escribir(vivo, E.base9(vivo, { storyPath: a }));
  assert.strictEqual(E.correr(['pr', '31', '--merged', '--story', '9.9', '--repo', E.repo, '--story-path', a], vivo).status, 0);
  assert.ok(renglones(path.join(dod, archivos[0])).some((l) => l.pedido === 31 && l.repo === 'repo'));
  // sin volcado en esta máquina: el renglón se escribe y sale bien
  fs.rmSync(hist, { recursive: true, force: true });
  const sinVolcado = E.correr(['pr', '32', '--merged', '--story', '9.9', '--repo', E.repo, '--story-path', a], 'y');
  assert.strictEqual(sinVolcado.status, 0, sinVolcado.stderr);
  assert.match(sinVolcado.stderr, /volcado/);
  assert.ok(renglones(path.join(dod, archivos[0])).some((l) => l.pedido === 32));
});
