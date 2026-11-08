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

# la casa del arnés: TYCON_HOME absoluta (sin los blancos de los bordes) o ~/.tycon. Una relativa no vale.
_tycon_home_root() {
  local v="${TYCON_HOME:-}"
  # sin los blancos de los bordes, como trim() en JS
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [ -n "$v" ]; then
    case "$v" in
      /*) printf '%s' "$v"; return 0 ;;
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
