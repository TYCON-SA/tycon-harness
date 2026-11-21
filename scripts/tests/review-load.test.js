'use strict';
/**
 * review-load.test.js — la cuenta de lo que espera la revisión de la persona (scripts/lib/review-load.js).
 * Carpetas temporales y lectores inyectados: ninguna prueba lee la carpeta de estado real ni sale a la red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const RL = require(path.join(RAIZ, 'scripts', 'lib', 'review-load.js'));
const NOW = Date.parse('2026-11-21T15:00:00Z');
const hace = (min) => new Date(NOW - min * 60000).toISOString();

function laboratorio() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-load-')));
  const home = path.join(root, 'home');
  const sdir = path.join(root, 'estado');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sdir, { recursive: true });
  return { root, home, sdir };
}
const TOPE = { value: 8, origin: 'sin-valor' };
const firmas = (tipos) => ({ abiertos: () => ({ filas: tipos.map((tipo) => ({ tipo })) }), tipoDe: (f) => f.tipo });
const terminados = (items) => () => ({ items, lines: [] });
const carpetas = (dirs, extra = {}) => async () => ({ carpetas: dirs.map((dir) => ({ dir, rama: 'wt/x', archivos: 1, sinTocarDesde: NOW })), problemas: [], sinMirar: 0, ...extra });
const deps = (lab, extra = {}) => ({ tope: TOPE, ...firmas([]), machine: terminados([]), folderItems: carpetas([]), ...extra });
function pedidos(lab, entradas) {
  fs.writeFileSync(path.join(lab.sdir, 'stuck-prs.json'), JSON.stringify(Object.fromEntries(entradas.map(([estado, min], i) => [`o/r#${i + 1}`, { estado, punta: 'abc', vistoDesde: hace(min) }]))));
}

// 🔴 Falla con: la cuenta que no suma las cuatro partes, o que cuenta un borrador limpio o un pedido de hace 30 minutos.
test('T1 ReviewLoad_CuentaLasCuatroPartes @story-8.326 @ac-1', async () => {
  const lab = laboratorio();
  pedidos(lab, [['blocked', 120], ['verde-sin-auto', 120], ['clean', 30], ['clean+borrador', 120], ['conflict+borrador', 120]]);
  const r = await RL.reviewLoad({ home: lab.home, stateDir: lab.sdir, ahora: NOW, deps: deps(lab, {
    ...firmas(['firma', 'terminal', 'delegated']),
    machine: terminados([{ sid: 'a', tipo: 'ejecucion' }, { sid: 'b', tipo: 'camino-corto' }]),
    folderItems: carpetas([path.join(lab.root, 'c1'), path.join(lab.root, 'c2')]),
  }) });
  assert.deepStrictEqual(r.partes, { firmas: 2, terminados: 2, carpetas: 2, pedidos: 3 });
  assert.strictEqual(r.total, 9);
  assert.deepStrictEqual(r.problems, []);
});

// 🔴 Falla con: lo que no se pudo mirar sumado al total, o dicho como cero.
test('T2 ReviewLoad_SinMedirNoSuma @story-8.326 @ac-1', async () => {
  const lab = laboratorio();
  const r = await RL.reviewLoad({ home: lab.home, stateDir: lab.sdir, ahora: NOW, deps: deps(lab, {
    machine: terminados([{ sid: 'a', tipo: 'sin-medir', texto: 'x' }, { sid: null, tipo: 'sin-medir', texto: 'no medido: 2 caminos cortos y 1 ejecución (se acabó el tope de 5 s)' }, { sid: 'c', tipo: 'ilegible' }]),
    folderItems: carpetas([], { sinMirar: 248 }),
  }) });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.noMedido, { terminados: 5, carpetas: 248 });
  assert.match(RL.lineaDeRevision(r), /no pude mirar: 5 terminados, 248 carpetas/);
});

// 🔴 Falla con: las copias de prueba de un trabajo de fondo contadas como trabajo de la persona.
test('T3 ReviewLoad_CopiasDePruebaNoCuentan @story-8.326 @ac-1', async () => {
  const lab = laboratorio();
  const copia = path.join(lab.home, '.claude', 'jobs', 'abc123', 'tmp', 'banco');
  fs.mkdirSync(copia, { recursive: true });
  const r = await RL.reviewLoad({ home: lab.home, stateDir: lab.sdir, ahora: NOW, deps: deps(lab, { folderItems: carpetas([copia, path.join(lab.root, 'de-verdad')]) }) });
  assert.strictEqual(r.partes.carpetas, 1);
});

// 🔴 Falla con: una fuente rota que tira toda la cuenta, o que se dice como cero.
test('T4 ReviewLoad_FuenteRota_ParteNull @story-8.326 @ac-2', async () => {
  const lab = laboratorio();
  fs.writeFileSync(path.join(lab.sdir, 'stuck-prs.json'), '{ roto');
  const r = await RL.reviewLoad({ home: lab.home, stateDir: lab.sdir, ahora: NOW, deps: deps(lab, {
    ...firmas(['firma']), machine: () => { throw new Error('se cayó'); }, folderItems: carpetas([path.join(lab.root, 'c1')]),
  }) });
  assert.strictEqual(r.partes.pedidos, null);
  assert.strictEqual(r.partes.terminados, null);
  assert.deepStrictEqual([r.partes.firmas, r.partes.carpetas, r.total], [1, 1, 2]);
  assert.ok(r.problems.some((p) => /pedidos trabados/.test(p)) && r.problems.some((p) => /se cayó/.test(p)), r.problems.join(' | '));
  assert.match(RL.lineaDeRevision(r), /\? terminados/);
});

// 🔴 Falla con: un lector de carpetas que no contesta deja la cuenta colgada.
test('T5 ReviewLoad_TopeDeTiempo @story-8.326 @ac-3', async () => {
  const lab = laboratorio();
  // stable-data: mide cuánto tarda la cuenta con su tope, no es una fecha que la prueba compare
  const desde = Date.now();
  const r = await RL.reviewLoad({ home: lab.home, stateDir: lab.sdir, ahora: NOW, topeMs: 600, deps: deps(lab, {
    ...firmas(['firma']), folderItems: () => new Promise(() => {}),
  }) });
  assert.ok(Date.now() - desde < 10000, `tardó ${Date.now() - desde} ms`);
  assert.strictEqual(r.partes.carpetas, null);
  assert.strictEqual(r.partes.firmas, 1);
  assert.ok(r.problems.some((p) => /no contestaron/.test(p)), r.problems.join(' | '));
});

// 🔴 Falla con: un aviso que decide con la foto, o la foto que no dice su edad.
test('T13 ReviewLoad_FotoSoloParaAvisos @story-8.326 @ac-10', async () => {
  const lab = laboratorio();
  const cuenta = { total: 0, partes: { firmas: 0, terminados: 0, carpetas: 0, pedidos: 0 }, noMedido: { terminados: 0, carpetas: 0 }, tope: TOPE, problems: [] };
  RL.escribirFoto(lab.sdir, cuenta, NOW - 5 * 60000);
  const f = RL.leerFoto(lab.sdir, NOW);
  assert.strictEqual(f.cuenta.total, 0);
  assert.strictEqual(f.edadMs, 5 * 60000);
  // una foto rota o sin hora no es una foto
  fs.writeFileSync(path.join(lab.sdir, 'review-load.json'), '{"total":0}');
  assert.strictEqual(RL.leerFoto(lab.sdir, NOW), null);
});

// 🔴 Falla con: la historia entrando en freno, o una variable que cambia el modo.
test('T16 ReviewLoad_ModoDeFabricaEsAviso @story-8.326 @ac-7', () => {
  assert.strictEqual(RL.MODO_TOPE_DE_REVISION, 'warn');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'review-load.js'))}).MODO_TOPE_DE_REVISION)`],
    { encoding: 'utf8', env: { ...process.env, TYCON_REVIEW_CAP_MODE: 'block', TYCON_REVIEW_LOAD_MODE: 'block' } });
  assert.strictEqual(r.stdout.trim(), 'warn');
  assert.strictEqual(RL.TOPE_DE_DECISION_MS, 4000);
});

// 🔴 Falla con: quien decide sin `await` sin la cuenta, o con un hijo que falla tirando la decisión.
test('T17 CapCheck_SincronaConLaCuentaEnUnHijo @story-8.326 @ac-3', () => {
  const lab = laboratorio();
  const bueno = path.join(lab.root, 'bueno.js');
  fs.writeFileSync(bueno, `process.stdout.write(JSON.stringify({ total: 8, partes: { firmas: 1, terminados: 2, carpetas: 3, pedidos: 2 }, noMedido: { terminados: 0, carpetas: 0 }, tope: { value: 8, origin: 'sin-valor' }, problems: [] }))`);
  const r = RL.reviewLoadSync({ home: lab.home, env: { PATH: process.env.PATH }, topeMs: 2000, script: bueno });
  assert.strictEqual(r.total, 8);
  assert.strictEqual(RL.enElTope(r), true);
  const malo = path.join(lab.root, 'malo.js');
  fs.writeFileSync(malo, 'process.exit(3)');
  const m = RL.reviewLoadSync({ home: lab.home, env: { PATH: process.env.PATH }, topeMs: 2000, script: malo });
  assert.deepStrictEqual(m.partes, { firmas: null, terminados: null, carpetas: null, pedidos: null });
  assert.match(m.problems[0], /salió con 3/);
  assert.strictEqual(RL.enElTope(m), false);
  // el hijo que no termina se corta en el tope más un segundo
  const lento = path.join(lab.root, 'lento.js');
  fs.writeFileSync(lento, 'setTimeout(() => {}, 60000)');
  // stable-data: mide cuánto tarda la cuenta con su tope, no es una fecha que la prueba compare
  const desde = Date.now();
  const l = RL.reviewLoadSync({ home: lab.home, env: { PATH: process.env.PATH }, topeMs: 300, script: lento });
  assert.ok(Date.now() - desde < 3000, `tardó ${Date.now() - desde} ms`);
  assert.match(l.problems[0], /no terminó/);
});

// 🔴 Falla con: una foto con otra forma (escrita a mano) que hace caer /wip y el estado de la coordinación.
test('T13b ReviewLoad_FotoConOtraForma_NoEsFoto @story-8.326 @ac-10', () => {
  const lab = laboratorio();
  const at = new Date(NOW).toISOString();
  for (const malo of [
    { at, total: 3, partes: {}, tope: { value: 8 } },
    { at, total: 3, partes: { firmas: 1, terminados: 1, carpetas: 1, pedidos: 0 }, tope: { value: 8 } },
    { at, total: 3, partes: { firmas: 1, terminados: 1, carpetas: 1, pedidos: 0 }, noMedido: { terminados: 0, carpetas: 0 }, tope: {} },
    { at, total: 3, partes: { firmas: 'x', terminados: 1, carpetas: 1, pedidos: 0 }, noMedido: { terminados: 0, carpetas: 0 }, tope: { value: 8 } },
  ]) {
    fs.writeFileSync(path.join(lab.sdir, 'review-load.json'), JSON.stringify(malo));
    assert.strictEqual(RL.leerFoto(lab.sdir, NOW), null, JSON.stringify(malo));
  }
});
