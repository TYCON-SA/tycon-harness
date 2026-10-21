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

test('T20 Largo_TresLugares_ConLoQueCorresponde @story-2.63 @ac-15 @ac-16 @ac-17 — las instrucciones, la mejora y los bloques de Configuración, cada uno con lo suyo', () => {
  // 🔴 rojo: el editor sólo está en las instrucciones del revisor; la mejora y Configuración tienen un cuadro común.
  const ROOT = path.join(__dirname, '..', '..');
  const TAB = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'));
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  const TX = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const { enCastellano } = require('./lib/spanish-text.js');
  for (const idioma of ['es', 'en']) {
    const g = TAB.guion(idioma);
    // las instrucciones: vista previa y qué cambió; la mejora: vista previa, sin qué cambió (no tiene original)
    assert.match(g, /LongTextEditor\.montar\(texto, \{ vistaPrevia: true, queCambio: true/, `${idioma}: las instrucciones`);
    assert.match(g, /LongTextEditor\.montar\(ta, \{ vistaPrevia: true, queCambio: false/, `${idioma}: la mejora`);
    // Configuración: qué cambió (contra el texto con que se abrió), sin vista previa (es JSON)
    const c = ORG.pantalla(idioma);
    assert.match(c, /LongTextEditor\.montar\(ta, \{ vistaPrevia: false, queCambio: true/, `${idioma}: los bloques de Configuración`);
    for (const k of ['escribir', 'vistaPrevia', 'buscar', 'buscarQue', 'siguiente', 'unaVez', 'vecesN', 'queCambio', 'sinCambios', 'ampliar', 'volver']) {
      const v = TX.t(idioma, `pantalla.lte.${k}`);
      assert.ok(v && v !== `pantalla.lte.${k}`, `${idioma}: Configuración tiene el texto ${k}`);
      if (idioma === 'en') assert.deepStrictEqual(enCastellano([v]), [], `pantalla.lte.${k} sin castellano en inglés`);
    }
    assert.match(c, /T\('pantalla\.lte\.queCambio'\)/, `${idioma}: Configuración usa sus textos`);
    // las herramientas, explicadas en los dos idiomas (lo mismo que en el editor del revisor)
    for (const h of TAB.HERRAMIENTAS) assert.ok(TX.t(idioma, `comoTrabaja.herramienta.${h}`) !== `comoTrabaja.herramienta.${h}`, `${idioma}: ${h}`);
  }
  // (pase adversarial) la mejora no va adentro de un <label> (un clic en la vista previa activaría «Escribir»);
  // Configuración compara contra el texto con que se abrió la sección aunque se redibuje con el borrador; y el editor
  // vuelve a medir su alto cuando pasa a verse (montado adentro de un desplegable cerrado quedaba cortado)
  const g = TAB.guion('es');
  assert.doesNotMatch(g, /el\('label', \{\}, el\('span', \{ text: T\('comoTrabaja\.mejoraQue'\) \}\), ta\)/, 'la mejora, fuera de un label');
  const c = ORG.pantalla('es');
  assert.match(c, /original: S\.abiertos\[abierto\]/, 'Configuración pasa el texto con que se abrió');
  assert.match(c, /function ponerBase[\s\S]*?olvidarAbiertos\(s\.id\)/, 'una base nueva renueva ese texto');
  // el original de «Ver qué cambió»: el que pasa quien monta (aunque el cuadro traiga el borrador), o el del cuadro
  assert.strictEqual(LTE.originalDe('{"nota":"x"}', { original: '{}' }), '{}');
  assert.strictEqual(LTE.originalDe('{"nota":"x"}', {}), '{"nota":"x"}');
  assert.strictEqual(LTE.originalDe('a', { original: '' }), '', 'un original vacío vale (una sección nueva)');
  assert.deepStrictEqual(LTE.queCambio(LTE.originalDe('{\n"nota": "x"\n}', { original: '{}' }), '{\n"nota": "x"\n}').filter((x) => x[0] !== 'igual').length > 0, true, 'con el borrador en el cuadro, el cambio se ve');
  // volver a medir el alto: sólo cuando la caja se ve y su ancho cambió (oculta mide 0; la misma medida, no se repite)
  assert.strictEqual(LTE.hayQueMedir(0, 0), false, 'oculta: no');
  assert.strictEqual(LTE.hayQueMedir(0, 640), true, 'pasa a verse: sí');
  assert.strictEqual(LTE.hayQueMedir(640, 640), false, 'el mismo ancho: no (no se vuelve a medir en bucle)');
  assert.strictEqual(LTE.hayQueMedir(640, 390), true, 'cambió el ancho: sí');
  const lte = require('fs').readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'long-text-editor.js'), 'utf8');
  assert.match(lte, /var original = originalDe\(ta\.value, o\)/, 'el editor usa ese original');
  assert.match(lte, /new ResizeObserver\(function \(\) \{ var w = caja\.clientWidth; if \(hayQueMedir\(ancho, w\)\)/, 'y vuelve a medir el alto al verse');
  // las dos páginas cargan el editor compartido
  for (const archivo of ['how-it-works.js', 'config.js']) {
    assert.match(require('fs').readFileSync(path.join(ROOT, 'scripts', 'site', 'tabs', archivo), 'utf8'), /<script src="\/static\/long-text-editor\.js" defer><\/script>/, `${archivo} carga el editor`);
  }
});
