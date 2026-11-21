#!/usr/bin/env node
'use strict';
/**
 * bash-write-unsaved-approval.test.js — la puerta de la consola no deja sacar una carpeta con una constancia de control
 * sin commitear.
 *
 * QUÉ CUIDA: una constancia firmada por el dueño (`.github/control-changes/`) vive sólo en la carpeta donde se firmó hasta
 * que se commitea. `git worktree remove` se niega por ella y sugiere `--force`; con eso, o con `rm -rf`, la firma se
 * pierde y hay que pedir otro click. La puerta frena y dice que se commitee antes; commiteada, el mismo comando pasa.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/bash-write-unsaved-approval.test.js < /dev/null
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));
const SID = 'sesion-96';

function laboratorio() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constancia-suelta-')));
  const estado = path.join(raiz, 'estado');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(repo);
  const FECHA = '2026-01-01T10:00:00';
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'inicio');
  const wt = path.join(raiz, 'repo-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt/x', wt);
  fs.mkdirSync(path.join(wt, '.github', 'control-changes'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.github', 'control-changes', 'abc.json'), '{"firma":"del dueño"}\n');
  return { raiz, estado, repo, wt, git };
}

const decidir = (lab, command) => {
  const antes = process.env.TYCON_NO_RUN_CHANGE;
  process.env.TYCON_NO_RUN_CHANGE = '1';
  try { return bash.handle({ tool_name: 'Bash', session_id: SID, cwd: lab.repo, tool_input: { command } }, { stateDir: lab.estado }); } finally {
    if (antes === undefined) delete process.env.TYCON_NO_RUN_CHANGE; else process.env.TYCON_NO_RUN_CHANGE = antes;
  }
};

test('T1 SacarWorktree_ConConstanciaSinCommitear_Frena — remove, remove --force y rm -rf de la carpeta', () => {
  const lab = laboratorio();
  for (const cmd of [`git worktree remove ${lab.wt}`, `git worktree remove --force ${lab.wt}`, `rm -rf ${lab.wt}`]) {
    const r = decidir(lab, cmd);
    assert.ok(r && r.block, `${cmd}: tiene que frenar`);
    assert.match(r.block, /CONSTANCIA SIN COMMITEAR/, r.block);
    assert.match(r.block, /\.github\/control-changes\/abc\.json/, r.block);
    assert.match(r.block, /Commiteala y empujala/, r.block);
  }
  assert.ok(fs.existsSync(path.join(lab.wt, '.github', 'control-changes', 'abc.json')), 'la constancia sigue ahí');
});

test('T2 SacarWorktree_ConLaConstanciaCommiteada_Pasa — y sin constancia tampoco frena', () => {
  const lab = laboratorio();
  lab.git(lab.wt, 'add', '-A');
  lab.git(lab.wt, 'commit', '-qm', 'la constancia');
  assert.ok(!(decidir(lab, `git worktree remove ${lab.wt}`) || {}).block, 'commiteada: pasa');
  // un worktree sin constancias sale como siempre
  const otro = laboratorio();
  fs.rmSync(path.join(otro.wt, '.github'), { recursive: true });
  assert.ok(!(decidir(otro, `git worktree remove --force ${otro.wt}`) || {}).block, 'sin constancia: pasa');
});
