'use strict';
// public-copy-messages.test.js — los textos que en la copia pública mandarían a una pieza que no viaja (story 8.10.3, tanda
// A, AC 5 · T5).
//
// POR QUÉ EXISTE: tres piezas del arnés hablan de integraciones del equipo que la copia no trae —la llave del buzón de
// corridas, el guion nocturno de dependencias y la lista de repos de producto—. En el repo
// del equipo esos textos están bien: diagnostican algo real. En la copia le dicen a quien la usa que le falta algo, o que
// corra algo que no existe. El exportador los cambia sólo en la copia con la transformación `public-texts`
// (`allowlist.json → publicTexts`: el texto EXACTO, su versión pública, cuántas veces aparece y el motivo).
//
// Qué fija, sobre los archivos de verdad y las entradas de verdad de la lista blanca:
//   · cada una de las tres piezas tiene su entrada;
//   · aplicadas, ninguna frase manda a la pieza que falta;
// El bloque del mapa del pre-commit NO está entre ellas, a propósito (pase adversarial de la tanda A): una suite que viaja
// (githook-renames.test.sh, H2) arma un mapa de juguete y espera que ese bloque frene; sin el generador, el bloque sólo
// avisa con su propio mensaje.
//   · en el repo, los archivos conservan los textos de hoy (el diagnóstico del equipo no se pierde).
// Corre también en la copia: ahí la transformación ya se aplicó, y la prueba mira el ARCHIVO de la copia (no vuelve a
// transformar nada). Cuál de los dos es se sabe por la tabla privada de reemplazos, que nunca viaja (pase de fallos
// silenciosos de la tanda A: sin esa distinción, una copia con un texto sin transformar caía en la rama del repo, que
// re-aplicaba la transformación por su cuenta, y daba verde).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const exportador = require('../publishing/export.js');
const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));

// Lo que no puede quedar en la copia, por pieza (la frase que manda a la pieza que no viaja).
const PIEZAS = [
  { file: 'scripts/metrics/upload-runs.js', prohibido: /la copia del arnés está incompleta/ },
  { file: 'scripts/hooks/dependencies-notice.js', prohibido: /nightly-dependencies\.js report/ },
  { file: 'scripts/nightly/dashboard/dashboard.js', prohibido: /declarados en repos\.json/ },
];
const entradas = (lista.publicTexts || []).filter((e) => e && e.root === 'arnes');
const EN_EL_REPO = fs.existsSync(path.join(RAIZ, 'scripts', 'publishing', 'replacements.json'));

test('PublicCopy_PieceThatDoesNotTravel_NoMessageSendsThere — los textos tienen su versión pública', () => {
  for (const p of PIEZAS) {
    const suyas = entradas.filter((e) => e.file === p.file);
    assert.ok(suyas.length, `${p.file}: sin entrada en allowlist.json → publicTexts`);
    const fuente = fs.readFileSync(path.join(RAIZ, p.file), 'utf8');
    let publico;
    if (EN_EL_REPO) {
      for (const e of suyas) assert.ok(fuente.includes(e.text), `${p.file}: el repo conserva el texto de hoy`);
      publico = exportador.applyPublicTexts(`arnes/${p.file}`, fuente, entradas);
    } else {
      // en la copia: el archivo tal cual viajó, sin volver a transformarlo
      publico = fuente;
      assert.ok(!suyas.some((e) => fuente.includes(e.text)), `${p.file}: la copia trae el texto del repo sin transformar`);
    }
    assert.doesNotMatch(publico, p.prohibido, `${p.file}: en la copia no manda a la pieza que no viaja`);
  }
});
