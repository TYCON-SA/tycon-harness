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
 * Sin base, o con git fallando, `known: false` con el motivo: el que llama corre todo. Lo mismo si el diff no trae
 * ningún archivo con seguimiento que no sea documentación (vacío, sólo sin seguimiento, sólo `.md`) y la rama trae
 * commits que la principal no tiene: pueden ser de la story, commiteados antes de la base.
 * El árbol armado del privado pasa `onlyCommitsBeforeBase`: ahí sólo los commits que la base contiene dejan el «no sé»,
 * porque el diff ve todos los posteriores. Con esa opción, una rama con commits propios sale con `must_measure: true`: lo
 * tocado se sabe, pero sin correr alguna suite no vale como medido. Con esa misma opción, lo que llegó sólo por main
 * (main traído durante la corrida) sale del diff y queda en `sources.from_main`: igual a `origin/main` en el disco y sin
 * commits propios de la rama que lo toquen; sin `origin/main` cuenta todo. Las demás llamadas siguen sin la opción.
 * Límites conocidos:
 *   · en un repo sin remoto, con los commits de la story sobre la propia `main` local, `main..HEAD` da 0 y no se ven
 *     como propios. Pedir el remoto haría correr todo en cualquier repo sin él; un clon real tiene `origin/main`;
 *   · con commits propios, una tanda que sólo crea archivos nuevos (sin agregarlos ni cambiar nada con seguimiento)
 *     corre todo: frena de más, aceptado, porque un archivo suelto no prueba que la story esté a la vista;
 *   · con lo de la story commiteado antes de la base, un cambio ajeno a ella que no sea documentación (un `.json`, un
 *     lockfile, un borrado) se toma como lo tocado y las suites de la story no corren. Cerrarlo pide saber si hubo
 *     commits de la story antes de la base, y eso lo sabe la corrida, no git.
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
// Documentación: un cambio sólo de esto no muestra el código de la story.
const DOCS_RE = /\.(md|markdown)$/i;
// La constancia que reescribe el propio portón: con seguimiento en el privado, aparece en el diff después de cada corrida.
const CONSTANCIA_DEL_PORTON_RE = /(^|\/)\.advisors\/dod-runtime\/[^/]+-tests-result\.json$/;

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
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
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

/**
 * Cuántos commits de la rama contiene la base: los que el diff contra ella no ve. Comprueba antes que la base sea un
 * commit, porque `git rev-list <main>..<árbol>` no falla: sale 0.
 */
function commitsBeforeBase(repo, baseRef, main) {
  if (git(repo, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]).error) {
    return { error: `la base ${String(baseRef).slice(0, 12)} no es un commit` };
  }
  const c = git(repo, ['rev-list', '--count', `${main}..${baseRef}`]);
  if (c.error) return { error: `no pude contar los commits anteriores a la base (${c.error})` };
  return { count: Number(c.out.trim()) || 0 };
}

const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/**
 * Lo que llegó sólo por main: de `files`, los que main cambió desde la base, que en el disco son iguales a `origin/main`
 * y que ningún commit propio de la rama tocó. Ante cualquier duda (sin `origin/main`, git que falla) no saca nada.
 * Propios son los commits que descienden de la base y llegan a HEAD sin estar en la línea principal de `origin/main`
 * (sus primeros padres): así un commit de la corrida que ya entró a main por un merge sigue siendo propio. Un pedido que
 * entró a main sin commit de fusión (squash o rebase) queda en esa línea y se toma como de main.
 */
function soloDeMain(repo, baseRef, files) {
  if (!files.length || git(repo, ['rev-parse', '--verify', '-q', 'origin/main^{commit}']).error) return new Set();
  const deMain = git(repo, ['diff', '--name-only', '--no-renames', baseRef, 'origin/main', '--']);
  const distintos = git(repo, ['diff', '--name-only', '--no-renames', 'origin/main', '--']);
  const desdeLaBase = git(repo, ['rev-list', '--ancestry-path', '--no-merges', `${baseRef}..HEAD`]);
  const lineaDeMain = git(repo, ['rev-list', '--first-parent', `${baseRef}..origin/main`]);
  if (deMain.error || distintos.error || desdeLaBase.error || lineaDeMain.error) return new Set();
  const deLaLinea = new Set(lines(lineaDeMain.out));
  const propios = lines(desdeLaBase.out).filter((c) => !deLaLinea.has(c));
  let tocadosPorLaRama = [];
  if (propios.length) {
    const t = git(repo, ['log', '--no-walk=unsorted', '--no-renames', '--name-only', '--format=', ...propios, '--']);
    if (t.error) return new Set();
    tocadosPorLaRama = lines(t.out);
  }
  const noIgual = new Set([...lines(distintos.out), ...tocadosPorLaRama]);
  return new Set(lines(deMain.out).filter((f) => !noIgual.has(f)));
}

function touchedFiles({ repo, storyPath, baseRef, baseSource, onlyCommitsBeforeBase = false } = {}) {
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
  // En el árbol armado, main traído durante la corrida no es de la historia: lo que llegó sólo por main sale del diff.
  if (onlyCommitsBeforeBase) {
    const ajenos = soloDeMain(repo, baseRef, sources.diff);
    if (ajenos.size) {
      sources.from_main = sources.diff.filter((f) => ajenos.has(f));
      sources.diff = sources.diff.filter((f) => !ajenos.has(f));
    }
  }
  // Lo declarado NO entra: una story de varias tandas declara los
  // archivos de las que vienen, y sumarlos correría suites de 10+ min en tandas que no las tocan. Queda en
  // `sources.declared` como dato. Lo commiteado antes de la base es de una tanda anterior con su control hecho.
  const files = [...new Set([...sources.diff, ...sources.untracked])];
  // Con lo de la story commiteado antes de la base, el diff no ve nada de ella: lo que muestre (un archivo sin
  // seguimiento, un .md) no es la story. Sin un cambio de código con seguimiento, si la rama trae commits propios no se
  // sabe; tampoco si no hay rama principal contra la que contarlos.
  // Con la bifurcación como base no hace falta: el diff ya ve todos los commits propios de la rama.
  // En el árbol armado la constancia del portón no cuenta: si contara, la respuesta cambiaría entre dos corridas iguales.
  const muestraCodigo = (f) => !DOCS_RE.test(f) && !(onlyCommitsBeforeBase && CONSTANCIA_DEL_PORTON_RE.test(f));
  const sinCodigoALaVista = baseSource !== 'bifurcacion' && !sources.diff.some(muestraCodigo);
  let mustMeasure = false;
  if (sinCodigoALaVista || onlyCommitsBeforeBase) {
    const que = files.length ? 'lo tocado no trae código con seguimiento' : 'lo tocado sale vacío';
    const propios = branchCommits(repo);
    if (propios.error) {
      if (sinCodigoALaVista) return unknown(`${que} y ${propios.error}`);
      mustMeasure = true;
    } else if (propios.count > 0) {
      if (!onlyCommitsBeforeBase) {
        return unknown(`${que} pero la rama trae ${propios.count} commit(s) que ${propios.main} no tiene: pueden ser de la story`);
      }
      const antes = commitsBeforeBase(repo, baseRef, propios.main);
      if (sinCodigoALaVista && antes.error) return unknown(`${que} y ${antes.error}`);
      if (sinCodigoALaVista && antes.count > 0) {
        return unknown(`${que} pero la base trae ${antes.count} commit(s) de la rama que ${propios.main} no tiene: pueden ser de la story`);
      }
      mustMeasure = true;
    }
  }
  // Una story ilegible con git sano: lo tocado de verdad sí se vio; se deja dicho igual.
  return { known: true, files, sources, reason: storyError || null, base: { ref: baseRef, source: baseSource || null },
    ...(mustMeasure ? { must_measure: true } : {}) };
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
