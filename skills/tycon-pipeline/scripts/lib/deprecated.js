'use strict';

/**
 * deprecated.js — el código deprecado de un repo: qué rutas lo están, con qué nivel y por qué.
 *
 * En los proyectos conviven carpetas vivas con código viejo que nadie quiere borrar todavía. El agente no tiene cómo
 * saberlo: busca «cómo se hace X acá», lo encuentra y lo copia, o lo edita sin que nadie lo haya pedido. Esta
 * biblioteca es la única que contesta «¿esta ruta está deprecada?»; la usan el arranque, el aviso al leer, los
 * revisores, el validador, el freno de edición y el nocturno de proyectos.
 *
 * Dos fuentes, que valen igual:
 *
 *   · La lista, en `.tycon/advisors.yaml` (clave `deprecated`), leída de lo COMMITEADO. Sacar una entrada afloja el
 *     freno, y aflojar exige commit (`config-source.js`): si valiera la carpeta, el agente se sacaría una entrada
 *     escribiendo el archivo.
 *
 *         deprecated:
 *           edit: warn            # warn (avisa) | block (frena)
 *           paths:
 *             - path: "src/legacy/**"
 *               level: frozen     # frozen: sólo arreglos con motivo en la historia · dead: nada
 *               reason: "reemplazado por src/billing (2026-09)"
 *               review_by: <AAAA-MM-DD>   # opcional: cuándo hay que decidir si se borra
 *
 *   · La marca en la cabecera de un archivo: `harness-deprecated: frozen|dead — <motivo>` en un comentario de las
 *     primeras 10 líneas.
 *
 * Con dos niveles para la misma ruta gana el más estricto (`dead`). Lo que no se puede mirar (configuración
 * ilegible, carpeta sin git) no clasifica nada y queda como `unknown-*` en gates.log: no se frena por lo que no se vio.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const configSource = require('./config-source.js');
const { matchGlob } = require('./match-glob.js');
const { stateDir: stateDirOf } = require('./state-dir.js');

const NIVELES = ['frozen', 'dead'];
const MODOS = ['warn', 'block'];
const LINEAS_DE_CABECERA = 10;
const RANGO = { frozen: 1, dead: 2 };

// La marca: un comentario que ARRANCA la línea. Una mención dentro de un texto no empieza con un comentario.
const MARCA = /^\s*(?:\/\/+|#+|--|<!--|\/\*+|\*|;+)\s*harness-deprecated:\s*(frozen|dead)\b\s*(?:—|–|-{1,2}|:)?\s*(.*?)\s*(?:-->|\*\/)?\s*$/i;

function git(repo, args) {
  // un diff grande o un repo de miles de archivos pasa el 1 MiB por omisión: sin esto, «no pude mirar»
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
}

function anotar(opts, obj) {
  try {
    const dir = (opts && opts.stateDir) || stateDirOf();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), sessionId: (opts && opts.sessionId) || null, name: 'deprecated', ...obj })}\n`, 'utf8');
  } catch (_e) { /* anotar nunca rompe al que pregunta */ }
}

/** El valor de un `clave: valor`: entre comillas, lo de adentro (un ` #` ahí es texto); sin comillas, sin el comentario. */
function limpiar(v) {
  const t = String(v).trim();
  const q = t.match(/^(['"])(.*?)\1\s*(#.*)?$/);
  if (q) return q[2];
  return t.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
}

/**
 * El bloque `deprecated:` de un texto de configuración. PURA.
 * @returns {{presente: boolean, ilegible: string|null, edit: string, entries: object[], problems: object[]}}
 */
function parsear(texto) {
  const out = { presente: false, ilegible: null, edit: 'warn', entries: [], problems: [] };
  if (!texto) return out;
  const lineas = String(texto).split(/\r?\n/);
  let dentro = false; let enPaths = false; let actual = null; let indentItem = -1; let indentClave = -1;
  const cerrar = () => { if (actual) out.entries.push(actual); actual = null; };
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (!dentro) {
      if (/^deprecated\s*:\s*(#.*)?$/.test(linea)) dentro = true;
      continue;
    }
    if (/^\s*(#.*)?$/.test(linea)) continue;
    if (/^\S/.test(linea)) break;                                   // otra clave de primer nivel: fin del bloque
    if (/^\s*\t|\t/.test(linea.match(/^\s*/)[0])) { out.ilegible = `línea ${i + 1}: sangría con tabulador`; break; }
    const indent = linea.length - linea.trimStart().length;
    const t = linea.trim();
    let m;
    if (indentClave < 0) indentClave = indent;
    // Los ítems de la lista pueden ir al mismo nivel que `paths:` (YAML válido): un guion nunca es otra clave.
    const esItem = enPaths && t.startsWith('-');
    if (!esItem && (!enPaths || indent <= indentClave)) {
      cerrar(); enPaths = false;
      if ((m = t.match(/^edit\s*:\s*(.*)$/))) { out.edit = limpiar(m[1]); continue; }
      if ((m = t.match(/^paths\s*:\s*(.*)$/))) {
        const resto = limpiar(m[1]);
        if (resto === '' ) { enPaths = true; continue; }
        if (resto === '[]') continue;
        out.ilegible = `línea ${i + 1}: \`paths\` tiene que ser una lista de entradas`; break;
      }
      out.ilegible = `línea ${i + 1}: «${t}» no es \`edit\` ni \`paths\``; break;
    }
    if ((m = t.match(/^-\s*(.*)$/))) {
      cerrar();
      actual = { linea: i + 1 };
      indentItem = indent;
      const resto = m[1];
      if (resto === '') continue;
      const kv = resto.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (!kv) { out.ilegible = `línea ${i + 1}: cada entrada es \`- path: …\` con sus campos`; break; }
      actual[kv[1]] = limpiar(kv[2]);
      continue;
    }
    const kv = t.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!actual || indent <= indentItem || !kv) { out.ilegible = `línea ${i + 1}: «${t}» no se entiende`; break; }
    actual[kv[1]] = limpiar(kv[2]);
  }
  out.presente = dentro;
  if (out.ilegible) { out.entries = []; return out; }
  cerrar();
  if (!MODOS.includes(out.edit)) {
    out.problems.push({ entry: null, motivo: `\`edit: ${out.edit}\` no es warn ni block: se avisa (warn)` });
    out.edit = 'warn';
  }
  out.entries = out.entries.filter((e) => {
    const malos = [];
    if (!e.path) malos.push('falta `path`');
    if (!NIVELES.includes(e.level)) malos.push(e.level ? `\`level: ${e.level}\` no es frozen ni dead` : 'falta `level`');
    if (!e.reason) malos.push('falta `reason`');
    if (e.path && /^(\/|[A-Za-z]:[\\/])/.test(e.path)) malos.push('`path` va relativo al repo, sin `/` ni unidad al principio');
    if (e.path) { try { matchGlob('x', e.path); } catch (_e) { malos.push(`\`path: ${e.path}\` no es un glob que se pueda leer`); } }
    if (e.review_by && !/^\d{4}-\d{2}-\d{2}$/.test(e.review_by)) {
      out.problems.push({ entry: e, motivo: `línea ${e.linea}: \`review_by: ${e.review_by}\` no es una fecha AAAA-MM-DD` });
      delete e.review_by;
    }
    if (malos.length) { out.problems.push({ entry: e, motivo: `línea ${e.linea}: ${malos.join(', ')}` }); return false; }
    e.path = e.path.replace(/\\/g, '/').replace(/^\.\//, '');
    return true;
  });
  return out;
}

/**
 * La lista del repo, de lo commiteado. Lo que no pudo mirar queda dicho en gates.log (`unknown-*`), una vez por lectura:
 * todos los lectores pasan por acá, así ninguno lo calla.
 * @param {{stateDir?: string, sessionId?: string}} [opts]  dónde anotar
 * @returns {{estado: 'ok'|'sin-lista'|'unknown-sin-git'|'unknown-config-ilegible', edit, entries, problems, motivo?}}
 */
function leerLista(repo, opts = {}) {
  const l = leerListaCruda(repo);
  if (l.estado.startsWith('unknown-')) anotar(opts, { status: l.estado, repoPath: repo || null, reason: l.motivo });
  return l;
}

function leerListaCruda(repo) {
  const vacia = (estado, motivo) => ({ estado, motivo: motivo || null, edit: 'warn', entries: [], problems: [] });
  if (!repo) return vacia('unknown-sin-git', 'sin repo');
  let hayHead = false;
  try { git(repo, ['rev-parse', '--verify', 'HEAD']); hayHead = true; } catch (_e) { hayHead = false; }
  if (!hayHead) return vacia('unknown-sin-git', 'la carpeta no es un repo git con commits: no hay lista commiteada que leer');
  const texto = configSource.leerCommiteado(repo);
  const p = parsear(texto);
  if (p.ilegible) return vacia('unknown-config-ilegible', `.tycon/advisors.yaml, bloque deprecated: ${p.ilegible}`);
  if (!p.presente) return vacia('sin-lista');
  return { estado: 'ok', motivo: null, edit: p.edit, entries: p.entries, problems: p.problems };
}

/** La marca de la cabecera de un archivo, o null. Un archivo que existe y no se puede leer queda dicho. */
function marcaDelArchivo(abs, opts = {}) {
  let texto = '';
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      texto = buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    // que no exista es lo normal (un Write que lo crea); otra cosa es «no pude mirar»
    if (e && !['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code)) anotar(opts, { status: 'unknown-lectura', file: abs, reason: e.code || e.message });
    return null;
  }
  const lineas = texto.split(/\r?\n/).slice(0, LINEAS_DE_CABECERA);
  for (const l of lineas) {
    const m = l.match(MARCA);
    if (m) return { level: m[1].toLowerCase(), reason: m[2] || '' };
  }
  return null;
}

/**
 * ¿La entrada alcanza la ruta relativa? Una ruta sin comodines es un archivo o una carpeta del repo. Los comodines son
 * los de `matchGlob` (`*`, `**`, `{a,b}`); `?` no lo es, como en la superficie de los revisores.
 */
function alcanza(rel, patron) {
  const p = patron.replace(/\/+$/, '');
  if (!/[*{]/.test(p)) return rel === p || matchGlob(rel, `${p}/**`);
  return matchGlob(rel, p);
}

/**
 * La ruta real: enlaces resueltos y, en un disco que no distingue mayúsculas (macOS, Windows), con las letras que tiene
 * en el disco. Lo que todavía no existe se arma sobre el primer antecesor que sí existe.
 */
function real(abs) {
  const resolver = fs.realpathSync.native || fs.realpathSync;
  const resto = [];
  let p = path.resolve(abs);
  for (;;) {
    try { return path.join(resolver(p), ...resto.reverse()); } catch (_e) { /* subir un nivel */ }
    const up = path.dirname(p);
    if (up === p) return abs;
    resto.push(path.basename(p));
    p = up;
  }
}

/** La ruta relativa al repo, con barras; null si cae afuera. */
function relativa(repo, ruta) {
  const abs = path.isAbsolute(ruta) ? ruta : path.join(repo, ruta);
  const rel = path.relative(real(repo), real(abs)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * ¿Está deprecada esta ruta?
 * @param {string} repo  raíz del repo
 * @param {string} ruta  absoluta o relativa al repo
 * @param {{stateDir?: string, sessionId?: string, lista?: object}} [opts]  `lista` evita releer en un recorrido
 * @returns {{level, reason, source: 'config'|'mark', entry}|null}
 */
function clasificar(repo, ruta, opts = {}) {
  const lista = opts.lista || leerLista(repo, opts);
  if (lista.estado.startsWith('unknown-')) return null;
  const rel = relativa(repo, ruta);
  if (!rel) return null;
  let mejor = null;
  for (const e of lista.entries) {
    if (!alcanza(rel, e.path)) continue;
    if (!mejor || RANGO[e.level] > RANGO[mejor.level]) mejor = { level: e.level, reason: e.reason, source: 'config', entry: e };
  }
  const marca = marcaDelArchivo(path.join(repo, rel), opts);
  if (marca && (!mejor || RANGO[marca.level] > RANGO[mejor.level])) {
    mejor = { level: marca.level, reason: marca.reason, source: 'mark', entry: { path: rel, level: marca.level, reason: marca.reason } };
  }
  return mejor;
}

/**
 * Las entradas podridas: la ruta no alcanza ningún archivo del repo, o pasó su `review_by`.
 * @param {string} hoy  AAAA-MM-DD
 * @returns {{estado, podridas: Array<{entry, motivo: 'no-existe'|'vencida'}>}}
 */
function podridas(repo, { hoy, lista, stateDir } = {}) {
  const l = lista || leerLista(repo, { stateDir });
  if (l.estado !== 'ok') return { estado: l.estado, motivo: l.motivo, podridas: [] };
  let archivos;
  try { archivos = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean); } catch (_e) {
    anotar({ stateDir }, { status: 'unknown-sin-git', repoPath: repo, reason: 'git no pudo listar los archivos del repo' });
    return { estado: 'unknown-sin-git', motivo: 'git no pudo listar los archivos del repo', podridas: [] };
  }
  const out = [];
  for (const e of l.entries) {
    if (!archivos.some((f) => alcanza(f, e.path))) out.push({ entry: e, motivo: 'no-existe' });
    else if (e.review_by && hoy && e.review_by < hoy) out.push({ entry: e, motivo: 'vencida' });
  }
  return { estado: 'ok', podridas: out };
}

/**
 * La raíz del repo que contiene una ruta, o null. Fuera de todo repo es lo normal y no se anota; una carpeta con
 * `.tycon/advisors.yaml` y sin git es «no pude mirar» (AC 11) y queda dicho.
 */
function raizDelRepo(ruta, opts = {}) {
  let dir = ruta;
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch (_e) { dir = path.dirname(dir); }
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) return null; dir = up; }
  try { return git(dir, ['rev-parse', '--show-toplevel']).trim() || null; } catch (_e) { /* sigue abajo */ }
  for (let d = dir; ; d = path.dirname(d)) {
    if (configSource.NOMBRES.some((n) => fs.existsSync(path.join(d, '.tycon', n)))) {
      anotar(opts, { status: 'unknown-sin-git', repoPath: d, file: ruta, reason: 'la carpeta tiene .tycon/advisors.yaml y no es un repo git: no hay lista commiteada que leer' });
      return null;
    }
    if (path.dirname(d) === d) return null;
  }
}

// ── La historia que toca lo deprecado ────────────────────────────────────────────────────────────────────────────

function frontmatter(texto) {
  const m = String(texto || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

/**
 * Las entradas de una lista del frontmatter (`files_to_modify`, `files_to_create`): `{ ruta, repo }`, con `repo` el
 * prefijo `(nombre)` que marca un archivo de otro repo (o null). Lee la forma de bloque (con comentarios en cualquier
 * columna) y la de corchetes (`[a, b]`); saca comillas antes del prefijo, que es como se escribe en las historias.
 */
function entradasDelFrontmatter(texto, clave) {
  const out = [];
  const agregar = (crudo) => {
    let t = limpiar(crudo);
    const pre = t.match(/^\(([^)]*)\)\s*(.*)$/);
    const repo = pre ? pre[1].trim() : null;
    if (pre) t = pre[2].trim();
    t = t.replace(/^(['"])(.*)\1$/, '$2').replace(/\\/g, '/').replace(/^\.\//, '');
    if (t) out.push({ ruta: t, repo });
  };
  let dentro = false;
  for (const l of frontmatter(texto).split(/\r?\n/)) {
    const cab = l.match(new RegExp(`^${clave}\\s*:\\s*(.*)$`));
    if (cab) {
      const flujo = cab[1].replace(/\s+#.*$/, '').trim().match(/^\[(.*)\]$/);
      if (flujo) { for (const x of flujo[1].split(',')) if (x.trim()) agregar(x); break; }
      dentro = true;
      continue;
    }
    if (!dentro) continue;
    if (/^\s*(#.*)?$/.test(l)) continue;   // un comentario o una línea vacía no cierran la lista
    if (/^\S/.test(l)) break;
    const m = l.match(/^\s*-\s*(.+)$/);
    if (m) agregar(m[1]);
  }
  return out;
}

/** Las rutas de una lista del frontmatter, sin comentarios ni `(repo)`. */
function listaDelFrontmatter(texto, clave) {
  return entradasDelFrontmatter(texto, clave).map((e) => e.ruta);
}

/** Las entradas de la historia que son de ESTE repo: sin prefijo, o con el prefijo de su nombre. */
function delRepo(entradas, repo) {
  const nombre = path.basename(repo || '');
  return entradas.filter((e) => !e.repo || e.repo === nombre);
}

/** El motivo que la historia da para tocar lo deprecado (`deprecated_reason:`), o ''. Nulo o comentario es ''. */
function motivoDeLaHistoria(texto) {
  const lineas = frontmatter(texto).split(/\r?\n/);
  const i = lineas.findIndex((l) => /^deprecated_reason\s*:/.test(l));
  if (i < 0) return '';
  const valor = lineas[i].replace(/^deprecated_reason\s*:\s*/, '').trim();
  let motivo;
  if (/^[|>][-+]?(\s+#.*)?$/.test(valor)) {
    const cuerpo = [];
    for (const l of lineas.slice(i + 1)) { if (/^\S/.test(l)) break; cuerpo.push(l.trim()); }
    motivo = cuerpo.join(' ').trim();
  } else {
    motivo = limpiar(valor);
  }
  return /^(~|null|Null|NULL)?$/.test(motivo) ? '' : motivo;
}

/**
 * Los archivos que una historia declara y están deprecados en este repo (AC 7). Un `dead` frena siempre; un `frozen`,
 * si la historia no trae `deprecated_reason:`. `files_to_create` dentro de lo deprecado sigue la misma regla.
 * @returns {Array<{archivo, lista, nivel, motivo, fuente, entrada, frena}>}
 */
function archivosDeHistoria({ repo, storyText, stateDir } = {}) {
  const lista = leerLista(repo, { stateDir });
  if (lista.estado.startsWith('unknown-')) return [];
  const motivo = motivoDeLaHistoria(storyText);
  const out = [];
  for (const clave of ['files_to_modify', 'files_to_create']) {
    // sólo las de este repo: una ruta marcada `(otro-repo)` se juzga con la lista de ese repo, no con ésta
    for (const { ruta: archivo } of delRepo(entradasDelFrontmatter(storyText, clave), repo)) {
      const c = clasificar(repo, archivo, { lista, stateDir });
      if (!c) continue;
      out.push({
        archivo, lista: clave, nivel: c.level, motivo: c.reason, fuente: c.source, entrada: c.entry.path,
        frena: c.level === 'dead' || !motivo,
      });
    }
  }
  return out;
}

/** ¿La historia autoriza tocar este archivo deprecado? Sólo un `frozen`, declarado y con motivo. */
function historiaAutoriza({ repo, storyText, archivo, clasificacion }) {
  if (!clasificacion || clasificacion.level !== 'frozen' || !motivoDeLaHistoria(storyText)) return false;
  const rel = relativa(repo, archivo);
  const declarados = delRepo([...entradasDelFrontmatter(storyText, 'files_to_modify'), ...entradasDelFrontmatter(storyText, 'files_to_create')], repo)
    .map((e) => e.ruta);
  // la ruta entera, relativa al repo: un nombre suelto (`index.js`) no autoriza a cualquier archivo que se llame igual
  return !!rel && declarados.includes(rel);
}

// ── Lo vivo que nombra lo deprecado (DEPR-W1) ────────────────────────────────────────────────────────────────────

const EXTENSIONES = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.cs', '.py', '/index.js', '/index.ts', '/index.tsx'];

/**
 * Las líneas agregadas por archivo (diff contra HEAD más los archivos nuevos sin seguimiento), con su número. El diff se
 * pide con prefijos fijos, sin comillas en los nombres y sin programas externos: la configuración de git de cada
 * máquina (`diff.noprefix`, `diff.mnemonicPrefix`, `core.quotePath`) no cambia lo que se lee.
 */
function lineasAgregadas(repo, opts = {}) {
  const out = new Map();
  // los prefijos `a/` y `b/` de siempre, aunque la máquina diga otra cosa (`diff.noprefix`, `diff.mnemonicPrefix`)
  const diff = git(repo, ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
    'diff', '--no-ext-diff', '--no-color', '-U0', 'HEAD']);
  let actual = null; let n = 0;
  for (const l of diff.split('\n')) {
    const f = l.match(/^\+\+\+ b\/(.+?)\t?$/);   // git agrega un tabulador al final de un nombre con espacios
    if (f) { actual = f[1]; continue; }
    if (/^\+\+\+ /.test(l)) { actual = null; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { n = Number(h[1]); continue; }
    if (actual && l.startsWith('+')) {
      if (!out.has(actual)) out.set(actual, []);
      out.get(actual).push({ n, texto: l.slice(1) });
      n++;
    }
  }
  for (const f of git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) {
    let texto = '';
    try { texto = fs.readFileSync(path.join(repo, f), 'utf8'); } catch (e) {
      // un archivo nuevo que no se puede leer no se evalúa, y queda dicho
      anotar(opts, { status: 'unknown-lectura', repoPath: repo, file: f, reason: (e && e.code) || 'no se pudo leer' });
      continue;
    }
    if (texto.includes('\0')) continue;
    out.set(f, texto.split(/\r?\n/).map((t, i) => ({ n: i + 1, texto: t })));
  }
  return out;
}

/** Las rutas que una línea nombra: los textos entre comillas que parecen una ruta, resueltos contra su archivo. */
function rutasNombradas(archivo, texto) {
  const out = [];
  for (const m of texto.matchAll(/(['"`])([^'"`\s]+)\1/g)) {
    const t = m[2];
    if (!t.includes('/') || /^[a-z]+:\/\//i.test(t)) continue;
    const rel = t.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(archivo), t)) : t.replace(/^\//, '');
    if (!rel.startsWith('..')) out.push(rel);
  }
  return out;
}

/** Lo deprecado que una ruta nombrada alcanza: la entrada más estricta de la lista, o la marca de un archivo que existe. */
function deprecadoNombrado(repo, ruta, lista, opts) {
  let mejor = null;
  for (const ext of EXTENSIONES) {
    const candidata = ruta + ext;
    for (const e of lista.entries) {
      if (alcanza(candidata, e.path) && (!mejor || RANGO[e.level] > RANGO[mejor.level])) mejor = { level: e.level, reason: e.reason, entrada: e.path };
    }
    const abs = path.join(repo, candidata);
    if (ext !== '' || /\.[A-Za-z0-9]+$/.test(ruta)) {
      let esArchivo = false;
      try { esArchivo = fs.statSync(abs).isFile(); } catch (_e) { esArchivo = false; }
      const marca = esArchivo ? marcaDelArchivo(abs, opts) : null;
      if (marca && (!mejor || RANGO[marca.level] > RANGO[mejor.level])) mejor = { level: marca.level, reason: marca.reason, entrada: candidata };
    }
  }
  return mejor;
}

/**
 * DEPR-W1: líneas agregadas en archivos VIVOS que importan, requieren o nombran una ruta deprecada (por la lista o por
 * la marca en su cabecera). Avisa, no frena. La configuración del arnés (`.tycon/`) no se juzga: nombrar ahí lo
 * deprecado es declararlo.
 * @param {{repo: string, files?: string[]}} args  `files` acota a esos archivos (relativos o absolutos)
 */
function vivoQueNombraDeprecado({ repo, files = [], stateDir } = {}) {
  const lista = leerLista(repo, { stateDir });
  if (lista.estado !== 'ok' && lista.estado !== 'sin-lista') return [];
  let agregadas;
  try { agregadas = lineasAgregadas(repo, { stateDir }); } catch (_e) { anotar({ stateDir }, { status: 'unknown-sin-diff', repoPath: repo, reason: 'git no pudo dar las líneas agregadas' }); return []; }
  const acotar = files.length ? new Set(files.map((f) => relativa(repo, f)).filter(Boolean)) : null;
  const out = [];
  for (const [archivo, lineas] of agregadas) {
    if (acotar && !acotar.has(archivo)) continue;
    if (/^\.tycon\//.test(archivo)) continue;
    if (clasificar(repo, archivo, { lista, stateDir })) continue;   // lo deprecado puede nombrarse a sí mismo
    for (const { n, texto } of lineas) {
      for (const ruta of rutasNombradas(archivo, texto)) {
        const e = deprecadoNombrado(repo, ruta, lista, { stateDir });
        if (!e) continue;
        out.push({
          rule: 'DEPR-W1', severity: 'WARNING', status: 'warn', file: archivo, line: n, ruta, entrada: e.entrada,
          detail: `${archivo}:${n} nombra ${ruta}, que está deprecado (${e.level}: ${e.reason}). Lo vivo no debería depender de lo deprecado.`,
        });
        break;
      }
    }
  }
  return out;
}

// ── Lo que ven los revisores ─────────────────────────────────────────────────────────────────────────────────────

const NIVEL_EN_CASTELLANO = { frozen: 'congelado', dead: 'muerto' };

/** La sección del contexto de los revisores con los archivos deprecados del diff; '' si no hay ninguno. */
function seccionParaRevisores({ repo, files, stateDir } = {}) {
  const lista = leerLista(repo, { stateDir });
  if (lista.estado.startsWith('unknown-')) return '';
  const marcados = [];
  for (const f of files || []) {
    const c = clasificar(repo, f, { lista, stateDir });
    if (c) marcados.push(`- ${relativa(repo, f) || f} — ${NIVEL_EN_CASTELLANO[c.level]}: ${c.reason}`);
  }
  if (!marcados.length) return '';
  return [
    `## Archivos deprecados del diff (${marcados.length})`,
    '',
    '> deprecado: no lo revises, salvo que la historia declare `deprecated_reason:` (entonces revisá sólo el arreglo',
    '> que la historia pide). Para el revisor de patrones hermanos: no tomes de modelo ninguno de estos archivos.',
    '',
    ...marcados,
    '',
  ].join('\n');
}

module.exports = {
  parsear, leerLista, marcaDelArchivo, alcanza, relativa, clasificar, podridas, raizDelRepo,
  listaDelFrontmatter, entradasDelFrontmatter, delRepo, motivoDeLaHistoria, archivosDeHistoria, historiaAutoriza,
  lineasAgregadas, vivoQueNombraDeprecado, seccionParaRevisores, anotar, NIVELES, MODOS,
};
