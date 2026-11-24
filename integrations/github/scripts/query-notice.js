'use strict';
/**
 * query-notice.js — lo de GitHub del aviso de consultas fallidas (scripts/hooks/failed-query-notice.js): qué comando
 * `gh` es una consulta. `gh api` sin método de escritura ni campos, y `gh <grupo> list|view|status|checks|diff|watch|
 * search`; lo demás (crear, mergear, `gh api -X POST`) no.
 */
const programas = ['gh'];
const LEE = new Set(['list', 'view', 'status', 'checks', 'diff', 'watch', 'search']);

/** 'consulta' u 'otro', con las palabras sin opciones del comando (`pos`) y el segmento sin prefijos (`limpio`). */
function clasificar({ pos, limpio }) {
  if (pos[0] === 'api') return /(?:^|\s)(?:-X|--method)\s+(?!GET\b)|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/.test(limpio) ? 'otro' : 'consulta';
  return pos.length >= 2 && LEE.has(pos[1]) ? 'consulta' : 'otro';
}

module.exports = { programas, clasificar };
