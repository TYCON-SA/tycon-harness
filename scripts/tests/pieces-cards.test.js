'use strict';
/**
 * La guía de piezas (`guides/piezas-del-arnes.md`) se lee rápido: cada ficha dice en pocas líneas qué es la pieza,
 * por qué existe, quién la usa y dónde se prueba. El detalle de cada pieza vive en
 * `guides/maintaining/piezas-en-detalle.md`, con el mismo título `## <ruta>`; los casos con fecha, en el registro de
 * incidentes de quien mantiene, que no se publica.
 *
 * Una ficha es todo lo que hay entre un `## <ruta>` y el siguiente `## `. Quedan fuera la sección «Dónde vive cada
 * cosa» (su árbol y sus reglas los mide guides-moved.test.js) y la ficha del sitio, que tiene su propia guía.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const GUIDE = path.join(ROOT, 'guides', 'piezas-del-arnes.md');
const DETAIL = path.join(ROOT, 'guides', 'maintaining', 'piezas-en-detalle.md');
const CEILING = 800;
const SIZE_CEILING = 120 * 1024;
const PARTS = ['Qué es', 'Por qué existe', 'Quién la usa', 'Dónde se prueba'];
const DATED = /\b20\d\d-\d\d-\d\d\b/;

const isExcluded = (title) => title === 'Dónde vive cada cosa' || title.startsWith('scripts/site/');

function sections(text) {
  const out = [];
  const rx = /^## (.+)$/gm;
  const marks = [...text.matchAll(rx)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out.push({ title: m[1].trim(), body: text.slice(m.index + m[0].length, end).trim() });
  });
  return out;
}

// el cuerpo que cuenta para el tope: sin la línea que manda al detalle
const measured = (body) => body.split('\n').filter((l) => !/^\*\*Detalle:\*\*/.test(l)).join('\n').trim();

// el ancla que arma la plataforma a partir de un título: minúsculas, sin puntuación salvo guiones, espacios a guiones
function slug(title) {
  return title.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

const read = (f) => fs.readFileSync(f, 'utf8');
// una guía vacía o mal partida no pasa en verde: las pruebas cuentan sobre las fichas que hay
const MIN_CARDS = 100;
const cards = () => {
  const out = sections(read(GUIDE)).filter((s) => !isExcluded(s.title));
  assert.ok(out.length >= MIN_CARDS, `la guía tiene ${out.length} fichas; se esperaban al menos ${MIN_CARDS}`);
  return out;
};

test('T1 Pieces_EveryCardHasTheFourParts', () => {
  const missing = [];
  for (const c of cards()) {
    const lacks = PARTS.filter((p) => !c.body.includes(`**${p}:**`));
    if (lacks.length) missing.push(`${c.title}: le falta ${lacks.join(', ')}`);
  }
  assert.deepEqual(missing, [], `fichas sin las cuatro partes:\n${missing.join('\n')}`);
});

test('T2 Pieces_EveryCardUnderTheCeiling_SiteExcluded', () => {
  const over = cards().filter((c) => measured(c.body).length > CEILING).map((c) => `${c.title}: ${measured(c.body).length} caracteres (tope ${CEILING})`);
  assert.deepEqual(over, [], `fichas más largas que el tope:\n${over.join('\n')}`);
});

test('T3 Pieces_AnchorsStillResolve', () => {
  const anchors = {
    'piezas-del-arnes.md': new Set(sections(read(GUIDE)).map((s) => slug(s.title))),
    'piezas-en-detalle.md': fs.existsSync(DETAIL) ? new Set(sections(read(DETAIL)).map((s) => slug(s.title))) : new Set(),
  };
  const broken = [];
  let checks = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        for (const m of read(p).matchAll(/\]\(([^)\s]*?(piezas-del-arnes\.md|piezas-en-detalle\.md))#([^)\s]+)\)/g)) {
          checks++;
          if (!anchors[m[2]].has(decodeURIComponent(m[3]))) broken.push(`${path.relative(ROOT, p)} → ${m[2]}#${m[3]}`);
        }
      }
    }
  };
  walk(ROOT);
  assert.ok(fs.existsSync(DETAIL), 'falta guides/maintaining/piezas-en-detalle.md');
  assert.ok(checks > 50, `se revisaron ${checks} enlaces a un ancla; se esperaban más de 50`);
  assert.deepEqual(broken, [], `enlaces a un ancla que no existe:\n${broken.join('\n')}`);
});

test('T4 Pieces_NoDatedCaseInThePublicGuide', () => {
  const dated = [];
  for (const c of cards()) if (DATED.test(c.body)) dated.push(`piezas-del-arnes.md · ${c.title}: ${c.body.match(DATED)[0]}`);
  if (fs.existsSync(DETAIL)) {
    for (const s of sections(read(DETAIL))) if (DATED.test(s.body)) dated.push(`piezas-en-detalle.md · ${s.title}: ${s.body.match(DATED)[0]}`);
  }
  assert.deepEqual(dated, [], `casos con fecha en una guía pública (van al registro de incidentes de quien mantiene):\n${dated.join('\n')}`);
});

test('T5 Pieces_SizeBelowAThird', () => {
  const text = read(GUIDE);
  const site = sections(text).find((s) => s.title.startsWith('scripts/site/'));
  const size = Buffer.byteLength(text, 'utf8') - (site ? Buffer.byteLength(site.body, 'utf8') : 0);
  assert.ok(size < SIZE_CEILING, `la guía pesa ${size} bytes sin la ficha del sitio (tope ${SIZE_CEILING})`);
});

test('T11 Pieces_EveryCardHasItsDetailSection', () => {
  // cada ficha que manda al detalle tiene ahí su sección con el mismo título
  if (!fs.existsSync(DETAIL)) assert.fail('falta guides/maintaining/piezas-en-detalle.md');
  const inDetail = new Set(sections(read(DETAIL)).map((s) => s.title));
  const orphan = cards().filter((c) => /^\*\*Detalle:\*\*/m.test(c.body) && !inDetail.has(c.title)).map((c) => c.title);
  assert.deepEqual(orphan, [], `fichas que mandan a un detalle que no existe:\n${orphan.join('\n')}`);
});

test('T10 Pieces_OpeningNoteSaysHowToRead', () => {
  // antes del primer `## `: cómo se lee una ficha (sus cuatro partes) y dónde está el detalle
  const text = read(GUIDE);
  const note = text.slice(0, text.search(/^## /m));
  for (const p of ['qué es', 'por qué existe', 'quién la usa', 'dónde se prueba']) assert.match(note.toLowerCase(), new RegExp(p), `la nota de apertura no dice «${p}»`);
  assert.match(note, /maintaining\/piezas-en-detalle\.md/, 'la nota de apertura no manda a la guía de detalle');
});
