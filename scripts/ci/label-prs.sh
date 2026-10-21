#!/usr/bin/env bash
# =============================================================================
# label-prs.sh — la corrida de main dice qué pull requests trae
# =============================================================================
# 🔴 POR QUÉ EXISTE. En Azure DevOps la corrida del pull request se ve bien —título y
# enlace—, pero la que dispara el push a main se titula «Merge pull request <id> from dev into
# main» y no enlaza a nada. Con `batch: true` una corrida junta varios merges y el título muestra,
# a lo sumo, el último. Este guion le pone a la corrida una etiqueta `PR-<id>` por cada pull request
# que trae y un resumen en su página, con el enlace a cada uno.
#
# La contraparte es el skill tycon-merge-to-main, que fija el mensaje de merge
# «Merged PR <id>: <título>». Este guion reconoce también otros formatos, así que etiqueta bien
# un PR que se complete desde la pantalla. También etiqueta el de un repo que vive en GitHub, donde el
# skill titula el merge «<título> (#<id>)» y el enlace va al pedido de GitHub.
#
# QUÉ TRAE UNA CORRIDA = los merges de la LÍNEA DE MAIN (`--first-parent`) desde la base hasta la
# punta. Sin `--first-parent` también aparecen los PR que entraron a `dev` y llegan adentro del merge
# de `dev` (varias etiquetas donde va 1). La base es la de run-base.sh, la misma que
# usa forms-to-version.sh: el commit del que partió la corrida anterior (marca `Commit:` del
# commit de versión del bot) — o sea, «qué trae esta versión respecto de la anterior».
#
# 🔴 NO ES UN CONTROL: ES TRAZABILIDAD. Nunca frena la corrida — sale 0 siempre. Pero «no etiqueté»
# se DICE (`##vso[task.logissue type=warning]` con el motivo): un verde mudo se lee igual que «no
# trae PR».
#
# 🔴 UN TÍTULO DE PR ES TEXTO DE AFUERA. Azure interpreta `##vso[…]` en stdout y en stderr: un PR
# titulado `##vso[task.setvariable …]` podría fijar variables de la corrida. Los títulos van SÓLO al
# archivo de resumen, escapados; por la consola salen números, nunca asuntos.
#
# Uso:  label-prs.sh [--repo <dir>] [--until <ref>] [--summary <archivo>]
#   --repo     el repo (default: .)
#   --until    la punta de la corrida (default: HEAD; en Azure es el commit que se construye)
#   --summary  dónde escribir el resumen markdown (default: $AGENT_TEMPDIRECTORY o una carpeta temporal)
#   (--until y --summary tienen un nombre viejo en castellano que sigue andando hasta el retiro)
# Salida (stdout): `##vso[build.addbuildtag]PR-<id>` por PR, `##vso[task.uploadsummary]<ruta>`, y el
#   aviso si no pudo. Explicación por stderr. Exit: siempre 0.
# =============================================================================
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="."; HASTA="HEAD"; RESUMEN=""

log(){ echo "[etiquetar] $*" >&2; }
avisar(){ # nunca frena: dice por qué no etiquetó y sale 0
  echo "##vso[task.logissue type=warning]etiquetar-prs: esta corrida queda SIN etiquetas de pull request — $*"
  log "no etiqueté: $*"
  exit 0
}

# Las opciones renombradas a inglés: los pipelines de los productos siguen pasando las viejas
# hasta el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci). La vieja y la nueva juntas no frenan
# la corrida, como cualquier otro argumento raro: se avisa y se sale 0.
if [ -f "$AQUI/legacy-options.sh" ]; then
  . "$AQUI/legacy-options.sh"
  LEGACY_OPTIONS_PREFIX='[etiquetar] ' legacy_options 'hasta:until resumen:summary' "$@" \
    || avisar "la misma opción llegó dos veces (con su nombre viejo y el nuevo)"
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    REPO="${2:-}"; shift ;;
    --until)   HASTA="${2:-}"; shift ;;
    --summary) RESUMEN="${2:-}"; shift ;;
    *) avisar "argumento desconocido: $(printf '%s' "$1" | tr -cd 'a-zA-Z0-9_./=-')" ;;
  esac
  shift
done

[ -f "$AQUI/run-base.sh" ] || avisar "no está run-base.sh al lado del guion (¿el artefacto arnes-ci llegó incompleto?)"
# shellcheck source=run-base.sh
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
{ [ -f "$AQUI/run-base.sh" ] && . "$AQUI/run-base.sh"; } || avisar "no pude cargar run-base.sh"

[ -n "$REPO" ] && cd "$REPO" 2>/dev/null || avisar "no existe el repo indicado"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || avisar "el directorio no es un repo git"
PUNTA=$(git rev-parse -q --verify "${HASTA}^{commit}" 2>/dev/null) || avisar "no existe la punta pedida (--until)"
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  avisar "el clon no tiene historia completa (shallow); el job necesita checkout con fetchDepth: 0"
fi

base_de_corrida "$PUNTA" '^chore: update form versions' '^chore: update versions' '^chore: bump version'
case "$BASE_MODO" in
  marca)           COMO="desde el commit del que partió la corrida anterior, anotado en el commit de versión $(git rev-parse --short "$BASE_BOT")" ;;
  bot-sin-marca)   COMO="desde el commit de versión $(git rev-parse --short "$BASE_BOT"), que no anota de qué commit partió: si hubo un rebase puede faltar un pull request" ;;
  marca-invalida)  COMO="desde el commit de versión $(git rev-parse --short "$BASE_BOT"): su marca Commit: no es un ancestro válido; si hubo un rebase puede faltar un pull request" ;;
  punta-menos-uno) COMO="desde HEAD~1 de la punta: no hay commit de versión previo, así que sólo se ve el último merge" ;;
  *)               avisar "no pude decidir la base (historia de un solo commit)" ;;
esac
log "base $(git rev-parse --short "$BASE_SHA"): $COMO"

ASUNTOS=$(git log --first-parent --merges --format=%s "$BASE_SHA..$PUNTA" 2>/dev/null) || avisar "git no pudo recorrer la historia desde la base"
if [ -z "$ASUNTOS" ]; then
  log "la corrida no trae merges (push directo o corrida manual): nada que etiquetar"
  exit 0
fi

# Escapa texto de afuera para el markdown del resumen: ni HTML, ni enlaces armados, ni un `##vso[`
# literal que alguien pueda terminar volcando en un log.
escapar(){ printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/\[/\\[/g' -e 's/\]/\\]/g' -e 's/#/\\#/g'; }
codificar(){ printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/ /%20/g'; }

# ¿El repo vive en GitHub? En una corrida lo dice Azure Pipelines (BUILD_REPOSITORY_PROVIDER: «GitHub», o
# «GitHubEnterprise» para uno propio de una empresa); fuera de una corrida, el remoto `origin`. De esto dependen DOS
# cosas: la forma «asunto (#N)» del merge —que en un repo de Azure NO es un pedido: ahí un «(#N)» al final del asunto es
# el número de una tarea— y a dónde enlaza el resumen.
ES_GITHUB=""
case "${BUILD_REPOSITORY_PROVIDER:-}" in
  [Gg]it[Hh]ub*) ES_GITHUB=1 ;;
  "")
    # sin el dato de Azure: si git no puede decir el remoto, queda como «no es de GitHub», que es lo de siempre
    ORIGEN=$(git remote get-url origin 2>/dev/null) || ORIGEN=""
    case "$ORIGEN" in *github.com[:/]*) ES_GITHUB=1 ;; esac ;;
esac

URL_BASE=""
# Con el repo en GitHub, el pedido vive ahí (`<dueño>/<repo>/pull/N`): la dirección de Azure llevaría a una página que
# no existe. La dirección del repo la da la corrida (BUILD_REPOSITORY_URI); sin ella, la de github.com.
# Lo que va adentro de un enlace del resumen tiene que tener forma de dirección: un `)` o un espacio lo rompería. Si
# no la tiene, el resumen sale sin enlace. Se mira el valor ENTERO con `case` —cualquier carácter fuera de la lista,
# también un salto de línea, lo descarta—: un `grep` mira renglón por renglón y daría por bueno un valor de varias líneas
# con la primera bien formada.
es_direccion(){   # https://<servidor>/<ruta>, sólo con letras, números y . _ ~ / : -
  case "$1" in https://?*) ;; *) return 1 ;; esac
  case "${1#https://}" in *[!A-Za-z0-9._~/:-]*) return 1 ;; esac
  return 0
}
es_nombre_de_repo(){   # <dueño>/<repo>, cada parte con letras, números y . _ -
  case "$1" in ""|*[!A-Za-z0-9._/-]*|/*|*/|*/*/*) return 1 ;; */*) return 0 ;; *) return 1 ;; esac
}
if [ -n "$ES_GITHUB" ] && es_direccion "${BUILD_REPOSITORY_URI:-}"; then
  URL_BASE="${BUILD_REPOSITORY_URI%.git}/pull/"
elif [ -n "$ES_GITHUB" ] && [ -z "${BUILD_REPOSITORY_URI:-}" ] && es_nombre_de_repo "${BUILD_REPOSITORY_NAME:-}"; then
  URL_BASE="https://github.com/${BUILD_REPOSITORY_NAME}/pull/"
elif [ -n "$ES_GITHUB" ]; then
  URL_BASE=""   # se sabe que es de GitHub, pero no cuál (o su dirección no tiene forma): sin enlace, antes que uno a Azure
elif [ -n "${SYSTEM_COLLECTIONURI:-}" ] && [ -n "${SYSTEM_TEAMPROJECT:-}" ] && [ -n "${BUILD_REPOSITORY_NAME:-}" ]; then
  URL_BASE="${SYSTEM_COLLECTIONURI%/}/$(codificar "$SYSTEM_TEAMPROJECT")/_git/$(codificar "$BUILD_REPOSITORY_NAME")/pullrequest/"
fi

VISTOS=" "; LINEAS=""; N_PR=0; SIN_NUMERO=0
# Del más viejo al más nuevo: las etiquetas y el resumen quedan en el orden en que entraron.
while IFS= read -r asunto; do
  [ -n "$asunto" ] || continue
  num=$(printf '%s\n' "$asunto" | sed -n -E 's/^(Merged PR|Merge PR|Merge pull request) #?([0-9]+)([: ].*)?$/\2/p')
  # El merge de un pedido de GitHub hecho por el skill se titula «asunto (#N)»: el número CIERRA el asunto. (Un
  # «(#N)» en el medio de otro texto no es eso.) Sólo con el repo en GitHub: ver ES_GITHUB, más arriba.
  de_github=""
  if [ -z "$num" ] && [ -n "$ES_GITHUB" ]; then
    num=$(printf '%s\n' "$asunto" | sed -n -E 's/^.+ \(#([0-9]+)\)$/\1/p')
    [ -n "$num" ] && de_github=1
  fi
  if [ -z "$num" ]; then SIN_NUMERO=$((SIN_NUMERO+1)); continue; fi
  case "$VISTOS" in *" $num "*) continue ;; esac
  VISTOS="$VISTOS$num "; N_PR=$((N_PR+1))
  echo "##vso[build.addbuildtag]PR-$num"
  if [ -n "$de_github" ]; then
    titulo=$(printf '%s\n' "$asunto" | sed -n -E 's/^(.+) \(#[0-9]+\)$/\1/p')
  else
    titulo=$(printf '%s\n' "$asunto" | sed -n -E 's/^(Merged PR|Merge PR) #?[0-9]+: ?(.*)$/\2/p')
  fi
  if [ -z "$titulo" ]; then
    ramas=$(printf '%s\n' "$asunto" | sed -n -E 's/^Merge pull request #?[0-9]+ from ([^ ]+) into ([^ ]+).*$/\1 → \2/p')
    [ -n "$ramas" ] && titulo="($ramas)"
  fi
  if [ -n "$URL_BASE" ]; then cabeza="[PR $num](${URL_BASE}$num)"; else cabeza="PR $num"; fi
  if [ -n "$titulo" ]; then LINEAS="$LINEAS- $cabeza: $(escapar "$titulo")"$'\n'; else LINEAS="$LINEAS- $cabeza"$'\n'; fi
done <<< "$(printf '%s\n' "$ASUNTOS" | awk '{ l[NR]=$0 } END { for (i=NR; i>0; i--) print l[i] }')"

log "$N_PR pull request(s) etiquetado(s) · $SIN_NUMERO merge(s) sin número"

if [ -z "$RESUMEN" ]; then
  DIR="${AGENT_TEMPDIRECTORY:-}"
  if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then DIR=$(mktemp -d 2>/dev/null) || { log "no pude crear dónde escribir el resumen"; exit 0; }; fi
  RESUMEN="$DIR/pull-requests-de-la-corrida.md"
fi
case "$RESUMEN" in /*) ;; *) RESUMEN="$(pwd)/$RESUMEN" ;; esac
{
  echo "### Pull requests de esta corrida"
  echo
  if [ "$N_PR" -gt 0 ]; then
    echo "Esta corrida incluye $N_PR pull request(s):"
    echo
    printf '%s' "$LINEAS"
  else
    echo "Esta corrida no incluye pull requests con número."
  fi
  if [ "$SIN_NUMERO" -gt 0 ]; then
    echo
    if [ "$SIN_NUMERO" -eq 1 ]; then echo "1 merge sin número de pull request."; else echo "$SIN_NUMERO merges sin número de pull request."; fi
  fi
  echo
  echo "Base: \`$(git rev-parse --short "$BASE_SHA")\` — $COMO."
} > "$RESUMEN" 2>/dev/null || { log "no pude escribir el resumen en la ruta pedida"; exit 0; }
echo "##vso[task.uploadsummary]$RESUMEN"
exit 0
