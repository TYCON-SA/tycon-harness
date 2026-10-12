'use strict';

/**
 * tests/lib/public-copy.js — ¿esta suite corre adentro de la copia pública? UNA señal para las pruebas de agent-skills
 * (story 8.7 del arnés, tanda B · 2026-10-03).
 *
 * La copia pública sale sin el paquete de revisores de clientes (`packs/clients/`) y sin las definiciones de sus
 * revisores (`agents/`). Tres suites contaban con ellos —packs, package-equivalence y reviewer-rules— y daban rojo sólo
 * ahí. La regla es la misma en las tres:
 *   · en el repo del equipo se mide TODO, como siempre: que falte un revisor de ese paquete es un rojo, no algo a descontar;
 *   · en la copia, lo que no se puede medir se DICE (un caso salteado con su motivo, o «NO MEDIDO: …» en el diagnóstico):
 *     nunca se cuenta como verde en silencio ni se borra el caso.
 *
 * La señal: no existe `packs/clients/pack.json`. Que ese paquete no se borre por error en el repo del equipo lo cuida
 * `legacy-names-options.test.js`, que corre sólo adentro.
 *
 * Los revisores de un paquete no se escriben acá por su nombre (story 8.10.3, tanda D): se leen de los manifiestos
 * instalados (`packReviewers`), y en la copia se reconoce al que no viaja porque le falta su definición
 * (`absentReviewers`).
 */

const fs = require('fs');
const path = require('path');

// tests/lib → tests → scripts → tycon-pipeline → skills → la raíz de agent-skills (o de la copia de un solo repo)
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const PACKS_DIR = path.join(ROOT, 'packs');
const CLIENT_PACK = path.join(PACKS_DIR, 'clients', 'pack.json');

/** `false` en el repo del equipo; en la copia pública, el motivo (sirve tal cual de mensaje para `t.skip`). */
const SKIP_PUBLIC = !fs.existsSync(CLIENT_PACK) && 'copia pública: sin el paquete de clientes';

/** Cuántos revisores trae el paquete de clientes: la copia sale sin el manifiesto y sin la definición de cada uno. */
const CLIENT_PACK_REVIEWER_COUNT = 2;

/**
 * Los revisores que declaran los manifiestos instalados (`packs/<paquete>/pack.json`), sin repetir y ordenados.
 * Un manifiesto que no se deja leer es un error, no «sin paquete»: la prueba que lo usa tiene que verlo.
 */
function packReviewers(packsDir = PACKS_DIR) {
  const nombres = new Set();
  for (const paquete of fs.readdirSync(packsDir).sort()) {
    const manifiesto = path.join(packsDir, paquete, 'pack.json');
    if (!fs.existsSync(manifiesto)) continue;   // un .DS_Store suelto no es un paquete
    for (const r of JSON.parse(fs.readFileSync(manifiesto, 'utf8')).reviewers || []) nombres.add(r.agent);
  }
  return [...nombres].sort();
}

/**
 * De una lista de revisores, los que esta copia NO trae (sin su `agents/<nombre>.md`).
 * En el repo del equipo devuelve siempre `[]`, aunque falte alguno: ahí la suite lo tiene que ver en rojo.
 */
function absentReviewers(names) {
  if (!SKIP_PUBLIC) return [];
  return names.filter((name) => !fs.existsSync(path.join(AGENTS_DIR, `${name}.md`)));
}

module.exports = { SKIP_PUBLIC, CLIENT_PACK_REVIEWER_COUNT, packReviewers, absentReviewers };
