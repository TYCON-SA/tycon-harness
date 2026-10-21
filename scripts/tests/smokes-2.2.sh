#!/usr/bin/env bash
# =============================================================================
# smokes-2.2.sh — la verificación RUNTIME del contador del presente y del tablero, por criterio.
#
# Por qué existe: el portón de Definición de Terminado exige que cada criterio se ejercite
# CORRIENDO el producto, no leyendo el código. Acá no hay pantalla ni endpoint: el
# producto son el medidor y el tablero, y su «runtime» es correrlos contra los repos de verdad
# y mirar lo que publican. Cada smoke va por `smoke-run.sh`, que captura el EXIT CODE REAL y lo
# deja en el ledger del repo Y en el registro global — un ledger escrito a mano no sirve.
#
# 🔴 La medición real es el único criterio declarado `runtime_not_verifiable` en el frontmatter: es una
#    medición contra los repos reales del disco de un dev, y ninguna suite puede fabricar ese universo
#    (fabricarlo sería medir el fixture y no la realidad). Las fichas del tablero y el criterio de «cerrado»
#    SÍ tienen red en la suite (dashboard.test.sh y sdlc-transitions.test.js); sus smokes existen porque una cosa es
#    que la mecánica funcione sobre un fixture y otra que la página real salga bien.
#
# Uso:  bash scripts/tests/smokes-2.2.sh [<raiz-de-repos>]
#       (default: ~/SourceCode)
# =============================================================================
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAIZ_REPOS="${1:-$HOME/SourceCode}"
MEDIDOR="$RAIZ/scripts/metrics/sdlc-stage-metrics.js"
TABLERO="$RAIZ/scripts/nightly/dashboard/dashboard.js"
ESTADOS="$RAIZ/scripts/metrics/states.json"
STORY="$RAIZ/specs/story-2.2-diccionario-de-estados-y-trabajo-en-curso.md"
EVID="$RAIZ/.advisors/dod-runtime"
SMOKE="$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh"
SID="2.2"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smokes-2.2"
mkdir -p "$EVID"

# 🔴 Los tres frenos salen 3 y NO registran evidencia: un smoke que no pudo correr no es un
#    smoke verde. «No pude mirar» y «miré y está bien» no se escriben igual.
if [ ! -d "$RAIZ_REPOS" ]; then
  echo "🛑 no encuentro la raíz de repos ($RAIZ_REPOS): sin ella estos smokes no prueban nada." >&2
  echo "   Pasá otra como primer argumento. NO se registra evidencia." >&2
  exit 3
fi
if [ ! -x "$SMOKE" ]; then
  echo "🛑 no encuentro smoke-run.sh ($SMOKE): sin él la evidencia no queda registrada." >&2
  exit 3
fi
if [ ! -f "$STORY" ]; then
  echo "🛑 no encuentro la story ($STORY): el AC 13 exige que los números estén publicados en ella." >&2
  exit 3
fi

echo "== smokes de la story 2.2 · repos reales: $RAIZ_REPOS =="

# 🔴 `corre` ACUMULA el resultado y el guion sale distinto de 0 si alguno falló. Sin esto el
#    script termina siempre en verde aunque un criterio rompa — el portón de Definición de Terminado no
#    se engaña (lee el código de salida real de cada smoke desde el ledger que escribe
#    smoke-run.sh), pero quien lo corra a mano, o cualquier automatización que mire el exit code,
#    sí.
FALLAS=0
CORRIDOS=0
corre() {
  echo; echo "── $1"; shift
  CORRIDOS=$((CORRIDOS + 1))
  "$SMOKE" "$EVID" "$SID" "$@" || FALLAS=$((FALLAS + 1))
}

# ── la medición real, con denominador y con el universo nombrado ──
corre "AC 13 · en curso / backlog / desconocidas, medido y publicado" --acs 13 -- \
  bash "$AQUI/ac13-real-measurement.sh" "$MEDIDOR" "$RAIZ_REPOS" "$STORY"

# ── las tres fichas del tablero, sobre un snapshot REAL ──
corre "AC 10/11/12 · las tres fichas con denominador, cobertura y desglose" --acs 10,11,12 -- \
  bash "$AQUI/ac10-unknowns-decided.sh" "$MEDIDOR" "$TABLERO" "$RAIZ_REPOS"

# ── el criterio nuevo de «cerrado» mueve exactamente lo esperado ──
corre "AC 14/17/18 · el delta de done_total es el esperado y nada más se mueve" --acs 14,17,18 -- \
  bash "$AQUI/ac14-expected-metrics.sh" "$MEDIDOR" "$ESTADOS" "$RAIZ_REPOS"

# ── los casos de las transiciones siguen ahí, sin retocar, y verdes ──
corre "AC 15 · los casos viejos intactos (sólo se agregan, salvo el que se nombra)" --acs 15 -- \
  bash "$AQUI/ac15-old-cases-intact.sh" "$RAIZ"

echo
echo "== evidencia en $EVID =="
[ "$FALLAS" -eq 0 ] || { echo "🛑 FALLARON $FALLAS smoke(s) — la story NO está lista"; exit 1; }
echo "los $CORRIDOS smokes salieron verdes"
