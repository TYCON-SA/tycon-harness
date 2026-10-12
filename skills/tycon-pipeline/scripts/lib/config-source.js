'use strict';

/**
 * config-source.js — de dónde leen los FRENOS la config del repo (FIX-1, 2026-08-25).
 *
 * ── EL PROBLEMA QUE CIERRA ──────────────────────────────────────────────────────────────────────
 * Casi todos los frenos del arnés consultan `.tycon/advisors.yaml` **como está en la carpeta de
 * trabajo**. O sea: alcanza con escribir ese archivo —sin commitearlo, sin que quede rastro en
 * ningún commit— para apagarlos. Y como un `.yaml` no es código, tampoco despierta a los revisores
 * automáticos ni al freno de commit. El resultado no es un error: es **silencio**.
 *
 * Reproducido el 2026-08-25 (auditoría del arnés, casos C1/C3/C8/C9): con
 * `stories.id_pattern: '^ZZZ-[0-9]+$'` escrito sólo en la carpeta, **ninguna story es una story** y
 * los dos frenos que impiden cerrar una story sin evidencia —el del commit y el de la edición—
 * dejan de existir, con exit 0 y cero mensajes.
 *
 * El arnés YA había decidido no permitir esto en un freno hermano: `pipeline.story_gate` se lee de
 * lo COMMITEADO, y su comentario explica por qué — *"si apagarlo fuera un Write a un yaml, el
 * agente lo apagaría en un turno"*. Lo que faltaba era extender esa disciplina al resto de las
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
 * 🔴 **La unión, no "manda lo commiteado" a secas**: el commit que *introduce* un patrón nuevo
 * —caso real en el backend de un producto del equipo, que hace visibles 18 stories `AP-*`/`CO-*`— dejaría esas stories
 * fuera del freno justo en ese commit si sólo mirara HEAD — guides/incident-log.md#config-de-frenos-en-la-carpeta-2026-08-25
 *
 * ── EFECTO DE BORDE, A PROPÓSITO ────────────────────────────────────────────────────────────────
 * El primer commit que declare un **repo hermano nuevo** dará rojo hasta que ese commit esté hecho.
 * Es la dirección correcta de falla, y los frenos lo dicen en su mensaje en vez de dejar al dev
 * adivinando.
 *
 * Costo: una lectura de git (~10ms) que el freno hermano ya paga, cacheada por proceso. El
 * comportamiento sólo cambia cuando la carpeta difiere de lo commiteado — medido, `.tycon/` se toca
 * entre 2 y 15 veces cada 6 meses por repo.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NOMBRES = ['advisors.yaml', 'advisors.yml'];
const _cache = new Map();

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
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

/** El yaml tal como está en el ÚLTIMO COMMIT, o null si no está commiteado. */
function leerCommiteado(repoRoot) {
  for (const n of NOMBRES) {
    try { return git(repoRoot, ['show', `HEAD:.tycon/${n}`]); } catch (_e) { /* siguiente */ }
  }
  return null;
}

function tieneHead(repoRoot) {
  try { git(repoRoot, ['rev-parse', '--verify', 'HEAD']); return true; } catch (_e) { return false; }
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
  if (_cache.has(repoRoot)) return _cache.get(repoRoot);
  const carpeta = leerCarpeta(repoRoot);
  const commiteado = leerCommiteado(repoRoot);
  const hayHistoria = commiteado !== null || tieneHead(repoRoot);
  const out = { carpeta, commiteado, hayHistoria, difieren: (carpeta || '') !== (commiteado || '') };
  _cache.set(repoRoot, out);
  return out;
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
 * apagan un control. Se leían de la carpeta: escribir `off` sin commitear alcanzaba, y crear ese
 * archivo tampoco genera evento de implementación (`.tycon` está en NEVER_CODE_SEGMENTS y los
 * archivos sin extensión no están en CODE_EXTS), así que no lo miraba nada.
 *
 * @param {string} repoRoot
 * @param {string} relativo  ruta dentro del repo, ej. `.tycon/atdd-gate`
 * @returns {string|null}
 */
function archivoParaFreno(repoRoot, relativo) {
  if (!repoRoot || !relativo) return null;
  const rel = String(relativo).replace(/\\/g, '/');
  let commiteado = null;
  try { commiteado = git(repoRoot, ['show', `HEAD:${rel}`]); } catch (_e) { commiteado = null; }
  if (commiteado !== null) return commiteado;
  // Sin el archivo en HEAD: si el repo TIENE historia, esa ausencia es la respuesta (no está
  // commiteado ⇒ no cuenta). Sin historia todavía no hay contra qué contrastar → la carpeta.
  if (tieneHead(repoRoot)) return null;
  try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch (_e) { return null; }
}

/** Limpia el cache (los tests corren varios repos en el mismo proceso). */
function limpiarCache() { _cache.clear(); }

module.exports = { leerCarpeta, leerCommiteado, leerAmbas, textoParaFreno, archivoParaFreno, limpiarCache, NOMBRES };
