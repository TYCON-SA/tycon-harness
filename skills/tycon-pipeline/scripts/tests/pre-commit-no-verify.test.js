'use strict';
/**
 * pre-commit-no-verify.test.js — el freno del commit anota en bypass.log el commit que saltea los hooks, también con
 * la opción abreviada que git acepta (`--no-veri`, `--no-verif`).
 *
 * Corre el hook DE VERDAD con una HOME temporal y busca la línea `GIT_NO_VERIFY` en su bypass.log. `--no-ver` y más
 * cortos chocan con `--no-verbose` (git los rechaza), y `--no-edit` es otra opción: no dejan línea.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'on-pre-commit.js');
const OPCION = ['--no', 'verify'].join('-');

function lineasDelRegistro(home) {
  const out = [];
  const ver = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) ver(p);
      else if (e.name === 'bypass.log') out.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    }
  };
  ver(home);
  return out;
}

function correr(t, command) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-no-verify-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, stdio: 'ignore' });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.GIT_INDEX_FILE;
  spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'no-verify-test', cwd: repo, tool_name: 'Bash', tool_input: { command } }),
  });
  return lineasDelRegistro(home).filter((l) => l.type === 'GIT_NO_VERIFY');
}

// T6 PreCommitAnotaLaAbreviada @story-4.12 @ac-2
// 🔴 Falla con: anotar sólo la opción entera (`/--no-verify\b/`): la abreviada saltea los hooks sin rastro.
test('T6 PreCommitAnotaLaAbreviada @story-4.12 @ac-2', (t) => {
  // stable-data: los `git commit …` de esta prueba son el texto del evento que lee el freno; no se corre ningún commit
  for (const op of [OPCION, OPCION.slice(0, -1), OPCION.slice(0, -2)]) {
    assert.strictEqual(correr(t, `git commit ${op} -m a`).length, 1, op);
  }
  for (const op of [OPCION.slice(0, -3), '--no-edit']) {
    assert.strictEqual(correr(t, `git commit ${op} -m a`).length, 0, op);
  }
  // la abreviada al final del comando, o pegada a un `;`, también
  assert.strictEqual(correr(t, `git commit -m a ${OPCION.slice(0, -1)}`).length, 1);
  assert.strictEqual(correr(t, `git commit -m a ${OPCION.slice(0, -2)}; ls`).length, 1);
});
