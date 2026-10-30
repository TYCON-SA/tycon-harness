#!/usr/bin/env node
/**
 * empty-work-gate.test.js — una vuelta de revisores no se lanza sobre una carpeta sin trabajo.
 *
 * Si la carpeta de la story no tiene ningún cambio contra la rama principal (ni commits propios ni cambios sin
 * commitear), los revisores leen la principal y dicen «no está el código»: la vuelta se pierde. Pasa cuando algo
 * aparta los cambios mientras corre la vuelta (un `git stash` de fondo). `advisors` y `smart-reloop` frenan y lo dicen.
 *
 *   T1  advisors, rama de la story igual a main   → frena (exit 2)
 *   T2  smart-reloop, rama igual a main           → frena (exit 2)
 *   T3  un cambio sin commitear                    → sigue
 *   T4  un commit propio sobre main                → sigue
 *   T5  repo sin rama principal conocida           → sigue (no puede afirmar que está vacía)
 *   T6  parada en la propia main                   → sigue (el trabajo pudo commitearse ahí)
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/empty-work-gate.test.js < /dev/null
 */
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');
const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const FECHA = '2026-01-01T10:00:00';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA };
function git(repo, ...a) {
  return spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a],
    { encoding: 'utf8', env: GIT_ENV });
}

/** Un repo con la story y el código commiteados en `branch`; la carpeta queda igual a esa rama. */
function repoLimpio(branch = 'main') {
  const r = tmp('ewg-');
  git(r, 'init', '-q', '-b', branch);
  fs.mkdirSync(path.join(r, 'src'));
  fs.writeFileSync(path.join(r, 'src', 'a.cs'), '// a\n');
  fs.writeFileSync(path.join(r, 'story.md'), [
    '---', 'story: 9.3.1', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', '',
  ].join('\n'));
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'base');
  return r;
}

/** La carpeta de la story: una rama nueva desde main, sin commits ni cambios. */
function ramaSinTrabajo() {
  const r = repoLimpio();
  git(r, 'checkout', '-q', '-b', 'story');
  return r;
}

const HOME = tmp('ewg-home-');
// el arnés es el árbol de esta prueba: con la HOME vacía, sin decírselo el set de revisores no sabe qué paquetes activa
const RAIZ = path.join(__dirname, '..', '..', '..', '..');
function run(cmd, repo, extra = []) {
  return spawnSync(process.execPath,
    [PIPELINE, cmd, '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/a.cs', ...extra],
    { encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, TYCON_GUIDES_DIR: RAIZ, CLAUDE_CODE_SESSION_ID: 'ewg-sin-marcador' } });
}

test('T1 Advisors_FolderEqualsMain_Blocks', () => {
  const r = run('advisors', ramaSinTrabajo());
  assert.equal(r.status, 2, `esperaba exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /ningún cambio contra main/);
  assert.equal(r.stdout.trim(), '', 'no devuelve el set');
});

test('T2 SmartReloop_FolderEqualsMain_Blocks', () => {
  const r = run('smart-reloop', ramaSinTrabajo(), ['--iter', '2']);
  assert.equal(r.status, 2, `esperaba exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /ningún cambio contra main/);
});

test('T3 Advisors_UncommittedChange_Continues', () => {
  const repo = ramaSinTrabajo();
  fs.writeFileSync(path.join(repo, 'src', 'a.cs'), '// a cambiado\n');
  const r = run('advisors', repo);
  assert.doesNotMatch(r.stderr, /ningún cambio contra/);
  assert.equal(r.status, 0, r.stderr);
});

test('T4 Advisors_OwnCommitOverMain_Continues', () => {
  const repo = repoLimpio();
  git(repo, 'checkout', '-q', '-b', 'story');
  fs.writeFileSync(path.join(repo, 'src', 'a.cs'), '// a cambiado\n');
  git(repo, 'commit', '-q', '-am', 'trabajo');
  const r = run('advisors', repo);
  assert.doesNotMatch(r.stderr, /ningún cambio contra/);
  assert.equal(r.status, 0, r.stderr);
});

test('T5 Advisors_NoMainBranch_Continues', () => {
  const repo = repoLimpio('trunk');
  git(repo, 'checkout', '-q', '-b', 'story');
  const r = run('advisors', repo);
  assert.doesNotMatch(r.stderr, /ningún cambio contra/);
  assert.equal(r.status, 0, r.stderr);
});

test('T6 Advisors_OnMainItself_Continues', () => {
  const r = run('advisors', repoLimpio());
  assert.doesNotMatch(r.stderr, /ningún cambio contra/);
  assert.equal(r.status, 0, r.stderr);
});
