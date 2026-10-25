'use strict';

/**
 * test-gate-failed-first.test.js — después de un rojo, la puerta pide primero en verde la suite que falló.
 *
 * Una corrida completa de la puerta (la de arriba, sin `--suite`) que sale roja anota en el marcador las suites que
 * fallaron (`testsFailed`). Mientras quede alguna, la corrida completa no lanza nada: sale 76 y da el comando para
 * repetir cada una sola. `test-gate.sh <repo> --suite <ruta>` corre sólo esa suite, con el ambiente de la completa, y
 * en verde la saca de la lista; nunca escribe `checks.tests` ni `tests-result.json`.
 *
 * Todo corre sobre un repo de prueba con su propio `scripts/tests/suites.json` (dos suites de bash que salen con el
 * código que diga un archivo de estado) y una HOME de prueba con un marcador falso por sesión.
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado, y la hora de cada entrada de la lista no se compara con nada.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const STEP_06 = path.resolve(SCRIPTS, '..', 'steps', 'step-06-run-tests.md');
const GUIDE = path.resolve(SCRIPTS, '..', '..', '..', 'guides', 'test-execution-discipline.md');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE',
  'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER'];

const A = 'tests/a.test.sh';
const B = 'tests/b.test.sh';
const SID = 'ff-sesion';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function git(d, ...a) {
  const fecha = '2026-01-01T00:00:00Z';
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
}

// Una suite de bash que anota que corrió y con qué ambiente, y sale con el código de su archivo de estado (0 si no hay).
const suite = (n, extra = '') => `#!/usr/bin/env bash
${extra}
echo "${n}" >> "$FF_STATE/corridas"
echo "TYCON_TEST_GATE=\${TYCON_TEST_GATE:-} TYCON_SUITE_RUNNER=\${TYCON_SUITE_RUNNER:-} TYCON_MAILBOX=\${TYCON_MAILBOX:-}" > "$FF_STATE/${n}.env"
exit "$(cat "$FF_STATE/${n}" 2>/dev/null || echo 0)"
`;

/** El laboratorio: repo con suites.json y dos suites, HOME de prueba, marcador falso y carpeta de estado. */
function lab({ a = 0, b = 0, marcador = true, size = null, suiteB = suite('b') } = {}) {
  const home = tmp('ff-home-');
  const state = tmp('ff-state-');
  const skills = tmp('ff-skills-');
  const repo = tmp('ff-repo-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const tests = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }], semanales: [] }, null, 2));
  fs.writeFileSync(path.join(tests, 'a.test.sh'), suite('a'));
  fs.writeFileSync(path.join(tests, 'b.test.sh'), suiteB);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  // la base de la corrida (la del marcador): sin ella la puerta no sabe qué se tocó y la corrida liviana corre todo
  const l = { home, state, skills, repo, base: git(repo, 'rev-parse', 'HEAD').stdout.trim() };
  estado(l, { a, b });
  if (marcador) escribirMarcador(l, { size });
  return l;
}

function estado(l, { a, b }) {
  if (a !== undefined) fs.writeFileSync(path.join(l.state, 'a'), String(a));
  if (b !== undefined) fs.writeFileSync(path.join(l.state, 'b'), String(b));
}

const markerFile = (l, sid = SID) => path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);

function escribirMarcador(l, { size = null, checks = {}, testsFailed } = {}) {
  fs.mkdirSync(path.dirname(markerFile(l)), { recursive: true });
  fs.writeFileSync(markerFile(l), JSON.stringify({
    storyId: '9.125', storyPath: '', repoPath: l.repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8, 9, 10, 11],
    filesTouched: [], iterations: {}, fileEvents: [], checks, ...(size ? { size } : {}), ...(testsFailed ? { testsFailed } : {}),
  }));
}

const marcador = (l) => JSON.parse(fs.readFileSync(markerFile(l), 'utf8'));
const lista = (l) => (marcador(l).testsFailed || []).map((x) => x.ruta);
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const limpiarCorridas = (l) => fs.rmSync(path.join(l.state, 'corridas'), { force: true });
const artefacto = (l) => path.join(l.repo, '.advisors', 'tests-result.json');

function entorno(l, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, FF_STATE: l.state, TYCON_SKILLS_DIR: l.skills, ...extra };
}

function puerta(l, args = [], extra = {}) {
  const r = spawnSync('bash', [TEST_GATE, l.repo, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 120000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function marker(l, args, extra = {}) {
  const r = spawnSync(process.execPath, [MARKER_JS, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 30000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** Un laboratorio que ya pasó por una corrida completa roja con A y B. */
function conRojo() {
  const l = lab({ a: 1, b: 1 });
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(lista(l), [A, B], r.out);
  limpiarCorridas(l);
  return l;
}

test('T1 FailedFirst_RedRun_SavesRoutes @story-8.125 @ac-1 — una corrida completa roja guarda las rutas de las suites que fallaron', () => {
  const l = lab({ a: 1, b: 1 });
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(lista(l), [A, B], r.out);
  assert.ok(marcador(l).testsFailed.every((x) => x.raiz === 'arnes' && x.at), 'cada entrada trae su raíz y su hora');
  assert.equal(marcador(l).checks.testsFailed, undefined, 'la lista no va dentro de checks');
});

test('T2 FailedFirst_SuiteAlone_GreenClears @story-8.125 @ac-2 — `--suite` de una ya arreglada corre sólo esa y la saca', () => {
  const l = conRojo();
  estado(l, { a: 0 });
  const r = puerta(l, ['--suite', A]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), ['a'], 'corrió algo más que la suite pedida');
  assert.deepEqual(lista(l), [B], r.out);
});

test('T3 FailedFirst_SuiteAlone_RedStays @story-8.125 @ac-2 — `--suite` de una que sigue roja la deja en la lista', () => {
  const l = conRojo();
  const r = puerta(l, ['--suite', A]);
  assert.notEqual(r.status, 0, r.out);
  assert.notEqual(r.status, 76, r.out);
  assert.deepEqual(lista(l), [A, B], r.out);
});

test('T4 FailedFirst_SuiteAlone_SameEnv @story-8.125 @ac-2 — la suite sola ve el mismo ambiente de la puerta que en la completa', () => {
  const l = conRojo();
  const completa = fs.readFileSync(path.join(l.state, 'a.env'), 'utf8');
  fs.rmSync(path.join(l.state, 'a.env'));
  puerta(l, ['--suite', A]);
  const sola = fs.readFileSync(path.join(l.state, 'a.env'), 'utf8');
  assert.equal(sola, completa);
  assert.match(sola, /TYCON_SUITE_RUNNER=test-gate /, 'la puerta no puso su ambiente');
});

test('T5 FailedFirst_FullRunWithPending_Refuses @story-8.125 @ac-3 — con la lista pendiente la completa no lanza, sale 76 y da los comandos', () => {
  const l = conRojo();
  const antes = marcador(l).checks.tests;
  fs.writeFileSync(artefacto(l), JSON.stringify({ suite_green: true, ts: 'vieja' }));
  const r = puerta(l);
  assert.equal(r.status, 76, r.out);
  assert.deepEqual(corridas(l), [], 'la negativa lanzó alguna suite');
  for (const ruta of [A, B]) assert.ok(r.out.includes(`--suite ${ruta}`), `no da el comando de ${ruta}:\n${r.out}`);
  assert.ok(r.out.includes(TEST_GATE), `el comando no nombra la puerta:\n${r.out}`);
  assert.equal(marcador(l).checks.tests, antes, 'la negativa cambió checks.tests');
  assert.ok(!fs.existsSync(artefacto(l)), 'quedó un tests-result.json con la negativa');
});

test('T6 FailedFirst_AllCleared_FullRuns @story-8.125 @ac-4 — con las dos repetidas en verde, la completa arranca', () => {
  const l = conRojo();
  estado(l, { a: 0, b: 0 });
  assert.equal(puerta(l, ['--suite', A]).status, 0);
  assert.equal(puerta(l, ['--suite', B]).status, 0);
  limpiarCorridas(l);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l).sort(), ['a', 'b']);
  assert.deepEqual(lista(l), []);
});

test('T7 FailedFirst_RouteGone_Dropped @story-8.125 @ac-5 — una ruta que ya no está en suites.json sale de la lista y lo dice', () => {
  const l = conRojo();
  const sj = path.join(l.repo, 'scripts', 'tests', 'suites.json');
  fs.writeFileSync(sj, JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }], semanales: [] }));
  const r = puerta(l);
  assert.equal(r.status, 76, r.out);
  assert.match(r.out, new RegExp(`${B.replace(/\./g, '\\.')}.*ya no está en suites\\.json`), r.out);
  assert.deepEqual(lista(l), [A]);
});

test('T8 FailedFirst_RedWithoutFailures_NoList @story-8.125 @ac-6 — un rojo sin suites que fallaron (no pudo correr) no deja lista', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.repo, 'scripts', 'tests', 'suites.json'), '{ esto no es json');
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(lista(l), [], r.out);
});

test('T9 FailedFirst_UnknownSuite_Fails @story-8.125 @ac-7 — `--suite` con una ruta que no está sale distinto de 0 y lo dice', () => {
  const l = lab();
  const r = puerta(l, ['--suite', 'tests/no-existe.test.sh']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /tests\/no-existe\.test\.sh.*no está en .*suites\.json/, r.out);
  assert.deepEqual(corridas(l), []);
  assert.equal(marcador(l).checks['tests-suite'], undefined, 'anotó un check sin correr nada');
});

test('T10 FailedFirst_SuiteGreen_NotAFullGreen @story-8.125 @ac-8 — una suite sola en verde no deja verde checks.tests ni cierra el paso', () => {
  const l = lab();
  const r = puerta(l, ['--suite', A]);
  assert.equal(r.status, 0, r.out);
  const m = marcador(l);
  assert.equal(m.checks.tests, undefined, 'la suite sola escribió checks.tests');
  assert.equal(m.checks['tests-suite'], 'green');
  assert.ok(!fs.existsSync(artefacto(l)), 'la suite sola escribió tests-result.json');
  const c = marker(l, ['complete-step', 'run-tests']);
  assert.notEqual(c.status, 0, `complete-step run-tests cerró con una suite sola:\n${c.out}`);
});

test('T11 FailedFirst_SuiteRed_KeepsPrevious @story-8.125 @ac-8 — una suite sola, roja o verde, deja checks.tests como estaba', () => {
  const l = conRojo();
  const antes = marcador(l).checks.tests;
  assert.match(String(antes), /^red/);
  puerta(l, ['--suite', B]);
  assert.equal(marcador(l).checks.tests, antes, 'la suite roja cambió checks.tests');
  estado(l, { a: 0 });
  puerta(l, ['--suite', A]);
  assert.equal(marcador(l).checks.tests, antes, 'la suite verde cambió checks.tests');
});

test('T12 FailedFirst_Guides_NameTheCommand @story-8.125 @ac-9 — las dos guías dicen que se repite primero la suite que falló, con el comando', () => {
  for (const g of [STEP_06, GUIDE]) {
    const linea = fs.readFileSync(g, 'utf8').split('\n').find((x) => /repetir primero la suite que fall[oó]/i.test(x));
    assert.ok(linea, `${path.basename(g)} no trae la línea`);
    assert.match(linea, /test-gate\.sh <repo> <story> --suite <ruta>/, `${path.basename(g)}: la línea no trae el comando completo`);
  }
});

test('T13 FailedFirst_NewFullRun_Replaces @story-8.125 @ac-10 — una corrida completa nueva reemplaza la lista: roja con sus fallas, verde la vacía', () => {
  const l = lab({ a: 1, b: 0 });
  puerta(l);
  assert.deepEqual(lista(l), [A]);
  // un resumen rojo sólo con B reemplaza la lista (no la suma)
  const resumen = path.join(l.state, 'resumen.json');
  fs.writeFileSync(resumen, JSON.stringify({ fallas: [{ ruta: path.join(l.repo, 'scripts', B), exit: 1, cola: '', entrada: { raiz: 'arnes', ruta: B } }] }));
  const r = marker(l, ['tests-failed', 'record', '--summary', resumen, '--repo', l.repo], { TYCON_TEST_GATE: '1' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(lista(l), [B]);
  estado(l, { a: 0, b: 0 });
  assert.equal(puerta(l, ['--suite', B]).status, 0);
  const verde = puerta(l);
  assert.equal(verde.status, 0, verde.out);
  assert.deepEqual(lista(l), []);
});

test('T14 FailedFirst_PartOrCompanion_NoList @story-8.125 @ac-11 — una corrida de parte o de repo hermano no guarda lista ni se niega', () => {
  for (const extra of [{ TYCON_TEST_GATE_PART: '1' }, { TYCON_TEST_GATE_COMPANION: '1' }]) {
    const l = lab({ a: 1, b: 1 });
    escribirMarcador(l, { testsFailed: [{ ruta: A, raiz: 'arnes', repo: l.repo, at: new Date().toISOString() }] });
    const r = puerta(l, [], extra);
    assert.notEqual(r.status, 76, `${Object.keys(extra)[0]} se negó:\n${r.out}`);
    // la del repo hermano es cruzada: sin nada tocado no corre ninguna suite (sale 7), y tampoco se niega
    if (extra.TYCON_TEST_GATE_PART) assert.deepEqual(corridas(l).sort(), ['a', 'b'], `la parte no corrió:\n${r.out}`);
    else assert.equal(r.status, 7, `el repo hermano:\n${r.out}`);
    assert.deepEqual(lista(l), [A], `${Object.keys(extra)[0]} cambió la lista`);
  }
});

test('T15 FailedFirst_TrimmedRun_CountsAsFull @story-8.125 @ac-12 — una corrida con los recortes de la puerta cuenta como completa', () => {
  // cruzada (la story en otro repo): corre sólo lo tocado, y con la lista pendiente se niega igual
  const l = lab({ a: 1, b: 1 });
  escribirMarcador(l, { testsFailed: [{ ruta: A, raiz: 'arnes', repo: l.repo, at: new Date().toISOString() }] });
  const otro = tmp('ff-story-');
  git(otro, 'init', '-q');
  fs.writeFileSync(path.join(otro, 'story.md'), '---\nstory: "9.125"\nfiles_to_modify:\n  - docs/x.md\n---\n');
  const r = puerta(l, [path.join(otro, 'story.md')]);
  assert.equal(r.status, 76, r.out);
  assert.deepEqual(corridas(l), []);
  // liviana (sólo documentación tocada): corre la suite que lee lo tocado, y su rojo queda en la lista
  const m = lab({ a: 0, b: 1, size: 'liviana', suiteB: suite('b', '# lee docs/x.md') });
  fs.appendFileSync(path.join(m.repo, 'docs', 'x.md'), 'cambio\n');
  const v = puerta(m);
  assert.notEqual(v.status, 0, v.out);
  assert.deepEqual(corridas(m), ['b'], `no fue una corrida liviana:\n${v.out}`);
  assert.deepEqual(lista(m), [B], v.out);
});

test('T16 FailedFirst_NoOpCases_Said @story-8.125 @ac-13 — los casos sin efecto no cambian nada y lo dicen', () => {
  const l = lab({ a: 0, b: 1 });
  escribirMarcador(l, { testsFailed: [{ ruta: B, raiz: 'arnes', repo: l.repo, at: new Date().toISOString() }] });
  assert.equal(puerta(l, ['--suite', A]).status, 0);
  assert.deepEqual(lista(l), [B], '--suite verde fuera de la lista la cambió');
  estado(l, { a: 1 });
  assert.notEqual(puerta(l, ['--suite', A]).status, 0);
  assert.deepEqual(lista(l), [B], '--suite roja fuera de la lista agregó su ruta');
  // sin corrida abierta: salen 0, no escriben y lo dicen
  const sin = lab({ marcador: false });
  const resumen = path.join(sin.state, 'resumen.json');
  fs.writeFileSync(resumen, JSON.stringify({ fallas: [{ ruta: 'x', exit: 1, cola: '', entrada: { raiz: 'arnes', ruta: A } }] }));
  for (const args of [['tests-failed', 'record', '--summary', resumen], ['tests-failed', 'clear', '--path', A]]) {
    const r = marker(sin, [...args, '--repo', sin.repo], { TYCON_TEST_GATE: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /sin corrida abierta/, r.out);
  }
  assert.ok(!fs.existsSync(markerFile(sin)), 'escribió un marcador sin corrida abierta');
});

test('T17 FailedFirst_OtherRepo_Isolated @story-8.125 @ac-14 — la corrida de otro repo en la misma sesión no reemplaza, no saca ni pide la lista de éste', () => {
  const l = conRojo();
  const otro = lab({ a: 0, b: 0, marcador: false });
  const env = { HOME: l.home, USERPROFILE: l.home, FF_STATE: otro.state };
  // otra corrida completa, verde, en otro repo con las mismas rutas y el mismo marcador
  const r = spawnSync('bash', [TEST_GATE, otro.repo], { cwd: otro.repo, encoding: 'utf8', env: entorno(l, env), timeout: 120000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(lista(l), [A, B], 'el verde del otro repo vació la lista de éste');
  const s = spawnSync('bash', [TEST_GATE, otro.repo, '--suite', A], { cwd: otro.repo, encoding: 'utf8', env: entorno(l, env), timeout: 120000 });
  assert.equal(s.status, 0, `${s.stdout}\n${s.stderr}`);
  assert.deepEqual(lista(l), [A, B], 'la suite sola del otro repo sacó una ruta de éste');
  assert.ok(marcador(l).testsFailed.every((x) => x.repo === l.repo), 'una entrada sin el repo de su corrida');
  // y la lista de éste no frena la completa del otro: la de arriba ya arrancó (salió 0, no 76)
  assert.equal(puerta(l).status, 76, 'la lista de éste dejó de pedirse');
});

test('T18 FailedFirst_StorySwitch_Resets @story-8.125 @ac-15 — cambiar de story con `marker.js set` no hereda la lista de la anterior', () => {
  const l = conRojo();
  const r = marker(l, ['set', JSON.stringify({ storyId: '9.126', storyPath: '', repoPath: l.repo }), '--replace']);
  assert.equal(r.status, 0, r.out);
  assert.equal(marcador(l).storyId, '9.126', r.out);
  assert.deepEqual(lista(l), [], 'la story nueva heredó las suites que fallaron en la anterior');
});

test('T19 FailedFirst_HandWrites_Refused @story-8.125 @ac-16 — `record` y `clear` a mano, sin la puerta, se niegan y no cambian la lista', () => {
  const l = conRojo();
  const resumen = path.join(l.state, 'vacio.json');
  fs.writeFileSync(resumen, JSON.stringify({ fallas: [] }));
  for (const args of [['tests-failed', 'record', '--summary', resumen, '--repo', l.repo], ['tests-failed', 'clear', '--path', A, '--repo', l.repo]]) {
    const r = marker(l, args);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /sólo lo usa test-gate\.sh/, r.out);
  }
  assert.deepEqual(lista(l), [A, B]);
});
