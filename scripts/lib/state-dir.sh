#!/usr/bin/env bash
# state-dir.sh — dónde escriben su estado y sus registros los guiones de shell del arnés.
#
# La regla es la de scripts/setup/harness/tycon-home.js (`stateDir`, `livesInOwnHome`, `ownRootOf`), dicha en shell para
# no pagar el arranque de Node en cada hook (el freno de comandos corre en cada comando):
#   · la casa del arnés es TYCON_HOME (absoluta, sin los blancos de los bordes) o ~/.tycon;
#   · si existe <casa>/state, la máquina vive en la casa propia: el estado y los registros sueltos van ahí;
#   · si no, el estado va a la carpeta de siempre bajo la de Claude Code, y los registros sueltos a la de Claude Code.
# Es la ÚNICA copia de la ruta en shell (declarada en scripts/tests/fixtures/legacy-home-names.json); su paridad con JS
# la mide scripts/tests/state-dir-parity.test.js.
#
# Se carga con `.` y deja tres funciones; no exporta nada ni cambia el PATH:
#   . "<árbol>/scripts/lib/state-dir.sh"
#   tycon_state_dir     # la carpeta del estado (bypass.log, sellos, candado)
#   tycon_logs_dir      # la carpeta de los registros sueltos (safety-guard.log)
#   tycon_own_home      # sale 0 si la máquina vive en la casa propia

# sin los blancos de los bordes, como trim() en JS: los de ASCII y los de Unicode que JS también saca (BOM, NBSP, los
# espacios de U+2000 a U+200A, U+3000…)
_tycon_trim() {
  local v="$1" antes u
  while :; do
    antes="$v"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    for u in $'\xef\xbb\xbf' $'\xc2\xa0' $'\xe1\x9a\x80' $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' \
      $'\xe2\x80\x84' $'\xe2\x80\x85' $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a' \
      $'\xe2\x80\xa8' $'\xe2\x80\xa9' $'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80'; do
      v="${v#"$u"}"
      v="${v%"$u"}"
    done
    [ "$v" = "$antes" ] && break
  done
  printf '%s' "$v"
}

# una ruta absoluta con «.» y «..» resueltos por el texto, sin mirar el disco, como path.join en JS (en una subshell: el
# `set -f` no sale de acá)
_tycon_normalize() (
  IFS=/
  set -f
  out=''
  for seg in $1; do
    case "$seg" in
      ''|.) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out:-/}"
)

# la casa del arnés: TYCON_HOME absoluta (sin los blancos de los bordes) o ~/.tycon. Una relativa no vale.
_tycon_home_root() {
  local v
  v="$(_tycon_trim "${TYCON_HOME:-}")"
  if [ -n "$v" ]; then
    case "$v" in
      /*) _tycon_normalize "$v"; return 0 ;;
      # una ruta de Windows sólo vale en Git Bash, donde Node también la toma como absoluta
      [A-Za-z]:[\\/]*) if command -v cygpath >/dev/null 2>&1; then cygpath -u "$v" 2>/dev/null || printf '%s' "$v"; return 0; fi ;;
    esac
  fi
  printf '%s/.tycon' "${HOME:-}"
}

tycon_own_home() { [ -d "$(_tycon_home_root)/state" ]; }

tycon_state_dir() {
  if tycon_own_home; then printf '%s/state' "$(_tycon_home_root)"
  else printf '%s/.claude/.tycon-pipeline' "${HOME:-}"; fi
}

tycon_logs_dir() {
  if tycon_own_home; then printf '%s/state' "$(_tycon_home_root)"
  else printf '%s/.claude' "${HOME:-}"; fi
}
