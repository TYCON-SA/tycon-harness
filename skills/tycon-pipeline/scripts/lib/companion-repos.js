#!/usr/bin/env node
/**
 * companion-repos.js — el repo hermano de una story (story 7.26).
 *
 * Una story puede vivir en un repo y cambiar otro, declarado en `.tycon/advisors.yaml → evidence.companion_repos` (el
 * repo hermano). Hasta la 7.26 el pipeline miraba sólo `--repo` en seis lugares: la detección de React, los
 * disparadores por líneas agregadas, el contexto de los revisores, el portón de pruebas, el delta de las vueltas y las
 * pruebas propias del pase adversarial (corrida de una story de un producto del equipo, 2026-10-14). Este módulo es lo
 * que esos lugares comparten: quiénes son los hermanos, a qué repo pertenece cada archivo y cómo se escribe uno del
 * hermano.
 *
 * 🔴 Los hermanos se leen de la CARPETA (`parseEvidenceConfig` sin modo freno), no sólo de lo commiteado: en estos
 * usos un hermano sólo SUMA revisión (un revisor, un diff, una suite, un archivo del delta), nunca afloja un control.
 * La evidencia de cierre, que sí afloja, los sigue leyendo de lo commiteado (`lib/evidence-config.js`).
 *
 * El bloque `evidence:` lo parsea UN solo lugar, `lib/evidence-config.js`: acá no hay otro parser.
 *
 * CLI (lo usa test-gate.sh):
 *   node companion-repos.js targets <repo> <story.md>
 *     → una línea por hermano que la story toca: `<raíz>\x1f<alcance o vacío>\x1f<archivos separados por coma>`.
 *   node companion-repos.js declared-here <repo> <story.md>
 *     → los `files_to_create` de la story que NO viven en un hermano (uno por línea): el cruce de cobertura del repo.
 *   node companion-repos.js declared-in <repo-de-la-story> <story.md> <hermano>
 *     → los `files_to_create` que viven en ESE hermano, relativos a él: el cruce de cobertura de su corrida.
 *   Una story ilegible sale 2 con el motivo (nunca «ninguno»); un hermano declarado que no existe se avisa por stderr.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseEvidenceConfig, discoverRepoRoot } = require('./evidence-config.js');

/**
 * La ruta real (enlaces resueltos; en macOS /tmp ↔ /private/tmp). Si no existe (un archivo borrado en el diff, o uno
 * que la story todavía va a crear), la real del ancestro que sí existe más el resto tal cual — la misma regla que
 * `verificarPruebasPropias` de marker.js. Antes caía a la ruta sin resolver: bajo un enlace, un archivo borrado del
 * repo salía «de otro repo» con una ruta `../../../../tmp/…` (pase adversarial de la 7.26, causa A).
 */
function real(p) {
  let actual = path.resolve(p);
  const resto = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(actual), ...resto); } catch (e) {
      // Sólo «no existe» sube al ancestro; otro error (permisos) usa la ruta tal cual.
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return path.join(actual, ...resto);
    }
    const padre = path.dirname(actual);
    if (padre === actual) return path.join(actual, ...resto);
    resto.unshift(path.basename(actual));
    actual = padre;
  }
}
const mismo = (a, b) => real(a) === real(b);
function adentro(p, raiz) {
  const r = real(raiz);
  const x = real(p);
  return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
function esDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function esArchivo(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/**
 * Los hermanos de una corrida: los que declara `--repo` más los que declara el repo que contiene la story, sin el
 * propio `--repo`, sin repetidos (por ruta real), en el orden en que aparecen.
 * `opts.onMissing(nombre, repoQueLoDeclara)`: un hermano declarado que no está en disco. Sin el aviso, «lo declaré y no
 * existe» se leía igual que «no hay hermanos» (revisor de fallas silenciosas, vuelta 1). Un error al leer la config
 * NO se traga: sube a quien llama.
 */
function companionRoots(repo, storyPath, opts) {
  if (!repo) return [];
  const fuentes = [repo];
  const repoDeLaStory = storyPath ? discoverRepoRoot(storyPath) : null;
  if (repoDeLaStory && !mismo(repoDeLaStory, repo)) fuentes.push(repoDeLaStory);
  const vistos = new Set([real(repo)]);
  const out = [];
  const rama = ramaDe(repoDeLaStory || repo);
  for (const f of fuentes) {
    const cfg = parseEvidenceConfig(f);
    if (opts && typeof opts.onMissing === 'function') for (const m of cfg.missing) opts.onMissing(m, f);
    for (const r of cfg.roots) {
      const k = enLaMismaRama(real(r), rama);
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(k);
    }
  }
  return out;
}

/** La rama en que está un repo, o null (cabeza suelta, o git que no contesta). */
function ramaDe(dir) {
  if (!dir) return null;
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  // salida 1 con -q = cabeza suelta; cualquier otra cosa es git que no contestó, y se dice
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    avisar(`no pude leer la rama de ${dir} (${(r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`}): los repos hermanos se leen como están declarados`);
    return null;
  }
  const b = r.status === 0 ? String(r.stdout || '').trim() : '';
  return b || null;
}

function avisar(texto) { process.stderr.write(`[hermanos] ⚠️  ${texto}\n`); }

// La carpeta de un worktree → la ruta con que la declara `.tycon/advisors.yaml` (su `label` es el nombre de ésa, y las
// rutas `../<hermano>/x` de la story se resuelven contra ella).
const DECLARADO = new Map();

/**
 * El hermano declarado, o su worktree en la misma rama que el repo de la story. Desde el worktree de una story,
 * `../<hermano>` es el checkout compartido (en `main`), no el código que la story cambió: el portón probaba otra cosa.
 * Con la cabeza suelta, o sin un worktree del hermano en esa rama, el declarado tal cual.
 */
function enLaMismaRama(declarado, rama) {
  if (!rama) return declarado;
  const r = spawnSync('git', ['-C', declarado, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  if (r.error || r.status !== 0) {
    avisar(`no pude listar los worktrees de ${declarado} (${(r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`}): uso el declarado, que puede no ser el código de la rama ${rama}`);
    return declarado;
  }
  // Un hermano declarado como subcarpeta de su repo es esa subcarpeta también en el worktree.
  const top = spawnSync('git', ['-C', declarado, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  if (top.error || top.status !== 0) {
    avisar(`no pude leer la raíz git de ${declarado} (${(top.error && (top.error.code || top.error.message)) || String(top.stderr || '').trim().split('\n')[0] || `git salió ${top.status}`}): uso el declarado, que puede no ser el código de la rama ${rama}`);
    return declarado;
  }
  const sub = path.relative(real(String(top.stdout || '').trim()), declarado);
  for (const bloque of String(r.stdout || '').split(/\n\s*\n/)) {
    const ruta = (bloque.match(/^worktree (.+)$/m) || [])[1];
    const b = (bloque.match(/^branch refs\/heads\/(.+)$/m) || [])[1];
    if (ruta && b === rama && esDir(path.join(ruta, sub))) {
      const wt = real(path.join(ruta, sub));
      if (wt !== declarado) DECLARADO.set(wt, declarado);
      return wt;
    }
  }
  return declarado;
}

/** La raíz git que contiene un archivo o carpeta (la carpeta con `.git`), o null. */
function gitRootOf(p) {
  const r = discoverRepoRoot(p);
  return r ? real(r) : null;
}

/** Cómo se nombra un repo hermano para una persona y para el step-05b: el nombre de su carpeta. */
function label(root) { const r = real(root); return path.basename(DECLARADO.get(r) || r); }

/**
 * A qué repo pertenece un archivo de `--files` (relativo a `--repo`, o absoluto): `{ root, rel, abs, propio }`.
 * `propio`: el archivo cae dentro de la raíz git de `--repo` (aunque `--repo` sea una subcarpeta). Fuera de ella, la
 * raíz es la del repo git que lo contiene; sin ninguno, `root: null`.
 */
function ownerOf(file, repo) {
  const abs = path.isAbsolute(file) ? file : path.resolve(repo, file);
  const raizRepo = gitRootOf(repo) || real(repo);
  if (adentro(abs, raizRepo)) {
    return { root: raizRepo, rel: path.relative(raizRepo, real(abs)).split(path.sep).join('/'), abs, propio: true };
  }
  const root = gitRootOf(abs);
  if (!root) return { root: null, rel: file, abs, propio: false };
  return { root, rel: path.relative(root, real(abs)).split(path.sep).join('/'), abs, propio: false };
}

/** Agrupa una lista de archivos por repo dueño, el de `--repo` primero. `[{ root, propio, files: [{rel, abs, original}] }]`. */
function groupByRepo(files, repo) {
  const grupos = new Map();
  for (const f of files || []) {
    const o = ownerOf(f, repo);
    const k = o.root || '(sin repo git)';
    if (!grupos.has(k)) grupos.set(k, { root: o.root, propio: o.propio, files: [] });
    grupos.get(k).files.push({ rel: o.rel, abs: o.abs, original: f });
  }
  return [...grupos.values()].sort((a, b) => Number(b.propio) - Number(a.propio));
}

/**
 * Dónde vive una ruta que la story declara: en el repo, o en un hermano escrita relativa a él, con `<nombre>/` o
 * `../<nombre>/` adelante. `{ where: 'repo'|'companion'|null, root, rel }`. Sólo se cuenta lo que EXISTE: una ruta que
 * no está en ningún lado sigue siendo del repo (el cruce de cobertura la lista como «declarada que no existe»).
 */
function resolveDeclared(decl, repo, companions) {
  const d = String(decl || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!d) return { where: null, root: null, rel: d };
  // Del repo sólo si cae ADENTRO: `path.join(repo, '../Front/x')` sale del repo y encuentra el archivo del hermano;
  // sin esta guarda, `../<hermano>/ruta` —una forma que el AC 7 promete— se tomaba como del repo (pase adversarial).
  const enRepo = path.join(repo, d);
  if (adentro(enRepo, repo) && esArchivo(enRepo)) return { where: 'repo', root: real(repo), rel: d };
  for (const c of companions || []) {
    const nombre = label(c);
    const candidatos = [d];
    if (d.startsWith(`${nombre}/`)) candidatos.push(d.slice(nombre.length + 1));
    const deRepo = path.resolve(repo, d);
    if (adentro(deRepo, c)) candidatos.push(path.relative(real(c), real(deRepo)).split(path.sep).join('/'));
    // Con el hermano en su worktree, `../<hermano>/x` apunta a la carpeta declarada: se traduce al worktree.
    const decl = DECLARADO.get(real(c));
    if (decl && adentro(deRepo, decl)) candidatos.push(path.relative(decl, real(deRepo)).split(path.sep).join('/'));
    for (const rel of candidatos) {
      // Adentro del hermano, como la guarda del repo: `sub/../../x` no empieza con `../` y sale de su raíz (seguridad, vuelta 2).
      const enHermano = path.join(c, rel);
      if (rel && adentro(enHermano, c) && esArchivo(enHermano)) {
        return { where: 'companion', root: real(c), rel: path.relative(real(c), real(enHermano)).split(path.sep).join('/') };
      }
    }
  }
  return { where: null, root: null, rel: d };
}

/** `(<repo>) <ruta>` → `{ ref, rest }`; cualquier otra forma → null. */
function parseRepoPrefixed(entry) {
  const m = String(entry || '').match(/^\(([^()]+)\)\s+(.+)$/);
  return m ? { ref: m[1].trim(), rest: m[2].trim() } : null;
}

/**
 * La raíz de `<repo>` en `(<repo>) <ruta>`, probando en orden (decisión D7 de la story 7.26): un hermano declarado con
 * ese nombre, una ruta relativa a la base (`../FrontEnd`) o absoluta, y una carpeta vecina de la base con ese nombre.
 * `{ root, tried }` — `root` es la raíz git, o null; `tried` dice qué se probó (para el mensaje de error).
 */
function resolveRepoRef(ref, base, companions) {
  const tried = [];
  const prueba = (p, como) => {
    tried.push(`${como}: ${p}`);
    if (!esDir(p)) return null;
    const r = gitRootOf(p);
    return r && mismo(r, p) ? r : null;
  };
  for (const c of companions || []) {
    if (label(c) === ref) {
      const r = prueba(c, 'hermano declarado');
      if (r) return { root: r, tried };
    }
  }
  const comoRuta = path.isAbsolute(ref) ? ref : path.resolve(base, ref);
  const r1 = prueba(comoRuta, 'ruta');
  if (r1) return { root: r1, tried };
  if (!ref.includes('/') && !ref.includes(path.sep)) {
    const r2 = prueba(path.join(path.dirname(real(base)), ref), 'carpeta vecina');
    if (r2) return { root: r2, tried };
  }
  return { root: null, tried };
}

/** El texto de la story. Una story ilegible NO es «la story no declara nada»: falla, con la ruta y el motivo. */
function leerStory(storyPath) {
  try { return fs.readFileSync(storyPath, 'utf8'); } catch (e) {
    throw new Error(`no pude leer la story ${storyPath}: ${(e && e.code) || (e && e.message) || e}`);
  }
}

/**
 * Los hermanos que la story toca, con los archivos que declara en cada uno y el alcance de pruebas deducido sobre esos
 * archivos (sólo si el hermano tiene más de un proyecto con pruebas y se puede deducir; si no, vacío y lo decide el
 * propio test-gate del hermano). `opts.onMissing` como en `companionRoots`; `opts.warn(texto)` para los avisos.
 */
function companionTargets(repo, storyPath, opts) {
  const ts = require('./test-scope.js');
  const contenido = leerStory(storyPath);
  const warn = (opts && opts.warn) || (() => {});
  const companions = companionRoots(repo, storyPath, opts);
  if (!companions.length) return [];
  const porRaiz = new Map();
  for (const decl of ts.parseDeclaredFiles(contenido)) {
    const r = resolveDeclared(decl, repo, companions);
    if (r.where !== 'companion') continue;
    if (!porRaiz.has(r.root)) porRaiz.set(r.root, []);
    if (!porRaiz.get(r.root).includes(r.rel)) porRaiz.get(r.root).push(r.rel);
  }
  return [...porRaiz.entries()].map(([root, files]) => {
    let scope = '';
    try {
      const d = ts.deduceScope({ files, candidates: ts.discoverCandidates(root) });
      if (d.multi && !d.ambiguous && d.scope) scope = d.scope;
    } catch (e) {
      // Sin alcance deducido, el test-gate del hermano deduce el suyo (o frena con 4): se avisa, no se calla.
      warn(`no pude deducir el alcance de pruebas en ${label(root)} (${(e && e.message) || e}): lo decide su propio test-gate`);
    }
    return { root, scope, files };
  });
}

/** Los `files_to_create` de la story que no viven en un hermano: lo que el cruce de cobertura del repo mira. */
function declaredHere(repo, storyPath) {
  const ts = require('./test-scope.js');
  const contenido = leerStory(storyPath);
  const companions = companionRoots(repo, storyPath);
  return ts.parseFilesToCreate(contenido).filter((d) => resolveDeclared(d, repo, companions).where !== 'companion');
}

/**
 * En la corrida de UN hermano: los `files_to_create` de la story que viven en ese hermano, vistos desde el repo de la
 * story y relativos al hermano. Sin esto, el artefacto del hermano listaba como «declarados que no existen» los que la
 * story crea en el repo de la story, y no encontraba los suyos escritos con `<nombre>/` (pase adversarial, causa C).
 */
function declaredIn(storyRepo, storyPath, companionRoot) {
  const ts = require('./test-scope.js');
  const contenido = leerStory(storyPath);
  const companions = companionRoots(storyRepo, storyPath);
  const destino = real(companionRoot);
  const out = [];
  for (const d of ts.parseFilesToCreate(contenido)) {
    const r = resolveDeclared(d, storyRepo, companions);
    if (r.where === 'companion' && r.root === destino && !out.includes(r.rel)) out.push(r.rel);
  }
  return out;
}

module.exports = {
  companionRoots, ramaDe, enLaMismaRama, gitRootOf, label, ownerOf, groupByRepo, resolveDeclared, parseRepoPrefixed, resolveRepoRef,
  companionTargets, declaredHere, declaredIn, real,
};

if (require.main === module) {
  const [cmd, repo, story, otro] = process.argv.slice(2);
  if (!['targets', 'declared-here', 'declared-in'].includes(cmd) || !repo || !story || (cmd === 'declared-in' && !otro)) {
    process.stderr.write('uso: companion-repos.js targets|declared-here <repo> <story.md>  ·  declared-in <repo-de-la-story> <story.md> <hermano>\n');
    process.exit(2);
  }
  try {
    if (cmd === 'targets') {
      const avisar = (t) => process.stderr.write(`[test-gate] ⚠️  ${t}\n`);
      const ts = companionTargets(repo, story, {
        warn: avisar,
        onMissing: (nombre, quien) => avisar(`el repo hermano «${nombre}» que declara ${label(quien)}/.tycon/advisors.yaml no está en disco: su suite NO se corre`),
      });
      for (const t of ts) process.stdout.write([t.root, t.scope, t.files.join(',')].join('\x1f') + '\n');
    } else {
      const xs = cmd === 'declared-here' ? declaredHere(repo, story) : declaredIn(repo, story, otro);
      process.stdout.write(xs.join('\n') + (xs.length ? '\n' : ''));
    }
  } catch (e) {
    process.stderr.write(`companion-repos.js ${cmd}: ${(e && e.message) || e}\n`);
    process.exit(2);
  }
}
