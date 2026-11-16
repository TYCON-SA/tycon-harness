'use strict';

/**
 * guide-links.test.js — las guías movidas a su nombre en inglés no dejan nada roto.
 *
 * Una guía que se mueve deja un reemplazo de dos líneas en su ruta vieja, y su contenido no cambia en el commit que la
 * mueve. Lo que se puede romper sin que nadie lo vea:
 *   - T4: un reemplazo que apunta a una guía que no existe, o que no es el que genera `--write-shims` (quien abre la
 *     ruta vieja lee «movida a…» y no encuentra nada);
 *   - T17: una guía que se reescribió en el mismo commit que la movió (git deja de seguir su historial).
 *
 * Las rutas salen del mapa (`scripts/lib/renames.json`, las entradas de guías de esta mudanza), nunca escritas acá. La
 * copia pública no lleva el mapa: ahí la prueba dice NO MEDIDO, como `guides-moved.test.js`. Los reemplazos viven con el
 * mapa, así que T4 mide sobre el árbol armado (lo privado con el público encima). T17 necesita además el historial de
 * git de la guía: se corre en la copia pública pasándole el mapa del privado con TYCON_LEGACY_NAMES_MAP.
 *
 * Correr: node --test scripts/tests/guide-links.test.js
 *         TYCON_LEGACY_NAMES_MAP=<privado>/scripts/lib/renames.json node --test scripts/tests/guide-links.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP = process.env.TYCON_LEGACY_NAMES_MAP || path.join(ROOT, 'scripts', 'lib', 'renames.json');
const NOT_MEASURED = !fs.existsSync(MAP) && 'NO MEDIDO — copia pública sin el mapa (TYCON_LEGACY_NAMES_MAP lo pasa)';
const SHIMS_ELSEWHERE = !NOT_MEASURED && !fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'renames.json'))
  && 'NO MEDIDO — el mapa vino de afuera y los reemplazos viven con él: corre sobre el árbol armado';
const L = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));

/** Las guías movidas a su nombre en inglés: entradas de archivo de `guides/` con su batch. Con el mapa y sin ninguna, falla. */
function movedGuides() {
  const all = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries
    .filter((e) => e && e.kind === 'file' && /^8\.45\b/.test(String(e.batch || '')) && /^guides\/.+\.md$/.test(e.old));
  assert.ok(all.length > 0, 'el mapa no tiene guías movidas a su nombre en inglés');
  return all;
}

test('T4 Reemplazos_ApuntanALaNueva @story-8.45 @ac-5 — cada ruta vieja es el reemplazo generado y lleva a la guía nueva', { skip: NOT_MEASURED || SHIMS_ELSEWHERE }, () => {
  for (const e of movedGuides()) {
    const oldAbs = path.join(ROOT, e.old);
    const newAbs = path.join(ROOT, e.new);
    assert.ok(fs.existsSync(newAbs), `${e.new}: la guía nueva existe`);
    assert.ok(!L.isShim(fs.readFileSync(newAbs, 'utf8')), `${e.new}: es la guía, no un reemplazo`);
    assert.ok(fs.existsSync(oldAbs), `${e.old}: la ruta vieja deja su reemplazo`);
    const text = fs.readFileSync(oldAbs, 'utf8');
    assert.ok(L.isGeneratedShim(e.old, text), `${e.old}: es el reemplazo que escribe --write-shims, no uno a mano`);
    assert.strictEqual(text.replace(/\n$/, '').split('\n').length, 2, `${e.old}: dos líneas`);
    assert.strictEqual(L.shimTarget(oldAbs), newAbs, `${e.old}: la marca lleva a ${e.new}`);
    const link = /\]\(([^)]+)\)/.exec(text);
    assert.ok(link, `${e.old}: trae un enlace`);
    assert.strictEqual(path.resolve(path.dirname(oldAbs), link[1]), newAbs, `${e.old}: el enlace relativo resuelve a ${e.new}`);
  }
});

/** El historial de la ruta nueva siguiendo renombres: `R<similitud>\t<viejo>\t<nuevo>` por cada renombre. */
function renamesOf(rel) {
  const r = spawnSync('git', ['-C', ROOT, 'log', '--follow', '-M', '--name-status', '--format=', '--', rel], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((l) => /^R(\d+)\t([^\t]+)\t([^\t]+)$/.exec(l)).filter(Boolean)
    .map((m) => ({ sim: Number(m[1]), from: m[2], to: m[3] }));
}
const NO_GIT = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status !== 0
  && 'NO MEDIDO — sin historial de git en la raíz';

test('T17 Contenido_IgualAlDeAntes @story-8.45 @ac-4 — git sigue cada guía movida desde su nombre viejo, sin reescribirla', { skip: NOT_MEASURED || NO_GIT }, (t) => {
  const sinHistorial = [];
  for (const e of movedGuides()) {
    const hist = renamesOf(e.new);
    if (hist === null || !hist.length) { sinHistorial.push(e.new); continue; }
    const move = hist.find((h) => h.from === e.old && h.to === e.new);
    assert.ok(move, `${e.new}: git encuentra el renombre desde ${e.old} (${JSON.stringify(hist)})`);
    assert.ok(move.sim >= 90, `${e.new}: el commit que la movió no la reescribió (similitud ${move.sim} %)`);
  }
  // una guía sin historial en este árbol (un árbol armado parado en el otro repo) no se mide, y se dice
  if (sinHistorial.length) t.skip(`NO MEDIDO para ${sinHistorial.join(', ')}: sin historial de renombres en este árbol`);
});
