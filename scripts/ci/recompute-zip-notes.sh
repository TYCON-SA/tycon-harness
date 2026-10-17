#!/usr/bin/env bash
# =============================================================================
# recompute-zip-notes.sh — notas de versión al MOMENTO DE PUBLICAR
# =============================================================================
# La nota que ve el administrador contesta "¿qué cambia respecto de lo que tengo instalado?".
# Esa pregunta sólo se puede contestar bien al publicar: el paquete se arma antes —a veces
# mucho antes— y en el medio el servidor pudo haber cambiado. Si se generan la v68 y la v69
# con la v67 publicada, y después se publica primero la 68, la nota de la 69 tiene que dejar
# de mencionar lo que ya trajo la 68.
#
# Entonces este script corre en el paso de DESPLIEGUE, no en el de empaquetado: por cada ZIP
# le pregunta al servidor destino qué versión de ESE formulario está publicada, arma la lista
# de cambios desde ahí, y la reescribe dentro del ZIP antes de subirlo.
#
# A diferencia del backend (un plugin, un ZIP), acá hay un formulario por ZIP y cada uno lleva
# su propia cuenta: el de stock puede estar en la v48 y el de pedidos en la v31.
#
# Uso: recompute-zip-notes.sh <dir-con-zips> <url> <usuario> <clave>
# Exit: 0 cuando TODAS las notas se calcularon contra el servidor.
#       3 cuando no pudo hacer su trabajo —falta el guion hermano, faltan credenciales o alguna
#         nota quedó calculada contra el build anterior porque el servidor no contestó—. En ese
#         caso el ZIP conserva la mejor nota que haya (nunca queda sin nota), y el despliegue NO
#         se frena: los pipelines llaman este paso con `continueOnError: true`, así que el 3 pinta
#         el paso de naranja en vez de verde. Eso es todo lo que se pide: que "no miré nada" no se
#         vea igual que "miré y está bien" (incident-log, 2026-08-31: la familia entera del verde
#         que significa no miré nada). Hasta esa noche salía SIEMPRE 0, y por eso la v1.0.62 de
#         un producto del equipo llegó a producción con una nota falsa y el paso en verde
#         — guides/maintaining/incident-log.md#nota-de-version-falsa-en-prod-2026-08-31.
#
# 🔴 ÉSTE ES EL CANÓNICO (2026-08-31). Vive SOLO acá.
# Estaba copiado en los 4 frontends y YA SE HABÍA PARTIDO EN DOS VARIANTES: Ceibo y URUTAU tenían
# una pausa de 3 segundos entre formularios que Totora y Lapacho no. No hubo que elegir: una
# variante era la otra MÁS esa pausa, así que el canónico es la que la tiene.
# La pausa existe porque cada consulta abre su propio ingreso al host y el host limita los ingresos
# seguidos: con 8 formularios la ráfaga hacía que el paso siguiente —el despliegue— recibiera un
# 401 "Too Many Requests" (build 9060 de URUTAU). Totora no lo veía porque tiene 4 formularios, e
# Lapacho tampoco porque tiene 1. Es exactamente cómo se parte una copia: el que sufre el
# problema lo arregla en la suya y los demás no se enteran.
# =============================================================================
set -uo pipefail

DIR="${1:?falta el directorio con los zips}"
URL="${2:-}"; USUARIO="${3:-}"; CLAVE="${4:-}"

# 🔴 release-notes.sh se busca en LA MISMA CARPETA que este guion (2026-08-31, la noche).
# Antes era `<carpeta>/../scripts/release-notes.sh`: una ruta heredada de cuando cada repo tenía su
# copia en `scripts/`. Al unificar, los dos guiones pasaron a vivir juntos en `scripts/ci/` del
# arnés y viajan al pipeline como un artefacto PLANO (`arnes-ci/`), así que esa ruta no existía en
# ningún lado — y el guion decía "no está … se dejan las notas del empaquetado", salía 0, y el
# paso quedaba VERDE. Resultado medido en producción: la v1.0.62 de un formulario de un producto del equipo se
# publicó con "Sin cambios desde el build anterior" cuando la versión instalada era la v1.0.56 y
# en el medio había una story entera (M-11) — guides/maintaining/incident-log.md#nota-de-version-falsa-en-prod-2026-08-31. Exactamente el caso que este guion existe para
# evitar. Los dos guiones se despliegan siempre juntos: la misma carpeta es la única ruta que no
# depende de cómo se los copió.
NOTAS_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes.sh"

for req in jq unzip zip; do
  command -v "$req" >/dev/null 2>&1 || { echo "[notas] falta $req; se dejan las notas del empaquetado" >&2; exit 3; }
done
[ -f "$NOTAS_SH" ] || { echo "[notas] no está $NOTAS_SH; se dejan las notas del empaquetado" >&2; exit 3; }
[ -d "$DIR" ] || { echo "[notas] no existe el directorio $DIR" >&2; exit 3; }

# Sin credenciales no hay a quién preguntarle: el ZIP ya trae una nota razonable.
if [ -z "$URL" ] || [ -z "$USUARIO" ] || [ -z "$CLAVE" ]; then
  echo "[notas] sin credenciales del servidor; se dejan las notas del empaquetado" >&2
  exit 3
fi

# Cuántas notas NO salieron contra el servidor. Decide el exit final (ver cabecera).
DEGRADADAS=0

# 🔴 UN SOLO INGRESO PARA TODOS LOS FORMULARIOS (2026-09-01, medido en un producto del equipo
# — guides/maintaining/incident-log.md#case-host-login-rate-limit-2026-09-01).
#
# Antes: cada formulario abría su propio ingreso al host (una invocación de release-notes.sh por
# ZIP). Con 4 formularios (Totora) no se nota; con 8 (URUTAU) hubo que meter una pausa de 3s
# entre uno y otro para que el despliegue de al lado no recibiera "Too Many Requests"; con 34
# (FRESNO) ni la pausa alcanza — build 9280: `login HTTP 429`, los 4 reintentos agotados, y las
# **34 notas calculadas contra el build anterior** en vez de contra la versión publicada. O sea:
# el guion corría, el paso quedaba naranja, y ninguna nota decía lo que tenía que decir.
#
# La pausa era un parche a la ráfaga. El problema de fondo es pedir N ingresos para responder N
# preguntas cuando alcanza con UNO. Se entra una vez acá y se pasa el token por `BZ_TOKEN`; el
# guion hermano lo usa y no vuelve a entrar. La pausa entre formularios ya no hace falta.
ingresar_una_vez() {
  local headers body code token
  headers=$(mktemp); local respuesta; respuesta=$(mktemp)
  # 🔴 El cuerpo va como TEXTO, no como archivo. `--data-raw "@ruta"` NO lee el archivo: manda la
  # cadena literal `@/tmp/loquesea`, el host recibe basura y contesta 500 — y de ahí se cae al
  # camino viejo de 34 ingresos, que es justo lo que esto vino a evitar (build 9290).
  # Se arma con jq y no a mano: una clave con comillas o barras rompería el JSON.
  body=$(jq -nc --arg u "$USUARIO" --arg p "$CLAVE" '{username:$u, password:$p, tenant_id:"default"}')
  # 🔴 UN SOLO INTENTO, y corto, A PROPÓSITO. Esto es una OPTIMIZACIÓN, no el camino
  # obligatorio: si no entra, cada formulario entra por su cuenta como toda la vida — y ESE
  # camino ya reintenta 4 veces con espera creciente, probado y con casos. Reintentar también
  # acá sumaría 90 segundos de espera ANTES de caer al camino que igual va a reintentar: pura
  # latencia, y en una corrida contra un host caído se paga dos veces.
  # Lo cazó el propio banco de pruebas al medir cuánto tardaba la suite.
  code=$(curl -s -D "$headers" -o "$respuesta" -w '%{http_code}' --max-time "${INGRESO_TIMEOUT:-15}" \
    "${URL}/api/auth/login" -H 'Content-Type: application/json' --data-raw "$body" 2>/dev/null) || code="000"
  if [ "$code" != "200" ]; then
    echo "[notas] no se pudo abrir un ingreso único (HTTP $code) — cada formulario va a entrar por su cuenta" >&2
    rm -f "$headers" "$respuesta"; return 1
  fi
  token=$(grep -i 'set-cookie:.*admin_token=' "$headers" | sed 's/.*admin_token=\([^;]*\).*/\1/' | head -1)
  [ -z "$token" ] && token=$(jq -r '.token // .accessToken // empty' "$respuesta" 2>/dev/null)
  rm -f "$headers" "$respuesta"
  [ -z "$token" ] && { echo "[notas] el ingreso no devolvió token (ni cookie ni cuerpo)" >&2; return 1; }
  printf '%s' "$token"
}

BZ_TOKEN="$(ingresar_una_vez || true)"
if [ -n "$BZ_TOKEN" ]; then
  export BZ_TOKEN
  # `${#}` era la cantidad de ARGUMENTOS del guion (4), no de formularios: el mensaje decía
  # "las 4 consultas" con 34 ZIPs adentro. Un número mal en un registro manda a diagnosticar
  # el problema equivocado.
  CUANTOS=$(ls -1 "$DIR"/*.zip 2>/dev/null | wc -l | tr -d ' ')
  echo "[notas] ingreso único obtenido: las ${CUANTOS} consultas van con el mismo token" >&2
else
  # Sin token no se aborta: cada formulario va a intentar entrar por su cuenta, como antes.
  # Es peor, pero es lo que ya hacía — y el exit 3 del final deja constancia de la degradación.
  unset BZ_TOKEN
fi

# Pausa entre formularios: con ingreso único ya no hace falta esperar por el límite de
# ingresos, pero se deja 1s para no ametrallar al host con 34 consultas seguidas.
PRIMERO=1

for ZIP in "$DIR"/*.zip; do
  [ -f "$ZIP" ] || continue
  if [ "$PRIMERO" = "1" ]; then PRIMERO=0; else sleep "${PAUSA_ENTRE_FORMS:-1}"; fi
  TMP=$(mktemp -d)

  # El formulario NO se deduce del nombre del archivo: sale del manifiesto, que es el dato
  # que el servidor va a leer.
  if ! unzip -q -o "$ZIP" manifest.json -d "$TMP" 2>/dev/null || [ ! -f "$TMP/manifest.json" ]; then
    echo "[notas] $(basename "$ZIP") no tiene manifest.json; se deja como está" >&2
    rm -rf "$TMP"; continue
  fi

  FORM=$(jq -r '.forms[0].formName // ""' "$TMP/manifest.json" 2>/dev/null)
  if [ -z "$FORM" ] || [ "$FORM" = "null" ]; then
    echo "[notas] $(basename "$ZIP") no declara formName; se deja como está" >&2
    rm -rf "$TMP"; continue
  fi

  # Los cambios se acotan a la carpeta del formulario: un cambio en el de pedidos no tiene
  # por qué aparecer en las notas del de stock. Mismo recorte que usa el empaquetado, para
  # que la nota no cambie de forma según quién la haya calculado.
  # 🔴 `--type form` (2026-08-31, la noche; hasta la story 8.9 se llamaba `formulario`): acá hay un formulario por ZIP, y el guion
  # unificado sin bandera pregunta por PLUGINS (`/api/admin/plugins`), donde un formulario no
  # figura → sin commit publicado → la nota se calcula contra el build anterior aunque el servidor
  # haya contestado perfecto. Segundo defecto del mismo incidente de la v1.0.62: el primero (la
  # ruta del guion hermano) lo tapaba, y arreglar sólo ése habría dejado la nota igual de falsa.
  NUEVAS=$(bash "$NOTAS_SH" --type form --from-server "$URL" "$USUARIO" "$CLAVE" "$FORM" "$FORM/src" "$FORM/package.json" 2>&1 >"$TMP/notas.txt" | sed 's/^/    /' )
  [ -n "$NUEVAS" ] && echo "$NUEVAS" >&2
  if [ ! -s "$TMP/notas.txt" ]; then
    echo "[notas] no se pudo calcular la nota de $FORM; se deja la del empaquetado" >&2
    DEGRADADAS=$((DEGRADADAS+1))
    rm -rf "$TMP"; continue
  fi
  # release-notes.sh dice contra QUÉ calculó: "…la versión que está publicada…" cuando el servidor
  # contestó, "…el build anterior…" cuando no (o "Últimos cambios" si ni eso). Sólo la primera es
  # la nota que este paso promete; cualquier otra se escribe igual —es mejor que nada— pero cuenta.
  if ! grep -q 'la versión que está publicada' "$TMP/notas.txt"; then
    echo "[notas] $FORM: el servidor no dijo qué versión tiene publicada — la nota quedó calculada contra el build anterior" >&2
    DEGRADADAS=$((DEGRADADAS+1))
  fi

  if ! jq --rawfile n "$TMP/notas.txt" '.forms[0].releaseNotes = $n' "$TMP/manifest.json" > "$TMP/manifest.new.json" \
     || [ ! -s "$TMP/manifest.new.json" ]; then
    echo "[notas] no se pudo actualizar el manifiesto de $FORM; se deja la nota original" >&2
    rm -rf "$TMP"; continue
  fi

  mv "$TMP/manifest.new.json" "$TMP/manifest.json"
  # Con ruta absoluta: `zip` corre dentro de $TMP y el ZIP puede venir por ruta relativa.
  ZIP_ABS="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"
  if ( cd "$TMP" && zip -q "$ZIP_ABS" manifest.json ) 2>/dev/null; then
    # Neutro a propósito: si el servidor no contestó, la nota es la del build anterior y
    # decir "recalculadas contra el servidor" sería mentir. El texto de abajo lo dice solo.
    echo "[notas] $FORM: notas actualizadas dentro del paquete"
    sed 's/^/    /' "$TMP/notas.txt"
  else
    echo "[notas] no se pudo reescribir $(basename "$ZIP"); se deja la nota original" >&2
  fi
  rm -rf "$TMP"
done

if [ "$DEGRADADAS" -gt 0 ]; then
  echo "[notas] $DEGRADADAS nota(s) NO se calcularon contra el servidor (ver arriba) — el paso sale 3 para que no se vea verde" >&2
  exit 3
fi
exit 0
