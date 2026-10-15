#!/usr/bin/env node
'use strict';
// spanish-names.js — el freno de nombres NUEVOS en castellano en lo que ejecuta la máquina (épica 8, story 8.9 · 2026-09-29)
//
// POR QUÉ EXISTE: el núcleo público mezcla inglés y castellano en lo que alguien de afuera tiene que ESCRIBIR para usarlo
// —archivos, opciones, subcomandos, variables, claves de configuración—. La story 8.9 los renombra por tandas; sin este
// freno, lo que una tanda renombra lo vuelve a ensuciar el commit siguiente. La prosa, los mensajes, las guías, los
// comentarios y los ids de los casos siguen en castellano: la convención está en guides/nombres-en-ingles.md.
//
// QUÉ MIRA: lo que sale en alguna copia pública (la clasificación del exportador, reusada de new-names.js) y, de eso, sólo
// ejecutables, configuración y pruebas —nunca `.md` ni los casos del banco—. Frena un nombre en castellano que NO EXISTE en
// ninguna parte de lo que sale ANTES del cambio (los dos repos; en un merge, en ningún padre): una ruta, una opción `--x`,
// un subcomando, un valor que declara el mapa de renombres, una variable de entorno leída o una clave de un archivo de
// `schemaFiles`. Usar un nombre castellano que ya existe pasa: todavía no tiene reemplazo. Qué es castellano lo decide
// scripts/lib/spanish-words.json más el diccionario inglés del sistema (/usr/share/dict/words).
//
// MODOS: en el arnés del equipo (tiene team-profile.json, o perfil-equipo.json) lo que sale lo dice la lista blanca; en la copia pública (sin
// perfil) todo lo del repo sale, con las mismas reglas, y nunca sale 2 por no tener la configuración privada.
//
// CÓMO FALLA: 0 = pasa · 1 = hallazgos (el commit no se crea) · 2 = no pude mirar (tampoco se crea). Sin el otro repo,
// avisa fuerte y deja pasar. `TYCON_SPANISH_NAMES=0` lo apaga, lo dice en cada commit y deja constancia.
//
// EN EL REPO UNIDO (story 8.18: el arnés con agent-skills adentro) no hay «otro repo» en ningún modo: las dos fuentes
// son las dos mitades del mismo árbol, partidas por ruta (new-names.js → sourceOfPath). El freno, --count, --check-map
// y --stale-mentions las arman así; cada hallazgo sale una vez, y un rango cuya base es de antes de la unión compara
// la mitad que esa base no trae con su propia historia.
//
// A mano:
//   node scripts/publishing/spanish-names.js [--repo <dir>] [--source arnes|agent-skills]      (lo stageado)
//   node scripts/publishing/spanish-names.js --range <base>...<punta>
//   node scripts/publishing/spanish-names.js --count [--json] [--repo <dir>] [--words <lista>]   (el termómetro)
//   node scripts/publishing/spanish-names.js --check-map [--repo <dir>] [--map <archivo>]       (el mapa de renombres)
//   node scripts/publishing/spanish-names.js --stale-mentions [--repo <dir>] [--json]           (nombres viejos que quedan)
// Guía: guides/nombres-en-ingles.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const nn = require('./new-names.js');
const exporter = require('../publishing/export.js');
const detector = require('./detector.js');

const { CouldNotLook } = nn;
const WORDS_PATH = 'scripts/lib/spanish-words.json';
const CEILING_PATH = 'scripts/publishing/spanish-names-ceiling.json';
const RENAMES_PATH = 'scripts/lib/renames.json';
// el perfil del equipo con su nombre de hoy o el de antes (los dos dicen «este árbol es del equipo»)
const PROFILES = ['team-profile.json', 'perfil-equipo.json'];
const hasProfile = (dir) => PROFILES.some((n) => fs.existsSync(path.join(dir, n)));
const DEFAULT_DICT = '/usr/share/dict/words';
const CATEGORIES = ['path', 'option', 'subcommand', 'value', 'env', 'key'];
const LABEL = { path: 'ruta', option: 'opción', subcommand: 'subcomando', value: 'valor', env: 'variable', key: 'clave' };
const CEILING_FIELDS = ['files', 'folders', 'options', 'subcommands', 'values', 'env', 'keys', 'total'];
// Lo que puede cambiar qué sale o qué cuenta aunque no sea un ejecutable. El techo y la lista también por su ruta vieja
// (un rango cuya punta es de antes de la mudanza de la tanda C4: pase adversarial), sacada del mapa.
const TRIGGERS = [WORDS_PATH, CEILING_PATH, RENAMES_PATH, nn.CONFIG.list, nn.CONFIG.exporter,
  ...nn.legacyPathsOf(CEILING_PATH), ...nn.legacyPathsOf(nn.CONFIG.list)];
const PACK = /^packs\/[^/]+\/pack\.json$/;

const say = (s) => process.stderr.write(`${s}\n`);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── la lista de palabras ─────────────────────────────────────────────────────────────────────────────────────────
/** Valida y arma la lista. Cualquier problema es «no pude mirar»: una lista rota no puede dar un verde. */
function loadWords(text, what) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new CouldNotLook(`${what} no es JSON válido (${e.message})`);
  }
  const problems = [];
  const list = (k) => {
    if (!Array.isArray(j[k]) || j[k].some((w) => typeof w !== 'string' || !w)) { problems.push(`«${k}» tiene que ser una lista de palabras`); return []; }
    return j[k].map((w) => w.toLowerCase());
  };
  const words = list('words');
  const ambiguous = list('ambiguous');
  const allowedWords = [];
  const allowedPaths = [];
  if (!Array.isArray(j.allowed)) problems.push('«allowed» tiene que ser una lista');
  for (const [i, a] of (Array.isArray(j.allowed) ? j.allowed : []).entries()) {
    if (!a || typeof a.reason !== 'string' || !a.reason.trim()) { problems.push(`allowed[${i}] no tiene reason: toda excepción dice por qué`); continue; }
    if (typeof a.word === 'string') allowedWords.push(a.word.toLowerCase());
    else if (Array.isArray(a.words)) allowedWords.push(...a.words.map((w) => String(w).toLowerCase()));
    else if (typeof a.path === 'string') allowedPaths.push({ path: a.path, reason: a.reason });
    else problems.push(`allowed[${i}] no dice qué permite (word, words o path)`);
  }
  const glossary = j.glossary && typeof j.glossary === 'object' && !Array.isArray(j.glossary) ? j.glossary : null;
  if (!glossary) problems.push('«glossary» tiene que ser un objeto castellano → inglés');
  const schemaFiles = Array.isArray(j.schemaFiles) ? j.schemaFiles.filter((x) => typeof x === 'string') : (problems.push('«schemaFiles» tiene que ser una lista de rutas'), []);
  // una palabra en dos listas: el freno no sabría qué hacer con ella
  const seen = new Map();
  for (const [name, arr] of [['words', words], ['ambiguous', ambiguous], ['allowed', allowedWords]]) {
    for (const w of new Set(arr)) {
      if (seen.has(w)) problems.push(`«${w}» está en dos listas (${seen.get(w)} y ${name})`);
      else seen.set(w, name);
    }
  }
  if (glossary) {
    const back = new Map();
    for (const [es, en] of Object.entries(glossary)) {
      if (typeof en !== 'string' || !en) { problems.push(`glossary.${es} no tiene la palabra en inglés`); continue; }
      if (back.has(en.toLowerCase())) problems.push(`el glosario no es inyectivo: «${back.get(en.toLowerCase())}» y «${es}» van a «${en}»`);
      else back.set(en.toLowerCase(), es);
      if (allowedWords.includes(es.toLowerCase())) problems.push(`«${es}» está en el glosario y en allowed`);
    }
  }
  if (problems.length) throw new CouldNotLook(`${what}: ${problems.join(' · ')}`);
  return {
    glossary: Object.fromEntries(Object.entries(glossary).map(([k, v]) => [k.toLowerCase(), v])),
    words: new Set(words), ambiguous: new Set(ambiguous), allowed: new Set(allowedWords), allowedPaths, schemaFiles,
  };
}

// ── qué es castellano ────────────────────────────────────────────────────────────────────────────────────────────
const ACCENT = /[À-ÿ]/;
const plain = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Las palabras de un nombre: guiones, guiones bajos, puntos, dígitos y mayúsculas internas las separan. */
function tokens(name) {
  return String(name)
    .replace(/(^|[^0-9A-Za-z])([0-9a-f]{7,40})(?=$|[^0-9A-Za-z])/g, (m, pre, hex) => (/\d/.test(hex) && /[a-f]/.test(hex) ? `${pre} ` : m))   // un sha no es una palabra
    .replace(/([A-Z]+)([A-Z][a-zß-ÿ])/g, '$1 $2')   // una sigla pegada a una palabra: `HTMLParser` → HTML Parser
    .replace(/([a-zß-ÿ])([A-Z])/g, '$1 $2').split(/[^A-Za-zÀ-ÿ]+/).filter(Boolean);
}
const variants = (t) => {
  const v = [t];
  if (t.length > 4 && t.endsWith('es')) v.push(t.slice(0, -2));
  if (t.length > 3 && t.endsWith('s')) v.push(t.slice(0, -1));
  return v;
};
// El diccionario del sistema trae la palabra, no sus formas: `navigated`, `toggled`, `updated`, `running`, `entries`
// no están. Para decidir «es inglés» se prueban también las raíces; para «es castellano», nunca (sólo el plural simple).
// El plural INGLÉS: `-s`, y `-es` sólo después de s/x/z/ch/sh (`boxes`, `matches`). Con la regla castellana (`-es` suelto)
// `errores` o `versiones` caían en `error`/`version` del diccionario y pasaban por inglesas (pase adversarial, 5b).
const englishStems = (t) => {
  const v = [t];
  const add = (x) => { if (x.length >= 3) v.push(x); };
  if (t.length > 3 && t.endsWith('s')) add(t.slice(0, -1));
  if (/(s|x|z|ch|sh)es$/.test(t)) add(t.slice(0, -2));
  if (t.endsWith('ies')) add(`${t.slice(0, -3)}y`);
  if (t.endsWith('ied')) add(`${t.slice(0, -3)}y`);
  // sin `-er`: los infinitivos castellanos (`comer`, `tener`) caerían en una raíz inglesa (`come`, `ten`)
  for (const suf of ['ed', 'ing', 'ly']) {
    if (!t.endsWith(suf) || t.length - suf.length < 3) continue;
    const stem = t.slice(0, -suf.length);
    add(stem);
    add(`${stem}e`);
    if (/([bcdfgklmnprstvz])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (t.endsWith('d')) add(t.slice(0, -1));
  return v;
};

const dictionaries = new Map();
/** El diccionario inglés y, si está al lado, el de nombres propios (`propernames` en macOS). null = no hay. */
function loadDictionary(p) {
  if (!dictionaries.has(p)) {
    let set = null;
    try {
      set = new Set(fs.readFileSync(p, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));
      try { for (const w of fs.readFileSync(path.join(path.dirname(p), 'propernames'), 'utf8').split('\n')) if (w.trim()) set.add(w.trim().toLowerCase()); } catch { /* opcional */ }
    } catch { set = null; }
    dictionaries.set(p, set);
  }
  return dictionaries.get(p);
}

function makeDetector(words, { dictPath = DEFAULT_DICT } = {}) {
  const dict = loadDictionary(dictPath);
  const inSet = (set, t) => variants(t).some((x) => set.has(x));
  // 'word' = cuenta · 'ambiguous' = cuenta si hay otra · 'english' = no cuenta
  const classify = (raw) => {
    if (ACCENT.test(raw)) return 'word';
    const t = raw.toLowerCase();
    if (inSet(words.allowed, t)) return 'english';
    if (words.words.has(t)) return 'word';
    if (words.ambiguous.has(t)) return 'ambiguous';
    // una palabra inglesa EXACTA del diccionario no pasa a castellana por su singular (`indices`, `loss`, `tapas`)
    if (dict && t.length >= 3 && dict.has(t)) return 'english';
    if (inSet(words.words, t)) return 'word';
    if (inSet(words.ambiguous, t)) return 'ambiguous';
    if (t.length < 3 || !dict) return 'english';
    return englishStems(t).some((x) => dict.has(x)) ? 'english' : 'word';
  };
  function isSpanish(name) {
    const toks = tokens(name);
    const cls = toks.map(classify);
    const sure = toks.filter((_, i) => cls[i] === 'word');
    const amb = toks.filter((_, i) => cls[i] === 'ambiguous');
    const spanish = sure.length > 0 || amb.length > 1;
    return { spanish, words: spanish ? [...new Set([...sure, ...amb].map((w) => plain(w.toLowerCase())))] : [] };
  }
  return { isSpanish, dictionary: !!dict, dictPath };
}

/** La propuesta en inglés: sólo si el glosario tiene TODAS las palabras castellanas del nombre. */
function propose(name, det, words) {
  const { spanish, words: es } = det.isSpanish(name);
  if (!spanish) return null;
  const upper = name === name.toUpperCase() && /[A-Z]/.test(name);
  let missing = false;
  const out = String(name).replace(/[A-Za-zÀ-ÿ]+/g, (chunk) => chunk.replace(/([a-zß-ÿ])(?=[A-Z])/g, '$1\u0000').split('\u0000').map((part) => {
    const low = plain(part.toLowerCase());
    if (!es.includes(low)) return part;
    const en = words.glossary[low] || variants(low).map((v) => words.glossary[v]).find(Boolean);
    if (!en) { missing = true; return part; }
    if (upper) return en.toUpperCase();
    return part[0] === part[0].toUpperCase() ? en[0].toUpperCase() + en.slice(1) : en;
  }).join(''));
  return missing ? null : out;
}

// ── qué se mira de cada archivo ──────────────────────────────────────────────────────────────────────────────────
const CASES = /^scripts\/controls-bench\/cases\//;
const TEST = /(^|\/)(tests?|__tests__|fixtures?)\//;
const EXEC_EXT = /\.(js|mjs|cjs|sh|bash|ps1|psm1|py|command)$/;
function kindOf(rel, text) {
  if (/\.md$/i.test(rel) || CASES.test(rel)) return null;
  // un reemplazo generado es un nombre VIEJO que sigue andando hasta el retiro, nunca uno nuevo: no depende de qué mapa
  // haya a mano (un mapa de laboratorio sin su entrada lo hacía ver nuevo, tanda C1). Sólo el idéntico a lo que escribe
  // --write-shims: la marca sola se escribe a mano (revisor de seguridad). Con una biblioteca de antes de la C1 (una copia
  // de trabajo a medio actualizar) no hay cómo saberlo: el archivo se mira como cualquier otro, que es el lado que frena.
  const isGenerated = text && require('../lib/legacy-names.js').isGeneratedShim;
  if (typeof isGenerated === 'function' && isGenerated(rel, text)) return null;
  const exec = EXEC_EXT.test(rel) || /(^|\/)\.githooks\//.test(rel) || /^#!/.test(text || '');
  const cfg = /\.json$/.test(rel);
  if (!exec && !cfg) return null;
  if (TEST.test(rel)) return 'test';
  return exec ? 'executable' : 'config';
}
const isExecutable = (rel, text) => EXEC_EXT.test(rel) || /(^|\/)\.githooks\//.test(rel) || /^#!/.test(text || '');
const isShell = (rel, text) => /\.(sh|bash|command)$/.test(rel) || /(^|\/)\.githooks\//.test(rel) || /^#!.*\b(ba|z)?sh\b/.test((text || '').split('\n', 1)[0]);

/** Los segmentos de una ruta que son nombres: las carpetas y el archivo sin su extensión (ni `.test`/`.spec`). */
function pathNames(rel) {
  const segs = rel.split('/');
  const base = segs.pop().replace(/(\.(test|spec))?\.[A-Za-z0-9]+$/, '');
  return [...segs, base].filter(Boolean);
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const SUBVAR = '(?:cmd|command|sub|subcmd|subcommand|subcomando|accion|action|verb|verbo|op|modo|mode)';
// también sobre una propiedad: `switch (a.cmd)`, `switch (args?.cmd)`
const SWITCH = new RegExp(`switch\\s*\\(\\s*(?:(?:[\\w$]+\\??\\.)*${SUBVAR}|process\\.argv\\[2\\]|argv\\[0\\]|args\\[0\\]|args\\._\\[0\\])\\s*\\)\\s*\\{`, 'g');

/**
 * El texto con los comentarios en blanco (mismo largo y mismos saltos de línea: las líneas no se mueven). Una opción o
 * una variable que sólo aparece en un comentario es prosa, no un nombre que la máquina lea. `js`: `//` y `/* *\/`, sin
 * tocar lo que está entre comillas (una URL no abre un comentario). `hash`: `#` al principio o después de un espacio,
 * fuera de comillas (`${#x}` y `$#` no son comentarios).
 */
function blankComments(text, style) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      // en shell, dentro de comillas simples la barra no escapa nada
      if (c === '\\' && !(style === 'hash' && quote === "'")) { i++; continue; }
      if (c === quote) quote = null;
      else if (c === '\n' && quote !== '`' && style === 'js') quote = null;
      continue;
    }
    if (style === 'js') {
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; blank(i, end); i = end - 1; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; blank(i, end); i = end - 1; continue; }
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; blank(i, end); i = end - 1; }
    }
  }
  return out.join('');
}

/** Las etiquetas `case '…':` del bloque de un `switch` que abre en `open` (la `{`), contando sólo llaves de código. */
function switchCases(code, open) {
  const found = [];
  let depth = 0;
  let quote = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (depth === 1 && c === 'c' && !/[\w$.]/.test(code[i - 1] || '')) {
      const cm = /^case\s+(['"])([a-z][a-z0-9-]*)\1\s*:/.exec(code.slice(i, i + 80));
      if (cm) found.push({ name: cm[2], index: i });
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return found;
}
const BASH_CASE = /case\s+"?\$\{?(?:1|cmd|CMD|sub|SUB|accion|ACCION|modo|MODO|comando|COMANDO|command|COMMAND|action|ACTION)(?::-[^}"]*)?\}?"?\s+in\b/g;

/** Los nombres de un archivo, por categoría: `[{ category, name, line }]`. */
function extract(rel, text, { schemaFiles = [], renames = null } = {}) {
  const kind = kindOf(rel, text);
  if (!kind || text === null || text === undefined) return [];
  const out = [];
  const add = (category, name, index) => out.push({ category, name, line: lineAt(text, index) });
  if (isExecutable(rel, text)) {
    const shell = isShell(rel, text);
    const code = blankComments(text, /\.(js|mjs|cjs)$/.test(rel) || /^#!.*\bnode\b/.test(text.split('\n', 1)[0]) ? 'js' : 'hash');
    for (const m of code.matchAll(/(?:^|[\s'"`(\[|,])--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=[\s'"`=)\]|,;:]|$)/gm)) {
      const at = m.index + m[0].indexOf('--');
      const next = code[at + 2 + m[1].length] || '';
      // `--x;` o `((--x))` es un pre-decremento, no una opción
      if (next === ';' || (code[at - 1] === '(' && next === ')')) continue;
      add('option', m[1], at);
    }
    for (const re of [/process\.env(?:\?\.|\.|\[\s*['"`])([A-Za-z_][A-Za-z0-9_]*)/g, /['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s+in\s+process\.env\b/g,
      /os\.environ(?:\.get\(|\[)\s*['"]([A-Za-z_][A-Za-z0-9_]*)/g, /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)/g, /\$env:([A-Za-z_][A-Za-z0-9_]*)/g,
      /\b(TYCON_[A-Z0-9_]*[A-Z0-9])\b/g]) {
      for (const m of code.matchAll(re)) add('env', m[1], m.index);
    }
    // `const { A, B: b = 1 } = process.env`
    for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
      for (const item of m[1].split(',')) {
        const name = item.trim().split(/[:=\s]/)[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) add('env', name, m.index);
      }
    }
    // en shell: `export A=1`, `export A B`, `export A` en su propia línea
    if (shell) {
      for (const m of code.matchAll(/^[ \t]*export[ \t]+([A-Za-z_][^;&|\n]*)/gm)) {
        for (const part of m[1].trim().split(/\s+/)) {
          const name = part.split('=')[0];
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) add('env', name, m.index);
          if (part.includes('=') && /^["']/.test(part.split('=')[1] || '')) break;   // el valor entre comillas puede tener espacios
        }
      }
    }
    // subcomandos: el despacho sobre el argumento de subcomando
    for (const m of code.matchAll(new RegExp(`\\b${SUBVAR}\\s*===?\\s*['"]([a-z][a-z0-9-]*)['"]`, 'g'))) add('subcommand', m[1], m.index);
    for (const m of code.matchAll(new RegExp(`['"]([a-z][a-z0-9-]*)['"]\\s*===?\\s*${SUBVAR}\\b`, 'g'))) add('subcommand', m[1], m.index);
    for (const m of code.matchAll(SWITCH)) for (const c of switchCases(code, m.index + m[0].length - 1)) add('subcommand', c.name, c.index);
    if (shell) {
      for (const m of code.matchAll(BASH_CASE)) {
        let at = m.index + m[0].length;
        let depth = 0;   // un `case … in` anidado dentro de una alternativa no corta el despacho, y sus etiquetas no son subcomandos
        for (const line of code.slice(at).split('\n')) {
          const opens = (line.match(/(?:^|[\s;(])case\s+\S.*?\s+in\b/g) || []).length;
          const closes = (line.match(/(?:^|[\s;])esac\b/g) || []).length;
          if (depth === 0 && closes > opens) break;
          const lm = depth === 0 && !opens ? /^\s*\(?\s*([^()\s#][^()]*?)\s*\)/.exec(line) : null;
          if (lm && !/^\s*[;]/.test(line)) {
            for (const alt of lm[1].split('|').map((x) => x.trim().replace(/^['"]|['"]$/g, ''))) {
              if (/^[a-z][a-z0-9-]*$/.test(alt)) add('subcommand', alt, at + line.indexOf(alt));
            }
          } else if (depth === 0 && opens) {
            // la alternativa puede abrir el case en la misma línea: `run) case "$2" in`
            const head = /^\s*\(?\s*([^()\s#][^()]*?)\s*\)\s*case\b/.exec(line);
            if (head) for (const alt of head[1].split('|').map((x) => x.trim())) if (/^[a-z][a-z0-9-]*$/.test(alt)) add('subcommand', alt, at + line.indexOf(alt));
          }
          depth += opens - closes;
          if (depth < 0) break;
          at += line.length + 1;
        }
      }
    }
    // valores: sólo los que el mapa de renombres declara, en el archivo que los lee (tanda A2 en adelante)
    // el `where` de un valor sigue a su archivo cuando se muda (tanda C2): en la foto de antes, el archivo vive en la ruta
    // vieja del mapa y sus valores tienen que contar como «ya existía» — si no, un valor viejo que el archivo mudado
    // conserva (una etiqueta de pantalla igual al valor) frena como nuevo
    const entriesAll = renames && Array.isArray(renames.entries) ? renames.entries : [];
    const movedFrom = new Set(entriesAll.filter((f) => f && f.kind === 'file' && f.old === rel && typeof f.new === 'string').map((f) => f.new));
    const values = entriesAll.filter((e) => e && e.kind === 'value' && (e.where === rel || movedFrom.has(e.where)));
    for (const e of values) {
      for (const v of [e.old, e.new].filter((x) => typeof x === 'string' && x)) {
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const m of text.matchAll(new RegExp(`(['"\`])${esc}\\1`, 'g'))) add('value', v, m.index);
      }
    }
  }
  if (kind === 'config' && schemaFiles.includes(rel)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new CouldNotLook(`${rel} está en schemaFiles y no es JSON válido (${e.message})`); }
    const keys = new Set();
    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (!k.includes('/')) keys.add(k); walk(v); }
    }(parsed));
    for (const k of keys) {
      const i = text.indexOf(JSON.stringify(k));
      add('key', k, i < 0 ? 0 : i);
    }
  }
  return out;
}

/** Una excepción por ruta (`allowed` con `path`, un glob de la raíz del repo): lo de esos archivos no es nuestro. */
const pathAllowed = (words, rel) => (words.allowedPaths || []).some((a) => exporter.coincide(a.path, rel));

// ── el conteo (el termómetro y --count) ──────────────────────────────────────────────────────────────────────────
/** Cuenta los nombres en castellano de un conjunto de archivos `[{ source, rel, text }]`: los distintos por categoría. */
function countFiles(files, words, det) {
  const detail = { executables: 0, tests: 0, config: 0, optionsOutsideTests: 0 };
  const folders = new Set();
  const sets = { option: new Set(), subcommand: new Set(), value: new Set(), env: new Set(), key: new Set() };
  const optionsOutside = new Set();
  let nFiles = 0;
  const yes = (name) => det.isSpanish(name).spanish;
  for (const f of files) {
    if (f.text === null || f.text === undefined || pathAllowed(words, f.rel)) continue;
    const kind = kindOf(f.rel, f.text);
    if (!kind) continue;
    const names = pathNames(f.rel);
    const base = names[names.length - 1];
    if (yes(base)) {
      nFiles++;
      detail[kind === 'executable' ? 'executables' : kind === 'test' ? 'tests' : 'config']++;
    }
    names.slice(0, -1).forEach((seg, i) => { if (yes(seg)) folders.add(`${f.source}/${names.slice(0, i + 1).join('/')}`); });
    for (const x of extract(f.rel, f.text, { schemaFiles: words.schemaFiles })) {
      if (!yes(x.name)) continue;
      if (x.category === 'subcommand') sets.subcommand.add(`${path.posix.basename(f.rel)} ${x.name}`);
      else sets[x.category].add(x.name);
      if (x.category === 'option' && kind !== 'test') optionsOutside.add(x.name);
    }
  }
  detail.optionsOutsideTests = optionsOutside.size;
  const c = {
    files: nFiles, folders: folders.size, options: sets.option.size, subcommands: sets.subcommand.size, values: sets.value.size,
    env: sets.env.size, keys: sets.key.size,
  };
  c.total = c.files + c.folders + c.options + c.subcommands + c.values + c.env + c.keys;
  return { ...c, detail };
}

/** Para el exportador: el conteo de una copia ya armada (`final`: `{ fuente, ruta, datos }`). */
function countCopy(entries, harnessDir) {
  const words = loadWords(fs.readFileSync(path.join(harnessDir, WORDS_PATH), 'utf8'), WORDS_PATH);
  const det = makeDetector(words, { dictPath: process.env.TYCON_SPANISH_NAMES_DICTIONARY || DEFAULT_DICT });
  const files = entries.map((a) => ({ source: a.fuente, rel: a.ruta, text: textOf(a.datos) }));
  return { ...countFiles(files, words, det), dictionary: det.dictionary };
}

const textOf = (buf) => {
  if (buf === null || buf === undefined) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return b.includes(0) ? null : b.toString('utf8');
};

// ── argumentos ───────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: 'staged', source: 'arnes', json: false };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i] === '' || argv[i].startsWith('--')) throw new CouldNotLook(`${flag} necesita un valor`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = value(++i, x);
    else if (x === '--source') a.source = value(++i, x);
    else if (x === '--staged') a.mode = 'staged';
    else if (x === '--range') { a.mode = 'range'; a.range = value(++i, x); } else if (x === '--count') a.mode = 'count';
    else if (x === '--check-map') a.mode = 'check-map';
    else if (x === '--stale-mentions') a.mode = 'stale-mentions';
    else if (x === '--map') a.map = value(++i, x);
    else if (x === '--map-name') a.mapName = value(++i, x);   // cómo se nombra el mapa en los mensajes (el pre-commit pasa una copia del índice)
    else if (x === '--words') a.words = value(++i, x);
    else if (x === '--json') a.json = true;
    else throw new CouldNotLook(`opción desconocida: ${x}`);
  }
  if (!nn.SOURCES.includes(a.source)) throw new CouldNotLook(`--source es arnes o agent-skills (no «${a.source}»)`);
  return a;
}

// ── las fotos ────────────────────────────────────────────────────────────────────────────────────────────────────
const blobText = (read, source, entry) => (entry && entry.tipo === 'blob' ? textOf(read(source, entry.obj)) : null);

/**
 * Lo que sale en una foto: `files` (clave `source\0rel` → `{ source, rel, text() }`). En modo equipo, la clasificación
 * del exportador con la configuración de esa foto; en modo público, todo el árbol del repo propio.
 */
function shippedOf(snap) {
  const files = new Map();
  if (snap.public) {
    for (const e of snap.trees[snap.source]) {
      if (e.tipo !== 'blob') continue;
      files.set(`${snap.source}\0${e.ruta}`, { source: snap.source, rel: e.ruta, text: () => blobText(snap.read, snap.source, e) });
    }
    return files;
  }
  for (const pk of snap.ships.packages) {
    for (const [, a] of pk.files) {
      if (a.kind === 'translation') continue;
      const k = `${a.fuente}\0${a.ruta}`;
      if (files.has(k)) continue;
      files.set(k, {
        source: a.fuente,
        rel: a.ruta,
        text: () => {
          const pieces = snap.ships.ofFile(a.fuente, a.ruta).filter((p) => p.text !== null);
          return pieces.length ? pieces.map((p) => p.text).join('\n') : null;
        },
      });
    }
  }
  return files;
}

function teamSnapshot(name, trees, ctxBase, strict) {
  const snap = nn.snapshot(name, trees, { ...ctxBase, disk: false, allowMissing: !strict });
  if (snap.missingConfig) return null;
  const lista = nn.parseJson(snap.listText, `${nn.CONFIG.list} (${name})`);
  const table = nn.parseJson(snap.tableText, `${nn.CONFIG.table} (${name})`);
  const ctx = nn.contextFor(snap, { lista, table, strict });
  return nn.ships(snap, ctx);
}

// ── la corrida ───────────────────────────────────────────────────────────────────────────────────────────────────
function run(args) {
  const t0 = Date.now();
  const source = args.source;
  const other = source === 'arnes' ? 'agent-skills' : 'arnes';
  const startDir = args.repo ? path.resolve(args.repo) : process.cwd();
  if (!fs.existsSync(startDir)) throw new CouldNotLook(`--repo ${startDir} no existe`);
  const repo = nn.realOr(nn.hookGit(startDir, ['rev-parse', '--show-toplevel']).trim());

  // 1 · qué cambia, contra cada padre
  let parents;
  let afterTree;
  let range = null;
  if (args.mode === 'range') {
    const m = /^(.+?)(\.{2,3})(.+)$/.exec(args.range);
    if (!m) throw new CouldNotLook(`--range ${args.range}: tiene que ser <base>...<punta> o <base>..<punta>`);
    const rev = (ref) => {
      const r = nn.isolated(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: true });
      if (r.status !== 0) throw new CouldNotLook(`no encuentro el commit «${ref}» en ${repo}`);
      return r.stdout.trim();
    };
    const tip = rev(m[3]);
    const base = m[2] === '...' ? nn.isolated(repo, ['merge-base', rev(m[1]), tip]).stdout.trim() : rev(m[1]);
    const commits = Number(nn.isolated(repo, ['rev-list', '--count', `${base}..${tip}`]).stdout.trim());
    if (!commits) return { outcome: 'not-measured', message: `nombres en castellano: no medido: el rango no trae commits (${args.range}) — la red de esta corrida es el termómetro nocturno` };
    parents = [{ sha: base, changes: nn.parseChanges(nn.isolated(repo, ['diff', '-M', '-z', '--name-status', base, tip]).stdout) }];
    afterTree = () => nn.commitTree(repo, tip);
    range = { base, tip };
  } else {
    const { spawnSync } = require('child_process');
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: repo, env: process.env, encoding: 'utf8' });
    const shas = head.status === 0 ? [head.stdout.trim()] : [null];
    const mergeAbs = path.resolve(repo, nn.hookGit(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
    if (shas[0] && fs.existsSync(mergeAbs)) shas.push(...fs.readFileSync(mergeAbs, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));
    parents = shas.map((sha) => ({ sha, changes: nn.parseChanges(nn.hookGit(repo, ['diff-index', '--cached', '-M', '-z', '--name-status', sha || nn.EMPTY_TREE])) }));
    afterTree = () => nn.indexTree(repo);
  }
  // story 8.18: en el repo unido (el arnés con agent-skills adentro) esta corrida mira sólo los cambios de su fuente
  // lógica, y la otra fuente es la otra mitad del mismo árbol: no se lee ningún otro clon (ver new-names.js). En un
  // rango que cruza la unión (el pull request del corte), la mitad que la base no trae se compara con su historia.
  let afterMemo = null;
  const afterOnce = () => (afterMemo || (afterMemo = afterTree()));
  const unified = nn.unifiedCheckout(repo) && (args.mode !== 'range' || nn.unifiedTree(afterOnce()));
  if (unified) parents = nn.unifiedParents(repo, parents, source, range);

  // 2 · si nada de lo tocado es un ejecutable, configuración, prueba o disparador, no se carga nada
  const touched = parents.flatMap((p) => p.changes);
  const trigger = (rel) => (source === 'arnes' && TRIGGERS.includes(rel)) || (source === 'agent-skills' && PACK.test(rel));
  // Por la ruta sola no se sabe: un `.zsh` o un `.template` con `#!` es un ejecutable (kindOf mira el texto). Acá sólo
  // se descarta lo que seguro no se mira; el resto lo decide kindOf con el contenido (pase adversarial, 5b).
  const maybe = (rel) => !!rel && (trigger(rel) || (!/\.md$/i.test(rel) && !CASES.test(rel)));
  if (!touched.some((c) => (c.status !== 'D' && maybe(c.path)) || maybe(c.oldPath))) return { outcome: 'quiet' };

  // 3 · el modo: el arnés del equipo tiene perfil; la copia pública, no
  const otherInfo = unified ? { dir: repo } : nn.otherRepo(source);
  const harnessDisk = source === 'arnes' ? repo : otherInfo.dir;
  if (source === 'agent-skills' && otherInfo.missing) return { outcome: 'other-repo-missing', otherDir: otherInfo.dir, other };
  const isPublic = !hasProfile(harnessDisk);
  if (!isPublic && otherInfo.missing) return { outcome: 'other-repo-missing', otherDir: otherInfo.dir, other };

  const dirs = { [source]: repo, [other]: otherInfo.dir };
  const read = nn.blobReader(dirs);
  const trees = unified ? nn.splitTree(afterOnce()) : { [source]: afterOnce() };
  if (!isPublic && !unified) trees[other] = nn.commitTree(otherInfo.dir, otherInfo.head);
  // la copia de un solo repo (story 8.7, AC 11): el arnés y agent-skills viven en la MISMA raíz, así que el árbol del
  // otro es el mismo índice (y en cada antes, el mismo commit) — si no, el lado agent-skills no encuentra la lista
  const mismaRaiz = isPublic && !otherInfo.missing && path.resolve(otherInfo.dir || '') === path.resolve(repo);
  if (mismaRaiz) trees[other] = trees[source];
  const beforeTrees = parents.map((p) => {
    if (unified) return nn.beforeHalves(repo, p);   // el antes de las dos fuentes: del mismo padre, o de su historia
    const t = { [source]: nn.commitTree(repo, p.sha) };
    if (!isPublic) t[other] = trees[other];
    else if (mismaRaiz) t[other] = t[source];
    return t;
  });
  const harnessTree = (t) => (unified || source === 'arnes' ? t.arnes : trees.arnes || []);
  const harnessText = (t, rel) => {
    const e = (harnessTree(t) || []).find((x) => x.ruta === rel);
    return blobText(read, 'arnes', e);
  };

  // 4 · la lista: la del después (sus palabras nuevas cuentan); las excepciones, sólo las que ya estaban (una excepción
  //     que llega en el mismo commit que el nombre que la necesita no vale: va aparte y la decide una persona)
  const afterWordsText = harnessText(trees, WORDS_PATH);
  if (afterWordsText === null) throw new CouldNotLook(`no está ${WORDS_PATH} — sin la lista de palabras no sé qué es castellano`);
  const afterWords = loadWords(afterWordsText, WORDS_PATH);
  let beforeWords = null;
  const beforeWordsText = parents[0].sha ? harnessText(beforeTrees[0], WORDS_PATH) : null;
  if (beforeWordsText !== null) {
    try { beforeWords = loadWords(beforeWordsText, `${WORDS_PATH} (antes)`); } catch (e) {
      say(`⚠️  nombres en castellano: la lista de antes no se deja leer (${e.message}) — las excepciones de este commit cuentan como si ya estuvieran`);
    }
  }
  const words = {
    ...afterWords,
    words: new Set([...afterWords.words, ...(beforeWords ? beforeWords.words : [])]),
    allowed: beforeWords ? new Set([...afterWords.allowed].filter((w) => beforeWords.allowed.has(w))) : afterWords.allowed,
    allowedPaths: beforeWords ? afterWords.allowedPaths.filter((a) => beforeWords.allowedPaths.some((b) => b.path === a.path)) : afterWords.allowedPaths,
    schemaFiles: [...new Set([...afterWords.schemaFiles, ...(beforeWords ? beforeWords.schemaFiles : [])])],
  };
  // una ambigua nueva también es una excepción (baja la palabra a «cuenta sólo con otra»): vale recién en el commit siguiente
  words.ambiguous = new Set([...afterWords.ambiguous].filter((w) => !words.words.has(w) && (!beforeWords || beforeWords.ambiguous.has(w))));
  const det = makeDetector(words, { dictPath: process.env.TYCON_SPANISH_NAMES_DICTIONARY || DEFAULT_DICT });
  if (!det.dictionary) say(`⚠️  nombres en castellano: sin diccionario inglés (${det.dictPath}) — uso sólo la lista de palabras`);
  let renames = null;
  const renamesText = harnessText(trees, RENAMES_PATH);
  if (renamesText !== null) renames = nn.parseJson(renamesText, RENAMES_PATH);
  const opts = { schemaFiles: words.schemaFiles, renames };

  // 5 · lo que sale, después y antes
  const ctxBase = { dirs, read, harnessDisk };
  let afterShip;
  let beforeShips;
  if (isPublic) {
    afterShip = shippedOf({ public: true, source, trees, read });
    beforeShips = beforeTrees.map((t) => shippedOf({ public: true, source, trees: t, read }));
  } else {
    afterShip = shippedOf({ ships: teamSnapshot('el después', trees, ctxBase, true) });
    beforeShips = beforeTrees.map((t, i) => {
      const sh = parents[i].sha ? teamSnapshot(`el antes (${parents[i].sha.slice(0, 12)})`, t, ctxBase, false) : null;
      return sh ? shippedOf({ ships: sh }) : new Map();
    });
  }

  // 6 · qué se mira: lo cambiado (contra todos los padres) que sale, y lo que empieza a salir
  const changedIn = parents.map((p) => new Map(p.changes.map((c) => [c.path, c])));
  // ¿empieza a salir? (no salía antes: en un merge, en alguno de los padres)
  const startsShipping = (k) => !beforeShips.every((b) => b.has(k)) && !(beforeShips.some((b) => b.has(k)) && parents.length === 1);
  const looked = new Map();   // key → { source, rel, newPath }
  for (const c of parents[0].changes) {
    if (c.status === 'D') continue;
    if (!changedIn.every((m) => m.has(c.path) && m.get(c.path).status !== 'D')) continue;
    const k = `${source}\0${c.path}`;
    if (!afterShip.has(k)) continue;
    // la ruta es nueva para la copia si el archivo es nuevo, o si empieza a salir aunque el commit además lo modifique
    // (story 8.18, pase adversarial del tramo 2, clase 8: un modificado que empieza a salir por la lista blanca no se
    // juzgaba por su ruta, y en el repo unido el reparto del doble aviso se lo deja a esta corrida, la de su fuente)
    const newPath = changedIn.every((m) => ['A', 'R', 'C'].includes(m.get(c.path).status)) || startsShipping(k);
    looked.set(k, { source, rel: c.path, newPath });
  }
  // en el repo unido, cada archivo que empieza a salir lo mira una sola de las dos corridas ([DEF-8.18-doble-aviso])
  const mine = unified ? nn.startsHere(source, parents) : () => true;
  for (const [k, f] of afterShip) {
    if (looked.has(k)) continue;
    if (!startsShipping(k)) continue;
    if (!mine(f.source, f.rel)) continue;
    looked.set(k, { source: f.source, rel: f.rel, newPath: true });
  }

  // 7 · los candidatos: nombres en castellano de lo que se mira
  const candidates = [];
  for (const x of looked.values()) {
    const f = afterShip.get(`${x.source}\0${x.rel}`);
    if (pathAllowed(words, x.rel)) continue;
    const text = f.text();
    if (!kindOf(x.rel, text)) continue;
    if (x.newPath) {
      for (const seg of pathNames(x.rel)) {
        const s = det.isSpanish(seg);
        if (s.spanish) candidates.push({ category: 'path', name: seg, words: s.words, source: x.source, rel: x.rel });
      }
    }
    const seen = new Set();
    for (const n of extract(x.rel, text, opts)) {
      const key = `${n.category}\0${n.name}`;
      if (seen.has(key)) continue;
      const s = det.isSpanish(n.name);
      if (!s.spanish) continue;
      seen.add(key);
      candidates.push({ ...n, words: s.words, source: x.source, rel: x.rel });
    }
  }

  // 8 · ¿ya existía en lo que salía antes? (en algún padre; los dos repos)
  const findings = [];
  if (candidates.length) {
    const pathSets = beforeShips.map((b) => {
      const s = new Set();
      for (const f of b.values()) if (!/\.md$/i.test(f.rel) && !CASES.test(f.rel)) for (const seg of pathNames(f.rel)) s.add(seg.toLowerCase());
      return s;
    });
    const contentNames = candidates.filter((c) => c.category !== 'path');
    const existing = beforeShips.map((b) => {
      const found = new Set();
      if (!contentNames.length) return found;
      for (const f of b.values()) {
        if (!maybe(f.rel)) continue;
        const want = contentNames.filter((c) => !found.has(`${c.category}\0${c.name}`));
        if (!want.length) break;
        const text = f.text();
        if (text === null || !want.some((c) => text.includes(c.name))) continue;
        for (const n of extract(f.rel, text, opts)) found.add(`${n.category}\0${n.name}`);
      }
      return found;
    });
    const reported = new Set();
    for (const c of candidates) {
      const exists = c.category === 'path'
        ? pathSets.some((s) => s.has(c.name.toLowerCase()))
        : existing.some((s) => s.has(`${c.category}\0${c.name}`));
      const id = `${c.category}\0${c.name}\0${c.rel}`;
      if (exists || reported.has(id)) continue;
      reported.add(id);
      findings.push({ ...c, proposal: propose(c.name, det, words) });
    }
  }

  // 9 · el techo sólo sube en el commit que suma palabras a words
  if (source === 'arnes' && touched.some((c) => nn.isConfigPath(CEILING_PATH, c.path) || nn.isConfigPath(CEILING_PATH, c.oldPath))) {
    // el techo de cada foto: con la ruta nueva o, en una foto de antes de la mudanza (tanda C4: la base del PR de la
    // mudanza, o la punta de un rango histórico), con la vieja que dice el mapa (nunca escrita acá)
    const pathIn = (t) => nn.configPathIn(new Map((harnessTree(t || {}) || []).map((x) => [x.ruta, x])), CEILING_PATH) || CEILING_PATH;
    const b = parents[0].sha ? harnessText(beforeTrees[0], pathIn(beforeTrees[0])) : null;
    const a = harnessText(trees, pathIn(trees));
    if (b !== null && a !== null) {
      const before = nn.parseJson(b, `${CEILING_PATH} (antes)`);
      const after = nn.parseJson(a, CEILING_PATH);
      // un paquete renombrado (tanda B3a: `nucleo` → `core`, entrada value del exportador en el mapa) conserva su techo con
      // el nombre nuevo: pasar la clave no es «perder la cifra»
      const renamesText = harnessText(trees, RENAMES_PATH);
      const renamedPkg = new Map();
      if (renamesText !== null) {
        const m = nn.parseJson(renamesText, RENAMES_PATH);
        const entries = Array.isArray(m && m.entries) ? m.entries : [];
        // el exportador se mudó en la tanda C2: el mapa de una foto de antes nombra su valor con la ruta vieja, que sale
        // de la entrada `file` de ese mismo mapa (nunca escrita acá)
        const exporterWhere = new Set([nn.CONFIG.exporter,
          ...entries.filter((e) => e && e.kind === 'file' && e.new === nn.CONFIG.exporter && typeof e.old === 'string').map((e) => e.old)]);
        for (const e of entries) {
          if (e && e.kind === 'value' && e.option === 'package' && exporterWhere.has(e.where)) renamedPkg.set(e.old, e.new);
        }
      }
      const raised = [];
      for (const [pkg, nums] of Object.entries(before)) {
        if (pkg.startsWith('__') || !nums || typeof nums !== 'object') continue;
        const pkgAfter = after[pkg] === undefined && renamedPkg.has(pkg) ? renamedPkg.get(pkg) : pkg;
        for (const [k, was] of Object.entries(nums)) {
          if (typeof was !== 'number') continue;
          const now = after[pkgAfter] && typeof after[pkgAfter] === 'object' ? after[pkgAfter][k] : undefined;
          if (typeof now !== 'number') raised.push(`${pkg}.${k} pasa de ${was} a ${now === undefined ? 'sin cifra' : JSON.stringify(now)}`);
          else if (now > was) raised.push(`${pkg}.${k} sube de ${was} a ${now}`);
        }
      }
      const newWords = beforeWords ? [...afterWords.words].filter((w) => !beforeWords.words.has(w)) : [];
      if (raised.length && !newWords.length) findings.push({ category: 'ceiling', raised });
    } else if (a !== null) nn.parseJson(a, CEILING_PATH);
  }

  return { outcome: findings.length ? 'blocked' : 'clean', findings, files: looked.size, isPublic, ms: Date.now() - t0, source };
}

// ── el mensaje ───────────────────────────────────────────────────────────────────────────────────────────────────
function report(result) {
  const l = [`🛑 nombres nuevos en castellano en lo que ejecuta la máquina — el commit no se crea (${result.findings.length} hallazgo(s)):`, ''];
  let names = 0;
  for (const f of result.findings) {
    if (f.category === 'ceiling') {
      l.push(`  ${CEILING_PATH}: ${f.raised.join(' · ')} sin que el commit sume palabras a ${WORDS_PATH} — el techo sólo baja, salvo en el commit que le enseña palabras a la lista`);
      continue;
    }
    names++;
    const where = `${f.source === result.source ? '' : `${f.source}: `}${f.rel}${f.category === 'path' ? '' : `:${f.line}`}`;
    const shown = f.category === 'option' ? `--${f.name}` : f.name;
    const prop = f.proposal ? ` → en inglés: ${f.category === 'option' ? `--${f.proposal}` : f.proposal}` : ' → el glosario no tiene todas sus palabras: elegí el nombre en inglés';
    l.push(`  ${where}  [${LABEL[f.category]}]  ${shown} — en castellano: ${f.words.join(', ')}${prop}`);
  }
  if (names) {
    l.push('', 'Cómo salir, en este orden:',
      '  (a) El nombre en inglés (la propuesta al lado de cada hallazgo; el glosario está en guides/nombres-en-ingles.md).',
      '  (b) Si la palabra es inglés técnico, un nombre propio o un slug ajeno: un «allowed» con su reason en',
      `      ${WORDS_PATH}, en un commit aparte y decidido por una persona.`);
  }
  l.push('', 'Guía: guides/nombres-en-ingles.md.');
  return l.join('\n');
}

function record(args, { outcome, verdict, rule, findings = [] }) {
  if (args.mode !== 'staged') return;
  const print = JSON.stringify([args.source, findings.map((f) => [f.category, f.source || '', f.rel || '', f.line || 0])]);
  try {
    require('../lib/guard-record.js').anotar({ freno: 'spanish-names', regla: rule, veredicto: verdict, cmd: print });
  } catch { /* la constancia es ayuda, no evidencia: nunca rompe el commit */ }
  void outcome;
}

// ── --count ──────────────────────────────────────────────────────────────────────────────────────────────────────
function count(args) {
  const startDir = args.repo ? path.resolve(args.repo) : process.cwd();
  const repo = nn.realOr(nn.hookGit(startDir, ['rev-parse', '--show-toplevel']).trim());
  const wordsFile = args.words ? path.resolve(args.words)
    : [path.join(repo, WORDS_PATH), path.resolve(__dirname, '..', '..', WORDS_PATH)].find((p) => fs.existsSync(p));
  if (!wordsFile || !fs.existsSync(wordsFile)) throw new CouldNotLook(`no está ${WORDS_PATH} — sin la lista de palabras no sé qué es castellano`);
  const words = loadWords(fs.readFileSync(wordsFile, 'utf8'), WORDS_PATH);
  const det = makeDetector(words, { dictPath: process.env.TYCON_SPANISH_NAMES_DICTIONARY || DEFAULT_DICT });
  if (!det.dictionary) say(`⚠️  nombres en castellano: sin diccionario inglés (${det.dictPath}) — uso sólo la lista de palabras`);
  const isPublic = !hasProfile(repo);
  const packages = {};
  if (isPublic) {
    const tree = nn.commitTree(repo, 'HEAD');
    const read = nn.blobReader({ arnes: repo, 'agent-skills': repo });
    packages.copy = countFiles(tree.filter((e) => e.tipo === 'blob').map((e) => ({ source: 'arnes', rel: e.ruta, text: blobText(read, 'arnes', e) })), words, det);
  } else {
    // story 8.18: en el repo unido las dos fuentes son las dos mitades del mismo HEAD, partidas por ruta
    const unified = nn.unifiedCheckout(repo);
    const otherInfo = unified ? { dir: repo } : nn.otherRepo('arnes');
    if (otherInfo.missing) throw new CouldNotLook(`no encontré agent-skills (${otherInfo.dir}): sin la segunda fuente no hay copia que contar`);
    const dirs = { arnes: repo, 'agent-skills': otherInfo.dir };
    const read = nn.blobReader(dirs);
    const trees = unified ? nn.splitTree(nn.commitTree(repo, 'HEAD'))
      : { arnes: nn.commitTree(repo, 'HEAD'), 'agent-skills': nn.commitTree(otherInfo.dir, otherInfo.head) };
    const ships = teamSnapshot('HEAD', trees, { dirs, read, harnessDisk: repo }, false);
    if (!ships) throw new CouldNotLook(`HEAD no tiene ${nn.CONFIG.list} ni ${nn.CONFIG.table}: sin la lista blanca no sé qué sale`);
    for (const pk of ships.packages) {
      const files = [];
      for (const [clave, a] of pk.files) if (a.kind !== 'translation') files.push({ source: a.fuente, rel: a.ruta, text: textOf(pk.content(clave)) });
      packages[pk.pkg] = countFiles(files, words, det);
    }
  }
  return { mode: isPublic ? 'public' : 'team', dictionary: det.dictionary, packages };
}

// ── --check-map: el validador del mapa de renombres (tanda A2, AC 13) ───────────────────────────────────────────
/**
 * Los problemas del mapa (scripts/lib/renames.json o `--map`), sobre el disco de `--repo`: forma de cada entrada, un
 * `old` o un `new` repetido en el mismo kind y where, un `new` en castellano, un `new` que choca, un valor o una clave sin
 * su `where`, y un archivo que llaman de afuera sin su reemplazo. Sin mapa no hay nada que validar.
 */
const ENTRY_KEYS = ['kind', 'old', 'new', 'where', 'batch', 'callers', 'repo', 'repeatable', 'option', 'assigned_to', 'role', 'role_waiver', 'homonyms'];
// `homonyms` (story 8.12, AC 37): los archivos del repo de la entrada donde su nombre viejo es OTRO archivo que se llama
// igual (el pipeline de cada producto se llama como el nocturno de métricas del arnés, que se mudó a `pipelines/`). Cada uno, un
// glob relativo a la raíz de ese repo (`**` cruza carpetas, `*` y `?` no) y el motivo. --stale-mentions no cuenta esa
// entrada en esos archivos; en cualquier otro, sí; y un glob que no matchea nada frena (una lista vieja no tapa callada).
const HOMONYM_KEYS = ['glob', 'reason'];
/** Los problemas de forma de `homonyms` de una entrada (los dos modos los usan: --check-map los lista, --stale-mentions frena). */
function homonymProblems(e, at) {
  if (e.homonyms === undefined) return [];
  if (!Array.isArray(e.homonyms) || !e.homonyms.length) return [`${at}: homonyms es una lista no vacía de { glob, reason }`];
  const problems = [];
  e.homonyms.forEach((h, j) => {
    const hat = `${at}: homonyms[${j}]`;
    if (!h || typeof h !== 'object' || Array.isArray(h)) { problems.push(`${hat} no es un objeto { glob, reason }`); return; }
    for (const k of Object.keys(h)) if (!HOMONYM_KEYS.includes(k)) problems.push(`${hat}: campo desconocido «${k}» en homonyms (van ${HOMONYM_KEYS.join(', ')})`);
    if (typeof h.glob !== 'string' || !h.glob.trim()) problems.push(`${hat}: el glob de homonyms es un texto no vacío`);
    else if (h.glob.startsWith('/') || h.glob.split('/').some((s) => s === '..' || s === '.')) problems.push(`${hat}: el glob de homonyms «${h.glob}» es relativo a la raíz del repo, sin «/» delante ni segmentos «..» o «.»`);
    if (typeof h.reason !== 'string' || !h.reason.trim()) problems.push(`${hat}: homonyms lleva el motivo (reason) de por qué ahí el nombre es otro archivo`);
  });
  return problems;
}
// El rol de un hook va en su nombre (story 8.12, AC 7): todo archivo que llega a scripts/hooks/ declara `role`, y con un
// rol que no es `none` su nombre termina en `-<rol>` (`x-guard.js`, `x-notice.sh`, `x-meter.js`).
const HOOKS_DIR = 'scripts/hooks/';
const HOOK_ROLES = ['guard', 'notice', 'meter', 'none'];
// 🔴 Las únicas entradas que pueden saltear el sufijo con `role_waiver`: las que la 8.9 cargó antes de que existiera la
// regla, y que la tabla de constancia de guides/nombres-en-ingles.md deja con su nombre (decisión del dueño, 2026-10-01).
// Una entrada nueva no entra acá: se nombra con su sufijo. Van por su nombre NUEVO: el viejo no se escribe fuera del mapa
// (--stale-mentions lo marcaría), y el nuevo identifica la entrada igual.
const ROLE_WAIVER_NEWS = new Set(['scripts/hooks/advisor-liveness-on-change.js']);
const NAME_RULES = {
  env: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, why: 'no es un nombre de variable (letras, dígitos y «_»)' },
  option: { re: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, why: 'no es un nombre de opción: va sin los guiones, con letras, dígitos, «.», «_» y «-»' },
  subcommand: { re: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, why: 'no es un nombre de subcomando (letras, dígitos, «.», «_» y «-»)' },
  value: { re: /^[^\s'"`\\]+$/, why: 'tiene espacios, comillas o barras invertidas' },
  key: { re: /^[^\s'"`\\/]+$/, why: 'tiene espacios, comillas o barras' },
};
/** ¿Una fecha AAAA-MM-DD que existe? (`2026-13-45` tiene la forma y no existe). */
const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Un mes 13 no da una fecha corrida: da una fecha inválida, y toISOString revienta en vez de contestar.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
/**
 * ¿La carpeta nueva tiene sólo lo que llegó antes que su carpeta? Una sola mudanza por archivo (story 8.9, «Estructura
 * destino»): un archivo renombrado en C1-C3 va directo a su destino final, que puede ser la carpeta nueva de una entrada
 * `folder` que todavía no se mudó. Eso no es un choque si cada archivo de la carpeta nueva es el `new` de una entrada
 * `file` del mismo repo que viene de la carpeta vieja. Cualquier otro archivo ahí sí lo es. Cuenta lo que git versiona: un
 * `.DS_Store` o un archivo de un editor no es un choque (pase adversarial, tanda C1); sin git, el disco.
 */
function onlyArrivals(e, newAbs, entries) {
  const repo = e.repo || 'arnes';
  const arrivals = new Set(entries.filter((x) => x && x.kind === 'file' && (x.repo || 'arnes') === repo
    && typeof x.old === 'string' && typeof x.new === 'string' && x.old.startsWith(`${e.old}/`) && x.new.startsWith(`${e.new}/`)).map((x) => x.new));
  const root = newAbs.slice(0, newAbs.length - e.new.length);
  // sin repo (o sin git), el disco; si git falla de verdad, frena: caer callado al disco haría de un `.DS_Store` un choque, y
  // de un git roto un veredicto (pase adversarial de la story 8.12, R2, revisor de fallos silenciosos)
  const ls = require('../lib/legacy-names.js').gitAt(root, ['ls-files', '-z', '--', e.new]);
  if (ls.failed) throw new CouldNotLook(`no pude preguntarle a git qué versiona ${e.new} en ${root} (${ls.why}) para saber si la carpeta nueva tiene sólo lo que llegó antes — «no pude preguntar» no es «no hay nada»`);
  if (!ls.notARepo) return ls.r.stdout.split('\0').filter(Boolean).every((f) => arrivals.has(f));
  const walk = (dir, rel) => fs.readdirSync(dir, { withFileTypes: true })
    .every((f) => (f.isDirectory() ? walk(path.join(dir, f.name), `${rel}/${f.name}`) : arrivals.has(`${rel}/${f.name}`)));
  return walk(newAbs, e.new);
}
/** Los problemas de `role` y `role_waiver` de una entrada (story 8.12, AC 7). */
function roleProblems(e, at) {
  const problems = [];
  const isHook = e.kind === 'file' && typeof e.new === 'string' && e.new.startsWith(HOOKS_DIR);
  if (e.role !== undefined && !isHook) problems.push(`${at}: role va sólo en un file cuyo new está bajo ${HOOKS_DIR}`);
  else if (isHook && e.role === undefined) problems.push(`${at}: un hook (new bajo ${HOOKS_DIR}) declara su role: ${HOOK_ROLES.join(', ')}`);
  else if (isHook && !HOOK_ROLES.includes(e.role)) problems.push(`${at}: role «${e.role}» desconocido (${HOOK_ROLES.join(', ')})`);
  if (e.role_waiver !== undefined) {
    if (typeof e.role_waiver !== 'string' || !e.role_waiver.trim()) problems.push(`${at}: role_waiver es el motivo de la excepción, un texto no vacío`);
    else if (!ROLE_WAIVER_NEWS.has(e.new)) problems.push(`${at}: role_waiver sólo vale para las entradas de la tabla de constancia que la 8.9 cargó antes de la regla`);
    if (e.role === undefined || e.role === 'none') problems.push(`${at}: role_waiver va sólo con un role que pide sufijo (guard, notice, meter)`);
  }
  if (isHook && HOOK_ROLES.includes(e.role) && e.role !== 'none') {
    const base = path.posix.basename(e.new).replace(/\.[^.]+$/, '');
    const waived = typeof e.role_waiver === 'string' && e.role_waiver.trim() && ROLE_WAIVER_NEWS.has(e.new);
    if (!base.endsWith(`-${e.role}`) && !waived) problems.push(`${at}: un hook con role ${e.role} se llama «…-${e.role}» (el nuevo es ${e.new})`);
  }
  return problems;
}

function checkMap(args) {
  const legacy = require('../lib/legacy-names.js');
  const repo = path.resolve(args.repo || process.cwd());
  const file = args.map ? path.resolve(args.map) : path.join(repo, RENAMES_PATH);
  if (!fs.existsSync(file)) return { file, problems: [], entries: 0, missing: true };
  let map;
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new CouldNotLook(`el mapa de renombres ${args.mapName || file} no es JSON válido (${e.message})`); }
  const wordsFile = args.words ? path.resolve(args.words)
    : [path.join(repo, WORDS_PATH), path.resolve(__dirname, '..', '..', WORDS_PATH)].find((p) => fs.existsSync(p));
  if (!wordsFile) throw new CouldNotLook(`no está ${WORDS_PATH} — sin la lista de palabras no sé si un nombre nuevo es castellano`);
  const words = loadWords(fs.readFileSync(wordsFile, 'utf8'), WORDS_PATH);
  const det = makeDetector(words, { dictPath: process.env.TYCON_SPANISH_NAMES_DICTIONARY || DEFAULT_DICT });
  const problems = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new CouldNotLook(`el mapa de renombres ${file} tiene que ser un objeto`);
  for (const k of Object.keys(map)) if (!k.startsWith('__') && !['retire_after', 'entries'].includes(k)) problems.push(`clave desconocida «${k}» (van retire_after, entries y comentarios __…)`);
  if (!(map.retire_after === null || map.retire_after === undefined || realDate(String(map.retire_after)))) problems.push(`retire_after tiene que ser una fecha AAAA-MM-DD que exista, o null (es ${JSON.stringify(map.retire_after)})`);
  if (!Array.isArray(map.entries)) { problems.push('«entries» tiene que ser una lista'); return { file, problems, entries: 0 }; }
  let skillsRoot = null;
  const rootOf = (e) => {
    if (e.repo !== 'agent-skills') return repo;
    if (skillsRoot === null) {
      // story 8.18: en el repo unido agent-skills está en esta misma raíz, con sus rutas de siempre
      const o = nn.unifiedCheckout(repo) ? { dir: repo } : nn.otherRepo('arnes');
      skillsRoot = !o.missing && o.dir && fs.existsSync(o.dir) ? o.dir : '';
    }
    return skillsRoot || null;
  };
  const seen = new Map();
  const isFile = (e) => e.kind === 'file' || e.kind === 'folder';
  map.entries.forEach((e, i) => {
    const at = `entries[${i}]${e && e.old ? ` (${e.old})` : ''}`;
    if (!e || typeof e !== 'object') { problems.push(`${at}: no es un objeto`); return; }
    for (const k of Object.keys(e)) if (!k.startsWith('__') && !ENTRY_KEYS.includes(k)) problems.push(`${at}: campo desconocido «${k}» (van ${ENTRY_KEYS.join(', ')})`);
    if (!legacy.KINDS.includes(e.kind)) { problems.push(`${at}: kind «${e.kind}» desconocido (${legacy.KINDS.join(', ')})`); return; }
    for (const k of ['old', 'new', 'batch']) if (typeof e[k] !== 'string' || !e[k]) problems.push(`${at}: falta «${k}»`);
    if (typeof e.old !== 'string' || typeof e.new !== 'string') return;
    if (e.old === e.new) problems.push(`${at}: old y new son iguales`);
    if (['option', 'subcommand', 'value', 'key'].includes(e.kind) && (typeof e.where !== 'string' || !e.where)) problems.push(`${at}: un ${e.kind} tiene que nombrar su where (el script o archivo que lo lee)`);
    if (e.repo !== undefined && !['arnes', 'agent-skills'].includes(e.repo)) problems.push(`${at}: repo es arnes o agent-skills (no «${e.repo}»)`);
    if (e.repeatable !== undefined && (e.kind !== 'option' || typeof e.repeatable !== 'boolean')) problems.push(`${at}: repeatable es true/false y sólo en una opción`);
    // un valor dice de qué opción es (su nombre nuevo, sin guiones): así se traduce sólo ahí y --stale-mentions lo encuentra (tanda B3a)
    if (e.kind === 'value' && (typeof e.option !== 'string' || !NAME_RULES.option.re.test(e.option))) problems.push(`${at}: un value tiene que nombrar su option (la opción cuyo valor es, con su nombre nuevo y sin guiones)`);
    if (e.kind !== 'value' && e.option !== undefined) problems.push(`${at}: option va sólo en un value`);
    // un valor que no es de una opción de línea de comandos declara a qué claves o variables se asigna (tanda G): ahí lo
    // busca --stale-mentions (`"<nombre>": <viejo>`, `<NOMBRE>=<viejo>`)
    if (e.assigned_to !== undefined) {
      if (e.kind !== 'value') problems.push(`${at}: assigned_to va sólo en un value`);
      else if (!Array.isArray(e.assigned_to) || !e.assigned_to.length || e.assigned_to.some((n) => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) {
        problems.push(`${at}: assigned_to es una lista de nombres de clave o de variable (letras, números y _)`);
      }
    }
    if (isFile(e)) {
      if (!Array.isArray(e.callers) || !e.callers.length || e.callers.some((c) => !legacy.CALLERS.includes(c))) problems.push(`${at}: callers tiene que ser una lista de ${legacy.CALLERS.join(', ')}`);
    } else if (e.callers !== undefined) problems.push(`${at}: callers va sólo en file y folder`);
    problems.push(...roleProblems(e, at));
    problems.push(...homonymProblems(e, at));
    // las rutas: relativas, sin `..` ni `.`, con caracteres de ruta (nunca salen de la raíz ni de la HOME)
    let pathsOk = true;
    if (['file', 'folder', 'config-file', 'state-file'].includes(e.kind)) {
      for (const side of ['old', 'new']) {
        const why = legacy.pathProblem(e[side], e.kind);
        if (why) { problems.push(`${at}: la ruta ${side} «${e[side]}» ${why}`); pathsOk = false; }
      }
    } else if (NAME_RULES[e.kind]) {
      for (const side of ['old', 'new']) {
        if (!NAME_RULES[e.kind].re.test(e[side])) problems.push(`${at}: el ${side} «${e[side]}» ${NAME_RULES[e.kind].why}`);
      }
    }
    // repetidos: las variables y los archivos de la HOME son globales (el repo y el where no los separan)
    const scope = ['env', 'config-file', 'state-file'].includes(e.kind) ? '' : isFile(e) ? `\0${e.repo || 'arnes'}` : `${e.where || ''}\0${e.repo || 'arnes'}`;
    for (const side of ['old', 'new']) {
      const k = `${e.kind}\0${scope}\0${side}\0${e[side]}`;
      if (seen.has(k)) problems.push(`${at}: el ${side} «${e[side]}» se repite con ${seen.get(k)} (mismo kind y where)`);
      else seen.set(k, at);
    }
    // de una ruta se juzgan sólo los nombres que el old no tenía: un archivo o una carpeta que nada más se muda conserva su
    // nombre, también uno en castellano que la 8.9 decidió dejar así (story 8.12, AC 1). Un `file` que cambia de nombre
    // es nuevo y se juzga ENTERO, también la carpeta que ya tenía (pase spec-first de la R1)
    const keepsName = e.kind === 'folder' || path.posix.basename(e.old) === path.posix.basename(e.new);
    const before = isFile(e) && keepsName ? new Set(pathNames(e.old)) : new Set();
    const names = isFile(e) ? pathNames(e.new).filter((n) => !before.has(n)) : [e.kind === 'option' ? e.new.replace(/^-+/, '') : e.new];
    const es = names.map((n) => det.isSpanish(n)).filter((s) => s.spanish);
    if (es.length) problems.push(`${at}: el nombre nuevo «${e.new}» está en castellano (${[...new Set(es.flatMap((s) => s.words))].join(', ')})`);
    if (isFile(e) && pathsOk) {
      const root = rootOf(e);
      if (!root) { problems.push(`${at}: no encontré agent-skills en esta máquina (TYCON_SKILLS_DIR o ~/.claude/agent-skills): no pude mirar esta entrada`); return; }
      const oldAbs = path.join(root, e.old);
      const newAbs = path.join(root, e.new);
      const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
      const oldExists = fs.existsSync(oldAbs);
      const newExists = e.kind === 'folder' ? isDir(newAbs) : fs.existsSync(newAbs);
      // acá alcanza la marca, como en isMoved: un reemplazo generado con una versión anterior del texto sigue siendo un
      // reemplazo (el freno de nombres, que es el que deja pasar, exige el generado tal cual — tanda C1). Una carpeta
      // vieja se juzga con el mismo criterio que isMoved (pase adversarial de la story 8.12, R2): sólo lo que git versiona
      // la hace real; los restos de la máquina (el log del grabador, sus descartados, un `.DS_Store`), sin seguir o
      // ignorados, no son un choque.
      const oldIsShim = e.kind === 'folder' ? isDir(oldAbs) && !legacy.oldStillReal(oldAbs, 'folder', root)
        : oldExists && fs.statSync(oldAbs).isFile() && legacy.isShim(fs.readFileSync(oldAbs, 'utf8'));
      if (!oldExists && !newExists) {
        problems.push(`${at}: no existe ni ${e.old} ni ${e.new}`);
      } else if (oldExists && !oldIsShim && newExists && !(e.kind === 'folder' && onlyArrivals(e, newAbs, map.entries))) {
        problems.push(`${at}: el nombre nuevo choca: ${e.new} ya existe y ${e.old} también (no es un reemplazo)`);
      } else if (oldExists && !oldIsShim) {
        // todavía no se movió: válido, no hace nada hasta la mudanza (estructura destino, AC 13)
      } else if (e.kind === 'file' && legacy.needsShim(e)) {
        const outside = e.callers.filter((c) => c !== 'same-repo' && c !== 'ado').join(', ');
        if (!legacy.supportsShim(e.old)) problems.push(`${at}: lo llaman de afuera (${outside}) y no hay forma de reemplazo para «${path.extname(e.old) || 'sin extensión'}» — si lo nombra un pipeline de Azure DevOps, va con callers: ["ado"] (tarea humana)`);
        else if (!oldIsShim) problems.push(`${at}: lo llaman de afuera (${outside}) y ${e.old} no es su reemplazo — generalo con node scripts/lib/legacy-names.js --write-shims`);
        else {
          const target = legacy.shimTarget(oldAbs);
          if (!target || path.resolve(target) !== path.resolve(newAbs)) problems.push(`${at}: el reemplazo de ${e.old} apunta a ${target ? path.relative(root, target) : '(nada)'}, no a ${e.new} — regeneralo con node scripts/lib/legacy-names.js --write-shims`);
        }
      }
    }
  });
  // un new que es el old de otra entrada del mismo kind y where: una cadena, que choca con el nombre que se está retirando
  for (const e of map.entries.filter((x) => x && typeof x.new === 'string')) {
    const other = map.entries.find((x) => x && x !== e && x.kind === e.kind && (x.where || '') === (e.where || '') && x.old === e.new);
    if (other) problems.push(`el nombre nuevo «${e.new}» choca con el viejo de otra entrada (${other.old} → ${other.new})`);
  }
  problems.push(...ciPairsProblems(repo, map.entries));
  return { file, problems, entries: map.entries.length };
}

// ── las opciones de scripts/ci: el mapa contra los pares declarados en cada guion (tanda B2, AC 27) ─────────────
/**
 * Los guiones de scripts/ci viajan solos en el artefacto `arnes-ci` (sin scripts/lib ni el mapa), así que traducen
 * sus opciones viejas con el traductor de su carpeta (legacy-options.sh/.js) y los pares declarados en el propio guion.
 * El mapa sigue siendo la lista oficial: toda entrada `option` con `where` en scripts/ci/ tiene su par declarado en
 * ese guion, y todo par declarado tiene su entrada. Si no, los dos lados divergen en silencio: el retiro sacaría del
 * mapa un nombre que el guion sigue aceptando, o un guion aceptaría un nombre viejo que nadie va a retirar.
 */
const CI_DIR = 'scripts/ci/';
function ciPairsProblems(repo, entries) {
  const { declaredPairs } = require('../ci/legacy-options.js');
  const problems = [];
  // opciones y valores (tanda B3a: el par `opcion=viejo:nuevo`); `kind` distingue los dos lados del cruce
  const opts = entries.filter((e) => e && (e.kind === 'option' || e.kind === 'value') && typeof e.where === 'string' && e.where.startsWith(CI_DIR)
    && (e.repo || 'arnes') === 'arnes' && typeof e.old === 'string' && typeof e.new === 'string');
  const pairText = (p) => (p.kind === 'value' ? `${p.option}=${p.old}:${p.new}` : `${p.old}:${p.new}`);
  const what = (e) => (e.kind === 'value' ? `el valor ${e.old} de --${e.option} (→ ${e.new})` : `la opción --${e.old} (→ --${e.new})`);
  const same = (p, e) => (p.kind || 'option') === e.kind && p.old === e.old && p.new === e.new && (e.kind !== 'value' || p.option === e.option);
  // where → { pairs } (pairs null: el guion no declara nada) · { missing } (no existe) · { unreadable } (existe y no se
  // pudo leer: no es lo mismo que no existir, y los dos son un problema)
  const declared = new Map();
  const read = (where) => {
    if (!declared.has(where)) {
      try {
        declared.set(where, { pairs: declaredPairs(fs.readFileSync(path.join(repo, where), 'utf8')) });
      } catch (err) {
        declared.set(where, err && err.code === 'ENOENT' ? { missing: true } : { unreadable: (err && (err.code || err.message)) || String(err) });
      }
    }
    return declared.get(where);
  };
  for (const e of opts) {
    const r = read(e.where);
    if (r.missing) problems.push(`${what(e)}: no existe su guion ${e.where}`);
    else if (r.unreadable) problems.push(`${what(e)}: no pude leer su guion ${e.where} (${r.unreadable})`);
    else if (!(r.pairs || []).some((p) => same(p, e))) problems.push(`${what(e)}: ${e.where} no declara el par «${pairText({ ...e, option: e.option })}» (legacy_options / aliasLegacyOptions) — sin él, el nombre viejo no anda desde el artefacto arnes-ci`);
  }
  let files = [];
  try {
    files = fs.readdirSync(path.join(repo, CI_DIR)).filter((f) => /\.(sh|js)$/.test(f) && !f.startsWith('legacy-options.'));
  } catch (err) {
    // sin scripts/ci no hay pares que declarar; cualquier otro error es «no pude mirar» esa mitad del cruce
    if (!(err && err.code === 'ENOENT')) problems.push(`no pude listar ${CI_DIR} (${(err && (err.code || err.message)) || err}): no sé si algún guion declara pares que el mapa no tiene`);
  }
  for (const f of files) {
    const where = `${CI_DIR}${f}`;
    const r = read(where);
    if (r.unreadable) { problems.push(`no pude leer ${where} (${r.unreadable}): no sé si declara pares que el mapa no tiene`); continue; }
    for (const p of r.pairs || []) {
      const kind = p.kind || 'option';
      if (!opts.some((e) => e.where === where && same(p, e))) problems.push(`${where} declara el par «${pairText(p)}» y el mapa no tiene su entrada ${kind} (kind ${kind}${kind === 'value' ? `, option ${p.option}` : ''}, where ${where})`);
    }
  }
  return problems;
}

// ── --stale-mentions: los nombres viejos que quedan fuera de su lugar (tanda B1, AC 25) ────────────────────────
/**
 * Un nombre viejo del mapa nombrado en los dos repos fuera de las zonas donde tiene que seguir (una variable, en
 * cualquier archivo; una opción `--viejo`, en su guion y en los archivos de su repo que nombran ese guion): el mapa, los reemplazos,
 * la biblioteca de compatibilidad (`legacy-names.*`, también el puente de agent-skills), `specs/`, `tasks/`,
 * `guides/incident-log.md`, la evidencia de corridas pasadas (`.advisors/`), la guía de la convención y las pruebas de
 * compatibilidad (`scripts/tests/legacy-names*`). En una variable con `repo`
 * (el único repo que la lee), el nombre viejo en el OTRO repo es una referencia entre repos y no cuenta: ese repo puede
 * estar un pull atrás hasta el retiro (AC 1 d). Un kind que este modo todavía no sabe mirar es «no pude mirar»: cada
 * tanda lo suma con su primera entrada, nunca se saltea callado. Una entrada con `homonyms` no cuenta en los archivos de
 * sus globs, donde el nombre viejo es otro archivo que se llama igual (story 8.12, AC 37); un glob muerto frena.
 */
const STALE_KINDS = ['env', 'option', 'subcommand', 'value', 'folder', 'file', 'state-file', 'config-file', 'key'];
// 🔴 Los que LEEN o PROTEGEN los dos nombres a propósito (tanda P, escritura doble): el freno de producción tiene que
// nombrar el catálogo, el índice y la memoria con su nombre de antes del renombre, porque la copia vieja de /opt los sigue
// usando hasta que todas las máquinas autorizadas reinstalen. No hay forma de hacerlo sin escribir el nombre viejo, y en
// una plantilla JSON no hay comentario donde declararlo. Salen de esta lista en el commit que apaga la escritura doble
// (AC 49 de la story 8.9): desde ahí, un nombre viejo en ellos vuelve a ser una mención de más.
const LEGACY_READERS = new Set([
  'scripts/production/production-index.js', 'scripts/production/tycon-prod-sql', 'scripts/production/node-shim.sh',
  'scripts/production/install-guard.sh', 'scripts/production/lint-production-json.js',
  'scripts/production/managed-settings.tycon-production.json.template', 'scripts/hooks/prod-access-guard.js',
  'scripts/hooks/produccion-notice.js', 'scripts/hooks/git-pre-commit-global.sh', 'scripts/lib/tycon-config.js',
  // la copia propia del freno (2026-10-14): ocupa en /opt el lugar de scripts/lib/tycon-config.js y lee lo mismo que ella
  'scripts/production/guard-libs/lib/tycon-config.js',
  // compara contra una base de antes del renombre y corre los archivos de esa base por el nombre que tenían (tanda C1)
  'scripts/publishing/profile-equivalence.js',
  // el termómetro mide también los commits de la medición (T5), donde el archivo de esquema del intérprete tenía su
  // nombre viejo: `schemaFiles` lista los dos (cada árbol tiene uno solo). Sale con el retiro, no con la escritura doble.
  'scripts/lib/spanish-words.json',
]);
// Los kinds de ruta y de clave (tanda P): cómo se nombra el viejo en un archivo. Una ruta, entera y no como pedazo de
// otra (`x-viejo.js` no está dentro de `mi-x-viejo.js`); un archivo o un estado también por su nombre solo; una clave,
// sólo como clave de un JSON (`"clave":`), en `«…»` o entre acentos graves, y sólo en los archivos que nombran el
// archivo donde vive (con cualquiera de sus dos nombres): la misma palabra suelta es prosa.
// antes, cualquier cosa que no sea parte de un nombre (una `/` sí: la ruta vieja puede venir al final de una absoluta).
// `inside`: las carpetas que la ruta nueva agrega delante de la vieja (`pipelines/` en `x.yml` → `pipelines/x.yml`); ahí
// la vieja está dentro de la nueva y no es una mención (story 8.12, AC 3). Detrás de otra cosa, sigue contando.
// `onlyAsPath`: una carpeta vieja de UN solo pedazo es también una palabra común (la de los instintos, tanda R2: «propone
// …», «Revisar y accionar …»); cuenta sólo escrita como ruta, con una barra detrás (`<vieja>/pending/`, `<vieja>\pending\`).
// La palabra suelta es prosa. El exportador decide igual (`rutaViejaRe`, que lee PATH_SEP_AHEAD de acá).
// Qué es «una barra detrás» (pase adversarial de la R2, clase 7): una `/`, o una `\` que NO abre una secuencia de escape de
// un string o de una expresión regular. `<vieja>\n`, `<vieja>\t`, `/<vieja>\b/` (también `\r`, `\f`, `\v`, `\0`, `\x`,
// `\u`, una comilla o un acento grave detrás de la `\`) no son una ruta. `\\` (la barra de Windows escrita dentro de un
// string: `"<vieja>\\pending"`) y `\/` (la barra escapada de un JSON o de una expresión regular) sí lo son. Borde elegido:
// una ruta de Windows cuyo pedazo siguiente empieza con una de esas letras (`<vieja>\notas`) no cuenta — se lee igual que
// un escape y no hay forma de distinguirlos mirando el texto; las subcarpetas de la carpeta mudada no empiezan así.
const PATH_SEP_AHEAD = '(?=/|\\\\(?![nrtbfv0xu\'"`]))';
const pathRe = (p, folder, inside, onlyAsPath) => new RegExp(`(?<![\\w.~-])${inside ? `(?<!(?:^|[^\\w.~-])${esc(inside)})` : ''}${esc(p)}${onlyAsPath ? PATH_SEP_AHEAD : folder ? '(?![\\w.@+~-])' : '(?![\\w.@+~/-])'}`);
/** Lo que la ruta nueva agrega delante de la vieja, si la nueva es `<carpetas>/<vieja>`; si no, nada. */
const addedPrefix = (oldRel, newRel) => {
  const o = oldRel.replace(/\/+$/, '');
  const n = String(newRel || '').replace(/^~\//, '').replace(/\/+$/, '');
  return n.length > o.length && n.endsWith(`/${o}`) ? n.slice(0, n.length - o.length) : '';
};
// El nombre suelto de un archivo renombrado: solo, detrás de `./` o detrás de SU carpeta. Detrás de otra carpeta es otro
// archivo con el mismo nombre (`lib/x.js` de agent-skills no es el `scripts/ci/x.js` renombrado, tanda C1).
const baseRe = (p, folder) => {
  const parent = path.posix.basename(path.posix.dirname(p));
  const where = parent && parent !== '.' ? `(?:(?<=(?:^|[^\\w.~-])${esc(parent)}/)|(?<=(?:^|[^\\w.~-])\\./)|(?<!/))` : '';
  return new RegExp(`(?<![\\w.~-])${where}${esc(path.posix.basename(p))}${folder ? '(?![\\w.@+~-])' : '(?![\\w.@+~/-])'}`);
};
function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// La misma ruta escrita a la Windows (`scripts\x.ps1`, `~\.claude\…\scripts\x.ps1`): las guías y las cabeceras de los
// .ps1 la usan de verdad, y el instalador ya la reescribe (`machineRewrites`); sin esta variante, una mención vieja así
// pasaba el control en verde (pase adversarial de la story 8.12, R1).
const winRes = (p, folder, inside) => (p.includes('/') ? [pathRe(p.split('/').join('\\'), folder, inside ? inside.split('/').join('\\') : inside)] : []);
// Una ruta vieja detrás de una barra sigue contando —puede ser el final de una absoluta, `/…/tycon-claude-guides/<vieja>/`—,
// salvo que lo de delante de la barra arme con ella OTRA ruta del repo que existe hoy (story 8.12, AC 3, matiz de la R2):
// la carpeta de la raíz que se mudó a `inbox/instincts/` se llama igual que el último pedazo de `scripts/instincts/`, otra
// carpeta de verdad. `inside` resuelve sólo el caso de la ruta NUEVA; éste es el de una ruta ajena. Se prueban los pedazos
// de delante de a uno (`scripts/<vieja>`, `x/scripts/<vieja>`, …) contra el repo: en una absoluta a la vieja ninguno existe
// (`<raíz>/<vieja>` ya se mudó y la raíz no es una carpeta del repo), y un `$TCG`, un `~`, un `.` o un `..` cortan la
// cuenta, porque no son carpetas del repo. La ruta vieja misma (`scripts/ci/x.js` armada detrás de `ci/`) no exime aunque
// en su lugar quede el reemplazo.
const PATH_BEFORE = /[\w.~$@+\\/-]*$/;
function completesOtherRealPath(line, at, hit, dir, oldRel) {
  if (!dir || (line[at - 1] !== '/' && line[at - 1] !== '\\')) return false;
  const segs = line.slice(0, at - 1).match(PATH_BEFORE)[0].split(/[\\/]/);
  const old = oldRel.replace(/\/+$/, '');
  const root = path.resolve(dir);
  let rel = hit.split('\\').join('/').replace(/\/+$/, '');
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    // un pedazo vacío es una barra doble o la barra escapada de una expresión regular (`inbox\/<vieja>`): una sola barra
    if (!s) continue;
    if (s === '.' || s === '..' || /[$~]/.test(s)) return false;
    rel = `${s}/${rel}`;
    if (path.posix.normalize(rel) === old) continue;
    const abs = path.resolve(root, rel);
    if (abs.startsWith(root + path.sep) && fs.existsSync(abs)) return true;
  }
  return false;
}
// `test(line, rel, dir)`: la línea nombra la ruta vieja en alguna aparición que no completa otra ruta real de `dir`.
const pathTest = (res, oldRel) => {
  const all = res.map((r) => new RegExp(r.source, 'g'));
  return (line, rel, dir) => all.some((g) => [...line.matchAll(g)].some((m) => !completesOtherRealPath(line, m.index, m[0], dir, oldRel)));
};
function pathMatchers(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || typeof e.old !== 'string' || !e.old || typeof e.new !== 'string') continue;
    // un estado vive en la HOME, no en un repo: lo nombran los dos (tanda D2: la carpeta de la consola la escribe
    // agent-skills y la lee el arnés). `*` = se mira en las dos fuentes.
    const repo = e.repo || (e.kind === 'state-file' ? '*' : 'arnes');
    const old = e.old.replace(/^~\//, '');
    if (e.kind === 'folder') {
      const dir = old.replace(/\/+$/, '');
      const res = [pathRe(dir, true, addedPrefix(old, e.new), !dir.includes('/')), ...winRes(dir, true, addedPrefix(old, e.new))];
      out.push({ e, repo, res, test: pathTest(res, dir) });
    }
    // el nombre suelto sólo si cambia: un archivo que nada más cambia de carpeta sigue nombrándose igual en su ruta nueva
    // (tanda C0, AC 59)
    else if (e.kind === 'file' || e.kind === 'state-file') {
      const renamed = path.posix.basename(old) !== path.posix.basename(e.new.replace(/^~\//, ''));
      // un estado puede ser una carpeta (tanda D2: `console-writes/<sesión>.jsonl`): ahí la barra después del nombre
      // también es una mención. En un archivo de estado nunca viene una barra detrás, así que no cuesta nada.
      const dirLike = e.kind === 'state-file';
      const inside = e.kind === 'file' ? addedPrefix(old, e.new) : '';
      const win = e.kind === 'file' ? winRes(old, dirLike, inside) : [];
      const res = renamed ? [pathRe(old, dirLike), baseRe(old, dirLike), ...win] : [pathRe(old, dirLike, inside), ...win];
      out.push({ e, repo, res, ...(e.kind === 'file' ? { test: pathTest(res, old) } : {}) });
    }
    else if (e.kind === 'config-file') out.push({ e, repo, res: [pathRe(old, false)] });
  }
  // El último pedazo de la ruta vieja: toda expresión de la entrada lo lleva entero (la ruta, su forma de Windows y el
  // nombre suelto terminan en él), así que un texto que no lo tiene escrito no puede tener ninguna mención.
  for (const m of out) m.needle = path.posix.basename(m.e.old.replace(/^~\//, '').replace(/\/+$/, ''));
  return out;
}
/**
 * Los buscadores de ruta que vale la pena probar contra `text`: los que tienen su último pedazo escrito ahí. Sin este
 * filtro, las ~316 entradas de ruta del mapa por cada archivo del repo eran 41 s de cálculo en cada --stale-mentions
 * (story 8.22, tramo F: todo el peso de guides-moved.test.js). spanish-names.test.js (T43) mide que el filtro no puede
 * tapar una mención, entrada por entrada del mapa real.
 */
const pathsNaming = (matchers, text) => matchers.filter((m) => text.includes(m.needle));
// Los esquemas AJENOS que se escriben con una clave vieja de un archivo del mapa y no son ese archivo (tanda D1, pase
// adversarial): cada uno se reconoce por una clave propia en la misma línea (`marker`) y exime sólo SUS claves (`keys`).
// Una lista declarada, no «cualquier clave que el .json no tenga»: eso tomaba por clave datos, textos y ternarios, y dejaba
// pasar menciones viejas reales. Uno nuevo se suma acá, con su caso en spanish-names.test.js.
const FOREIGN_SCHEMAS = Object.freeze([
  { what: 'una entrada de scripts/tests/suites.json', marker: 'requiere', keys: ['raiz', 'ruta'] },
  { what: 'la tabla de reemplazos (replacements.json, privada)', marker: 'pares', keys: ['afuera'] },
]);
// el archivo de configuración de cada máquina y su lector: las claves del primero se nombran también por el segundo
const MACHINE_CONFIG = '~/.claude/tycon.json';
const CONFIG_READER = 'tycon-config.js';
const quotedKeyRe = (k) => new RegExp(`(?<![\\w-])\\\\?["']${esc(k)}\\\\?["']\\s*:`);
/**
 * Las menciones de una clave vieja: como clave JSON (`"x":`) o en prosa («x», `x`), en un archivo que nombra el .json de
 * la clave. Tanda D1, lo que NO es esa clave aunque se escriba igual (cada una, una regla precisa):
 *   · `"x":` dentro de OTRO .json es una clave de ese otro archivo (la de un fixture no es la de budget.json);
 *   · `"x":` en una línea de un esquema ajeno DECLARADO (FOREIGN_SCHEMAS), si `x` es una clave de ese esquema;
 *   · en prosa, «x»/`x` seguido de «privado» es la clave de la tabla PRIVADA (replacements.json), que no cambia;
 *   · en prosa, un viejo que es el nombre de una transformación del exportador es ese id (`opts.ids`), que no cambia
 *     (pregunta decidida 2): la clave se busca, en ese caso, sólo en su forma JSON.
 * `test(line, rel)` dice si la línea la nombra; `res` es el filtro grueso por archivo.
 */
function keyMatchers(entries, opts = {}) {
  const out = [];
  const files = entries.filter((x) => x && x.kind === 'config-file');
  const ids = new Set(opts.ids || []);
  for (const e of entries) {
    if (!e || e.kind !== 'key' || typeof e.old !== 'string' || !e.old || typeof e.where !== 'string') continue;
    // el archivo donde vive la clave, con sus dos nombres (el where nombra el nuevo; el mapa dice el viejo)
    const names = new Set([path.posix.basename(e.where)]);
    for (const f of files) if (f.new === e.where || f.old === e.where) { names.add(path.posix.basename(f.new)); names.add(path.posix.basename(f.old)); }
    const k = esc(e.old);
    const json = new RegExp(`\\\\?["']${k}\\\\?["']\\s*:`);
    const notPrivate = '(?![ \\t]+(?:privad|PRIVAD))';
    const prose = ids.has(e.old) ? [] : [new RegExp(`«${k}»${notPrivate}`), new RegExp(`\`${k}\`${notPrivate}`)];
    const foreign = FOREIGN_SCHEMAS.filter((s) => s.keys.includes(e.old)).map((s) => quotedKeyRe(s.marker));
    // las claves del archivo de la máquina se escriben también con punto (`integrations.<vieja>`) y como argumento del
    // lector (`tycon-config.js key <vieja>`, `get <sección>.<vieja>`) — tanda G, pase adversarial, causa 2. El prefijo es
    // cualquier otra clave del mismo archivo (las secciones están en el mapa con sus dos nombres).
    const config = [];
    if (e.where === MACHINE_CONFIG) {
      const sections = [...new Set(entries.filter((x) => x && x.kind === 'key' && x.where === e.where && x !== e).flatMap((x) => [x.old, x.new]))].map(esc);
      if (sections.length) config.push(new RegExp(`(?<![A-Za-z0-9_.-])(?:${sections.join('|')})\\.${k}(?![A-Za-z0-9_-])`));
      config.push(new RegExp(`${esc(CONFIG_READER)}["'\`]?\\s+(?:key|get)(?:\\s+--?[A-Za-z-]+)*\\s+["']?(?:[A-Za-z_]+\\.)?${k}(?![A-Za-z0-9_-])`));
      names.add(CONFIG_READER);
    }
    const test = (line, rel) => {
      if (prose.some((r) => r.test(line)) || config.some((r) => r.test(line))) return true;
      if (!json.test(line)) return false;
      if (rel && /\.json$/i.test(rel) && !names.has(path.posix.basename(rel))) return false;
      return !foreign.some((r) => r.test(line));
    };
    out.push({ e, repo: e.repo || 'arnes', names: [...names], res: [json, ...prose, ...config], test });
  }
  return out;
}
const SCRIPT_NAME = /[A-Za-z0-9_.-]+\.(?:sh|js|mjs|cjs|ps1|py)\b/g;
// `.advisors/`: evidencia de corridas pasadas (historia, no se reescribe); la guía de la convención nombra un viejo como ejemplo.
// La foto de un pipeline de producto (tanda B2) copia las líneas de afuera, con los nombres viejos que los productos
// siguen usando hasta el retiro: es la prueba de que siguen andando.
// Tanda B3a, más historia que no se reescribe: las métricas grabadas por merge (`.dashboard/`), el registro de propuestas
// y las revisiones con fecha de guides/, y el techo de la 8.10 (names-ceiling.json no se toca: AC 29). La página del
// tablero estuvo acá hasta que el nocturno la regeneró con el nombre nuevo (corrida 11421, tanda C1): ya no es zona.
// Volvió a estar en las tandas C4 y D1, y salió otra vez cuando el nocturno la regeneró sobre el merge de la D1
// (corrida 11477, [DEF-8.9-TABLERO-D1]).
// Tanda B3b, la historia de agent-skills: el CHANGELOG de cada skill y la HISTORIA.md del pipeline (los párrafos que el
// SKILL.md dejó al recortarse, con la fecha en que se escribieron).
const STALE_ZONES = [/^specs\//, /^tasks\//, /^\.advisors\//, /^guides\/incident-log\.md$/, /^guides\/nombres-en-ingles\.md$/, /^scripts\/tests\/legacy-names[^/]*$/,
  /^scripts\/tests\/fixtures\/product-pipeline\//, /^\.dashboard\//, /^guides\/guide-update-proposals\.md$/, /^guides\/(?:decisions\/)?revision-adversarial-[^/]*\.md$/,
  /^scripts\/publishing\/names-ceiling\.json$/,
  /^skills\/[^/]+\/CHANGELOG\.md$/, /^skills\/tycon-pipeline\/HISTORIA\.md$/,
  // Tanda C1, más historia: la guía de prueba de cada story (qa/, como specs/) y los instintos ya archivados. Y las
  // traducciones a Codex de los agentes de agent-skills: son texto de agent-skills, que nombra al arnés con el nombre viejo
  // hasta el retiro (AC 1 d), y build/check.js las compara con el agente de la máquina; la copia pública las regenera
  // con la ruta ya traducida.
  // (los archivados se mudaron con su carpeta a `inbox/` en la tanda R2 de la story 8.12)
  /^qa\//, /^inbox\/instincts\/archived\//, /^adapters\/codex\/agents(?:-native)?\/[^/]+\.toml$/,
  // Tanda C3: la foto del último nocturno (banco y suites). Es la copia de `.dashboard/controls-bench/` que viaja al lado
  // del banco, y sus `motivos` copian tal cual la salida de una prueba roja de esa noche: el 2026-10-01 una prueba
  // renombrada en la C2 quedó nombrada en un motivo y este modo dio rojo en la noche siguiente (legacy-names-env T30).
  // Las claves de esas fotos sí se migran con el renombre (legacy-names.js --migrate-bench).
  /^scripts\/controls-bench\/ultimo-(?:banco|suites)\.json$/,
  // Tanda D1: la clasificación commiteada de las claves (viejo → nuevo, una fila por clave y lugar) es dato de historia:
  // nombra cada clave y ruta vieja a propósito, y se genera, no se reescribe.
  /^scripts\/tests\/fixtures\/legacy-names-d1\//,
  // Tanda F: las fichas de las dos colas de los nocturnos (`pending/`, `promoted/` y `archived/` de cada una). Son datos
  // que escribe un proceso, como `.dashboard/`: llevan el motivo de un rechazo tal cual lo escribió una persona en el pull
  // request («se resuelve junto con <cola>/<id>», la rama de la cola) y rutas de archivos de los productos. Con las colas
  // mudadas, la primera noche que una ficha lo trajera este modo salía rojo sin que nadie tocara código (pase adversarial
  // de la tanda, clase 9). El README de cada cola NO entra: es una guía, y una ruta vieja ahí es una instrucción viva.
  /^inbox\/(?:dependencies|watcher)\/(?:pending|promoted|archived)\//,
  // Tanda G: la página del tablero vuelve a ser zona —como en las tandas C4 y D1— hasta que el nocturno la regenere sobre
  // el merge: trae escrito el comando de la vista de corridas con el nombre que tenía su opción, y no se edita a mano (la
  // escribe dashboard.js, que ya imprime el nombre nuevo). Sale de acá con esa corrida ([DEF-8.9-TABLERO-G]).
  /^artifacts\/tablero-del-arnes\.html$/];
// Un `.gitignore` que ignora la carpeta vieja ENTERA (`/<vieja>/`) la nombra a propósito: es lo que esconde los restos que
// cada máquina guarda ahí después de la mudanza —el log del grabador, sus descartados— (pase adversarial de la story 8.12,
// R2). Sólo la línea que es la carpeta sola; un patrón de adentro (`<vieja>/drafts/`) sigue siendo una mención vieja.
const ignoresOldFolder = (rel, line, e) => e.kind === 'folder' && path.posix.basename(rel) === '.gitignore'
  && line.trim().replace(/^\//, '').replace(/\/(?:\*\*)?$/, '') === e.old.replace(/\/+$/, '');
function staleMentions(args) {
  const legacy = require('../lib/legacy-names.js');
  const startDir = args.repo ? path.resolve(args.repo) : process.cwd();
  if (!fs.existsSync(startDir)) throw new CouldNotLook(`--repo ${startDir} no existe`);
  const repo = nn.realOr(nn.hookGit(startDir, ['rev-parse', '--show-toplevel']).trim());
  const file = path.join(repo, RENAMES_PATH);
  if (!fs.existsSync(file)) return { missing: true, findings: [] };
  let map;
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new CouldNotLook(`el mapa de renombres ${RENAMES_PATH} no es JSON válido (${e.message})`); }
  const entries = Array.isArray(map && map.entries) ? map.entries : [];
  const unknown = [...new Set(entries.map((e) => e && e.kind).filter((k) => !STALE_KINDS.includes(k)))];
  if (unknown.length) throw new CouldNotLook(`el mapa tiene entradas de ${unknown.join(', ')} y --stale-mentions todavía sabe mirar sólo ${STALE_KINDS.join(', ')}: se suma en la tanda que trae esa entrada`);
  // story 8.18: en el repo unido las dos fuentes viven en esta raíz y cada archivo es de la suya por su ruta. Sin esto
  // el recorrido tomaba `skills/` por archivos del arnés y contaba como menciones viejas las que agent-skills hace del
  // arnés, que son referencias entre fuentes (AC 1 d) — o, sin «el otro repo» a mano, no miraba.
  const unified = nn.unifiedCheckout(repo);
  const other = unified ? { dir: repo } : nn.otherRepo('arnes');
  if (other.missing) throw new CouldNotLook(`no encontré agent-skills (${other.dir}): sin el otro repo no sé si quedan nombres viejos allá — seteá TYCON_SKILLS_DIR`);
  const repos = { arnes: repo, 'agent-skills': other.dir };
  const findings = [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const olds = entries.filter((e) => e && e.kind === 'env' && typeof e.old === 'string' && e.old).map((e) => ({ e, re: new RegExp(`(?<![A-Za-z0-9_])${esc(e.old)}(?![A-Za-z0-9_])`) }));
  // una opción (tanda B2): el --viejo en su where y en los archivos de su repo que nombran ese guion; en el otro repo es
  // una referencia entre repos (AC 1 d). La declaración del par («viejo:nuevo», sin guiones) no es una mención.
  const opts = entries.filter((e) => e && e.kind === 'option' && typeof e.old === 'string' && e.old && typeof e.where === 'string')
    .map((e) => ({ e, flag: `--${e.old}`, base: path.posix.basename(e.where), re: new RegExp(`(?<![A-Za-z0-9_-])--${esc(e.old)}(?![A-Za-z0-9_-])`) }));
  // rutas y claves (tanda P): en su propio repo; en el otro es una referencia entre repos, que sigue andando porque el
  // arnés lee los dos nombres (AC 1 d). Un archivo o una carpeta cuenta recién cuando se mudó —el nuevo existe y el viejo
  // ya no es el de verdad—: una entrada nace antes de su mudanza con sus llamadores medidos (tanda C0, AC 59), y hasta
  // entonces la ruta vieja es la real, como ya la tratan el validador del mapa, el instalador, --write-shims y el exportador.
  const moved = (e) => (e.kind !== 'file' && e.kind !== 'folder') || legacy.isMoved(e, repos[e.repo || 'arnes']);
  const paths = pathMatchers(entries.filter((e) => e && moved(e)));
  // los ids de transformación del exportador, que se escriben como una clave vieja de la lista blanca y no cambian
  const keys = keyMatchers(entries, { ids: (exporter.TRANSFORMACIONES || []).map((t) => t.nombre) });
  // un subcomando (tanda B3a): el nombre de su script seguido del viejo en la misma línea (`tool.js <viejo>`);
  // un valor: `--<opción> viejo` o `--<opción>=viejo`, con la opción nueva o su nombre viejo, donde se nombra el script.
  // Como la opción, se busca en su where y en los archivos de su repo que nombran ese script.
  const subs = entries.filter((e) => e && e.kind === 'subcommand' && typeof e.old === 'string' && e.old && typeof e.where === 'string')
    .map((e) => {
      const base = path.posix.basename(e.where);
      return { e, flag: e.old, base, shown: [e.old, e.new], re: new RegExp(`${esc(base)}["'\`]?\\s+["']?${esc(e.old)}(?![A-Za-z0-9_-])`) };
    });
  const valueEntries = entries.filter((e) => e && e.kind === 'value' && typeof e.old === 'string' && e.old && typeof e.where === 'string' && typeof e.option === 'string');
  // un valor de una clave de configuración o de una variable (tanda G, pase adversarial): se busca asignado a los nombres
  // que declara (`"<nombre>": "<viejo>"`, `"<nombre>": [..., "<viejo>"]`, `<NOMBRE>=<viejo>`), en todo su repo. La
  // declaración del par viejo:nuevo (`<NOMBRE>=<viejo>:<nuevo>`) no es una mención.
  const assigned = valueEntries.filter((e) => Array.isArray(e.assigned_to) && e.assigned_to.length).map((e) => {
    const names = e.assigned_to.map(esc).join('|');
    return { e, re: new RegExp(`(?<![A-Za-z0-9_])["']?(?:${names})["']?\\s*(?::|=)\\s*(?:\\[[^\\]\\n]*?)?["']?${esc(e.old)}(?![A-Za-z0-9_-])(?!:${esc(e.new)})`) };
  });
  // un valor sin assigned_to se busca como `--<opción> <viejo>`: si su guion no tiene esa opción, esa forma no aparece
  // nunca y el modo saldría 0 callado. Eso es «no pude mirar» (tanda G, pase adversarial, causa 1).
  for (const e of valueEntries) {
    if (Array.isArray(e.assigned_to)) continue;
    const file = path.join(repos[e.repo || 'arnes'] || repo, e.where);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }   // el guion no está en este árbol: no se juzga
    if (!text.includes(`--${e.option}`)) throw new CouldNotLook(`el valor «${e.old}» → «${e.new}» del mapa es de «${e.option}», y ${e.where} no tiene la opción --${e.option}: así no sé buscarlo — declarale assigned_to con las claves o variables a las que se asigna`);
  }
  const vals = valueEntries.filter((e) => !Array.isArray(e.assigned_to))
    .map((e) => {
      const renamed = entries.find((x) => x && x.kind === 'option' && x.where === e.where && x.new === e.option);
      const names = [e.option, ...(renamed ? [renamed.old] : [])].map(esc).join('|');
      return { e, flag: e.old, base: path.posix.basename(e.where), shown: [`--${e.option} ${e.old}`, `--${e.option} ${e.new}`],
        re: new RegExp(`(?<![A-Za-z0-9_-])--(?:${names})(?:\\s+|=)["']?${esc(e.old)}(?![A-Za-z0-9_-])`) };
    });
  const scoped = [...subs, ...vals];
  // lo que cada repo versiona (una vez por repo: lo usan los homónimos y la recorrida)
  const versioned = {};
  const filesOf = (source) => {
    if (!versioned[source]) {
      const all = nn.isolated(repos[source], ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
      versioned[source] = unified ? all.filter((rel) => nn.sourceOfPath(rel) === source) : all;
    }
    return versioned[source];
  };
  // los homónimos (story 8.12, AC 37): una forma rota o un glob que no matchea ningún archivo del repo de la entrada es
  // «no pude mirar» — una lista vieja o mal escrita taparía menciones en silencio
  const homonymRes = new Map();
  entries.forEach((e, i) => {
    if (!e || e.homonyms === undefined) return;
    const at = `entries[${i}] (${e.old})`;
    const bad = homonymProblems(e, at);
    if (bad.length) throw new CouldNotLook(`el mapa de renombres tiene un homonyms mal formado — ${bad.join('; ')}`);
    const source = e.repo || 'arnes';
    if (!repos[source]) throw new CouldNotLook(`${at}: homonyms en una entrada de un repo que este modo no mira (${source})`);
    const res = e.homonyms.map((h) => {
      const re = detector.globARegex(h.glob);
      if (!filesOf(source).some((rel) => re.test(rel))) throw new CouldNotLook(`${at}: el glob de homonyms «${h.glob}» no matchea ningún archivo de ${source} — una lista vieja no puede tapar menciones: sacalo del mapa o corregilo`);
      return re;
    });
    homonymRes.set(e, { source, res });
  });
  // ¿en este archivo el nombre viejo de la entrada es su homónimo (otro archivo que se llama igual)?
  const homonymAt = (e, source, rel) => {
    const h = homonymRes.get(e);
    return Boolean(h) && h.source === source && h.res.some((re) => re.test(rel));
  };
  if (!olds.length && !opts.length && !scoped.length && !assigned.length && !paths.length && !keys.length) return { findings, entries: 0 };
  for (const [source, dir] of Object.entries(repos)) {
    for (const rel of filesOf(source)) {
      if (source === 'arnes' && rel === RENAMES_PATH) continue;
      if (path.posix.basename(rel).startsWith('legacy-names.') || STALE_ZONES.some((z) => z.test(rel))) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(dir, rel)); } catch { continue; }   // borrado del árbol sin commitear
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      // una entrada cuyo nombre viejo es, en este archivo, su homónimo no se mira acá; las demás entradas, sí
      const own = (x) => !homonymAt(x.e, source, rel);
      const mine = [
        ...olds.filter(({ e }) => !(e.repo && e.repo !== source)),
        ...assigned.filter(({ e }) => (e.repo || 'arnes') === source),
      ].filter(({ e }) => text.includes(e.old)).filter(own);
      const mineOpts = opts.filter((o) => source === (o.e.repo || 'arnes') && (rel === o.e.where || text.includes(o.base)) && text.includes(o.flag)).filter(own);
      const mineScoped = scoped.filter((o) => source === (o.e.repo || 'arnes') && (rel === o.e.where || text.includes(o.base)) && text.includes(o.flag)).filter(own);
      const reader = source === 'arnes' && LEGACY_READERS.has(rel);
      const minePaths = reader ? [] : pathsNaming(paths, text).filter((p) => (p.repo === source || p.repo === '*') && !(p.e.kind === 'file' && rel === p.e.new && path.posix.basename(p.e.old) !== path.posix.basename(p.e.new)) && p.res.some((r) => r.test(text))).filter(own);
      const mineKeys = reader ? [] : keys.filter((k) => k.repo === source && k.names.some((n) => text.includes(n)) && k.res.some((r) => r.test(text))).filter(own);
      // lo que la mudanza no toca: el reemplazo generado, y el archivo ya RENOMBRADO cuyo propio nombre viejo aparece en su
      // cabecera («hasta la story 8.9 se llamaba …») — eso es historia, no un llamador. Uno que sólo cambió de carpeta sí se
      // mira a sí mismo: su «Uso:» con la ruta vieja es una instrucción viva (pase adversarial de la story 8.12, R1)
      // un reemplazo nombra su nombre viejo a propósito; sólo el generado tal cual (la marca sola se escribe a mano: tanda C1)
      if ((!mine.length && !mineOpts.length && !mineScoped.length && !minePaths.length && !mineKeys.length) || legacy.isGeneratedShim(rel, text)) continue;
      // en quien llama, una línea que nombra OTRO guion y no éste es de ese otro (`marker.js … --tipo`): no cuenta. Un
      // guion que es el VALOR de una asignación (`TYCON_DEP_CMD="$TMP/doble.sh" node "$GUION" …`) no es el que se llama.
      const otherScript = (line, base) => {
        const s = [...line.matchAll(SCRIPT_NAME)].filter((m) => !/=["']?[^\s"'=]*$/.test(line.slice(0, m.index))).map((m) => m[0]);
        return s.length > 0 && !s.includes(base);
      };
      text.split('\n').forEach((line, i) => {
        for (const { e, re } of mine) if (re.test(line)) findings.push({ source, rel, line: i + 1, old: e.old, new: e.new, kind: e.kind });
        for (const { e, re, base } of mineOpts) {
          if (re.test(line) && (rel === e.where || !otherScript(line, base))) findings.push({ source, rel, line: i + 1, old: `--${e.old}`, new: `--${e.new}`, kind: e.kind, where: e.where });
        }
        // el subcomando ya ancla en el nombre de su script; el valor, como la opción, no cuenta en la línea de otro script
        for (const { e, re, base, shown } of mineScoped) {
          if (re.test(line) && (e.kind === 'subcommand' || rel === e.where || !otherScript(line, base))) findings.push({ source, rel, line: i + 1, old: shown[0], new: shown[1], kind: e.kind, where: e.where });
        }
        for (const { e, res, test } of [...minePaths, ...mineKeys]) {
          if (ignoresOldFolder(rel, line, e)) continue;
          if (test ? test(line, rel, dir) : res.some((r) => r.test(line))) findings.push({ source, rel, line: i + 1, old: e.old, new: e.new, kind: e.kind, ...(e.where ? { where: e.where } : {}) });
        }
      });
    }
  }
  return { findings, entries: olds.length + opts.length + scoped.length + assigned.length + paths.length + keys.length };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    say(`⛔ nombres en castellano: no pude mirar — ${e.message}`);
    return 2;
  }
  if (args.mode === 'check-map') {
    try {
      const r = checkMap(args);
      const label = args.mapName || r.file;
      if (r.missing) { say(`nombres en castellano: no hay mapa de renombres (${label}) — nada que validar`); return 0; }
      if (!r.problems.length) return 0;
      say(`⛔ el mapa de renombres (${label}) no pasa — ${r.problems.length} problema(s):`);
      for (const p of r.problems) say(`  · ${p}`);
      say('Formato y reglas: AC 13 de specs/story-8.9-nombres-en-ingles.md · guides/nombres-en-ingles.md.');
      return 2;
    } catch (e) {
      const known = e instanceof CouldNotLook || e instanceof exporter.NoPudo || e instanceof require('../lib/legacy-names.js').LegacyNamesError;
      say(`⛔ nombres en castellano: no pude validar el mapa de renombres —${known ? e.message : (e && e.stack) || e}`);
      return 2;
    }
  }
  if (args.mode === 'stale-mentions') {
    try {
      const r = staleMentions(args);
      if (args.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      if (r.missing) { say('nombres en castellano: no hay mapa de renombres — no hay nombres viejos que buscar'); return 0; }
      if (!r.findings.length) return 0;
      if (!args.json) {
        process.stdout.write(`⛔ quedan ${r.findings.length} mención(es) de nombres viejos fuera de su lugar:\n`);
        for (const f of r.findings) process.stdout.write(`  ${f.source}:${f.rel}:${f.line} — ${f.old} (→ ${f.new})\n`);
        process.stdout.write('Van con el nombre nuevo. Se permiten sólo en el mapa, los reemplazos, legacy-names.*, specs/, tasks/, '
          + 'guides/incident-log.md, .advisors/, .dashboard/ y la foto del último nocturno, guides/guide-update-proposals.md, la guía de la convención, las pruebas de compatibilidad y, en una variable que lee un solo repo, en el otro (AC 25). '
          + 'Una opción cuenta en su guion y en lo que nombra ese guion, en su mismo repo (AC 27). Las rutas y claves viejas del freno de producción no se miran en los archivos que las leen y protegen a propósito (LEGACY_READERS, AC 45).\n');
      }
      return 1;
    } catch (e) {
      const known = e instanceof CouldNotLook || e instanceof exporter.NoPudo || e instanceof require('../lib/legacy-names.js').LegacyNamesError;
      say(`⛔ nombres en castellano: no pude buscar nombres viejos — ${known ? e.message : (e && e.stack) || e}`);
      return 2;
    }
  }
  if (args.mode === 'count') {
    try {
      const out = count(args);
      if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      else for (const [pkg, c] of Object.entries(out.packages)) process.stdout.write(`${pkg}: ${CEILING_FIELDS.map((k) => `${k} ${c[k]}`).join(' · ')}\n`);
      return 0;
    } catch (e) {
      const known = e instanceof CouldNotLook || e instanceof exporter.NoPudo;
      say(`⛔ nombres en castellano: no pude contar — ${known ? e.message : (e && e.stack) || e}`);
      return 2;
    }
  }
  if (process.env.TYCON_SPANISH_NAMES === '0') {
    say('⚠️  nombres en castellano: APAGADO (TYCON_SPANISH_NAMES=0) — no se miró si entran nombres nuevos en castellano en lo que se publica. Lo que entre así lo cuenta el termómetro esa noche.');
    record(args, { outcome: 'disabled', verdict: 'escape', rule: 'disabled' });
    return 0;
  }
  let result;
  try {
    result = run(args);
  } catch (e) {
    const known = e instanceof CouldNotLook || e instanceof exporter.NoPudo;
    say(`⛔ nombres en castellano: no pude mirar — ${known ? e.message : (e && e.stack) || e}. No poder mirar no es verde: el commit no se crea.`);
    record(args, { outcome: 'could-not-look', verdict: 'bloqueo', rule: 'could-not-look' });
    return 2;
  }
  if (result.outcome === 'not-measured') {
    say(`${/^true$/i.test(process.env.TF_BUILD || '') ? '##vso[task.logissue type=warning]' : '⚠️  '}${result.message}`);
    return 0;
  }
  if (result.outcome === 'quiet') return 0;
  if (result.outcome === 'other-repo-missing') {
    say(`⚠️⚠️ nombres en castellano: no encontré ${result.other} (${result.otherDir}) — no se miró si entran nombres nuevos en castellano en lo que se publica. `
      + `Cloná o ubicá ${result.other}${result.other === 'agent-skills' ? ' o seteá TYCON_SKILLS_DIR' : ' o seteá TYCON_GUIDES_DIR'}.`);
    record(args, { outcome: 'other-repo-missing', verdict: 'paso', rule: 'other-repo-missing' });
    return 0;
  }
  const blocked = result.findings.length > 0;
  const rule = !blocked ? 'clean' : result.findings.some((f) => f.category !== 'ceiling') ? 'new-spanish-name' : 'ceiling-raised';
  record(args, { outcome: result.outcome, verdict: blocked ? 'bloqueo' : 'paso', rule, findings: result.findings });
  if (args.json) process.stdout.write(`${JSON.stringify({ outcome: result.outcome, blocked, files: result.files, findings: result.findings.length, ms: result.ms })}\n`);
  if (blocked) say(report(result));
  return blocked ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  CouldNotLook, WORDS_PATH, CEILING_PATH, loadWords, makeDetector, tokens, propose, kindOf, extract, pathNames, countFiles, countCopy,
  pathMatchers, pathsNaming, keyMatchers, FOREIGN_SCHEMAS, LEGACY_READERS, PATH_SEP_AHEAD,
};
