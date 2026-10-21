#!/usr/bin/env bash
# npx.sh — el instalador del paquete de npm en una máquina limpia de Linux (T46). Corre
# DENTRO del contenedor del núcleo, lanzado con `--network none`: el «GitHub» es el de juguete
# (scripts/tests/fixtures/toy-release-server.js) sirviendo la copia, en el mismo contenedor.
#   T46 · el paquete armado con `npm pack` y corrido con `npx --package <tgz> tycon-harness … --yes` con un PATH SIN git:
#         instala (estado `release`, ~/.tycon/harness), `doctor --json` sin rojos, ~/.claude/skills con enlaces reales;
#         y una segunda corrida sobre la misma HOME dice «al día» sin bajar nada.
# uso: bash /opt/lab/scenarios/npx.sh
set -uo pipefail
. /opt/lab/lib.sh
scenario_begin npx

N="/tmp/npx-lab"; mkdir -p "${N}/pkg" "${N}/nogit" || { no "T46 no pude armar la carpeta del escenario"; scenario_end npx; exit 0; }
GIT_BIN="$(command -v git)"
# el paquete, como lo arma el workflow que publica: la carpeta del paquete más LICENSE
for f in package.json index.js home-paths.json README.md; do cp "${COPY_DIR}/scripts/setup/npm/${f}" "${N}/pkg/" || { no "T46 la copia no trae scripts/setup/npm/${f}"; scenario_end npx; exit 0; }; done
cp "${COPY_DIR}/LICENSE" "${N}/pkg/LICENSE"
export npm_config_cache="${N}/npm-cache" npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false npm_config_offline=true
TGZ="$( cd "${N}/pkg" && npm pack --silent --pack-destination "${N}" 2> "${OUT_DIR}/npx-pack.err" | tail -n 1 )"
if [ -z "${TGZ}" ] || [ ! -f "${N}/${TGZ}" ]; then no "T46 npm pack no armó el paquete: $(tail -n 2 "${OUT_DIR}/npx-pack.err" | tr '\n' ' ')"; scenario_end npx; exit 0; fi
TGZ="${N}/${TGZ}"
# el GitHub de juguete, sobre un clon pelado de la copia
"${GIT_BIN}" clone -q --bare "${COPY_DIR}" "${N}/harness.git" || { no "T46 no pude clonar la copia para el GitHub de juguete"; scenario_end npx; exit 0; }
printf '{ "auth": "none" }\n' > "${N}/control.json"
node "${COPY_DIR}/scripts/tests/fixtures/toy-release-server.js" --repo "${N}/harness.git" --org example-org --name example-harness \
  --git "${GIT_BIN}" --control "${N}/control.json" --log "${N}/requests.log" --port-file "${N}/ports.env" > "${OUT_DIR}/npx-server.out" 2>&1 &
SERVER=$!
for _ in $(seq 1 100); do [ -f "${N}/ports.env" ] && break; sleep 0.1; done
if [ ! -f "${N}/ports.env" ]; then no "T46 el GitHub de juguete no arrancó: $(tail -n 2 "${OUT_DIR}/npx-server.out" | tr '\n' ' ')"; scenario_end npx; exit 0; fi
export TYCON_RELEASE_API="$(sed -n 's/^API=//p' "${N}/ports.env")" TYCON_RELEASE_GIT="$(sed -n 's/^GIT=//p' "${N}/ports.env")" TYCON_RELEASE_ARCHIVE="$(sed -n 's/^CODELOAD=//p' "${N}/ports.env")"
export TYCON_THIRD_PARTY=0
# un PATH sin git: todo lo que hay en el contenedor, menos git (la instalación por npx no lo necesita)
for d in /usr/local/bin /usr/bin /bin; do for f in "${d}"/*; do b="$(basename "${f}")"; [ "${b}" = git ] && continue; [ -e "${N}/nogit/${b}" ] || ln -s "${f}" "${N}/nogit/${b}"; done; done
# --tool claude: el contenedor no trae Claude Code ni Codex, e install pide elegir qué enchufar
npx_run() { PATH="${N}/nogit" npx --yes --package "${TGZ}" tycon-harness --repo example-org/example-harness --tool claude --profile minimal --integrations none --packs none --yes < /dev/null; }

npx_run > "${OUT_DIR}/npx-install.out" 2>&1; RC=$?
STATE=""; for s in "${HOME}/.tycon/state/harness-state.json" "${HOME}/.claude/.tycon-pipeline/harness-state.json"; do [ -f "${s}" ] && STATE="${s}" && break; done
KIND="$( [ -n "${STATE}" ] && json "${STATE}" '(d.sources.find((x) => x.name === "harness") || {}).kind' )"
if [ "${RC}" -eq 0 ] && [ "${KIND}" = release ] && [ -f "${HOME}/.tycon/harness/scripts/setup/harness.js" ]; then
  ok "T46 npx --package <tgz> tycon-harness instala en una máquina limpia sin git (estado release, ~/.tycon/harness)"
else
  no "T46 la instalación por npx salió ${RC} (estado ${KIND:-ninguno}): $(tail -n 4 "${OUT_DIR}/npx-install.out" | tr '\n' ' ')"
  kill "${SERVER}" 2>/dev/null; scenario_end npx; exit 0
fi
PATH="${N}/nogit" node "${HOME}/.tycon/harness/scripts/setup/harness.js" doctor --json > "${OUT_DIR}/npx-doctor.json" 2> "${OUT_DIR}/npx-doctor.err"; RC=$?
FAILS="$(json "${OUT_DIR}/npx-doctor.json" 'Array.isArray(d.fail) ? d.fail.length : "ilegible"')"
if [ "${RC}" -eq 0 ] && [ "${FAILS}" = 0 ]; then ok "T46 doctor sin rojos después de instalar por npx"
else no "T46 doctor salió ${RC} con ${FAILS} rojo(s): $(head -c 400 "${OUT_DIR}/npx-doctor.json")"; fi
BAD=""; N_LINKS=0
for l in "${HOME}/.claude/skills"/*; do [ -e "${l}" ] || [ -L "${l}" ] || continue; N_LINKS=$((N_LINKS + 1)); { [ -L "${l}" ] && [ -e "${l}" ]; } || BAD="${BAD} $(basename "${l}")"; done
if [ -d "${HOME}/.claude/skills" ] && [ ! -L "${HOME}/.claude/skills" ] && [ "${N_LINKS}" -gt 0 ] && [ -z "${BAD}" ]; then ok "T46 ~/.claude/skills es una carpeta real con ${N_LINKS} enlace(s) que resuelven"
else no "T46 ~/.claude/skills (${N_LINKS} entradas; rotas o no enlaces:${BAD:- ninguna})"; fi
# la segunda corrida, sobre la misma HOME: «al día», sin instalar ni actualizar nada. El paquete baja la punta siempre
# (decide el instalador del árbol bajado): lo que se mide es que el estado del arnés instalado no cambie.
STATE="$(find "${HOME}/.tycon" "${HOME}/.claude" -name harness-state.json -type f 2>/dev/null | head -n 1)"
before="$([ -n "${STATE}" ] && cksum < "${STATE}" || echo sin-estado)"
npx_run > "${OUT_DIR}/npx-again.out" 2>&1; RC=$?
after="$([ -n "${STATE}" ] && cksum < "${STATE}" || echo sin-estado)"
if [ "${RC}" -eq 0 ] && grep -q 'al día' "${OUT_DIR}/npx-again.out" && grep -q 'No cambié nada' "${OUT_DIR}/npx-again.out" && [ -n "${STATE}" ] && [ "${before}" = "${after}" ]; then ok "T46 la segunda ejecución sobre la misma máquina dice «al día» y no instala ni actualiza nada"
else no "T46 la segunda corrida salió ${RC} (estado del arnés: ${STATE:-no encontrado}; ${before} → ${after}): $(tail -n 3 "${OUT_DIR}/npx-again.out" | tr '\n' ' ')"; fi
kill "${SERVER}" 2>/dev/null
scenario_end npx
