#!/usr/bin/env bash
# capture.sh — deja la última captura de pantalla en una ruta que el agente SIEMPRE puede leer.
#
# 🔴 Por qué existe (2026-09-09): el agente no pudo leer una captura del escritorio y el dev
# perdió el hilo del trabajo. Dos causas distintas, y ninguna se arregla "intentando de nuevo":
#   1. El nombre que pone macOS en español trae un espacio ESTRECHO (U+202F) antes de «a. m.».
#      Viaja como texto entre el dev y el agente, se normaliza a un espacio común, y entonces
#      la ruta ya no existe. El error que se ve es «no existe el archivo», que manda a buscar
#      donde no está.
#   2. 🔴 LA GRANDE: cuando una conversación ya tiene varias imágenes, NINGUNA puede superar
#      los 2000 píxeles de lado. Una captura de pantalla Retina mide 2400-2950 de ancho, así
#      que la rechaza — y el mensaje no dice "achicá la imagen", dice que no se pudo procesar.
#      Peor: una sola imagen grande pegada antes envenena TODAS las que vengan después en esa
#      misma conversación, aunque las nuevas sean chicas. Por eso conviene achicar ANTES de
#      pegar, no después.
# Esto resuelve las dos: copia con nombre ASCII fijo y la achica a un ancho razonable.
#
# Uso:
#   scripts/tools/capture.sh           # la más reciente del escritorio
#   scripts/tools/capture.sh <archivo> # una en particular (admite nombres con espacios raros)
# Imprime la ruta lista para leer. Sale 3 si no encontró ninguna: un vacío en silencio manda a
# mirar una captura vieja creyendo que es la nueva.

set -uo pipefail
# Las variables renombradas a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/legacy-names.sh"
legacy_env TYCON_CAPTURE_DIR; legacy_env TYCON_CAPTURE_SOURCE; legacy_env TYCON_CAPTURE_SIDE
DEST_DIR="${TYCON_CAPTURE_DIR:-${TMPDIR:-/tmp}/tycon-captura}"
ORIGEN_DIR="${TYCON_CAPTURE_SOURCE:-$HOME/Desktop}"
LADO="${TYCON_CAPTURE_SIDE:-1600}"   # lado más largo; el tope duro del otro lado es 2000

mkdir -p "$DEST_DIR" || { echo "no se pudo crear $DEST_DIR" >&2; exit 3; }

if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
  ORIGEN="$1"
  [ -f "$ORIGEN" ] || { echo "no existe: $ORIGEN" >&2; exit 3; }
else
  # El más reciente por fecha, sin depender del glob del shell (los nombres traen espacios).
  ORIGEN="$(/usr/bin/find "$ORIGEN_DIR" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) -print0 2>/dev/null \
    | xargs -0 /bin/ls -t 2>/dev/null | head -1)"
  [ -n "$ORIGEN" ] || { echo "no hay ninguna imagen en $ORIGEN_DIR" >&2; exit 3; }
fi

# Nombre fijo y ASCII. Se numera para que el agente no lea por error la de hace media hora
# creyendo que es la nueva: la ruta cambia en cada corrida.
N=$(( $(/bin/ls "$DEST_DIR" 2>/dev/null | grep -c '^captura-') + 1 ))
DEST="$DEST_DIR/captura-$N.png"

if command -v sips >/dev/null 2>&1; then
  # -Z acota el lado MÁS LARGO: acotar sólo el ancho deja pasar una captura alta y angosta.
  sips -Z "$LADO" -s format png "$ORIGEN" --out "$DEST" >/dev/null 2>&1 \
    || cp "$ORIGEN" "$DEST" || { echo "no se pudo copiar" >&2; exit 3; }
else
  cp "$ORIGEN" "$DEST" || { echo "no se pudo copiar" >&2; exit 3; }
fi

BYTES=$(/usr/bin/stat -f%z "$DEST" 2>/dev/null || /usr/bin/stat -c%s "$DEST" 2>/dev/null || echo 0)

# Se VERIFICA el resultado: si la copia sigue pasada de tamaño, se dice acá y no allá, donde el
# error es "no se pudo procesar la imagen" y manda a buscar la causa a cualquier lado.
if command -v sips >/dev/null 2>&1; then
  W=$(sips -g pixelWidth  "$DEST" 2>/dev/null | awk '/pixelWidth/{print $2}')
  H=$(sips -g pixelHeight "$DEST" 2>/dev/null | awk '/pixelHeight/{print $2}')
  if [ -n "${W:-}" ] && [ -n "${H:-}" ] && { [ "$W" -gt 2000 ] || [ "$H" -gt 2000 ]; }; then
    echo "🔴 la copia quedó en ${W}x${H}: pasa el tope de 2000 px por lado y va a ser rechazada" >&2
    exit 3
  fi
fi

echo "$DEST"
echo "origen: $ORIGEN · ${W:-?}x${H:-?} · $(( BYTES / 1024 )) KB" >&2
[ "${1:-}" = "--finder" ] || [ "${2:-}" = "--finder" ] && open -R "$DEST" 2>/dev/null
exit 0
