#!/usr/bin/env node
'use strict';
/**
 * adhoc-list-windows.test.js — la lista del camino corto con rutas de Windows: la letra de unidad no distingue mayúsculas.
 *
 * VS Code abre la carpeta como `d:\workspace\…` y el editor pasa las rutas como `D:\workspace\…`. Una lista guardada con
 * `d:` frenaba cada edición de sus propios archivos, y ampliarla desde `D:\` no contenía la firmada.
 *
 *   W1 la letra de unidad pasa a mayúscula; una ruta de Mac o Linux no cambia
 *   W2 la lista pedida desde `d:\` se guarda con `D:`
 *   W3 un archivo de la lista pasa con cualquiera de las dos letras, también una lista guardada con `d:` antes del arreglo
 *   W4 un archivo fuera de la lista sigue frenando con la letra en mayúscula
 *   W5 la prueba de un archivo de la lista pasa aunque la raíz del repo venga con `d:`
 *   W6 la carpeta personal se reconoce con cualquiera de las dos letras
 *   W7 ampliar la lista: la nueva con `D:` contiene la firmada con `d:`; un archivo que falta, falta
 *
 * Se ejercita en cualquier sistema: la biblioteca se carga con las rutas de Windows (`path.win32`) y un disco simulado
 * que, como `realpathSync` en Windows, devuelve la letra tal como vino.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-list-windows.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const LIB = path.join(__dirname, '..', 'lib', 'adhoc-list.js');
const REPO = 'd:\\workspace\\acme';
const HOME = 'c:\\Users\\dev';
// las carpetas que existen en el disco simulado, comparadas sin mayúsculas como en Windows
const CARPETAS = new Set(['c:\\', 'c:\\users', HOME, 'd:\\', 'd:\\workspace', REPO, `${REPO}\\src`, `${REPO}\\src\\__tests__`].map((c) => c.toLowerCase()));

const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
const fsDeWindows = {
  realpathSync: (p) => { if (CARPETAS.has(path.win32.resolve(p).toLowerCase())) return path.win32.resolve(p); throw enoent(p); },
  statSync: (p) => { if (CARPETAS.has(path.win32.resolve(p).toLowerCase())) return { isDirectory: () => true }; throw enoent(p); },
};
const osDeWindows = { homedir: () => HOME, tmpdir: () => `${HOME}\\AppData\\Local\\Temp` };
// git devuelve la raíz con la letra como la tiene la carpeta abierta
const baseDeWindows = {
  ubicar: (p) => (String(p).toLowerCase().startsWith(REPO.toLowerCase()) ? { raiz: REPO } : { fuera: true }),
};

/** Corre `fn` con lo que la biblioteca pide (al cargarse y al usarse) cambiado por lo de Windows. */
function conWindows(fn) {
  const cargar = Module._load;
  const jobDir = process.env.CLAUDE_JOB_DIR;
  delete process.env.CLAUDE_JOB_DIR;
  const DE_WINDOWS = { path: path.win32, fs: fsDeWindows, os: osDeWindows, './adhoc-base.js': baseDeWindows };
  Module._load = function (pedido, padre, ...resto) {
    if (padre && padre.filename === LIB && DE_WINDOWS[pedido]) return DE_WINDOWS[pedido];
    return cargar.call(this, pedido, padre, ...resto);
  };
  try { return fn(); } finally {
    Module._load = cargar;
    if (jobDir !== undefined) process.env.CLAUDE_JOB_DIR = jobDir;
  }
}

/** La biblioteca cargada con las rutas, el disco y la carpeta personal de Windows. */
function listaDeWindows() {
  const L = conWindows(() => { delete require.cache[require.resolve(LIB)]; return require(LIB); });
  delete require.cache[require.resolve(LIB)];
  // `./adhoc-base.js` se pide al usarse, no al cargar
  const usar = (f) => (...args) => conWindows(() => f(...args));
  return { ...L, fueraDeLaLista: usar(L.fueraDeLaLista), normalizar: usar(L.normalizar) };
}

test('T-269 W1 la letra de unidad pasa a mayúscula; una ruta de Mac o Linux no cambia', () => {
  const { unidadEnMayuscula } = require(LIB);
  assert.equal(unidadEnMayuscula('d:\\workspace\\a.ts'), 'D:\\workspace\\a.ts');
  assert.equal(unidadEnMayuscula('d:/workspace/a.ts'), 'D:/workspace/a.ts');
  assert.equal(unidadEnMayuscula('D:\\workspace\\a.ts'), 'D:\\workspace\\a.ts');
  assert.equal(unidadEnMayuscula('d:'), 'D:');
  assert.equal(unidadEnMayuscula('/Users/dev/d:/a.ts'), '/Users/dev/d:/a.ts');
  assert.equal(unidadEnMayuscula('/workspace/src/a.ts'), '/workspace/src/a.ts');
  assert.equal(unidadEnMayuscula('d:relativa'), 'd:relativa', 'sin barra no es una ruta con unidad');
  assert.equal(unidadEnMayuscula('ab:\\x'), 'ab:\\x');
});

test('T-269 W2 la lista pedida desde d:\\ se guarda con D:', () => {
  const L = listaDeWindows();
  const r = L.normalizar(['src\\a.ts', 'src/b.ts'], { cwd: REPO });
  assert.equal(r.problema, undefined);
  assert.deepEqual(r.lista, ['D:\\workspace\\acme\\src\\a.ts', 'D:\\workspace\\acme\\src\\b.ts']);
  assert.deepEqual(r.sinRepo, []);
  const desdeMayuscula = L.normalizar(['src\\a.ts'], { cwd: 'D:\\workspace\\acme' });
  assert.deepEqual(desdeMayuscula.lista, r.lista.slice(0, 1), 'desde D:\\ sale la misma lista');
});

test('T-269 W3 un archivo de la lista pasa con cualquiera de las dos letras, también una lista guardada con d: antes del arreglo', () => {
  const L = listaDeWindows();
  const guardadaAntes = [`${REPO}\\src\\a.ts`];
  const nueva = L.normalizar(['src\\a.ts'], { cwd: REPO }).lista;
  for (const lista of [guardadaAntes, nueva]) {
    for (const filePath of ['D:\\workspace\\acme\\src\\a.ts', `${REPO}\\src\\a.ts`]) {
      assert.equal(L.fueraDeLaLista({ lista, filePath, real: filePath, repoRoot: 'D:\\workspace\\acme', home: HOME }), null, `${lista[0]} contra ${filePath}`);
      assert.equal(L.fueraDeLaLista({ lista, filePath, repoRoot: null, home: HOME }), null, `${lista[0]} contra ${filePath}, raíz por git`);
    }
  }
});

test('T-269 W4 un archivo fuera de la lista sigue frenando con la letra en mayúscula', () => {
  const L = listaDeWindows();
  const fuera = L.fueraDeLaLista({ lista: [`${REPO}\\src\\a.ts`], filePath: 'D:\\workspace\\acme\\src\\b.ts', repoRoot: null, home: HOME });
  assert.deepEqual(fuera, { archivo: 'D:\\workspace\\acme\\src\\b.ts', motivo: 'no está en la lista' });
  const sinRepo = L.fueraDeLaLista({ lista: [`${REPO}\\src\\a.ts`], filePath: 'E:\\otro\\c.ts', repoRoot: null, home: HOME });
  assert.deepEqual(sinRepo, { archivo: 'E:\\otro\\c.ts', motivo: 'fuera de un repo' });
});

test('T-269 W5 la prueba de un archivo de la lista pasa aunque la raíz del repo venga con d:', () => {
  const L = listaDeWindows();
  const lista = ['D:\\workspace\\acme\\src\\a.ts'];
  assert.equal(L.fueraDeLaLista({ lista, filePath: 'D:\\workspace\\acme\\src\\a.test.ts', repoRoot: null, home: HOME }), null);
  assert.equal(L.fueraDeLaLista({ lista: [`${REPO}\\src\\a.ts`], filePath: 'D:\\workspace\\acme\\src\\__tests__\\a.ts', repoRoot: REPO, home: HOME }), null);
});

test('T-269 W6 la carpeta personal se reconoce con cualquiera de las dos letras', () => {
  const L = listaDeWindows();
  const lista = [`${REPO}\\src\\a.ts`];
  const archivo = 'C:\\Users\\dev\\notas.md';
  assert.equal(L.fueraDeLaLista({ lista, filePath: archivo, repoRoot: null, home: HOME }), null, 'el carril de una persona no frena en su carpeta');
  assert.deepEqual(L.fueraDeLaLista({ lista, filePath: archivo, repoRoot: null, home: HOME, delegado: true }), { archivo, motivo: 'carpeta personal' });
});

test('T-269 W7 ampliar la lista: la nueva con D: contiene la firmada con d:; un archivo que falta, falta', () => {
  const { faltanEnLaNueva } = require(LIB);
  const firmada = [`${REPO}\\src\\a.ts`, `${REPO}\\src\\b.ts`];
  assert.deepEqual(faltanEnLaNueva(firmada, ['D:\\workspace\\acme\\src\\a.ts', 'D:\\workspace\\acme\\src\\b.ts', 'D:\\workspace\\acme\\src\\c.ts']), []);
  assert.deepEqual(faltanEnLaNueva(firmada, ['D:\\workspace\\acme\\src\\a.ts']), [`${REPO}\\src\\b.ts`]);
  assert.deepEqual(faltanEnLaNueva(['/repo/a.ts'], ['/repo/a.ts']), [], 'en Mac y Linux, igual que antes');
  assert.deepEqual(faltanEnLaNueva(['/repo/A.ts'], ['/repo/a.ts']), ['/repo/A.ts'], 'fuera de la letra de unidad, las mayúsculas cuentan');
});
