'use strict';
/**
 * one-minute.test.js — la página de un minuto: qué es el arnés, los tres pasos del primer día y las palabras que usa.
 *
 * POR QUÉ. Quien llega al arnés tiene que entenderlo en un minuto y arrancar el primer día sin ayuda. La portada es
 * larga; esta página es lo primero que enlaza, y el instalador termina señalándola.
 *
 *   T1 OneMinute_BothLanguages_Short      las dos páginas existen y se leen en un minuto (≤ 45 renglones)
 *   T2 OneMinute_ThreeSteps               los tres pasos con las frases que el agente reconoce, en ese orden
 *   T3 OneMinute_Glossary                 las palabras del arnés, cada una con su definición, iguales en los dos idiomas
 *   T4 OneMinute_CoversLinkIt             las dos portadas la enlazan antes de su primera sección
 *   T5 OneMinute_NeverWithoutYou          dice lo que el agente nunca hace sin la persona
 *
 * Correr: node --test scripts/tests/one-minute.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const ES = 'getting-started/one-minute.es.md';
const EN = 'getting-started/one-minute.md';
// la tabla de palabras: un renglón `| **palabra** | definición |` por palabra
const words = (text) => [...text.matchAll(/^\|\s*\*\*([^*]+)\*\*\s*\|\s*([^|]+?)\s*\|\s*$/gm)].map((m) => ({ word: m[1], def: m[2] }));

test('T1 OneMinute_BothLanguages_Short: las dos páginas existen y se leen en un minuto', () => {
  for (const f of [ES, EN]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} existe`);
    const lines = read(f).trimEnd().split('\n').length;
    assert.ok(lines <= 45, `${f}: ${lines} renglones; un minuto son 45 como mucho`);
  }
});

test('T2 OneMinute_ThreeSteps: los tres pasos, en orden, con las frases que el agente reconoce', () => {
  const es = read(ES);
  const install = es.indexOf('npx @tyconsa/harness@latest');
  const story = es.indexOf('«creá una historia para');
  const run = es.indexOf('«implementemos la story»');
  assert.ok(install > 0 && story > install && run > story, `instalar → pedir la historia → implementarla (${install}, ${story}, ${run})`);
  const en = read(EN);
  const a = en.indexOf('npx @tyconsa/harness@latest');
  const b = en.indexOf('"create a story to');
  const c = en.indexOf('"implementemos la story"');
  assert.ok(a > 0 && b > a && c > b, `the same three steps in English (${a}, ${b}, ${c})`);
  assert.match(en, /the agent recognizes it in Spanish/, 'el inglés dice por qué la frase va en castellano');
});

test('T3 OneMinute_Glossary: las palabras del arnés con su definición, las mismas en los dos idiomas', () => {
  const es = words(read(ES));
  const en = words(read(EN));
  assert.ok(es.length >= 6 && es.length <= 9, `entre 6 y 9 palabras: ${es.map((w) => w.word).join(', ')}`);
  assert.strictEqual(en.length, es.length, 'el mismo número de palabras en inglés');
  for (const w of ['historia', 'revisor', 'freno', 'ejecución', 'pedido']) assert.ok(es.some((x) => x.word === w), `«${w}» está`);
  for (const w of [...es, ...en]) assert.ok(w.def.length >= 15, `«${w.word}» tiene su definición`);
});

test('T4 OneMinute_CoversLinkIt: las dos portadas la enlazan antes de su primera sección', () => {
  for (const [cover, page] of [['README.es.md', 'getting-started/one-minute.es.md'], ['README.md', 'getting-started/one-minute.md']]) {
    const text = read(cover);
    const first = text.search(/^## /m);
    const link = text.indexOf(`](${page})`);
    assert.ok(link > 0 && link < first, `${cover} enlaza ${page} antes de su primera sección`);
  }
});

test('T5 OneMinute_NeverWithoutYou: dice lo que el agente nunca hace sin la persona', () => {
  assert.match(read(ES), /nunca commitea ni sube cambios sin tu permiso/);
  assert.match(read(EN), /never commits or pushes without your permission/);
});
