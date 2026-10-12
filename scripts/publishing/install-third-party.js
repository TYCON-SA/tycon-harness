#!/usr/bin/env node
'use strict';
// install-third-party.js — el paso del instalador que restituye las skills de terceros (story 8.5 · 2026-09-29)
//
// POR QUÉ EXISTE: lo ajeno sale del árbol de agent-skills (se referencia, no se copia) y cada máquina tiene que seguir
// teniendo, carpeta por carpeta, el mismo contenido. El manifiesto (third-party-skills.json) fija cada skill por commit
// y por hash de árbol de git; este paso la pone en su lugar.
//
// DE DÓNDE, en este orden (AC 12):
//   1. La historia de git LOCAL de agent-skills: si el objeto `tree` está en el clon —el caso de toda máquina que lo tuvo
//      versionado—, sin red. El pull del retiro borra los archivos pero no los objetos.
//   2. El `origin` en su `commit` y `path`, menos `omit`, con `mode_fixes`: se baja a un temporal y se verifica que dé
//      `tree` ANTES de escribir. Un origen que no lo da no se instala («el origen no coincide»). Sólo con el retiro hecho:
//      mientras lo ajeno siga versionado, no hay nada que bajar (criterio aprobado de la tanda A).
//   3. Ninguna: se dice cuál de tres cosas pasó —no pude preguntar, el origen no existe, el commit ya no está—, el disco
//      queda como estaba y el próximo arranque reintenta.
//
// LO QUE NUNCA HACE (AC 13-16): borrar; pisar un archivo que no escribió él (uno distinto se nombra como «modificado
// localmente»; lo que no pertenece a la entrada ni se mira); dejar un archivo a medias (temporal + renombre); escribir
// con otro paso corriendo (cerrojo); pasar el tope de red (TYCON_THIRD_PARTY_NETWORK_BUDGET_S, 20 s: la extensión de
// VS Code se rinde a los 60 s de arranque). Nunca baja una propietaria: esas vienen con el plugin oficial (AC 17).
//
// EL PULL DEL RETIRO, TRABADO (AC 27): si el retiro borró un archivo ajeno que el dev tenía modificado, el pull con
// --autostash de la línea de arranque deja el índice en conflicto y ningún pull vuelve a entrar. El paso saca del índice
// SÓLO esas rutas (el archivo del dev queda en el disco, el stash también); cualquier otro conflicto lo nombra y no lo toca.
//
// SALIDA: todo aviso por stdout (la línea de arranque descarta stderr) y siempre exit 0: un paso de arranque no frena
// la sesión. Al día no dice nada. Apagado (TYCON_THIRD_PARTY=0) lo dice en una línea.
//
// ESTADO: ~/.claude/.tycon-pipeline/third-party-state.json — qué árbol quedó en cada destino, el hash de cada archivo
// y si lo escribió el paso; con el tamaño y la fecha de cada archivo no vuelve a leer lo que no cambió (así el arranque
// al día tarda milisegundos). Avisos una vez por día.
//
// A mano:
//   node scripts/publishing/install-third-party.js [--repo <agent-skills>] [--manifest <json>] [--check]
//   --check: dice qué falta, sin escribir nada.
// Sólo para pruebas: TYCON_THIRD_PARTY_TEST_CUT_AFTER=<n> (se corta solo después del n-ésimo archivo) y
// TYCON_THIRD_PARTY_TEST_DELAY_MS=<ms> (espera antes de cada archivo).

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadManifest, DEFAULT_MANIFEST } = require('./third-party-coverage.js');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const TAG = 'skills de terceros';
const TMP_MARK = '.tycon-tmp';
const LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_BUDGET_S = 20;

const say = (line) => process.stdout.write(`${line}\n`);
const today = () => new Date().toISOString().slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── hashes de git, calculados acá (sin escribir objetos en ningún repo) ─────────────────────────────────────────────
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
// story 8.23 (tanda B): el hash de git vive en scripts/lib/git-tree-hash.js —lo usa también la versión bajada como
// comprimido— y acá se re-exporta tal cual (tar-reader.test.js lo comprueba)
const { blobSha, treeSha } = require('../lib/git-tree-hash.js');

// ── git ────────────────────────────────────────────────────────────────────────────────────────────────────────
function git(cwd, args, { input, timeout, binary = false } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    input, timeout, encoding: binary ? undefined : 'utf8', maxBuffer: 1024 * 1024 * 1024,
    // mensajes de git en inglés siempre: la clasificación de fallas (no-network / no-origin / missing-commit) los lee
    env: sinGitDelPadre({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', LANGUAGE: '' }),
  });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const stderr = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8') : (r.stderr || '');
  return { status: r.status, stdout: r.stdout, stderr: r.error && !timedOut ? `${r.error.message} ${stderr}` : stderr, timedOut };
}
/** Qué árboles están en el clon (una sola llamada para todos). */
function presentTrees(repo, trees) {
  if (!trees.length) return new Set();
  const r = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${trees.join('\n')}\n` });
  const present = new Set();
  if (r.status === 0) for (const l of r.stdout.split('\n')) { const [sha, type] = l.split(' '); if (type === 'tree') present.add(sha); }
  return present;
}
function listTree(repo, treeish) {
  const r = git(repo, ['ls-tree', '-r', '-z', treeish]);
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    return { mode, type, sha, path: rec.slice(tab + 1) };
  });
}
/** Contenido de blobs por sha, en una sola llamada. Un sha que falta no aparece en el mapa. */
function readBlobs(repo, shas) {
  const out = new Map();
  if (!shas.length) return out;
  const r = git(repo, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, binary: true });
  if (r.status !== 0 || !r.stdout) return out;
  const buf = r.stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const [sha, type, size] = buf.slice(i, nl).toString('utf8').split(' ');
    if (type === 'missing' || size === undefined) { i = nl + 1; continue; }
    const n = Number(size);
    out.set(sha, buf.slice(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return out;
}

// ── el origen ──────────────────────────────────────────────────────────────────────────────────────────────────
function classifyFetchError(stderr) {
  const s = stderr.toLowerCase();
  if (/not our ref|couldn't find remote ref|no such remote ref|unadvertised object|did not send all necessary objects|not a valid object|is not a commit/.test(s)) return 'missing-commit';
  if (/repository not found|does not appear to be a git repository|could not read username|authentication failed|returned error: 40[34]|no such file or directory/.test(s)) return 'no-origin';
  return 'no-network';
}
const FAILURE_TEXT = {
  'no-network': () => 'no pude preguntar al origen',
  'no-origin': () => 'el origen no existe (o no es público)',
  'missing-commit': (e) => `el commit ${e.commit.slice(0, 12)} ya no está en el origen`,
};

// ── estado, cerrojo y escritura ────────────────────────────────────────────────────────────────────────────────
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, entries: s.entries || {}, notices: s.notices || {} };
  } catch {
    return { version: 1, entries: {}, notices: {} };
  }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}${TMP_MARK}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(tmp, file);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function takeLock(lockDir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      let age = 0;
      try { pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* a medio crear: se juzga por la edad */ }
      if (pid && alive(pid) && age < LOCK_STALE_MS) return false;
      if (!pid && age < 5000) return false;
      fs.rmSync(lockDir, { recursive: true, force: true }); // de un paso que murió (o un corte): se pisa
    }
  }
  return false;
}
let written = 0;
function writeAtomic(abs, content, mode) {
  const delay = Number(process.env.TYCON_THIRD_PARTY_TEST_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TMP_MARK}-${process.pid}`;
  const perm = mode === '100755' ? 0o755 : 0o644;
  fs.writeFileSync(tmp, content, { mode: perm });
  fs.chmodSync(tmp, perm);
  fs.renameSync(tmp, abs);
  written++;
  const cut = Number(process.env.TYCON_THIRD_PARTY_TEST_CUT_AFTER || 0);
  if (cut > 0 && written === cut) process.kill(process.pid, 'SIGKILL');
}
/** Temporales que dejó un paso cortado a mitad en este destino (son del paso por el nombre). */
function sweepTemps(dir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) sweepTemps(abs);
    else if (it.name.includes(`${TMP_MARK}-`)) {
      const pid = Number(it.name.split(`${TMP_MARK}-`).pop());
      if (!pid || !alive(pid) || pid === process.pid) fs.rmSync(abs, { force: true });
    }
  }
}
const isExec = (st) => (st.mode & 0o111) !== 0;
const statKey = (st) => ({ size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino });
/** El hash del contenido en el disco; si sólo difiere del esperado en los fines de línea (CRLF de core.autocrlf), cuenta
 *  como el esperado: git lo ve igual, y el paso no puede decir «modificado» por la configuración de git del dev. */
function effectiveBlob(buf, expected) {
  const raw = blobSha(buf);
  if (raw === expected || !buf.includes(0x0d)) return raw;
  return blobSha(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === expected ? expected : raw;
}
/** El primer enlace simbólico en el camino desde el repo hasta `rel` (inclusive), o null. */
function symlinkOnPath(repo, rel) {
  let cur = repo;
  for (const seg of rel.split('/').filter((s) => s && s !== '.')) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; } // lo que no existe todavía no es un enlace
    if (st.isSymbolicLink()) return path.relative(repo, cur);
  }
  return null;
}
/** Lo que hay en el disco bajo `dir` como lista de árbol (null si falta o trae enlaces: no se adopta). */
function diskListing(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) walk(abs, r);
      else if (it.isFile()) { const st = fs.statSync(abs); out.push({ mode: isExec(st) ? '100755' : '100644', type: 'blob', sha: blobSha(fs.readFileSync(abs)), path: r }); }
      else throw new Error('link');
    }
  };
  try { walk(dir, ''); } catch { return null; }
  return out;
}
/** Una ruta relativa, sin `.`/`..`/segmentos vacíos ni `.git`, que resuelta queda dentro de `dest`. */
function insideTarget(dest, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..' || s === '.git')) return false;
  const base = path.resolve(dest);
  return path.resolve(base, rel).startsWith(`${base}${path.sep}`);
}

// ── una versión bajada: verificar, no restituir (story 8.23, tanda G · AC 42) ──────────────────────────────────
// el manifiesto de la instalación bajada (scripts/setup/harness/release.js, MANIFEST_NAME): escrito acá para que esta pieza
// siga corriendo suelta (los laboratorios copian carpetas de scripts/ sin scripts/setup/)
const RELEASE_MANIFEST = '.tycon-release.json';
/**
 * Cada entrada `download` del manifiesto, contra el disco del árbol bajado: presente y dando el árbol declarado. Entera:
 * no dice nada (al día no se habla). Si falta alguna o su contenido no da el árbol: UNA línea que las nombra y la acción
 * (quien repone es `harness.js update`, que vuelve a bajar y restituir). Nunca escribe; nunca llama a git.
 */
function checkReleaseTree(repo, manifest, { home = os.homedir(), env = process.env } = {}) {
  // la caché de la bajada (~/.tycon/third-party/<commit>/<destino>): su manifiesto trae cada archivo con su hash. Con
  // ella la comparación es por CONTENIDO, archivo por archivo; sin ella, por el hash de árbol, probando los modos
  // posibles del disco (los modos no viajan a Windows, y la bajada deja un ejecutable con 755 donde el manifiesto declara
  // 644 vía mode_fixes: comparar modos daba un aviso falso en cada arranque — pase adversarial de la tanda G, clase 8)
  let cacheRoot = null;
  try { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); if (fs.existsSync(lib)) cacheRoot = require(lib).ownPaths({ env }).thirdParty; } catch { cacheRoot = null; }
  const problems = [];
  for (const e of manifest.thirdParty.filter((x) => x.install === 'download')) {
    const dest = path.join(repo, e.target);
    if (!fs.existsSync(dest)) { problems.push(`${e.target} (falta entera)`); continue; }
    const onDisk = diskListing(dest);
    if (!onDisk) { problems.push(`${e.target} (no se puede leer, o trae un enlace)`); continue; }
    let cached = null;
    if (cacheRoot && e.commit) {
      try { cached = JSON.parse(fs.readFileSync(path.join(cacheRoot, String(e.commit).slice(0, 12), String(e.target).replace(/[\\/]/g, '__'), RELEASE_MANIFEST), 'utf8')); } catch { cached = null; }
    }
    if (cached && Array.isArray(cached.files) && cached.tree === e.tree) {
      const want = cached.files.map((f) => `${f.path}\t${f.blob}`).sort().join('\n');
      const got = onDisk.map((f) => `${f.path}\t${f.sha}`).sort().join('\n');
      if (want !== got) problems.push(`${e.target} (su contenido no da el árbol declarado)`);
      continue;
    }
    const fixes = new Map((e.mode_fixes || []).map((f) => [f.file, f.mode]));
    const variants = [
      onDisk,
      onDisk.map((f) => (fixes.has(f.path) ? Object.assign({}, f, { mode: fixes.get(f.path) }) : f)),
      onDisk.map((f) => Object.assign({}, f, { mode: fixes.get(f.path) || '100644' })),
    ];
    if (!variants.some((v) => treeSha(v) === e.tree)) problems.push(`${e.target} (su contenido no da el árbol declarado)`);
  }
  if (!problems.length) return;
  say(`⚠ ${TAG}: en la versión bajada ${repo} ${plural(problems.length, 'skill de terceros no está como la declara su manifiesto', 'skills de terceros no están como las declara su manifiesto')}: ${problems.slice(0, 5).join(', ')}${problems.length > 5 ? ` y ${problems.length - 5} más` : ''} — las repone harness.js update (si la versión ya está al día, igual vuelve a restituir lo que falta); este paso no escribe en una versión bajada`);
}

// ── el paso ────────────────────────────────────────────────────────────────────────────────────────────────────
// ── el pull del retiro, trabado ────────────────────────────────────────────────────────────────────────────────
/** Una ruta o una carpeta lista para pegar en la shell: tal cual si es `[\w./-]+`; si no, entre comillas simples (la misma
 *  regla que el aviso de arranque, branch-guard-notice.js, que tiene su copia: el banco lo prueba como archivo suelto). */
function sh(s) {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
/** Las rutas en conflicto del índice, con sus etapas (1 base · 2 la de HEAD · 3 la otra), o null si git falló. */
function unmergedPaths(repo) {
  const r = git(repo, ['ls-files', '-u', '-z']);
  if (r.status !== 0) return null;
  const byPath = new Map();
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const p = rec.slice(tab + 1);
    if (!byPath.has(p)) byPath.set(p, new Set());
    byPath.get(p).add(rec.slice(0, tab).split(' ')[2]);
  }
  return byPath;
}
/** AC 27: la línea de arranque trae el retiro con `pull --ff-only --autostash`. Si el retiro borró un archivo ajeno que
 *  el dev tenía modificado, git sale 0 pero deja el índice en conflicto (DU: HEAD lo borró, el stash lo modificó) y desde
 *  ahí ningún pull entra — en silencio, porque la línea descarta los errores. Se destraba SÓLO ese caso: cada conflicto
 *  es DU bajo un destino de third_party, el stash de arriba es un autostash y los trae a todos. Se sacan del índice
 *  (`rm --cached`): el archivo del dev queda en el disco —ignorado— y el recorrido lo nombra como modificado. El stash no
 *  se toca y ningún archivo se borra. Cualquier otro conflicto se nombra y no se toca. */
function unstickRetirementPull(repo, manifest, { check = false } = {}) {
  const byPath = unmergedPaths(repo);
  if (!byPath || !byPath.size) return null;
  const paths = [...byPath.keys()];
  const targets = manifest.thirdParty.map((e) => e.target);
  const underTarget = (p) => targets.some((t) => p === t || p.startsWith(`${t}/`));
  const deletedByRetirement = (p) => !byPath.get(p).has('2') && byPath.get(p).has('3');
  const retiredDu = new Set(paths.filter((p) => underTarget(p) && deletedByRetirement(p)));
  const refuse = (why) => ({ unstuck: false, paths, why, retiredDu });
  if (manifest.retirement !== 'done') return refuse('el retiro está pendiente: no es su pull');
  if (!paths.every((p) => underTarget(p) && deletedByRetirement(p))) return refuse('no son sólo archivos ajenos que el retiro borró');
  const top = git(repo, ['stash', 'list', '-n', '1']);
  if (top.status !== 0 || !/autostash/i.test(top.stdout)) return refuse('no vienen de un autostash');
  const shown = git(repo, ['stash', 'show', '--name-only', '-z', 'stash@{0}']);
  const inStash = new Set(shown.status === 0 ? shown.stdout.split('\0').filter(Boolean) : []);
  if (!paths.every((p) => inStash.has(p))) return refuse('el stash de arriba no los trae a todos');
  if (check) return refuse('--check no escribe');
  const rm = git(repo, ['rm', '--cached', '-q', '--', ...paths]);
  if (rm.status !== 0) return refuse(`git rm --cached falló: ${rm.stderr.trim().split('\n').pop()}`);
  return { unstuck: true, paths };
}

function run({ repo, manifestPath, statePath, check = false, env = process.env }) {
  if (env.TYCON_THIRD_PARTY === '0') {
    say(`ℹ ${TAG}: el paso está apagado (TYCON_THIRD_PARTY=0) — no se restituye ni se revisa nada`);
    return;
  }
  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    say(`⚠ ${TAG}: no pude leer el manifiesto — ${String(e.message).split('\n').slice(0, 3).join(' ')} · no toco nada`);
    return;
  }
  // una versión BAJADA (story 8.23, tanda G · AC 42): el árbol trae su manifiesto de instalación y no es un clon; lo
  // ajeno lo restituye la propia bajada (release.js) al instalar o actualizar. Acá sólo se VERIFICA, sin git y sin
  // escribir: decir «no es un clon … no restituyo nada» en cada arranque era ruido, y nadie miraba si faltaba algo
  // (la primera máquina migrada, 2026-10-08). Se mira ANTES de preguntarle a git: un ~/.tycon/harness dentro de una
  // carpeta de usuario versionada con git (git init ~) contestaría «soy un clon» y el paso escribiría en el árbol bajado
  // (pase adversarial de la tanda G, clase 6)
  if (fs.existsSync(path.join(repo, RELEASE_MANIFEST))) { checkReleaseTree(repo, manifest, { home: os.homedir(), env }); return; }
  if (git(repo, ['rev-parse', '--git-dir']).status !== 0) {
    say(`⚠ ${TAG}: ${repo} no es un clon de agent-skills que pueda leer — no restituyo nada`);
    return;
  }
  // El cerrojo es del CLON, no de la ruta con que lo nombran (story 8.18, contrato C11): `~/.claude/agent-skills` puede
  // ser un enlace al clon unido, y por el enlace y por su ruta real es el mismo árbol. Con la ruta tal cual eran dos
  // cerrojos, y dos pasos a la vez escribían los dos (medido: 5 y 4 archivos de la misma skill, cada uno por su ruta).
  let lockOf = path.resolve(repo);
  try { lockOf = fs.realpathSync(repo); } catch { /* se acaba de leer con git: si ahora no resuelve, vale la ruta dada */ }
  const lockDir = path.join(path.dirname(statePath), `third-party-${sha1(Buffer.from(lockOf)).slice(0, 8)}.lock`);
  if (!check && !takeLock(lockDir)) {
    say(`ℹ ${TAG}: otro arranque está restituyendo en este agent-skills ahora — no escribo; el próximo arranque completa lo que falte`);
    return;
  }
  const tmpDirs = [];
  try {
    const budgetS = Number(env.TYCON_THIRD_PARTY_NETWORK_BUDGET_S) > 0 ? Number(env.TYCON_THIRD_PARTY_NETWORK_BUDGET_S) : DEFAULT_BUDGET_S;
    const deadline = Date.now() + budgetS * 1000;
    const state = loadState(statePath);
    const before = JSON.stringify(state);
    const report = { restored: new Map(), modified: [], waiting: [], unverifiable: [], failures: [], mismatch: [], pending: [], unsupported: [], unsafe: [], linked: [], broken: [], missing: [] };
    // antes de restituir: así el archivo del dev que el destrabe deja en el disco se ve como «modificado localmente»
    const stuck = unstickRetirementPull(repo, manifest, { check });
    const listed = (paths, n) => paths.slice(0, n).join(', ') + (paths.length > n ? ` y ${paths.length - n} más` : '');
    if (stuck && stuck.unstuck) {
      // con sus rutas: el recorrido de abajo sólo nombra los del árbol NUEVO de una entrada `download`; uno de una
      // propietaria, de una retirada o del árbol anterior de impeccable no lo nombraría nadie (pase adversarial, tanda B)
      say(`✓ ${TAG}: destrabé agent-skills — el retiro borró ${plural(stuck.paths.length, 'archivo ajeno', 'archivos ajenos')} que tenías modificados (${listed(stuck.paths, 5)}); tus versiones quedaron en el disco (no las toco) y siguen en el stash «autostash» (git -C ${sh(repo)} stash list)`);
    } else if (stuck) {
      // un consejo que funcione: `checkout HEAD --` sobre un archivo que el retiro borró falla y no resuelve nada
      const ours = stuck.paths.filter((p) => stuck.retiredDu.has(p));
      const rest = stuck.paths.filter((p) => !stuck.retiredDu.has(p));
      const hint = [
        ours.length ? `los ajenos que el retiro borró se destraban con git -C ${sh(repo)} rm --cached -- ${ours.map(sh).join(' ')}` : '',
        rest.length ? `${ours.length ? 'los demás' : 'se'} resuelven a mano (git -C ${sh(repo)} status)` : '',
      ].filter(Boolean).join('; ');
      say(`⚠ ${TAG}: agent-skills tiene un conflicto sin resolver (${listed(stuck.paths, 3)}) — ningún pull entra hasta resolverlo; no lo toco (${stuck.why}): ${hint}`);
    }
    const downloads = manifest.thirdParty.filter((e) => e.install === 'download');
    const local = presentTrees(repo, [...new Set(downloads.map((e) => e.tree))]);
    const origins = new Map(); // origen@commit → { dir } | { error } (una bajada por origen y commit en cada corrida)

    const fromOrigin = (e) => {
      const key = `${e.origin}@${e.commit}`;
      if (!origins.has(key)) {
        const left = deadline - Date.now();
        if (left <= 0) return { pending: true };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-third-party-'));
        tmpDirs.push(dir);
        git(dir, ['init', '-q', '--bare']);
        // `--`: el origen nunca se lee como opción de git (el manifiesto ya lo valida; esto es la segunda puerta)
        const r = git(dir, ['fetch', '-q', '--depth', '1', '--no-tags', '--', e.origin, e.commit], { timeout: left });
        if (r.timedOut) return { pending: true }; // no se cachea: otra entrada del mismo origen tampoco llegaría
        origins.set(key, r.status === 0 ? { dir } : { error: classifyFetchError(r.stderr), detail: r.stderr.trim().split('\n').pop() });
      }
      const o = origins.get(key);
      if (o.error) return o;
      const listing = listTree(o.dir, e.path ? `${e.commit}:${e.path}` : `${e.commit}^{tree}`);
      if (!listing) return { mismatch: `la ruta «${e.path}» no está en ese commit` };
      const omit = (e.omit || []).map((x) => x.file);
      const fixes = new Map((e.mode_fixes || []).map((x) => [x.file, x.mode]));
      const entries = listing
        .filter((x) => !omit.some((f) => x.path === f || x.path.startsWith(`${f}/`)))
        .map((x) => (fixes.has(x.path) ? { ...x, mode: fixes.get(x.path) } : x));
      if (treeSha(entries) !== e.tree) return { mismatch: 'lo que trae no da el árbol declarado' };
      return { entries, dir: o.dir };
    };

    for (const e of downloads) {
      // Cada entrada, aislada: un error del disco en una skill (una carpeta sin permiso, un archivo donde el árbol pide
      // una carpeta) se nombra con la skill y el archivo, y las que siguen se restituyen igual (pase adversarial, tanda A).
      let touching = e.target;
      try {
      const dest = path.join(repo, e.target);
      const prev = state.entries[e.target];
      let expected = null;
      let source = null;
      // un enlace simbólico en el camino al destino (la carpeta de la skill enlazada a otro checkout): no se escribe a
      // través de él —escribiría en otro repo— y se dice
      const linkOnWay = symlinkOnPath(repo, e.target);
      if (linkOnWay) { report.linked.push(`${e.target} (${linkOnWay})`); continue; }
      // la lista esperada: la del estado si ya se registró este mismo árbol (sin lanzar git: así el arranque al día
      // tarda milisegundos), si no la del árbol en la historia local; el contenido sale después de donde esté
      if (prev && prev.tree === e.tree && prev.complete) { expected = Object.entries(prev.files).map(([p, f]) => ({ mode: f.mode, sha: f.blob, path: p, type: 'blob' })); source = 'state'; }
      else if (local.has(e.tree)) { expected = listTree(repo, e.tree); source = 'local'; }
      else if (prev && prev.tree === e.tree) { expected = Object.entries(prev.files).map(([p, f]) => ({ mode: f.mode, sha: f.blob, path: p, type: 'blob' })); source = 'state'; }

      // sin historia ni estado (la copia pública, un estado borrado): si lo que hay en el disco ya da el árbol, se adopta
      // sin ir a la red
      if (!expected) {
        const onDisk = diskListing(dest);
        if (onDisk && onDisk.length && treeSha(onDisk) === e.tree) { expected = onDisk; source = 'disk'; }
      }
      let originResult = null;
      if (!expected) {
        if (manifest.retirement !== 'done') {
          if (!fs.existsSync(dest)) {
            if (check) report.missing.push(`${e.target} (entera: no está en la historia local y con el retiro pendiente no se baja)`);
            else report.waiting.push(e.target);
          } else if (check) {
            report.missing.push(`${e.target} (su contenido no da el árbol declarado y el árbol no está en la historia local: actualizá agent-skills)`);
          } else {
            // existe, no da el árbol y no hay con qué compararla archivo por archivo: no se calla (revisores, iter 2)
            report.unverifiable.push(e.target);
          }
          continue;
        }
        if (check) {
          // a medias también se nombra (pase adversarial, tanda B): el arranque la completaría desde el origen
          report.missing.push(fs.existsSync(dest) ? `${e.target} (su contenido no da el árbol declarado y el árbol no está en la historia local: el arranque la baja del origen)` : `${e.target} (entera)`);
          continue;
        }
        originResult = fromOrigin(e);
        if (originResult.pending) { report.pending.push(e.target); continue; }
        if (originResult.error) { report.failures.push({ e, kind: originResult.error, detail: originResult.detail }); continue; }
        if (originResult.mismatch) { report.mismatch.push({ e, why: originResult.mismatch }); continue; }
        expected = originResult.entries;
        source = 'origin';
      }
      if (expected.some((x) => x.type !== 'blob' || !['100644', '100755'].includes(x.mode))) { report.unsupported.push(e.target); continue; }
      // cada ruta tiene que quedar DENTRO del destino: viene de un árbol (del origen, de la historia) o del estado, y
      // ninguno de los tres es de fiar para escribir en el disco (un `..` o una ruta absoluta escribirían afuera)
      const unsafe = expected.filter((x) => !insideTarget(dest, x.path));
      if (unsafe.length) { report.unsafe.push(`${e.target} (${unsafe.slice(0, 3).map((x) => x.path).join(', ')})`); continue; }

      // qué hay en el disco, archivo por archivo (con el caché de tamaño y fecha del estado)
      const prevFiles = (prev && prev.files) || {};
      const record = {};
      const toWrite = [];
      for (const x of expected) {
        touching = `${e.target}/${x.path}`;
        const abs = path.join(dest, x.path);
        const was = prevFiles[x.path];
        let st = null;
        try { st = fs.lstatSync(abs); } catch { /* falta */ }
        if (!st) { toWrite.push(x); continue; }
        if (!st.isFile()) { report.modified.push(`${e.target}/${x.path}`); record[x.path] = { blob: x.sha, mode: x.mode }; continue; }
        // el caché del estado vale sólo si tamaño, fecha, ctime (no se puede fijar a mano) e inodo son los mismos
        const cached = was && was.diskBlob && was.size === st.size && was.mtimeMs === st.mtimeMs && was.ctimeMs === st.ctimeMs && was.ino === st.ino;
        const disk = cached ? was.diskBlob : effectiveBlob(fs.readFileSync(abs), x.sha);
        // `ours`: el contenido es el que el paso escribió o el que adoptó por ser idéntico al árbol declarado (AC 13:
        // «lo escribió él y nadie lo tocó»). Uno distinto queda como no-suyo aunque después vuelva atrás a mano.
        const entry = { blob: x.sha, mode: x.mode, ...statKey(st), diskBlob: disk, ours: disk === x.sha };
        if (disk === x.sha) {
          if (!check && isExec(st) !== (x.mode === '100755')) { fs.chmodSync(abs, x.mode === '100755' ? 0o755 : 0o644); Object.assign(entry, statKey(fs.statSync(abs))); }
          record[x.path] = entry;
        } else if (was && was.ours && disk === was.blob && was.blob !== x.sha) {
          toWrite.push(x); // la versión anterior, suya y sin tocar: se reemplaza por la nueva
        } else {
          record[x.path] = entry;
          report.modified.push(`${e.target}/${x.path}`);
        }
      }
      if (toWrite.length && check) { report.missing.push(`${e.target} (${plural(toWrite.length, 'archivo', 'archivos')})`); continue; }
      if (toWrite.length) {
        let contents = source === 'origin' ? readBlobs(originResult.dir, toWrite.map((x) => x.sha)) : readBlobs(repo, toWrite.map((x) => x.sha));
        let from = source === 'origin' ? 'origin' : 'local';
        if (toWrite.some((x) => !contents.has(x.sha))) {
          // la lista estaba (historia o estado) pero no el contenido: el origen, si el retiro está hecho
          if (manifest.retirement !== 'done') { report.waiting.push(e.target); continue; }
          const o = originResult || fromOrigin(e);
          if (o.pending) { report.pending.push(e.target); continue; }
          if (o.error) { report.failures.push({ e, kind: o.error, detail: o.detail }); continue; }
          if (o.mismatch) { report.mismatch.push({ e, why: o.mismatch }); continue; }
          contents = readBlobs(o.dir, toWrite.map((x) => x.sha));
          from = 'origin';
          if (toWrite.some((x) => !contents.has(x.sha))) { report.mismatch.push({ e, why: 'el origen no trae todos los archivos del árbol' }); continue; }
        }
        const linkInside = toWrite.map((x) => symlinkOnPath(repo, path.posix.join(e.target, path.posix.dirname(x.path)))).find(Boolean);
        if (linkInside) { report.linked.push(`${e.target} (${linkInside})`); continue; }
        sweepTemps(dest);
        for (const x of toWrite) {
          touching = `${e.target}/${x.path}`;
          const abs = path.join(dest, x.path);
          writeAtomic(abs, contents.get(x.sha), x.mode);
          record[x.path] = { blob: x.sha, mode: x.mode, ...statKey(fs.statSync(abs)), diskBlob: x.sha, ours: true };
        }
        const r = report.restored.get(from) || { files: 0, targets: 0 };
        report.restored.set(from, { files: r.files + toWrite.length, targets: r.targets + 1 });
      }
      // exactamente la lista de este árbol (lo de un árbol anterior no se arrastra: el paso nunca lo borra, pero ya no es suyo)
      if (!check) state.entries[e.target] = { tree: e.tree, complete: true, files: record };
      } catch (err) {
        report.broken.push(`${touching} (${err.code || err.message})`);
      }
    }

    // ── avisos ──
    for (const [from, r] of report.restored) {
      say(`✓ ${TAG}: restituí ${plural(r.files, 'archivo', 'archivos')} en ${plural(r.targets, 'skill', 'skills')} ${from === 'local' ? 'desde la historia local de agent-skills (sin red)' : 'desde su origen, verificado por hash de árbol'}`);
    }
    // agrupadas (pase adversarial, tanda B): sin red, la copia pública tiene ~70 skills que bajar, y 70 líneas en cada
    // arranque entran al contexto de cada sesión. «No pude preguntar» va en una sola; las otras dos, por origen y commit.
    const groups = new Map();
    for (const f of report.failures) {
      const key = f.kind === 'no-network' ? f.kind : `${f.kind} ${f.e.origin}@${f.e.commit}`;
      if (!groups.has(key)) groups.set(key, { f, targets: [], origins: new Set() });
      groups.get(key).targets.push(f.e.target);
      groups.get(key).origins.add(f.e.origin);
    }
    for (const { f, targets, origins } of groups.values()) {
      const where = listed([...origins], 3) + (origins.size === 1 && f.detail ? `: ${f.detail.slice(0, 160)}` : '');
      say(`⚠ ${TAG}: ${listed(targets, 3)} — ${FAILURE_TEXT[f.kind](f.e)} (${where}). No toqué nada; el próximo arranque reintenta.`);
    }
    for (const m of report.mismatch) {
      say(`⚠ ${TAG}: ${m.e.target} — el origen no coincide: ${m.e.origin} en ${m.e.commit.slice(0, 12)}:${m.e.path || '/'} ${m.why}. No instalo nada; hay que revisar la entrada del manifiesto.`);
    }
    if (report.pending.length) say(`⏳ ${TAG}: se acabó el tiempo de red (${budgetS} s) — quedan para el próximo arranque: ${report.pending.join(', ')}`);
    if (report.broken.length) say(`⚠ ${TAG}: no pude escribir o leer en ${report.broken.join(', ')} — esas skills quedaron como estaban (las demás siguieron); se reintenta en el próximo arranque`);
    if (report.linked.length) say(`⚠ ${TAG}: ${report.linked.join(', ')} — hay un enlace simbólico en el camino: no escribo a través de él (escribiría en otro lado); si la skill vive en otro checkout a propósito, es tuya`);
    if (report.unsafe.length) say(`⚠ ${TAG}: ${report.unsafe.join(', ')} — ruta insegura (con .., absoluta o vacía): no escribo nada de esa skill`);
    if (report.unsupported.length) say(`⚠ ${TAG}: ${report.unsupported.join(', ')} — su árbol trae un enlace simbólico o un submódulo; el paso no instala eso`);
    if (report.missing.length) say(`⚠ ${TAG}: faltan ${report.missing.join(', ')} — corré el instalador`);
    // El aviso diario es para el arranque; quien corre --check a mano pregunta y siempre se le contesta (2026-10-06)
    const daily = (key, line) => {
      if (!check && state.notices[key] === today()) return;
      say(line);
      if (!check) state.notices[key] = today();
    };
    if (report.modified.length) {
      const shown = report.modified.slice(0, 5).join(', ') + (report.modified.length > 5 ? ` y ${report.modified.length - 5} más` : '');
      daily('modified', `ℹ ${TAG}: ${plural(report.modified.length, 'archivo modificado', 'archivos modificados')} localmente, que no toco: ${shown} (una vez por día)`);
    }
    if (report.waiting.length) {
      daily('waiting', `ℹ ${TAG}: ${plural(report.waiting.length, 'skill', 'skills')} sin su contenido y fuera de la historia local (${report.waiting.slice(0, 3).join(', ')}${report.waiting.length > 3 ? ', …' : ''}); con el retiro pendiente no se bajan del origen (una vez por día)`);
    }
    if (report.unverifiable.length) {
      daily('unverifiable', `⚠ ${TAG}: no puedo verificar ${report.unverifiable.slice(0, 3).join(', ')}${report.unverifiable.length > 3 ? ` y ${report.unverifiable.length - 3} más` : ''}: lo que hay en el disco no da el árbol del manifiesto y ese árbol no está en la historia local — actualizá agent-skills (git pull); no toco nada (una vez por día)`);
    }
    proprietaryNotice(manifest, env, daily);
    if (!check && JSON.stringify(state) !== before) saveState(statePath, state);
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    if (!check) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** AC 17: las propietarias vienen con un plugin oficial; si no está, una línea por día con los dos comandos. */
function proprietaryNotice(manifest, env, daily) {
  if (manifest.retirement !== 'done' || env.TYCON_THIRD_PARTY_PROPRIETARY_NOTICE === '0') return;
  const byPlugin = new Map();
  for (const e of manifest.thirdParty.filter((x) => x.install === 'official-plugin')) {
    if (!byPlugin.has(e.plugin)) byPlugin.set(e.plugin, { names: [], origin: e.origin });
    byPlugin.get(e.plugin).names.push(path.basename(e.target));
  }
  if (!byPlugin.size) return;
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* sin plugins */ }
  const missing = [...byPlugin].filter(([plugin]) => !Object.prototype.hasOwnProperty.call(installed, plugin));
  if (!missing.length) return;
  const lines = missing.map(([plugin, { names, origin }]) => {
    const gh = /github\.com\/([^/]+\/[^/.]+)/.exec(origin || '');
    return `${names.join(', ')} vienen con el plugin oficial ${plugin}, que no está instalado — en Claude Code: /plugin marketplace add ${gh ? gh[1] : origin} y /plugin install ${plugin}`;
  });
  daily('proprietary', `ℹ ${TAG}: ${lines.join(' · ')} (una vez por día; se apaga con TYCON_THIRD_PARTY_PROPRIETARY_NOTICE=0)`);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = { check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') opt.repo = argv[++i];
    else if (argv[i] === '--manifest') opt.manifest = argv[++i];
    else if (argv[i] === '--check') opt.check = true;
    else { say(`⚠ ${TAG}: opción desconocida ${argv[i]} — no hago nada`); return; }
  }
  try {
    const repo = path.resolve(opt.repo || require('../lib/skills-dir.js').resolveSkillsDirs().repo);
    run({
      repo,
      manifestPath: path.resolve(opt.manifest || process.env.TYCON_THIRD_PARTY_MANIFEST || DEFAULT_MANIFEST),
      statePath: path.join(stateDirOf(os.homedir()), 'third-party-state.json'),
      check: opt.check,
    });
  } catch (e) {
    say(`⚠ ${TAG}: el paso falló sin terminar (${e.code || e.message}) — lo que ya estaba escrito quedó entero; el próximo arranque sigue`);
  }
}

if (require.main === module) main();

module.exports = { run, treeSha, blobSha, diskListing, checkReleaseTree, classifyFetchError };
