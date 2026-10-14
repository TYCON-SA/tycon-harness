'use strict';
// path-lookup.test.js — la búsqueda de un programa en el PATH de harness.js (`findInPath`, la que usan `install` y
// `doctor` para los requisitos) y de scripts/setup/harness/tools.js (`findIn`, la que detecta Claude Code y Codex).
//
// EL CASO (2026-10-14): en una máquina Windows 11 del equipo `pwsh --version` daba 7.6.7 y `where.exe pwsh` daba
// C:\Users\<usuario>\AppData\Local\Microsoft\WindowsApps\pwsh.exe —el PowerShell 7 de la Microsoft Store, que es un alias
// de ejecución (un punto de reanálisis)—, pero `/tycon-harness` decía «falta pwsh en el PATH». Sobre ese alias Node falla
// en `statSync` (EACCES/UNKNOWN), y la búsqueda se lo salteaba aunque `spawnSync('pwsh')` lo ejecuta.
//
// Sin máquina Windows, el sistema y el sistema de archivos se inyectan: un alias es una entrada cuyo `statSync` tira
// EACCES y cuyo `lstatSync` dice que existe y no es una carpeta.
// 🔴 rojo previo: `harness.js` no exportaba `findInPath` (TypeError), `tools.runnableAt` no existía, y las dos búsquedas
//    se salteaban el alias.
//
// Uso: node --test scripts/tests/path-lookup.test.js   (no lanza procesos ni toca la máquina; lee una carpeta temporal)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
const TOOLS = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));

const eacces = (p) => Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });

/**
 * Un sistema de archivos de mentira: `entries` mapea una ruta a `file`, `dir` o `alias` (el de la Store: `accessSync` pasa,
 * `statSync` tira EACCES, `lstatSync` existe y no es carpeta). Lo que no está, no existe.
 */
function fakeFs(entries) {
  const kind = (p) => entries[p];
  const stats = (k) => ({ isFile: () => k === 'file', isDirectory: () => k === 'dir', isSymbolicLink: () => k === 'alias' });
  return {
    accessSync(p) { if (!kind(p)) throw enoent(p); },
    statSync(p) { const k = kind(p); if (!k) throw enoent(p); if (k === 'alias') throw eacces(p); return stats(k); },
    lstatSync(p) { const k = kind(p); if (!k) throw enoent(p); return stats(k); },
  };
}

// sin letra de unidad: el PATH se corta con el separador de la máquina que corre la prueba (`:` en Mac y Linux)
const APPS = path.join(path.sep, 'Users', '<usuario>', 'AppData', 'Local', 'Microsoft', 'WindowsApps');
const OTHER = path.join(path.sep, 'Program Files', 'Otra');
const PATH = [OTHER, APPS].join(path.delimiter);

test('Windows · el alias de ejecución de la Store (statSync tira EACCES, lstatSync existe como archivo) cuenta como encontrado', () => {
  const alias = path.join(APPS, 'pwsh.exe');
  const fsApi = fakeFs({ [alias]: 'alias' });
  assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform: 'win32', fsApi }), alias, 'harness.js · findInPath');
  assert.strictEqual(TOOLS.findIn('pwsh', PATH, 'win32', fsApi), alias, 'tools.js · findIn');
  // el `Path` de Windows (con esa capitalización) también vale
  assert.strictEqual(H.findInPath('pwsh', { Path: PATH }, { platform: 'win32', fsApi }), alias);
});

test('Windows · una CARPETA con el nombre del programa sigue sin contar, se lea o no con statSync', () => {
  const dir = path.join(APPS, 'pwsh.exe');
  // statSync responde: es una carpeta
  assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform: 'win32', fsApi: fakeFs({ [dir]: 'dir' }) }), null);
  assert.strictEqual(TOOLS.findIn('pwsh', PATH, 'win32', fakeFs({ [dir]: 'dir' })), null);
  // statSync falla y lstatSync dice carpeta: tampoco
  const failing = fakeFs({ [dir]: 'dir' });
  failing.statSync = (p) => { throw eacces(p); };
  assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform: 'win32', fsApi: failing }), null);
  assert.strictEqual(TOOLS.runnableAt(dir, 'win32', failing), false);
});

test('Windows · gana el primero del PATH, y el archivo común se sigue encontrando como siempre', () => {
  const first = path.join(OTHER, 'pwsh.exe');
  const alias = path.join(APPS, 'pwsh.exe');
  assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform: 'win32', fsApi: fakeFs({ [first]: 'file', [alias]: 'alias' }) }), first);
  assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform: 'win32', fsApi: fakeFs({}) }), null, 'nada en el PATH: null');
});

test('Mac y Linux · la regla no cambia: lo que no se puede leer con statSync no cuenta', () => {
  const alias = path.join(APPS, 'pwsh');
  for (const platform of ['darwin', 'linux']) {
    assert.strictEqual(H.findInPath('pwsh', { PATH }, { platform, fsApi: fakeFs({ [alias]: 'alias' }) }), null, platform);
    assert.strictEqual(TOOLS.runnableAt(alias, platform, fakeFs({ [alias]: 'alias' })), false, platform);
  }
});

test('con el sistema de archivos de verdad: un ejecutable se encuentra y una carpeta con su nombre no', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-path-lookup-'));
  try {
    const withBin = path.join(base, 'con');
    const withDir = path.join(base, 'carpeta');
    const ext = process.platform === 'win32' ? '.exe' : '';
    fs.mkdirSync(withBin);
    fs.mkdirSync(path.join(withDir, `programa-de-juguete${ext}`), { recursive: true });
    const bin = path.join(withBin, `programa-de-juguete${ext}`);
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    assert.strictEqual(H.findInPath('programa-de-juguete', { PATH: [withDir, withBin].join(path.delimiter) }), bin);
    assert.strictEqual(H.findInPath('programa-de-juguete', { PATH: withDir }), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
