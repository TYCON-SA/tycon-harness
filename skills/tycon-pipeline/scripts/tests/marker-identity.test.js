'use strict';

/**
 * marker-identity.test.js — el marcador no cambia de story en silencio.
 *
 * Lo que no se puede perder:
 *   - `pipeline.js start` frena si la story no trae `story:` en su frontmatter: no inventa el número con el nombre
 *     del archivo, ni con el frontmatter ausente ni con la clave `storyId:` en su lugar.
 *   - `marker.js set` con otro storyId, sobre una ejecución que ya avanzó, frena y no toca nada; con `--replace`
 *     reemplaza, deja una copia del marcador anterior y lo anota en gates.log. Sobre uno sin pasos hechos, reemplaza
 *     igual, con su copia.
 *   - `start` de otra story con la ejecución de esta sesión a medias pausa antes de escribir el marcador.
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
const MARKER = path.join(SCRIPTS, 'marker.js');
const SID = 'lab-identidad-del-marcador';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `identidad-${p}-`)));

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
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_AUTO_SNAPSHOT: '0',
    TYCON_PACKS_DEFAULT: 'none', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });
}

const git = (home, dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args],
  { env: entorno(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(home) {
  const d = tmp('repo');
  git(home, d, 'init', '-q', '-b', 'story/9.1');
  fs.writeFileSync(path.join(d, 'README.md'), '# acme\n');
  git(home, d, 'add', 'README.md');
  git(home, d, 'commit', '-q', '-m', 'inicio');
  fs.mkdirSync(path.join(d, 'specs'), { recursive: true });
  return d;
}

function historia(dir, nombre, cabecera) {
  const f = path.join(dir, 'specs', nombre);
  fs.writeFileSync(f, [...cabecera, '', '# Una historia', '', '### Tests (1 verificaciones)', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `X` | 1 |', ''].join('\n'));
  return f;
}

function start(home, story, dir) {
  const r = spawnSync(process.execPath, [PIPELINE, 'start', '--story', story, '--repo', dir], { env: entorno(home), encoding: 'utf8', cwd: dir });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  assert.ok(json, `start no devolvió JSON: ${r.stdout}${r.stderr}`);
  return json;
}

const marker = (home, ...args) => spawnSync(process.execPath, [MARKER, ...args], { env: entorno(home), encoding: 'utf8' });
const estado = (home) => path.join(home, '.claude', '.tycon-pipeline');
const leer = (home) => {
  const f = path.join(estado(home), 'active', `${SID}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const copias = (home) => {
  const d = path.join(estado(home), 'replaced');
  return fs.existsSync(d) ? fs.readdirSync(d).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'))) : [];
};

for (const [caso, cabecera] of [
  ['sin frontmatter', ['# sin cabecera']],
  ['con storyId en vez de story', ['---', 'epic: 9', 'storyId: "9.1"', 'status: ready-for-dev', '---']],
]) {
  test(`Start_StoryQueNoParsea_Frena (${caso}) — no usa el nombre del archivo como número`, () => {
    const home = laboratorio();
    const d = repo(home);
    const story = historia(d, 'story-9-1-algo.md', cabecera);
    const r = start(home, story, d);
    assert.strictEqual(r.ready, false, JSON.stringify(r));
    assert.match(JSON.stringify(r), /story:/, 'dice qué clave falta');
    assert.strictEqual(leer(home), null, 'no escribe el marcador');
  });
}

test('Set_OtraStoryConPasosHechos_Frena — no reinicia la ejecución en silencio', () => {
  const home = laboratorio();
  assert.strictEqual(marker(home, 'set', JSON.stringify({ storyId: '9.1', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] })).status, 0);
  const r = marker(home, 'set', JSON.stringify({ storyId: '9.2', stepScheme: 2, stepsPending: ['start', 'approve-plan'] }));
  assert.notStrictEqual(r.status, 0, 'tenía que frenar');
  assert.match(r.stderr, /9\.1/);
  assert.match(r.stderr, /9\.2/);
  assert.match(r.stderr, /--replace/);
  const m = leer(home);
  assert.strictEqual(m.storyId, '9.1', 'el marcador sigue siendo el de la 9.1');
  assert.deepStrictEqual(m.stepsCompleted, ['start', 'validate-story']);
  assert.strictEqual(copias(home).length, 0);
});

test('Set_OtraStoryConReplace_ReemplazaYDejaCopia — la copia trae la ejecución anterior y queda anotado', () => {
  const home = laboratorio();
  marker(home, 'set', JSON.stringify({ storyId: '9.1', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] }));
  const r = marker(home, 'set', JSON.stringify({ storyId: '9.2', stepScheme: 2, stepsPending: ['start', 'approve-plan'] }), '--replace');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = leer(home);
  assert.strictEqual(m.storyId, '9.2');
  assert.ok(!m.stepsCompleted || m.stepsCompleted.length === 0, 'la story nueva no hereda pasos');
  const c = copias(home);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].storyId, '9.1');
  assert.deepStrictEqual(c[0].stepsCompleted, ['start', 'validate-story']);
  const log = fs.readFileSync(path.join(estado(home), 'gates.log'), 'utf8');
  assert.match(log, /marker-replace/);
});

test('Set_OtraStoryConPasosHechos_OfreceRenumerar — el freno dice cómo conservar la ejecución', () => {
  const home = laboratorio();
  marker(home, 'set', JSON.stringify({ storyId: '9.1', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] }));
  const r = marker(home, 'set', JSON.stringify({ storyId: '9.7', stepScheme: 2, stepsPending: ['plan', 'approve-plan'] }));
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--renumber/);
});

test('Set_OtraStoryConRenumber_ConservaLaEjecucion — cambia el número, no los pasos ni los controles', () => {
  const home = laboratorio();
  marker(home, 'set', JSON.stringify({ storyId: '9.1', storyPath: '/x/specs/story-9.1.md', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] }));
  const antes = leer(home);
  // un control y una iteración de la corrida, escritos como los deja el arnés
  const f = path.join(estado(home), 'active', `${SID}.json`);
  fs.writeFileSync(f, JSON.stringify({ ...antes, checks: { build: 'green' }, iterations: { 1: { ts: 't', filesSnapshot: ['a'] } } }));
  const r = marker(home, 'set', JSON.stringify({ storyId: '9.7', storyPath: '/x/specs/story-9.7.md' }), '--renumber');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = leer(home);
  assert.strictEqual(m.storyId, '9.7');
  assert.strictEqual(m.storyPath, '/x/specs/story-9.7.md');
  assert.deepStrictEqual(m.stepsCompleted, ['start', 'validate-story'], 'conserva los pasos hechos');
  assert.deepStrictEqual(m.stepsPending, ['plan', 'approve-plan']);
  assert.deepStrictEqual(m.checks, { build: 'green' }, 'conserva los controles');
  assert.ok(m.iterations && m.iterations[1], 'conserva las iteraciones');
  assert.strictEqual(m.startedAt, antes.startedAt);
  assert.match(r.stderr, /9\.1/);
  assert.match(r.stderr, /9\.7/);
  const c = copias(home);
  assert.strictEqual(c.length, 1, 'deja la copia del marcador anterior');
  assert.strictEqual(c[0].storyId, '9.1');
  const log = fs.readFileSync(path.join(estado(home), 'gates.log'), 'utf8');
  assert.match(log, /marker-renumber/);
});

test('Set_OtraStorySinPasosHechos_ReemplazaConCopia — un marcador recién armado no frena', () => {
  const home = laboratorio();
  marker(home, 'set', JSON.stringify({ storyId: '9.1', stepScheme: 2, stepsPending: ['start', 'approve-plan'] }));
  const r = marker(home, 'set', JSON.stringify({ storyId: '9.2', stepScheme: 2, stepsPending: ['start', 'approve-plan'] }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(leer(home).storyId, '9.2');
  assert.strictEqual(copias(home).length, 1);
});

test('Start_OtraStoryConEjecucionAMedias_Pausa — antes de escribir el marcador', () => {
  const home = laboratorio();
  const d = repo(home);
  marker(home, 'set', JSON.stringify({ storyId: '9.1', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] }));
  const story = historia(d, 'story-9-2.md', ['---', 'epic: 9', 'story: "9.2"', 'status: ready-for-dev', '---']);
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false, JSON.stringify(r));
  const p = (r.pauses || []).find((x) => x.id === 'PIPE-C4-otra-ejecucion');
  assert.ok(p, JSON.stringify(r.pauses));
  assert.match(p.detail, /9\.1/);
  assert.strictEqual(leer(home).storyId, '9.1', 'el marcador no se tocó');
});
