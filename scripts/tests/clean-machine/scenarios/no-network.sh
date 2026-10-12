#!/usr/bin/env bash
# no-network.sh — sin red (corre DENTRO del contenedor del núcleo, lanzado con `--network none`).
#   T31 (--check) · sobre una HOME sin settings.json, `install-tycon-hooks.sh --check` no escribe nada.
#   T30 · el bloque `install:core` sale 0 igual; el paso de terceros dice que no pudo preguntar a los orígenes; el
#         control de presencia nombra las skills de terceros que faltan; y `harness.js startup` sale 0 diciendo
#         «sin red» en 35 s o menos.
# La receta de T30 (decisión C2): la copia se sirve desde una carpeta local, así que su `fetch` anda aunque no haya
# red. Para medir «sin red» de verdad: tras instalar se saca el desvío, se corre `harness.js install --source <URL>`
# (el remedio documentado cuando el origen cambió) y recién entonces `startup`.
# uso: bash /opt/lab/scenarios/no-network.sh
set -uo pipefail
. /opt/lab/lib.sh
scenario_begin no-network
fakes_setup ${WATCHED} dotnet curl wget launchctl open
serve_copy

# ── T31 · --check sobre una HOME sin settings.json: no escribe nada ──────────────────────────────────────────
listing() { find "${HOME}" -print | LC_ALL=C sort; }
if ( cd "${WORK_DIR}" && git clone -q "${PUBLIC_URL}" check-clone ) > "${OUT_DIR}/check-clone.out" 2>&1; then
  listing > "${OUT_DIR}/home-before.txt"
  bash "${WORK_DIR}/check-clone/scripts/install-tycon-hooks.sh" --check > "${OUT_DIR}/check.out" 2>&1; RC=$?
  listing > "${OUT_DIR}/home-after.txt"
  if [ "${RC}" -eq 0 ] && cmp -s "${OUT_DIR}/home-before.txt" "${OUT_DIR}/home-after.txt" \
     && [ ! -e "${HOME}/.claude/settings.json" ] && [ ! -e "${STATE_FILE}" ] && [ ! -L "${HARNESS_LINK}" ]; then
    ok "T31 install-tycon-hooks.sh --check sobre una HOME sin settings.json sale 0 y no escribe nada (ni settings.json, ni el estado, ni el enlace)"
  else
    no "T31 install-tycon-hooks.sh --check salió ${RC} o escribió en la HOME: $(diff "${OUT_DIR}/home-before.txt" "${OUT_DIR}/home-after.txt" | grep '^[<>]' | head -n 4 | tr '\n' ' ') $(tail -n 2 "${OUT_DIR}/check.out" | tr '\n' ' ')"
  fi
  # sin el enlace todavía, la revisión de terceros mira el CLON (decisión C16): con la ruta del enlace, que no existe,
  # decía «no es un clon de agent-skills» y no revisaba nada. Acá revisa, y como nada está instalado, dice qué falta.
  if ! grep -q 'no es un clon de agent-skills' "${OUT_DIR}/check.out" && grep -q 'skills de terceros' "${OUT_DIR}/check.out"; then
    ok "T31 --check sin el enlace revisa las skills de terceros en el propio clon (y dice cuáles faltan)"
  else
    no "T31 --check sin el enlace no revisó las skills de terceros en el clon: $(grep -i 'terceros\|agent-skills' "${OUT_DIR}/check.out" | head -n 2 | tr '\n' ' ')"
  fi
  rm -rf "${WORK_DIR}/check-clone"
else
  no "T31 no pude clonar la copia para probar --check: $(tail -n 2 "${OUT_DIR}/check-clone.out" | tr '\n' ' ')"
fi

# ── T30 · sin red la instalación sale 0 y lo dice ────────────────────────────────────────────────────────────
run_block_pty core "${OUT_DIR}/install.out" "${ANSWERS_FULL}"; RC=$?   # en una terminal: install pregunta (story 8.16, tandas B y D)
if [ "${RC}" -eq 0 ] && find_clone; then ok "T30 sin red, el bloque install:core sale 0"
else
  no "T30 sin red, el bloque install:core salió ${RC}: $(tail -n 4 "${OUT_DIR}/install.out" | tr '\n' ' ')"
  fakes_check "T30"; scenario_end no-network; exit 0
fi

# la línea del paso de terceros (el contrato de la 8.5). `harness.js install` guarda la salida del instalador en su
# registro y no la muestra entera: si no está ahí, se corre el instalador una vez más, como en cada arranque, y se lee la suya
LINE_RE='skills de terceros: .*no pude preguntar al origen'
WHERE=""
if grep -q -E "${LINE_RE}" "${OUT_DIR}/install.out"; then WHERE="la salida del bloque"
elif grep -q -E "${LINE_RE}" "${HOME}/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null; then WHERE="el registro del arranque"
else
  bash "${CLONE}/scripts/install-tycon-hooks.sh" > "${OUT_DIR}/installer-again.out" 2>&1
  grep -q -E "${LINE_RE}" "${OUT_DIR}/installer-again.out" && WHERE="la salida del instalador"
fi
if [ -n "${WHERE}" ]; then ok "T30 el paso de terceros dice en una línea que no pudo preguntar a los orígenes (en ${WHERE})"
else no "T30 el paso de terceros no dijo «no pude preguntar al origen»: $(grep 'skills de terceros' "${OUT_DIR}/install.out" "${OUT_DIR}/installer-again.out" 2>/dev/null | head -n 2 | tr '\n' ' ' | head -c 300)"; fi

# el control de presencia nombra las skills de terceros que faltan: sin red, todas las del manifiesto de la copia
read -r TP_TOTAL TP_MISSING TP_LOADS <<< "$(third_party "${CLONE}")"
N_MISSING=0; [ "${TP_MISSING:--}" != "-" ] && N_MISSING="$(echo "${TP_MISSING}" | tr ',' '\n' | grep -c .)"
if [ "${TP_TOTAL:-0}" -gt 0 ] && [ "${N_MISSING}" = "${TP_TOTAL}" ]; then ok "T30 el control de presencia nombra las ${TP_TOTAL} skills de terceros que faltan: ${TP_MISSING}"
else no "T30 el control de presencia nombra ${N_MISSING} de ${TP_TOTAL:-0} skills de terceros como faltantes (sin red tendrían que faltar todas): ${TP_MISSING:-?}"; fi

# la receta de C2, y recién entonces `startup`
unserve_copy
node "${HARNESS_JS}" install --yes --source "${PUBLIC_URL}" > "${OUT_DIR}/install-source.out" 2>&1; RC=$?
if [ "${RC}" -eq 0 ] && [ "$(json "${STATE_FILE}" 'd.sources[0].url')" = "${PUBLIC_URL}" ]; then ok "T30 sin el desvío, harness.js install --source <URL del bloque> sale 0 y el estado guarda esa URL"
else no "T30 harness.js install --source salió ${RC}: $(tail -n 3 "${OUT_DIR}/install-source.out" | tr '\n' ' ')"; fi
T0="$(date +%s)"
node "${HARNESS_JS}" startup > "${OUT_DIR}/startup.out" 2>&1; RC=$?
TOOK=$(( $(date +%s) - T0 ))
if [ "${RC}" -eq 0 ] && grep -q 'sin red' "${OUT_DIR}/startup.out" && [ "${TOOK}" -le 35 ]; then ok "T30 harness.js startup sale 0 y dice «sin red» en ${TOOK} s (tope 35)"
else no "T30 harness.js startup salió ${RC} en ${TOOK} s (tope 35) y dijo: $(head -c 300 "${OUT_DIR}/startup.out" | tr '\n' ' ')"; fi

fakes_check "T30"
scenario_end no-network
