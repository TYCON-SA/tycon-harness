'use strict';
// coordination-without-profile.test.js — without the team profile a session can be designated coordinator
// and it orders the machine (the cap, the turns, the notices, the waits, /coordinate), but it signs nothing for the
// owner: confirm-designation refuses, and an old confirmation in the log stops counting. Nothing here reads the real
// HOME or the real profile: every case builds its own HOME and harness folder. The keys that sign are read only from the
// profile of the harness tree (TYCON_PROFILE does not change them), so the real commands run from a copy of the harness
// whose profile each case writes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { harnessCopy } = require('./lib/harness-copy.js');

const ROOT = path.join(__dirname, '..', '..');
const SKILL_LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const C = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
const HT = require(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'));
const cw = require(path.join(SKILL_LIB, 'critical-waivers.js'));
const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
const oa = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
const sl = require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
const planReview = require(path.join(SKILL_LIB, 'plan-review.js'));

const NOW = Date.parse('2026-11-04T14:00:00.000Z');
const mins = (n) => NOW - n * 60000;
const COORD = 'coord-sin-perfil';
const GUIDE = path.join(ROOT, 'guides', 'coordination.md');
const FRASE = 'Esta sesión es la coordinadora';

// A toy machine: HOME with its Claude folder and the state in ~/.tycon/state (where the signing side reads it), and a
// harness folder. `profile`: null = no profile file at all; an object = the profile; a string = the file's raw text.
function toy(t, { profile = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-sin-perfil-'));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = path.join(home, '.tycon', 'state');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  const profileFile = path.join(arnes, 'team-profile.json');
  if (profile !== null) fs.writeFileSync(profileFile, typeof profile === 'string' ? profile : JSON.stringify(profile));
  const env = {};
  return { root, home, state, arnes, profile, profileFile, env, opts: { home, arnes, env, now: NOW } };
}
function session(m, sid, name, extra = {}) {
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({
    pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: mins(20), cwd: m.root, ...extra,
  }));
}
const busy = (m, sid, name, ago) => session(m, sid, name, { status: 'busy', statusUpdatedAt: mins(ago) });
// The designation as designate-relay leaves it without a profile: the role is the factory one.
function designate(m, sid = COORD, { rol = 'coordinadora', ts = new Date(NOW).toISOString() } = {}) {
  const line = { ts, name: 'relay-designation', status: 'ok', sesion: sid, rol, quien: 'el dueño', cita: FRASE };
  fs.appendFileSync(path.join(m.state, 'gates.log'), `${JSON.stringify(line)}\n`);
  return line;
}
// The owner's confirmation of that designation, as confirm-designation writes it (made while the profile had the key).
function confirm(m, d) {
  fs.appendFileSync(path.join(m.state, 'gates.log'), `${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
}
// The machine's own config file, where the config reader looks for it in this HOME.
function machineFile(m, data) {
  const f = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).rutaMaquina(m.home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
}
const gates = (m) => { try { return fs.readFileSync(path.join(m.state, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function cleanEnv(m, extra = {}) {
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, ...extra };
  for (const k of ['TYCON_STATE_DIR', 'TYCON_HOME', 'TYCON_PROFILE', 'TYCON_SESSION_ID', 'TYCON_EVAL_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[k];
  if (!extra.CLAUDE_CODE_SESSION_ID) delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}
// The copy of the harness the real commands run from, with this case's profile (or none) in its tree.
function copyFor(m) {
  const copy = harnessCopy();
  const file = path.join(copy, 'team-profile.json');
  if (m.profile === null) fs.rmSync(file, { force: true });
  else fs.copyFileSync(m.profileFile, file);
  return copy;
}
const designateRelay = (m, quote) => {
  const copy = copyFor(m);
  const r = spawnSync(process.execPath, [path.join(copy, 'skills', 'tycon-pipeline', 'scripts', 'marker.js'), 'designate-relay', '--approved-by', 'Dev de Prueba', '--quote', quote], {
    cwd: m.root, encoding: 'utf8', env: cleanEnv(m, { CLAUDE_CODE_SESSION_ID: COORD }),
  });
  return { ...r, copy };
};
const designar = (m, quote) => cw.designar({ approvedBy: 'Dev de Prueba', quote, env: { ...m.env, CLAUDE_CODE_SESSION_ID: COORD }, home: m.home, arnes: m.arnes });
// The delegation with every other key in place: the signature delegated, this machine listed, the designation confirmed.
const lists = (extra = {}) => ({ delegated_signing: ['plan-approval'], delegated_machines: [{ id: 'a1b2c3d4e5f60718', label: 'la de prueba' }], ...extra });
const delega = (m, perfil) => DS.delegaSinVentana({ firma: 'plan-approval', sesion: COORD, destino: 'otra', home: m.home, estado: m.state, env: m.env, arnes: m.arnes, perfil: () => perfil, huella: () => ({ huella: 'a1b2c3d4e5f60718' }) });

// ── Designating without a profile (AC 1-4) ───────────────────────────────────────────────────────────────────────

test('T1 SinPerfil_Designar_DesignaYDiceQueNoFirma @story-8.199 @ac-1: el comando real designa con el rol de fábrica y dice que las firmas van al dueño', (t) => {
  const m = toy(t);
  const r = designateRelay(m, FRASE);
  assert.strictEqual(r.status, 0, r.stderr);
  const [d] = gates(m).filter((g) => g.name === 'relay-designation');
  assert.ok(d, 'quedó el renglón');
  assert.strictEqual(d.sesion, COORD);
  assert.strictEqual(d.rol, 'coordinadora');
  assert.match(r.stderr, /firmas siguen yendo a la ventana de la persona/);
  assert.doesNotMatch(r.stderr, /confirm-designation/, 'no pide confirmar: sin perfil no hay firma que delegar');
  assert.ok(r.stderr.includes(path.join(r.copy, 'guides', 'coordination.md')), `manda a leer la guía: ${r.stderr}`);
});

test('T2 SinPerfil_FraseEnIngles_Designa @story-8.199 @ac-2: «This session is the coordinator» designa; negar o preguntar, no', (t) => {
  const m = toy(t);
  const en = designar(m, 'This session is the coordinator');
  assert.strictEqual(en.ok, true, en.motivo);
  assert.strictEqual(en.entrada.rol, 'coordinadora');
  assert.strictEqual(designar(m, FRASE).ok, true);
  for (const mala of ['This session is not the coordinator', 'Is this session the coordinator?', 'Esta sesión no es la coordinadora', '¿Esta sesión es la coordinadora?', 'Esta sesión es la que manda']) {
    assert.strictEqual(designar(m, mala).ok, false, mala);
  }
});

test('T3 ConPerfil_RolPropio_ComoHoy @story-8.199 @ac-3: con relay_session «jefa» la frase la nombra, y la salida pide confirmar', (t) => {
  const m = toy(t, { profile: { approvals: { relay_session: 'jefa' } } });
  assert.strictEqual(designar(m, FRASE).ok, false, 'con rol propio, «coordinadora» no designa');
  const r = designar(m, 'Esta sesión es la jefa');
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(r.entrada.rol, 'jefa');
  const cmd = designateRelay(m, 'Esta sesión es la jefa');
  assert.strictEqual(cmd.status, 0, cmd.stderr);
  assert.match(cmd.stderr, /confirm-designation/, 'pide la confirmación del dueño, como hoy');
});

test('T4 ConfigRota_Designa_YDiceElMotivo @story-8.199 @ac-4: con el perfil roto designa con el rol de fábrica y dice por qué las firmas van al dueño', (t) => {
  const m = toy(t, { profile: '{ esto no es json' });
  const r = designar(m, FRASE);
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(r.entrada.rol, 'coordinadora');
  const cmd = designateRelay(m, FRASE);
  assert.strictEqual(cmd.status, 0, cmd.stderr);
  assert.match(cmd.stderr, /no se pudo leer/, `dice el motivo: ${cmd.stderr}`);
  assert.match(cmd.stderr, /ventana de la persona/);
  assert.doesNotMatch(cmd.stderr, /confirm-designation/);
});

// ── Ordering without a profile (AC 5-10) ─────────────────────────────────────────────────────────────────────────

test('T5 SinPerfil_Coordinate_EnLaDesignada_DaElEstado @story-8.199 @ac-5: la designada ve el estado y la línea de firmas; otra, cómo designarla', (t) => {
  const m = toy(t);
  session(m, COORD, 'Coordinadora', { status: 'busy' });
  designate(m);
  const r = C.coordinate({ ...m.opts, env: { ...m.env, CLAUDE_CODE_SESSION_ID: COORD } });
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /Trabajando:/);
  assert.match(r.text, /firmas/i);
  assert.match(r.text, /dueño/);
  const otra = C.coordinate({ ...m.opts, env: { ...m.env, CLAUDE_CODE_SESSION_ID: 'otra-1' } });
  assert.strictEqual(otra.code, 1);
  assert.match(otra.text, /Esta sesión es la coordinadora/);
  assert.match(otra.text, /designate-relay/);
  assert.doesNotMatch(otra.text, /no usa una coordinadora/);
});

test('T7 SinPerfil_Avisos_LeLleganALaDesignada @story-8.199 @ac-6: el tope y la guía le hablan a la designada y callan en otra', (t) => {
  const m = toy(t);
  session(m, COORD, 'Coordinadora', { status: 'busy' });
  designate(m);
  for (const [s, n] of [['s-a', 'Uno'], ['s-b', 'Dos'], ['s-c', 'Tres']]) busy(m, s, n, 10);
  const n = C.capNotice({ ...m.opts, sessionId: COORD });
  assert.ok(n, 'con 3 trabajando le avisa');
  assert.match(n, /en el tope/);
  assert.strictEqual(C.capNotice({ ...m.opts, sessionId: 's-a' }), null, 'otra sesión no oye nada');
  const g = C.guideNotice({ ...m.opts, sessionId: COORD, source: 'compact' });
  assert.ok(g && g.includes(GUIDE), `manda a leer la guía: ${g}`);
  assert.match(g, /sos la coordinadora/);
  assert.strictEqual(C.guideNotice({ ...m.opts, sessionId: 's-a', source: 'compact' }), null);
});

test('T9 SinPerfil_LimpiarConversacion_DiceComoRecuperarla @story-8.199 @ac-7: tras limpiar, con el mismo título, dice cómo recuperarla', (t) => {
  const m = toy(t);
  designate(m);
  const dir = path.join(m.home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const saved = (sid, title) => { const f = path.join(dir, `${sid}.jsonl`); fs.writeFileSync(f, `${JSON.stringify({ type: 'agent-name', agentName: title, sessionId: sid })}\n`); return f; };
  saved(COORD, 'Coordinadora');
  const transcript = saved('nueva', 'Coordinadora');
  const n = C.guideNotice({ ...m.opts, sessionId: 'nueva', source: 'clear', title: 'Coordinadora', transcript });
  assert.ok(n, 'dice algo');
  assert.match(n, /era la coordinadora/);
  assert.match(n, /«Esta sesión es la coordinadora»/);
});

test('T10 SinPerfil_Espera_VaALaCoordinadora @story-8.199 @ac-8: la espera de otra sesión va primero a la designada viva', (t) => {
  const m = toy(t);
  session(m, COORD, 'Coordinadora');
  session(m, 'espera-1', 'Espera');
  designate(m);
  const c = C.liveCoordinator(m.opts, 'espera-1');
  assert.ok(c, 'hay coordinadora');
  assert.strictEqual(c.sid, COORD);
  assert.strictEqual(c.role, 'coordinadora');
});

test('T11 SinPerfil_TurnosDeSuiteYPase_SePiden @story-8.199 @ac-9: la suite y el pase piden turno con la designada viva', (t) => {
  const m = toy(t);
  session(m, COORD, 'Coordinadora');
  designate(m);
  // the suite: another live process holds the turn, so this one waits and is told to ask the coordinator
  const first = HT.take({ home: m.home, env: { ...m.env, CLAUDE_CODE_SESSION_ID: 's-a' }, arnes: m.arnes, pid: process.pid, what: 'suites', now: NOW });
  assert.strictEqual(first.taken, true, first.message);
  const second = HT.take({ home: m.home, env: { ...m.env, CLAUDE_CODE_SESSION_ID: 's-b' }, arnes: m.arnes, pid: process.ppid, what: 'suites', now: NOW });
  assert.strictEqual(second.ok, false);
  assert.match(second.message, /pedile turno a la coordinadora/);
  HT.release({ home: m.home, pid: process.pid });
  // the pass: another session has one in flight
  session(m, 's-a', 'Uno', { status: 'busy' });
  fs.writeFileSync(path.join(m.state, 'active', 's-a.json'), JSON.stringify({ sessionId: 's-a', storyId: '9.9', stepsPending: [6], lastTouch: new Date(NOW).toISOString(), adversarial: { launchedAt: new Date(mins(5)).toISOString(), runId: 'wf_x' } }));
  const r = C.adversarialTurn({ ...m.opts, sessionId: 's-b' });
  assert.ok(r, 'hay turno que pedir');
  assert.strictEqual(r.waiting_turn, true);
  assert.match(r.turn, /coordinadora/);
});

test('T12 SinPerfil_Open_ElEncargoTraeLaReglaDeLoPesado @story-8.199 @ac-10: la coordinadora abre una sesión y el encargo trae la regla de lo pesado', (t) => {
  const m = toy(t);
  designate(m);
  const sid = 'caller-1';
  const folder = m.root.replace(/[^A-Za-z0-9-]/g, '-');
  const dir = path.join(m.home, '.claude', 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions', message: { content: 'hola' } })}\n`);
  const script = path.join(m.root, 'launcher.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(path.join(m.root, 'launched.json'))}, JSON.stringify(process.argv.slice(2)));`);
  const r = C.open({ ...m.opts, env: { ...m.env, CLAUDE_CODE_SESSION_ID: sid }, cwd: m.root, name: 'n1', task: 'implementá la 9.9', launcher: { bin: process.execPath, prefix: [script] } });
  assert.strictEqual(r.ok, true, r.message);
  const argv = JSON.parse(fs.readFileSync(path.join(m.root, 'launched.json'), 'utf8'));
  assert.match(argv.at(-1), /Nada pesado sin turno de la coordinadora/);
});

// ── Signing still asks for the profile (AC 11-17) ────────────────────────────────────────────────────────────────

// Loaded before the script: the account home comes from the system, and without a terminal or a real signature the
// script would not go on. `exigir` writes down that it was asked: the refusal comes before any box.
const PRELOAD = `
const fs = require('fs');
const os = require('os');
const homedir = process.env.TEST_HOME;
os.userInfo = () => ({ homedir, username: 'prueba', uid: 1, gid: 1, shell: null });
require(process.env.TEST_WAIVER_LIB).hasTty = () => false;
require(process.env.TEST_WINDOW_LIB).exigir = () => { fs.writeFileSync(process.env.TEST_CALL_FILE, 'pedida'); return { codigo: 0, via: 'click' }; };
`;
function confirmDesignation(m, args = []) {
  const preload = path.join(m.root, 'preload.js');
  const call = path.join(m.root, 'call.txt');
  fs.writeFileSync(preload, PRELOAD);
  const copy = copyFor(m);
  const env = { PATH: process.env.PATH, HOME: m.home, CLAUDE_CODE_SESSION_ID: COORD, TEST_HOME: m.home, TEST_CALL_FILE: call,
    TEST_WAIVER_LIB: path.join(copy, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'runtime-waiver.js'), TEST_WINDOW_LIB: path.join(copy, 'scripts', 'lib', 'owner-window.js') };
  const r = spawnSync(process.execPath, ['-r', preload, path.join(copy, 'scripts', 'lib', 'delegated-signing.js'), 'confirm-designation', ...args], { env, encoding: 'utf8' });
  return { ...r, asked: fs.existsSync(call) };
}

test('T13 SinPerfil_ConfirmarDesignacion_SeNiega @story-8.199 @ac-11: desde la pestaña y con --terminal, se niega sin pedir nada ni anotar', (t) => {
  const m = toy(t);
  designate(m);
  for (const args of [[], ['--terminal']]) {
    const r = confirmDesignation(m, args);
    assert.notStrictEqual(r.status, 0, `${args.join(' ') || 'pestaña'}: ${r.stderr}`);
    assert.strictEqual(r.asked, false, 'no se pidió ningún cuadro');
    assert.match(r.stderr, /dueño/);
    assert.doesNotMatch(r.stderr, /\/dev\/tty/, 'la negativa va antes de pedir la terminal');
    assert.deepStrictEqual(gates(m).filter((g) => g.name === 'relay-designation-confirmed'), []);
  }
  // with the key, the same command does ask for the signature (the guard)
  const con = toy(t, { profile: { approvals: { relay_session: 'coordinadora' } } });
  designate(con);
  const r = confirmDesignation(con);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.asked, true);
});

test('T14 SinPerfil_AprobadoEnLaCoordinadora_NoCuenta @story-8.199 @ac-12: con designación y confirmación en el registro, sin perfil, no hay coordinadora confirmada', (t) => {
  const m = toy(t);
  confirm(m, designate(m));
  assert.strictEqual(oa.coordinadoraConfirmada(m.home, { env: m.env, arnes: m.arnes }), null);
  const con = toy(t, { profile: { approvals: { relay_session: 'coordinadora' } } });
  confirm(con, designate(con));
  assert.strictEqual(oa.coordinadoraConfirmada(con.home, { env: con.env, arnes: con.arnes }), COORD, 'con la clave, como hoy');
  // the key is read only from the profile: a broken value in the machine file does not hide it; a broken profile does
  machineFile(con, { approvals: { signature_list: 'si' } });
  assert.strictEqual(oa.coordinadoraConfirmada(con.home, { env: con.env, arnes: con.arnes }), COORD, 'el archivo de la máquina no la tapa');
  fs.writeFileSync(con.profileFile, '{ roto');
  assert.strictEqual(oa.coordinadoraConfirmada(con.home, { env: con.env, arnes: con.arnes }), null, 'un perfil roto no firma');
});

test('T15 PerfilSinClave_Delegacion_DiceQueNo @story-8.199 @ac-13: las dos listas sin relay_session no delegan, y el motivo la nombra', (t) => {
  const m = toy(t, { profile: { approvals: lists() } });
  confirm(m, designate(m));
  const r = delega(m, lists());
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /approvals\.relay_session/);
  assert.strictEqual(delega(m, lists({ relay_session: 'coordinadora' })).ok, true, 'con la clave en el mismo perfil, delega');
});

test('T16 SinPerfil_PlanDeOtra_LoApruebaElDueno @story-8.199 @ac-14: la coordinadora no prepara la revisión del plan de otra sesión', (t) => {
  // the profile delegates the plan approval and lists this machine, but has no relay_session
  const m = toy(t, { profile: { approvals: lists() } });
  confirm(m, designate(m));
  const delegacion = (o) => DS.delegaSinVentana({ ...o, arnes: m.arnes, env: m.env, huella: () => ({ huella: 'a1b2c3d4e5f60718' }) });
  const r = planReview.preparar({ lanza: COORD, destino: 'otra-1', estado: m.state, home: m.home, delegacion });
  assert.strictEqual(r.codigo, 2, JSON.stringify(r));
  assert.match(r.motivo, /approvals\.relay_session/);
});

// The signature list asks owner-approvals for the confirmed coordinator with the account home only, so it reads the
// profile of the tree this file runs from: point it at the toy's harness folder for the case.
function withToyProfile(m, fn) {
  const orig = oa.coordinadoraConfirmada;
  oa.coordinadoraConfirmada = (casa, o = {}) => orig(casa, { arnes: m.arnes, env: m.env, ...o });
  try { return fn(); } finally { oa.coordinadoraConfirmada = orig; }
}

test('T17 SinPerfil_ListaDeFirmas_VaACadaSesion @story-8.199 @ac-15: la coordinadora no recibe las firmas ajenas ni las saca', (t) => {
  const m = toy(t);
  session(m, COORD, 'Coordinadora');
  session(m, 'ses-a', 'Una');
  confirm(m, designate(m));
  withToyProfile(m, () => {
    assert.strictEqual(sl.coordinadoraViva(m.home), null, 'sin perfil no hay coordinadora que pase firmas');
    const a = sl.anotarPermiso({ casa: m.home, herramienta: 'Bash', pedido: 'echo hola', carpeta: '/r', sesion: 'ses-a', pid: process.pid, ahora: NOW });
    assert.ok(a.ok, a.motivo);
    const [fila] = sl.leer(m.home);
    const r = sl.rechazar({ casa: m.home, sesion: COORD, id: fila.id });
    assert.strictEqual(r.ok, false);
    assert.match(r.mensaje, /es de otra sesión/);
  });
  // the notice and owner-next: the coordinator neither hears about the other session's row nor gets it to pass on
  machineFile(m, { approvals: { signature_list: 'on' } });
  withToyProfile(m, () => {
    assert.strictEqual(C.listNotice({ ...m.opts, sessionId: COORD, prompt: 'hola' }), null, 'el aviso no le llega a la coordinadora');
    const n = sl.siguiente({ casa: m.home, sesion: COORD, arnes: m.arnes, env: m.env, ahora: NOW });
    assert.notStrictEqual(n.tipo, 'permiso', `owner-next no le da la fila ajena: ${n.texto}`);
  });
  // the twin with the key: the coordinator is alive, hears about it, gets it in owner-next and does take it out
  const con = toy(t, { profile: { approvals: { relay_session: 'coordinadora' } } });
  session(con, COORD, 'Coordinadora');
  session(con, 'ses-a', 'Una');
  confirm(con, designate(con));
  machineFile(con, { approvals: { signature_list: 'on' } });
  withToyProfile(con, () => {
    assert.strictEqual(sl.coordinadoraViva(con.home), COORD);
    sl.anotarPermiso({ casa: con.home, herramienta: 'Bash', pedido: 'echo hola', carpeta: '/r', sesion: 'ses-a', pid: process.pid, ahora: NOW });
    assert.match(C.listNotice({ ...con.opts, sessionId: COORD, prompt: 'hola' }) || '', /Coordinación: esperan a la persona 1 permiso/);
    assert.strictEqual(sl.siguiente({ casa: con.home, sesion: COORD, arnes: con.arnes, env: con.env, ahora: NOW }).tipo, 'permiso');
    const [fila] = sl.leer(con.home);
    assert.strictEqual(sl.rechazar({ casa: con.home, sesion: COORD, id: fila.id }).ok, true);
  });
});

test('T18 PerfilSinClaveDespuesDeConfirmar_NoFirma @story-8.199 @ac-16: confirmada con la clave, el perfil la saca y ya no vale', (t) => {
  const m = toy(t, { profile: { approvals: lists({ relay_session: 'coordinadora' }) } });
  confirm(m, designate(m));
  assert.strictEqual(oa.coordinadoraConfirmada(m.home, { env: m.env, arnes: m.arnes }), COORD);
  fs.writeFileSync(m.profileFile, JSON.stringify({ approvals: lists() }));
  assert.strictEqual(oa.coordinadoraConfirmada(m.home, { env: m.env, arnes: m.arnes }), null);
  assert.strictEqual(delega(m, lists()).ok, false);
});

test('T22 ConfigAjena_OrdenarYFirmarLeenLoMismo @story-8.199 @ac-4 @ac-12: un error ajeno a la clave no separa el rol de ordenar del de firmar', (t) => {
  // a broken value in the machine file, and an unknown key in the profile next to relay_session
  for (const [label, profile, machine] of [
    ['el archivo de la máquina', { approvals: { relay_session: 'jefa' } }, { bogus_key: 1 }],
    ['otra clave del perfil', { approvals: { relay_session: 'jefa' }, bogus: 1 }, null],
  ]) {
    const m = toy(t, { profile });
    if (machine) machineFile(m, machine);
    const r = cw.rolDeCoordinar({ env: m.env, home: m.home, arnes: m.arnes });
    assert.deepStrictEqual([r.rol, r.firma], ['jefa', true], `${label}: ${r.aviso}`);
    assert.strictEqual(DS.firmaPorElDueno({ env: m.env, home: m.home, arnes: m.arnes }).ok, true, label);
    const d = designar(m, 'Esta sesión es la jefa');
    assert.strictEqual(d.ok, true, `${label}: ${d.motivo}`);
    assert.strictEqual(d.firma, true, label);
    assert.strictEqual(designar(m, FRASE).ok, false, `${label}: con rol propio, el de fábrica no designa`);
  }
  // a broken profile: both say no, with the reason
  const roto = toy(t, { profile: '{ roto' });
  assert.strictEqual(cw.rolDeCoordinar({ env: roto.env, home: roto.home, arnes: roto.arnes }).firma, false);
  assert.strictEqual(DS.firmaPorElDueno({ env: roto.env, home: roto.home, arnes: roto.arnes }).ok, false);
});

// ── The guides (AC 18) and Windows (AC 19) ───────────────────────────────────────────────────────────────────────

test('T20 Guias_SinPerfil_OrdenaYNoFirma @story-8.199 @ac-18: las cuatro guías dicen que sin perfil la coordinadora ordena y no firma', () => {
  // the guides wrap their lines: a space in the phrase can be a line break
  const es = /sin\s+perfil[^.]*ordena[^.]*no\s+firma/i;
  const en = /without\s+(?:a|the)\s+(?:team\s+)?profile[^.]*organizes[^.]*(?:does\s+not|doesn't)\s+sign/i;
  for (const [f, re] of [['coordination.md', es], ['coordination.en.md', en], ['working-with-a-coordinator.md', es], ['working-with-a-coordinator.en.md', en]]) {
    const text = fs.readFileSync(path.join(ROOT, 'guides', f), 'utf8');
    assert.match(text, re, `${f}: dice que sin perfil no firma`);
    // none of them still says the profile is a step to turn the coordinator on, or that without it there is none
    assert.doesNotMatch(text, /se prende en dos pasos|turned on in two\s+steps/i, `${f}: el perfil ya no es un paso para ordenar`);
    assert.doesNotMatch(text, /no usa una coordinadora|does not use a coordinator|sin (?:esa|la) clave[^.]*no hay coordinadora/i, `${f}: no dice que sin perfil no hay coordinadora`);
  }
});

test('T21 Windows_SuiteNueva_EnLaValidacion @story-8.199 @ac-19: la suite está en suites.json sin excluir Windows, y el escenario de firmas de Windows la corre', () => {
  const suites = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8'));
  const all = Object.values(suites).filter(Array.isArray).flat();
  const entry = all.find((s) => s && s.ruta === 'tests/coordination-without-profile.test.js');
  assert.ok(entry, 'está en suites.json');
  assert.deepStrictEqual(entry.requiere, [], 'portable');
  const { __nota: _nota, ...fields } = entry;
  assert.ok(!JSON.stringify(fields).match(/win32|windows/i), 'no la excluye de Windows');
  const probe = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'waiver-probe.js'), 'utf8');
  assert.match(probe, /coordination-without-profile\.test\.js/, 'el escenario de firmas la corre');
});
