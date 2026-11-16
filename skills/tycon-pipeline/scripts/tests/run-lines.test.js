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
  assert.strictEqual(linea, 'entró el pedido #148 — 52 min de trabajo, 14 min de espera, 2 vueltas (+1 extra), 1 firma del dueño y 2 de la coordinadora');
});

test('RL4 Final_NotEntered_And_NotMeasured @story-8.293 @ac-3', () => {
  const j = juguete();
  const sinFirmas = path.join(j.base, 'sin-corrida');
  // (a) cerrada sin pedido
  const a = RL.final({ dump: volcado(j, { cierre: { estado: 'abortada', motivo: 'la persona la canceló' } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  assert.match(a, /^no entró: la persona la canceló — /);
  // (b) sin tiempos, sin registro de firmas y sin pedido: la línea sale igual
  const b = RL.final({ dump: volcado(j, { stepTimings: undefined }), runDir: sinFirmas, stateDir: j.stateDir, gatesLog: [] });
  assert.strictEqual(b, 'pedido: no medido — trabajo no medido, espera no medida, 2 vueltas, firmas del dueño no medidas');
  // (c) pedido sin merge
  const c = RL.final({ dump: volcado(j, { pr: { number: 7 } }), runDir: j.runDir, stateDir: j.stateDir, gatesLog: [] });
  assert.match(c, /^pedido #7 abierto, espera la cola — 52 min de trabajo, 14 min de espera, 2 vueltas, firmas del dueño no medidas$/);
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
const textoDe = (cuerpo) => { try { return JSON.parse(cuerpo).text || ''; } catch (_) { return decodeURIComponent(String(cuerpo).replace(/\+/g, ' ')); } };

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
  const skill = fs.readFileSync(path.join(SCRIPTS, '..', 'SKILL.md'), 'utf8');
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
  const b = await cerrar(entorno(), 'mk3-b');
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(!/aviso del cierre/.test(b.stderr), b.stderr);
  // (c) un canal que falla: una línea en la salida de errores, y sale 0
  const c = await cerrar(entorno(), 'mk3-c', conTelegram(roto.url));
  assert.strictEqual(c.status, 0, c.stderr);
  assert.strictEqual(c.stderr.split('\n').filter((l) => /aviso del cierre/.test(l)).length, 1, c.stderr);
});
