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
 * stable-data: no crea commits ni lee el reloj; «commit» es el del historial que lee con `git log` y `git show`.
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

/** Los reemplazos que hay en `guides/` (en cualquier subcarpeta), como rutas relativas a la raíz. */
function shimsInGuides(dir = path.join(ROOT, 'guides')) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...shimsInGuides(abs));
    else if (d.name.endsWith('.md') && L.isShim(fs.readFileSync(abs, 'utf8'))) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
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
  // y al revés: cada reemplazo de una guía tiene su entrada en el mapa (si se pierde una, su reemplazo queda huérfano)
  const enMapa = new Set(JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.kind === 'file').map((e) => e.old));
  const huerfanos = shimsInGuides().filter((rel) => !enMapa.has(rel));
  assert.deepStrictEqual(huerfanos, [], 'reemplazos de guías sin su entrada en el mapa');
});

function git(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  assert.ok(!r.error && r.status === 0, `git ${args.join(' ')} falló: ${(r.error && r.error.message) || r.stderr}`);
  return r.stdout;
}
/** Los renombres de la ruta nueva siguiendo su historial: { commit, from, to } por cada uno. Sin historial, []. */
function renamesOf(rel) {
  const out = [];
  let commit = null;
  for (const l of git(['log', '--follow', '-M', '--name-status', '--format=%H', '--', rel]).split('\n')) {
    if (/^[0-9a-f]{40}$/.test(l)) commit = l;
    const m = /^R\d+\t([^\t]+)\t([^\t]+)$/.exec(l);
    if (m) out.push({ commit, from: m[1], to: m[2] });
  }
  return out;
}
const NO_GIT = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status !== 0
  && 'NO MEDIDO — sin historial de git en la raíz';

test('T17 Contenido_IgualAlDeAntes @story-8.45 @ac-4 — el commit que mueve cada guía no cambia su texto, salvo los enlaces a otra guía movida', { skip: NOT_MEASURED || NO_GIT }, (t) => {
  const moved = movedGuides();
  // un enlace a otra guía movida puede cambiar en el mismo commit: se compara con los nombres nuevos llevados a los viejos
  const aViejo = (s) => moved.reduce((acc, e) => acc.split(path.posix.basename(e.new)).join(path.posix.basename(e.old)), s);
  const sinHistorial = [];
  for (const e of moved) {
    const hist = renamesOf(e.new);
    if (!hist.length) { sinHistorial.push(e.new); continue; }
    const move = hist.find((h) => h.from === e.old && h.to === e.new);
    assert.ok(move, `${e.new}: git encuentra el renombre desde ${e.old} (${JSON.stringify(hist)})`);
    const antes = git(['show', `${move.commit}^:${e.old}`]).split('\n');
    const despues = git(['show', `${move.commit}:${e.new}`]).split('\n');
    assert.strictEqual(despues.length, antes.length, `${e.new}: el commit que la movió no agregó ni sacó renglones`);
    const distintos = despues.map((l, i) => i).filter((i) => despues[i] !== antes[i] && aViejo(despues[i]) !== antes[i]);
    assert.deepStrictEqual(distintos.map((i) => i + 1), [], `${e.new}: renglones reescritos en el commit que la movió`);
  }
  // una guía sin historial en este árbol (un árbol armado parado en el otro repo) no se mide, y se dice; si ninguna
  // tiene historial, la prueba entera queda NO MEDIDA
  if (sinHistorial.length) t.skip(`NO MEDIDO para ${sinHistorial.join(', ')}: sin historial de renombres en este árbol`);
});
