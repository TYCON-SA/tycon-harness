'use strict';
/**
 * pre-commit-chained-add.test.js — `git add X && git commit` en una sola línea.
 *
 * El freno del commit corre ANTES que el comando entero: con `git add X && git commit` vería la versión
 * vieja de X stageada y rebotaría por algo que el mismo comando ya arregla (y al revés: miraría una
 * versión sana y dejaría pasar la rota que trae el `add`). Por eso, si lo que precede al commit son `git add`
 * simples, el freno evalúa una COPIA del índice con esos `add` aplicados (lib/chained-add.js); si no, mira
 * lo stageado hoy y, al frenar, dice que corra el `add` aparte.
 *
 * Corre el hook DE VERDAD sobre un repo y una HOME temporales. La story del caso declara E2E (pide
 * evidencia) y no tiene ninguna: lo único que la deja pasar es `dod_runtime_exempt: true`.
 *
 * Un freno que mirara sólo lo stageado hoy daría 2 en el caso 1 y 0 en el caso 3.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const { addsBeforeCommit } = require(path.join(SCRIPTS, 'lib', 'chained-add.js'));
const { isGitCommit } = require(HOOK);

const STORY = 'specs/stories/9-9-fixture.md';
function story(status, exenta) {
  return [
    '---', 'story: 9.9', `status: ${status}`,
    ...(exenta ? ['dod_runtime_exempt: true', 'dod_runtime_exempt_reason: "fixture sin superficie runtime"'] : []),
    '---', '', '# Story 9.9 — Fixture (pide E2E)', '', '## Acceptance Criteria', '',
    '1. **Given** algo, **Then** se ve otra cosa.', '',
  ].join('\n');
}

/** `staged` y `disco`: si la versión stageada / la del disco está exenta. */
function armar(t, { staged, disco }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-chained-add-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(repo, STORY), story('ready-for-dev', false));
  fs.writeFileSync(path.join(repo, 'otro.txt'), 'uno\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, STORY), story('review', staged));
  git('add', STORY);
  fs.writeFileSync(path.join(repo, STORY), story('review', disco));
  fs.writeFileSync(path.join(repo, 'otro.txt'), 'dos\n');
  return { repo, home };
}

function correr({ repo, home }, command) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.GIT_INDEX_FILE;
  const antes = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' });
  const antesStory = execFileSync('git', ['show', `:${STORY}`], { cwd: repo, encoding: 'utf8' });
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'chained-add-test', cwd: repo, tool_name: 'Bash', tool_input: { command } }),
  });
  // El índice real no se toca nunca: ni la lista de lo stageado ni el contenido.
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }), antes, 'el freno cambió el índice real');
  assert.equal(execFileSync('git', ['show', `:${STORY}`], { cwd: repo, encoding: 'utf8' }), antesStory, 'el freno cambió lo stageado');
  return { code: r.status, err: r.stderr || '' };
}

test('0. control: sin add, la versión stageada (sin exención) frena como siempre', (t) => {
  const r = correr(armar(t, { staged: false, disco: true }), 'git commit -m "story a review"');
  assert.equal(r.code, 2, r.err);
});

test('1. `git add <story> && git commit`: se evalúa lo que quedaría stageado → el arreglo del add cuenta y pasa', (t) => {
  const r = correr(armar(t, { staged: false, disco: true }), `git add ${STORY} && git commit -m "story a review"`);
  assert.equal(r.code, 0, r.err);
});

test('2. un add de OTRO archivo no cambia la story: sigue frenando, y dice sobre qué evaluó', (t) => {
  const r = correr(armar(t, { staged: false, disco: true }), 'git add otro.txt && git commit -m "story a review"');
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /quedaría stageado después de los `git add`/);
});

test('3. el add trae una versión ROTA sobre una stageada sana: frena (antes pasaba)', (t) => {
  const r = correr(armar(t, { staged: true, disco: false }), `git add ${STORY} && git commit -m "story a review"`);
  assert.equal(r.code, 2, r.err);
});

test('4. con algo que no se puede reproducir antes del commit, mira lo stageado hoy y pide el add aparte', (t) => {
  const r = correr(armar(t, { staged: false, disco: true }), `touch otro.txt && git add ${STORY} && git commit -m x`);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /corré el `git add` en una llamada aparte/);
});

test('5. un add que falla no tumba al freno: mira lo stageado hoy (sano) y pasa', (t) => {
  const r = correr(armar(t, { staged: true, disco: true }), 'git add no-existe.txt && git commit -m x');
  assert.equal(r.code, 0, r.err);
});

test('el analizador sólo simula `git add` simples encadenados con && o ;', () => {
  const p = (c) => addsBeforeCommit(c, isGitCommit);
  assert.deepEqual(p('git add a.md && git commit -m "x; y && z"'), { estado: 'simulable', adds: [['a.md']] });
  assert.deepEqual(p("git add 'a b.md' ; git add -A && git commit"), { estado: 'simulable', adds: [['a b.md'], ['-A']] });
  assert.equal(p('git commit -m "add"').estado, 'sin-add');
  assert.equal(p('git commit -m x && git add a').estado, 'sin-add');
  for (const c of [
    'sed -i s/a/b/ a && git add a && git commit',  // cambia el archivo entre medio
    'git add *.md && git commit',                   // comodín que expande el shell
    'git add $F && git commit',                     // variable
    'git add "$F" && git commit',                   // variable entre comillas dobles
    'git add a || git commit',                      // no encadena
    'git add a | git commit',
    'git add -p && git commit',                     // interactivo
    'git add -e a && git commit',                  // otra interactiva, fuera de la lista cerrada
    'git -C otro add a && git commit',              // otra carpeta
    'cd otro && git add a && git commit',
    'git add "a && git commit',                     // comilla sin cerrar
  ]) assert.equal(p(c).estado, 'no-simulable', c);
});
