'use strict';
// office-tables.test.js — the tables of the office: «Hoy» and «Pendientes», drawn as text. The shared toys live in lib/office-fixtures.js.
// Through that library the cases run scripts/tools/office.js and skills/tycon-pipeline/scripts/marker.js: named
// here so the dependency reader of the validation follows them from this file, as it follows what a suite names.
// Nothing here reads the real HOME: the command-line tests run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const test = require('node:test');
const assert = require('node:assert');
const {
  NOW, KANBAN_FOR_TABLES, mixedOffice, wip, buildOffice, page, buildTables
} = require('./lib/office-fixtures.js');

test('T211 Tables_PageDrawsText: la página dibuja las tablas arriba del tablero, como texto', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  data.tablas = buildTables({ kanban: KANBAN_FOR_TABLES, nowMs: NOW });
  const html = page(data);
  assert.ok(html.indexOf('id="tablas"') < html.indexOf('id="board"'));
  const fn = (html.match(/function renderTablas\(\)\{[\s\S]*?\n?\}\)\}/) || [])[0];
  assert.ok(fn && !/innerHTML/.test(fn), 'como texto');
});

test('T225 Views_OnePerTime: «El trabajo» muestra Tablas o Kanban, una por vez, y recuerda la última', () => {
  const html = page(mixedOffice());
  assert.match(html, /<h2 id="trabajoTitle">El trabajo<\/h2>/);
  assert.match(html, /name="vista" value="tablas"/);
  assert.match(html, /name="vista" value="kanban"/);
  assert.match(html, /<div class="seg" role="radiogroup"/, 'un interruptor de dos posiciones');
  assert.match(html, /\.seg input:checked\+span\{background:var\(--accent\)/, 'la opción activa bien marcada, con los colores de cada tema');
  assert.match(html, /\.seg input:focus-visible\+span\{outline/, 'y el teclado se ve');
  assert.doesNotMatch(html, /\.seg input\{[^}]*display:none/, 'sin sacarle el teclado a los botones');
  assert.doesNotMatch(html, /id="boardTitle"/, 'la sección ya no se llama Pendientes');
  assert.match(html, /\[hidden\]\{display:none!important\}/, 'un display propio no le gana a hidden');
  // la lógica de la vista, fuera del navegador
  const code = (html.match(/const VISTA_KEY=[\s\S]*?(?=\/\/ los dos resúmenes)/) || [])[0];
  assert.ok(code, 'la página trae las vistas');
  const run = (store, DATA) => {
    const nodes = { tablas: { hidden: false }, board: { hidden: false }, trabajo: { hidden: false } };
    const radios = ['tablas', 'kanban'].map((value) => ({ value, checked: false, addEventListener(_, f) { this.f = f; } }));
    const document = { getElementById: (id) => nodes[id], querySelectorAll: () => radios };
    const api = new Function('document', 'localStorage', 'DATA', `${code};return { pintarVista };`)(document, store, DATA);
    api.pintarVista();
    return { nodes, radios };
  };
  const memory = (v) => ({ saved: v, getItem() { return this.saved; }, setItem(_, x) { this.saved = x; } });
  const both = { tablas: {}, kanban: {} };
  let r = run(memory(null), both);
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [false, true], 'de entrada, las tablas');
  const store = memory('kanban');
  r = run(store, both);
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [true, false], 'recuerda el kanban');
  r.radios[0].checked = true;
  r.radios[0].f();
  assert.strictEqual(store.saved, 'tablas', 'guarda la elegida');
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [false, true]);
  const broken = { getItem() { throw new Error('sin permiso'); }, setItem() { throw new Error('sin permiso'); } };
  r = run(broken, both);
  assert.strictEqual(r.nodes.tablas.hidden, false, 'sin dónde guardar, igual se ve');
  r.radios[1].checked = true;
  r.radios[1].f();
  assert.strictEqual(r.nodes.board.hidden, false, 'y se puede cambiar');
});

test('T226 PlainTable_OnlyWithout3D: «Ver como tabla» no se ve, salvo sin 3D; la nota de las horas va junto a las tarjetas', () => {
  const html = page(mixedOffice());
  assert.match(html, /<details class="tablewrap" id="tablewrap" hidden>/);
  assert.match(html, /function sinTresD\(msg\)\{[^\n]*t\.hidden=false;t\.open=true/);
  const crew = html.indexOf('id="crew"');
  const note = html.indexOf('«Prometido» es la hora');
  const work = html.indexOf('id="trabajo"');
  assert.ok(crew > 0 && crew < note && note < work, 'después de las tarjetas y antes del trabajo');
  assert.ok(html.indexOf('id="noRead"') < html.indexOf('id="tablewrap"'), 'lo que no se pudo leer se ve siempre');
});
