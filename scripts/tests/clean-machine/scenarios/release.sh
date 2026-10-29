#!/usr/bin/env bash
# release.sh — la portada SIN git en una máquina limpia de Linux que tiene UNA sola herramienta (T36, la parte Linux).
# Corre DENTRO del contenedor del núcleo, lanzado con `--network none`: el «GitHub» es el de juguete
# (scripts/tests/fixtures/toy-release-server.js) sirviendo la copia en el mismo contenedor, con el org y el nombre que
# trae la portada (blocks/release-repo.txt), porque get-harness.sh pide ese repo.
#   T36 · el bloque `install:unattended` de la portada, tal cual salvo la dirección de raw (la del juguete), con un PATH
#         SIN git y con sólo `claude` o sólo `codex` (de juguete) en el PATH: sale 0, deja el estado `release` en
#         ~/.tycon, enchufa SÓLO esa herramienta y `doctor --json` no tiene rojos. Con sólo Codex no aparece nada de
#         Claude Code (~/.claude ni ~/.claude.json) y Codex recibe sus reglas en AGENTS.md; con sólo Claude Code,
#         settings.json trae la línea de arranque y Codex no recibe nada.
# uso: bash /opt/lab/scenarios/release.sh claude|codex
set -uo pipefail
. /opt/lab/lib.sh
TOOL="${1:-}"
case "${TOOL}" in claude|codex) ;; *) echo "uso: release.sh claude|codex"; exit 2 ;; esac
OTHER=codex; [ "${TOOL}" = codex ] && OTHER=claude
NAME="release-${TOOL}"
scenario_begin "${NAME}"
T="T36 (sólo ${TOOL})"

if [ -z "$(ls -A "${HOME}")" ]; then ok "${T} la HOME del contenedor arranca vacía"; else no "${T} la HOME del contenedor no arranca vacía: $(ls -A "${HOME}" | tr '\n' ' ')"; fi

N="/tmp/release-lab"; mkdir -p "${N}/path" "${N}/tool" || { no "${T} no pude armar la carpeta del escenario"; scenario_end "${NAME}"; exit 0; }
GIT_BIN="$(command -v git)"
REPO="$(cat "${LAB_DIR}/blocks/release-repo.txt" 2> /dev/null)"
case "${REPO}" in */*) ;; *) no "${T} el anfitrión no dejó el repo de la portada (blocks/release-repo.txt)"; scenario_end "${NAME}"; exit 0 ;; esac
# el GitHub de juguete, sobre un clon pelado de la copia
"${GIT_BIN}" clone -q --bare "${COPY_DIR}" "${N}/harness.git" || { no "${T} no pude clonar la copia para el GitHub de juguete"; scenario_end "${NAME}"; exit 0; }
printf '{ "auth": "none" }\n' > "${N}/control.json"
node "${COPY_DIR}/scripts/tests/fixtures/toy-release-server.js" --repo "${N}/harness.git" --org "${REPO%%/*}" --name "${REPO#*/}" \
  --git "${GIT_BIN}" --control "${N}/control.json" --log "${N}/requests.log" --port-file "${N}/ports.env" > "${OUT_DIR}/${NAME}-server.out" 2>&1 &
SERVER=$!
trap 'kill "${SERVER}" 2> /dev/null' EXIT
for _ in $(seq 1 100); do [ -f "${N}/ports.env" ] && break; sleep 0.1; done
if [ ! -f "${N}/ports.env" ]; then no "${T} el GitHub de juguete no arrancó: $(tail -n 2 "${OUT_DIR}/${NAME}-server.out" | tr '\n' ' ')"; scenario_end "${NAME}"; exit 0; fi
export TYCON_RELEASE_API="$(sed -n 's/^API=//p' "${N}/ports.env")" TYCON_RELEASE_GIT="$(sed -n 's/^GIT=//p' "${N}/ports.env")" TYCON_RELEASE_ARCHIVE="$(sed -n 's/^CODELOAD=//p' "${N}/ports.env")"
TOY_RAW="$(sed -n 's/^RAW=//p' "${N}/ports.env")"
# la herramienta de juguete: un ejecutable con su nombre en el PATH, que es lo que mira la detección
printf '#!/bin/sh\necho "%s 0.0.0 (de juguete)"\n' "${TOOL}" > "${N}/tool/${TOOL}" && chmod +x "${N}/tool/${TOOL}"
# un PATH sin git: todo lo del contenedor menos git (y menos la otra herramienta, que la imagen no trae)
for d in /usr/local/bin /usr/bin /bin; do for f in "${d}"/*; do b="$(basename "${f}")"; [ "${b}" = git ] && continue; [ -e "${N}/path/${b}" ] || ln -s "${f}" "${N}/path/${b}"; done; done
P="${N}/tool:${N}/path"
if PATH="${P}" command -v git > /dev/null 2>&1 || PATH="${P}" command -v "${OTHER}" > /dev/null 2>&1; then
  no "${T} el PATH armado todavía trae git o ${OTHER}: la medición no vale"; scenario_end "${NAME}"; exit 0
fi

# el bloque de la portada, tal cual salvo la dirección de raw
sed "s#https://raw.githubusercontent.com#${TOY_RAW}#" "${LAB_DIR}/blocks/install-release.sh" > "${N}/block.sh"
( cd "${WORK_DIR}" && PATH="${P}" TYCON_THIRD_PARTY=0 bash "${N}/block.sh" ) < /dev/null > "${OUT_DIR}/${NAME}.out" 2>&1; RC=$?
STATE=""; for s in "${HOME}/.tycon/state/harness-state.json" "${HOME}/.claude/.tycon-pipeline/harness-state.json"; do [ -f "${s}" ] && STATE="${s}" && break; done
KIND="$( [ -n "${STATE}" ] && json "${STATE}" '(d.sources.find((x) => x.name === "harness") || {}).kind' )"
if [ "${RC}" -eq 0 ] && [ "${KIND}" = release ] && [ -f "${HOME}/.tycon/harness/scripts/setup/harness.js" ]; then
  ok "${T} el bloque install:unattended de la portada, sin git, instala desde el GitHub de juguete (estado release, ~/.tycon/harness)"
else
  no "${T} el bloque install:unattended salió ${RC} (estado ${KIND:-ninguno}): $(tail -n 4 "${OUT_DIR}/${NAME}.out" | tr '\n' ' ')"
  kill "${SERVER}" 2> /dev/null; scenario_end "${NAME}"; exit 0
fi

TOOLS_SET="$(json "${STATE}" 'Array.isArray(d.tools) ? d.tools.join(",") : "sin dato"')"
if [ "${TOOLS_SET}" = "${TOOL}" ]; then ok "${T} el estado enchufa sólo ${TOOL}, la que encontró en el PATH"
else no "${T} el estado enchufa «${TOOLS_SET}» (esperado sólo ${TOOL})"; fi

if [ "${TOOL}" = codex ]; then
  if [ ! -e "${HOME}/.claude" ] && [ ! -e "${HOME}/.claude.json" ]; then ok "${T} no apareció nada de Claude Code: ni ~/.claude ni ~/.claude.json"
  else no "${T} apareció $( [ -e "${HOME}/.claude" ] && echo "~/.claude ($(ls -A "${HOME}/.claude" | head -n 5 | tr '\n' ' '))" || echo '~/.claude.json') en una máquina sólo con Codex"; fi
  if grep -qF '<!-- TYCON_BLOCK:' "${HOME}/.codex/AGENTS.md" 2> /dev/null; then ok "${T} Codex recibió sus reglas en ~/.codex/AGENTS.md"
  else no "${T} ~/.codex/AGENTS.md no trae los bloques del arnés ($( [ -f "${HOME}/.codex/AGENTS.md" ] && echo 'está sin ellos' || echo 'no está'))"; fi
else
  # la marca de la línea de arranque es la que mira health.js; «bootstrap» solo también matchea el hook de reparación
  if grep -qF '.tycon-pipeline/harness/bootstrap.js' "${HOME}/.claude/settings.json" 2> /dev/null; then ok "${T} ~/.claude/settings.json trae la línea de arranque del arnés"
  else no "${T} ~/.claude/settings.json no trae la línea de arranque ($( [ -f "${HOME}/.claude/settings.json" ] && echo 'está sin ella' || echo 'no está'))"; fi
  if [ ! -e "${HOME}/.codex/AGENTS.md" ]; then ok "${T} Codex no recibió nada: no hay ~/.codex/AGENTS.md"
  else no "${T} apareció ~/.codex/AGENTS.md en una máquina sólo con Claude Code"; fi
fi

PATH="${P}" node "${HOME}/.tycon/harness/scripts/setup/harness.js" doctor --json > "${OUT_DIR}/${NAME}-doctor.json" 2> "${OUT_DIR}/${NAME}-doctor.err"; RC=$?
FAILS="$(json "${OUT_DIR}/${NAME}-doctor.json" 'Array.isArray(d.fail) ? d.fail.length : "ilegible"')"
if [ "${RC}" -eq 0 ] && [ "${FAILS}" = 0 ]; then ok "${T} doctor sin rojos después de instalar sin git"
else no "${T} doctor salió ${RC} con ${FAILS} rojo(s): $(head -c 400 "${OUT_DIR}/${NAME}-doctor.json")"; fi
kill "${SERVER}" 2> /dev/null
scenario_end "${NAME}"
