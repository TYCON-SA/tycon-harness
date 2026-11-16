'use strict';
/**
 * file-zones.test.js — una lista de archivos dicha en palabras (scripts/lib/file-zones.js `zonasDe`): cuántos y de qué
 * zonas, sin rutas. Es lo que muestra el cuadro de una firma en lugar de la lista (historia 8.275). Sin red, milisegundos.
 */
const test = require('node:test');
const assert = require('node:assert');

const { zonasDe } = require('../lib/file-zones.js');

// 🔴 Falla con: una lista que nombra rutas, que cuenta dos veces una ruta repetida o que cambia el orden de las clases.
test('FileZones_MixedList_CountsByClass (T1) @story-8.275 @ac-4', () => {
  const rutas = ['scripts/lib/owner-window.js', 'scripts/lib/signature-list.js', 'scripts/lib/owner-approvals.js', 'scripts/lib/file-zones.js',
    'scripts/tools/coordination.js', 'scripts/tools/harness.js', 'scripts/tests/a.test.js', 'scripts/tests/b.test.js', 'skills/x/tests/c.js',
    'web/__tests__/d.js', 'specs/story-8.275-x.md', 'scripts/lib/owner-window.js'];
  const z = zonasDe(rutas);
  assert.strictEqual(z, '11 archivos: 6 de código (lib y tools), 4 pruebas, 1 historia');
  assert.doesNotMatch(z, /\//);
  // las demás clases, en su orden: guías, configuración y otros
  assert.strictEqual(zonasDe(['README.md', 'guides/a.md', 'a.json', 'b.yml', 'c.yaml', 'd.toml', 'logo.png', 'x.spec.ts', 'story-1.2-x.md']),
    '9 archivos: 1 prueba, 1 historia, 2 guías, 4 de configuración, 1 otro');
});

// 🔴 Falla con: tres archivos de código nombrados con su carpeta o su extensión, o más carpetas de las que entran.
test('FileZones_UpToThreeCodeFiles_NamedWithoutPath (T2) @story-8.275 @ac-4', () => {
  assert.strictEqual(zonasDe(['scripts/lib/owner-window.js', 'scripts/lib/signature-list.js', 'scripts/tools/coordination.js']),
    '3 archivos: 3 de código (owner-window, signature-list y coordination)');
  assert.strictEqual(zonasDe(['a/foo.js', 'b/bar.cs']), '2 archivos: 2 de código (foo y bar)');
});

test('FileZones_ManyFolders_SaysHowManyMore (T2) @story-8.275 @ac-4', () => {
  const z = zonasDe(['a/1.js', 'b/2.js', 'c/3.js', 'd/4.js', 'e/5.js', 'a/6.js']);
  assert.strictEqual(z, '6 archivos: 6 de código (a, b, c y 2 carpetas más)');
  // un archivo de código en la raíz cuenta como la carpeta «raíz»
  assert.strictEqual(zonasDe(['x.js', 'y.js', 'lib/z.js', 'lib/w.js']), '4 archivos: 4 de código (raíz y lib)');
});

// 🔴 Falla con: «1 archivos», o una zona para una lista vacía.
test('FileZones_OneOrNone (T3) @story-8.275 @ac-5', () => {
  assert.strictEqual(zonasDe(['scripts/lib/owner-window.js']), '1 archivo: de código (owner-window)');
  assert.strictEqual(zonasDe(['scripts/tests/a.test.js']), '1 archivo: una prueba');
  assert.strictEqual(zonasDe(['guides/a.md']), '1 archivo: una guía');
  assert.strictEqual(zonasDe([]), null);
  assert.strictEqual(zonasDe(null), null);
  assert.strictEqual(zonasDe(['', '  ']), null);
});

// 🔴 Falla con: un archivo anotado en el plan («a.js (nuevo)») contado como «otro», una ruta con «..» en otra zona, o la
//    raíz absoluta como carpeta vacía (pase adversarial de la 8.275).
test('FileZones_AnnotatedAndOddPaths (pase C, E) @story-8.275 @ac-4', () => {
  assert.strictEqual(zonasDe(['scripts/lib/a.js (nuevo)', 'scripts/lib/b.js', 'scripts/tools/c.js']), '3 archivos: 3 de código (a, b y c)');
  assert.strictEqual(zonasDe(['x/tests/../hook.sh']), '1 archivo: de código (hook)');
  assert.strictEqual(zonasDe(['/a.js', '/b.js', 'x/c.js', 'y/d.js']), '4 archivos: 4 de código (raíz, x y y)');
  // barras invertidas, y un nombre de más de 40 letras que no se nombra: cuenta por su carpeta
  assert.strictEqual(zonasDe(['scripts\\lib\\a.js']), '1 archivo: de código (a)');
  assert.strictEqual(zonasDe([`lib/${'n'.repeat(41)}.js`, 'tools/b.js']), '2 archivos: 2 de código (lib y tools)');
});
