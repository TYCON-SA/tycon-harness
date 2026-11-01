'use strict';
// work-slots.test.js — the fixed work slots of a repo: as many as the session cap, locked, taken by one job at a time
// and left clean on main when it ends; and the list of slots Claude Code still has to trust. Every case builds its own
// HOME, profile and toy repo with its origin: nothing here reads the real HOME.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SLOTS = path.join(ROOT, 'scripts', 'tools', 'work-slots.js');
const S = require(SLOTS);

// Pinned dates and no background maintenance: the toy commits are the same on every run.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function g(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A toy machine: HOME, a profile with the cap, and a repo cloned from its own origin, with one commit on main.
function toy({ cap = 2 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slots-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(cap == null ? {} : { coordination: { max_working: cap } }));
  // the command line reads the profile of the harness it lives in: the cap also goes in this machine's layer
  if (cap != null) fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ coordination: { max_working: cap } }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '--bare', origin);
  const repo = path.join(root, 'src', 'proyecto');
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  g(root, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  g(repo, 'add', 'a.txt');
  g(repo, 'commit', '-q', '-m', 'uno');
  g(repo, 'push', '-q', 'origin', 'HEAD:main');
  const opts = { home, arnes, env: {}, repo };
  return { root, home, arnes, repo, origin, opts };
}
const slot = (t, n) => path.join(path.dirname(t.repo), `proyecto--slot-${n}`);
const branchOf = (dir) => spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const lockedPaths = (t) => g(t.repo, 'worktree', 'list', '--porcelain').split('\n\n')
  .filter((b) => /^locked/m.test(b)).map((b) => fs.realpathSync(b.match(/^worktree (.+)$/m)[1]));
const run = (t, ...args) => spawnSync(process.execPath, [SLOTS, ...args], { cwd: t.repo, encoding: 'utf8', env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_HARNESS_DIR: t.arnes } });

test('S1 Ensure_CreatesAsManyAsTheCap_LockedAndOnMain: crea tantos puestos como el tope, bloqueados y sobre main sin rama', () => {
  const t = toy({ cap: 2 });
  const r = S.ensure(t.opts);
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(r.slots.map((s) => s.path), [slot(t, 1), slot(t, 2)]);
  const main = g(t.repo, 'rev-parse', 'origin/main');
  for (const n of [1, 2]) {
    assert.strictEqual(g(slot(t, n), 'rev-parse', 'HEAD'), main, `el puesto ${n} está sobre main`);
    assert.strictEqual(branchOf(slot(t, n)), '', `el puesto ${n} no tiene rama`);
  }
  assert.deepStrictEqual(lockedPaths(t).sort(), [slot(t, 1), slot(t, 2)], 'bloqueados: el barrido de worktrees no los borra');
  assert.ok(S.list(t.opts).slots.every((s) => s.free), 'recién creados, están libres');
});

test('S2 Ensure_CapRises_CreatesTheMissing_NeverRemoves: si el tope sube crea los que faltan; si baja no borra ninguno y lo dice', () => {
  const t = toy({ cap: 2 });
  S.ensure(t.opts);
  const up = S.ensure({ ...t.opts, count: 3 });
  assert.strictEqual(up.slots.length, 3);
  assert.match(up.message, /cre[eé] 1/i);
  const down = S.ensure({ ...t.opts, count: 1 });
  assert.strictEqual(down.ok, true);
  assert.strictEqual(down.slots.length, 3, 'no borra puestos');
  assert.match(down.message, /tope es 1/);
  assert.ok(fs.existsSync(slot(t, 3)));
});

test('S3 Ensure_CapFromTheConfig: sin cantidad, la saca de coordination.max_working; sin valor, 3', () => {
  assert.strictEqual(S.ensure(toy({ cap: 4 }).opts).slots.length, 4);
  assert.strictEqual(S.ensure(toy({ cap: null }).opts).slots.length, 3);
});

test('S4 Take_FreeSlot_SwitchesToTheJobBranch: toma el primer puesto libre y cambia ahí a la rama; sin libres no toma ninguno', () => {
  const t = toy({ cap: 2 });
  const a = S.take({ ...t.opts, branch: 'feat/a' });
  assert.strictEqual(a.ok, true, a.message);
  assert.strictEqual(a.path, slot(t, 1));
  assert.strictEqual(a.created, true);
  assert.strictEqual(branchOf(slot(t, 1)), 'feat/a');
  const b = S.take({ ...t.opts, branch: 'feat/b' });
  assert.strictEqual(b.path, slot(t, 2));
  const c = S.take({ ...t.opts, branch: 'feat/c' });
  assert.strictEqual(c.ok, false);
  assert.match(c.message, /no hay puesto libre/);
  assert.match(c.message, /2 de 2/);
  assert.strictEqual(g(t.repo, 'branch', '--list', 'feat/c'), '', 'no creó la rama');
});

test('S5 Take_ExistingBranch_ChecksItOut: una rama que ya existe se usa tal cual, sin crearla', () => {
  const t = toy({ cap: 1 });
  g(t.repo, 'branch', 'feat/ya');
  const r = S.take({ ...t.opts, branch: 'feat/ya' });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.created, false);
  assert.strictEqual(branchOf(r.path), 'feat/ya');
});

test('S6 Take_BadBranch_Refuses: una rama inválida o tomada en otra carpeta no deja el puesto a medias', () => {
  const t = toy({ cap: 2 });
  for (const bad of ['-x', 'a b', '']) {
    const r = S.take({ ...t.opts, branch: bad });
    assert.strictEqual(r.ok, false, `«${bad}»`);
  }
  g(t.repo, 'switch', '-q', '-c', 'feat/aca');
  const r = S.take({ ...t.opts, branch: 'feat/aca' });
  assert.strictEqual(r.ok, false);
  assert.ok(S.list(t.opts).slots.every((s) => s.free), 'los puestos siguen libres');
});

test('S7 Release_LeavesItCleanOnMain_AndFree: al terminar vuelve a main sin rama, la rama queda; con cambios sin commitear no lo suelta', () => {
  const t = toy({ cap: 1 });
  const a = S.take({ ...t.opts, branch: 'feat/a' });
  fs.writeFileSync(path.join(a.path, 'b.txt'), 'dos\n');
  const dirty = S.release({ ...t.opts, slot: a.path });
  assert.strictEqual(dirty.ok, false);
  assert.match(dirty.message, /sin commitear/);
  g(a.path, 'add', 'b.txt');
  g(a.path, 'commit', '-q', '-m', 'dos');
  const r = S.release({ ...t.opts, slot: a.path });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(branchOf(a.path), '');
  assert.strictEqual(g(a.path, 'rev-parse', 'HEAD'), g(t.repo, 'rev-parse', 'origin/main'));
  assert.strictEqual(S.list(t.opts).slots[0].free, true);
  assert.notStrictEqual(g(t.repo, 'branch', '--list', 'feat/a'), '', 'la rama del trabajo queda');
});

test('S8 Release_NotASlot_Refuses: una carpeta que no es un puesto no se toca', () => {
  const t = toy({ cap: 1 });
  const r = S.release({ ...t.opts, slot: t.repo });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /no es un puesto/);
});

test('S9 PendingTrust_ListsTheUntrusted_WithTheirCd: lista los puestos que Claude Code no tiene aprobados, cada uno con su cd', () => {
  const t = toy({ cap: 3 });
  S.ensure(t.opts);
  fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ oauthAccount: { secreto: 'no-se-imprime' }, projects: { [slot(t, 2)]: { hasTrustDialogAccepted: true } } }));
  const r = S.pendingTrust(t.opts);
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(r.pending, [slot(t, 1), slot(t, 3)]);
  const cli = run(t, 'pending-trust');
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes(`cd "${slot(t, 1)}" && claude`), cli.stdout);
  assert.ok(!cli.stdout.includes(slot(t, 2)), 'el aprobado no se lista');
  assert.doesNotMatch(cli.stdout, /no-se-imprime/);
});

test('S10 PendingTrust_AllTrusted_OrUnreadable: todos aprobados lo dice; una configuración que no se lee es «no sé», no «todos aprobados»', () => {
  const t = toy({ cap: 1 });
  S.ensure(t.opts);
  fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ projects: { [slot(t, 1)]: { hasTrustDialogAccepted: true } } }));
  const all = S.pendingTrust(t.opts);
  assert.deepStrictEqual(all.pending, []);
  assert.match(all.message, /aprobados/);
  fs.writeFileSync(path.join(t.home, '.claude.json'), '{roto');
  const bad = S.pendingTrust(t.opts);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.message, /no pude leer/i);
});

test('S11 PendingTrust_AllKnownRepos: sin repo, lista los puestos de todos los repos que ya los tienen', () => {
  const t = toy({ cap: 1 });
  const u = toy({ cap: 1 });
  S.ensure(t.opts);
  S.ensure({ ...u.opts, home: t.home });
  const r = S.pendingTrust({ home: t.home, arnes: t.arnes, env: {} });
  assert.deepStrictEqual([...r.pending].sort(), [slot(t, 1), slot(u, 1)].sort());
});

test('S12 AgentSkills_Refused: el clon de las skills no lleva puestos (su freno mira la ruta literal)', () => {
  const t = toy({ cap: 1 });
  const skills = path.join(t.root, 'home', '.claude', 'agent-skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  g(t.root, 'clone', '-q', t.origin, skills);
  const r = S.ensure({ ...t.opts, repo: skills });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /agent-skills/);
});

test('S13 Cli_TakeListRelease: la línea de comandos toma, lista con su cd y suelta', () => {
  const t = toy({ cap: 1 });
  const take = run(t, 'take', '--branch', 'feat/cli');
  assert.strictEqual(take.status, 0, take.stderr + take.stdout);
  assert.ok(take.stdout.includes(`cd "${slot(t, 1)}"`), take.stdout);
  const list = run(t, 'list');
  assert.match(list.stdout, /feat\/cli/);
  const rel = spawnSync(process.execPath, [SLOTS, 'release'], { cwd: slot(t, 1), encoding: 'utf8', env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_HARNESS_DIR: t.arnes } });
  assert.strictEqual(rel.status, 0, rel.stderr + rel.stdout);
  assert.strictEqual(run(t, 'take', '--branch', '-mal').status, 1);
});

test('S14 TyconWorktree_SlotDelegates: tycon-worktree.sh slot es un atajo al mismo guion', { skip: process.platform === 'win32' }, () => {
  const t = toy({ cap: 1 });
  const sh = path.join(ROOT, 'scripts', 'tools', 'tycon-worktree.sh');
  const r = spawnSync('bash', [sh, 'slot', 'ensure'], { cwd: t.repo, encoding: 'utf8', env: { ...process.env, HOME: t.home, TYCON_HARNESS_DIR: t.arnes } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(slot(t, 1)), r.stdout);
});
