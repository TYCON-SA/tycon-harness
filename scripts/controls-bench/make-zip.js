'use strict';
/**
 * make-zip.js — arma un .zip sin compresión con los archivos de una carpeta, para la preparación de un caso del banco.
 *
 * Uso: node "$TCG/scripts/controls-bench/make-zip.js" <salida.zip> <carpeta>
 *
 * El agente de Windows no trae `zip`, y la preparación de un caso no puede depender de un programa que la máquina no
 * tiene: node sí está en todas. Los nombres van relativos a la carpeta, con barras hacia adelante, como los deja `zip`.
 */
const fs = require('fs');
const path = require('path');

const TABLA = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLA[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function archivos(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? archivos(p, base) : e.isFile() ? [path.relative(base, p).split(path.sep).join('/')] : [];
  });
}

function makeZip(salida, carpeta) {
  const locales = [];
  const central = [];
  let offset = 0;
  const lista = archivos(carpeta);
  for (const rel of lista) {
    const datos = fs.readFileSync(path.join(carpeta, rel));
    const nombre = Buffer.from(rel, 'utf8');
    const crc = crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    const entrada = Buffer.alloc(46);
    entrada.writeUInt32LE(0x02014b50, 0);
    entrada.writeUInt16LE(20, 4);
    entrada.writeUInt16LE(20, 6);
    entrada.writeUInt32LE(crc, 16);
    entrada.writeUInt32LE(datos.length, 20);
    entrada.writeUInt32LE(datos.length, 24);
    entrada.writeUInt16LE(nombre.length, 28);
    entrada.writeUInt32LE(offset, 42);
    locales.push(local, nombre, datos);
    central.push(entrada, nombre);
    offset += local.length + nombre.length + datos.length;
  }
  const directorio = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(lista.length, 8);
  fin.writeUInt16LE(lista.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  fs.writeFileSync(salida, Buffer.concat([...locales, directorio, fin]));
}

if (require.main === module) {
  const [salida, carpeta] = process.argv.slice(2);
  if (!salida || !carpeta) {
    console.error('uso: node make-zip.js <salida.zip> <carpeta>');
    process.exit(2);
  }
  makeZip(salida, carpeta);
}

module.exports = { makeZip };
