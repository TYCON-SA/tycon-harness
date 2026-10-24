#!/usr/bin/env node
'use strict';
/**
 * windows-skips.test.js — ningún salteo de Windows sin su motivo, en las siete suites que corre el ensayo de Windows.
 *
 * QUÉ CUIDA: un salteo condicionado a Windows sin el porqué escrito se lee como «pasa en Windows» y es «no se midió en
 * Windows». Las siete suites (las del paso «suites» del escenario portable de la 182) se recorren buscando las tres formas
 * de saltear que usan:
 *   1. `{ skip: <condición de Windows> && '<motivo>' }` (o `? '<motivo>' : false`, o `&& <constante de texto>`) en la
 *      declaración de una prueba, aunque siga en el renglón de abajo;
 *   2. una condición de Windows con un `t.skip(`, un `continue` o un `return` en ese renglón o en el siguiente: el motivo
 *      va en el texto de `t.skip(…)` o `t.diagnostic(…)`, o en un comentario (ese renglón, el anterior o el siguiente).
 *      Un texto que es parte de la condición —el nombre de un caso— no es un motivo;
 *   3. un bloque que sólo corre fuera de Windows (`if (!EN_WINDOWS) {`), con un comentario que nombra Windows en ese
 *      renglón o en los dos de arriba.
 * Un alias de la condición (`const win = process.platform === 'win32';`) cuenta como la condición. La suite de bash
 * (`harness-node.test.sh`) saltea con `saltear_en_windows <caso> <motivo>` y su propia lista fija, que mide ella misma.
 *
 * Correr: node --test scripts/tests/windows-skips.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const SUITES = [
  'scripts/tests/apply-hooks.test.js',
  'scripts/tests/safety-escape.test.js',
  'skills/tycon-pipeline/scripts/tests/story-gate.test.js',
  'skills/tycon-pipeline/scripts/tests/ledger-visible.test.js',
  'skills/tycon-pipeline/scripts/tests/run-close.test.js',
  'skills/tycon-pipeline/scripts/tests/unit.test.js',
];

const BASE_WINDOWS = String.raw`(?:process\.platform|os\.platform\(\))\s*===\s*['"]win32['"]|\bEN_WINDOWS\b|\benWindows\b`;
const TEXTO = String.raw`(['"\x60])((?:(?!\1).){10,})\1`;
// el motivo vale sólo en su lugar: el texto de t.skip(…) o t.diagnostic(…), o un comentario; un texto que es parte de
// la condición (el nombre de un caso) no explica nada
// (un comentario cuenta si nombra Windows: uno cualquiera de al lado no explica el salteo)
const MOTIVO_EN_SU_LUGAR = new RegExp(String.raw`\bt\.(?:skip|diagnostic)\(\s*` + TEXTO + String.raw`|\/\/[^\n]*Windows[^\n]{5,}`);
const SALTEO = /\bt\.skip\(|\bcontinue\b|\breturn\b/;

/** Los salteos de Windows sin motivo de un texto: `[{ renglon, texto, regla }]`. */
function sinMotivo(texto) {
  const out = [];
  const src = String(texto);
  const renglones = src.split('\n');
  // los alias de la condición (`const win = process.platform === 'win32'`) también son una condición de Windows
  // (sólo la condición sola: `const bin = EN_WINDOWS ? a : b` usa la condición, no la nombra)
  const alias = [...src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:` + BASE_WINDOWS + String.raw`)\s*;`, 'g'))].map((m) => m[1]);
  const nombres = alias.length ? `|\\b(?:${alias.join('|')})\\b` : '';
  const WINDOWS = new RegExp(BASE_WINDOWS + nombres);
  const NEGADA = new RegExp(String.raw`if\s*\(\s*(?:!\s*(?:EN_WINDOWS|enWindows${alias.length ? '|' + alias.join('|') : ''})|(?:process\.platform|os\.platform\(\))\s*!==\s*['"]win32['"])\s*\)\s*\{`);
  // las constantes de texto del archivo: `skip: cond && MOTIVO` vale si MOTIVO es un texto con motivo
  const constantes = new Map([...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(['"`])((?:(?!\2).){10,})\2/g)].map((m) => [m[1], m[3]]));
  renglones.forEach((r, i) => {
    const n = i + 1;
    const ventana = `${r}\n${renglones[i + 1] || ''}`;
    const decl = /skip:\s*([\s\S]*?)(?:\}\s*,|\}\s*\)|$)/.exec(ventana);
    if (decl && /skip:/.test(r) && WINDOWS.test(decl[1])) {
      const cond = decl[1];
      const conTexto = new RegExp(String.raw`(?:&&|\?)\s*` + TEXTO).test(cond);
      const conConstante = (/&&\s*(\w+)\s*$/.exec(cond.trim()) || [])[1];
      if (!conTexto && !(conConstante && constantes.has(conConstante))) out.push({ renglon: n, texto: r.trim(), regla: 'skip sin motivo en la declaración' });
      return;
    }
    if (WINDOWS.test(r) && !NEGADA.test(r) && SALTEO.test(ventana) && /\bif\b|&&|\?/.test(r)) {
      const contexto = `${renglones[i - 1] || ''}\n${ventana}`;
      if (!MOTIVO_EN_SU_LUGAR.test(contexto)) out.push({ renglon: n, texto: r.trim(), regla: 'salteo condicionado sin motivo en su lugar' });
      return;
    }
    if (NEGADA.test(r)) {
      const contexto = [renglones[i - 2] || '', renglones[i - 1] || '', r].join('\n');
      if (!/\/\/[^\n]*Windows/.test(contexto)) out.push({ renglon: n, texto: r.trim(), regla: 'bloque fuera de Windows sin comentario que diga por qué' });
    }
  });
  return out;
}

test('T7 WindowsSkips_TodosConMotivo @story-8.115 @ac-6 — seis de las siete suites (harness-node mide su propia lista)', () => {
  const malos = [];
  for (const rel of SUITES) {
    const f = path.join(RAIZ, rel);
    assert.ok(fs.existsSync(f), `falta la suite ${rel}: la lista de esta prueba quedó vieja`);
    for (const m of sinMotivo(fs.readFileSync(f, 'utf8'))) malos.push(`${rel}:${m.renglon} (${m.regla}): ${m.texto.slice(0, 140)}`);
  }
  assert.deepStrictEqual(malos, [], `salteos de Windows sin motivo:\n${malos.join('\n')}`);
});

test('T7 WindowsSkips_TodosConMotivo @story-8.115 @ac-6 — el detector encuentra cada forma sin motivo', () => {
  const casos = [
    "test('x', { skip: process.platform === 'win32' }, () => {});",
    "test('x', { skip: process.platform === 'win32' && 'no' }, () => {});",
    "  if (process.platform === 'win32') { t.skip(); return; }",
    "  if (EN_WINDOWS && caso === 'a') continue;",
    "  if (!EN_WINDOWS) {",
    // el nombre del caso, o un texto de la condición, no es un motivo
    "  if (EN_WINDOWS && nombre === 'caso-largo-de-prueba') continue;",
    "  if (process.platform === 'win32') return assert.ok(true, 'esto no es un motivo');",
    // la condición y el salteo en renglones distintos
    "  if (process.platform === 'win32')\n    return;",
    "  if (EN_WINDOWS) {\n    t.skip(); return;",
    // detrás de un alias
    "  const win = process.platform === 'win32';\n  if (win) return;",
    "  const esWindows = process.platform === 'win32';\ntest('x', { skip: esWindows }, () => {});",
    "  if (os.platform() === 'win32') return;",
    // un comentario de al lado que no explica el salteo
    "  // armamos el laboratorio de prueba\n  if (EN_WINDOWS) return;",
  ];
  for (const c of casos) assert.ok(sinMotivo(c).length >= 1, `no lo vio: ${c}`);
  const buenos = [
    "test('x', { skip: process.platform === 'win32' && 'Windows no guarda permisos POSIX' }, () => {});",
    "test('x', { skip: process.platform === 'win32' ? 'Windows no guarda permisos POSIX' : false }, () => {});",
    "const MOTIVO_PERMISOS = 'Windows no guarda permisos POSIX';\ntest('x', { skip: process.platform === 'win32' && MOTIVO_PERMISOS }, () => {});",
    "test('x', { skip: process.platform === 'win32'\n  && 'Windows no guarda permisos POSIX' }, () => {});",
    "  if (EN_WINDOWS && caso === 'a') { t.diagnostic('salteado en Windows: no se puede fingir una versión'); continue; }",
    "  // en Windows no hay una forma bin/node que medir\n  if (EN_WINDOWS && caso === 'a') continue;",
    "  // en Windows esta forma no existe\n  if (!EN_WINDOWS) {",
    "  const salida = enWindows ? 'una' : 'otra';",
  ];
  for (const c of buenos) assert.deepStrictEqual(sinMotivo(c), [], `lo marcó de más: ${c}`);
});
