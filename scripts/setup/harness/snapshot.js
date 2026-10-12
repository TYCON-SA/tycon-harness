'use strict';
// snapshot.js — la copia de seguridad que el mecanismo de instalación toma ANTES de cada cambio en la máquina
// (story 8.13, tanda B · AC 17 y 18).
//
// Qué guarda: antes de `install`, `update`, `apply`, `rollback`, `uninstall`, la migración de la línea de arranque y el
// aplicador de cada `startup`, una carpeta `~/.claude/.tycon-pipeline/harness/backups/<YYYYMMDD-HHMMSS>/` (hora UTC; si
// ya existe, sufijo `-2`, `-3`…) con los archivos tal cual (en `files/`) y un `manifest.json`: `schema`, `seq` (la
// secuencia que ordena las copias: la mayor + 1, nunca el reloj), `from` y `to` (las versiones), `reason`, `at`, `hash`
// del conjunto, `sources` (tanda C: los commits completos de cada fuente, a dónde `rollback` lleva los árboles; null en
// las copias que no los saben) y, por archivo, `path`, `existed`, `sha256`, `copy` (dónde quedó
// dentro de la carpeta) y `sha256_after`, que escribe `finish` cuando el cambio terminó. Se escribe en `<carpeta>.tmp`
// y se renombra: una copia a medias nunca parece una copia.
//
// Por qué la lista es FIJA y declarada acá (y no «lo que el aplicador diga que tocó»): es la tabla de la medición §2
// (`tasks/measurement-8.13-un-solo-mecanismo/medicion-2026-09-30.md`) — los archivos del dev que el arnés modifica y
// que, si quedan mal, dejan la máquina sin trabajar: `settings.json`, `CLAUDE.md`, `tycon.json`, el espejo y el
// despliegue de Codex (`AGENTS.md`, `hooks.json`, `config.toml`), los git hooks globales y sus `.local`, los
// `~/.claude/commands/*.md` DEL ARNÉS (los que trae `<árbol>/commands/`) y los dos LaunchAgents. Una lista que se arma
// en cada corrida no se puede comparar con nada; ésta la compara una prueba (T20) con la medición. Lo regenerable
// (sellos, logs, candados, los perfiles de Codex por agente) no entra. Va un poco MÁS allá de la medición en dos
// puntos, a propósito (ver `files`): el `AGENTS.md` que escribe el espejo y los comandos propios del dev.
//
// Retención: si el conjunto tiene el mismo `hash` que la copia más reciente, no se crea otra (el aplicador corre en cada
// arranque y casi nunca cambia nada). Quedan las 5 más nuevas MÁS la `reason: install` más vieja, que no rota nunca: es
// «cómo estaba la máquina antes del arnés». Las demás `install` cuentan dentro de las 5.
//
// Nunca toca los `.bak` que el dev ya tiene al lado de sus archivos (los dejaron corridas sueltas del aplicador): ni los
// lee, ni los mueve, ni los borra. `countBak` sólo los cuenta, para que `doctor` diga que existen y que no los gestiona.
//
// Núcleo público: sin dependencias, sin leer el perfil del equipo ni `renames.json`. Funciones puras respecto del HOME:
// reciben `home` y `env`; `os.homedir()` y `process.env` sólo como valores por defecto.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('./state');
const { backupsDir } = require('./tycon-home.js');   // story 8.23: la ruta de las copias la sabe una sola pieza

const SCHEMA = 1;
const KEEP = 5;
const MANIFEST = 'manifest.json';
const NAME_RE = /^(\d{8}-\d{6})(?:-(\d+))?$/;
const LAUNCH_AGENTS = ['ar.com.tycon.harness-env.plist', 'ar.com.tycon.examen-periodico.plist'];

/** La carpeta de las copias. */
function backupsRoot(home = os.homedir()) {
  return backupsDir(home);
}

/** El valor de una variable si está puesta y no vacía; si no, null. */
function envPath(env, key) {
  const v = env && env[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Los nombres de `<dir>/*.md`, en orden; una carpeta que no está (o no se puede leer) no aporta ninguno. */
function mdNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.isDirectory() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch (_) {
    return [];
  }
}

/**
 * La lista fija de archivos que se copian, en rutas absolutas, sin duplicados y en un orden estable.
 * Respeta `TYCON_SETTINGS_PATH`, `CLAUDE_MD_PATH`, `CODEX_HOME`, `CODEX_AGENTS_MD_PATH` y `TYCON_GIT_HOOKS_DIR`
 * (vacías = sin poner, como el `${VAR:-…}` de los scripts).
 *
 * Dos casos donde la lista va más allá de la medición, a propósito (pase adversarial, F7 y F8):
 *   · El espejo `AGENTS.md` lo escribe `sync-claude-md-blocks.sh/.ps1` en `CODEX_AGENTS_MD_PATH` o en
 *     `~/.codex/AGENTS.md` — no mira `CODEX_HOME`. Se copia ése; el de `$CODEX_HOME/AGENTS.md`, si es otro, también.
 *   · Los comandos son la unión de `<tree>/commands/*.md` (los del arnés; `tree` por defecto es el enlace
 *     el lugar del arnés, `place.js`) y de los `~/.claude/commands/*.md` que ya existen: la lista se arma con el árbol
 *     de ANTES del pull, y un comando nuevo de la actualización puede llamarse igual que uno propio del dev.
 */
function files({ home = os.homedir(), env = process.env, tree } = {}) {
  const claude = path.join(home, '.claude');
  const codex = envPath(env, 'CODEX_HOME') || path.join(home, '.codex');
  const mirror = envPath(env, 'CODEX_AGENTS_MD_PATH') || path.join(home, '.codex', 'AGENTS.md');
  const gitHooks = envPath(env, 'TYCON_GIT_HOOKS_DIR') || path.join(home, '.git-hooks');
  const commandsDir = path.join(claude, 'commands');
  const P = require('./place.js');
  const defaultTree = P.resolvePlace({ home }).dir || P.placePath(home);
  const commands = [...new Set([...mdNames(path.join(tree || defaultTree, 'commands')), ...mdNames(commandsDir)])].sort();
  const list = [
    envPath(env, 'TYCON_SETTINGS_PATH') || path.join(claude, 'settings.json'),
    envPath(env, 'CLAUDE_MD_PATH') || path.join(claude, 'CLAUDE.md'),
    path.join(claude, 'tycon.json'),
    mirror,
    path.join(codex, 'AGENTS.md'),
    path.join(codex, 'hooks.json'),
    path.join(codex, 'config.toml'),
    path.join(gitHooks, 'pre-commit'),
    path.join(gitHooks, 'post-commit'),
    path.join(gitHooks, 'pre-push'),          // story 8.26, tanda F1: el freno antes de publicar
    path.join(gitHooks, 'pre-commit.local'),
    path.join(gitHooks, 'post-commit.local'),
    path.join(gitHooks, 'pre-push.local'),
    ...commands.map((n) => path.join(commandsDir, n)),
    ...LAUNCH_AGENTS.map((n) => path.join(home, 'Library', 'LaunchAgents', n)),
  ];
  return [...new Set(list)];
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** El contenido de un archivo, o null si no está. Cualquier otro error (permisos, una carpeta) tira: no se miente «no existía». */
function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw new Error(`snapshot: no se pudo leer ${file} (${(e && e.code) || e.message})`);
  }
}

/** `YYYYMMDD-HHMMSS` en UTC. */
function stamp(now) {
  const iso = new Date(now).toISOString(); // 2026-10-02T12:34:56.789Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** El nombre de una carpeta de copia, partido: fecha y sufijo numérico (sin sufijo = 1); null si no es una copia. */
function nameKey(name) {
  const m = NAME_RE.exec(name);
  return m ? [m[1], m[2] ? Number(m[2]) : 1] : null;
}

const seqOf = (manifest) => (Number.isInteger(manifest.seq) && manifest.seq > 0 ? manifest.seq : null);

/**
 * Más nueva primero. Manda la secuencia del manifiesto (`seq`), que no depende del reloj: con el reloj corregido hacia
 * atrás, la copia recién tomada sigue siendo la más nueva (pase adversarial, F9). Las copias sin `seq` (anteriores a
 * ella) van debajo, por nombre: fecha y, dentro del mismo segundo, sufijo numérico.
 */
function newestFirst(a, b) {
  const sa = seqOf(a.manifest); const sb = seqOf(b.manifest);
  if (sa !== null || sb !== null) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sa !== sb) return sb - sa;
  }
  if (a.key[0] !== b.key[0]) return a.key[0] < b.key[0] ? 1 : -1;
  return b.key[1] - a.key[1];
}

/** Las copias válidas (con manifiesto legible), la más nueva primero: `[{ dir, name, manifest }]`. */
function list(home = os.homedir()) {
  const root = backupsRoot(home);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const key = nameKey(name);
    if (!key) continue; // `.tmp` a medias o algo que no es nuestro: ni se lista ni se toca
    const dir = path.join(root, name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    } catch (_) {
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    out.push({ dir, name, manifest, key });
  }
  out.sort(newestFirst);
  return out.map(({ dir, name, manifest }) => ({ dir, name, manifest }));
}

/**
 * Retención: deja las 5 más nuevas MÁS la `reason: install` más vieja (fija). Borra sólo carpetas de copia con
 * manifiesto legible; nunca un `.bak` del dev ni nada que no reconozca. `protect` (una carpeta) no se borra nunca: es
 * la que `take` acaba de crear. Devuelve las carpetas borradas.
 */
function prune(home = os.homedir(), { protect = null } = {}) {
  const all = list(home);
  const keep = new Set(all.slice(0, KEEP).map((b) => b.dir));
  for (const p of Array.isArray(protect) ? protect : [protect]) if (p) keep.add(p);
  const installs = all.filter((b) => b.manifest.reason === 'install');
  if (installs.length) keep.add(installs[installs.length - 1].dir);
  // la copia de ANTES de la versión instalada (la más nueva cuyos `sources` difieren de los de la copia más nueva) es a
  // dónde vuelve `rollback` sin opciones: cinco arranques que cambian settings.json no la pueden podar (tanda C, pase
  // adversarial H5)
  const newest = all.find((b) => b.manifest.sources);
  if (newest) {
    const cur = JSON.stringify(newest.manifest.sources);
    const before = all.find((b) => b.manifest.sources && JSON.stringify(b.manifest.sources) !== cur);
    if (before) keep.add(before.dir);
  }
  const removed = [];
  for (const b of all) {
    if (keep.has(b.dir)) continue;
    fs.rmSync(b.dir, { recursive: true, force: true });
    removed.push(b.dir);
  }
  return removed;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** `sources` del manifiesto: `{ <fuente>: <sha completo> }` o null. Un sha corto no sirve para mover un árbol: tira. */
function checkSources(sources) {
  if (sources === null || sources === undefined) return null;
  if (typeof sources !== 'object' || Array.isArray(sources)) throw new TypeError('snapshot.take: `sources` tiene que ser { <fuente>: <sha> }');
  const out = {};
  for (const [name, sha] of Object.entries(sources)) {
    if (typeof sha !== 'string' || !FULL_SHA.test(sha)) throw new TypeError(`snapshot.take: sources.${name} no es un commit completo (${JSON.stringify(sha)})`);
    out[name] = sha;
  }
  return out;
}

/**
 * Toma la copia. Si el conjunto es igual al de la copia más reciente, no crea otra y devuelve ésa (`created: false`),
 * salvo con `force` (tanda C, decisión 1 del dueño: cuando el mecanismo mueve árboles, en `rollback` y en `uninstall` la
 * copia es SIEMPRE nueva, así su `sha256_after` es el de ESE cambio). `sources` (`{ harness, agent_skills }`, commits
 * completos; decisión 2) queda en el manifiesto: es a dónde `rollback --to` lleva los árboles.
 * Después de crear, aplica la retención. `now` (Date o milisegundos) es el reloj: por defecto, el de la máquina.
 * @returns {{ dir: string, created: boolean, pruned: string[] }}
 */
// `protect`: carpetas de copia que la retención de ESTA toma no puede borrar (el destino de un rollback: pase adversarial H9)
function take({ home = os.homedir(), env = process.env, tree, reason, from = null, to = null, force = false, sources = null, protect = [], now = new Date() } = {}) {
  if (typeof reason !== 'string' || !reason) throw new TypeError('snapshot.take: falta `reason` (install, update, apply, startup, before-rollback, uninstall…)');
  const commits = checkSources(sources);
  const entries = files({ home, env, tree }).map((p) => {
    const buf = readOrNull(p);
    return { path: p, buf, existed: buf !== null, sha256: buf === null ? null : sha256(buf) };
  });
  const hash = sha256(JSON.stringify(entries.map((e) => [e.path, e.sha256])));
  const existing = list(home);
  const latest = existing[0];
  if (!force && latest && latest.manifest.hash === hash) return { dir: latest.dir, created: false, pruned: [] };
  // la secuencia: la mayor que haya + 1 (no el reloj; ver `newestFirst`)
  const seq = existing.reduce((max, b) => Math.max(max, seqOf(b.manifest) || 0), 0) + 1;

  const root = backupsRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const base = stamp(now);
  let dir = null;
  let tmp = null;
  for (let n = 1; n < 1000 && !dir; n++) {
    const candidate = path.join(root, n === 1 ? base : `${base}-${n}`);
    if (fs.existsSync(candidate)) continue;
    try {
      fs.mkdirSync(`${candidate}.tmp`); // el reclamo: dos copias en el mismo segundo no eligen el mismo nombre
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
    dir = candidate;
    tmp = `${candidate}.tmp`;
  }
  if (!dir) throw new Error(`snapshot: no encontré un nombre libre para ${base} en ${root}`);

  try {
    const filesDir = path.join(tmp, 'files');
    fs.mkdirSync(filesDir);
    const manifestFiles = entries.map((e, i) => {
      let copy = null;
      if (e.existed) {
        copy = `files/${String(i + 1).padStart(2, '0')}-${path.basename(e.path)}`;
        const dest = path.join(tmp, copy);
        fs.writeFileSync(dest, e.buf);
        try { fs.chmodSync(dest, fs.statSync(e.path).mode & 0o777); } catch (_) { /* el modo es cortesía: el contenido ya está */ }
      }
      return { path: e.path, existed: e.existed, sha256: e.sha256, sha256_after: null, copy };
    });
    const manifest = {
      schema: SCHEMA, seq, from, to, reason, at: new Date(now).toISOString(), hash, sources: commits, files: manifestFiles,
    };
    fs.writeFileSync(path.join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, dir);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* el temporal ya no está */ }
    throw e;
  }
  return { dir, created: true, pruned: prune(home, { protect: [dir, ...(Array.isArray(protect) ? protect : [protect])] }) };
}

/** Escribe `sha256_after` de cada archivo del manifiesto (null si después del cambio no está). Devuelve el manifiesto. */
function finish(dir, { home = os.homedir(), env = process.env } = {}) { // eslint-disable-line no-unused-vars
  const file = path.join(dir, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of manifest.files || []) {
    const buf = readOrNull(f.path);
    f.sha256_after = buf === null ? null : sha256(buf);
  }
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Cuántos `.bak*` del dev hay al lado de los archivos de la lista (`settings.json.bak.<ts>`, `pre-commit.bak-<ts>`…). */
function countBak({ home = os.homedir(), env = process.env, tree } = {}) {
  const found = new Set();
  for (const p of files({ home, env, tree })) {
    const dir = path.dirname(p);
    const prefix = `${path.basename(p)}.bak`;
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) if (n.startsWith(prefix)) found.add(path.join(dir, n));
  }
  return found.size;
}

module.exports = { SCHEMA, KEEP, backupsRoot, files, take, finish, list, prune, countBak };
