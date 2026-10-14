'use strict';
/**
 * public-git.test.js — las rutas públicas de GitHub con las que una versión bajada mira y baja sin permiso
 * (scripts/setup/harness/public-git.js, story 8.34).
 *
 * Qué fija:
 *   · `parseInfoRefs` lee las ramas de una respuesta de `info/refs` (pkt-line de git, con las capacidades después de un
 *     byte nulo en la primera ref) y rechaza lo que no es git: una página HTML, un encabezado de otro servicio, un largo
 *     que no es hexadecimal, una respuesta cortada a mitad de una línea o sin el corte final;
 *   · `bases`: por defecto los hosts reales; las variables de prueba los cambian; con `TYCON_RELEASE_API` puesta y
 *     `TYCON_RELEASE_GIT` no, NO hay rutas públicas (un laboratorio no sale al GitHub real); una base que no es http(s)
 *     tampoco;
 *   · las tres direcciones: `info/refs` del repo, el raw POR COMMIT y el comprimido de codeload.
 * Sin red: los datos son texto armado acá.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const PG = require(path.join(__dirname, '..', 'setup', 'harness', 'public-git.js'));

const pkt = (t) => `${(Buffer.byteLength(t, 'latin1') + 4).toString(16).padStart(4, '0')}${t}`;
const SHA_MAIN = 'a'.repeat(40);
const SHA_SYNC = 'b'.repeat(40);
const advert = (lines) => Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${lines.map(pkt).join('')}0000`, 'latin1');

test('ParseInfoRefs_ReadsHeads_FirstLineWithCapabilities', () => {
  const r = PG.parseInfoRefs(advert([
    `${SHA_MAIN} HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/main\n`,
    `${SHA_MAIN} refs/heads/main\n`,
    `${SHA_SYNC} refs/heads/mirror/sync\n`,
    `${'c'.repeat(40)} refs/pull/12/head\n`,
    `${'d'.repeat(40)} refs/tags/v1\n`,
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.heads, { main: SHA_MAIN, 'mirror/sync': SHA_SYNC }, 'sólo las ramas, con la barra tal cual');
  // la primera ref con capacidades también cuenta cuando es una rama
  const r2 = PG.parseInfoRefs(advert([`${SHA_MAIN} refs/heads/main\0multi_ack agent=x\n`]));
  assert.deepEqual(r2.heads, { main: SHA_MAIN });
  // un repo sin ramas: se lee, sin ninguna
  assert.deepEqual(PG.parseInfoRefs(advert([])).heads, {});
});

test('ParseInfoRefs_RejectsWhatIsNotGit', () => {
  const casos = {
    'una página HTML': Buffer.from('<html>no es git</html>'),
    'otro servicio': Buffer.from(`${pkt('# service=git-receive-pack\n')}0000${pkt(`${SHA_MAIN} refs/heads/main\n`)}0000`, 'latin1'),
    'un largo que no es hexadecimal': Buffer.from(`zzzz# service=git-upload-pack\n0000`, 'latin1'),
    'cortada a mitad de una línea': advert([`${SHA_MAIN} refs/heads/main\n`]).subarray(0, 60),
    'sin el corte final': Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${SHA_MAIN} refs/heads/main\n`)}`, 'latin1'),
    'vacía': Buffer.alloc(0),
  };
  for (const [nombre, buf] of Object.entries(casos)) {
    const r = PG.parseInfoRefs(buf);
    assert.equal(r.ok, false, `${nombre}: no se acepta`);
    assert.match(r.reason, /git/, `${nombre}: el motivo lo dice`);
  }
});

test('Bases_RealByDefault_TestVarsOverride_ApiWithoutGitMeansNone', () => {
  assert.deepEqual(PG.bases({}), PG.DEFAULTS, 'sin variables, los hosts reales');
  const lab = { TYCON_RELEASE_API: 'http://127.0.0.1:1', TYCON_RELEASE_GIT: 'http://127.0.0.1:2/', TYCON_RELEASE_RAW: 'http://127.0.0.1:3', TYCON_RELEASE_ARCHIVE: 'http://127.0.0.1:4' };
  assert.deepEqual(PG.bases(lab), { git: 'http://127.0.0.1:2', raw: 'http://127.0.0.1:3', codeload: 'http://127.0.0.1:4' }, 'las de prueba, sin la barra final');
  assert.equal(PG.bases({ TYCON_RELEASE_API: 'http://127.0.0.1:1' }), null, 'la API de juguete sin github.com de juguete: sin rutas públicas');
  assert.equal(PG.bases({ TYCON_RELEASE_GIT: 'file:///etc' }), null, 'una base que no es http(s): ninguna');
});

test('Urls_InfoRefs_RawByCommit_Codeload', () => {
  const b = PG.DEFAULTS;
  assert.equal(PG.refsUrl(b, 'org/repo'), 'https://github.com/org/repo.git/info/refs?service=git-upload-pack');
  assert.equal(PG.rawUrl(b, 'org/repo', SHA_MAIN, 'version.json'), `https://raw.githubusercontent.com/org/repo/${SHA_MAIN}/version.json`);
  assert.equal(PG.tarUrl(b, 'org/repo', SHA_MAIN), `https://codeload.github.com/org/repo/tar.gz/${SHA_MAIN}`);
});
