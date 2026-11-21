#!/usr/bin/env node
'use strict';
// hook-failures-notice.js — SessionStart: las fallas de los controles del arnés de las últimas 24 horas, una línea por
// control, con cuántas veces falló dejando pasar y cuántas frenando, y la ruta del registro.
//
// Lee hook-errors.log de la carpeta del estado (stateDir de scripts/setup/harness/tycon-home.js, la misma donde escriben
// el despachador de ediciones, los ganchos y la trampa del freno de comandos). Un registro empieza en un renglón con el
// sello `[<ISO>] `; los renglones sin sello son su continuación (la pila de un error) y no se miran, aunque traigan una
// marca. Un sello que no se lee como fecha tampoco abre un registro: sin fecha no se sabe si entra en las 24 horas. Del
// primer renglón, en este orden:
//   a) `… handler "<nombre>" FAILED OPEN|CLOSED…` (el despachador): el control es <nombre>;
//   b) `safety-guard ERR-FAIL-OPEN …` (la trampa del freno de comandos): `safety-guard`, dejando pasar;
//   c) `<palabra> FAILED OPEN|FAILED CLOSED|FRENÓ POR FALLA…`, una palabra justo después del sello: <palabra> sin `.js`;
//   d) un registro con alguna de esas marcas del que no sale un nombre: «control sin nombre». Nunca se descarta callado.
// Imprime una cabecera con la ruta del registro, una línea por control y el renglón de cómo repararlo.
// FAILED CLOSED y FRENÓ POR FALLA cuentan frenando; FAILED OPEN y ERR-FAIL-OPEN, dejando pasar. Un registro sin ninguna
// marca (avisos de otros ganchos) se saltea. Lo del freno de producción lo cuenta production-notice.js y acá no entra.
//
// Sin registro, o sin fallas en las últimas 24 horas, no dice nada. Si el registro existe y no se puede leer, lo dice.
// Nunca frena: sale 0 siempre.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VENTANA_MS = 24 * 3600 * 1000;
// con `s`: un separador de renglón de Unicode (U+2028/U+2029) en el mensaje no corta el registro
const SELLO = /^\[(\d{4}-\d{2}-\d{2}T[^\]\s]+)\] (.*)$/s;
const MARCA = /FAILED OPEN|FAILED CLOSED|ERR-FAIL-OPEN|FRENÓ POR FALLA/;
const SIN_NOMBRE = 'control sin nombre';

/** `{ control, frena }` del primer renglón (sin el sello), o null si no es una falla de un control. */
function clasificar(texto) {
  const marca = MARCA.exec(texto);
  if (!marca) return null;
  const frena = marca[0] === 'FAILED CLOSED' || marca[0] === 'FRENÓ POR FALLA';
  const a = /handler "([^"]+)" FAILED (OPEN|CLOSED)/.exec(texto);
  if (a) return { control: a[1], frena: a[2] === 'CLOSED' };
  if (/^safety-guard ERR-FAIL-OPEN\b/.test(texto)) return { control: 'safety-guard', frena: false };
  const c = /^(\S+) (FAILED OPEN|FAILED CLOSED|FRENÓ POR FALLA)/.exec(texto);
  if (c) return { control: c[1].replace(/\.js$/, ''), frena: c[2] !== 'FAILED OPEN' };
  return { control: SIN_NOMBRE, frena };
}

/** Las fallas por control de las últimas 24 horas: Map(control → { abiertas, cerradas }). */
function contar(log, now) {
  const cuentas = new Map();
  for (const renglon of log.split(/\r?\n/)) {
    const m = SELLO.exec(renglon);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts) || ts < now - VENTANA_MS) continue;
    if (/^prod-access-guard\b/.test(m[2])) continue;
    const falla = clasificar(m[2]);
    if (!falla) continue;
    const c = cuentas.get(falla.control) || { abiertas: 0, cerradas: 0 };
    if (falla.frena) c.cerradas++; else c.abiertas++;
    cuentas.set(falla.control, c);
  }
  return cuentas;
}

function main({ home = os.homedir(), now = Date.now(), write = (t) => process.stdout.write(t) } = {}) {
  const ruta = path.join(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home), 'hook-errors.log');
  let log;
  try {
    log = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    write(`⚠️ no pude leer el registro de fallas de los controles (${(e && (e.code || e.message)) || e}): ${ruta}\n`);
    return;
  }
  const cuentas = contar(log, now);
  if (!cuentas.size) return;
  const filas = [...cuentas].sort(([na, a], [nb, b]) => (b.cerradas + b.abiertas) - (a.cerradas + a.abiertas) || na.localeCompare(nb))
    .map(([nombre, c]) => `  · ${nombre}: ${[c.abiertas && `${c.abiertas} dejando pasar`, c.cerradas && `${c.cerradas} frenando`].filter(Boolean).join(', ')}`);
  write(`⚠️ controles del arnés que fallaron en las últimas 24 h (detalle en ${ruta}):\n${filas.join('\n')}\n`
    + '   Reparalo: /tycon-harness dice si el arnés quedó bien instalado.\n');
}

if (require.main === module) {
  try { fs.readFileSync(0, 'utf8'); } catch { /* el evento no hace falta: el aviso es de toda la máquina */ }
  try { main(); } catch (e) {
    try { process.stdout.write(`⚠️ no pude contar las fallas de los controles (${String((e && e.message) || e).split('\n')[0]})\n`); } catch { /* nada */ }
  }
  process.exit(0);
}

module.exports = { main, clasificar, contar };
