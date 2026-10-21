#!/usr/bin/env bash
# unified.sh — la máquina NUEVA del equipo después de la unión de los dos repos internos (T37 y T39).
# Corre DENTRO del contenedor del núcleo (sólo los requisitos de la portada), lanzado con `--network none`, sobre un clon
# del repo unido INTERNO: la copia que sirve el desvío (COPY_DIR, en lib.sh) es el árbol de trabajo bajo prueba con su historia, tal como lo
# baja una máquina nueva; no pasó por el exportador.
#
# El alta es UN clon y UN comando, y esta prueba hace lo que haría un dev nuevo: ejecuta el bloque
# `<!-- install:internal -->` de INSTALL.md.
#   T39 · el bloque de INSTALL.md, tal cual. Lo único que se cambia es `<URL del arnés>` por la carpeta que sirve la
#         copia (la URL del equipo no está en el repo: vive en onboarding/datos-del-equipo.md, y acá no hay red).
#   T37 · lo que tiene que quedar: una fuente; los cuatro enlaces; las skills de terceros restituidas desde la historia
#         local, sin red; `doctor` sin rojos; ningún hook dos veces, tampoco después de llamar al instalador por el
#         enlace `~/.claude/tycon-harness`. Y un clon SIN `skills/` sale 1 con una línea, sin escribir nada.
# El perfil del equipo viene en el clon: las integraciones quedan PRENDIDAS y sus herramientas (az, engram, codex…) no
# están en la imagen. El instalador tiene que degradar y decirlo, no fallar: por eso acá no hay herramientas de mentira.
# Lo que NO mide: Windows, una sesión real de Claude Code, y el clon desde Azure DevOps (credenciales).
# uso: bash /opt/lab/scenarios/unified.sh
set -uo pipefail
. /opt/lab/lib.sh
mkdir -p "${OUT_DIR}"
echo "clean-machine: escenario unified · $(id -un) · HOME=${HOME} · un clon de ${COPY_DIR} (el repo unido interno) · sin red"

CLONE="${HOME}/SourceCode/tycon-claude-guides"       # donde lo deja el bloque de INSTALL.md
SETTINGS="${HOME}/.claude/settings.json"
BLOCK="${LAB_DIR}/blocks/install-internal.sh"        # el bloque <!-- install:internal -->, como lo extrajo el anfitrión

if [ -z "$(ls -A "${HOME}")" ]; then ok "T37 la HOME del contenedor arranca vacía"; else no "T37 la HOME del contenedor no arranca vacía: $(ls -A "${HOME}" | tr '\n' ' ')"; fi
# «sin red» medido adentro: con --network none el contenedor no tiene ninguna ruta. Mirar que la única
# interfaz sea la local daría rojo: en el motor de contenedores de Mac el núcleo trae además túneles apagados (tunl0,
# gre0, sit0…) que no llevan a ningún lado.
# La tabla de rutas del núcleo trae una línea de encabezado y, sin red, nada más.
if [ ! -r /proc/net/route ]; then no "T37 no pude leer la tabla de rutas del contenedor: «sin red» NO MEDIDO"
else
  ROUTES="$(tail -n +2 /proc/net/route | wc -l | tr -d ' ')"
  if [ "${ROUTES}" = "0" ]; then ok "T37 el contenedor no tiene red (ninguna ruta)"
  else no "T37 el contenedor tiene red (${ROUTES} ruta(s): $(tail -n +2 /proc/net/route | awk '{print $1}' | tr '\n' ' ')): «sin red» no se estaría midiendo"; fi
fi

# ── T39 · el bloque de INSTALL.md, tal cual ──────────────────────────────────────────────────────────────────
if [ ! -s "${BLOCK}" ]; then
  no "T39 no está el bloque <!-- install:internal --> de INSTALL.md (${BLOCK}): no hay qué ejecutar"
  scenario_end unified; exit 0
fi
PLACEHOLDER='<URL del arnés>'
sed -e "s#${PLACEHOLDER}#${COPY_DIR}#" "${BLOCK}" > "${OUT_DIR}/install-internal.sh"
N_CLONE="$(grep -c -E '^[[:space:]]*git clone ' "${OUT_DIR}/install-internal.sh" || true)"
if [ "${N_CLONE}" = 1 ] && grep -q -F "git clone ${COPY_DIR} " "${OUT_DIR}/install-internal.sh" && ! grep -q -F '<URL' "${OUT_DIR}/install-internal.sh"; then
  ok "T39 el bloque de INSTALL.md trae UN git clone, y su URL es lo único que se reemplaza (por la copia que sirve este contenedor)"
else no "T39 el bloque de INSTALL.md no trae exactamente un «git clone ${PLACEHOLDER} …» (encontré ${N_CLONE}): $(head -c 300 "${BLOCK}" | tr '\n' ' ')"; fi
# el bloque es para una persona en su terminal: `install` muestra el plan y pregunta
( cd "${WORK_DIR}" && pty_run s bash "${OUT_DIR}/install-internal.sh" ) > "${OUT_DIR}/install.out" 2>&1; RC=$?
if [ "${RC}" -eq 0 ] && [ -f "${CLONE}/scripts/setup/harness.js" ]; then ok "T39 el bloque <!-- install:internal --> de INSTALL.md, tal cual, sale 0 (un clon y harness.js install)"
else
  no "T39 el bloque <!-- install:internal --> de INSTALL.md salió ${RC}: $(tail -n 4 "${OUT_DIR}/install.out" | tr '\n' ' ' | head -c 400)"
  scenario_end unified; exit 0
fi

# ── T37 · lo que deja: una fuente, cuatro enlaces, terceros sin red, doctor, ningún hook dos veces ────────────
# una fuente (`harness`), con el origin del clon; y la política del perfil del equipo, que viene en el clon
V="$(json "${STATE_FILE}" '[d.mode, (d.sources || []).length, d.sources && d.sources[0] && d.sources[0].name, d.sources && d.sources[0] && d.sources[0].url].join("|")')"
if [ "${V}" = "managed|1|harness|$(git -C "${CLONE}" remote get-url origin)" ]; then ok "T37 el estado: managed, UNA fuente (harness) con el origin del clon"
else no "T37 el estado dice «${V:-ilegible}» (esperado «managed|1|harness|$(git -C "${CLONE}" remote get-url origin)»)"; fi
V="$(json "${STATE_FILE}" '[d.channel, d.policy && d.policy.apply].join("|")')"
if [ "${V}" = "latest|auto" ]; then ok "T37 la política es la del perfil del equipo, que viene en el clon (latest, auto)"
else no "T37 la política del estado es «${V:-ilegible}» (esperado «latest|auto»: el perfil del equipo viene en el clon)"; fi

BAD=""
# el enlace del arnés es el LUGAR (HARNESS_LINK): una máquina nueva no recibe el nombre viejo
# skills y agents: carpetas reales del dev con un enlace por entrada del clon
for name in "$(basename "${HARNESS_LINK}")" agent-skills; do
  if [ ! -L "${HOME}/.claude/${name}" ] || [ "$(real "${HOME}/.claude/${name}")" != "$(real "${CLONE}")" ]; then BAD="${BAD} ${name}"; fi
done
N=0
for sub in skills agents; do
  { [ -d "${HOME}/.claude/${sub}" ] && [ ! -L "${HOME}/.claude/${sub}" ]; } || BAD="${BAD} ${sub}(no es carpeta real)"
  for entry in "${CLONE}/${sub}"/*; do
    [ -e "${entry}" ] || continue
    e="$(basename "${entry}")"; link="${HOME}/.claude/${sub}/${e}"; N=$((N + 1))
    if [ ! -L "${link}" ] || [ ! -e "${link}" ] || [ "$(real "${link}")" != "$(real "${entry}")" ]; then BAD="${BAD} ${sub}/${e}"; fi
  done
done
[ "${N}" -gt 0 ] || BAD="${BAD} (el clon no tiene entradas)"
if [ -z "${BAD}" ]; then ok "T37 los enlaces existen y apuntan al clon (el lugar del arnés, agent-skills; skills y agents, carpetas reales con un enlace por entrada)"
else no "T37 enlaces que faltan o apuntan a otro lado:${BAD}"; fi
if [ -f "${HOME}/.claude/skills/tycon-pipeline/SKILL.md" ] && [ -n "$(ls "${HOME}/.claude/agents"/*.md 2>/dev/null | head -n 1)" ]; then
  ok "T37 las skills y los revisores se ven desde ~/.claude/skills y ~/.claude/agents (donde los busca Claude Code)"
else no "T37 ~/.claude/skills/tycon-pipeline/SKILL.md o los revisores de ~/.claude/agents no se ven"; fi

# las skills de terceros, desde la historia local: sólo se puede medir si el clon trae esa historia
read -r TP_ALL TP_HISTORY <<< "$(third_party_in_history "${CLONE}")"
if [ "${TP_ALL:-0}" -gt 0 ] && [ "${TP_HISTORY}" = "${TP_ALL}" ]; then
  read -r TP_TOTAL TP_MISSING TP_LOADS <<< "$(third_party "${CLONE}")"
  if [ "${TP_TOTAL:-0}" = "${TP_ALL}" ] && [ "${TP_MISSING}" = "-" ]; then ok "T37 las ${TP_TOTAL} skills de terceros del manifiesto quedaron en su lugar, restituidas desde la historia local (sin red)"
  else no "T37 skills de terceros: ${TP_TOTAL:-0} en el manifiesto; faltan: $(echo "${TP_MISSING:-?}" | head -c 300)"; fi
  if grep -q 'no pude preguntar al origen' "${OUT_DIR}/install.out" "${HOME}/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null; then
    no "T37 el paso de terceros quiso salir a la red (dijo «no pude preguntar al origen») teniendo todo en la historia local"
  else ok "T37 …y el paso de terceros no quiso salir a la red"; fi
  if [ -z "$(git -C "${CLONE}" status --porcelain)" ]; then ok "T37 …y el clon sigue limpio para git (lo restituido está ignorado: no traba la próxima actualización)"
  else no "T37 el clon quedó sucio después de instalar: $(git -C "${CLONE}" status --porcelain | head -n 3 | tr '\n' ' ')"; fi
else
  skip "T37 las skills de terceros desde la historia local: la historia de la copia trae ${TP_HISTORY:-0} de ${TP_ALL:-0} árboles del manifiesto (un clon recortado): no hay de dónde restituirlas sin red"
fi

node "${HARNESS_JS}" doctor --json > "${OUT_DIR}/doctor.json" 2> "${OUT_DIR}/doctor.err"
V="$(json "${OUT_DIR}/doctor.json" 'Array.isArray(d.fail) ? d.fail.length + "|" + d.fail.slice(0, 3).join(" · ") : "sin-lista"')"
if [ "${V}" = "0|" ]; then ok "T37 harness.js doctor --json no trae ningún fail"; else no "T37 harness.js doctor --json: ${V:-no es JSON} $(head -c 200 "${OUT_DIR}/doctor.err")"; fi

N="$(grep -c -x -F '@~/.claude/tycon-harness/INDEX.md' "${HOME}/.claude/CLAUDE.md" 2>/dev/null || true)"
L="$(json "${SETTINGS}" '((d.hooks && d.hooks.SessionStart) || []).reduce((a, m) => a + (m.hooks || []).filter((h) => /\.tycon-pipeline\/harness\/bootstrap\.js/.test(h.command || "")).length, 0)')"
if [ "${N:-0}" = 1 ] && [ "${L:-0}" = 1 ]; then ok "T37 el @import y la línea de arranque están una vez cada uno (nadie los escribió a mano)"
else no "T37 el @import aparece ${N:-0} veces y la línea de arranque ${L:-?} (esperado 1 y 1)"; fi

read -r HOOKS REPEATED <<< "$(hooks_census "${SETTINGS}")"
if [ "${HOOKS:-0}" -ge 20 ] && [ "${REPEATED}" = 0 ]; then ok "T37 settings.json: ${HOOKS} hooks, ninguno dos veces"
else no "T37 settings.json: ${HOOKS:-?} hooks, ${REPEATED:-?} repetido(s)"; fi

# llamado por el ENLACE (como lo nombran los papeles y la línea de arranque vieja): nada falta, nada se repite
bash "${HARNESS_LINK}/scripts/install-tycon-hooks.sh" --check > "${OUT_DIR}/check-link.out" 2>&1; RC=$?
if [ "${RC}" -eq 0 ] && ! grep -q 'hooks faltan' "${OUT_DIR}/check-link.out"; then ok "T37 el instalador por el enlace con --check: sale 0 y no dice que falte ningún hook"
else no "T37 el instalador por el enlace con --check salió ${RC}: $(grep 'hooks faltan' "${OUT_DIR}/check-link.out" | head -n 1 | head -c 200)"; fi
bash "${HARNESS_LINK}/scripts/install-tycon-hooks.sh" > "${OUT_DIR}/by-link.out" 2>&1; RC=$?
read -r HOOKS_AFTER REPEATED <<< "$(hooks_census "${SETTINGS}")"
if [ "${RC}" -eq 0 ] && [ "${REPEATED}" = 0 ] && [ "${HOOKS_AFTER}" = "${HOOKS}" ]; then ok "T37 el instalador por el enlace no registra nada por segunda vez (${HOOKS_AFTER} hooks, 0 repetidos)"
else no "T37 el instalador por el enlace (exit ${RC}) dejó ${HOOKS_AFTER:-?} hooks (había ${HOOKS:-?}), ${REPEATED:-?} repetido(s): $(grep 'instalé' "${OUT_DIR}/by-link.out" | head -n 1 | head -c 200)"; fi
bash "${CLONE}/scripts/install-tycon-hooks.sh" > "${OUT_DIR}/by-clone.out" 2>&1; RC=$?
read -r HOOKS_AFTER REPEATED <<< "$(hooks_census "${SETTINGS}")"
if [ "${RC}" -eq 0 ] && [ "${REPEATED}" = 0 ] && [ "${HOOKS_AFTER}" = "${HOOKS}" ]; then ok "T37 (espejo) …y por la carpeta del clon, tampoco"
else no "T37 el instalador por la carpeta del clon (exit ${RC}) dejó ${HOOKS_AFTER:-?} hooks (había ${HOOKS:-?}), ${REPEATED:-?} repetido(s)"; fi

# ── T37 (error) · un clon SIN skills/ y sin ~/.claude/agent-skills: 1, una línea, nada escrito ────────────────
EMPTY_HOME=/tmp/empty-home; BARE_CLONE="${WORK_DIR}/no-skills"; mkdir -p "${EMPTY_HOME}"
if git clone -q "${COPY_DIR}" "${BARE_CLONE}" > "${OUT_DIR}/no-skills-clone.out" 2>&1; then
  for d in skills agents packs; do
    if [ -e "${BARE_CLONE}/${d}" ]; then git -C "${BARE_CLONE}" rm -r -q "${d}" >> "${OUT_DIR}/no-skills-clone.out" 2>&1; fi
  done
  git -C "${BARE_CLONE}" -c user.name=lab -c user.email=lab@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q -m 'lab: un clon sin skills/' >> "${OUT_DIR}/no-skills-clone.out" 2>&1
  HOME="${EMPTY_HOME}" node "${BARE_CLONE}/scripts/setup/harness.js" install > "${OUT_DIR}/no-skills.out" 2>&1; RC=$?
  LINES="$(grep -c . "${OUT_DIR}/no-skills.out" || true)"
  if [ ! -e "${BARE_CLONE}/skills" ] && [ "${RC}" -eq 1 ] && [ "${LINES}" = 1 ] && grep -q 'agent-skills' "${OUT_DIR}/no-skills.out"; then
    ok "T37 (error) un clon sin skills/ y sin ~/.claude/agent-skills: harness.js install sale 1 con UNA línea que nombra agent-skills"
  else no "T37 (error) un clon sin skills/ salió ${RC} con ${LINES} línea(s): $(head -c 300 "${OUT_DIR}/no-skills.out" | tr '\n' ' ')"; fi
  if [ -z "$(ls -A "${EMPTY_HOME}")" ]; then ok "T37 (error) …y sin escribir nada: esa HOME sigue vacía"
  else no "T37 (error) escribió en la HOME: $(ls -A "${EMPTY_HOME}" | tr '\n' ' ')"; fi
else
  no "T37 (error) no pude clonar la copia para armar el clon sin skills/: $(tail -n 2 "${OUT_DIR}/no-skills-clone.out" | tr '\n' ' ')"
fi

scenario_end unified
