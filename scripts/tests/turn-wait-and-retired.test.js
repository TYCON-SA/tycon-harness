'use strict';
// turn-wait-and-retired.test.js — la espera de un turno anotada con `marker.js doing --waiting-for` (no pasa al dueño a
// los 30 minutos y gana sobre la razón del freno del cierre), y las sesiones de fondo que Claude Code cerró por falta de
// memoria (se leen de su registro de fondo y se dicen en `status`, `owner-wait`, `capNotice` y la oficina).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WN = require(path.join(ROOT, 'scripts', 'hooks', 'wait-notice.js'));
const C = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
const W = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
const O = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
const R = require(path.join(ROOT, 'scripts', 'lib', 'claude-retired.js'));
const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));

// La coordinadora confirmada pide approvals.relay_session en el perfil del árbol del arnés, y el clon de trabajo no lo
// trae: estos casos la leen de una carpeta con ese perfil.
const CON_CLAVE = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-wait-clave-'));
fs.writeFileSync(path.join(CON_CLAVE, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
const confirmadaSinClave = OA.coordinadoraConfirmada;
OA.coordinadoraConfirmada = (casa, o = {}) => confirmadaSinClave(casa, { arnes: CON_CLAVE, ...o });
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const NOW = Date.parse('2026-11-04T14:00:00.000Z');
const mins = (n) => NOW - n * 60000;
const iso = (ms) => new Date(ms).toISOString();
const COORD = 'coord-sid-1';
const SID_NORTE = 'aaaabbbb-sesion-norte';

function toy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-retired-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  const d = { name: 'relay-designation', status: 'ok', ts: iso(NOW), sesion: COORD, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, iso(NOW)))}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${COORD}.json`), JSON.stringify({ pid: process.pid, sessionId: COORD, name: 'Coordinadora', nameSource: 'user', status: 'busy', statusUpdatedAt: NOW, cwd: root }));
  // owner-wait también mira «Tu firma» de la oficina: acá, una lectura vacía, sin lanzar la oficina real
  return { root, home, state, arnes, opts: { home, arnes, env: {}, now: NOW, sessionId: COORD, ownerWaits: () => ({ esperas: [], problemas: [] }) } };
}
/** La nota de `marker.js doing` de una sesión. */
const note = (t, sid, body) => { fs.mkdirSync(path.join(t.state, 'doing'), { recursive: true }); fs.writeFileSync(path.join(t.state, 'doing', `${sid}.json`), JSON.stringify(body)); };
/** El registro de fondo de Claude Code y el archivo de la sesión que retiró. */
function daemon(t, lines) { fs.writeFileSync(path.join(t.home, '.claude', 'daemon.log'), `${lines.join('\n')}\n`); }
function job(t, short, name, sid) {
  fs.mkdirSync(path.join(t.home, '.claude', 'jobs', short), { recursive: true });
  fs.writeFileSync(path.join(t.home, '.claude', 'jobs', short, 'state.json'), JSON.stringify({ state: 'working', name, sessionId: sid, daemonShort: short }));
}
const retire = (ms, short, idle) => `[${iso(ms)}] [bg] bg retire ${short}: idle-prompt, idle ${idle}m [low memory]`;
const settled = (ms, short) => `[${iso(ms)}] [bg] bg settled ${short} (done)`;
const claimed = (ms, short) => `[${iso(ms)}] [bg] bg claimed-spare ${short} (fleet)`;

// ── La espera de un turno (AC 23 a 26) ─────────────────────────────────────────────────────────────────────────────

// la nota de espera se mide contra el reloj real (su tope de 24 h): sus horas salen de ahora
// stable-data: el tope de 24 h de la espera se mide con el reloj real, sin fecha inyectable
const recien = () => new Date(Date.now() - 60000).toISOString();

test('T27 TurnWait_NotaWaitingFor_TipoTurnSinDuenoA30 @story-8.202 @ac-23', () => {
  const t = toy();
  note(t, 'ses-a', { text: '8.201: espera el turno de suite', at: recien(), waitingFor: 'el turno de suite de la coordinadora', waitingSince: recien() });
  const w = WN.waitOf({ sid: 'ses-a', marker: { storyId: '8.201' }, last: { kind: 'stop', line: 'Quedo esperando el «arrancá» de la Coordinadora' }, home: t.home });
  assert.strictEqual(w.kind, 'turn');
  assert.strictEqual(w.line, 'espera el turno de suite de la coordinadora');
  const env = { TYCON_WAIT_NOTICE_OWNER_MS: String(30 * 60000), TYCON_WAIT_NOTICE_PEER_OWNER_MS: String(120 * 60000) };
  assert.strictEqual(WN.ownerDeadlineFor('turn', { env }).ms, 120 * 60000, 'al dueño recién a los 120');
  assert.strictEqual(WN.ownerDeadlineFor('stop', { env }).ms, 30 * 60000);
});

test('T28 TurnWait_GanaSobreElFrenoDelCierre @story-8.202 @ac-24', () => {
  const t = toy();
  const marker = { storyId: '8.201', needs_human: true, escalation_reason: 'la vuelta no resolvió ninguno de los fallos de la anterior' };
  note(t, 'ses-a', { text: 'x espera', at: recien(), waitingFor: 'el turno de suite de la coordinadora', waitingSince: recien() });
  const con = WN.waitOf({ sid: 'ses-a', marker, last: { kind: 'stop', line: 'algo' }, home: t.home });
  assert.deepStrictEqual(con, { kind: 'turn', line: 'espera el turno de suite de la coordinadora' });
  // una nota de espera de hace más de 24 h no cuenta: el aviso vuelve a ser el de siempre
  note(t, 'ses-c', { text: 'x espera', at: recien(), waitingFor: 'algo de ayer', waitingSince: new Date(Date.now() - 30 * 3600000).toISOString() });
  assert.deepStrictEqual(WN.waitOf({ sid: 'ses-c', marker: {}, last: { kind: 'stop', line: 'listo' }, home: t.home }), { kind: 'stop', line: 'listo' });
  const sin = WN.waitOf({ sid: 'ses-b', marker, last: { kind: 'stop', line: 'algo' }, home: t.home });
  assert.deepStrictEqual(sin, { kind: 'stop', line: 'la vuelta no resolvió ninguno de los fallos de la anterior' });
});

test('T29 Oficina_EsperaAnotadaGanaSobreEsperaDeClaude @story-8.202 @ac-25', () => {
  const x = { kind: 'pipeline', current: 'run-tests', waitingFor: 'el turno de suite de la coordinadora' };
  assert.deepStrictEqual(W.realState(x, { status: 'waiting' }, { waitingForOwner: false }), { estado: 'espera', espera: 'el turno de suite de la coordinadora' });
  assert.deepStrictEqual(W.realState(x, { status: 'waiting' }, null), { estado: 'espera', espera: 'el turno de suite de la coordinadora' });
  assert.strictEqual(W.realState(x, { status: 'waiting' }, { waitingForOwner: true, waitingFor: 'un permiso' }).estado, 'firma', 'con cuadro, el cuadro');
  assert.strictEqual(W.realState(x, { status: 'waiting', waitingFor: 'permission prompt' }, null).estado, 'firma', 'el cuadro que dice Claude también');
  assert.strictEqual(W.realState({ kind: 'pipeline', current: 'run-tests' }, { status: 'waiting' }, null).estado, 'pregunta', 'sin nota, como hoy');
});

test('T30 TurnWait_NotaCambiada_ComoHoy @story-8.202 @ac-26', () => {
  const t = toy();
  note(t, 'ses-a', { text: 'x trabaja', at: mins(1), endAt: mins(-60) });
  assert.deepStrictEqual(WN.waitOf({ sid: 'ses-a', marker: { storyId: '1.1' }, last: { kind: 'stop', line: 'listo' }, home: t.home }), { kind: 'stop', line: 'listo' });
  assert.deepStrictEqual(WN.waitOf({ sid: 'ses-a', marker: { storyId: '1.1' }, last: { kind: 'peer', line: 'la respuesta de X' }, home: t.home }), { kind: 'peer', line: 'la respuesta de X' });
  assert.deepStrictEqual(WN.waitOf({ sid: 'ses-z', marker: { storyId: '1.1' }, last: { kind: 'stop', line: 'listo' }, home: t.home }), { kind: 'stop', line: 'listo' }, 'sin nota');
});

// ── La sesión que cerró Claude Code (AC 27 a 32) ───────────────────────────────────────────────────────────────────

test('T31 Retiradas_Status_LaLineaYJson @story-8.202 @ac-27', () => {
  const t = toy();
  daemon(t, [retire(mins(40), 'aaaabbbb', 27), settled(mins(40), 'aaaabbbb'), retire(mins(40), 'ccccdddd', 15)]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  const s = C.status(t.opts);
  assert.strictEqual(s.retiredMeasured, true);
  const norte = s.retired.find((r) => r.sid === SID_NORTE);
  assert.deepStrictEqual(Object.keys(norte).sort(), ['at', 'idleMin', 'reason', 'session', 'short', 'sid']);
  assert.strictEqual(norte.session, 'trabajo-norte');
  assert.strictEqual(norte.idleMin, 27);
  const anon = s.retired.find((r) => r.short === 'ccccdddd');
  assert.strictEqual(anon.session, 'ccccdddd', 'sin su archivo, el id corto');
  const text = C.statusText(s);
  assert.match(text, /Cerradas por Claude Code: .*trabajo-norte: la cerró Claude Code a las \d\d:\d\d por falta de memoria, quieta 27 min, sin anotar qué esperaba\. Para levantarla: coordination\.js relaunch --id aaaabbbb/);
  assert.ok(!s.working.some((w) => w.sid === SID_NORTE), 'no cuenta para el tope');
});

test('T32 Retiradas_Levantada_DejaDeSalir @story-8.202 @ac-28', () => {
  const t = toy();
  daemon(t, [retire(mins(40), 'aaaabbbb', 27), settled(mins(40), 'aaaabbbb'), claimed(mins(20), 'aaaabbbb')]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  assert.deepStrictEqual(C.status(t.opts).retired, []);
  assert.doesNotMatch(C.statusText(C.status(t.opts)), /Cerradas por Claude Code/);
});

test('T33 OwnerWait_Retirada_TerminaUnaVez @story-8.202 @ac-29', () => {
  const t = toy();
  daemon(t, [retire(mins(1), 'aaaabbbb', 27)]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  const r = C.ownerWaitOnce(t.opts);
  assert.deepStrictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /^trabajo-norte: la cerró Claude Code a las \d\d:\d\d por falta de memoria, quieta 27 min, sin anotar qué esperaba\. Para levantarla: coordination\.js relaunch --id aaaabbbb$/);
  assert.deepStrictEqual(C.ownerWaitOnce(t.opts).lines, [], 'la segunda vez no');
});

test('T34 Oficina_Retirada_LaFila @story-8.202 @ac-30', () => {
  const wip = { rows: [], details: [], extra: [], free: [], halfway: [], unreadable: [], retired: [{ session: 'trabajo-norte', sid: SID_NORTE, short: 'aaaabbbb', at: mins(40), reason: 'falta de memoria', idleMin: 27 }] };
  const { data } = O.buildOffice({ wip, nowMs: NOW });
  const all = JSON.stringify(data);
  assert.match(all, /la cerró Claude Code \(falta de memoria\), quieta 27 min/);
  assert.match(all, /claude respawn aaaabbbb/);
  assert.doesNotMatch(all, /trabajo-norte[^}]*"estado":"trabajando"/);
  const w = W.renderRetired(wip.retired);
  assert.match(w, /trabajo-norte: la cerró Claude Code \(falta de memoria\), quieta 27 min, sin anotar qué esperaba — claude respawn aaaabbbb/);
});

test('T35 Retiradas_SinRegistroOIlegible_NoMedido @story-8.202 @ac-31 @ac-32', () => {
  const t = toy();
  let r = R.retiredSessions({ home: t.home, now: NOW });
  assert.strictEqual(r.measured, false);
  assert.match(r.why, /no hay registro/);
  assert.match(C.statusText(C.status(t.opts)), /Sesiones cerradas por Claude Code: no medido \(no hay registro/);
  assert.doesNotMatch(C.statusText(C.status(t.opts)), /cerradas por Claude Code: ninguna/i);
  daemon(t, [`[${iso(mins(5))}] [bg] bg retire aaaabbbb por algo nuevo`]);
  r = R.retiredSessions({ home: t.home, now: NOW });
  assert.strictEqual(r.measured, false, 'un retiro con otra forma no se entiende');
  assert.match(r.why, /no entiendo/);
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    fs.chmodSync(path.join(t.home, '.claude', 'daemon.log'), 0o000);
    r = R.retiredSessions({ home: t.home, now: NOW });
    assert.strictEqual(r.measured, false);
    assert.match(r.why, /no se pudo leer/);
    fs.chmodSync(path.join(t.home, '.claude', 'daemon.log'), 0o600);
  }
  // un registro de 1 MB: lee sólo el final; un retiro de hace más de 12 h no cuenta
  const pad = `[${iso(mins(60))}] [supervisor] auth: token still valid ${'x'.repeat(200)}`;
  const big = [retire(mins(13 * 60), 'aaaaaaaa', 20), ...Array.from({ length: 5000 }, () => pad), retire(mins(5), 'bbbbbbbb', 30)];
  daemon(t, big);
  r = R.retiredSessions({ home: t.home, now: NOW });
  assert.strictEqual(r.measured, true);
  assert.deepStrictEqual(r.retired.map((x) => x.short), ['bbbbbbbb']);
  assert.ok(r.bytesRead <= 256 * 1024, r.bytesRead);
  // con Codex nada cambia: sin registro de Claude, no medido, sin error
  assert.doesNotThrow(() => R.retiredSessions({ home: path.join(t.root, 'no-existe'), now: NOW }));
});

test('T37 Retiradas_QuietaHorasYMotivoDesconocido_SeCuentan @story-8.202 @ac-31', () => {
  const t = toy();
  daemon(t, [
    `[${iso(mins(50))}] [bg] bg retire aaaabbbb: idle-prompt, idle 2h [low memory]`,
    `[${iso(mins(40))}] [bg] bg retire ccccdddd: idle-prompt, idle 1h5m [algo nuevo]`,
    `[${iso(mins(30))}] [bg] bg retire eeeeffff: idle-prompt, idle 45s`,
  ]);
  const r = R.retiredSessions({ home: t.home, now: NOW });
  assert.strictEqual(r.measured, true, r.why);
  assert.deepStrictEqual(r.retired.map((x) => [x.short, x.idleMin, x.reason]), [
    ['aaaabbbb', 120, 'falta de memoria'],
    ['ccccdddd', 65, 'un motivo que no conozco: algo nuevo'],
    ['eeeeffff', 0, 'idle-prompt'],
  ]);
});

test('Adv5 Wip_Retiradas_VivaFueraEIlegibleDicho @story-8.202 @ac-30 @ac-31', () => {
  const t = toy();
  daemon(t, [retire(mins(40), 'aaaabbbb', 27), retire(mins(40), 'ccccdddd', 15)]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  job(t, 'ccccdddd', 'trabajo-sur', 'ccccdddd-sesion-sur');
  // trabajo-sur volvió y está viva: no sale como cerrada
  const sessions = new Map([['ccccdddd-sesion-sur', { alive: true }]]);
  const unreadable = [];
  assert.deepStrictEqual(W.retiredNow(t.home, NOW, sessions, unreadable).map((x) => x.session), ['trabajo-norte']);
  assert.deepStrictEqual(unreadable, []);
  // un registro que no se entiende se dice, sin caracteres de control; sin registro, nada
  daemon(t, [`[${iso(mins(5))}] [bg] bg retire aaaabbbb por algo\u001b[31m nuevo`]);
  const u2 = [];
  assert.deepStrictEqual(W.retiredNow(t.home, NOW, new Map(), u2), []);
  assert.strictEqual(u2.length, 1);
  assert.match(u2[0], /no entiendo un retiro/);
  assert.doesNotMatch(u2[0], /\u001b/);
  const u3 = [];
  W.retiredNow(path.join(t.root, 'otra-casa'), NOW, new Map(), u3);
  assert.deepStrictEqual(u3, []);
  // la espera anotada se muestra en una línea, sin caracteres de control y acotada
  const r = W.realState({ kind: 'pipeline', waitingFor: `el turno\u001b[2J ${'x'.repeat(300)}` }, { status: 'waiting' }, null);
  assert.doesNotMatch(r.espera, /\u001b/);
  assert.ok(r.espera.length <= 120);
});

test('T36 CapNotice_RetiradaSinAnunciar_LaLinea @story-8.202 @ac-29', () => {
  const t = toy();
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'owner-wait.pid'), String(process.pid));
  daemon(t, [retire(mins(10), 'aaaabbbb', 27)]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  assert.match(C.capNotice(t.opts) || '', /trabajo-norte: la cerró Claude Code .* coordination\.js relaunch --id aaaabbbb/);
  C.ownerWaitOnce(t.opts);
  assert.doesNotMatch(C.capNotice(t.opts) || '', /la cerró Claude Code/, 'ya anunciada');
});

// ── El motivo de un lugar libre a propósito, en /wip y en la oficina (@story-8.307, AC 13) ──────────────────────────

test('T12 Wip_MotivoVigente_SeVeYVencidoNo @story-8.307 @ac-13', () => {
  const FS = require(path.join(ROOT, 'scripts', 'lib', 'free-slots.js'));
  const t = toy();
  const rec = (extra = {}) => ({ at: iso(mins(10)), expiresAt: iso(NOW + 20 * 60000), sid: COORD, session: 'Coordinadora', kind: 'reason', reason: 'espero el merge de la 8.288', working: 2, cap: 6, memoryPct: 48, work: ['story:8.232'], ...extra });
  FS.write(t.state, rec());
  const u = [];
  const list = W.freeSlotsNow(t.state, NOW, u);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(u, []);
  assert.match(W.renderFreeSlots(list), /^\n\nLugares libres a propósito: Coordinadora, \d\d:\d\d a \d\d:\d\d: espero el merge de la 8\.288$/);
  const wip = W.buildWip({ home: t.home, now: iso(NOW) });
  assert.strictEqual(wip.freeSlots.length, 1);
  assert.match(wip.text, /Lugares libres a propósito: Coordinadora, \d\d:\d\d a \d\d:\d\d: espero el merge de la 8\.288/);
  // la oficina lee el mismo `wip` que /wip: una tarjeta `riesgo` con el mismo texto
  const office = () => JSON.stringify(O.buildOffice({ wip: W.buildWip({ home: t.home, now: iso(NOW) }), nowMs: NOW }).data);
  const all = office();
  assert.match(all, /Lugares libres a propósito: Coordinadora, \d\d:\d\d a \d\d:\d\d: espero el merge de la 8\.288/);
  assert.match(all, /"estado":"riesgo"/);
  // el cierre sin motivo se ve igual que un motivo, en /wip y en la oficina
  FS.write(t.state, rec({ kind: 'closed-without-reason', reason: 'cerró sin abrir ni motivo' }));
  assert.match(W.renderFreeSlots(W.freeSlotsNow(t.state, NOW, [])), /cerró sin abrir ni motivo/);
  assert.match(office(), /Lugares libres a propósito: Coordinadora, \d\d:\d\d a \d\d:\d\d: cerró sin abrir ni motivo/);
  // vencido no sale en ninguna de las dos; el registro lo conserva
  FS.write(t.state, rec({ expiresAt: iso(mins(1)) }));
  assert.deepStrictEqual(W.freeSlotsNow(t.state, NOW, []), []);
  assert.strictEqual(W.renderFreeSlots([]), '');
  assert.doesNotMatch(office(), /Lugares libres a propósito/);
  assert.strictEqual(fs.readFileSync(FS.files(t.state).log, 'utf8').trim().split('\n').length, 3);
  // un archivo roto no rompe /wip: va a lo que no se pudo leer
  fs.writeFileSync(FS.files(t.state).current, '{ roto');
  const u2 = [];
  assert.deepStrictEqual(W.freeSlotsNow(t.state, NOW, u2), []);
  assert.strictEqual(u2.length, 1);
  assert.match(u2[0], /lugares libres/i);
  const wip2 = W.buildWip({ home: t.home, now: iso(NOW) });
  assert.ok(wip2.text.length > 0);
  assert.ok(wip2.unreadable.some((x) => /lugares libres/i.test(x)));
});

// ── owner-wait que termina porque esta sesión dejó de ser la coordinadora (R4) ──────────────────────────────────────

test('OwnerWait_DejaDeSerCoordinadora_DicePorQueTermina', () => {
  const t = toy();
  // la primera lectura la ve confirmada (arranca a esperar) y la siguiente ya no: la confirmación se retiró mientras esperaba
  let llamadas = 0;
  const antes = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o) => (++llamadas === 1 ? antes(casa, o) : null);
  try {
    const r = C.ownerWait({ ...t.opts, env: { TYCON_OWNER_WAIT_POLL_MS: '1' } });
    assert.strictEqual(r.code, 0);
    assert.match(r.text, /ya no es la coordinadora confirmada/, 'no termina mudo');
  } finally { OA.coordinadoraConfirmada = antes; }
});

// Una sesión que Claude Code cerró mientras esperaba algo: la línea dice qué esperaba (su nota de espera, o la espera
// abierta de su pipeline) y cómo levantarla. Sin nada anotado, lo dice en vez de callarlo.
test('T38 Retiradas_DicenQueEsperaban', () => {
  const t = toy();
  daemon(t, [retire(mins(40), 'aaaabbbb', 27), retire(mins(40), 'eeeeffff', 15), retire(mins(40), 'ccccdddd', 12)]);
  job(t, 'aaaabbbb', 'trabajo-norte', SID_NORTE);
  note(t, SID_NORTE, { text: 'espera', at: iso(mins(70)), waitingFor: 'la firma de la coordinadora', waitingSince: iso(mins(70)) });
  const SID_SUR = 'eeeeffff-sesion-sur';
  job(t, 'eeeeffff', 'trabajo-sur', SID_SUR);
  const waits = path.join(t.state, 'wait-notice', 'waits');
  fs.mkdirSync(waits, { recursive: true });
  fs.writeFileSync(path.join(waits, `${SID_SUR}.json`), JSON.stringify({ session: SID_SUR, story: '9.9', step: 'approve-plan', stepName: 'Aprobar el plan', kind: 'stop', waiting: '¿Apruebo el plan?', openedAt: iso(mins(60)) }));
  const s = C.status(t.opts);
  const norte = s.retired.find((r) => r.sid === SID_NORTE);
  const sur = s.retired.find((r) => r.sid === SID_SUR);
  const anon = s.retired.find((r) => r.short === 'ccccdddd');
  assert.strictEqual(norte.waited, 'la firma de la coordinadora');
  assert.match(sur.waited, /la 9\.9, Aprobar el plan: ¿Apruebo el plan\?/);
  assert.strictEqual(anon.waited, undefined, 'sin nada anotado, sin el campo');
  const text = C.statusText(s);
  assert.match(text, /trabajo-norte: la cerró Claude Code a las \d\d:\d\d por falta de memoria, quieta 27 min, esperando la firma de la coordinadora desde las \d\d:\d\d\. Para levantarla: coordination\.js relaunch --id aaaabbbb/);
  assert.match(text, /ccccdddd: la cerró Claude Code .*quieta 12 min, sin anotar qué esperaba\. Para levantarla: coordination\.js relaunch --id ccccdddd/);
  assert.match(W.renderRetired(s.retired), /trabajo-sur: la cerró Claude Code \(falta de memoria\), quieta 15 min, esperando la 9\.9, Aprobar el plan/);
  const oficina = JSON.stringify(O.buildOffice({ wip: { rows: [], details: [], extra: [], free: [], halfway: [], unreadable: [], retired: s.retired }, nowMs: NOW }).data);
  assert.match(oficina, /esperaba la firma de la coordinadora; para levantarla: claude respawn aaaabbbb/);
  assert.match(oficina, /no anotó qué esperaba; para levantarla: claude respawn ccccdddd/);
});
