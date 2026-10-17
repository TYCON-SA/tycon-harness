'use strict';

/**
 * git-http-server.test.js — la pieza de pruebas que sirve un repo git por HTTP (scripts/tests/lib/git-http-server.js).
 *
 * Qué sostiene: un git que no trae `http-backend` no cuenta como «hay backend» (una salida vacía no es su cabecera
 * CGI); si el git del PATH no lo trae, se busca otro de la máquina que sí, y con él el repo por HTTP se clona.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

const LIB = path.join(__dirname, 'lib', 'git-http-server.js');
const REPO = path.join(__dirname, 'lib', 'git-http-repo.js');

/** Corre `código` en un proceso aparte con este PATH; devuelve lo que imprime. */
function conPath(PATH, codigo) {
  const r = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', env: { ...process.env, PATH } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** Una carpeta con un `git` de mentira que no conoce `http-backend`. */
function gitSinBackend(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sin-backend-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'git'), '#!/bin/sh\necho "git: \'http-backend\' is not a git command." >&2\nexit 1\n', { mode: 0o755 });
  return d;
}

test('HttpBackend_GitWithout_NotCounted', { skip: process.platform === 'win32' && 'el git de mentira es un guion de sh' }, (t) => {
  const d = gitSinBackend(t);
  assert.strictEqual(conPath(`${d}${path.delimiter}/usr/bin${path.delimiter}/bin`, `console.log(require(${JSON.stringify(LIB)}).hayHttpBackend())`), 'false');
});

// en un agente de Windows el primer git del PATH no trae http-backend: este caso mide que se encuentre el otro
test('HttpBackend_RealGit_Clones', async (t) => {
  const { crearRepoHttp, hayHttpBackend } = require(REPO);
  if (!hayHttpBackend()) { t.skip('NO MEDIDO: el git de esta máquina no trae http-backend'); return; }
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'git-http-server-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const cab = `Basic ${Buffer.from('x-access-token:w').toString('base64')}`;
  const r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos: { 'a.json': { x: 1 } }, cabecera: cab });
  try {
    const dir = path.join(raiz, 'clon');
    await require('util').promisify(execFile)('git', ['-c', `http.extraheader=Authorization: ${cab}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')), { x: 1 });
  } finally { await r.cerrar(); }
});
