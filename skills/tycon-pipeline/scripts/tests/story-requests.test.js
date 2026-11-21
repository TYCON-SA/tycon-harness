#!/usr/bin/env node
'use strict';
/**
 * story-requests.test.js — el registro de pedidos de cada historia, de qué historia es una fusión, y lo que las guías
 * dicen de la regla de la entrada.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/story-requests.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const registro = require(path.join(LIB, 'story-requests.js'));
const { pedidoDelAsunto, historiaDeLaFusion, nombraLaHistoria } = require(path.join(LIB, 'commit-story.js'));
const { crearJuez } = require(path.join(LIB, 'evidence-vs-commit.js'));

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });
function carpeta() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-')));
  temporales.push(d);
  return d;
}

const HORA_FIJA = 1790000000;
const PROPIA = { numero: '9.9', clave: '9.9', archivo: '/h/9.9.md' };
const CATALOGO = [{ numero: '9.9', archivo: '/h/9.9.md' }, { numero: '9.8', archivo: '/h/9.8.md' }];
const pedidosDe = (dir) => registro.leer({ dirs: [dir] }).porPedido;
const deLaFusion = (asunto, pedidos, repo = 'Codigo') => historiaDeLaFusion(asunto, { repo, propia: PROPIA, catalogo: CATALOGO, pedidos });

test('T19 HistoriaDeFusion_PorNumero_RamaWt @story-8.310 @ac-19', () => {
  assert.strictEqual(pedidoDelAsunto('Merge pull request #12 from org/wt/Uno'), 12);
  assert.strictEqual(pedidoDelAsunto('Merge pull request 13 from wt/Dos into main'), 13);
  assert.strictEqual(pedidoDelAsunto('Merged PR 14: arreglo de la 1.2'), 14);
  assert.strictEqual(pedidoDelAsunto('fix: el pedido 15'), null);
  const dir = carpeta();
  registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 12 });
  registro.anotar({ dir, clave: '9.8', historia: '9.8', repo: 'Codigo', pedido: 13 });
  const p = pedidosDe(dir);
  assert.strictEqual(deLaFusion('Merge pull request #12 from org/wt/Uno', p), 'propia');
  assert.deepStrictEqual(deLaFusion('Merge pull request 13 from wt/Dos into main', p), { numero: '9.8' });
  assert.strictEqual(deLaFusion('Merged PR 14: nada', p), null);
  assert.strictEqual(deLaFusion('Merge pull request #12 from org/wt/Uno', p, 'OtroRepo'), null, 'el mismo número en otro repo no cuenta');
  // un renglón de otra historia no le quita a una fusión lo que su rama reconoce como propio
  assert.strictEqual(deLaFusion('Merge pull request #13 from org/story/9.9-algo', p), 'propia');
});

test('Vigencia_NoLeeElRegistro @story-8.310 @ac-19', () => {
  const repo = carpeta();
  const fecha = `${HORA_FIJA} +0000`;
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=l@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a],
    { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
  fs.writeFileSync(path.join(repo, 'ev.md'), 'x\n');
  git('add', '-A'); git('commit', '-qm', 'inicio');
  fs.writeFileSync(path.join(repo, 'a.js'), '2\n');
  git('add', '-A'); git('commit', '-qm', 'cambio');
  let leido = false;
  const juez = crearJuez({ historia: { ...PROPIA, catalogo: () => CATALOGO, pedidos: () => { leido = true; return { porPedido: new Map(), ilegibles: [] }; } } });
  const r = juez.vigencia({ archivo: path.join(repo, 'a.js'), mtimeMs: (HORA_FIJA + 3600) * 1000, evidencia: { ruta: path.join(repo, 'ev.md'), tsMs: (HORA_FIJA - 3600) * 1000 } });
  assert.strictEqual(r.cuenta, false);
  assert.strictEqual(leido, false, 'vigencia no pregunta por el registro');
});

test('T20 HistoriaDeFusion_SinRenglon_Rama_YIlegible @story-8.310 @ac-20', () => {
  const dir = carpeta();
  registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 1 });
  const archivo = path.join(dir, '9.9-pedidos.jsonl');
  fs.appendFileSync(archivo, '{ roto\n');
  fs.appendFileSync(archivo, `${JSON.stringify({ historia: '9.9', repo: 'Codigo' })}\n`);
  const { porPedido, ilegibles } = registro.leer({ dirs: [dir, path.join(dir, 'no-existe')] });
  assert.strictEqual(porPedido.size, 1);
  assert.strictEqual(ilegibles.length, 2);
  assert.ok(ilegibles.every((i) => i.archivo === archivo), JSON.stringify(ilegibles));
  assert.strictEqual(deLaFusion('Merge pull request #7 from org/story/9.9-algo', porPedido), 'propia');
  assert.deepStrictEqual(deLaFusion('Merge pull request #7 from org/story/9.8-otra', porPedido), { numero: '9.8' });
  assert.strictEqual(deLaFusion('Merge pull request #7 from org/wt/Uno', porPedido), null);
  assert.ok(nombraLaHistoria('fix(9.9 B): algo', '9.9'));
  assert.ok(nombraLaHistoria('feat(9.9-A): algo', '9.9'));
  assert.ok(!nombraLaHistoria('fix(9.91): algo', '9.9'));
  assert.ok(!nombraLaHistoria('fix(19.9): algo', '9.9'));
  assert.ok(!nombraLaHistoria('fix(9.9.1): algo', '9.9'));
});

test('T21 HistoriaDeFusion_DosHistorias_MismoPedido @story-8.310 @ac-21', () => {
  const dir = carpeta();
  registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 5 });
  registro.anotar({ dir, clave: '9.8', historia: '9.8', repo: 'Codigo', pedido: 5 });
  const p = pedidosDe(dir);
  const asunto = 'Merge pull request #5 from org/wt/Uno';
  assert.strictEqual(deLaFusion(asunto, p), 'propia');
  assert.strictEqual(historiaDeLaFusion(asunto, { repo: 'Codigo', propia: { numero: '9.8', clave: '9.8', archivo: '/h/9.8.md' }, catalogo: CATALOGO, pedidos: p }), 'propia');
  const otra = historiaDeLaFusion(asunto, { repo: 'Codigo', propia: { numero: '9.7', clave: '9.7', archivo: '/h/9.7.md' }, catalogo: [...CATALOGO, { numero: '9.7', archivo: '/h/9.7.md' }], pedidos: p });
  assert.ok(otra && otra !== 'propia', 'para otra historia es ajena');
});

test('Anotar_NoRepite @story-8.310 @ac-17', () => {
  const dir = carpeta();
  assert.strictEqual(registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 5 }).escrito, true);
  assert.strictEqual(registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 5 }).escrito, false);
  assert.strictEqual(fs.readFileSync(path.join(dir, '9.9-pedidos.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('T23 Guias_DicenLaReglaDeEntrada @story-8.310 @ac-25', () => {
  for (const g of ['guides/accov-governance-protocol.md', 'guides/definition-of-done.md']) {
    const t = fs.readFileSync(path.join(RAIZ, g), 'utf8');
    for (const re of [/entr[óo] a `?main`?/i, /cambio propio|la propia historia/i, /nocturno/i, /prueba de noche/i, /riesgo escrito|Aceptado sin cobertura posterior/i,
      /lo que (ellas )?cargan/i, /sin historia conocida/i, /pedidos\.jsonl/, /editable|se puede editar/i,
      // cómo se reconoce la entrada: en la línea de primer padre, contra el último commit anterior y el primero posterior
      /primer padre/i, /último commit anterior/i, /primer commit posterior/i]) {
      assert.match(t, re, `${g} no dice ${re}`);
    }
  }
});

test('NombraLaHistoria_ComoUnaRama_GuionYMayusculas @story-8.310 @ac-7', () => {
  assert.strictEqual(nombraLaHistoria('fix(8-310): la prueba', '8.310'), true, 'con guion, como la acepta una rama');
  assert.strictEqual(nombraLaHistoria('arreglo de la oc-1', 'OC-1'), true, 'sin distinguir mayúsculas');
  assert.strictEqual(nombraLaHistoria('feat(8.3101): otra', '8.310'), false);
  assert.strictEqual(nombraLaHistoria('fix(18-310): otra', '8.310'), false);
});

test('Anotar_ArchivoSinSaltoFinal_NoFundeRenglones @story-8.310 @ac-17', () => {
  const dir = carpeta();
  const archivo = path.join(dir, '9.9-pedidos.jsonl');
  fs.writeFileSync(archivo, JSON.stringify({ historia: '9.9', clave: '9.9', repo: 'Codigo', pedido: 1, ts: 'x' }));
  registro.anotar({ dir, clave: '9.9', historia: '9.9', repo: 'Codigo', pedido: 2 });
  const { porPedido, ilegibles } = registro.leer({ dirs: [dir] });
  assert.deepStrictEqual([...porPedido.keys()].sort(), ['Codigo#1', 'Codigo#2']);
  assert.deepStrictEqual(ilegibles, []);
});

test('Leer_CarpetaQueNoSePuedeLeer_LoDice @story-8.310 @ac-20', () => {
  const dir = carpeta();
  const noEsCarpeta = path.join(dir, 'archivo');
  fs.writeFileSync(noEsCarpeta, 'x');
  const { ilegibles } = registro.leer({ dirs: [noEsCarpeta, path.join(dir, 'no-existe')] });
  assert.deepStrictEqual(ilegibles, [{ archivo: noEsCarpeta, linea: null }], 'una carpeta que falta no se avisa; una que no se puede leer, sí');
});
