#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * work-slots.js — los puestos de trabajo fijos de un repo (guides/git-worktrees.md §«Puestos fijos»).
 *
 * POR QUÉ. Claude Code pide aprobar cada carpeta nueva antes de abrir una sesión ahí. Con un worktree nuevo por
 * trabajo, cada sesión de fondo esperaba al dueño. Los puestos son siempre las mismas carpetas: se aprueban una vez y
 * cada trabajo toma uno libre y cambia ahí de rama.
 *
 * QUÉ ES UN PUESTO. Un worktree hermano del checkout principal, `<repo>--slot-<n>`, con n de 1 al tope de sesiones de
 * la organización (`coordination.max_working`, el mismo que usa la coordinadora; 3 sin valor). Está bloqueado con
 * `git worktree lock`, así el barrido de worktrees no lo borra. Está LIBRE si está sin rama (sobre main) y sin cambios
 * sin commitear; un puesto con rama, o con cambios, lo está usando un trabajo.
 *
 *   ensure [--repo <r>]                         crea los puestos que falten hasta el tope; nunca borra uno
 *   list [--repo <r>] [--json]                  los puestos, libres u ocupados, cada uno con su cd
 *   take --branch <b> [--from <ref>] [--repo <r>]
 *                                               toma el primer puesto libre y cambia ahí a la rama (la crea desde
 *                                               origin/main si no existe); imprime su cd
 *   release [<puesto>]                          lo deja sobre main sin rama y libre; la rama queda. Con cambios sin
 *                                               commitear no lo suelta
 *   pending-trust [--repo <r>]                  los puestos que Claude Code todavía no tiene aprobados, cada uno con
 *                                               el cd para aprobarlo; sin repo, los de todos los repos con puestos
 *
 * El repo por defecto es el de la carpeta actual. Los repos con puestos quedan anotados en
 * `<estado>/coordination/slots.json`, para que `pending-trust` los encuentre. La aprobación se mira en la
 * configuración de Claude Code (`~/.claude.json`, o la de `CLAUDE_CONFIG_DIR`), por la ruta exacta del puesto; de ese
 * archivo no se imprime nada más que rutas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const tyconConfig = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));

const TAG = '--slot-';
const BASE = 'origin/main';
const LOCK_REASON = 'puesto fijo de trabajo (work-slots.js)';
// Un candado más viejo que esto lo dejó un proceso que murió: se toma igual.
const STALE_LOCK_MS = 2 * 60000;
const DEFAULT_CAP = 3;

const no = (message) => ({ ok: false, message });

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = String((r.error && r.error.message) || r.stderr || r.stdout || '').trim().split('\n')[0];
    return { problem: `git ${args[0]}: ${why || `salió con código ${r.status}`}` };
  }
  return { out: r.stdout.trim() };
}

/** El checkout principal del repo de `dir` (los puestos son sus hermanos): `{ main, common }` o `{ problem }`. */
function mainCheckout(dir, home) {
  if (!dir || !fs.existsSync(dir)) return { problem: `la carpeta ${dir} no existe` };
  const c = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (c.problem) return { problem: `${dir} no es un repo de git (${c.problem})` };
  const common = c.out;
  if (path.basename(common) !== '.git') return { problem: `${dir} es un repo sin carpeta de trabajo: no lleva puestos` };
  const main = fs.realpathSync(path.dirname(common));
  // el freno de staging del clon de las skills mira su ruta literal: un puesto en otra ruta lo esquivaría
  if (isSkillsClone(main, home)) return { problem: `${main} es el clon de agent-skills: no lleva puestos` };
  return { main, common };
}

// la ruta del clon de las skills la sabe tycon-home.js; se carga al usarla, no al cargar este archivo
function isSkillsClone(main, home) {
  try {
    return fs.realpathSync(require('../setup/harness/tycon-home.js').installedSkillsDir(home || os.homedir())) === main;
  } catch { return false; }
}

const slotPath = (main, n) => path.join(path.dirname(main), `${path.basename(main)}${TAG}${n}`);

function cap(opts) {
  if (opts.count != null) return Number(opts.count);
  try {
    const cfg = tyconConfig.cargar({ home: opts.home, env: opts.env || process.env, ...(opts.arnes ? { arnes: opts.arnes } : {}) });
    const v = tyconConfig.coordinacion(cfg).max_working;
    return v && Number.isInteger(v.value) && v.value > 0 ? v.value : DEFAULT_CAP;
  } catch { return DEFAULT_CAP; }
}

const registryFile = (home) => path.join(stateDir(home || os.homedir()), 'coordination', 'slots.json');
function readRegistry(home) {
  try {
    const d = JSON.parse(fs.readFileSync(registryFile(home), 'utf8'));
    return Array.isArray(d.repos) ? d.repos.filter((r) => typeof r === 'string') : [];
  } catch { return []; }
}
function remember(home, main) {
  const repos = readRegistry(home);
  if (repos.includes(main)) return;
  const file = registryFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ repos: [...repos, main].sort() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Los puestos que hay del repo, en orden: `[{ n, path, branch, dirty, free }]`. */
function present(main) {
  const out = git(main, ['worktree', 'list', '--porcelain']);
  if (out.problem) return out;
  const prefix = `${path.basename(main)}${TAG}`;
  const slots = [];
  for (const block of out.out.split(/\n\n+/)) {
    const m = block.match(/^worktree (.+)$/m);
    if (!m) continue;
    // la ruta real: git y la carpeta del repo pueden escribir la misma con otro enlace adelante
    const p = fs.existsSync(m[1]) ? fs.realpathSync(m[1]) : path.resolve(m[1]);
    const name = path.basename(p);
    if (path.dirname(p) !== path.dirname(main) || !name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const n = Number(name.slice(prefix.length));
    const b = block.match(/^branch refs\/heads\/(.+)$/m);
    const st = fs.existsSync(p) ? git(p, ['status', '--porcelain']) : { problem: 'la carpeta no está' };
    const dirty = st.problem ? null : st.out !== '';
    slots.push({ n, path: p, branch: b ? b[1] : null, dirty, locked: /^locked/m.test(block), free: !b && dirty === false });
  }
  return { slots: slots.sort((a, c) => a.n - c.n) };
}

/** Crea los puestos que falten hasta el tope. Nunca borra uno: si el tope bajó, lo dice. */
function ensure(opts = {}) {
  const home = opts.home || os.homedir();
  const r = mainCheckout(opts.repo || process.cwd(), home);
  if (r.problem) return no(`No hay puestos: ${r.problem}.`);
  const want = cap(opts);
  if (!Number.isInteger(want) || want < 1) return no(`El tope de puestos tiene que ser un entero desde 1 (vino ${opts.count}).`);
  let p = present(r.main);
  if (p.problem) return no(`No pude listar los worktrees de ${r.main} (${p.problem}).`);
  const have = new Set(p.slots.map((s) => s.n));
  const missing = [];
  for (let n = 1; n <= want; n += 1) if (!have.has(n)) missing.push(n);
  if (missing.length) {
    // sin red, el puesto nace sobre el origin/main que ya había: lo pone al día el primer trabajo que lo toma
    git(r.main, ['fetch', '-q', 'origin', 'main']);
    const base = git(r.main, ['rev-parse', '--verify', '-q', BASE]).problem ? 'HEAD' : BASE;
    for (const n of missing) {
      const dir = slotPath(r.main, n);
      if (fs.existsSync(dir)) return no(`${dir} ya existe y no es un puesto de ${r.main}: no lo toco. Movelo o borralo y volvé a correr.`);
      const add = git(r.main, ['worktree', 'add', '-q', '--detach', dir, base]);
      if (add.problem) return no(`No pude crear el puesto ${dir} (${add.problem}).`);
      const lock = git(r.main, ['worktree', 'lock', '--reason', LOCK_REASON, dir]);
      if (lock.problem) return no(`Creé ${dir} pero no lo pude bloquear (${lock.problem}): el barrido de worktrees lo podría borrar.`);
    }
  }
  for (const s of p.slots) if (!s.locked) git(r.main, ['worktree', 'lock', '--reason', LOCK_REASON, s.path]);
  try { remember(home, r.main); } catch { /* la lista es para pending-trust; sin ella el puesto igual sirve */ }
  p = present(r.main);
  if (p.problem) return no(`No pude listar los worktrees de ${r.main} (${p.problem}).`);
  const parts = [missing.length ? `Creé ${missing.length} puesto(s)` : 'No faltaba ninguno', `${r.main} tiene ${p.slots.length}`];
  if (p.slots.length > want) parts.push(`el tope es ${want}: los de más no los borro`);
  return { ok: true, main: r.main, cap: want, slots: p.slots, message: `${parts.join('; ')}.` };
}

function list(opts = {}) {
  const r = mainCheckout(opts.repo || process.cwd(), opts.home);
  if (r.problem) return no(`No hay puestos: ${r.problem}.`);
  const p = present(r.main);
  if (p.problem) return no(`No pude listar los worktrees de ${r.main} (${p.problem}).`);
  return { ok: true, main: r.main, cap: cap(opts), slots: p.slots };
}

// Un candado por repo, para que dos sesiones no tomen el mismo puesto a la vez.
function withLock(common, fn) {
  const lock = path.join(common, 'tycon-slots.lock');
  for (let i = 0; i < 2; i += 1) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') return no(`No pude tomar el candado de los puestos (${e.code}).`);
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* se soltó recién */ }
      if (i === 0 && age > STALE_LOCK_MS) { try { fs.rmdirSync(lock); } catch { /* otro lo soltó */ } continue; }
      return no('Otra sesión está tomando un puesto de este repo en este momento: probá de nuevo en unos segundos.');
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya no está */ } }
}

/** Toma el primer puesto libre y cambia ahí a la rama. `{ ok, path, n, branch, created }` o `{ ok: false, message }`. */
function take(opts = {}) {
  const branch = String(opts.branch || '');
  if (!branch || branch.startsWith('-') || git(opts.repo || process.cwd(), ['check-ref-format', '--branch', branch]).problem) {
    return no(`«${branch}» no es un nombre de rama válido: no tomé ningún puesto.`);
  }
  const e = ensure(opts);
  if (!e.ok) return e;
  const r = mainCheckout(e.main, opts.home);
  return withLock(r.common, () => {
    const p = present(r.main);
    if (p.problem) return no(`No pude listar los worktrees de ${r.main} (${p.problem}).`);
    const s = p.slots.find((x) => x.free);
    if (!s) return no(`En ${r.main} no hay puesto libre (${p.slots.length - p.slots.filter((x) => x.free).length} de ${p.slots.length} ocupados): no tomé ninguno.`);
    const exists = !git(r.main, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).problem;
    if (!exists) git(r.main, ['fetch', '-q', 'origin', 'main']);
    const from = opts.from || (git(r.main, ['rev-parse', '--verify', '-q', BASE]).problem ? 'HEAD' : BASE);
    const sw = exists ? git(s.path, ['switch', '-q', branch]) : git(s.path, ['switch', '-q', '--no-track', '-c', branch, from]);
    if (sw.problem) return no(`No pude cambiar el puesto ${s.path} a la rama ${branch} (${sw.problem}): sigue libre.`);
    return { ok: true, path: s.path, n: s.n, branch, created: !exists, message: `Tomé el puesto ${s.n} de ${r.main}, en la rama ${branch}.` };
  });
}

/** Deja el puesto sobre main, sin rama y libre. La rama queda. Con cambios sin commitear no lo suelta. */
function release(opts = {}) {
  const dir = path.resolve(opts.slot || process.cwd());
  const r = mainCheckout(dir, opts.home);
  if (r.problem) return no(`No solté nada: ${r.problem}.`);
  const p = present(r.main);
  if (p.problem) return no(`No pude listar los worktrees de ${r.main} (${p.problem}).`);
  const real = fs.realpathSync(dir);
  const s = p.slots.find((x) => fs.realpathSync(x.path) === real);
  if (!s) return no(`${dir} no es un puesto de ${r.main}: no lo toco.`);
  if (s.dirty !== false) return no(`El puesto ${s.path} tiene cambios sin commitear: commitealos o descartalos y volvé a soltarlo.`);
  git(s.path, ['fetch', '-q', 'origin', 'main']);
  const base = git(s.path, ['rev-parse', '--verify', '-q', BASE]).problem ? null : BASE;
  if (!base) return no(`El puesto ${s.path} no tiene ${BASE}: no sé dónde dejarlo.`);
  const sw = git(s.path, ['switch', '-q', '--detach', base]);
  if (sw.problem) return no(`No pude dejar el puesto ${s.path} sobre main (${sw.problem}).`);
  return { ok: true, path: s.path, branch: s.branch, message: `Solté el puesto ${s.n}: quedó sobre main y libre${s.branch ? `; la rama ${s.branch} queda` : ''}.` };
}

const claudeConfigFile = (home, env) => (env && env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'));

/** Los puestos que Claude Code todavía no tiene aprobados. `{ ok, pending: [rutas] }` o `{ ok: false, message }`. */
function pendingTrust(opts = {}) {
  const home = opts.home || os.homedir();
  const repos = opts.repo ? [opts.repo] : readRegistry(home);
  const file = claudeConfigFile(home, opts.env || process.env);
  let projects = {};
  try {
    projects = (JSON.parse(fs.readFileSync(file, 'utf8')) || {}).projects || {};
  } catch (e) {
    if (e.code !== 'ENOENT') return no(`No pude leer ${file} (${e.code || 'no es JSON'}): no sé qué puestos están aprobados.`);
  }
  const trusted = (p) => Boolean(projects[p] && projects[p].hasTrustDialogAccepted);
  const pending = [];
  for (const repo of repos) {
    const l = list({ ...opts, repo });
    if (!l.ok) return no(l.message);
    for (const s of l.slots) if (!trusted(s.path)) pending.push(s.path);
  }
  const message = pending.length
    ? `${pending.length} puesto(s) sin aprobar en Claude Code. Para cada uno, abrí Claude ahí una vez y aceptá:`
    : (repos.length ? 'Los puestos están todos aprobados en Claude Code.' : 'Todavía no hay puestos en ningún repo.');
  return { ok: true, pending, message };
}

// ── La línea de comandos ──

const cdLine = (p) => `cd "${p}"`;

function flags(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (/^--[a-z-]+$/.test(a)) {
      const v = argv[++i];
      if (v === undefined || v === '') throw new Error(`${a} pide un valor`);
      out[a.slice(2)] = v;
    } else out.rest.push(a);
  }
  return out;
}

function main(argv) {
  const [cmd, ...more] = argv;
  let f;
  try { f = flags(more); } catch (e) { process.stderr.write(`work-slots.js: ${e.message}\n`); return 2; }
  const base = { env: process.env, ...(f.repo ? { repo: path.resolve(f.repo) } : {}) };
  const say = (r, extra = []) => { process.stdout.write(`${[r.message, ...extra].filter(Boolean).join('\n')}\n`); return r.ok ? 0 : 1; };
  if (cmd === 'ensure') {
    const r = ensure(base);
    return say(r, r.ok ? r.slots.map((s) => `  ${s.n}  ${cdLine(s.path)}`) : []);
  }
  if (cmd === 'list') {
    const r = list(base);
    if (r.ok && f.json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return 0; }
    if (!r.ok) return say(r);
    const rows = r.slots.map((s) => `  ${s.n}  ${s.free ? 'libre  ' : 'ocupado'}  ${s.branch || (s.dirty ? 'sin rama, con cambios' : 'sobre main')}  ${cdLine(s.path)}`);
    return say({ ok: true, message: r.slots.length ? `Puestos de ${r.main} (tope ${r.cap}):` : `${r.main} todavía no tiene puestos: los crea «ensure» o el primer «take».` }, rows);
  }
  if (cmd === 'take') {
    const r = take({ ...base, branch: f.branch, from: f.from });
    return say(r, r.ok ? [cdLine(r.path)] : []);
  }
  if (cmd === 'release') return say(release({ ...base, slot: f.rest[0] }));
  if (cmd === 'pending-trust') {
    const r = pendingTrust(base);
    return say(r, r.ok ? r.pending.map((p) => `  ${cdLine(p)} && claude`) : []);
  }
  process.stderr.write('uso: work-slots.js ensure | list [--json] | take --branch <rama> [--from <ref>] | release [<puesto>] | pending-trust   (todos aceptan --repo <repo>)\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { ensure, list, take, release, pendingTrust, slotPath };
