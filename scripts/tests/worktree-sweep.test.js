'use strict';

/**
 * worktree-sweep.test.js — las carpetas de trabajo ya mergeadas se borran solas, y las que tienen trabajo no se tocan
 * (scripts/hooks/worktree-sweep.js).
 *
 * Los dos caminos:
 *   · el arranque (una vez por día): borra las limpias y con su HEAD en origin/main, nombra las que tienen cambios o
 *     commits sin mergear, no toca el checkout principal, ni una carpeta usada hace poco, ni una recién creada, ni una
 *     bloqueada, ni la del cwd; sella el día y calla al segundo arranque; se apaga con TYCON_WORKTREE_SWEEP=0;
 *   · el cierre de la story (`--story`): sólo las carpetas cuya rama nombra la story, después de traer origin.
 *
 * Con git de verdad: un remoto desnudo, su clon y carpetas de trabajo, todo en una carpeta temporal; un HOME de prueba
 * por caso (el sello va a su carpeta de estado) y TYCON_REPOS_ROOT apuntado a la carpeta de los repos. Sin red.
 *
 * Correr: node --test scripts/tests/worktree-sweep.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'worktree-sweep.js');
const { stateDir } = require(path.join(REPO, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const { branchNamesStory } = require(HOOK);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-sweep-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@ejemplo.test',
  GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@ejemplo.test',
  GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};

let serial = 0;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: path.join(tmp, 'git-home') } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Un lugar nuevo: { root (la carpeta de los repos), repo (clon con origin), home }. */
function lugar() {
  const base = path.join(tmp, `lugar-${++serial}`);
  const root = path.join(base, 'repos');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'git-home'), { recursive: true });
  const bare = path.join(base, 'remoto.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const repo = path.join(root, 'producto');
  git(base, 'clone', '-q', bare, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'primero');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'fetch', '-q', 'origin');
  return { base, root, repo, home };
}

/** Una carpeta de trabajo con su rama y un commit propio. */
function carpeta(L, nombre, rama) {
  const wt = path.join(L.root, nombre);
  git(L.repo, 'worktree', 'add', '-q', '-b', rama, wt, 'origin/main');
  fs.writeFileSync(path.join(wt, `${nombre}.txt`), `${nombre}\n`);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', `trabajo de ${nombre}`);
  return wt;
}

/** Mergea la rama a main en el remoto (merge commit) y trae origin: la carpeta queda «ya mergeada». */
function mergear(L, rama) {
  git(L.repo, 'merge', '-q', '--no-ff', '-m', `merge ${rama}`, rama);
  git(L.repo, 'push', '-q', 'origin', 'HEAD:main');
  git(L.repo, 'fetch', '-q', 'origin');
}

function correr(L, args = [], env = {}, cwd = L.base) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, HOME: L.home, USERPROFILE: L.home, TYCON_REPOS_ROOT: L.root, TYCON_WORKTREE_SWEEP_IDLE_HOURS: '0', TYCON_WORKTREE_SWEEP: '', TYCON_EVAL_SANDBOX: '', ...env },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

const ramas = (L) => git(L.repo, 'branch', '--format=%(refname:short)').split('\n');

test('Arranque_MergedClean_RemovesFolderAndBranch', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  const r = correr(L);
  assert.strictEqual(r.rc, 0);
  assert.match(r.out, /borré 1 ya mergeada\(s\) \(producto-wt-a\)/);
  assert.ok(!fs.existsSync(wt), 'la carpeta mergeada sigue');
  assert.ok(!ramas(L).includes('feat/a'), 'la rama mergeada sigue');
  assert.ok(fs.existsSync(path.join(L.repo, '.git')), 'tocó el checkout principal');
});

test('Arranque_WithChanges_KeepsAndNamesIt', () => {
  const L = lugar();
  const sucia = carpeta(L, 'producto-wt-sucia', 'feat/sucia');
  const nueva = carpeta(L, 'producto-wt-nueva', 'feat/nueva');
  mergear(L, 'feat/sucia');
  mergear(L, 'feat/nueva');
  fs.writeFileSync(path.join(sucia, 'a.txt'), 'cambiado\n');           // archivo modificado
  fs.writeFileSync(path.join(nueva, 'sin-seguimiento.txt'), 'x\n');    // archivo sin seguimiento
  const r = correr(L);
  assert.strictEqual(r.rc, 0);
  assert.match(r.out, /no toqué 2 con trabajo/);
  assert.match(r.out, /producto-wt-sucia \(tiene cambios\)/);
  assert.match(r.out, /producto-wt-nueva \(tiene cambios\)/);
  assert.ok(fs.existsSync(path.join(sucia, 'a.txt')) && fs.readFileSync(path.join(sucia, 'a.txt'), 'utf8') === 'cambiado\n');
  assert.ok(fs.existsSync(path.join(nueva, 'sin-seguimiento.txt')));
  assert.ok(ramas(L).includes('feat/sucia') && ramas(L).includes('feat/nueva'));
});

test('Arranque_UnmergedCommits_KeepsAndNamesIt', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-viva', 'feat/viva');
  const r = correr(L);
  assert.match(r.out, /producto-wt-viva \(commits sin mergear a origin\/main\)/);
  assert.ok(fs.existsSync(wt));
});

test('Arranque_RecentlyUsed_KeepsSilently', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-reciente', 'feat/reciente');
  mergear(L, 'feat/reciente');
  const r = correr(L, [], { TYCON_WORKTREE_SWEEP_IDLE_HOURS: '4' });
  assert.strictEqual(r.out, '', 'una carpeta usada hace minutos puede ser de otra sesión viva');
  assert.ok(fs.existsSync(wt));
});

test('Arranque_FreshFromMain_Locked_OrSessionCwd_KeepsThem', () => {
  const L = lugar();
  const fresca = path.join(L.root, 'producto-wt-fresca');
  git(L.repo, 'worktree', 'add', '-q', '-b', 'feat/fresca', fresca, 'origin/main');   // sin trabajo propio todavía
  const bloqueada = carpeta(L, 'producto-wt-bloqueada', 'feat/bloqueada');
  const propia = carpeta(L, 'producto-wt-propia', 'feat/propia');
  mergear(L, 'feat/bloqueada');
  mergear(L, 'feat/propia');
  git(L.repo, 'worktree', 'lock', bloqueada);
  // HEAD de la fresca vuelve a ser la punta: la avanzamos con main para que siga siendo «recién creada»
  git(fresca, 'merge', '-q', '--ff-only', 'origin/main');
  const r = correr(L, [], {}, path.join(propia));
  assert.ok(fs.existsSync(fresca), 'borró una carpeta recién creada');
  assert.ok(fs.existsSync(bloqueada), 'borró una carpeta bloqueada');
  assert.ok(fs.existsSync(propia), 'borró la carpeta de esta sesión');
  assert.match(r.out, /producto-wt-propia \(es la carpeta de esta sesión\)/);
});

test('Arranque_OncePerDay_SealsAndStaysQuiet', () => {
  const L = lugar();
  carpeta(L, 'producto-wt-viva', 'feat/viva');
  const a = correr(L);
  assert.match(a.out, /producto-wt-viva/);
  assert.ok(fs.existsSync(path.join(stateDir(L.home), 'worktree-sweep-last-run')), 'no selló el día');
  const b = correr(L);
  assert.strictEqual(b.out, '', 'el segundo arranque del día habló');
  const c = correr(L, ['--force']);
  assert.match(c.out, /producto-wt-viva/);
});

test('Arranque_OffSwitch_DoesNothing', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  const r = correr(L, [], { TYCON_WORKTREE_SWEEP: '0' });
  assert.strictEqual(r.rc, 0);
  assert.strictEqual(r.out, '');
  assert.ok(fs.existsSync(wt));
  assert.ok(!fs.existsSync(path.join(stateDir(L.home), 'worktree-sweep-last-run')));
});

test('Arranque_DryRun_TouchesNothing', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  const r = correr(L, ['--dry-run']);
  assert.match(r.out, /borraría 1 ya mergeada\(s\)/);
  assert.ok(fs.existsSync(wt));
});

test('Close_Story_RemovesOnlyThatStoryFolders_KeepsDirtyOne', () => {
  const L = lugar();
  const a = carpeta(L, 'producto-wt-841a', 'feat/8.41-a-paquete');
  const b = carpeta(L, 'producto-wt-841b', 'feat/8.41-b-sitio');
  const otra = carpeta(L, 'producto-wt-otra', 'feat/2.30-otra');
  for (const r of ['feat/8.41-a-paquete', 'feat/8.41-b-sitio', 'feat/2.30-otra']) mergear(L, r);
  fs.writeFileSync(path.join(b, 'a.txt'), 'a medias\n');
  const r = correr(L, ['--story', '8.41'], { TYCON_WORKTREE_SWEEP_IDLE_HOURS: '4' });
  assert.strictEqual(r.rc, 0);
  assert.match(r.out, /borrada: producto-wt-841a/);
  assert.match(r.out, /no la toqué: producto-wt-841b — tiene cambios/);
  assert.ok(!fs.existsSync(a), 'la carpeta mergeada de la story sigue (el cierre no espera horas de uso)');
  assert.ok(fs.existsSync(b) && fs.existsSync(otra), 'tocó una carpeta con cambios o de otra story');
  assert.ok(!ramas(L).includes('feat/8.41-a-paquete'));
});

test('Close_Story_FetchesOrigin_BeforeJudging', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-9', 'feat/9.1-x');
  // el merge entra al remoto desde otro clon: el clon local no lo sabe hasta traer origin
  const otro = path.join(L.base, 'otro-clon');
  git(L.base, 'clone', '-q', path.join(L.base, 'remoto.git'), otro);
  git(L.repo, 'push', '-q', 'origin', 'feat/9.1-x');
  git(otro, 'fetch', '-q', 'origin');
  git(otro, 'merge', '-q', '--no-ff', '-m', 'merge', 'origin/feat/9.1-x');
  git(otro, 'push', '-q', 'origin', 'HEAD:main');
  const r = correr(L, ['--story', '9.1']);
  assert.match(r.out, /borrada: producto-wt-9/);
  assert.ok(!fs.existsSync(wt));
});

test('Close_Story_NoFolders_SaysSo', () => {
  const L = lugar();
  const r = correr(L, ['--story', '7.7']);
  assert.match(r.out, /carpetas de trabajo de la story 7\.7: ninguna/);
});

test('BranchNamesStory_MatchesTokenNotPrefix', () => {
  assert.ok(branchNamesStory('feat/8.41-a-paquete', '8.41'));
  assert.ok(branchNamesStory('story/8-41', '8.41'));
  assert.ok(!branchNamesStory('feat/18.41-x', '8.41'));
  assert.ok(!branchNamesStory('feat/8.410-x', '8.41'));
  assert.ok(!branchNamesStory(null, '8.41'));
});

test('BranchNamesStory_StoryWithRegexCharacters_IsLiteral', () => {
  // la story llega por `--story`: sus caracteres se leen tal cual, no como una expresión
  assert.ok(branchNamesStory('feat/8.1+-x', '8.1+'));
  assert.ok(!branchNamesStory('feat/8.11-x', '8.1+'));
  assert.ok(!branchNamesStory('feat/x', '8.1|x'));
});
