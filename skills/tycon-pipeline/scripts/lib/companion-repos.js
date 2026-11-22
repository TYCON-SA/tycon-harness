#!/usr/bin/env node
/**
 * companion-repos.js — el repo hermano de una story.
 *
 * Una story puede vivir en un repo y cambiar otro, declarado en `.tycon/advisors.yaml → evidence.companion_repos` (el
 * repo hermano). Sin esto, el pipeline mira sólo `--repo` en seis lugares: la detección de React, los
 * disparadores por líneas agregadas, el contexto de los revisores, el portón de pruebas, el delta de las vueltas y las
 * pruebas propias (una story de un producto del equipo, con el código en otro repo). Este módulo es lo
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

// El entorno de cada git que pregunta por un hermano: sin el GIT_DIR, el GIT_WORK_TREE y compañía que llegan adentro de
// un gancho de git o de un guion de otro repo (con ellos, `git -C <hermano>` contesta por ese otro repo), y con el idioma
// fijo, porque los errores se leen por su texto.
const entornoDeGit = () => {
  const cge = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js'));
  return cge.idiomaFijo(cge.sinGitDelPadre());
};

/**
 * La ruta real (enlaces resueltos; en macOS /tmp ↔ /private/tmp). Si no existe (un archivo borrado en el diff, o uno
 * que la story todavía va a crear), la real del ancestro que sí existe más el resto tal cual — la misma regla que
 * `verificarPruebasPropias` de marker.js. Sin esto, la ruta quedaría sin resolver: bajo un enlace, un archivo borrado del
 * repo saldría «de otro repo» con una ruta `../../../../tmp/…`.
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
 * existe» se leería igual que «no hay hermanos». Un error al leer la config
 * NO se traga: sube a quien llama.
 * `opts.onWarning(aviso, repoQueLoDeclara)`: cómo se resolvió un hermano que no está al lado (lo encontró en la raíz de
 * repos, o por qué no).
 */
function companionRoots(repo, storyPath, opts) {
  if (!repo) return [];
  const fuentes = [repo];
  const repoDeLaStory = storyPath ? discoverRepoRoot(storyPath) : null;
  if (repoDeLaStory && !mismo(repoDeLaStory, repo)) fuentes.push(repoDeLaStory);
  const vistos = new Set([real(repo)]);
  const out = [];
  const rama = ramaDe(repoDeLaStory || repo);
  const numero = numeroDeLaStory(storyPath);
  for (const f of fuentes) {
    const cfg = parseEvidenceConfig(f);
    if (opts && typeof opts.onMissing === 'function') for (const m of cfg.missing) opts.onMissing(m, f);
    if (opts && typeof opts.onWarning === 'function') for (const w of cfg.warnings) opts.onWarning(w, f);
    for (const r of cfg.roots) {
      const k = enLaMismaRama(real(r), rama, numero);
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * La rama en que está un repo, o null (cabeza suelta, o git que no contesta). Se recuerda por carpeta y huella
 * (lib/git-stamp.js): varios lugares de un mismo comando preguntan por los mismos hermanos. Un fallo no se recuerda.
 */
const RAMAS = new Map();
function ramaDe(dir) {
  if (!dir) return null;
  return require('./git-stamp.js').memo(RAMAS, dir, 'rama', () => {
    const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env: entornoDeGit() });
    // salida 1 con -q = cabeza suelta; cualquier otra cosa es git que no contestó, y se dice
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      avisar(`no pude leer la rama de ${dir} (${(r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`}): los repos hermanos se leen como están declarados`);
      return { valor: null, recordar: false };
    }
    const b = r.status === 0 ? String(r.stdout || '').trim() : '';
    return { valor: b || null, recordar: true };
  });
}
/** Olvida las ramas recordadas (para las pruebas: la huella ya cubre un repo que cambia). */
function limpiarRamas() { RAMAS.clear(); }

// Cada aviso, una vez por proceso: varios lugares de un mismo comando preguntan por los mismos hermanos.
const AVISADOS = new Set();
function avisar(texto) {
  if (AVISADOS.has(texto)) return;
  AVISADOS.add(texto);
  process.stderr.write(`[hermanos] ⚠️  ${texto}\n`);
}

/**
 * El número de la story (`1.4`, `CA-3`), o null: sin story legible, o sin número. El campo `story:` manda; sin él, el
 * número del nombre del archivo (`story-1-4-x.md`, `1.4-x.md` → `1.4`). Un nombre sin número no se busca en las ramas.
 */
function numeroDeLaStory(storyPath) {
  if (!storyPath) return null;
  let fm;
  try { fm = (fs.readFileSync(storyPath, 'utf8').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''; } catch { return null; }
  const campo = fm.match(/^story:\s*["']?([A-Za-z0-9][\w.-]*)/m);
  if (campo) return /\d/.test(campo[1]) ? campo[1] : null;
  const nombre = path.basename(storyPath, '.md').match(/^(?:story[-_])?(\d+(?:[.-]\d+)+)(?:$|[-_])/i);
  return nombre ? nombre[1].replace(/-/g, '.') : null;
}

/**
 * ¿La rama nombra a la story? Las partes del número, con `.`, `-` o `_` indistintos entre ellas y sin distinguir
 * mayúsculas (`1.4` en `feature/<nombre>-1-4-<nombre>`, `CA-3` en `feature/<nombre>-ca-3`), como palabra entera y no como parte de un
 * número más largo: `1.4` no es `11-4`, `1-45`, `1.4.2` ni `2-1-4`.
 */
function ramaNombraLaStory(rama, numero) {
  if (!rama || !numero || !/\d/.test(numero)) return false;
  const partes = String(numero).toLowerCase().split(/[._-]+/).filter(Boolean)
    .map((p) => p.replace(/[^a-z0-9]/g, ''));
  if (!partes.length || partes.some((p) => !p)) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${partes.join('[._-]')}(?=$|[^a-z0-9])`, 'g');
  const r = String(rama).toLowerCase();
  for (let m = re.exec(r); m; m = re.exec(r)) {
    const desde = m.index + (/^[a-z0-9]/.test(m[0]) ? 0 : 1);
    const hasta = m.index + m[0].length;
    if (/\d[._-]$/.test(r.slice(0, desde)) || /^[._-]\d/.test(r.slice(hasta))) continue;
    return true;
  }
  return false;
}

// La carpeta de un worktree → la ruta con que la declara `.tycon/advisors.yaml` (su `label` es el nombre de ésa, y las
// rutas `../<hermano>/x` de la story se resuelven contra ella).
const DECLARADO = new Map();

/**
 * El hermano declarado, o su worktree en la rama de la story. Desde el worktree de una story, `../<hermano>` es el
 * checkout compartido (en `main`), no el código que la story cambió: el portón probaba otra cosa.
 * Primero, el worktree de la rama de mismo nombre. Si no hay, el ÚNICO worktree en disco cuya rama nombra la story
 * (`numero`): las ramas de las specs y del código suelen llamarse distinto (`docs/…-1-4-impl` y `feat/…-1-4-…`). Con dos
 * o más candidatos no se adivina: el mismo número se repite entre carpetas de specs de un producto. Toda elección que
 * no sea la de mismo nombre se dice en una línea, y también la caída al declarado cuando está en otra rama.
 * Con la cabeza suelta no hay rama de mismo nombre, pero el número de la story sigue eligiendo: un clon de prueba del
 * repo de la story, en un commit suelto, tomaba el checkout compartido aunque la story tuviera su worktree. Sin rama
 * ni número, el declarado tal cual.
 */
function enLaMismaRama(declarado, rama, numero) {
  if (!rama && !numero) return declarado;
  const deLaStory = rama ? `la rama ${rama}` : `la story ${numero}`;
  // Un declarado que no es un repo git no tiene ramas ni worktrees: se usa tal cual y se dice una vez, con el motivo
  // exacto (suele ser una ruta mal declarada). Cualquier otra falla de git (un .git roto) sigue al aviso de abajo.
  const env = entornoDeGit();
  const repo = spawnSync('git', ['-C', declarado, 'rev-parse', '--git-dir'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  if (!repo.error && repo.status !== 0 && /not a git repository/i.test(String(repo.stderr || ''))) {
    avisar(`no pude listar los worktrees de ${declarado}: no es un repo git, uso la carpeta tal cual (¿la ruta de companion_repos está bien declarada?)`);
    return declarado;
  }
  const r = spawnSync('git', ['-C', declarado, 'worktree', 'list', '--porcelain'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  if (r.error || r.status !== 0) {
    avisar(`no pude listar los worktrees de ${declarado} (${(r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`}): uso el declarado, que puede no ser el código de ${deLaStory}`);
    return declarado;
  }
  // Un hermano declarado como subcarpeta de su repo es esa subcarpeta también en el worktree.
  const top = spawnSync('git', ['-C', declarado, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  if (top.error || top.status !== 0) {
    avisar(`no pude leer la raíz git de ${declarado} (${(top.error && (top.error.code || top.error.message)) || String(top.stderr || '').trim().split('\n')[0] || `git salió ${top.status}`}): uso el declarado, que puede no ser el código de ${deLaStory}`);
    return declarado;
  }
  const raiz = real(String(top.stdout || '').trim());
  const sub = path.relative(raiz, declarado);
  const elegir = (ruta) => {
    const wt = real(path.join(ruta, sub));
    if (wt !== declarado) DECLARADO.set(wt, declarado);
    return wt;
  };
  const worktrees = String(r.stdout || '').split(/\n\s*\n/).map((bloque) => ({
    ruta: (bloque.match(/^worktree (.+)$/m) || [])[1],
    rama: (bloque.match(/^branch refs\/heads\/(.+)$/m) || [])[1],
  })).filter((w) => w.ruta && esDir(path.join(w.ruta, sub)));
  const nombre = path.basename(declarado);
  let mismoNombre = rama && worktrees.find((w) => w.rama === rama);
  // `main` no nombra a ninguna historia: el worktree en `main` suele ser el checkout compartido. Se elige por el nombre
  // sólo si está al día con su `origin/main` local y limpio; si no, como si la rama no tuviera nombre
  if (mismoNombre && rama === 'main' && !mainAlDia(mismoNombre.ruta)) {
    avisar(`${nombre}: el worktree en main ${real(mismoNombre.ruta)} no está al día con origin/main o tiene cambios: no lo elijo por el nombre de la rama`);
    mismoNombre = null;
  }
  if (mismoNombre) return rama === 'main' ? elegir(mismoNombre.ruta) : alDiaOVieja(mismoNombre, worktrees, nombre, elegir, null);
  const candidatos = worktrees.filter((w) => ramaNombraLaStory(w.rama, numero));
  if (candidatos.length === 1) {
    return alDiaOVieja(candidatos[0], worktrees, nombre, elegir,
      (wt) => `${nombre} se lee del worktree ${wt} (rama ${candidatos[0].rama}): es el único cuya rama nombra la story ${numero}`);
  }
  if (candidatos.length > 1) {
    avisar(`${nombre}: ${candidatos.length} worktrees nombran la story ${numero} (${candidatos.map((w) => `${real(w.ruta)} en ${w.rama}`).join(' · ')}): no elijo, uso el declarado ${declarado}`);
    return declarado;
  }
  const propio = worktrees.find((w) => real(w.ruta) === raiz);
  if (rama && propio && propio.rama && propio.rama !== rama) {
    avisar(`${nombre} se lee del checkout principal ${declarado}, que está en la rama ${propio.rama} (la story está en ${rama}): si el código de la story está en otro worktree, que su rama nombre la story`);
  }
  return declarado;
}

/**
 * El worktree elegido por la rama de la story, salvo que esa rama ya haya entrado entera a `main` y quedado atrás: un
 * portón que mide contra ella da rojos ya arreglados en `main`. Entonces, si hay un worktree en `main` al día
 * (`mainAlDia`), se usa ése y se dice. Una rama atrás con commits que `main` no tiene es el código de la story sin
 * mergear: se usa igual, y se dice cuánto está atrás. `porNumero(wt)` es el aviso de la elección por número, o null.
 */
function alDiaOVieja(w, worktrees, nombre, elegir, porNumero) {
  const d = atrasDeMain(w.ruta);
  if (d && d.atras > 0 && d.propios === 0 && d.limpio) {
    const alDia = worktrees.find((x) => x.rama === 'main' && mainAlDia(x.ruta));
    if (alDia) {
      const wt = elegir(alDia.ruta);
      avisar(`${nombre}: la rama ${w.rama} ya entró a main y está atrás de origin/main (${d.atras} commits): uso ${wt}, al día con main`);
      return wt;
    }
  }
  const wt = elegir(w.ruta);
  if (porNumero) avisar(porNumero(wt));
  if (!d) avisar(`${nombre}: no pude medir si la rama ${w.rama} está atrás de main: la uso igual`);
  else if (d.atras > 0) avisar(`${nombre} está ${d.atras} commits atrás de main (rama ${w.rama}, en ${wt}): un rojo puede ser algo ya arreglado`);
  return wt;
}

/**
 * Cuánto está `dir` atrás de su `origin/main` local, cuántos commits tiene que `main` no tiene y si está sin cambios:
 * `{ atras, propios, limpio }`, con lo que trajo el último `fetch` (no sale a la red). Sin `origin/main` no hay contra
 * qué medir: `atras` y `propios` en 0. Git que no contesta, null.
 */
function atrasDeMain(dir) {
  const env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre();
  const correr = (args) => spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  const estado = correr(['status', '--porcelain']);
  if (estado.error || estado.status !== 0) return null;
  const limpio = !String(estado.stdout || '').trim();
  const conOrigen = correr(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (!conOrigen.error && conOrigen.status === 1) return { atras: 0, propios: 0, limpio };
  if (conOrigen.error || conOrigen.status !== 0) return null;
  const r = correr(['rev-list', '--left-right', '--count', 'refs/remotes/origin/main...HEAD']);
  const m = !r.error && r.status === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(String(r.stdout || '')) : null;
  return m ? { atras: Number(m[1]), propios: Number(m[2]), limpio } : null;
}

/**
 * ¿El checkout en `dir` está en el mismo commit que su `origin/main` local y sin cambios? Sin `fetch`: la elección no
 * sale a la red. Un repo sin `origin/main` (local, sin nada contra qué comparar) es «sí», como antes. Cualquier otra falla
 * de git es «no».
 */
function mainAlDia(dir) {
  // sin las variables de git del proceso: dentro de un gancho del commit, `GIT_INDEX_FILE` es el índice de otro repo
  const env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre();
  const correr = (args) => spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  const conOrigen = correr(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
  // `show-ref --verify --quiet` sale 1 si la referencia no está; otra salida es git que no contestó
  if (!conOrigen.error && conOrigen.status === 1) return true;
  if (conOrigen.error || conOrigen.status !== 0) return false;
  const commits = correr(['rev-parse', 'HEAD', 'refs/remotes/origin/main']);
  if (commits.error || commits.status !== 0) return false;
  const [head, origen] = String(commits.stdout || '').trim().split('\n');
  if (!head || head !== origen) return false;
  const estado = correr(['status', '--porcelain']);
  return !estado.error && estado.status === 0 && !String(estado.stdout || '').trim();
}

/**
 * ¿Su `origin/main` local cambió el archivo `abs` en commits que el checkout donde está no tiene? Sin `fetch`.
 * `{ commit }` con el más nuevo de esos commits, `{ commit: null }` si no (o sin `origin/main`: nada contra qué comparar),
 * `{ error }` si git no contestó: no se sabe si la copia es vieja.
 */
function mainCambioDespues(abs) {
  const env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).sinGitDelPadre();
  const dir = path.dirname(abs);
  const correr = (args) => spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env });
  const conOrigen = correr(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (!conOrigen.error && conOrigen.status === 1) return { commit: null };
  const motivo = (r) => (r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`;
  if (conOrigen.error || conOrigen.status !== 0) return { error: motivo(conOrigen) };
  // `:(literal)`: un nombre con `[ ] * ?` (una ruta `[id].tsx`) es ese archivo, no un comodín que nombra otros
  const r = correr(['log', '-1', '--format=%h', 'HEAD..refs/remotes/origin/main', '--', `:(literal)${path.basename(abs)}`]);
  if (r.error || r.status !== 0) return { error: motivo(r) };
  return { commit: String(r.stdout || '').trim() || null };
}

/** La raíz git que contiene un archivo o carpeta (la carpeta con `.git`), o null. */
function gitRootOf(p) {
  const r = discoverRepoRoot(p);
  return r ? real(r) : null;
}

/** Cómo se nombra un repo hermano para una persona y para el paso «Pase adversarial»: el nombre de su carpeta. */
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
  // sin esta guarda, `../<hermano>/ruta` —una forma que se promete en el contrato— se tomaría como del repo.
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
      // Adentro del hermano, como la guarda del repo: `sub/../../x` no empieza con `../` y sale de su raíz.
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
 * La raíz de `<repo>` en `(<repo>) <ruta>`, probando en orden: un hermano declarado con
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
 * story crea en el repo de la story, y no encontraba los suyos escritos con `<nombre>/`.
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

/**
 * Todos los archivos que la story declara (crear y modificar) que son de `targetRepo`, relativos a él. `targetRepo` es
 * el repo de la story o uno de sus hermanos. Un archivo que todavía no existe se ubica por su carpeta: es del repo
 * donde existe la carpeta que lo contiene (y, si no existe en ninguno, del repo de la story, como antes). Lo usa el
 * chequeo de mutantes: sin esto, una story que toca dos repos le pedía a cada uno las pruebas del otro y no medía en
 * ninguno.
 */
function declaredFor(storyRepo, storyPath, targetRepo) {
  const ts = require('./test-scope.js');
  const contenido = leerStory(storyPath);
  const propio = real(storyRepo);
  const objetivo = real(targetRepo);
  const comunDe = (dir) => {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env: entornoDeGit() });
    return r.status === 0 ? real(r.stdout.trim()) : null;
  };
  const comunObjetivo = objetivo === propio ? null : comunDe(objetivo);
  // otra copia (un worktree) del repo de la story: se mide con lo del repo de la story
  if (comunObjetivo && comunObjetivo === comunDe(propio)) return declaredFor(storyRepo, storyPath, storyRepo);
  // los hermanos que declaran el repo de la story y el medido (como el portón); el medido, si es otra copia de un
  // hermano, toma su lugar; y si no es ninguno de ellos, también cuenta: el portón lo eligió porque la story lo toca
  let companions = [...companionRoots(storyRepo, storyPath), ...(objetivo === propio ? [] : companionRoots(objetivo, storyPath))]
    .map((c) => real(c)).filter((c, i, a) => a.indexOf(c) === i && c !== propio);
  if (objetivo !== propio) {
    const i = companions.findIndex((c) => c === objetivo || (comunObjetivo && comunDe(c) === comunObjetivo));
    if (i >= 0) companions[i] = objetivo; else companions = [objetivo, ...companions];
  }
  const out = [];
  for (const d of ts.parseDeclaredFiles(contenido)) {
    let r;
    const prefijada = parseRepoPrefixed(d);
    if (prefijada) {
      // `(<repo>) <ruta>`: el repo lo dice la entrada
      const raiz = resolveRepoRef(prefijada.ref, storyRepo, companions).root;
      const rr = raiz ? real(raiz) : null;
      const deObjetivo = rr && (rr === objetivo || (comunObjetivo && comunDe(rr) === comunObjetivo));
      r = { where: rr === propio ? 'repo' : 'companion', root: deObjetivo ? objetivo : rr, rel: prefijada.rest.replace(/\\/g, '/').replace(/^\.\//, '') };
    } else {
      r = resolveDeclared(d, storyRepo, companions);
      if (r.where === null) r = porCarpeta(r.rel, storyRepo, companions);
    }
    const raiz = r.where === 'companion' ? r.root : propio;
    if (raiz === objetivo && r.rel && !out.includes(r.rel)) out.push(r.rel);
  }
  return out;
}

/** Un archivo declarado que todavía no existe: del repo donde está su carpeta, con las mismas formas que resolveDeclared. */
function porCarpeta(d, repo, companions) {
  const carpetaEn = (raiz, rel) => adentro(path.join(raiz, rel), raiz) && esDir(path.dirname(path.join(raiz, rel)));
  if (carpetaEn(repo, d)) return { where: 'repo', root: real(repo), rel: d };
  for (const c of companions || []) {
    const nombre = label(c);
    const candidatos = [d];
    if (d.startsWith(`${nombre}/`)) candidatos.push(d.slice(nombre.length + 1));
    const deRepo = path.resolve(repo, d);
    if (adentro(deRepo, c)) candidatos.push(path.relative(real(c), deRepo).split(path.sep).join('/'));
    for (const rel of candidatos) if (rel && carpetaEn(c, rel)) return { where: 'companion', root: real(c), rel };
  }
  return { where: null, root: null, rel: d };
}

const TOPE_DE_HUELLAS = 50;

/**
 * El nombre de un repo, igual en su checkout principal y en sus worktrees: la carpeta que tiene `.git`. Sin rutas absolutas,
 * porque el ancla viaja con la evidencia.
 */
function nombreDelRepo(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: entornoDeGit() });
  if (r.error || r.status !== 0) return null;
  const comun = path.resolve(dir, String(r.stdout).trim());
  return path.basename(path.basename(comun) === '.git' ? path.dirname(comun) : comun);
}

// Lo que el hermano tiene sin commitear, con la huella que tendría en git; `null` si el archivo se borró. Las rutas van desde la
// raíz del repo, como las da git: un hermano declarado como subcarpeta mira sólo lo suyo.
function huellasSinCommitear(raiz) {
  const top = spawnSync('git', ['-C', raiz, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: entornoDeGit() });
  if (top.error || top.status !== 0) return { motivo: 'no pude leer su raíz' };
  const repo = String(top.stdout).trim();
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: entornoDeGit() });
  const estado = git('status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', path.relative(repo, raiz) || '.');
  if (estado.error || estado.status !== 0) return { motivo: 'no pude leer sus cambios' };
  const lineas = String(estado.stdout).split('\0').filter(Boolean);
  if (lineas.length > TOPE_DE_HUELLAS) return { motivo: `tiene más de ${TOPE_DE_HUELLAS} archivos sin commitear` };
  const huellas = {};
  for (const linea of lineas) {
    const rel = linea.slice(3);
    // borrado es lo que git dice borrado; un archivo que no se puede leer no es un archivo borrado
    if (linea[0] === 'D' || linea[1] === 'D') { huellas[rel] = null; continue; }
    if (!esArchivo(path.join(repo, rel))) return { motivo: `no pude leer ${rel}` };
    const h = git('hash-object', '--', rel);
    if (h.error || h.status !== 0) return { motivo: `no pude leer ${rel}` };
    huellas[rel] = String(h.stdout).trim();
  }
  return { huellas };
}

/**
 * Lo que la evidencia probó en cada hermano del repo de la evidencia: `{ repo, commit, huellas? }`, o `{ repo, sinAncla }`.
 * Los hermanos salen de la configuración del repo, así que alcanza con el id de la historia. `historia`, su id o su ruta, sólo
 * sirve para elegir el worktree de su rama.
 */
function anclasDeLaEvidencia(repo, historia) {
  const numero = /\.md$/.test(historia || '') ? numeroDeLaStory(historia) : String(historia || '').split('__').pop();
  const rama = ramaDe(repo);
  return parseEvidenceConfig(repo).roots.map((declarado) => {
    const raiz = enLaMismaRama(real(declarado), rama, /\d/.test(numero || '') ? numero : null);
    const nombre = nombreDelRepo(raiz) || path.basename(raiz);
    const head = spawnSync('git', ['-C', raiz, 'rev-parse', '--verify', '-q', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, env: entornoDeGit() });
    const commit = head.status === 0 ? String(head.stdout).trim() : '';
    if (!commit) return { repo: nombre, sinAncla: 'no pude leer su commit' };
    const { huellas, motivo } = huellasSinCommitear(raiz);
    if (motivo) return { repo: nombre, sinAncla: motivo };
    return Object.keys(huellas).length ? { repo: nombre, commit, huellas } : { repo: nombre, commit };
  });
}

module.exports = {
  anclasDeLaEvidencia, nombreDelRepo,
  companionRoots, ramaDe, limpiarRamas, enLaMismaRama, mainAlDia, mainCambioDespues, ramaNombraLaStory, numeroDeLaStory, gitRootOf, label, ownerOf, groupByRepo, resolveDeclared, parseRepoPrefixed, resolveRepoRef,
  companionTargets, declaredHere, declaredIn, declaredFor, real,
};

if (require.main === module) {
  const [cmd, repo, story, otro] = process.argv.slice(2);
  if (cmd === 'anchors' && repo) {
    // Imprime el JSON de las anclas, y dice en stderr qué hermano quedó sin ancla. Falla callado hacia `[]`: la evidencia se lee como la vieja, y da rojo.
    let anclas = [];
    try { anclas = anclasDeLaEvidencia(repo, story); } catch (e) { process.stderr.write(`[hermanos] sin ancla: ${(e && e.message) || e}\n`); }
    for (const a of anclas) if (a.sinAncla) process.stderr.write(`[hermanos] ${a.repo} queda sin ancla: ${a.sinAncla}\n`);
    process.stdout.write(JSON.stringify(anclas));
    process.exit(0);
  }
  if (!['targets', 'declared-here', 'declared-in'].includes(cmd) || !repo || !story || (cmd === 'declared-in' && !otro)) {
    process.stderr.write('uso: companion-repos.js targets|declared-here <repo> <story.md>  ·  declared-in <repo-de-la-story> <story.md> <hermano>  ·  anchors <repo> [<id o ruta de la historia>]\n');
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
