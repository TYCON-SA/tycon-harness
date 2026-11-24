'use strict';
/**
 * team-init-add-profile.test.js — el comando con que `harness.js team-init` suma el perfil a esta máquina.
 * Quien contribuye al arnés lo instala desde un clon, y ahí `install --version` sale 2 sin escribir («es para una máquina
 * sin arnés»): la capa la apila la mudanza a ~/.tycon (`migrate --to-home --team`). Con la versión bajada, como siempre.
 * Correr: node --test scripts/tests/team-init-add-profile.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TI = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team-init.js'));

// el estado de una máquina con la versión bajada (una fuente release) y el de una instalada desde un clon (sin ella)
const RELEASE = { sources: [{ name: 'harness', kind: 'release', repo: 'acme/harness', commit: 'a'.repeat(40) }] };
const CLONE = { sources: [{ name: 'harness', kind: 'clone', path: '/tmp/clon' }] };

test('TeamInitAddProfile_VersionBajada_InstallVersion', () => {
  const r = TI.addProfile(ROOT, RELEASE, '2026.11.20.54', '/tmp/perfil-de-acme');
  assert.deepStrictEqual(r.args, ['install', '--version', '2026.11.20.54', '--team', '/tmp/perfil-de-acme']);
  assert.ok(r.cmd.endsWith('harness.js" install --version 2026.11.20.54 --team "/tmp/perfil-de-acme"'), r.cmd);
});

test('TeamInitAddProfile_InstaladoDesdeUnClon_LaMudanzaConElPerfil', () => {
  const r = TI.addProfile(ROOT, CLONE, '2026.11.20.54', '/tmp/perfil-de-acme');
  assert.deepStrictEqual(r.args, ['migrate', '--to-home', '--team', '/tmp/perfil-de-acme']);
  assert.ok(r.cmd.endsWith('harness.js" migrate --to-home --team "/tmp/perfil-de-acme"'), r.cmd);
  // el repo de un perfil remoto va tal cual, sin comillas
  assert.ok(TI.addProfile(ROOT, CLONE, '2026.11.20.54', 'acme/harness-team-profile').cmd.endsWith('--team acme/harness-team-profile'));
  // sin estado legible, el clon: la mudanza dice su plan antes de escribir nada
  assert.deepStrictEqual(TI.addProfile(ROOT, null, '2026.11.20.54', 'acme/x').args.slice(0, 2), ['migrate', '--to-home']);
});
