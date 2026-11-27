'use strict';
// decompress-limits.test.js — lo que se descomprime de lo que baja del buzón (el hilo de una conversación, los usos de nombres
// viejos de una máquina) tiene tope de salida. Un .gz de unos KB puede abrirse a GB: sin tope, el proceso se queda sin
// memoria. Cada lectura recibe su tope (con valor de fábrica) y lo que lo pasa sale ilegible, nunca leído a medias.
//
// Uso: node --test scripts/tests/decompress-limits.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gunzip-caps-'));
// unos KB comprimidos que se abren a 64 KB de renglones
const grande = () => zlib.gzipSync(Buffer.from(`${'{"x":1}\n'.repeat(8 * 1024)}`));

test('Caps_ReviewersCost_HiloConTope — el hilo que pasa el tope sale ilegible', () => {
  const { leerHilo } = require(path.join(RAIZ, 'scripts', 'metrics', 'reviewers-cost.js'));
  const f = path.join(tmp(), 'h.jsonl.gz');
  fs.writeFileSync(f, grande());
  assert.match(String(leerHilo(f, { tope: 1024 }).error), /ERR_BUFFER_TOO_LARGE/);
  assert.ok(!leerHilo(f).error, 'con el tope de fábrica se lee');
});

test('Caps_RunChange_HiloConTope — el hilo que pasa el tope dice que no se pudo leer', () => {
  const { ventanasDelHilo } = require(path.join(RAIZ, 'scripts', 'metrics', 'run-change.js'));
  const volcado = path.join(tmp(), 'corrida.json');
  fs.writeFileSync(volcado.replace(/\.json$/, '.hilo.jsonl.gz'), grande());
  assert.match(String(ventanasDelHilo(volcado, { tope: 1024 }).error), /ERR_BUFFER_TOO_LARGE/);
  // con el tope de fábrica se lee (el hilo de juguete no trae mensajes con fecha: lo dice, pero no por no poder leerlo)
  assert.doesNotMatch(String(ventanasDelHilo(volcado).error || ''), /no se pudo leer/);
});

test('Caps_LegacyRetireCheck_UsosConTope — los usos que pasan el tope no se leen a medias: la lectura falla', () => {
  const { readMailbox } = require(path.join(RAIZ, 'scripts', 'tools', 'legacy-retire-check.js'));
  const espejo = tmp();
  const reg = path.join(espejo, 'maquina-a', 'registros');
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, 'cobertura.json'), JSON.stringify({ fecha: '2026-11-27', fuentes: { 'legacy-names': { estado: 'medido' } } }));
  fs.writeFileSync(path.join(reg, 'legacy-names.jsonl.gz'), grande());
  assert.throws(() => readMailbox(espejo, '2026-11-01', '2026-11-27', { tope: 1024 }), /ERR_BUFFER_TOO_LARGE/);
  assert.doesNotThrow(() => readMailbox(espejo, '2026-11-01', '2026-11-27'), 'con el tope de fábrica se lee');
});
