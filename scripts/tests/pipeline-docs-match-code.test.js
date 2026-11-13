'use strict';
// pipeline-docs-match-code.test.js — las guías del pipeline dicen lo que el código hace.
//
// Lo que no se puede perder:
//   · el SKILL.md del pipeline y la guía de pruebas nombran las recetas del chequeo de mutantes y la fecha desde la que
//     frenan todas; la fecha se importa del código, nunca se copia: si alguien la mueve, las guías tienen que decir la
//     nueva;
//   · la plantilla de historia nace en borrador, y el freno de historia nueva la deja nacer en ese estado;
//   · sin poder leer la fecha, la prueba sale roja con el motivo: no da verde sin medir.
//
// Cubre sólo esas tres clases de afirmación: una frase nueva en otra guía sigue sin control.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const LIB = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { computeStorySkillGate } = require(path.join(LIB, 'story-skill-gate.js'));

/**
 * La fecha desde la que el chequeo de mutantes frena todas las recetas, leída del módulo que la define. Lanza «no
 * medido: …» si no puede importarlo o si el valor no es una fecha AAAA-MM-DD válida.
 */
function fechaDelAviso(modulo = path.join(LIB, 'mutation-gate.js')) {
  let m;
  try {
    m = require(modulo);
  } catch (e) {
    throw new Error(`no medido: no pude importar ${modulo} (${e.message})`, { cause: e });
  }
  const v = m && m.MUTATION_NOTICE_UNTIL;
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  const valida = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  if (!valida) throw new Error(`no medido: MUTATION_NOTICE_UNTIL de ${modulo} no es una fecha AAAA-MM-DD (es ${JSON.stringify(v)})`);
  return v;
}

/** El párrafo de una viñeta o sección: desde la línea que matchea `inicio` hasta antes de la que matchea `fin`. */
function tramo(texto, inicio, fin) {
  const lineas = texto.split('\n');
  const i = lineas.findIndex((l) => inicio.test(l));
  assert.ok(i >= 0, `no encontré ${inicio}`);
  let j = lineas.findIndex((l, k) => k > i && fin.test(l));
  if (j < 0) j = lineas.length;
  return lineas.slice(i, j).join('\n');
}

/**
 * Qué pasa a cada lado de la fecha, leído junto a ella: antes, «avisa … hasta (el)»; después, «frena» y «desde ese día».
 * Así una guía que diga la regla al revés no pasa por tener las palabras sueltas en otro lado.
 */
function ladosDeLaFecha(texto, fecha, donde) {
  const plano = texto.replace(/\s+/g, ' ');
  const i = plano.indexOf(fecha);
  assert.ok(i >= 0, `${donde} no nombra la fecha ${fecha}`);
  const antes = plano.slice(Math.max(0, i - 80), i);
  const despues = plano.slice(i + fecha.length, i + fecha.length + 120);
  assert.match(antes, /avisa[^.;]*hasta( el)? $/, `${donde}: antes de la fecha no dice que avisa hasta ese día`);
  assert.match(despues, /^[^.]*fren/, `${donde}: después de la fecha no dice que frena`);
  assert.match(despues, /desde ese día/, `${donde}: después de la fecha no dice «desde ese día»`);
}

const SOLO_NODE_TEST = /s[oó]lo\s+`?node --test/i;
const RECETAS = [/Jest/, /Vitest/, /\.NET/, /pytest/, /`node --test`/, /`?scoped`?/];

test('SkillMutantes_NombraLasRecetasYLaFecha (T1) @story-8.261 @ac-1 @ac-4', () => {
  const fecha = fechaDelAviso();
  const skill = leer('skills/tycon-pipeline/SKILL.md');
  const v = tramo(skill, /^- \*\*I\.ii — mutantes\*\*/, /^- \*\*/);
  for (const r of RECETAS) assert.match(v, r, `la viñeta de mutantes no nombra ${r}`);
  ladosDeLaFecha(v, fecha, 'la viñeta de mutantes');
  assert.match(v, /sobrevivientes/i);
  assert.doesNotMatch(skill, SOLO_NODE_TEST);
});

test('GuiaDePruebas_NombraLaFechaDelChequeo (T2) @story-8.261 @ac-2 @ac-4', () => {
  const fecha = fechaDelAviso();
  const guia = leer('guides/test-execution-discipline.md');
  const s = tramo(guia, /^## El chequeo de mutantes/, /^## /);
  ladosDeLaFecha(s, fecha, 'la sección del chequeo de mutantes');
  assert.doesNotMatch(guia, SOLO_NODE_TEST);
});

/** El valor de `status:` del frontmatter de la plantilla. */
function estadoDeLaPlantilla(texto) {
  const fm = texto.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'la plantilla no tiene frontmatter');
  const m = fm[1].match(/^status:\s*(\S+)/m);
  assert.ok(m, 'el frontmatter de la plantilla no tiene status:');
  return m[1];
}

test('Plantilla_NaceEnBorrador (T3) @story-8.261 @ac-3 @ac-4', () => {
  const t = leer('skills/tycon-create-story/template.md');
  assert.strictEqual(estadoDeLaPlantilla(t), 'draft');
  assert.match(t, /^Status: draft$/m);
  assert.doesNotMatch(t, /^Status: ready-for-dev$/m);
  const comentario = (t.match(/<!--[\s\S]*?-->/) || [''])[0];
  assert.match(comentario, /ready-for-dev/);
  assert.match(comentario, /paso 6/);
});

test('Plantilla_ElFrenoLaDejaNacer (T4) @story-8.261 @ac-4', () => {
  const estado = estadoDeLaPlantilla(leer('skills/tycon-create-story/template.md'));
  const r = computeStorySkillGate({
    filePath: '/repo/specs/story-1.1-nueva.md', existsOnDisk: false, status: estado, isStoryCandidate: true,
    isHarness: false, repoUnderHarness: true, idIsWork: true,
  });
  assert.strictEqual(r.action, 'pass');
  assert.strictEqual(r.kind, 'new-draft');
});

test('DocsMatch_SinFechaNoMide (T11) @story-8.261 @ac-11', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-match-'));
  try {
    const vacia = path.join(dir, 'vacia.js');
    fs.writeFileSync(vacia, "module.exports = { MUTATION_NOTICE_UNTIL: '' };\n");
    assert.throws(() => fechaDelAviso(vacia), /no medido: MUTATION_NOTICE_UNTIL .* no es una fecha/);
    const invalida = path.join(dir, 'invalida.js');
    fs.writeFileSync(invalida, "module.exports = { MUTATION_NOTICE_UNTIL: '2026-13-40' };\n");
    assert.throws(() => fechaDelAviso(invalida), /no es una fecha/);
    assert.throws(() => fechaDelAviso(path.join(dir, 'no-existe.js')), /no medido: no pude importar/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
