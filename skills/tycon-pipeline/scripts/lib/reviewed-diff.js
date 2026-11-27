'use strict';
/**
 * reviewed-diff.js — lo que cambió desde lo que vieron los revisores, con la regla de «Preparar el pull request».
 *
 * Sella cada repo de una vuelta congelada y lo compara con su sello (lib/frozen-tree.js `changed`), con el papeleo, lo
 * que trajo main, los comentarios movidos y lo que no se ejecuta aparte. Lo usan dos frenos con la misma regla:
 *   · «Preparar» (marker-shared.js `comprobarLoRevisado`): con algo en `distintos`, no se guarda;
 *   · el tope de vueltas (pipeline-advisor-context.js `topeDeVueltas`): una vuelta sin código pasa el tope sola sólo si
 *     «Preparar» pasaría, es decir, sin nada en `distintos`.
 *
 *   · `comparar({ marker, v, storyAbs, stateDir, cierre })`: `{ error }` o `{ distintos, adentro, papeleo, deMain,
 *     sinSepararMain, huellas, movidos, sinCodigo }`. `v` es la vuelta congelada (`frozen-tree.js ultimaVuelta`), `cierre`
 *     la hora del cierre de los revisores (lib/steps.js `reviewersClose`), para los comentarios movidos.
 *   · `sinCodigoParaLaVuelta(marker, storyAbs)`: `(repo, tree, rel, storyRel) => bool`, lo que no se ejecuta.
 *   · `rutaDeLaHistoriaEn(repo, storyAbs)`: la ruta de la historia en ese repo, también desde otra copia del mismo repo.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); } };

const IMAGENES_SUELTAS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DE_LA_GUIA = new Set(['.html', '.htm', '.md', '.pdf', ...IMAGENES_SUELTAS]);
// una carpeta que la app sirve tal cual: lo que hay ahí puede publicarse, sea prueba o no
const QUE_SE_SIRVE = /(^|\/)(public|static|www|wwwroot|dist|build|out)\//i;
// una carpeta que la app compila: una prueba ahí no se publica, otra cosa sí puede
const QUE_SE_COMPILA = /(^|\/)(assets|src|app|pages|lib)\//i;
const NOMBRE_DE_PRUEBA = /(\.(test|spec)\.[^/]+$)|((^|\/)__tests__\/)|((^|\/)[^/]+\.Tests?\/)/i;
const CONFIGURACION = /^(package(-lock)?|npm-shrinkwrap|tsconfig[\w.-]*|jsconfig)\.json$/;

/** Dónde vive la historia: `{ storyRel, repoCommon }` (su ruta en su copia y la carpeta git común), o `{}`. */
function dondeViveLaHistoria(storyPath) {
  try {
    const dir = path.dirname(storyPath);
    const [raiz, comun] = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim().split('\n');
    return { storyRel: path.relative(real(raiz), real(storyPath)), repoCommon: path.resolve(dir, comun) };
  } catch (_e) {
    return {};
  }
}

/**
 * La ruta de la historia relativa a `repo`: la de siempre si vive adentro, o su ruta dentro de su propia copia si vive
 * en otra copia del mismo repo (la misma carpeta git común). null si es de otro repo o no se sabe.
 */
function rutaDeLaHistoriaEn(repo, storyAbs) {
  const directa = path.relative(real(repo), real(storyAbs));
  if (directa && !directa.startsWith('..') && !path.isAbsolute(directa)) return directa;
  const donde = dondeViveLaHistoria(storyAbs);
  if (!donde.storyRel || !donde.repoCommon) return null;
  try {
    const comun = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
    return real(path.resolve(repo, comun)) === real(donde.repoCommon) ? donde.storyRel : null;
  } catch (_e) { return null; }
}

/**
 * `(repo, tree, rel, storyRel) => bool`: ¿el archivo, cambiado después de la vuelta, es algo que no se ejecuta y el
 * re-loop no revisa? Nunca la historia (tiene su regla de papeleo), una carpeta oculta, la configuración de una
 * herramienta, lo que cuenta siempre (reloop-code.js `cuentaSiempre`), un modo que no es el de un archivo común, ni lo
 * que el re-loop revisa. De lo que queda, sólo por lista: una prueba del proyecto, una imagen suelta, y la guía, el
 * informe o una imagen de ESTA historia en su carpeta qa; nada de una carpeta que la app sirve, ni algo que no es prueba
 * en una que compila. Ante un error, cuenta.
 */
function sinCodigoParaLaVuelta(marker, storyAbs) {
  const rc = require('./reloop-code.js');
  return (repo, tree, rel, storyRel) => {
    try {
      const abs = path.join(repo, rel);
      if (storyAbs && real(abs) === real(storyAbs)) return false;
      if (storyRel && rel === String(storyRel).split(path.sep).join('/')) return false;
      if (rel.split('/').some((p) => p.startsWith('.')) || CONFIGURACION.test(path.posix.basename(rel))) return false;
      if (rc.cuentaSiempre(abs)) return false;
      const ls = spawnSync('git', ['-C', repo, 'ls-tree', tree, '--', rel], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      if (ls.error || ls.status !== 0) return false;
      const modo = String(ls.stdout || '').split(' ')[0];
      // borrado (sin entrada) o un archivo común: lo demás cuenta
      if (modo && modo !== '100644') return false;
      if (rc.pideOtraVuelta(abs, { storyPath: storyAbs || marker.storyPath, repoPath: marker.repoPath })) return false;
      const raiz = rc.raizDelRepo(abs);
      const desdeLaRaiz = (raiz ? path.relative(raiz, abs) : rel).split(path.sep).join('/');
      if (QUE_SE_SIRVE.test(desdeLaRaiz)) return false;
      // adentro de una carpeta que la app compila, sólo un archivo con nombre de prueba: una carpeta `test/` o `specs/` ahí
      // puede ser una ruta de la app, y `*Test.cs` fuera de un proyecto de pruebas es código
      if (QUE_SE_COMPILA.test(desdeLaRaiz)) return NOMBRE_DE_PRUEBA.test(desdeLaRaiz);
      if (require('./atdd-order.js').isTestPath(desdeLaRaiz)) return true;
      const ext = path.posix.extname(rel).toLowerCase();
      if (IMAGENES_SUELTAS.has(ext)) return true;
      const qa = storyAbs ? real(require('./qa-dir.js').qaDirFor(storyAbs)) : null;
      const historia = storyAbs ? path.basename(storyAbs, '.md').toLowerCase() : null;
      const nombre = path.basename(abs).toLowerCase();
      return !!qa && real(path.dirname(abs)) === qa && nombre.startsWith(`${historia}-`) && DE_LA_GUIA.has(ext);
    } catch (_e) { return false; }
  };
}

function comparar({ marker, v, storyAbs, stateDir, cierre }) {
  const ft = require('./frozen-tree.js');
  const { isControlApproval } = require('./story-gate.js');
  const out = { distintos: [], adentro: [], papeleo: [], deMain: [], sinSepararMain: [], huellas: [], movidos: [], sinCodigo: [] };
  const noPideVuelta = sinCodigoParaLaVuelta(marker, storyAbs);
  // sólo comentarios movidos: contra una vuelta ya cerrada y de esta historia; nunca una lanzada sin cerrar
  let conComentarios = false;
  try {
    const cerrada = ft.vueltaCerradaDeLosRevisores(marker, cierre, { stateDir });
    conComentarios = !!cerrada && cerrada.etiqueta === v.etiqueta && cerrada.ts === v.ts;
  } catch (_e) { conComentarios = false; }
  for (const r of v.repos || []) {
    const ahora = ft.seal(r.repo);
    if (ahora.error) return { error: `no pude sellar lo que se guarda para compararlo con lo revisado (${ahora.error}).` };
    const anidados = ft.anidadosConCambios(r.repo, ahora.tree);
    if (anidados.error) return { error: `no pude comparar lo que se guarda con lo revisado en ${path.basename(r.repo)}: ${anidados.error}.` };
    for (const f of anidados.files) { out.distintos.push({ repo: r.repo, f }); out.adentro.push(f); }
    // la historia en otra copia del mismo repo (un worktree) sigue su regla de papeleo y no cuenta entera como cambio
    const rel = storyAbs ? rutaDeLaHistoriaEn(r.repo, storyAbs) : null;
    // lo que trajo main en archivos que la corrida no tocó no es «no revisado»: se separa con el punto en común con main
    // del sello y el de ahora, del mismo repo
    const pm = r.mainBase ? ft.puntoComunConMain(r.repo) : { error: `${path.basename(r.repo)}: la vuelta se selló sin el punto en común con main` };
    if (pm.error) out.sinSepararMain.push(pm.error);
    let c;
    try {
      c = ft.changed(r.repo, r.tree, ahora.tree, { storyRel: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null,
        mainAntes: r.mainBase || null, mainAhora: pm.sha || null, comentarios: conComentarios });
    } catch (e) { c = { error: String((e && e.message) || e).split('\n')[0] }; }
    if (c.error) return { error: `no pude comparar lo que se guarda con lo revisado (${c.error}).` };
    for (const f of c.files) {
      // una constancia de cambio de control la firma el dueño: no es código que los revisores tengan que ver
      if (isControlApproval(f)) out.papeleo.push(f);
      else if (noPideVuelta(r.repo, ahora.tree, f, rel)) out.sinCodigo.push(f);
      else out.distintos.push({ repo: r.repo, f });
    }
    out.papeleo.push(...c.papeleo);
    out.deMain.push(...(c.deMain || []));
    out.movidos.push(...(c.comentarios || []));
    out.huellas.push(`${path.basename(r.repo)} ${r.tree.slice(0, 12)}`);
  }
  return out;
}

module.exports = { comparar, sinCodigoParaLaVuelta, rutaDeLaHistoriaEn, dondeViveLaHistoria };
