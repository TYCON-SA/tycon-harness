#!/usr/bin/env bash
# harness-node.sh — qué Node usa un guion de shell del arnés.
#
# El arnés baja su propio Node a `<casa>/node/current` (la casa es TYCON_HOME o ~/.tycon; la regla vive en
# scripts/setup/harness/tycon-home.js#harnessNode, y ésta es una copia declarada en
# scripts/tests/fixtures/harness-node-copies.json). Los guiones de shell del arnés (los hooks .sh, los hooks globales de
# git, el instalador) lanzan sus `node` con él si está y es ejecutable; si no, con el `node` del PATH, como siempre.
#
# Se carga con `.` y deja UNA función; no exporta nada ni cambia el PATH: lo que el guion lance después (el
# `.githooks/pre-commit` del repo del dev, `npm install -g`) sigue con el Node del dev.
#
#   . "<árbol>/scripts/lib/harness-node.sh"
#   HNODE="$(harness_node_bin)"            # la ruta de current, o «node»
#   "$HNODE" guion.js …
#
# Apagado: TYCON_HARNESS_NODE=0 → siempre «node».

harness_node_bin() {
  if [ "${TYCON_HARNESS_NODE:-}" = "0" ]; then echo node; return 0; fi
  local casa="${TYCON_HOME:-${HOME:-}/.tycon}"
  # una TYCON_HOME relativa no se resuelve contra la carpeta de quien llama (como tycon-home.js): el Node del PATH
  case "$casa" in /*|[A-Za-z]:*) ;; *) echo node; return 0 ;; esac
  # en Git Bash la casa puede venir como C:\Users\…: se pasa a la forma del shell
  if command -v cygpath >/dev/null 2>&1; then casa="$(cygpath -u "$casa" 2>/dev/null || printf '%s' "$casa")"; fi
  if [ -f "$casa/node/current/bin/node" ] && [ -x "$casa/node/current/bin/node" ]; then echo "$casa/node/current/bin/node"; return 0; fi
  if [ -f "$casa/node/current/node.exe" ] && [ -x "$casa/node/current/node.exe" ]; then echo "$casa/node/current/node.exe"; return 0; fi
  echo node
}
