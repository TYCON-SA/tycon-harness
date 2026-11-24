'use strict';
/**
 * ci-red-lane.js — el arreglo de un rojo de CI de un pedido abierto y ya revisado (la firma `adhoc-lane:ci-rojo`).
 *
 * Un rojo chico de la compilación de un pedido (una clave mal puesta en un manifiesto) no paga una corrida entera: se
 * abre un camino corto atado al pedido y al control que falló, sin plan ni revisores, con un tope de 3 archivos de
 * implementación. Lo que lo protege es su alcance y el control que falló corrido otra vez antes de guardar.
 *
 *   · `validarApertura(...)`  `{ ciRojo }` o `{ problema }`. Abre sólo sobre un pedido que la espera de la compilación
 *                             de ESTA sesión vio en rojo (`pr-build-wait/<sesión>-resultado.json`), con la lista dentro del
 *                             repo de ese pedido, sin archivos sensibles (van con su firma de control), con el control
 *                             declarado para correr en local y con la punta del repo en el commit que dio rojo. Anota la punta: el carril mide desde ahí, no desde `main`.
 *   · `frenoAlGuardar(carril)` `{ texto }` o null. Corre el control que falló, que el repo tiene que declarar para correr
 *                             en local (lib/ci-local-checks.js): sin él no abre, y si deja de estar, no guarda.
 *   · `esperaTrasEmpujar(...)` la lista para relanzar la espera de la compilación del pedido con la punta nueva; con
 *                             verde, la espera cierra el carril.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/** El resultado de la espera de la compilación de la sesión, o `{ problema }`. */
function resultadoDeLaSesion(stateDir, sesion) {
  const archivo = path.join(stateDir, 'pr-build-wait', `${sesion}-resultado.json`);
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
    return { problema: e.code === 'ENOENT' ? 'esta sesión no tiene una espera de compilación terminada: el arreglo de un rojo de CI se abre sobre un pedido que la espera vio en rojo (marker.js clear la lanza)' : `no pude leer la espera de la compilación de esta sesión (${e.message})` };
  }
}

/**
 * ¿Se puede abrir el arreglo? `pedido` (número), `control` (el nombre del control que falló), `allowedFiles` (absolutas),
 * `codigo` (cuántos son de implementación), `tope`.
 */
function validarApertura({ stateDir, sesion, pedido, control, allowedFiles = [], codigo, tope, controlesDe = (repo) => require('./ci-local-checks.js').controlesDe(repo) }) {
  const r = resultadoDeLaSesion(stateDir, sesion);
  if (r.problema) return { problema: r.problema };
  const p = (r.pedidos || []).find((x) => Number(x.numero) === Number(pedido));
  if (!p) return { problema: `el pedido #${pedido} no es de la espera de compilación de esta sesión (${(r.pedidos || []).map((x) => `#${x.numero}`).join(', ') || 'ninguno'}): el arreglo de un rojo de CI va en la sesión que abrió el pedido` };
  if (r.estado !== 'rojo' || p.veredicto !== 'rojo') return { problema: `la compilación del pedido #${pedido} no está en rojo (la espera dijo: ${p.veredicto}): no hay rojo que arreglar por esta vía` };
  if (!String(control || '').trim()) return { problema: '--check "<control que falló>" va con el nombre del control' };
  if (!allowedFiles.length) return { problema: 'la lista de archivos va con --file <ruta>, al menos uno' };
  if (codigo > tope) return { problema: `la lista nombra ${codigo} archivos de implementación y el arreglo de un rojo de CI llega hasta ${tope}: esto va por el camino corto de siempre o por una historia` };
  const repo = real(p.repo);
  const fuera = allowedFiles.filter((f) => { const rel = path.relative(repo, real(path.dirname(f))); return rel.startsWith('..') || path.isAbsolute(rel); });
  if (fuera.length) return { problema: `${fuera.length} archivo(s) de la lista no son del repo del pedido (${p.nombre}): ${fuera.slice(0, 3).join(', ')}` };
  const so = require('./save-ok.js');
  const sensibles = allowedFiles.map((f) => path.relative(repo, f).split(path.sep).join('/')).filter((rel) => so.esSensible(rel));
  if (sensibles.length) return { problema: `la lista toca lo sensible (${sensibles.join(', ')}): eso va con su firma de control, no por el arreglo de un rojo de CI` };
  // el control que falló tiene que poder correr en local: es lo único que frena el arreglo antes de empujar
  const { controles, errores } = controlesDe(repo);
  if (errores.length) return { problema: `no pude leer los controles de CI que corren en local en ${p.nombre}: ${errores.join('; ')}` };
  if (!controles.some((x) => x.nombre === String(control).trim())) {
    const hay = controles.map((x) => `«${x.nombre}»`).join(', ');
    return { problema: `«${String(control).trim()}» no es un control de CI que ${p.nombre} declare para correr en local (${hay || 'no declara ninguno'}): sin él nada frena el arreglo antes de empujar, y va por el camino corto de siempre` };
  }
  const punta = git(repo, ['rev-parse', 'HEAD']);
  if (punta.status !== 0) return { problema: `no pude leer la punta de ${p.nombre} (${String(punta.stderr || '').trim() || 'git no contestó'})` };
  const sha = punta.stdout.trim();
  if (p.commit && sha !== p.commit) return { problema: `la punta de ${p.nombre} (${sha.slice(0, 12)}) no es la que dio rojo (${String(p.commit).slice(0, 12)}): el arreglo se abre sobre el commit de la compilación en rojo` };
  return { ciRojo: { pedido: Number(pedido), control: String(control).trim(), repo, nombre: p.nombre, rama: p.rama || null, etapa: p.etapa || null, puntas: { [repo]: sha }, storyId: r.storyId || null } };
}

/** El freno de guardar del arreglo: el control que falló, otra vez, en local. `{ texto }` o null. */
function frenoAlGuardar(carril, { correr = (repo, o) => require('./ci-local-checks.js').correr(repo, o), controlesDe = (repo) => require('./ci-local-checks.js').controlesDe(repo) } = {}) {
  const c = carril && carril.ciRojo;
  if (!c) return null;
  const { controles, errores } = controlesDe(c.repo);
  if (errores.length) return { texto: `🔒 GUARDAR: el arreglo del rojo de CI del pedido #${c.pedido} no puede correr el control que falló: ${errores.join('; ')}` };
  const declarado = controles.find((x) => x.nombre === c.control);
  // al abrir estaba declarado: si el repo dejó de declararlo, no hay con qué frenar el arreglo
  if (!declarado) return { texto: `🔒 GUARDAR: el control «${c.control}» ya no está declarado para correr en local en ${c.nombre}: sin él no se guarda el arreglo del rojo de CI del pedido #${c.pedido}` };
  const r = correr(c.repo, { soloNombre: c.control });
  if (r.codigo !== 0) return { texto: `🔒 GUARDAR: el arreglo del rojo de CI del pedido #${c.pedido} todavía no pasa el control que falló: ${r.motivo}` };
  return null;
}

/** La lista de la espera de la compilación tras empujar el arreglo: el pedido con la punta nueva. */
function esperaTrasEmpujar(carril) {
  const c = carril && carril.ciRojo;
  if (!c) return null;
  const punta = git(c.repo, ['rev-parse', 'HEAD']);
  if (punta.status !== 0) return null;
  return [{ repo: c.repo, nombre: c.nombre, numero: c.pedido, rama: c.rama, commit: punta.stdout.trim() }];
}

module.exports = { validarApertura, frenoAlGuardar, esperaTrasEmpujar, resultadoDeLaSesion };
