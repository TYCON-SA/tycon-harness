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

test('T2j Imagen_SinHerramientasDePaquetes_YArranca @story-2.30', { skip: SIN_DOCKER }, () => {
  // la imagen armada no trae npm, npx, yarn ni corepack (sus módulos traen vulnerabilidades y el sitio no los usa), y el
  // sitio sigue corriendo: node y git están, y el proceso arranca
  const id = crypto.randomBytes(4).toString('hex');
  const imagen = `site-prueba-sin-npm:${id}`;
  try {
    const b = docker(['buildx', 'build', '--load', '-f', 'scripts/site/Dockerfile', '-t', imagen, '.']);
    assert.strictEqual(b.status, 0, `la imagen se arma: ${(b.stderr || '').slice(-800)}`);
    const r = docker(['run', '--rm', imagen, 'sh', '-c',
      'for b in npm npx yarn yarnpkg corepack; do command -v "$b" && echo "TRAE $b"; done; ls /usr/local/lib/node_modules 2>/dev/null | sed "s/^/MODULO /"; node -v; git --version']);
    assert.strictEqual(r.status, 0, (r.stdout + r.stderr).slice(-600));
    assert.doesNotMatch(r.stdout, /TRAE |MODULO /, `sin herramientas de paquetes: ${r.stdout}`);
    assert.match(r.stdout, /^v\d+\.\d+\.\d+$/m, 'node sigue');
    assert.match(r.stdout, /^git version /m, 'git sigue');
    // el servidor carga y valida su configuración (sin variables, sale diciendo cuál falta: no por un módulo ausente)
    const s = docker(['run', '--rm', imagen, 'node', 'scripts/site/server.js'], { timeout: 60000 });
    assert.doesNotMatch(s.stdout + s.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/, (s.stdout + s.stderr).slice(-400));
    assert.match(s.stdout + s.stderr, /SITE_/, 'dice qué variable falta');
  } finally {
    docker(['image', 'rm', '-f', imagen], { timeout: 60000 });
  }
});

test('T2k Imagen_LaPestanaConfiguracionLeeLoMismoQueElArbol @story-2.30', { skip: SIN_DOCKER }, () => {
  // la pestaña Configuración lee archivos del árbol del arnés (qué trae cada perfil, los umbrales, los lectores): armada
  // dentro de la imagen tiene que contestar lo mismo que en el árbol, sin ningún «no se pudo leer». La sonda corre en los
  // dos lados con un repo de operaciones y uno del perfil de mentira (tests/lib/config-tab-probe.js)
  const id = crypto.randomBytes(4).toString('hex');
  const imagen = `site-prueba-config:${id}`;
  const sonda = (r) => { assert.strictEqual(r.status, 0, (r.stdout + r.stderr).slice(-800)); return JSON.parse(r.stdout.trim().split('\n').pop()); };
  try {
    const b = docker(['buildx', 'build', '--load', '-f', 'scripts/site/Dockerfile', '-t', imagen, '.']);
    assert.strictEqual(b.status, 0, `la imagen se arma: ${(b.stderr || '').slice(-800)}`);
    const env = { ...process.env, PROBE_FULL: '1' };
    const arbol = sonda(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'config-tab-probe.js')], { cwd: ROOT, encoding: 'utf8', env, timeout: 120000 }));
    const enImagen = sonda(docker(['run', '--rm', '-e', 'PROBE_FULL=1', '-v', `${path.join(ROOT, 'scripts', 'tests')}:/app/scripts/tests:ro`,
      imagen, 'node', '/app/scripts/tests/lib/config-tab-probe.js'], { timeout: 120000 }));
    assert.deepStrictEqual(enImagen.ilegibles, [], 'en la imagen, ninguna sección dice «no se pudo leer»');
    assert.ok(enImagen.perfiles.minimal > 0 && enImagen.perfiles.full > enImagen.perfiles.minimal, `qué trae cada perfil: ${JSON.stringify(enImagen.perfiles)}`);
    assert.ok(enImagen.secciones > 0 && enImagen.secciones === arbol.secciones, 'las mismas secciones');
    for (const s of arbol.respuesta.secciones) {
      const otra = enImagen.respuesta.secciones.find((x) => x.id === s.id);
      assert.deepStrictEqual(otra, s, `la sección ${s.id}, igual en la imagen que en el árbol`);
    }
    const { secciones: _a, ...restoArbol } = arbol.respuesta;
    const { secciones: _b, ...restoImagen } = enImagen.respuesta;
    assert.deepStrictEqual(restoImagen, restoArbol, 'lo demás de la pestaña, igual');
  } finally {
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
