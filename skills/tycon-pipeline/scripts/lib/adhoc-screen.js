'use strict';
/**
 * adhoc-screen.js — la pantalla en el camino rápido: un arreglo sin historia que toca una pantalla no guarda sin su
 * maqueta aprobada y una captura de lo construido. Lo pide el freno de guardar (save-brake.js) y lo anota `marker.js
 * adhoc`: la maqueta y su aprobación con `adhoc set` (firmado), la captura con `adhoc capture` (sin firma: no aprueba
 * nada, y acá se mide).
 *
 *   revisar(adhoc, repos)     `{ pantallas, faltan, mostrar }`, o `{ sinMedir }` si no se pudo medir: sin medir no guarda.
 *   problemaDeLaMaqueta(ruta) `{ sha256 }` o `{ problema }`: que exista y pase `mockup.js check`.
 *   problemaDeLaCaptura(ruta) el problema en una frase, o null: que sea una imagen de verdad y no esté vacía.
 *
 * Qué es una pantalla lo dice el pipeline (`ui-signal.js`, con la regla `screen_test` de la organización), archivo por
 * archivo; una prueba no lo es. La captura vale si es más nueva que el último cambio de los archivos del carril.
 *
 * Lo que no ve: la fecha de un archivo se puede cambiar, y una imagen de verdad puede no mostrar esa pantalla. Sin la base
 * del carril (sin red al abrirlo) mide lo anotado y el commit, no el resto de la rama: sigue y lo avisa, como el resto del
 * camino rápido.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIRMAS_DE_IMAGEN = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const rutaReal = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(String(p)); } };
// una ruta en un renglón: va al texto que lee la persona antes de aprobar, y no puede armar renglones falsos
const enUnRenglon = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

function problemaDeLaMaqueta(ruta) {
  const mk = require('../mockup.js');
  let html;
  try { html = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { problema: `no pude leer la maqueta ${enUnRenglon(ruta)} (${e.code || e.message})` }; }
  const v = mk.validateMockupHtml(html);
  if (!v.ok) return { problema: `la maqueta ${enUnRenglon(ruta)} no pasa mockup.js check (${v.findings[0].what})` };
  return { sha256: mk.mockupHash(html) };
}

function problemaDeLaCaptura(ruta) {
  const firma = FIRMAS_DE_IMAGEN[path.extname(String(ruta)).toLowerCase()];
  const dicha = enUnRenglon(ruta);
  if (!firma) return `la captura ${dicha} no es una imagen .png, .jpg o .webp`;
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    if (!firma(buf.subarray(0, n))) return `la captura ${dicha} no es una imagen: está vacía o su contenido no coincide con su extensión`;
  } catch (e) {
    return `no pude leer la captura ${dicha} (${e.code || e.message})`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// El nombre del repo, también desde un worktree: en una historia la entrada lleva el del repo (`(FrontEnd) x.ts`), no el
// de la carpeta de trabajo.
function nombreDelRepo(repo) {
  const comun = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
  return path.basename(path.dirname(path.resolve(repo, comun)));
}

function reglaDePantalla() {
  return require('./stack-config.js').orgRules().rules.screen_test.value;
}

// Lo que le falta a la maqueta y a la captura anotadas, cada cosa en una frase.
function faltantes(adhoc, ultimaEdicion) {
  const faltan = [];
  const maqueta = adhoc.mockup;
  if (!maqueta || typeof maqueta.file !== 'string' || !maqueta.approval) {
    faltan.push('la maqueta aprobada');
  } else {
    const m = problemaDeLaMaqueta(maqueta.file);
    if (m.problema) faltan.push(m.problema);
    else if (m.sha256 !== maqueta.sha256) faltan.push(`volver a aprobar la maqueta: ${enUnRenglon(maqueta.file)} cambió después de aprobada`);
  }
  const captura = adhoc.capture;
  if (!captura || typeof captura.file !== 'string') {
    faltan.push('la captura de lo construido');
    return faltan;
  }
  const p = problemaDeLaCaptura(captura.file);
  if (p) { faltan.push(p); return faltan; }
  if (fs.statSync(captura.file).mtimeMs <= ultimaEdicion) faltan.push(`una captura nueva: ${enUnRenglon(captura.file)} es anterior al último cambio del carril`);
  return faltan;
}

// La fecha de un archivo del carril. Uno borrado no tiene: vale la de su carpeta, que cambió al borrarlo (o la de la primera
// que siga en pie). Otro cambio en esa carpeta también la mueve: del lado seguro, pide otra captura.
function fechaDelCambio(abs) {
  for (let p = abs; ; p = path.dirname(p)) {
    try { return fs.statSync(p).mtimeMs; } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e.code) || path.dirname(p) === p) throw e;
    }
  }
}

// Una prueba por su nombre o por una carpeta de pruebas en la raíz. Una carpeta `test/` más adentro puede ser una pantalla
// de verdad (la ruta `/test` de `src/app/test/page.tsx`).
const esPrueba = (rel) => /\.(test|spec)\.[^./]+$/i.test(rel) || /(^|\/)__tests__\//.test(rel) || /^(tests?|e2e)\//i.test(rel);

function revisar(adhoc, repos = []) {
  const { archivosDelCarril } = require('./adhoc-base.js');
  const { isCodeFile } = require('./story-gate.js');
  const { fileTouchesUi } = require('./ui-signal.js');
  // un repo anotado que ya no está (un worktree borrado) no tiene nada que guardar: no es «no pude medir». Otro error al
  // mirarlo (sin permiso, un disco desmontado) sí lo es, y sube
  const sigue = (repo) => { try { fs.statSync(repo); return true; } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; } };
  const bases = Object.fromEntries(Object.entries(adhoc.bases || {}).filter(([repo]) => sigue(repo)));
  const { porRepo, fallas, avisos } = archivosDelCarril({ ...adhoc, bases }, { repos });
  if (fallas.length) return { sinMedir: fallas[0] };
  const anotadas = new Set([adhoc.mockup, adhoc.capture].filter((x) => x && typeof x.file === 'string').map((x) => rutaReal(x.file)));
  const regla = reglaDePantalla();
  const pantallas = [];
  let ultimaEdicion = -Infinity;
  for (const repo of Object.keys(porRepo)) {
    const nombre = nombreDelRepo(repo);
    for (const rel of porRepo[repo]) {
      const abs = path.join(repo, rel);
      if (anotadas.has(rutaReal(abs))) continue;
      const esPantalla = !esPrueba(rel) && fileTouchesUi(rel, repo, regla, nombre);
      if (esPantalla) pantallas.push(enUnRenglon(abs));
      if (!esPantalla && !isCodeFile(rel)) continue;
      ultimaEdicion = Math.max(ultimaEdicion, fechaDelCambio(abs));
    }
  }
  if (!pantallas.length) return { pantallas, faltan: [], mostrar: null, avisos };
  const dicha = (x) => (x && typeof x.file === 'string' ? enUnRenglon(x.file) : 'sin anotar');
  return { pantallas, faltan: faltantes(adhoc, ultimaEdicion), mostrar: `Maqueta: ${dicha(adhoc.mockup)} · captura: ${dicha(adhoc.capture)}.`, avisos };
}

module.exports = { revisar, problemaDeLaMaqueta, problemaDeLaCaptura, enUnRenglon };
