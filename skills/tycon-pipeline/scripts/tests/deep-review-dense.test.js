#!/usr/bin/env node
/**
 * deep-review-dense.test.js — el pase adversarial corre cuando el diff es DENSO aunque sea chico
 * en archivos (PIPE-DEBT-2.14, 2026-09-10).
 *
 * Caso disparador (el arnés, story 2.14): 4 archivos de código → risk-class LOW → el
 * gate saltea el 5b. Forzado a mano, el pase confirmó 6 defectos reales sobre esos mismos 4
 * archivos (traversal, clasificación, contratos, determinismo). El tamaño en archivos no mide la
 * lógica: una vista con agregaciones, clasificación y ejes de tiempo en 1.100 líneas es «LOW».
 *
 * Correr: node --test .../scripts/tests/deep-review-dense.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
// HOME temporal: el gate deja constancia en gates.log cuando salta por LOW (mismo motivo que en
// deep-review-shared-surface.test.js — no ensuciar el registro real del dev).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-home-'));

// git de laboratorio: fechas fijas y sin mantenimiento automático (guía de ejecución de tests: una prueba no depende
// de un sha ni de una hora), sin la configuración de la máquina.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' };
function git(dir, ...a) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// 🔴 Cada laboratorio es un repo git (2026-10-15): el conteo mide cada archivo en SU repo, y un archivo fuera de todo
//    repo ya no se cuenta entero en silencio. Un archivo nuevo sin trackear en su repo sí se cuenta entero: es nuevo.
function mkRepo(lineasCodigo) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-'));
  git(r, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'vista.js'), Array.from({ length: lineasCodigo }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(r, 'src', 'datos.json'), '[' + Array.from({ length: 2000 }, () => '1').join(',') + ']\n');
  fs.writeFileSync(path.join(r, 'story.md'),
    ['---', 'story: 2.14', 'epic: 2', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  return r;
}

/** Como `gate`, pero SIN exigir exit 0: los casos de «no pude medir» esperan que el gate corte. */
function mkRepoConScope(lineasCodigo) {
  const r = mkRepo(lineasCodigo);
  // 🔴 La story DECLARA su scope: sin eso el risk-class da NORMAL («scope no declarado») y el gate
  //    decide antes de llegar a la densidad. El caso real (story 4.1) declaraba 6 archivos → LOW.
  fs.writeFileSync(path.join(r, 'story.md'),
    ['---', 'story: 4.1', 'epic: 4', 'status: in-progress', 'files_to_create: []',
     'files_to_modify:', '  - src/vista.js', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  return r;
}

function gateCrudo(repo, env, args) {
  return spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'story.md'), ...args],
    { encoding: 'utf8', env: { ...process.env, HOME, ...env } });
}

function gate(repo, env, ...files) {
  const r = spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', ...files],
    { encoding: 'utf8', env: { ...process.env, HOME, ...env } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('un archivo de código denso (400 líneas) corre el pase aunque el risk-class sea LOW', () => {
  const repo = mkRepo(400);
  const v = gate(repo, {}, 'src/vista.js');
  assert.equal(v.run, true);
  assert.equal(v.risk, 'dense');
  assert.equal(v.lineas_agregadas, 401);
  assert.match(v.reason, /denso/i);
});

test('un archivo chico (40 líneas) sigue saltando por LOW, y el veredicto MUESTRA la medición', () => {
  // 🔴 rojo previo: sin la señal de densidad el caso de arriba también salía run:false — este
  //    caso fija que el skip legítimo sigue existiendo y que dice cuántas líneas contó.
  const repo = mkRepo(40);
  const v = gate(repo, {}, 'src/vista.js');
  assert.equal(v.run, false);
  assert.equal(v.risk, 'LOW');
  assert.equal(v.lineas_agregadas, 41);
  assert.match(v.reason, /41 líneas/);
});

test('los archivos que no son código no cuentan (un JSON de 2000 números no es lógica)', () => {
  const repo = mkRepo(40);
  const v = gate(repo, {}, 'src/vista.js', 'src/datos.json');
  assert.equal(v.run, false);
  assert.equal(v.lineas_agregadas, 41);
});

test('el umbral se declara por env (TYCON_DEEP_REVIEW_DENSE_LINES) y un valor inválido cae al default', () => {
  const repo = mkRepo(120);
  assert.equal(gate(repo, { TYCON_DEEP_REVIEW_DENSE_LINES: '100' }, 'src/vista.js').run, true);
  assert.equal(gate(repo, { TYCON_DEEP_REVIEW_DENSE_LINES: 'muchas' }, 'src/vista.js').run, false);
  assert.equal(gate(repo, { TYCON_DEEP_REVIEW_DENSE_LINES: 'muchas' }, 'src/vista.js').umbral_lineas, 300);
});

// ── «no me dijiste qué mirar» no es «no cambió nada» (2026-09-10) ──────────────────────────────
//
// Caso real, story 4.1 del arnés: se invocó el gate SIN `--files` sobre un cambio de
// 839 líneas y contestó «0 líneas agregadas < 300 → skip». Sonaba a medición y no lo era: sin
// archivos que mirar no hay nada que contar. En esa corrida no importó porque el dev había pedido
// la revisión a mano; por el camino automático, las 839 líneas se salteaban solas — y ese pase fue
// justamente el que encontró seis defectos.
//
// Se eligió CORTAR y no «correr por las dudas»: una corrida del pase adversarial midió 6,5 M de
// tokens y 30 minutos, así que revisar de más no es el lado barato. El error está en la llamada y
// se arregla ahí. Las dos invocaciones reales de los steps ya pasan `--files`.

test('sin --files el gate CORTA en vez de informar «0 líneas»', () => {
  const repo = mkRepoConScope(400);
  const r = gateCrudo(repo, {}, []);
  assert.notEqual(r.status, 0, 'tiene que cortar: no puede decidir sin saber qué mirar');
  const salida = `${r.stdout}${r.stderr}`;
  assert.match(salida, /no pude medir|sin --files|qué mirar/i, `debe decir por qué cortó: ${salida.slice(0, 200)}`);
  assert.doesNotMatch(salida, /0 líneas agregadas/, 'jamás un cero que nadie contó');
});

test('…pero `--files` DECLARADO y vacío sí es una medición: el diff no toca código', () => {
  // 🔴 La distinción es el corazón del arreglo, y se pasa por alto fácil: «no me dijiste qué
  //    mirar» y «te digo que no hay archivos de código» son cosas distintas. La primera no se
  //    puede medir y corta; la segunda ES cero, y un skip ahí es correcto — una story de sólo
  //    documentación no necesita el pase adversarial. Sin este caso, el arreglo podía terminar
  //    cortando también las corridas legítimas, que es como un freno se vuelve un estorbo y
  //    alguien lo apaga.
  const repo = mkRepoConScope(400);
  const r = gateCrudo(repo, {}, ['--files']);
  assert.equal(r.status, 0, `declarar la lista vacía es válido: ${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.run, false);
  assert.equal(v.lineas_agregadas, 0, 'acá el cero SÍ se midió: no hay archivos de código');
});

test('un override explícito del dev decide SIN necesitar la densidad', () => {
  // 🔴 El corte no puede tapar la puerta que el dev usa a propósito: `--deep-review` fuerza el pase
  //    y `--no-deep-review` lo apaga. En los dos casos la densidad es irrelevante — pedir archivos
  //    ahí convertiría un freno útil en un estorbo, que es como se terminan apagando.
  const repo = mkRepoConScope(400);
  const on = gateCrudo(repo, {}, ['--deep-review']);
  assert.equal(on.status, 0, `--deep-review debe decidir solo: ${on.stderr}`);
  assert.equal(JSON.parse(on.stdout).run, true);

  const off = gateCrudo(repo, { TYCON_NO_DEEP_REVIEW: '1' }, []);
  assert.equal(off.status, 0, `el kill-switch debe decidir solo: ${off.stderr}`);
  assert.equal(JSON.parse(off.stdout).run, false);
});

// ── Stories de dos repos (2026-10-15, GE-4 de un producto del equipo) ──────────────────────────────────────────────
//
// La story vivía en el backend y el código en el frontend, un repo companion. El portón medía cada archivo con
// `git -C <repo de la story>`: los del frontend daban «no trackeado» y se sumaban enteros (1464 líneas contra 221
// reales) y corrió el pase por «denso». Ahora cada archivo se mide en el repo de su propia carpeta.

function repoConArchivoTrackeado(lineas) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-companion-'));
  git(b, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(b, 'src'), { recursive: true });
  const f = path.join(b, 'src', 'pantalla.tsx');
  fs.writeFileSync(f, Array.from({ length: lineas }, (_, i) => `export const p${i} = ${i};`).join('\n') + '\n');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'base');
  return { b, f };
}

test('@story-7.26 story en A, código en el repo companion B: mide las líneas agregadas en B, no el archivo entero', () => {
  // 🔴 rojo previo: 403 (las 400 de HEAD más las 3 nuevas) y run:true por «denso».
  const a = mkRepoConScope(40);
  const { f } = repoConArchivoTrackeado(400);
  fs.appendFileSync(f, 'export const n1 = 1;\nexport const n2 = 2;\nexport const n3 = 3;\n');
  const v = gate(a, { TYCON_DEEP_REVIEW_DENSE_LINES: '300' }, f);
  assert.equal(v.lineas_agregadas, 3, `midió ${v.lineas_agregadas}: tiene que contar sólo lo agregado en su repo`);
  assert.equal(v.run, false);
  assert.equal(v.risk, 'LOW');
  assert.equal(v.archivos_no_medidos, undefined);
});

test('@story-7.26 un archivo fuera de todo repo git no se cuenta entero ni como 0: el portón corta y lo nombra', () => {
  const a = mkRepoConScope(40);
  const suelto = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-suelto-'));
  const f = path.join(suelto, 'huerfano.js');
  fs.writeFileSync(f, Array.from({ length: 50 }, (_, i) => `const h${i} = ${i};`).join('\n') + '\n');
  const r = gateCrudo(a, {}, ['--files', f]);
  assert.equal(r.status, 2, `tiene que cortar: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no pude medir 1 archivo/);
  assert.ok(r.stderr.includes(f), 'nombra la ruta que no pudo medir');
  assert.match(r.stderr, /no está dentro de ningún repo git/);
  assert.doesNotMatch(r.stderr, /51 líneas agregadas/, 'el archivo entero no se suma en silencio');
});

test('@story-7.26 lo medido ya pasa el umbral: corre el pase y el veredicto igual nombra lo que no midió', () => {
  const a = mkRepoConScope(400);
  const suelto = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-suelto-'));
  const f = path.join(suelto, 'huerfano.js');
  fs.writeFileSync(f, 'const h = 1;\n');
  const v = gate(a, {}, 'src/vista.js', f);
  assert.equal(v.run, true);
  assert.equal(v.risk, 'dense');
  assert.equal(v.lineas_agregadas, 401);
  assert.deepEqual(v.archivos_no_medidos.map((n) => n.file), [f]);
});
