'use strict';
// finished-open.test.js — lo terminado sin cerrar: qué ejecución o camino corto terminó y sigue
// abierto, con qué se cierra, y lo que no se pudo medir. La plataforma es un `gh` de mentira (scripts/tests/lib/fake-gh.js):
// estas pruebas no salen a la red.
// stable-data: T29 mide el borrado automático de marker.js, que lee el reloj del sistema; la edad del marcador se arma
// desde ahora. Las demás usan la fecha fija AHORA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const FAKE_GH = path.join(RAIZ, 'scripts', 'tests', 'lib', 'fake-gh.js');
const F = require('../lib/finished-open.js');
const L = require('../lib/session-liveness.js');
const { stateDir, claudeDir } = require('../lib/state-dir.js');

const AHORA = Date.parse('2026-10-15T12:00:00Z');
const HACE = (min) => new Date(AHORA - min * 60000).toISOString();
const FECHA = '2026-10-15T08:00:00';

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  const marcador = (sid, m) => fs.writeFileSync(path.join(sdir, 'active', `${sid}.json`), typeof m === 'string' ? m : JSON.stringify({ sessionId: sid, ...m }));
  const carril = (sid, a) => fs.writeFileSync(path.join(sdir, 'adhoc', `${sid}.json`), JSON.stringify(a));
  // el registro de sesión que escribe Claude Code: un proceso vivo (éste) o uno que ya no existe
  const sesion = (sid, vive) => fs.writeFileSync(path.join(claudeDir(home), 'sessions', `${sid.slice(0, 6)}.json`),
    JSON.stringify({ sessionId: sid, pid: vive ? process.pid : 2147483646, name: `nombre-${sid.slice(0, 4)}` }));
  return { home, sdir, marcador, carril, sesion };
}

// Una ejecución con todos los pasos hechos; `extra` la modifica.
const terminada = (extra = {}) => ({
  storyId: '7.7', storyPath: '/x/specs/story-7.7.md', repoPath: '/x', stepScheme: 2,
  stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'prepare-commit'],
  stepsPending: [], dodRuntimeChecked: true, deepReviewDone: true,
  stepTimings: { reviewers: { completedAt: HACE(120) }, findings: { completedAt: HACE(110) }, 'prepare-commit': { completedAt: HACE(90) } },
  lastTouch: HACE(80), ...extra,
});

// Un repo con una rama de camino corto, su base y un origin de GitHub (que contesta el gh de mentira).
function repoConRama({ entro = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-repo-'));
  const remoto = path.join(base, 'remoto.git');
  const repo = path.join(base, 'repo');
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (dir, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { encoding: 'utf8', env }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'inicio');
  git(repo, 'remote', 'add', 'origin', remoto);
  git(repo, 'push', '-q', 'origin', 'main');
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'fix/rapido');
  fs.writeFileSync(path.join(repo, 'a.js'), '2\n');
  git(repo, 'commit', '-qam', 'arreglo');
  // entra como entra un pedido: con un merge en main
  if (entro) {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge del pedido', 'fix/rapido');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', 'fix/rapido');
    git(repo, 'fetch', '-q', 'origin');
  }
  // el origin que se lee es el de GitHub; el remoto local sólo sirve para que origin/main exista
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/arnes.git');
  return { repo, adhoc: { reason: 'arreglo chico del aviso', bases: { [repo]: { sha } }, declaredAt: HACE(200) } };
}

function ghCon(pulls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-gh-'));
  const state = path.join(dir, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ user: 'arnes-bot', now: '2026-10-15T12:00:00Z', pulls: { 'acme/arnes': pulls } }));
  return { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: state, FAKE_GH_LOG: path.join(dir, 'log.jsonl'), TYCON_PROFILE: '0' };
}
const llamadas = (env) => (fs.existsSync(env.FAKE_GH_LOG) ? fs.readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('T16 Ejecucion_TerminadaSinCerrar_DiceDesdeCuandoYComoSeCierra @story-8.195 @ac-16 — la línea de la sesión propia cuenta desde el cierre de «Preparar el commit»', () => {
  const C = casa();
  C.marcador('s-16', terminada());
  const r = F.stopLines({ sid: 's-16', home: C.home, stateDir: C.sdir, now: AHORA });
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.match(r[0], /la ejecución de la story 7\.7 terminó hace 1 h 30 min y sigue abierta: cerrala con `marker\.js clear` después del último push y del último pedido/);
  // sin la hora del último paso, desde lastTouch
  C.marcador('s-16', terminada({ stepTimings: { reviewers: { completedAt: HACE(120) }, findings: { completedAt: HACE(110) } } }));
  assert.match(F.stopLines({ sid: 's-16', home: C.home, stateDir: C.sdir, now: AHORA })[0], /terminó hace 1 h 20 min/);
});

test('T17 Ejecucion_ConOtraVuelta_DiceQueFaltaRevisar @story-8.195 @ac-17 — con código cambiado después de los revisores, no dice que se cierre', () => {
  const C = casa();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-r17-'));
  fs.mkdirSync(path.join(repo, '.git'));
  C.marcador('s-17', terminada({ repoPath: repo, fileEvents: [{ path: path.join(repo, 'src', 'a.js'), ts: HACE(60), code: true }] }));
  const r = F.stopLines({ sid: 's-17', home: C.home, stateDir: C.sdir, now: AHORA });
  assert.equal(r.length, 1);
  assert.match(r[0], /story 7\.7 tiene código cambiado después de los revisores \(src\/a\.js\): falta revisarlo; `pipeline\.js next` dice cómo/);
  assert.doesNotMatch(r[0], /marker\.js clear/);
  // los revisores cerraron después del último paso: «Preparar el commit» se pide otra vez, también es revisar
  C.marcador('s-17', terminada({ stepTimings: { reviewers: { completedAt: HACE(120), lastCompletedAt: HACE(30) }, findings: { completedAt: HACE(110) }, 'prepare-commit': { completedAt: HACE(90) } } }));
  assert.match(F.stopLines({ sid: 's-17', home: C.home, stateDir: C.sdir, now: AHORA })[0], /falta revisarlo/);
});

test('T18 CaminoCorto_ConPedido_AbiertoOMergeado @story-8.195 @ac-18 — el pedido abierto por la plataforma, la rama ya en main por git', () => {
  const C = casa();
  const { repo, adhoc } = repoConRama();
  C.carril('s-18', adhoc);
  const env = ghCon([{ number: 41, state: 'open', head: { ref: 'fix/rapido' }, base: { ref: 'main' }, title: 'x', user: { login: 'a' } }]);
  const r = F.stopLines({ sid: 's-18', home: C.home, stateDir: C.sdir, now: AHORA, env });
  assert.deepEqual(r.map((l) => l.replace(/^🔔 \[tycon-pipeline\] /, '')),
    ['el camino corto «arreglo chico del aviso» tiene su pedido 41 abierto y sigue abierto: cerralo con `marker.js adhoc clear`']);
  // ya en main, sin pedido abierto: lo dice git, sin número
  const otro = repoConRama({ entro: true });
  C.carril('s-18b', otro.adhoc);
  const r2 = F.stopLines({ sid: 's-18b', home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]) });
  assert.match(r2[0], /el camino corto «arreglo chico del aviso» tiene su rama ya en main y sigue abierto: cerralo con `marker\.js adhoc clear`/);
  // una rama recién creada, sin nada propio, no «entró»
  execFileSync('git', ['-C', repo, 'checkout', '-q', 'main']);
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'fix/vacia']);
  assert.deepEqual(F.stopLines({ sid: 's-18', home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]) }), []);
});

test('T18 CierreDeTurno_CaminoCortoConPedido_Avisa @story-8.195 @ac-18 — el cierre de turno real dice el pedido y no frena', () => {
  const C = casa();
  const { adhoc } = repoConRama();
  C.carril('s-18c', adhoc);
  const env = ghCon([{ number: 41, state: 'open', head: { ref: 'fix/rapido' }, base: { ref: 'main' }, title: 'x', user: { login: 'a' } }]);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-stop-dod-gate.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: 's-18c', last_assistant_message: 'sigo' }),
    env: { ...process.env, ...env, HOME: C.home, USERPROFILE: C.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: 's-18c' },
  });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.decision, undefined, 'no frena');
  assert.match(o.systemMessage, /el camino corto «arreglo chico del aviso» tiene su pedido 41 abierto y sigue abierto: cerralo con `marker\.js adhoc clear`/);
});

test('T20 Ejecucion_EnCursoONada_NoDiceNada @story-8.195 @ac-20 — sin nada terminado, ninguna línea; con uno terminado, la línea', () => {
  const C = casa();
  assert.deepEqual(F.stopLines({ sid: 's-20', home: C.home, stateDir: C.sdir, now: AHORA }), []);
  C.marcador('s-20', terminada({ stepsPending: ['prepare-commit'], stepsCompleted: ['start'] }));
  assert.deepEqual(F.stopLines({ sid: 's-20', home: C.home, stateDir: C.sdir, now: AHORA }), []);
  assert.deepEqual(F.machine({ home: C.home, stateDir: C.sdir, now: AHORA }).items, []);
  C.marcador('s-20', terminada());
  assert.equal(F.stopLines({ sid: 's-20', home: C.home, stateDir: C.sdir, now: AHORA }).length, 1);
});

test('T21 Avisos_NoCierranNada @story-8.195 @ac-21 — después de mirar, el marcador, el carril y el pedido siguen igual', () => {
  const C = casa();
  const { adhoc } = repoConRama();
  C.marcador('s-21', terminada());
  C.carril('s-21', adhoc);
  const antes = [path.join(C.sdir, 'active', 's-21.json'), path.join(C.sdir, 'adhoc', 's-21.json')].map((f) => fs.readFileSync(f, 'utf8'));
  const env = ghCon([{ number: 41, state: 'open', head: { ref: 'fix/rapido' }, base: { ref: 'main' }, title: 'x', user: { login: 'a' } }]);
  F.stopLines({ sid: 's-21', home: C.home, stateDir: C.sdir, now: AHORA, env });
  F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, env });
  const despues = [path.join(C.sdir, 'active', 's-21.json'), path.join(C.sdir, 'adhoc', 's-21.json')].map((f) => fs.readFileSync(f, 'utf8'));
  assert.deepEqual(despues, antes);
  const metodos = fs.readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((l) => (l.args || []).join(' '));
  for (const m of metodos) assert.doesNotMatch(m, /--method (POST|PATCH|PUT|DELETE)/, 'sólo lecturas a la plataforma');
});

test('T25 Pedido_SinRed_DiceQueNoSabe @story-8.195 @ac-25 — sin plataforma, una sola línea por día; la segunda consulta sale de la foto', () => {
  const C = casa();
  const { adhoc } = repoConRama();
  C.carril('s-25', adhoc);
  const env = { ...ghCon([]), FAKE_GH_STATE: path.join(os.tmpdir(), 'no-existe-finished-open.json') };
  const a = F.stopLines({ sid: 's-25', home: C.home, stateDir: C.sdir, now: AHORA, env });
  assert.equal(a.length, 1, JSON.stringify(a));
  assert.match(a[0], /no pude ver si el pedido del camino corto está abierto \(.+\)/);
  const n = llamadas(env);
  const b = F.stopLines({ sid: 's-25', home: C.home, stateDir: C.sdir, now: AHORA + 60000, env });
  assert.deepEqual(b, [], 'la misma sesión, el mismo día: no lo repite');
  assert.equal(llamadas(env), n, 'dentro de los 10 minutos no consulta otra vez');
  assert.ok(fs.existsSync(path.join(C.sdir, 'finished-open-prs.json')));
  assert.ok(fs.existsSync(path.join(C.sdir, 'finished-open-said.json')));
  // al día siguiente lo vuelve a decir
  assert.equal(F.stopLines({ sid: 's-25', home: C.home, stateDir: C.sdir, now: AHORA + 86400000, env }).length, 1);
});

test('T26 Avisos_MarcadorIlegible_LoNombran @story-8.195 @ac-26 — un marcador roto no es «nada abierto»', () => {
  const C = casa();
  C.marcador('s-26', '{ roto');
  assert.match(F.stopLines({ sid: 's-26', home: C.home, stateDir: C.sdir, now: AHORA })[0], /no pude leer la ejecución de la sesión s-26 \(/);
  const m = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA });
  assert.match(m.lines.join('\n'), /no pude leer la ejecución de la sesión s-26/);
});

test('T19 Vida_TresRespuestas @story-8.195 @ac-19 — vive, murió o no se sabe; marker.js usa la misma regla', () => {
  const C = casa();
  C.sesion('aaaaaaaa-1', true);
  C.sesion('bbbbbbbb-2', false);
  assert.equal(L.liveness('aaaaaaaa-1', { home: C.home }).alive, true);
  const muerta = L.liveness('bbbbbbbb-2', { home: C.home });
  assert.equal(muerta.alive, false);
  assert.notEqual(muerta.sinRegistro, true);
  const sin = L.liveness('cccccccc-3', { home: C.home });
  assert.equal(sin.alive, false);
  assert.equal(sin.sinRegistro, true, 'sin registro: Codex no lo escribe');
  fs.writeFileSync(path.join(claudeDir(C.home), 'sessions', 'rota.json'), '{');
  assert.match(L.liveness('dddddddd-4', { home: C.home }).unknown, /rota\.json/);
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'marker.js'), 'utf8'), /require\('\.\/lib\/session-liveness\.js'\)/, 'marker.js usa la biblioteca');
});

test('T19c Arranque_CaminoCortoDeSesionMuerta_ClearOrphan @story-8.195 @ac-19 — el camino corto de una sesión que murió lleva adhoc clear-orphan', () => {
  const C = casa();
  const { adhoc } = repoConRama({ entro: true });
  C.carril('dddddddd-muerta', adhoc);
  C.sesion('dddddddd-muerta', false);
  const m = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]), markerJs: '/x/marker.js' });
  assert.match(m.lines.join('\n'), /camino corto «arreglo chico del aviso» \(sesión dddddddd\): tiene su rama ya en main y sigue abierto; su sesión ya no está: node \/x\/marker\.js adhoc clear-orphan dddddddd-muerta/);
});

test('T19d Arranque_IdRaroORutaConEspacios_ComandoSeguro @story-8.195 @ac-19 — un id que la consola expandiría no lleva comando; una ruta con espacios va entre comillas', () => {
  const C = casa();
  const raro = 'x$(touch pwn)';
  C.marcador(raro, terminada());
  C.marcador('-empieza', terminada());
  C.marcador('eeeeeeee-muerta', terminada());
  C.sesion('eeeeeeee-muerta', false);
  const out = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, markerJs: '/Mis Cosas/marker.js' }).lines.join('\n');
  assert.doesNotMatch(out, /clear-session .*\$\(/, 'el id raro no va en un comando');
  assert.doesNotMatch(out, /clear-session -empieza/, 'un id que empieza con guion no va en un comando');
  assert.match(out, /id de sesión raro: no doy comando/);
  assert.match(out, /node '\/Mis Cosas\/marker\.js' clear-session eeeeeeee-muerta/);
});

test('T19f Avisos_MotivoDeFallaConControles_SaleLimpio @story-8.195 @ac-19 @ac-26 — el motivo de una falla que viene de disco no lleva caracteres de control; una base que no es un sha no llega a git', () => {
  const C = casa();
  // el mensaje de JSON.parse trae un trozo del archivo: una secuencia de la consola adentro del marcador roto
  C.marcador('s-19f', '{ "x": "\u001b]0;pwn\u0007' + 'a'.repeat(400));
  const propias = F.stopLines({ sid: 's-19f', home: C.home, stateDir: C.sdir, now: AHORA }).join('\n');
  assert.match(propias, /no pude leer la ejecución de la sesión s-19f \(/);
  assert.doesNotMatch(propias, /[\u0000-\u001f\u007f-\u009f]/, 'sin caracteres de control');
  assert.doesNotMatch(F.machine({ home: C.home, stateDir: C.sdir, now: AHORA }).lines.join('\n'), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  // una base que git leería como opción: no se afirma que entró y no es una falla
  const { repo, adhoc } = repoConRama({ entro: true });
  C.carril('s-19g', { ...adhoc, bases: { [repo]: { sha: '--output=/tmp/x' } } });
  assert.deepEqual(F.stopLines({ sid: 's-19g', home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]) }), []);
});

test('T26b Avisos_LoQueNoSePudoMedir_SeDice @story-8.195 @ac-26 — carpeta del carril que ya no está, carpeta de estado ilegible y ejecución perdida sin poder mirar: se dicen, no son «nada abierto»', () => {
  const C = casa();
  const { repo, adhoc } = repoConRama();
  C.carril('s-26b', adhoc);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.match(F.stopLines({ sid: 's-26b', home: C.home, stateDir: C.sdir, now: AHORA })[0], /no pude ver si el pedido del camino corto está abierto \(la carpeta .* ya no está\)/);
  // la carpeta de las ejecuciones que no se puede leer
  const activos = path.join(C.sdir, 'active');
  fs.chmodSync(activos, 0o000);
  try {
    if (process.getuid && process.getuid() !== 0) assert.match(F.machine({ home: C.home, stateDir: C.sdir, now: AHORA }).lines.join('\n'), /no pude leer las ejecuciones de la máquina \(/);
  } finally { fs.chmodSync(activos, 0o755); }
  // si no se puede mirar si está perdida, no da el comando de cierre
  const pre = require('../lib/open-runs.js');
  const original = pre.perdida;
  pre.perdida = () => { throw new Error('copias ilegibles'); };
  try {
    C.marcador('ffffffff-x', terminada());
    C.sesion('ffffffff-x', false);
    const out = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA }).lines.join('\n');
    assert.match(out, /no pude ver si su ejecución está perdida \(copias ilegibles\): no doy comando/);
    assert.doesNotMatch(out, /clear-session ffffffff-x/);
  } finally { pre.perdida = original; }
});

test('T23b Foto_ConFalla_SeDiceEnWip @story-8.195 @ac-23 @ac-25 — la falla guardada en la foto vuelve como falla; sin foto, nada', () => {
  const C = casa();
  const { repo, adhoc } = repoConRama();
  assert.equal(F.adhocFromPhoto(adhoc, { home: C.home, stateDir: C.sdir, now: AHORA }), null, 'sin foto: como hoy');
  fs.writeFileSync(path.join(C.sdir, 'finished-open-prs.json'), JSON.stringify({ [`${repo}|fix/rapido`]: { at: AHORA - 60000, error: 'sin red' } }));
  assert.deepEqual(F.adhocFromPhoto(adhoc, { home: C.home, stateDir: C.sdir, now: AHORA }), { error: 'sin red' });
});

test('T18b CaminoCorto_RamaQueSoloTrajoMain_NoEntro @story-8.195 @ac-18 — una rama sin nada propio que sólo trajo main no «entró»; una que entró con su merge, sí', () => {
  const C = casa();
  const { repo, adhoc } = repoConRama();
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-C', repo, ...a], { encoding: 'utf8', env }).trim();
  // otra rama, sin nada propio, puesta al día con un main que avanzó
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'b.js'), '1\n');
  git('add', '.'); git('commit', '-qm', 'otro en main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'fix/solo-main', adhoc.bases[repo].sha);
  git('merge', '-q', '--ff-only', 'origin/main');
  C.carril('s-18b', adhoc);
  assert.deepEqual(F.stopLines({ sid: 's-18b', home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]) }), [], 'sólo trajo main: no entró');
  // la rama con su trabajo, entrada a main con un merge
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge del pedido', 'fix/rapido');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', 'fix/rapido');
  assert.match(F.stopLines({ sid: 's-18b', home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]) })[0], /tiene su rama ya en main/);
});

test('T25b Pedido_TopeRecortado_NoSeGuardaEnLaFoto @story-8.195 @ac-25 — con poco tiempo del tope compartido, la consulta no deja una falla en la foto', () => {
  const C = casa();
  const { adhoc } = repoConRama();
  // el gh de mentira tarda más que lo que queda del tope compartido
  const lento = path.join(C.home, 'gh-lento.js');
  fs.writeFileSync(lento, `#!/usr/bin/env node\nsetTimeout(() => require(${JSON.stringify(FAKE_GH)}), 800);\n`, { mode: 0o755 });
  const env = { ...ghCon([{ number: 7, state: 'open', head: { ref: 'fix/rapido' }, base: { ref: 'main' }, title: 'x', user: { login: 'a' } }]), TYCON_GH_CMD: lento };
  const ctx = { foto: {}, now: AHORA, env, until: Date.now() + 300, cambio: false };
  const r = F.adhocState(adhoc, ctx);
  assert.ok(r && r.error && r.sinTiempo, JSON.stringify(r));
  assert.deepEqual(ctx.foto, {}, 'nada a la foto: el próximo pregunta con su tope entero');
});

test('T19e Vida_RegistroRotoDeOtra_NoCambiaLaRespuesta @story-8.195 @ac-19 — un registro roto de otra sesión no tapa el registro vivo, se llame como se llame', () => {
  for (const roto of ['a.json', 'z.json']) {
    const C = casa();
    C.sesion('mmmmmmmm-viva', true);
    fs.writeFileSync(path.join(claudeDir(C.home), 'sessions', roto), '{rot');
    assert.equal(L.liveness('mmmmmmmm-viva', { home: C.home }).alive, true, roto);
    assert.match(String(L.liveness('nnnnnnnn-otra', { home: C.home }).unknown), /\{rot|JSON|Unexpected|Expected/, `${roto}: sin el suyo, «no se sabe»`);
  }
});

test('T29 BorradoAutomatico_MarcadorViejo_SinCambios @story-8.195 @ac-29 — un marcador terminado de 25 h lo borra pruneStale como hoy', () => {
  const C = casa();
  const viejo = new Date(Date.now() - 25 * 3600000).toISOString();
  C.marcador('s-29', terminada({ lastTouch: viejo, startedAt: viejo }));
  const f = path.join(C.sdir, 'active', 's-29.json');
  const t = new Date(Date.now() - 25 * 3600000);
  fs.utimesSync(f, t, t);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'list-all'], {
    encoding: 'utf8', env: { ...process.env, HOME: C.home, USERPROFILE: C.home, CLAUDE_CODE_SESSION_ID: 's-otra', TYCON_HOME: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f), false, 'pruneStale lo borró como hoy');
});

test('T30 Arranque_MuchosCaminosCortosViejos_NoPasaDelTope — los de sesiones que ya no están, sin tocar hace más de 7 días, se cuentan sin mirar sus repos y el aviso no pasa del tope', () => {
  const C = casa();
  const { repo, adhoc } = repoConRama();
  // cada carril anota archivos que ya no están: mirarlo en detalle pregunta a git por cada uno
  const rutas = ['x1.js', 'x2.js', 'x3.js'].map((f) => path.join(repo, f));
  const viejo = { ...adhoc, rutas, declaredAt: HACE(9 * 1440), lastTouch: HACE(8 * 1440) };
  const N = 80;
  const sids = [];
  for (let i = 0; i < N; i += 1) {
    const sid = `${String(i).padStart(8, '0')}-viejo`;
    sids.push(sid);
    C.carril(sid, viejo);
    // la mitad murió con registro; la otra mitad no dejó registro (como Codex)
    if (i % 2) C.sesion(sid, false);
  }
  // uno viejo pero con la sesión viva sí se mira
  C.carril('vvvvvvvv-viva', viejo);
  C.sesion('vvvvvvvv-viva', true);
  const t0 = Date.now();
  const m = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]), markerJs: '/x/marker.js' });
  const ms = Date.now() - t0;
  assert.ok(ms < F.TOPE_MS, `el aviso tardó ${ms} ms: pasa del tope de ${F.TOPE_MS} ms`);
  const out = m.lines.join('\n');
  const lista = path.join(C.sdir, 'finished-open-viejos.txt');
  assert.match(out, new RegExp(`${N} caminos cortos de sesiones que ya no están, sin tocar hace más de 7 días \\(no los miro uno por uno\\): xargs -n1 node /x/marker\\.js adhoc clear-orphan < ${lista.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(fs.readFileSync(lista, 'utf8').trim().split('\n'), sids);
  assert.doesNotMatch(out, /no medido/, 'todo se miró o se contó');
  assert.doesNotMatch(fs.readFileSync(lista, 'utf8'), /vvvvvvvv-viva/, 'el de la sesión viva no se cuenta como viejo');
  // uno solo lleva su comando directo
  const D = casa();
  D.carril('11111111-viejo', viejo);
  assert.match(F.machine({ home: D.home, stateDir: D.sdir, now: AHORA, env: ghCon([]), markerJs: '/x/marker.js' }).lines.join('\n'),
    /1 camino corto de sesiones que ya no están, sin tocar hace más de 7 días \(no los miro uno por uno\): node \/x\/marker\.js adhoc clear-orphan 11111111-viejo/);
});

test('T31 Arranque_SeAcaboElTope_DiceLoNoMedido — lo que no se llegó a mirar se cuenta como no medido, nunca se calla como «nada abierto»', () => {
  const C = casa();
  const { adhoc } = repoConRama({ entro: true });
  for (let i = 0; i < 4; i += 1) C.carril(`${i}0000000-fresco`, adhoc);
  C.marcador('s-31', terminada());
  const sinTiempo = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]), markerJs: '/x/marker.js', topeMs: 0 });
  assert.deepEqual(sinTiempo.lines, ['no medido: 4 caminos cortos y 1 ejecución (se acabó el tope de 0 s)']);
  assert.equal(sinTiempo.items.at(-1).tipo, 'sin-medir');
  // con el tope entero se miran todos
  const conTiempo = F.machine({ home: C.home, stateDir: C.sdir, now: AHORA, env: ghCon([]), markerJs: '/x/marker.js' });
  assert.doesNotMatch(conTiempo.lines.join('\n'), /no medido/);
  assert.equal(conTiempo.items.filter((i) => i.tipo === 'camino-corto').length, 4);
});
