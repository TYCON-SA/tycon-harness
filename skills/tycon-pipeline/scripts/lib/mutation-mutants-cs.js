'use strict';
/**
 * lib/mutation-mutants-cs.js — generación PURA de mutantes de C# (sin fs, sin exec), para el chequeo de mutantes.
 *
 * Misma forma que lib/mutation-mutants.js (el de JavaScript): dado el texto de un archivo y sus líneas AGREGADAS,
 * devuelve la lista ordenada y determinística de mutantes chicos. El runner los aplica con `applyMutant` del de JS.
 *
 * Operadores (orden FIJO — el orden de salida es parte del contrato):
 *   1. ==  → !=      5. >=  → >       9. return true;  → return false;
 *   2. !=  → ==      6. <=  → <      10. return false; → return true;
 *   3. &&  → ||      7. >   → >=
 *   4. ||  → &&      8. <   → <=
 *
 * Los dos de borde (`>` y `<`) se mutan sólo con un espacio a cada lado: así no se rompen genéricos (`List<int>`) ni
 * lambdas (`=>`). Un mutante que no compila «moriría» en falso.
 *
 * No se muta: dentro de un texto ("…", @"…", '…'), un comentario (//, ///, /* … *\/) ni una línea de `using`,
 * `namespace` o un atributo (`[...]`), ni la definición de un operador (`operator ==`). Lo que cruza líneas —un
 * comentario de bloque, un texto @"…" o uno de tres comillas— se sigue por todo el archivo.
 */

const { applyMutant } = require('./mutation-mutants.js');

const OPERATOR_ORDER = [
  'eq-a-neq', 'neq-a-eq', 'and-a-or', 'or-a-and', 'gte-a-gt', 'lte-a-lt', 'gt-a-gte', 'lt-a-lte',
  'return-true-a-false', 'return-false-a-true',
];

// mask[i] = true ⇔ el carácter i es código (fuera de textos y comentarios). `abierto` es lo que viene abierto de una
// línea anterior y cruza líneas —un comentario de bloque (`/*`), un texto @"…" (`@"`) o uno de tres o más comillas
// (`"""`…)— o null; devuelve también lo que queda abierto al final de la línea.
function escanear(line, abierto = null) {
  const mask = new Array(line.length).fill(true);
  let estado = abierto;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (estado === '/*') {
      mask[i] = false;
      if (ch === '*' && line[i + 1] === '/') { mask[i + 1] = false; i++; estado = null; }
      continue;
    }
    if (estado === '@"') {
      mask[i] = false;
      if (ch === '"' && line[i + 1] === '"') { mask[i + 1] = false; i++; continue; }
      if (ch === '"') estado = null;
      continue;
    }
    if (estado && estado.startsWith('"""')) {
      mask[i] = false;
      if (line.startsWith(estado, i)) {
        for (let j = i; j < i + estado.length; j++) mask[j] = false;
        i += estado.length - 1;
        estado = null;
      }
      continue;
    }
    if (estado === '"' || estado === "'") {
      mask[i] = false;
      if (ch === '\\') { if (i + 1 < line.length) { mask[i + 1] = false; i++; } continue; }
      if (ch === estado) estado = null;
      continue;
    }
    if (ch === '"' && line.startsWith('"""', i)) {
      let n = 3;
      while (line[i + n] === '"') n++;
      estado = '"'.repeat(n);
      for (let j = i; j < i + n; j++) mask[j] = false;
      i += n - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const verbatim = ch === '"' && i > 0 && (line[i - 1] === '@' || (line[i - 1] === '$' && line[i - 2] === '@'));
      estado = verbatim ? '@"' : ch;
      mask[i] = false;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      for (let j = i; j < line.length; j++) mask[j] = false;
      break;
    }
    if (ch === '/' && line[i + 1] === '*') {
      mask[i] = false; mask[i + 1] = false; i++;
      estado = '/*';
    }
  }
  // un texto común sin cerrar no cruza líneas en C#: lo que queda abierto es sólo lo que sí las cruza
  return { mask, abierto: estado === '"' || estado === "'" ? null : estado };
}

const codeMask = (line) => escanear(line).mask;

// Una letra, un dígito o el guion bajo, en cualquier alfabeto.
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

const OPERATORS = [
  { id: 'eq-a-neq', mutate: tokenSwap('==', '!=', { prevNot: ['=', '!', '<', '>'], nextNot: ['='] }) },
  { id: 'neq-a-eq', mutate: tokenSwap('!=', '==', { nextNot: ['='] }) },
  { id: 'and-a-or', mutate: tokenSwap('&&', '||', { prevNot: ['&'], nextNot: ['&'] }) },
  { id: 'or-a-and', mutate: tokenSwap('||', '&&', { prevNot: ['|'], nextNot: ['|'] }) },
  { id: 'gte-a-gt', mutate: tokenSwap('>=', '>', { prevNot: ['>', '<', '=', '!'], nextNot: ['='] }) },
  { id: 'lte-a-lt', mutate: tokenSwap('<=', '<', { prevNot: ['<', '=', '!'], nextNot: ['='] }) },
  { id: 'gt-a-gte', mutate: tokenSwap('>', '>=', { spaced: true }) },
  { id: 'lt-a-lte', mutate: tokenSwap('<', '<=', { spaced: true }) },
  { id: 'return-true-a-false', mutate: tokenSwap('return true;', 'return false;', { word: true }) },
  { id: 'return-false-a-true', mutate: tokenSwap('return false;', 'return true;', { word: true }) },
];

// Líneas que no se mutan aunque sean nuevas: comentarios, `using`, `namespace` y atributos.
const LINEA_SIN_MUTAR = /^(\/\/|\/\*|\*|using\b|global\s+using\b|namespace\b|\[)/;
// La definición de un operador (`operator ==`): cambiarlo duplica la de `!=` y no compila; se saltea la línea.
const DEFINE_OPERADOR = /\boperator\s*[=!<>]/;

function mutantsForFile({ file, source, addedLines }) {
  const added = new Set(addedLines || []);
  const lines = String(source == null ? '' : source).split('\n');
  const out = [];
  // lo que cruza líneas (comentario de bloque, @"…", """…""") se sigue por TODO el archivo, también por las líneas
  // que no se mutan
  let abierto = null;
  for (let ln = 1; ln <= lines.length; ln++) {
    let line = lines[ln - 1];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const venia = abierto;
    const { mask, abierto: queda } = escanear(line, abierto);
    abierto = queda;
    if (!added.has(ln)) continue;
    if (!venia && LINEA_SIN_MUTAR.test(line.trimStart())) continue;
    if (DEFINE_OPERADOR.test(line)) continue;
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
