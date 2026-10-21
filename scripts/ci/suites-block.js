#!/usr/bin/env node
'use strict';

/**
 * suites-block.js — ¿un rojo NUEVO de suite frena esta validación, o sólo avisa?
 *
 * POR QUÉ EXISTE. Un rojo nuevo de suite puede avisar sin frenar: dos suites verdes en una máquina pueden salir rojas
 * en el agente, y no siempre las mismas. Con la validación como control obligatorio de `main` en el repo público, el
 * modo aviso tiene que poder salir; pero sacarlo con falsos rojos frena cambios sanos. Por eso el freno va detrás de
 * un interruptor, que se cambia sin un merge.
 *
 * El interruptor es una variable de la definición del pipeline, `HARNESS_SUITES_BLOCK`. Sin ella, decide el repo propio:
 *   · un repo de Azure (la validación del interno, la 170): APAGADO;
 *   · un repo de GitHub (la definición sobre el público): PRENDIDO — si algo falla, falla cerrado.
 * Un valor que no se entiende frena (y lo dice): un interruptor mal escrito no puede abrir la puerta.
 *
 * La leen dos pasos de la validación: el veredicto (apagado → `pr-verdict.js --suites-warn`) y el que corre las suites
 * (prendido → toda roja nueva tiene su segunda pasada, aunque el trabajo vaya tarde). Una sola regla para los dos.
 *
 * Uso: node scripts/ci/suites-block.js   → imprime `on` u `off`; sale 0 (el motivo de una duda, por la salida de error).
 * Casos: scripts/tests/pr-suites-shards.test.js (T14).
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

/** `on` u `off`, y por qué (para el registro). */
function decide(env = process.env) {
  let raw = String(env.HARNESS_SUITES_BLOCK || '').trim();
  // Azure deja el LITERAL `$(VAR)` cuando un paso nombra como macro una variable que no existe: no es un valor.
  if (/^\$\(.*\)$/.test(raw)) raw = '';
  const value = raw.toLowerCase();
  if (ON.has(value)) return { block: 'on', why: 'el interruptor lo prende' };
  if (OFF.has(value)) return { block: 'off', why: 'el interruptor lo apaga' };
  const github = String(env.BUILD_REPOSITORY_PROVIDER || '').toLowerCase() === 'github';
  if (value) return { block: 'on', why: `no entiendo el valor del interruptor HARNESS_SUITES_BLOCK («${raw.slice(0, 40)}»): frena, falla cerrado`, odd: true };
  return github
    ? { block: 'on', why: 'sin interruptor, sobre un repo de GitHub: frena' }
    : { block: 'off', why: 'sin interruptor, sobre un repo de Azure: avisa, como hasta la tanda C' };
}

if (require.main === module) {
  const d = decide();
  if (d.odd) process.stderr.write(`suites-block: ${d.why}\n`);
  process.stdout.write(`${d.block}\n`);
}
module.exports = { decide };
