'use strict';
// site-findings-titles.test.js — los títulos de las fichas de ejecuciones de Mantenimiento, en los dos idiomas.
//
// El nombre de una causa lo escribe la noche en minúscula («pase adversarial salteado») y el inglés sale del código de la
// causa («adversarial pass skipped»): como título de una ficha, arranca con mayúscula. Y una causa que el catálogo no
// conoce no tiene inglés: en inglés quedaba la frase en castellano junto al enlace en inglés («Las pruebas quedaron en
// rojo al cerrar Work item 5001», recorrido del sitio del 27/11). El demo inventaba una causa así.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FINDINGS = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'findings.js'));
const CN = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cause-names.js'));

// 🔴 Falla con: el título tal como lo escribe la noche, en minúscula.
test('F1 TituloDeEjecucion_ArrancaConMayuscula — en castellano y en inglés', () => {
  assert.strictEqual(typeof FINDINGS.conMayuscula, 'function', 'la pestaña exporta conMayuscula');
  assert.strictEqual(FINDINGS.conMayuscula('pase adversarial salteado'), 'Pase adversarial salteado');
  assert.strictEqual(FINDINGS.conMayuscula('adversarial pass skipped'), 'Adversarial pass skipped');
  assert.strictEqual(FINDINGS.conMayuscula('ñandú'), 'Ñandú');
  assert.strictEqual(FINDINGS.conMayuscula(''), '');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'tabs', 'findings.js'), 'utf8');
  // como título dibujado, sólo en las de ejecuciones: dentro de una oración y en los datos el nombre queda como vino
  assert.match(src, /const tituloVisible = \(x\) => \(x && x\.fuente === 'ejecuciones' \? conMayuscula\(x\.nombre\)/);
  assert.strictEqual((src.match(/esc\(tituloVisible\((?:f|x)\)\)/g) || []).length, 4, 'las cuatro listas que dibujan el nombre como título');
});

// 🔴 Falla con: una ficha de ejecuciones del demo con una causa que la noche nunca escribe (sin nombre en inglés).
test('F2 Demo_FichasDeEjecuciones_ConCausasDelCatalogo — todas tienen su nombre en inglés', () => {
  const demo = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'demo', 'data.js'), 'utf8');
  const causas = [...demo.matchAll(/fuente: 'ejecuciones', causa: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(causas.length >= 2, `las fichas de ejecuciones del demo: ${causas}`);
  for (const c of causas) assert.ok(CN.codigoDeLaFicha(c), `el demo usa la causa ${c}, que el catálogo de la noche no conoce`);
});
