'use strict';
/**
 * session-state.test.js — el archivo de estado de cada sesión: quién lo escribe, cuándo, y qué hace la oficina con él.
 * T17 a T24, T27 a T33, y T76 a T82 (las regresiones del pase adversarial).
 *
 * Cada caso tiene su HOME de juguete: el estado real de la máquina no se toca. Los ganchos y marker.js se lanzan por
 * subproceso, con el ambiente limpio de las variables de la máquina (TYCON_*, CLAUDE_CODE_SESSION_ID,
 * CODEX_SESSION_ID). Las firmas que piden `adhoc set`, `clear-session --lost` y `restore` se dan por pasadas con
 * `conVentana` (scripts/tests/lib/window-passed.js), sólo sobre la HOME de juguete.
 *
 * stable-data: el archivo guarda la hora real de su última novedad, y «inactiva» y «sin novedades» se miden contra la
 * hora actual; las pruebas usan el reloj real y fechas relativas a él (3 h, 25 h atrás). Ningún valor esperado depende
 * de la hora del día ni del huso horario: sólo de lo que pasó antes o después de cada umbral.
 *
 * Correr: node --test scripts/tests/session-state.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'session-state.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'session-state.js');
const OFFICE = path.join(ROOT, 'scripts', 'tools', 'office.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const STEPS = require(path.join(SCRIPTS, 'lib', 'steps.js'));
const { conVentana } = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'window-passed.js'));

const lib = () => require(LIB);
const FIELDS = ['schema', 'session', 'tool', 'name', 'sentence', 'step', 'endAt', 'endWithoutHour', 'waitingForOwner', 'waitingFor', 'updatedAt', 'pid'];
const HOUR = 3600000;

// ── el mundo de cada caso ───────────────────────────────────────────────────────────────────────────────────────
function cleanEnv(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$|^CLAUDE_/.test(k)) continue;
    e[k] = v;
  }
  return Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' }, extra);
}

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'timing-history']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { home, sdir, sessions };
}

const hook = (w, payload, extra = {}) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: cleanEnv(w.home, extra), encoding: 'utf8',
});
const marker = (w, sid, args, extra = {}) => spawnSync(process.execPath, [MARKER, ...args], {
  input: '', env: cleanEnv(w.home, { CLAUDE_CODE_SESSION_ID: sid, ...extra }), encoding: 'utf8',
});
const fileOf = (w, sid) => path.join(w.sdir, 'sessions', `${sid}.json`);
const stateOf = (w, sid) => { try { return JSON.parse(fs.readFileSync(fileOf(w, sid), 'utf8')); } catch { return null; } };
const claudeSession = (w, sid, name, pid = process.pid) => fs.writeFileSync(path.join(w.sessions, `${pid}.json`),
  JSON.stringify({ pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: Date.now() }));
// un pid que ya terminó: el de un proceso que se lanzó y salió
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function storyFile(w, id, title) {
  const p = path.join(w.home, `story-${id}.md`);
  fs.writeFileSync(p, `---\nstory: "${id}"\ntitle: "${title}"\n---\n# Story\n`);
  return p;
}
// un marcador con los pasos por nombre: los primeros `done` hechos, el resto pendiente
function pipelineMarker(w, sid, { done = ['start', 'validate-story', 'plan', 'approve-plan'], extra = {} } = {}) {
  const ids = STEPS.STEPS.filter((s) => !s.flag).map((s) => s.id);
  fs.writeFileSync(path.join(w.sdir, 'active', `${sid}.json`), JSON.stringify({
    sessionId: sid, storyId: '9.9', storyPath: storyFile(w, '9.9', 'Una historia'), stepScheme: STEPS.SCHEME,
    startedAt: new Date().toISOString(), lastTouch: new Date().toISOString(),
    stepsCompleted: done, stepsPending: ids.filter((s) => !done.includes(s)), stepTimings: {}, ...extra,
  }));
}
// una corrida archivada donde cada paso duró `mins[paso]` minutos: las medianas de /wip
function history(w, mins) {
  let t = Date.parse('2026-10-10T10:00:00.000Z');
  const startedAt = new Date(t).toISOString();
  const stepTimings = {};
  for (const [step, min] of Object.entries(mins)) {
    const s = t;
    t += min * 60000;
    stepTimings[step] = { startedAt: new Date(s).toISOString(), completedAt: new Date(t).toISOString() };
  }
  fs.writeFileSync(path.join(w.sdir, 'timing-history', 'h1.json'), JSON.stringify({ archivedAt: new Date(t).toISOString(), marker: { startedAt, stepTimings } }));
}

// ── T17 a T24 ──────────────────────────────────────────────────────────────────────────────────────────────────

test('T17 SessionFile_StartWritesSchema @story-2.81 @ac-17 — el arranque escribe el archivo con todos sus campos, por renombre', () => {
  const w = world();
  claudeSession(w, 's-cl', 'Pipa');
  let r = hook(w, { hook_event_name: 'SessionStart', session_id: 's-cl', source: 'startup' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'el gancho no imprime nada');
  const cl = stateOf(w, 's-cl');
  assert.deepStrictEqual(Object.keys(cl).sort(), [...FIELDS].sort());
  assert.strictEqual(cl.schema, 1);
  assert.strictEqual(cl.session, 's-cl');
  assert.strictEqual(cl.tool, 'claude');
  assert.strictEqual(cl.name, 'Pipa');
  assert.strictEqual(cl.pid, process.pid, 'el pid sale del archivo de sesión de Claude');
  assert.strictEqual(cl.step, null);
  assert.strictEqual(cl.sentence, lib().NO_PIPELINE);
  assert.strictEqual(cl.waitingForOwner, false);
  assert.strictEqual(cl.waitingFor, null);
  assert.ok(Number.isFinite(Date.parse(cl.updatedAt)));
  // Codex: sin nombre ni pid (decisión 24d)
  r = hook(w, { hook_event_name: 'SessionStart', session_id: 's-cx', turn_id: 't-1' });
  assert.strictEqual(r.status, 0, r.stderr);
  const cx = stateOf(w, 's-cx');
  assert.strictEqual(cx.tool, 'codex');
  assert.strictEqual(cx.name, null);
  assert.strictEqual(cx.pid, null);
  // Claude sin su archivo de sesión: el pid va null y rige el tiempo
  hook(w, { hook_event_name: 'SessionStart', session_id: 's-sin', source: 'startup' });
  assert.strictEqual(stateOf(w, 's-sin').pid, null);
  assert.deepStrictEqual(fs.readdirSync(path.join(w.sdir, 'sessions')).filter((f) => !f.endsWith('.json')), [], 'no quedan temporales');
  // escrito entero y renombrado: nunca se ve a medias
  const renames = [];
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return real(a, b); };
  try { lib().update(w.sdir, 's-ren', { sentence: 'Algo.' }, { create: true, tool: 'claude' }); } finally { fs.renameSync = real; }
  assert.strictEqual(renames.length, 1);
  assert.strictEqual(renames[0][1], fileOf(w, 's-ren'));
  assert.notStrictEqual(renames[0][0], renames[0][1]);
});

test('T18 SessionFile_SameContent_NoWrite @story-2.81 @ac-18 — lo mismo que ya dice no se vuelve a escribir', () => {
  const w = world();
  const L = lib();
  assert.strictEqual(L.update(w.sdir, 's1', { waitingForOwner: true, waitingFor: 'un permiso' }, { create: true, tool: 'claude' }), 'written');
  const before = stateOf(w, 's1');
  const old = new Date(Date.now() - HOUR);
  fs.utimesSync(fileOf(w, 's1'), old, old);
  assert.strictEqual(L.update(w.sdir, 's1', { waitingForOwner: true, waitingFor: 'un permiso' }), 'same');
  assert.strictEqual(fs.statSync(fileOf(w, 's1')).mtimeMs, old.getTime(), 'la fecha del archivo no cambió');
  assert.strictEqual(stateOf(w, 's1').updatedAt, before.updatedAt);
  assert.strictEqual(L.update(w.sdir, 's1', { waitingForOwner: false, waitingFor: null }), 'written');
});

test('T19 SessionFile_StepChange_StepSentenceAndEnd @story-2.81 @ac-19 — el cambio de paso dice el paso, la oración y la hora de /wip', () => {
  const w = world();
  claudeSession(w, 's-pipe', 'Pipa');
  history(w, { implement: 30, 'run-tests': 5, reviewers: 20, 'adversarial-pass': 10, findings: 5, 'live-check': 5, 'prepare-commit': 5 });
  pipelineMarker(w, 's-pipe');
  lib().update(w.sdir, 's-pipe', {}, { create: true, tool: 'claude' });
  // la otra sesión no tiene archivo: marker.js no se lo crea
  pipelineMarker(w, 's-sinarchivo');
  let r = marker(w, 's-pipe', ['start-step', 'implement']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(marker(w, 's-sinarchivo', ['start-step', 'implement']).status, 0);
  const st = stateOf(w, 's-pipe');
  const name = STEPS.byId('implement').name;
  assert.strictEqual(st.step, name);
  assert.strictEqual(st.sentence, `Va por el paso «${name}».`);
  const { buildWip } = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  const wip = buildWip({ home: w.home, stateDir: w.sdir, sessionsDir: w.sessions });
  const i = wip.details.findIndex((d) => d.sid === 's-pipe');
  assert.ok(i >= 0, 'la corrida sale en /wip');
  assert.ok(Number.isFinite(wip.extra[i].endAt), 'con historial, /wip tiene hora');
  assert.strictEqual(Date.parse(st.endAt), wip.extra[i].endAt, 'la misma hora de fin que /wip');
  assert.strictEqual(st.endWithoutHour, null);
  assert.strictEqual(stateOf(w, 's-sinarchivo'), null, 'la sesión sin archivo sigue sin archivo');
  // complete-step también lo pone al día
  r = marker(w, 's-pipe', ['complete-step', 'implement', '--no-atdd', '--reason', 'prueba de juguete']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(stateOf(w, 's-pipe').step, STEPS.byId('run-tests').name);
  // sin historial: sin hora, con el motivo
  const v = world();
  claudeSession(v, 's-v', 'Vacia');
  pipelineMarker(v, 's-v');
  lib().update(v.sdir, 's-v', {}, { create: true, tool: 'claude' });
  assert.strictEqual(marker(v, 's-v', ['start-step', 'implement']).status, 0);
  const sv = stateOf(v, 's-v');
  assert.strictEqual(sv.endAt, null);
  assert.match(String(sv.endWithoutHour), /sin datos/);
});

test('T20 SessionFile_AdhocSetAndClear @story-2.81 @ac-20 — el trabajo suelto cambia la oración, sin números', () => {
  const w = world();
  lib().update(w.sdir, 's-ad', {}, { create: true, tool: 'claude' });
  const reason = '2.44 · Arreglo el aviso del pedido !812';
  let r = marker(w, 's-ad', ['adhoc', 'set', JSON.stringify({ reason })], conVentana({}));
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const { plain } = require(OFFICE);
  const st = stateOf(w, 's-ad');
  assert.strictEqual(st.sentence, plain(reason));
  assert.doesNotMatch(st.sentence, /2\.44|!812|812/, 'sin el número de historia ni el del pedido');
  assert.strictEqual(st.step, null);
  r = marker(w, 's-ad', ['adhoc', 'clear']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf(w, 's-ad').sentence, lib().NO_PIPELINE);
});

test('T21 Claude_PermissionAndQuestion_Waiting @story-2.81 @ac-21 — el permiso y la pregunta se anotan, sin pipeline ni canal de aviso', () => {
  const w = world();
  const sid = 's-esp';
  const off = { TYCON_WAIT_NOTICE: '0' };
  const ev = (e) => assert.strictEqual(hook(w, { session_id: sid, ...e }, off).status, 0);
  ev({ hook_event_name: 'SessionStart', source: 'startup' });
  ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, true);
  assert.strictEqual(stateOf(w, sid).waitingFor, 'un permiso');
  ev({ hook_event_name: 'UserPromptSubmit', prompt: 'dale' });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, false);
  assert.strictEqual(stateOf(w, sid).waitingFor, null);
  ev({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, true);
  assert.strictEqual(stateOf(w, sid).waitingFor, 'una respuesta');
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, false, 'terminó el uso de una herramienta');
  ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'permission' });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, true);
  ev({ hook_event_name: 'Stop' });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, false, 'se cerró el turno');
  // otra notificación que no es un permiso no abre la espera
  ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'esperando' });
  assert.strictEqual(stateOf(w, sid).waitingForOwner, false);
  // el plan que se le muestra a la persona también es una pregunta
  ev({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  assert.strictEqual(stateOf(w, sid).waitingFor, 'una respuesta');
  ev({ hook_event_name: 'UserPromptSubmit', prompt: 'sí' });
  assert.ok(!fs.existsSync(path.join(w.sdir, 'wait-notice')), 'wait-notice.js no intervino');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(fileOf(w, sid)).mode & 0o777, 0o600, 'el archivo es privado');
});

test('T22 Codex_StopWithPipeline_Waiting @story-2.81 @ac-22 — Codex espera al cerrar el turno con un pipeline; una firma no es su espera', () => {
  const w = world();
  pipelineMarker(w, 's-cx');
  const ev = (sid, e) => assert.strictEqual(hook(w, { session_id: sid, turn_id: 't', ...e }).status, 0);
  ev('s-cx', { hook_event_name: 'SessionStart' });
  ev('s-cx', { hook_event_name: 'Stop' });
  assert.strictEqual(stateOf(w, 's-cx').waitingForOwner, true);
  assert.strictEqual(stateOf(w, 's-cx').waitingFor, 'una respuesta');
  ev('s-cx', { hook_event_name: 'UserPromptSubmit', prompt: 'seguí' });
  assert.strictEqual(stateOf(w, 's-cx').waitingForOwner, false);
  // sin pipeline, con una firma pendiente en la máquina: no espera (decisión 24b)
  const { coordinationDir } = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
  fs.mkdirSync(coordinationDir(w.home), { recursive: true });
  fs.writeFileSync(path.join(coordinationDir(w.home), 'signatures.json'), JSON.stringify([{ id: 'f1', key: 'k', file: '/x', kind: 'k', title: 'una firma', at: Date.now() }]));
  ev('s-libre', { hook_event_name: 'SessionStart' });
  ev('s-libre', { hook_event_name: 'Stop' });
  assert.strictEqual(stateOf(w, 's-libre').waitingForOwner, false);
});

test('T23 Codex_NoPermissionEvent_NothingInvented @story-2.81 @ac-22 — en Codex, usar una herramienta no se toma como un permiso', () => {
  const w = world();
  const ev = (e) => assert.strictEqual(hook(w, { session_id: 's-cx2', turn_id: 't', ...e }).status, 0);
  ev({ hook_event_name: 'SessionStart' });
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.strictEqual(stateOf(w, 's-cx2').waitingForOwner, false);
  assert.strictEqual(stateOf(w, 's-cx2').waitingFor, null);
});

test('T24 End_ClaudeDeletes_DeadOrUnknownGoesInactive @story-2.81 @ac-23 — SessionEnd borra; pid muerto o sin pid viejo, «inactiva»', () => {
  const w = world();
  const L = lib();
  hook(w, { hook_event_name: 'SessionStart', session_id: 's-fin', source: 'startup' });
  assert.ok(stateOf(w, 's-fin'));
  assert.strictEqual(hook(w, { hook_event_name: 'SessionEnd', session_id: 's-fin', reason: 'exit' }).status, 0);
  assert.strictEqual(stateOf(w, 's-fin'), null, 'SessionEnd de Claude borra el archivo');
  const dead = deadPid();
  const put = (sid, fields) => {
    L.update(w.sdir, sid, fields, { create: true, tool: fields.tool });
    const p = fileOf(w, sid);
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({ ...s, ...fields }));
  };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  put('s-cl-muerta', { tool: 'claude', name: 'Muerta', pid: dead, updatedAt: ago(10 * 60000) });
  put('s-cx-muerta', { tool: 'codex', pid: dead, updatedAt: ago(10 * 60000) });
  put('s-cx-3h', { tool: 'codex', pid: null, updatedAt: ago(3 * HOUR) });
  put('s-cx-25h', { tool: 'codex', pid: null, updatedAt: ago(25 * HOUR) });
  const out = execFileSync(process.execPath, [OFFICE, '--json'], { input: '', env: cleanEnv(w.home), encoding: 'utf8' });
  const data = JSON.parse(out);
  const inactive = data.agents.filter((a) => a.estado === 'inactiva');
  assert.strictEqual(inactive.length, 3, JSON.stringify(data.agents));
  for (const a of inactive) assert.match(a.haciendo, /sin novedades desde las \d\d:\d\d/);
  assert.ok(data.agents.some((a) => a.nombre === 'Muerta' && a.estado === 'inactiva'));
  for (const sid of ['s-cl-muerta', 's-cx-muerta', 's-cx-3h', 's-cx-25h']) assert.ok(stateOf(w, sid), `${sid} sigue en disco`);
  assert.strictEqual(data.agents.length, 3, 'la de hace 25 h no se dibuja');
  assert.strictEqual(L.isStale(stateOf(w, 's-cx-3h')), true);
  assert.strictEqual(L.isStale({ ...stateOf(w, 's-cx-3h'), updatedAt: ago(HOUR) }), false, 'sin pid, menos de 2 h: viva');
});

// ── T27 a T33 ──────────────────────────────────────────────────────────────────────────────────────────────────

test('T27 Hook_CannotWrite_ExitsZero @story-2.81 @ac-26 — sin poder escribir, o con un JSON roto, sale 0 y lo anota; apagado no hace nada', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'los permisos de carpeta no frenan en Windows ni como root' : false }, () => {
  const w = world();
  const log = path.join(w.sdir, 'office', 'session-state-errors.log');
  fs.mkdirSync(path.join(w.sdir, 'sessions'), { recursive: true });
  fs.chmodSync(path.join(w.sdir, 'sessions'), 0o500);
  try {
    const r = hook(w, { hook_event_name: 'SessionStart', session_id: 's-ro', source: 'startup' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { fs.chmodSync(path.join(w.sdir, 'sessions'), 0o700); }
  assert.match(fs.readFileSync(log, 'utf8'), /s-ro/);
  const r2 = hook(w, '{esto no es json');
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout, '');
  assert.match(fs.readFileSync(log, 'utf8'), /JSON/);
  const v = world();
  const r3 = hook(v, { hook_event_name: 'SessionStart', session_id: 's-off', source: 'startup' }, { TYCON_SESSION_STATE: '0' });
  assert.strictEqual(r3.status, 0);
  assert.strictEqual(stateOf(v, 's-off'), null);
  assert.ok(!fs.existsSync(path.join(v.sdir, 'office', 'session-state-errors.log')));
});

test('T28 Installer_RegistersHooks_Idempotent @story-2.81 @ac-27 — el aplicador de Claude y el despliegue de Codex lo registran una vez', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-inst-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{}\n');
  const apply = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'), '--settings', settings,
    '--hooks-dir', path.join(ROOT, 'scripts', 'hooks'), '--skills', path.join(ROOT, 'skills'),
    '--list', path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), '--effects', path.join(ROOT, 'scripts', 'setup', 'install-effects.json')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_HARNESS_SHARED_DONE: '1' },
  });
  const claudeCount = () => {
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const out = {};
    for (const [ev, groups] of Object.entries(s.hooks || {})) {
      for (const g of groups) for (const h of g.hooks || []) if (/session-state\.js/.test(h.command)) out[`${ev}·${g.matcher || ''}`] = (out[`${ev}·${g.matcher || ''}`] || 0) + 1;
    }
    return out;
  };
  for (let i = 0; i < 2; i += 1) { const r = apply(); assert.strictEqual(r.status, 0, r.stderr + r.stdout); }
  const want = ['SessionStart·', 'SessionEnd·', 'Notification·permission_prompt', 'PreToolUse·AskUserQuestion|ExitPlanMode|mcp__spokenly__ask_user_dictation', 'PostToolUse·', 'UserPromptSubmit·', 'Stop·'];
  assert.deepStrictEqual(Object.keys(claudeCount()).sort(), [...want].sort());
  for (const [k, n] of Object.entries(claudeCount())) assert.strictEqual(n, 1, `${k} una sola vez`);
  // Codex
  const codexHome = path.join(base, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const deploy = () => spawnSync(process.execPath, [path.join(ROOT, 'build', 'deploy-codex-hooks.js')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, TYCON_SKILLS_DIR: ROOT },
  });
  for (let i = 0; i < 2; i += 1) { const r = deploy(); assert.strictEqual(r.status, 0, r.stderr + r.stdout); }
  const cx = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  const cxCount = {};
  for (const [ev, groups] of Object.entries(cx.hooks || {})) {
    for (const g of groups) for (const h of g.hooks || []) if (/session-state\.js/.test(h.command)) cxCount[ev] = (cxCount[ev] || 0) + 1;
  }
  assert.deepStrictEqual(cxCount, { SessionStart: 1, UserPromptSubmit: 1, Stop: 1 });
});

test('T29 Parity_CodexAsymmetryDeclared @story-2.81 @ac-28 — la paridad de registro pasa; sin la asimetría declarada, falla nombrando los dos momentos', () => {
  const check = path.join(ROOT, 'build', 'check-hooks-registration.js');
  const ok = spawnSync(process.execPath, [check], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  // la misma comprobación sobre una copia del árbol sin la declaración del gancho nuevo
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-parity-'));
  for (const rel of ['build', path.join('scripts', 'lib'), path.join('scripts', 'controls-bench', 'cases'), path.join('scripts', 'setup'), 'adapters', 'integrations']) {
    if (fs.existsSync(path.join(ROOT, rel))) fs.cpSync(path.join(ROOT, rel), path.join(copy, rel), { recursive: true });
  }
  const frag = path.join(copy, 'adapters', 'codex', 'hooks.json');
  const raw = JSON.parse(fs.readFileSync(frag, 'utf8'));
  const before = raw.divergences.length;
  raw.divergences = raw.divergences.filter((d) => !(d.scripts || []).includes('session-state.js'));
  assert.strictEqual(raw.divergences.length, before - 1, 'la asimetría del gancho nuevo está declarada');
  fs.writeFileSync(frag, JSON.stringify(raw, null, 2));
  const bad = spawnSync(process.execPath, [path.join(copy, 'build', 'check-hooks-registration.js')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /session-state\.js/);
  assert.match(bad.stdout, /Notification/);
  assert.match(bad.stdout, /SessionEnd/);
});

test('T30 Regression_WipAndWaitNotice_Unchanged @story-2.81 @ac-29 — /wip y wait-notice siguen verdes', { timeout: 600000 }, () => {
  for (const suite of ['work-in-progress.test.js', 'wait-notice.test.js']) {
    const r = spawnSync(process.execPath, ['--test', path.join(__dirname, suite)], { encoding: 'utf8', env: { ...process.env, TYCON_SESSION_STATE: '0' } });
    assert.strictEqual(r.status, 0, `${suite}: ${r.stdout.slice(-2000)}`);
  }
});

test('T31 Quiet_LivePidOldFile_NotInactive @story-2.81 @ac-23 — pid vivo y archivo de hace 3 h: quieta, no inactiva', () => {
  const { buildOffice } = require(OFFICE);
  const updatedAt = new Date(Date.now() - 3 * HOUR).toISOString();
  const state = { schema: 1, session: 's-q', tool: 'claude', name: 'Quieta', sentence: 'Va por el paso «Revisores».', step: 'Revisores', endAt: null, endWithoutHour: 'sin datos', waitingForOwner: false, waitingFor: null, updatedAt, pid: process.pid };
  // una sesión de Claude viva con su corrida: tiene su fila en /wip y su archivo, que no cambió hace 3 h
  const wip = { rows: [{ work: '9.9 · Una historia', state: 'Revisores', end: '', session: 'Quieta', folder: 'repo' }], details: [{ sid: 's-q', status: 'busy' }],
    extra: [{ kind: 'pipeline', current: 'reviewers', steps: [{ id: 'reviewers', name: 'Revisores', done: false }] }], free: [], halfway: [], unreadable: [] };
  const { data } = buildOffice({ wip, sessionFiles: [state], nowMs: Date.now() });
  const a = data.agents.find((x) => x.nombre === 'Quieta');
  assert.ok(a, JSON.stringify(data.agents));
  assert.notStrictEqual(a.estado, 'inactiva');
  assert.strictEqual(a.haciendo, 'Va por el paso «Revisores».');
  assert.match(a.callada, /^sin novedades desde las \d\d:\d\d$/);
  assert.strictEqual(lib().isStale(state), false);
});

test('T32 OtherSession_ClearAndRestore_UpdateItsFile @story-2.81 @ac-20 — los comandos sobre otra sesión ponen al día el archivo de esa sesión', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-otra-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  // stable-data: los commits de juguete llevan fecha fija y el mantenimiento de git apagado
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  // una historia por sesión: dos corridas de la misma historia no arrancan a la vez
  const stories = {};
  for (const [i, sid] of ['s-a', 's-b', 's-c', 's-d', 's-f'].entries()) {
    const n = `9.${i + 1}`;
    stories[sid] = path.join(repo, 'specs', `story-${n}-otra.md`);
    fs.writeFileSync(stories[sid], ['---', `story: "${n}"`, 'title: "otra"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---', `# Story ${n}`, '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
  }
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const w = { home, sdir: stateDir(home) };
  const env = (sid, extra = {}) => cleanEnv(home, { TYCON_HOME: '', TYCON_GUIDES_DIR: ROOT, CLAUDE_CODE_SESSION_ID: sid, ...extra });
  const run = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo });
  const start = (sid) => { const r = run('pipeline.js', ['start', '--story', stories[sid], '--repo', repo, '--brief'], sid); assert.strictEqual(r.status, 0, r.stderr + r.stdout); };
  const withStep = (sid) => lib().update(w.sdir, sid, { step: 'Implementar', sentence: 'Va por el paso «Implementar».' }, { create: true, tool: 'claude' });
  const cleared = (sid) => { const s = stateOf(w, sid); assert.ok(s, `${sid} tiene archivo`); assert.strictEqual(s.step, null, sid); assert.strictEqual(s.endAt, null, sid); assert.strictEqual(s.sentence, lib().NO_PIPELINE, sid); };
  // clear: la propia
  start('s-a'); withStep('s-a');
  let r = run('marker.js', ['clear'], 's-a');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  cleared('s-a');
  // clear-session <otra>
  start('s-b'); withStep('s-b');
  r = run('marker.js', ['clear-session', 's-b'], 's-a');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  cleared('s-b');
  // clear-session --lost <otra>, con la firma del dueño
  start('s-c'); withStep('s-c');
  r = run('marker.js', ['clear-session', 's-c', '--lost'], 's-a', conVentana({}));
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  cleared('s-c');
  // restore: el paso vuelve al archivo de la sesión que restaura
  start('s-d');
  fs.rmSync(path.join(w.sdir, 'active', 's-d.json'));
  lib().update(w.sdir, 's-d', {}, { create: true, tool: 'claude' });
  r = run('marker.js', ['restore', 's-d'], 's-d', conVentana({}));
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(stateOf(w, 's-d').step, 'restore deja el paso que vuelve');
  // adhoc clear-orphan <otra>: un carril de hace 25 h de una sesión que ya no está
  fs.mkdirSync(path.join(w.sdir, 'adhoc'), { recursive: true });
  const old = new Date(Date.now() - 25 * HOUR).toISOString();
  fs.writeFileSync(path.join(w.sdir, 'adhoc', 's-e.json'), JSON.stringify({ reason: 'un arreglo viejo', declaredAt: old, lastTouch: old }));
  lib().update(w.sdir, 's-e', { sentence: 'un arreglo viejo' }, { create: true, tool: 'claude' });
  r = run('marker.js', ['adhoc', 'clear-orphan', 's-e'], 's-a');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  cleared('s-e');
  // una sesión sin archivo sigue sin archivo
  start('s-f');
  r = run('marker.js', ['clear-session', 's-f'], 's-a');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(stateOf(w, 's-f'), null);
});

test('T33 TwoWriters_DoNotOverwriteEachOther @story-2.81 @ac-17 — la espera del gancho y el paso de marker.js conviven', () => {
  const w = world();
  claudeSession(w, 's-dos', 'Dos');
  pipelineMarker(w, 's-dos');
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-dos', source: 'startup' }).status, 0);
  assert.strictEqual(hook(w, { hook_event_name: 'Notification', session_id: 's-dos', notification_type: 'permission_prompt', message: 'permission' }).status, 0);
  const r = marker(w, 's-dos', ['start-step', 'implement']);
  assert.strictEqual(r.status, 0, r.stderr);
  const st = stateOf(w, 's-dos');
  assert.strictEqual(st.step, STEPS.byId('implement').name);
  assert.strictEqual(st.waitingForOwner, true);
  assert.strictEqual(st.waitingFor, 'un permiso');
});

// ── Las regresiones del pase adversarial ───────────────────────────────────────────────────────────────────────

test('T76 Codex_StartWithoutTurnId_IsCodex @story-2.81 @ac-17 — el arranque real de Codex no trae turn_id y se reconoce igual', () => {
  const w = world();
  pipelineMarker(w, 's-cx3');
  // la forma real del arranque de Codex: sin turn_id, con la conversación en ~/.codex/sessions
  const start = { hook_event_name: 'SessionStart', session_id: 's-cx3', model: 'gpt-5', permission_mode: 'default', source: 'startup',
    cwd: w.home, transcript_path: path.join(w.home, '.codex', 'sessions', '2026', 'x.jsonl') };
  assert.strictEqual(hook(w, start).status, 0);
  const st = stateOf(w, 's-cx3');
  assert.strictEqual(st.tool, 'codex');
  assert.strictEqual(st.pid, null);
  // un archivo creado como de Claude por un arranque sin señales se corrige con el próximo momento de Codex
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-cx4', source: 'startup' }).status, 0);
  assert.strictEqual(stateOf(w, 's-cx4').tool, 'claude');
  assert.strictEqual(hook(w, { hook_event_name: 'UserPromptSubmit', session_id: 's-cx4', turn_id: 't1', prompt: 'hola' }).status, 0);
  assert.strictEqual(stateOf(w, 's-cx4').tool, 'codex');
  // la oficina la dibuja trabajando, desde su archivo
  const { buildOffice } = require(OFFICE);
  const { data } = buildOffice({
    wip: { rows: [], details: [], extra: [], free: [], freeSids: [], halfwayItems: [{ kind: 'run', text: 'La historia', cleanAfter: null, sid: 's-cx3' }], unreadable: [] },
    sessionFiles: [st], codexNames: new Map([['s-cx3', 'Lola']]), nowMs: Date.now(),
  });
  const lola = data.agents.find((a) => a.nombre === 'Lola');
  assert.ok(lola, JSON.stringify(data.agents));
  assert.strictEqual(lola.estado, 'trabajando');
});

test('T77 AdoptAndSet_UpdateSessionFiles @story-2.81 @ac-20 — adoptar una corrida o rehacer el marcador con set pone al día los dos archivos', () => {
  const w = world();
  claudeSession(w, 's-vieja', 'Vieja', deadPid());
  claudeSession(w, 's-nueva', 'Nueva');
  pipelineMarker(w, 's-vieja');
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-vieja', source: 'startup' }).status, 0);
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-nueva', source: 'startup' }).status, 0);
  assert.ok(stateOf(w, 's-vieja').step, 'la vieja arranca con su paso');
  assert.strictEqual(stateOf(w, 's-nueva').step, null);
  const r = marker(w, 's-nueva', ['adopt-session', 's-vieja']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf(w, 's-vieja').step, null, 'la vieja ya no tiene la corrida');
  assert.strictEqual(stateOf(w, 's-vieja').sentence, lib().NO_PIPELINE);
  assert.strictEqual(stateOf(w, 's-nueva').step, STEPS.byId('implement').name, 'la nueva toma el paso');
  // set con otros pasos pendientes: el archivo dice el paso nuevo
  const m = JSON.parse(fs.readFileSync(path.join(w.sdir, 'active', 's-nueva.json'), 'utf8'));
  const ids = STEPS.STEPS.filter((s) => !s.flag).map((s) => s.id);
  const done = ids.slice(0, ids.indexOf('reviewers'));
  const s = marker(w, 's-nueva', ['set', JSON.stringify({ ...m, stepsCompleted: done, stepsPending: ids.filter((x) => !done.includes(x)) })]);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual(stateOf(w, 's-nueva').step, STEPS.byId('reviewers').name);
});

test('T78 ClaudeSession_TwoFiles_LiveWins @story-2.81 @ac-17 — con dos archivos de la misma sesión, manda el del proceso vivo', () => {
  const w = world();
  // el muerto primero en el orden de la carpeta
  fs.writeFileSync(path.join(w.sessions, '0001.json'), JSON.stringify({ pid: deadPid(), sessionId: 's-par', name: 'Muerta', status: 'idle' }));
  claudeSession(w, 's-par', 'Viva');
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-par', source: 'startup' }).status, 0);
  assert.strictEqual(stateOf(w, 's-par').name, 'Viva');
  assert.strictEqual(stateOf(w, 's-par').pid, process.pid);
});

test('T79 OldSchemeMarker_StepName @story-2.81 @ac-19 — un marcador de pasos por número dice el nombre del paso, como /wip', () => {
  const w = world();
  fs.writeFileSync(path.join(w.sdir, 'active', 's-num.json'), JSON.stringify({
    sessionId: 's-num', storyId: '9.9', stepsCompleted: ['0', '1', '2', '3', '4'], stepsPending: ['5', '6', '7', '8'],
    startedAt: new Date().toISOString(), lastTouch: new Date().toISOString(), stepTimings: {},
  }));
  const f = lib().fromDisk(w.sdir, 's-num', { home: w.home });
  assert.ok(typeof f.step === 'string' && f.step.length > 0, 'un nombre, no vacío');
  assert.strictEqual(f.step, STEPS.stepName('5'));
  assert.doesNotMatch(f.sentence, /paso \d/);
});

test('T80 StaleMarker_LooseWorkWins @story-2.81 @ac-20 — un marcador sin tocar hace más de un día no tapa el trabajo suelto ni su hora', () => {
  const w = world();
  pipelineMarker(w, 's-vie', { extra: { lastTouch: new Date(Date.now() - 25 * HOUR).toISOString() } });
  const until = new Date(Date.now() + HOUR).toISOString();
  fs.writeFileSync(path.join(w.sdir, 'adhoc', 's-vie.json'), JSON.stringify({ reason: 'Arreglo el aviso del pedido', until }));
  const f = lib().fromDisk(w.sdir, 's-vie', { home: w.home });
  assert.strictEqual(f.step, null);
  assert.strictEqual(f.sentence, 'Arreglo el aviso del pedido');
  assert.strictEqual(f.endAt, until);
});

test('T81 ReadAll_UnsafeSessionId_Accepted @story-2.81 @ac-25 — un id con caracteres que se sanean se lee igual que con read()', () => {
  const w = world();
  assert.strictEqual(lib().update(w.sdir, 'a/b:c', {}, { create: true, tool: 'codex' }), 'written');
  assert.ok(lib().read(w.sdir, 'a/b:c').state);
  const all = lib().readAll(w.sdir);
  assert.deepStrictEqual(all.problems, []);
  assert.strictEqual(all.states.length, 1);
  assert.strictEqual(all.states[0].session, 'a/b:c');
});

test('T82 BrokenMarker_NotWrittenAsNoPipeline @story-2.81 @ac-26 — un marcador que no se lee no borra el paso: queda en el registro', () => {
  const w = world();
  claudeSession(w, 's-rot', 'Rota');
  pipelineMarker(w, 's-rot');
  assert.strictEqual(hook(w, { hook_event_name: 'SessionStart', session_id: 's-rot', source: 'startup' }).status, 0);
  const before = stateOf(w, 's-rot');
  assert.ok(before.step);
  fs.writeFileSync(path.join(w.sdir, 'active', 's-rot.json'), '{roto');
  assert.strictEqual(lib().refresh(w.sdir, 's-rot', { home: w.home }), 'error');
  assert.strictEqual(stateOf(w, 's-rot').step, before.step, 'el paso queda');
  assert.match(fs.readFileSync(lib().errorsLogOf(w.sdir), 'utf8'), /s-rot[^\n]*JSON roto/);
});
