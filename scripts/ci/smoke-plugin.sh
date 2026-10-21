#!/usr/bin/env bash
# =============================================================================
# smoke-plugin.sh — ¿el plugin que acabo de instalar está vivo y es la versión que dije?
# =============================================================================
# Es la ÚNICA prueba del circuito que toca el paquete INSTALADO: las unitarias y las de
# contenedor prueban el código; esto pregunta al host, después de subir y activar, si el
# plugin figura activo, como default y con la versión exacta que este run empaquetó.
# Etapas 3 (staging) y 4 (producción) del flujo objetivo: artifacts/camino-del-paquete.html.
#
# Uso: smoke-plugin.sh <url> <usuario> <clave> <nombre-del-plugin> <versión-esperada>
#
# Exit: 0 sólo si el host contestó y el plugin está activo + default + versión exacta.
#       1 en cualquier otro caso — incluido "no pude entrar" o "no pude leer la respuesta".
#       🔴 Fail-closed a propósito: un humo que no pudo mirar NO está aprobado. Este paso NO va
#       con continueOnError en los pipelines: si falla, el Deploy falla, y producción (que
#       verifica el Deploy del run que promueve) no lo acepta.
#
# Reintenta la comprobación 3 veces cada 10 s: el host tarda unos segundos en activar.
# Reintenta el login 4 veces ante fallas transitorias (000/429/5xx), como release-notes.sh.
# =============================================================================
set -uo pipefail
URL="${1:?url}"; USUARIO="${2:?usuario}"; CLAVE="${3:?clave}"; PLUGIN="${4:?nombre del plugin}"; ESPERADA="${5:?versión esperada}"
# 🔴 EL IDENTIFICADOR DE COMPILACIÓN, OPCIONAL. La versión sola no dice que lo instalado
# sea ESTE build: se re-empaqueta y se sube sin tocar el número, y el humo lo aprueba igual. Es el
# mismo agujero que el humo de formularios tenía comparando versión contra versión.
# Se pasa el hash corto que este run empaquetó; si el host lo devuelve y NO coincide, es rojo.
# Si el host no lo devuelve, AVISA y no frena: hay plugins que todavía pueden no reportarlo.
ESPERADO_HASH="${6:-}"

# >>> nombre-seguro — SEC-C1. Este bloque es byte a byte el mismo en smoke-plugin.sh y smoke-forms.sh (lo verifica smoke.test.sh)
# 🔴 UN NOMBRE NO SE METE CRUDO EN UNA CONSULTA AL HOST NI EN UN MENSAJE. El nombre del
# plugin sale del plugin.json del ZIP y el de cada formulario del manifest.json del ZIP: es texto del
# PAQUETE. Tal cual en la URL (`../` cambia la ruta, `?` le agrega parámetros) o en cada línea de
# salida (donde Azure interpreta `##vso[` esté donde esté), un nombre armado a propósito se aprobaría igual.
# Un nombre que no pasa NO se consulta: el humo sale rojo y lo dice — no verificar nunca es verde.
# El juego acepta todos los nombres de plugins y formularios publicados.
# Va copiado en los dos humos y no en un tercer archivo a propósito: el artefacto puede llegar incompleto
# y eso no puede ser un modo nuevo de tumbar un despliegue.
REGLA_NOMBRE="empieza con letra o dígito, usa sólo letras, dígitos, '.', '_' y '-', no contiene '..' y tiene hasta 100 caracteres"
nombre_seguro() { # se compara la cadena ENTERA ([[ =~ ]]), no línea por línea como haría grep: un salto de línea no pasa
  local LC_ALL=C re='^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  case "$1" in *..*) return 1 ;; esac
  [[ "$1" =~ $re ]]
}
# para MOSTRAR un nombre que no pasó: lo que no es del juego se ve como '?', así no puede armar un `##vso[`
nombre_visible() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._-' '?' | cut -c1-60; }
# segunda barrera: aunque el juego se amplíe, a la URL va codificado (hoy no cambia nada: son caracteres no reservados)
en_url() { jq -rn --arg s "$1" '$s|@uri' 2>/dev/null; }
# 🔴 LO DEMÁS QUE TRAE EL PAQUETE TAMBIÉN SE VALIDA, Y LO QUE DICE EL HOST SE MUESTRA SANEADO. La versión y el
# identificador de compilación salen del mismo plugin.json / manifest.json que el nombre e iban a las mismas
# líneas de salida. Las versiones publicadas son N.N.N; la forma admitida es la que ya exige el registro de
# despliegues, así un humo verde nunca deja una versión que el registro después rechaza.
REGLA_VERSION="tiene forma de versión: tres números separados por puntos (1.0.214), con un sufijo opcional de letras, dígitos y puntos detrás de '-' o '.', hasta 60 caracteres"
version_segura() {
  local LC_ALL=C re='^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$'
  [ "${#1}" -le 60 ] && [[ "$1" =~ $re ]]
}
es_commit() { local LC_ALL=C re='^[0-9a-fA-F]{7,40}$'; [[ "$1" =~ $re ]]; }
es_numero() { local LC_ALL=C re='^[0-9]{1,15}$'; [[ "$1" =~ $re ]]; }
# Lo que devuelve el HOST no se valida —si no coincide con lo esperado el humo ya es rojo—, pero tampoco sale
# tal cual: una versión o una bandera se muestran con nombre_visible; un texto libre (un motivo, el cuerpo de
# un error) en una sola línea y sin '#', que es con lo que Azure arma `##vso[` y `##[`. Los acentos se conservan.
texto_visible() { printf '%s' "$1" | LC_ALL=C tr '\000-\037\177' ' ' | LC_ALL=C tr -d '#' | cut -c1-200; }
# <<< nombre-seguro
if ! nombre_seguro "$PLUGIN"; then
  echo "##vso[task.logissue type=error][humo] el nombre del plugin no es válido («$(nombre_visible "$PLUGIN")», mostrado sin sus caracteres raros): un nombre $REGLA_NOMBRE. NO se consultó al host — un plugin que no se pudo consultar NO está verificado"
  exit 1
fi
if ! version_segura "$ESPERADA"; then
  echo "##vso[task.logissue type=error][humo] $PLUGIN: la versión esperada no es válida («$(nombre_visible "$ESPERADA")», mostrada sin sus caracteres raros): una versión $REGLA_VERSION. NO se consultó al host — un plugin que no se pudo consultar NO está verificado"
  exit 1
fi
if [ -n "$ESPERADO_HASH" ] && ! es_commit "$ESPERADO_HASH"; then
  echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: el identificador de compilación esperado no es válido («$(nombre_visible "$ESPERADO_HASH")»): tiene que ser un commit, de 7 a 40 caracteres hexadecimales. NO se consultó al host — no está verificado"
  exit 1
fi
PLUGIN_URL=$(en_url "$PLUGIN") || PLUGIN_URL=""
[ -n "$PLUGIN_URL" ] || { echo "##vso[task.logissue type=error][humo] no pude codificar el nombre del plugin para la consulta (¿falta jq?) — NO se consultó al host, así que no está verificado"; exit 1; }

# 🔴 EL REGISTRO DE DESPLIEGUES. Un humo aprobado, dentro de una corrida de Azure, deja
# una línea `[registro-despliegue]` y sus etiquetas (contrato en deploy-record.sh). Anotar nunca
# cambia el veredicto: si el ayudante no llegó con el artefacto, se avisa y el humo sale igual.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRO_OK=no
if [ -f "$AQUI/deploy-record.sh" ] && . "$AQUI/deploy-record.sh"; then REGISTRO_OK=si; fi
registrar_despliegue() {
  if [ "$REGISTRO_OK" = si ]; then
    registro_despliegue desplegado plugin "$PLUGIN" "$ESPERADA" "$ESPERADO_HASH" || true
  elif [ "${TF_BUILD:-}" = "True" ]; then
    echo "##vso[task.logissue type=warning]registro-despliegue: no está deploy-record.sh al lado del humo (¿el artefacto arnes-ci llegó incompleto?) — esta corrida queda SIN registro de despliegue"
  fi
}

login() {
  local headers respuesta body code token intento
  headers=$(mktemp); respuesta=$(mktemp)
  body=$(jq -nc --arg u "$USUARIO" --arg p "$CLAVE" '{username:$u, password:$p, tenant_id:"default"}')
  for intento in 1 2 3 4; do
    code=$(curl -s -D "$headers" -o "$respuesta" -w '%{http_code}' --max-time 25 \
      "${URL}/api/auth/login" -H 'Content-Type: application/json' --data-raw "$body" 2>/dev/null) || code="000"
    [ "$code" = "200" ] && break
    # 🔴 El host devuelve su límite de ingresos como 401 con {"error":"Too Many Requests"}, no
    # como 429 (el humo puede ser uno de varios logins seguidos del mismo job y el host lo corta). Ese 401 es
    # transitorio y se reintenta con espera larga; un 401 sin ese texto es clave mal y no se reintenta.
    if [ "$code" = "401" ] && grep -qi "too many requests" "$respuesta" 2>/dev/null; then code="429"; fi
    case "$code" in 000|429|5??) [ "$intento" -lt 4 ] && { echo "[humo] login HTTP $code (intento $intento) — reintento en $((intento*15))s" >&2; sleep $((intento*15)); } ;; *) break ;; esac
  done
  if [ "$code" != "200" ]; then echo "[humo] no se pudo entrar al host (HTTP $code, $intento intento/s): $(texto_visible "$(head -c 160 "$respuesta" 2>/dev/null)")" >&2; rm -f "$headers" "$respuesta"; return 1; fi
  token=$(grep -i 'set-cookie:.*admin_token=' "$headers" | sed 's/.*admin_token=\([^;]*\).*/\1/' | head -1)
  [ -z "$token" ] && token=$(jq -r '.token // .accessToken // empty' "$respuesta" 2>/dev/null)
  rm -f "$headers" "$respuesta"
  [ -z "$token" ] && { echo "[humo] el login no devolvió token" >&2; return 1; }
  printf '%s' "$token"
}

TOKEN=$(login) || exit 1

for intento in 1 2 3; do
  LISTA=$(curl -s --max-time 25 "${URL}/api/admin/plugins" -H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" -H 'X-Tenant-Id: default' 2>/dev/null) || LISTA=""
  # La respuesta puede venir como array o envuelta; se busca el plugin por nombre y, entre sus
  # versiones cargadas, la que está marcada como default. Sólo ésa cuenta.
  ESTADO=$(printf '%s' "$LISTA" | jq -r --arg n "$PLUGIN" '
    (if type=="array" then . else (.plugins // .data // .items // .value // []) end)
    | map(select((.name // "" | ascii_downcase) == ($n | ascii_downcase)))
    | (map(select(.isDefault == true)) | .[0]) // .[0]
    | if . == null then "AUSENTE" else "\(.version)|\(.isActive)|\(.isDefault)" end' 2>/dev/null) || ESTADO="ILEGIBLE"
  [ -z "$ESTADO" ] && ESTADO="ILEGIBLE"
  VER="${ESTADO%%|*}"; RESTO="${ESTADO#*|}"; ACTIVO="${RESTO%%|*}"; DEFAULT="${RESTO#*|}"
  # 🔴 `isActive` NO significa "cargado": esa bandera la pone
  # en verdadero el upload para TODA versión subida, cargada o no. En todo el host no hay un solo
  # lugar que la ponga en falso. O sea que mirarla sola aprueba un plugin que no está corriendo.
  # Se pregunta por lo CARGADO de verdad, y por el motivo de degradación (el host puede cargar el
  # plugin con sus servicios internos caídos, devolver 200 y guardar el motivo en vez de fallar).
  if [ "$VER" = "$ESPERADA" ] && [ "$ACTIVO" = "true" ] && [ "$DEFAULT" = "true" ]; then
    CARGADAS=$(curl -s --max-time 25 "${URL}/api/admin/plugins/loaded" -H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" 2>/dev/null)
    CARGADA=$(printf '%s' "$CARGADAS" | jq -r --arg n "$PLUGIN" '
      (if type=="array" then . else (.plugins // .data // .items // .value // []) end)
      | map(select((.name // "" | ascii_downcase) == ($n | ascii_downcase)))
      | .[0].version // "NINGUNA"' 2>/dev/null) || CARGADA="ILEGIBLE"
    [ -z "$CARGADA" ] && CARGADA="ILEGIBLE"
    if [ "$CARGADA" != "$ESPERADA" ]; then
      echo "[humo] intento $intento: marcada v$(nombre_visible "$VER") pero CARGADA=$(nombre_visible "$CARGADA") — el host sirve otra versión"
      [ "$intento" -lt 3 ] && { sleep 10; continue; }
      echo "##vso[task.logissue type=error][humo] $PLUGIN: la versión marcada como actual es v$ESPERADA pero la que el host tiene CARGADA es $(nombre_visible "$CARGADA") — el despliegue anotó y no cargó"
      exit 1
    fi
    # 🔴 "SANO" HAY QUE PREGUNTARLO: imprimir "sano" sin medirlo sería mentir. El host puede cargar el plugin con
    # sus servicios internos caídos, devolver 200
    # y guardar el motivo en vez de fallar. Un 404 acá significa que esa versión del host no tiene
    # el chequeo — no es "sano", es "no se puede preguntar", y se dice.
    ID=$(printf '%s' "$LISTA" | jq -r --arg n "$PLUGIN" --arg v "$ESPERADA" '
      (if type=="array" then . else (.plugins // .data // .items // .value // []) end)
      | map(select((.name // "" | ascii_downcase) == ($n | ascii_downcase) and .version == $v))
      | .[0].pluginId // empty' 2>/dev/null)
    SANO="no medido"
    # 🔴 El identificador lo devuelve el HOST y también va a una URL: mismo criterio que el nombre (SEC-C1).
    # Que el host no lo traiga es una capacidad ausente y avisa (abajo); que traiga uno imposible es una
    # respuesta anormal, y un chequeo que no se pudo hacer NO es un chequeo aprobado.
    if [ -n "$ID" ] && ! nombre_seguro "$ID"; then
      echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: el host devolvió un identificador de plugin que no se puede usar en una consulta («$(nombre_visible "$ID")») — NO se verificó si cargó a medias"
      exit 1
    fi
    if [ -n "$ID" ]; then
      ID_URL=$(en_url "$ID") || ID_URL=""
      [ -n "$ID_URL" ] || { echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: no pude codificar el identificador del plugin para preguntar por su salud (¿falta jq?) — un chequeo que no se pudo hacer NO es un chequeo aprobado"; exit 1; }
      SAL=$(curl -s -w '\n%{http_code}' --max-time 25 "${URL}/api/admin/plugins/${ID_URL}/health" \
        -H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" 2>/dev/null)
      SAL_CODE=$(printf '%s' "$SAL" | tail -1); SAL_BODY=$(printf '%s' "$SAL" | sed '$d')
      case "$SAL_CODE" in
        200)
          # 🔴 Un 200 con cuerpo ilegible (HTML del proxy, vacío) haría que jq no encontrara el campo
          # y se imprimiera "sano" sin haber leído nada — la misma mentira que este bloque cierra.
          if ! printf '%s' "$SAL_BODY" | jq -e . >/dev/null 2>&1; then
            echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: el estado de salud vino ilegible (no es JSON) — un chequeo que no se pudo hacer NO es un chequeo aprobado"
            exit 1
          fi
          MOT=$(printf '%s' "$SAL_BODY" | jq -r '.errorMessage // .reason // empty' 2>/dev/null)
          if [ -n "$MOT" ]; then
            echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA está cargado pero DEGRADADO: $(texto_visible "$MOT")"
            exit 1
          fi
          SANO="sano" ;;
        404) echo "[humo] el host no expone /health para este plugin — no se pudo verificar el modo degradado" >&2 ;;
        *)   echo "##vso[task.logissue type=error][humo] no pude leer el estado de salud de $PLUGIN v$ESPERADA (HTTP $SAL_CODE) — un chequeo que no se pudo hacer NO es un chequeo aprobado"
             exit 1 ;;
      esac
    else
      # 🔴 No poder preguntar NO es "sano": queda como aviso visible, no como una línea en stderr
      # que nadie mira. La línea final va a decir "no medido" — pero sin este aviso, un verde con
      # "no medido" se lee igual que un verde con "sano".
      echo "##vso[task.logissue type=warning][humo] $PLUGIN v$ESPERADA: no pude resolver su identificador para preguntar por el modo degradado — NO se verificó si cargó a medias"
    fi
    # El identificador de compilación, si este run lo pasó: pregunta al /health del PLUGIN.
    if [ -n "$ESPERADO_HASH" ]; then
      # 🔴 DOS COSAS DISTINTAS, Y SÓLO UNA ADMITE AVISO.
      #
      # Esta llamada va a las RUTAS PROPIAS del plugin, no a la API de administración. Que el host
      # diga "cargado, activo y default" no prueba que el plugin esté SIRVIENDO: si tras la recarga
      # sus rutas devuelven 404 —o el HTML del proxy— los frenos duros de arriba no lo ven, porque
      # miran /loaded y el health de administración. Por eso un código distinto de 200 es ROJO, con
      # reintentos: el humo exige 200 de las rutas propias del plugin.
      #
      # Que el cuerpo no traiga el identificador es otra cosa: hay plugins que todavía no lo
      # reportan. Eso avisa y no frena.
      HCODE=""; HB=""
      for hi in 1 2 3; do
        RESP=$(curl -s -w '\n%{http_code}' --max-time 20 "${URL}/api/plugins/${PLUGIN_URL}/health" 2>/dev/null)
        HCODE=$(printf '%s' "$RESP" | tail -1); HB=$(printf '%s' "$RESP" | sed '$d')
        [ "$HCODE" = "200" ] && break
        [ "$hi" -lt 3 ] && { echo "[humo] las rutas de $PLUGIN contestaron HTTP $HCODE (intento $hi) — reintento en 5s" >&2; sleep 5; }
      done
      if [ "$HCODE" != "200" ]; then
        echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: sus PROPIAS rutas no contestan (HTTP $HCODE en /api/plugins/${PLUGIN}/health tras 3 intentos) — el host lo da por cargado pero no está sirviendo"
        exit 1
      fi
      HASH=$(printf '%s' "$HB" | jq -r '.commitHash // empty' 2>/dev/null)
      if [ -z "$HASH" ]; then
        echo "##vso[task.logissue type=warning][humo] $PLUGIN v$ESPERADA: el host no devuelve el identificador de compilación — NO se pudo verificar que lo instalado sea ESTE build (sólo que la versión coincide)"
      elif [ "${HASH:0:${#ESPERADO_HASH}}" != "$ESPERADO_HASH" ]; then
        echo "##vso[task.logissue type=error][humo] $PLUGIN v$ESPERADA: el host corre el build $(nombre_visible "$HASH") y este run empaquetó $ESPERADO_HASH — misma versión, OTRO código"
        exit 1
      else
        SANO="$SANO, sirviendo por sus propias rutas y es el build $ESPERADO_HASH"
      fi
    fi
    echo "[humo] ✅ $PLUGIN v$ESPERADA: cargado, activo, default y $SANO (intento $intento)"
    registrar_despliegue
    exit 0
  fi
  echo "[humo] intento $intento: $PLUGIN → versión=$(nombre_visible "$VER") activo=$(nombre_visible "$ACTIVO") default=$(nombre_visible "$DEFAULT") (esperaba v$ESPERADA activo+default)" >&2
  [ "$intento" -lt 3 ] && sleep 10
done
echo "##vso[task.logissue type=error][humo] $PLUGIN NO quedó como v$ESPERADA activo+default en el host — el paquete instalado no es el que este run dijo"
exit 1
