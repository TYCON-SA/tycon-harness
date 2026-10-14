#!/usr/bin/env bash
# missing-tool.sh — falta un requisito (corre DENTRO de una imagen derivada del núcleo, sin red: a la que la prueba le
# borró `python3`, o `node`).
#   T24 (derivada) · la herramienta de verdad no está, y el resto de los requisitos sí.
#   T31 · con el bloque `install:core` y, aparte, con el instalador suelto: salida distinta de 0, UNA línea que nombra
#         lo que falta y remite a los requisitos de la portada, y nada escrito bajo ~/.claude.
#         Sin `node`, la línea del bloque la da el propio shell («node: command not found»): el bloque empieza por
#         `git clone`, así que la carpeta del clon QUEDA (decisión C7).
# Nada de acá llama a node: una de las dos imágenes no lo tiene.
# uso: bash /opt/lab/scenarios/missing-tool.sh python3|node
set -uo pipefail
. /opt/lab/lib.sh
TOOL="${1:?falta la herramienta: python3 o node}"
T31="T31 (sin ${TOOL})"
scenario_begin "sin-${TOOL}"

# ── T24 · la derivada es la del núcleo menos esa herramienta ─────────────────────────────────────────────────
if command -v "${TOOL}" >/dev/null 2>&1; then no "T24 (derivada sin ${TOOL}) ${TOOL} sigue en la imagen: $(command -v "${TOOL}")"
else ok "T24 (derivada sin ${TOOL}) ${TOOL} no está en la imagen"; fi
requirements_check "T24 (derivada sin ${TOOL})" "" "${TOOL}"

fakes_setup ${WATCHED} dotnet curl wget launchctl open
serve_copy
# nothing_written → 0 si bajo ~/.claude no hay ningún archivo ni enlace (ni settings.json, ni el estado, ni el enlace)
nothing_written() { [ ! -e "${HOME}/.claude" ] || [ -z "$(find "${HOME}/.claude" ! -type d -print | head -n 1)" ]; }
written() { find "${HOME}/.claude" ! -type d -print 2>/dev/null | head -n 4 | tr '\n' ' '; }
NAMES_IT="falta ${TOOL} en el PATH"; POINTS="requisitos de la portada"

# ── T31 · con el bloque de la portada ────────────────────────────────────────────────────────────────────────
run_block core "${OUT_DIR}/install.out"; RC=$?
if [ "${TOOL}" = node ]; then
  # la línea es del shell: la última de la salida nombra a node y dice que no lo encuentra
  LAST="$(tail -n 1 "${OUT_DIR}/install.out")"
  case "${LAST}" in *node*"not found"*) SAID=1 ;; *) SAID=0 ;; esac
  if [ "${RC}" -ne 0 ] && [ "${SAID}" -eq 1 ]; then ok "${T31} el bloque install:core sale ${RC} y la última línea, del propio shell, nombra a node"
  else no "${T31} el bloque install:core salió ${RC}; su última línea: «${LAST}»"; fi
else
  N="$(grep -c -F "${NAMES_IT}" "${OUT_DIR}/install.out" || true)"
  if [ "${RC}" -ne 0 ] && [ "${N}" = 1 ] && grep -F "${NAMES_IT}" "${OUT_DIR}/install.out" | grep -F "${POINTS}" >/dev/null; then
    ok "${T31} el bloque install:core sale ${RC} con UNA línea que nombra ${TOOL} y remite a los requisitos de la portada"
  else no "${T31} el bloque install:core salió ${RC} con ${N} línea(s) «${NAMES_IT}»: $(tail -n 3 "${OUT_DIR}/install.out" | tr '\n' ' ')"; fi
fi
if nothing_written; then ok "${T31} tras el bloque no hay nada escrito bajo ~/.claude (ni settings.json, ni el estado, ni el enlace)"
else no "${T31} el bloque escribió bajo ~/.claude antes de fallar: $(written)"; fi
if find_clone; then ok "${T31} la carpeta del clon queda (el bloque empieza por git clone): ${CLONE}"
else
  no "${T31} no encuentro la carpeta del clon: no puedo probar el instalador suelto — $(tail -n 2 "${OUT_DIR}/install.out" | tr '\n' ' ')"
  fakes_check "${T31}"; scenario_end "sin-${TOOL}"; exit 0
fi

# ── T31 · con el instalador suelto: su propia línea, antes del candado, salida 1 ─────────────────────────────
bash "${CLONE}/scripts/install-tycon-hooks.sh" > "${OUT_DIR}/installer.out" 2>&1; RC=$?
N="$(grep -c -F "${NAMES_IT}" "${OUT_DIR}/installer.out" || true)"
if [ "${RC}" -eq 1 ] && [ "${N}" = 1 ] && grep -F "${NAMES_IT}" "${OUT_DIR}/installer.out" | grep -F "${POINTS}" >/dev/null; then
  ok "${T31} el instalador suelto sale 1 con UNA línea que nombra ${TOOL} y remite a los requisitos de la portada"
else no "${T31} el instalador suelto salió ${RC} (esperado 1) con ${N} línea(s) «${NAMES_IT}»: $(tail -n 3 "${OUT_DIR}/installer.out" | tr '\n' ' ')"; fi
if nothing_written; then ok "${T31} tras el instalador suelto no hay nada escrito bajo ~/.claude"
else no "${T31} el instalador suelto escribió bajo ~/.claude antes de fallar: $(written)"; fi

fakes_check "${T31}"
scenario_end "sin-${TOOL}"
