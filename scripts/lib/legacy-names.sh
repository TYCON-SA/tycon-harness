#!/usr/bin/env bash
# legacy-names.sh — que un nombre viejo siga andando en un guion de bash (story 8.9, tanda A2 · 2026-09-30)
#
# El par de scripts/lib/legacy-names.js para bash, incluido el 3.2 de macOS: nada de ${v,,}, arreglos asociativos ni una
# variable pegada a un carácter no ASCII. Lee el mismo mapa (scripts/lib/renames.json) con UNA llamada a node, sólo si
# el mapa tiene alguna entrada; sin mapa, o con el mapa vacío, es paso directo y no lanza nada.
#
# Uso (con `source`: cambia el ambiente de quien lo carga):
#   . "$ARNES/scripts/lib/legacy-names.sh"
#   legacy_env TYCON_NEW                        # si sólo está la vieja, TYCON_NEW queda con su valor (exportada)
#   legacy_args "$@" || exit 2                  # los argumentos con opciones, subcomandos y valores viejos → nuevos
#   set -- ${LEGACY_ARGS[@]+"${LEGACY_ARGS[@]}"}   # una función no puede cambiar el "$@" de quien la llama
# `LEGACY_NAMES_WHERE` fija el script (ruta relativa al repo) si no se deduce de quién cargó la biblioteca. `legacy_args`
# devuelve 2 con «la misma opción dos veces» si llegan el viejo y el nuevo de una opción que no se repite.
# Anotar un uso nunca demora: va de fondo. En Azure DevOps (TF_BUILD) además deja un warning en la corrida.

_LEGACY_NAMES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LEGACY_NAMES_ROOT="$(cd "${_LEGACY_NAMES_DIR}/../.." && pwd -P)"   # física: la comparo con la carpeta física del script
_LEGACY_NAMES_FOR=""
_LEGACY_NAMES_LINES=""

_legacy_names_map() { printf '%s' "${TYCON_LEGACY_NAMES_MAP:-${_LEGACY_NAMES_DIR}/renames.json}"; }

# el script que usa el nombre viejo, relativo al arnés (afuera, sólo su nombre)
_legacy_names_where() {
  if [ -n "${LEGACY_NAMES_WHERE:-}" ]; then printf '%s' "${LEGACY_NAMES_WHERE}"; return 0; fi
  local f="${BASH_SOURCE[2]:-}" d
  [ -n "$f" ] || { printf 'desconocido'; return 0; }
  # la carpeta física del script: `./x.sh`, `a//x.sh` o `a/b/../x.sh` dan la misma ruta que el `where` del mapa
  d="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)" && f="${d}/$(basename "$f")"
  case "$f" in /*) ;; *) f="${PWD}/${f}" ;; esac
  case "$f" in
    "${_LEGACY_NAMES_ROOT}"/*) printf '%s' "${f#"${_LEGACY_NAMES_ROOT}"/}" ;;
    *) printf '%s' "$(basename "$f")" ;;
  esac
}

_legacy_names_load() { # <where>
  [ "${_LEGACY_NAMES_FOR}" = "x$1" ] && return 0
  _LEGACY_NAMES_FOR="x$1"; _LEGACY_NAMES_LINES=""
  local map; map="$(_legacy_names_map)"
  [ -f "$map" ] || return 0
  grep -q '"old"' "$map" 2>/dev/null || return 0          # mapa vacío: ni se lanza node
  command -v node >/dev/null 2>&1 || return 0
  _LEGACY_NAMES_LINES="$(TYCON_LEGACY_NAMES_MAP="$map" node "${_LEGACY_NAMES_DIR}/legacy-names.js" --shell "$1" 2>/dev/null)" || _LEGACY_NAMES_LINES=""
}

# _legacy_names_find <kind> <campo: old|new> <nombre> → imprime «old<TAB>new<TAB>repetible» de la entrada, o nada
_legacy_names_find() {
  local kind o n r
  while IFS="$(printf '\t')" read -r kind o n r; do
    [ "$kind" = "$1" ] || continue
    if { [ "$2" = old ] && [ "$o" = "$3" ]; } || { [ "$2" = new ] && [ "$n" = "$3" ]; }; then
      printf '%s\t%s\t%s' "$o" "$n" "${r:-0}"; return 0
    fi
  done <<EOF
${_LEGACY_NAMES_LINES}
EOF
  return 1
}

_legacy_names_log() { # <kind> <old> <new> <where> [--conflict]
  case "${TF_BUILD:-}" in
    [Tt][Rr][Uu][Ee]) printf '##vso[task.logissue type=warning]nombre viejo «%s» (%s) en %s: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «%s»\n' "$2" "$1" "$4" "$3" >&2 ;;
  esac
  command -v node >/dev/null 2>&1 || return 0
  ( node "${_LEGACY_NAMES_DIR}/legacy-names.js" --log-use "$1" "$2" "$3" "$4" ${5:+"$5"} >/dev/null 2>&1 & ) 2>/dev/null
  return 0
}

# Los nombres viejos del mapa, leídos UNA vez por proceso con un grep (tanda B1): el caso de todos los días es que ninguna
# variable vieja está puesta, y entonces legacy_env no tiene nada que hacer. Sin este atajo cada llamada lanzaba subshells
# y un node, y el hook global de git (que corre en cada commit de cualquier repo) sumaba ~100 ms. Si alguna vieja está
# puesta —no importa cuál—, sigue el camino completo de abajo, que decide con el mapa entero.
_LEGACY_NAMES_OLDS=""
_LEGACY_NAMES_OLDS_READ=""
_legacy_names_any_old_set() {
  if [ -z "${_LEGACY_NAMES_OLDS_READ}" ]; then
    _LEGACY_NAMES_OLDS_READ=1
    local map="${TYCON_LEGACY_NAMES_MAP:-${_LEGACY_NAMES_DIR}/renames.json}"
    [ -f "$map" ] && _LEGACY_NAMES_OLDS="$(grep -o '"old"[[:space:]]*:[[:space:]]*"[A-Za-z_][A-Za-z0-9_]*"' "$map" 2>/dev/null | sed 's/.*"\([A-Za-z0-9_]*\)"$/\1/')"
  fi
  local o
  for o in ${_LEGACY_NAMES_OLDS}; do
    eval "[ -n \"\${${o}+x}\" ]" && return 0
  done
  return 1
}

# legacy_env <NUEVA>: sólo la vieja → la nueva queda con su valor; las dos distintas → gana la nueva (se anota conflict)
legacy_env() {
  local new="${1:-}" w hit old
  case "$new" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) return 0 ;; esac
  _legacy_names_any_old_set || return 0
  w="$(_legacy_names_where)"
  _legacy_names_load "$w"
  [ -n "${_LEGACY_NAMES_LINES}" ] || return 0
  hit="$(_legacy_names_find env new "$new")" || return 0
  old="${hit%%	*}"
  case "$old" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) return 0 ;; esac
  local old_set new_set old_v new_v
  eval "old_set=\${${old}+x}; new_set=\${${new}+x}"
  [ -n "$old_set" ] || return 0
  eval "old_v=\${${old}}"
  if [ -z "$new_set" ]; then
    eval "export ${new}=\"\${old_v}\""
    _legacy_names_log env "$old" "$new" "$w"
    return 0
  fi
  eval "new_v=\${${new}}"
  if [ "$new_v" = "$old_v" ]; then _legacy_names_log env "$old" "$new" "$w"
  else _legacy_names_log env "$old" "$new" "$w" --conflict; fi
  return 0
}

# _legacy_names_value <opción (nombre nuevo) o vacío> <argumento> <where>: deja en _LEGACY_VALUE el argumento, o su valor
# nuevo si es un valor viejo de ESA opción (tanda B3a: el cuarto campo de la línea es la opción; «0», sin opción, vale para
# cualquiera). El where lo pasa legacy_args: calculado desde acá, BASH_SOURCE apuntaría un nivel más arriba.
_legacy_names_value() {
  local hit v o
  _LEGACY_VALUE="$2"
  hit="$(_legacy_names_find value old "$2")" || return 0
  o="${hit##*	}"
  # vacío o «0» (_legacy_names_find escribe «0» por un cuarto campo vacío): el valor no tiene opción y vale en cualquiera
  if [ -n "$o" ] && [ "$o" != 0 ] && [ "$o" != "$1" ]; then return 0; fi
  v="${hit#*	}"; v="${v%%	*}"
  _legacy_names_log value "$2" "$v" "$3"
  _LEGACY_VALUE="$v"
}

# legacy_args "$@": deja en LEGACY_ARGS los argumentos con los nombres viejos pasados a los nuevos
legacy_args() {
  LEGACY_ARGS=()
  local w; w="$(_legacy_names_where)"
  _legacy_names_load "$w"
  if [ -z "${_LEGACY_NAMES_LINES}" ]; then
    [ "$#" -gt 0 ] && LEGACY_ARGS=("$@")
    return 0
  fi
  local a name rest hit i=0 done=0 seen_old="|" seen_new="|" v nu prev="" after eq
  for a in "$@"; do
    after="$prev"; prev=""
    if [ "$done" = 1 ]; then LEGACY_ARGS[${#LEGACY_ARGS[@]}]="$a"; i=$((i+1)); continue; fi
    if [ "$a" = "--" ]; then done=1; LEGACY_ARGS[${#LEGACY_ARGS[@]}]="$a"; i=$((i+1)); continue; fi
    case "$a" in
      --?*)
        name="${a#--}"; rest=""; eq=0
        case "$name" in *=*) rest="${name#*=}"; name="${name%%=*}"; eq=1 ;; esac
        nu="$name"
        if hit="$(_legacy_names_find option old "$name")"; then
          v="${hit#*	}"; v="${v%%	*}"
          _legacy_names_log option "$name" "$v" "$w"
          case "${hit##*	}" in 1) ;; *) seen_old="${seen_old}${name}|" ;; esac
          nu="$v"
        elif _legacy_names_find option new "$name" >/dev/null; then seen_new="${seen_new}${name}|"
        fi
        if [ "$eq" = 1 ]; then _legacy_names_value "$nu" "$rest" "$w"; a="--${nu}=${_LEGACY_VALUE}"; else a="--${nu}"; prev="$nu"; fi ;;
      *)
        if [ "$i" = 0 ] && hit="$(_legacy_names_find subcommand old "$a")"; then
          v="${hit#*	}"; v="${v%%	*}"; _legacy_names_log subcommand "$a" "$v" "$w"; a="$v"
        else
          _legacy_names_value "$after" "$a" "$w"; a="$_LEGACY_VALUE"
        fi ;;
    esac
    LEGACY_ARGS[${#LEGACY_ARGS[@]}]="$a"
    i=$((i+1))
  done
  # el viejo y el nuevo de una opción que no se repite: error de opción, como una desconocida
  local o n
  local IFS='|'
  for o in ${seen_old}; do
    [ -n "$o" ] || continue
    hit="$(_legacy_names_find option old "$o")" || continue
    n="${hit#*	}"; n="${n%%	*}"
    case "${seen_new}" in *"|${n}|"*)
      printf 'la misma opción dos veces: --%s y --%s (--%s es el nombre viejo de --%s)\n' "$o" "$n" "$o" "$n" >&2
      return 2 ;;
    esac
  done
  return 0
}
