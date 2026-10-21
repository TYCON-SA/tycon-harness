#!/usr/bin/env node
/**
 * lint-story-frontmatter.test.js — el lint tiene que ver las stories DEL REPO, no sólo las que
 * están en `specs/stories/`.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * El lint protege contra el peor modo de falla del harness: una story cuyo frontmatter no se
 * puede leer no da error — **desaparece en silencio** del validator, del backfill, de los
 * scripts de status y del hook de DoD.
 *
 * Pero decidir QUÉ lintear por la RUTA (`<repo>/specs/stories/`) no alcanza: en un repo con
 * otro layout el lint no miraría nada y diría "✅ OK": el
 * control que existe para que nada se pierda en silencio, perdiéndose en silencio.
 *
 * Por eso "esto es una story" es una decisión ESTRUCTURAL:
 *   (a) el archivo vive en una carpeta donde YA hay stories legibles, o
 *   (b) su frontmatter declara alguno de `story:` / `epic:` / `status:`.
 * (a) es la que importa: una story ROTA no se puede reconocer por sus campos —justamente porque
 * están rotos— pero sí por la compañía en la que vive.
 *
 * Correr: node --test scripts/tests/lint-story-frontmatter.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LINT = path.join(RAIZ, 'scripts', 'lib', 'lint-story-frontmatter.js');

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}
function story(root, rel, fm) {
  return write(root, rel, `---\n${fm.join('\n')}\n---\n\n# story\n`);
}
function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [LINT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('lint: encuentra las stories del repo aunque no vivan en specs/stories/', () => {
  const root = mkRepo('lint-layout-');
  story(root, 'specs/bizuit-bpmn-mcp/4-42-sana.md', ['story: "4.42"', 'epic: 4', 'status: done']);
  // Rota: el frontmatter NUNCA cierra → el harness la saltea en silencio.
  write(root, 'specs/bizuit-bpmn-mcp/4-43-rota.md', '---\nstory: "4.43"\nepic: 4\nstatus: done\n\n# sin cierre\n');

  const r = run([], root);

  assert.equal(r.code, 1, `tiene que fallar: hay una story ilegible\n${r.out}`);
  assert.match(r.out, /4-43-rota\.md/, 'y nombrarla');
  assert.match(r.out, /frontmatter NO cierra/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: una story rota se reconoce por la COMPAÑÍA, no por sus campos', () => {
  // Es el caso que (b) sola no puede cubrir: si los campos están rotos, no hay campo que mirar.
  const root = mkRepo('lint-vecindad-');
  story(root, 'docs/epicas/1-1-sana.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  write(root, 'docs/epicas/1-2-rota.md', '---\nstory: "1.2"\nepic: 1\nstatus: done\n\n# sin cierre\n');
  // Un .md cualquiera en OTRA carpeta, con frontmatter que no es de story: no se lintea.
  write(root, 'docs/guias/como-desplegar.md', '---\ntitle: "guía"\n---\n\n# nada que ver\n');

  const r = run([], root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1-2-rota\.md/);
  assert.ok(!/como-desplegar/.test(r.out), `un doc que no es story no se lintea:\n${r.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: con el repo sano dice OK y CUÁNTAS revisó (un cero no es un OK)', () => {
  const root = mkRepo('lint-ok-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  story(root, 'specs/mcp/1-2-b.md', ['story: "1.2"', 'epic: 1', 'status: ready-for-dev']);

  const r = run([], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 revisadas/, `tiene que decir cuántas miró — "OK" sobre cero archivos no es OK:\n${r.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: por argumentos, filtra lo que NO es story (el hook puede pasarle todos los .md)', () => {
  const root = mkRepo('lint-args-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  const doc = write(root, 'README.md', '---\ntitle: "léeme"\n---\n\n# hola\n');
  const codigo = write(root, 'CHANGELOG.md', '# cambios\n');

  const r = run([path.join(root, 'specs/mcp/1-1-a.md'), doc, codigo], root);

  assert.equal(r.code, 0, `un README con frontmatter propio no puede reportarse como story rota:\n${r.out}`);
  assert.match(r.out, /1 revisadas/, 'sólo la story cuenta');

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: la evidencia de QA (specs/qa/<sid>-legibilidad.md, con «veredicto:») no es una story, aunque declare `story:`', () => {
  const root = mkRepo('lint-qa-');
  story(root, 'specs/story-2.1-primera.md', ['epic: 2', 'story: "2.1"', 'status: done']);
  // lo que deja la revisión de legibilidad: la identidad de la story a la que pertenece y el veredicto, nada de epic ni status
  const legibilidad = story(root, 'specs/qa/2.1-legibilidad.md', ['story: "2.1"', 'veredicto: OK', 'marcas: 3', 'resueltas: 3']);
  const ui = story(root, 'specs/qa/2.1-legibilidad-ui.md', ['story: "2.1"', 'veredicto: OK']);

  const todo = run([], root);
  assert.equal(todo.code, 0, `el repo con una revisión de legibilidad está sano:\n${todo.out}`);
  assert.match(todo.out, /1 revisadas/, 'sólo la story cuenta, no su evidencia de QA');
  const porArgumentos = run([legibilidad, ui], root);
  assert.equal(porArgumentos.code, 0, `pasada por argumento tampoco se lintea:\n${porArgumentos.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: una story de verdad dentro de una carpeta qa/ (sin «veredicto:») sigue linteándose', () => {
  const root = mkRepo('lint-qa2-');
  const rota = story(root, 'qa/3-1-roto.md', ['story: "3.1"', 'status: ready-for-dev']);   // le falta epic:
  const sin = story(root, 'specs/qa/3.2-sin-veredicto.md', ['story: "3.2"', 'marcas: 1']);   // declara story: y no es evidencia

  const r = run([rota, sin], root);
  assert.equal(r.code, 1, `sin «veredicto:» sigue siendo una story, y está rota:\n${r.out}`);
  assert.match(r.out, /epic/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: un archivo pasado por argumento que SÍ declara campos de story se lintea igual', () => {
  const root = mkRepo('lint-args2-');
  // Sin vecinas legibles: la única señal es que declara `story:`. Y le falta `epic:`.
  const rota = story(root, 'nuevo/2-1-primera.md', ['story: "2.1"', 'status: ready-for-dev']);

  const r = run([rota], root);
  assert.equal(r.code, 1, `le falta epic: y tiene que cazarlo\n${r.out}`);
  assert.match(r.out, /epic/);

  fs.rmSync(root, { recursive: true, force: true });
});

// ── T23 · R3_Lib_MovedRequires ─────────────────────────────────────────────────────────
// El lint vive en scripts/lib/: compila desde ahí, cada ruta relativa que escribe (`require('./x')`, o
// `path.join(__dirname, …)`) apunta a un archivo que existe —sus vecinos no llevan `lib/` adelante y el vocabulario de
// causas queda un nivel más arriba—, y lintea una story de juguete con `followup_reason:` sin perder el vocabulario. En
// la ruta de siempre queda el reemplazo generado (lo llaman los pre-commit de producto y agent-skills); esa ruta sale del
// mapa, y la copia pública, que no lo lleva, lo dice.

/** Las rutas relativas escritas en `file`: `require('./x')`, `require('../x')` y `path.join|resolve(__dirname, 'a', …)`. */
function relativePaths(file) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const out = [];
  for (const m of src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) out.push({ spec: m[2], abs: path.resolve(dir, m[2]) });
  for (const m of src.matchAll(/path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]+\2)+)\s*\)/g)) {
    const parts = [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]);
    out.push({ spec: `__dirname, ${parts.join(', ')}`, abs: path.resolve(dir, ...parts) });
  }
  return out;
}
const exists = (abs) => { try { require.resolve(abs); return true; } catch { return fs.existsSync(abs); } };
// Sólo la copia pública —que no lleva el mapa— se saltea. Con el mapa presente, ilegible o sin la entrada es un rojo:
// tratarlo como «copia pública» dejaría pasar en verde un reemplazo que falta.
const MAP_PATH = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const HAS_MAP = fs.existsSync(MAP_PATH);

test('T23 R3_Lib_MovedRequires — el lint compila desde scripts/lib/ y cada ruta relativa que escribe existe', () => {
  const chk = require('child_process').spawnSync(process.execPath, ['--check', LINT], { encoding: 'utf8' });
  assert.strictEqual(chk.status, 0, `compila desde scripts/lib/ (${chk.stderr})`);
  const rutas = relativePaths(LINT);
  assert.ok(rutas.length >= 4, `encontró sus rutas relativas (${rutas.length})`);
  const muertas = rutas.filter((r) => !exists(r.abs)).map((r) => r.spec);
  assert.deepStrictEqual(muertas, [], 'toda ruta relativa del lint resuelve desde scripts/lib/');
  assert.ok(!/require\(\s*path\.join\(\s*__dirname\s*,\s*['"]lib['"]/.test(fs.readFileSync(LINT, 'utf8')), 'sus vecinos de lib/ se piden sin `lib/` adelante');
});

test('T23 R3_Lib_MovedRequires — desde scripts/lib/ lintea una story de juguete y lee el vocabulario de causas', () => {
  const root = mkRepo('lint-t23-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  const nueva = story(root, 'specs/mcp/1-2-b.md',
    ['story: "1.2"', 'epic: 1', 'status: ready-for-dev', 'followup_of: "1.1"', 'followup_reason: "defecto-propio"']);
  const env = { ...process.env };
  delete env.TYCON_CAUSES_PATH;
  let r;
  try {
    r = { code: 0, out: execFileSync('node', [LINT, nueva], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { r = { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 revisadas/, r.out);
  assert.ok(!/vocabulario de causas/.test(r.out), `encuentra rework-causes.json desde scripts/lib/:\n${r.out}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('T23 R3_Lib_MovedRequires — en la ruta de siempre queda el reemplazo generado que lanza el de lib/',
  { skip: !HAS_MAP && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const L = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const R3_ENTRY = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).entries
      .find((e) => e && e.batch === 'R3' && e.new === 'scripts/lib/lint-story-frontmatter.js');
    assert.ok(R3_ENTRY, 'el mapa no tiene la entrada de scripts/lib/lint-story-frontmatter.js');
    const viejo = path.join(RAIZ, R3_ENTRY.old);
    assert.ok(fs.existsSync(viejo), `${R3_ENTRY.old} existe`);
    assert.ok(L.isGeneratedShim(R3_ENTRY.old, fs.readFileSync(viejo, 'utf8')), `${R3_ENTRY.old} es el reemplazo generado, tal cual`);
    assert.strictEqual(path.resolve(L.shimTarget(viejo)), LINT, `${R3_ENTRY.old} lanza el de scripts/lib/`);
  });
