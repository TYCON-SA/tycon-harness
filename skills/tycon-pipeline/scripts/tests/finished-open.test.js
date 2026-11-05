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
  if (entro) {
    git(repo, 'push', '-q', 'origin', 'fix/rapido:main');
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
