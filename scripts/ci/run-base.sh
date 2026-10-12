#!/usr/bin/env bash
# =============================================================================
# run-base.sh — ¿desde qué commit mira una corrida de main «lo que trae»?
# =============================================================================
# Se carga con `source` (no se ejecuta). La usan dos guiones que se hacen la misma pregunta:
#   · forms-to-version.sh — a qué formularios subirles la versión;
#   · label-prs.sh        — qué pull requests trae la corrida (story 2.17).
#
# 🔴 POR QUÉ ESTÁ APARTE (2026-09-15, story 2.17). La lógica vivía adentro de
# forms-to-version.sh como `base_cambios`, con los mensajes del bot de formularios fijos. El
# guion de etiquetas necesitaba la misma respuesta y con los mensajes de los backends
# («chore: bump version to X [skip ci]»): copiarla era la deuda que el arnés ya pagó con
# release-notes.sh en 8 repos. La lógica se comparte; los mensajes no — cada guion habla de lo suyo
# (formularios de formularios, etiquetas de pull requests), por eso esta función NO imprime nada.
#
# LA RESPUESTA (idéntica a la de `base_cambios` hasta hoy):
#   1. el último commit del bot (cualquiera de los patrones) alcanzable desde la punta;
#   2. si anota `Commit: <sha>` y ese commit existe y es ancestro de la punta → ese sha: es el commit
#      del que partió la corrida anterior, y ese hash NO lo mueve un rebase del commit del bot;
#   3. si no lo anota, o el anotado no sirve → el commit del bot mismo (quien llama avisa: si hubo un
#      rebase puede perderse algo);
#   4. sin commit del bot → <punta>~1;
#   5. historia de un solo commit → vacío.
#
# Uso:
#   source "$AQUI/run-base.sh"
#   base_de_corrida <punta> <patrón-de-mensaje>...
# Deja:
#   BASE_SHA    el commit base (vacío en el caso 5)
#   BASE_MODO   marca | bot-sin-marca | marca-invalida | punta-menos-uno | sin-base
#   BASE_BOT    el commit del bot (casos 2 y 3), si no vacío
#   BASE_MARCA  el sha anotado tal cual (casos 2 y marca-invalida), si no vacío
# Siempre devuelve 0. Corre en el directorio del repo (quien llama hace el `cd`).
# =============================================================================

base_de_corrida() {
  local punta="$1"; shift
  local greps=() p b h
  for p in "$@"; do greps+=("--grep=$p"); done
  BASE_SHA=""; BASE_MODO="sin-base"; BASE_BOT=""; BASE_MARCA=""

  if [ ${#greps[@]} -gt 0 ]; then
    b=$(git log -1 --pretty=%H "${greps[@]}" "$punta" 2>/dev/null || true)
  else
    b=""
  fi
  if [ -n "$b" ] && git cat-file -e "${b}^{commit}" 2>/dev/null; then
    BASE_BOT="$b"
    h=$(git log -1 --pretty=%B "$b" 2>/dev/null | sed -n 's/^[[:space:]]*Commit:[[:space:]]*\([0-9a-fA-F]\{7,40\}\)[[:space:]]*$/\1/p' | head -1)
    BASE_MARCA="$h"
    if [ -n "$h" ] && git cat-file -e "${h}^{commit}" 2>/dev/null && git merge-base --is-ancestor "$h" "$punta" 2>/dev/null; then
      BASE_SHA="$h"; BASE_MODO="marca"; return 0
    fi
    BASE_SHA="$b"
    if [ -n "$h" ]; then BASE_MODO="marca-invalida"; else BASE_MODO="bot-sin-marca"; fi
    return 0
  fi
  if git cat-file -e "${punta}~1^{commit}" 2>/dev/null; then
    BASE_SHA=$(git rev-parse "${punta}~1"); BASE_MODO="punta-menos-uno"; return 0
  fi
  return 0
}
