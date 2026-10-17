#!/usr/bin/env node
/**
 * readme-index.test.js — el README se achica, pero ninguna pieza se queda sin dónde encontrarla
 * (story 7.7, 2026-09-19).
 *
 * Desde el 2026-10-14 el índice se llama INDEX.md: README.md quedó como la portada para personas que muestra GitHub.
 * Lo que este archivo dice del «README» vale para el índice, hoy INDEX.md; la base de T6 sigue siendo el README de antes.
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
  // el índice se partió en dos: lo de uso diario queda en el README (se carga en cada sesión) y lo de quien mantiene el
  // arnés pasó a guides/maintaining/mantener-el-arnes.md (a demanda), que el README nombra en su última fila
  const donde = leer('guides/piezas-del-arnes.md') + '\n' + leer('INDEX.md') + '\n' + leer('guides/maintaining/mantener-el-arnes.md');
  const faltan = rutas.filter((r) => !nombrada(r, donde));
  assert.deepEqual(faltan, [], `rutas del índice de la base que ya no nombra ni la guía de piezas, ni el README, ni la guía de mantener: ${faltan.join(', ')}`);
  assert.ok(nombrada('guides/maintaining/mantener-el-arnes.md', leer('INDEX.md')), 'el índice (INDEX.md) nombra la guía de mantener el arnés');
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

// story 8.40, tanda B (T33): el alta de una organización tiene su fila en el índice y su sección en las dos referencias.
// Hasta la primera publicación del paquete de npm el alta se cuenta con `harness.js team-init` (cambio 2 de la
// coordinadora): la sección no promete npx
test('Index_HasTeamInitRow (T33): la fila del alta apunta a la referencia, y la sección existe sin prometer npx', () => {
  const index = leer('INDEX.md');
  const row = index.split('\n').find((l) => /^\| Dar de alta una organización nueva/.test(l));
  assert.ok(row, 'INDEX.md no tiene la fila «Dar de alta una organización nueva»');
  assert.match(row, /harness\.js team-init/, 'la fila del alta no nombra harness.js team-init');
  assert.match(row, /getting-started\/reference\.es\.md/, 'la fila del alta no apunta a la referencia');
  for (const [file, title] of [['getting-started/reference.es.md', '## Dar de alta tu organización'], ['getting-started/reference.md', '## Set up your organization']]) {
    const text = leer(file);
    assert.ok(text.includes(`\n${title}\n`), `${file} no tiene la sección «${title}»`);
    const sec = seccion(text, `${title}\n`, '\n## ');
    assert.match(sec, /harness\.js team-init/, `${file}: la sección del alta no cuenta harness.js team-init`);
    assert.doesNotMatch(sec, /npx /, `${file}: la sección del alta promete npx antes de que el paquete exista`);
    for (const f of ['team-layer.json', 'team-profile.json', 'team-repos.json', '--dry-run']) assert.ok(sec.includes(f), `${file}: la sección del alta no nombra ${f}`);
  }
});

// story 8.40, el cierre (T52): la guía para mantener el paquete de npm dice lo que hace falta saber el día que sale una
// versión, falla o hay que retirarla, y la nombran la guía de mantener el arnés y la ficha de la pieza
test('Guides_NpmPackageMaintainerGuide (T52): cómo sale, se aprueba, falla y se retira una versión del paquete', () => {
  const g = leer('guides/maintaining/paquete-npm.md');
  for (const s of ['npm stage approve', 'npm deprecate', '72 horas', '2 días', 'NPM_PUBLISH_ENABLED', 'Run workflow', 'Trusted publishing']) assert.ok(g.includes(s), `guides/maintaining/paquete-npm.md no nombra «${s}»`);
  const row = leer('guides/maintaining/mantener-el-arnes.md').split('\n').find((l) => l.startsWith('|') && l.includes('guides/maintaining/paquete-npm.md'));
  assert.ok(row, 'guides/maintaining/mantener-el-arnes.md no tiene la fila de la guía del paquete de npm');
  assert.ok(leer('guides/piezas-del-arnes.md').includes('guides/maintaining/paquete-npm.md'), 'la ficha de npm-publish.yml no nombra la guía');
});

test('Readme_Tamano_Secciones (T5): ≤ 25 KB y las tres secciones de uso diario', () => {
  const readme = leer('INDEX.md');
  const bytes = Buffer.byteLength(readme, 'utf8');
  assert.ok(bytes <= TOPE_BYTES, `el índice (INDEX.md) pesa ${bytes} bytes (tope ${TOPE_BYTES})`);
  assert.match(readme, /^## Cuándo leer cada guía/m, 'falta la tabla «Cuándo leer cada guía»');
  assert.match(seccion(readme, '## Cuándo leer cada guía', '\n## '), /^\| .+ \| .+ \|$/m, 'la sección «Cuándo leer cada guía» no tiene tabla');
  assert.match(readme, /^## Regla siempre activa — CodeGraph/m, 'falta la regla siempre activa de CodeGraph');
  // la de BZURL es del paquete bizuit: la escribe en el CLAUDE.md su bloque (packs/bizuit/claude-md-blocks/), sólo con el paquete activo
  assert.doesNotMatch(readme, /BZURL/, 'la regla BZURL es del paquete bizuit, no del índice del núcleo');
  assert.match(readme, /^## Cheat sheet/m, 'faltan los comandos del día a día (Cheat sheet)');
  assert.match(readme, /\/tycon-merge-to-main/, 'el cheat sheet perdió el merge a main');
});
