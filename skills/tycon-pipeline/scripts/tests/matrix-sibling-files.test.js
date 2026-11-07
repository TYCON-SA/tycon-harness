#!/usr/bin/env node
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. Las fechas de commit que se comparan las fija cada laboratorio.
/**
 * matrix-sibling-files.test.js — la matriz busca cada archivo declarado también en el repo hermano y en su copia de la rama
 * de la historia, juzga cada copia que encuentra, y da rojo cuando un archivo de código declarado no está en ningún lado.
 *
 * Los laboratorios son repos de git de verdad, en una carpeta temporal: uno con las historias y la evidencia, y el hermano.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/matrix-sibling-files.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
const ledgerLine = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const GUIA = path.join(SCRIPTS, '..', '..', '..', 'guides', 'accov-governance-protocol.md');

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const RAMA = 'feature/5-28-carga';

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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msf-')));
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
}
function compacto(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * El repo de historias (con su evidencia) y, si se pide, el hermano `Back`. Las horas, una hora antes de ahora: la fecha
 * de los archivos en disco es la de ahora, así que el juez siempre le pregunta a git.
 */
function lab({ declarados, hermanos = ['../Back'], fePaths = [], estado = 'in-progress', propios = {}, delHermano = { 'src/Feature.cs': '// v1\n' } } = {}) {
  const ws = carpeta();
  const esp = repoNuevo(ws, 'Historias');
  const ahora = Math.floor(Date.now() / 1000) - 3600;
  let back = null;
  if (hermanos.includes('../Back')) {
    back = repoNuevo(ws, 'Back');
    for (const [rel, texto] of Object.entries(delHermano)) escribir(back, rel, texto);
    commit(back, 'base', ahora - 1000);
  }
  const yaml = ['evidence:'];
  if (hermanos.length) yaml.push('  companion_repos:', ...hermanos.map((h) => `    - ${h}`));
  if (fePaths.length) yaml.push('  fe_paths:', ...fePaths.map((p) => `    - ${p}`));
  if (yaml.length > 1) escribir(esp, '.tycon/advisors.yaml', yaml.join('\n') + '\n');
  for (const [rel, texto] of Object.entries(propios)) escribir(esp, rel, texto);
  const cuerpo = ['---', 'story: 5.28', `status: ${estado}`, 'files_to_modify:', ...declarados.map((d) => `  - ${d}`), '---', '',
    '## Acceptance Criteria', '', '1. **Given** algo, **When** pasa, **Then** resultado.', '', '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| E1 | `curl la pantalla` | 1 | e2e | x | y |', ''].join('\n');
  const storyPath = escribir(esp, 'specs/stories/5-28-carga.md', cuerpo);
  commit(esp, 'historias', ahora - 900);
  const dod = path.join(esp, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const gatesLog = path.join(ws, 'gates.log');
  const humo = (ts = ahora - 50) => {
    ledgerLine.append({ dodDir: dod, gatesLog, story: '5.28', acs: [1], ts: new Date(ts * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), cmd: 'curl -s http://localhost:5000/pantalla', mirror: true });
    commit(esp, 'evidencia', ts + 5);
  };
  const gate = (ts = ahora - 40) => {
    const filtro = 'story-5-28.spec.ts';
    escribir(esp, `.advisors/dod-runtime/5.28-e2e-gate-${compacto(ts * 1000)}.md`, ['# gate', `**Spec filter**: ${filtro}`, '```', 'verdict=PASS', 'total=1', 'passed=1', '```', '- skipped: 0', ''].join('\n'));
    fs.appendFileSync(gatesLog, JSON.stringify({ ts: new Date().toISOString(), check: 'dod', status: 'green', provenance: 'run-check', cmd: `bash e2e-gate.sh /fe 5.28 /dir ${filtro}`, exit: 0 }) + '\n');
    commit(esp, 'evidencia del gate', ts + 5);
  };
  const calcular = (extra = {}) => rm.compute({ storyPath, gatesLogPath: gatesLog, testsResults: [], ...extra });
  return { ws, esp, back, ahora, storyPath, humo, gate, calcular };
}
const avisos = (r) => r.warnings.join('\n');

// ---------------------------------------------------------------- dónde busca

test('T1 Hermano_RutaRelativa_CambiadaDespues_NoCuenta @story-8.200 @ac-1', () => {
  const f = lab({ declarados: ['src/Feature.cs'] });
  f.humo();
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'cambio de otra historia', f.ahora + 100);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  assert.match(avisos(r), /src\/Feature\.cs/);
  assert.equal(r.green, false);
});

test('T2 Hermano_RutaRelativa_SinCambios_Cuenta @story-8.200 @ac-2', () => {
  const f = lab({ declarados: ['src/Feature.cs'] });
  f.humo();
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'RUNTIME', avisos(r));
  assert.equal(r.green, true, avisos(r));
});

test('T3 Hermano_WorktreeDeLaRama_SeMira @story-8.200 @ac-3', () => {
  const f = lab({ declarados: ['src/Feature.cs'] });
  git(f.esp, ['checkout', '-q', '-b', RAMA]);
  const copia = path.join(f.ws, 'Back-wt');
  git(f.back, ['worktree', 'add', '-q', '-b', RAMA, copia]);
  f.humo();
  // El cambio sólo en la copia de la rama: el checkout del hermano sigue igual
  escribir(copia, 'src/Feature.cs', '// v2 en la rama\n');
  commit(copia, 'cambio en la rama', f.ahora + 100);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  assert.match(avisos(r), /src\/Feature\.cs/);
});

test('T4 RutaDelRepoYDesdeArriba_ComoHoy @story-8.200 @ac-4', () => {
  // Escrita desde la carpeta de arriba
  const arriba = lab({ declarados: ['Back/src/Feature.cs'] });
  arriba.humo();
  escribir(arriba.back, 'src/Feature.cs', '// v2\n');
  commit(arriba.back, 'cambio', arriba.ahora + 100);
  const r1 = arriba.calcular();
  assert.equal(r1.perAc[1].verdict, 'NOT-RUN', avisos(r1));
  assert.match(avisos(r1), /Back\/src\/Feature\.cs/);
  assert.doesNotMatch(avisos(r1), /no pude leer/);
  // Relativa al repo de la historia
  const propio = lab({ declarados: ['src/Local.cs'], hermanos: [], propios: { 'src/Local.cs': '// v1\n' } });
  propio.humo();
  escribir(propio.esp, 'src/Local.cs', '// v2\n');
  commit(propio.esp, 'cambio', propio.ahora + 100);
  const r2 = propio.calcular();
  assert.equal(r2.perAc[1].verdict, 'NOT-RUN', avisos(r2));
  assert.match(avisos(r2), /src\/Local\.cs/);
  assert.doesNotMatch(avisos(r2), /no pude leer/);
});

test('T5 MismaRutaEnDosLugares_JuzgaTodas @story-8.200 @ac-5', () => {
  // La copia del repo de la historia no cambia; la del hermano sí
  const f = lab({ declarados: ['src/Feature.cs'], propios: { 'src/Feature.cs': '// propio\n' } });
  f.humo();
  escribir(f.back, 'src/Feature.cs', '// v2\n');
  commit(f.back, 'cambio', f.ahora + 100);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  const aviso = r.warnings.find((w) => /Smoke .* no cuenta/.test(w)) || '';
  assert.match(aviso, /src\/Feature\.cs \(en Back\)/, avisos(r));
});

// ---------------------------------------------------------------- lo que no se puede leer

test('T6 RutaQueNoEsta_Rojo @story-8.200 @ac-6', () => {
  const f = lab({ declarados: ['src/NoEsta.cs'], hermanos: [] });
  f.humo();
  const r = f.calcular();
  assert.equal(r.green, false, avisos(r));
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  const aviso = r.warnings.find((w) => /^No pude leer src\/NoEsta\.cs/.test(w));
  assert.ok(aviso, avisos(r));
  assert.ok(aviso.includes(f.esp), `nombra dónde la buscó: ${aviso}`);
  assert.match(aviso, /corregí la ruta en la lista/);
  assert.match(aviso, /si es para crear, crealo o sacalo de la lista/);
  assert.match(aviso, /traelo al día/);
  assert.deepEqual(r.noLeidos.map((n) => n.rel), ['src/NoEsta.cs']);

  // En done, la salida no es editar la lista
  const hecha = lab({ declarados: ['src/NoEsta.cs'], hermanos: [], estado: 'done' });
  hecha.humo();
  const r2 = hecha.calcular();
  assert.equal(r2.green, false);
  const enDone = r2.warnings.find((w) => /^No pude leer src\/NoEsta\.cs/.test(w)) || '';
  assert.match(enDone, /volvé a correr la evidencia/, enDone);
  assert.doesNotMatch(enDone, /corregí la ruta/);
});

test('T7 HermanoInexistente_RutaSoloAhi_Rojo @story-8.200 @ac-7', () => {
  const f = lab({ declarados: ['src/NoEsta.cs'], hermanos: ['../NoExiste'] });
  f.humo();
  const r = f.calcular();
  assert.equal(r.green, false, avisos(r));
  assert.match(avisos(r), /INEXISTENTE/);
  assert.match(avisos(r), /^No pude leer src\/NoEsta\.cs/m);
});

test('T8 ArchivoQueNoEsCodigo_NoEsta_ComoHoy @story-8.200 @ac-8', () => {
  const f = lab({ declarados: ['docs/nota.md'], hermanos: [] });
  f.humo();
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'RUNTIME', avisos(r));
  assert.equal(r.green, true, avisos(r));
  assert.doesNotMatch(avisos(r), /no pude leer/i);
});

test('T9 SinHermanos_TodoPresente_ComoHoy @story-8.200 @ac-9', () => {
  const f = lab({ declarados: ['src/Local.cs'], hermanos: [], propios: { 'src/Local.cs': '// v1\n' } });
  f.humo();
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'RUNTIME', avisos(r));
  assert.equal(r.green, true, avisos(r));
  assert.doesNotMatch(avisos(r), /no pude leer/i);
});

test('T10 RutaNoLeida_AvisosDeGateYHumo_DicenNoPudeLeer @story-8.200 @ac-10', () => {
  const f = lab({ declarados: ['src/NoEsta.cs'], hermanos: [] });
  f.humo();
  f.gate();
  const r = f.calcular();
  const delGate = r.warnings.find((w) => /^Gate E2E /.test(w)) || '';
  const delHumo = r.warnings.find((w) => /^Smoke /.test(w)) || '';
  assert.match(delGate, /no pude leer src\/NoEsta\.cs/, avisos(r));
  assert.match(delHumo, /no pude leer src\/NoEsta\.cs/, avisos(r));
  assert.doesNotMatch(avisos(r), /no se pudo comparar contra git/);
  assert.doesNotMatch(delGate, /ANTERIOR al último edit/);
  assert.doesNotMatch(delHumo, /anterior al último edit/);
});

test('T11 FechaPorLado_CopiaDelHermanoSuma_NoLeidaNo @story-8.200 @ac-11', () => {
  const f = lab({
    declarados: ['pantallas/Inicio.ts', 'src/NoEsta.cs'],
    fePaths: ['pantallas'],
    delHermano: { 'pantallas/Inicio.ts': 'export const v = 1;\n' },
  });
  f.humo();
  const suite = escribir(f.ws, 'pantallas-suite/tests-result.json',
    JSON.stringify({ ts: new Date(f.ahora * 1000).toISOString(), story_id: '5.28', suite_green: true }));
  const r = f.calcular({ testsResults: [suite] });
  const copia = fs.statSync(path.join(f.back, 'pantallas/Inicio.ts')).mtimeMs;
  assert.equal(r.codeMtime, copia, 'la copia del hermano suma con su fecha, y la no leída no');
  assert.match(avisos(r), /tests-result \(fe\) es anterior al último edit de código fe/);
});

// ---------------------------------------------------------------- la guía

test('E3 Guia_Seccion7_DiceDondeBuscaYElRojo @story-8.200 @ac-14', () => {
  const texto = fs.readFileSync(GUIA, 'utf8');
  const s7 = texto.slice(texto.indexOf('## 7. Qué vence una evidencia'), texto.indexOf('\n## 8.'));
  assert.match(s7, /en el repo de la historia, en la carpeta de arriba, en cada hermano declarado y en su copia de la rama de la historia/);
  assert.match(s7, /Un archivo de código declarado que la matriz no puede leer la deja en rojo/);
});

// ---------------------------------------------------------------- lo que es de una tanda bloqueada

/**
 * Una historia en dos tandas: la A (AC 1) se entrega ahora; la C (AC 2) está bloqueada. `crear` son los archivos a
 * crear, cada uno con su comentario; `tareas` y `filasC`, cómo la historia ata archivos a la C por tarea o por prueba.
 */
function labTandas({ crear, estadoC = 'blocked', tareas = [], filasC = [] }) {
  const ws = carpeta();
  const esp = repoNuevo(ws, 'Historias');
  const ahora = Math.floor(Date.now() / 1000) - 3600;
  const cuerpo = ['---', 'story: 5.28', 'status: in-progress',
    'pipelines:',
    '  - name: A-lo-de-ahora', '    status: pending', '    acs_pending: [1]', '    tasks_pending: [1]', '    tests_pending: ["E1"]',
    '  - name: C-lo-de-despues', `    status: ${estadoC}`, '    blocked_by: "la tanda A en main"', '    acs_pending: [2]', '    tasks_pending: [3]', '    tests_pending: ["T2"]',
    'files_to_create:', ...crear.map((c) => `  - ${c}`), '---', '',
    '## Acceptance Criteria', '', '1. **Given** algo, **When** pasa, **Then** resultado.', '', '2. **Given** otra cosa, **When** pasa, **Then** otro resultado.', '',
    '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| E1 | `curl la pantalla` | 1 | e2e | x | y |',
    ...filasC.map((f) => `| T2 | ${f} | 2 | unit | x | y |`), '',
    '## Tasks', '', ...tareas, ''].join('\n');
  const storyPath = escribir(esp, 'specs/stories/5-28-carga.md', cuerpo);
  commit(esp, 'historias', ahora - 900);
  const dod = path.join(esp, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const gatesLog = path.join(ws, 'gates.log');
  ledgerLine.append({ dodDir: dod, gatesLog, story: '5.28', acs: [1], ts: new Date((ahora - 50) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), cmd: 'curl -s http://localhost:5000/pantalla', mirror: true });
  commit(esp, 'evidencia', ahora - 45);
  return rm.compute({ storyPath, gatesLogPath: gatesLog, testsResults: [] });
}

test('T12 ArchivoACrearDeTandaBloqueada_NoAnulaLaEvidencia', () => {
  // la forma de la historia del caso: el código de la tanda bloqueada por su comentario, su prueba por la tabla y otro por su tarea
  const r = labTandas({
    crear: ['src/barrido.js                 # tanda C: lo de después', 'tests/barrido.test.js', 'src/aviso.js', '"src/citado.js"                # tanda C', 'src/final.js', 'src/entero.js                  # tanda C-lo-de-despues'],
    filasC: ['`barrido.test.js` · `5.28-Barre`'],
    tareas: ['- [ ] [SEQ] Task 1: tanda A — lo de ahora', '- [ ] [SEQ] Task 3: tanda C — `aviso.js`,', '  con su prueba y el que cierra la frase: final.js.'],
  });
  assert.equal(r.perAc[1].verdict, 'RUNTIME', avisos(r));
  assert.equal(r.green, true, avisos(r));
  assert.deepEqual(r.noLeidos, []);
  const aviso = r.warnings.find((w) => /tanda bloqueada/.test(w)) || '';
  for (const f of ['src/barrido.js', 'tests/barrido.test.js', 'src/aviso.js', 'src/citado.js', 'src/final.js', 'src/entero.js']) assert.ok(aviso.includes(`${f} (C-lo-de-despues)`), aviso);
  assert.deepEqual(r.deTandaBloqueada.map((d) => d.rel).sort(), ['src/aviso.js', 'src/barrido.js', 'src/citado.js', 'src/entero.js', 'src/final.js', 'tests/barrido.test.js']);
});

test('T13 ArchivoACrearQueNoEsSoloDeLaBloqueada_SigueRojo', () => {
  // sin atar a ninguna tanda, atado a la que se entrega, o a las dos: la evidencia no cuenta, como siempre
  const casos = [
    { crear: ['src/suelto.js'], rel: 'src/suelto.js' },
    { crear: ['src/ahora.js                   # tanda A'], rel: 'src/ahora.js' },
    { crear: ['src/las-dos.js                 # tanda C'], tareas: ['- [ ] Task 1: tanda A — `las-dos.js`'], rel: 'src/las-dos.js' },
    // entre comillas y atado a la que se entrega, aunque una prueba de la bloqueada lo nombre
    { crear: ['"src/citado.js"                # tanda A'], filasC: ['`citado.js`'], rel: 'src/citado.js' },
    // un párrafo después de la tarea, tras un renglón en blanco, no es de la tarea
    { crear: ['src/zz.js'], tareas: ['- [ ] Task 3: tanda C — otra cosa', '', 'Una nota sobre zz.js que no es de la tarea.'], rel: 'src/zz.js' },
    // ni lo que sigue bajo un título pegado a la tarea
    { crear: ['src/tt.js'], tareas: ['- [ ] Task 3: tanda C — otra cosa', '## Dev Notes', 'tt.js va en la tanda A'], rel: 'src/tt.js' },
    // una tarea que no está en ninguna tanda no ata
    { crear: ['src/sin-tanda.js'], tareas: ['- [ ] Task 2: `sin-tanda.js`'], rel: 'src/sin-tanda.js' },
    // dos archivos con el mismo nombre: la tarea de la bloqueada que dice sólo el nombre no ata al de la que se entrega
    { crear: ['src/a/index.js', 'src/b/index.js                 # tanda C'], tareas: ['- [ ] Task 3: tanda C — `index.js`'], rel: 'src/a/index.js' },
    // ni la cola de una ruta más larga que la bloqueada nombra entera
    { crear: ['src/a/index.js', 'lib/src/a/index.js'], tareas: ['- [ ] Task 3: tanda C — `lib/src/a/index.js`'], rel: 'src/a/index.js' },
  ];
  for (const c of casos) {
    const r = labTandas(c);
    assert.equal(r.green, false, `${c.rel}: ${avisos(r)}`);
    assert.deepEqual(r.noLeidos.map((n) => n.rel), [c.rel]);
    assert.ok(r.warnings.some((w) => w.startsWith(`No pude leer ${c.rel}`)), avisos(r));
  }
});

test('T14 TandaQueDejaDeEstarBloqueada_SuArchivoVuelveAContar', () => {
  const r = labTandas({ crear: ['src/barrido.js                 # tanda C'], estadoC: 'pending' });
  assert.equal(r.green, false, avisos(r));
  assert.deepEqual(r.noLeidos.map((n) => n.rel), ['src/barrido.js']);
});

// ---------------------------------------------------------------- la copia de la historia y el clon compartido

/** El laboratorio con el hermano y su copia en la rama de la historia; el repo de historias, en esa rama o suelto. */
function labConCopia({ declarados = ['src/Feature.cs'], suelto = false, copia = true } = {}) {
  const f = lab({ declarados });
  git(f.esp, ['checkout', '-q', '-b', RAMA]);
  if (suelto) git(f.esp, ['checkout', '-q', '--detach']);
  const wt = path.join(f.ws, 'Back-wt');
  if (copia) git(f.back, ['worktree', 'add', '-q', '-b', RAMA, wt]);
  f.humo();
  return { ...f, wt };
}
// El clon compartido avanza en main y cambia el archivo, después de la evidencia.
function avanzaElClon(f) {
  escribir(f.back, 'src/Feature.cs', '// v2 en main, de otra historia\n');
  commit(f.back, 'main avanza', f.ahora + 100);
}

test('T15 CopiaDeLaHistoria_ClonCompartidoAvanza_NoVence @story-8.235 @ac-15', () => {
  // por la ruta del hermano, desde la carpeta de arriba y con el repo de historias sin rama (la copia se busca por número)
  for (const caso of [{}, { declarados: ['Back/src/Feature.cs'] }, { suelto: true }]) {
    const f = labConCopia(caso);
    avanzaElClon(f);
    const r = f.calcular();
    assert.equal(r.perAc[1].verdict, 'RUNTIME', `${JSON.stringify(caso)}: ${avisos(r)}`);
    assert.equal(r.green, true, avisos(r));
  }
});

test('T16 CopiaDeLaHistoria_CambiaDespues_Vence @story-8.235 @ac-16', () => {
  const f = labConCopia();
  avanzaElClon(f);
  escribir(f.wt, 'src/Feature.cs', '// v2 en la rama\n');
  commit(f.wt, 'cambio en la rama', f.ahora + 100);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  assert.match(avisos(r), /src\/Feature\.cs/);
  assert.doesNotMatch(avisos(r), /tal como está declarado/);
});

test('T17 HermanoSinCopiaDeLaHistoria_SeJuzgaYLoDice @story-8.235 @ac-17', () => {
  const f = labConCopia({ copia: false });
  avanzaElClon(f);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  assert.match(avisos(r), /comparada contra Back tal como está declarado: no tomé ninguna copia suya en la rama feature\/5-28-carga ni con el número 5\.28/);
  // sin rama, dice que la buscó sólo por el número
  const s = labConCopia({ copia: false, suelto: true });
  avanzaElClon(s);
  const rs = s.calcular();
  assert.equal(rs.perAc[1].verdict, 'NOT-RUN', avisos(rs));
  assert.match(avisos(rs), /comparada contra Back tal como está declarado: no tomé ninguna copia suya con el número 5\.28/);
  // dos copias que nombran la historia: no se elige ninguna, y el aviso no dice que no hay
  const d = labConCopia({ copia: false });
  git(d.back, ['worktree', 'add', '-q', '-b', 'otra/5-28-a', path.join(d.ws, 'Back-a')]);
  git(d.back, ['worktree', 'add', '-q', '-b', 'otra/5-28-b', path.join(d.ws, 'Back-b')]);
  avanzaElClon(d);
  const rd = d.calcular();
  assert.equal(rd.perAc[1].verdict, 'NOT-RUN', avisos(rd));
  assert.match(avisos(rd), /comparada contra Back tal como está declarado: no tomé ninguna copia suya en la rama feature\/5-28-carga ni con el número 5\.28/);
});

test('T17b HermanoEnLaRamaDeLaHistoria_SinAvisoDeCopia @story-8.235 @ac-17', () => {
  // el declarado está él mismo en la rama de la historia: es su copia, y el aviso no dice que falta
  const f = lab({ declarados: ['src/Feature.cs'] });
  git(f.esp, ['checkout', '-q', '-b', RAMA]);
  git(f.back, ['checkout', '-q', '-b', RAMA]);
  f.humo();
  escribir(f.back, 'src/Feature.cs', '// v2 en la rama\n');
  commit(f.back, 'cambio en la rama', f.ahora + 100);
  const r = f.calcular();
  assert.equal(r.perAc[1].verdict, 'NOT-RUN', avisos(r));
  assert.doesNotMatch(avisos(r), /tal como está declarado/);
});

test('T15b CopiaDeLaHistoria_RutaConOtraMayusculaOSoloEnLaCopia @story-8.235 @ac-15', () => {
  // un archivo que la historia crea sólo en su copia, escrito desde la carpeta de arriba: se lee en la copia
  const n = labConCopia({ declarados: ['Back/src/New.cs'] });
  escribir(n.wt, 'src/New.cs', '// nuevo en la rama\n');
  commit(n.wt, 'nuevo en la rama', n.ahora - 200);
  const rn = n.calcular();
  assert.deepEqual(rn.noLeidos, [], avisos(rn));
  assert.equal(rn.perAc[1].verdict, 'RUNTIME', avisos(rn));
  // la ruta escrita con otra mayúscula que la carpeta: donde el disco no las distingue, es la misma copia
  const m = labConCopia({ declarados: ['back/src/Feature.cs'] });
  const distingue = !fs.existsSync(path.join(m.ws, 'back'));
  avanzaElClon(m);
  const rm1 = m.calcular();
  if (distingue) {
    assert.deepEqual(rm1.noLeidos.map((x) => x.rel), ['back/src/Feature.cs'], avisos(rm1));
  } else {
    assert.equal(rm1.perAc[1].verdict, 'RUNTIME', avisos(rm1));
    escribir(m.wt, 'src/Feature.cs', '// v2 en la rama\n');
    commit(m.wt, 'cambio en la rama', m.ahora + 100);
    assert.equal(m.calcular().perAc[1].verdict, 'NOT-RUN', 'la copia cambió: no cuenta');
  }
});
