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
# Story 1.19 (2026-10-15) — la prueba dice qué esperaba y qué salió:
#   · un humo que nombra criterios (`--acs`) escribe ANTES de correr qué tiene que pasar (`--pass-if`, y
#     opcional `--fail-if`). Sin `--pass-if` no corre. Un humo sin `--acs` (sembrar las precondiciones de
#     un AC) no lo necesita, y conviene correrlo igual por acá para que quede rastro;
#   · la salida del comando (con la de error mezclada) se ve en la terminal y además se guarda recortada
#     (≤ 8 KB) y tapada en <evidence-dir>/<story>-smoke-outputs/, con su sha256 en el registro Y el espejo;
#   · la línea lleva `"v":2`: la matriz exige la salida intacta para contarla.
#
# Imagen de pantalla — el humo de un criterio de pantalla deja su imagen:
#   · `--capture <archivo.png|.webm>` guarda en <evidence-dir>/<story>-smoke-captures/ una captura o una grabación del
#     navegador real, atada a los criterios del humo (`--acs`). Su sha256 va en el registro (`capture_sha`, junto a la
#     ruta `capture`) y en el espejo: la matriz sólo la cuenta si la imagen sigue siendo la que se selló al correr.
#     La imagen se saca ANTES (el E2E, o Playwright suelto) y se pasa acá; un archivo que no existe o que no es png ni
#     webm hace fallar el humo sin correr el comando. Siempre del sitio de laboratorio, nunca con datos de un cliente.
#
# Uso:
#   smoke-run.sh <evidence-dir> <ruta-de-la-story.md | story-id> --acs 8,9 \
#     --pass-if '<qué tiene que pasar>' [--fail-if '<qué lo da por malo>'] [--capture <archivo.png|.webm>] \
#     -- <comando...>
#   (con la ruta, la clave del registro la calcula lib/evidence-key.js — story 1.17)
# Ejemplo:
#   smoke-run.sh .../.advisors/dod-runtime 10.4 --acs 9 \
#     --pass-if 'responde 201 y el artículo aparece en el pedido 42' -- \
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
PASA_SI=""; PASA_SI_SET=0
FALLA_SI=""; FALLA_SI_SET=0
CAPTURE=""; CAPTURE_SET=0
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
    # Story 1.19: la expectativa, escrita antes de correr. Texto libre: no la evalúa este envoltorio (para eso
    # están `curl -f` / `jq -e` dentro del comando); la lee el revisor de cierre contra la salida guardada
    # (DODRT-W4). Vacía, sólo blancos, o con `--` como «valor» → exit 2 sin correr nada.
    # La imagen del navegador real que prueba un criterio de pantalla. Sin valor, o con `--` como «valor» → exit 2.
    --capture)
      if [ $# -lt 2 ] || [ "$2" = "--" ]; then
        echo "smoke-run.sh: --capture necesita la ruta de una captura (.png) o de una grabación (.webm) del navegador (ej: --capture pantalla.png)" >&2
        exit 2
      fi
      CAPTURE="$2"; CAPTURE_SET=1; shift 2 ;;
    --pass-if|--fail-if)
      if [ $# -lt 2 ] || [ "$2" = "--" ] || [ -z "$(printf '%s' "$2" | tr -d '[:space:]')" ]; then
        echo "smoke-run.sh: $1 necesita un texto: qué tiene que pasar para dar el humo por bueno (ej: $1 'responde 201 con el id del pedido')" >&2
        exit 2
      fi
      if [ "$1" = "--pass-if" ]; then PASA_SI="$2"; PASA_SI_SET=1; else FALLA_SI="$2"; FALLA_SI_SET=1; fi
      shift 2 ;;
    *) break ;;
  esac
done
if [ "${1:-}" != "--" ]; then
  echo "smoke-run.sh: falta el separador -- antes del comando" >&2
  exit 2
fi
shift
# Decisión del dueño (2026-10-15, duda 2): obligatorio desde la publicación para todo humo con criterios. Un humo
# que dice cubrir un AC sin decir qué esperaba es el que convierte «verificado corriendo» en «terminó con 0».
if [ -n "$ACS" ] && [ "$PASA_SI_SET" != 1 ]; then
  echo "smoke-run.sh: un humo con --acs tiene que decir antes de correr qué tiene que pasar — no se corre." >&2
  echo "  forma: smoke-run.sh <evidence-dir> <story> --acs $ACS --pass-if '<qué tiene que pasar>' [--fail-if '<…>'] -- <comando…>" >&2
  echo "  (sembrar las precondiciones de un AC va sin --acs)" >&2
  exit 2
fi

# ── La imagen, validada ANTES de correr ──
# Un archivo que no sirve de prueba no se descubre después de correr un comando que puede haber escrito: el humo falla acá
# y no corre nada. lib/capture-file.js mira la extensión (png o webm), que exista, que no sea un enlace simbólico, que no
# pase de 50 MB y que sus primeros bytes sean los del formato. La huella se calcula al copiarlo, después del comando.
CAPTURE_EXT=""
CAPTURE_JS="$(cd "$(dirname "$0")" && pwd)/lib/capture-file.js"
if [ "$CAPTURE_SET" = 1 ]; then
  CAPTURE_EXT="$(printf '%s' "${CAPTURE##*.}" | tr 'A-Z' 'a-z')"
  case "$CAPTURE_EXT" in
    png|webm) ;;
    *)
      echo "smoke-run.sh: --capture sólo acepta una captura .png o una grabación .webm del navegador (recibí: $CAPTURE) — no se corre el humo." >&2
      exit 2 ;;
  esac
  if [ ! -f "$CAPTURE" ] && [ ! -L "$CAPTURE" ]; then
    echo "smoke-run.sh: --capture: el archivo no existe: $CAPTURE — no se corre el humo. Sacá la imagen (.png o .webm) antes, con el E2E o con Playwright, y pasala acá." >&2
    exit 2
  fi
  if ! CAPTURE_PROBLEM="$(node "$CAPTURE_JS" check "$CAPTURE" png,webm)"; then
    echo "smoke-run.sh: --capture: $CAPTURE no sirve como captura (.png) ni como grabación (.webm): ${CAPTURE_PROBLEM:-no se pudo revisar} — no se corre el humo." >&2
    exit 2
  fi
  if [ -z "$ACS" ]; then
    echo "[smoke-run] ⚠️ --capture sin --acs: la imagen no queda atada a ningún criterio y no cuenta para ninguno." >&2
  fi
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── La salida, guardada sin perder el código de salida (story 1.19) ──
# Va a un temporal FUERA del repo (`mktemp` en $TMPDIR) y se borra siempre, también si el humo muere a mitad: la
# salida sin tapar no puede quedar en `.advisors/`, que viaja por git. Un TERM/INT/HUP sale por `exit`, y eso dispara
# el trap de EXIT.
# La copia la hace un `tee` en una sustitución de proceso (`> >(…)`), no en una tubería. Lo encontró el pase
# adversarial de la 1.19 (2026-10-15): con `"$@" | tee`, bash espera a que se cierre la salida y no al comando, y un humo
# que deja un proceso de fondo con la salida abierta (arrancar la app para sembrar el «Given») colgaba el envoltorio;
# con un servidor, para siempre.
# 🔴 El código de salida es el del COMANDO (`$?`, sin tubería de por medio). Con `| tee` y sin `pipefail` sería el de
# `tee`, y un humo rojo quedaría registrado con exit 0: el mismo bug que test-gate.sh ya evita con su `tee`.
# Cómo terminó la copia lo deja `tee` en `<temporal>.rc`, y se lo espera hasta 5 s después del comando. Si no terminó,
# un proceso de fondo tiene la salida abierta: se guarda lo que salió hasta ahí, con aviso. Si terminó mal (disco lleno,
# o `smoke-run.sh … | head` que corta la tubería), la copia está incompleta: queda output: null y la matriz no lo cuenta.
# El precio: la salida de error va mezclada con la normal y el comando deja de ver una terminal (sin colores ni
# barras de progreso).
SALIDA_TMP="$(mktemp "${TMPDIR:-/tmp}/smoke-run.XXXXXX" 2>/dev/null)" || SALIDA_TMP=""
GUARDAR_SALIDA=0
trap '[ -n "$SALIDA_TMP" ] && rm -f "$SALIDA_TMP" "$SALIDA_TMP.rc"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
if [ -n "$SALIDA_TMP" ]; then
  # La salida de error del propio `tee` va a /dev/null: si no, mientras un proceso de fondo lo mantiene vivo, también
  # mantiene abierta la salida de error de quien llamó a smoke-run.sh (su error queda igual en `.rc`).
  # El `.rc` se escribe sólo si el temporal sigue ahí: con un proceso de fondo, `tee` termina después de que el trap
  # ya borró los dos, y escribirlo igual dejaba un archivo suelto en $TMPDIR.
  "$@" > >(exec sh -c 'tee "$1"; rc=$?; [ -e "$1" ] && echo "$rc" > "$2"' smoke-run-tee "$SALIDA_TMP" "$SALIDA_TMP.rc" 2>/dev/null) 2>&1
  EXIT=$?
  ESPERA=0
  while [ ! -s "$SALIDA_TMP.rc" ] && [ "$ESPERA" -lt 50 ]; do sleep 0.1; ESPERA=$((ESPERA + 1)); done
  if [ ! -s "$SALIDA_TMP.rc" ]; then
    echo "[smoke-run] ⚠️ un proceso de fondo del comando sigue con la salida abierta: se guarda lo que salió hasta ahora. Redirigí su salida (… > app.log 2>&1 &) para guardarla entera." >&2
    # La marca va DENTRO de la salida guardada, y por eso dentro de su sello: quien la lea (el revisor de cierre)
    # sabe que no está entera. Un aviso sólo por stderr no quedaba en ningún lado.
    printf '\n[… la salida siguió después de guardarla: un proceso de fondo la mantenía abierta …]\n' >> "$SALIDA_TMP"
    GUARDAR_SALIDA=1
  elif [ "$(cat "$SALIDA_TMP.rc")" = 0 ]; then
    GUARDAR_SALIDA=1
  else
    echo "[smoke-run] ⚠️ la copia de la salida se cortó (tee salió con $(cat "$SALIDA_TMP.rc")): el humo queda con output: null y la matriz no lo cuenta." >&2
  fi
else
  echo "[smoke-run] ⚠️ no pude crear un temporal para la salida: el humo corre igual y queda con output: null (la matriz no lo cuenta)." >&2
  "$@"
  EXIT=$?
fi

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

mkdir -p "$EVIDENCE_DIR"

# ── La expectativa y la salida (story 1.19), por el MISMO tapado que el comando ──
# `ledger-extras` tapa `--pass-if`/`--fail-if`, recorta (≤ 8 KB) y tapa la salida, la escribe en
# <story>-smoke-outputs/ y devuelve dos fragmentos: el de la línea del registro y el del espejo (los sha256).
# Si el tapado no puede correr, no se escribe NINGUNO de los tres: queda un aviso, como con `cmd`, y la línea
# sale con output: null — desde la 1.19, una línea `"v":2` sin salida no cuenta (cambio declarado de la story).
EXTRA_ARGS=()
[ "$PASA_SI_SET" = 1 ] && EXTRA_ARGS+=(--pass-if "$PASA_SI")
[ "$FALLA_SI_SET" = 1 ] && EXTRA_ARGS+=(--fail-if "$FALLA_SI")
[ -n "$SALIDA_TMP" ] && [ "$GUARDAR_SALIDA" = 1 ] && EXTRA_ARGS+=(--output-tmp "$SALIDA_TMP" --evidence-dir "$EVIDENCE_DIR" --key "$STORY_ID" --ts "$TS")
# `${arr[@]+…}`: bash 3.2 (el de macOS) da «unbound variable» con un arreglo vacío bajo `set -u`.
if EXTRAS="$(node "$SECRETS_JS" ledger-extras ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"})" && [ -n "$EXTRAS" ]; then
  LEDGER_EXTRA="$(printf '%s\n' "$EXTRAS" | sed -n 1p)"
  MIRROR_EXTRA="$(printf '%s\n' "$EXTRAS" | sed -n 2p)"
else
  LEDGER_EXTRA=''
  [ "$PASA_SI_SET" = 1 ] && LEDGER_EXTRA="$LEDGER_EXTRA"',"pass_if":"[expectativa no registrada: no se pudo tapar]"'
  [ "$FALLA_SI_SET" = 1 ] && LEDGER_EXTRA="$LEDGER_EXTRA"',"fail_if":"[expectativa no registrada: no se pudo tapar]"'
  LEDGER_EXTRA="$LEDGER_EXTRA"',"output":null,"output_sha":null'
  MIRROR_EXTRA=''
  echo "[smoke-run] ⚠️ no se pudo correr el tapado de secretos ($SECRETS_JS): ni la expectativa ni la salida se escriben en la evidencia." >&2
fi

# ── La imagen, copiada a la evidencia con su huella ──
# Después del comando: si el humo la produce o la rehace, queda la de ahora. Se vuelve a revisar al copiar (el comando
# pudo borrarla o cambiarla por un enlace). La huella es la de la COPIA que viaja con el repo; la misma va al espejo
# (fuera del repo), que es contra lo que la matriz la verifica. Si no se puede copiar, el humo sigue (el comando ya corrió
# y su código de salida manda) pero el registro anota `capture_error` con el motivo y la matriz lo dice en el criterio.
if [ "$CAPTURE_SET" = 1 ]; then
  CAP_OUT="$(node "$CAPTURE_JS" copy "$CAPTURE" png,webm "$EVIDENCE_DIR" "$STORY_ID" "$TS")"
  case "$CAP_OUT" in
    "OK "*)
      CAP_REST="${CAP_OUT#OK }"
      LEDGER_EXTRA="$LEDGER_EXTRA"',"capture":"'"${CAP_REST%% *}"'","capture_sha":"'"${CAP_REST##* }"'"'
      MIRROR_EXTRA="$MIRROR_EXTRA"',"capture_sha":"'"${CAP_REST##* }"'"' ;;
    *)
      CAP_MOTIVO='"no se pudo guardar la imagen"'
      case "$CAP_OUT" in "ERR "*) CAP_MOTIVO="${CAP_OUT#ERR }" ;; esac
      LEDGER_EXTRA="$LEDGER_EXTRA"',"capture_error":'"$CAP_MOTIVO"
      echo "[smoke-run] ⚠️ no pude guardar la imagen $CAPTURE en la evidencia: el humo queda sin imagen y la matriz no la cuenta." >&2 ;;
  esac
fi

ENTRY=$(printf '{"ts":"%s","story":"%s","acs":%s,"cmd":%s,"exit":%d,"via":"smoke-run.sh"%s,"v":2%s}' \
  "$TS" "$STORY_ID" "$ACS_JSON" "$CMD_JSON" "$EXIT" "$MUT_FIELD" "$LEDGER_EXTRA")

printf '%s\n' "$ENTRY" >> "$EVIDENCE_DIR/$STORY_ID-smoke-ledger.jsonl"

MIRROR_DIR="$HOME/.claude/.tycon-pipeline"
mkdir -p "$MIRROR_DIR"
# repoPath: namespace por repo (GATESLOG-STORYID-NS-1) — el espejo es global por máquina y los ids
# cortos de story se repiten entre repos. El repo es el dueño del evidence-dir (<repo>/.advisors/...);
# si no es un repo git, cae al cwd. Misma key que marker.js para que el capturer agrupe igual.
REPO_PATH="$(git -C "$EVIDENCE_DIR" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPO_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$REPO_PATH")"
printf '{"type":"smoke-run","ts":"%s","repoPath":%s,"story":"%s","acs":%s,"exit":%d%s,"v":2%s}\n' \
  "$TS" "$REPO_JSON" "$STORY_ID" "$ACS_JSON" "$EXIT" "$MUT_FIELD" "$MIRROR_EXTRA" >> "$MIRROR_DIR/gates.log"

echo "[smoke-run] story=$STORY_ID acs=$ACS exit=$EXIT mutates=$MUTATES → ledger + gates.log" >&2
exit $EXIT
