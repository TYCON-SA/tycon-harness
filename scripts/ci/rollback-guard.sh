#!/usr/bin/env bash
# =============================================================================
# rollback-guard.sh — ¿el paquete que estoy por promover es MENOR que el instalado?
# =============================================================================
# 🔴 POR QUÉ EXISTE (2026-09-02, revisión adversarial de los pipelines, hallazgo 🟠 #9).
#
# Encolar a mano el pipeline de producción eligiendo un run de CI VIEJO promueve ESE paquete.
# Los backends lo suben con `setAsDefault=true` y el humo compara contra la versión del ZIP —no
# contra la que estaba—, así que el retroceso termina en VERDE. Los formularios de Totora lo
# saltean como "al día" y después el humo falla en rojo sin haber hecho nada; los de FRESNO lo suben
# igual. Cuatro pipelines, tres conductas ante el mismo caso, y la única "exitosa" es el retroceso
# silencioso. Etapa 4 del flujo objetivo: "instala el MISMO paquete" — el que la etapa 3 probó,
# no uno anterior.
#
# Corre ANTES de subir nada: pregunta al host qué versión está instalada y se NIEGA si la del
# paquete es menor. Igual o mayor pasa (igual = el despliegue lo va a saltear o deduplicar).
# No existe un "forzar retroceso": no se verificó con el host que subir una versión menor la deje
# como actual, y prometer un forzado que quizá no funciona es peor que no tenerlo. Retroceder es
# una acción de una persona desde el panel del host, con las manos.
#
# Uso:  rollback-guard.sh plugin <url> <usuario> <clave> <nombre-del-plugin> <versión-del-paquete>
#       rollback-guard.sh forms  <url> <usuario> <clave> <dir-con-zips>
#         (forms: la versión de cada paquete sale del manifest.json de su ZIP, como en el humo)
#
# Exit: 0 = ningún paquete es menor que lo instalado (o no hay nada instalado): puede subir.
#       2 = RETROCESO: al menos un paquete es MENOR que el instalado. Se niega, con el detalle.
#       1 = no pude mirar (login caído, respuesta ilegible, manifest roto, directorio vacío).
#       🔴 Fail-closed: un freno que no pudo mirar NO deja pasar. Este paso NO va con
#       continueOnError: si sale ≠ 0, el despliegue a producción no se hace.
# =============================================================================
set -uo pipefail
MODO="${1:?modo: plugin | forms}"; shift
URL="${1:?url}"; USUARIO="${2:?usuario}"; CLAVE="${3:?clave}"; shift 3

login() {
  local headers respuesta body code token intento
  headers=$(mktemp); respuesta=$(mktemp)
  body=$(jq -nc --arg u "$USUARIO" --arg p "$CLAVE" '{username:$u, password:$p, tenant_id:"default"}')
  for intento in 1 2 3 4; do
    code=$(curl -s -D "$headers" -o "$respuesta" -w '%{http_code}' --max-time 25 \
      "${URL}/api/auth/login" -H 'Content-Type: application/json' --data-raw "$body" 2>/dev/null) || code="000"
    [ "$code" = "200" ] && break
    # El host devuelve su límite de ingresos como 401 {"error":"Too Many Requests"}, no como 429
    # (medido 2026-09-01). Transitorio: se reintenta con espera larga. Un 401 sin ese texto es
    # clave mal y no se reintenta.
    if [ "$code" = "401" ] && grep -qi "too many requests" "$respuesta" 2>/dev/null; then code="429"; fi
    case "$code" in 000|429|5??) [ "$intento" -lt 4 ] && { echo "[retroceso] login HTTP $code (intento $intento) — reintento en $((intento*15))s" >&2; sleep $((intento*15)); } ;; *) break ;; esac
  done
  if [ "$code" != "200" ]; then echo "[retroceso] no se pudo entrar al host (HTTP $code, $intento intento/s): $(head -c 160 "$respuesta" 2>/dev/null | tr -d '\n')" >&2; rm -f "$headers" "$respuesta"; return 1; fi
  token=$(grep -i 'set-cookie:.*admin_token=' "$headers" | sed 's/.*admin_token=\([^;]*\).*/\1/' | head -1)
  [ -z "$token" ] && token=$(jq -r '.token // .accessToken // empty' "$respuesta" 2>/dev/null)
  rm -f "$headers" "$respuesta"
  [ -z "$token" ] && { echo "[retroceso] el login no devolvió token" >&2; return 1; }
  printf '%s' "$token"
}

# ¿$1 es MENOR que $2? (versiones X.Y.Z; sort -V)
es_menor() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }
valida_version() { printf '%s' "$1" | grep -E '^[0-9]+(\.[0-9]+)+$' >/dev/null; }

case "$MODO" in
  plugin)
    PLUGIN="${1:?nombre del plugin}"; PAQUETE="${2:?versión del paquete}"
    valida_version "$PAQUETE" || { echo "[retroceso] la versión del paquete no tiene forma de versión: '$PAQUETE'" >&2; exit 1; }
    TOKEN=$(login) || exit 1
    LISTA=$(curl -s --max-time 25 "${URL}/api/admin/plugins" -H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" -H 'X-Tenant-Id: default' 2>/dev/null) || LISTA=""
    # La versión INSTALADA = la marcada como default para ese nombre (como smoke-plugin.sh).
# 🔴 LA MISMA LECTURA QUE EL HUMO Y EL DESPLIEGUE (2026-09-03). Este freno leía la lista de
# plugins con un criterio MÁS ANGOSTO que sus dos hermanos, que leen la MISMA respuesta del
# MISMO host: ante una respuesta envuelta en `.value` no encontraba el plugin, concluía "no
# está instalado" y APROBABA — diciendo lo contrario de lo que pasaba. Tres guiones del mismo
# circuito DISCREPABAN SOBRE EL MISMO HOST, que es el modo más silencioso de fallar: el que
# frena retrocesos es justo el que no puede equivocarse hacia "pasá".
    INSTALADA=$(printf '%s' "$LISTA" | jq -r --arg n "$PLUGIN" '
      (if type=="array" then . else (.plugins // .data // .items // .value // []) end)
      | map(select((.name // "" | ascii_downcase) == ($n | ascii_downcase)))
      | (map(select(.isDefault == true)) | .[0]) // .[0]
      | if . == null then "AUSENTE" else (.version // "ILEGIBLE") end' 2>/dev/null) || INSTALADA="ILEGIBLE"
    [ -z "$INSTALADA" ] && INSTALADA="ILEGIBLE"
    if [ "$INSTALADA" = "ILEGIBLE" ]; then echo "[retroceso] no pude leer qué versión de $PLUGIN está instalada (respuesta ilegible) — no dejo pasar sin mirar" >&2; exit 1; fi
    if [ "$INSTALADA" = "AUSENTE" ]; then echo "[retroceso] $PLUGIN no está instalado en el host: v$PAQUETE es la primera, puede subir"; exit 0; fi
    valida_version "$INSTALADA" || { echo "[retroceso] la versión instalada de $PLUGIN no tiene forma de versión: '$INSTALADA' — no dejo pasar sin entender" >&2; exit 1; }
    if es_menor "$PAQUETE" "$INSTALADA"; then
      echo "##vso[task.logissue type=error][retroceso] ME NIEGO: $PLUGIN v$PAQUETE es MENOR que la instalada v$INSTALADA. Este run promueve un paquete viejo (¿se encoló a mano eligiendo un run de CI anterior?). Retroceder es una acción de una persona desde el panel del host."
      exit 2
    fi
    echo "[retroceso] ✅ $PLUGIN v$PAQUETE ≥ instalada v$INSTALADA: puede subir"; exit 0 ;;

  forms)
    DIR="${1:?directorio con los zips}"
    [ -d "$DIR" ] || { echo "[retroceso] no existe $DIR" >&2; exit 1; }
    command -v unzip >/dev/null || { echo "[retroceso] falta unzip" >&2; exit 1; }
    ESPERADOS=""
    for ZIP in "$DIR"/*.zip; do
      [ -f "$ZIP" ] || continue
      M=$(unzip -p "$ZIP" manifest.json 2>/dev/null) || M=""
      PAR=$(printf '%s' "$M" | jq -r '.forms[0] | select(.formName != null and .version != null) | "\(.formName)=\(.version)"' 2>/dev/null)
      if [ -z "$PAR" ]; then echo "[retroceso] $(basename "$ZIP"): manifest ilegible o sin formName/version — no puedo saber qué versión trae" >&2; exit 1; fi
      ESPERADOS="$ESPERADOS $PAR"
    done
    [ -z "$ESPERADOS" ] && { echo "[retroceso] no hay ZIPs en $DIR — nada que promover NO es verde" >&2; exit 1; }
    TOKEN=$(login) || exit 1
    LISTA=$(curl -s --max-time 25 "${URL}/api/custom-forms" -H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" -H 'X-Tenant-Id: default' 2>/dev/null) || LISTA=""
    printf '%s' "$LISTA" | jq -e 'type=="array" or (type=="object" and ((.forms // .data // .items) != null))' >/dev/null 2>&1 \
      || { echo "[retroceso] no pude leer la lista de formularios del host (respuesta ilegible) — no dejo pasar sin mirar" >&2; exit 1; }
    RETROCESOS=0
    for PAR in $ESPERADOS; do
      F="${PAR%%=*}"; V="${PAR#*=}"
      valida_version "$V" || { echo "[retroceso] $F: la versión del paquete no tiene forma de versión: '$V'" >&2; exit 1; }
      INSTALADA=$(printf '%s' "$LISTA" | jq -r --arg f "$F" '
        (if type=="array" then . else (.forms // .data // .items // []) end)
        | map(select((.formName // .name // "") == $f)) | .[0] | (.currentVersion // .CurrentVersion // "AUSENTE")' 2>/dev/null)
      [ -z "$INSTALADA" ] && INSTALADA="AUSENTE"
      if [ "$INSTALADA" = "AUSENTE" ] || [ "$INSTALADA" = "null" ]; then echo "[retroceso] $F: no está instalado, v$V es la primera"; continue; fi
      valida_version "$INSTALADA" || { echo "[retroceso] $F: la versión instalada no tiene forma de versión: '$INSTALADA' — no dejo pasar sin entender" >&2; exit 1; }
      if es_menor "$V" "$INSTALADA"; then
        echo "##vso[task.logissue type=error][retroceso] $F: el paquete trae v$V y en producción está v$INSTALADA — es un RETROCESO"
        RETROCESOS=$((RETROCESOS+1))
      else
        echo "[retroceso] ✅ $F v$V ≥ instalada v$INSTALADA"
      fi
    done
    if [ "$RETROCESOS" -gt 0 ]; then
      echo "##vso[task.logissue type=error][retroceso] ME NIEGO: $RETROCESOS formulario(s) del paquete son MENORES que lo instalado. Este run promueve paquetes viejos (¿se encoló a mano eligiendo un run de CI anterior?). Retroceder es una acción de una persona desde el panel del host."
      exit 2
    fi
    echo "[retroceso] ✅ ningún formulario retrocede: puede subir"; exit 0 ;;
  *) echo "[retroceso] modo desconocido: $MODO (plugin | forms)" >&2; exit 1 ;;
esac
