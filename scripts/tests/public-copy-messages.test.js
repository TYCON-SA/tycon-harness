'use strict';
// public-copy-messages.test.js — los textos que en el arnés publicado mandarían a una pieza que no viaja (story 8.10.3,
// tanda A, AC 5 · T5; story 8.26, AC 36).
//
// POR QUÉ EXISTE: tres piezas del arnés hablan de integraciones del equipo que el arnés publicado no trae —la llave del
// buzón de corridas, el guion nocturno de dependencias y la lista de repos de producto—. Un texto que le dice a quien lo
// usa que le falta algo, o que corra algo que no existe, es un diagnóstico falso.
//
// Hasta la story 8.26 el repo del equipo guardaba el texto «interno» y el exportador lo cambiaba sólo en la copia
// (`allowlist.json → publicTexts`). Desde el AC 36 el repo de mantenimiento ya no arma la copia: el texto público es
// el ÚNICO, en los dos lados, y la lista quedó vacía. Esta prueba fija eso:
//   · cada pieza, tal como está en el árbol, no manda a la pieza que no viaja;
//   · ninguna tiene ya una entrada en `publicTexts` (una entrada nueva volvería a pedir un texto interno que el
//     público no tiene, y el árbol de mantenimiento —lo privado con el público encima— dejaría de poder clasificarse).
// El bloque del mapa del pre-commit NO está entre ellas, a propósito (pase adversarial de la tanda A): una suite que viaja
// (githook-renames.test.sh, H2) arma un mapa de juguete y espera que ese bloque frene; sin el generador, el bloque sólo
// avisa con su propio mensaje.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));

// Lo que no puede quedar, por pieza (la frase que manda a la pieza que no viaja), y la frase pública que la reemplazó:
// el espejo, para que un archivo vacío o movido no pase por «no tiene la frase prohibida».
const PIEZAS = [
  { file: 'scripts/metrics/upload-runs.js', prohibido: /la copia del arnés está incompleta/, publico: 'Es una integración del equipo que la copia pública no trae' },
  { file: 'scripts/hooks/dependencies-notice.js', prohibido: /nightly-dependencies\.js report/, publico: 'Se deciden en su pull request.' },
  { file: 'scripts/nightly/dashboard/dashboard.js', prohibido: /declarados en repos\.json/, publico: 'la lista de productos del equipo no viene con la copia pública' },
];

test('PublicCopy_PieceThatDoesNotTravel_NoMessageSendsThere — cada pieza trae el texto público, sin transformar nada', () => {
  for (const p of PIEZAS) {
    const fuente = fs.readFileSync(path.join(RAIZ, p.file), 'utf8');
    assert.doesNotMatch(fuente, p.prohibido, `${p.file}: manda a la pieza que no viaja`);
    assert.ok(fuente.includes(p.publico), `${p.file}: no trae su texto público («${p.publico}»)`);
  }
});

test('PublicCopy_NoInternalTextLeft_AC36 — ninguna de las tres piezas pide ya un texto interno (publicTexts)', () => {
  const entradas = Array.isArray(lista.publicTexts) ? lista.publicTexts : [];
  const suyas = entradas.filter((e) => e && PIEZAS.some((p) => p.file === e.file));
  assert.deepStrictEqual(suyas.map((e) => e.file), [], 'una pieza volvió a declarar un texto interno en allowlist.json → publicTexts');
});
