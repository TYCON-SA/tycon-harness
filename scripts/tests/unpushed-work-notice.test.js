'use strict';
// unpushed-work-notice.test.js — el aviso de trabajo sin subir mira las ramas de un repo con una cantidad fija de git.
//
// El aviso corre al arrancar, después de cada push a main y al cerrar cada turno de una sesión que commiteó. Si pregunta
// rama por rama, un repo con cientos de ramas son cientos de git cada vez: en Windows, cada uno es un proceso caro (y una
// ventana si el gancho corre sin consola). Lo que no se puede perder:
//   · la cantidad de git no crece con las ramas;
//   · el resultado es el mismo que preguntar rama por rama: qué ramas, con qué punta y cuántos commits sin subir;
//   · al cerrar el turno, lo propio y lo ajeno se separan como siempre, sin otro git por rama;
//   · un git que no contesta deja el repo «no escaneado», nunca verde.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'unpushed-work-notice.js');
const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'unpushed-notice-'));
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME, { recursive: true });
const GIT_ENV = {
  PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z',
};

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd, file, text) { fs.writeFileSync(path.join(cwd, file), text); git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', `${file}`]); return git(cwd, ['rev-parse', 'HEAD']); }

/** Un repo solo en su carpeta, clonado de un repo pelado, con `branches` ramas: las pares con un commit sin subir. */
function toyRepo(name, branches, { remote = true } = {}) {
  const parent = path.join(BASE, name);
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(parent, { recursive: true });
  if (remote) {
    const bare = path.join(BASE, 'remotes', `${name}.git`);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(BASE, ['init', '-q', '--bare', bare]);
    git(BASE, ['clone', '-q', bare, repo]);
  } else {
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
  }
  git(repo, ['checkout', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, '.tycon'));
  commit(repo, 'a.txt', 'base');
  if (remote) git(repo, ['push', '-q', 'origin', 'main']);
  for (let i = 1; i <= branches; i++) {
    git(repo, ['checkout', '-q', '-b', `b${i}`, 'main']);
    if (i % 2 === 0) commit(repo, `f${i}.txt`, String(i));
  }
  git(repo, ['checkout', '-q', 'main']);
  return fs.realpathSync(repo);
}

/** Corre el gancho y cuenta los git que lanzó (trace2). */
function runHook(args, { input = '', env = {} } = {}) {
  const trace = path.join(BASE, `trace-${process.hrtime.bigint()}.json`);
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    input, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...GIT_ENV, GIT_TRACE2_EVENT: trace, ...env },
  });
  const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const starts = events.filter((e) => e.event === 'start').map((e) => e.argv.slice(1));
  return { code: r.status, out: r.stdout, err: r.stderr, starts };
}

test('T6 · UnpushedScan_GitCallsDoNotGrowWithBranches @story-8.266 @ac-4 @ac-9', () => {
  const few = runHook(['--scan', toyRepo('few', 5)]);
  const many = runHook(['--scan', toyRepo('many', 60)]);
  assert.strictEqual(few.code, 0, few.err);
  assert.strictEqual(few.starts.length, 6, few.starts.map((a) => a.join(' ')).join('\n'));
  assert.strictEqual(many.starts.length, 6, many.starts.map((a) => a.join(' ')).join('\n'));
  const local = runHook(['--scan', toyRepo('local', 3, { remote: false })]);
  assert.strictEqual(local.starts.length, 4, local.starts.map((a) => a.join(' ')).join('\n'));
  assert.match(local.out, /sin remoto/);
});

test('T7 · UnpushedScan_SameResultAsBranchByBranch @story-8.266 @ac-4 @ac-9', () => {
  const repo = toyRepo('same', 0);
  git(repo, ['checkout', '-q', '-b', 'pushed', 'main']); commit(repo, 'p.txt', 'p'); git(repo, ['push', '-q', 'origin', 'pushed']);
  git(repo, ['checkout', '-q', '-b', 'one', 'main']); commit(repo, 'o.txt', 'o');
  git(repo, ['checkout', '-q', '-b', 'stacked', 'one']); commit(repo, 's1.txt', 's1'); commit(repo, 's2.txt', 's2');
  git(repo, ['checkout', '-q', '-b', 'behind', 'main']); commit(repo, 'x.txt', 'x'); git(repo, ['push', '-q', 'origin', 'behind']);
  git(repo, ['reset', '-q', '--hard', 'main']);
  git(repo, ['checkout', '-q', 'main']);
  const expected = {};
  for (const b of git(repo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']).split('\n')) {
    const n = Number(git(repo, ['rev-list', '--count', b, '--not', '--remotes=origin']));
    if (n) expected[b] = { tip: git(repo, ['rev-parse', '--short', b]), count: n };
  }
  assert.deepStrictEqual(Object.keys(expected).sort(), ['one', 'stacked']);
  const r = runHook(['--scan', repo, '--json']);
  const scanned = JSON.parse(r.out).repos[0];
  const got = {};
  for (const b of scanned.branches) got[b.branch] = { tip: b.tip, count: b.count };
  assert.deepStrictEqual(got, expected);
  assert.deepStrictEqual(Object.keys(scanned.branches[0]).sort(), ['branch', 'count', 'subject', 'tip', 'wip']);
  const plain = JSON.parse(runHook(['--scan', toyRepo('plain', 2, { remote: false }), '--json']).out).repos[0];
  assert.strictEqual(plain.noRemote, true);
});

test('T8 · UnpushedStop_ClassifiesWithoutPerBranchRevList @story-8.266 @ac-5', () => {
  const repo = toyRepo('stop', 0);
  git(repo, ['checkout', '-q', '-b', 'mine', 'main']);
  const own = commit(repo, 'm.txt', 'm');
  git(repo, ['checkout', '-q', '-b', 'theirs', 'main']); commit(repo, 't.txt', 't');
  git(repo, ['checkout', '-q', 'main']);
  const sid = 'stop-session';
  const dir = stateDir(HOME);
  fs.mkdirSync(dir, { recursive: true });
  // stable-data: el registro de commits de la sesión tiene que ser de hoy para que el gancho lo lea al cerrar el turno
  fs.writeFileSync(path.join(dir, `unpushed-commits-${sid}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), repo, kind: 'commit', sha: own })}\n`);
  const r = runHook([], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: false }) });
  const reason = JSON.parse(r.out).reason;
  const [ownPart, foreignPart] = reason.split('\n\n');
  assert.match(ownPart, /esta sesión commiteó/);
  assert.match(ownPart, / mine @/);
  assert.match(foreignPart, /NO hizo/);
  assert.match(foreignPart, / theirs @/);
  const perBranch = r.starts.filter((a) => a.includes('rev-list') && (a.includes('mine') || a.includes('theirs')));
  assert.deepStrictEqual(perBranch, []);
});

test('T9 · UnpushedScan_BigOrSlow_SaysNotScanned @story-8.266 @ac-8', { skip: process.platform === 'win32' && 'el git de juguete es un guion de bash' }, () => {
  const repo = toyRepo('slow', 4);
  const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const bin = path.join(BASE, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // el git de juguete: lento o con más de 1 MB de salida, sólo en el pedido de lo que falta subir
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/bash',
    'if [ -n "$TOY_BROKEN_REMOTE" ] && [ "${3:-}" = "remote" ] && [ $# -eq 3 ]; then echo "fatal: bad config" >&2; exit 128; fi',
    'case " $* " in *" --parents "*)',
    '  if [ -n "$TOY_SLOW" ]; then sleep 15; fi',
    '  if [ -n "$TOY_BROKEN" ]; then echo "fatal: bad object" >&2; exit 128; fi',
    `  "${realGit}" "$@"; s=$?`,
    '  if [ -n "$TOY_BIG" ]; then for i in $(seq 1 30000); do printf "%040d\\n" "$i"; done; fi',
    '  exit $s;;',
    'esac',
    `exec "${realGit}" "$@"`,
  ].join('\n'), { mode: 0o755 });
  const PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const slow = runHook(['--scan', repo], { env: { PATH, TOY_SLOW: '1' } });
  assert.match(slow.out, /NO ESCANEADO \(timeout\)/);
  // un git que sale con error (un objeto roto) tampoco es «nada sin subir»
  const broken = JSON.parse(runHook(['--scan', repo, '--json'], { env: { PATH, TOY_BROKEN: '1' } }).out).repos[0];
  assert.strictEqual(broken.error, 'error git');
  assert.strictEqual(broken.scanned, false);
  // ni un `git remote` que falla: no es «sin remoto»
  const noRemote = JSON.parse(runHook(['--scan', repo, '--json'], { env: { PATH, TOY_BROKEN_REMOTE: '1' } }).out).repos[0];
  assert.strictEqual(noRemote.error, 'error git');
  assert.strictEqual(noRemote.noRemote, undefined);
  const big = runHook(['--scan', repo, '--json'], { env: { PATH, TOY_BIG: '1' } });
  const scanned = JSON.parse(big.out).repos[0];
  assert.strictEqual(scanned.error, undefined, big.out);
  assert.deepStrictEqual(scanned.branches.map((b) => b.branch).sort(), ['b2', 'b4']);
});

test.after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

// ── La carpeta de trabajo que ya no existe (8.271) ────────────────────────────────────────────────────────────────────
//
// Un worktree temporal borrado con `git worktree remove` queda en el registro de la sesión. Escanearlo en cada cierre de
// turno da «no escaneado (error git)» sin fin. El registro guarda la carpeta git común del commit; con ella se prueba si
// lo que la sesión commiteó ahí sigue pendiente: una rama local lo tiene y ninguna remota. Si no se puede probar, se avisa
// una sola vez por sesión. Una carpeta que existe y en la que git falla sigue avisando siempre.

/** Un repo del arnés de juguete (con `.tycon` commiteada, para que el worktree la traiga) y un worktree en la rama `rama`. */
function repoConWorktree(name, rama = 'tarea') {
  const repo = toyRepo(name, 0);
  fs.writeFileSync(path.join(repo, '.tycon', 'repo.json'), '{}\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'tycon']); git(repo, ['push', '-q', 'origin', 'main']);
  const wt = path.join(path.dirname(repo), 'wt');
  git(repo, ['worktree', 'add', '-q', '-b', rama, wt, 'main']);
  return { repo, wt: fs.realpathSync(wt), common: fs.realpathSync(path.join(repo, '.git')) };
}
function registro(sid, renglones) {
  const dir = stateDir(HOME);
  fs.mkdirSync(dir, { recursive: true });
  // stable-data: el registro tiene que ser de hoy para que el gancho lo lea al cerrar el turno
  fs.writeFileSync(path.join(dir, `unpushed-commits-${sid}.jsonl`), renglones.map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r })).join('\n') + '\n');
}
const cierre = (sid) => runHook([], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: false }) });
const realDe = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

test('UnpushedRecord_Commit_GuardaLaCarpetaComun @story-8.271 @ac-10', () => {
  const { wt, common } = repoConWorktree('rec-comun');
  commit(wt, 'w.txt', 'w');
  const sid = 'rec-comun-session';
  runHook([], { input: JSON.stringify({ session_id: sid, tool_name: 'Bash', tool_input: { command: 'git commit -m w.txt' }, cwd: wt }) });
  const lineas = fs.readFileSync(path.join(stateDir(HOME), `unpushed-commits-${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const c = lineas.find((l) => l.kind === 'commit');
  assert.ok(c, JSON.stringify(lineas));
  assert.strictEqual(realDe(c.common), common);
  assert.ok(path.isAbsolute(c.common), 'la ruta va absoluta');
});

test('UnpushedStop_CarpetaBorradaYCommitEnElRemoto_Calla @story-8.271 @ac-11', () => {
  // empujado y borrado
  const a = repoConWorktree('borrada-empujada');
  const sha = commit(a.wt, 'a.txt', 'a');
  git(a.wt, ['push', '-q', 'origin', 'tarea']);
  git(a.repo, ['worktree', 'remove', a.wt]);
  registro('borrada-empujada', [{ repo: a.wt, kind: 'commit', sha, common: a.common }]);
  let r = cierre('borrada-empujada');
  assert.strictEqual(r.out.trim(), '', r.out);
  // reescrito (el sha viejo ya no está en ninguna rama), el nuevo empujado, y borrado
  const b = repoConWorktree('borrada-reescrita');
  const viejo = commit(b.wt, 'b.txt', 'b');
  git(b.wt, ['commit', '-q', '--amend', '-m', 'b reescrito']);
  const nuevo = git(b.wt, ['rev-parse', 'HEAD']);
  git(b.wt, ['push', '-q', 'origin', 'tarea']);
  git(b.repo, ['worktree', 'remove', b.wt]);
  registro('borrada-reescrita', [{ repo: b.wt, kind: 'commit', sha: viejo, common: b.common }, { repo: b.wt, kind: 'rewrite', shas: [nuevo], common: b.common }]);
  r = cierre('borrada-reescrita');
  assert.strictEqual(r.out.trim(), '', r.out);
});

test('UnpushedStop_CarpetaBorradaSinProbar_AvisaUnaVez @story-8.271 @ac-12', () => {
  // sin empujar: avisa la primera vez, con la carpeta y el commit; la segunda, no
  const a = repoConWorktree('borrada-sin-subir');
  const sha = commit(a.wt, 'a.txt', 'a');
  git(a.repo, ['worktree', 'remove', a.wt]);
  registro('borrada-sin-subir', [{ repo: a.wt, kind: 'commit', sha, common: a.common }]);
  let r = cierre('borrada-sin-subir');
  const reason = JSON.parse(r.out).reason;
  assert.match(reason, /ya no existe/);
  assert.ok(reason.includes('borrada-sin-subir/wt'), reason);
  assert.ok(reason.includes(sha.slice(0, 7)), reason);
  assert.doesNotMatch(reason, /no escaneado/);
  r = cierre('borrada-sin-subir');
  assert.strictEqual(r.out.trim(), '', 'el segundo cierre no repite el aviso');
  // sin carpeta común, y sólo con renglones sin sha: avisa una vez
  const b = repoConWorktree('borrada-sin-comun');
  const shaB = commit(b.wt, 'b.txt', 'b');
  git(b.wt, ['push', '-q', 'origin', 'tarea']);
  git(b.repo, ['worktree', 'remove', b.wt]);
  registro('borrada-sin-comun', [{ repo: b.wt, kind: 'commit', sha: shaB }]);
  assert.match(JSON.parse(cierre('borrada-sin-comun').out).reason, /ya no existe/);
  registro('borrada-sin-sha', [{ repo: b.wt, kind: 'commit', sha: null, common: b.common }]);
  assert.match(JSON.parse(cierre('borrada-sin-sha').out).reason, /ya no existe/);
  // una rama empujada y otra de la misma carpeta sin subir: avisa por la que falta
  const c = repoConWorktree('borrada-dos-ramas');
  const subido = commit(c.wt, 'c.txt', 'c');
  git(c.wt, ['push', '-q', 'origin', 'tarea']);
  git(c.wt, ['checkout', '-q', '-b', 'otra']);
  const local = commit(c.wt, 'd.txt', 'd');
  git(c.wt, ['checkout', '-q', 'tarea']);
  git(c.repo, ['worktree', 'remove', c.wt]);
  registro('borrada-dos-ramas', [{ repo: c.wt, kind: 'commit', sha: subido, common: c.common }, { repo: c.wt, kind: 'commit', sha: local, common: c.common }]);
  const dos = JSON.parse(cierre('borrada-dos-ramas').out).reason;
  assert.ok(dos.includes(local.slice(0, 7)), dos);
  assert.ok(!dos.includes(subido.slice(0, 7)), dos);
});

test('UnpushedStop_CarpetaVivaConGitRoto_SigueAvisando @story-8.271 @ac-13 @ac-14', () => {
  const roto = path.join(BASE, 'git-roto');
  fs.mkdirSync(roto, { recursive: true });
  fs.writeFileSync(path.join(roto, '.git'), `gitdir: ${path.join(BASE, 'no-existe')}\n`);
  registro('git-roto', [{ repo: roto, kind: 'commit', sha: 'a'.repeat(40) }]);
  for (let i = 0; i < 2; i++) assert.match(JSON.parse(cierre('git-roto').out).reason, /no escaneado/, `cierre ${i + 1}`);
});
