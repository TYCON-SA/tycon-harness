#!/usr/bin/env node
/**
 * gate-base-fork.test.js — un portón corrido a mano, sin marcador, acota desde la bifurcación con main.
 *
 * El caso: una rama con sus archivos ya commiteados y el portón corrido a mano, sin una ejecución del pipeline. La base
 * caía a HEAD, el diff no veía lo commiteado, «no sé qué se tocó» y corrían todas las suites (680 en el público). Ahora
 * la base es la bifurcación con la rama principal, y el portón dice al arrancar qué eligió y por qué.
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
const BASE_LIB = path.join(SCRIPTS, 'lib', 'coverage-base.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_TEST_GATE_CROSS_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER', 'TYCON_SUITE_TIMES'];
const CI = 'la CI de GitHub del pedido';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function git(d, ...a) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', '-C', d, ...a], { encoding: 'utf8', env });
  return r.stdout.trim();
}

/** Repo con main y su `origin/main`, y una rama con dos commits propios. */
function forkRepo({ main = true } = {}) {
  const repo = tmp('fork-repo-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  if (main) git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  git(repo, 'checkout', '-q', '-b', 'rama');
  for (const n of ['2', '3']) { fs.writeFileSync(path.join(repo, 'a.txt'), `${n}\n`); git(repo, 'commit', '-q', '-am', n); }
  if (!main) git(repo, 'branch', '-q', '-D', 'main');
  return { repo, base };
}
const resolve = (opts) => require(BASE_LIB).resolver(opts);

test('T9 Base_SinMarcador_Bifurcacion — sin marcador, o con el de otro repo, la base es la bifurcación con main', () => {
  // 🔴 mutación: dejar la bifurcación sólo para la corrida cruzada (cae a HEAD y lo commiteado no se ve).
  const { repo, base } = forkRepo();
  const sin = resolve({ repo, env: {}, marker: null });
  assert.equal(sin.source, 'bifurcacion', JSON.stringify(sin));
  assert.equal(sin.ref, base);
  assert.equal(sin.rama, 'origin/main');
  const otro = forkRepo();
  const ajeno = resolve({ repo, env: {}, marker: { baseSha: otro.base, repoPath: otro.repo } });
  assert.equal(ajeno.source, 'bifurcacion', JSON.stringify(ajeno));
  assert.ok(ajeno.descartadas.some((d) => /otro repo/.test(d.motivo)));
});

test('T10 Base_SinRamaPrincipalCaeAHEAD_OrdenIgual — sin rama principal cae a HEAD con el motivo; la variable y el marcador mandan', () => {
  // 🔴 mutación: inventar una base sin rama principal, o pasar la bifurcación delante de la variable o del marcador.
  const { repo } = forkRepo({ main: false });
  const h = resolve({ repo, env: {}, marker: null });
  assert.equal(h.source, 'HEAD', JSON.stringify(h));
  assert.ok(h.descartadas.some((d) => d.source === 'bifurcacion' && /rama principal/.test(d.motivo)), JSON.stringify(h));
  const f = forkRepo();
  const first = git(f.repo, 'rev-parse', 'HEAD~1');
  assert.equal(resolve({ repo: f.repo, env: { TYCON_COVERAGE_BASE: first }, marker: null }).source, 'env');
  const m = resolve({ repo: f.repo, env: {}, marker: { baseSha: first, repoPath: f.repo } });
  assert.equal(m.source, 'marcador');
  assert.equal(m.ref, first);
});

const suite = (n, nombra = '') => `#!/usr/bin/env bash
# ${nombra}
echo "${n}" >> "$TG_STATE/corridas"
exit 0
`;

/** El repo que acota por repo, con 20 suites, `origin/main` y una rama SIN marcador de pipeline. */
function gateLab({ main = true } = {}) {
  const home = tmp('fork-home-');
  const state = tmp('fork-state-');
  const skills = tmp('fork-skills-');
  const repo = tmp('fork-gate-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const tests = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(tests, { recursive: true });
  const names = Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, '0')}.test.sh`);
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: names.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}` })), semanales: [] }, null, 2));
  for (const n of names) fs.writeFileSync(path.join(tests, n), suite(n));
  // s05 prueba lib/acme.js; s06 lee la guía docs/guia-acme.md
  fs.writeFileSync(path.join(tests, 's05.test.sh'), suite('s05.test.sh', 'prueba lib/acme.js'));
  fs.writeFileSync(path.join(tests, 's06.test.sh'), suite('s06.test.sh', 'lee docs/guia-acme.md'));
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lib', 'acme.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'guia-acme.md'), 'x\n');
  fs.writeFileSync(path.join(repo, '.test-gate.yaml'), `test_gate:\n  scope: touched\n  full_suite_by: "${CI}"\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  if (main) git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  git(repo, 'checkout', '-q', '-b', 'rama');
  if (!main) git(repo, 'branch', '-q', '-D', 'main');
  return { home, state, skills, repo, base, tests };
}
function gate(l) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, l.repo], { cwd: l.repo, encoding: 'utf8', timeout: 180000,
    env: { ...env, HOME: l.home, USERPROFILE: l.home, TG_STATE: l.state, TYCON_SKILLS_DIR: l.skills } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const ran = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean).sort(); } catch (_) { return []; } };
const summary = (l) => JSON.parse(fs.readFileSync(path.join(l.repo, '.advisors', 'tests-result.json'), 'utf8'));

/** El caso de la mañana del 4/11: cinco archivos commiteados (cuatro suites y la biblioteca que prueba s05). */
function commitFive(l) {
  for (const n of ['s01', 's02', 's03', 's04']) fs.appendFileSync(path.join(l.tests, `${n}.test.sh`), '# tocada\n');
  fs.writeFileSync(path.join(l.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'cinco archivos');
}

test('T11 Porton_CasoDel4_11_NoCorreTodas — sin marcador y con lo tocado commiteado, corren las suites de lo tocado', () => {
  // 🔴 mutación: la base sin marcador vuelve a HEAD → «🟠 sin base» y corren las 20; o, con la bifurcación, la rama de
  //    sólo un .md se lee como desconocida (el chequeo de commits propios de la base del marcador).
  const l = gateLab();
  commitFive(l);
  const r = gate(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(ran(l), ['s01.test.sh', 's02.test.sh', 's03.test.sh', 's04.test.sh', 's05.test.sh'], r.out);
  assert.doesNotMatch(r.out, /sin base/);

  const md = gateLab();
  fs.writeFileSync(path.join(md.repo, 'docs', 'guia-acme.md'), 'y\n');
  git(md.repo, 'commit', '-q', '-am', 'sólo la guía');
  const rm = gate(md);
  assert.equal(rm.status, 0, rm.out);
  assert.deepEqual(ran(md), ['s06.test.sh'], rm.out);
});

test('T12 Porton_LineaYResumenDeSeleccion — el portón dice qué eligió, desde dónde y por qué', () => {
  // 🔴 mutación: callar la selección, o no dejarla en el resumen.
  const l = gateLab();
  commitFive(l);
  const r = gate(l);
  assert.match(r.out, new RegExp(`acotado a lo tocado: 5 archivos desde ${l.base.slice(0, 7)} \\(bifurcacion\\): corren 5 de 20`), r.out);
  const sel = summary(l).totals.seleccion;
  assert.deepEqual(sel, { base: l.base, fuente: 'bifurcacion', tocados: 5, corren: 5, total: 20 });

  const sinMain = gateLab({ main: false });
  commitFive(sinMain);
  const rs = gate(sinMain);
  assert.match(rs.out, /sin acotar: .*: corren 20 de 20/, rs.out);
  assert.equal(ran(sinMain).length, 20);
});
