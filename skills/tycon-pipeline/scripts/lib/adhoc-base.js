'use strict';
/**
 * adhoc-base.js — la base del camino rápido: contra qué se mide lo que cambió, y qué archivos son suyos.
 *
 *   traerBase(repo)           trae `main` del remoto y devuelve su commit: `{ sha, traida: true, ts }`; sin red (o sin
 *                             remoto) `{ sha: null, traida: false, motivo, ts }`. Nunca lee el `origin/main` local, que
 *                             puede estar movido o atrasado: lee lo que trajo (FETCH_HEAD).
 *   conBase(adhoc, repo)      el carril con la base de ese repo anotada, si todavía no la tenía (el primer toque).
 *   conBasesAlDia(adhoc)      el carril con `main` traído otra vez en cada repo: lo que el freno hace antes de frenar.
 *   archivosDelCarril(adhoc)  `{ porRepo: { <repo>: [rel…] }, avisos }`: lo que el carril anotó y sigue cambiado, lo
 *                             preparado para el commit y el diff contra el punto de salida de la rama (lo que `main` agregó
 *                             después no es de la rama); sin base, lo anotado, lo preparado y lo cambiado contra HEAD, con
 *                             el aviso de que la rama no se midió.
 *   marcaSinSustento(…)       ¿la marca de riesgo alto nombra un archivo que ya no es del carril?
 *   huellaDelCarril(adhoc)    el sha256 del contenido de sus archivos de código, en cada repo: un cambio después de una
 *                             constancia la cambia.
 *
 * Lo que no se puede leer (git que no contesta) sigue y avisa: el camino rápido es nivel 1.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAMA = 'main';
const TOPE_MS = Number(process.env.TYCON_ADHOC_BASE_TIMEOUT_MS) || 8000;

// git en inglés (LC_ALL=C): `ubicar` reconoce «fuera de un repo» por el texto del error, que se traduce
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
function git(repo, args, timeout = 5000) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: GIT_ENV }).trim();
}

/**
 * `{ raiz }` con la raíz real del repo de una ruta; `{ fuera: true }` si la ruta no está en un repo (la carpeta temporal
 * de la sesión, por ejemplo); `{ falla }` si git no contestó.
 */
function ubicar(p) {
  let d = String(p);
  try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch (_) { d = path.dirname(d); }
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { return { raiz: fs.realpathSync(git(d, ['rev-parse', '--show-toplevel'])) }; } catch (e) {
    const err = String((e && (e.stderr || e.message)) || e);
    if (/not a git repository/i.test(err)) return { fuera: true };
    return { falla: err.split('\n').find((l) => l.trim()) || 'git no contestó' };
  }
}
/** La raíz del repo de una ruta, o null (fuera de un repo, o git que no contesta). */
function raizDe(p) { return ubicar(p).raiz || null; }

function traerBase(repo) {
  const ts = new Date().toISOString();
  try {
    git(repo, ['fetch', '--quiet', '--no-tags', 'origin', RAMA], TOPE_MS);
    return { sha: git(repo, ['rev-parse', 'FETCH_HEAD^{commit}']), traida: true, ts, origen: git(repo, ['remote', 'get-url', 'origin']) };
  } catch (e) {
    const motivo = String((e && (e.stderr || e.message)) || e).split('\n').find((l) => l.trim()) || 'git no contestó';
    return { sha: null, traida: false, motivo: `no pude traer ${RAMA} de origin: ${motivo.trim()}`, ts };
  }
}

/** El carril con la base del repo anotada si no la tenía: `{ adhoc, aviso }` (aviso sólo si la base no se trajo). */
function conBase(adhoc, repo) {
  const bases = { ...((adhoc && adhoc.bases) || {}) };
  if (bases[repo]) return { adhoc, aviso: null };
  const b = traerBase(repo);
  bases[repo] = b;
  return { adhoc: { ...adhoc, bases }, aviso: b.traida ? null : `camino rápido: la base de ${repo} queda sin traer (${b.motivo}); al guardar se mide con lo anotado y el commit, sin la rama` };
}

/**
 * El carril con `main` traído otra vez en los repos que ya tienen base: `{ adhoc, alDia, avisos }`, con los repos cuya base
 * quedó recién traída y lo que no se pudo. Sin red queda la anotada. Un `origin` que ya no es el de la base anotada tampoco
 * cuenta: su `main` podría traer la misma rama.
 */
function conBasesAlDia(adhoc) {
  const bases = { ...((adhoc && adhoc.bases) || {}) };
  const alDia = [];
  const avisos = [];
  for (const repo of Object.keys(bases)) {
    const b = traerBase(repo);
    if (!b.traida) { avisos.push(`camino rápido: ${repo} sigue con la base anotada (${b.motivo})`); continue; }
    if (bases[repo].origen && bases[repo].origen !== b.origen) { avisos.push(`camino rápido: ${repo} sigue con la base anotada: su origin ya no es el de esa base`); continue; }
    bases[repo] = b;
    alDia.push(repo);
  }
  return { adhoc: { ...adhoc, bases }, alDia, avisos };
}

// La etiqueta de `git ls-files -v` de un archivo con una bandera del índice (`--skip-worktree`, `--assume-unchanged`): el
// diff no ve lo que el archivo tiene.
const CON_BANDERA = /^(S|[a-z])/;

/**
 * Donde la rama se separó de la base: lo que `main` agregó después no es de la rama. Sin historia común, la base: mide de
 * más. Con git caído, también; el diff que sigue lo dice como una falla.
 */
function puntoDeSalida(repo, sha) {
  try { return git(repo, ['merge-base', sha, 'HEAD']) || sha; } catch (_) { return sha; }
}

/**
 * ¿La marca nombra un archivo que ya no es del carril? Sólo con la medición completa y `main` recién traído en su repo.
 * Tampoco si un commit de otra rama local lo tocó después de la marca: pasarse de rama no la levanta. La duda deja la marca;
 * si la duda es un git que no contestó, `avisar` lo dice.
 */
function marcaSinSustento(marca, { porRepo, fallas }, alDia, bases, avisar = () => {}) {
  if (fallas.length || !marca || !marca.archivo) return false;
  // un enlace: medir su destino no dice si el enlace cambió
  try { if (fs.lstatSync(marca.archivo).isSymbolicLink()) return false; } catch (_) { /* ya no está: se mide por su ruta */ }
  const abs = rutaReal(marca.archivo);
  const repo = raizDe(abs);
  if (!repo || !alDia.includes(repo) || !porRepo[repo]) return false;
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || porRepo[repo].includes(rel)) return false;
  const t = Date.parse(marca.ts);
  const desde = Number.isNaN(t) ? [] : [`--since=${new Date(t).toISOString().slice(0, 19)}Z`];
  try {
    if (CON_BANDERA.test(git(repo, ['--literal-pathspecs', 'ls-files', '-v', '--', rel]))) return false;
    return !git(repo, ['--literal-pathspecs', 'log', '-1', '--format=%H', '--branches', ...desde, '--not', bases[repo].sha, '--', rel]);
  } catch (e) {
    avisar(`camino rápido: la marca de ${rel} queda: no pude mirar las otras ramas (${String(e.message || e).split('\n')[0]})`);
    return false;
  }
}

/** La ruta real (por los enlaces de carpeta, como /tmp → /private/tmp); la de su carpeta si el archivo ya no está. */
function rutaReal(f) {
  try { return fs.realpathSync(f); } catch (_) {
    try { return path.join(fs.realpathSync(path.dirname(f)), path.basename(f)); } catch (__) { return String(f); }
  }
}

/** Los repos del carril (los de su base y los de las rutas que anotó) y las rutas cuyo repo no se pudo ubicar. */
function reposYHuerfanas(adhoc) {
  const repos = new Set(Object.keys((adhoc && adhoc.bases) || {}));
  const huerfanas = [];
  for (const f of [...((adhoc && adhoc.rutas) || []), ...((adhoc && adhoc.files) || [])]) {
    const u = ubicar(f);
    if (u.raiz) repos.add(u.raiz); else if (u.falla) huerfanas.push(String(f));
  }
  return { repos: [...repos], huerfanas };
}
function reposDelCarril(adhoc) { return reposYHuerfanas(adhoc).repos; }

// Las rutas que lista git, separadas por NUL (`-z`): sin comillas ni escapes en los nombres con acentos o espacios.
// `-z` va antes de todo lo demás: después de un `--` git lo leería como una ruta. En un diff, sin detectar renombres
// (`--no-renames`): un archivo movido sale con su ruta vieja y la nueva, y la vieja puede ser la de riesgo alto.
const rutasDeGit = (repo, [sub, ...resto]) => git(repo, ['-c', 'core.quotepath=false', sub, '-z',
  ...(sub === 'diff' ? ['--no-renames'] : []), ...resto]).split('\0').filter(Boolean);
const ES_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * `{ porRepo, avisos, fallas }`. `avisos`: lo que se midió con menos (sin base traída). `fallas`: git que no contestó;
 * con una falla la medición está incompleta y la huella lo dice.
 */
function archivosDelCarril(adhoc, { repos: extra = [] } = {}) {
  const porRepo = {};
  const avisos = [];
  const fallas = [];
  const anotadas = [...((adhoc && adhoc.rutas) || []), ...((adhoc && adhoc.files) || [])].map(rutaReal);
  const { repos, huerfanas } = reposYHuerfanas(adhoc);
  // una ruta anotada cuyo repo no se ubica (git que no contesta) es una medición incompleta, no «nada que medir»
  for (const f of huerfanas) {
    const m = `camino rápido: no pude ubicar el repo de ${f}: queda sin medir`;
    avisos.push(m);
    fallas.push(m);
  }
  // `extra`: los repos de lo que se guarda, aunque el carril todavía no haya anotado nada en ellos
  for (const repo of [...new Set([...repos, ...extra.filter(Boolean)])]) {
    const set = new Set();
    for (const f of anotadas) {
      const rel = path.relative(repo, f).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) set.add(rel);
    }
    const base = adhoc.bases && adhoc.bases[repo];
    try {
      const anotados = [...set];
      // lo que git ya contestó queda en la medición aunque lo que sigue falle
      const cambiadas = new Set();
      const sumar = (l) => { cambiadas.add(l); set.add(l); };
      rutasDeGit(repo, ['diff', '--cached', '--name-only']).forEach(sumar);
      // un archivo nuevo que git todavía no sigue también es del carril (un `git add -A` lo sube en el mismo comando)
      rutasDeGit(repo, ['ls-files', '--others', '--exclude-standard']).forEach(sumar);
      if (base && base.sha && ES_SHA.test(base.sha)) {
        rutasDeGit(repo, ['diff', '--name-only', puntoDeSalida(repo, base.sha), '--']).forEach(sumar);
        // lo anotado que git sigue y no cambió ya no es del carril (una edición restaurada); uno ignorado o con bandera
        // del índice, que git no mide, sí lo es
        const seguidos = new Map(!anotados.length ? [] : git(repo, ['--literal-pathspecs', 'ls-files', '-v', '-z', '--', ...anotados])
          .split('\0').filter(Boolean).map((l) => [l.slice(2), l]));
        for (const rel of anotados) {
          if (cambiadas.has(rel)) continue;
          if (seguidos.has(rel) ? !CON_BANDERA.test(seguidos.get(rel)) : !fs.existsSync(path.join(repo, rel))) set.delete(rel);
        }
      } else {
        for (const l of rutasDeGit(repo, ['diff', '--name-only', 'HEAD', '--'])) set.add(l);
        avisos.push(`camino rápido: ${repo} no tiene su base traída (${(base && base.motivo) || 'sin anotar'}): la rama no se midió, sólo lo anotado y el commit`);
      }
    } catch (e) {
      const f = `camino rápido: git no contestó en ${repo} (${String(e.message || e).split('\n')[0]}): se mide sólo lo anotado`;
      avisos.push(f);
      fallas.push(f);
    }
    porRepo[repo] = [...set].sort();
  }
  return { porRepo, avisos, fallas };
}

/**
 * La huella del carril: el sha256 del contenido de sus archivos de código y de sus archivos de riesgo alto (una
 * migración, `.tycon/production.json`, un pipeline), en cada repo. Con git caído empieza con `incompleta:` y no vale
 * como constancia: se midió con menos archivos.
 */
function huellaDelCarril(adhoc) {
  const { isCodeFile } = require('./story-gate.js');
  const riskPaths = require('./risk-paths.js');
  const { porRepo, fallas } = archivosDelCarril(adhoc);
  const h = crypto.createHash('sha256');
  for (const repo of Object.keys(porRepo).sort()) {
    for (const rel of porRepo[repo]) {
      let cuenta = isCodeFile(rel);
      if (!cuenta) { try { cuenta = riskPaths.riesgoDeArchivos([rel], { repo }).value; } catch (_) { cuenta = true; } }
      if (!cuenta) continue;
      let contenido;
      try { contenido = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, rel))).digest('hex'); } catch (_) { contenido = 'ausente'; }
      h.update(`${repo}\t${rel}\t${contenido}\n`);
    }
  }
  return `${fallas.length ? 'incompleta:' : ''}${h.digest('hex')}`;
}

/** ¿La huella sirve para una constancia? Una incompleta, no. */
const huellaCompleta = (h) => typeof h === 'string' && !h.startsWith('incompleta:');

module.exports = { traerBase, conBase, conBasesAlDia, marcaSinSustento, reposDelCarril, archivosDelCarril, huellaDelCarril, huellaCompleta, raizDe, ubicar, RAMA };
