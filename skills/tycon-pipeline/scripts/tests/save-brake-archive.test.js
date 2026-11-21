'use strict';
/**
 * save-brake-archive.test.js — dónde escribe un `unzip` para el freno de guardar (lib/save-brake.js,
 * `comandosQueGuardan`): listar o mandar a la salida no escribe, y extraer escribe en la carpeta de `-d` o en la del
 * shell. Aparte de save-brake.test.js, que es una suite bajada de las lentas y no cambia sus casos.
 *
 * Laboratorio por prueba: una HOME vacía y un repo con su `origin` (un repo desnudo local).
 *
 * stable-data: no lee el reloj ni la red.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRAKE_LIB = path.join(__dirname, '..', 'lib', 'save-brake.js');
const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };

function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Un repo con `origin` (desnudo, local) y la rama de la story empujada con seguimiento. */
function repoConOrigin(t) {
  const base = tmp(t, 'freno-unzip-');
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'LEEME.md'), 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', 'story/la-prueba');
  sh(d, 'push', '-q', '-u', 'origin', 'story/la-prueba');
  return d;
}

/** La HOME vacía de la prueba, con la carpeta del estado. */
function home(t) {
  const h = tmp(t, 'freno-unzip-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}

// 🔴 Falla con: un `unzip` que sólo lista (`-l`, `-Z1`, `-t`) o que manda a la salida (`-p`), leído como si escribiera en
// la carpeta del commit: el freno cuenta la carpeta entera como cambiada y frena un guardado que no cambió nada. Y con
// `-d`, lo que escribe es la carpeta de `-d`, no la del shell.
test('SaveBrake_UnzipQueNoEscribe_NoCuenta: listar no escribe, y extraer escribe donde dice -d', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  const escritos = (cmd) => (require(BRAKE_LIB).comandosQueGuardan(cmd, a, h).find((c) => c.tipo === 'commit') || {}).escritos;
  for (const lista of ['unzip -l /tmp/x.zip', 'unzip -Z1 /tmp/x.zip', 'unzip -t /tmp/x.zip', 'unzip -p /tmp/x.zip a.txt', 'unzip -qql /tmp/x.zip']) {
    assert.deepStrictEqual(escritos(`${lista} && git commit -m x`), [], `«${lista}» no escribe`);
  }
  const otra = tmp(t, 'unzip-destino-');
  assert.deepStrictEqual(escritos(`unzip -o /tmp/x.zip -d ${otra} && git commit -m x`), [otra], 'con -d, escribe en esa carpeta');
  assert.deepStrictEqual(escritos(`unzip -o /tmp/x.zip -d${otra} && git commit -m x`), [otra], 'con -d pegado, igual');
  // extraer en la carpeta del shell: la carpeta, como antes
  assert.deepStrictEqual(escritos('unzip -o /tmp/x.zip && git commit -m x'), [a], 'sin -d, la carpeta del shell');
  // las letras del valor pegado a -d o a -P no son banderas: «-dout» extrae en «out» aunque traiga una t
  for (const d of ['out', 'tmp', 'lib', 'vendor']) {
    assert.deepStrictEqual(escritos(`unzip -o /tmp/x.zip -d${d} && git commit -m x`), [path.join(a, d)], `-d${d} extrae en ${d}`);
    assert.deepStrictEqual(escritos(`unzip -qd${d} /tmp/x.zip && git commit -m x`), [path.join(a, d)], `-qd${d}, igual`);
  }
  assert.deepStrictEqual(escritos('unzip -Pclavetl /tmp/x.zip && git commit -m x'), [a], 'la clave de -P no es una bandera de listar');
});
