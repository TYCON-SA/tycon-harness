'use strict';
/*
 * operations-guide.test.js — la guía de los procesos de la noche dice cuánto lleva y avisa, antes de empezar, las dos
 * casillas de Azure DevOps que dejan la noche sin medir.
 *
 * T1 GuiaAzure_TiempoReal   T2 GuiaGithub_TiempoReal   T3 GuiaAzure_LasDosCasillasArriba
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// sin las marcas de cita y con los cortes de línea vueltos un espacio: una frase puede partirse en dos renglones
const leer = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8').replace(/^> ?/gm, '').replace(/\s+/g, ' ');
const AZURE = 'pipelines/operations/README.md';
const GITHUB = 'pipelines/operations/github/README.md';

test('T1 GuiaAzure_TiempoReal @story-8.49 @ac-1', () => {
  const t = leer(AZURE);
  assert.match(t, /entre tres y cuatro horas la primera vez/);
  assert.doesNotMatch(t, /Lleva una hora/);
});

test('T2 GuiaGithub_TiempoReal @story-8.49 @ac-2', () => {
  const t = leer(GITHUB);
  assert.match(t, /entre tres y cuatro horas la primera vez/);
  assert.doesNotMatch(t, /Lleva una hora/);
});

test('T3 GuiaAzure_LasDosCasillasArriba @story-8.49 @ac-3', () => {
  const t = leer(AZURE);
  const i = t.indexOf('## 1.');
  assert.ok(i > 0, 'la sección 1');
  const arriba = t.slice(0, i);
  for (const s of ['Protect access to repositories in YAML pipelines', 'Limit job authorization scope to current project for non-release pipelines', 'Project settings → Pipelines → Settings', 'NO MEDIDO', 'otros proyectos', 'todo el proyecto']) {
    assert.ok(arriba.includes(s), `antes de la sección 1: «${s}»`);
  }
  assert.match(arriba, /\]\(#3-permisos-de-la-identidad-de-los-pipelines\)/, 'enlaza la sección 3');
  assert.ok(t.includes('## 3. Permisos de la identidad de los pipelines'), 'la sección 3 sigue con ese título');
});
