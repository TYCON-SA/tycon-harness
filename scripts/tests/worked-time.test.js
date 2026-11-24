'use strict';
/**
 * worked-time.test.js — el tramo trabajado de cada sesión: lo abre y lo cierra el gancho de estado
 * (scripts/hooks/session-state.js), lo anota scripts/lib/worked-time.js por día local. T1 a T12, T36 y T37.
 *
 * Cada caso tiene su HOME de juguete. El reloj se inyecta: `handle(d, env, home, now)` en el mismo proceso, y el
 * gancho como proceso para lo que mira el proceso entero (sale 0 sin imprimir, dos a la vez). La zona es fija
 * (UTC-3 sin horario de verano) en este proceso y en los que lanza.
 *
 * stable-data: todas las horas son fechas fijas en la zona fija; ninguna comprobación depende del reloj real, salvo
 * T5 (dos procesos a la vez), que sólo cuenta cuántas aperturas hay.
 *
 * Correr: node --test scripts/tests/worked-time.test.js
 */
process.env.TZ = 'America/Argentina/Buenos_Aires';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'session-state.js');
const WT = path.join(ROOT, 'scripts', 'lib', 'worked-time.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'session-state.js');
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const MIN = 60000;
const TZ = 'America/Argentina/Buenos_Aires';
// una hora local de la zona fija (UTC-3), escrita «AAAA-MM-DD hh:mm» → ms
const at = (local) => Date.parse(`${local.replace(' ', 'T')}:00-03:00`);

function cleanEnv(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^TYCON_|^CODEX_|^CLAUDE_/.test(k)) continue;
    e[k] = v;
  }
  return Object.assign(e, { HOME: home, USERPROFILE: home, TZ, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none' }, extra);
}

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worked-time-'));
  const sdir = stateDir(home);
  fs.mkdirSync(sdir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  return { home, sdir };
}

// un momento del gancho en este proceso, con la hora dada
const handle = (w, d, now, extra = {}) => require(HOOK).handle(d, cleanEnv(w.home, extra), w.home, now);
const ev = (sid, name, more = {}) => ({ session_id: sid, hook_event_name: name, ...more });
const codexEv = (sid, name, more = {}) => ({ session_id: sid, hook_event_name: name, turn_id: 't1', ...more });
const stateOf = (w, sid) => { try { return JSON.parse(fs.readFileSync(path.join(w.sdir, 'sessions', `${sid}.json`), 'utf8')); } catch { return null; } };
const workedDir = (w) => path.join(w.sdir, 'worked');
function spansOf(w, day) {
  let text = '';
  try { text = fs.readFileSync(path.join(workedDir(w), `${day}.jsonl`), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const minutes = (s) => Math.round((Date.parse(s.hasta) - Date.parse(s.desde)) / MIN);

test('T1 Tramo_PromptYStop_AnotaElRenglon @story-8.209 @ac-1', () => {
  const w = world();
  const env = cleanEnv(w.home);
  const run = (d) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(d), env, encoding: 'utf8' });
  const a = run(ev('s1', 'UserPromptSubmit'));
  assert.strictEqual(a.status, 0);
  assert.strictEqual(a.stdout, '');
  assert.ok(stateOf(w, 's1').workingSince, 'workingSince abierto');
  const b = run(ev('s1', 'Stop'));
  assert.strictEqual(b.status, 0);
  assert.strictEqual(b.stdout, '');
  assert.strictEqual(stateOf(w, 's1').workingSince, undefined, 'el tramo se cerró');
  const today = require(WT).dayOf(Date.now());
  const spans = spansOf(w, today);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].sid, 's1');
  assert.strictEqual(spans[0].tool, 'claude');
  assert.ok(spans[0].desde && spans[0].hasta);
});

test('T2 Tramo_SessionEnd_CierraElTramo @story-8.209 @ac-1', () => {
  const w = world();
  handle(w, ev('s2', 'UserPromptSubmit'), at('2026-11-10 09:00'));
  handle(w, ev('s2', 'SessionEnd'), at('2026-11-10 09:30'));
  assert.strictEqual(stateOf(w, 's2'), null, 'sin archivo de estado');
  const spans = spansOf(w, '2026-11-10');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(minutes(spans[0]), 30);
});

test('T3 Tramo_EsperaDeLaPersona_Pausa @story-8.209 @ac-2', () => {
  const w = world();
  handle(w, ev('s3', 'UserPromptSubmit'), at('2026-11-10 10:00'));
  handle(w, ev('s3', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }), at('2026-11-10 10:05'));
  handle(w, ev('s3', 'PostToolUse', { tool_name: 'Read' }), at('2026-11-10 10:07'));
  assert.strictEqual(stateOf(w, 's3').workingSince, undefined, 'otra herramienta no cierra el permiso pedido: no reabre');
  handle(w, ev('s3', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 10:09'));
  handle(w, ev('s3', 'Stop'), at('2026-11-10 10:12'));
  assert.deepStrictEqual(spansOf(w, '2026-11-10').map(minutes), [5, 3]);
});

test('T4 Tramo_Pregunta_Pausa @story-8.209 @ac-2', () => {
  const w = world();
  handle(w, ev('s4', 'UserPromptSubmit'), at('2026-11-10 11:00'));
  handle(w, ev('s4', 'PreToolUse', { tool_name: 'AskUserQuestion' }), at('2026-11-10 11:04'));
  assert.strictEqual(stateOf(w, 's4').workingSince, undefined, 'la pregunta pausa');
  handle(w, ev('s4', 'PostToolUse', { tool_name: 'AskUserQuestion' }), at('2026-11-10 11:20'));
  assert.ok(stateOf(w, 's4').workingSince, 'la respuesta reabre');
  handle(w, ev('s4', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), at('2026-11-10 11:30'));
  assert.strictEqual(stateOf(w, 's4').workingSince, undefined, 'la notificación pausa');
  handle(w, ev('s4', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 11:40'));
  assert.ok(stateOf(w, 's4').workingSince, 'el final de la herramienta reabre');
  handle(w, ev('s4', 'Stop'), at('2026-11-10 11:45'));
  assert.deepStrictEqual(spansOf(w, '2026-11-10').map(minutes), [4, 10, 5]);
});

test('T5 Tramo_CruzaLaMedianoche_DosDias @story-8.209 @ac-3', async () => {
  const w = world();
  handle(w, ev('s5', 'UserPromptSubmit'), at('2026-11-10 23:50'));
  handle(w, ev('s5', 'Stop'), at('2026-11-11 00:20'));
  assert.deepStrictEqual(spansOf(w, '2026-11-10').map(minutes), [10]);
  assert.deepStrictEqual(spansOf(w, '2026-11-11').map(minutes), [20]);
  const opened = JSON.parse(fs.readFileSync(path.join(workedDir(w), '2026-11-11.abierto'), 'utf8'));
  assert.strictEqual(Date.parse(opened.abierto), at('2026-11-11 00:20'), 'la apertura es del evento, no del tramo partido');
  assert.strictEqual(opened.tz, '-03:00');
  // dos procesos del gancho a la vez: una sola apertura del día
  const w2 = world();
  const env = cleanEnv(w2.home);
  const one = (sid) => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env });
    p.on('exit', resolve);
    p.stdin.end(JSON.stringify(ev(sid, 'UserPromptSubmit')));
  });
  await Promise.all([one('a'), one('b')]);
  const opens = fs.readdirSync(workedDir(w2)).filter((n) => n.endsWith('.abierto'));
  assert.strictEqual(opens.length, 1);
});

test('T6 Tramo_Codex_SeAnota @story-8.209 @ac-4 @ac-24', () => {
  const w = world();
  handle(w, codexEv('c6', 'UserPromptSubmit'), at('2026-11-10 14:00'));
  handle(w, codexEv('c6', 'Stop'), at('2026-11-10 14:25'));
  const spans = spansOf(w, '2026-11-10');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].tool, 'codex');
  assert.strictEqual(minutes(spans[0]), 25);
  assert.strictEqual(stateOf(w, 'c6').busy, false, 'lo de Codex sigue igual');
  // un PostToolUse suelto después del Stop de Claude no abre
  handle(w, ev('s6', 'UserPromptSubmit'), at('2026-11-10 15:00'));
  handle(w, ev('s6', 'Stop'), at('2026-11-10 15:10'));
  handle(w, ev('s6', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 15:12'));
  assert.strictEqual(stateOf(w, 's6').workingSince, undefined);
});

test('T7 Tramo_SesionMuerta_CierraEnSuUltimoEvento @story-8.209 @ac-5', () => {
  const w = world();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  handle(w, ev('s7', 'UserPromptSubmit'), at('2026-11-10 08:00'));
  handle(w, ev('s7', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 08:40'));
  require(LIB).update(w.sdir, 's7', { pid: dead }, { env: cleanEnv(w.home) });
  const closed = require(WT).closeDead(w.sdir, { now: at('2026-11-10 10:40'), env: cleanEnv(w.home) });
  assert.strictEqual(closed, 1);
  const spans = spansOf(w, '2026-11-10');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(Date.parse(spans[0].hasta), at('2026-11-10 08:40'), 'cierra en lastEventAt, no a la hora de la preparación');
  assert.strictEqual(stateOf(w, 's7').workingSince, undefined);
});

test('T8 Tramo_Apagado_NoAnota @story-8.209 @ac-6', () => {
  for (const off of [{ TYCON_WORKDAYS: '0' }, { TYCON_SESSION_STATE: '0' }]) {
    const w = world();
    const env = cleanEnv(w.home, off);
    for (const name of ['UserPromptSubmit', 'Stop']) spawnSync(process.execPath, [HOOK], { input: JSON.stringify(ev('s8', name)), env });
    const st = stateOf(w, 's8');
    assert.ok(!st || st.workingSince === undefined, JSON.stringify(off));
    assert.ok(!fs.existsSync(workedDir(w)), `${JSON.stringify(off)}: ningún renglón ni apertura`);
  }
});

test('T9 Tramo_DosSesiones_SumanLasDos @story-8.209 @ac-1 @ac-25', () => {
  const w = world();
  for (const sid of ['a9', 'b9']) handle(w, ev(sid, 'UserPromptSubmit'), at('2026-11-10 09:00'));
  for (const sid of ['a9', 'b9']) handle(w, ev(sid, 'Stop'), at('2026-11-10 10:00'));
  const t = require(WT).readDay(w.sdir, '2026-11-10');
  assert.strictEqual(t.sesion_segundos, 2 * 3600);
  assert.strictEqual(t.arnes_segundos, 3600);
  assert.strictEqual(t.sesiones, 2);
});

test('T10 Tramo_SubagenteNoSumaAparte @story-8.209 @ac-1', () => {
  const w = world();
  handle(w, ev('s10', 'UserPromptSubmit'), at('2026-11-10 13:00'));
  for (const [tool, m] of [['Read', 5], ['Bash', 10], ['Grep', 15], ['Agent', 20]]) handle(w, ev('s10', 'PostToolUse', { tool_name: tool }), at(`2026-11-10 13:${m}`));
  handle(w, ev('s10', 'Stop'), at('2026-11-10 13:30'));
  assert.deepStrictEqual(spansOf(w, '2026-11-10').map(minutes), [30]);
});

test('T11 Tramo_RenglonRoto_NoTiraElDia @story-8.209 @ac-11', () => {
  const w = world();
  fs.mkdirSync(workedDir(w), { recursive: true });
  const line = (sid, a, b) => JSON.stringify({ sid, tool: 'claude', desde: new Date(at(a)).toISOString(), hasta: new Date(at(b)).toISOString() });
  fs.writeFileSync(path.join(workedDir(w), '2026-11-10.jsonl'), `${line('x', '2026-11-10 09:00', '2026-11-10 09:30')}\n{roto\n${line('y', '2026-11-10 10:00', '2026-11-10 10:30')}\n`);
  const t = require(WT).readDay(w.sdir, '2026-11-10');
  assert.strictEqual(t.sesion_segundos, 3600);
  assert.strictEqual(t.ilegibles, 1);
});

test('T12 EstadoSinTurno_FormaDeSiempre @story-8.209 @ac-23', () => {
  const w = world();
  handle(w, ev('s12', 'SessionStart'), at('2026-11-10 09:00'));
  const st = stateOf(w, 's12');
  assert.ok(st);
  assert.ok(!('workingSince' in st) && !('lastEventAt' in st), Object.keys(st).join(','));
  handle(w, ev('s12', 'UserPromptSubmit'), at('2026-11-10 09:01'));
  handle(w, ev('s12', 'Stop'), at('2026-11-10 09:02'));
  const after = stateOf(w, 's12');
  assert.ok(!('workingSince' in after) && !('lastEventAt' in after), 'cerrado el turno, vuelve a la forma de siempre');
});

test('T36 Tramo_LastEventAt_SeRefresca @story-8.209 @ac-5', () => {
  const w = world();
  handle(w, ev('s36', 'UserPromptSubmit'), at('2026-11-10 16:00'));
  handle(w, ev('s36', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 16:10'));
  assert.strictEqual(Date.parse(stateOf(w, 's36').lastEventAt), at('2026-11-10 16:10'));
  const file = path.join(w.sdir, 'sessions', 's36.json');
  const before = fs.readFileSync(file, 'utf8');
  handle(w, ev('s36', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 16:10') + 20000);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'menos de un minuto: no reescribe');
});

test('T37 Tramo_CodexSinEventos_CierraALasDosHoras @story-8.209 @ac-5', () => {
  const w = world();
  handle(w, codexEv('c37', 'UserPromptSubmit'), at('2026-11-10 09:00'));
  handle(w, codexEv('c37', 'PostToolUse', { tool_name: 'apply_patch' }), at('2026-11-10 09:20'));
  handle(w, codexEv('d37', 'UserPromptSubmit'), at('2026-11-10 11:00'));
  const closed = require(WT).closeDead(w.sdir, { now: at('2026-11-10 12:00'), env: cleanEnv(w.home) });
  assert.strictEqual(closed, 1);
  const spans = spansOf(w, '2026-11-10');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].sid, 'c37');
  assert.strictEqual(minutes(spans[0]), 20, 'cierra en su último PostToolUse, no al empezar el turno');
  assert.ok(stateOf(w, 'd37').workingSince, 'el de hace 1 h sigue abierto');
  // el adaptador de Codex engancha el gancho en PostToolUse de Bash y de apply_patch
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8')).hooks;
  const post = (hooks.PostToolUse || []).filter((g) => (g.hooks || []).some((h) => /hooks\/session-state\.js/.test(h.command)));
  assert.deepStrictEqual(post.map((g) => g.matcher).sort(), ['Bash', 'apply_patch']);
});

test('T42 Tramo_Compactacion_SigueElTurno @story-8.209 @ac-2', () => {
  // una compactación a mitad del turno manda un SessionStart en el mismo proceso: el tramo sigue abierto
  const w = world();
  handle(w, ev('s42', 'UserPromptSubmit'), at('2026-11-10 09:00'));
  handle(w, ev('s42', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 09:30'));
  handle(w, ev('s42', 'SessionStart', { source: 'compact' }), at('2026-11-10 09:31'));
  handle(w, ev('s42', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 11:00'));
  handle(w, ev('s42', 'Stop'), at('2026-11-10 12:00'));
  const spans = spansOf(w, '2026-11-10');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(minutes(spans[0]), 180, 'del pedido al Stop, sin cortar en la compactación');
  // un arranque de verdad sí cierra el tramo de la vida anterior en su último evento
  handle(w, ev('s42b', 'UserPromptSubmit'), at('2026-11-10 13:00'));
  handle(w, ev('s42b', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 13:20'));
  handle(w, ev('s42b', 'SessionStart', { source: 'resume' }), at('2026-11-10 15:00'));
  const otro = spansOf(w, '2026-11-10').filter((s) => s.sid === 's42b');
  assert.strictEqual(otro.length, 1);
  assert.strictEqual(minutes(otro[0]), 20);
});

test('T43 Tramo_TurnoCortadoSinStop_NoCuentaElHueco @story-8.209 @ac-2', () => {
  // la persona corta el turno (sin Stop) y vuelve a pedir horas después: el hueco no se cuenta
  const w = world();
  handle(w, ev('s43', 'UserPromptSubmit'), at('2026-11-10 09:00'));
  handle(w, ev('s43', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 09:10'));
  handle(w, ev('s43', 'UserPromptSubmit'), at('2026-11-10 14:00'));
  handle(w, ev('s43', 'Stop'), at('2026-11-10 14:10'));
  const spans = spansOf(w, '2026-11-10');
  assert.deepStrictEqual(spans.map(minutes), [10, 10]);
  assert.strictEqual(require(WT).readDay(w.sdir, '2026-11-10').sesion_segundos, 20 * 60);
});

test('T44 Tramo_StopFrenado_ElTurnoSigueContando @story-8.209 @ac-2', () => {
  // otro gancho frena el Stop y el turno sigue: el Stop siguiente (stop_hook_active) suma lo que se trabajó en medio
  const w = world();
  handle(w, ev('s44', 'UserPromptSubmit'), at('2026-11-10 10:00'));
  handle(w, ev('s44', 'Stop'), at('2026-11-10 10:11'));
  handle(w, ev('s44', 'PostToolUse', { tool_name: 'Bash' }), at('2026-11-10 10:30'));
  handle(w, ev('s44', 'Stop', { stop_hook_active: true }), at('2026-11-10 10:51'));
  const spans = spansOf(w, '2026-11-10');
  assert.deepStrictEqual(spans.map(minutes), [11, 40]);
  assert.strictEqual(stateOf(w, 's44').workingSince, undefined);
  // un Stop común sin turno abierto no suma nada
  handle(w, ev('s44', 'Stop'), at('2026-11-10 11:30'));
  assert.strictEqual(spansOf(w, '2026-11-10').length, 2);
});
