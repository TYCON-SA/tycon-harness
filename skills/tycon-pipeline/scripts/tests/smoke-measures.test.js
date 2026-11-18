#!/usr/bin/env node
'use strict';
// smoke-measures.test.js — la marca de cota en el criterio y la comparación de una medida contra ella
// (lib/smoke-measures.js): las dos formas de la marca, los operadores, las unidades y la duración del reloj.
//
//   T7  Measures_ParseMark_OpsUnitsAliases
//   T8  Measures_Compare_TimeConversion_UnitMismatch
//   y la lectura de los renglones TYCON_MEASURE de una salida (la usan smoke-run.sh y T1-T6 de smoke-measure.test.sh)
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/smoke-measures.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const M = require(path.join(__dirname, '..', 'lib', 'smoke-measures.js'));

test('Measures_ParseMark_OpsUnitsAliases @story-8.260 @ac-10 @ac-11 @ac-12', () => {
  const a = M.marcas('responde @measure(duration < 2s) siempre');
  assert.deepStrictEqual(a.marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]), [['duration', '<', 2, 's']]);
  assert.deepStrictEqual(a.ilegibles, []);
  // las dos formas dan lo mismo
  const b = M.marcas('@mide(duracion<=150ms)');
  assert.deepStrictEqual(b.marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]), [['duration', '<=', 150, 'ms']]);
  assert.deepStrictEqual(M.marcas('@mide(duracion < 2s)').marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]),
    M.marcas('@measure(duration < 2s)').marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]));
  // tamaño con unidad; cuenta sin unidad
  assert.deepStrictEqual(M.marcas('@measure(size >= 1MB)').marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]), [['size', '>=', 1, 'MB']]);
  assert.deepStrictEqual(M.marcas('@measure(errors <= 0)').marcas.map((m) => [m.nombre, m.op, m.valor, m.unidad]), [['errors', '<=', 0, null]]);
  // ilegibles: operador desconocido, `==`, nombre en mayúscula, sin número
  for (const t of ['@measure(p95 ~ 2)', '@measure(p95 == 2ms)', '@measure(P95 < 2ms)', '@measure(p95 < ms)']) {
    const r = M.marcas(t);
    assert.strictEqual(r.marcas.length, 0, t);
    assert.deepStrictEqual(r.ilegibles, [t], t);
  }
  // citadas como ejemplo: entre acentos graves, en un bloque y en una cita, no son marcas
  const citadas = ['se escribe `@measure(duration < 2s)` así', '```', '@measure(duration < 2s)', '```', '> @measure(duration < 2s)'].join('\n');
  assert.deepStrictEqual(M.marcas(citadas), { marcas: [], ilegibles: [] });
});

test('Measures_RawAcText_GherkinOwnBlockOnly @story-8.260 @ac-11', () => {
  const sc = require(path.join(__dirname, '..', 'lib', 'story-checks.js'));
  const largo = 'x'.repeat(700);
  // lista numerada: el texto entero, sin el corte de 600 ni la limpieza que borra los acentos graves
  const numerada = ['# S', '', '## Acceptance Criteria', '',
    `1. **Given** algo ${largo} @measure(duration < 2s)`, '   se cita `@measure(p95 < 1ms)` como ejemplo', '> @measure(p95 < 1ms)',
    '2. **Given** otro, **Then** nada.', ''].join('\n');
  const n = sc.acTextsFromSpec(numerada, { crudo: true });
  assert.deepStrictEqual(M.marcas(n[1]).marcas.map((m) => m.texto), ['@measure(duration < 2s)']);
  assert.match(n[1], /`@measure\(p95 < 1ms\)`/);
  // Gherkin: la marca dentro del bloque del criterio cuenta; la de un bloque de ejemplo ajeno, no
  const gherkin = ['# S', '', '## Acceptance Criteria', '', '```gherkin',
    'Given una consulta', 'When responde', 'Then tarda poco @measure(duration < 2s)', '```', '',
    'Un ejemplo de cómo NO escribirla:', '', '```', '@measure(p95 < 1ms)', '```', '',
    '```gherkin', 'Given otra cosa', 'Then otra', '```', ''].join('\n');
  const g = sc.acTextsFromSpec(gherkin, { crudo: true });
  assert.deepStrictEqual(M.marcas(g[1]).marcas.map((m) => m.texto), ['@measure(duration < 2s)']);
  assert.deepStrictEqual(M.marcas(g[2] || '').marcas, []);
  // sin `crudo`, lo de siempre: el texto limpio y cortado
  assert.ok(sc.acTextsFromSpec(numerada)[1].length <= 600);
});

test('Measures_Compare_TimeConversion_UnitMismatch @story-8.260 @ac-1 @ac-10', () => {
  const marca = (t) => M.marcas(t).marcas[0];
  assert.strictEqual(M.comparar({ value: 1500, unit: 'ms' }, marca('@measure(duration < 2s)')).cumple, true);
  assert.strictEqual(M.comparar({ value: 3010, unit: 'ms' }, marca('@measure(duration < 2s)')).cumple, false);
  assert.strictEqual(M.comparar({ value: 2, unit: 'min' }, marca('@measure(t <= 120s)')).cumple, true);
  const kb = M.comparar({ value: 900, unit: 'KB' }, marca('@measure(size <= 1MB)'));
  assert.strictEqual(kb.cumple, undefined);
  assert.strictEqual(kb.sinMedicion, 'unidad distinta (medido en KB, la cota en MB)');
  assert.strictEqual(M.comparar({ value: 0, unit: null }, marca('@measure(errors <= 0)')).cumple, true);
  assert.match(M.comparar({ value: 0, unit: null }, marca('@measure(errors <= 0ms)')).sinMedicion, /^unidad distinta/);
  // los textos: tiempo en ms, lo demás como vino
  assert.strictEqual(M.textoCota(marca('@measure(duration < 2s)')), '< 2000 ms');
  assert.strictEqual(M.textoMedido({ value: 3010, unit: 'ms' }), '3010 ms');
  assert.strictEqual(M.textoCota(marca('@measure(errors <= 0)')), '<= 0');
  // la duración: un reloj que retrocede o una lectura que no es entera no dan un número
  assert.deepStrictEqual(M.duracion('1000', '4010'), { ms: 3010 });
  const atras = M.duracion(5000, 4000);
  assert.strictEqual(atras.ms, null);
  assert.match(atras.error, /retroced/);
  const rara = M.duracion('1000.5', '2000');
  assert.strictEqual(rara.ms, null);
  assert.match(rara.error, /entero/);
});

test('Measures_ReadLines_LastWins_TopAndRejected @story-8.260 @ac-4 @ac-5', () => {
  const r = M.leerRenglones(['hola', 'TYCON_MEASURE p95=180ms', 'TYCON_MEASURE p95=175 ms', 'TYCON_MEASURE errors=0',
    'TYCON_MEASURE p95 180', 'TYCON_MEASURE duration=1s', 'TYCON_MEASURE rate=-1.5req/s\r'].join('\n'));
  assert.deepStrictEqual(r.measures, [{ name: 'p95', value: 175, unit: 'ms' }, { name: 'errors', value: 0, unit: null },
    { name: 'rate', value: -1.5, unit: 'req/s' }]);
  assert.deepStrictEqual(r.rejected, [5, 6]);
  assert.strictEqual(r.dropped, 0);
  const muchos = Array.from({ length: 22 }, (_, i) => `TYCON_MEASURE m${i}=1`).join('\n');
  const t = M.leerRenglones(muchos);
  assert.strictEqual(t.measures.length, 20);
  assert.strictEqual(t.dropped, 2);
  assert.strictEqual(t.measures[19].name, 'm19');
});

test('Measures_RawAcText_SubItemsHeadingsScenarios @story-8.260 @ac-11', () => {
  const sc = require(path.join(__dirname, '..', 'lib', 'story-checks.js'));
  const crudo = (cuerpo) => sc.acTextsFromSpec(['# S', '', '## Acceptance Criteria', '', ...cuerpo, ''].join('\n'), { crudo: true });
  const de = (t) => M.marcas(t || '').marcas.map((m) => m.texto);
  const MARCA = '@measure(duration < 2s)';
  // sub-items numerados con sangría: son del criterio que los abre, y el siguiente no se lleva su marca
  const a = crudo(['1. **Given** la consulta:', '   1. pide', `   2. responde ${MARCA}`, '2. **Then** otro']);
  assert.deepStrictEqual([de(a[1]), de(a[2])], [[MARCA], []]);
  // una lista y un subtítulo más profundo dentro de `### AC-N`
  const b = crudo(['### AC-1 — rápido', '1. pide', `2. responde ${MARCA}`, '### AC-2 — otro', '1. nada']);
  assert.deepStrictEqual([de(b[1]), de(b[2])], [[MARCA], []]);
  const c = crudo(['### AC-1 — rápido', 'texto', '#### Detalle', MARCA, '### AC-2 — otro', 'nada']);
  assert.deepStrictEqual([de(c[1]), de(c[2])], [[MARCA], []]);
  // «Dado» dentro de un bloque: el bloque es del criterio
  const d = crudo(['```gherkin', 'Dado la consulta', 'Cuando se pide', `Entonces responde ${MARCA}`, '```']);
  assert.deepStrictEqual(de(d[1]), [MARCA]);
  // la etiqueta sobre el escenario y el título son del escenario que abren, no del anterior
  const e = crudo(['```gherkin', 'Scenario: uno', 'Given a', 'Then b', MARCA, 'Scenario: dos', 'Given c', 'Then d', '```']);
  assert.deepStrictEqual([de(e[1]), de(e[2])], [[], [MARCA]]);
  const f = crudo(['```gherkin', MARCA, 'Scenario: uno', 'Given a', 'Then b', `Scenario: dos ${MARCA}`, 'Given c', '```']);
  assert.deepStrictEqual([de(f[1]), de(f[2])], [[MARCA], [MARCA]]);
  // una marca suelta al final del último escenario sigue siendo suya
  const g = crudo(['```gherkin', 'Scenario: uno', 'Given a', 'Then b', MARCA, '```']);
  assert.deepStrictEqual(de(g[1]), [MARCA]);
});

test('Measures_NearMissMarks_Unreadable @story-8.260 @ac-11', () => {
  for (const t of ['@Measure(duration < 2s)', '@measure (duration < 2s)', '@measure(duration < 2s', '@mide(duracion < 2s']) {
    const r = M.marcas(`responde rápido ${t}`);
    assert.strictEqual(r.marcas.length, 0, t);
    assert.strictEqual(r.ilegibles.length, 1, t);
  }
  assert.strictEqual(M.marcas('@measure duration < 2s').ilegibles.length, 1);
  for (const t of ['@measured el tiempo', 'una cuenta ana@measure','usa @measure/paquete', 'lo marca @mide en la guía']) {
    assert.deepStrictEqual(M.marcas(t), { marcas: [], ilegibles: [] }, t);
  }
  // partida en dos renglones sigue siendo la marca
  assert.strictEqual(M.marcas('responde @measure(duration\n  < 2s) siempre').marcas.length, 1);
});

test('Measures_Citations_DoubleBacktickTildeWrapped @story-8.260 @ac-11', () => {
  for (const t of ['se escribe ``@measure(duration < 2s)`` así', 'se escribe `la marca\n@measure(duration < 2s)` así',
    '~~~\n@measure(duration < 2s)\n~~~']) {
    assert.deepStrictEqual(M.marcas(t), { marcas: [], ilegibles: [] }, t);
  }
  // un acento grave suelto no se come el resto del criterio
  assert.strictEqual(M.marcas('un ` suelto\n\n@measure(duration < 2s)').marcas.length, 1);
});

test('Measures_TimeConversion_NoFloatDrift @story-8.260 @ac-10', () => {
  const marca = (t) => M.marcas(t).marcas[0];
  assert.strictEqual(M.comparar({ value: 2010, unit: 'ms' }, marca('@measure(t < 2.01s)')).cumple, false);
  assert.strictEqual(M.comparar({ value: 2010, unit: 'ms' }, marca('@measure(t >= 2.01s)')).cumple, true);
  assert.strictEqual(M.textoCota(marca('@measure(t < 2.01s)')), '< 2010 ms');
  assert.strictEqual(M.textoMedido({ value: 2.01, unit: 's' }), '2010 ms');
});

test('Measures_LinePrefixAndPrototypeNames @story-8.260 @ac-5 @ac-10 @ac-12', () => {
  assert.deepStrictEqual(M.leerRenglones('TYCON_MEASUREx=1\n').rejected, [1]);
  assert.strictEqual(M.marcas('@measure(constructor < 2)').marcas[0].nombre, 'constructor');
  const m = M.marcas('@measure(t < 2constructor)').marcas[0];
  assert.strictEqual(M.comparar({ value: 1, unit: 'constructor' }, m).cumple, true);
  assert.strictEqual(M.textoMedido({ value: 1, unit: 'valueOf' }), '1 valueOf');
});
