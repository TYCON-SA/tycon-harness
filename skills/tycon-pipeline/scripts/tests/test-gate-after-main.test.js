'use strict';

/**
 * test-gate-after-main.test.js — el portón no repite lo que ya midió cuando lo único que cambió es lo que trajo main.
 *
 * Corre test-gate.sh entero sobre un repo de prueba con cuatro suites de bash: `a` y `d` nombran el archivo de la historia, `b` no
 * nombra nada, `c` nombra el archivo que trae main; `d` falla cuando se le pide. `origin/main` es una referencia local y la
 * HOME es de prueba, con un marcador falso.
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
const SID = 'tras-main-sesion';
const CI = 'la CI de GitHub del pedido';
const SOLO_MAIN = /lo único que cambió es lo que trajo main/;
const tmp = (t, p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function git(d, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', '-C', d, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const escribir = (d, rel, texto) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), texto); };

const suite = (n, nombra = '') => `#!/usr/bin/env bash
# ${nombra}
echo "${n}" >> "$TG_STATE/corridas"
[ ! -f "$TG_STATE/roja-${n}" ]
`;

function lab(t, { clave = true, papeleo = false } = {}) {
  const l = { home: tmp(t, 'tm-home-'), state: tmp(t, 'tm-state-'), skills: tmp(t, 'tm-skills-'), repo: tmp(t, 'tm-repo-'), historia: null };
  const { repo } = l;
  git(repo, 'init', '-q', '-b', 'story/la-prueba');
  git(repo, 'config', 'user.email', 'prueba@ejemplo.invalid');
  git(repo, 'config', 'user.name', 'prueba');
  const rutas = ['a', 'b', 'c', 'd', ...(papeleo ? ['e'] : [])].map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` }));
  escribir(repo, 'scripts/tests/suites.json', JSON.stringify({ diarias: rutas }));
  if (papeleo) {
    escribir(repo, 'scripts/tests/e.test.sh', suite('e', 'prueba tasks/datos.json'));
    escribir(repo, 'tasks/datos.json', '{}\n');
  }
  escribir(repo, 'scripts/tests/a.test.sh', suite('a', 'prueba lib/acme.js'));
  escribir(repo, 'scripts/tests/b.test.sh', suite('b'));
  escribir(repo, 'scripts/tests/c.test.sh', suite('c', 'prueba lib/otro.js'));
  escribir(repo, 'scripts/tests/d.test.sh', suite('d', 'prueba lib/acme.js'));
  escribir(repo, 'lib/acme.js', 'module.exports = 1;\n');
  escribir(repo, 'lib/otro.js', 'module.exports = 1;\n');
  escribir(repo, '.gitignore', '.advisors/\n');
  if (clave) escribir(repo, '.test-gate.yaml', `test_gate:\n  scope: touched\n  full_suite_by: "${CI}"\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  l.base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', l.base);
  const mf = path.join(l.home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`);
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  fs.writeFileSync(mf, JSON.stringify({
    storyId: 'adhoc-tras-main', storyPath: '', repoPath: repo, baseSha: l.base, sessionId: SID, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8, 9, 10, 11],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {},
  }));
  return l;
}

function puerta(l, ...args) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync('bash', [TEST_GATE, l.repo, ...(l.historia ? [l.historia] : []), ...args], { cwd: l.repo, encoding: 'utf8', timeout: 120000,
    env: { ...env, HOME: l.home, USERPROFILE: l.home, CLAUDE_CODE_SESSION_ID: SID, TG_STATE: l.state, TYCON_SKILLS_DIR: l.skills } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const corridas = (l) => { try { return fs.readFileSync(path.join(l.state, 'corridas'), 'utf8').split('\n').filter(Boolean).sort(); } catch (_) { return []; } };
const borrarCorridas = (l) => fs.rmSync(path.join(l.state, 'corridas'), { force: true });
const artefacto = (l) => JSON.parse(fs.readFileSync(path.join(l.repo, '.advisors', 'tests-result.json'), 'utf8'));
const medido = (l) => path.join(l.repo, '.advisors', 'test-gate-measured.json');

/** El cambio de la historia, sólo preparado, sin commit. */
function cambioDeLaHistoria(l) {
  escribir(l.repo, 'lib/acme.js', 'module.exports = 2;\n');
  git(l.repo, 'add', 'lib/acme.js');
}

/** Main suma un commit que cambia `lib/otro.js` (u otro archivo); devuelve su sha. No toca la carpeta. */
function mainAvanza(l, archivo = 'lib/otro.js') {
  const wt = tmp({ after: (f) => process.on('exit', f) }, 'tm-main-');
  git(l.repo, 'worktree', 'add', '-q', '--detach', wt, 'refs/remotes/origin/main');
  escribir(wt, archivo, 'module.exports = 3;\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'lo de main');
  const sha = git(wt, 'rev-parse', 'HEAD');
  git(l.repo, 'worktree', 'remove', '--force', wt);
  git(l.repo, 'update-ref', 'refs/remotes/origin/main', sha);
  return sha;
}

/** La primera corrida: `d` sale roja, se repite sola en verde, y queda lo medido. */
function primeraConUnaRoja(l) {
  fs.writeFileSync(path.join(l.state, 'roja-d'), '');
  const r = puerta(l);
  assert.equal(r.status, 1, r.out);
  fs.rmSync(path.join(l.state, 'roja-d'));
  const s = puerta(l, '--suite', 'tests/d.test.sh');
  assert.equal(s.status, 0, s.out);
  assert.ok(fs.existsSync(medido(l)), r.out);
  borrarCorridas(l);
}

test('SoloMain_ConAvanceDirecto_CorreLaQueFalloYLasQueNombranLoDeMain — el caso real: cambios sólo preparados y main traído con avance directo', (t) => {
  // 🔴 mutación: comparar commits en vez de la carpeta deja afuera este caso, porque lo medido nunca se commiteó; sin sumar lo
  // que falló, `d` no vuelve a correr.
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, SOLO_MAIN);
  assert.deepEqual(corridas(l), ['c', 'd'], r.out);
});

test('SoloMain_LaHistoriaEnOtroRepo_CorreLoMismo — la corrida cruzada, donde una suite elegida ninguna daría «sin acotar»', (t) => {
  // 🔴 mutación: atender sólo la clave del repo deja afuera la corrida cruzada, que es la de una historia en el repo privado.
  const l = lab(t, { clave: false });
  const otro = tmp(t, 'tm-historia-');
  git(otro, 'init', '-q');
  escribir(otro, 'specs/story-9.md', '---\nepic: 9\nstory: "9.1"\nstatus: in-progress\n---\n# Story\n');
  l.historia = path.join(otro, 'specs', 'story-9.md');
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, SOLO_MAIN);
  assert.deepEqual(corridas(l), ['c', 'd'], r.out);
});

test('SoloMain_ConMergeDeMain_CorreLoMismo — con la historia commiteada y main traído con un merge', (t) => {
  // 🔴 mutación: exigir que main sea un avance directo apaga el arreglo en el caso más común.
  const l = lab(t);
  cambioDeLaHistoria(l);
  git(l.repo, 'commit', '-q', '-m', 'la historia');
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--no-edit', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, SOLO_MAIN);
  assert.deepEqual(corridas(l), ['c', 'd'], r.out);
});

test('SoloMain_LasDemasQuedanDiferidas_ConElMotivo — el resumen dice quién corre la completa', (t) => {
  // 🔴 mutación: sin el motivo, lo que no corrió se lee como que no existe.
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  const art = artefacto(l);
  assert.equal(art.suite_green, true, JSON.stringify(art));
  assert.deepEqual(art.scoped_by_repo, { full_suite_by: CI, none_touched: false });
  assert.ok(art.totals.deferred_suites.some((s) => /b\.test\.sh$/.test(s.suite) && s.reason.includes(CI)), JSON.stringify(art.totals));
});

test('RetoqueDespuesDeTraerMain_CorreLoDeSiempre — un cambio propio de más lo apaga, también en un .json', (t) => {
  // 🔴 mutación: comparar sólo los archivos de código deja pasar el `.json`, que el resto del arnés sí lee.
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  escribir(l.repo, 'lib/datos.json', '{"nuevo":true}\n');
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /hay otro cambio además de lo que trajo main/);
});

test('ConflictoArregladoAMano_CorreLoDeSiempre — lo medido choca con main', (t) => {
  // 🔴 mutación: tomar la mezcla con conflicto como si diera lo de hoy acota sobre un arreglo que nadie midió.
  const l = lab(t);
  cambioDeLaHistoria(l);
  git(l.repo, 'commit', '-q', '-m', 'la historia');
  primeraConUnaRoja(l);
  const sha = mainAvanza(l, 'lib/acme.js');
  spawnSync('git', ['-C', l.repo, 'merge', '--no-edit', sha], { encoding: 'utf8' });
  escribir(l.repo, 'lib/acme.js', 'module.exports = 4;\n');
  git(l.repo, 'add', 'lib/acme.js');
  git(l.repo, 'commit', '-q', '--no-edit');
  const r = puerta(l);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /lo medido choca con main/);
});

test('SinCIQueCorraLaCompleta_CorreTodo — un repo sin la declaración no se acota', (t) => {
  // 🔴 mutación: consultar lo medido sin mirar si el portón ya estaba acotado dejaría sin nadie que corra la completa.
  const l = lab(t, { clave: false });
  cambioDeLaHistoria(l);
  const p = puerta(l);
  assert.equal(p.status, 0, p.out);
  borrarCorridas(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.deepEqual(corridas(l), ['a', 'b', 'c', 'd'], r.out);
});

test('EjecucionAnteriorSinMedir_CorreLoDeSiempre — sin lo medido, o con una corrida que no midió, no se acota', (t) => {
  // 🔴 mutación: dar por buena una ejecución sin dato acota sobre algo que nadie sabe qué midió.
  const l = lab(t);
  cambioDeLaHistoria(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /la corrida anterior no dejó qué midió/);
  const { medido: anotar } = require('../lib/after-main.js');
  const inicio = require('../lib/after-main.js').foto(l.repo);
  const resumen = { fallas: [], ausentes: [], unmeasured_suites: [] };
  assert.ok(anotar({ repo: l.repo, inicio, resumen, exit: 0 }).tree);
  assert.ok(anotar({ repo: l.repo, inicio, resumen, exit: 7 }).no);
  assert.ok(anotar({ repo: l.repo, inicio, resumen: { ...resumen, no_medido: 'x' }, exit: 0 }).no);
  assert.ok(anotar({ repo: l.repo, inicio, resumen: { ...resumen, ausentes: ['x'] }, exit: 0 }).no);
  assert.ok(anotar({ repo: l.repo, inicio, resumen, exit: 1 }).no, 'rojo sin una suite con nombre');
  escribir(l.repo, 'lib/mientras.js', 'x\n');
  assert.match(anotar({ repo: l.repo, inicio, resumen, exit: 0 }).no, /cambió mientras corría/);
});

test('SuitePendienteDeRepetir_SigueElFreno — con una roja sin repetir sale 76, como hoy', (t) => {
  // 🔴 mutación: decidir antes del freno correría la selección con una roja que nadie miró.
  const l = lab(t);
  cambioDeLaHistoria(l);
  fs.writeFileSync(path.join(l.state, 'roja-d'), '');
  assert.equal(puerta(l).status, 1);
  fs.rmSync(path.join(l.state, 'roja-d'));
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  borrarCorridas(l);
  const r = puerta(l);
  assert.equal(r.status, 76, r.out);
  assert.deepEqual(corridas(l), [], r.out);
});

test('MainNoCambio_CorreLoDeSiempre — sin nada nuevo de main, no se acota por main', (t) => {
  // 🔴 mutación: sin esta condición, repetir el portón sobre lo mismo saldría verde sin correr nada.
  const l = lab(t);
  cambioDeLaHistoria(l);
  assert.equal(puerta(l).status, 0);
  borrarCorridas(l);
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /no cambió nada desde la corrida anterior/);
  assert.deepEqual(corridas(l), ['a', 'd'], r.out);
});

test('GitViejoOFallando_CorreLoDeSiempre — no poder comparar no acota', (t) => {
  // 🔴 mutación: tomar un fallo de git como «sólo cambió main» acota sin haber comparado nada.
  const l = lab(t);
  cambioDeLaHistoria(l);
  assert.equal(puerta(l).status, 0);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const anotado = JSON.parse(fs.readFileSync(medido(l), 'utf8'));
  fs.writeFileSync(medido(l), JSON.stringify({ ...anotado, tree: '0'.repeat(40) }));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /corre lo de siempre/);
});

test('Papeleo_CorreLasSuitesQueLoNombran — un cambio propio en tasks/ no apaga el acotado, pero no pasa sin correr', (t) => {
  // 🔴 mutación: descartar el papeleo sin sumarlo a lo tocado da verde sobre un archivo roto, y lo anota como medido.
  const l = lab(t, { papeleo: true });
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  escribir(l.repo, 'tasks/datos.json', '{"rota":true}\n');
  fs.writeFileSync(path.join(l.state, 'roja-e'), '');
  const r = puerta(l);
  assert.match(r.out, SOLO_MAIN);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(corridas(l), ['c', 'd', 'e'], r.out);
});

test('SuiteQueFallo_CarpetaNombradaPorOtraRuta_Corre — la ruta se anota relativa y real', (t) => {
  // 🔴 mutación: anotar la ruta absoluta la pierde al entrar por un enlace, y el portón dice que la corrió sin correrla.
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const enlace = path.join(tmp(t, 'tm-enlace-'), 'por-otra-ruta');
  fs.symlinkSync(l.repo, enlace);
  fs.writeFileSync(path.join(l.state, 'roja-d'), '');
  const r = puerta({ ...l, repo: enlace });
  assert.match(r.out, SOLO_MAIN);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(corridas(l), ['c', 'd'], r.out);
});

test('SubmoduloConCambiosAdentro_CorreLoDeSiempre — el árbol no ve lo que cambia adentro', (t) => {
  // 🔴 mutación: confiar sólo en el árbol da «sólo main» con un submódulo sucio.
  const l = lab(t);
  const sub = tmp(t, 'tm-sub-');
  git(sub, 'init', '-q');
  git(sub, 'config', 'user.email', 'prueba@ejemplo.invalid');
  git(sub, 'config', 'user.name', 'prueba');
  escribir(sub, 'dato.txt', 'uno\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'base');
  git(l.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(l.repo, 'commit', '-q', '-m', 'el submódulo');
  cambioDeLaHistoria(l);
  git(l.repo, 'commit', '-q', '-m', 'la historia');
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--no-edit', mainAvanza(l));
  escribir(l.repo, 'vendor/sub/dato.txt', 'dos\n');
  const r = puerta(l);
  assert.doesNotMatch(r.out, SOLO_MAIN);
  assert.match(r.out, /un submódulo tiene cambios adentro/);
});

test('LoMedido_HeredadasYSuitesAfuera — lo heredado del nocturno se repite, y una suite fuera del repo no se anota', (t) => {
  // 🔴 mutación: sacar lo heredado de lo que se repite la deja sin correr si main trae una foto sin ella; anotar con una
  // suite afuera da verde sobre un cambio que el árbol no ve.
  const l = lab(t);
  const { foto, medido: anotar } = require('../lib/after-main.js');
  const inicio = foto(l.repo);
  const resumen = { fallas: [], ausentes: [], unmeasured_suites: [], suites: [], deferred_suites: [] };
  const d = path.join(l.repo, 'scripts', 'tests', 'd.test.sh');
  const conHeredada = anotar({ repo: l.repo, inicio, resumen: { ...resumen, inherited: { suites: [{ ruta: d }] } }, exit: 0 });
  assert.deepEqual(conHeredada.failed, ['scripts/tests/d.test.sh']);
  const afuera = path.join(l.home, 'skills', 'x.test.sh');
  assert.match(anotar({ repo: l.repo, inicio, resumen: { ...resumen, suites: [{ ruta: afuera }] }, exit: 0 }).no, /fuera del repo/);
  assert.match(anotar({ repo: l.repo, inicio, resumen: { ...resumen, deferred_suites: [{ suite: afuera }] }, exit: 0 }).no, /fuera del repo/);
});

test('CoberturaDeLoTocado_NoSeCalculaAlElegirPorMain — la historia no corrió: su porcentaje mentiría', (t) => {
  // 🔴 mutación: calcularla igual saca el código de la historia de la cuenta, y «no cumple» pasa a «cumple».
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  const cov = artefacto(l).coverage;
  assert.equal(cov.touched_lines_pct, null, JSON.stringify(cov));
  assert.match(cov.touched_no_cross_check, /eligió sólo lo que trajo main/);
});

test('AmbienteHeredado_NoDecideQuienCorreLaCompleta — una variable de afuera no nombra una CI', (t) => {
  // 🔴 mutación: sin limpiarla al arrancar, el artefacto dice que la completa la corre una CI que nadie declaró.
  const l = lab(t);
  cambioDeLaHistoria(l);
  primeraConUnaRoja(l);
  git(l.repo, 'merge', '-q', '--ff-only', mainAvanza(l));
  const antes = process.env.TG_FULL_SUITE_BY;
  process.env.TG_FULL_SUITE_BY = 'una CI que no existe';
  t.after(() => { if (antes === undefined) delete process.env.TG_FULL_SUITE_BY; else process.env.TG_FULL_SUITE_BY = antes; });
  const r = puerta(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(artefacto(l).scoped_by_repo.full_suite_by, CI);
});
