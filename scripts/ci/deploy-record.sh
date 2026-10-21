#!/usr/bin/env bash
# =============================================================================
# deploy-record.sh — cada despliegue queda anotado en SU corrida de Azure DevOps
# =============================================================================
# 🔴 POR QUÉ EXISTE. Sin registro, el arnés no sabe qué le llegó a cada servidor ni cuándo: el humo
# aprueba el despliegue y la corrida termina verde sin dejar nada que se pueda contar. Contar
# despliegues por producto y medir cuánto tarda un commit en llegar a producción necesita que cada
# despliegue deje UNA línea legible y una etiqueta que permita encontrar la corrida sin leer su log.
# Se hace acá, en los guiones que ya corren en todos los pipelines, porque un paso nuevo en cada
# YAML son decenas de copias que divergen.
#
# Se CARGA con `source` desde smoke-plugin.sh, smoke-forms.sh y deploy-plugin.sh. No se ejecuta solo.
# Ninguna función sale con `exit`: devuelven, y el guion que llama sigue con su propio veredicto.
#
# ── EL CONTRATO QUE LEE EL CONTEO DE DESPLIEGUES ─────────────────────────────────────────────────────────────────
# PREFIJO: [registro-despliegue]
#   Una línea por despliegue en el log de la corrida: el prefijo, un espacio y un JSON en una línea.
# CLAVES: v ts estado tipo entorno entorno_fuente proyecto repo destino artefacto version hash build build_ci clave
#   v               1
#   ts              momento en UTC (AAAA-MM-DDTHH:MM:SSZ)
#   estado          desplegado (el humo lo aprobó) · intentado (deploy-plugin.sh entró al host)
#                   En formularios, desplegado = PUBLICADO POR ESTA CORRIDA: el host vuelve a publicar una
#                   versión que ya tenía (no da 409; sp_UpsertBZExtForm reemplaza código y commit), así que
#                   la misma versión subida otra vez también se anota. Un CAMBIO se cuenta por la primera
#                   aparición de (proyecto, repo, destino, entorno, artefacto, version) — eso lo hace el lector del registro.
#   tipo            plugin · formulario
#   entorno         staging · produccion
#   entorno_fuente  declarado (--environment de deploy-plugin.sh en el mismo job) · derivado
#   proyecto        SYSTEM_TEAMPROJECT (crudo; el nombre de producto lo mapea el lector del registro con repos.json)
#   repo            BUILD_REPOSITORY_NAME (crudo; proyecto+repo es único en los 17 repos)
#   destino         SYSTEM_STAGENAME/SYSTEM_JOBNAME — distingue los dos stagings de Pacara
#   artefacto       nombre del plugin o del formulario
#   version         la versión instalada
#   hash            el commit del paquete (plugins: el que pasó el paso, 7 caracteres; formularios: el
#                   del manifest) o null — NUNCA BUILD_SOURCEVERSION, que en una promoción manual es
#                   la punta de la rama
#   build           BUILD_BUILDID (la corrida que despliega)
#   build_ci        RESOURCES_PIPELINE_CI_RUNID si existe (producción: el CI promovido), si no BUILD_BUILDID
#   clave           d-<16 hex> del SHA-256 de estado|tipo|proyecto|repo|destino|entorno|artefacto|version|hash7
#                   Identifica el DESPLIEGUE, no la corrida: dos corridas que despliegan lo mismo en el
#                   mismo destino tienen la misma clave. El lector deduplica por clave.
#   Un campo sin valor es null, nunca "".
# ETIQUETAS: desplegado · <artefacto>-<version> · despliegue-intentado
#   Cada una se emite una vez por job. Una corrida con despliegue-intentado y sin desplegado es un
#   despliegue de plugin que falló.
#
# ── LO QUE NO SE REGISTRA (declarado) ────────────────────────────────────────────────────────────
#   · el gateway de Pacara (azure-pipelines-gateway-prod.yml no pasa por estos guiones)
#   · los intentos de formularios (su subida es un paso inline del YAML, no un guion del arnés)
#   · producción de URUTAU, Lapacho y Ceibo: no tienen pipeline de producción
#   · producción corre el guion del artefacto del CI PROMOVIDO: el registro llega a producción cuando
#     se promueve un CI construido después del merge del arnés
#
# ── REGLAS ───────────────────────────────────────────────────────────────────────────────────────
#   · Sólo dentro de una corrida de Azure (TF_BUILD=True). Afuera no imprime nada.
#   · La dirección del host, el usuario y la clave NUNCA llegan acá: no se reciben.
#   · Texto de afuera no fija comandos de la corrida: cada valor se valida contra su juego de
#     caracteres y, si no entra, no se anota y se avisa con el nombre saneado.
#   · Anotar nunca cambia el veredicto del que llama: si no puede, avisa con
#     ##vso[task.logissue type=warning] y devuelve 1.
# =============================================================================

REG_DIR_JOB=""   # $AGENT_TEMPDIRECTORY/tycon-despliegue, o vacío si no hay dónde marcar
REG_ENTORNO=""; REG_ENTORNO_FUENTE=""
REG_ETIQUETAS_EMITIDAS=" "

registro_activo() { [ "${TF_BUILD:-}" = "True" ]; }

# Texto de un aviso: sin corchetes, numerales ni saltos de línea (no puede formar un ##vso[).
registro_aviso() {
  registro_activo || return 0
  local t
  t=$(printf '%s' "$1" | tr -d '[]#\r\n')
  echo "##vso[task.logissue type=warning]registro-despliegue: $t"
}

# Un nombre de afuera, reducido a caracteres inofensivos, para citarlo en un aviso.
registro_sanear() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._/-' | cut -c1-60; }

# Un valor con salto de línea no pasa nunca: grep miraría cada línea por separado.
_reg_valido() { case "$2" in *$'\n'*|*$'\r'*) return 1 ;; esac; printf '%s' "$2" | grep -Eq "$1"; }

_reg_dir_job() {
  REG_DIR_JOB=""
  [ -n "${AGENT_TEMPDIRECTORY:-}" ] && [ -d "${AGENT_TEMPDIRECTORY}" ] || return 1
  mkdir -p "${AGENT_TEMPDIRECTORY}/tycon-despliegue" 2>/dev/null || return 1
  REG_DIR_JOB="${AGENT_TEMPDIRECTORY}/tycon-despliegue"
}

_reg_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -c1-16
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum -a 256 | cut -c1-16
  else return 1; fi
}

# El entorno: el que deploy-plugin.sh DECLARÓ en este job manda; si no hay, se deriva. Si los dos
# existen y discrepan, se usa el declarado y se avisa: es la verificación de la regla derivada (sus
# variables salen de la documentación de Azure).
registro_entorno() {
  local derivado declarado=""
  if [ -n "${ENVIRONMENT_NAME:-}" ] || [ -n "${RESOURCES_PIPELINE_CI_RUNID:-}" ]; then derivado="produccion"; else derivado="staging"; fi
  if [ -n "${AGENT_TEMPDIRECTORY:-}" ] && [ -f "${AGENT_TEMPDIRECTORY}/tycon-despliegue/entorno" ]; then
    declarado=$(head -1 "${AGENT_TEMPDIRECTORY}/tycon-despliegue/entorno" 2>/dev/null | tr -d '\r\n ')
    case "$declarado" in staging|produccion) ;; *) declarado="" ;; esac
  fi
  if [ -n "$declarado" ]; then
    REG_ENTORNO="$declarado"; REG_ENTORNO_FUENTE="declarado"
    if [ "$derivado" != "$declarado" ]; then
      registro_aviso "la regla derivada dice $derivado y desplegar-plugin declaró $declarado — la regla no vale en este pipeline"
    fi
  else
    REG_ENTORNO="$derivado"; REG_ENTORNO_FUENTE="derivado"
  fi
  return 0
}

# deploy-plugin.sh deja el entorno que recibió por --environment para el humo del mismo job.
# El entorno de producción se recibe con el nombre de la opción («production») o con el que se
# GRABA en el registro, y se graba siempre como REG_PROD_RECORDED: es el valor que espera quien lee el registro y el que
# traen los registros ya escritos (se acepta el nombre nuevo y se graba el viejo).
REG_PROD_RECORDED="produccion"
registro_declarar_entorno() {
  registro_activo || return 0
  local entorno="${1:-}"
  [ "$entorno" = "production" ] && entorno="$REG_PROD_RECORDED"
  if [ "$entorno" != "staging" ] && [ "$entorno" != "$REG_PROD_RECORDED" ]; then
    registro_aviso "--environment $(registro_sanear "${1:-}") no es staging ni production: el humo de este job va a derivar el entorno"
    return 1
  fi
  # 🔴 el 2>/dev/null va AFUERA de la redirección: `cmd > archivo 2>/dev/null` imprime el «Permission
  # denied» igual, porque el `>` falla antes de que el 2>/dev/null tome efecto.
  if ! _reg_dir_job || ! { printf '%s\n' "$entorno" > "$REG_DIR_JOB/entorno"; } 2>/dev/null; then
    registro_aviso "no pude dejar el entorno $entorno para el humo de este job (sin directorio temporal del job o sin permiso): el humo va a derivarlo"
    return 1
  fi
  return 0
}

# Una etiqueta, una vez por job (marca en el directorio del job; sin directorio, una vez por proceso).
_reg_etiqueta() {
  local tag="$1"
  case "$REG_ETIQUETAS_EMITIDAS" in *" $tag "*) return 0 ;; esac
  if [ -n "$REG_DIR_JOB" ]; then
    [ -f "$REG_DIR_JOB/etiqueta-$tag" ] && return 0
    { : > "$REG_DIR_JOB/etiqueta-$tag"; } 2>/dev/null
  fi
  REG_ETIQUETAS_EMITIDAS="$REG_ETIQUETAS_EMITIDAS$tag "
  echo "##vso[build.addbuildtag]$tag"
}

# ¿Están las herramientas para anotar? (jq y una herramienta de huella). No imprime nada: quien recorre
# muchos artefactos (smoke-forms.sh) lo pregunta una vez y avisa una vez, en vez de un aviso por formulario.
registro_puede_anotar() { command -v jq >/dev/null 2>&1 && _reg_sha256 x >/dev/null 2>&1; }

# registro_despliegue <estado> <tipo> <artefacto> <version> <hash>
# 0 = anotado (o ya anotado en este job) · 1 = no se anotó (fuera de Azure, o avisado)
registro_despliegue() {
  registro_activo || return 1
  local estado="${1:-}" tipo="${2:-}" artefacto="${3:-}" version="${4:-}" hash="${5:-}"
  local proyecto="${SYSTEM_TEAMPROJECT:-}" repo="${BUILD_REPOSITORY_NAME:-}" destino=""
  local build="${BUILD_BUILDID:-}" build_ci="${RESOURCES_PIPELINE_CI_RUNID:-${BUILD_BUILDID:-}}"
  local nombre; nombre=$(registro_sanear "$artefacto")

  command -v jq >/dev/null 2>&1 || { registro_aviso "falta jq — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }
  case "$estado" in desplegado|intentado) ;; *) registro_aviso "estado desconocido — esta corrida queda SIN registro de despliegue para $nombre"; return 1 ;; esac
  case "$tipo" in plugin|formulario) ;; *) registro_aviso "tipo desconocido — esta corrida queda SIN registro de despliegue para $nombre"; return 1 ;; esac
  if [ -n "${SYSTEM_STAGENAME:-}" ] || [ -n "${SYSTEM_JOBNAME:-}" ]; then
    destino="${SYSTEM_STAGENAME:-sin-stage}/${SYSTEM_JOBNAME:-sin-job}"
  fi

  _reg_valido '^[A-Za-z0-9._-]{1,100}$' "$artefacto" || { registro_aviso "el nombre del artefacto ($nombre) tiene caracteres fuera de su juego — esta corrida queda SIN registro de despliegue para él"; return 1; }
  _reg_valido '^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$' "$version" || { registro_aviso "la versión de $nombre ($(registro_sanear "$version")) no tiene forma de versión — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }
  if [ -n "$destino" ]; then
    _reg_valido '^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$' "$destino" || { registro_aviso "el stage o el job ($(registro_sanear "$destino")) tiene caracteres fuera de su juego — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }
  fi
  if [ -n "$proyecto" ]; then _reg_valido '^[A-Za-z0-9 ._-]{1,64}$' "$proyecto" || { registro_aviso "el nombre del proyecto tiene caracteres fuera de su juego — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }; fi
  if [ -n "$repo" ]; then _reg_valido '^[A-Za-z0-9 ._-]{1,64}$' "$repo" || { registro_aviso "el nombre del repo tiene caracteres fuera de su juego — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }; fi
  _reg_valido '^[0-9]{1,20}$' "$build" || build=""
  _reg_valido '^[0-9]{1,20}$' "$build_ci" || build_ci=""
  _reg_valido '^[0-9a-fA-F]{7,40}$' "$hash" || hash=""

  registro_entorno
  local hash7="sin-hash"
  [ -n "$hash" ] && hash7=$(printf '%s' "$hash" | cut -c1-7 | tr 'A-F' 'a-f')
  local huella
  huella=$(_reg_sha256 "$estado|$tipo|$proyecto|$repo|$destino|$REG_ENTORNO|$artefacto|$version|$hash7") || { registro_aviso "no hay sha256sum ni shasum para calcular la clave — esta corrida queda SIN registro de despliegue para $nombre"; return 1; }
  local clave="d-$huella"

  _reg_dir_job || true
  if [ -n "$REG_DIR_JOB" ] && [ -f "$REG_DIR_JOB/$clave" ]; then return 0; fi

  local json
  json=$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg estado "$estado" --arg tipo "$tipo" \
    --arg entorno "$REG_ENTORNO" --arg fuente "$REG_ENTORNO_FUENTE" --arg proyecto "$proyecto" \
    --arg repo "$repo" --arg destino "$destino" --arg artefacto "$artefacto" --arg version "$version" \
    --arg hash "$hash" --arg build "$build" --arg build_ci "$build_ci" --arg clave "$clave" '
    def n: if . == "" then null else . end;
    {v: 1, ts: $ts, estado: $estado, tipo: $tipo, entorno: $entorno, entorno_fuente: $fuente,
     proyecto: ($proyecto|n), repo: ($repo|n), destino: ($destino|n), artefacto: $artefacto,
     version: $version, hash: ($hash|n), build: ($build|n), build_ci: ($build_ci|n), clave: $clave}' 2>/dev/null)
  if [ -z "$json" ]; then registro_aviso "no pude armar la línea — esta corrida queda SIN registro de despliegue para $nombre"; return 1; fi

  [ -n "$REG_DIR_JOB" ] && { : > "$REG_DIR_JOB/$clave"; } 2>/dev/null
  echo "[registro-despliegue] $json"
  if [ "$estado" = "desplegado" ]; then
    _reg_etiqueta "desplegado"
    _reg_etiqueta "$artefacto-$version"
  else
    _reg_etiqueta "despliegue-intentado"
  fi
  return 0
}
