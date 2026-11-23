'use strict';

/**
 * test-gate-main-wait.test.js — la espera a main donde se cruza con las suites que vuelven, lo guardado del portón, la
 * repetición de una suite sola y los repos hermanos.
 *
 * Lo que no se puede perder:
 *   - la repetición de una suite sola pasa por el juez de main igual que la completa, y no suma nada a lo guardado;
 *   - una suite que vuelve por sus carpetas se juzga como cualquier otra: nunca queda perdonada sin medir;
 *   - una espera no se guarda como medida: la corrida siguiente vuelve a correr lo que esperaba, aunque la carpeta sea
 *     la misma, y aunque la corrida no pase por la decisión de lo guardado (una cruzada, o sin nada guardado);
 *   - la espera se borra suite por suite, sólo con la suite medida; una corrida ocupada no la borra;
 *   - si main pasó y la rama no lo trae, el rojo lo dice antes de pedir que se arregle la suite;
 *   - con repos hermanos, un rojo de cualquier lado gana sobre la espera, y la espera sobre el verde.
 *
 * Todo corre sobre repos de juguete con un `origin` local (un repo desnudo) y una HOME de prueba: ninguna prueba trae el
 * origin real ni mide las suites reales. Las suites son guiones de bash que leen `lib/x.js` (así la corrida acotada las
 * corre; un `.md` solo no alcanza: con commits propios, el portón no sabría qué se tocó), anotan cada corrida y salen con el código de su archivo de estado o el de su contenido.
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
const LIB = path.join(SCRIPTS, 'lib', 'main-check.js');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const FF = path.join(SCRIPTS, 'lib', 'failed-first.js');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_TEST_GATE_RUN', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER', 'TYCON_SUITE_TIMES',
  'TYCON_MAIN_CHECK', 'TYCON_MAIN_CHECK_MAX', 'TYCON_MAIN_CHECK_TIMEOUT_S', 'TYCON_MAIN_CHECK_LOCK_WAIT_S', 'TYCON_INHERITED_BASE_MAX',
  'TYCON_MAIN_CHECK_WAIT_INTERVAL_S', 'TYCON_MAIN_CHECK_WAIT_MAX_S'];

const RUTA = (n) => `tests/${n}.test.sh`;
const SID = 'mw-sesion';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const autor = ['-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba'];

function git(d, ...a) {
  const fecha = '2026-01-01T00:00:00Z';
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', ...autor, '-C', d, ...a], {
    // sin las variables de un gancho: con su GIT_DIR, `-C` no decide el repo y un `init --bare` deja pelado al de verdad
    encoding: 'utf8', env: require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre({ GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha }),
  });
}
const sha = (d, ref = 'HEAD') => git(d, 'rev-parse', ref).stdout.trim();

/**
 * Una suite de bash que lee `lee` (por eso la corrida acotada la elige cuando eso cambia), anota que corrió, imprime un
 * renglón de caso por cada nombre de `casos` y sale con su archivo de estado (`$MW_STATE/<n>`) o con `sale`.
 */
const suite = (n, { casos = [], sale = 0, lee = 'lib/x.js' } = {}) => `#!/usr/bin/env bash
# lee ${lee}
echo "${n} $(pwd)" >> "\${MW_STATE:-/dev/null}/corridas" 2>/dev/null || true
${casos.map((c) => `echo "✖ ${c}"`).join('\n')}
exit "$(cat "\${MW_STATE:-/nonexistent}/${n}" 2>/dev/null || echo ${sale})"
`;
const ROJA = (n, extra = {}) => suite(n, { casos: [`${n}-1`], sale: 1, ...extra });

/**
 * Un repo de juguete que acota el portón, con su `origin` desnudo y `main` empujado. `enMain` son las suites de main
 * (nombre → texto); `entradas` su lista (con `gate_only_when_touching` si hace falta). La rama `cambio` toca `lib/x.js` y
 * lo que diga `enRama`. Devuelve también la carpeta de estado de las suites y la HOME de prueba.
 */
function repoDeJuguete({ enMain, enRama = {}, entradas = null, nombre = 'mw-repo-', extra = {} } = {}) {
  const home = tmp('mw-home-');
  const state = tmp('mw-state-');
  const skills = tmp('mw-skills-');
  const remoto = tmp('mw-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const repo = tmp(nombre);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remoto);
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  const lista = entradas || Object.keys(enMain).map((n) => ({ raiz: 'arnes', ruta: RUTA(n) }));
  escribir('scripts/tests/suites.json', `${JSON.stringify({ diarias: lista, semanales: [] }, null, 2)}\n`);
  for (const [n, txt] of Object.entries(enMain)) escribir(`scripts/${RUTA(n)}`, txt);
  escribir('lib/x.js', '// x\n');
  for (const [rel, txt] of Object.entries(extra)) escribir(rel, txt);
  escribir('.test-gate.yaml', 'test_gate:\n  scope: touched\n  full_suite_by: "la CI de prueba"\n');
  escribir('.gitignore', '.advisors/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const base = sha(repo);
  git(repo, 'checkout', '-q', '-b', 'cambio');
  fs.appendFileSync(path.join(repo, 'lib', 'x.js'), '// cambio de la historia\n');
  for (const [n, txt] of Object.entries(enRama)) escribir(`scripts/${RUTA(n)}`, txt);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'el cambio');
  return { home, state, skills, remoto, repo, base };
}

/** Un commit en main del remoto que deja verdes las suites dadas, hecho desde otro clon. Devuelve su sha. */
function arreglarMain(l, nombres) {
  const otro = tmp('mw-otro-');
  git(otro, 'clone', '-q', l.remoto, otro);
  for (const n of nombres) fs.writeFileSync(path.join(otro, 'scripts', RUTA(n)), suite(n));
  git(otro, 'add', '-A'); git(otro, 'commit', '-q', '-m', `arregla ${nombres.join(' ')}`);
  git(otro, 'push', '-q', 'origin', 'main');
  return sha(otro);
}

function entorno(l, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, MW_STATE: l.state, TYCON_SKILLS_DIR: l.skills,
    TYCON_INHERITED_BASE_MAX: '0', TYCON_MAIN_CHECK_LOCK_WAIT_S: '2', ...extra };
}
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const corrio = (l, n) => corridas(l).some((c) => c.startsWith(`${n} `) && !c.includes('--main-check'));
const estado = (l, valores) => { for (const [n, v] of Object.entries(valores)) fs.writeFileSync(path.join(l.state, n), String(v)); };
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const markerFile = (l) => path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
function escribirMarcador(l, extra = {}) {
  fs.mkdirSync(path.dirname(markerFile(l)), { recursive: true });
  fs.writeFileSync(markerFile(l), JSON.stringify({
    storyId: '9.309', storyPath: '', repoPath: l.repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8, 9, 10, 11],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {}, autonomous: true, ...extra,
  }, null, 2));
}
const marcador = (l) => leer(markerFile(l));
const esperas = (l) => [].concat(marcador(l).waitingOnMain || []);
const esperaDe = (l, repo = l.repo) => esperas(l).find((w) => w.repo === repo) || null;
const verde = (l) => (marcador(l).testsGreenFull || []).find((x) => x.repo === l.repo) || null;
const roja = (l) => (marcador(l).testsRedFull || []).find((x) => x.repo === l.repo) || null;

function puerta(l, args = [], extra = {}) {
  fs.rmSync(path.join(l.state, 'corridas'), { force: true });
  const r = spawnSync('bash', [TEST_GATE, l.repo, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 240000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function marker(l, args, extra = {}) {
  const r = spawnSync(process.execPath, [MARKER_JS, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 30000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const estadoDeMain = (l) => {
  const dir = path.join(l.home, '.claude', '.tycon-pipeline', 'main-check');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
  return { file: path.join(dir, f), data: leer(path.join(dir, f)) };
};

// ── T5: la repetición de una suite sola ──────────────────────────────────────────────────────────────────────────────

test('T5 MainWait_SingleSuiteRerun_Exit78 @story-8.309 @ac-5 — --suite de una roja de main sale 78, la saca de la lista y no suma nada a lo guardado', () => {
  // 🔴 mutación: una --suite que reemplaza la espera pierde las suites de antes; una que pasa por `tests-failed clear`
  //    suma su repetición a lo guardado; una que no saca la suite de la lista hace salir 76 a la completa siguiente.
  const l = repoDeJuguete({ enMain: { a: ROJA('a'), b: suite('b'), c: ROJA('c') }, enRama: { b: ROJA('b') } });
  escribirMarcador(l);
  let r = puerta(l);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual((marcador(l).testsFailed || []).map((x) => x.ruta).sort(), [RUTA('a'), RUTA('b'), RUTA('c')]);
  assert.ok(roja(l), `no guardó la completa roja:\n${r.out}`);
  const repetidas = () => leer(path.join(roja(l).dir, 'repetidas.json'));
  r = puerta(l, ['--suite', RUTA('a')]);
  assert.equal(r.status, 78, r.out);
  // la repetición sola no es la completa: no cambia el check de la completa, que sigue con su rojo (b, y lo que la
  // completa haya dejado sin medir)
  assert.match(String(marcador(l).checks.tests), /^red/, 'una --suite con 78 escondió el rojo de la completa');
  assert.ok(!(marcador(l).testsFailed || []).some((x) => x.ruta === RUTA('a')), 'a sigue en la lista');
  assert.deepEqual(esperaDe(l).suites, [RUTA('a')]);
  assert.equal(repetidas()[RUTA('a')], undefined, 'la repetición que espera a main se sumó a lo guardado');
  r = puerta(l, ['--suite', RUTA('c')]);
  assert.equal(r.status, 78, r.out);
  assert.deepEqual([...esperaDe(l).suites].sort(), [RUTA('a'), RUTA('c')], 'la segunda repetición pisó la espera de la primera');
  // la historia arregla b; la completa siguiente no pide repetir nada y espera a main
  estado(l, { b: 0 });
  assert.equal(puerta(l, ['--suite', RUTA('b')]).status, 0);
  r = puerta(l);
  assert.equal(r.status, 78, r.out);
  assert.doesNotMatch(r.out, /Repetí primero/);
});

test('T5b MainWait_SingleSuiteRerun_DoesNotHideFullRunRed @story-8.309 @ac-5 — una --suite con 78 no deja la completa en espera-main si la completa dejó un rojo que no está en la lista (una ausente)', () => {
  // 🔴 mutación: la repetición sola deja `tests` en espera-main mirando sólo la lista de las que fallaron, que no trae las
  //    ausentes ni las no medidas: el cierre del turno deja parar con un rojo propio de la historia.
  const entradas = [{ raiz: 'arnes', ruta: RUTA('a') }, { raiz: 'arnes', ruta: RUTA('c') }, { raiz: 'arnes', ruta: RUTA('z') }];
  const l = repoDeJuguete({ entradas, enMain: { a: ROJA('a'), c: ROJA('c') } });
  escribirMarcador(l);
  // la completa con el tope del juez en 1: a de main, c sin medir en main (sigue en la lista), z ausente
  let r = puerta(l, [], { TYCON_MAIN_CHECK_MAX: '1' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /AUSENTE/);
  r = puerta(l, ['--suite', RUTA('c')]);
  assert.equal(r.status, 78, r.out);
  assert.match(String(marcador(l).checks.tests), /^red/, 'la repetición sola escondió la ausente de la completa');
});

// ── T6: una suite que vuelve por sus carpetas, frente al juez ────────────────────────────────────────────────────────

const ENTRADAS_G = [{ raiz: 'arnes', ruta: RUTA('a') }, { raiz: 'arnes', ruta: RUTA('b') }, { raiz: 'arnes', ruta: RUTA('g'), gate_only_when_touching: ['G/**'] }];
// g es la misma en main y en la rama (si no, tocar su archivo la haría correr): falla si existe G/x.md
const G = `#!/usr/bin/env bash
# lee G/x.md
echo "g $(pwd)" >> "\${MW_STATE:-/dev/null}/corridas" 2>/dev/null || true
if [ -f G/x.md ]; then echo "✖ g-1"; exit 1; fi
exit 0
`;
/** g diferida en la completa verde; después la historia toca G/x.md. `mainRoto`: main ya trae G/x.md, y g falla también ahí. */
function conGDiferida({ mainRoto = true } = {}) {
  const l = repoDeJuguete({ entradas: ENTRADAS_G, enMain: { a: suite('a'), b: suite('b'), g: G }, extra: mainRoto ? { 'G/x.md': 'de main\n' } : {} });
  escribirMarcador(l);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.ok(verde(l), `no guardó la completa verde:\n${r.out}`);
  assert.ok(!corrio(l, 'g'), `g tenía que quedar diferida:\n${r.out}`);
  fs.mkdirSync(path.join(l.repo, 'G'), { recursive: true });
  fs.appendFileSync(path.join(l.repo, 'G', 'x.md'), 'toca la carpeta de g\n');
  return l;
}

test('T6 MainWait_ReturningSuite_IsJudged @story-8.309 @ac-6 — g vuelve por su carpeta y sale roja: de main espera; si no, rojo', () => {
  // 🔴 mutación: perdonar la que vuelve sin juzgarla (verde) o no juzgarla (rojo aun con main roto).
  let l = conGDiferida();
  let r = puerta(l);
  assert.ok(corrio(l, 'g'), r.out);
  assert.equal(r.status, 78, `main roja: espera\n${r.out}`);
  l = conGDiferida({ mainRoto: false });
  r = puerta(l);
  assert.ok(corrio(l, 'g'), r.out);
  assert.equal(r.status, 1, `main verde: el rojo es de la historia\n${r.out}`);
  l = conGDiferida();
  r = puerta(l, [], { TYCON_MAIN_CHECK_MAX: '0' });
  assert.equal(r.status, 1, `sin poder medir main: rojo\n${r.out}`);
  l = conGDiferida();
  fs.writeFileSync(path.join(l.repo, 'scripts', RUTA('b')), ROJA('b'));
  r = puerta(l);
  assert.equal(r.status, 1, `con otro rojo de la historia: rojo\n${r.out}`);
  assert.equal(esperas(l).length, 0, 'una mezcla no anota espera');
});

// ── T7: una espera no es una medida ──────────────────────────────────────────────────────────────────────────────────

test('T7 MainWait_NotSaved_RerunsTheWait @story-8.309 @ac-7 — con la carpeta igual, la corrida siguiente vuelve a correr lo que esperaba', () => {
  // 🔴 mutación: sin `esperaMain`, la decisión da `same` y la corrida cierra en verde con lo guardado.
  const l = repoDeJuguete({ enMain: { a: ROJA('a'), b: suite('b') }, enRama: { a: suite('a') } });
  escribirMarcador(l);
  let r = puerta(l);
  assert.equal(r.status, 0, r.out);
  const guardado = verde(l);
  assert.ok(guardado, r.out);
  // a se rompe igual en la rama y en main, sin cambiar la carpeta: la medición entera sale 78
  estado(l, { a: 1 });
  r = puerta(l, [], { TYCON_GATE_ALL_SUITES: '1' });
  assert.equal(r.status, 78, r.out);
  assert.equal(verde(l).dir, guardado.dir, 'una espera se guardó como medida');
  r = puerta(l);
  assert.ok(corrio(l, 'a'), `a no volvió a correr:\n${r.out}`);
  assert.doesNotMatch(r.out, /no corro ninguna suite/);
  assert.equal(r.status, 78, r.out);
  assert.equal(verde(l).dir, guardado.dir, 'la 78 quedó como último verde');
});

test('T7 Decide_WithEsperaMain_ChangedNeverSame @story-8.309 @ac-7 — decide suma las suites de la espera a rerun y no pide repetirlas solas', () => {
  const ff = require(FF);
  const repo = tmp('mw-decide-');
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: RUTA('a') }], semanales: [] }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const tree = sha(repo, 'HEAD^{tree}');
  const d = tmp('mw-guardado-');
  const resumen = { suites: [{ ruta: `${repo}/scripts/${RUTA('a')}`, exit: 1, entrada: { raiz: 'arnes', ruta: RUTA('a') } }],
    fallas: [{ ruta: `${repo}/scripts/${RUTA('a')}`, exit: 1, casos: [], entrada: { raiz: 'arnes', ruta: RUTA('a') } }], ausentes: [], deferred_suites: [] };
  fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify(resumen)); fs.writeFileSync(path.join(d, 'm.json'), JSON.stringify({ tree }));
  const dir = path.join(d, 'g');
  ff.saveRed({ dir, summaryFile: path.join(d, 'r.json'), lcovFile: null, measuredFile: path.join(d, 'm.json'), base: null, recorte: '' });
  const decidir = (extra) => ff.decide({ dir, hash: ff.redHash(dir), repo, tree, base: null, recorte: '', ...extra });
  assert.match(decidir({}).reason || '', /falta repetir sola: tests\/a\.test\.sh/, 'sin la espera, como hoy');
  const dec = decidir({ esperaMain: [RUTA('a')] });
  assert.equal(dec.mode, 'changed', JSON.stringify(dec));
  assert.deepEqual(dec.rerun, [RUTA('a')]);
  assert.deepEqual(dec.files, []);
});

// ── La espera corre siempre, aunque la corrida no pase por la decisión ───────────────────────────────────────────────

test('MainWait_NoSavedOrCrossRun_RunsTheWaitingSuite @story-8.309 @ac-7 — sin nada guardado, o en una corrida cruzada, la suite en espera corre aunque no lea lo tocado', () => {
  // 🔴 mutación: dejar la espera sólo en `decide` → la suite que no lee lo tocado queda diferida y la espera se borra
  //    sin medirla.
  for (const cruzada of [false, true]) {
    const l = repoDeJuguete({ enMain: { a: ROJA('a', { lee: 'lib/otro.js' }), b: suite('b') } });
    let historiaArg = [];
    if (cruzada) {
      const otro = tmp('mw-historias-');
      git(otro, 'init', '-q', '-b', 'main');
      const s = path.join(otro, 'specs', 'story-9.309.md');
      fs.mkdirSync(path.dirname(s), { recursive: true });
      fs.writeFileSync(s, '---\nstory: "9.309"\nstatus: in-progress\nfiles_to_modify:\n  - lib/x.js\n---\n# Story 9.309\n');
      historiaArg = [s];
    }
    escribirMarcador(l, { checks: { tests: 'espera-main' }, waitingOnMain: [{ repo: l.repo, tree: l.repo, id: 'main-1', sha: l.base, suites: [RUTA('a')], since: new Date().toISOString() }] });
    const r = puerta(l, historiaArg);
    assert.ok(corrio(l, 'a'), `${cruzada ? 'cruzada' : 'sin guardado'}: a no corrió\n${r.out}`);
    assert.equal(r.status, 78, `${cruzada ? 'cruzada' : 'sin guardado'}\n${r.out}`);
    assert.deepEqual(esperaDe(l).suites, [RUTA('a')]);
  }
});

test('MainWait_BusyOrNotMeasured_KeepsTheWait @story-8.309 @ac-9 — una corrida ocupada no borra la espera; el borrado es por suite medida', () => {
  const l = repoDeJuguete({ enMain: { a: ROJA('a'), b: suite('b') } });
  const espera = { repo: l.repo, tree: l.repo, id: 'main-1', sha: l.base, suites: [RUTA('a'), RUTA('b')], since: new Date().toISOString() };
  escribirMarcador(l, { checks: { tests: 'espera-main' }, waitingOnMain: [espera] });
  const huella = require('crypto').createHash('sha1').update(l.repo).digest('hex').slice(0, 16);
  const candado = path.join(l.home, '.claude', '.tycon-pipeline', 'run-check-locks', `tests-${huella}`);
  fs.mkdirSync(candado, { recursive: true });
  const r = puerta(l);
  assert.equal(r.status, 75, r.out);
  fs.rmSync(candado, { recursive: true, force: true });
  assert.deepEqual(esperaDe(l).suites, espera.suites, 'la corrida ocupada borró la espera');
  assert.equal(marcador(l).checks.tests, 'espera-main');
  // el borrado mira qué corrió: un resumen sin a deja a; con las dos, se borra y el check deja de decir espera-main
  const resumen = (rutas) => {
    const f = path.join(tmp('mw-medido-'), 'suites.json');
    fs.writeFileSync(f, JSON.stringify({ suites: rutas.map((ruta) => ({ ruta: `${l.repo}/scripts/${ruta}`, exit: 0, entrada: { raiz: 'arnes', ruta } })), fallas: [], ausentes: [] }));
    return f;
  };
  let m = marker(l, ['waiting-on-main', 'clear', '--repo', l.repo, '--measured', resumen([RUTA('b')])], { TYCON_TEST_GATE: '1' });
  assert.equal(m.status, 0, m.out);
  assert.deepEqual(esperaDe(l).suites, [RUTA('a')]);
  m = marker(l, ['waiting-on-main', 'clear', '--repo', l.repo, '--measured', resumen([RUTA('a')])], { TYCON_TEST_GATE: '1' });
  assert.equal(m.status, 0, m.out);
  assert.equal(esperas(l).length, 0);
  assert.match(String(marcador(l).checks.tests), /^red/, 'espera-main sin espera anotada');
});

// ── T8: main pasó y la rama no lo trae ───────────────────────────────────────────────────────────────────────────────

test('T8 MainWait_MainPassed_BranchMustBringIt @story-8.309 @ac-8 — wait cierra con closedSha; sin traer main el rojo lo dice; con main traído, verde', () => {
  // 🔴 mutación: pedir arreglar la suite sin decir que main ya pasó; afirmarlo sin poder comprobarlo; dejar la espera
  //    puesta con el portón verde.
  const l = repoDeJuguete({ enMain: { a: ROJA('a'), b: suite('b') } });
  escribirMarcador(l);
  let r = puerta(l);
  assert.equal(r.status, 78, r.out);
  const nuevo = arreglarMain(l, ['a']);
  // la memoria de la máquina no decide la prueba: la espera la lee de quien la llama
  const w = spawnSync(process.execPath, ['-e', `const r = require(${JSON.stringify(LIB)}).wait({ repo: ${JSON.stringify(l.repo)}, id: 'main-1', readMemory: () => ({ pct: 90 }) }); process.stdout.write(r.line + '\\n'); process.exitCode = r.code;`],
    { encoding: 'utf8', env: entorno(l, { TYCON_MAIN_CHECK_WAIT_INTERVAL_S: '1', TYCON_MAIN_CHECK_WAIT_MAX_S: '120' }), timeout: 180000 });
  assert.equal(w.status, 0, `${w.stdout}\n${w.stderr}`);
  assert.match(w.stdout, new RegExp(`main pasó: ${nuevo.slice(0, 10)}[0-9a-f]*; traé main y repetí el portón`));
  assert.equal(estadoDeMain(l).data.broken[0].closedSha, nuevo);
  r = puerta(l);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /main ya pasó \([0-9a-f]+\) y esta rama no lo trae: traé main y repetí el portón/);
  // branch-check: con el closedSha en la rama, o uno que el repo no tiene, o sin registro, no afirma nada
  const bc = (id) => spawnSync(process.execPath, [LIB, 'branch-check', '--repo', l.repo, '--id', id], { encoding: 'utf8', env: entorno(l) });
  assert.match(bc('main-1').stdout, /main ya pasó \([0-9a-f]+\) y esta rama no lo trae/);
  const st = estadoDeMain(l);
  st.data.broken[0].closedSha = 'f'.repeat(40);
  fs.writeFileSync(st.file, JSON.stringify(st.data));
  let b = bc('main-1');
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, '', 'afirmó sin poder comprobarlo');
  assert.equal(bc('main-9').stdout, '', 'sin registro con ese id');
  st.data.broken[0].closedSha = nuevo;
  fs.writeFileSync(st.file, JSON.stringify(st.data));
  // con main traído, verde y sin espera
  escribirMarcador(l, { waitingOnMain: [{ repo: l.repo, tree: l.repo, id: 'main-1', sha: l.base, suites: [RUTA('a')], since: new Date().toISOString() }] });
  git(l.repo, 'fetch', '-q', 'origin');
  assert.equal(git(l.repo, 'merge', '-q', '--no-edit', 'origin/main').status, 0);
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(esperas(l).length, 0);
});

// ── T9: los repos hermanos ───────────────────────────────────────────────────────────────────────────────────────────

/** Un repo y su hermano, cada uno con lo que sale su portón: '78' (a roja también en main), '0' o '1' (b roja sólo acá). */
function conHermano(principal, hermano) {
  const raiz = tmp('mw-hermanos-');
  const armar = (sale, nombre) => {
    const enRama = sale === '78' ? {} : sale === '0' ? { a: suite('a') } : { a: suite('a'), b: ROJA('b') };
    const r = repoDeJuguete({ enMain: { a: ROJA('a'), b: suite('b') }, enRama, nombre: `mw-${nombre}-` });
    const destino = path.join(raiz, nombre);
    fs.renameSync(r.repo, destino);
    return { ...r, repo: destino };
  };
  const p = armar(principal, 'P');
  const s = armar(hermano, 'S');
  fs.mkdirSync(path.join(p.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(p.repo, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - S\n');
  const story = path.join(p.repo, 'specs', 'story-9.309.md');
  fs.mkdirSync(path.dirname(story), { recursive: true });
  fs.writeFileSync(story, '---\nstory: "9.309"\nstatus: in-progress\nfiles_to_modify:\n  - lib/x.js\n  - S/lib/x.js\n---\n# Story 9.309\n');
  const l = { ...p, state: p.state };
  escribirMarcador(l, { storyPath: story });
  // las suites del hermano anotan en la misma carpeta de estado
  return { l, s, story };
}

test('T9 MainWait_SiblingRepo_RedBeatsWait @story-8.309 @ac-9 · TG5 Companions_78Combines_RedWins @story-8.294 @ac-17 @ac-18 —78 y 0 → 78; 0 y 78 → 78; 78 y 1 → 1; 1 y 78 → 1; 78 y 78 → 78 con dos esperas', () => {
  // 🔴 mutación: copiar el 78 del hermano tal cual (tapa un rojo); contarlo como rojo (pierde la espera); dejar el check
  //    en verde porque el hermano corrió después.
  for (const [p, s, total] of [['78', '0', 78], ['0', '78', 78], ['78', '1', 1], ['1', '78', 1], ['78', '78', 78]]) {
    const { l, story } = conHermano(p, s);
    const r = puerta(l, [story]);
    assert.equal(r.status, total, `${p} y ${s}\n${r.out}`);
    const m = marcador(l);
    if (total === 78) {
      assert.equal(m.checks.tests, 'espera-main', `${p} y ${s}: el check no es el total`);
      assert.ok(!fs.existsSync(path.join(l.repo, '.advisors', 'tests-result.json')), `${p} y ${s}: quedó tests-result.json`);
    } else assert.match(String(m.checks.tests), /^red/, `${p} y ${s}: el check no quedó rojo`);
    const repos = esperas(l).map((w) => path.basename(w.repo)).sort();
    assert.deepEqual(repos, [p === '78' ? 'P' : null, s === '78' ? 'S' : null].filter(Boolean).sort(), `${p} y ${s}: las esperas`);
  }
});

test('MainWait_SameRun_PartsSum_NewRunReplaces @story-8.309 @ac-9 — dos partes de la misma corrida suman sus suites; una corrida nueva reemplaza; --merge suma', () => {
  // 🔴 mutación: reemplazar siempre (la segunda parte borra la espera de la primera) o sumar siempre (una corrida nueva
  //    arrastra suites que ya no esperan).
  const l = repoDeJuguete({ enMain: { a: suite('a'), b: suite('b'), c: suite('c') } });
  escribirMarcador(l);
  const resumen = (n) => {
    const f = path.join(tmp('mw-parte-'), 'suites.json');
    fs.writeFileSync(f, JSON.stringify({ suites: [], fallas: [], ausentes: [], waiting_on_main: { sha: l.base, suites: [{ ruta: RUTA(n), raiz: 'arnes', casos: [`✖ ${n}-1`] }] } }));
    return f;
  };
  const set = (n, run, extra = []) => marker(l, ['waiting-on-main', 'set', '--repo', l.repo, '--tree', l.repo, '--summary', resumen(n), '--run', run, ...extra], { TYCON_TEST_GATE: '1' });
  assert.equal(set('a', 'corrida-1').status, 0);
  assert.equal(set('b', 'corrida-1').status, 0);
  assert.deepEqual([...esperaDe(l).suites].sort(), [RUTA('a'), RUTA('b')], 'la segunda parte borró la primera');
  assert.equal(set('c', 'corrida-2').status, 0);
  assert.deepEqual(esperaDe(l).suites, [RUTA('c')], 'una corrida nueva arrastró lo de antes');
  assert.equal(set('a', 'corrida-3', ['--merge']).status, 0);
  assert.deepEqual([...esperaDe(l).suites].sort(), [RUTA('a'), RUTA('c')], '--merge no sumó');
  assert.equal(esperas(l).length, 1, 'una entrada por repo');
  // el registro de main roto guarda la raíz de cada suite, para la espera de fondo
  assert.equal(estadoDeMain(l).data.broken[0].raiz[RUTA('a')], 'arnes');
});

test('MainWait_TwoRepos_OrderAndSinceKept @story-8.309 @ac-9 — con dos repos esperando, una corrida nueva no cambia el orden de los ids ni la hora de la espera', () => {
  // 🔴 mutación: mover al final la entrada que se escribe da vuelta el texto de la nota y reinicia «desde las».
  const l = repoDeJuguete({ enMain: { a: suite('a') } });
  const otro = repoDeJuguete({ enMain: { a: suite('a') }, nombre: 'mw-otro-' });
  escribirMarcador(l);
  const resumen = (repo) => {
    const f = path.join(tmp('mw-orden-'), 'suites.json');
    fs.writeFileSync(f, JSON.stringify({ suites: [], fallas: [], ausentes: [], waiting_on_main: { sha: repo.base, suites: [{ ruta: RUTA('a'), raiz: 'arnes', casos: ['✖ a-1'] }] } }));
    return f;
  };
  const set = (repo, run) => marker(l, ['waiting-on-main', 'set', '--repo', repo.repo, '--tree', repo.repo, '--summary', resumen(repo), '--run', run], { TYCON_TEST_GATE: '1' });
  const nota = () => leer(path.join(l.home, '.claude', '.tycon-pipeline', 'doing', `${SID}.json`));
  assert.equal(set(l, 'corrida-1').status, 0);
  assert.equal(set(otro, 'corrida-1').status, 0);
  const antes = nota();
  const orden = esperas(l).map((w) => w.repo);
  assert.equal(set(l, 'corrida-2').status, 0);
  assert.deepEqual(esperas(l).map((w) => w.repo), orden, 'la corrida nueva cambió el orden');
  assert.equal(nota().waitingFor, antes.waitingFor);
  assert.equal(nota().waitingSince, antes.waitingSince, 'la hora de la espera se reinició');
});

test('MainWait_Mark_OnlyWithWait @story-8.309 @ac-9 · TG6 SharedCheck_MarkAfterGreenSibling @story-8.294 @ac-18 —mark deja el check en espera-main sólo con una espera anotada', () => {
  const l = repoDeJuguete({ enMain: { a: suite('a') } });
  escribirMarcador(l, { checks: { tests: 'green' } });
  let m = marker(l, ['waiting-on-main', 'mark'], { TYCON_TEST_GATE: '1' });
  assert.equal(m.status, 1, m.out);
  assert.match(m.out, /sin espera anotada/);
  assert.equal(marcador(l).checks.tests, 'green');
  escribirMarcador(l, { checks: { tests: 'green' }, waitingOnMain: [{ repo: l.repo, tree: l.repo, id: 'main-1', sha: l.base, suites: [RUTA('a')], since: new Date().toISOString() }] });
  m = marker(l, ['waiting-on-main', 'mark'], { TYCON_TEST_GATE: '1' });
  assert.equal(m.status, 0, m.out);
  assert.equal(marcador(l).checks.tests, 'espera-main');
});
