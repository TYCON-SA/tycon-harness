'use strict';

/**
 * create-story-estimate.test.js — el paso de estimación de la skill que escribe historias y el campo viejo de la guía de
 * historias. La skill propone un valor desde las historias parecidas y la persona decide; el campo `estimated_days`
 * queda por compatibilidad y apunta al registro.
 *
 * Lo que no se puede perder: el paso va después de escribir la historia y antes del validador (escribir en la historia
 * después de validarla vencería la constancia; la estimación va al registro, no a la historia); nombra el buscador de
 * parecidas, las tres respuestas y la pregunta a quien aprueba cuando hay coordinadora; muestra el total de la épica o
 * el motivo por el que no compara; un comando que falla no frena la historia.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, 'skills', 'tycon-create-story', 'workflow.md');

test('T14 Skill_PasoDeEstimacion @story-2.75 @ac-11 @ac-13', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const paso5 = wf.slice(wf.indexOf('<step n="5"'), wf.indexOf('<step n="6"'));
  const paso6 = wf.slice(wf.indexOf('<step n="6"'));
  const iBorrador = paso5.indexOf('Status as "draft"');
  const iEstima = paso5.indexOf('similar-stories.js');
  assert.ok(iBorrador >= 0 && iEstima > iBorrador, `la estimación, después de escribir el borrador (${[iBorrador, iEstima]})`);
  assert.ok(paso6.indexOf('tycon-story-validator') >= 0, 'el validador sigue en el paso 6, después');
  assert.doesNotMatch(paso6, /similar-stories\.js|estimates\.js"? story/, 'nada de la estimación después del validador');
  const bloque = paso5.slice(iEstima - 400);
  assert.match(bloque, /estimates\.js"? story/);
  assert.match(bloque, /--proposed[\s\S]*--value[\s\S]*--base[\s\S]*--confirmed-by/);
  assert.match(bloque, /confirm/i);
  assert.match(bloque, /correct/i);
  assert.match(bloque, /skip/i);
  assert.match(bloque, /coordinator[\s\S]{0,120}whoever approves/i);
  assert.match(bloque, /estimates\.js"? report/);
  assert.match(bloque, /motivo/);
  assert.match(bloque, /hours_per_point/);
  assert.match(bloque, /exits? (with )?2 or 3/i);
  assert.match(bloque, /\.tycon\/estimates\.jsonl/, 'dice dónde queda: el registro, no la historia');
  // los valores van entre comillas simples, con la comilla interna escrita así: la línea de comandos no los corre
  assert.match(bloque, /single quotes/i);
  assert.ok(bloque.includes("`'\\''`"), 'nombra la forma de la comilla interna');
});

test('T16 StoryFormat_EstimatedDaysApunta @story-2.75 @ac-14', () => {
  const sf = fs.readFileSync(path.join(ROOT, 'story-format.md'), 'utf8');
  const fila = sf.split('\n').find((l) => l.startsWith('| `estimated_days`'));
  assert.ok(fila, 'la fila sigue');
  assert.match(fila, /compatibilidad/);
  assert.match(fila, /\.tycon\/estimates\.jsonl/);
  assert.match(fila, /guides\/estimates\.md/);
  for (const g of ['estimates.md', 'estimates.en.md']) assert.ok(fs.existsSync(path.join(ROOT, 'guides', g)), `guides/${g}`);
});
