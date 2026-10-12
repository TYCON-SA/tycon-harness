#!/usr/bin/env node
'use strict';
/**
 * suite-deps.js — de qué archivos y carpetas del repo depende cada suite, leído de su código (sin correrla).
 *
 * POR QUÉ (2026-10-05, decisión del dueño): la validación de cada cambio tiene que durar 15 min o menos, los agentes de
 * Azure tienen 2 núcleos y no se compran más. La validación corría las ~240 suites con cualquier cambio (~40 min de
 * trabajo). Con esto, scripts/ci/suites-for-change.js corre en la validación sólo las suites que dependen de algo que
 * el cambio toca; las demás las corre el banco nocturno, como siempre.
 * Story 8.22, tramo B (2026-10-06): vuelve como entró en `64a5a523`. Se había revertido (`df7d3ba9`) porque la rama
 * validada a mano se calculaba con el último commit; desde `36560371` se compara la rama entera y la 170 ya no cae al
 * último commit en ningún camino. Un solo cambio, del pase adversarial: lo que no se deja leer queda en `unreadable` y
 * la suite corre siempre (antes se leía como texto vacío y se salteaba).
 *
 * CÓMO: desde el archivo de la suite, un recorrido por lo que nombra su código —las cadenas que son rutas del repo
 * (también las armadas con `path.join(…)` de pedazos literales) y los `require` relativos—. Un archivo de código
 * nombrado se recorre igual; uno de datos (`.json`, `.md`, `.yml`…) cuenta como dependencia sin recorrerse; una carpeta
 * nombrada hace depender de todo lo que tenga adentro. Si algo del recorrido lista los archivos del repo entero
 * (`git ls-files`, `git grep`) la suite depende de TODO.
 *
 * ANTE LA DUDA, CORRE. El recorrido puede ver de más (una ruta en un comentario) y eso sólo hace correr una suite de más.
 * Lo que no puede es ver de menos sin decirlo: lo que no sabe leer —una ruta armada con variables— lo cubre la carpeta
 * de la suite y lo que sí nombra, y el banco nocturno corre todas cada noche. Las carpetas de primer nivel nombradas
 * solas (`scripts`, `skills`) no cuentan como carpeta: son el comienzo de un `path.join` que sigue con variables, y
 * contarlas haría depender a casi todas de todo; la suite que de verdad recorre una de ellas entera la lista con
 * `ls-files`, y eso sí cuenta.
 *
 * Uso (para mirar a mano):  node scripts/ci/suite-deps.js <repo> <ruta de la suite relativa al repo> [--changed <archivo>]
 *   imprime sus dependencias y, con --changed, si el cambio la toca. La función la usa suites-for-change.js.
 */
const fs = require('fs');
const path = require('path');

const CODE = /\.(c?js|mjs|sh|bash|ps1|py)$/;
// Carpetas que nombradas enteras no dicen nada: el comienzo de un `path.join` que sigue con variables (`scripts`,
// `skills`), la carpeta de TODAS las suites (cambiar una suite hacía correr otras 82) y la memoria del equipo, que cambia
// en cada commit (126). Un archivo puntual de adentro sigue contando.
const TOO_BROAD = /^(scripts|skills|\.engram|scripts\/tests|skills\/[^/]+\/scripts\/tests)$/;
const WHOLE_REPO = /\bls-files\b|\bgit\b[^\n]{0,40}\bgrep\b|['"]grep['"]/;
const MAX_FILE = 2 * 1024 * 1024;

const slash = (p) => p.split(path.sep).join('/');

/** Las cadenas candidatas a ruta de un texto de código: literales, `path.join` de literales y palabras con barra. */
function candidates(text) {
  const out = new Set();
  for (const m of text.matchAll(/path\.(?:join|resolve)\(([^()]*)\)/g)) {
    const lits = [...m[1].matchAll(/(['"`])([^'"`\n$]*)\1/g)].map((x) => x[2]).filter(Boolean);
    if (lits.length) out.add(lits.join('/'));
  }
  // lo que sigue a una variable (`$RAIZ/guides/x`, `${TCG}/scripts/y`) es relativo a lo que la variable nombra: sin la
  // barra de adelante
  const pieces = (s) => s.split(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/).map((p, i) => (i ? p.replace(/^\/+/, '') : p));
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\n\\])*)\1/g)) for (const piece of pieces(m[2])) if (piece.length > 1) out.add(piece);
  for (const m of text.matchAll(/[\w.@~${}-]*\/[\w.@/${}-]+/g)) for (const piece of pieces(m[0])) if (piece.length > 1) out.add(piece);
  return out;
}

function makeResolver(repoRoot) {
  const kind = new Map();
  const statOf = (rel) => {
    if (kind.has(rel)) return kind.get(rel);
    let k = null;
    try { const s = fs.statSync(path.join(repoRoot, rel)); k = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null; } catch (_) { k = null; }
    kind.set(rel, k);
    return k;
  };
  /** Una cadena → la ruta del repo que nombra (o null), probando desde la carpeta del archivo, la raíz, scripts/ y skills/. */
  return (raw, fromDir) => {
    const c = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!c || c.length > 300 || /^[a-z]+:\/\//i.test(c) || c.startsWith('/')) return null;
    const tries = [path.posix.join(fromDir, c), c, `scripts/${c}`, `skills/${c}`];
    for (const t of tries) {
      const rel = path.posix.normalize(t);
      if (rel.startsWith('..') || rel === '.' || rel === '') continue;
      const k = statOf(rel);
      if (k) return { rel, kind: k };
    }
    return null;
  };
}

/**
 * Las dependencias de una suite. `cache` (opcional, compartido entre suites) guarda lo leído de cada archivo.
 * Devuelve { files: Set<rel>, dirs: Set<rel>, wholeRepo: bool }.
 */
function suiteDeps(repoRoot, suiteRel, cache = new Map()) {
  const resolve = cache.resolve || (cache.resolve = makeResolver(repoRoot));
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    // Lo que no se deja leer (sin permiso, o más grande que MAX_FILE) no es «no nombra nada»: queda anotado y la suite
    // corre (story 8.22, AC 9 c; pase adversarial del tramo B). Antes se leía como texto vacío y la suite se salteaba.
    let text = '';
    let unreadable = null;
    try {
      const abs = path.join(repoRoot, rel);
      const size = fs.statSync(abs).size;
      if (size <= MAX_FILE) text = fs.readFileSync(abs, 'utf8');
      else unreadable = `pesa ${size} bytes, más que los ${MAX_FILE} que se leen`;
    } catch (e) { unreadable = e.code || e.message; }
    const fromDir = path.posix.dirname(rel);
    const mentions = [];
    for (const c of candidates(text)) { const r = resolve(c, fromDir); if (r) mentions.push(r); }
    // lo que el módulo carga: require('./x') y require(path.join(__dirname, …)) — su grafo de módulos se sigue entero
    const requires = [];
    for (const m of text.matchAll(/require\(\s*(?:(['"`])(\.{1,2}\/[^'"`]+)\1|path\.join\(\s*__dirname\s*,([^()]*)\))\s*\)/g)) {
      const raw = m[2] || [...m[3].matchAll(/(['"`])([^'"`$]+)\1/g)].map((x) => x[2]).join('/');
      for (const cand of [raw, `${raw}.js`, `${raw}/index.js`]) { const r = resolve(cand, fromDir); if (r && r.kind === 'file') { requires.push(r.rel); break; } }
    }
    const out = { mentions, requires, whole: WHOLE_REPO.test(text), unreadable };
    cache.set(rel, out);
    return out;
  };
  const files = new Set();
  const dirs = new Set();
  const add = (r) => { if (r.kind === 'dir') { if (!TOO_BROAD.test(r.rel)) dirs.add(r.rel); } else files.add(r.rel); };
  // Nivel 0, la suite: lo que nombra cuenta, y cada archivo de código que nombra se mira un nivel (es lo que la suite
  // ejecuta). Desde ahí sólo se sigue el grafo de módulos: seguir cada ruta nombrada por cualquier guion terminaba en
  // el repo entero (el instalador nombra cien guiones) y no dejaba saltear nada.
  const suite = read(suiteRel);
  const wholeRepo = suite.whole;
  const unreadable = [];
  if (suite.unreadable) unreadable.push({ rel: suiteRel, reason: suite.unreadable });
  files.add(suiteRel);
  const queue = [];
  for (const r of suite.mentions) { add(r); if (r.kind === 'file' && CODE.test(r.rel)) queue.push(r.rel); }
  queue.push(...suite.requires);
  const seen = new Set([suiteRel]);
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.add(rel);
    if (!CODE.test(rel)) continue;
    const r = read(rel);
    if (r.unreadable) unreadable.push({ rel, reason: r.unreadable });
    for (const m of r.mentions) add(m);
    queue.push(...r.requires);
  }
  // la carpeta de la suite (sus fixtures y vecinos que arma con variables), salvo que sea la de todas las suites
  const own = path.posix.dirname(suiteRel);
  if (own !== '.' && !TOO_BROAD.test(own)) dirs.add(own);
  return { files, dirs, wholeRepo, unreadable };
}

/**
 * ¿Algún archivo del cambio es una dependencia (o está dentro de una carpeta dependencia)? Una suite con algo que no
 * se pudo leer corre siempre: no se sabe qué usa.
 */
function touchedBy(deps, changed) {
  if (deps.wholeRepo || (deps.unreadable && deps.unreadable.length)) return true;
  return changed.some((f) => deps.files.has(f) || [...deps.dirs].some((d) => f === d || f.startsWith(`${d}/`)));
}

function main(argv) {
  const [repo, suite] = argv;
  if (!repo || !suite) { process.stderr.write('uso: suite-deps.js <repo> <suite relativa al repo> [--changed <archivo>]\n'); return 2; }
  const d = suiteDeps(path.resolve(repo), slash(suite));
  process.stdout.write(`${suite}: ${d.files.size} archivo(s), ${d.dirs.size} carpeta(s)${d.wholeRepo ? ', TODO el repo (lista los archivos)' : ''}\n`);
  for (const u of d.unreadable) process.stdout.write(`  no se deja leer  ${u.rel} (${u.reason}): corre siempre\n`);
  for (const x of [...d.dirs].sort()) process.stdout.write(`  carpeta  ${x}/\n`);
  for (const x of [...d.files].sort()) process.stdout.write(`  archivo  ${x}\n`);
  const i = argv.indexOf('--changed');
  if (i > 0) {
    const changed = fs.readFileSync(argv[i + 1], 'utf8').split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
    process.stdout.write(`el cambio ${touchedBy(d, changed) ? 'la toca: corre' : 'no la toca'}\n`);
  }
  return 0;
}

/**
 * Cuántas líneas de un texto disparan el «depende de todo» (story 8.22, tramo E). Una pesada con `deps: "graph"` anota
 * este número en heavy-suites.json cuando alguien revisó que esas líneas recorren un repo de juguete; si cambia, vuelve
 * a depender de todo hasta que la revisen de nuevo.
 */
function wholeRepoLines(text) {
  return String(text).split('\n').filter((l) => WHOLE_REPO.test(l)).length;
}

/** La huella de esas líneas: los 12 primeros caracteres del sha1 de su texto, en orden. Ve una línea reemplazada por otra. */
function wholeRepoSha(text) {
  const lines = String(text).split('\n').filter((l) => WHOLE_REPO.test(l));
  return require('crypto').createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { suiteDeps, touchedBy, candidates, wholeRepoLines, wholeRepoSha };
