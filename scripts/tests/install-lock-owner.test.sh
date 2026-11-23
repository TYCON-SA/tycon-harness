#!/usr/bin/env bash
# install-lock-owner.test.sh — el candado del instalador no vence por edad mientras su dueño vive.
#
# install-tycon-hooks.sh toma un candado (una carpeta con el pid de quien lo tiene) para que corra un solo instalador
# por máquina. Uno de más de 10 minutos se daba por abandonado aunque su dueño siguiera corriendo, y entraba un segundo
# instalador. Ahora es viejo sólo con su dueño muerto; con el dueño vivo, recién a la hora (uno colgado no frena para
# siempre). La prueba saca la función `_lock_stale` del instalador y la evalúa sobre candados de juguete: no corre el
# instalador.
#
# stable-data: sin git; las fechas del candado se fijan con touch -t, relativas a ahora.
# Correr: bash scripts/tests/install-lock-owner.test.sh < /dev/null
set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALADOR="$RAIZ/scripts/install-tycon-hooks.sh"
FALLAS=0
ok() { echo "✅ $1"; }
mal() { echo "❌ $1"; FALLAS=$((FALLAS + 1)); }

# la función tal como está en el instalador, de su línea de apertura a su cierre (en un renglón o en varios)
FUNCION="$(awk '/^  _lock_stale\(\) \{/{f=1} f{print} f&&(/^  \}$/||/; \}$/){exit}' "$INSTALADOR")"
[ -n "$FUNCION" ] || { echo "❌ no encontré _lock_stale en el instalador"; exit 1; }
eval "$FUNCION"

LAB="$(mktemp -d)"
trap 'rm -rf "$LAB"; [ -n "${VIVO:-}" ] && kill "$VIVO" 2>/dev/null' EXIT
INSTALL_LOCK="$LAB/install-tycon-hooks.lock"
hace() { date -v-"$1"M +%Y%m%d%H%M 2>/dev/null || date -d "-$1 min" +%Y%m%d%H%M; }
candado() { rm -rf "$INSTALL_LOCK"; mkdir "$INSTALL_LOCK"; [ -n "$2" ] && echo "$2" > "$INSTALL_LOCK/pid"; touch -t "$(hace "$1")" "$INSTALL_LOCK"; }

sleep 600 & VIVO=$!
( exit 0 ) & MUERTO=$!; wait "$MUERTO"

candado 5 "$MUERTO"
_lock_stale && mal "T1 uno fresco (5 min) se daba por viejo" || ok "T1 uno fresco (5 min) no es viejo"
candado 20 "$VIVO"
_lock_stale && mal "T2 uno de 20 min con su dueño vivo se daba por viejo" || ok "T2 uno de 20 min con su dueño vivo no es viejo"
candado 20 "$MUERTO"
_lock_stale && ok "T3 uno de 20 min con su dueño muerto es viejo" || mal "T3 uno de 20 min con su dueño muerto no se daba por viejo"
candado 20 ""
_lock_stale && ok "T4 uno de 20 min sin pid anotado es viejo" || mal "T4 uno de 20 min sin pid no se daba por viejo"
candado 90 "$VIVO"
_lock_stale && ok "T5 uno de 90 min es viejo aunque su dueño viva (colgado)" || mal "T5 uno de 90 min con el dueño vivo no vencía nunca"

[ "$FALLAS" -eq 0 ] && { echo "install-lock-owner: todo verde"; exit 0; }
echo "install-lock-owner: $FALLAS en rojo"; exit 1
