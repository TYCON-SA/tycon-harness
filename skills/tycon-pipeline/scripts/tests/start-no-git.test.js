'use strict';

/**
 * start-no-git.test.js — un repo sin git se inicia al arrancar el recorrido, y nada se saltea en silencio.
 *
 * Lo que no se puede perder:
 *   - Una carpeta sin ningún git arranca con `git init` y la rama `story/<n>`, aunque la historia no la haya escrito el
 *     modo primera vez. No en la carpeta personal, ni en la raíz, ni con la historia afuera: ahí pausa con el comando.
 *   - Con git y sin commits, el chequeo de dependencias y las líneas tocadas comparan contra el árbol vacío.
 *   - Lo que no se pudo medir llega a `write-findings` como `sin_medir`, con su motivo.
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
const SID = 'lab-sin-git-876';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sin-git-${p}-`)));

function laboratorio() {
  const home = tmp('home');
  // `start` llama a marker.js por ~/.claude/agent-skills: el de este árbol (no el de la máquina)
  const skills = path.join(home, '.claude', 'agent-skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(RAIZ, skills, 'junction');
  return home;
}

function entorno(home, extra = {}) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_AUTO_SNAPSHOT: '0',
    TYCON_PACKS_DEFAULT: 'none', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  }, extra);
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

/** Una historia escrita a mano, sin la marca del modo primera vez (como en el laboratorio del capítulo 2). */
function historia(dir, { status = 'ready-for-dev', texto = '' } = {}) {
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  const f = path.join(dir, 'specs', 'story-1-1.md');
  fs.writeFileSync(f, ['---', 'epic: 1', 'story: "1.1"', 'title: "enPesos"', `status: ${status}`, '---', '',
    '# Story 1.1: enPesos', '', texto, '', '### Tests (1 verificaciones)', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `X` | 1 |', ''].join('\n'));
  return f;
}

function correr(home, args, cwd, extra) {
  const r = spawnSync(process.execPath, [PIPELINE, ...args], { env: entorno(home, extra), encoding: 'utf8', cwd });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  assert.ok(json, `${args[0]} no devolvió JSON: ${r.stdout}${r.stderr}`);
  return json;
}
const start = (home, story, repo) => correr(home, ['start', '--story', story, '--repo', repo], repo);
const depGate = (home, story, repo) => correr(home, ['dep-gate', '--repo', repo, '--story', story], repo);

const tieneGit = (d) => fs.existsSync(path.join(d, '.git'));
const ramaActual = (home, dir) => git(home, dir, 'symbolic-ref', '--short', 'HEAD');
const ramas = (home, dir) => git(home, dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

function carpetaDeCorrida(repo) {
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).map((n) => path.join(base, n)) : [];
  return dirs.find((d) => fs.existsSync(path.join(d, 'dep-gate.json'))) || null;
}

test('8.76-SinGit_Start_IniciaYCreaRama @story-8.76 @ac-1 — sin git y sin marca: git init, story/1.1 y la línea en llano', () => {
  const home = laboratorio();
  const d = tmp('sin-git');
  const story = historia(d);
  fs.writeFileSync(path.join(d, 'precio.js'), 'module.exports = 1;\n');
  const r = start(home, story, d);
  assert.strictEqual(r.ready, true, JSON.stringify(r.pauses));
  assert.ok(tieneGit(d), 'tenía que hacer git init');
  assert.strictEqual(ramaActual(home, d), 'story/1.1');
  assert.strictEqual(r.branch, 'story/1.1');
  const linea = r.actions_done.find((a) => a.startsWith('PIPE-C1'));
  assert.ok(linea && /tu carpeta no tenía git/.test(linea) && /story\/1\.1/.test(linea), JSON.stringify(r.actions_done));
  assert.strictEqual(fs.readFileSync(path.join(d, 'precio.js'), 'utf8'), 'module.exports = 1;\n', 'lo que había sigue igual');
});

test('8.76-SinGit_AdentroDeOtroRepo_NoToca @story-8.76 @ac-2 — adentro de otro repo no hay git init ni cambio de rama', () => {
  const home = laboratorio();
  const padre = repoConCommit(home, 'main');
  const d = path.join(padre, 'app');
  fs.mkdirSync(d);
  const story = historia(d);
  start(home, story, d);
  assert.ok(!tieneGit(d), 'no hace git init adentro de otro repo');
  assert.strictEqual(ramaActual(home, padre), 'main');
  assert.deepStrictEqual(ramas(home, padre), ['main']);
});

test('8.76-SinGit_CarpetaPersonalORaizOHistoriaAfuera_PausaSinInit @story-8.76 @ac-2 — pausa con el comando a mano', () => {
  // la carpeta personal
  const home = laboratorio();
  const enCasa = historia(home);
  const r = start(home, enCasa, home);
  assert.strictEqual(r.ready, false);
  const p = r.pauses.find((x) => x.id === 'PIPE-C1-sin-git');
  assert.ok(p && /carpeta personal/.test(p.detail) && /git -C .* init/.test(p.detail), JSON.stringify(r.pauses));
  assert.ok(!tieneGit(home), 'en la carpeta personal no hace git init');

  // la historia vive fuera de la carpeta del recorrido
  const home2 = laboratorio();
  const d = tmp('sin-git-afuera');
  const otra = tmp('otra');
  const story = historia(otra);
  const r2 = start(home2, story, d);
  assert.strictEqual(r2.ready, false);
  const p2 = r2.pauses.find((x) => x.id === 'PIPE-C1-sin-git');
  assert.ok(p2 && /fuera/.test(p2.detail), JSON.stringify(r2.pauses));
  assert.ok(!tieneGit(d) && !tieneGit(otra));
});

test('8.76-SinGit_ConPausa_NoInicia @story-8.76 @ac-3 — con otra pausa del arranque no se inicia nada', () => {
  const home = laboratorio();
  const d = tmp('sin-git-pausa');
  const story = historia(d, { status: 'in-progress' });   // historia abandonada: pausa PIPE-C5
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  assert.ok(r.pauses.some((x) => x.id === 'PIPE-C5-abandoned'), JSON.stringify(r.pauses));
  assert.ok(!tieneGit(d), 'con una pausa no hace git init');
});

test('8.76-RepoEnMain_SinMarca_SigueFrenando @story-8.76 @ac-4 — un repo que existe, en main, sin marca: pausa y no cambia de rama', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'main');
  const story = historia(d);
  const r = start(home, story, d);
  assert.strictEqual(r.ready, false);
  assert.ok(r.pauses.some((x) => x.id === 'PIPE-C1-branch-guard'), JSON.stringify(r.pauses));
  assert.strictEqual(ramaActual(home, d), 'main');
  assert.deepStrictEqual(ramas(home, d), ['main']);
});

test('8.76-GitInitFalla_PausaConError @story-8.76 @ac-5 — si git init falla, pausa con el error y el comando a mano', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = laboratorio();
  const d = tmp('sin-permiso');
  const story = historia(d);
  fs.chmodSync(d, 0o555);
  try {
    const r = start(home, story, d);
    assert.strictEqual(r.ready, false);
    const p = r.pauses.find((x) => /^PIPE-C1/.test(x.id) && /No pude preparar la rama story\/1\.1/.test(x.detail));
    assert.ok(p && /git -C .* init/.test(p.detail), JSON.stringify(r.pauses));
    assert.notStrictEqual(r.branch, 'story/1.1');
  } finally {
    fs.chmodSync(d, 0o755);
  }
});

test('8.76-DepGate_SinCommits_TodoNuevo @story-8.76 @ac-6 — sin commits, cada dependencia del package.json cuenta como nueva', () => {
  const home = laboratorio();
  const d = tmp('sin-commits');
  git(home, d, 'init', '-q', '-b', 'story/1.1');
  const story = historia(d, { texto: 'Usa left-pad para alinear.' });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: 'precios', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' }, devDependencies: { 'acme-sin-declarar': '^2.0.0' },
  }, null, 2));
  const r = depGate(home, story, d);
  assert.notStrictEqual(r.gate, 'skip', JSON.stringify(r));
  assert.deepStrictEqual(r.declared, ['left-pad']);
  assert.deepStrictEqual(r.undeclared, ['acme-sin-declarar']);
  assert.ok(!r.new_deps.includes('version') && !r.new_deps.includes('name'), JSON.stringify(r.new_deps));
  assert.strictEqual(r.gate, 'pause');
});

test('8.76-DepGate_ManifiestoNuevoSinTrackear_Cuenta @story-8.76 @ac-7 — un package.json nuevo sin trackear también cuenta', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'story/1.1');
  const story = historia(d);
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'package.json'), JSON.stringify({ dependencies: { 'acme-nueva': '1.0.0' } }));
  const r = depGate(home, story, d);
  assert.deepStrictEqual(r.new_deps, ['acme-nueva'], JSON.stringify(r));
  assert.strictEqual(r.gate, 'pause');
});

test('8.76-DepGate_NodeModulesSinGitignore_NoCuenta @story-8.76 @ac-6 @ac-7 — lo instalado no es del proyecto, aunque no haya .gitignore', () => {
  // sin .gitignore, node_modules/*/package.json pasaría sus dependencias como nuevas
  const home = laboratorio();
  const d = tmp('node-modules');
  git(home, d, 'init', '-q', '-b', 'story/1.1');
  const story = historia(d, { texto: 'Usa foo.' });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { foo: '^1.0.0' } }));
  for (const [p, deps] of [['node_modules/foo', { bar: '^1.0.0' }], ['node_modules/foo/node_modules/bar', { baz: '^1.0.0' }]]) {
    fs.mkdirSync(path.join(d, p), { recursive: true });
    fs.writeFileSync(path.join(d, p, 'package.json'), JSON.stringify({ name: path.basename(p), dependencies: deps }));
  }
  const r = depGate(home, story, d);
  assert.deepStrictEqual(r.new_deps, ['foo'], JSON.stringify(r));
  assert.strictEqual(r.gate, 'pass');
});

test('8.76-DepGate_PackageJsonConBom_SeLee @story-8.76 @ac-6 @ac-7 — un package.json con BOM (común en Windows) se lee igual', () => {
  const home = laboratorio();
  const d = repoConCommit(home, 'story/1.1');
  const story = historia(d);
  fs.mkdirSync(path.join(d, 'app'));
  fs.writeFileSync(path.join(d, 'app', 'package.json'), `﻿${JSON.stringify({ dependencies: { zed: '^1.0.0' } })}`);
  const r = depGate(home, story, d);
  assert.deepStrictEqual(r.new_deps, ['zed'], JSON.stringify(r));
  assert.strictEqual(r.repos_no_medidos, undefined, JSON.stringify(r));
});

test('8.76-CoverageBase_SinCommits_ArbolVacio @story-8.76 @ac-8 — sin commits la base es el árbol vacío; con commit, HEAD', () => {
  const { resolver } = require('../lib/coverage-base.js');
  const home = laboratorio();
  const vacio = tmp('cov-vacio');
  git(home, vacio, 'init', '-q', '-b', 'story/1.1');
  const arbolVacio = execFileSync('git', ['-C', vacio, 'hash-object', '-t', 'tree', '--stdin'], { input: '', encoding: 'utf8' }).trim();
  const r = resolver({ repo: vacio, env: {} });
  assert.strictEqual(r.source, 'arbol-vacio', JSON.stringify(r));
  assert.strictEqual(r.ref, arbolVacio);

  const lleno = repoConCommit(home, 'main');
  const r2 = resolver({ repo: lleno, env: {} });
  assert.strictEqual(r2.source, 'HEAD');
  assert.strictEqual(r2.ref, git(home, lleno, 'rev-parse', 'HEAD'));
});

test('8.76-DepGate_SinGit_NoMedidoConConstancia @story-8.76 @ac-9 — sin git: no-medido con motivo, y la constancia en la corrida', () => {
  const home = laboratorio();
  const d = tmp('dep-sin-git');
  const story = historia(d);
  fs.writeFileSync(path.join(d, 'package.json'), '{"dependencies":{"acme":"1.0.0"}}');
  const r = depGate(home, story, d);
  assert.strictEqual(r.gate, 'no-medido', JSON.stringify(r));
  assert.ok(r.reason && /git/.test(r.reason));
  const corrida = carpetaDeCorrida(d);
  assert.ok(corrida, 'tenía que dejar dep-gate.json en la carpeta de la corrida');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(corrida, 'dep-gate.json'), 'utf8')).gate, 'no-medido');
});

function writeFindings(home, story, repo) {
  const r = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', story, '--repo', repo, '--findings', '-'],
    { env: entorno(home), encoding: 'utf8', cwd: repo, input: '[]' });
  return JSON.parse(r.stdout);
}

test('8.76-WriteFindings_SinMedir_LoDice @story-8.76 @ac-10 — el chequeo de dependencias y las líneas tocadas sin medir, dichos', () => {
  const home = laboratorio();
  const d = tmp('wf-sin-medir');
  const story = historia(d);
  depGate(home, story, d);   // sin git: deja dep-gate.json no-medido
  fs.writeFileSync(path.join(d, '.advisors', 'tests-result.json'), JSON.stringify({
    suite_exit: 0, coverage: { touched_lines_pct: null, touched_no_cross_check: 'sin cruce de líneas tocadas: el runner node-test no produce cobertura' },
  }));
  const r = writeFindings(home, story, d);
  assert.ok(Array.isArray(r.sin_medir), JSON.stringify(r));
  const que = r.sin_medir.map((x) => x.que).join(' | ');
  assert.match(que, /dependencias/);
  assert.match(que, /líneas tocadas/);
  assert.ok(r.sin_medir.every((x) => x.motivo), JSON.stringify(r.sin_medir));
  assert.ok(r.warnings.some((w) => /sin medir: .*dependencias/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /sin medir: .*líneas tocadas.*node-test/.test(w)), JSON.stringify(r.warnings));
});

test('8.76-WriteFindings_ConstanciaIlegible_SinMedir @story-8.76 @ac-10 — una constancia rota es sin medir; sin nada, no hay sin_medir', () => {
  const home = laboratorio();
  const d = tmp('wf-roto');
  const story = historia(d);
  depGate(home, story, d);
  const corrida = carpetaDeCorrida(d);
  fs.writeFileSync(path.join(corrida, 'dep-gate.json'), '{roto');
  const r = writeFindings(home, story, d);
  assert.ok(r.sin_medir && r.sin_medir.some((x) => /no pude leer .*dep-gate\.json/.test(x.motivo)), JSON.stringify(r));

  const home2 = laboratorio();
  const limpio = repoConCommit(home2, 'story/1.1');
  const story2 = historia(limpio);
  depGate(home2, story2, limpio);
  const r2 = writeFindings(home2, story2, limpio);
  assert.strictEqual(r2.sin_medir, undefined, JSON.stringify(r2));
});

test('8.76-CreateStory_DescripcionEnCastellano_YNotice @story-8.76 @ac-11 — la skill nombra los pedidos en castellano', () => {
  const dir = path.join(RAIZ, 'skills', 'tycon-create-story');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const descripcion = (/^description:\s*(.+)$/m.exec(skill) || [])[1] || '';
  for (const frase of ['creá una historia', 'escribí una historia', 'creá una story', 'armá la historia de']) {
    assert.ok(descripcion.includes(frase), `falta «${frase}» en la descripción: ${descripcion}`);
  }
  const notice = fs.readFileSync(path.join(dir, 'NOTICE.md'), 'utf8');
  assert.ok(!/\|\s*`SKILL\.md`\s*\|\s*Identical to the original/.test(notice), 'el NOTICE todavía dice que SKILL.md es idéntico');
  assert.ok(!/\|\s*`SKILL\.md`\s*\|\s*Idéntico al original/.test(notice), 'el NOTICE en castellano todavía dice que SKILL.md es idéntico');
});
