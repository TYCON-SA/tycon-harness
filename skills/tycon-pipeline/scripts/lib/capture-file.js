#!/usr/bin/env node
'use strict';
/**
 * capture-file.js — ¿sirve este archivo como captura o grabación del navegador? Una sola respuesta para el portón E2E
 * (`e2e-evidence.js captures`) y para el humo (`smoke-run.sh --capture`).
 *
 * Una imagen que entra a la evidencia viaja por git y la lee un revisor: no puede ser un enlace simbólico (apuntaría a
 * un archivo de la máquina de quien la sacó), ni pasar de 50 MB, y tiene que ser de verdad lo que su extensión dice.
 * Se mira la extensión y los primeros bytes (la firma del formato); el contenido no se interpreta.
 *
 * CLI (para smoke-run.sh):
 *   capture-file.js check <archivo> <extensiones, separadas por coma>
 *        → exit 0 si sirve; si no, imprime el motivo y sale 1
 *   capture-file.js copy <archivo> <extensiones> <carpeta-de-evidencia> <clave> <ts>
 *        → imprime «OK <ruta relativa> <sha256>» (exit 0) o «ERR <motivo como JSON>» (exit 1); la copia queda en
 *          <carpeta>/<clave>-smoke-captures/<ts compacto>-<6 hex>.<ext>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 50 * 1024 * 1024;

// Firma de cada formato en sus primeros 12 bytes.
const SIGNATURES = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  gif: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  webm: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
};

/** La extensión en minúsculas, sin el punto. */
function extOf(file) { return path.extname(String(file)).slice(1).toLowerCase(); }

/**
 * Por qué el archivo no sirve, o null si sirve. `exts` son las extensiones que la situación acepta (todas, si falta).
 */
function problem(file, exts) {
  const permitidas = (exts || Object.keys(SIGNATURES)).filter((e) => SIGNATURES[e]);
  const ext = extOf(file);
  if (!permitidas.includes(ext)) return `la extensión .${ext || '(ninguna)'} no sirve: sólo ${permitidas.map((e) => '.' + e).join(', ')}`;
  let st;
  try { st = fs.lstatSync(file); } catch { return 'el archivo no existe'; }
  if (st.isSymbolicLink()) return 'es un enlace simbólico';
  if (!st.isFile()) return 'no es un archivo';
  if (st.size > MAX_BYTES) return 'pesa más de 50 MB';
  const head = Buffer.alloc(12);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 12, 0);
  } catch (e) { return `no se pudo leer (${e.code || e.message})`; } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!SIGNATURES[ext](head)) return `sus primeros bytes no son de un .${ext}`;
  return null;
}

/** Copia el archivo a la carpeta de capturas del humo. → { rel, sha } o lanza con el motivo. */
function copyForSmoke(file, exts, dir, key, ts) {
  const motivo = problem(file, exts);
  if (motivo) throw new Error(motivo);
  const rel = `${key}-smoke-captures/${String(ts).replace(/[-:]/g, '')}-${crypto.randomBytes(3).toString('hex')}.${extOf(file)}`;
  try {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(file, path.join(dir, rel));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    return { rel, sha };
  } catch (e) { throw new Error(`no se pudo copiar (${e.code || e.message})`); }
}

module.exports = { problem, copyForSmoke, extOf, MAX_BYTES, SIGNATURES };

if (require.main === module) {
  const [cmd, file, exts, dir, key, ts] = process.argv.slice(2);
  const lista = String(exts || '').split(',').filter(Boolean);
  if (cmd === 'check') {
    const m = problem(file, lista);
    if (m) { process.stdout.write(m); process.exit(1); }
    process.exit(0);
  }
  if (cmd === 'copy') {
    try {
      const { rel, sha } = copyForSmoke(file, lista, dir, key, ts);
      process.stdout.write(`OK ${rel} ${sha}`);
    } catch (e) {
      process.stdout.write(`ERR ${JSON.stringify(e.message)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  console.error('uso: capture-file.js check <archivo> <extensiones> | copy <archivo> <extensiones> <carpeta> <clave> <ts>');
  process.exit(2);
}
