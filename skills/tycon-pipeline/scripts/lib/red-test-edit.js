'use strict';
/**
 * red-test-edit.js — la decisión del freno de una prueba vieja en rojo (`on-red-test-edit.js`).
 *
 * Una prueba que ya existía en `origin/main` y figura en las fallas del último reporte de pruebas de ESTA sesión no se
 * edita para que pase sin decir por qué: se para y se anota la razón (`marker.js note-red-test`). Si la prueba es la de
 * un control (nombra el guion o un archivo de regla de `scripts/ci/controls-from-base.json`), la nota no alcanza: la
 * edición la firma el dueño (`red-control-test-edit`).
 *
 * Decisiones (`decidir`):
 *   fuera     sin corrida abierta: el freno no actúa
 *   silencio  no es una prueba, es nueva, está en verde, o el reporte es de otra sesión
 *   no-medido no se puede saber (sin reporte o ilegible, sin la entrada de cada falla, reporte sin sesión, el de un
 *             repo hermano que no se ubica o no se lee, raíz desconocida, git no contesta): no frena y queda en
 *             gates.log con su motivo
 *   nota      vieja y en rojo en esta sesión, sin nota
 *   firma     además es la prueba de un control
 *   pasa      vieja y en rojo, con su nota
 *
 * La ruta de cada falla sale de su raíz como la resuelven los lectores de `suites.json`: `arnes` → `<repo>/scripts`,
 * `agent-skills` → la carpeta de skills. Se compara por la ruta real, no por el nombre: dos pruebas homónimas en
 * carpetas distintas no se confunden.
 */
const fs = require('fs');
const path = require('path');
const { isTestFile } = require('./code-files.js');

const NOMBRE = 'red-test-edit';
const FIRMA = 'red-control-test-edit';

/** La ruta real de un archivo (o la de su carpeta más su nombre, si todavía no existe). */
function rutaReal(p) {
  try { return fs.realpathSync(p); } catch (_) { /* todavía no existe */ }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_) { return path.resolve(p); }
}

/** La carpeta de cada raíz de `suites.json`, o null si no se conoce. */
function carpetaDeLaRaiz(raiz, repo, { skillsDir } = {}) {
  if (raiz === 'arnes') return repo ? path.join(repo, 'scripts') : null;
  if (raiz === 'agent-skills') return skillsDir || null;
  return null;
}

/**
 * Las pruebas en rojo del reporte, como rutas absolutas. `desconocidas`: las fallas cuya raíz no se resuelve.
 * @returns {{ rutas: string[], desconocidas: {raiz: any, ruta: string}[] }}
 */
function rutasEnRojo(reporte, repo, opts = {}) {
  const entradas = reporte && reporte.totals && Array.isArray(reporte.totals.failure_entries) ? reporte.totals.failure_entries : [];
  const rutas = [];
  const desconocidas = [];
  for (const e of entradas) {
    if (!e || typeof e.ruta !== 'string' || !e.ruta) continue;
    const base = carpetaDeLaRaiz(e.raiz, repo, opts);
    if (base) rutas.push(path.join(base, e.ruta));
    else desconocidas.push({ raiz: e.raiz == null ? null : e.raiz, ruta: e.ruta });
  }
  return { rutas, desconocidas };
}

/** Los archivos de los controles (el guion y cada regla, las opcionales incluidas), relativos a su repo. */
function archivosDeControles(controles) {
  const lista = controles && Array.isArray(controles.controls) ? controles.controls : [];
  const out = new Set();
  for (const c of lista) {
    if (c && typeof c.script === 'string' && c.script) out.add(c.script);
    for (const r of (c && Array.isArray(c.rules) ? c.rules : [])) {
      const p = typeof r === 'string' ? r : (r && r.path);
      if (typeof p === 'string' && p) out.add(p);
    }
  }
  return [...out];
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿La prueba nombra un archivo de un control? Por su nombre como literal o al final de una ruta. Devuelve cuál. */
function controlQueNombra(texto, archivos) {
  const t = String(texto || '');
  for (const rel of archivos) {
    const base = path.posix.basename(String(rel).replace(/\\/g, '/'));
    if (!base) continue;
    const re = new RegExp(`(^|[\\\\/'"\`])${escapar(base)}($|['"\`]|[^\\w.-])`, 'm');
    if (re.test(t)) return rel;
  }
  return null;
}

/** La sesión que corrió el reporte (`by.session`), o null si no lo dice. */
const sesionDelReporte = (reporte) => (reporte && reporte.by && typeof reporte.by.session === 'string' && reporte.by.session) || null;

/** La nota de esta prueba en el marcador, si la hay. */
function notaDe(marker, archivo) {
  const real = rutaReal(archivo);
  const notas = marker && Array.isArray(marker.redTestNotes) ? marker.redTestNotes : [];
  return notas.find((n) => n && typeof n.test === 'string' && rutaReal(n.test) === real) || null;
}

/**
 * La decisión, sin efectos. `existiaEnMain(archivo)` → true | false | null (git no contestó); se llama sólo cuando
 * hace falta. `textoDeLaPrueba()` → el texto actual de la prueba, para ver si nombra un control. `hermanos`: los
 * reportes de los repos hermanos de la corrida (`[{ reporte, repo, skillsDir }]`, los `companions[]` del principal).
 * Una suite es prueba por estar en las fallas, sea cual sea su nombre; el nombre (`isTestFile`) sólo decide qué se anota
 * como no medido cuando no hay reporte.
 * @returns {{ decision: string, motivo?: string, prueba?: string, control?: string }}
 */
function decidir({ archivo, marker, sessionId, reporte, reporteError = null, hermanos = [], repoDelReporte, controles, existiaEnMain, textoDeLaPrueba, skillsDir, skillsMotivo = null }) {
  if (!marker) return { decision: 'fuera' };
  if (!archivo) return { decision: 'silencio' };
  const prueba = rutaReal(archivo);
  const pareceUnaPrueba = isTestFile(archivo);
  const vieja = () => (typeof existiaEnMain === 'function' ? existiaEnMain(prueba) : null);
  const sinMedir = (motivo) => {
    // sólo una prueba vieja puede ser una prueba vieja en rojo: un archivo de código, o una prueba nueva, no se anota
    if (!pareceUnaPrueba) return { decision: 'silencio' };
    const v = vieja();
    if (v === false) return { decision: 'silencio' };
    return { decision: 'no-medido', prueba, motivo: v === null ? `${motivo}; además git no dijo si la prueba existía en origin/main` : motivo };
  };

  if (!reporte) return sinMedir(reporteError || 'no hay reporte de pruebas (.advisors/tests-result.json) de esta corrida');
  if (!reporte.totals || !Array.isArray(reporte.totals.failure_entries)) return sinMedir('el reporte de pruebas no trae la entrada de cada falla (failure_entries)');
  const deQuien = sesionDelReporte(reporte);
  if (!deQuien) return sinMedir('el reporte de pruebas no dice de qué sesión es (by.session)');
  if (deQuien !== sessionId) return { decision: 'silencio' };

  // las fallas de la corrida y las de sus repos hermanos (de la misma sesión), cada una resuelta contra su repo; el
  // reporte de un hermano que no se ubica, no se lee, no trae la entrada de cada falla o no dice su sesión deja sin
  // medir las pruebas de ese repo. Uno sin carpeta no se puede atar a ninguna prueba: se dice al final, si no frenó nada.
  const lista = Array.isArray(hermanos) ? hermanos.filter(Boolean) : [];
  const dentroDe = (repo) => !!repo && (prueba + path.sep).startsWith(rutaReal(repo) + path.sep);
  for (const h of lista) {
    if (!dentroDe(h.repo)) continue;
    if (h.error) return sinMedir(h.error);
    if (!h.reporte || !h.reporte.totals || !Array.isArray(h.reporte.totals.failure_entries)) {
      return sinMedir(`el reporte del repo hermano ${h.repo} no trae la entrada de cada falla (failure_entries)`);
    }
    if (!sesionDelReporte(h.reporte)) return sinMedir(`el reporte del repo hermano ${h.repo} no dice de qué sesión es (by.session)`);
  }
  const sinCarpeta = lista.find((h) => h.error && !h.repo);
  const fuentes = [{ reporte, repo: repoDelReporte, skillsDir },
    ...lista.filter((h) => h.reporte && h.reporte.totals && sesionDelReporte(h.reporte) === sessionId)];
  const rutas = [];
  const desconocidas = [];
  for (const f of fuentes) {
    const r = rutasEnRojo(f.reporte, f.repo, { skillsDir: f.skillsDir || skillsDir });
    rutas.push(...r.rutas);
    desconocidas.push(...r.desconocidas);
  }
  // una roja heredada (roja también en la base o en el nocturno) sale de failure_entries y queda sólo con su nombre
  const heredada = fuentes.some((f) => f.reporte.totals && Array.isArray(f.reporte.totals.inherited_suites)
    && f.reporte.totals.inherited_suites.includes(path.basename(prueba)));
  const enRojo = heredada || rutas.some((r) => rutaReal(r) === prueba);
  if (!enRojo) {
    const homonima = desconocidas.find((d) => path.posix.basename(d.ruta) === path.basename(prueba));
    // la raíz de skills es «desconocida» cuando no se pudo resolver su carpeta: el motivo dice por qué
    const porque = homonima && homonima.raiz === 'agent-skills' && skillsMotivo ? ` (${skillsMotivo})` : '';
    if (homonima) return pareceUnaPrueba ? sinMedir(`una falla del reporte es de una raíz que no conozco («${homonima.raiz}»)${porque}: no sé si es esta prueba`)
      : { decision: 'no-medido', prueba, motivo: `una falla del reporte es de una raíz que no conozco («${homonima.raiz}»)${porque}: no sé si es este archivo` };
    if (sinCarpeta) return sinMedir(sinCarpeta.error);
    return { decision: 'silencio' };
  }

  const v = vieja();
  if (v === false) return { decision: 'silencio' };
  if (v === null) return { decision: 'no-medido', prueba, motivo: 'git no dijo si la prueba existía en origin/main' };

  // ¿es la prueba de un control? Si no se puede ver (sin inventario, o la prueba no se lee), la decisión es la de una
  // prueba común —nota— y lo que no se pudo ver va en `controlSinMedir`, para que quede anotado
  let controlSinMedir = controles && controles.error ? `el inventario de controles no se lee (${controles.error})` : null;
  let texto = '';
  if (!controlSinMedir) {
    try { texto = typeof textoDeLaPrueba === 'function' ? textoDeLaPrueba(prueba) : ''; } catch (e) {
      controlSinMedir = `la prueba no se lee (${e.code || e.message})`;
    }
  }
  const control = controlSinMedir ? null : controlQueNombra(texto, archivosDeControles(controles));
  if (control) return { decision: 'firma', prueba, control };
  const extra = controlSinMedir ? { controlSinMedir } : {};
  if (notaDe(marker, prueba)) return { decision: 'pasa', prueba, ...extra };
  return { decision: 'nota', prueba, ...extra };
}

/** El bloque que lleva el contexto de los revisores: una línea por prueba vieja editada en rojo, con su razón. */
function bloqueParaRevisores(marker) {
  const notas = marker && Array.isArray(marker.redTestNotes) ? marker.redTestNotes : [];
  if (!notas.length) return '';
  return [
    '## Pruebas viejas que estaban en rojo y se editaron',
    '',
    'Cada una se editó con una razón anotada. Mirá si la razón se sostiene: una prueba en rojo que se corrige para que',
    'pase puede estar escondiendo el defecto que medía.',
    '',
    ...notas.map((n) => `- \`${n.test}\`: ${n.reason}`),
    '',
  ].join('\n');
}

/** Un renglón por prueba para el mensaje del commit. */
function renglonesParaElCommit(marker) {
  const notas = marker && Array.isArray(marker.redTestNotes) ? marker.redTestNotes : [];
  return notas.map((n) => `Prueba en rojo editada: ${n.test} — ${n.reason}`);
}

module.exports = {
  NOMBRE, FIRMA, rutaReal, carpetaDeLaRaiz, rutasEnRojo, archivosDeControles, controlQueNombra, sesionDelReporte, notaDe,
  decidir, bloqueParaRevisores, renglonesParaElCommit,
};
