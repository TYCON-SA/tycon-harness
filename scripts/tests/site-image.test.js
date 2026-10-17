'use strict';
/*
 * site-image.test.js — la imagen del sitio de la organización, armada de verdad (necesita Docker).
 *
 * T1 Imagen_VolumenNuevoEscribiblePorElSitio: con un volumen con nombre NUEVO montado en /data (el comando que da la
 * guía: `-v sitio-datos:/data -e SITE_DATA_DIR=/data`), el usuario del sitio puede crear ahí la carpeta del clon de
 * operaciones y escribir un archivo. 🔴 rojo previo (2026-10-16): el volumen nacía de root, el sitio corre como `node`,
 * y `git clone` decía «could not create work tree dir '/data/operaciones': Permission denied»: el sitio se frenaba.
 *
 * Sin Docker (o sin su servicio), la prueba se saltea y lo dice: no es un verde.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const docker = (args, opts = {}) => spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', timeout: 600000, ...opts });
const SIN_DOCKER = (() => { const r = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 }); return r.status === 0 ? false : 'Docker no está o su servicio no responde: la imagen no se puede armar'; })();

test('T1 Imagen_VolumenNuevoEscribiblePorElSitio', { skip: SIN_DOCKER }, () => {
  const id = crypto.randomBytes(4).toString('hex');
  const imagen = `site-prueba:${id}`;
  const volumen = `site-prueba-datos-${id}`;
  try {
    const b = docker(['buildx', 'build', '--load', '-f', 'scripts/site/Dockerfile', '-t', imagen, '.']);
    assert.strictEqual(b.status, 0, `la imagen se arma: ${(b.stderr || '').slice(-800)}`);
    // el volumen con nombre se crea al montarlo: nuevo, vacío, como el de la guía
    // el comando reemplaza al del sitio (la imagen de Node lo ejecuta tal cual)
    const r = docker(['run', '--rm', '-v', `${volumen}:/data`, '-e', 'SITE_DATA_DIR=/data', imagen, 'sh', '-c',
      'id -un && mkdir /data/operaciones && echo ok > /data/configuracion-estado.json && stat -c %U /data']);
    assert.strictEqual(r.status, 0, `el sitio escribe en el volumen: ${(r.stdout + r.stderr).slice(-600)}`);
    const lineas = r.stdout.trim().split('\n');
    assert.strictEqual(lineas[0], 'node', 'corre como node');
    assert.strictEqual(lineas[lineas.length - 1], 'node', '/data es de node');
  } finally {
    docker(['volume', 'rm', '-f', volumen], { timeout: 60000 });
    docker(['image', 'rm', '-f', imagen], { timeout: 60000 });
  }
});

test('T2i Imagen_SinVersionJson_SeArmaIgual @story-2.30', { skip: SIN_DOCKER }, () => {
  // 🔴 el árbol de la noche (lo privado con lo público encima) no trae version.json en la raíz —lo genera la
  // publicación—: la imagen se arma igual, y el sitio dice la versión como desconocida.
  const fs = require('fs');
  const os = require('os');
  const id = crypto.randomBytes(4).toString('hex');
  const imagen = `site-prueba-sin-version:${id}`;
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'site-ctx-'));
  try {
    for (const d of ['scripts', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(ctx, d), { recursive: true, filter: (f) => !f.includes(`${path.sep}node_modules`) });
    assert.ok(!fs.existsSync(path.join(ctx, 'version.json')), 'el contexto no trae version.json');
    const b = docker(['buildx', 'build', '--load', '-f', 'scripts/site/Dockerfile', '-t', imagen, '.'], { cwd: ctx });
    assert.strictEqual(b.status, 0, `la imagen se arma sin version.json: ${(b.stderr || '').slice(-800)}`);
  } finally {
    docker(['image', 'rm', '-f', imagen], { timeout: 60000 });
    fs.rmSync(ctx, { recursive: true, force: true });
  }
});
