'use strict';
// coordination-fill-gate.test.js — the brake that keeps the coordinator from closing her turn with a free slot, free
// memory and a ready story: the Stop hook, `fillCheck`, `keep-free` and the written reason. Nothing here reads the real
// HOME: every case builds its own HOME, team profile, sessions and project reading. The in-process cases hand the role
// through `arnes`; the hook as a child process gets the same profile through TYCON_PROFILE, like session-cap-guard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
const FS = require(path.join(ROOT, 'scripts', 'lib', 'free-slots.js'));
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'coordination-fill-gate.js');
const G = require(HOOK);
const COORDINATION = path.join(ROOT, 'scripts', 'tools', 'coordination.js');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

// stable-data: the in-process cases run with a fixed clock; the hook as a child process reads the real one, so its
// toys are dated relative to the moment they are built (the brake compares against its own clock).
const NOW = Date.parse('2026-11-18T14:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const COORD = 'coord-sid-1';
const REMOTE = 'https://github.com/acme/repo.git';
const POSIX_PERMS = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false };
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A toy machine: HOME, the pipeline state, the team profile (role and cap) and the coordinator's folder with a remote. */
function toy({ cap = 6, designated = COORD, remote = REMOTE, nowMs = NOW } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.mkdirSync(path.join(state, 'pruned'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  const profile = path.join(arnes, 'perfil-equipo.json');
  fs.writeFileSync(profile, JSON.stringify({ approvals: { relay_session: 'coordinadora' }, coordination: { max_working: cap } }));
  if (designated) {
    fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts: iso(nowMs), name: 'relay-designation', status: 'ok', sesion: designated, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  }
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-q');
  if (remote) git(cwd, 'remote', 'add', 'origin', remote);
  const t = { root, home, state, arnes, profile, cwd, nowMs };
  session(t, COORD, 'Coordinadora', { status: 'busy', statusUpdatedAt: nowMs });
  return t;
}
/** A session file as Claude Code writes it, alive (this process's pid) unless `pid` says otherwise. */
function session(t, sid, name, extra = {}) {
  fs.writeFileSync(path.join(claudeDir(t.home), 'sessions', `${sid}.json`), JSON.stringify({
    pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: t.nowMs - 20 * 60000, cwd: t.root, kind: 'bg', ...extra,
  }));
}
const busy = (t, sid, name, minutesAgo = 10) => session(t, sid, name, { status: 'busy', statusUpdatedAt: t.nowMs - minutesAgo * 60000 });
const storyFile = (t, id, status = 'in-progress') => {
  const f = path.join(t.root, `story-${id}.md`);
  fs.writeFileSync(f, `---\nstory: "${id}"\ntitle: "La historia ${id}"\nstatus: ${status}\n---\n`);
  return f;
};
/** A stopped run with its plan signed: the marker in `active/` (or `pruned/`) and the story it points to. */
function stoppedRun(t, sid, id, { where = 'active', status = 'in-progress' } = {}) {
  const storyPath = storyFile(t, id, status);
  fs.writeFileSync(path.join(t.state, where, `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: id, storyPath, repoPath: t.root, stepsPending: ['implement'], stepsCompleted: ['start', 'plan', 'approve-plan'], planApproval: { at: iso(t.nowMs - 60 * 60000) }, lastTouch: iso(t.nowMs - 30 * 60000), startedAt: iso(t.nowMs - 90 * 60000) }));
  return storyPath;
}
const story = (id, extra = {}) => ({ id, archivo: `story-${id}.md`, titulo: `La historia ${id}`, estado: 'ready-for-dev', prioridad: 'P2', trabajo: null, ...extra });
const proyecto = (historias, extra = {}) => ({ nombre: 'acme', traidoAt: null, deTuCopia: false, sinLeer: 0, repos: ['github/acme/repo'], historias, ...extra });
function snapshot(t, proyectos, { ageMin = 5 } = {}) {
  const dir = path.join(t.state, 'office');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-stories.json'), JSON.stringify({ at: iso(t.nowMs - ageMin * 60000), proyectos, sinHistorias: [], commitsPropios: { medido: true, motivo: null } }));
}
function board(t, rows) {
  const f = path.join(t.state, 'coordination', 'tablero.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof rows === 'string' ? rows : JSON.stringify({ pendientes: rows }));
}
const row = (historia, estado, extra = {}) => ({ id: `T-${Math.floor(Math.random() * 1000) + 1}`, titulo: `fila ${historia}`, estado, grupo: 'Hoy', historia, quien: '', ...extra });
function opened(t, name, minutesAgo) {
  const f = path.join(t.state, 'coordination', 'opened.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* vacío */ }
  fs.writeFileSync(f, JSON.stringify([...list, { name, cwd: t.root, at: t.nowMs - minutesAgo * 60000 }]));
}
const mem = (pct) => () => ({ pct, why: pct == null ? 'no se pudo' : null });
const opts = (t, extra = {}) => ({ home: t.home, arnes: t.arnes, env: {}, now: t.nowMs, sessionId: COORD, cwd: t.cwd, readMemory: mem(48), refreshLauncher: () => {}, ...extra });
const keysOf = (r) => (r.work || []).map((w) => w.key).sort();
const countFile = (t, sid = COORD) => path.join(t.state, 'coordination', `fill-gate-${sid}.count`);
const freeSlots = (t) => FS.read(t.state);

/** The hook as Claude Code runs it: the event on stdin, the toy HOME and profile, the memory as an argument. */
function runHook(t, event, { memory = 48, input } = {}) {
  const args = memory == null ? [HOOK] : [HOOK, '--memory-pct', String(memory)];
  const r = spawnSync(process.execPath, args, {
    input: input !== undefined ? input : JSON.stringify(event), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: t.home, USERPROFILE: t.home, TYCON_PROFILE: t.profile },
  });
  let decision = null;
  try { decision = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { decision = { unparsed: r.stdout }; }
  return { code: r.status, out: r.stdout, err: r.stderr, decision };
}
const stopEvent = (t, sid = COORD, extra = {}) => ({ hook_event_name: 'Stop', session_id: sid, cwd: t.cwd, stop_hook_active: false, ...extra });
/** The hook in process, with the toy's clock and memory. */
const runIn = (t, extra = {}) => G.run({ event: stopEvent(t), home: t.home, arnes: t.arnes, env: {}, now: t.nowMs, readMemory: mem(48), refreshLauncher: () => {}, ...extra });

// ── Cuándo frena (AC 1-4) ───────────────────────────────────────────────────────────────────────────────────────────

test('T1 FillGate_LugarMemoriaYTrabajo_Frena @story-8.307 @ac-1: el gancho real frena con lugar, memoria y dos historias listas, sin nombrar la detenida', () => {
  const t = toy({ nowMs: Date.now() });
  busy(t, 's-a', 'Uno');
  busy(t, 's-b', 'Dos');
  stoppedRun(t, 'dead-1', '8.290');
  session(t, 'dead-1', 'Muerta', { pid: deadPid() });
  snapshot(t, [proyecto([story('8.232', { prioridad: 'P2', titulo: 'La segunda' }), story('8.294', { prioridad: 'P1', titulo: 'La primera' })])]);
  const r = runHook(t, stopEvent(t));
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.decision && r.decision.decision === 'block', `frena: ${r.out} ${r.err}`);
  const reason = r.decision.reason;
  assert.match(reason, /2 otras trabajando de un tope de 6/);
  assert.match(reason, /memoria libre 48 %/);
  assert.ok(reason.indexOf('8.294') < reason.indexOf('8.232'), `la P1 antes que la P2: ${reason}`);
  assert.match(reason, /8\.294 «La primera» \(P1\)/);
  assert.match(reason, /8\.232 «La segunda» \(P2\)/);
  assert.match(reason, /nada pesado sin turno/);
  assert.match(reason, /keep-free --reason/);
  assert.doesNotMatch(reason, /8\.290/, 'la detenida no se nombra');
  assert.doesNotMatch(reason, /respawn|open --/);
  assert.match(reason, /Bloqueo 1\/3/);
});

test('T2 FillGate_CuentaComoOpen_NoFrenaEnElTopeReal @story-8.307 @ac-2: con 4 otras hay lugar; con 5 no, y no mide la memoria', () => {
  const t = toy();
  snapshot(t, [proyecto([story('8.232')])]);
  for (let i = 0; i < 4; i += 1) busy(t, `s-${i}`, `S${i}`);
  let calls = 0;
  const counting = () => { calls += 1; return { pct: 48, why: null }; };
  const four = C.fillCheck(opts(t, { readMemory: counting }));
  assert.strictEqual(four.block, true, JSON.stringify(four));
  assert.strictEqual(four.working, 4);
  assert.strictEqual(four.cap, 6);
  assert.strictEqual(calls, 1);
  busy(t, 's-4', 'S4');
  const five = C.fillCheck(opts(t, { readMemory: counting }));
  assert.strictEqual(five.block, false);
  assert.strictEqual(five.why, 'sin-lugar');
  assert.strictEqual(calls, 1, 'sin lugar no se mide la memoria');
});

test('T3 FillGate_MemoriaBajaOSinMedir_NoFrena @story-8.307 @ac-3: 39 % y sin medir no frenan; 40 % frena; sin trabajo no mide', () => {
  const t = toy();
  snapshot(t, [proyecto([story('8.232')])]);
  busy(t, 's-a', 'Uno');
  assert.strictEqual(C.fillCheck(opts(t, { readMemory: mem(39) })).why, 'memoria');
  assert.strictEqual(C.fillCheck(opts(t, { readMemory: mem(null) })).why, 'memoria');
  const ok = C.fillCheck(opts(t, { readMemory: mem(40) }));
  assert.strictEqual(ok.block, true);
  assert.strictEqual(ok.memoryPct, 40);
  // a heavy run noted in the turn: `status` would measure the second turn with the reader it gets; the brake does not
  let calls = 0;
  const t2 = toy();
  busy(t2, 's-a', 'Uno');
  const r = C.fillCheck(opts(t2, { readMemory: () => { calls += 1; return { pct: 48, why: null }; } }));
  assert.strictEqual(r.why, 'sin-trabajo');
  assert.strictEqual(calls, 0, 'sin trabajo listo no se mide la memoria');
});

test('T4 FillGate_OtraSesion_NoHaceNada @story-8.307 @ac-4: otra sesión, ninguna designada o sin session_id: 0, salida vacía, sin archivos', () => {
  const t = toy({ nowMs: Date.now() });
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('8.232')])]);
  const before = () => JSON.stringify(fs.readdirSync(t.state).sort()) + JSON.stringify((fs.existsSync(path.join(t.state, 'coordination')) ? fs.readdirSync(path.join(t.state, 'coordination')) : []).sort());
  const snap = before();
  const other = runHook(t, stopEvent(t, 's-a'));
  assert.strictEqual(other.code, 0, other.err);
  assert.strictEqual(other.out, '');
  const none = runHook(t, { hook_event_name: 'Stop', cwd: t.cwd });
  assert.strictEqual(none.code, 0);
  assert.strictEqual(none.out, '');
  const t2 = toy({ designated: null, nowMs: Date.now() });
  snapshot(t2, [proyecto([story('8.232')])]);
  const undesignated = runHook(t2, stopEvent(t2));
  assert.strictEqual(undesignated.code, 0);
  assert.strictEqual(undesignated.out, '');
  assert.strictEqual(before(), snap, 'no escribió nada en la carpeta de estado');
});

// ── Qué cuenta como trabajo listo (AC 5-9) ──────────────────────────────────────────────────────────────────────────

test('T5 FillGate_DetenidasNoCuentan_StatusIgual @story-8.307 @ac-5 @ac-19: una detenida con plan firmado no es trabajo listo y status queda igual', () => {
  const t = toy();
  busy(t, 's-a', 'Uno');
  stoppedRun(t, 'dead-1', '8.290');
  session(t, 'dead-1', 'Muerta', { pid: deadPid() });
  stoppedRun(t, 'dead-2', '8.294', { where: 'pruned' });
  const r = C.fillCheck(opts(t));
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.why, 'sin-trabajo');
  const k = C.keepFree(opts(t, { reason: 'espero el merge de la 8.288 antes de abrir' }));
  assert.strictEqual(k.code, 1, k.message);
  const s = C.status({ home: t.home, arnes: t.arnes, env: {}, now: t.nowMs });
  assert.ok(!('stoppedProblems' in s), 'status no suma campos');
  assert.strictEqual(s.stopped, null, 'las detenidas se buscan sólo con la fila del portón larga, como hoy');
});

test('T6 FillGate_Historias_SoloLasLibresDelProyecto @story-8.307 @ac-6: cuentan la libre, la de corrida podada y las de filas sin-empezar o hecho; el resto no', () => {
  const t = toy();
  busy(t, 's-a', 'Uno');
  // B has a run on this machine; C has a pruned one (counts: the pruning closed it as abandoned)
  fs.writeFileSync(path.join(t.state, 'active', 'run-b.json'), JSON.stringify({ sessionId: 'run-b', storyId: 'B', storyPath: path.join(t.root, 'story-B.md'), lastTouch: iso(t.nowMs) }));
  fs.writeFileSync(path.join(t.state, 'pruned', 'run-c.json'), JSON.stringify({ sessionId: 'run-c', storyId: 'C', storyPath: path.join(t.root, 'story-C.md'), lastTouch: iso(t.nowMs - 7 * 3600000), prunedAt: iso(t.nowMs) }));
  snapshot(t, [
    proyecto([
      story('A'), story('B'), story('C'),
      story('D', { estado: 'in-progress' }),
      story('E', { pendientes: ['8.297'] }),
      story('F', { pausa: '2027-01-05' }),
      story('I'), story('J'), story('K'),
    ]),
    proyecto([story('G')], { nombre: 'otro', repos: ['github/otro/x'] }),
    proyecto([story('H')], { nombre: 'copia', deTuCopia: true }),
    proyecto([story('L')], { nombre: 'acme · docs' }),
  ]);
  board(t, [row('I', 'curso', { quien: 'Ana' }), row('J', 'sin-empezar'), row('K', 'hecho', { quien: 'Ana' })]);
  const r = C.fillCheck(opts(t));
  assert.strictEqual(r.block, true, JSON.stringify(r));
  assert.deepStrictEqual(keysOf(r), ['story:A', 'story:C', 'story:J', 'story:K', 'story:L']);
  // a story of yesterday's pause counts again
  snapshot(t, [proyecto([story('F', { pausa: '2026-11-17' })])]);
  assert.deepStrictEqual(keysOf(C.fillCheck(opts(t))), ['story:F']);
  // the same number in two places of the remote (found by the adversarial pass): whatever order the reading has, the brake
  // names the most urgent one, so its text does not change between refreshes
  const vieja = proyecto([story('M', { titulo: 'La vieja', prioridad: 'P3' })]);
  const nueva = proyecto([story('M', { titulo: 'La nueva', prioridad: 'P0' }), story('N')], { nombre: 'acme · docs' });
  snapshot(t, [vieja, nueva]);
  const ab = C.fillCheck(opts(t));
  snapshot(t, [nueva, vieja]);
  const ba = C.fillCheck(opts(t));
  assert.strictEqual(ab.reason, ba.reason, 'el texto del freno no depende del orden de la lectura');
  assert.deepStrictEqual(ab.work.map((w) => `${w.id} ${w.titulo}`), ['M La nueva', 'N La historia N']);
});

test('T7 FillGate_RecienAbiertas_Descuentan @story-8.307 @ac-8: una sesión abierta hace 5 min descuenta una historia; a los 11 min ya no', () => {
  const t = toy();
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A')])]);
  opened(t, 'Nueva', 5);
  const one = C.fillCheck(opts(t));
  assert.strictEqual(one.block, false);
  assert.strictEqual(one.why, 'recien-abiertas');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  const two = C.fillCheck(opts(t));
  assert.strictEqual(two.block, true);
  assert.strictEqual(two.recent, 1);
  assert.match(two.reason, /1 ya se abri/);
  const t2 = toy();
  busy(t2, 's-a', 'Uno');
  snapshot(t2, [proyecto([story('A')])]);
  opened(t2, 'Vieja', 11);
  assert.strictEqual(C.fillCheck(opts(t2)).block, true);
});

test('T8 FillGate_LecturaVencida_NoFrenaYRefresca @story-8.307 @ac-9: sin lectura, vieja o sin remoto no frena; la de 40 min cuenta y se refresca; sin lugar no se lanza', () => {
  const launches = [];
  const launcher = () => launches.push(1);
  const t = toy();
  busy(t, 's-a', 'Uno');
  // no reading: no block, refresh launched
  assert.strictEqual(C.fillCheck(opts(t, { refreshLauncher: launcher })).why, 'sin-trabajo');
  assert.strictEqual(launches.length, 1);
  snapshot(t, [proyecto([story('A')])], { ageMin: 120 });
  assert.strictEqual(C.fillCheck(opts(t, { refreshLauncher: launcher })).why, 'sin-trabajo');
  assert.strictEqual(launches.length, 2);
  snapshot(t, [proyecto([story('A')])], { ageMin: 40 });
  const forty = C.fillCheck(opts(t, { refreshLauncher: launcher }));
  assert.strictEqual(forty.block, true, JSON.stringify(forty));
  assert.strictEqual(launches.length, 3, 'de 30 a 60 minutos cuenta y además se refresca');
  snapshot(t, [proyecto([story('A')])], { ageMin: 5 });
  assert.strictEqual(C.fillCheck(opts(t, { refreshLauncher: launcher })).block, true);
  assert.strictEqual(launches.length, 3, 'una lectura fresca no se refresca');
  // without `repos`, the stories don't count
  snapshot(t, [{ nombre: 'acme', traidoAt: null, deTuCopia: false, sinLeer: 0, historias: [story('A')] }]);
  assert.strictEqual(C.fillCheck(opts(t)).why, 'sin-trabajo');
  // a board that exists and cannot be read: no stories
  snapshot(t, [proyecto([story('A')])]);
  board(t, '{ roto');
  const broken = C.fillCheck(opts(t));
  assert.strictEqual(broken.block, false);
  assert.ok(broken.problems.some((p) => /tablero/.test(p)), JSON.stringify(broken.problems));
  fs.unlinkSync(path.join(t.state, 'coordination', 'tablero.json'));
  assert.strictEqual(C.fillCheck(opts(t)).block, true, 'sin tablero es un tablero vacío');
  // the coordinator's folder without a remote
  const t2 = toy({ remote: null });
  busy(t2, 's-a', 'Uno');
  snapshot(t2, [proyecto([story('A')])]);
  assert.strictEqual(C.fillCheck(opts(t2)).why, 'sin-trabajo');
  // no room: the launcher does not run
  const t3 = toy();
  for (let i = 0; i < 5; i += 1) busy(t3, `s-${i}`, `S${i}`);
  const l3 = [];
  assert.strictEqual(C.fillCheck(opts(t3, { refreshLauncher: () => l3.push(1) })).why, 'sin-lugar');
  assert.strictEqual(l3.length, 0);
  // a run that cannot be read: in doubt no story counts, and the brake says what it could not read
  const t4 = toy();
  busy(t4, 's-a', 'Uno');
  snapshot(t4, [proyecto([story('A')])]);
  fs.mkdirSync(path.join(t4.state, 'timing-history'), { recursive: true });
  fs.writeFileSync(path.join(t4.state, 'timing-history', 'x.json'), '{ roto');
  const doubt = C.fillCheck(opts(t4));
  assert.strictEqual(doubt.block, false);
  assert.ok(doubt.problems.some((p) => /x\.json/.test(p)), JSON.stringify(doubt.problems));
  const trace = runIn(t4).stderr;
  assert.match(trace, /x\.json/);
  assert.strictEqual(trace.trim().split('\n').length, 1, 'el rastro va en una sola línea');
  // without a reading the hook does not block, and leaves a trace of what it could not read
  const t5 = toy();
  busy(t5, 's-a', 'Uno');
  const quiet = runIn(t5);
  assert.strictEqual(quiet.stdout, '');
  assert.match(quiet.stderr, /lectura de proyectos/);
});

// ── El motivo (AC 10-12) ────────────────────────────────────────────────────────────────────────────────────────────

test('T9 KeepFree_AnotaYSeRespeta @story-8.307 @ac-10 @ac-11: el motivo se anota con todos sus campos, vale 30 minutos, lo vence una clave nueva y se renueva', () => {
  const t = toy();
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  const k = C.keepFree(opts(t, { reason: 'espero el merge de la 8.288 antes de abrir otra' }));
  assert.strictEqual(k.code, 0, k.message);
  assert.match(k.message, /vale hasta las \d\d:\d\d/);
  const { record } = freeSlots(t);
  assert.strictEqual(record.kind, 'reason');
  assert.strictEqual(record.sid, COORD);
  assert.strictEqual(record.session, 'Coordinadora');
  assert.strictEqual(record.reason, 'espero el merge de la 8.288 antes de abrir otra');
  assert.strictEqual(record.working, 1);
  assert.strictEqual(record.cap, 6);
  assert.strictEqual(record.memoryPct, 48);
  assert.deepStrictEqual([...record.work].sort(), ['story:A', 'story:B']);
  assert.strictEqual(Date.parse(record.expiresAt) - Date.parse(record.at), 30 * 60000);
  const log = fs.readFileSync(FS.files(t.state).log, 'utf8').trim().split('\n');
  assert.strictEqual(log.length, 1);
  // covered now, at 29 minutes, and with fewer keys; not at 31 nor with a new key
  assert.strictEqual(runIn(t).code, 0);
  assert.strictEqual(runIn(t).stdout, '');
  assert.strictEqual(runIn(t, { now: t.nowMs + 29 * 60000 }).stdout, '');
  snapshot(t, [proyecto([story('A')])]);
  assert.strictEqual(runIn(t).stdout, '', 'menos trabajo que antes no lo vence');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  assert.match(runIn(t, { now: t.nowMs + 31 * 60000 }).stdout, /"decision":"block"/);
  snapshot(t, [proyecto([story('A'), story('B'), story('C')])]);
  assert.match(runIn(t).stdout, /"decision":"block"/, 'una clave nueva lo vence');
  // another keep-free with the motive still current renews it: the new one replaces, the log keeps both
  const k2 = C.keepFree(opts(t, { reason: 'ahora espero también la firma del dueño' }));
  assert.strictEqual(k2.code, 0, k2.message);
  assert.strictEqual(freeSlots(t).record.reason, 'ahora espero también la firma del dueño');
  assert.deepStrictEqual([...freeSlots(t).record.work].sort(), ['story:A', 'story:B', 'story:C']);
  assert.strictEqual(fs.readFileSync(FS.files(t.state).log, 'utf8').trim().split('\n').length, 2);
});

test('T10 KeepFree_RechazaLoQueNoCorresponde @story-8.307 @ac-12: otra sesión, motivo corto, sin motivo, sin lugar o sin trabajo: no escribe nada', () => {
  const t = toy();
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A')])]);
  const nothing = () => assert.strictEqual(fs.existsSync(FS.files(t.state).current), false, 'no escribió el motivo');
  assert.strictEqual(C.keepFree(opts(t, { sessionId: 's-a', reason: 'un motivo bastante largo para contar' })).code, 1);
  nothing();
  assert.strictEqual(FS.reasonLength('catorce letras.'), 14);
  assert.strictEqual(C.keepFree(opts(t, { reason: 'catorce letras.' })).code, 2);
  nothing();
  assert.strictEqual(C.keepFree(opts(t, { reason: undefined })).code, 2);
  nothing();
  // `<` and `>` are stripped from the saved reason, so they do not count as letters (found by the adversarial pass)
  assert.strictEqual(FS.reasonLength('<<<<<<<<<<<<<<<<'), 0);
  assert.strictEqual(C.keepFree(opts(t, { reason: '<<<<<<<<<<<<<<<<' })).code, 2, 'un motivo de solo < y > queda vacío: se rechaza');
  nothing();
  const full = toy();
  for (let i = 0; i < 5; i += 1) busy(full, `s-${i}`, `S${i}`);
  snapshot(full, [proyecto([story('A')])]);
  const noRoom = C.keepFree(opts(full, { reason: 'un motivo bastante largo para contar' }));
  assert.strictEqual(noRoom.code, 1);
  assert.match(noRoom.message, /lugar/);
  assert.strictEqual(fs.existsSync(FS.files(full.state).current), false);
  const empty = toy();
  busy(empty, 's-a', 'Uno');
  const noWork = C.keepFree(opts(empty, { reason: 'un motivo bastante largo para contar' }));
  assert.strictEqual(noWork.code, 1);
  assert.match(noWork.message, /trabajo/);
  assert.strictEqual(fs.existsSync(FS.files(empty.state).current), false);
  // fifteen letters without spaces is the floor: accepted
  assert.strictEqual(FS.reasonLength('quince letras ok.'), 15);
  assert.strictEqual(C.keepFree(opts(t, { reason: 'quince letras ok.' })).code, 0, 'quince letras es el piso');
  // a valid motive with angle brackets is stored without them
  const ok = C.keepFree(opts(t, { reason: 'espero <b>la firma</b> del dueño para la 8.288' }));
  assert.strictEqual(ok.code, 0, ok.message);
  assert.strictEqual(freeSlots(t).record.reason, 'espero bla firma/b del dueño para la 8.288');
  // the command line: without --reason it exits 2 and touches nothing
  const cli = spawnSync(process.execPath, [COORDINATION, 'keep-free'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: empty.home, USERPROFILE: empty.home, TYCON_PROFILE: empty.profile, CLAUDE_CODE_SESSION_ID: COORD } });
  assert.strictEqual(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /--reason/);
  assert.strictEqual(fs.existsSync(FS.files(empty.state).current), false);
});

// ── El tope del freno (AC 14-16) ────────────────────────────────────────────────────────────────────────────────────

test('T11 FillGate_TopeDeBloqueos_DejaCerrarYLoAnota @story-8.307 @ac-14 @ac-15: tres bloqueos seguidos; el cuarto deja cerrar y lo anota; el cierre limpio borra el contador', () => {
  const t = toy({ nowMs: Date.now() });
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  for (let i = 1; i <= 3; i += 1) {
    const r = runHook(t, stopEvent(t));
    assert.ok(r.decision && r.decision.decision === 'block', `bloqueo ${i}: ${r.out} ${r.err}`);
    assert.match(r.decision.reason, new RegExp(`Bloqueo ${i}/3`));
    assert.strictEqual(fs.readFileSync(countFile(t), 'utf8').trim(), String(i));
  }
  const fourth = runHook(t, stopEvent(t));
  assert.strictEqual(fourth.code, 0, fourth.err);
  assert.strictEqual(fourth.out, '', 'el cuarto deja cerrar');
  assert.match(fourth.err, /sin abrir ni motivo/);
  const { record } = freeSlots(t);
  assert.strictEqual(record.kind, 'closed-without-reason');
  assert.strictEqual(record.reason, 'cerró sin abrir ni motivo');
  assert.deepStrictEqual([...record.work].sort(), ['story:A', 'story:B']);
  assert.strictEqual(Date.parse(record.expiresAt) - Date.parse(record.at), 30 * 60000);
  assert.strictEqual(fs.existsSync(countFile(t)), false, 'el contador vuelve a 0');
  const fifth = runHook(t, stopEvent(t));
  assert.strictEqual(fifth.out, '', 'el registro del cierre lo cubre');
  // a new key brings the brake back; stop_hook_active does not skip it
  snapshot(t, [proyecto([story('A'), story('B'), story('C')])]);
  assert.ok(runHook(t, stopEvent(t)).decision.decision === 'block');
  const active = runHook(t, stopEvent(t, COORD, { stop_hook_active: true }));
  assert.ok(active.decision && active.decision.decision === 'block', 'stop_hook_active frena igual');
  assert.strictEqual(fs.readFileSync(countFile(t), 'utf8').trim(), '2');
  // a clean close (no work) deletes the counter
  snapshot(t, [proyecto([])]);
  const clean = runHook(t, stopEvent(t));
  assert.strictEqual(clean.out, '');
  assert.strictEqual(fs.existsSync(countFile(t)), false);
  // after the clean close the count starts again from 0: three more blocks, 1/3 to 3/3
  snapshot(t, [proyecto([story('A'), story('B'), story('C')])]);
  for (let i = 1; i <= 3; i += 1) {
    const r = runHook(t, stopEvent(t));
    assert.ok(r.decision && r.decision.decision === 'block', `bloqueo ${i} tras el cierre limpio: ${r.out} ${r.err}`);
    assert.match(r.decision.reason, new RegExp(`Bloqueo ${i}/3`));
  }
});

test('T14 FillGate_ErrorPropio_NoFrena @story-8.307 @ac-16: un marcador roto, un evento ilegible o la carpeta sin permiso: sale 0 sin frenar y lo dice', (ctx) => {
  const t = toy({ nowMs: Date.now() });
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A')])]);
  fs.writeFileSync(path.join(t.state, 'active', 'roto.json'), '{ roto');
  const broken = runHook(t, stopEvent(t));
  assert.strictEqual(broken.code, 0);
  assert.strictEqual(broken.out, '');
  assert.match(broken.err, /roto\.json|no pude leer|estado/i);
  fs.unlinkSync(path.join(t.state, 'active', 'roto.json'));
  const garbage = runHook(t, stopEvent(t), { input: '{ no es json' });
  assert.strictEqual(garbage.code, 0);
  assert.strictEqual(garbage.out, '');
  assert.ok(garbage.err.length > 0, 'dice que no pudo leer el evento');
  if (POSIX_PERMS.skip) { ctx.diagnostic(`salteado: ${POSIX_PERMS.skip}`); return; }
  // before the cap, with the coordination folder read-only: the count cannot be written, so it does not block and says so
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.chmodSync(path.join(t.state, 'coordination'), 0o555);
  try {
    const r0 = runHook(t, stopEvent(t));
    assert.strictEqual(r0.code, 0);
    assert.strictEqual(r0.out, '', 'sin poder anotar el bloqueo no frena');
    assert.match(r0.err, /no pude anotar el bloqueo/);
    assert.strictEqual(fs.existsSync(countFile(t)), false);
  } finally { fs.chmodSync(path.join(t.state, 'coordination'), 0o755); }
  // at the cap, with the coordination folder read-only: the record cannot be written; it lets the turn close and says so
  fs.writeFileSync(countFile(t), '3');
  fs.chmodSync(path.join(t.state, 'coordination'), 0o555);
  try {
    const r = runHook(t, stopEvent(t));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out, '');
    assert.match(r.err, /no pude anotar|EACCES|permiso/i);
  } finally { fs.chmodSync(path.join(t.state, 'coordination'), 0o755); }
});

test('T15 FillGate_MismaFoto_DecideIgualQueStatus @story-8.307 @ac-1 @ac-2 @ac-6: status --json, keep-free y el gancho coinciden en la cuenta y en la lista', () => {
  const t = toy({ nowMs: Date.now() });
  busy(t, 's-a', 'Uno');
  busy(t, 's-b', 'Dos');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  const env = { PATH: process.env.PATH, HOME: t.home, USERPROFILE: t.home, TYCON_PROFILE: t.profile, CLAUDE_CODE_SESSION_ID: COORD };
  const cli = spawnSync(process.execPath, [COORDINATION, 'status', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const s = JSON.parse(cli.stdout);
  const f = C.fillCheck(opts(t));
  assert.strictEqual(f.working, s.working.filter((w) => w.sid !== COORD).length);
  assert.strictEqual(f.cap, s.cap.value);
  const hook = runHook(t, stopEvent(t));
  assert.ok(hook.decision && hook.decision.decision === 'block', hook.err);
  assert.match(hook.decision.reason, new RegExp(`${f.working} otras trabajando de un tope de ${f.cap}`));
  const named = [...hook.decision.reason.matchAll(/historia lista: (\S+) «/g)].map((m) => `story:${m[1]}`).sort();
  assert.deepStrictEqual(named, keysOf(f), 'el gancho nombra las mismas historias que fillCheck');
  const k = C.keepFree(opts(t, { reason: 'espero el merge de la 8.288 antes de abrir otra' }));
  assert.strictEqual(k.code, 0, 'keep-free acepta exactamente cuando el gancho frena');
  assert.deepStrictEqual([...k.record.work].sort(), named);
  // without work: the hook stays quiet and keep-free refuses
  const t2 = toy();
  busy(t2, 's-a', 'Uno');
  assert.strictEqual(runIn(t2).stdout, '');
  assert.strictEqual(C.keepFree(opts(t2, { reason: 'espero el merge de la 8.288 antes de abrir otra' })).code, 1);
});

test('T16 FillGate_MotivoIlegible_NoCalla @story-8.159: un motivo de lugares libres roto no cubre el trabajo: el gancho frena y la cuenta lo dice', () => {
  // 🔴 mutación: tomar el motivo que no se pudo leer como vigente (el cierre pasa callado con lugar, memoria y trabajo)
  const t = toy();
  busy(t, 's-a', 'Uno');
  snapshot(t, [proyecto([story('A'), story('B')])]);
  const f = FS.files(t.state).current;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ roto');
  const r = C.fillCheck(opts(t));
  assert.strictEqual(r.block, true, JSON.stringify(r));
  assert.ok(r.problems.some((p) => /motivo de los lugares libres/.test(p)), JSON.stringify(r.problems));
  assert.match(runIn(t).stdout, /"decision":"block"/);
});

// ── Instalación (AC 17) ─────────────────────────────────────────────────────────────────────────────────────────────

test('T17 FillGate_Registrado @story-8.307 @ac-17: el gancho está en cada lista del instalador, en Codex como asimetría, en la guía de instalación, en el sitio, en las suites y en el banco', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  const hooks = JSON.parse(read('scripts', 'setup', 'hooks-list.json')).hooks;
  const h = hooks.find((x) => x.spec === '@tcg:coordination-fill-gate.js');
  assert.ok(h, 'hooks-list.json');
  assert.deepStrictEqual([h.event, h.effect, h.when, h.platforms.windows, h.steps], ['Stop', 'blocks', 'always', true, ['all']]);
  const effects = JSON.parse(read('scripts', 'setup', 'install-effects.json')).effects;
  const e = effects.find((x) => x.id === 'Stop:@tcg:coordination-fill-gate.js');
  assert.ok(e, 'install-effects.json');
  assert.deepStrictEqual([e.switch, e.blocks, e.profiles, e.windows], [null, 'any-repo', ['full'], true]);
  assert.ok(e.en && e.en.title && e.en.does);
  const pieces = JSON.parse(read('scripts', 'tests', 'fixtures', 'harness-managed-pieces.json'));
  assert.ok(JSON.stringify(pieces).includes('"Stop:@tcg:coordination-fill-gate.js"'), 'harness-managed-pieces.json');
  const codex = JSON.parse(read('adapters', 'codex', 'hooks.json'));
  assert.ok(codex.divergences.some((d) => (d.scripts || []).includes('coordination-fill-gate.js') && /ASIMETR/i.test(d.verdict)), 'la asimetría de Codex');
  assert.ok(JSON.stringify(codex.hooks).includes('coordination-fill-gate.js') === false, 'Codex no lo registra');
  assert.match(read('INSTALL.md'), /\| `coordination-fill-gate\.js` \| Stop \|/);
  assert.match(read('scripts', 'site', 'texts.js'), /'control\.@tcg:coordination-fill-gate\.js': \{ es: '[^']+', en: '[^']+' \}/);
  const suites = JSON.parse(read('scripts', 'tests', 'suites.json'));
  assert.ok(suites.diarias.some((s) => s.ruta === 'tests/coordination-fill-gate.test.js'), 'suites.json');
  assert.match(read('scripts', 'tests', 'harness-profile.test.sh'), /scripts\/hooks\/coordination-fill-gate\.js/);
  const bench = JSON.parse(read('scripts', 'controls-bench', 'cases', 'hooks', '92-coordination-fill-gate.json'));
  assert.deepStrictEqual(bench.hooks[0].tools, ['claude']);
  assert.ok(bench.hooks[0].asymmetry);
  assert.ok(bench.hooks[0].cases.some((c) => c.type === 'must-block') && bench.hooks[0].cases.some((c) => c.type === 'must-not-block'));
  const baseline = JSON.parse(read('scripts', 'controls-bench', 'baseline', 'claude.json'));
  for (const c of bench.hooks[0].cases) assert.ok(`coordination-fill-gate.js::${c.id}` in baseline.cases, `baseline: ${c.id}`);
  // the bench itself: the real case blocks and a working session's close stays quiet
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fill-gate-bench-')), 'bench.json');
  const benchRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'controls-bench', 'runner.js'), '--tool', 'claude', '--only', 'coordination-fill-gate.js', '--json', report], { encoding: 'utf8', env: process.env });
  assert.strictEqual(benchRun.status, 0, `${benchRun.stdout}\n${benchRun.stderr}`);
  const measured = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.strictEqual(measured.ran, 2, benchRun.stdout);
  assert.strictEqual(Object.keys(measured.failed || {}).length, 0, benchRun.stdout);
});
