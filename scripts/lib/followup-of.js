'use strict';
/**
 * followup-of.js — LA lectura del bloque `followup_of:` y del vocabulario de causas del reproceso.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * La story 2.3 nació con esta lógica ESCRITA DOS VECES —una en `lint-story-frontmatter.js` y otra
 * en `metrics/sdlc-stage-metrics.js`, copiada a mano «con el mismo criterio»— y el pase adversarial
 * del 2026-09-05 encontró **cuatro defectos que vivían en las dos copias a la vez**:
 *
 *   (A) una lista YAML **sin indentar** (`-` en la columna 0, estilo válido) no se reconocía: el
 *       bloque se acotaba con `after.search(/^\S/m)`, que encuentra el PROPIO guion del primer
 *       item —un `-` es no-blanco— y deja el cuerpo en `''`. La story se evaporaba del conteo sin
 *       error ni aviso, y el invariante seguía cerrando porque medía el universo ya empobrecido.
 *       🔴 Era una **regresión**: el parser hermano de `followed_up_by:`, que la 2.3 no tocó, sí
 *       la reconoce — dos formas de leer lo mismo, una nueva y peor.
 *   (B) `followup_of: []  # ninguno todavía` contaba como seguimiento, porque la comparación era
 *       `inline !== '[]'` y el comentario rompe la igualdad exacta. Inflaba los contadores **y**
 *       hacía que el lint frenara una story nueva que no tiene ningún seguimiento.
 *   (E) el bloque se ubicaba con `indexOf(match[0])` en vez de `match.index`: si el literal
 *       `followup_of:` aparecía antes en el frontmatter (dentro de un `title:`, por ejemplo), se
 *       leía el lugar equivocado.
 *   (F) `typeof j.causes === 'object'` acepta un **array**, y `Object.keys()` de un array devuelve
 *       los índices `"0","1","2"` — que habrían pasado por vocabulario, en verde.
 *
 * Arreglar cuatro defectos en dos archivos es arreglarlos ocho veces y olvidarse de uno. La lección
 * ya está pagada en este repo dos veces: los dos diccionarios de estados (story 2.2) y
 * `release-notes.sh` copiado en 8 repos. Por eso la lectura vive acá y los dos la importan.
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
 *    exactamente la confusión del defecto (A).
 */
function cuerpoBloque(after) {
  const m = /^[A-Za-z_][\w.-]*[ \t]*:/m.exec(after);
  return m ? after.slice(0, m.index) : after;
}

/** `{inline, cuerpo}` del bloque `followup_of:`, o `null` si la clave no está. */
function bloqueFollowupOf(fm) {
  // `exec` para tener `m.index` REAL — `indexOf(m[0])` encuentra la PRIMERA aparición del texto,
  // que puede ser otra (defecto E).
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
    //    de un array devuelve sus índices — `"0","1","2"` habrían pasado por vocabulario (F).
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
 *      es una DECISIÓN, no el resultado de un `catch` genérico (defecto D): el día que alguien
 *      importa un repo entero de stories, el primer commit tendría CADA story «naciendo» y el
 *      lint bloquearía la importación completa. Un freno que muerde en el onboarding se apaga.
 *   2. La historia del archivo **siguiendo renombres** (`--follow`).
 *   3. Si aun así no hay historia: ¿existe ya en `HEAD` una story con **el mismo `story:`**? Un
 *      `git mv` acompañado de una reescritura grande hace que git la reporte como borrado+alta en
 *      vez de renombre, y ahí `--follow` tampoco la encuentra (defecto C). La identidad declarada
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
