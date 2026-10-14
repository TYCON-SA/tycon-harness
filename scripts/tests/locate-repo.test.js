#!/usr/bin/env node
/**
 * locate-repo.test.js — red de `ubicarRepo` (scripts/nightly/dependencies/nightly-dependencies.js).
 *
 * POR QUÉ EXISTE (2026-09-29). `ruta` en repos.json es la ETIQUETA de una entrada, no el nombre de
 * la carpeta. En Azure eso no se nota —el pipeline clona en `<raiz>/<ruta>`—, pero en la máquina de
 * un dev cada uno clonó con el nombre que quiso: `Orbita/FrontEnd` vive en
 * `Orbita/OrbitaFrontEnd`. Esos repos salían NO MEDIDO con «el repo no está en …»: verdad
 * literal, conclusión falsa. Ahora se los ubica por IDENTIDAD — el `origin` que apunta al mismo
 * repo de Azure que declara `ado` — y no por parecido de nombre.
 *
 * Lo que estos casos protegen, y que sin ellos se rompería en silencio:
 *   · que NO se adivine por nombre parecido (ahí es donde se termina auditando el repo ajeno);
 *   · que sin `ado` no se busque nada (sin identidad no hay a qué comparar);
 *   · que cuando se reubica, el informe lo DIGA (un número medido en otra carpeta que la declarada
 *     no puede parecer medido en la declarada).
 *
 * Ninguno toca la red: los repos son `git init` locales con un `origin` inventado (organización y productos de
 * mentira: acme, Orbita, Quasar, Fondo).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ubicarRepo } = require(path.join(__dirname, '..', 'nightly', 'dependencies', 'nightly-dependencies.js'));

let casos = 0, fallos = 0;
const prueba = (m, fn) => { casos++; try { fn(); console.log(`✅ ubicar-repo: ${m}`); } catch (e) { fallos++; console.log(`❌ ubicar-repo: ${m} — ${e.message}`); } };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'ubicar-'));
/** Un repo git de mentira con el `origin` que se le pida. */
function repo(rel, origin) {
  const d = path.join(RAIZ, rel);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['-C', d, 'init', '-q']);
  if (origin) execFileSync('git', ['-C', d, 'remote', 'add', 'origin', origin]);
  return d;
}

const ADO_ORBITA = 'Orbita/FrontEnd';
repo('Orbita/OrbitaFrontEnd', 'https://acme.visualstudio.com/Orbita/_git/FrontEnd');
repo('Orbita/OtroQueNoEs', 'https://acme.visualstudio.com/Orbita/_git/BackEnd');
repo('Quasar/QuasarFrontend', 'https://dev.azure.com/acme/AcmePlugins/_git/QuasarPluginFrontEnd.git');
repo('Solo/ConNombreParecido/FrontEnd', null);           // se llama igual, pero no es un repo de ADO
repo('Fondo/FondoExtForms', 'https://acme.visualstudio.com/Fondo%20Creditos/_git/FondoExtForms');

prueba('si la carpeta declarada existe, no se busca nada', () => {
  const r = ubicarRepo({ ruta: 'Fondo/FondoExtForms', ado: 'Fondo%20Creditos/FondoExtForms' }, RAIZ);
  assert.strictEqual(r.dir, path.join(RAIZ, 'Fondo/FondoExtForms'));
  assert(!r.reubicado, 'se marcó como reubicado sin haberlo hecho');
});

prueba('🔴 una carpeta con OTRO nombre se encuentra por su remoto, no por el nombre', () => {
  const r = ubicarRepo({ ruta: 'Orbita/FrontEnd', ado: ADO_ORBITA }, RAIZ);
  assert.strictEqual(r.dir, path.join(RAIZ, 'Orbita/OrbitaFrontEnd'), `ubicó mal: ${r.dir}`);
  assert(r.reubicado, 'no dejó constancia de que la encontró en otro lado');
});

prueba('…y funciona con las dos formas del servidor y con el .git al final', () => {
  const r = ubicarRepo({ ruta: 'Quasar/QuasarPluginfrontend', ado: 'AcmePlugins/QuasarPluginfrontend' }, RAIZ);
  assert.strictEqual(r.dir, path.join(RAIZ, 'Quasar/QuasarFrontend'), `ubicó mal: ${r.dir}`);
});

prueba('🔴 NO se conforma con un vecino del mismo proyecto: compara el repo también', () => {
  const r = ubicarRepo({ ruta: 'Orbita/NoExiste', ado: 'Orbita/Inexistente' }, RAIZ);
  assert(!r.reubicado, `agarró un repo ajeno: ${r.dir}`);
});

prueba('🔴 sin `ado` no se busca: sin identidad, adivinar por nombre es agarrar cualquier cosa', () => {
  const r = ubicarRepo({ ruta: 'Orbita/FrontEnd' }, RAIZ);
  assert(!r.reubicado, `buscó sin identidad y encontró ${r.dir}`);
  assert.strictEqual(r.dir, path.join(RAIZ, 'Orbita/FrontEnd'));
});

prueba('una carpeta que se llama igual pero no es un repo git no cuenta', () => {
  const r = ubicarRepo({ ruta: 'Solo/NoExiste', ado: 'Solo/FrontEnd' }, RAIZ);
  assert(!r.reubicado, `tomó una carpeta que no es un repo: ${r.dir}`);
});

prueba('un repo que de verdad no está sigue devolviendo la ruta declarada (y será NO MEDIDO)', () => {
  const r = ubicarRepo({ ruta: 'Fantasma/NoEsta', ado: 'Fantasma/NoEsta' }, RAIZ);
  assert.strictEqual(r.dir, path.join(RAIZ, 'Fantasma/NoEsta'));
  assert(!r.reubicado);
});

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(fallos === 0 ? `✅ ubicar-repo: todo verde (${casos} casos)` : `❌ ubicar-repo: ${fallos} fallo(s) de ${casos}`);
process.exitCode = fallos === 0 ? 0 : 1;
