#!/usr/bin/env node
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. Las fechas de commit que se comparan las fija cada laboratorio.
/**
 * evidence-vs-merge.test.js — con el archivo en otro repo, la fusión de la propia historia no vence su evidencia, un cambio
 * de otra historia en una prueba tampoco, y todo código que la evidencia no probó sigue sin contar.
 *
 * Los laboratorios son repos de git de verdad, en una carpeta temporal: uno con el código y otro con la evidencia.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/evidence-vs-merge.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
const ledgerLine = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const juezLib = require(path.join(SCRIPTS, 'lib', 'evidence-vs-commit.js'));
const commitStory = () => require(path.join(SCRIPTS, 'lib', 'commit-story.js'));

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = 1700000000;
const EVIDENCIA = T0 + 120;
const PROPIA = '5.28';
const CATALOGO = [{ numero: '5.28', archivo: '/h/5-28-carga.md' }, { numero: '5.29', archivo: '/h/5-29-otra.md' }];
const PRUEBA = 'tests/App.Tests/FeatureTests.cs';

function entornoGit(fecha) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return fecha ? { ...env, GIT_COMMITTER_DATE: `${fecha} +0000`, GIT_AUTHOR_DATE: `${fecha} +0000` } : env;
}
function git(repo, args, fecha) {
  return execFileSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: entornoGit(fecha) }).trim();
}
function carpeta() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evm-')));
  temporales.push(d);
  return d;
}
function repoNuevo(dentro, nombre) {
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
function commit(repo, mensaje, fecha) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', mensaje], fecha);
  return git(repo, ['rev-parse', '--short', 'HEAD']);
}
const rama = (repo, nombre) => git(repo, ['checkout', '-q', '-b', nombre]);
const irA = (repo, nombre) => git(repo, ['checkout', '-q', nombre]);
const asuntoDe = (nombre) => `Merge pull request 77 from ${nombre} into main`;
function fusionar(repo, nombre, fecha, asunto = asuntoDe(nombre)) {
  git(repo, ['merge', '-q', '--no-ff', '-m', asunto, nombre], fecha);
  return git(repo, ['rev-parse', '--short', 'HEAD']);
}
function juntar(repo, nombre, fecha, asunto = 'feat: lo de la rama (#7)') {
  git(repo, ['merge', '-q', '--squash', nombre]);
  git(repo, ['commit', '-q', '-m', asunto], fecha);
  return git(repo, ['rev-parse', '--short', 'HEAD']);
}

/** Un repo con el código y otro con la evidencia; la evidencia se guarda cuando el caso lo pide. */
function lab(dentro = carpeta()) {
  const back = repoNuevo(dentro, 'Back');
  const esp = repoNuevo(dentro, 'Historias');
  const archivo = escribir(back, 'src/Feature.cs', '// v1\n');
  const prueba = escribir(back, PRUEBA, '// p1\n');
  commit(back, 'base', T0);
  const evidencia = (fecha = EVIDENCIA, tsDeLaCorrida = fecha) => {
    const ruta = escribir(esp, '.advisors/dod-runtime/5.28-e2e-gate-20270101T000000Z.md', 'verdict=PASS\n');
    commit(esp, 'evidencia', fecha);
    return { ruta, tsMs: tsDeLaCorrida * 1000 };
  };
  return { back, esp, archivo, prueba, evidencia };
}
const historia = (extra = {}) => ({ numero: PROPIA, archivo: '/h/5-28-carga.md', catalogo: () => CATALOGO, ...extra });
const juzgar = (archivo, ev, opts = {}) => juezLib.crearJuez({ historia: historia(), ...opts })
  .vigencia({ archivo, mtimeMs: Date.now(), evidencia: ev });

// ---------------------------------------------------------------- la fusión propia no vence

function codigoEvidenciaFusion(l) {
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'main');
  escribir(l.back, 'otro.txt', 'x');
  commit(l.back, 'otra cosa', T0 + 110);
  return ev;
}

test('T1 Fusion_PropiaPosterior_Cuenta @story-8.192 @ac-1', () => {
  const l = lab();
  const ev = codigoEvidenciaFusion(l);
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  const r = juzgar(l.archivo, ev);
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.regla, 5);
  assert.equal(r.via, 'fusion-propia');
});

test('T2 Fusion_PropiaYDevAMain_Cuenta @story-8.192 @ac-2', () => {
  const l = lab();
  rama(l.back, 'dev');
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'dev');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  irA(l.back, 'main');
  fusionar(l.back, 'dev', T0 + 300, 'Merge pull request 900 from dev into main');
  assert.equal(juzgar(l.archivo, ev).cuenta, true);
});

/** Dos repos de verdad con la matriz real: historia y humo con espejo en uno, código en el otro. Horas cerca de ahora. */
function labMatriz({ declarados = ['Back/src/Feature.cs'], tests = 'curl la pantalla' } = {}) {
  const ws = carpeta();
  const back = repoNuevo(ws, 'Back');
  const esp = repoNuevo(ws, 'Historias');
  const ahora = Math.floor(Date.now() / 1000) - 3600;
  escribir(back, 'src/Feature.cs', '// v1\n');
  escribir(back, PRUEBA, '// p1\n');
  commit(back, 'base', ahora - 1000);
  escribir(esp, '.tycon/advisors.yaml', 'evidence:\n  companion_repos:\n    - ../Back\n');
  const cuerpo = (n, tit) => ['---', `story: ${n}`, 'status: in-progress', 'files_to_modify:', ...declarados.map((d) => `  - ${d}`), '---', '',
    '## Acceptance Criteria', '', `1. **Given** ${tit}, **When** pasa, **Then** resultado.`, '', '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', `| E1 | \`${tests}\` | 1 | e2e | x | y |`, ''].join('\n');
  const storyPath = escribir(esp, 'specs/stories/5-28-carga.md', cuerpo('5.28', 'algo'));
  escribir(esp, 'specs/stories/5-29-otra.md', cuerpo('5.29', 'otra cosa'));
  commit(esp, 'historias', ahora - 900);
  const dod = path.join(esp, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const gatesLog = path.join(ws, 'gates.log');
  const humo = (ts) => {
    ledgerLine.append({ dodDir: dod, gatesLog, story: '5.28', acs: [1], ts: new Date(ts * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), cmd: 'curl -s http://localhost:5000/pantalla', mirror: true });
    commit(esp, 'evidencia', ts + 5);
  };
  const calcular = (extra = {}) => rm.compute({ storyPath, gatesLogPath: gatesLog, testsResults: [], ...extra });
  return { ws, back, esp, dod, ahora, storyPath, gatesLog, humo, calcular };
}
const huellaDeCarpeta = (dir) => fs.readdirSync(dir).sort().map((n) => `${n}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')}`).join('\n');

test('T3 Matriz_FusionPropia_RuntimeAntesYDespues_SinTocarEvidencia @story-8.192 @ac-3', () => {
  const f = labMatriz();
  rama(f.back, 'feature/5-28-carga');
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'codigo', f.ahora - 100);
  f.humo(f.ahora - 50);
  const huella = huellaDeCarpeta(f.dod);
  assert.equal(f.calcular().perAc[1].verdict, 'RUNTIME');
  irA(f.back, 'main');
  fusionar(f.back, 'feature/5-28-carga', f.ahora + 60);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'RUNTIME', JSON.stringify(r.warnings));
  assert.equal(huellaDeCarpeta(f.dod), huella, 'la evidencia no se toca');
});

test('T4 Fusion_EvidenciaGuardadaDespues_UsaLaHoraDeLaCorrida @story-8.192 @ac-4', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  // corrió antes de ese commit, y se guardó después
  const ev = l.evidencia(T0 + 150, T0 + 50);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

// ---------------------------------------------------------------- lo que cuida --first-parent sigue cuidado

test('T5 Fusion_CommitAjenoViejoQueEntraDespues_NoCuenta @story-8.192 @ac-5', () => {
  const l = lab();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, 'src/Feature.cs', '// ajeno\n');
  commit(l.back, 'ajeno', T0 + 50);
  irA(l.back, 'main');
  const ev = l.evidencia();
  const fus = fusionar(l.back, 'feature/5-29-otra', T0 + 200);
  const r = juzgar(l.archivo, ev);
  assert.equal(r.cuenta, false, JSON.stringify(r));
  assert.equal(r.commit, fus);
});

test('T6 Fusion_PropiaYDespuesAjena_NoCuenta @story-8.192 @ac-6', () => {
  const l = lab();
  const ev = codigoEvidenciaFusion(l);
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, 'src/Feature.cs', '// ajeno\n');
  commit(l.back, 'ajeno', T0 + 300);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 400);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

test('T7 Fusion_RamaPropiaCambiaDespues_NoCuenta @story-8.192 @ac-7', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ev = l.evidencia();
  escribir(l.back, 'src/Feature.cs', '// v3\n');
  commit(l.back, 'arreglo', T0 + 150);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

test('T8 Fusion_RamaPropiaTraeMainConCambio_NoCuenta @story-8.192 @ac-8', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'otro2.txt', 'y');
  commit(l.back, 'otra parte', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'main');
  escribir(l.back, 'src/Feature.cs', '// ajeno\n');
  commit(l.back, 'ajeno', T0 + 130);
  irA(l.back, 'feature/5-28-carga');
  git(l.back, ['merge', '-q', '--no-ff', '-m', 'Merge main into feature', 'main'], T0 + 140);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

test('T9 Fusion_ResolucionDistinta_NoCuenta @story-8.192 @ac-9', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'main');
  escribir(l.back, 'src/Feature.cs', '// ajeno\n');
  commit(l.back, 'ajeno', T0 + 50);
  assert.throws(() => git(l.back, ['merge', '-q', '--no-ff', '-m', 'x', 'feature/5-28-carga']), 'el laboratorio necesita un conflicto');
  escribir(l.back, 'src/Feature.cs', '// mezcla\n');
  commit(l.back, asuntoDe('feature/5-28-carga'), T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

test('T10 Rama_NumeroParecido_NoEsLaHistoria @story-8.192 @ac-10', () => {
  const { historiaDeLaRama } = commitStory();
  for (const r of ['feature/5-280-x', 'feature/15-28-x', 'feature/5-28-1-x']) {
    assert.equal(historiaDeLaRama(r, { propia: CATALOGO[0], catalogo: CATALOGO }), null, r);
  }
  assert.equal(historiaDeLaRama('feature/5-28-x', { propia: CATALOGO[0], catalogo: CATALOGO }), 'propia');
  assert.deepEqual(historiaDeLaRama('feature/5-29-x', { propia: CATALOGO[0], catalogo: CATALOGO }), { numero: '5.29' });
});

const REPETIDO = [{ numero: '6.1', archivo: '/h/fondos/6-1-fondos-inversion.md' }, { numero: '6.1', archivo: '/h/tablero/6-1-comparacion-periodo.md' }];

function casoRepetido(nombreDeRama) {
  const l = lab();
  rama(l.back, nombreDeRama);
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'main');
  fusionar(l.back, nombreDeRama, T0 + 200);
  return juzgar(l.archivo, ev, { historia: { numero: '6.1', archivo: REPETIDO[0].archivo, catalogo: () => REPETIDO } });
}

test('T11 Rama_NumeroRepetido_PalabrasDeOtroTema_NoCuenta @story-8.192 @ac-11', () => {
  assert.equal(casoRepetido('feature/6-1-comparacion-periodo').cuenta, false);
});

test('T12 Rama_NumeroRepetido_PalabrasPropias_Cuenta @story-8.192 @ac-12', () => {
  assert.equal(casoRepetido('feature/6-1-fondos-inversion').cuenta, true);
  assert.equal(casoRepetido('feature/6-1-fondos').cuenta, true, 'las palabras de la rama son el principio de las del archivo');
});

test('T13 Rama_NumeroRepetido_NumeroSolo_NoSeSabe @story-8.192 @ac-13', () => {
  const { historiaDeLaRama } = commitStory();
  assert.equal(historiaDeLaRama('feature/6-1', { propia: REPETIDO[0], catalogo: REPETIDO }), null);
  // una palabra que empieza igual no alcanza: son palabras enteras
  assert.equal(historiaDeLaRama('feature/6-1-fon', { propia: REPETIDO[0], catalogo: REPETIDO }), null);
});

test('T14 Fusion_SinAsuntoDePlataforma_NoCuenta @story-8.192 @ac-14', () => {
  for (const asunto of ['Merged PR 12: Story 5.28', "Merge branch 'feature/5-28-carga'"]) {
    const l = lab();
    const ev = codigoEvidenciaFusion(l);
    fusionar(l.back, 'feature/5-28-carga', T0 + 200, asunto);
    assert.equal(juzgar(l.archivo, ev).cuenta, false, asunto);
  }
});

// ---------------------------------------------------------------- squash

test('T15 Squash_PropioSinAncla_NoCuenta_YDicePorQue @story-8.192 @ac-15', () => {
  const l = lab();
  const ev = codigoEvidenciaFusion(l);
  juntar(l.back, 'feature/5-28-carga', T0 + 200);
  const r = juzgar(l.archivo, ev);
  assert.equal(r.cuenta, false);
  assert.match(juezLib.motivoEnPalabras(r), /squash/);
  assert.match(juezLib.motivoEnPalabras(r), /repetir la prueba/);
});

test('T16 Squash_Ajeno_SinAncla_NoCuenta @story-8.192 @ac-16', () => {
  const l = lab();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, 'src/Feature.cs', '// ajeno\n');
  commit(l.back, 'ajeno', T0 + 50);
  irA(l.back, 'main');
  const ev = l.evidencia();
  juntar(l.back, 'feature/5-29-otra', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

// ---------------------------------------------------------------- las pruebas

/** Cambia un archivo de prueba después de la evidencia, por la rama que se pida. Devuelve la vigencia de ese archivo. */
function pruebaCambiadaPor(nombreDeRama, { rel = PRUEBA, modo = 'merge' } = {}) {
  const l = lab();
  const abs = escribir(l.back, rel, '// antes\n');
  commit(l.back, 'el archivo', T0 + 10);
  const ev = l.evidencia();
  if (modo === 'direct') {
    escribir(l.back, rel, '// despues\n');
    commit(l.back, 'prueba', T0 + 150);
  } else {
    rama(l.back, nombreDeRama);
    escribir(l.back, rel, '// despues\n');
    commit(l.back, 'prueba', T0 + 150);
    irA(l.back, 'main');
    if (modo === 'squash') juntar(l.back, nombreDeRama, T0 + 200);
    else fusionar(l.back, nombreDeRama, T0 + 200);
  }
  return juzgar(abs, ev);
}

test('T24 Prueba_OtraHistoria_Cuenta_YAvisa @story-8.192 @ac-24', () => {
  const f = labMatriz({ declarados: ['Back/src/Feature.cs', `Back/${PRUEBA}`] });
  f.humo(f.ahora - 50);
  rama(f.back, 'feature/5-29-otra');
  escribir(f.back, PRUEBA, '// otra historia\n');
  const c = commit(f.back, 'prueba', f.ahora + 10);
  irA(f.back, 'main');
  fusionar(f.back, 'feature/5-29-otra', f.ahora + 60);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'RUNTIME', JSON.stringify(r.warnings));
  const aviso = r.warnings.find((w) => w.includes(`Back/${PRUEBA}`));
  assert.ok(aviso, JSON.stringify(r.warnings));
  assert.ok(aviso.includes(c) && aviso.includes('5.29'), aviso);
});

test('T25 Prueba_MismaHistoria_NoCuenta @story-8.192 @ac-25', () => {
  const r = pruebaCambiadaPor('feature/5-28-arreglo');
  assert.equal(r.cuenta, false, JSON.stringify(r));
});

test('T26 PruebaYCodigo_OtraHistoria_RojoPorElCodigo @story-8.192 @ac-26', () => {
  const f = labMatriz({ declarados: ['Back/src/Feature.cs', `Back/${PRUEBA}`] });
  f.humo(f.ahora - 50);
  rama(f.back, 'feature/5-29-otra');
  escribir(f.back, PRUEBA, '// otra historia\n');
  escribir(f.back, 'src/Feature.cs', '// codigo de otra historia\n');
  commit(f.back, 'las dos cosas', f.ahora + 10);
  irA(f.back, 'main');
  fusionar(f.back, 'feature/5-29-otra', f.ahora + 60);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN');
  assert.ok(r.warnings.some((w) => w.includes('Back/src/Feature.cs') && /no cuenta/i.test(w)), JSON.stringify(r.warnings));
});

test('T27 Prueba_SinHistoriaSegura_NoCuenta @story-8.192 @ac-27', () => {
  assert.equal(pruebaCambiadaPor('fix/arreglo-pruebas').cuenta, false, 'rama sin historia');
  assert.equal(pruebaCambiadaPor(null, { modo: 'direct' }).cuenta, false, 'commit directo');
  assert.equal(pruebaCambiadaPor('feature/5-29-otra', { modo: 'squash' }).cuenta, false, 'squash');
  assert.equal(pruebaCambiadaPor('feature/5-29-y-5-28').cuenta, false, 'rama con dos historias');
});

test('T28 Prueba_DosCambios_UnoPropio_NoCuenta @story-8.192 @ac-28', () => {
  const l = lab();
  const ev = l.evidencia();
  for (const [r, n] of [['feature/5-29-otra', 1], ['feature/5-28-arreglo', 2]]) {
    rama(l.back, r);
    escribir(l.back, PRUEBA, `// cambio ${n}\n`);
    commit(l.back, 'prueba', T0 + 100 + n * 100);
    irA(l.back, 'main');
    fusionar(l.back, r, T0 + 150 + n * 100);
  }
  assert.equal(juzgar(l.prueba, ev).cuenta, false);
});

test('T29 Prueba_SoloResolucionDeConflicto_NoCuenta @story-8.192 @ac-29', () => {
  const l = lab();
  const ev = l.evidencia();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, 'otro.txt', 'x');
  commit(l.back, 'no toca la prueba', T0 + 150);
  irA(l.back, 'main');
  git(l.back, ['merge', '-q', '--no-ff', '--no-commit', 'feature/5-29-otra']);
  escribir(l.back, PRUEBA, '// cambiada adentro de la fusión\n');
  commit(l.back, asuntoDe('feature/5-29-otra'), T0 + 200);
  assert.equal(juzgar(l.prueba, ev).cuenta, false);
});

test('T30 Prueba_SinCommitear_NoCuenta @story-8.192 @ac-30', () => {
  const l = lab();
  const ev = l.evidencia();
  escribir(l.back, PRUEBA, '// sin commitear\n');
  const r = juzgar(l.prueba, ev);
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'sin-commitear');
});

test('T31 Prueba_MismoRepo_OtraHistoria_Cuenta @story-8.192 @ac-31', () => {
  const repo = repoNuevo(carpeta(), 'Proj');
  const prueba = escribir(repo, PRUEBA, '// p1\n');
  commit(repo, 'base', T0);
  const ruta = escribir(repo, '.advisors/dod-runtime/5.28-e2e-gate-20270101T000000Z.md', 'verdict=PASS\n');
  commit(repo, 'evidencia', EVIDENCIA);
  rama(repo, 'feature/5-29-otra');
  escribir(repo, PRUEBA, '// otra historia\n');
  commit(repo, 'prueba', T0 + 150);
  irA(repo, 'main');
  fusionar(repo, 'feature/5-29-otra', T0 + 200);
  const r = juzgar(prueba, { ruta, tsMs: EVIDENCIA * 1000 });
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.regla, 6);
});

test('T32 NoEsPrueba_DatoYGuiones_NoCuenta @story-8.192 @ac-32', () => {
  for (const rel of ['tests/x/init-db.sql', 'tests/smoke.sh', 'scripts/capturar.mjs']) {
    assert.equal(pruebaCambiadaPor('feature/5-29-otra', { rel }).cuenta, false, rel);
  }
});

test('T33 Criterio_MideDesdeLaRaizDelRepo @story-8.192 @ac-33', () => {
  const dentro = path.join(carpeta(), 'tests');
  fs.mkdirSync(dentro);
  const l = lab(dentro);
  const ev = l.evidencia();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, 'src/Feature.cs', '// otra historia\n');
  commit(l.back, 'codigo', T0 + 150);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false);
});

test('T34 Criterio_SaleDeIsTestPath @story-8.192 @ac-34', () => {
  const fuente = fs.readFileSync(path.join(SCRIPTS, 'lib', 'evidence-vs-commit.js'), 'utf8');
  assert.match(fuente, /isTestPath/);
  for (const f of ['evidence-vs-commit.js', 'commit-story.js']) {
    const t = fs.readFileSync(path.join(SCRIPTS, 'lib', f), 'utf8');
    assert.doesNotMatch(t, /__tests__|\.spec\\?\.|Tests\?\\?\.cs/, `${f} no trae otra lista de nombres de prueba`);
  }
});

test('T35 Asunto_GitHubYAzure_LeeLaRama @story-8.192 @ac-1 @ac-14', () => {
  const { ramaDelAsunto } = commitStory();
  assert.equal(ramaDelAsunto('Merge pull request 5662 from feature/5-28-carga into dev'), 'feature/5-28-carga');
  assert.equal(ramaDelAsunto('Merge pull request #944 from TYCON-SA/story/8.181-los-cambios'), 'story/8.181-los-cambios');
  assert.equal(ramaDelAsunto('Merge pull request #7 from mi-fork:rama-1'), null);
  for (const otro of ['Merged PR 5044: TC-1: retomar', "Merge branch 'feature/5-28-carga'", 'Merge remote-tracking branch \'origin/main\' into dev', 'feat: Merge pull request 5 from x']) {
    assert.equal(ramaDelAsunto(otro), null, otro);
  }
});

// ---------------------------------------------------------------- lo que estaba bien sigue igual

test('T36 Suite8186_SigueVerde @story-8.192 @ac-35', () => {
  // sin la marca del corredor de pruebas: con ella, el proceso hijo se daría por corrido sin correr nada
  const env = entornoGit();
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'evidence-vs-commit.test.js')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
  assert.match(r.stdout, /pass [1-9]/, 'la suite corrió');
});

test('T37 Matriz_CodeMtimeYSuite_SinCambios @story-8.192 @ac-36', () => {
  const f = labMatriz({ declarados: [`Back/${PRUEBA}`] });
  f.humo(f.ahora - 50);
  rama(f.back, 'feature/5-29-otra');
  const abs = escribir(f.back, PRUEBA, '// otra historia\n');
  commit(f.back, 'prueba', f.ahora + 10);
  irA(f.back, 'main');
  fusionar(f.back, 'feature/5-29-otra', f.ahora + 60);
  const suite = path.join(f.ws, 'tests-result.json');
  fs.writeFileSync(suite, JSON.stringify({ ts: new Date((f.ahora - 500) * 1000).toISOString(), suite_green: true, story_id: '5.28' }));
  const r = f.calcular({ testsResults: [suite] });
  assert.equal(r.perAc[1].verdict, 'RUNTIME', JSON.stringify(r.warnings));
  assert.equal(r.codeMtime, fs.statSync(abs).mtimeMs);
  assert.ok(r.warnings.some((w) => /tests-result \(\w+\) es anterior al último edit de código/.test(w)), JSON.stringify(r.warnings));
});

function juezQueNoContesta(preguntasNuevas) {
  return (carpetaDeGit, args, env) => (preguntasNuevas(args) ? { codigo: null, salida: '' } : juezLib.correrGitDeVerdad(carpetaDeGit, args, env));
}

test('T38 Vigencia_GitSinRespuesta_NoCuenta @story-8.192 @ac-43', () => {
  const nuevas = [(a) => a.includes('--merges'), (a) => a[0] === 'rev-list'];
  for (const n of nuevas) {
    const l = lab();
    const ev = codigoEvidenciaFusion(l);
    fusionar(l.back, 'feature/5-28-carga', T0 + 200);
    assert.equal(juzgar(l.archivo, ev, { correrGit: juezQueNoContesta(n) }).cuenta, false);
  }
  for (const n of [(a) => a.includes('--no-merges'), (a) => a.includes('--ancestry-path'), (a) => a.includes('--full-name')]) {
    const l = lab();
    const ev = l.evidencia();
    rama(l.back, 'feature/5-29-otra');
    escribir(l.back, PRUEBA, '// otra historia\n');
    commit(l.back, 'prueba', T0 + 150);
    irA(l.back, 'main');
    fusionar(l.back, 'feature/5-29-otra', T0 + 200);
    assert.equal(juzgar(l.prueba, ev, { correrGit: juezQueNoContesta(n) }).cuenta, false);
  }
  const l = lab();
  const ev = l.evidencia();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, PRUEBA, '// otra historia\n');
  commit(l.back, 'prueba', T0 + 150);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 200);
  const sinCatalogo = juzgar(l.prueba, ev, { historia: historia({ catalogo: () => null }) });
  assert.equal(sinCatalogo.cuenta, false, 'sin catálogo, tampoco');
});

test('T39 Vigencia_HermanoCortado_NoCuenta @story-8.192 @ac-43', () => {
  const l = lab();
  const ev = codigoEvidenciaFusion(l);
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  const cortado = path.join(path.dirname(l.back), 'Cortado');
  git(path.dirname(l.back), ['clone', '-q', '--depth', '1', `file://${l.back}`, cortado]);
  const r = juzgar(path.join(cortado, 'src/Feature.cs'), ev);
  assert.equal(r.cuenta, false);
  assert.equal(r.motivo, 'sin-respuesta');
});

// ---------------------------------------------------------------- lo que la matriz dice, y los casos cruzados

test('T41 Matriz_ManeraTres_AvisaElSupuesto @story-8.192 @ac-40', () => {
  const f = labMatriz();
  rama(f.back, 'feature/5-28-carga');
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'codigo', f.ahora - 100);
  f.humo(f.ahora - 50);
  irA(f.back, 'main');
  const fus = fusionar(f.back, 'feature/5-28-carga', f.ahora + 60);
  const r = f.calcular();
  const aviso = r.warnings.find((w) => w.includes('Back/src/Feature.cs') && w.includes(fus));
  assert.ok(aviso, JSON.stringify(r.warnings));
  assert.match(aviso, /se supone que la evidencia corrió sobre esa rama/);
  assert.ok(rm.renderMd(r).includes(fus), 'también en el archivo de la matriz');
});

test('T42 Prueba_AyudanteDeCarpetaDePruebas_OtraHistoria_Cuenta @story-8.192 @ac-41', () => {
  const r = pruebaCambiadaPor('feature/5-29-otra', { rel: 'tests/App.Tests/TestHelpers/MockFactory.cs' });
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.regla, 6);
  assert.equal(r.historia, '5.29');
});

test('T43 Prueba_FusionPropiaYDespuesOtraHistoria_Cuenta @story-8.192 @ac-42', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, PRUEBA, '// propia\n');
  commit(l.back, 'prueba propia', T0 + 100);
  const ev = l.evidencia();
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, PRUEBA, '// ajena\n');
  commit(l.back, 'prueba ajena', T0 + 300);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 400);
  const r = juzgar(l.prueba, ev);
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.regla, 6);
});

// ---------------------------------------------------------------- evidencia nueva: el ancla

const SMOKE = path.join(SCRIPTS, 'smoke-run.sh');
const GATE = path.join(SCRIPTS, 'e2e-gate.sh');
const conAncla = (ev, ancla) => ({ ...ev, ancla });

/** Un humo de verdad, por `smoke-run.sh`, con una carpeta personal propia para el espejo. Devuelve la línea del registro. */
function humoReal(f, story, acs = '1') {
  const home = path.join(f.ws, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dod = path.join(f.esp, '.advisors', 'dod-runtime');
  const r = spawnSync('bash', [SMOKE, dod, story, '--acs', acs, '--pass-if', 'contesta', '--', 'node', '-e', 'console.log("contesta")'],
    { cwd: f.esp, encoding: 'utf8', env: { ...entornoGit(), HOME: home } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lineas = fs.readFileSync(path.join(dod, '5.28-smoke-ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
  return { linea: JSON.parse(lineas[lineas.length - 1]), gates: path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), salida: `${r.stdout}\n${r.stderr}` };
}

test('T17 Humo_AnotaElAncla_RegistroYEspejo @story-8.192 @ac-17', () => {
  for (const conRuta of [false, true]) {
    const f = labMatriz();
    const commitLimpio = git(f.back, ['rev-parse', 'HEAD']);
    const h = humoReal(f, conRuta ? f.storyPath : '5.28');
    const [ancla] = h.linea.target.hermanos;
    assert.deepEqual(ancla, { repo: 'Back', commit: commitLimpio }, JSON.stringify(h.linea.target));
    assert.ok(fs.readFileSync(h.gates, 'utf8').includes(`"hermanos":[{"repo":"Back","commit":"${commitLimpio}"}]`), 'también en el espejo');
    escribir(f.back, 'src/Feature.cs', '// sin commitear\n');
    const blob = git(f.back, ['hash-object', 'src/Feature.cs']);
    const sucio = humoReal(f, conRuta ? f.storyPath : '5.28').linea.target.hermanos[0];
    assert.deepEqual(sucio, { repo: 'Back', commit: commitLimpio, huellas: { 'src/Feature.cs': blob } });
  }
});

/** El gate de verdad, sin navegador: un `npx` falso y el repo de la historia con su hermano declarado. */
function gateReal(f) {
  const home = path.join(f.ws, 'home');
  const bin = path.join(f.ws, 'bin');
  const front = path.join(f.ws, 'front');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(front, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho \'{}\'\n', { mode: 0o755 });
  const dod = path.join(f.esp, '.advisors', 'dod-runtime');
  spawnSync('bash', [GATE, front, '5.28', dod, 'story.spec.ts'], { cwd: f.esp, encoding: 'utf8', env: { ...entornoGit(), HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const archivo = fs.readdirSync(dod).find((n) => /^5\.28-e2e-gate-.*\.md$/.test(n));
  return { md: fs.readFileSync(path.join(dod, archivo), 'utf8'), ts: archivo.match(/gate-(.*)\.md$/)[1], espejo: fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8') };
}

test('T18 Gate_AnotaElAncla_GateYEspejo @story-8.192 @ac-18', () => {
  const f = labMatriz();
  const commitLimpio = git(f.back, ['rev-parse', 'HEAD']);
  const g = gateReal(f);
  const esperado = JSON.stringify([{ repo: 'Back', commit: commitLimpio }]);
  assert.ok(g.md.includes(`- hermanos: ${esperado}`), g.md.slice(0, 600));
  const linea = g.espejo.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === 'e2e-gate-anchor');
  assert.ok(linea, g.espejo);
  assert.equal(linea.ts, g.ts);
  assert.equal(linea.story, '5.28');
  assert.equal(JSON.stringify(linea.hermanos), esperado);
});

test('T19 Ancla_SquashPropio_Cuenta @story-8.192 @ac-19', () => {
  const l = lab();
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'src/Feature.cs', '// v2\n');
  commit(l.back, 'codigo', T0 + 100);
  const ancla = [{ repo: 'Back', commit: git(l.back, ['rev-parse', 'HEAD']) }];
  const ev = l.evidencia();
  irA(l.back, 'main');
  juntar(l.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(l.archivo, ev).cuenta, false, 'sin ancla, no');
  const r = juzgar(l.archivo, conAncla(ev, ancla));
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.via, 'ancla');
});

test('T20 Ancla_ArchivoDistinto_NoCuenta @story-8.192 @ac-20', () => {
  for (const camino of ['direct', 'merge', 'squash']) {
    const l = lab();
    const ancla = [{ repo: 'Back', commit: git(l.back, ['rev-parse', 'HEAD']) }];
    const ev = l.evidencia();
    if (camino === 'direct') {
      escribir(l.back, 'src/Feature.cs', '// ajeno\n');
      commit(l.back, 'ajeno', T0 + 50);
    } else {
      rama(l.back, 'feature/5-29-otra');
      escribir(l.back, 'src/Feature.cs', '// ajeno\n');
      commit(l.back, 'ajeno', T0 + 50);
      irA(l.back, 'main');
      if (camino === 'merge') fusionar(l.back, 'feature/5-29-otra', T0 + 60);
      else juntar(l.back, 'feature/5-29-otra', T0 + 60);
    }
    // con la hora anterior a la evidencia: la línea principal diría que cuenta, y el ancla manda
    assert.equal(juzgar(l.archivo, conAncla(ev, ancla)).cuenta, false, camino);
  }
});

test('T21 Ancla_CommitAusente_SigueConLasOtras_NoCuenta @story-8.192 @ac-21', () => {
  const ausente = [{ repo: 'Back', commit: 'a'.repeat(40) }];
  const l = lab();
  const ev = codigoEvidenciaFusion(l);
  juntar(l.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(l.archivo, conAncla(ev, ausente)).cuenta, false, 'ninguna otra manera da verde');
  const m = lab();
  const evm = codigoEvidenciaFusion(m);
  fusionar(m.back, 'feature/5-28-carga', T0 + 200);
  assert.equal(juzgar(m.archivo, conAncla(evm, ausente)).cuenta, true, 'la rama propia sí da verde');
});

/** Historia con código en una rama, humo real con ancla, y squash: con el ancla del espejo, la evidencia cuenta. */
function squashConHumoReal() {
  const f = labMatriz();
  rama(f.back, 'feature/5-28-carga');
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'codigo', f.ahora - 100);
  humoReal(f, '5.28');
  const dod = path.join(f.esp, '.advisors', 'dod-runtime');
  const led = path.join(dod, '5.28-smoke-ledger.jsonl');
  const gates = path.join(f.ws, 'home', '.claude', '.tycon-pipeline', 'gates.log');
  irA(f.back, 'main');
  juntar(f.back, 'feature/5-28-carga', Math.floor(Date.now() / 1000) + 3600);
  return { f, led, gates };
}

test('T22 Ancla_EditadaEnElRegistro_NoSeUsa @story-8.192 @ac-22', () => {
  const bien = squashConHumoReal();
  commit(bien.f.esp, 'evidencia', Math.floor(Date.now() / 1000));
  assert.equal(bien.f.calcular({ gatesLogPath: bien.gates }).perAc[1].verdict, 'RUNTIME', 'con el ancla del espejo cuenta');

  const mal = squashConHumoReal();
  const otro = git(mal.f.back, ['rev-parse', 'HEAD']);
  const editada = fs.readFileSync(mal.led, 'utf8').replace(/"commit":"[0-9a-f]{40}"(?=[,}]*\]|\})/, `"commit":"${otro}"`);
  const conOtra = editada.replace(/("hermanos":\[\{"repo":"Back","commit":")[0-9a-f]{40}/, `$1${otro}`);
  assert.notEqual(conOtra, fs.readFileSync(mal.led, 'utf8'), 'el laboratorio editó el ancla');
  fs.writeFileSync(mal.led, conOtra);
  commit(mal.f.esp, 'evidencia', Math.floor(Date.now() / 1000));
  assert.equal(mal.f.calcular({ gatesLogPath: mal.gates }).perAc[1].verdict, 'NOT-RUN');
});

test('T23 SinAncla_SeLeeComoHoy @story-8.192 @ac-23', () => {
  const f = labMatriz();
  rama(f.back, 'feature/5-28-carga');
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'codigo', f.ahora - 100);
  f.humo(f.ahora - 50);
  assert.equal(f.calcular().perAc[1].verdict, 'RUNTIME');
  irA(f.back, 'main');
  juntar(f.back, 'feature/5-28-carga', f.ahora + 60);
  assert.equal(f.calcular().perAc[1].verdict, 'NOT-RUN');
});

test('T40 Ancla_EditadaEnElGate_NoSeUsa @story-8.192 @ac-22', () => {
  const caso = ({ editar, sinEspejo }) => {
    const f = labMatriz({ tests: 'story-5-28.spec.ts::flujo' });
    rama(f.back, 'feature/5-28-carga');
    escribir(f.back, 'src/Feature.cs', '// v2\n');
    commit(f.back, 'codigo', f.ahora - 100);
    const delAncla = git(f.back, ['rev-parse', 'HEAD']);
    const hermanos = JSON.stringify([{ repo: 'Back', commit: delAncla }]);
    const ms = (f.ahora - 50) * 1000;
    const ts = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    irA(f.back, 'main');
    juntar(f.back, 'feature/5-28-carga', f.ahora + 60);
    const enElGate = editar ? JSON.stringify([{ repo: 'Back', commit: git(f.back, ['rev-parse', 'HEAD']) }]) : hermanos;
    fs.writeFileSync(path.join(f.dod, `5.28-e2e-gate-${ts}.md`),
      ['# Gate', '**Spec filter**: story-5-28.spec.ts', '```', 'verdict=PASS', '```', '- skipped: 0', `- hermanos: ${enElGate}`, ''].join('\n'));
    fs.appendFileSync(f.gatesLog, `${JSON.stringify({ ts: new Date(ms).toISOString(), check: 'dod', status: 'green', provenance: 'run-check', cmd: 'bash e2e-gate.sh /fe 5.28 /dir story-5-28.spec.ts', exit: 0 })}\n`);
    if (!sinEspejo) fs.appendFileSync(f.gatesLog, `{"type":"e2e-gate-anchor","ts":"${ts}","story":"5.28","hermanos":${hermanos}}\n`);
    commit(f.esp, 'evidencia', f.ahora - 45);
    return f.calcular().perAc[1].verdict;
  };
  assert.equal(caso({}), 'RUNTIME');
  assert.equal(caso({ editar: true }), 'NOT-RUN', 'el gate dice otra cosa que el espejo');
  assert.equal(caso({ sinEspejo: true }), 'NOT-RUN', 'sin su línea en el espejo');
});

test('T44 Ancla_CodigoSinCommitear_ComparaLaHuella @story-8.192 @ac-44', () => {
  const ahora = (contenido) => {
    const l = lab();
    const base = git(l.back, ['rev-parse', 'HEAD']);
    escribir(l.back, 'src/Feature.cs', '// probado\n');
    const huella = git(l.back, ['hash-object', 'src/Feature.cs']);
    const ev = l.evidencia();
    escribir(l.back, 'src/Feature.cs', contenido);
    commit(l.back, 'codigo', T0 + 300);
    return juzgar(l.archivo, conAncla(ev, [{ repo: 'Back', commit: base, huellas: { 'src/Feature.cs': huella } }])).cuenta;
  };
  assert.equal(ahora('// probado\n'), true, 'igual a la huella');
  assert.equal(ahora('// otra cosa\n'), false, 'distinto de la huella');
});

test('T45 Ancla_MasDeCincuentaArchivosSinCommitear_SinAncla @story-8.192 @ac-45', () => {
  const f = labMatriz();
  for (let i = 0; i < 51; i += 1) escribir(f.back, `gen/a${i}.js`, '// generado\n');
  const h = humoReal(f, '5.28');
  const [ancla] = h.linea.target.hermanos;
  assert.equal(ancla.repo, 'Back');
  assert.equal(ancla.commit, undefined);
  assert.equal(ancla.huellas, undefined);
  assert.ok(ancla.sinAncla);
  assert.match(h.salida, /sin ancla/);
  assert.ok(JSON.stringify(h.linea).length < 2000, 'la línea sigue siendo chica');
});

// ---------------------------------------------------------------- lo que encontró el pase adversarial

test('T46 Prueba_SinHistoria_YDespuesFusionAjenaQueNoLaToca_NoCuenta @story-8.192 @ac-27 @ac-25', () => {
  const ajenaDespues = (l) => {
    rama(l.back, 'feature/5-29-otra');
    escribir(l.back, 'otro.txt', 'x');
    commit(l.back, 'no toca la prueba', T0 + 300);
    irA(l.back, 'main');
    fusionar(l.back, 'feature/5-29-otra', T0 + 400);
  };
  const casos = {
    directo: (l) => { escribir(l.back, PRUEBA, '// directo\n'); commit(l.back, 'prueba', T0 + 150); },
    squashPropio: (l) => {
      rama(l.back, 'feature/5-28-arreglo');
      escribir(l.back, PRUEBA, '// propia\n');
      commit(l.back, 'prueba', T0 + 150);
      irA(l.back, 'main');
      juntar(l.back, 'feature/5-28-arreglo', T0 + 200, 'Merged PR 3: arreglo');
    },
    mergedPr: (l) => {
      rama(l.back, 'feature/5-28-arreglo');
      escribir(l.back, PRUEBA, '// propia\n');
      commit(l.back, 'prueba', T0 + 150);
      irA(l.back, 'main');
      fusionar(l.back, 'feature/5-28-arreglo', T0 + 200, 'Merged PR 3: arreglo de 5.28');
    },
  };
  for (const [nombre, cambiar] of Object.entries(casos)) {
    const l = lab();
    const ev = l.evidencia();
    cambiar(l);
    ajenaDespues(l);
    assert.equal(juzgar(l.prueba, ev).cuenta, false, nombre);
  }
});

test('T47 Prueba_LaFusionPropiaLaReescribe_NoCuenta @story-8.192 @ac-29', () => {
  const l = lab();
  const ev = l.evidencia();
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, PRUEBA, '// otra historia\n');
  commit(l.back, 'prueba', T0 + 150);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 200);
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, 'otro.txt', 'x');
  commit(l.back, 'otra cosa', T0 + 250);
  irA(l.back, 'main');
  git(l.back, ['merge', '-q', '--no-ff', '--no-commit', 'feature/5-28-carga']);
  escribir(l.back, PRUEBA, '// reescrita en la fusión propia\n');
  commit(l.back, asuntoDe('feature/5-28-carga'), T0 + 300);
  assert.equal(juzgar(l.prueba, ev).cuenta, false);
});

test('T48 Rama_PropiaFueraDelCatalogo_NoSeSabe @story-8.192 @ac-13', () => {
  const { historiaDeLaRama } = commitStory();
  const otroTema = [{ numero: '5.28', archivo: '/h/otro-tema/5-28-otra-cosa.md' }];
  assert.equal(historiaDeLaRama('feature/5-28-carga', { propia: CATALOGO[0], catalogo: otroTema }), null);
});

test('T49 RutaNoAscii_SeLeeCruda @story-8.192 @ac-24 @ac-44', () => {
  const rel = 'tests/App.Tests/SeñalTests.cs';
  const r = pruebaCambiadaPor('feature/5-29-otra', { rel });
  assert.equal(r.cuenta, true, JSON.stringify(r));
  const l = lab();
  const abs = escribir(l.back, rel, '// probado\n');
  const huella = git(l.back, ['hash-object', rel]);
  const base = git(l.back, ['rev-parse', 'HEAD']);
  const ev = l.evidencia();
  commit(l.back, 'la prueba', T0 + 300);
  assert.equal(juzgar(abs, conAncla(ev, [{ repo: 'Back', commit: base, huellas: { [rel]: huella } }])).cuenta, true);
});

test('T50 Ancla_HermanoSubcarpeta_HuellaDelArchivoReal @story-8.192 @ac-17 @ac-44', () => {
  const ws = carpeta();
  const mono = repoNuevo(ws, 'Mono');
  escribir(mono, 'back/src/Feature.cs', '// v1\n');
  escribir(mono, 'front/x.ts', '// x\n');
  commit(mono, 'base', T0);
  const esp = repoNuevo(ws, 'Historias');
  escribir(esp, '.tycon/advisors.yaml', 'evidence:\n  companion_repos:\n    - ../Mono/back\n');
  commit(esp, 'config', T0);
  escribir(mono, 'back/src/Feature.cs', '// sin commitear\n');
  escribir(mono, 'front/x.ts', '// fuera del hermano\n');
  const [ancla] = require(path.join(SCRIPTS, 'lib', 'companion-repos.js')).anclasDeLaEvidencia(esp, '5.28');
  assert.deepEqual(ancla.huellas, { 'back/src/Feature.cs': git(mono, ['hash-object', 'back/src/Feature.cs']) }, JSON.stringify(ancla));
});

test('T51 Ancla_PruebaSinCommitearAlCorrer_OtraHistoriaDespues_Cuenta @story-8.192 @ac-24 @ac-44', () => {
  const l = lab();
  const base = git(l.back, ['rev-parse', 'HEAD']);
  rama(l.back, 'feature/5-28-carga');
  escribir(l.back, PRUEBA, '// la probada\n');
  const huella = git(l.back, ['hash-object', PRUEBA]);
  const ev = l.evidencia();
  commit(l.back, 'guarda lo probado', T0 + 150);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-28-carga', T0 + 200);
  rama(l.back, 'feature/5-29-otra');
  escribir(l.back, PRUEBA, '// otra historia\n');
  commit(l.back, 'prueba', T0 + 300);
  irA(l.back, 'main');
  fusionar(l.back, 'feature/5-29-otra', T0 + 400);
  const r = juzgar(l.prueba, conAncla(ev, [{ repo: 'Back', commit: base, huellas: { [PRUEBA]: huella } }]));
  assert.equal(r.cuenta, true, JSON.stringify(r));
  assert.equal(r.regla, 6);
});

test('T52 Humo_PrimeraVez_AnclaDelRepoDeLaEvidencia @story-8.192 @ac-17', () => {
  const f = labMatriz();
  fs.rmSync(path.join(f.esp, '.advisors'), { recursive: true, force: true });
  const home = path.join(f.ws, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dod = path.join(f.esp, '.advisors', 'dod-runtime');
  const r = spawnSync('bash', [SMOKE, dod, '5.28', '--acs', '1', '--pass-if', 'contesta', '--', 'node', '-e', 'console.log("contesta")'],
    { cwd: f.back, encoding: 'utf8', env: { ...entornoGit(), HOME: home } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const linea = JSON.parse(fs.readFileSync(path.join(dod, '5.28-smoke-ledger.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(linea.target.hermanos[0].repo, 'Back', JSON.stringify(linea.target));
});

test('T53 Matriz_GateSinEspejo_NoAvisaLoQueContó @story-8.192 @ac-40', () => {
  const f = labMatriz({ tests: 'story-5-28.spec.ts::flujo' });
  rama(f.back, 'feature/5-28-carga');
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'codigo', f.ahora - 100);
  const ts = new Date((f.ahora - 50) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(path.join(f.dod, `5.28-e2e-gate-${ts}.md`), ['# Gate', '**Spec filter**: story-5-28.spec.ts', '```', 'verdict=PASS', '```', '- skipped: 0', ''].join('\n'));
  commit(f.esp, 'evidencia', f.ahora - 45);
  irA(f.back, 'main');
  fusionar(f.back, 'feature/5-28-carga', f.ahora + 60);
  const r = f.calcular();
  assert.ok(r.warnings.some((w) => /SIN espejo/.test(w)), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => /sigue contando/.test(w)), JSON.stringify(r.warnings));
});
