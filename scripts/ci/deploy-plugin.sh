#!/usr/bin/env bash
# deploy-plugin.sh — subir, migrar, activar y marcar como actual. En ese orden, sin atajos.
#
# 🔴 POR QUÉ EXISTE (2026-09-02).
#
# La secuencia de despliegue estuvo MAL escrita cuatro veces seguidas en el plan de cierre, cada una
# por un extremo distinto, porque se escribía desde informes y no desde el código del host. Las
# cuatro habrían dejado producción rota con la corrida en verde:
#
#   v3 · subir sin marcar → ejecutar → marcar como actual.   Marcar NO CARGA el plugin: producción
#        sigue sirviendo la versión anterior con la nueva marcada. Es el incidente de un producto del equipo del
#        2026-08-15, y el staging de otro producto ya lo tenía comentado con esa fecha
#        — guides/maintaining/incident-log.md#case-mark-without-load-2026-08-15.
#   v4 · subir sin marcar → ejecutar → activar.              Activar carga pero NO marca. Funciona
#        hasta el próximo reinicio del App Service: al arrancar, el host carga sólo lo que está
#        marcado como actual Y estaba corriendo, así que después del reinicio no carga NINGUNA.
#   v5 · las cuatro llamadas, pero marcando al final sin preguntar. Si marcar se niega (y se niega
#        por cuatro motivos), queda el estado de la v4: en rojo, pero con la bomba armada.
#   hoy · se PREGUNTA primero (la vista previa hace el mismo análisis sin tocar nada), así una
#        negativa termina la corrida con la versión anterior todavía cargada y marcada.
#
# 🔴 LO QUE EL HOST HACE, llamada por llamada (leído en PluginAdminController.cs / PluginManager.cs,
# no en un informe). Esta tabla es el motivo de que el orden sea éste y no otro:
#
#   subir con setAsDefault=true  → marca la nueva como actual, DESCARGA LA ANTERIOR y trata de
#                                  cargar la nueva; con migraciones pendientes la nueva falla y no
#                                  queda NINGUNA cargada. Por eso no se usa.
#   subir con setAsDefault=false → guarda la versión, no toca la memoria. La anterior sigue viva.
#   vista previa de marcar       → el MISMO análisis que marcar, sin efectos. Es el freno.
#   ejecutar migraciones         → devuelve 200 AUNQUE alguna haya fallado, con un contador.
#   activar                      → descarga la anterior y carga la nueva. NO toca la marca.
#   marcar como actual           → escribe la marca. NO carga nada. Se niega por: migraciones
#                                  pendientes · retroceso sin aprobación · retroceso sin guion de
#                                  reversión sin reconocimiento.
#   al reiniciar el host         → carga sólo lo marcado como actual Y que estaba corriendo.
#
# 🔴 Y DOS SEÑALES QUE NO SE PUEDEN TIRAR:
#   · la respuesta de subir trae las opciones de configuración que faltan. Es la ÚNICA señal de
#     configuración que el host da, y sólo frena por ella cuando se sube marcando como actual —
#     que acá no hacemos. Si faltan, la corrida termina en rojo.
#   · activar puede devolver 200 con el plugin en MODO DEGRADADO: cargó, pero sus servicios
#     internos no arrancaron y el host guarda el motivo en vez de fallar. Se lee y se exige vacío.
#
# Uso:
#   deploy-plugin.sh --url <host> --user <u> --password <c> --zip <archivo> --endpoint <ruta>
#                    [--environment staging|production] [--pending-options <archivo.json>]
#                       [--exclusions <números de migración excluidos a propósito>]
#
#   --environment: «production» tenía su nombre castellano hasta la story 8.9 (tanda B3a) y el viejo sigue
#   andando hasta el retiro. Lo que queda escrito para el humo del job (deploy-record.sh) NO cambia:
#   es un dato de registro y sigue con el nombre de siempre.
#
#   --pending-options: archivo con las opciones de configuración que el equipo deja vacías A
#   SABIENDAS, con motivo y fecha. Forma: {"revision":"AAAA-MM-DD","opciones":[{"opcion":"X:Y",
#   "motivo":"por qué"}]}. Lo NO declarado frena igual; una declaración vencida o sin fecha frena.
#
# Exit: 0 desplegado y verificado · 1 falló (con la anterior recuperada donde se pudo)
#       2 no se pudo ni empezar (credenciales, archivo, login)
set -u

URL=""; USUARIO=""; CLAVE=""; ZIP=""; ENDPOINT=""; ENTORNO="staging"; PENDIENTES_ARCH=""; EXCLUSIONES=""; RETRO_APROBADO=no
# Las opciones renombradas a inglés (story 8.9, tanda B2): los pipelines de los productos siguen pasando las viejas hasta
# el retiro, y este guion corre en producción desde el artefacto arnes-ci (sólo scripts/ci): el traductor vive al lado.
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  legacy_options 'usuario:user clave:password entorno:environment opciones-pendientes:pending-options exclusiones:exclusions environment=produccion:production' "$@" || exit 2
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi
# story 2.10: el entorno sólo se DECLARA al humo del job si vino por --environment (el default no es una declaración)
case " $* " in *" --environment "*) ENTORNO_EXPLICITO=si ;; *) ENTORNO_EXPLICITO=no ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --user) USUARIO="$2"; shift 2 ;;
    --password) CLAVE="$2"; shift 2 ;;
    --zip) ZIP="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --environment) ENTORNO="$2"; shift 2 ;;
    --pending-options) PENDIENTES_ARCH="$2"; shift 2 ;;
    --exclusions) EXCLUSIONES="$2"; shift 2 ;;
    -h|--help) sed -n '1,58p' "$0"; exit 0 ;;
    *) echo "[desplegar] argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
# story 8.9 (B3a): la opción dice «production», pero el registro de despliegues que lee el humo —y la línea del
# ingreso, que los pipelines de los productos ya muestran así— guardan su dato de siempre (sin comillas: es el dato
# grabado, no un nombre que alguien escribe; el freno de nombres cuenta los valores del mapa entre comillas).
case "$ENTORNO" in production) ENTORNO=produccion ;; esac

fatal() { echo "##vso[task.logissue type=error]$1"; exit "${2:-1}"; }
paso()  { echo ""; echo "── $1"; }

[ -n "$URL" ] && [ -n "$USUARIO" ] && [ -n "$CLAVE" ] || fatal "faltan credenciales o URL del host — un despliegue que no puede empezar NO está desplegado" 2
[ -n "$ENDPOINT" ] || fatal "falta --endpoint (la ruta de subida del host): sin ella la URL queda apuntando a la raíz y el error es un 404 confuso" 2
[ -f "$ZIP" ] || fatal "no encuentro el paquete: ${ZIP:-<vacío>}" 2
command -v jq >/dev/null 2>&1 || fatal "falta jq" 2

ZIP_NAME=$(basename "$ZIP")
# 🔴 El nombre del plugin sale del nombre del paquete y se necesita ANTES de la primera llamada:
# la recuperación tiene que reactivar UNA VERSIÓN DE ESTE plugin, no "la primera marcada como
# actual que no sea yo" — en un host con varios plugins eso reactiva uno AJENO, imprime "versión
# anterior vuelta a cargar" y deja el nuestro descargado: se toca algo que nadie pidió tocar y el
# registro dice lo contrario de lo que pasó. `smoke-plugin.sh` y `rollback-guard.sh` ya filtran
# por nombre; este guion era el único que no.
NOMBRE_PLUGIN=$(echo "$ZIP_NAME" | sed -E 's/^([^.]*)\..*/\1/')

# 🔴 EL REGISTRO DE DESPLIEGUES (story 2.10). Tras entrar al host y antes de subir nada, la corrida
# queda con una línea `[registro-despliegue]` «intentado» y la etiqueta `despliegue-intentado`: una
# corrida con esa etiqueta y sin `desplegado` es un despliegue que falló. También deja el entorno
# declarado para el humo del mismo job. Contrato en deploy-record.sh. Nunca cambia el resultado.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRO_OK=no
if [ -f "$AQUI/deploy-record.sh" ] && . "$AQUI/deploy-record.sh"; then REGISTRO_OK=si; fi

# ── login ────────────────────────────────────────────────────────────────────────────────────
#
# 🔴 CON REINTENTO, Y NO POR PRUDENCIA: los tres modos de abajo son incidentes medidos, y la
# primera versión de este guion los perdió todos al unificar el despliegue en un solo lugar.
#
#   · "Too Many Requests" → el host LIMITA los ingresos seguidos. Medido en URUTAU (build 9060):
#     el paso que recalcula las notas se loguea una vez por formulario, y con ocho el ingreso del
#     despliegue caía justo detrás del límite.
#   · "circuit is now open" → el host CORTA LA CORRIENTE: tras varios fallos rechaza todo por
#     minutos, sin mirar la contraseña. Espera más larga a propósito: reintentar cada 15 s sólo
#     gasta los intentos sin llegar a que el candado se cierre.
#   · 404/502/503/504 → el host TODAVÍA NO LEVANTÓ. Medido el 2026-08-31: el despliegue devolvió
#     404 y el cuerpo era la pantalla web del panel — el proxy contestó con el front porque la
#     parte de servidor no estaba arriba. Cuatro corridas antes, el mismo día y la misma URL,
#     había funcionado. Eso es "esperá", no "la dirección está mal".
#
# Cualquier OTRO error aborta de una: no es transitorio y reintentar sólo demora el rojo.
paso "Ingreso al host ($ENTORNO)"
HDR=$(mktemp); TOKEN=""
for intento in 1 2 3 4; do
  LOGIN=$(curl -s -D "$HDR" -w "\n%{http_code}" "${URL}/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data-raw "{\"username\":\"${USUARIO}\",\"password\":\"${CLAVE}\",\"tenant_id\":\"default\"}")
  LOGIN_CODE=$(echo "$LOGIN" | tail -1); CUERPO=$(echo "$LOGIN" | sed '$d')
  if [ "$LOGIN_CODE" = "200" ]; then
    TOKEN=$(grep -i 'set-cookie:.*admin_token=' "$HDR" | sed 's/.*admin_token=\([^;]*\).*/\1/' | head -1)
    [ -z "$TOKEN" ] && TOKEN=$(printf '%s' "$CUERPO" | jq -r '.token // .accessToken // empty' 2>/dev/null)
    [ -n "$TOKEN" ] && break
    fatal "el host aceptó el ingreso pero no devolvió token" 2
  fi
  if printf '%s' "$CUERPO" | grep -qiE "Too Many Requests|circuit is now open|circuit breaker"; then
    if printf '%s' "$CUERPO" | grep -qi "circuit"; then
      ESPERA=$((intento * 45)); MOTIVO="el host cortó la corriente (se protege tras fallos seguidos)"
    else
      ESPERA=$((intento * 15)); MOTIVO="el host está limitando los ingresos"
    fi
    echo "   ⏳ $MOTIVO (intento $intento) — reintento en ${ESPERA}s"; sleep "$ESPERA"; continue
  fi
  case "$LOGIN_CODE" in
    404|502|503|504)
      ESPERA=$((intento * 20))
      echo "   ⏳ el host no está sirviendo su API (HTTP $LOGIN_CODE, intento $intento) — reintento en ${ESPERA}s"
      sleep "$ESPERA"; continue ;;
  esac
  rm -f "$HDR"; fatal "no pude ingresar al host (HTTP $LOGIN_CODE): $(printf '%s' "$CUERPO" | head -c 200)" 2
done
rm -f "$HDR"
[ -n "$TOKEN" ] || fatal "no pude ingresar al host tras 4 intentos — el host limita, cortó la corriente o no está arriba" 2
echo "   ok"
if [ "$REGISTRO_OK" = si ]; then
  [ "$ENTORNO_EXPLICITO" = si ] && registro_declarar_entorno "$ENTORNO"
  VERSION_ZIP=$(echo "$ZIP_NAME" | sed -E 's/^[^.]*\.([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
  HASH_ZIP=""
  command -v unzip >/dev/null 2>&1 && HASH_ZIP=$(unzip -p "$ZIP" plugin.json 2>/dev/null | jq -r '.commitHash // empty' 2>/dev/null)
  registro_despliegue intentado plugin "$NOMBRE_PLUGIN" "$VERSION_ZIP" "$HASH_ZIP" || true
elif [ "${TF_BUILD:-}" = "True" ]; then
  echo "##vso[task.logissue type=warning]registro-despliegue: no está deploy-record.sh al lado del guion (¿el artefacto arnes-ci llegó incompleto?) — esta corrida queda SIN registro de despliegue"
fi

api() { # api <método> <ruta> [datos-curl-extra...]
  local m="$1" ruta="$2"; shift 2
  curl -s -w "\n%{http_code}" -X "$m" "${URL}${ruta}" -H "Cookie: admin_token=${TOKEN}" "$@"
}
cuerpo() { echo "$1" | sed '$d'; }
codigo() { echo "$1" | tail -1; }

# 🔴 TODA SALIDA POSTERIOR A "ACTIVAR" TIENE QUE RECUPERAR LA ANTERIOR (2026-09-03).
#
# Activar descarga la versión vieja y carga la nueva, pero NO toca la marca de "actual". Entonces,
# cualquier fallo DESPUÉS de ese punto deja el peor estado posible: la nueva a medias y la anterior
# marcada pero descargada — o sea que el host sirve algo roto AHORA y, al próximo reinicio, no carga
# NINGUNA versión. Es exactamente el estado por el que se descartó la variante v4 de este guion: "en
# rojo, pero con la bomba armada".
#
# Esto era una función porque la recuperación estaba escrita a mano en dos lugares y, al agregar el
# tercer camino de salida (el chequeo de salud del mismo día), se olvidó — tres salidas nuevas sin
# recuperación y sin que nadie lo dijera. Repetir a mano una secuencia de recuperación es cómo se
# pierde: ahora hay UN solo lugar y todas las salidas lo llaman.
recuperar_anterior() {
  local ANT ID_ANT
  ANT=$(api GET "/api/admin/plugins")
  if [ "$(codigo "$ANT")" != "200" ]; then
    echo "   ⚠️ NO pude leer la lista para recuperar la anterior: el plugin puede haber quedado sin cargar"
    return 1
  fi
  ID_ANT=$(cuerpo "$ANT" | jq -r --arg id "$PLUGIN_ID" --arg n "$NOMBRE_PLUGIN" '(if type=="array" then . else (.plugins // .data // .items // .value // []) end) | map(select(((.name // "" | ascii_downcase) == ($n | ascii_downcase)) and .isDefault==true and ((.pluginId|tostring)!=$id))) | .[0].pluginId // empty')
  if [ -z "$ID_ANT" ]; then
    echo "   ⚠️ no encontré otra versión de '$NOMBRE_PLUGIN' marcada como actual para recuperar"
    return 1
  fi
  # 🔴 MIRAR EL CÓDIGO HTTP, NO EL DE CURL (2026-09-03, corrección del mismo día). `api()` no usa
  # `--fail`, así que curl sale 0 con un 500, un 404 o el HTML del proxy. El `if` juzgaba por el
  # código de salida de curl y afirmaba "versión anterior vuelta a cargar" sin haberlo medido: la
  # corrida quedaba en rojo pero el registro decía lo contrario de lo que pasó, y el operador creía
  # que el host seguía sirviendo la versión vieja cuando no había NINGUNA cargada. La incoherencia
  # era interna a esta misma función: la lectura de la lista sí mira el código; la escritura no.
  local RES CODE
  RES=$(api POST "/api/admin/plugins/${ID_ANT}/activate" -H "Content-Type: application/json" --data '')
  CODE=$(codigo "$RES")
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || [ "$CODE" = "204" ]; then
    echo "   versión anterior vuelta a cargar"
    return 0
  fi
  echo "   ⚠️ NO pude recuperar la anterior (HTTP $CODE): el plugin quedó SIN CARGAR — hay que volver a activar la versión $ID_ANT a mano"
  return 1
}


# 🔴 CÓMO SE LEE LA LISTA DE PLUGINS (2026-09-03). El host la devuelve a veces como arreglo y a
# veces envuelta. La primera versión de este guion sólo entendía el arreglo, así que ante una
# respuesta envuelta la recuperación de la versión anterior fallaba EN SILENCIO —y el aviso de "no
# pude recuperar" quedaba dentro del bloque que no se ejecutaba, o sea que el plugin quedaba
# descargado sin que nadie lo dijera. `smoke-plugin.sh` ya manejaba las dos formas: los dos guiones
# discrepaban sobre el mismo host. Se usa el mismo criterio que el humo.
LISTA_DE_PLUGINS='(if type=="array" then . else (.plugins // .data // .items // .value // []) end)'

# ── 1. subir SIN marcar como actual ──────────────────────────────────────────────────────────
paso "1/5 · Subir el paquete SIN marcarlo como actual"
UP=$(api POST "$ENDPOINT" -F "file=@${ZIP};filename=${ZIP_NAME};type=application/zip" -F "setAsDefault=false")
UP_CODE=$(codigo "$UP"); UP_BODY=$(cuerpo "$UP")
PLUGIN_ID=$(echo "$UP_BODY" | jq -r '.pluginId // empty')

if [ "$UP_CODE" = "409" ]; then
  # 🔴 DOS rechazos distintos con el mismo código. "Ya existe" en una re-corrida no es un error:
  # se resuelve el identificador y se sigue. El de conflicto de migración SÍ es rojo.
  if echo "$UP_BODY" | grep -qiE "migration|migrac"; then
    fatal "el host rechazó el paquete por un conflicto de migraciones: $(echo "$UP_BODY" | head -c 300)"
  fi
  echo "   el paquete ya estaba subido (re-corrida): resuelvo el identificador y sigo"
  VER=$(echo "$ZIP_NAME" | sed -E 's/^[^.]*\.([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
  NOMBRE=$(echo "$ZIP_NAME" | sed -E 's/^([^.]*)\..*/\1/')
  LISTA=$(api GET "/api/admin/plugins"); [ "$(codigo "$LISTA")" = "200" ] || fatal "no pude listar los plugins para resolver el identificador"
  PLUGIN_ID=$(cuerpo "$LISTA" | jq -r --arg n "$NOMBRE" --arg v "$VER" \
    '(if type=="array" then . else (.plugins // .data // .items // .value // []) end) | map(select((.name|ascii_downcase)==($n|ascii_downcase) and .version==$v)) | .[0].pluginId // empty')
  [ -n "$PLUGIN_ID" ] || fatal "el paquete ya existía y no pude resolver su identificador (nombre=$NOMBRE versión=$VER)"
  # 🔴 En la re-corrida la lista de opciones faltantes NO vuelve a viajar (sólo la trae la subida
  # que salió bien): se pide por la dirección de la versión, o es rojo. Sin esto, re-encolar
  # ignorando un rojo que nombraba la opción la dejaría pasar.
  DET=$(api GET "/api/admin/plugins/${PLUGIN_ID}")
  [ "$(codigo "$DET")" = "200" ] || fatal "no pude releer la versión ya subida para verificar su configuración"
  FALTAN=$(cuerpo "$DET" | jq -r '[(.missingSettings // [])[]] | join(", ")')
elif [ "$UP_CODE" = "200" ] || [ "$UP_CODE" = "201" ]; then
  [ -n "$PLUGIN_ID" ] || fatal "la subida salió bien pero no trajo identificador de plugin — sin él no puedo migrar ni activar: $(echo "$UP_BODY" | head -c 300)"
  FALTAN=$(echo "$UP_BODY" | jq -r '[(.missingSettings // [])[]] | join(", ")')
  echo "   subido · identificador $PLUGIN_ID"
else
  fatal "la subida falló (HTTP $UP_CODE): $(echo "$UP_BODY" | head -c 400)"
fi

# 🔴 UNA OPCIÓN PENDIENTE SE DECLARA; LO NO DECLARADO FRENA (2026-09-03).
#
# El host avisa qué opciones de configuración no tienen valor. Eso es lo único que dice sobre
# configuración, y con la versión sin marcar no frena sola: si no se mira, el plugin queda corriendo
# sin la configuración que su funcionalidad espera y nadie se entera. Por eso frena.
#
# Pero hay opciones que el equipo deja vacías A SABIENDAS: una credencial de un servicio externo que
# todavía no existe, con el código preparado para devolver un error claro en el único endpoint que la
# usa. Frenar por ésas no protege nada — sólo enseña a apagar el control. Medido el 2026-09-03 en
# URUTAU: `Nimbo:ServiceSid` está declarada como bloqueante de una story en su propio
# `tasks/todo.md`, el servicio lanza un 503 explícito cuando falta, y los otros dos caminos de envío
# ni la usan (hay un comentario en el código explicando que dejaron de reusar ese servicio porque
# exigirla hacía fallar TODAS las confirmaciones por WhatsApp).
#
# Entonces la puerta es la misma que ya usamos para las vulnerabilidades: se DECLARA, con motivo y
# fecha de revisión. Una declaración vencida vuelve a frenar. Un archivo ilegible frena. Y una
# opción faltante que no esté declarada frena igual que antes — que es el 90% del valor del control.
if [ -n "$FALTAN" ]; then
  NO_DECLARADAS=""
  if [ -n "${PENDIENTES_ARCH:-}" ] && [ -f "$PENDIENTES_ARCH" ]; then
    jq -e . "$PENDIENTES_ARCH" >/dev/null 2>&1 \
      || fatal "el archivo de opciones pendientes ($PENDIENTES_ARCH) no se puede leer — un permiso ilegible no es un permiso"
    VENCE=$(jq -r '.revision // ""' "$PENDIENTES_ARCH")
    HOY=$(date -u +%Y-%m-%d)
    [ -n "$VENCE" ] || fatal "el archivo de opciones pendientes no tiene fecha de revisión — una deuda sin fecha es permanente en silencio"
    [ "$VENCE" \< "$HOY" ] && fatal "la declaración de opciones pendientes venció el $VENCE — o se configuran, o se re-declara con fecha nueva y su motivo"
    OLD_IFS="$IFS"; IFS=','
    for op in $FALTAN; do
      op=$(echo "$op" | sed 's/^ *//; s/ *$//')
      [ -z "$op" ] && continue
      jq -e --arg o "$op" '.opciones[]? | select(.opcion == $o and (.motivo // "") != "")' "$PENDIENTES_ARCH" >/dev/null 2>&1 \
        || NO_DECLARADAS="$NO_DECLARADAS $op"
    done
    IFS="$OLD_IFS"
  else
    NO_DECLARADAS=" $FALTAN"
  fi
  if [ -n "$NO_DECLARADAS" ]; then
    fatal "el host dice que faltan opciones de configuración para esta versión y NO están declaradas:$NO_DECLARADAS — es la única señal de configuración que da, y con la versión sin marcar no frena sola. Si son pendientes a sabiendas, declaralas con motivo y fecha en el archivo de opciones pendientes"
  fi
  echo "##vso[task.logissue type=warning]faltan opciones de configuración DECLARADAS como pendientes (revisar $VENCE): $FALTAN"
fi

# ── 2. preguntar ANTES de tocar la memoria ───────────────────────────────────────────────────
paso "2/5 · Vista previa: ¿el host va a dejar marcar esta versión como actual?"
PREVIA=$(api POST "/api/admin/plugins/${PLUGIN_ID}/set-default/preview" -H "Content-Type: application/json" --data '')
PREV_CODE=$(codigo "$PREVIA"); PREV_BODY=$(cuerpo "$PREVIA")
[ "$PREV_CODE" = "200" ] || fatal "la vista previa falló (HTTP $PREV_CODE): $(echo "$PREV_BODY" | head -c 300) — no toco nada, la versión anterior sigue cargada y marcada"
# 🔴 SI EL CUERPO NO SE PUDO LEER, NO ES "0 Y 0" (2026-09-03). `jq -r '.campo // 0'` sobre un cuerpo
# vacío o que no es JSON devuelve 0 sin quejarse, así que este paso —el que el guion define como EL
# freno— imprimía "pendientes 0 · retrocesos 0" sin haber leído nada: no ejecutaba migraciones y no
# revisaba retrocesos. Con migraciones o retrocesos reales, la negativa aparecía más tarde, al
# activar o al marcar, y para entonces el host ya había descargado la versión anterior.
if ! printf '%s' "$PREV_BODY" | jq -e . >/dev/null 2>&1; then
  fatal "la vista previa vino ilegible (no es JSON): $(printf '%s' "$PREV_BODY" | head -c 300). Es EL freno del despliegue: si no se pudo leer, no se sigue — no toqué nada"
fi
PENDIENTES=$(echo "$PREV_BODY" | jq -r '.pendingCount // 0')
RETROCESOS=$(echo "$PREV_BODY" | jq -r '.rollbackCount // 0')
echo "   migraciones pendientes: $PENDIENTES · retrocesos: $RETROCESOS"

# 🔴 SE MIRA CUÁLES RETROCEDE, NO CUÁNTAS (2026-09-03).
#
# Un retroceso de base de datos frena, y eso no cambia. Pero hay migraciones que el paquete deja
# afuera A PROPÓSITO: el pipeline las declara en `excludedMigrations`, cada una con su motivo escrito,
# porque volver a aplicarlas reinstalaría un parche que se quitó a mano. El host, que las tiene
# aplicadas, las lee como retroceso — así que contar retrocesos frenaba un despliegue por una decisión
# que el equipo ya había tomado y documentado.
#
# Medido en un producto del equipo el 2026-09-03: la 006 está excluida desde el 29 de agosto con su motivo (una
# columna de compatibilidad que otro sistema arregló y que, si viaja, se reinstala sola), y el host la
# devolvía como el único retroceso — guides/maintaining/incident-log.md#case-excluded-migration-as-rollback-2026-09-03. Ahora se compara POR NOMBRE contra esa misma lista: no hay un
# segundo lugar donde declarar lo mismo, y no se puede tolerar un retroceso que no se haya excluido
# deliberadamente. Cualquier retroceso que NO esté en la lista frena igual que antes.
#
# Si el host no dice CUÁLES retrocede, frena: sin los nombres no se puede comparar, y "no sé" no es
# "está declarado".
if [ "${RETROCESOS:-0}" -gt 0 ] 2>/dev/null; then
  NOMBRES=$(echo "$PREV_BODY" | jq -r '[.rollbacksNeeded[]?.migrationName // empty] | join(" ")' 2>/dev/null)
  NO_DECL=""
  if [ -z "$NOMBRES" ]; then
    fatal "el host dice que habría $RETROCESOS retroceso(s) de base de datos pero no dice cuáles — sin los nombres no puedo compararlos con las exclusiones declaradas, y \"no sé\" no es \"está declarado\". Detalle: $(echo "$PREV_BODY" | head -c 300)"
  fi
  for MN in $NOMBRES; do
    NUM=$(printf '%s' "$MN" | sed -n 's/^\([0-9]\{3\}\).*/\1/p')
    ESTA=no
    OLD_IFS="$IFS"; IFS=', '
    for EX in $EXCLUSIONES; do
      EX=$(printf '%s' "$EX" | sed 's/[^0-9]//g')
      [ -n "$EX" ] && [ "$EX" = "$NUM" ] && ESTA=si
    done
    IFS="$OLD_IFS"
    [ "$ESTA" = "no" ] && NO_DECL="$NO_DECL $MN"
  done
  if [ -n "$NO_DECL" ]; then
    fatal "esta versión NO trae migraciones que el host recuerda haber aplicado y que NO están declaradas como exclusiones:$NO_DECL — marcarla como actual sería un retroceso de base de datos. NO toqué nada: la versión anterior sigue cargada y marcada. Si la exclusión es deliberada, va en excludedMigrations con su motivo. Detalle: $(echo "$PREV_BODY" | head -c 300)"
  fi
  echo "##vso[task.logissue type=warning]el host lee como retroceso $RETROCESOS migración(es) que el paquete excluye A PROPÓSITO ($NOMBRES) — declaradas en excludedMigrations; se sigue"
  # El host exige la aprobación EXPLÍCITA del retroceso al marcar como actual. Se enciende acá y
  # sólo acá: la aprobación la genera la lista de exclusiones deliberadas, no una bandera suelta.
  RETRO_APROBADO=si
fi

# ── 3. migraciones ───────────────────────────────────────────────────────────────────────────
if [ "${PENDIENTES:-0}" -gt 0 ] 2>/dev/null; then
  paso "3/5 · Ejecutar $PENDIENTES migración(es)"
  MIG=$(api POST "/api/admin/plugins/${PLUGIN_ID}/migrations/execute" -H "Content-Type: application/json" --data '')
  MIG_CODE=$(codigo "$MIG"); MIG_BODY=$(cuerpo "$MIG")
  [ "$MIG_CODE" = "200" ] || fatal "la ejecución de migraciones falló (HTTP $MIG_CODE): $(echo "$MIG_BODY" | head -c 400)"
  # 🔴 200 NO significa que se aplicaron: el host devuelve bien con un contador de fallidas.
  FALLIDAS=$(echo "$MIG_BODY" | jq -r '.failed // 0')
  APLICADAS=$(echo "$MIG_BODY" | jq -r '.applied // 0')
  echo "   aplicadas: $APLICADAS · fallidas: $FALLIDAS"
  [ "${FALLIDAS:-0}" -eq 0 ] 2>/dev/null || fatal "$FALLIDAS migración(es) fallaron: $(echo "$MIG_BODY" | head -c 400) — no activo nada; la versión anterior sigue cargada y marcada"

  paso "3b/5 · Vista previa otra vez, ya sin pendientes"
  PREVIA2=$(api POST "/api/admin/plugins/${PLUGIN_ID}/set-default/preview" -H "Content-Type: application/json" --data '')
  [ "$(codigo "$PREVIA2")" = "200" ] || fatal "la segunda vista previa falló: $(cuerpo "$PREVIA2" | head -c 300)"
  RESTAN=$(cuerpo "$PREVIA2" | jq -r '.pendingCount // 0')
  [ "${RESTAN:-0}" -eq 0 ] 2>/dev/null || fatal "quedan $RESTAN migración(es) pendientes después de ejecutarlas — no activo nada"
else
  paso "3/5 · Sin migraciones pendientes"
fi

# ── 4. activar (esto es lo que CARGA) ────────────────────────────────────────────────────────
paso "4/5 · Activar — es la llamada que carga el plugin y descarga la anterior"
ACT=$(api POST "/api/admin/plugins/${PLUGIN_ID}/activate" -H "Content-Type: application/json" --data '')
ACT_CODE=$(codigo "$ACT"); ACT_BODY=$(cuerpo "$ACT")
if [ "$ACT_CODE" != "200" ]; then
  # 🔴 El host descarga la anterior ANTES de validar la nueva: si esto falló, no quedó NADA
  # cargado. Se vuelve a cargar la anterior, que sigue siendo la marcada como actual.
  echo "   la activación falló — el host ya había descargado la anterior; intento recuperarla"
  recuperar_anterior
  fatal "no se pudo activar la versión nueva (HTTP $ACT_CODE): $(echo "$ACT_BODY" | head -c 400)"
fi
# 🔴 Modo degradado: cargó, pero sus servicios internos no arrancaron y el host guarda el motivo
# en vez de fallar. Respuesta 200, estado "corriendo", y el plugin a medias.
SALUD=$(api GET "/api/admin/plugins/${PLUGIN_ID}/health")
SALUD_CODE=$(codigo "$SALUD")
# 🔴 MIRAR EL CÓDIGO, NO SÓLO EL CUERPO (2026-09-03). Antes se leía `errorMessage` del cuerpo sin
# mirar el código HTTP: con un 500, un HTML del proxy o un cuerpo vacío, jq no encontraba el campo,
# el motivo quedaba vacío y se imprimía "activado y sin motivo de degradación". O sea "verde que
# significa no miré nada", adentro del guion que existe para evitar exactamente eso.
# El 404 es el único caso que no frena: quiere decir que ESA versión del host no tiene el chequeo.
# Eso no es "sano", es "no se puede preguntar" — y se dice, para que quede constancia.
case "$SALUD_CODE" in
  200) : ;;
  404) echo "##vso[task.logissue type=warning]el host no expone /health para este plugin (HTTP 404) — NO se pudo verificar el modo degradado; el plugin puede estar cargado con sus servicios internos caídos" ;;
  *)   echo "   no pude leer el estado de salud — recupero la anterior antes de cortar"; recuperar_anterior
       fatal "no pude leer el estado de salud del plugin (HTTP $SALUD_CODE): $(cuerpo "$SALUD" | head -c 300). Un chequeo que no se pudo hacer NO es un chequeo aprobado" ;;
esac
if [ "$SALUD_CODE" = "200" ] && ! cuerpo "$SALUD" | jq -e . >/dev/null 2>&1; then
  echo "   el estado de salud vino ilegible — recupero la anterior antes de cortar"; recuperar_anterior
  fatal "el estado de salud del plugin vino ilegible (no es JSON): $(cuerpo "$SALUD" | head -c 300)"
fi
MOTIVO=$(cuerpo "$SALUD" | jq -r '.errorMessage // .reason // empty' 2>/dev/null)
if [ -n "$MOTIVO" ]; then
  echo "   cargó degradado — recupero la anterior antes de cortar"; recuperar_anterior
  fatal "el plugin cargó en MODO DEGRADADO: $MOTIVO — responde, pero sus servicios internos no arrancaron"
fi
echo "   activado y sin motivo de degradación"

# ── 5. marcar como actual (lo que sobrevive al reinicio) ─────────────────────────────────────
paso "5/5 · Marcar como actual — sin esto, el próximo reinicio del host no carga ninguna versión"
# 🔴 LA APROBACIÓN DEL RETROCESO VIAJA ACÁ, Y SÓLO SI TODO RETROCESO ESTABA DECLARADO (2026-09-03).
# El host se niega a marcar como actual una versión que retrocede migraciones, salvo que se le
# mande `rollbackApproved` habiendo consultado antes la vista previa —que es exactamente lo que
# hace este guion en el paso 2—. La aprobación NO es una bandera de conveniencia: se enciende
# únicamente cuando cada migración que el host lee como retroceso figura en la lista de
# exclusiones deliberadas del pipeline, con su motivo escrito. Un retroceso no declarado ya
# frenó mucho antes, en el paso 2, sin tocar nada.
if [ "$RETRO_APROBADO" = "si" ]; then
  echo "   con aprobación del retroceso: cada migración que el host retrocede está declarada como exclusión"
  CUERPO_SET='{"rollbackApproved": true}'
else
  CUERPO_SET='{}'
fi
SET=$(api POST "/api/admin/plugins/${PLUGIN_ID}/set-default" -H "Content-Type: application/json" --data "$CUERPO_SET")
SET_CODE=$(codigo "$SET")
if [ "$SET_CODE" != "200" ]; then
  echo "   marcar como actual se negó — recupero la anterior para no dejar la nueva cargada y sin marca"
  recuperar_anterior
  fatal "no se pudo marcar como actual (HTTP $SET_CODE): $(cuerpo "$SET" | head -c 400)"
fi

echo ""
echo "✅ desplegado: subido, migrado, activado y marcado como actual (identificador $PLUGIN_ID)"
echo "   El humo verifica aparte que lo CARGADO y lo MARCADO sean esta misma versión."
exit 0
