'use strict';
/**
 * resume-state.js — lo que tiene que estar en disco antes de cada punto de control del pipeline, y el aviso de
 * cerrar la sesión al terminar la historia.
 *
 * Una ejecución real costó US$ 82, y 48 se fueron en releer la conversación entera en cada turno. Lo barato: que la
 * ejecución se pueda retomar en una sesión nueva sin perder nada (las condiciones que puso el dev al pedirla y lo que
 * devolvió cada revisor, en disco antes de «Aprobar el plan» y de «Hallazgos»), y que la sesión se cierre al terminar
 * la historia en lugar de arrastrar su conversación a la siguiente.
 *
 *   faltantes({ marker, paso, lanzados, existe }) → [{ que, comando? }]: lo que falta en disco al llegar a ese paso.
 *   lanzadosDe({ lineas, marker })               → los revisores que esta ejecución lanzó en «Revisores».
 *   CIERRE_DE_SESION                             → la línea que imprime el cierre de la historia.
 */

const path = require('path');

// los pasos donde la ejecución espera a una persona: ahí se corta una sesión, y ahí tiene que estar todo en disco
const PUNTOS_DE_CONTROL = new Set(['approve-plan', 'findings']);
// los agentes sueltos (los mismos que cuenta on-advisor-run.js): no son revisores y no dejan informe
const SUELTOS = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
const CARPETA_DE_INFORMES = 'step-05-advisor-reports';

const CIERRE_DE_SESION = 'La historia terminó: cerrá esta sesión. La próxima historia va en una sesión nueva (o tras /clear): '
  + 'releer esta conversación en cada turno cuesta más que todo lo demás, y el estado vive en disco, no acá.';

/**
 * Los revisores que esta ejecución lanzó en «Revisores» (renglones del registro de la sesión, de esta historia y desde su
 * arranque), sin repetir. Cuenta sólo los que nombra el set esperado de alguna marca `step5-start` (la que anota
 * `pipeline.js advisors`): el validador de la historia, la revisión previa y los demás agentes de otros pasos no dejan
 * informe en la carpeta de los revisores. Sin ninguna marca, la ejecución todavía no lanzó revisores.
 */
function lanzadosDe({ lineas = [], marker = {} } = {}) {
  const desde = Date.parse(marker.startedAt || '');
  const esperados = new Set();
  const vistos = new Set();
  for (const l of lineas) {
    let r;
    try { r = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (Number.isFinite(desde) && Number.isFinite(Date.parse(r.ts || '')) && Date.parse(r.ts) < desde) continue;
    if (r.event === 'step5-start') {
      for (const a of Array.isArray(r.expected) ? r.expected : []) if (typeof a === 'string') esperados.add(a);
      continue;
    }
    if (typeof r.advisor !== 'string' || SUELTOS.has(r.advisor)) continue;
    if (marker.storyId && r.story != null && String(r.story) !== String(marker.storyId)) continue;
    vistos.add(r.advisor);
  }
  return [...vistos].filter((a) => esperados.has(a));
}

/**
 * Lo que falta en disco al llegar a `paso`: `[]` fuera de un punto de control. Las condiciones del pedido se anotan una
 * vez (`marker.js conditions`, también «ninguna»); en «Hallazgos», cada revisor lanzado tiene que tener su informe en
 * `<runDir>/step-05-advisor-reports/<revisor>.md`. `existe` se inyecta en las pruebas.
 */
function faltantes({ marker, paso, lanzados = [], existe = require('fs').existsSync } = {}) {
  if (!marker || !PUNTOS_DE_CONTROL.has(paso)) return [];
  const out = [];
  const c = marker.requestConditions;
  if (!c || typeof c.texto !== 'string' || !c.texto.trim()) {
    out.push({ que: 'las condiciones que puso el dev al pedir la historia (qué no hacer, qué esperar, a quién preguntar)', comando: 'marker.js conditions "<las condiciones, o ninguna>"' });
  }
  if (paso === 'findings') {
    if (!marker.runDir) {
      if (lanzados.length) out.push({ que: `los informes de ${lanzados.length} revisor(es): la ejecución no tiene carpeta`, comando: 'pipeline.js run-dir --story <s> --repo <r> --create' });
    } else {
      for (const a of lanzados) {
        const f = path.join(marker.runDir, CARPETA_DE_INFORMES, `${a}.md`);
        if (!existe(f)) out.push({ que: `el informe de ${a} (${f})` });
      }
    }
  }
  return out;
}

/** El texto del aviso para `next`: una línea, o null si no falta nada. */
function aviso(falta) {
  if (!falta || !falta.length) return null;
  return `Antes de este punto de control, dejá en disco: ${falta.map((f) => (f.comando ? `${f.que} — ${f.comando}` : f.que)).join(' · ')}. Así la ejecución se retoma en una sesión nueva sin releer esta conversación.`;
}

module.exports = { faltantes, lanzadosDe, aviso, CIERRE_DE_SESION, PUNTOS_DE_CONTROL, CARPETA_DE_INFORMES };
