#!/usr/bin/env node
/**
 * lint-story-frontmatter.js — chequea que el frontmatter de cada story sea LEGIBLE
 * por las herramientas del harness.
 *
 * POR QUÉ EXISTE
 * ---------------
 * Un frontmatter **sin el `---` de cierre** no hace quejar a ninguna herramienta: todas hacen
 * `content.indexOf('\n---', 3)` y, al no encontrarlo (o al enganchar una regla horizontal `---` del cuerpo), se
 * saltean la story EN SILENCIO. La story queda invisible para el validator, el backfill de back-links, los scripts
 * de status y el hook de DoD, y puede ocultar una deuda de evidencia DoD.
 *
 * Segundo modo de falla de la misma familia: **comillas dobles dentro del comentario
 * inline** de un campo escalar (típico en `status:`). El scalar que usan las tools es
 *     /^status:\s*"?([^"\n]+?)"?\s*$/m
 * y el `[^"]` corta en la primera comilla → el `$` no matchea → el campo da `null` →
 * el colector descarta la story igual que en el caso anterior.
 *
 * QUÉ CHEQUEA
 * -----------
 *   1. El archivo abre con `---` y **cierra** el frontmatter.
 *   2. Los 3 campos que todo colector exige (`story`, `epic`, `status`) se pueden
 *      leer con EL MISMO regex que usan las herramientas del harness.
 *   3. Bonus, si hay python3 + PyYAML disponible: el frontmatter parsea como YAML.
 *      Si no está, se saltea con aviso (fail-open, no rompe el commit de nadie).
 *   4. La CAUSA del reproceso: una story que declara
 *      `followup_of:` dice por qué hubo que volver en `followup_reason:`, con el vocabulario
 *      CERRADO de `scripts/metrics/rework-causes.json`. Se le EXIGE sólo a la story que NACE
 *      en este commit (sin historial en git); a una que ya existía sin el campo se le AVISA y no
 *      se la frena. Hay cientos de stories con `followup_of:` repartidas en varios repos:
 *      exigírselo a todas pondría en rojo el pre-commit de todo el equipo el día del merge, o sea
 *      apagaría este lint en una semana. Un valor FUERA del vocabulario frena siempre, nueva o
 *      vieja, sin normalizar mayúsculas ni acentos (un vocabulario que acepta variantes deja de
 *      ser cerrado). Sin git, o fuera de un repo, no se puede saber si nace ahora → se la trata
 *      como existente: un freno que no puede decidir no frena. Si el vocabulario no se puede
 *      leer, se avisa a los gritos y la regla no corre en esa corrida (fail-open RUIDOSO: es un
 *      hueco declarado, no un OK).
 *
 *   5. Los ARCHIVOS A MODIFICAR existen: cada ruta de `files_to_modify:` está en el código del
 *      producto (el repo de la story o un repo hermano). Frena a la story que NACE en este commit; a
 *      una que ya existía se le avisa (sus archivos pudieron moverse). Si el repo de código no está
 *      clonado, avisa y no frena. El detalle, en la cabecera de `checkStory`.
 *
 * IMPORTANTE: el chequeo naive `awk '/^---$/'` NO alcanza — cualquier regla
 * horizontal del cuerpo lo satisface. Por eso acá se replica el parser real.
 *
 * USO
 *   node scripts/lib/lint-story-frontmatter.js              # todas las stories
 *   node scripts/lib/lint-story-frontmatter.js a.md b.md    # solo esos archivos
 *
 * Exit code: 0 si OK, 1 si hay alguna story ilegible.
 *
 * ADOPCIÓN POR REPO — SIN COPIAR EL SCRIPT
 * ----------------------------------------
 * Este archivo vive SOLO acá. Los repos lo referencian por path; no se duplica.
 * Se puede porque el onboarding del equipo clona el arnés en una ruta
 * fija (`~/.claude/tycon-harness`) y el hook `SessionStart` le hace
 * `git pull` en cada arranque → está en la máquina de todos los devs. Y porque un
 * `pre-commit` corre SIEMPRE en local, nunca en CI: no hay otro entorno donde el
 * path pueda faltar.
 *
 * Pegar en el `.githooks/pre-commit` del repo:
 *
 *     TYCON_GUIDES_DIR="${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}"
 *     FM_LINT="$TYCON_GUIDES_DIR/scripts/lib/lint-story-frontmatter.js"
 *     # Se le pasan TODOS los .md del commit: el filtro "esto es una story" lo hace el lint. Con un grep
 *     # `^specs/stories/.*\.md$`, en un repo con otro layout el hook no le pasaría NADA y el lint diría OK sin haber
 *     # mirado una sola story.
 *     # Con los renombres (R), y separados por NUL: un nombre con tildes o espacios no se escapa.
 *     CHANGED_STORIES=()
 *     while IFS= read -r -d '' f; do case "$f" in *.md) CHANGED_STORIES+=("$f") ;; esac
 *     done < <(git -c core.quotePath=false diff --cached --name-only -z --diff-filter=ACMR)
 *     if [ "${#CHANGED_STORIES[@]}" -gt 0 ]; then
 *       if [ ! -f "$FM_LINT" ]; then
 *         echo "⚠️  No encontre $FM_LINT — se saltea el lint de frontmatter."
 *         echo "   Cloná el arnés (onboarding) o exportá TYCON_GUIDES_DIR."
 *       else
 *         echo "→ Lint de frontmatter de stories..."
 *         if ! node "$FM_LINT" "${CHANGED_STORIES[@]}"; then
 *           echo "❌ Hay stories que el harness no puede leer."
 *           exit 1
 *         fi
 *       fi
 *     fi
 *
 * Y `./scripts/setup-githooks.sh` (una vez por clone) si el repo no lo tenía.
 *
 * Fail-open RUIDOSO a propósito: si falta el repo de guías avisa pero no bloquea el
 * commit — un repo hermano ausente es un problema de setup, no del commit.
 *
 * NOTA: los repos le pasan los archivos como argumentos; sin argumentos, DESCUBRE las carpetas
 * de stories del repo (`story-discovery.js` del pipeline) en vez de asumir `<repo>/specs/stories`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const os = require('os');

const REQUIRED = ['story', 'epic', 'status'];

// ── La causa del reproceso — `followup_reason:` ───────────────────────────────────────────────
//
// 🔴 La LECTURA (bloque `followup_of:`, vocabulario de causas, «¿nace en este commit?») vive en UN
//    solo lugar, `followup-of.js` (su vecino en scripts/lib/), que este archivo y `metrics/sdlc-stage-metrics.js` importan.
//    Escrita DOS veces «con el mismo criterio», dejaría los mismos defectos en las dos copias a la vez (lista YAML sin
//    indentar invisible, `[] # comentario` contado como seguimiento, `indexOf` en vez de `.index`,
//    y un array aceptado como vocabulario). El motivo de cada uno está en la cabecera de esa lib.
const { tieneFollowupOf, leerCausas, naceAhora } = require('./followup-of.js');

// `TYCON_CAUSES_PATH` existe para los casos de prueba; el medidor deja rastro en el snapshot de qué
// archivo usó de verdad, así que no es un interruptor invisible.
const { readEnv } = require('./legacy-names.js');
const CAUSAS_PATH = readEnv('TYCON_CAUSES_PATH', { where: 'scripts/lib/lint-story-frontmatter.js' })
  || path.join(__dirname, '..', 'metrics', 'rework-causes.json');

// ── Qué archivos son "una story" — por IDENTIDAD DECLARADA ───────────────────────────────────
//
// El detector decide por lo ÚNICO que declara "yo soy una story": la clave `story:`. Decidir por RUTA
// (`<repo>/specs/stories/`) deja sin mirar un repo con otro layout: el lint diría "✅ OK", el control que existe para
// que ninguna story se pierda en silencio, perdiéndose en silencio. Decidir por vivir en una carpeta con stories
// legibles, o por declarar `story:` / `epic:` / `status:`, rechazaría cientos de `.md` legítimos: las stories y los
// documentos de planning viven en la MISMA carpeta, y cada prd/architecture/epics/brief/report declara `status:`. Un
// gate que rechaza commits legítimos se apaga, y se lleva puestos también los casos donde sí importaba.
//
// Por qué `story:` y no `status:`: **`story:` es IDENTIDAD, `status:` es ESTADO.** Un PRD, una
// arquitectura, un épico, un brief y un reporte de readiness tienen estado; ninguno tiene número
// de story. Verificado uno por uno sobre los 13 documentos de planning del corpus (0 declaran
// `story:`) y sobre 12 repos (~12.000 `.md`).
//
// 🔴 POR QUÉ ESTO SIGUE ATRAPANDO UNA STORY ROTA — que es el bug que este lint persigue.
// Los 2 modos de rotura documentados NO tocan la línea `story:`:
//   modo 1 — falta el `---` de cierre → rompe el CIERRE del bloque, no su contenido. Y acá la
//            rotura AGRANDA la zona mirada (ver frontmatterZone): un archivo roto se mira con más
//            ganas, no con menos.
//   modo 2 — comillas dobles en el comentario inline de `status:` → rompe el valor de OTRO campo.
// Por eso el detector es a propósito más LAXO que el chequeo: busca el TEXTO de la clave, no su
// valor parseado. El detector tolera; el que falla es el chequeo estricto de más abajo.
//
// 🔴 LO QUE NO SE USA COMO REQUISITO, A PROPÓSITO: el NOMBRE del archivo y los headers del CUERPO
// (`## Acceptance Criteria`). Los dos parecen señales robustas y los dos se rompen al cambiar de
// repo: hay stories reales que se llaman `story-N.M-slug.md` (ningún patrón de id razonable
// las matchea) y otras que escriben `## Acceptance criteria` con minúscula. Exigir cualquiera de las dos
// deja esas stories AFUERA del lint — o sea: story rota, "✅ OK", exit 0. Que es exactamente el
// modo de falla que este archivo existe para impedir.
// La asimetría que sí vale: una lista de EXCLUSIÓN por nombre degrada del lado seguro (si se queda
// vieja se lintea de más, y eso se ve al instante). Por eso el nombre aparece sólo para sacar
// plantillas.
//
// Resolución TOLERANTE de TYCON_SKILLS_DIR (acepta la raíz del clon O la carpeta de skills —
// las dos semánticas conviven documentadas; ver scripts/lib/skills-dir.js).
const SKILLS_DIR = require('./skills-dir.js').resolveSkillsDirs().skills;
const DISCOVERY_PATH = path.join(SKILLS_DIR, 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');
let discovery = null;
try {
  discovery = require(DISCOVERY_PATH);
} catch {
  /* fail-open: se avisa más abajo, una sola vez, y se cae al layout clásico */
}

/** Carpetas del repo donde hay stories legibles. Vacío si el descubridor no está disponible. */
function storyDirsOf(repoRoot) {
  if (!discovery || !repoRoot) return [];
  try {
    return discovery.findStoryDirs(repoRoot, { budgetMs: 15000, cache: false });
  } catch {
    return [];
  }
}

/**
 * Nombres que NUNCA son una story. Sólo plantillas: `_template-gold.md` declara
 * `story: "{N.NN}"` (un placeholder) y un `status: "backlog"  # backlog | ready-for-dev | …` cuyo
 * comentario rompe el scalar a propósito — o sea que entraría y fallaría, y el "arreglo" que el
 * error sugeriría es borrarle a la plantilla la documentación de sus valores legales.
 * Anclado a los EXTREMOS del nombre a propósito: `story-N.M-template-render-fail-loud.md` y
 * `story-N.M-template-de-spec.md` son stories REALES, y con el patrón sin anclar se perderían.
 */
const NOT_A_STORY_NAME = /^_|^(?:template|plantilla|ejemplo|example)[-_.]|[-_.](?:template|plantilla|ejemplo|example)$/i;

/** La clave de identidad. Case-insensitive y tolerante a indentación: el detector tolera. */
const DECLARES_STORY = /^[ \t]*story[ \t]*:/mi;

/**
 * La evidencia de QA de una story (`specs/qa/<sid>-legibilidad.md` y su par de la pantalla) declara a qué story
 * pertenece y su veredicto, pero no es una story: no tiene epic ni status. Se reconoce por las DOS cosas juntas —vivir en
 * una carpeta `qa/` y traer `veredicto:` en el encabezado—, para que una story de verdad que alguien deja en una
 * carpeta `qa/` se siga linteando.
 */
const DECLARES_VERDICT = /^[ \t]*veredicto[ \t]*:/mi;
const isQaEvidence = (abs, zone) => path.basename(path.dirname(abs)).toLowerCase() === 'qa' && zone !== null && DECLARES_VERDICT.test(zone);

/** Forma de story sin identidad declarada (`epic:` sin `story:`) — no bloquea, se AVISA. */
const STORY_SHAPED = /^[ \t]*epic[ \t]*:/mi;

/**
 * Zona donde se busca la identidad. TOLERANTE A ROTURA por diseño:
 *   - el archivo no abre con `---`      → null (no hay frontmatter que romper)
 *   - el frontmatter cierra             → sólo el frontmatter (un `story:` del cuerpo no cuenta)
 *   - el frontmatter NO cierra (modo 1) → TODA la cabecera
 * La última rama es la clave: es el modo de rotura que deja stories invisibles durante meses. Si un
 * archivo abrió `---` y no lo cerró ya tiene un defecto real, así que mirarlo de más no se puede
 * equivocar — la rotura no puede esconder la evidencia de que esto era una story.
 */
function frontmatterZone(head) {
  const t = head.charCodeAt(0) === 0xFEFF ? head.slice(1) : head; // BOM: no puede tapar nada
  if (!t.startsWith('---')) return null;
  const close = t.indexOf('\n---', 3);
  return close >= 0 ? t.slice(3, close) : t.slice(3);
}

/**
 * ¿Este `.md` se lintea?
 * @param {string[]} [aviso] acumulador de lo que NO se linteó pero podría ser una story. Se
 *        IMPRIME al final de la corrida: un filtro que descarta en silencio deja stories sin mirar sin que
 *        nadie se entere.
 */
function looksLikeStory(abs, storyDirSet, aviso) {
  let head;
  try {
    // 8 KB alcanzan de sobra: la identidad va en las primeras líneas. No se lee el archivo entero
    // porque esto corre en cada pre-commit sobre todos los `.md` del commit.
    head = fs.readFileSync(abs, 'utf8').slice(0, 8192);
  } catch {
    return false;
  }
  const zone = frontmatterZone(head);

  if (zone !== null && DECLARES_STORY.test(zone) && !NOT_A_STORY_NAME.test(path.basename(abs)) && !isQaEvidence(abs, zone)) {
    return true;
  }

  // No se lintea — pero si vive entre stories, o tiene forma de story sin declarar identidad
  // (`epic:` sin `story:`: hay repos que usan `id:`), queda anotado. Esos archivos son INVISIBLES para todo el arnés hoy mismo, y el aviso es lo único
  // que los delata. No bloquean: a un archivo que nunca dijo ser una story no se le puede exigir
  // que lo sea, y bloquearlo apagaría el gate en varios repos el día de la adopción.
  if (aviso && (storyDirSet.has(path.dirname(abs)) || (zone !== null && STORY_SHAPED.test(zone)))) {
    aviso.push(abs);
  }
  return false;
}

/**
 * Resuelve el repo cuyas stories hay que lintear, por precedencia:
 *   1. env STORIES_DIR / SPECS_DIR
 *   2. raíz del repo git desde el cwd  ← el caso normal al correrlo a mano parado
 *      en el proyecto (el script vive en el arnés, no en el repo)
 *   3. `../specs/stories` relativo al script (fallback para clones que lo tengan
 *      copiado adentro del propio repo)
 * Mismo criterio que scripts/tools/lint-wiki.sh, para que los dos lints se comporten igual.
 */
function resolveDirs() {
  if (process.env.STORIES_DIR) {
    return { root: path.resolve(process.env.STORIES_DIR, '..', '..'), stories: process.env.STORIES_DIR };
  }
  if (process.env.SPECS_DIR) {
    return { root: path.resolve(process.env.SPECS_DIR, '..'), stories: path.join(process.env.SPECS_DIR, 'stories') };
  }
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // La raíz es la raíz git, exista o no `<gitRoot>/specs/stories`: si se exigiera esa carpeta, en un repo con otro
    // layout la raíz caería al fallback —el propio arnés— y el lint buscaría stories en el repo equivocado.
    // QUÉ carpetas mirar lo decide el descubrimiento estructural.
    if (gitRoot) return { root: gitRoot, stories: path.join(gitRoot, 'specs', 'stories') };
  } catch {
    /* no estamos en un repo git — seguimos al fallback */
  }
  const fallbackRoot = path.resolve(__dirname, '..', '..');   // el clon: este archivo vive en scripts/lib/
  return { root: fallbackRoot, stories: path.join(fallbackRoot, 'specs', 'stories') };
}

const { root: REPO_ROOT, stories: STORIES_DIR } = resolveDirs();

/** Mismo slice de frontmatter que `readStory()` de las tools del harness. */
function readFrontmatter(content) {
  const trimmed = content.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return { ok: false, reason: 'no-frontmatter' };
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return { ok: false, reason: 'sin-cierre' };
  return { ok: true, fm: trimmed.slice(3, end) };
}

/** Mismo scalar que usan tycon-backfill-followups / validator / status scripts. */
function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

function yamlChecker() {
  try {
    execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
  } catch {
    return null; // fail-open: sin PyYAML no bloqueamos a nadie
  }
  return (fmText) => {
    try {
      execFileSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(sys.stdin.read())'], {
        input: fmText,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return null;
    } catch (e) {
      const err = (e.stderr || '').toString().split('\n').filter(Boolean).slice(-2).join(' ');
      return err || 'YAML invalido';
    }
  };
}

// ── Número de story repetido en el repo ──────────────────────────────────────────────────────────
// El id de una story tiene que ser único dentro de su repo (story-format.md §1.0). Hay repos que numeran por tema y
// cada tema arranca en 1.1: con el mismo número, la evidencia de cierre de una story se mezcla con la de otra y la
// matriz cuenta como corrido un criterio con el registro ajeno. El arnés ya separa la evidencia
// (`<tema>__<número>`), pero el número repetido sigue confundiendo a quien busca «la story N.M». AVISA y no frena:
// con muchos números repetidos ya existentes, frenar de entrada traba a los equipos. `soloEstos`: con archivos por argumento (el pre-commit), se avisa
// sólo de los grupos que los incluyen; sin argumentos, de todos.
function avisarNumerosRepetidos(soloEstos) {
  if (!discovery || !REPO_ROOT) return;
  let d;
  try { d = discovery.discoverStories(REPO_ROOT, { budgetMs: 15000, cache: false }); } catch (e) {
    console.log(`ℹ️  no pude recorrer las stories del repo: el aviso de números repetidos NO se hizo en esta ejecución (${e.message}).`);
    return;
  }
  if (d.partial) {
    console.log('ℹ️  no pude recorrer todas las stories del repo: el aviso de números repetidos NO se hizo en esta ejecución.');
    return;
  }
  const porId = new Map();
  for (const s of d.stories) {
    const k = String(s.id);
    if (!porId.has(k)) porId.set(k, []);
    porId.get(k).push(path.resolve(s.path));
  }
  const filtro = soloEstos ? new Set(soloEstos.map((f) => path.resolve(f))) : null;
  const grupos = [...porId].filter(([, rutas]) => rutas.length > 1 && (!filtro || rutas.some((r) => filtro.has(r))));
  if (!grupos.length) return;
  console.log(`⚠️  ${grupos.length} número(s) de story repetido(s) en este repo — el id de una story tiene que ser único dentro de su repo (story-format.md §1.0):`);
  for (const [id, rutas] of grupos) {
    console.log(`   · ${id}: ${rutas.map((r) => path.relative(REPO_ROOT, r)).join(' · ')}`);
  }
  console.log('   No frena. La evidencia de cierre ya se separa por tema (`<tema>__<número>`); para una story nueva,');
  console.log('   usá un número que no exista en el repo (recomendado: el de la épica adelante, `2.3`).');
}

// ── Los archivos a modificar existen ───────────────────────────────────────────────────────────────────────────────
/**
 * Las rutas de `files_to_modify:` de una story existen en el código del producto.
 *
 * Un modelo que escribe una story puede inventar los archivos a modificar (una carpeta de funcionalidad o un modal que
 * nadie creó). El revisor de historias lo ve, pero sólo si el modelo lo corre; este control no depende de eso.
 *
 * Dónde se busca cada ruta: en el repo de la story, en la carpeta del producto (la que contiene al repo, para las rutas
 * que empiezan con el nombre del repo) y en cada repo hermano con su `.git` (el código suele vivir al lado del repo de
 * historias). Una ruta que no está en ninguno de esos lugares:
 *   - frena si su primera carpeta existe en alguno de ellos: el repo está clonado y el archivo no;
 *   - avisa si su primera carpeta no aparece en ninguno: el repo de código puede no estar clonado, y un control que no
 *     puede decidir no frena.
 * `files_to_create:` no se mira: esos archivos todavía no existen. Una story cerrada (done, review, cancelada) tampoco:
 * sus archivos pudieron moverse después. Lo que no es una ruta clara (notas entre paréntesis, comodines, `{a,b}`,
 * `<marcador>`, texto con espacios) se saltea.
 */
const CLOSED = /^(done|review|cancel|superseded|closed|obsolete|deprecated|abandon|postpon|deferred|eliminad|descartad)/i;

/** Los valores de la lista `<key>:` del frontmatter, en bloque o entre corchetes. */
function listOf(fm, key) {
  const out = [];
  let on = false;
  for (const line of fm.split(/\r?\n/)) {
    const head = line.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (head) {
      const inline = head[1].match(/^\[(.*)\]\s*(#.*)?$/);
      if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
      on = true;
      continue;
    }
    if (!on) continue;
    if (/^[A-Za-z_]/.test(line)) break;
    const m = line.match(/^\s*-\s*(.*)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** La ruta de un ítem, o null si no es una ruta clara. */
function pathOf(item) {
  let v = String(item).trim();
  const q = v.match(/^(["'])(.*?)\1/);
  if (q) v = q[2];
  else v = v.replace(/\s+#.*$/, '');
  v = v.trim();
  if (!v || /^[({<]/.test(v)) return null;
  const first = v.split(/\s+/)[0].replace(/[,;:]+$/, '');
  if (/[*?{}<>[\]]/.test(first) || first.startsWith('/') || first.startsWith('~') || first.split('/').includes('..')) return null;
  if (!first.includes('/') && !/\.[A-Za-z0-9]+$/.test(first)) return null;
  return first.replace(/^\.\//, '');
}

/** 'yes' si existe, 'no' si no existe, 'unknown' si no se pudo mirar (permisos, por ejemplo). */
function probe(p) {
  try { fs.statSync(p); return 'yes'; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no' : 'unknown'; }
}

/** Los lugares donde puede estar el código del producto de una story. */
function rootsOf(storyFile) {
  let repo = path.dirname(path.resolve(storyFile));
  while (!fs.existsSync(path.join(repo, '.git')) && path.dirname(repo) !== repo) repo = path.dirname(repo);
  if (!fs.existsSync(path.join(repo, '.git'))) repo = path.dirname(path.resolve(storyFile));
  const parent = path.dirname(repo);
  const roots = [repo, parent];
  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      const d = path.join(parent, e.name);
      if (e.isDirectory() && d !== repo && !e.name.startsWith('.') && fs.existsSync(path.join(d, '.git'))) roots.push(d);
    }
  } catch (_) {
    // sin poder mirar la carpeta del producto no se sabe qué repos hay al lado: nada se da por inventado
    roots.unreadable = true;
  }
  return roots;
}

/** `{ missing, unsure }` de una story: las rutas que no existen y las que no se pueden juzgar. */
function checkStory(storyFile, content) {
  const text = (content === undefined ? fs.readFileSync(storyFile, 'utf8') : content).replace(/^﻿/, '');
  if (!text.startsWith('---')) return { missing: [], unsure: [] };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { missing: [], unsure: [] };
  const fm = text.slice(3, end);
  const status = (fm.match(/^status:\s*["']?([^"'\s#]+)/m) || [])[1] || '';
  if (CLOSED.test(status)) return { missing: [], unsure: [] };
  const paths = [...new Set(listOf(fm, 'files_to_modify').map(pathOf).filter(Boolean))];
  if (!paths.length) return { missing: [], unsure: [] };
  const roots = rootsOf(storyFile);
  const missing = [];
  const unsure = [];
  for (const p of paths) {
    const where = roots.map((r) => probe(path.join(r, p)));
    if (where.includes('yes')) continue;
    // una ruta que no se pudo mirar en algún lugar no se da por inventada
    if (where.includes('unknown') || roots.unreadable) { unsure.push(p); continue; }
    const top = p.split('/')[0];
    (p.includes('/') && roots.some((r) => probe(path.join(r, top)) === 'yes') ? missing : unsure).push(p);
  }
  return { missing, unsure };
}

function main() {
  const args = process.argv.slice(2);
  if (!discovery) {
    console.error(`⚠️  no encontré el descubridor de stories del arnés (${DISCOVERY_PATH}).`);
    console.error('    Se lintea sólo el layout clásico `<repo>/specs/stories/`; en un repo con otro');
    console.error('    layout esto NO va a mirar nada. Instalá el skill tycon-pipeline o exportá TYCON_SKILLS_DIR.');
  }
  // Con STORIES_DIR/SPECS_DIR explícitos manda lo que declaró el usuario; si no, se descubre.
  const explicitDir = !!(process.env.STORIES_DIR || process.env.SPECS_DIR);
  const dirs = explicitDir ? [STORIES_DIR] : storyDirsOf(REPO_ROOT);
  if (!explicitDir && fs.existsSync(STORIES_DIR) && !dirs.includes(STORIES_DIR)) dirs.push(STORIES_DIR);
  const dirSet = new Set(dirs);

  // Lo que NO se linteó pero podría ser una story. Se imprime al final, sin bloquear: un filtro
  // que descarta en silencio deja stories sin mirar sin que nadie se entere.
  const aviso = [];

  let files;
  if (args.length > 0) {
    // El hook del repo puede pasarle TODOS los `.md` del commit: el filtro lo hace el lint, que es
    // el que sabe qué es una story. Con un grep del hook (`^specs/stories/`) como filtro, un repo con otro
    // layout no lintearía nada.
    files = args
      .map((f) => path.resolve(f))
      .filter((f) => f.endsWith('.md') && fs.existsSync(f) && looksLikeStory(f, dirSet, aviso));
  } else {
    if (dirs.length === 0) {
      console.error('No encontré ninguna story en este repo (busqué .md con `story:` y `status:` en el');
      console.error(`frontmatter, desde ${REPO_ROOT}).`);
      console.error('Si las stories están en otro lado, indicá la ruta con STORIES_DIR=... / SPECS_DIR=...,');
      console.error('o pasale los archivos como argumentos. Diagnóstico del descubridor:');
      console.error(`  node ${DISCOVERY_PATH} --doctor --repo ${REPO_ROOT}`);
      return 1;
    }
    files = [];
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        // MISMO filtro que la rama con argumentos. Si esta rama tomara la carpeta ENTERA, el modo standalone
        // rompería con los documentos de planning aunque el pre-commit estuviera bien: dos caminos con dos
        // criterios es cómo se arregla uno y el otro sigue roto. Los archivos que el descubridor no pudo leer siguen entrando — los caza
        // `frontmatterZone`, que se agranda justo cuando el frontmatter está roto.
        if (!f.endsWith('.md') || f === 'INDEX.md') continue;
        const cand = path.join(dir, f);
        if (looksLikeStory(cand, dirSet, aviso)) files.push(cand);
      }
    }
  }

  const checkYaml = yamlChecker();
  const errors = [];
  let checked = 0;
  let skippedNoFm = 0;
  // Causa del reproceso: el vocabulario se lee UNA vez. Sin él la regla no corre, y eso se DICE:
  // callarlo sería exactamente el «verde que significa no miré nada» que este repo persigue.
  const vocab = leerCausas(CAUSAS_PATH);
  // 🔴 Se pregunta por `motivo`, NO por `!vocab.causas`: cuando el vocabulario no vale, `leerCausas`
  //    devuelve `causas: []` — y `[]` es TRUTHY en JS, así que el aviso no salía y la regla corría
  //    con un vocabulario VACÍO, rechazando causas perfectamente válidas.
  if (vocab.motivo) {
    console.error(`⚠️  ${vocab.motivo} (${CAUSAS_PATH}).`);
    console.error('    La regla de `followup_reason:` NO se aplica en esta ejecución — es un hueco declarado, no un OK.');
  }
  let sinCausaExistentes = 0;
  const rutasViejas = [];
  const rutasSinJuzgar = [];

  for (const abs of files) {
    if (!fs.existsSync(abs)) continue; // borrado en el commit
    const relRaw = path.relative(REPO_ROOT, abs);
    // Si el archivo vive fuera del repo (uso ad-hoc), mostrar el path absoluto
    // en vez de una ristra de `../..` ilegible.
    const rel = relRaw.startsWith('..') ? abs : relRaw;
    const content = fs.readFileSync(abs, 'utf8');
    const parsed = readFrontmatter(content);

    if (!parsed.ok) {
      if (parsed.reason === 'no-frontmatter') {
        // Legado: hay stories viejas sin frontmatter (ej. 5.2 ELIMINADA). No es el bug
        // que este lint persigue — se cuenta y se informa, no bloquea.
        skippedNoFm++;
        continue;
      }
      errors.push({
        rel,
        problema: 'el frontmatter NO cierra (falta el `---` final)',
        efecto: 'toda herramienta del harness saltea esta story EN SILENCIO',
        arreglo: 'agregar una linea `---` justo antes del cuerpo (antes del `# Story N.M:`)',
      });
      continue;
    }

    checked++;
    const faltantes = REQUIRED.filter((k) => scalar(parsed.fm, k) === null);
    if (faltantes.length > 0) {
      const detalle = faltantes
        .map((k) => {
          const linea = (parsed.fm.match(new RegExp(`^${k}:.*$`, 'm')) || ['(campo AUSENTE)'])[0];
          const causa = linea.includes('"') ? ' ← comillas dobles en el comentario inline' : '';
          return `      ${linea.slice(0, 110)}${causa}`;
        })
        .join('\n');
      errors.push({
        rel,
        problema: `campos ilegibles para el harness: ${faltantes.join(', ')}\n${detalle}`,
        efecto: 'el colector exige story+epic+status; si uno da null, saltea la story',
        arreglo: 'usar comillas simples dentro de los comentarios `#`, o mover el comentario a otra linea',
      });
      continue;
    }

    // 4. La causa del reproceso. El por qué de cada rama, en la cabecera del archivo.
    if (!vocab.motivo) {
      const lista = vocab.causas.join(' · ');
      const causa = scalar(parsed.fm, 'followup_reason');
      if (causa !== null && !vocab.causas.includes(causa)) {
        // Fuera del vocabulario: frena SIEMPRE, nueva o vieja. Sin normalizar: si `Defecto-Propio` pasa "por comodidad",
        // el vocabulario deja de ser cerrado y la ficha del tablero deja de poder sumarlo.
        errors.push({
          rel,
          problema: `\`followup_reason: ${causa}\` no está en el vocabulario cerrado de causas del reproceso`,
          efecto: 'el medidor lo publica como «fuera de vocabulario» y la barra de su causa real nunca lo cuenta',
          arreglo: `usar EXACTAMENTE una de: ${lista} (sin mayúsculas ni variantes) — scripts/metrics/rework-causes.json`,
        });
        continue;
      }
      if (causa === null && tieneFollowupOf(parsed.fm)) {
        if (naceAhora(abs, scalar(parsed.fm, 'story'))) {
          errors.push({
            rel,
            problema: 'la story NACE declarando `followup_of:` (es un seguimiento) y sin `followup_reason:` (la causa)',
            efecto: 'el tablero no puede decir por qué volvió: la ficha «Por qué volvió» la cuenta como «sin declarar»',
            arreglo: `agregar al frontmatter \`followup_reason: <causa>\` con una de: ${lista}`,
          });
          continue;
        }
        // Ya existía: se AVISA y no se frena. Medido al crear la regla: 285 stories en 9 repos.
        sinCausaExistentes++;
      }
    }

    // 5. Los archivos a modificar existen. El por qué y dónde se buscan, en la cabecera de checkStory.
    const rutas = checkStory(abs, content);
    if (rutas.missing.length) {
      if (naceAhora(abs, scalar(parsed.fm, 'story'))) {
        errors.push({
          rel,
          problema: `\`files_to_modify:\` nombra archivos que no existen en el código del producto: ${rutas.missing.join(', ')}`,
          efecto: 'quien implemente la story busca archivos inventados, o los crea donde no van',
          arreglo: 'corregir la ruta contra el repo de código, o pasarla a `files_to_create:` si el archivo es nuevo',
        });
        continue;
      }
      // Ya existía: sus archivos pudieron moverse después. Se avisa y no se frena.
      rutasViejas.push(`${rel}: ${rutas.missing.join(', ')}`);
    }
    if (rutas.unsure.length) rutasSinJuzgar.push(`${rel}: ${rutas.unsure.join(', ')}`);

    if (checkYaml) {
      const yamlErr = checkYaml(parsed.fm);
      if (yamlErr) {
        errors.push({
          rel,
          problema: `el frontmatter no parsea como YAML: ${yamlErr}`,
          efecto: 'cualquier consumidor que use un parser YAML real falla o lo ignora',
          arreglo: 'revisar indentacion, comillas sin cerrar o listas mal formadas',
        });
      }
    }
  }

  console.log(`Lint frontmatter de stories — ${checked} revisadas` +
    (skippedNoFm ? ` (${skippedNoFm} sin frontmatter, legado — no se chequean)` : '') +
    (checkYaml ? '' : ' · aviso: sin PyYAML, se saltea el parse YAML'));

  if (sinCausaExistentes > 0) {
    // Aviso, NO freno: son stories que ya existían cuando nació la regla. Al tocarlas, se declara.
    console.log(`⚠️  ${sinCausaExistentes} story(s) con seguimiento (\`followup_of:\`) sin causa declarada ` +
      '(`followup_reason:`) — ya existían, no frenan. Al tocarlas, declarar una de: ' +
      `${(vocab.causas || []).join(' · ')} (scripts/metrics/rework-causes.json).`);
  }

  if (rutasViejas.length) {
    console.log(`⚠️  ${rutasViejas.length} story(s) que ya existían nombran en \`files_to_modify:\` archivos que no están ` +
      '(no frenan: pudieron moverse después):');
    for (const r of rutasViejas) console.log(`   ${r}`);
  }
  if (rutasSinJuzgar.length) {
    console.log(`⚠️  ${rutasSinJuzgar.length} story(s) con archivos que no encuentro en ningún repo al lado ` +
      '(¿el repo de código está clonado?; no frenan):');
    for (const r of rutasSinJuzgar) console.log(`   ${r}`);
  }

  if (aviso.length) {
    console.log(`ℹ️  ${aviso.length} .md NO linteados (no declaran \`story:\`): ` +
      aviso.map((f) => path.basename(f)).join(', '));
    console.log('   Si alguno ES una story: o su frontmatter está roto de un modo nuevo, o el repo');
    console.log('   usa otra clave de identidad (`id:`) y esas stories ya son invisibles para el arnés.');
  }

  avisarNumerosRepetidos(args.length > 0 ? files : null);

  if (errors.length === 0) {
    console.log('─────────────────────────────');
    console.log('✅ OK — todas las stories son legibles por el harness');
    return 0;
  }

  console.log('');
  for (const e of errors) {
    console.log(`❌ ${e.rel}`);
    console.log(`   Problema: ${e.problema}`);
    console.log(`   Efecto:   ${e.efecto}`);
    console.log(`   Arreglo:  ${e.arreglo}`);
    console.log('');
  }
  console.log('─────────────────────────────');
  console.log(`❌ ${errors.length} story(s) ilegible(s) para el harness.`);
  console.log('   Una story con el frontmatter roto NO es un detalle cosmetico: desaparece');
  console.log('   del validator, del backfill de back-links, de los scripts de status y del');
  console.log('   hook de DoD, sin que nadie avise. Caso 2026-07-24: 4 stories invisibles');
  console.log('   durante 2 meses, una de ellas tapando una deuda de evidencia DoD.');
  return 1;
}

// Exportado para que OTROS controles usen EL MISMO criterio de "esto es una story" en vez de
// escribir el suyo (dos detectores del mismo concepto terminan divergiendo: uno aparte podría tomar por story rota
// un reporte de medición que declara `story:` en el cuerpo, sin frontmatter).
module.exports = { frontmatterZone, looksLikeStory, DECLARES_STORY, NOT_A_STORY_NAME, STORY_SHAPED };

// 🔴 `process.exitCode`, NO `process.exit()`: en Node las escrituras a una tubería son
// ASINCRÓNICAS y `process.exit()` mata el proceso con parte de lo escrito en el aire. Medido con
// la forma de este guión (una escritura grande y salir): a 41 KB llega cortado en 8192 y el JSON
// se rompe; el consumidor lo lee como «no pude», nunca como un error.
if (require.main === module) process.exitCode = main();
