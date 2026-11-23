'use strict';
// run-overrun.test.js — el aviso de la corrida que va por el doble (o el cuádruple) de lo estimado: mide el tiempo
// trabajado sin las esperas, avisa una vez por umbral a la propia sesión y lo deja dicho en su archivo de estado, de
// donde lo leen /wip, la oficina y coordination.js status.
// Todo en una casa de juguete en una carpeta temporal. Nada lee ni escribe la casa real.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test run-overrun.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RO = require(path.join(ROOT, 'scripts', 'lib', 'run-overrun.js'));
const W = require(path.join(ROOT, 'scripts', 'lib', 'worked-time.js'));
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'session-state.js');
const SID = 'aaaaaaaa-2222-4aaa-8bbb-00000000ab12';
const MIN = 60000;
const T0 = Date.parse('2026-11-21T10:00:00');

function casa(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overrun-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'active'), { recursive: true });
  return { home, sdir };
}
const marcador = (sdir, extra = {}) => fs.writeFileSync(path.join(sdir, 'active', `${SID}.json`), JSON.stringify({
  storyId: '9.9', startedAt: new Date(T0).toISOString(), estimate_min: 60, stepsPending: ['implement'], ...extra }));
const tramo = (sdir, desdeMin, hastaMin, sid = SID) => W.appendSpan(sdir, { sid, tool: 'claude', desde: T0 + desdeMin * MIN, hasta: T0 + hastaMin * MIN });

test('T1 Overrun_SoloCuentaLoTrabajado — las esperas entre tramos no suman; el tramo abierto sí; otra sesión no', (t) => {
  const { sdir } = casa(t);
  marcador(sdir);
  tramo(sdir, 0, 50);
  tramo(sdir, 300, 360); // 250 min de espera en el medio
  tramo(sdir, 0, 500, 'otra-sesion');
  const m = JSON.parse(fs.readFileSync(path.join(sdir, 'active', `${SID}.json`), 'utf8'));
  let o = RO.overrunOf(m, { sdir, sid: SID, now: T0 + 400 * MIN });
  assert.deepStrictEqual({ f: o.factor, w: o.worked_min }, { f: null, w: 110 }, 'con 110 de 60 no pasó el doble');
  o = RO.overrunOf(m, { sdir, sid: SID, now: T0 + 420 * MIN, openSince: new Date(T0 + 400 * MIN).toISOString() });
  assert.deepStrictEqual({ f: o.factor, w: o.worked_min }, { f: 2, w: 130 }, 'el tramo abierto suma');
  tramo(sdir, 400, 540);
  o = RO.overrunOf(m, { sdir, sid: SID, now: T0 + 550 * MIN, openSince: new Date(T0 + 400 * MIN).toISOString() });
  assert.strictEqual(o.factor, 4, 'el abierto ya cerrado no suma dos veces');
  assert.strictEqual(RO.overrunOf({ ...m, estimate_min: null }, { sdir, sid: SID }), null, 'sin estimación, nada');
  assert.strictEqual(RO.overrunOf({ ...m, stepsPending: [] }, { sdir, sid: SID }), null, 'corrida terminada, nada');
});

test('T2 Check_AvisaUnaVezPorUmbral — doble, cuádruple, una vez por minuto, y otra corrida empieza de cero', (t) => {
  const { sdir } = casa(t);
  marcador(sdir);
  tramo(sdir, 0, 130);
  let r = RO.check(sdir, SID, { now: T0 + 140 * MIN, env: {} });
  assert.match(r.notice, /la 9\.9\) va por el doble de lo estimado \(130 de 60 min/);
  assert.strictEqual(r.overrun.factor, 2);
  assert.strictEqual(RO.check(sdir, SID, { now: T0 + 140 * MIN + 1000, env: {} }).overrun, undefined, 'dentro del minuto no repasa');
  r = RO.check(sdir, SID, { now: T0 + 150 * MIN, env: {} });
  assert.strictEqual(r.notice, null, 'el doble no se avisa dos veces');
  assert.strictEqual(r.overrun.factor, 2, 'pero sigue anotado');
  tramo(sdir, 150, 270);
  r = RO.check(sdir, SID, { now: T0 + 280 * MIN, env: {} });
  assert.match(r.notice, /cuádruple/);
  marcador(sdir, { startedAt: new Date(T0 + 600 * MIN).toISOString() });
  r = RO.check(sdir, SID, { now: T0 + 610 * MIN, env: {} });
  assert.deepStrictEqual(r, { overrun: null, notice: null }, 'la corrida nueva empieza de cero');
  assert.deepStrictEqual(RO.check(sdir, SID, { now: T0 + 700 * MIN, env: { TYCON_OVERRUN: '0' } }), { overrun: null, notice: null }, 'apagado, la marca se borra');
});

test('T3 Hook_AvisaALaSesionYLoAnota — después de una herramienta, el aviso va al modelo y la marca al archivo de estado', (t) => {
  const { home, sdir } = casa(t);
  // stable-data: el gancho corre como proceso aparte con el reloj de verdad; el marcador y el tramo se arman contra ahora
  marcador(sdir, { startedAt: new Date(Date.now() - 300 * MIN).toISOString(), estimate_min: 30 });
  W.appendSpan(sdir, { sid: SID, tool: 'claude', desde: Date.now() - 200 * MIN, hasta: Date.now() - 60 * MIN });
  const correr = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Bash', cwd: home }),
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const r = correr();
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /cuádruple de lo estimado/);
  const st = JSON.parse(fs.readFileSync(path.join(sdir, 'sessions', `${SID}.json`), 'utf8'));
  assert.strictEqual(st.overrun.factor, 4);
  assert.match(RO.sessionText(sdir, SID), /^va por el cuádruple de lo estimado \(\d+ de 30 min trabajados\)$/);
  assert.strictEqual(correr().stdout, '', 'la segunda vez no avisa');
});

test('T4 LoMuestran_WipOficinaYCoordinacion — los tres leen la marca del archivo de estado', () => {
  for (const f of ['scripts/tools/coordination.js', 'scripts/tools/work-in-progress.js', 'scripts/tools/office.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /run-overrun\.js'\)\.(sessionText|overrunText)\(/, `${f} lee la marca`);
  }
  assert.strictEqual(RO.overrunText({ factor: 2, worked_min: 125, estimate_min: 60 }), 'va por el doble de lo estimado (125 de 60 min trabajados)');
  assert.strictEqual(RO.overrunText(null), null);
});

// Pase adversarial (21/11): la corrida que cambió de sesión, la que terminó, y la que arrancó hace más de dos semanas.
test('T5 Overrun_CorridaQueCambioDeSesion — adoptada suma lo de la anterior; restaurada no cuenta lo de antes de tomarla', (t) => {
  const { sdir } = casa(t);
  tramo(sdir, 0, 100, 'vieja');
  tramo(sdir, 110, 140);
  const adoptada = { storyId: '9.9', startedAt: new Date(T0).toISOString(), estimate_min: 60, stepsPending: ['implement'], adoptedFrom: 'vieja', adoptedAt: new Date(T0 + 105 * MIN).toISOString() };
  assert.deepStrictEqual(RO.overrunOf(adoptada, { sdir, sid: SID, now: T0 + 141 * MIN }), { factor: 2, estimate_min: 60, worked_min: 130, storyId: '9.9' });
  const { sdir: s2 } = casa(t);
  tramo(s2, -600, -360); // la sesión de ahora hizo otra cosa antes de restaurarla
  tramo(s2, 0, 5);
  const restaurada = { storyId: '9.9', startedAt: new Date(T0 - 1200 * MIN).toISOString(), estimate_min: 60, stepsPending: ['implement'], restoredFrom: SID, restoredAt: new Date(T0).toISOString() };
  assert.strictEqual(RO.overrunOf(restaurada, { sdir: s2, sid: SID, now: T0 + 10 * MIN }).worked_min, 5);
});

test('T6 Check_MarcaViejaSeBorra — al terminar la corrida, sin esperar el minuto; y una corrida de hace semanas ve los días recientes', (t) => {
  const { sdir } = casa(t);
  marcador(sdir);
  tramo(sdir, 0, 130);
  assert.strictEqual(RO.check(sdir, SID, { now: T0 + 140 * MIN, env: {} }).overrun.factor, 2);
  marcador(sdir, { stepsPending: [] });
  assert.deepStrictEqual(RO.check(sdir, SID, { now: T0 + 140 * MIN + 1000, env: {} }), { overrun: null, notice: null });
  const { sdir: s2 } = casa(t);
  const vieja = { storyId: '9.9', startedAt: new Date(T0 - 40 * 24 * 60 * MIN).toISOString(), estimate_min: 30, stepsPending: ['implement'] };
  tramo(s2, 0, 120);
  assert.strictEqual(RO.overrunOf(vieja, { sdir: s2, sid: SID, now: T0 + 130 * MIN }).factor, 4);
});
