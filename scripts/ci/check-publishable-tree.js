#!/usr/bin/env node
'use strict';
/**
 * check-publishable-tree.js — lo que rompería la verificación de una versión BAJADA no entra al repo (story 8.23,
 * tanda B · AC 20).
 *
 * 🔴 POR QUÉ EXISTE (2026-10-06, revisión I3 de la story 8.23). Una máquina sin git instala el arnés bajando el comprimido
 * de un commit publicado y lo da por bueno sólo si el árbol que trae es el del commit (scripts/lib/tar-reader.js +
 * scripts/lib/git-tree-hash.js). Tres cosas del repo rompen eso sin que nadie lo note hasta la primera instalación:
 *   · un `export-ignore` o `export-subst` en un `.gitattributes` publicado: el comprimido de GitHub (git archive) no
 *     trae ese archivo, o lo trae cambiado, y el árbol ya no coincide con el commit → ninguna máquina instala;
 *   · un enlace simbólico (`120000`) o un submódulo (`160000`) en una ruta publicada: el lector propio los rechaza
 *     antes de escribir (y hace bien) → tampoco instala.
 * Lo que vive en una ruta PRIVADA (specs/, tasks/, lo que la lista blanca no toma) no viaja en la copia y no importa.
 *
 * QUÉ MIRA: `git ls-files -s` (el índice: modo de cada ruta) y el contenido de cada `.gitattributes`. «Publicada» lo
 * decide la lista blanca del exportador (scripts/publishing/allowlist.json: `packages.*.{arnes,agent-skills}.in/out`)
 * con el mismo matcher de globs (`coincide` de export.js) y sus excluidos de siempre (`EXCLUIDOS_SIEMPRE`). En el
 * repo unido las dos fuentes son este repo: una ruta se publica si algún paquete de alguna fuente la toma.
 *
 * Con `--staged` mira sólo lo que el commit en curso agrega o cambia (el pre-commit); sin él, todo el índice (la
 * validación de cada rama).
 *
 * Salida: 0 sin hallazgos · 1 hay al menos uno (cada uno con su ruta y su motivo) · 2 no se pudo mirar (sin git, lista
 * blanca o exportador ilegibles): no medido NO es verde.
 *
 * Uso: node scripts/ci/check-publishable-tree.js [--repo <dir>] [--staged] [--allowlist <json>] [--exporter <export.js>]
 *   `--allowlist` y `--exporter` son para las pruebas (un repo de juguete con su propia lista); en el arnés se leen del
 *   repo.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, def = null) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def; }
const REPO = path.resolve(arg('--repo', process.cwd()));
const STAGED = process.argv.includes('--staged');
const ALLOWLIST = path.resolve(arg('--allowlist', path.join(REPO, 'scripts', 'publishing', 'allowlist.json')));
const EXPORTER = path.resolve(arg('--exporter', path.join(REPO, 'scripts', 'publishing', 'export.js')));
const SOURCES = ['arnes', 'agent-skills'];
const ATTR_RX = /(^|\s)export-(ignore|subst)(\s|$)/;
// atributos que cambian los BYTES del archivo entre el commit y lo que un clon ve (pase adversarial de la B): el árbol se
// calcula sobre los bytes del commit y es el que el comprimido trae; un clon con estos atributos vería otra cosa y el
// aplicador compararía mal. `text`/`eol` sin `=crlf` no cambian lo que el comprimido trae (git archive da los bytes del
// commit); `eol=crlf` sí fuerza el final de línea al exportar
const BYTES_RX = /(^|\s)(eol=crlf|ident|filter=\S+|working-tree-encoding=\S+)(\s|$)/;
// nombres que Windows no escribe, o que el lector del comprimido rechaza (`.git` como segmento)
const UNSAFE_NAME_RX = /[:\\*?"<>|]|(^|\/)\.git(\/|$)/;

const say = (l) => process.stdout.write(`${l}\n`);
const cannot = (why) => { process.stderr.write(`check-publishable-tree: no pude mirar — ${why}. No medido no es verde.\n`); return 2; };

function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, err: (r.stderr || r.error && r.error.message || `git salió ${r.status}`).trim().split('\n')[0] };
}

/** El predicado «esta ruta se publica», con la lista blanca y los excluidos del exportador. */
function publishedPredicate() {
  let exporter;
  try { exporter = require(EXPORTER); } catch (e) { return { problem: `no pude cargar el exportador ${EXPORTER} (${e.message})` }; }
  if (typeof exporter.coincide !== 'function' || !Array.isArray(exporter.EXCLUIDOS_SIEMPRE)) return { problem: `${EXPORTER} no exporta coincide y EXCLUIDOS_SIEMPRE` };
  let list;
  try { list = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')); } catch (e) { return { problem: `la lista blanca ${ALLOWLIST} no se puede leer (${e.message})` }; }
  const packages = list && list.packages && typeof list.packages === 'object' ? list.packages : null;
  if (!packages) return { problem: `la lista blanca ${ALLOWLIST} no trae «packages»` };
  const defs = [];
  for (const P of Object.keys(packages)) {
    if (P.startsWith('__')) continue;
    for (const f of SOURCES) {
      const d = packages[P][f];
      if (d && Array.isArray(d.in)) defs.push({ f, in: d.in, out: Array.isArray(d.out) ? d.out : [] });
    }
  }
  // `in` son globs; `out` y los excluidos de siempre son `{ glob, motivo }` (en una lista de juguete, también textos)
  const globOf = (x) => (typeof x === 'string' ? x : x && x.glob);
  const matches = (x, ruta) => { const g = globOf(x); return typeof g === 'string' && exporter.coincide(g, ruta); };
  // con el `salvo` de cada exclusión fija (story 8.26, tanda C): lo que sale igual no es privado. Una exclusión de una
  // lista de juguete (un texto) no tiene `salvo`.
  const excluded = (f, ruta) => exporter.EXCLUIDOS_SIEMPRE.some((x) => x.fuente === f && matches(x, ruta)
    && !(x && Array.isArray(x.salvo) && x.salvo.includes(ruta)));
  const publishes = (ruta) => defs.some((d) => d.in.some((g) => matches(g, ruta)) && !d.out.some((x) => matches(x, ruta)) && !excluded(d.f, ruta));
  return { publishes };
}

function main() {
  const pred = publishedPredicate();
  if (pred.problem) return cannot(pred.problem);
  const ls = git(['ls-files', '-s', '-z']);
  if (!ls.ok) return cannot(`git ls-files en ${REPO}: ${ls.err}`);
  let only = null;
  if (STAGED) {
    // también lo que cambia de TIPO (T: un archivo que pasa a ser enlace); y si el commit toca la lista blanca, lo que
    // antes era privado puede publicarse ahora: se mira el índice entero (pase adversarial de la B)
    const d = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=AMRCT']);
    if (!d.ok) return cannot(`git diff --cached: ${d.err}`);
    only = new Set(d.out.split('\0').filter(Boolean));
    const allowRel = path.relative(REPO, ALLOWLIST).split(path.sep).join('/');
    if (only.has(allowRel)) { say(`check-publishable-tree: el commit toca ${allowRel}: se mira el índice entero`); only = null; }
  }
  const all = ls.out.split('\0').filter(Boolean).map((l) => {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/.exec(l);
    return m ? { mode: m[1], path: m[4] } : null;
  }).filter(Boolean);
  const entries = all.filter((e) => !only || only.has(e.path));
  const findings = [];
  // dos rutas publicadas que sólo difieren en mayúsculas: en Windows y en macOS por defecto una pisa a la otra
  const lower = new Map();
  for (const e of all) { if (!pred.publishes(e.path)) continue; const k = e.path.toLowerCase(); if (!lower.has(k)) lower.set(k, []); lower.get(k).push(e.path); }
  for (const e of entries) {
    if (!pred.publishes(e.path)) continue;
    if (e.mode === '120000') findings.push(`${e.path} — es un enlace simbólico (120000) en una ruta publicada: el comprimido lo trae como enlace y el lector lo rechaza; que sea un archivo`);
    if (e.mode === '160000') findings.push(`${e.path} — es un submódulo (160000) en una ruta publicada: el comprimido no trae su contenido y el árbol no coincide; que sea una carpeta del repo`);
    if (UNSAFE_NAME_RX.test(e.path)) findings.push(`${e.path} — el nombre no se puede escribir en Windows (: \\ * ? " < > |) o lleva «.git» como segmento, que el lector rechaza; renombralo`);
    const twins = lower.get(e.path.toLowerCase());
    if (twins && twins.length > 1) findings.push(`${e.path} — hay otra ruta publicada que sólo difiere en mayúsculas (${twins.filter((t) => t !== e.path).join(', ')}): en Windows una pisa a la otra; renombrá una`);
    if (path.basename(e.path) === '.gitattributes') {
      let text;
      if (STAGED) { const s = git(['show', `:${e.path}`]); if (!s.ok) return cannot(`git show :${e.path}: ${s.err}`); text = s.out; }
      else { try { text = fs.readFileSync(path.join(REPO, ...e.path.split('/')), 'utf8'); } catch (err) { return cannot(`no pude leer ${e.path} (${err.message})`); } }
      text.split('\n').forEach((line, i) => {
        // en .gitattributes el comentario es la línea que EMPIEZA con #; un # en el medio es parte del patrón
        if (/^\s*#/.test(line)) return;
        const clean = line;
        if (ATTR_RX.test(clean)) findings.push(`${e.path}:${i + 1} — «${line.trim()}»: un export-${/export-subst/.test(clean) ? 'subst' : 'ignore'} cambia lo que el comprimido trae y el árbol deja de ser el del commit; sacalo`);
        const b = BYTES_RX.exec(clean);
        if (b) findings.push(`${e.path}:${i + 1} — «${line.trim()}»: «${b[2]}» cambia los bytes del archivo entre el commit y el disco, y la versión bajada se verifica por los bytes del commit; sacalo`);
      });
    }
  }
  if (!findings.length) return 0;
  say(`❌ check-publishable-tree: ${findings.length} hallazgo(s) que romperían la verificación de la versión bajada:`);
  for (const f of findings) say(`  · ${f}`);
  return 1;
}

process.exitCode = main();
