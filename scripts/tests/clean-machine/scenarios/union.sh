#!/usr/bin/env bash
# union.sh — el paquete del stack, con red (corre DENTRO del contenedor del paquete: el del núcleo más el SDK de .NET).
#   T24 (paquete) · la imagen trae lo que la portada declara —acá también `dotnet`— y nada de la lista vigilada.
#   T28 · la copia con el paquete, instalada con los bloques `install:core` e `install:bizuit` de la portada, sobre el
#         plugin de ejemplo: clonado DE GITHUB por sha (el desvío de la copia no lo toca, nunca por rama), con una story
#         que nombra pruebas que el plugin ya tiene. El esqueleto del pipeline, `dotnet test` de verdad, la auditoría
#         sin faltantes y los casos de los tres revisores del paquete en el banco.
# uso: bash /opt/lab/scenarios/union.sh
set -uo pipefail
. /opt/lab/lib.sh
PLUGIN_URL="https://github.com/TYCON-SA/bizuit-custom-plugin-sample"
PLUGIN_SHA="b4dfe15ef37be0be17bf9ec89305cec6cb3bc635"
PACK_REVIEWERS="tycon-plugin-dotnet-conventions tycon-plugin-react-conventions tycon-plugin-nextjs-conventions"
scenario_begin union

requirements_check "T24 (paquete)" "bizuit"
fakes_setup ${WATCHED} curl wget launchctl open

serve_copy
run_block_pty core "${OUT_DIR}/install.out" "${ANSWERS_FULL}"; RC=$?   # en una terminal: install pregunta (story 8.16, tandas B y D)
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
# el bloque install:bizuit de la portada, tal cual: activa el paquete en la máquina (lo activa la organización o la
# máquina; un repo sólo puede achicar la lista)
run_block bizuit "${OUT_DIR}/install-bizuit.out" "${R}"; RC=$?
PD="$(node "${HARNESS_LINK}/scripts/lib/tycon-config.js" get packs.default 2>/dev/null)"
if [ "${RC}" -eq 0 ] && [ "${PD}" = "bizuit" ]; then ok "T28 el bloque install:bizuit de la portada deja packs.default en bizuit en la máquina"
else no "T28 el bloque install:bizuit salió ${RC} o packs.default no quedó en bizuit («${PD}»): $(tail -n 2 "${OUT_DIR}/install-bizuit.out" | tr '\n' ' ')"; fi
git -C "${R}" add -A && git -C "${R}" -c user.name=lab -c user.email=lab@example.com commit -q -m 'la story de ejemplo y el paquete pedido'

# ── T28 · el esqueleto del pipeline, con el paquete ──────────────────────────────────────────────────────────
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
# `packs` es una lista de objetos: se miran sus `nombre` (decisión C6)
V="$(json "${OUT_DIR}/advisors.json" '(d.packs || []).map((p) => p.nombre).join(",") + "|" + (d.all || []).includes("tycon-plugin-dotnet-conventions")')"
if [ "${RC}" -eq 0 ] && [ "${V}" = "bizuit|true" ]; then ok "T28 pipeline.js advisors sale 0 con el paquete bizuit activo y tycon-plugin-dotnet-conventions en el set"
else no "T28 pipeline.js advisors salió ${RC}; paquetes activos y revisor de .NET en el set: «${V:-ilegible}» (esperado bizuit|true) $(head -c 300 "${OUT_DIR}/advisors.err" | tr '\n' ' ')"; fi

bash "${PIPE_DIR}/test-gate.sh" "${R}" "${STORY}" > "${OUT_DIR}/gate.out" 2>&1; RC=$?
V="$(json "${R}/.advisors/tests-result.json" '[d.runner, d.suite_green, d.totals && d.totals.total > 0 && d.totals.failed === 0].join("|")')"
if [ "${RC}" -eq 0 ] && [ "${V}" = "dotnet|true|true" ]; then ok "T28 test-gate.sh corre dotnet test, sale 0 y deja su tests-result.json ($(json "${R}/.advisors/tests-result.json" 'd.totals.total') pruebas, ninguna en rojo)"
else no "T28 test-gate.sh salió ${RC}; tests-result.json dice «${V:-no está}» (esperado dotnet|true|true): $(tail -n 4 "${OUT_DIR}/gate.out" | tr '\n' ' ' | head -c 400)"; fi

audit_clean "T28 (núcleo y paquete)"

# los casos de los revisores los lista el corredor de revisores (runner.js es el de hooks: decisión C5)
( cd "${HARNESS_LINK}" && node scripts/controls-bench/advisor-runner.js --list ) > "${OUT_DIR}/bench.out" 2>&1
MISSING=""
for a in ${PACK_REVIEWERS}; do grep -q "${a}" "${OUT_DIR}/bench.out" || MISSING="${MISSING} ${a}"; done
if [ -z "${MISSING}" ]; then ok "T28 advisor-runner.js --list incluye los casos de los tres revisores del paquete"
else no "T28 advisor-runner.js --list no trae los casos de:${MISSING} — $(tail -n 2 "${OUT_DIR}/bench.out" | tr '\n' ' ')"; fi

fakes_check "T28"
scenario_end union
