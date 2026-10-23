'use strict';

/**
 * similar-stories.test.js — las historias cerradas más parecidas a una nueva, con sus horas reales
 * (scripts/lib/similar-stories.js). Es la base de la propuesta de estimación al escribir una historia.
 *
 * Lo que no se puede perder: sólo cuentan las historias en `done` con horas reales en el registro; cada candidata dice
 * por qué se parece; sin candidatas medidas la lista sale vacía con su motivo y nunca se inventa una. Todo en
 * laboratorios (organización acme).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'similar-stories.js');
const CLAVES = ['v', 'nivel', 'epica', 'historia', 'valor', 'min', 'max', 'unidad', 'supuestos', 'propuesto', 'base', 'quien', 'confirmo', 'ejecucion', 'cuando'];

/** Una historia de laboratorio en `specs/`; devuelve su ruta. */
function historia(repo, { id, epic, status = 'done', title, topics, files = [] }) {
  const fm = [
    '---', `epic: ${epic}`, `story: "${id}"`, `title: "${title}"`, `status: ${status}`,
    ...(topics ? [`topics: [${topics.join(', ')}]`] : []),
    ...(files.length ? ['files_to_modify:', ...files.map((f) => `  - ${f}`)] : []),
    '---', '', `# Story ${id}`, '',
  ].join('\n');
  const file = path.join(repo, 'specs', `story-${id}-algo.md`);
  fs.writeFileSync(file, fm);
  return file;
}
function fila(campos) {
  const base = Object.fromEntries(CLAVES.map((k) => [k, null]));
  return { ...base, v: 1, unidad: 'hours', quien: 'acme-lider', cuando: '2026-10-22T10:00:00.000Z', ...campos };
}
function registro(repo, filas) {
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.tycon', 'estimates.jsonl'), filas.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n') + '\n');
}
function repoVacio() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'similar-'));
  fs.mkdirSync(path.join(d, 'specs'));
  return d;
}
function correr(repo, story) {
  const r = spawnSync(process.execPath, [CLI, '--repo', repo, '--story', story, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** El laboratorio de T10: seis cerradas con horas reales y la historia nueva. */
function laboratorio() {
  const repo = repoVacio();
  const cerradas = [
    { id: '3.1', epic: 3, title: 'El tablero de pedidos por cliente', topics: ['pedidos'], files: ['src/pedidos.js'] },
    { id: '3.2', epic: 3, title: 'Exportar el informe semanal' },
    { id: '4.1', epic: 4, title: 'Los pedidos atrasados en el tablero', files: ['src/pedidos.js'] },
    { id: '4.2', epic: 4, title: 'Notificar pedidos vencidos', topics: ['pedidos'] },
    { id: '5.1', epic: 5, title: 'Tablero de facturas' },
    { id: '5.2', epic: 5, title: 'Cambiar la clave de acceso' },
    { id: '6.1', epic: 6, title: 'Un informe de pedidos del mes' },
  ];
  for (const h of cerradas) historia(repo, h);
  const filas = [];
  for (const [i, h] of cerradas.entries()) {
    filas.push(fila({ nivel: 'historia', epica: String(h.epic), historia: h.id, valor: 10 + i }));
    filas.push(fila({ nivel: 'real', epica: String(h.epic), historia: h.id, valor: 12 + i, unidad: 'hours', ejecucion: `r${i}` }));
  }
  // una segunda vuelta del cierre de la primera: sus horas reales se suman
  filas.push(fila({ nivel: 'real', epica: '3', historia: '3.1', valor: 3, unidad: 'hours', ejecucion: 'r9' }));
  registro(repo, filas);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'El tablero de pedidos por zona', topics: ['pedidos'], files: ['src/pedidos.js'] });
  return { repo, nueva };
}

test('T10 Parecidas_OrdenYMotivo @story-2.75 @ac-9', () => {
  const { repo, nueva } = laboratorio();
  const r = correr(repo, nueva);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const c = r.json.candidatas;
  assert.strictEqual(c.length, 5, 'hasta cinco');
  // la primera suma épica, tema, archivo y dos palabras; tres empatan (por la épica; por el archivo y dos palabras; por
  // el tema y una palabra) y desempata el id; dos quedan con una palabra
  assert.deepStrictEqual(c.map((x) => [x.id, x.puntaje]), [['3.1', 8], ['3.2', 3], ['4.1', 3], ['4.2', 3], ['5.1', 1]], 'por parecido');
  const [primera] = c;
  assert.deepStrictEqual(Object.keys(primera), ['id', 'titulo', 'real_horas', 'estimacion', 'motivos', 'puntaje']);
  assert.strictEqual(primera.real_horas, 15, 'las dos líneas real, sumadas');
  assert.deepStrictEqual(primera.estimacion, { valor: 10, unidad: 'hours' });
  assert.deepStrictEqual(primera.motivos, { misma_epica: true, topics: ['pedidos'], archivos: ['src/pedidos.js'], palabras: ['pedidos', 'tablero'] });
  assert.ok(c.every((x) => x.id !== '3.9'), 'nunca la historia nueva');
  assert.ok(!c.some((x) => x.id === '5.2'), 'sin nada en común no entra');
  assert.strictEqual(r.json.motivo, null);
});

test('T11 SinCerradas_ListaVacia @story-2.75 @ac-10', () => {
  const repo = repoVacio();
  historia(repo, { id: '3.1', epic: 3, status: 'review', title: 'El tablero de pedidos' });
  historia(repo, { id: '3.2', epic: 3, status: 'done', title: 'El tablero de facturas' });
  registro(repo, [fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 5 })]);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'El tablero de pedidos por zona' });
  const r = correr(repo, nueva);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual([r.json.candidatas, r.json.motivo], [[], 'sin historias cerradas con horas reales']);
  // sin registro, lo mismo
  fs.rmSync(path.join(repo, '.tycon'), { recursive: true });
  assert.deepStrictEqual(correr(repo, nueva).json.candidatas, []);
});

test('T12 SoloDone_Cuentan @story-2.75 @ac-9', () => {
  const repo = repoVacio();
  historia(repo, { id: '3.1', epic: 3, status: 'review', title: 'El tablero de pedidos' });
  registro(repo, [fila({ nivel: 'real', epica: '3', historia: '3.1', valor: 8, ejecucion: 'r1' })]);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'El tablero de pedidos por zona' });
  const r = correr(repo, nueva);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.json.candidatas, [], 'en review no cuenta aunque tenga horas');
});

test('T13 RegistroIlegible_NoInventa @story-2.75 @ac-10', () => {
  const repo = repoVacio();
  historia(repo, { id: '3.1', epic: 3, title: 'El tablero de pedidos' });
  registro(repo, ['{"v":1,', 'no es json', JSON.stringify(fila({ v: 7, nivel: 'real', epica: '3', historia: '3.1', valor: 8 }))]);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'El tablero de pedidos por zona' });
  const r = correr(repo, nueva);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual([r.json.candidatas, r.json.motivo, r.json.unreadable], [[], 'sin historias cerradas con horas reales', [1, 2, 3]]);
});

test('Parecidas_EntradaInvalida_Sale2 @story-2.75 @ac-9', () => {
  const repo = repoVacio();
  const r = correr(repo, path.join(repo, 'specs', 'no-existe.md'));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.json.reason, /no-existe\.md/);
  const sinRepo = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8' });
  assert.strictEqual(sinRepo.status, 2);
});

// ── el frontmatter como lo escriben las historias de verdad ─────────────────────────────────────

test('Rasgos_ListasConComentarios_NoSeCortan @story-2.75 @ac-9', () => {
  const S = require(CLI);
  const r = S.rasgos([
    '---', 'epic: 3', 'story: "3.1"', 'title: "La historia"',
    'topics: [estimaciones, reloj]  # temas de la wiki',
    'files_to_create:', '  # público', '  - scripts/lib/a.js            # el registro', '', '  - scripts/lib/b.js',
    'files_to_modify:', '  # privado', '  - "specs/sprint-status.yaml"',
    'status: done', '---', '',
  ].join('\n'));
  assert.deepStrictEqual(r.archivos, ['scripts/lib/a.js', 'scripts/lib/b.js', 'specs/sprint-status.yaml']);
  assert.deepStrictEqual(r.topics, ['estimaciones', 'reloj']);
  const bloque = S.rasgos(['---', 'topics:', '  # de la wiki', '  - alfa  # el primero', '  - beta', 'status: done', '---'].join('\n'));
  assert.deepStrictEqual(bloque.topics, ['alfa', 'beta']);
});

test('Rasgos_TituloConComillas_SeLee @story-2.75 @ac-9', () => {
  const S = require(CLI);
  assert.strictEqual(S.rasgos('---\ntitle: "La regla \'BZURL\' cambia la URL"\n---\n').titulo, "La regla 'BZURL' cambia la URL");
  assert.strictEqual(S.rasgos("---\ntitle: Don't romper el registro\n---\n").titulo, "Don't romper el registro");
  assert.strictEqual(S.rasgos('---\ntitle: "El \\"freno\\" de estimaciones"\n---\n').titulo, 'El "freno" de estimaciones');
  assert.strictEqual(S.rasgos("---\ntitle: 'It''s the clock'\n---\n").titulo, "It's the clock");
  assert.strictEqual(S.rasgos('---\ntitle: El tablero  # provisorio\n---\n').titulo, 'El tablero');
});

test('Parecidas_RepetidosCuentanUnaVez @story-2.75 @ac-9', () => {
  const repo = repoVacio();
  const doble = path.join(repo, 'specs', 'story-3.1-algo.md');
  fs.writeFileSync(doble, ['---', 'epic: 4', 'story: "3.1"', 'title: "Algo distinto"', 'status: done', 'topics: [pedidos, pedidos]',
    'files_to_create:', '  - src/pedidos.js', 'files_to_modify:', '  - src/pedidos.js', '---', ''].join('\n'));
  registro(repo, [fila({ nivel: 'real', epica: '4', historia: '3.1', valor: 8, ejecucion: 'r1' })]);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'Otra cosa', topics: ['pedidos'], files: ['src/pedidos.js'] });
  const [c] = correr(repo, nueva).json.candidatas;
  assert.deepStrictEqual([c.motivos.topics, c.motivos.archivos, c.puntaje], [['pedidos'], ['src/pedidos.js'], 3], 'un tema 2 + un archivo 1');
});

test('Parecidas_NoSePudoBuscar_Sale3 @story-2.75 @ac-11', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const S = require(CLI);
  const { repo, nueva } = laboratorio();
  const incompleta = { discoverStories: () => ({ stories: [], partial: true }), declaredStoryId: () => '3.9' };
  assert.throws(() => S.similar(repo, nueva, incompleta), (e) => e.code === 3 && /no terminó/.test(e.message));
  const reg = path.join(repo, '.tycon', 'estimates.jsonl');
  fs.chmodSync(reg, 0o200);
  try {
    const r = correr(repo, nueva);
    assert.strictEqual(r.status, 3, r.stdout);
    assert.match(r.json.reason, /no pude leer/);
  } finally { fs.chmodSync(reg, 0o644); }
});

test('Parecidas_TextoDiceLasIlegibles @story-2.75 @ac-10', () => {
  const repo = repoVacio();
  registro(repo, ['no es json']);
  const nueva = historia(repo, { id: '3.9', epic: 3, status: 'draft', title: 'Algo' });
  const r = spawnSync(process.execPath, [CLI, '--repo', repo, '--story', nueva], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /sin historias cerradas con horas reales/);
  assert.match(r.stdout, /ilegibles: 1/);
});
