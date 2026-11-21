'use strict';
/**
 * lib/mutation-mutants-py.js — generación PURA de mutantes de Python (sin fs, sin exec), para el chequeo de mutantes.
 *
 * Misma forma que lib/mutation-mutants.js (el de JavaScript). Operadores, en orden FIJO:
 *   1. ==  → !=      5. >=  → >       9. return True  → return False
 *   2. !=  → ==      6. <=  → <      10. return False → return True
 *   3. and → or      7. >   → >=     11. if x:        → if not (x):
 *   4. or  → and     8. <   → <=
 *
 * `>` y `<` se mutan sólo con un espacio a cada lado (no se toca `->`). No se muta dentro de un texto (comillas
 * simples, dobles o triples en la misma línea), un comentario (`#`), un `import`/`from … import` ni un decorador.
 * Un texto de comillas triples que cruza líneas (un docstring) se sigue por todo el archivo: sus líneas de adentro
 * son texto.
 */

const { applyMutant } = require('./mutation-mutants.js');

const OPERATOR_ORDER = [
  'eq-a-neq', 'neq-a-eq', 'and-a-or', 'or-a-and', 'gte-a-gt', 'lte-a-lt', 'gt-a-gte', 'lt-a-lte',
  'return-true-a-false', 'return-false-a-true', 'negar-if',
];

// mask[i] = true ⇔ el carácter i es código. `abierto` es el texto de comillas triples que viene abierto de una línea
// anterior (o null); devuelve también el que queda abierto al final de la línea. Las comillas simples no cruzan líneas.
function escanear(line, abierto = null) {
  const mask = new Array(line.length).fill(true);
  let quote = abierto;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      mask[i] = false;
      if (ch === '\\') {
        if (i + 1 < line.length) { mask[i + 1] = false; i++; }
        continue;
      }
      if (line.startsWith(quote, i)) {
        for (let j = i; j < i + quote.length; j++) mask[j] = false;
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      for (let j = i; j < i + quote.length; j++) mask[j] = false;
      i += quote.length - 1;
      continue;
    }
    if (ch === '#') {
      for (let j = i; j < line.length; j++) mask[j] = false;
      break;
    }
  }
  return { mask, abierto: quote && quote.length === 3 ? quote : null };
}

const codeMask = (line) => escanear(line).mask;

// Una letra, un dígito o el guion bajo, en cualquier alfabeto: «señor» es una sola palabra.
const PALABRA = /[\p{L}\p{N}_]/u;

function findCodeToken(line, mask, token, { prevNot = [], nextNot = [], word = false, spaced = false } = {}) {
  for (let i = line.indexOf(token); i !== -1; i = line.indexOf(token, i + 1)) {
    let esCodigo = true;
    for (let j = i; j < i + token.length; j++) if (!mask[j]) { esCodigo = false; break; }
    if (!esCodigo) continue;
    const prev = i > 0 ? line[i - 1] : '';
    const next = i + token.length < line.length ? line[i + token.length] : '';
    if (prevNot.includes(prev) || nextNot.includes(next)) continue;
    if (word && (PALABRA.test(prev) || PALABRA.test(next))) continue;
    if (spaced && (prev !== ' ' || next !== ' ')) continue;
    return i;
  }
  return -1;
}

function tokenSwap(token, repl, guards) {
  return (line, mask) => {
    const i = findCodeToken(line, mask, token, guards);
    if (i === -1) return null;
    return line.slice(0, i) + repl + line.slice(i + token.length);
  };
}

// `if x:` → `if not (x):`, sólo si la condición y los dos puntos están en la misma línea y son código.
function negarIf(line, mask) {
  const m = line.match(/^(\s*)if\s+(.+?):(\s*(#.*)?)$/);
  if (!m) return null;
  const inicio = m[1].length;
  const finCond = line.length - m[3].length - 1; // el índice de los dos puntos
  if (!mask[inicio] || !mask[finCond]) return null;
  const cond = m[2].trim();
  if (!cond) return null;
  return `${m[1]}if not (${cond}):${m[3]}`;
}

const OPERATORS = [
  { id: 'eq-a-neq', mutate: tokenSwap('==', '!=', { prevNot: ['=', '!', '<', '>'], nextNot: ['='] }) },
  { id: 'neq-a-eq', mutate: tokenSwap('!=', '==', { nextNot: ['='] }) },
  { id: 'and-a-or', mutate: tokenSwap('and', 'or', { word: true }) },
  { id: 'or-a-and', mutate: tokenSwap('or', 'and', { word: true }) },
  { id: 'gte-a-gt', mutate: tokenSwap('>=', '>', { prevNot: ['>', '<', '=', '!'], nextNot: ['='] }) },
  { id: 'lte-a-lt', mutate: tokenSwap('<=', '<', { prevNot: ['<', '=', '!'], nextNot: ['='] }) },
  { id: 'gt-a-gte', mutate: tokenSwap('>', '>=', { spaced: true }) },
  { id: 'lt-a-lte', mutate: tokenSwap('<', '<=', { spaced: true }) },
  { id: 'return-true-a-false', mutate: tokenSwap('return True', 'return False', { word: true }) },
  { id: 'return-false-a-true', mutate: tokenSwap('return False', 'return True', { word: true }) },
  { id: 'negar-if', mutate: negarIf },
];

const LINEA_SIN_MUTAR = /^(#|import\b|from\s+\S+\s+import\b|@)/;

function mutantsForFile({ file, source, addedLines }) {
  const added = new Set(addedLines || []);
  const lines = String(source == null ? '' : source).split('\n');
  const out = [];
  // el texto de comillas triples abierto se sigue por TODO el archivo, también por las líneas que no se mutan
  let abierto = null;
  for (let ln = 1; ln <= lines.length; ln++) {
    let line = lines[ln - 1];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const venia = abierto;
    const { mask, abierto: queda } = escanear(line, abierto);
    abierto = queda;
    if (!added.has(ln)) continue;
    if (!venia && LINEA_SIN_MUTAR.test(line.trimStart())) continue;
    for (const op of OPERATORS) {
      const after = op.mutate(line, mask);
      if (after != null && after !== line) out.push({ file, line: ln, operator: op.id, before: line, after });
    }
  }
  return out;
}

/** Orden estable: archivo (alfabético), línea, operador. No depende del orden de entrada. */
function generateMutants(entries) {
  const sorted = (Array.isArray(entries) ? entries : []).slice()
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const out = [];
  for (const e of sorted) out.push(...mutantsForFile(e));
  return out;
}

module.exports = { generateMutants, mutantsForFile, applyMutant, codeMask, OPERATOR_ORDER };
