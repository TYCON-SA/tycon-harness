#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * worktree-sweep.js — las carpetas de trabajo (worktrees de git) que ya se mergearon se borran solas.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * Cada story y cada arreglo abre una carpeta `<repo>-wt-*` al lado de los repos, y nadie la cierra al mergear. Ocupan disco (cada una trae su
 * `node_modules`), confunden a quien busca dónde está el trabajo vivo, y una rama vieja checkeada en una carpeta olvidada no se deja borrar.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Dos caminos, el mismo criterio:
 *   · Al arrancar sesión (SessionStart), en cada arranque: dice en una línea lo que dejó la pasada anterior y lanza la
 *     suya de fondo, sin esperarla (`--pass`, desprendida). La pasada recorre los repos conocidos —los de la raíz de
 *     repos de la máquina (`scripts/lib/repos-root.js`) hasta dos niveles, y el del cwd— y sus carpetas de trabajo, de
 *     a `MAX_PER_PASS`, siguiendo desde el cursor de la anterior (`worktree-sweep-cursor`). Borra (`git worktree
 *     remove` + `git branch -d`) las que están LIMPIAS y con su HEAD ya en origin/main. Las que tienen cambios o commits
 *     sin mergear sólo las nombra, una vez por día (`worktree-sweep-notice-last`). Hay una sola pasada viva por máquina
 *     (`worktree-sweep.lock`, con el pid; el de un proceso muerto se pisa). Una vez por semana (`branch-count-last`),
 *     la pasada trae las ramas del servidor (`git fetch --prune`) y cuenta las remotas ya entradas a main; el arranque
 *     siguiente dice cuántas y el comando para borrarlas.
 *   · Al cerrar una story (`/tycon-pipeline close`, «Cerrar la historia»): `--story <N.M>` limita a las carpetas cuya rama nombra
 *     la story, trae origin primero (`git fetch`) y dice qué hizo con cada una.
 *
 * El marcador de una ejecución adentro de la carpeta (`<estado>/active/`): si hay uno solo, de una ejecución terminada
 * (sin pasos ni controles abiertos ni sin medir, con el pase cerrado, el ok de guardar vigente y sin una firma
 * pendiente en `<estado>/coordination/signatures.json`), lo cierra con `marker.js clear-session` y después borra. Con
 * una ejecución sin terminar, estacionada (`<estado>/parked/`), con más de un marcador, o con un marcador que no se
 * puede leer, no borra y la nombra con sus sesiones.
 *
 * ── LO QUE NUNCA TOCA ────────────────────────────────────────────────────────────────────────────────────────────
 *   · el checkout principal de un repo (el primero de `git worktree list`);
 *   · una carpeta con cambios: archivos modificados, en el índice o sin seguimiento (`git status --porcelain`), o con
 *     evidencia que git ignora en `.advisors/` (salvo la copia de la apertura de una ejecución, que es de open-runs.js).
 *     Además el borrado va sin `--force`: si git ve algo, se niega él también;
 *   · una carpeta que es, o contiene, el cwd de una sesión viva (`<claude>/sessions/`), aunque esté quieta;
 *   · una carpeta con commits que no están en origin/main (o en la rama por defecto de origin);
 *   · una carpeta bloqueada (`git worktree lock`), una que ya no existe en disco, o la que contiene el cwd de esta sesión;
 *   · una carpeta con una ejecución abierta adentro (su apertura vigente en gates.log, lib/open-runs.js): borrarla deja
 *     la ejecución perdida. Si el registro no se puede leer, no se borra ninguna (@story-8.318);
 *   · al arrancar, además: una carpeta usada en las últimas horas (puede ser de otra sesión viva que acaba de mergear y
 *     sigue ahí) y una recién creada sin trabajo propio (su HEAD es justo la punta de origin/main).
 * Al arrancar no se hace `git fetch`: con los refs de origin viejos se borra de menos, nunca de más.
 *
 * Mac, Linux y Windows: sólo Node y git, sin shell.
 *
 * Apagar: TYCON_WORKTREE_SWEEP=0 (los dos caminos). Horas de uso que protegen una carpeta al arrancar:
 * `maintenance.worktree_idle_hours` (scripts/lib/tycon-config.js, 4 de fábrica), que TYCON_WORKTREE_SWEEP_IDLE_HOURS pisa
 * en la máquina. La pasada de todas las carpetas, ahora y diciendo qué hizo: --force. Probar sin borrar: --dry-run.
 * Fail-open: un hook de arranque nunca frena ni tira.
 *
 * Uso:
 *   node scripts/hooks/worktree-sweep.js [--max <n>]             ← el hook de arranque (lanza --pass de fondo)
 *   node scripts/hooks/worktree-sweep.js --pass [--max <n>]      ← una pasada de fondo, desde el cursor
 *   node scripts/hooks/worktree-sweep.js --story <N.M> [--dry-run] [--json]
 *   node scripts/hooks/worktree-sweep.js --force [--dry-run]     ← la pasada de todas, ahora
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

const STAMP_NAME = 'worktree-sweep-last-run';
const LOCK_NAME = 'worktree-sweep.lock';
const CURSOR_NAME = 'worktree-sweep-cursor';
const RESULT_NAME = 'worktree-sweep-result.json';
const NOTICE_DAY_NAME = 'worktree-sweep-notice-last';
const BRANCH_STAMP_NAME = 'branch-count-last';
const BRANCH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// una pasada larga sigue siendo de este proceso: el candado sólo se pisa si su proceso murió o pasó media hora
const LOCK_STALE_MS = 30 * 60 * 1000;
// un candado recién creado y todavía vacío es de una pasada que está por escribir su pid
const LOCK_FRESH_MS = 10 * 1000;
// cuántas carpetas mira una pasada de fondo; la siguiente sigue desde el cursor
const MAX_PER_PASS = 20;
const GIT_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 60000;
const MAX_NAMES = 10;
const WIN = process.platform === 'win32';
// la copia de la apertura de una ejecución (lib/open-runs.js) no es evidencia: la juzga el chequeo de ejecuciones abiertas
const RUN_OPEN_COPY = /^\.advisors\/pipeline-runs\/[^/]+\/run-open\.json$/;

function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function norm(p) { const r = path.resolve(p); return WIN ? r.toLowerCase() : r; }
// la ruta con los enlaces resueltos, aunque ya no exista: se resuelve la carpeta de arriba que existe y se suma el resto
function realOf(p) {
  let d = path.resolve(p);
  const resto = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(d), ...[...resto].reverse()); } catch (_) { /* sube */ }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    resto.push(path.basename(d));
    d = arriba;
  }
  return null;
}
/**
 * ¿`child` es `parent` o está adentro? Con los enlaces resueltos y, donde el sistema no distingue mayúsculas (macOS y
 * Windows), sin distinguirlas: la misma carpeta por otro nombre cuenta como la misma. Lo que no es texto no está adentro.
 */
function inside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const sinMayus = WIN || process.platform === 'darwin';
  const formas = (p) => [path.resolve(p), realOf(p)].filter(Boolean).map((x) => (sinMayus ? x.toLowerCase() : x));
  for (const c of formas(child)) for (const q of formas(parent)) if (c === q || c.startsWith(q + path.sep)) return true;
  return false;
}

/** El checkout principal de un repo (carpeta con `.git` como directorio), o null. */
function mainRepoOf(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!r.ok || !r.out) return null;
  const common = path.resolve(dir, r.out);
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

/** Los repos conocidos: la raíz de repos (dos niveles) y el del cwd. Sólo checkouts principales, sin repetir. */
function knownRepos(cwd) {
  const found = new Map();
  const add = (p) => { const m = mainRepoOf(p); if (m && !found.has(norm(m))) found.set(norm(m), m); };
  // todas las carpetas de repos de la máquina (puede haber más de una)
  let roots = [];
  try {
    const lib = path.join(__dirname, '..', 'lib', 'repos-root.js');
    if (fs.existsSync(lib)) roots = require(lib).resolveReposRoot(process.env.TYCON_REPOS_ROOT).roots || [];
  } catch (_) { roots = []; }
  const isMain = (p) => { try { return fs.statSync(path.join(p, '.git')).isDirectory(); } catch (_) { return false; } };
  const kids = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(p, e.name)); } catch (_) { return []; } };
  for (const root of roots) {
    for (const a of kids(root)) {
      if (isMain(a)) { add(a); continue; }
      for (const b of kids(a)) if (isMain(b)) add(b);
    }
  }
  if (cwd) add(cwd);
  return [...found.values()];
}

/** `git worktree list --porcelain` → [{ path, head, branch, locked, prunable }]; el primero es el principal. */
function listWorktrees(repo) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return null;
  const out = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)), head: null, branch: null, locked: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

/** La rama por defecto de origin (origin/HEAD, si no origin/main, si no origin/master), o null. */
function targetRef(repo) {
  const h = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const cands = [...(h.ok && h.out ? [h.out.replace(/^refs\/remotes\//, '')] : []), 'origin/main', 'origin/master'];
  for (const c of cands) { const v = git(repo, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]); if (v.ok && v.out) return { name: c, sha: v.out }; }
  return null;
}

/** Última vez que se usó la carpeta: lo más nuevo entre su índice, su HEAD, su historial de HEAD y la carpeta. */
function lastUsedMs(wt) {
  let t = 0;
  const g = git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const files = [wt];
  if (g.ok && g.out) for (const f of ['index', 'HEAD', path.join('logs', 'HEAD')]) files.push(path.join(g.out, f));
  for (const f of files) { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch (_) { /* no está */ } }
  return t;
}

/** El token de la story en una rama: `N.M` casa con `feat/N.M-a-x` y `story/N-M`, no con `1N.M` ni con `N.M0`. */
function branchNamesStory(branch, story) {
  if (!branch || !story) return false;
  const alt = story.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '[.-]');
  return new RegExp(`(^|[^0-9.])${alt}($|[^0-9])`).test(branch);
}

/**
 * Evalúa (y, si no es `dryRun`, borra) las carpetas de trabajo de los repos dados. Con `max`, mira como mucho esa
 * cantidad, empezando por la que sigue a `cursor` (las carpetas de todos los repos, por ruta), y devuelve en `cursor`
 * dónde quedó: vacío si llegó al final.
 * Devuelve { removed: [...], kept: [{ name, why }], branchKept: [...], checked, unreadable: [...], cursor }.
 */
function sweep({ repos, cwd, story = null, idleMs = 0, now = Date.now(), dryRun = false, fetch = false, home = os.homedir(), max = 0, cursor = '' }) {
  const res = { removed: [], kept: [], branchKept: [], checked: 0, unreadable: [], cursor: '' };
  // las ejecuciones abiertas (gates.log), leídas una vez y sólo si alguna carpeta llega a borrarse (@story-8.318)
  let abiertas;
  // `salvo`: la sesión cuya ejecución terminada se va a cerrar, que no cuenta como la de otra
  const abiertaEn = (wt, { salvo = null } = {}) => {
    if (abiertas === undefined) abiertas = ejecucionesAbiertas(home);
    if (!abiertas.ok) return { why: `no pude ver si tiene una ejecución abierta (${abiertas.error})` };
    const a = abiertas.lib.abiertasDentro(wt, { eventos: abiertas.eventos }).abiertas.find((x) => !salvo || x.sesion !== salvo);
    return a ? { why: `tiene una ejecución abierta (story ${a.story || '?'}, sesión ${a.sesion})` } : null;
  };
  // los marcadores, las firmas pendientes y las sesiones vivas: también una vez, y sólo si alguna llega a borrarse
  let ctx;
  const contexto = () => { if (ctx === undefined) ctx = leerContexto(home); return ctx; };
  const todas = [];
  for (const repo of repos) {
    const list = listWorktrees(repo);
    if (!list) { res.unreadable.push(path.basename(repo)); continue; }
    let linked = list.slice(1).filter((w) => !w.prunable && fs.existsSync(w.path));
    if (story) linked = linked.filter((w) => branchNamesStory(w.branch, story));
    if (!linked.length) continue;
    if (fetch) git(repo, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    const target = targetRef(repo);
    if (!target) { res.unreadable.push(`${path.basename(repo)} (sin origin/main)`); continue; }
    for (const w of linked) todas.push({ repo, target, w });
  }
  let turno = todas;
  if (max > 0) {
    todas.sort((a, b) => (norm(a.w.path) < norm(b.w.path) ? -1 : norm(a.w.path) > norm(b.w.path) ? 1 : 0));
    const desde = cursor ? todas.findIndex((x) => norm(x.w.path) > cursor) : 0;
    turno = (desde < 0 ? [] : todas.slice(desde)).slice(0, max);
    res.cursor = turno.length === max && desde + max < todas.length ? norm(turno[turno.length - 1].w.path) : '';
  }
  for (const item of turno) {
    res.checked++;
    const name = path.basename(item.w.path);
    // una carpeta que no se puede juzgar queda, con su motivo, y la pasada sigue con las demás
    try { juzgarCarpeta(item, { res, name, cwd, story, idleMs, now, dryRun, home, abiertaEn, contexto }); } catch (e) {
      res.kept.push({ name, why: `no pude juzgarla (${(e && e.message) || e})` });
    }
  }
  return res;
}

/** Juzga una carpeta: la borra, la nombra en `res.kept` o la deja en silencio. */
function juzgarCarpeta({ repo, target, w }, { res, name, cwd, story, idleMs, now, dryRun, home, abiertaEn, contexto }) {
  if (cwd && inside(cwd, w.path)) { res.kept.push({ name, why: 'es la carpeta de esta sesión' }); return; }
  if (w.locked) { if (story) res.kept.push({ name, why: 'está bloqueada (git worktree lock)' }); return; }
  // al arrancar, una carpeta en uso o recién creada se deja en silencio: puede ser de otra sesión viva
  if (!story && idleMs > 0 && now - lastUsedMs(w.path) < idleMs) return;
  const st = git(w.path, ['status', '--porcelain']);
  if (!st.ok) { res.kept.push({ name, why: 'no pude leer su estado' }); return; }
  if (st.out) { res.kept.push({ name, why: `tiene ${st.out.split('\n').length} archivo(s) con cambios`, cambios: true }); return; }
  const ev = evidenciaIgnorada(w.path);
  if (ev === null) { res.kept.push({ name, why: 'no pude ver si tiene evidencia ignorada en .advisors' }); return; }
  if (ev) { res.kept.push({ name, why: `tiene ${ev} archivo(s) de evidencia sin guardar en .advisors`, cambios: true }); return; }
  // `git worktree remove` borra sin quejarse lo que git ignora: sólo se deja borrar lo que se vuelve a armar solo
  const ign = ignoradosQueSePierden(w.path);
  if (ign === null) { res.kept.push({ name, why: 'no pude ver qué archivos ignorados tiene' }); return; }
  if (ign.length) { res.kept.push({ name, why: `tiene ${ign.length} archivo(s) que git ignora y se perderían (${ign.slice(0, 3).join(', ')}${ign.length > 3 ? ', …' : ''})`, cambios: true }); return; }
  const head = git(w.path, ['rev-parse', 'HEAD']).out;
  if (!head) { res.kept.push({ name, why: 'no pude leer su HEAD' }); return; }
  const merged = git(repo, ['merge-base', '--is-ancestor', head, target.sha]).ok;
  if (!merged) { res.kept.push({ name, why: `commits sin mergear a ${target.name}` }); return; }
  if (!story && head === target.sha) return;
  // la carpeta de una sesión viva no se toca, aunque esté quieta
  const viva = sesionVivaEn(contexto(), w.path);
  if (viva) { res.kept.push({ name, why: viva }); return; }
  // una ejecución abierta de OTRA sesión adentro: la carpeta queda, y el marcador de la terminada no se cierra
  const ajena = abiertaEn(w.path, { salvo: marcadorDe(contexto(), w.path) });
  if (ajena) { res.kept.push({ name, why: ajena.why }); return; }
  // el marcador de una ejecución terminada se cierra antes de borrar; con cualquier otro, la carpeta queda
  const marca = juzgarMarcadores(contexto(), w.path, { home, dryRun });
  if (marca) { res.kept.push({ name, why: marca }); return; }
  // con la carpeta de una ejecución abierta adentro, borrarla deja la ejecución perdida: se cierra antes
  const abierta = abiertaEn(w.path);
  if (abierta) { res.kept.push({ name, why: abierta.why }); return; }
  if (dryRun) { res.removed.push(name); return; }
  const rm = git(repo, ['worktree', 'remove', w.path]);
  if (!rm.ok) {
    // otra pasada pudo borrarla en el medio: lo que ya no está no es un error
    if (!fs.existsSync(w.path)) return;
    const cerrado = marcadorDe(contexto(), w.path) ? ' (su marcador ya estaba cerrado)' : '';
    res.kept.push({ name, why: `git no la quiso borrar${cerrado} (${rm.err.split('\n')[0] || 'sin motivo'})` });
    return;
  }
  res.removed.push(name);
  if (w.branch) {
    const b = git(repo, ['branch', '-d', w.branch]);
    if (!b.ok) res.branchKept.push(w.branch);
  }
}

/** Cuántos archivos que git ignora hay en `.advisors/` (sin la copia de la apertura); null si no se pudo mirar. */
function evidenciaIgnorada(wt) {
  // `traditional` con `--untracked-files=all` nombra cada archivo de una carpeta ignorada; `matching` la nombraría una vez
  const r = git(wt, ['status', '--porcelain', '--ignored=traditional', '--untracked-files=all', '--', '.advisors']);
  if (!r.ok) return null;
  return r.out.split('\n').filter((l) => l.startsWith('!! ') && !RUN_OPEN_COPY.test(l.slice(3).replace(/^"|"$/g, ''))).length;
}

// lo ignorado que se vuelve a armar solo (dependencias, índices, salidas de compilación y de pruebas, cachés): borrarlo
// no pierde nada. Cualquier otra cosa que git ignora (notas, `.env`, una base local, ajustes del editor) se perdería.
const SE_REARMA = new Set(['node_modules', '.codegraph', '.bench', '.dashboard', '__pycache__', '.pytest_cache', '.mypy_cache',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'bin', 'obj', 'target', '.gradle', '.DS_Store']);

/** Lo que git ignora en `wt` y se perdería al borrarla (sin `.advisors`, que se mira aparte); null si no se pudo mirar. */
function ignoradosQueSePierden(wt) {
  const r = git(wt, ['status', '--porcelain', '--ignored=matching', '--untracked-files=normal']);
  if (!r.ok) return null;
  return r.out.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3).replace(/^"|"$/g, '').replace(/\/$/, ''))
    .filter((p) => p && !p.split('/').some((parte) => SE_REARMA.has(parte) || parte === '.advisors') && !/\.py[co]$/.test(p));
}

/**
 * Lo que hace falta para juzgar una ejecución adentro de una carpeta: los marcadores activos, los estacionados, las
 * firmas pendientes y las sesiones vivas. Lo que no se pudo leer queda con su motivo, y esa parte no deja borrar.
 */
function leerContexto(home) {
  const estado = stateDirOf(home);
  const ctx = { home, marcadores: [], ilegibles: [], firmas: null, firmasError: null, vivas: null, vivasError: null };
  const activos = path.join(estado, 'active');
  let archivos = [];
  try { archivos = fs.readdirSync(activos).filter((f) => f.endsWith('.json')); } catch (e) {
    if (!e || e.code !== 'ENOENT') ctx.ilegibles.push(`la carpeta de marcadores (${(e && e.code) || 'error'})`);
  }
  for (const f of archivos) {
    const sid = f.slice(0, -5);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(activos, f), 'utf8'));
      if (!m || typeof m !== 'object') throw new Error('no es un objeto');
      ctx.marcadores.push({ sid, m });
    } catch (e) {
      // borrado por otra pasada en el medio: no es un marcador ilegible
      if (e && e.code === 'ENOENT') continue;
      ctx.ilegibles.push(`el marcador ${sid}`);
    }
  }
  try {
    const lista = JSON.parse(fs.readFileSync(path.join(estado, 'coordination', 'signatures.json'), 'utf8'));
    ctx.firmas = Array.isArray(lista) ? lista : null;
    if (!ctx.firmas) ctx.firmasError = 'no es una lista';
  } catch (e) {
    if (e && e.code === 'ENOENT') ctx.firmas = [];
    else ctx.firmasError = (e && (e.code || e.message)) || 'error';
  }
  const sesiones = path.join(claudeDirOf(home), 'sessions');
  try {
    ctx.vivas = [];
    for (const f of fs.readdirSync(sesiones).filter((x) => x.endsWith('.json'))) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(sesiones, f), 'utf8')); } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        throw new Error(`${f} no se puede leer`);
      }
      const pid = Number(s && s.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!pidAlive(pid)) continue;
      // una sesión viva que no dice su carpeta no se puede proteger: como un archivo ilegible, no deja borrar
      if (typeof s.cwd !== 'string' || !s.cwd) throw new Error(`${f} no dice su carpeta`);
      ctx.vivas.push({ sid: String(s.sessionId || f.slice(0, -5)), name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : null, cwd: s.cwd });
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') ctx.vivas = [];
    else { ctx.vivas = null; ctx.vivasError = (e && (e.code || e.message)) || 'error'; }
  }
  return ctx;
}

function claudeDirOf(home) {
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  try { if (fs.existsSync(lib)) return require(lib).claudeDir(home); } catch (_) { /* la de siempre */ }
  return path.join(home || os.homedir(), '.claude');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}

/** El motivo para no tocar la carpeta de una sesión viva, o null. Sin poder ver las sesiones, tampoco se toca. */
function sesionVivaEn(ctx, wt) {
  if (!ctx.vivas) return `no pude ver las sesiones vivas (${ctx.vivasError})`;
  const v = ctx.vivas.find((s) => inside(s.cwd, wt));
  return v ? `es la carpeta de una sesión viva: ${v.name ? `${v.name} (${v.sid})` : v.sid}` : null;
}

/**
 * Los marcadores de la carpeta: ninguno → null (se puede borrar); uno solo, de una ejecución terminada y sin firma
 * pendiente → lo cierra con `marker.js clear-session` y devuelve null; cualquier otro caso → el motivo, con las sesiones.
 */
function juzgarMarcadores(ctx, wt, { home, dryRun }) {
  if (ctx.ilegibles.length) return `no pude leer ${ctx.ilegibles.join(', ')}: no sé de qué carpeta es`;
  // un marcador con una ruta que no es texto no dice de qué carpeta es: no deja borrar ninguna (como uno ilegible)
  const raros = ctx.marcadores.filter(({ m }) => (m.repoPath != null && typeof m.repoPath !== 'string') || (m.storyPath != null && typeof m.storyPath !== 'string'));
  if (raros.length) return `no pude leer las rutas del marcador ${raros.map((x) => x.sid).join(', ')}: no sé de qué carpeta es`;
  const deAca = marcadoresDe(ctx, wt);
  if (!deAca.length) return null;
  if (deAca.length > 1) return `tiene ${deAca.length} ejecuciones (sesiones ${deAca.map((x) => x.sid).sort().join(', ')})`;
  const { sid, m } = deAca[0];
  // la sesión de la ejecución sigue viva, aunque haya arrancado en otra carpeta y entrado a ésta después
  if (!ctx.vivas) return `no pude ver las sesiones vivas (${ctx.vivasError})`;
  if (ctx.vivas.some((v) => v.sid === sid)) return `su ejecución es de una sesión viva (sesión ${sid})`;
  const estacionada = estacionadaDe(sid, m, home);
  if (estacionada) return `su ejecución está estacionada (sesión ${sid}${estacionada === true ? '' : `: ${estacionada}`})`;
  const fin = terminada(m);
  if (!fin.ok) return `su ejecución no terminó (sesión ${sid}: ${fin.motivo})`;
  if (ctx.firmasError) return `no pude leer las firmas pendientes (${ctx.firmasError}) de su ejecución (sesión ${sid})`;
  const firma = ctx.firmas.find((f) => f && ([f.cwd, f.carpeta].some((c) => typeof c === 'string' && c && inside(c, wt))
    || f.destino === sid || f.sesion === sid || (typeof f.key === 'string' && f.key.includes(wt))));
  if (firma) return `su ejecución tiene una firma pendiente (sesión ${sid})`;
  if (dryRun) return null;
  const markerJs = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  if (!fs.existsSync(markerJs)) return `no pude cerrar su marcador: este arnés no trae marker.js (sesión ${sid})`;
  const r = spawnSync(process.execPath, [markerJs, 'clear-session', sid], { cwd: wt, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
  // otra pasada pudo cerrarlo en el medio: «no había marcador» no es un error
  if (r.status === 0 || /no había marcador de esa sesión/.test(r.stderr || '')) return null;
  return `no pude cerrar su marcador (sesión ${sid}: ${String(r.stderr || r.error || '').split('\n')[0] || `salió ${r.status}`})`;
}

/** Los marcadores cuya carpeta (`repoPath`, o la de su `storyPath`) es `wt` o está adentro. */
function marcadoresDe(ctx, wt) {
  return ctx.marcadores.filter(({ m }) => (typeof m.repoPath === 'string' && inside(m.repoPath, wt))
    || (typeof m.storyPath === 'string' && path.isAbsolute(m.storyPath) && inside(path.dirname(m.storyPath), wt)));
}

/** La sesión del único marcador de `wt`, o null (ninguno, varios, o los marcadores no se pudieron leer). */
function marcadorDe(ctx, wt) {
  if (ctx.ilegibles.length) return null;
  const deAca = marcadoresDe(ctx, wt);
  return deAca.length === 1 ? deAca[0].sid : null;
}

/** true, el motivo de una estacionada, o null. Lo lee open-runs.js si viene con el arnés; si no, por su archivo. */
function estacionadaDe(sid, m, home) {
  try {
    const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js');
    if (fs.existsSync(lib)) {
      const marca = require(lib).marcaDeEstacionada(sid, m, { home, avisar: () => {} });
      if (!marca) return null;
      return marca.kind === 'ilegible' ? 'su marca no se puede leer' : true;
    }
  } catch (e) { return `no pude ver si está estacionada (${e.message})`; }
  return fs.existsSync(path.join(stateDirOf(home), 'parked', `${String(sid).replace(/[/\\]/g, '_')}.json`)) || null;
}

/**
 * ¿La ejecución terminó? El estado de cierre de lib/run-close.js (sin pasos sin correr, sin controles en rojo ni sin
 * medir, con el pase cerrado y sin esperar a una persona) y el ok de guardar vigente (lib/save-ok.js).
 */
function terminada(m) {
  const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
  let rc, so;
  try { rc = require(path.join(lib, 'run-close.js')); so = require(path.join(lib, 'save-ok.js')); } catch (e) {
    return { ok: false, motivo: `no pude ver su estado (${(e && (e.code || e.message)) || 'error'})` };
  }
  try {
    const e = rc.estado(m);
    if (rc.abierta(e) || e.sinMedir.length || e.detenida) return { ok: false, motivo: rc.motivoDe(e) || 'abierta' };
    const v = so.vigente({ saveOk: m.saveOk });
    if (!v.ok) return { ok: false, motivo: `sin el ok de guardar vigente: ${v.motivo}` };
    return { ok: true };
  } catch (e) { return { ok: false, motivo: `no pude ver su estado (${e.message})` }; }
}

/**
 * Las aperturas y cierres de gates.log: `{ ok: true, lib, eventos }`, o `{ ok: false, error }` si no se pueden leer o
 * este archivo viaja sin skills/tycon-pipeline/scripts/lib/open-runs.js. Sin saber, ninguna carpeta se borra.
 */
function ejecucionesAbiertas(home) {
  const libPath = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js');
  let lib;
  try { lib = require(libPath); } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') return { ok: false, error: `no pude cargar open-runs.js (${(e && (e.code || e.message)) || e})` };
    lib = lectorSuelto();
  }
  try {
    const r = lib.leerEventos(home);
    if (!r.ok && !r.ausente) return { ok: false, error: `gates.log: ${r.error}` };
    return { ok: true, lib, eventos: r.ok ? r.eventos : [] };
  } catch (e) { return { ok: false, error: e.code || e.message }; }
}

/**
 * La lectura de las aperturas cuando este archivo viaja suelto, sin open-runs.js (el banco lo copia solo): los renglones
 * `run-open` y `run-close` de gates.log, el último de cada sesión, y la carpeta adentro por prefijo de ruta.
 */
function lectorSuelto() {
  return {
    leerEventos(home) {
      let raw;
      try { raw = fs.readFileSync(path.join(stateDirOf(home || os.homedir()), 'gates.log'), 'utf8'); } catch (e) {
        return e && e.code === 'ENOENT' ? { ok: false, ausente: true } : { ok: false, error: (e && (e.code || e.message)) || 'error' };
      }
      const eventos = [];
      for (const l of raw.split('\n')) {
        if (!l.includes('"run-open"') && !l.includes('"run-close"')) continue;
        try { const o = JSON.parse(l); if (o && (o.name === 'run-open' || o.name === 'run-close') && o.sesion) eventos.push(o); } catch (_) { /* otro renglón */ }
      }
      return { ok: true, eventos };
    },
    abiertasDentro(carpeta, { eventos = [] } = {}) {
      const ultimo = new Map();
      for (const e of eventos) ultimo.set(e.sesion, e);
      const abiertas = [...ultimo.values()].filter((e) => e.name === 'run-open' && e.runDir && inside(e.runDir, carpeta))
        .map((e) => ({ sesion: e.sesion, story: e.story != null ? String(e.story) : null, runDir: e.runDir }));
      return { ok: true, abiertas };
    },
  };
}

function names(list) {
  const shown = list.slice(0, MAX_NAMES).join(', ');
  return list.length > MAX_NAMES ? `${shown} y ${list.length - MAX_NAMES} más` : shown;
}

/** La línea del arranque; null si no hay nada que decir. Con `sinNombrar`, sin las que quedaron ni las sin revisar. */
function startupLine(res, dryRun, { sinNombrar = false } = {}) {
  const parts = [];
  if (res.removed.length) parts.push(`${dryRun ? 'borraría' : 'borré'} ${res.removed.length} ya mergeada(s) (${names(res.removed)})`);
  if (!sinNombrar && res.kept.length) parts.push(`no toqué ${res.kept.length} con trabajo: ${names(res.kept.map((k) => `${k.name} (${k.why})`))}`);
  if (res.branchKept.length) parts.push(`la rama quedó en ${names(res.branchKept)} (git branch -d no la soltó)`);
  if (!sinNombrar && res.unreadable.length) parts.push(`sin revisar: ${names(res.unreadable)}`);
  return parts.length ? `carpetas de trabajo: ${parts.join(' · ')}. Apagar: TYCON_WORKTREE_SWEEP=0` : null;
}

/** La línea de las ramas remotas ya entradas, o null. */
function branchesLine(b) {
  if (!b || !b.total) return null;
  const cuenta = b.repos.filter((r) => r.n).map((r) => `${path.basename(r.repo)}: ${r.n}`).join(', ');
  const comandos = b.repos.filter((r) => r.n).map((r) => `git -C "${r.repo}" for-each-ref --merged ${r.target} --format='%(refname:lstrip=3)' refs/remotes/origin | grep -v -x -e HEAD -e ${r.target.replace(/^origin\//, '')} | xargs -n 50 git -C "${r.repo}" push origin --delete`);
  return `ramas: ${b.total} rama(s) remota(s) ya entrada(s) a main que el servidor no borró (${cuenta}). Para borrarlas: ${comandos.join(' ; ')}`;
}

/**
 * Una vez por semana: trae las ramas del servidor (`fetch --prune`, sin pedir clave) y cuenta las remotas ya entradas.
 * Un repo que no se pudo traer no se cuenta esa vez. `null` si no tocaba o si no pudo contar ninguno.
 */
function countBranches(repos, home, now = Date.now()) {
  const sello = path.join(stateDirOf(home), BRANCH_STAMP_NAME);
  try { if (now - fs.statSync(sello).mtimeMs < BRANCH_EVERY_MS) return null; } catch (_) { /* sin sello: toca */ }
  const out = { total: 0, repos: [], skipped: [] };
  for (const repo of repos) {
    const f = git(repo, ['fetch', '--quiet', '--prune', 'origin'], FETCH_TIMEOUT_MS);
    if (!f.ok) { out.skipped.push(path.basename(repo)); continue; }
    const target = targetRef(repo);
    if (!target) { out.skipped.push(path.basename(repo)); continue; }
    const r = git(repo, ['for-each-ref', '--merged', target.sha, '--format=%(refname)', 'refs/remotes/origin']);
    if (!r.ok) { out.skipped.push(path.basename(repo)); continue; }
    const propia = `refs/remotes/${target.name}`;
    const n = r.out.split('\n').filter((x) => x && x !== propia && x !== 'refs/remotes/origin/HEAD').length;
    out.repos.push({ repo, target: target.name, n });
    out.total += n;
  }
  if (!out.repos.length) return null;
  try { fs.mkdirSync(path.dirname(sello), { recursive: true }); fs.writeFileSync(sello, new Date(now).toISOString() + '\n'); } catch (_) { /* sin sello: se cuenta de nuevo */ }
  return out;
}

/** Las horas de quietud: `maintenance.worktree_idle_hours` (o su variable); si el lector no está o falla, la variable o 4. */
function idleHours(env = process.env) {
  const lib = path.join(__dirname, '..', 'lib', 'tycon-config.js');
  try {
    if (fs.existsSync(lib)) {
      const tc = require(lib);
      const r = tc.leerParaHook({});
      if (r.ok) return tc.mantenimiento(r.config).worktree_idle_hours.value;
    }
  } catch (_) { /* fail-open: la variable o el de fábrica */ }
  const hours = Number(env.TYCON_WORKTREE_SWEEP_IDLE_HOURS);
  return env.TYCON_WORKTREE_SWEEP_IDLE_HOURS !== undefined && env.TYCON_WORKTREE_SWEEP_IDLE_HOURS !== '' && Number.isFinite(hours) && hours >= 0 ? hours : 4;
}

/** El candado de la pasada: `'taken'`, `'busy'` (otra viva) o `'error'`. El de un proceso muerto, viejo o ilegible se pisa. */
function takeLock(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { return 'error'; }
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return 'taken';
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return 'error';
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { held = null; }
      const age = held && typeof held.at === 'string' ? Date.now() - Date.parse(held.at) : Infinity;
      if (held && Number.isInteger(held.pid) && pidAlive(held.pid) && age < LOCK_STALE_MS) return 'busy';
      // uno ilegible y recién hecho puede ser el de otra pasada que todavía no escribió su pid: se respeta un rato
      if (!held) { try { const st = fs.statSync(file); if (st.isFile() && Date.now() - st.mtimeMs < LOCK_FRESH_MS) return 'busy'; } catch (_) { /* ya no está */ } }
      // lo que no es un candado válido (también una carpeta con ese nombre) se saca: si no, ninguna pasada corre más
      try { fs.rmSync(file, { force: true, recursive: true }); } catch (_) { return 'error'; }
    }
  }
  return 'busy';
}
function releaseLock(file) {
  try { const held = JSON.parse(fs.readFileSync(file, 'utf8')); if (held && held.pid === process.pid) fs.rmSync(file, { force: true }); } catch (_) { /* nada */ }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n');
  fs.renameSync(tmp, file);
}
const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * Lo que dice el arranque de la pasada anterior, una vez: lo borrado siempre; lo que quedó y lo sin revisar, una vez
 * por día; las ramas, cuando se contaron. Marca el resultado como mostrado.
 */
function takeNotice(home) {
  const estado = stateDirOf(home);
  const file = path.join(estado, RESULT_NAME);
  const res = readJson(file);
  if (!res || res.shown === true) return [];
  const diaFile = path.join(estado, NOTICE_DAY_NAME);
  let dia = null;
  try { dia = fs.readFileSync(diaFile, 'utf8').trim(); } catch (_) { dia = null; }
  const hayNombres = Boolean(res.kept.length || res.unreadable.length);
  const nombrar = hayNombres && dia !== today();
  const lines = [startupLine(res, false, { sinNombrar: !nombrar }), branchesLine(res.branches)].filter(Boolean);
  // una pasada de fondo pudo escribir otro resultado en el medio: se marca sólo si sigue siendo el mismo
  const again = readJson(file);
  if (!again || again.at !== res.at) return lines;
  try { writeAtomic(file, { ...again, shown: true }); } catch (_) { return []; }   // sin poder marcarlo, mejor callar que repetir
  if (nombrar) { try { fs.writeFileSync(diaFile, today() + '\n'); } catch (_) { /* mañana se repite: no es grave */ } }
  return lines;
}

/** Lanza la pasada desprendida y vuelve. Nunca tira. */
function launch(max) {
  try {
    const child = spawn(process.execPath, [__filename, '--pass', ...(max ? ['--max', String(max)] : [])], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.on('error', () => { /* fail-open: la próxima sesión lo intenta de nuevo */ });
    child.unref();
  } catch (_) { /* fail-open */ }
}

/** Una pasada de fondo: con el candado, desde el cursor, y el conteo semanal de ramas. Deja el resultado escrito. */
function pass({ home, cwd, max }) {
  const estado = stateDirOf(home);
  const lock = path.join(estado, LOCK_NAME);
  if (takeLock(lock) !== 'taken') return null;
  try {
    let cursor = '';
    try { cursor = fs.readFileSync(path.join(estado, CURSOR_NAME), 'utf8').trim(); } catch (_) { cursor = ''; }
    const repos = knownRepos(cwd);
    const res = sweep({ repos, cwd, idleMs: idleHours() * 60 * 60 * 1000, home, max: max || MAX_PER_PASS, cursor });
    try { fs.writeFileSync(path.join(estado, CURSOR_NAME), res.cursor + '\n'); } catch (_) { /* sin cursor: empieza de nuevo */ }
    const branches = countBranches(repos, home);
    const { cursor: _c, ...guardar } = res;
    const kept = guardar.kept.map(({ name, why }) => ({ name, why }));
    // lo que borró una pasada anterior que ningún arranque mostró no se pierde: se suma
    const antes = readJson(path.join(estado, RESULT_NAME));
    if (antes && antes.shown === false) {
      const juntar = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...b])];
      guardar.removed = juntar(antes.removed, guardar.removed);
      guardar.branchKept = juntar(antes.branchKept, guardar.branchKept);
    }
    writeAtomic(path.join(estado, RESULT_NAME), { at: new Date().toISOString(), ...guardar, kept, branches: branches || (antes && antes.shown === false ? antes.branches || null : null), shown: false });
    try { fs.writeFileSync(path.join(estado, STAMP_NAME), new Date().toISOString() + '\n'); } catch (_) { /* nada */ }
    return res;
  } finally { releaseLock(lock); }
}

function storyLines(res, story, dryRun) {
  const lines = [];
  if (!res.checked && !res.unreadable.length) return [`carpetas de trabajo de la story ${story}: ninguna`];
  for (const n of res.removed) lines.push(`${dryRun ? 'borraría' : 'borrada'}: ${n}`);
  for (const k of res.kept) lines.push(`no la toqué: ${k.name} — ${k.why}`);
  for (const b of res.branchKept) lines.push(`la rama ${b} quedó (git branch -d no la soltó)`);
  for (const u of res.unreadable) lines.push(`sin revisar: ${u}`);
  return lines;
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

function main() {
  if (process.env.TYCON_WORKTREE_SWEEP === '0' || process.env.TYCON_EVAL_SANDBOX === '1') return 0;
  const story = arg('--story');
  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  const cwd = process.cwd();
  if (story) {
    const res = sweep({ repos: knownRepos(cwd), cwd, story, dryRun, fetch: true });
    if (json) process.stdout.write(JSON.stringify({ story, dryRun, ...res }, null, 2) + '\n');
    else process.stdout.write(storyLines(res, story, dryRun).join('\n') + '\n');
    return 0;
  }
  const home = os.homedir();
  const maxArg = Number(arg('--max'));
  const max = Number.isInteger(maxArg) && maxArg > 0 ? maxArg : 0;
  // la pasada de fondo que lanza el arranque (con --dry-run, la prueba sin borrar de abajo)
  if (process.argv.includes('--pass') && !dryRun) { pass({ home, cwd, max }); return 0; }
  // la pasada de todas, ahora, diciendo qué hizo (y la prueba sin borrar)
  if (process.argv.includes('--force') || dryRun) {
    const lock = path.join(stateDirOf(home), LOCK_NAME);
    const got = dryRun ? 'taken' : takeLock(lock);
    if (got === 'busy') { process.stdout.write('carpetas de trabajo: otra pasada está corriendo en esta máquina; probá de nuevo cuando termine\n'); return 0; }
    try {
      const res = sweep({ repos: knownRepos(cwd), cwd, idleMs: idleHours() * 60 * 60 * 1000, dryRun, home });
      const line = startupLine(res, dryRun);
      if (json) process.stdout.write(JSON.stringify({ dryRun, ...res }, null, 2) + '\n');
      else if (line) process.stdout.write(line + '\n');
    } finally { if (!dryRun) releaseLock(lock); }
    return 0;
  }
  // el hook: lo que dejó la pasada anterior, y la de esta sesión de fondo, sin esperarla
  for (const line of takeNotice(home)) process.stdout.write(line + '\n');
  launch(max);
  return 0;
}

if (require.main === module) {
  try { main(); } catch (_) { /* un hook de arranque nunca frena una sesión */ }
  process.exit(0);
}

module.exports = { sweep, knownRepos, listWorktrees, branchNamesStory, startupLine };
