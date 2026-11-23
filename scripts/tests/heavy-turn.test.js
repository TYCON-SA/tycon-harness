'use strict';
// stable-data: las horas de estas pruebas son relativas al reloj de quien las corre (turnos recién tomados o vencidos): no dependen del día ni del huso.
// heavy-turn.test.js — el turno de las ejecuciones grandes (scripts/tools/heavy-turn.js): con coordinadora, una por vez en
// la máquina; la segunda no arranca y dice quién tiene el lugar. Sin coordinadora, nada cambia. Un turno de un proceso
// muerto se libera solo; el de otro no se suelta. Y el corredor de suites.json lo pide según cuántas suites corren. Un
// portón acotado corre al lado de un pase en vuelo sólo si es chico, va uno solo y hay memoria libre.
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
// Un repo de juguete con `n` suites que nombran lib/x.js y el módulo del turno de este árbol.
function repoConSuites(m, n, nombran = n) {
  const repo = path.join(m.root, 'repo');
  const tests = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'tools'), { recursive: true });
  const rutas = Array.from({ length: n }, (_, i) => `tests/s${i}.test.js`);
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: rutas.map((ruta) => ({ raiz: 'arnes', ruta, requiere: ['x'] })) }));
  rutas.forEach((ruta, i) => fs.writeFileSync(path.join(repo, 'scripts', ruta), `${i < nombran ? '// lib/x.js\n' : ''}process.exit(0)\n`));
  fs.writeFileSync(path.join(repo, 'scripts', 'tools', 'heavy-turn.js'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'))});\n`);
  return { repo, primera: rutas[0] };
}
// Ejecución acotada: lo tocado se conoce, y todas las suites del repo de juguete lo nombran.
function acotada(m, repo, out, extra = []) {
  const touched = path.join(m.root, 'tocado.json');
  fs.writeFileSync(touched, JSON.stringify({ known: true, files: ['lib/x.js'], sources: {}, reason: null }));
  // con el tope de la máquina de fábrica (60) una acotada no llega a pedir turno: acá el tope va en 200
  return [RUNNER, repo, out, '--touched', touched, '--scoped-by-repo', 'la CI', '--max-suites', '200', ...extra];
}
const POSIX = { skip: process.platform === 'win32' ? 'enlaces simbólicos y bash' : false };
// Un solo turno, como antes de la 8.291: con el piso en 100 la segunda nunca entra, sea cual sea la memoria de la
// máquina. Lo usan las pruebas que miden «la segunda espera» con el turno de otro.
const ONE_TURN = { TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT: '100' };
// permisos de carpeta: sin efecto en Windows ni para root
const POSIX_PERMS = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false };
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
  const b = HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 'otra', ...ONE_TURN }, pid: process.pid, what: 'suites.json' });
  assert.strictEqual(b.ok, false);
  assert.match(b.message, /Ya corre una ejecución grande de pruebas en esta máquina: Uma \(suites portables, desde las \d\d:\d\d\)/);
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
  const env = { ...machineEnv(m), ...ONE_TURN };
  const cli = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const r = spawnSync(process.execPath, [cli, 'take', '--what', 'x', '--process', String(process.pid)], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, HT.BUSY_EXIT, r.stderr);
  assert.match(r.stderr, /Ya corre una ejecución grande de pruebas en esta máquina: Uma/);
  assert.match(r.stderr, new RegExp(`release --process ${other}`), 'dice cómo destrabarla');
  spawnSync(process.execPath, [cli, 'release', '--process', String(process.pid)], { env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
  // el árbol que arma el nocturno trae su propio perfil: desde ahí siempre hay rol, y este caso no se puede medir
  if (['team-profile.json', 'perfil-equipo.json'].some((f) => fs.existsSync(path.join(ROOT, f)))) return;
  // sin el perfil instalado la designada ordena igual, con el rol de fábrica: el turno se pide
  const sin = toy();
  fs.mkdirSync(path.dirname(HT.turnFile(sin.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(sin.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  const pide = spawnSync(process.execPath, [cli, 'take', '--what', 'x', '--process', String(process.pid)], { env: { ...machineEnv(sin), ...ONE_TURN }, encoding: 'utf8' });
  assert.strictEqual(pide.status, HT.BUSY_EXIT, pide.stderr);
  assert.match(pide.stderr, /pedile turno a la coordinadora/);
  // sin designada no hay a quién pedirle turno: corre
  const nadie = toy({ designated: false });
  fs.mkdirSync(path.dirname(HT.turnFile(nadie.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(nadie.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  assert.strictEqual(spawnSync(process.execPath, [cli, 'take', '--what', 'x', '--process', String(process.pid)], { env: machineEnv(nadie), encoding: 'utf8' }).status, 0);
});

test('HT5 Turno_GrandeSinAcotar_NoArrancaConElTurnoAjeno — sin acotar y grande no corre con el turno ajeno; una sola suite, sí', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo, primera } = repoConSuites(m, 100);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const out = path.join(m.root, 'resumen.json');
  const full = spawnSync(process.execPath, [RUNNER, repo, out], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(full.status, HT.BUSY_EXIT, `${full.stdout}\n${full.stderr}`);
  assert.match(full.stderr, /Ya corre una ejecución grande de pruebas en esta máquina: Uma/);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).no_medido, /Uma/);
  const one = spawnSync(process.execPath, [RUNNER, repo, out, '--suite', primera], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(one.status, 0, `${one.stdout}\n${one.stderr}`);
  // sin el turno ajeno, la grande corre y al terminar lo suelta
  fs.unlinkSync(HT.turnFile(m.home));
  const ok = spawnSync(process.execPath, [RUNNER, repo, out], { env, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.ok(!fs.existsSync(HT.turnFile(m.home)), 'al terminar soltó el turno');
});

// 🔴 mutación: pedirlo sólo sin acotar deja correr cientos de suites junto a otro portón, y eso satura la máquina.
test('HT5a Turno_AcotadaGrande_NoArrancaConElTurnoAjeno — acotada o no, con 100 suites no corre y dice quién', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo } = repoConSuites(m, 100);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: '279 suites de otro', at: Date.now() }));
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const out = path.join(m.root, 'resumen.json');
  const r = spawnSync(process.execPath, acotada(m, repo, out), { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, HT.BUSY_EXIT, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Uma \(279 suites de otro, desde las/);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).no_medido, /Uma/);
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
});

// 🔴 mutación: contar las declaradas en vez de las que corren frena una acotada chica porque el repo tiene muchas suites.
test('HT5g Turno_MuchasDeclaradasPocasPorCorrer_NoLoPide — las diferidas no cuentan', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo } = repoConSuites(m, 150, 5);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const out = path.join(m.root, 'resumen.json');
  const r = spawnSync(process.execPath, acotada(m, repo, out), { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).corridas, 5);
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
});

// 🔴 mutación: tragarse el error del módulo deja sin turno a una ejecución grande sin que nadie se entere.
test('HT5h Turno_ModuloQueNoCarga_LoDiceYCorre — no poder mirar el turno no frena, y se dice', POSIX, () => {
  const m = toy();
  installed(m);
  const { repo } = repoConSuites(m, 100);
  fs.writeFileSync(path.join(repo, 'scripts', 'tools', 'heavy-turn.js'), 'throw new Error("módulo roto");\n');
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const r = spawnSync(process.execPath, acotada(m, repo, path.join(m.root, 'resumen.json')), { env, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /no pude cargar el turno de las ejecuciones grandes \(módulo roto\): corro igual/);
});

// 🔴 mutación: bajar el corte frena una acotada chica que no satura la máquina.
test('HT5d Turno_AcotadaChica_CorreConElTurnoAjeno — con 99 suites corre', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo } = repoConSuites(m, 99);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const r = spawnSync(process.execPath, acotada(m, repo, path.join(m.root, 'resumen.json')), { env, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
});

// 🔴 mutación: no decir cuántas corren deja a `holder` y a la negativa sin el dato con que se decide esperar; no soltarlo frena a los demás.
test('HT5e Turno_AcotadaGrande_LoTomaYLoSuelta — mientras corre se ve con su cantidad; al terminar, nadie', POSIX, () => {
  const m = toy();
  installed(m);
  const { repo } = repoConSuites(m, 100);
  const cli = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  // una suite que anota quién tiene el turno mientras corre
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 's0.test.js'), `// lib/x.js\nconst r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(cli)}, 'holder'], { encoding: 'utf8' });\nrequire('fs').writeFileSync(${JSON.stringify(path.join(m.root, 'visto.txt'))}, r.stdout);\n`);
  const env = { ...machineEnv(m), TYCON_SKILLS_DIR: path.join(ROOT, 'skills'), CLAUDE_CODE_SESSION_ID: 's-uma' };
  const r = spawnSync(process.execPath, acotada(m, repo, path.join(m.root, 'resumen.json')), { env, encoding: 'utf8', timeout: 120000, cwd: repo });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(fs.readFileSync(path.join(m.root, 'visto.txt'), 'utf8'), /Uma \(100 suites de repo, desde las/);
  assert.ok(!fs.existsSync(HT.turnFile(m.home)), 'al terminar soltó el turno');
});

// 🔴 mutación: seguir pidiéndolo por «sin acotar» frena una liviana de tres suites porque otra sesión corre algo grande.
test('HT5f Turno_LivianaDePocas_NoLoPide — sin acotar, con pocas suites por correr, no lo pide', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo } = repoConSuites(m, 3);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'x', at: Date.now() }));
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills') };
  const r = spawnSync(process.execPath, [RUNNER, repo, path.join(m.root, 'resumen.json')], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('HT6 SuiteTurn_PortablesFull_StopsForReal — las portables enteras, con el turno ajeno, no corren y dicen quién lo tiene', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'tests', 'portable-suites.test.sh')], { env: { ...machineEnv(m), ...ONE_TURN }, encoding: 'utf8', timeout: 60000, cwd: path.join(ROOT, 'scripts') });
  assert.strictEqual(r.status, HT.BUSY_EXIT, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ya corre una ejecución grande de pruebas en esta máquina: Uma/);
  assert.match(r.stdout, /NO MEDIDO suites-portables/);
  assert.strictEqual(JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8')).pid, other, 'el turno ajeno sigue');
});

test('HT7 SuiteTurn_TakenAtOnce_OneOwner — varios procesos a la vez, con o sin un turno muerto: uno solo lo tiene', { timeout: 120000 }, async () => {
  const m = toy();
  const mod = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SUITE_TURN: '1' };
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

test('HT5b Turno_PortonGrande_Sale75 — por el portón de verdad: con el turno ajeno sale 75, dice quién, y no deja un verde viejo', POSIX, (t) => {
  const m = toy();
  installed(m);
  const other = otherProcess(t);
  const { repo } = repoConSuites(m, 100);
  spawnSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.dirname(HT.turnFile(m.home)), { recursive: true });
  fs.writeFileSync(HT.turnFile(m.home), JSON.stringify({ pid: other, session: 'Uma', what: 'suites portables', at: Date.now() }));
  const gate = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'test-gate.sh');
  const env = { ...machineEnv(m), ...ONE_TURN, TYCON_SKILLS_DIR: path.join(ROOT, 'skills'), TYCON_GATE_ALL_SUITES: '1' };
  const r = spawnSync('bash', [gate, repo], { env, encoding: 'utf8', timeout: 90000, cwd: repo });
  assert.strictEqual(r.status, 75, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ya corre una ejecución grande de pruebas en esta máquina: Uma/);
  assert.match(r.stderr, /otra sesión tiene el turno de las ejecuciones grandes/);
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

test('HT9 Take_ClearsTheNotedWait — al tomar el turno de la suite, la espera anotada de esa sesión se borra sola', (t) => {
  const m = toy();
  const doing = path.join(stateDir(m.home), 'doing');
  fs.mkdirSync(doing, { recursive: true });
  const at = new Date(Date.now() - 600000).toISOString();
  fs.writeFileSync(path.join(doing, 's-uma.json'), JSON.stringify({ at, waitingFor: 'turno de suite (N.º 2)', waitingSince: at }));
  fs.writeFileSync(path.join(doing, 's-ana.json'), JSON.stringify({ at, waitingFor: 'turno de suite (N.º 3)', waitingSince: at }));
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, what: 'suite' }).taken, true);
  assert.ok(!fs.existsSync(path.join(doing, 's-uma.json')), 'la espera de quien toma el turno ya no está');
  assert.ok(fs.existsSync(path.join(doing, 's-ana.json')), 'la de otra sesión no se toca');
  HT.release({ home: m.home, pid: process.pid });
  // con texto propio, la nota queda y sólo se va la espera
  fs.writeFileSync(path.join(doing, 's-uma.json'), JSON.stringify({ text: 'mido el banco de controles', at, waitingFor: 'turno de suite', waitingSince: at }));
  HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, what: 'suite' });
  const note = JSON.parse(fs.readFileSync(path.join(doing, 's-uma.json'), 'utf8'));
  assert.strictEqual(note.text, 'mido el banco de controles');
  assert.strictEqual(note.waitingFor, undefined);
  assert.strictEqual(note.waitingSince, undefined);
  HT.release({ home: m.home, pid: process.pid });
});

// ── The adversarial pass holds the same turn: its probes run on the machine ──────────────────────────────────────

// A session file of the toy machine; alive with this process's pid unless another one is given.
function addSession(m, sid, name, pid = process.pid) {
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid, sessionId: sid, name, nameSource: 'user', status: 'busy', statusUpdatedAt: Date.now(), cwd: m.root }));
}
// The run marker of a session with its pass launched `minutesAgo` minutes ago; `extra` adds the result fields.
function passMarker(m, sid, storyId, minutesAgo, extra = {}) {
  const dir = path.join(stateDir(m.home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ sessionId: sid, storyId, adversarial: { launchedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), runId: 'wf_x' }, ...extra }));
}
const result = (minutesAgo, veredicto) => ({ ts: new Date(Date.now() - minutesAgo * 60000).toISOString(), tipo: '5b', veredicto });
const takeAs = (m, sid, extra = {}) => HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: sid }, pid: process.pid, what: '100 suites de repo', ...extra });

// 🔴 mutación: mirar sólo las suites deja correr una grande al lado del pase, que es lo que agotó la memoria.
test('HT10 HeavyTurn_AdversarialInFlight_FullSuiteWaits @story-8.228 @ac-1 — con un pase de otra sesión en vuelo, la grande no arranca y dice de quién', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const r = takeAs(m, 's-uma');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.holder.kind, 'pass');
  assert.match(r.message, /pase adversarial de la 7\.7 \(Ana, desde las \d\d:\d\d\)/);
  assert.ok(!fs.existsSync(HT.turnFile(m.home)), 'no publicó el turno');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'take', '--process', String(process.pid), '--what', 'x'], { env: { ...machineEnv(m), TYCON_SUITE_TURN: '1', CLAUDE_CODE_SESSION_ID: 's-uma' }, encoding: 'utf8' });
  assert.strictEqual(cli.status, HT.BUSY_EXIT, cli.stderr);
  assert.match(cli.stderr, /pase adversarial de la 7\.7/);
});

// 🔴 mutación: excluir la sesión propia (como entre dos pases) deja a un re-loop correr sus vecinas al lado de su pase.
test('HT11 HeavyTurn_OwnSessionPass_AlsoCounts @story-8.228 @ac-1 — el pase de la misma sesión también frena: el turno es de la máquina', () => {
  const m = toy();
  passMarker(m, 's-uma', '7.7', 5);
  const r = takeAs(m, 's-uma');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /pase adversarial de la 7\.7 \(Uma/);
});

// 🔴 mutación: mirar `deepReviewDone` en vez del resultado posterior al lanzamiento deja trabado el turno con un no-medido.
test('HT12 HeavyTurn_PassResultNoted_TurnFree @story-8.228 @ac-3 — con su resultado anotado el turno queda libre; relanzado, vuelve a frenar', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 30, { adversarialPasses: [result(2, 'listo')], deepReviewDone: true });
  assert.strictEqual(takeAs(m, 's-uma').taken, true, 'medido');
  HT.release({ home: m.home, pid: process.pid });
  passMarker(m, 's-ana', '7.7', 30, { adversarialPasses: [result(2, 'no-medido')], deepReviewDone: false });
  assert.strictEqual(takeAs(m, 's-uma').taken, true, 'no-medido: su workflow ya terminó');
  HT.release({ home: m.home, pid: process.pid });
  passMarker(m, 's-ana', '7.7', 1, { adversarialPasses: [result(2, 'no-medido')], deepReviewDone: false });
  assert.strictEqual(takeAs(m, 's-uma').ok, false, 'relanzado después del no-medido');
});

// The run record Claude Code leaves for the pass's Workflow, in the folder of the session that launched it.
function workflowRecord(m, sid, status) {
  const dir = path.join(m.home, '.claude', 'projects', '-repo', sid, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wf_x.json'), JSON.stringify({ runId: 'wf_x', status }));
}

// 🔴 mutación: soltar el pase por cualquier registro deja correr una grande al lado de un pase que todavía corre.
test('HT12b HeavyTurn_FinishedPassWithoutResult_TurnFree @story-8.277 @ac-10 @ac-12 — un pase con su Workflow terminado y sin resultado anotado no frena la grande, de otra sesión ni de la propia; uno corriendo, sí', () => {
  for (const [owner, name] of [['s-ana', 'Ana'], ['s-uma', 'Uma']]) {
    const m = toy();
    if (owner !== 's-uma') addSession(m, owner, name);
    passMarker(m, owner, '7.7', 5);
    workflowRecord(m, owner, 'running');
    assert.strictEqual(takeAs(m, 's-uma').ok, false, `${name}: corriendo, frena`);
    workflowRecord(m, owner, 'completed');
    sinFila(m, 's-uma');
    assert.strictEqual(takeAs(m, 's-uma').taken, true, `${name}: terminado, libre`);
    HT.release({ home: m.home, pid: process.pid });
  }
});

// 🔴 mutación: sin el tope de la hora, un pase colgado traba las suites para siempre; sin mirar la sesión, uno abandonado.
test('HT13 HeavyTurn_StaleOrDeadPass_DoesNotBlock @story-8.228 @ac-6 — un pase de más de una hora o de una sesión cerrada no frena', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 61);
  const r = takeAs(m, 's-uma');
  assert.strictEqual(r.taken, true);
  assert.match(r.note, /hace más de una hora.*no frena/);
  HT.release({ home: m.home, pid: process.pid });
  addSession(m, 's-ana', 'Ana', spawnSync(process.execPath, ['-e', '']).pid);
  passMarker(m, 's-ana', '7.7', 5);
  const dead = takeAs(m, 's-uma');
  assert.strictEqual(dead.taken, true);
  assert.strictEqual(dead.note, null);
  HT.release({ home: m.home, pid: process.pid });
});

// 🔴 mutación: tragarse el error de lectura deja correr la grande sin que nadie sepa que no se miró.
test('HT14 HeavyTurn_MarkersUnreadable_RunsAndSays @story-8.228 @ac-7 — sin poder leer los marcadores corre igual y lo dice', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false }, (t) => {
  const m = toy();
  const dir = path.join(stateDir(m.home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o000);
  t.after(() => fs.chmodSync(dir, 0o700));
  const r = takeAs(m, 's-uma');
  assert.strictEqual(r.taken, true);
  assert.match(r.note, /no pude ver si hay un pase en vuelo: /);
  HT.release({ home: m.home, pid: process.pid });
});

// 🔴 mutación: mirar el pase antes que la coordinadora frena en la CI y en la nube.
test('HT15 HeavyTurn_NoCoordinator_PassIgnored @story-8.228 @ac-8 — sin coordinadora, o apagado, un pase en vuelo no cambia nada', () => {
  const m = toy({ designated: false });
  passMarker(m, 's-uma', '7.7', 5);
  assert.deepStrictEqual(takeAs(m, 's-uma'), { ok: true, taken: false, message: null });
  const off = toy();
  passMarker(off, 's-uma', '7.7', 5);
  assert.deepStrictEqual(takeAs(off, 's-uma', { env: { CLAUDE_CODE_SESSION_ID: 's-uma', TYCON_SUITE_TURN: '0' } }), { ok: true, taken: false, message: null });
});

// 🔴 mutación: contar en la duda como viva a una sesión sin archivo frena las suites hasta una hora por un archivo roto ajeno.
test('HT17 HeavyTurn_UnsureIfAlive_DoesNotBlockAndSays @story-8.228 @ac-7 — con un archivo de sesión ilegible, el pase de una sesión sin archivo no frena la suite, y se dice', () => {
  const m = toy();
  fs.writeFileSync(path.join(m.home, '.claude', 'sessions', 'rota.json'), '{}');
  passMarker(m, 's-sin-archivo', '9.9', 1);
  const r = takeAs(m, 's-uma');
  assert.strictEqual(r.taken, true, r.message || '');
  assert.match(r.note, /no sé si vive la sesión del pase de la 9\.9.*no frena/);
  HT.release({ home: m.home, pid: process.pid });
  // con una sesión que sí se sabe viva, frena igual
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  assert.strictEqual(takeAs(m, 's-uma').ok, false);
});

test('HT16 Guides_HeavyTurn_SuiteAndPassNotTogether @story-8.228 @ac-5 — las dos guías dicen que no van juntos, por qué y cómo se libera cada turno', () => {
  const section = (file, heading) => {
    const text = fs.readFileSync(path.join(ROOT, 'guides', file), 'utf8');
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `${file}: falta «${heading}»`);
    const end = text.indexOf('\n## ', start + 1);
    // el corte de renglón de la guía no cambia lo que dice
    return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  };
  const es = section('coordination.md', '## Lo pesado, con turno');
  assert.doesNotMatch(es, /corren en la nube|pueden ir juntos|puede correr a la vez \*\*una suite completa y un pase/);
  assert.match(es, /sondas/);
  for (const k of ['mark-adversarial-result', 'mark-adversarial-skipped', 'tres horas']) assert.ok(es.includes(k), `es: ${k}`);
  const en = section('coordination.en.md', '## Heavy work takes turns');
  assert.doesNotMatch(en, /run in the cloud|can run at the same time \*\*one full suite and one adversarial pass/);
  assert.match(en, /probes/);
  for (const k of ['mark-adversarial-result', 'mark-adversarial-skipped', 'three hours']) assert.ok(en.includes(k), `en: ${k}`);
});

// ── El portón acotado al lado del pase (8.286) ────────────────────────────────────────────────────────────────────

// El registro de un portón que corre sin turno, como lo deja gateStarted, de un proceso vivo.
function gateOf(m, pid, fields) {
  const dir = path.join(stateDir(m.home), 'coordination', 'gates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sid: 's-ana', session: 'Ana', what: `${fields.suites} suites de repo`, at: Date.now() - 60000, ...fields }));
}
const memory = (pct) => { const r = () => { r.calls += 1; return { pct, why: null }; }; r.calls = 0; return r; };
const besideAs = (m, suites, readMemory, extra = {}) => HT.besidePass({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, suites, readMemory, ...extra });
// la salida de errores de una llamada, sin ensuciar la de la prueba
function said(fn) {
  const out = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  try { return { r: fn(), text: out.join('') }; } finally { process.stderr.write = write; }
}

// 🔴 mutación: frenar todo portón con un pase en vuelo (como hoy la guía) deja la sesión parada por unas pocas suites.
test('HT18 BesidePass_SmallGate_Runs @story-8.286 @ac-1 — con un pase en vuelo, un portón de 40 suites corre y se anota con cuántas', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const r = besideAs(m, 40, memory(60));
  assert.strictEqual(r.ok, true, r.message);
  assert.ok(r.pass, 'dice que hay un pase al lado');
  const g = HT.gateStarted({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, what: '40 suites de repo', suites: 40 });
  assert.ok(g.file, g.error);
  assert.strictEqual(JSON.parse(fs.readFileSync(g.file, 'utf8')).suites, 40);
});

// 🔴 mutación: comparar con el corte de 100 deja correr al lado del pase un portón que dura dos pases.
test('HT19 BesidePass_MediumGate_Waits @story-8.286 @ac-2 — con un pase en vuelo, uno de 41 suites espera y dice por qué', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const r = besideAs(m, 41, memory(90));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(HT.BUSY_EXIT, 77);
  assert.match(r.message, /pase adversarial de la 7\.7 \(Ana, desde las \d\d:\d\d\)/);
  assert.match(r.message, /41 suites/);
  assert.match(r.message, /40 suites o menos/);
  assert.match(r.message, /pedile turno a la coordinadora/);
});

// 🔴 mutación: no mirar los portones ya anotados deja dos al lado del pase.
test('HT20 BesidePass_SecondSmallGate_Waits @story-8.286 @ac-3 — al lado del pase va uno solo: el segundo dice cuál ya está', (t) => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  gateOf(m, otherProcess(t), { suites: 10, session: 'Bea' });
  const r = besideAs(m, 5, memory(90));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Bea \(10 suites, desde las \d\d:\d\d\)/);
  assert.match(r.message, /uno solo/);
  // 🔴 mutación: leer los portones sin juntar los problemas deja pasar callado lo que no se pudo ver (AC 14)
  const gates = path.join(stateDir(m.home), 'coordination', 'gates');
  fs.rmSync(gates, { recursive: true, force: true });
  fs.writeFileSync(gates, 'no es una carpeta');
  const { r: r2, text } = said(() => besideAs(m, 5, memory(90)));
  assert.strictEqual(r2.ok, true, 'no poder leer los portones no frena');
  assert.match(text, /no pude ver los portones en curso/);
  assert.match(said(() => HT.besideRecheck({ home: m.home, pid: process.pid })).text, /no pude ver los portones en curso/);
});

// 🔴 mutación: aplicar la regla sin pase en vuelo frena portones que hoy corren, y mira la memoria de más.
test('HT21 NoPass_GatesAsToday @story-8.286 @ac-4 — sin pase, los portones corren como hoy y la memoria no se mira', (t) => {
  const m = toy();
  const mem = memory(5);
  assert.strictEqual(besideAs(m, 90, mem).ok, true);
  gateOf(m, otherProcess(t), { suites: 90 });
  assert.strictEqual(besideAs(m, 30, mem).ok, true);
  assert.strictEqual(mem.calls, 0, 'sin pase no se lee la memoria');
});

// 🔴 mutación: no mirar la memoria deja correr el portón con la máquina ya justa, que es lo que cerró sesiones.
test('HT22 BesidePass_LowMemory_Waits @story-8.286 @ac-9 — con poca memoria libre el portón espera y dice cuánta hay y el piso', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const r = besideAs(m, 5, memory(35));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /35 %/);
  assert.match(r.message, /40 %/);
});

// 🔴 mutación: tratar «no pude medir» como poca memoria frena para siempre donde no se puede medir (Windows).
test('HT23 MemoryUnreadable_DoesNotBlockAndSays @story-8.286 @ac-10 — sin poder medir la memoria corre y lo dice', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const { r, text } = said(() => besideAs(m, 5, () => { throw new Error('sin comando'); }));
  assert.strictEqual(r.ok, true, r.message);
  assert.match(text, /no pude medir la memoria libre: sin comando/);
  const { r: r2, text: t2 } = said(() => besideAs(m, 5, () => ({ pct: null, why: 'no hay número' })));
  assert.strictEqual(r2.ok, true);
  assert.match(t2, /no pude medir la memoria libre: no hay número/);
});

// 🔴 mutación: leer `MemFree` en vez de `MemAvailable`, o el primer porcentaje de memory_pressure, mide de menos.
test('HT24 MemoryReader_ParsesPlatforms @story-8.286 @ac-9 @ac-10 — macOS y Linux dan el porcentaje; lo ilegible, null con el motivo', () => {
  const mac = HT.freeMemory({ platform: 'darwin', run: () => 'The system has 17179869184 (1048576 pages with a page size of 16384).\nPages free: 6117.\nSystem-wide memory free percentage: 66%\n' });
  assert.strictEqual(mac.pct, 66);
  const linux = HT.freeMemory({ platform: 'linux', readFile: () => 'MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    4000000 kB\n' });
  assert.strictEqual(linux.pct, 25);
  const garbage = HT.freeMemory({ platform: 'darwin', run: () => 'nada que leer' });
  assert.strictEqual(garbage.pct, null);
  assert.ok(garbage.why, 'dice por qué');
  const failed = HT.freeMemory({ platform: 'darwin', run: () => { throw new Error('ENOENT memory_pressure'); } });
  assert.strictEqual(failed.pct, null);
  assert.match(failed.why, /ENOENT/);
  assert.strictEqual(HT.freeMemory({ platform: 'win32' }).pct, null);
});

// 🔴 mutación: volver a mirar la memoria y cortar el portón ya arrancado deja corridas a medias sin resultado.
test('HT26 BesidePass_MemoryReadOnce_GateNotCut @story-8.286 @ac-11 — la memoria se mira una vez; si baja después, el portón sigue', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  let pct = 60;
  const mem = () => { mem.calls += 1; return { pct, why: null }; };
  mem.calls = 0;
  assert.strictEqual(besideAs(m, 5, mem).ok, true);
  HT.gateStarted({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, what: '5 suites de repo', suites: 5 });
  pct = 20;
  assert.strictEqual(HT.besideRecheck({ home: m.home, pid: process.pid }).ok, true);
  assert.deepStrictEqual(HT.gatesRunning({ home: m.home }).map((g) => g.pid), [process.pid]);
  assert.strictEqual(mem.calls, 1);
});

// 🔴 mutación: dejar pasar por memoria o por el corte nuevo una ejecución de 100 suites rompe la exclusión de la 8.228.
test('HT27 BesidePass_FullGate_StillExclusive @story-8.286 @ac-16 — una de 100 suites sigue esperando al pase, con memoria de sobra', () => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const r = takeAs(m, 's-uma', { readMemory: memory(90) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /pase adversarial de la 7\.7/);
});

// 🔴 mutación: sin la relectura, dos portones que arrancan a la vez quedan los dos al lado del pase.
test('HT28 BesidePass_TwoGatesAtOnce_OneRuns @story-8.286 @ac-3 — de dos anotados a la vez sigue el de menor proceso; el otro se baja', (t) => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const [a, b] = [otherProcess(t), otherProcess(t)].sort((x, y) => x - y);
  const at = Date.now() - 1000;
  gateOf(m, a, { suites: 5, session: 'Primera', at });
  gateOf(m, b, { suites: 5, session: 'Segunda', at });
  const lost = HT.besideRecheck({ home: m.home, pid: b });
  assert.strictEqual(lost.ok, false);
  assert.match(lost.message, /Primera \(5 suites/);
  assert.ok(!fs.existsSync(path.join(stateDir(m.home), 'coordination', 'gates', `${b}.json`)), 'el que pierde borra su registro');
  assert.strictEqual(HT.besideRecheck({ home: m.home, pid: a }).ok, true);
});

// 🔴 mutación: dejar la guía con «tampoco una de cada una» hace que la coordinadora siga frenando todo portón.
test('HT25 Guides_SmallGateBesidePass @story-8.286 @ac-13 — las guías y el paso de pruebas cuentan la regla del portón al lado del pase', () => {
  const flat = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
  const section = (text, heading) => { const s = text.indexOf(heading); assert.ok(s >= 0, `falta «${heading}»`); const e = text.indexOf(' ## ', s + 1); return text.slice(s, e < 0 ? undefined : e); };
  const esAll = flat('guides/coordination.md');
  const es = section(esAll, '## Lo pesado, con turno');
  for (const k of ['40 suites', 'uno por vez', 'memoria libre', 'portón completo']) assert.ok(es.includes(k), `es: ${k}`);
  assert.doesNotMatch(es, /tampoco una de cada una/);
  assert.doesNotMatch(esAll, /el examen de revisores y el portón corren de a uno/);
  const en = section(flat('guides/coordination.en.md'), '## Heavy work takes turns');
  for (const k of ['40 suites', 'one at a time', 'free memory', 'full gate']) assert.ok(en.includes(k), `en: ${k}`);
  const step = flat('skills/tycon-pipeline/steps/step-06-run-tests.md');
  assert.match(step, /pase adversarial en vuelo/);
  assert.match(step, /40 suites/);
});

// ── El segundo turno de ejecución grande, con la memoria libre en el piso (8.291) ───────────────────────────────────

// Un lugar del turno tomado por `pid`, escrito como lo publica `take`: el primero (0) o el segundo (1).
function slotOf(m, i, pid, fields = {}) {
  const file = HT.slotFiles(m.home)[i];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, sid: `s-${i}`, session: i ? 'Segunda' : 'Primera', what: '204 suites de repo', at: Date.now() - (2 - i) * 60000, ...fields }));
  return file;
}
const inForce = (m) => HT.holders({ home: m.home }).map((h) => h.pid);
const secondAs = (m, pid, readMemory, env = {}) => HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma', ...env }, pid, what: '204 suites de repo', readMemory });

// 🔴 mutación: no dar el segundo lugar (como antes), o darlo sin decir la memoria y el piso.
test('HT29 SecondTurn_FreeMemory_Takes @story-8.291 @ac-1 — con la memoria libre en el piso o arriba, la segunda toma el otro lugar', (t) => {
  const m = toy();
  const first = otherProcess(t);
  slotOf(m, 0, first);
  const doing = path.join(stateDir(m.home), 'doing');
  fs.mkdirSync(doing, { recursive: true });
  fs.writeFileSync(path.join(doing, 's-uma.json'), JSON.stringify({ at: new Date().toISOString(), waitingFor: 'turno de suite', waitingSince: new Date().toISOString() }));
  const mem = memory(62);
  const { r, text } = said(() => secondAs(m, process.pid, mem));
  assert.deepStrictEqual([r.ok, r.taken], [true, true], r.message);
  assert.deepStrictEqual(inForce(m), [first, process.pid]);
  assert.strictEqual(mem.calls, 1, 'la memoria se mide una vez');
  assert.match(text, /segunda ejecución grande: memoria libre 62 %, piso 50 %/);
  assert.ok(!fs.existsSync(path.join(doing, 's-uma.json')), 'la espera anotada de la sesión se borró');
  const mine = JSON.parse(fs.readFileSync(HT.slotFiles(m.home)[1], 'utf8'));
  assert.deepStrictEqual(Object.keys(mine).sort(), ['at', 'pid', 'session', 'sid', 'what']);
});

// 🔴 mutación: comparar al revés, o tomar el lugar igual con poca memoria (lo que cerró sesiones en la 8.228).
test('HT30 SecondTurn_LowMemory_Waits @story-8.291 @ac-2 — debajo del piso espera, dice la memoria, el piso, su origen y quién corre', (t) => {
  const m = toy();
  const first = otherProcess(t);
  slotOf(m, 0, first);
  const r = secondAs(m, process.pid, memory(41));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Ya corre una ejecución grande de pruebas en esta máquina: Primera \(204 suites de repo, desde las \d\d:\d\d\)/);
  assert.match(r.message, /41 %/);
  assert.match(r.message, /piso 50 %, de fábrica/);
  assert.match(r.message, new RegExp(`release --process ${first}`));
  assert.ok(!fs.existsSync(HT.slotFiles(m.home)[1]), 'no escribió el segundo lugar');
  // por la línea de comandos sale 77; el lector de memoria real no se puede inyectar ahí: el piso en 100 lo cierra igual
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'take', '--process', String(process.pid), '--what', 'x'], { env: { ...machineEnv(m), ...ONE_TURN, TYCON_SUITE_TURN: '1' }, encoding: 'utf8' });
  assert.strictEqual(cli.status, HT.BUSY_EXIT, cli.stderr);
});

// 🔴 mutación: tratar «no pude medir» como en besidePass (deja pasar): el segundo turno es un extra.
test('HT31 SecondTurn_MemoryUnreadable_Waits @story-8.291 @ac-3 — sin poder medir la memoria no se da el segundo turno', (t) => {
  const m = toy();
  slotOf(m, 0, otherProcess(t));
  for (const reader of [() => { throw new Error('sin comando'); }, () => ({ pct: null, why: 'memory_pressure no dio el porcentaje' })]) {
    const r = secondAs(m, process.pid, reader);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /no pude medir la memoria libre: (sin comando|memory_pressure no dio el porcentaje); sin medirla no se da el segundo turno/);
    assert.ok(!fs.existsSync(HT.slotFiles(m.home)[1]), 'nada escrito');
  }
});

// 🔴 mutación: un tercer lugar, o medir la memoria con los dos ocupados.
test('HT32 ThirdRun_Waits_NamesBoth_NoMemoryRead @story-8.291 @ac-4 — con dos corriendo, la tercera espera y nombra a las dos', (t) => {
  const m = toy();
  const [a, b] = [otherProcess(t), otherProcess(t)];
  slotOf(m, 0, a);
  slotOf(m, 1, b);
  const mem = memory(95);
  const r = secondAs(m, process.pid, mem);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Primera \(204 suites de repo/);
  assert.match(r.message, /Segunda \(204 suites de repo/);
  assert.match(r.message, new RegExp(`release --process ${a}`));
  assert.match(r.message, new RegExp(`release --process ${b}`));
  assert.strictEqual(mem.calls, 0, 'con dos corriendo la memoria no se mide');
});

// 🔴 mutación: publicar el segundo lugar sin link, o que quien pierde el primero quede segundo sin medir.
test('HT33 SecondTurn_TwoAtOnce_OneTakes @story-8.291 @ac-5 — dos piden el segundo lugar: lo toma uno; dos piden el primero con poca memoria: queda uno', (t) => {
  const m = toy();
  slotOf(m, 0, otherProcess(t));
  const [x, y] = [otherProcess(t), otherProcess(t)];
  const rx = secondAs(m, x, memory(70));
  const ry = secondAs(m, y, memory(70));
  assert.deepStrictEqual([rx.taken, ry.ok], [true, false]);
  assert.match(ry.message, /Primera \(204 suites/);
  assert.match(ry.message, /Segunda|204 suites de repo, desde/);
  assert.match(ry.message, new RegExp(`release --process ${x}`));
  // la máquina vacía y poca memoria: el que llega segundo encuentra el primer lugar recién publicado y mide
  const v = toy();
  const memA = memory(41);
  const memB = memory(41);
  const [p, q] = [otherProcess(t), otherProcess(t)];
  assert.strictEqual(secondAs(v, p, memA).taken, true);
  const lost = secondAs(v, q, memB);
  assert.strictEqual(lost.ok, false);
  assert.match(lost.message, /41 %/);
  assert.strictEqual(memA.calls, 0, 'el primero no mide');
  assert.strictEqual(memB.calls, 1, 'el que llega segundo mide');
  assert.deepStrictEqual(inForce(v), [p]);
});

// 🔴 mutación: decidir por qué archivo queda libre en vez de por cuántas corren.
test('HT34 FirstFree_SecondHeld_CountsAsSecond @story-8.291 @ac-6 — con sólo el segundo lugar tomado, la que llega cuenta como segunda', (t) => {
  const m = toy();
  const b = otherProcess(t);
  slotOf(m, 1, b);
  assert.strictEqual(secondAs(m, process.pid, memory(41)).ok, false);
  assert.ok(!fs.existsSync(HT.slotFiles(m.home)[0]), 'no tomó el primer archivo con poca memoria');
  const c = otherProcess(t);
  sinFila(m, 's-uma');
  assert.strictEqual(secondAs(m, c, memory(62)).taken, true);
  assert.deepStrictEqual(inForce(m).sort(), [b, c].sort());
});

// 🔴 mutación: que la memoria de sobra deje correr una grande al lado de un pase.
test('HT35 PassInFlight_NoTurnEvenWithMemory @story-8.291 @ac-7 — con un pase en vuelo no hay turno, haya una corriendo o no, y la memoria no se mide', (t) => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  passMarker(m, 's-ana', '7.7', 5);
  const mem = memory(90);
  const a = secondAs(m, process.pid, mem);
  assert.strictEqual(a.ok, false);
  assert.match(a.message, /pase adversarial de la 7\.7/);
  slotOf(m, 0, otherProcess(t));
  const b = secondAs(m, process.pid, mem);
  assert.strictEqual(b.ok, false);
  assert.match(b.message, /pase adversarial de la 7\.7/);
  assert.strictEqual(mem.calls, 0);
});

// 🔴 mutación: soltar el lugar ajeno, cortar la que corre si baja la memoria, o no vencer el segundo lugar muerto.
test('HT36 Release_OnlyOwnSlot_StaleFreed_NotCut @story-8.291 @ac-9 @ac-13 — se suelta sólo el propio; los muertos se van solos; la memoria baja y nadie se corta', (t) => {
  const m = toy();
  const [a, b] = [otherProcess(t), otherProcess(t)];
  assert.strictEqual(secondAs(m, a, memory(62)).taken, true);
  assert.strictEqual(secondAs(m, b, memory(62)).taken, true);
  const low = memory(20);
  assert.deepStrictEqual(inForce(m), [a, b]);
  assert.strictEqual(secondAs(m, process.pid, low).ok, false);
  assert.deepStrictEqual(inForce(m), [a, b], 'con 20 % siguen las dos');
  assert.strictEqual(HT.release({ home: m.home, pid: a }), true);
  assert.deepStrictEqual(inForce(m), [b]);
  assert.strictEqual(HT.release({ home: m.home, pid: process.pid }), false, 'no suelta lo que no es suyo');
  // un lugar de un proceso muerto y otro de hace más de tres horas se liberan solos al pedir el turno
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const v = toy();
  slotOf(v, 0, dead);
  slotOf(v, 1, otherProcess(t), { at: Date.now() - 3 * 3600000 - 1000 });
  const mem = memory(10);
  assert.strictEqual(secondAs(v, process.pid, mem).taken, true);
  assert.strictEqual(mem.calls, 0, 'vencidos los dos, es la primera');
  assert.deepStrictEqual(inForce(v), [process.pid]);
});

// 🔴 mutación: contar el propio lugar como otra ejecución (ocupa los dos y mide de más).
test('HT40 SamePid_Retake_NoSecondSlot @story-8.291 @ac-1 — quien ya tiene un lugar y lo vuelve a pedir no ocupa el otro', (t) => {
  const m = toy();
  const a = otherProcess(t);
  slotOf(m, 0, a);
  const mem = memory(62);
  assert.strictEqual(secondAs(m, a, mem).taken, true);
  assert.strictEqual(mem.calls, 0);
  assert.deepStrictEqual(inForce(m), [a]);
  assert.ok(!fs.existsSync(HT.slotFiles(m.home)[1]));
});

// 🔴 mutación: un piso fijo en el código, sin la configuración.
test('HT37 SecondTurn_FloorFromConfig @story-8.291 @ac-10 — el piso de la máquina y el de la variable mandan', (t) => {
  const m = toy();
  const { rutaMaquina } = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  fs.mkdirSync(path.dirname(rutaMaquina(m.home)), { recursive: true });
  fs.writeFileSync(rutaMaquina(m.home), JSON.stringify({ coordination: { second_heavy_min_free_pct: 70 } }));
  slotOf(m, 0, otherProcess(t));
  const r = secondAs(m, process.pid, memory(62));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /70 %/);
  assert.match(r.message, /máquina/);
  assert.deepStrictEqual(HT.secondTurnFloor({ home: m.home, env: {}, arnes: m.arnes }).value, 70);
  sinFila(m, 's-uma');
  assert.strictEqual(secondAs(m, process.pid, memory(62), { TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT: '60' }).taken, true);
});

// 🔴 mutación: dejar en las guías que la segunda nunca arranca, o no contar el piso y cómo se cambia.
test('HT38 Guides_SecondHeavyTurn @story-8.291 @ac-16 — las guías y el paso de pruebas cuentan el segundo turno', () => {
  const flat = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
  const section = (text, heading) => { const s = text.indexOf(heading); assert.ok(s >= 0, `falta «${heading}»`); const e = text.indexOf(' ## ', s + 1); return text.slice(s, e < 0 ? undefined : e); };
  const esAll = flat('guides/coordination.md');
  const es = section(esAll, '## Lo pesado, con turno');
  for (const k of ['dos ejecuciones grandes', '50 %', 'coordination.second_heavy_min_free_pct', 'sin poder medirla, una', 'nunca al lado del pase', 'no se corta']) assert.ok(es.includes(k), `es: ${k}`);
  assert.doesNotMatch(esAll, /La segunda ejecución grande no arranca/);
  assert.doesNotMatch(esAll, /el portón completo corre de a uno/);
  const en = section(flat('guides/coordination.en.md'), '## Heavy work takes turns');
  for (const k of ['two large runs', '50 %', 'coordination.second_heavy_min_free_pct', 'cannot be measured, one', 'never beside the pass', 'is not cut']) assert.ok(en.includes(k), `en: ${k}`);
  assert.doesNotMatch(en, /The second large run does not start/);
  const step = flat('skills/tycon-pipeline/steps/step-06-run-tests.md');
  assert.match(step, /ya corren dos/);
  assert.match(step, /la memoria no alcanza para la segunda/);
  assert.match(step, /50 %/, 'el paso de pruebas dice el piso');
});

// 🔴 mutación: mover el primer lugar de archivo o de formato, o repetir el 50 como número suelto.
test('HT39 FirstSlot_FormatAndHolder_Unchanged @story-8.291 @ac-17 — el primer lugar, holder y holder --json como antes; el 50 vive en un solo lugar', (t) => {
  const m = toy();
  assert.strictEqual(HT.slotFiles(m.home)[0], HT.turnFile(m.home));
  assert.strictEqual(path.basename(HT.turnFile(m.home)), 'suite-turn.json');
  const a = otherProcess(t);
  assert.strictEqual(secondAs(m, a, memory(62)).taken, true);
  const first = JSON.parse(fs.readFileSync(HT.turnFile(m.home), 'utf8'));
  assert.deepStrictEqual(Object.keys(first).sort(), ['at', 'pid', 'session', 'sid', 'what']);
  // la segunda, un segundo después: en el mismo milisegundo la más vieja se desempata por el proceso menor
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: process.pid, what: '204 suites de repo', readMemory: memory(62), now: first.at + 1000 }).taken, true);
  assert.strictEqual(HT.holder({ home: m.home }).pid, a, 'holder es la más vieja');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'holder', '--json'], { env: machineEnv(m), encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(cli.stdout), first);
  const both = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'holders', '--json'], { env: machineEnv(m), encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(both.stdout).map((h) => h.pid), [a, process.pid]);
  assert.strictEqual(HT.SECOND_HEAVY_MIN_FREE_PCT, 50);
  // el código sin sus comentarios: un 50 en un comentario no es un número suelto
  const code = (file) => fs.readFileSync(path.join(ROOT, 'scripts', 'tools', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.deepStrictEqual(code('heavy-turn.js').match(/\b50\b/g), ['50'], 'un solo 50 en el código de heavy-turn.js: la constante');
  assert.match(code('heavy-turn.js'), /const SECOND_HEAVY_MIN_FREE_PCT = 50;/);
  assert.doesNotMatch(code('coordination.js'), /(second_heavy_min_free_pct|minFreePct|secondTurn)[^\n]*\b50\b/);
});

// 🔴 mutación: buscar el error del piso sólo por la clave con punto: un valor malo puesto por variable se ignora callado.
test('HT41 SecondTurnFloor_BadEnvValue_SaysSo @story-8.291 @ac-10 @ac-14 — un piso inválido por variable cae al de fábrica y lo dice', (t) => {
  const m = toy();
  for (const bad of ['abc', '0', '101']) {
    const f = HT.secondTurnFloor({ home: m.home, env: { TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT: bad }, arnes: m.arnes });
    assert.deepStrictEqual([f.value, f.origin], [HT.SECOND_HEAVY_MIN_FREE_PCT, 'sin-valor'], bad);
    assert.match(String(f.problem), /TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT/, `${bad}: dice qué valor no vale`);
  }
  // al decidir el segundo turno, el aviso sale por la salida de errores
  slotOf(m, 0, otherProcess(t));
  const { text } = said(() => secondAs(m, process.pid, memory(62), { TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT: 'abc' }));
  assert.match(text, /uso el piso de fábrica/);
});

// 🔴 mutación: tragar cualquier error al soltar el lugar: uno que no se pudo borrar quedaría tomado hasta tres horas, callado.
test('HT42 Release_CannotDelete_SaysSo @story-8.291 @ac-9 — si el lugar propio no se puede borrar, se dice', POSIX_PERMS, () => {
  const m = toy();
  const file = slotOf(m, 1, process.pid);
  const dir = path.dirname(file);
  fs.chmodSync(dir, 0o555);
  try {
    const { r, text } = said(() => HT.release({ home: m.home, pid: process.pid }));
    assert.strictEqual(r, false);
    assert.match(text, /no pude soltar el lugar del turno .*suite-turn-2\.json/);
  } finally { fs.chmodSync(dir, 0o755); }
  assert.strictEqual(HT.release({ home: m.home, pid: process.pid }), true);
});

// 🔴 mutación: que la línea de comandos no mida la memoria de verdad, o no publique el segundo lugar. Con el piso en 1 %
// la memoria real de cualquier máquina que la mide lo pasa: la prueba no depende de cuánta haya.
test('HT43 Cli_SecondTurn_RealMemory @story-8.291 @ac-1 @ac-2 @ac-9 — por la línea de comandos, con la memoria real: la segunda entra con piso 1 y espera con piso 100', { skip: ['darwin', 'linux'].includes(process.platform) ? false : 'la memoria se mide en macOS y Linux' }, (t) => {
  const m = toy();
  const first = otherProcess(t);
  slotOf(m, 0, first);
  const cli = path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js');
  const env = (floor) => ({ ...machineEnv(m), TYCON_SUITE_TURN: '1', TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT: floor });
  const closed = spawnSync(process.execPath, [cli, 'take', '--process', String(process.pid), '--what', 'x'], { env: env('100'), encoding: 'utf8' });
  assert.strictEqual(closed.status, HT.BUSY_EXIT, closed.stderr);
  assert.match(closed.stderr, /memoria libre en el piso o arriba, y está en \d+ % \(piso 100 %, de una variable\)/);
  const open = spawnSync(process.execPath, [cli, 'take', '--process', String(process.pid), '--what', 'x'], { env: env('1'), encoding: 'utf8' });
  assert.strictEqual(open.status, 0, open.stderr);
  assert.match(open.stderr, /segunda ejecución grande: memoria libre \d+ %, piso 1 %, de una variable/);
  assert.deepStrictEqual(inForce(m), [first, process.pid]);
  spawnSync(process.execPath, [cli, 'release', '--process', String(process.pid)], { env: env('1'), encoding: 'utf8' });
  assert.deepStrictEqual(inForce(m), [first], 'soltó sólo el suyo');
});

// Quién corre una prueba pesada según el registro de turnos, para que la espera de turno de esa sesión pierda contra él:
// la fila de la coordinadora y /wip lo leen. Sólo los registros vivos; lo que no se lee se dice.
// 🔴 mutación: aceptar la espera de un pase, contar un portón de un proceso muerto o un turno vencido, o callar uno roto.
test('HT44 RunningSids_SoloLosVivos_YLaEsperaDeTurno: los vivos cuentan, los muertos y vencidos no, el ilegible se dice; la espera de un pase no es de turno', () => {
  assert.strictEqual(HT.isTurnWait('portón final de pruebas de la 9.9'), true);
  assert.strictEqual(HT.isTurnWait('el turno de la suite'), true);
  assert.strictEqual(HT.isTurnWait('el turno del pase adversarial'), false, 'la espera de un pase no es de este registro');
  assert.strictEqual(HT.isTurnWait('la firma del dueño'), false);
  assert.strictEqual(HT.isTurnWait(undefined), false);
  const state = stateDir(toy().home);
  const gates = path.join(state, 'coordination', 'gates');
  fs.mkdirSync(gates, { recursive: true });
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const now = Date.now();
  fs.writeFileSync(path.join(gates, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sid: 's-viva', at: now }));
  fs.writeFileSync(path.join(gates, `${dead}.json`), JSON.stringify({ pid: dead, sid: 's-muerta', at: now }));
  fs.writeFileSync(path.join(gates, `${process.ppid}.json`), '{ esto no es json');
  fs.writeFileSync(path.join(state, 'coordination', 'suite-turn.json'), JSON.stringify({ pid: process.pid, sid: 's-vencida', at: now - 4 * 3600000 }));
  fs.writeFileSync(path.join(state, 'coordination', 'suite-turn-2.json'), JSON.stringify({ pid: process.pid, sid: 's-turno', at: now }));
  const problems = [];
  assert.deepStrictEqual([...HT.runningSids({ state, now, problems })].sort(), ['s-turno', 's-viva']);
  assert.ok(problems.some((p) => p.includes(`${process.ppid}.json`)), `el portón ilegible se dice: ${JSON.stringify(problems)}`);
  assert.deepStrictEqual([...HT.runningSids({ state: path.join(state, 'no-existe'), now })], [], 'sin registro, nadie');
});

// ── El turno no se toma solo con coordinadora: el «arrancá» y la reserva ─────────────────────────────────────────────

const coordFile = (m, name) => path.join(stateDir(m.home), 'coordination', name);
const waitFile = (m, sid) => path.join(stateDir(m.home), 'coordination', 'suite-waits', `${sid}.json`);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const asSid = (m, sid, extra = {}) => HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: sid, ...ONE_TURN }, pid: process.pid, what: '120 suites de repo', ...extra });
const grantAs = (m, by, to, extra = {}) => HT.grant({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: by }, to, ...extra });
// La sesión sale de la fila, como si la coordinadora le hubiera dado el «arrancá»: lo usan las pruebas que reintentan
// con la misma sesión después de un 77 y miden otra cosa (el pase, los lugares, el piso).
function sinFila(m, sid) { fs.rmSync(path.join(stateDir(m.home), 'coordination', 'suite-waits', `${sid}.json`), { force: true }); }

// 🔴 mutación: tomar el turno libre en el próximo intento (como hoy) se superpone con lo que la coordinadora ya lanzó.
test('Turno_ConCoordinadora_EsperaElArranca (T10) @story-8.274 @ac-12 @ac-14', (t) => {
  const m = toy();
  addSession(m, 's-ana', 'Ana');
  addSession(m, 's-bea', 'Bea');
  const other = otherProcess(t);
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: other, what: 'portables' }).taken, true);
  // Ana recibe 77 y queda anotada
  assert.strictEqual(asSid(m, 's-ana').ok, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(waitFile(m, 's-ana'), 'utf8')).sid, 's-ana');
  HT.release({ home: m.home, pid: other });
  // con el turno libre, no lo toma sola: espera el «arrancá»
  const sola = asSid(m, 's-ana');
  assert.deepStrictEqual([sola.ok, sola.taken], [false, false]);
  assert.match(sola.message, /esperá el «arrancá» de la coordinadora/i);
  assert.match(sola.message, /heavy-turn\.js grant --to s-ana/);
  assert.strictEqual(HT.holder({ home: m.home }), null);
  // el «arrancá» lo da sólo la coordinadora
  assert.strictEqual(grantAs(m, 's-bea', 's-ana').ok, false);
  assert.ok(!fs.existsSync(coordFile(m, 'suite-grant.json')));
  // un «arrancá» vigente a nombre de Ana frena a quien no estaba anotada
  assert.strictEqual(grantAs(m, COORD, 'Ana').ok, true, 'se puede dar por nombre');
  const bea = asSid(m, 's-bea');
  assert.strictEqual(bea.ok, false);
  assert.match(bea.message, /le dio el «arrancá» a Ana/);
  assert.ok(fs.existsSync(waitFile(m, 's-bea')), 'su 77 la anota en la fila');
  fs.rmSync(waitFile(m, 's-bea'));
  // con su «arrancá», Ana lo toma, y se borran el «arrancá» y su anotación
  assert.strictEqual(asSid(m, 's-ana').taken, true);
  assert.ok(!fs.existsSync(coordFile(m, 'suite-grant.json')));
  assert.ok(!fs.existsSync(waitFile(m, 's-ana')));
  HT.release({ home: m.home, pid: process.pid });
  // un «arrancá» a una sesión muerta, o a una viva que no lo tomó en 10 minutos, vence: no frena a nadie
  fs.writeFileSync(coordFile(m, 'suite-grant.json'), JSON.stringify({ to: 's-muerta', by: COORD, at: Date.now() }));
  assert.strictEqual(asSid(m, 's-bea').taken, true);
  HT.release({ home: m.home, pid: process.pid });
  fs.writeFileSync(coordFile(m, 'suite-grant.json'), JSON.stringify({ to: 's-ana', by: COORD, at: Date.now() - 11 * 60000 }));
  assert.strictEqual(asSid(m, 's-bea').taken, true);
  HT.release({ home: m.home, pid: process.pid });
  assert.strictEqual(HT.grantInForce({ home: m.home }), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(coordFile(m, 'suite-grant.json'), 'utf8')).to, 's-ana', 'el vencido queda escrito para la fila');
  // la segunda ejecución grande tampoco entra sin «arrancá» para una anotada, aunque haya memoria
  fs.writeFileSync(waitFile(m, 's-ana'), JSON.stringify({ sid: 's-ana', what: 'x', at: Date.now() - 60000 }));
  slotOf(m, 0, other);
  const segunda = said(() => secondAs(m, process.pid, memory(90), { CLAUDE_CODE_SESSION_ID: 's-ana' })).r;
  assert.strictEqual(segunda.ok, false);
  assert.match(segunda.message, /esperá el «arrancá»/i);
  assert.ok(!fs.existsSync(HT.slotFiles(m.home)[1]));
  // una espera de más de tres horas no cuenta: se borra
  fs.writeFileSync(waitFile(m, 's-bea'), JSON.stringify({ sid: 's-bea', what: 'x', at: Date.now() - 3 * 3600000 - 1000 }));
  assert.strictEqual(said(() => secondAs(m, process.pid, memory(90), { CLAUDE_CODE_SESSION_ID: 's-bea' })).r.taken, true);
  HT.release({ home: m.home, pid: process.pid });
  fs.rmSync(HT.slotFiles(m.home)[0]);
  // la suite rápida del arranque no es un portón: su 77 no la anota, su espera no la frena y no gasta el «arrancá»
  slotOf(m, 0, other);
  assert.strictEqual(asSid(m, 's-cami', { queue: false }).ok, false);
  assert.ok(!fs.existsSync(waitFile(m, 's-cami')));
  fs.rmSync(HT.slotFiles(m.home)[0]);
  assert.strictEqual(grantAs(m, COORD, 's-ana').ok, true);
  assert.strictEqual(asSid(m, 's-ana', { queue: false }).taken, true);
  assert.ok(fs.existsSync(coordFile(m, 'suite-grant.json')), 'el «arrancá» sigue siendo del portón');
  assert.ok(fs.existsSync(waitFile(m, 's-ana')));
  HT.release({ home: m.home, pid: process.pid });
  // ni la nota de espera de su sesión: es la del portón
  const doing = path.join(stateDir(m.home), 'doing');
  fs.mkdirSync(doing, { recursive: true });
  fs.writeFileSync(path.join(doing, 's-ana.json'), JSON.stringify({ at: new Date().toISOString(), waitingFor: 'turno de portón', waitingSince: new Date().toISOString() }));
  assert.strictEqual(asSid(m, 's-ana', { queue: false }).taken, true);
  assert.ok(fs.existsSync(path.join(doing, 's-ana.json')));
  HT.release({ home: m.home, pid: process.pid });
  // con el turno prendido a mano y nadie designado, no hay fila: nadie podría dar el «arrancá»
  const manual = toy({ designated: false });
  const ocupa = otherProcess(t);
  slotOf(manual, 0, ocupa);
  assert.strictEqual(asSid(manual, 's-uma', { env: { CLAUDE_CODE_SESSION_ID: 's-uma', TYCON_SUITE_TURN: '1', ...ONE_TURN } }).ok, false);
  assert.ok(!fs.existsSync(waitFile(manual, 's-uma')));
  fs.rmSync(HT.slotFiles(manual.home)[0]);
  assert.strictEqual(asSid(manual, 's-uma', { env: { CLAUDE_CODE_SESSION_ID: 's-uma', TYCON_SUITE_TURN: '1' } }).taken, true);
  HT.release({ home: manual.home, pid: process.pid });
  // con la coordinadora cerrada, todo vuelve a lo de hoy: el portón en espera corre
  addSession(m, COORD, 'Coordinadora', deadPid());
  assert.deepStrictEqual(asSid(m, 's-ana'), { ok: true, taken: false, message: null });
});

// 🔴 mutación: una reserva como un lugar con proceso vence al instante (el de `reserve` termina enseguida).
test('Turno_ReservaDeLaCoordinadora_FrenaAlPorton (T11) @story-8.274 @ac-13 @ac-14', (t) => {
  const m = toy();
  const r = HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'revisores 9.9' });
  assert.strictEqual(r.ok, true, r.message);
  const gate = asSid(m, 's-uma');
  assert.strictEqual(gate.ok, false);
  assert.match(gate.message, /reservado .*revisores 9\.9/);
  // también frena el segundo lugar
  assert.strictEqual(said(() => secondAs(m, process.pid, memory(90))).r.ok, false);
  // a los 90 minutos vence
  assert.strictEqual(asSid(m, 's-bea', { now: Date.now() + 91 * 60000 }).taken, true);
  HT.release({ home: m.home, pid: process.pid });
  // con la sesión que reservó cerrada, a los 10 minutos
  fs.writeFileSync(coordFile(m, 'suite-reserve.json'), JSON.stringify({ sid: 's-muerta', session: 'Vieja', what: 'pase 9.8', at: Date.now() - 5 * 60000 }));
  assert.strictEqual(asSid(m, 's-dani').ok, false);
  fs.writeFileSync(coordFile(m, 'suite-reserve.json'), JSON.stringify({ sid: 's-muerta', session: 'Vieja', what: 'pase 9.8', at: Date.now() - 11 * 60000 }));
  // (Dani quedó anotada por su 77: la que prueba el vencimiento es otra, sin anotar)
  assert.strictEqual(asSid(m, 's-eva').taken, true);
  HT.release({ home: m.home, pid: process.pid });
  // release --reserve la suelta; sólo la coordinadora reserva
  assert.strictEqual(HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, what: 'x' }).ok, false);
  assert.strictEqual(HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'revisores 9.9' }).ok, true);
  assert.strictEqual(HT.releaseReserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD } }), true);
  assert.ok(!fs.existsSync(coordFile(m, 'suite-reserve.json')));
  // con una suite corriendo, la reserva no la pisa: sale 77 y dice quién la tiene
  const other = otherProcess(t);
  sinFila(m, 's-uma');
  assert.strictEqual(HT.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-uma' }, pid: other, what: 'portables' }).taken, true);
  const pisada = HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'revisores 9.9' });
  assert.deepStrictEqual([pisada.ok, pisada.code], [false, HT.BUSY_EXIT]);
  assert.match(pisada.message, /Uma \(portables/);
  assert.ok(!fs.existsSync(coordFile(m, 'suite-reserve.json')));
  // por la línea de comandos: reserva y «arrancá» de la coordinadora, y otra sesión no puede
  HT.release({ home: m.home, pid: other });
  const cli = (sid, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), ...a], { env: { ...machineEnv(m), CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' });
  installed(m);
  assert.strictEqual(cli(COORD, 'reserve', '--for', 'pase 9.9').status, 0);
  assert.strictEqual(cli(COORD, 'release', '--reserve').status, 0);
  assert.strictEqual(cli(COORD, 'grant', '--to', 's-uma').status, 0);
  assert.strictEqual(cli('s-uma', 'grant', '--to', 's-uma').status, 2);
});

// 🔴 mutación: guardar la reserva sin la sesión que lanza lo reservado (agile-pass-turn.js no la reconoce), o aceptar una
// sesión que no está viva.
test('Turno_ReservaConSesion_DiceDeQuienEs (fila 126 a)', () => {
  const m = toy();
  const r = HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'el pase de Uma', to: 's-uma' });
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /turno reservado para «el pase de Uma» de Uma/);
  const guardada = JSON.parse(fs.readFileSync(coordFile(m, 'suite-reserve.json'), 'utf8'));
  assert.deepStrictEqual([guardada.sid, guardada.to, guardada.toSession], [COORD, 's-uma', 'Uma']);
  assert.strictEqual(HT.reserveInForce({ home: m.home }).to, 's-uma');
  assert.strictEqual(HT.releaseReserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD } }), true);
  // una sesión que no está viva no recibe la reserva, y no queda nada reservado
  const nadie = HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'x', to: 'nadie-vivo' });
  assert.deepStrictEqual([nadie.ok, nadie.code], [false, 2]);
  assert.ok(!fs.existsSync(coordFile(m, 'suite-reserve.json')));
  // sin --to, como siempre: sin sesión
  assert.strictEqual(HT.reserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD }, what: 'revisores' }).ok, true);
  assert.strictEqual(HT.reserveInForce({ home: m.home }).to, undefined);
  // por la línea de comandos
  HT.releaseReserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD } });
  installed(m);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'reserve', '--for', 'pase', '--to', 's-uma'],
    { env: { ...machineEnv(m), CLAUDE_CODE_SESSION_ID: COORD }, encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(coordFile(m, 'suite-reserve.json'), 'utf8')).to, 's-uma');
  HT.releaseReserve({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: COORD } });
  // `--to` sin su sesión, al final o seguido de otra opción, falla y no reserva: no es una reserva sin sesión
  for (const args of [['--for', 'pase', '--to'], ['--to', '--for', 'pase']]) {
    const sin = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'), 'reserve', ...args],
      { env: { ...machineEnv(m), CLAUDE_CODE_SESSION_ID: COORD }, encoding: 'utf8' });
    assert.strictEqual(sin.status, 2, `${args.join(' ')}: ${sin.stdout}${sin.stderr}`);
    assert.match(sin.stderr, /falta --to <sesión>/);
    assert.ok(!fs.existsSync(coordFile(m, 'suite-reserve.json')), args.join(' '));
  }
});
