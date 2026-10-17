#!/usr/bin/env bash
# legacy-options.sh — que una opción vieja siga andando en un guion de scripts/ci (story 8.9, tanda B2 · 2026-09-30)
#
# 🔴 POR QUÉ EXISTE, Y POR QUÉ NO USA scripts/lib/legacy-names.sh. Los pipelines de los productos corren los guiones
# de esta carpeta de dos maneras: desde el checkout del arnés y desde el artefacto `arnes-ci`, que es SÓLO esta carpeta
# (`targetPath: …/scripts/ci`). En la etapa de producción no hay scripts/lib ni el mapa de renombres: la biblioteca
# general no alcanza ahí, y un despliegue que pasa la opción vieja del usuario se habría roto justo en producción. Este
# traductor vive en la misma carpeta, no lanza node y no lee el mapa: cada guion declara sus pares viejo:nuevo, y
# `spanish-names.js --check-map` verifica que el mapa (scripts/lib/renames.json, la lista oficial) y cada guion digan
# lo mismo. En el retiro se sacan los pares de los dos lados; sin pares, este archivo se borra.
#
# Uso (con `source`: una función no puede cambiar el "$@" de quien la llama):
#   . "$(dirname "${BASH_SOURCE[0]}")/legacy-options.sh"
#   legacy_options 'usuario:user clave:password' "$@" || exit 2      (el código de «opción desconocida» del guion)
#   set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
# `LEGACY_OPTIONS_PREFIX` (opcional) va adelante del mensaje de error: el que usa el guion en su stderr, para que quien
# filtra su salida por ese prefijo lo filtre también (release-notes.sh: `[release-notes] `).
#
# Qué hace: pasa `--viejo` y `--viejo=x` a `--nuevo` hasta un `--` (lo de después son rutas, no opciones). Con un par
# `opcion=viejo:nuevo` (tanda B3a), el valor viejo de esa opción —el argumento siguiente o lo que va tras `=`— pasa al
# nuevo: `legacy_options 'entorno:environment environment=produccion:production' "$@"`. Con la vieja
# y la nueva juntas devuelve 2 y dice «la misma opción dos veces». Cada nombre viejo usado deja, en Azure DevOps
# (TF_BUILD), un warning en la corrida — es donde se ve el uso desde los productos —, y donde está el arnés completo
# lo anota en el registro de usos (scripts/lib/legacy-names.js --log-use, de fondo). Sin nombres viejos no cuesta nada:
# es un bucle de bash sobre los argumentos. Bash 3.2: nada de arreglos asociativos ni `${v,,}`.
# Guía: guides/maintaining/nombres-en-ingles.md §«El traductor de scripts/ci».

LEGACY_OPTIONS=()

# 🔴 El warning de la corrida va por stderr, SALVO que stdout y stderr vayan al mismo lugar: eso es quien llama
# guardando la salida como dato (`NOTAS=$(release-notes.sh … 2>&1 | …)` en el pipeline de un producto), y el warning
# terminaba ADENTRO de la nota de versión que lee el administrador del plugin. Lo encontró T32 (story 8.9, tanda B2).
# En un paso normal de Azure los dos van por separado y el warning se ve en la corrida.
_legacy_options_ci_warning() { # <viejo> <nuevo> <guion> [option|value]
  local dash="--"
  case "${TF_BUILD:-}" in [Tt][Rr][Uu][Ee]) ;; *) return 0 ;; esac
  [ /dev/stdout -ef /dev/stderr ] && return 0   # sin 2>/dev/null: redirigir stderr acá cambiaría lo que se compara
  [ "${4:-option}" = value ] && dash=""
  printf '##vso[task.logissue type=warning]nombre viejo «%s%s» (%s) en %s: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «%s%s» (el viejo se retira: guides/maintaining/nombres-en-ingles.md)\n' "$dash" "$1" "${4:-option}" "$3" "$dash" "$2" >&2
}

_legacy_options_note() { # <viejo> <nuevo> <guion> [option|value]
  _legacy_options_ci_warning "$1" "$2" "$3" "${4:-option}"
  local lib
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" 2>/dev/null && pwd)/legacy-names.js" || return 0
  [ -f "$lib" ] && command -v node >/dev/null 2>&1 || return 0
  ( node "$lib" --log-use "${4:-option}" "$1" "$2" "$3" >/dev/null 2>&1 & ) 2>/dev/null
  return 0
}

# El valor viejo de una opción (pares «opcion=viejo:nuevo», tanda B3a) pasado al nuevo; si no hay par, igual. <opcion> <valor>
_legacy_options_value() {
  local p opt rest o n
  _LEGACY_VALUE="$2"
  for p in $_legacy_pairs; do
    case "$p" in *=*:*) ;; *) continue ;; esac
    opt="${p%%=*}"; rest="${p#*=}"; o="${rest%%:*}"; n="${rest#*:}"
    if [ "$opt" = "$1" ] && [ "$2" = "$o" ]; then
      case "$_legacy_seen_values" in *"|${opt}=${o}|"*) ;; *) _legacy_options_note "$o" "$n" "$_legacy_where" value ;; esac
      _legacy_seen_values="${_legacy_seen_values}${opt}=${o}|"; _LEGACY_VALUE="$n"; return 0
    fi
  done
}

legacy_options() { # <pares «viejo:nuevo … opcion=viejo:nuevo …»> <argumentos…>
  local pairs="$1" where a name rest p o n done=0 seen_old="|" seen_new="|" prev=""
  _legacy_pairs="$1"; _legacy_seen_values="|"
  shift
  LEGACY_OPTIONS=()
  where="scripts/ci/$(basename "${BASH_SOURCE[1]:-$0}")"
  _legacy_where="$where"
  for a in "$@"; do
    if [ "$done" = 0 ]; then
      case "$a" in
        --) done=1; prev="" ;;
        --?*)
          name="${a#--}"; rest=""
          case "$name" in *=*) rest="${name#*=}"; name="${name%%=*}" ;; esac
          for p in $pairs; do
            case "$p" in *=*:*) continue ;; esac
            o="${p%%:*}"; n="${p#*:}"
            if [ "$name" = "$o" ]; then
              case "$seen_old" in *"|${o}|"*) ;; *) _legacy_options_note "$o" "$n" "$where" ;; esac
              seen_old="${seen_old}${o}|"; name="$n"; break
            fi
            if [ "$name" = "$n" ]; then seen_new="${seen_new}${n}|"; break; fi
          done
          case "$a" in
            *=*) _legacy_options_value "$name" "$rest"; a="--${name}=${_LEGACY_VALUE}"; prev="" ;;
            *) a="--${name}"; prev="$name" ;;
          esac ;;
        *)
          if [ -n "$prev" ]; then _legacy_options_value "$prev" "$a"; a="$_LEGACY_VALUE"; fi
          prev="" ;;
      esac
    fi
    LEGACY_OPTIONS[${#LEGACY_OPTIONS[@]}]="$a"
  done
  for p in $pairs; do
    case "$p" in *=*:*) continue ;; esac
    o="${p%%:*}"; n="${p#*:}"
    case "$seen_old" in *"|${o}|"*)
      case "$seen_new" in *"|${n}|"*)
        # con el prefijo del guion (LEGACY_OPTIONS_PREFIX): quien guarda su salida como dato filtra por él —
        # sin prefijo, el mensaje terminaba publicado como nota de versión (revisión de la tanda B2, SILENT-C2)
        printf '%sla misma opción dos veces: --%s y --%s (--%s es el nombre viejo de --%s)\n' "${LEGACY_OPTIONS_PREFIX:-}" "$o" "$n" "$o" "$n" >&2
        return 2 ;;
      esac ;;
    esac
  done
  return 0
}
