#!/usr/bin/env node
'use strict';
// undecided-guards.test.js — cada gancho de consola que frena dice en guides/safety-guard.md qué hace si no alcanza a
// decidir, y la guía de producción dice cómo se cierra el corte del gancho. Lee los archivos de verdad.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const leer = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const TITULO = '## Cuando un freno no alcanza a decidir';

/** Los guiones de consola con `effect: blocks` de una lista de ganchos. */
const frenosDeConsola = (lista) => lista.hooks
  .filter((h) => h.event === 'PreToolUse' && h.effect === 'blocks' && h.matcher.split('|').includes('Bash'))
  .map((h) => path.basename(h.spec.replace(/^@tcg:/, '')));

/** Las filas de la tabla de esa sección: `{ guion, reloj, siSeTraba }`. */
function filasDeLaGuia(guia) {
  const desde = guia.indexOf(TITULO);
  assert.ok(desde >= 0, `la guía no tiene la sección «${TITULO}»`);
  const fin = guia.indexOf('\n## ', desde + TITULO.length);
  return guia.slice(desde, fin < 0 ? guia.length : fin).split('\n')
    .map((l) => /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ guion: m[1], reloj: m[2].trim(), siSeTraba: m[3].trim() }));
}

const faltantes = (lista, guia) => {
  const hay = new Set(filasDeLaGuia(guia).map((f) => f.guion));
  return frenosDeConsola(lista).filter((g) => !hay.has(g));
};

test('T9 UndecidedGuards_GuideCoversEveryBlockingHook @story-8.308 @ac-9 — la tabla cubre cada freno de consola, y uno nuevo da rojo', () => {
  const lista = JSON.parse(leer('scripts/setup/hooks-list.json'));
  const guia = leer('guides/safety-guard.md');
  assert.strictEqual(frenosDeConsola(lista).length, 11, 'la lista de frenos de consola cambió: revisar la guía');
  assert.deepStrictEqual(faltantes(lista, guia), []);
  const conGancho = { hooks: [...lista.hooks, { event: 'PreToolUse', matcher: 'Bash|PowerShell', spec: '@tcg:freno-de-juguete.js', effect: 'blocks' }] };
  assert.deepStrictEqual(faltantes(conGancho, guia), ['freno-de-juguete.js']);
});

test('T9b UndecidedGuards_ClockColumnIsTrue @story-8.308 @ac-9 — dos frenos tienen reloj y ocho no, con lo que hace cada uno', () => {
  const filas = filasDeLaGuia(leer('guides/safety-guard.md'));
  const conReloj = filas.filter((f) => /20 s/.test(f.reloj)).map((f) => f.guion).sort();
  assert.deepStrictEqual(conReloj, ['on-bash-write-gate.js', 'safety-guard-pre.sh']);
  for (const f of filas) {
    if (conReloj.includes(f.guion)) assert.match(f.siSeTraba, /frena/i, f.guion);
    else assert.match(f.siSeTraba, /600 s/, f.guion);
  }
});

test('T9c UndecidedGuards_ProductionGuideSaysHowItCloses @story-8.308 @ac-9 — la guía de producción dice desde qué versión se cierra y cómo se sale', () => {
  const guia = leer('guides/produccion-con-permiso.md');
  assert.doesNotMatch(guia, /límite que el arnés no puede cerrar/);
  assert.match(guia, /onFailure/);
  assert.match(guia, /2\.1\.295/);
  assert.match(guia, /falta el lanzador[\s\S]{0,400}sudo[\s\S]{0,200}reinstal[\s\S]{0,300}managed-settings\.d/i);
});
