'use strict';
// adhoc-orphan.test.js — `marker.js adhoc clear-orphan` (the ad-hoc a dead session left behind) and an honest
// `marker.js clear-session`. The real CLI runs against a temporary HOME; nothing touches the real state.
// stable-data: las fechas son relativas a ahora y marker.js mide contra el mismo reloj; 30 h y 2 h quedan lejos del corte de 24 h.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const ROOT = path.join(SCRIPTS, '..', '..', '..');

const OWN = 'own00000-0000';
const DEAD_PID = 999999;
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-'));
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  return { home, state };
}

function adhoc(m, sid, hours) {
  const f = path.join(m.state, 'adhoc', `${sid}.json`);
  fs.writeFileSync(f, JSON.stringify({ reason: `ajuste de ${sid}`, declaredAt: hoursAgo(hours), lastTouch: hoursAgo(hours) }));
  return f;
}

function session(m, sid, pid) {
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid, sessionId: sid }));
}

function cli(m, args) {
  return spawnSync('node', [MARKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: m.home, USERPROFILE: m.home, CLAUDE_CODE_SESSION_ID: OWN, TYCON_LANE_LLM: '0' },
  });
}

function log(m) {
  try { return fs.readFileSync(path.join(m.state, 'adhoc.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

test('T1 ClearOrphan_SesionMuertaYVieja_Borra: sesión sin rastro y ad-hoc de 30 h', () => {
  const m = machine();
  const f = adhoc(m, 'dead0000-1', 30);
  session(m, 'dead0000-1', DEAD_PID);
  const r = cli(m, ['adhoc', 'clear-orphan', 'dead0000-1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(f));
  const e = log(m).find((x) => x.kind === 'ADHOC_CLEAR_ORPHAN');
  assert.ok(e, JSON.stringify(log(m)));
  assert.strictEqual(e.sessionId, 'dead0000-1');
  assert.strictEqual(e.reason, 'ajuste de dead0000-1');
  assert.strictEqual(e.by, OWN);
});

test('T2 ClearOrphan_SesionViva_NoBorra: el proceso de la sesión existe', () => {
  const m = machine();
  const f = adhoc(m, 'live0000-1', 30);
  session(m, 'live0000-1', process.pid);
  const r = cli(m, ['adhoc', 'clear-orphan', 'live0000-1']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /viva/);
  assert.ok(fs.existsSync(f));
  assert.ok(log(m).some((x) => x.kind === 'ADHOC_CLEAR_ORPHAN_DENIED' && /viva/.test(x.motivo)));
});

test('T3 ClearOrphan_MenosDe24h_NoBorra: dice cuándo se podrá', () => {
  const m = machine();
  const f = adhoc(m, 'young000-1', 2);
  const r = cli(m, ['adhoc', 'clear-orphan', 'young000-1']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /después de las \d\d:\d\d/);
  assert.ok(fs.existsSync(f));
  assert.ok(log(m).some((x) => x.kind === 'ADHOC_CLEAR_ORPHAN_DENIED' && /24 h/.test(x.motivo)));
});

test('T4 ClearOrphan_SesionIlegible_NoBorra: no se puede descartar que sea la sesión', () => {
  const m = machine();
  const f = adhoc(m, 'dead0000-2', 30);
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', 'rota.json'), '{ no es json');
  const r = cli(m, ['adhoc', 'clear-orphan', 'dead0000-2']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /rota\.json/);
  assert.ok(fs.existsSync(f));
  assert.ok(log(m).some((x) => x.kind === 'ADHOC_CLEAR_ORPHAN_DENIED' && /rota\.json/.test(x.motivo)));
});

test('T5 ClearOrphan_IdPropioOSinAdhoc_NoBorra', () => {
  const m = machine();
  const own = adhoc(m, OWN, 30);
  const r1 = cli(m, ['adhoc', 'clear-orphan', OWN]);
  assert.notStrictEqual(r1.status, 0);
  assert.match(r1.stderr, /adhoc clear/);
  assert.ok(fs.existsSync(own));
  const r2 = cli(m, ['adhoc', 'clear-orphan', 'nadie000-1']);
  assert.notStrictEqual(r2.status, 0);
  assert.match(r2.stderr, /no hay ad-hoc/);
  const denied = log(m).filter((x) => x.kind === 'ADHOC_CLEAR_ORPHAN_DENIED').map((x) => x.sessionId);
  assert.deepStrictEqual(denied.sort(), ['nadie000-1', OWN].sort(), 'las dos negativas quedan en adhoc.log');
});

test('T6 ClearSession_DiceLaVerdad: sin marcador no dice cleared', () => {
  const m = machine();
  const r1 = cli(m, ['clear-session', 'nomark00-1']);
  assert.strictEqual(r1.status, 1);
  assert.doesNotMatch(r1.stdout, /cleared/);
  assert.match(r1.stderr, /no había marcador/);
  const f = path.join(m.state, 'active', 'mark0000-1.json');
  fs.writeFileSync(f, JSON.stringify({ storyId: '1.1', sessionId: 'mark0000-1' }));
  const r2 = cli(m, ['clear-session', 'mark0000-1']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /cleared/);
  assert.ok(!fs.existsSync(f));
});

test('T9 Referencia_NombraClearOrphan: la referencia del pipeline y la tabla de comandos', () => {
  for (const f of [path.join(SCRIPTS, '..', 'SKILL.md'), path.join(ROOT, 'guides', 'workflow-orchestration.md')]) {
    if (!fs.existsSync(f)) { console.log(`⏭ ${f}: no está en este árbol — NO MEDIDO`); continue; }
    assert.match(fs.readFileSync(f, 'utf8'), /adhoc (set\|get\|clear\|)?clear-orphan/, f);
  }
});

test('T10 ClearOrphan_SinCarpetaDeSesiones_Borra: ninguna sesión de Claude en la máquina', () => {
  const m = machine();
  fs.rmSync(path.join(m.home, '.claude', 'sessions'), { recursive: true });
  const f = adhoc(m, 'dead0000-3', 30);
  const r = cli(m, ['adhoc', 'clear-orphan', 'dead0000-3']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(f));
});

test('T11 ClearOrphan_FechaDeRespaldo: lastTouch ilegible usa declaredAt; sin ninguna, la del archivo', () => {
  const m = machine();
  const f1 = path.join(m.state, 'adhoc', 'bad00000-1.json');
  fs.writeFileSync(f1, JSON.stringify({ reason: 'r', lastTouch: 'ayer', declaredAt: hoursAgo(30) }));
  assert.strictEqual(cli(m, ['adhoc', 'clear-orphan', 'bad00000-1']).status, 0);
  assert.ok(!fs.existsSync(f1), 'declaredAt de 30 h manda');
  const f2 = path.join(m.state, 'adhoc', 'bad00000-2.json');
  fs.writeFileSync(f2, JSON.stringify({ reason: 'r' }));
  const old = new Date(Date.now() - 30 * 3600 * 1000);
  fs.utimesSync(f2, old, old);
  assert.strictEqual(cli(m, ['adhoc', 'clear-orphan', 'bad00000-2']).status, 0);
  assert.ok(!fs.existsSync(f2), 'la fecha del archivo manda');
});

test('T12 ClearOrphan_BorradoFalla_LoDiceYDejaConstancia', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const m = machine();
  const f = adhoc(m, 'lock0000-1', 30);
  const dir = path.join(m.state, 'adhoc');
  fs.chmodSync(dir, 0o500);
  try {
    const r = cli(m, ['adhoc', 'clear-orphan', 'lock0000-1']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no pude borrar/);
    assert.ok(fs.existsSync(f));
    assert.ok(log(m).some((x) => x.kind === 'ADHOC_CLEAR_ORPHAN_DENIED' && /no pude borrar/.test(x.motivo)));
  } finally { fs.chmodSync(dir, 0o700); }
});

test('T14 ClearOrphan_RamasDeBorde: ad-hoc roto, pid ilegible y constancia que no queda', () => {
  const m = machine();
  // ad-hoc con JSON roto y archivo de 30 h: se borra, con el motivo «(ilegible)»
  const f1 = path.join(m.state, 'adhoc', 'roto0000-1.json');
  fs.writeFileSync(f1, '{ roto');
  const old = new Date(Date.now() - 30 * 3600 * 1000);
  fs.utimesSync(f1, old, old);
  assert.strictEqual(cli(m, ['adhoc', 'clear-orphan', 'roto0000-1']).status, 0);
  assert.ok(log(m).some((x) => x.kind === 'ADHOC_CLEAR_ORPHAN' && x.reason === '(ilegible)'));
  // archivo de sesión con pid ilegible: no se puede descartar que viva
  const f2 = adhoc(m, 'pidx0000-1', 30);
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', 'p.json'), JSON.stringify({ pid: 'abc', sessionId: 'pidx0000-1' }));
  const r2 = cli(m, ['adhoc', 'clear-orphan', 'pidx0000-1']);
  assert.notStrictEqual(r2.status, 0);
  assert.match(r2.stderr, /pid ilegible/);
  assert.ok(fs.existsSync(f2));
  // la constancia no se puede escribir (adhoc.log es una carpeta): se borra igual y se avisa
  const m2 = machine();
  const f3 = adhoc(m2, 'nolog000-1', 30);
  fs.mkdirSync(path.join(m2.state, 'adhoc.log'));
  const r3 = cli(m2, ['adhoc', 'clear-orphan', 'nolog000-1']);
  assert.strictEqual(r3.status, 0, r3.stderr);
  assert.ok(!fs.existsSync(f3));
  assert.match(r3.stderr, /no pude dejar la constancia/);
});

test('T15 ClearSession_BorradoFalla_LoDice', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const m = machine();
  const f = path.join(m.state, 'active', 'lock0000-2.json');
  fs.writeFileSync(f, JSON.stringify({ storyId: '1.1', sessionId: 'lock0000-2' }));
  fs.chmodSync(path.join(m.state, 'active'), 0o500);
  try {
    const r = cli(m, ['clear-session', 'lock0000-2']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no pude borrar/);
    assert.doesNotMatch(r.stdout, /cleared/);
    assert.ok(fs.existsSync(f));
  } finally { fs.chmodSync(path.join(m.state, 'active'), 0o700); }
});
