#!/usr/bin/env node
'use strict';
/**
 * failed-first.js — la lista de suites que fallaron en la última corrida completa de la puerta.
 *
 * La lista vive en el marcador (`testsFailed: [{ruta, raiz, repo, at}]`, al lado de `checks`) y guarda la entrada de
 * `scripts/tests/suites.json`: su `ruta` es la que recibe `test-gate.sh <repo> <story> --suite <ruta>`. `repo` es el
 * repo de la corrida, canónico: el marcador es de la sesión y una sesión puede correr la puerta en varios repos. Acá están las
 * funciones puras que la leen y la arman; las escrituras al marcador las hace `marker.js tests-failed`.
 *
 * Uso:  node failed-first.js has <suites.json> <ruta>   → sale 0 si la ruta es una entrada de la lista, 1 si no, 2 si
 *       la lista no se deja leer (y lo dice).
 *
 * Casos: skills/tycon-pipeline/scripts/tests/test-gate-failed-first.test.js
 */
const fs = require('fs');

/** Las entradas de `diarias` y `semanales`; lanza si el archivo no se deja leer. */
function entries(suitesJson) {
  const d = JSON.parse(fs.readFileSync(suitesJson, 'utf8'));
  return [...(d.diarias || []), ...(d.semanales || [])];
}

function find(suitesJson, ruta) {
  return entries(suitesJson).find((s) => s.ruta === ruta) || null;
}

/** Las suites que fallaron según el resumen de run-suites-json.js, de la corrida en `repo`. Sin resumen legible, ninguna. */
function fromSummary(resumen, repo, at = new Date().toISOString()) {
  const fallas = (resumen && Array.isArray(resumen.fallas)) ? resumen.fallas : [];
  const vistas = new Set();
  const out = [];
  for (const f of fallas) {
    const e = f && f.entrada;
    if (!e || typeof e.ruta !== 'string' || vistas.has(e.ruta)) continue;
    vistas.add(e.ruta);
    out.push({ ruta: e.ruta, raiz: e.raiz || null, repo, at });
  }
  return out;
}

/** Separa las rutas que siguen en suites.json de las que ya no están. */
function prune(lista, suitesJson) {
  const rutas = new Set(entries(suitesJson).map((s) => s.ruta));
  const keep = [];
  const gone = [];
  for (const x of lista || []) (rutas.has(x.ruta) ? keep : gone).push(x);
  return { keep, gone };
}

if (require.main === module) {
  const [cmd, suitesJson, ruta] = process.argv.slice(2);
  if (cmd !== 'has' || !suitesJson || !ruta) {
    console.error('uso: failed-first.js has <suites.json> <ruta>');
    process.exit(2);
  }
  try {
    process.exit(find(suitesJson, ruta) ? 0 : 1);
  } catch (e) {
    console.error(`[failed-first] no pude leer ${suitesJson}: ${e.message}`);
    process.exit(2);
  }
}

module.exports = { entries, find, fromSummary, prune };
