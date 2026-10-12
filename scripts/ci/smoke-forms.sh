#!/usr/bin/env bash
# =============================================================================
# smoke-forms.sh — ¿los formularios que acabo de instalar están vivos y son la versión que dije?
# =============================================================================
# Es la ÚNICA prueba del circuito que toca el paquete INSTALADO. Por cada ZIP del directorio
# (uno por formulario, con su manifest.json) pregunta al host si ese formulario está en la
# versión del manifest y si su código se sirve (200 y tamaño > 0).
# Etapas 3 (staging) y 4 (producción) del flujo objetivo: artifacts/camino-del-paquete.html.
#
# Uso: smoke-forms.sh <url> <usuario> <clave> <dir-con-zips>
#
# Exit: 0 sólo si TODOS los formularios del directorio están en su versión y sirven código.
#       1 en cualquier otro caso — incluido "no pude entrar" o "no pude leer un manifest".
#       🔴 Fail-closed a propósito: un humo que no pudo mirar NO está aprobado.
#
# La versión esperada sale del manifest de cada ZIP, no del repo: el deploy sube sólo los
# formularios cuya versión es nueva; los demás tienen que seguir en la suya — que es la misma.
# Reintenta la comprobación 3 veces cada 10 s. Login con reintento como release-notes.sh.
# =============================================================================
set -uo pipefail
URL="${1:?url}"; USUARIO="${2:?usuario}"; CLAVE="${3:?clave}"; DIR="${4:?directorio con los zips}"
[ -d "$DIR" ] || { echo "[humo] no existe $DIR" >&2; exit 1; }
command -v unzip >/dev/null || { echo "[humo] falta unzip" >&2; exit 1; }

# >>> nombre-seguro — SEC-C1. Este bloque es byte a byte el mismo en smoke-plugin.sh y smoke-forms.sh (lo verifica smoke.test.sh)
# 🔴 UN NOMBRE NO SE METE CRUDO EN UNA CONSULTA AL HOST NI EN UN MENSAJE (2026-09-17). El nombre del
# plugin sale del plugin.json del ZIP y el de cada formulario del manifest.json del ZIP: es texto del
# PAQUETE. Iba tal cual a la URL (`../` cambia la ruta, `?` le agrega parámetros) y a cada línea de
# salida, donde Azure interpreta `##vso[` esté donde esté. Desde el 03-09 y hasta hoy el humo aprobaba
# igual. Un nombre que no pasa NO se consulta: el humo sale rojo y lo dice — no verificar nunca es verde.
# El juego acepta los 9 plugins y los 65 formularios publicados (tasks/medicion-nombres-humo-2026-09-17.md).
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
# 🔴 LO DEMÁS QUE TRAE EL PAQUETE TAMBIÉN SE VALIDA, Y LO QUE DICE EL HOST SE MUESTRA SANEADO (segunda parte,
# mismo día). La versión y el identificador de compilación salen del mismo plugin.json / manifest.json que el
# nombre e iban a las mismas líneas de salida. Las 74 versiones publicadas hoy son N.N.N; la forma admitida es
# la que ya exige el registro de despliegues (story 2.10, AC 7), así un humo verde nunca deja una versión que
# el registro después rechaza.
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

# 🔴 EL REGISTRO DE DESPLIEGUES (story 2.10). Un humo aprobado, dentro de una corrida de Azure, anota
# SÓLO los formularios que esta corrida subió — no todos los que verificó: el directorio trae el ZIP de
# cada formulario y la mayoría ya estaba. Quién se subió lo dice el host: la versión actual de cada
# formulario guarda el commit con el que se subió, y se compara con el del manifest de este ZIP. Si no
# se puede saber, no se anota y se avisa. Anotar nunca cambia el veredicto.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRO_OK=no
if [ -f "$AQUI/deploy-record.sh" ] && . "$AQUI/deploy-record.sh"; then REGISTRO_OK=si; fi
registrar_formularios() {
  if [ "$REGISTRO_OK" != si ]; then
    [ "${TF_BUILD:-}" = "True" ] && echo "##vso[task.logissue type=warning]registro-despliegue: no está deploy-record.sh al lado del humo (¿el artefacto arnes-ci llegó incompleto?) — esta corrida queda SIN registro de despliegue"
    return 0
  fi
  registro_activo || return 0
  local i=0 f v ch fu resp code body host a b n=0 ya=0 sc=0 na=0 puede=si
  # sin jq o sin herramienta de huella no se puede anotar ninguno: se dice UNA vez y se cuentan
  registro_puede_anotar || puede=no
  while [ "$i" -lt "${#NOMBRES[@]}" ]; do
    f="${NOMBRES[$i]}"; v="${VERSIONES[$i]}"; ch="${COMMITS[$i]}"; fu="${EN_URL[$i]}"; i=$((i+1))
    [ -n "$ch" ] || { sc=$((sc+1)); continue; }
    # el nombre viene del paquete: ya se validó al leer el manifest (un nombre fuera de su juego tumba el
    # humo antes de llegar acá). Se vuelve a mirar igual: a esta URL no entra nada que no sea del juego.
    nombre_seguro "$f" && [ -n "$fu" ] || { sc=$((sc+1)); continue; }
    resp=$(curl -s -w '\n%{http_code}' --max-time 25 "${URL}/api/custom-forms/${fu}/versions" "${A[@]}" 2>/dev/null) || resp=$'\n000'
    code=$(printf '%s' "$resp" | tail -1); body=$(printf '%s' "$resp" | sed '$d')
    if [ "$code" != "200" ] || ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then sc=$((sc+1)); continue; fi
    host=$(printf '%s' "$body" | jq -r --arg v "$v" '
      (if type=="array" then . else (.versions // .data // .items // .value // []) end)
      | map(select(((.isCurrent // .IsCurrent) == true) and ((.version // .Version) == $v)))
      | .[0] | (.commitHash // .CommitHash // "")' 2>/dev/null)
    es_commit "$host" || { sc=$((sc+1)); continue; }
    a=$(printf '%s' "$ch" | tr 'A-F' 'a-f'); b=$(printf '%s' "$host" | tr 'A-F' 'a-f')
    if [ "${a:0:${#b}}" = "$b" ] || [ "${b:0:${#a}}" = "$a" ]; then
      # publicado por esta corrida (versión nueva o la misma otra vez: el host no los distingue)
      if [ "$puede" = si ] && registro_despliegue desplegado formulario "$f" "$v" "$ch"; then n=$((n+1)); else na=$((na+1)); fi
    else
      ya=$((ya+1))
    fi
  done
  echo "[registro] $n desplegado(s) en esta corrida · $ya ya estaban · $sc sin constancia · $na sin anotar" >&2
  [ "$puede" = no ] && [ "$na" -gt 0 ] && registro_aviso "falta jq o una herramienta de huella (sha256sum/shasum): $na formulario(s) publicados por esta corrida quedan SIN registro de despliegue"
  [ "$sc" -gt 0 ] && registro_aviso "$sc formulario(s) sin constancia de con qué commit los subió el host — esta corrida queda SIN registro de despliegue para ellos"
  return 0
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
    # como 429 (medido: formularios de un producto en main, 2026-09-01 — guides/incident-log.md#case-smoke-login-rate-limited-2026-09-01; el humo era el 6º login del mismo job y el
    # host lo cortó). Ese 401 es transitorio y se reintenta con espera larga; un 401 sin ese
    # texto es clave mal y no se reintenta.
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

# ── qué espero: nombre y versión de cada ZIP (del manifest, que es lo que el host leyó)
# 🔴 LISTAS POR ÍNDICE, NO TEXTO SEPARADO POR ESPACIOS (SEC-C1, 2026-09-17). Esto era una cadena
# "nombre=versión nombre=versión…" recorrida sin comillas: un espacio en un nombre la partía en dos, un
# comodín se expandía contra los archivos de la carpeta y un '=' corría el corte entre nombre y versión.
NOMBRES=(); VERSIONES=(); PESOS=(); COMMITS=(); EN_URL=()
for ZIP in "$DIR"/*.zip; do
  [ -f "$ZIP" ] || continue
  M=$(unzip -p "$ZIP" manifest.json 2>/dev/null) || M=""
  FN=$(printf '%s' "$M" | jq -r '.forms[0] | select(.formName != null and .version != null) | .formName' 2>/dev/null)
  FV=$(printf '%s' "$M" | jq -r '.forms[0] | select(.formName != null and .version != null) | .version' 2>/dev/null)
  if [ -z "$FN" ] || [ -z "$FV" ]; then echo "[humo] $(nombre_visible "$(basename "$ZIP")"): manifest ilegible o sin formName/version — no puedo saber qué esperar" >&2; exit 1; fi
  if ! nombre_seguro "$FN"; then
    echo "##vso[task.logissue type=error][humo] $(nombre_visible "$(basename "$ZIP")"): el nombre del formulario en su manifest no es válido («$(nombre_visible "$FN")», mostrado sin sus caracteres raros): un nombre $REGLA_NOMBRE. NO se consultó al host — un formulario que no se pudo consultar NO está verificado, y con uno sin verificar no se aprueba ninguno"
    exit 1
  fi
  if ! version_segura "$FV"; then
    echo "##vso[task.logissue type=error][humo] $FN: la versión de su manifest no es válida («$(nombre_visible "$FV")», mostrada sin sus caracteres raros): una versión $REGLA_VERSION. NO se consultó al host — un formulario que no se pudo consultar NO está verificado, y con uno sin verificar no se aprueba ninguno"
    exit 1
  fi
  FU=$(en_url "$FN") || FU=""
  [ -n "$FU" ] || { echo "##vso[task.logissue type=error][humo] no pude codificar el nombre de $FN para la consulta (¿falta jq?) — NO se consultó al host, así que no está verificado"; exit 1; }
  # 🔴 CUÁNTO DEBERÍA PESAR (2026-09-03). Ver el comentario de abajo, en la comprobación. "" = no lo declara.
  TAM=$(printf '%s' "$M" | jq -r '.forms[0].sizeBytes // empty' 2>/dev/null)
  # 🔴 EL PESO ENTRA A UNA CUENTA `$(( ))`, Y AHÍ BASH EJECUTA LO QUE VENGA ADENTRO (medido 2026-09-17, en bash
  # 3.2 y 5.2): con `SIZE[$(orden)]` como peso, la orden corría en el agente; con una variable que no existe,
  # `set -u` cortaba el guion — y en bash 3.2 salía 0, un verde sin haber verificado nada. Un peso declarado
  # es un número o el manifest no se puede leer. (No declararlo sigue valiendo: no frena por peso.)
  if [ -n "$TAM" ]; then
    if ! es_numero "$TAM"; then
      echo "##vso[task.logissue type=error][humo] $FN v$FV: el peso que declara su manifest no es un número («$(nombre_visible "$TAM")») — no puedo saber qué esperar. NO se consultó al host, así que no está verificado"
      exit 1
    fi
    TAM=$((10#$TAM))   # en base 10 siempre: un "010" no es octal, y se compara contra lo que cuenta curl
  fi
  # story 2.10: el commit con el que se construyó este ZIP (sólo si tiene forma de commit). "" = sin constancia.
  CH=$(printf '%s' "$M" | jq -r '.commitHash // empty' 2>/dev/null)
  es_commit "$CH" || CH=""
  NOMBRES+=("$FN"); VERSIONES+=("$FV"); PESOS+=("$TAM"); COMMITS+=("$CH"); EN_URL+=("$FU")
done
[ "${#NOMBRES[@]}" -eq 0 ] && { echo "[humo] no hay ZIPs en $DIR — nada que verificar NO es verde" >&2; exit 1; }

TOKEN=$(login) || exit 1
A=(-H "Authorization: Bearer $TOKEN" -H "Cookie: admin_token=$TOKEN" -H 'X-Tenant-Id: default')

for intento in 1 2 3; do
  LISTA=$(curl -s --max-time 25 "${URL}/api/custom-forms" "${A[@]}" 2>/dev/null) || LISTA=""
  FALLAS=0; k=0
  while [ "$k" -lt "${#NOMBRES[@]}" ]; do
    F="${NOMBRES[$k]}"; V="${VERSIONES[$k]}"; ESP_TAM="${PESOS[$k]}"; FU="${EN_URL[$k]}"; k=$((k+1))
    ACTUAL=$(printf '%s' "$LISTA" | jq -r --arg f "$F" '
      (if type=="array" then . else (.forms // .data // .items // []) end)
      | map(select((.formName // .name // "") == $f)) | .[0] | (.currentVersion // .CurrentVersion // "AUSENTE")' 2>/dev/null)
    [ -z "$ACTUAL" ] && ACTUAL="ILEGIBLE"
    if [ "$ACTUAL" != "$V" ]; then echo "[humo] intento $intento: $F está en '$(nombre_visible "$ACTUAL")', esperaba '$V'" >&2; FALLAS=$((FALLAS+1)); continue; fi
    # y el código se sirve: 200 con cuerpo
    BYTES=$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 40 "${URL}/api/custom-forms/${FU}/code" "${A[@]}" 2>/dev/null) || BYTES="000 0"
    HTTP="${BYTES%% *}"; SIZE="${BYTES##* }"
    # 🔴 Lo que cuenta `curl` también entra a la cuenta de más abajo. `curl -w` siempre da un número, pero si
    # un día no lo diera, la resta moría —en bash 3.2 saliendo 0 y sin imprimir nada— y sin peso declarado se
    # aprobaba «abc bytes». Un tamaño que no es un número es «no pude mirar»: falla, y lo dice.
    if ! es_numero "$SIZE"; then echo "[humo] intento $intento: $F v$V — no pude leer cuántos bytes sirve el host: lo que contó curl no es un número («$(nombre_visible "$SIZE")», HTTP $(nombre_visible "$HTTP"))" >&2; FALLAS=$((FALLAS+1)); continue; fi
    if [ "$HTTP" != "200" ] || [ "${SIZE:-0}" -le 0 ]; then echo "[humo] intento $intento: $F v$V — el código no se sirve (HTTP $HTTP, $SIZE bytes)" >&2; FALLAS=$((FALLAS+1)); continue; fi
    # 🔴 ¿SIRVE LO QUE ESTA CORRIDA CONSTRUYÓ? (2026-09-03, todavía AVISANDO, no frenando)
    #
    # Este humo compara VERSIÓN contra VERSIÓN, así que toda la familia de fallos de versionado lo
    # pasa POR CONSTRUCCIÓN: si el número no subió, el host ya tiene "esa versión" —porque nunca se
    # le subió nada— y sirve el código VIEJO. O sea que el control que debería atrapar el fallo más
    # caro del circuito es, por diseño, ciego a él.
    #
    # 🔴 EL PESO SERVIDO TIENE QUE SER EL DEL PAQUETE DE ESTA CORRIDA (2026-09-03).
    #
    # Comparar versión contra versión deja pasar toda la familia de fallos de versionado POR
    # CONSTRUCCIÓN: si el número no subió, el host ya tiene "esa versión" —porque nunca se le subió
    # nada— y sirve el código VIEJO. El peso es la señal más barata de "es otro código".
    #
    # Entró AVISANDO el mismo día, porque no estaba medido si el host sirve el archivo tal cual o lo
    # envuelve, y una diferencia constante habría puesto en rojo a los cinco productos el primer día.
    # Se midió: en 48 formularios de los CINCO productos (Totora 9807, URUTAU 9808, Lapacho 9819,
    # Ceibo 9820, FRESNO 9793) el host sirve EXACTAMENTE los bytes que declara el paquete. Diferencia
    # cero, ni siquiera constante: nula. Con esa evidencia el aviso pasa a FRENAR.
    #
    # Límite que queda declarado: un cambio que no altere el tamaño del archivo pasaría igual. Cerrar
    # eso pide identidad de contenido —el commitHash de la corrida adentro del propio form.js—, que
    # es trabajo del empaquetado, no de este humo.
    #
    # Y un paquete que NO declara peso no frena por peso: no hay con qué comparar, y se sigue
    # verificando la versión como antes.
    if [ -n "$ESP_TAM" ] && [ "$ESP_TAM" != "$SIZE" ]; then
      D=$(( 10#$SIZE > 10#$ESP_TAM ? 10#$SIZE - 10#$ESP_TAM : 10#$ESP_TAM - 10#$SIZE ))   # los dos ya son números (es_numero)
      echo "[humo] 🔴 $F v$V: el host sirve $SIZE bytes y el paquete de esta corrida declara $ESP_TAM (difieren en $D) — el código servido NO es el que se acaba de instalar" >&2
      FALLAS=$((FALLAS+1)); continue
    fi
    echo "[humo] ✅ $F v$V: en su versión y sirviendo código ($SIZE bytes${ESP_TAM:+, el paquete declara $ESP_TAM})"
  done
  if [ "$FALLAS" -eq 0 ]; then registrar_formularios; exit 0; fi
  [ "$intento" -lt 3 ] && sleep 10
done
echo "##vso[task.logissue type=error][humo] $FALLAS formulario(s) NO quedaron como este run dijo — el paquete instalado no es el esperado"
exit 1
