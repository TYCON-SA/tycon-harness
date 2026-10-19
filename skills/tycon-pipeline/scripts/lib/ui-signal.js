#!/usr/bin/env node
/**
 * ui-signal.js — ¿la story toca pantalla? Fuente ÚNICA del detector (fix 2026-08-14; story 7.18, 2026-10-08).
 *
 * Lo consumen cuatro controles del cierre, que no copian la lógica: `marker.js` (`markerStoryIsUi`:
 * `mark-dod-runtime-checked`, `set-check dod`, `complete-step 8` y la guía del tester), `qa-guide.js`
 * (`isUiStory`), `on-pre-commit.js` (`storyIsUiStory`) y `lib/atdd-commit-gate.js` (`storyIsHandOperable`).
 * Hasta el 2026-08-14 vivía copiado en esos cuatro, con carpetas de un producto escritas en duro.
 *
 * Las cinco reglas (story 7.18). La primera que da sí, decide:
 *
 *   1. EXTENSIÓN de pantalla (.tsx / .jsx / .vue / .svelte) en un item de lista del frontmatter, o en cualquier
 *      entrada de una lista de archivos (entre corchetes, como `path:` de un item que es un mapa, en un bloque `|`).
 *   2. RUTA del frente (`front-end`/`frontend`, `src/app/`, `src/components/`) o NOMBRE DECLARADO por el repo
 *      (`.tycon/advisors.yaml → evidence.fe_paths`) en una LISTA DE ARCHIVOS: cualquier llave que empiece con
 *      `files` (files, files_to_create, files_to_modify, files_to_reference, files_to_delete, files-to-*, filesTo*…),
 *      sin distinguir mayúsculas, anidada o no. Cuenta lo que la entrada NOMBRA como ubicación (el prefijo
 *      «(Repo/Carpeta)», sus rutas, y la llave que la agrupa: `frontend:` → rutas); la prosa pegada a la ruta o en
 *      una sub-llave (`why:`, `description:`) no. Un `#` entre comillas es texto, no comentario.
 *      Una entrada cuyas rutas son TODAS documentos (.md/.txt, con ancla o número de línea) no cuenta por su ruta
 *      (un documento no es pantalla: deuda que dejó la story 7.6), salvo bajo src/app|pages|content/, donde un
 *      documento puede ser una página. `.mdx` cuenta siempre: es una página en los sitios que lo usan.
 *   3. RUTA o NOMBRE DECLARADO en un CAMPO ESTRUCTURADO (`repo`, `repos`, `target_repo`, `target_repos`, `tags`,
 *      `stack`, `layer`, `component`, `area`: valor suelto, entre corchetes o en bloque) o en cualquier cosa que
 *      cuelgue de `pipelines:` o `tandas:` (el nombre de la tanda incluido), sin distinguir mayúsculas. Una nota
 *      de la tanda que dice «el frontend es otra story» también marca: queda del lado seguro, a propósito.
 *   4. PROSA (`title`, `driver`, resúmenes, comentarios, todo lo demás): cuenta SÓLO si la story no declara
 *      archivos a tocar, y sin las rutas HTTP (`GET /…`, `/api/…`, URLs). «Declara archivos a tocar» =
 *      `files`, `files_to_create` o `files_to_modify` con al menos una entrada con forma de ruta: `TBD`, `null`,
 *      `~`, `[]` o sólo una lista de lectura no cuentan. Con archivos declarados, mandan las listas.
 *   5. ESCENARIOS de prueba de navegador en el cuerpo del spec.
 *
 * Por qué la prosa quedó de respaldo (story 7.18): una story de backend con sólo `.cs` en sus listas y una ruta
 * HTTP terminada en `/frontend` en el `driver` quedaba como de pantalla, y la guía del tester la bloqueaba sin
 * salida. Medido sobre 1.394 stories: leer sólo las dos llaves `files_to_*` sacaba 24 que SÍ tocan pantalla (sin
 * listas, su única señal es el título); estas cinco reglas cambian 11, ninguna de pantalla (10 en la revisión; la
 * otra es una story de backend con prosa dentro de su lista, que dejó de contar tras el pase adversarial).
 *
 * Dirección de falla: este detector ENDURECE controles (exige pruebas de navegador, rechaza
 * `set-check dod --manual`, pide la guía del tester). Sobre-detectar molesta; sub-detectar deja pasar una
 * pantalla sin correr sus pruebas. Por eso la señal genérica es AMPLIA, lo declarado se suma y nunca resta, y los
 * nombres declarados se toman en unión entre lo commiteado y la carpeta (modo freno).
 * Riesgo aceptado de la regla 4: a una story de pantalla que sólo se detectaba por su título, agregarle una lista
 * con archivos de backend la saca del detector. Esa baja nunca es muda: `uiSignalDetail` la marca
 * (`proseDropped`) y los controles la dicen en una línea con `proseDropNotice`.
 */

const { parseEvidenceConfig, discoverRepoRoot } = require('./evidence-config.js');

const UI_FM_FILES_RE = /^\s*-\s*["']?[^"'\n]*\.(tsx|jsx|vue|svelte)\b/mi;
const UI_FM_PATHS_RE = /front-?end|src\/app\/|src\/components\//i;
const UI_BODY_RE = /tests\/e2e\/|Playwright E2E|(^|\s)E2E-?\d/;
const UI_EXT_RE = /\.(tsx|jsx|vue|svelte)\b/i;
// Rutas HTTP: un verbo con su ruta, cualquier `/api/…` y las URLs. No son rutas de archivo.
const HTTP_ROUTE_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[^\s"'`)\]]*|(?<![\w.])\/api\/[^\s"'`)\]]*|https?:\/\/[^\s"'`)\]]*/gi;
const STRUCT_KEY_RE = /^(repo|repos|target_repo|target_repos|tags|stack|layer|component|area)$/i;
// `files`, `files_to_*`, `Files_To_*`, `files-to-*` y `filesToModify`: el camelCase pide la mayúscula, para que
// `filesystem` no cuente.
const FILE_LIST_KEY_RE = /^[Ff][Ii][Ll][Ee][Ss](?:[_-]|$)|^[Ff]iles[A-Z]/;
const TOUCH_LIST_KEY_RE = /^files(?:[_-]?to[_-]?(?:create|modify))?$/i;
const BATCH_KEY_RE = /^(pipelines|tandas)$/i;
const DOC_FILE_RE = /\.(md|txt)$/i;
const PAGE_DIR_RE = /(^|\/)src\/(app|pages|content)\//i;
const EMPTY_VALUE_RE = /^(tbd|null|~|none|n\/a|-)?$/i;
// Palabras con `/` o con punto que no son archivos: «N/A», «y/o», y los nombres de tecnología terminados en `.js`.
const NOT_PATH_RE = /^(n\/a|y\/o|and\/or|i\/o|e\/s|s\/n)$/i;
const TECH_NAME_RE = /^(node|next|vue|react|nuxt|express|three|chart|d3)\.js$/i;

function fmOf(content) {
  const parts = String(content).split(/^---\s*$/m);
  return parts.length >= 3 ? parts[1] : '';
}

/** Corta el comentario YAML (` #…`) sólo FUERA de comillas: en «"Api/X.cs (AC #2)"» el `#` es texto. */
function noComment(t) {
  const s = String(t);
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[,:{(]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '#' && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s;
}
const unquote = (t) => String(t).trim().replace(/^["'`]|["'`]$/g, '').trim();
const sinPrefijo = (t) => unquote(noComment(t)).replace(/^\([^)]*\)\s*/, '');
/** Una palabra limpia de lo que se le pega a una ruta: ancla (`#x`), número de línea (`:12`, `:L3-9`) y puntuación. */
const cleanToken = (w) => w.replace(/#.*$/, '').replace(/:(L?\d+(-\d+)?)?$/i, '').replace(/[.:;!?]+$/, '');
/** ¿Tiene forma de ruta? Con una `/`, o con una extensión que lleva alguna letra (`7.2` y `v2.0` no son archivos). */
const isPathToken = (w) => !!w && !NOT_PATH_RE.test(w) && !TECH_NAME_RE.test(w)
  && (w.includes('/') || /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,6}$/.test(w));

/** Items de una lista entre corchetes (`[a, "b"]`). Devuelve null si el valor no es una lista así. */
function flowItems(value) {
  const v = noComment(value).trim();
  if (!/^\[.*\]$/.test(v)) return null;
  return v.slice(1, -1).split(',').map(unquote).filter(Boolean);
}

/** Las rutas de una entrada (sin el prefijo «(Repo/Carpeta) »): las palabras con forma de ruta, ya limpias. */
function pathsOf(text) {
  return (sinPrefijo(text).match(/[^\s"'`,()[\]{}]+/g) || []).map(cleanToken).filter(isPathToken);
}
const isDocPath = (p) => DOC_FILE_RE.test(p) && !PAGE_DIR_RE.test(p);
/**
 * Una entrada es «sólo documentos» si tiene rutas y TODAS son documentos (no páginas). También la que es UNA ruta
 * de documento con espacios en el nombre («docs/Guia de uso.md»): termina en .md/.txt, no junta varias rutas (` y `,
 * `,`, `;`) y ninguna otra palabra tiene extensión.
 */
function isDocOnly(text) {
  const ps = pathsOf(text);
  if (ps.length > 0 && ps.every(isDocPath)) return true;
  const whole = cleanToken(sinPrefijo(text).trim());
  return isDocPath(whole) && !/\s(y|e|and|o|or)\s|[;,]/i.test(whole)
    && ps.every((p) => isDocPath(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p));
}
const looksLikePath = (text) => pathsOf(text).length > 0;
/**
 * Lo que una entrada de lista NOMBRA como ubicación: el prefijo «(Repo/Carpeta)» y sus rutas. La prosa pegada a la
 * ruta («Api/X.cs — el frontend lo consume») no cuenta. Una entrada de una sola palabra cuenta entera (un nombre
 * declarado en fe_paths puede no tener `/`).
 */
function entryLocation(text) {
  const t = unquote(noComment(text)).trim();
  if (!/\s/.test(t)) return t;
  const prefix = (t.match(/^\([^)]*\)/) || [''])[0];
  return [prefix, ...pathsOf(text)].join(' ');   // `text`, no `t`: ya sin comillas, un `#` de adentro cortaría
}
/** Las llaves de un mapa entre llaves (`{frontend: [a.ts], backend: [b.cs]}`). */
const flowMapKeys = (text) => {
  const t = unquote(noComment(text)).trim();
  return /^\{.*\}$/.test(t) ? [...t.matchAll(/[{,]\s*["']?([A-Za-z_][\w .-]*?)["']?\s*:/g)].map((m) => m[1]) : [];
};

/**
 * Las líneas del frontmatter con la cadena de llaves de la que cuelgan. Parser mínimo, sin dependencias: alcanza
 * con saber bajo qué llave está cada línea. Los comentarios de línea entera se saltean (son prosa, y la prosa se
 * mira aparte sobre el texto entero). `kind`: 'item' (`- x`), 'value' (`llave: x`) o 'cont' (línea de un bloque
 * `|` o continuación).
 */
function fmLines(fm) {
  const out = [];
  const stack = [];
  for (const raw0 of String(fm).split(/\r?\n/)) {
    const raw = raw0.replace(/\t/g, '  ');
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const item = raw.match(/^\s*-(?:\s+(.*))?$/);
    if (item) {
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      const chain = stack.map((s) => s.key);
      const text = item[1] || '';
      // Un item que es un mapa (`- path: x.ts`) es un item y además abre llaves para lo que sigue.
      const km = text.match(/^([A-Za-z_][\w .-]*?)\s*:(\s.*|)$/);
      out.push({ chain: km ? [...chain, km[1]] : chain, text: km ? km[2] : text, kind: 'item', key: km ? km[1] : null });
      if (km) stack.push({ indent: indent + 1, key: km[1] });
      continue;
    }
    const km = raw.match(/^\s*([A-Za-z_][\w .-]*?)\s*:(\s.*|)$/);
    if (km) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, key: km[1] });
      out.push({ chain: stack.map((s) => s.key), text: km[2], kind: 'value', key: km[1] });
      continue;
    }
    out.push({ chain: stack.map((s) => s.key), text: raw.trim(), kind: 'cont' });
  }
  return out;
}

/** Las entradas (texto) de las líneas que cuelgan de una llave que cumple `keyRe`. */
function entriesUnder(lines, keyRe) {
  const out = [];
  for (const l of lines) {
    if (!l.chain.some((k) => keyRe.test(k))) continue;
    const t = noComment(l.text).trim();
    if (l.kind === 'value') {
      const fl = flowItems(l.text);
      if (fl) out.push(...fl);
      else if (t && !/^[|>][-+]?$/.test(t)) out.push(l.text);
    } else if (t) {
      out.push(l.text);
    }
  }
  return out;
}

/**
 * El veredicto con su porqué: `{ ui, signal, proseDropped, dropReason }`.
 *   - `signal`: 'extension' | 'lista' | 'campo' | 'tanda' | 'prosa' | 'cuerpo' | null.
 *   - `proseDropped`: true cuando NO es de pantalla pero el detector de antes de la 7.18 sí la tomaba (la palabra
 *     del frente o un nombre declarado aparecen en el frontmatter, fuera de lo que manda). Es la «baja».
 *   - `dropReason`: 'documentos' (la mención está en documentos de las listas) o 'prosa'.
 */
function uiSignalParts(fm, body, repoRoot) {
  const f = fm || '';
  const verdict = (signal) => ({ ui: true, signal, proseDropped: false, dropReason: null });
  if (UI_FM_FILES_RE.test(f)) return verdict('extension');
  let fe = null;
  const hit = (t) => {
    if (UI_FM_PATHS_RE.test(t)) return true;
    if (fe === null) {
      // El caller puede pasar un SUBDIR del repo (el cwd de un `cd sub && git commit`, o el process.cwd() del
      // marker): se sube hasta `.git`, para que los nombres declarados no se pierdan según desde dónde corra.
      const root = discoverRepoRoot(repoRoot) || repoRoot || null;
      // Modo FRENO (caso C9): los nombres se toman en UNIÓN entre lo commiteado y la carpeta. Sacar un nombre sin
      // commitear no apaga la exigencia de navegador; agregarlo vale al toque.
      fe = f ? parseEvidenceConfig(root, { freno: true }).fePaths : [];
    }
    return fe.some((x) => x && t.includes(x));
  };
  const lines = fmLines(f);
  const fileEntries = entriesUnder(lines, FILE_LIST_KEY_RE);
  if (fileEntries.some((e) => UI_EXT_RE.test(noComment(e)))) return verdict('extension');
  if (fileEntries.some((e) => !isDocOnly(e) && hit(entryLocation(e)))) return verdict('lista');
  // Una lista agrupada por repo (`files_to_modify:` → `frontend:` → rutas, o `- FrontEnd: x.ts`, o entre llaves):
  // la llave que cuelga de la lista también nombra la ubicación.
  const subKeys = lines.flatMap((l) => {
    const i = l.chain.findIndex((k) => FILE_LIST_KEY_RE.test(k));
    return i < 0 ? [] : [...l.chain.slice(i + 1), ...(l.kind === 'cont' ? [] : flowMapKeys(l.text))];
  });
  if (subKeys.some((k) => hit(k))) return verdict('lista');
  const structEntries = [
    ...entriesUnder(lines, STRUCT_KEY_RE),
    ...lines.filter((l) => l.key && STRUCT_KEY_RE.test(l.key) && l.kind === 'item').map((l) => l.text),
  ];
  if (structEntries.some((e) => hit(noComment(e)))) return verdict('campo');
  if (lines.some((l) => l.chain.some((k) => BATCH_KEY_RE.test(k))
    && (hit(noComment(l.text)) || l.chain.some((k) => !BATCH_KEY_RE.test(k) && hit(k))))) {
    return verdict('tanda');
  }
  const declaresTouch = entriesUnder(lines, TOUCH_LIST_KEY_RE)
    .some((e) => !EMPTY_VALUE_RE.test(unquote(noComment(e))) && looksLikePath(e));
  if (!declaresTouch && hit(f.replace(HTTP_ROUTE_RE, ' '))) return verdict('prosa');
  if (UI_BODY_RE.test(body || '')) return verdict('cuerpo');
  const dropped = !!f && hit(f);
  const dropReason = !dropped ? null
    : (fileEntries.some((e) => isDocOnly(e) && hit(noComment(e))) ? 'documentos' : 'prosa');
  return { ui: false, signal: null, proseDropped: dropped, dropReason };
}

/** Variante por-partes, para callers que ya tienen el frontmatter separado (qa-guide). */
function touchesUiParts(fm, body, repoRoot) {
  return uiSignalParts(fm, body, repoRoot).ui;
}

/** ¿La story toca pantalla? `repoRoot` (opcional) habilita los nombres declarados en evidence.fe_paths. */
function storyTouchesUi(content, repoRoot) {
  if (!content) return false;
  return touchesUiParts(fmOf(content), content, repoRoot);
}

/** El veredicto con su porqué, sobre la story entera (ver `uiSignalParts`). */
function uiSignalDetail(content, repoRoot) {
  if (!content) return { ui: false, signal: null, proseDropped: false, dropReason: null };
  return uiSignalParts(fmOf(content), content, repoRoot);
}

/**
 * La línea que dice la baja (story 7.18, AC 6), o null si no hay baja que decir. La arma este módulo para que los
 * controles no copien el texto: la imprimen tal cual, una vez por comando, sin bloquear.
 */
function proseDropNotice(detail) {
  if (!detail || detail.ui || !detail.proseDropped) return null;
  const donde = detail.dropReason === 'documentos'
    ? 'sólo aparece en documentos (.md/.txt) de sus listas de archivos'
    : 'sólo aparece en la prosa del frontmatter (título, driver, comentarios), no en sus listas de archivos';
  return `ℹ️  La story se trata como SIN pantalla: la palabra del frente ${donde}. `
    + 'Si toca pantalla, declará sus archivos en files_to_modify.';
}

const REACT_EXT_RE = /\.(tsx|jsx)\b/i;

/**
 * El veredicto de pantalla según la regla `screen_test` de la organización: `ui` = el de siempre; `react` = una story
 * que sólo nombra pantallas `.svelte`/`.vue` no pide E2E; `off` = ninguna lo pide. Cuando la regla saca una story que
 * toca pantalla, `note` lo dice en una línea.
 * Devuelve `{ ui, note }`.
 */
function applyScreenRule(content, repoRoot, rule = 'ui') {
  const ui = storyTouchesUi(content, repoRoot);
  if (!ui || rule === 'ui') return { ui, note: null };
  if (rule === 'off') {
    return { ui: false, note: 'ℹ️  La story toca pantalla, pero la organización no exige la prueba E2E de pantalla (screen_test: off).' };
  }
  const detail = uiSignalDetail(content, repoRoot);
  if (rule === 'react' && detail.signal === 'extension' && !REACT_EXT_RE.test(fmOf(content) || '')) {
    return { ui: false, note: 'ℹ️  La story toca pantallas .svelte o .vue, y la organización sólo exige la prueba E2E de pantalla en .tsx/.jsx (screen_test: react).' };
  }
  return { ui, note: null };
}

module.exports = {
  storyTouchesUi, touchesUiParts, uiSignalDetail, proseDropNotice, applyScreenRule,
  UI_FM_FILES_RE, UI_FM_PATHS_RE, UI_BODY_RE,
};
