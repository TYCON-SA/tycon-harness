'use strict';
/**
 * git-target-shell-c.test.js — los `git` dentro de un `bash -c '…'` se ven todos, cada uno en su carpeta.
 *
 * scripts/lib/git-target.js parte el comando por `&&`, `;` y `|`: el `bash -c '` quedaba pegado a la primera sentencia,
 * que así no empezaba con `git` ni con `cd`. El aviso de retrospectiva (scripts/hooks/retro-pending.js) veía sólo el
 * último `git push` de dos dentro de un `bash -c`, y con `cd` le daba al primero la carpeta equivocada. Lo usan también
 * el freno de sesiones y el de producción.
 *
 * Correr: node --test scripts/tests/git-target-shell-c.test.js < /dev/null
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'scripts', 'lib', 'git-target.js'));
const { sinHeredocs } = require(path.join(ROOT, 'scripts', 'lib', 'shell-parse.js'));
const PUSH = G.regexDeGit(G.VERBOS_QUE_PUBLICAN);
const BASE = path.resolve('/base');
const carpetas = (cmd) => G.destinos(sinHeredocs(cmd, { salvoShell: true }), BASE, PUSH, { envoltorios: true }).map((d) => d.dir);

test('T1 BashC_DosPush_SeVenLosDos — con -C y con cd, en bash, sh y zsh', () => {
  const a = path.resolve('/r/a');
  const b = path.resolve('/r/b');
  assert.deepStrictEqual(carpetas("bash -c 'git -C /r/a push origin main && git -C /r/b push origin main'"), [a, b]);
  assert.deepStrictEqual(carpetas("bash -c 'cd /r/a && git push origin main; cd /r/b && git push origin main'"), [a, b]);
  assert.deepStrictEqual(carpetas('sh -c "git -C /r/a push origin main && git -C /r/b push origin main"'), [a, b]);
  assert.deepStrictEqual(carpetas("/bin/zsh -lc 'git -C /r/a push origin main && git -C /r/b push origin main'"), [a, b]);
});

// lo que encontró el pase adversarial: un subshell adentro del bash -c, y un cd de adentro que no es la carpeta de afuera
test('T1b BashC_SubshellAdentro_Y_CdQueNoSale', () => {
  assert.deepStrictEqual(carpetas('bash -c "(cd /x && git push origin main)"'), [path.resolve('/x')]);
  assert.deepStrictEqual(carpetas("bash -c 'cd /a'; git push origin main"), [BASE], 'el cd de adentro no cambia la carpeta de afuera');
  assert.deepStrictEqual(carpetas("bash -c 'cd /a && git status' && git push origin main"), [BASE]);
  assert.deepStrictEqual(carpetas("bash -c 'cd /a && git push origin main' && git push origin main"), [path.resolve('/a'), BASE]);
});

test('T2 SinBashC_ComoAntes — la misma cadena sin envoltorio, y un bash que no es -c', () => {
  assert.deepStrictEqual(carpetas('git -C /r/a push origin main && git -C /r/b push origin main'), [path.resolve('/r/a'), path.resolve('/r/b')]);
  assert.deepStrictEqual(carpetas('bash scripts/x.sh && git push origin main'), [BASE]);
});
