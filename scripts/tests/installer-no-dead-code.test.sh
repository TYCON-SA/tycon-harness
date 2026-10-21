#!/usr/bin/env bash
# installer-no-dead-code.test.sh — nada vive después del `exit 0` final del instalador.
#
# 🔴 Un bloque agregado DESPUÉS del `exit 0` de nivel raíz de install-tycon-hooks.sh (por ejemplo el que
# refresca la lista de proyectos de Azure DevOps para failed-query-notice.js) nunca corre, en ninguna máquina,
# y los textos que lo describen afirman algo que no existe.
# Este chequeo es estructural y barato: el último `exit 0` de nivel raíz tiene que ser la última
# línea con código del archivo (comentarios y líneas vacías después están bien).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
for f in "$RAIZ/scripts/install-tycon-hooks.sh"; do
  ULT_EXIT=$(grep -n '^exit 0' "$f" | tail -1 | cut -d: -f1)
  [ -n "$ULT_EXIT" ] || { mal "$(basename "$f"): no tiene un exit 0 de nivel raíz"; continue; }
  DESPUES=$(tail -n +"$((ULT_EXIT + 1))" "$f" | grep -vE '^\s*(#|$)' | head -3)
  if [ -z "$DESPUES" ]; then ok "$(basename "$f"): nada con código después del exit 0 final (línea $ULT_EXIT)"
  else mal "$(basename "$f"): hay código después del exit 0 de la línea $ULT_EXIT — es código muerto:"; echo "$DESPUES" | sed 's/^/        /'; fi
done
# Reproducido en una copia: un bloque después del exit 0 se detecta
T=$(mktemp -d); cp "$RAIZ/scripts/install-tycon-hooks.sh" "$T/inst.sh"; printf '\nif true; then echo muerto; fi\n' >> "$T/inst.sh"
ULT=$(grep -n '^exit 0' "$T/inst.sh" | tail -1 | cut -d: -f1); D=$(tail -n +"$((ULT + 1))" "$T/inst.sh" | grep -vE '^\s*(#|$)')
[ -n "$D" ] && ok "el chequeo se pone rojo con un bloque después del exit 0 (rojo previo)" || mal "el chequeo no detecta código después del exit 0"
rm -rf "$T"
echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
