'use strict';

/**
 * test-gate-failed-first.test.js — después de un rojo, la puerta pide primero en verde la suite que falló.
 *
 * Una corrida completa de la puerta (la de arriba, sin `--suite`) que sale roja anota en el marcador las suites que
 * fallaron (`testsFailed`). Mientras quede alguna, la corrida completa no lanza nada: sale 76 y da el comando para
 * repetir cada una sola. `test-gate.sh <repo> --suite <ruta>` corre sólo esa suite, con el ambiente de la completa, y
 * en verde la saca de la lista; no escribe `checks.tests` (salvo la última roja de una corrida acotada, casos
 * «UltimaRojaRepetida_AcotadaDejaTestsVerde»), y de `tests-result.json` sólo saca su falla si la constancia es de la
 * misma completa (casos «RepetirVerdeConSuite_ReescribeLaConstancia»).
 *
 * Todo corre sobre un repo de prueba con su propio `scripts/tests/suites.json` (dos suites de bash que salen con el
 * código que diga un archivo de estado) y una HOME de prueba con un marcador falso por sesión.
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado, y la hora de cada entrada de la lista no se compara con nada.
 */

// partida sin mover sus pruebas: cada parte es test-gate-failed-first.p<k>.test.js (cuáles, suite-parts.json de esta carpeta)
const test = require('./lib/suite-parts.js').test;
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
function lab({ a = 0, b = 0, marcador = true, size = null, suiteB = suite('b'), suiteA = suite('a'), acota = false } = {}) {
  const home = tmp('ff-home-');
  const state = tmp('ff-state-');
  const skills = tmp('ff-skills-');
  const repo = tmp('ff-repo-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const tests = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }], semanales: [] }, null, 2));
  fs.writeFileSync(path.join(tests, 'a.test.sh'), suiteA);
  fs.writeFileSync(path.join(tests, 'b.test.sh'), suiteB);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'x\n');
  fs.writeFileSync(path.join(repo, 'docs', 'y.md'), 'y\n');
  // el repo acota el portón, como los del arnés: la completa la corre la CI del pedido
  if (acota) {
    fs.writeFileSync(path.join(repo, '.test-gate.yaml'), 'test_gate:\n  scope: touched\n  full_suite_by: "la CI de prueba"\n');
    // como en los repos de verdad: lo que deja la puerta no es parte de la carpeta que se mide
    fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  }
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

// ── Repetir solas cierra ───────────────────────────────────────────────────────────────────────────────────────────
// En un repo que acota el portón: una completa roja guarda lo que midió; con las rojas repetidas en verde sobre la misma
// carpeta, la completa cierra sin correr nada; con la carpeta cambiada, corren sólo las suites que leen lo cambiado.
// 🔴 Falla con: cerrar sobre una carpeta que no midió nadie (un arreglo deshecho), con la base o la lista de suites
//    cambiadas, con lo guardado tocado a mano, o con el atajo en un repo cuya completa no corre nadie después.
const leeX = (n) => suite(n, '# lee docs/x.md');
const guardado = (l) => (marcador(l).testsRedFull || []).find((x) => x.repo === l.repo) || null;

/** El repo que acota, con las dos suites rojas en una completa sobre docs/x.md cambiado (las dos lo leen). */
function conRojoAcotado({ suiteB = leeX('b') } = {}) {
  const l = lab({ a: 1, b: 1, acota: true, suiteA: leeX('a'), suiteB });
  fs.appendFileSync(path.join(l.repo, 'docs', 'x.md'), 'cambio de la historia\n');
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(corridas(l).sort(), ['a', 'b'], `la completa no corrió las dos:\n${r.out}`);
  limpiarCorridas(l);
  return l;
}
function repetirVerdes(l) {
  estado(l, { a: 0, b: 0 });
  for (const s of [A, B]) assert.equal(puerta(l, ['--suite', s]).status, 0);
  limpiarCorridas(l);
}

test('T25 Porton_CompletaRoja_GuardaLoMedido — la completa roja guarda su resumen, su foto y su base; la repetición verde, su foto', () => {
  const l = conRojoAcotado();
  const g = guardado(l);
  assert.ok(g && g.repo && g.hash && g.dir, `no guardó nada: ${JSON.stringify(marcador(l))}`);
  for (const f of ['resumen.json', 'medido.json']) assert.ok(fs.existsSync(path.join(g.dir, f)), `falta ${f}`);
  assert.ok(!g.dir.includes(`${path.sep}.advisors${path.sep}`), 'lo guardado no vive en .advisors/');
  repetirVerdes(l);
  const rep = JSON.parse(fs.readFileSync(path.join(guardado(l).dir, 'repetidas.json'), 'utf8'));
  assert.deepEqual(Object.keys(rep).sort(), [A, B]);
  assert.ok(Object.values(rep).every((x) => /^[0-9a-f]{40}$/.test(x.tree)), 'cada repetición con la foto de su carpeta');
  // en un repo que no acota no se guarda: la completa no la corre nadie después
  const n = lab({ a: 1, b: 1 });
  puerta(n);
  assert.equal(guardado(n), null);
  // con la carpeta cambiada mientras corría la completa se guarda con la foto del arranque: la próxima corrida vuelve a
  // correr lo que lee lo cambiado durante la corrida
  const mueve = suite('a', '# lee docs/x.md\necho otra >> "$FF_TOUCH"');
  const c = lab({ a: 1, b: 1, acota: true, suiteA: mueve, suiteB: leeX('b') });
  fs.appendFileSync(path.join(c.repo, 'docs', 'x.md'), 'cambio de la historia\n');
  const rc = puerta(c, [], { FF_TOUCH: path.join(c.repo, 'docs', 'y.md') });
  assert.notEqual(rc.status, 0, rc.out);
  assert.ok(guardado(c), `no guardó la completa roja con la foto del arranque:\n${rc.out}`);
  assert.match(rc.out, /la carpeta cambió mientras corría: guardo con la foto del arranque/);
});

test('T26 Porton_RepetidasSolas_CarpetaIgual_CierraSinCompleta — no corre nada, deja el verde por run-check y lo dice', () => {
  const l = conRojoAcotado();
  repetirVerdes(l);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), [], `corrió suites:\n${r.out}`);
  assert.match(r.out, /cierra con la completa de las \d\d:\d\d y 2 suites repetidas solas: la carpeta no cambió/);
  const art = JSON.parse(fs.readFileSync(artefacto(l), 'utf8'));
  assert.equal(art.suite_exit, 0, JSON.stringify(art).slice(0, 400));
  assert.equal(art.suite_green, true);
  assert.equal(art.totals.suites, 2, 'el resumen juntado trae las dos suites');
  assert.equal(art.totals.passed, 2);
  assert.match(String(art.coverage.joined || ''), /completa roja .* 2 suites repetidas solas/, 'el informe dice que la cobertura es juntada');
  assert.match(r.out, /cobertura juntada:/);
  assert.equal(marcador(l).checks.tests, 'green');
  assert.equal(guardado(l), null, 'lo guardado se borró');
});

test('T27 Porton_RepetidasSolas_CarpetaCambio_SoloLasQueLoLeen — lo cambiado corre; base, lista o constancia distintas corren todo', () => {
  // docs/y.md lo lee sólo b: el arreglo cambia y.md antes de repetir
  const l = conRojoAcotado({ suiteB: suite('b', '# lee docs/x.md y docs/y.md') });
  fs.appendFileSync(path.join(l.repo, 'docs', 'y.md'), 'el arreglo\n');
  repetirVerdes(l);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l), ['b'], `no corrió sólo la que lee lo cambiado:\n${r.out}`);
  assert.equal(JSON.parse(fs.readFileSync(artefacto(l), 'utf8')).totals.suites, 2, 'el resumen juntado trae las dos suites');
  // la base movida (main avanzó) sin cambiar la carpeta: lo traído es un cambio más, y acá no cambió nada
  const bm = conRojoAcotado();
  repetirVerdes(bm);
  git(bm.repo, 'commit', '-q', '--allow-empty', '-m', 'main avanzó');
  const mk = marcador(bm);
  mk.baseSha = git(bm.repo, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(markerFile(bm), JSON.stringify(mk));
  const u = puerta(bm);
  assert.equal(u.status, 0, u.out);
  assert.deepEqual(corridas(bm), [], u.out);
  assert.doesNotMatch(u.out, /la base cambió desde la completa roja/);
  // un cambio después de repetir: ya no la completa, sino las que leen lo cambiado y las repetidas viejas
  const d = conRojoAcotado();
  repetirVerdes(d);
  fs.appendFileSync(path.join(d.repo, 'docs', 'x.md'), 'otra vuelta\n');
  const v = puerta(d);
  assert.equal(v.status, 0, v.out);
  assert.deepEqual(corridas(d).sort(), ['a', 'b'], v.out);
  assert.doesNotMatch(v.out, /corre la completa como siempre/);
  // la lista de suites cambiada: completa
  const s = conRojoAcotado();
  repetirVerdes(s);
  const sj = path.join(s.repo, 'scripts', 'tests', 'suites.json');
  fs.writeFileSync(sj, fs.readFileSync(sj, 'utf8').replace('"diarias"', '"diarias" '));
  const w = puerta(s);
  assert.equal(w.status, 0, w.out);
  assert.deepEqual(corridas(s).sort(), ['a', 'b']);
  assert.match(w.out, /cambió la lista de suites/);
  // lo guardado tocado a mano: completa
  const m = conRojoAcotado();
  repetirVerdes(m);
  const rf = path.join(guardado(m).dir, 'resumen.json');
  fs.appendFileSync(rf, ' ');
  const x = puerta(m);
  assert.deepEqual(corridas(m).sort(), ['a', 'b'], x.out);
  assert.match(x.out, /lo guardado no coincide con su constancia/);
});

test('T27 Porton_RepetidasSolas_LoQueLaCorridaNuevaDiceCuenta — una ausente, una suite que vuelve a correr, la cobertura vieja', () => {
  const ff = require('../lib/failed-first.js');
  const d = tmp('ff-guardado-');
  const resumen = path.join(d, 'r.json');
  const medido = path.join(d, 'm.json');
  const lcov = path.join(d, 'l.info');
  fs.writeFileSync(resumen, JSON.stringify({ suites: [{ ruta: '/r/scripts/tests/a.test.sh', exit: 1 }, { ruta: '/r/scripts/tests/c.test.sh', exit: 0 }],
    fallas: [{ ruta: '/r/scripts/tests/a.test.sh', entrada: { raiz: 'arnes', ruta: A } }], ausentes: [],
    deferred_suites: [{ suite: '/r/scripts/tests/g.test.sh', reason: 'corre de noche y en el control del PR; esta story no toca G/**' }] }));
  fs.writeFileSync(medido, JSON.stringify({ tree: 'a'.repeat(40) }));
  fs.writeFileSync(lcov, 'SF:lib/cambiado.js\nDA:1,1\nend_of_record\nSF:lib/quieto.js\nDA:1,1\nend_of_record\n');
  const dir = path.join(d, 'g');
  ff.saveRed({ dir, summaryFile: resumen, lcovFile: lcov, measuredFile: medido, base: null, recorte: '' });
  ff.addRepeat(dir, A, { tree: 'b'.repeat(40), entry: { ruta: '/r/scripts/tests/a.test.sh', exit: 0 } });
  // una suite que se fue entre la completa y el cierre: la corrida nueva la da ausente, y es rojo como en una completa
  const out = ff.merge({ dir, newSummary: { suites: [], fallas: [], ausentes: ['/r/scripts/tests/c.test.sh'] } });
  assert.deepEqual(out.ausentes, ['/r/scripts/tests/c.test.sh']);
  assert.ok(!out.suites.some((s) => s.ruta === '/r/scripts/tests/c.test.sh'), 'la ausente no queda verde por la completa vieja');
  assert.equal(ff.mergedRed(out), true);
  assert.equal(ff.mergedRed(ff.merge({ dir, newSummary: { suites: [], fallas: [], no_medido: 'corrida interrumpida' } })), true);
  // la cobertura de un archivo cambiado después de la completa no se junta: se midió sobre el código viejo
  const cov = path.join(d, 'cov');
  ff.merge({ dir, covDir: cov, changed: ['lib/cambiado.js'] });
  const junto = fs.readFileSync(path.join(cov, 'lcov.info'), 'utf8');
  assert.doesNotMatch(junto, /SF:lib\/cambiado\.js/);
  assert.match(junto, /SF:lib\/quieto\.js/);
  // lo cambiado vuelve a hacer correr una suite que la completa difirió por sus carpetas: vuelve por su carpeta
  const repo = tmp('ff-repo-gate-');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/g.test.sh', gate_only_when_touching: ['G/**'] }, { raiz: 'arnes', ruta: 'tests/i.test.sh' }] }));
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'resumen.json'), 'utf8'));
  assert.deepEqual(ff.suitesPorSusCarpetas(repo, ['G/x.js'], res).map((x) => x.nombre), ['g.test.sh']);
  assert.deepEqual(ff.suitesPorSusCarpetas(repo, ['lib/otro.js'], res), []);
  // ídem con una suite del grupo del instalador: el criterio es el del repo medido, y sólo con lo guardado rojo fuera del árbol
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'heavy-suites.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'suites-for-change.js'),
    "module.exports = { groupCriterion: () => ({ incluye: (name) => name === 'i.test.sh', skips: (name, files) => !files.some((f) => f.startsWith('installer/')) }) };\n");
  const inst = { deferred_suites: [{ suite: '/r/scripts/tests/i.test.sh', reason: 'corre de noche y en el control del PR; esta story no toca el instalador (el grupo installer de scripts/ci/heavy-suites.json)' }] };
  assert.deepEqual(ff.suitesPorSusCarpetas(repo, ['installer/x.sh'], inst, { instalador: true }).map((x) => x.nombre), ['i.test.sh']);
  assert.deepEqual(ff.suitesPorSusCarpetas(repo, ['lib/otro.js'], inst, { instalador: true }), []);
  assert.deepEqual(ff.suitesPorSusCarpetas(repo, ['installer/x.sh'], inst, { instalador: false }), [], 'con lo guardado verde, el instalador lo frena antes claseQuePideLaCompleta');
  // decide: otro recorte, o una roja sin su repetición verde, corren la completa
  const hash = ff.redHash(dir);
  assert.match(ff.decide({ dir, hash, repo, tree: 'b'.repeat(40), base: null, recorte: '--light' }).reason, /no tiene el mismo recorte/);
  const sola = path.join(d, 'sin-repetir');
  ff.saveRed({ dir: sola, summaryFile: resumen, lcovFile: null, measuredFile: medido, base: null, recorte: '' });
  assert.match(ff.decide({ dir: sola, hash: ff.redHash(sola), repo, tree: 'a'.repeat(40), base: null, recorte: '' }).reason, /falta repetir sola: tests\/a\.test\.sh/);
});

test('T27 Porton_LoGuardadoFueraDeSuCarpeta_NoSeBorra — drop-red sólo borra dentro de red-full/', () => {
  const l = lab({ acota: true });
  const ajena = tmp('ff-ajena-');
  fs.writeFileSync(path.join(ajena, 'no-borrar.txt'), 'x');
  const mk = marcador(l);
  mk.testsRedFull = [{ repo: l.repo, dir: ajena, hash: 'x', at: new Date().toISOString() }];
  fs.writeFileSync(markerFile(l), JSON.stringify(mk));
  const r = marker(l, ['tests-failed', 'drop-red', '--repo', l.repo], { TYCON_TEST_GATE: '1' });
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(path.join(ajena, 'no-borrar.txt')), 'borró una carpeta fuera de red-full/');
  assert.match(r.out, /apunta fuera de/);
  assert.equal(guardado(l), null, 'igual lo saca del marcador');
});

test('T27 Porton_SinCorrida_LoGuardadoEsNull — red-full sin corrida abierta da null, que el portón lee como JSON', () => {
  const l = lab({ marcador: false, acota: true });
  const r = marker(l, ['tests-failed', 'red-full', '--repo', l.repo]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'null');
});

test('T13 FailedFirst_DecideGreen_ClassesFromLists @story-8.263 @ac-3 @ac-6 — con lo guardado verde, cada clase pide la completa y lo demás acota', () => {
  const ff = require('../lib/failed-first.js');
  const repo = tmp('ff-clases-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'p@e.invalid'); git(repo, 'config', 'user.name', 'p');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  escribir('scripts/tests/suites.json', JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }] }));
  escribir('scripts/ci/control-x.js', '// control\n');
  escribir('scripts/ci/controls-from-base.json', JSON.stringify({ controls: [{ name: 'x', script: 'scripts/ci/control-x.js', rules: [] }], content: ['datos/'], workflows: [], approvals: [] }));
  escribir('scripts/ci/heavy-suites.json', JSON.stringify({ shared: { patterns: ['lib/shared/**'] }, groups: { installer: { patterns: ['installer/**'] } }, suites: {} }));
  fs.copyFileSync(path.resolve(SCRIPTS, '..', '..', '..', 'scripts', 'ci', 'suites-for-change.js'), path.join(repo, 'scripts', 'ci', 'suites-for-change.js'));
  for (const rel of ['installer/a.sh', 'lib/shared/a.js', 'datos/a.json', 'docs/a.md']) escribir(rel, 'v1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const arbol = () => { git(repo, 'add', '-A'); return git(repo, 'write-tree').stdout.trim(); };
  const d = tmp('ff-verde-');
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ suites: [], fallas: [] }));
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ tree: arbol() }));
  const dir = path.join(d, 'g');
  const hash = ff.saveGreen({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: null, recorte: '', storyId: '9.263' });
  const decidir = () => ff.decide({ dir, hash, repo, tree: arbol(), base: null, recorte: '', storyId: '9.263' });
  for (const [rel, clase] of [['scripts/ci/control-x.js', 'un control'], ['datos/a.json', 'un control'], ['installer/a.sh', 'el instalador'],
    ['lib/shared/a.js', 'algo compartido'], ['scripts/tests/suites.json', 'la lista de suites']]) {
    const antes = fs.readFileSync(path.join(repo, rel), 'utf8');
    fs.appendFileSync(path.join(repo, rel), rel.endsWith('.json') ? ' ' : 'v2\n');
    const r = decidir();
    assert.deepEqual([r.mode, r.reason], ['full', `cambió ${clase} (${rel})`], rel);
    fs.writeFileSync(path.join(repo, rel), antes);
  }
  fs.appendFileSync(path.join(repo, 'docs', 'a.md'), 'v2\n');
  const r = decidir();
  assert.deepEqual([r.mode, r.origen, r.files], ['changed', 'verde', ['docs/a.md']]);
});

test('FailedFirst_DecideWithoutStory_RunsFull @story-8.263 @ac-3 — sin saber de qué historia es la corrida, lo guardado de una historia no se usa', () => {
  const ff = require('../lib/failed-first.js');
  const repo = tmp('ff-sin-historia-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'p@e.invalid'); git(repo, 'config', 'user.name', 'p');
  fs.writeFileSync(path.join(repo, 'a.md'), 'v1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const arbol = () => { git(repo, 'add', '-A'); return git(repo, 'write-tree').stdout.trim(); };
  const d = tmp('ff-sin-historia-g-');
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ suites: [], fallas: [] }));
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ tree: arbol() }));
  const dir = path.join(d, 'g');
  const hash = ff.saveGreen({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: null, recorte: '', storyId: '9.263' });
  for (const storyId of [null, '']) {
    const r = ff.decide({ dir, hash, repo, tree: arbol(), base: null, recorte: '', storyId });
    assert.deepEqual([r.mode, r.reason], ['full', 'no sé de qué historia es esta corrida: lo guardado es de la 9.263'], JSON.stringify(storyId));
  }
});

// ── El arreglo después del portón ─────────────────────────────────────────────────────────────────────
// Una repetición vieja (la carpeta cambió después de repetirla) o main traído ya no corren la completa: corren las suites
// que leen lo cambiado desde la completa y las repetidas viejas, reconocidas por su entrada de la lista de suites.
// 🔴 Falla con: la completa de siempre por `otraCarpeta` o por la base; la repetida vieja pasada como archivo tocado
//    (su clave es de la lista, relativa a scripts/, y el filtro de lo tocado descarta lo que tiene forma de suite); o el
//    resultado nuevo de la repetida sumado al lado del viejo en vez de reemplazarlo.

// a falla salvo que exista docs/arreglo-a (el arreglo de la historia); b lee docs/y.md; c lee docs/z.md y docs/w.md.
const suiteA = suite('a', '# lee docs/x.md\nif [ -f "$FF_REPO/docs/arreglo-a" ]; then echo 0 > "$FF_STATE/a"; else echo 1 > "$FF_STATE/a"; fi');
const C = 'tests/c.test.sh';

/** Un repo que acota con tres suites: la completa toca x.md (a, b) y z.md (c); a y b salen rojas, c verde. */
function conTres() {
  const l = lab({ a: 1, b: 1, acota: true, suiteA, suiteB: suite('b', '# lee docs/x.md y docs/y.md') });
  const tests = path.join(l.repo, 'scripts', 'tests');
  fs.writeFileSync(path.join(tests, 'c.test.sh'), suite('c', '# lee docs/z.md y docs/w.md'));
  fs.writeFileSync(path.join(tests, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }, { raiz: 'arnes', ruta: C }], semanales: [] }, null, 2));
  for (const f of ['z.md', 'w.md', 'nadie.md']) fs.writeFileSync(path.join(l.repo, 'docs', f), `${f}\n`);
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'tres suites');
  l.base = git(l.repo, 'rev-parse', 'HEAD').stdout.trim();
  escribirMarcador(l);
  fs.appendFileSync(path.join(l.repo, 'docs', 'x.md'), 'cambio de la historia\n');
  fs.appendFileSync(path.join(l.repo, 'docs', 'z.md'), 'cambio de la historia\n');
  const r = puerta(l, [], { FF_REPO: l.repo });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(corridas(l).sort(), ['a', 'b', 'c'], `la completa no corrió las tres:\n${r.out}`);
  limpiarCorridas(l);
  return l;
}
const repetirSola = (l, s) => { const r = puerta(l, ['--suite', s], { FF_REPO: l.repo }); assert.equal(r.status, 0, r.out); };

test('T6a Gate_FixAfterRepeat_OnlyChangedReaders @story-8.279 @ac-6 — repetida A, arreglada B después: corren B y A (vieja), no la completa', () => {
  const l = conTres();
  fs.writeFileSync(path.join(l.repo, 'docs', 'arreglo-a'), 'ok\n');
  repetirSola(l, A);
  estado(l, { b: 0 });
  fs.appendFileSync(path.join(l.repo, 'docs', 'y.md'), 'el arreglo de b\n');
  repetirSola(l, B);
  limpiarCorridas(l);
  const r = puerta(l, [], { FF_REPO: l.repo });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(corridas(l).sort(), ['a', 'b'], `c no lee lo cambiado y no es repetida: no corre\n${r.out}`);
  assert.match(r.out, /la carpeta cambió desde la completa roja .*: corren sólo las suites que leen lo cambiado/);
  assert.doesNotMatch(r.out, /corre la completa como siempre/);
  const art = JSON.parse(fs.readFileSync(artefacto(l), 'utf8'));
  assert.equal(art.suite_green, true, JSON.stringify(art).slice(0, 400));
  assert.equal(art.totals.suites, 3, 'una entrada por suite: la nueva reemplaza a la vieja');
});

test('T6b Gate_UndoneFix_StaleRepeatRerunsBySuiteEntry @story-8.279 @ac-6 — el arreglo de A deshecho después de repetirla: A vuelve a correr (por su entrada tests/a.test.sh) y el portón cierra en rojo', () => {
  const l = conTres();
  fs.writeFileSync(path.join(l.repo, 'docs', 'arreglo-a'), 'ok\n');
  estado(l, { b: 0 });
  repetirSola(l, A);
  repetirSola(l, B);
  fs.rmSync(path.join(l.repo, 'docs', 'arreglo-a'));
  limpiarCorridas(l);
  const r = puerta(l, [], { FF_REPO: l.repo });
  assert.notEqual(r.status, 0, `un arreglo deshecho no puede cerrar en verde:\n${r.out}`);
  assert.ok(corridas(l).includes('a'), r.out);
  assert.ok(!corridas(l).includes('c'), r.out);
  const art = JSON.parse(fs.readFileSync(artefacto(l), 'utf8'));
  assert.equal(art.suite_green, false);
  assert.equal(art.totals.suites, 3, 'una entrada por suite');
});

test('T6c Gate_MainBroughtIn_OnlyChangedReaders @story-8.279 @ac-7 — main traído: lo que nadie lee no corre nada; lo que lee c corre c; la lista de suites, la completa', () => {
  const traer = (l, cambio) => {
    cambio();
    git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'main');
    const mk = marcador(l);
    mk.baseSha = git(l.repo, 'rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(markerFile(l), JSON.stringify(mk));
    limpiarCorridas(l);
    return puerta(l, [], { FF_REPO: l.repo });
  };
  const listo = () => { const l = conTres(); fs.writeFileSync(path.join(l.repo, 'docs', 'arreglo-a'), 'ok\n'); estado(l, { b: 0 }); repetirSola(l, A); repetirSola(l, B); return l; };
  // un archivo que ninguna suite lee: c no corre (a y b, sí: sus repeticiones quedaron viejas)
  const n = listo();
  const r1 = traer(n, () => fs.appendFileSync(path.join(n.repo, 'docs', 'nadie.md'), 'de main\n'));
  assert.equal(r1.status, 0, r1.out);
  assert.deepEqual(corridas(n).filter((x) => x === 'c'), [], r1.out);
  assert.doesNotMatch(r1.out, /la base cambió desde la completa/);
  // uno que lee c: corre c
  const c = listo();
  const r2 = traer(c, () => fs.appendFileSync(path.join(c.repo, 'docs', 'w.md'), 'de main\n'));
  assert.equal(r2.status, 0, r2.out);
  assert.ok(corridas(c).includes('c'), r2.out);
  assert.doesNotMatch(r2.out, /corre la completa como siempre/);
  // la lista de suites: la completa, con su motivo
  const s = listo();
  const sj = path.join(s.repo, 'scripts', 'tests', 'suites.json');
  const r3 = traer(s, () => fs.writeFileSync(sj, fs.readFileSync(sj, 'utf8').replace('"diarias"', '"diarias" ')));
  assert.match(r3.out, /corre la completa como siempre: .*lista de suites/);
});

test('T6d FailedFirst_DecideTree_StaleRepeatByFingerprint @story-8.279 @ac-6 — en el árbol armado, la huella de una línea alcanza: `changed` con la repetida vieja en `rerun`', () => {
  const ff = require('../lib/failed-first.js');
  const am = require('../lib/after-main.js');
  const nuevoRepo = (n) => {
    const d = tmp(`ff-arbol-${n}-`);
    git(d, 'init', '-q'); git(d, 'config', 'user.email', 'p@e.invalid'); git(d, 'config', 'user.name', 'p');
    fs.writeFileSync(path.join(d, 'a.md'), 'v1\n');
    git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
    return d;
  };
  const priv = nuevoRepo('priv');
  const pub = nuevoRepo('pub');
  const foto = () => {
    const lado = (d) => { git(d, 'add', '-A'); return { head: git(d, 'rev-parse', 'HEAD').stdout.trim(), tree: git(d, 'write-tree').stdout.trim() }; };
    return { origen: { privado: priv, publico: pub, fuente: 'rama' }, privado: lado(priv), publico: lado(pub) };
  };
  const d = tmp('ff-arbol-g-');
  const enCompleta = foto();
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ suites: [{ ruta: `/tmp/arbol-1/scripts/${A}`, exit: 1, ms: 1, entrada: { raiz: 'arnes', ruta: A } }],
    fallas: [{ ruta: `/tmp/arbol-1/scripts/${A}`, entrada: { raiz: 'arnes', ruta: A } }] }));
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify(enCompleta));
  const dir = path.join(d, 'g');
  ff.saveRed({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: null, recorte: '', storyId: '9.279' });
  fs.appendFileSync(path.join(priv, 'a.md'), 'el arreglo\n');
  const hash = ff.addRepeat(dir, A, { tree: am.huellaDeFoto(foto()), entry: { ruta: `/tmp/arbol-2/scripts/${A}`, exit: 0, ms: 1, entrada: { raiz: 'arnes', ruta: A } } });
  fs.appendFileSync(path.join(pub, 'a.md'), 'después de repetir\n');
  const r = ff.decide({ dir, hash, repo: pub, tree: foto(), base: null, recorte: '', storyId: '9.279' });
  assert.equal(r.mode, 'changed', JSON.stringify(r));
  assert.deepEqual(r.rerun, [A], JSON.stringify(r));
  assert.deepEqual(r.files.sort(), ['a.md'], JSON.stringify(r));
});

test('T6e FailedFirst_Merge_ReplacesBySuiteEntry @story-8.279 @ac-6 — en el árbol armado la ruta del resumen cambia con la carpeta temporal: la entrada nueva reemplaza a la vieja por su entrada de la lista', () => {
  const ff = require('../lib/failed-first.js');
  const d = tmp('ff-merge-');
  const en = (base, exit) => ({ ruta: `${base}/scripts/${A}`, exit, ms: 1, entrada: { raiz: 'arnes', ruta: A } });
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ suites: [en('/tmp/arbol-1', 1)], fallas: [{ ...en('/tmp/arbol-1', 1) }] }));
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ tree: 'a'.repeat(40) }));
  const dir = path.join(d, 'g');
  ff.saveRed({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: null, recorte: '', storyId: '9.279' });
  ff.addRepeat(dir, A, { tree: 'b'.repeat(40), entry: en('/tmp/arbol-2', 0) });
  const out = ff.merge({ dir, newSummary: { suites: [en('/tmp/arbol-3', 1)], fallas: [en('/tmp/arbol-3', 1)] } });
  assert.equal(out.suites.length, 1, JSON.stringify(out.suites));
  assert.equal(out.suites[0].exit, 1);
  assert.equal(out.fallas.length, 1, JSON.stringify(out.fallas));
});

/** Un repo con un control declarado y una completa roja guardada (con su repetición) sobre la carpeta de ahora. */
function rojaConControl() {
  const ff = require('../lib/failed-first.js');
  const repo = tmp('ff-control-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'p@e.invalid'); git(repo, 'config', 'user.name', 'p');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  escribir('scripts/tests/suites.json', JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }] }));
  escribir('scripts/ci/control-x.js', '// control\n');
  escribir('scripts/ci/controls-from-base.json', JSON.stringify({ controls: [{ name: 'x', script: 'scripts/ci/control-x.js', rules: [] }], content: [], workflows: [], approvals: [] }));
  escribir('docs/a.md', 'v1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const arbol = () => { git(repo, 'add', '-A'); return git(repo, 'write-tree').stdout.trim(); };
  const d = tmp('ff-control-g-');
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ suites: [], fallas: [{ ruta: `/x/scripts/${A}`, entrada: { raiz: 'arnes', ruta: A } }] }));
  fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ tree: arbol() }));
  const dir = path.join(d, 'g');
  ff.saveRed({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: 'base-vieja', recorte: '', storyId: '9.279' });
  const hash = ff.addRepeat(dir, A, { tree: arbol(), entry: { ruta: `/x/scripts/${A}`, exit: 0, ms: 1, entrada: { raiz: 'arnes', ruta: A } } });
  return { ff, repo, dir, hash, arbol, escribir };
}

test('T6f Gate_MainTouchesControl_FullAsToday @story-8.279 @ac-7 — main traído que cambia un control corre la completa con su motivo, aunque lo guardado sea rojo', () => {
  const { ff, repo, dir, hash, arbol } = rojaConControl();
  fs.appendFileSync(path.join(repo, 'scripts', 'ci', 'control-x.js'), '// de main\n');
  const r = ff.decide({ dir, hash, repo, tree: arbol(), base: 'base-nueva', recorte: '', storyId: '9.279' });
  assert.deepEqual([r.mode, r.reason], ['full', 'cambió un control (scripts/ci/control-x.js)'], JSON.stringify(r));
  // un papel traído de main, en cambio, acota
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'control-x.js'), '// control\n');
  fs.appendFileSync(path.join(repo, 'docs', 'a.md'), 'de main\n');
  const p = ff.decide({ dir, hash, repo, tree: arbol(), base: 'base-nueva', recorte: '', storyId: '9.279' });
  assert.equal(p.mode, 'changed', JSON.stringify(p));
});

test('T7e PrivateGate_NoSnapshot_FullAsToday @story-8.279 @ac-8 — sin foto, lo guardado tocado, de otra historia o con otro recorte: la completa como hoy, con su motivo', () => {
  const { ff, repo, dir, hash, arbol } = rojaConControl();
  const decidir = (o) => ff.decide({ dir, hash, repo, tree: arbol(), base: 'base-vieja', recorte: '', storyId: '9.279', ...o });
  // la carpeta es la misma de la completa y de la repetición: sin ninguna de estas dudas, cerraría con lo guardado
  assert.equal(decidir({}).mode, 'same');
  assert.deepEqual([decidir({ tree: null }).mode, decidir({ tree: null }).reason], ['full', 'no hay foto de la carpeta para comparar']);
  assert.match(decidir({ storyId: '9.999' }).reason, /lo guardado es de otra historia/);
  assert.match(decidir({ recorte: '--light' }).reason, /no tiene el mismo recorte/);
  assert.match(decidir({ hash: 'f'.repeat(64) }).reason, /lo guardado no coincide con su constancia/);
  for (const o of [{ tree: null }, { storyId: '9.999' }, { recorte: '--light' }, { hash: 'f'.repeat(64) }]) assert.equal(decidir(o).mode, 'full');
});

test('T6g RunSuites_RerunWithoutEntry_CountsMissing @story-8.279 @ac-6 — una repetida vieja que no está en la lista no se saltea en silencio: cuenta como ausente y lo dice', () => {
  const repo = tmp('ff-rerun-sin-');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  escribir('scripts/tests/suites.json', JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: A }] }));
  escribir(`scripts/${A}`, '#!/usr/bin/env bash\nexit 0\n');
  escribir('touched.json', JSON.stringify({ known: true, files: [], rerun_suites: [A, 'tests/ya-no-esta.test.sh'], sources: {}, reason: null }));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-suites-json.js'), repo, path.join(repo, 'r.json'), '--skills', path.join(repo, 'skills'),
    '--touched', path.join(repo, 'touched.json'), '--scoped-by-repo', 'la CI de prueba'], { encoding: 'utf8', cwd: repo,
    env: entorno({ home: tmp('ff-rerun-home-'), state: tmp('ff-rerun-state-'), skills: path.join(repo, 'skills') }) });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /tests\/ya-no-esta\.test\.sh/, out);
  const res = JSON.parse(fs.readFileSync(path.join(repo, 'r.json'), 'utf8'));
  assert.ok((res.ausentes || []).some((a) => String(a).includes('ya-no-esta')), JSON.stringify(res.ausentes));
  assert.notEqual(r.status, 0, out);
});

test('T28 Guia_RepetirSolasCierra — el paso 6 y el portón dicen los tres casos, cada uno', () => {
  for (const archivo of [STEP_06, TEST_GATE]) {
    const texto = fs.readFileSync(archivo, 'utf8');
    for (const re of [/la carpeta no cambió/, /sólo las suites que leen lo cambiado/, /corre la completa como siempre/]) assert.match(texto, re, `${path.basename(archivo)}: ${re}`);
  }
});

// T31 Porton_CortadoCortaSuCorredor: cortar el portón corta el corredor y sus suites.
// 🔴 Falla con: el corredor en primer plano sin trampas (bash espera al hijo y la señal no llega), o un corredor que
//    sigue vivo, con el turno de lo pesado, cuando a su portón lo mataron con kill -9.
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function hasta(cond, ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return cond();
}
for (const senal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
  test(`T31 Porton_CortadoCortaSuCorredor — con ${senal}, a los 10 s no queda vivo ni el corredor ni la suite`, async () => {
    const lenta = suite('b', 'echo $$ > "$FF_STATE/b.pid"; sleep 60');
    const l = lab({ suiteB: lenta });
    const { spawn } = require('child_process');
    const p = spawn('bash', [TEST_GATE, l.repo], { cwd: l.repo, env: entorno(l), stdio: 'ignore', detached: true });
    const pidFile = path.join(l.state, 'b.pid');
    assert.ok(await hasta(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 60000), 'la suite lenta arrancó');
    const suitePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const corredor = spawnSync('pgrep', ['-f', `run-suites-json.js ${l.repo}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
    assert.ok(corredor.length > 0, 'el corredor está vivo');
    process.kill(p.pid, senal);
    const muertos = await hasta(() => !vivo(suitePid) && corredor.every((c) => !vivo(c)), 10000);
    try { process.kill(-p.pid, 'SIGKILL'); } catch (_) { /* ya no está */ }
    for (const c of [suitePid, ...corredor]) { try { process.kill(c, 'SIGKILL'); } catch (_) { /* ya no está */ } }
    assert.ok(muertos, `quedó vivo: suite ${vivo(suitePid)}, corredor ${corredor.filter(vivo)}`);
  });
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
  assert.match(r.out, new RegExp(`${B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*ya no está en suites\\.json`), r.out);
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

test('T20 SuiteAlone_Red_KeepsFailedCase — una suite roja por la puerta guarda su caso fallido aunque quede fuera de la cola', () => {
  // 🔴 mutación: guardar sólo la cola de la salida → el caso del medio no llega ni al resumen ni a la consola.
  const larga = suite('b', [
    'for i in $(seq 1 300); do echo "ruido $i"; done',
    'echo "✖ la carpeta global de hooks de git: otra sesión está actualizando"',
    'for i in $(seq 301 600); do echo "ruido $i"; done',
    'exit 1',
  ].join('\n'));
  const l = lab({ suiteB: larga });
  const r = puerta(l, ['--suite', B]);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /✖ la carpeta global de hooks de git: otra sesión está actualizando/, r.out);
  const m = /salida completa: (\S+)/.exec(r.out);
  assert.ok(m && fs.existsSync(m[1]), `nombra el archivo con la salida entera:\n${r.out}`);
  const entera = fs.readFileSync(m[1], 'utf8');
  assert.match(entera, /ruido 1\n/);
  assert.match(entera, /ruido 600\n/);
  assert.match(r.out, /run-check tests-suite/, 'dice que corrió bajo run-check');
  assert.match(r.out, /TYCON_SUITE_RUNNER=test-gate/, 'y con la marca de la puerta');
  const resumen = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(m[1])), 'suites.json'), 'utf8'));
  assert.match(resumen.fallas[0].casos.join('\n'), /carpeta global de hooks/);
  assert.equal(resumen.ambiente.run_check, 'tests-suite');
});

/** Pone en el repo el juez de la validación de cada pedido y la foto nocturna con esas suites rojas. */
function conFoto(l, rojas, casos = null) {
  const ci = path.join(l.repo, 'scripts', 'ci');
  fs.mkdirSync(ci, { recursive: true });
  const origen = path.resolve(SCRIPTS, '..', '..', '..', 'scripts', 'ci');
  for (const f of ['pr-verdict.js', 'legacy-options.js']) fs.copyFileSync(path.join(origen, f), path.join(ci, f));
  fs.mkdirSync(path.join(l.repo, 'scripts', 'controls-bench'), { recursive: true });
  fs.writeFileSync(path.join(l.repo, 'scripts', 'controls-bench', 'ultimo-suites.json'),
    JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), build: '1', failures: rojas, ...(casos ? { casos } : {}) }));
  // La foto llega commiteada en el árbol, como en el privado: una con cambios sin commitear no perdona.
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'foto nocturna');
}

test('T21 InheritedRed_InSnapshot_GateGreen — lo rojo que ya estaba en el nocturno avisa, no frena y no pide repetirse', () => {
  // 🔴 mutación: juzgar contra cero → sale 1, check en rojo y b en la lista de «repetir primero».
  const l = lab({ a: 0, b: 1 });
  conFoto(l, ['b.test.sh']);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ya estaba rojo/, r.out);
  assert.match(r.out, /b\.test\.sh/, 'no nombra lo heredado');
  assert.deepEqual(lista(l), [], r.out);
  assert.match(String(marcador(l).checks.tests), /^green/, r.out);
  assert.equal(JSON.parse(fs.readFileSync(artefacto(l), 'utf8')).suite_green, true);
});

test('T22 InheritedRed_WithNewRed_StillStops — un rojo nuevo sigue frenando, y sólo él queda para repetir primero', () => {
  const l = lab({ a: 1, b: 1 });
  conFoto(l, ['b.test.sh']);
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(lista(l), [A], r.out);
  assert.match(String(marcador(l).checks.tests), /^red/, r.out);
});

test('T23 InheritedRed_UnreadableSnapshot_AsBefore — con la foto ilegible no se perdona nada', () => {
  const l = lab({ a: 0, b: 1 });
  conFoto(l, ['b.test.sh']);
  fs.writeFileSync(path.join(l.repo, 'scripts', 'controls-bench', 'ultimo-suites.json'), '{ roto');
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(lista(l), [B], r.out);
});

test('T24 InheritedRed_SuiteAlone_Forgiven — repetida sola, la que ya estaba roja en el nocturno avisa, no frena y sale de la lista', () => {
  // 🔴 mutación: juzgar sólo en la corrida completa → la repetición sola de b sale 1, queda en la lista y la completa
  // sigue negándose (76) por un rojo que el pedido no frena.
  const l = conRojo();
  conFoto(l, ['b.test.sh']);
  const r = puerta(l, ['--suite', B]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ya estaba rojo/, r.out);
  assert.deepEqual(lista(l), [A], r.out);
  assert.match(String(marcador(l).checks['tests-suite']), /^green/, r.out);
  const a = puerta(l, ['--suite', A]);
  assert.notEqual(a.status, 0, 'un rojo nuevo, repetido solo, sigue frenando');
  assert.deepEqual(lista(l), [A], a.out);
});

test('T22 Repeat_InheritedRed_RecordedAndJudgedAgain @story-8.279 @ac-33 @ac-34 — una roja perdonada repetida sola cuenta como repetida: la completa no corre entera, y su falla vuelve al juez', () => {
  // 🔴 rojo si: la repetición perdonada no se suma a lo guardado → la próxima completa corre entera («falta repetir
  //    sola»); o si `merge` descarta su falla → el cierre sale verde sin que el juez la mire, y un caso nuevo pasaría.
  const casosB = (l, ...c) => fs.writeFileSync(path.join(l.state, 'b.casos'), `${c.map((x) => `✗ ${x}`).join('\n')}\n`);
  const l = conRojoAcotado({ suiteB: suite('b', '# lee docs/x.md\ncat "$FF_STATE/b.casos" 2>/dev/null') });
  casosB(l, 'caso viejo');
  conFoto(l, ['b.test.sh'], { 'b.test.sh': ['✗ caso viejo'] });
  estado(l, { a: 0 });
  assert.equal(puerta(l, ['--suite', A]).status, 0, 'A arreglada, repetida en verde');
  const rb = puerta(l, ['--suite', B]);
  assert.equal(rb.status, 0, rb.out);
  assert.match(rb.out, /ya estaba roja antes del cambio/, rb.out);
  limpiarCorridas(l);
  const r = puerta(l);
  assert.doesNotMatch(r.out, /falta repetir sola|corre la completa como siempre/, r.out);
  assert.deepEqual(corridas(l), [], `ninguna suite lee lo cambiado ni es una repetida vieja:\n${r.out}`);
  assert.match(r.out, /ya estaba rojo en el nocturno[^\n]*b\.test\.sh/, `la falla de B vuelve al juez:\n${r.out}`);
  assert.equal(r.status, 0, r.out);
  // la misma suite con un caso que la foto no conoce, y la carpeta cambiada: B vuelve a correr y frena
  casosB(l, 'caso viejo', 'caso nuevo');
  fs.appendFileSync(path.join(l.repo, 'docs', 'x.md'), 'otro cambio\n');
  limpiarCorridas(l);
  const n = puerta(l);
  assert.notEqual(n.status, 0, n.out);
  assert.match(n.out, /caso nuevo/, n.out);
});

// ── Repetir verde reescribe la constancia ──────────────────────────────────────────────────────────────────────────
// La repetición verde de una suite saca su falla de `.advisors/tests-result.json`, la que lee el revisor de pruebas: si
// no, el revisor pide otra completa por una suite ya repetida en verde. Sólo con la constancia de la misma completa
// (`full_ts` de la lista) y por la entrada de suites.json, nunca por el nombre corto.
const ff = require('../lib/failed-first.js');
const constancia = (l) => JSON.parse(fs.readFileSync(artefacto(l), 'utf8'));

test('RepetirVerdeConSuite_ReescribeLaConstancia (a) @story-8.230 @ac-12 — de a una, cada repetición verde sale de la constancia; con la última, suite_green', () => {
  // 🔴 mutación: no tocar la constancia → failures sigue con a y b, y el revisor pide otra completa.
  const l = conRojo();
  const antes = constancia(l);
  assert.deepEqual(antes.totals.failure_entries, [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }], 'la completa no guardó la entrada de cada falla');
  assert.ok(marcador(l).testsFailed.every((x) => x.full_ts === antes.ts), 'la lista no anotó la hora de su completa');
  estado(l, { a: 0, b: 0 });
  const r = puerta(l, ['--suite', A]);
  assert.equal(r.status, 0, r.out);
  const c1 = constancia(l);
  assert.deepEqual(c1.totals.failures, ['b.test.sh'], r.out);
  assert.deepEqual(c1.totals.failure_entries, [{ raiz: 'arnes', ruta: B }]);
  assert.equal(c1.totals.failed, 1);
  assert.equal(c1.totals.passed, antes.totals.passed + 1);
  assert.equal(c1.repeated_green.length, 1);
  assert.equal(c1.repeated_green[0].ruta, A);
  assert.ok(c1.repeated_green[0].at, 'la repetición no trae su hora');
  assert.equal(c1.suite_green, false);
  assert.equal(c1.suite_exit, antes.suite_exit, 'suite_exit es el de la completa');
  assert.match(r.out, /constancia/, r.out);
  const r2 = puerta(l, ['--suite', B]);
  assert.equal(r2.status, 0, r2.out);
  const c2 = constancia(l);
  assert.deepEqual(c2.totals.failures, []);
  assert.equal(c2.totals.failed, 0);
  assert.equal(c2.suite_green, true, r2.out);
  assert.equal(c2.suite_green_by, 'repeticiones');
  assert.deepEqual(c2.repeated_green.map((x) => x.ruta), [A, B]);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (portón con historia) @story-8.230 @ac-12 — por el portón, la copia que viaja también sale verde', () => {
  // 🔴 mutación: no pasar --sealed desde test-gate.sh, o con otra ruta → la copia sigue roja y la matriz por criterio no
  //    cuenta la repetición.
  const l = lab({ a: 1, b: 0 });
  const historia = path.join(l.repo, 'docs', 'historia-9.125.md');
  fs.writeFileSync(historia, '---\nstory: "9.125"\ntitle: "prueba"\nstatus: in-progress\nfiles_to_modify:\n  - scripts/tests/a.test.sh\n---\n# prueba\n');
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'historia');
  const r = puerta(l, [historia]);
  assert.notEqual(r.status, 0, r.out);
  const copias = () => { const d = path.join(l.repo, '.advisors', 'dod-runtime'); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-tests-result.json')).map((x) => path.join(d, x)) : []; };
  assert.equal(copias().length, 1, `la completa no dejó su copia que viaja:\n${r.out}`);
  assert.equal(JSON.parse(fs.readFileSync(copias()[0], 'utf8')).suite_green, false);
  estado(l, { a: 0 });
  const s = puerta(l, [historia, '--suite', A]);
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, /y de su copia que viaja/, s.out);
  const copia = JSON.parse(fs.readFileSync(copias()[0], 'utf8'));
  assert.equal(copia.suite_green, true, s.out);
  assert.equal(copia.totals.failed, 0);
  assert.equal(constancia(l).suite_green, true);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (b) @story-8.230 @ac-12 — una constancia de otra corrida no se toca y lo dice', () => {
  const l = conRojo();
  const c = constancia(l);
  c.ts = '2000-01-01T00:00:00Z';
  fs.writeFileSync(artefacto(l), JSON.stringify(c, null, 2));
  const antes = fs.readFileSync(artefacto(l), 'utf8');
  estado(l, { a: 0 });
  const r = puerta(l, ['--suite', A]);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.readFileSync(artefacto(l), 'utf8'), antes);
  assert.match(r.out, /la constancia es de otra corrida/, r.out);
  assert.deepEqual(lista(l), [B], 'igual sale de la lista');
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (e) @story-8.230 @ac-12 — sin constancia (la borró una completa negada) no escribe nada y lo dice', () => {
  const l = conRojo();
  assert.equal(puerta(l).status, 76);
  assert.ok(!fs.existsSync(artefacto(l)));
  estado(l, { a: 0 });
  const r = puerta(l, ['--suite', A]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(artefacto(l)), 'la repetición inventó una constancia');
  assert.match(r.out, /no hay constancia de la completa/, r.out);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (f) @story-8.230 @ac-12 — una repetición roja que el juez perdona pasa a heredadas, no a repeated_green', () => {
  const l = conRojo();
  // la foto se commitea en el repo: la constancia de la completa sigue siendo la misma
  conFoto(l, ['b.test.sh']);
  const r = puerta(l, ['--suite', B]);
  assert.equal(r.status, 0, r.out);
  const c = constancia(l);
  assert.deepEqual(c.totals.failures, ['a.test.sh'], r.out);
  assert.deepEqual(c.totals.inherited_suites, ['b.test.sh']);
  assert.equal(c.repeated_green, undefined, 'la heredada entró como verde');
});

/** Una constancia de una completa roja, escrita a mano para las piezas puras. */
function constanciaFalsa(dir, entradas, extra = {}) {
  const f = path.join(dir, 'tests-result.json');
  fs.writeFileSync(f, JSON.stringify({ ts: '2026-11-07T10:00:00Z', story_id: '9.1', suite_exit: 1, suite_green: false, halted: false,
    totals: { suites: entradas.length + 1, passed: 1, failed: entradas.length, missing: 0, failures: entradas.map((e) => path.basename(e.ruta)),
      failure_entries: entradas, missing_paths: [] }, ...extra }, null, 2));
  return f;
}
const repetir = (f, ruta, extra = {}) => ff.rewriteResult(f, { raiz: 'arnes', ruta }, { fullTs: '2026-11-07T10:00:00Z', storyId: '9.1', at: '2026-11-07T11:00:00Z', ...extra });

test('RepetirVerdeConSuite_ReescribeLaConstancia (c) @story-8.230 @ac-12 — una constancia sin failure_entries (de antes) no se toca', () => {
  const dir = tmp('ff-const-');
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: A }]);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete c.totals.failure_entries;
  fs.writeFileSync(f, JSON.stringify(c));
  const antes = fs.readFileSync(f, 'utf8');
  const r = repetir(f, A);
  assert.equal(r.written, false);
  assert.match(r.reason, /de antes/);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (d) @story-8.230 @ac-12 — dos rojas con el mismo nombre corto: sale sólo la de esa entrada', () => {
  // 🔴 mutación: buscar por el nombre corto → salen las dos x.test.sh.
  const dir = tmp('ff-const-');
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: 'tests/x.test.sh' }, { raiz: 'agent-skills', ruta: 'otra/x.test.sh' }]);
  const r = ff.rewriteResult(f, { raiz: 'agent-skills', ruta: 'otra/x.test.sh' }, { fullTs: '2026-11-07T10:00:00Z', storyId: '9.1' });
  assert.equal(r.written, true, r.reason);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(c.totals.failure_entries, [{ raiz: 'arnes', ruta: 'tests/x.test.sh' }]);
  assert.deepEqual(c.totals.failures, ['x.test.sh']);
  assert.equal(c.totals.failed, 1);
  assert.equal(c.suite_green, false);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (g) @story-8.230 @ac-12 — con una ausente en la completa, suite_green sigue false y dice qué falta', () => {
  // 🔴 mutación: poner suite_green con failed en 0 → verde con una suite que no corrió.
  const dir = tmp('ff-const-');
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: A }]);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(c.totals, { missing: 1, missing_paths: ['/x/scripts/tests/c.test.sh'] });
  fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(repetir(f, A).written, true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(d.totals.failed, 0);
  assert.equal(d.suite_green, false);
  assert.match(d.suite_green_pending.join(' '), /ausente/);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (hermanos) @story-8.230 @ac-12 — con un repo hermano en verde, all_green también queda en verde', () => {
  // 🔴 mutación: recalcular sólo suite_green → all_green sigue false y el revisor de pruebas no la toma verde.
  const f = constanciaFalsa(tmp('ff-const-'), [{ raiz: 'arnes', ruta: A }], { companions: [{ root: '/x/hermano', green: true, exit: 0 }], all_green: false });
  assert.equal(repetir(f, A).written, true);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(c.suite_green, true);
  assert.equal(c.all_green, true);
  // sin hermanos, la constancia no gana un all_green que no tenía
  const g = constanciaFalsa(tmp('ff-const-'), [{ raiz: 'arnes', ruta: A }]);
  repetir(g, A);
  assert.ok(!('all_green' in JSON.parse(fs.readFileSync(g, 'utf8'))));
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (sin entrada) @story-8.230 @ac-12 — una falla sin su entrada de suites.json sigue contando', () => {
  // 🔴 mutación: contar `failed` por failure_entries → 0 y verde con una falla todavía listada.
  const f = constanciaFalsa(tmp('ff-const-'), [{ raiz: 'arnes', ruta: A }]);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.totals.failures.push('sin-entrada.test.sh');
  c.totals.failed = 2;
  fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(repetir(f, A).written, true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(d.totals.failed, 1);
  assert.equal(d.suite_green, false);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (otra suite) @story-8.230 @ac-12 — una suite que no está entre las fallas no saca ninguna, ni de la copia', () => {
  // 🔴 mutación: sin `if (i < 0) return false` → splice(-1, 1) saca la última falla, que es de otra suite.
  const dir = tmp('ff-const-');
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: A }]);
  const antes = fs.readFileSync(f, 'utf8');
  const r = repetir(f, B);
  assert.equal(r.written, false);
  assert.match(r.reason, /no está entre las fallas de la constancia: no la toco/);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
  // la constancia la trae y la copia no: la constancia cambia, la copia queda igual y lo dice
  const g = constanciaFalsa(tmp('ff-const-'), [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }]);
  const sellada = path.join(dir, 'copia.json');
  fs.writeFileSync(sellada, JSON.stringify(JSON.parse(antes)));
  const s = repetir(g, B, { sealed: sellada });
  assert.equal(s.written, true);
  assert.match(s.reason, /la copia que viaja no trae esa falla: no la toco/);
  assert.equal(fs.readFileSync(sellada, 'utf8'), JSON.stringify(JSON.parse(antes)));
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (copia que no se toca) @story-8.230 @ac-12 — sin copia, o de otra corrida, lo dice', () => {
  const dir = tmp('ff-const-');
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: A }, { raiz: 'arnes', ruta: B }]);
  assert.match(repetir(f, A).reason, /sin copia que viaja/);
  const sellada = path.join(dir, 'copia.json');
  fs.writeFileSync(sellada, JSON.stringify({ ts: 'otra', totals: {} }));
  assert.match(repetir(f, B, { sealed: sellada }).reason, /la copia que viaja es de otra corrida/);
});

test('RepetirVerdeConSuite_ReescribeLaConstancia (copia) @story-8.230 @ac-12 — la copia que viaja cambia igual; otra historia o un hermano en rojo no la ponen verde', () => {
  const dir = tmp('ff-const-');
  const sellada = path.join(dir, 'dod-runtime', '9.1-tests-result.json');
  fs.mkdirSync(path.dirname(sellada), { recursive: true });
  const f = constanciaFalsa(dir, [{ raiz: 'arnes', ruta: A }]);
  const base = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(sellada, JSON.stringify({ kind: 'tests-result-sellado', story_id: '9.1', ts: base.ts, suite_exit: 1, suite_green: false, totals: base.totals }));
  assert.equal(repetir(f, A, { storyId: '9.2', sealed: sellada }).written, false, 'reescribió la constancia de otra historia');
  assert.equal(repetir(f, A, { sealed: sellada }).written, true);
  const s = JSON.parse(fs.readFileSync(sellada, 'utf8'));
  assert.equal(s.suite_green, true);
  assert.equal(s.totals.failed, 0);
  assert.equal(s.kind, 'tests-result-sellado', 'la copia perdió su forma');
  // con un repo hermano en rojo, el total no es verde
  const g = constanciaFalsa(tmp('ff-const-'), [{ raiz: 'arnes', ruta: A }], { companions: [{ root: '/x/hermano', green: false, exit: 1 }] });
  repetir(g, A);
  const h = JSON.parse(fs.readFileSync(g, 'utf8'));
  assert.equal(h.suite_green, false);
  assert.match(h.suite_green_pending.join(' '), /hermano/);
});

// ── La última roja repetida en verde, en una corrida acotada ─────────────────────────────────────────────────────────
// Con la última roja repetida en verde y la constancia en verde por las repeticiones, `checks.tests` pasa a verde. Sin
// eso, el freno de cierre, el del commit y el de guardar piden otra completa entera.
// 🔴 Falla con: dejar `tests` como estaba al sacar la última roja acotada · ponerlo en verde con otra roja en la lista
//    (de este repo o de otro), con una ausente, con una corrida de `tests` posterior, sin estar acotada, o con lo
//    guardado de la completa roja (ahí cierra la próxima completa, que vuelve a correr lo que cambió).
const FULL_TS = '2026-11-08T16:36:00Z';
const STOP_GATE = path.join(SCRIPTS, 'on-stop-dod-gate.js');
const gatesLog = (l) => { try { return fs.readFileSync(path.join(l.home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8'); } catch (_) { return ''; } };

/** Una completa roja escrita a mano: su constancia, y el marcador con `tests` en rojo y la lista de las rojas. */
function rojoAMano({ rojas = [A], checksAt = '2026-11-08T17:51:16.000Z', at = '2026-11-08T17:51:17.000Z', ajenas = [], totals = {} } = {}) {
  const l = lab();
  fs.mkdirSync(path.dirname(artefacto(l)), { recursive: true });
  fs.writeFileSync(artefacto(l), JSON.stringify({ ts: FULL_TS, runner: 'suites-json', suite_exit: 1, suite_green: false, halted: false,
    totals: { suites: 2, passed: 2 - rojas.length, failed: rojas.length, missing: 0, failures: rojas.map((r) => path.basename(r)),
      failure_entries: rojas.map((ruta) => ({ raiz: 'arnes', ruta })), missing_paths: [], ...totals } }));
  const m = marcador(l);
  Object.assign(m, { autonomous: true, checks: { tests: 'red:exit=1' }, checksAt: { tests: checksAt }, checksProvenance: { tests: 'test-gate' },
    testsFailed: [...rojas.map((ruta) => ({ ruta, raiz: 'arnes', repo: l.repo, at, full_ts: FULL_TS })), ...ajenas] });
  fs.writeFileSync(markerFile(l), JSON.stringify(m));
  return l;
}
const sacar = (l, ruta, conQuien = true) => marker(l, ['tests-failed', 'clear', '--path', ruta, '--repo', l.repo, '--result', artefacto(l),
  ...(conQuien ? ['--full-suite-by', 'la CI de prueba'] : [])], { TYCON_TEST_GATE: '1' });
const frenoDeCierre = (l) => spawnSync(process.execPath, [STOP_GATE], { cwd: l.repo, encoding: 'utf8', env: entorno(l),
  input: JSON.stringify({ session_id: SID, cwd: l.repo, last_assistant_message: 'sigo' }), timeout: 30000 }).stdout;

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (a) — la última roja en verde, acotada: tests en verde, anotado, y el freno de cierre deja cerrar', () => {
  const l = rojoAMano();
  assert.match(frenoDeCierre(l), /"decision":"block"/, 'el freno no frenaba con tests en rojo: el laboratorio no reproduce el caso');
  const r = sacar(l, A);
  assert.equal(r.status, 0, r.out);
  const m = marcador(l);
  assert.equal(m.checks.tests, 'green', r.out);
  assert.equal(m.checksProvenance.tests, 'test-gate');
  assert.ok(Math.abs(Date.now() - Date.parse(m.checksAt.tests)) < 60000, `la hora del verde no es la de la repetición: ${m.checksAt.tests}`);
  assert.match(r.out, /el check tests pasa a verde \(la completa la corre la CI de prueba\)/);
  const linea = gatesLog(l).split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.name === 'tests' && x.by === 'repeticiones');
  assert.ok(linea, 'el verde por las repeticiones no quedó en gates.log');
  assert.equal(linea.before, 'red:exit=1');
  assert.doesNotMatch(frenoDeCierre(l), /"decision":"block"/, 'el freno de cierre siguió frenando');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (b) — sin estar acotada, la repetición no toca tests', () => {
  const l = rojoAMano();
  const r = sacar(l, A, false);
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(artefacto(l), 'utf8')).suite_green, true, 'la constancia no quedó en verde');
  assert.equal(marcador(l).checks.tests, 'red:exit=1', 'una corrida sin acotar cerró con una suite sola');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (c) — con otra roja sin repetir sigue en rojo; con las dos repetidas, verde', () => {
  const l = rojoAMano({ rojas: [A, B] });
  sacar(l, A);
  assert.equal(marcador(l).checks.tests, 'red:exit=1', 'una repetición tapó la roja que no se repitió');
  sacar(l, B);
  assert.equal(marcador(l).checks.tests, 'green');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (d) — una ausente en la completa, una roja pendiente de otro repo o una corrida posterior: sigue en rojo', () => {
  const aus = rojoAMano({ totals: { missing: 1, missing_paths: ['/x/scripts/tests/c.test.sh'] } });
  sacar(aus, A);
  assert.equal(marcador(aus).checks.tests, 'red:exit=1', 'una ausente quedó tapada');
  const otro = rojoAMano({ ajenas: [{ ruta: B, raiz: 'arnes', repo: '/otro/repo', at: '2026-11-08T17:00:00.000Z' }] });
  sacar(otro, A);
  assert.equal(marcador(otro).checks.tests, 'red:exit=1', 'una roja de otro repo quedó tapada');
  assert.deepEqual(marcador(otro).testsFailed.map((x) => x.repo), ['/otro/repo']);
  const tarde = rojoAMano({ checksAt: '2026-11-08T18:00:00.000Z' });
  sacar(tarde, A);
  assert.equal(marcador(tarde).checks.tests, 'red:exit=1', 'una corrida de tests posterior a la completa quedó tapada');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (f) — un rojo que no es del portón, un rótulo que no es rojo o un hermano rojo: no lo toca', () => {
  const manual = rojoAMano();
  const m = marcador(manual); m.checksProvenance.tests = 'manual'; fs.writeFileSync(markerFile(manual), JSON.stringify(m));
  sacar(manual, A);
  assert.equal(marcador(manual).checks.tests, 'red:exit=1', 'un rojo declarado a mano pasó a verde');
  const turno = rojoAMano();
  const t = marcador(turno); t.checks.tests = 'sin-turno'; fs.writeFileSync(markerFile(turno), JSON.stringify(t));
  sacar(turno, A);
  assert.equal(marcador(turno).checks.tests, 'sin-turno', 'un «sin turno» pasó a verde sin medir');
  const hermano = rojoAMano();
  const c = JSON.parse(fs.readFileSync(artefacto(hermano), 'utf8'));
  c.companions = [{ root: '/otro/hermano', green: false }];
  fs.writeFileSync(artefacto(hermano), JSON.stringify(c));
  sacar(hermano, A);
  assert.equal(JSON.parse(fs.readFileSync(artefacto(hermano), 'utf8')).suite_green, false);
  assert.equal(marcador(hermano).checks.tests, 'red:exit=1', 'un repo hermano rojo quedó tapado');
  // lo guardado de la completa roja de otro repo: su próxima completa cierra, la repetición de éste no lo adelanta
  const guardadoAjeno = rojoAMano();
  const g = marcador(guardadoAjeno); g.testsRedFull = [{ repo: '/otro/repo', dir: '/nada', hash: 'x', at: '2026-11-08T17:00:00.000Z' }];
  fs.writeFileSync(markerFile(guardadoAjeno), JSON.stringify(g));
  sacar(guardadoAjeno, A);
  assert.equal(marcador(guardadoAjeno).checks.tests, 'red:exit=1', 'lo guardado de otro repo quedó tapado');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (g) — por la puerta, la corrida cruzada (la historia en otro repo) cuenta como acotada', () => {
  // la historia vive en otro repo (el privado) y la suite corre en éste, que no tiene .test-gate.yaml
  const l = rojoAMano();
  const privado = tmp('ff-privado-');
  git(privado, 'init', '-q'); git(privado, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(privado, 'config', 'user.name', 'prueba');
  fs.mkdirSync(path.join(privado, 'specs'));
  const story = path.join(privado, 'specs', 'story-9.1-prueba.md');
  fs.writeFileSync(story, '---\nstory: 9.1\ntitle: prueba\nstatus: in-progress\n---\n# prueba\n');
  git(privado, 'add', '-A'); git(privado, 'co' + 'mmit', '-q', '-m', 'base');
  const r = puerta(l, [story, '--suite', A]);
  assert.equal(r.status, 0, r.out);
  assert.equal(marcador(l).checks.tests, 'green', r.out);
  assert.match(r.out, /la corrida cruzada se acota a lo tocado/);
  // la misma repetición sin la historia de otro repo, en un repo que no acota: no lo toca
  const n = rojoAMano();
  assert.equal(puerta(n, ['--suite', A]).status, 0);
  assert.equal(marcador(n).checks.tests, 'red:exit=1', 'sin acotar, la repetición cerró el paso');
});

test('UltimaRojaRepetida_AcotadaDejaTestsVerde (e) — por la puerta: el repo que acota sin lo guardado pasa a verde; con lo guardado, o sin acotar, no', () => {
  // sin lo guardado de la completa roja (se borró): la segunda repetición deja tests en verde
  const l = conRojoAcotado();
  const d = marker(l, ['tests-failed', 'drop-red', '--repo', l.repo], { TYCON_TEST_GATE: '1' });
  assert.equal(d.status, 0, d.out);
  assert.equal(guardado(l), null);
  estado(l, { a: 0, b: 0 });
  assert.equal(puerta(l, ['--suite', A]).status, 0);
  assert.match(String(marcador(l).checks.tests), /^red/, 'con B sin repetir, tests pasó a verde');
  const r = puerta(l, ['--suite', B]);
  assert.equal(r.status, 0, r.out);
  assert.equal(marcador(l).checks.tests, 'green', r.out);
  // con lo guardado, cierra la próxima completa (corre lo que cambió): la repetición no lo adelanta
  const g = conRojoAcotado();
  repetirVerdes(g);
  assert.match(String(marcador(g).checks.tests), /^red/, 'con lo guardado, la repetición se salteó la completa que cierra');
  // un repo que no acota: una suite sola nunca cierra
  const n = conRojo();
  estado(n, { a: 0, b: 0 });
  for (const s of [A, B]) assert.equal(puerta(n, ['--suite', s]).status, 0);
  assert.match(String(marcador(n).checks.tests), /^red/, 'un repo sin acotar cerró con suites solas');
});

// ── Las suites que vuelven por sus carpetas corren solas, no la completa ────────────────────────────────────────────
const ff299 = require(path.join(SCRIPTS, 'lib', 'failed-first.js'));
const RAIZ_PUBLICA = path.resolve(SCRIPTS, '..', '..', '..');
const SELECTOR_VIEJO = "module.exports = { groupCriterion: () => ({ skips: () => false }) };\n";
/**
 * Un repo de juguete para `decide`: la lista de suites, el grupo `installer` (con el selector del público, uno viejo sin
 * `incluye`, o un heavy-suites.json roto) y dos árboles: el de la base y el de después de tocar.
 */
function repoParaDecidir({ suites = [], heavy = 'ok', selector = 'publico' } = {}) {
  const repo = tmp('ff-decide-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  escribir('scripts/tests/suites.json', JSON.stringify({ diarias: suites, semanales: [] }));
  for (const s of suites) escribir(`scripts/${s.ruta}`, 'exit 0\n');
  if (heavy) {
    escribir('scripts/ci/heavy-suites.json', heavy === 'roto' ? '{' : JSON.stringify({ groups: { installer: { patterns: ['installer/**'] } },
      suites: { 'i.test.sh': { group: 'installer', patterns: ['scripts/tests/i.test.sh'] }, 'j.test.sh': { group: 'installer', patterns: ['scripts/tests/j.test.sh'] } } }));
    if (selector === 'publico') fs.copyFileSync(path.join(RAIZ_PUBLICA, 'scripts', 'ci', 'suites-for-change.js'), path.join(repo, 'scripts', 'ci', 'suites-for-change.js'));
    else escribir('scripts/ci/suites-for-change.js', selector);
  }
  for (const f of ['docs/z.md', 'G/x.md', 'H/x.md', 'installer/x.sh', 'lib/otro.js']) escribir(f, 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const arbol = () => git(repo, 'rev-parse', 'HEAD^{tree}').stdout.trim();
  const tocar = (...rels) => { for (const rel of rels) fs.appendFileSync(path.join(repo, rel), 'cambio\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'cambio'); return arbol(); };
  return { repo, antes: arbol(), tocar };
}
/** Lo guardado de una completa roja (fuera del árbol armado) que midió el árbol `tree`, con su constancia. */
function guardadoRojo(resumen, tree) {
  const d = tmp('ff-guardado-carpetas-');
  const r = path.join(d, 'r.json'); const m = path.join(d, 'm.json'); const dir = path.join(d, 'g');
  fs.writeFileSync(r, JSON.stringify(resumen)); fs.writeFileSync(m, JSON.stringify({ tree }));
  ff299.saveRed({ dir, summaryFile: r, lcovFile: null, measuredFile: m, base: null, recorte: '' });
  return { dir, hash: ff299.redHash(dir) };
}
const ENTRADA = (n, extra = {}) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh`, ...extra });
const MEDIDA = (n) => ({ ruta: `/r/scripts/tests/${n}.test.sh`, exit: 0, ms: 1, entrada: ENTRADA(n) });
const DIFERIDA = (n, reason, conEntrada = true) => ({ suite: `/r/scripts/tests/${n}.test.sh`, reason, ...(conEntrada ? { entrada: ENTRADA(n) } : {}) });
const POR_CARPETA = (c) => `corre de noche y en el control del PR; esta story no toca ${c}`;
const POR_INSTALADOR = 'corre de noche y en el control del PR; esta story no toca el instalador (el grupo installer de scripts/ci/heavy-suites.json)';
const decidir = (j, g, tree) => ff299.decide({ dir: g.dir, hash: g.hash, repo: j.repo, tree, base: null, recorte: '' });

test('T2 Decide_DeferredByFolderOrInstaller_Changed @story-8.299 @ac-1 @ac-2 — con lo guardado rojo fuera del árbol, las diferidas y las medidas que vuelven por sus carpetas van en reactivadas, una sola vez', () => {
  // 🔴 mutación: pedir la completa en vez de `changed`; olvidar las ya medidas (quedarían con el resultado viejo); repetir
  // una suite que figura medida y como diferida vieja sin entrada.
  const j = repoParaDecidir({ suites: [ENTRADA('g', { gate_only_when_touching: ['G/**'] }), ENTRADA('h', { gate_only_when_touching: ['H/**'] }), ENTRADA('i'), ENTRADA('j'), ENTRADA('k')] });
  const g = guardadoRojo({ suites: [MEDIDA('h'), MEDIDA('j'), MEDIDA('k')], fallas: [], ausentes: [],
    deferred_suites: [DIFERIDA('g', POR_CARPETA('G/**')), DIFERIDA('i', POR_INSTALADOR), DIFERIDA('h', POR_CARPETA('H/**'), false)] }, j.antes);
  const d = decidir(j, g, j.tocar('G/x.md', 'H/x.md', 'installer/x.sh'));
  assert.equal(d.mode, 'changed', JSON.stringify(d));
  assert.deepEqual([...d.files].sort(), ['G/x.md', 'H/x.md', 'installer/x.sh']);
  const por = Object.fromEntries(d.reactivadas.map((x) => [x.nombre, x]));
  assert.deepEqual(Object.keys(por).sort(), ['g.test.sh', 'h.test.sh', 'i.test.sh', 'j.test.sh']);
  assert.equal(d.reactivadas.length, 4, `cada una una sola vez: ${JSON.stringify(d.reactivadas)}`);
  for (const n of ['g', 'h', 'i', 'j']) assert.deepEqual([por[`${n}.test.sh`].raiz, por[`${n}.test.sh`].ruta], ['arnes', `tests/${n}.test.sh`]);
  assert.equal(por['g.test.sh'].motivo, 'la completa la difirió y lo cambiado toca G/**');
  assert.equal(por['i.test.sh'].motivo, 'la completa la difirió y lo cambiado toca el instalador');
  assert.equal(por['h.test.sh'].motivo, 'lo cambiado toca H/**, que lee sin nombrar');
  assert.equal(por['j.test.sh'].motivo, 'lo cambiado toca el instalador, que lee sin nombrar');
});

test('T3 Decide_DeferredWithoutEntry_Full @story-8.299 @ac-8 — una diferida sin entrada en la lista pide la completa con cualquier cambio', () => {
  // 🔴 mutación: saltearla callada (como hacía el criterio viejo) la dejaría sin medir
  const j = repoParaDecidir({ suites: [ENTRADA('g', { gate_only_when_touching: ['G/**'] })] });
  const g = guardadoRojo({ suites: [], fallas: [], ausentes: [], deferred_suites: [DIFERIDA('x', POR_CARPETA('X/**'), false)] }, j.antes);
  const d = decidir(j, g, j.tocar('docs/z.md'));
  assert.equal(d.mode, 'full', JSON.stringify(d));
  assert.equal(d.reason, 'no encuentro en la lista de suites la diferida x.test.sh: corre la completa');
});

test('T6 Merge_Reactivated_LeavesDeferredList @story-8.299 @ac-4 — una reactivada que corrió sale de deferred_suites por su entrada; una vieja sin entrada se queda', () => {
  // 🔴 mutación: conservar deferred_suites tal cual deja a lo guardado diciendo «diferida» de una suite que ya midió
  const otra = tmp('ff-otra-carpeta-');
  const g = guardadoRojo({ suites: [MEDIDA('a')], fallas: [], ausentes: [],
    deferred_suites: [{ suite: path.join(otra, 'scripts', 'tests', 'g.test.sh'), reason: POR_CARPETA('G/**'), entrada: ENTRADA('g') }, DIFERIDA('v', POR_CARPETA('V/**'), false)] }, 'a'.repeat(40));
  const out = ff299.merge({ dir: g.dir, newSummary: { suites: [{ ruta: '/r2/scripts/tests/g.test.sh', exit: 0, ms: 2, entrada: ENTRADA('g') }], fallas: [], ausentes: [] } });
  const gg = out.suites.find((s) => s.entrada && s.entrada.ruta === 'tests/g.test.sh');
  assert.deepEqual([gg && gg.exit, gg && gg.ruta], [0, '/r2/scripts/tests/g.test.sh']);
  assert.deepEqual(out.deferred_suites.map((x) => path.basename(x.suite)), ['v.test.sh']);
  assert.equal(ff299.mergedRed(out), false);
});

test('T9 Decide_CriteriaUnreadable_Full @story-8.299 @ac-7 — un heavy-suites.json roto o un selector sin incluye piden la completa y lo dicen', () => {
  // 🔴 mutación: tratar el criterio ilegible como «no es del grupo» dejaría a la diferida del instalador sin medir
  const roto = repoParaDecidir({ suites: [ENTRADA('i')], heavy: 'roto' });
  let g = guardadoRojo({ suites: [], fallas: [], ausentes: [], deferred_suites: [DIFERIDA('i', POR_INSTALADOR)] }, roto.antes);
  let d = decidir(roto, g, roto.tocar('installer/x.sh'));
  assert.equal(d.mode, 'full', JSON.stringify(d));
  assert.match(d.reason, /^no pude ver qué suites vuelven a correr por sus carpetas \(/);
  const viejo = repoParaDecidir({ suites: [ENTRADA('i')], selector: SELECTOR_VIEJO });
  g = guardadoRojo({ suites: [], fallas: [], ausentes: [], deferred_suites: [DIFERIDA('i', POR_INSTALADOR)] }, viejo.antes);
  d = decidir(viejo, g, viejo.tocar('installer/x.sh'));
  assert.equal(d.mode, 'full', JSON.stringify(d));
  assert.match(d.reason, /^no pude ver qué suites vuelven a correr por sus carpetas \(.*incluye/);
});

test('T10 Decide_NoReturning_AsToday @story-8.299 @ac-11 — sin suites que vuelvan por sus carpetas, decide da lo de hoy: same, changed con files y rerun, sin reactivadas', () => {
  // 🔴 mutación: un `reactivadas` que no esté vacío, o un `full`, donde hoy se acota
  const j = repoParaDecidir({ suites: [ENTRADA('a'), ENTRADA('g', { gate_only_when_touching: ['G/**'] })] });
  const resumen = { suites: [MEDIDA('a')], fallas: [], ausentes: [], deferred_suites: [DIFERIDA('g', POR_CARPETA('G/**'))] };
  let g = guardadoRojo(resumen, j.antes);
  assert.equal(decidir(j, g, j.antes).mode, 'same');
  let d = decidir(j, g, j.tocar('lib/otro.js'));
  assert.deepEqual([d.mode, d.files, d.rerun, d.reactivadas], ['changed', ['lib/otro.js'], [], []]);
  // una repetida vieja vuelve por su clave, como hoy
  const conFalla = { ...resumen, suites: [{ ...MEDIDA('a'), exit: 1 }], fallas: [{ ruta: '/r/scripts/tests/a.test.sh', entrada: ENTRADA('a') }] };
  g = guardadoRojo(conFalla, j.antes);
  ff299.addRepeat(g.dir, 'tests/a.test.sh', { tree: 'x'.repeat(40), entry: { ruta: '/r/scripts/tests/a.test.sh', exit: 0, entrada: ENTRADA('a') } });
  d = decidir(j, { dir: g.dir, hash: ff299.redHash(g.dir) }, j.tocar('docs/z.md'));
  assert.deepEqual([d.mode, d.rerun, d.reactivadas], ['changed', ['tests/a.test.sh'], []]);
});
