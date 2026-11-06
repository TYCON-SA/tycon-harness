#!/usr/bin/env node
/**
 * suite-workers.test.js — cuántas suites corren a la vez, según los núcleos y la carga de la máquina.
 *
 * Lo que no se puede perder:
 *   - fuera de la CI y sin variable, el portón y las portables corren min(núcleos − 2, núcleos − carga), con piso 1:
 *     dos núcleos quedan para la persona y una máquina cargada recibe menos;
 *   - antes de lanzar cada suite, con la carga sobre el doble de los núcleos y otra propia corriendo, espera y vuelve a
 *     mirar: nunca se queda sin ninguna corriendo;
 *   - la variable y la CI se comportan como antes (la mitad de los núcleos en el portón, 4 en las portables), sin espera;
 *   - la línea de arranque dice cuántas, con los núcleos y la carga.
 *
 * Las pruebas que lanzan un proceso fingen la máquina con TYCON_FAKE_MACHINE=<núcleos>/<carga> y vacían las variables de
 * la CI: así miden la regla de la máquina también cuando corren en GitHub o en Azure.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const LIB = path.join(SCRIPTS, 'lib', 'suite-times.js');
const RUNNER = path.join(SCRIPTS, 'lib', 'run-suites-json.js');
const PORTABLES = path.join(ROOT, 'scripts', 'tests', 'portable-suites.test.sh');
const st = require(LIB);
const runner = require(RUNNER);

const CLEAN = ['CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'TYCON_PUBLIC_CI_OUT', 'TYCON_SUITES_MAX_WORKERS', 'TYCON_PORTABLE_PARALLEL',
  'TYCON_FAKE_MACHINE', 'TYCON_SUITE_TIMES', 'TYCON_SUITE_RUNNER', 'TYCON_HOME', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR',
  'NODE_TEST_CONTEXT', 'TYCON_SUITE_TURN', 'TYCON_PORTABLE_ONLY', 'TYCON_PORTABLE_SHARD'];
function envWith(extra) {
  const env = { ...process.env };
  for (const k of CLEAN) delete env[k];
  return { ...env, ...extra };
}
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const HALF = (n) => Math.max(1, Math.floor(n / 2));

/** Un sueño de mentira: no espera de verdad, cuenta el tiempo que habría dormido. */
function fakeClock() {
  const c = { now: 0, sleeps: 0 };
  c.sleep = async (ms) => { c.sleeps += 1; c.now += ms; await new Promise((r) => setImmediate(r)); };
  return c;
}

test('T13 Trabajadores_PorNucleosYCarga — núcleos menos dos, o núcleos menos la carga, con piso 1', () => {
  // 🔴 mutación: volver a la mitad de los núcleos, no restar los dos de la persona, o dejar que la carga dé 0 o menos.
  assert.equal(st.autoWorkers({ nucleos: 10, carga: 1 }), 8);
  assert.equal(st.autoWorkers({ nucleos: 10, carga: 6 }), 4);
  // con carga 50, el piso de cuatro (T24)
  assert.equal(st.autoWorkers({ nucleos: 10, carga: 50 }), 4);
  assert.equal(st.autoWorkers({ nucleos: 2, carga: 0 }), 1);
  // una carga con decimales no regala un trabajador
  assert.equal(st.autoWorkers({ nucleos: 10, carga: 3.2 }), 6);
  // sin variable ni CI manda la máquina, y con espera
  const w = st.workersFor({ env: {}, varName: 'TYCON_SUITES_MAX_WORKERS', maquina: { nucleos: 10, carga: 1 }, ci: false, ciDefault: 5 });
  assert.deepEqual([w.workers, w.why, w.wait, w.warning], [8, 'maquina', true, null]);
  // la máquina de mentira de las pruebas con proceso
  assert.deepEqual(st.machine({ TYCON_FAKE_MACHINE: '10/3.2' }), { nucleos: 10, carga: 3.2, fake: true });
  assert.equal(st.loadNow({ TYCON_FAKE_MACHINE: '10/3.2' }), 3.2);
  const real = st.machine({ TYCON_FAKE_MACHINE: 'mucho' });
  assert.equal(real.fake, undefined, 'un valor que no es <núcleos>/<carga> no finge nada');
  assert.ok(real.nucleos >= 1);
  // 🔴 mutación: que un valor mal escrito use la máquina real en silencio (la prueba creería fingir y mediría la real).
  for (const bad of ['mucho', '8-3', '0/2']) {
    assert.match(st.machine({ TYCON_FAKE_MACHINE: bad }).warning || '', new RegExp(`TYCON_FAKE_MACHINE=«${bad}»`), bad);
  }
  assert.equal(st.machine({}).warning, undefined, 'sin la variable no avisa nada');
  // la tercera cifra es la carga de después del arranque: la que mira la espera
  assert.deepEqual(st.machine({ TYCON_FAKE_MACHINE: '10/1/25' }), { nucleos: 10, carga: 1, fake: true });
  assert.equal(st.loadNow({ TYCON_FAKE_MACHINE: '10/1/25' }), 25);
});

test('T14 Trabajadores_EsperaSiLaCargaPasaElDoble — no lanza la siguiente mientras la carga pasa el doble, y nunca se queda sin ninguna', async () => {
  // 🔴 mutación: esperar con la carga bajo el doble, no volver a mirar, esperar sin ninguna otra corriendo, o no contar.
  let c = fakeClock();
  assert.equal(await st.waitForRoom({ nucleos: 10, load: () => 15, others: () => 1, sleep: c.sleep }), 0);
  assert.equal(c.sleeps, 0, 'con 15 en 10 núcleos no espera');

  c = fakeClock();
  const seq = [22, 22, 15];
  const ms = await st.waitForRoom({ nucleos: 10, load: () => seq.shift() ?? 15, others: () => 1, sleep: c.sleep });
  assert.equal(ms, 10000, 'sube a 22 y baja a los 10 s: espera 10 s, mirando cada 5');
  assert.equal(c.sleeps, 2);

  c = fakeClock();
  assert.equal(await st.waitForRoom({ nucleos: 10, load: () => 22, others: () => 0, sleep: c.sleep }), 0, 'sin otra corriendo la lanza');

  // el pool del portón con la carga en 22: con dos carriles, la tercera no sale mientras la segunda sigue corriendo
  c = fakeClock();
  const esperas = { veces: 0, ms: 0 };
  const beforeLaunch = runner.launchGate({ nucleos: 10, load: () => 22, sleep: c.sleep, esperas, now: () => c.now });
  const started = [];
  const finish = {};
  const runOne = (it) => new Promise((resolve) => { started.push(it); finish[it] = resolve; });
  const done = runner.pool(['a', 'b', 'c'], 2, runOne, { beforeLaunch });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b'], 'arrancan las dos del arranque');
  finish.a();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b'], 'con b corriendo y la carga en 22, c espera');
  assert.ok(c.sleeps > 0, 'vuelve a mirar');
  finish.b();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b', 'c'], 'sin otra corriendo, c sale');
  finish.c();
  await done;
  assert.equal(esperas.veces, 1, 'una espera');
  assert.ok(esperas.ms >= 5000, `con su tiempo: ${esperas.ms}`);
});

test('T14 — varios carriles esperando por la misma carga cuentan una sola espera, con el tiempo del reloj', async () => {
  // 🔴 mutación: contar una espera y sus ms por carril (3 carriles esperando 240 s daban 3 esperas y 720 s).
  const clock = { now: 0, pending: [] };
  const sleep = () => new Promise((r) => clock.pending.push(r));
  const tick = async (ms) => {
    clock.now += ms;
    const p = clock.pending.splice(0);
    for (const r of p) r();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  let load = 25;
  const esperas = { veces: 0, ms: 0 };
  const beforeLaunch = runner.launchGate({ nucleos: 10, load: () => load, sleep, esperas, now: () => clock.now });
  const finish = {};
  const started = [];
  const runOne = (it) => new Promise((resolve) => { started.push(it); finish[it] = resolve; });
  const done = runner.pool(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 4, runOne, { beforeLaunch });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  for (const it of ['a', 'b', 'c']) finish[it]();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'tres carriles esperan con d corriendo');
  for (let s = 0; s < 48; s++) await tick(5000);
  load = 5;
  await tick(5000);
  assert.equal(started.length, 7, 'con la carga abajo salen las tres');
  for (const it of ['d', 'e', 'f', 'g']) finish[it]();
  await done;
  assert.equal(esperas.veces, 1, 'una sola espera');
  assert.equal(esperas.ms, 245000, 'el tiempo de reloj de esa espera, no la suma de los carriles');
});

test('T24 Trabajadores_PisoDeCuatro — con la máquina cargada nunca bajan de cuatro, y la espera frena sólo lo que pasa del piso', async () => {
  // 🔴 mutación: volver al piso de 1 (con carga 22,7 el portón corría de a una), pasarse de núcleos menos dos en una
  // máquina chica, o esperar por la carga con menos suites corriendo que el piso.
  assert.deepEqual([1, 6, 22.7, 50].map((carga) => st.autoWorkers({ nucleos: 10, carga })), [8, 4, 4, 4]);
  assert.equal(st.autoWorkers({ nucleos: 4, carga: 30 }), 2, 'con 4 núcleos el piso es núcleos menos dos');
  assert.equal(st.autoWorkers({ nucleos: 2, carga: 30 }), 1);
  assert.equal(st.floorOf(10), 4);
  const w = st.workersFor({ env: {}, varName: 'TYCON_SUITES_MAX_WORKERS', maquina: { nucleos: 10, carga: 22.7 }, ci: false, ciDefault: 5 });
  assert.deepEqual([w.workers, w.why, w.floor, w.byFloor], [4, 'maquina', 4, true]);
  assert.match(st.describeWorkers(w, { nucleos: 10, carga: 22.7 }, 'darwin'), /^4 a la vez, el piso \(10 núcleos, carga 22\.7 al arrancar\)$/);
  const libre = st.workersFor({ env: {}, varName: 'TYCON_SUITES_MAX_WORKERS', maquina: { nucleos: 10, carga: 1 }, ci: false, ciDefault: 5 });
  assert.equal(libre.byFloor, false);
  assert.doesNotMatch(st.describeWorkers(libre, { nucleos: 10, carga: 1 }, 'darwin'), /piso/);
  // la espera: con la carga en 25 (pasa el doble), 3 corriendo y piso 4 lanza; con 4 corriendo espera
  let c = fakeClock();
  assert.equal(await st.waitForRoom({ nucleos: 10, floor: 4, load: () => 25, others: () => 3, sleep: c.sleep }), 0, 'con 3 de 4 lanza');
  c = fakeClock();
  const seq = [25, 15];
  assert.equal(await st.waitForRoom({ nucleos: 10, floor: 4, load: () => seq.shift() ?? 15, others: () => 4, sleep: c.sleep }), 5000, 'con 4 espera');
  // el pool del portón con la carga en 25 y el piso: las cuatro salen sin esperar; la quinta, no
  c = fakeClock();
  const esperas = { veces: 0, ms: 0 };
  const beforeLaunch = runner.launchGate({ nucleos: 10, floor: 4, load: () => 25, sleep: c.sleep, esperas, now: () => c.now });
  const started = [];
  const finish = {};
  const runOne = (it) => new Promise((resolve) => { started.push(it); finish[it] = resolve; });
  const done = runner.pool(['a', 'b', 'c', 'd', 'e'], 4, runOne, { beforeLaunch });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'las cuatro del piso salen con la carga en 25');
  assert.equal(c.sleeps, 0, 'sin mirar la carga');
  for (const k of ['a', 'b', 'c', 'd']) finish[k]();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  finish.e();
  await done;
});

test('T29 Porton_LentoLoDiceYAvisa — un portón grande con menos de 3 a la vez lo dice primero, con su hora de fin, y deja su aviso', () => {
  // 🔴 mutación: callar el portón lento, decirlo después de lanzar, sin la hora, o dejar el aviso vivo al terminar.
  const root = tmp('suite-workers-lento-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'casa');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(home);
  const probe = path.join(root, 'visto');
  const avisos = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home), 'slow-gates');
  const suites = Array.from({ length: 100 }, (_, i) => ({ raiz: 'arnes', ruta: `tests/s${i}.test.sh` }));
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: suites, semanales: [] }));
  // la primera suite copia los avisos que hay mientras corre
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 's0.test.sh'), `cat "${avisos}"/*.json > "${probe}" 2>/dev/null; exit 0`);
  for (let i = 1; i < 100; i++) fs.writeFileSync(path.join(repo, 'scripts', 'tests', `s${i}.test.sh`), 'exit 0');
  const correr = (env) => {
    const out = path.join(root, `out-${Math.random().toString(36).slice(2)}.json`);
    const r = spawnSync(process.execPath, [RUNNER, repo, out, '--skills', path.join(root, 'skills')],
      { encoding: 'utf8', env: envWith({ TYCON_SUITE_TIMES: 'off', HOME: home, USERPROFILE: home, ...env }), timeout: 120000 });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const lento = correr({ TYCON_FAKE_MACHINE: '4/3' });
  assert.equal(lento.status, 0, lento.out);
  const primera = lento.out.split('\n').find((l) => /\[suites\.json\]/.test(l));
  assert.match(primera, /🔴 \[suites\.json\] portón lento: 2 a la vez para 100 suites \(carga 3 al arrancar\): termina cerca de las \d\d:\d\d/, lento.out);
  const visto = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.deepEqual([visto.suites, visto.workers, visto.pid > 0, /^\d\d:\d\d$/.test(visto.eta)], [100, 2, true, true]);
  assert.deepEqual(fs.existsSync(avisos) ? fs.readdirSync(avisos) : [], [], 'al terminar, el aviso se borra');
  fs.rmSync(probe, { force: true });
  const libre = correr({ TYCON_FAKE_MACHINE: '10/1' });
  assert.equal(libre.status, 0, libre.out);
  assert.doesNotMatch(libre.out, /portón lento/);
  assert.equal(fs.existsSync(probe) && fs.readFileSync(probe, 'utf8').trim() !== '', false, 'con 8 a la vez, ningún aviso');
  // la hora sale de las medianas del registro: 100 suites de 60 s con 2 a la vez son 50 min
  const est = st.estimateMs({ rutas: ['a', 'b'], workers: 2, runs: [{ suites: [{ s: 'a', ms: 60000 }, { s: 'b', ms: 30000 }] }], defaultMs: 1000 });
  assert.equal(est.ms, 45000);
  assert.equal(st.estimateMs({ rutas: ['a', 'z'], workers: 1, runs: [{ suites: [{ s: 'a', ms: 60000 }] }], defaultMs: 1000 }).ms, 61000, 'sin medición, el peso por defecto');
});

test('T29 — la hora de arranque del proceso no depende del idioma ni de la zona de quien la lee', { skip: process.platform === 'win32' ? 'ps -o lstart no existe en Windows' : false }, () => {
  const leer = (env) => spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(LIB)}).processStart(${process.pid})))`],
    { encoding: 'utf8', env: { ...process.env, ...env } }).stdout;
  const base = leer({});
  assert.ok(base && base !== 'null', 'lee la hora de arranque');
  assert.equal(leer({ LC_ALL: 'es_AR.UTF-8', LANG: 'es_AR.UTF-8', TZ: 'America/Argentina/Buenos_Aires' }), base);
  assert.equal(leer({ TZ: 'Asia/Tokyo' }), base);
});

test('T15 Trabajadores_VariableOCI_ComoHoy — la variable manda y la CI usa la regla de antes, sin espera', () => {
  // 🔴 mutación: que la máquina le gane a la variable, que la CI use la regla nueva o espere, o que las portables pierdan su 4.
  const maquina = { nucleos: 10, carga: 1 };
  const gate = (env, ci) => st.workersFor({ env, varName: 'TYCON_SUITES_MAX_WORKERS', maquina, ci, ciDefault: HALF(10) });
  assert.deepEqual([gate({ TYCON_SUITES_MAX_WORKERS: '3' }, false).workers, gate({ TYCON_SUITES_MAX_WORKERS: '3' }, false).wait], [3, false]);
  for (const env of [{ GITHUB_ACTIONS: 'true' }, { TF_BUILD: 'True' }]) {
    assert.equal(st.isCI(env), true, JSON.stringify(env));
    const w = gate(env, st.isCI(env));
    assert.deepEqual([w.workers, w.why, w.wait], [5, 'ci', false], JSON.stringify(env));
  }
  assert.equal(st.isCI({ CI: 'false' }), false);
  assert.equal(st.isCI({ CI: '' }), false);
  // la variable inválida avisa y usa la regla que corresponde
  const bad = gate({ TYCON_SUITES_MAX_WORKERS: 'mucho' }, false);
  assert.equal(bad.workers, 8);
  assert.match(bad.warning, /TYCON_SUITES_MAX_WORKERS=«mucho»/);
  // el portón en la CI, por proceso: la mitad de los núcleos de la máquina (de mentira)
  const t = toyGate();
  const r = runGate(t, { TYCON_FAKE_MACHINE: '10/1', TF_BUILD: 'True' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.resumen.workers, 5);
  // las portables en la CI: 4
  const p = st.workersFor({ env: {}, varName: 'TYCON_PORTABLE_PARALLEL', maquina, ci: true, ciDefault: 4 });
  assert.deepEqual([p.workers, p.wait], [4, false]);
});

/** Un repo de juguete con suites.json y dos suites verdes. */
function toyGate() {
  const root = tmp('suite-workers-');
  const repo = path.join(root, 'repo');
  const skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/a.test.sh' }, { raiz: 'arnes', ruta: 'tests/b.test.sh' }], semanales: [] }));
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(repo, 'scripts', 'tests', `${n}.test.sh`), 'exit 0');
  return { root, repo, skills };
}
function runGate(t, env) {
  const out = path.join(t.root, 'out.json');
  const r = spawnSync(process.execPath, [RUNNER, t.repo, out, '--skills', t.skills],
    { encoding: 'utf8', env: envWith({ TYCON_SUITE_TIMES: 'off', ...env }), timeout: 60000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, resumen: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

/** Una copia de las portables con tres portables de juguete (la librería de tiempos es la del árbol). */
/** Tres portables de juguete (una de node y dos de bash), y `extra` de bash más. */
function toyPortables(extra = 0) {
  const root = tmp('suite-workers-port-');
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  fs.copyFileSync(PORTABLES, path.join(root, 'scripts', 'tests', 'portable-suites.test.sh'));
  fs.symlinkSync(path.join(ROOT, 'skills'), path.join(root, 'skills'));
  const bash = Array.from({ length: 2 + extra }, (_, i) => `p${i + 2}.test.sh`);
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/p1.test.js', requiere: [] },
    ...bash.map((b) => ({ raiz: 'arnes', ruta: `tests/${b}`, requiere: [] })),
  ], semanales: [] }));
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'p1.test.js'), 'process.exit(0)');
  for (const b of bash) fs.writeFileSync(path.join(root, 'scripts', 'tests', b), 'exit 0');
  return root;
}
function runPortables(root, env) {
  const times = path.join(root, `times-${Math.random().toString(36).slice(2)}.jsonl`);
  const r = spawnSync('bash', [path.join(root, 'scripts', 'tests', 'portable-suites.test.sh')],
    { encoding: 'utf8', env: envWith({ TYCON_PORTABLE_HOME: path.join(root, 'casa'), TYCON_SUITE_TIMES: times, ...env }), timeout: 120000 });
  const entry = fs.existsSync(times) ? JSON.parse(fs.readFileSync(times, 'utf8').split('\n').filter(Boolean)[0]) : null;
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, entry };
}

test('T16 Portables_MismaFuncion — a mano, las portables usan la función del portón; la variable sigue mandando', () => {
  // 🔴 mutación: que las portables sigan con 4 fijos, o que la máquina le gane a TYCON_PORTABLE_PARALLEL.
  const root = toyPortables();
  const auto = runPortables(root, { TYCON_FAKE_MACHINE: '10/1' });
  assert.equal(auto.status, 0, auto.out);
  assert.equal(auto.entry.workers, 8, auto.out);
  // 🔴 mutación: que una máquina fingida quede en el registro como si fuera la real (ensucia medianas y tendencias).
  assert.equal(auto.entry.fingida, true, 'el renglón dice que la máquina era de mentira');
  const fixed = runPortables(root, { TYCON_FAKE_MACHINE: '10/1', TYCON_PORTABLE_PARALLEL: '2' });
  assert.equal(fixed.status, 0, fixed.out);
  assert.equal(fixed.entry.workers, 2, fixed.out);
});

test('T16 — las portables en la CI de GitHub usan 4, sin la librería usan 4 y lo dicen, y a mano esperan por la carga', () => {
  // 🔴 mutación: perder `|| TYCON_PUBLIC_CI_OUT`, caerse (o callar) sin la librería, o no esperar en siguiente().
  const ciOut = tmp('suite-workers-ciout-');
  const ci = runPortables(toyPortables(), { TYCON_FAKE_MACHINE: '10/1', TYCON_PUBLIC_CI_OUT: ciOut });
  assert.equal(ci.status, 0, ci.out);
  assert.match(ci.out, /4 a la vez por la CI \(10 núcleos/);
  assert.match(ci.out, /SUITE-TIMES \{.*"workers":4/);

  const sinLib = toyPortables();
  fs.unlinkSync(path.join(sinLib, 'skills'));
  fs.mkdirSync(path.join(sinLib, 'skills'));
  const r = runPortables(sinLib, { TYCON_FAKE_MACHINE: '10/1' });
  assert.match(r.out, /no pude cargar la función de cuántas a la vez .*uso 4/);
  assert.match(r.out, /con 4 a la vez/);

  // arranca con carga 1 (8 carriles) y después la carga es 25: con el piso (4) corriendo, la quinta espera
  const w = runPortables(toyPortables(3), { TYCON_FAKE_MACHINE: '10/1/25' });
  assert.equal(w.status, 0, w.out);
  assert.match(w.out, /esperó \d+ vez\/veces \(\d+s\) por la carga/);
  // con menos portables que el piso no espera nunca
  const p = runPortables(toyPortables(), { TYCON_FAKE_MACHINE: '10/1/25' });
  assert.equal(p.status, 0, p.out);
  assert.doesNotMatch(p.out, /esperó \d+ vez/);
});

test('T17 Ambiente_DiceNucleosYCarga — el portón y las portables dicen cuántas, con los núcleos y la carga del arranque', () => {
  // 🔴 mutación: callar los núcleos o la carga, o que la línea diga otro número que el que corre.
  const t = toyGate();
  const g = runGate(t, { TYCON_FAKE_MACHINE: '10/3.2' });
  assert.equal(g.status, 0, g.out);
  assert.match(g.out, /6 a la vez \(10 núcleos, carga 3\.2 al arrancar\)/);
  assert.equal(g.resumen.workers, 6);
  assert.equal(g.resumen.nucleos, 10);
  assert.equal(g.resumen.carga, 3.2);
  assert.deepEqual(g.resumen.esperas, { veces: 0, ms: 0 });
  // 🔴 mutación: que una TYCON_FAKE_MACHINE olvidada en el entorno no se note en la línea de arranque.
  assert.match(g.out, /a la vez \(10 núcleos, carga 3\.2 al arrancar\) · máquina fingida por TYCON_FAKE_MACHINE/);
  assert.equal(st.entryOf({ origen: 'gate', repo: 'r', workers: 1, nucleos: 1, carga: 0, wallMs: 1, suites: [] }).fingida, undefined,
    'con la máquina real el renglón no lleva la marca');
  // 🔴 mutación: que un renglón fingido entre a la mediana y a la tendencia de `slow` y `runs`.
  const runs = [{ origen: 'gate', carga: 1, fingida: true }, { origen: 'gate', carga: 1 }];
  assert.deepEqual(st.filterRuns(runs), [{ origen: 'gate', carga: 1 }]);
  const p = runPortables(toyPortables(), { TYCON_FAKE_MACHINE: '10/3.2' });
  assert.equal(p.status, 0, p.out);
  assert.match(p.out, /6 a la vez \(10 núcleos, carga 3\.2 al arrancar\)/);
  // con la variable, la línea dice quién decidió
  const v = runGate(t, { TYCON_FAKE_MACHINE: '10/3.2', TYCON_SUITES_MAX_WORKERS: '3' });
  assert.match(v.out, /3 a la vez por TYCON_SUITES_MAX_WORKERS \(10 núcleos, carga 3\.2 al arrancar\)/);
});
