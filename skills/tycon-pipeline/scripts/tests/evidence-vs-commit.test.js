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

test('T14 Vigente_ArchivoBorrado_JuezComoHoyMatrizRojo @story-8.186 @ac-12', () => {
  // un archivo que no está tiene fecha cero: la evidencia cuenta como hoy, y no se le pregunta a git
  const { repo, ev } = labBasico();
  const llamadas = [];
  const r = evidencia().crearJuez({ correrGit: (...a) => { llamadas.push(a); return { codigo: null, salida: '' }; } })
    .vigencia(consulta(path.join(repo, 'src', 'borrado.js'), ev, 0));
  assert.equal(r.cuenta, true);
  assert.equal(llamadas.length, 0);

  // y por la matriz: la historia declara un archivo que no está. Desde la 8.200 la matriz no se lo pregunta al juez: no
  // pudo leerlo, la evidencia no cuenta y queda en rojo
  const f = labMatriz({ historia: HISTORIA_DOS.replace('src/Feature.cs', 'src/Borrado.cs'),
    armarEvidencia: ({ dod, gatesLog }) => gate(dod, gatesLog, HACE_DIEZ_MIN) });
  const m = calcular(f);
  assert.equal(m.perAc[1].verdict, 'NOT-RUN', m.warnings.join('\n'));
  assert.equal(m.green, false);
  assert.match(m.warnings.join('\n'), /no pude leer src\/Borrado\.cs/i);
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

// Un registro de humos con muchas líneas, cada una en su commit; una sale y vuelve a entrar, y la última no está commiteada.
// Lo que contestaba `git log -S` línea por línea (el commit más viejo que cambió cuántas veces aparece) lo tiene que
// contestar igual una sola pasada de git por registro.
test('T19 Registro_UnaPasadaDeGit_MismoCommitQueLaBusquedaPorLinea', () => {
  const repo = repoNuevo(carpeta());
  escribir(repo, 'src/feature.js', '// v1\n');
  commit(repo, 'codigo', 1700000000);
  const rel = '.advisors/dod-runtime/9.9-smoke-ledger.jsonl';
  const lineas = [];
  for (let i = 1; i <= 40; i += 1) {
    lineas.push(JSON.stringify({ ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, acs: [i], cmd: `node humo-${i}.js`, exit: 0 }));
    escribir(repo, rel, `${lineas.join('\n')}\n`);
    commit(repo, `humo ${i}`, 1700000000 + i * 60);
  }
  escribir(repo, rel, `${lineas.filter((_, k) => k !== 4).join('\n')}\n`);
  commit(repo, 'saca la 5', 1700009000);
  escribir(repo, rel, `${lineas.join('\n')}\n`);
  commit(repo, 'vuelve la 5', 1700009060);
  const suelta = JSON.stringify({ ts: '2026-01-02T00:00:00Z', acs: [99], cmd: 'node sin-commitear.js', exit: 0 });
  const ev = escribir(repo, rel, `${lineas.join('\n')}\n${suelta}\n`);

  const lib = evidencia();
  const logs = [];
  const juez = lib.crearJuez({ correrGit: (dir, args, env) => { if (args[0] === 'log') logs.push(args); return lib.correrGitDeVerdad(dir, args, env); } });
  for (const linea of [...lineas, suelta]) {
    const salida = git(path.dirname(ev), ['log', '--topo-order', '--format=%H %ct', `-S${linea}`, 'HEAD', '--', path.basename(ev)])
      .split('\n').filter(Boolean);
    const [hash, hora] = salida.length ? salida[salida.length - 1].split(' ') : [];
    const antes = hash ? { commit: hash, hora: Number(hora) } : { commit: null };
    assert.deepStrictEqual(juez.commitDeLaEvidencia({ ruta: ev, linea }), antes, `la línea ${linea}`);
  }
  assert.equal(logs.length, 1, `una sola pasada de git log por registro (fueron ${logs.length})`);
  assert.ok(!logs[0].some((a) => String(a).startsWith('-S')), 'ya no busca línea por línea');
});

// ---------------------------------------------------------------- la prueba corregida por la misma historia
// Decisión del dueño: una prueba que la misma historia cambió después de la evidencia vence sólo la evidencia de los
// criterios que esa prueba nombra (`@story-<historia> @ac-N`). Sin marcas, ilegible o de autoría desconocida, vence todo.

const HISTORIA_9_9 = { numero: '9.9', archivo: '/h/9-9-lab.md', catalogo: () => [{ numero: '9.9', archivo: '/h/9-9-lab.md' }, { numero: '9.8', archivo: '/h/9-8-otra.md' }] };
const PRUEBA_9_9 = 'tests/feature.test.js';
const conMarcas = (n) => `test('caso a @story-9.9 @ac-2 @ac-3', () => {});\ntest('caso b @story-9.9 @ac-3', () => {}); // v${n}\n`;

/** El repo de la historia: main con el código y la prueba (también como origin/main), y la rama de la historia con la evidencia. */
function labDeLaHistoria(prueba = conMarcas(1)) {
  const repo = repoNuevo(carpeta());
  const archivo = escribir(repo, 'src/feature.js', '// v1\n');
  const abs = escribir(repo, PRUEBA_9_9, prueba);
  commit(repo, 'base', 1700000000);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['switch', '-q', '-c', 'feature/9-9-lab']);
  const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20270101T000000Z.md', 'verdict=PASS\n');
  commit(repo, 'evidencia', 1700000100);
  const juzgar = (f, historia = HISTORIA_9_9) => evidencia().crearJuez({ historia }).vigencia({ archivo: f, mtimeMs: Date.now(), evidencia: { ruta: ev, tsMs: 1700000100 * 1000 } });
  return { repo, archivo, prueba: abs, ev, juzgar };
}

test('T17 EvidenceVsCommit_SameStoryTest_VoidsOnlyItsCriteria @story-8.263 @ac-14 — la prueba que la historia corrigió vence sólo sus criterios', () => {
  // con un commit en la rama de la historia, todavía sin fusionar (lo de siempre dentro de una corrida)
  let l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(2));
  commit(l.repo, 'arregla la prueba', 1700000200);
  let r = l.juzgar(l.prueba);
  assert.equal(r.cuenta, false, JSON.stringify(r));
  assert.equal(r.regla, 6, JSON.stringify(r));
  assert.deepStrictEqual(r.criterios, [2, 3], JSON.stringify(r));
  // sin commitear: la regla 2 la juzga igual, dentro de la carpeta de la historia
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(3));
  r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.criterios], [false, 6, [2, 3]], JSON.stringify(r));
  assert.equal(r.motivo, 'sin-commitear');
  // con la fusión del pedido de la historia
  l = labDeLaHistoria();
  git(l.repo, ['switch', '-q', 'main']);
  git(l.repo, ['switch', '-q', '-c', 'feature/9-9-arreglo']);
  escribir(l.repo, PRUEBA_9_9, conMarcas(4));
  commit(l.repo, 'arregla la prueba', 1700000200);
  git(l.repo, ['switch', '-q', 'feature/9-9-lab']);
  git(l.repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request 7 from feature/9-9-arreglo into main', 'feature/9-9-arreglo'],
    { GIT_COMMITTER_DATE: '1700000300 +0000', GIT_AUTHOR_DATE: '1700000300 +0000' });
  r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.criterios], [false, 6, [2, 3]], JSON.stringify(r));
});

// Sumarle o sacarle sólo marcas a una prueba no la cambia: la prueba hace lo mismo que cuando corrió la evidencia.
const conMarcaDeMas = 'test(\'caso a @story-9.9 @ac-2 @ac-3 @ac-4\', () => {});\ntest(\'caso b @story-9.9 @ac-3\', () => {}); // v1\n';

test('EvidenceVsCommit_SameStoryOnlyChangesTags_StillCounts — la historia que sólo suma o saca marcas en la prueba no vence la evidencia', () => {
  // un commit de la rama de la historia que sólo suma una marca al nombre de una prueba
  let l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcaDeMas);
  commit(l.repo, 'marca el criterio 4', 1700000200);
  let r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.via], [true, 6, 'solo-marcas'], JSON.stringify(r));
  // sin commitear, un renglón de comentario que sólo trae marcas y otra al final de un comentario que ya estaba
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, `// @story-9.9 @ac-5\n${conMarcas(1).replace('// v1', '// v1 @story-9.9 @ac-6')}`);
  r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.via], [true, 6, 'solo-marcas'], JSON.stringify(r));
  // sacar una marca tampoco cambia la prueba
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(1).replace(' @ac-2', ''));
  commit(l.repo, 'saca la marca del 2', 1700000200);
  r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.via], [true, 6, 'solo-marcas'], JSON.stringify(r));
});

test('EvidenceVsCommit_SameStoryTagsAndCode_VoidsItsCriteria — marcas y algo más, o un comentario que cambió, vencen como siempre', () => {
  let l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcaDeMas.replace('() => {});\ntest(\'caso b', '() => { assert.ok(1); });\ntest(\'caso b'));
  commit(l.repo, 'marca y cambia la prueba', 1700000200);
  let r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.criterios], [false, 6, [2, 3, 4]], JSON.stringify(r));
  // una marca y un comentario cambiado: el comentario no es una marca
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcaDeMas.replace('// v1', '// v2'));
  commit(l.repo, 'marca y comenta', 1700000200);
  r = l.juzgar(l.prueba);
  assert.deepStrictEqual([r.cuenta, r.regla, r.criterios], [false, 6, [2, 3, 4]], JSON.stringify(r));
  // una marca pegada a una palabra no es una marca: `x@ac-4` sigue siendo texto de la prueba
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(1).replace('caso a', 'caso a x@ac-4'));
  commit(l.repo, 'cambia el nombre', 1700000200);
  r = l.juzgar(l.prueba);
  assert.equal(r.cuenta, false, JSON.stringify(r));
});

test('EvidenceVsCommit_TagsInDataOrWhitespace_Voids — una marca en un dato de la prueba, o un cambio de espacios en un texto, vencen', () => {
  const base = 'test(\'caso a @story-9.9 @ac-2\', () => { assert.equal(f(), \'ok @ac-1\'); const t = `a \nb`; const r = /x @ac-1/; });\n';
  for (const [caso, ahora] of [
    ['la marca de un dato', base.replace('\'ok @ac-1\'', '\'ok\'')],
    ['la marca de una expresión', base.replace('/x @ac-1/', '/x/')],
    ['los espacios de una plantilla', base.replace('`a \nb`', '`a\nb`')],
    ['un salto de Windows en una plantilla', base.replace('`a \nb`', '`a \r\nb`')],
    ['una marca de un método que no declara una prueba', base.replace('assert.equal(f(), \'ok @ac-1\')', 'assert.equal(re.test(\'ok @ac-2\'), true)')],
  ]) {
    const l = labDeLaHistoria(base);
    escribir(l.repo, PRUEBA_9_9, ahora);
    commit(l.repo, 'cambia la prueba', 1700000200);
    const r = l.juzgar(l.prueba);
    assert.equal(r.cuenta, false, `${caso}: ${JSON.stringify(r)}`);
  }
});

test('EvidenceVsCommit_SameStoryShellTestOnlyTags_StillCounts — en una suite de bash, sumar un renglón de marcas no vence; cambiar un comando sí', () => {
  const nombre = 'tests/feature.test.sh';
  const lab = (inicial = '# @story-9.9 @ac-2\nok "caso a" "$(echo a)"\n') => {
    const repo = repoNuevo(carpeta());
    escribir(repo, 'src/feature.js', '// v1\n');
    const abs = escribir(repo, nombre, inicial);
    commit(repo, 'base', 1700000000);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['switch', '-q', '-c', 'feature/9-9-lab']);
    const ev = escribir(repo, '.advisors/dod-runtime/9.9-e2e-gate-20270101T000000Z.md', 'verdict=PASS\n');
    commit(repo, 'evidencia', 1700000100);
    const juzgar = () => evidencia().crearJuez({ historia: HISTORIA_9_9 }).vigencia({ archivo: abs, mtimeMs: Date.now(), evidencia: { ruta: ev, tsMs: 1700000100 * 1000 } });
    return { repo, juzgar };
  };
  let l = lab();
  escribir(l.repo, nombre, '# @story-9.9 @ac-2 @ac-3\n# @story-9.9 @ac-4\nok "caso a" "$(echo a)"\n');
  commit(l.repo, 'marca', 1700000200);
  let r = l.juzgar();
  assert.deepStrictEqual([r.cuenta, r.regla, r.via], [true, 6, 'solo-marcas'], JSON.stringify(r));
  l = lab();
  escribir(l.repo, nombre, '# @story-9.9 @ac-2 @ac-3\nok "caso a" "$(echo b)"\n');
  commit(l.repo, 'marca y cambia', 1700000200);
  r = l.juzgar();
  assert.deepStrictEqual([r.cuenta, r.regla], [false, 6], JSON.stringify(r));
  // fuera de un comentario, una marca es parte del comando; y un renglón sin marcas se compara tal cual
  for (const ahora of ['# @story-9.9 @ac-2\nok "caso a @ac-3" "$(echo a)"\n', '# @story-9.9 @ac-2 @ac-3\nok "caso a" "$(echo a)" \n',
    '# @story-9.9 @ac-2 @ac-3\r\nok "caso a" "$(echo a)"\r\n']) {
    l = lab();
    escribir(l.repo, nombre, ahora);
    commit(l.repo, 'marca y algo más', 1700000200);
    r = l.juzgar();
    assert.equal(r.cuenta, false, `${JSON.stringify(ahora)}: ${JSON.stringify(r)}`);
  }
  // un renglón con `#` adentro de un heredoc es un dato del archivo que escribe: una marca ahí cambia la prueba
  const conHeredoc = 'ok "caso a" "$(echo a)"\ncat > x.txt <<EOF\n# x\nEOF\n';
  l = lab(conHeredoc);
  escribir(l.repo, nombre, conHeredoc.replace('# x', '# x @ac-5'));
  commit(l.repo, 'marca adentro del heredoc', 1700000200);
  r = l.juzgar();
  assert.equal(r.cuenta, false, JSON.stringify(r));
});

test('T18 EvidenceVsCommit_SameStoryTestWithoutTags_VoidsAll @story-8.263 @ac-15 @ac-16 @ac-17 — sin marcas, ilegible, de código o de autoría desconocida vence todo; la de otra historia cuenta', () => {
  const venceTodo = (r, caso) => {
    assert.equal(r.cuenta, false, `${caso}: ${JSON.stringify(r)}`);
    assert.ok(!Array.isArray(r.criterios) || !r.criterios.length, `${caso}: ${JSON.stringify(r)}`);
  };
  // la prueba sin marcas
  let l = labDeLaHistoria('test(\'caso sin marcas\', () => {});\n');
  escribir(l.repo, PRUEBA_9_9, 'test(\'caso sin marcas\', () => {}); // v2\n');
  commit(l.repo, 'arregla la prueba', 1700000200);
  venceTodo(l.juzgar(l.prueba), 'sin marcas');
  // la prueba que no se deja leer
  l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(2));
  fs.chmodSync(l.prueba, 0o000);
  try { venceTodo(l.juzgar(l.prueba), 'ilegible'); } finally { fs.chmodSync(l.prueba, 0o644); }
  // un archivo de código, aunque lo cambie la misma historia
  l = labDeLaHistoria();
  escribir(l.repo, 'src/feature.js', '// v2\n');
  commit(l.repo, 'arregla el código', 1700000200);
  venceTodo(l.juzgar(l.archivo), 'código');
  // la prueba cambiada por otra historia: cuenta, como hoy
  l = labDeLaHistoria();
  git(l.repo, ['switch', '-q', '-c', 'feature/9-8-otra', 'main']);
  escribir(l.repo, PRUEBA_9_9, conMarcas(5));
  commit(l.repo, 'otra historia', 1700000200);
  git(l.repo, ['switch', '-q', 'feature/9-9-lab']);
  git(l.repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request 8 from feature/9-8-otra into main', 'feature/9-8-otra'],
    { GIT_COMMITTER_DATE: '1700000300 +0000', GIT_AUTHOR_DATE: '1700000300 +0000' });
  const ajena = l.juzgar(l.prueba);
  assert.deepStrictEqual([ajena.cuenta, ajena.regla], [true, 6], JSON.stringify(ajena));
  // un commit de historia desconocida que ya está en main, sin su fusión
  l = labDeLaHistoria();
  git(l.repo, ['switch', '-q', 'main']);
  escribir(l.repo, PRUEBA_9_9, conMarcas(6));
  commit(l.repo, 'directo a main', 1700000200);
  git(l.repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(l.repo, ['switch', '-q', 'feature/9-9-lab']);
  git(l.repo, ['merge', '-q', '--no-ff', '-m', 'trae main', 'main'], { GIT_COMMITTER_DATE: '1700000300 +0000', GIT_AUTHOR_DATE: '1700000300 +0000' });
  venceTodo(l.juzgar(l.prueba), 'desconocida en main');
  // la prueba que escribió la resolución de una fusión
  l = labDeLaHistoria();
  git(l.repo, ['switch', '-q', '-c', 'feature/9-8-otra', 'main']);
  escribir(l.repo, 'otro.txt', 'x');
  commit(l.repo, 'no toca la prueba', 1700000200);
  git(l.repo, ['switch', '-q', 'feature/9-9-lab']);
  git(l.repo, ['merge', '-q', '--no-ff', '--no-commit', 'feature/9-8-otra']);
  escribir(l.repo, PRUEBA_9_9, conMarcas(7));
  commit(l.repo, 'Merge pull request 9 from feature/9-8-otra into main', 1700000300);
  venceTodo(l.juzgar(l.prueba), 'resolución de fusión');
});

test('EvidenceVsCommit_FixedTestCriteria_ReadFromEveryVersion @story-8.263 @ac-14 @ac-15 — los criterios salen de todo el archivo y también de la versión que juzgó la evidencia', () => {
  const tieneTodos = (r, esperados, caso) => {
    assert.deepStrictEqual([r.cuenta, r.regla], [false, 6], `${caso}: ${JSON.stringify(r)}`);
    assert.ok(Array.isArray(r.criterios) && esperados.every((n) => r.criterios.includes(n)), `${caso}: ${JSON.stringify(r)}`);
  };
  // un archivo que nombra otra historia y marca cada caso sin repetir la marca de la historia
  const varias = (v) => [
    "describe('T1 @story-9.9 @ac-1 @ac-2', () => {",
    "  it('T2 @ac-2', () => {});",
    `  it('T6 @ac-3', () => {}); // v${v}`,
    '});',
    "describe('@story-9.8 @ac-7', () => {});", ''].join('\n');
  let l = labDeLaHistoria(varias(1));
  escribir(l.repo, PRUEBA_9_9, varias(2));
  commit(l.repo, 'arregla la prueba', 1700000200);
  tieneTodos(l.juzgar(l.prueba), [1, 2, 3], 'varias historias');
  // el arreglo commiteado sacó la marca de un caso: ese criterio también vence
  const dos = (b) => `test('caso a @story-9.9 @ac-2', () => {});\ntest('caso b ${b}', () => {});\n`;
  l = labDeLaHistoria(dos('@story-9.9 @ac-3'));
  escribir(l.repo, PRUEBA_9_9, dos('ahora sin marca'));
  commit(l.repo, 'arregla la prueba', 1700000200);
  tieneTodos(l.juzgar(l.prueba), [2, 3], 'marca sacada y commiteada');
  // y lo mismo si después se vuelve a editar sin commitear
  escribir(l.repo, PRUEBA_9_9, `${dos('ahora sin marca')}// otra vez\n`);
  tieneTodos(l.juzgar(l.prueba), [2, 3], 'marca sacada, commiteada y vuelta a editar');
  // una fusión de otra historia tocó la prueba y la historia la edita sin commitear: vence por criterio, no todo
  l = labDeLaHistoria();
  git(l.repo, ['switch', '-q', '-c', 'feature/9-8-otra', 'main']);
  escribir(l.repo, PRUEBA_9_9, conMarcas(5));
  commit(l.repo, 'otra historia', 1700000200);
  git(l.repo, ['switch', '-q', 'feature/9-9-lab']);
  git(l.repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request 8 from feature/9-8-otra into main', 'feature/9-8-otra'],
    { GIT_COMMITTER_DATE: '1700000300 +0000', GIT_AUTHOR_DATE: '1700000300 +0000' });
  escribir(l.repo, PRUEBA_9_9, `${conMarcas(5)}// la historia la corrige\n`);
  const r = l.juzgar(l.prueba);
  tieneTodos(r, [2, 3], 'fusión ajena y edición propia sin commitear');
  assert.equal(r.motivo, 'sin-commitear');
});

test('EvidenceVsCommit_EvidenceVersionUnreadable_VoidsAll @story-8.263 @ac-15 — si no se encuentra la versión que juzgó la evidencia, vence toda', () => {
  const l = labDeLaHistoria();
  escribir(l.repo, PRUEBA_9_9, conMarcas(2));
  const lib = evidencia();
  const juez = lib.crearJuez({ historia: HISTORIA_9_9, correrGit: (dir, args, env) =>
    (args[0] === 'rev-list' && args.some((a) => String(a).startsWith('--before=')) ? { codigo: 128, salida: '', error: 'fatal: de mentira' } : lib.correrGitDeVerdad(dir, args, env)) });
  const r = juez.vigencia({ archivo: l.prueba, mtimeMs: Date.now(), evidencia: { ruta: l.ev, tsMs: 1700000100 * 1000 } });
  assert.equal(r.cuenta, false, JSON.stringify(r));
  assert.ok(!Array.isArray(r.criterios) || !r.criterios.length, JSON.stringify(r));
});

test('EvidenceVsCommit_StoryNumberWithRegexChars_ReadsItsCriteria @story-8.263 @ac-14 — un número de historia con caracteres de expresión se busca literal: lee sus criterios y no revienta', () => {
  for (const numero of ['9.9(', '9.9[']) {
    const historia = { numero, archivo: '/h/9-9-lab.md', catalogo: () => [{ numero, archivo: '/h/9-9-lab.md' }] };
    const l = labDeLaHistoria(`test('caso @story-${numero} @ac-4', () => {}); // v1\n`);
    escribir(l.repo, PRUEBA_9_9, `test('caso @story-${numero} @ac-4', () => {}); // v2\n`);
    const r = l.juzgar(l.prueba, historia);
    assert.deepStrictEqual([r.cuenta, r.regla, r.criterios], [false, 6, [4]], `${numero}: ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------- la regla de la entrada a main (historia 8.310)

const BASE_ENTRADA = Math.floor(Date.now() / 1000) - 12 * 3600;
const HISTORIA_ENTRADA = { numero: '9.9', clave: '9.9', archivo: '/h/9.9.md' };

function fijarOrigen(repo) { git(repo, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']); }
const conFecha = (t) => ({ GIT_COMMITTER_DATE: `${t} +0000`, GIT_AUTHOR_DATE: `${t} +0000` });
const blobDe = (repo, rev, rel) => git(repo, ['rev-parse', `${rev}:${rel}`]);

function enRama(repo, rama, cambios, t, mensaje = 'cambio', desde = 'main') {
  git(repo, ['switch', '-q', '-C', rama, desde]);
  for (const [rel, texto] of Object.entries(cambios)) escribir(repo, rel, texto);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', mensaje], conFecha(t));
  return git(repo, ['rev-parse', 'HEAD']);
}

// Una fusión de pedido a main, con el asunto que escribe la plataforma. Devuelve su commit corto.
function fusionarPedido(repo, rama, numero, t) {
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', `Merge pull request #${numero} from org/${rama}`, rama], conFecha(t));
  fijarOrigen(repo);
  return git(repo, ['rev-parse', '--short', 'HEAD']);
}

/** El repo del código (`Codigo`, con `origin/main`) y el de las historias, con el renglón del humo ya commiteado. */
function labEntrada() {
  const ws = carpeta();
  const codigo = repoNuevo(ws, 'Codigo');
  const historias = repoNuevo(ws, 'Historias');
  escribir(codigo, 'src/a.js', '// a0\n');
  escribir(codigo, 'src/b.js', '// b0\n');
  escribir(codigo, 'tests/a.test.js', '// @story-9.9 @ac-1\n');
  git(codigo, ['add', '-A']);
  git(codigo, ['commit', '-q', '-m', 'inicio'], conFecha(BASE_ENTRADA));
  fijarOrigen(codigo);
  const tsHumo = BASE_ENTRADA + 200;
  const anclaCommit = enRama(codigo, 'wt/Uno', { 'src/a.js': '// a1 probado\n' }, BASE_ENTRADA + 100);
  const linea = JSON.stringify({ ts: new Date(tsHumo * 1000).toISOString(), story: '9.9', acs: [1], exit: 0 });
  const ruta = escribir(historias, '.advisors/dod-runtime/9.9-smoke-ledger.jsonl', `${linea}\n`);
  git(historias, ['add', '-A']);
  git(historias, ['commit', '-q', '-m', 'evidencia'], conFecha(BASE_ENTRADA + 250));
  const evidencia = { ruta, tsMs: tsHumo * 1000, linea, ancla: [{ repo: 'Codigo', commit: anclaCommit }] };
  return { ws, codigo, historias, evidencia, a: path.join(codigo, 'src/a.js'), b: path.join(codigo, 'src/b.js'), prueba: path.join(codigo, 'tests/a.test.js'), anclaCommit };
}

test('Entrada_CambioPropioQueEntraPorDev_Vence @story-8.310 @ac-7', () => {
  const f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  // la historia corrige su código después: su pedido entra a dev con su número registrado, y después dev entra a main
  git(f.codigo, ['switch', '-q', '-C', 'dev', 'main']);
  enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// a2 propio\n' }, BASE_ENTRADA + 350, 'cambio', 'dev');
  git(f.codigo, ['switch', '-q', 'dev']);
  git(f.codigo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from org/wt/Dos into dev', 'wt/Dos'], conFecha(BASE_ENTRADA + 360));
  git(f.codigo, ['switch', '-q', 'main']);
  git(f.codigo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #13 from org/dev into main', 'dev'], conFecha(BASE_ENTRADA + 400));
  fijarOrigen(f.codigo);
  const r = juezDeEntrada([['Codigo#12', ['9.9']]]).entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.strictEqual(r && r.motivo, 'cambio-propio-tras-entrar', JSON.stringify(r));
});

test('Entrada_GitConFirmaEnElLog_NoLeeLaFirmaComoCommit @story-8.310 @ac-8', () => {
  const f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// a2 de otra\n' }, BASE_ENTRADA + 350);
  fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
  // con log.showSignature=true y commits firmados, git escribe la firma antes del formato pedido
  const conFirma = (carpeta, args, env) => {
    const r = evidencia().correrGitDeVerdad(carpeta, args, env);
    if (args.includes('log') && !args.includes('--no-show-signature') && r.codigo === 0 && r.salida) r.salida = `gpg: Firma hecha con la llave X\n${r.salida}`;
    return r;
  };
  const real = juezDeEntrada([['Codigo#12', ['9.8']]]).entrada({ archivo: f.a, evidencia: f.evidencia });
  const firmado = juezDeEntrada([['Codigo#12', ['9.8']]], { correrGit: conFirma }).entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.deepStrictEqual(firmado, real);
});

function juezDeEntrada(filas = [], extra = {}) {
  const porPedido = new Map();
  for (const [clave, h] of filas) porPedido.set(clave, h.map((x) => ({ historia: x, clave: x })));
  return evidencia().crearJuez({
    historia: { ...HISTORIA_ENTRADA, catalogo: () => [{ numero: '9.9', archivo: '/h/9.9.md' }, { numero: '9.8', archivo: '/h/9.8.md' }], pedidos: () => ({ porPedido, ilegibles: [] }) },
    ...extra,
  });
}

test('T1 Entrada_OtroRepo_IgualYDespuesCambiaOtra_Cuenta @story-8.310 @ac-1', () => {
  const f = labEntrada();
  const blob = blobDe(f.codigo, f.anclaCommit, 'src/a.js');
  f.evidencia.ancla = [{ repo: 'Codigo', commit: `${f.anclaCommit}`, huellas: { 'src/a.js': blob } }];
  const entrada = fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// a2 de otra\n' }, BASE_ENTRADA + 350);
  const ajena = fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
  enRama(f.codigo, 'wt/Tres', { 'src/a.js': '// a3 de nadie\n' }, BASE_ENTRADA + 450);
  const nadie = fusionarPedido(f.codigo, 'wt/Tres', 13, BASE_ENTRADA + 500);
  const r = juezDeEntrada([['Codigo#12', ['9.8']]]).entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.strictEqual(r.cuenta, true, JSON.stringify(r));
  assert.strictEqual(r.regla, 'entrada');
  assert.strictEqual(r.commit, entrada);
  assert.deepStrictEqual(r.ajenas, [{ commit: ajena, historia: '9.8' }]);
  assert.deepStrictEqual(r.sinHistoria, [nadie]);
});

test('T1b Entrada_SinHuella_ComparaConElCommitDelAncla @story-8.310 @ac-1', () => {
  const f = labEntrada();
  const entrada = fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  const r = juezDeEntrada().entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.strictEqual(r.cuenta, true, JSON.stringify(r));
  assert.strictEqual(r.commit, entrada);
});

test('T1c Entrada_PortonE2E_ConAncla_Cuenta @story-8.310 @ac-1', () => {
  const f = labEntrada();
  const ruta = escribir(f.historias, '.advisors/dod-runtime/9.9-e2e-gate-20260101T000000Z.md', 'verdict=PASS\n');
  git(f.historias, ['add', '-A']);
  git(f.historias, ['commit', '-q', '-m', 'porton'], conFecha(BASE_ENTRADA + 260));
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  const r = juezDeEntrada().entrada({ archivo: f.a, evidencia: { ruta, tsMs: f.evidencia.tsMs, ancla: f.evidencia.ancla } });
  assert.strictEqual(r.cuenta, true, JSON.stringify(r));
  assert.strictEqual(r.regla, 'entrada');
});

test('T2 Entrada_MismoRepo_SelloYCommitDeLaEvidencia_Cuentan @story-8.310 @ac-2', () => {
  for (const conSello of [true, false]) {
    const repo = repoNuevo(carpeta(), 'Proj');
    const a = escribir(repo, 'src/a.js', '// a0\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'inicio'], conFecha(BASE_ENTRADA));
    fijarOrigen(repo);
    enRama(repo, 'wt/Uno', { 'src/a.js': '// a1\n' }, BASE_ENTRADA + 100);
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    const linea = JSON.stringify({ ts: new Date((BASE_ENTRADA + 200) * 1000).toISOString(), story: '9.9', acs: [1], exit: 0 });
    const ruta = escribir(repo, '.advisors/dod-runtime/9.9-smoke-ledger.jsonl', `${linea}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'evidencia'], conFecha(BASE_ENTRADA + 250));
    const entrada = fusionarPedido(repo, 'wt/Uno', 11, BASE_ENTRADA + 300);
    enRama(repo, 'wt/Dos', { 'src/a.js': '// a2\n' }, BASE_ENTRADA + 350);
    fusionarPedido(repo, 'wt/Dos', 12, BASE_ENTRADA + 400);
    const ev = { ruta, tsMs: (BASE_ENTRADA + 200) * 1000, linea, ...(conSello ? { sello: { tree } } : {}) };
    const r = juezDeEntrada().entrada({ archivo: a, evidencia: ev });
    assert.strictEqual(r.cuenta, true, `${conSello}: ${JSON.stringify(r)}`);
    assert.strictEqual(r.commit, entrada);
  }
});

test('T3 Entrada_YaEstabaEnMain_ConOtroQueEntro_Cuenta @story-8.310 @ac-3', () => {
  const f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  enRama(f.codigo, 'wt/Dos', { 'src/b.js': '// b1 de otra\n' }, BASE_ENTRADA + 350);
  fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
  const ajena = juezDeEntrada().entrada({ archivo: f.b, evidencia: f.evidencia });
  assert.strictEqual(ajena.cuenta, true, JSON.stringify(ajena));
  assert.strictEqual(ajena.yaEstaba, true);
  assert.strictEqual(ajena.commit, null, 'lo que ya estaba no trae commit de entrada');
  const propia = juezDeEntrada([['Codigo#12', ['9.9']]]).entrada({ archivo: f.b, evidencia: f.evidencia });
  assert.strictEqual(propia.cuenta, false, JSON.stringify(propia));
  assert.strictEqual(propia.motivo, 'cambio-propio-tras-entrar');
});

test('T6 Entrada_PrimerCambioDistinto_NoCuentaAunqueVuelva @story-8.310 @ac-6', () => {
  const f = labEntrada();
  enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// otra cosa\n' }, BASE_ENTRADA + 250);
  const primera = fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 300);
  enRama(f.codigo, 'wt/Tres', { 'src/a.js': '// a1 probado\n' }, BASE_ENTRADA + 350);
  fusionarPedido(f.codigo, 'wt/Tres', 13, BASE_ENTRADA + 400);
  const r = juezDeEntrada().entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.strictEqual(r.cuenta, false, JSON.stringify(r));
  assert.strictEqual(r.motivo, 'entro-otro-contenido');
  assert.strictEqual(r.commit, primera);
  assert.match(evidencia().motivoEnPalabras(r), /no es lo que se prob/);
});

test('T7 Entrada_FusionPropiaPosterior_NoCuenta @story-8.310 @ac-7', () => {
  const f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// a2 propio\n' }, BASE_ENTRADA + 350);
  const propia = fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
  const r = juezDeEntrada([['Codigo#12', ['9.9']]]).entrada({ archivo: f.a, evidencia: f.evidencia });
  assert.strictEqual(r.cuenta, false, JSON.stringify(r));
  assert.strictEqual(r.motivo, 'cambio-propio-tras-entrar');
  assert.strictEqual(r.fusion, propia);
  assert.ok(evidencia().motivoEnPalabras(r).includes(propia));
});

test('T7b Entrada_AsuntoNombraLaHistoria_EsPropia @story-8.310 @ac-7 @ac-19', () => {
  const caso = (mensaje, filas = [], aplastada = false) => {
    const f = labEntrada();
    fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
    if (aplastada) {
      git(f.codigo, ['switch', '-q', 'main']);
      escribir(f.codigo, 'src/a.js', '// a2\n');
      git(f.codigo, ['add', '-A']);
      git(f.codigo, ['commit', '-q', '-m', mensaje], conFecha(BASE_ENTRADA + 400));
      fijarOrigen(f.codigo);
    } else {
      enRama(f.codigo, 'wt/Dos', { 'src/a.js': '// a2\n' }, BASE_ENTRADA + 350, mensaje);
      fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
    }
    return juezDeEntrada(filas).entrada({ archivo: f.a, evidencia: f.evidencia });
  };
  assert.strictEqual(caso('fix(9.9): corrijo lo mío').motivo, 'cambio-propio-tras-entrar');
  const parecido = caso('fix(9.91): otra historia');
  assert.strictEqual(parecido.cuenta, true, JSON.stringify(parecido));
  assert.strictEqual(parecido.sinHistoria.length, 1);
  assert.strictEqual(caso('Merged PR 40: fix(9.9) aplastado', [], true).motivo, 'cambio-propio-tras-entrar');
  assert.strictEqual(caso('fix(9.9): con renglón ajeno', [['Codigo#12', ['9.8']]]).motivo, 'cambio-propio-tras-entrar', 'un renglón de otra historia no lo vuelve ajeno');
});

test('T8 Entrada_SinDatosOGitMudo_NoSeAplica @story-8.310 @ac-8', () => {
  const armado = () => { const f = labEntrada(); fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300); return f; };
  let f = armado();
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.a, evidencia: { ...f.evidencia, ancla: undefined } }), null, 'sin ancla');
  f = armado();
  git(f.codigo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'sin origin/main');
  const con = (filtro) => juezDeEntrada([], { correrGit: (c, a, e) => (filtro(a) ? { codigo: null, salida: '' } : evidencia().correrGitDeVerdad(c, a, e)) });
  f = armado();
  assert.strictEqual(juezDeEntrada([], { correrGit: (c, a, e) => (a[1] === '--is-shallow-repository' ? { codigo: 0, salida: 'true\n' } : evidencia().correrGitDeVerdad(c, a, e)) }).entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'clon cortado');
  assert.strictEqual(con((a) => a[0] === 'rev-list').entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'git no contesta');
  assert.strictEqual(con((a) => a[0] === 'merge-base').entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'no se sabe si la entrada está en HEAD');
  f = armado();
  git(f.codigo, ['switch', '-q', '--detach', 'main~1']);
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'la entrada no está en HEAD');
});

test('T9 Entrada_SinCommitearYEvidenciaSinCommitear_ComoHoy @story-8.310 @ac-9', () => {
  let f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  fs.appendFileSync(f.a, '// sin commitear\n');
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.a, evidencia: f.evidencia }), null);
  assert.strictEqual(juezDeEntrada().vigencia({ archivo: f.a, mtimeMs: Date.now(), evidencia: f.evidencia }).motivo, 'sin-commitear');
  f = labEntrada();
  fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
  const linea = JSON.stringify({ ts: 'sin-commitear', story: '9.9', acs: [2], exit: 0 });
  fs.appendFileSync(f.evidencia.ruta, `${linea}\n`);
  const ev = { ...f.evidencia, linea };
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.a, evidencia: ev }), null);
  assert.strictEqual(juezDeEntrada().vigencia({ archivo: f.a, mtimeMs: Date.now(), evidencia: ev }).motivo, 'evidencia-sin-commitear');
});

test('T10 Entrada_PruebasYCargados_PropioVence_AjenoNo @story-8.310 @ac-10', () => {
  const caso = (filas, texto = '// cambiada\n') => {
    const f = labEntrada();
    enRama(f.codigo, 'wt/Uno', { 'tests/a.test.js': '// @story-9.9 @ac-1 probada\n' }, BASE_ENTRADA + 150, 'prueba', 'wt/Uno');
    f.evidencia.ancla = [{ repo: 'Codigo', commit: git(f.codigo, ['rev-parse', 'wt/Uno']) }];
    fusionarPedido(f.codigo, 'wt/Uno', 11, BASE_ENTRADA + 300);
    enRama(f.codigo, 'wt/Dos', { 'tests/a.test.js': texto }, BASE_ENTRADA + 350);
    fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 400);
    return { f, r: juezDeEntrada(filas).entrada({ archivo: f.prueba, evidencia: f.evidencia }) };
  };
  assert.strictEqual(caso([['Codigo#12', ['9.8']]]).r.cuenta, true, 'de otra historia');
  assert.strictEqual(caso([]).r.cuenta, true, 'sin historia conocida');
  const propia = caso([['Codigo#12', ['9.9']]]);
  assert.strictEqual(propia.r.motivo, 'cambio-propio-tras-entrar');
  assert.deepStrictEqual(juezDeEntrada().criteriosDe({ archivo: propia.f.prueba, desde: propia.r.desde }), [1], 'vence sólo sus criterios, aunque el cambio les haya sacado la marca');
  const f = labEntrada();
  enRama(f.codigo, 'wt/Dos', { 'tests/a.test.js': '// entró otra\n' }, BASE_ENTRADA + 100);
  fusionarPedido(f.codigo, 'wt/Dos', 12, BASE_ENTRADA + 300);
  f.evidencia.ancla = [{ repo: 'Codigo', commit: f.anclaCommit, huellas: { 'tests/a.test.js': blobDe(f.codigo, 'main~1', 'src/b.js') } }];
  assert.strictEqual(juezDeEntrada().entrada({ archivo: f.prueba, evidencia: f.evidencia }).motivo, 'entro-otro-contenido');
});

test('T22 Entrada_SinFusionEnMain_ComoHoy @story-8.310 @ac-26', () => {
  const f = labEntrada();
  const juez = juezDeEntrada();
  assert.strictEqual(juez.entrada({ archivo: f.a, evidencia: f.evidencia }), null, 'la rama no entró');
  const hoy = evidencia().crearJuez().vigencia({ archivo: f.a, mtimeMs: Date.now(), evidencia: f.evidencia });
  assert.deepStrictEqual(juez.vigencia({ archivo: f.a, mtimeMs: Date.now(), evidencia: f.evidencia }), hoy);
});
