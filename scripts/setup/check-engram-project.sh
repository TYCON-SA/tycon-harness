#!/usr/bin/env bash
# =============================================================================
# check-engram-project.sh — el nombre de proyecto de engram tiene que ser UNO por repo
# =============================================================================
# Por qué (ENGRAM-PROJECT-NAME-DRIFT-1, 2026-08-25): la memoria persistente guarda todo por
# nombre de proyecto, y ese nombre vive en DOS archivos que nadie obliga a coincidir:
#   · .engram/config.json → project_name   (lo lee el MCP / la CLI en la sesión)
#   · .engram-project                       (lo lee engram-pre-commit.sh en cada commit)
# Cuando desacuerdan, la falla es SILENCIOSA: lo que se guarda cae en un cajón y lo que se
# busca mira otro, y "sin resultados" se lee igual que "todavía no hay historia". Caso real:
# los 6 repos de un producto del equipo se consolidaron a `totora` el 2026-08-20 editando config.json y el
# CLAUDE.md — y `.engram-project` quedó con los nombres viejos (TotoraBackend,
# TotoraCustomForms…) durante días, sincronizando cada commit bajo el cajón equivocado
# — guides/incident-log.md#case-engram-project-name-drift-2026-08-20.
# Mismo día, otro cliente (el repo del framework): 74 observaciones repartidas en 6 nombres.
#
# Qué hace: para el repo dado (arg 1, default $PWD) AVISA —nunca bloquea— si
#   (a) hay `.engram/` pero ningún archivo declara el nombre, o
#   (b) los dos archivos declaran nombres distintos.
# Silencioso si coinciden o si el repo no usa engram. Sale 0 siempre (advisory), salvo
# `--strict`, que sale 1 cuando hay aviso (lo usan los tests y quien quiera un gate).
#
# Lo invoca install-tycon-hooks.sh en cada SessionStart (junto al chequeo de versión).
# Opt-out: TYCON_NO_ENGRAM_PROJECT_CHECK=1. Fail-open total: cualquier error interno → exit 0.
# Red: scripts/tests/engram-project-check.test.sh
# =============================================================================
set -uo pipefail
[[ "${TYCON_NO_ENGRAM_PROJECT_CHECK:-0}" == "1" ]] && exit 0

STRICT=0
REPO="$PWD"
for a in "$@"; do
  case "$a" in
    --strict) STRICT=1 ;;
    *) REPO="$a" ;;
  esac
done

# Sin git no hay "repo": mirar el directorio tal cual (los tests usan carpetas temporales).
if command -v git >/dev/null 2>&1; then
  top="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$top" ]] && REPO="$top"
fi

[[ -d "$REPO/.engram" || -f "$REPO/.engram-project" ]] || exit 0

leer_config() {
  local cfg="$REPO/.engram/config.json"
  [[ -f "$cfg" ]] || return 0
  # Sin depender de node/jq: el campo es un string simple.
  sed -n 's/.*"project_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -1
}
leer_archivo() {
  [[ -f "$REPO/.engram-project" ]] || return 0
  head -1 "$REPO/.engram-project" | tr -d '[:space:]'
}

en_config="$(leer_config 2>/dev/null || true)"
en_archivo="$(leer_archivo 2>/dev/null || true)"

aviso=""
if [[ -z "$en_config" && -z "$en_archivo" ]]; then
  aviso="⚠ engram: $REPO tiene .engram/ pero NINGÚN archivo declara el nombre de proyecto (ni .engram/config.json → project_name ni .engram-project). Riesgo de fragmentación silenciosa: cada sesión puede guardar bajo un nombre distinto. Fijalo en los dos (mismo valor)."
elif [[ -n "$en_config" && -n "$en_archivo" ]]; then
  lc_c="$(printf '%s' "$en_config" | tr '[:upper:]' '[:lower:]')"
  lc_a="$(printf '%s' "$en_archivo" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lc_c" != "$lc_a" ]]; then
    aviso="⚠ engram: $REPO declara DOS nombres de proyecto distintos — .engram/config.json dice \"$en_config\" y .engram-project dice \"$en_archivo\". El hook de commit sincroniza con el segundo y la sesión busca con el primero: la memoria se parte en dos cajones sin error. Dejá el mismo valor en ambos (el canónico del CLAUDE.md del repo)."
  fi
elif [[ -n "$en_config" && -z "$en_archivo" && -f "$REPO/.engram-project" ]]; then
  aviso="⚠ engram: $REPO tiene un .engram-project VACÍO mientras config.json dice \"$en_config\" — el hook de commit va a sincronizar sin proyecto. Escribí \"$en_config\" en .engram-project."
fi

if [[ -n "$aviso" ]]; then
  echo "$aviso"
  [[ "$STRICT" == "1" ]] && exit 1
fi
exit 0
