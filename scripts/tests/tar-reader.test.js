'use strict';
/**
 * tar-reader.test.js — el lector propio de comprimidos y el hash del árbol de git (T10, unidad).
 *
 * Instalar sin git baja el comprimido de un commit publicado. Abrirlo con el `tar` del sistema
 * escribe enlaces y rutas con `../` antes de poder rechazarlos, y en Windows el bit de ejecutable no queda
 * en el disco (los archivos `100755` se leerían como `100644`), así que el árbol se calcula con el
 * modo de la CABECERA del tar, nunca del sistema de archivos.
 *
 * Qué fija:
 *   · un comprimido bueno (carpeta raíz + cabecera global pax, como el de GitHub) se extrae sin la raíz, el manifiesto
 *     trae el modo de la cabecera, y su árbol es el que da `git-tree-hash.js` sobre las mismas entradas;
 *   · un archivo cambiado da OTRO árbol (la comparación la hace quien instala);
 *   · un enlace simbólico, un enlace duro, un dispositivo, una ruta con `../`, una absoluta y una bajo `.git/` se
 *     RECHAZAN ANTES de escribir nada: la carpeta destino queda vacía y el error nombra la entrada;
 *   · un nombre de 130 caracteres llega bien por las tres vías (`prefix` de ustar, `x` de pax, `L` de GNU) y uno con
 *     acento también;
 *   · un comprimido cortado a mitad es un error que lo dice, sin carpeta a medias;
 *   · `git-tree-hash.js` es la única definición del hash: `install-third-party.js` lo re-exporta tal cual.
 * 🔴 Nada toca el HOME real: todo en el temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const READER = path.join(ROOT, 'scripts', 'lib', 'tar-reader.js');
const HASH = path.join(ROOT, 'scripts', 'lib', 'git-tree-hash.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── un escritor de tar mínimo, sólo para armar los casos ───────────────────────────────────────────────────────────
function header(fields) {
  const b = Buffer.alloc(512, 0);
  const put = (off, len, v) => b.write(String(v).slice(0, len), off, len, 'utf8');
  const oct = (off, len, n) => put(off, len, n.toString(8).padStart(len - 1, '0'));
  put(0, 100, fields.name || '');
  oct(100, 8, fields.mode === undefined ? 0o644 : fields.mode);
  oct(108, 8, 0); oct(116, 8, 0);
  oct(124, 12, fields.size || 0);
  oct(136, 12, 1700000000);
  put(156, 1, fields.type || '0');
  put(157, 100, fields.linkname || '');
  put(257, 6, 'ustar\0'); put(263, 2, '00');
  put(265, 32, 'tycon'); put(297, 32, 'tycon');
  if (fields.prefix) put(345, 155, fields.prefix);
  // la suma de control, con el campo en blancos
  b.fill(0x20, 148, 156);
  let sum = 0; for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return b;
}
const pad = (n) => (n % 512 ? 512 - (n % 512) : 0);
function entry(fields, content = null) {
  const data = content === null ? Buffer.alloc(0) : Buffer.from(content);
  const parts = [header(Object.assign({ size: data.length }, fields)), data];
  if (pad(data.length)) parts.push(Buffer.alloc(pad(data.length)));
  return Buffer.concat(parts);
}
const paxRecord = (k, v) => { const body = ` ${k}=${v}\n`; let len = Buffer.byteLength(body) + 1; while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`); return `${len}${body}`; };
function tar(entries) { return Buffer.concat([...entries, Buffer.alloc(1024)]); }
const gz = (buf) => zlib.gzipSync(buf);
const ROOT_DIR = 'acme-arnes-0123456';   // como la carpeta raíz que GitHub pone al comprimido: <org>-<repo>-<sha7>
const inRoot = (p) => `${ROOT_DIR}/${p}`;
/** El comprimido «de GitHub»: cabecera global pax con el commit, la carpeta raíz, carpetas y archivos. */
function githubLike(files, extra = []) {
  const out = [entry({ name: 'pax_global_header', type: 'g' }, paxRecord('comment', '0123456789abcdef0123456789abcdef01234567'))];
  out.push(entry({ name: `${ROOT_DIR}/`, type: '5', mode: 0o755 }));
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!dirs.has(d)) { dirs.add(d); out.push(entry({ name: `${inRoot(d)}/`, type: '5', mode: 0o755 })); } }
    out.push(entry({ name: inRoot(f.path), mode: f.mode === '100755' ? 0o755 : 0o644 }, f.content));
  }
  return tar([...out, ...extra]);
}
const FILES = [
  { path: 'README.md', content: '# arnés\n', mode: '100644' },
  { path: 'scripts/setup/harness.js', content: '#!/usr/bin/env node\n', mode: '100755' },
  { path: 'scripts/lib/a.js', content: 'module.exports = 1;\n', mode: '100644' },
  { path: 'guides/ñandú-áéíóú.md', content: 'con acento\n', mode: '100644' },
];

test('T10 · git-tree-hash.js es la única definición del hash; install-third-party.js la re-exporta tal cual', () => {
  const H = require(HASH);
  const TP = require(path.join(ROOT, 'scripts', 'publishing', 'install-third-party.js'));
  assert.strictEqual(TP.treeSha, H.treeSha);
  assert.strictEqual(TP.blobSha, H.blobSha);
  // el blob vacío de git: e69de29b…
  assert.strictEqual(H.blobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  // el árbol de un solo archivo vacío `a` en modo 100644: 496d6428b9cf92981dc9495211e6e1120fb6f2ba
  assert.strictEqual(H.treeSha([{ mode: '100644', path: 'a', sha: H.blobSha(Buffer.alloc(0)) }]), '496d6428b9cf92981dc9495211e6e1120fb6f2ba');
});

test('T10 · un comprimido como el de GitHub se extrae sin la raíz; el manifiesto trae el modo de la cabecera y da el árbol', () => {
  const R = require(READER), H = require(HASH);
  const dest = tmp('tar-good-');
  const r = R.extractTarGz(gz(githubLike(FILES)), dest, { stripRoot: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.root, ROOT_DIR);
  assert.strictEqual(r.globalHeader.comment, '0123456789abcdef0123456789abcdef01234567');
  const got = r.manifest.map((m) => `${m.mode} ${m.path}`).sort();
  assert.deepStrictEqual(got, FILES.map((f) => `${f.mode} ${f.path}`).sort());
  for (const f of FILES) assert.strictEqual(fs.readFileSync(path.join(dest, ...f.path.split('/')), 'utf8'), f.content);
  assert.ok(!fs.existsSync(path.join(dest, ROOT_DIR)), 'la carpeta raíz del comprimido no se escribe');
  const expected = H.treeSha(FILES.map((f) => ({ mode: f.mode, path: f.path, sha: H.blobSha(Buffer.from(f.content)) })));
  assert.strictEqual(R.treeOf(r.manifest), expected);
  // un archivo cambiado: otro árbol
  const changed = FILES.map((f) => (f.path === 'README.md' ? Object.assign({}, f, { content: '# otro\n' }) : f));
  const r2 = R.extractTarGz(gz(githubLike(changed)), tmp('tar-changed-'), { stripRoot: true });
  assert.notStrictEqual(R.treeOf(r2.manifest), expected);
});

test('T10 · el modo sale de la cabecera, no del disco (Windows no guarda el bit de ejecutable)', () => {
  const R = require(READER);
  const dest = tmp('tar-mode-');
  const r = R.extractTarGz(gz(githubLike(FILES)), dest, { stripRoot: true });
  const exec = r.manifest.find((m) => m.path === 'scripts/setup/harness.js');
  assert.strictEqual(exec.mode, '100755');
  // y lo que se escribió en el disco también se lee de la cabecera al armar el manifiesto: una lectura del disco daría
  // 100644 en Windows; acá se comprueba que el manifiesto NO depende de `fs.statSync`
  const stat = fs.statSync(path.join(dest, 'scripts', 'setup', 'harness.js'));
  if (process.platform !== 'win32') assert.ok(stat.mode & 0o100, 'en posix el ejecutable queda ejecutable');
});

const refused = (t, label, extraEntry) => test(`T10 · se rechaza ANTES de escribir: ${label}`, () => {
  const R = require(READER);
  const dest = tmp('tar-refuse-');
  const r = R.extractTarGz(gz(githubLike(FILES, [extraEntry])), dest, { stripRoot: true });
  assert.strictEqual(r.ok, false, 'tiene que rechazar');
  assert.match(r.reason, t, r.reason);
  assert.deepStrictEqual(fs.readdirSync(dest), [], 'nada escrito en el destino');
});
refused(/enlace simb[oó]lico.*scripts\/link\.js/, 'un enlace simbólico', entry({ name: inRoot('scripts/link.js'), type: '2', linkname: '../etc/passwd' }));
refused(/enlace duro.*scripts\/hard\.js/, 'un enlace duro', entry({ name: inRoot('scripts/hard.js'), type: '1', linkname: inRoot('README.md') }));
refused(/dispositivo.*dev\/sda/, 'un dispositivo', entry({ name: inRoot('dev/sda'), type: '3' }));
refused(/sale del destino.*\.\.\/fuera\.txt/, 'una ruta con ../', entry({ name: inRoot('../fuera.txt') }, 'x'));
refused(/sale del destino.*\/etc\/x/, 'una ruta absoluta', entry({ name: '/etc/x' }, 'x'));
refused(/\.git.*\.git\/config/, 'una ruta bajo .git/', entry({ name: inRoot('.git/config') }, 'x'));
refused(/fifo.*scripts\/pipe/, 'un fifo', entry({ name: inRoot('scripts/pipe'), type: '6' }));

test('T10 · un nombre de 130 caracteres llega por las tres vías (prefix de ustar, x de pax, L de GNU) y uno con acento', () => {
  const R = require(READER);
  const long = `${'carpeta-larga/'.repeat(6)}archivo-con-un-nombre-realmente-largo-para-el-tar.md`;   // 130+ caracteres
  assert.ok(long.length >= 130, String(long.length));
  const full = inRoot(long);
  // (1) ustar: prefix + name
  const cut = full.lastIndexOf('/', 154);
  const viaPrefix = entry({ name: full.slice(cut + 1), prefix: full.slice(0, cut) }, 'uno\n');
  // (2) pax `x` con `path`
  const viaPax = Buffer.concat([entry({ name: 'PaxHeader/x', type: 'x' }, paxRecord('path', `${full}.pax`)), entry({ name: 'nombre-cortado' }, 'dos\n')]);
  // (3) GNU `L` con el nombre largo como contenido
  const viaGnu = Buffer.concat([entry({ name: '././@LongLink', type: 'L' }, `${full}.gnu\0`), entry({ name: 'nombre-cortado-2' }, 'tres\n')]);
  const dest = tmp('tar-long-');
  const r = R.extractTarGz(gz(githubLike(FILES, [viaPrefix, viaPax, viaGnu])), dest, { stripRoot: true });
  assert.ok(r.ok, JSON.stringify(r));
  const paths = r.manifest.map((m) => m.path);
  assert.ok(paths.includes(long), 'por prefix');
  assert.ok(paths.includes(`${long}.pax`), 'por pax');
  assert.ok(paths.includes(`${long}.gnu`), 'por GNU L');
  assert.ok(paths.includes('guides/ñandú-áéíóú.md'), 'con acento');
  assert.strictEqual(fs.readFileSync(path.join(dest, ...`${long}.gnu`.split('/')), 'utf8'), 'tres\n');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'guides', 'ñandú-áéíóú.md'), 'utf8'), 'con acento\n');
});

test('T10 · un comprimido cortado a mitad es un error que lo dice, sin carpeta a medias', () => {
  const R = require(READER);
  const whole = gz(githubLike(FILES));
  const dest = tmp('tar-cut-');
  const r = R.extractTarGz(whole.subarray(0, Math.floor(whole.length / 2)), dest, { stripRoot: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cortado|incompleto|ilegible/, r.reason);
  assert.deepStrictEqual(fs.readdirSync(dest), []);
  // también un tar sano por dentro pero sin su final (gzip entero, tar truncado)
  const t = githubLike(FILES);
  const r2 = R.extractTarGz(gz(t.subarray(0, t.length - 1024 - 300)), tmp('tar-cut2-'), { stripRoot: true });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /cortado|incompleto/, r2.reason);
});

test('T10 · con `only` sólo se juzga y se escribe esa subcarpeta: un enlace en OTRA carpeta del comprimido no frena (skills de terceros)', () => {
  const R = require(READER);
  const link = entry({ name: inRoot('other/enlace'), type: '2', linkname: '../README.md' });
  const files = [...FILES, { path: 'skills/x/SKILL.md', content: '# x\n', mode: '100644' }, { path: 'skills/x/run.sh', content: 'echo\n', mode: '100755' }];
  // sin `only`, el enlace frena (como siempre)
  const all = R.extractTarGz(gz(githubLike(files, [link])), tmp('tar-only-all-'), { stripRoot: true });
  assert.strictEqual(all.ok, false);
  assert.match(all.reason, /enlace/);
  // con `only: 'skills/x'`, el enlace de other/ no existe para el lector: sólo lo de skills/x se escribe
  const dest = tmp('tar-only-');
  const r = R.extractTarGz(gz(githubLike(files, [link])), dest, { stripRoot: true, only: 'skills/x' });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.manifest.map((m) => m.path).sort(), ['skills/x/SKILL.md', 'skills/x/run.sh']);
  assert.strictEqual(fs.existsSync(path.join(dest, 'README.md')), false, 'nada de afuera se escribió');
  assert.strictEqual(fs.existsSync(path.join(dest, 'skills', 'x', 'run.sh')), true);
  // un enlace DENTRO de la subcarpeta sí frena
  const inside = entry({ name: inRoot('skills/x/enlace'), type: '2', linkname: 'SKILL.md' });
  const r2 = R.extractTarGz(gz(githubLike(files, [inside])), tmp('tar-only-in-'), { stripRoot: true, only: 'skills/x' });
  assert.strictEqual(r2.ok, false);
});

test('T10 · sin carpeta raíz común no se puede quitar la raíz, y se dice', () => {
  const R = require(READER);
  const t = tar([entry({ name: 'a/x.txt' }, 'x'), entry({ name: 'b/y.txt' }, 'y')]);
  const r = R.extractTarGz(gz(t), tmp('tar-noroot-'), { stripRoot: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /ra[ií]z/, r.reason);
});

// T3, caracterización: del comprimido oficial de Node la bajada saca SÓLO bin/node; los tres enlaces que
// trae bin/ (npm, npx, corepack) quedan afuera sin rechazar el comprimido, y el binario conserva su modo ejecutable
test('T3 TarReader_SoloUnArchivo_IgnoraEnlacesDeAlLado @story-8.39 @ac-2', () => {
  const R = require(READER);
  const root = 'node-v24.21.0-darwin-arm64';
  const t = tar([
    entry({ name: `${root}/`, type: '5', mode: 0o755 }),
    entry({ name: `${root}/bin/`, type: '5', mode: 0o755 }),
    entry({ name: `${root}/bin/node`, mode: 0o755 }, '#!/bin/sh\necho v24.21.0\n'),
    entry({ name: `${root}/bin/npm`, type: '2', linkname: '../lib/node_modules/npm/bin/npm-cli.js' }),
    entry({ name: `${root}/bin/npx`, type: '2', linkname: '../lib/node_modules/npm/bin/npx-cli.js' }),
    entry({ name: `${root}/bin/corepack`, type: '2', linkname: '../lib/node_modules/corepack/dist/corepack.js' }),
    entry({ name: `${root}/lib/node_modules/npm/bin/npm-cli.js` }, '// npm\n'),
  ]);
  const dir = tmp('tar-only-node-');
  const r = R.extractTarGz(gz(t), dir, { stripRoot: true, only: 'bin/node' });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.manifest.map((m) => `${m.path} ${m.mode}`), ['bin/node 100755']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((x) => `${e.name}/${x}`) : [e.name]));
  assert.deepStrictEqual(walk(dir), ['bin/node'], 'sólo bin/node en el disco');
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dir, 'bin', 'node')).mode & 0o100, 'con su modo ejecutable');
});
