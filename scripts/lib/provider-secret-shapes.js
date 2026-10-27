#!/usr/bin/env node
'use strict';
// provider-secret-shapes.js — las claves enteras con forma de proveedor, y el freno que no las deja entrar al arnés
//
// Las formas son las que el escaneo de secretos de GitHub reconoce (AWS, GitHub, Stripe, sk-, GitLab, Google, npm,
// Slack, llave privada, JWT). Sólo la forma entera cuenta: «AKIA» suelto, o una clave armada por partes en el código
// (`'AKIA' + '…'`), no.
//
// Lo usan:
//   · el borrador de errores de la puesta al día (`maintainers-sync.js#redact`), que tapa una clave sin palabra antes;
//   · la prueba de los archivos de pruebas (T3 de tycon-config.test.js);
//   · el pre-commit del arnés (`--staged`: sólo lo que el commit AGREGA) y la CI del público (`--all`: el árbol entero).
//     Los repos de producto no lo corren: el guion vive en el arnés.
//
// A mano:
//   node scripts/lib/provider-secret-shapes.js --staged [--repo <dir>]
//   node scripts/lib/provider-secret-shapes.js --all [--repo <dir>]
// Salida: 0 sin claves · 1 hay claves (una línea por cada una, la clave recortada) · 2 no pude mirar.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHAPES = Object.freeze([
  ['AWS', /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ['GitHub', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['Stripe', /sk_(?:live|test)_[A-Za-z0-9]{8,}/],
  ['sk-', /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/],   // al empezar una palabra: «risk-assessment…» no es una clave
  ['GitLab', /glpat-[\w-]{12,}/],
  ['Google', /AIza[\w-]{20,}/],
  ['npm', /npm_[A-Za-z0-9]{16,}/],
  ['Slack', /xox[abprs]-[\w-]{10,}/],
  ['llave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /eyJ[\w-]{10,}\.eyJ[\w-]{10,}\./],
]);

/** Todas las formas juntas, para probar o reemplazar de una vez. */
const ANY = new RegExp(SHAPES.map(([, re]) => re.source).join('|'), 'g');

/** Las claves de un texto: `[{ proveedor, muestra }]`, con la clave recortada a sus primeros 4 caracteres. */
function find(text) {
  const out = [];
  for (const m of String(text || '').matchAll(ANY)) {
    const proveedor = (SHAPES.find(([, re]) => new RegExp(`^(?:${re.source})`).test(m[0])) || ['?'])[0];
    out.push({ proveedor, muestra: `${m[0].slice(0, 4)}***` });
  }
  return out;
}

/** El texto con cada clave tapada. */
function redactShapes(text) {
  return String(text || '').replace(ANY, '***');
}

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Lo que el commit agrega: `[{ archivo, linea, texto }]`, de `git diff --cached` sin contexto. */
function stagedLines(repo) {
  const r = git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR']);
  if (r.status !== 0) throw new Error(`git diff --cached falló: ${(r.stderr || '').trim() || r.status}`);
  const out = [];
  let archivo = null;
  let linea = 0;
  // la cabecera de cada archivo va de «diff --git» al primer «@@»: fuera de ella, una línea agregada que empieza con
  // «++ » también se ve como «+++ …», y es contenido
  let cabecera = false;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('diff --git ')) { cabecera = true; archivo = null; continue; }
    if (cabecera && l.startsWith('+++ ')) { archivo = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ (?:b\/)?/, ''); continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { cabecera = false; linea = Number(h[1]); continue; }
    if (cabecera) continue;
    if (archivo && l.startsWith('+')) out.push({ archivo, linea: linea++, texto: l.slice(1) });
  }
  return out;
}

// sin git (una copia exportada), se recorre la carpeta: sin seguir enlaces ni entrar donde otras suites arman y borran
// carpetas de juguete mientras ésta corre
const SALTEAR = new Set(['.git', 'node_modules', '.advisors']);
function walk(repo, rel = '', out = []) {
  let entradas;
  try { entradas = fs.readdirSync(path.join(repo, rel), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const e of entradas) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SALTEAR.has(e.name)) walk(repo, r, out); } else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Los archivos del árbol: los que git sigue (lo ignorado, como un `.env` propio, no viaja), o todos sin git. */
function treeFiles(repo) {
  if (!fs.existsSync(path.join(repo, '.git'))) return walk(repo);
  const r = git(repo, ['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files falló: ${(r.stderr || '').trim() || r.status}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** El árbol entero: cada línea de cada archivo de texto. */
function allLines(repo) {
  const out = [];
  for (const archivo of treeFiles(repo)) {
    let buf;
    try { buf = fs.readFileSync(path.join(repo, archivo)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }   // borrado sin commitear: no viaja
    if (buf.includes(0)) continue;   // un binario no trae una clave escrita
    buf.toString('utf8').split('\n').forEach((texto, i) => out.push({ archivo, linea: i + 1, texto }));
  }
  return out;
}

function main(argv) {
  const iRepo = argv.indexOf('--repo');
  const repo = path.resolve(iRepo >= 0 && argv[iRepo + 1] ? argv[iRepo + 1] : process.cwd());
  const modo = argv.includes('--all') ? 'all' : argv.includes('--staged') ? 'staged' : null;
  if (!modo) { process.stderr.write('uso: provider-secret-shapes.js --staged|--all [--repo <dir>]\n'); return 2; }
  let lineas;
  try { lineas = modo === 'all' ? allLines(repo) : stagedLines(repo); } catch (e) {
    process.stderr.write(`⛔ claves de proveedor: no pude mirar (${e.message})\n`);
    return 2;
  }
  let hallazgos = 0;
  for (const { archivo, linea, texto } of lineas) {
    for (const h of find(texto)) {
      hallazgos++;
      process.stderr.write(`⛔ ${archivo}:${linea}: clave entera con forma de ${h.proveedor} (${h.muestra}): armala por partes, como 'AKIA' + '…' en las pruebas.\n`);
    }
  }
  return hallazgos ? 1 : 0;
}

module.exports = { SHAPES, ANY, find, redactShapes, allLines, stagedLines };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
