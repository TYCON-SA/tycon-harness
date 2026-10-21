#!/usr/bin/env bash
# validate-pipeline-in-ado.sh — validar un pipeline CONTRA Azure DevOps sin ejecutarlo ni hacer cola.
#
# 🔴 POR QUÉ EXISTE: probar un pipeline corriéndolo de verdad es lento, y cada corrida ocupa uno de los
# dos carriles de la organización. Lo que hay para acelerarlo:
#
#   · NO existe un simulador de pipelines de Azure DevOps. GitHub Actions tiene `act`; acá no hay
#     equivalente, ni oficial ni de la comunidad, que ejecute el pipeline localmente.
#   · SÍ existe la "corrida en modo vista previa" (`previewRun`): Azure toma un YAML —incluso uno
#     que no está commiteado, vía `yamlOverride`— lo valida y devuelve el YAML final expandido,
#     con identificador de corrida -1. No ejecuta, no consume uno de los dos carriles de la
#     organización y contesta en segundos.
#
# 🔴 QUÉ ATRAPA (un caso por clase):
#     · YAML mal indentado                     · clave duplicada
#     · una tarea que no existe                · un `dependsOn` a una etapa inexistente
#     · una plantilla que no está en el repo
#
# 🔴 QUÉ **NO** ATRAPA, y hay que decirlo para que nadie lo lea de más: las expresiones se evalúan
# en tiempo de ejecución, así que una condición mal escrita —`succeededd()` con dos "d"— PASA la
# vista previa. Esto valida el ESQUELETO, no la conducta. La conducta la prueban los casos locales
# de cada guion y los controles estáticos del arnés; la corrida real queda para la confirmación.
#
# Uso:
#   validate-pipeline-in-ado.sh --project <p> --pipeline <id> [--yaml <archivo>]
#   validate-pipeline-in-ado.sh --project Totora --pipeline 94 --yaml ./azure-pipelines.yml
#   (el nombre viejo en castellano de --project sigue andando hasta el retiro)
#   --org <url> pisa la organización; sin ella se usa la configurada (ver abajo).
#   Sin --yaml se valida el YAML que ya está en el repo.
#   Con --yaml se valida ese archivo local, aunque no esté commiteado.
#
# Necesita AZURE_DEVOPS_EXT_PAT. Exit: 0 válido · 1 rechazado · 2 no se pudo consultar.
set -u
ORG="${TYCON_ADO_ORG:-${ADO_ORG:-}}"   # la misma precedencia que el lector (tycon-config.js): TYCON_ADO_ORG › ADO_ORG
PROY=""; PID=""; YAML=""
# El traductor de las opciones viejas vive al lado (viaja en el artefacto arnes-ci).
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  LEGACY_OPTIONS_PREFIX='[validar] ' legacy_options 'proyecto:project' "$@" || exit 2
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROY="$2"; shift 2 ;;
    --pipeline) PID="$2"; shift 2 ;;
    --yaml) YAML="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) echo "[validar] argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
# La organización sale de la configuración del arnés: --org › ADO_ORG / TYCON_ADO_ORG › `ado.org`
# (perfil del equipo o ~/.claude/tycon.json). Sin organización, Azure DevOps está APAGADA en esta máquina: se dice en
# una línea y sale 0 sin consultar nada. Nunca «válido».
if [ -z "$ORG" ]; then
  CFG_ERR="$(mktemp)"
  ORG="$(node "$(cd "$(dirname "$0")" && pwd)/../lib/tycon-config.js" get ado.org 2>"$CFG_ERR")"; RC_ORG=$?
  # rc 2 = configuración del arnés ROTA: un comando frena con el archivo, la clave y el motivo
  if [ "$RC_ORG" = "2" ]; then cat "$CFG_ERR" >&2; rm -f "$CFG_ERR"; exit 2; fi
  # rc 0 = hay organización · rc 3 = sin valor (apagada). Cualquier OTRO rc (node ausente = 127, un crash = 1) es «no pude
  # preguntar», que no se disfraza de «apagado» (regla 5 del bloque ADO)
  if [ "$RC_ORG" != "0" ] && [ "$RC_ORG" != "3" ]; then
    echo "[validar] no pude leer la configuración del arnés (rc $RC_ORG) — no sé si Azure DevOps está prendida: $(tr '\n' ' ' < "$CFG_ERR" | head -c 300)" >&2
    rm -f "$CFG_ERR"; exit 2
  fi
  rm -f "$CFG_ERR"
fi
[ -n "$ORG" ] || { echo "[validar] Azure DevOps apagado en esta máquina: no hay organización configurada, el pipeline no se validó (prender: ado.org en ~/.claude/tycon.json, TYCON_ADO_ORG, o pasá --org)"; exit 0; }
[ -n "$PROY" ] && [ -n "$PID" ] || { echo "[validar] faltan --project y --pipeline" >&2; exit 2; }
[ -n "${AZURE_DEVOPS_EXT_PAT:-}" ] || { echo "[validar] falta AZURE_DEVOPS_EXT_PAT — sin credenciales NO puedo validar, y eso no es 'válido'" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "[validar] falta python3" >&2; exit 2; }

CUERPO=$(mktemp); trap 'rm -f "$CUERPO"' EXIT
if [ -n "$YAML" ]; then
  [ -f "$YAML" ] || { echo "[validar] no encuentro $YAML" >&2; exit 2; }
  python3 -c "
import json,sys
y=open(sys.argv[1],encoding='utf-8').read()
json.dump({'previewRun':True,'yamlOverride':y}, open(sys.argv[2],'w',encoding='utf-8'))
" "$YAML" "$CUERPO" || { echo "[validar] no pude armar el pedido" >&2; exit 2; }
else
  echo '{"previewRun":true}' > "$CUERPO"
fi

# 🔴 El nombre del proyecto va codificado para la URL: "Acme Logistica" tiene un espacio, y sin
# codificar la consulta falla con un error de red que se lee como "no pude consultar", aunque el pipeline esté bien.
PROY_URL=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PROY")
AUTH=$(printf ':%s' "$AZURE_DEVOPS_EXT_PAT" | base64 | tr -d '\n')
RESP=$(curl -s --max-time 60 -X POST "${ORG}/${PROY_URL}/_apis/pipelines/${PID}/runs?api-version=7.1-preview.1" \
  -H "Authorization: Basic ${AUTH}" -H "Content-Type: application/json" --data-binary @"$CUERPO") || {
  echo "[validar] no pude consultar a Azure — eso NO es 'válido'" >&2; exit 2; }

printf '%s' "$RESP" | python3 -c "
import json,sys
crudo=sys.stdin.read()
try: d=json.loads(crudo, strict=False)
except Exception:
    print('🔴 respuesta ilegible de Azure — no puedo decir si es válido'); sys.exit(2)
etq=sys.argv[1] if len(sys.argv)>1 else ''
if 'finalYaml' in d:
    print(f'✅ {etq}: válido para Azure ({len(d[\"finalYaml\"])} caracteres de YAML final, sin ejecutar)')
    sys.exit(0)
msg=d.get('message') or d.get('typeName') or str(d)[:300]
print(f'🔴 {etq}: Azure lo RECHAZA — {msg[:400]}')
sys.exit(1)
" "${YAML:-$PROY/$PID}"
