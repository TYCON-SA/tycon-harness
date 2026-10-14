#!/usr/bin/env node
'use strict';
// internal-history.js — el control de historia interna en la prosa que se publica (story 8.26, tanda G1 · 2026-10-09)
//
// POR QUÉ EXISTE: el arnés se va a escribir directo en un repo público. Hasta ahora, lo que una guía contaba de la
// historia del equipo —el número de una story, el código de una tanda, el caso que motivó la regla con su enlace al
// registro de incidentes, una rama, un commit, una corrida— lo tapaba en parte el exportador al armar la copia. Sin
// exportador, lo que se escribe es lo que sale: desde afuera nada de eso lleva a ningún lado, y dice con quién y sobre
// qué trabaja el equipo. La guía pública explica la regla y su porqué; el caso vive en el registro, que no se publica.
// Este control mira lo que un commit AGREGA a la prosa que se publica y, prendido, no deja crear el commit.
//
// QUÉ MIRA:
//   · La PROSA que se publica: los `.md` de guides/, de la raíz, getting-started/, .github/, claude-md-blocks/, skills/,
//     commands/, agents/ y packs/, por la ruta con que salen. El archivo entero (también los cercos de código: si no, la
//     anécdota se esconde en uno), y por párrafo: una forma partida por el corte de renglón se ve igual. Guiones,
//     pruebas, datos y YAML no son de este control: ahí sigue valiendo scripts/tests/internal-history.test.js (sin
//     números de pull request en nada de lo publicado).
//   · Qué se publica: en el repo del equipo (trae `team-profile.json`, o `perfil-equipo.json`) lo dice el exportador (`whatShips`, como el freno
//     de nombres) y se lee el texto COMO SALE —sin los bloques internos, un papel de public-files/ con la ruta de su
//     destino, y también lo que un paquete deja pendiente para la copia que une los paquetes—; en el repo público, todo
//     lo versionado. Con el perfil y sin la tabla privada es «no pude mirar»: un clon del equipo incompleto no es el
//     repo público.
//   · Lo neto, por archivo: por forma y por lo que la identifica (el número de la story, el ancla del caso…), cuántas
//     veces aparece después y cuántas antes EN ESE ARCHIVO (el mismo archivo aunque salga con otra ruta; en un renombre o
//     una copia, el de origen). El antes sólo cuenta si se publicaba y era prosa: retocar o renombrar una guía no frena;
//     lo que llega desde un archivo que no era prosa, sí. En un merge no es nuevo lo que traía cualquiera de las ramas.
//     Un archivo que empieza a publicarse se mira entero, y si el commit toca lo que decide qué se publica (la lista
//     blanca, la tabla, el manifiesto de un paquete, el exportador) se miran todos.
//   · Las formas: `FORMS`, abajo. Una ruta del equipo (`team-path`) necesita el árbol; las demás son expresiones.
//
// CÓMO FALLA: exit 0 = pasa · 1 = hallazgos · 2 = no pude mirar. El modo decide si eso frena: `block` frena con 1 y con
// 2; `warn` dice lo mismo y sale 0; apagado lo dice en cada commit. El modo se escribe en internal-history.json (por
// control y por forma) y `TYCON_INTERNAL_HISTORY=block|warn|0` lo pisa: un valor que no se entiende es `block`, y bajarlo
// por variable se dice en cada corrida. Un error propio también es «no pude mirar»: nunca un 1 que parezca un hallazgo.
// La última línea de la salida normal son las cuentas, SIEMPRE, para la validación:
//   internal-history: findings=N cannot_look=0|1 mode=block|warn|off [warnings=N] [looked=0] [measured=0]
// (`warnings` = hallazgos de formas que sólo avisan; `looked=0` = nada de lo tocado era prosa; `measured=0` = un rango
// sin commits). Nunca imprime el texto encontrado: archivo, línea y forma.
//
// Un dato o un ejemplo que tiene que quedar se declara con su archivo (la ruta con que sale), su forma, el valor EXACTO
// y el motivo en scripts/tests/fixtures/internal-history-allowed.json — nunca un archivo entero.
//
// A mano:
//   node scripts/publishing/internal-history.js [--repo <dir>] [--config <archivo>]   (lo stageado: el pre-commit)
//   node scripts/publishing/internal-history.js --range <base>...<punta>              (el diff de un pedido de cambio)
//   node scripts/publishing/internal-history.js --all [--json] [--ref <commit>]       (la cuenta de todo; no frena)
//   Para otra herramienta: require(...).scan(text, zone) → [{ form, value, line, col }] (pura: sin disco ni git).
// Guía: guides/publicacion-espejo.md §«La historia interna»

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SWITCH = 'TYCON_INTERNAL_HISTORY';
const CONFIG_PATH = 'scripts/publishing/internal-history.json';
const ALLOWED_PATH = 'scripts/tests/fixtures/internal-history-allowed.json';
const LIST_PATH = 'scripts/publishing/allowlist.json';
const TABLE_PATH = 'scripts/publishing/replacements.json';
// el perfil del equipo con su nombre de hoy o el de antes (los dos dicen «este árbol es del equipo»)
const PROFILES = ['team-profile.json', 'perfil-equipo.json'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZONES = ['prose', 'code', 'message'];
const PROSE_ROOTS = new Set(['guides', 'getting-started', '.github', 'claude-md-blocks', 'skills', 'commands', 'agents', 'packs']);

class CouldNot extends Error {}
const say = (s) => process.stderr.write(`${s}\n`);
// Lo que no sale crudo por la salida: los controles (las dos tandas: una terminal lee U+009B como el comienzo de una
// secuencia) y los separadores de línea de Unicode. Un solo lugar para los dos saneadores de abajo.
const UNPRINTABLE = '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029';
/** Una ruta para imprimir: git admite saltos de línea en un nombre, y el registro de una validación los leería como comandos. */
const shown = (p) => String(p).replace(new RegExp(`[${UNPRINTABLE}]`, 'g'), '?');

// ── las formas ────────────────────────────────────────────────────────────────────────────────────────────────────
// Cada forma: `re` (la expresión) y `key` (lo que la identifica dentro del texto encontrado: lo neto se cuenta por eso,
// así retocar las palabras de alrededor —la preposición, lo que hay entre la story y «del equipo»— no la hace nueva).
// El orden importa para `scan`: cuando dos formas ven el mismo pedazo de texto informa la primera (la story de un
// producto es UN hallazgo, no además un número de story). Sin `\b` pegado a una vocal acentuada: en JS corta antes.
const TEAM_OWNER = '(?:producto|repo|cliente|proyecto) del equipo';
const STORY = '[Ss]tor(?:y|ies)[ -]';
const STORY_ID = '(?:[0-9]+(?:\\.[0-9]+)*|[A-Z]{1,3}-[0-9]+)';
const SAME_SENTENCE = '(?:[^.\\n]|\\.(?=[0-9])){0,60}?';   // hasta 60 caracteres sin punto (el de un número no corta)
const OWNER = 'decisi(?:ón|on|ones) del (?:dev|dueño)';
const DATE = '20[0-9]{2}-[01][0-9]-[0-3][0-9]';
const pick = (re) => (v) => ((v.match(re) || [v])[0]).toLowerCase();
const FORMS = {
  // sin distinguir caja sólo en la «S»: con la marca `i`, «un producto del equipo tuvo una story que…» sería un hallazgo
  'product-story': { re: new RegExp(`\\b${STORY}${STORY_ID}${SAME_SENTENCE}${TEAM_OWNER}|${TEAM_OWNER}${SAME_SENTENCE}\\b${STORY}${STORY_ID}`, 'g'), key: pick(/[0-9]+(?:\.[0-9]+)*|[A-Z]{1,3}-[0-9]+/) },
  // la misma expresión que usa scripts/tests/internal-history.test.js (la toma de acá): las dos redes ven lo mismo
  'pr-number': { re: /\b(?:PR|PRs|[Pp]ull [Rr]equests?)(?: de prueba)? [#!]?[0-9]{3,5}/g, key: pick(/[0-9]{3,5}/), zones: ['prose', 'code', 'message'] },
  // acotada a propósito: con `[^)]*` un renglón con muchos «](…incident-log» sin cerrar colgaba el control
  'incident-log': { re: /incident-log(?:\.md)?#[\w.-]+|\]\([\w./-]{0,160}incident-log(?:\.md)?(?:#[\w.-]{0,160})?\)/g, key: (v) => (v.includes('#') ? v.slice(v.indexOf('#')).replace(/\)$/, '') : 'link').toLowerCase() },
  // sin `docs/`: una rama `docs/8.25-…` no se distingue de una ruta `docs/v2/…` (límite conocido)
  'work-branch': { re: /(?<![\w./-])(?:story|fix|feat|feature|chore|hotfix|bugfix)\/[0-9a-z][\w.-]*[0-9][\w.-]*/g, key: (v) => v.toLowerCase() },
  // «corrida 2026-05-23» es una fecha, no una corrida: el número no puede seguir con un guion
  'azure-run': { re: /(?<![\w&/#])#[0-9]{5}\b|\b(?:corridas?|builds?) #?[0-9]{4,6}\b(?!-)/gi, key: pick(/[0-9]{4,6}/) },
  // sólo con la palabra adelante: un identificador hexadecimal suelto entre comillas invertidas no es un commit
  'private-commit': { re: /\b(?:[Cc]ommits?|[Mm]erge|sha|SHA|[Hh]ash) `?(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}`?(?![0-9A-Za-z])/g, key: pick(/[0-9a-f]{7,40}(?=`?$)/) },
  'debt-id': { re: /\bDEF-[0-9][\w.]*-[\w-]+/g, key: (v) => v.toLowerCase() },
  'owner-decision': { re: new RegExp(`\\(\\s*${OWNER}|${OWNER}[^.\\n]{0,40}?${DATE}|${DATE}[^.\\n]{0,40}?${OWNER}`, 'gi'), key: (v) => (/dueño/i.test(v) ? 'dueño' : 'dev') },
  'case-label': { re: /(?<![\p{L}\p{N}_])casos? disparador(?:es)?(?![\p{L}\p{N}_])|\[caso\]\(|\(caso: /giu, key: (v) => (/disparador/i.test(v) ? 'caso disparador' : v.toLowerCase()) },
  'batch-code': { re: /\b[Tt]andas? [A-Z][0-9]?[a-z]?\b(?![a-záéíóúñ])/g, key: (v) => v.slice(v.indexOf(' ') + 1) },
  'story-number': { re: new RegExp(`\\b${STORY}[0-9]+\\.[0-9]+(?:\\.[0-9]+)?[a-z]?\\b|(?<![\\p{L}\\p{N}_])[ÉéEe]picas? [0-9]+\\b`, 'gu'), key: (v) => (/pica/i.test(v) ? `épica ${v.match(/[0-9]+/)[0]}` : v.match(/[0-9]+\.[0-9]+(?:\.[0-9]+)?[a-z]?/)[0]) },
  'story-bare': { re: /(?<![\p{L}\p{N}_])[Ll]as? [0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?\b(?!\s*(?:%|x\b|veces|ms\b|s\b|[GMK]B\b))/gu, key: pick(/[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?/) },
  // necesita el árbol (qué existe y qué se publica): la busca `teamPaths`, no `scan`
  'team-path': { re: null, key: (v) => v },
};
const formsOf = (zone) => Object.entries(FORMS).filter(([, f]) => f.re && (f.zones || ['prose']).includes(zone));
const keyOf = (f) => `${f.form}\0${FORMS[f.form].key(f.value)}`;

/** La zona de una ruta (como sale): `prose` o `code`. Con cualquier separador. */
function zoneOf(rel) {
  const p = String(rel).split('\\').join('/');
  if (!/\.md$/i.test(p)) return 'code';
  const slash = p.indexOf('/');
  return slash === -1 || PROSE_ROOTS.has(p.slice(0, slash)) ? 'prose' : 'code';
}

/**
 * Los renglones LÓGICOS de un texto: un párrafo cortado a lo ancho es un solo renglón (Markdown muestra el corte como un
 * espacio), y una forma partida por el corte se tiene que ver. Dentro de un cerco, un título o una fila de tabla, cada
 * renglón va solo. `map` dice a qué línea y columna del texto corresponde cada tramo del renglón lógico.
 */
const STARTS_BLOCK = /^\s*(?:#{1,6}\s|\||[-*+]\s|[0-9]+[.)]\s)/;
function logicalLines(text) {
  const out = [];
  let cur = null;
  let fence = false;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const single = () => out.push({ text: raw, map: [[0, i + 1, 0]] });
    if (/^\s*(?:```|~~~)/.test(raw)) { flush(); single(); fence = !fence; return; }
    if (fence) { single(); return; }
    if (!raw.trim()) { flush(); return; }
    const quote = /^\s*>/.test(raw);
    const alone = /^\s*(?:#{1,6}\s|\|)/.test(raw);
    if (cur && !cur.alone && !STARTS_BLOCK.test(quote ? raw.replace(/^\s*>\s?/, '') : raw) && cur.quote === quote) {
      const lead = (quote ? raw.match(/^\s*>\s?/) : raw.match(/^\s*/))[0].length;
      cur.map.push([cur.text.length + 1, i + 1, lead]);
      cur.text += ` ${raw.slice(lead)}`;
      return;
    }
    flush();
    cur = { text: raw, map: [[0, i + 1, 0]], quote, alone };
  });
  flush();
  return out;
}
function positionOf(logical, index) {
  let at = logical.map[0];
  for (const m of logical.map) { if (m[0] <= index) at = m; else break; }
  return { line: at[1], col: at[2] + (index - at[0]) };
}

/** Todas las apariciones de las formas de una zona, con la que queda tapada por otra de más arriba marcada `covered`. */
function scanAll(text, zone) {
  if (typeof text !== 'string') throw new TypeError('scan: el texto tiene que ser un string (no poder mirar no es «sin hallazgos»)');
  if (!ZONES.includes(zone)) throw new TypeError(`scan: zona desconocida «${zone}» (son ${ZONES.join(', ')})`);
  const forms = formsOf(zone);
  const out = [];
  logicalLines(text).forEach((logical, lid) => {
    const taken = [];
    for (const [form, f] of forms) {
      f.re.lastIndex = 0;
      for (const m of logical.text.matchAll(f.re)) {
        const from = m.index;
        const to = m.index + m[0].length;
        const covered = taken.some(([a, b]) => from < b && a < to);
        if (!covered) taken.push([from, to]);
        out.push({ form, value: m[0], ...positionOf(logical, from), lid, from, to, covered });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * Las formas de historia interna de un texto. Pura: sin disco, sin git, sin configuración.
 * @param {string} text
 * @param {'prose'|'code'|'message'} zone `prose`: todas las formas de texto; `code` y `message` (el nombre de una rama, un
 *   mensaje de commit, el título y el cuerpo de un pedido): hoy, sólo `pr-number`.
 * @returns {{form: string, value: string, line: number, col: number}[]} `line` desde 1, `col` desde 0
 */
function scan(text, zone) {
  return scanAll(text, zone).filter((f) => !f.covered).map(({ form, value, line, col }) => ({ form, value, line, col }));
}

/**
 * Las rutas del equipo que nombra la prosa de un `.md`: una ruta entre comillas invertidas, fuera de los cercos, que
 * tendría que existir y no se publica.
 *   · En el repo del equipo (`env.team`): lo que el exportador marcaría — existe en el repo del equipo y no en la copia,
 *     desde la raíz o desde la carpeta del archivo, y no es una convención del repo del lector.
 *   · En el repo público (sin `env.team`) no hay repo del equipo contra el cual mirar: una ruta bajo una de las carpetas
 *     que el control declara como no públicas (`env.roots`), o la carpeta misma escrita con su barra, que no existe.
 *     Límite conocido: ahí no se ven `tasks/…` ni `specs/…` (no se distinguen de las del repo del lector) ni un archivo
 *     privado dentro de una carpeta pública. La regla más ancha —«toda ruta bajo una carpeta del repo que no existe»—
 *     se midió sobre la copia: de cada cinco hallazgos uno era falso (rutas relativas a una skill, del repo del lector,
 *     ejemplos), y por eso no está.
 * @returns {{form: 'team-path', value: string, line: number, col: number}[]}
 */
function teamPaths(text, file, env) {
  const pc = require('./public-copy.js');
  const conventions = env.conventions || [];
  const dir = path.posix.dirname(String(file).split('\\').join('/'));
  const out = [];
  for (const s of pc.proseCodeSpans(text)) {
    const cp = pc.codePath(s.content, env.installPrefixes || []);
    if (!cp) continue;
    const p = cp.path;
    if (cp.anchor && /(^|\/)incident-log\.md$/.test(p)) continue;   // eso es `incident-log`
    const relative = !cp.rootOnly && dir !== '.' ? path.posix.normalize(`${dir}/${p}`) : null;
    if (env.has(p) || (relative && env.has(relative))) continue;
    let hit = null;
    if (env.team) {
      const ours = (x) => x && env.team(x) && !pc.isReaderConvention(x, conventions);
      hit = ours(relative) ? relative : ours(p) ? p : null;
    } else if (!pc.isReaderConvention(p, conventions)) {
      const roots = env.roots || [];
      const folderAlone = !p.includes('/') && /\/\s*$/.test(s.content.trim().split(/\s+/)[0] || '');
      if (roots.includes(p.includes('/') ? p.slice(0, p.indexOf('/')) : folderAlone ? p : '')) hit = p;
    }
    if (hit) out.push({ form: 'team-path', value: hit, line: s.line, col: 0, lid: -1, from: 0, to: 0, covered: false });
  }
  return out;
}

// ── el modo ───────────────────────────────────────────────────────────────────────────────────────────────────────
const RANK = { off: 0, warn: 1, block: 2 };
const SWITCH_VALUES = { block: 'block', warn: 'warn', 0: 'off', off: 'off' };
/** El modo efectivo del control: lo escrito, pisado por la variable. Lo que no se entiende es `block` (falla cerrado). */
function effectiveMode(config, env = process.env) {
  const written = ['warn', 'block'].includes(config && config.mode) ? config.mode : 'block';
  const raw = String((env && env[SWITCH]) || '').trim().toLowerCase();
  if (!raw) return { mode: written, lowered: false, odd: false };
  if (!Object.prototype.hasOwnProperty.call(SWITCH_VALUES, raw)) return { mode: 'block', lowered: false, odd: true };
  const mode = SWITCH_VALUES[raw];
  return { mode, lowered: RANK[mode] < RANK[written], odd: false };
}
/** El modo de una forma: `warn` sólo si lo dice con todas las letras; mal escrito o sin entrada, `block` (falla cerrado). */
const formModeOf = (config, form) => (config.forms && config.forms[form] && config.forms[form].mode === 'warn' ? 'warn' : 'block');

// ── git: el del hook (con el índice del commit en curso) ─────────────────────────────────────────────────────────
function git(cwd, args, { tolerate = false, buffer = false } = {}) {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new CouldNot(`no pude correr git ${args[0]} (${r.error.code || r.error.message})`);
  if (r.status !== 0 && !tolerate) throw new CouldNot(`git ${args[0]} falló en ${shown(cwd)}: ${shown(String(r.stderr).trim().split('\n')[0]) || `salió ${r.status}`}`);
  return r;
}
/** El commit de una referencia que escribió alguien: nunca se lee como una opción de git, aunque empiece con guion. */
function commitOf(repo, ref) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { tolerate: true });
  if (r.status !== 0) throw new CouldNot(`no encuentro el commit «${shown(ref)}» en ${shown(repo)}`);
  return r.stdout.trim();
}
/** Las entradas de un árbol (`ls-tree -r -z`) o del índice (`ls-files -s -z`), con la forma del exportador. */
function treeOf(repo, sha) {
  const index = sha === null;
  const out = git(repo, index ? ['ls-files', '-s', '-z'] : ['ls-tree', '-r', '-z', sha]).stdout;
  const entries = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const head = rec.slice(0, tab).split(' ');
    if (index && head[2] !== '0') throw new CouldNot(`el índice tiene conflictos sin resolver (${shown(rec.slice(tab + 1))})`);
    const [modo, a, b] = head;
    const obj = index ? a : b;
    entries.push({ modo, tipo: modo === '160000' ? 'commit' : 'blob', obj, ruta: rec.slice(tab + 1) });
  }
  return entries;
}
/** Cambios de `--name-status -z -M -C`: ruta → `{ status, oldPath }` (el origen de un renombre o de una copia). */
function parseChanges(out) {
  const t = out.split('\0');
  const changes = new Map();
  for (let i = 0; i < t.length && t[i];) {
    const status = t[i][0];
    if (status === 'R' || status === 'C') { changes.set(t[i + 2], { status, oldPath: t[i + 1] }); i += 3; } else { changes.set(t[i + 1], { status, oldPath: null }); i += 2; }
  }
  return changes;
}
// Renombres y copias sin tope (`-l0`): con el de git, o con el `diff.renameLimit` de cada máquina, un commit grande daría
// otro veredicto. `-C` mira como origen de una copia sólo lo que el commit modifica: mudar una guía dejando un talón en
// la ruta vieja no hace nuevo lo que la guía ya traía.
const DIFF_FLAGS = ['-M', '-C', '-l0', '-z', '--name-status'];
const withFolders = (paths) => {
  const set = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    for (let k = 1; k <= parts.length; k++) set.add(parts.slice(0, k).join('/'));
  }
  return set;
};
/** El error de V8 al leer un JSON trae un pedazo del texto: no se reenvía (la tabla de reemplazos es privada). */
function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw new CouldNot(`${what} no es JSON válido`); }
}
/** El texto de un archivo de prosa. Lo que no es UTF-8 (un `.md` guardado en UTF-16 o Latin-1) no se puede mirar. */
function utf8(buf, what) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new CouldNot(`${shown(what)} no es UTF-8 válido: no puedo buscar formas en él`); }
}
/** Las formas con que una guía nombra un archivo del arnés instalado. Sin el exportador a mano (un laboratorio), ninguna. */
function installPrefixes() {
  let mod;
  try { mod = require('./export.js'); } catch (e) {
    // sólo si el que falta es el exportador mismo: uno que está y no puede cargar algo suyo es «no pude mirar»
    // (con `[]` se reconocerían menos rutas, en silencio)
    if (e && e.code === 'MODULE_NOT_FOUND' && /['"]\.\/export\.js['"]/.test(String(e.message).split('\n')[0])) return [];
    throw e;
  }
  return mod.installPrefixes();
}

// ── qué se publica en una foto ───────────────────────────────────────────────────────────────────────────────────
/**
 * Lo que se publica de un árbol: `files` (ruta con que sale → `{ real, text() }`, `real` = el archivo del repo que hay que
 * editar; `text()` null = no es de este control) y lo que `teamPaths` necesita saber de esa foto.
 */
function publishedPublic(repo, tree, config) {
  const blobs = tree.filter((e) => e.tipo === 'blob');
  const byPath = new Map(blobs.map((e) => [e.ruta, e]));
  const read = (e) => utf8(git(repo, ['cat-file', 'blob', e.obj], { buffer: true }).stdout, e.ruta);
  const files = new Map(blobs.map((e) => [e.ruta, { real: e.ruta, text: () => read(e) }]));
  const all = withFolders(byPath.keys());
  let conventions = [];
  const list = byPath.get(LIST_PATH);
  if (list) conventions = (parseJson(read(list), LIST_PATH).readerConventions || []).map((c) => c.path);
  const pathsEnv = { has: (p) => all.has(p), team: null, roots: config.nonPublicRoots || [], conventions, installPrefixes: installPrefixes() };
  return { files, pathsEnv, raw: (real) => (byPath.has(real) ? read(byPath.get(real)) : null) };
}
function publishedTeam(repo, tree, name, { strict }) {
  const nn = require('./new-names.js');
  const pc = require('./public-copy.js');
  if (!nn.unifiedTree(tree)) {
    if (!strict) return null;
    throw new CouldNot(`${name}: no tiene la forma del repo unido (el arnés con las skills adentro) — no sé qué sale`);
  }
  const trees = nn.splitTree(tree);
  const dirs = { arnes: repo, 'agent-skills': repo };
  const read = nn.blobReader(dirs);
  let ctx;
  let sh;
  try {
    const snap = nn.snapshot(name, trees, { dirs, read, disk: false, harnessDisk: repo, allowMissing: !strict });
    if (snap.missingConfig) return null;
    const lista = nn.parseJson(snap.listText, `${LIST_PATH} (${name})`);
    const table = nn.parseJson(snap.tableText, `${TABLE_PATH} (${name})`);
    ctx = nn.contextFor(snap, { lista, table, strict });
    sh = nn.ships(snap, ctx);
  } catch (e) {
    // los «no pude mirar» del freno de nombres ya cuidan no imprimir lo privado; de cualquier otro error, sólo su clase
    // y de ésos, sólo el primer renglón: algunos traen detrás lo que git dijo, que puede nombrar rutas
    throw new CouldNot(e instanceof nn.CouldNotLook ? String(e.message).split('\n')[0] : `${name}: la clasificación de qué se publica falló (${e.name || 'Error'})`);
  }
  // de dónde sale cada papel: de la lista de la foto (lo que el exportador anota al colocarlos es por paquete)
  const from = new Map(((ctx.lista && ctx.lista.synthetic) || []).map((s) => [`arnes/${s.target}`, s.from]));
  // El texto de un archivo como sale: lo que de él lleva cada paquete MÁS lo que un paquete deja pendiente para la copia
  // que une los paquetes (las secciones del catálogo de los revisores de un paquete): eso también se publica. Cada pieza
  // sin sus bloques internos; una pieza repetida en dos paquetes cuenta una vez.
  const blobOf = new Map(tree.filter((e) => e.tipo === 'blob').map((e) => [e.ruta, e]));
  const textOf = (source, ruta, dest, real = ruta) => () => {
    // el archivo de donde sale el texto tiene que ser UTF-8 de verdad: en UTF-16 o Latin-1 ninguna forma coincide
    const blob = blobOf.get(real);
    if (blob) utf8(read(nn.sourceOfPath(real), blob.obj), real);
    const seen = new Set();
    const parts = [];
    for (const piece of sh.ofFile(source, ruta)) {
      if (piece.kind === 'translation') continue;
      if (piece.text === null) throw new CouldNot(`${shown(ruta)} no se deja leer como texto: no puedo buscar formas en él`);
      const r = pc.internalBlocks(piece.text, dest);   // con marcadores rotos, entero (el exportador ahí frena)
      const text = r.errors.length ? piece.text : r.text;
      if (!seen.has(text)) { seen.add(text); parts.push(text); }
    }
    return parts.length ? parts.join('\n') : null;
  };
  const files = new Map();
  const copyPaths = [];
  const realsShipped = new Set();
  for (const p of sh.packages) {
    for (const [clave, a] of p.files) {
      if (a.kind === 'synthetic-source') continue;
      const dest = clave.slice(clave.indexOf('/') + 1);
      copyPaths.push(dest);   // también una traducción: se regenera, pero está en la copia
      if (a.kind === 'translation' || files.has(dest)) continue;
      const real = a.kind === 'synthetic' ? from.get(clave) || a.ruta : a.ruta;
      realsShipped.add(real);
      files.set(dest, { real, text: zoneOf(dest) === 'prose' ? textOf(a.fuente, a.ruta, dest, real) : () => null });
    }
  }
  // un `.md` de prosa que no está en ningún paquete suelto pero del que algún paquete deja algo pendiente
  for (const source of nn.SOURCES) {
    for (const e of trees[source]) {
      if (e.tipo !== 'blob' || zoneOf(e.ruta) !== 'prose' || realsShipped.has(e.ruta) || files.has(e.ruta)) continue;
      if (sh.ofFile(source, e.ruta).some((piece) => piece.kind !== 'translation')) files.set(e.ruta, { real: e.ruta, text: textOf(source, e.ruta, e.ruta) });
    }
  }
  const team = withFolders(blobOf.keys());
  const copy = withFolders(copyPaths);
  const pathsEnv = { has: (p) => copy.has(p), team: (p) => team.has(p), conventions: ((ctx.lista && ctx.lista.readerConventions) || []).map((c) => c.path), installPrefixes: installPrefixes() };
  return { files, pathsEnv, raw: (real) => (blobOf.has(real) ? read(nn.sourceOfPath(real), blobOf.get(real).obj).toString('utf8') : null) };
}

// ── los datos declarados ─────────────────────────────────────────────────────────────────────────────────────────
function loadAllowed(text) {
  if (text === null) return [];
  const data = parseJson(text, ALLOWED_PATH);
  if (!data || !Array.isArray(data.allowed)) throw new CouldNot(`${ALLOWED_PATH} no trae la lista «allowed»`);
  // `form` es una de las formas del control, o falta (una entrada de antes: es `pr-number`): cualquier otra cosa no se
  // adivina, y no llega a un mensaje
  const bad = data.allowed.findIndex((e) => e && e.form !== undefined && !Object.prototype.hasOwnProperty.call(FORMS, e.form));
  if (bad !== -1) throw new CouldNot(`${ALLOWED_PATH}: la entrada ${bad + 1} trae un «form» que no es una forma del control`);
  return data.allowed.filter((e) => e && typeof e.file === 'string' && typeof e.value === 'string');
}
// por la ruta con que sale (la que vale en los dos repos) o por la del archivo que se edita (en el del equipo, un papel)
const declares = (e, f, file) => (e.file === file.dest || e.file === file.real) && (e.form || 'pr-number') === f.form && e.value === f.value;

/** Las formas de un archivo de prosa que se publica: todas (`all`) y sin los datos declarados (`kept`). */
function findingsOf(pub, dest, allowed) {
  const file = pub.files.get(dest);
  const text = file.text();
  if (text === null || text === undefined) throw new CouldNot(`${shown(file.real)} se publica como prosa y no tiene texto que mirar`);
  const lines = text.split(/\r?\n/);
  // `ptext`: el renglón donde empieza cada una (para decir después cuál es la nueva: la de un renglón que no estaba)
  const all = [...scanAll(text, 'prose'), ...teamPaths(text, dest, pub.pathsEnv)].map((f) => ({ ...f, ptext: lines[f.line - 1] }));
  const kept = all.filter((f) => !allowed.some((e) => declares(e, f, { real: file.real, dest })));
  return { kept, all, text };
}
function countByKey(findings) {
  const m = new Map();
  for (const f of findings) m.set(keyOf(f), (m.get(keyOf(f)) || 0) + 1);
  return m;
}

// ── la corrida ───────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: 'staged', repo: null, range: null, json: false, ref: 'HEAD', config: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CouldNot(`${x} pide un valor`);
      return v;
    };
    if (x === '--repo') a.repo = value();
    else if (x === '--range') { a.range = value(); a.mode = 'range'; }
    else if (x === '--all') a.mode = 'all';
    else if (x === '--json') a.json = true;
    else if (x === '--ref') a.ref = value();
    else if (x === '--config') a.config = value();
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new CouldNot(`no entiendo «${shown(x)}» (uso: [--repo <dir>] [--config <archivo>] [--range <base>...<punta>] | --all [--json] [--ref <commit>])`);
  }
  return a;
}
/**
 * La configuración que ENTRA en el commit, si el control corre desde el mismo repo que se commitea: la del índice, como
 * la lista de datos declarados. Una edición sin stagear de `mode` no baja el control callada (bajarlo se hace con la
 * variable, que lo dice). `null` = no aplica (otro árbol, o el repo no la versiona): vale la del disco.
 */
function stagedConfig(args) {
  const start = args.repo ? path.resolve(args.repo) : process.cwd();
  const top = git(start, ['rev-parse', '--show-toplevel'], { tolerate: true });
  if (top.status !== 0) return null;   // no es un repo: lo dice después quien mira
  let repo; let own;
  // no saber si es el mismo repo no es «leo la del disco»: es no poder mirar
  try { repo = fs.realpathSync(top.stdout.trim()); own = fs.realpathSync(path.join(__dirname, '..', '..')); } catch (e) {
    throw new CouldNot(`no pude ubicar la configuración que entra en el commit (${e.code || 'error'})`);
  }
  if (own !== repo) return null;
  const staged = git(repo, ['show', `:${CONFIG_PATH}`], { tolerate: true });
  if (staged.status === 0) return staged.stdout;
  // No está en el índice. Si el repo la versiona (está en HEAD), este commit la saca: vale la que está commiteada, no
  // la copia que quedó en el disco. Si el repo no la versiona, la del disco (`null`).
  const head = git(repo, ['show', `HEAD:${CONFIG_PATH}`], { tolerate: true });
  return head.status === 0 ? head.stdout : null;
}
function loadConfig(args) {
  const file = args.config ? path.resolve(args.config) : path.join(__dirname, 'internal-history.json');
  let text = !args.config && args.mode === 'staged' ? stagedConfig(args) : null;
  if (text === null) {
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new CouldNot(`no está la configuración del control (${shown(file)}: ${e.code || 'no se pudo leer'})`); }
  }
  const config = parseJson(text, CONFIG_PATH);
  if (!config || typeof config !== 'object' || !config.forms || typeof config.forms !== 'object') throw new CouldNot(`${CONFIG_PATH} no trae «forms»`);
  return config;
}
/** ¿Es el repo del equipo o el público? Dos señales, como el freno de nombres: el perfil y la tabla privada. */
function teamOrPublic(repo) {
  const profile = PROFILES.find((n) => fs.existsSync(path.join(repo, n)));
  if (!profile) return 'public';
  if (!fs.existsSync(path.join(repo, TABLE_PATH))) throw new CouldNot(`este clon trae ${profile} (es del equipo) y le falta ${TABLE_PATH}: sin la tabla no sé qué sale, y un clon del equipo incompleto no es el repo público`);
  return 'team';
}
const published = (kind, repo, tree, name, config, strict) => (kind === 'team' ? publishedTeam(repo, tree, name, { strict }) : publishedPublic(repo, tree, config));

/** Qué cambia: los padres (`{ sha, changes }`) y el árbol del después. `null` = un rango sin commits. */
function whatChanges(repo, args) {
  if (args.mode === 'range') {
    const m = /^(.+?)(\.{2,3})(.+)$/.exec(args.range);
    if (!m) throw new CouldNot(`--range ${shown(args.range)}: tiene que ser <base>...<punta> o <base>..<punta>`);
    const tip = commitOf(repo, m[3]);
    const base = m[2] === '...' ? git(repo, ['merge-base', commitOf(repo, m[1]), tip]).stdout.trim() : commitOf(repo, m[1]);
    if (!Number(git(repo, ['rev-list', '--count', `${base}..${tip}`]).stdout.trim())) return null;
    return { parents: [{ sha: base, changes: parseChanges(git(repo, ['diff', ...DIFF_FLAGS, base, tip]).stdout) }], after: () => treeOf(repo, tip) };
  }
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { tolerate: true });
  const shas = head.status === 0 ? [head.stdout.trim()] : [null];
  const mergeHead = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).stdout.trim());
  if (shas[0] && fs.existsSync(mergeHead)) shas.push(...fs.readFileSync(mergeHead, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));
  return {
    parents: shas.map((sha) => ({ sha, changes: parseChanges(git(repo, ['diff-index', '--cached', ...DIFF_FLAGS, sha || EMPTY_TREE]).stdout) })),
    after: () => treeOf(repo, null),
  };
}
// Lo que, tocado, cambia QUÉ se publica o qué cuenta como una ruta del equipo sin tocar un `.md`: la lista blanca, la
// tabla, el manifiesto de un paquete (qué revisores son suyos), el exportador y sus piezas, y la configuración del control.
const RECLASSIFIES = [LIST_PATH, TABLE_PATH, CONFIG_PATH, 'scripts/publishing/export.js', 'scripts/publishing/public-copy.js', 'scripts/publishing/new-names.js'];
const reclassifies = (p) => !!p && (RECLASSIFIES.includes(p) || /^packs\/[^/]+\/pack\.json$/.test(p));
const mayMatter = (p) => !!p && (/\.md$/i.test(p) || reclassifies(p));

function runAll(repo, args) {
  const config = loadConfig(args);
  const kind = teamOrPublic(repo);
  const tree = treeOf(repo, commitOf(repo, args.ref));
  const pub = published(kind, repo, tree, shown(args.ref), config, true);
  const allowedEntry = tree.find((e) => e.ruta === ALLOWED_PATH && e.tipo === 'blob');
  const allowed = loadAllowed(allowedEntry ? git(repo, ['cat-file', 'blob', allowedEntry.obj]).stdout : null);
  const forms = {};
  const files = {};
  const seen = new Set();
  const list = [];   // sólo para quien llama a `run` desde un guion (la muestra de falsos positivos): la línea de comandos nunca imprime el texto
  const paths = [];   // cada archivo de prosa mirado, también los que miden cero: quien cuenta otra cosa sobre lo mismo (la medición de la tanda G) parte de acá
  let total = 0;
  let looked = 0;
  for (const dest of [...pub.files.keys()].sort()) {
    if (zoneOf(dest) !== 'prose') continue;
    const r = findingsOf(pub, dest, allowed);
    looked++;
    const real = pub.files.get(dest).real;
    paths.push(real);
    for (const f of r.all) for (const e of allowed) if (declares(e, f, { real, dest })) seen.add(e);
    for (const f of r.kept) {
      if (f.covered) continue;   // el pedazo que otra forma ya cuenta
      forms[f.form] = (forms[f.form] || 0) + 1;
      (files[real] || (files[real] = {}))[f.form] = (files[real][f.form] || 0) + 1;
      total++;
      if (args.detail) list.push({ file: real, line: f.line, form: f.form, value: f.value, text: r.text.split(/\r?\n/)[f.line - 1] });
    }
  }
  // las `pr-number` las cuida la prueba de antes (también fuera de la prosa); acá, las de las demás formas
  // Una ruta del equipo declarada sólo puede «sobrar» en el repo donde el control la puede ver: la misma lista viaja a
  // los dos, y cada modo ve rutas distintas (el público, sólo bajo una carpeta no pública; el del equipo, sólo lo que
  // el equipo tiene versionado). Lo que acá no se puede ver la juzga el otro: el público, lo que está bajo una carpeta
  // no pública; el del equipo, todo lo demás. Así ninguna queda sin juez: una ruta que el equipo ya no tiene y que
  // tampoco está bajo una carpeta no pública no la ve nadie, y sobra acá.
  const env = pub.pathsEnv;
  const underRoot = (value) => (config.nonPublicRoots || []).includes(String(value).split('/')[0]);
  const visibleHere = (e) => e.form !== 'team-path' || (env.team ? !!env.team(e.value) || !underRoot(e.value) : underRoot(e.value));
  const stale = allowed.filter((e) => e.form && e.form !== 'pr-number' && !seen.has(e) && visibleHere(e)).map((e) => ({ file: e.file, form: e.form }));
  return { outcome: 'counted', mode: kind, total, looked, paths, forms, files, stale, ...(args.detail ? { list } : {}) };
}

function run(args) {
  const start = args.repo ? path.resolve(args.repo) : process.cwd();
  if (!fs.existsSync(start)) throw new CouldNot(`--repo ${shown(start)} no existe`);
  const repo = fs.realpathSync(git(start, ['rev-parse', '--show-toplevel']).stdout.trim());
  if (args.mode === 'all') return runAll(repo, args);

  const what = whatChanges(repo, args);
  if (!what) return { outcome: 'not-measured' };
  // un borrado sólo importa si es de lo que decide qué se publica (un `.md` que se va no agrega nada)
  const touched = what.parents.flatMap((p) => [...p.changes].flatMap(([p2, c]) => (c.status === 'D' ? (reclassifies(p2) ? [p2] : []) : [p2, c.oldPath])));
  if (!touched.some(mayMatter)) return { outcome: 'quiet' };
  const reclassified = touched.some(reclassifies);

  const config = loadConfig(args);
  const kind = teamOrPublic(repo);
  const afterTree = what.after();
  const after = published(kind, repo, afterTree, 'el después', config, true);
  const snapshotOf = (sha) => {
    if (!sha) return null;
    const pub = published(kind, repo, treeOf(repo, sha), `el antes (${sha.slice(0, 12)})`, config, false);
    return pub ? { pub, byReal: new Map([...pub.files].map(([dest, f]) => [f.real, dest])) } : null;
  };
  const befores = what.parents.map((p) => snapshotOf(p.sha));
  // en un merge, lo que cada rama agregó sobre el ancestro común se suma: juntar dos ramas no es agregar
  let common = null;
  if (what.parents.length > 1) {
    const mb = git(repo, ['merge-base', '--octopus', ...what.parents.map((p) => p.sha)], { tolerate: true });
    if (mb.status === 0 && mb.stdout.trim()) common = snapshotOf(mb.stdout.trim());
  }
  const allowedEntry = afterTree.find((e) => e.ruta === ALLOWED_PATH && e.tipo === 'blob');
  const allowed = loadAllowed(allowedEntry ? git(repo, ['cat-file', 'blob', allowedEntry.obj]).stdout : null);

  const findings = [];
  let looked = 0;
  for (const [dest, file] of after.files) {
    if (zoneOf(dest) !== 'prose') continue;
    // el antes de este archivo en una foto: el origen de un renombre o de una copia; si no, el MISMO archivo (aunque
    // saliera con otra ruta); si no, lo que salía con esta ruta. Sólo si era prosa.
    const beforeIn = (b, change) => {
      if (!b) return null;
      const prose = (d) => (d && zoneOf(d) === 'prose' ? d : null);
      if (change && change.oldPath) return prose(b.byReal.get(change.oldPath));
      if (change && change.status === 'A') return null;
      return prose(b.byReal.get(file.real)) || (b.pub.files.has(dest) ? prose(dest) : null);
    };
    const beforeDest = what.parents.map((p, i) => beforeIn(befores[i], p.changes.get(file.real)));
    // igual a algún padre: el mismo archivo, con la misma ruta, sin tocar, y sin que el commit cambie qué se publica
    // (una ruta ya escrita pasa a ser del equipo si lo que nombra deja de salir): nada nuevo, y no se lee
    if (!reclassified && what.parents.some((p, i) => beforeDest[i] === dest && befores[i].pub.files.get(dest).real === file.real && !p.changes.has(file.real))) continue;
    const now = findingsOf(after, dest, allowed);
    looked++;
    if (!now.kept.length) continue;
    const beforeOf = (b, d) => (d ? findingsOf(b.pub, d, allowed).kept : []);
    const before = beforeDest.map((d, i) => beforeOf(befores[i], d));
    const counts = before.map(countByKey);
    const base = common ? countByKey(beforeOf(common, beforeIn(common, null))) : null;
    const allowance = (k) => {
      const top = counts.reduce((m, c) => Math.max(m, c.get(k) || 0), 0);
      if (!base) return top;
      const b = base.get(k) || 0;
      return Math.max(top, b + counts.reduce((s, c) => s + Math.max(0, (c.get(k) || 0) - b), 0));
    };
    // cuáles son las nuevas: de cada clave sobran (después − lo que ya había); se señalan primero las que están en un
    // renglón que antes no traía esa forma, y sólo si no alcanza, las últimas
    const richest = before.reduce((best, b) => (b.length > best.length ? b : best), []);
    const oldLines = new Map();
    for (const f of richest) { const k = `${keyOf(f)}\0${f.ptext}`; oldLines.set(k, (oldLines.get(k) || 0) + 1); }
    const byKey = new Map();
    for (const f of now.kept) { if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), []); byKey.get(keyOf(f)).push(f); }
    const fresh = [];
    for (const [k, list] of byKey) {
      const extra = list.length - allowance(k);
      if (extra <= 0) continue;
      // las que están en un renglón que ya traía esa forma se descuentan; de ésas nunca hay más que las que ya había,
      // así que las que quedan (`moved`) alcanzan siempre para las que sobran
      const moved = [];
      for (const f of list) {
        const lk = `${k}\0${f.ptext}`;
        if (oldLines.get(lk)) oldLines.set(lk, oldLines.get(lk) - 1); else moved.push(f);
      }
      fresh.push(...moved.slice(0, extra));
    }
    // el pedazo que otra forma nueva ya informa no se repite (la story de un producto no es además un número de story)
    const said = fresh.filter((f) => !(f.covered && fresh.some((g) => g !== f && !g.covered && g.lid === f.lid && f.from < g.to && g.from < f.to)));
    if (!said.length) continue;
    // la línea del archivo real (el texto que sale puede no traer un bloque interno): cada renglón se busca una vez
    const raw = kind === 'team' ? after.raw(file.real) : null;
    const rawLines = raw === null ? null : raw.split(/\r?\n/);
    const shipped = now.text.split(/\r?\n/);
    const placed = new Map();
    const taken = new Set();
    const realLine = (n) => {
      if (!rawLines) return { line: n, approximate: false };
      if (!placed.has(n)) {
        // el renglón igual más cercano a su posición (con dos renglones iguales, el suyo y no el primero del archivo)
        let at = -1;
        rawLines.forEach((l, i) => { if (l === shipped[n - 1] && !taken.has(i) && (at === -1 || Math.abs(i - (n - 1)) < Math.abs(at - (n - 1)))) at = i; });
        if (at !== -1) taken.add(at);
        placed.set(n, at);
      }
      return placed.get(n) === -1 ? { line: n, approximate: true } : { line: placed.get(n) + 1, approximate: false };
    };
    for (const f of said.sort((a, b) => a.line - b.line || a.col - b.col)) {
      findings.push({ file: file.real, dest, ...realLine(f.line), form: f.form, formMode: formModeOf(config, f.form) });
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { outcome: findings.length ? 'findings' : 'clean', findings, looked, kind };
}

// ── el mensaje, la constancia y la salida ────────────────────────────────────────────────────────────────────────
function report(findings, blocks) {
  const l = [blocks
    ? `🛑 historia interna en la prosa que se publica — el commit no se crea (${findings.length} hallazgo(s)):`
    : `⚠️  historia interna en la prosa que se publica — avisa, no frena (${findings.length} hallazgo(s)):`, ''];
  for (const f of findings) {
    l.push(`  ${shown(f.file)}:${f.line}${f.approximate ? ' (línea aproximada)' : ''}  ${f.form}${f.formMode === 'warn' ? '  (esta forma sólo avisa)' : ''}${f.dest !== f.file ? `  (sale como ${shown(f.dest)})` : ''}`);
  }
  l.push('', 'Cómo salir:',
    '  (a) Reescribir sin la forma: la guía pública cuenta la regla y su porqué, de modo que se entienda sin el caso. El',
    '      caso (qué producto, qué story, qué pasó) va al registro de incidentes, que no se publica; la guía no lo enlaza.',
    '  (b) Si es un marcador o un ejemplo genérico: escribilo como marcador (`story <N.M>`, `specs/<story>.md`).',
    `  (c) Si es un dato o un ejemplo que tiene que quedar tal cual: declararlo en ${ALLOWED_PATH}`,
    '      con su archivo (la ruta con que sale), su forma, el valor exacto y el motivo (nunca un archivo entero).',
    '', 'Guía: guides/publicacion-espejo.md §«La historia interna».');
  return l.join('\n');
}
// la carpeta del estado la sabe scripts/setup/harness/tycon-home.js, que viaja; sin él (un laboratorio con guiones
// sueltos) no hay dónde anotar, y `record` lo deja pasar: medir nunca rompe el commit
const stateDir = () => require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(os.homedir());
/** La decisión de un commit, en los códigos del registro de frenos; `null` si no hubo nada que decidir. */
function decisionOf({ mode, findings = [], cannotLook = false, lowered = false, blocked = false, looked = 0 }) {
  if (mode === 'off') return { rule: 'disabled', verdict: 'escape' };
  if (cannotLook) return { rule: 'could-not-look', verdict: blocked ? 'bloqueo' : lowered ? 'escape' : 'aviso' };
  if (findings.length) {
    // se escapó sólo lo que habría frenado: una forma que sólo avisa no frena ni con la variable ni sin ella
    const wouldBlock = findings.some((f) => f.formMode === 'block');
    return { rule: 'finding', verdict: blocked ? 'bloqueo' : lowered && wouldBlock ? 'escape' : 'aviso' };
  }
  return looked > 0 ? { rule: 'clean', verdict: 'paso' } : null;
}
function record(args, state) {
  const { mode, findings = [], cannotLook = false, lowered = false, blocked = false, looked = 0 } = state;
  if (args.mode !== 'staged') return;   // sólo el commit de una máquina: el pedido de cambio y la cuenta no lo son
  // el registro de frenos: una línea por commit que tocó prosa que se publica, también cuando pasó (es el denominador)
  const decision = decisionOf(state);
  if (decision) {
    try {
      const print = JSON.stringify(findings.map((f) => [f.form, f.file || '', f.line || 0]));
      require(path.join(__dirname, '..', 'lib', 'guard-record.js')).anotar({ freno: 'internal-history', regla: decision.rule, veredicto: decision.verdict, cmd: findings.length ? print : '' });
    } catch { /* la constancia es ayuda, no evidencia: nunca rompe el commit */ }
  }
  if (!findings.length && !cannotLook && !lowered) return;
  const forms = {};
  for (const f of findings) forms[f.form] = (forms[f.form] || 0) + 1;
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'internal-history.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), mode, files: looked, forms, cannot_look: cannotLook, lowered, blocked })}\n`);
  } catch { /* medir nunca rompe el commit */ }
}
const HELP = [
  'internal-history.js — el control de historia interna en la prosa que se publica',
  '  node scripts/publishing/internal-history.js [--repo <dir>] [--config <archivo>]   lo stageado (el pre-commit)',
  '  node scripts/publishing/internal-history.js --range <base>...<punta>              el diff de un pedido de cambio',
  '  node scripts/publishing/internal-history.js --all [--json] [--ref <commit>]       la cuenta de todo lo que se publica',
  `  ${SWITCH}=block|warn|0 pisa el modo escrito en ${CONFIG_PATH}`,
].join('\n');
/** Un mensaje para imprimir: en UN renglón (un salto de línea adentro podría leerse como un comando del registro) y acotado. */
const oneLine = (s) => String(s).replace(new RegExp(`[${UNPRINTABLE}]+`, 'g'), ' ').trim().slice(0, 600);
/**
 * Por qué no se pudo mirar, para imprimir: lo que el control escribió, o —de un error que no esperaba— sólo su clase y
 * dónde fue. Nunca el mensaje de un error ajeno: puede traer un pedazo de un archivo.
 */
function reasonOf(e) {
  if (e instanceof CouldNot) return oneLine(e.message);
  const frame = String((e && e.stack) || '').split('\n').map((l) => l.trim()).find((l) => /^at /.test(l));
  return `error del propio control (${oneLine((e && e.name) || 'Error')}${frame ? `, ${oneLine(frame)}` : ''})`;
}

/** @returns {number} el código de salida */
function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    // mal llamado no se sabe qué había que mirar: es 2 en cualquier modo, con su línea de cuentas
    say(`⛔ historia interna: ${reasonOf(e)}`);
    process.stdout.write('internal-history: findings=0 cannot_look=1 mode=block\n');
    return 2;
  }
  if (args.help) { process.stdout.write(`${HELP}\n`); return 0; }

  if (args.mode === 'all') {
    try {
      const r = run(args);
      if (args.json) process.stdout.write(`${JSON.stringify({ mode: r.mode, total: r.total, looked: r.looked, forms: r.forms, files: r.files, stale: r.stale }, null, 2)}\n`);
      else {
        const l = [`historia interna en la prosa que se publica (${r.mode === 'team' ? 'repo del equipo: lo que sale' : 'repo público: todo lo versionado'}): ${r.total} en ${Object.keys(r.files).length} de ${r.looked} archivos`, ''];
        for (const [form, n] of Object.entries(r.forms).sort((a, b) => b[1] - a[1])) l.push(`  ${form.padEnd(16)} ${n}`);
        if (r.stale.length) l.push('', `declaraciones que ya no aparecen donde dicen (${ALLOWED_PATH}): ${r.stale.map((s) => `${shown(s.file)} [${shown(s.form)}]`).join(', ')}`);
        process.stdout.write(`${l.join('\n')}\n`);
      }
      return 0;
    } catch (e) {
      say(`⛔ historia interna: no pude mirar — ${reasonOf(e)}`);
      return 2;
    }
  }

  // el modo: sin configuración legible manda la variable sola, y sin variable, `block` (lo que no se entiende frena)
  let config = null;
  try { config = loadConfig(args); } catch { /* si hay algo que mirar, se dice abajo */ }
  const m = effectiveMode(config, process.env);
  const summary = (n, cannot, extra) => process.stdout.write(`internal-history: findings=${n} cannot_look=${cannot} mode=${m.mode}${extra ? ` ${extra}` : ''}\n`);
  if (m.odd) say(`⚠️  historia interna: no entiendo ${SWITCH}=«${shown(String(process.env[SWITCH]).slice(0, 40))}» (es block, warn o 0): frena, falla cerrado`);
  if (m.mode === 'off') {
    say(`⚠️  historia interna: control APAGADO por ${SWITCH}=${shown(process.env[SWITCH])} — este cambio no se mira`);
    summary(0, 0);
    record(args, { mode: 'off', lowered: true });
    return 0;
  }
  if (m.lowered) say(`⚠️  historia interna: ${config ? `el control frena (${CONFIG_PATH})` : 'no pude leer el modo escrito del control'} y ${SWITCH}=${shown(process.env[SWITCH])} lo deja en aviso en esta corrida`);

  let r;
  try {
    r = run(args);
  } catch (e) {
    say(`⛔ historia interna: no pude mirar — ${reasonOf(e)}${m.mode === 'block' ? '\n   «No pude mirar» no es verde: el commit no se crea.' : '\n   El control está en modo aviso: sigue, pero ESTE cambio no se miró.'}`);
    summary(0, 1);
    record(args, { mode: m.mode, cannotLook: true, lowered: m.lowered, blocked: m.mode === 'block' });
    return m.mode === 'block' ? 2 : 0;
  }
  if (r.outcome === 'not-measured') { say('historia interna: no medido: el rango no trae commits — nada que comparar'); summary(0, 0, 'measured=0'); return 0; }
  if (r.outcome === 'quiet') { summary(0, 0, 'looked=0'); record(args, { mode: m.mode, lowered: m.lowered }); return 0; }

  const blocking = r.findings.filter((f) => f.formMode === 'block');
  const warnings = r.findings.length - blocking.length;
  const blocks = m.mode === 'block' && blocking.length > 0;
  if (r.findings.length) say(report(r.findings, blocks));
  // `looked=0` también acá: un `.md` tocado que no era prosa del alcance, o que no se publica, no es «miré y está limpio»
  summary(blocking.length, 0, warnings ? `warnings=${warnings}` : r.looked ? '' : 'looked=0');
  record(args, { mode: m.mode, findings: r.findings, lowered: m.lowered, blocked: blocks, looked: r.looked });
  return blocks ? 1 : 0;
}

module.exports = { scan, FORMS, ZONES, zoneOf, teamPaths, effectiveMode, formModeOf, logicalLines, parseChanges, parseArgs, run, decisionOf, CouldNot };

// el código de salida se deja anotado y el proceso termina solo: `process.exit` corta la salida a medio escribir cuando
// va por un tubo (la cuenta en JSON de `--all` son miles de renglones)
if (require.main === module) {
  try { process.exitCode = main(); } catch (e) {
    // nada de lo de arriba debería llegar acá; si llega, es «no pude mirar», nunca un 1 que parezca un hallazgo, y con
    // el modo que diga la variable (sin configuración a mano, lo escrito cuenta como `block`)
    const mode = effectiveMode(null, process.env).mode === 'block' ? 'block' : 'warn';
    say(`⛔ historia interna: no pude mirar — ${reasonOf(e)}`);
    process.stdout.write(`internal-history: findings=0 cannot_look=1 mode=${mode}\n`);
    process.exitCode = mode === 'block' ? 2 : 0;
  }
}
