'use strict';

/**
 * public-copy.js — funciones puras con que el exportador arma la copia pública.
 *
 * Sin git, sin disco, sin dependencias: reciben texto y devuelven texto o hallazgos. Las llama `export.js` dentro de
 * `transformar` (transformaciones `internal-blocks`, `skill-rename`, `public-third-party`) y de `controles` (`links`,
 * `readmePaths`, `attributions`, `skillRenameLeft`, y el error «marcador fuera de un `.md`» con `markerLines`).
 *
 * Rutas: siempre con `/` y desde la raíz del repo de la copia. En la copia de dos repos el exportador las lleva con la
 * carpeta de su fuente adelante (`arnes/…`, `agent-skills/…`): estas funciones la reconocen y la sacan donde comparan
 * contra una ruta fija (el `NOTICE`, el manifiesto de terceros, el README de la raíz).
 *
 * `files` (en `brokenLinks`, `readmePaths` y `renameLeft`) es la copia entera: un `Map` ruta → texto (o `Buffer`), un
 * objeto con esa forma, una lista de pares `[ruta, texto]` o una lista de `{ file, text }`. Un `Buffer` con un byte 0
 * es binario y no se mira.
 */

const path = require('path');

// Los marcadores se arman por partes: ninguna línea de este archivo es exactamente un marcador.
const INTERNAL_START = '<!-- tycon:' + 'internal-start -->';
const INTERNAL_END = '<!-- tycon:' + 'internal-end -->';
const PUBLIC_START = '<!-- tycon:' + 'public-only';
const PUBLIC_END = '-' + '->';
// Un marcador «casi» bien escrito: un comentario HTML que empieza como un marcador
// y no ES uno —un espacio de más o de menos, otra caja, un guion bajo, dentro de una cita o de un ítem de lista, con
// texto en la misma línea—. No es ni marcador ni error, y frena: si la apertura y el cierre traen la misma errata, el
// bloque entero saldría en la copia con todo en verde. Nombrar el marcador en la prosa, sin el comentario
// (`tycon:internal-start`), no cuenta.
// Dos formas, las dos frenan (una errata de DOS caracteres —`::`, `__`, `--`— o con otro separador —`.`, `,`, `/`— no
// sería ni marcador ni error, y el bloque saldría):
//   · un comentario que empieza con la palabra del arnés y, tras cualquier separador corto, «internal» o «public»;
//   · un comentario que nombra el cuerpo de un marcador (`internal-start`, `internal-end`, `public-only`, con guion,
//     guion bajo o espacio) aunque la primera palabra esté mal escrita o falte.
// Sin comillas ni `+` en el medio: el código que ARMA un marcador por partes (este archivo, las pruebas) no es un marcador.
//
// Las dos formas no piden palabras exactas: una errata DENTRO de «internal» (`intenral`, `interal`) o un comentario
// partido en renglones también cuentan, y los comentarios comunes que nombran «internal endpoints» o «public only» no
// frenan. Se compara el CONTENIDO del comentario, sólo sus letras, contra el cuerpo de cada marcador, con hasta dos
// letras de distancia:
//   · el contenido entero (con o sin la palabra del arnés adelante) a ≤2 letras de un cuerpo de marcador;
//   · o el contenido EMPIEZA con la palabra del arnés (a ≤1 letra), un separador corto y una palabra a ≤2 letras de
//     «internal» o «public»: ese comienzo queda reservado para los marcadores;
//   · un comentario que el renglón deja abierto suma el renglón de abajo hasta su cierre (el comentario partido).
// Un comentario común trae texto de más y queda lejos de los dos.
const HARNESS_WORD = 'tycon';
const MARKER_BODIES = ['internalstart', 'internalend', 'publiconly'].flatMap((b) => [b, HARNESS_WORD + b]);
// El código que arma un marcador por partes es una concatenación de cadenas (`'…' + '…'`); una comilla o un apóstrofo
// sueltos en el comentario no (un `isn't` dejaría salir el bloque).
const BUILT_BY_PARTS = /['"`]\s*\+|\+\s*['"`]/;
// Un renglón que es una cadena de código (`'tycon:internal-start',`) no es un marcador suelto.
const QUOTED = /['"`]/;

/** Los comentarios de un renglón: `[{ content, closed }]`. Con `indexOf` y no con un regex: con una línea enorme de
 *  guiones y sin cierre, un regex tardaría en proporción al cuadrado del largo. */
function commentsOf(raw) {
  const out = [];
  let pos = 0;
  for (;;) {
    const i = raw.indexOf('<!-', pos);
    if (i < 0) return out;
    let j = i + 3;
    while (raw[j] === '-') j++;
    const k = raw.indexOf('-->', j);
    if (k < 0) {
      out.push({ content: raw.slice(j), closed: false });
      return out;
    }
    out.push({ content: raw.slice(j, k), closed: true });
    pos = k + 3;
  }
}

/** Distancia entre dos textos cortos (letras cambiadas, de más, de menos o dos vecinas cambiadas de lugar), con tope:
 *  cualquier valor mayor que `max` vuelve como `max + 1`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return Math.min(d[a.length][b.length], max + 1);
}

const lettersOf = (s) => s.normalize('NFD').toLowerCase().replace(/[^a-z]/g, '');

/** Si en `words`, desde `from` (o en cualquier lugar, con `from` = -1), viene la palabra del arnés y después una
 *  palabra cercana a «internal» o «public». */
function harnessPair(words, from) {
  return words.some((w, i) => (from < 0 || i === from) && i + 1 < words.length && distance(w.toLowerCase(), HARNESS_WORD, 1) <= 1
    && ['internal', 'public'].some((x) => distance(words[i + 1].toLowerCase(), x, 2) <= 2));
}

/** Si el contenido de un comentario es, o casi, el de un marcador. `ownLine`: la parte del comentario que está en el
 *  renglón donde abre; `content`: el comentario entero, con los renglones de abajo si quedó abierto. */
function nearContent(content, ownLine = content) {
  if (BUILT_BY_PARTS.test(content)) return false;
  const letters = lettersOf(content);
  if (MARKER_BODIES.some((b) => distance(letters, b, 2) <= 2)) return true;
  if (harnessPair(content.match(/[A-Za-z]+/g) || [], 0)) return true;
  // La palabra del arnés + «internal»/«public» en CUALQUIER lugar del renglón del comentario: con una etiqueta delante
  // (`BEGIN`, `marker:`) el bloque saldría. Sólo en ese
  // renglón: en los de abajo de un comentario abierto pescaba código que nombra `<!--` en un comentario.
  return harnessPair(ownLine.match(/[A-Za-z]+/g) || [], -1);
}

/** Un renglón que es SÓLO el cuerpo de un marcador con la palabra del
 *  arnés (`tycon:internal-start`, con hasta dos letras de diferencia), sin comentario: un `-->` en el medio cerró el
 *  comentario antes, o el comentario se partió en más renglones de los que se siguen. Nombrarlo en una frase trae texto
 *  de más, y un título como «Internal start» no trae la palabra del arnés. */
const HARNESS_BODIES = MARKER_BODIES.filter((b) => b.startsWith(HARNESS_WORD));
function bareBody(raw) {
  if (QUOTED.test(raw)) return false;
  const letters = lettersOf(raw);
  return letters.length >= 12 && letters.length <= 20 && HARNESS_BODIES.some((b) => distance(letters, b, 2) <= 2);
}

const isMarker = (t) => t === INTERNAL_START || t === INTERNAL_END || t === PUBLIC_START;

/** Hasta cuántos renglones de abajo sigue un comentario que el renglón deja abierto. */
const OPEN_COMMENT_LINES = 5;

/** Un renglón que trae un marcador casi bien escrito (`below`: los renglones de abajo, para el comentario partido). Un
 *  comentario que el renglón deja abierto sigue en los de abajo hasta su cierre (como mucho `OPEN_COMMENT_LINES`):
 *  cualquier cosa delante del `<!--` (prosa, un ítem de lista numerada) o el corte en el medio del contenido no lo
 *  esconden (`Ver <!--` y el comentario partido en tres o cuatro renglones dejarían salir el bloque). */
function isNearMarker(raw, below = []) {
  if (isMarker(raw.trim())) return false;
  if (!raw.includes('<!-')) return bareBody(raw);
  for (const c of commentsOf(raw)) {
    let contenido = c.content;
    if (!c.closed) {
      for (const l of below.slice(0, OPEN_COMMENT_LINES)) {
        const cierre = l.indexOf('-->');
        contenido += ` ${cierre < 0 ? l : l.slice(0, cierre)}`;
        if (cierre >= 0) break;
      }
    }
    if (nearContent(contenido, c.content)) return true;
  }
  return false;
}

const SOURCE_DIRS = ['arnes/', 'agent-skills/'];
const MANIFEST = 'scripts/publishing/third-party-skills.json';
const FREE_LICENSES = new Set(['MIT', 'Apache-2.0']);

// ── utilidades ───────────────────────────────────────────────────────────────────────────────────────────────────

/** La ruta desde la raíz del repo de su fuente (sin la carpeta `arnes/` o `agent-skills/` de la copia de dos repos). */
function inRepo(file) {
  const dir = SOURCE_DIRS.find((d) => file.startsWith(d));
  return dir ? file.slice(dir.length) : file;
}

const lastPiece = (p) => String(p).replace(/\/+$/, '').split('/').pop();

/** Texto de un archivo de la copia; `null` si es binario. */
function asText(content) {
  if (Buffer.isBuffer(content)) return content.includes(0) ? null : content.toString('utf8');
  return typeof content === 'string' ? content : null;
}

/** La copia como lista de `[ruta, texto]` (ver la cabecera: cuatro formas aceptadas). */
function fileEntries(files) {
  let list;
  if (files instanceof Map) list = [...files.entries()];
  else if (Array.isArray(files)) list = files.map((x) => (Array.isArray(x) ? x : [x.file, x.text]));
  else list = Object.entries(files || {});
  return list.map(([f, c]) => [f, asText(c)]);
}

/** Un cerco de código (CommonMark): abre con 3+ ``` o ~~~ y cierra con el MISMO carácter, al menos igual de largo y
 *  sin nada más en la línea. Devuelve el cerco abierto después de la línea (el mismo criterio que `export.js`). */
function fence(line, open) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''));
  if (!m) return open;
  if (!open) return m[1][0] === '`' && m[2].includes('`') ? null : { ch: m[1][0], len: m[1].length };
  return m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim() ? null : open;
}

/** Recorre las líneas fuera de los cercos de código: `fn(línea, número)` (los números empiezan en 1). */
function eachProseLine(text, fn) {
  let open = null;
  text.split('\n').forEach((line, i) => {
    const before = open;
    open = fence(line, open);
    if (!before && !open) fn(line, i + 1);
  });
}

const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;

// ── internal-blocks ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Saca de un `.md` los bloques internos (marcadores incluidos) y deja visible el contenido de los sólo-públicos (sin
 * sus dos líneas de marcador). Un marcador es una línea entera (recortada) igual al marcador; el cierre `-->` cuenta
 * sólo con un sólo-público abierto. Errores: sin par, anidado (también un comentario HTML dentro de un sólo-público,
 * que en el interno lo cerraría antes de tiempo), dentro de un cerco de código o entre dos filas de tabla. Con
 * errores el texto vuelve como estaba.
 * @returns {{ text: string, changed: boolean, errors: {file: string, line: number, why: string}[] }}
 */
function internalBlocks(text, file) {
  const ls = text.split('\n');
  const out = [];
  const errors = [];
  const err = (line, why) => errors.push({ file, line, why });
  let open = null;   // cerco de código abierto
  let block = null;  // { kind: 'internal' | 'public', line }
  const isRow = (l) => l !== undefined && l.trimStart().startsWith('|');

  ls.forEach((raw, i) => {
    const n = i + 1;
    const t = raw.trim();
    let marker = null;
    if (t === INTERNAL_START) marker = 'internal-start';
    else if (t === INTERNAL_END) marker = 'internal-end';
    else if (t === PUBLIC_START) marker = 'public-start';
    else if (t === PUBLIC_END && block && block.kind === 'public') marker = 'public-end';

    if (!marker && isNearMarker(raw, ls.slice(i + 1, i + 1 + OPEN_COMMENT_LINES))) {
      return err(n, 'marcador casi igual a uno de bloque: va solo en su línea y escrito exacto (un espacio de cada lado, en minúsculas, sin cita ni viñeta adelante); así como está no se reconoce y el bloque saldría en la copia');
    }
    if (marker) {
      if (open) return err(n, 'marcador dentro de un cerco de código: el bloque entero (con su cerco) va adentro');
      if (isRow(ls[i - 1]) && isRow(ls[i + 1])) return err(n, 'marcador entre dos filas de una tabla: la tabla entera va adentro');
      if (marker === 'internal-start' || marker === 'public-start') {
        if (block) return err(n, `marcador anidado: ya hay un bloque abierto en la línea ${block.line}`);
        block = { kind: marker === 'internal-start' ? 'internal' : 'public', line: n };
        return undefined;
      }
      if (marker === 'internal-end') {
        if (!block) return err(n, 'cierre de bloque interno sin su apertura');
        if (block.kind !== 'internal') return err(n, `cierre de bloque interno dentro del sólo-público de la línea ${block.line}`);
      }
      block = null;
      return undefined;
    }

    if (block && block.kind === 'public' && (raw.includes('<!--') || raw.includes(PUBLIC_END))) {
      err(n, `comentario HTML anidado en el sólo-público de la línea ${block.line}: en el interno lo cerraría antes de tiempo`);
    }
    open = fence(raw, open);
    if (!block || block.kind === 'public') out.push(raw);
    return undefined;
  });
  if (block) err(block.line, `bloque ${block.kind === 'internal' ? 'interno' : 'sólo-público'} sin su cierre`);

  if (errors.length) return { text, changed: false, errors };
  const result = out.join('\n');
  return { text: result, changed: result !== text, errors };
}

/** Las líneas que son un marcador de bloque, o casi (para el error «marcador fuera de un `.md`»): `[{ line, marker }]`.
 *  Fuera de un `.md` nada se saca: un marcador ahí, bien o casi bien escrito, es alguien que creyó que el bloque no salía. */
function markerLines(text) {
  const found = [];
  const ls = text.split('\n');
  ls.forEach((raw, i) => {
    const t = raw.trim();
    if (isMarker(t) || isNearMarker(raw, ls.slice(i + 1, i + 1 + OPEN_COMMENT_LINES))) found.push({ line: i + 1, marker: t });
  });
  return found;
}

// ── links ────────────────────────────────────────────────────────────────────────────────────────────────────────

// el destino admite paréntesis balanceados de un nivel (`notas(2026).md`), como CommonMark
const LINK = /\]\(\s*(<[^>\n]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Enlaces relativos de Markdown `](x)` de los `.md` de la copia que apuntan a algo que no está. Fuera de cercos y de
 * código en línea; ignora esquemas (`https:`, `mailto:`…), `//…`, `/…` y `#…`; quita `#…` y `?…` y resuelve contra
 * la carpeta del archivo. `exists(ruta)` dice si la ruta es un archivo o una carpeta de la copia.
 * @returns {{file: string, line: number, target: string, resolved: string}[]}
 */
function brokenLinks(files, exists) {
  const found = [];
  for (const [file, text] of fileEntries(files)) {
    if (text === null || !/\.md$/i.test(file)) continue;
    const dir = path.posix.dirname(file);
    let enComentario = false;   // un comentario HTML no se muestra: sus enlaces no cuentan (puede ocupar varias líneas)
    const sinComentarios = (s) => {
      let out = '';
      let rest = s;
      while (rest) {
        if (enComentario) {
          const fin = rest.indexOf('-->');
          if (fin === -1) return out;
          rest = rest.slice(fin + 3); enComentario = false;
        } else {
          const ini = rest.indexOf('<!--');
          if (ini === -1) return out + rest;
          out += rest.slice(0, ini); rest = rest.slice(ini + 4); enComentario = true;
        }
      }
      return out;
    };
    eachProseLine(text, (line, n) => {
      const prose = sinComentarios(line.replace(CODE_SPAN, (m) => ' '.repeat(m.length)));
      for (const m of prose.matchAll(LINK)) {
        const target = m[1].replace(/^<|>$/g, '');
        if (!target || SCHEME.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
        let bare = target.replace(/[#?].*$/, '');
        if (!bare) continue;
        try { bare = decodeURIComponent(bare); } catch { /* un % suelto: se resuelve tal cual */ }
        const resolved = path.posix.normalize(path.posix.join(dir, bare)).replace(/\/+$/, '');
        if (resolved === '.' || resolved === '') continue;
        if (!exists(resolved)) found.push({ file, line: n, target, resolved });
      }
    });
  }
  return found;
}

// ── readme-paths ─────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT_DOCS = new Set(['README.md', 'INSTALL.md', 'arnes/README.md', 'arnes/INSTALL.md']);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Rutas entre comillas invertidas del `README.md` y el `INSTALL.md` de la raíz del arnés (en la copia de dos repos,
 * `arnes/README.md` y `arnes/INSTALL.md`) que no están en la copia. Cuenta el código en línea fuera de cercos cuyo
 * primer pedazo (antes de la primera `/`, en su primera palabra) es una entrada de `firstLevel`, salvo `.tycon`; quita
 * `:N`, `:N-M` y `#…`; con `<` o `{` se saltea; con `*` o `?` es un glob que tiene que coincidir con alguna ruta (o
 * carpeta) de `files`; si no, pregunta `exists(ruta)`.
 * @returns {{file: string, line: number, path: string}[]}
 */
function readmePaths(files, firstLevel, exists) {
  const entries = fileEntries(files);
  const first = new Set(firstLevel);
  first.delete('.tycon');
  let candidates = null;
  const anyMatch = (re) => {
    if (!candidates) {
      candidates = new Set();
      for (const [f] of entries) {
        const parts = inRepo(f).split('/');
        for (let k = 1; k <= parts.length; k++) candidates.add(parts.slice(0, k).join('/'));
      }
    }
    for (const c of candidates) if (re.test(c)) return true;
    return false;
  };

  const found = [];
  for (const [file, text] of entries) {
    if (text === null || !ROOT_DOCS.has(file)) continue;
    eachProseLine(text, (line, n) => {
      for (const m of line.matchAll(CODE_SPAN)) {
        const token = m[2].trim().split(/\s+/)[0];
        if (!token || /[<{]/.test(token) || !first.has(token.split('/')[0])) continue;
        const p = token.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/\/+$/, '');
        if (!p) continue;
        const ok = /[*?]/.test(p) ? anyMatch(globToRegExp(p)) : exists(p);
        if (!ok) found.push({ file, line: n, path: p });
      }
    });
  }
  return found;
}

// ── not-in-copy ──────────────────────────────────────────────────────────────────────

/** La marca que lleva al lado una ruta del repo del equipo que la copia no trae. Un solo lugar: la usan la transformación
 *  y el control `pathsNotInCopy` del exportador. */
const NOT_IN_COPY_MARK = ' _(del repo del equipo; no está en esta copia)_';

/**
 * El código en línea de la prosa de un `.md`, leído como CommonMark:
 * fuera de los cercos, párrafo por párrafo (un renglón en blanco corta), una tanda de comillas invertidas abre y la cierra
 * la próxima tanda del MISMO largo — puede estar en el renglón siguiente del párrafo—; una tanda sin pareja es texto y no
 * se come la apertura de un código posterior. El contenido: los saltos de renglón pasan a espacio y, si empieza y termina
 * con espacio (y no es sólo espacios), se le saca uno de cada lado. Lo comparten la marca y su control: los dos leen el
 * mismo código en línea, y cada uno decide por su cuenta qué hace con él.
 * @returns {{ end: number, line: number, content: string }[]} `end`: la posición después de la tanda que cierra; `line`:
 *   el renglón (desde 1) donde cierra.
 */
function proseCodeSpans(text) {
  const spans = [];
  const lines = text.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  let open = null;
  let parrafo = null;   // { ini, fin } posiciones en `text`
  const cerrar = () => {
    if (!parrafo) return;
    const t = text.slice(parrafo.ini, parrafo.fin);
    const tandas = [];
    for (const m of t.matchAll(/`+/g)) tandas.push({ at: m.index, len: m[0].length });
    for (let i = 0; i < tandas.length; i++) {
      const j = tandas.findIndex((x, k) => k > i && x.len === tandas[i].len);
      if (j === -1) continue;
      let content = t.slice(tandas[i].at + tandas[i].len, tandas[j].at).replace(/\n/g, ' ');
      if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
      const end = parrafo.ini + tandas[j].at + tandas[j].len;
      spans.push({ end, line: text.slice(0, end).split('\n').length, content });
      i = j;
    }
    parrafo = null;
  };
  lines.forEach((line, i) => {
    const before = open;
    open = fence(line, open);
    if (before || open || !line.trim()) { cerrar(); return; }
    const fin = starts[i] + line.length;
    if (parrafo) parrafo.fin = fin; else parrafo = { ini: starts[i], fin };
  });
  cerrar();
  return spans;
}

/** La ruta que nombra un código en línea, o `null` si no es una ruta que se pueda mirar: el primer pedazo, sin `#…`, sin
 *  `:N`/`:N-M` y sin la barra final; con un prefijo de instalación (`installPrefixes`: las formas con que las skills
 *  nombran un archivo del arnés instalado; las arma el exportador con el nombre del lugar), desde la raíz (`rootOnly`);
 *  con `<`, `{`, `*`, `?` o una comilla invertida es un ejemplo, un glob o código. */
function codePath(code, installPrefixes = []) {
  let token = code.trim().split(/\s+/)[0] || '';
  // cada prefijo: un texto con que empieza el pedazo, o un par [expresión, prefijo que queda]
  const prefijo = installPrefixes.find((x) => (typeof x === 'string' ? token.startsWith(x) : x[0].test(token)));
  if (prefijo !== undefined) token = typeof prefijo === 'string' ? token.slice(prefijo.length) : prefijo[1] + token.replace(prefijo[0], '');
  if (!token || /[<{*?`]/.test(token) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return null;
  const p = token.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..')) return null;
  return { path: p, anchor: token.includes('#'), rootOnly: prefijo !== undefined };
}

/** La ruta de una convención del repo del lector (`allowlist.json → readerConventions`): con `/` al final, la carpeta y
 *  todo lo de adentro; sin ella, sólo esa ruta exacta (`specs` es la carpeta suelta, no `specs/story-…`). */
function isReaderConvention(p, conventions) {
  return (conventions || []).some((c) => (c.endsWith('/') ? p === c.slice(0, -1) || p.startsWith(c) : p === c));
}

/**
 * Marca en un `.md` cada ruta entre comillas invertidas, en prosa (fuera de los cercos), que existe en el repo del equipo
 * —desde la raíz, relativa a la carpeta del archivo, o con un prefijo de instalación de `installPrefixes`— y no en la copia: le pone `NOT_IN_COPY_MARK` al lado y deja la
 * ruta tal cual. No marca: una ruta de la copia (desde la raíz o desde la carpeta del archivo), lo que no existe en el
 * repo, un ancla al registro de incidentes, las convenciones del repo del lector, ni el README y el INSTALL de la raíz (los
 * mira `readmePaths`). Idempotente. `inRepo(p)` / `inCopy(p)`: ¿la ruta (desde la raíz de su repo, archivo o carpeta) está
 * en el repo del equipo / en la copia?
 * @returns {{ text: string, changed: boolean, marked: {line: number, path: string}[] }}
 */
function markPathsNotInCopy(text, file, opts) {
  const { inRepo: teamHas, inCopy: copyHas, conventions = [], installPrefixes = [] } = opts;
  const marked = [];
  if (!/\.md$/i.test(file) || ROOT_DOCS.has(file)) return { text, changed: false, marked };
  const dir = path.posix.dirname(inRepo(file));
  const cortes = [];
  for (const s of proseCodeSpans(text)) {
    const cp = codePath(s.content, installPrefixes);
    if (!cp || text.startsWith(NOT_IN_COPY_MARK, s.end)) continue;
    const p = cp.path;
    if (cp.anchor && p === 'guides/maintaining/incident-log.md') continue;
    const relativa = !cp.rootOnly && dir !== '.' ? path.posix.normalize(`${dir}/${p}`) : null;
    if (copyHas(p) || (relativa && copyHas(relativa))) continue;
    // la vecina del archivo es la lectura más específica: gana sobre una convención suelta que se llama igual (`tasks`)
    const esDelEquipo = (x) => x && teamHas(x) && !isReaderConvention(x, conventions);
    const delEquipo = esDelEquipo(relativa) ? relativa : esDelEquipo(p) ? p : null;
    if (!delEquipo) continue;
    cortes.push(s.end);
    marked.push({ line: s.line, path: delEquipo });
  }
  if (!cortes.length) return { text, changed: false, marked };
  let out = '';
  let last = 0;
  for (const c of cortes) { out += text.slice(last, c) + NOT_IN_COPY_MARK; last = c; }
  out += text.slice(last);
  return { text: out, changed: true, marked };
}

// ── attributions ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El `NOTICE` contra las entradas `derived` del manifiesto (con su `target` como queda en la copia, después de
 * `skill-rename`). Cada atribución es una línea que empieza con `* <ruta>` (la ruta puede ir entre comillas
 * invertidas). Falta la línea de un `derived` que sale; sobra la que nombra algo que no es un `derived` que sale, y la
 * repetida. `ships` es un `Set`/lista de rutas o una función `(ruta, entrada) → boolean`.
 * @returns {{file: string, line: number, path: string, why: string}[]}
 */
function attributions(noticeText, derived, ships) {
  const shipsFn = typeof ships === 'function' ? ships : ((s) => (p) => s.has(p))(new Set(ships));
  const expected = new Set((derived || []).filter((d) => shipsFn(d.target, d)).map((d) => d.target));
  const known = new Set((derived || []).map((d) => d.target));
  const found = [];
  const listed = new Set();
  noticeText.split('\n').forEach((raw, i) => {
    const m = /^\* +`?([^`\s]+)`?/.exec(raw.replace(/\r$/, ''));
    if (!m) return;
    const p = m[1].replace(/\/+$/, '');
    if (listed.has(p)) found.push({ file: 'NOTICE', line: i + 1, path: p, why: 'atribución repetida' });
    else if (!expected.has(p)) {
      found.push({ file: 'NOTICE', line: i + 1, path: p, why: known.has(p) ? 'nombra algo que no sale en la copia' : 'nombra algo que no sale como entrada derived del manifiesto' });
    }
    listed.add(p);
  });
  for (const p of expected) {
    if (!listed.has(p)) found.push({ file: 'NOTICE', line: 0, path: p, why: 'falta su atribución en el NOTICE' });
  }
  return found;
}

// ── JSON que conserva el formato: se ubica cada valor y se edita el texto, nunca se re-serializa ─────────────────

/** Árbol de posiciones de un JSON válido: `{ type: 'object'|'array'|'value', start, end, children: [{ key, start,
 *  end, value }] }` (los `end` son exclusivos). */
function parseJson(t) {
  let i = 0;
  const ws = () => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
  const string = () => {
    const s = i;
    i++;
    while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(t.slice(s, i));
  };
  const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const value = () => {
    ws();
    const start = i;
    if (t[i] === '{' || t[i] === '[') {
      const object = t[i] === '{';
      const close = object ? '}' : ']';
      const type = object ? 'object' : 'array';
      i++;
      const children = [];
      ws();
      if (t[i] === close) { i++; return { type, start, end: i, children }; }
      for (;;) {
        ws();
        const childStart = i;
        let key;
        if (object) { key = string(); ws(); i++; }
        const v = value();
        children.push({ key, start: childStart, end: v.end, value: v });
        ws();
        if (t[i] === ',') { i++; continue; }
        i++;
        return { type, start, end: i, children };
      }
    }
    if (t[i] === '"') { string(); return { type: 'value', start, end: i }; }
    LITERAL.lastIndex = i;
    i += LITERAL.exec(t)[0].length;
    return { type: 'value', start, end: i };
  };
  return value();
}

const member = (node, key) => (node && node.type === 'object' ? node.children.find((c) => c.key === key) : undefined);

/** Deja en el contenedor sólo los hijos `keep` (índices en orden), con los separadores y la sangría del original. */
function keepChildren(t, cont, keep) {
  const h = cont.children;
  if (keep.length === h.length) return t;
  let body;
  if (!keep.length) body = t[cont.start] + t[cont.end - 1];
  else {
    const parts = keep.map((k, n) => t.slice(h[k].start, h[k].end) + (n < keep.length - 1 ? t.slice(h[k].end, h[k + 1].start) : ''));
    body = t.slice(cont.start, h[0].start) + parts.join('') + t.slice(h[h.length - 1].end, cont.end);
  }
  return t.slice(0, cont.start) + body + t.slice(cont.end);
}

function parseManifest(text) {
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error(`${MANIFEST}: JSON inválido (${e.message})`);
  }
  return parseJson(text);
}

/** En el manifiesto, la entrada `derived` de la skill renombrada (por su `target` viejo o nuevo): los rangos que no se
 *  tocan (`based_on`, `license_source`) y el valor de su `why`. */
function manifestRanges(text, rule) {
  const root = parseManifest(text);
  const derived = member(root, 'derived');
  const res = { keep: [], why: null };
  if (!derived || derived.value.type !== 'array') return res;
  for (const c of derived.value.children) {
    const target = member(c.value, 'target');
    if (!target) continue;
    const v = JSON.parse(text.slice(target.value.start, target.value.end));
    if (v !== rule.from && v !== rule.to) continue;
    for (const k of ['based_on', 'license_source']) {
      const m = member(c.value, k);
      if (m) res.keep.push([m.value.start, m.value.end]);
    }
    const why = member(c.value, 'why');
    if (why) res.why = [why.value.start, why.value.end];
    break;
  }
  return res;
}

// ── skill-rename ─────────────────────────────────────────────────────────────────────────────────────────────────

/** La lista cerrada de archivos que conservan el nombre viejo: el `NOTICE` de la raíz y el `NOTICE.md` y el `LICENSE`
 *  de la carpeta renombrada (con su ruta vieja o nueva). Los dos campos del manifiesto los maneja `manifestRanges`. */
function renameExceptions(rule) {
  return ['NOTICE', ...[rule.from, rule.to].flatMap((d) => [`${d}/NOTICE.md`, `${d}/LICENSE`])];
}

/**
 * Reemplaza el identificador de la skill (el último pedazo de `rule.from`) por el nuevo (el de `rule.to`) en el texto
 * de un archivo que sale. Salvo la lista cerrada: el `NOTICE`, el `NOTICE.md` y el `LICENSE` de la carpeta quedan
 * intactos; en el manifiesto de terceros, `based_on` y `license_source` de la entrada `derived` de la skill quedan
 * intactos y su `why` pasa a `rule.why` (edición en su lugar). Un manifiesto ilegible tira.
 * @param {{from: string, to: string, why?: string}} rule
 * @returns {{ text: string, changed: boolean }}
 */
function renameSkill(text, file, rule) {
  const oldId = lastPiece(rule.from);
  const newId = lastPiece(rule.to);
  const f = inRepo(file);
  if (renameExceptions(rule).includes(f)) return { text, changed: false };
  const swap = (s) => s.split(oldId).join(newId);
  if (f !== MANIFEST) {
    const out = swap(text);
    return { text: out, changed: out !== text };
  }
  const { keep, why } = manifestRanges(text, rule);
  const spans = keep.map(([s, e]) => ({ s, e, put: text.slice(s, e) }));
  if (why && typeof rule.why === 'string') spans.push({ s: why[0], e: why[1], put: JSON.stringify(rule.why) });
  spans.sort((a, b) => a.s - b.s);
  let out = '';
  let at = 0;
  for (const sp of spans) {
    out += swap(text.slice(at, sp.s)) + sp.put;
    at = sp.e;
  }
  out += swap(text.slice(at));
  return { text: out, changed: out !== text };
}

/**
 * Lo que quedó con el nombre viejo después de `renameSkill`: cada línea que lo nombra (fuera de las excepciones y de
 * los dos campos del manifiesto) y cada ruta que lo lleva (con `line: 0`). `exceptions` reemplaza la lista cerrada
 * (por defecto, `renameExceptions(rule)`).
 * @returns {{file: string, line: number, text: string}[]}
 */
function renameLeft(files, rule, exceptions = renameExceptions(rule)) {
  const oldId = lastPiece(rule.from);
  const skip = new Set(exceptions);
  const found = [];
  for (const [file, text] of fileEntries(files)) {
    const f = inRepo(file);
    // el nombre viejo en cualquier parte de la ruta (una carpeta entera o dentro del nombre de un archivo): el renombre
    // sólo mueve la carpeta de la skill, así que cualquier otra ruta que lo lleve quedó con el nombre viejo
    if (f.includes(oldId)) found.push({ file, line: 0, text: file });
    if (text === null || skip.has(f) || !text.includes(oldId)) continue;
    const keep = f === MANIFEST ? manifestRanges(text, rule).keep : [];
    let offset = 0;
    text.split('\n').forEach((line, i) => {
      for (let k = line.indexOf(oldId); k !== -1; k = line.indexOf(oldId, k + 1)) {
        const at = offset + k;
        if (keep.some(([s, e]) => at >= s && at < e)) continue;
        found.push({ file, line: i + 1, text: line.trim() });
        break;
      }
      offset += line.length + 1;
    });
  }
  return found;
}

// ── public-third-party ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deja en `third_party` del manifiesto sólo las entradas `install: "download"` que el arnés usa —su `used_by` nombra
 * una skill que sale o una entrada que queda (cierre transitivo), o la entrada trae `publish: true` (la
 * copia la ofrece aunque nada de lo que sale la nombre, como BMAD completo o las de .NET y React)— y cuya licencia (la
 * de la entrada, o la de su `origins[from]`) es MIT o Apache-2.0. Se van las demás, `official-plugin` y `retire` incluidas; `own`, `derived`,
 * `origins` y el resto del archivo quedan byte a byte. `shippedSkills`: nombres (o rutas `skills/<nombre>`) de las
 * skills que salen. Un manifiesto ilegible tira.
 * @returns {{ text: string, kept: string[], removed: string[] }}
 */
function publicThirdParty(jsonText, shippedSkills) {
  const root = parseManifest(jsonText);
  const data = JSON.parse(jsonText);
  const node = member(root, 'third_party');
  if (!node || node.value.type !== 'array' || !Array.isArray(data.third_party)) return { text: jsonText, kept: [], removed: [] };
  const entries = data.third_party;
  const origins = data.origins || {};
  const licenseOf = (e) => (e.license !== undefined ? e.license : (origins[e.from] || {}).license);
  const eligible = entries.map((e) => !!e && e.install === 'download' && FREE_LICENSES.has(licenseOf(e)));

  const live = new Set([...(shippedSkills || [])].map(lastPiece));
  const keep = new Set();
  for (let grew = true; grew;) {
    grew = false;
    entries.forEach((e, i) => {
      if (!eligible[i] || keep.has(i)) return;
      if (e.publish === true || (e.used_by || []).some((u) => live.has(lastPiece(u)))) {
        keep.add(i);
        live.add(lastPiece(e.target));
        grew = true;
      }
    });
  }
  const idx = [...keep].sort((a, b) => a - b);
  return {
    text: keepChildren(jsonText, node.value, idx),
    kept: idx.map((i) => entries[i].target),
    removed: entries.filter((e, i) => !keep.has(i)).map((e) => (e && e.target)),
  };
}

module.exports = {
  INTERNAL_START, INTERNAL_END, PUBLIC_START, PUBLIC_END,
  internalBlocks, markerLines, brokenLinks, readmePaths, attributions,
  renameSkill, renameLeft, renameExceptions, publicThirdParty,
  // la marca de las rutas que no viajan (la usan la transformación y el control del exportador)
  NOT_IN_COPY_MARK, markPathsNotInCopy, proseCodeSpans, ROOT_DOCS,
  // el control de historia interna (internal-history.js) busca las rutas del equipo con los mismos
  // lectores que la marca
  codePath, isReaderConvention,
};
