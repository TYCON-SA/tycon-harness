'use strict';
/**
 * adhoc-base.js — la base del camino rápido: contra qué se mide lo que cambió, y qué archivos son suyos.
 *
 *   traerBase(repo)           trae `main` del remoto y devuelve su commit: `{ sha, traida: true, ts }`; sin red (o sin
 *                             remoto) `{ sha: null, traida: false, motivo, ts }`. Nunca lee el `origin/main` local, que
 *                             puede estar movido o atrasado: lee lo que trajo (FETCH_HEAD).
 *   conBase(adhoc, repo)      el carril con la base de ese repo anotada, si todavía no la tenía (el primer toque).
 *   archivosDelCarril(adhoc)  `{ porRepo: { <repo>: [rel…] }, avisos }`: lo que el carril anotó, lo preparado para el
 *                             commit y el diff contra la base; sin base, lo anotado, lo preparado y lo cambiado contra
 *                             HEAD, con el aviso de que la rama no se midió.
 *   propiosDelCarril(adhoc)   lo mismo, sin lo que entró de `main`: lo que el arreglo cambió de verdad.
 *   cuentaDelCarril(adhoc)    `{ archivos, avisos, fallas }`: de lo propio, lo que suma para el tope.
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
const RAMA_DE_TRABAJO = 'dev';
const TOPE_MS = Number(process.env.TYCON_ADHOC_BASE_TIMEOUT_MS) || 8000;

// git en inglés (LC_ALL=C): `ubicar` reconoce «fuera de un repo» por el texto del error, que se traduce
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
// el tope de salida por defecto es de 1 MB: en un repo grande, la lista de archivos lo pasa y parece que git no contestó
const SALIDA_MAX = 64 * 1024 * 1024;
function git(repo, args, timeout = 5000) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: GIT_ENV, maxBuffer: SALIDA_MAX }).trim();
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
    return { sha: git(repo, ['rev-parse', 'FETCH_HEAD^{commit}']), traida: true, ts };
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
// Para contar lo propio: un archivo movido es un cambio, con su ruta nueva.
const cambiosDeGit = (repo, args) => git(repo, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--find-renames', ...args]).split('\0').filter(Boolean);
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
      for (const l of rutasDeGit(repo, ['diff', '--cached', '--name-only'])) set.add(l);
      // un archivo nuevo que git todavía no sigue también es del carril (un `git add -A` lo sube en el mismo comando)
      for (const l of rutasDeGit(repo, ['ls-files', '--others', '--exclude-standard'])) set.add(l);
      if (base && base.sha && ES_SHA.test(base.sha)) {
        for (const l of rutasDeGit(repo, ['diff', '--name-only', base.sha, '--'])) set.add(l);
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
 * ¿Sigue siendo un repo la carpeta anotada? Una que ya no está (un worktree borrado), sin `.git`, o con un `.git` que apunta
 * a un repo que ya no está (los restos de un worktree), no tiene nada que medir. Un repo roto sí: su `.git` está, y que git
 * no conteste es «no pude medir». Otro error sube.
 */
function sigueElRepo(repo) {
  try {
    fs.statSync(repo);
    const punto = path.join(repo, '.git');
    if (fs.statSync(punto).isDirectory()) return true;
    const destino = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(punto, 'utf8'));
    return !destino || fs.existsSync(path.resolve(repo, destino[1]));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * Desde dónde se mide lo propio de un repo: la bifurcación con la rama de integración más cercana (`main` o `dev`), sin lo
 * que entró de ahí. Sin ninguna, la base anotada; sin ésa, lo anotado y el commit, con el aviso. Git que no contesta, sube.
 */
function basePropia(repo, adhoc) {
  const candidatas = [];
  for (const rama of [RAMA, RAMA_DE_TRABAJO]) {
    try {
      const sha = git(repo, ['merge-base', 'HEAD', `origin/${rama}`]);
      candidatas.push({ sha, adelante: Number(git(repo, ['rev-list', '--count', `${sha}..HEAD`])) });
    } catch (e) {
      // exit 1: historias sin relación. La rama que falta o el repo sin commits los dice el texto
      if (e.status !== 1 && !/not a valid object name/i.test(String(e.stderr || e.message))) throw e;
    }
  }
  if (candidatas.length) return { sha: candidatas.sort((a, b) => a.adelante - b.adelante)[0].sha };
  const anotada = adhoc.bases && adhoc.bases[repo];
  if (anotada && anotada.sha && ES_SHA.test(anotada.sha)) return { sha: anotada.sha };
  let cabeza = null;
  try { cabeza = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']); } catch (e) { if (e.status !== 1) throw e; }
  return { sha: cabeza, aviso: `camino corto: ${repo} no tiene su base traída (${(anotada && anotada.motivo) || 'sin origin/main'}): la rama no se midió, sólo lo anotado y el commit` };
}

const esArchivo = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };

/**
 * ¿Hay un merge en curso de lo que ya está en una rama de integración? Sólo eso es «traído». Una rama cualquiera, o varias a
 * la vez, es trabajo propio: si no, armarlo aparte y mergearlo sin commitear lo sacaría de la cuenta.
 */
function traeDeIntegracion(repo) {
  let puntas;
  try { puntas = fs.readFileSync(path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD'])), 'utf8').split('\n').filter(Boolean); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (puntas.length !== 1) return false;
  return [RAMA, RAMA_DE_TRABAJO].some((rama) => {
    try { git(repo, ['merge-base', '--is-ancestor', puntas[0], `origin/${rama}`]); return true; } catch (e) {
      if (e.status === 1 || /not a valid object name/i.test(String(e.stderr || e.message))) return false;
      throw e;
    }
  });
}

/**
 * Lo que este carril cambió de verdad, sin lo traído de `main`: `{ porRepo, avisos, fallas }`, como `archivosDelCarril`.
 * Lo anotado suma si existe o si git lo muestra borrado. Una sonda fuera de un repo, una ruta que nunca existió o un repo
 * borrado no son «no pude medir»: no suman. Con `sinSeguir`, también lo que git no sigue: una pantalla nueva que un `git add
 * -A` sube en el mismo comando. Sin él, un archivo sin seguir suma sólo si el carril lo anotó: puede ser de otra sesión, y si
 * entra en un commit, el guardado siguiente lo cuenta. Con un merge en curso de una rama de integración, lo que queda igual
 * que en esa rama es lo que el merge trae: `HEAD` todavía no lo tiene y la bifurcación no lo descuenta.
 */
function propiosDelCarril(adhoc, { repos: extra = [], sinSeguir = false } = {}) {
  const porRepo = {};
  const avisos = [];
  const fallas = [];
  const anotadas = [...((adhoc && adhoc.rutas) || []), ...((adhoc && adhoc.files) || [])].filter((f) => path.isAbsolute(String(f)));
  const { repos, huerfanas } = reposYHuerfanas({ bases: adhoc && adhoc.bases, rutas: anotadas.filter((f) => fs.existsSync(path.dirname(f))) });
  for (const f of huerfanas) {
    const m = `camino corto: no pude ubicar el repo de ${f}: queda sin medir`;
    avisos.push(m);
    fallas.push(m);
  }
  const reales = anotadas.map(rutaReal);
  for (const repo of [...new Set([...repos, ...extra.filter(Boolean)])]) {
    try {
      if (!sigueElRepo(repo)) { avisos.push(`camino corto: ${repo} ya no es un repo: no hay nada que medir ahí`); continue; }
      const base = basePropia(repo, adhoc);
      if (base.aviso) avisos.push(base.aviso);
      let set = new Set(cambiosDeGit(repo, ['--cached']));
      if (base.sha) for (const l of cambiosDeGit(repo, [base.sha, '--'])) set.add(l);
      if (traeDeIntegracion(repo)) {
        const distintos = new Set(cambiosDeGit(repo, ['MERGE_HEAD', '--']));
        set = new Set([...set].filter((l) => distintos.has(l)));
      }
      if (sinSeguir) for (const l of rutasDeGit(repo, ['ls-files', '--others', '--exclude-standard'])) set.add(l);
      for (const f of reales) {
        const rel = path.relative(repo, f).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && esArchivo(f)) set.add(rel);
      }
      porRepo[repo] = [...set].sort();
    } catch (e) {
      const f = `camino corto: git no contestó en ${repo} (${String((e && e.message) || e).split('\n')[0]})`;
      avisos.push(f);
      fallas.push(f);
    }
  }
  return { porRepo, avisos, fallas };
}

/**
 * Lo que suma para el tope: los archivos de implementación que el carril cambió, con su ruta entera. `{ archivos, avisos,
 * fallas }`. La maqueta y la captura anotadas no suman, aunque vivan en el repo. Un archivo suma una vez: un worktree dentro
 * de otro repo del carril lo muestra en los dos, y Mac guarda un nombre con acento en una forma de Unicode y git lo lista en otra.
 */
function cuentaDelCarril(adhoc, opciones) {
  const { isImplPath } = require('./atdd-order.js');
  const { isCodeFile } = require('./story-gate.js');
  const { porRepo, avisos, fallas } = propiosDelCarril(adhoc, opciones);
  const anotadas = new Set([adhoc && adhoc.mockup, adhoc && adhoc.capture].filter((x) => x && typeof x.file === 'string').map((x) => rutaReal(x.file)));
  const archivos = new Map();
  for (const repo of Object.keys(porRepo)) {
    for (const rel of porRepo[repo]) {
      const abs = path.join(repo, rel);
      if (isImplPath(rel) && isCodeFile(rel) && !anotadas.has(rutaReal(abs))) {
        const clave = abs.normalize('NFC');
        if (!archivos.has(clave)) archivos.set(clave, abs);
      }
    }
  }
  return { archivos: [...archivos.values()].sort(), avisos, fallas };
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

module.exports = { traerBase, conBase, reposDelCarril, archivosDelCarril, propiosDelCarril, cuentaDelCarril, sigueElRepo, huellaDelCarril, huellaCompleta, raizDe, ubicar, RAMA };
