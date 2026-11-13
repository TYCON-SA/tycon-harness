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
 *   4. Si HEAD no la conoce y hay un merge en curso: las preguntas 2 y 3 desde cada cabeza del merge
 *      (`MERGE_HEAD`). Traer main a una rama atrasada mete en lo preparado para el commit las historias
 *      que main ya tenía; su historia vive en la cabeza del merge, no en HEAD. Sin merge en curso esto
 *      cuesta una sola llamada (la que ubica `MERGE_HEAD`), y sólo cuando HEAD no alcanzó.
 *
 * Falla siempre hacia **existente** (avisar), nunca hacia **nace ahora** (frenar): un freno que no
 * puede decidir no frena. Un `MERGE_HEAD` que no se lee, o una cabeza que no es un commit del repo,
 * es «no sé».
 */
function naceAhora(abs, storyId) {
  const dir = path.dirname(abs);
  const archivo = path.basename(abs);
  const git = (args, cwd) => execFileSync('git', args, {
    windowsHide: true,
    cwd: cwd || dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  });
  // ¿Esta revisión ya conoce la story, por su archivo (2) o por su `story:` (3)? `null` = no se pudo saber.
  // Sin revisión, las preguntas van a HEAD con las mismas llamadas de siempre.
  const laConoce = (rev) => {
    try {
      const log = ['log', '-1', '--follow', '--format=%H', ...(rev ? [rev] : []), '--', archivo];
      if (git(log).trim() !== '') return true;                                       // (2)
    } catch { return null; }
    if (!storyId) return false;
    try {                                                                            // (3)
      const raiz = git(['rev-parse', '--show-toplevel']).trim();
      if (!raiz) return false;
      // Con comillas, la comilla de cierre corta el número. Sin comillas, el número tiene que terminar el renglón (o
      // seguir un comentario): `story: 9.2` no es `story: 9.26`.
      const sinComillas = String(storyId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const busquedas = [
        ['--fixed-strings', `story: "${storyId}"`],
        ['--fixed-strings', `story: '${storyId}'`],
        ['-E', `story: ${sinComillas}[[:space:]]*(#.*)?$`],
      ];
      for (const [modo, patron] of busquedas) {
        let hit = '';
        // `git grep` sale 1 cuando no encuentra: eso es una respuesta. Cualquier otra salida es un error: «no sé».
        try { hit = git(['grep', '-l', modo, '-e', patron, rev || 'HEAD', '--', '*.md'], raiz); } catch (e) {
          if (!e || e.status !== 1) return null;
        }
        if (hit.trim() !== '') return true;
      }
    } catch { return null; }
    return false;
  };

  try { git(['rev-parse', '--verify', 'HEAD']); } catch { return false; }          // (1)

  const enHead = laConoce(null);
  if (enHead !== false) return false;

  const cabezas = cabezasDelMerge(git, dir);                                        // (4)
  if (cabezas === null) return false;
  for (const cabeza of cabezas) {
    try { git(['rev-parse', '--verify', '--quiet', `${cabeza}^{commit}`]); } catch { return false; }
    if (laConoce(cabeza) !== false) return false;
  }
  return true;
}

/**
 * Las cabezas de un merge en curso: un hash por renglón del archivo `MERGE_HEAD`, que se ubica con
 * `git rev-parse --git-path` (en un worktree no está en `<raíz>/.git`). `[]` sin merge en curso (el
 * archivo no existe o está vacío); `null` si no se pudo leer.
 */
function cabezasDelMerge(git, dir) {
  let ruta;
  try { ruta = git(['rev-parse', '--git-path', 'MERGE_HEAD']).trim(); } catch { return null; }
  if (!ruta) return null;
  let raw;
  try { raw = fs.readFileSync(path.resolve(dir, ruta), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

module.exports = { tieneFollowupOf, tiposDeFollowupOf, leerCausas, naceAhora, sinComentario, cuerpoBloque };
