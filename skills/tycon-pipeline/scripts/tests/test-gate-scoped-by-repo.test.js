'use strict';

/**
 * test-gate-scoped-by-repo.test.js — el portón acotado por el repo: con `test_gate` en `.test-gate.yaml`, la puerta
 * corre en la máquina sólo las suites que leen lo tocado y dice que la suite completa la corre la CI del pedido.
 *
 * Corre test-gate.sh entero sobre un repo de prueba con dos suites de bash (una nombra `lib/acme.js`, la otra no) y una
 * HOME de prueba con un marcador falso.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE',
  'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER'];
const SID = 'acotada-sesion';
const CI = 'la CI de GitHub del pedido';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function git(d, ...a) {
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', '-C', d, ...a], { encoding: 'utf8' });
}

const suite = (n, nombra = '') => `#!/usr/bin/env bash
# ${nombra}
echo "${n}" >> "$TG_STATE/corridas"
exit 0
`;

function lab({ clave }) {
  const home = tmp('acot-home-');
  const state = tmp('acot-state-');
  const skills = tmp('acot-skills-');
  const repo = tmp('acot-repo-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const tests = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }, { raiz: 'arnes', ruta: 'tests/b.test.sh' }], semanales: [] }, null, 2));
  fs.writeFileSync(path.join(tests, 'a.test.sh'), suite('a', 'prueba lib/acme.js'));
  fs.writeFileSync(path.join(tests, 'b.test.sh'), suite('b'));
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lib', 'acme.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'x\n');
  if (clave) {
    fs.writeFileSync(path.join(repo, '.test-gate.yaml'), `test_gate:\n  scope: touched\n  full_suite_by: "${CI}"\n`);
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const l = { home, state, skills, repo, base: git(repo, 'rev-parse', 'HEAD').stdout.trim() };
  const mf = path.join(home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  fs.writeFileSync(mf, JSON.stringify({
    storyId: 'adhoc-acotada', storyPath: '', repoPath: repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8, 9, 10, 11],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {},
  }));
  return l;
}

function puerta(l) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, l.repo], { cwd: l.repo, encoding: 'utf8', timeout: 120000,
    env: { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, TG_STATE: l.state, TYCON_SKILLS_DIR: l.skills } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean).sort(); } catch (_) { return []; } };
const artefacto = (l) => JSON.parse(fs.readFileSync(path.join(l.repo, '.advisors', 'tests-result.json'), 'utf8'));

test('T1 PortonAcotado_ConClave_CorreSoloLoTocado — con la clave commiteada corre sólo la suite que lee lo tocado y el cierre dice quién corre la completa', () => {
  // 🔴 mutación: sin leer la clave, la puerta corre las dos; sin la línea del cierre, nadie sabe que la completa quedó para la CI.
  const l = lab({ clave: true });
  fs.writeFileSync(path.join(l.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), ['a'], r.out);
  assert.match(r.out, /la suite completa la corre la CI del pedido \(la CI de GitHub del pedido\)/);
  const art = artefacto(l);
  assert.equal(art.suite_green, true, JSON.stringify(art));
  assert.deepEqual(art.scoped_by_repo, { full_suite_by: CI, none_touched: false });
});

test('T2 PortonAcotado_SinClave_CorreTodo — sin la clave, todo como siempre', () => {
  // 🔴 mutación: acotar sin la clave cambiaría el portón de todos los repos.
  const l = lab({ clave: false });
  fs.writeFileSync(path.join(l.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), ['a', 'b'], r.out);
  assert.doesNotMatch(r.out, /la suite completa la corre la CI del pedido \(/);
  assert.equal(artefacto(l).scoped_by_repo, undefined);
});

test('T3 PortonAcotado_NadieLee_Verde — con la clave y un cambio que ninguna suite lee, sale verde sin correr nada y lo dice', () => {
  // 🔴 mutación: sin la excepción del informe, la puerta saldría 6 («no corrió ninguna prueba»).
  const l = lab({ clave: true });
  fs.writeFileSync(path.join(l.repo, 'docs', 'x.md'), 'y\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), [], r.out);
  assert.match(r.out, /ninguna suite lee lo tocado; la suite completa la corre la CI del pedido/);
  assert.equal(artefacto(l).suite_green, true);
});

test('T4 PortonAcotado_SinSaberQueSeToco_CorreTodo_YUnaRojaFrena — con la clave y la base del marcador ilegible corre todas, y una roja sale roja', () => {
  // 🔴 mutación: acotar sin saber qué se tocó sale «sin acotar» sin correr nada, y el cierre lo acepta con la suite b roja.
  const l = lab({ clave: true });
  const mf = path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.baseSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.writeFileSync(mf, JSON.stringify(m));
  fs.writeFileSync(path.join(l.repo, 'scripts', 'tests', 'b.test.sh'), '#!/usr/bin/env bash\necho b >> "$TG_STATE/corridas"\nexit 1\n');
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'b roja');
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.notEqual(r.status, 7, r.out);
  assert.deepEqual(corridas(l), ['a', 'b'], r.out);
  assert.match(r.out, /el repo acota el portón, pero no sé qué se tocó .*: corren todas las suites/);
  assert.doesNotMatch(r.out, /en esta máquina corrieron sólo las suites que leen lo tocado/);
  const art = artefacto(l);
  assert.equal(art.suite_green, false, JSON.stringify(art));
  assert.equal(art.unscoped, undefined);
  assert.equal(art.scoped_by_repo, undefined);
});

test('T5 PortonAcotado_TodasPedidas_ElCierreNoDiceAcotado — con TYCON_GATE_ALL_SUITES=1 corren todas y el cierre no dice que corrieron sólo las tocadas', () => {
  // 🔴 mutación: el cierre mira sólo la clave, no lo que hizo el corredor, y dice «corrieron sólo las que leen lo tocado».
  const l = lab({ clave: true });
  fs.writeFileSync(path.join(l.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, l.repo], { cwd: l.repo, encoding: 'utf8', timeout: 120000,
    env: { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, TG_STATE: l.state, TYCON_SKILLS_DIR: l.skills, TYCON_GATE_ALL_SUITES: '1' } });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.deepEqual(corridas(l), ['a', 'b'], out);
  assert.doesNotMatch(out, /en esta máquina corrieron sólo las suites que leen lo tocado/);
});
