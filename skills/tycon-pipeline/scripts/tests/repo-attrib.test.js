'use strict';

/**
 * repo-attrib.test.js — el repo real de una carpeta, que el volcado de cada ejecución lleva al buzón.
 *
 * QUÉ PROTEGE: que la vista de ejecuciones agrupe un worktree con su repo (sin eso, cada copia de trabajo sale como
 * un repo aparte en el filtro) y que el remoto viaje SIN host, usuario ni token: el volcado sale de la máquina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { realRepo, remoteName } = require('../lib/repo-attrib.js');

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-attrib-'))); }

/** Un repo y un worktree suyo, armados a mano como los deja git (sin invocarlo). */
function repoConWorktree(raiz, url) {
  const main = path.join(raiz, 'acme');
  const git = path.join(main, '.git');
  fs.mkdirSync(path.join(git, 'worktrees', 'acme-wt-127'), { recursive: true });
  fs.writeFileSync(path.join(git, 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://otro.invalid/x/y.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  const wt = path.join(raiz, 'acme-wt-127');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(git, 'worktrees', 'acme-wt-127')}\n`);
  fs.writeFileSync(path.join(git, 'worktrees', 'acme-wt-127', 'commondir'), '../..\n');
  return { main, wt };
}

// rojo si: el worktree se toma como su propio repo, o el remoto sale con el token de la URL.
test('T1 RealRepo_Worktree_GivesMainCheckoutAndRemoteWithoutCredentials', () => {
  const raiz = tmp();
  const { main, wt } = repoConWorktree(raiz, 'https://usuario:TOKEN_SEMBRADO@dev.azure.example/org/Cliente%20A/_git/acme');
  const r = realRepo(wt);
  assert.deepStrictEqual(r, { path: main, remote: 'Cliente%20A/acme' });
  assert.ok(!JSON.stringify(r).includes('TOKEN_SEMBRADO') && !JSON.stringify(r).includes('usuario'), 'ni el token ni el usuario salen');
  assert.deepStrictEqual(realRepo(main), r, 'el clon principal da lo mismo que su worktree');
});

// rojo si: una forma de URL deja pasar el host o el usuario, o se queda con el `.git`.
test('T2 RemoteName_UrlForms_KeepOnlyOwnerAndRepo', () => {
  assert.strictEqual(remoteName('git@github.com:acme/tienda.git'), 'acme/tienda');
  assert.strictEqual(remoteName('ssh://git@ssh.dev.azure.com/v3/org/Proj/tienda'), 'Proj/tienda');
  assert.strictEqual(remoteName('git@ssh.dev.azure.com:v3/org/Proj/tienda'), 'Proj/tienda');
  assert.strictEqual(remoteName('https://user:token@github.example/acme/tienda.git'), 'acme/tienda');
  assert.strictEqual(remoteName('/Users/dev/repos/tienda.git'), 'repos/tienda');
  assert.strictEqual(remoteName('https://github.com'), null);
  // las formas que dejaban pasar el host, el token o una query
  assert.strictEqual(remoteName('https://dev.azure.com/org/tienda?token=SECRETO/x'), 'org/tienda');
  assert.strictEqual(remoteName('github.com:acme/tienda'), 'acme/tienda');
  assert.strictEqual(remoteName('https://u:pa/ss@host.invalid/acme/tienda.git'), 'acme/tienda');
  assert.strictEqual(remoteName('C:\\repos\\acme\\tienda'), 'acme/tienda');
});

// rojo si: una carpeta sin git o sin origin rompe, en vez de dejar que la vista deduzca de la carpeta.
test('T3 RealRepo_NoGitOrNoOrigin_NeverThrows', () => {
  const raiz = tmp();
  assert.strictEqual(realRepo(path.join(raiz, 'no-esta')), null);
  assert.strictEqual(realRepo(undefined), null);
  const solo = path.join(raiz, 'solo');
  fs.mkdirSync(path.join(solo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(solo, '.git', 'config'), '[core]\n\tbare = false\n');
  assert.deepStrictEqual(realRepo(solo), { path: solo, remote: null });
});
