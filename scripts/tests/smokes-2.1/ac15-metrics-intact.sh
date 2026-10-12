#!/usr/bin/env bash
# AC 15 · las cuatro métricas de antes, IDÉNTICAS.
# 🔴 El A/B correcto es: mismo repo, mismo momento, código de `origin/main` contra el de esta
# rama. La primera versión de este smoke comparaba contra el snapshot del SERVIDOR y daba rojo
# por una diferencia de ENTORNO (allá la evidencia de cierre no viaja, acá sí) — un falso
# positivo que habría mandado a buscar una regresión inexistente.
set -uo pipefail
RAIZ="$1"; REPO_REAL="$2"; NUEVO_JSON="$3"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git -C "$RAIZ" show origin/main:scripts/metrics/sdlc-stage-metrics.js > "$T/viejo.js" || exit 1
node "$T/viejo.js" --repo "$REPO_REAL" --json 2>/dev/null > "$T/viejo.json" || exit 1
python3 - "$T/viejo.json" "$NUEVO_JSON" <<'PY'
import json, sys
v = json.load(open(sys.argv[1])); n = json.load(open(sys.argv[2]))
for k in ('lead_time_days', 'rework_ratio', 'dod_evidence_ratio', 'stories_total', 'done_total'):
    assert v['repos'][0][k] == n['repos'][0][k], f"{k} cambió: {v['repos'][0][k]} -> {n['repos'][0][k]}"
for k in ('lead_time_days', 'lead_time_monthly', 'rework_ratio', 'dod_evidence_ratio'):
    assert v['global'][k] == n['global'][k], f"global.{k} cambió"
print('las 4 métricas y la serie mensual, idénticas al código publicado')
PY
