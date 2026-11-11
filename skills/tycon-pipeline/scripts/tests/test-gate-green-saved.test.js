'use strict';

/**
 * test-gate-green-saved.test.js — después de una completa en verde, el portón corre sólo lo que cambió desde entonces.
 *
 * En un repo que acota el portón (`.test-gate.yaml` con `full_suite_by`), una completa verde que midió todo lo suyo guarda
 * lo medido (`marker.js tests-failed save-green`). La corrida siguiente compara la carpeta con la de esa completa: igual,
 * cierra sin correr nada; con cambios, corren sólo las suites que leen lo cambiado y se juntan con lo guardado. Un cambio
 * en un control, el instalador, lo compartido o la lista de suites, otra base, otro recorte, lo guardado tocado u otra
 * historia corren la completa como siempre. La completa la sigue corriendo la CI del pedido.
 *
 * Todo corre sobre un repo de prueba con tres suites de bash que leen un archivo cada una (docs/a.md, docs/b.md,
 * docs/c.md) y salen con el código de su archivo de estado, y una HOME de prueba con un marcador falso.
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/test-gate-green-saved.test.js < /dev/null
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const ff = () => require(path.join(SCRIPTS, 'lib', 'failed-first.js'));

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE',
  'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'TYCON_TEST_GATE_OUT_FILE',
  'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE',
  'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_HOME',
  'TYCON_HARNESS_LOCK_HELD', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER'];

const SID = 'gs-sesion';
const RUTA = (n) => `tests/${n}.test.sh`;
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function git(d, ...a) {
  const fecha = '2026-01-01T00:00:00Z';
  return spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
}

// Una suite de bash que lee su archivo (el corredor elige por las rutas que nombra), anota que corrió y sale con el código
// de su archivo de estado (0 si no hay).
const suite = (n, lee = `docs/${n}.md`) => `#!/usr/bin/env bash
# lee ${lee}
echo "${n}" >> "$GS_STATE/corridas"
exit "$(cat "$GS_STATE/${n}" 2>/dev/null || echo 0)"
`;

/**
 * El laboratorio: repo que acota con tres suites (a, b, c) y, con `listas`, los criterios de clase de un repo del arnés
 * (un control, el grupo del instalador, lo compartido). `extra`: más entradas de suites.json.
 */
function lab({ listas = false, extra = [] } = {}) {
  const home = tmp('gs-home-');
  const state = tmp('gs-state-');
  const skills = tmp('gs-skills-');
  const repo = tmp('gs-repo-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  const entradas = ['a', 'b', 'c'].map((n) => ({ raiz: 'arnes', ruta: RUTA(n) }));
  escribir('scripts/tests/suites.json', `${JSON.stringify({ diarias: [...entradas, ...extra.map((e) => e.entrada)], semanales: [] }, null, 2)}\n`);
  for (const n of ['a', 'b', 'c']) { escribir(`scripts/tests/${n}.test.sh`, suite(n)); escribir(`docs/${n}.md`, `${n}\n`); }
  for (const e of extra) escribir(`scripts/${e.entrada.ruta}`, e.texto);
  if (listas) {
    escribir('scripts/ci/control-x.js', '// un control\n');
    escribir('scripts/ci/controls-from-base.json', `${JSON.stringify({ controls: [{ name: 'x', script: 'scripts/ci/control-x.js', rules: [] }], content: [], workflows: [], approvals: [] }, null, 2)}\n`);
    escribir('scripts/ci/heavy-suites.json', `${JSON.stringify({ shared: { patterns: ['lib/shared/**'] }, groups: { installer: { patterns: ['installer/**'] } }, suites: {} }, null, 2)}\n`);
    fs.copyFileSync(path.join(RAIZ, 'scripts', 'ci', 'suites-for-change.js'), path.join(repo, 'scripts', 'ci', 'suites-for-change.js'));
    escribir('installer/setup.sh', '# instala\n');
    escribir('lib/shared/x.js', '// compartido\n');
  }
  fs.writeFileSync(path.join(repo, '.test-gate.yaml'), 'test_gate:\n  scope: touched\n  full_suite_by: "la CI de prueba"\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const l = { home, state, skills, repo, base: git(repo, 'rev-parse', 'HEAD').stdout.trim() };
  // lo que toca la historia: en un repo que acota, la completa corre las suites que leen lo tocado desde la base
  for (const n of ['a', 'b', 'c']) fs.appendFileSync(path.join(repo, 'docs', `${n}.md`), 'tocado por la historia\n');
  escribirMarcador(l);
  return l;
}

const markerFile = (l) => path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
function escribirMarcador(l, extra = {}) {
  fs.mkdirSync(path.dirname(markerFile(l)), { recursive: true });
  fs.writeFileSync(markerFile(l), JSON.stringify({
    storyId: '9.263', storyPath: '', repoPath: l.repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8, 9, 10, 11],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {}, ...extra,
  }));
}
const marcador = (l) => JSON.parse(fs.readFileSync(markerFile(l), 'utf8'));
const verde = (l) => (marcador(l).testsGreenFull || []).find((x) => x.repo === l.repo) || null;
const roja = (l) => (marcador(l).testsRedFull || []).find((x) => x.repo === l.repo) || null;
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean).sort(); } catch (_) { return []; } };
const limpiar = (l) => fs.rmSync(path.join(l.state, 'corridas'), { force: true });
const constancia = (l) => JSON.parse(fs.readFileSync(path.join(l.repo, '.advisors', 'tests-result.json'), 'utf8'));
const tocar = (l, rel, txt = 'cambio\n') => { fs.mkdirSync(path.dirname(path.join(l.repo, rel)), { recursive: true }); fs.appendFileSync(path.join(l.repo, rel), txt); };
const estado = (l, n, codigo) => fs.writeFileSync(path.join(l.state, n), String(codigo));

function entorno(l, extra = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, GS_STATE: l.state, TYCON_SKILLS_DIR: l.skills, ...extra };
}
function puerta(l, args = [], extra = {}) {
  limpiar(l);
  const r = spawnSync('bash', [TEST_GATE, l.repo, ...args], { cwd: l.repo, encoding: 'utf8', env: entorno(l, extra), timeout: 120000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, corridas: corridas(l) };
}
/** Un laboratorio que ya pasó por su completa verde. */
function conCompletaVerde(opts) {
  const l = lab(opts);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.ok(verde(l), `no guardó la completa verde:\n${r.out}`);
  return l;
}
const TODAS = ['a', 'b', 'c'];

test('T1 GreenSaved_FullGreen_SavesAndMarks @story-8.263 @ac-1 — la completa verde guarda lo medido y el marcador su hash', () => {
  const l = lab();
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, TODAS, r.out);
  const g = verde(l);
  assert.ok(g && /^[0-9a-f]{64}$/.test(g.hash) && g.dir, JSON.stringify(marcador(l)));
  assert.equal(g.hash, ff().redHash(g.dir), 'el hash es el de lo guardado');
  const archivos = fs.readdirSync(g.dir).sort();
  for (const f of ['meta.json', 'medido.json', 'repetidas.json', 'resumen.json']) assert.ok(archivos.includes(f), `falta ${f}: ${archivos}`);
  assert.ok(archivos.every((f) => ff().RED_FILES.includes(f)) && archivos.length <= 5, `sin repeticiones son 5 a lo sumo: ${archivos}`);
  const meta = JSON.parse(fs.readFileSync(path.join(g.dir, 'meta.json'), 'utf8'));
  assert.deepEqual([meta.origen, meta.storyId], ['verde', '9.263']);
  assert.equal(roja(l), null);
});

test('T2 GreenSaved_SameFolder_ClosesWithoutRunning @story-8.263 @ac-2 @ac-10 — la misma carpeta cierra sin correr nada', () => {
  const l = conCompletaVerde();
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, [], `corrió suites:\n${r.out}`);
  assert.match(r.out, /cierra con la completa de las \d\d:\d\d: la carpeta no cambió/);
  const c = constancia(l);
  assert.equal(c.suite_green, true);
  assert.equal(c.suite_green_by, 'completa-guardada');
  assert.ok(c.completa_at, JSON.stringify(c).slice(0, 300));
  assert.equal(c.totals.suites, 3, 'el resumen juntado trae las tres');
  const f = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'suite-freshness.js'), 'check', l.repo], { encoding: 'utf8', env: entorno(l) });
  assert.equal(f.status, 0, `${f.stdout}${f.stderr}`);
});

test('T3 GreenSaved_ChangedFile_RunsOnlyItsSuites @story-8.263 @ac-3 — corren sólo las que leen lo cambiado, juntadas con lo guardado', () => {
  const l = conCompletaVerde();
  tocar(l, 'docs/b.md');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['b'], r.out);
  assert.match(r.out, /la completa de las \d\d:\d\d más 1 suites? por lo cambiado \(docs\/b\.md\)/);
  const c = constancia(l);
  assert.deepEqual([c.suite_green_by, c.totals.suites], ['completa-guardada', 3]);
  assert.deepEqual(c.changed_since_full, ['docs/b.md']);
});

test('T4 GreenSaved_ChainComparesWithOrigin @story-8.263 @ac-4 — la segunda corrida compara con la completa, no con la acotada', () => {
  const l = conCompletaVerde();
  const antes = verde(l);
  tocar(l, 'docs/b.md');
  assert.deepEqual(puerta(l).corridas, ['b']);
  assert.deepEqual(verde(l), antes, 'una acotada en verde no reemplaza lo guardado');
  tocar(l, 'docs/c.md');
  const r = puerta(l);
  assert.deepEqual(r.corridas, ['b', 'c'], r.out);
});

test('T5 GreenSaved_ScopedRed_KeepsSavedAndRepeatFirst @story-8.263 @ac-5 — una acotada roja anota sus rojas y lo guardado sigue', () => {
  const l = conCompletaVerde();
  const antes = verde(l);
  tocar(l, 'docs/b.md');
  estado(l, 'b', 1);
  let r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['b'], r.out);
  const lista = marcador(l).testsFailed || [];
  assert.deepEqual(lista.map((x) => x.ruta), [RUTA('b')]);
  assert.equal(lista[0].full_ts, constancia(l).ts, 'full_ts es la hora de esa acotada');
  assert.deepEqual(verde(l), antes, 'lo guardado verde sigue');
  estado(l, 'b', 0);
  r = puerta(l, ['--suite', RUTA('b')]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /salió de la constancia/, 'la repetición encuentra la constancia por su full_ts');
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['b'], r.out);
});

test('T6 GreenSaved_ControlInstallerShared_RunsFull @story-8.263 @ac-6 — un control, el instalador, lo compartido o la lista de suites corren la completa', () => {
  const l = conCompletaVerde({ listas: true });
  for (const [archivo, clase] of [['scripts/ci/control-x.js', 'un control'], ['installer/setup.sh', 'el instalador'],
    ['lib/shared/x.js', 'algo compartido'], ['scripts/tests/suites.json', 'la lista de suites']]) {
    tocar(l, archivo, archivo.endsWith('.json') ? ' ' : '// otro\n');
    const r = puerta(l);
    assert.equal(r.status, 0, `${archivo}: ${r.out}`);
    assert.deepEqual(r.corridas, TODAS, `${archivo}: ${r.out}`);
    assert.ok(r.out.includes(`corre la completa como siempre: cambió ${clase} (${archivo})`), `${archivo}: ${r.out}`);
  }
});

test('T7 GreenSaved_BaseTrimOrDeferred_RunsFull @story-8.263 @ac-6 — otra base, otro recorte o una diferida que vuelve corren la completa', () => {
  const l = conCompletaVerde();
  git(l.repo, 'commit', '-q', '--allow-empty', '-m', 'main avanzó');
  escribirMarcador(l, { baseSha: git(l.repo, 'rev-parse', 'HEAD').stdout.trim(), testsGreenFull: marcador(l).testsGreenFull });
  let r = puerta(l);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(r.out, /corre la completa como siempre: la base cambió/);
  escribirMarcador(l, { baseSha: marcador(l).baseSha, testsGreenFull: marcador(l).testsGreenFull, size: 'liviana' });
  tocar(l, 'docs/a.md');
  r = puerta(l);
  assert.match(r.out, /corre la completa como siempre: [^\n]*recorte/, r.out);
  // una suite diferida por sus carpetas que lo cambiado vuelve a hacer correr
  const d = conCompletaVerde({ extra: [{ entrada: { raiz: 'arnes', ruta: 'tests/g.test.sh', gate_only_when_touching: ['G/**'] }, texto: suite('g', 'G/x.md') }] });
  tocar(d, 'G/x.md');
  r = puerta(d);
  assert.match(r.out, /corre la completa como siempre: lo cambiado vuelve a hacer correr g\.test\.sh/, r.out);
});

test('T8 GreenSaved_RealFullReplaces_ClosedNeverSaves @story-8.263 @ac-7 — la completa reemplaza lo guardado; la que cerró con él, no', () => {
  const l = conCompletaVerde({ listas: true });
  tocar(l, 'scripts/ci/control-x.js', '// otro\n');
  estado(l, 'a', 1);
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.equal(verde(l), null, 'la completa roja borró lo verde');
  assert.ok(roja(l), 'y guardó la roja');
  const c = conCompletaVerde();
  const antes = verde(c);
  tocar(c, 'docs/b.md');
  assert.equal(puerta(c).status, 0);
  assert.deepEqual(verde(c), antes, 'la que cerró con lo guardado no escribe una completa nueva');
});

test('T9 GreenSaved_Unreadable_OtherStory_RunsFull @story-8.263 @ac-11 — lo guardado tocado, de otra historia o sin foto corre la completa', () => {
  const l = conCompletaVerde();
  fs.appendFileSync(path.join(verde(l).dir, 'resumen.json'), ' ');
  let r = puerta(l);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(r.out, /corre la completa como siempre: lo guardado no coincide con su constancia/);
  const o = conCompletaVerde();
  escribirMarcador(o, { storyId: '9.999', testsGreenFull: marcador(o).testsGreenFull });
  r = puerta(o);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(r.out, /corre la completa como siempre: lo guardado es de otra historia/);
  // sin foto de la carpeta al arrancar: decide no tiene con qué comparar
  const g = verde(conCompletaVerde());
  const d = ff().decide({ dir: g.dir, hash: g.hash, repo: o.repo, tree: null, base: null, recorte: '', storyId: '9.263' });
  assert.deepEqual([d.mode, d.reason], ['full', 'no hay foto de la carpeta para comparar']);
});

test('T10 GreenSaved_GitOrCriteriaFail_RunsFull @story-8.263 @ac-12 — git que no compara o un criterio que no se lee corren la completa', () => {
  const l = conCompletaVerde({ listas: true });
  tocar(l, 'docs/b.md');
  // un git que no contesta al comparar árboles
  const bin = tmp('gs-bin-');
  const real = spawnSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == diff-tree ]] && { echo "fatal: de mentira" >&2; exit 128; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  let r = puerta(l, [], { PATH: `${bin}:${process.env.PATH}` });
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(r.out, /corre la completa como siempre: no pude comparar la carpeta/);
  // heavy-suites.json roto (desde antes de la completa: cambiarlo después es cambiar la lista de suites): el criterio que
  // no se lee nunca cuenta como «no es un control»
  const c = lab({ listas: true });
  fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'heavy-suites.json'), '{ roto');
  assert.equal(puerta(c).status, 0);
  tocar(c, 'docs/b.md');
  r = puerta(c);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(r.out, /corre la completa como siempre: no pude leer los criterios/);
});

test('T11 GreenSaved_OldMarkerWithoutField_RunsFullThenSaves @story-8.263 @ac-13 — un marcador de antes corre la completa y después guarda', () => {
  const l = lab();
  assert.equal(marcador(l).testsGreenFull, undefined);
  let r = puerta(l);
  assert.deepEqual(r.corridas, TODAS, r.out);
  r = puerta(l);
  assert.deepEqual(r.corridas, [], r.out);
});

test('T15 GreenSaved_PrivatePipelinesOrCi_RunsFull @story-8.263 @ac-6 @ac-8 — en el privado, pipelines/ y scripts/ci/ piden la completa', () => {
  const lib = ff();
  const raiz = tmp('gs-priv-');
  for (const rel of ['pipelines/azure-pipelines-maintainers-pr.yml', 'scripts/ci/overlay-harness.js']) {
    const c = lib.claseQuePideLaCompleta([{ repo: 'privado', rel }], { raiz });
    assert.deepEqual(c, { clase: 'un control del privado', archivo: rel }, rel);
  }
  // en el público, la misma ruta sin lista que la nombre no es un control
  assert.equal(lib.claseQuePideLaCompleta([{ repo: 'publico', rel: 'docs/x.md' }], { raiz }), null);
});

test('T16 GreenSaved_AllSuitesEnv_RunsFull @story-8.263 @ac-6 @ac-13 — TYCON_GATE_ALL_SUITES=1 corre la completa y la guarda', () => {
  const l = conCompletaVerde();
  const antes = JSON.parse(fs.readFileSync(path.join(verde(l).dir, 'meta.json'), 'utf8')).at;
  const r = puerta(l, [], { TYCON_GATE_ALL_SUITES: '1' });
  assert.deepEqual(r.corridas, TODAS, r.out);
  const despues = JSON.parse(fs.readFileSync(path.join(verde(l).dir, 'meta.json'), 'utf8')).at;
  assert.ok(Date.parse(despues) > Date.parse(antes), 'lo guardado es el de la completa nueva');
});

// La foto del nocturno, commiteada en el repo como en el privado (la lee lib/inherited-reds.js).
function conFoto(l, rojas) {
  const ci = path.join(l.repo, 'scripts', 'ci');
  fs.mkdirSync(ci, { recursive: true });
  for (const f of ['pr-verdict.js', 'legacy-options.js']) fs.copyFileSync(path.join(RAIZ, 'scripts', 'ci', f), path.join(ci, f));
  fs.mkdirSync(path.join(l.repo, 'scripts', 'controls-bench'), { recursive: true });
  fs.writeFileSync(path.join(l.repo, 'scripts', 'controls-bench', 'ultimo-suites.json'),
    JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), build: '1', failures: rojas }));
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'foto nocturna');
}

test('T21 GreenSaved_InheritedReds_JudgedAgainAtClose @story-8.263 @ac-1 @ac-18 — las heredadas se guardan rojas y se vuelven a juzgar', () => {
  const l = lab();
  conFoto(l, ['c.test.sh']);
  estado(l, 'c', 1);
  let r = puerta(l);
  assert.equal(r.status, 0, `la heredada no frena:\n${r.out}`);
  const resumen = JSON.parse(fs.readFileSync(path.join(verde(l).dir, 'resumen.json'), 'utf8'));
  assert.deepEqual(resumen.fallas.map((f) => f.entrada.ruta), [RUTA('c')], 'lo guardado trae la suite roja, de antes del perdón');
  // con la misma foto, cierra sin correr nada y vuelve a perdonarla
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, [], r.out);
  assert.match(r.out, /ya estaba rojo/);
  // con una foto donde c está verde (sin commitear: no perdona), ya no la perdona
  fs.writeFileSync(path.join(l.repo, 'scripts', 'controls-bench', 'ultimo-suites.json'),
    JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), build: '2', failures: [] }));
  r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual((marcador(l).testsFailed || []).map((x) => x.ruta), [RUTA('c')], r.out);
});
