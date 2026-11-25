'use strict';
/**
 * fix-scope.js — los revisores de un arreglo no ensanchan su alcance.
 *
 * Desde la segunda vuelta de revisores, lo que se revisa es un arreglo: lo que cambió entre el sello de la vuelta
 * anterior y el de la última (lib/frozen-tree.js). Un hallazgo de esa vuelta sobre líneas que el arreglo no tocó no es
 * del arreglo: va a seguimiento (`disposition: deferred`, `deuda: fuera-del-arreglo`) y no abre otra vuelta. Un crítico
 * también, y el cierre lo muestra primero: no se pierde, pero no frena el arreglo.
 *
 * Ante la duda, es del arreglo: un hallazgo sin vuelta anotada (`iter`), de la primera vuelta, sin archivo, de un repo
 * que la vuelta no selló o con un diff que no se pudo leer sigue como vino. Uno sin línea en un archivo que el arreglo
 * cambió, también.
 *
 *   · `alcanceDelArreglo({ stateDir, sid, story })` → `{ iter, repos: [{ repo, desde, hasta }] }` o null (sin dos vueltas).
 *   · `aplicar(records, alcance)` → `{ records, fuera: [records movidos] }`.
 */
const path = require('path');
const { spawnSync } = require('child_process');

/** Las dos últimas vueltas de revisores de la historia en la sesión, como alcance; null si hay menos de dos. */
function alcanceDelArreglo({ stateDir, sid, story }) {
  const ft = require('./frozen-tree.js');
  const todas = ft.vueltas(stateDir, String(sid).replace(/[/\\]/g, '_')).filter((v) => v.tipo === 'revisores' && String(v.story) === String(story));
  // una vuelta sellada dos veces (el set pedido de nuevo) cuenta una: vale su último sello
  const porEtiqueta = new Map();
  for (const v of todas) { porEtiqueta.delete(v.etiqueta); porEtiqueta.set(v.etiqueta, v); }
  const vs = [...porEtiqueta.values()];
  if (vs.length < 2) return null;
  const [antes, ahora] = vs.slice(-2);
  const repos = (ahora.repos || []).map((r) => ({ repo: r.repo, hasta: r.tree, desde: ((antes.repos || []).find((x) => x.repo === r.repo) || {}).tree || null }))
    .filter((r) => r.repo && r.hasta && r.desde);
  return { iter: vs.length, repos };
}

/** Las líneas (del lado nuevo) que cambió el arreglo en un archivo: `{ cambio: bool, rangos: [[desde, hasta]] }` o null. */
function lineasDelArreglo(r, rel) {
  const d = spawnSync('git', ['-C', r.repo, 'diff', '-U0', '--no-color', r.desde, r.hasta, '--', rel], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (d.status !== 0) return null;
  const rangos = [];
  for (const m of String(d.stdout).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const desde = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    // un borrado puro (n = 0) toca el renglón donde estaba
    rangos.push([desde, desde + Math.max(n, 1) - 1]);
  }
  return { cambio: rangos.length > 0, rangos };
}

/** ¿El hallazgo cae fuera del arreglo? true sólo cuando se pudo medir y no toca nada de lo que el arreglo cambió. */
/** ¿El archivo está en el árbol sellado de la vuelta? */
const enElSello = (r, rel) => spawnSync('git', ['-C', r.repo, 'cat-file', '-e', `${r.hasta}:${rel}`], { windowsHide: true }).status === 0;

function estaFuera(f, alcance) {
  if (!alcance || !Number.isInteger(f.iter) || f.iter < 2 || f.iter !== alcance.iter || !f.file) return false;
  // con la ruta relativa y varios repos, el repo del hallazgo es el único cuyo sello tiene ese archivo; si son varios o
  // ninguno, no se sabe de cuál es, y ante la duda es del arreglo
  let candidatos = alcance.repos;
  if (!path.isAbsolute(f.file)) {
    const rel = String(f.file).replace(/\\/g, '/');
    candidatos = alcance.repos.filter((r) => enElSello(r, rel));
    if (candidatos.length !== 1) return false;
  }
  for (const r of candidatos) {
    const abs = path.isAbsolute(f.file) ? f.file : path.join(r.repo, f.file);
    const rel = path.relative(r.repo, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const l = lineasDelArreglo(r, rel.split(path.sep).join('/'));
    if (!l) return false;
    if (!l.cambio) return true;
    if (!Number.isInteger(f.line)) return false;
    return !l.rangos.some(([a, b]) => f.line >= a && f.line <= b);
  }
  return false;
}

const CRITICO = (f) => /critical/i.test(String(f.severity || ''));

/** Los hallazgos abiertos de la vuelta del arreglo que caen fuera de él pasan a seguimiento; los críticos, primero. */
function aplicar(records, alcance) {
  const fuera = [];
  const out = records.map((f) => {
    if (f.disposition !== 'open' || !estaFuera(f, alcance)) return f;
    const movido = { ...f, disposition: 'deferred', deuda: 'fuera-del-arreglo' };
    fuera.push(movido);
    return movido;
  });
  return { records: out, fuera: [...fuera.filter(CRITICO), ...fuera.filter((f) => !CRITICO(f))] };
}

module.exports = { alcanceDelArreglo, aplicar, estaFuera, lineasDelArreglo };
