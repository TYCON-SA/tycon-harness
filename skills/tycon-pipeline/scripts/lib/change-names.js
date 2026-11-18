'use strict';
/**
 * change-names.js — los nombres de lo que cambió dentro de un archivo: las funciones y los subcomandos que ENCIERRAN
 * cada renglón agregado o cambiado desde una base de git.
 *
 * Lo usa el portón acotado por el repo (run-suites-json.js) con una pieza central —un archivo que nombran decenas de
 * suites—: corre sólo las suites que nombran lo que cambió adentro. Por eso nunca devuelve una lista vacía como
 * conocida: ante la duda, `{ known: false, reason }`, y el portón corre todas las que nombran el archivo.
 *
 * Encerrar es por las llaves, no por cercanía: una función de una línea o una que ya se cerró arriba del renglón no lo
 * encierra. Por cada renglón se sube bloque por bloque y se junta, de adentro hacia afuera:
 *   · el nombre de cada función que lo encierra: `function x(`, `const x = (…) =>`, `x(…) {` (método), `x: function`
 *     o, en un guion de shell, `x() {`;
 *   · el subcomando: un `case 'x':` del mismo bloque, o un bloque `if (cmd === 'x') {` (también `|| cmd === 'y'`).
 * Las suites nombran el subcomando, no la función que lo implementa: por cada función juntada se suman también los
 * nombres que encierran cada lugar que la llama (`case 'adhoc': cmdAdhoc(…)` → `adhoc`), hasta dos saltos. `main`, el
 * despacho, no cuenta cuando ya hay un subcomando: casi toda suite nombra «main».
 * Un renglón que nada encierra, o un archivo cuyas llaves no cierran, es «no sé».
 * Un tramo que sólo borra cuenta por el renglón de al lado que quedó en el archivo nuevo.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Un identificador de JavaScript, también con letras fuera del ASCII (`naïveSort`, `avisoDeLoQueContó`).
const ID = '[\\p{L}_$][\\p{L}\\p{N}_$]*';
const WORD = '[\\p{L}\\p{N}_$]';
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'finally']);
// Los parámetros de una flecha pueden traer paréntesis adentro (`(keep = new Set()) =>`), o seguir en el renglón de abajo.
const ARROW = `(?:\\(.*\\)\\s*=>|\\([^)]*$|${ID}\\s*=>)`;
const JS_FN = [
  new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*\\(`, 'u'),
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s+)?(?:function\\b|${ARROW})`, 'u'),
  new RegExp(`^\\s*(${ID})\\s*:\\s*(?:async\\s+)?(?:function\\b|${ARROW})`, 'u'),
  new RegExp(`^\\s*(?:static\\s+)?(?:async\\s+)?(${ID})\\s*\\([^)]*\\)\\s*\\{`, 'u'),
];
const SH_FN = [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/, /^\s*function\s+([A-Za-z_][\w-]*)\s*\{/];
const CASE = /^\s*case\s+(['"`])([^'"`]+)\1\s*:/;
const IF_LABEL = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;
const EQ_LIT = new RegExp(`${ID}(?:\\.${ID}|\\[\\d+\\])*\\s*===?\\s*(['"\`])([^'"\`]+)\\1`, 'gu');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

/**
 * Las llaves de código de cada renglón, en orden (`'{'`/`'}'`), sin las de strings, comentarios, expresiones regulares
 * ni `${…}` de una plantilla. `ok: false` si no cierran (quedan abiertas al final o se cierra una que no se abrió).
 */
function bracesJs(lines) {
  const out = lines.map(() => []);
  let st = 'code';
  const tpl = [];   // por cada `${` abierto, cuántas llaves de código lleva adentro
  let depth = 0;
  let prev = '';    // el último carácter significativo de código, para distinguir una expresión regular de una división
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (st === 'sq' || st === 'dq') st = 'code';   // un string de comillas simples o dobles no cruza el renglón
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (st === 'block') { if (ch === '*' && l[i + 1] === '/') { st = 'code'; i++; } continue; }
      if (st === 'sq' || st === 'dq') {
        if (ch === '\\') i++;
        else if ((st === 'sq' && ch === "'") || (st === 'dq' && ch === '"')) { st = 'code'; prev = 'a'; }
        continue;
      }
      if (st === 'tpl') {
        if (ch === '\\') i++;
        else if (ch === '`') { st = 'code'; prev = 'a'; } else if (ch === '$' && l[i + 1] === '{') { tpl.push(0); st = 'code'; i++; prev = '('; }
        continue;
      }
      if (ch === '/' && l[i + 1] === '/') break;
      if (ch === '/' && l[i + 1] === '*') { st = 'block'; i++; continue; }
      if (ch === "'") { st = 'sq'; continue; }
      if (ch === '"') { st = 'dq'; continue; }
      if (ch === '`') { st = 'tpl'; continue; }
      if (ch === '\\') { i++; continue; }
      if (ch === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of)\s*$/.test(l.slice(0, i)))) {
        let cls = false;
        for (i++; i < l.length; i++) {
          if (l[i] === '\\') { i++; continue; }
          if (l[i] === '[') cls = true; else if (l[i] === ']') cls = false; else if (l[i] === '/' && !cls) break;
        }
        prev = 'a';
        continue;
      }
      if (ch === '{') { if (tpl.length) tpl[tpl.length - 1]++; out[n].push('{'); depth++; }
      else if (ch === '}') {
        if (tpl.length && tpl[tpl.length - 1] === 0) { tpl.pop(); st = 'tpl'; continue; }
        if (tpl.length) tpl[tpl.length - 1]--;
        out[n].push('}');
        if (--depth < 0) return { ok: false, reason: `una llave cierra sin abrir en el renglón ${n + 1}` };
      }
      if (!/\s/.test(ch)) prev = ch;
    }
  }
  if (depth !== 0 || st === 'block' || st === 'tpl') return { ok: false, reason: `las llaves no cierran (quedan ${depth} abiertas)` };
  return { ok: true, braces: out };
}

/** Lo mismo para un guion de shell: comillas, comentarios, `${var}` y documentos en línea (`<<EOF`) no cuentan. */
function bracesSh(lines) {
  const out = lines.map(() => []);
  let st = 'code';
  let depth = 0;
  let heredoc = null;
  const subst = [];   // por cada `$(` abierto dentro de comillas dobles, cuántos paréntesis lleva adentro
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (heredoc) { if ((heredoc.dash ? l.trim() : l) === heredoc.tag) heredoc = null; continue; }
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (st === 'sq') { if (ch === "'") st = 'code'; continue; }
      if (st === 'dq') {
        if (ch === '\\') i++;
        else if (ch === '"') st = 'code';
        else if (ch === '$' && l[i + 1] === '(') { subst.push(0); st = 'code'; i++; }
        continue;
      }
      if (ch === '\\') { i++; continue; }
      if (subst.length && ch === '(') { subst[subst.length - 1]++; continue; }
      if (subst.length && ch === ')') {
        if (subst[subst.length - 1] === 0) { subst.pop(); st = 'dq'; } else subst[subst.length - 1]--;
        continue;
      }
      if (ch === '#' && (i === 0 || /[\s;]/.test(l[i - 1]))) break;
      if (ch === "'") { st = 'sq'; continue; }
      if (ch === '"') { st = 'dq'; continue; }
      if (ch === '$' && l[i + 1] === '{') {   // ${var…}: se salta hasta su cierre
        let d = 0;
        for (i++; i < l.length; i++) { if (l[i] === '{') d++; else if (l[i] === '}' && --d === 0) break; }
        continue;
      }
      if (ch === '<' && l[i + 1] === '<' && l[i + 2] !== '<') {
        const m = l.slice(i).match(/^<<(-?)\s*['"]?([A-Za-z_]\w*)['"]?/);
        if (m) heredoc = { tag: m[2], dash: m[1] === '-' };
      }
      if (ch === '{') { out[n].push('{'); depth++; } else if (ch === '}') {
        out[n].push('}');
        if (--depth < 0) return { ok: false, reason: `una llave cierra sin abrir en el renglón ${n + 1}` };
      }
    }
  }
  if (depth !== 0 || st !== 'code' || heredoc || subst.length) return { ok: false, reason: `las llaves no cierran (quedan ${depth} abiertas)` };
  return { ok: true, braces: out };
}

function fnName(line, forms) {
  for (const re of forms) {
    const m = line.match(re);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

// Los subcomandos que nombra un renglón: `case 'x':` o la condición de un `if (cmd === 'x' || cmd === 'y')`.
function labelsOf(line) {
  const c = line.match(CASE);
  if (c) return [c[2]];
  if (!IF_LABEL.test(line)) return [];
  return [...line.matchAll(EQ_LIT)].map((m) => m[2]);
}

/** Lo que encierra el renglón `idx` (0-based), de adentro hacia afuera: [{ name } | { label }]. */
function enclosing(ctx, idx) {
  const { lines, braces, forms } = ctx;
  const chain = [];
  const own = fnName(lines[idx], forms);
  if (own) chain.push({ name: own });
  for (const lab of labelsOf(lines[idx])) chain.push({ label: lab });
  let open = 0;
  let caseSeen = chain.some((c) => c.label);
  for (let i = idx - 1; i >= 0; i--) {
    // de derecha a izquierda: `} else if (…) {` abre un bloque nuevo aunque sus llaves se compensen
    let encloses = false;
    for (let k = braces[i].length - 1; k >= 0; k--) {
      if (braces[i][k] === '}') open--;
      else if (++open > 0) { encloses = true; break; }
    }
    if (!encloses) {
      if (open === 0 && !caseSeen) {
        const c = lines[i].match(CASE);
        if (c) { chain.push({ label: c[2] }); caseSeen = true; }
      }
      continue;
    }
    open = 0;
    caseSeen = false;
    let name = fnName(lines[i], forms);
    // la firma partida en renglones: `function x(a,` arriba del `{`
    for (let j = i - 1; !name && j >= Math.max(0, i - 2) && !braces[j].length; j--) name = fnName(lines[j], forms);
    if (name) chain.push({ name });
    for (const lab of labelsOf(lines[i])) chain.push({ label: lab });
  }
  return chain;
}

function callSites(ctx, fn) {
  const re = new RegExp(`(?<!${WORD}|\\.)${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'u');
  const out = [];
  ctx.lines.forEach((l, i) => { if (re.test(l) && fnName(l, ctx.forms) !== fn) out.push(i); });
  return out;
}

// Los nombres de un renglón: lo que lo encierra y, por cada función, lo que encierra a quien la llama (dos saltos). A una
// función que se alcanza por dos caminos se la sigue con el que deja más saltos: el orden de la visita no corta nombres.
function namesOf(ctx, idx) {
  const names = new Set();
  let labels = false;
  const seen = new Map();   // función → los saltos con que ya se siguió
  const visit = (i, saltos) => {
    let label = false;
    for (const c of enclosing(ctx, i)) {
      if (c.label) { labels = true; label = true; names.add(c.label); continue; }
      if (c.name === 'main' && label) continue;   // el despacho: ni cuenta ni se siguen sus llamadas
      names.add(c.name);
      if (saltos > 0 && saltos > (seen.has(c.name) ? seen.get(c.name) : 0)) {
        seen.set(c.name, saltos);
        for (const s of callSites(ctx, c.name)) visit(s, saltos - 1);
      }
    }
  };
  visit(idx, 2);
  if (labels) names.delete('main');
  return [...names];
}

// Los renglones que tocó cada tramo de `git diff -U0`: los del archivo nuevo (`nuevos`) y los que se fueron o cambiaron
// del archivo de la base (`viejos`).
function changedLines(diff) {
  const nuevos = [];
  const viejos = [];
  for (const l of diff.split('\n')) {
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const start = Number(m[3]);
    const count = m[4] === undefined ? 1 : Number(m[4]);
    if (count === 0) nuevos.push(Math.max(start, 1));   // sólo borra: el renglón de al lado que quedó
    else for (let i = 0; i < count; i++) nuevos.push(start + i);
    for (let i = 0; i < oldCount; i++) viejos.push(oldStart + i);
  }
  return { nuevos, viejos };
}

/**
 * @param {{ repo: string, file: string, base: string }} o  `file` relativo a `repo`, como lo nombra touched.json
 * @returns {{ known: true, names: string[] } | { known: false, reason: string }}
 */
function changeNames({ repo, file, base }) {
  if (!repo || !file) return { known: false, reason: 'faltan el repo o el archivo' };
  if (!base) return { known: false, reason: 'sin base contra la que comparar' };
  let text;
  try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch (e) { return { known: false, reason: `no pude leer ${file} (${e.code || e.message})` }; }
  // una base que empieza con `-` git la tomaría por opción
  try { if (base.startsWith('-')) throw new Error('opción'); git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]); } catch (_) {
    return { known: false, reason: `git no conoce la base ${base}` };
  }
  try { git(repo, ['cat-file', '-e', `${base}:./${file}`]); } catch (_) {
    return { known: false, reason: `el archivo es nuevo: no está en ${base.slice(0, 12)}` };
  }
  let diff;
  try { diff = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, '--', file]); } catch (e) {
    return { known: false, reason: `git diff falló (${String(e.stderr || e.message).trim().split('\n')[0]})` };
  }
  const { nuevos, viejos } = changedLines(diff);
  if (!nuevos.length) return { known: false, reason: `no cambió desde ${base.slice(0, 12)}` };
  const sh = /\.(ba)?sh$/.test(file);
  const contexto = (txt, cual) => {
    const lines = txt.split('\n');
    const b = sh ? bracesSh(lines) : bracesJs(lines);
    if (!b.ok) throw new Error(`no pude seguir las llaves de ${file}${cual}: ${b.reason}`);
    return { lines, braces: b.braces, forms: sh ? SH_FN : JS_FN };
  };
  let ctx;
  let viejo = null;
  try {
    ctx = contexto(text, '');
    if (viejos.length) viejo = contexto(git(repo, ['show', `${base}:./${file}`]), ` en ${base.slice(0, 12)}`);
  } catch (e) {
    return { known: false, reason: e.message };
  }
  const names = [];
  for (const n of nuevos) {
    const idx = Math.min(n, ctx.lines.length) - 1;
    const found = idx >= 0 ? namesOf(ctx, idx) : [];
    if (!found.length) return { known: false, reason: `el renglón ${n} cambió y no lo encierra ninguna función ni subcomando` };
    for (const x of found) if (!names.includes(x)) names.push(x);
  }
  // lo que se borró o se renombró suma su nombre viejo; un renglón viejo que nada encierra no agrega nada
  for (const n of viejos) {
    const idx = Math.min(n, viejo.lines.length) - 1;
    for (const x of idx >= 0 ? namesOf(viejo, idx) : []) if (!names.includes(x)) names.push(x);
  }
  return { known: true, names };
}

module.exports = { changeNames, changedLines, enclosing, bracesJs, bracesSh };
