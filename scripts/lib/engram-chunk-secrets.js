#!/usr/bin/env node
'use strict';
// engram-chunk-secrets.js — las claves en la memoria compartida, antes de que viaje con un commit
//
// El pre-commit global exporta la memoria del proyecto a `.engram/` y la prepara para el commit. Una nota que trae una
// clave entera viajaría al pedido y quedaría en la historia del repo. Esto mira lo que el próximo commit puede llevar de
// `.engram/`: lo PREPARADO (leído del índice, que es lo que git guarda, no del disco) y lo PENDIENTE en el disco (sin
// seguir o cambiado, que es lo que el gancho prepara después). Dice qué archivo y qué nota traen qué forma de clave,
// sin mostrarla.
//
// Las formas: las claves enteras de proveedor (`provider-secret-shapes.js`), la contraseña o la llave de una cadena de
// conexión, y un valor con pinta de clave escrito junto a su palabra («clave de licencia … es <valor>»,
// «password: <valor>»). Un valor con pinta de clave mezcla mayúsculas, minúsculas y números, y no es una ruta ni un
// identificador armado con palabras.
//
// A mano:
//   node scripts/lib/engram-chunk-secrets.js --repo <dir>
// Salida: 0 sin claves · 1 hay claves, o un archivo que no se pudo leer (una línea por cada uno) · 2 no pude mirar (git).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const SHAPES = require('./provider-secret-shapes.js');

// lo más que se descomprime de un archivo: más grande no es una memoria exportada, y no se deja colgar el commit
const MAX_TEXTO = 64 * 1024 * 1024;

// la contraseña o la llave de una cadena de conexión (SQL Server, Azure Storage, Service Bus)
const CONEXION = /(?:^|[;\s"'])(?:password|pwd|accountkey|sharedaccesskey)\s*=\s*([^;\s"']{6,})/gi;
// la palabra de una clave y, a pocos caracteres, «es», «is», «:» o «=» y el valor
const PALABRA = /(?:licen[cs]ia|license|clave|contrase[ñn]a|password|passwd|secret[oa]?|token|api[ _-]?key|llave)[^\n]{0,40}?(?:\bes\b|\bis\b|:|=)\s*["'`]?([A-Za-z0-9+/_\-.=]{16,})/gi;
// un identificador armado con palabras («SEC-12.6-alguna-regla-mas») no es una clave aunque mezcle mayúsculas y números
const deCorrido = (v) => v.split(/[-_.]/).filter((x) => /^[a-z]{3,}$/.test(x)).length >= 2;
const conPintaDeClave = (v) => /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && !/^https?:|\/\w+\//.test(v) && !deCorrido(v);
// la de una cadena de conexión lleva un número y no es una variable ni una expresión de reemplazo (la clave seguida de `=/…/`)
const contrasenaDeVerdad = (v) => /[0-9]/.test(v) && !/^[$<{%/]/.test(v);

/** Las formas de clave de un texto: `['clave de AWS', …]`, sin el valor. */
function formasDe(texto) {
  const t = String(texto || '');
  const out = SHAPES.find(t).map((h) => `clave de ${h.proveedor}`);
  for (const m of t.matchAll(CONEXION)) if (contrasenaDeVerdad(m[1])) { out.push('contraseña o llave de una cadena de conexión'); break; }
  for (const m of t.matchAll(PALABRA)) if (conPintaDeClave(m[1])) { out.push('valor con pinta de clave junto a su palabra'); break; }
  return [...new Set(out)];
}

/** Un texto para la terminal: sin ninguna clave, sin caracteres de control y recortado. */
function paraMostrar(texto, max = 80) {
  let t = SHAPES.redactShapes(String(texto))
    .replace(CONEXION, (m, v) => (contrasenaDeVerdad(v) ? m.replace(v, '***') : m))
    .replace(PALABRA, (m, v) => (conPintaDeClave(v) ? m.replace(v, '***') : m));
  t = t.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Todos los textos de un valor, recursivo. */
function textos(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textos(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => textos(x, out));
  return out;
}

/**
 * El texto de un archivo de `.engram/`: descomprimido mientras sea gzip (un gzip dentro de otro también, con tope), y
 * leído como UTF-16 si trae su marca. Lanza si no se puede.
 */
function textoDe(buf) {
  let b = buf;
  for (let vueltas = 0; b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b; vueltas += 1) {
    if (vueltas >= 4) throw Object.assign(new Error('demasiados gzip uno dentro de otro'), { code: 'ANIDADO' });
    b = zlib.gunzipSync(b, { maxOutputLength: MAX_TEXTO });
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.slice(2)).swap16().toString('utf16le');
  return b.toString('utf8');
}

/** Los hallazgos de un archivo: `[{ nota, formas }]`. Una memoria exportada se mira nota por nota; otro texto, entero. */
function revisarContenido(buf, nombre) {
  const texto = textoDe(buf);
  let datos = null;
  try { datos = JSON.parse(texto); } catch { datos = null; }
  const out = [];
  if (datos && typeof datos === 'object' && !Array.isArray(datos)) {
    for (const [lista, items] of Object.entries(datos)) {
      for (const item of Array.isArray(items) ? items : [items]) {
        const formas = formasDe(textos(item).join('\n'));
        if (formas.length) out.push({ nota: paraMostrar(item && typeof item === 'object' ? (item.title || item.type || lista) : lista), formas });
      }
    }
    return out;
  }
  // un .jsonl, o lo que no sea una memoria exportada: renglón por renglón, nombrado por el archivo
  const formas = formasDe(texto);
  if (formas.length) out.push({ nota: paraMostrar(path.basename(nombre)), formas });
  return out;
}

/** Compatibilidad: los hallazgos de un archivo del disco. */
function revisarArchivo(ruta) { return revisarContenido(fs.readFileSync(ruta), ruta); }

const lista = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} falló: ${(r.stderr || '').toString().trim() || r.status}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
};

/**
 * Lo que el próximo commit puede llevar de `.engram/`: `[{ ruta, de: 'preparado' | 'disco' }]`. Lo preparado se lee del
 * índice (un archivo preparado y cambiado después en el disco viaja como está en el índice); lo del disco es lo que el
 * gancho prepara después: sin seguir, o cambiado respecto del índice. Un borrado no trae nada que mirar.
 */
function pendientes(repo) {
  const out = [];
  for (const ruta of lista(repo, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', '--', '.engram'])) out.push({ ruta, de: 'preparado' });
  for (const ruta of lista(repo, ['diff', '--name-only', '-z', '--diff-filter=ACMRT', '--', '.engram'])) out.push({ ruta, de: 'disco' });
  for (const ruta of lista(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.engram'])) out.push({ ruta, de: 'disco' });
  return out;
}

/**
 * El contenido que viajaría. Un enlace simbólico viaja como el texto de su destino: se lee ése, nunca se sigue (un
 * enlace a /dev/zero colgaría el commit). Lo que no es un archivo común ni un enlace (un dispositivo, una tubería) no
 * se lee y frena.
 */
function leer(repo, p) {
  if (p.de === 'disco') {
    const abs = path.join(repo, p.ruta);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return Buffer.from(fs.readlinkSync(abs), 'utf8');
    if (!st.isFile()) throw Object.assign(new Error('no es un archivo común'), { code: 'NO_ARCHIVO' });
    if (st.size > MAX_TEXTO) throw Object.assign(new Error('pasa el tope'), { code: 'TOPE' });
    return fs.readFileSync(abs);
  }
  const r = spawnSync('git', ['-C', repo, 'cat-file', 'blob', `:${p.ruta}`], { maxBuffer: MAX_TEXTO });
  if (r.status !== 0) throw Object.assign(new Error('no está en el índice'), { code: 'INDICE' });
  return r.stdout;
}

function main(argv) {
  const i = argv.indexOf('--repo');
  const repo = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd());
  let archivos;
  try { archivos = pendientes(repo); } catch (e) {
    process.stderr.write(`engram: no pude ver qué memoria está pendiente (${paraMostrar(e.message, 200)})\n`);
    return 2;
  }
  let malos = 0;
  for (const p of archivos) {
    const nombre = paraMostrar(p.ruta, 120);
    // el nombre del archivo también viaja
    const enElNombre = formasDe(p.ruta);
    if (enElNombre.length) { malos += 1; process.stderr.write(`⛔ engram: el nombre de ${nombre} trae ${enElNombre.join(', ')}.\n`); }
    let hallazgos;
    try { hallazgos = revisarContenido(leer(repo, p), p.ruta); } catch (e) {
      malos += 1;
      process.stderr.write(`⛔ engram: ${nombre} (${p.de}) no se pudo leer (${/^[A-Z_]{2,30}$/.test(String(e.code)) ? e.code : 'no es texto ni gzip legible, o pasa el tope'}): no se puede saber si trae una clave. Borralo o volvé a exportarlo.\n`);
      continue;
    }
    for (const h of hallazgos) {
      malos += 1;
      process.stderr.write(`⛔ engram: ${nombre} (${p.de}), nota «${h.nota}»: ${h.formas.join(', ')}.\n`);
    }
  }
  if (malos) {
    process.stderr.write('⛔ engram: el commit no se crea — esa memoria iría con la clave al repo y a su historia. Sacá la clave de la nota en engram y borrá de .engram/ el archivo que la trae; el commit pasa cuando ningún archivo pendiente la tiene.\n');
    return 1;
  }
  return 0;
}

module.exports = { formasDe, paraMostrar, revisarContenido, revisarArchivo, pendientes };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
