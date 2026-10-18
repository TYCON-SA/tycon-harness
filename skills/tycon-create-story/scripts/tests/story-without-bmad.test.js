'use strict';

/**
 * story-without-bmad.test.js — la historia de un repo sin proyecto BMAD.
 *
 * Lo que no se puede perder:
 *   - El modo lo decide el guion por lo que hay en el repo (`_bmad/bmm/config.yaml`), nunca el modelo.
 *   - La historia la escribe el guion: valida antes, no pisa, pasa el lint y el arnés la encuentra.
 *   - El guion deja constancia de lo que escribió; esa constancia es lo que habilita la rama sola en `start`.
 *
 * Todo corre en repos de juguete y con un HOME de laboratorio: nunca toca el árbol ni la casa de quien la corre.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..', '..');
const RAIZ = path.resolve(SKILL, '..', '..');
const GUION = path.join(SKILL, 'scripts', 'story-without-bmad.js');
const LINT = path.join(RAIZ, 'scripts', 'lib', 'lint-story-frontmatter.js');
const DISCOVERY = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');
const STATE_DIR = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `historia-${p}-`));

function entorno(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_HOME', 'TYCON_STATE_DIR']) delete env[k];
  return env;
}

function correr(argv, { home = tmp('home') } = {}) {
  const r = spawnSync(process.execPath, [GUION, ...argv], { env: entorno(home), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, home };
}

function repo({ bmad = false, specs = false } = {}) {
  const d = tmp('repo');
  if (bmad) {
    fs.mkdirSync(path.join(d, '_bmad', 'bmm'), { recursive: true });
    fs.writeFileSync(path.join(d, '_bmad', 'bmm', 'config.yaml'), 'project_name: acme\n');
  }
  if (specs) fs.mkdirSync(path.join(d, 'specs'));
  return d;
}

const respuestas = (extra = {}) => ({
  title: 'El total del carrito suma el envío',
  asA: 'quien compra en la tienda de acme',
  iWant: 'ver el total con el envío incluido',
  soThat: 'no llevarme una sorpresa al pagar',
  criteria: [
    { given: 'un carrito con dos productos y envío a domicilio', when: 'abro el resumen', then: 'el total incluye el costo del envío' },
    { given: 'un carrito sin productos', when: 'abro el resumen', then: 'el total es cero y no hay envío', failure: true },
  ],
  tests: [
    { name: 'Total_ConEnvio', criterion: 1, level: 'unit', scenario: 'dos productos y envío de 500', expected: 'total = suma + 500' },
    { name: 'Total_CarritoVacio', criterion: 2, level: 'unit', scenario: 'carrito vacío', expected: 'total = 0' },
  ],
  outOfScope: ['el cálculo de impuestos'],
  filesToCreate: [],
  filesToModify: ['src/cart.js'],
  ...extra,
});

function escribirRespuestas(obj) {
  const f = path.join(tmp('respuestas'), 'answers.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}

function historiaDeJuguete(dir, nombre, id) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nombre), ['---', `epic: 1`, `story: "${id}"`, `title: "de juguete ${id}"`, 'status: done', '---', '', `# Story ${id}`, ''].join('\n'));
}

test('T1 Mode_SinConfig_PrimeraVez: sin _bmad, modo first-time con carpeta, número y ruta', () => {
  const sinSpecs = repo();
  const r1 = correr(['mode', '--repo', sinSpecs]);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.strictEqual(r1.json.mode, 'first-time');
  assert.strictEqual(r1.json.folder, 'stories');
  assert.strictEqual(r1.json.number, '1.1');
  assert.strictEqual(r1.json.dir, path.join(sinSpecs, 'stories'));

  const conSpecs = repo({ specs: true });
  const r2 = correr(['mode', '--repo', conSpecs]);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(r2.json.folder, 'specs');
  assert.strictEqual(r2.json.number, '1.1');
});

test('T2 Mode_ConConfig_Bmad: con _bmad/bmm/config.yaml, modo bmad y nada más', () => {
  const r = correr(['mode', '--repo', repo({ bmad: true })]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json, { mode: 'bmad' });
});

test('T3 Mode_SiguienteNumero: con 1.1 y 1.2 en la carpeta, el siguiente es 1.3', () => {
  const d = repo();
  historiaDeJuguete(path.join(d, 'stories'), 'cualquier-nombre.md', '1.1');
  historiaDeJuguete(path.join(d, 'stories'), 'otra.md', '1.2');
  fs.writeFileSync(path.join(d, 'stories', 'notas.md'), '# sin frontmatter\n');
  const r = correr(['mode', '--repo', d]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.number, '1.3');
});

test('T4 Write_EscribeLaHistoria: frontmatter, secciones, una fila por prueba, constancia y la frase', () => {
  const d = repo();
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(r.status, 0, r.stderr);
  const ruta = r.json.path;
  assert.ok(ruta.startsWith(path.join(d, 'stories') + path.sep), ruta);
  assert.match(path.basename(ruta), /^story-1\.1-[a-z0-9-]+\.md$/);
  assert.strictEqual(r.json.phrase, `implementemos la story ${path.relative(d, ruta)}`);
  assert.match(r.stdout, /implementemos la story /);

  const txt = fs.readFileSync(ruta, 'utf8');
  for (const linea of ['epic: 1', 'story: "1.1"', 'title: "El total del carrito suma el envío"', 'status: ready-for-dev',
    'origin: first-time', 'files_to_create: []', 'files_to_modify:', '  - src/cart.js']) {
    assert.ok(txt.split('\n').includes(linea), `falta la línea «${linea}»`);
  }
  assert.match(txt, /^created: \d{4}-\d{2}-\d{2}$/m);
  for (const titulo of ['## Story', '## Acceptance Criteria', '### Tests (2 verificaciones)', '## Tasks / Subtasks', '## Fuera de alcance', '## Dev Notes']) {
    assert.ok(txt.includes(`\n${titulo}\n`), `falta la sección ${titulo}`);
  }
  assert.match(txt, /1\. \*\*Given\*\* un carrito con dos productos y envío a domicilio \*\*When\*\* abro el resumen \*\*Then\*\* el total incluye el costo del envío/);
  const filas = txt.split('\n').filter((l) => /^\| T\d+ \|/.test(l));
  assert.strictEqual(filas.length, 2);
  assert.match(filas[0], /^\| T1 \| `Total_ConEnvio` \| 1 \| unit \|/);
  assert.match(filas[1], /^\| T2 \| `Total_CarritoVacio` \| 2 \| unit \|/);
  assert.match(txt, /el cálculo de impuestos/);

  const constancia = path.join(require(STATE_DIR).stateDir(r.home), 'first-time-stories');
  const archivos = fs.readdirSync(constancia);
  assert.strictEqual(archivos.length, 1);
  const c = JSON.parse(fs.readFileSync(path.join(constancia, archivos[0]), 'utf8'));
  assert.strictEqual(c.path, fs.realpathSync(ruta));
  assert.strictEqual(c.story, '1.1');
});

test('T5 Write_PasaLintYDescubrimiento: el lint no da errores y el arnés la encuentra', () => {
  const d = repo();
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(r.status, 0, r.stderr);
  const lint = spawnSync(process.execPath, [LINT, r.json.path], { cwd: d, env: entorno(r.home), encoding: 'utf8' });
  assert.strictEqual(lint.status, 0, lint.stdout + lint.stderr);
  const encontrada = require(DISCOVERY).probeStoryFile(r.json.path);
  assert.deepStrictEqual({ id: encontrada.id, status: encontrada.status }, { id: '1.1', status: 'ready-for-dev' });
});

test('T6 Write_JsonIncompleto_Sale2: dice qué falta o qué sobra y no escribe nada', () => {
  const casos = [
    [{ criteria: [], tests: [] }, /ningún criterio/],
    [{ tests: [respuestas().tests[0]] }, /criterio 2 no tiene ninguna prueba/],
    [{ tests: [...respuestas().tests, { name: 'Fantasma', criterion: 7, level: 'unit', scenario: 'x', expected: 'y' }] }, /prueba Fantasma nombra el criterio 7, que no existe/],
    [{ title: 'El "total" del carrito' }, /comillas dobles/],
    // pase adversarial: una barra invertida rompía el YAML del encabezado
    [{ title: 'C:\\temp\\x' }, /barras invertidas/],
    // pase adversarial: rutas que en una lista YAML cambian de significado, o salen del repo
    [{ filesToCreate: ['-bad.md'] }, /la ruta «-bad\.md» no sirve/],
    [{ filesToCreate: ['a: b.md'] }, /la ruta «a: b\.md» no sirve/],
    [{ filesToModify: ['#hash.md'] }, /la ruta «#hash\.md» no sirve/],
    [{ filesToModify: ['../fuera.js'] }, /la ruta «\.\.\/fuera\.js» no sirve/],
    [{ filesToModify: ['/abs/x.js'] }, /la ruta «\/abs\/x\.js» no sirve/],
  ];
  for (const [cambio, mensaje] of casos) {
    const d = repo();
    const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas(cambio))]);
    assert.strictEqual(r.status, 2, `${JSON.stringify(cambio)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, mensaje);
    assert.ok(!fs.existsSync(path.join(d, 'stories')), 'no tenía que escribir nada');
  }
});

test('T7 Write_NoPisa: con el destino ocupado sale 2 nombrándolo y lo deja igual', () => {
  const d = repo();
  const primera = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(primera.status, 0, primera.stderr);
  // Otro archivo sin frontmatter ocupa la ruta que tocaría a la siguiente.
  const ocupado = path.join(d, 'stories', 'story-1.2-el-total-del-carrito-suma-el-envio.md');
  fs.writeFileSync(ocupado, 'mío\n');
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())], { home: primera.home });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes(ocupado), r.stderr);
  assert.strictEqual(fs.readFileSync(ocupado, 'utf8'), 'mío\n');
});

test('T8 Write_ProyectoBmad_Sale2: en un proyecto BMAD el modo primera vez no escribe', () => {
  const d = repo({ bmad: true });
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stderr, /proyecto BMAD/);
  assert.ok(!fs.existsSync(path.join(d, 'stories')));
  assert.ok(!fs.existsSync(path.join(d, 'specs')));
});

test('T9 Instrucciones_PrimeraVez: el desvío antes de la config y las tres preguntas en llano', () => {
  const wf = fs.readFileSync(path.join(SKILL, 'workflow.md'), 'utf8');
  const iMode = wf.indexOf('story-without-bmad.js mode');
  const iConfig = wf.indexOf('### Configuration Loading');
  assert.ok(iMode > 0 && iConfig > 0 && iMode < iConfig, 'workflow.md: el modo tiene que correr antes de «Configuration Loading»');
  assert.match(wf.slice(0, iConfig), /first-time\.md/);
  // AC 14: desde «Configuration Loading» el flujo de BMAD sigue igual.
  assert.match(wf.slice(iConfig), /Load config from `\{project-root\}\/_bmad\/bmm\/config\.yaml`/);

  const ft = fs.readFileSync(path.join(SKILL, 'first-time.md'), 'utf8');
  const preguntas = ft.split('\n').filter((l) => /^\d\. \*\*/.test(l));
  assert.strictEqual(preguntas.length, 3, 'tres preguntas numeradas');
  assert.match(preguntas[0], /qué querés que haga/i);
  assert.match(preguntas[1], /cómo te das cuenta de que anda/i);
  assert.match(preguntas[2], /qué no tiene que tocar/i);
  for (const p of preguntas) assert.doesNotMatch(p, /épica|sprint|prioridad/i);
  assert.match(ft, /una por vez/);
  assert.match(ft, /esper(á|ar) el «sí»/);
  assert.match(ft, /story-without-bmad\.js write/);
  assert.match(ft, /historia/);
  assert.match(ft, /tu agente de código/);
  assert.match(ft, /implementemos la story <ruta>/);
});

test('T17 Mode_Subcarpetas: una historia en una subcarpeta también cuenta para el número', () => {
  const d = repo({ specs: true });
  historiaDeJuguete(path.join(d, 'specs', 'stories', 'viejas'), 'existente.md', '1.7');
  const r = correr(['mode', '--repo', d]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.number, '1.8');

  // una historia enlazada también cuenta
  const afuera = tmp('afuera');
  historiaDeJuguete(afuera, 'enlazada.md', '1.9');
  fs.symlinkSync(path.join(afuera, 'enlazada.md'), path.join(d, 'specs', 'enlace.md'));
  assert.strictEqual(correr(['mode', '--repo', d]).json.number, '1.10');

  // más hondo que lo que se recorre: frena en vez de no contarla
  const honda = path.join(d, 'specs', 'a', 'b', 'c', 'd', 'e');
  historiaDeJuguete(honda, 'honda.md', '1.20');
  const h = correr(['mode', '--repo', d]);
  assert.strictEqual(h.status, 2, h.stdout);
  assert.match(h.stderr, /de profundidad/);
});

test('T18 Mode_Ilegible_Sale2: un .md que no se puede leer frena en vez de adivinar el número', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const d = repo();
  historiaDeJuguete(path.join(d, 'stories'), 'cerrada.md', '1.4');
  const f = path.join(d, 'stories', 'cerrada.md');
  fs.chmodSync(f, 0o000);
  try {
    const r = correr(['mode', '--repo', d]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.ok(r.stderr.includes(f), r.stderr);
    const w = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
    assert.strictEqual(w.status, 2, w.stdout);
    assert.deepStrictEqual(fs.readdirSync(path.join(d, 'stories')), ['cerrada.md']);
  } finally {
    fs.chmodSync(f, 0o644);
  }
});

test('T19 Write_SinConstancia_NoDejaHistoria: si no puede guardar la constancia, no deja la historia a medias', () => {
  const d = repo();
  const home = tmp('home');
  const estado = require(STATE_DIR).stateDir(home);
  fs.mkdirSync(estado, { recursive: true });
  fs.writeFileSync(path.join(estado, 'first-time-stories'), 'un archivo donde va la carpeta\n');
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())], { home });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stderr, /no pude dejar la constancia/);
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'stories')), []);
});

test('T15 Portada_SinAvisoBmad: la portada ya no dice que la skill espera _bmad/; dice las tres preguntas', () => {
  const casos = { 'README.es.md': [/espera la carpeta `_bmad\/`/, /tres preguntas en llano/], 'README.md': [/expects a project's `_bmad\/`/, /three plain questions/] };
  for (const [f, [viejo, nuevo]] of Object.entries(casos)) {
    const txt = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    assert.doesNotMatch(txt, viejo, `${f} todavía avisa que la skill espera _bmad/`);
    assert.doesNotMatch(txt, /story-format\.md/, `${f} todavía manda a escribir la historia a mano`);
    assert.match(txt, nuevo, `${f} no dice qué pasa sin _bmad/`);
  }
});
