'use strict';
// snapshot.js — la copia de seguridad que el mecanismo de instalación toma ANTES de cada cambio en la máquina.
//
// Qué guarda: antes de `install`, `update`, `apply`, `rollback`, `uninstall`, la migración de la línea de arranque y el
// aplicador de cada `startup`, una carpeta `~/.claude/.tycon-pipeline/harness/backups/<YYYYMMDD-HHMMSS>/` (hora UTC; si
// ya existe, sufijo `-2`, `-3`…) con los archivos tal cual (en `files/`) y un `manifest.json`: `schema`, `seq` (la
// secuencia que ordena las copias: la mayor + 1, nunca el reloj), `from` y `to` (las versiones), `reason`, `at`, `hash`
// del conjunto, `sources` (los commits completos de cada fuente, a dónde `rollback` lleva los árboles; null en
// las copias que no los saben) y, por archivo, `path`, `existed`, `sha256`, `copy` (dónde quedó
// dentro de la carpeta) y `sha256_after`, que escribe `finish` cuando el cambio terminó. Se escribe en `<carpeta>.tmp`
// y se renombra: una copia a medias nunca parece una copia.
//
// Por qué la lista es FIJA y declarada acá (y no «lo que el aplicador diga que tocó»): es la tabla de los archivos del dev que el arnés
// modifica y que, si quedan mal, dejan la máquina sin trabajar: `settings.json`, `CLAUDE.md`, `tycon.json`, el espejo y el
// despliegue de Codex (`AGENTS.md`, `hooks.json`, `config.toml`), los git hooks globales y sus `.local`, los
// `~/.claude/commands/*.md` DEL ARNÉS (los que trae `<árbol>/commands/`) y los dos LaunchAgents. Una lista que se arma
// en cada corrida no se puede comparar con nada; ésta la verifica una prueba (T20). Lo regenerable
// (sellos, logs, candados, los perfiles de Codex por agente) no entra. Va un poco MÁS allá de esos archivos en dos
// puntos, a propósito (ver `files`): el `AGENTS.md` que escribe el espejo y los comandos propios del dev.
//
// Retención: si el conjunto tiene el mismo `hash` que la copia más reciente, no se crea otra (el aplicador corre en cada
// arranque y casi nunca cambia nada). Quedan las 5 más nuevas MÁS la `reason: install` más vieja, que no rota nunca: es
// «cómo estaba la máquina antes del arnés». Las demás `install` cuentan dentro de las 5.
//
// Abierta y cerrada: toda copia nace con `open: true` (también la reusada, que se reabre sin tocar su `sha256_after`), y
// la cierra su operación al terminar, bien o con error (`open: false` y `closed_by`). Una copia abierta en un arranque
// es un cambio que se cortó a la mitad: el arranque la nombra con `openCopyNotice` y da el comando para volver. La poda
// no borra una abierta. Un `finish` cierra también las abiertas más viejas (su operación siguiente terminó bien),
// salvo las `before-rollback`: ésas las cierra sólo la vuelta atrás que termina, porque guardan en `rollback_to` a qué
// copia volvía. Una copia sin el campo (anterior a esto) cuenta cerrada.
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
const { backupsDir } = require('./tycon-home.js');   // la ruta de las copias la sabe una sola pieza

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
 * Dos casos donde la lista va más allá de la medición, a propósito:
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
    path.join(gitHooks, 'pre-push'),          // el freno antes de publicar
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
 * atrás, la copia recién tomada sigue siendo la más nueva. Las copias sin `seq` (anteriores a
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
  // una abierta es la única constancia de un cambio que se cortó: no se poda hasta que se cierre
  for (const b of all) if (isOpen(b.manifest)) keep.add(b.dir);
  const installs = all.filter((b) => b.manifest.reason === 'install');
  if (installs.length) keep.add(installs[installs.length - 1].dir);
  // la copia de ANTES de la versión instalada (la más nueva cuyos `sources` difieren de los de la copia más nueva) es a
  // dónde vuelve `rollback` sin opciones: cinco arranques que cambian settings.json no la pueden podar
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
 * salvo con `force` (cuando el mecanismo mueve árboles, en `rollback` y en `uninstall` la
 * copia es SIEMPRE nueva, así su `sha256_after` es el de ESE cambio). `sources` (`{ harness, agent_skills }`, commits
 * completos) queda en el manifiesto: es a dónde `rollback --to` lleva los árboles.
 * Después de crear, aplica la retención. `now` (Date o milisegundos) es el reloj: por defecto, el de la máquina.
 * @returns {{ dir: string, created: boolean, pruned: string[] }}
 */
// `protect`: carpetas de copia que la retención de ESTA toma no puede borrar (el destino de un rollback)
function take({ home = os.homedir(), env = process.env, tree, reason, from = null, to = null, force = false, sources = null, protect = [], rollbackTo = null, now = new Date() } = {}) {
  if (typeof reason !== 'string' || !reason) throw new TypeError('snapshot.take: falta `reason` (install, update, apply, startup, before-rollback, uninstall…)');
  const commits = checkSources(sources);
  const entries = files({ home, env, tree }).map((p) => {
    const buf = readOrNull(p);
    return { path: p, buf, existed: buf !== null, sha256: buf === null ? null : sha256(buf) };
  });
  const hash = sha256(JSON.stringify(entries.map((e) => [e.path, e.sha256])));
  const existing = list(home);
  const latest = existing[0];
  if (!force && latest && latest.manifest.hash === hash) {
    // reusada: se reabre (un corte de esta operación también tiene que quedar a la vista), sin tocar su «después»
    reopen(latest.dir, now);
    return { dir: latest.dir, created: false, pruned: [] };
  }
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
      schema: SCHEMA, seq, from, to, reason, at: new Date(now).toISOString(), hash, sources: commits,
      open: true, opened_at: new Date(now).toISOString(), ...(rollbackTo ? { rollback_to: String(rollbackTo) } : {}), files: manifestFiles,
    };
    fs.writeFileSync(path.join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, dir);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* el temporal ya no está */ }
    throw e;
  }
  return { dir, created: true, pruned: prune(home, { protect: [dir, ...(Array.isArray(protect) ? protect : [protect])] }) };
}

/** Una ruta comparable: absoluta y sin el `/private` con que macOS resuelve /tmp y /var. */
const comparable = (p) => path.resolve(String(p)).replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');
const COPY_RE = /^files\/[^/\\]+$/;
/** La ruta real: la del archivo, o la de su carpeta más cercana que exista, con los enlaces resueltos. */
function realish(p) {
  let base = path.resolve(String(p)); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(base), ...rest); } catch (_) { /* no existe: se sube un nivel */ }
    const up = path.dirname(base);
    if (up === base) return path.resolve(String(p));
    rest.unshift(path.basename(base)); base = up;
  }
}

/**
 * Los archivos del manifiesto de `copy` que se pueden usar: la ruta, absoluta y (resuelta) dentro de la HOME o en la lista
 * fija de hoy (las variables de `files` pueden ponerla en otro lado); la copia, `files/<nombre>` dentro de la carpeta. Un
 * manifiesto tocado a mano no hace escribir, borrar ni leer fuera de eso. `skipped` son las rutas que no pasan.
 * @returns {{ files: object[], skipped: string[] }}
 */
function safeFiles(copy, { home = os.homedir(), env = process.env, tree } = {}) {
  const all = copy && copy.manifest && Array.isArray(copy.manifest.files) ? copy.manifest.files : [];
  const homeDir = comparable(realish(home));
  let declared = null;
  const isDeclared = (p) => {
    if (!declared) { try { declared = new Set(files({ home, env, tree }).map(comparable)); } catch (_) { declared = new Set(); } }
    return declared.has(comparable(p));
  };
  const out = { files: [], skipped: [] };
  for (const f of all) {
    if (!f || typeof f.path !== 'string') continue;
    // dentro de la HOME por el nombre y también por donde llevan los enlaces
    const okPath = path.isAbsolute(f.path) && ((comparable(f.path).startsWith(comparable(home) + path.sep) && comparable(realish(f.path)).startsWith(homeDir + path.sep)) || isDeclared(f.path));
    const okCopy = f.copy === null || f.copy === undefined || (typeof f.copy === 'string' && COPY_RE.test(f.copy) && !f.copy.endsWith('/..'));
    if (okPath && okCopy) out.files.push(f); else out.skipped.push(f.path);
  }
  return out;
}

/** ¿La copia está abierta? Sólo con `open: true`: una sin el campo es anterior a la marca y cuenta cerrada. */
const isOpen = (manifest) => Boolean(manifest && typeof manifest === 'object' && manifest.open === true);

/** Reescribe el manifiesto de `dir` con `patch`; null si no se pudo leer. */
function patchManifest(dir, patch) {
  const file = path.join(dir, MANIFEST);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  Object.assign(manifest, patch);
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
function reopen(dir, now = new Date()) {
  return patchManifest(dir, { open: true, opened_at: new Date(now).toISOString(), closed_by: null });
}

/**
 * Cierra la copia sin tocar nada más (`open: false` y `closed_by`): la reusada, que ya tiene el «después» de su
 * operación, y la de una operación que falló (`closedBy: 'failed'`). Devuelve el manifiesto, o null si no está.
 */
function close(dir, { closedBy = null, home = null, older = false } = {}) {
  const m = patchManifest(dir, { open: false, closed_by: closedBy || 'closed' });
  if (m && older && home) closeOlder(home, dir);
  return m;
}

/**
 * El cambio terminó: escribe `sha256_after` de cada archivo (null si después no está), cierra la copia (`closed_by`:
 * `closedBy` o su `reason`) y cierra las abiertas más viejas, salvo las `before-rollback`. Con `older: false` (una
 * operación que falló) no cierra las viejas: un fallo no arregla lo que dejó un corte anterior. Devuelve el manifiesto.
 */
function finish(dir, { home = os.homedir(), env = process.env, closedBy = null, older = true } = {}) { // eslint-disable-line no-unused-vars
  const file = path.join(dir, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of manifest.files || []) {
    const buf = readOrNull(f.path);
    f.sha256_after = buf === null ? null : sha256(buf);
  }
  manifest.open = false;
  manifest.closed_by = closedBy || manifest.reason || 'finish';
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  if (older) closeOlder(home, dir);
  return manifest;
}

/** Las abiertas más viejas que `dir` (no `before-rollback`) se cierran con el nombre de `dir`: su sucesora terminó. */
function closeOlder(home, dir) {
  const all = list(home);
  const at = all.findIndex((b) => path.resolve(b.dir) === path.resolve(dir));
  if (at < 0) return;
  for (const b of all.slice(at + 1)) {
    if (!isOpen(b.manifest) || b.manifest.reason === 'before-rollback') continue;
    try { close(b.dir, { closedBy: path.basename(dir) }); } catch (_) { /* la que no se pudo cerrar sigue avisando */ }
  }
}

/** Lo que encabeza el aviso de una copia abierta en `state.notice`: con eso se lo saca cuando ya no vale. */
const CUT_NOTICE_PREFIX = 'a medias: ';

/**
 * El aviso de un cambio que se cortó: la copia abierta más nueva de `copies` (`list()`), o null si no hay. `cmd` es
 * cómo se nombra a harness.js en el texto. Una `before-rollback` abierta es una vuelta atrás cortada: el comando la
 * termina con el `--to` que anotó (`rollback_to`), nunca vuelve a ella misma. Una copia sin `sha256_after` vuelve por
 * piezas (`rollback.js` no restaura archivos enteros sin el «después»), y el aviso lo dice.
 */
function openCopyNotice(copies, { cmd = 'harness.js' } = {}) {
  const open = (Array.isArray(copies) ? copies : []).filter((c) => c && isOpen(c.manifest));
  if (!open.length) return null;
  const c = open[0];
  const m = c.manifest;
  const more = open.length > 1 ? `; hay ${open.length - 1} copia(s) abierta(s) más (${cmd} rollback --list)` : '';
  if (m.reason === 'before-rollback') {
    const how = m.rollback_to ? `${cmd} rollback --to ${m.rollback_to} la termina` : `${cmd} rollback --list muestra a dónde volver`;
    return `${CUT_NOTICE_PREFIX}una vuelta atrás se cortó (copia ${c.name}, ${m.at || '—'}): ${how}${more}`;
  }
  const noAfter = !(m.files || []).some((f) => f && typeof f.sha256_after === 'string');
  const pieces = noAfter ? ' por piezas (la copia no sabe cómo quedaron los archivos después)' : '';
  return `${CUT_NOTICE_PREFIX}un cambio del arnés se cortó (copia ${c.name}, ${m.reason || 'sin motivo'}, ${m.at || '—'}): ${cmd} rollback --to ${c.name} vuelve a como estaba${pieces}${more}`;
}

/** `notice` sin el tramo del aviso de copia abierta (los tramos van separados por « · »); null si no queda nada. */
function stripCutNotice(notice) {
  if (typeof notice !== 'string' || !notice) return notice || null;
  const rest = notice.split(' · ').filter((s) => !s.startsWith(CUT_NOTICE_PREFIX));
  return rest.length ? rest.join(' · ') : null;
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

module.exports = {
  SCHEMA, KEEP, CUT_NOTICE_PREFIX, backupsRoot, files, take, finish, close, isOpen, openCopyNotice, stripCutNotice, list, prune,
  countBak, safeFiles,
};
