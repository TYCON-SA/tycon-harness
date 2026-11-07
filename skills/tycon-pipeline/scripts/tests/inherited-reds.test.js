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

// Los casos de la foto miden sólo la foto: la medición en la base queda apagada (la prueban los casos «Heredado_MedidoEnMainEnElMomento»).
const aplicar = (raiz, f) => spawnSync(process.execPath, [LIB, 'apply', raiz, f], { encoding: 'utf8',
  env: { ...process.env, TYCON_INHERITED_BASE_MAX: '0' } });
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

// ── Medido en la base, en el momento ────────────────────────────────────────────────────────────────────────────────
// Un rojo que la foto no perdona se corre solo sobre la base (`git merge-base HEAD origin/main`), sin el cambio: rojo
// ahí también es heredado; verde, no; sin poder medirlo, sigue rojo y dice «no medido» con el motivo.
const autor = ['-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba'];
const suiteQueSale = (codigo, extra = '') => `#!/usr/bin/env bash\n${extra}\nexit ${codigo}\n`;

/**
 * Un clon con `origin/main` (la base: a.test.sh roja, b.test.sh verde, s.test.sh que tarda) y una rama con el cambio
 * (b.test.sh pasa a roja y llega n.test.sh, nueva y roja). `foto`: las suites rojas de la foto nocturna, o null.
 */
function conBase({ foto = null } = {}) {
  const remoto = tmp('herencia-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const raiz = tmp('herencia-clon-');
  git(raiz, 'init', '-q', '-b', 'main');
  git(raiz, 'remote', 'add', 'origin', remoto);
  const t = path.join(raiz, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  const lista = (nombres) => JSON.stringify({ diarias: nombres.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })), semanales: [] });
  fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 's']));
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1));
  fs.writeFileSync(path.join(t, 'b.test.sh'), suiteQueSale(0));
  fs.writeFileSync(path.join(t, 's.test.sh'), suiteQueSale(1, 'sleep 30'));
  if (foto) {
    fs.mkdirSync(path.join(raiz, 'scripts', 'ci'), { recursive: true });
    for (const f of ['pr-verdict.js', 'legacy-options.js']) fs.copyFileSync(path.join(CI, f), path.join(raiz, 'scripts', 'ci', f));
    fs.mkdirSync(path.join(raiz, 'scripts', 'controls-bench'), { recursive: true });
    fs.writeFileSync(path.join(raiz, FOTO), JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), build: '1', failures: foto }));
  }
  git(raiz, 'add', '-A'); git(raiz, ...autor, 'commit', '-q', '-m', 'base');
  git(raiz, 'push', '-q', 'origin', 'main');
  git(raiz, 'fetch', '-q', 'origin');
  git(raiz, 'checkout', '-q', '-b', 'cambio');
  fs.writeFileSync(path.join(t, 'b.test.sh'), suiteQueSale(1));
  fs.writeFileSync(path.join(t, 'n.test.sh'), suiteQueSale(1));
  fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 'n', 's']));
  git(raiz, 'add', '-A'); git(raiz, ...autor, 'commit', '-q', '-m', 'el cambio');
  return raiz;
}

const enLaBase = (raiz, f, env = {}, args = []) => spawnSync(process.execPath, [LIB, 'apply', raiz, f, ...args], { encoding: 'utf8',
  env: { ...process.env, TYCON_INHERITED_BASE_MAX: '', TYCON_INHERITED_BASE_TIMEOUT_S: '', TYCON_SKILLS_DIR: '', TYCON_GATE_ALL_SUITES: '', ...env } });
const veredicto = (j, ruta) => (j.base_check.suites.find((s) => s.ruta === ruta) || {});
const baseSinRestos = (raiz) => assert.equal(git(raiz, 'worktree', 'list').stdout.trim().split('\n').length, 1, 'quedó el árbol de la base');

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — sin foto: rojo en la base es heredada; verde en la base sigue roja; nueva, «no medido»', () => {
  // 🔴 mutación: tomar «distinto de 0» como rojo en la base, o no mirar la base → b o n salen heredadas.
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh', 'tests/b.test.sh', 'tests/n.test.sh']);
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/b.test.sh', 'tests/n.test.sh'], r.stderr);
  assert.deepEqual(j.inherited.suites.map((s) => [s.entrada.ruta, s.measured_on]), [['tests/a.test.sh', 'base']]);
  assert.equal(j.inherited.snapshot_ts, null, 'sin foto, la cabecera no tiene fecha de foto');
  assert.match(j.inherited.base.sha, /^[0-9a-f]{40}$/);
  assert.equal(j.base_check.base, j.inherited.base.sha);
  assert.equal(veredicto(j, 'tests/a.test.sh').verdict, 'heredada');
  assert.equal(veredicto(j, 'tests/b.test.sh').verdict, 'no-heredada');
  assert.equal(veredicto(j, 'tests/n.test.sh').verdict, 'no-medido');
  assert.match(veredicto(j, 'tests/n.test.sh').motivo, /la suite no está en la base/);
  assert.match(r.stderr, /a\.test\.sh/);
  baseSinRestos(raiz);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — con foto: lo que la foto perdona queda «snapshot», el resto se mide en la base', () => {
  const raiz = conBase({ foto: ['b.test.sh'] });
  const f = resumen(raiz, ['tests/a.test.sh', 'tests/b.test.sh']);
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 0, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas, []);
  assert.deepEqual(j.inherited.suites.map((s) => [s.entrada.ruta, s.measured_on]).sort(), [['tests/a.test.sh', 'base'], ['tests/b.test.sh', 'snapshot']]);
  assert.ok(j.inherited.snapshot_ts, 'perdió la fecha de la foto');
  assert.ok(j.inherited.base, 'no dice de qué base salió la otra');
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — el tope de suites y el de segundos dejan «no medido», en el orden del resumen', () => {
  const raiz = conBase();
  const f = resumen(raiz, ['tests/s.test.sh', 'tests/a.test.sh', 'tests/b.test.sh']);
  // 5 s: a.test.sh se mide en menos de 1 s aun con la máquina cargada; s.test.sh tarda 30
  const r = enLaBase(raiz, f, { TYCON_INHERITED_BASE_MAX: '2', TYCON_INHERITED_BASE_TIMEOUT_S: '5' });
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  // s tarda 30 s: la corta el tope, y no es heredada aunque saldría roja
  assert.equal(veredicto(j, 'tests/s.test.sh').verdict, 'no-medido');
  assert.match(veredicto(j, 'tests/s.test.sh').motivo, /pasó el tope de 5 s/);
  assert.equal(veredicto(j, 'tests/a.test.sh').verdict, 'heredada');
  assert.equal(veredicto(j, 'tests/b.test.sh').verdict, 'no-medido');
  assert.match(veredicto(j, 'tests/b.test.sh').motivo, /pasó del tope de 2 suites/);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/s.test.sh', 'tests/b.test.sh']);
  baseSinRestos(raiz);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — sin base que medir: sin origin/main, el árbol es la base, una ausente, el árbol armado, no es git', () => {
  const casos = [];
  // sin origin/main
  const sinRemoto = arbol(null);
  casos.push([sinRemoto, resumen(sinRemoto, ['tests/a.test.sh']), [], /no hay origin\/main/]);
  // el árbol es la base, sin cambios
  const igual = conBase();
  git(igual, 'checkout', '-q', '--detach', 'origin/main');
  casos.push([igual, resumen(igual, ['tests/a.test.sh']), [], /el árbol es la base, sin cambios/]);
  // el árbol armado del privado
  const armado = conBase();
  casos.push([armado, resumen(armado, ['tests/a.test.sh']), ['--assembled'], /el árbol armado del privado mezcla dos repos/]);
  // una carpeta que no es git
  const suelta = tmp('herencia-suelta-');
  casos.push([suelta, resumen(suelta, ['tests/a.test.sh']), [], /no es un repo de git/]);
  for (const [raiz, f, args, motivo] of casos) {
    const r = enLaBase(raiz, f, {}, args);
    assert.equal(r.status, 1, r.stderr);
    const j = leer(f);
    assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/a.test.sh'], `${raiz}: ${r.stderr}`);
    assert.equal(veredicto(j, 'tests/a.test.sh').verdict, 'no-medido');
    assert.match(veredicto(j, 'tests/a.test.sh').motivo, motivo);
  }
  // una ausente no se mide: sigue roja
  const aus = conBase();
  const f = resumen(aus, [], { ausentes: [path.join(aus, 'scripts', 'tests', 'a.test.sh')] });
  const r = enLaBase(aus, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.equal(j.ausentes.length, 1);
  assert.match(j.base_check.suites[0].motivo, /la suite no existe en el cambio/);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — con la foto que no sirve, lo rojo se mide en la base', () => {
  // 🔴 mutación: con la foto ilegible devolver «no se perdona nada» sin medir → a.test.sh sigue roja.
  const raiz = conBase({ foto: ['otra.test.sh'] });
  fs.writeFileSync(path.join(raiz, FOTO), '{ roto');
  git(raiz, 'add', '-A'); git(raiz, ...autor, 'commit', '-q', '-m', 'foto ilegible');
  const f = resumen(raiz, ['tests/a.test.sh', 'tests/b.test.sh']);
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no se deja leer.*lo rojo se mide en la base/);
  const j = leer(f);
  assert.deepEqual(j.inherited.suites.map((s) => [s.entrada.ruta, s.measured_on]), [['tests/a.test.sh', 'base']]);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/b.test.sh']);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — la base que no se arma y la lista de la base ilegible: «no medido» con su motivo', () => {
  // git worktree add no puede escribir su registro: la base no se arma
  const raiz = conBase();
  fs.writeFileSync(path.join(raiz, '.git', 'worktrees'), 'no es una carpeta');
  const f = resumen(raiz, ['tests/a.test.sh']);
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  assert.match(veredicto(leer(f), 'tests/a.test.sh').motivo, /no se pudo armar la base/);
  // la lista de suites de la base rota: no es «la suite no está en la base»
  const remoto = tmp('herencia-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const rota = tmp('herencia-rota-');
  git(rota, 'init', '-q', '-b', 'main');
  git(rota, 'remote', 'add', 'origin', remoto);
  const t = path.join(rota, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'suites.json'), '{ roto');
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1));
  git(rota, 'add', '-A'); git(rota, ...autor, 'commit', '-q', '-m', 'base con la lista rota');
  git(rota, 'push', '-q', 'origin', 'main'); git(rota, 'fetch', '-q', 'origin');
  // el cambio arregla la lista, sin commitear: la base (origin/main) la sigue teniendo rota
  fs.writeFileSync(path.join(t, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }], semanales: [] }));
  const g = resumen(rota, ['tests/a.test.sh']);
  const r2 = enLaBase(rota, g);
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(veredicto(leer(g), 'tests/a.test.sh').motivo, /la lista de suites de la base no se deja leer/);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — el árbol es una subcarpeta del repo: en la base se mide la misma subcarpeta', () => {
  // 🔴 mutación: leer suites.json en la raíz de la base → «la suite no está en la base».
  const remoto = tmp('herencia-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const mono = tmp('herencia-mono-');
  git(mono, 'init', '-q', '-b', 'main');
  git(mono, 'remote', 'add', 'origin', remoto);
  const t = path.join(mono, 'sub', 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }], semanales: [] }));
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1));
  git(mono, 'add', '-A'); git(mono, ...autor, 'commit', '-q', '-m', 'base');
  git(mono, 'push', '-q', 'origin', 'main'); git(mono, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(mono, 'sub', 'otro.txt'), 'un cambio sin commitear\n');
  const sub = path.join(mono, 'sub');
  const f = resumen(sub, ['tests/a.test.sh']);
  const r = enLaBase(sub, f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(veredicto(leer(f), 'tests/a.test.sh').verdict, 'heredada');
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — un tope que no es un número usa el de por defecto y lo dice', () => {
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh']);
  const r = enLaBase(raiz, f, { TYCON_INHERITED_BASE_MAX: 'off' });
  assert.match(r.stderr, /TYCON_INHERITED_BASE_MAX=off no es un entero ≥ 0: uso 3/);
  assert.equal(veredicto(leer(f), 'tests/a.test.sh').verdict, 'heredada', 'con el de por defecto sí mide');
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — apagado con TYCON_INHERITED_BASE_MAX=0: el resumen queda como hoy', () => {
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  const r = enLaBase(raiz, f, { TYCON_INHERITED_BASE_MAX: '0' });
  assert.equal(r.status, 10, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

test('InheritedReds_Unmeasured_Undecided — con suites sin medir no se perdona nada: sale 2 y el resumen no cambia', () => {
  const raiz = arbol(['b.test.sh']);
  const f = resumen(raiz, ['tests/b.test.sh'], { unmeasured_suites: [{ suite: 'tests/d.test.sh', reason: 'pasó su tope' }] });
  const antes = fs.readFileSync(f, 'utf8');
  assert.equal(aplicar(raiz, f).status, 2);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});
