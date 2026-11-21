'use strict';

/**
 * guard-libs-signed.test.js — la copia propia del freno de producción (scripts/production/guard-libs/) pide la constancia
 * del dueño cada vez que cambia.
 *
 * Esa copia es lo que se instala en /opt, y ningún banco la corre: el banco prueba el freno con las bibliotecas compartidas.
 * Un pedido que afloja la copia de `shell-parse.js` pasaría la base y el pedido igual, así que el único freno es que el
 * inventario de la revisión la declare como regla con «sign_on_change».
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const INVENTARIO = path.join(ROOT, 'scripts', 'ci', 'controls-from-base.json');
const COPIA = path.join(ROOT, 'scripts', 'production', 'guard-libs');

// 🔴 Falla con: un archivo de la copia (o su lista, sources.json) que el inventario no declara como regla firmada.
test('GuardLibs_EveryCopy_IsASignedRule', () => {
  const inventario = JSON.parse(fs.readFileSync(INVENTARIO, 'utf8'));
  const firmadas = new Set(inventario.controls.flatMap((c) => c.rules || [])
    .filter((r) => r && typeof r === 'object' && r.sign_on_change).map((r) => r.path));
  const fuentes = JSON.parse(fs.readFileSync(path.join(COPIA, 'sources.json'), 'utf8'));
  const enDisco = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p); else enDisco.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  recorrer(COPIA);
  const esperadas = [...new Set([...enDisco, ...fuentes.files.map((f) => `scripts/production/guard-libs/${f.copy}`)])];
  assert.ok(esperadas.includes('scripts/production/guard-libs/lib/shell-parse.js'), 'la copia de shell-parse existe');
  const faltan = esperadas.filter((p) => !firmadas.has(p));
  assert.deepStrictEqual(faltan, [], `la copia del freno de producción sin constancia del dueño al cambiar:\n${faltan.join('\n')}`);
});
