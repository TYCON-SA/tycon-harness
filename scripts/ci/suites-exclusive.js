#!/usr/bin/env node
'use strict';
/**
 * suites-exclusive.js — separa la lista de suites de un trabajo de la validación en las que pueden correr a la vez y
 * las `exclusive: true` de suites.json, que comparten estado con otras y corren solas, al final.
 *
 * POR QUÉ (2026-10-05, pedido del dueño: la validación entera en 15 min o menos). En serie, un trabajo de 214 suites
 * tardaba 18 min y el que llevaba la copia pública pasaba los 45 (corridas 12049, 12050 y 12051, cortadas sin
 * veredicto). El trabajo de suites de pipelines/azure-pipelines-maintainers-pr.yml las corre ahora de a varias, con el mismo
 * criterio que el test-gate de cada story (skills/tycon-pipeline/scripts/lib/run-suites-json.js).
 *
 * DESDE EL TRAMO I DE LA STORY 8.22 (2026-10-08) las exclusivas ya no llegan en la lista de un trabajo de suites: el
 * repartidor las aparta (`suites-shard.js --exclusive-apart`) y las corre el trabajo del banco, después del banco, en
 * el carril que quedaba ocioso (la copia pública de verdad tardaba ~6 min sola al final de un trabajo de suites). Este
 * guion lo siguen llamando los dos trabajos, con los mismos pasos (pipelines/templates/run-suites.yml): en el de
 * suites no encuentra ninguna, en el del banco son todas, y si el reparto fallara y llegaran mezcladas, las separa.
 *
 * Una suite es exclusiva si su `ruta` (de `diarias` o `semanales`) es el final de la ruta de la lista.
 *
 * Uso:  node scripts/ci/suites-exclusive.js <suites.json> <lista> <salida-paralelas> <salida-exclusivas>
 * Sale 0 con las dos salidas escritas (cada línea de la lista va a una sola); 1 si no pudo leer suites.json o la lista
 * —«no pude separar» nunca se lee como «ninguna es exclusiva»: quien llama las corre todas de a una—; 2 si faltan
 * argumentos.
 */
const fs = require('fs');

function split(config, lines) {
  const all = [].concat(config.diarias || [], config.semanales || []);
  if (!all.length) throw new Error('suites.json no trae ninguna suite');
  const ends = all.filter((s) => s && s.exclusive && typeof s.ruta === 'string').map((s) => `/${s.ruta}`);
  const isExclusive = (line) => ends.some((e) => line.replace(/\\/g, '/').endsWith(e));
  return { parallel: lines.filter((l) => !isExclusive(l)), exclusive: lines.filter(isExclusive) };
}

function main(argv) {
  const [cfg, list, par, exc] = argv;
  if (!exc) { process.stderr.write('uso: suites-exclusive.js <suites.json> <lista> <salida-paralelas> <salida-exclusivas>\n'); return 2; }
  let parts;
  try {
    parts = split(JSON.parse(fs.readFileSync(cfg, 'utf8')), fs.readFileSync(list, 'utf8').split('\n').filter(Boolean));
  } catch (e) {
    process.stderr.write(`suites-exclusive: no pude separar las exclusivas (${e.message})\n`);
    return 1;
  }
  const text = (a) => a.map((l) => `${l}\n`).join('');
  fs.writeFileSync(par, text(parts.parallel));
  fs.writeFileSync(exc, text(parts.exclusive));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { split, main };
