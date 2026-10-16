#!/usr/bin/env node
'use strict';
/**
 * fake-node-dist.js — el servidor local que hace de nodejs.org en las pruebas de la story 8.39 (harness-node.test.sh).
 *
 * La bajada del Node del arnés nunca se prueba contra nodejs.org (decisión 20 de la story): esta prueba levanta este
 * servidor en 127.0.0.1, con un puerto libre, y le sirve los archivos de una carpeta (el comprimido y el `.exe` de
 * juguete que arma la prueba). Cuenta cada pedido en un archivo y se porta según un archivo de modo, que la prueba
 * cambia sin reiniciarlo:
 *   ok      sirve el archivo pedido (404 si no está)
 *   500     contesta 500 a todo
 *   hang    acepta y no contesta nunca (para probar el tope)
 *   slow    espera SLOW_MS (el número que traiga la segunda línea del archivo de modo, o 3000) y después sirve
 *
 * Uso: node fake-node-dist.js <carpeta> <archivo-del-puerto> <archivo-de-pedidos> <archivo-de-modo>
 * Escribe el puerto en <archivo-del-puerto> cuando escucha. Cada pedido agrega una línea «<método> <ruta>» al de pedidos.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const [dir, portFile, countFile, modeFile] = process.argv.slice(2);
if (!dir || !portFile || !countFile || !modeFile) {
  process.stderr.write('uso: fake-node-dist.js <carpeta> <archivo-del-puerto> <archivo-de-pedidos> <archivo-de-modo>\n');
  process.exit(2);
}

function mode() {
  try {
    const [m, ms] = fs.readFileSync(modeFile, 'utf8').split('\n');
    return { name: (m || 'ok').trim(), ms: Number(ms) > 0 ? Number(ms) : 3000 };
  } catch (_) { return { name: 'ok', ms: 3000 }; }
}

function serve(req, res) {
  const rel = decodeURIComponent(String(req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const file = path.join(dir, ...rel.split('/'));
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no está\n');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try { fs.appendFileSync(countFile, `${req.method} ${req.url}\n`); } catch (_) { /* la prueba lo nota */ }
  const m = mode();
  if (m.name === '500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('falla\n'); return; }
  if (m.name === 'hang') return;   // nunca contesta
  if (m.name === 'slow') { setTimeout(() => serve(req, res), m.ms); return; }
  serve(req, res);
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
