#!/usr/bin/env node
/**
 * readme-index.test.js — el README se achica, pero ninguna pieza se queda sin dónde encontrarla
 * (story 7.7, 2026-09-19).
 *
 * El README se importa ENTERO en cada sesión y en cada subagente de cada dev. La 7.4 lo había vuelto
 * índice (una línea por pieza, 110 líneas); la 7.7 saca también el índice —las piezas se buscan en
 * `guides/piezas-del-arnes.md`, que se lee a demanda— y el README queda con lo que se usa en cada
 * sesión: la tabla «Cuándo leer cada guía», las reglas siempre activas y los comandos del día a día.
 *
 * Sacar 110 líneas de un índice es la forma más barata de perder una pieza sin que nadie lo note, así
 * que el recorte vive detrás de esta guarda:
 *   T6 — cada archivo o carpeta que el «Qué contiene» del README de la base nombraba sigue nombrado en
 *        `guides/piezas-del-arnes.md` o en el README nuevo.
 *   T5 — el README pesa ≤ 25 KB y conserva sus tres secciones de uso diario.
 *
 * La lista de la base vive en `fixtures/readme-index.json` y no en `git show`: el nocturno clona sin
 * historia, y una guarda que no puede leer su referencia no guarda nada.
 *
 * Correr:   node --test scripts/tests/readme-index.test.js
 * Regenerar la lista (sólo si cambia la base, con git): node scripts/tests/readme-index.test.js --generate
 * (`--generar` hasta la story 8.9, tanda E)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'readme-index.json');
const TOPE_BYTES = 25 * 1024;

// Las rutas que nombra un bloque de índice: destinos de enlaces (sin el ancla) y rutas en backticks.
function rutasDe(texto) {
  const out = new Set();
  for (const m of texto.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) out.add(m[1].replace(/^\.\//, ''));
  for (const m of texto.matchAll(/`([\w./-]+(?:\.(?:js|sh|ps1|md|json|ya?ml)|\/))`/g)) out.add(m[1]);
  return [...out].filter((r) => !/^https?:/.test(r)).sort();
}

// ¿La ruta está nombrada ENTERA? No alcanza con que sea subcadena: `buzon/` está dentro de
// `scripts/buzon/buzon.js` y `engram-version` dentro de `scripts/setup/check-engram-version.sh`, así
// que perder la carpeta o el archivo de la raíz daba verde igual (pase adversarial de la 7.7: 11 de
// las 144 rutas eran parte de otra). Antes no puede venir otro carácter de ruta; después, ni letra ni
// guion, y un archivo tampoco puede seguir como `.algo` (`engram-version.md` no nombra a `engram-version`).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nombrada(ruta, texto) {
  const fin = ruta.endsWith('/') ? '' : '(?![\\w-]|\\.\\w)';
  return new RegExp(`(?<![\\w./-])${esc(ruta)}${fin}`).test(texto);
}

function seccion(texto, titulo, hasta) {
  const i = texto.indexOf(titulo);
  if (i < 0) return '';
  const j = texto.indexOf(hasta, i + titulo.length);
  return texto.slice(i, j < 0 ? undefined : j);
}

if (require.main === module && process.argv.includes('--generate')) {
  const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).base;
  const readme = execFileSync('git', ['-C', REPO, 'show', `${base}:README.md`], { encoding: 'utf8' });
  const rutas = rutasDe(seccion(readme, '## Qué contiene', '## Cuándo leer'));
  const previo = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  fs.writeFileSync(FIXTURE, JSON.stringify({ ...previo, rutas }, null, 1) + '\n');
  console.log(`readme-indice: ${rutas.length} rutas desde ${base}`);
  process.exit(0);
}

const { test } = require('node:test');
const assert = require('node:assert');

const leer = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('Readme_IndiceCompleto (T6): cada ruta del «Qué contiene» de la base sigue nombrada', () => {
  const { rutas } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.ok(Array.isArray(rutas) && rutas.length >= 100, `la lista de la base tiene ${rutas && rutas.length} rutas; se esperaban las ~110 del índice`);
  const donde = leer('guides/piezas-del-arnes.md') + '\n' + leer('README.md');
  const faltan = rutas.filter((r) => !nombrada(r, donde));
  assert.deepEqual(faltan, [], `rutas del índice de la base que ya no nombra ni la guía de piezas ni el README: ${faltan.join(', ')}`);
});

test('Readme_IndiceCompleto (T6): una ruta dentro de otra más larga NO cuenta como nombrada', () => {
  assert.equal(nombrada('buzon/', 'ver scripts/buzon/buzon.js'), false);
  assert.equal(nombrada('engram-version', 'y scripts/setup/check-engram-version.sh'), false);
  assert.equal(nombrada('engram-version', 'el pin engram-version.md'), false);
  assert.equal(nombrada('scripts/controls-bench/', 'tools/scripts/controls-bench/x'), false);
  assert.equal(nombrada('buzon/', '*(scripts/buzon/buzon.js + buzon/)*'), true);
  assert.equal(nombrada('engram-version', '## engram-version\n'), true);
  assert.equal(nombrada('release-notes.sh', 'el `release-notes.sh` copiado'), true);
});

test('Readme_Tamano_Secciones (T5): ≤ 25 KB y las tres secciones de uso diario', () => {
  const readme = leer('README.md');
  const bytes = Buffer.byteLength(readme, 'utf8');
  assert.ok(bytes <= TOPE_BYTES, `el README pesa ${bytes} bytes (tope ${TOPE_BYTES})`);
  assert.match(readme, /^## Cuándo leer cada guía/m, 'falta la tabla «Cuándo leer cada guía»');
  assert.match(seccion(readme, '## Cuándo leer cada guía', '\n## '), /^\| .+ \| .+ \|$/m, 'la sección «Cuándo leer cada guía» no tiene tabla');
  assert.match(readme, /^## Regla siempre activa — CodeGraph/m, 'falta la regla siempre activa de CodeGraph');
  assert.match(readme, /^## Regla siempre activa — Routing Bizuit por entorno \(BZURL\)/m, 'falta la regla siempre activa BZURL');
  assert.match(readme, /^## Cheat sheet/m, 'faltan los comandos del día a día (Cheat sheet)');
  assert.match(readme, /\/tycon-merge-to-main/, 'el cheat sheet perdió el merge a main');
});
