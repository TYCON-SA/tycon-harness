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
  // La rama se nombra, para no depender de cómo la nombra el git de la máquina (el de Apple nace en `main`). `master`:
  // el corredor la reconoce como principal (la T3 lo necesita) y no es `main`, que el portón usa de respaldo para saber
  // qué se tocó (con ella, la T4 sabría qué se tocó).
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
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
  assert.match(r.out, /la suite completa la corre la CI de GitHub del pedido/);
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
  assert.doesNotMatch(r.out, /la suite completa la corre la CI de GitHub del pedido/);
  assert.equal(artefacto(l).scoped_by_repo, undefined);
});

test('T3 PortonAcotado_NadieLee_Verde — con la clave y un cambio que ninguna suite lee, sale verde sin correr nada y lo dice', () => {
  // 🔴 mutación: sin la excepción del informe, la puerta saldría 6 («no corrió ninguna prueba»).
  const l = lab({ clave: true });
  fs.writeFileSync(path.join(l.repo, 'docs', 'x.md'), 'y\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), [], r.out);
  assert.match(r.out, /ninguna suite lee lo tocado; la suite completa la corre la CI de GitHub del pedido/);
  assert.equal(artefacto(l).suite_green, true);
});

function sinSaberQueSeToco() {
  const l = lab({ clave: true });
  const mf = path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.baseSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.writeFileSync(mf, JSON.stringify(m));
  fs.writeFileSync(path.join(l.repo, 'scripts', 'tests', 'b.test.sh'), '#!/usr/bin/env bash\necho b >> "$TG_STATE/corridas"\nexit 1\n');
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'b roja');
  const r = puerta(l);
  // la completa no corre en la máquina: sin saber qué se tocó no corre nada y sale «sin acotar», que no es verde
  assert.equal(r.status, 7, r.out);
  assert.deepEqual(corridas(l), [], r.out);
  assert.match(r.out, /sin acotar: la cubre la CI del pedido/);
  assert.doesNotMatch(r.out, /en esta máquina corrieron sólo las suites que leen lo tocado/);
  const art = artefacto(l);
  assert.notEqual(art.suite_green, true, JSON.stringify(art));
  assert.equal(art.unscoped, true);
  assert.equal(art.scoped_by_repo, undefined);
}

test('T4 PortonAcotado_SinSaberQueSeToco_NoCorreNada_YNoEsVerde — con la clave y la base del marcador ilegible sale «sin acotar» sin correr', () => {
  // 🔴 mutación: sin saber qué se tocó, correr todas las suites en la máquina (la completa la corre la CI del pedido), o
  // cerrar en verde sin haber corrido nada.
  sinSaberQueSeToco();
});

test('T18 PortonAcotado_T4_NoDependeDeLaRamaDeFabrica @story-8.230 @ac-18 — con un git que nace en main, la T4 da lo mismo', (t) => {
  // 🔴 mutación: el repo de juguete nace con `git init` a secas → con init.defaultBranch=main la rama de trabajo es la
  // principal, no hay nada tocado contra ella, y la puerta sale «sin acotar» sin correr las suites.
  const cfg = path.join(tmp('acot-gitcfg-'), 'gitconfig');
  fs.writeFileSync(cfg, '[init]\n\tdefaultBranch = main\n');
  const antes = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  t.after(() => { if (antes === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = antes; });
  sinSaberQueSeToco();
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

// ── El tamaño antes del turno ─────────────────────────────────────────────────────────────────────────

// El registro de tiempos de la máquina de prueba: el mismo archivo que lee el aviso de portón lento.
function tiempos(l, suites) {
  const dir = require('../lib/state-dir.js').stateDir(l.home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'suite-times.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), suites })}\n`);
}

// Un turno falso en el repo de prueba: deja una marca en la salida cuando se pide, para ver qué salió antes.
function turnoFalso(l) {
  const dir = path.join(l.repo, 'scripts', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heavy-turn.js'), "module.exports = { BUSY_EXIT: 77, take() { console.log('TURNO-PEDIDO'); return { ok: true, taken: true }; }, release() {} };\n");
}

const RENGLON = /\[suites\.json\] portón acotado: (\d+) de (\d+) suites · ([^\n]*)/g;

test('T19 ScopedGate_AnnouncesSizeBeforeTurn @story-8.279 @ac-4 — el acotado dice cuántas suites de cuántas y los minutos, una sola vez; sin medida, «sin estimación»', () => {
  // 🔴 mutación: sin el renglón (o con el aviso de portón lento sólo desde cien suites), nadie sabe el tamaño antes del turno.
  const con = lab({ clave: true });
  tiempos(con, [{ s: 'tests/a.test.sh', ms: 180000 }]);
  fs.writeFileSync(path.join(con.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const r1 = puerta(con);
  assert.equal(r1.status, 0, r1.out);
  const m1 = [...r1.out.matchAll(RENGLON)];
  assert.equal(m1.length, 1, r1.out);
  assert.deepEqual([m1[0][1], m1[0][2]], ['1', '2'], r1.out);
  assert.match(m1[0][3], /~3 min/, r1.out);
  // antes de la línea de los carriles, que sale con el turno ya tomado
  assert.ok(r1.out.indexOf(m1[0][0]) < r1.out.indexOf('en paralelo:'), r1.out);

  const sin = lab({ clave: true });
  fs.writeFileSync(path.join(sin.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const r2 = puerta(sin);
  assert.equal(r2.status, 0, r2.out);
  const m2 = [...r2.out.matchAll(RENGLON)];
  assert.equal(m2.length, 1, r2.out);
  assert.match(m2[0][3], /sin estimación/, r2.out);
});

test('T20 ScopedGate_LargeAnnouncesAlmostFull @story-8.279 @ac-5 — un acotado de cien suites o más dice «casi una completa», antes de pedir el turno y sin repetir el aviso lento', () => {
  // 🔴 mutación: el renglón sale después de `turn.take`, o se imprime además el «🔴 portón lento» de siempre.
  const l = lab({ clave: true });
  // con el tope de la máquina de fábrica (60) un acotado no llega a cien: este repo lo sube (va en el commit de abajo)
  fs.appendFileSync(path.join(l.repo, '.test-gate.yaml'), '  max_local_suites: 200\n');
  const tests = path.join(l.repo, 'scripts', 'tests');
  const lista = [];
  for (let i = 0; i < 100; i += 1) {
    fs.writeFileSync(path.join(tests, `n${i}.test.sh`), suite(`n${i}`, 'prueba lib/acme.js'));
    lista.push({ raiz: 'arnes', ruta: `tests/n${i}.test.sh` });
  }
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }, { raiz: 'arnes', ruta: 'tests/b.test.sh' }, ...lista], semanales: [] }, null, 2));
  turnoFalso(l);
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'cien suites');
  const mf = path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.baseSha = git(l.repo, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(mf, JSON.stringify(m));
  fs.writeFileSync(path.join(l.repo, 'lib', 'acme.js'), 'module.exports = 2;\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  const ms = [...r.out.matchAll(RENGLON)];
  assert.equal(ms.length, 1, r.out);
  assert.deepEqual([ms[0][1], ms[0][2]], ['101', '102'], r.out);
  assert.match(ms[0][3], /casi una completa: pide turno como una completa/, r.out);
  assert.ok(r.out.includes('TURNO-PEDIDO'), r.out);
  assert.ok(r.out.indexOf(ms[0][0]) < r.out.indexOf('TURNO-PEDIDO'), r.out);
  assert.doesNotMatch(r.out, /portón lento/, r.out);
});
