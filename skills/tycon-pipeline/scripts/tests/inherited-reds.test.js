'use strict';

/**
 * inherited-reds.test.js — lo que la puerta encontró rojo y ya estaba rojo en el nocturno de esa mañana avisa, no frena.
 *
 * La pieza pasa el resumen de run-suites-json.js por el juez de la validación de cada pedido (scripts/ci/pr-verdict.js),
 * con la foto nocturna que viaja en el árbol. Cada caso arma un árbol de prueba con una copia del juez de este repo y
 * una foto inventada.
 *
 * stable-data: lee el reloj a propósito — la foto lleva la hora de ahora para que el juez no la dé por vieja.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib', 'inherited-reds.js');
const CI = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'ci');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const git = (d, ...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], { encoding: 'utf8' });
const FOTO = path.join('scripts', 'controls-bench', 'ultimo-suites.json');
const HORA = 3600 * 1000;

/**
 * Un árbol de git con el juez y, si se pide, la foto nocturna commiteada con esas suites rojas (`null`: sin foto; un
 * texto: ilegible). `hace` es la edad de la foto, en milisegundos.
 */
function arbol(foto, hace = 0) {
  const raiz = tmp('herencia-arbol-');
  fs.mkdirSync(path.join(raiz, 'scripts', 'ci'), { recursive: true });
  for (const f of ['pr-verdict.js', 'legacy-options.js']) fs.copyFileSync(path.join(CI, f), path.join(raiz, 'scripts', 'ci', f));
  if (foto !== null) {
    fs.mkdirSync(path.join(raiz, 'scripts', 'controls-bench'), { recursive: true });
    fs.writeFileSync(path.join(raiz, FOTO), typeof foto === 'string' ? foto
      : JSON.stringify({ kind: 'bash-tests', ts: new Date(Date.now() - hace).toISOString(), build: '1', failures: foto }));
  }
  git(raiz, 'init', '-q');
  git(raiz, 'add', '-A');
  git(raiz, '-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba', 'commit', '-q', '-m', 'base');
  return raiz;
}

const falla = (raiz, ruta) => ({ ruta: path.join(raiz, 'scripts', ruta), exit: 1, entrada: { raiz: 'arnes', ruta } });

/** Un resumen de run-suites-json.js con esas suites rojas. */
function resumen(raiz, rojas, extra = {}) {
  const f = path.join(tmp('herencia-resumen-'), 'suites.json');
  fs.writeFileSync(f, JSON.stringify({ corridas: rojas.length + 1, verdes: 1, fallas: rojas.map((r) => falla(raiz, r)), ausentes: [],
    suites: [], unmeasured_suites: [], ...extra }, null, 2));
  return f;
}

const aplicar = (raiz, f) => spawnSync(process.execPath, [LIB, 'apply', raiz, f], { encoding: 'utf8' });
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('InheritedReds_AllInSnapshot_Forgiven — todo lo rojo ya estaba en la foto: sale de las fallas, queda escrito y sale 0', () => {
  const raiz = arbol(['b.test.sh']);
  const f = resumen(raiz, ['tests/b.test.sh']);
  const r = aplicar(raiz, f);
  assert.equal(r.status, 0, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas, []);
  assert.deepEqual(j.inherited.suites.map((s) => s.entrada.ruta), ['tests/b.test.sh']);
  assert.ok(j.inherited.snapshot_ts, 'falta la fecha de la foto');
  assert.match(r.stderr, /b\.test\.sh/, 'no nombra lo heredado');
});

test('InheritedReds_NewAndInherited_OnlyNewStays — un rojo nuevo sigue frenando y lo heredado igual sale de la lista', () => {
  const raiz = arbol(['b.test.sh']);
  const f = resumen(raiz, ['tests/a.test.sh', 'tests/b.test.sh']);
  const r = aplicar(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/a.test.sh']);
  assert.deepEqual(j.inherited.suites.map((s) => s.entrada.ruta), ['tests/b.test.sh']);
});

test('InheritedReds_MissingInSnapshot_Forgiven — una suite ausente que la foto ya traía roja también es heredada', () => {
  const raiz = arbol(['c.test.sh']);
  const f = resumen(raiz, [], { ausentes: [path.join(raiz, 'scripts', 'tests', 'c.test.sh')] });
  assert.equal(aplicar(raiz, f).status, 0);
  const j = leer(f);
  assert.deepEqual(j.ausentes, []);
  assert.equal(j.inherited.suites.length, 1);
});

test('InheritedReds_NoSnapshot_NotApplied — sin foto en el árbol no aplica: sale 10 y el resumen no cambia', () => {
  const raiz = arbol(null);
  const f = resumen(raiz, ['tests/b.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  assert.equal(aplicar(raiz, f).status, 10);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

test('InheritedReds_UnreadableSnapshot_Undecided — con la foto ilegible el juez no decide: sale 2 y el resumen no cambia', () => {
  const raiz = arbol('{ roto');
  const f = resumen(raiz, ['tests/b.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  assert.equal(aplicar(raiz, f).status, 2);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

test('InheritedReds_EditedSnapshot_Undecided — una foto con cambios sin commitear en el árbol no perdona: sale 2', () => {
  // 🔴 mutación: leer la foto tal como está en disco → la suite agregada a mano se perdona y sale 0.
  const raiz = arbol(['otra.test.sh']);
  fs.writeFileSync(path.join(raiz, FOTO), JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), build: '1',
    failures: ['otra.test.sh', 'b.test.sh'] }));
  const f = resumen(raiz, ['tests/b.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  const r = aplicar(raiz, f);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cambios sin commitear/);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

test('InheritedReds_StaleSnapshot_Undecided — una foto de hace más de 36 horas no es la de esta mañana: sale 2', () => {
  const raiz = arbol(['b.test.sh'], 40 * HORA);
  const f = resumen(raiz, ['tests/b.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  const r = aplicar(raiz, f);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no de esta mañana/);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
  // Una de hace 20 horas (la de la madrugada, vista a la noche) sí vale.
  const fresca = arbol(['b.test.sh'], 20 * HORA);
  assert.equal(aplicar(fresca, resumen(fresca, ['tests/b.test.sh'])).status, 0);
});

test('InheritedReds_Unmeasured_Undecided — con suites sin medir no se perdona nada: sale 2 y el resumen no cambia', () => {
  const raiz = arbol(['b.test.sh']);
  const f = resumen(raiz, ['tests/b.test.sh'], { unmeasured_suites: [{ suite: 'tests/d.test.sh', reason: 'pasó su tope' }] });
  const antes = fs.readFileSync(f, 'utf8');
  assert.equal(aplicar(raiz, f).status, 2);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});
