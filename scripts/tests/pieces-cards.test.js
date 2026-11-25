'use strict';
/**
 * La guía de piezas se lee rápido: cada ficha dice en pocas líneas qué es la pieza, por qué existe, quién la usa y
 * dónde se prueba. Está partida: `guides/harness-pieces.md` es el índice (el árbol «Dónde vive cada cosa» y la lista
 * de las piezas de cada grupo) y las fichas viven en `guides/pieces/<grupo>.md`. El detalle de cada pieza vive en
 * `guides/maintaining/pieces-in-detail.md`, con el mismo título `## <ruta>`; los casos con fecha, en el registro de
 * incidentes de quien mantiene, que no se publica.
 *
 * Una ficha es todo lo que hay entre un `## <ruta>` de un archivo de grupo y el siguiente `## `. Queda fuera de las
 * medidas la ficha del sitio, que tiene su propia guía. El árbol del índice lo mide guides-moved.test.js.
 *
 * Cada archivo tiene su tope: el índice uno y cada grupo otro. Un grupo lleno no se agranda: la ficha nueva va a otro
 * grupo, o el grupo se parte en dos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INDEX, piecesFiles } = require('./lib/pieces-guide.js');

const ROOT = path.resolve(__dirname, '..', '..');
const GUIDE = path.join(ROOT, INDEX);
const DETAIL = path.join(ROOT, 'guides', 'maintaining', 'pieces-in-detail.md');
const CEILING = 800;
const INDEX_SIZE_CEILING = 30 * 1024;
const GROUP_SIZE_CEILING = 32 * 1024;
const PARTS = ['Qué es', 'Por qué existe', 'Quién la usa', 'Dónde se prueba'];
const DATED = /\b20\d\d-\d\d-\d\d\b/;

const isSite = (title) => title.startsWith('scripts/site/');

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
// los archivos de grupo, con la ruta corta con que los enlaza el índice (`pieces/<group>.md`)
const groups = () => piecesFiles(ROOT).filter((rel) => rel !== INDEX).map((rel) => ({ rel, link: rel.replace(/^guides\//, ''), text: read(path.join(ROOT, rel)) }));
// una guía vacía o mal partida no pasa en verde: las pruebas cuentan sobre las fichas que hay
const MIN_CARDS = 100;
const MIN_GROUPS = 2;
const cards = () => {
  const gs = groups();
  assert.ok(gs.length >= MIN_GROUPS, `la guía tiene ${gs.length} archivos de grupo en guides/pieces/; se esperaban al menos ${MIN_GROUPS}`);
  const out = gs.flatMap((g) => sections(g.text).map((s) => ({ ...s, file: g.rel }))).filter((s) => !isSite(s.title));
  assert.ok(out.length >= MIN_CARDS, `la guía tiene ${out.length} fichas; se esperaban al menos ${MIN_CARDS}`);
  return out;
};

// el tamaño de un archivo, sin la ficha del sitio
function sizeWithoutSite(text) {
  const site = sections(text).find((s) => isSite(s.title));
  return Buffer.byteLength(text, 'utf8') - (site ? Buffer.byteLength(site.body, 'utf8') : 0);
}

test('T1 Pieces_EveryCardHasTheFourParts', () => {
  const missing = [];
  for (const c of cards()) {
    const lacks = PARTS.filter((p) => !c.body.includes(`**${p}:**`));
    if (lacks.length) missing.push(`${c.file} · ${c.title}: le falta ${lacks.join(', ')}`);
  }
  assert.deepEqual(missing, [], `fichas sin las cuatro partes:\n${missing.join('\n')}`);
});

test('T2 Pieces_EveryCardUnderTheCeiling_SiteExcluded', () => {
  const over = cards().filter((c) => measured(c.body).length > CEILING).map((c) => `${c.file} · ${c.title}: ${measured(c.body).length} caracteres (tope ${CEILING})`);
  assert.deepEqual(over, [], `fichas más largas que el tope:\n${over.join('\n')}`);
});

test('T3 Pieces_AnchorsStillResolve', () => {
  const anchors = {
    'harness-pieces.md': new Set(sections(read(GUIDE)).map((s) => slug(s.title))),
    'pieces-in-detail.md': fs.existsSync(DETAIL) ? new Set(sections(read(DETAIL)).map((s) => slug(s.title))) : new Set(),
  };
  for (const g of groups()) anchors[g.link] = new Set(sections(g.text).map((s) => slug(s.title)));
  const broken = [];
  let checks = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        for (const m of read(p).matchAll(/\]\(([^)\s]*?(harness-pieces\.md|pieces-in-detail\.md|pieces\/[\w-]+\.md))#([^)\s]+)\)/g)) {
          checks++;
          const known = anchors[m[2]];
          if (!known || !known.has(decodeURIComponent(m[3]))) broken.push(`${path.relative(ROOT, p)} → ${m[2]}#${m[3]}`);
        }
      }
    }
  };
  walk(ROOT);
  assert.ok(fs.existsSync(DETAIL), 'falta guides/maintaining/pieces-in-detail.md');
  assert.ok(checks > 50, `se revisaron ${checks} enlaces a un ancla; se esperaban más de 50`);
  assert.deepEqual(broken, [], `enlaces a un ancla que no existe:\n${broken.join('\n')}`);
});

test('T4 Pieces_NoDatedCaseInThePublicGuide', () => {
  const dated = [];
  for (const s of sections(read(GUIDE))) if (DATED.test(s.body)) dated.push(`harness-pieces.md · ${s.title}: ${s.body.match(DATED)[0]}`);
  for (const c of cards()) if (DATED.test(c.body)) dated.push(`${c.file} · ${c.title}: ${c.body.match(DATED)[0]}`);
  if (fs.existsSync(DETAIL)) {
    for (const s of sections(read(DETAIL))) if (DATED.test(s.body)) dated.push(`pieces-in-detail.md · ${s.title}: ${s.body.match(DATED)[0]}`);
  }
  assert.deepEqual(dated, [], `casos con fecha en una guía pública (van al registro de incidentes de quien mantiene):\n${dated.join('\n')}`);
});

test('T5 Pieces_IndexAndEveryGroupUnderTheirCeiling', () => {
  const over = [];
  const index = Buffer.byteLength(read(GUIDE), 'utf8');
  if (index >= INDEX_SIZE_CEILING) over.push(`${INDEX}: ${index} bytes (tope ${INDEX_SIZE_CEILING})`);
  for (const g of groups()) {
    const size = sizeWithoutSite(g.text);
    if (size >= GROUP_SIZE_CEILING) over.push(`${g.rel}: ${size} bytes sin la ficha del sitio (tope ${GROUP_SIZE_CEILING}): la ficha nueva va a otro grupo, o este se parte en dos`);
  }
  assert.deepEqual(over, [], `archivos de la guía de piezas por encima de su tope:\n${over.join('\n')}`);
});

test('T5b Pieces_CeilingsMeasureTheirLaboratory', () => {
  // un grupo que se pasa da rojo, y la ficha del sitio no cuenta
  const card = (t, n) => `## ${t}\n\n${'x'.repeat(n)}\n`;
  assert.ok(sizeWithoutSite(card('scripts/uno.js', GROUP_SIZE_CEILING)) >= GROUP_SIZE_CEILING, 'un grupo lleno se mide entero');
  assert.ok(sizeWithoutSite(card('scripts/site/ — el sitio', GROUP_SIZE_CEILING)) < 100, 'la ficha del sitio no cuenta');
});

test('T11 Pieces_EveryCardHasItsDetailSection', () => {
  // cada ficha que manda al detalle tiene ahí su sección con el mismo título
  if (!fs.existsSync(DETAIL)) assert.fail('falta guides/maintaining/pieces-in-detail.md');
  const inDetail = new Set(sections(read(DETAIL)).map((s) => s.title));
  const orphan = cards().filter((c) => /^\*\*Detalle:\*\*/m.test(c.body) && !inDetail.has(c.title)).map((c) => c.title);
  assert.deepEqual(orphan, [], `fichas que mandan a un detalle que no existe:\n${orphan.join('\n')}`);
});

test('T10 Pieces_OpeningNoteSaysHowToRead', () => {
  // antes del primer `## ` del índice: cómo se lee una ficha (sus cuatro partes), dónde están los grupos y el detalle
  const text = read(GUIDE);
  const note = text.slice(0, text.search(/^## /m));
  for (const p of ['qué es', 'por qué existe', 'quién la usa', 'dónde se prueba']) assert.match(note.toLowerCase(), new RegExp(p), `la nota de apertura no dice «${p}»`);
  assert.match(note, /maintaining\/pieces-in-detail\.md/, 'la nota de apertura no manda a la guía de detalle');
  assert.match(note, /pieces\//, 'la nota de apertura no dice que las fichas están en guides/pieces/');
});

test('T21 GuiaDePiezas_NombraLaPruebaDeEnlaces @story-8.45 @ac-13 — la ficha de la guía de piezas nombra la prueba de enlaces y dice que las guías se nombran en inglés', () => {
  const ficha = cards().find((c) => c.title === INDEX);
  assert.ok(ficha, `no hay ficha de ${INDEX}`);
  assert.match(ficha.body, /scripts\/tests\/guide-links\.test\.js/, 'la ficha no nombra la prueba de enlaces');
  assert.match(ficha.body, /guías se nombran en inglés/, 'la ficha no dice que las guías se nombran en inglés');
});

test('T12 Pieces_IndexListsEveryCardOnce', () => {
  // cada ficha de un grupo está en el índice, con el enlace a su grupo; el índice no lista fichas que no existen.
  // El enlace lleva el ancla de la ficha; sin ancla (cuando el ancla pegada parece un nombre privado y el control de
  // nombres la frena), el texto del enlace es el título exacto de la ficha
  const index = read(GUIDE);
  const listed = [...index.matchAll(/^- \[([^\]]+)\]\((pieces\/[\w-]+\.md)(?:#([^)\s]+))?\)(?: _\(.*\)_)?$/gm)]
    .map((m) => `${m[2]}#${m[3] ? decodeURIComponent(m[3]) : slug(m[1])}`);
  const all = groups().flatMap((g) => sections(g.text).map((s) => `${g.link}#${slug(s.title)}`));
  const twice = listed.filter((x, i) => listed.indexOf(x) !== i);
  const missing = all.filter((x) => !listed.includes(x));
  const extra = listed.filter((x) => !all.includes(x));
  assert.ok(all.length >= MIN_CARDS, `los grupos tienen ${all.length} fichas; se esperaban al menos ${MIN_CARDS}`);
  assert.deepEqual({ missing, extra, twice }, { missing: [], extra: [], twice: [] }, 'el índice y las fichas de los grupos no coinciden');
  // una pieza tiene una sola ficha: el mismo título en dos grupos (o dos veces en uno) es una ficha de más
  const titles = groups().flatMap((g) => sections(g.text).map((s) => s.title));
  const repeated = [...new Set(titles.filter((x, i) => titles.indexOf(x) !== i))];
  assert.deepEqual(repeated, [], `fichas con el mismo título en más de un lugar:\n${repeated.join('\n')}`);
  // la línea de la ficha que nombra los archivos que la acompañan va también en el índice: se buscan por nombre
  for (const g of groups()) {
    for (const s of sections(g.text)) {
      const companions = s.body.split('\n').find((l) => /^_\(.*\)_\s*$/.test(l));
      if (companions) assert.ok(index.includes(`(${g.link}#${slug(s.title)}) ${companions.trim()}`), `el índice no nombra lo que acompaña a ${s.title}`);
    }
  }
  // cada grupo tiene su sección en el índice, que enlaza el archivo
  for (const g of groups()) assert.ok(index.includes(`](${g.link})`), `el índice no enlaza ${g.link}`);
});
