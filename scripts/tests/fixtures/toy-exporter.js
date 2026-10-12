'use strict';
// toy-exporter.js — el «exportador de juguete» de las pruebas de la capa (story 8.13.1, §Given/Fixture).
//
// Recibe un repo interno de juguete con la forma del repo unido (agents/, skills/ y packs/ en la raíz) y arma un «repo
// público» con la forma mínima de la 8.7, sin correr el exportador real (tarda decenas de segundos por caso):
//   · deja afuera una lista de rutas (exactas, o carpetas terminadas en `/`);
//   · transforma UN archivo (una línea menos) y lo declara en `version.json.transformed` (salvo `declare: false`, para
//     probar que un transformado no declarado es «otra versión»);
//   · quita del `.gitignore` las líneas del bloque `.advisors/`;
//   · agrega `LICENSE` y `version.json` (con el sha fuente; sin `transformed` si `withoutTransformed`), y lo que se le
//     pida que exista sólo afuera (`onlyPublic`);
//   · copia el resto tal cual, con su modo (los ejecutables siguen ejecutables). Los enlaces y submódulos del interno no
//     se copian nunca.
// El resultado es un repo de git con un commit, en `outDir`. Lee el interno por commit (`ls-tree` + `cat-file`), nunca
// su árbol de trabajo. `publishableBy(leaveOut)` dice qué publica con esa lista (todo lo que no deja afuera): la noción de
// «publicable» que la prueba unitaria le pasa a `computeLayer`.
//
// Uso por línea de comandos (las pruebas de bash):
//   node toy-exporter.js --internal <dir> --out <dir> [--commit <rev>] [--leave-out a,b/] [--transform <ruta>:<nombre>]
//        [--no-declare] [--without-transformed] [--only-public <ruta>=<texto>]... [--version YYYY.MM.DD.N]
// Imprime el commit del repo público.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z',
    GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid', GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z',
  });
})();
const GIT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null'];

function git(dir, args, { input, binary } = {}) {
  const r = spawnSync('git', [...GIT_FLAGS, '-C', dir, ...args], { env: GIT_ENV, input, maxBuffer: 512 * 1024 * 1024, encoding: binary ? null : 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} en ${dir}: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

const leftOut = (p, list) => list.some((x) => p === x || (x.endsWith('/') && p.startsWith(x)));
/** Qué publica el exportador de juguete con esa lista de rutas que deja afuera: ruta interna → ruta publicada (la
 *  misma) o null. Es lo que `computeLayer` recibe como `publishable` en la prueba unitaria (AC 5, la mitad «ninguna ruta
 *  que el interno publica falta en el público»); la máquina usa la clasificación del exportador de verdad. */
const publishableBy = (leaveOut = []) => (p) => (leftOut(p, leaveOut) ? null : p);
const dropLastLine = (buf) => {
  const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
  return Buffer.from(`${lines.slice(0, -1).join('\n')}\n`, 'utf8');
};
const withoutAdvisors = (buf) => Buffer.from(buf.toString('utf8').split('\n').filter((l) => !l.includes('.advisors')).join('\n'), 'utf8');

/** Arma el repo público de juguete. Devuelve `{ dir, commit, source, transformed }`. */
function exportToy({ internalDir, commit = 'HEAD', outDir, leaveOut = [], transform = null, declare = true,
  withoutTransformed = false, onlyPublic = {}, version = '2026.10.06.1' } = {}) {
  const source = git(internalDir, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const entries = git(internalDir, ['ls-tree', '-r', '-z', '--full-tree', source]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    return { mode, type, blob, path: line.slice(tab + 1) };
  });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const transformed = [];
  for (const e of entries) {
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) continue;
    if (leftOut(e.path, leaveOut)) continue;
    let content = git(internalDir, ['cat-file', 'blob', e.blob], { binary: true });
    if (transform && e.path === transform.path) {
      content = dropLastLine(content);
      if (declare) transformed.push({ path: e.path, transform: transform.transform });
    }
    if (e.path === '.gitignore') content = withoutAdvisors(content);
    const file = path.join(outDir, ...e.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, e.mode === '100755' ? 0o755 : 0o644);
  }
  for (const [p, text] of Object.entries(onlyPublic)) {
    const file = path.join(outDir, ...p.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  fs.writeFileSync(path.join(outDir, 'LICENSE'), 'Licencia de juguete para las pruebas de la capa.\n');
  const versionFile = { version, source: { harness: source } };
  if (!withoutTransformed) versionFile.transformed = transformed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  fs.writeFileSync(path.join(outDir, 'version.json'), `${JSON.stringify(versionFile, null, 2)}\n`);
  git(outDir, ['init', '-q']);
  git(outDir, ['add', '-A', '-f', '.']);
  git(outDir, ['commit', '-q', '-m', `copia pública de juguete ${version}`]);
  return { dir: outDir, commit: git(outDir, ['rev-parse', 'HEAD']).trim(), source, transformed };
}

function cli(argv) {
  const opts = { leaveOut: [], onlyPublic: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} necesita un valor`); return v; };
    if (a === '--internal') opts.internalDir = next();
    else if (a === '--out') opts.outDir = next();
    else if (a === '--commit') opts.commit = next();
    else if (a === '--leave-out') opts.leaveOut.push(...next().split(',').filter(Boolean));
    else if (a === '--transform') { const v = next(); const c = v.lastIndexOf(':'); opts.transform = { path: v.slice(0, c), transform: v.slice(c + 1) }; }
    else if (a === '--no-declare') opts.declare = false;
    else if (a === '--without-transformed') opts.withoutTransformed = true;
    else if (a === '--only-public') { const v = next(); const eq = v.indexOf('='); opts.onlyPublic[v.slice(0, eq)] = v.slice(eq + 1); }
    else if (a === '--version') opts.version = next();
    else throw new Error(`opción desconocida: ${a}`);
  }
  if (!opts.internalDir || !opts.outDir) throw new Error('uso: toy-exporter.js --internal <dir> --out <dir> [opciones]');
  process.stdout.write(`${exportToy(opts).commit}\n`);
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (e) { process.stderr.write(`toy-exporter: ${e.message}\n`); process.exit(2); }
}

module.exports = { exportToy, publishableBy };
