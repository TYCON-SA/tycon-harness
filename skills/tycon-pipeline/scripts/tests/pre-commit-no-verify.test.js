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

// T7 PreCommitAnotaSoloElArgumentoDeGit
// 🔴 Falla con: buscar la opción en todo el texto: un mensaje, un heredoc o un grep que sólo la nombran saltean el
// freno del commit y dejan una línea de bypass que no fue tal.
test('T7 PreCommitAnotaSoloElArgumentoDeGit', (t) => {
  // stable-data: los `git commit …` de esta prueba son el texto del evento que lee el freno; no se corre ningún commit
  for (const cmd of [`git commit -m "no usar ${OPCION}"`, `grep -n -- ${OPCION} f.md && git commit -m a`,
    `git commit -F - <<'X'\nno usar ${OPCION}\nX`, `git commit -m ${OPCION}`]) {
    assert.strictEqual(correr(t, cmd).length, 0, cmd);
  }
  for (const cmd of [`git commit "${OPCION}" -m a`, `bash -c "git commit ${OPCION} -m a"`, `git -C . commit -q ${OPCION} -m a`]) {
    assert.strictEqual(correr(t, cmd).length, 1, cmd);
  }
});

// T8 PreCommitLeeLasComillasYLasCortas
// 🔴 Falla con: cortar el comando en `;`, `|` o el salto de línea antes de mirar las comillas, no leer `$'…'`, `-n` ni
// las opciones con valor abreviadas: un salteo real queda sin línea, o una mención cuenta como salteo.
test('T8 PreCommitLeeLasComillasYLasCortas', (t) => {
  // stable-data: los `git commit …` de esta prueba son el texto del evento que lee el freno; no se corre ningún commit
  for (const cmd of [`git commit -m "a; b" ${OPCION}`, `git commit -m "a | b" ${OPCION}`, `git commit -m "a\nb" ${OPCION}`,
    `git commit $'${OPCION}' -m a`, `git commit --trailer x ${OPCION}`, `git commit -am ${OPCION.slice(0, 2)} ${OPCION}`]) {
    assert.strictEqual(correr(t, cmd).length, 1, cmd);
  }
  // `-n` y sus grupos no cuentan como salteo: el control del commit corre igual, como antes
  for (const cmd of ['git commit -n -m x', 'git commit -an -m x', `git commit --trailer ${OPCION} -m a`, `git commit --mess ${OPCION}`,
    `git commit -m${OPCION}`, `git commit -am ${OPCION}`, `echo "x; git commit ${OPCION}"`]) {
    assert.strictEqual(correr(t, cmd).length, 0, cmd);
  }
});
