'use strict';
// finished-open-notice.test.js — el aviso de arranque de lo terminado sin cerrar: lista lo de
// toda la máquina, hasta cinco, con el comando de cada sesión; calla si no hay nada. Corre el gancho real en una casa de
// prueba; ningún caso sale a la red (los caminos cortos no tienen repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'finished-open-notice.js');
const { stateDir, claudeDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const PASOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'prepare-commit'];
const terminada = (story) => ({
  storyId: story, stepScheme: 2, stepsCompleted: PASOS, stepsPending: [], dodRuntimeChecked: true, deepReviewDone: true,
  stepTimings: { reviewers: { completedAt: '2026-10-15T10:00:00Z' }, findings: { completedAt: '2026-10-15T10:10:00Z' }, 'prepare-commit': { completedAt: '2026-10-15T10:30:00Z' } },
  lastTouch: '2026-10-15T10:30:00Z',
});

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-notice-'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  const marcador = (sid, m) => fs.writeFileSync(path.join(sdir, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, ...m }));
  const sesion = (sid, vive) => fs.writeFileSync(path.join(claudeDir(home), 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ sessionId: sid, pid: vive ? process.pid : 2147483646 }));
  const correr = (env = {}) => spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'nueva-0000' }),
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_EVAL_SANDBOX: '', TYCON_FINISHED_OPEN_NOTICE: '', TYCON_FINISHED_OPEN_NOW: '2026-10-15T12:00:00Z', TYCON_UNSAVED_FOLDERS: '0', ...env },
  });
  return { home, sdir, marcador, sesion, correr };
}

test('T19 Arranque_ListaLasDeOtrasSesiones @story-8.195 @ac-19 — seis casos de tres sesiones: cinco y «y 1 más», cada uno con el comando de su sesión', () => {
  const C = casa();
  const viva = 'aaaaaaaa-viva';
  const muerta = 'bbbbbbbb-muerta';
  const sinRegistro = 'cccccccc-codex';
  C.sesion(viva, true);
  C.sesion(muerta, false);
  // dos ejecuciones por sesión (una con un sufijo de marcador, como las que adopta otra sesión)
  for (const [sid, n] of [[viva, 1], [viva, 2], [muerta, 3], [muerta, 4], [sinRegistro, 5], [sinRegistro, 6]]) {
    const archivo = n % 2 ? sid : `${sid}-${n}`;
    C.marcador(archivo, { ...terminada(`9.${n}`), sessionId: archivo });
  }
  // cada marcador es su propia sesión para la regla de vida: los sufijados no tienen registro
  const r = C.correr();
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  const renglones = out.split('\n').filter((l) => /^\s*· /.test(l));
  assert.equal(renglones.length, 6, out);
  assert.match(renglones[5], /y 1 más/);
  assert.match(out, /story 9\.1 \(sesión aaaaaaaa\): terminó hace 1 h 30 min y sigue abierta; la cierra su sesión/);
  assert.doesNotMatch(out.split('\n').find((l) => /story 9\.1 /.test(l)), /clear-session/, 'la viva no lleva comando de cierre');
  assert.match(out, new RegExp(`story 9\\.3 \\(sesión bbbbbbbb\\): terminó hace 1 h 30 min y sigue abierta; su sesión ya no está: node \\S*marker\\.js clear-session ${muerta}`));
  assert.match(out, /story 9\.[56] \(sesión cccccccc\): .*no sé si la sesión vive \(no tiene registro de sesión: puede ser de Codex, o estar cerrada\): no doy comando/);
  assert.doesNotMatch(out, /nueva-0000/, 'el comando es el de cada sesión, no el de la que arranca');
});

test('T19b Arranque_EjecucionPerdida_ConLost @story-8.195 @ac-19 — la ejecución perdida lleva clear-session --lost', () => {
  const C = casa();
  const sid = 'dddddddd-perdida';
  C.sesion(sid, false);
  C.marcador(sid, terminada('9.7'));
  // la pieza que falta: la ejecución dice que está abierta en su repo y el marcador de su carpeta no está (lib/open-runs.js)
  const lost = path.join(C.home, 'lost.js');
  fs.writeFileSync(lost, `require(${JSON.stringify(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js'))}).perdida = () => ({ caso: 'sin-marcador' });\n`);
  const r = spawnSync(process.execPath, ['--require', lost, HOOK], {
    encoding: 'utf8', input: '{}', env: { ...process.env, HOME: C.home, USERPROFILE: C.home, TYCON_HOME: '', TYCON_EVAL_SANDBOX: '', TYCON_FINISHED_OPEN_NOTICE: '', TYCON_FINISHED_OPEN_NOW: '2026-10-15T12:00:00Z', TYCON_UNSAVED_FOLDERS: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`story 9\\.7 .*su ejecución está perdida: node \\S*marker\\.js clear-session ${sid} --lost \\(lo firma una persona\\)`));
});

test('T20 Avisos_NadaAbierto_Callan @story-8.195 @ac-20 — sin nada terminado, sin salida; con uno terminado, la línea', () => {
  const C = casa();
  C.marcador('eeeeeeee-encurso', { ...terminada('9.8'), stepsPending: ['prepare-commit'], stepsCompleted: PASOS.slice(0, -1) });
  const vacio = C.correr();
  assert.equal(vacio.status, 0, vacio.stderr);
  assert.equal(vacio.stdout, '', 'nada terminado: calla');
  // en la misma casa, uno terminado: el gancho corre y dice
  C.marcador('ffffffff-hecha', terminada('9.9'));
  const lleno = C.correr();
  assert.match(lleno.stdout, /story 9\.9 \(sesión ffffffff\): terminó hace/);
  // apagado, calla
  assert.equal(C.correr({ TYCON_FINISHED_OPEN_NOTICE: '0' }).stdout, '');
});

test('T21 Avisos_NoCierranNada @story-8.195 @ac-21 — el aviso de arranque no toca los marcadores que lista', () => {
  const C = casa();
  C.sesion('gggggggg-muerta', false);
  C.marcador('gggggggg-muerta', terminada('9.10'));
  const f = path.join(C.sdir, 'active', 'gggggggg-muerta.json');
  const antes = fs.readFileSync(f, 'utf8');
  const r = C.correr();
  assert.match(r.stdout, /clear-session gggggggg-muerta/, 'da el comando');
  assert.equal(fs.readFileSync(f, 'utf8'), antes, 'y no lo corre');
});

// las carpetas de trabajo sin commitear: un repo de prueba con tres worktrees (sucio sin sesión, sucio con una sesión
// viva adentro, limpio); sólo el primero se dice
function repoConWorktrees(home) {
  const g = (dir, ...args) => {
    const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-10-15T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T10:00:00Z' } });
    assert.equal(r.status, 0, r.stderr);
  };
  const repo = path.join(home, 'repos', 'producto');
  fs.mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', 'a.txt');
  g(repo, 'commit', '-q', '-m', 'base');
  const wt = (nombre) => { const d = path.join(home, 'repos', nombre); g(repo, 'worktree', 'add', '-q', '-b', `story/${nombre}`, d); return d; };
  const tirada = wt('tirada');
  const ocupada = wt('ocupada');
  wt('limpia');
  fs.writeFileSync(path.join(tirada, 'a.txt'), 'cambiado\n');
  fs.writeFileSync(path.join(tirada, 'nuevo.js'), 'x\n');
  fs.writeFileSync(path.join(ocupada, 'a.txt'), 'cambiado\n');
  return { repo, tirada, ocupada };
}

test('T-133a CarpetasSinCommitear_SoloLaQueNadieUsa — dice carpeta, rama, cuántos archivos y desde cuándo; calla la ocupada y la limpia', async () => {
  const C = casa();
  const { repo, ocupada } = repoConWorktrees(C.home);
  fs.writeFileSync(path.join(claudeDir(C.home), 'sessions', '1.json'), JSON.stringify({ sessionId: 'viva', pid: process.pid, cwd: path.join(ocupada, 'sub') }));
  const lib = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'finished-open.js'));
  const lines = await lib.unsavedFolders({ home: C.home, now: Date.now() + 2 * 3600e3, repos: [repo] });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /repos[\\/]tirada \(rama story\/tirada\): 2 archivos sin commitear, sin tocar hace 2 h; ninguna sesión viva trabaja ahí/);
});

test('T-133b CarpetasSinCommitear_ElGancho_NoTocaNada — el aviso sale al arrancar y la carpeta queda igual', () => {
  const C = casa();
  const { tirada } = repoConWorktrees(C.home);
  const antes = fs.readFileSync(path.join(tirada, 'a.txt'), 'utf8');
  const r = C.correr({ TYCON_UNSAVED_FOLDERS: '', TYCON_REPOS_ROOT: path.join(C.home, 'repos') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^🔔 carpetas de trabajo con cambios sin commitear y sin sesión/m);
  assert.match(r.stdout, /^\s+· \S*tirada \(rama story\/tirada\): 2 archivos sin commitear/m);
  assert.equal(fs.readFileSync(path.join(tirada, 'a.txt'), 'utf8'), antes);
  assert.equal(C.correr({ TYCON_UNSAVED_FOLDERS: '0', TYCON_REPOS_ROOT: path.join(C.home, 'repos') }).stdout, '', 'apagado, calla');
});

// Los caminos cortos viejos de una máquina anotan rutas de carpetas que ya no existen (temporales, worktrees borrados).
// Cada una le preguntaba a git por la carpeta que existe más arriba: cientos de veces la misma. Se pregunta una vez.
test('T10 · FinishedOpen_MissingFolders_AskedOncePerExistingFolder @story-8.266 @ac-6 — dos caminos cortos con rutas en carpetas borradas bajo la misma carpeta que existe', () => {
  const C = casa();
  const temporal = path.join(C.home, 'temporal');
  fs.mkdirSync(temporal);
  fs.mkdirSync(path.join(C.sdir, 'adhoc'), { recursive: true });
  for (const sid of ['eeeeeeee-uno', 'ffffffff-dos']) {
    const rutas = Array.from({ length: 15 }, (_, i) => path.join(temporal, `${sid}-borrada-${i}`, 'x.txt'));
    fs.writeFileSync(path.join(C.sdir, 'adhoc', `${sid}.json`), JSON.stringify({ reason: 'prueba', rutas, files: [], bases: {}, lastTouch: '2026-10-15T11:00:00Z' }));
  }
  const trace = path.join(C.home, 'trace.json');
  const r = C.correr({ GIT_TRACE2_EVENT: trace });
  assert.equal(r.status, 0, r.stderr);
  const starts = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'start') : [];
  const toplevel = starts.filter((e) => e.argv.includes('--show-toplevel'));
  assert.equal(toplevel.length, 1, toplevel.map((e) => e.argv.join(' ')).join('\n'));
  // un git que no contestó no se guarda: la próxima ruta de la misma carpeta vuelve a preguntar
  if (process.platform === 'win32') return;
  const bin = path.join(C.home, 'bin');
  const calls = path.join(C.home, 'calls.txt');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> "${calls}"\necho "fatal: unable to read index" >&2\nexit 128\n`, { mode: 0o755 });
  const probe = [
    `const base = require(${JSON.stringify(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'adhoc-base.js'))});`,
    'const seen = new Map();',
    `const a = base.ubicar(${JSON.stringify(path.join(temporal, 'a.txt'))}, seen);`,
    `const b = base.ubicar(${JSON.stringify(path.join(temporal, 'b.txt'))}, seen);`,
    'process.stdout.write(JSON.stringify({ a: !!a.falla, b: !!b.falla, kept: seen.size }));',
  ].join('\n');
  const p = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: C.home, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), { a: true, b: true, kept: 0 });
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('T11 · FinishedOpen_DeletedFolderInLiveRepo_StillBringsTheRepo @story-8.266 @ac-6 — una carpeta borrada y commiteada en un repo vivo sigue trayendo el repo', () => {
  const C = casa();
  const repo = path.join(C.home, 'vivo');
  const g = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: C.home, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' } });
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  g(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'sub', 'x.txt'), 'x\n');
  g(['add', '-A']); g(['commit', '-qm', 'x']);
  g(['rm', '-rq', 'sub']); g(['commit', '-qm', 'borrada']);
  const base = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'adhoc-base.js'));
  const adhoc = { reason: 'prueba', rutas: [path.join(repo, 'sub', 'x.txt')], files: [], bases: {} };
  const real = fs.realpathSync(repo);
  assert.deepEqual(base.reposDelCarril(adhoc), [real], 'sin la opción, como siempre');
  assert.deepEqual(base.reposDelCarril(adhoc, { ubicados: new Map() }), [real], 'con lo ya ubicado compartido, lo mismo');
});
