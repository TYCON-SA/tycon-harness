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
 *
 * stable-data: el reloj se lee para esperar la pasada de fondo y para fechar archivos y candados contra el mismo reloj
 * que lee el barrido (horas de quietud, edad del candado, el sello semanal); ninguna aserción depende de la fecha del día.
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
  const r = correr(L, ['--force']);
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
  const r = correr(L, ['--force']);
  assert.strictEqual(r.rc, 0);
  assert.match(r.out, /no toqué 2 con trabajo/);
  assert.match(r.out, /producto-wt-sucia \(tiene 1 archivo\(s\) con cambios\)/);
  assert.match(r.out, /producto-wt-nueva \(tiene 1 archivo\(s\) con cambios\)/);
  assert.ok(fs.existsSync(path.join(sucia, 'a.txt')) && fs.readFileSync(path.join(sucia, 'a.txt'), 'utf8') === 'cambiado\n');
  assert.ok(fs.existsSync(path.join(nueva, 'sin-seguimiento.txt')));
  assert.ok(ramas(L).includes('feat/sucia') && ramas(L).includes('feat/nueva'));
});

test('Arranque_UnmergedCommits_KeepsAndNamesIt', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-viva', 'feat/viva');
  const r = correr(L, ['--force']);
  assert.match(r.out, /producto-wt-viva \(commits sin mergear a origin\/main\)/);
  assert.ok(fs.existsSync(wt));
});

test('Arranque_RecentlyUsed_KeepsSilently', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-reciente', 'feat/reciente');
  mergear(L, 'feat/reciente');
  const r = correr(L, ['--force'], { TYCON_WORKTREE_SWEEP_IDLE_HOURS: '4' });
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
  const r = correr(L, ['--force'], {}, path.join(propia));
  assert.ok(fs.existsSync(fresca), 'borró una carpeta recién creada');
  assert.ok(fs.existsSync(bloqueada), 'borró una carpeta bloqueada');
  assert.ok(fs.existsSync(propia), 'borró la carpeta de esta sesión');
  assert.match(r.out, /producto-wt-propia \(es la carpeta de esta sesión\)/);
});

test('Arranque_OffSwitch_DoesNothing', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  const r = correr(L, ['--force'], { TYCON_WORKTREE_SWEEP: '0' });
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
  assert.match(r.out, /no la toqué: producto-wt-841b — tiene 1 archivo\(s\) con cambios/);
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

// ── una carpeta con una ejecución abierta no se borra (@story-8.318) ─────────────────────────────────────────────────

const openRuns = require(path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js'));

/** Abre una ejecución con su carpeta dentro de `wt` (la apertura en el gates.log de la casa del lugar). */
function abrirEn(L, wt, sid, story = '9.9') {
  // la carpeta de las ejecuciones va ignorada, como en los repos de verdad: su copia no ensucia la carpeta
  fs.appendFileSync(path.join(L.repo, '.git', 'info', 'exclude'), '.advisors/\n');
  return openRuns.abrir({ sid, story, repo: wt, runDir: path.join(wt, '.advisors', 'pipeline-runs', `${story}-${sid}`), home: L.home });
}

test('T19 WorktreeSweep_NoBorraCarpetaConEjecucionAbierta @story-8.318 @ac-16 — a mitad o terminada, no la borra y la nombra con la historia y la sesión', () => {
  const L = lugar();
  const mitad = carpeta(L, 'producto-wt-mitad', 'feat/mitad');
  const fin = carpeta(L, 'producto-wt-fin', 'feat/fin');
  mergear(L, 'feat/mitad');
  mergear(L, 'feat/fin');
  abrirEn(L, mitad, 's-mitad', '9.1');
  abrirEn(L, fin, 's-fin', '9.2');
  const r = correr(L, ['--force']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(fs.existsSync(mitad) && fs.existsSync(fin), 'borró una carpeta con una ejecución abierta');
  assert.match(r.out, /producto-wt-mitad \(tiene una ejecución abierta \(story 9\.1, sesión s-mitad\)\)/);
  assert.match(r.out, /producto-wt-fin \(tiene una ejecución abierta \(story 9\.2, sesión s-fin\)\)/);
});

test('T20 WorktreeSweep_SinEjecucionAbierta_BorraComoHoy @story-8.318 @ac-15 @ac-16 — sin ejecución, y con una copia vieja sin apertura vigente, la borra', () => {
  const L = lugar();
  const sin = carpeta(L, 'producto-wt-sin', 'feat/sin');
  const vieja = carpeta(L, 'producto-wt-vieja', 'feat/vieja');
  mergear(L, 'feat/sin');
  mergear(L, 'feat/vieja');
  // la ejecución de la vieja ya se cerró: su copia quedó (de antes del registro, o restaurada por git)
  const a = abrirEn(L, vieja, 's-vieja');
  openRuns.cerrar({ sid: 's-vieja', sesion: 's-vieja', home: L.home, motivo: 'prueba' });
  fs.mkdirSync(a.runDir, { recursive: true });
  fs.writeFileSync(path.join(a.runDir, 'run-open.json'), JSON.stringify({ sesion: 's-vieja', story: '9.9', runDir: a.runDir, ts: a.ts }));
  const r = correr(L, ['--force']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /borré 2 ya mergeada\(s\)/, r.out);
  assert.ok(!fs.existsSync(sin) && !fs.existsSync(vieja));
});

test('T21 WorktreeSweep_RegistroIlegible_NoBorraNinguna @story-8.318 @ac-17 — sin poder leer gates.log no borra y lo dice', { skip: (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) && 'los permisos de lectura no se niegan igual en Windows ni como root' }, () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-x', 'feat/x');
  mergear(L, 'feat/x');
  abrirEn(L, path.join(L.base, 'otra'), 's-otra');
  const log = path.join(stateDir(L.home), 'gates.log');
  fs.chmodSync(log, 0o000);
  try {
    const r = correr(L, ['--force']);
    assert.strictEqual(r.rc, 0, r.err);
    assert.ok(fs.existsSync(wt), 'borró sin poder ver');
    assert.match(r.out, /producto-wt-x \(no pude ver si tiene una ejecución abierta/);
  } finally { fs.chmodSync(log, 0o644); }
});

// ── la máquina se limpia sola: el barrido en cada arranque, de fondo (@story-8.164) ──────────────────────────────────
// El arranque sólo dice lo que dejó la pasada anterior y lanza la suya, desprendida; la pasada sigue desde su cursor,
// con un candado de una sola por máquina, cierra el marcador de una ejecución terminada antes de borrar su carpeta, y
// una vez por semana cuenta las ramas remotas ya entradas.

const saveOk = require(path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'save-ok.js'));
const esperar = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const resultado = (L) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(L.home), 'worktree-sweep-result.json'), 'utf8')); } catch (_) { return null; } };
const candado = (L) => path.join(stateDir(L.home), 'worktree-sweep.lock');

/** El arranque (el hook sin opciones) y la espera de la pasada que lanzó de fondo. */
function arranque(L, args = [], env = {}) {
  const antes = resultado(L);
  const t0 = Date.now();
  const r = correr(L, args, env);
  const ms = Date.now() - t0;
  const hasta = Date.now() + 60000;
  while (Date.now() < hasta) {
    const ahora = resultado(L);
    if (ahora && (!antes || ahora.at !== antes.at) && !fs.existsSync(candado(L))) break;
    esperar(100);
  }
  return { ...r, ms };
}

/** Un marcador activo de la sesión `sid` con su ejecución en `wt`; `terminada` le da el ok de guardar vigente. */
function marcador(L, sid, wt, { terminada = true, extra = {} } = {}) {
  const dir = path.join(stateDir(L.home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  const m = { storyId: '9.164', storyPath: path.join(wt, 'specs', 's.md'), repoPath: wt, sessionId: sid, startedAt: '2026-11-01T10:00:00.000Z',
    stepsPending: [], stepsCompleted: [], checks: {}, ...(terminada ? { saveOk: { huellas: [saveOk.huella(wt)] } } : {}), ...extra };
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(m));
  return path.join(dir, `${sid}.json`);
}

test('T4 8.164-CadaArranque_DeFondoConCursor @story-8.164 @ac-4 — el arranque no espera; entre las pasadas se miran todas; una sola pasada viva; el candado muerto se pisa', () => {
  const L = lugar();
  const nombres = ['a', 'b', 'c', 'd', 'e'].map((n) => `producto-wt-${n}`);
  const wts = nombres.map((n, i) => { const w = carpeta(L, n, `feat/${i}`); mergear(L, `feat/${i}`); return w; });
  const primero = arranque(L, ['--max', '2']);
  assert.strictEqual(primero.rc, 0, primero.err);
  assert.strictEqual(primero.out, '', 'el primer arranque no tiene pasada anterior que contar');
  assert.ok(primero.ms < 3000, `el arranque esperó la pasada (${primero.ms} ms)`);
  assert.strictEqual(wts.filter((w) => !fs.existsSync(w)).length, 2, 'la primera pasada mira dos');
  const segundo = arranque(L, ['--max', '2']);
  assert.match(segundo.out, /borré 2 ya mergeada\(s\)/, 'el arranque dice lo que dejó la pasada anterior');
  arranque(L, ['--max', '2']);
  assert.ok(wts.every((w) => !fs.existsSync(w)), 'entre las tres pasadas se miraron todas');
  // una pasada viva tiene el candado: la segunda sale sin hacer nada
  const otra = carpeta(L, 'producto-wt-f', 'feat/f');
  mergear(L, 'feat/f');
  fs.mkdirSync(path.dirname(candado(L)), { recursive: true });
  fs.writeFileSync(candado(L), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const ocupada = correr(L, ['--pass']);
  assert.strictEqual(ocupada.rc, 0, ocupada.err);
  assert.ok(fs.existsSync(otra), 'corrió con otra pasada viva');
  // el candado de un proceso muerto se pisa
  const muerto = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(candado(L), JSON.stringify({ pid: Number(muerto), at: new Date().toISOString() }));
  const pisa = correr(L, ['--pass']);
  assert.strictEqual(pisa.rc, 0, pisa.err);
  assert.ok(!fs.existsSync(otra), 'el candado de un proceso muerto la frenó');
  assert.ok(!fs.existsSync(candado(L)), 'la pasada no soltó el candado');
});

test('T18 8.164-HorasDesdeElPerfil @story-8.164 @ac-4 — las horas de quietud salen de maintenance.worktree_idle_hours; la variable las pisa', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-quieta', 'feat/quieta');
  mergear(L, 'feat/quieta');
  // quieta hace 5 horas: su índice, su HEAD, su historial y la carpeta
  const hace5 = (Date.now() - 5 * 3600 * 1000) / 1000;
  const gitDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-dir');
  for (const f of [wt, path.join(gitDir, 'index'), path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) fs.utimesSync(f, hace5, hace5);
  const perfil = path.join(L.base, 'team-profile.json');
  fs.writeFileSync(perfil, JSON.stringify({ maintenance: { worktree_idle_hours: 6 } }));
  const conPerfil = correr(L, ['--pass'], { TYCON_PROFILE: perfil, TYCON_WORKTREE_SWEEP_IDLE_HOURS: '' });
  assert.strictEqual(conPerfil.rc, 0, conPerfil.err);
  assert.ok(fs.existsSync(wt), 'con 6 horas en el perfil, una carpeta quieta hace 5 se borró');
  const conVariable = correr(L, ['--pass'], { TYCON_PROFILE: perfil, TYCON_WORKTREE_SWEEP_IDLE_HOURS: '4' });
  assert.strictEqual(conVariable.rc, 0, conVariable.err);
  assert.ok(!fs.existsSync(wt), 'la variable de la máquina no pisó al perfil');
});

test('T5 8.164-CierraElMarcador @story-8.164 @ac-5 — sólo la ejecución terminada: cierra su marcador y borra; las demás quedan y se nombran con sus sesiones', () => {
  const L = lugar();
  const casos = ['terminada', 'pasos', 'sin-ok', 'estacionada', 'dos', 'firma', 'viva'];
  const wt = {};
  for (const c of casos) { wt[c] = carpeta(L, `producto-wt-${c}`, `feat/${c}`); mergear(L, `feat/${c}`); }
  const m = marcador(L, 's-terminada', wt.terminada);
  marcador(L, 's-pasos', wt.pasos, { extra: { stepsPending: ['implement', 'run-tests', 'prepare-commit'] } });
  marcador(L, 's-sin-ok', wt['sin-ok'], { terminada: false });
  marcador(L, 's-estacionada', wt.estacionada);
  fs.mkdirSync(path.join(stateDir(L.home), 'parked'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(L.home), 'parked', 's-estacionada.json'), JSON.stringify({ story: '9.164', kind: 'queue', at: '2026-11-02T10:00:00.000Z', by: 'x' }));
  marcador(L, 's-dos-a', wt.dos);
  marcador(L, 's-dos-b', wt.dos);
  marcador(L, 's-firma', wt.firma);
  fs.mkdirSync(path.join(stateDir(L.home), 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(L.home), 'coordination', 'signatures.json'),
    JSON.stringify([{ tipo: 'firma', id: 'f1', key: 'k1', firma: 'save', sesion: 'coord', destino: 'otra', comando: 'x', cwd: path.join(wt.firma, 'specs'), title: 't', at: Date.now() }]));
  const sesiones = path.join(L.home, '.claude', 'sessions');
  fs.mkdirSync(sesiones, { recursive: true });
  fs.writeFileSync(path.join(sesiones, '1.json'), JSON.stringify({ sessionId: 's-viva', pid: process.pid, cwd: path.join(wt.viva, 'docs'), name: 'Viva' }));
  const r = correr(L, ['--force']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(!fs.existsSync(wt.terminada), `la terminada no se borró\n${r.out}`);
  assert.ok(!fs.existsSync(m), 'su marcador no se cerró');
  for (const c of casos.slice(1)) assert.ok(fs.existsSync(wt[c]), `borró la carpeta «${c}»\n${r.out}`);
  assert.match(r.out, /producto-wt-pasos \([^)]*s-pasos/, r.out);
  assert.match(r.out, /producto-wt-sin-ok \([^)]*s-sin-ok/, r.out);
  assert.match(r.out, /producto-wt-estacionada \([^)]*s-estacionada/, r.out);
  assert.match(r.out, /producto-wt-dos \([^)]*s-dos-a[^)]*s-dos-b/, r.out);
  assert.match(r.out, /producto-wt-firma \([^)]*firma pendiente/, r.out);
  assert.match(r.out, /producto-wt-viva \([^)]*sesión viva[^)]*Viva/, r.out);
  // un marcador que no se puede leer: esa pasada no borra ninguna
  const L2 = lugar();
  const otra = carpeta(L2, 'producto-wt-otra', 'feat/otra');
  mergear(L2, 'feat/otra');
  fs.mkdirSync(path.join(stateDir(L2.home), 'active'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(L2.home), 'active', 's-rota.json'), '{ roto');
  const r2 = correr(L2, ['--force']);
  assert.ok(fs.existsSync(otra), 'borró sin poder leer un marcador');
  assert.match(r2.out, /producto-wt-otra \([^)]*no pude leer el marcador s-rota/, r2.out);
});

test('T6 8.164-ConCambios_NuncaSeBorra @story-8.164 @ac-6 — sin seguimiento o con evidencia ignorada: quedan, y el aviso las nombra una vez por día', () => {
  const L = lugar();
  const suelta = carpeta(L, 'producto-wt-suelta', 'feat/suelta');
  const evidencia = carpeta(L, 'producto-wt-evidencia', 'feat/evidencia');
  mergear(L, 'feat/suelta');
  mergear(L, 'feat/evidencia');
  fs.writeFileSync(path.join(suelta, 'nuevo.txt'), 'x\n');
  fs.appendFileSync(path.join(L.repo, '.git', 'info', 'exclude'), '.advisors/\n');
  fs.mkdirSync(path.join(evidencia, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(evidencia, '.advisors', 'dod-runtime', 'x.md'), 'evidencia\n');
  fs.writeFileSync(path.join(evidencia, '.advisors', 'dod-runtime', 'y.md'), 'evidencia\n');
  arranque(L);
  const primero = arranque(L);
  assert.ok(fs.existsSync(suelta) && fs.existsSync(evidencia), 'borró una carpeta con trabajo');
  assert.match(primero.out, /producto-wt-suelta \(tiene 1 archivo\(s\) con cambios\)/, primero.out);
  assert.match(primero.out, /producto-wt-evidencia \(tiene 2 archivo\(s\) de evidencia sin guardar en \.advisors\)/, primero.out);
  assert.ok(fs.existsSync(path.join(stateDir(L.home), 'worktree-sweep-notice-last')), 'no anotó el día del aviso');
  const segundo = arranque(L);
  assert.doesNotMatch(segundo.out, /producto-wt-suelta|producto-wt-evidencia/, 'el mismo día las volvió a nombrar');
});

test('T7 8.164-PuestoFijo_NoSeToca @story-8.164 @ac-7 — un puesto bloqueado, limpio y entrado, con un marcador terminado: queda, y su marcador también', () => {
  const L = lugar();
  const puesto = carpeta(L, 'producto--slot-1', 'feat/puesto');
  mergear(L, 'feat/puesto');
  git(L.repo, 'worktree', 'lock', puesto);
  const m = marcador(L, 's-puesto', puesto);
  const r = correr(L, ['--pass']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(fs.existsSync(puesto), 'borró un puesto fijo');
  assert.ok(fs.existsSync(m), 'cerró el marcador de un puesto fijo');
});

test('T17 8.164-ConteoSemanal_DeRamas @story-8.164 @ac-17 — una vez por semana cuenta las ramas remotas ya entradas, después de traerlas con fetch --prune', () => {
  const L = lugar();
  for (const rama of ['feat/x', 'feat/y', 'feat/z']) {
    git(L.repo, 'branch', rama, 'HEAD');
    git(L.repo, 'push', '-q', 'origin', rama);
  }
  git(L.repo, 'fetch', '-q', 'origin');
  // el servidor ya borró feat/z: el clon todavía la ve
  git(path.join(L.base, 'remoto.git'), 'branch', '-D', 'feat/z');
  arranque(L);
  const primero = arranque(L);
  assert.match(primero.out, /2 rama\(s\) remota\(s\) ya entrada\(s\) a main/, primero.out);
  assert.match(primero.out, /push origin --delete/, 'no da el comando para borrarlas');
  assert.ok(!git(L.repo, 'branch', '-r').includes('origin/feat/z'), 'contó sin traer las ramas del servidor');
  const segundo = arranque(L);
  assert.doesNotMatch(segundo.out, /rama\(s\) remota/, 'la misma semana volvió a contar');
  const sello = path.join(stateDir(L.home), 'branch-count-last');
  const hace8 = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(sello, hace8, hace8);
  arranque(L);
  const semana = arranque(L);
  assert.match(semana.out, /2 rama\(s\) remota\(s\) ya entrada\(s\) a main/, 'la semana siguiente no volvió a contar');
});

// ── lo que encontró el pase adversarial: rutas por otro nombre, marcadores raros, el candado y la prueba sin borrar ──

test('T5b 8.164-OtroNombreDeLaMismaRuta_NoBorra @story-8.164 @ac-5 — la sesión viva o el marcador por un enlace o con otras mayúsculas protegen igual', () => {
  const L = lugar();
  const viva = carpeta(L, 'producto-wt-viva', 'feat/viva');
  const abierta = carpeta(L, 'producto-wt-abierta', 'feat/abierta');
  mergear(L, 'feat/viva');
  mergear(L, 'feat/abierta');
  const enlace = path.join(L.base, 'enlace-a-repos');
  fs.symlinkSync(L.root, enlace);
  const sesiones = path.join(L.home, '.claude', 'sessions');
  fs.mkdirSync(sesiones, { recursive: true });
  fs.writeFileSync(path.join(sesiones, '1.json'), JSON.stringify({ sessionId: 's-viva', pid: process.pid, cwd: path.join(enlace, 'producto-wt-viva') }));
  marcador(L, 's-abierta', path.join(enlace, 'producto-wt-abierta'), { extra: { stepsPending: ['implement', 'run-tests', 'prepare-commit'] } });
  const r = correr(L, ['--force']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(fs.existsSync(viva), `borró la carpeta de una sesión viva nombrada por un enlace\n${r.out}`);
  assert.ok(fs.existsSync(abierta), `borró la carpeta de una ejecución sin terminar nombrada por un enlace\n${r.out}`);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const L2 = lugar();
    const wt = carpeta(L2, 'producto-wt-mayus', 'feat/mayus');
    mergear(L2, 'feat/mayus');
    const s2 = path.join(L2.home, '.claude', 'sessions');
    fs.mkdirSync(s2, { recursive: true });
    fs.writeFileSync(path.join(s2, '1.json'), JSON.stringify({ sessionId: 's-m', pid: process.pid, cwd: path.join(L2.root, 'Producto-WT-Mayus') }));
    correr(L2, ['--force']);
    assert.ok(fs.existsSync(wt), 'borró la carpeta de una sesión viva nombrada con otras mayúsculas');
  }
});

test('T5c 8.164-MarcadorConTiposRaros_NoTrabaLaPasada @story-8.164 @ac-5 — un marcador con una ruta que no es texto deja su carpeta y la pasada sigue', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  fs.mkdirSync(path.join(stateDir(L.home), 'active'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(L.home), 'active', 's-rara.json'), JSON.stringify({ storyId: '9.1', repoPath: 123, storyPath: { x: 1 } }));
  const r = correr(L, ['--pass']);
  assert.strictEqual(r.rc, 0, r.err);
  const res = resultado(L);
  assert.ok(res, 'la pasada no dejó resultado');
  assert.ok(!fs.existsSync(wt) || res.kept.some((k) => k.name === 'producto-wt-a'), 'la carpeta ni se borró ni se nombró: la pasada se cortó');
});

test('T4b 8.164-CandadoQueEsCarpeta_SePisa @story-8.164 @ac-4 — un candado que no es un archivo no frena las pasadas para siempre', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  fs.mkdirSync(candado(L), { recursive: true });
  const r = correr(L, ['--pass']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(!fs.existsSync(wt), 'un candado que es carpeta frenó la pasada');
});

test('T4c 8.164-PasadaDeFondoEnPrueba_NoBorra @story-8.164 @ac-4 — con --dry-run, también --pass prueba sin borrar', () => {
  const L = lugar();
  const wt = carpeta(L, 'producto-wt-a', 'feat/a');
  mergear(L, 'feat/a');
  const r = correr(L, ['--pass', '--dry-run']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(fs.existsSync(wt), '--pass --dry-run borró');
});

test('T4d 8.164-DosPasadasSinMostrar_SeSuman @story-8.164 @ac-4 — lo que borró una pasada que nadie mostró se suma a la siguiente', () => {
  const L = lugar();
  const wts = ['a', 'b'].map((n) => { const w = carpeta(L, `producto-wt-${n}`, `feat/${n}`); mergear(L, `feat/${n}`); return w; });
  correr(L, ['--pass', '--max', '1']);
  correr(L, ['--pass', '--max', '1']);
  assert.ok(wts.every((w) => !fs.existsSync(w)));
  const r = arranque(L);
  assert.match(r.out, /borré 2 ya mergeada\(s\)/, r.out);
});
