'use strict';
// image-files.js — qué archivos del repo entran a la imagen del sitio, sin Docker: los que deja pasar la lista de
// scripts/site/Dockerfile.dockerignore (como la lee BuildKit: la última regla que coincide manda, y una regla que
// coincide con una carpeta vale para lo que tiene adentro) y además cubre alguna línea COPY de scripts/site/Dockerfile.
// Todas las COPY del sitio dejan cada archivo en su misma ruta bajo /app, así que la ruta del repo es la de la imagen.
//
//   imageFiles(root, archivos)   →   { entran: [rutas], afueraDeCopy: [rutas que la lista deja pasar y ninguna COPY copia] }
const fs = require('fs');
const path = require('path');

/**
 * Un patrón de .dockerignore o de COPY a expresión regular sobre una ruta con «/». Lo que no sabe leer como BuildKit
 * (una barra al principio, `[!…]`, un `[` sin cerrar) lo dice tirando: una simulación que adivina daría otra lista.
 */
function patron(glob) {
  let g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (g.startsWith('/') || g.includes('[!') || g.includes('[^')) throw new Error(`image-files: el patrón «${glob}» usa una forma que esta simulación no sabe leer como BuildKit`);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const fin = g.indexOf(']', i);
      if (fin < 0) throw new Error(`image-files: el patrón «${glob}» abre «[» y no lo cierra`);
      re += g.slice(i, fin + 1); i = fin;
    }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Si el patrón coincide con la ruta o con alguna de sus carpetas. */
function coincide(re, ruta) {
  const partes = ruta.split('/');
  for (let k = partes.length; k > 0; k--) if (re.test(partes.slice(0, k).join('/'))) return true;
  return false;
}

function reglasDeLaLista(texto) {
  return texto.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!') ? { entra: true, re: patron(l.slice(1)) } : { entra: false, re: patron(l) }));
}

function origenesDeCopy(texto) {
  const out = [];
  for (const [, args] of texto.matchAll(/^COPY\s+(.+)$/gm)) {
    // una COPY de otra etapa no copia del repo, y una partida en renglones no se lee entera: se dice, no se adivina
    if (/(^|\s)--from=/.test(args) || /\\\s*$/.test(args)) throw new Error(`image-files: «COPY ${args}» no es una copia del repo en un renglón; esta simulación no la sabe leer`);
    const partes = args.split(/\s+/).filter((x) => !x.startsWith('--'));
    for (const o of partes.slice(0, -1)) out.push(patron(o));
  }
  return out;
}

function imageFiles(root, archivos) {
  const site = path.join(root, 'scripts', 'site');
  const reglas = reglasDeLaLista(fs.readFileSync(path.join(site, 'Dockerfile.dockerignore'), 'utf8'));
  const copias = origenesDeCopy(fs.readFileSync(path.join(site, 'Dockerfile'), 'utf8'));
  const entran = [];
  const afueraDeCopy = [];
  for (const f of archivos) {
    let pasa = true;
    for (const r of reglas) if (coincide(r.re, f)) pasa = r.entra;
    if (!pasa) continue;
    if (copias.some((re) => coincide(re, f))) entran.push(f); else afueraDeCopy.push(f);
  }
  return { entran, afueraDeCopy };
}

module.exports = { imageFiles, patron, coincide };
