'use strict';
// stable-data: las horas de estas pruebas son relativas al reloj de quien las corre (turnos recién tomados o vencidos): no dependen del día ni del huso.
// heavy-turn.test.js — el turno de la suite completa (scripts/tools/heavy-turn.js): con coordinadora, una suite completa por
// vez en la máquina; la segunda no arranca y dice quién tiene el lugar. Sin coordinadora, nada cambia. Un turno de un
// proceso muerto se libera solo; el de otro no se suelta. Y el corredor de suites.json lo pide sólo sin acotar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HT = require(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'));
const RUNNER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'run-suites-json.js');
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { placePath } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const COORD = 'coord-sid-1';

/** Una máquina de juguete: HOME con la coordinadora designada y viva (este proceso), y el perfil con el rol. */
function toy({ designated = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-turn-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(state, { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  if (designated) fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'relay-designation', status: 'ok', sesion: COORD, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  const sess = (sid, name) => fs.writeFileSync(path.join(home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'busy', statusUpdatedAt: Date.now(), cwd: root }));
  sess(COORD, 'Coordinadora');
  sess('s-uma', 'Uma');
  return { root, home, arnes };
}
// El arnés instalado de esa máquina, con el perfil del equipo: lo que un clon de trabajo no trae.
function installed(m) {
  const dir = path.join(m.root, 'instalado');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh'), '');
  fs.writeFileSync(path.join(dir, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  fs.mkdirSync(path.dirname(placePath(m.home)), { recursive: true });
  fs.symlinkSync(dir, placePath(m.home));
}
// El entorno de quien corre desde un clon del público en esa máquina: sin ninguna variable del arnés.
function machineEnv(m) {
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home };
  for (const k of Object.keys(env)) if (/^TYCON_/.test(k) || k === 'CLAUDE_CODE_SESSION_ID') delete env[k];
  return env;
}
const POSIX = { skip: process.platform === 'win32' ? 'enlaces simbólicos y bash' : false };
// un proceso vivo que no es éste: el «otro» corredor
function otherProcess(t) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { c.kill('SIGKILL'); } catch { /* ya terminó */ } });
  return c.pid;
}

test('HT1 SuiteTurn_SecondFullSuite_StopsAndSaysWho — con el turno de otra sesión viva, la segunda no lo toma y dice quién', (t) => {
  const m = toy();
  const other = otherProcess(t);
  const a = HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: other, what: 'suites portables' });
  assert.deepStrictEqual([a.ok, a.taken], [true, true]);
  const b = HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 'otra' }, pid: process.pid, what: 'suites.json' });
  assert.strictEqual(b.ok, false);
  assert.match(b.message, /Ya corre una suite completa en esta máquina: Uma \(suites portables, desde las \d\d:\d\d\)/);
  assert.match(b.message, /pedile turno a la coordinadora/);
  // el mismo proceso lo vuelve a pedir: sigue siendo suyo
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: other }).ok, true);
  // soltar el de otro no hace nada; el propio, sí
  assert.strictEqual(HT.release({ home: m.home, pid: process.pid }), false);
  assert.ok(HT.holder({ home: m.home }));
  assert.strictEqual(HT.release({ home: m.home, pid: other }), true);
  assert.strictEqual(HT.holder({ home: m.home }), null);
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: process.pid }).taken, true);
});

test('HT2 SuiteTurn_DeadHolder_Frees — un turno cuyo proceso ya no vive se libera solo', () => {
  const m = toy();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: Number(dead), session: 'Vieja', what: 'x', at: Date.now() }));
  assert.strictEqual(HT.holder({ home: m.home }), null);
  const r = HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: process.pid });
  assert.deepStrictEqual([r.ok, r.taken], [true, true]);
});

test('HT3 SuiteTurn_NoCoordinator_NothingChanges — sin coordinadora designada, o apagado, no se toma ni se frena', (t) => {
  const m = toy({ designated: false });
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  assert.deepStrictEqual(HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: process.pid }), { ok: true, taken: false, message: null });
  const d = toy();
  fs.mkdirSync(path.dirname(HT.turnFile(d.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(d.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  assert.strictEqual(HT.take({ home: d.home, arnes: d.arnes, env: { TYCON_SUITE_TURN: '0' }, pid: process.pid }).ok, true);
});

test('HT4 SuiteTurn_FromAWorkingClone_ReadsTheInstalledProfile — el perfil está en el arnés instalado: la CLI de un clon igual frena', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const env = machineEnv(m);
  const cli = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const r = spawnSync(process.execPath, [cli, 'take', '--what', 'x', '--process', String(process.pid)], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, HT.BUSY_EXIT, r.stderr);
  assert.match(r.stderr, /Ya corre una suite completa en esta máquina: Uma/);
  assert.match(r.stderr, new RegExp(`release --process ${other}`), 'dice cómo destrabarla');
  spawnSync(process.execPath, [cli, 'release', '--process', String(process.pid)], { env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
  // sin el perfil instalado no hay rol: no se pide nada, y corre
  const sin = toy();
  fs.mkdirSync(path.dirname(HT.turnFile(sin.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(sin.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  assert.strictEqual(spawnSync(process.execPath, [cli, 'take', '--what', 'x', '--process', String(process.pid)], { env: machineEnv(sin), encoding: 'utf8' }).status, 0);
});

test('HT5 SuiteTurn_RunnerFullRunStops_ScopedRunPasses — el corredor sin acotar no corre con el turno ajeno; una sola suite, sí', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  // un repo de juguete con una suite y el módulo del turno de este árbol
  const repo = path.join(m.root, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/verde.test.js', requiere: ['x'] }] }));
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'verde.test.js'), 'process.exit(0)\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'tools', 'heavy-turn.js'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'))});\n`);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const env = { ...machineEnv(m), TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const out = path.join(m.root, 'resumen.json');
  const full = spawnSync(process.execPath, [RUNNER, repo, out], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(full.status, HT.BUSY_EXIT, `${full.stdout}\n${full.stderr}`);
  assert.match(full.stderr, /Ya corre una suite completa en esta máquina: Uma/);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).no_medido, /Uma/);
  const one = spawnSync(process.execPath, [RUNNER, repo, out, '--suite', 'tests/verde.test.js'], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(one.status, 0, `${one.stdout}\n${one.stderr}`);
  // sin el turno ajeno, la completa corre y al terminar lo suelta
  fs.unlinkSync(HT.turnFile(m.home));
  const ok = spawnSync(process.execPath, [RUNNER, repo, out], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.ok(!fs.existsSync(HT.turnFile(m.home)), 'al terminar soltó el turno');
});

test('HT6 SuiteTurn_PortablesFull_StopsForReal — las portables enteras, con el turno ajeno, no corren y dicen quién lo tiene', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'tests', 'portable-suites.test.sh')], { env: machineEnv(m), encoding: 'utf8', timeout: 60000, cwd: path.join(ROOT, 'scripts') });
  assert.strictEqual(r.status, HT.BUSY_EXIT, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ya corre una suite completa en esta máquina: Uma/);
  assert.match(r.stdout, /NO MEDIDO suites-portables/);
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
});

test('HT7 SuiteTurn_TakenAtOnce_OneOwner — varios procesos a la vez, con o sin un turno muerto: uno solo lo tiene', { timeout: 120000 }, async () => {
  const m = toy();
  const mod = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const env = { ...machineEnv(m), TYCON_SUITE_TURN: '1' };
  // cada uno espera la misma hora, intenta y dice si lo tomó. Sigue vivo hasta que probaron todos: si muere antes, otro
  // toma legítimamente un turno muerto y parecería un segundo dueño (con la máquina cargada, el arranque tarda).
  const racer = (at) => {
    const c = spawn(process.execPath, ['-e', `const H=require(${JSON.stringify(mod)});setTimeout(()=>{const r=H.take({what:'x'});process.stdout.write(r.ok&&r.taken?'1':'0');setInterval(()=>{},1000);},Math.max(0,${at}-Date.now()));`], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    return { c, said: new Promise((resolve) => c.stdout.once('data', (d) => resolve(String(d)))) };
  };
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  for (const withDead of [false, true]) {
    for (let round = 0; round < 6; round += 1) {
      fs.rmSync(HT.turnFile(m.home), { force: true });
      if (withDead) fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: dead, what: 'vieja', at: Date.now() }));
      const at = Date.now() + 350;
      const racers = Array.from({ length: 6 }, () => racer(at));
      const got = await Promise.all(racers.map((r) => r.said));
      for (const r of racers) r.c.kill('SIGKILL');
      assert.strictEqual(got.filter((g) => g === '1').length, 1, `${withDead ? 'con un turno muerto' : 'sin turno'}, ronda ${round}: ${got.join(',')}`);
    }
  }
  assert.deepStrictEqual(fs.readdirSync(path.dirname(HT.turnFile(m.home))).filter((f) => /\.(tmp|evict)$/.test(f)), [], 'no deja temporales');
});

test('HT5b SuiteTurn_GateSaysWait_NotRed — por el portón de verdad: con el turno ajeno sale 75, dice quién, y no deja un verde viejo', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const repo = path.join(m.root, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'tools'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/verde.test.js', requiere: ['x'] }] }));
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'verde.test.js'), 'process.exit(0)\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'tools', 'heavy-turn.js'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'))});\n`);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const gate = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'test-gate.sh');
  const env = { ...machineEnv(m), TYCON_SKILLS_DIR: path.join(ROOT, 'skills'), TYCON_GATE_ALL_SUITES: '1' };
  const r = spawnSync('bash', [gate, repo], { env, encoding: 'utf8', timeout: 90000, cwd: repo });
  assert.strictEqual(r.status, 75, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ya corre una suite completa en esta máquina: Uma/);
  assert.match(r.stderr, /otra sesión tiene el turno de la suite completa/);
  assert.ok(!fs.existsSync(path.join(repo, '.advisors', 'tests-result.json')), 'no queda un resultado que se lea como de esta corrida');
});

test('HT5c SuiteTurn_ClosedCoordinator_NoTurn_AndCliErrors — con la coordinadora cerrada no se pide; la línea de comandos dice lo que está mal', (t) => {
  const m = toy();
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', `${COORD}.json`), JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, sessionId: COORD, name: 'Coordinadora', nameSource: 'user', status: 'idle', statusUpdatedAt: Date.now(), cwd: m.root }));
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  assert.deepStrictEqual(HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: process.pid }), { ok: true, taken: false, message: null });
  const cli = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { env: machineEnv(m), encoding: 'utf8' });
  assert.strictEqual(run('take', '--process', 'abc').status, 2);
  assert.strictEqual(run('nada').status, 2);
  assert.match(run('holder').stdout, /Uma \(x, desde las/);
  assert.strictEqual(JSON.parse(run('holder', '--json').stdout).pid, other);
});

test('HT8 SuiteTurn_OlderThanThreeHours_Frees — una suite colgada no frena para siempre', (t) => {
  const m = toy();
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() - 3 * 3600000 - 1000 }));
  assert.strictEqual(HT.holder({ home: m.home }), null);
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: {}, pid: process.pid }).taken, true);
});
