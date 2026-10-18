#!/usr/bin/env node
'use strict';
/**
 * start.js — el arranque del sitio de la organización en una máquina propia, con el archivo de secretos FUERA de todo
 * repo: un archivo de secretos dentro de un repo termina commiteado tarde o temprano.
 *
 * POR QUÉ: compose.yaml lee los secretos de un archivo de variables. Si ese archivo vive dentro de un repo git (por ejemplo
 * al lado de compose.yaml, en el clon del arnés), un `git add` de más lo sube con la llave de la sesión, el secreto del
 * inicio de sesión y los tokens. Por eso compose.yaml no nombra ningún archivo: lo recibe por `SITE_ENV_FILE`, que pone
 * este arranque después de comprobar dos cosas, y si alguna falla no arranca nada:
 *   · que el archivo no esté dentro de un repo git (ninguna carpeta de arriba tiene `.git`, carpeta o archivo);
 *   · que sólo lo pueda leer su dueño (en Mac y Linux: `chmod 600`).
 *
 *   node scripts/site/deploy/local/start.js --secrets-file <ruta fuera de todo repo>/sitio.env [--dry-run]
 *   SALIDA: 0 arrancó (o, en ensayo, dice la orden) · 1 el archivo no está, está dentro de un repo o lo leen otros · 2 uso.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const COMPOSE = path.join(__dirname, 'compose.yaml');
// La opción NO se llama --env-file: Node 20 la toma como suya aunque venga después del guion, y sale 9 sin correrlo.

/** La carpeta del repo git que contiene `archivo`, o null. */
function repoQueLoContiene(archivo) {
  let dir = path.dirname(archivo);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const arriba = path.dirname(dir);
    if (arriba === dir) return null;
    dir = arriba;
  }
}

function main(argv) {
  let envFile = null; let ensayo = false; let actualizar = false; let imagenDada = null; let error = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--secrets-file') envFile = argv[++i];
    else if (argv[i] === '--dry-run') ensayo = true;
    else if (argv[i] === '--update') actualizar = true;
    else if (argv[i] === '--image') imagenDada = argv[++i];
    else error = `opción desconocida: ${argv[i]}`;
  }
  if (error || !envFile) {
    if (error) process.stderr.write(`${error}\n`);
    process.stderr.write('uso: start.js --secrets-file <ruta fuera de todo repo>/sitio.env [--update --image <registro/repo>] [--dry-run]\n');
    return 2;
  }
  const archivo = path.resolve(envFile);
  let st;
  try { st = fs.statSync(archivo); } catch (e) {
    // «no está» y «no lo puedo abrir» son dos cosas: la segunda no manda a buscar un archivo que está
    if (e && e.code === 'ENOENT') process.stderr.write('🔴 no encuentro el archivo de secretos: copiá scripts/site/deploy/local/sitio.env.example FUERA de todo repo y completalo\n');
    else process.stderr.write(`🔴 no pude leer el archivo de secretos (${(e && e.code) || 'error'})\n`);
    return 1;
  }
  if (!st.isFile()) { process.stderr.write('🔴 el archivo de secretos no es un archivo\n'); return 1; }
  const repo = repoQueLoContiene(fs.realpathSync(archivo));
  if (repo) {
    process.stderr.write(`🔴 el archivo de secretos está dentro de un repo git (${repo}): un commit de más lo subiría. Movelo a una carpeta fuera de todo repo\n`);
    return 1;
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    process.stderr.write('🔴 el archivo de secretos lo pueden leer otros usuarios de la máquina: chmod 600 y volvé a lanzarlo\n');
    return 1;
  }
  if (actualizar) {
    // --update: resuelve `stable`, recrea con SITE_IMAGE=<imagen>@<huella>, prueba /livez y vuelve atrás si falla; para
    // un cron o un temporizador de systemd (la receta, en la guía). 🔴 La imagen la dice quien instala (`--image`): nunca
    // sale del ejemplo de compose.yaml, que es de una organización inventada
    const imagen = imagenDada && require('../../latest-release.js').partirImagen(imagenDada) ? require('../../latest-release.js').nombreSinEtiqueta(imagenDada) : null;
    if (!imagen) { process.stderr.write('🔴 --update necesita --image <registro/repo> (la imagen del sitio de tu organización, sin etiqueta)\n'); return 2; }
    const up = ['--platform', 'local', '--mode', 'auto', '--compose', COMPOSE, '--site-url', 'http://127.0.0.1:8080', '--image', imagen, ...(ensayo ? ['--dry-run'] : [])];
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'update-site.js'), ...up], { stdio: 'inherit', env: { ...process.env, SITE_ENV_FILE: archivo } });
    return r.status === 0 ? 0 : 1;
  }
  const args = ['compose', '-f', COMPOSE, 'up', '-d'];
  if (ensayo) {
    process.stdout.write(`SITE_ENV_FILE=${archivo} docker ${args.join(' ')}   (ensayo: no se arrancó nada)\n`);
    return 0;
  }
  const r = spawnSync('docker', args, { stdio: 'inherit', env: { ...process.env, SITE_ENV_FILE: archivo } });
  if (r.error) { process.stderr.write(`🔴 no pude correr docker (${r.error.code || r.error.message})\n`); return 1; }
  return r.status === 0 ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { repoQueLoContiene };
