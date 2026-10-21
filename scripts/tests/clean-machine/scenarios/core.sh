#!/usr/bin/env bash
# core.sh — el núcleo, como de afuera, con red (corre DENTRO del contenedor del núcleo; lo lanza clean-machine.test.sh).
#   T24 · la imagen trae lo que la portada declara y nada de la lista vigilada.
#   T26 (variante 1, HOME vacía) · el bloque `install:core` tal cual: los cuatro enlaces, el estado, la línea de
#         arranque, la copia fija, version (la estampada), doctor, el @import y los bloques, --check sin faltantes, los
#         hooks de arranque callados, las ocho integraciones apagadas, la auditoría sin faltantes; una versión nueva
#         servida por la copia, que `startup` no aplica y avisa (T34); y `uninstall --yes`.
#   T27 · el esqueleto mecánico del pipeline sobre el repo de ejemplo.
#   T29 · el núcleo solo frente a un repo que pide el paquete (sólo en modo interno: en la copia pública el paquete está).
# uso: bash /opt/lab/scenarios/core.sh internal|public
set -uo pipefail
. /opt/lab/lib.sh
MODE="${1:-internal}"
scenario_begin core

requirements_check "T24 (núcleo)" ""
fakes_setup ${WATCHED} dotnet curl wget launchctl open

# ── T26 · el bloque de la portada, sobre una HOME vacía ──────────────────────────────────────────────────────
if [ -z "$(ls -A "${HOME}")" ]; then ok "T26 la HOME del contenedor arranca vacía"; else no "T26 la HOME del contenedor no arranca vacía: $(ls -A "${HOME}" | tr '\n' ' ')"; fi
serve_copy
# T25 y T51: sin terminal, el bloque tal cual sale 2 sin escribir nada bajo ~/.claude, antes del plan: pide el perfil
# (sin terminal no pregunta, y no hay uno por defecto)
run_block core "${OUT_DIR}/install-notty.out" < /dev/null; RC=$?
if [ "${RC}" -eq 2 ] && [ ! -e "${HOME}/.claude" ] && grep -q 'elegí el perfil' "${OUT_DIR}/install-notty.out"; then
  ok "T51 el bloque install:core sin terminal: pide el perfil, sale 2 y no escribe nada bajo ~/.claude"
else no "T25 el bloque install:core sin terminal salió ${RC} ($( [ -e "${HOME}/.claude" ] && echo 'escribió ~/.claude' || echo 'sin ~/.claude' )): $(tail -n 3 "${OUT_DIR}/install-notty.out" | tr '\n' ' ')"; fi
find_clone && rm -rf "${CLONE}"   # el bloque vuelve a clonar: tal cual, en la carpeta de antes
# …y en una terminal de juguete, contestando como una persona: perfil full, ninguna integración, paquete no, y sí
run_block_pty core "${OUT_DIR}/install.out" "${ANSWERS_FULL}"; RC=$?
if [ "${RC}" -eq 0 ] && find_clone && grep -q '¿Qué perfil instalo?' "${OUT_DIR}/install.out" && grep -q '¿Qué integraciones prendo?' "${OUT_DIR}/install.out" \
   && grep -q 'paquete del stack en todos tus repos' "${OUT_DIR}/install.out" && grep -q '¿Instalo? \[s/N\]' "${OUT_DIR}/install.out"; then
  ok "T51 el bloque install:core de la portada, tal cual, en una terminal: las tres preguntas y la conformidad, y sale 0"
else
  no "T26 el bloque install:core salió ${RC}: $(tail -n 4 "${OUT_DIR}/install.out" | tr '\n' ' ')"
  fakes_check "T26"; scenario_end core; exit 0
fi

# los cuatro enlaces, cada uno a su lugar del clon. El del arnés es el LUGAR (HARNESS_LINK): una máquina nueva no
# recibe el nombre viejo (LEGACY_FOR_NEW_MACHINES en canonical-path.js).
# skills y agents son carpetas reales del dev, con un enlace por cada entrada del clon: lo que Claude Code
# sincroniza y lo que el dev crea no cae adentro del arnés
BAD=""
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
if [ -z "${BAD}" ]; then ok "T26 los enlaces existen y apuntan al clon (el lugar del arnés, agent-skills; skills y agents, carpetas reales con un enlace por entrada)"
else no "T26 enlaces que faltan o apuntan a otro lado:${BAD}"; fi
check_install "T26"
# lo contestado (T51): full, ninguna integración ni el paquete escritos
V="$(json "${HOME}/.claude/tycon.json" 'JSON.stringify(d)')"
if [ "${V}" = '{"install":{"profile":"full"}}' ]; then ok "T51 tycon.json guarda sólo el perfil contestado (full): ninguna integración, paquete sin tocar"
else no "T51 tycon.json después de contestar: ${V:-ilegible}"; fi

# ── T27 · el esqueleto mecánico del pipeline sobre el repo de ejemplo ────────────────────────────────────────
export TYCON_SESSION_ID="clean-machine-core"
R="${WORK_DIR}/example-repo"; STORY="${R}/specs/story-1.1-greeting.md"
if make_example_repo "${R}"; then
  node "${HARNESS_LINK}/scripts/lib/lint-story-frontmatter.js" "${STORY}" > "${OUT_DIR}/lint.out" 2>&1; RC=$?
  if [ "${RC}" -eq 0 ]; then ok "T27 lint-story-frontmatter.js sale 0 sobre la story del repo de ejemplo"; else no "T27 lint-story-frontmatter.js salió ${RC}: $(tail -n 2 "${OUT_DIR}/lint.out" | tr '\n' ' ')"; fi

  ( cd "${R}" && node "${PIPE_DIR}/pipeline.js" start --story "${STORY}" --repo "${R}" ) > "${OUT_DIR}/start.json" 2> "${OUT_DIR}/start.err"; RC=$?
  if [ "${RC}" -eq 0 ] && [ "$(json "${OUT_DIR}/start.json" 'd.ready')" = true ]; then ok "T27 pipeline.js start sale 0 con ready: true"
  else no "T27 pipeline.js start salió ${RC}: $(json "${OUT_DIR}/start.json" 'JSON.stringify(d.pauses || d.error || d)' | head -c 300) $(head -c 200 "${OUT_DIR}/start.err")"; fi

  ( cd "${R}" && node "${PIPE_DIR}/pipeline.js" mech-check --repo "${R}" --story "${STORY}" ) > "${OUT_DIR}/mech.json" 2> "${OUT_DIR}/mech.err"; RC=$?
  V="$(json "${OUT_DIR}/mech.json" '(d.findings || []).filter((f) => f.severity === "CRITICAL").length')"
  if [ "${RC}" -eq 0 ] && [ "${V}" = 0 ]; then ok "T27 pipeline.js mech-check sale 0 sin hallazgos CRITICAL"
  else no "T27 pipeline.js mech-check salió ${RC} con ${V:-?} CRITICAL: $(json "${OUT_DIR}/mech.json" '(d.findings || []).map((f) => f.rule + " " + f.detail).join(" · ")' | head -c 300)"; fi

  ( cd "${R}" && node "${PIPE_DIR}/pipeline.js" advisors --repo "${R}" --story "${STORY}" --files src/greeting.js test/greeting.test.js ) > "${OUT_DIR}/advisors.json" 2> "${OUT_DIR}/advisors.err"; RC=$?
  # `packs` es una lista de objetos. Los revisores del paquete son los `tycon-plugin-*-conventions`:
  # `tycon-plugin-tests-coverage` y `tycon-plugin-security-basics` son del núcleo, aunque se llamen parecido.
  V="$(json "${OUT_DIR}/advisors.json" '(d.packs || ["sin-lista"]).length + "|" + (d.all || []).filter((a) => /^tycon-plugin-.*-conventions$/.test(a)).join(",")')"
  if [ "${RC}" -eq 0 ] && [ "${V}" = "0|" ]; then ok "T27 pipeline.js advisors sale 0 con packs vacía y ningún revisor del paquete"
  else no "T27 pipeline.js advisors salió ${RC}; packs y revisores del paquete: «${V:-ilegible}» $(head -c 300 "${OUT_DIR}/advisors.err" | tr '\n' ' ')"; fi

  bash "${PIPE_DIR}/test-gate.sh" "${R}" "${STORY}" > "${OUT_DIR}/gate.out" 2>&1; RC=$?
  V="$(json "${R}/.advisors/tests-result.json" '[d.runner, d.suite_green, d.totals && d.totals.total > 0 && d.totals.passed === d.totals.total && d.totals.failed === 0].join("|")')"
  if [ "${RC}" -eq 0 ] && [ "${V}" = "node-test|true|true" ]; then ok "T27 test-gate.sh sale 0 y deja tests-result.json con el runner de node --test y todas las pruebas verdes"
  else no "T27 test-gate.sh salió ${RC}; tests-result.json dice «${V:-no está}» (esperado node-test|true|true): $(tail -n 3 "${OUT_DIR}/gate.out" | tr '\n' ' ')"; fi

  read -r TP_TOTAL TP_MISSING TP_LOADS <<< "$(third_party "${CLONE}")"
  if [ "${TP_TOTAL:-0}" -gt 0 ] && [ "${TP_MISSING}" = "-" ] && [ "${TP_LOADS}" = "-" ]; then ok "T27 las ${TP_TOTAL} skills de terceros del manifiesto de la copia están instaladas, y las que cada una carga también"
  else no "T27 skills de terceros: ${TP_TOTAL:-0} en el manifiesto de la copia; faltan: $(echo "${TP_MISSING:-?}" | head -c 300); cargan una que no está: $(echo "${TP_LOADS:-?}" | head -c 200)"; fi

  ( cd "${R}" && node "${PIPE_DIR}/pipeline.js" tooling-expected --repo "${R}" ) > "${OUT_DIR}/tooling.json" 2> "${OUT_DIR}/tooling.err"; RC=$?
  V="$(json "${OUT_DIR}/tooling.json" '(d.expected || []).filter((e) => e.present === false || e.name === "engram").map((e) => e.name).join(",")')"
  if [ "${RC}" -eq 0 ] && [ -z "${V}" ] && [ -s "${OUT_DIR}/tooling.json" ]; then ok "T27 pipeline.js tooling-expected no nombra nada faltante ni espera lo de una integración apagada"
  else no "T27 pipeline.js tooling-expected salió ${RC}; faltantes o de una integración apagada: ${V:-ilegible}"; fi
else
  no "T27 no pude armar el repo de ejemplo en ${R}"
fi

# ── T29 · el núcleo solo frente a un repo que pide el paquete ────────────────────────────────────────────────
# (la copia no trae paquetes —llegan con el perfil de cada equipo—, así que se mide en los dos modos)
A="${WORK_DIR}/asks-pack"
FIXED='el repo declara el paquete «bizuit» en `packs:` y no está instalado en '
DOC='el repo declara el paquete «<nombre>» en `packs:` y no está instalado en '
if make_example_repo "${A}" && mkdir -p "${A}/.tycon" && printf 'packs: [bizuit]\n' >> "${A}/.tycon/advisors.yaml"; then
  ( cd "${A}" && TYCON_SESSION_ID="clean-machine-core-pack" node "${PIPE_DIR}/pipeline.js" advisors --repo "${A}" --story "${A}/specs/story-1.1-greeting.md" --files src/greeting.js ) > "${OUT_DIR}/t29.out" 2> "${OUT_DIR}/t29.err"; RC=$?
  if [ "${RC}" -eq 2 ] && grep -q -F "${FIXED}" "${OUT_DIR}/t29.err" && grep -q -F "${DOC}" "${CLONE}/getting-started/reference.md"; then
    ok "T29 el núcleo solo, frente a un repo con packs: [bizuit], sale 2 con el mensaje que la referencia muestra"
  else no "T29 pipeline.js advisors salió ${RC} (esperado 2), o su mensaje no es el de la referencia: $(tail -n 2 "${OUT_DIR}/t29.err" | tr '\n' ' ' | head -c 300)"; fi
else
  no "T29 no pude armar el repo que pide el paquete en ${A}"
fi

# ── T26 · una versión nueva servida por la copia: con la política ask, startup no la aplica y avisa ───────────
# Es T34. Va DESPUÉS de check_install: ahí los hooks de arranque tienen que callar, y con una versión
# pendiente `startup` imprime el aviso, que está bien. Mide «ask no aplica y avisa»; el camino del clon público (la rama
# propia, no bajar de número) lo mide harness-channel.test.sh: acá el remoto que ve el programa es una carpeta local.
HEAD_BEFORE="$(git -C "${CLONE}" rev-parse HEAD)"; COMMIT_BEFORE="$(json "${STATE_FILE}" 'd.sources[0].commit')"
if serve_new_version > "${OUT_DIR}/new-version.out" 2>&1 && forget_last_fetch >> "${OUT_DIR}/new-version.out" 2>&1 \
   && [ "$(git -C "${COPY_DIR}" rev-parse HEAD)" != "${HEAD_BEFORE}" ]; then
  node "${HARNESS_JS}" startup > "${OUT_DIR}/startup-new.out" 2>&1; RC=$?
  HEAD_AFTER="$(git -C "${CLONE}" rev-parse HEAD)"; COMMIT_AFTER="$(json "${STATE_FILE}" 'd.sources[0].commit')"
  NOTICE="$(json "${STATE_FILE}" 'd.notice || ""')"
  if [ "${RC}" -eq 0 ] && [ "${HEAD_AFTER}" = "${HEAD_BEFORE}" ]; then ok "T26 (versión nueva) con una versión nueva${NEW_VERSION:+ (${NEW_VERSION})} servida por la copia y la política ask, harness.js startup sale 0 y no la aplica: el HEAD del clon no cambió"
  else no "T26 (versión nueva) harness.js startup salió ${RC} y el HEAD del clon pasó de ${HEAD_BEFORE:0:7} a ${HEAD_AFTER:0:7} (con la política ask no se aplica): $(tail -n 3 "${OUT_DIR}/startup-new.out" | tr '\n' ' ' | head -c 300)"; fi
  # (un sha de verdad antes: sin eso, dos lecturas fallidas del estado serían «iguales»)
  SHA_RE='^[0-9a-f]{40,64}$'
  if [[ "${COMMIT_BEFORE}" =~ ${SHA_RE} ]] && [ "${COMMIT_AFTER}" = "${COMMIT_BEFORE}" ]; then ok "T26 (versión nueva) el commit de la fuente en el estado no cambió (${COMMIT_BEFORE:0:7})"
  else no "T26 (versión nueva) el commit de la fuente en el estado pasó de «${COMMIT_BEFORE:0:12}» a «${COMMIT_AFTER:0:12}» (tiene que ser un sha, y con la política ask no se registra otra versión)"; fi
  # el aviso, por partes: que hay una versión disponible, y cómo aplicarla
  BAD=""
  case "${NOTICE}" in *disponible*) ;; *) BAD="${BAD} «disponible»" ;; esac
  case "${NOTICE}" in *"update --yes"*) ;; *) BAD="${BAD} «update --yes»" ;; esac
  if [ -z "${BAD}" ]; then ok "T26 (versión nueva) el aviso que queda en el estado (notice) dice que hay una versión disponible y cómo aplicarla (update --yes)"
  else no "T26 (versión nueva) al aviso del estado (notice) le falta:${BAD} — dice «$(echo "${NOTICE}" | head -c 300)»; startup dijo: $(tail -n 2 "${OUT_DIR}/startup-new.out" | tr '\n' ' ' | head -c 300)"; fi
else
  no "T26 (versión nueva) no pude servir una versión nueva desde la copia (${COPY_DIR}) o soltar el sello de la última mirada: $(tail -n 3 "${OUT_DIR}/new-version.out" | tr '\n' ' ' | head -c 300)"
fi

# ── T26 · al final de la variante, uninstall deja la máquina como estaba ─────────────────────────────────────
uninstall_keeps_clone "T26"
S="${HOME}/.claude/settings.json"; C="${HOME}/.claude/CLAUDE.md"
# la HOME no tenía ninguno de los dos: vuelven a no estar, o quedan vacíos (sin hooks, sin bloques, sin el @import)
S_OK=0; C_OK=0
if [ ! -s "${S}" ] || [ "$(json "${S}" 'Object.keys(d).filter((k) => k !== "hooks").length + Object.keys(d.hooks || {}).length')" = 0 ]; then S_OK=1; fi
if [ ! -e "${C}" ] || ! grep -q '[^[:space:]]' "${C}"; then C_OK=1; fi
if [ "${S_OK}" -eq 1 ] && [ "${C_OK}" -eq 1 ]; then ok "T26 tras uninstall, settings.json y CLAUDE.md quedan como antes de instalar (no están, o vacíos)"
else no "T26 tras uninstall queda algo del arnés: settings.json $([ "${S_OK}" -eq 1 ] && echo limpio || echo "con contenido: $(head -c 200 "${S}" | tr '\n' ' ')") · CLAUDE.md $([ "${C_OK}" -eq 1 ] && echo limpio || echo "con contenido: $(head -c 200 "${C}" | tr '\n' ' ')")"; fi
if [ ! -L "${HOME}/.claude/agents" ] && [ ! -L "${HOME}/.claude/skills" ]; then ok "T26 tras uninstall no quedan los enlaces agents ni skills"
else no "T26 tras uninstall queda el enlace agents o skills apuntando al clon"; fi

fakes_check "T26"
scenario_end core
