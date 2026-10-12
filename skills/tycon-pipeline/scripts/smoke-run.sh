#!/usr/bin/env bash
# =============================================================================
# smoke-run.sh — registra un smoke runtime (curl/lo que sea) como EVIDENCIA
# machine-readable para runtime-matrix.js (regla DODRT-C6).
#
# Por qué: los smokes por curl quedaban descriptos en PROSA (Debug Log de la
# story) — ninguna capa mecánica podía saber si de verdad corrieron. Este
# wrapper corre el comando, captura el EXIT CODE REAL y lo appendea a:
#   1. <evidence-dir>/<story>-smoke-ledger.jsonl        (el repo)
#   2. ~/.claude/.tycon-pipeline/gates.log              (espejo global, append-only)
# runtime-matrix.js solo cuenta entries que existen EN AMBOS (anti escritura a
# mano del ledger) y con exit 0.
#
# Uso:
#   smoke-run.sh <evidence-dir> <ruta-de-la-story.md | story-id> --acs 8,9 -- <comando...>
#   (con la ruta, la clave del registro la calcula lib/evidence-key.js — story 1.17)
# Ejemplo:
#   smoke-run.sh .../.advisors/dod-runtime 10.4 --acs 9 -- \
#     curl -sf -X POST http://localhost:5001/api/pedidos/42/articulos ...
#
# Exit: el exit code REAL del comando (0 se registra como evidencia válida;
# !=0 también se registra, pero la matriz no lo cuenta).
# =============================================================================
set -u

EVIDENCE_DIR="${1:?Falta <evidence-dir>}"
STORY_ID="${2:?Falta <story-id> o la ruta de la story}"
shift 2

# ── La CLAVE de la evidencia (story 1.17) ──
# Con la RUTA de la story (lo recomendado) la clave sale de lib/evidence-key.js: el número solo si es
# único en su repo, `<tema>__<número>` si se repite — así dos stories 1.1 de temas distintos no escriben
# en el mismo registro. Con un número a mano sigue andando, pero en un número repetido el registro queda
# huérfano (la matriz lo nombra y no lo cuenta). Si la clave no se puede decidir, NO se corre el humo:
# un humo registrado bajo una clave adivinada es evidencia que puede terminar contándole a otra story.
case "$STORY_ID" in
  *.md)
    if [ ! -f "$STORY_ID" ]; then
      echo "smoke-run.sh: no encontré la story $STORY_ID — no se corre el humo (una ruta mal escrita no puede nombrar evidencia)." >&2
      exit 2
    fi
    KEY_JS="$(cd "$(dirname "$0")" && pwd)/lib/evidence-key.js"
    if ! STORY_KEY="$(node "$KEY_JS" "$STORY_ID")" || [ -z "$STORY_KEY" ]; then
      echo "smoke-run.sh: no pude calcular la clave de la evidencia de $STORY_ID — no se corre el humo." >&2
      exit 2
    fi
    STORY_ID="$STORY_KEY" ;;
esac
# El id (a mano o calculado) nombra un archivo y entra en una línea JSON: sólo letras, números y `. _ + ~ -`, sin
# `..`. Una barra o un `../` escribirían fuera de la carpeta de evidencia; una comilla rompería el registro.
_ID_RE='^[A-Za-z0-9][A-Za-z0-9._+~-]*$'
if ! [[ "$STORY_ID" =~ $_ID_RE ]] || [[ "$STORY_ID" == *..* ]]; then
  echo "smoke-run.sh: «${STORY_ID}» no sirve para nombrar evidencia (sólo letras, números y . _ + ~ -, sin ..) — no se corre el humo." >&2
  exit 2
fi

ACS=""
MUTATES=0
# Flags opcionales en cualquier orden antes del `--`.
# --mutates (DODRT-C8, 2026-08-13 — caso Story 4.34 de un repo del equipo): declara que este smoke
# EJECUTA una mutación de estado. Es la vía para productos sin superficie HTTP ni navegador
# (el MCP habla por stdio: la matriz no puede olfatear un `-X DELETE` que no existe). No es
# más débil que olfatear el comando — un `-X DELETE` también lo escribe el agente; la garantía
# real es el exit code que este wrapper captura. El flag viaja al ledger Y al espejo de
# gates.log: la matriz lo acepta SOLO si el espejo (fuera del repo, append-only) lo trae.
while true; do
  case "${1:-}" in
    --acs)
      # Guard: `--acs` sin valor (o con `--` como "valor") registraría evidencia mal atribuida
      # o moriría con un `unbound variable` críptico. Mensaje claro y exit 2, sin correr nada.
      if [ $# -lt 2 ] || [ "$2" = "--" ]; then
        echo "smoke-run.sh: --acs necesita un valor (ej: --acs 1,3)" >&2
        exit 2
      fi
      ACS="$2"; shift 2 ;;
    --mutates) MUTATES=1; shift ;;
    *) break ;;
  esac
done
if [ "${1:-}" != "--" ]; then
  echo "smoke-run.sh: falta el separador -- antes del comando" >&2
  exit 2
fi
shift

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"$@"
EXIT=$?

ACS_JSON="[$(echo "$ACS" | tr ',' '\n' | grep -E '^[0-9]+$' | paste -sd, -)]"
MUT_FIELD=""
if [ "$MUTATES" = "1" ]; then MUT_FIELD=',"mutates":true'; fi

# ── SMOKE-SECRETO-1 (2026-09-22) y SMOKE-SECRETO-2 (2026-10-04) — el `cmd` se TAPA antes de escribirlo ──
# El ledger vive en `<repo>/.advisors/dod-runtime/`, que el .gitignore canónico deja VIAJAR por
# git a propósito (es la evidencia de cierre). Así que todo lo que entre en `cmd` termina en el
# repo, en el remoto y en la historia — incluida la credencial del smoke, escrita tal cual.
#
# No es hipotético: el 2026-09-22 aparecieron claves de API vivas y JWT en los ledgers de dos
# productos, y el 2026-10-04 contraseñas SQL —una, la de la base de PRODUCCIÓN— que el primer
# tapado dejaba pasar porque iban entre comillas o tenían símbolos (`SQLCMDPASSWORD='…'`,
# `sqlcmd -P …`). Documentarlo como convención ya había fallado: el tapado es mecánico por eso.
#
# El tapado vive en lib/smoke-secrets.js (las formas, por qué esas y no un intérprete de shell).
# Tapar acá es seguro para la evidencia: `runtime-matrix.js` cruza el ledger contra el espejo de
# gates.log por `ts` + `story` + `acs` + `exit`, NUNCA por `cmd` (ver su §"confirmadas").
#
# TYCON_SMOKE_REDACT=0 apaga sólo el tapado general (para un caso donde el valor SEA el dato bajo
# prueba); las formas de contraseña, token y clave de la lista se tapan siempre.
#
# 🔴 Si el tapado no puede correr, el comando NO se escribe: queda un aviso en su lugar. Antes, un
# python3 ausente (Windows) dejaba pasar el comando tal cual.
SECRETS_JS="$(cd "$(dirname "$0")" && pwd)/lib/smoke-secrets.js"
CMD_JSON=$(node "$SECRETS_JS" ledger-cmd -- "$@")
if [ $? -ne 0 ] || [ -z "$CMD_JSON" ]; then
  CMD_JSON='"[comando no registrado: no se pudieron tapar sus secretos]"'
  echo "[smoke-run] ⚠️ no se pudo correr el tapado de secretos ($SECRETS_JS): el comando NO se escribe en la evidencia." >&2
fi

ENTRY=$(printf '{"ts":"%s","story":"%s","acs":%s,"cmd":%s,"exit":%d,"via":"smoke-run.sh"%s}' \
  "$TS" "$STORY_ID" "$ACS_JSON" "$CMD_JSON" "$EXIT" "$MUT_FIELD")

mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$ENTRY" >> "$EVIDENCE_DIR/$STORY_ID-smoke-ledger.jsonl"

MIRROR_DIR="$HOME/.claude/.tycon-pipeline"
mkdir -p "$MIRROR_DIR"
# repoPath: namespace por repo (GATESLOG-STORYID-NS-1) — el espejo es global por máquina y los ids
# cortos de story se repiten entre repos. El repo es el dueño del evidence-dir (<repo>/.advisors/...);
# si no es un repo git, cae al cwd. Misma key que marker.js para que el capturer agrupe igual.
REPO_PATH="$(git -C "$EVIDENCE_DIR" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPO_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$REPO_PATH")"
printf '{"type":"smoke-run","ts":"%s","repoPath":%s,"story":"%s","acs":%s,"exit":%d%s}\n' \
  "$TS" "$REPO_JSON" "$STORY_ID" "$ACS_JSON" "$EXIT" "$MUT_FIELD" >> "$MIRROR_DIR/gates.log"

echo "[smoke-run] story=$STORY_ID acs=$ACS exit=$EXIT mutates=$MUTATES → ledger + gates.log" >&2
exit $EXIT
