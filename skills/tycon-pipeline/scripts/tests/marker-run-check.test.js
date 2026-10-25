'use strict';

/**
 * marker-run-check.test.js — una sola corrida de cada check por repo.
 *
 * `marker.js run-check <check>` toma un candado por check y por repo antes de lanzar el comando. El segundo que llega
 * con el mismo check en el mismo repo no lanza nada: sale 75 y dice desde qué hora corre el otro, su pid y su sesión.
 * El candado de un proceso muerto en esta máquina se libera solo; por edad no se libera, y el de otra máquina no se
 * toca. Las señales se le pasan al hijo y sueltan el candado. La puerta de pruebas pasa el 75 sin escribir resultado.
 *
 * Todo corre con una HOME de prueba: el candado vive en `<HOME>/.claude/.tycon-pipeline/run-check-locks/`.
 */
// stable-data: el reloj fija la edad de los candados armados a mano (ahora menos N minutos) y los plazos de espera;
// ninguna prueba compara una hora ni una fecha contra un valor escrito.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const GUIDE = path.resolve(SCRIPTS, '..', '..', '..', 'guides', 'test-execution-discipline.md');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY',
  'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK',
  'STOP_AUTONOMY', 'TYCON_HOME', 'TYCON_HARNESS_LOCK_HELD'];

const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const casa = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-home-')));
const locksDir = (home) => path.join(home, '.claude', '.tycon-pipeline', 'run-check-locks');
const candados = (home) => { try { return fs.readdirSync(locksDir(home)).filter((n) => !n.endsWith('.takeover')); } catch (_) { return []; } };

function git(d, ...a) {
  const fecha = '2026-01-01T00:00:00Z';
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
}

/** Un repo con git y los archivos dados; `tocar` queda cambiado sin commitear. */
function repo(archivos = { 'a.txt': 'a\n' }, tocar = [], dir = null) {
  const d = dir || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-repo-')));
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(d, 'config', 'user.name', 'prueba');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), c);
  }
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  for (const rel of tocar) fs.appendFileSync(path.join(d, rel), '\n# tocado\n');
  return d;
}

/** La carpeta del candado de `check` en `repoDir`: el nombre del check y la huella de la ruta real de la raíz de git. */
function lockDirOf(home, check, repoDir) {
  const raiz = fs.realpathSync(git(repoDir, 'rev-parse', '--show-toplevel').stdout.trim());
  return path.join(locksDir(home), `${check}-${crypto.createHash('sha1').update(raiz).digest('hex').slice(0, 16)}`);
}

function entorno(home, sid, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: home, ...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}), ...extra };
}

function markerFalso(home, sid, repoDir) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.json`);
  fs.writeFileSync(f, JSON.stringify({
    storyId: '9.124', storyPath: '', repoPath: repoDir, sessionId: sid, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {},
  }));
  return f;
}

const DUERME = ['node', '-e', 'setTimeout(() => {}, 60000)'];

/** `run-check` de fondo; vuelve cuando su candado ya anota el pid del hijo. */
function deFondo(home, dir, check, cmd = DUERME, { sid, extra } = {}) {
  const p = spawn(process.execPath, [MARKER_JS, 'run-check', check, '--', ...cmd], { cwd: dir, env: entorno(home, sid, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { out += b; });
  const salida = new Promise((res) => p.on('exit', (code, signal) => res({ code, signal, out })));
  const lock = lockDirOf(home, check, dir);
  const hasta = Date.now() + 15000;
  let dueno = null;
  while (Date.now() < hasta) {
    try { dueno = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch (_) { dueno = null; }
    if (dueno && dueno.childPid) break;
    dormir(50);
  }
  return { p, salida, lock, dueno };
}

function correr(home, dir, check, cmd = ['node', '-e', 'process.exit(0)'], { sid, extra } = {}) {
  const r = spawnSync(process.execPath, [MARKER_JS, 'run-check', check, '--', ...cmd], { cwd: dir, encoding: 'utf8', env: entorno(home, sid, extra), timeout: 30000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function cortar(bg) {
  try { process.kill(bg.p.pid, 'SIGTERM'); } catch (_) { /* ya terminó */ }
  if (bg.dueno && bg.dueno.childPid) { try { process.kill(bg.dueno.childPid, 'SIGKILL'); } catch (_) { /* ya terminó */ } }
  return bg.salida;
}

/** Un candado armado a mano: `pid` (pid y máquina) y `owner.json`, con la edad dada. */
function candadoFalso(lock, { pid, host = os.hostname(), edadMs = 0, owner = {} }) {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), pid === '' ? '' : `${pid}\n${host}\n`);
  if (pid !== '') fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ check: 'tests', repo: '/x', startedAt: new Date(Date.now() - edadMs).toISOString(), session: 'otra', ...owner }));
  const t = new Date(Date.now() - edadMs);
  for (const f of fs.readdirSync(lock)) fs.utimesSync(path.join(lock, f), t, t);
  fs.utimesSync(lock, t, t);
}

test('T1 RunCheck_SameCheckSameRepo_Refuses @story-8.124 @ac-1 — el segundo no lanza; sale 75 y dice hora, pid y sesión', async () => {
  const home = casa(); const d = repo();
  markerFalso(home, 'rc1', d);
  const bg = deFondo(home, d, 'tests', DUERME, { sid: 'rc1' });
  assert.ok(bg.dueno, 'el primero no dejó su candado con el pid del hijo');
  const marca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-m-')), 'lanzado');
  const r = correr(home, d, 'tests', ['node', '-e', `require("fs").writeFileSync(${JSON.stringify(marca)}, "x")`], { sid: 'rc2' });
  await cortar(bg);
  assert.equal(r.status, 75, r.out);
  assert.ok(!fs.existsSync(marca), 'el segundo lanzó el comando');
  assert.match(r.out, /desde las \d{2}:\d{2}/, r.out);
  assert.match(r.out, new RegExp(`pid ${bg.p.pid}\\b`), r.out);
  assert.match(r.out, /sesión rc1\b/, r.out);
  assert.match(r.out, /esper/i, 'no dice que se espere el resultado');
});

test('T2 RunCheck_Refused_NoSession_Said @story-8.124 @ac-1 — sin marcador, la negativa dice «sin sesión»', async () => {
  const home = casa(); const d = repo();
  const bg = deFondo(home, d, 'tests', DUERME, { sid: 'nadie' });
  const r = correr(home, d, 'tests');
  await cortar(bg);
  assert.equal(r.status, 75, r.out);
  assert.match(r.out, /sin sesión/, r.out);
});

test('T3 RunCheck_Refused_MarkerUntouched @story-8.124 @ac-2 — la negativa no escribe el check ni gates.log', async () => {
  const home = casa(); const d = repo();
  const mk = markerFalso(home, 'rc3', d);
  const bg = deFondo(home, d, 'tests', DUERME, { sid: 'rc3' });
  const gates = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  const antesGates = fs.existsSync(gates) ? fs.readFileSync(gates, 'utf8') : '';
  const antesMk = fs.readFileSync(mk, 'utf8');
  const r = correr(home, d, 'tests', ['node', '-e', 'process.exit(1)'], { sid: 'rc3' });
  const despuesMk = fs.readFileSync(mk, 'utf8');
  const despuesGates = fs.existsSync(gates) ? fs.readFileSync(gates, 'utf8') : '';
  await cortar(bg);
  assert.equal(r.status, 75, r.out);
  assert.equal(despuesMk, antesMk, 'la negativa tocó el marcador');
  assert.equal(JSON.parse(despuesMk).checks.tests, undefined);
  assert.equal(despuesGates, antesGates, 'la negativa escribió en gates.log');
});

/** `python -m pytest` falso: deja el JUnit con FAKE_CASES pruebas y anota cuántos candados ve mientras corre. */
function herramientas() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-bin-'));
  const sh = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  const escribe = `node -e 'const n=+(process.env.FAKE_CASES||2);require("fs").mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});require("fs").writeFileSync(process.argv[1], ${JSON.stringify('<?xml version="1.0"?><testsuites><testsuite name="s">')}+Array.from({length:n},(_,i)=>"<testcase name=\\"t"+i+"\\"/>").join("")+"</testsuite></testsuites>")'`;
  const anota = 'echo "$(ls "$HOME/.claude/.tycon-pipeline/run-check-locks" 2>/dev/null | grep -vc takeover)" >> "${FAKE_CANDADOS:-/dev/null}"';
  // FAKE_LOCK: al terminar, deja de fondo un proceso que toma ese candado apenas se suelta (otra sesión que entra
  // entre una parte y la siguiente); anota su pid en FAKE_LOCK_PID.
  const toma = `if [ -n "\${FAKE_LOCK:-}" ]; then nohup node -e 'const fs=require("fs"),os=require("os"),l=process.argv[1];const t=Date.now()+20000;(function g(){try{fs.mkdirSync(l);fs.writeFileSync(l+"/pid",process.pid+"\\n"+os.hostname()+"\\n");fs.writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>{},20000);}catch(e){if(Date.now()<t)setTimeout(g,20);}})()' "$FAKE_LOCK" "$FAKE_LOCK_PID" >/dev/null 2>&1 & fi`;
  sh('python', `
for a in "$@"; do case "$a" in --junitxml=*) J="\${a#--junitxml=}";; --cov) echo "pytest: error: unrecognized arguments: --cov" >&2; exit 4;; esac; done
${anota}
${escribe} "$J"
${toma}`);
  sh('npx', `
if [ "$1" = "playwright" ] && [ "$2" = "test" ]; then
  ${anota}
  ${escribe} "$PLAYWRIGHT_JUNIT_OUTPUT_NAME"; exit 0
fi
echo "npx falso: no sé correr $*" >&2; exit 127`);
  return bin;
}

function gate(home, d, bin, story, extra = {}) {
  const args = [TEST_GATE, d]; if (story) args.push(story);
  const r = spawnSync('bash', args, { encoding: 'utf8', cwd: d, env: entorno(home, 'rcg', { PATH: `${bin}:${process.env.PATH}`, ...extra }), timeout: 120000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art: path.join(d, '.advisors', 'tests-result.json') };
}

const BACK = { 'backend/pytest.ini': '[pytest]\n', 'backend/app/precios.py': 'a = 1\n', 'backend/tests/test_precios.py': 'def test_a(): pass\n' };
const FRONT = {
  'frontend/package.json': JSON.stringify({ name: 'tienda-front', private: true, devDependencies: { '@playwright/test': '^1.64.1' } }) + '\n',
  'frontend/playwright.config.js': "export default { testDir: 'tests/e2e' };\n",
  'frontend/src/lib/precio.js': 'export const p = 1;\n',
  'frontend/tests/e2e/precio.spec.ts': "import { test } from '@playwright/test';\n",
};
const STORY = (archivos) => ['---', 'epic: 9', 'story: "9.124"', 'title: "candado"', 'status: in-progress',
  'files_to_create: []', 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', '# Story 9.124', '',
  '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '', '### Tests', '',
  '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `prueba` | 1 | unit | x | y |', ''].join('\n');

test('T4 TestGate_Refused_PassesThrough @story-8.124 @ac-3 — la puerta con un run-check tests vivo sale 75 sin tests-result.json', async () => {
  const home = casa(); const bin = herramientas();
  const d = repo(BACK, ['backend/app/precios.py']);
  const bg = deFondo(home, d, 'tests', DUERME, { sid: 'otra' });
  // un verde de una corrida anterior tampoco queda a la vista
  fs.mkdirSync(path.dirname(path.join(d, '.advisors', 'tests-result.json')), { recursive: true });
  fs.writeFileSync(path.join(d, '.advisors', 'tests-result.json'), JSON.stringify({ suite_green: true, ts: 'vieja' }));
  const r = gate(home, d, bin);
  await cortar(bg);
  assert.equal(r.status, 75, r.out);
  assert.ok(!fs.existsSync(r.art), 'quedó un tests-result.json con la negativa');
});

test('T5 RunCheck_DifferentChecks_RunTogether @story-8.124 @ac-4 — tests y build a la vez corren los dos', async () => {
  const home = casa(); const d = repo();
  const bg = deFondo(home, d, 'tests');
  const r = correr(home, d, 'build');
  await cortar(bg);
  assert.equal(r.status, 0, r.out);
});

test('T6 RunCheck_DifferentRepos_RunTogether @story-8.124 @ac-5 — tests en dos worktrees del mismo repo corren los dos', async () => {
  const home = casa(); const d = repo();
  const wt = `${d}-wt`;
  const w = git(d, 'worktree', 'add', '-q', '-b', 'otra', wt);
  assert.equal(w.status, 0, w.stderr);
  const bg = deFondo(home, d, 'tests');
  const r = correr(home, wt, 'tests');
  await cortar(bg);
  assert.equal(r.status, 0, r.out);
});

test('T7 RunCheck_DeadOwner_Freed @story-8.124 @ac-6 — el candado de un pid que no existe, en esta máquina, se libera', () => {
  const home = casa(); const d = repo();
  candadoFalso(lockDirOf(home, 'tests', d), { pid: 999999, owner: { childPid: 999998 } });
  const r = correr(home, d, 'tests');
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(candados(home), [], 'quedó un candado');
});

test('T8 RunCheck_OldLiveOwner_NotFreed @story-8.124 @ac-7 — un candado de 11 min con el dueño vivo no se libera', () => {
  const home = casa(); const d = repo();
  candadoFalso(lockDirOf(home, 'tests', d), { pid: process.pid, edadMs: 11 * 60 * 1000 });
  const r = correr(home, d, 'tests');
  assert.equal(r.status, 75, r.out);
});

test('T9 RunCheck_OtherMachine_NotFreed @story-8.124 @ac-8 — el candado de otra máquina no se toca', () => {
  const home = casa(); const d = repo();
  const lock = lockDirOf(home, 'tests', d);
  candadoFalso(lock, { pid: 999999, host: 'otra-maquina-de-prueba', edadMs: 2 * 60 * 60 * 1000 });
  const r = correr(home, d, 'tests');
  assert.equal(r.status, 75, r.out);
  assert.match(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), /otra-maquina-de-prueba/);
});

test('T10 RunCheck_ChildEnds_LockGone @story-8.124 @ac-9 — hijo verde y hijo rojo: no queda candado', () => {
  const home = casa(); const d = repo();
  assert.equal(correr(home, d, 'tests').status, 0);
  assert.deepEqual(candados(home), [], 'quedó el candado tras el verde');
  assert.equal(correr(home, d, 'tests', ['node', '-e', 'process.exit(3)']).status, 3);
  assert.deepEqual(candados(home), [], 'quedó el candado tras el rojo');
});

test('T11 RunCheck_Signal_ForwardsAndFrees @story-8.124 @ac-10 — SIGTERM, SIGINT y SIGHUP: el hijo la recibe, no queda candado, sale 128 + señal', async () => {
  for (const [sig, n] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) {
    const home = casa(); const d = repo();
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-s-')), 'senal');
    const hijo = ['node', '-e', `for (const s of ["SIGTERM","SIGINT","SIGHUP"]) process.on(s, () => { require("fs").writeFileSync(${JSON.stringify(f)}, s); process.exit(0); }); setTimeout(() => {}, 60000);`];
    const bg = deFondo(home, d, 'tests', hijo);
    assert.ok(bg.dueno, `${sig}: no arrancó`);
    dormir(200);   // el hijo ya instaló sus manejadores
    process.kill(bg.p.pid, sig);
    const fin = await bg.salida;
    for (let i = 0; i < 40 && !fs.existsSync(f); i++) dormir(50);
    assert.equal(fin.code, 128 + n, `${sig}: salió ${fin.code}/${fin.signal}\n${fin.out}`);
    assert.equal(fs.existsSync(f) && fs.readFileSync(f, 'utf8'), sig, `${sig}: el hijo no la recibió`);
    assert.deepEqual(candados(home), [], `${sig}: quedó el candado`);
  }
});

test('T12 TestGate_Parts_DoNotBlockThemselves @story-8.124 @ac-11 — la puerta con dos partes: cada una ve su candado y al final no queda ninguno', () => {
  const home = casa(); const bin = herramientas();
  const anot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-c-')), 'candados');
  const d = repo({ ...BACK, ...FRONT, 'specs/s.md': STORY(['backend/app/precios.py', 'frontend/src/lib/precio.js']) },
    ['backend/app/precios.py', 'frontend/src/lib/precio.js']);
  const r = gate(home, d, bin, path.join(d, 'specs', 's.md'), { FAKE_CANDADOS: anot, FAKE_CASES: '2' });
  assert.equal(r.status, 0, r.out);
  const vistos = fs.readFileSync(anot, 'utf8').trim().split('\n');
  assert.deepEqual(vistos, ['1', '1'], `cada parte debía ver su candado puesto: ${vistos}`);
  assert.deepEqual(candados(home), [], 'quedó un candado');
});

test('T15 RunCheck_KilledParentLiveChild_StillHeld @story-8.124 @ac-9b — con run-check muerto y el hijo vivo, el candado sigue', async () => {
  const home = casa(); const d = repo();
  const bg = deFondo(home, d, 'tests');
  assert.ok(bg.dueno && bg.dueno.childPid, 'el candado no anota el pid del hijo');
  process.kill(bg.p.pid, 'SIGKILL');
  await bg.salida;
  const r1 = correr(home, d, 'tests');
  process.kill(bg.dueno.childPid, 'SIGKILL');
  for (let i = 0; i < 40; i++) { try { process.kill(bg.dueno.childPid, 0); dormir(50); } catch (_) { break; } }
  const r2 = correr(home, d, 'tests');
  assert.equal(r1.status, 75, `con el hijo vivo no se negó: ${r1.out}`);
  assert.equal(r2.status, 0, `con los dos muertos no corrió: ${r2.out}`);
});

test('T16 RunCheck_UnreadableOwner_HeldThenFreed @story-8.124 @ac-9c — dueño ilegible: ocupado el primer minuto, después se libera', () => {
  const home = casa(); const d = repo();
  const lock = lockDirOf(home, 'tests', d);
  candadoFalso(lock, { pid: '' });
  const r1 = correr(home, d, 'tests');
  assert.equal(r1.status, 75, r1.out);
  assert.ok(r1.out.includes(lock), `la negativa no nombra la carpeta del candado: ${r1.out}`);
  fs.rmSync(lock, { recursive: true, force: true });
  candadoFalso(lock, { pid: '', edadMs: 2 * 60 * 1000 });
  const r2 = correr(home, d, 'tests');
  assert.equal(r2.status, 0, r2.out);
});

test('T18 RunCheck_GateRedMark_IgnoresLock @story-8.124 @ac-3b — la marca en rojo de la puerta se escribe aunque otra sesión tenga el candado', async () => {
  const home = casa(); const d = repo();
  const mk = markerFalso(home, 'rc18', d);
  const bg = deFondo(home, d, 'tests', DUERME, { sid: 'otra' });
  const r = correr(home, d, 'tests', ['node', '-e', 'process.exit(4)'], { sid: 'rc18', extra: { TYCON_TEST_GATE: '1', TYCON_TEST_GATE_MARK: '1' } });
  await cortar(bg);
  assert.equal(r.status, 4, r.out);
  assert.match(String(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests), /^red/, 'la marca en rojo no quedó escrita');
});

test('T19 RunCheck_ChildExits75_RecordedAsOne @story-8.124 @ac-1b — un comando que sale 75 por su cuenta no se confunde con «ocupado»', () => {
  const home = casa(); const d = repo();
  const mk = markerFalso(home, 'rc19', d);
  const r = correr(home, d, 'tests', ['node', '-e', 'process.exit(75)'], { sid: 'rc19' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /por su cuenta/, r.out);
  assert.match(String(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests), /^red/);
  assert.deepEqual(candados(home), [], 'quedó un candado');
});

test('T20 RunCheck_Signal_SlowChild_HeldUntilItCloses @story-8.124 @ac-10 — con la señal, el candado sigue hasta que el hijo cierra', async () => {
  const home = casa(); const d = repo();
  const hijo = ['node', '-e', 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500)); setTimeout(() => {}, 60000);'];
  const bg = deFondo(home, d, 'tests', hijo);
  assert.ok(bg.dueno, 'no arrancó');
  dormir(200);
  process.kill(bg.p.pid, 'SIGTERM');
  dormir(300);
  const r = correr(home, d, 'tests');
  const fin = await bg.salida;
  assert.equal(r.status, 75, `con el hijo todavía cerrando, otra corrida arrancó: ${r.out}`);
  assert.equal(fin.code, 143, `salió ${fin.code}/${fin.signal}\n${fin.out}`);
  assert.deepEqual(candados(home), [], 'quedó el candado');
});

test('T21 TestGate_LaterPartBusy_MarksRed @story-8.124 @ac-3c — si otra sesión entra entre dos partes, la puerta sale 75 y el check no queda verde', () => {
  const home = casa(); const bin = herramientas();
  const d = repo({ ...BACK, ...FRONT, 'specs/s.md': STORY(['backend/app/precios.py', 'frontend/src/lib/precio.js']) },
    ['backend/app/precios.py', 'frontend/src/lib/precio.js']);
  const mk = markerFalso(home, 'rcg', d);
  const pidF = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-p-')), 'pid');
  const r = gate(home, d, bin, path.join(d, 'specs', 's.md'), { FAKE_CASES: '2', FAKE_LOCK: lockDirOf(home, 'tests', d), FAKE_LOCK_PID: pidF });
  try { process.kill(Number(fs.readFileSync(pidF, 'utf8')), 'SIGKILL'); } catch (_) { /* no llegó a tomarlo */ }
  assert.equal(r.status, 75, r.out);
  assert.ok(!fs.existsSync(r.art), 'quedó tests-result.json');
  assert.match(String(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests), /^red/, `el check quedó ${JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests}`);
});

test('T22 TestGate_CompanionBusy_MarksRed @story-8.124 @ac-3c — un repo hermano ocupado: la puerta sale 75, sin tests-result.json y con el check en rojo', () => {
  const home = casa(); const bin = herramientas();
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-hermanos-')));
  const front = repo(BACK, ['backend/app/precios.py'], path.join(raiz, 'Front'));
  const back = repo({ ...BACK, '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n',
    'specs/s.md': STORY(['backend/app/precios.py', 'Front/backend/app/precios.py']) }, ['backend/app/precios.py'], path.join(raiz, 'Back'));
  const mk = markerFalso(home, 'rcg', back);
  candadoFalso(lockDirOf(home, 'tests', front), { pid: process.pid });
  const r = gate(home, back, bin, path.join(back, 'specs', 's.md'), { FAKE_CASES: '2' });
  assert.equal(r.status, 75, r.out);
  assert.match(r.out, /repo hermano Front no corrió/, r.out);
  assert.ok(!fs.existsSync(r.art), 'quedó tests-result.json');
  assert.match(String(JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests), /^red/, `el check quedó ${JSON.parse(fs.readFileSync(mk, 'utf8')).checks.tests}`);
});

test('T14 Guide_NamesTheLock @story-8.124 @ac-13 — la guía de pruebas trae la línea del candado y el código 75', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  assert.ok(g.split('\n').some((l) => /candado/.test(l) && /\b75\b/.test(l) && /run-check/.test(l)), 'falta la línea del candado de run-check con el 75');
});
