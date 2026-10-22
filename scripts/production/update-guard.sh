#!/bin/bash -p
# update-guard.sh — pone al día el freno de producción SIN pedir la contraseña. Casos: scripts/tests/update-guard.test.sh.
#
# Es lo único que el permiso de sudo acotado deja correr como root sin contraseña (la regla la escribe
# `install-guard.sh --allow-auto-update` desde sudoers.tycon-guard.template, y sólo para este guion, sin argumentos). Vive en
# /opt/tycon/setup/, de root, al lado de la copia de root del último instalador verificado; nunca en el HOME ni en el clon.
#
# QUÉ HACE: corre esa copia del instalador en su modo `--auto-update`, con el entorno descartado. Ese modo instala SÓLO la
# versión bajada (~/.tycon/harness) verificada contra GitHub, sólo hacia adelante, sólo si la máquina tiene la marca de
# root que dejó el instalador con la contraseña de su persona y el perfil del equipo dice `guard.update: auto`. No fija un
# origen nuevo ni hace la primera instalación, falla cerrado sin red, toma un candado y deja un renglón de root en
# production/update-log.jsonl. La verificación es UNA sola, la del instalador: este guion no la copia.
#
# 🔴 QUIÉN LO DISPARA NO SE PUEDE ACOTAR (decisión 12): sudo no distingue una sesión de otra, así que cualquier proceso
# del usuario puede correrlo. Lo que acota el daño es lo que hace (idempotente, sólo avanza, sólo lo publicado), no quién
# lo llama.
#
# No acepta argumentos: no hay forma de pasarle de dónde instalar. Ignora el entorno: con sudo sólo pasa SUDO_USER (que
# pone sudo) y un PATH fijo.
#
# Uso:  sudo -n /opt/tycon/setup/update-guard.sh
#       (pruebas, sin root) TYCON_PROD_ROOT=<raíz falsa> … bash update-guard.sh
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$#" -eq 0 ] || { echo "⛔ update-guard.sh no acepta argumentos (recibió $#): no hay forma de elegir de dónde instalar." >&2; exit 2; }
# sudo conserva la carpeta desde donde se lo llama: nada de ahí entra a lo que corre como root
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || { echo "⛔ no pude ubicar la carpeta de update-guard.sh" >&2; exit 2; }
cd / || { echo "⛔ no pude pararme en /" >&2; exit 2; }

if [ "$(id -u)" = "0" ]; then
  INSTALADOR=/opt/tycon/setup/install-guard.sh
  # sólo la copia de root: si este guion no es el de /opt/tycon/setup, no es el que habilita la regla de sudo
  [ "$AQUI" = /opt/tycon/setup ] || { echo "⛔ update-guard.sh corre como root sólo desde /opt/tycon/setup (corre desde $AQUI)." >&2; exit 2; }
  [ -f "$INSTALADOR" ] || { echo "⛔ falta $INSTALADOR: reinstalá el permiso con sudo bash install-guard.sh --allow-auto-update" >&2; exit 1; }
  U="${SUDO_USER:-}"
  [[ "$U" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] && [ "$U" != root ] || { echo "⛔ no sé qué usuario pidió la actualización (SUDO_USER vacío): corrélo con sudo -n desde tu sesión." >&2; exit 1; }
  # que el usuario no pueda cortarlo a mitad (sudo conserva los límites de recursos de quien lo llama, y la terminal
  # manda señales): sin límites y con las señales ignoradas, que se heredan por el exec
  ulimit -f unlimited 2>/dev/null; ulimit -t unlimited 2>/dev/null
  trap '' INT TERM HUP QUIT TSTP XFSZ
  exec /usr/bin/env -i SUDO_USER="$U" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -p "$INSTALADOR" --auto-update
fi

# sin root: sólo las pruebas, sobre una raíz de sistema falsa. Pasan únicamente las variables de las pruebas; las demás
# (TYCON_PROD_ACCEPT_ORIGIN, TYCON_ADO_ORG, TYCON_PROD_ORIGIN_MOVES, el PATH) se descartan como con sudo.
[ -n "${TYCON_PROD_ROOT:-}" ] || { echo "⛔ esto corre con sudo: sudo -n /opt/tycon/setup/update-guard.sh" >&2; exit 2; }
INSTALADOR="$TYCON_PROD_ROOT/opt/tycon/setup/install-guard.sh"
[ -f "$INSTALADOR" ] || { echo "⛔ falta $INSTALADOR (la raíz falsa no tiene el permiso instalado)" >&2; exit 1; }
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="${HOME:-}" TYCON_PROD_ROOT="$TYCON_PROD_ROOT" \
  TYCON_PROD_HARNESS="${TYCON_PROD_HARNESS:-}" TYCON_PROD_STATE="${TYCON_PROD_STATE:-}" TYCON_RELEASE_API="${TYCON_RELEASE_API:-}" \
  TYCON_RELEASE_GIT="${TYCON_RELEASE_GIT:-}" TYCON_PROD_NODE_LOCAL="${TYCON_PROD_NODE_LOCAL:-}" TYCON_PROD_TEST_PATH="${TYCON_PROD_TEST_PATH:-}" \
  /bin/bash -p "$INSTALADOR" --no-sudo --auto-update
