#!/usr/bin/env node
/**
 * pre-commit-hook.test.js — `publicHarnessHook` da el gancho del arnés público también en el árbol armado, y nunca
 * otro en su lugar.
 *
 * En el árbol armado (el privado con el público encima) `.githooks/pre-commit-checks` es la copia propia del privado:
 * las suites que miran el texto del gancho público lo leían y daban rojo en la noche, sin que el gancho público
 * cambiara. Con TYCON_CHECKS_PUBLIC_HOOK leen el público; sin ella, tiran (no poder mirarlo no es verde).
 *
 * Correr: node --test scripts/tests/pre-commit-hook.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preCommitHook, publicHarnessHook } = require('./lib/pre-commit-hook.js');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-hook-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

// 🔴 Falla con: las suites del gancho leyendo la copia propia del privado en el árbol armado (rojas desde el 23/11, sin
// que el gancho público cambiara), o un árbol armado sin el gancho público que pasa verde sin haberlo mirado
test('T1 PublicHarnessHook_ArbolArmado_LeeElPublicoOFalla — con la copia propia del privado, el público por la variable; sin ella, tira', () => {
  const publico = tree({ '.githooks/pre-commit-checks': '# el público\n' });
  const armado = tree({
    '.githooks/pre-commit-checks': '# la copia del privado\n',
    '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin', own: { '.githooks/pre-commit-checks': 'la suya' }, mirror: {} }),
  });
  const conVariable = path.join(publico, '.githooks', 'pre-commit-checks');
  assert.strictEqual(publicHarnessHook(armado, { TYCON_CHECKS_PUBLIC_HOOK: conVariable }), conVariable);
  assert.throws(() => publicHarnessHook(armado, {}), /copia propia del privado.*TYCON_CHECKS_PUBLIC_HOOK/);
  assert.throws(() => publicHarnessHook(armado, { TYCON_CHECKS_PUBLIC_HOOK: path.join(publico, 'no-esta') }), /no existe/);
});

test('T2 PublicHarnessHook_FueraDelArbolArmado_ElDelRepo — sin la lista del privado, o sin el gancho en ella, el del repo', () => {
  const publico = tree({ '.githooks/pre-commit-checks': '# el público\n' });
  assert.strictEqual(publicHarnessHook(publico, {}), preCommitHook('harness', publico));
  const otraCopia = tree({
    '.githooks/pre-commit-checks': '# el del árbol\n',
    '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin', own: { 'README.md': 'la suya' }, mirror: {} }),
  });
  assert.strictEqual(publicHarnessHook(otraCopia, { TYCON_CHECKS_PUBLIC_HOOK: '/no/importa' }), preCommitHook('harness', otraCopia));
  const rota = tree({ '.githooks/pre-commit-checks': '#\n', '.tycon/internal-forms.json': '{ roto' });
  assert.throws(() => publicHarnessHook(rota, {}), /no pude leer/);
});
