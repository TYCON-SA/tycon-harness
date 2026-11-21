'use strict';
/**
 * codex-typed-fixtures.test.js — los renglones medidos de una sesión de Codex, por cada forma en que le llega un mensaje
 * (tipeado por la persona, por la cola, por otro programa conectado al servidor, tipeado por un programa en una
 * pseudo-terminal), y su veredicto: si la conversación guardada distingue lo que tipeó la persona.
 * Los datos de prueba no traen nada real (ni rutas de la máquina, ni ids, ni el texto original), y el veredicto se lee
 * con falla cerrada (scripts/lib/codex-typed-verdict.js): sin él, ilegible o incompleto, no distingue. Sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readVerdict, CASES, FIXED_TEXT, TOY_IDS } = require('../lib/codex-typed-verdict.js');

const DIR = path.join(__dirname, 'fixtures', 'codex-typed');
const GUIDE = path.join(__dirname, '..', '..', 'guides', 'firmas-del-arnes.md');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const fixtureFiles = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
const lines = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Los textos que la persona (o el programa) mandó, en los renglones de la conversación. */
function userTexts(rows) {
  const out = [];
  for (const r of rows) {
    const p = r.payload || {};
    if (r.type === 'response_item' && p.role === 'user') {
      for (const c of p.content || []) {
        if (c.type === 'input_text' && !/^<environment_context>/.test(c.text)) out.push(c.text);
      }
    }
    if (r.type === 'event_msg' && p.type === 'user_message') out.push(p.message);
  }
  return out;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-typed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CodexTypedFixtures_FourCases_Parse', () => {
  const verdict = readVerdict(DIR);
  const files = fixtureFiles();
  assert.deepStrictEqual(files.map((f) => f[0]).sort(), [...CASES].sort(), 'un archivo por caso: a, b, c y d');
  for (const f of files) {
    const m = f.match(/^([abcd])-[a-z-]+-(\d+\.\d+\.\d+)\.jsonl$/);
    assert.ok(m, `${f}: el nombre lleva el caso y la versión de Codex`);
    assert.strictEqual(m[2], verdict.version, `${f}: la versión del nombre es la del veredicto`);
    const rows = lines(f);
    assert.ok(rows.length > 0, `${f}: tiene renglones`);
    if (rows.length === 1 && rows[0].no_ejecutado !== undefined) {
      assert.ok(String(rows[0].no_ejecutado).trim(), `${f}: un caso no ejecutado dice por qué`);
      continue;
    }
    assert.ok(rows.some((r) => r.type === 'session_meta'), `${f}: trae la cabecera de la sesión`);
    assert.ok(userTexts(rows).length > 0, `${f}: trae el mensaje del caso`);
  }
});

test('CodexTypedFixtures_NoRealData', () => {
  for (const f of fixtureFiles()) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const p of ['/Users/', '/home/', 'C:\\', '/private/', '/var/folders/']) {
      assert.ok(!raw.includes(p), `${f}: sin rutas de la máquina (${p})`);
    }
    for (const id of raw.match(UUID) || []) {
      assert.ok(TOY_IDS.includes(id.toLowerCase()), `${f}: ${id} no es un id de juguete`);
    }
    const rows = lines(f);
    if (rows.length === 1 && rows[0].no_ejecutado !== undefined) continue;
    for (const text of userTexts(rows)) assert.strictEqual(text, FIXED_TEXT, `${f}: el texto es la marca inventada`);
    for (const r of rows) {
      if (r.type !== 'session_meta') continue;
      for (const k of ['creator_user_id', 'creator_account_id']) {
        if (r.payload[k] !== undefined) assert.ok(/^toy-/.test(r.payload[k]) || TOY_IDS.includes(r.payload[k]), `${f}: ${k} es de juguete`);
      }
    }
  }
});

test('CodexTypedVerdict_ShapeAndFailClosed', (t) => {
  const good = readVerdict(DIR);
  assert.match(good.version, /^\d+\.\d+\.\d+$/);
  assert.match(good.fecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(typeof good.distingue, 'boolean');
  for (const c of CASES) assert.ok(good.datos[c], `el veredicto trae el dato del caso ${c}`);

  const write = (obj) => { const d = tempDir(t); fs.writeFileSync(path.join(d, 'verdict.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); return d; };
  const yes = { version: '9.9.9', fecha: '2026-01-01', distingue: true, datos: {
    a: { dato: 'campo', valor: 'x', corridas: 2 }, b: { dato: 'campo', valor: 'y' }, c: { dato: 'campo', valor: 'z' }, d: { dato: 'campo', valor: 'w' } } };
  assert.strictEqual(readVerdict(write(yes)).distingue, true, 'el bien formado con «sí» vale');

  const missing = JSON.parse(JSON.stringify(yes)); delete missing.datos.c;
  const r1 = readVerdict(write(missing));
  assert.strictEqual(r1.distingue, false, '«sí» sin el dato de un caso se lee como «no»');
  assert.match(r1.motivo, /c/);

  const skipped = JSON.parse(JSON.stringify(yes)); skipped.datos.d = { no_ejecutado: 'el gancho no se disparó' };
  const r2 = readVerdict(write(skipped));
  assert.strictEqual(r2.distingue, false, '«sí» con un caso no ejecutado se lee como «no»');
  assert.match(r2.motivo, /no ejecutado/);

  const once = JSON.parse(JSON.stringify(yes)); once.datos.a.corridas = 1;
  assert.strictEqual(readVerdict(write(once)).distingue, false, '«sí» con la persona medida una sola vez se lee como «no»');

  for (const empty of [null, '', '   ']) {
    const noValue = JSON.parse(JSON.stringify(yes)); noValue.datos.b.valor = empty;
    const r = readVerdict(write(noValue));
    assert.strictEqual(r.distingue, false, `«sí» con el valor de un caso ${JSON.stringify(empty)} se lee como «no»`);
    assert.match(r.motivo, /b/);
  }

  for (const [bad, why] of [[[1, 2], 'no es un objeto'], [{ ...yes, version: 'v1' }, 'versión mal escrita'], [{ ...yes, distingue: 'sí' }, '«distingue» no es booleano'], [{ ...yes, distingue: false }, 'dice que no distingue']]) {
    const r = readVerdict(write(bad));
    assert.strictEqual(r.distingue, false, `${why}: se lee como «no»`);
    assert.ok(r.motivo, `${why}: dice por qué`);
  }

  const r3 = readVerdict(write('{ esto no es json'));
  assert.strictEqual(r3.distingue, false, 'ilegible se lee como «no»');
  assert.match(r3.motivo, /JSON|position|token/i, 'ilegible: el motivo trae el error de lectura');

  const r4 = readVerdict(tempDir(t));
  assert.strictEqual(r4.distingue, false, 'sin verdict.json se lee como «no»');
  assert.ok(r4.motivo);
});

test('Docs_FirmasEnCodex_HasMeasurement', () => {
  const verdict = readVerdict(DIR);
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const start = guide.indexOf('### En Codex');
  assert.ok(start >= 0, 'la guía tiene la sección «En Codex»');
  const next = guide.indexOf('\n### ', start + 1);
  const section = guide.slice(start, next < 0 ? undefined : next);
  assert.ok(section.includes(verdict.fecha), 'la sección trae la fecha de la medición');
  assert.ok(section.includes(verdict.version), 'la sección trae la versión medida');
  assert.ok(section.includes(verdict.distingue ? 'distingue: sí' : 'distingue: no'), 'la sección trae el veredicto');
});
