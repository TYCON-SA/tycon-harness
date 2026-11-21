'use strict';
/**
 * query-notice.js — lo de GitHub del aviso de consultas fallidas (scripts/hooks/failed-query-notice.js): qué comando
 * `gh` es una consulta. `gh api` sin método de escritura ni campos, `gh search …`, y `gh <grupo> list|view|status|checks|
 * diff|watch|search`; lo demás (crear, mergear, `gh api -X POST`) no.
 */
const programas = ['gh'];
const LEE = new Set(['list', 'view', 'status', 'checks', 'diff', 'watch', 'search']);
// las opciones que pueden ir antes del grupo y llevan valor (`gh -R o/r pr list`)
const conValor = new Set(['-R', '--repo']);
// un método que no es GET, con espacio, con «=» o pegado (`-X POST`, `--method=POST`, `-XPOST`), o campos que se mandan
const ESCRIBE_API = /(?:^|\s)(?:-X\s*|--method[=\s]\s*)['"]?(?!GET\b)[A-Za-z]|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/i;

/** 'consulta' u 'otro', con el grupo y el verbo del comando (`pos`) y el segmento sin prefijos (`limpio`). */
function clasificar({ pos, limpio }) {
  if (pos[0] === 'api') return ESCRIBE_API.test(limpio) ? 'otro' : 'consulta';
  if (pos[0] === 'search') return 'consulta';
  return pos.length >= 2 && LEE.has(pos[1]) ? 'consulta' : 'otro';
}

module.exports = { programas, conValor, clasificar };
