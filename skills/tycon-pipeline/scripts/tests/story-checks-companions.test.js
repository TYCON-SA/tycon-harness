#!/usr/bin/env node
/**
 * story-checks-companions.test.js — dónde busca `mech-check` las pruebas de una story que vive en un repo y se prueba
 * en otro (el compañero de `.tycon/advisors.yaml → evidence.companion_repos`).
 *
 * Caso que cubre: desde el worktree de una story, la ruta declarada del compañero (`../<compañero>`) puede caer en un
 * checkout parado en la rama de otra tarea. El control leía las pruebas de esa rama: confirmaba una prueba que la
 * story no tiene, o negaba una que sí. Ahora usa la misma búsqueda que la evidencia (`lib/companion-repos.js`): el
 * worktree del compañero en la rama de la story, y si no hay, el declarado con su aviso.
 *
 * Cada prueba arma repos git efímeros y corre `pipeline.js mech-check` en un proceso aparte, con una HOME vacía, para
 * leer su salida y sus avisos por stderr (los avisos salen una vez por proceso).
 *
 * Correr: env -u NODE_TEST_CONTEXT node --test skills/tycon-pipeline/scripts/tests/story-checks-companions.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');

const STORY = [
  '---',
  'epic: 9',
  'story: "9.1"',
  'title: "una"',
  'status: in-progress',
  '---',
  '',
  '# Story 9.1: una',
  '',
  '## Acceptance Criteria',
  '',
  '1. **Given** algo **When** pasa **Then** se ve.',
  '',
  '### Tests',
  '',
  '| # | Test | AC | Nivel |',
  '|---|------|----|-------|',
  '| T7 | `CompaneroDeLaRama_LaPruebaExiste` | 1 | unit |',
  '',
].join('\n');
const PRUEBA = "test('CompaneroDeLaRama_LaPruebaExiste T7', () => {});\n";

function escribir(raiz, archivos) {
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), txt);
  }
}
function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'maintenance.auto=false', '-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  });
}
/** Un repo git con un commit, en la rama `rama`. */
function repoGit(dir, rama, archivos) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', rama);
  escribir(dir, { 'README.md': 'x\n', ...archivos });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return fs.realpathSync(dir);
}
const DECLARA_PUB = { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../Pub\n' };
function lab() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-companeros-'))); }

/** `mech-check` en un proceso aparte, con una HOME vacía: el JSON de salida y lo que dijo por stderr. */
function mechCheck(repo, story) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-companeros-casa-'));
  const r = spawnSync(process.execPath, [PIPELINE, 'mech-check', '--repo', repo, '--story', story], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LC_ALL: 'C' },
  });
  // sale 2 con un crítico (la prueba de la tabla que no encuentra), 0 sin críticos; cualquier otra cosa es una caída
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, out.findings.some((f) => f.severity === 'CRITICAL') ? 2 : 0, r.stderr);
  return { out, avisos: r.stderr };
}
const faltaLaPrueba = (out) => out.findings.some((f) => f.rule === 'ACCOV-C1');
const reales = (rutas) => (rutas || []).map((p) => fs.realpathSync(p));

test('T1 Companion_StoryBranchWorktree_WinsOverDeclared @story-8.148 @ac-1 — el worktree del compañero en la rama de la story gana', () => {
  // 🔴 mutación: con la ruta declarada tal cual, el control lee la rama ajena y da la prueba por implementada.
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const pub = repoGit(path.join(raiz, 'Pub'), 'otra', {});
  const pubR = path.join(raiz, 'Pub-r');
  git(pub, 'worktree', 'add', '-q', '-b', 'story/r', pubR);
  escribir(pub, { 'tests/una.test.js': PRUEBA });
  const story = path.join(priv, 'specs', 'story-9.1.md');

  const { out, avisos } = mechCheck(priv, story);
  assert.ok(faltaLaPrueba(out), JSON.stringify(out.findings));
  assert.deepEqual(reales(out.stats.companion_roots), [fs.realpathSync(pubR)]);
  assert.doesNotMatch(avisos, /\[hermanos\]/, avisos);

  escribir(pubR, { 'tests/una.test.js': PRUEBA });
  assert.ok(!faltaLaPrueba(mechCheck(priv, story).out));
});

test('T2 Companion_NoBranchWorktree_UsesDeclaredAndWarns @story-8.148 @ac-2 — sin worktree en la rama: el declarado, avisado', () => {
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const pub = repoGit(path.join(raiz, 'Pub'), 'otra', { 'tests/una.test.js': PRUEBA });

  const { out, avisos } = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(reales(out.stats.companion_roots), [pub]);
  assert.ok(!faltaLaPrueba(out), JSON.stringify(out.findings));
  assert.match(avisos, /se lee del checkout principal [^\n]*rama otra \(la story está en story\/r\)/, avisos);
});

test('T3 Companion_NotGit_UsedAsIsAndWarns @story-8.148 @ac-3 — un compañero que no es repo git: tal cual, avisado', () => {
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const pub = path.join(raiz, 'Pub');
  escribir(pub, { 'tests/una.test.js': PRUEBA });

  const { out, avisos } = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(reales(out.stats.companion_roots), [fs.realpathSync(pub)]);
  assert.ok(!faltaLaPrueba(out), JSON.stringify(out.findings));
  assert.match(avisos, /no es un repo git, uso la carpeta tal cual/, avisos);
});

test('T3b Companion_NoConfig_RepoOnly @story-8.148 @ac-3 — sin evidence: sólo el repo, sin aviso', () => {
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', { 'specs/story-9.1.md': STORY });
  repoGit(path.join(raiz, 'Pub'), 'otra', { 'tests/una.test.js': PRUEBA });

  const { out, avisos } = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(out.stats.companion_roots, []);
  assert.ok(faltaLaPrueba(out), JSON.stringify(out.findings));
  assert.doesNotMatch(avisos, /\[hermanos\]/, avisos);
});

test('T3c Companion_BrokenConfig_RepoOnlyNoThrow @story-8.148 @ac-3 — la configuración rota: sólo el repo, sin caerse', () => {
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', {
    'specs/story-9.1.md': STORY, '.tycon/advisors.yaml': 'evidence: [:::\n  companion_repos: {\n\t- ../Pub\n',
  });
  repoGit(path.join(raiz, 'Pub'), 'otra', { 'tests/una.test.js': PRUEBA });

  const { out } = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(out.stats.companion_roots, []);
  assert.ok(faltaLaPrueba(out), JSON.stringify(out.findings));
});

test('T3d Companion_DeclaredMissing_Warns @story-8.148 @ac-3 — un compañero declarado que no está en disco: avisado, en git y fuera de git', () => {
  const raiz = lab();
  const priv = repoGit(path.join(raiz, 'Priv'), 'story/r', { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const enGit = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(enGit.out.stats.companion_roots, []);
  assert.match(enGit.avisos, /«\.\.\/Pub»[^\n]*no está en disco: sus pruebas NO se leen/, enGit.avisos);

  const suelto = path.join(raiz, 'Suelto');
  escribir(suelto, { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const fuera = mechCheck(suelto, path.join(suelto, 'specs', 'story-9.1.md'));
  assert.deepEqual(fuera.out.stats.companion_roots, []);
  assert.match(fuera.avisos, /«\.\.\/Pub»[^\n]*no está en disco: sus pruebas NO se leen/, fuera.avisos);
});

test('T6 Companion_NoBranchNoNumber_SameRootsNoWarning @story-8.148 @ac-6 — la story fuera de un repo git: los compañeros de siempre, sin aviso', () => {
  // 🔴 mutación: con la búsqueda por rama también acá, el número de la story elige el worktree cuya rama lo nombra y lo avisa.
  const raiz = lab();
  const priv = path.join(raiz, 'Priv');
  escribir(priv, { 'specs/story-9.1.md': STORY, ...DECLARA_PUB });
  const pub = repoGit(path.join(raiz, 'Pub'), 'otra', { 'tests/una.test.js': PRUEBA });
  git(pub, 'worktree', 'add', '-q', '-b', 'feat/9.1-x', path.join(raiz, 'Pub-9-1'));

  const { out, avisos } = mechCheck(priv, path.join(priv, 'specs', 'story-9.1.md'));
  assert.deepEqual(reales(out.stats.companion_roots), [pub]);
  assert.equal(avisos, '');
});
