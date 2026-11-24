#!/usr/bin/env node
/**
 * production-notice-cases.test.js — los casos del banco del aviso del freno de producción copian, junto con el aviso,
 * cada guion de su carpeta que el aviso carga.
 *
 * Los casos de `scripts/controls-bench/cases/hooks/41-production-notice.json` arman un arnés de juguete y corren la
 * copia del aviso que dejan ahí, con sólo los guiones de `scripts/hooks/` que el armado copia. Si el aviso empieza a
 * cargar otro guion de su carpeta y los casos no lo copian, el aviso de juguete se cae al cargarlo y dice «no pude
 * chequear el freno». Esos casos están declarados sólo para macOS: Linux los saltea, y una Mac con el freno instalado
 * también, así que el pedido del cambio pasa verde y el rojo aparece recién en el banco nocturno de macOS. Esta prueba
 * lo mira sin correrlos, en cualquier sistema.
 *
 * Correr: node --test scripts/tests/production-notice-cases.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'production-notice.js');
const CASES = path.join(ROOT, 'scripts', 'controls-bench', 'cases', 'hooks', '41-production-notice.json');

/** Los guiones de la misma carpeta que carga un fuente: `require(path.join(__dirname, 'x.js'))` o `require('./x.js')`. */
function siblingsLoaded(source) {
  const out = new Set();
  for (const m of source.matchAll(/require\(\s*path\.join\(\s*__dirname\s*,\s*['"]([^'"/.][^'"/]*\.js)['"]\s*\)\s*\)/g)) out.add(m[1]);
  for (const m of source.matchAll(/require\(\s*['"]\.\/([^'"/]+\.js)['"]\s*\)/g)) out.add(m[1]);
  return [...out].sort();
}

/**
 * Los casos que copian el aviso a su carpeta de juguete, con lo que les falta copiar al lado. → [{ id, faltan }]
 * La copia del aviso es el `cp` que lo nombra; lo que va con él tiene que estar en ese mismo `cp`.
 */
function missingSiblings(cases, siblings) {
  const out = [];
  for (const c of cases) {
    const copy = (c.setup || []).flatMap((s) => s.split(/&&|;/)).map((s) => s.trim())
      .find((s) => /^cp\b/.test(s) && s.includes('$TCG/scripts/hooks/production-notice.js'));
    if (!copy) continue;
    const faltan = siblings.filter((name) => !copy.includes(`$TCG/scripts/hooks/${name}`));
    if (faltan.length) out.push({ id: c.id, faltan });
  }
  return out;
}

const allCases = () => {
  const def = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  return (Array.isArray(def.hooks) ? def.hooks : Object.values(def.hooks)).flatMap((h) => h.cases || []);
};

// 🔴 Falla con: el aviso que carga `guard-update-notice.js` (la actualización sola del freno) y los 24 casos que
// copian sólo `production-notice.js` y `prod-access-guard.js`: los tres de «quedó viejo» llegaban a esa carga, el
// aviso de juguete se caía y el banco nocturno de macOS los dio rojos desde el 21/11
test('T1 CasosDelAviso_CopianLoQueElAvisoCarga — cada caso que copia el aviso copia también los guiones de su carpeta que carga', () => {
  const siblings = siblingsLoaded(fs.readFileSync(HOOK, 'utf8'));
  assert.ok(siblings.includes('guard-update-notice.js'), `el aviso carga guard-update-notice.js; encontré: ${siblings.join(', ') || 'nada'}`);
  const cases = allCases();
  assert.ok(cases.some((c) => (c.setup || []).join(' ').includes('$TCG/scripts/hooks/production-notice.js')), 'ningún caso copia el aviso: la prueba no mide nada');
  assert.deepStrictEqual(missingSiblings(cases, siblings), []);
});

test('T1 laboratorio — encuentra las dos formas de cargar un guion de la carpeta, y un cp sin él falta', () => {
  const fuente = [
    "const a = require(path.join(__dirname, 'uno.js'));",
    "const b = require('./dos.js');",
    "const c = require(path.join(__dirname, '..', 'lib', 'otra.js'));",
    "const d = require('fs');",
  ].join('\n');
  assert.deepStrictEqual(siblingsLoaded(fuente), ['dos.js', 'uno.js']);
  const cases = [
    { id: 'completo', setup: ['mkdir -p tcg/scripts/hooks && cp $TCG/scripts/hooks/production-notice.js $TCG/scripts/hooks/uno.js $TCG/scripts/hooks/dos.js tcg/scripts/hooks/'] },
    { id: 'incompleto', setup: ['mkdir -p x && cp $TCG/scripts/hooks/production-notice.js $TCG/scripts/hooks/uno.js tcg/scripts/hooks/ && cp $TCG/scripts/hooks/dos.js otro/'] },
    { id: 'sin-aviso', setup: ['true'] },
  ];
  assert.deepStrictEqual(missingSiblings(cases, ['dos.js', 'uno.js']), [{ id: 'incompleto', faltan: ['dos.js'] }]);
});
