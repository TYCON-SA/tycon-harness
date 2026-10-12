'use strict';
// layer.js — la capa privada: lo que una máquina del equipo apila encima de la copia pública (story 8.13.1, tanda A,
// AC 3 y 4).
//
// Dos piezas separadas a propósito (AC 3): CALCULAR la lista y APILARLA. El apilador recibe una lista y no sabe de
// dónde salió: otra forma de calcularla (la de un equipo de afuera, pregunta 6 de la story) se suma sin tocarlo.
//
// CALCULAR (`computeLayer`, sin escribir nada): `git ls-tree -r` del commit interno contra el del commit público, ruta
// por ruta, por el hash de git de cada archivo (el blob):
//   · en el interno y no en el público → `add` (en su misma ruta: el repo unido trae agents/, skills/ y packs/ en la raíz);
//   · en los dos con otro blob y declarada en `transformed` del version.json publicado → `overwrite` (el interno manda);
//   · en los dos con otro blob y en «el público manda» (fixtures/layer-public-wins.json) → `same`;
//   · en los dos con otro blob y en ninguna de las dos → «capa de otra versión»: rojo, y la lista no se usa;
//   · sólo en el público: aceptada si está en «sólo afuera»; si no, un hallazgo. «Sólo afuera» es la lista a mano
//     (fixtures/layer-public-only.json) MÁS lo que el exportador agrega sólo a la copia según la lista blanca de ESE
//     commit interno: los destinos `synthetic` (los papeles de public-files/), los `generated` (version.json) y la
//     carpeta nueva de cada `skillRenames` (`outsideMatcher`). Un papel nuevo en la lista blanca se reconoce solo;
//     si la lista blanca no se puede leer, se dice por qué y lo de sólo afuera sigue como hallazgo;
//   · y la otra mitad de la compatibilidad (AC 5): un `add` que ese commit interno PUBLICA (un archivo nuevo en una
//     carpeta pública, que la copia todavía no trae) también es «capa de otra versión». Qué publica el commit lo dice la
//     clasificación del exportador (`whatShips`, la misma del freno de nombres), con la lista blanca, la tabla y el mapa
//     de renombres de ESE commit leídos de git: sin exportar y sin escribir nada. Las listas privadas se leen en memoria
//     y su contenido no sale en ningún mensaje. Si no se puede saber, la capa no es compatible («no pude mirar»).
//   Un version.json sin `transformed` no deja calcular: sin la lista no hay forma de distinguir un ajuste del exportador
//   de un cambio de otra versión. Mismos commits → misma lista, byte a byte (`serializeList`).
//
// APILAR (`applyLayer`): cada entrada se escribe desde su blob, leído con UN `git cat-file --batch` para todas, atómica
// (temporal al lado + rename), con el modo del blob; el manifiesto (layer.json) guarda el sha256 de cada archivo, y el
// bloque `# tycon-layer` de `<árbol>/.git/info/exclude` declara lo agregado (las carpetas privadas enteras, los archivos
// sueltos uno por uno) con una línea que nombra la fuente; lo de la persona fuera del bloque no se toca. Las reglas:
//   · nunca un enlace: una entrada que en git es un enlace (120000) o un submódulo (160000) frena TODO antes de escribir;
//   · lo editado a mano (el sha256 del disco no es el del manifiesto) no se pisa ni se borra: se avisa con la ruta;
//   · lo que la máquina escribe (fixtures/harness-tree-writers.json) se escribe si falta y no entra al manifiesto;
//   · un agregado que dejó de estar en la lista: si su ruta pasó a ser pública (git la sigue en el árbol) sale del
//     manifiesto y del bloque y el archivo queda; si no, se borra sólo si su hash es el del manifiesto;
//   · un pisado que dejó de estar en la lista (el interno lo borró o lo dejó igual al público) vuelve al contenido
//     público (`git checkout` del índice) si tiene el contenido que dejó la capa; si ya está como el público, sólo
//     sale del manifiesto;
//   · lo que dejó de estar en la lista y está editado a mano no se toca: queda en el manifiesto marcado (`held`) y se
//     avisa en cada corrida (y verify sale 1) hasta que la persona lo resuelve (lo borra o lo vuelve a como estaba);
//   · el bloque se reconoce aunque el archivo tenga finales CRLF o espacios al final; dos bloques completos quedan en
//     uno; un bloque que empieza y no cierra frena todo antes de escribir (nunca se adivina dónde termina);
//   · una segunda corrida igual no escribe nada y lo dice.
// En Windows el modo no se mira en el disco (NTFS): queda en el manifiesto.
//
// VERIFICAR (`verifyLayer`, sin escribir nada): el árbol contra el manifiesto, archivo por archivo; lo marcado `held`
// sale siempre como pendiente.
//
// Funciones puras respecto del HOME: el árbol, el manifiesto y las listas llegan como rutas.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA = 1;
const SOURCE_NAME = 'internal';
const TREE_SOURCE_NAME = 'harness';
const VERSION_FILE = 'version.json';
const MODE_FILE = '100644';
const MODE_EXEC = '100755';
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';
const BLOCK_BEGIN_MARK = '# tycon-layer begin';
const BLOCK_BEGIN = '# tycon-layer begin — lo escribe la capa privada (harness.js layer); lo de afuera de este bloque es tuyo';
const BLOCK_END = '# tycon-layer end';
const NO_TRANSFORMED = 'la versión pública no trae la lista de transformados: la capa no se apila';
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const PUBLISHING = path.join(__dirname, '..', '..', 'publishing');
const DEFAULT_LISTS = {
  publicWins: path.join(FIXTURES, 'layer-public-wins.json'),
  publicOnly: path.join(FIXTURES, 'layer-public-only.json'),
  writers: path.join(FIXTURES, 'harness-tree-writers.json'),
};

const byPath = (a, b) => { const x = a.path || a; const y = b.path || b; return x < y ? -1 : x > y ? 1 : 0; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** El id de git de un contenido (sha1, o sha256 en un repo con ese formato: lo dice el largo del blob). */
const gitBlobId = (buf, like) => crypto.createHash(like && like.length === 64 ? 'sha256' : 'sha1')
  .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const lstat = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin espera */ } };

class LayerError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });   // sin login invisible (8.23, AC 38)
}

/** Corre git en `dir`. Tira `LayerError` si falla. Con `binary` devuelve un Buffer. */
function git(dir, args, { input, binary } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', dir, ...args],
    { windowsHide: true, env: gitEnv(), input, maxBuffer: GIT_MAX_BUFFER, encoding: binary ? null : 'utf8' });
  if (r.error) throw new LayerError(`no pude correr git en ${dir} (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new LayerError(`git ${args[0]} en ${dir} falló: ${String(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

const resolveCommit = (dir, rev) => git(dir, ['rev-parse', '--verify', '--quiet', `${rev || 'HEAD'}^{commit}`]).trim();

/** `git ls-tree -r` de un commit: Map ruta → { mode, type, blob }. */
function readTree(dir, commit) {
  const out = new Map();
  for (const line of git(dir, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    out.set(line.slice(tab + 1), { mode, type, blob });
  }
  return out;
}

/** El version.json del commit público: `{ ok, version, transformed, problem, reason }`. Nunca tira por el contenido. */
function readPublicVersion(dir, commit) {
  let text;
  try { text = git(dir, ['show', `${commit}:${VERSION_FILE}`]); } catch (_) {
    return { ok: false, problem: 'no-version', reason: `la versión pública no trae ${VERSION_FILE}: la capa no se apila` };
  }
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    return { ok: false, problem: 'no-version', reason: `${VERSION_FILE} de la versión pública no se puede leer (${e.message})` };
  }
  const list = data && data.transformed;
  if (!Array.isArray(list) || !list.every((t) => t && typeof t.path === 'string' && t.path && typeof t.transform === 'string' && t.transform)) {
    return { ok: false, problem: 'no-transformed', reason: NO_TRANSFORMED, version: data && data.version };
  }
  return { ok: true, version: typeof data.version === 'string' ? data.version : null, transformed: new Map(list.map((t) => [t.path, t.transform])) };
}

// ── las listas declaradas ────────────────────────────────────────────────────────────────────────

/** Un patrón de las listas (`*` dentro de una carpeta, `**` a cualquier profundidad) como expresión regular. */
function patternRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matcher = (patterns) => { const res = patterns.map(patternRegex); return (p) => res.some((r) => r.test(p)); };

/** Lee los patrones de una lista declarada: `paths` (de layer-public-*.json) o los `paths` de cada escritor. */
function loadPatterns(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    throw new LayerError(`no pude leer la lista ${file} (${e.code || e.message})`);
  }
  const items = Array.isArray(data.paths) ? data.paths
    : Array.isArray(data.writers) ? data.writers.flatMap((w) => (Array.isArray(w.paths) ? w.paths : []))
      : null;
  if (!items) throw new LayerError(`la lista ${file} no trae «paths» ni «writers»`);
  return items.map((x) => (typeof x === 'string' ? x : x && x.path)).filter((x) => typeof x === 'string' && x);
}

// ── calcular ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el exportador agrega SÓLO a la copia, según una lista blanca ya leída: los destinos `synthetic` (los papeles
 * de public-files/ y los sintéticos), los `generated` (version.json) y la carpeta nueva de cada `skillRenames`. Como
 * patrones de «sólo afuera». Los que reemplazan un archivo interno no molestan: «sólo afuera» mira sólo las rutas que
 * el interno no tiene.
 */
function copyOnlyPatterns(lista) {
  const out = [];
  const target = (x) => (x && typeof x.target === 'string' && x.target ? x.target : null);
  for (const s of (lista && Array.isArray(lista.synthetic) ? lista.synthetic : [])) if (target(s)) out.push(target(s));
  for (const g of (lista && Array.isArray(lista.generated) ? lista.generated : [])) if (target(g)) out.push(target(g));
  for (const r of (lista && Array.isArray(lista.skillRenames) ? lista.skillRenames : [])) {
    if (r && typeof r.to === 'string' && r.to && r.to !== r.from) out.push(`${r.to}/**`);
  }
  return [...new Set(out)].sort();
}

/** La lista blanca de un commit interno, leída de git (su ruta de hoy o la de antes de la mudanza, con las claves de
 *  hoy). `tree` es su `readTree`. Tira si el commit no la trae o no se puede leer. Sólo rutas: no es una lista privada. */
function commitAllowlist(dir, commit, tree) {
  const names = require(path.join(PUBLISHING, 'new-names.js'));
  const legacy = require(path.join(__dirname, '..', '..', 'lib', 'legacy-names.js'));
  const where = names.configPathIn(new Map([...tree].map(([p, e]) => [p, { tipo: e.type }])), names.CONFIG.list);
  if (!where) throw new LayerError(`el commit no trae ${names.CONFIG.list}`);
  const lista = names.parseJson(git(dir, ['cat-file', 'blob', tree.get(where).blob]), names.CONFIG.list);
  return legacy.readKeysDeep(lista, names.CONFIG.list, { record: false });
}

/**
 * «Sólo afuera» de un commit interno: la lista a mano (`publicOnly`, patrones o la ruta de la lista) más lo que el
 * exportador agrega sólo a la copia según la lista blanca de ese commit (`copyOnly` en vez de leerla, para las pruebas).
 * La lista blanca se lee la primera vez que hace falta (una ruta que la lista a mano no acepta). Si no se puede leer,
 * esas rutas no se aceptan y `matcher.problem` dice por qué. Lo usan computeLayer y doctor (la misma regla).
 */
function outsideMatcher({ internalDir, internalCommit = 'HEAD', publicOnly = DEFAULT_LISTS.publicOnly, copyOnly = null, tree = null } = {}) {
  const manual = matcher(Array.isArray(publicOnly) ? publicOnly : loadPatterns(publicOnly));
  let derived = Array.isArray(copyOnly) ? matcher(copyOnly) : null;
  const fn = (p) => {
    if (manual(p)) return true;
    if (!derived) {
      let commit = internalCommit;
      try {
        commit = resolveCommit(internalDir, internalCommit);
        derived = matcher(copyOnlyPatterns(commitAllowlist(internalDir, commit, tree || readTree(internalDir, commit))));
      } catch (e) {
        derived = () => false;
        fn.problem = `no pude saber qué agrega el exportador sólo a la copia: no pude leer la lista blanca del commit interno ${String(commit).slice(0, 7)} (${String(e.message).split('\n')[0]}); lo de sólo afuera queda como hallazgo`;
      }
    }
    return derived(p);
  };
  fn.problem = null;
  return fn;
}

/**
 * Qué publica un commit interno, sin exportar (AC 5): la clasificación del exportador (`whatShips`) con la lista blanca,
 * la tabla y el mapa de renombres de ESE commit, leídos de git (la máquina los tiene en su clon de lectura). Devuelve una
 * función ruta interna → ruta en la copia (otra si el exportador la renombra), o null si no sale. Cuenta lo que sale
 * tal cual o traducido y lo que un paquete deja «pendiente» de la unión (en la copia, que es la unión de los paquetes
 * públicos, sale); no cuenta los sintéticos: lo que sale en esa ruta no es el archivo interno. Tira si no puede saberlo.
 */
function exporterPublishable(dir, commit) {
  const names = require(path.join(PUBLISHING, 'new-names.js'));
  const exporter = require(path.join(PUBLISHING, 'export.js'));
  const dirs = { arnes: dir, 'agent-skills': dir };
  const read = names.blobReader(dirs);
  const snap = names.snapshot(`el commit interno ${commit.slice(0, 7)}`, names.splitTree(names.commitTree(dir, commit)), { dirs, read });
  const lista = names.parseJson(snap.listText, names.CONFIG.list);
  const table = names.parseJson(snap.tableText, names.CONFIG.table);
  const shipped = names.ships(snap, names.contextFor(snap, { lista, table, strict: true }));
  return (p) => {
    const source = names.sourceOfPath(p);
    for (const pkg of shipped.packages) {
      const key = pkg.keyOf(source, p);
      const file = key && pkg.files.get(key);
      if (file && (file.kind === 'copy' || file.kind === 'translation')) return key.slice(source.length + 1);
      if (pkg.pending.some((x) => !x.ruta.includes('#') && exporter.coincide(x.ruta, `${source}/${p}`))) return p;
    }
    return null;
  };
}

/**
 * El complemento: lo que hay que apilar sobre el público para tener el interno. No escribe nada.
 * Devuelve `{ ok, problem, reason, version, source, sources, entries, same, otherVersion, unpublished, onlyPublic }`;
 * `entries` va en orden por ruta, cada una `{ path, kind: add | overwrite, mode, blob, transform? }`. `otherVersion` son
 * todas las rutas que hacen «capa de otra versión»; `unpublished`, las de ellas que el interno publica y la copia no trae.
 * `publishable` (ruta interna → ruta en la copia, o null) dice qué publica el commit interno; sin él, el exportador.
 * `onlyPublic.problem` dice por qué no se pudo leer qué agrega el exportador sólo a la copia (null si se pudo o no hizo
 * falta); `copyOnly` (patrones) lo da en vez de leerlo de la lista blanca del commit.
 */
function computeLayer({ internalDir, internalCommit = 'HEAD', publicDir, publicCommit = 'HEAD',
  publicWins = DEFAULT_LISTS.publicWins, publicOnly = DEFAULT_LISTS.publicOnly, sourceLabel = null, publishable = null, copyOnly = null } = {}) {
  const iCommit = resolveCommit(internalDir, internalCommit);
  const pCommit = resolveCommit(publicDir, publicCommit);
  const wins = matcher(Array.isArray(publicWins) ? publicWins : loadPatterns(publicWins));
  const source = { name: SOURCE_NAME, commit: iCommit, label: sourceLabel || labelOf(internalDir) };
  const sources = [{ name: TREE_SOURCE_NAME, commit: pCommit }, { name: SOURCE_NAME, commit: iCommit }];
  const base = { version: null, source, sources, entries: [], same: [], otherVersion: [], unpublished: [], onlyPublic: { declared: [], undeclared: [], problem: null } };

  const pub = readPublicVersion(publicDir, pCommit);
  if (!pub.ok) return Object.assign(base, { ok: false, problem: pub.problem, reason: pub.reason, version: pub.version || null });
  base.version = pub.version;

  const internal = readTree(internalDir, iCommit);
  const outside = outsideMatcher({ internalDir, internalCommit: iCommit, publicOnly, copyOnly, tree: internal });
  const published = readTree(publicDir, pCommit);
  for (const p of [...internal.keys()].sort()) {
    const e = internal.get(p);
    const there = published.get(p);
    if (!there) { base.entries.push({ path: p, kind: 'add', mode: e.mode, blob: e.blob }); continue; }
    if (there.blob === e.blob || wins(p)) { base.same.push(p); continue; }
    if (pub.transformed.has(p)) base.entries.push({ path: p, kind: 'overwrite', mode: e.mode, blob: e.blob, transform: pub.transformed.get(p) });
    else base.otherVersion.push(p);
  }
  for (const p of [...published.keys()].sort()) {
    if (internal.has(p)) continue;
    (outside(p) ? base.onlyPublic.declared : base.onlyPublic.undeclared).push(p);
  }
  base.onlyPublic.problem = outside.problem;
  // la otra mitad (AC 5): un agregado que el commit interno publica y la copia no trae. Sólo si la primera pasó: la
  // clasificación lee la lista blanca del commit, y una capa ya de otra versión no la necesita
  const adds = base.entries.filter((e) => e.kind === 'add');
  if (!base.otherVersion.length && adds.length) {
    let publishes = publishable;
    try {
      if (!publishes) publishes = exporterPublishable(internalDir, iCommit);
      for (const e of adds) {
        const there = publishes(e.path);
        if (there && !published.has(there)) base.unpublished.push(e.path);
      }
    } catch (e) {
      return Object.assign(base, { ok: false, problem: 'unclassified',
        reason: `no pude saber qué publica el commit interno ${iCommit.slice(0, 7)} (${String(e.message).split('\n')[0]}): la capa no se apila` });
    }
    base.otherVersion.push(...base.unpublished);
  }
  if (base.otherVersion.length) {
    const said = (p) => (base.unpublished.includes(p) ? `${p} (el interno la publica y la copia no la trae)` : p);
    return Object.assign(base, { ok: false, problem: 'other-version', reason: `capa de otra versión: ${base.otherVersion.map(said).join(', ')}` });
  }
  return Object.assign(base, { ok: true, problem: null, reason: null });
}

/** Cómo se nombra la fuente en el bloque de exclude: su `origin` si tiene; si no, la carpeta. */
function labelOf(dir) {
  try { const url = git(dir, ['config', '--get', 'remote.origin.url']).trim(); if (url) return url; } catch (_) { /* sin origin */ }
  return path.resolve(dir);
}

/** La lista que recibe el apilador, en texto canónico: mismos commits → mismos bytes. */
function serializeList(result) {
  const list = {
    schema: SCHEMA,
    version: result.version,
    source: { name: result.source.name, commit: result.source.commit, label: result.source.label },
    sources: result.sources.map((s) => ({ name: s.name, commit: s.commit })),
    entries: [...result.entries].sort(byPath).map((e) => {
      const o = { path: e.path, kind: e.kind, mode: e.mode, blob: e.blob };
      if (e.transform) o.transform = e.transform;
      return o;
    }),
  };
  return `${JSON.stringify(list, null, 2)}\n`;
}

// ── apilar ───────────────────────────────────────────────────────────────────────────────────────

/** Lee los blobs con UN proceso `git cat-file --batch`: Map blob → Buffer. Tira si falta alguno. */
function readBlobs(gitDir, blobs) {
  const out = new Map();
  if (!blobs.length) return out;
  const buf = git(gitDir, ['cat-file', '--batch'], { input: `${blobs.join('\n')}\n`, binary: true });
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.slice(at, nl).toString('utf8').split(' ');
    at = nl + 1;
    if (header[1] === 'missing') throw new LayerError(`el clon de lectura no tiene el blob ${header[0]}: la capa no se apila`);
    if (header[1] !== 'blob') throw new LayerError(`${header[0]} no es un archivo (${header[1]}): la capa no se apila`);
    const size = Number(header[2]);
    out.set(header[0], buf.slice(at, at + size));
    at += size + 1;
  }
  for (const b of blobs) if (!out.has(b)) throw new LayerError(`git cat-file no devolvió el blob ${b}: la capa no se apila`);
  return out;
}

/** Escribe un archivo atómico (temporal al lado + rename) con el modo dado; tres intentos si Windows lo tiene ocupado. */
function writeFileAtomic(file, buf, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tycon-layer-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, buf, { mode });
    fs.chmodSync(tmp, mode);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nada */ } throw e; }
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!(e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') || attempt === 3) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nada */ }
        throw e;
      }
      nap(50 * attempt);
    }
  }
}

const fsMode = (mode) => (mode === MODE_EXEC ? 0o755 : 0o644);
const isExec = (st) => (st.mode & 0o111) !== 0;

/** Lo que git sigue en el árbol: Map ruta → blob del índice. */
function trackedInTree(tree) {
  const out = new Map();
  for (const line of git(tree, ['ls-files', '-s', '-z']).split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    out.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[1]);
  }
  return out;
}

/** Una ruta como patrón literal de gitignore, anclada a la raíz. */
function excludeLine(p) {
  let s = p.replace(/[\\*?[\]]/g, '\\$&');
  s = s.replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
  return `/${s}`;
}

/** Las líneas del bloque: la carpeta privada más alta que git no sigue, o el archivo suelto si su carpeta es pública. */
function excludeLines(paths, tracked) {
  const trackedDirs = new Set();
  for (const p of tracked.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) trackedDirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const lines = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    let line = null;
    for (let i = 1; i < parts.length; i++) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      if (!trackedDirs.has(dir)) { line = excludeLine(dir); break; }
    }
    lines.add(line || excludeLine(p));
  }
  return [...lines].sort();
}

/**
 * El texto nuevo de info/exclude: el bloque reemplazado en su lugar (o agregado al final); lo de afuera, byte a byte.
 * El inicio y el fin se reconocen sin mirar el final de línea ni los espacios del final (un editor de Windows deja
 * CRLF); el bloque nuevo usa el final de línea que ya tiene el archivo. Dos bloques completos (lo que dejaba la
 * versión anterior con CRLF) quedan en uno, en el lugar del primero. Un inicio sin su fin antes del próximo inicio o
 * del final del archivo tira: no se adivina dónde termina, para no comerse líneas de la persona.
 */
function withBlock(text, block, where = 'info/exclude') {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const bare = (l) => l.replace(/\s+$/, '');
  const isBegin = (l) => bare(l).startsWith(BLOCK_BEGIN_MARK);
  const isEnd = (l) => bare(l) === BLOCK_END;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isBegin(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !isBegin(lines[j]) && !isEnd(lines[j])) j++;
    if (j >= lines.length || !isEnd(lines[j])) {
      throw new LayerError(`el bloque «${BLOCK_BEGIN_MARK}» de ${where} empieza en la línea ${i + 1} y no cierra con «${BLOCK_END}»: `
        + 'no sé dónde termina y no toco tus líneas; agregá el cierre (o borrá el bloque entero) y volvé a correr. No se escribió nada');
    }
    blocks.push([i, j]);
    i = j;
  }
  const fresh = block.map((l) => `${l}${eol}`);
  if (!blocks.length) {
    if (!block.length) return text;
    const head = text === '' ? '' : text.endsWith('\n') ? text : `${text}${eol}`;
    return `${head}${fresh.join('')}`;
  }
  const out = [];
  let at = 0;
  blocks.forEach(([b, e], k) => {
    out.push(...lines.slice(at, b));
    if (k === 0) out.push(...fresh);
    at = e + 1;
  });
  out.push(...lines.slice(at));
  return out.join('');
}

/**
 * ¿Es una ruta de la capa que no sale del árbol? La regla es UNA para todo lo que llega de afuera y termina en una ruta
 * del árbol: la lista nueva (`readList`) y el manifiesto de la corrida anterior (`readManifest`, y `readLayerManifest`
 * de harness.js). Las rutas de git usan siempre «/»: una «\» o un «:» (una unidad de Windows, «C:x») no son de git y en
 * Windows sacarían la escritura (o el borrado) del árbol; «..», «.» y un tramo vacío tampoco; «.git» se compara sin
 * mayúsculas porque en Windows es la misma carpeta; una absoluta, nunca.
 */
function isSafeLayerPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (path.isAbsolute(p) || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /[\\:]/.test(p)) return false;
  return !p.split('/').some((x) => x === '..' || x === '.' || x === '' || x.toLowerCase() === '.git');
}
/** Cómo se nombra en un mensaje lo que no es una ruta (una entrada sin `path`, un número): tal cual si es texto. */
const shownPath = (f) => (f && typeof f.path === 'string' ? f.path : JSON.stringify(f && f.path !== undefined ? f.path : f));

function readManifest(file) {
  if (!file || !lstat(file)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new LayerError(`el manifiesto ${file} no se puede leer (${e.message})`); }
  if (!data || !Array.isArray(data.files)) throw new LayerError(`el manifiesto ${file} no trae «files»`);
  // sus rutas terminan en un borrado, una escritura o un checkout (lo que salió de la lista): la misma regla que la
  // lista, antes de tocar nada (revisión del paso 5, vuelta 2)
  for (const f of data.files) if (!isSafeLayerPath(f && f.path)) throw new LayerError(`ruta inválida en el manifiesto de la capa: ${shownPath(f)} (${file})`);
  return data;
}

function readList(list) {
  const data = typeof list === 'string' ? (() => {
    try { return JSON.parse(fs.readFileSync(list, 'utf8')); } catch (e) { throw new LayerError(`no pude leer la lista ${list} (${e.code || e.message})`); }
  })() : list;
  if (!data || !Array.isArray(data.entries) || !data.source || typeof data.source.name !== 'string') {
    throw new LayerError('la lista de la capa no trae «entries» ni «source»');
  }
  for (const e of data.entries) {
    if (!e || typeof e.path !== 'string' || !e.path || !/^[0-9a-f]{40,64}$/.test(String(e.blob)) || !['add', 'overwrite'].includes(e.kind)) {
      throw new LayerError(`entrada inválida en la lista de la capa: ${JSON.stringify(e)}`);
    }
    if (!isSafeLayerPath(e.path)) throw new LayerError(`ruta inválida en la lista de la capa: ${e.path}`);
  }
  return data;
}

/**
 * Apila una lista sobre el árbol. `{ tree, from, list, manifest, writers, platform }`: `from` es el repo de donde salen
 * los blobs (el clon de lectura), `list` la lista (objeto o ruta), `manifest` la ruta de layer.json.
 * Devuelve `{ ok, code, refused, written, unchanged, removed, restored, released, handEdited, held, writersWritten,
 * manifestChanged, excludeChanged, nothing }`: `restored`, los pisados que salieron de la lista y volvieron al contenido
 * público; `held`, lo que salió de la lista y quedó (editado a mano), también contado en `handEdited`. Con un enlace o
 * un submódulo en la lista, `ok: false`, `code: 2` y nada escrito; con el bloque de exclude roto, tira sin escribir.
 */
function applyLayer({ tree, from, list, manifest, writers = DEFAULT_LISTS.writers, platform = process.platform } = {}) {
  const data = readList(list);
  const refused = data.entries.filter((e) => e.mode === MODE_SYMLINK || e.mode === MODE_SUBMODULE)
    .map((e) => ({ path: e.path, what: e.mode === MODE_SYMLINK ? 'un enlace simbólico' : 'un submódulo' }));
  const result = { ok: true, code: 0, refused, written: [], unchanged: [], removed: [], restored: [], released: [], handEdited: [], held: [],
    writersWritten: [], manifestChanged: false, excludeChanged: false, nothing: false };
  if (refused.length) return Object.assign(result, { ok: false, code: 2 });
  for (const e of data.entries) {
    if (e.mode !== MODE_FILE && e.mode !== MODE_EXEC) throw new LayerError(`${e.path}: modo ${e.mode} que la capa no sabe escribir`);
  }

  const isWriter = matcher(Array.isArray(writers) ? writers : loadPatterns(writers));
  const checkMode = platform !== 'win32';
  const previous = readManifest(manifest);
  const prevFiles = new Map((previous ? previous.files : []).map((f) => [f.path, f]));
  const tracked = trackedInTree(tree);
  const files = [];          // el manifiesto nuevo
  const toWrite = [];        // { entry, file }
  const toChmod = [];

  for (const e of data.entries) {
    const file = path.join(tree, ...e.path.split('/'));
    const st = lstat(file);
    if (isWriter(e.path)) {
      if (!st) { toWrite.push({ entry: e, file, writer: true }); }
      continue;
    }
    const prev = prevFiles.get(e.path);
    const record = { path: e.path, source: data.source.name, kind: e.kind, blob: e.blob, mode: e.mode, sha256: null };
    if (!st) { toWrite.push({ entry: e, file, record }); files.push(record); continue; }
    if (!st.isFile()) { result.handEdited.push(e.path); if (prev) files.push(unheld(prev)); continue; }
    const disk = fs.readFileSync(file);
    const diskSha = sha256(disk);
    if (gitBlobId(disk, e.blob) === e.blob) {
      record.sha256 = diskSha;
      files.push(record);
      if (checkMode && isExec(st) !== (e.mode === MODE_EXEC)) toChmod.push({ path: e.path, file, mode: fsMode(e.mode) });
      else result.unchanged.push(e.path);
      continue;
    }
    const ours = (prev && prev.sha256 === diskSha) || (e.kind === 'overwrite' && tracked.get(e.path) === gitBlobId(disk, e.blob));
    if (ours) { toWrite.push({ entry: e, file, record }); files.push(record); continue; }
    result.handEdited.push(e.path);
    if (prev) files.push(unheld(prev));
  }

  // lo que dejó de estar en la lista. Lo editado a mano no se toca y queda en el manifiesto marcado (`held`): así se
  // sigue avisando en cada corrida (y en verify) hasta que la persona lo resuelve, aunque su carpeta siga excluida
  const inList = new Set(data.entries.map((e) => e.path));
  const dropped = [...prevFiles.values()].filter((f) => !inList.has(f.path));
  const toRemove = [];
  const toRestore = [];
  const hold = (prev) => { result.handEdited.push(prev.path); result.held.push(prev.path); files.push(Object.assign({}, prev, { held: true })); };
  // un pisado que git sigue: ¿ya está como el público? (`git diff` contra el índice, con los filtros de git; una sola vez)
  const overwritten = dropped.filter((f) => f.kind === 'overwrite' && tracked.has(f.path)).map((f) => f.path);
  const differs = new Set(overwritten.length
    ? git(tree, ['diff', '--name-only', '-z', '--', ...overwritten.map(literalPathspec)]).split('\0').filter(Boolean) : []);
  for (const prev of dropped) {
    const file = path.join(tree, ...prev.path.split('/'));
    const st = lstat(file);
    const ownContent = () => Boolean(st) && st.isFile() && sha256(fs.readFileSync(file)) === prev.sha256;
    if (prev.kind === 'overwrite' && tracked.has(prev.path)) {
      if (!differs.has(prev.path)) result.released.push(prev.path);   // ya está como el público: sólo sale del manifiesto
      else if (ownContent()) toRestore.push(prev.path);              // con lo que dejó la capa: vuelve al público
      else hold(prev);                                               // editado (o borrado) a mano
      continue;
    }
    if (tracked.has(prev.path)) { result.released.push(prev.path); continue; }   // pasó a ser pública: el archivo queda
    if (!st) continue;
    if (ownContent()) toRemove.push({ path: prev.path, file });
    else hold(prev);
  }

  // el bloque de exclude: lo agregado que git no sigue en el árbol. Se arma antes de escribir: un bloque roto frena acá
  const added = data.entries.filter((e) => e.kind === 'add' && !tracked.has(e.path)).map((e) => e.path);
  const lines = excludeLines(added, tracked);
  const block = lines.length ? [BLOCK_BEGIN, `# fuente: ${data.source.name} (${data.source.label || 'sin nombre'})`, ...lines, BLOCK_END] : [];
  const excludeFile = path.resolve(tree, git(tree, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const oldExclude = lstat(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const newExclude = withBlock(oldExclude, block, excludeFile);

  // todo lo que hay que leer, antes de escribir nada: un blob que falta frena acá
  const blobs = readBlobs(from, [...new Set(toWrite.map((w) => w.entry.blob))]);

  // lo que vuelve al público va PRIMERO: es lo único que escribe git y puede fallar por algo de afuera (otra sesión con
  // el índice tomado). Si falla acá, no se escribió nada más y el manifiesto queda como estaba (revisión del paso 5,
  // vuelta 2: antes corría después de los agregados, y lo ya escrito quedaba sin manifiesto que lo dijera)
  if (toRestore.length) {
    git(tree, ['checkout', '-q', '--', ...toRestore.map(literalPathspec)]);
    result.restored.push(...toRestore);
  }
  for (const w of toWrite) {
    const buf = blobs.get(w.entry.blob);
    writeFileAtomic(w.file, buf, fsMode(w.entry.mode));
    if (w.writer) result.writersWritten.push(w.entry.path);
    else { w.record.sha256 = sha256(buf); result.written.push(w.entry.path); }
  }
  for (const c of toChmod) { fs.chmodSync(c.file, c.mode); result.written.push(c.path); }
  for (const r of toRemove) { fs.rmSync(r.file, { force: true }); removeEmptyParents(tree, r.file); result.removed.push(r.path); }

  if (newExclude !== oldExclude) { writeFileAtomic(excludeFile, Buffer.from(newExclude, 'utf8'), 0o644); result.excludeChanged = true; }

  // el manifiesto
  const text = `${JSON.stringify({
    schema: SCHEMA,
    version: data.version || null,
    sources: (data.sources || [{ name: data.source.name, commit: data.source.commit }]).map((s) => ({ name: s.name, commit: s.commit })),
    files: files.sort(byPath).map((f) => Object.assign({ path: f.path, source: f.source, kind: f.kind, blob: f.blob, mode: f.mode, sha256: f.sha256 },
      f.held ? { held: true } : {})),
  }, null, 2)}\n`;
  const oldText = manifest && lstat(manifest) ? fs.readFileSync(manifest, 'utf8') : null;
  if (text !== oldText) { writeFileAtomic(manifest, Buffer.from(text, 'utf8'), 0o644); result.manifestChanged = true; }

  result.handEdited.sort();
  result.held.sort();
  result.nothing = !result.written.length && !result.removed.length && !result.restored.length && !result.writersWritten.length
    && !result.manifestChanged && !result.excludeChanged;
  return result;
}

/** Una ruta como pathspec literal de git (sin comodines): `:(literal)ruta`. */
const literalPathspec = (p) => `:(literal)${p}`;
/** Un registro del manifiesto sin la marca `held` (la ruta volvió a la lista). */
const unheld = (f) => { const o = Object.assign({}, f); delete o.held; return o; };

/** Saca las carpetas que quedaron vacías al borrar un archivo, sin salir del árbol. */
function removeEmptyParents(tree, file) {
  const root = path.resolve(tree);
  for (let dir = path.dirname(path.resolve(file)); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try { if (fs.readdirSync(dir).length) return; fs.rmdirSync(dir); } catch (_) { return; }
  }
}

// ── verificar ────────────────────────────────────────────────────────────────────────────────────

/** El árbol contra el manifiesto, sin escribir nada: `{ ok, present, missing, handEdited, modeMismatch, held, files }`.
 *  `held`: lo que dejó de ser de la capa y quedó porque está editado a mano; mientras esté, la capa no está entera. */
function verifyLayer({ tree, manifest, platform = process.platform } = {}) {
  const data = readManifest(manifest);
  if (!data) return { ok: false, present: false, missing: [], handEdited: [], modeMismatch: [], held: [], files: 0 };
  const out = { ok: true, present: true, missing: [], handEdited: [], modeMismatch: [], held: [], files: data.files.length };
  for (const f of data.files) {
    if (f.held) { out.held.push(f.path); continue; }
    const file = path.join(tree, ...f.path.split('/'));
    const st = lstat(file);
    if (!st) { out.missing.push(f.path); continue; }
    if (!st.isFile() || sha256(fs.readFileSync(file)) !== f.sha256) { out.handEdited.push(f.path); continue; }
    if (platform !== 'win32' && isExec(st) !== (f.mode === MODE_EXEC)) out.modeMismatch.push(f.path);
  }
  out.ok = !out.missing.length && !out.handEdited.length && !out.modeMismatch.length && !out.held.length;
  return out;
}

// ── línea de comandos ────────────────────────────────────────────────────────────────────────────

const USAGE = [
  'uso: layer.js compute --internal <repo> [--internal-commit <rev>] --public <repo> [--public-commit <rev>]',
  '                      [--public-wins <lista>] [--public-only <lista>] [--source-label <nombre>] [--out <archivo>] [--json]',
  '     layer.js apply --tree <árbol> --from <repo> --list <archivo> --manifest <layer.json> [--writers <lista>] [--json]',
  '     layer.js verify --tree <árbol> --manifest <layer.json> [--json]',
].join('\n');

function parseArgs(argv) {
  const opts = { json: false };
  const valued = { '--internal': 'internal', '--internal-commit': 'internalCommit', '--public': 'public', '--public-commit': 'publicCommit',
    '--public-wins': 'publicWins', '--public-only': 'publicOnly', '--source-label': 'sourceLabel', '--out': 'out', '--tree': 'tree',
    '--from': 'from', '--list': 'list', '--manifest': 'manifest', '--writers': 'writers' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (valued[a]) { const v = argv[++i]; if (v === undefined) throw new LayerError(`${a} necesita un valor\n${USAGE}`); opts[valued[a]] = v; }
    else throw new LayerError(`opción desconocida: ${a}\n${USAGE}`);
  }
  return opts;
}

function need(opts, keys) {
  const missing = keys.filter((k) => !opts[k]);
  if (missing.length) throw new LayerError(`falta ${missing.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')}\n${USAGE}`);
}

function cli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (s) => stdout.write(`${s}\n`);
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));
  if (cmd === 'compute') {
    need(opts, ['internal', 'public']);
    const r = computeLayer({ internalDir: opts.internal, internalCommit: opts.internalCommit, publicDir: opts.public, publicCommit: opts.publicCommit,
      publicWins: opts.publicWins, publicOnly: opts.publicOnly, sourceLabel: opts.sourceLabel });
    if (r.ok && opts.out) writeFileAtomic(path.resolve(opts.out), Buffer.from(serializeList(r), 'utf8'), 0o644);
    if (opts.json) { say(JSON.stringify(Object.assign({}, r, { add: r.entries.filter((e) => e.kind === 'add').map((e) => e.path),
      overwrite: r.entries.filter((e) => e.kind === 'overwrite').map((e) => e.path) }), null, 2)); return r.ok ? 0 : 1; }
    if (!r.ok) {
      stderr.write(`layer: ${r.reason}\n`);
      for (const p of r.otherVersion) stderr.write(`  capa de otra versión: ${p}\n`);
      return 1;
    }
    const add = r.entries.filter((e) => e.kind === 'add').length;
    say(`capa: ${add} agregados, ${r.entries.length - add} pisados (transformados), ${r.same.length} iguales`);
    for (const p of r.onlyPublic.undeclared) say(`  sólo en el público y sin declarar en layer-public-only.json: ${p}`);
    if (r.onlyPublic.problem) say(`  ${r.onlyPublic.problem}`);
    return 0;
  }
  if (cmd === 'apply') {
    need(opts, ['tree', 'from', 'list', 'manifest']);
    const r = applyLayer({ tree: path.resolve(opts.tree), from: opts.from, list: opts.list, manifest: path.resolve(opts.manifest),
      writers: opts.writers || DEFAULT_LISTS.writers });
    if (opts.json) { say(JSON.stringify(r, null, 2)); return r.code; }
    if (!r.ok) {
      for (const x of r.refused) stderr.write(`layer: ${x.path} es ${x.what} en git: la capa nunca crea enlaces; no se escribió nada\n`);
      return r.code;
    }
    if (r.nothing) say('capa: nada que escribir (ya estaba apilada)');
    else say(`capa: ${r.written.length} escritos, ${r.removed.length} borrados, ${r.restored.length} volvieron al público, ${r.released.length} pasaron a ser públicos, ${r.writersWritten.length} de escritores`);
    const held = new Set(r.held);
    for (const p of r.handEdited) {
      say(held.has(p) ? `  ya no es de la capa y está editado a mano, no lo toco: ${p} (borralo o devolvelo a como estaba y el aviso se va)`
        : `  editado a mano, no lo toco: ${p}`);
    }
    return 0;
  }
  if (cmd === 'verify') {
    need(opts, ['tree', 'manifest']);
    const r = verifyLayer({ tree: path.resolve(opts.tree), manifest: path.resolve(opts.manifest) });
    if (opts.json) { say(JSON.stringify(r, null, 2)); return !r.present ? 3 : r.ok ? 0 : 1; }
    if (!r.present) { say('capa: no hay manifiesto (sin capa)'); return 3; }
    if (r.ok) { say(`capa: ${r.files} archivos, todo en su lugar`); return 0; }
    for (const p of r.missing) say(`  falta: ${p}`);
    for (const p of r.handEdited) say(`  editado a mano: ${p}`);
    for (const p of r.modeMismatch) say(`  con otro modo: ${p}`);
    for (const p of r.held) say(`  ya no es de la capa y quedó editado a mano: ${p}`);
    return 1;
  }
  throw new LayerError(USAGE);
}

if (require.main === module) {
  let code;
  try { code = cli(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`layer: ${e.message}\n`);
    code = e instanceof LayerError ? e.code : 2;
  }
  process.exit(code);
}

module.exports = {
  SCHEMA, SOURCE_NAME, MODE_SYMLINK, MODE_SUBMODULE, BLOCK_BEGIN, BLOCK_END, NO_TRANSFORMED, DEFAULT_LISTS,
  computeLayer, serializeList, applyLayer, verifyLayer, outsideMatcher, copyOnlyPatterns,
  readTree, readPublicVersion, loadPatterns, patternRegex, matcher, gitBlobId, excludeLines, isSafeLayerPath, cli, LayerError,
};
