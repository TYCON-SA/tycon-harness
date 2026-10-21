'use strict';
/**
 * followup-of.js — LA lectura del bloque `followup_of:` y del vocabulario de causas del reproceso.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * La lectura vive acá y la importan `lint-story-frontmatter.js` y `metrics/sdlc-stage-metrics.js`: con una copia en
 * cada uno, un defecto se arregla dos veces y se olvida una. Cuatro trampas que esta lectura cubre:
 *
 *   · una lista YAML **sin indentar** (`-` en la columna 0, estilo válido) tiene que reconocerse: si el
 *       bloque se acota con `after.search(/^\S/m)`, ese regex encuentra el PROPIO guion del primer
 *       item —un `-` es no-blanco— y deja el cuerpo en `''`. La story se evaporaría del conteo sin
 *       error ni aviso, y el invariante seguiría cerrando porque mide el universo ya empobrecido.
 *       🔴 El parser hermano de `followed_up_by:` sí la reconoce: dos formas de leer lo mismo darían
 *       resultados distintos.
 *   · `followup_of: []  # ninguno todavía` no es un seguimiento: comparar con `inline !== '[]'` falla porque el
 *       comentario rompe la igualdad exacta. Inflaría los contadores **y** haría que el lint frenara una story
 *       nueva que no tiene ningún seguimiento.
 *   · el bloque se ubica con `match.index`, no con `indexOf(match[0])`: si el literal
 *       `followup_of:` aparece antes en el frontmatter (dentro de un `title:`, por ejemplo), se
 *       leería el lugar equivocado.
 *   · `typeof j.causes === 'object'` acepta un **array**, y `Object.keys()` de un array devuelve
 *       los índices `"0","1","2"` — que pasarían por vocabulario, en verde.
 *
 * Es 0-deps y no toca disco salvo en `leerCausas`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── El bloque `followup_of:` ──────────────────────────────────────────────────────────────────

/**
 * Saca el comentario YAML de fin de línea. `[]  # ninguno` → `[]`.
 * Exige espacio antes del `#` para no romper un valor que lo contenga (`a#b`).
 */
function sinComentario(s) {
  return String(s == null ? '' : s).replace(/^\s*#.*$/, '').replace(/\s+#.*$/, '').trim();
}

/**
 * El cuerpo del bloque: desde después de la clave hasta la PRÓXIMA CLAVE de primer nivel.
 *
 * 🔴 «Próxima clave» es `nombre:` en la columna 0 — NO «la próxima línea que no arranca con un
 *    espacio». Un item de lista sin indentar arranca con `-`, que también es no-blanco: ésa es
 *    exactamente la confusión de la lista sin indentar.
 */
function cuerpoBloque(after) {
  const m = /^[A-Za-z_][\w.-]*[ \t]*:/m.exec(after);
  return m ? after.slice(0, m.index) : after;
}

/** `{inline, cuerpo}` del bloque `followup_of:`, o `null` si la clave no está. */
function bloqueFollowupOf(fm) {
  // `exec` para tener `m.index` REAL — `indexOf(m[0])` encuentra la PRIMERA aparición del texto,
  // que puede ser otra.
  const m = /^followup_of:[ \t]*(.*)$/m.exec(String(fm || ''));
  if (!m) return null;
  const inline = sinComentario(m[1]);
  const after = String(fm).slice(m.index + m[0].length);
  return { inline, cuerpo: inline || cuerpoBloque(after) };
}

/**
 * ¿La story declara `followup_of:` NO vacío? Inline (`[x]`) o bloque con al menos un `- item`,
 * indentado o no.
 */
function tieneFollowupOf(fm) {
  const b = bloqueFollowupOf(fm);
  if (!b) return false;
  if (b.inline) return b.inline !== '[]';
  return /^[ \t]*-[ \t]+\S/m.test(b.cuerpo);
}

/** Los `type:` declarados dentro del bloque, en orden. Lista vacía si no hay ninguno. */
function tiposDeFollowupOf(fm) {
  const b = bloqueFollowupOf(fm);
  if (!b || !tieneFollowupOf(fm)) return [];
  return [...b.cuerpo.matchAll(/^[ \t]*-?[ \t]*type:[ \t]*["']?([A-Za-z][A-Za-z-]*)/gm)].map((m) => m[1]);
}

// ── El vocabulario de causas ──────────────────────────────────────────────────────────────────

/**
 * `{ruta, hash, causas[], motivo}`. Con `motivo` NO se cuenta nada: quien llama publica `null`,
 * jamás un cero — cuatro barras en cero se leerían como «no volvió nada».
 */
function leerCausas(ruta) {
  let hash = null;
  try {
    const txt = fs.readFileSync(ruta, 'utf8');
    hash = require('crypto').createHash('sha256').update(txt).digest('hex').slice(0, 12);
    const j = JSON.parse(txt);
    // 🔴 `!Array.isArray` explícito: en JS un array TAMBIÉN es `typeof 'object'`, y `Object.keys()`
    //    de un array devuelve sus índices — `"0","1","2"` pasarían por vocabulario.
    const obj = j && typeof j.causes === 'object' && j.causes !== null && !Array.isArray(j.causes)
      ? j.causes : null;
    if (!obj) {
      return { ruta, hash, causas: [], motivo: 'el vocabulario de causas del reproceso no trae un objeto `causes` (¿es una lista?)' };
    }
    const causas = Object.keys(obj);
    if (!causas.length) return { ruta, hash, causas: [], motivo: 'el vocabulario de causas del reproceso está vacío' };
    return { ruta, hash, causas, motivo: null };
  } catch (e) {
    return { ruta, hash, causas: [],
      motivo: `no se pudo leer el vocabulario de causas del reproceso (${e.code === 'ENOENT' ? 'ausente' : e.message})` };
  }
}

// ── ¿La story NACE en este commit? ────────────────────────────────────────────────────────────

/**
 * `true` sólo si el archivo no tiene NINGUNA historia previa bajo ninguna identidad.
 *
 * Tres preguntas, en orden de costo. Las dos últimas sólo se hacen si la primera no alcanzó, o sea
 * casi nunca (una story nueva por commit, como mucho):
 *
 *   1. ¿Hay historia en este repo? Sin repo git, sin `git`, o **con el repo recién inicializado y
 *      cero commits** → «no sé» → **existente**. 🔴 Que un repo sin commits cuente como existente
 *      es una DECISIÓN, no el resultado de un `catch` genérico: el día que alguien
 *      importa un repo entero de stories, el primer commit tendría CADA story «naciendo» y el
 *      lint bloquearía la importación completa. Un freno que muerde en el onboarding se apaga.
 *   2. La historia del archivo **siguiendo renombres** (`--follow`).
 *   3. Si aun así no hay historia: ¿existe ya en `HEAD` una story con **el mismo `story:`**? Un
 *      `git mv` acompañado de una reescritura grande hace que git la reporte como borrado+alta en
 *      vez de renombre, y ahí `--follow` tampoco la encuentra. La identidad declarada
 *      sí — es el mismo criterio con el que todo este arnés decide qué es una story.
 *
 * Falla siempre hacia **existente** (avisar), nunca hacia **nace ahora** (frenar): un freno que no
 * puede decidir no frena.
 */
function naceAhora(abs, storyId) {
  const dir = path.dirname(abs);
  const git = (args, cwd) => execFileSync('git', args, {
    cwd: cwd || dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  });

  try { git(['rev-parse', '--verify', 'HEAD']); } catch { return false; }          // (1)

  try {
    if (git(['log', '-1', '--follow', '--format=%H', '--', path.basename(abs)]).trim() !== '') return false;  // (2)
  } catch { return false; }

  if (!storyId) return true;
  try {                                                                            // (3)
    const raiz = git(['rev-parse', '--show-toplevel']).trim();
    if (!raiz) return true;
    for (const patron of [`story: "${storyId}"`, `story: '${storyId}'`, `story: ${storyId}`]) {
      let hit = '';
      // `git grep` sale 1 cuando no encuentra: eso es una respuesta, no un error.
      try { hit = git(['grep', '-l', '--fixed-strings', patron, 'HEAD', '--', '*.md'], raiz); } catch { hit = ''; }
      if (hit.trim() !== '') return false;
    }
  } catch { return false; }
  return true;
}

module.exports = { tieneFollowupOf, tiposDeFollowupOf, leerCausas, naceAhora, sinComentario, cuerpoBloque };
