#!/usr/bin/env node
/**
 * companion-repos.test.js — story 7.26: las stories de dos repos. Cuando una story vive en un repo y cambia otro
 * declarado en `.tycon/advisors.yaml → evidence.companion_repos` (el repo hermano), el pipeline lo sigue: al elegir
 * revisores, al armarles el contexto, al correr las pruebas, al calcular las vueltas y al anotar las pruebas del pase
 * adversarial.
 *
 * Caso disparador: la corrida de una story de un producto del equipo que vivía en el Backend y cambiaba el FrontEnd
 * (2026-10-14). Seis puntos miraban sólo el repo de la story: el revisor de React quedaba afuera, el contexto llegaba
 * con el diff vacío («is outside repository» tiraba el diff de TODOS los archivos), la suite del hermano no la corría
 * nadie, las vueltas 2 y 3 no veían los arreglos del hermano y `(<repo>) <ruta>` daba «no existe».
 *
 * Cada prueba arma un laboratorio de dos repos git efímeros (`Back` y `Front`, hermanos en la misma carpeta) y corre los
 * comandos de verdad con una HOME temporal. Las que cubren un defecto nacieron en rojo contra el código de origin/main.
 *
 * Correr: env -u NODE_TEST_CONTEXT node --test skills/tycon-pipeline/scripts/tests/companion-repos.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
// Story 8.41: los revisores de React y de cableado viven en el paquete del stack, que viaja con el perfil del equipo. En
// la copia pública (sin él) los casos que los esperan en el set no se pueden medir, y se dice.
const { SKIP_PUBLIC } = require('./lib/public-copy.js');
const CON_PAQUETE = SKIP_PUBLIC ? { skip: `${SKIP_PUBLIC}: este caso espera un revisor del paquete del stack — NO MEDIDO acá` } : {};
const MARKER = path.join(SCRIPTS, 'marker.js');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');

// Variables del entorno de quien corre la suite que cambian un veredicto o el lugar del estado: fuera, siempre.
const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS',
  'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY',
  'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE', 'STOP_AUTONOMY', 'TYCON_SNAPSHOT_GUARD', 'TYCON_PACKS_DIR'];

function entorno(home, sid, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  // Story 8.7 (AC 8): sin perfil, `packs.default` no activa paquetes; esta suite cuenta con los instalados.
  return { ...env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_PACKS_DEFAULT: 'all', ...(extra || {}) };
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function escribir(raiz, rel, texto) {
  const abs = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, texto);
  return abs;
}
function repoGit(dir, archivos) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, texto] of Object.entries(archivos)) escribir(dir, rel, texto);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '-m', 'base');
  return dir;
}
function casa() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-home-'))); }

const STORY = (archivos = {}) => {
  const lista = (clave, xs) => (xs && xs.length ? [`${clave}:`, ...xs.map((x) => `  - ${x}`)] : [`${clave}: []`]);
  return ['---', 'epic: 9', 'story: "9.26"', 'title: "laboratorio de dos repos"', 'status: in-progress',
    ...lista('files_to_create', archivos.crear), ...lista('files_to_modify', archivos.modificar), '---', '',
    '# Story 9.26', '', '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `prueba` | 1 | unit | x | y |', ''].join('\n');
};

/**
 * El laboratorio de §Medición previa de la story: `Back` (un .cs) y `Front` (React en `app/`), los dos con cambios sin
 * commitear. `declarar`: Back declara a Front como hermano (commiteado, como en un repo real).
 */
function laboratorio({ declarar = true, frontBase = 'export const X = () => null;\n', story, frontPaquete } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-lab-')));
  const back = repoGit(path.join(raiz, 'Back'), {
    'src/A.cs': 'class A {}\n',
    'specs/s.md': story || STORY({ modificar: ['src/A.cs', 'app/src/X.tsx'] }),
    ...(declarar ? { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n' } : {}),
  });
  const front = repoGit(path.join(raiz, 'Front'), {
    'app/package.json': JSON.stringify(frontPaquete || { name: 'app', version: '1.0.0', dependencies: { react: '18.3.1' } }, null, 2) + '\n',
    'app/src/X.tsx': frontBase,
  });
  fs.writeFileSync(path.join(back, 'src', 'A.cs'), 'class A { void M() {} }\n');
  fs.appendFileSync(path.join(front, 'app', 'src', 'X.tsx'), 'export const Y = () => 1;\n');
  return { raiz, back, front, story: path.join(back, 'specs', 's.md') };
}

function advisors(lab, home, sid, files, extra = []) {
  const r = spawnSync(process.execPath, [PIPELINE, 'advisors', '--repo', lab.back, '--story', lab.story, '--files', ...files, ...extra],
    { encoding: 'utf8', env: entorno(home, sid), cwd: lab.back });
  assert.equal(r.status, 0, `advisors salió ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
function expectedPersistido(home, sid) {
  const p = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs', `${sid}.jsonl`);
  const lineas = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lineas.filter((l) => l.event === 'step5-start').pop().expected;
}

// ── Qué es un repo hermano (AC 1) ─────────────────────────────────────────────────────────────────────────────

test('companionRoots: une los hermanos del repo y del repo de la story, sin el propio repo', () => {
  const { companionRoots } = require(path.join(SCRIPTS, 'lib', 'companion-repos.js'));
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-raices-')));
  const a = repoGit(path.join(raiz, 'A'), { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - B\n    - NoExiste\n' });
  const b = repoGit(path.join(raiz, 'B'), { 'x.txt': 'b\n' });
  const c = repoGit(path.join(raiz, 'C'), { 'x.txt': 'c\n' });
  const s = repoGit(path.join(raiz, 'S'), {
    '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - C\n    - A\n',
    'specs/s.md': STORY(),
  });
  assert.deepEqual(companionRoots(a, path.join(s, 'specs', 's.md')), [b, c]);
  assert.deepEqual(companionRoots(a, null), [b], 'sin story, sólo los del repo');
  assert.deepEqual(companionRoots(b, null), [], 'sin bloque evidence, ninguno');
});

// ── Revisores (AC 2, 3, 4) ────────────────────────────────────────────────────────────────────────────────────

test('advisors: el package.json del hermano detecta React y no avisa detección ciega', CON_PAQUETE, () => {
  const lab = laboratorio();
  for (const [i, xtsx] of [['rel', '../Front/app/src/X.tsx'], ['abs', path.join(lab.front, 'app', 'src', 'X.tsx')]]) {
    const home = casa();
    const out = advisors(lab, home, `t2-${i}`, ['src/A.cs', xtsx]);
    assert.equal(out.detection.hasReact, true, `${i}: ${JSON.stringify(out.detection)}`);
    assert.equal(out.detection.warning, undefined, `${i}: no avisa detección ciega`);
    assert.ok(out.all.includes('tycon-feature-wiring-checker'), `${i}: ${out.all}`);
  }
});

// El caso real del 2026-10-15: la story vive en el backend y el formulario en el repo hermano declara React SÓLO en
// peerDependencies (lo provee el host de Bizuit). El package.json se encontraba bien; lo que no se leía era esa sección.
test('advisors: un formulario hermano con React sólo en peerDependencies trae al revisor de React', CON_PAQUETE, () => {
  const lab = laboratorio({ frontPaquete: { name: 'app', version: '1.0.0', peerDependencies: { react: '^18.3.1' }, dependencies: { dayjs: '1.11.0' } } });
  const out = advisors(lab, casa(), 't2-peer', ['src/A.cs', path.join(lab.front, 'app', 'src', 'X.tsx')]);
  assert.equal(out.detection.hasReact, true, JSON.stringify(out.detection));
  assert.equal(out.detection.warning, undefined, 'no avisa detección ciega');
  assert.ok(out.all.includes('tycon-plugin-react-conventions'), `${out.all}`);
});

test('advisors: un .tsx sin React detectable trae al revisor de cableado; con Next no', CON_PAQUETE, () => {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-wiring-')));
  const sinPkg = repoGit(path.join(raiz, 'SinPkg'), { 'src/P.tsx': 'export const P = () => null;\n', 'specs/s.md': STORY() });
  fs.appendFileSync(path.join(sinPkg, 'src', 'P.tsx'), 'export const Q = () => 2;\n');
  const home = casa();
  const out = advisors({ back: sinPkg, story: path.join(sinPkg, 'specs', 's.md') }, home, 't3-a', ['src/P.tsx']);
  assert.ok(out.all.includes('tycon-feature-wiring-checker'), JSON.stringify(out.all));
  assert.ok(expectedPersistido(home, 't3-a').includes('tycon-feature-wiring-checker'), 'y entra al expected[] que mira check-count');

  const conNext = repoGit(path.join(raiz, 'ConNext'), {
    'package.json': JSON.stringify({ name: 'n', version: '1.0.0', dependencies: { next: '14.2.0', react: '18.3.1' } }) + '\n',
    'src/app/page.tsx': 'export default function P() { return null; }\n', 'specs/s.md': STORY(),
  });
  fs.appendFileSync(path.join(conNext, 'src', 'app', 'page.tsx'), 'export const Z = 1;\n');
  const out2 = advisors({ back: conNext, story: path.join(conNext, 'specs', 's.md') }, casa(), 't3-b', ['src/app/page.tsx']);
  assert.ok(!out2.all.includes('tycon-feature-wiring-checker'), JSON.stringify(out2.all));
});

test('advisors: las líneas agregadas del hermano salen de su git diff', () => {
  const lab = laboratorio({ frontBase: 'export function f() { try { return 1; } catch (e) { return 0; } }\n' });
  const out = advisors(lab, casa(), 't4', ['src/A.cs', '../Front/app/src/X.tsx']);
  assert.ok(!out.all.includes('tycon-silent-failure-hunter'),
    `el try viejo del hermano no es línea agregada: ${JSON.stringify(out.all)}`);
  // El gemelo: una línea AGREGADA del hermano con un catch sí lo trae (el disparador mira las líneas del hermano).
  fs.appendFileSync(path.join(lab.front, 'app', 'src', 'X.tsx'), 'export function g() { try { return 1; } catch (e) { return 0; } }\n');
  const out2 = advisors(lab, casa(), 't4b', ['src/A.cs', '../Front/app/src/X.tsx']);
  assert.ok(out2.all.includes('tycon-silent-failure-hunter'), JSON.stringify(out2.all));
});

// ── Contexto de los revisores (AC 5, 6) ───────────────────────────────────────────────────────────────────────

test('contexto: el diff de cada repo llega, el del hermano en su sección y con (<nombre>)', () => {
  const lab = laboratorio();
  const out = advisors(lab, casa(), 't5', ['src/A.cs', '../Front/app/src/X.tsx']);
  const ctx = fs.readFileSync(out.context_file, 'utf8');
  assert.match(ctx, /\+class A \{ void M\(\) \{\} \}/, 'el hunk del repo');
  assert.match(ctx, /Diff del repo hermano `Front`/, 'la sección del hermano');
  assert.match(ctx, /\+export const Y = \(\) => 1;/, 'el hunk del hermano');
  assert.match(ctx, /- \(Front\) app\/src\/X\.tsx/, 'el archivo del hermano listado con (<nombre>)');
  assert.doesNotMatch(ctx, /git diff no disponible/);
});

test('contexto: un archivo nuevo del hermano entra con su contenido', () => {
  const lab = laboratorio();
  escribir(lab.front, 'app/src/Nuevo.tsx', 'export const NUEVO_MARCA = 42;\n');
  const out = advisors(lab, casa(), 't6', ['src/A.cs', '../Front/app/src/X.tsx', '../Front/app/src/Nuevo.tsx']);
  const ctx = fs.readFileSync(out.context_file, 'utf8');
  assert.match(ctx, /NUEVO_MARCA = 42/);
  assert.match(ctx, /\(Front\) app\/src\/Nuevo\.tsx \(archivo NUEVO/);
});

test('contexto: si git falla en un repo, el texto dice cuál y por qué, y el otro repo conserva su diff', () => {
  const lab = laboratorio();
  fs.writeFileSync(path.join(lab.front, '.git', 'HEAD'), 'esto no es una referencia\n');
  const out = advisors(lab, casa(), 't7', ['src/A.cs', '../Front/app/src/X.tsx']);
  const ctx = fs.readFileSync(out.context_file, 'utf8');
  assert.match(ctx, /\+class A \{ void M\(\) \{\} \}/, 'el repo conserva su diff');
  assert.match(ctx, /`Front`[^\n]*git falló — (fatal|error): \S/, 'nombra al hermano y trae la primera línea del error de git');
  assert.match(ctx, /repo hermano `Front`: git no pudo listar sus archivos nuevos/, 'y dice que no pudo listar sus nuevos (AC 17)');
  assert.doesNotMatch(ctx, /repo sin git/);
});

// ── Pruebas (AC 7-10, 15) ─────────────────────────────────────────────────────────────────────────────────────

const PKG_NODE_TEST = JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }) + '\n';
const PRUEBA_VERDE = "const {test}=require('node:test');test('ok',()=>{});\n";
const PRUEBA_ROJA = "const {test}=require('node:test');const assert=require('node:assert');test('rojo',()=>{assert.equal(1,2);});\n";

/** Laboratorio de pruebas: Back (con o sin suite `node --test`) y Front con `app/` de `node --test`. */
function laboratorioDePruebas({ backConSuite = false, frontRoja = false, frontDeclaraBack = false, story, backExtra = {}, xCommiteado = false } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-gate-')));
  const historia = story || STORY({ crear: ['app/src/x.js'], modificar: ['Front/app/tests/x.test.js', 'src/A.cs'] });
  const back = repoGit(path.join(raiz, 'Back'), {
    'src/A.cs': 'class A {}\n', 'specs/s.md': historia,
    '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n',
    ...(backConSuite ? { 'package.json': PKG_NODE_TEST, 'test/b.test.js': PRUEBA_VERDE } : {}),
    ...backExtra,
  });
  const front = repoGit(path.join(raiz, 'Front'), {
    'app/package.json': PKG_NODE_TEST,
    'app/tests/x.test.js': frontRoja ? PRUEBA_ROJA : PRUEBA_VERDE,
    ...(frontDeclaraBack ? { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Back\n' } : {}),
    // Commiteado, git no lo reporta como nuevo y el cruce de cobertura cae a lo que la story declara crear.
    ...(xCommiteado ? { 'app/src/x.js': 'module.exports = 1;\n' } : {}),
  });
  if (!xCommiteado) escribir(front, 'app/src/x.js', 'module.exports = 1;\n');
  return { raiz, back, front, story: path.join(back, 'specs', 's.md') };
}
function testGate(lab, home, sid) {
  return spawnSync('bash', [TEST_GATE, lab.back, lab.story], { encoding: 'utf8', env: entorno(home, sid), cwd: lab.back });
}
function artefacto(repo) { return JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8')); }
function markerFalso(home, sid, repo, story) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    storyId: '9.26', storyPath: story, repoPath: repo, sessionId: sid, startedAt: new Date().toISOString(),
    lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
    filesTouched: [], iterations: {}, fileEvents: [], checks: {},
  }));
  return path.join(dir, `${sid}.json`);
}

test('test-gate: corre la suite del hermano que la story toca y la anota en companions', () => {
  const lab = laboratorioDePruebas();
  const r = testGate(lab, casa(), 't8');
  assert.equal(r.status, 0, `esperaba 0 (el repo no tiene suite, el hermano sí y en verde)\n${r.stdout}\n${r.stderr}`);
  const art = artefacto(lab.back);
  assert.ok(Array.isArray(art.companions) && art.companions.length === 1, JSON.stringify(art.companions));
  const h = art.companions[0];
  assert.equal(h.root, lab.front);
  assert.equal(h.exit, 0);
  assert.equal(h.green, true);
  assert.deepEqual(h.files.sort(), ['app/src/x.js', 'app/tests/x.test.js']);
  assert.equal(art.all_green, true);
  const delHermano = artefacto(lab.front);
  assert.equal(delHermano.runner, 'node-test');
  assert.ok(!(delHermano.coverage.declared_not_found || []).includes('app/src/x.js'),
    'el cruce del hermano encuentra lo que la story declara crear ahí');
});

test('test-gate: hermano rojo con el repo verde → sale con el código del hermano y el check tests en rojo', () => {
  const lab = laboratorioDePruebas({ backConSuite: true, frontRoja: true });
  const home = casa();
  const archivoMarker = markerFalso(home, 't9', lab.back, lab.story);
  const r = testGate(lab, home, 't9');
  assert.notEqual(r.status, 0, `el hermano está en rojo\n${r.stdout}\n${r.stderr}`);
  const m = JSON.parse(fs.readFileSync(archivoMarker, 'utf8'));
  assert.match(String(m.checks.tests), /^red/, `checks.tests=${m.checks.tests}`);
  assert.equal(m.checksProvenance.tests, 'test-gate');
  const art = artefacto(lab.back);
  assert.equal(art.suite_green, true, 'la suite del repo sí está verde');
  assert.equal(art.all_green, false);
  assert.equal(art.companions[0].green, false);
  assert.ok(!(art.coverage.declared_not_found || []).includes('app/src/x.js'),
    'lo declarado en el hermano no es «declarado que no existe» en el repo');
});

test('test-gate: la corrida del hermano no sigue a los hermanos del hermano ni escribe la copia sellada', () => {
  const lab = laboratorioDePruebas({ backConSuite: true, frontDeclaraBack: true });
  const r = testGate(lab, casa(), 't10');
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const corridas = (r.stdout.match(/\[test-gate\] node --test \(1 sola corrida/g) || []).length;
  assert.equal(corridas, 2, `una corrida por repo, sin ciclo:\n${r.stdout}`);
  const evidencia = path.join(lab.front, '.advisors', 'dod-runtime');
  const sellada = fs.existsSync(evidencia) ? fs.readdirSync(evidencia).filter((f) => /tests-result\.json$/.test(f)) : [];
  assert.deepEqual(sellada, [], 'la copia sellada es la de la story, en su repo');
});

test('test-gate: sin archivos en hermanos el artefacto queda como hoy', () => {
  const lab = laboratorioDePruebas({ backConSuite: true, story: STORY({ modificar: ['src/A.cs'] }) });
  const r = testGate(lab, casa(), 't11');
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const art = artefacto(lab.back);
  assert.equal('companions' in art, false);
  assert.equal('all_green' in art, false);
  assert.ok(!fs.existsSync(path.join(lab.front, '.advisors', 'tests-result.json')), 'el hermano no se corrió');
});

// ── Vueltas de revisores (AC 11) ──────────────────────────────────────────────────────────────────────────────

test('smart-reloop: un arreglo en el hermano después de la foto entra al delta', CON_PAQUETE, () => {
  const lab = laboratorio();
  const home = casa(); const sid = 't12';
  const xtsx = path.join(lab.front, 'app', 'src', 'X.tsx');
  const acs = path.join(lab.back, 'src', 'A.cs');
  const foto = new Date(Date.now() - 60000).toISOString();
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    storyId: '9.26', storyPath: lab.story, repoPath: lab.back, sessionId: sid,
    filesTouched: [acs, xtsx],
    fileEvents: [{ path: acs, ts: new Date(Date.now() - 120000).toISOString() }, { path: xtsx, ts: new Date().toISOString() }],
    iterations: { 1: { ts: foto, filesSnapshot: [acs, xtsx] } },
  }));
  const t = (Date.now() - 120000) / 1000;
  fs.utimesSync(acs, t, t);   // el .cs es de antes de la foto: lo único nuevo es el arreglo del hermano
  const r = spawnSync(process.execPath, [PIPELINE, 'smart-reloop', '--iter', '2', '--repo', lab.back, '--story', lab.story,
    '--files', 'src/A.cs', '../Front/app/src/X.tsx'], { encoding: 'utf8', env: entorno(home, sid), cwd: lab.back });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.delta_files.some((f) => fs.realpathSync(f) === xtsx), `delta: ${JSON.stringify(out.delta_files)}`);
  const cableado = out.rerun_reasons.find((x) => x.name === 'tycon-feature-wiring-checker');
  assert.ok(cableado && /X\.tsx/.test(cableado.reason), JSON.stringify(out.rerun_reasons));
});

// ── Pase adversarial (AC 12, 13, 16) ──────────────────────────────────────────────────────────────────────────

const LANZADO = '2026-09-18T01:00:00.000Z';
const DESPUES = '2026-09-18T02:00:00.000Z';

function corridaConPase(home, sid, lab) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const prueba = path.join(lab.front, 'app', 'tests', 'x.test.js');
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    storyId: '9.26', storyPath: lab.story, repoPath: lab.back, sessionId: sid,
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5], filesTouched: [prueba], iterations: {},
    adversarial: { launchedAtStep: 4, runId: 'wf_T', sessionId: 'otra', launchedAt: LANZADO },
    fileEvents: [{ path: prueba, ts: DESPUES }],
  }));
}
function propia(home, sid, ruta, cwd) {
  return spawnSync(process.execPath, [MARKER, 'mark-adversarial-result', '1', '--type', '5b', '--tests', '0', '--own', '1', '--in', ruta],
    { encoding: 'utf8', env: entorno(home, sid), cwd });
}
function pasesAnotados(home) {
  const p = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.name === 'adversarial-pass');
}

test('mark-adversarial-result: (<repo>) <ruta> con el nombre, ../<repo> y la carpeta vecina', () => {
  const casos = [
    ['nombre de un hermano declarado', true, '(Front) app/tests/x.test.js'],
    ['ruta relativa al repo', false, '(../Front) app/tests/x.test.js'],
    ['carpeta vecina sin declarar', false, '(Front) app/tests/x.test.js'],
    ['ruta absoluta, como antes', false, null],
  ];
  for (const [i, [nombre, declarar, ruta]] of casos.entries()) {
    const lab = laboratorio({ declarar });
    escribir(lab.front, 'app/tests/x.test.js', PRUEBA_VERDE);
    const home = casa(); const sid = `t13-${i}`;
    corridaConPase(home, sid, lab);
    const r = propia(home, sid, ruta || path.join(lab.front, 'app', 'tests', 'x.test.js'), lab.back);
    assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    assert.deepEqual(pasesAnotados(home)[0].en, ['(Front) app/tests/x.test.js'], nombre);
  }
});

test('mark-adversarial-result: (<repo>) que no es un repo git sale 2 y no anota', () => {
  const lab = laboratorio();
  const home = casa(); const sid = 't14';
  corridaConPase(home, sid, lab);
  const r = propia(home, sid, '(NoExiste) a.test.js', lab.back);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /NoExiste/);
  assert.match(r.stderr, /no (es|encontré) un repo/);
  assert.deepEqual(pasesAnotados(home), []);
});

// ── No-regresión (AC 14) ──────────────────────────────────────────────────────────────────────────────────────

test('una story de un solo repo da el mismo set, contexto y delta que antes', () => {
  const lab = laboratorio({ declarar: false });
  const out = advisors(lab, casa(), 't15', ['src/A.cs']);
  const ctx = fs.readFileSync(out.context_file, 'utf8');
  assert.match(ctx, /## Diff unificado \(git diff HEAD\)\n\n```diff\ndiff --git a\/src\/A\.cs b\/src\/A\.cs/);
  assert.doesNotMatch(ctx, /repo hermano/);
  assert.match(ctx, /## Archivos del diff \(1\)\n\n- src\/A\.cs\n/);
  assert.deepEqual(out.all.filter((a) => /feature-wiring|react/.test(a)), [], 'un diff sólo .cs sin endpoints no trae ni cableado ni React');
});

// ── No poder mirar no es «no hay hermano» (AC 17, revisor de fallas silenciosas de la vuelta 1) ────────────────

const COMPANION_LIB = path.join(SCRIPTS, 'lib', 'companion-repos.js');

test('companionRoots y la consulta de hermanos: una story ilegible falla y un hermano declarado que no existe se avisa', () => {
  const { companionTargets, declaredHere } = require(COMPANION_LIB);
  const lab = laboratorio();
  const fantasma = path.join(lab.raiz, 'no-existe.md');
  assert.throws(() => companionTargets(lab.back, fantasma), /no-existe\.md/);
  assert.throws(() => declaredHere(lab.back, fantasma), /no-existe\.md/);
  const cli = (args) => spawnSync(process.execPath, [COMPANION_LIB, ...args], { encoding: 'utf8', env: entorno(casa(), 't16') });
  const r = cli(['targets', lab.back, fantasma]);
  assert.notEqual(r.status, 0, 'una story ilegible no es «ningún hermano»');
  fs.writeFileSync(path.join(lab.back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n    - Fantasma\n');
  const r2 = cli(['targets', lab.back, lab.story]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stderr, /Fantasma/, 'el hermano declarado que no está en disco se avisa con su nombre');
});

test('test-gate: si no se pudo averiguar qué hermanos toca la story, no sale verde', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('como root la story sin permiso igual se lee'); return; }
  const lab = laboratorioDePruebas({ backConSuite: true });
  const home = casa();
  const archivoMarker = markerFalso(home, 't17', lab.back, lab.story);
  fs.chmodSync(lab.story, 0o000);
  let r;
  try { r = testGate(lab, home, 't17'); } finally { fs.chmodSync(lab.story, 0o644); }
  assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /no pude averiguar los repos hermanos/);
  const m = JSON.parse(fs.readFileSync(archivoMarker, 'utf8'));
  assert.match(String(m.checks.tests), /^red/, `checks.tests=${m.checks.tests}`);
});

// ── Lo que encontró el pase adversarial de esta corrida (causas A, B y C) ────────────────────────────────────

test('ownerOf: un archivo borrado del repo es del repo aunque el repo cuelgue de un enlace', () => {
  const { groupByRepo } = require(COMPANION_LIB);
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-real-')));
  const back = repoGit(path.join(real, 'Back'), { 'src/A.cs': 'class A {}\n', 'src/Gone.cs': 'class G {}\n', 'specs/s.md': STORY() });
  fs.writeFileSync(path.join(back, 'src', 'A.cs'), 'class A { void M() {} }\n');
  fs.unlinkSync(path.join(back, 'src', 'Gone.cs'));
  const enlace = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-enlace-'))), 'por-enlace');
  fs.symlinkSync(real, enlace);
  const backPorEnlace = path.join(enlace, 'Back');
  const grupos = groupByRepo(['src/Gone.cs', 'src/A.cs'], backPorEnlace);
  assert.equal(grupos.length, 1, JSON.stringify(grupos));
  assert.equal(grupos[0].propio, true);
  assert.deepEqual(grupos[0].files.map((x) => x.rel), ['src/Gone.cs', 'src/A.cs']);
  const out = advisors({ back: backPorEnlace, story: path.join(backPorEnlace, 'specs', 's.md') }, casa(), 't18',
    ['src/Gone.cs', 'src/A.cs'], ['--allow-missing-files']);   // un borrado legítimo, como lo pide el propio comando
  const ctx = fs.readFileSync(out.context_file, 'utf8');
  assert.match(ctx, /diff --git a\/src\/A\.cs b\/src\/A\.cs/, 'el diff del repo se conserva');
  assert.doesNotMatch(ctx, /\.\.\/\.\.\//, 'sin rutas basura');
});

test('la story declara ../<hermano>/ruta: el gate corre el hermano y el repo no la cuenta como suya', () => {
  const lab = laboratorioDePruebas({ story: STORY({ crear: ['../Front/app/src/x.js'], modificar: ['src/A.cs'] }) });
  const cli = (args) => spawnSync(process.execPath, [COMPANION_LIB, ...args], { encoding: 'utf8', env: entorno(casa(), 't19') });
  const t = cli(['targets', lab.back, lab.story]);
  assert.equal(t.status, 0, t.stderr);
  const [root, , archivos] = t.stdout.trim().split('\x1f');
  assert.equal(root, lab.front);
  assert.equal(archivos, 'app/src/x.js');
  const d = cli(['declared-here', lab.back, lab.story]);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stdout.trim(), '', 'el repo no la cuenta como declarada propia');
});

test('test-gate: el artefacto del hermano no lista los archivos que la story crea en el repo de la story', () => {
  const lab = laboratorioDePruebas({
    backExtra: { 'src/B.cs': 'class B {}\n' }, xCommiteado: true,
    story: STORY({ crear: ['src/B.cs', 'app/src/x.js'], modificar: ['Front/app/tests/x.test.js'] }),
  });
  const r = testGate(lab, casa(), 't20');
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const delHermano = artefacto(lab.front);
  assert.ok(!(delHermano.coverage.declared_not_found || []).includes('src/B.cs'),
    `el hermano no lista lo que la story crea en el repo de la story: ${JSON.stringify(delHermano.coverage)}`);
  assert.equal(delHermano.coverage.new_files_source, 'story:files_to_create', 'el cruce sí usó lo que la story crea en el hermano');
});

test('advisors: un archivo JS/TS fuera de todo repo git se dice en el aviso de detección', () => {
  const lab = laboratorio();
  const suelta = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermano-sin-git-')));
  const ts = escribir(suelta, 'util.ts', 'export const u = 1;\n');
  const out = advisors(lab, casa(), 't21', ['src/A.cs', ts]);
  assert.match(String(out.detection.warning), /fuera de --repo y de todo repo git[^\n]*util\.ts[^\n]*package\.json no se buscó/,
    JSON.stringify(out.detection));
});

test('test-gate: con dos hermanos corren los dos aunque la suite del primero lea la entrada estándar', () => {
  const lab = laboratorioDePruebas({
    story: STORY({ crear: ['Front/app/src/x.js', 'Front2/app/src/y.js'], modificar: ['src/A.cs'] }),
  });
  // La suite de Front lee la entrada estándar antes de correr: con la lista de hermanos en esa entrada, se la tragaba.
  fs.writeFileSync(path.join(lab.front, 'app', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'cat > /dev/null; node --test' } }) + '\n');
  const front2 = repoGit(path.join(lab.raiz, 'Front2'), { 'app/package.json': PKG_NODE_TEST, 'app/tests/y.test.js': PRUEBA_VERDE });
  escribir(front2, 'app/src/y.js', 'module.exports = 2;\n');
  fs.writeFileSync(path.join(lab.back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n    - Front2\n');
  const r = testGate(lab, casa(), 't22');
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const art = artefacto(lab.back);
  assert.deepEqual(art.companions.map((c) => path.basename(c.root)).sort(), ['Front', 'Front2'], JSON.stringify(art.companions));
});
