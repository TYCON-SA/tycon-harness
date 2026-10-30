#!/usr/bin/env node
'use strict';
// pinned-playwright.test.js — las pruebas y herramientas del arnés que abren un navegador usan la versión fija de
// Playwright del arnés, nunca la primera que encuentren subiendo carpetas.
//
// Por qué existe: un `require('playwright')` suelto sube de carpeta en carpeta hasta dar con uno. En una máquina con un
// `node_modules` en la carpeta personal, las pruebas del sitio tomaban ese: una versión de 2023 cuyo Chromium se cae al
// arrancar en el macOS de hoy. Y al reinstalarlo borró de la caché el Chromium de otro proyecto. La versión fija vive
// en scripts/lib/pinned-playwright.js, que la busca sólo en su caché y comprueba la versión.
//
// Lo que no se puede perder:
//   · ninguna prueba ni herramienta de scripts/ hace `require` de `playwright` o `playwright-core` por nombre
//     (PinnedPlaywright_NoLooseRequire);
//   · un `node_modules` de la carpeta personal no se toma, aunque esté (PinnedPlaywright_HomeModule_Ignored);
//   · la caché con otra versión no se toma, y el motivo lo dice (PinnedPlaywright_WrongVersion_NotUsed);
//   · la caché con la versión fija se carga (PinnedPlaywright_PinnedCache_Loaded);
//   · `TYCON_PLAYWRIGHT` sigue siendo la salida explícita (PinnedPlaywright_ExplicitFolder_Wins).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'scripts', 'lib', 'pinned-playwright.js');

// `require('playwright')`, `require('playwright-core')` o `require(X || 'playwright')`: todo lo que deja a Node elegir.
const SUELTO = /require\(\s*(?:[^)]*\|\|\s*)?['"]playwright(?:-core)?['"]\s*\)/;

function archivosJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) archivosJs(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Un módulo de juguete con su package.json: dice quién es al cargarlo. */
function moduloFalso(dir, version, quien) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'playwright-core', version, main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { quien: ${JSON.stringify(quien)}, chromium: {} };\n`);
}

function casaFalsa(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-pw-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

test('PinnedPlaywright_NoLooseRequire — ninguna prueba ni herramienta pide Playwright por nombre', () => {
  const archivos = archivosJs(path.join(RAIZ, 'scripts')).filter((f) => f !== __filename);
  assert.ok(archivos.length > 100, `pocos archivos (${archivos.length}): no miré lo que debía`);
  const sueltos = archivos.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')
    .map((l, i) => (!/^\s*(\/\/|\*)/.test(l) && SUELTO.test(l) ? `${path.relative(RAIZ, f)}:${i + 1}` : null)).filter(Boolean));
  assert.deepStrictEqual(sueltos, [], 'Playwright pedido por nombre: usá scripts/lib/pinned-playwright.js');
});

test('PinnedPlaywright_HomeModule_Ignored — el de la carpeta personal no se toma, aunque esté', (t) => {
  const pw = require(LIB);
  const casa = casaFalsa(t);
  moduloFalso(path.join(casa, 'node_modules', 'playwright-core'), '1.39.0', 'casa');
  moduloFalso(path.join(casa, 'node_modules', 'playwright'), '1.39.0', 'casa');
  const r = pw.locate({ env: {}, home: casa });
  assert.strictEqual(r.dir, null);
  assert.match(r.why, new RegExp(pw.PINNED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'el motivo nombra la versión fija');
  assert.match(r.why, /pinned-playwright\.js install/, 'el motivo dice cómo instalarla');
  assert.strictEqual(pw.load({ env: {}, home: casa }), null);
});

test('PinnedPlaywright_WrongVersion_NotUsed — la caché con otra versión no se toma', (t) => {
  const pw = require(LIB);
  const casa = casaFalsa(t);
  moduloFalso(path.join(pw.cacheDir(casa), 'node_modules', 'playwright-core'), '1.39.0', 'vieja');
  const r = pw.locate({ env: {}, home: casa });
  assert.strictEqual(r.dir, null);
  assert.match(r.why, /1\.39\.0/, 'el motivo dice qué versión encontró');
});

test('PinnedPlaywright_PinnedCache_Loaded — la caché con la versión fija se carga', (t) => {
  const pw = require(LIB);
  const casa = casaFalsa(t);
  const dir = path.join(pw.cacheDir(casa), 'node_modules', 'playwright-core');
  moduloFalso(dir, pw.PINNED_VERSION, 'fija');
  assert.strictEqual(pw.locate({ env: {}, home: casa }).dir, dir);
  assert.strictEqual(pw.load({ env: {}, home: casa }).quien, 'fija');
});

test('PinnedPlaywright_ExplicitFolder_Wins — TYCON_PLAYWRIGHT gana, sin mirar la caché', (t) => {
  const pw = require(LIB);
  const casa = casaFalsa(t);
  moduloFalso(path.join(pw.cacheDir(casa), 'node_modules', 'playwright-core'), pw.PINNED_VERSION, 'fija');
  const propio = path.join(casa, 'otro', 'playwright');
  moduloFalso(propio, '9.9.9', 'propio');
  assert.strictEqual(pw.locate({ env: { TYCON_PLAYWRIGHT: propio }, home: casa }).dir, propio);
  assert.strictEqual(pw.load({ env: { TYCON_PLAYWRIGHT: propio }, home: casa }).quien, 'propio');
});
