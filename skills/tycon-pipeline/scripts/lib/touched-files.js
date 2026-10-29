#!/usr/bin/env node
'use strict';
/**
 * touched-files.js — ¿qué archivos toca la story, y SE SABE?
 *
 * El test-gate del arnés difiere las suites que declaran `gate_only_when_touching` (por ejemplo
 * exportador-real, 24-41 min) cuando la story no toca esas carpetas. Esta lib junta lo tocado de tres
 * fuentes y, sobre todo, dice si se pudo mirar:
 *   · `git diff --name-only <base>` — lo que cambió desde el commit en que arrancó la corrida;
 *   · `git ls-files --others --exclude-standard` — lo nuevo sin agregar al índice;
 *   · lo que la story DECLARA (`files_to_create` + `files_to_modify`) sólo como dato en `sources.declared`:
 *     no cuenta como tocado: el corte es el cambio real (ver `touchedFiles`).
 * Sin base, o con git fallando, `known: false` con el motivo: el que llama corre todo. Lo mismo si lo tocado sale vacío
 * y la rama trae commits que la principal no tiene: pueden ser de la story, commiteados antes de la base.
 * 🔴 No se reusa `changedFiles` de test-scope.js: traga los errores de git y devuelve [], así que
 *    «git falló» y «no hay cambios» se ven igual — justo lo que este corte no puede confundir.
 *
 * CLI: node touched-files.js <repo> [story-path] [base-ref] [base-source]  → imprime el JSON, siempre exit 0.
 *   base-source es el `source` de lib/coverage-base.js; con «HEAD» (base por defecto) la respuesta es «no sé».
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseDeclaredFiles } = require('./test-scope');

// «<carpeta>/**»: ruta relativa, sin comodines antes del /** final. Otra forma no se interpreta.
// Cada segmento excluye «/» (una barra doble no calza) y no puede ser «.» ni «..»: «scripts//<carpeta>/**»
// dejaría la suite diferida para siempre.
const PATTERN_RE = /^(?!(?:.*\/)?\.{1,2}\/)(?:[^*?[\]{}\s/]+\/)*[^*?[\]{}\s/]+\/\*\*$/;

function isValidPattern(p) {
  return typeof p === 'string' && PATTERN_RE.test(p);
}

/** true si algún archivo cae bajo alguna carpeta `<carpeta>/**` válida. */
function touches(files, patterns) {
  const prefixes = (patterns || []).filter(isValidPattern).map((p) => p.slice(0, -2));   // «a/b/»
  return (files || []).some((f) => prefixes.some((pre) => String(f).replace(/\\/g, '/').startsWith(pre)));
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  if (r.error) return { error: `git no se pudo ejecutar (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { error: `git ${args[0]} salió ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}` };
  return { out: r.stdout };
}

/** Cuántos commits tiene HEAD que la rama principal no tiene; la principal es la primera que exista de la lista. */
function branchCommits(repo) {
  for (const main of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(repo, ['rev-parse', '--verify', '-q', `${main}^{commit}`]).error) continue;
    const c = git(repo, ['rev-list', '--count', `${main}..HEAD`]);
    if (c.error) return { error: `no pude contar los commits propios de la rama (${c.error})` };
    return { main, count: Number(c.out.trim()) || 0 };
  }
  return { error: 'no hay rama principal (origin/main, origin/master, main ni master) contra la que contar los commits propios de la rama' };
}

const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

function touchedFiles({ repo, storyPath, baseRef, baseSource } = {}) {
  const sources = { declared: [], diff: [], untracked: [] };
  let storyError = null;
  if (storyPath) {
    try {
      // Las entradas `(otro-repo) ruta` son de OTRO repo: no se comparan contra carpetas de éste.
      sources.declared = parseDeclaredFiles(fs.readFileSync(storyPath, 'utf8'))
        .filter((f) => !/^\(/.test(f)).map((f) => f.replace(/\\/g, '/'));
    } catch (e) {
      storyError = `no pude leer la story ${storyPath} (${e.code || e.message})`;
    }
  }
  const unknown = (reason) => ({ known: false, files: [...new Set(sources.declared)], sources, reason });

  if (!baseRef) {
    return unknown(`no hay base de git contra la que comparar${storyError ? `; ${storyError}` : ''}`);
  }
  // Base = HEAD por defecto (sin marcador ni TYCON_COVERAGE_BASE: el gate corrido a mano sobre un commit
  // hecho): el diff no ve lo commiteado, así que «no aparece» no significa «no toca».
  if (baseSource === 'HEAD') {
    return unknown('la base de la corrida cayó a HEAD por defecto: lo ya commiteado no se ve en el diff');
  }
  // --no-renames: un archivo movido aparece como borrado en su ruta vieja + agregado en la nueva. Con la
  // detección de renombres por defecto, `--name-only` muestra sólo la ruta destino, y mover algo FUERA de
  // una carpeta con `gate_only_when_touching` se leería como «no la toca».
  const d = git(repo, ['diff', '--name-only', '--no-renames', baseRef, '--']);
  if (d.error) return unknown(d.error);
  const u = git(repo, ['ls-files', '--others', '--exclude-standard']);
  if (u.error) return unknown(u.error);
  sources.diff = lines(d.out);
  sources.untracked = lines(u.out);
  // Lo declarado NO entra: una story de varias tandas declara los
  // archivos de las que vienen, y sumarlos correría suites de 10+ min en tandas que no las tocan. Queda en
  // `sources.declared` como dato. Lo commiteado antes de la base es de una tanda anterior con su control hecho.
  const files = [...new Set([...sources.diff, ...sources.untracked])];
  // Vacío no es «nada que probar» si la rama ya trae commits propios: con la base en la punta y lo de la story
  // commiteado, el diff no ve nada. Sin una rama principal contra la que contarlos, tampoco se sabe.
  if (!files.length) {
    const propios = branchCommits(repo);
    if (propios.error) return unknown(`lo tocado sale vacío y ${propios.error}`);
    if (propios.count > 0) {
      return unknown(`lo tocado sale vacío pero la rama trae ${propios.count} commit(s) que ${propios.main} no tiene: pueden ser de la story`);
    }
  }
  // Una story ilegible con git sano: lo tocado de verdad sí se vio; se deja dicho igual.
  return { known: true, files, sources, reason: storyError || null };
}

if (require.main === module) {
  const [repo, storyPath, baseRef, baseSource] = process.argv.slice(2);
  let out;
  try {
    out = touchedFiles({ repo: path.resolve(repo || '.'), storyPath: storyPath || '', baseRef: baseRef || null,
      baseSource: baseSource || null });
  } catch (e) {
    out = { known: false, files: [], sources: {}, reason: `touched-files falló: ${e.message}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

module.exports = { touchedFiles, touches, isValidPattern };
