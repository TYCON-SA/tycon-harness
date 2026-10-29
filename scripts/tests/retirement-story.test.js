'use strict';

/**
 * retirement-story.test.js — T58: la story de retiro existe y trae lo que el cierre le pide, y las filas de seguimiento
 * la registran.
 *
 * El corte de nombres fija la fecha de retiro y deja los nombres viejos andando hasta entonces; lo que los saca es OTRA
 * story. Si esa story no existe, o no nombra alguna de las cosas que hay que sacar, el retiro llega a la fecha sin plan
 * y los alias quedan para siempre. Lo que exige, leyendo `specs/` y `specs/epics.md`:
 *   · una story con `followup_of` a las dos stories padres (la del corte de nombres y la que dejó su lista de retiro);
 *   · que nombre cada pieza que hay que retirar: reemplazos, alias y lecturas dobles, la carpeta de marcas `legacy-names.d/`, los
 *     pipelines y los cuatro archivos de los productos, el control de paridad, la escritura doble del freno de
 *     producción, la condición (14 días sin usos en el buzón, sin avisos `##vso`; lo que tuvo uso, con su
 *     fecha propia una semana después) y `retire_after`;
 *   · las dos padres con su `followed_up_by` de vuelta;
 *   · la fila de la story en `epics.md` y la fila de la story padre con los números del termómetro de antes y de ahora.
 *
 * `specs/` no viaja en la copia pública: ahí la prueba no mide y lo dice.
 *
 * Correr: node --test scripts/tests/retirement-story.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SPECS = path.join(ROOT, 'specs');
const NOT_MEASURED = !fs.existsSync(path.join(SPECS, 'epics.md')) && 'NO MEDIDO — copia pública sin specs/';

/** El frontmatter de una story (texto entre los dos `---` del principio). */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  return m ? m[1] : '';
}
/** Los ids de un bloque de lista del frontmatter (`followup_of:` o `followed_up_by:`). */
function listIds(fm, key) {
  const at = fm.search(new RegExp(`^${key}:\\s*$`, 'm'));
  if (at < 0) return [];
  const block = fm.slice(at).split('\n').slice(1);
  const ids = [];
  for (const line of block) {
    if (/^\S/.test(line)) break;
    const m = /^\s*-\s*id:\s*"?([\d.]+)"?/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}
/** La story de retiro: la que sigue a las dos padres (puede haber otras que sigan sólo a la primera). */
function findRetirementStory(dir) {
  for (const f of fs.readdirSync(dir).filter((x) => /^story-.*\.md$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const ids = listIds(frontmatter(text), 'followup_of');
    if (ids.includes('8.9') && ids.includes('8.12')) return { file: f, text };
  }
  return null;
}
/** `.tycon/production.json` o el nombre de antes que el mapa de renombres le da (sin mapa, sólo el nuevo). */
function productionConfigPattern() {
  return configPattern('.tycon/production.json');
}
/** Un archivo de configuración de los productos por su nombre nuevo o por el de antes que da el mapa (sin mapa, el nuevo). */
function configPattern(nuevo) {
  const names = [nuevo];
  try {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'renames.json'), 'utf8'));
    for (const e of map.entries || []) if (e && e.kind === 'config-file' && e.new === names[0]) names.push(e.old);
  } catch { /* sin mapa (copia pública): vale el nombre nuevo */ }
  return new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
}
/** Lo que el cierre le pide a la story: cada pieza con las formas en que puede aparecer escrita. */
const REQUIRED = [
  ['los reemplazos', /reemplazo/i],
  ['los alias', /\balias\b/i],
  ['las lecturas dobles', /lectura(s)? doble/i],
  ['la carpeta de marcas legacy-names.d', /legacy-names\.d/],
  ['los pipelines de los productos', /pipeline/i],
  ['el control de paridad', /paridad/i],
  // los cuatro archivos de los productos, uno por uno (un /pipeline/ no los cubre), por su nombre nuevo o por el viejo
  ['el archivo de deuda de vulnerabilidades', configPattern('pending-vulnerabilities.json')],
  ['el archivo de deuda de opciones', configPattern('pending-options.json')],
  ['el archivo de deuda de pruebas', configPattern('pending-tests.json')],
  // el de producción, por su nombre nuevo o por el viejo que da el mapa (nunca escrito acá: la copia no lleva nombres viejos)
  ['la configuración de producción del producto', productionConfigPattern()],
  ['la escritura doble del freno de producción', /escritura doble/i],
  ['los 14 días sin usos', /14 días/],
  ['los avisos ##vso', /##vso/],
  // con usos, lo que los tuvo queda con su propia fecha una semana después
  ['la fecha propia si hay usos', /una semana después/],
  ['la fecha retire_after', /retire_after/],
  ['la lista de la 8.12', /8\.12/],
];
function missingPieces(text) {
  return REQUIRED.filter(([, re]) => !re.test(text)).map(([what]) => what);
}

test('T58 Close_FollowupStoryAndRows — la story de retiro sigue a la 8.9 y a la 8.12 y trae lo del AC 54', { skip: NOT_MEASURED }, () => {
  const story = findRetirementStory(SPECS);
  assert.ok(story, 'hay una story con followup_of a la 8.9 y a la 8.12 (la de retiro)');
  assert.deepStrictEqual(missingPieces(story.text), [], `${story.file}: le falta lo que pide el AC 54 de la 8.9`);
  const id = (/^story:\s*"?([\d.]+)"?/m.exec(frontmatter(story.text)) || [])[1];
  assert.ok(id, `${story.file}: tiene su número de story`);
  for (const parent of ['story-8.9-nombres-en-ingles.md', 'story-8.12-cada-pieza-en-su-carpeta.md']) {
    const fm = frontmatter(fs.readFileSync(path.join(SPECS, parent), 'utf8'));
    assert.ok(listIds(fm, 'followed_up_by').includes(id), `${parent}: tiene el followed_up_by de vuelta a la ${id}`);
  }
  const epics = fs.readFileSync(path.join(SPECS, 'epics.md'), 'utf8');
  assert.ok(new RegExp(`^\\| ${id.replace('.', '\\.')} \\|`, 'm').test(epics), `epics.md tiene la fila de la ${id}`);
  const row89 = epics.split('\n').find((l) => l.startsWith('| 8.9 |')) || '';
  // la fila escribe los números en negrita con texto entre medio («**225** → **70** → **N** …)
  assert.match(row89, /\*\*225\*\*[^→]*→\s*\*\*70\*\*[^→]*→\s*\*\*\d+\*\*/,
    'la fila 8.9 de epics.md tiene los números del termómetro de antes y de ahora (225 → 70 → N)');
});

test('T58 Close_FollowupStoryAndRows — laboratorio: la comprobación sabe fallar', () => {
  const good = REQUIRED.map(([what]) => what).join(' ') +
    ' reemplazo alias lectura doble legacy-names.d pipeline paridad escritura doble 14 días ##vso una semana después retire_after 8.12' +
    ' .tycon/production.json pending-vulnerabilities.json pending-options.json pending-tests.json';
  assert.deepStrictEqual(missingPieces(good), [], 'con todo, no falta nada');
  assert.deepStrictEqual(missingPieces(good.replace(/##vso/g, '')), ['los avisos ##vso'], 'sin ##vso, lo nombra');
  const fm = 'story: "9.99"\nfollowup_of:\n  - id: "8.9"\n    type: "extension"\n  - id: "8.12"\nfollowup_reason: x\n';
  assert.deepStrictEqual(listIds(fm, 'followup_of'), ['8.9', '8.12'], 'lee los ids de la lista');
  assert.deepStrictEqual(listIds(fm, 'followed_up_by'), [], 'sin el bloque, ninguno');
});
