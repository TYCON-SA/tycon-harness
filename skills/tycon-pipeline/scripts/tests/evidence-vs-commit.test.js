#!/usr/bin/env node
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. Las fechas de commit que se comparan las fija cada laboratorio.
/**
 * evidence-vs-commit.test.js — una evidencia sigue valiendo si el archivo que probó no cambió, aunque git le haya
 * reescrito la fecha en un cambio de rama; y lo que cambió de verdad después de probarse sigue sin contar.
 *
 * Los laboratorios son repos de git de verdad, en una carpeta temporal. Se prueba el módulo (lib/evidence-vs-commit.js)
 * y la matriz (runtime-matrix.js) con un cambio de rama real: la otra rama modifica el archivo, y por eso git lo reescribe.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/evidence-vs-commit.test.js
 * Con T18_BASE=<commit> en el entorno, T18 mira además que la suite vieja no cambió desde ese commit.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
const ledgerLine = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const evidencia = () => require(path.join(SCRIPTS, 'lib', 'evidence-vs-commit.js'));

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const HACE_UNA_HORA = Date.now() - 60 * 60 * 1000;
const HACE_DIEZ_MIN = Date.now() - 10 * 60 * 1000;

// El entorno de un git de laboratorio: sin nada que lo ate al repo desde el que se corre la prueba.
function entornoGit(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) if (!(k in extra)) delete env[k];
  return env;
}

function git(repo, args, extra) {
  return execFileSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: entornoGit(extra) }).trim();
}

function carpeta() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evc-')));
  temporales.push(d);
  return d;
}

function repoNuevo(dentro, nombre = 'Proj') {
  const repo = path.join(dentro, nombre);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  return repo;
}

function escribir(repo, rel, texto) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, texto);
  return abs;
}

// `fecha` en segundos: la hora del commit, para los casos que comparan horas.
function commit(repo, mensaje, fecha) {
  git(repo, ['add', '-A']);
  const extra = fecha ? { GIT_COMMITTER_DATE: `${fecha} +0000`, GIT_AUTHOR_DATE: `${fecha} +0000` } : undefined;
  git(repo, ['commit', '-q', '-m', mensaje], extra);
  return git(repo, ['rev-parse', '--short', 'HEAD']);
}

function fechaDe(abs, ms) { fs.utimesSync(abs, new Date(ms), new Date(ms)); }

// Un cambio de rama de verdad: la otra rama modifica el archivo, así git lo reescribe al ir y al volver. Sólo ese archivo
// entra a su commit: una evidencia sin commitear sobrevive al cambio de rama, y ése es uno de los casos.
function irYVolverDeRama(repo, rel) {
  git(repo, ['switch', '-q', '-c', 'otra']);
  fs.appendFileSync(path.join(repo, rel), '// otra rama\n');
  git(repo, ['add', '--', rel]);
  git(repo, ['commit', '-q', '-m', 'otra rama']);
  git(repo, ['switch', '-q', 'main']);
}

/** Código y evidencia en un repo, con la evidencia en un commit posterior al del código y la fecha nueva del archivo. */
function labBasico() {
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  commit(repo, 'codigo');
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(repo, 'evidencia');
  return { repo, archivo, ev };
}

const consulta = (archivo, ev, mtimeMs = Date.now(), tsMs = HACE_UNA_HORA, linea) =>
  ({ archivo, mtimeMs, evidencia: { ruta: ev, tsMs, linea } });

// ---------------------------------------------------------------- la matriz, en un repo de verdad

const HISTORIA_NUEVE = (declarado = 'src/Feature.cs') => [
  '---', 'story: 9.9', 'status: in-progress', 'files_to_modify:', `  - ${declarado}`, '---', '',
  '## Acceptance Criteria', '',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${n}. **Given** algo ${n}, **When** pasa, **Then** resultado ${n}.`), '',
  '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
  '| T1 | `FeatureTests.Caso1` | 1,2,3,4,5,6,7,8,9 | integration | x | y |', '',
].join('\n');

const HISTORIA_DOS = [
  '---', 'story: 9.9', 'status: in-progress', 'files_to_modify:', '  - src/Feature.cs', '---', '',
  '## Acceptance Criteria', '',
  '1. **Given** algo, **When** pasa, **Then** resultado.',
  '2. **Given** otra cosa, **When** pasa, **Then** otro resultado.', '',
  '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
  '| E1 | `story-9-9.spec.ts::flujo` | 1 | e2e | x | y |',
  '| T2 | `FeatureTests.Caso2` | 2 | integration | x | y |', '',
].join('\n');

function compacto(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

function gate(dod, gatesLog, ms, espejo = true) {
  fs.writeFileSync(path.join(dod, `9.9-e2e-gate-${compacto(ms)}.md`),
    ['# Gate', '**Spec filter**: story-9-9.spec.ts', '```', 'verdict=PASS', '```', '- skipped: 0', ''].join('\n'));
  if (espejo) {
    fs.appendFileSync(gatesLog, `${JSON.stringify({ ts: new Date(ms).toISOString(), check: 'dod', status: 'green', provenance: 'run-check',
      cmd: 'bash e2e-gate.sh /fe 9.9 /dir story-9-9.spec.ts', exit: 0 })}\n`);
  }
}

/** Repo con la historia, el código y su evidencia commiteados; el código con fecha vieja, como antes de cambiar de rama. */
function labMatriz({ historia = HISTORIA_DOS, armarEvidencia, enOtroCommit = false } = {}) {
  const ws = carpeta();
  const repo = repoNuevo(ws);
  const dod = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const gatesLog = path.join(ws, 'gates.log');
  const archivo = escribir(repo, 'src/Feature.cs', '// v1\n');
  const storyPath = escribir(repo, 'specs/stories/9-9-lab.md', historia);
  if (enOtroCommit) commit(repo, 'codigo');
  armarEvidencia({ dod, gatesLog });
  commit(repo, 'evidencia');
  fechaDe(archivo, HACE_UNA_HORA);
  return { ws, repo, dod, gatesLog, archivo, storyPath };
}

const calcular = (f, extra = {}) => rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog, testsResults: [], ...extra });
const veredictos = (r) => Object.fromEntries(r.acs.map((n) => [n, r.perAc[n].verdict]));

function humo(dod, gatesLog, acs, ts = new Date(HACE_DIEZ_MIN).toISOString().replace(/\.\d+Z$/, 'Z'), cmd, mirror = true) {
  return ledgerLine.append({ dodDir: dod, gatesLog, story: '9.9', acs, ts, cmd, mirror });
}

// ---------------------------------------------------------------- la evidencia sigue valiendo

test('T1 Vigente_EvidenciaCommiteada_FechaNueva_Cuenta @story-8.186 @ac-1', () => {
  const { archivo, ev, repo } = labBasico();
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, true, JSON.stringify(r));
  // un nombre con corchetes es un nombre, no un patrón: el cambio de su vecino no es un cambio suyo
  const corchetes = escribir(repo, 'pages/[id].tsx', 'a\n');
  const vecino = escribir(repo, 'pages/i.tsx', 'b\n');
  commit(repo, 'paginas');
  const ev2 = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000001Z.md', 'verdict=PASS\n');
  commit(repo, 'evidencia 2');
  fs.appendFileSync(vecino, 'c\n');
  commit(repo, 'vecino');
  const r2 = evidencia().crearJuez().vigencia(consulta(corchetes, ev2));
  assert.equal(r2.cuenta, true, JSON.stringify(r2));
});

test('T2 Matriz_GateYHumo_TrasCambioDeRama_Runtime @story-8.186 @ac-1', () => {
  const f = labMatriz({ enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => {
    gate(dod, gatesLog, HACE_DIEZ_MIN);
    humo(dod, gatesLog, [2]);
  } });
  irYVolverDeRama(f.repo, 'src/Feature.cs');
  assert.ok(fs.statSync(f.archivo).mtimeMs > HACE_DIEZ_MIN, 'el cambio de rama tenía que reescribir el archivo');
  const r = calcular(f);
  assert.deepEqual(veredictos(r), { 1: 'RUNTIME', 2: 'RUNTIME' }, r.warnings.join('\n'));
});

test('T3 Vigente_EvidenciaAntesDelCommit_MismoCommit_Cuenta @story-8.186 @ac-2', () => {
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(repo, 'codigo y evidencia juntos');
  irYVolverDeRama(repo, 'src/feature.js');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev, fs.statSync(archivo).mtimeMs));
  assert.equal(r.cuenta, true, JSON.stringify(r));
});

test('T4 Matriz_NueveDeNueve_TrasCambioDeRama_MismoResultado @story-8.186 @ac-3', () => {
  const f = labMatriz({ historia: HISTORIA_NUEVE(), armarEvidencia: ({ dod, gatesLog }) => humo(dod, gatesLog, [1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  const antes = calcular(f);
  assert.equal(antes.stats.runtime, 9, antes.warnings.join('\n'));
  irYVolverDeRama(f.repo, 'src/Feature.cs');
  const despues = calcular(f);
  assert.deepEqual(veredictos(despues), veredictos(antes), despues.warnings.join('\n'));
  assert.equal(despues.hash, antes.hash);
});

test('T5 Vigente_RepoHermano_CommitAnterior_Cuenta @story-8.186 @ac-4', () => {
  const ws = carpeta();
  const codigo = repoNuevo(ws, 'Back');
  const archivo = escribir(codigo, 'src/feature.js', '// v1\n');
  commit(codigo, 'codigo', 1700000000);
  const espec = repoNuevo(ws, 'Specs');
  const ev = escribir(espec, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(espec, 'evidencia', 1700000100);
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, true, JSON.stringify(r));
});

test('T6 Vigente_HumoConDosCorridas_CadaUnaConSuCommit @story-8.186 @ac-5', () => {
  const repo = repoNuevo(carpeta());
  const dod = path.join(repo, '.advisors', 'dod-runtime');
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  const ts = new Date(HACE_DIEZ_MIN).toISOString().replace(/\.\d+Z$/, 'Z');
  const primera = ledgerLine.append({ dodDir: dod, story: '9.9', acs: [1], ts, cmd: 'curl -s http://app/primera', mirror: false });
  commit(repo, 'codigo y primera corrida');
  fs.appendFileSync(archivo, '// v2\n');
  const segunda = ledgerLine.append({ dodDir: dod, story: '9.9', acs: [1], ts, cmd: 'curl -s http://app/segunda', mirror: false });
  commit(repo, 'cambio y segunda corrida');
  const registro = path.join(dod, '9.9-smoke-ledger.jsonl');
  const juez = evidencia().crearJuez();
  const r1 = juez.vigencia(consulta(archivo, registro, Date.now(), HACE_DIEZ_MIN, primera.ledger));
  const r2 = juez.vigencia(consulta(archivo, registro, Date.now(), HACE_DIEZ_MIN, segunda.ledger));
  assert.equal(r1.cuenta, false, JSON.stringify(r1));
  assert.equal(r2.cuenta, true, JSON.stringify(r2));
});

// ---------------------------------------------------------------- los rojos verdaderos siguen rojos

test('T7 Vigente_CommitPosterior_DeOtraHistoria_NoCuenta @story-8.186 @ac-6', () => {
  const { repo, archivo, ev } = labBasico();
  fs.appendFileSync(archivo, '// otra historia\n');
  const corto = commit(repo, 'otra historia');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'cambio-posterior');
  assert.equal(r.commit, corto);
});

test('T8 Matriz_CommitPosterior_AvisoNombraArchivoYCommit @story-8.186 @ac-6', () => {
  const f = labMatriz({ enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => {
    gate(dod, gatesLog, HACE_DIEZ_MIN);
    humo(dod, gatesLog, [2]);
  } });
  fs.appendFileSync(f.archivo, '// otra historia\n');
  const corto = commit(f.repo, 'otra historia');
  const r = calcular(f);
  assert.notEqual(r.perAc[1].verdict, 'RUNTIME');
  assert.notEqual(r.perAc[2].verdict, 'RUNTIME');
  const delGate = r.warnings.find((w) => /Gate E2E .*ANTERIOR al último edit/.test(w));
  const delHumo = r.warnings.find((w) => /Smoke .*anterior al último edit/.test(w));
  for (const aviso of [delGate, delHumo]) {
    assert.ok(aviso, r.warnings.join('\n'));
    assert.match(aviso, /src\/Feature\.cs/);
    assert.ok(aviso.includes(corto), aviso);
  }
});

test('T9 Vigente_CambiosSinCommitear_NoCuenta @story-8.186 @ac-7', () => {
  const { archivo, ev } = labBasico();
  fs.appendFileSync(archivo, '// sin commitear\n');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'sin-commitear');

  // con la marca de no mirarlo, `status` lo oculta: un archivo editado no puede pasar por igual
  for (const marca of ['--assume-unchanged', '--skip-worktree']) {
    const lab = labBasico();
    fs.appendFileSync(lab.archivo, '// editado\n');
    git(lab.repo, ['update-index', marca, 'src/feature.js']);
    const oculto = evidencia().crearJuez().vigencia(consulta(lab.archivo, lab.ev));
    assert.equal(oculto.cuenta, false, `${marca}: ${JSON.stringify(oculto)}`);
    assert.equal(oculto.motivo, 'oculto-para-git');
    assert.match(evidencia().motivoEnPalabras(oculto), /marcado para que git no lo mire/);
  }

  // fuera de git: sin commitear nunca, o ignorado, que `status` no muestra
  const lab = labBasico();
  escribir(lab.repo, '.gitignore', 'ignorado.js\n');
  commit(lab.repo, 'ignorados');
  for (const nombre of ['nuevo.js', 'ignorado.js']) {
    const fuera = escribir(lab.repo, `src/${nombre}`, '// nunca commiteado\n');
    const rf = evidencia().crearJuez().vigencia(consulta(fuera, lab.ev));
    assert.equal(rf.cuenta, false, `${nombre}: ${JSON.stringify(rf)}`);
    assert.equal(rf.motivo, 'fuera-de-git', nombre);
  }
});

test('T10 Vigente_EvidenciaSinCommitear_CommitAnterior_NoCuenta @story-8.186 @ac-8', () => {
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  commit(repo, 'codigo');
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  irYVolverDeRama(repo, 'src/feature.js');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev, fs.statSync(archivo).mtimeMs));
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'evidencia-sin-commitear');
});

test('T11 Vigente_RepoHermano_CommitPosterior_NoCuenta @story-8.186 @ac-9', () => {
  const ws = carpeta();
  const espec = repoNuevo(ws, 'Specs');
  const ev = escribir(espec, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(espec, 'evidencia', 1700000000);
  const codigo = repoNuevo(ws, 'Back');
  const archivo = escribir(codigo, 'src/feature.js', '// v1\n');
  const corto = commit(codigo, 'codigo', 1700000100);
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'otro-repo');
  assert.equal(r.commit, corto);
  assert.match(evidencia().motivoEnPalabras(r), /entre repos sólo se pueden comparar horas/);
});

test('T12 Vigente_VolvioAlMismoContenido_Cuenta @story-8.186 @ac-10', () => {
  const { repo, archivo, ev } = labBasico();
  fs.writeFileSync(archivo, '// v2\n');
  commit(repo, 'cambia');
  fs.writeFileSync(archivo, '// v1\n');
  commit(repo, 'vuelve');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, true, JSON.stringify(r));
});

test('T19 Vigente_EditadoDespues_Preparado_NoCuenta @story-8.186 @ac-17', () => {
  // se prueba, se edita, se prepara todo: lo que ve el freno del commit
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  commit(repo, 'codigo');
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  fs.appendFileSync(archivo, '// editado despues de probar\n');
  git(repo, ['add', '-A']);
  const preparado = evidencia().crearJuez({ repoDelIndice: repo }).vigencia(consulta(archivo, ev));
  assert.equal(preparado.cuenta, false, JSON.stringify(preparado));

  // con la copia del índice que arma el freno para `git add … && git commit`: manda la copia, no el índice real
  const lab = labBasico();
  fs.appendFileSync(lab.archivo, '// preparado\n');
  git(lab.repo, ['add', '-A']);
  fs.writeFileSync(lab.archivo, '// v1\n');
  const copia = path.join(lab.repo, '..', 'copia-del-indice');
  fs.copyFileSync(path.join(lab.repo, '.git', 'index'), copia);
  git(lab.repo, ['add', 'src/feature.js'], { GIT_INDEX_FILE: copia });
  const sinCopia = evidencia().crearJuez({ repoDelIndice: lab.repo }).vigencia(consulta(lab.archivo, lab.ev));
  assert.equal(sinCopia.cuenta, false, 'el índice real tiene el archivo preparado distinto');
  const antes = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = copia;
  try {
    const conCopia = evidencia().crearJuez({ repoDelIndice: lab.repo }).vigencia(consulta(lab.archivo, lab.ev));
    assert.equal(conCopia.cuenta, true, JSON.stringify(conCopia));
    // una ruta relativa se cuenta desde donde corre el proceso, no desde la raíz del repo
    process.env.GIT_INDEX_FILE = path.relative(process.cwd(), copia);
    const conRelativa = evidencia().crearJuez({ repoDelIndice: lab.repo }).vigencia(consulta(lab.archivo, lab.ev));
    assert.equal(conRelativa.cuenta, true, JSON.stringify(conRelativa));
    process.env.GIT_INDEX_FILE = copia;
    // la copia es de otro repo: un hermano no la lee, y sigue contestando con la suya
    const hermano = repoNuevo(path.dirname(lab.repo), 'Hermano');
    const delHermano = escribir(hermano, 'src/otro.js', '// h\n');
    commit(hermano, 'hermano', 1700000000);
    const enHermano = evidencia().crearJuez({ repoDelIndice: lab.repo }).vigencia(consulta(delHermano, lab.ev));
    assert.equal(enHermano.cuenta, true, JSON.stringify(enHermano));
  } finally {
    if (antes === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = antes;
  }
});

test('T20 Vigente_EvidenciaAntesDelCodigo_NoCuenta_NombraCommit @story-8.186 @ac-18', () => {
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(repo, 'tanda anterior');
  fs.appendFileSync(archivo, '// tanda siguiente\n');
  const corto = commit(repo, 'tanda siguiente');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, false);
  assert.equal(r.commit, corto);
});

test('T21 Vigente_MergeYJuntada_EnMain_Cuenta @story-8.186 @ac-19', () => {
  for (const modo of ['merge', 'juntada']) {
    const repo = repoNuevo(carpeta());
    escribir(repo, 'README.md', 'base\n');
    commit(repo, 'base', 1700000000);
    git(repo, ['switch', '-q', '-c', 'historia']);
    const archivo = escribir(repo, 'src/feature.js', '// v1\n');
    const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
    commit(repo, 'codigo y evidencia', 1700000100);
    git(repo, ['switch', '-q', 'main']);
    const fecha = { GIT_COMMITTER_DATE: '1700000900 +0000', GIT_AUTHOR_DATE: '1700000900 +0000' };
    if (modo === 'merge') git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'historia'], fecha);
    else { git(repo, ['merge', '-q', '--squash', 'historia']); git(repo, ['commit', '-q', '-m', 'juntada'], fecha); }
    irYVolverDeRama(repo, 'src/feature.js');
    const r = evidencia().crearJuez().vigencia(consulta(archivo, ev, fs.statSync(archivo).mtimeMs));
    assert.equal(r.cuenta, true, `${modo}: ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------- modos de falla

test('T13 Vigente_SinGitOCortado_NoCuenta_YLoDice @story-8.186 @ac-11', () => {
  const sinGit = carpeta();
  const archivo = escribir(sinGit, 'src/feature.js', '// v1\n');
  const ev = escribir(sinGit, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  const r = evidencia().crearJuez().vigencia(consulta(archivo, ev));
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'sin-respuesta');
  assert.match(evidencia().motivoEnPalabras(r), /no se pudo comparar contra git/);

  // en un clon cortado el commit del borde parece haber agregado todo: con la evidencia y el archivo cambiado después,
  // daría verde falso
  const lab = labBasico();
  fs.appendFileSync(lab.archivo, '// cambiado despues de la evidencia\n');
  commit(lab.repo, 'cambio');
  const clon = path.join(carpeta(), 'clon');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${lab.repo}`, clon], { env: entornoGit(), stdio: 'ignore' });
  const r2 = evidencia().crearJuez().vigencia(consulta(path.join(clon, 'src', 'feature.js'), path.join(clon, '.advisors', 'dod-runtime', path.basename(lab.ev))));
  assert.equal(r2.cuenta, false, JSON.stringify(r2));
  assert.equal(r2.motivo, 'sin-respuesta');

  // git que falla: nunca se lee como que no cambió
  const { archivo: a3, ev: e3 } = labBasico();
  const r3 = evidencia().crearJuez({ correrGit: () => ({ codigo: null, salida: '' }) }).vigencia(consulta(a3, e3));
  assert.equal(r3.cuenta, false);
  assert.equal(r3.motivo, 'sin-respuesta');

  // una evidencia sin hora legible no se compara
  const r4 = evidencia().crearJuez().vigencia(consulta(a3, e3, Date.now(), NaN));
  assert.equal(r4.cuenta, false);
  assert.equal(r4.motivo, 'sin-hora');
  assert.match(evidencia().motivoEnPalabras(r4), /hora legible/);

  // un `diff` que no contesta 0 ni 1 no se lee como «cambió» ni como «igual»
  const lib = evidencia();
  const conGit = (cambio) => (dir, args, env) => cambio(args) || lib.correrGitDeVerdad(dir, args, env);
  const r5 = lib.crearJuez({ correrGit: conGit((a) => (a[0] === 'diff-tree' ? { codigo: 129, salida: '' } : null)) }).vigencia(consulta(a3, e3));
  assert.equal(r5.motivo, 'sin-respuesta', JSON.stringify(r5));

  // entre repos: el clon del código cortado, y un último commit que no se puede leer
  const ws = carpeta();
  const espec = repoNuevo(ws, 'Specs');
  const evDeOtroRepo = escribir(espec, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  commit(espec, 'evidencia', 1700000100);
  const codigo = repoNuevo(ws, 'Back');
  const delHermano = escribir(codigo, 'src/feature.js', '// v1\n');
  commit(codigo, 'codigo', 1700000000);
  const clonDelCodigo = path.join(ws, 'BackCortado');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${codigo}`, clonDelCodigo], { env: entornoGit(), stdio: 'ignore' });
  const r6 = lib.crearJuez().vigencia(consulta(path.join(clonDelCodigo, 'src', 'feature.js'), evDeOtroRepo));
  assert.equal(r6.motivo, 'sin-respuesta', JSON.stringify(r6));
  for (const salida of ['', 'abc123 no-es-una-hora abc']) {
    const conLog = conGit((a) => (a.includes('--first-parent') ? { codigo: 0, salida } : null));
    const r7 = lib.crearJuez({ correrGit: conLog }).vigencia(consulta(delHermano, evDeOtroRepo));
    assert.equal(r7.cuenta, false, JSON.stringify(r7));
    assert.equal(r7.motivo, 'sin-respuesta', JSON.stringify(r7));
  }
});

test('T14 Vigente_ArchivoBorrado_ComoHoy @story-8.186 @ac-12', () => {
  // un archivo que no está tiene fecha cero: la evidencia cuenta como hoy, y no se le pregunta a git
  const { repo, ev } = labBasico();
  const llamadas = [];
  const r = evidencia().crearJuez({ correrGit: (...a) => { llamadas.push(a); return { codigo: null, salida: '' }; } })
    .vigencia(consulta(path.join(repo, 'src', 'borrado.js'), ev, 0));
  assert.equal(r.cuenta, true);
  assert.equal(llamadas.length, 0);

  // y por la matriz: la historia declara un archivo que no está, y la evidencia cuenta como hoy
  const f = labMatriz({ historia: HISTORIA_DOS.replace('src/Feature.cs', 'src/Borrado.cs'),
    armarEvidencia: ({ dod, gatesLog }) => gate(dod, gatesLog, HACE_DIEZ_MIN) });
  const m = calcular(f);
  assert.equal(m.perAc[1].verdict, 'RUNTIME', m.warnings.join('\n'));
});

// ---------------------------------------------------------------- la lista con la ruta entre comillas

const HISTORIA_CON_COMILLAS = HISTORIA_DOS.replace('  - src/Feature.cs', '  - "src/Feature.cs"');

test('T15 Vigencia_ComillasEnRepoReal_CambioDeRamaSigueContando @story-8.191 @ac-13', () => {
  const f = labMatriz({ historia: HISTORIA_CON_COMILLAS, enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => gate(dod, gatesLog, HACE_DIEZ_MIN) });
  irYVolverDeRama(f.repo, 'src/Feature.cs');
  assert.ok(fs.statSync(f.archivo).mtimeMs > HACE_DIEZ_MIN, 'el cambio de rama tiene que reescribir la fecha');
  const r = calcular(f);
  assert.ok(r.codeMtime > 0, 'la matriz tiene que ver el archivo');
  assert.equal(r.perAc[1].verdict, 'RUNTIME', r.warnings.join('\n'));
});

test('T16 Vigencia_ComillasEnRepoReal_CambioDeArchivo_NoCuenta @story-8.191 @ac-1 @ac-13', () => {
  const f = labMatriz({ historia: HISTORIA_CON_COMILLAS, enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => gate(dod, gatesLog, HACE_DIEZ_MIN) });
  fs.appendFileSync(f.archivo, '// cambio de verdad\n');
  const hash = commit(f.repo, 'cambio de verdad');
  const r = calcular(f);
  assert.notEqual(r.perAc[1].verdict, 'RUNTIME');
  assert.ok(r.warnings.some((w) => w.includes('src/Feature.cs') && w.includes(hash)), r.warnings.join('\n'));
});

// ---------------------------------------------------------------- no-regresión

test('T15 Matriz_SinEspejo_ArchivoIgual_NoCuenta @story-8.186 @ac-13', () => {
  const f = labMatriz({ enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => {
    gate(dod, gatesLog, HACE_DIEZ_MIN, false);
    humo(dod, gatesLog, [2], undefined, undefined, false);
  } });
  irYVolverDeRama(f.repo, 'src/Feature.cs');
  const r = calcular(f);
  assert.notEqual(r.perAc[1].verdict, 'RUNTIME');
  assert.notEqual(r.perAc[2].verdict, 'RUNTIME');
  assert.ok(r.warnings.some((w) => /Gate E2E .* SIN espejo/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /Smoke ledger entry .* SIN espejo/.test(w)), r.warnings.join('\n'));
});

test('T16 Vigente_FechaAnterior_NoLlamaAGit_YUnaPorCalculo @story-8.186 @ac-14', () => {
  const { archivo, ev, repo } = labBasico();
  const llamadas = [];
  const lib = evidencia();
  const contar = (dir, args, env) => { llamadas.push(`${dir}\0${args.join('\0')}`); return lib.correrGitDeVerdad(dir, args, env); };
  const juez = lib.crearJuez({ correrGit: contar, repoDelIndice: repo });
  assert.equal(juez.vigencia(consulta(archivo, ev, HACE_UNA_HORA, HACE_DIEZ_MIN)).cuenta, true);
  assert.equal(llamadas.length, 0, 'con la fecha anterior a la evidencia no se llama a git');
  juez.vigencia(consulta(archivo, ev));
  juez.vigencia(consulta(archivo, ev));
  assert.ok(llamadas.length > 0);
  assert.equal(new Set(llamadas).size, llamadas.length, `pregunta repetida: ${llamadas.join(' | ')}`);
});

test('T17 Matriz_CodeMtime_SigueSiendoLaFechaDelDisco @story-8.186 @ac-16', () => {
  const f = labMatriz({ enOtroCommit: true, armarEvidencia: ({ dod, gatesLog }) => gate(dod, gatesLog, HACE_DIEZ_MIN) });
  irYVolverDeRama(f.repo, 'src/Feature.cs');
  const r = calcular(f);
  assert.equal(r.perAc[1].verdict, 'RUNTIME', r.warnings.join('\n'));
  assert.equal(r.codeMtime, fs.statSync(f.archivo).mtimeMs);
});

test('T18 Matriz_SuiteVieja_SinCambios_Verde @story-8.186 @ac-15', (t) => {
  const vieja = path.join(__dirname, 'test-runtime-matrix.js');
  const r = spawnSync(process.execPath, [vieja], { encoding: 'utf8', env: entornoGit() });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
  // la suite vieja puede cambiar en una historia futura: el «sin cambios» se mide contra el commit que se le pasa
  if (!process.env.T18_BASE) { t.diagnostic('sin T18_BASE: se midió sólo que está en verde'); return; }
  const diff = spawnSync('git', ['diff', '--quiet', process.env.T18_BASE, '--', path.basename(vieja)], { cwd: __dirname, env: entornoGit() });
  assert.equal(diff.status, 0, 'la suite vieja cambió');
});
