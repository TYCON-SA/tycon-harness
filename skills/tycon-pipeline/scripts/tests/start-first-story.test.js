'use strict';

/**
 * start-first-story.test.js — el arranque del recorrido con la historia de primera vez.
 *
 * Lo que no se puede perder:
 *   - La historia que escribió el guion del modo primera vez (marca `origin: first-time` + su constancia) arranca sola:
 *     sin git hace `git init`, en main/master crea `story/<n>`; si la rama ya existe, pausa.
 *   - Sin la marca, o con la marca escrita a mano, la pausa de rama protegida queda como siempre: en un checkout que
 *     comparten varias sesiones, cambiar de rama solo rompe el trabajo de la otra.
 *
 * Todo corre con un HOME de laboratorio (el arnés de la máquina no se toca) y repos de juguete con git sin hooks.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const GUION = path.join(RAIZ, 'skills', 'tycon-create-story', 'scripts', 'story-without-bmad.js');
const SID = 'lab-primera-historia-851';

// Cada carpeta en su propia carpeta de arriba: los repos de las pruebas no son hermanos entre sí (la skill de historias
// mira los repos de al lado antes de decir que un producto empieza de cero).
const tmp = (p) => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `primera-${p}-`)), p);
  fs.mkdirSync(d);
  return d;
};

function laboratorio() {
  const home = tmp('home');
  // `start` llama a marker.js por ~/.claude/agent-skills: el de este árbol (no el de la máquina)
  const skills = path.join(home, '.claude', 'agent-skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(RAIZ, skills, 'junction');
  return home;
}

function entorno(home) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_AUTO_SNAPSHOT: '0',
    TYCON_PACKS_DEFAULT: 'none', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });
  return env;
}

const git = (home, dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args],
  { env: entorno(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repoConCommit(home, rama) {
  const d = tmp('repo');
  git(home, d, 'init', '-q', '-b', rama);
  fs.writeFileSync(path.join(d, 'README.md'), '# acme\n');
  git(home, d, 'add', 'README.md');
  git(home, d, 'commit', '-q', '-m', 'inicio');
  return d;
}

/** La historia como la escribe el modo primera vez: por el guion, que deja su constancia en este HOME. */
function historiaDelGuion(home, dir) {
  const answers = path.join(tmp('respuestas'), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({
    title: 'El total del carrito suma el envío', asA: 'quien compra', iWant: 'ver el total con envío', soThat: 'no tener sorpresas',
    criteria: [{ given: 'un carrito con envío', when: 'abro el resumen', then: 'el total incluye el envío' }],
    tests: [{ name: 'Total_ConEnvio', criterion: 1, level: 'unit', scenario: 'envío de 500', expected: 'total + 500' }],
    verify: ['npm test'],   // sin cómo se corren las pruebas el guion no escribe
  }));
  const r = spawnSync(process.execPath, [GUION, 'write', '--repo', dir, '--answers', answers], { env: entorno(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).path;
}

/** Una historia escrita a mano, con o sin la marca: sin constancia del guion. */
function historiaAMano(dir, { marca }) {
  fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
  const f = path.join(dir, 'stories', 'story-1.1-a-mano.md');
  fs.writeFileSync(f, ['---', 'epic: 1', 'story: "1.1"', 'title: "a mano"', 'status: ready-for-dev', ...(marca ? ['origin: first-time'] : []),
    '---', '', '# Story 1.1: a mano', '', '### Tests (1 verificaciones)', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `X` | 1 |', ''].join('\n'));
  return f;
}

function start(home, story, repo) {
  const r = spawnSync(process.execPath, [PIPELINE, 'start', '--story', story, '--repo', repo], { env: entorno(home), encoding: 'utf8', cwd: repo });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  assert.ok(json, `start no devolvió JSON: ${r.stdout}${r.stderr}`);
  return json;
}

const ramaActual = (home, dir) => git(home, dir, 'symbolic-ref', '--short', 'HEAD');
const ramas = (home, dir) => git(home, dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

test('T10 Start_SinGit_InitYRama: sin git, git init y la rama story/1.1, listo y dicho', () => {
  const home = laboratorio();
  const d = tmp('sin-git');
  const story = historiaDelGuion(home, d);
  const r = start(home, story, d);
  assert.strictEqual(r.ready, true, JSON.stringify(r.pauses));
  assert.ok(fs.existsSync(path.join(d, '.git')), 'tenía que hacer git init');
  assert.strictEqual(ramaActual(home, d), 'story/1.1');
  const linea = r.actions_done.find((a) => a.startsWith('PIPE-C1'));
  assert.ok(linea && /git init/.test(linea) && /story\/1\.1/.test(linea), JSON.stringify(r.actions_done));
});

for (const [t, rama] of [['T11', 'main'], ['T12', 'master']]) {
  test(`${t} Start_En${rama === 'main' ? 'Main' : 'Master'}_CreaRama: en ${rama}, crea story/1.1 y lo sin commitear sigue`, () => {
    const home = laboratorio();
    const d = repoConCommit(home, rama);
    const story = historiaDelGuion(home, d);
    fs.writeFileSync(path.join(d, 'pendiente.txt'), 'sin commitear\n');
    const r = start(home, story, d);
    assert.strictEqual(r.ready, true, JSON.stringify(r.pauses));
    assert.strictEqual(ramaActual(home, d), 'story/1.1');
    assert.ok(ramas(home, d).includes(rama), 'la rama de partida sigue');
    assert.strictEqual(fs.readFileSync(path.join(d, 'pendiente.txt'), 'utf8'), 'sin commitear\n');
    assert.ok(r.actions_done.some((a) => a.startsWith('PIPE-C1') && a.includes('story/1.1')), JSON.stringify(r.actions_done));
  });
}

test('T13 Start_RamaExiste_Pausa: con story/1.1 ya creada, pausa nombrándola y no cambia nada', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'main');
  git(home, d, 'branch', 'story/1.1');
  const story = historiaDelGuion(home, d);
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  const p = r.pauses.find((x) => x.id === 'PIPE-C1-branch-guard');
  assert.ok(p && p.detail.includes('story/1.1'), JSON.stringify(r.pauses));
  assert.strictEqual(ramaActual(home, d), 'main');
});

test('T14 Start_SinMarca_PausaComoHoy: sin la marca, en main pausa y no crea ninguna rama', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'main');
  const story = historiaAMano(d, { marca: false });
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  assert.ok(r.pauses.some((x) => x.id === 'PIPE-C1-branch-guard'), JSON.stringify(r.pauses));
  assert.strictEqual(ramaActual(home, d), 'main');
  assert.deepStrictEqual(ramas(home, d), ['main']);
});

test('T16 Start_MarcaAMano_NoCambiaRama: la marca escrita a mano no habilita ni la rama ni el git init', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'main');
  const story = historiaAMano(d, { marca: true });
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  const p = r.pauses.find((x) => x.id === 'PIPE-C1-branch-guard');
  assert.ok(p && /no la puso el guion/.test(p.detail), JSON.stringify(r.pauses));
  assert.deepStrictEqual(ramas(home, d), ['main']);

  // sin ningún git, la marca no hace falta: no hay rama de otra sesión que pisar (start-no-git.test.js)
  const sinGit = tmp('sin-git-a-mano');
  const story2 = historiaAMano(sinGit, { marca: true });
  const r2 = start(laboratorio(), story2, sinGit);
  assert.ok(fs.existsSync(path.join(sinGit, '.git')), 'sin git, el arranque lo inicia aunque la marca sea a mano');
  assert.strictEqual(r2.ready, true, JSON.stringify(r2.pauses));
});

test('T21 Start_RamaNoSePuedeCrear_Pausa: si git no puede crear la rama, pausa con su motivo y nada cambia', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'main');
  // Un archivo donde git necesita la carpeta de las ramas story/*: la rama no existe, pero no se puede crear.
  fs.writeFileSync(path.join(d, '.git', 'refs', 'heads', 'story'), 'ocupado\n');
  const story = historiaDelGuion(home, d);
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  const p = r.pauses.find((x) => x.id === 'PIPE-C1-branch-guard');
  assert.ok(p && /No pude preparar la rama story\/1\.1/.test(p.detail), JSON.stringify(r.pauses));
  assert.strictEqual(ramaActual(home, d), 'main');
});

test('T20 Start_AdentroDeOtroRepo_NoLoToca: una carpeta dentro de otro repo no es «sin git»; la rama del otro no se cambia', () => {
  const home = laboratorio();
  const padre = repoConCommit(home, 'main');
  const d = path.join(padre, 'app');
  fs.mkdirSync(d);
  const story = historiaDelGuion(home, d);
  const r = start(home, story, d);
  assert.ok(!fs.existsSync(path.join(d, '.git')), 'no hace git init adentro de otro repo');
  assert.strictEqual(ramaActual(home, padre), 'main');
  assert.deepStrictEqual(ramas(home, padre), ['main']);
  assert.strictEqual(r.ready, false);
  assert.ok(r.pauses.some((x) => x.id === 'PIPE-C1-branch-guard'), JSON.stringify(r.pauses));
});
