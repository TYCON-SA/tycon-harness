'use strict';
// runs-site-stamp.test.js — el sello de la vista de ejecuciones en el sitio dice qué versión del sitio armó la página.
//
// 🔴 Falla con: el rótulo «versión del sitio» sin el número (recorrido del sitio del 27/11): en modo sitio el sello ponía
// la etiqueta en lugar del commit y nunca usaba la versión que le pasa la pestaña. Sin versión conocida dice
// «desconocida», nunca el rótulo solo.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const R = require(path.join(__dirname, '..', 'nightly', 'dashboard', 'runs.js'));
const M = { corridas: [], generado: '2026-11-28T02:00:00.000Z', multi: false, registro: { estado: 'no_aplica' }, pasos: { fuente: 'skill', motivo: '' } };
const sello = (opts) => {
  const m = /<div class="stamp">([\s\S]*?)<\/div>/.exec(R.cabecera(M, opts));
  assert.ok(m, 'la cabecera trae el sello');
  return m[1].replace(/<[^>]+>/g, '');
};

test('S1 SelloDelSitio_ConLaVersion — en castellano y en inglés', () => {
  assert.match(sello({ sitio: { rol: 'maintainer', version: '3.4.5' }, idioma: 'es' }), /UTC · versión del sitio 3\.4\.5(?=Alcance|$)/);
  assert.match(sello({ sitio: { rol: 'person', version: '3.4.5' }, idioma: 'en' }), /UTC · site version 3\.4\.5(?=Scope|$)/);
});

test('S2 SelloDelSitio_SinVersion_DiceDesconocida — nunca el rótulo solo', () => {
  assert.match(sello({ sitio: { rol: 'maintainer', version: null }, idioma: 'es' }), /UTC · versión del sitio desconocida/);
  assert.match(sello({ sitio: { rol: 'maintainer' }, idioma: 'en' }), /UTC · site version unknown/);
});
