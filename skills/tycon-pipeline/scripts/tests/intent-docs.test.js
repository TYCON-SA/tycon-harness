#!/usr/bin/env node
/**
 * intent-docs.test.js — lo que dicen las guías de la intención coincide con lo que lee el código.
 *
 * La guía de historias explica la intención (qué lleva, cuándo se aprueba y se congela, cómo se marca lo que falta) y
 * escribe los vocabularios cerrados de sus dos tablas. Si la guía y `lib/intent.js` dicen cosas distintas, quien
 * escribe una intención siguiendo la guía choca con el control sin entender por qué.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/intent-docs.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const intent = require(path.join(SCRIPTS, 'lib', 'intent.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Los valores entre comillas invertidas del renglón de la tabla de vocabularios cuya primera celda nombra `columna`. */
function vocabularyRow(text, columna) {
  const row = text.split('\n').find((l) => l.startsWith(`| ${columna} |`));
  assert.ok(row, `la guía no trae el renglón de vocabulario «${columna}»`);
  const cell = row.split('|')[2];
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

test('T15 Docs_IntentFormat_VocabulariesMatch @story-8.258 @ac-9', () => {
  const guia = read('story-format.md');
  assert.ok(/\n## La intención\n/.test(guia), 'story-format.md no trae la sección «La intención»');
  assert.ok(!guia.includes('La story ES el intent'), 'story-format.md sigue diciendo «La story ES el intent»');
  assert.ok(!/No se crean archivos `intent-\*\.md`/.test(guia), 'story-format.md sigue diciendo que no se crean intenciones');
  const apertura = guia.split('\n').slice(0, 6).join('\n');
  assert.ok(!/sin preguntas/.test(apertura), 'la apertura sigue prometiendo historias «sin preguntas»');

  const v = intent.VOCABULARIES;
  assert.deepStrictEqual(vocabularyRow(guia, 'Bloquea'), v.bloquea);
  assert.deepStrictEqual(vocabularyRow(guia, 'Estado de una pregunta'), v.estadoPregunta);
  assert.deepStrictEqual(vocabularyRow(guia, 'Fuente de una pregunta'), v.fuentePregunta);
  assert.deepStrictEqual(vocabularyRow(guia, 'Estado de una decisión'), v.estadoReservada);
  assert.deepStrictEqual(vocabularyRow(guia, 'Fuente de una decisión'), v.fuenteReservada);

  const plantilla = read('skills/tycon-create-story/intent-template.md');
  const fm = plantilla.split('\n---')[0];
  for (const campo of ['id:', 'status:', 'objective:', 'outcomes:']) assert.ok(fm.includes(`\n${campo}`), `la plantilla no trae ${campo}`);
  for (const cabecera of [intent.QUESTION_COLUMNS, intent.RESERVED_COLUMNS]) {
    assert.ok(plantilla.includes(`| ${cabecera.join(' | ')} |`), `la plantilla no trae la cabecera ${cabecera.join(', ')}`);
  }
  assert.ok(/\n## Preguntas abiertas\n/.test(plantilla) && /\n## Decisiones reservadas\n/.test(plantilla), 'la plantilla no trae las dos secciones');
  assert.ok(/<!--[^]*Ninguna\.[^]*-->/.test(plantilla), 'la plantilla no trae el comentario que pide filas o «Ninguna.»');
});

test('Docs_IntentRules_AndSkillNotice @story-8.258 @ac-9', () => {
  const guia = read('story-format.md');
  const seccion = guia.slice(guia.indexOf('\n## La intención\n'), guia.indexOf('\n## ', guia.indexOf('\n## La intención\n') + 5));
  for (const [que, re] of [['cuándo se aprueba', /se aprueba/], ['que se congela', /congelada/], ['cómo se marca lo que falta', /\[falta: Q<n>\]/],
    ['por qué no es una segunda fuente de verdad', /segunda fuente de verdad/]]) {
    assert.match(seccion, re, `«La intención» no dice ${que}`);
  }
  const notice = read('skills/tycon-create-story/NOTICE.md');
  const [en, es] = notice.split('\n## Castellano\n');
  for (const [idioma, texto, palabra] of [['inglés', en, /intent/], ['castellano', es, /intención/]]) {
    assert.ok(texto.includes('`intent-template.md`'), `NOTICE.md (${idioma}) no nombra intent-template.md`);
    for (const f of ['`first-time.md`', '`scripts/story-without-bmad.js`']) {
      const fila = texto.split('\n').find((l) => l.startsWith(`| ${f} |`));
      assert.ok(fila && palabra.test(fila), `NOTICE.md (${idioma}): la fila de ${f} no dice lo nuevo`);
    }
  }
});
