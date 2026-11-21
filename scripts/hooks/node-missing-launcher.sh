#!/bin/bash
# node-missing-launcher.sh — el lanzador del freno de publicación (public-push-guard.js) antes de una herramienta.
#
# Sin `node`, el freno no arranca: la herramienta recibe 127 y deja correr el comando sin mirarlo. Este lanzador va
# delante de la línea que registra el instalador (`bash "<este>" node "<…>/public-push-guard.js"`, o con el piso de Node
# o el Node del arnés en lugar de `node`) y hace una sola cosa: ver si el intérprete de esa línea está.
#   · Está: le pasa el control con `exec`, sin tocar la entrada ni la salida.
#   · No está: mira el texto crudo de la entrada con la regla del terreno del freno (un `gh` que publica, o un `push`,
#     la misma que usa el freno cuando no puede revisar un comando). En su terreno sale 2 y dice que falta Node; fuera de
#     él deja pasar y lo dice.
# Es la misma forma que scripts/production/node-shim.sh usa para el freno de producción, con otro terreno. En Windows
# no se registra (la herramienta no lanza ahí los ganchos con este bash de forma medida): queda como límite declarado.
# Casos: scripts/tests/hook-failure-critical.test.js (T14, T15).

if [ "$#" -lt 2 ]; then
  echo "⛔ node-missing-launcher.sh: falta la línea del freno que lanza" >&2
  exit 2
fi

# el intérprete es la primera palabra de la línea: un nombre que se busca en el PATH, o una ruta
runner="$1"
if [ "${runner#*/}" != "$runner" ]; then
  [ -x "$runner" ] && exec "$@"
else
  command -v "$runner" > /dev/null 2>&1 && exec "$@"
fi

raw="$(cat 2>/dev/null)"
gh_publica='(^|[^A-Za-z0-9_.-])gh(\.exe)?["'"'"', 	\\]+(pr|issue|release|api|gist|repo|label)([^A-Za-z0-9_]|$)'
if printf '%s' "$raw" | grep -Eiq "$gh_publica" || printf '%s' "$raw" | grep -q 'push'; then
  echo "⛔ FRENADO — el freno de publicación no pudo arrancar: no encuentro ${runner} (Node). Este comando puede publicar y lo que no se pudo mirar no sale. Instalá Node o reinstalá el arnés." >&2
  exit 2
fi
echo "[public-push-guard] no pude arrancar (no encuentro ${runner}, Node): este comando no publica, así que pasa. Instalá Node o reinstalá el arnés." >&2
exit 0
