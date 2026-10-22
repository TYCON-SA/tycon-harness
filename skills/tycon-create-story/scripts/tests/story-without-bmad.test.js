'use strict';

/**
 * story-without-bmad.test.js — la historia de un repo sin proyecto BMAD.
 *
 * Lo que no se puede perder:
 *   - El modo lo decide el guion por lo que hay en el repo (`_bmad/bmm/config.yaml`), nunca el modelo.
 *   - La historia la escribe el guion: valida antes, no pisa, pasa el lint y el arnés la encuentra.
 *   - El guion deja constancia de lo que escribió; esa constancia es lo que habilita la rama sola en `start`.
 *   - La historia nace limpia para el validador: sprint, salvaguarda primero, lo que no hay que hacer y cómo verificar
 *     con un comando real. Sin comando que decir, no escribe.
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
  verify: ['npm test'],
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
  for (const titulo of ['## Story', '## Acceptance Criteria', '### Tests (2 verificaciones)', '## Tasks / Subtasks', '## Lo que NO hay que hacer', '## Cómo verificar que funciona', '## Dev Notes']) {
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

// ── La historia nace limpia para el validador ──────────────────────────────────────────────────

function escribir(d, extra) {
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas(extra))]);
  assert.strictEqual(r.status, 0, r.stderr);
  return fs.readFileSync(r.json.path, 'utf8');
}

/** Lo que va entre un título `## X` y el siguiente `## `. */
function seccion(txt, titulo) {
  const i = txt.indexOf(`\n${titulo}\n`);
  assert.ok(i >= 0, `falta la sección ${titulo}`);
  const resto = txt.slice(i + titulo.length + 2);
  const fin = resto.search(/\n## /);
  return fin < 0 ? resto : resto.slice(0, fin);
}

test('T20 Write_HistoriaLimpia_Sprint @story-8.62 @ac-1: sprint 1 en el frontmatter y el estado bajo el título', () => {
  const txt = escribir(repo());
  const fm = txt.split('\n---\n')[0];
  assert.ok(fm.split('\n').includes('sprint: 1'), 'falta «sprint: 1» en el frontmatter');
  assert.match(txt, /\n# Story 1\.1: [^\n]+\n\nStatus: ready-for-dev\n/);
});

test('T21 Write_SalvaguardaPrimero @story-8.62 @ac-2: la primera tarea es la salvaguarda de estado', () => {
  const tareas = seccion(escribir(repo()), '## Tasks / Subtasks').split('\n').filter((l) => /^- \[ \]/.test(l));
  assert.ok(tareas.length >= 3, tareas.join('\n'));
  assert.match(tareas[0], /Task 1: Salvaguarda de estado/);
  assert.match(tareas[0], /src\/cart\.js/, 'la salvaguarda nombra los archivos de la historia');
});

test('T22 Write_LoQueNoHayQueHacer @story-8.62 @ac-3: con y sin «qué no tocar», al menos un renglón', () => {
  const con = seccion(escribir(repo()), '## Lo que NO hay que hacer');
  assert.match(con, /^- No tocar el cálculo de impuestos/m);
  assert.match(con, /^- No escribir el código antes de ver las pruebas en rojo/m);
  const yaDiceNo = seccion(escribir(repo(), { outOfScope: ['no cambiar la moneda.'] }), '## Lo que NO hay que hacer');
  assert.match(yaDiceNo, /^- No cambiar la moneda\.$/m);
  assert.doesNotMatch(yaDiceNo, /No tocar no/i);
  const sin = seccion(escribir(repo(), { outOfScope: [] }), '## Lo que NO hay que hacer');
  assert.ok(sin.split('\n').filter((l) => l.startsWith('- ')).length >= 1, sin);
  assert.doesNotMatch(sin, /No tocar/);
});

test('T23 Write_ComoVerificar_DeVerifyODelRepo @story-8.62 @ac-4: el comando de la respuesta, o npm test si el repo lo declara', () => {
  const deVerify = seccion(escribir(repo(), { verify: ['npx vitest run src/cart.test.js'] }), '## Cómo verificar que funciona');
  assert.match(deVerify, /```bash\nnpx vitest run src\/cart\.test\.js\n```/);
  const d = repo();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'acme', scripts: { test: 'node --test' } }));
  const delRepo = seccion(escribir(d, { verify: undefined }), '## Cómo verificar que funciona');
  assert.match(delRepo, /```bash\nnpm test\n```/);
  // una lista vacía es «no lo trae»: también sale del repo
  assert.match(seccion(escribir(d, { verify: [] }), '## Cómo verificar que funciona'), /```bash\nnpm test\n```/);
  // el comando lo corre después el recorrido: la persona lo ve antes del «sí»
  const paso3 = fs.readFileSync(path.join(SKILL, 'first-time.md'), 'utf8').split('## 3. Mostrar')[1].split('\n## ')[0];
  assert.match(paso3, /con qué comando se corren/);
});

test('T25 Write_QueExisteHoyYOrden @story-8.62 @ac-6: lo que está en el disco, la delta y el orden de las tareas', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'cart.js'), 'module.exports = {};\n');
  const txt = escribir(d, { filesToCreate: ['src/envio.js'] });
  const hoy = txt.slice(txt.indexOf('\n### Que existe hoy\n'), txt.indexOf('\n### Que hay que hacer (la delta)\n'));
  assert.match(hoy, /\*\*Archivo:\*\* `src\/cart\.js` — lo modifica la historia/);
  assert.match(hoy, /\*\*No existe:\*\* `src\/envio\.js`/);
  assert.match(txt, /### Que hay que hacer \(la delta\)\n\n1\. Crear `src\/envio\.js`\n2\. Modificar `src\/cart\.js`\n3\. Que se cumplan los criterios 1 a 2/);
  assert.match(txt, /### Task Dependencies\n\nTask 1 → Task 2 → Task 3 \(secuencial\)/);
  const sinArchivos = escribir(repo(), { filesToModify: [] });
  assert.match(sinArchivos, /La historia no nombra archivos/);
});

test('T24 Write_SinComando_Sale2 @story-8.62 @ac-5: sin verify ni nada que deducir, no escribe', () => {
  // el `test` que deja `npm init` sale siempre con error: no es un comando de pruebas
  const stubNpmInit = { name: 'acme', scripts: { test: 'echo "Error: no test specified" && exit 1' } };
  for (const pkg of [null, { name: 'acme', scripts: {} }, '{ esto no es json', stubNpmInit]) {
    const d = repo();
    if (pkg !== null) fs.writeFileSync(path.join(d, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
    const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas({ verify: undefined }))]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.stderr, /falta cómo se corren las pruebas/);
    assert.ok(!fs.existsSync(path.join(d, 'stories')) || fs.readdirSync(path.join(d, 'stories')).length === 0, 'no escribió nada');
  }
  // un comando con salto de línea o con ``` saldría del bloque bash y escribiría en la historia
  for (const malo of ['npm test\nrm -rf /', 'echo ```']) {
    const r = correr(['write', '--repo', repo(), '--answers', escribirRespuestas(respuestas({ verify: [malo] }))]);
    assert.strictEqual(r.status, 2, `${JSON.stringify(malo)}: ${r.stdout}`);
    assert.match(r.stderr, /verify/);
  }
});

test('T26 Write_TraeElCierre @story-8.64 @ac-1: el mensaje de cierre viaja en el resultado y la guía lo pide tal cual', () => {
  // medido: la frase para seguir iba sólo por la salida de errores y el agente no la dijo
  const d = repo();
  const r = correr(['write', '--repo', d, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(r.status, 0, r.stderr);
  const rel = path.relative(d, r.json.path).split(path.sep).join('/');
  assert.strictEqual(typeof r.json.closing, 'string', JSON.stringify(r.json));
  assert.ok(r.json.closing.startsWith(`Listo, tu historia quedó en \`${rel}\`.`), r.json.closing);
  assert.ok(r.json.closing.includes(`Para implementarla, pedime: «implementemos la story ${rel}».`), r.json.closing);
  assert.match(r.json.closing, /el recorrido lo prepara solo/);
  const guia = fs.readFileSync(path.join(SKILL, 'first-time.md'), 'utf8');
  const cierre = guia.slice(guia.indexOf('## 5. El cierre'));
  assert.match(cierre, /`closing`/);
  assert.match(cierre, /tal cual/);
});

// ── «primera vez» sólo cuando el producto de verdad no tiene historias ──────────────────────────────────────────────
// Un producto de juguete: una carpeta con sus repos (cada uno con su .git), como la raíz de repos de una máquina.
function producto() { return tmp('producto'); }
function repoDe(prod, nombre, { bmad = false, historias = [], carpeta = 'specs', yaml = null } = {}) {
  const d = path.join(prod, nombre);
  fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  if (bmad) {
    fs.mkdirSync(path.join(d, '_bmad', 'bmm'), { recursive: true });
    fs.writeFileSync(path.join(d, '_bmad', 'bmm', 'config.yaml'), 'project_name: acme\n');
  }
  historias.forEach((id, i) => historiaDeJuguete(path.join(d, carpeta), `h-${i}.md`, id));
  if (yaml) {
    fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  }
  return d;
}
const YAML_HISTORIAS = (rel, remoto) => `stories:\n  id_pattern: '^(?:[A-Z]{1,4}-)?\\d+(?:[.-]\\d+)*$'\n  repo: ${rel}\n${remoto ? `  remote: ${remoto}\n` : ''}`;

test('T27 Mode_RepoConHistoriasPropias_NoEsPrimeraVez: con historias por área, no inventa una 1.1 ni ofrece BMAD', () => {
  const prod = producto();
  const back = repoDe(prod, 'Backend', { historias: ['A-1', 'AP-2', 'CA-1'] });
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'existing', r.stdout);
  assert.strictEqual(r.json.places.length, 1);
  assert.strictEqual(r.json.places[0].dir, path.join(back, 'specs'));
  assert.strictEqual(r.json.places[0].count, 3);
  assert.match(r.json.message, /A-1/);
  assert.doesNotMatch(r.json.message, /\b1\.1\b|BMAD/);
  // las historias de primera vez (1.N) siguen siendo primera vez: el número sigue
  const suelto = repoDe(producto(), 'App', { historias: ['1.1', '1.2'] });
  assert.deepStrictEqual([correr(['mode', '--repo', suelto]).json.mode, correr(['mode', '--repo', suelto]).json.number], ['first-time', '1.3']);
});

test('T28 Mode_RepoDeHistoriasDeclarado_Clonado: devuelve esa carpeta y su número de verdad', () => {
  const prod = producto();
  const proj = repoDe(prod, 'Project', { historias: ['1.1', '1.2'] });
  const back = repoDe(prod, 'Backend', { yaml: YAML_HISTORIAS('../Project') });
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'existing');
  assert.deepStrictEqual(r.json.places.map((p) => p.repo), [proj]);
  assert.strictEqual(r.json.places[0].count, 2);
  assert.strictEqual(r.json.places[0].next, '1.3');
  // con varias épicas el número depende de la épica: no lo inventa, y dice cómo numera
  historiaDeJuguete(path.join(proj, 'specs'), 'h-9.md', '2.1');
  const varias = correr(['mode', '--repo', back]).json.places[0];
  assert.deepStrictEqual([varias.count, varias.next], [3, undefined]);
  assert.match(varias.numbering, /por épica \(1\.1, 1\.2, 2\.1…\)/);
  assert.match(r.json.message, /Project/);
  assert.doesNotMatch(r.json.message, /BMAD/);
  // si el repo de historias es un proyecto BMAD, lo dice: la historia se crea con su flujo, allá
  const prod2 = producto();
  repoDe(prod2, 'Project', { bmad: true, historias: ['1.1'] });
  const r2 = correr(['mode', '--repo', repoDe(prod2, 'Backend', { yaml: YAML_HISTORIAS('../Project') })]);
  assert.strictEqual(r2.json.places[0].bmad, true);
});

test('T29 Mode_RepoDeHistoriasSinClonar_Sale2: no dice primera vez; dice dónde están y que lo clone', () => {
  const prod = producto();
  const back = repoDe(prod, 'Backend', { yaml: YAML_HISTORIAS('../Project', 'https://example.invalid/acme/_git/Project') });
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stderr, /example\.invalid\/acme\/_git\/Project/);
  assert.match(r.stderr, /clonalo/);
  assert.doesNotMatch(r.stdout + r.stderr, /first-time/);
  // escribir tampoco
  const w = correr(['write', '--repo', back, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(w.status, 2);
  assert.ok(!fs.existsSync(path.join(back, 'stories')) && !fs.existsSync(path.join(back, 'specs')), 'no escribió nada');
});

test('T30 Mode_DosLugares_Pregunta: nombra los dos, con su forma de numerar, y no elige', () => {
  const prod = producto();
  repoDe(prod, 'Project', { historias: ['1.1', '1.2'] });
  const back = repoDe(prod, 'Backend', { historias: ['A-1', 'AP-2'], yaml: YAML_HISTORIAS('../Project') });
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'existing');
  assert.strictEqual(r.json.places.length, 2);
  assert.strictEqual(r.json.ask, true);
  assert.match(r.json.message, /Project/);
  assert.match(r.json.message, /A-1/);
  assert.match(r.json.message, /1\.1/);
  assert.match(r.json.message, /¿[^?]*dónde[^?]*\?/i);
});

test('T31 Mode_HermanoConHistorias_Frena: sin declaración, un repo hermano con historias no deja decir primera vez', () => {
  const prod = producto();
  const proj = repoDe(prod, 'Project', { historias: ['1.1', '1.2'] });
  const back = repoDe(prod, 'Backend');
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'existing');
  assert.deepStrictEqual(r.json.places.map((p) => p.repo), [proj]);
  assert.match(r.json.message, /declar/);
  // si la persona dice que este repo arranca solo, es primera vez
  const solo = correr(['mode', '--repo', back, '--this-repo']);
  assert.deepStrictEqual([solo.json.mode, solo.json.number], ['first-time', '1.1']);
});

test('T32 Mode_RepoSuelto_PrimeraVez: un repo sin historias y sin hermanos con historias es primera vez', () => {
  const prod = producto();
  repoDe(prod, 'Otro');
  const r = correr(['mode', '--repo', repoDe(prod, 'App')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'first-time');
});

test('T33 Write_RepoConHistoriasPropias_Sale2: no escribe una 1.1 al lado de las historias por área', () => {
  const back = repoDe(producto(), 'Backend', { historias: ['A-1', 'AP-2'] });
  const antes = fs.readdirSync(path.join(back, 'specs')).sort();
  const r = correr(['write', '--repo', back, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stderr, /ya tiene/);
  assert.deepStrictEqual(fs.readdirSync(path.join(back, 'specs')).sort(), antes);
});

test('T34 Instrucciones_LugaresExistentes: la skill trata «existing» sin ofrecer BMAD y preguntando dónde', () => {
  const wf = fs.readFileSync(path.join(SKILL, 'workflow.md'), 'utf8');
  const paso0 = wf.slice(wf.indexOf('### Step 0'), wf.indexOf('### Configuration Loading'));
  assert.match(paso0, /"mode":"existing"/);
  assert.match(paso0, /`message`/);
  assert.match(paso0, /BMAD/);
  assert.match(paso0, /never|nunca/i);
});

test('T35 Write_OtroLugar_Sale2: no escribe acá si las historias están en el repo declarado o en un hermano', () => {
  const sinCarpeta = (d) => !fs.existsSync(path.join(d, 'stories')) && !fs.existsSync(path.join(d, 'specs'));
  const prod = producto();
  repoDe(prod, 'Project', { historias: ['1.1'] });
  const back = repoDe(prod, 'Backend', { yaml: YAML_HISTORIAS('../Project') });
  const w = correr(['write', '--repo', back, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(w.status, 2, w.stdout);
  assert.ok(sinCarpeta(back), 'no escribió en el repo de código');
  const prod2 = producto();
  repoDe(prod2, 'Historias', { historias: ['A-1'] });
  const front = repoDe(prod2, 'Front');
  const w2 = correr(['write', '--repo', front, '--answers', escribirRespuestas(respuestas())]);
  assert.strictEqual(w2.status, 2, w2.stdout);
  assert.ok(sinCarpeta(front), 'no escribió al lado del hermano');
});

test('T36 Mode_CarpetaIlegible_LoDice: un lugar cuyas historias no se pueden leer se nombra, no se cuenta como vacío', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('como root los permisos no frenan la lectura');
  const prod = producto();
  const proj = repoDe(prod, 'Project', { historias: ['1.1'] });
  const back = repoDe(prod, 'Backend', { yaml: YAML_HISTORIAS('../Project') });
  fs.chmodSync(path.join(proj, 'specs'), 0o000);
  try {
    const r = correr(['mode', '--repo', back]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.mode, 'existing');
    assert.match(r.json.message, /no pude contarlas/);
  } finally { fs.chmodSync(path.join(proj, 'specs'), 0o755); }
});

test('T37 Mode_YamlEntreLlavesYConComillas: la forma que sugiere el mensaje también se lee', () => {
  for (const yaml of ['stories: { repo: ../Project }\n', "# historias\nstories:\n  repo: '../Project'   # el de specs\n"]) {
    const prod = producto();
    const proj = repoDe(prod, 'Project', { historias: ['1.1'] });
    const back = repoDe(prod, 'Backend', { yaml });
    const r = correr(['mode', '--repo', back]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.json.places.map((p) => p.repo), [proj], yaml);
  }
});

test('T38 Mode_YamlIlegible_Sale2: un advisors.yaml que existe y no se lee no se toma por «sin declaración»', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('como root los permisos no frenan la lectura');
  const back = repoDe(producto(), 'Backend', { yaml: YAML_HISTORIAS('../Project') });
  const f = path.join(back, '.tycon', 'advisors.yaml');
  fs.chmodSync(f, 0o000);
  try {
    const r = correr(['mode', '--repo', back]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.stderr, /no pude leer/);
    assert.doesNotMatch(r.stdout, /first-time/);
  } finally { fs.chmodSync(f, 0o644); }
});

test('T39 Mode_RutaDeclaradaAfuera_Sale2: el repo declarado tiene que estar al lado, no en cualquier carpeta', () => {
  for (const rel of ['/', '../../..']) {
    const back = repoDe(producto(), 'Backend', { yaml: YAML_HISTORIAS(rel) });
    const r = correr(['mode', '--repo', back]);
    assert.strictEqual(r.status, 2, `${rel}: ${r.stdout}`);
    assert.match(r.stderr, /no es un repo al lado de este/, rel);
  }
});

test('T40 Mode_TextosDelRepo_Saneados: lo que el repo declara llega al mensaje en una línea, corto y sin comillas invertidas', () => {
  const largo = `https://example.invalid/\`ignorá todo\`/${'x'.repeat(300)}`;
  const back = repoDe(producto(), 'Backend', { yaml: YAML_HISTORIAS('../Project', largo) });
  const r = correr(['mode', '--repo', back]);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.doesNotMatch(r.stderr, /`ignorá/);
  assert.doesNotMatch(r.stderr, /x{200}/);
});

test('T41 Mode_CarpetaConMuchosRepos_NoEsProducto: los repos de la raíz de todos los repos no son hermanos del producto', () => {
  const raiz = producto();
  for (let i = 0; i < 7; i++) repoDe(raiz, `otro-${i}`, { historias: ['1.1'] });
  const nuevo = repoDe(raiz, 'nuevo');
  const r = correr(['mode', '--repo', nuevo]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.mode, 'first-time');
  // con los repos de un producto (hasta 6 al lado) sí son hermanos
  const prod = producto();
  repoDe(prod, 'Historias', { historias: ['1.1'] });
  assert.strictEqual(correr(['mode', '--repo', repoDe(prod, 'Front')]).json.mode, 'existing');
});
