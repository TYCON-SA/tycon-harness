'use strict';
/**
 * validator-verdict.js — el renglón `Veredicto:` con que el validador de stories cierra cada informe.
 *
 * Por qué existe: qué encontró cada lanzamiento de `tycon-story-validator` sólo se sabe leyendo su
 * informe con un modelo. Sin un renglón legible
 * por una máquina, lo que encuentra en cada fase no deja rastro, y el pipeline no puede saber en el
 * momento si sus dos últimas validaciones salieron limpias.
 *
 * Contrato del renglón (lo escribe el agente; `agents/tycon-story-validator.md`):
 *   Veredicto: limpio
 *   Veredicto: hallazgos (VAL-C8, VAL-W15) · bloquea: sí
 *
 * 🔴 Nunca se infiere «limpio» de la prosa: sin renglón es `sin_veredicto`, y eso no es limpio.
 * 🔴 Gana el ÚLTIMO renglón: un informe puede citar el formato más arriba.
 * 🔴 `limpio` con un identificador de regla es `inconsistente`: el informe dice dos cosas.
 *
 * Consumidores: `scripts/metrics/reviewers-cost.js` (constancia por lanzamiento y por fase, y la
 * decisión de los re-loops en `pipeline.js` de agent-skills) y `scripts/controls-bench/advisor-runner.js`
 * (`expect_veredicto`). Un solo parse: dos copias se separan solas.
 */

const RENGLON = /^[\s>]*[*_`]*\s*veredicto\s*[*_`]*\s*:\s*[*_`]*\s*(.*)$/i;
// las del validador y las del revisor de historias (`agents/tycon-story-adversarial-reviewer.md`), que cierra igual
const REGLA = /\b(?:VAL|SADV)-[CW]\d+\b/gi;

/** Minúsculas y sin tildes, para comparar palabras sin depender de cómo se tipearon. */
function plano(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Lee el veredicto de un informe.
 * @param {string} texto
 * @returns {{ estado: 'limpio'|'hallazgos'|'inconsistente'|'sin_veredicto', reglas: string[], bloquea: boolean|null }}
 */
function veredictoDe(texto) {
  if (typeof texto !== 'string' || !texto) return { estado: 'sin_veredicto', reglas: [], bloquea: null };
  let ultimo = null;
  for (const renglon of texto.split(/\r?\n/)) {
    const m = renglon.match(RENGLON);
    if (m) ultimo = m[1];
  }
  if (ultimo === null) return { estado: 'sin_veredicto', reglas: [], bloquea: null };
  const reglas = [...new Set((ultimo.match(REGLA) || []).map((r) => r.toUpperCase()))];
  const valor = plano(ultimo).replace(/[*_`]/g, '').trim();
  if (/^limpio\b/.test(valor)) {
    return reglas.length
      ? { estado: 'inconsistente', reglas, bloquea: null }
      : { estado: 'limpio', reglas: [], bloquea: false };
  }
  if (/^hallazgos\b/.test(valor)) {
    const b = valor.match(/bloquea\s*:\s*(si|no)\b/);
    return { estado: 'hallazgos', reglas, bloquea: b ? b[1] === 'si' : null };
  }
  return { estado: 'inconsistente', reglas, bloquea: null };
}

module.exports = { veredictoDe };
