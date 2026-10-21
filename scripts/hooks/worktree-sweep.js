#!/usr/bin/env node
'use strict';
/**
 * worktree-sweep.js — las carpetas de trabajo (worktrees de git) que ya se mergearon se borran solas.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * Cada story y cada arreglo abre una carpeta `<repo>-wt-*` al lado de los repos, y nadie la cierra al mergear. Ocupan disco (cada una trae su
 * `node_modules`), confunden a quien busca dónde está el trabajo vivo, y una rama vieja checkeada en una carpeta olvidada no se deja borrar.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Dos caminos, el mismo criterio:
 *   · Al arrancar sesión (SessionStart), como mucho una vez por día: recorre los repos conocidos —los de la raíz de
 *     repos de la máquina (`scripts/lib/repos-root.js`) hasta dos niveles, y el del cwd— y en cada uno sus carpetas de
 *     trabajo. Borra (`git worktree remove` + `git branch -d`) las que están LIMPIAS y con su HEAD ya en origin/main.
 *     Las que tienen cambios o commits sin mergear sólo las nombra, en una línea. Silencio si no hay nada.
 *   · Al cerrar una story (`/tycon-pipeline close`, paso 9): `--story <N.M>` limita a las carpetas cuya rama nombra
 *     la story, trae origin primero (`git fetch`) y dice qué hizo con cada una.
 *
 * ── LO QUE NUNCA TOCA ────────────────────────────────────────────────────────────────────────────────────────────
 *   · el checkout principal de un repo (el primero de `git worktree list`);
 *   · una carpeta con cambios: archivos modificados, en el índice o sin seguimiento (`git status --porcelain`). Además
 *     el borrado va sin `--force`: si git ve algo, se niega él también;
 *   · una carpeta con commits que no están en origin/main (o en la rama por defecto de origin);
 *   · una carpeta bloqueada (`git worktree lock`), una que ya no existe en disco, o la que contiene el cwd de esta sesión;
 *   · al arrancar, además: una carpeta usada en las últimas horas (puede ser de otra sesión viva que acaba de mergear y
 *     sigue ahí) y una recién creada sin trabajo propio (su HEAD es justo la punta de origin/main).
 * Al arrancar no se hace `git fetch`: con los refs de origin viejos se borra de menos, nunca de más.
 *
 * Mac, Linux y Windows: sólo Node y git, sin shell.
 *
 * Apagar: TYCON_WORKTREE_SWEEP=0 (los dos caminos). Horas de uso que protegen una carpeta al arrancar:
 * TYCON_WORKTREE_SWEEP_IDLE_HOURS (4). Forzar la pasada de hoy: --force. Probar sin borrar: --dry-run.
 * Fail-open: un hook de arranque nunca frena ni tira.
 *
 * Uso:
 *   node scripts/hooks/worktree-sweep.js                         ← el hook de arranque
 *   node scripts/hooks/worktree-sweep.js --story <N.M> [--dry-run] [--json]
 *   node scripts/hooks/worktree-sweep.js --force [--dry-run]     ← la pasada de arranque, ahora
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

const STAMP_NAME = 'worktree-sweep-last-run';
const EVERY_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 15000;
const MAX_NAMES = 5;
const WIN = process.platform === 'win32';

function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function norm(p) { const r = path.resolve(p); return WIN ? r.toLowerCase() : r; }
function inside(child, parent) { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p + path.sep); }

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
  const alt = story.replace(/\./g, '[.-]');
  return new RegExp(`(^|[^0-9.])${alt}($|[^0-9])`).test(branch);
}

/**
 * Evalúa (y, si no es `dryRun`, borra) las carpetas de trabajo de los repos dados.
 * Devuelve { removed: [...], kept: [{ name, why }], branchKept: [...], checked, unreadable: [...] }.
 */
function sweep({ repos, cwd, story = null, idleMs = 0, now = Date.now(), dryRun = false, fetch = false }) {
  const res = { removed: [], kept: [], branchKept: [], checked: 0, unreadable: [] };
  for (const repo of repos) {
    const list = listWorktrees(repo);
    if (!list) { res.unreadable.push(path.basename(repo)); continue; }
    let linked = list.slice(1).filter((w) => !w.prunable && fs.existsSync(w.path));
    if (story) linked = linked.filter((w) => branchNamesStory(w.branch, story));
    if (!linked.length) continue;
    if (fetch) git(repo, ['fetch', '--quiet', 'origin'], 60000);
    const target = targetRef(repo);
    if (!target) { res.unreadable.push(`${path.basename(repo)} (sin origin/main)`); continue; }
    for (const w of linked) {
      res.checked++;
      const name = path.basename(w.path);
      if (cwd && inside(cwd, w.path)) { res.kept.push({ name, why: 'es la carpeta de esta sesión' }); continue; }
      if (w.locked) { if (story) res.kept.push({ name, why: 'está bloqueada (git worktree lock)' }); continue; }
      // al arrancar, una carpeta en uso o recién creada se deja en silencio: puede ser de otra sesión viva
      if (!story && idleMs > 0 && now - lastUsedMs(w.path) < idleMs) continue;
      const st = git(w.path, ['status', '--porcelain']);
      if (!st.ok) { res.kept.push({ name, why: 'no pude leer su estado' }); continue; }
      if (st.out) { res.kept.push({ name, why: 'tiene cambios' }); continue; }
      const head = git(w.path, ['rev-parse', 'HEAD']).out;
      if (!head) { res.kept.push({ name, why: 'no pude leer su HEAD' }); continue; }
      const merged = git(repo, ['merge-base', '--is-ancestor', head, target.sha]).ok;
      if (!merged) { res.kept.push({ name, why: `commits sin mergear a ${target.name}` }); continue; }
      if (!story && head === target.sha) continue;
      if (dryRun) { res.removed.push(name); continue; }
      const rm = git(repo, ['worktree', 'remove', w.path]);
      if (!rm.ok) { res.kept.push({ name, why: `git no la quiso borrar (${rm.err.split('\n')[0] || 'sin motivo'})` }); continue; }
      res.removed.push(name);
      if (w.branch) {
        const b = git(repo, ['branch', '-d', w.branch]);
        if (!b.ok) res.branchKept.push(w.branch);
      }
    }
  }
  return res;
}

function names(list) {
  const shown = list.slice(0, MAX_NAMES).join(', ');
  return list.length > MAX_NAMES ? `${shown} y ${list.length - MAX_NAMES} más` : shown;
}

/** La línea del arranque; null si no hay nada que decir. */
function startupLine(res, dryRun) {
  const parts = [];
  if (res.removed.length) parts.push(`${dryRun ? 'borraría' : 'borré'} ${res.removed.length} ya mergeada(s) (${names(res.removed)})`);
  if (res.kept.length) parts.push(`no toqué ${res.kept.length} con trabajo: ${names(res.kept.map((k) => `${k.name} (${k.why})`))}`);
  if (res.branchKept.length) parts.push(`la rama quedó en ${names(res.branchKept)} (git branch -d no la soltó)`);
  if (res.unreadable.length) parts.push(`sin revisar: ${names(res.unreadable)}`);
  return parts.length ? `carpetas de trabajo: ${parts.join(' · ')}. Apagar: TYCON_WORKTREE_SWEEP=0` : null;
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
  // el hook: una vez por día, salvo --force
  const stamp = path.join(stateDirOf(os.homedir()), STAMP_NAME);
  if (!process.argv.includes('--force')) {
    try { if (Date.now() - fs.statSync(stamp).mtimeMs < EVERY_MS) return 0; } catch (_) { /* sin sello: toca hoy */ }
  }
  const hours = Number(process.env.TYCON_WORKTREE_SWEEP_IDLE_HOURS);
  const idleMs = (Number.isFinite(hours) && hours >= 0 ? hours : 4) * 60 * 60 * 1000;
  const res = sweep({ repos: knownRepos(cwd), cwd, idleMs, dryRun });
  if (!dryRun) {
    try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, new Date().toISOString() + '\n'); } catch (_) { /* sin sello: mañana se repite, no es grave */ }
  }
  const line = startupLine(res, dryRun);
  if (json) process.stdout.write(JSON.stringify({ dryRun, ...res }, null, 2) + '\n');
  else if (line) process.stdout.write(line + '\n');
  return 0;
}

if (require.main === module) {
  try { main(); } catch (_) { /* un hook de arranque nunca frena una sesión */ }
  process.exit(0);
}

module.exports = { sweep, knownRepos, listWorktrees, branchNamesStory, startupLine };
