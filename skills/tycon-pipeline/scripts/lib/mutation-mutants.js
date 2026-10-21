'use strict';
/**
 * lib/mutation-mutants.js — generación PURA de mutantes candidatos (sin fs, sin exec).
 *
 * Parte del CHEQUEO DE MUTANTES del harness TYCON: una suite en
 * verde NO prueba que los tests ejerzan el código nuevo — un test puede
 * pasar sin probar nada. Este módulo, dado el texto de un archivo y el conjunto
 * de líneas AGREGADAS, devuelve la lista ordenada y DETERMINÍSTICA de mutantes
 * chicos y seguros. El runner (scripts/mutation-check.js) los aplica uno por uno
 * y verifica que algún test se ponga rojo.
 *
 * Operadores (orden FIJO — el orden de salida es parte del contrato):
 *   1. ===  → !==            5. >=  → >
 *   2. !==  → ===            6. <=  → <
 *   3. &&   → ||             7. return true  → return false
 *   4. ||   → &&             8. return false → return true
 *   9. if (X) → if (!(X))    (sólo si el paréntesis abre y cierra en la misma línea)
 *
 * Reglas de seguridad:
 *   - Sólo líneas AGREGADAS (las declara el llamador; acá no hay git).
 *   - Se saltean líneas de comentario (trim arranca con `//`, `*` o `/*`).
 *   - No se muta dentro de string literals ('…', "…", `…`) ni después de un
 *     `//` inline — aproximación BEST-EFFORT por línea (ver Límites).
 *   - Un mutante por (línea, operador): la PRIMERA ocurrencia elegible.
 *   - Nada de Math.random ni Date.now: mismo input → misma salida, siempre.
 *
 * Límites conocidos (documentados a propósito):
 *   - La máscara de strings es POR LÍNEA: un template literal o un comentario
 *     de bloque que abre en una línea y cierra en otra no se rastrea entre
 *     líneas (la heurística `trim arranca con *` cubre el cuerpo típico de un
 *     bloque JSDoc). Falso negativo posible → un mutante de menos, nunca un
 *     archivo corrupto.
 *   - `${…}` dentro de un template literal se trata como string (no se muta).
 *   - `return true` exige exactamente un espacio (la forma normal del código).
 */

// Orden fijo del catálogo de operadores — parte del contrato de determinismo.
const OPERATOR_ORDER = [
  'eq-a-neq',
  'neq-a-eq',
  'and-a-or',
  'or-a-and',
  'gte-a-gt',
  'lte-a-lt',
  'return-true-a-false',
  'return-false-a-true',
  'negar-if',
];

// ── Máscara de código ────────────────────────────────────────────────────────
// mask[i] = true ⇔ el carácter i es CÓDIGO (fuera de strings y de comentarios).
// Best-effort por línea: no rastrea strings/comentarios multilínea.
function codeMask(line) {
  const mask = new Array(line.length).fill(true);
  let quote = null; // ', " o ` si estamos dentro de un string
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      mask[i] = false;
      if (ch === '\\') { // el escapado tampoco es código
        if (i + 1 < line.length) { mask[i + 1] = false; i++; }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; mask[i] = false; continue; }
    if (ch === '/' && line[i + 1] === '/') { // comentario inline: el resto no es código
      for (let j = i; j < line.length; j++) mask[j] = false;
      break;
    }
    if (ch === '/' && line[i + 1] === '*') { // /* … */ dentro de la línea (o hasta el final)
      const end = line.indexOf('*/', i + 2);
      const stop = end === -1 ? line.length : end + 2;
      for (let j = i; j < stop; j++) mask[j] = false;
      i = stop - 1;
    }
  }
  return mask;
}

// Primera ocurrencia de `token` cuyo span completo es código y pasa las guardas.
function findCodeToken(line, mask, token, { prevNot = [], nextNot = [], word = false } = {}) {
  for (let i = line.indexOf(token); i !== -1; i = line.indexOf(token, i + 1)) {
    let esCodigo = true;
    for (let j = i; j < i + token.length; j++) {
      if (!mask[j]) { esCodigo = false; break; }
    }
    if (!esCodigo) continue;
    const prev = i > 0 ? line[i - 1] : '';
    const next = i + token.length < line.length ? line[i + token.length] : '';
    if (prevNot.includes(prev) || nextNot.includes(next)) continue;
    if (word && (/\w/.test(prev) || /\w/.test(next))) continue;
    return i;
  }
  return -1;
}

// token → reemplazo, con guardas de vecindad para no partir operadores más largos.
function tokenSwap(token, repl, guards) {
  return (line, mask) => {
    const i = findCodeToken(line, mask, token, guards);
    if (i === -1) return null;
    return line.slice(0, i) + repl + line.slice(i + token.length);
  };
}

// if (X) → if (!(X)) — sólo si el paréntesis abre Y cierra en la misma línea.
function negarIf(line, mask) {
  for (let i = line.indexOf('if'); i !== -1; i = line.indexOf('if', i + 1)) {
    if (!mask[i] || !mask[i + 1]) continue;
    const prev = i > 0 ? line[i - 1] : '';
    if (/\w/.test(prev)) continue; // 'gif', 'elif', etc.
    // Saltear espacios hasta el '('
    let j = i + 2;
    while (j < line.length && /\s/.test(line[j])) j++;
    if (line[j] !== '(' || !mask[j]) continue;
    const open = j;
    // Balancear paréntesis contando SOLO los que son código.
    let depth = 1;
    let close = -1;
    for (let k = open + 1; k < line.length; k++) {
      if (!mask[k]) continue;
      if (line[k] === '(') depth++;
      else if (line[k] === ')') {
        depth--;
        if (depth === 0) { close = k; break; }
      }
    }
    if (close === -1) return null; // el if sigue en otra línea → no se muta
    const inner = line.slice(open + 1, close);
    if (inner.trim() === '') return null;
    return `${line.slice(0, open + 1)}!(${inner})${line.slice(close)}`;
  }
  return null;
}

// Catálogo, en el MISMO orden que OPERATOR_ORDER.
const OPERATORS = [
  // `===` — guardas: no dentro de `!==`/`====` (inválidos igual, pero fail-closed).
  { id: 'eq-a-neq', mutate: tokenSwap('===', '!==', { prevNot: ['!', '='], nextNot: ['='] }) },
  { id: 'neq-a-eq', mutate: tokenSwap('!==', '===', { nextNot: ['='] }) },
  // `&&`/`||` — no partir `&&&`/`|||` (inválidos) ni matchear `&`/`|` bitwise (el token ya lo evita).
  { id: 'and-a-or', mutate: tokenSwap('&&', '||', { prevNot: ['&'], nextNot: ['&'] }) },
  { id: 'or-a-and', mutate: tokenSwap('||', '&&', { prevNot: ['|'], nextNot: ['|'] }) },
  // `>=`/`<=` — no partir `>>=`/`<<=` ni `===`/`!==` (prev '='/'!').
  { id: 'gte-a-gt', mutate: tokenSwap('>=', '>', { prevNot: ['>', '<', '=', '!'], nextNot: ['='] }) },
  { id: 'lte-a-lt', mutate: tokenSwap('<=', '<', { prevNot: ['<', '=', '!'], nextNot: ['='] }) },
  { id: 'return-true-a-false', mutate: tokenSwap('return true', 'return false', { word: true }) },
  { id: 'return-false-a-true', mutate: tokenSwap('return false', 'return true', { word: true }) },
  { id: 'negar-if', mutate: negarIf },
];

// ── Generación ───────────────────────────────────────────────────────────────

/**
 * mutantsForFile({ file, source, addedLines }) → [{ file, line, operator, before, after }]
 * `line` es 1-based. `before`/`after` son la línea SIN el \r final (si lo hubiera);
 * applyMutant lo repone al escribir.
 */
function mutantsForFile({ file, source, addedLines }) {
  const added = new Set(addedLines || []);
  const lines = String(source == null ? '' : source).split('\n');
  const out = [];
  for (let ln = 1; ln <= lines.length; ln++) {
    if (!added.has(ln)) continue;
    let line = lines[ln - 1];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const trimmed = line.trimStart();
    // Líneas de comentario: no se mutan (incluye el cuerpo típico de un bloque JSDoc).
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const mask = codeMask(line);
    for (const op of OPERATORS) {
      const after = op.mutate(line, mask);
      if (after != null && after !== line) {
        out.push({ file, line: ln, operator: op.id, before: line, after });
      }
    }
  }
  return out;
}

/**
 * generateMutants(entries) — entries: [{ file, source, addedLines }].
 * Orden ESTABLE: archivo (alfabético), línea (ascendente), operador (orden fijo
 * del catálogo). El orden no depende del orden de entrada: mismo input, misma
 * salida, siempre — es lo que hace reproducible una corrida.
 */
function generateMutants(entries) {
  const sorted = (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const out = [];
  for (const e of sorted) out.push(...mutantsForFile(e));
  return out;
}

/**
 * applyMutant(source, mutant) → texto mutado, o null si la línea `mutant.line`
 * no coincide byte a byte con `mutant.before` (fail-closed: si el archivo
 * cambió desde que se generó el mutante, NO se escribe nada).
 * Preserva el \r final de la línea (archivos CRLF).
 */
function applyMutant(source, mutant) {
  const lines = String(source == null ? '' : source).split('\n');
  const idx = mutant.line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  let actual = lines[idx];
  const teniaCR = actual.endsWith('\r');
  if (teniaCR) actual = actual.slice(0, -1);
  if (actual !== mutant.before) return null;
  lines[idx] = mutant.after + (teniaCR ? '\r' : '');
  return lines.join('\n');
}

module.exports = { generateMutants, mutantsForFile, applyMutant, codeMask, OPERATOR_ORDER };
