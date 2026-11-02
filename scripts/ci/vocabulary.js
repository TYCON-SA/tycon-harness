#!/usr/bin/env node
'use strict';
/**
 * vocabulary.js — el control de las palabras de las guías en castellano.
 *
 * Las guías dicen cada cosa con una sola palabra (guides/maintaining/vocabulario.md): historia y no story, revisor y no
 * advisor. Este control cuenta, en lo que va al commit (el índice de git), las palabras que no se escriben:
 *   · sólo en la prosa en castellano de `guides/`, `getting-started/`, `README.es.md`, `INDEX.md` e `INSTALL.md`. No mide
 *     un `.en.md`, una `SKILL.md`, ni un `X.md` que tiene al lado un `X.es.md` (es el inglés del par);
 *   · sin el código entre acentos graves, los bloques de código, la dirección de un enlace ni un nombre de la máquina
 *     (la palabra pegada a `-`, `_`, `/`, `@` o a un `.` seguido de letra: `tycon-harness`, `advisors.yaml`);
 *   · sin las frases declaradas en `exceptions`, cada una con su motivo (una sin motivo, con comodines o que ya no
 *     encuentra su frase, frena). Una excepción sin `path` vale en todos los archivos medidos; con `path`, sólo en ése.
 * Lo que cuenta no puede pasar el techo de su archivo (`ceiling`; sin entrada, 0). Por debajo del techo no frena: avisa el
 * número que va, para que el pedido que barre lo baje. Subir un techo es aflojar el control: lo mira la revisión desde
 * la base (scripts/ci/controls-from-base.json).
 *
 * Las reglas: scripts/ci/vocabulary.json, leídas del índice. Sin reglas legibles no se mide: sale 2, nunca verde.
 *
 * Uso: node scripts/ci/vocabulary.js --repo <dir> [--measure] [--json] [--skip-thin]
 *   sale 0 dentro del techo · 1 una palabra de más o una excepción mal declarada · 2 no medido (git o las reglas)
 *   --measure imprime lo que cuenta cada archivo (para fijar el techo) y sale 0
 *   --skip-thin lo pasa sólo el pre-commit propio del repo de mantenimiento adelgazado: si el árbol lo es (su
 *     `.tycon/internal-forms.json` dice `layout: "thin"`), no cuenta y lo dice; las guías las mide el repo público
 * Casos: scripts/tests/vocabulary.test.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const RULES = 'scripts/ci/vocabulary.json';
const MAX_BUFFER = 256 * 1024 * 1024;
const L = '\\p{L}\\p{N}';
const WILDCARD = /[*?[\]{}]/;

class LookError extends Error {}

// el color de git apagado: con `color.ui=always` en la configuración de una máquina, la salida trae escapes
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, '-c', 'color.ui=never', ...args], { maxBuffer: MAX_BUFFER, input });
  if (r.error) throw new LookError(`git no corrió (${r.error.code || r.error.message})`);
  return r;
}
/** El contenido de un archivo en el índice, o null si no está. */
function indexed(repo, rel) {
  if (git(repo, ['ls-files', '--error-unmatch', '--', rel]).status !== 0) return null;
  const r = git(repo, ['show', `:${rel}`]);
  if (r.status !== 0) throw new LookError(`${rel} está en el índice y no se puede leer (git show salió con ${r.status})`);
  return r.stdout.toString('utf8');
}
/** Muchos archivos del índice de una vez (`git cat-file --batch`): rel → texto. */
function readMany(repo, rels) {
  const out = new Map();
  if (!rels.length) return out;
  const r = git(repo, ['cat-file', '--batch'], rels.map((rel) => `:${rel}`).join('\n') + '\n');
  if (r.status !== 0) throw new LookError(`git cat-file salió con ${r.status}`);
  const buf = r.stdout;
  let at = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(0x0a, at);
    const head = buf.slice(at, nl).toString('utf8');
    const m = /^\S+ blob (\d+)$/.exec(head);
    if (!m) throw new LookError(`${rel}: git cat-file devolvió «${head.slice(0, 80)}»`);
    const size = Number(m[1]);
    out.set(rel, buf.slice(nl + 1, nl + 1 + size).toString('utf8'));
    at = nl + 1 + size + 1;
  }
  return out;
}

/** ¿El archivo es prosa en castellano que se mide? `files` es el conjunto de los archivos del índice. */
function measured(rel, files) {
  if (!rel.endsWith('.md')) return false;
  const inScope = rel === 'README.es.md' || rel === 'INDEX.md' || rel === 'INSTALL.md' || rel.startsWith('guides/') || rel.startsWith('getting-started/');
  if (!inScope) return false;
  if (rel.endsWith('.en.md') || path.posix.basename(rel) === 'SKILL.md') return false;
  // un X.md con su X.es.md al lado es el inglés del par
  if (!rel.endsWith('.es.md') && files.has(rel.replace(/\.md$/, '.es.md'))) return false;
  return true;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');

/** Las reglas leídas y revisadas; tira LookError si no se pueden usar. */
function validRules(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new LookError(`${RULES} no es un objeto`);
  if (!Array.isArray(r.terms) || !r.terms.length) throw new LookError(`${RULES} no trae «terms»: no sé qué palabras contar`);
  for (const t of r.terms) {
    const ok = t && typeof t.use === 'string' && t.use.trim() && Array.isArray(t.avoid) && t.avoid.length
      && t.avoid.every((w) => typeof w === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ]*$/u.test(w));
    if (!ok) throw new LookError(`${RULES}: cada término lleva «use» (la palabra que va) y «avoid» (las que no, sólo letras y espacios): ${JSON.stringify(t).slice(0, 120)}`);
  }
  const exceptions = r.exceptions === undefined ? [] : r.exceptions;
  const ceiling = r.ceiling === undefined ? {} : r.ceiling;
  if (!Array.isArray(exceptions)) throw new LookError(`${RULES}: «exceptions» es una lista`);
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling) || Object.values(ceiling).some((n) => !Number.isInteger(n) || n < 0)) {
    throw new LookError(`${RULES}: «ceiling» es un objeto de archivo → entero ≥ 0`);
  }
  return { terms: r.terms, exceptions, ceiling };
}

/** La expresión de las palabras que no se escriben y el mapa palabra → la que va. */
function compile(rules) {
  const useOf = new Map();
  for (const t of rules.terms) for (const w of t.avoid) useOf.set(norm(w), t.use);
  const alts = [...useOf.keys()].sort((a, b) => b.length - a.length).map((w) => w.split(' ').map(escape).join('\\s+'));
  // la palabra entera, y no pegada a lo que arma un nombre de la máquina
  const re = new RegExp(`(?<![-_/.@${L}])(?:${alts.join('|')})(?![-_/${L}])(?!\\.[${L}])`, 'giu');
  return { re, useOf };
}

// el texto se tapa sin mover nada: cada carácter pasa a espacio y los saltos de renglón quedan, así las líneas no cambian
const blank = (s) => s.replace(/[^\n]/g, ' ');
// el comienzo de un renglón dentro de una cita (`> `, `> > `), que no es parte del contenido
const QUOTE = /^(?: {0,3}>[ \t]?)*/;

/**
 * Los renglones con los bloques de código tapados, como los lee CommonMark: un bloque abre con tres acentos graves o
 * tres virgulillas (también dentro de una cita), su información no lleva acentos graves si abre con acentos, y cierra
 * con la misma marca, igual o más larga, sin nada después. Devuelve los renglones y, si uno quedó abierto, dónde abrió.
 */
function maskFences(lines) {
  let fence = null;
  const out = lines.map((raw, i) => {
    const body = raw.replace(QUOTE, '');
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (c && c[1][0] === fence.mark[0] && c[1].length >= fence.mark.length) fence = null;
      return '';
    }
    const o = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (o && !(o[1][0] === '`' && o[2].includes('`'))) { fence = { mark: o[1], line: i + 1 }; return ''; }
    // una definición de referencia (`[x]: dirección`) es una dirección; una nota al pie (`[^1]: …`) es prosa
    if (/^\s*\[(?!\^)[^\]]+\]:\s*\S/.test(raw)) return '';
    return raw;
  });
  return { lines: out, unclosed: fence ? fence.line : null };
}

/** El texto sin código entre acentos graves (también partido entre renglones), sin direcciones de enlaces ni URLs. */
function prose(text) {
  return text
    // el código en línea no cruza un renglón en blanco: un acento suelto no se come el párrafo siguiente
    .replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g, blank)
    .replace(/\]\([^)]*\)/g, (s) => `]${blank(s.slice(1))}`)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank);
}

/**
 * Lo que cuenta un texto: las menciones, qué excepciones encontró (por su índice en la lista) y dónde abre un bloque
 * de código que nunca cierra. Se mide el texto entero, no renglón por renglón: una frase partida por un salto de
 * renglón es la misma frase.
 */
function scan(text, rules, rel, compiled = compile(rules)) {
  const fenced = maskFences(text.split(/\r?\n/));
  let body = prose(fenced.lines.join('\n'));
  const hits = new Set();
  rules.exceptions.forEach((e, k) => {
    if (!e || typeof e.phrase !== 'string' || !e.phrase.trim()) return;
    if (e.path !== undefined && e.path !== rel) return;
    const re = new RegExp(e.phrase.trim().split(/\s+/).map(escape).join('\\s+'), 'giu');
    body = body.replace(re, (s) => { hits.add(k); return blank(s); });
  });
  const mentions = [];
  for (const m of body.matchAll(compiled.re)) {
    const line = 1 + (body.slice(0, m.index).match(/\n/g) || []).length;
    mentions.push({ line, word: m[0], use: compiled.useOf.get(norm(m[0])) });
  }
  return { mentions, hits, unclosed: fenced.unclosed };
}
/** Las menciones de un texto: `[{ line, word, use }]`. */
function mentionsIn(text, rules, rel = '') {
  return scan(text, { terms: rules.terms, exceptions: rules.exceptions || [] }, rel).mentions;
}

/** La tabla del glosario (la que tiene la columna «No se escribe»): `[{ use, avoid }]`, las palabras entre acentos graves. */
function glossaryTable(md) {
  const lines = md.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\|/.test(l) && /No se escribe/i.test(l));
  if (head < 0) return [];
  const cols = lines[head].split('|').map((c) => c.trim());
  const useAt = cols.findIndex((c) => /^Se escribe$/i.test(c));
  const avoidAt = cols.findIndex((c) => /^No se escribe$/i.test(c));
  const out = [];
  for (const l of lines.slice(head + 2)) {
    if (!/^\|/.test(l)) break;
    const cells = l.split('|').map((c) => c.trim());
    const avoid = [...cells[avoidAt].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
    out.push({ use: cells[useAt].replace(/`/g, ''), avoid });
  }
  return out;
}

/** ¿El repo de mantenimiento adelgazado? Sus guías propias no se publican. */
function thinLayout(repo) {
  try { return JSON.parse(indexed(repo, '.tycon/internal-forms.json') || '').layout === 'thin'; } catch (_) { return false; }
}

function readRules(repo) {
  const text = indexed(repo, RULES);
  if (text === null) throw new LookError(`no está ${RULES}: sin reglas no sé qué contar`);
  let r;
  try { r = JSON.parse(text); } catch (e) { throw new LookError(`${RULES} no es JSON (${e.message})`); }
  return validRules(r);
}

/**
 * El control sobre el índice de `repo`: `{ ok, problems, perFile, mentions, notes }`. `perFile` es lo que cuenta cada
 * archivo medido; `mentions`, cada palabra con su archivo y su línea. Tira LookError si no puede medir.
 */
function check({ repo, skipThin = false }) {
  // el salteo lo pide quien llama y además el árbol tiene que serlo: el archivo solo no apaga el control en el público
  // con --repo en una subcarpeta, el repo entero: las rutas de las reglas son desde la raíz
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.status === 0 && top.stdout.toString('utf8').trim()) repo = top.stdout.toString('utf8').trim();
  if (skipThin && thinLayout(repo)) return { ok: true, skipped: true, problems: [], perFile: {}, mentions: [], notes: ['no aplica: las guías las mide el público'] };
  const ls = git(repo, ['ls-files', '-z']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}`);
  const files = new Set(ls.stdout.toString('utf8').split('\0').filter(Boolean));
  const rels = [...files].filter((rel) => measured(rel, files)).sort();
  // un árbol sin guías y sin reglas (un repo de juguete con el pre-commit del arnés) no tiene nada que medir; con una
  // guía, las reglas hacen falta
  if (!rels.length && !files.has(RULES)) return { ok: true, problems: [], perFile: {}, mentions: [], notes: ['el árbol no trae guías ni reglas: nada que medir'] };
  const rules = readRules(repo);
  const texts = readMany(repo, rels);
  const compiled = compile(rules);
  const problems = [];
  const notes = [];
  const perFile = Object.create(null);
  const mentions = [];
  const found = new Set();
  for (const rel of rels) {
    const s = scan(texts.get(rel), rules, rel, compiled);
    for (const k of s.hits) found.add(k);
    if (s.unclosed) problems.push(`${rel}: el bloque de código que abre en la línea ${s.unclosed} queda sin cerrar, y todo lo que sigue no se mide: cerralo`);
    if (!s.mentions.length) continue;
    perFile[rel] = s.mentions.length;
    for (const m of s.mentions) mentions.push({ file: rel, ...m });
  }
  rules.exceptions.forEach((e, k) => {
    const what = e && typeof e.phrase === 'string' && e.phrase.trim() ? `«${e.phrase}»` : null;
    if (!what) { problems.push(`${RULES}: una excepción sin «phrase»`); return; }
    if (e.path !== undefined && typeof e.path !== 'string') { problems.push(`${RULES}: la excepción ${what} trae un «path» que no es un texto: va la ruta exacta de un archivo, o nada para todas las guías`); return; }
    if (WILDCARD.test(e.phrase) || (typeof e.path === 'string' && WILDCARD.test(e.path))) { problems.push(`${RULES}: la excepción ${what} lleva comodines: va la frase y el archivo exactos`); return; }
    if (!(typeof e.reason === 'string' && e.reason.trim())) problems.push(`${RULES}: la excepción ${what} está sin motivo: cada una dice por qué esa frase queda`);
    // no frena, como un techo por encima de lo que cuenta: sacar la frase y la excepción juntas endurece, y la revisión
    // desde la base, que corre con las reglas viejas, no lo puede ver como un aflojamiento
    if (!found.has(k)) notes.push(`${RULES}: la excepción ${what} ya no encuentra su frase${e.path ? ` en ${e.path}` : ' en las guías'}: sacala`);
  });
  const topOf = (rel) => (Object.prototype.hasOwnProperty.call(rules.ceiling, rel) ? rules.ceiling[rel] : 0);
  for (const [rel, n] of Object.entries(perFile)) {
    const top = topOf(rel);
    if (n <= top) continue;
    const where = mentions.filter((m) => m.file === rel).map((m) => `${rel}:${m.line}: «${m.word}» → ${m.use}`).join('; ');
    problems.push(`${rel}: ${n} palabra(s) que no se escriben y el techo es ${top} (el glosario: guides/maintaining/vocabulario.md). Dónde: ${where}`);
  }
  for (const [rel, top] of Object.entries(rules.ceiling)) {
    const n = perFile[rel] || 0;
    if (n < top) notes.push(`${rel}: va ${n} y su techo es ${top}: bajalo a ${n} en ${RULES}`);
  }
  return { ok: problems.length === 0, problems, perFile: Object.fromEntries(Object.entries(perFile)), mentions, notes };
}

function main(argv) {
  const repoAt = argv.indexOf('--repo');
  const repo = path.resolve(repoAt >= 0 && argv[repoAt + 1] ? argv[repoAt + 1] : '.');
  let r;
  try { r = check({ repo, skipThin: argv.includes('--skip-thin') }); } catch (e) {
    if (!(e instanceof LookError)) throw e;
    process.stderr.write(`⛔ vocabulary: no medido — ${e.message}\n`);
    return 2;
  }
  if (argv.includes('--measure')) { process.stdout.write(`${JSON.stringify(r.perFile, null, 2)}\n`); return 0; }
  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  if (r.skipped) { process.stdout.write(`⏭ vocabulary: ${r.notes.join(' · ')}\n`); return 0; }
  for (const n of r.notes) process.stdout.write(`ℹ vocabulary: ${n}\n`);
  if (r.ok) {
    const total = Object.values(r.perFile).reduce((a, b) => a + b, 0);
    process.stdout.write(`✅ vocabulary: ${total} palabra(s) por cambiar en ${Object.keys(r.perFile).length} archivo(s), dentro del techo\n`);
    return 0;
  }
  for (const p of r.problems) process.stderr.write(`🛑 vocabulary: ${p}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, measured, mentionsIn, glossaryTable, main, RULES };
