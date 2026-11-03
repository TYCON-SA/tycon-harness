'use strict';
// coordination-notice.test.js — what the coordinator hears on each turn (the cap of working sessions) and what
// deep-review-gate adds when another adversarial pass is in flight. Nothing here reads the real HOME: every case builds
// its own HOME and profile. The positive cases run in-process: who the coordinator is comes from the harness tree's own
// profile, which a child process can't be handed; the hook itself is run only in the safe direction (it stays quiet).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'coordination-notice.js');
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { harnessCopy } = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'harness-copy.js'));

const NOW = Date.parse('2026-10-27T14:00:00.000Z');
const mins = (n) => NOW - n * 60000;
const COORD = 'coord-sid-1';
const POSIX_PERMS = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false };

// A toy machine with the coordinator role in the profile and, by default, this coordinator designated.
function toy({ role = 'coordinadora', designated = COORD } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-notice-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(role ? { approvals: { relay_session: role } } : {}));
  if (designated) {
    fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts: new Date(NOW).toISOString(), name: 'relay-designation', status: 'ok', sesion: designated, rol: role, quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  }
  const t = { root, home, state, arnes, opts: { home, arnes, env: {}, now: NOW, sessionId: COORD } };
  session(t, COORD, 'Coordinadora', { status: 'busy', statusUpdatedAt: mins(0) });
  return t;
}
// A session file as Claude Code writes it, alive (this process's pid). `busyFor`: minutes since it went busy.
function session(t, sid, name, extra = {}) {
  fs.writeFileSync(path.join(t.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({
    pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: mins(20), cwd: t.root, ...extra,
  }));
}
const busy = (t, sid, name, minutesAgo) => session(t, sid, name, { status: 'busy', statusUpdatedAt: mins(minutesAgo) });
function marker(t, sid, fields) {
  fs.writeFileSync(path.join(t.state, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, stepsPending: [6], lastTouch: new Date(NOW).toISOString(), ...fields }));
}
const inFlight = (t, sid, storyId, minutesAgo) => marker(t, sid, { storyId, adversarial: { launchedAt: new Date(mins(minutesAgo)).toISOString(), runId: 'wf_x' } });

// ── The cap (AC 11, 12) ──────────────────────────────────────────────────────────────────────────────────────────

test('T11 Notice_AtCap_SaysWhoWorks @story-8.122 @ac-11: con 3 trabajando y el tope en 3 avisa quiénes; con 2 calla', () => {
  const t = toy();
  busy(t, 's-a', 'Uno', 30);
  busy(t, 's-b', 'Dos', 20);
  session(t, 's-idle', 'Quieta');
  assert.strictEqual(C.capNotice(t.opts), null, 'con 2 trabajando no dice nada');
  busy(t, 's-c', 'Tres', 10);
  const n = C.capNotice(t.opts);
  assert.ok(n, 'con 3 avisa');
  assert.match(n, /en el tope/);
  assert.match(n, /3 de 3/);
  for (const name of ['Uno', 'Dos', 'Tres']) assert.ok(n.includes(name), `nombra a ${name}: ${n}`);
  assert.ok(!n.includes('Quieta'), 'la que espera no se nombra');
  // the coordinator, busy because it is taking this very turn, is not one of the working sessions
  assert.ok(!/Coordinadora/.test(n), `la coordinadora no se cuenta a sí misma: ${n}`);
});

test('T12 Notice_OverCap_SaysByHowMuch @story-8.122 @ac-12: con 4 dice el exceso y cuál trabaja hace menos', () => {
  const t = toy();
  busy(t, 's-a', 'Uno', 40);
  busy(t, 's-b', 'Dos', 30);
  busy(t, 's-c', 'Tres', 3);
  busy(t, 's-d', 'Cuatro', 15);
  const n = C.capNotice(t.opts);
  assert.match(n, /pasó el tope por 1/);
  assert.match(n, /4 de 3/);
  assert.match(n, /hace menos: Tres/);
});

test('T12b Notice_CapFromConfig @story-8.122 @ac-11: el tope es el del lector (aquí, el de la máquina)', () => {
  const t = toy();
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ coordination: { max_working: 2 } }));
  busy(t, 's-a', 'Uno', 30);
  assert.strictEqual(C.capNotice(t.opts), null);
  busy(t, 's-b', 'Dos', 20);
  assert.match(C.capNotice(t.opts), /2 de 2/);
});

// ── Another adversarial pass in flight (AC 13) ───────────────────────────────────────────────────────────────────

test('T13 DeepReviewGate_OtherPassInFlight @story-8.122 @ac-13: un pase de otra sesión sale con historia, sesión y hora; el propio y uno cerrado no', () => {
  const t = toy();
  const me = 'propia-1';
  session(t, me, 'Propia', { status: 'busy' });
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: me }), null, 'sin otro pase no trae nada');
  inFlight(t, me, '9.1', 5);
  session(t, 'otra-1', 'Otra', { status: 'idle' });
  marker(t, 'otra-1', { storyId: '9.3', adversarial: { launchedAt: new Date(mins(60)).toISOString() }, deepReviewDone: true });
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: me }), null, 'el propio y uno ya cerrado no cuentan');
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  inFlight(t, 'otra-2', '9.2', 12);
  const r = C.adversarialTurn({ ...t.opts, sessionId: me });
  assert.ok(r, 'con otro en vuelo trae algo');
  assert.deepStrictEqual(r.other_in_flight.map((a) => [a.storyId, a.session, a.since]), [['9.2', 'Vecina', new Date(mins(12)).toISOString()]]);
  assert.match(r.turn, /pedile turno a la coordinadora/);
  assert.match(r.turn, /9\.2/);
});

// ── Quiet without a coordinator (AC 20) and own errors (AC 21) ───────────────────────────────────────────────────

test('T20 NoRole_NothingSaid @story-8.122 @ac-20: sin rol, sin designación o en otra sesión, ni el tope ni el pase dicen nada', () => {
  for (const [label, t, sid] of [
    ['sin rol', toy({ role: null }), COORD],
    ['sin designación', toy({ designated: null }), COORD],
    ['otra sesión', toy(), 'otra-sesion'],
  ]) {
    for (const [s, n] of [['s-a', 'Uno'], ['s-b', 'Dos'], ['s-c', 'Tres'], ['s-d', 'Cuatro']]) busy(t, s, n, 10);
    inFlight(t, 's-a', '9.9', 5);
    assert.strictEqual(C.capNotice({ ...t.opts, sessionId: sid }), null, `${label}: el tope calla`);
    if (label !== 'otra sesión') assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 's-b' }), null, `${label}: el pase calla`);
  }
  // the twin with the designation in place does speak
  const t = toy();
  for (const [s, n] of [['s-a', 'Uno'], ['s-b', 'Dos'], ['s-c', 'Tres']]) busy(t, s, n, 10);
  inFlight(t, 's-a', '9.9', 5);
  assert.ok(C.capNotice(t.opts));
  assert.ok(C.adversarialTurn({ ...t.opts, sessionId: 's-b' }));
});

// ── The rules, read again in each new context ────────────────────────────────────────────────────────────────────

const GUIDE_PATH = path.join(ROOT, 'guides', 'coordination.md');
// A saved conversation as Claude Code leaves it: its title at the top, and again after a rename.
function saved(t, sid, ...titles) {
  const dir = path.join(t.home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, [...titles.map((title) => JSON.stringify({ type: 'agent-name', agentName: title, sessionId: sid })), JSON.stringify({ type: 'user', sessionId: sid }), ''].join('\n'));
  return file;
}

test('Guide_Designated_Compact_ReadsTheRules: la designada, al compactar y al limpiar con el mismo id, lee la guía; al arrancar o retomar no', () => {
  const t = toy();
  for (const source of ['compact', 'clear']) {
    const n = C.guideNotice({ ...t.opts, source });
    assert.ok(n && n.includes(GUIDE_PATH), `${source}: manda a leer la guía: ${n}`);
    assert.match(n, /sos la coordinadora/);
  }
  assert.ok(fs.existsSync(GUIDE_PATH), 'la ruta que manda a leer existe');
  for (const source of ['startup', 'resume', undefined]) assert.strictEqual(C.guideNotice({ ...t.opts, source }), null, `${source}: calla`);
});

test('Guide_NotDesignated_Silent: otra sesión, sin designación o sin rol, compactar y limpiar no dicen nada', () => {
  const t = toy();
  saved(t, COORD, 'Coordinadora');
  const transcript = saved(t, 'otra', 'Vecina');
  assert.strictEqual(C.guideNotice({ ...t.opts, sessionId: 'otra', source: 'compact', title: 'Coordinadora', transcript }), null, 'compactar no quita la designación: una con el mismo título no es ella');
  assert.strictEqual(C.guideNotice({ ...t.opts, sessionId: 'otra', source: 'clear', title: 'Vecina', transcript }), null, 'limpiar con otro título');
  assert.strictEqual(C.guideNotice({ ...t.opts, sessionId: 'otra', source: 'clear', transcript }), null, 'sin título no hay con qué reconocerla');
  assert.strictEqual(C.guideNotice({ ...t.opts, sessionId: 'otra', source: 'clear', title: 'Coordinadora' }), null, 'sin conversación tampoco');
  for (const [label, o] of [['sin designación', toy({ designated: null })], ['sin rol', toy({ role: null })]]) {
    const f = saved(o, COORD, 'Coordinadora');
    assert.strictEqual(C.guideNotice({ ...o.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript: f }), null, label);
    assert.strictEqual(C.guideNotice({ ...o.opts, sessionId: COORD, source: 'compact' }), null, `${label}, al compactar`);
  }
});

test('Guide_ClearLosesDesignation_SaysHowToGetItBack: tras limpiar, con otro id y el mismo título, dice cómo recuperarla y no la recupera sola', () => {
  const t = toy();
  saved(t, COORD, 'Coordinadora');
  const transcript = saved(t, 'nueva', 'Coordinadora');
  const n = C.guideNotice({ ...t.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript });
  assert.match(n, /era la coordinadora/);
  assert.match(n, /«Esta sesión es la coordinadora»/);
  assert.match(n, /nunca vos/, 'la frase la escribe la persona');
  assert.match(n, /designate-relay/);
  assert.strictEqual(require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js')).designacionVigente({ home: t.home }).sesion, COORD, 'la designación no se movió');
  // the title that counts is the last one: she was renamed after starting
  saved(t, COORD, 'Vieja', 'Coordinadora');
  assert.match(C.guideNotice({ ...t.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript }), /era la coordinadora/);
  saved(t, COORD, 'Coordinadora', 'Otro nombre');
  assert.strictEqual(C.guideNotice({ ...t.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript }), null);
  // a long conversation: the title stays at the top, past what is read from the end
  const big = path.join(t.home, '.claude', 'projects', '-repo', `${COORD}.jsonl`);
  fs.writeFileSync(big, `${JSON.stringify({ type: 'agent-name', agentName: 'Coordinadora' })}\n${`${JSON.stringify({ type: 'user', text: 'x'.repeat(1000) })}\n`.repeat(1000)}`);
  assert.match(C.guideNotice({ ...t.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript }), /era la coordinadora/);
});

// The real hook and the real command read the role from their own tree's profile, so they run from a copy that has one.
function copyWithProfile() {
  const copy = harnessCopy();
  fs.writeFileSync(path.join(copy, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  return copy;
}
function cleanEnv(t) {
  const env = { ...process.env, HOME: t.home, USERPROFILE: t.home };
  for (const k of ['TYCON_STATE_DIR', 'TYCON_HOME', 'TYCON_PROFILE', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'TYCON_EVAL_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[k];
  return env;
}

test('Guide_RealHook_SessionStart: el gancho real se lo dice a la designada al compactar, y a las demás no', () => {
  const t = toy();
  const copy = copyWithProfile();
  const env = cleanEnv(t);
  const hook = (event) => spawnSync(process.execPath, [path.join(copy, 'scripts', 'hooks', 'coordination-notice.js')], { input: JSON.stringify({ hook_event_name: 'SessionStart', ...event }), encoding: 'utf8', env });
  const dicho = hook({ session_id: COORD, source: 'compact' });
  assert.strictEqual(dicho.status, 0, dicho.stderr);
  assert.ok(dicho.stdout.includes(path.join(copy, 'guides', 'coordination.md')), `manda a leer la guía: ${dicho.stdout}`);
  for (const event of [{ session_id: 'otra', source: 'compact' }, { session_id: COORD, source: 'startup' }, { session_id: 'otra', source: 'clear' }]) {
    const r = hook(event);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', JSON.stringify(event));
  }
  // after clearing, the hook hands over the title and the conversation: same title, how to get it back; another, nothing
  saved(t, COORD, 'Coordinadora');
  const transcript = saved(t, 'nueva', 'Coordinadora');
  const perdida = hook({ session_id: 'nueva', source: 'clear', session_title: 'Coordinadora', transcript_path: transcript });
  assert.strictEqual(perdida.status, 0, perdida.stderr);
  assert.match(perdida.stdout, /era la coordinadora/);
  assert.strictEqual(hook({ session_id: 'nueva', source: 'clear', session_title: 'Vecina', transcript_path: transcript }).stdout, '');
});

test('Guide_Designate_SaysToReadTheRules: al designarse, el comando real manda a leer la guía', () => {
  const t = toy({ designated: null });
  const copy = copyWithProfile();
  const env = { ...cleanEnv(t), CLAUDE_CODE_SESSION_ID: COORD };
  const marker = path.join(copy, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  const guide = path.join(copy, 'guides', 'coordination.md');
  const r = spawnSync(process.execPath, [marker, 'designate-relay', '--approved-by', 'Dev de Prueba', '--quote', 'Esta sesión es la coordinadora'], { cwd: t.root, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(guide), `manda a leer la guía: ${r.stderr}`);
  // a failed designation sends nobody to read anything
  const no = spawnSync(process.execPath, [marker, 'designate-relay', '--approved-by', 'Dev de Prueba'], { cwd: t.root, encoding: 'utf8', env });
  assert.notStrictEqual(no.status, 0);
  assert.ok(!no.stderr.includes(guide));
});

test('T20b Hook_WithoutCoordinator_Silent @story-8.122 @ac-20: el gancho real, sin coordinadora, no imprime nada y sale 0', () => {
  const t = toy({ role: null, designated: null });
  for (const [s, n] of [['s-a', 'Uno'], ['s-b', 'Dos'], ['s-c', 'Tres'], ['s-d', 'Cuatro']]) busy(t, s, n, 10);
  const env = { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_PROFILE: '0' };
  for (const k of ['TYCON_STATE_DIR', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'TYCON_EVAL_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[k];
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: COORD, hook_event_name: 'UserPromptSubmit', prompt: 'hola' }), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  // and with an event it can't read, it doesn't break the turn either
  const rota = spawnSync(process.execPath, [HOOK], { input: '{no es json', encoding: 'utf8', env });
  assert.strictEqual(rota.status, 0, rota.stderr);
});

test('T21 OwnErrors_DoNotBlock @story-8.122 @ac-21: con la configuración rota o la carpeta de sesiones ilegible lo dice en una línea', POSIX_PERMS, () => {
  const rota = toy();
  fs.writeFileSync(path.join(rota.home, '.claude', 'tycon.json'), '{ roto');
  const n = C.capNotice(rota.opts);
  assert.ok(n, 'la coordinadora se entera');
  assert.match(n, /No pude leer/);
  assert.strictEqual(n.split('\n').filter((l) => /No pude leer/.test(l)).length, 1, 'una línea');

  const t = toy();
  const sessions = path.join(t.home, '.claude', 'sessions');
  fs.chmodSync(sessions, 0o000);
  try {
    // the designation lives in the gates log, so the coordinator is still known; what it can't count, it says
    const m = C.capNotice(t.opts);
    assert.match(m, /No pude leer/);
    assert.match(m, /sessions/);
  } finally { fs.chmodSync(sessions, 0o755); }
});

// ── Cost (AC 22) ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T22 Notice_UnderBudget @story-8.122 @ac-22: 20 turnos con 6 sesiones, mediana bajo 300 ms, sin abrir una conversación', () => {
  const t = toy();
  const projects = path.join(t.home, '.claude', 'projects');
  for (let i = 0; i < 6; i++) {
    const sid = `s-${i}`;
    // sessions without a name: the status of /wip would look for their title in the conversation
    session(t, sid, '', { status: i < 4 ? 'busy' : 'idle', statusUpdatedAt: mins(10 + i) });
    const dir = path.join(projects, t.root.replace(/[^A-Za-z0-9-]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: `Titulo${i}` })}\n`);
    marker(t, sid, { storyId: `1.${i}` });
  }
  const opened = [];
  const origOpen = fs.openSync;
  const origRead = fs.readFileSync;
  fs.openSync = function (p, ...rest) { if (String(p).startsWith(projects)) opened.push(String(p)); return origOpen.call(this, p, ...rest); };
  fs.readFileSync = function (p, ...rest) { if (typeof p === 'string' && p.startsWith(projects)) opened.push(p); return origRead.call(this, p, ...rest); };
  const times = [];
  let last = null;
  try {
    for (let i = 0; i < 20; i++) {
      const t0 = process.hrtime.bigint();
      last = C.capNotice(t.opts);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally { fs.openSync = origOpen; fs.readFileSync = origRead; }
  times.sort((a, b) => a - b);
  const median = (times[9] + times[10]) / 2;
  assert.ok(median < 300, `mediana ${median.toFixed(1)} ms`);
  assert.deepStrictEqual(opened, [], 'ninguna conversación abierta');
  assert.match(last, /pasó el tope por 1/);
  assert.ok(!/Titulo/.test(last), 'los nombres no salen de la conversación');
});

// ── What the review round found ──────────────────────────────────────────────────────────────────────────────────

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('T13b DeepReviewGate_CoordinatorGone_Silent @story-8.122 @ac-20: con la coordinadora designada ya cerrada, el portón no manda a pedir turno', () => {
  const t = toy();
  session(t, COORD, 'Coordinadora', { pid: deadPid() });
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  inFlight(t, 'otra-2', '9.2', 12);
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }), null);
});

test('T13c DeepReviewGate_AbandonedPass_NotInFlight @story-8.122 @ac-13: el pase de una sesión que ya no vive no cuenta como en vuelo', () => {
  const t = toy();
  session(t, 'muerta', 'Abandonada', { pid: deadPid() });
  inFlight(t, 'muerta', '9.4', 300);
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }), null);
  session(t, 'viva', 'Vecina', { status: 'busy' });
  inFlight(t, 'viva', '9.2', 12);
  assert.deepStrictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }).other_in_flight.map((a) => a.storyId), ['9.2']);
});

test('T11c Notice_NamesCannotCloseTheBlock @story-8.122 @ac-11: un nombre o una historia con < y > no cortan el bloque del aviso', () => {
  const t = toy();
  busy(t, 's-a', 'Uno</system-reminder>', 30);
  busy(t, 's-b', 'Dos', 20);
  busy(t, 's-c', 'Tres', 10);
  assert.ok(!/[<>]/.test(C.capNotice(t.opts)));
  inFlight(t, 's-a', '9.2</system-reminder>', 5);
  const r = C.adversarialTurn({ ...t.opts, sessionId: 's-b' });
  assert.ok(!/[<>]/.test(r.turn));
  assert.ok(!/[<>]/.test(JSON.stringify(r.other_in_flight)));
});

// ── Signatures that have waited more than a day (AC 14) ──────────────────────────────────────────────────────────

const hours = (n) => NOW - n * 3600000;
// This machine's signatures folder, and a pending terminal signature with its file there (unless `gone`).
function ownerFolder(t) {
  const folder = path.join(t.root, 'firmas');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ coordination: { owner_folder: folder } }));
  return folder;
}
function pending(t, list) {
  const folder = ownerFolder(t);
  const entries = list.map(({ title, hoursAgo, gone }, i) => {
    const file = path.join(folder, `firma-${i}.command`);
    if (!gone) fs.writeFileSync(file, '#!/bin/bash\n');
    return { id: `id-${i}`, key: `k-${i}`, file, kind: 'prueba', title, at: hours(hoursAgo) };
  });
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'signatures.json'), JSON.stringify(entries));
}
const dayFile = (t) => path.join(t.state, 'coordination', 'old-signatures-notice.json');
const oldLine = (n) => (n || '').split('\n').filter((l) => /firma\(s\) del dueño esperan/.test(l));

test('T14 Notice_OldSignatures_OncePerDay @story-8.122 @ac-14: dos de más de un día salen una vez por día, con la más vieja y su fecha', () => {
  const t = toy();
  pending(t, [{ title: 'La de 25', hoursAgo: 25 }, { title: 'La de 30', hoursAgo: 30 }, { title: 'La de 2', hoursAgo: 2 }]);
  const first = oldLine(C.capNotice(t.opts));
  assert.strictEqual(first.length, 1, 'una línea');
  assert.match(first[0], /\b2 firma\(s\)/);
  assert.match(first[0], /«La de 30»/);
  const d = new Date(hours(30));
  assert.ok(first[0].includes(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`), first[0]);
  const today = new Date(NOW);
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(dayFile(t), 'utf8')), { day });
  // same day, another count: quiet
  pending(t, [{ title: 'La de 30', hoursAgo: 30 }]);
  assert.deepStrictEqual(oldLine(C.capNotice({ ...t.opts, now: NOW + 60000 })), []);
  // the next day: again
  const next = oldLine(C.capNotice({ ...t.opts, now: NOW + 24 * 3600000 }));
  assert.strictEqual(next.length, 1);
  assert.match(next[0], /\b1 firma\(s\)/);
});

test('T14b Notice_FreshSignatures_Silent @story-8.122 @ac-14: sólo nuevas no dicen nada ni anotan la fecha; en otra sesión, tampoco una vieja', () => {
  const t = toy();
  pending(t, [{ title: 'Nueva', hoursAgo: 2 }, { title: 'Casi', hoursAgo: 23 }]);
  assert.strictEqual(C.capNotice(t.opts), null);
  assert.ok(!fs.existsSync(dayFile(t)), 'la fecha no se anota');
  pending(t, [{ title: 'Vieja', hoursAgo: 25 }]);
  assert.strictEqual(C.capNotice({ ...t.opts, sessionId: 'otra-sesion' }), null, 'otra sesión no la oye');
  assert.ok(!fs.existsSync(dayFile(t)));
  // a machine without a signatures folder never says it, even with an old entry left in the record
  const sin = toy();
  pending(sin, [{ title: 'Vieja', hoursAgo: 25 }]);
  fs.writeFileSync(path.join(sin.home, '.claude', 'tycon.json'), '{}');
  assert.strictEqual(C.capNotice(sin.opts), null);
});

test('T14c Notice_SignedFileGone_NotCounted @story-8.122 @ac-14: una de 25 h cuyo archivo ya no está no cuenta', () => {
  const t = toy();
  pending(t, [{ title: 'Firmada', hoursAgo: 25, gone: true }]);
  assert.strictEqual(C.capNotice(t.opts), null);
  assert.ok(!fs.existsSync(dayFile(t)));
});

test('T14d Notice_DayNotWritable_SaysSoAndRepeats @story-8.122 @ac-14: sin poder anotar el día, avisa, lo dice y avisa otra vez', POSIX_PERMS, () => {
  const t = toy();
  pending(t, [{ title: 'Vieja', hoursAgo: 25 }]);
  const dir = path.join(t.state, 'coordination');
  fs.chmodSync(dir, 0o500);
  try {
    for (const now of [NOW, NOW + 60000]) {
      const n = C.capNotice({ ...t.opts, now });
      assert.strictEqual(oldLine(n).length, 1, `avisa: ${n}`);
      assert.match(n, /No pude leer.*no pude anotar el día del aviso de firmas/);
    }
  } finally { fs.chmodSync(dir, 0o755); }
});

test('T14e Notice_DayRenameFails_NoTempLeft @story-8.122 @ac-14: si el archivo del día no se puede reemplazar, avisa y no deja temporales', () => {
  const t = toy();
  pending(t, [{ title: 'Vieja', hoursAgo: 25 }]);
  fs.mkdirSync(dayFile(t));
  const n = C.capNotice(t.opts);
  assert.strictEqual(oldLine(n).length, 1, `avisa: ${n}`);
  assert.match(n, /No pude leer.*no pude anotar el día del aviso de firmas/);
  assert.deepStrictEqual(fs.readdirSync(path.join(t.state, 'coordination')).filter((f) => f.endsWith('.tmp')), []);
});

test('T14f Notice_BadEntryOrDayFile_SaysSo @story-8.122 @ac-14: una pendiente sin fecha o sin archivo y el archivo del día roto se dicen', () => {
  const t = toy();
  pending(t, [{ title: 'Vieja', hoursAgo: 25 }]);
  const reg = path.join(t.state, 'coordination', 'signatures.json');
  const entries = JSON.parse(fs.readFileSync(reg, 'utf8'));
  entries.push({ id: 'sin-fecha', file: entries[0].file, title: 'Sin fecha' }, { id: 'sin-archivo', at: hours(30), title: 'Sin archivo' });
  fs.writeFileSync(reg, JSON.stringify(entries));
  fs.writeFileSync(dayFile(t), '{roto');
  const n = C.capNotice(t.opts);
  assert.strictEqual(oldLine(n).length, 1, `avisa por la buena: ${n}`);
  assert.match(oldLine(n)[0], /\b1 firma\(s\)/);
  assert.match(n, /No pude leer.*2 firma\(s\) pendiente\(s\) sin fecha o sin archivo/);
  assert.match(n, /No pude leer.*old-signatures-notice\.json no se puede leer/);
  // exactly one day: not yet old
  const borde = toy();
  pending(borde, [{ title: 'Justo', hoursAgo: 24 }]);
  assert.strictEqual(C.capNotice(borde.opts), null);
});

// ── Sesiones de fondo quietas, el turno de la suite, los pedidos verdes y el freno del segundo pase ───────────────────

const bg = (t, sid, name, minutesAgo, extra = {}) => session(t, sid, name, { kind: 'bg', status: 'idle', statusUpdatedAt: mins(minutesAgo), ...extra });

test('Q1 Notice_QuietBackgroundSession_SaysCloseOrAssign: una de fondo sin trabajar más de 15 min avisa; las demás no', () => {
  const t = toy();
  bg(t, 'bg-1', 'Uma', 20);
  bg(t, 'bg-2', 'Nico', 10);
  session(t, 'int-1', 'Beto', { kind: 'interactive', status: 'idle', statusUpdatedAt: mins(90) });
  bg(t, 'bg-3', 'Trabaja', 40, { status: 'busy' });
  bg(t, 'bg-4', 'Muerta', 40, { pid: deadPid() });
  const n = C.capNotice(t.opts);
  assert.ok(n, 'avisa');
  assert.match(n, /Coordinación: Uma está quieta hace 20 min: cerrala o dale trabajo\./);
  for (const name of ['Nico', 'Beto', 'Trabaja', 'Muerta']) assert.ok(!n.includes(name), `${name} no se nombra: ${n}`);
  // la coordinadora misma, de fondo y quieta, no se avisa a sí misma
  const t2 = toy();
  bg(t2, COORD, 'Coordinadora', 50);
  assert.strictEqual(C.capNotice(t2.opts), null);
});

test('Q2 Notice_QuietButWaiting_NotNamed: su pase en vuelo, una nota reciente o la suite de la máquina no cuentan como quieta', () => {
  const t = toy();
  bg(t, 'bg-pase', 'ConPase', 30);
  inFlight(t, 'bg-pase', '9.5', 25);
  bg(t, 'bg-nota', 'ConNota', 30);
  const doing = path.join(t.state, 'doing');
  fs.mkdirSync(doing, { recursive: true });
  fs.writeFileSync(path.join(doing, 'bg-nota.json'), JSON.stringify({ text: 'miro la cola' }));
  bg(t, 'bg-suite', 'ConSuite', 30);
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'suite-turn.json'), JSON.stringify({ pid: process.pid, sid: 'bg-suite', session: 'ConSuite', what: 'suites portables', at: mins(30) }));
  const s = C.status({ ...t.opts, noTranscripts: true });
  assert.deepStrictEqual(s.quiet, [], JSON.stringify(s.quiet));
  assert.strictEqual(s.suite.session, 'ConSuite');
  assert.match(C.statusText(s), /Suite completa en curso: ConSuite \(suites portables, desde las \d\d:\d\d\)/);
  // una nota vieja ya no la tapa
  const old = new Date(NOW - 4 * 3600000);
  fs.utimesSync(path.join(doing, 'bg-nota.json'), old, old);
  assert.deepStrictEqual(C.status({ ...t.opts, noTranscripts: true }).quiet.map((q) => q.session), ['ConNota']);
});

test('Q3 Notice_GreenRequestNobodyQueued_SaysHowToQueue: un pedido verde sin auto-merge, de la foto, con el comando; sin salir a la red', () => {
  const t = toy();
  const az = (repo) => ({ platform: 'azure', org: 'acme', project: 'Harness', repo });
  fs.writeFileSync(path.join(t.arnes, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: az('harness-team-profile'), operations: az('harness-team-operations'), maintainers: az('harness-maintainers') }));
  const pr = { number: 882, draft: false, autoComplete: false, inQueue: false, lastQueueDrop: null, mergeState: 'clean', author: 'quien', sourceCommit: 'c882', sourceBranch: 'fix/aprobado', createdAt: '2026-10-25T10:00:00Z' };
  fs.writeFileSync(path.join(t.state, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date(mins(1)).toISOString(), repos: ['acme/harness', 'acme/Harness/harness-team-profile', 'acme/Harness/harness-team-operations', 'acme/Harness/harness-maintainers'], lecturas: { 'acme/harness': { ok: true, value: [pr] } } }));
  fs.writeFileSync(path.join(t.state, 'green-prs.json'), JSON.stringify({ 'acme/harness#882': { estado: 'verde-sin-auto', punta: 'c882', vistoDesde: new Date(mins(15)).toISOString() } }));
  const n = C.capNotice(t.opts);
  assert.ok(n, 'avisa');
  assert.match(n, /^Coordinación: pedido 882 \(harness\) listo y sin auto-merge hace 15 min, fuera de la cola/m);
  assert.match(n, /gh pr merge 882 -R acme\/harness --merge/);
  assert.ok(!fs.existsSync(path.join(t.state, 'stuck-prs-refresh.lock')), 'con la foto vigente no lanza la lectura de fondo');
});

test('Q4 AdversarialTurn_Waits_UpToAnHour: frena con un pase en vuelo; pasada una hora, con una fecha ilegible o con la sesión cerrada, no', () => {
  const t = toy();
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  inFlight(t, 'otra-2', '9.2', 12);
  const r = C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' });
  assert.strictEqual(r.waiting_turn, true);
  assert.match(r.turn, /el arnés no deja lanzar este hasta que termine/);
  assert.match(r.turn, /Vecina/);
  inFlight(t, 'otra-2', '9.2', 61);
  const viejo = C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' });
  assert.strictEqual(viejo.waiting_turn, false);
  assert.match(viejo.turn, /hace más de una hora/);
  marker(t, 'otra-2', { storyId: '9.2', adversarial: { launchedAt: 'no es una fecha', runId: 'wf_x' } });
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }).waiting_turn, false);
  // una sesión cerrada no deja archivo: su pase quedó abandonado y no ocupa el lugar
  const c = toy();
  inFlight(c, 'cerrada', '9.7', 5);
  assert.strictEqual(C.adversarialTurn({ ...c.opts, sessionId: 'propia-1' }), null);
  // una de Codex tampoco lo deja, y su pase sí cuenta si tuvo actividad hace poco
  const dbDir = path.join(c.root, 'codex');
  fs.mkdirSync(dbDir);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dbDir, 'state_1.sqlite'));
  db.exec("CREATE TABLE threads (id TEXT, name TEXT, updated_at_ms INTEGER, source TEXT)");
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('cerrada', 'Con Codex', mins(2), 'cli');
  db.close();
  assert.strictEqual(C.adversarialTurn({ ...c.opts, sessionId: 'propia-1', codexHome: dbDir }).waiting_turn, true);
});

test('Q6 Notice_WaitingForPassTurn_WakeHerUp: quien debe su pase no sale como quieta; la coordinadora la despierta cuando se libera', () => {
  const t = toy();
  bg(t, 'bg-debe', 'Rita', 40);
  marker(t, 'bg-debe', { storyId: '9.8', adversarialGate: { run: true, files: ['a.js'] } });
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  inFlight(t, 'otra-2', '9.2', 12);
  const n = C.capNotice(t.opts);
  assert.match(n, /Coordinación: Rita espera su turno de pase adversarial \(lo tiene Vecina\): avisale cuando termine\./);
  assert.ok(!/Rita está quieta/.test(n), n);
  fs.unlinkSync(path.join(t.state, 'active', 'otra-2.json'));
  assert.match(C.capNotice(t.opts), /Coordinación: Rita puede lanzar su pase adversarial, no hay otro en vuelo: avisale\./);
  // el pase de una sesión cerrada no ocupa el lugar: el aviso dice lo mismo que el portón
  inFlight(t, 'cerrada', '9.3', 5);
  assert.match(C.capNotice(t.opts), /Rita puede lanzar su pase adversarial/);
  fs.unlinkSync(path.join(t.state, 'active', 'cerrada.json'));
  // ya lanzado, no debe nada
  marker(t, 'bg-debe', { storyId: '9.8', adversarialGate: { run: true }, adversarial: { launchedAt: new Date(mins(5)).toISOString() } });
  assert.strictEqual(C.capNotice(t.opts), null);
});

test('Q5 DeepReviewGate_SecondPass_ExitsThreeAndSaysWho: el portón de verdad sale 3 y nombra quién tiene el lugar; sin otro pase, 0', { skip: process.platform === 'win32' ? 'enlaces simbólicos' : false }, () => {
  const t = toy();
  // un árbol con el perfil de juguete: quién es la coordinadora sale del perfil del árbol, y con los enlaces conservados
  // el proceso cree vivir ahí
  const tree = path.join(t.root, 'arbol');
  fs.mkdirSync(tree);
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(tree, 'scripts'));
  fs.symlinkSync(path.join(ROOT, 'skills'), path.join(tree, 'skills'));
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  // la designación vale con su renglón de ahora: la del juguete es de la fecha fija de las demás pruebas
  // stable-data: la designación y el pase de este caso los lee un proceso aparte, con su propio reloj: no depende del día ni del huso
  fs.appendFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'relay-designation', status: 'ok', sesion: COORD, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  fs.writeFileSync(path.join(t.state, 'active', 'otra-2.json'), JSON.stringify({ sessionId: 'otra-2', storyId: '9.2', stepsPending: [6], lastTouch: new Date().toISOString(), adversarial: { launchedAt: new Date(Date.now() - 12 * 60000).toISOString(), runId: 'wf_x' } }));
  const repo = path.join(t.root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  // el repo declara que su pase corre siempre: corre sin una bandera que lo fuerce
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'deep_review: always\n');
  const story = path.join(repo, 'specs', 'story-9.9.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'epic: 1', 'status: in-progress', 'approach: "[ADAPT]"', 'files_to_create: []', 'files_to_modify:', '  - scripts/a.js', '---', '', '# Story', '', '## Acceptance Criteria', '', '1. criterio', ''].join('\n'));
  const code = 'scripts/a.js';
  fs.writeFileSync(path.join(repo, code), 'module.exports = 1;\n');
  const gate = () => spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(tree, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'), 'deep-review-gate', '--repo', repo, '--story', story, '--files', code], {
    cwd: repo, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: t.home, USERPROFILE: t.home, CLAUDE_CODE_SESSION_ID: 'propia-1', TYCON_PROFILE: '' },
  });
  const r = gate();
  assert.strictEqual(r.status, 3, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /deep-review-gate: Hay otro pase adversarial en vuelo \(la 9\.2, Vecina/);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.run, true);
  assert.strictEqual(out.waiting_turn, true);
  // `next` tampoco pide lanzarlo, y el salteo se sigue negando con el veredicto legible
  const SK = path.join(tree, 'skills', 'tycon-pipeline', 'scripts');
  const env = { ...process.env, HOME: t.home, USERPROFILE: t.home, CLAUDE_CODE_SESSION_ID: 'propia-1', TYCON_PROFILE: '' };
  fs.writeFileSync(path.join(t.state, 'active', 'propia-1.json'), JSON.stringify({
    storyId: '9.9', storyPath: story, repoPath: repo, sessionId: 'propia-1', startedAt: new Date(Date.now() - 3600000).toISOString(), lastTouch: new Date().toISOString(),
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5, 6, 7, 8], filesTouched: [], iterations: {}, fileEvents: [], clockiStarted: true, adoMarkedActive: true,
    adversarialGate: { run: true, early_launch: true, files: [code], at: new Date().toISOString(), sessionId: 'propia-1' },
  }));
  const node = (script, args) => spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(SK, script), ...args], { cwd: repo, encoding: 'utf8', timeout: 60000, env });
  const next = node('pipeline.js', ['next']);
  assert.strictEqual(JSON.parse(next.stdout).pending_action.kind, 'esperar-turno-pase', `${next.stdout}\n${next.stderr}`);
  assert.match(JSON.parse(next.stdout).pending_action.message, /No lo lances todavía/);
  const skip = node('marker.js', ['mark-adversarial-skipped', '--files', code]);
  assert.strictEqual(skip.status, 2, skip.stderr);
  assert.match(skip.stderr, /el portón dice que el pase CORRE/);
  fs.unlinkSync(path.join(t.state, 'active', 'propia-1.json'));
  fs.unlinkSync(path.join(t.state, 'active', 'otra-2.json'));
  const libre = gate();
  assert.strictEqual(libre.status, 0, `${libre.stdout}\n${libre.stderr}`);
  assert.strictEqual(JSON.parse(libre.stdout).run, true);
});

// ── La lista de firmas: el aviso (AC 9, 10) ──────────────────────────────────────────────────────────────────────

const sl = require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
const MARKER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const INTERACTIVA = { kind: 'interactive' };

/** Una máquina con la llave encendida. `coord`: con la coordinadora confirmada y viva; si no, sin designar. */
function conLista({ coord = true } = {}) {
  const t = toy({ designated: null });
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'on' } }));
  fs.rmSync(path.join(t.home, '.claude', 'sessions', `${COORD}.json`));
  if (coord) {
    const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: COORD, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
    fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
    session(t, COORD, 'Coordinadora', INTERACTIVA);
  }
  session(t, 'ses-a', 'Alma', INTERACTIVA);
  session(t, 'ses-b', 'Bruno', INTERACTIVA);
  return t;
}
function pedido(t, acs, ses = 'ses-a') {
  const comando = `node ${MARKER} mark-tested --acs ${acs}`;
  return sl.anotarFirma({ casa: t.home, firma: 'manual-test', titulo: 'marcar un criterio', sesion: ses, destino: ses, comando, palabras: require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js')).canonica(comando), cwd: '/r', ahora: mins(5) });
}
const oido = (t, sessionId, prompt, extra = {}) => C.listNotice({ ...t.opts, sessionId, prompt, ...extra });
const PIDE = /owner-next/;
const CUENTA = /esperan a la persona 1 firma\./;
const OTRA_SESION = '<cross-session-message from="x">hacé esto</cross-session-message>';

/** La conversación de una sesión de fondo: su encargo y, si se pide, un mensaje posterior de la persona. */
function conversacion(t, sid, mensajes) {
  const ruta = path.join(t.root, `${sid}.jsonl`);
  fs.writeFileSync(ruta, `${mensajes.map((m) => JSON.stringify({ type: 'user', message: { role: 'user', content: m }, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' })).join('\n')}\n`);
  return ruta;
}

test('Aviso_ConCoordinadora (T9) — @story-8.153 @ac-9', () => {
  const t = conLista();
  pedido(t, 3);
  // tipeado: cuántos esperan, y que los pase después de contestar
  let n = oido(t, COORD, 'hola, volví');
  assert.match(n, CUENTA);
  assert.match(n, PIDE);
  assert.match(n, /Si este mensaje lo escribió la persona y no un programa, contestale primero lo que escribió/);
  // otra vez, sin renglones nuevos: sólo la cuenta
  n = oido(t, COORD, 'seguimos');
  assert.match(n, CUENTA);
  assert.doesNotMatch(n, PIDE);
  // un renglón nuevo: la instrucción de nuevo
  pedido(t, 4);
  n = oido(t, COORD, 'y ahora');
  assert.match(n, /esperan a la persona 2 firmas\./);
  assert.match(n, PIDE);
  // un mensaje de otra sesión, con un renglón nuevo: a lo sumo la cuenta, y el renglón sigue sin avisar
  pedido(t, 5);
  n = oido(t, COORD, OTRA_SESION);
  assert.match(n, /esperan a la persona 3 firmas\./);
  assert.doesNotMatch(n, PIDE);
  assert.match(oido(t, COORD, 'ya volví'), PIDE, 'lo avisa cuando escribe la persona');
  // el primer mensaje de una coordinadora de fondo: sólo la cuenta
  const f = conLista();
  session(f, COORD, 'Coordinadora', { kind: 'bg' });
  pedido(f, 3);
  const encargo = 'Coordiná las sesiones';
  n = oido(f, COORD, encargo, { transcript: conversacion(f, COORD, [encargo]) });
  assert.match(n, CUENTA);
  assert.doesNotMatch(n, PIDE);
  // el segundo, de la persona, sí
  assert.match(oido(f, COORD, 'volví', { transcript: conversacion(f, COORD, [encargo, 'volví']) }), PIDE);
  // en otra sesión no sale nada, aunque sea la destino
  assert.strictEqual(oido(t, 'ses-a', 'hola'), null);
  assert.strictEqual(oido(t, 'ses-b', 'hola'), null);
  // sin renglones, nada
  assert.strictEqual(oido(conLista(), COORD, 'hola'), null);
  // el gancho, en la dirección segura: con una sesión cualquiera y la casa de juguete, calla y sale 0
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'ses-b', prompt: 'hola' }), encoding: 'utf8', env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_PROFILE: '0' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('Aviso_LoQueNoPudoLeer_LoDice — @story-8.153 @ac-9 @ac-16', () => {
  // la llave rota: la coordinadora se entera; otra sesión, no
  const rota = conLista();
  pedido(rota, 3);
  fs.writeFileSync(path.join(rota.home, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'si' } }));
  assert.match(oido(rota, COORD, 'hola'), /no pude leer la llave/);
  assert.strictEqual(oido(rota, 'ses-a', 'hola'), null);
  // una fila que no se entiende: la cuenta sigue, y lo dice
  const fila = conLista();
  pedido(fila, 3);
  const archivo = sl.archivo(fila.home);
  fs.writeFileSync(archivo, JSON.stringify([...JSON.parse(fs.readFileSync(archivo, 'utf8')), 'no soy una fila']));
  const n = oido(fila, COORD, 'hola');
  assert.match(n, CUENTA);
  assert.match(n, /Ojo: no entiendo la fila 2/);
});

test('Llave_Apagada_ElAvisoCalla (T16) — @story-8.153 @ac-16', () => {
  for (const coord of [true, false]) {
    for (const contenido of [{ approvals: { signature_list: 'off' } }, {}]) {
      const t = conLista({ coord });
      pedido(t, 3);
      fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify(contenido));
      assert.strictEqual(oido(t, coord ? COORD : 'ses-a', 'hola'), null, JSON.stringify(contenido));
    }
  }
});

test('Aviso_SinCoordinadora (T10) — @story-8.153 @ac-10', () => {
  const t = conLista({ coord: false });
  pedido(t, 3);
  // la sesión destino recibe la instrucción, una vez por renglón
  assert.match(oido(t, 'ses-a', 'volví'), PIDE);
  assert.strictEqual(oido(t, 'ses-a', 'seguimos'), null, 'una sola vez');
  pedido(t, 4);
  assert.match(oido(t, 'ses-a', 'y ahora'), /de esta sesión esperan a la persona 2 firmas/);
  // cualquier otra sesión no ve nada, y sin renglón tampoco
  assert.strictEqual(oido(t, 'ses-b', 'hola'), null);
  // el primer mensaje de una sesión de fondo no cuenta como de la persona: el encargo queda anotado como tipeado
  const f = conLista({ coord: false });
  session(f, 'ses-a', 'Alma', { kind: 'bg' });
  pedido(f, 3);
  const encargo = 'Implementá la historia';
  assert.strictEqual(oido(f, 'ses-a', encargo, { transcript: conversacion(f, 'ses-a', [encargo]) }), null);
  assert.strictEqual(oido(f, 'ses-a', encargo, { transcript: conversacion(f, 'ses-a', []) }), null, 'aunque todavía no esté escrito');
  assert.strictEqual(oido(f, 'ses-a', encargo), null, 'sin poder leer la conversación, tampoco');
  assert.match(oido(f, 'ses-a', 'volví', { transcript: conversacion(f, 'ses-a', [encargo, 'volví']) }), PIDE);
  // un mensaje de otra sesión tampoco
  const g = conLista({ coord: false });
  pedido(g, 3);
  assert.strictEqual(oido(g, 'ses-a', OTRA_SESION), null);
  // con la coordinadora cerrada, vuelve a hablarle a la sesión destino
  const h = conLista();
  pedido(h, 3);
  fs.rmSync(path.join(h.home, '.claude', 'sessions', `${COORD}.json`));
  assert.match(oido(h, 'ses-a', 'volví'), PIDE);
  assert.strictEqual(oido(h, COORD, 'hola'), null);
});
