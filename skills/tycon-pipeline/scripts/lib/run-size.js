'use strict';
/**
 * run-size.js — el tamaño de la corrida del pipeline: `liviana` o `completa`.
 *
 * Liviana: TODOS los archivos que la story declara (`files_to_create` y `files_to_modify`) son documentación o texto
 * (`.md`, `.txt`, imágenes de guías y capturas) o acompañan al texto: las pruebas (`*.test.*`, `*.spec.*`, fixtures),
 * la lista de suites, las notas y mediciones de `tasks/` y NOTICE/LICENSE. Todo otro JSON es código, y el que es un
 * control (denegación, excepciones, renombres, lo que decide qué se publica) lo dice. Los `.md` que el agente ejecuta
 * (SKILL.md, CLAUDE.md, AGENTS.md, steps/, agents/, commands/, hooks/) son código. Una carpeta declarada se juzga por sus archivos.
 * Ninguno vive en una ruta de seguridad, de producción, del instalador o
 * de la CI. Cualquier otro archivo la vuelve completa, y el motivo nombra el primero. Una story sin archivos declarados
 * es completa: no se sabe qué toca. Cuántos archivos o cuántos ACs no cambian el tamaño.
 *
 * Las superficies que el repo declaró para el pase adversarial mandan: un archivo bajo `deep_review_always_paths` o el
 * `deep_review: always` del repo vuelven completa la corrida aunque todo sea texto.
 *
 * El tiempo estimado sale de las corridas archivadas en esta máquina (`timing-history/*.json`, el marcador de cada una
 * al cerrarse): la mediana de las del mismo tamaño que llegaron a preparar el commit. Las que no guardaron su tamaño se clasifican por lo que tocaron.
 * Sin ninguna, un número fijo por tamaño, dicho como «estimado sin historia».
 *
 * Funciones puras salvo `estimate`, que lee la carpeta que se le pasa.
 */
const fs = require('fs');
const path = require('path');

const SIZES = ['liviana', 'completa'];
const FIXED_MINUTES = { liviana: 45, completa: 180 };

const DOC_EXT = /\.(md|markdown|txt|png|jpe?g|gif|svg|webp)$/i;

// Rutas que vuelven completa la corrida aunque el archivo sea texto: lo que dicen ahí se ejecuta o protege algo.
const SENSITIVE = [
  { re: /(^|\/)(security|seguridad|auth|secrets?|credentials?|crypto)(\/|[-_.])/i, why: 'ruta de seguridad' },
  { re: /(^|\/)(production|produccion)(\/|[-_.])/i, why: 'ruta de producción' },
  { re: /(^|\/)install(er)?[-_.]|(^|\/)install-tycon-hooks/i, why: 'archivo del instalador' },
  { re: /(^|\/)(pipelines|\.github|ci)\/|azure-pipelines/i, why: 'archivo de la CI' },
  // un .md que el agente lee como instrucciones cambia lo que hace el arnés: no es documentación
  { re: /(^|\/)(SKILL|CLAUDE|AGENTS)\.md$|(^|\/)(steps|agents|commands|hooks)\/[^/]*\.md$/i, why: 'instrucciones que ejecuta el agente' },
];

// La lista del frontmatter puede traer el comentario de quien escribió la story: `- ruta   # para qué`.
function norm(f) { return String(f || '').replace(/\s+#.*$/, '').trim().replace(/\\/g, '/').replace(/^\.\//, ''); }

// Lo que acompaña al texto: no es lógica que corre en nombre de nadie.
const COMPANION = [
  { re: /\.(test|spec)\.[a-z]+$/i, why: 'prueba' },
  { re: /(^|\/)(fixtures?|__fixtures__)\//i, why: 'datos de prueba' },
  { re: /(^|\/)suites\.json$/i, why: 'lista de suites' },
  { re: /^tasks\//i, why: 'notas de tasks/' },
  { re: /(^|\/)(NOTICE|LICENSE|COPYING)(\.[a-z]+)?$/, why: 'texto legal' },
];
// JSON que son CONTROLES aunque traigan datos: deciden qué se frena o qué se publica.
const CONTROL_JSON = /(^|\/)(denylist|allowlist|[^/]*exceptions?|renames|internal-forms|split|public-repos|legacy-names|third-party-skills|hooks|safety-rules|controls-[^/]*)\.json$/i;
// Todo otro JSON es código («ante la duda, completa»); sólo
// cuentan como texto los datos conocidos que ya acompañan al texto (la lista de suites, tasks/, fixtures).
const CONFIG_JSON = /(^|\/)\.tycon\/|(^|\/)(package(-lock)?|tsconfig[^/]*|[^/]*\.config|settings[^/]*|appsettings[^/]*|plugin)\.json$/i;

/** Un patrón `<carpeta>/**`, `**\/x` o `*.ext` contra una ruta relativa. */
function globMatch(file, pattern) {
  const f = norm(file);
  const p = norm(pattern);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if ('.+?^$()|[]{}\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`).test(f) || (!p.includes('/') && new RegExp(`^${re}$`).test(path.posix.basename(f)));
}

/**
 * Los archivos que declara la story en `files_to_create` y `files_to_modify`, leídos del frontmatter. Acepta la lista
 * en renglones (`- ruta  # comentario`), la lista en línea (`[a, b]`) y un comentario después de la clave: el lector
 * general del pipeline se salteaba las dos últimas y una story con código saldría liviana.
 */
function declaredFiles(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const out = [];
  let inList = false;
  for (const line of m[1].split(/\r?\n/)) {
    const key = line.match(/^(files_to_create|files_to_modify)\s*:\s*(.*)$/);
    if (key) {
      const rest = key[2].replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
      inList = !rest;
      if (rest.startsWith('[')) {
        out.push(...rest.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
      } else if (rest) out.push(rest.replace(/^["']|["']$/g, ''));
      continue;
    }
    // la lista puede ir con sangría o pegada al margen (`- ruta` debajo de la clave); un comentario o un renglón
    // vacío en el medio no la corta
    if (inList && /^\s*(#.*)?$/.test(line)) continue;
    const item = inList && line.match(/^\s*-\s+(.*)$/);
    if (!item && /^\S/.test(line)) { inList = false; continue; }
    if (item) out.push(item[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, ''));
  }
  return out.filter(Boolean);
}

/** `{ kind: 'doc' | 'code', why }` de un archivo declarado. */
function classifyFile(file) {
  const f = norm(file);
  for (const s of SENSITIVE) if (s.re.test(f)) return { kind: 'code', why: s.why };
  if (DOC_EXT.test(f)) return { kind: 'doc', why: 'documentación' };
  if (CONTROL_JSON.test(f)) return { kind: 'code', why: 'archivo .json que es un control' };
  for (const c of COMPANION) if (c.re.test(f)) return { kind: 'doc', why: c.why };
  if (/\.json$/i.test(f)) return { kind: 'code', why: CONFIG_JSON.test(f) ? 'archivo .json de configuración' : 'archivo .json (todo JSON cuenta como código salvo los datos conocidos)' };
  const ext = path.posix.extname(f);
  if (f.endsWith('/')) return { kind: 'code', why: 'carpeta que no está en el repo: no se sabe qué trae' };
  return { kind: 'code', why: ext ? `archivo ${ext}` : 'archivo sin extensión' };
}

/**
 * @param {{ files: string[], alwaysPaths?: string[], deepReviewCfg?: string|null }} o
 * @returns {{ size: 'liviana'|'completa', reason: string, first_code_file: string|null }}
 */
function classifyStory({ files, alwaysPaths = [], deepReviewCfg = null, roots = [] }) {
  const list = expandDirs((files || []).map(norm).filter(Boolean), roots);
  if (!list.length) return { size: 'completa', reason: 'la story no declara archivos (files_to_create / files_to_modify)', first_code_file: null };
  if (deepReviewCfg === 'always') {
    return { size: 'completa', reason: 'el repo declara deep_review: always', first_code_file: null };
  }
  for (const f of list) {
    const pat = (alwaysPaths || []).find((p) => globMatch(f, p));
    if (pat) return { size: 'completa', reason: `${f} está en la superficie compartida del repo (${pat})`, first_code_file: f };
  }
  for (const f of list) {
    const c = classifyFile(f);
    if (c.kind === 'code') return { size: 'completa', reason: `${f}: ${c.why}`, first_code_file: f };
  }
  return { size: 'liviana', reason: `sólo documentación (${list.length} archivo${list.length === 1 ? '' : 's'})`, first_code_file: null };
}

/**
 * Una carpeta declarada (`guides/maintaining/`) se cambia por sus archivos, buscados en las raíces dadas (los repos de
 * la corrida). Si no está en ninguna, queda como carpeta: sin archivos no se sabe qué trae, y cuenta como código.
 */
function expandDirs(list, roots) {
  const out = [];
  for (const f of list) {
    if (!f.endsWith('/')) { out.push(f); continue; }
    const root = (roots || []).find((r) => { try { return fs.statSync(path.join(r, f)).isDirectory(); } catch (_) { return false; } });
    if (!root) { out.push(f); continue; }
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const r = `${rel}${e.name}`;
        if (e.isDirectory()) walk(`${r}/`); else out.push(r);
      }
    };
    walk(f);
  }
  return out;
}

/** Minutos de una corrida archivada: del arranque al último paso cerrado (o al último toque), o null. */
function runMinutes(marker) {
  const start = Date.parse(marker && marker.startedAt);
  if (!Number.isFinite(start)) return null;
  let end = NaN;
  for (const t of Object.values(marker.stepTimings || {})) {
    const c = Date.parse(t && t.completedAt);
    if (Number.isFinite(c) && !(c <= end)) end = c;
  }
  if (!Number.isFinite(end)) end = Date.parse(marker.lastTouch);
  if (!Number.isFinite(end) || end <= start) return null;
  return (end - start) / 60000;
}

/** El tamaño de una corrida archivada: el que guardó, o el de lo que tocó (sin los archivos de la propia corrida). */
function archivedSize(marker) {
  if (SIZES.includes(marker.size)) return marker.size;
  const files = (marker.filesTouched || []).map(norm).filter((f) => !/(^|\/)\.advisors\//.test(f));
  return classifyStory({ files }).size;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {{ size: string, historyDir: string|null }} o
 * @returns {{ minutes: number, samples: number, source: string }}
 */
function estimate({ size, historyDir }) {
  const sizeName = SIZES.includes(size) ? size : 'completa';
  const mins = [];
  let unreadable = 0;
  let names = [];
  let dirProblem = '';
  try { names = historyDir ? fs.readdirSync(historyDir).filter((n) => /\.json$/.test(n)) : []; } catch (e) {
    if (e && e.code !== 'ENOENT') dirProblem = `; no pude leer ${historyDir} (${e.code || e.message})`;
  }
  for (const n of names) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(historyDir, n), 'utf8')).marker; } catch (_) { unreadable += 1; continue; }
    // sólo las que llegaron a preparar el commit: una abandonada a la mitad tira la mediana para abajo
    if (!m || !require('./steps.js').isDone(m, 'prepare-commit') || archivedSize(m) !== sizeName) continue;
    const min = runMinutes(m);
    if (min !== null) mins.push(min);
  }
  const ilegibles = unreadable ? `; ${unreadable} registro(s) ilegible(s) en ${historyDir}` : '';
  if (!mins.length) {
    return { minutes: FIXED_MINUTES[sizeName], samples: 0, source: `estimado sin historia (${FIXED_MINUTES[sizeName]} min fijos para una ${sizeName}${ilegibles}${dirProblem})` };
  }
  const plural = sizeName === 'liviana' ? 'livianas' : 'completas';
  return { minutes: Math.round(median(mins)), samples: mins.length, source: `mediana de ${mins.length} corridas ${plural} terminadas de esta máquina${ilegibles}` };
}

module.exports = { SIZES, FIXED_MINUTES, declaredFiles, classifyFile, classifyStory, estimate, archivedSize, runMinutes, globMatch };
