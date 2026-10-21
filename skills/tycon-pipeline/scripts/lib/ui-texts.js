#!/usr/bin/env node
/**
 * ui-texts.js — lo que un usuario lee en una pantalla, sin el código alrededor.
 *
 * Qué cubre: una pantalla puede pasar todos los controles y aun así ser «inentendible» para quien la
 * usa. Si la revisión de legibilidad lee sólo la guía del tester, las marcas sobre textos de la pantalla se
 * «resuelven» reescribiendo la guía, y el texto malo sigue en el código.
 *
 * Cuatro piezas, todas sin modelo:
 *   screenFiles   — las pantallas de una story (`.tsx/.jsx/.vue/.svelte` de files_to_create, files_to_modify y del
 *                   File List), resueltas contra las raíces que se le pasan. Las que no están en el disco se nombran.
 *   visibleTexts  — los textos que ve el usuario: texto de JSX (un `{expr}` queda como hueco), los atributos que se
 *                   leen (placeholder, title, aria-label, alt, label) y las cadenas y plantillas con forma de frase.
 *                   Deja afuera imports, clases, data-testid, key y lo que va a la consola. Es heurístico a
 *                   propósito: alimenta al revisor, no frena nada (el revisor tiene además las capturas).
 *   quotedMarks   — las marcas citadas con «» en un archivo de legibilidad, de tres palabras o más (un botón
 *                   nombrado en un paso, «Guardar», no es una marca sobre la pantalla), con su `keep:` si lo trae.
 *   whereInScreens — en qué pantallas sigue un texto citado: literal, o como mensaje armado cuyas partes fijas
 *                   aparecen en orden (`Tiene ${n} facturas` cuenta para «Tiene 1 facturas»).
 *
 * CLI: node ui-texts.js <archivo...>   imprime los textos visibles de cada archivo.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCREEN_RE = /\.(tsx|jsx|vue|svelte)$/i;
const VISIBLE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'label'];
const HIDDEN_ATTRS = ['className', 'class', 'data-testid', 'key', 'id', 'href', 'src', 'type', 'name', 'role', 'style'];

// Entradas `- ruta` de una lista del frontmatter (`files_to_create:` / `files_to_modify:`), sin el comentario `#`.
function listEntries(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[^\\n]*\\r?\\n?|[ \\t]*#[^\\n]*\\r?\\n?)*)`, 'm'));
  if (!m) return [];
  // `(<repo>) ruta` es una entrada: el repo entre paréntesis dice dónde vive la ruta.
  return m[1].split('\n').map((l) => l.match(/^\s*-\s*["']?((?:\([^()\n]+\)\s+)?[^\s#"']+)/)).filter(Boolean).map((x) => x[1]);
}
// Rutas de la sección `### File List` del Dev Agent Record (o `## File List`).
function fileListEntries(body) {
  const m = body.match(/^#{2,3}\s+File List\s*\n([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/m);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.match(/^\s*[-*]\s*`?((?:\([^()\n]+\)\s+)?[^\s`]+)`?/)).filter(Boolean).map((x) => x[1]);
}

/** Las pantallas que declara la story. `roots`: dónde buscarlas, en orden (repo de la story, workspace, acompañantes). */
function screenFiles(fm, body, roots, resolve) {
  const declared = [...listEntries(fm, 'files_to_create'), ...listEntries(fm, 'files_to_modify'), ...fileListEntries(body)]
    .map((raw) => ({ raw: raw.trim(), rel: raw.replace(/^\(([^)]*)\)\s*/, '').trim() }))
    .filter((d) => SCREEN_RE.test(d.rel));
  const found = []; const missing = []; const seen = new Set();
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  for (const { raw, rel } of declared) {
    // `(A) x` y `(B) x` son dos pantallas: la clave es la entrada entera, con su repo.
    if (seen.has(raw)) continue;
    seen.add(raw);
    // `resolve(entrada)`: la ruta donde vive la entrada, `null` si es de un repo que no la tiene, `undefined` si no sabe.
    const decidida = typeof resolve === 'function' ? resolve(raw) : undefined;
    if (decidida === null) { missing.push(rel); continue; }
    const abs = typeof decidida === 'string' ? decidida : path.isAbsolute(rel) ? rel : (roots || []).filter(Boolean).map((r) => path.join(r, rel)).find(isFile);
    if (abs && fs.existsSync(abs)) found.push({ rel, abs }); else missing.push(rel);
  }
  return { found, missing };
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const hasLetter = (s) => /[A-Za-zÀ-ÿ]/.test(s);
// Una cadena con forma de clases CSS (`flex items-center gap-2`, `hidden md:block`) o de ruta no es texto para el
// usuario. Una frase en minúsculas («no se pudo guardar el cambio») sí lo es: para ser
// código, además de ir toda en minúsculas sin tildes, alguna palabra tiene que traer una marca de clase o de ruta.
const looksLikeCode = (s) => {
  const t = s.trim();
  if (/^[./@]/.test(t)) return true;
  const words = t.split(/\s+/);
  return words.every((w) => /^[a-z0-9:_./[\]#-]+$/.test(w)) && words.some((w) => /[-:_/[\]#]/.test(w) || /[a-z]\d|\d[a-z]/.test(w));
};
// Las entidades HTML se leen como la letra que ve el usuario: `Contrase&ntilde;a`.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó',
  Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü' };
// Un número fuera de Unicode (o un sustituto) queda como está: `String.fromCodePoint` tira y tumbaría el candado.
const fromCode = (m, n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m);
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]{1,8});/gi, (m, h) => fromCode(m, parseInt(h, 16)))
  .replace(/&#(\d{1,10});/g, (m, d) => fromCode(m, Number(d)))
  .replace(/&([A-Za-z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));

// Un tramo de texto entre `>` y `<`: lo que queda es lo que ve el usuario, con cada expresión como hueco `{…}`.
// Un tramo puede empezar o terminar adentro de una expresión (`{err && <p>…</p>}`): lo que está antes de una `}` sin
// abrir o después de una `{` sin cerrar es código.
function jsxSegmentText(seg) {
  let s = seg
    .replace(/\{\{[^{}]*\}\}/g, '{…}')                                      // interpolación de Vue
    .replace(/\{\s*(?:"([^"]*)"|'([^']*)')\s*\}/g, (_x, a, b) => a ?? b)   // {"texto"} es texto
    .replace(/\{\s*`[^`]*`\s*\}/g, ' ')                                    // una plantilla la lee el paso de cadenas
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');                           // comentarios de JSX
  const holes = [];
  s = s.replace(/\{[^{}]*\}/g, (x) => { holes.push(x); return `\u0000${holes.length - 1}\u0000`; });
  const close = s.lastIndexOf('}');
  if (close !== -1) s = s.slice(close + 1);
  const open = s.indexOf('{');
  if (open !== -1) s = s.slice(0, open);
  return s.replace(/\u0000(\d+)\u0000/g, (_x, i) => holes[Number(i)]);
}

/** Textos visibles de una pantalla: [{ text, line }]. */
function visibleTexts(src) {
  const out = []; const seen = new Set();
  const add = (text, idx) => {
    const t = decodeEntities(text).replace(/\s+/g, ' ').trim();
    if (!t || !hasLetter(t.replace(/\{[^{}]*\}|\$\{[^}]*\}/g, '')) || seen.has(t)) return;
    seen.add(t);
    out.push({ text: t, line: lineOf(src, idx) });
  };
  // Lo que nunca es texto de pantalla: imports/requires, consola, y los atributos de código.
  let limpio = src
    .replace(/^\s*(import|export\s+\*|export\s+\{)[^\n]*$/gm, (m) => ' '.repeat(m.length))
    .replace(/\brequire\([^)]*\)/g, (m) => ' '.repeat(m.length))
    .replace(/console\.\w+\((?:[^()]|\([^()]*\))*\)/g, (m) => ' '.repeat(m.length));
  const attrRe = (names) => new RegExp(`\\b(?:${names.map((n) => n.replace('-', '\\-')).join('|')})\\s*=\\s*(?:"[^"]*"|'[^']*'|\\{\\s*(?:"[^"]*"|'[^']*'|\`[^\`]*\`)\\s*\\})`, 'g');
  // 1. atributos visibles
  const vis = new RegExp(`\\b(${VISIBLE_ATTRS.map((n) => n.replace('-', '\\-')).join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)\\s*\\})`, 'g');
  let m;
  while ((m = vis.exec(limpio)) !== null) add(m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '', m.index);
  limpio = limpio.replace(vis, (x) => ' '.repeat(x.length)).replace(attrRe(HIDDEN_ATTRS), (x) => ' '.repeat(x.length));
  // 2. texto de JSX (y de plantillas de Vue/Svelte) entre etiquetas; cada expresión adentro es un hueco del mensaje
  const jsx = />([^<>]*)</g;
  while ((m = jsx.exec(limpio)) !== null) add(jsxSegmentText(m[1]), m.index);
  // 3. cadenas y plantillas con forma de frase (un espacio y una letra). Las plantillas pueden cruzar líneas.
  const strs = [/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g, /(`)((?:\\.|[^\\`])*)`/g];
  for (const str of strs) {
    while ((m = str.exec(limpio)) !== null) {
      const s = m[2];
      if (!/\s/.test(s.trim()) || looksLikeCode(s)) continue;
      add(s, m.index);
    }
  }
  return out;
}

/** Marcas citadas con «» en un archivo de legibilidad: [{ quote, keep, line }]. */
function quotedMarks(md) {
  const marks = [];
  md.split('\n').forEach((l, i) => {
    const keep = (l.match(/\bkeep:\s*(.+)$/) || [])[1] || null;
    for (const q of l.matchAll(/«([^»]+)»/g)) {
      const quote = q[1].replace(/\s+/g, ' ').trim();
      if (quote.split(' ').length < 3) continue;
      marks.push({ quote, keep: keep ? keep.trim() : null, line: i + 1 });
    }
  });
  return marks;
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.:;,!?¡¿]+$/g, '').trim();
const HOLE = /\$\{[^}]*\}|\{[^{}]*\}/g;
const words = (s) => s.split(' ').map((w) => w.replace(/^[«»"'(¡¿]+|[«»"'),.:;!?]+$/g, '')).filter(Boolean);
const HOLE_MAX_WORDS = 3;   // un hueco lo llena un número, un nombre o una fecha: hasta tres palabras

// ¿El texto citado sale de este texto de pantalla? Sí si la cita ENTERA es un tramo del mensaje con los huecos
// (`${…}` / `{…}`) llenos por una a tres palabras cualesquiera, y al menos dos palabras fijas del mensaje coinciden.
// Una cita más larga que el mensaje no sale de él; y una plantilla de puros huecos
// (`${a} ${b}`) no «contiene» cualquier frase.
function quoteMatchesText(quote, text) {
  const q = norm(quote); const t = norm(text);
  if (!q || !t) return false;
  if (t.includes(q)) return true;
  const qw = words(q);
  const tw = words(t.replace(HOLE, ' \u0000 ')).map((w) => (w === '\u0000' ? null : w));   // null = hueco
  // Una cita no puede ser más larga que el mensaje con cada hueco lleno al máximo: corta antes de buscar.
  if (qw.length > tw.length * HOLE_MAX_WORDS) return false;
  // ¿qw[i..] se puede leer empezando en tw[j..]? Devuelve el máximo de palabras fijas que coincidieron, o -1.
  // Con memoria por (i, j): sin ella, muchos huecos y una cita larga ramificarían sin tope.
  const memo = new Map();
  const desde = (i, j) => {
    if (i === qw.length) return 0;
    if (j === tw.length) return -1;
    const clave = i * (tw.length + 1) + j;
    if (memo.has(clave)) return memo.get(clave);
    let r = -1;
    if (tw[j] === null) {
      for (let k = 1; k <= HOLE_MAX_WORDS && i + k <= qw.length; k++) r = Math.max(r, desde(i + k, j + 1));
    } else if (tw[j] === qw[i]) {
      const resto = desde(i + 1, j + 1);
      if (resto !== -1) r = resto + 1;
    }
    memo.set(clave, r);
    return r;
  };
  for (let j = 0; j < tw.length; j++) {
    if (desde(0, j) >= 2) return true;
  }
  return false;
}

/**
 * En qué pantallas sigue un texto citado: [{ rel, line }]. `screens`: [{ rel, abs }].
 * Una pantalla que no se puede leer vuelve como `{ rel, unreadable: <motivo> }`: no mirar no es prueba de que la pantalla desapareció.
 */
function whereInScreens(quote, screens) {
  const hits = [];
  for (const s of screens) {
    let src;
    try { src = fs.readFileSync(s.abs, 'utf8'); } catch (e) { hits.push({ rel: s.rel, unreadable: e.code || e.message }); continue; }
    if (src.includes(quote)) { hits.push({ rel: s.rel, line: lineOf(src, src.indexOf(quote)) }); continue; }
    const t = visibleTexts(src).find((v) => quoteMatchesText(quote, v.text));
    if (t) hits.push({ rel: s.rel, line: t.line });
  }
  return hits;
}

module.exports = { screenFiles, visibleTexts, quotedMarks, whereInScreens, quoteMatchesText, SCREEN_RE };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('uso: ui-texts.js <archivo de pantalla...>'); process.exit(2); }
  for (const f of files) {
    console.log(`## ${f}`);
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`- (no pude leerlo: ${e.message})`); continue; }
    const ts = visibleTexts(src);
    if (!ts.length) console.log('- (sin textos visibles detectados)');
    for (const t of ts) console.log(`- ${t.text}  (línea ${t.line})`);
  }
}
