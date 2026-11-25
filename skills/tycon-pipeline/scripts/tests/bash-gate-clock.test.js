'use strict';
// El reloj del freno de escrituras (lib/gate-clock.js): el análisis corre en un hilo y, si no alcanza a decidir, el
// comando no corre. Las primeras pruebas usan un análisis de juguete; las últimas, el freno de verdad en una HOME vacía.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RELOJ = path.join(SCRIPTS, 'lib', 'gate-clock.js');
const GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');

/** Un análisis de juguete que se porta según `JUGUETE`. En el hilo principal, sólo arranca el reloj. */
const JUGUETE = `
const { isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const { spawnSync } = require('child_process');
const modo = process.env.TOY_MODE;
if (isMainThread) {
  require(process.env.CLOCK_LIB).vigilar({
    archivo: process.env.TOY_FILE || __filename,
    archivoRed: process.env.TOY_NET_FILE || undefined,
    segundos: Number(process.env.TOY_SECONDS),
  });
  return;
}
if (workerData.modo === 'net') {
  if (modo === 'net-loop') for (;;);
  if (modo === 'net-crashes') process.exit(1);
  process.stderr.write('red: ' + String(workerData.entrada).length + '\\n');
  process.exit(String(workerData.entrada).includes('escribe') ? 2 : 0);
}
const entrada = fs.readFileSync(0, 'utf8');
require(process.env.CLOCK_LIB).entregarEntrada(parentPort, workerData, entrada);
if (modo === 'slow' || modo === 'slow-hung') require(process.env.CLOCK_LIB).anotarPaso('leyendo un guion de juguete');
if (modo === 'slow') spawnSync('sleep', ['1.4']);
if (modo === 'slow-hung') for (;;);
if (modo === 'loop') for (;;);
if (modo === 'regex') /(a+)+$/.test('a'.repeat(60) + 'b');
if (modo === 'hung') spawnSync('sleep', ['30']);
if (modo === 'exit-1' || modo === 'net-loop' || modo === 'net-crashes' || modo === 'net-missing') process.exit(1);
if (modo === 'fatal') throw new Error('fatal de juguete');
if (modo === 'verdict-2') { process.stdout.write('salida'); process.stderr.write('motivo\\n'); process.exit(2); }
if (modo === 'big-output') { process.stdout.write('x'.repeat(1024 * 1024)); process.exit(0); }
process.stdout.write('largo ' + entrada.length);
process.exit(0);
`;

/**
 * La entrada viene de un archivo: 1 MB por el canal que arma `spawnSync` deja al freno esperando la lectura de vez en
 * cuando, también sin hilos y sin reloj, y esa espera no es lo que se prueba acá.
 */
function conEntrada(dir, texto, correr) {
  const ruta = path.join(dir, `entrada-${process.hrtime.bigint()}`);
  fs.writeFileSync(ruta, texto);
  const fd = fs.openSync(ruta, 'r');
  try { return correr([fd, 'pipe', 'pipe']); } finally { fs.closeSync(fd); fs.rmSync(ruta, { force: true }); }
}

function corral(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-clock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const juguete = path.join(dir, 'juguete.js');
  fs.writeFileSync(juguete, JUGUETE);
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  const correr = (modo, entrada = 'ls', extra = {}) => {
    const ini = performance.now();
    const r = conEntrada(dir, entrada, (stdio) => spawnSync(process.execPath, [juguete], {
      stdio, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1 << 24,
      env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', CLOCK_LIB: RELOJ, TOY_MODE: modo, TOY_SECONDS: '2', ...extra },
    }));
    return { ...r, ms: performance.now() - ini };
  };
  const registro = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { dir, home, correr, registro, log };
}

const noDecidio = (r, c) => {
  assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
  assert.strictEqual(r.signal, null, c);
  assert.match(r.stderr, /no alcanzó a decidir/, c);
  assert.match(r.stderr, /[Rr]eintent/, c);
};

test('T1 BashGateClock_HungAnalysis_BlocksAndDies @story-8.308 @ac-1 — un análisis trabado frena dentro del reloj y el proceso termina', (t) => {
  const c = corral(t);
  const { contar } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'hooks', 'hook-failures-notice.js'));
  for (const modo of ['loop', 'regex']) {
    fs.rmSync(c.log, { force: true });
    const r = c.correr(modo);
    noDecidio(r, modo);
    assert.ok(r.ms < 4000, `${modo}: tardó ${r.ms} ms`);
    assert.throws(() => process.kill(r.pid, 0), /ESRCH/, `${modo}: el proceso sigue vivo`);
    assert.match(c.registro(), /on-bash-write-gate FRENÓ POR FALLA/, modo);
    const sello = Date.parse(/^\[([^\]]+)\]/.exec(c.registro())[1]);
    assert.strictEqual(contar(c.registro(), sello).get('on-bash-write-gate').cerradas, 1, modo);
  }
});

test('T1b BashGateClock_StuckInSystemCall_StillBlocks @story-8.308 @ac-1 — un hilo trabado en una llamada del sistema no impide salir', { skip: process.platform === 'win32' || typeof process.execve !== 'function' }, (t) => {
  const r = corral(t).correr('hung');
  noDecidio(r, 'hilo colgado');
  assert.ok(r.ms < 4000, `tardó ${r.ms} ms`);
});

test('T2 BashGateClock_Verdict_PassesThrough @story-8.308 @ac-2 — el veredicto del análisis pasa tal cual', (t) => {
  const c = corral(t);
  let r = c.correr('healthy', 'ls');
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, 'largo 2', '']);
  r = c.correr('verdict-2', 'ls');
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [2, 'salida', 'motivo\n']);
  const mega = 'a'.repeat(1024 * 1024);
  r = c.correr('healthy', mega);
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, `largo ${mega.length}`, '']);
  r = c.correr('big-output', 'ls');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.length, 1024 * 1024, 'la salida no se corta al terminar el hilo');
  assert.strictEqual(c.registro(), '', 'un veredicto normal no deja renglón');
});

test('T3 BashGateClock_AnalysisCrash_UsesTheNet @story-8.308 @ac-3 — un análisis caído decide por la red, y si la red falla frena', (t) => {
  const c = corral(t);
  for (const modo of ['exit-1', 'fatal']) {
    assert.strictEqual(c.correr(modo, 'escribe specs/h.md').status, 2, `${modo} con una escritura`);
    assert.strictEqual(c.correr(modo, 'ls').status, 0, `${modo} con ls`);
  }
  const sinLanzar = { TOY_FILE: path.join(c.dir, 'missing.js') };
  let r = c.correr('healthy', 'ls', sinLanzar);
  noDecidio(r, 'análisis y red sin lanzar');
  r = c.correr('net-loop', 'escribe');
  noDecidio(r, 'red trabada');
  assert.ok(r.ms < 4000, `la red trabada tardó ${r.ms} ms`);
  noDecidio(c.correr('net-crashes', 'ls'), 'red caída');
  noDecidio(c.correr('net-missing', 'ls', { TOY_NET_FILE: path.join(c.dir, 'missing.js') }), 'red sin lanzar');
  assert.match(c.registro(), /FRENÓ POR FALLA/);
});

test('T3c BashGateClock_CrashRightAfterReading_TheNetSeesTheCommand @story-8.308 @ac-3 — el texto leído llega a la red aunque el hilo caiga enseguida', (t) => {
  const c = corral(t);
  for (let n = 0; n < 40; n++) {
    assert.strictEqual(c.correr('exit-1', 'escribe specs/h.md').status, 2, `exit-1, vuelta ${n}`);
    assert.strictEqual(c.correr('fatal', 'escribe specs/h.md').status, 2, `fatal, vuelta ${n}`);
  }
});

test('T4 BashGateClock_TimeoutEnv_Bounds @story-8.308 @ac-4 — sólo un entero de 1 a 50 cambia el reloj', () => {
  const { segundosDelReloj } = require(RELOJ);
  for (const v of ['0', '51', '09', 'abc', '', undefined, '-1', '1.5', ' 5', '100']) assert.strictEqual(segundosDelReloj(v), 20, String(v));
  assert.strictEqual(segundosDelReloj('1'), 1);
  assert.strictEqual(segundosDelReloj('50'), 50);
});

/** El freno de verdad en un repo de juguete con una historia. */
function freno(t, argsPrevios = []) {
  const c = corral(t);
  const repo = path.join(c.dir, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), '---\nepic: 1\nstory: "1.1"\ntitle: "x"\nstatus: in-progress\n---\n# x\n');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'CLAUDE_CODE_SESSION_ID') base[k] = v;
  const entrada = (command) => JSON.stringify({ tool_name: 'Bash', session_id: 's-reloj', cwd: repo, tool_input: { command } });
  const correr = (command, extra = {}) => conEntrada(c.dir, entrada(command), (stdio) => spawnSync(process.execPath, [...argsPrevios, GATE], {
    stdio, cwd: repo, encoding: 'utf8',
    env: { ...base, HOME: c.home, USERPROFILE: c.home, TYCON_NO_RUN_CHANGE: '1', ...extra }, maxBuffer: 1 << 24,
  }));
  return { ...c, repo, correr };
}

test('T2b BashGateClock_RealGate_SameVerdicts @story-8.308 @ac-2 — el freno de verdad decide igual por el hilo', (t) => {
  const f = freno(t);
  let r = f.correr('ls -la');
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  r = f.correr('rm specs/story-1.1.md');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /HISTORIA ESCRITA POR CONSOLA/);
  r = f.correr(`rm specs/story-1.1.md # ${'a'.repeat(1024 * 1024)}`);
  assert.strictEqual(r.status, 2, 'también con una entrada de 1 MB');
  assert.strictEqual(f.registro(), '');
});

test('T3b BashGateClock_ClockDoesNotLoad_RunsAsToday @story-8.308 @ac-3 — sin el reloj, el freno decide como siempre y lo deja anotado', (t) => {
  const c = corral(t);
  const previa = path.join(c.dir, 'previa.js');
  fs.writeFileSync(previa, "const M = require('module'); const c = M._load; M._load = function (p, ...r) { if (String(p).endsWith('gate-clock.js')) throw new Error('reloj roto'); return c.call(this, p, ...r); };");
  const f = freno(t, ['-r', previa]);
  for (const [command, salida] of [['ls -la', 0], ['rm specs/story-1.1.md', 2]]) {
    fs.rmSync(f.log, { force: true });
    assert.strictEqual(f.correr(command).status, salida, command);
    assert.match(f.registro(), /on-bash-write-gate FAILED OPEN/, command);
  }
});

// 🔴 Falla con: un freno que tarda más de la mitad de su reloj no deja rastro, o el corte no dice en qué paso estaba.
test('T7 BashGateClock_SlowOrCut_LogsWhereItWas — el freno lento o cortado anota cuánto tardó y en qué paso', (t) => {
  const c = corral(t);
  const { contar } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'hooks', 'hook-failures-notice.js'));
  let r = c.correr('slow');
  assert.deepStrictEqual([r.status, r.stdout], [0, 'largo 2'], r.stderr);
  const lento = c.registro();
  assert.match(lento, /^\[[^\]]+\] on-bash-write-gate LENTO: decidió en \d+ ms, con un tope de 2 s; el paso más lento: leyendo un guion de juguete \(\d+ ms\)\n/);
  // tardar no es fallar: el aviso de arranque no lo cuenta
  assert.strictEqual(contar(lento, Date.parse(/^\[([^\]]+)\]/.exec(lento)[1])).size, 0, lento);
  fs.rmSync(c.log, { force: true });
  r = c.correr('slow-hung');
  noDecidio(r, 'lento y trabado');
  assert.match(c.registro(), /on-bash-write-gate FRENÓ POR FALLA: no contestó en 2 s; el último paso: leyendo un guion de juguete/);
  fs.rmSync(c.log, { force: true });
  r = c.correr('healthy');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(c.registro(), '', 'uno rápido no deja renglón');
});

// 🔴 Falla con: el freno de verdad no anota sus pasos, y el renglón de lo lento no dice dónde se fue el tiempo.
test('T7b BashGateClock_RealGate_SlowStepIsNamed — el freno de verdad dice en qué paso se le fue el tiempo', (t) => {
  const c = corral(t);
  const previa = path.join(c.dir, 'lenta.js');
  // el paso del stash se demora 3,2 s (sin lanzar procesos), con un reloj de 6 s: el arranque del freno de verdad, con la
  // máquina cargada, se come parte del reloj
  fs.writeFileSync(previa, "const M = require('module'); const c = M._load; M._load = function (p, ...r) { if (String(p).endsWith('stash-guard.js')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200); return c.call(this, p, ...r); };\n");
  const f = freno(t, ['-r', previa]);
  const r = f.correr('git stash list', { TYCON_BASH_GATE_TIMEOUT_S: '6' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(f.registro(), /on-bash-write-gate LENTO: decidió en \d+ ms, con un tope de 6 s; el paso más lento: mirando un stash \((3[2-9]|[4-9]\d)\d\d ms\)/);
});
