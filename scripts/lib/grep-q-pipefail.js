'use strict';
// grep-q-pipefail.js — la regla «ningún guion con pipefail pasa una tubería a `grep -q`», en un solo lugar.
//
// La usan dos: la prueba que mira el repo entero (scripts/tests/grep-q-pipefail.test.js) y el freno de antes del commit
// (scripts/ci/check-staged-ci-rules.js), que mira sólo lo que el commit trae. Por qué existe la regla: la cabecera de la
// prueba. Arreglo: `| grep … >/dev/null` (sin -q, grep lee hasta el final y no corta la tubería).

// Lo que se mira: los .sh de scripts/ y skills/, sin node_modules ni carpetas que empiezan con punto.
const FOLDERS = ['scripts', 'skills'];
const PIPE_INTO_GREP_Q = /(^|[^|])\|(?!\|)\s*grep\s+-[A-Za-z]*q/;
const FIX = 'cambiala a `| grep … >/dev/null` (sin -q, grep lee todo y no corta la tubería)';

/** ¿La regla mira esta ruta? (relativa a la raíz, con `/`) */
function inScope(rel) {
  const parts = rel.split('/');
  if (!FOLDERS.includes(parts[0]) || !rel.endsWith('.sh')) return false;
  return !parts.some((p) => p === 'node_modules' || p.startsWith('.'));
}

function hasPipefail(text) { return /pipefail/.test(text); }

/** Los renglones de código (no comentarios) con una tubería a `grep -q`: [{ line, text }]. */
function findings(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    if (PIPE_INTO_GREP_Q.test(l)) out.push({ line: i + 1, text: l.trim().slice(0, 160) });
  });
  return out;
}

module.exports = { FOLDERS, PIPE_INTO_GREP_Q, FIX, inScope, hasPipefail, findings };
