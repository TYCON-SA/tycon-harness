'use strict';
/*
 * long-text-editor.test.js — el editor de texto largo del sitio (scripts/site/static/long-text-editor.js): la vista
 * previa, lo que cambió contra el texto con que se abrió y la búsqueda. Lo que hace en la página (crecer, ampliar,
 * las solapas) lo recorre la prueba en vivo; acá, las partes que deciden algo, sin navegador.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LTE = require(path.join(__dirname, '..', 'site', 'static', 'long-text-editor.js'));

test('T17 Largo_VistaPrevia_TitulosListasCodigo @story-2.63 @ac-16 — títulos, listas y código; todo lo demás, escapado', () => {
  // 🔴 rojo: la vista previa ejecuta lo que se escribió (<script>), o no reconoce los títulos y las listas.
  const html = LTE.vistaPrevia('## Qué mirás\n- uno\n- dos con `codigo`\n\nTexto <script>alert(1)</script> y & más\n### Otro\n');
  assert.match(html, /<h2>Qué mirás<\/h2>/);
  assert.match(html, /<ul><li>uno<\/li><li>dos con <code>codigo<\/code><\/li><\/ul>/);
  assert.match(html, /<h3>Otro<\/h3>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; y &amp; más/);
  assert.doesNotMatch(html, /<script>/);
  assert.strictEqual(LTE.vistaPrevia(''), '', 'vacío, nada');
});

test('T18 Largo_QueCambio_AgregadoYQuitado @story-2.63 @ac-16 — renglón por renglón contra el texto con que se abrió', () => {
  // 🔴 rojo: no marca lo quitado, o dice que hay cambios cuando no los hay.
  assert.deepStrictEqual(LTE.queCambio('a\nb\nc', 'a\nc\nd'), [['igual', 'a'], ['menos', 'b'], ['igual', 'c'], ['mas', 'd']]);
  assert.strictEqual(LTE.hayCambios(LTE.queCambio('a\nb', 'a\nb')), false, 'sin cambios');
  assert.strictEqual(LTE.hayCambios(LTE.queCambio('a', 'a\n')), true, 'un renglón nuevo, aunque vacío, es un cambio');
  // un texto largo no se cuelga: se compara igual
  const largo = Array.from({ length: 2000 }, (_, i) => `renglón ${i}`).join('\n');
  const d = LTE.queCambio(largo, largo.replace('renglón 1000', 'otro'));
  assert.deepStrictEqual(d.filter((x) => x[0] !== 'igual'), [['menos', 'renglón 1000'], ['mas', 'otro']]);
});

test('T19 Largo_Buscar_CuentaYSigue @story-2.63 @ac-15 — cuántas veces aparece, sin mirar mayúsculas, y la siguiente vuelve al principio', () => {
  // 🔴 rojo: cuenta distinto según mayúsculas, o «Siguiente» se queda en la última.
  const texto = 'Uno, uno y UNO; dos';
  const p = LTE.buscar(texto, 'uno');
  assert.deepStrictEqual(p, [0, 5, 11]);
  assert.strictEqual(LTE.siguiente(p, 0), 5, 'desde la primera, la segunda');
  assert.strictEqual(LTE.siguiente(p, 11), 0, 'desde la última, vuelve a la primera');
  assert.strictEqual(LTE.siguiente([], 3), -1, 'sin apariciones, ninguna');
  assert.deepStrictEqual(LTE.buscar(texto, ''), [], 'sin texto a buscar, nada');
  // las posiciones son del texto tal cual: una letra que cambia de largo al pasar a minúscula (İ) no las corre
  const turco = 'İstanbul, istanbul e ISTANBUL';
  for (const p of LTE.buscar(turco, 'stanbul')) assert.strictEqual(turco.slice(p, p + 7).toLowerCase(), 'stanbul', `en ${p} está lo buscado`);
  assert.strictEqual(LTE.buscar(turco, 'stanbul').length, 3);
  assert.deepStrictEqual(LTE.buscar('a.b a.b axb', 'a.b'), [0, 4], 'lo buscado es texto, no un patrón');
});
