#!/usr/bin/env node
'use strict';
/**
 * nightly-coverage.test.js — qué criterios de una historia tienen una prueba que corre de noche, y qué archivos de la
 * regla de la entrada se tratan como sensibles.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/nightly-coverage.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const { criteriosConPruebaDeNoche } = require(path.join(__dirname, '..', 'lib', 'nightly-coverage.js'));

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

function escribir(raiz, rel, texto) {
  const abs = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, texto);
  return abs;
}

function arnes({ suites } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noche-')));
  temporales.push(raiz);
  escribir(raiz, 'scripts/tests/suites.json', suites !== undefined ? suites : JSON.stringify({
    diarias: [{ raiz: 'arnes', ruta: 'tests/diaria.test.js' }, { raiz: 'agent-skills', ruta: 'tycon-pipeline/scripts/tests/skill.test.js' }],
    semanales: [{ raiz: 'arnes', ruta: 'tests/semanal.test.js' }],
  }));
  const pruebas = [
    escribir(raiz, 'scripts/tests/diaria.test.js', "test('T1 @story-9.9 @ac-1', f);\n"),
    escribir(raiz, 'skills/tycon-pipeline/scripts/tests/skill.test.js', "test('T2 @story-9.9 @ac-2 @ac-3', f);\n"),
    escribir(raiz, 'scripts/tests/semanal.test.js', "test('T4 @story-9.9 @ac-4', f);\n"),
    escribir(raiz, 'scripts/tests/suelta.test.js', "test('T5 @story-9.9 @ac-5', f);\n"),
  ];
  return { raiz, pruebas };
}

const orden = (s) => [...s].sort((a, b) => a - b);

test('T14 NightlyCoverage_DiariasYBanco_SemanalesNo @story-8.310 @ac-14', () => {
  const { raiz, pruebas } = arnes();
  pruebas.push(escribir(raiz, 'scripts/controls-bench/cases/hooks/90-caso.json', JSON.stringify({ __doc: 'T9 Caso @story-9.9 @ac-6.' })));
  pruebas.push(escribir(raiz, 'scripts/controls-bench/cases/advisors/revisor.json', JSON.stringify({ __doc: 'T9 Caso @story-9.9 @ac-7.' })));
  pruebas.push(escribir(raiz, 'scripts/controls-bench/cases/guides/guia.json', JSON.stringify({ __doc: 'T9 Caso @story-9.9 @ac-8.' })));
  // un caso del banco que la historia no declara no le da cobertura
  escribir(raiz, 'scripts/controls-bench/cases/hooks/93-no-declarado.json', JSON.stringify({ __doc: 'T9 Caso @story-9.9 @ac-10.' }));
  // las marcas de la historia y del criterio en renglones distintos no dicen que esa prueba mire ese criterio
  pruebas.push(escribir(raiz, 'scripts/tests/diaria2.test.js', "// @story-9.9\ntest('otra @story-1.1 @ac-9', f);\n"));
  fs.writeFileSync(path.join(raiz, 'scripts/tests/suites.json'), JSON.stringify({
    diarias: [{ raiz: 'arnes', ruta: 'tests/diaria.test.js' }, { raiz: 'arnes', ruta: 'tests/diaria2.test.js' }, { raiz: 'agent-skills', ruta: 'tycon-pipeline/scripts/tests/skill.test.js' }],
    semanales: [{ raiz: 'arnes', ruta: 'tests/semanal.test.js' }],
  }));
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz, historia: '9.9', pruebas })), [1, 2, 3, 6]);
  // otra historia con un número que contiene a éste no cuenta
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz, historia: '9', pruebas })), []);
});

test('T14b NightlyCoverage_ListaOCasoIlegible_NoCuenta @story-8.310 @ac-14', () => {
  const roto = arnes({ suites: '{ esto no es json' });
  roto.pruebas.push(escribir(roto.raiz, 'scripts/controls-bench/cases/hooks/90-caso.json', JSON.stringify({ __doc: '@story-9.9 @ac-6' })));
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz: roto.raiz, historia: '9.9', pruebas: roto.pruebas })), [6], 'sin lista no cuenta ninguna suite, y el banco sigue');
  const { raiz, pruebas } = arnes();
  pruebas.push(escribir(raiz, 'scripts/controls-bench/cases/hooks/91-roto.json', '{ "__doc": "@story-9.9 @ac-7"'));
  pruebas.push(escribir(raiz, 'scripts/controls-bench/cases/hooks/92-bien.json', JSON.stringify({ casos: [{ nota: '@story-9.9 @ac-8' }] })));
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz, historia: '9.9', pruebas })), [1, 2, 3, 8], 'un caso roto no cuenta y no tapa a los otros');
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz: path.join(raiz, 'no-existe'), historia: '9.9', pruebas })), []);
});

test('NightlyCoverage_RenglonConOtraHistoria_SoloSusCriterios @story-8.310 @ac-14', () => {
  const { raiz, pruebas } = arnes();
  fs.writeFileSync(pruebas[0], "test('T1 @story-9.9 @ac-1 @story-9.8 @ac-2', f);\ntest('T2 @story-9.8 @ac-3 @story-9.9 @ac-4', f);\n");
  assert.deepStrictEqual(orden(criteriosConPruebaDeNoche({ raiz, historia: '9.9', pruebas: [pruebas[0]] })), [1, 4]);
});

test('HistoriaSensible_RutaDesdeArribaOConPunto_EsSensible @story-8.310 @ac-13', () => {
  const { historiaSensible } = require(path.join(__dirname, '..', 'lib', 'nightly-coverage.js'));
  for (const rel of ['./skills/tycon-pipeline/scripts/marker.js', 'Proj/skills/tycon-pipeline/scripts/marker.js', '../Proj/skills/tycon-pipeline/scripts/marker.js']) {
    assert.strictEqual(historiaSensible({ declarados: [rel], codigo: [] }), true, rel);
  }
  assert.strictEqual(historiaSensible({ declarados: ['src/a.js'], codigo: [] }), false);
  // un archivo de código fuera de cualquier repo no se sabe dónde cae: sensible
  const suelto = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suelto-'))), 'x.js');
  temporales.push(path.dirname(suelto));
  fs.writeFileSync(suelto, '// x\n');
  assert.strictEqual(historiaSensible({ declarados: ['src/x.js'], codigo: [suelto] }), true);
});

// 🔴 Falla con: la lectura del código que carga firmas rota (una función que ya no existe): el error cae en «no se sabe»
// y toda historia con código común cuenta como sensible.
test('HistoriaSensible_CodigoComunEnUnRepo_NoEsSensible @story-8.283 @ac-10', () => {
  const { historiaSensible } = require(path.join(__dirname, '..', 'lib', 'nightly-coverage.js'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comun-')));
  temporales.push(repo);
  fs.mkdirSync(path.join(repo, '.git'));
  const comun = escribir(repo, 'src/a.js', 'module.exports = () => 1;\n');
  assert.strictEqual(historiaSensible({ declarados: ['src/a.js'], codigo: [comun] }), false, 'código común en un repo');
  const firmas = escribir(repo, 'src/b.js', "const s = require('../scripts/lib/signatures.js');\nmodule.exports = s;\n");
  assert.strictEqual(historiaSensible({ declarados: ['src/b.js'], codigo: [firmas] }), true, 'código que carga el catálogo de firmas');
});

test('T15 Signatures_ReglaDeEntrada_EsSensible @story-8.310 @ac-15', () => {
  const { SENSITIVE } = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  for (const f of ['evidence-vs-commit.js', 'commit-story.js', 'story-requests.js', 'nightly-coverage.js']) {
    assert.ok(SENSITIVE.includes(`skills/tycon-pipeline/scripts/lib/${f}`), `${f} en SENSITIVE`);
  }
});
