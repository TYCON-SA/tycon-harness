#!/usr/bin/env bash
# ac-real-measurement.sh — T13 · AC 11 de la story 2.3: el medidor corre sobre los repos REALES del disco y
# el número se PUBLICA en Dev Notes. Es el único caso de esta story que toca la realidad; todos los
# demás son fixtures.
#
# 🔴 Asserta `total > 0` antes de creerle a nada: un cero acá es «no miré», no «no hay». Lo pagó
#    esta misma story — la primera corrida del censo devolvió 0 repos en silencio porque
#    `discoverStories()` devuelve `{stories: [...]}` y el guion esperaba un array.
#
# Correr: bash scripts/tests/smokes-2.3/ac-real-measurement.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STORY="$RAIZ/specs/story-2.3-causa-del-reproceso.md"
CENSO="$RAIZ/scripts/metrics/censo-followups-2026-09-05.json"
SCAN="${TYCON_REPOS_ROOT:-$HOME/SourceCode}"

fallos=0
ok()  { echo "  ✅ $1"; }
mal() { echo "  ❌ $1 — $2"; fallos=$((fallos+1)); }

echo "== AC 11 · la medición real se publica =="

[ -d "$SCAN" ] || { echo "  ⚠️  no existe $SCAN — este smoke necesita los repos del dev. NO MEDIDO."; exit 3; }

OUT="$(node "$RAIZ/scripts/metrics/sdlc-stage-metrics.js" --scan "$SCAN" --only-harness --json 2>/dev/null)"
RC=$?
[ "$RC" -eq 0 ] && [ -n "$OUT" ] || { mal "el medidor no corrió" "exit $RC"; echo "❌ $fallos"; exit 1; }

read -r TOTAL SINDEC CUATRO SINTYPE REPOS <<<"$(printf '%s' "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin); x=(d.get('global') or {}).get('rework_por_causa')
if not x: print('0 0 0 0 0'); sys.exit()
cuatro=sum(x['conteo'].values())
print(x['total'], x['sin_declarar'], cuatro, x['sin_declarar_por_type'].get('sin_type',0), len(d['repos']))")"

echo "  medido: total=$TOTAL · sin_declarar=$SINDEC · las cuatro causas=$CUATRO · sin_type=$SINTYPE · repos=$REPOS"

# 🔴 El assert que impide creerle a un cero.
[ "${TOTAL:-0}" -gt 0 ] 2>/dev/null && ok "total > 0 (miró de verdad)" || mal "total = ${TOTAL:-vacío}" "un cero acá es «no miré», no «no hay»"
[ "${SINDEC:-0}" -le "${TOTAL:-0}" ] 2>/dev/null && ok "sin_declarar ($SINDEC) no supera el total" || mal "sin_declarar > total" "$SINDEC > $TOTAL"
[ $(( ${CUATRO:-0} + ${SINDEC:-0} )) -le "${TOTAL:-0}" ] 2>/dev/null && ok "el invariante cierra sobre los repos reales" || mal "no cierra" "$CUATRO + $SINDEC > $TOTAL"

# El censo commiteado tiene que coincidir con lo que el medidor cuenta hoy.
if [ -f "$CENSO" ]; then
  CTOT="$(python3 -c "import json;print(json.load(open('$CENSO'))['con_followup_of'])" 2>/dev/null)"
  [ "$CTOT" = "$TOTAL" ] && ok "el censo commiteado coincide con la corrida ($CTOT)" \
    || mal "el censo dice $CTOT y el medidor $TOTAL" "el censo es salida de una medición: se regenera, no se edita"
else
  mal "falta el censo" "$CENSO"
fi

# Y el número tiene que estar ESCRITO en la story: publicar es parte del AC, no un extra.
# 🔴 `[ -n "$N" ]` primero: con $N vacío (si el `python3` de arriba falló) el patrón `\b\b` matchea
#    CUALQUIER texto y este sub-chequeo daría «ok» falso. Hoy queda enmascarado porque el chequeo
#    `total > 0` ya falla en ese escenario — pero un ok que depende de que otro falle no es un ok.
#    Lo cazó el cazador de fallos silenciosos.
for N in "$TOTAL" "$SINTYPE"; do
  if [ -z "$N" ]; then mal "no pude leer un número del medidor" "el valor llegó vacío — no se puede juzgar"; continue; fi
  grep -q "\b$N\b" "$STORY" && ok "el número $N está escrito en la story" || mal "el número $N no aparece en la story" "AC 11 exige publicarlo en Dev Notes"
done

echo
[ "$fallos" -eq 0 ] && { echo "✅ ac-medicion-real: todo verde"; exit 0; }
echo "❌ ac-medicion-real: $fallos rojos"; exit 1
