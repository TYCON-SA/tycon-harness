'use strict';
/**
 * followup-of-git-errors.test.js — si git falla al buscar si la historia ya existe, la historia no se toma como nueva.
 *
 * `naceAhora` (scripts/lib/followup-of.js) decide si una historia nace en este cambio: el lint de `followup_of:` frena
 * sólo a una nueva. Pregunta con `git log` (su archivo) y con `git grep` (su `story:`). `git grep` sale 1 cuando no
 * encuentra, y eso es una respuesta; cualquier otra falla es «no sé», y con «no sé» la historia no nace (el lint no la
 * frena por un error de git). Esta prueba pone un `git` de juguete adelante en el PATH que falla en `log` o en `grep`.
 *
 * Correr: node --test scripts/tests/followup-of-git-errors.test.js < /dev/null
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FOLLOWUP_OF = path.join(ROOT, 'scripts', 'lib', 'followup-of.js');
const NO_SH = process.platform === 'win32';
const GIT_REAL = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();

/** Un repo con una historia commiteada y otra nueva, sin commitear, que nadie conoce. */
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'followup-git-')));
  const git = (...a) => execFileSync(GIT_REAL, ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T10:00:00', GIT_COMMITTER_DATE: '2026-01-01T10:00:00' } });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs', 'vieja.md'), '---\nstory: "9.1"\n---\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'inicio');
  const nueva = path.join(dir, 'specs', 'nueva.md');
  fs.writeFileSync(nueva, '---\nstory: "9.2"\n---\n');
  return { dir, nueva };
}

/** Un `git` de juguete que sale `codigo` en el subcomando `falla` y pasa lo demás al git de verdad. */
function gitQueFalla(falla, codigo) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-falla-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "${falla}" ]; then echo "fatal: de juguete" >&2; exit ${codigo}; fi; done\nexec "${GIT_REAL}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return bin;
}

function naceAhora(archivo, id, bin) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(FOLLOWUP_OF)}).naceAhora(process.argv[1], process.argv[2])))`, archivo, id],
    { encoding: 'utf8', env: { ...process.env, ...(bin ? { PATH: `${bin}${path.delimiter}${process.env.PATH}` } : {}) } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('T1 NaceAhora_GitLogFalla_NoNace', { skip: NO_SH }, () => {
  const { nueva } = repo();
  assert.strictEqual(naceAhora(nueva, '9.2'), 'true', 'con git sano, nadie la conoce: nace');
  assert.strictEqual(naceAhora(nueva, '9.2', gitQueFalla('log', 128)), 'false', 'git log falló: no sé, no nace');
});

test('T2 NaceAhora_GitGrepFalla_NoNace_YSinCoincidenciasNace', { skip: NO_SH }, () => {
  const { nueva } = repo();
  assert.strictEqual(naceAhora(nueva, '9.2', gitQueFalla('grep', 2)), 'false', 'git grep falló: no sé, no nace');
  assert.strictEqual(naceAhora(nueva, '9.2', gitQueFalla('grep', 1)), 'true', 'git grep sale 1 sin coincidencias: es una respuesta, nace');
});
