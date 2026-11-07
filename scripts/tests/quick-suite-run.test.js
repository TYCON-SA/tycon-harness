'use strict';
// stable-data: las suites de laboratorio anotan la hora para ver si dos se solapan; no comparan fechas.

/**
 * quick-suite-run.test.js — la suite rápida del arranque no traba la máquina.
 *
 * El aplicador corre en cada arranque de cada sesión, y con él seis suites de las skills. Corrían enteras cada vez, con
 * un proceso por suite y sin candado: medido en una Mac, 15 s y 440 MB por arranque; cinco sesiones que abren juntas,
 * treinta procesos. Lo que sostiene esta suite, contra `scripts/lib/quick-suite-run.js` de verdad:
 *   · versión: con lo mismo en disco, una suite que ya salió verde no se vuelve a correr; si cambia un archivo, sí;
 *     si salió roja o la cortaron, el arranque siguiente la vuelve a correr (un corte no la deja callada);
 *   · tope: corre a lo sumo la mitad de los núcleos a la vez (mínimo 1);
 *   · candado: con otra sesión corriéndola, el arranque no espera ni corre, y lo deja escrito en el registro; un
 *     candado de un proceso muerto no traba a nadie, y al terminar se suelta.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'lib', 'quick-suite-run.js');

/** Una carpeta con suites de mentira que anotan cada corrida en `corridas.log`. */
function armar() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-suite-'));
  const watch = path.join(base, 'scripts');
  const state = path.join(base, 'state');
  fs.mkdirSync(path.join(watch, 'tests'), { recursive: true });
  fs.mkdirSync(state);
  const log = path.join(base, 'corridas.log');
  return { base, watch, state, log };
}

/** Escribe una suite que anota su nombre al empezar y al terminar, y tarda `ms`. `falla`: sale roja. */
function suite(c, nombre, { ms = 0, falla = false } = {}) {
  const f = path.join(c.watch, 'tests', `${nombre}.test.js`);
  fs.writeFileSync(f, `'use strict';
const fs = require('fs');
const { test } = require('node:test');
test('${nombre}', async () => {
  fs.appendFileSync(${JSON.stringify(c.log)}, 'empieza ${nombre} ' + Date.now() + '\\n');
  await new Promise((r) => setTimeout(r, Number(process.env.QS_MS || ${ms})));
  fs.appendFileSync(${JSON.stringify(c.log)}, 'termina ${nombre} ' + Date.now() + '\\n');
  ${falla ? "throw new Error('roja a propósito');" : ''}
});
`);
  return f;
}

function args(c, files) { return [RUNNER, '--state-dir', c.state, '--watch', c.watch, ...files]; }
// con una HOME propia: el turno de las ejecuciones grandes de la máquina de quien corre la suite no entra al laboratorio
function entorno(c, env = {}) {
  const base = { ...process.env, HOME: path.join(c.base, 'home') };
  for (const k of ['TYCON_HOME', 'TYCON_SUITE_TURN', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete base[k];
  return { ...base, ...env };
}
function correr(c, files, env = {}) {
  return spawnSync(process.execPath, args(c, files), { encoding: 'utf8', env: entorno(c, env), timeout: 60000 });
}
/** El archivo del turno de las ejecuciones grandes en la HOME del laboratorio. */
function archivoDelTurno(c) {
  const env = { ...process.env, HOME: path.join(c.base, 'home') };
  delete env.TYCON_HOME;
  const ht = path.join(__dirname, '..', 'tools', 'heavy-turn.js');
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).turnFile(process.argv[2]))', ht, env.HOME], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}
function corridas(c, nombre) {
  try { return fs.readFileSync(c.log, 'utf8').split('\n').filter((l) => l.startsWith(`empieza ${nombre} `)).length; } catch (_) { return 0; }
}

test('QuickSuite_SameVersionGreen_NotRunAgain — con lo mismo en disco, una suite verde no se vuelve a correr', () => {
  const c = armar();
  const f = suite(c, 'a');
  assert.strictEqual(correr(c, [f]).status, 0);
  assert.strictEqual(correr(c, [f]).status, 0);
  assert.strictEqual(corridas(c, 'a'), 1, 'la segunda vez, sin cambios, corrió igual: cada arranque pagaba la suite entera');
});

test('QuickSuite_FileChanged_RunsAgain — si cambia un archivo de lo vigilado, vuelve a correr', () => {
  const c = armar();
  const f = suite(c, 'a');
  correr(c, [f]);
  fs.writeFileSync(path.join(c.watch, 'lib.js'), 'module.exports = 1;\n');
  correr(c, [f]);
  assert.strictEqual(corridas(c, 'a'), 2, 'cambió lo vigilado y no volvió a correr: una versión nueva quedaría sin probar');
});

test('QuickSuite_Red_RunsAgainAndSaysSo — una suite roja sale 1 y el arranque siguiente la vuelve a correr', () => {
  const c = armar();
  const f = suite(c, 'roja', { falla: true });
  assert.strictEqual(correr(c, [f]).status, 1);
  assert.strictEqual(correr(c, [f]).status, 1);
  assert.strictEqual(corridas(c, 'roja'), 2, 'una roja quedó como probada: el rojo se diría una sola vez');
});

test('QuickSuite_Killed_RunsAgainAndReleasesLock — una corrida cortada no cuenta como probada ni deja el candado', async () => {
  const c = armar();
  const f = suite(c, 'lenta');
  const p = spawn(process.execPath, args(c, [f]), { stdio: 'ignore', env: entorno(c, { QS_MS: '4000' }) });
  const deadline = Date.now() + 10000;
  while (corridas(c, 'lenta') === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const fin = p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.on('exit', r));
  p.kill('SIGTERM');
  await fin;
  assert.ok(!fs.existsSync(path.join(c.state, 'quick-suite.lock')), 'cortada, dejó el candado tomado');
  correr(c, [f]);   // la misma suite, sin tocar nada en disco
  assert.strictEqual(corridas(c, 'lenta'), 2, 'el arranque siguiente no la volvió a correr: un corte la dejó callada');
});

test('QuickSuite_Cap_HalfTheCores — corre a lo sumo la mitad de los núcleos a la vez (mínimo 1)', () => {
  const c = armar();
  const files = ['p1', 'p2', 'p3', 'p4'].map((n) => suite(c, n, { ms: 400 }));
  assert.strictEqual(correr(c, files, { TYCON_QUICK_SUITE_CORES: '3' }).status, 0);
  // máximo de suites abiertas a la vez, por los tiempos anotados
  const ev = fs.readFileSync(c.log, 'utf8').trim().split('\n').map((l) => { const [k, , t] = l.split(' '); return { k, t: Number(t) }; })
    .sort((x, y) => x.t - y.t || (x.k === 'termina' ? -1 : 1));
  let open = 0; let max = 0;
  for (const e of ev) { open += e.k === 'empieza' ? 1 : -1; max = Math.max(max, open); }
  assert.strictEqual(max, 1, `con 3 núcleos el tope es 1, y corrieron ${max} a la vez`);
});

test('QuickSuite_Locked_NoRunNoWait_Logged — con otra sesión corriéndola, no espera ni corre, y lo escribe', () => {
  const c = armar();
  const f = suite(c, 'a');
  const lock = path.join(c.state, 'quick-suite.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));   // un proceso vivo: este
  const t0 = Date.now();
  const r = correr(c, [f]);
  assert.strictEqual(r.status, 0);
  assert.ok(Date.now() - t0 < 5000, 'esperó al candado');
  assert.strictEqual(corridas(c, 'a'), 0, 'con el candado tomado, corrió igual');
  const reg = fs.readFileSync(path.join(c.state, 'quick-suite.log'), 'utf8');
  assert.match(reg, /otra sesión/, 'no dejó la línea en el registro');
  assert.ok(fs.existsSync(lock), 'soltó un candado que no era suyo');
});

test('QuickSuite_StaleLock_Taken_ThenReleased — un candado de un proceso muerto se toma, y al terminar se suelta', () => {
  const c = armar();
  const f = suite(c, 'a');
  const lock = path.join(c.state, 'quick-suite.lock');
  const muerto = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), muerto);
  assert.strictEqual(correr(c, [f]).status, 0);
  assert.strictEqual(corridas(c, 'a'), 1, 'el candado huérfano trabó la suite');
  assert.ok(!fs.existsSync(lock), 'al terminar no soltó el candado');
});

test('QuickSuite_HeavyTurnTaken_NoRun_Logged — con el turno de las ejecuciones grandes de otro, no corre y lo escribe', () => {
  const c = armar();
  const f = suite(c, 'a');
  const turno = archivoDelTurno(c);
  fs.mkdirSync(path.dirname(turno), { recursive: true });
  // otra ejecución grande viva: este proceso
  fs.writeFileSync(turno, JSON.stringify({ pid: process.pid, sid: 'otra', session: 'Otra', what: 'suites portables', at: Date.now() }));
  const r = correr(c, [f], { TYCON_SUITE_TURN: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(corridas(c, 'a'), 0, 'con el turno de otro, corrió igual');
  assert.match(fs.readFileSync(path.join(c.state, 'quick-suite.log'), 'utf8'), /suites portables.*este arranque no corre la suite rápida/);
  assert.ok(fs.existsSync(turno), 'soltó un turno que no era suyo');
  assert.ok(!fs.existsSync(path.join(c.state, 'quick-suite.lock')), 'dejó tomado su candado');
  // el arranque siguiente, con el turno libre, la corre
  fs.unlinkSync(turno);
  assert.strictEqual(correr(c, [f], { TYCON_SUITE_TURN: '1' }).status, 0);
  assert.strictEqual(corridas(c, 'a'), 1, 'con el turno libre, no la corrió');
});

test('QuickSuite_HeavyTurn_TakenWhileRunning_ThenReleased — corre con el turno tomado a su nombre y al terminar lo suelta', () => {
  const c = armar();
  const turno = archivoDelTurno(c);
  // la suite anota, mientras corre, quién tiene el turno
  const f = path.join(c.watch, 'tests', 'mira.test.js');
  fs.writeFileSync(f, `'use strict';
const fs = require('fs');
const { test } = require('node:test');
test('mira', () => { fs.writeFileSync(${JSON.stringify(path.join(c.base, 'visto.json'))}, fs.readFileSync(${JSON.stringify(turno)}, 'utf8')); });
`);
  assert.strictEqual(correr(c, [f], { TYCON_SUITE_TURN: '1' }).status, 0);
  assert.match(JSON.parse(fs.readFileSync(path.join(c.base, 'visto.json'), 'utf8')).what, /suite rápida del arranque/);
  assert.ok(!fs.existsSync(turno), 'al terminar no soltó el turno');
});

test('QuickSuite_HeavyTurn_KilledReleasesIt — cortada mientras corre con el turno, lo suelta', async () => {
  const c = armar();
  const f = suite(c, 'lenta');
  const turno = archivoDelTurno(c);
  const p = spawn(process.execPath, args(c, [f]), { stdio: 'ignore', env: entorno(c, { QS_MS: '4000', TYCON_SUITE_TURN: '1' }) });
  const deadline = Date.now() + 10000;
  while (corridas(c, 'lenta') === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(turno), 'corría sin el turno tomado');
  const fin = p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.on('exit', r));
  p.kill('SIGTERM');
  await fin;
  assert.ok(!fs.existsSync(turno), 'cortada, dejó el turno tomado');
});

test('QuickSuite_HeavyTurn_CannotAsk_RunsAndSaysSo — sin poder pedir el turno, corre igual y lo escribe', () => {
  const c = armar();
  const f = suite(c, 'a');
  // donde va la carpeta del turno hay un archivo: pedirlo tira
  const turno = archivoDelTurno(c);
  fs.mkdirSync(path.dirname(path.dirname(turno)), { recursive: true });
  fs.writeFileSync(path.dirname(turno), 'no es una carpeta');
  assert.strictEqual(correr(c, [f], { TYCON_SUITE_TURN: '1' }).status, 0);
  assert.strictEqual(corridas(c, 'a'), 1, 'sin poder pedir el turno, no corrió');
  assert.match(fs.readFileSync(path.join(c.state, 'quick-suite.log'), 'utf8'), /no pude pedir el turno de las ejecuciones grandes .*: la corro sin turno/);
});

test('QuickSuite_Installer_UsesRunner — el aplicador corre la suite rápida por este guion, no con un node --test suelto', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'install-tycon-hooks.sh'), 'utf8');
  assert.match(sh, /QUICK_SUITE_JS="\$SCRIPT_DIR\/lib\/quick-suite-run\.js"/, 'el aplicador no apunta a quick-suite-run.js');
  assert.match(sh, /node "\$QUICK_SUITE_JS" --state-dir /, 'el aplicador no llama a quick-suite-run.js');
  assert.doesNotMatch(sh, /node --test "\$\{UT_PRESENT\[@\]\}"/, 'el aplicador sigue corriendo la suite entera, sin tope ni candado');
});
