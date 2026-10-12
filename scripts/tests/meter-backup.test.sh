#!/usr/bin/env bash
# meter-backup.test.sh — el respaldo local del medidor NO corre antes de que el nocturno haya
# tenido su oportunidad (2026-09-06).
#
# EL DEFECTO. El instalador lanzaba el medidor local si «el snapshot de hoy no llegó con el pull».
# Pero el nocturno lo commitea a las 03:00 hora local, así que en toda sesión entre las 00:00 y las
# 03:00 el archivo de hoy NUNCA está — y el respaldo corría siempre, no sólo cuando el nocturno
# falló. Medido: sesión a las 01:38 → sello escrito a las 01:38:55, snapshot local a las 01:41; a
# las 03:20 el nocturno commitea el suyo y el `git pull` de la mañana rebota contra el archivo
# suelto. Dos escritores del mismo archivo por día es justo lo que la serie no puede tener.
#
# 🔴 rojo previo verificado: con la decisión vieja (que sólo miraba «¿existe el archivo?»), el caso
#    de la 01:41 dice «correr».
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$RAIZ/scripts/lib/meter-backup.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

# hora · existe snapshot de hoy · sello es de hoy · esperado (0=correr 1=no)
caso() {
  local hora="$1" existe="$2" sello="$3" esperado="$4" nombre="$5"
  respaldo_medidor_debe_correr "$hora" "$existe" "$sello"; local rc=$?
  if [ "$rc" = "$esperado" ]; then ok "$nombre"; else mal "$nombre (esperaba $esperado, dio $rc)"; fi
}

caso 01 0 0 1 "01:41, sin archivo, sello de ayer → NO corre: el nocturno todavía no tuvo su oportunidad (el caso real)"
caso 03 0 0 1 "03:10, sin archivo → NO corre: el nocturno está corriendo justo ahora"
caso 05 0 0 0 "05:00, sin archivo, sello de ayer → SÍ corre: el nocturno debería haber llegado y no llegó"
caso 09 0 0 0 "09:00, sin archivo → SÍ corre (respaldo de verdad)"
caso 09 1 0 1 "09:00, el archivo YA llegó con el pull → NO corre (escritor único)"
caso 09 0 1 1 "09:00, sin archivo pero ya se lanzó hoy → NO corre (no se reintenta en loop)"
caso 23 0 0 0 "23:00, sin archivo → SÍ corre"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
