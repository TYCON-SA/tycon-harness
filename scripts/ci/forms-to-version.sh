#!/usr/bin/env bash
# =============================================================================
# forms-to-version.sh — ¿a qué formularios hay que subirles la versión en esta corrida?
# =============================================================================
# 🔴 POR QUÉ EXISTE.
#
# Decidir a quién subirle la versión con `git diff HEAD~1 HEAD`, mirando sólo la carpeta TOCADA,
# tiene dos agujeros, los dos en verde:
#
#   · Con `batch: true` una corrida junta varios merges; HEAD~1 es el merge anterior, así que el
#     formulario que cambió el PRIMER merge del lote no sube de versión → el host lo deduplica →
#     el cambio nunca llega a staging ni a producción. La base correcta es el ÚLTIMO COMMIT DE
#     VERSIONES (todo lo posterior es lo que todavía no se versionó).
#   · Se construye lo AFECTADO (lo cambiado más lo que depende de ello, por los imports reales);
#     si se versionara sólo lo tocado, un dependiente reconstruido saldría con código nuevo y
#     VERSIÓN VIEJA → el despliegue lo saltea como "al día".
#
# La lógica va acá, en UN guion del arnés que los cinco llaman (llega por `arnes-ci`), y no
# copiada en cinco YAML: un patrón copiado (como `release-notes.sh`) acaba en copias que divergen.
# Y así la corrida "dos merges agrupados" —que en Azure DevOps no se puede provocar a voluntad—
# se prueba en local con una historia git sintética.
#
# Uso:  forms-to-version.sh [--repo <dir>] [--base]
#   sin --base   imprime en stdout los formularios a versionar, uno por línea (vacío = ninguno).
#   --base       imprime sólo el commit base (el último de versiones, o HEAD~1 si no hay); el
#                pipeline lo usa para leer la versión ANTERIOR desde ahí y no desde HEAD~1 — si
#                no, un bump manual hecho en el primer merge del lote se pisa.
#   Explica lo que decide por stderr.
#
# El conjunto = `affected-forms.js --changed <diff BASE..HEAD>`, el mismo criterio que
# usan las pruebas y la construcción. 🔴 Comportamiento que hay que SABER:
# cualquier archivo de la raíz que no sea el pipeline ni `.md` versiona a TODOS;
# cualquier archivo DENTRO de un formulario lo versiona (no sólo `src/`); un formulario borrado o
# renombrado no versiona a nadie; y un MERGE no aporta ningún archivo — el porqué, en el bucle.
#
# Exit: 0 con lista (posiblemente vacía = nada que versionar, legítimo) · 1 si NO PUDO DECIDIR:
#       falta el guion hermano, no hay ningún formulario, o el diff no se pudo calcular. Nunca
#       sale 0 sin poder decir: un "vacío" que en realidad es "no sé" deja un despliegue sin
#       versión y todo en verde.
# =============================================================================
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="."; MODO="lista"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo necesita un directorio}"; shift ;;
    --base) MODO="base" ;;
    *) echo "[versionar] argumento desconocido: $1" >&2; exit 1 ;;
  esac
  shift
done
cd "$REPO" 2>/dev/null || { echo "[versionar] no existe $REPO" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[versionar] $REPO no es un repo git" >&2; exit 1; }

# La base: el último commit de versiones que escribió el bot. Los dos mensajes reales que se usan
# ("chore: update form versions" y "chore: update versions and add deployment ZIPs"). Si no hay
# ninguno (repo nuevo, historia recortada), HEAD~1. Historia de un solo commit: vacío.
# 🔴 LA BASE ES EL COMMIT DEL QUE PARTIÓ LA CORRIDA ANTERIOR, NO EL COMMIT DEL BOT.
#
# El bot escribe su commit de versiones y lo pushea. Si mientras tanto entró otro merge a main, el
# push rebota y el paso hace `fetch` + `rebase`: el commit de versiones queda ENCIMA de ese merge.
# Si la corrida siguiente tomara como base ese commit rebasado, el merge que quedó debajo caería
# fuera del diff — su formulario NUNCA subiría de versión, el host lo deduplicaría por versión igual
# ("al día, no se sube"), el humo daría verde porque la versión coincide, y el cambio no llegaría ni
# a staging ni a producción. TODO VERDE.
#
# La salida está escrita en el propio commit: el bot anota `Commit: <sha>` con
# `Build.SourceVersion`, o sea el commit exacto del que partió esa corrida. Ese hash NO lo mueve el
# rebase. Entonces la base es ese hash: dice "hasta acá ya versioné", que es la pregunta real.
#
# Los cinco pipelines de formularios lo anotan y los cinco clonan la historia completa
# (`fetchDepth: 0`), así que el hash siempre está. Si igual no se puede usar —un bump sin la
# anotación, o un hash que no es ancestro porque alguien reescribió la historia— se cae a HEAD~1
# AVISANDO, porque esa caída puede perder un formulario y eso no puede pasar en silencio: es
# exactamente el defecto que este bloque evita.
# 🔴 SON DOS PREGUNTAS DISTINTAS Y NECESITAN DOS BASES.
#
# Usar UNA sola base —el commit del que partió la corrida anterior— para las dos rompería el caso
# normal. Las preguntas son:
#
#   (a) ¿QUÉ cambió desde la corrida anterior?  → desde el commit del que ESA corrida partió,
#       salteando los commits del bot. Así, si el bot rebasó su commit encima de un merge que entró
#       mientras corría, ese merge sigue adentro del rango y su formulario no se pierde.
#
#   (b) ¿QUÉ VERSIÓN está publicada?  → la que el BOT dejó escrita en su último commit de versiones.
#       Ésa es la que está en el host. Leerla desde (a) daría la versión ANTERIOR al bump, así que
#       el número nuevo repetiría el que la corrida anterior ya publicó: el host lo deduplicaría
#       ("al día, no se sube"), el humo lo aprobaría porque la versión coincide, y el cambio no
#       llegaría NUNCA.
#
# `--base` contesta (b), que es lo único que el pipeline le pide. El rango de (a) es interno.
base_versiones() {   # (b) el último commit de versiones del bot: ahí está lo publicado
  local b
  b=$(git log -1 --pretty=%H --grep='^chore: update form versions' --grep='^chore: update versions' 2>/dev/null || true)
  if [ -n "$b" ] && git cat-file -e "${b}^{commit}" 2>/dev/null; then
    echo "[versionar] versión publicada: se lee del último commit de versiones ($(git rev-parse --short "$b"))" >&2
    printf '%s\n' "$b"; return 0
  fi
  if git cat-file -e 'HEAD~1^{commit}' 2>/dev/null; then
    echo "[versionar] versión publicada: HEAD~1 (no hay un commit de versiones previo)" >&2
    git rev-parse HEAD~1; return 0
  fi
  echo "[versionar] versión publicada: ninguna base (historia de un solo commit)" >&2
  printf '\n'
}

base_cambios() {     # (a) desde dónde mirar qué cambió
  # 🔴 La DECISIÓN vive en run-base.sh, compartida con label-prs.sh; acá quedan sólo los
  # mensajes, que hablan de formularios. La salida (stdout y stderr) no depende de que la decisión
  # sea compartida: lo verifica esta suite.
  base_de_corrida HEAD '^chore: update form versions' '^chore: update versions'
  case "$BASE_MODO" in
    marca)
      echo "[versionar] qué cambió: desde el commit del que partió la corrida anterior ($(git rev-parse --short "$BASE_SHA")), anotado en $(git rev-parse --short "$BASE_BOT")" >&2 ;;
    marca-invalida)
      echo "[versionar] AVISO: el commit de versiones $(git rev-parse --short "$BASE_BOT") anota Commit: $BASE_MARCA, pero ese commit no está o no es ancestro de HEAD — se mira desde el commit de versiones y PUEDE perderse un formulario si hubo un rebase" >&2 ;;
    bot-sin-marca)
      echo "[versionar] AVISO: el commit de versiones $(git rev-parse --short "$BASE_BOT") no anota de qué commit partió — se mira desde el commit de versiones y PUEDE perderse un formulario si hubo un rebase" >&2 ;;
    punta-menos-uno)
      echo "[versionar] qué cambió: desde HEAD~1 (no hay un commit de versiones previo)" >&2 ;;
    *)
      echo "[versionar] qué cambió: sin base (historia de un solo commit) — se toma el árbol entero" >&2 ;;
  esac
  printf '%s\n' "$BASE_SHA"
}

if [ "$MODO" = "base" ]; then printf '%s\n' "$(base_versiones)"; exit 0; fi

AFECTADOS_JS="$AQUI/affected-forms.js"
if [ ! -f "$AFECTADOS_JS" ]; then
  echo "[versionar] no está affected-forms.js al lado mío ($AQUI) — no puedo decidir" >&2
  exit 1
fi
# La base compartida se carga recién acá: `--base` (arriba) no la necesita y no cambia. Va después de
# chequear affected-forms.js para que, si faltan los dos, el primer motivo siga siendo el de siempre.
if [ ! -f "$AQUI/run-base.sh" ]; then
  echo "[versionar] no está run-base.sh al lado mío ($AQUI) — no puedo decidir" >&2
  exit 1
fi
# shellcheck source=run-base.sh
. "$AQUI/run-base.sh"
BASE=$(base_cambios) || exit 1

CAMBIOS=$(mktemp); trap 'rm -f "$CAMBIOS"' EXIT
if [ -n "$BASE" ]; then
  # 🔴 EL RANGO SALTEA LOS COMMITS DEL BOT. La base es el commit del que partió la corrida
  # anterior, así que el commit de versiones de ESA corrida cae DENTRO del rango. Un diff plano lo
  # incluiría y cada corrida volvería a versionar los formularios que versionó la anterior, para
  # siempre. Entonces el rango se recorre commit por commit y se saltean los del bot: queda
  # exactamente lo que cambió una persona desde donde la corrida anterior arrancó.
  #
  # 🔴 Y LOS MERGES TAMBIÉN SE SALTEAN (2026-09-21) — por eso un commit con segundo padre (`^2`) no aporta
  # archivos. `git log BASE..HEAD` ya lista todos los commits de todas las ramas del rango y acá
  # se recorren uno por uno, así que lo que un merge trajo ya está contado por sus propios
  # commits. Lo único que agrega diffear un merge contra su primer padre es lo que el segundo padre
  # tenía y el primero no, o sea lo que BASE ya tenía: el commit de versiones del bot, que vive sólo
  # en `main` y vuelve a entrar a `dev` con cada merge —una rama cortada de `main`, o «bajar main a
  # dev»— y re-muestra los `package.json` que la corrida anterior ya versionó. Sin esto, cada
  # corrida de main versionaría y redesplegaría todos los formularios aunque sólo cambien uno o dos.
  # Límite declarado: si una resolución de conflicto tocara un formulario que NINGÚN commit del rango
  # tocó, ese formulario no se versionaría. No se conoce un caso real; si aparece, la señal es código
  # nuevo con versión vieja en el humo de despliegue, y el arreglo sería diffear contra el resultado
  # del merge automático (`git merge-tree`), no contra el primer padre.
  : > "$CAMBIOS"
  RANGO=$(git log --format='%H%x09%s' "$BASE..HEAD" 2>/dev/null) \
    || { echo "[versionar] no pude recorrer ${BASE:0:7}..HEAD" >&2; exit 1; }
  while IFS=$'\t' read -r C ASUNTO; do
    [ -n "$C" ] || continue
    case "$ASUNTO" in
      'chore: update form versions'*|'chore: update versions'*|'chore: bump version'*) continue ;;
    esac
    git rev-parse -q --verify "${C}^" >/dev/null 2>&1 || continue
    git rev-parse -q --verify "${C}^2" >/dev/null 2>&1 && continue
    git diff --name-only "${C}^" "$C" >> "$CAMBIOS" 2>/dev/null || true
  done <<< "$RANGO"
  sort -u -o "$CAMBIOS" "$CAMBIOS"
else
  git ls-tree --name-only -r HEAD > "$CAMBIOS" 2>/dev/null || { echo "[versionar] no pude listar el árbol" >&2; exit 1; }
fi
echo "[versionar] $(wc -l < "$CAMBIOS" | tr -d ' ') archivo(s) cambiado(s) desde la base" >&2

# 🔴 --no-debt (tiene un nombre viejo en castellano que sigue andando): el guion de afectados suma los formularios cuya
# DECLARACIÓN DE DEUDA de pruebas cambió, para que el pull request los juzgue. Eso es para
# PROBAR. Acá la pregunta es otra —a quién le subo la versión y redespliego— y la respuesta no
# cambia: tocar la declaración no cambia una línea del código construido, y versionar por eso
# redesplegaría formularios idénticos (es justo lo que la lista NO_AFECTAN vino a evitar).
LISTA=$(node "$AFECTADOS_JS" --repo . --changed "$CAMBIOS" --no-debt); RC=$?
if [ "$RC" -ne 0 ]; then
  echo "[versionar] el guion de afectados no pudo decidir (exit $RC) — se versionan TODOS, el lado seguro" >&2
  LISTA=$(node "$AFECTADOS_JS" --repo . --all 2>/dev/null) || LISTA=""
  if [ -z "$(printf '%s' "$LISTA" | tr -d '[:space:]')" ]; then
    echo "[versionar] ni siquiera pude listar los formularios del repo — no puedo decidir" >&2
    exit 1
  fi
fi
LISTA=$(printf '%s\n' "$LISTA" | sed '/^[[:space:]]*$/d')
if [ -z "$LISTA" ]; then echo "[versionar] nada que versionar" >&2; exit 0; fi
echo "[versionar] a versionar: $(printf '%s' "$LISTA" | tr '\n' ' ')" >&2
printf '%s\n' "$LISTA"
