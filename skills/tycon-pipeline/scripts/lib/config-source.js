'use strict';

/**
 * config-source.js — de dónde leen los FRENOS la config del repo.
 *
 * ── EL PROBLEMA QUE CIERRA ──────────────────────────────────────────────────────────────────────
 * Casi todos los frenos del arnés consultan `.tycon/advisors.yaml` **como está en la carpeta de
 * trabajo**. O sea: alcanza con escribir ese archivo —sin commitearlo, sin que quede rastro en
 * ningún commit— para apagarlos. Y como un `.yaml` no es código, tampoco despierta a los revisores
 * automáticos ni al freno de commit. El resultado no es un error: es **silencio**.
 *
 * Ejemplo: con `stories.id_pattern: '^ZZZ-[0-9]+$'` escrito sólo en la carpeta, **ninguna story es una story** y
 * los dos frenos que impiden cerrar una story sin evidencia —el del commit y el de la edición—
 * dejan de existir, con exit 0 y cero mensajes.
 *
 * El arnés ya decide no permitir esto en un freno hermano: `pipeline.story_gate` se lee de
 * lo COMMITEADO, y su comentario explica por qué — *"si apagarlo fuera un Write a un yaml, el
 * agente lo apagaría en un turno"*. Esa disciplina se extiende al resto de las
 * llaves que aflojan frenos. Esto es esa extensión.
 *
 * ── LA REGLA, EN UNA FRASE ──────────────────────────────────────────────────────────────────────
 * 🔴 **AFLOJAR exige commit; APRETAR vale al toque.**
 *
 * De ahí salen dos modos, y cuál va en cada llave lo decide su DIRECCIÓN:
 *
 *   · `soloCommiteado` — para las llaves donde escribir algo AFLOJA el freno (declarar un repo
 *     hermano cuya evidencia cuenta como propia; apagar un aviso con `off`). El working tree se
 *     ignora: si querés aflojar, commitealo y que se vea en el diff.
 *   · `union` — para las llaves donde el valor DELIMITA a qué se le aplica el freno (el patrón de
 *     ids de story, los nombres de carpeta que marcan el frente). Se gatea si matchea lo commiteado
 *     **o** lo de la carpeta: ampliar entra al instante, recortar espera al commit.
 *
 * 🔴 **La unión, no "manda lo commiteado" a secas**: el commit que *introduce* un patrón nuevo (por ejemplo, uno que hace
 * visibles 18 stories `AP-*`/`CO-*`) dejaría esas stories fuera del freno justo en ese commit si sólo mirara HEAD.
 *
 * ── EFECTO DE BORDE, A PROPÓSITO ────────────────────────────────────────────────────────────────
 * El primer commit que declare un **repo hermano nuevo** dará rojo hasta que ese commit esté hecho.
 * Es la dirección correcta de falla, y los frenos lo dicen en su mensaje en vez de dejar al dev
 * adivinando.
 *
 * Costo: lo commiteado se pregunta a git una vez por carpeta mientras no cambie su huella (`lib/git-stamp.js`: el
 * `HEAD`, su historial y el índice, leídos del disco): «¿hay historia?» y la lista de `.tycon/` del `HEAD`, y el
 * contenido sólo de lo que está. La carpeta de trabajo se lee del disco cada vez: nunca se recuerda. Una respuesta
 * fallida de git (no contestó, salió con error) tampoco se recuerda.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { memo } = require('./git-stamp.js');

const NOMBRES = ['advisors.yaml', 'advisors.yml'];
const _cache = new Map();

function git(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], {
    windowsHide: true,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
  });
}

/** El yaml tal como está en la CARPETA de trabajo, o null. */
function leerCarpeta(repoRoot) {
  for (const n of NOMBRES) {
    try { return fs.readFileSync(path.join(repoRoot, '.tycon', n), 'utf8'); } catch (_e) { /* siguiente */ }
  }
  return null;
}

/**
 * ¿El repo tiene un commit? `rev-parse -q --verify` sale 0 (true) o 1 (false); otra cosa es git que no contestó (null,
 * sin recordar).
 */
function cabeza(repoRoot) {
  return memo(_cache, repoRoot, 'head', () => {
    const r = git(repoRoot, ['rev-parse', '-q', '--verify', 'HEAD']);
    if (!r.error && r.status === 0) return { valor: true, recordar: true };
    if (!r.error && r.status === 1) return { valor: false, recordar: true };
    return { valor: null, recordar: false };
  });
}
/** Como siempre: git que no contestó cuenta como «sin historia». */
const tieneHead = (repoRoot) => cabeza(repoRoot) === true;

/** Los archivos de `.tycon/` en el `HEAD` (un Set), o null si git no contestó. Sin historia, vacío. */
function tyconCommiteado(repoRoot) {
  return memo(_cache, repoRoot, 'tycon', () => {
    const h = cabeza(repoRoot);
    if (h === null) return { valor: null, recordar: false };
    if (h === false) return { valor: new Set(), recordar: true };
    // --full-tree: la ruta y lo que imprime son desde la raíz, como `show HEAD:<ruta>`, aunque repoRoot sea una subcarpeta
    const r = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', 'HEAD', '--', '.tycon/']);
    if (r.error || r.status !== 0) return { valor: null, recordar: false };
    return { valor: new Set(String(r.stdout).split('\0').filter(Boolean)), recordar: true };
  });
}

/** El contenido de `rel` en el `HEAD`, o null si no está commiteado (o git no contestó). */
function commiteadoDe(repoRoot, rel) {
  return memo(_cache, repoRoot, `show:${rel}`, () => {
    const lista = rel.startsWith('.tycon/') ? tyconCommiteado(repoRoot) : null;
    if (lista && !lista.has(rel)) return { valor: null, recordar: true };
    const r = git(repoRoot, ['show', `HEAD:${rel}`]);
    if (!r.error && r.status === 0) return { valor: r.stdout, recordar: true };
    // sin la lista no se distingue «no está» de «git no contestó»: no se recuerda
    return { valor: null, recordar: false };
  });
}

/** El yaml tal como está en el ÚLTIMO COMMIT, o null si no está commiteado. */
function leerCommiteado(repoRoot) {
  for (const n of NOMBRES) {
    const v = commiteadoDe(repoRoot, `.tycon/${n}`);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Las dos versiones del yaml del repo.
 *
 * @returns {{carpeta: string|null, commiteado: string|null, hayHistoria: boolean, difieren: boolean}}
 *   `hayHistoria: false` = el repo no tiene ni un commit (o no es git). Ahí no hay nada que
 *   proteger todavía y el llamador debe caer a la carpeta: fail-open explícito, no silencioso.
 */
function leerAmbas(repoRoot) {
  if (!repoRoot) return { carpeta: null, commiteado: null, hayHistoria: false, difieren: false };
  const carpeta = leerCarpeta(repoRoot);
  const commiteado = leerCommiteado(repoRoot);
  const hayHistoria = commiteado !== null || tieneHead(repoRoot);
  return { carpeta, commiteado, hayHistoria, difieren: (carpeta || '') !== (commiteado || '') };
}

/**
 * El texto que un FRENO debe leer cuando la llave AFLOJA (modo `soloCommiteado`).
 * Sin historia todavía → la carpeta (no hay commit contra el cual contrastar).
 */
function textoParaFreno(repoRoot) {
  const a = leerAmbas(repoRoot);
  return a.hayHistoria ? a.commiteado : a.carpeta;
}

/**
 * El contenido de un archivo SUELTO de `.tycon/` (no el yaml) tal como lo debe leer un FRENO:
 * el COMMITEADO. Sin historia git todavía, la carpeta.
 *
 * Existe para las escotillas de emergencia — archivos de una palabra como `.tycon/atdd-gate`, que
 * apagan un control. Leídos de la carpeta, escribir `off` sin commitear alcanzaría, y crear ese
 * archivo tampoco genera evento de implementación (`.tycon` está en NEVER_CODE_SEGMENTS y los
 * archivos sin extensión no están en CODE_EXTS), así que no lo mira nada.
 *
 * @param {string} repoRoot
 * @param {string} relativo  ruta dentro del repo, ej. `.tycon/atdd-gate`
 * @returns {string|null}
 */
function archivoParaFreno(repoRoot, relativo) {
  if (!repoRoot || !relativo) return null;
  const rel = String(relativo).replace(/\\/g, '/');
  const commiteado = commiteadoDe(repoRoot, rel);
  if (commiteado !== null) return commiteado;
  // Sin el archivo en HEAD: si el repo TIENE historia, esa ausencia es la respuesta (no está
  // commiteado ⇒ no cuenta). Sin historia todavía no hay contra qué contrastar → la carpeta.
  if (tieneHead(repoRoot)) return null;
  try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch (_e) { return null; }
}

/** Limpia el cache (los tests corren varios repos en el mismo proceso). */
function limpiarCache() { _cache.clear(); }

module.exports = { leerCarpeta, leerCommiteado, leerAmbas, textoParaFreno, archivoParaFreno, limpiarCache, NOMBRES };
