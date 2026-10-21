'use strict';
// uninstall.js — qué quita `harness.js uninstall`, qué deja y qué hay que revisar.
//
// La regla del AC 22: se quita SÓLO lo registrado (`managed` del estado, que llenó el aplicador con `--report-json`, más
// las piezas propias de harness.js), la copia fija de arranque con su programa y el estado. Lo demás se deja y se
// imprime, para que nadie tenga que adivinar qué quedó: el clon, `~/.claude/tycon.json`, las copias de seguridad, la
// carpeta de estado (con el comando para borrarla), `.dashboard/` del clon, engram/sqlite3/node, las skills de terceros,
// el `core.hooksPath` local que el aplicador borró en su día, el freno de producción (se quita con su instalador y
// `sudo`) y los enlaces que el registro no nombra (`agent-skills`, `agents`, `skills`; en el repo único el
// aplicador los crea y los registra, y entonces se quitan como cualquier pieza). Nunca se borra un
// archivo versionado en otro repo: los `AGENTS.md` puntero de los repos de producto se listan con su ruta.
//
// Funciona sin árbol (el dev borró el clon): trabaja con el registro y lo dice. El byte a byte sale de la copia
// `reason: install` más vieja (`snapshot.list`): es «cómo estaba la máquina antes del arnés», y `remove.js` vuelve a sus
// bytes un settings.json / CLAUDE.md que quedó igual a ella.
//
// Contrato con harness.js: `plan(ctx, state)` → `{ remove, retry, keep, review, pointers, … }` (sin escribir nada;
// `--dry-run` imprime `describePlan(plan)`; `retry` = lo que hoy no se pudo ni leer); `run(ctx, state, { log })` →
// `{ ok, lines }`: si algo no se pudo quitar, `ok: false` y el estado queda reescrito sólo con eso. La copia `reason: uninstall`, la
// confirmación (`--yes` o la terminal) y el candado los pone harness.js. `state` null = no instalado: «nada que quitar».
// `ctx` = `{ home, env, platform, tree }`. Sólo `require` de scripts/setup/harness/ (corre desde la copia fija).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths, write: writeState } = require('./state');
const SN = require('./snapshot');
const { removePieces } = require('./remove');

const BOOTSTRAP_FILES = ['bootstrap.js', 'bootstrap-fallback.sh', 'bootstrap-fallback.ps1'];
const POINTER_MARK = 'AGENTS.md — puntero (lo depositó el arnés';
const UNREGISTERED_LINKS = ['agent-skills', 'agents', 'skills'];
const NOTHING = 'nada que quitar: el arnés no está instalado (no hay estado)';

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };

// Lo que los hooks del arnés guardan bajo ~/.claude FUERA de la carpeta de estado: `uninstall` no lo
// quita (no son piezas registradas) y lo nombra en «deja» cuando existe. `name` es relativo a ~/.claude; `dir`, si es una
// carpeta. Cada `stores` de un hook de scripts/setup/install-effects.json que caiga acá tiene que estar en esta lista.
const HOOK_STORES = [
  { name: 'response-style', dir: true, what: 'las respuestas largas y los veredictos del medidor de estilo' },
  { name: 'blocking-meter', dir: true, what: 'el registro del medidor de pasos que bloquean' },
  { name: 'lectura-grande', dir: true, what: 'el registro del medidor de lecturas' },
  { name: 'safety-guard.log', dir: false, what: 'el registro de comandos bloqueados' },
  { name: '.tycon-retro-staleness-last-notice', dir: false, what: 'el sello del aviso de retrospectivas' },
  { name: 'clocki', dir: true, what: 'el estado del timer de Clockify' },
  { name: 'tycon-observations', dir: true, what: 'lo que grabó la grabadora de instintos' },
];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
const expandHome = (p, home) => (typeof p === 'string' ? p.replace(/^~(?=$|[\\/])/, home) : null);

/**
 * La copia `reason: install` más vieja → `map` = `{ [ruta]: <archivo de la copia> | null }` (null = no existía) y `after`
 * = `{ [ruta]: <sha256_after> }` (cómo dejó cada archivo esa instalación: con eso remove.js sabe si un hooks.json de
 * Codex o un comando sin su par en el árbol siguen siendo sólo del arnés). `{}` sin copia.
 */
function baseline(home) {
  let copies = [];
  try { copies = SN.list(home); } catch (_) { copies = []; }
  const installs = copies.filter((c) => c.manifest && c.manifest.reason === 'install');
  const oldest = installs[installs.length - 1];   // list: la más nueva primero
  const map = {}; const after = {};
  if (!oldest || !Array.isArray(oldest.manifest.files)) return { map, after, dir: null };
  for (const f of oldest.manifest.files) {
    if (!f || typeof f.path !== 'string') continue;
    map[f.path] = f.existed && f.copy ? path.join(oldest.dir, f.copy) : null;
    if (typeof f.sha256_after === 'string') after[f.path] = f.sha256_after;
  }
  return { map, after, dir: oldest.dir };
}

/** La raíz de repos: `TYCON_REPOS_ROOT` o `rutas.repos` de ~/.claude/tycon.json (como la lee el aplicador). */
function reposRoot(home, env) {
  if (env.TYCON_REPOS_ROOT) return { root: expandHome(env.TYCON_REPOS_ROOT, home), from: 'TYCON_REPOS_ROOT' };
  const cfg = readJson(path.join(home, '.claude', 'tycon.json'));
  const r = cfg && isObject(cfg.rutas) ? expandHome(cfg.rutas.repos, home) : null;
  return r ? { root: r, from: '~/.claude/tycon.json (rutas.repos)' } : { root: null, from: null };
}

/** Los `AGENTS.md` puntero (el texto con que los deposita el aplicador) en la raíz de repos, a dos niveles. */
function findPointers(root) {
  const out = [];
  // un repo que es un enlace a una carpeta también cuenta: el aplicador (`"$_REPOS_ROOT"/*/`) lo sigue y deja ahí su puntero
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(d, e.name))))).map((e) => path.join(d, e.name)); } catch (_) { return []; } };
  const look = (repo) => {
    const f = path.join(repo, 'AGENTS.md');
    try { if (fs.lstatSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(POINTER_MARK)) out.push(f); } catch (_) { /* no hay */ }
  };
  for (const a of dirs(root)) { look(a); for (const b of dirs(a)) look(b); }
  return [...new Set(out)].sort();
}

/** El freno de producción: su carpeta (`TYCON_PRODUCTION_GUARD_DIR`, por defecto /opt/tycon) o su managed-settings.d. */
function productionGuard(env) {
  const custom = typeof env.TYCON_PRODUCTION_GUARD_DIR === 'string' && env.TYCON_PRODUCTION_GUARD_DIR !== '';
  const where = [custom ? env.TYCON_PRODUCTION_GUARD_DIR : '/opt/tycon'];
  // con la variable puesta (una prueba que lo simula) sólo se mira esa carpeta: la de la máquina real no se cuela
  if (!custom) where.push('/Library/Application Support/ClaudeCode/managed-settings.d/tycon-production.json', '/etc/claude-code/managed-settings.d/tycon-production.json');
  return where.filter(lexists);
}

/** Las piezas que harness.js deja fuera del registro y también se van: la copia fija con su programa. */
function ownExtras(home, registered) {
  const dir = paths(home).harnessDir;
  const seen = new Set(registered.map((p) => path.resolve(p.where)));
  const out = [];
  for (const f of BOOTSTRAP_FILES) { const p = path.join(dir, f); if (lexists(p) && !seen.has(path.resolve(p))) out.push({ kind: 'file', where: p, id: f }); }
  const prog = path.join(dir, 'program');
  if (lexists(prog)) out.push({ kind: 'file', where: prog, id: 'program/' });
  return out;
}

/**
 * El plan, sin escribir nada.
 * @returns {{ remove: object[], keep: string[], review: string[], pointers: string[], tree: string|null, treeMissing: boolean,
 *             nothing: boolean, baseline: object, stateFile: string }}
 */
function plan(ctx, state) {
  const home = (ctx && ctx.home) || os.homedir();
  const env = (ctx && ctx.env) || process.env;
  const stateFile = paths(home).file;
  if (!isObject(state)) return { remove: [], retry: [], failing: [], keep: [], review: [], pointers: [], tree: null, treeMissing: false, nothing: true, baseline: {}, afterSha: {}, stateFile };
  const tree = (typeof state.tree === 'string' && state.tree) || (ctx && ctx.tree) || null;
  const treeMissing = !tree || !fs.existsSync(tree);
  const base = baseline(home);
  const managed = (Array.isArray(state.managed) ? state.managed : []).filter((p) => isObject(p) && p.kind && typeof p.where === 'string' && typeof p.id === 'string');
  const dry = removePieces(managed, { home, env, tree, restoreIfEqual: base.map, afterSha: base.after, platform: (ctx && ctx.platform) || process.platform, dryRun: true });
  const remove = [...dry.removed, ...ownExtras(home, managed)];
  // lo que hoy no se puede ni leer (un settings.json ilegible, un permiso): `run` lo vuelve a intentar y, si sigue
  // fallando, queda en el estado para otra corrida — nunca se pierde del registro
  const failing = dry.kept.filter((k) => k.error);
  const retry = failing.map((k) => k.piece);

  const keep = [];
  const claude = path.join(home, '.claude');
  keep.push(treeMissing ? `el clon ${tree || '(sin árbol en el estado)'} — ya no está: trabajé con el registro` : `el clon ${tree}`);
  for (const s of Array.isArray(state.sources) ? state.sources : []) {
    if (isObject(s) && s.dir && s.dir !== tree && s.name !== 'harness') keep.push(`el clon de ${s.name} ${s.dir}${fs.existsSync(s.dir) ? '' : ' (ya no está)'}`);
  }
  if (!treeMissing && fs.existsSync(path.join(tree, '.dashboard'))) keep.push(`${path.join(tree, '.dashboard')}/ (vive dentro del clon)`);
  const tj = path.join(claude, 'tycon.json');
  if (lexists(tj)) keep.push(`tu configuración ${tj}`);
  const backups = SN.backupsRoot(home);
  if (lexists(backups)) keep.push(`las copias de seguridad ${backups} (la de antes de instalar incluida)`);
  keep.push(`la carpeta de estado ${paths(home).dir}/ (registros, sellos, copias) — para borrarla: rm -rf "${paths(home).dir}"`);
  // lo que guardaron los hooks fuera de la carpeta de estado: no son piezas registradas, así que
  // quedan. La lista es `HOOK_STORES`; scripts/tests/install-effects.test.js la cruza con el `stores` de cada hook de
  // la lista de efectos, para que un hook nuevo que guarde algo bajo ~/.claude no quede sin nombrar acá
  for (const s of HOOK_STORES) {
    const p = path.join(claude, s.name);
    if (lexists(p)) keep.push(`${s.what} ${p}${s.dir ? `/ — para borrarlo: rm -rf "${p}"` : ''}`);
  }
  for (const k of dry.kept) if (!k.error) keep.push(k.why);
  keep.push('engram, sqlite3 y node: herramientas del sistema, cada una con su instalador');
  // el Node propio del arnés: se deja, como node, engram y sqlite3, con el comando para borrarlo
  try {
    const hn = require('./tycon-home.js').harnessNode({ env });
    if (lexists(hn.dir)) keep.push(`el Node propio del arnés ${hn.dir}/ — para borrarlo: rm -rf "${hn.dir}"`);
  } catch (_) { /* sin la casa propia no hay Node del arnés que nombrar */ }
  keep.push('el core.hooksPath local que el aplicador haya borrado por vestigial no vuelve: era una configuración rota y no quedó copia');
  for (const g of productionGuard(env)) keep.push(`el freno de producción (${g}): se quita con su propio instalador, con sudo`);
  // sólo los que el registro no trae: en el repo único el aplicador los crea y los registra
  const registered = new Set(managed.filter((p) => p.kind === 'link').map((p) => path.resolve(p.where)));
  for (const n of UNREGISTERED_LINKS) {
    const p = path.join(claude, n);
    if (isLink(p) && !registered.has(path.resolve(p))) keep.push(`el enlace ${p} → ${fs.readlinkSync(p)} (no está registrado: no lo toco)`);
  }

  const review = dry.review.map((r) => r.why);
  const hooksDir = (env.TYCON_GIT_HOOKS_DIR) || path.join(home, '.git-hooks');
  let names = [];
  try { names = fs.readdirSync(hooksDir); } catch (_) { names = []; }
  for (const n of names.sort()) {
    if (/^((pre|post)-commit|pre-push)\.bak-/.test(n)) review.push(`${path.join(hooksDir, n)}: la copia de un hook de git ajeno que el aplicador no pudo pasar a .local — revisalo, no la restauro sola`);
  }

  const rr = reposRoot(home, env);
  let pointers = [];
  if (rr.root) pointers = findPointers(rr.root);
  else keep.push('sin raíz de repos conocida (TYCON_REPOS_ROOT, o rutas.repos en ~/.claude/tycon.json): no busqué AGENTS.md puntero en los repos de producto');

  return { remove, retry, failing: failing.map((k) => k.why), keep, review, pointers, tree, treeMissing, nothing: false, baseline: base.map, afterSha: base.after, stateFile, home };
}

/** Las piezas por archivo, en una línea cada uno: «settings.json (<ruta>): 38 hooks, la línea de arranque, env.X». */
const insideFile = (p) => ['hook', 'setting', 'startup-line', 'block', 'import'].includes(p.kind) || (p.kind === 'codex' && path.basename(p.where) === 'AGENTS.md');
function summarize(pieces, { home = os.homedir(), localBack = null } = {}) {
  const fixedDir = paths(home).harnessDir;
  const fixed = pieces.filter((p) => p.kind === 'file' && path.dirname(p.where) === fixedDir).map((p) => p.id);
  const byWhere = new Map();
  for (const p of pieces) {
    if (!insideFile(p)) continue;
    if (!byWhere.has(p.where)) byWhere.set(p.where, []);
    byWhere.get(p.where).push(p);
  }
  const lines = [];
  for (const [where, ps] of byWhere) {
    const hooks = ps.filter((p) => p.kind === 'hook').length;
    const parts = [];
    if (hooks) parts.push(`${hooks} hook(s) del arnés`);
    if (ps.some((p) => p.kind === 'startup-line')) parts.push('la línea de arranque');
    for (const p of ps.filter((x) => x.kind === 'setting')) parts.push(`el ajuste ${p.id}`);
    for (const p of ps.filter((x) => x.kind === 'import')) parts.push(`la línea ${p.id}`);
    const blocks = ps.filter((p) => p.kind === 'block').map((p) => p.id);
    if (blocks.length) parts.push(`los bloques ${blocks.join(', ')}`);
    if (ps.some((p) => p.kind === 'codex')) parts.push('los bloques TYCON_BLOCK del espejo de Codex');
    lines.push(`${where}: ${parts.join(', ')}`);
  }
  for (const p of pieces) {
    if (insideFile(p)) continue;
    const back = localBack ? localBack.has(p.where) : lexists(`${p.where}.local`);
    if (p.kind === 'link') lines.push(`el enlace ${p.where}`);
    else if (p.kind === 'command') lines.push(`el comando ${p.where}`);
    else if (p.kind === 'git-hook') lines.push(`el hook de git ${p.where}${back ? ` (vuelve el tuyo desde ${p.id}.local)` : ''}`);
    else if (p.kind === 'launch-agent') lines.push(`el LaunchAgent ${p.id} (${p.where})`);
    else if (p.kind === 'file' && (path.dirname(p.where) === fixedDir || /^program\//.test(p.id))) continue;   // la copia fija, abajo, en una línea
    else lines.push(`${p.kind} ${p.id} (${p.where})`);
  }
  if (fixed.length) lines.push(`la copia fija de arranque en ${fixedDir}/ (${fixed.join(', ')})`);
  return lines;
}

/** El plan en líneas para la terminal (`--dry-run` y la confirmación). */
function describePlan(p) {
  if (!p || p.nothing) return [NOTHING];
  const L = [];
  // «el árbol no está» lo dice la línea del clon, en «deja» (harness.js lo antepone una vez, arriba)
  L.push('quita (sólo lo registrado):');
  for (const l of summarize(p.remove, { home: p.home })) L.push(`  - ${l}`);
  L.push(`  - el estado ${p.stateFile}`);
  if (p.failing && p.failing.length) {
    L.push('no se pueden quitar ahora (se reintentan; si siguen fallando, quedan en el estado para otra ejecución):');
    for (const w of p.failing) L.push(`  ✗ ${w}`);
  }
  L.push('deja:');
  for (const l of p.keep) L.push(`  - ${l}`);
  if (p.review.length) { L.push('revisalo:'); for (const l of p.review) L.push(`  - ${l}`); }
  if (p.pointers.length) {
    L.push('AGENTS.md puntero en repos de producto — son de cada repo (versionados): no los toco, los quitás con un commit:');
    for (const f of p.pointers) L.push(`  - ${f}`);
  }
  return L;
}

/** Quita lo del plan, la copia fija y el estado. Nunca tira. */
function run(ctx, state, { log = null } = {}) {
  const home = (ctx && ctx.home) || os.homedir();
  const env = (ctx && ctx.env) || process.env;
  if (!isObject(state)) return { ok: true, lines: [NOTHING] };
  const say = (l) => { try { if (log) log(l); } catch (_) { /* el registro nunca frena */ } };
  const p = plan(ctx, state);
  const localBack = new Set(p.remove.filter((x) => x.kind === 'git-hook' && lexists(`${x.where}.local`)).map((x) => x.where));
  const r = removePieces([...p.remove, ...p.retry], { home, env, tree: p.tree, log, restoreIfEqual: p.baseline, afterSha: p.afterSha, platform: (ctx && ctx.platform) || process.platform });
  const errors = r.kept.filter((k) => k.error);
  // el estado: si todo salió, se va; si algo no se pudo quitar, queda con eso solo, para que otra corrida lo reintente
  try {
    if (!errors.length) fs.rmSync(p.stateFile, { force: true });
    else {
      const left = Object.assign({}, state, { managed: errors.map((k) => k.piece), notice: `uninstall: ${errors.length} pieza(s) no se pudieron quitar — harness.js uninstall --yes las reintenta` });
      writeState(home, left);
    }
  } catch (e) { errors.push({ why: `no pude ${errors.length ? 'reescribir' : 'borrar'} el estado ${p.stateFile} (${e.code || e.message})` }); }
  say(`quitadas ${r.removed.length}, quedan ${r.kept.length}, a revisar ${r.review.length}, errores ${errors.length}`);

  const L = [];
  L.push(errors.length ? `desinstalado a medias: ${errors.length} pieza(s) no se pudieron quitar` : `arnés desinstalado: ${r.removed.length} pieza(s) quitadas, sólo lo registrado`);
  for (const l of summarize(r.removed, { home, localBack })) L.push(`  - ${l}`);
  if (!errors.length) L.push(`  - el estado ${p.stateFile}`);
  for (const e of errors) L.push(`  ✗ ${e.why}`);
  L.push('deja:');
  for (const l of p.keep) L.push(`  - ${l}`);
  for (const k of r.kept) if (!k.error && !p.keep.includes(k.why)) L.push(`  - ${k.why}`);
  const review = [...p.review, ...r.review.map((x) => x.why).filter((w) => !p.review.includes(w))];
  if (review.length) { L.push('revisalo:'); for (const l of review) L.push(`  - ${l}`); }
  if (p.pointers.length) {
    L.push('AGENTS.md puntero en repos de producto — son de cada repo (versionados): no los toqué, los quitás con un commit:');
    for (const f of p.pointers) L.push(`  - ${f}`);
  }
  return { ok: errors.length === 0, lines: L };
}

module.exports = { plan, run, describePlan, planLines: describePlan, baseline, findPointers, reposRoot, productionGuard, HOOK_STORES };
