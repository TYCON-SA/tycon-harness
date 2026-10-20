'use strict';
// team-local.js — la capa del equipo desde un repo git de LA MÁQUINA: el perfil de un dev que trabaja solo,
// armado con `harness.js team-init --local`, sin cuenta ni repo remoto. Lo que la capa ES (lista cerrada, declaración, perfil
// validado, apilado, estado, caché) vive en team.js, igual que para GitHub y Azure; acá sólo CÓMO se leen los objetos: con el
// git de la máquina, sobre el commit de `main`.
//
// Es una puerta de entrada de instrucciones a todas las sesiones de esa persona, así que se lee como un repo remoto, sin
// atajos: nunca la carpeta tal cual ni lo que está sin commitear; la lista del árbol del commit (su hash recalculado tiene que
// dar el del commit) → planTeam → judgeContent → cada archivo por su blob. git corre sin terminal y sin nada que el repo
// pueda hacer ejecutar: sin hooks, sin fsmonitor y sólo con comandos de lectura de objetos (rev-parse, ls-tree, cat-file).
// La carpeta tiene que ser la raíz del repo (o un repo bare): una carpeta suelta dentro de otro repo no lee el `main` de ése.
//
// Sólo `require` dentro de scripts/setup/harness/ al cargar; lo de ../../lib/ y team.js, al usarlos.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = (name) => require(path.join(__dirname, '..', '..', 'lib', name));
// team.js carga este archivo (al usarlo) y este archivo usa team.js: la vuelta se nombra por ruta armada (como team-azure.js)
// para que la copia fija de arranque no vea un ciclo
const team = () => require(path.join(__dirname, 'team.js'));

const TEAM_REF = 'main';
const SHA40 = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
// lo que el repo podría hacer ejecutar al leerlo, apagado en cada llamada (la configuración del repo es de la persona, pero
// la lee un proceso del arnés); y ninguna variable de git de quien llama decide qué repo se lee
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never'];
const DROP_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER'];

const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const nowIso = () => new Date().toISOString();

function gitEnv(env) {
  const out = Object.assign({}, env);
  for (const k of DROP_ENV) delete out[k];
  for (const k of Object.keys(out)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k];
  return Object.assign(out, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });
}

/** Un comando de git sobre el repo: `{ ok, out (Buffer), err }`. Nunca tira. */
function run(c, args, { buffer = false } = {}) {
  const r = spawnSync('git', ['-C', c.dir, ...SAFE, ...args], { env: c.env, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BLOB_BYTES + 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' });
  const why = r.error ? `no arrancó: ${r.error.code || r.error.message}` : r.signal ? `cortado con la señal ${r.signal}` : '';
  const err = [String(r.stderr || '').trim().split('\n').slice(-2).join(' '), why].filter(Boolean).join(' · ');
  return { ok: !r.error && !r.signal && r.status === 0, out: r.stdout, err };
}

/**
 * Abre la fuente: la carpeta existe y es una carpeta. Si es un repo se mira al resolver (ahí se dice «no es un repo git»).
 * `{ ok, c }` o `{ ok: false, reason }`.
 */
function open(src, { env = process.env } = {}) {
  let real;
  try { real = fs.realpathSync(src.repo); } catch (e) { return { ok: false, reason: `capa del equipo (${src.repo}): la carpeta no existe (${e.code || e.message})` }; }
  try { if (!fs.statSync(real).isDirectory()) return { ok: false, reason: `capa del equipo (${src.repo}): no es una carpeta` }; } catch (e) { return { ok: false, reason: `capa del equipo (${src.repo}): no se puede leer (${e.code || e.message})` }; }
  return { ok: true, c: { src, dir: real, env: gitEnv(env) } };
}

/** ¿La carpeta es la raíz de un repo (o un repo bare)? `null` si sí; el motivo, si no. */
function notARepo(c) {
  const bare = run(c, ['rev-parse', '--is-bare-repository']);
  if (!bare.ok) return `no es un repo git (${bare.err || 'git no lo reconoce'}): el perfil local se arma con harness.js team-init --local`;
  if (String(bare.out).trim() === 'true') {
    const gd = run(c, ['rev-parse', '--absolute-git-dir']);
    let real = null; try { real = gd.ok ? fs.realpathSync(String(gd.out).trim()) : null; } catch (_) { /* sin carpeta */ }
    return real === c.dir ? null : 'no es un repo git en esa carpeta: es una carpeta dentro de otro repo';
  }
  const top = run(c, ['rev-parse', '--show-toplevel']);
  let real = null; try { real = top.ok ? fs.realpathSync(String(top.out).trim()) : null; } catch (_) { /* sin carpeta */ }
  return real === c.dir ? null : `no es un repo git en esa carpeta: está dentro del repo ${real || 'de otra carpeta'}, y la capa sólo se lee de la raíz de su propio repo`;
}

/** El contenido de un blob por su sha: `{ ok, buf, blob }`, verificado por el sha recalculado. */
function blobAt(c, sha) {
  if (!SHA40.test(String(sha))) return { ok: false, status: 'blocked', reason: `un archivo de la lista no tiene forma de blob (${JSON.stringify(String(sha).slice(0, 48))})` };
  const r = run(c, ['cat-file', 'blob', sha], { buffer: true });
  if (!r.ok) return { ok: false, status: 'blocked', reason: `git no pudo leer el blob ${sha7(sha)} (${r.err})` };
  const blob = team().blobOf(r.out);
  if (blob !== sha) return { ok: false, status: 'blocked', reason: `el blob ${sha7(sha)} que git devolvió no es el que la lista declara (${sha7(blob)}): no se usa` };
  return { ok: true, buf: r.out, blob };
}

/**
 * Resuelve y valida la capa SIN escribir ni registrar (la misma forma que `team.resolveTeam` y `team-azure.resolve`): la rama
 * `main`, su commit y su árbol, la lista del árbol (lista cerrada; su hash recalculado tiene que dar el del commit), la
 * declaración y el perfil.
 */
function resolve(c, { version, readerTree, deferReaders = false, home, env = process.env, knownCommits = [] } = {}) {
  const T = team();
  const src = c.src;
  const head = `capa del equipo (${src.repo})`;
  const nr = notARepo(c);
  if (nr) return { ok: false, status: 'blocked', missing: 'team', reason: `${head}: ${nr}` };
  // el arnés lee objetos sha1 (los hashes de la capa, la caché y el estado son de 40 hexadecimales): un repo sha256 se dice
  // como tal, no como «sin la rama main»
  const fmt = run(c, ['rev-parse', '--show-object-format']);
  if (fmt.ok && String(fmt.out).trim() && String(fmt.out).trim() !== 'sha1') return { ok: false, status: 'blocked', reason: `${head}: el repo usa objetos ${String(fmt.out).trim()} y el arnés lee repos sha1. Armalo de nuevo con git init --object-format=sha1 (team-init --local ya lo hace) y copiá los archivos` };
  const ref = run(c, ['rev-parse', '--verify', '--quiet', `refs/heads/${TEAM_REF}^{commit}`]);
  const commit = ref.ok ? String(ref.out).trim() : '';
  // `--quiet` sin la rama sale 1 sin decir nada; cualquier otra cosa (un git que no arrancó, el tiempo) es otra falla y se dice
  if (!ref.ok && ref.err) return { ok: false, status: 'unknown', reason: `${head}: git no pudo leer la rama ${TEAM_REF} (${ref.err})` };
  if (!SHA40.test(commit)) return { ok: false, status: 'blocked', missing: 'team', reason: `${head}: el repo no tiene la rama ${TEAM_REF} con un commit; la capa se lee de refs/heads/${TEAM_REF} (hacé el commit en ${TEAM_REF})` };
  if (Array.isArray(knownCommits) && knownCommits.includes(commit)) return { ok: true, unchanged: true, repo: src.repo, host: 'local', commit, etag: null };
  const tr = run(c, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  const tree = tr.ok ? String(tr.out).trim() : '';
  if (!SHA40.test(tree)) return { ok: false, status: 'blocked', reason: `${head}: el commit ${sha7(commit)} no tiene un árbol legible (${tr.err || 'sin árbol'}): no se usa` };
  const ls = run(c, ['ls-tree', '-r', '-t', '-l', '--full-tree', '-z', commit]);
  if (!ls.ok) return { ok: false, status: 'blocked', reason: `${head}: git no pudo listar el árbol ${sha7(tree)} (${ls.err})` };
  const entries = [];
  for (const rec of String(ls.out).split('\0').filter(Boolean)) {
    // <modo> SP <tipo> SP <sha> SP+ <tamaño o -> TAB <ruta>
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}) +(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (!m) return { ok: false, status: 'blocked', reason: `${head}: la lista del árbol ${sha7(tree)} trae una entrada sin forma: no se usa` };
    entries.push({ path: m[5], mode: m[1], type: m[2], sha: m[3], size: m[4] === '-' ? 0 : Number(m[4]) });
  }
  const GH = lib('git-tree-hash.js');
  const leaves = entries.filter((e) => e.type !== 'tree').map((e) => ({ mode: e.mode, path: e.path, sha: e.sha }));
  const recomputed = leaves.length ? GH.treeSha(leaves) : null;
  if (recomputed !== tree) return { ok: false, status: 'blocked', reason: `${head}: la lista del árbol no da el árbol del commit ${sha7(commit)} (${sha7(recomputed)} ≠ ${sha7(tree)}): no se usa` };
  const plan = T.planTeam(entries, { truncated: false });
  if (!plan.ok) return { ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: no se apila — ${plan.problems.map((p) => `${p.path}: ${p.reason}`).join(' · ')}` };
  const judged = T.judgeContent(plan, (p, sha) => blobAt(c, sha), { version, readerTree, deferReaders, home, env, head, commit });
  if (!judged.ok) return judged;
  return { ok: true, repo: src.repo, host: 'local', ref: TEAM_REF, commit, tree, etag: null, files: plan.files, declaration: judged.declaration, declarationSha: plan.declaration ? plan.declaration.sha : null, totalBytes: plan.totalBytes, profileEntries: judged.profileEntries, readersDeferred: judged.readersDeferred, stagedDir: judged.dir, notes: plan.notes };
}

/**
 * Copia los archivos de la capa resuelta (cada uno verificado por su blob) a `~/.tycon/team/<commit>/` con su manifiesto; con
 * la caché entera del mismo repo y commit, no lee nada. La misma forma que `team.fetchTeam`.
 */
function fetch(c, resolved, { env = process.env, log = null } = {}) {
  const T = team();
  if (!SHA40.test(String(resolved.commit)) || !SHA40.test(String(resolved.tree))) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): el commit o el árbol resueltos no tienen forma de sha: no se copia nada` };
  const cacheDir = T.cacheDirOf(env, resolved.commit);
  const m = T.readTeamManifest(cacheDir);
  if (m && m.commit === resolved.commit && m.repo === resolved.repo && m.tree === resolved.tree) {
    const intact = T.filesIntact(cacheDir, resolved.files.map((f) => ({ path: f.path, mode: f.mode, blob: f.sha })));
    if (intact) { if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} desde la caché (${intact.length} archivo(s))`); T.dropStaged(resolved.stagedDir); return { ok: true, cacheDir, files: intact, fromCache: true, resolved }; }
  }
  const staged = [];
  for (const f of resolved.files) {
    const it = blobAt(c, f.sha);
    if (!it.ok) { T.dropStaged(resolved.stagedDir); return Object.assign(it, { reason: `capa del equipo (${resolved.repo}): ${f.path}: ${it.reason}` }); }
    staged.push({ path: f.path, mode: f.mode || '100644', blob: it.blob, buf: it.buf });
  }
  const declSha = SHA40.test(String(resolved.declarationSha || '')) ? resolved.declarationSha : null;
  const decl = declSha ? blobAt(c, declSha) : null;
  T.dropStaged(resolved.stagedDir);
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const s of staged) { const to = path.join(cacheDir, ...s.path.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, s.buf); }
    if (decl && decl.ok) fs.writeFileSync(path.join(cacheDir, T.DECLARATION), decl.buf);
    const files = staged.map((s) => ({ path: s.path, mode: s.mode, blob: s.blob }));
    const manifest = { schema: 1, repo: resolved.repo, host: 'local', ref: resolved.ref, commit: resolved.commit, tree: resolved.tree, etag: null, name: resolved.declaration.name, requires: resolved.declaration.requires, files, ...(decl && decl.ok ? { declaration_blob: declSha } : {}), fetched_at: nowIso() };
    fs.writeFileSync(path.join(cacheDir, T.MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
    if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} leída del repo local y verificada en ${cacheDir} (${files.length} archivo(s), árbol ${sha7(resolved.tree)})`);
    return { ok: true, cacheDir, files, fromCache: false, resolved };
  } catch (e) {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) { /* queda; la próxima la rehace */ }
    return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): no pude escribir la caché en ${cacheDir} (${e.code || e.message})` };
  }
}

module.exports = { open, resolve, fetch, TEAM_REF };
