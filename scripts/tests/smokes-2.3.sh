#!/usr/bin/env bash
# smokes-2.3.sh — los smokes de la causa del reproceso (lo que una suite local no puede probar).
#
# 🔴 ACUMULA los códigos de salida y sale ≠ 0 si alguno falló. Si las llamadas no miran el exit code,
#    el guion sale verde con un smoke en rojo — un verde que significa «no miré nada».
#
# Un smoke que devuelve 3 (NO MEDIDO: faltan los repos del dev, o no se puede resolver origin/main)
# se cuenta APARTE y no se lee como verde: se nombra y el guion sale 3.
#
# Correr: bash scripts/tests/smokes-2.3.sh

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$DIR/../.." && pwd)"
# 🔴 Cada smoke va por `smoke-run.sh`: captura el EXIT CODE REAL y lo deja en el ledger
# del repo Y en el registro global. Sin eso, la corrida no es EVIDENCIA para runtime-matrix.js —
# el smoke pasa, el criterio sigue contando como NO CORRIDO y la story no se puede cerrar.
SMOKE="$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh"
EVID="$RAIZ/.advisors/dod-runtime"

rojos=0
nomedidos=0
nombres_nm=""

# $1 = script · $2 = los ACs que cubre (para el ledger)
correr() {
  echo
  echo "──────────────────────────────────────────────────────────────"
  if [ -x "$SMOKE" ]; then
    "$SMOKE" "$EVID" 2.3 --acs "$2" -- bash "$DIR/smokes-2.3/$1"
  else
    echo "⚠️  falta smoke-run.sh: la ejecución NO queda registrada como evidencia" >&2
    bash "$DIR/smokes-2.3/$1"
  fi
  local rc=$?
  case "$rc" in
    0) ;;
    3) nomedidos=$((nomedidos+1)); nombres_nm="$nombres_nm $1" ;;
    *) rojos=$((rojos+1)) ;;
  esac
}

correr ac-real-measurement.sh 11
correr ac-old-cases-intact.sh 12

echo
echo "══════════════════════════════════════════════════════════════"
if [ "$rojos" -gt 0 ]; then
  echo "❌ smokes 2.3: $rojos smoke(s) en ROJO$( [ "$nomedidos" -gt 0 ] && echo " · $nomedidos no medido(s):$nombres_nm" )"
  exit 1
fi
if [ "$nomedidos" -gt 0 ]; then
  echo "⚠️  smokes 2.3: $nomedidos NO MEDIDO(s):$nombres_nm — no es un verde, es «no se pudo mirar»"
  exit 3
fi
echo "✅ smokes 2.3: todo verde"
exit 0
