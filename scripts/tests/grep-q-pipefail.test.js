#!/usr/bin/env node
'use strict';
// grep-q-pipefail.test.js — ningún guion de pruebas con `pipefail` pasa una tubería a `grep -q`.
//
// Por qué existe: con `set -o pipefail`, `… | grep -q <patrón>` es una carrera. `grep -q` sale apenas encuentra; si lo de la
// izquierda todavía escribe, muere por SIGPIPE y la tubería entera cuenta como falla AUNQUE el patrón esté. Medido en
// Linux con la máquina cargada: con un texto corto (`echo "$S" | grep -q`), 2 rojos falsos cada 20 000; con un programa
// que escribe mucho, rojo siempre. Así salieron rojas de a ratos release-notes y otras en public-ci (2026-10-14), y se
// cambiaron 491 líneas de 71 suites, y 4 de dos guiones del producto, a `| grep … >/dev/null`: sin -q, grep lee hasta el
// final. En el producto importa más: en validate-engram-upgrade.sh la carrera hacía que un error real del sync se leyera
// como «sin error».
//
// Lo que no se puede perder (GrepQPipefail_NoPipeIntoGrepQ):
//   · ningún renglón de código de un `.sh` del arnés o de las skills (pruebas y producto) con pipefail tiene `| grep -q` (también `-qE`, `-Fq`…); los comentarios no
//     cuentan y `|| grep -q` (un «o», no una tubería) tampoco;
//   · el control: el detector ve cada forma en un texto de laboratorio, y no ve las que no son el caso;
//   · nunca verde sin mirar: si no encontró guiones con pipefail, es rojo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const CARPETAS = ['scripts', 'skills'];
const PIPE_A_GREP_Q = /(^|[^|])\|(?!\|)\s*grep\s+-[A-Za-z]*q/;

function guiones(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) guiones(p, out);
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out;
}

/** Los renglones de código (no comentarios) con una tubería a `grep -q`, como «ruta:línea: texto». */
function hallazgos(texto, ruta) {
  const out = [];
  texto.split('\n').forEach((linea, i) => {
    if (/^\s*#/.test(linea)) return;
    if (PIPE_A_GREP_Q.test(linea)) out.push(`${ruta}:${i + 1}: ${linea.trim().slice(0, 160)}`);
  });
  return out;
}

test('GrepQPipefail_Detector_SeesEachFormAndNotTheOthers', () => {
  for (const si of ['echo "$S" | grep -q x && ok', 'printf \'%s\' "$o" | grep -qE \'a|b\'', 'git log |grep -Fq abc', 'x | grep -iq y']) {
    assert.strictEqual(hallazgos(si, 'lab').length, 1, `no vio: ${si}`);
  }
  for (const no of ['# con `x | grep -q` y pipefail…', 'grep -q x "$F" || grep -q y "$G"', 'echo "$S" | grep x >/dev/null', 'x | grep -c y', 'false || grep -q z f']) {
    assert.strictEqual(hallazgos(no, 'lab').length, 0, `vio de más: ${no}`);
  }
});

test('GrepQPipefail_NoPipeIntoGrepQ — ningún guion con pipefail pasa una tubería a grep -q', () => {
  const conPipefail = CARPETAS.filter((c) => fs.existsSync(path.join(RAIZ, c)))
    .flatMap((c) => guiones(path.join(RAIZ, c)))
    .filter((f) => /pipefail/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(conPipefail.length > 20, `pocos guiones con pipefail (${conPipefail.length}): no miré lo que debía`);
  const malos = conPipefail.flatMap((f) => hallazgos(fs.readFileSync(f, 'utf8'), path.relative(RAIZ, f)));
  assert.deepStrictEqual(malos, [], 'tubería a `grep -q` con pipefail: cambiala a `| grep … >/dev/null` (sin -q, grep lee todo y no corta la tubería)');
});
