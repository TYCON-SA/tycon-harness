'use strict';
// protected-photo.js — la foto de lo que el freno de escrituras por consola protege, para mirarlo de nuevo después del
// comando (on-bash-write-after.js).
//
// Lo protegido: las historias que no están en borrador (todo su contenido), el `status:` de los borradores, las
// historias nuevas que no nacen en borrador, las constancias (`.github|.tycon/control-changes/` y `control-changes.jsonl`)
// y los marcadores de la ejecución (`<estado>/active/`, `<estado>/active.json`; de esos, sólo que no se borren: su
// contenido lo cambia marker.js). La foto guarda la huella (sha256) de cada archivo y una copia de cada versión, una sola
// vez por huella, en `<estado>/write-photos/blobs/`; las copias que nadie usó en 7 días se borran.
//
// Por qué por contenido y no por tamaño y hora: un guion puede cambiar una letra y devolverle la hora con `touch -r` o
// `os.utimes`. Límites: una historia nueva en una carpeta donde no había ninguna no se ve (las carpetas son las que ya
// tenían historias), y sólo se miran los repos que se le pasan (el de la sesión y los de cada `cd` del comando).
//
// Casos: skills/tycon-pipeline/scripts/tests/bash-write-after.test.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIAS_DE_LAS_COPIAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirFotos = (stateDir) => path.join(stateDir, 'write-photos');
const dirCopias = (stateDir) => path.join(dirFotos(stateDir), 'blobs');

/** El estado de una historia por su texto: `'draft'`, otro estado, `''` (sin `status:`), o null si no es una historia. */
function estadoDelTexto(texto) {
  const t = String(texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { declaresStoryIdentity } = require('./story-discovery.js');
  if (!declaresStoryIdentity(t)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(t);
  const m = fm && /^["']?status["']?\s*:\s*["']?([\w-]+)/m.exec(fm[1]);
  return m ? m[1].toLowerCase() : '';
}

function leer(abs) {
  try { return fs.readFileSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'EISDIR') return null; throw e; }
}

/** Escribe `contenido` en `abs` entero o nada: un archivo temporal al lado y un cambio de nombre. */
function escribirEntero(abs, contenido) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, abs);
}

/** Guarda la copia de una versión si no está, o le renueva la hora para que la limpieza no la borre. */
function guardarCopia(stateDir, huella, contenido) {
  const f = path.join(dirCopias(stateDir), huella);
  try {
    const ahora = new Date(); // stable-data: la hora de uso de la copia, para la limpieza de 7 días
    fs.utimesSync(f, ahora, ahora);
  } catch (_) { escribirEntero(f, contenido); }
}

function copia(stateDir, huella) {
  const contenido = leer(path.join(dirCopias(stateDir), huella));
  // una copia que no coincide con su huella no se usa para restaurar
  return contenido && sha(contenido) === huella ? contenido : null;
}

/** Borra las copias que nadie usó en 7 días; corre a lo sumo una vez por día. */
function limpiarCopias(stateDir, ahora) {
  const sello = path.join(dirFotos(stateDir), '.limpieza');
  try { if (ahora - fs.statSync(sello).mtimeMs < DIA_MS) return; } catch (_) { /* nunca se limpió */ }
  let nombres = [];
  try { nombres = fs.readdirSync(dirCopias(stateDir)); } catch (_) { return; }
  for (const n of nombres) {
    const f = path.join(dirCopias(stateDir), n);
    try { if (ahora - fs.statSync(f).mtimeMs > DIAS_DE_LAS_COPIAS * DIA_MS) fs.unlinkSync(f); } catch (_) { /* otra la borró */ }
  }
  escribirEntero(sello, '');
}

/** Los `.md` de una carpeta (sin bajar: cada carpeta con historias viene en la lista). */
function mdsDe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => path.join(dir, e.name)); } catch (_) { return []; }
}

/** Los archivos de constancia de un repo que existen hoy. */
function constanciasDe(root) {
  const out = [];
  for (const base of ['.github', '.tycon']) {
    const archivo = path.join(root, base, 'control-changes.jsonl');
    if (fs.existsSync(archivo)) out.push(archivo);
    const carpeta = path.join(root, base, 'control-changes');
    const recorrer = (d) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) recorrer(f); else if (e.isFile()) out.push(f); }
    };
    recorrer(carpeta);
  }
  return out;
}

function marcadoresDe(stateDir) {
  const out = [];
  const activo = path.join(stateDir, 'active.json');
  if (fs.existsSync(activo)) out.push(activo);
  try { for (const e of fs.readdirSync(path.join(stateDir, 'active'), { withFileTypes: true })) if (e.isFile()) out.push(path.join(stateDir, 'active', e.name)); } catch (_) { /* sin carpeta */ }
  return out;
}

/** Las carpetas con historias de cada repo (las del descubridor). */
function carpetasDeHistorias(roots) {
  const { findStoryDirs } = require('./story-discovery.js');
  const dirs = new Set();
  for (const r of roots) for (const d of findStoryDirs(r)) dirs.add(d);
  return [...dirs].sort();
}

/** Lo que hay hoy en disco de lo protegido: `{ abs: { kind, sha, status?, contenido } }`. */
function relevar({ roots, storyDirs, stateDir }) {
  const out = {};
  for (const dir of storyDirs) {
    for (const abs of mdsDe(dir)) {
      const c = leer(abs);
      if (c === null) continue;
      const status = estadoDelTexto(c.toString('utf8'));
      if (status === null) continue;
      out[abs] = { kind: 'story', sha: sha(c), status, contenido: c };
    }
  }
  for (const r of roots) for (const abs of constanciasDe(r)) { const c = leer(abs); if (c !== null) out[abs] = { kind: 'constancia', sha: sha(c), contenido: c }; }
  for (const abs of marcadoresDe(stateDir)) { const c = leer(abs); if (c !== null) out[abs] = { kind: 'marker', sha: sha(c), contenido: c }; }
  return out;
}

const huellaDeLaFoto = (f) => sha(JSON.stringify({ ...f, hash: undefined }));

/**
 * Saca la foto de lo protegido en `roots` y guarda las copias de cada versión.
 * @returns {{v, at, roots, storyDirs, files: Object<string, {kind, sha, status?}>, hash}}
 */
function takePhoto({ roots, stateDir, now = Date.now() }) {
  const storyDirs = carpetasDeHistorias(roots);
  const hoy = relevar({ roots, storyDirs, stateDir });
  const files = {};
  for (const [abs, f] of Object.entries(hoy)) {
    guardarCopia(stateDir, f.sha, f.contenido);
    files[abs] = f.kind === 'story' ? { kind: f.kind, sha: f.sha, status: f.status } : { kind: f.kind, sha: f.sha };
  }
  const foto = { v: 1, at: now, roots, storyDirs, files };
  foto.hash = huellaDeLaFoto(foto);
  try { limpiarCopias(stateDir, now); } catch (_) { /* la limpieza no frena nada */ }
  return foto;
}

/** ¿La foto es la que se sacó? (su huella coincide) */
const photoIntact = (foto) => Boolean(foto && foto.v === 1 && foto.files && foto.hash === huellaDeLaFoto(foto));

/**
 * Lo que cambió de lo protegido desde la foto, con lo que hay que hacer para deshacerlo:
 * `[{ abs, kind, que, deshacer: 'restaurar'|'borrar', sha? }]`.
 */
function differences(foto, { stateDir }) {
  const hoy = relevar({ roots: foto.roots, storyDirs: foto.storyDirs, stateDir });
  const out = [];
  for (const [abs, antes] of Object.entries(foto.files)) {
    const ahora = hoy[abs];
    if (antes.kind === 'story' && antes.status === 'draft') {
      // de un borrador cuenta sólo el estado: el cuerpo se sigue editando libre
      if (ahora && ahora.status !== 'draft') out.push({ abs, kind: 'story', que: `dejó de estar en borrador (quedó en «${ahora.status || 'sin estado'}»)`, deshacer: 'restaurar', sha: antes.sha });
      continue;
    }
    if (antes.kind === 'marker') {
      if (!fs.existsSync(abs)) out.push({ abs, kind: 'marker', que: 'se borró', deshacer: 'restaurar', sha: antes.sha });
      continue;
    }
    if (!ahora) { if (!fs.existsSync(abs)) out.push({ abs, kind: antes.kind, que: 'se borró', deshacer: 'restaurar', sha: antes.sha }); continue; }
    if (ahora.sha !== antes.sha) out.push({ abs, kind: antes.kind, que: 'se cambió', deshacer: 'restaurar', sha: antes.sha });
  }
  for (const [abs, ahora] of Object.entries(hoy)) {
    if (foto.files[abs]) continue;
    if (ahora.kind === 'story' && ahora.status !== 'draft') out.push({ abs, kind: 'story', que: `se creó fuera de borrador («${ahora.status || 'sin estado'}»)`, deshacer: 'borrar' });
    if (ahora.kind === 'constancia') out.push({ abs, kind: 'constancia', que: 'se creó', deshacer: 'borrar' });
  }
  return out;
}

/** Deshace cada diferencia. Devuelve `{ hechas: [], fallas: [{ abs, motivo }] }`. */
function undo(diferencias, { stateDir }) {
  const hechas = [];
  const fallas = [];
  for (const d of diferencias) {
    try {
      if (d.deshacer === 'borrar') fs.rmSync(d.abs, { force: true });
      else {
        const c = copia(stateDir, d.sha);
        if (!c) { fallas.push({ abs: d.abs, motivo: 'no está la copia de lo que había, o no coincide con su huella' }); continue; }
        escribirEntero(d.abs, c);
      }
      hechas.push(d);
    } catch (e) { fallas.push({ abs: d.abs, motivo: e.code || e.message }); }
  }
  return { hechas, fallas };
}

module.exports = { takePhoto, photoIntact, differences, undo, photosDir: dirFotos, writeWhole: escribirEntero, storyStatusOf: estadoDelTexto };
