#!/bin/bash -p
# install-guard.sh — instala el freno de producción (story 6.1). Corre con sudo, una vez por
# máquina, y SÓLO en las máquinas de quien está autorizado a tocar producción (hoy DevA y DevB).
#
# QUÉ DEJA INSTALADO, todo de root y fuera del alcance del asistente:
#   /opt/tycon/hooks/prod-access-guard.js           el freno
#   /opt/tycon/lib/ · /opt/tycon/production/        lo que el freno y la puerta requieren
#   /opt/tycon/bin/tycon-prod-sql                   la puerta
#   /opt/tycon/bin/node · /opt/tycon/bin/sqlcmd     el intérprete y el cliente de base (AC 29)
#   /opt/tycon/node-shim.sh · /opt/tycon/huellas.json
#   /opt/tycon/production/installed-files.json      la constancia de lo instalado (la lee el aviso de arranque)
#   /Library/Application Support/ClaudeCode/managed-settings.d/tycon-production.json
#
# EL RENOMBRE A INGLÉS (story 8.9, tanda P · 2026-09-30): hasta el 2026-09-30 esto era scripts/produccion/instalar-freno.sh
# y dejaba /opt/tycon/produccion/ y managed-settings.d/tycon-produccion.json. Una máquina que reinstala pasa sola a los
# nombres nuevos: el origen fijado se lee de la carpeta vieja si la nueva no lo tiene (nunca vuelve a pedir confirmarlo),
# el archivo administrado viejo se respalda y se saca (dos archivos registrarían el freno dos veces), y la carpeta vieja
# de /opt se borra al final. Las opciones viejas se siguen entendiendo (TRADUCIR, abajo). Sin reemplazo en la ruta vieja:
# corre como root, y un reemplazo anota el uso con el node del usuario.
#
# 🔴 COPIA LO PUBLICADO, NO EL DISCO. La primera versión hacía `git fetch` y después copiaba la carpeta
# del clon, que el asistente puede editar: el freno instalado podía ser uno retocado, y la huella de
# referencia salía de ahí (revisores del Step 5, 2026-09-15). Ahora: fetch y `git archive origin/main`
# COMO EL USUARIO (git corriendo como root sobre la configuración del usuario es otra puerta), a una
# carpeta propia, y de ahí se instala. Sin fetch exitoso, no se instala.
#
# `bash -p` y PATH fijo: corre como root, así que nada del entorno ni del PATH del usuario decide qué
# programas se ejecutan.
#
# NO TOCA el managed-settings.json de la organización: la Task 0b midió que un archivo aparte en
# managed-settings.d/ funciona y se SUMA.
#
# 🔴 EL ORIGEN SE FIJA LA PRIMERA VEZ Y DESPUÉS SE COMPARA (story 8.3, revisor de seguridad de la vuelta 2). Desde la
# 8.3 la organización del equipo sale de la configuración, y esa configuración la puede escribir el propio asistente
# (~/.claude/tycon.json, el perfil del equipo del clon): verificar la URL del remoto contra ella ya no alcanza para decir
# «este clon es el del equipo». Lo que el asistente NO puede escribir es /opt/tycon, que es de root: la primera
# instalación deja ahí (`production/trusted-origin.json`) la URL y la organización que una PERSONA aceptó por
# teclado, y cada instalación siguiente exige las mismas. Un cambio se acepta sólo con `--change-origin` y otra
# confirmación por teclado (/dev/tty), que un asistente no tiene.
#
# LA MUDANZA OFICIAL A GITHUB (2026-10-16, decisión del dueño): una máquina que instaló el freno desde el clon de Azure
# tiene ese clon fijado, y la versión bajada de GitHub frenaba pidiendo --change-origin. Las mudanzas oficiales están
# declaradas en `origin-moves.json`, AL LADO DE ESTE GUION (no en la carpeta que se instala: ésa la elige quien corre, y
# una versión de un repo ajeno traería su propia mudanza). Si lo fijado es un `from` y lo de ahora su `to`, se acepta
# solo y se dice; cualquier otro cambio sigue pidiendo --change-origin y el teclado.
#
# LA ACTUALIZACIÓN SIN CONTRASEÑA: `--allow-auto-update` instala, además del freno, un permiso de sudo
# acotado a UN guion sin argumentos (/opt/tycon/setup/update-guard.sh, desde sudoers.tycon-guard.template, validado con
# `visudo -cf` antes de moverlo a /etc/sudoers.d) y la marca de root production/auto-update.json. Se instala sólo si el
# perfil del equipo dice `guard.update: auto` en ese momento: la persona está delante, con su contraseña, y esa marca es lo
# único que habilita la actualización sin contraseña (decisión 19). `--remove-auto-update` saca la regla, el guion y la
# marca. Sin ninguna de las dos, el instalador hace lo de siempre (decisión 11). El guion corre ESTE instalador, desde su
# copia de root en /opt/tycon/setup, en el modo `--auto-update`: sólo la versión bajada verificada contra GitHub, sólo
# hacia adelante, sin preguntar nada por teclado, con candado y un renglón de root en production/update-log.jsonl.
#
# Uso:  sudo bash install-guard.sh [--from <clon del arnés>] [--change-origin]
#       sudo bash install-guard.sh --allow-auto-update | --remove-auto-update
#       bash install-guard.sh --no-sudo         (sólo pruebas, sin root: raíz falsa y copia del disco;
#                                                 TYCON_PROD_ACCEPT_ORIGIN=1 hace de persona que confirma)
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
# la carpeta de este guion, resuelta antes de cualquier cd: de acá sale la lista de mudanzas oficiales del origen
AQUI_GUION="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || { echo "no pude ubicar la carpeta del instalador" >&2; exit 2; }

# Las opciones de antes del renombre a inglés, «vieja:nueva» sin los guiones (las lista el mapa, scripts/lib/renames.json).
# Se traducen acá, en bash y sin node: esto corre como root, y la biblioteca de nombres viejos es código que el usuario
# puede cambiar. Por lo mismo, el uso de un nombre viejo NO se anota.
TRADUCIR='sin-sudo:no-sudo desde:from cambiar-origen:change-origin'
ARGS=(); VISTAS=' '
for a in "$@"; do
  for par in $TRADUCIR; do
    if [ "$a" = "--${par%%:*}" ]; then a="--${par#*:}"; VISTAS="$VISTAS${par#*:}:v "; break; fi
    if [ "$a" = "--${par#*:}" ]; then VISTAS="$VISTAS${par#*:}:n "; break; fi
  done
  ARGS+=("$a")
done
for par in $TRADUCIR; do
  case "$VISTAS" in *" ${par#*:}:v "*)
    case "$VISTAS" in *" ${par#*:}:n "*)
      echo "la misma opción dos veces: --${par%%:*} y --${par#*:} (--${par%%:*} es el nombre viejo de --${par#*:})" >&2; exit 2 ;;
    esac ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

SIN_SUDO=0; ARNES=""; CAMBIAR_ORIGEN=0; PERMISO=""; AUTO=0; CON_FROM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-sudo) SIN_SUDO=1; shift ;;
    --from)    ARNES="${2:-}"; CON_FROM=1; shift 2 ;;
    --change-origin) CAMBIAR_ORIGEN=1; shift ;;
    --allow-auto-update)  [ -z "$PERMISO" ] || { echo "--allow-auto-update y --remove-auto-update se excluyen" >&2; exit 2; }; PERMISO=allow; shift ;;
    --remove-auto-update) [ -z "$PERMISO" ] || { echo "--allow-auto-update y --remove-auto-update se excluyen" >&2; exit 2; }; PERMISO=remove; shift ;;
    --auto-update) AUTO=1; shift ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
# el modo que corre update-guard.sh no elige de dónde instalar ni acepta otro origen, y no instala ni saca el permiso
if [ "$AUTO" = 1 ] && { [ -n "$PERMISO" ] || [ "$CON_FROM" = 1 ] || [ "$CAMBIAR_ORIGEN" = 1 ]; }; then
  echo "--auto-update no va con --from, --change-origin ni las opciones del permiso" >&2; exit 2
fi

muere(){ printf '⛔ %s\n' "$1" >&2; [ "$SIN_SUDO" = 0 ] && sudo -K 2>/dev/null; exit "${2:-1}"; }
ok(){ printf '   %s\n' "$1"; }
# 🔴 desde /, y python con -I: sudo conserva la carpeta desde donde se lo llama, y
# python pone esa carpeta en sys.path, así que un json.py plantado ahí corría como root. Con la actualización sin
# contraseña eso ya no pide una persona. Las rutas que llegan como argumento o variable se hacen absolutas antes.
case "$ARNES" in ""|/*) ;; *) ARNES="$PWD/$ARNES" ;; esac
case "${TYCON_PROD_HARNESS:-}" in ""|/*) ;; *) TYCON_PROD_HARNESS="$PWD/$TYCON_PROD_HARNESS" ;; esac
case "${TYCON_PROD_ROOT:-}" in ""|/*) ;; *) TYCON_PROD_ROOT="$PWD/$TYCON_PROD_ROOT" ;; esac
cd / || muere "no pude pararme en /"

if [ "$SIN_SUDO" = 1 ]; then
  # el modo de pruebas NUNCA corre como root: con sudo instalaría en /opt/tycon sin chequear dueños ni
  # dejar nada de root (revisores del Step 5, 2026-09-15)
  if [ "$(id -u)" = "0" ] || [ "${TYCON_PROD_AS_ROOT:-}" = "1" ]; then muere "--no-sudo es sólo para las pruebas y no corre como root."; fi
  RAIZ="${TYCON_PROD_ROOT:-}"
  [ -n "$RAIZ" ] || muere "--no-sudo necesita TYCON_PROD_ROOT (una raíz de sistema falsa)"
  ARNES="${ARNES:-${TYCON_PROD_HARNESS:-}}"
  [ -n "$ARNES" ] || muere "--no-sudo necesita --from o TYCON_PROD_HARNESS"
  USUARIO=""; HOME_USUARIO=""
else
  [ "$(id -u)" = "0" ] || muere "esto va con sudo: sudo bash $0"
  RAIZ=""
  USUARIO="${SUDO_USER:-}"
  { [ -n "$USUARIO" ] && [ "$USUARIO" != "root" ]; } || muere "no sé qué usuario lanzó la instalación (SUDO_USER vacío): corrélo con sudo desde tu sesión."
  HOME_USUARIO="$(dscl . -read "/Users/$USUARIO" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -d "$HOME_USUARIO" ] || muere "no encuentro la carpeta de $USUARIO"
  # el lugar del arnés que deja el instalador: ~/.claude/tycon-harness y, si no está, el nombre viejo (stories 8.3 y
  # 8.19). Escritos acá: este guion corre con sudo y no carga el árbol (copia declarada en harness-place-names.json)
  if [ -z "${ARNES:-}" ]; then
    # la máquina ya mudada a ~/.tycon (story 8.23, tanda D · AC 30): la versión bajada, que se verifica abajo
    if [ -f "$HOME_USUARIO/.tycon/harness/.tycon-release.json" ]; then ARNES="$HOME_USUARIO/.tycon/harness"; fi
    for _place_name in tycon-harness tycon-claude-guides; do
      [ -n "${ARNES:-}" ] && break
      if [ -d "$HOME_USUARIO/.claude/$_place_name/.git" ]; then ARNES="$HOME_USUARIO/.claude/$_place_name"; break; fi
    done
    ARNES="${ARNES:-$HOME_USUARIO/.claude/tycon-harness}"
  fi
  { [ -d "$ARNES/.git" ] || [ -f "$ARNES/.tycon-release.json" ]; } || muere "no encuentro el arnés en $ARNES: ni un clon (.git) ni una versión bajada (.tycon-release.json) — pasalo con --from <ruta>"
fi
# la HOME que se lee (con sudo, la del usuario que lanzó; sin sudo —las pruebas— la de quien corre) y, escrita UNA sola
# vez, su carpeta de Claude Code: la configuración de la máquina y el estado viejo se buscan ahí (tycon-home T3)
HOME_LEIDA="${HOME_USUARIO:-${HOME:-}}"; CLAUDE_LEIDA="$HOME_LEIDA/.claude"

# ── la actualización sin contraseña: lo que se decide ANTES de verificar o tocar nada ───────────────────────
DESTINO="$RAIZ/opt/tycon"
SUDOERS_D="$RAIZ/etc/sudoers.d"; REGLA="$SUDOERS_D/tycon-guard"; MARCA="$DESTINO/production/auto-update.json"
REGISTRO_AUTO="$DESTINO/production/update-log.jsonl"; INSTALADA="$DESTINO/production/installed-release.json"
CANDADO="$DESTINO/production/update.lock"; CANDADO_MIO=0; COPIA_AUTO=""; ORIGEN=""
limpiar(){ [ -n "$ORIGEN" ] && rm -rf "$ORIGEN"; [ -n "$COPIA_AUTO" ] && rm -rf "$COPIA_AUTO"; [ "$CANDADO_MIO" = 1 ] && rm -rf "$CANDADO"; return 0; }
trap limpiar EXIT
# lo que eligió la organización (guard.update del perfil del equipo), leído con python y sin cargar código del árbol, como
# ado.org → «auto», «password», «missing-key», «roto <motivo>», «ilegible <motivo>» o «ausente»
leer_guard_update(){ # $1 = carpeta del arnés
  local perfil="$1/team-profile.json"; [ -f "$perfil" ] || perfil="$1/perfil-equipo.json"
  /usr/bin/python3 -I -c 'import json, sys
ruta = sys.argv[1]
try:
    f = open(ruta, encoding="utf-8-sig")   # con o sin BOM, como el lector del arnés
except FileNotFoundError:
    print("ausente"); sys.exit(0)
except Exception as e:
    print("ilegible %s: %s" % (ruta, e)); sys.exit(0)
with f:
    try: d = json.load(f)
    except Exception as e: print("ilegible %s: JSON ilegible (%s)" % (ruta, e)); sys.exit(0)
g = d.get("guard") if isinstance(d, dict) else None
if g is None or (isinstance(g, dict) and "update" not in g): print("missing-key"); sys.exit(0)
v = g.get("update") if isinstance(g, dict) else None
if isinstance(v, str): v = v.strip()   # el lector del arnés recorta el valor: los dos leen igual
if v in ("auto", "password"): print(v)
else: print("roto en %s: guard.update vale %s y sólo puede ser password o auto" % (ruta, json.dumps(v, ensure_ascii=False)))' "$perfil"
}
# el motivo, en llano, cuando lo que eligió la organización no es «auto» ($1 = lo que dijo leer_guard_update)
motivo_eleccion(){
  case "$1" in
    password) echo "la organización eligió «con la contraseña» (guard.update: password en el perfil del equipo)" ;;
    missing-key) echo "la organización no eligió nada (sin guard.update en el perfil del equipo): de fábrica es «con la contraseña»" ;;
    roto*) echo "guard.update está roto (${1#roto }): lo trato como «con la contraseña»" ;;
    *) echo "no pude leer lo que eligió la organización (${1#ilegible }): lo trato como «con la contraseña»" ;;
  esac
}
COMO_CAMBIARLO="se cambia en el sitio de la organización, pestaña Configuración → «Cómo se actualiza el freno de producción»"

# sacar el permiso: la regla primero (sudo deja de permitirlo), después el guion, sus vecinos y la marca; nada se verifica
if [ "$PERMISO" = remove ]; then
  rm -f "$REGLA" || muere "no pude sacar la regla de sudo $REGLA"
  rm -f "$DESTINO/setup/update-guard.sh" "$DESTINO/setup/install-guard.sh" "$DESTINO/setup/origin-moves.json" || muere "no pude sacar el guion de $DESTINO/setup"
  rm -f "$MARCA" || muere "no pude sacar la marca $MARCA"
  echo "✅ actualización sin contraseña sacada: la regla de sudo, el guion y la marca. El freno vuelve a pedir la contraseña para ponerse al día."
  [ "$SIN_SUDO" = 0 ] && sudo -K 2>/dev/null
  exit 0
fi

# el modo de update-guard.sh: sólo con la marca de root, sólo la versión bajada, sólo con un origen ya fijado, sólo si el
# perfil dice «auto», y una corrida a la vez. Lo verificado es una COPIA de root de la versión bajada: lo que hay en el HOME
# puede cambiar entre la verificación y la copia, la copia no
if [ "$AUTO" = 1 ]; then
  [ -d "$DESTINO/production" ] || muere "esta máquina no tiene el freno instalado: la primera instalación pide contraseña (sudo bash install-guard.sh)"
  if ! mkdir "$CANDADO" 2>/dev/null; then
    OTRO="$(cat "$CANDADO/pid" 2>/dev/null || true)"
    if [[ "$OTRO" =~ ^[0-9]+$ ]] && kill -0 "$OTRO" 2>/dev/null; then muere "ya hay una actualización corriendo (proceso $OTRO): no hago nada"; fi
    # sin pid puede ser otra corrida que acaba de tomarlo y todavía no lo escribió: vale como viva hasta que pase un minuto
    if [ -z "$OTRO" ] && [ -z "$(/usr/bin/find "$CANDADO" -maxdepth 0 -mmin +1 -print 2>/dev/null)" ]; then muere "ya hay una actualización corriendo (el candado se acaba de tomar): no hago nada"; fi
    rm -rf "$CANDADO" && mkdir "$CANDADO" 2>/dev/null || muere "no pude tomar el candado $CANDADO"
    ok "candado de una actualización que ya no corre (proceso ${OTRO:-?}): liberado"
  fi
  CANDADO_MIO=1; printf '%s\n' "$$" > "$CANDADO/pid" || muere "no pude escribir el candado $CANDADO"
  [ -f "$MARCA" ] || muere "esta máquina no tiene el permiso de actualizarse sin contraseña: lo instala su persona con sudo bash install-guard.sh --allow-auto-update (pide su contraseña)"
  { [ -f "$DESTINO/production/trusted-origin.json" ] || [ -f "$DESTINO/produccion/origen-de-confianza.json" ]; } \
    || muere "no hay origen de confianza fijado: la primera instalación pide contraseña (sudo bash install-guard.sh)"
  [ "$SIN_SUDO" = 0 ] && ARNES="$HOME_USUARIO/.tycon/harness"
  { [ -f "$ARNES/.tycon-release.json" ] && [ ! -d "$ARNES/.git" ]; } \
    || muere "la actualización sin contraseña instala sólo la versión bajada y verificada (~/.tycon/harness), nunca un clon ($ARNES)"
  # 🔴 sin enlaces (pase adversarial de la vuelta 1): cp -RP copia un enlace como enlace, y lo que se verifica y lo que
  # se copia después seguirían pasando por un archivo del usuario, que puede cambiarlo entre las dos lecturas
  [ -L "$ARNES" ] && muere "la versión bajada ($ARNES) es un enlace simbólico: la actualización sin contraseña no lo sigue"
  COPIA_AUTO="$(/usr/bin/mktemp -d)" || muere "no pude crear una carpeta temporal"
  /bin/cp -RP "$ARNES" "$COPIA_AUTO/harness" || muere "no pude copiar la versión bajada ($ARNES)"
  # un find que falla es «no sé», nunca «sin enlaces»
  ENLACES="$(/usr/bin/find "$COPIA_AUTO/harness" -type l -print)" || muere "no pude revisar si la versión bajada trae enlaces simbólicos"
  ENLACES="$(printf '%s\n' "$ENLACES" | /usr/bin/head -3)"
  [ -z "$ENLACES" ] || muere "la versión bajada trae enlaces simbólicos (${ENLACES//$COPIA_AUTO\/harness\//}): la actualización sin contraseña no los sigue"
  ESTADO_AUTO="${TYCON_PROD_STATE:-}"
  if [ "$SIN_SUDO" = 0 ] || [ -z "$ESTADO_AUTO" ]; then
    if [ -f "$HOME_LEIDA/.tycon/state/harness-state.json" ]; then ESTADO_AUTO="$HOME_LEIDA/.tycon/state/harness-state.json"; else ESTADO_AUTO="$CLAUDE_LEIDA/.tycon-pipeline/harness-state.json"; fi
  fi
  /bin/cp "$ESTADO_AUTO" "$COPIA_AUTO/harness-state.json" 2>/dev/null || muere "no pude copiar el estado del arnés ($ESTADO_AUTO): sin él no sé de qué repo se bajó la versión"
  ARNES="$COPIA_AUTO/harness"; ESTADO_AUTO="$COPIA_AUTO/harness-state.json"
  ELECCION="$(leer_guard_update "$ARNES")"
  [ "$ELECCION" = auto ] || muere "$(motivo_eleccion "$ELECCION"): no actualizo sin contraseña — $COMO_CAMBIARLO"
fi

# instalar el permiso: sólo si la organización eligió «solo» (la persona está delante, con su contraseña)
if [ "$PERMISO" = allow ]; then
  ELECCION="$(leer_guard_update "$ARNES")"
  [ "$ELECCION" = auto ] || muere "$(motivo_eleccion "$ELECCION"): no instalo el permiso de actualizar sin contraseña — $COMO_CAMBIARLO, y después se vuelve a correr esto"
fi

# ── 0a. de dónde se instala (story 8.23, tanda D · AC 30): el clon, con git (lo de siempre, abajo), o la VERSIÓN BAJADA ──
# en ~/.tycon/harness, VERIFICADA antes de copiar. 🔴 Todo lo que hay en el HOME lo puede escribir el asistente —los
# archivos bajados, su manifiesto (.tycon-release.json) y el estado de la máquina—, así que compararlos entre sí no alcanza
# (revisor de seguridad de la tanda D: editar un archivo y recalcular su blob en el manifiesto pasaba). Lo que el asistente
# NO puede escribir es GitHub: se recalcula el árbol de git de la carpeta desde el disco (sin cargar código del árbol: ese
# código es lo que se verifica), se compara con el árbol del commit que registra el estado SEGÚN GITHUB (la API, con el
# permiso de la persona si lo tiene guardado), y ese commit tiene que ser la punta publicada (main, o mirror/sync) o un
# commit anterior de main con el freno igual al de la punta (instala y avisa que hay una versión más nueva). Sin red,
# sin permiso para ver el repo, con un árbol distinto, con un commit fuera de main o con un freno viejo: no se instala, y
# se dice. El origen de
# confianza pasa a ser el repo de GitHub y queda fijado con `repo` (así `doctor` sabe que este freno ya es el de la mudanza).
# TYCON_RELEASE_API cambia la API (sólo pruebas: el servidor de versiones de juguete); con sudo el entorno viene limpio.
# Sin permiso guardado (story 8.34), las puntas de main y mirror/sync salen de la página pública `info/refs` de github.com
# (lo que lee `git ls-remote`, leída con urllib: sin git y sin gastar el tope de la API, 60 consultas por hora por
# conexión); a la API le quedan el commit (1 consulta) y, con una versión atrasada, la comparación y el árbol de la punta.
# Con permiso, todo por la API, como antes. TYCON_RELEASE_GIT cambia github.com (sólo pruebas, como TYCON_RELEASE_API).
# Lo que se copia a /opt (el freno, la puerta y lo que requieren). Escrito ANTES de 0a: con una versión bajada atrasada,
# 0a exige que estos archivos sean byte a byte los de la punta de main (paso 5 del python).
# 🔴 LA COPIA PROPIA (2026-10-14, decisión del dueño): las bibliotecas que el freno carga salen de
# scripts/production/guard-libs/, no de scripts/lib/ ni de scripts/setup/harness/. Las compartidas cambian casi todos los días
# por motivos que no son del freno, y cada cambio pedía reinstalar con la contraseña del Mac. La copia cambia sólo cuando
# alguien lo decide (scripts/production/guard-libs-check.js); en /opt quedan donde siempre (lib/, setup/harness/), así el
# freno instalado las encuentra por las mismas rutas relativas.
ARCHIVOS=(
  scripts/hooks/prod-access-guard.js
  scripts/hooks/prod-firewall-close.js
  scripts/production/guard-libs/lib/shell-parse.js
  scripts/production/guard-libs/lib/repos-root.js
  scripts/production/guard-libs/lib/tycon-config.js
  scripts/production/guard-libs/lib/skills-dir.js
  scripts/production/guard-libs/lib/guard-record.js
  scripts/production/guard-libs/lib/legacy-names.js
  scripts/production/production-index.js
  scripts/production/tycon-prod-sql
  scripts/production/node-shim.sh
  scripts/production/load-key.command.template
  scripts/production/managed-settings.tycon-production.json.template
  scripts/production/node-official.json
  scripts/production/guard-libs/setup/harness/tycon-home.js
)
# El mapa de nombres viejos (story 8.9): lo exige el arnés del equipo (el que trae su perfil, team-profile.json o
# perfil-equipo.json, el nombre de antes) —sin él la copia de
# /opt leería sólo los nombres nuevos, callada—; la copia pública no lo lleva a propósito (nace con los nombres nuevos y
# legacy-names.js sin mapa es paso directo), así que ahí no se pide. Lo decide lo publicado (o el disco en --no-sudo),
# nunca un archivo de la máquina. Tanda C0, [DEF-8.9-COPIA]: era el T25 de la copia. Lo cuida T19p de instalar-freno.test.sh.
MAPA_NOMBRES=scripts/lib/renames.json
# Lo que va a /opt/tycon/setup para la actualización sin contraseña: el guion, este instalador y la lista de
# mudanzas que lee. Se copian (y se exigen iguales a los de la punta, como el freno) sólo con el permiso: al instalarlo, en
# el modo que corre el guion, y en cada reinstalación de una máquina que ya tiene la marca. La plantilla de la regla se usa
# desde la copia verificada y no queda en /opt.
SETUP_ARCHIVOS=(scripts/production/update-guard.sh scripts/production/install-guard.sh scripts/production/origin-moves.json scripts/production/sudoers.tycon-guard.template)
CON_SETUP=0; { [ "$PERMISO" = allow ] || [ "$AUTO" = 1 ] || [ -f "$MARCA" ]; } && CON_SETUP=1
extras_de_setup() { [ "$CON_SETUP" = 1 ] && printf '%s\n' "${SETUP_ARCHIVOS[@]}"; return 0; }
# en el modo del guion, el commit instalado (production/installed-release.json, de root): la versión bajada tiene que ser
# posterior; igual, no hay nada que hacer
PREVIO_COMMIT=""; PREVIO_VERSION=""
# Sin la constancia (un freno instalado desde un clon, o antes de que existiera) no hay contra qué comparar: rige la regla
# de siempre del paso 5 (la punta, o un commit anterior de main con el freno igual al de la punta), se dice, y desde esta
# actualización queda la constancia.
if [ "$AUTO" = 1 ] && [ ! -f "$INSTALADA" ]; then ok "sin constancia de la versión instalada: sólo puedo exigir que lo bajado sea la punta publicada (o tenga su mismo freno); desde ahora queda anotada"; fi
if [ "$AUTO" = 1 ] && [ -f "$INSTALADA" ]; then
  PREVIO_COMMIT="$(/usr/bin/python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); c=str(d.get("commit") or ""); print(c if len(c)==40 and all(x in "0123456789abcdef" for x in c) else "")' "$INSTALADA" 2>/dev/null)" \
    || muere "la constancia de la versión instalada ($INSTALADA) está ilegible (la escribe sólo root): sin ella no sé si la nueva avanza — reinstalá con sudo bash install-guard.sh"
  # un commit que no tiene forma de commit es una constancia rota, no «sin constancia»: apagaría «sólo avanza» callado
  [ -n "$PREVIO_COMMIT" ] || muere "la constancia de la versión instalada ($INSTALADA) está ilegible: no trae un commit — reinstalá con sudo bash install-guard.sh"
  PREVIO_VERSION="$(/usr/bin/python3 -I -c 'import json,sys; print(str(json.load(open(sys.argv[1])).get("version") or ""))' "$INSTALADA" 2>/dev/null || true)"
fi
DESDE_RELEASE=0; REPO_GITHUB=""
if [ -f "$ARNES/.tycon-release.json" ] && [ ! -d "$ARNES/.git" ]; then
  DESDE_RELEASE=1
  # el estado vive en ~/.tycon/state en una máquina mudada o sin Claude Code, y donde siempre en una instalada con
  # `install --version` CON Claude Code (pase adversarial de la D, clase 13): se mira donde esté
  ESTADO_RELEASE="${ESTADO_AUTO:-${TYCON_PROD_STATE:-}}"
  if [ -z "$ESTADO_RELEASE" ]; then
    if [ -f "$HOME_LEIDA/.tycon/state/harness-state.json" ]; then ESTADO_RELEASE="$HOME_LEIDA/.tycon/state/harness-state.json"; else ESTADO_RELEASE="$CLAUDE_LEIDA/.tycon-pipeline/harness-state.json"; fi
  fi
  LISTA_VERIFICADA="$(/usr/bin/mktemp)" || muere "no pude crear un archivo temporal"
  # la API de GitHub: con sudo, SIEMPRE la real (TYCON_RELEASE_API es sólo de las pruebas: un asistente no puede
  # apuntar la verificación a un servidor propio); el ancla contra «un repo ajeno que GitHub verifica igual» es la misma que
  # en el modo clon: el origen lo confirma UNA PERSONA por teclado la primera vez y queda fijado en /opt (root); cualquier
  # otro repo después exige --change-origin y otra confirmación por teclado (revisor de seguridad de la D, vuelta 2)
  if [ "$SIN_SUDO" = 0 ]; then API_GITHUB="https://api.github.com"; else API_GITHUB="${TYCON_RELEASE_API:-https://api.github.com}"; fi
  # github.com (las puntas sin la API, story 8.34): con sudo, SIEMPRE el real. Una API de juguete sin un github.com de
  # juguete no tiene rutas públicas (la salvaguarda de public-git.js): las puntas salen de la API, como antes
  if [ "$SIN_SUDO" = 0 ]; then GIT_GITHUB="https://github.com"
  elif [ -n "${TYCON_RELEASE_API:-}" ] && [ -z "${TYCON_RELEASE_GIT:-}" ]; then GIT_GITHUB=""
  else GIT_GITHUB="${TYCON_RELEASE_GIT:-https://github.com}"; fi
  # (2>&1: el motivo de python viaja en la variable, así `muere` lo imprime; cazador de fallos silenciosos de la D)
  # shellcheck disable=SC2046
  REPO_GITHUB="$(/usr/bin/python3 -I - "$ARNES" "$ESTADO_RELEASE" "$API_GITHUB" "$HOME_LEIDA/.tycon/config.json" "$LISTA_VERIFICADA" "$GIT_GITHUB" "$PREVIO_COMMIT" "${ARCHIVOS[@]}" "$MAPA_NOMBRES" $(extras_de_setup) 2>&1 <<'PY'
import hashlib, json, os, re, sys, time, urllib.request, urllib.error
arnes, estado, api, token_file, lista, gitbase, previo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]
freno = sys.argv[8:]   # lo que se copia a /opt (ARCHIVOS, el mapa de nombres y lo de setup): tiene que ser igual al de la punta (paso 5)
def muere(m): sys.stderr.write(m + "\n"); sys.exit(2)
try:
    with open(os.path.join(arnes, ".tycon-release.json"), encoding="utf-8") as f: m = json.load(f)
except Exception as e: muere("el manifiesto de la versión bajada (%s/.tycon-release.json) no se lee: %s" % (arnes, e))
files = m.get("files") if isinstance(m, dict) else None
if not isinstance(files, list) or not isinstance(m.get("tree"), str): muere("el manifiesto de la versión bajada no trae files/tree")
# 1. cada archivo del disco contra su blob de git (editado o faltante → frena nombrándolo)
malos, entradas = [], []
for f in files:
    rel, blob, mode = (f.get("path"), f.get("blob"), str(f.get("mode") or "100644")) if isinstance(f, dict) else (None, None, None)
    if not isinstance(rel, str) or not isinstance(blob, str) or rel.startswith("/") or ".." in rel.split("/"): muere("el manifiesto trae una entrada inválida: %r" % (f,))
    p = os.path.join(arnes, *rel.split("/"))
    # un archivo que no es enlace en la versión tiene que leerse sin pasar por ninguno: si no, lo verificado y lo copiado
    # después pueden ser cosas distintas (story 8.88)
    if mode != "120000" and os.path.realpath(p) != os.path.join(os.path.realpath(arnes), *rel.split("/")):
        malos.append(rel + " (es un enlace o pasa por uno)"); continue
    try:
        if mode == "120000": data = os.readlink(p).encode("utf-8")
        else:
            with open(p, "rb") as fh: data = fh.read()
    except Exception: malos.append(rel + " (falta)"); continue
    h = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    if h != blob: malos.append(rel + " (editado)")
    entradas.append((mode, rel, h))
if malos: muere("la versión bajada en %s NO es la publicada — %s: una edición local no se instala como freno" % (arnes, ", ".join(malos[:5]) + (" (+%d)" % (len(malos) - 5) if len(malos) > 5 else "")))
# 2. el árbol de git RECALCULADO desde el disco (no el que dice el manifiesto: ése también vive en el HOME)
def tree_of(items):
    hijos, carpetas = {}, {}
    for mode, rel, h in items:
        head, _, tail = rel.partition("/")
        if tail: carpetas.setdefault(head, []).append((mode, tail, h))
        else: hijos[head] = (mode, h)
    entries = [(name, hijos[name][0], hijos[name][1]) for name in hijos] + [(name, "40000", tree_of(carpetas[name])) for name in carpetas]
    entries.sort(key=lambda e: (e[0] + "/") if e[1] == "40000" else e[0])   # git ordena con las carpetas como si llevaran «/»
    body = b"".join(("%s %s\0" % (mode, name)).encode("utf-8") + bytes.fromhex(sha) for name, mode, sha in entries)
    return hashlib.sha1(b"tree %d\0" % len(body) + body).hexdigest()
arbol = tree_of(entradas)
if arbol != m.get("tree"): muere("el árbol de la versión bajada recalculado desde el disco (%s) no es el del manifiesto (%s): la carpeta no es la que se bajó" % (arbol[:7], str(m.get("tree"))[:7]))
# 3. el estado de la máquina: de qué repo y de qué commit se bajó
try:
    with open(estado, encoding="utf-8") as f: s = json.load(f)
except Exception as e: muere("el estado del arnés (%s) no se lee: %s — sin él no sé de qué repo se bajó la versión" % (estado, e))
src = next((x for x in (s.get("sources") or []) if isinstance(x, dict) and x.get("kind") == "release"), None) if isinstance(s, dict) else None
if not src: muere("el estado del arnés (%s) no registra una versión bajada: ¿la mudanza terminó?" % estado)
if src.get("tree") != arbol: muere("el árbol de la versión bajada (%s) no es el que registra el estado (%s): la carpeta no es la que se instaló" % (arbol[:7], str(src.get("tree"))[:7]))
commit = str(src.get("commit") or "")
if not re.match(r"^[0-9a-f]{40}$", commit): muere("el estado no registra el commit de la versión bajada")
url = str(src.get("url") or "")
mm = re.match(r"^https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$", url)
if not mm: muere("el estado registra un origen que no es un repo de GitHub por https (%s)" % url)
repo = "%s/%s" % (mm.group(1), mm.group(2))
# 4. 🔴 GitHub: el commit del estado tiene que existir en el repo con ESTE árbol y ser la punta publicada
token = ""
try:
    with open(token_file, encoding="utf-8") as f: j = json.load(f)
    token = str(((j or {}).get("github") or {}).get("token") or "").strip()
except Exception: token = ""
vencido = [False]   # el permiso guardado contestó 401 y el repo se leyó sin él: va en la tercera línea de la salida
def lee_sin_permiso():
    # ¿el repo se lee sin permiso? `info/refs` sin credencial contesta 200 (2026-10-14: un permiso vencido contra el repo público)
    if not gitbase: return False
    req = urllib.request.Request(gitbase.rstrip("/") + "/" + repo + ".git/info/refs?service=git-upload-pack", headers={"User-Agent": "tycon-install-guard"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status == 200
    except Exception: return False
def get(route):
    global token
    req = urllib.request.Request(api.rstrip("/") + route, headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tycon-install-guard"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # el tope de la API (story 8.34): se dice hasta qué hora, en hora local, en vez de «GitHub contestó 403»
        if e.code == 403 and str(e.headers.get("X-RateLimit-Remaining")) == "0":
            try: hora = time.strftime("%H:%M", time.localtime(int(e.headers.get("X-RateLimit-Reset"))))
            except Exception: hora = "dentro de una hora"
            muere("GitHub limita las consultas %s hasta las %s: no instalo el freno; volvé a correrlo después de esa hora" % ("de tu permiso" if token else "sin permiso de esta conexión", hora))
        # un permiso guardado que venció (401) y el repo se lee sin él: se sigue SIN el permiso (el resto, por info/refs) y se dice
        if e.code == 401 and token and lee_sin_permiso():
            token = ""; vencido[0] = True
            return get(route)
        return e.code, None
    except Exception as e: muere("no pude preguntarle a GitHub por el repo %s (%s): sin eso no instalo — el disco lo puede tocar el asistente" % (repo, e))
def puntas_publicas():
    # las ramas de `info/refs` (pkt-line de git), sin la API: {rama: sha}, o None si github.com no contesta o no es git
    req = urllib.request.Request(gitbase.rstrip("/") + "/" + repo + ".git/info/refs?service=git-upload-pack", headers={"User-Agent": "tycon-install-guard"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: body = r.read().decode("latin-1")
    except urllib.error.HTTPError as e:
        if e.code in (401, 404): muere("github.com no muestra %s (%s): el repo no está o no es público — sin permiso guardado no lo veo (harness.js config set github.token)" % (repo, e.code))
        return None
    except Exception: return None
    if not body.startswith("001e# service=git-upload-pack\n0000"): return None
    return {m.group(2): m.group(1) for m in re.finditer(r"([0-9a-f]{40}) refs/heads/([^\0\n]+)", body)}
st, c = get("/repos/%s/git/commits/%s" % (repo, commit))
if st == 404: muere("GitHub no encuentra el commit %s en %s (404): sin permiso guardado, el permiso no ve el repo, o el commit no existe — harness.js config set github.token, y harness.js doctor" % (commit[:7], repo))
if st != 200 or not isinstance(c, dict): muere("GitHub contestó %s al pedir el commit %s de %s: no instalo" % (st, commit[:7], repo))
gh_tree = str(((c.get("tree") or {}).get("sha")) or "")
if gh_tree != arbol: muere("el árbol de la carpeta (%s) NO es el del commit %s en GitHub (%s): la carpeta no es lo publicado, no se instala como freno" % (arbol[:7], commit[:7], gh_tree[:7]))
puntas = {}
# sin permiso, las puntas de UN pedido a info/refs (story 8.34); si github.com no contesta o no es git, por la API
publicas = puntas_publicas() if gitbase and not token else None
if publicas is not None:
    puntas = {ref: publicas[ref] for ref in ("main", "mirror/sync") if ref in publicas}
else:
    for ref in ("main", "mirror/sync"):
        st2, r = get("/repos/%s/git/ref/heads/%s" % (repo, ref))
        if st2 == 200 and isinstance(r, dict): puntas[ref] = str(((r.get("object") or {}).get("sha")) or "")
if not puntas: muere("GitHub no me dio la punta de main de %s: no instalo" % repo)
# 5. 🔴 un commit PUBLICADO de main: la punta, o uno anterior de main con el MISMO freno que la punta (2026-10-14).
# Antes se exigía la punta exacta, y en un día de 30 publicaciones el freno no se podía instalar. Lo que la regla cuida
# sigue en pie: (a) que el commit sea de main y no de una rama ni de un fork — GitHub sirve /git/commits/<sha> de
# cualquier rama, y también de los forks, así que «existe y tiene este árbol» no alcanza: lo dice la comparación con la
# punta, «behind» o «identical», con la base de la comparación igual al commit; (b) que no se instale un freno VIEJO
# —una versión publicada antes de un arreglo del freno sigue verificando contra GitHub, y el asistente la puede bajar—:
# los archivos que se copian a /opt tienen que ser byte a byte los de la punta. Atrasado con el mismo freno: instala y
# avisa. Cualquier respuesta que no sea ésa (GitHub no contesta, 403, lista cortada): frena.
aviso = ""
if commit not in puntas.values():
    punta = puntas.get("main") or ""
    if not re.match(r"^[0-9a-f]{40}$", punta): muere("GitHub no me dio la punta de main de %s (sólo %s): la versión instalada (%s) no es la punta publicada y sin main no sé si es de main — no instalo" % (repo, ", ".join("%s %s" % (k, v[:7]) for k, v in puntas.items()), commit[:7]))
    st3, cmp_ = get("/repos/%s/compare/%s...%s?per_page=1" % (repo, punta, commit))
    if st3 != 200 or not isinstance(cmp_, dict): muere("GitHub contestó %s al comparar la versión instalada (%s) con la punta de main (%s) de %s: sin saber si es un commit publicado de main no instalo" % (st3, commit[:7], punta[:7], repo))
    estado_cmp = str(cmp_.get("status") or "")
    base_cmp = str(((cmp_.get("merge_base_commit") or {}).get("sha")) or "")
    if estado_cmp not in ("behind", "identical") or base_cmp != commit: muere("la versión instalada (%s) NO es un commit publicado de main de %s (GitHub: «%s» respecto de la punta %s): una rama o un cambio local no se instala como freno — actualizá el arnés (harness.js update) y volvé a instalar el freno" % (commit[:7], repo, estado_cmp or "sin estado", punta[:7]))
    arbol_punta = str(((((cmp_.get("base_commit") or {}).get("commit") or {}).get("tree") or {}).get("sha")) or "")
    if not re.match(r"^[0-9a-f]{40}$", arbol_punta): muere("GitHub no me dio el árbol de la punta de main (%s) de %s: no puedo comparar el freno con el de la punta — no instalo" % (punta[:7], repo))
    st4, t = get("/repos/%s/git/trees/%s?recursive=1" % (repo, arbol_punta))
    if st4 != 200 or not isinstance(t, dict) or not isinstance(t.get("tree"), list): muere("GitHub contestó %s al pedir el árbol de la punta de main (%s) de %s: no puedo comparar el freno con el de la punta — no instalo" % (st4, punta[:7], repo))
    if t.get("truncated") is not False: muere("GitHub me dio el árbol de la punta de main (%s) de %s cortado: no puedo comparar el freno con el de la punta — no instalo" % (punta[:7], repo))
    en_punta = {str(e.get("path")): str(e.get("sha")) for e in t["tree"] if isinstance(e, dict) and e.get("type") == "blob"}
    locales = {rel: h for _, rel, h in entradas}
    distintos = [p for p in freno if locales.get(p) != en_punta.get(p)]
    if distintos: muere("la versión instalada (%s) es de main pero VIEJA, y el freno cambió desde entonces en la punta (%s): %s — actualizá el arnés (harness.js update) y volvé a instalar el freno" % (commit[:7], punta[:7], ", ".join(distintos[:5]) + (" (+%d)" % (len(distintos) - 5) if len(distintos) > 5 else "")))
    atras = cmp_.get("behind_by")
    aviso = "hay una versión más nueva de %s (main %s%s); el freno que se instala es igual al de esa versión. Actualizá cuando puedas (harness.js update)" % (repo, punta[:7], (", %d commit%s adelante" % (atras, "" if atras == 1 else "s")) if isinstance(atras, int) else "")
# la lista de lo verificado: sólo eso se copia (un archivo que está en el disco y no en el manifiesto no es de la versión)
# 6. sólo hacia adelante (story 8.88, el modo de update-guard.sh): con un commit ya instalado, el bajado tiene que ser
# posterior según GitHub; el mismo commit es «nada que hacer». Cualquier otra respuesta frena
avance = "nuevo"
if previo:
    if previo == commit: avance = "igual"
    else:
        st5, c5 = get("/repos/%s/compare/%s...%s?per_page=1" % (repo, previo, commit))
        if st5 != 200 or not isinstance(c5, dict): muere("GitHub contestó %s al comparar la versión instalada (%s) con la bajada (%s) de %s: sin saber si avanza no instalo" % (st5, previo[:7], commit[:7], repo))
        if str(c5.get("status") or "") != "ahead": muere("la versión bajada (%s) no es posterior a la instalada (%s) — GitHub: «%s»: el freno sólo avanza, nunca retrocede" % (commit[:7], previo[:7], c5.get("status") or "sin estado"))
        avance = "adelante"
with open(lista, "w", encoding="utf-8") as f: f.write("".join(rel + "\n" for _, rel, _ in entradas))
print(repo)
print(aviso or "")
print("el permiso de GitHub guardado venció o se revocó (401), pero no hace falta: el repo del arnés es público y sigo sin él. Para sacarlo: harness.js config unset github.token" if vencido[0] else "")
# la versión del manifiesto sólo se muestra (va al registro): lo verificado es el commit y su árbol
print("%s %s %s" % (avance, commit, re.sub(r"\s", "", str(m.get("version") or "?")) or "?"))
PY
)" || muere "$REPO_GITHUB"
  # la primera línea es el repo; la segunda, si la hay, el aviso de una versión atrasada con el mismo freno que la punta; la
  # tercera, si la hay, que el permiso guardado venció y el repo público se leyó sin él (2026-10-14)
  AVISO_ATRASADA="$(printf '%s\n' "$REPO_GITHUB" | sed -n 2p)"
  AVISO_VENCIDO="$(printf '%s\n' "$REPO_GITHUB" | sed -n 3p)"
  read -r AVANCE COMMIT_BAJADO VERSION_BAJADA <<< "$(printf '%s\n' "$REPO_GITHUB" | sed -n 4p)"
  REPO_GITHUB="$(printf '%s\n' "$REPO_GITHUB" | sed -n 1p)"
  [ -n "$REPO_GITHUB" ] || muere "no pude saber de qué repo de GitHub se bajó la versión"
  if [ "$AUTO" = 1 ] && [ "${AVANCE:-}" = igual ]; then
    ok "sin versión nueva: el freno ya está en ${COMMIT_BAJADO:0:7} (${VERSION_BAJADA:-?}); no cambio nada"
    exit 0
  fi
  URL="https://github.com/$REPO_GITHUB"
  ORG="github:$REPO_GITHUB"
  if [ -n "$AVISO_ATRASADA" ]; then
    ok "arnés: la versión bajada en $ARNES, verificada contra su manifiesto, el estado y GitHub (repo $REPO_GITHUB: el árbol del commit, que es un commit publicado de main)"
    echo "   ⚠ $AVISO_ATRASADA"
  else
    ok "arnés: la versión bajada en $ARNES, verificada contra su manifiesto, el estado y GitHub (repo $REPO_GITHUB: el árbol del commit, que es la punta publicada)"
  fi
  [ -n "$AVISO_VENCIDO" ] && echo "   ⚠ $AVISO_VENCIDO"
fi

MANAGED_PADRE="$RAIZ/Library/Application Support/ClaudeCode"
MANAGED_D="$MANAGED_PADRE/managed-settings.d"
CON_MAPA=0
# Un freno instalado antes de la story 8.7 carga la biblioteca de constancias por su nombre de antes (story 8.9, tanda C1:
# así el freno no cambió y nadie reinstaló por el renombre); el de hoy la busca primero por su nombre nuevo y, si falta,
# por el de antes. En /opt la biblioteca queda copiada con los dos nombres, así cualquiera de los dos frenos la encuentra:
# en el repo el nombre de antes es un reemplazo, que la copia pública no lleva y que un arnés de laboratorio puede no tener.
NOMBRE_VIEJO_CONSTANCIA=lib/constancia-freno.js
extras_del_equipo() { [ "$CON_MAPA" = 1 ] && echo "$MAPA_NOMBRES"; }

# ── 0. el arnés PUBLICADO, a una carpeta propia ───────────────────────────────────────────────
ORIGEN="$(mktemp -d)" || muere "no pude crear una carpeta temporal"   # la borra `limpiar`, al salir
# 🔴 El remoto del clon lo puede cambiar el asistente (`git remote set-url`), y la referencia `origin/main`
# también (`git update-ref`). Así que la URL se verifica contra la organización del equipo y, al instalar de
# verdad, se usa FETCH_HEAD, que es lo que ACABA de traer ese fetch (revisores del Step 5, 2026-09-15).
# La verificación corre EN LOS DOS MODOS —en pruebas también: es local, sin red, y si no corriera ahí el caso
# de control «otra organización» no podría fallar nunca (pase adversarial de la story 8.3, vuelta 1).
if [ "$SIN_SUDO" = 1 ]; then
  git_arnes(){ /usr/bin/git -C "$ARNES" "$@"; }
else
  como_usuario(){ sudo -u "$USUARIO" /usr/bin/env -i HOME="$HOME_USUARIO" PATH=/usr/bin:/bin "$@"; }
  git_arnes(){ como_usuario /usr/bin/git -C "$ARNES" "$@"; }
fi
if [ "$DESDE_RELEASE" = 0 ]; then
  URL="$(git_arnes remote get-url origin)" || muere "no pude leer el remoto del clon"
  # La organización del equipo sale de la configuración del arnés (story 8.3): TYCON_ADO_ORG/ADO_ORG del que
  # invoca, ~/.claude/tycon.json del usuario, o el perfil del equipo. Acá se lee con python3 (está en /usr/bin;
  # node no entra en el PATH de root) y sin la precedencia completa del lector: sólo `ado.org`. Sin organización
  # no se puede verificar que el clon sea el del equipo, y sin eso no se instala.
  # 🔴 Un archivo de configuración ILEGIBLE frena con el motivo (AC 2 de la story 8.3): no se lee como «sin
  # organización». Sólo el archivo AUSENTE es un candidato vacío (cazador de fallos silenciosos, vuelta 2).
  CFG_ERR="$(/usr/bin/mktemp)" || muere "no pude crear un archivo temporal"
  RC_ORG=0
  # el perfil del equipo con su nombre de hoy; si no está, el de antes, que sigue valiendo (con los dos, gana el nuevo)
  PERFIL_ARNES="$ARNES/team-profile.json"; [ -f "$PERFIL_ARNES" ] || PERFIL_ARNES="$ARNES/perfil-equipo.json"
  ORG="$(/usr/bin/python3 -I - "${TYCON_ADO_ORG:-}" "${ADO_ORG:-}" "${HOME_USUARIO:+$CLAUDE_LEIDA/tycon.json}" "$PERFIL_ARNES" 2>"$CFG_ERR" <<'PY'
import json, re, sys
# la misma forma canónica que tycon-config.js (normalizarOrg): https://dev.azure.com/<org>; acepta <org>.visualstudio.com,
# usuario, barra final y espacios — sin esto, `${ORG##*/}` daba vacío y el clon del equipo se rechazaba
def normalizar(v):
    s = (v or '').strip().rstrip('/')
    m = re.match(r'^https?://(?:[^@/]+@)?dev\.azure\.com/([^/?#]+)', s, re.I) or re.match(r'^https?://(?:[^@/]+@)?([^./]+)\.visualstudio\.com', s, re.I)
    return 'https://dev.azure.com/' + m.group(1) if m else s
def roto(ruta, motivo):
    sys.stderr.write('%s: %s\n' % (ruta, motivo)); sys.exit(2)
def leer_org(ruta):
    try:
        f = open(ruta, encoding='utf-8')
    except FileNotFoundError:
        return ''
    except Exception as e:
        roto(ruta, 'no se puede leer (%s)' % e)
    with f:
        try:
            d = json.load(f)
        except Exception as e:
            roto(ruta, 'JSON ilegible (%s)' % e)
    if not isinstance(d, dict):
        roto(ruta, 'tiene que ser un objeto JSON')
    ado = d.get('ado')
    if ado is None:
        return ''
    if not isinstance(ado, dict):
        roto(ruta, 'ado tiene que ser un objeto')
    v = ado.get('org')
    if v is None:
        return ''
    if not isinstance(v, str):
        roto(ruta, 'ado.org tiene que ser un texto')
    return v
candidatos = [sys.argv[1], sys.argv[2]] + [leer_org(r) for r in sys.argv[3:]]
for v in candidatos:
    if v and v.strip():
        print(normalizar(v)); break
PY
)" || RC_ORG=$?
  if [ "$RC_ORG" -eq 2 ]; then
    CFG_MOTIVO="$(tr '\n' ' ' < "$CFG_ERR")"; rm -f "$CFG_ERR"
    muere "la configuración del arnés está ROTA — ${CFG_MOTIVO}— arreglá ese archivo: un archivo roto no se lee como «sin organización» (AC 2 de la story 8.3)."
  fi
  rm -f "$CFG_ERR"
  [ -n "$ORG" ] || muere "sin organización de Azure DevOps configurada (ado.org en el perfil del equipo o en ~/.claude/tycon.json, o TYCON_ADO_ORG): no puedo verificar que el clon sea el del equipo."
  ORG_NOMBRE="${ORG##*/}"
  # El host se compara ENTERO (sin el usuario de la URL) y sólo por https: con el glob `*dev.azure.com/` de antes,
  # `https://ajeno/dev.azure.com/<org>/…` también pasaba (revisor de seguridad, vuelta 3).
  case "$URL" in https://*) : ;; *) muere "el remoto del clon no es https ($URL): el freno sólo se instala desde el repo del equipo por https." ;; esac
  URL_HOST="${URL#*://}"; URL_RUTA="${URL_HOST#*/}"; URL_HOST="${URL_HOST%%/*}"; URL_HOST="${URL_HOST##*@}"
  case "$URL_HOST/$URL_RUTA" in
    "dev.azure.com/$ORG_NOMBRE/tycon-claude-guides/_git/tycon-claude-guides"|"$ORG_NOMBRE.visualstudio.com/tycon-claude-guides/_git/tycon-claude-guides") : ;;
    *) muere "el clon apunta a un remoto que no es el del equipo ($ORG): $URL" ;;
  esac
fi

# ── 0b. el origen de confianza: se fija la primera vez y después se compara (ver la cabecera) ───────
ORIGEN_FIJADO="$DESTINO/production/trusted-origin.json"
# el de antes del renombre a inglés: una máquina que reinstala lo trae (lo escribió root, igual que el nuevo), así que
# el origen que la persona aceptó por teclado sigue valiendo y no se vuelve a preguntar
ORIGEN_FIJADO_VIEJO="$DESTINO/produccion/origen-de-confianza.json"
FIJADO_LEIDO="$ORIGEN_FIJADO"
if [ ! -e "$ORIGEN_FIJADO" ] && [ -f "$ORIGEN_FIJADO_VIEJO" ]; then FIJADO_LEIDO="$ORIGEN_FIJADO_VIEJO"; fi
confirmar_por_teclado(){ # $1 = pregunta → 0 sólo si una PERSONA escribió «si» por teclado (un asistente no tiene /dev/tty)
  [ "$AUTO" = 1 ] && return 1   # el modo de update-guard.sh no pregunta: lo que pediría una persona, frena
  if [ "$SIN_SUDO" = 1 ]; then [ "${TYCON_PROD_ACCEPT_ORIGIN:-}" = "1" ]; return; fi   # en pruebas no hay teclado: la variable hace de persona
  { [ -r /dev/tty ] && [ -w /dev/tty ]; } || return 1
  printf '%s [si/NO] ' "$1" > /dev/tty
  local r=''; IFS= read -r r < /dev/tty || return 1
  [ "$r" = "si" ]
}
leer_fijado(){ # $1 = clave, $2 = archivo (el leído, por defecto) → lo fijado (vacío si la clave no está); un archivo fijado ILEGIBLE sale 2 con el motivo, nunca «vacío»
  /usr/bin/python3 -I -c 'import json,sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    sys.stderr.write("%s: %s\n" % (sys.argv[1], e)); sys.exit(2)
v = d.get(sys.argv[2], "") if isinstance(d, dict) else ""
print(v if isinstance(v, str) else "")' "${2:-$FIJADO_LEIDO}" "$1"
}
# la lista de mudanzas oficiales: al lado de este guion (ver la cabecera); en pruebas, TYCON_PROD_ORIGIN_MOVES la cambia
MUDANZAS="$AQUI_GUION/origin-moves.json"
if [ "$SIN_SUDO" = 1 ] && [ -n "${TYCON_PROD_ORIGIN_MOVES:-}" ]; then MUDANZAS="$TYCON_PROD_ORIGIN_MOVES"; fi
RC_MUDANZA=1; MUDANZA=""
mudanza_oficial(){ # → imprime el mensaje y sale 0 si lo fijado → lo de ahora es una mudanza declarada; 1 si no; 2 (con el motivo) si la lista está rota
  [ -f "$MUDANZAS" ] || return 1
  /usr/bin/python3 -I - "$MUDANZAS" "$FIJADO_URL" "$FIJADO_ORG" "$FIJADO_REPO" "$URL" "$ORG" "$REPO_GITHUB" 2>&1 <<'PY'
import json, re, sys
ruta, f_url, f_org, f_repo, url, org, repo = sys.argv[1:8]
def rota(m): print(m); sys.exit(2)
try:
    d = json.load(open(ruta, encoding="utf-8"))
except Exception as e:
    rota("no se lee (%s)" % e)
moves = d.get("moves") if isinstance(d, dict) else None
if not isinstance(moves, list): rota("le falta la lista «moves»")
# lo fijado tiene que ser un clon de Azure (sin «repo»: lo fijado desde GitHub lo trae) con su organización al lado
m = re.match(r"^https://dev\.azure\.com/([^/?#]+)$", f_org)
if f_repo or not m: sys.exit(1)
o = m.group(1)
fu = re.match(r"^https://(?:[^@/]+@)?([^/]+)/(.+)$", f_url)
if not fu: sys.exit(1)
host, ruta_url = fu.group(1).lower(), fu.group(2)
for mv in moves:
    desde = mv.get("from") if isinstance(mv, dict) else None
    hacia = mv.get("to") if isinstance(mv, dict) else None
    msg = mv.get("message") if isinstance(mv, dict) else None
    if not (isinstance(desde, dict) and isinstance(hacia, dict) and isinstance(desde.get("azure_path"), str)
            and isinstance(hacia.get("github_repo"), str) and isinstance(msg, str) and msg.strip()):
        rota("una mudanza no trae from.azure_path, to.github_repo y message: %r" % (mv,))
    ap, gh = desde["azure_path"], hacia["github_repo"]
    viejo = (host == "dev.azure.com" and ruta_url == o + "/" + ap) or (host == o.lower() + ".visualstudio.com" and ruta_url == ap)
    nuevo = repo == gh and url == "https://github.com/" + gh and org == "github:" + gh
    if viejo and nuevo:
        print(msg.strip()); sys.exit(0)
sys.exit(1)
PY
}
FIJADO_ILEGIBLE="el origen de confianza fijado en $FIJADO_LEIDO está ilegible (lo escribe sólo root): borralo con sudo y volvé a instalar — te va a pedir confirmar el origen otra vez."
if [ -f "$FIJADO_LEIDO" ]; then
  FIJADO_URL="$(leer_fijado url)" || muere "$FIJADO_ILEGIBLE"
  FIJADO_ORG="$(leer_fijado org)" || muere "$FIJADO_ILEGIBLE"
  if [ "$FIJADO_URL" != "$URL" ] || [ "$FIJADO_ORG" != "$ORG" ]; then
    FIJADO_REPO="$(leer_fijado repo)" || muere "$FIJADO_ILEGIBLE"
    RC_MUDANZA=0; MUDANZA="$(mudanza_oficial)" || RC_MUDANZA=$?
    [ "$RC_MUDANZA" -eq 2 ] && muere "la lista de mudanzas oficiales del origen está ROTA ($MUDANZAS): $MUDANZA"
  fi
  if [ "$RC_MUDANZA" -eq 0 ] && [ -n "$MUDANZA" ] && [ "$AUTO" = 1 ]; then
    muere "el origen fijado cambió por una mudanza oficial ($MUDANZA — fijado: $FIJADO_URL · ahora: $URL): sin contraseña no se acepta; corré el instalador con sudo"
  elif [ "$RC_MUDANZA" -eq 0 ] && [ -n "$MUDANZA" ]; then
    ok "$MUDANZA (fijado: $FIJADO_URL · ahora: $URL)"
  elif [ "$FIJADO_URL" != "$URL" ] || [ "$FIJADO_ORG" != "$ORG" ]; then
    [ "$CAMBIAR_ORIGEN" = 1 ] || muere "el origen del clon NO es el que se instaló la última vez (fijado: $FIJADO_URL · $FIJADO_ORG — ahora: $URL · $ORG). Si el cambio es tuyo, volvé a correr con --change-origin; si no lo es, alguien tocó el remoto del clon o la configuración."
    confirmar_por_teclado "El origen cambió. ¿Instalar el freno desde $URL (organización $ORG) en lugar de $FIJADO_URL?" \
      || muere "cambio de origen no confirmado por teclado (un asistente no puede confirmarlo por vos): no instalo."
  fi
else
  confirmar_por_teclado "Primera instalación en esta máquina. ¿Confiar en $URL (organización $ORG) como origen del freno de producción?" \
    || muere "origen no confirmado por teclado (un asistente no puede confirmarlo por vos): no instalo."
fi

if [ "$SIN_SUDO" = 1 ] || [ "$DESDE_RELEASE" = 1 ]; then
  # en pruebas, el disco; la versión bajada también se copia del disco, pero YA VERIFICADA archivo por archivo (0a), y su
  # mapa de nombres viejos entra sólo si el manifiesto lo trae (decidido arriba)
  if [ "$DESDE_RELEASE" = 0 ]; then { [ -f "$ARNES/team-profile.json" ] || [ -f "$ARNES/perfil-equipo.json" ] || [ -f "$ARNES/$MAPA_NOMBRES" ]; } && CON_MAPA=1; fi
  if [ "$DESDE_RELEASE" = 1 ]; then
    # 🔴 sólo se copia lo que el manifiesto trae: un archivo puesto a mano en ~/.tycon/harness (renames.json en una versión
    # pública, por ejemplo) no existe en la versión y no entra a /opt (pase adversarial de la D, clases 4 y 17)
    grep -qx "$MAPA_NOMBRES" "$LISTA_VERIFICADA" && CON_MAPA=1
    for f in "${ARCHIVOS[@]}" $(extras_del_equipo) $(extras_de_setup); do
      grep -qx "$f" "$LISTA_VERIFICADA" || muere "$f está en $ARNES pero NO en el manifiesto de la versión bajada: no es de la versión publicada y no se instala como freno"
    done
    rm -f "$LISTA_VERIFICADA"
  fi
  for f in "${ARCHIVOS[@]}" $(extras_del_equipo) $(extras_de_setup); do
    mkdir -p "$ORIGEN/$(dirname "$f")" && cp -f "$ARNES/$f" "$ORIGEN/$f" || muere "falta un archivo del arnés: $f"
  done
  if [ "$DESDE_RELEASE" = 1 ]; then ok "arnés: copia de la versión bajada verificada ($ARNES)"; else ok "pruebas: copia del disco ($ARNES)"; fi
else
  como_usuario /usr/bin/git -C "$ARNES" fetch -q "$URL" main \
    || muere "no pude traer lo publicado (git fetch falló). Sin eso no instalo: el disco del clon lo puede tocar el asistente."
  REF="$(como_usuario /usr/bin/git -C "$ARNES" rev-parse FETCH_HEAD)" || muere "no pude leer lo que trajo el fetch"
  # ¿lo publicado es el arnés del equipo, o trae el mapa? (un listado que falla no es «no hay»: frena)
  HAY="$(como_usuario /usr/bin/git -C "$ARNES" ls-tree --name-only "$REF" -- team-profile.json perfil-equipo.json "$MAPA_NOMBRES")" \
    || muere "no pude listar lo publicado (origin/main $REF) para saber si lleva el mapa de nombres viejos"
  [ -n "$HAY" ] && CON_MAPA=1
  como_usuario /usr/bin/git -C "$ARNES" archive "$REF" "${ARCHIVOS[@]}" $(extras_del_equipo) $(extras_de_setup) | /usr/bin/tar -x -C "$ORIGEN" \
    || muere "no pude extraer lo publicado de origin/main ($REF)"
  for f in "${ARCHIVOS[@]}" $(extras_del_equipo) $(extras_de_setup); do [ -f "$ORIGEN/$f" ] || muere "lo publicado (origin/main $REF) no tiene $f: ¿el freno ya está mergeado a main?"; done
  ok "arnés: origin/main ${REF:0:10} (traído recién, exportado con git archive)"
fi
# el modo del guion corre la copia de root del instalador, que trae su propia lista de lo que se instala: una versión con
# otro instalador (o con otro guion) no se instala sola — con la lista vieja quedaría a medias diciendo «se actualizó»
if [ "$AUTO" = 1 ]; then
  for par in update-guard.sh:scripts/production/update-guard.sh install-guard.sh:scripts/production/install-guard.sh; do
    cmp -s "$AQUI_GUION/${par%%:*}" "$ORIGEN/${par#*:}" \
      || muere "la versión nueva trae otro ${par%%:*}: esta actualización pide contraseña (sudo bash ~/.tycon/harness/scripts/production/install-guard.sh)"
  done
fi

# ── 1. las carpetas de root: se crean o se exigen de root ────────────────────────────────────
carpeta_de_root(){ # $1 = carpeta
  if [ -e "$1" ]; then
    [ -d "$1" ] || muere "$1 existe y no es una carpeta"
    if [ "$SIN_SUDO" = 0 ]; then
      local d; d="$(stat -f '%Su' "$1")"
      [ "$d" = "root" ] || muere "$1 existe y es de «${d}», no de root. No la toco: revisala a mano."
    fi
  else
    mkdir -p "$1" || muere "no pude crear $1"
  fi
  if [ "$SIN_SUDO" = 0 ]; then
    chown root:wheel "$1" && chmod 755 "$1" || muere "no pude dejar $1 como root:wheel 755"
    [ "$(stat -f '%Su:%Sg %Lp' "$1")" = "root:wheel 755" ] || muere "$1 no quedó root:wheel 755"
  fi
}
for d in "$DESTINO" "$DESTINO/bin" "$DESTINO/hooks" "$DESTINO/lib" "$DESTINO/production" "$DESTINO/setup" "$DESTINO/setup/harness" "$MANAGED_PADRE" "$MANAGED_D"; do
  carpeta_de_root "$d"
done

instalar(){ # $1 = relativo en ORIGEN, $2 = destino, $3 = modo
  # escrito aparte y movido: una instalación cortada a mitad deja el archivo viejo entero, nunca uno truncado
  cp -f "$ORIGEN/$1" "$2.nuevo" || muere "no pude copiar $1 → $2"
  chmod "$3" "$2.nuevo" || muere "no pude poner permisos $3 a $2"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$2.nuevo" || muere "no pude dejar $2 como root:wheel"; fi
  mv -f "$2.nuevo" "$2" || muere "no pude dejar $2"
}

# Las reglas de firewall que abrió la puerta se cierran ANTES de reemplazarla: una regla abierta por una
# puerta que se reemplaza no puede quedar sin quién la cierre. La cierra la puerta instalada, como el dev (su cuenta de
# Azure, no la de root). Si no puede, lo dice en rojo con el comando, y la instalación sigue: el barrido de arranque del
# hook la vuelve a intentar.
cerrar_reglas_abiertas(){
  local casa="${HOME_USUARIO:-${HOME:-}}" puerta_vieja="$DESTINO/bin/tycon-prod-sql" f h hosts salida
  for d in "$casa/.tycon/state" "$casa/.claude/.tycon-pipeline"; do
    [ -f "$d/production-firewall.json" ] || [ -f "$d/production.log" ] || continue
    # la unión del estado y de las aperturas del registro sin un cierre posterior, como el barrido del hook
    if ! hosts="$(/usr/bin/python3 -I -c 'import json,sys,os
estado, registro = sys.argv[1], sys.argv[2]
hosts = []
if os.path.exists(estado):
    try:
        hosts += [r.get("host", "") for r in json.load(open(estado)).get("reglas", [])]
    except Exception:
        print("ILEGIBLE")
abiertas = {}
if os.path.exists(registro):
    for l in open(registro, encoding="utf-8", errors="replace"):
        try: j = json.loads(l)
        except Exception: continue
        h = j.get("host") if isinstance(j, dict) else None
        if not isinstance(h, str): continue
        if j.get("accion") == "open-firewall" and j.get("regla"): abiertas[h] = True
        elif j.get("accion") == "close-firewall" and j.get("exit") == 0: abiertas.pop(h, None)
for h in dict.fromkeys(hosts + list(abiertas)): print(h)' "$d/production-firewall.json" "$d/production.log")"; then
      printf '   🔴 no pude leer qué reglas de firewall quedaron abiertas en %s. Mirá en el portal de Azure las reglas tycon-gate-*.\n' "$d"; continue
    fi
    for h in $hosts; do
      if [ "$h" = ILEGIBLE ]; then printf '   🔴 no pude leer %s/production-firewall.json: sigo con lo que dice el registro. Mirá también en el portal de Azure las reglas tycon-gate-*.\n' "$d"; continue; fi
      [[ "$h" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { printf '   🔴 hay una regla anotada con un host que no tiene forma de host («%s»): no la cierro desde acá. Mirá en el portal de Azure las reglas tycon-gate-*.\n' "$h"; continue; }
      if [ ! -x "$puerta_vieja" ] || ! grep -q -- '--close-firewall' "$puerta_vieja" 2>/dev/null; then
        printf '   🔴 hay una regla de firewall abierta en %s y la puerta instalada no sabe cerrarla. Cerrala después con: /opt/tycon/bin/tycon-prod-sql --close-firewall %s\n' "$h" "$h"; continue
      fi
      if [ "$SIN_SUDO" = 1 ]; then salida="$(/usr/bin/env HOME="$casa" "$puerta_vieja" --close-firewall "$h" 2>&1)"
      else salida="$(sudo -u "$USUARIO" /usr/bin/env -i HOME="$HOME_USUARIO" PATH=/usr/bin:/bin "$puerta_vieja" --close-firewall "$h" 2>&1)"; fi
      if [ $? = 0 ]; then ok "regla de firewall de $h cerrada antes de reinstalar"
      else printf '   🔴 no pude cerrar la regla de firewall de %s (%s). Cerrala con: /opt/tycon/bin/tycon-prod-sql --close-firewall %s\n' "$h" "$(printf '%s' "$salida" | tail -1)" "$h"; fi
    done
  done
}
cerrar_reglas_abiertas

instalar scripts/hooks/prod-access-guard.js       "$DESTINO/hooks/prod-access-guard.js" 644
# el hook que cierra las reglas de firewall de la puerta, en el fin de sesión y en el barrido de arranque
instalar scripts/hooks/prod-firewall-close.js     "$DESTINO/hooks/prod-firewall-close.js" 644
# las bibliotecas, de la copia propia del freno (scripts/production/guard-libs/, ver ARCHIVOS)
instalar scripts/production/guard-libs/lib/shell-parse.js "$DESTINO/lib/shell-parse.js" 644
instalar scripts/production/guard-libs/lib/repos-root.js  "$DESTINO/lib/repos-root.js" 644
# las dos vecinas que repos-root.js requiere desde la story 8.3 (sin ellas el freno instalado no leía el índice)
instalar scripts/production/guard-libs/lib/tycon-config.js "$DESTINO/lib/tycon-config.js" 644
instalar scripts/production/guard-libs/lib/skills-dir.js  "$DESTINO/lib/skills-dir.js" 644
# la constancia de cada decisión del freno (story 8.9, AC 20): el freno la requería y no se copiaba, así que la copia de
# /opt nunca anotaba nada y nadie se enteraba (el require está en un try). Lo cuida T25 de legacy-names.test.js.
instalar scripts/production/guard-libs/lib/guard-record.js "$DESTINO/lib/guard-record.js" 644
# el freno instalado sigue cargando el nombre viejo (story 8.9, tanda C1): la biblioteca misma, con ese nombre
instalar scripts/production/guard-libs/lib/guard-record.js "$DESTINO/$NOMBRE_VIEJO_CONSTANCIA" 644
# los nombres viejos de las variables (story 8.9, tanda B1): tycon-config.js lee sus variables con la biblioteca, y la
# biblioteca busca el mapa al lado suyo. Sin ellos la copia de /opt leería sólo los nombres nuevos, callada (el require
# está en un try).
instalar scripts/production/guard-libs/lib/legacy-names.js "$DESTINO/lib/legacy-names.js" 644
# dónde vive cada cosa en la máquina (story 8.23, tanda D · AC 30): tycon-config.js y skills-dir.js la cargan por su ruta
# relativa (../setup/harness/), la misma posición que en el repo; sin ella, leen las rutas de antes de la mudanza
instalar scripts/production/guard-libs/setup/harness/tycon-home.js "$DESTINO/setup/harness/tycon-home.js" 644
if [ "$CON_MAPA" = 1 ]; then instalar "$MAPA_NOMBRES" "$DESTINO/lib/renames.json" 644; fi
instalar scripts/production/production-index.js  "$DESTINO/production/production-index.js" 644
instalar scripts/production/load-key.command.template "$DESTINO/production/load-key.command.template" 644
instalar scripts/production/tycon-prod-sql        "$DESTINO/bin/tycon-prod-sql" 755
instalar scripts/production/node-shim.sh          "$DESTINO/node-shim.sh" 755
ok "freno y puerta instalados en $DESTINO"
# el origen que la persona aceptó queda fijado, de root, para las instalaciones siguientes (sólo se escribe si cambió:
# la segunda corrida no toca nada)
FIJADO_URL_AHORA=""; FIJADO_ORG_AHORA=""
if [ -f "$ORIGEN_FIJADO" ]; then   # el mismo chequeo que al leerlo: un fijado ilegible frena, nunca se compara como vacío
  FIJADO_URL_AHORA="$(leer_fijado url "$ORIGEN_FIJADO")" || muere "$FIJADO_ILEGIBLE"
  FIJADO_ORG_AHORA="$(leer_fijado org "$ORIGEN_FIJADO")" || muere "$FIJADO_ILEGIBLE"
elif [ "$FIJADO_LEIDO" = "$ORIGEN_FIJADO_VIEJO" ] && [ "$FIJADO_URL" = "$URL" ] && [ "$FIJADO_ORG" = "$ORG" ]; then
  # el fijado de antes del renombre, con el mismo origen: pasa tal cual a la carpeta nueva (conserva su fecha)
  cp -p "$ORIGEN_FIJADO_VIEJO" "$ORIGEN_FIJADO" || muere "no pude pasar el origen fijado de $ORIGEN_FIJADO_VIEJO a $ORIGEN_FIJADO"
  chmod 644 "$ORIGEN_FIJADO" || muere "no pude poner permisos a $ORIGEN_FIJADO"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$ORIGEN_FIJADO" || muere "no pude dejar $ORIGEN_FIJADO como root:wheel"; fi
  FIJADO_URL_AHORA="$URL"; FIJADO_ORG_AHORA="$ORG"
  ok "origen de confianza: el fijado antes del renombre pasó a $ORIGEN_FIJADO"
fi
if [ ! -f "$ORIGEN_FIJADO" ] || [ "$FIJADO_URL_AHORA" != "$URL" ] || [ "$FIJADO_ORG_AHORA" != "$ORG" ]; then
  /usr/bin/python3 -I -c 'import json,sys,datetime; d={"url": sys.argv[1], "org": sys.argv[2], "fijado": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}; sys.argv[4] and d.update({"repo": sys.argv[4]}); json.dump(d, open(sys.argv[3], "w"), indent=1)' "$URL" "$ORG" "$ORIGEN_FIJADO" "$REPO_GITHUB" \
    || muere "no pude fijar el origen de confianza en $ORIGEN_FIJADO"
  chmod 644 "$ORIGEN_FIJADO" || muere "no pude poner permisos a $ORIGEN_FIJADO"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$ORIGEN_FIJADO" || muere "no pude dejar $ORIGEN_FIJADO como root:wheel"; fi
  ok "origen de confianza fijado: $URL ($ORG)"
fi

# ── 2. el intérprete y el cliente de base, de root (AC 29): los DOS son obligatorios ──────────
real_de(){ # sigue enlaces sin depender de programas del usuario
  local p="$1" n=0
  while [ -L "$p" ] && [ $n -lt 20 ]; do
    local t; t="$(readlink "$p")"
    case "$t" in /*) p="$t" ;; *) p="$(cd "$(dirname "$p")" && pwd -P)/$t" ;; esac
    n=$((n+1))
  done
  printf '%s' "$p"
}
copiar_binario(){ # $1 = nombre
  local origen
  if [ "$SIN_SUDO" = 1 ]; then origen="$(PATH="${TYCON_PROD_TEST_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}" command -v "$1" || true)"
  else origen="$(PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin command -v "$1" || true)"; fi
  [ -n "$origen" ] || muere "no encuentro «${1}» para copiarlo a $DESTINO/bin: instalalo y volvé a correr esto (el freno no queda a medias)."
  local real; real="$(real_de "$origen")"
  [ -f "$real" ] || muere "«${1}» apunta a algo que no es un archivo ($real)"
  cp -f "$real" "$DESTINO/bin/$1" && chmod 755 "$DESTINO/bin/$1" || muere "no pude copiar $real → $DESTINO/bin/$1"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$DESTINO/bin/$1" || muere "no pude dejar $DESTINO/bin/$1 como root:wheel"; fi
  ok "$1 copiado de $real"
}
# 🔴 El intérprete NO es el del dev. El node de Homebrew carga 8 bibliotecas de /opt/homebrew,
# carpetas que el usuario (y el asistente) puede escribir: cambiar una hace que el freno salga 0 y
# deje pasar todo, sin contraseña y en silencio (medido con `otool -L`, revisores del Step 5). El
# oficial de nodejs.org es autocontenido. Se baja acá, se verifica contra la huella que viaja en el
# repo —no contra la que sirva el servidor— y se copia. Sin red o con huella distinta: NO se instala.
instalar_node_oficial(){
  local conf="$ORIGEN/scripts/production/node-official.json"
  [ -f "$conf" ] || muere "falta scripts/production/node-official.json en lo publicado"
  local arch; arch="$(uname -m)"; case "$arch" in arm64) arch=darwin-arm64 ;; x86_64) arch=darwin-x64 ;; *) muere "arquitectura no contemplada: $arch" ;; esac
  local ver tar sha base
  ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -1)"
  tar="$(grep -A2 "\"$arch\"" "$conf" | sed -n 's/.*"tar"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  sha="$(grep -A2 "\"$arch\"" "$conf" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{64\}\)".*/\1/p' | head -1)"
  base="$(sed -n 's/.*"base_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -1)"
  { [ -n "$ver" ] && [ -n "$tar" ] && [ -n "$sha" ] && [ -n "$base" ]; } || muere "node-official.json incompleto (versión, archivo, huella o URL)"

  # ¿ya está el oficial instalado y con su huella? entonces no se baja nada
  if [ -x "$DESTINO/bin/node" ] && [ "$("$DESTINO/bin/node" --version 2>/dev/null)" = "$ver" ] \
     && [ "$(huella_esperada_local)" = "$(shasum -a 256 "$DESTINO/bin/node" | cut -d" " -f1)" ]; then
    ok "intérprete: ya está el oficial $ver"
    return 0
  fi

  local tmp; tmp="$(mktemp -d)" || muere "no pude crear una carpeta temporal para el intérprete"
  ok "bajando el intérprete oficial $ver ($arch)…"
  curl -fsSL --max-time 180 -o "$tmp/$tar" "$base$ver/$tar" || { rm -rf "$tmp"; muere "no pude bajar el intérprete oficial ($base$ver/$tar). Sin él no instalo: el node del sistema carga bibliotecas que el asistente puede cambiar."; }
  local real; real="$(shasum -a 256 "$tmp/$tar" | cut -d' ' -f1)"
  [ "$real" = "$sha" ] || { rm -rf "$tmp"; muere "el intérprete que bajé NO coincide con la huella publicada por el equipo (esperaba $sha, vino $real). No instalo."; }
  tar -xzf "$tmp/$tar" -C "$tmp" || { rm -rf "$tmp"; muere "no pude descomprimir el intérprete"; }
  local origen="$tmp/${tar%.tar.gz}/bin/node"
  [ -x "$origen" ] || { rm -rf "$tmp"; muere "el paquete del intérprete no trae bin/node"; }
  cp -f "$origen" "$DESTINO/bin/node.nuevo" && chmod 755 "$DESTINO/bin/node.nuevo" || { rm -rf "$tmp"; muere "no pude copiar el intérprete"; }
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$DESTINO/bin/node.nuevo" || { rm -rf "$tmp"; muere "no pude dejar el intérprete como root:wheel"; }; fi
  mv -f "$DESTINO/bin/node.nuevo" "$DESTINO/bin/node" || { rm -rf "$tmp"; muere "no pude dejar el intérprete en $DESTINO/bin/node"; }
  rm -rf "$tmp"
  ok "intérprete oficial $ver instalado (huella verificada contra la del repo)"
}
huella_esperada_local(){ sed -n 's/.*"\/opt\/tycon\/bin\/node"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{64\}\)".*/\1/p' "$DESTINO/huellas.json" 2>/dev/null | head -1; }

# nada de lo que el freno o la puerta EJECUTAN puede depender de carpetas que el usuario escribe
sin_dependencias_del_usuario(){ # $1 = binario
  local ajenas; ajenas="$(otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}' | grep -vE '^/usr/lib/|^/System/' || true)"
  [ -z "$ajenas" ] || muere "«$1» carga bibliotecas de carpetas que el usuario puede escribir:
$(printf '%s\n' "$ajenas" | sed 's/^/     /')
   Cambiar una de ésas apaga el freno. Instalá una versión autocontenida y volvé a correr esto."
}
if [ "${TYCON_PROD_NODE_LOCAL:-}" = "1" ] && [ "$SIN_SUDO" = 1 ]; then
  copiar_binario node                     # sólo en pruebas: sin red, con el node que haya
else
  instalar_node_oficial
fi
# la actualización sin contraseña no toma un binario de las carpetas que escribe el usuario: deja el de root que ya está
# (el cliente de base no viene en lo publicado y no hay huella contra la que verificarlo)
if [ "$AUTO" = 1 ]; then
  [ -x "$DESTINO/bin/sqlcmd" ] || muere "falta el sqlcmd de root ($DESTINO/bin/sqlcmd): sin contraseña no lo copio de las carpetas del usuario — reinstalá con sudo bash install-guard.sh"
  ok "sqlcmd: queda el de root que ya estaba (sin contraseña no se recopia)"
else copiar_binario sqlcmd; fi
sin_dependencias_del_usuario "$DESTINO/bin/sqlcmd"
[ "${TYCON_PROD_NODE_LOCAL:-}" = "1" ] || sin_dependencias_del_usuario "$DESTINO/bin/node"

# ── 3. las huellas (lo que el freno y la puerta reverifican antes de ejecutar) ────────────────
huella(){ local h; h="$(shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1)"; [[ "$h" =~ ^[a-f0-9]{64}$ ]] || muere "no pude calcular la huella de $1"; printf '%s' "$h"; }
H_PUERTA="$(huella "$DESTINO/bin/tycon-prod-sql")" || exit 1
H_NODE="$(huella "$DESTINO/bin/node")" || exit 1
H_SQLCMD="$(huella "$DESTINO/bin/sqlcmd")" || exit 1
H_HOOK="$(huella "$DESTINO/hooks/prod-access-guard.js")" || exit 1
H_PLANTILLA="$(huella "$DESTINO/production/load-key.command.template")" || exit 1
H_CIERRE="$(huella "$DESTINO/hooks/prod-firewall-close.js")" || exit 1
NUEVAS="$(printf '{\n  "__doc": "Huellas de lo instalado por install-guard.sh. El freno, el lanzador y la puerta las reverifican antes de ejecutar: si no coinciden, no corren.",\n  "/opt/tycon/bin/tycon-prod-sql": "%s",\n  "/opt/tycon/bin/node": "%s",\n  "/opt/tycon/bin/sqlcmd": "%s",\n  "/opt/tycon/hooks/prod-access-guard.js": "%s",\n  "/opt/tycon/hooks/prod-firewall-close.js": "%s",\n  "/opt/tycon/production/load-key.command.template": "%s"\n}' \
  "$H_PUERTA" "$H_NODE" "$H_SQLCMD" "$H_HOOK" "$H_CIERRE" "$H_PLANTILLA")"
if [ -f "$DESTINO/huellas.json" ] && [ "$(cat "$DESTINO/huellas.json")" = "$NUEVAS" ]; then
  ok "huellas sin cambios"
else
  printf '%s\n' "$NUEVAS" > "$DESTINO/huellas.json.nuevo" || muere "no pude escribir las huellas"
  chmod 644 "$DESTINO/huellas.json.nuevo" || muere "no pude poner permisos a las huellas"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$DESTINO/huellas.json.nuevo" || muere "no pude dejar las huellas como root"; fi
  mv -f "$DESTINO/huellas.json.nuevo" "$DESTINO/huellas.json" || muere "no pude dejar las huellas en $DESTINO/huellas.json"
  ok "huellas escritas"
fi

# ── 4. la configuración administrada ──────────────────────────────────────────────────────────
PLANTILLA="$ORIGEN/scripts/production/managed-settings.tycon-production.json.template"
NUEVO="$MANAGED_D/tycon-production.json"
if [ -f "$NUEVO" ] && ! cmp -s "$PLANTILLA" "$NUEVO"; then
  cp -f "$NUEVO" "$MANAGED_D/tycon-production.json.bak-$(date +%Y%m%d%H%M%S)" || muere "no pude respaldar el archivo administrado anterior"
  ok "respaldo del archivo administrado anterior"
fi
if ! cmp -s "$PLANTILLA" "$NUEVO" 2>/dev/null; then
  # aparte y movido; el nombre intermedio no termina en .json, así que Claude Code no lo lee a medio escribir
  cp -f "$PLANTILLA" "$NUEVO.nuevo" && mv -f "$NUEVO.nuevo" "$NUEVO" || muere "no pude escribir $NUEVO"
fi
if [ "$SIN_SUDO" = 0 ]; then
  # el modo que se midió funcionando en la Task 0b
  chown root:admin "$NUEVO" && chmod 644 "$NUEVO" || muere "no pude dejar $NUEVO como root:admin 644"
  [ "$(stat -f '%Su:%Sg %Lp' "$NUEVO")" = "root:admin 644" ] || muere "$NUEVO no quedó root:admin 644"
fi
ok "configuración administrada: $NUEVO"
# el archivo administrado de antes del renombre a inglés: respaldado y afuera, DESPUÉS de dejar el nuevo (en ningún
# momento la máquina queda sin freno). Con los dos, Claude Code registraría el freno dos veces.
VIEJO="$MANAGED_D/tycon-produccion.json"
if [ -f "$VIEJO" ]; then
  cp -f "$VIEJO" "$VIEJO.bak-$(date +%Y%m%d%H%M%S)" || muere "no pude respaldar el archivo administrado viejo ($VIEJO)"
  rm -f "$VIEJO" || muere "no pude sacar el archivo administrado viejo ($VIEJO): el freno quedaría registrado dos veces"
  ok "archivo administrado de antes del renombre: respaldado y sacado"
fi
# la carpeta de /opt de antes del renombre: sólo lo que dejaba el instalador viejo; si queda algo más, no se toca
VIEJA="$DESTINO/produccion"
if [ -d "$VIEJA" ]; then
  rm -f "$VIEJA/indice-produccion.js" "$VIEJA/cargar-clave.command.template" "$VIEJA/origen-de-confianza.json"
  if rmdir "$VIEJA" 2>/dev/null; then ok "carpeta de antes del renombre ($VIEJA): sacada"
  else echo "   ⚠ $VIEJA tiene archivos que no dejó este instalador: no la toco (revisala a mano)"; fi
fi

# ── 4b. la constancia de lo instalado (2026-10-09) ────────────────────────────────────────────
# Para el aviso de arranque en una máquina con una versión BAJADA: ahí no hay historia de git contra la que decir si lo
# instalado «quedó viejo» o si «alguien lo cambió», y el aviso gritaba lo segundo en cada arranque. Queda escrito, de
# root, el blob de git de cada archivo del arnés tal como se copió: se calcula de $ORIGEN (la copia propia de este
# instalador, la misma de la que salió cada `instalar` y la configuración administrada), no del HOME. Tiene la forma del
# manifiesto de una versión (`files: [{ path, blob }]`) y no lleva fecha: la segunda corrida no cambia nada.
# Desde la copia propia (2026-10-14) las rutas de las bibliotecas son las de scripts/production/guard-libs/: el aviso de
# arranque las busca ahí para saber si el freno instalado ya es el de la copia propia (y, si no, explicar la reinstalación).
# Va AL FINAL y se escribe aparte y se mueve: una instalación que se corta antes deja la constancia de la instalación
# anterior entera (lo que ya se copió coincide con la versión que corre; lo que no, con esa constancia), nunca una a medias.
CONSTANCIA_INSTALADO="$DESTINO/production/installed-files.json"
INCOMPLETA="la instalación quedó INCOMPLETA: el freno y la puerta ya están copiados, falta su constancia — volvé a correr el instalador"
# shellcheck disable=SC2046
/usr/bin/python3 -I - "$ORIGEN" "$CONSTANCIA_INSTALADO.new" "${ARCHIVOS[@]}" $(extras_del_equipo) <<'PY' || muere "no pude escribir la constancia de lo instalado ($CONSTANCIA_INSTALADO) — $INCOMPLETA"
import hashlib, json, os, sys
origen, salida, rutas = sys.argv[1], sys.argv[2], sys.argv[3:]
files = []
for rel in rutas:
    with open(os.path.join(origen, *rel.split("/")), "rb") as fh: data = fh.read()
    files.append({"path": rel, "blob": hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()})
doc = "Lo que dejó install-guard.sh: el blob de git de cada archivo del arnés que copió a /opt/tycon. El aviso de arranque lo lee en una máquina con una versión bajada, para distinguir «quedó viejo» de «alguien lo cambió»."
with open(salida, "w", encoding="utf-8") as f:
    json.dump({"__doc": doc, "files": files}, f, indent=1, ensure_ascii=False)
    f.write("\n")
PY
chmod 644 "$CONSTANCIA_INSTALADO.new" || muere "no pude poner permisos a $CONSTANCIA_INSTALADO.new — $INCOMPLETA"
if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$CONSTANCIA_INSTALADO.new" || muere "no pude dejar $CONSTANCIA_INSTALADO.new como root:wheel — $INCOMPLETA"; fi
if cmp -s "$CONSTANCIA_INSTALADO.new" "$CONSTANCIA_INSTALADO" 2>/dev/null; then
  rm -f "$CONSTANCIA_INSTALADO.new"; ok "constancia de lo instalado sin cambios"
else
  mv -f "$CONSTANCIA_INSTALADO.new" "$CONSTANCIA_INSTALADO" || muere "no pude dejar la constancia en $CONSTANCIA_INSTALADO — $INCOMPLETA"
  ok "constancia de lo instalado: $CONSTANCIA_INSTALADO"
fi

# ── 4c. la actualización sin contraseña (story 8.88) ──────────────────────────────────────────────────────────────────
# lo que va a /opt/tycon/setup: escrito aparte y movido (el modo del guion corre DESDE esa copia del instalador, y bash
# lee un guion mientras corre: un reemplazo en el lugar lo cortaría a mitad)
poner_en_setup(){ # $1 = relativo en ORIGEN, $2 = nombre, $3 = modo
  local d="$DESTINO/setup/$2"
  cp -f "$ORIGEN/$1" "$d.nuevo" && chmod "$3" "$d.nuevo" || muere "no pude copiar $1 → $d"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$d.nuevo" || muere "no pude dejar $d como root:wheel"; fi
  mv -f "$d.nuevo" "$d" || muere "no pude dejar $d"
}
# sólo con contraseña: lo que corre el guion no se renueva a sí mismo (tabla de los dos caminos de la story)
if [ "$CON_SETUP" = 1 ] && [ "$AUTO" = 0 ] && [ "$PERMISO" = allow -o -f "$MARCA" ]; then
  poner_en_setup scripts/production/update-guard.sh update-guard.sh 755
  poner_en_setup scripts/production/install-guard.sh install-guard.sh 755
  poner_en_setup scripts/production/origin-moves.json origin-moves.json 644
  ok "actualización sin contraseña: el guion y la copia del instalador al día en $DESTINO/setup"
fi
# la versión bajada que quedó instalada (de root): contra ella el guion decide si la próxima avanza
if [ "$DESDE_RELEASE" = 1 ] && [ -n "${COMMIT_BAJADO:-}" ]; then
  /usr/bin/python3 -I -c 'import json,sys; json.dump({"repo": sys.argv[2], "commit": sys.argv[3], "version": sys.argv[4]}, open(sys.argv[1], "w"), indent=1)' \
    "$INSTALADA.nuevo" "$REPO_GITHUB" "$COMMIT_BAJADO" "${VERSION_BAJADA:-?}" && chmod 644 "$INSTALADA.nuevo" || muere "no pude escribir $INSTALADA"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$INSTALADA.nuevo" || muere "no pude dejar $INSTALADA como root:wheel"; fi
  mv -f "$INSTALADA.nuevo" "$INSTALADA" || muere "no pude dejar $INSTALADA"
fi
QUIEN="${USUARIO:-$(id -un)}"
# el modo del guion deja su renglón (se agrega, no se reescribe): de y a qué versión, quién la pidió y cuándo
if [ "$AUTO" = 1 ]; then
  /usr/bin/python3 -I -c 'import json,sys,datetime
r = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "from": sys.argv[2] or None, "to": sys.argv[3], "from_version": sys.argv[4] or None, "to_version": sys.argv[5], "user": sys.argv[6]}
open(sys.argv[1], "a", encoding="utf-8").write(json.dumps(r, ensure_ascii=False) + "\n")' "$REGISTRO_AUTO" "$PREVIO_COMMIT" "$COMMIT_BAJADO" "$PREVIO_VERSION" "${VERSION_BAJADA:-?}" "$QUIEN" \
    && chmod 644 "$REGISTRO_AUTO" || muere "el freno quedó al día pero no pude anotarlo en $REGISTRO_AUTO"
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$REGISTRO_AUTO" || muere "no pude dejar $REGISTRO_AUTO como root:wheel"; fi
fi
# el permiso: el guion y cada carpeta hasta / de root, nadie más la escribe y ninguna es un enlace; la regla, validada con
# visudo ANTES de moverla. Si algo falla, no queda ninguna regla puesta (sudo sigue andando como antes)
if [ "$PERMISO" = allow ]; then
  p="$DESTINO/setup/update-guard.sh"
  while :; do
    [ -L "$p" ] && muere "$p es un enlace simbólico: no pongo la regla de sudo (ninguna regla puesta)"
    if [ "$SIN_SUDO" = 0 ] && [ "$(stat -f '%Su' "$p")" != root ]; then muere "$p no es de root: no pongo la regla de sudo (ninguna regla puesta)"; fi
    escribible="$(/usr/bin/find "$p" -maxdepth 0 \( -perm -o+w -o -perm -g+w \) -print)" || muere "no pude revisar los permisos de $p: no pongo la regla de sudo (ninguna regla puesta)"
    [ -z "$escribible" ] || muere "$p lo puede escribir alguien más que root: no pongo la regla de sudo (ninguna regla puesta)"
    [ "$p" = / ] && break
    p="$(dirname "$p")"
    # en pruebas, el camino termina en la raíz falsa (lo de arriba es la carpeta temporal del usuario)
    [ "$SIN_SUDO" = 1 ] && [ "$p" = "$RAIZ" ] && break
  done
  [[ "$QUIEN" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || muere "el nombre de usuario «${QUIEN}» no sirve para la regla de sudo"
  VISUDO=/usr/sbin/visudo; [ -x "$VISUDO" ] || muere "no encuentro $VISUDO: sin validar la regla no la pongo"
  mkdir -p "$SUDOERS_D" || muere "no pude crear $SUDOERS_D"
  # el nombre con un punto: sudo no lee de sudoers.d un archivo así, y no queda a medio escribir como regla
  NUEVA="$SUDOERS_D/tycon-guard.nueva"
  sed "s/__USER__/$QUIEN/" "$ORIGEN/scripts/production/sudoers.tycon-guard.template" > "$NUEVA" || { rm -f "$NUEVA"; muere "no pude escribir la regla de sudo"; }
  if ! "$VISUDO" -cf "$NUEVA" >/dev/null 2>&1; then rm -f "$NUEVA"; muere "la regla de sudo no valida (visudo -cf): no muevo nada a $SUDOERS_D"; fi
  chmod 440 "$NUEVA" || { rm -f "$NUEVA"; muere "no pude poner permisos 440 a la regla"; }
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$NUEVA" || { rm -f "$NUEVA"; muere "no pude dejar la regla como root:wheel"; }; fi
  mv -f "$NUEVA" "$REGLA" || { rm -f "$NUEVA"; muere "no pude dejar la regla en $REGLA"; }
  /usr/bin/python3 -I -c 'import json,sys,datetime; json.dump({"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "user": sys.argv[2], "by": "install-guard.sh --allow-auto-update"}, open(sys.argv[1], "w"), indent=1)' "$MARCA" "$QUIEN" \
    && chmod 644 "$MARCA" || { rm -f "$REGLA" "$MARCA"; muere "no pude escribir la marca $MARCA (saqué la regla)"; }
  if [ "$SIN_SUDO" = 0 ]; then chown root:wheel "$MARCA" || { rm -f "$REGLA" "$MARCA"; muere "no pude dejar la marca como root:wheel (saqué la regla)"; }; fi
  ok "actualización sin contraseña instalada: sudo -n /opt/tycon/setup/update-guard.sh (sin argumentos)"
fi

# ── 5. verificación final: dueño y permisos, todo junto ───────────────────────────────────────
if [ "$SIN_SUDO" = 0 ]; then
  ajenos="$(find "$DESTINO" \( ! -user root -o -perm -o+w -o -perm -g+w \) -print)" || muere "no pude revisar los dueños y permisos de $DESTINO: no doy la instalación por buena"
  [ -z "$ajenos" ] || muere "quedaron archivos que no son de root o que otro puede escribir:
$ajenos"
  ok "$DESTINO es de root y nadie más puede escribirlo"
fi

echo
if [ "$AUTO" = 1 ]; then
  echo "✅ el freno se actualizó solo a ${VERSION_BAJADA:-?} (${COMMIT_BAJADO:0:7}); queda anotado en $REGISTRO_AUTO."
  echo "   Los hooks nuevos quedan activos en la SIGUIENTE sesión de Claude Code."
  exit 0
fi
echo "✅ freno de producción instalado."
echo "   Los hooks nuevos quedan activos en la SIGUIENTE sesión de Claude Code."
echo "   Probalo ahí: sqlcmd -S <un host de producción> -Q 'select 1'   → tiene que quedar frenado"
[ -n "${AVISO_ATRASADA:-}" ] && echo "   ⚠ $AVISO_ATRASADA"
[ "$SIN_SUDO" = 0 ] && sudo -K 2>/dev/null   # no dejar la caché de sudo abierta (decisión 6)
exit 0
