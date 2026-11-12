'use strict';
// hidden-window-scan.js — encuentra cada lanzamiento de un proceso (child_process) en el texto de un guion y dice si sus
// opciones piden la ventana oculta en Windows.
//
// Por qué: en Windows, un proceso sin consola que lanza un programa de consola sin `windowsHide` le abre una ventana
// visible. Los ganchos pueden correr sin consola, y entonces cada git que lanzan es una ventana. La opción tiene que ir
// en el objeto de opciones de la llamada misma: dentro de otro objeto (como `env`) no vale.
//
// Qué reconoce como lanzamiento:
//   · la función desestructurada: `const { spawnSync } = require('child_process')`, también con otro nombre, en
//     cualquier lugar de una declaración con varias variables, o desde el módulo ya guardado (`const { spawnSync } = cp`);
//   · la función tomada como valor: `const sp = opts.spawnSync || require('child_process').spawnSync`, también como
//     valor por defecto de un parámetro (`function f({ spawnSync = require('child_process').spawnSync } = {})`);
//   · el módulo en una variable: `const cp = require('child_process')` y después `cp.spawnSync(…)`;
//   · `import { spawnSync } from 'child_process'` e `import * as cp from 'child_process'`;
//   · la versión con promesa (`const run = promisify(exec)`), y la llamada con `?.`, `.call(…)` o `.apply(…)`;
//   · `require('child_process').spawnSync(…)` y `node:child_process`.
// No cuenta un comentario, `regex.exec(…)`, un método que se llama igual (`exec(sql) { … }`) ni un lanzamiento escrito
// dentro de un texto (comillas o plantilla, también anidada en un `${…}`): ése es el código de otro guion, que se
// escribe a un archivo o se le pasa a `node -e`. Lo que no es código (textos, comentarios, expresiones regulares)
// tampoco cuenta al buscar el paréntesis que cierra, al separar los argumentos ni al leer las opciones.
const fs = require('fs');
const path = require('path');

const FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const FN = FUNCTIONS.join('|');
const MODULE = `(?:require|(?:await\\s+)?import)\\(\\s*['"](?:node:)?child_process['"]\\s*\\)`;
const ESM_SOURCE = `from\\s*['"](?:node:)?child_process['"]`;
const NAME = '[A-Za-z_$][\\w$]*';

/** Desde el paréntesis que abre en `open`, el índice del que lo cierra (salta lo que no es código). -1 si no cierra. */
function closing(text, open, mask = nonCodeMask(text)) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (mask[i]) continue;
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Los argumentos de primer nivel entre `from` y `to` de `text`, como [inicio, fin], sin lo que no es código en los bordes. */
function splitArgs(text, mask, from, to) {
  const out = []; let depth = 0; let start = from;
  for (let i = from; i < to; i++) {
    if (mask[i]) continue;
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  out.push([start, to]);
  const blank = (i) => mask[i] || /\s/.test(text[i]);
  return out.map(([a, b]) => {
    while (a < b && blank(a)) a++;
    while (b > a && blank(b - 1)) b--;
    return [a, b];
  }).filter(([a, b]) => b > a);
}

/** El estado del objeto literal entre `from` y `to`: lo que pide `windowsHide` en su primer nivel. */
function objectState(call, mask, from, to) {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (mask[i]) continue;
    const c = call[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 1) {
      const m = /^windowsHide\s*:\s*(true|false)\b/.exec(call.slice(i, to));
      if (m && /[{,\s]/.test(call[i - 1])) return m[1] === 'true' ? 'hidden' : 'shown';
    }
  }
  return 'missing';
}

/** Las ramas de `cond ? a : b` entre `from` y `to` (cada una sin bordes), o null si el argumento no es un condicional. */
function ternaryBranches(call, mask, from, to) {
  let depth = 0; let q = -1; let nested = 0;
  for (let i = from; i < to; i++) {
    if (mask[i]) continue;
    const c = call[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && call[i + 1] !== '.' && call[i + 1] !== '?' && call[i - 1] !== '?') {
      if (q < 0) q = i; else nested++;
    } else if (depth === 0 && c === ':' && q >= 0) {
      if (nested) { nested--; continue; }
      return splitArgs(call, mask, q + 1, i).concat(splitArgs(call, mask, i + 1, to));
    }
  }
  return null;
}

/**
 * `'hidden'` si el objeto de opciones de la llamada (el último argumento que es un objeto literal, o un condicional
 * entre dos) pide `windowsHide: true` en su primer nivel, `'shown'` si pide `windowsHide: false`, `'missing'` si no la
 * pide. Un condicional vale `'hidden'` sólo si sus dos ramas lo piden. `open` es el índice del paréntesis de la llamada
 * dentro de `call` (por defecto, el primero).
 */
function windowState(call, open = call.indexOf('(')) {
  const mask = nonCodeMask(call);
  const options = [];
  for (const [a, b] of splitArgs(call, mask, open + 1, call.lastIndexOf(')'))) {
    if (call[a] === '{') { options.push([[a, b]]); continue; }
    const branches = ternaryBranches(call, mask, a, b);
    if (branches && branches.length === 2 && branches.every(([x]) => call[x] === '{')) options.push(branches);
  }
  if (!options.length) return 'missing';
  const states = options[options.length - 1].map(([a, b]) => objectState(call, mask, a, b));
  if (states.includes('shown')) return 'shown';
  return states.every((s) => s === 'hidden') ? 'hidden' : 'missing';
}

/** El nombre de la función declarada más cercana antes de `index` (`function nombre(`), o null. */
function enclosingFunction(text, index) {
  const all = [...text.slice(0, index).matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * Las zonas de texto que no son código: cadenas ('…', "…", `…`, con el código de cada `${…}` como código) y comentarios.
 * Devuelve una bandera por carácter: 1 = no es código. Una expresión regular literal tampoco es código: sus comillas no
 * abren un texto y sus paréntesis no cuentan.
 */
function nonCodeMask(text) {
  const mask = new Uint8Array(text.length);
  // una pila de marcos: 'code' (con su profundidad de llaves) o 'template'; el código de un `${…}` es un marco 'code'
  const stack = [{ kind: 'code', depth: 0 }];
  let prev = '';   // el último carácter de código que no es espacio: decide si una `/` abre una expresión regular
  let i = 0;
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const c = text[i];
    const n = text[i + 1];
    if (top.kind === 'template') {
      mask[i] = 1;
      if (c === '\\') { if (i + 1 < text.length) mask[i + 1] = 1; i += 2; continue; }
      if (c === '`') { stack.pop(); prev = '`'; i++; continue; }
      if (c === '$' && n === '{') { mask[i + 1] = 1; stack.push({ kind: 'code', depth: 0 }); prev = '{'; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); const stop = e < 0 ? text.length : e; mask.fill(1, i, stop); i = stop; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); const stop = e < 0 ? text.length : e + 2; mask.fill(1, i, stop); i = stop; continue; }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\b(return|typeof|case|in|of)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1; let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true; else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      mask.fill(1, i, Math.min(j + 1, text.length)); i = j + 1; prev = '/'; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      mask.fill(1, i, Math.min(j + 1, text.length)); i = j + 1; prev = c; continue;
    }
    if (c === '`') { mask[i] = 1; stack.push({ kind: 'template' }); i++; continue; }
    if (c === '{') top.depth++;
    else if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { mask[i] = 1; stack.pop(); i++; continue; }
      top.depth--;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return mask;
}

/** Cada lanzamiento del texto: `[{ line, fn, call, start, open, end, state, inFunction }]`. */
function findLaunches(text) {
  if (!/child_process/.test(text)) return [];
  const mask = nonCodeMask(text);
  // sólo cuenta lo que está en el código: el mismo texto dentro de una cadena es el código de otro guion
  const inCode = (re) => [...text.matchAll(new RegExp(re, 'g'))].filter((m) => !mask[m.index]);
  const names = new Set(); const modules = new Set();
  // `{ spawnSync, execFile: ef }` o `{ spawnSync as run }`: el nombre con que queda cada función de lanzamiento
  const addNames = (list, alias) => {
    for (const part of list.split(',')) {
      const [from, to] = part.split(alias).map((s) => s.trim());
      if (FUNCTIONS.includes(from)) names.add(to || from);
    }
  };
  for (const m of inCode(`\\{([^{}]*)\\}\\s*=\\s*${MODULE}`)) addNames(m[1], ':');
  for (const m of inCode(`\\bimport\\s*\\{([^{}]*)\\}\\s*${ESM_SOURCE}`)) addNames(m[1], /\s+as\s+/);
  for (const m of inCode(`(?<![.\\w$])(${NAME})\\s*=\\s*${MODULE}(?!\\s*\\.)`)) modules.add(m[1]);
  for (const m of inCode(`\\bimport\\s+(?:\\*\\s*as\\s+)?(${NAME})\\s+${ESM_SOURCE}`)) modules.add(m[1]);
  const moduleNames = [...modules].join('|');
  if (modules.size) for (const m of inCode(`\\{([^{}]*)\\}\\s*=\\s*(?:${moduleNames})\\b(?!\\s*[.(\\[])`)) addNames(m[1], ':');
  const owner = `(?:${MODULE}${modules.size ? `|(?<![.\\w$])(?:${moduleNames})\\b` : ''})`;
  // la función tomada como valor, sin llamarla: `const sp = x || require('child_process').spawnSync;`, o el valor por
  // defecto de un parámetro, `{ spawnSync = require('child_process').spawnSync } = {}`
  const dot = '\\s*\\??\\.\\s*';
  for (const m of inCode(`(?<![.\\w$])(${NAME})\\s*=(?!=)[^;\\n,]*?${owner}${dot}(?:${FN})\\b(?!\\s*\\()`)) names.add(m[1]);
  // otro nombre para una función ya conocida: `const run = spawnSync`, `{ run = opts.run || spawnSync } = {}`, y su
  // versión con promesa: `const run = promisify(exec)` o `promisify(cp.execFile)`
  for (let before = -1; names.size !== before;) {
    before = names.size;
    const known = names.size ? `|(?<![.\\w$])(?:${[...names].join('|')})\\b` : '';
    for (const m of inCode(`(?<![.\\w$])(${NAME})\\s*=(?!=)[^;\\n,=]*?\\bpromisify\\(\\s*(?:${owner}${dot}(?:${FN})\\b${known})\\s*\\)`)) names.add(m[1]);
    if (names.size) for (const m of inCode(`(?<![.\\w$])(${NAME})\\s*=(?!=)[^;\\n,=(]*?(?<![.\\w$])(?:${[...names].join('|')})\\b(?!\\s*[.(\\[:])`)) names.add(m[1]);
  }
  // la llamada, también con `?.` y con `.call(…)` o `.apply(…)`
  const how = '(?:\\s*\\.\\s*(?:call|apply))?';
  const callee = `(?:${owner}${dot}(${FN})${names.size ? `|(?<![.\\w$])(${[...names].join('|')})` : ''})${how}\\s*\\(`;
  const out = [];
  for (const m of inCode(callee)) {
    const open = m.index + m[0].length - 1;
    const end = closing(text, open, mask);
    if (end < 0) continue;
    // `exec(sql) { … }`: un método o una función que se llama igual, no una llamada
    if (/^\s*\{/.test(text.slice(end + 1, end + 40))) continue;
    const call = text.slice(m.index, end + 1);
    out.push({
      line: text.slice(0, m.index).split('\n').length,
      fn: m[1] || m[2],
      call,
      start: m.index,
      open,
      end,
      state: windowState(call, open - m.index),
      inFunction: enclosingFunction(text, m.index),
    });
  }
  return out;
}

/** ¿El código (no un texto ni un comentario) carga el módulo `child_process`, con `require`, `import(…)` o `from`? */
function usesChildProcess(text) {
  if (!/child_process/.test(text)) return false;
  const mask = nonCodeMask(text);
  const loads = /\b(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]|\bfrom\s*['"](?:node:)?child_process['"]/g;
  return [...text.matchAll(loads)].some((m) => !mask[m.index]);
}

/**
 * ¿Es un atajo de nombre viejo? Lo escribe `scripts/lib/legacy-names.js --write-shims`, igual a su plantilla (una prueba
 * lo exige), y vive sólo en el repo privado de quien mantiene: no se edita a mano ni se escanea como código propio.
 */
const isLegacyShim = (text) => /^\/\/ tycon-legacy-shim: /m.test(text.slice(0, 300));

/** Los guiones de las carpetas `dirs` (relativas a `root`), sin pruebas ni lo que empieza con una ruta de `skip`. */
function scriptFiles(root, dirs, skip = []) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const r = path.posix.join(rel, e.name);
      if (skip.some((s) => r === s || r.startsWith(`${s}/`))) continue;
      if (e.isDirectory()) {
        if (['node_modules', 'tests', 'test', '__tests__'].includes(e.name)) continue;
        walk(r);
      } else if (/\.(c|m)?js$/.test(e.name) && !/\.test\.(c|m)?js$/.test(e.name)) out.push(r);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

/** Cada lanzamiento de esas carpetas, con su archivo (sin los atajos de nombres viejos). */
function scanTree(root, dirs, skip = []) {
  const out = [];
  for (const file of scriptFiles(root, dirs, skip)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (isLegacyShim(text)) continue;
    for (const l of findLaunches(text)) out.push({ file, ...l });
  }
  return out;
}

module.exports = { FUNCTIONS, findLaunches, windowState, scanTree, scriptFiles, isLegacyShim, usesChildProcess };
