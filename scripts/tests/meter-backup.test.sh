#!/usr/bin/env bash
# meter-backup.test.sh — el respaldo local del medidor NO corre antes de que el nocturno haya
# tenido su oportunidad.
#
# POR QUÉ. El instalador lanza el medidor local si «el snapshot de hoy no llegó con el pull».
# Pero el nocturno lo commitea a las 03:00 hora local, así que en toda sesión entre las 00:00 y las
# 03:00 el archivo de hoy NUNCA está — y un respaldo que sólo mira «¿existe el archivo?» correría siempre, no sólo
# cuando el nocturno falló. Ejemplo: sesión a las 01:38 → sello escrito a las 01:38:55, snapshot local a las 01:41; a
# las 03:20 el nocturno commitea el suyo y el `git pull` de la mañana rebota contra el archivo
# suelto. Dos escritores del mismo archivo por día es justo lo que la serie no puede tener.
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

# ── El respaldo sólo corre donde el arnés es un CLON ─────────────────────────────────────────────
# POR QUÉ. En una versión instalada el árbol del arnés no es un clon: buscar la foto del día en
# `<árbol>/.dashboard/`, que ahí no existe nunca, haría correr el respaldo TODOS los días; barrería la carpeta madre
# del árbol (sin repos) y escribiría una foto vacía (unos 939 bytes, contra los 49.945 de la del nocturno), con el
# mismo nombre. Escrita en el clon donde el nocturno deja la suya, la pisa o traba el `pull` siguiente.
# Sin `meter_backup_has_own_tree`, estos casos fallan por «command not found».
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/clon/.git" "$T/enlazado" "$T/instalado/scripts"
echo "gitdir: /otro/lado" > "$T/enlazado/.git"
arbol() {
  local dir="$1" esperado="$2" nombre="$3"
  meter_backup_has_own_tree "$dir" 2>/dev/null; local rc=$?
  if [ "$rc" = "$esperado" ]; then ok "$nombre"; else mal "$nombre (esperaba $esperado, dio $rc)"; fi
}
arbol "$T/clon" 0 "el arnés corre desde un clon → el respaldo tiene dónde escribir: aplica"
arbol "$T/enlazado" 0 "un árbol enlazado de un clon (.git es un archivo) → aplica"
arbol "$T/instalado" 1 "una versión instalada (sin .git) → NO aplica: el punto del día es del nocturno"
arbol "$T/no-existe" 1 "una carpeta que no está → NO aplica"
arbol "" 1 "sin carpeta → NO aplica"
# y el instalador se lo pregunta ANTES de sellar y de lanzar el barrido
if awk '/^STAGE_METRICS_JS=/{on=1} on&&/nohup node "\$STAGE_METRICS_JS"/{exit} on' "$RAIZ/scripts/install-tycon-hooks.sh" | grep 'meter_backup_has_own_tree' >/dev/null; then
  ok "el instalador pregunta si el arnés es un clon antes de lanzar el respaldo"
else
  mal "el instalador lanza el respaldo sin preguntar si el arnés es un clon"
fi
# …y si la biblioteca del respaldo no está, lo dice (el `source` falla a la vista; saltearlo callado no)
if grep -q 'falta scripts/lib/meter-backup.sh' "$RAIZ/scripts/install-tycon-hooks.sh"; then
  ok "sin scripts/lib/meter-backup.sh el instalador dice que el respaldo no corre"
else
  mal "sin scripts/lib/meter-backup.sh el instalador saltea el respaldo sin decirlo"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
