'use strict';
/**
 * slow-suites-goal.test.js — lo que las guías dicen de las suites del arnés: cuántas corren a la vez, cuáles son las
 * lentas y desde dónde acota un portón corrido a mano.
 *
 *   T21 Guia_TrabajadoresLentasYBase — las dos guías: cuántas a la vez y por qué, las lentas, la base del portón
 *
 * 🔴 Falla con: una de las dos guías sin la regla de cuántas a la vez, sin el comando de las lentas o sin la base.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('T21 Guia_TrabajadoresLentasYBase — las dos guías dicen cuántas a la vez y por qué, cómo ver las lentas y la base del portón', () => {
  for (const g of ['guides/test-execution-discipline.md', 'guides/piezas-del-arnes.md']) {
    const texto = fs.readFileSync(path.join(ROOT, g), 'utf8');
    assert.match(texto, /núcleos menos dos/, `${g}: cuántas suites corren a la vez`);
    assert.match(texto, /dos núcleos (?:quedan )?para la persona/i, `${g}: por qué no más`);
    assert.match(texto, /suite-times\.js slow/, `${g}: cómo se listan las lentas`);
    assert.match(texto, /bifurcación con main/, `${g}: un portón a mano acota desde la bifurcación con main`);
  }
});
