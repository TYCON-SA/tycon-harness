'use strict';
// legacy-files.js — lee un archivo de deuda de un producto con su nombre nuevo o con el de antes
//
// 🔴 POR QUÉ VIVE EN scripts/ci Y NO USA resolveFile DE scripts/lib/legacy-names.js. Los pipelines de los productos
// corren los guiones de esta carpeta también desde el artefacto `arnes-ci`, que es SÓLO esta carpeta: ahí no hay
// scripts/lib ni el mapa de renombres. Como el traductor de opciones (legacy-options.js), los pares viven acá; una prueba
// del repo del equipo compara estos pares con las entradas `config-file` del mapa (scripts/lib/renames.json). Los
// lectores de fuera de scripts/ci (el nocturno de dependencias) usan este mismo archivo, así hay un solo lugar que sabe
// los nombres de antes. En el retiro se sacan los pares y, sin pares, se borra.
//
// Uso:
//   const { resolveDebtFile, readDebtAtRevision, LegacyFilesError } = require('./legacy-files.js');
//   const r = resolveDebtFile(repo, 'pending-tests.json', 'scripts/ci/<guion>.js');   // { name, abs, exists }
//   const t = readDebtAtRevision((rel) => git show base:rel, 'pending-tests.json', 'scripts/ci/<guion>.js');   // { name, text } | null
//
// Qué hace: lee el nombre nuevo si está, si no el viejo; con los dos de contenido distinto lanza LegacyFilesError, que
// nombra los dos (el lector lo trata como su «no puedo»). Cada nombre viejo leído se anota con la biblioteca general si
// está (registro de usos y, en Azure DevOps, el aviso de la corrida); en el artefacto, sin ella, deja igual el aviso.
// Guía: guides/maintaining/nombres-en-ingles.md.

const fs = require('fs');
const path = require('path');

/** nombre nuevo → nombre de antes, relativos a la raíz de cada repo de producto. Casos: scripts/tests/legacy-retire.test.js */
const PAIRS = Object.freeze({
  'pending-vulnerabilities.json': 'vulnerabilidades-pendientes.json',
  'pending-tests.json': 'pruebas-pendientes.json',
  'pending-options.json': 'opciones-pendientes.json',
  'pending-form-vulnerabilities.json': 'vulnerabilidades-formularios-pendientes.json',
});
/** El nombre de antes de una ruta relativa (`../pending-tests.json` → `../pruebas-pendientes.json`), o null sin par. */
const oldOf = (rel) => {
  const old = PAIRS[path.basename(rel)];
  return old ? path.join(path.dirname(rel), old) : null;
};

class LegacyFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyFilesError';
  }
}

// 🔴 stdout y stderr al mismo lugar = quien llama guarda la salida como dato: el aviso de la corrida terminaría adentro.
function sameOutput() {
  try { const a = fs.fstatSync(1); const b = fs.fstatSync(2); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
}

function note(old, nu, where) {
  let lib = null;
  try { lib = require('../lib/legacy-names.js'); } catch (e) {
    // sólo «no está» es el artefacto arnes-ci (sin scripts/lib); una biblioteca rota no se calla
    if (!(e && e.code === 'MODULE_NOT_FOUND' && /legacy-names\.js/.test(String(e.message)))) throw e;
  }
  const merged = sameOutput();
  if (lib && typeof lib.recordUse === 'function') {
    lib.recordUse({ kind: 'config-file', old, new: nu, script: where }, merged ? { env: { ...process.env, TF_BUILD: '' } } : {});
    return;
  }
  if (!merged && /^true$/i.test(String(process.env.TF_BUILD || ''))) {
    try {
      process.stderr.write(`##vso[task.logissue type=warning]nombre viejo «${old}» (config-file) en ${where}: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «${nu}» (el viejo se retira: guides/maintaining/nombres-en-ingles.md)\n`);
    } catch { /* anotar nunca rompe */ }
  }
}

/** ¿Existe? «No está» es false; cualquier otro error (un permiso) es «no pude mirar» y lanza. */
function exists(abs) {
  try { fs.statSync(abs); return true; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    throw new LegacyFilesError(`no pude mirar ${abs} (${(e && e.code) || (e && e.message) || e}) — revisá los permisos`);
  }
}

const twoNames = (nu, old, where) => new LegacyFilesError(`hay dos archivos de deuda con contenido distinto${where ? ` (lo lee ${where})` : ''}: ${nu} (el nombre nuevo) y ${old} (el de antes) — dejá uno solo, ${nu}`);

/**
 * Qué archivo de deuda leer en `repo`: `{ name, abs, exists }`. `nu` es relativo a `repo` y puede traer carpetas
 * (`../pending-form-vulnerabilities.json`, como lo pasa el pipeline de formularios). Sin par declarado, tal cual.
 */
function resolveDebtFile(repo, nu, where) {
  const old = oldOf(nu);
  const abs = path.join(repo, nu);
  if (!old) return { name: nu, abs, exists: exists(abs) };
  const oldAbs = path.join(repo, old);
  const hasNew = exists(abs);
  const hasOld = exists(oldAbs);
  if (!hasOld) return { name: nu, abs, exists: hasNew };
  // el uso se anota con el nombre solo, como lo nombra el mapa (la ruta puede traer `../`)
  if (!hasNew) { note(path.basename(old), path.basename(nu), where); return { name: old, abs: oldAbs, exists: true }; }
  let same = false;
  try { same = fs.readFileSync(abs).equals(fs.readFileSync(oldAbs)); } catch (e) {
    throw new LegacyFilesError(`no pude leer ${nu} o ${old} (${(e && e.code) || (e && e.message) || e})`);
  }
  if (!same) throw twoNames(nu, old, where);
  return { name: nu, abs, exists: true };
}

/**
 * El archivo de deuda en una revisión: `show(rel)` devuelve su texto, null si no está, o lanza si no pudo mirar (un git
 * que falla no es «no está en la base»: lanza LegacyFilesError). `{ name, text }`, o null si no está con ninguno de los
 * dos nombres. No anota uso: una revisión pasada es historia, y el commit que renombra el archivo deja el nombre viejo
 * en su base.
 */
function readDebtAtRevision(show, nu, where) {
  const get = (rel) => {
    let text;
    try { text = show(rel); } catch (e) {
      throw new LegacyFilesError(`no pude leer ${rel} de la revisión${where ? ` (lo lee ${where})` : ''}: ${(e && e.message) || e}`);
    }
    return text === null || text === undefined ? { ok: false } : { ok: true, text };
  };
  const nuevo = get(nu);
  const old = oldOf(nu);
  const viejo = old ? get(old) : { ok: false };
  if (!viejo.ok) return nuevo.ok ? { name: nu, text: nuevo.text } : null;
  if (!nuevo.ok) return { name: old, text: viejo.text };
  if (nuevo.text !== viejo.text) throw twoNames(nu, old, where);
  return { name: nu, text: nuevo.text };
}

module.exports = { PAIRS, LegacyFilesError, resolveDebtFile, readDebtAtRevision };
