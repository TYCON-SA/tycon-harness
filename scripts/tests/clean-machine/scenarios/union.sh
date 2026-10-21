#!/usr/bin/env bash
# union.sh — el núcleo sobre un plugin .NET, con red (corre DENTRO del contenedor del núcleo más el SDK de .NET).
#   T24 (paquete) · la imagen trae lo que la portada declara y nada de la lista vigilada.
#   T28 · la copia, instalada con el bloque `install:core` de la portada, sobre el plugin de ejemplo: clonado DE GITHUB
#         por sha (el desvío de la copia no lo toca, nunca por rama), con una story que nombra pruebas que el plugin ya
#         tiene. El esqueleto del pipeline, `dotnet test` de verdad y la auditoría sin faltantes. Los paquetes de un
#         stack (revisores, skills, guías) llegan con el perfil de cada equipo, no con la copia: acá el
#         pipeline corre sin ninguno activo y lo dice.
# uso: bash /opt/lab/scenarios/union.sh
set -uo pipefail
. /opt/lab/lib.sh
PLUGIN_URL="https://github.com/TYCON-SA/bizuit-custom-plugin-sample"
PLUGIN_SHA="b4dfe15ef37be0be17bf9ec89305cec6cb3bc635"
scenario_begin union

requirements_check "T24 (paquete)" "bizuit"
fakes_setup ${WATCHED} curl wget launchctl open

serve_copy
run_block_pty core "${OUT_DIR}/install.out" "${ANSWERS_FULL}"; RC=$?   # en una terminal: install pregunta
if [ "${RC}" -eq 0 ] && find_clone; then ok "T28 el bloque install:core sale 0 sobre la copia con el paquete"
else
  no "T28 el bloque install:core salió ${RC}: $(tail -n 4 "${OUT_DIR}/install.out" | tr '\n' ' ')"
  fakes_check "T28"; scenario_end union; exit 0
fi

# ── el plugin de ejemplo: de GitHub, por sha ─────────────────────────────────────────────────────────────────
R="${WORK_DIR}/plugin"; STORY="${R}/specs/story-1.1-items.md"
( cd "${WORK_DIR}" && git clone -q "${PLUGIN_URL}" plugin && git -C plugin checkout -q "${PLUGIN_SHA}" ) > "${OUT_DIR}/plugin-clone.out" 2>&1; RC=$?
if [ "${RC}" -eq 0 ] && [ "$(git -C "${R}" rev-parse HEAD)" = "${PLUGIN_SHA}" ] && [ "$(git -C "${R}" remote get-url origin)" = "${PLUGIN_URL}" ]; then
  ok "T28 el plugin de ejemplo está en ${PLUGIN_SHA:0:7} y su remoto es GitHub (el desvío de la copia no lo tocó)"
else
  no "T28 no pude clonar el plugin de ejemplo de GitHub en ${PLUGIN_SHA:0:7} (exit ${RC}; remoto: $(git -C "${R}" remote get-url origin 2>/dev/null)): $(tail -n 2 "${OUT_DIR}/plugin-clone.out" | tr '\n' ' ')"
  fakes_check "T28"; scenario_end union; exit 0
fi
git -C "${R}" checkout -q -b story/1.1 && mkdir -p "${R}/specs" && cp "${LAB_DIR}/plugin-story-1.1.md.tpl" "${STORY}"
git -C "${R}" add -A && git -C "${R}" -c user.name=lab -c user.email=lab@example.com commit -q -m 'la story de ejemplo'

# ── T28 · el esqueleto del pipeline, sin paquetes ────────────────────────────────────────────────────────────
export TYCON_SESSION_ID="clean-machine-union"
node "${HARNESS_LINK}/scripts/lib/lint-story-frontmatter.js" "${STORY}" > "${OUT_DIR}/lint.out" 2>&1; RC=$?
if [ "${RC}" -eq 0 ]; then ok "T28 lint-story-frontmatter.js sale 0 sobre la story del plugin"; else no "T28 lint-story-frontmatter.js salió ${RC}: $(tail -n 2 "${OUT_DIR}/lint.out" | tr '\n' ' ')"; fi

( cd "${R}" && node "${PIPE_DIR}/pipeline.js" start --story "${STORY}" --repo "${R}" ) > "${OUT_DIR}/start.json" 2> "${OUT_DIR}/start.err"; RC=$?
if [ "${RC}" -eq 0 ] && [ "$(json "${OUT_DIR}/start.json" 'd.ready')" = true ]; then ok "T28 pipeline.js start sale 0 con ready: true"
else no "T28 pipeline.js start salió ${RC}: $(json "${OUT_DIR}/start.json" 'JSON.stringify(d.pauses || d.error || d)' | head -c 300) $(head -c 200 "${OUT_DIR}/start.err")"; fi

( cd "${R}" && node "${PIPE_DIR}/pipeline.js" mech-check --repo "${R}" --story "${STORY}" ) > "${OUT_DIR}/mech.json" 2> "${OUT_DIR}/mech.err"; RC=$?
V="$(json "${OUT_DIR}/mech.json" '(d.findings || []).filter((f) => f.severity === "CRITICAL").length')"
if [ "${RC}" -eq 0 ] && [ "${V}" = 0 ]; then ok "T28 pipeline.js mech-check sale 0 sin hallazgos CRITICAL"
else no "T28 pipeline.js mech-check salió ${RC} con ${V:-?} CRITICAL: $(json "${OUT_DIR}/mech.json" '(d.findings || []).map((f) => f.rule + " " + f.detail).join(" · ")' | head -c 300)"; fi

( cd "${R}" && node "${PIPE_DIR}/pipeline.js" advisors --repo "${R}" --story "${STORY}" \
    --files src/MyPlugin/Features/Items/ItemsService.cs tests/MyPlugin.Tests/Features/ItemsServiceTests.cs ) > "${OUT_DIR}/advisors.json" 2> "${OUT_DIR}/advisors.err"; RC=$?
# `packs` es una lista de objetos: la copia no trae paquetes, y el set conserva pruebas y seguridad
V="$(json "${OUT_DIR}/advisors.json" '(d.packs || []).length + "|" + ["tycon-plugin-tests-coverage", "tycon-plugin-security-basics"].every((a) => (d.all || []).includes(a))')"
if [ "${RC}" -eq 0 ] && [ "${V}" = "0|true" ]; then ok "T28 pipeline.js advisors sale 0 sin paquetes, con los revisores de pruebas y de seguridad en el set"
else no "T28 pipeline.js advisors salió ${RC}; paquetes activos y núcleo en el set: «${V:-ilegible}» (esperado 0|true) $(head -c 300 "${OUT_DIR}/advisors.err" | tr '\n' ' ')"; fi

bash "${PIPE_DIR}/test-gate.sh" "${R}" "${STORY}" > "${OUT_DIR}/gate.out" 2>&1; RC=$?
V="$(json "${R}/.advisors/tests-result.json" '[d.runner, d.suite_green, d.totals && d.totals.total > 0 && d.totals.failed === 0].join("|")')"
if [ "${RC}" -eq 0 ] && [ "${V}" = "dotnet|true|true" ]; then ok "T28 test-gate.sh corre dotnet test, sale 0 y deja su tests-result.json ($(json "${R}/.advisors/tests-result.json" 'd.totals.total') pruebas, ninguna en rojo)"
else no "T28 test-gate.sh salió ${RC}; tests-result.json dice «${V:-no está}» (esperado dotnet|true|true): $(tail -n 4 "${OUT_DIR}/gate.out" | tr '\n' ' ' | head -c 400)"; fi

audit_clean "T28 (núcleo sobre un plugin .NET)"

fakes_check "T28"
scenario_end union
