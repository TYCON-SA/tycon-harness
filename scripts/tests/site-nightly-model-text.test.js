'use strict';
// site-nightly-model-text.test.js — la fila «El proceso de la noche» de Configuración dice lo que pasa de verdad.
//
// Sin `models.nightly` la noche corre igual: suites, banco, tablero y comparaciones. Lo único que no se escribe es lo
// que redacta un modelo (los aprendizajes del equipo, las propuestas de hallazgos, los temas de la oficina: los que
// llaman a nightly-model.js). El sitio decía «sin configurar (la noche no corre)», y en el mismo sitio se veían los
// datos de la noche de hoy: quien mantiene podía «arreglar» algo que no estaba roto o desconfiar de todo lo nocturno
// (recorrido del sitio del 27/11).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { TEXTOS } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));

// 🔴 Falla con: el texto que dice que la noche no corre sin el modelo, o la opción del selector con esa frase larga.
test('N1 NocheSinModelo_DiceQueLaNocheCorre_YQueNoRedacta — en los dos idiomas', () => {
  const linea = TEXTOS['pantalla.nocheSinConfigurar'];
  assert.ok(linea, 'falta el texto de la fila');
  assert.doesNotMatch(linea.es, /no corre/, linea.es);
  assert.doesNotMatch(linea.en, /does not run/, linea.en);
  assert.match(linea.es, /la noche corre/, linea.es);
  assert.match(linea.es, /modelo/, linea.es);
  assert.match(linea.en, /runs/, linea.en);
  // la opción vacía del selector es corta: el porqué va en la línea de la fila, no en cada opción
  const opcion = TEXTOS['pantalla.nocheSinProveedor'];
  assert.ok(opcion && opcion.es === 'sin configurar' && opcion.en === 'not set', JSON.stringify(opcion));
  const oc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'org-config.js'), 'utf8');
  assert.match(oc, /\[\['', T\('pantalla\.nocheSinProveedor'\)\]\]/, 'el selector usa la opción corta');
});
