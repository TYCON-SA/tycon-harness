'use strict';

/**
 * test-environment.test.js — el entorno de pruebas que la organización declara en `stack.test_environments`: el lector
 * de la configuración lo valida, el portón lo prepara antes de la suite y lo desarma al terminar, y si no queda listo
 * sale 8, «entorno sin preparar», sin correr la suite.
 *
 * Una herramienta de prueba falsa de la organización (`mix`) que falla si no ve la variable que deja la preparación:
 * así se ve que lo preparado llega a la suite. Nada de bases ni servidores reales.
 *
 * stable-data: la hora de ahora sólo mide cuánto tarda en cortarse una preparación que pasa su tope (T6); no compara fechas.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const ENV_JS = path.join(SCRIPTS, 'lib', 'test-environment.js');
const teamRepos = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));
const tenv = require(ENV_JS);

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_TEST_ENV', 'TYCON_TEST_ENV_READY', 'ACME_TEST_SQL'];

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// los commits de las pruebas, con fecha fija: el resultado no depende del reloj
const FECHA = '2026-01-01T00:00:00Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA };
const REPO_API = { platform: 'github', org: 'acme', repo: 'api' };
const RUNNER = { name: 'elixir', detect: 'mix.exs', command: 'mix test {results}/j.xml', results: { format: 'junit', path: '{results}/j.xml' } };

/** La herramienta falsa: deja un JUnit de 2 casos si ve ACME_TEST_SQL; si no, sale 1. Anota cada lanzamiento. */
function herramientas(registro) {
  const bin = tmp('te-bin-');
  fs.writeFileSync(path.join(bin, 'mix'), `#!/usr/bin/env bash
echo "suite ACME_TEST_SQL=\${ACME_TEST_SQL:-}" >> ${JSON.stringify(registro)}
[ -n "\${ACME_TEST_SQL:-}" ] || { echo "sin base de prueba" >&2; exit 1; }
node -e 'require("fs").writeFileSync(process.argv[1], "<testsuites><testsuite name=\\"s\\"><testcase name=\\"a\\"/><testcase name=\\"b\\"/></testsuite></testsuites>")' "$2"
`);
  fs.chmodSync(path.join(bin, 'mix'), 0o755);
  return bin;
}

/** Un árbol del arnés con la configuración de la organización: la herramienta falsa y los entornos dados. */
function arbol(environments) {
  const a = tmp('te-arbol-');
  fs.mkdirSync(path.join(a, 'scripts'));
  fs.writeFileSync(path.join(a, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(a, 'team-repos.json'), JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' },
    stack: { test_runners: [RUNNER], test_environments: environments } }));
  return a;
}

/** Un repo con git, el remoto dado y un cambio sin commitear (para que el portón sepa qué se tocó). */
function repo(remote, { name } = {}) {
  const base = tmp('te-repo-');
  const d = name ? path.join(base, name) : base;
  fs.mkdirSync(d, { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], { encoding: 'utf8', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  fs.writeFileSync(path.join(d, 'mix.exs'), 'defmodule X do end\n');
  fs.mkdirSync(path.join(d, 'lib'));
  fs.writeFileSync(path.join(d, 'lib', 'a.ex'), 'x\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  if (remote) git('remote', 'add', 'origin', remote);
  fs.appendFileSync(path.join(d, 'lib', 'a.ex'), 'y\n');
  return d;
}

function correr(dir, { bin, guides, extra = {} }) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, dir], {
    encoding: 'utf8', cwd: dir, timeout: 60000,
    env: { ...env, HOME: tmp('te-home-'), CLAUDE_CODE_SESSION_ID: 'te-entorno', PATH: `${bin}:${process.env.PATH}`, TYCON_GUIDES_DIR: guides, ...extra },
  });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art };
}

const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

test('T1 TeamRepos_TestEnvironments_Validated', () => {
  const bien = { name: 'acme-local', label: 'Base local', repos: [REPO_API], prepare: 'source x.sh', teardown: 'bash y.sh', requires: ['ACME_TEST_SQL'], timeout_s: 300 };
  assert.deepEqual(teamRepos.stackProblems({ test_environments: [bien] }), []);
  const casos = [
    [{ ...bien, prepare: '' }, 'stack.test_environments.0.prepare'],
    [{ ...bien, name: 'Acme Local' }, 'stack.test_environments.0.name'],
    [{ ...bien, requires: ['ACME-SQL'] }, 'stack.test_environments.0.requires'],
    [{ ...bien, timeout_s: 0 }, 'stack.test_environments.0.timeout_s'],
    [{ ...bien, repos: [] }, 'stack.test_environments.0.repos'],
    [{ ...bien, otra: 1 }, 'stack.test_environments.0.otra'],
    [{ ...bien, teardown: 3 }, 'stack.test_environments.0.teardown'],
  ];
  for (const [e, ruta] of casos) {
    const p = teamRepos.stackProblems({ test_environments: [e] });
    assert.ok(p.some((x) => x.path === ruta), `${ruta}: ${JSON.stringify(p)}`);
  }
  // un repo va en un solo entorno
  const dos = teamRepos.stackProblems({ test_environments: [bien, { ...bien, name: 'otro' }] });
  assert.ok(dos.some((x) => x.path === 'stack.test_environments.1.repos.0' && /un solo entorno/.test(x.message)), JSON.stringify(dos));
  // uno mal escrito sale solo y los demás siguen
  const r = teamRepos.parse(JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' },
    stack: { test_environments: [{ ...bien, prepare: '' }, { ...bien, name: 'b', repos: [{ platform: 'github', org: 'acme', repo: 'web' }] }] } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.stack.test_environments.map((e) => e.name), ['b']);
});

test('T2 TestEnvironment_Placeholders_RepoAndSibling', () => {
  const base = tmp('te-sib-');
  for (const d of ['acme-web--wt-3', 'acme-backend--wt-3', 'acme-backend', 'solo']) fs.mkdirSync(path.join(base, d));
  const x = tenv.expand('bash {sibling:acme-backend}/s.sh {repo}', path.join(base, 'acme-web--wt-3'));
  assert.equal(x.text, `bash '${path.join(base, 'acme-backend--wt-3')}'/s.sh '${path.join(base, 'acme-web--wt-3')}'`);
  // sin sufijo de copia, el de nombre exacto
  assert.equal(tenv.siblingDir(path.join(base, 'solo'), 'acme-backend').dir, path.join(base, 'acme-backend'));
  assert.match(tenv.expand('{sibling:no-esta}', path.join(base, 'solo')).problem, /no encontré/);
  assert.match(tenv.expand('{sibling:a/b}', path.join(base, 'solo')).problem, /sin barras/);
});

test('T3 TestGate_Environment_PreparedBeforeSuite_TornDownAfter', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', label: 'Base local de Acme', repos: [REPO_API],
    prepare: `export ACME_TEST_SQL=local; echo preparado {repo} >> ${JSON.stringify(registro)}`,
    teardown: `echo "desarmado ACME_TEST_SQL=$ACME_TEST_SQL" >> ${JSON.stringify(registro)}`, requires: ['ACME_TEST_SQL'] }]);
  const d = repo('https://github.com/acme/api.git');
  const r = correr(d, { bin, guides });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.suite_green, true, r.out);
  assert.deepEqual(r.art.test_environment, { name: 'acme-local', label: 'Base local de Acme', prepared: true });
  const lineas = leer(registro).trim().split('\n');
  assert.deepEqual(lineas, [`preparado ${d}`, 'suite ACME_TEST_SQL=local', 'desarmado ACME_TEST_SQL=local'], r.out);
  assert.match(r.out, /entorno «Base local de Acme» listo/);
});

test('T4 TestGate_Environment_PrepareFails_Exit8_SuiteNotRun', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API],
    prepare: 'echo "falta el contenedor acme-sql" >&2; exit 3',
    teardown: `echo desarmado >> ${JSON.stringify(registro)}` }]);
  const d = repo('https://github.com/acme/api.git');
  const r = correr(d, { bin, guides });
  assert.equal(r.status, 8, r.out);
  assert.match(r.out, /entorno sin preparar \(«acme-local»\): la preparación salió 3 \(falta el contenedor acme-sql\)/);
  assert.equal(r.art.env_not_ready, true);
  assert.equal(r.art.suite_green, false);
  assert.equal(r.art.suite_exit, 8);
  assert.doesNotMatch(leer(registro), /suite/, 'la suite no corre');
  assert.match(leer(registro), /desarmado/, 'lo que haya dejado a medias la preparación se desarma');
});

test('T5 TestGate_Environment_RequiredVarMissing_Exit8', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API], prepare: 'export OTRA=1', requires: ['ACME_TEST_SQL'] }]);
  const r = correr(repo('https://github.com/acme/api.git'), { bin, guides });
  assert.equal(r.status, 8, r.out);
  assert.match(r.art.env_not_ready_reason, /no dejó ACME_TEST_SQL/);
  assert.equal(leer(registro), '');
});

test('T6 TestGate_Environment_Timeout_Exit8', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API], prepare: 'sleep 30', timeout_s: 1 }]);
  const t0 = Date.now();
  const r = correr(repo('https://github.com/acme/api.git'), { bin, guides });
  assert.equal(r.status, 8, r.out);
  assert.match(r.art.env_not_ready_reason, /tope de 1 s/);
  assert.ok(Date.now() - t0 < 20000, 'corta al pasar el tope');
});

test('T7 TestGate_Environment_OtherRepoOrOff_Untouched', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API], prepare: `echo preparado >> ${JSON.stringify(registro)}` }]);
  // un repo que no está en ningún entorno corre como siempre (acá, sin la base: rojo de la suite)
  const otro = correr(repo('https://github.com/acme/web.git'), { bin, guides });
  assert.equal(otro.status, 1, otro.out);
  assert.equal(otro.art.test_environment, undefined);
  // apagado en la máquina: no prepara
  const off = correr(repo('https://github.com/acme/api.git'), { bin, guides, extra: { TYCON_TEST_ENV: 'off' } });
  assert.equal(off.status, 1, off.out);
  assert.doesNotMatch(leer(registro), /preparado/);
});

test('T8 TestEnvironment_Name_SkipsAlreadyPrepared', () => {
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API], prepare: 'true' }]);
  const d = repo('https://github.com/acme/api.git');
  const env = { ...process.env, TYCON_GUIDES_DIR: guides, HOME: tmp('te-home-') };
  for (const k of ['TYCON_TEST_ENV', 'TYCON_TEST_ENV_READY']) delete env[k];
  assert.equal(spawnSync(process.execPath, [ENV_JS, 'name', d], { encoding: 'utf8', env }).stdout.trim(), 'acme-local');
  // un repo hermano en el mismo entorno, dentro de una corrida que ya lo preparó, no lo prepara otra vez
  assert.equal(spawnSync(process.execPath, [ENV_JS, 'name', d], { encoding: 'utf8', env: { ...env, TYCON_TEST_ENV_READY: 'otro:acme-local' } }).stdout.trim(), '');
});

test('T9 TestGate_Environment_LeftoverProcess_StoppedAtTheEnd', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const pidFile = path.join(tmp('te-pid-'), 'pid');
  // la preparación deja un «servidor» andando y no hay teardown que lo pare
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API],
    prepare: `export ACME_TEST_SQL=local; (sleep 300 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)})` }]);
  const r = correr(repo('https://github.com/acme/api.git'), { bin, guides });
  assert.equal(r.status, 0, r.out);
  const pid = Number(leer(pidFile).trim());
  assert.ok(pid > 0, 'la preparación dejó su proceso');
  let vivo = true;
  try { process.kill(pid, 0); } catch (_) { vivo = false; }
  assert.equal(vivo, false, `el proceso ${pid} que dejó la preparación quedó andando`);
  assert.match(r.out, /corté lo que la preparación del entorno «acme-local» dejó andando/);
});

test('T10 TestEnvironment_Sibling_IsTheCompanionOnTheStoryBranch', () => {
  const base = tmp('te-hno-');
  const git = (d, ...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], { encoding: 'utf8', env: GIT_ENV });
  const init = (d) => { fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 'p@ejemplo.invalid'); git(d, 'config', 'user.name', 'p'); };
  const hist = path.join(base, 'acme-historias');
  init(hist);
  fs.mkdirSync(path.join(hist, '.tycon')); fs.mkdirSync(path.join(hist, 'stories'));
  fs.writeFileSync(path.join(hist, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - acme-backend\n');
  fs.writeFileSync(path.join(hist, 'stories', 'story-2-1-x.md'), '---\nid: "2.1"\n---\n# x\n');
  git(hist, 'add', '-A'); git(hist, 'commit', '-q', '-m', 'base'); git(hist, 'checkout', '-q', '-b', 'story/2.1-x');
  const back = path.join(base, 'acme-backend');
  init(back); fs.writeFileSync(path.join(back, 'a'), 'a'); git(back, 'add', '-A'); git(back, 'commit', '-q', '-m', 'base');
  const copia = path.join(base, 'acme-backend--otra');
  git(back, 'worktree', 'add', '-q', '-b', 'story/2.1-x', copia);
  const story = path.join(hist, 'stories', 'story-2-1-x.md');
  // con la story: la copia del hermano en la rama de la story, la misma que corre el portón
  assert.equal(fs.realpathSync(tenv.siblingDir(hist, 'acme-backend', { story }).dir), fs.realpathSync(copia));
  // sin story: el repo al lado
  assert.equal(tenv.siblingDir(hist, 'acme-backend').dir, back);
});

test('T11 TeamRepos_BrokenEnvironment_DoesNotStealRepos', () => {
  const bien = { name: 'b', repos: [REPO_API], prepare: 'true' };
  const p = teamRepos.stackProblems({ test_environments: [{ name: 'a', repos: [REPO_API], prepare: '' }, bien] });
  assert.ok(p.some((x) => x.path === 'stack.test_environments.0.prepare'), JSON.stringify(p));
  assert.ok(!p.some((x) => x.path.startsWith('stack.test_environments.1')), `el bueno no carga la culpa: ${JSON.stringify(p)}`);
});

test('T12 TestGate_Environment_LockHeld_Exit75_WithoutPreparing', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-lock', repos: [REPO_API], prepare: `echo preparado >> ${JSON.stringify(registro)}; export ACME_TEST_SQL=1`,
    teardown: `echo desarmado >> ${JSON.stringify(registro)}` }]);
  // otra corrida viva tiene el entorno: este proceso de prueba hace de dueño
  const lockDir = tmp('te-lock-');
  const lock = path.join(lockDir, 'tycon-test-env-acme-lock.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 0, group: null }));
  const r = correr(repo('https://github.com/acme/api.git'), { bin, guides, extra: { TMPDIR: lockDir } });
  assert.equal(r.status, 75, r.out);
  assert.match(r.out, /lo está usando otra corrida/);
  assert.equal(leer(registro), '', 'ni prepara ni desarma el entorno de la otra corrida');
  assert.ok(fs.existsSync(lock), 'el candado ajeno queda');
  // con el dueño muerto, el candado viejo no traba
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, ts: 0, group: null }));
  const r2 = correr(repo('https://github.com/acme/api.git'), { bin, guides, extra: { TMPDIR: lockDir } });
  assert.equal(r2.status, 0, r2.out);
  assert.ok(!fs.existsSync(lock), 'al terminar suelta el candado');
});

test('T13 TestEnvironment_SignalDuringPrepare_StopsAndTearsDown', async (t) => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const pidFile = path.join(tmp('te-pid-'), 'pid');
  // las rutas llegan por el entorno que hereda el paso, no dentro del texto del comando
  process.env.ACME_PROCESS_FILE = pidFile;
  process.env.ACME_LOG = registro;
  t.after(() => { delete process.env.ACME_PROCESS_FILE; delete process.env.ACME_LOG; });
  const env = { name: 'acme-sig', label: 'acme-sig', requires: [], timeout_s: 60,
    prepare: '(sleep 300 >/dev/null 2>&1 & echo $! > "$ACME_PROCESS_FILE"); sleep 30',
    teardown: 'echo desarmado >> "$ACME_LOG"' };
  const d = tmp('te-sig-');
  const p = tenv.run(d, { environment: env, storyArg: '', cmd: ['true'], lockDir: tmp('te-lock-') });
  for (let i = 0; i < 50 && !leer(pidFile).trim(); i++) await new Promise((r) => setTimeout(r, 100));
  process.emit('SIGTERM', 'SIGTERM');
  const code = await p;
  assert.equal(code, 143);
  assert.match(leer(registro), /desarmado/, 'una señal en la preparación desarma igual');
  let vivo = true;
  try { process.kill(Number(leer(pidFile).trim()), 0); } catch (_) { vivo = false; }
  assert.equal(vivo, false, 'lo que la preparación dejó andando se corta');
});

test('T14 TestEnvironment_OwnExitTrap_UnsetAndStoryId', async () => {
  const d = tmp('te-trap-');
  const base = { ...process.env, ACME_SACAR: '1' };
  // una trampa de salida propia (o un unset) no rompe el volcado
  const dump = path.join(d, 'env.json');
  const r = await tenv.step('trap "echo chau" EXIT; export ACME_TEST_SQL=x; unset ACME_SACAR', { cwd: d, env: base, timeoutS: 30, dump, logFile: path.join(d, 'log') });
  assert.equal(r.code, 0, r.output);
  const { env } = tenv.envAfterPrepare(dump, base);
  assert.equal(env.ACME_TEST_SQL, 'x');
  assert.equal('ACME_SACAR' in env, false, 'un unset de la preparación llega a la suite');
  // `exit 0` explícito también vuelca
  const dump2 = path.join(d, 'env2.json');
  const r2 = await tenv.step('export ACME_TEST_SQL=y; exit 0', { cwd: d, env: base, timeoutS: 30, dump: dump2, logFile: path.join(d, 'log2') });
  assert.equal(r2.code, 0);
  assert.equal(tenv.envAfterPrepare(dump2, base).env.ACME_TEST_SQL, 'y');
  const story = path.join(d, 'story-2-1-x.md');
  fs.writeFileSync(story, '---\nid: "2.1"\n---\n');
  assert.equal(tenv.storyIdOf(story), '2.1');
});

test('T15 TestGate_Environment_SuiteRepeat_NotReady_KeepsFullRunArtifact', () => {
  const registro = path.join(tmp('te-reg-'), 'log');
  const bin = herramientas(registro);
  const guides = arbol([{ name: 'acme-local', repos: [REPO_API], prepare: 'exit 3' }]);
  const d = repo('https://github.com/acme/api.git');
  const art = path.join(d, '.advisors', 'tests-result.json');
  fs.mkdirSync(path.dirname(art), { recursive: true });
  fs.writeFileSync(art, '{"de":"la completa"}');
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync(process.execPath, [ENV_JS, 'run', d, '--', 'bash', TEST_GATE, d, '--suite', 'x.test.js'], {
    encoding: 'utf8', cwd: d, env: { ...env, HOME: tmp('te-home-'), PATH: `${bin}:${process.env.PATH}`, TYCON_GUIDES_DIR: guides, TMPDIR: tmp('te-lock-') } });
  assert.equal(r.status, 8, r.stderr);
  assert.equal(fs.readFileSync(art, 'utf8'), '{"de":"la completa"}', 'la repetición de una suite no pisa la constancia de la completa');
});

// 🔴 Falla con: el paso arma el texto de bash con la ruta de node y la del volcado (alerta de CodeQL
//    js/shell-command-injection-from-environment): una ruta con `'` o `$(…)` sería parte del comando.
test('T16 TestEnvironment_Step_PathsAsArguments_NotInTheText', async () => {
  const d = tmp('te-args-');
  const dump = path.join(d, "it's $(echo x) env.json");
  const { script, args } = tenv.stepScript('export ACME_TEST_SQL=z', dump);
  assert.ok(!script.includes(dump), 'la ruta del volcado no va en el texto');
  assert.ok(!script.includes(process.execPath), 'la de node tampoco');
  assert.deepEqual(args.slice(1), [process.execPath, dump], 'van como argumentos');
  assert.deepEqual(tenv.stepScript('true', undefined), { script: 'true', args: [] }, 'sin volcado, el comando tal cual');
  // con esa ruta el volcado anda, y el comando no ve los argumentos
  const base = { ...process.env };
  const r = await tenv.step('export ACME_TEST_SQL=z; echo "args=$#"', { cwd: d, env: base, timeoutS: 30, dump, logFile: path.join(d, 'log') });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /args=0/);
  assert.equal(tenv.envAfterPrepare(dump, base).env.ACME_TEST_SQL, 'z');
  assert.ok(!fs.existsSync(path.join(d, 'x')), 'el $(…) de la ruta no corrió');
});
