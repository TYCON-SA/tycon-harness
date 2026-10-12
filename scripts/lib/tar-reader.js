'use strict';
// tar-reader.js — el lector propio de comprimidos `.tar.gz` del mecanismo de instalación (story 8.23, tanda B · AC 10).
//
// ── POR QUÉ UNO PROPIO (revisión I4, 2026-10-06) ─────────────────────────────────────────────────────────────────
// El `tar` del sistema escribe enlaces y rutas con `../` antes de que nadie pueda rechazarlos. Acá el comprimido se lee
// ENTERO en memoria (el del arnés: 6,6 MB comprimido, 24 MB abierto), se juzga cada entrada, y recién si TODAS pasan se
// escribe algo. Y el modo de cada archivo sale de la CABECERA, nunca del disco: Windows no guarda el bit de ejecutable
// (medición del 2026-10-07: 162 archivos `100755` leídos del disco como `100644` daban otro árbol).
//
// ── QUÉ ENTIENDE ─────────────────────────────────────────────────────────────────────────────────────────────────
//   · `ustar` (nombre + `prefix`), las cabeceras extendidas de pax (`x` por archivo: `path`, `linkpath`, `size`; `g`
//     global: la de GitHub trae el commit en `comment`) y los nombres largos de GNU (`L`, `K`).
//   · Tipos: archivo (`0`, `\0`, `7`), carpeta (`5`). Lo demás —enlace simbólico (`2`), duro (`1`), dispositivo (`3`,
//     `4`), fifo (`6`), otros— se RECHAZA, nombrando la primera entrada de cada clase.
//   · Rutas: después de quitar la carpeta raíz, la misma regla de `isSafeLayerPath` (scripts/setup/harness/layer.js,
//     copiada acá porque esto vive en scripts/lib/): relativas, sin `..`, sin `.`, sin tramos vacíos, sin `\` ni `:`,
//     sin `.git`. Lo que la rompe «sale del destino» y se rechaza.
//   · `stripRoot`: el comprimido de GitHub trae todo bajo `<org>-<repo>-<sha7>/`; esa carpeta se descarta y tiene que
//     ser UNA (todas las entradas bajo la misma); si no, es un error.
//
// ── QUÉ DEVUELVE ─────────────────────────────────────────────────────────────────────────────────────────────────
// `extractTarGz(gzBuffer, destDir, { stripRoot })` → `{ ok: true, root, globalHeader, manifest }` con el manifiesto
// `[{ path, mode, blob }]` (ordenado por ruta; `blob` = sha de git del contenido), o `{ ok: false, reason }` SIN haber
// escrito nada. `treeOf(manifest)` da el árbol de git. Nunca tira por el contenido del comprimido: lo dice en `reason`.
//
// Sin dependencias: `zlib`, `fs`, `path`, `crypto` (vía git-tree-hash.js).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { blobSha, treeSha } = require('./git-tree-hash.js');

const BLOCK = 512;
const FILE_TYPES = new Set(['0', '\0', '7']);
const TYPE_NAMES = Object.freeze({ '1': 'enlace duro', '2': 'enlace simbólico', '3': 'dispositivo', '4': 'dispositivo', '6': 'fifo' });

class TarError extends Error {
  constructor(message) { super(message); this.name = 'TarError'; }
}

/** La regla de `isSafeLayerPath` (layer.js): relativa, sin tramos raros, sin `.git`. */
function isSafePath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (path.isAbsolute(p) || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /[\\:]/.test(p)) return false;
  return !p.split('/').some((x) => x === '..' || x === '.' || x === '' || x.toLowerCase() === '.git');
}

const str = (buf, off, len) => { const s = buf.subarray(off, off + len); const z = s.indexOf(0); return (z >= 0 ? s.subarray(0, z) : s).toString('utf8'); };
const oct = (buf, off, len) => { const t = str(buf, off, len).trim(); if (!t) return 0; const n = parseInt(t, 8); return Number.isFinite(n) ? n : 0; };
const isZero = (buf, off) => { for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false; return true; };

/** Los registros `<largo> <clave>=<valor>\n` de una cabecera pax. */
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(i, sp).toString('latin1'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');   // sin el `\n` final
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Las entradas de un tar en memoria: `[{ path, type, mode, size, content, linkname }]` y la cabecera global.
 * Un tar cortado (una cabecera o un cuerpo que no llegan enteros, o sin su cierre) tira TarError.
 */
function parseTar(buf) {
  const entries = [];
  let globalHeader = {};
  let pending = {};          // lo que una cabecera `x`, `L` o `K` deja para la entrada siguiente
  let off = 0;
  let closed = false;
  while (off + BLOCK <= buf.length) {
    if (isZero(buf, off)) { closed = true; break; }   // el primer bloque de ceros: el final
    const h = buf.subarray(off, off + BLOCK);
    const type = String.fromCharCode(h[156]) === '\0' ? '\0' : String.fromCharCode(h[156]);
    const magic = str(h, 257, 6);
    let name = str(h, 0, 100);
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const size = pending.size !== undefined ? pending.size : oct(h, 124, 12);
    const bodyStart = off + BLOCK;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buf.length) throw new TarError(`el comprimido está cortado: la entrada «${pending.path || name}» declara ${size} bytes y faltan ${bodyEnd - buf.length}`);
    const body = buf.subarray(bodyStart, bodyEnd);
    off = bodyStart + size + (size % BLOCK ? BLOCK - (size % BLOCK) : 0);
    if (type === 'g') { Object.assign(globalHeader, parsePax(body)); continue; }
    if (type === 'x') { const p = parsePax(body); pending = Object.assign(pending, { path: p.path, linkname: p.linkpath, size: p.size !== undefined ? parseInt(p.size, 10) : undefined }); delete pending.size; if (p.size !== undefined) pending.size = parseInt(p.size, 10); continue; }
    if (type === 'L') { pending.path = str(body, 0, body.length); continue; }
    if (type === 'K') { pending.linkname = str(body, 0, body.length); continue; }
    entries.push({
      path: pending.path !== undefined ? pending.path : name,
      type,
      mode: oct(h, 100, 8),
      size,
      content: FILE_TYPES.has(type) ? body : null,
      linkname: pending.linkname !== undefined ? pending.linkname : str(h, 157, 100),
    });
    pending = {};
  }
  if (!closed) throw new TarError('el comprimido está cortado: no trae su bloque de cierre');
  return { entries, globalHeader };
}

/** Descomprime y lee; un gzip ilegible o cortado es TarError. */
function parseTarGz(gzBuffer) {
  let raw;
  try { raw = zlib.gunzipSync(gzBuffer); } catch (e) { throw new TarError(`el comprimido está cortado o ilegible (${e.code || e.message})`); }
  return parseTar(raw);
}

/**
 * Juzga las entradas ANTES de escribir: la raíz común (si `stripRoot`), los tipos, las rutas. Devuelve
 * `{ ok: true, root, files: [{ path, mode, content }], dirs }` o `{ ok: false, reason }`.
 */
function plan(entries, { stripRoot = true, only = null } = {}) {
  let normalized = entries.map((e) => Object.assign({}, e, { path: e.path.replace(/\/+$/, '') }));
  // `only`: una subcarpeta (relativa a la raíz quitada): lo demás del comprimido no se juzga ni se escribe. Así una skill de
  // terceros se restituye aunque su repo traiga un enlace en otra carpeta (pase adversarial de la 8.23 B: 47 de 70 skills
  // quedaban afuera por enlaces de BMAD y de vercel fuera de su ruta)
  if (only) {
    const prefix = `${String(only).replace(/^\/+|\/+$/g, '')}/`;
    normalized = normalized.filter((e) => {
      const rel = stripRoot ? e.path.split('/').slice(1).join('/') : e.path;
      return rel === prefix.slice(0, -1) || rel.startsWith(prefix) || (stripRoot && !e.path.includes('/'));
    });
  }
  // una ruta absoluta o con `..` se rechaza tal cual, antes de buscar la raíz: no es «otra raíz», es una salida
  const escapes = normalized.filter((e) => path.isAbsolute(e.path) || path.posix.isAbsolute(e.path) || path.win32.isAbsolute(e.path) || e.path.split('/').includes('..'));
  if (escapes.length) return { ok: false, reason: `el comprimido trae lo que no se escribe (${escapes.length}): ${escapes.slice(0, 5).map((e) => `sale del destino: ${e.path}`).join(' · ')}` };
  let root = null;
  let items = normalized;
  if (stripRoot) {
    const heads = new Set(normalized.map((e) => e.path.split('/')[0]));
    if (heads.size !== 1) return { ok: false, reason: `el comprimido no trae UNA carpeta raíz (trae ${heads.size}: ${[...heads].slice(0, 3).join(', ')}): no sé qué quitar` };
    root = [...heads][0];
    if (!root || root === '..' || root === '.') return { ok: false, reason: `la carpeta raíz del comprimido no sirve («${root}»)` };
    items = normalized.filter((e) => e.path !== root).map((e) => Object.assign({}, e, { path: e.path.slice(root.length + 1) }));
  }
  const refused = [];
  const files = [];
  const dirs = [];
  for (const e of items) {
    const kind = TYPE_NAMES[e.type];
    if (kind) { refused.push(`${kind}: ${e.path}`); continue; }
    if (!FILE_TYPES.has(e.type) && e.type !== '5') { refused.push(`entrada de tipo «${e.type}»: ${e.path}`); continue; }
    if (!isSafePath(e.path)) { refused.push(/(^|\/)\.git(\/|$)/i.test(e.path) ? `bajo .git: ${e.path}` : `sale del destino: ${e.path}`); continue; }
    if (e.type === '5') dirs.push(e.path);
    else files.push({ path: e.path, mode: (e.mode & 0o111) ? '100755' : '100644', content: e.content });
  }
  if (refused.length) return { ok: false, reason: `el comprimido trae lo que no se escribe (${refused.length}): ${refused.slice(0, 5).join(' · ')}${refused.length > 5 ? ' …' : ''}` };
  return { ok: true, root, files, dirs };
}

/**
 * Lee, juzga y recién entonces escribe en `destDir` (que tiene que existir y estar vacío, o se crea). Devuelve el
 * manifiesto con el modo DE LA CABECERA. Si algo falla al escribir, lo que alcanzó a escribir se borra.
 */
function extractTarGz(gzBuffer, destDir, { stripRoot = true, only = null } = {}) {
  let parsed;
  try { parsed = parseTarGz(gzBuffer); } catch (e) { return { ok: false, reason: e.message }; }
  const p = plan(parsed.entries, { stripRoot, only });
  if (!p.ok) return p;
  const written = [];
  try {
    fs.mkdirSync(destDir, { recursive: true });
    for (const d of p.dirs) fs.mkdirSync(path.join(destDir, ...d.split('/')), { recursive: true });
    for (const f of p.files) {
      const abs = path.join(destDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
      if (process.platform !== 'win32') { try { fs.chmodSync(abs, f.mode === '100755' ? 0o755 : 0o644); } catch (_) { /* el modo del disco no decide nada */ } }
      written.push(abs);
    }
  } catch (e) {
    for (const w of written) { try { fs.rmSync(w, { force: true }); } catch (_) { /* queda; lo dice el error */ } }
    return { ok: false, reason: `no pude escribir en ${destDir}: ${e.message}` };
  }
  const manifest = p.files.map((f) => ({ path: f.path, mode: f.mode, blob: blobSha(f.content) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, root: p.root, globalHeader: parsed.globalHeader, manifest };
}

/** El árbol de git de un manifiesto `[{ path, mode, blob }]`. */
function treeOf(manifest) {
  return treeSha(manifest.map((m) => ({ mode: m.mode, path: m.path, sha: m.blob })));
}

module.exports = { TarError, isSafePath, parseTar, parseTarGz, plan, extractTarGz, treeOf };
