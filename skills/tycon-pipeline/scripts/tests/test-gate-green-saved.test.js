'use strict';

/**
 * test-gate-green-saved.test.js — después de una completa en verde, el portón corre sólo lo que cambió desde entonces.
 *
 * En un repo que acota el portón (`.test-gate.yaml` con `full_suite_by`), una completa verde que midió todo lo suyo guarda
 * lo medido (`marker.js tests-failed save-green`). La corrida siguiente compara la carpeta con la de esa completa: igual,
 * cierra sin correr nada; con cambios, corren sólo las suites que leen lo cambiado y se juntan con lo guardado. Un cambio
 * en un control, el instalador, lo compartido o la lista de suites, otro recorte, lo guardado tocado u otra historia
 * corren la completa como siempre; main traído cuenta como un cambio más de la carpeta. La completa la sigue corriendo la CI del pedido.
 *
 * Todo corre sobre un repo de prueba con tres suites de bash que leen un archivo cada una (docs/a.md, docs/b.md,
 * docs/c.md) y salen con el código de su archivo de estado, y una HOME de prueba con un marcador falso.
 *
 * stable-data: lee el reloj a propósito — el marcador falso lleva la hora de ahora para que marker.js no lo dé por
 * abandonado.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/test-gate-green-saved.test.js < /dev/null
 */

// partida sin mover sus pruebas: cada parte es test-gate-green-saved.p<k>.test.js (cuáles, suite-parts.json de esta carpeta)
const test = require('./lib/suite-parts.js').test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
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
 * (un control, el grupo del instalador, lo compartido). `extra`: más entradas de suites.json. `grupo` (con `listas`): una
 * suite `i` del grupo `installer`, que la completa difiere mientras la story no toque el instalador.
 */
function lab({ listas = false, extra = [], grupo = false } = {}) {
  const home = tmp('gs-home-');
  const state = tmp('gs-state-');
  const skills = tmp('gs-skills-');
  const repo = tmp('gs-repo-');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(repo, 'config', 'user.name', 'prueba');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); };
  const entradas = ['a', 'b', 'c'].map((n) => ({ raiz: 'arnes', ruta: RUTA(n) }));
  if (grupo) entradas.push({ raiz: 'arnes', ruta: RUTA('i') });
  escribir('scripts/tests/suites.json', `${JSON.stringify({ diarias: [...entradas, ...extra.map((e) => e.entrada)], semanales: [] }, null, 2)}\n`);
  for (const n of ['a', 'b', 'c']) { escribir(`scripts/tests/${n}.test.sh`, suite(n)); escribir(`docs/${n}.md`, `${n}\n`); }
  if (grupo) escribir('scripts/tests/i.test.sh', suite('i', 'installer/setup.sh'));
  for (const e of extra) escribir(`scripts/${e.entrada.ruta}`, e.texto);
  if (listas) {
    escribir('scripts/ci/control-x.js', '// un control\n');
    escribir('scripts/ci/controls-from-base.json', `${JSON.stringify({ controls: [{ name: 'x', script: 'scripts/ci/control-x.js', rules: [] }], content: [], workflows: [], approvals: [] }, null, 2)}\n`);
    const delGrupo = grupo ? { 'i.test.sh': { group: 'installer', patterns: ['scripts/tests/i.test.sh'] } } : {};
    escribir('scripts/ci/heavy-suites.json', `${JSON.stringify({ shared: { patterns: ['lib/shared/**'] }, groups: { installer: { patterns: ['installer/**'] } }, suites: delGrupo }, null, 2)}\n`);
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
const meta = (g) => JSON.parse(fs.readFileSync(path.join(g.dir, 'meta.json'), 'utf8'));
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

test('T4 GreenSaved_ChainComparesWithLastGreen @story-8.263 @ac-4 @story-8.297 @ac-2 — la segunda corrida compara con el último verde juntado', () => {
  // el cierre en verde, juntado, es el nuevo punto de partida
  const l = conCompletaVerde();
  const antes = verde(l);
  tocar(l, 'docs/b.md');
  assert.deepEqual(puerta(l).corridas, ['b']);
  assert.notEqual(verde(l).hash, antes.hash, 'el cierre en verde reemplaza lo guardado');
  tocar(l, 'docs/c.md');
  const r = puerta(l);
  assert.deepEqual(r.corridas, ['c'], r.out);
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

test('T7 GreenSaved_ClassesStillFull @story-8.263 @ac-6 @story-8.279 @ac-7 @story-8.299 @ac-10 — otro recorte y el instalador siguen pidiendo la completa; una diferida que vuelve, ya no; main traído sin cambios, nada', () => {
  const l = conCompletaVerde();
  git(l.repo, 'commit', '-q', '--allow-empty', '-m', 'main avanzó');
  escribirMarcador(l, { baseSha: git(l.repo, 'rev-parse', 'HEAD').stdout.trim(), testsGreenFull: marcador(l).testsGreenFull });
  let r = puerta(l);
  // main traído cuenta como un cambio más de la carpeta: sin cambios, no corre nada
  assert.deepEqual(r.corridas, [], r.out);
  assert.doesNotMatch(r.out, /la base cambió/);
  escribirMarcador(l, { baseSha: marcador(l).baseSha, testsGreenFull: marcador(l).testsGreenFull, size: 'liviana' });
  tocar(l, 'docs/a.md');
  r = puerta(l);
  assert.match(r.out, /corre la completa como siempre: [^\n]*recorte/, r.out);
  // una suite diferida por sus carpetas que lo cambiado vuelve a hacer correr: acotada, no la completa
  const d = conCompletaVerde({ extra: [{ entrada: { raiz: 'arnes', ruta: 'tests/g.test.sh', gate_only_when_touching: ['G/**'] }, texto: suite('g', 'G/x.md') }] });
  tocar(d, 'G/x.md');
  r = puerta(d);
  assert.equal(r.status, 0, r.out);
  assert.match(lineasDeModo(r.out)[0], /^\[test-gate\] modo acotada · /, r.out);
  assert.doesNotMatch(r.out, /corre la completa como siempre/);
  assert.match(r.out, /^VUELVE\s+g\.test\.sh/m, r.out);
  // con lo guardado verde, el instalador tocado pide la completa aunque una suite del grupo esté diferida
  const i = conCompletaVerde({ listas: true, grupo: true });
  const guardado = JSON.parse(fs.readFileSync(path.join(verde(i).dir, 'resumen.json'), 'utf8'));
  assert.ok((guardado.deferred_suites || []).some((x) => x.suite.endsWith('/i.test.sh')), `la completa difirió la del grupo: ${JSON.stringify(guardado.deferred_suites)}`);
  tocar(i, 'installer/setup.sh', '# otro\n');
  r = puerta(i);
  assert.match(r.out, /corre la completa como siempre: cambió el instalador \(installer\/setup\.sh\)/, r.out);
  assert.deepEqual(r.corridas, [...TODAS, 'i'], r.out);
});

test('T8 GreenSaved_RealFullReplaces_ClosedSavesJoined @story-8.263 @ac-7 @story-8.297 @ac-1 — la completa reemplaza lo guardado; la que cerró en verde guarda lo juntado', () => {
  const l = conCompletaVerde({ listas: true });
  tocar(l, 'scripts/ci/control-x.js', '// otro\n');
  estado(l, 'a', 1);
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.equal(verde(l), null, 'la completa roja borró lo verde');
  assert.ok(roja(l), 'y guardó la roja');
  const c = conCompletaVerde();
  const antes = verde(c);
  const metaAntes = meta(antes);
  tocar(c, 'docs/b.md');
  assert.equal(puerta(c).status, 0);
  assert.notEqual(verde(c).hash, antes.hash, 'la que cerró en verde guarda lo juntado');
  assert.equal(meta(verde(c)).origen_at, metaAntes.at, 'con la hora de la completa de origen');
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

// ── El último verde, la foto del arranque, el motivo de cada corrida ──────────────────────────────────────────────────
// El cierre en verde con lo guardado pasa a ser el punto de partida; una carpeta que cambió mientras corría guarda con la
// foto del arranque; cada corrida de arriba dice su modo y su motivo, lo anota en el marcador (testsSavedNote) y en
// gates.log (test-gate-run).

const GATES_LOG = (l) => path.join(l.home, '.claude', '.tycon-pipeline', 'gates.log');
const registro = (l) => { try { return fs.readFileSync(GATES_LOG(l), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.name === 'test-gate-run'); } catch (_) { return []; } };
const nota = (l) => (marcador(l).testsSavedNote || []).find((x) => x.repo === l.repo) || null;
const lineasDeModo = (out) => out.split('\n').filter((x) => /^\[test-gate\] modo /.test(x));
const GUARDE = /guardé este verde \(juntado con la completa de las \d\d:\d\d\): la próxima corrida corre sólo lo que cambie desde acá/;
const fotoDeAhora = (l) => JSON.parse(spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'after-main.js'), 'snapshot', l.repo], { encoding: 'utf8' }).stdout).tree;
const medidoDe = (g) => JSON.parse(fs.readFileSync(path.join(g.dir, 'medido.json'), 'utf8'));

// Una suite que lee docs/a.md (corre con la historia) y, con GS_TOUCH, escribe ese archivo mientras corre.
const ESCRITORA = { entrada: { raiz: 'arnes', ruta: 'tests/w.test.sh' }, texto: `#!/usr/bin/env bash
# lee docs/a.md
echo "w" >> "$GS_STATE/corridas"
[ -n "\${GS_TOUCH:-}" ] && echo "durante" >> "$GS_TOUCH"
exit 0
` };
// Una suite que lee docs/a.md y, con GS_SLEEP, se queda corriendo: para cortar el portón a mitad.
const DORMIDA = { entrada: { raiz: 'arnes', ruta: 'tests/z.test.sh' }, texto: `#!/usr/bin/env bash
# lee docs/a.md
echo "z" >> "$GS_STATE/corridas"
[ -n "\${GS_SLEEP:-}" ] && sleep 60
exit 0
` };

/** El portón cortado con una señal mientras corre la suite dormida; devuelve su salida. */
async function cortada(l) {
  limpiar(l);
  const p = spawn('bash', [TEST_GATE, l.repo], { cwd: l.repo, env: entorno(l, { GS_SLEEP: '1' }) });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const fin = new Promise((ok) => p.on('close', ok));
  for (let i = 0; i < 300 && !corridas(l).includes('z'); i += 1) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(corridas(l).includes('z'), `la suite dormida no arrancó:\n${out}`);
  p.kill('SIGTERM');
  await fin;
  return out;
}

test('T1 LastGreen_CloseFromRed_BecomesNewGreen @story-8.297 @ac-1 — el cierre en verde desde una roja queda como el nuevo verde', () => {
  // 🔴 mutación: dejar el cierre sin guardar deja a la historia sin nada guardado y verde(l) en null
  const l = lab();
  estado(l, 'a', 1);
  assert.notEqual(puerta(l).status, 0);
  const origen = meta(roja(l));
  estado(l, 'a', 0);
  assert.equal(puerta(l, ['--suite', RUTA('a')]).status, 0);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, [], r.out);
  assert.match(r.out, GUARDE);
  const g = verde(l);
  assert.ok(g, `no guardó el cierre:\n${r.out}`);
  assert.equal(g.hash, ff().redHash(g.dir));
  const m = meta(g);
  assert.deepEqual([m.origen, m.storyId, m.origen_at], ['verde', '9.263', origen.at]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(g.dir, 'resumen.json'), 'utf8')).suites.length, 3, 'el resumen juntado trae las tres');
  assert.equal(medidoDe(g).tree, fotoDeAhora(l), 'con la foto de esa corrida');
  assert.equal(roja(l), null, 'la roja de origen ya se usó');
});

test('T2 LastGreen_ChainOfFixes_RunsOnlyTheNewChange @story-8.297 @ac-1 @ac-2 — dos arreglos seguidos: el segundo corre sólo lo suyo', () => {
  // 🔴 mutación: comparar contra la completa de origen hace correr b otra vez en el segundo arreglo
  const l = conCompletaVerde();
  tocar(l, 'docs/b.md');
  let r = puerta(l);
  assert.deepEqual(r.corridas, ['b'], r.out);
  assert.match(r.out, GUARDE);
  tocar(l, 'docs/c.md');
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['c'], r.out);
  assert.match(r.out, GUARDE, 'y vuelve a guardar');
  assert.equal(medidoDe(verde(l)).tree, fotoDeAhora(l));
});

test('T3 LastGreen_CloseRed_KeepsLastGreen @story-8.297 @ac-3 — un cierre rojo deja lo guardado, verde o rojo', () => {
  // 🔴 mutación: borrar la roja de origen al cerrar en rojo deja roja(o) en null
  const v = conCompletaVerde();
  const antes = verde(v);
  tocar(v, 'docs/b.md');
  estado(v, 'b', 1);
  let r = puerta(v);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual((marcador(v).testsFailed || []).map((x) => x.ruta), [RUTA('b')]);
  assert.deepEqual(verde(v), antes, 'el verde de antes sigue');
  const o = lab();
  estado(o, 'a', 1);
  assert.notEqual(puerta(o).status, 0);
  estado(o, 'a', 0);
  assert.equal(puerta(o, ['--suite', RUTA('a')]).status, 0);
  const rojaAntes = roja(o);
  tocar(o, 'docs/c.md');
  estado(o, 'c', 1);
  r = puerta(o);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual((marcador(o).testsFailed || []).map((x) => x.ruta), [RUTA('c')], r.out);
  assert.deepEqual(roja(o), rojaAntes, `la roja de origen sigue, con su repetida:\n${r.out}`);
  assert.ok(JSON.parse(fs.readFileSync(path.join(rojaAntes.dir, 'repetidas.json'), 'utf8'))[RUTA('a')]);
  assert.equal(verde(o), null);
});

test('T4 LastGreen_CloseNotFullyMeasured_KeepsOldAndSaysWhy @story-8.297 @ac-4 @ac-1 — lo que no se puede guardar no reemplaza lo de antes', () => {
  // 🔴 mutación: guardar el cierre sin mirar el perdón de la roja de origen pasa a verde una suite perdonada ayer
  // una ausente: la corrida sale roja y lo guardado sigue
  const l = conCompletaVerde();
  const antes = verde(l);
  fs.rmSync(path.join(l.repo, 'scripts', 'tests', 'b.test.sh'));
  let r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(verde(l), antes, r.out);
  assert.equal(nota(l).guardo, 'no');
  assert.ok(nota(l).motivo, JSON.stringify(nota(l)));
  // la roja de origen trae una suite perdonada por lo heredado (perdón parcial): el cierre en verde no la pasa a verde
  const p = lab();
  conFoto(p, ['c.test.sh']);
  estado(p, 'a', 1);
  estado(p, 'c', 1);
  r = puerta(p);
  assert.notEqual(r.status, 0, r.out);
  assert.ok(roja(p), r.out);
  estado(p, 'a', 0);
  assert.equal(puerta(p, ['--suite', RUTA('a')]).status, 0);
  r = puerta(p);
  assert.equal(r.status, 0, r.out);
  assert.equal(verde(p), null, `guardó como verde una roja perdonada:\n${r.out}`);
  assert.match(r.out, /no guardo este cierre: lo guardado trae rojas perdonadas con la foto de otro día/);
  assert.match(nota(p).motivo, /rojas perdonadas/);
  // el perdón de esta corrida sí se guarda, con el resumen de antes del perdón: se vuelve a juzgar al cerrar
  const h = lab();
  conFoto(h, ['c.test.sh']);
  estado(h, 'c', 1);
  assert.equal(puerta(h).status, 0);
  const primero = verde(h);
  r = puerta(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ya estaba rojo/);
  assert.notEqual(verde(h).hash, primero.hash, `el cierre perdonado en esta corrida se guarda:\n${r.out}`);
  assert.deepEqual(meta(verde(h)).heredadas, [RUTA('c')], 'con la heredada para volver a juzgarla');
});

test('T18 Save_FailsMidway_KeepsPreviousAndNotes @story-8.297 @ac-4 @ac-8 — un guardado que falla deja lo de antes y lo anota', (t) => {
  // 🔴 mutación: borrar la carpeta antes de copiar deja lo guardado vacío si la copia falla
  const l = conCompletaVerde();
  const antes = verde(l);
  const casa = path.dirname(antes.dir);
  // como root una carpeta de sólo lectura se escribe igual: la copia que falla no se puede armar, el resto sí
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    tocar(l, 'docs/b.md');
    fs.chmodSync(casa, 0o555);
    t.after(() => fs.chmodSync(casa, 0o755));
    const r = puerta(l);
    fs.chmodSync(casa, 0o755);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(verde(l), antes, r.out);
    assert.equal(antes.hash, ff().redHash(antes.dir), 'lo de antes está entero');
    assert.match(r.out, /no pude guardar/);
    assert.equal(nota(l).guardo, 'no');
    assert.match(nota(l).motivo, /no pude guardar/);
  }
  // un --summary que no existe: sale 1, sin tocar lo guardado
  const s = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'tests-failed', 'save-green', '--summary', path.join(l.state, 'no-existe.json'),
    '--measured', path.join(antes.dir, 'medido.json'), '--repo', l.repo], { cwd: l.repo, encoding: 'utf8', env: entorno(l, { TYCON_TEST_GATE: '1' }) });
  assert.equal(s.status, 1, `${s.stdout}${s.stderr}`);
  assert.deepEqual(verde(l), antes);
  assert.equal(antes.hash, ff().redHash(antes.dir));
  // los restos de un guardado que murió a mitad: una carpeta nueva se borra; sin la vigente, la vieja vuelve a su lugar
  const casa2 = tmp('gs-restos-');
  const dir = path.join(casa2, 'sesion-repo');
  const opts = { dir, summaryFile: path.join(antes.dir, 'resumen.json'), measuredFile: path.join(antes.dir, 'medido.json'), base: null, recorte: '' };
  ff().saveGreen(opts);
  fs.mkdirSync(`${dir}.nuevo-999999`);
  fs.renameSync(dir, `${dir}.viejo-999998`);
  const h = ff().saveGreen(opts);
  assert.deepEqual(fs.readdirSync(casa2), ['sesion-repo'], 'no quedan restos');
  assert.equal(h, ff().redHash(dir));
});

test('T5 StartPhoto_GreenFolderChangedDuringRun_SavesAndNextRunsChanged @story-8.297 @ac-5 — una carpeta que cambia mientras corre guarda con la foto del arranque', () => {
  // 🔴 mutación: guardar con la foto del final da por medido lo que cambia mientras corre, y c no vuelve a correr
  const l = lab({ extra: [ESCRITORA] });
  let r = puerta(l, [], { GS_TOUCH: path.join(l.repo, 'docs', 'c.md') });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /la carpeta cambió mientras corría: guardo con la foto del arranque; la próxima corrida vuelve a correr lo que lee lo cambiado durante la corrida/);
  assert.ok(verde(l), r.out);
  assert.notEqual(medidoDe(verde(l)).tree, fotoDeAhora(l), 'la foto es la del arranque');
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['c'], r.out);
});

test('T6 StartPhoto_RedFolderChangedDuringRun_SavesRed @story-8.297 @ac-6 — lo mismo con una roja', () => {
  // 🔴 mutación: no guardar la roja con la carpeta cambiada deja la próxima corrida entera
  const l = lab({ extra: [ESCRITORA] });
  estado(l, 'a', 1);
  let r = puerta(l, [], { GS_TOUCH: path.join(l.repo, 'docs', 'c.md') });
  assert.notEqual(r.status, 0, r.out);
  assert.ok(roja(l), `no guardó la roja:\n${r.out}`);
  assert.notEqual(medidoDe(roja(l)).tree, fotoDeAhora(l), 'la foto es la del arranque');
  estado(l, 'a', 0);
  assert.equal(puerta(l, ['--suite', RUTA('a')]).status, 0);
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /la carpeta cambió desde la completa roja \(docs\/c\.md\)/);
  assert.deepEqual(r.corridas, ['c'], r.out);
});

test('T8 Decision_NothingSaved_SaysWhyWithLastNote @story-8.297 @ac-8 — sin nada guardado dice por qué, con la nota de la última', async () => {
  // 🔴 mutación: leer la nota de cualquier repo o historia saca «entera» en la primera corrida de otra historia
  const l = lab();
  fs.rmSync(path.join(l.repo, 'scripts', 'tests', 'b.test.sh'));
  let r = puerta(l);
  let [linea] = lineasDeModo(r.out);
  assert.match(linea, /^\[test-gate\] modo primera · corre la completa: no hay un verde guardado de esta historia en esta sesión$/, r.out);
  assert.equal(nota(l).guardo, 'no');
  git(l.repo, 'checkout', '--', 'scripts/tests/b.test.sh');
  r = puerta(l);
  [linea] = lineasDeModo(r.out);
  assert.match(linea, /^\[test-gate\] modo entera · corre la completa: no hay un verde guardado de esta historia en esta sesión; la última corrida, de las \d\d:\d\d, no guardó: /, r.out);
  // después de una cortada: la cortada no anotó nada
  const c = lab({ extra: [DORMIDA] });
  await cortada(c);
  assert.equal(nota(c), null);
  r = puerta(c);
  assert.match(lineasDeModo(r.out)[0], /^\[test-gate\] modo primera /, r.out);
  // una nota de otro repo, o de otra historia de la misma sesión, no cuenta
  const o = lab();
  escribirMarcador(o, { testsSavedNote: [{ repo: '/otro/repo', storyId: '9.263', at: new Date().toISOString(), guardo: 'no', motivo: 'de otro repo' }] });
  assert.match(lineasDeModo(puerta(o).out)[0], /^\[test-gate\] modo primera /);
  const s = lab();
  assert.equal(puerta(s).status, 0);
  assert.ok(nota(s));
  const set = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '9.264', storyPath: '', repoPath: s.repo }), '--replace'],
    { cwd: s.repo, encoding: 'utf8', env: entorno(s) });
  assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);
  assert.equal(marcador(s).testsSavedNote, undefined, 'marker.js set no la pasa a otra historia');
  tocar(s, 'docs/a.md');
  assert.match(lineasDeModo(puerta(s).out)[0], /^\[test-gate\] modo primera /);
});

test('RedSaved_StoryChange_NotCarriedOver — lo guardado de una completa roja no pasa a otra historia', () => {
  const l = lab();
  const guardada = { repo: l.repo, storyId: '9.263', at: new Date().toISOString(), dir: path.join(l.state, 'roja') };
  const set = (storyId, extra = []) => spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId, storyPath: '', repoPath: l.repo }), ...extra],
    { cwd: l.repo, encoding: 'utf8', env: entorno(l) });
  escribirMarcador(l, { testsRedFull: [guardada], testsGreenFull: [{ ...guardada, dir: path.join(l.state, 'verde') }] });
  let r = set('9.264', ['--replace']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(marcador(l).testsGreenFull, undefined, 'lo verde guardado no pasa a otra historia');
  assert.equal(marcador(l).testsRedFull, undefined, 'lo rojo guardado no pasa a otra historia');
  // con la misma historia, lo rojo guardado sigue
  escribirMarcador(l, { testsRedFull: [guardada], stepsCompleted: [], stepsPending: [] });
  r = set('9.263');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(marcador(l).testsRedFull, [guardada], 'con la misma historia, lo rojo guardado sigue');
});

test('T9 Decision_EveryMode_OneLine @story-8.297 @ac-8 — cada corrida dice un solo renglón con su modo', () => {
  // 🔴 mutación: imprimir el renglón sólo en la completa deja callados el cierre y la acotada
  const l = lab({ listas: true });
  const modos = [];
  const una = () => { const r = puerta(l); const ls = lineasDeModo(r.out); assert.equal(ls.length, 1, r.out); modos.push(ls[0].match(/modo (primera|entera|acotada|sin correr) · /)[1]); };
  una();
  una();
  tocar(l, 'docs/b.md');
  una();
  tocar(l, 'scripts/ci/control-x.js', '// otro\n');
  una();
  assert.deepEqual(modos, ['primera', 'sin correr', 'acotada', 'entera']);
});

test('T19 Decision_UnreadableMarker_CountsAsWhole @story-8.297 @ac-8 @ac-10 — un marcador que no se deja leer cuenta como entera, no como primera', () => {
  // 🔴 mutación: tomar el `{}` que imprime `get` con un marcador roto como «sin nota» achica las repeticiones
  const l = conCompletaVerde();
  fs.writeFileSync(markerFile(l), '{roto');
  tocar(l, 'docs/b.md');
  const r = puerta(l);
  const ls = lineasDeModo(r.out);
  assert.equal(ls.length, 1, r.out);
  assert.match(ls[0], /^\[test-gate\] modo entera · /, r.out);
  assert.match(ls[0], /no pude leer el marcador/);
  assert.deepEqual(registro(l).map((x) => x.modo).slice(-1), ['entera']);
});

test('T10 GatesLog_RunLine_PerModeAndNotWhenCutOrNoTurn @story-8.297 @ac-9 — un renglón por corrida terminada, ninguno por la cortada ni la ocupada', async () => {
  // 🔴 mutación: anotar desde el trap de salida suma renglones de corridas que no terminaron
  const l = lab({ extra: [DORMIDA] });
  await cortada(l);
  assert.equal(registro(l).length, 0, 'la cortada no anota');
  assert.equal(puerta(l).status, 0);
  tocar(l, 'docs/b.md');
  assert.equal(puerta(l).status, 0);
  const lineas = registro(l);
  assert.equal(lineas.length, 2, JSON.stringify(lineas));
  for (const x of lineas) {
    for (const k of ['ts', 'sessionId', 'repoPath', 'story', 'modo', 'motivo', 'origen_at', 'suites', 'duracion_ms', 'exit', 'guardo', 'guardo_motivo']) {
      assert.ok(Object.prototype.hasOwnProperty.call(x, k), `${k}: ${JSON.stringify(x)}`);
    }
  }
  assert.deepEqual(lineas.map((x) => [x.story, x.modo, x.guardo, x.exit]), [['9.263', 'primera', 'verde', 0], ['9.263', 'acotada', 'verde', 0]]);
  assert.equal(lineas[1].suites, 1);
  assert.equal(lineas[1].origen_at, meta(verde(l)).origen_at, 'la acotada nombra la hora de la completa de origen');
  // ocupada: otra corrida de las pruebas en marcha en este repo (su candado recién creado)
  const huella = require('crypto').createHash('sha1').update(l.repo).digest('hex').slice(0, 16);
  const candado = path.join(l.home, '.claude', '.tycon-pipeline', 'run-check-locks', `tests-${huella}`);
  fs.mkdirSync(candado, { recursive: true });
  tocar(l, 'docs/c.md');
  let r = puerta(l);
  assert.equal(r.status, 75, r.out);
  fs.rmSync(candado, { recursive: true, force: true });
  assert.equal(registro(l).length, 2, 'la ocupada no anota');
  // sin turno (77): con cien suites, el turno de la máquina lo tiene otra sesión
  const muchas = Array.from({ length: 100 }, (_, i) => ({ entrada: { raiz: 'arnes', ruta: `tests/m${i}.test.sh` }, texto: suite(`m${i}`, 'docs/a.md') }));
  const t = lab({ extra: muchas });
  // con el tope de la máquina de fábrica (60) una acotada no llega a pedir turno: este repo lo sube
  fs.writeFileSync(path.join(t.repo, '.test-gate.yaml'), 'test_gate:\n  scope: touched\n  full_suite_by: "la CI de prueba"\n  max_local_suites: 200\n');
  git(t.repo, 'add', '-A'); git(t.repo, 'commit', '-q', '-m', 'tope');
  fs.mkdirSync(path.join(t.repo, 'scripts', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(t.repo, 'scripts', 'tools', 'heavy-turn.js'),
    "module.exports = { BUSY_EXIT: 77, take: () => ({ ok: false, message: 'el turno lo tiene otra sesión (de prueba)' }) };\n");
  r = puerta(t);
  assert.equal(r.status, 75, r.out);
  assert.match(r.out, /el turno lo tiene otra sesión \(de prueba\)/);
  assert.equal(registro(t).length, 0, 'la sin turno no anota');
});

test('T14 Safety_ControlChangedAfterLastGreen_StillFullWithMotive @story-8.297 @ac-12 — después del último verde, un control corre la completa y lo dice', () => {
  // 🔴 mutación: saltear los criterios de lo que pide la completa con un verde que salió de un cierre
  const l = conCompletaVerde({ listas: true });
  tocar(l, 'docs/b.md');
  assert.match(puerta(l).out, GUARDE);
  tocar(l, 'scripts/ci/control-x.js', '// otro\n');
  const r = puerta(l);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.match(lineasDeModo(r.out)[0], /^\[test-gate\] modo entera · corre la completa como siempre: cambió un control \(scripts\/ci\/control-x\.js\)$/, r.out);
  const ultima = registro(l).pop();
  assert.deepEqual([ultima.modo, ultima.motivo], ['entera', 'cambió un control (scripts/ci/control-x.js)']);
});

test('T15 NoScopeRepo_AsToday_WithRunLine @story-8.297 @ac-13 @ac-14 — un repo que no acota, y TYCON_GATE_ALL_SUITES=1, corren todo y lo anotan', () => {
  // 🔴 mutación: guardar en un repo que no acota hace que su próxima corrida no corra todo
  const l = lab();
  git(l.repo, 'rm', '-q', '.test-gate.yaml');
  git(l.repo, 'commit', '-q', '-m', 'sin acotar');
  let r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.equal(verde(l), null, 'no guarda');
  let x = registro(l).pop();
  assert.deepEqual([x.modo, x.motivo, x.guardo], ['primera', 'el repo no acota el portón', 'no']);
  const a = lab();
  r = puerta(a, [], { TYCON_GATE_ALL_SUITES: '1' });
  assert.deepEqual(r.corridas, TODAS, r.out);
  assert.ok(verde(a), 'guarda el verde, como hoy');
  x = registro(a).pop();
  assert.deepEqual([x.modo, x.motivo, x.guardo], ['primera', 'TYCON_GATE_ALL_SUITES=1 pide correr todo', 'verde']);
});

// ── Las suites que vuelven por sus carpetas corren solas, no la completa ────────────────────────────────────────────
const G = { entrada: { raiz: 'arnes', ruta: RUTA('g'), gate_only_when_touching: ['G/**'] }, texto: suite('g', 'G/x.md') };
const MOTIVO_G = 'la carpeta cambió desde la completa verde (G/x.md): corren las suites que leen lo cambiado y las que vuelven por sus carpetas (g.test.sh)';
const resumenGuardado = (l) => JSON.parse(fs.readFileSync(path.join(verde(l).dir, 'resumen.json'), 'utf8'));

test('T1 DeferredReturns_RunsOnlyThoseAndChanged @story-8.299 @ac-1 @ac-3 @ac-5 — la diferida que lo cambiado vuelve a hacer correr corre sola, con su renglón, sin la completa', () => {
  // 🔴 mutación: pedir la completa (lo de antes), o pasar la reactivada por los filtros del corredor (la volverían a diferir)
  const l = conCompletaVerde({ extra: [G] });
  tocar(l, 'G/x.md');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['g'], r.out);
  assert.match(r.out, /^VUELVE\s+g\.test\.sh — la completa la difirió y lo cambiado toca G\/\*\*$/m, r.out);
  assert.doesNotMatch(r.out, /corre la completa como siempre/);
  assert.equal(lineasDeModo(r.out)[0], `[test-gate] modo acotada · ${MOTIVO_G}`, r.out);
  const x = registro(l).pop();
  assert.deepEqual([x.modo, x.motivo], ['acotada', MOTIVO_G]);
});

test('T5 Reactivated_Red_GateRed @story-8.299 @ac-4 — una reactivada roja deja el portón en rojo, con ella en las fallas', () => {
  // 🔴 mutación: juntar la reactivada sin su resultado nuevo dejaría verde lo que salió rojo
  const l = conCompletaVerde({ extra: [G] });
  const antes = verde(l);
  tocar(l, 'G/x.md');
  estado(l, 'g', 1);
  const r = puerta(l);
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['g'], r.out);
  assert.deepEqual((marcador(l).testsFailed || []).map((x) => x.ruta), [RUTA('g')], 'g queda en las fallas de la constancia');
  assert.deepEqual(verde(l), antes, 'lo guardado verde sigue');
});

test('T8 LastGreen_ReactivatedSaved_NextRunsThemAgain @story-8.299 @ac-6 — el cierre verde guarda la reactivada medida y fuera de las diferidas; la vuelta siguiente la corre otra vez por su carpeta', () => {
  // 🔴 mutación: conservar deferred_suites en lo guardado haría que la vuelta siguiente la trate como diferida que vuelve
  const l = conCompletaVerde({ extra: [G] });
  assert.ok(resumenGuardado(l).deferred_suites.some((d) => d.suite.endsWith('/g.test.sh')), 'la completa la difirió');
  tocar(l, 'G/x.md');
  let r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['g'], r.out);
  const guardado = resumenGuardado(l);
  const g = guardado.suites.find((s) => s.entrada && s.entrada.ruta === RUTA('g'));
  assert.equal(g && g.exit, 0, `lo guardado trae el resultado nuevo de g: ${JSON.stringify(guardado.suites)}`);
  assert.ok(!(guardado.deferred_suites || []).some((d) => d.suite.endsWith('/g.test.sh')), JSON.stringify(guardado.deferred_suites));
  tocar(l, 'G/y.md');
  r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corridas, ['g'], r.out);
  assert.match(r.out, /^VUELVE\s+g\.test\.sh — lo cambiado toca G\/\*\*, que lee sin nombrar$/m, r.out);
});

// ── La frescura mide los dos repos ──────────────────────────────────────────────────────────────────────────────────
// Dos repos de prueba: `Back` (la historia, que declara a `Front` como hermano) y `Front` (una suite `node --test` en
// `app/`). El portón de verdad con una HOME vacía, y después `suite-freshness.js check` sobre la constancia de `Back`.

const PKG_NODE_TEST = `${JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } })}\n`;
const PRUEBA = (verde) => `const {test}=require('node:test');const assert=require('node:assert');test('caso',()=>{assert.equal(1,${verde ? 1 : 2});});\n`;
const HISTORIA_HERMANO = (modificar) => ['---', 'epic: 9', 'story: "9.279"', 'title: "laboratorio de dos repos"',
  'status: in-progress', 'files_to_create: []', 'files_to_modify:', ...modificar.map((x) => `  - ${x}`), '---', '',
  '# Story 9.279', '', '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '', '### Tests', '',
  '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `Prueba` | 1 | unit | x | y |', ''].join('\n');

function repoDePrueba(dir, archivos) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'prueba@ejemplo.invalid'); git(dir, 'config', 'user.name', 'prueba');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/** `backSuite`: Back tiene su propia suite verde. `frontVerde`: la suite de Front. `sinHermano`: la historia sólo toca Back. */
function labHermano({ backSuite = true, frontVerde = true, sinHermano = false } = {}) {
  const raiz = tmp('gs-hermano-');
  const modificar = sinHermano ? ['src/a.js'] : ['src/a.js', 'Front/app/src/x.js', 'Front/app/tests/x.test.js'];
  const back = repoDePrueba(path.join(raiz, 'Back'), {
    'src/a.js': 'module.exports = 1;\n', 'specs/s.md': HISTORIA_HERMANO(modificar), '.gitignore': '.advisors/\n',
    '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n',
    ...(backSuite ? { 'package.json': PKG_NODE_TEST, 'test/b.test.js': PRUEBA(true) } : {}),
  });
  const front = repoDePrueba(path.join(raiz, 'Front'), {
    '.gitignore': '.advisors/\n', 'app/package.json': PKG_NODE_TEST, 'app/tests/x.test.js': PRUEBA(frontVerde),
  });
  // sin commitear, como lo deja una historia a medio camino
  fs.mkdirSync(path.join(front, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(front, 'app', 'src', 'x.js'), 'module.exports = 1;\n');
  return { raiz, back, front, story: path.join(back, 'specs', 's.md'), home: tmp('gs-hermano-home-') };
}
function entornoHermano(h) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: h.home, USERPROFILE: h.home, CLAUDE_CODE_SESSION_ID: 'gs-hermano' };
}
const portonHermano = (h) => spawnSync('bash', [TEST_GATE, h.back, h.story], { cwd: h.back, encoding: 'utf8', timeout: 120000, env: entornoHermano(h) });
function frescura(h) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'suite-freshness.js'), 'check', h.back], { encoding: 'utf8', env: entornoHermano(h) });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const constanciaDe = (h) => path.join(h.back, '.advisors', 'tests-result.json');
const leerConstancia = (h) => JSON.parse(fs.readFileSync(constanciaDe(h), 'utf8'));
const escribirConstancia = (h, art) => fs.writeFileSync(constanciaDe(h), `${JSON.stringify(art, null, 2)}\n`);
function conPortonVerde(opts) {
  const h = labHermano(opts);
  const r = portonHermano(h);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return h;
}

test('T25 Freshness_SiblingChanged_Stale @story-8.279 @ac-38 @ac-39 — la constancia guarda la huella del hermano, y un cambio en él vence el verde', () => {
  // 🔴 mutación: sin `repos` en la constancia, o con el chequeo midiendo sólo el repo de la historia, el cambio en Front da 0
  const h = conPortonVerde();
  const art = leerConstancia(h);
  assert.match(String(art.code_state && art.code_state.state_hash), /^[0-9a-f]{64}$/, 'los campos de hoy siguen siendo los del repo de la historia');
  const repos = art.code_state.repos || [];
  assert.equal(repos.length, 1, JSON.stringify(art.code_state));
  assert.equal(repos[0].name, 'Front');
  assert.equal(repos[0].root, h.front);
  assert.equal(repos[0].git, true);
  assert.match(String(repos[0].state_hash), /^[0-9a-f]{64}$/);
  let f = frescura(h);
  assert.equal(f.status, 0, f.out);

  fs.appendFileSync(path.join(h.front, 'app', 'src', 'x.js'), 'module.exports.y = 2;\n');
  f = frescura(h);
  assert.equal(f.status, 5, f.out);
  assert.match(f.out, /Front/);
  assert.doesNotMatch(f.out, /Back/, 'el motivo nombra al hermano, no al repo de la historia');

  fs.writeFileSync(path.join(h.front, 'app', 'src', 'x.js'), 'module.exports = 1;\n');
  f = frescura(h);
  assert.equal(f.status, 0, `deshecho, vuelve a fresco: ${f.out}`);
  fs.appendFileSync(path.join(h.back, 'src', 'a.js'), 'module.exports.b = 2;\n');
  f = frescura(h);
  assert.equal(f.status, 5, f.out);
  assert.doesNotMatch(f.out, /Front/, 'un cambio sólo en el repo de la historia no nombra al hermano');
});

test('T25 Freshness_SiblingOnly_StoryRepoWithoutSuite_Measured @story-8.279 @ac-38 @ac-40 — sin suite propia y con el hermano verde, la constancia guarda las dos huellas', () => {
  // 🔴 mutación: la constancia que arma el bloque de hermanos sin `code_state` deja el chequeo en «sin datos»
  const h = conPortonVerde({ backSuite: false });
  const art = leerConstancia(h);
  assert.equal(art.all_green, true);
  assert.match(String(art.code_state && art.code_state.state_hash), /^[0-9a-f]{64}$/, JSON.stringify(art.code_state));
  assert.equal((art.code_state.repos || []).length, 1);
  let f = frescura(h);
  assert.equal(f.status, 0, f.out);
  fs.appendFileSync(path.join(h.front, 'app', 'src', 'x.js'), 'module.exports.y = 2;\n');
  f = frescura(h);
  assert.equal(f.status, 5, f.out);
});

test('T25 Freshness_CommitWithoutChange_StaysFresh @story-8.279 @ac-39 — commitear en el hermano lo que ya estaba no vence el verde', () => {
  const h = conPortonVerde();
  git(h.front, 'add', '-A'); git(h.front, 'commit', '-q', '-m', 'lo de la historia');
  const f = frescura(h);
  assert.equal(f.status, 0, f.out);
});

test('T26 Freshness_SiblingUnreadable_NoData @story-8.279 @ac-40 — lo que no se puede medir no es fresco', () => {
  // 🔴 mutación: saltear la raíz que no se puede leer, o la que no tiene huella, da 0
  let h = conPortonVerde();
  fs.rmSync(h.front, { recursive: true, force: true });
  let f = frescura(h);
  assert.equal(f.status, 6, f.out);
  assert.match(f.out, /Front/);

  h = conPortonVerde();
  const art = leerConstancia(h);
  delete art.code_state.repos;
  escribirConstancia(h, art);
  f = frescura(h);
  assert.equal(f.status, 6, f.out);
  assert.match(f.out, /Front/);
});

test('T26 Freshness_ChangedAndUnreadable_StaleNamesBoth @story-8.279 @ac-40 — un hermano cambiado y otro ilegible: sale 5 y nombra los dos', () => {
  const h = conPortonVerde();
  const otro = repoDePrueba(path.join(h.raiz, 'Otro'), { 'lib/o.js': 'module.exports = 1;\n' });
  const art = leerConstancia(h);
  art.companions.push({ root: otro, scope: null, files: ['lib/o.js'], exit: 0, green: true, no_suite: false });
  art.code_state.repos.push({ name: 'Otro', root: otro, ...require(path.join(SCRIPTS, 'lib', 'suite-freshness.js')).codeState(otro) });
  escribirConstancia(h, art);
  let f = frescura(h);
  assert.equal(f.status, 0, `con las dos huellas guardadas, fresco: ${f.out}`);
  fs.appendFileSync(path.join(h.front, 'app', 'src', 'x.js'), 'module.exports.y = 2;\n');
  fs.rmSync(otro, { recursive: true, force: true });
  f = frescura(h);
  assert.equal(f.status, 5, f.out);
  assert.match(f.out, /Front/);
  assert.match(f.out, /Otro/);
});

test('T26 Freshness_SiblingRed_NotFresh @story-8.279 @ac-40 — un hermano rojo con el repo de la historia verde no es fresco', () => {
  // 🔴 mutación: mirar sólo `suite_green` da 0
  const h = labHermano({ frontVerde: false });
  const r = portonHermano(h);
  assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const art = leerConstancia(h);
  assert.equal(art.suite_green, true);
  assert.equal(art.all_green, false);
  const f = frescura(h);
  assert.equal(f.status, 6, f.out);
  assert.match(f.out, /hermano/);
});

test('T26 Freshness_NoSibling_AsToday @story-8.279 @ac-41 — sin hermano y con una constancia vieja, todo como hoy', () => {
  const h = conPortonVerde({ sinHermano: true });
  const art = leerConstancia(h);
  assert.equal('companions' in art, false);
  assert.equal('repos' in (art.code_state || {}), false);
  let f = frescura(h);
  assert.equal(f.status, 0, f.out);
  fs.appendFileSync(path.join(h.back, 'src', 'a.js'), 'module.exports.b = 2;\n');
  f = frescura(h);
  assert.equal(f.status, 5, f.out);
  assert.match(f.out, /re-correr test-gate\.sh/);
  // una constancia vieja: sólo los campos planos, sin companions
  fs.writeFileSync(path.join(h.back, 'src', 'a.js'), 'module.exports = 1;\n');
  const vieja = leerConstancia(h);
  vieja.code_state = { git: vieja.code_state.git, state_hash: vieja.code_state.state_hash, code_files: vieja.code_state.code_files };
  escribirConstancia(h, vieja);
  f = frescura(h);
  assert.equal(f.status, 0, f.out);
});
