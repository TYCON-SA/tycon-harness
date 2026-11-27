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

// sin las variables de un gancho: con su GIT_DIR, `-C` no decide el repo y un `init --bare` deja pelado al de verdad
const ENV_GIT = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre();
const git = (d, ...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], { encoding: 'utf8', env: ENV_GIT });
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
function conBase({ foto = null, conOrden = false } = {}) {
  const remoto = tmp('herencia-remoto-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const raiz = tmp('herencia-clon-');
  git(raiz, 'init', '-q', '-b', 'main');
  git(raiz, 'remote', 'add', 'origin', remoto);
  const t = path.join(raiz, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  const lista = (nombres) => JSON.stringify({ diarias: nombres.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.sh` })), semanales: [] });
  fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 's', ...(conOrden ? ['o'] : [])]));
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1));
  // o.test.sh: sola pasa; en la corrida completa (acá, con la marca que la deja roja) falla, en la base y en la rama
  if (conOrden) fs.writeFileSync(path.join(t, 'o.test.sh'), suiteQueSale(0, '[ -n "$HEREDADOS_ORDEN" ] && exit 1'));
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
  fs.writeFileSync(path.join(t, 'suites.json'), lista(['a', 'b', 'n', 's', ...(conOrden ? ['o'] : [])]));
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
  // 🔴 mutación: el motivo sin la línea de git (`r && (r.stderr || r.stdout)` sin el stderr) → «()» vacío
  assert.match(veredicto(leer(f), 'tests/a.test.sh').motivo, /no se pudo armar la base \(\S[^)]*\)/);
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

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — un tope negativo tampoco es un entero ≥ 0: usa el de por defecto y lo dice', () => {
  // 🔴 mutación: aceptar cualquier entero (`n >= 0` → `true`) → con -1 no mide nada y no lo dice.
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh']);
  const r = enLaBase(raiz, f, { TYCON_INHERITED_BASE_MAX: '-1' });
  assert.match(r.stderr, /TYCON_INHERITED_BASE_MAX=-1 no es un entero ≥ 0: uso 3/);
  assert.equal(veredicto(leer(f), 'tests/a.test.sh').verdict, 'heredada', 'con el de por defecto sí mide');
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — una falla vacía o sin su entrada queda «no medido», sin romper la medición', () => {
  // 🔴 mutación: leer la entrada sin mirar si la falla existe (`f && f.entrada` → `f.entrada`) → se cae con una nula.
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh']);
  const j = leer(f);
  j.fallas.push(null, { ruta: path.join(raiz, 'scripts', 'tests', 'x.test.sh'), exit: 1 }, { ruta: path.join(raiz, 'scripts', 'tests', 'y.test.sh'), exit: 1, entrada: null });
  fs.writeFileSync(f, JSON.stringify(j));
  const r = enLaBase(raiz, f);
  assert.doesNotMatch(r.stderr, /TypeError/, r.stderr);
  const k = leer(f);
  assert.equal(veredicto(k, 'tests/a.test.sh').verdict, 'heredada', r.stderr);
  for (const ruta of ['null', path.join(raiz, 'scripts', 'tests', 'x.test.sh'), path.join(raiz, 'scripts', 'tests', 'y.test.sh')]) {
    assert.deepEqual([veredicto(k, ruta).verdict, veredicto(k, ruta).motivo], ['no-medido', 'no medido: la falla no trae su entrada de suites.json'], ruta);
  }
  // sin base que medir, todas «no medido» con su ruta, también la nula
  const suelta = tmp('herencia-suelta-');
  const g = resumen(suelta, []);
  fs.writeFileSync(g, JSON.stringify({ ...leer(g), fallas: [null, { ruta: 'z.test.sh', exit: 1 }] }));
  const s = enLaBase(suelta, g);
  assert.doesNotMatch(s.stderr, /TypeError/, s.stderr);
  assert.deepEqual(leer(g).base_check.suites.map((x) => [x.ruta, x.raiz, x.verdict]), [['null', null, 'no-medido'], ['z.test.sh', null, 'no-medido']]);
});

test('Heredado_MedidoEnMainEnElMomento @story-8.230 @ac-14 — apagado con TYCON_INHERITED_BASE_MAX=0: el resumen queda como hoy', () => {
  const raiz = conBase();
  const f = resumen(raiz, ['tests/a.test.sh']);
  const antes = fs.readFileSync(f, 'utf8');
  const r = enLaBase(raiz, f, { TYCON_INHERITED_BASE_MAX: '0' });
  assert.equal(r.status, 10, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

// ── El juez por caso ────────────────────────────────────────────────────────────────────────────────────────────────
// La foto la arma suites-report.js con la salida guardada de la suite roja; el portón trae sus casos de failedCases
// (con renglones de contexto y otra duración). Los dos lados pasan por el mismo nombre de caso.
const REPORTE = path.join(CI, 'suites-report.js');
const VEREDICTO = path.join(CI, 'pr-verdict.js');

/** Una foto armada por suites-report.js con `salidas` ({suite: salida de la corrida}) como las rojas de la noche. */
function fotoDeLaNoche(salidas) {
  const d = tmp('herencia-noche-');
  const detalle = path.join(d, 'detalle');
  fs.mkdirSync(detalle);
  for (const [s, txt] of Object.entries(salidas)) fs.writeFileSync(path.join(detalle, `${s}.txt`), txt);
  const rep = path.join(d, 'ultimo-suites.json');
  const r = spawnSync(process.execPath, [REPORTE, '--rep', rep, '--build', '7', '--runs', '3', '--failures', Object.keys(salidas).join(' '), '--detail', detalle], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(rep, 'utf8');
}
const SALIDA_AB = '▶ b\n✖ T1 caso A (12.5ms)\n  AssertionError: 1 !== 2\n✖ T2 caso B (3ms)\n✖ failing tests:\n✖ T1 caso A (12.5ms)\n';
/** El resumen del portón con `b.test.sh` roja por esos casos (como los arma failedCases). */
function resumenConCasos(raiz, casos) {
  const f = resumen(raiz, ['tests/b.test.sh']);
  const j = leer(f);
  j.fallas[0].casos = casos;
  fs.writeFileSync(f, JSON.stringify(j));
  return f;
}
const CASO_A_DEL_PORTON = '✖ T1 caso A (8.1ms)\n  AssertionError [ERR_ASSERTION]: otra cosa\n    at Test.run';

test('Inherited_ByCase_NewCaseBlocks @story-8.279 @ac-21 — roja por A y B en la foto, por A y C ahora: C frena, A avisa', () => {
  const raiz = arbol(fotoDeLaNoche({ 'b.test.sh': SALIDA_AB }));
  const f = resumenConCasos(raiz, [CASO_A_DEL_PORTON, '✖ T3 caso C (2ms)']);
  const r = aplicar(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/b.test.sh'], 'la suite sigue roja por C');
  assert.equal(j.inherited, undefined);
  assert.match(r.stderr, /b\.test\.sh.*caso\(s\) nuevo\(s\): T3 caso C/);
  assert.match(r.stderr, /b\.test\.sh.*ya rojo\(s\) en el nocturno: T1 caso A/);
});

test('Inherited_NoCaseNames_BySuiteAsToday @story-8.279 @ac-22 — sin casos en algún lado, por suite como hoy, y lo dice', () => {
  // la foto vieja, sin el campo `casos`
  const vieja = arbol(['b.test.sh']);
  const r = aplicar(vieja, resumenConCasos(vieja, [CASO_A_DEL_PORTON, '✖ T3 caso C (2ms)']));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /b\.test\.sh: se juzgó por suite/);
  // la lista de la foto que llegó a su tope
  const larga = {};
  for (let i = 0; i < 60; i++) larga[`T${i}`] = `✖ T${i} caso (1ms)`;
  const tope = arbol(fotoDeLaNoche({ 'b.test.sh': Object.values(larga).join('\n') }));
  assert.ok(JSON.parse(fs.readFileSync(path.join(tope, FOTO), 'utf8')).casos_incompletos.includes('b.test.sh'));
  assert.equal(aplicar(tope, resumenConCasos(tope, ['✖ T99 otro (1ms)'])).status, 0, 'incompleta: por suite');
  // la lista del portón en su tope (el de failedCases): por suite
  const { failedCases } = require(path.resolve(__dirname, '..', 'lib', 'run-suites-json.js'));
  const delPorton = failedCases(Object.values(larga).join('\n'));
  const llena = arbol(fotoDeLaNoche({ 'b.test.sh': SALIDA_AB }));
  const rl = aplicar(llena, resumenConCasos(llena, delPorton));
  assert.equal(rl.status, 0, rl.stderr);
  assert.match(rl.stderr, /b\.test\.sh: se juzgó por suite/);
});

test('Inherited_SameCases_StillWarns @story-8.279 @ac-26 — los mismos casos con nombres en los dos lados: avisa sin frenar', () => {
  const raiz = arbol(fotoDeLaNoche({ 'b.test.sh': SALIDA_AB }));
  const f = resumenConCasos(raiz, [CASO_A_DEL_PORTON, '✖ T2 caso B (9ms)']);
  const r = aplicar(raiz, f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(leer(f).inherited.suites.map((s) => s.entrada.ruta), ['tests/b.test.sh']);
  assert.doesNotMatch(r.stderr, /se juzgó por suite/);
});

test('Inherited_SameCases_StillWarns @story-8.279 @ac-26 — el mismo caso escrito distinto en cada lado sigue siendo el mismo', () => {
  // (1) el renglón de resumen de una suite de bash cambia su contador: no es un caso nuevo
  const resumenBash = (n) => `❌ pr-uno: caso A\n${n > 1 ? '❌ pr-uno: caso B\n' : ''}❌ pr-uno-por-repo: ${n} falla(s)\n❌ FALLARON ${n} de 9\n`;
  const r1 = arbol(fotoDeLaNoche({ 'b.test.sh': resumenBash(2) }));
  const f1 = resumenConCasos(r1, ['❌ pr-uno: caso A', '❌ pr-uno-por-repo: 1 falla(s)', '❌ FALLARON 1 de 9']);
  assert.equal(aplicar(r1, f1).status, 0, 'arreglar un caso de una suite roja no la vuelve nueva');
  // (2) un renglón de más de 300 caracteres: el portón lo recorta (failedCases) y la foto no
  const largo = `✖ T1 ${'x'.repeat(320)} (2ms)`;
  const { failedCases } = require(path.resolve(__dirname, '..', 'lib', 'run-suites-json.js'));
  const r2 = arbol(fotoDeLaNoche({ 'b.test.sh': `${largo}\n` }));
  const f2 = resumenConCasos(r2, failedCases(`${largo}\n`));
  assert.equal(aplicar(r2, f2).status, 0, 'el mismo caso largo, recortado en un lado');
  // (3) un nombre con una ruta de la máquina: la foto lo guarda saneado, el portón también lo sanea
  const conRuta = `✖ T1 lee ${os.homedir()}/x/config.json (1ms)`;
  const r3 = arbol(fotoDeLaNoche({ 'b.test.sh': `${conRuta}\n` }));
  const f3 = resumenConCasos(r3, [conRuta]);
  const a3 = aplicar(r3, f3);
  assert.equal(a3.status, 0, a3.stderr);
});

test('Inherited_GreenInPhoto_Blocks @story-8.279 @ac-26 — verde en la foto, roja ahora: frena', () => {
  const raiz = arbol(fotoDeLaNoche({ 'otra.test.sh': '✖ T9 otra (1ms)\n' }));
  const f = resumenConCasos(raiz, ['✖ T1 caso A (1ms)']);
  assert.equal(aplicar(raiz, f).status, 1);
  assert.deepEqual(leer(f).fallas.map((x) => x.entrada.ruta), ['tests/b.test.sh']);
});

test('PrVerdict_ByCase_SameRule @story-8.279 @ac-23 — la validación del pedido juzga igual, también con la suite renombrada', () => {
  const d = tmp('herencia-veredicto-');
  const foto = path.join(d, 'foto.json');
  fs.writeFileSync(foto, fotoDeLaNoche({ 'b.test.sh': SALIDA_AB, 'viejo.test.sh': '✖ T5 caso E (1ms)\n' }));
  const ahora = (casos) => {
    const p = path.join(d, `ahora-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), failures: Object.keys(casos), motivos: {}, casos }));
    return p;
  };
  // un árbol con el mapa de renombres: viejo.test.sh se llama nuevo.test.sh
  const tcg = tmp('herencia-tcg-');
  fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.resolve(CI, '..', 'lib', 'legacy-names.js'), path.join(tcg, 'scripts', 'lib', 'legacy-names.js'));
  fs.writeFileSync(path.join(tcg, 'scripts', 'lib', 'renames.json'), JSON.stringify({ entries: [
    { kind: 'file', old: 'scripts/tests/viejo.test.sh', new: 'scripts/tests/nuevo.test.sh', batch: 'X', callers: ['same-repo'] }] }));
  const juzgar = (p) => spawnSync(process.execPath, [VEREDICTO, '--tcg', tcg, '--suites-actual', p, '--suites-snapshot', foto, '--json'], { encoding: 'utf8' });
  const nuevo = juzgar(ahora({ 'b.test.sh': ['✖ T1 caso A (2ms)', '✖ T3 caso C (2ms)'] }));
  assert.equal(nuevo.status, 1, nuevo.stdout + nuevo.stderr);
  assert.match(nuevo.stdout, /b\.test\.sh \(caso\(s\) nuevo\(s\): T3 caso C/);
  const igual = juzgar(ahora({ 'b.test.sh': ['✖ T2 caso B (2ms)'], 'nuevo.test.sh': ['✖ T5 caso E (7ms)'] }));
  assert.equal(igual.status, 0, igual.stdout + igual.stderr);
  assert.doesNotMatch(igual.stdout, /se juzgó por suite/, 'la renombrada trae sus casos con el nombre nuevo');
});

test('Inherited_BaseRun_ByCase @story-8.279 @ac-24 — roja en la base por A, ahora por A y C: no es heredada', () => {
  const remoto = tmp('herencia-remoto-caso-');
  git(remoto, 'init', '-q', '--bare', '-b', 'main');
  const raiz = tmp('herencia-clon-caso-');
  git(raiz, 'init', '-q', '-b', 'main');
  git(raiz, 'remote', 'add', 'origin', remoto);
  const t = path.join(raiz, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }, { raiz: 'arnes', ruta: 'tests/d.test.sh' }], semanales: [] }));
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1, 'echo "MAL caso A"'));
  fs.writeFileSync(path.join(t, 'd.test.sh'), suiteQueSale(1, 'echo "MAL caso D"'));
  git(raiz, 'add', '-A'); git(raiz, ...autor, 'commit', '-q', '-m', 'base');
  git(raiz, 'push', '-q', 'origin', 'main');
  git(raiz, 'fetch', '-q', 'origin');
  git(raiz, 'checkout', '-q', '-b', 'cambio');
  fs.writeFileSync(path.join(t, 'a.test.sh'), suiteQueSale(1, `echo "MAL caso A"\necho "MAL caso C"\necho "MAL lee ${os.homedir()}/secreto.json"`));
  fs.writeFileSync(path.join(t, 'd.test.sh'), suiteQueSale(1, 'echo "MAL caso D" # otra línea'));
  git(raiz, 'add', '-A'); git(raiz, ...autor, 'commit', '-q', '-m', 'el cambio');
  const f = resumen(raiz, ['tests/a.test.sh', 'tests/d.test.sh']);
  const j0 = leer(f);
  j0.fallas[0].casos = ['MAL caso A', 'MAL caso C', `MAL lee ${os.homedir()}/secreto.json`];
  j0.fallas[1].casos = ['MAL caso D'];
  fs.writeFileSync(f, JSON.stringify(j0));
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/a.test.sh']);
  assert.equal(veredicto(j, 'tests/a.test.sh').verdict, 'no-heredada');
  assert.match(veredicto(j, 'tests/a.test.sh').motivo, /caso\(s\) nuevo\(s\): caso C · lee /);
  assert.ok(!veredicto(j, 'tests/a.test.sh').motivo.includes(os.homedir()), 'el motivo sale saneado: sin la ruta de la máquina');
  assert.equal(veredicto(j, 'tests/d.test.sh').verdict, 'heredada', 'los mismos casos: heredada');
  baseSinRestos(raiz);
});

test('InheritedReds_Unmeasured_Undecided — con suites sin medir no se perdona nada: sale 2 y el resumen no cambia', () => {
  const raiz = arbol(['b.test.sh']);
  const f = resumen(raiz, ['tests/b.test.sh'], { unmeasured_suites: [{ suite: 'tests/d.test.sh', reason: 'pasó su tope' }] });
  const antes = fs.readFileSync(f, 'utf8');
  assert.equal(aplicar(raiz, f).status, 2);
  assert.equal(fs.readFileSync(f, 'utf8'), antes);
});

// 🔴 Falla con (issue #1855): una suite roja en la corrida completa que pasa sola en la base y sola en la rama (depende del
// orden o de la carga) cobrada como «verde en la base: el rojo es del cambio». La base se mide sola: la rama también.
test('Heredado_VerdeEnLaBase_SolaEnLaRamaTambien_NoFrena @A75 — pasa sola en los dos lados: avisa, no frena; roja sola en la rama sigue frenando', () => {
  const raiz = conBase({ conOrden: true });
  const f = resumen(raiz, ['tests/o.test.sh', 'tests/b.test.sh']);
  const r = enLaBase(raiz, f);
  assert.equal(r.status, 1, r.stderr);
  const j = leer(f);
  assert.equal(veredicto(j, 'tests/o.test.sh').verdict, 'no-reproduce', r.stderr);
  assert.match(veredicto(j, 'tests/o.test.sh').motivo, /verde sola en la rama/);
  // b es roja sola en la rama: sigue siendo del cambio, y lo dice
  assert.equal(veredicto(j, 'tests/b.test.sh').verdict, 'no-heredada');
  assert.match(veredicto(j, 'tests/b.test.sh').motivo, /roja también sola en la rama/);
  assert.deepEqual(j.fallas.map((x) => x.entrada.ruta), ['tests/b.test.sh'], r.stderr);
  assert.match(r.stderr, /o\.test\.sh.*avisa, no frena/);
  assert.deepEqual(j.inherited.suites.map((s) => [s.entrada.ruta, s.measured_on]), [['tests/o.test.sh', 'branch-alone']]);
  baseSinRestos(raiz);
});
