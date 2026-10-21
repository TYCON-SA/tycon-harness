#!/usr/bin/env bash
# Prueba de recompute-zip-notes.sh — el guion que reescribe la nota de cada formulario
# CONTRA EL SERVIDOR en el momento de publicar.
#
# Sin esta prueba, un formulario nuevo podría llegar a producción diciendo "Sin cambios desde el build anterior" con
# trabajo nuevo adentro. Dos defectos lo provocan: que el guion no encuentre a su hermano release-notes.sh (lo diría
# por stderr, saldría 0 y el paso quedaría verde), y que llame al guion unificado SIN `--type form`, o sea que
# pregunte por plugins. Este archivo existe para que ninguno de los dos pueda pasar en silencio.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REC_SRC="$AQUI/scripts/ci/recompute-zip-notes.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ recalcular: $1"; }
no(){ echo "❌ recalcular: $1"; fallos=$((fallos+1)); }

for req in jq unzip zip; do
  command -v "$req" >/dev/null 2>&1 || { echo "⚠️ recalcular: falta $req en esta máquina — suite salteada (no es verde)"; exit 0; }
done

# Un directorio PLANO con los dos guiones, como el artefacto `arnes-ci/` que baja el pipeline.
FLAT="$TMP/arnes-ci"; mkdir -p "$FLAT"
cp "$REC_SRC" "$FLAT/recompute-zip-notes.sh"

# Un release-notes.sh de mentira: anota cómo lo llamaron y contesta lo que le digan por env.
cat > "$FLAT/release-notes.sh" <<'STUB'
#!/usr/bin/env bash
# Deja constancia de si le llegó el ingreso ya hecho: es lo único que distingue
# "un ingreso para todos" de "un ingreso por formulario".
printf 'BZ_TOKEN=%s\n' "${BZ_TOKEN:-<vacio>}" >> "${STUB_TOKEN_LOG:-/dev/null}"
printf '%s\n' "$*" >> "$STUB_LOG"
printf '%s\n' "${STUB_SALIDA:-Cambios desde la versión que está publicada (abc1234):

- feat(stock): algo real}"
exit 0
STUB
chmod +x "$FLAT/release-notes.sh"

zip_con_form(){ # <dir> <formName>
  local d="$1" f="$2"
  mkdir -p "$TMP/mk" && ( cd "$TMP/mk" && jq -nc --arg f "$f" '{forms:[{formName:$f, releaseNotes:"nota del empaquetado"}]}' > manifest.json && zip -q "$d/$f.zip" manifest.json ) && rm -rf "$TMP/mk"
}
nota_en(){ unzip -p "$1" manifest.json | jq -r '.forms[0].releaseNotes'; }

# ---------------------------------------------------------------- 1. encuentra al hermano en la MISMA carpeta
Z1="$TMP/z1"; mkdir -p "$Z1"; zip_con_form "$Z1" "totora-reserva"
export STUB_LOG="$TMP/llamadas.log"; : > "$STUB_LOG"
ERR=$(bash "$FLAT/recompute-zip-notes.sh" "$Z1" http://srv usuario clave 2>&1 >/dev/null); rc=$?
echo "$ERR" | grep "no está" >/dev/null && no "🔴 no encontró release-notes.sh en su misma carpeta (el defecto de la v1.0.62)" || ok "encuentra release-notes.sh en la misma carpeta (layout plano del artefacto)"
[ "$rc" -eq 0 ] && ok "sale 0 cuando todas las notas salieron contra el servidor" || no "salió $rc con todo bien (stderr: $ERR)"

# ---------------------------------------------------------------- 2. lo llama como FORMULARIO y desde el servidor
L=$(cat "$STUB_LOG")
echo "$L" | grep -- '^--type form --from-server http://srv usuario clave totora-reserva totora-reserva/src totora-reserva/package.json$' >/dev/null \
  && ok "invoca --type form --from-server con el nombre y los paths del formulario" \
  || no "🔴 la invocación no es la esperada: '$L' (sin --type form pregunta por PLUGINS)"

# ---------------------------------------------------------------- 3. reescribe la nota dentro del ZIP
N=$(nota_en "$Z1/totora-reserva.zip")
echo "$N" | grep "feat(stock): algo real" >/dev/null && ok "la nota nueva quedó dentro del manifest del ZIP" || no "el ZIP sigue con la nota vieja: '$N'"

# ---------------------------------------------------------------- 4. sin el hermano → 3, y lo dice
FLAT2="$TMP/solo"; mkdir -p "$FLAT2"; cp "$REC_SRC" "$FLAT2/recompute-zip-notes.sh"
Z2="$TMP/z2"; mkdir -p "$Z2"; zip_con_form "$Z2" "f"
ERR=$(bash "$FLAT2/recompute-zip-notes.sh" "$Z2" http://srv u p 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 3 ] && ok "sin release-notes.sh sale 3 (antes: 0 y paso verde)" || no "🔴 sin release-notes.sh salió $rc"
echo "$ERR" | grep "no está" >/dev/null && ok "…y dice qué falta" || no "no dijo qué falta: '$ERR'"
[ "$(nota_en "$Z2/f.zip")" = "nota del empaquetado" ] && ok "…y el ZIP conserva la nota que traía" || no "tocó el ZIP sin poder calcular"

# ---------------------------------------------------------------- 5. sin credenciales → 3
ERR=$(bash "$FLAT/recompute-zip-notes.sh" "$Z1" "" "" "" 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 3 ] && ok "sin credenciales sale 3" || no "sin credenciales salió $rc"

# ---------------------------------------------------------------- 6. el servidor no contestó → la nota se escribe igual, pero sale 3
Z3="$TMP/z3"; mkdir -p "$Z3"; zip_con_form "$Z3" "g"
ERR=$(STUB_SALIDA='Sin cambios desde el build anterior (9f21d3d3) — esta versión sólo trae cambios internos del repositorio.' \
  bash "$FLAT/recompute-zip-notes.sh" "$Z3" http://srv u p 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 3 ] && ok "nota calculada contra el build anterior → sale 3 (no se disfraza de verde)" || no "🔴 nota degradada y salió $rc — es EXACTAMENTE la v1.0.62"
echo "$ERR" | grep "build anterior" >/dev/null && ok "…y explica que fue contra el build anterior" || no "no explicó la degradación: '$ERR'"
nota_en "$Z3/g.zip" | grep "build anterior" >/dev/null && ok "…pero la nota igual se escribió (mejor que nada)" || no "no escribió la nota degradada"

# ---------------------------------------------------------------- 7. dos formularios: cada uno con su nombre, con pausa entre medio
Z4="$TMP/z4"; mkdir -p "$Z4"; zip_con_form "$Z4" "a-form"; zip_con_form "$Z4" "b-form"
: > "$STUB_LOG"
bash "$FLAT/recompute-zip-notes.sh" "$Z4" http://srv u p >/dev/null 2>&1
grep -c -- ' a-form a-form/src' "$STUB_LOG" | grep -x 1 >/dev/null && grep -c -- ' b-form b-form/src' "$STUB_LOG" | grep -x 1 >/dev/null \
  && ok "con dos ZIPs pregunta por cada formulario por su nombre del manifest" || no "no preguntó por cada formulario: $(cat "$STUB_LOG")"

# ---------------------------------------------------------------- 8. UN SOLO INGRESO para todos
# 🔴 El guion entra al host UNA sola vez y pasa el ingreso a todos. Si dejara que CADA formulario entrara por su
# cuenta, con 4 formularios no se notaría; con 8 haría falta una pausa entre uno y otro; con 34 el host corta por
# límite de velocidad y las 34 notas salen calculadas contra el build anterior.
STUBC="$TMP/stubc"; mkdir -p "$STUBC"
cat > "$STUBC/curl" <<'CURL'
#!/usr/bin/env bash
url=""; hdr=""; out=""; cuerpo=""
while [ $# -gt 0 ]; do case "$1" in -D) hdr="$2"; shift;; -o) out="$2"; shift;; --data-raw|--data|-d|--data-binary) cuerpo="$2"; shift;; http*) url="$1";; esac; shift; done
echo "$url" >> "$CURL_LOG"
[ -n "$cuerpo" ] && printf '%s\n' "$cuerpo" >> "${CURL_BODY_LOG:-/dev/null}"
if echo "$url" | grep '/api/auth/login' >/dev/null; then
  if [ -n "${CURL_LOGIN_FALLA:-}" ]; then printf '000'; exit 7; fi
  printf 'HTTP/1.1 200 OK\r\nSet-Cookie: admin_token=tokUNICO; Path=/\r\n\r\n' > "$hdr"; echo '{}' > "$out"; printf '200'; exit 0
fi
exit 1
CURL
chmod +x "$STUBC/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUBC/sleep"; chmod +x "$STUBC/sleep"

Z5="$TMP/z5"; mkdir -p "$Z5"
for f in uno dos tres cuatro; do zip_con_form "$Z5" "form-$f"; done
: > "$STUB_LOG"; export CURL_LOG="$TMP/curl5.log"; : > "$CURL_LOG"
export CURL_BODY_LOG="$TMP/body5.log"; : > "$CURL_BODY_LOG"; STUB_BODY="$CURL_BODY_LOG"
export STUB_TOKEN_LOG="$TMP/tok5.log"; : > "$STUB_TOKEN_LOG"
PATH="$STUBC:$PATH" bash "$FLAT/recompute-zip-notes.sh" "$Z5" http://srv u p >/dev/null 2>&1

ingresos=$(grep -c '/api/auth/login' "$CURL_LOG")
formularios=$(grep -c -- '--type form' "$STUB_LOG")
[ "$ingresos" -eq 1 ] \
  && ok "4 formularios → UN solo ingreso al servidor (antes: uno por formulario)" \
  || no "🔴 abrió $ingresos ingreso(s) para $formularios formulario(s) — con 34 el host corta por límite"
[ "$formularios" -eq 4 ] \
  && ok "…y sí consultó por los 4 (el ahorro es de ingresos, no de consultas)" \
  || no "🔴 consultó $formularios de 4 formularios"
[ "$(grep -c 'BZ_TOKEN=tokUNICO' "$STUB_TOKEN_LOG")" -eq 4 ] \
  && ok "…y los 4 recibieron el MISMO ingreso ya hecho" \
  || no "🔴 el ingreso no les llegó a todos: $(sort -u "$STUB_TOKEN_LOG" | tr '\n' ' ')"

# 🔴 El CUERPO del ingreso tiene que ser el JSON, no el nombre de un archivo.
# Si se mandara `--data-raw "@/tmp/xxx"`, `--data-raw` NO leería el archivo: mandaría la cadena literal. El host
# contestaría 500, el guion caería al camino de un ingreso por formulario y el límite de velocidad se agotaría. El
# caso 8 pasaría igual, porque el servidor simulado acepta cualquier cosa: un "un solo ingreso" que manda basura no
# sirve de nada.
CUERPO=$(cat "$STUB_BODY" 2>/dev/null | head -1)
echo "$CUERPO" | grep '^@' >/dev/null && no "🔴 el cuerpo del ingreso es una RUTA, no el JSON: $CUERPO" \
  || ok "el cuerpo del ingreso NO es una ruta de archivo"
echo "$CUERPO" | jq -e '.username == "u" and .tenant_id == "default"' >/dev/null 2>&1 \
  && ok "…es JSON válido y trae el usuario (el host lo va a entender)" \
  || no "🔴 el cuerpo del ingreso no es el JSON esperado: $CUERPO"

# ---------------------------------------------------------------- 9. si el ingreso único falla, NO bloquea
# El ingreso único es una MEJORA, no el camino obligatorio: si no entra, cada formulario entra por
# su cuenta, y ese camino ya reintenta solo. Reintentar también acá sumaría 90
# segundos de espera antes de caer al camino que igual va a reintentar.
: > "$STUB_LOG"; : > "$CURL_LOG"; : > "$STUB_TOKEN_LOG"
INICIO=$(date +%s)
CURL_LOGIN_FALLA=1 PATH="$STUBC:$PATH" bash "$FLAT/recompute-zip-notes.sh" "$Z5" http://srv u p >/dev/null 2>"$TMP/err9.txt"
TARDO=$(( $(date +%s) - INICIO ))
[ "$(grep -c '/api/auth/login' "$CURL_LOG")" -eq 1 ] \
  && ok "si el ingreso único no entra, NO reintenta (un solo intento)" \
  || no "🔴 reintentó $(grep -c '/api/auth/login' "$CURL_LOG") veces antes de caer al camino de siempre"
[ "$TARDO" -lt 20 ] \
  && ok "…y cae al camino de siempre sin hacer esperar (${TARDO}s)" \
  || no "🔴 tardó ${TARDO}s en caer al camino de siempre — es latencia pura"
[ "$(grep -c 'BZ_TOKEN=<vacio>' "$STUB_TOKEN_LOG")" -eq 4 ] \
  && ok "…y los formularios entran por su cuenta, como antes del cambio" \
  || no "🔴 quedó un ingreso a medias: $(sort -u "$STUB_TOKEN_LOG" | tr '\n' ' ')"
grep -q "ingreso único" "$TMP/err9.txt" \
  && ok "…y lo dice por stderr en vez de degradar en silencio" \
  || no "no avisó que no pudo abrir el ingreso único"

echo
if [ "$fallos" -eq 0 ]; then echo "recompute-zip-notes: todo verde"; exit 0; else echo "recompute-zip-notes: $fallos fallo(s)"; exit 1; fi
