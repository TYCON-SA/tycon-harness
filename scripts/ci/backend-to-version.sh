#!/usr/bin/env bash
# =============================================================================
# backend-to-version.sh — ¿esta corrida del backend trae algo nuevo desde la última versión?
# =============================================================================
# 🔴 POR QUÉ EXISTE. El pipeline de backend subía la versión, empaquetaba, desplegaba a
# staging, commiteaba el bump y abría la corrida de producción en CADA corrida sobre main, hubiera o
# no código nuevo. Una corrida lanzada a mano para probar el arnés, sin ningún cambio desde el merge
# anterior, generó una versión con el mismo código que la anterior, la desplegó a staging, dejó el
# commit del bump en main y abrió una corrida de producción que hubo que cancelar. Los formularios
# tuvieron el mismo problema y lo resolvieron con forms-to-version.sh; esto es lo mismo para un
# backend, que es un formulario único: el plugin.
#
# La pregunta y la base son las de los formularios: lo nuevo es lo que cambió desde el commit del que
# partió la corrida que hizo el último bump (la marca `Commit: <sha>` del commit del bot), salteando
# los commits del bot y los merges. La base la decide run-base.sh, compartida con forms-to-version.sh
# y label-prs.sh. Con `batch: true` eso cubre el primer merge del lote, que `HEAD~1` perdía.
#
# Qué cuenta como «algo nuevo»: lo mismo que despierta al pipeline en main —las rutas del `trigger` del
# azure-pipelines.yml del commit, con sus `exclude`—; si no declara rutas, las del canónico (src/, database/,
# plugin.json, plugin.json.example, scripts/, package.json, azure-pipelines.yml, tests/). La documentación y .tycon/
# no cuentan, igual que no lo disparan.
#
# 🔴 ANTE LA DUDA, VERSIONA. Si el último bump no anota de qué commit partió, si el commit anotado no
# está, o si no hay ningún bump en la historia, no se adivina «no hay nada»: se versiona (es lo de
# siempre) y se avisa por qué. Un «no hay nada» equivocado deja código nuevo sin desplegar, en verde.
#
# Uso:  backend-to-version.sh [--repo <dir>] [--force <true|false>]
#   --force   la casilla del pipeline («Versionar y desplegar aunque no haya código nuevo»), tal como la
#             escribe Azure (True/False); tildada, versiona sin mirar.
#   Imprime en stdout, una por línea:
#     versionar=true|false
#     ultima=<la versión del último bump, o vacío si no hay>
#     motivo=casilla|cambios|sin-cambios|sin-marca|marca-invalida|primera
#   Explica lo que decide por stderr.
#
# Exit: 0 con veredicto · 1 si NO PUDO MIRAR (no es un repo, falta run-base.sh, el rango no se pudo
#       recorrer, la casilla trae otra cosa). Nunca sale 0 sin poder decir: el pipeline trata el 1 como
#       error, no como «nada nuevo».
# =============================================================================
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="."; FORZAR="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo necesita un directorio}"; shift ;;
    --force) FORZAR="${2:?--force necesita true o false}"; shift ;;
    *) echo "[versionar-backend] argumento desconocido: $1" >&2; exit 1 ;;
  esac
  shift
done
case "$(printf '%s' "$FORZAR" | tr '[:upper:]' '[:lower:]')" in
  true) FORZAR="true" ;;
  false|'') FORZAR="false" ;;
  *) echo "[versionar-backend] --force espera true o false, no «${FORZAR}»" >&2; exit 1 ;;
esac
cd "$REPO" 2>/dev/null || { echo "[versionar-backend] no existe $REPO" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[versionar-backend] $REPO no es un repo git" >&2; exit 1; }
if [ ! -f "$AQUI/run-base.sh" ]; then
  echo "[versionar-backend] no está run-base.sh al lado mío ($AQUI) — no puedo decidir" >&2
  exit 1
fi
# shellcheck source=run-base.sh
. "$AQUI/run-base.sh"

BOT='^chore: bump version'
base_de_corrida HEAD "$BOT"
ULTIMA=""
if [ -n "$BASE_BOT" ]; then
  ULTIMA=$(git show "$BASE_BOT:plugin.json" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
veredicto(){ printf 'versionar=%s\nultima=%s\nmotivo=%s\n' "$1" "$ULTIMA" "$2"; exit 0; }

if [ "$FORZAR" = "true" ]; then
  echo "[versionar-backend] la casilla «versionar y desplegar» está tildada: se versiona sin mirar" >&2
  veredicto true casilla
fi
case "$BASE_MODO" in
  marca) ;;
  bot-sin-marca)
    echo "[versionar-backend] AVISO: el último bump ($(git rev-parse --short "$BASE_BOT")) no anota de qué commit partió — no puedo saber qué es nuevo, así que se versiona" >&2
    veredicto true sin-marca ;;
  marca-invalida)
    echo "[versionar-backend] AVISO: el último bump ($(git rev-parse --short "$BASE_BOT")) anota Commit: $BASE_MARCA, pero ese commit no está o no es ancestro de HEAD — se versiona" >&2
    veredicto true marca-invalida ;;
  *)
    echo "[versionar-backend] no hay un bump previo en la historia: es la primera versión" >&2
    veredicto true primera ;;
esac

# El rango se recorre commit por commit, salteando los del bot y los merges: lo que un merge trajo ya
# está contado por sus propios commits (el mismo criterio de forms-to-version.sh, con su porqué).
CAMBIOS=$(mktemp); trap 'rm -f "$CAMBIOS"' EXIT
RANGO=$(git log --format='%H%x09%s' "$BASE_SHA..HEAD" 2>/dev/null) \
  || { echo "[versionar-backend] no pude recorrer ${BASE_SHA:0:7}..HEAD" >&2; exit 1; }
while IFS=$'\t' read -r C ASUNTO; do
  [ -n "$C" ] || continue
  case "$ASUNTO" in 'chore: bump version'*) continue ;; esac
  git rev-parse -q --verify "${C}^" >/dev/null 2>&1 || continue
  git rev-parse -q --verify "${C}^2" >/dev/null 2>&1 && continue
  # --no-renames: un `git mv src/A.cs docs/A.cs` tiene que mostrar las dos rutas; con la detección de renombres sale sólo
  # la nueva, y el código que salió del paquete no contaría. quotepath=off: con el valor de fábrica, un nombre con acentos
  # sale entre comillas y con escapes octales, y no calza con ningún patrón.
  git -c core.quotepath=off diff --no-renames --name-only "${C}^" "$C" >> "$CAMBIOS" 2>/dev/null \
    || { echo "[versionar-backend] no pude leer los cambios de ${C:0:7}" >&2; exit 1; }
done <<< "$RANGO"

# Las rutas que cuentan son las del `trigger` del azure-pipelines.yml de ESTE commit: cada producto tiene su lista (uno
# dispara también con su gateway, otros con coverlet.runsettings), y con una lista fija un merge que sólo toca una de
# esas rutas no se versionaría ni se desplegaría. Sólo si el pipeline no declara rutas se usa la del canónico.
# Sale una línea por ruta: «I <patrón>» (include) o «E <patrón>» (exclude).
disparadores(){
  git show HEAD:azure-pipelines.yml 2>/dev/null | tr -d '\r' | awk '
    /^trigger:/ { t = 1; next }
    t && /^[^ #]/ { exit }
    t && /^ +[A-Za-z_]+:/ {
      n = match($0, /[^ ]/) - 1; k = $0; sub(/^ +/, "", k); sub(/:.*/, "", k)
      if (k == "paths") { p = 1; pi = n; lista = ""; next }
      if (p && n <= pi) { p = 0; lista = ""; next }
      if (p && (k == "include" || k == "exclude")) {
        lista = (k == "include") ? "I" : "E"
        # la lista en una línea (`include: [src/**, plugin.json]`) también vale
        r = $0; sub(/^[^:]*:[ \t]*/, "", r); sub(/[ \t]+#.*$/, "", r)
        if (r ~ /^\[/) {
          gsub(/[][\047"]/, "", r); m = split(r, xs, ",")
          for (q = 1; q <= m; q++) { s = xs[q]; gsub(/^[ \t]+|[ \t]+$/, "", s); if (s != "") print lista " " s }
          lista = ""
        }
        next
      }
      next
    }
    t && p && lista != "" && /^ *- / {
      s = $0; sub(/^ *- */, "", s); sub(/[ \t]+#.*$/, "", s); gsub(/["\047]/, "", s); sub(/[ \t]+$/, "", s)
      if (s != "") print lista " " s
    }'
}
INCLUIR=(); EXCLUIR=()
while IFS= read -r l; do
  case "$l" in "I "*) INCLUIR+=("${l#I }") ;; "E "*) EXCLUIR+=("${l#E }") ;; esac
done < <(disparadores)
if [ ${#INCLUIR[@]} -eq 0 ] && [ ${#EXCLUIR[@]} -gt 0 ]; then
  # sólo exclusiones: para Azure, dispara todo lo que no está excluido
  INCLUIR=('**')
elif [ ${#INCLUIR[@]} -eq 0 ]; then
  echo "[versionar-backend] el pipeline no declara rutas en su trigger: cuento las del canónico" >&2
  INCLUIR=('src/**' 'database/**' 'plugin.json' 'plugin.json.example' 'scripts/**' 'package.json' 'azure-pipelines.yml' 'tests/**')
fi
calza(){ # <archivo> <patrón> — el glob de Azure: `**` es cualquier cosa (también `/`), y `**/` puede ser ninguna carpeta
  local corto="${2//\*\*\//}"
  # Sin comodín, Azure lo toma como prefijo: `tools/gateway` dispara con `tools/gateway/x.js` (no con `tools/gatewayx`).
  case "$2" in *'*'*|*'?'*|*'['*) ;; *) [[ "$1" == "$2" || "$1" == "${2%/}/"* ]] && return 0 ;; esac
  # shellcheck disable=SC2053 # el patrón va sin comillas a propósito: es un glob
  [[ "$1" == $2 ]] || [[ "$1" == $corto ]]
}
cuenta(){ # <archivo> → 0 si despierta al pipeline
  local p
  for p in ${EXCLUIR[@]+"${EXCLUIR[@]}"}; do calza "$1" "$p" && return 1; done
  for p in "${INCLUIR[@]}"; do calza "$1" "$p" && return 0; done
  return 1
}
NUEVO=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  cuenta "$f" && NUEVO="${NUEVO}${f}"$'\n'
done < <(sort -u "$CAMBIOS")

DESDE="desde el commit del que partió el último bump ($(git rev-parse --short "$BASE_SHA"))"
if [ -z "$NUEVO" ]; then
  echo "[versionar-backend] sin código nuevo $DESDE${ULTIMA:+, la $ULTIMA} — no se versiona" >&2
  veredicto false sin-cambios
fi
echo "[versionar-backend] $(printf '%s' "$NUEVO" | grep -c .) archivo(s) nuevo(s) $DESDE: $(printf '%s' "$NUEVO" | head -5 | tr '\n' ' ')" >&2
veredicto true cambios
