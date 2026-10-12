#!/usr/bin/env bash
# ac-old-cases-intact.sh — T15 · AC 12 de la story 2.3: los casos que YA existían en las cuatro
# suites que esta story toca no se editan; sólo se AGREGAN casos.
#
# 🔴 Es smoke y no caso de suite a propósito (mismo criterio que el T15 de la 2.2): sólo se puede
#    juzgar comparando contra `origin/main`, y en cuanto la story se mergea el diff se vacía y el
#    caso pasaría para siempre sin poder ponerse rojo. Un control que no puede fallar es peor que
#    no tenerlo. Se corre UNA vez antes del merge y su exit code real queda en el registro.
#
# Correr: bash scripts/tests/smokes-2.3/ac-old-cases-intact.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$RAIZ" || exit 1

# 🔴 La base es `origin/main` FIJA, sin variable de entorno que la cambie: apuntada a `HEAD` este
#    chequeo daría «0 líneas borradas» siempre — un control apagable por config
#    (`guides/decisions/controles-apagables-por-config-2026-08-25.md`). Lo cazó el revisor de spec-first.
BASE="origin/main"
ARCHIVOS=(
  scripts/tests/lint-story-detector.test.sh
  scripts/tests/lint-story-frontmatter.test.js
  scripts/tests/sdlc-transitions.test.js
  scripts/tests/dashboard.test.sh
)

fallos=0
ok()  { echo "  ✅ $1"; }
mal() { echo "  ❌ $1 — $2"; fallos=$((fallos+1)); }

echo "== AC 12 · los casos viejos no se tocan (contra $BASE) =="

git rev-parse --verify --quiet "$BASE" >/dev/null || {
  echo "  ⚠️  no puedo resolver $BASE — sin la base no se puede juzgar. NO MEDIDO (no es un OK)."
  exit 3
}

for f in "${ARCHIVOS[@]}"; do
  [ -f "$f" ] || { mal "$f" "no existe"; continue; }
  # Líneas BORRADAS respecto de la base (las agregadas son el trabajo de esta story).
  BORRADAS="$(git diff "$BASE" -- "$f" | grep -c '^-[^-]' || true)"
  if [ "${BORRADAS:-0}" -eq 0 ]; then
    ok "$(basename "$f"): 0 líneas borradas"
  else
    mal "$(basename "$f"): $BORRADAS línea(s) borrada(s)" "esta story agrega casos, no edita los que ya estaban"
    git diff "$BASE" -- "$f" | grep '^-[^-]' | head -10 | sed 's/^/       /'
  fi
done

echo "  — y las cuatro suites en verde —"
for f in "${ARCHIVOS[@]}"; do
  # 🔴 El `*)` no es decoración: sin él, un archivo con otra extensión no corre NADA y `RC=$?`
  #    toma el exit del comando ANTERIOR — o sea «✅ verde» sin haber ejecutado una línea. Lo cazó
  #    el pase adversarial posterior al merge; es la forma exacta del «verde que significa no miré».
  case "$f" in
    *.sh) bash "$f" >/dev/null 2>&1; RC=$? ;;
    *.js) node --test "$f" >/dev/null 2>&1; RC=$? ;;
    *)    mal "$(basename "$f") no se sabe correr" "extensión no contemplada — NO se ejecutó"; continue ;;
  esac
  [ "$RC" -eq 0 ] && ok "$(basename "$f") verde" || mal "$(basename "$f") en rojo" "exit $RC"
done
# `dashboard.test.sh` regenera el artefacto del tablero (su caso C-11): se restaura, porque el
# tablero se genera desde el checkout canónico y no desde un clon (gotcha de la 2.2).
git checkout -q -- artifacts/ 2>/dev/null || true

echo
[ "$fallos" -eq 0 ] && { echo "✅ ac-casos-viejos-intactos: todo verde"; exit 0; }
echo "❌ ac-casos-viejos-intactos: $fallos rojos"; exit 1
