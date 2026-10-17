#!/usr/bin/env bash
# =============================================================================
# release-notes.sh — Notas de versión del plugin, para el "Historial de Versiones"
# =============================================================================
# El texto que imprime este script termina publicado tal cual en la pantalla que ve el
# ADMINISTRADOR del sistema. No es un changelog para el equipo: es para quien instala.
#
# El problema que resuelve (visto en producción el 2026-08-05): las notas salían de
# `git log -1 --pretty=%B`, o sea el mensaje COMPLETO del último commit. Eso publicaba el
# detalle interno de desarrollo, y —peor— si una versión se generaba y no se publicaba, sus
# cambios no figuraban en ningún lado: se pasaba de la v67 a la v69 y lo que entró en la 68
# desaparecía.
#
# La regla: la nota contesta "¿QUÉ CAMBIA respecto de lo que tenés instalado?". Esa pregunta
# sólo se puede contestar bien EN EL MOMENTO DE PUBLICAR, porque entre que se arma el paquete
# y que se sube, el servidor pudo haber cambiado. Por eso hay dos modos:
#
#   --from-server <url> <usuario> <clave>
#       Le pregunta al servidor qué versión está corriendo y desde qué commit se generó, y
#       lista los cambios desde ahí. Es el modo REAL, el que se usa al desplegar. Se consulta
#       al servidor y no a un archivo del repo porque una versión se puede publicar a mano
#       (subiendo el ZIP o desde el dashboard) y en esos casos el repo nunca se entera.
#
#   --local
#       Sin servidor: lista los cambios desde el build anterior. Es la nota que viaja dentro
#       del ZIP como respaldo, para cuando alguien lo sube a mano y nadie puede recalcular.
#
# 🔴 ÉSTE ES EL CANÓNICO (2026-08-31). Vive SOLO acá.
#
# Hasta hoy estaba COPIADO en 8 repos (backend y formularios de cuatro productos del
# equipo). Nada las mantenía iguales: el 2026-08-31 hubo que editar las ocho a mano DOS veces
# en el mismo día — guides/maintaining/incident-log.md#case-release-notes-eight-copies-2026-08-31; y en el camino se descubrió que uno de ellos —el piloto del flujo con Pull Request,
# con un día de uso— era el ÚNICO sin filtrar `^Merged PR`: su próxima versión iba a publicarle
# "Merged PR <id>: …" al administrador que instala el plugin. Su filtro se había escrito ANTES de
# que existiera el flujo y nadie volvió a mirarlo cuando el flujo cambió.
#
# Se midió antes de unificar: las 8 copias tenían 78 líneas de código EXACTAS y diferían entre 0 y
# 4 líneas dentro de cada variante. La única diferencia real entre "plugin" y "formulario" son 6
# líneas —a qué dirección del host le pregunta qué versión está publicada— y eso lo resuelve una
# BANDERA, no un archivo aparte.
#
# Uso:
#   release-notes.sh [--type plugin|form] --local <nombre> [paths...]
#   release-notes.sh [--type plugin|form] --from-server <url> <usuario> <clave> <nombre> [paths...]
#
#   --type plugin      (default) pregunta por /api/admin/plugins — backends de plugin Bizuit
#   --type form        pregunta por /api/custom-forms/<nombre>/versions — formularios
#                      (`formulario`, el valor viejo, sigue andando hasta el retiro — story 8.9, tanda B3a)
#
# Exit: siempre 0. Nunca puede romper un build por un texto informativo — si algo falla,
# imprime la mejor nota que pueda y avisa por stderr.
# =============================================================================
set -uo pipefail

# Las opciones renombradas a inglés (story 8.9, tanda B2; el valor `formulario` de --type, tanda B3a): los pipelines de los productos siguen pasando las viejas hasta
# el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci). La vieja y la nueva juntas salen 0 sin nota,
# como un --type inválido: una nota de versión nunca frena un despliegue.
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  LEGACY_OPTIONS_PREFIX='[release-notes] ' legacy_options 'tipo:type desde-servidor:from-server type=formulario:form' "$@" \
    || { echo "[release-notes] sin nota: la misma opción llegó dos veces" >&2; exit 0; }
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi

# --type va PRIMERO y es opcional: sin él, `plugin`. Así las invocaciones que ya existen en los
# pipelines de backend siguen andando sin tocarlas.
TIPO="plugin"
if [ "${1:-}" = "--type" ]; then
  TIPO="${2:?falta el valor de --type (plugin|form)}"; shift 2
fi
case "$TIPO" in
  plugin|form) ;;
  *) echo "[release-notes] --type inválido: '$TIPO' (esperaba plugin|form)" >&2; exit 0 ;;
esac

MODO="${1:?uso: release-notes.sh [--type plugin|form] --local|--from-server ...}"
shift

URL=""; USUARIO=""; CLAVE=""
if [ "$MODO" = "--from-server" ]; then
  URL="${1:-}"; USUARIO="${2:-}"; CLAVE="${3:-}"; shift 3 || true
fi

NOMBRE="${1:?falta el nombre del plugin o del formulario}"; shift
PATHS=("$@")
[ ${#PATHS[@]} -eq 0 ] && PATHS=(".")

MAX_LINEAS=50

# Ruido que no le dice nada a nadie: los commits que el propio CI genera, y los que tocan
# un archivo sólo para disparar el pipeline.
# 2026-08-31 (flujo PR): `^Merged PR` es NUEVO y necesario — con el merge por Pull Request, el
# commit que llega a main se llama "Merged PR N: …", y sin filtrarlo la primera versión posterior
# publicaría ESE texto al administrador en vez de los cambios reales.
# 🔴 2026-08-31: se suman los commits de CI. Un cambio del pipeline NO le dice nada a quien
# instala el plugin, y la nota de versión la lee alguien de afuera del equipo. `^ci:` y
# `^<tipo>(ci):` cubren `ci: …`, `fix(ci): …`, `feat(ci): …` — antes sólo estaba `chore(ci)`, así
# que un `fix(ci)` se publicaba como si fuera un cambio del producto.
# `^chore: update versions` viene de la variante de formularios: es el mensaje que escribía su
# bot. Estar de más es inofensivo (nadie escribe un cambio de producto así), y tenerlo en los dos
# es lo que permite que sea UN archivo.
# 🔴 2026-09-15 (story 2.17): `^Merged PR` era UNO de los formatos con que un merge llega a main, y el
# camino de RESPALDO publicaba los otros tal cual al administrador. Censo de los asuntos reales de
# merge en `main` de seis productos: «Merge pull request N from X into Y» (el que escribe Azure al
# completar solo), «Merged PR N: …», «Merge PR #N into main», «Merge PR N into main», «Merge PR: …»
# (sin número) y «Merge branch 'dev' into main» (66 en Totora). La primera versión de este filtro
# exigía dos puntos después del número y dejaba pasar la mitad — lo cazó el pase adversarial
# reproduciéndolo con los repos reales. Ahora se filtra la CLASE: cualquier asunto que EMPIECE con una
# de esas fórmulas. Un cambio real que hable de un merge («fix: el merge de listas perdía el último»)
# no empieza así, y por eso no se pierde. Queda afuera a propósito «merge: dev -> main — <resumen>»,
# el asunto que escribe el skill al pushear: ése SÍ describe el cambio.
RUIDO='^chore: bump version|^chore\(ci\)|^chore: trigger|^Merged PR|^Merge pull request |^Merge PR[ :#]|^Merge branch |^chore: update versions|\[skip ci\]|^ci[:(]|^[a-z]+\(ci\)'

# ---------------------------------------------------------------- versión publicada
hash_publicado() {
  [ -z "$URL" ] || [ -z "$USUARIO" ] || [ -z "$CLAVE" ] && return 0
  local headers body code token

  # 🔴 INGRESO REUTILIZADO (2026-09-01, medido en un producto del equipo — guides/maintaining/incident-log.md#case-release-notes-against-published-2026-09-01). Este guion se invoca UNA VEZ POR
  # FORMULARIO, y hasta hoy cada invocación abría su propio ingreso al host. Con 4 formularios
  # (Totora) no se nota; con 8 (URUTAU) ya hubo que meter una pausa entre uno y otro; con 34
  # (FRESNO) el host rechaza por límite de velocidad, los 4 reintentos se agotan y **las 34 notas
  # salen calculadas contra el build anterior en vez de contra la versión publicada** — que es
  # exactamente el punto de correr `--from-server`. Medido en el build 9280: `login HTTP 429`
  # y las 34 degradadas.
  #
  # La pausa entre formularios era un parche a la ráfaga: el problema de fondo es pedir N
  # ingresos para responder N preguntas cuando alcanza con UNO. Quien invoca en lote se loguea
  # una vez y pasa el token por `BZ_TOKEN`; acá se usa y no se vuelve a entrar.
  # Sin `BZ_TOKEN` el comportamiento es EXACTAMENTE el de antes (una llamada suelta se loguea
  # sola), así que ningún invocador existente cambia.
  if [ -n "${BZ_TOKEN:-}" ]; then
    token="$BZ_TOKEN"
    consultar_version "$token"
    return 0
  fi

  headers=$(mktemp)
  # El body se arma con jq: una clave con comillas o barras rompía el JSON escrito a mano
  # y el login fallaba degradando en silencio.
  body=$(jq -nc --arg u "$USUARIO" --arg p "$CLAVE" '{username:$u, password:$p, tenant_id:"default"}')
  # El cuerpo de la respuesta se GUARDA (antes iba a /dev/null): este servidor devuelve el
  # token en el JSON y no siempre en la cookie, así que sin el cuerpo no hay plan B. El paso
  # de despliegue de este mismo pipeline sí tiene ese fallback (azure-pipelines.yml, "Extract
  # token ... Fallback: try extracting token from JSON response body") y por eso entra bien
  # mientras este guion decía "el login no devolvió token" y calculaba la nota contra el build
  # anterior en vez de contra la versión PUBLICADA, que es el punto de correr --from-server.
  local respuesta intento
  respuesta=$(mktemp)
  # 🔴 Reintento (2026-09-01): el login se cae de vez en cuando por la RED (HTTP 000 = curl no
  # llegó) o por el límite de ingresos del host (429 / "Too Many Requests"), no por la clave.
  # Sin reintento, un tropiezo de un segundo mandaba la nota al camino de respaldo ("desde el
  # build anterior") y — desde el fail-loud de la mañana — pintaba el deploy de naranja. Medido
  # en Totora/FrontEnd run 9230: el primer formulario dio 000 y los otros tres entraron bien.
  # El paso de deploy de al lado ya reintentaba 4 veces; éste no. Misma política: 4 intentos,
  # espera creciente, y sólo ante fallas transitorias — un 401 de clave mala no se reintenta.
  for intento in 1 2 3 4; do
    code=$(curl -s -D "$headers" -o "$respuesta" -w '%{http_code}' --max-time 25 \
      "${URL}/api/auth/login" -H 'Content-Type: application/json' --data-raw "$body" 2>/dev/null) || code="000"
    [ "$code" = "200" ] && break
    # El host devuelve su límite de ingresos como 401 + "Too Many Requests" (no 429): es transitorio.
    if [ "$code" = "401" ] && grep -qi "too many requests" "$respuesta" 2>/dev/null; then code="429"; fi
    case "$code" in
      000|429|5??)
        [ "$intento" -lt 4 ] && { echo "[release-notes] login HTTP $code (intento $intento) — reintento en $((intento*15))s" >&2; sleep $((intento*15)); } ;;
      *) break ;;
    esac
  done
  if [ "$code" != "200" ]; then
    echo "[release-notes] no se pudo entrar al servidor (HTTP $code, $intento intento/s)" >&2
    rm -f "$headers" "$respuesta"; return 0
  fi
  token=$(grep -i 'set-cookie:.*admin_token=' "$headers" | sed 's/.*admin_token=\([^;]*\).*/\1/' | head -1)
  [ -z "$token" ] && token=$(jq -r '.token // .accessToken // empty' "$respuesta" 2>/dev/null)
  rm -f "$headers" "$respuesta"
  [ -z "$token" ] && { echo "[release-notes] el login no devolvió token (ni cookie ni cuerpo)" >&2; return 0; }

  consultar_version "$token"
}

# La consulta en sí, separada del ingreso para que se pueda hacer con un token ya obtenido.
# Se mandan las dos formas de autenticación: el controller acepta `Authorization: Bearer`
# y el resto del pipeline usa la cookie.
# 🔴 LA ÚNICA divergencia real entre las dos variantes: el host expone los plugins y los
# formularios en direcciones distintas, con formas de respuesta distintas. Son estas 6 líneas —
# el resto del guion es idéntico, y por eso alcanza con una bandera.
consultar_version() {
  local token="$1"
  if [ "$TIPO" = "form" ]; then
    # 🔴 DIAGNÓSTICO (2026-09-01, un producto del equipo — guides/maintaining/incident-log.md#case-release-notes-against-published-2026-09-01). Antes esto se comía la respuesta y el guion sólo podía
    # decir "el servidor no dijo qué versión tiene publicada" — una frase que tapa TRES causas
    # distintas y manda a buscar el problema en cualquiera de las tres:
    #   (a) la dirección no existe en ese host (404) → el host es de otra versión;
    #   (b) contesta pero la versión no trae el commit → el paquete se subió sin ese dato;
    #   (c) rechaza el ingreso (401) → problema de permisos, no de datos.
    # Ahora se dice CUÁL de las tres, por stderr. Un mensaje que no distingue causas es un
    # mensaje que hace perder una tarde — pasó exactamente eso con los 33 formularios de ese producto.
    local cuerpo codigo
    cuerpo=$(mktemp)
    codigo=$(curl -s -o "$cuerpo" -w '%{http_code}' --max-time 25 "${URL}/api/custom-forms/${NOMBRE}/versions" \
      -H "Cookie: admin_token=$token" -H "Authorization: Bearer $token" -H 'X-Tenant-Id: default' 2>/dev/null) || codigo="000"
    if [ "$codigo" != "200" ]; then
      echo "[release-notes] $NOMBRE: el host contestó HTTP $codigo al pedirle las versiones — no es que falte el dato, es que no se pudo preguntar" >&2
      rm -f "$cuerpo"; return 0
    fi
    local hash
    hash=$(jq -r '
        (if type=="array" then . else (.versions // .data // .items // []) end)
        | (map(select(.isCurrent == true or .IsCurrent == true)) | .[0]) // .[0]
        | (.commitHash // .CommitHash // "")' "$cuerpo" 2>/dev/null | grep -vx 'null' || true)
    if [ -z "$hash" ]; then
      local cuantas campos
      cuantas=$(jq -r '(if type=="array" then . else (.versions // .data // .items // []) end) | length' "$cuerpo" 2>/dev/null || echo '?')
      campos=$(jq -r '(if type=="array" then . else (.versions // .data // .items // []) end) | .[0] | keys | join(", ")' "$cuerpo" 2>/dev/null || echo '?')
      if [ "$cuantas" = "0" ]; then
        echo "[release-notes] $NOMBRE: el host contestó bien pero NO tiene ninguna versión publicada de este formulario" >&2
      else
        echo "[release-notes] $NOMBRE: el host tiene $cuantas versión/es pero ninguna trae el commit. Campos que sí devuelve: $campos" >&2
      fi
    fi
    rm -f "$cuerpo"
    [ -n "$hash" ] && printf '%s' "$hash"
    return 0
  else
    curl -s --max-time 25 "${URL}/api/admin/plugins" \
      -H "Authorization: Bearer $token" -H "Cookie: admin_token=$token" -H 'X-Tenant-Id: default' 2>/dev/null \
      | jq -r --arg n "$NOMBRE" '
          (if type=="array" then . else (.plugins // .data // .items // []) end)
          | map(select((.name // "" | ascii_downcase) == ($n | ascii_downcase)))
          | .[0] | (.commitHash // .commit_hash // "")' 2>/dev/null \
      | grep -vx 'null' || true
  fi
}

# ---------------------------------------------------------------- commit del build anterior
# Marcador natural: el CI hace un commit "chore: bump version ..." en cada build.
# Los tres mensajes que escriben los bots del equipo. Estar de más es inofensivo: se busca el
# ÚLTIMO que matchee cualquiera, y ningún repo usa los tres.
hash_build_anterior() {
  git log -1 --pretty=%H \
    --grep='^chore: bump version' \
    --grep='^chore: update form versions' \
    --grep='^chore: update versions' 2>/dev/null || true
}

# ---------------------------------------------------------------- lista de cambios
lista_desde() {
  local desde="$1" todo n
  todo=$(git log "${desde}..HEAD" --no-merges --pretty=%s -- "${PATHS[@]}" 2>/dev/null \
    | grep -vE "$RUIDO" | sed 's/^/- /' || true)
  [ -z "$todo" ] && return 0
  n=$(printf '%s\n' "$todo" | grep -c '^- ' || true)
  if [ "${n:-0}" -gt "$MAX_LINEAS" ]; then
    # Tras varias versiones sin publicar la lista puede ser enorme, y esto va dentro del
    # paquete: se corta diciendo cuántos cambios quedaron afuera.
    printf '%s\n- … y %s cambios más (ver el historial del repositorio)\n' \
      "$(printf '%s\n' "$todo" | head -"$MAX_LINEAS")" "$((n - MAX_LINEAS))"
  else
    printf '%s\n' "$todo"
  fi
}

# ---------------------------------------------------------------- salida
REF=""
ORIGEN=""
if [ "$MODO" = "--from-server" ]; then
  REF="$(hash_publicado)"
  ORIGEN="la versión que está publicada"
fi
if [ -z "$REF" ]; then
  REF="$(hash_build_anterior)"
  ORIGEN="el build anterior"
fi

# El commit tiene que existir en ESTE clon: con historia recortada, o si la versión publicada
# salió de otra rama, no sirve como punto de partida.
# 🔴 CUARTA CAUSA (2026-09-01, un producto del equipo — guides/maintaining/incident-log.md#case-release-notes-against-published-2026-09-01). El diagnóstico de arriba cubre tres causas de "no hay nota
# contra lo publicado", y le faltaba ÉSTA — la que de verdad pasó: el host contesta perfecto, el
# commit llega, y NO ESTÁ EN EL CLON porque el job del despliegue clonó sin historia (o sin
# clonar). El síntoma era "sin punto de partida confiable", que se lee como "el host no contestó"
# y manda a buscar el problema al host. Se perdió una tarde así. Ahora se distingue.
if [ -n "$REF" ] && [ "$ORIGEN" = "la versión que está publicada" ] && ! git cat-file -e "${REF}^{commit}" 2>/dev/null; then
  echo "[release-notes] $NOMBRE: el host SÍ dijo su versión publicada (${REF:0:8}) pero ese commit no está en este clon — al job le falta clonar el repo con historia (checkout: self + fetchDepth: 0). No es un problema del host." >&2
fi
if [ -z "$REF" ] || ! git cat-file -e "${REF}^{commit}" 2>/dev/null; then
  echo "[release-notes] sin punto de partida confiable; se listan los cambios del último commit" >&2
  # 🔴 El filtro de RUIDO también acá (2026-08-31). Este camino de respaldo publicaba el último
  # commit TAL CUAL, y con el flujo de Pull Request ese commit se llama "Merged PR N: …" o es el
  # bump del propio bot. El `^Merged PR` que se había agregado a RUIDO no servía de nada en este
  # camino: RUIDO sólo se aplicaba en `lista_desde`, donde `--no-merges` ya excluía el merge. O
  # sea que el arreglo estaba puesto y el único camino que lo necesitaba no lo usaba.
  ULTIMO=$(git log -5 --pretty=%s -- "${PATHS[@]}" 2>/dev/null | grep -vE "$RUIDO" | head -1 | sed 's/^/- /' || true)
  [ -z "$ULTIMO" ] && ULTIMO="- (sin cambios)"
  printf 'Últimos cambios (la lista puede estar incompleta):\n\n%s\n' "$ULTIMO"
  exit 0
fi

CAMBIOS="$(lista_desde "$REF")"
if [ -z "$CAMBIOS" ]; then
  printf 'Sin cambios desde %s (%s) — esta versión sólo trae cambios internos del repositorio.\n' \
    "$ORIGEN" "$(git rev-parse --short "$REF")"
else
  printf 'Cambios desde %s (%s):\n\n%s\n' "$ORIGEN" "$(git rev-parse --short "$REF")" "$CAMBIOS"
fi
exit 0
