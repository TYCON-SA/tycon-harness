'use strict';
// protected-photo.js — la foto de lo que el freno de escrituras por consola protege, para mirarlo de nuevo después del
// comando (on-bash-write-after.js).
//
// Lo protegido: las historias que no están en borrador (todo su contenido, y que sigan siendo historias), el `status:`
// de los borradores, las historias nuevas que no nacen en borrador, las constancias (`.github|.tycon/control-changes/` y
// `control-changes.jsonl`) y los marcadores de la ejecución (`<estado>/active/`, `<estado>/active.json`; de esos, sólo que
// no se borren: su contenido lo cambia marker.js). Los demás `.md` de las carpetas de historias entran en la foto sin
// protegerse: si uno se vuelve una historia fuera de borrador, vuelve a lo que tenía, no se borra.
//
// La foto guarda la huella (sha256) de cada archivo y una copia de cada versión, una sola vez por huella, en
// `<estado>/write-photos/blobs/`; las copias que nadie usó en 7 días se borran. Por contenido y no por tamaño y hora: un
// guion puede cambiar una letra y devolverle la hora con `touch -r` o `os.utimes`. Un archivo protegido que quedó como
// enlace simbólico o sin permiso de lectura es una diferencia. Nada se escribe ni se borra si el camino real de su
// carpeta ya no es el de la foto (un enlace puesto en el medio la llevaría afuera).
//
// Límites: una historia nueva en una carpeta donde no había ninguna no se ve (las carpetas son las que ya tenían
// historias), y sólo se miran los repos que se le pasan (el de la sesión y los de cada `cd` del comando).
//
// Casos: skills/tycon-pipeline/scripts/tests/bash-write-after.test.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIAS_DE_LAS_COPIAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 3000;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirFotos = (stateDir) => path.join(stateDir, 'write-photos');
const dirCopias = (stateDir) => path.join(dirFotos(stateDir), 'blobs');

/**
 * El estado de una historia por su texto: `'draft'`, otro estado, `''` (sin `status:`), o null si no es una historia.
 * Es borrador sólo si todas las formas de `status:` del encabezado (con comillas o con un espacio antes de los dos
 * puntos) dicen `draft`: el lector del arnés toma `status:` a secas, y una clave citada no puede tapar a otra.
 */
function estadoDelTexto(texto) {
  const t = String(texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { declaresStoryIdentity } = require('./story-discovery.js');
  if (!declaresStoryIdentity(t)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(t);
  const estados = fm ? [...fm[1].matchAll(/^[ \t]*["']?status["']?[ \t]*:[ \t]*["']?([\w-]*)/gm)].map((m) => m[1].toLowerCase()) : [];
  if (!estados.length) return '';
  return estados.every((e) => e === 'draft') ? 'draft' : (estados.find((e) => e !== 'draft') || '');
}

/** Lo que hay en `abs`: `{ link }`, `{ ilegible }`, `{ contenido }`, o null si no existe. */
function mirar(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : { ilegible: e.code || e.message }; }
  if (st.isSymbolicLink()) return { link: true };
  if (!st.isFile()) return null;
  try { return { contenido: fs.readFileSync(abs) }; } catch (e) { return { ilegible: e.code || e.message }; }
}

/** Escribe `contenido` en `abs` entero o nada: un archivo temporal al lado y un cambio de nombre (reemplaza un enlace). */
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
  const m = mirar(path.join(dirCopias(stateDir), huella));
  // una copia que no coincide con su huella no se usa para restaurar
  return m && m.contenido && sha(m.contenido) === huella ? m.contenido : null;
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

/** Las entradas de una carpeta que son archivos o enlaces (sin bajar), filtradas por nombre. */
function entradas(dir, filtro = () => true) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isFile() || e.isSymbolicLink()) && filtro(e.name)).map((e) => path.join(dir, e.name)); } catch (_) { return []; }
}

/** Los archivos de constancia de un repo que existen hoy. */
function constanciasDe(root) {
  const out = [];
  for (const base of ['.github', '.tycon']) {
    out.push(...entradas(path.join(root, base), (n) => n === 'control-changes.jsonl'));
    const recorrer = (d) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) recorrer(f); else out.push(f); }
    };
    recorrer(path.join(root, base, 'control-changes'));
  }
  return out;
}

const marcadoresDe = (stateDir) => [...entradas(stateDir, (n) => n === 'active.json'), ...entradas(path.join(stateDir, 'active'))];

/** Las carpetas con historias de cada repo (las del descubridor). */
function carpetasDeHistorias(roots) {
  const { findStoryDirs } = require('./story-discovery.js');
  const dirs = new Set();
  for (const r of roots) for (const d of findStoryDirs(r)) dirs.add(d);
  return [...dirs].sort();
}

/**
 * Lo que hay hoy en disco: `{ abs: { kind, sha?, status?, contenido?, link?, ilegible? } }`. `kind`: `story`, `md` (un
 * `.md` de una carpeta de historias que no es historia), `constancia` o `marker`.
 */
function relevar({ roots, storyDirs, stateDir }) {
  const out = {};
  const anotar = (abs, kind, conEstado) => {
    const m = mirar(abs);
    if (!m) return;
    if (!m.contenido) { out[abs] = { kind, ...m }; return; }
    const e = { kind, sha: sha(m.contenido), contenido: m.contenido };
    if (conEstado) {
      const status = estadoDelTexto(m.contenido.toString('utf8'));
      if (status === null) e.kind = 'md'; else e.status = status;
    }
    out[abs] = e;
  };
  for (const dir of storyDirs) for (const abs of entradas(dir, (n) => /\.md$/i.test(n))) anotar(abs, 'story', true);
  for (const r of roots) for (const abs of constanciasDe(r)) anotar(abs, 'constancia', false);
  for (const abs of marcadoresDe(stateDir)) anotar(abs, 'marker', false);
  return out;
}

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const huellaDeLaFoto = (f) => sha(JSON.stringify({ ...f, hash: undefined }));

/**
 * Saca la foto de lo protegido en `roots` y guarda las copias de cada versión.
 * @returns {{v, at, roots, bases, storyDirs, files: Object<string, {kind, sha?, status?, link?, ilegible?}>, hash}}
 */
function takePhoto({ roots, stateDir, now = Date.now() }) {
  const storyDirs = carpetasDeHistorias(roots);
  const hoy = relevar({ roots, storyDirs, stateDir });
  const files = {};
  for (const [abs, f] of Object.entries(hoy)) {
    if (f.contenido) guardarCopia(stateDir, f.sha, f.contenido);
    const { contenido, ...resto } = f;
    files[abs] = resto;
  }
  // el camino real de cada raíz: deshacer no escribe donde un enlace puesto en el medio la lleve afuera
  const bases = [...roots, stateDir].map((b) => [b, realOrNull(b)]).filter(([, r]) => r);
  const foto = { v: 2, at: now, roots, bases, storyDirs, files };
  foto.hash = huellaDeLaFoto(foto);
  try { limpiarCopias(stateDir, now); } catch (_) { /* la limpieza no frena nada */ }
  return foto;
}

/** ¿La foto es la que se sacó? (su huella coincide) */
const photoIntact = (foto) => Boolean(foto && foto.v === 2 && foto.files && Array.isArray(foto.bases) && foto.hash === huellaDeLaFoto(foto));

/**
 * Lo que cambió de lo protegido desde la foto, con lo que hay que hacer para deshacerlo:
 * `[{ abs, kind, que, deshacer: 'restaurar'|'borrar', sha? }]`.
 */
function differences(foto, { stateDir }) {
  const hoy = relevar({ roots: foto.roots, storyDirs: foto.storyDirs, stateDir });
  const out = [];
  const raro = (a) => (a.link ? 'quedó como enlace simbólico' : `no se puede leer (${a.ilegible})`);
  for (const [abs, antes] of Object.entries(foto.files)) {
    const ahora = hoy[abs];
    const restaurar = (que) => out.push({ abs, kind: antes.kind, que, deshacer: 'restaurar', sha: antes.sha });
    if (antes.link || antes.ilegible) continue;   // sin copia de lo que había: no hay a qué volver
    if (antes.kind === 'md') {
      if (ahora && ahora.kind === 'story' && ahora.status !== 'draft') restaurar(`se volvió una historia fuera de borrador («${ahora.status || 'sin estado'}»)`);
      else if (ahora && (ahora.link || ahora.ilegible) && foto.storyDirs.includes(path.dirname(abs))) {
        // un `.md` que quedó como enlace puede apuntar a una historia: el arnés la lee por el enlace
        restaurar(raro(ahora));
      }
      continue;
    }
    if (antes.kind === 'marker') { if (!ahora) restaurar('se borró'); continue; }
    if (antes.kind === 'story' && antes.status === 'draft') {
      // de un borrador cuenta sólo el estado: el cuerpo se sigue editando libre
      if (ahora && (ahora.link || ahora.ilegible)) restaurar(raro(ahora));
      else if (ahora && ahora.kind === 'story' && ahora.status !== 'draft') restaurar(`dejó de estar en borrador (quedó en «${ahora.status || 'sin estado'}»)`);
      continue;
    }
    if (!ahora) { restaurar('se borró'); continue; }
    if (ahora.link || ahora.ilegible) { restaurar(raro(ahora)); continue; }
    if (antes.kind === 'story' && ahora.kind !== 'story') { restaurar('dejó de ser una historia'); continue; }
    if (ahora.sha !== antes.sha) restaurar('se cambió');
  }
  for (const [abs, ahora] of Object.entries(hoy)) {
    if (foto.files[abs]) continue;
    const borrar = (que) => out.push({ abs, kind: ahora.kind, que, deshacer: 'borrar' });
    if (ahora.kind === 'story' && ahora.status !== 'draft') borrar(`se creó fuera de borrador («${ahora.status || 'sin estado'}»)`);
    else if (ahora.kind === 'story' && ahora.link) borrar('se creó como enlace simbólico');
    else if (ahora.kind === 'constancia') borrar('se creó');
  }
  return out;
}

/** ¿El camino real de la carpeta de `abs` es el que tenía en la foto? (sin un enlace puesto en el medio) */
function carpetaSinEnlaces(foto, abs) {
  let d = path.dirname(abs);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  for (const [base, real] of foto.bases) {
    if (d !== base && !d.startsWith(base + path.sep)) continue;
    return realOrNull(d) === real + d.slice(base.length);
  }
  return false;
}

/**
 * Las diferencias que trajo git y no un guion: con un comando que es sólo git, lo que quedó es igual a lo commiteado
 * (`HEAD` después del comando), o lo borrado no está en `HEAD`. Un gancho de git que escribe otra cosa no coincide.
 */
function traidasPorGit(foto, diferencias) {
  const raizDe = (abs) => foto.roots.find((r) => abs.startsWith(r + path.sep));
  return diferencias.filter((d) => {
    const raiz = raizDe(d.abs);
    if (!raiz || d.kind === 'marker') return false;
    const rel = path.relative(raiz, d.abs).split(path.sep).join('/');
    let enHead = null;
    try { enHead = execFileSync('git', ['-C', raiz, 'show', `HEAD:${rel}`], { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { enHead = null; }
    const m = mirar(d.abs);
    if (!m) return enHead === null;
    return Boolean(enHead && m.contenido && Buffer.compare(enHead, m.contenido) === 0);
  });
}

/** Deshace cada diferencia. Devuelve `{ hechas: [], fallas: [{ abs, motivo }] }`. */
function undo(foto, diferencias, { stateDir }) {
  const hechas = [];
  const fallas = [];
  for (const d of diferencias) {
    try {
      if (!carpetaSinEnlaces(foto, d.abs)) { fallas.push({ abs: d.abs, motivo: 'su carpeta ya no es la de la foto (un enlace en el camino): no toqué nada' }); continue; }
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

module.exports = { takePhoto, photoIntact, differences, undo, gitBrought: traidasPorGit, photosDir: dirFotos, writeWhole: escribirEntero, storyStatusOf: estadoDelTexto };
