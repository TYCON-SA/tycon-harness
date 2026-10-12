#!/usr/bin/env bash
# Prueba de smoke-plugin.sh y smoke-forms.sh — los únicos guiones del circuito que tocan el paquete
# INSTALADO. Sin red: un `curl` de mentira en PATH contesta según lo que el caso pide, y `sleep`
# no espera. Lo que se prueba: que aprueban SÓLO cuando el host dice lo que este run dijo, y que
# cualquier "no pude mirar" (login caído, JSON ilegible, manifest roto, directorio vacío) es 1.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HP="$AQUI/scripts/ci/smoke-plugin.sh"; HF="$AQUI/scripts/ci/smoke-forms.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; ok(){ echo "✅ humo: $1"; }; no(){ echo "❌ humo: $1"; fallos=$((fallos+1)); }
for req in jq unzip zip; do command -v "$req" >/dev/null || { echo "⚠️ humo: falta $req — suite salteada (no es verde)"; exit 0; }; done

STUB="$TMP/stub"; mkdir -p "$STUB"; export STUB_DIR="$TMP"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/sleep"; chmod +x "$STUB/sleep"
# El curl falso lee de $STUB_DIR: login.code (default 200), plugins.json, forms.json, code.http (default "200 1234")
cat > "$STUB/curl" <<'STUB'
#!/usr/bin/env bash
url=""; hdr=""; out=""; fmt=""
while [ $# -gt 0 ]; do case "$1" in -D) hdr="$2"; shift;; -o) out="$2"; shift;; -w) fmt="$2"; shift;; http*) url="$1";; esac; shift; done
# SEC-C1: cada URL pedida queda anotada — las pruebas de nombres exigen que un nombre malo NO llegue a ninguna
printf '%s\n' "${url//$'\n'/\\n}" >> "$STUB_DIR/urls.log"
if echo "$url" | grep -q '/api/auth/login'; then
  code=$(cat "$STUB_DIR/login.code" 2>/dev/null || echo 200)
  # "limite:N" = los primeros N logins devuelven 401 {"error":"Too Many Requests"}, después 200
  if echo "$code" | grep -q '^limite:'; then n=$(grep -c '/api/auth/login' "$STUB_DIR/login.log" 2>/dev/null || echo 0); echo "$url" >> "$STUB_DIR/login.log"; if [ "$n" -lt "${code#limite:}" ]; then echo '{"error":"Too Many Requests"}' > "$out"; printf '401'; exit 0; fi; code=200; fi
  [ "$code" = "401" ] && { cat "$STUB_DIR/login.body" 2>/dev/null || echo '{"error":"Invalid credentials"}'; } > "$out"
  [ "$code" = "200" ] && { printf 'HTTP/1.1 200 OK\r\nSet-Cookie: admin_token=tok; Path=/\r\n\r\n' > "$hdr"; echo '{}' > "$out"; }
  printf '%s' "$code"; [ "$code" = "000" ] && exit 7; exit 0
fi
if echo "$url" | grep -q '^http[^ ]*/api/plugins/[^/]*/health$'; then
  cuerpo=$(cat "$STUB_DIR/pluginhealth.json" 2>/dev/null || echo '{}')
  code=$(cat "$STUB_DIR/pluginhealth.code" 2>/dev/null || echo 200)
  # el guion pregunta este /health pidiendo el código con -w: cuerpo y código, como hace curl
  if [ -n "$fmt" ]; then printf '%s\n%s' "$cuerpo" "$code"; else printf '%s' "$cuerpo"; fi
  exit 0
fi
if echo "$url" | grep -q '/health$'; then
  code=$(cat "$STUB_DIR/health.code" 2>/dev/null || echo 200)
  cuerpo=$(cat "$STUB_DIR/health.json" 2>/dev/null || echo '{}')
  [ -n "$fmt" ] && { printf '%s\n%s' "$cuerpo" "$code"; exit 0; }
  printf '%s' "$cuerpo"; exit 0
fi
if echo "$url" | grep -q '/api/admin/plugins/loaded'; then cat "$STUB_DIR/loaded.json" 2>/dev/null || cat "$STUB_DIR/plugins.json"; exit 0; fi
if echo "$url" | grep -q '/api/admin/plugins'; then cat "$STUB_DIR/plugins.json"; exit 0; fi
if echo "$url" | grep -q '/code$'; then printf '%s' "$(cat "$STUB_DIR/code.http" 2>/dev/null || echo '200 1234')"; exit 0; fi
# story 2.10: /api/custom-forms/<f>/versions contesta versions-<f>.json con versions-<f>.code (default 200)
if echo "$url" | grep -q '/api/custom-forms/[^/]*/versions$'; then
  f=$(echo "$url" | sed 's#.*/api/custom-forms/\([^/]*\)/versions$#\1#')
  cuerpo=$(cat "$STUB_DIR/versions-$f.json" 2>/dev/null || echo '[]'); code=$(cat "$STUB_DIR/versions-$f.code" 2>/dev/null || echo 200)
  echo "$url" >> "$STUB_DIR/versions.log"
  if [ -n "$fmt" ]; then printf '%s\n%s' "$cuerpo" "$code"; else printf '%s' "$cuerpo"; fi
  exit 0
fi
if echo "$url" | grep -q '/api/custom-forms'; then cat "$STUB_DIR/forms.json"; exit 0; fi
exit 1
STUB
chmod +x "$STUB/curl"; export PATH="$STUB:$PATH"
run_hp(){ bash "$HP" http://stub u p totorabackend "$1" ${2:+"$2"} >"$TMP/out" 2>"$TMP/err"; }
run_hf(){ bash "$HF" http://stub u p "$1" >"$TMP/out" 2>"$TMP/err"; }

# ── plugin
echo 200 > "$TMP/login.code"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true},{"name":"totorabackend","version":"1.0.213","isActive":true,"isDefault":false},{"name":"otro","version":"9.9.9","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
run_hp 1.0.214 && ok "plugin: versión exacta + activo + default → 0" || no "plugin: el caso bueno salió $?"
run_hp 1.0.213 && no "🔴 plugin: aprobó la versión que NO es default (1.0.213 está cargada pero no activa como default)" || ok "plugin: una versión cargada pero no default NO aprueba"
run_hp 1.0.999 && no "🔴 plugin: aprobó una versión que el host no tiene" || ok "plugin: versión ausente → 1"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":false,"isDefault":true}]' > "$TMP/plugins.json"
run_hp 1.0.214 && no "🔴 plugin: aprobó un plugin inactivo" || ok "plugin: inactivo → 1"
echo 'esto no es json' > "$TMP/plugins.json"
run_hp 1.0.214 && no "🔴 plugin: respuesta ilegible salió verde" || ok "plugin: respuesta ilegible → 1 (no pude mirar ≠ aprobado)"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"; echo 000 > "$TMP/login.code"
run_hp 1.0.214 && no "🔴 plugin: sin poder entrar al host salió verde" || ok "plugin: login caído (4 intentos) → 1"
grep -q "intento 1" "$TMP/err" && ok "plugin: …y avisó los reintentos" || no "plugin: no avisó los reintentos"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
echo 'limite:2' > "$TMP/login.code"; : > "$TMP/login.log"
run_hp 1.0.214 && ok "plugin: 401 'Too Many Requests' (límite del host) se reintenta y entra a la 3ª" || no "🔴 plugin: el límite del host disfrazado de 401 lo dejó en rojo ($(tail -1 "$TMP/err"))"
echo 401 > "$TMP/login.code"
run_hp 1.0.214 && no "🔴 plugin: aprobó con clave mala" || ok "plugin: 401 de clave mala → 1, sin reintentar"
grep -q "intento 1" "$TMP/err" && no "plugin: reintentó un 401 de clave mala" || ok "plugin: …y no reintentó"
grep -qi "invalid credentials" "$TMP/err" && ok "plugin: …y muestra el cuerpo del 401 (para no volver a adivinar)" || no "plugin: no mostró el cuerpo del 401"

# ── 🔴 lo MARCADO no es lo CARGADO (2026-09-02) ───────────────────────────────────────────────
# `isActive` la pone el host en verdadero para TODA versión subida, cargada o no: en todo su
# código no hay un solo lugar que la ponga en falso. Mirarla sola aprueba un plugin que no está
# corriendo. Es el incidente del 2026-08-15 en un producto del equipo y el estado por el que se rechazaron dos
# versiones del plan de cierre: anotar sin cargar.
echo 200 > "$TMP/login.code"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
echo '[{"name":"totorabackend","version":"1.0.213"}]' > "$TMP/loaded.json"
run_hp 1.0.214 && no "🔴 plugin: aprobó con la versión MARCADA correcta y otra CARGADA — el host sirve la vieja" || ok "🔴 plugin: marcada v1.0.214 pero cargada v1.0.213 → 1"
grep -q "CARGADA" "$TMP/out" "$TMP/err" 2>/dev/null && ok "…y lo dice: nombra la versión que está cargada" || no "no explicó que la cargada es otra"

echo '[]' > "$TMP/loaded.json"
run_hp 1.0.214 && no "🔴 plugin: aprobó sin NINGUNA versión cargada" || ok "🔴 plugin: ninguna versión cargada → 1 (el estado tras un reinicio sin marca)"

echo '[{"name":"totorabackend","version":"1.0.214"}]' > "$TMP/loaded.json"
run_hp 1.0.214 && ok "plugin: marcada y cargada coinciden → 0" || no "el caso bueno con /loaded salió $?"

rm -f "$TMP/loaded.json"

# ── 🔴 "SANO" HAY QUE PREGUNTARLO (2026-09-03) ────────────────────────────────────────────────
# El humo imprimía "cargado, activo, default y sano" sin haber preguntado NUNCA por el modo
# degradado: el host puede cargar el plugin con sus servicios internos caídos, devolver 200 y
# guardar el motivo en vez de fallar. El comentario del código prometía la pregunta; el código no
# la hacía. Tres casos: degradado → rojo · no se pudo leer → rojo · el host no lo expone → verde
# pero DICIÉNDOLO, nunca "sano".
echo 200 > "$TMP/login.code"
echo '[{"pluginId":7,"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
rm -f "$TMP/loaded.json"; echo 200 > "$TMP/health.code"; echo '{}' > "$TMP/health.json"
run_hp 1.0.214 && ok "plugin: con /health sano, aprueba" || no "🔴 plugin: /health sano quedó en rojo ($(tail -1 "$TMP/err"))"
grep -q "y sano" "$TMP/out" && ok "…y recién ahí dice 'sano', porque lo preguntó" || no "no dijo sano habiéndolo medido"

echo '{"errorMessage":"el worker de notificaciones no arrancó"}' > "$TMP/health.json"
run_hp 1.0.214 && no "🔴 plugin: un plugin DEGRADADO salió verde — es el 'verde que significa no miré nada'" || ok "plugin: cargado pero degradado → 1"
grep -q "worker de notificaciones" "$TMP/out" "$TMP/err" && ok "…y dice el motivo que dio el host" || no "no mostró el motivo de la degradación"

echo '{}' > "$TMP/health.json"; echo 500 > "$TMP/health.code"
run_hp 1.0.214 && no "🔴 plugin: no pudo leer la salud (HTTP 500) y aprobó igual" || ok "plugin: salud ilegible (500) → 1 (no pude mirar ≠ aprobado)"

# 🔴 Un 200 con cuerpo ilegible hacia que jq no encontrara el campo y se imprimiera "sano" sin haber
# leido nada — la misma mentira que este bloque vino a cerrar.
echo 200 > "$TMP/health.code"; echo '<html>502</html>' > "$TMP/health.json"
run_hp 1.0.214 && no "🔴 salud ilegible con 200: dijo que estaba sano sin poder leerla" || ok "🔴 salud ilegible con 200 → 1 (no dice sano sin haber leido)"
echo '{}' > "$TMP/health.json"

echo 404 > "$TMP/health.code"
run_hp 1.0.214 && ok "plugin: si el host no expone /health, no frena (la capacidad no está)" || no "🔴 plugin: un 404 de /health frenó el despliegue en hosts que no lo tienen"
grep -q "no medido" "$TMP/out" && ok "…pero NO dice 'sano': dice que no lo pudo medir" || no "🔴 plugin: con /health ausente igual imprimió 'sano' — es la mentira que este caso existe para cazar"
echo 200 > "$TMP/health.code"

# ── 🔴 el IDENTIFICADOR DE COMPILACIÓN: la versión sola no dice que sea ESTE build ────────────
# (2026-09-03) Dos versiones distintas del mismo número existen: se re-empaqueta y se vuelve a subir
# sin tocar el número. Comparar sólo la versión deja pasar eso, igual que en el humo de formularios.
# Un producto del equipo lo verificaba con un paso propio que leía commitHash de /health; al pasar ese producto al guion
# compartido ese paso se iba y la cobertura se perdía. Sube al guion, así lo tienen los CINCO.
# 🔴 Si el host no devuelve el identificador, AVISA y no frena: los otros cuatro plugins todavía
# pueden no reportarlo (Ceibo recién lo arregló hoy). Se mide y después se aprieta, como el peso.
echo '{"status":"healthy","version":"1.0.214","commitHash":"abc1234def"}' > "$TMP/pluginhealth.json"
run_hp 1.0.214 abc1234 && ok "🔴 identificador de compilación que coincide → 0" || no "🔴 el hash correcto salió $? ($(cat "$TMP/err"))"
run_hp 1.0.214 9999999 && no "🔴 aprobó con OTRO identificador de compilación — dos builds del mismo número pasan igual" || ok "🔴 identificador distinto → 1 (no es este build)"
grep -q "9999999" "$TMP/out" "$TMP/err" && grep -q "abc1234" "$TMP/out" "$TMP/err" && ok "…y dice cuál esperaba y cuál encontró" || no "no dijo los identificadores"
echo '{"status":"healthy","version":"1.0.214"}' > "$TMP/pluginhealth.json"
run_hp 1.0.214 abc1234 && ok "…y si el host contesta 200 sin identificador, AVISA y no frena (los otros plugins todavía no lo reportan)" || no "🔴 frenó a un host que contesta 200 sin identificador ($?)"

# 🔴 PERO LAS RUTAS PROPIAS DEL PLUGIN TIENEN QUE CONTESTAR (2026-09-03, revisión adversarial).
# El paso que se eliminó de ese producto exigía HTTP 200 en /api/plugins/<n>/health con 6 reintentos: un
# 404 —o el HTML del proxy— era rojo. Al mudar la comprobación al guion compartido quedó una sola
# llamada sin mirar el código, así que un 404 salía VERDE con un aviso: los frenos duros que quedan
# miran la API de ADMINISTRACIÓN, no las rutas del plugin. Eso es un agujero distinto del hash.
echo 404 > "$TMP/pluginhealth.code"
run_hp 1.0.214 abc1234 && no "🔴 las rutas propias del plugin dan 404 y el humo aprobó — el plugin no está sirviendo" || ok "🔴 rutas del plugin en 404 → 1 (no alcanza con que la API de administración lo vea)"
echo 500 > "$TMP/pluginhealth.code"
run_hp 1.0.214 abc1234 && no "🔴 aprobó con las rutas del plugin en 500" || ok "…y en 500 también"
rm -f "$TMP/pluginhealth.code"
run_hp 1.0.214 abc1234 && ok "…y si el host no devuelve identificador, AVISA y no frena" || no "🔴 frenó a un host que no reporta el identificador ($?)"
rm -f "$TMP/pluginhealth.json"

# ── forms: 2 ZIPs con manifest
echo 200 > "$TMP/login.code"; Z="$TMP/zips"; mkdir -p "$Z"
mk(){ ( cd "$TMP" && jq -nc --arg f "$1" --arg v "$2" '{forms:[{formName:$f,version:$v}]}' > manifest.json && zip -q "$Z/$1.zip" manifest.json && rm manifest.json ); }
mk totora-catalogo 1.0.73; mk totora-reserva 1.0.63
echo '[{"formName":"totora-catalogo","currentVersion":"1.0.73"},{"formName":"totora-reserva","currentVersion":"1.0.63"},{"formName":"totora-encargos","currentVersion":"1.0.288"}]' > "$TMP/forms.json"
echo '200 1461271' > "$TMP/code.http"
run_hf "$Z" && ok "forms: los 2 del directorio en su versión y sirviendo código → 0" || no "forms: el caso bueno salió $? ($(cat "$TMP/err"))"
echo '[{"formName":"totora-catalogo","currentVersion":"1.0.72"},{"formName":"totora-reserva","currentVersion":"1.0.63"}]' > "$TMP/forms.json"
run_hf "$Z" && no "🔴 forms: aprobó con admin en la versión vieja" || ok "forms: un formulario en la versión vieja → 1"
grep -q "totora-catalogo está en '1.0.72', esperaba '1.0.73'" "$TMP/err" && ok "forms: …y dice cuál y qué esperaba" || no "forms: no dijo cuál falló"
echo '[{"formName":"totora-catalogo","currentVersion":"1.0.73"},{"formName":"totora-reserva","currentVersion":"1.0.63"}]' > "$TMP/forms.json"; echo '200 0' > "$TMP/code.http"
run_hf "$Z" && no "🔴 forms: aprobó con el código sirviéndose vacío (0 bytes)" || ok "forms: código de 0 bytes → 1"
echo '404 8251' > "$TMP/code.http"
run_hf "$Z" && no "🔴 forms: aprobó con el código en 404" || ok "forms: código 404 → 1"
echo '200 1461271' > "$TMP/code.http"; E="$TMP/vacio"; mkdir -p "$E"
run_hf "$E" && no "🔴 forms: directorio sin ZIPs salió verde" || ok "forms: sin ZIPs → 1 (nada que verificar no es verde)"
R="$TMP/roto"; mkdir -p "$R"; ( cd "$TMP" && echo '{"forms":[{"formName":"x"}]}' > manifest.json && zip -q "$R/x.zip" manifest.json && rm manifest.json )
run_hf "$R" && no "🔴 forms: manifest sin versión salió verde" || ok "forms: manifest sin versión → 1"

# ── 🔴 EL HUMO COMPARA VERSIÓN, NO CÓDIGO (2026-09-03) ─────────────────────────────────────────
# Toda la familia de fallos de versionado pasa este humo POR CONSTRUCCIÓN: si el número no subió, el
# host ya tiene "esa versión" —porque nunca se le subió nada— y sirve el código VIEJO. El control que
# debería atrapar el fallo más caro del circuito es ciego a él. Primer paso: comparar el peso servido
# con el que declara el paquete, AVISANDO (no frenando) hasta medir si el host envuelve el archivo.
mkdir -p "$TMP/z2" && rm -f "$TMP/z2"/*.zip
( cd "$TMP" && rm -rf arm && mkdir -p arm && cd arm \
  && printf '{"forms":[{"formName":"pedidos","version":"1.0.7","sizeBytes":"12345"}]}' > manifest.json \
  && zip -q "$TMP/z2/pedidos.zip" manifest.json ) >/dev/null 2>&1
echo '[{"formName":"pedidos","currentVersion":"1.0.7"}]' > "$TMP/forms.json"; echo 200 > "$TMP/login.code"

echo '200 12345' > "$TMP/code.http"
run_hf "$TMP/z2" && ok "formularios: peso servido igual al declarado → sin aviso" || no "🔴 el caso bueno salió $?"
grep -q "difieren en" "$TMP/out" "$TMP/err" && no "🔴 avisó con los pesos iguales" || ok "…y no avisa de nada"

# 🔴 EL PESO YA FRENA (2026-09-03, la misma noche, con la evidencia en la mano). El aviso entró
# midiendo porque no estaba medido si el host envuelve el archivo. Se midió: en 48 formularios de
# los CINCO productos (Totora 9807, URUTAU 9808, Lapacho 9819, Ceibo 9820, FRESNO 9793), el host
# sirve EXACTAMENTE los bytes que declara el paquete — diferencia cero, no constante: nula. Con eso
# el peso deja de ser un aviso y pasa a frenar: un formulario cuyo código servido pesa distinto del
# que trae el paquete de esta corrida NO es el que se acaba de instalar.
echo '200 99999' > "$TMP/code.http"
run_hf "$TMP/z2" && no "🔴 el host sirve un peso distinto al del paquete y el humo lo aprobó — es el 'verde que no miró'" || ok "🔴 formularios: peso distinto al del paquete → 1 (el código servido no es el de esta corrida)"
grep -q "difieren en" "$TMP/out" "$TMP/err" && ok "…y dice cuánto difieren" || no "🔴 frenó sin decir por qué"

# …y lo que NO cambia: un manifiesto sin peso declarado no puede frenar por peso (no hay con qué
# comparar). Es el caso de un paquete viejo: se sigue verificando la versión, como antes.
( cd "$TMP" && rm -rf arm3 && mkdir -p arm3 && cd arm3   && printf '{"forms":[{"formName":"pedidos","version":"1.0.7"}]}' > manifest.json   && rm -f "$TMP/z3"/*.zip 2>/dev/null; mkdir -p "$TMP/z3"   && zip -q "$TMP/z3/pedidos.zip" manifest.json ) >/dev/null 2>&1
echo '200 99999' > "$TMP/code.http"
run_hf "$TMP/z3" && ok "…y un paquete que no declara peso no frena por peso (no hay con qué comparar)" || no "🔴 frenó a un paquete sin peso declarado ($?)"
echo '200 1234' > "$TMP/code.http"

# ══ story 2.10 · REGISTRO DE DESPLIEGUES ═══════════════════════════════════════════════════════════
# Dentro de una corrida de Azure (TF_BUILD=True), un humo APROBADO deja una línea
# `[registro-despliegue] {json}` y sus etiquetas; uno que falla, nada. Fuera de Azure, la salida es la
# de siempre. La dirección del host, el usuario y la clave nunca aparecen.
REG=(TF_BUILD=True SYSTEM_TEAMPROJECT=Totora BUILD_REPOSITORY_NAME=Backend SYSTEM_STAGENAME=Deploy SYSTEM_JOBNAME=DeployToStaging BUILD_BUILDID=100)
job(){ mktemp -d "$TMP/job.XXXXXX"; }
lineas(){ grep -c '^\[registro-despliegue\] ' "$1" 2>/dev/null || true; }
etiquetas(){ grep -c '^##vso\[build.addbuildtag\]' "$1" 2>/dev/null || true; }
reg_hp(){ local j="$1"; shift; env "${REG[@]}" AGENT_TEMPDIRECTORY="$j" bash "$HP" "$@" >"$TMP/out" 2>"$TMP/err"; }
reg_hf(){ local j="$1"; shift; env "${REG[@]}" AGENT_TEMPDIRECTORY="$j" bash "$HF" http://stub u p "$1" >"$TMP/out" 2>"$TMP/err"; }
plugin_sano(){ # el plugin del caso bueno, con /health sano y el identificador de compilación abc1234
  echo 200 > "$TMP/login.code"; rm -f "$TMP/loaded.json" "$TMP/pluginhealth.code"
  echo "[{\"pluginId\":7,\"name\":\"${1:-totorabackend}\",\"version\":\"1.0.214\",\"isActive\":true,\"isDefault\":true}]" > "$TMP/plugins.json"
  echo 200 > "$TMP/health.code"; echo '{}' > "$TMP/health.json"
  echo '{"status":"healthy","commitHash":"abc1234def"}' > "$TMP/pluginhealth.json"
}

# ── T1 · un humo de plugin aprobado: una línea y dos etiquetas
plugin_sano; J=$(job)
reg_hp "$J" http://stub u p totorabackend 1.0.214 abc1234
rc=$?
[ $rc -eq 0 ] && ok "2.10 T1 el humo aprobado sigue saliendo 0" || no "🔴 2.10 T1 el registro cambió el veredicto (rc=$rc): $(cat "$TMP/err")"
[ "$(lineas "$TMP/out")" = "1" ] && ok "2.10 T1 exactamente una línea [registro-despliegue]" || no "🔴 2.10 T1 esperaba 1 línea, hay $(lineas "$TMP/out")"
L=$(grep '^\[registro-despliegue\] ' "$TMP/out" | sed 's/^\[registro-despliegue\] //')
[ "$(printf '%s' "$L" | jq 'keys|length' 2>/dev/null)" = "15" ] && printf '%s' "$L" | jq -e '.estado=="desplegado" and .tipo=="plugin" and .artefacto=="totorabackend" and .version=="1.0.214" and .hash=="abc1234"' >/dev/null && ok "2.10 T1 la línea trae las 15 claves con estado desplegado" || no "2.10 T1 línea fuera de contrato: $L"
[ "$(etiquetas "$TMP/out")" = "2" ] && grep -qx '##vso\[build.addbuildtag\]desplegado' "$TMP/out" && grep -qx '##vso\[build.addbuildtag\]totorabackend-1.0.214' "$TMP/out" && ok "2.10 T1 exactamente dos etiquetas: desplegado y totorabackend-1.0.214" || no "🔴 2.10 T1 etiquetas: $(grep addbuildtag "$TMP/out" | tr '\n' ' ')"
grep -n '^\[humo\] ✅' "$TMP/out" >/dev/null && [ "$(grep -n '^\[humo\] ✅' "$TMP/out" | cut -d: -f1)" -lt "$(grep -n '^\[registro-despliegue\]' "$TMP/out" | cut -d: -f1)" ] && ok "2.10 T1 la línea sale DESPUÉS del veredicto ✅" || no "2.10 T1 la línea no sale después del ✅"

# ── T3 · el mismo job no duplica; otro job repite la misma clave
reg_hp "$J" http://stub u p totorabackend 1.0.214 abc1234
[ "$(lineas "$TMP/out")" = "0" ] && [ "$(etiquetas "$TMP/out")" = "0" ] && ok "2.10 T3 segunda corrida en el mismo job: ni línea ni etiquetas" || no "🔴 2.10 T3 el mismo job anotó dos veces ($(lineas "$TMP/out") líneas, $(etiquetas "$TMP/out") etiquetas)"
J2=$(job); reg_hp "$J2" http://stub u p totorabackend 1.0.214 abc1234
L2=$(grep '^\[registro-despliegue\] ' "$TMP/out" | sed 's/^\[registro-despliegue\] //')
[ -n "$L2" ] && [ "$(printf '%s' "$L2" | jq -r .clave)" = "$(printf '%s' "$L" | jq -r .clave)" ] && ok "2.10 T3 otro job anota de nuevo, con la MISMA clave" || no "2.10 T3 otro job: línea '$L2' vs '$L'"

# ── T4 · un humo que falla no deja «desplegado» (plugin)
sin_desplegado(){ ! grep -q '^\[registro-despliegue\] ' "$TMP/out" && ! grep -q 'addbuildtag\]desplegado' "$TMP/out"; }
plugin_sano; echo '[{"pluginId":7,"name":"totorabackend","version":"1.0.213","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 plugin versión distinta → 1 y sin registro" || no "🔴 2.10 T4 versión distinta anotó 'desplegado' (rc=$rc)"
plugin_sano; echo '[{"name":"totorabackend","version":"1.0.213"}]' > "$TMP/loaded.json"
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 marcada ≠ cargada → 1 y sin registro" || no "🔴 2.10 T4 marcada≠cargada anotó (rc=$rc)"
plugin_sano; echo '{"errorMessage":"worker caído"}' > "$TMP/health.json"
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 degradado → 1 y sin registro" || no "🔴 2.10 T4 degradado anotó (rc=$rc)"
plugin_sano; echo 500 > "$TMP/health.code"
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 salud ilegible (500) → 1 y sin registro" || no "🔴 2.10 T4 salud ilegible anotó (rc=$rc)"
plugin_sano
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 9999999; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 otro identificador de compilación → 1 y sin registro" || no "🔴 2.10 T4 hash distinto anotó (rc=$rc)"
plugin_sano; echo 404 > "$TMP/pluginhealth.code"
reg_hp "$(job)" http://stub u p totorabackend 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "2.10 T4 rutas propias en 404 → 1 y sin registro" || no "🔴 2.10 T4 rutas en 404 anotó (rc=$rc)"
rm -f "$TMP/pluginhealth.code"

# ── Formularios: ZIPs con commitHash en el manifest
mkc(){ # mkc <dir> <form> <version> <commit|""> <bytes>
  local d="$1" f="$2" v="$3" c="$4" b="$5" w="$TMP/arm-$2"; mkdir -p "$d" "$w"
  ( cd "$w" && if [ -n "$c" ]; then jq -nc --arg c "$c" --arg f "$f" --arg v "$v" --arg b "$b" '{commitHash:$c, forms:[{formName:$f,version:$v,sizeBytes:$b}]}'; else jq -nc --arg f "$f" --arg v "$v" --arg b "$b" '{forms:[{formName:$f,version:$v,sizeBytes:$b}]}'; fi > manifest.json && rm -f "$d/$f.zip" && zip -q "$d/$f.zip" manifest.json )
}
formularios_al_dia(){ # todas las formas del directorio en 1.0.2 y sirviendo 10 bytes
  echo 200 > "$TMP/login.code"; echo '200 10' > "$TMP/code.http"; rm -f "$TMP"/versions-*.json "$TMP"/versions-*.code "$TMP/versions.log"
  jq -nc '[ $ARGS.positional[] | {formName: ., currentVersion: "1.0.2"} ]' --args "$@" > "$TMP/forms.json"
}
cur(){ echo "[{\"version\":\"1.0.2\",\"isCurrent\":true,\"commitHash\":\"$2\"},{\"version\":\"1.0.1\",\"isCurrent\":false,\"commitHash\":\"0000000\"}]" > "$TMP/versions-$1.json"; }

# ── T6 · se anota sólo lo que el host dice que se subió desde el commit de este ZIP
Z6="$TMP/z6"; rm -rf "$Z6"
mkc "$Z6" a 1.0.2 abc1234def5678 10; mkc "$Z6" b 1.0.2 abc1234def5678 10; mkc "$Z6" c 1.0.2 abc1234def5678 10
formularios_al_dia a b c; cur a abc1234def5678; cur b 9999999aaaa; cur c ABC1234
reg_hf "$(job)" "$Z6"; rc=$?
[ $rc -eq 0 ] && ok "2.10 T6 humo de formularios aprobado sigue saliendo 0" || no "🔴 2.10 T6 rc=$rc: $(cat "$TMP/err")"
[ "$(lineas "$TMP/out")" = "2" ] && grep '^\[registro-despliegue\]' "$TMP/out" | grep -q '"artefacto":"a"' && grep '^\[registro-despliegue\]' "$TMP/out" | grep -q '"artefacto":"c"' && ! grep '^\[registro-despliegue\]' "$TMP/out" | grep -q '"artefacto":"b"' && ok "2.10 T6 dos líneas: a (mismo commit) y c (prefijo, sin mayúsculas); b ya estaba" || no "🔴 2.10 T6 líneas: $(grep '^\[registro-despliegue\]' "$TMP/out" | sed 's/^\[registro-despliegue\] //' | jq -rc '.artefacto' 2>/dev/null | tr '\n' ' ') — esperaba a y c"
grep '^\[registro-despliegue\]' "$TMP/out" | sed 's/^\[registro-despliegue\] //' | jq -e 'select(.artefacto=="a") | .tipo=="formulario" and .estado=="desplegado" and .hash=="abc1234def5678"' >/dev/null && ok "2.10 T6 la línea de formulario trae tipo formulario y el commit del manifest" || no "2.10 T6 línea de formulario fuera de contrato"
[ "$(grep -c '^##vso\[build.addbuildtag\]desplegado$' "$TMP/out")" = "1" ] && grep -qx '##vso\[build.addbuildtag\]a-1.0.2' "$TMP/out" && grep -qx '##vso\[build.addbuildtag\]c-1.0.2' "$TMP/out" && [ "$(etiquetas "$TMP/out")" = "3" ] && ok "2.10 T6 etiquetas: desplegado una vez + a-1.0.2 + c-1.0.2" || no "🔴 2.10 T6 etiquetas: $(grep addbuildtag "$TMP/out" | tr '\n' ' ')"
grep -q '2 desplegado(s) en esta corrida · 1 ya estaban · 0 sin constancia · 0 sin anotar' "$TMP/err" && ok "2.10 T6 el resumen por stderr cuenta 2 · 1 · 0 · 0" || no "2.10 T6 resumen: $(grep '\[registro\]' "$TMP/err")"

# ── T7 · sin constancia: avisa una vez y sale 0
Z7="$TMP/z7"; rm -rf "$Z7"
for f in a b c d; do mkc "$Z7" $f 1.0.2 abc1234 10; done; mkc "$Z7" e 1.0.2 "" 10
formularios_al_dia a b c d e
cur a abc1234; echo 500 > "$TMP/versions-a.code"
echo '<html>proxy</html>' > "$TMP/versions-b.json"
echo '[{"version":"1.0.1","isCurrent":true,"commitHash":"abc1234"}]' > "$TMP/versions-c.json"
echo '[{"version":"1.0.2","isCurrent":true}]' > "$TMP/versions-d.json"
cur e abc1234
reg_hf "$(job)" "$Z7"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "0" ] && [ "$(etiquetas "$TMP/out")" = "0" ] && ok "2.10 T7 cinco formas de no saber → 0, ninguna línea, ninguna etiqueta" || no "🔴 2.10 T7 rc=$rc líneas=$(lineas "$TMP/out") etiquetas=$(etiquetas "$TMP/out") — no saber se leyó como saber"
[ "$(grep -c 'logissue type=warning.*registro-despliegue' "$TMP/out")" = "1" ] && grep 'logissue type=warning.*registro-despliegue' "$TMP/out" | grep -q '5' && ok "2.10 T7 …con UN aviso que cuenta los 5" || no "2.10 T7 avisos: $(grep logissue "$TMP/out")"

# ── T8 · nada subido en esta corrida: sin etiqueta desplegado
Z8="$TMP/z8"; rm -rf "$Z8"; mkc "$Z8" a 1.0.2 abc1234 10; mkc "$Z8" b 1.0.2 abc1234 10
formularios_al_dia a b; cur a 1111111; cur b 2222222
reg_hf "$(job)" "$Z8"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "0" ] && [ "$(etiquetas "$TMP/out")" = "0" ] && ok "2.10 T8 nada subido → 0, sin líneas y SIN etiqueta desplegado" || no "🔴 2.10 T8 una corrida que no subió nada quedó anotada (rc=$rc, $(etiquetas "$TMP/out") etiquetas)"
grep -q '0 desplegado(s) en esta corrida · 2 ya estaban · 0 sin constancia · 0 sin anotar' "$TMP/err" && ok "2.10 T8 el resumen dice 2 ya estaban" || no "2.10 T8 resumen: $(grep '\[registro\]' "$TMP/err")"

# ── T13 (revisión de seguridad) · un nombre de formulario fuera de su juego no se mete en NINGUNA consulta.
# Hasta el 2026-09-17 el humo lo aprobaba (el nombre crudo iba a /code) y sólo el registro lo salteaba como
# «sin constancia». Desde el arreglo SEC-C1 el humo sale ROJO antes de entrar al host: nada se anota.
Z13="$TMP/z13"; rm -rf "$Z13"; mkc "$Z13" 'x%2e%2e' 1.0.2 abc1234 10; mkc "$Z13" a 1.0.2 abc1234 10
formularios_al_dia 'x%2e%2e' a; cur a abc1234; : > "$TMP/urls.log"
reg_hf "$(job)" "$Z13"; rc=$?
[ $rc -ne 0 ] && sin_desplegado && [ ! -s "$TMP/urls.log" ] && ok "2.10 T13 un formulario con '%' en el nombre: humo en rojo, sin registro y sin una sola consulta al host" || no "🔴 2.10 T13 el nombre crudo llegó al host o el humo aprobó (rc=$rc): $(cat "$TMP/urls.log" 2>/dev/null | tr '\n' ' ')"

# ── T4 · un humo que falla no deja «desplegado» (formularios), y /versions ni se consulta
Z4="$TMP/z4"; rm -rf "$Z4"; mkc "$Z4" a 1.0.2 abc1234 10; mkc "$Z4" b 1.0.2 abc1234 10
fallo_forms(){ reg_hf "$(job)" "$1"; local rc=$?; [ $rc -ne 0 ] && sin_desplegado && [ ! -s "$TMP/versions.log" ]; }
formularios_al_dia a b; cur a abc1234; cur b abc1234; echo '[{"formName":"a","currentVersion":"1.0.1"},{"formName":"b","currentVersion":"1.0.2"}]' > "$TMP/forms.json"
fallo_forms "$Z4" && ok "2.10 T4 formularios con uno en versión vieja → 1, sin registro, sin consultar /versions" || no "🔴 2.10 T4 versión vieja anotó o consultó /versions"
formularios_al_dia a b; cur a abc1234; cur b abc1234; echo '200 0' > "$TMP/code.http"
fallo_forms "$Z4" && ok "2.10 T4 código vacío → 1 y sin registro" || no "🔴 2.10 T4 código vacío anotó"
formularios_al_dia a b; cur a abc1234; cur b abc1234; echo '404 10' > "$TMP/code.http"
fallo_forms "$Z4" && ok "2.10 T4 código en 404 → 1 y sin registro" || no "🔴 2.10 T4 código 404 anotó"
formularios_al_dia a b; cur a abc1234; cur b abc1234; mkc "$Z4" b 1.0.2 abc1234 99
fallo_forms "$Z4" && ok "2.10 T4 uno bien y otro con peso distinto → 1 y NINGUNO se anota" || no "🔴 2.10 T4 con un formulario roto se anotó el que pasó"
mkc "$Z4" b 1.0.2 abc1234 10
E4="$TMP/vacio4"; mkdir -p "$E4"; formularios_al_dia a
fallo_forms "$E4" && ok "2.10 T4 sin ZIPs → 1 y sin registro" || no "🔴 2.10 T4 sin ZIPs anotó"
R4="$TMP/roto4"; mkdir -p "$R4"; ( cd "$TMP" && echo '{"forms":[{"formName":"x"}]}' > manifest.json && zip -q "$R4/x.zip" manifest.json && rm manifest.json )
formularios_al_dia x
fallo_forms "$R4" && ok "2.10 T4 manifest roto → 1 y sin registro" || no "🔴 2.10 T4 manifest roto anotó"

# ── T6b (pase adversarial) · la MISMA versión publicada otra vez por esta corrida se anota: el host la
# vuelve a publicar con el commit nuevo y no deja distinguirla de una versión nueva. La 2.11 cuenta cambios
# por primera aparición de la versión (decisión del dev 2026-09-17). Este caso fija esa conducta.
Z6b="$TMP/z6b"; rm -rf "$Z6b"; mkc "$Z6b" demo-form-a 1.0.2 1111111aaaa 10; mkc "$Z6b" demo-form-b 1.0.2 1111111aaaa 10
formularios_al_dia demo-form-a demo-form-b; cur demo-form-a 1111111aaaa; cur demo-form-b 1111111aaaa
reg_hf "$(job)" "$Z6b"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "2" ] && grep -q '2 desplegado(s) en esta corrida · 0 ya estaban · 0 sin constancia · 0 sin anotar' "$TMP/err" && ok "2.10 T6b la misma versión publicada otra vez por esta corrida se anota (publicado ≠ cambiado: lo cuenta la 2.11)" || no "2.10 T6b republicación: rc=$rc líneas=$(lineas "$TMP/out") $(grep '\[registro\]' "$TMP/err")"

# ── T5 · la dirección, el usuario y la clave no viajan
plugin_sano; J=$(job)
env "${REG[@]}" AGENT_TEMPDIRECTORY="$J" bash "$HP" https://host-secreto.cliente.example usuario-secreto clave-secreta totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "1" ] && ! grep -q -e 'host-secreto' -e 'cliente.example' -e 'usuario-secreto' -e 'clave-secreta' "$TMP/out" "$TMP/err" && ok "2.10 T5 plugin: ni la dirección, ni el usuario, ni la clave en stdout+stderr" || no "🔴 2.10 T5 plugin: se filtró algo (rc=$rc): $(grep -h -e host-secreto -e usuario-secreto -e clave-secreta "$TMP/out" "$TMP/err")"
plugin_sano host-secreto; J=$(job)
env "${REG[@]}" AGENT_TEMPDIRECTORY="$J" bash "$HP" https://otro.example u p host-secreto 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"
grep '^\[registro-despliegue\]' "$TMP/out" | grep -q 'host-secreto' && ok "2.10 T5 control positivo: el marcador puesto en el artefacto SÍ aparece (la prueba sabe ponerse roja)" || no "2.10 T5 el control positivo no apareció — la prueba de fuga no prueba nada"
formularios_al_dia a c; Z5="$TMP/z5"; rm -rf "$Z5"; mkc "$Z5" a 1.0.2 abc1234 10; mkc "$Z5" c 1.0.2 abc1234 10; cur a abc1234; cur c abc1234
env "${REG[@]}" AGENT_TEMPDIRECTORY="$(job)" bash "$HF" https://host-secreto.cliente.example usuario-secreto clave-secreta "$Z5" >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "2" ] && grep -q 'host-secreto.cliente.example/api/custom-forms/a/versions' "$TMP/versions.log" && ! grep -q -e 'host-secreto' -e 'usuario-secreto' -e 'clave-secreta' "$TMP/out" "$TMP/err" && ok "2.10 T5 formularios: /versions se consultó en el host pero su dirección no sale" || no "🔴 2.10 T5 formularios: rc=$rc líneas=$(lineas "$TMP/out") o se filtró la dirección"

# ── T10 · fuera de Azure la salida es byte a byte la del guion sin registro
SOLO="$TMP/solo"; mkdir -p "$SOLO"; cp "$HP" "$HF" "$SOLO/"
sin_azure(){ env -u TF_BUILD -u AGENT_TEMPDIRECTORY bash "$@"; }
compara(){ # compara <nombre> <args...> — corre el guion con ayudante y la copia sin ayudante
  local n="$1"; shift; local g="$1"; shift
  sin_azure "$g" "$@" >"$TMP/con.out" 2>"$TMP/con.err"; local r1=$?
  sin_azure "$SOLO/$(basename "$g")" "$@" >"$TMP/sin.out" 2>"$TMP/sin.err"; local r2=$?
  if [ $r1 -eq $r2 ] && cmp -s "$TMP/con.out" "$TMP/sin.out" && cmp -s "$TMP/con.err" "$TMP/sin.err" && ! grep -q -e 'registro' -e 'addbuildtag' "$TMP/con.out" "$TMP/con.err"; then ok "2.10 T10 fuera de Azure, $n: salida idéntica a la del guion sin registro"; else no "🔴 2.10 T10 fuera de Azure, $n: la salida cambió ($r1 vs $r2)"; fi
}
plugin_sano; compara "plugin aprobado" "$HP" http://stub u p totorabackend 1.0.214 abc1234
plugin_sano; echo '{"errorMessage":"x"}' > "$TMP/health.json"; compara "plugin degradado" "$HP" http://stub u p totorabackend 1.0.214 abc1234
formularios_al_dia a b c; cur a abc1234def5678; cur b 9999999aaaa; cur c ABC1234; compara "formularios aprobados" "$HF" http://stub u p "$Z6"

# ── T11 · un registro roto no cambia el veredicto
plugin_sano; J=$(job)
env "${REG[@]}" AGENT_TEMPDIRECTORY="$J" bash "$SOLO/smoke-plugin.sh" http://stub u p totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "0" ] && grep -q 'logissue type=warning.*deploy-record.sh' "$TMP/out" && ok "2.10 T11 sin el ayudante al lado: sale 0, sin línea, con un aviso que lo nombra" || no "🔴 2.10 T11 sin ayudante: rc=$rc o sin aviso: $(cat "$TMP/out")"
echo '[{"pluginId":7,"name":"totorabackend","version":"1.0.213","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
env "${REG[@]}" AGENT_TEMPDIRECTORY="$(job)" bash "$SOLO/smoke-plugin.sh" http://stub u p totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 1 ] && ok "2.10 T11 sin el ayudante, un humo que falla sigue saliendo 1" || no "🔴 2.10 T11 sin ayudante el humo fallido salió $rc"
# PATH sin sha256sum ni shasum: sólo los comandos que el humo y el ayudante usan
GRANJA="$TMP/granja"; mkdir -p "$GRANJA"; cp "$STUB/curl" "$STUB/sleep" "$GRANJA/"
for c in bash jq grep sed head tail mktemp rm cat date mkdir tr cut dirname basename touch printf env wc sort; do p=$(command -v "$c" 2>/dev/null) && [ -x "$p" ] && [ "${p#/}" != "$p" ] && ln -sf "$p" "$GRANJA/$c"; done
plugin_sano; J=$(job)
env -i HOME="$TMP" PATH="$GRANJA" STUB_DIR="$TMP" "${REG[@]}" AGENT_TEMPDIRECTORY="$J" "$BASH" "$HP" http://stub u p totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "0" ] && [ "$(etiquetas "$TMP/out")" = "0" ] && grep -q 'logissue type=warning.*registro-despliegue' "$TMP/out" && ok "2.10 T11 sin sha256sum ni shasum: sale 0, sin línea ni etiquetas, con aviso" || no "🔴 2.10 T11 sin herramienta de huella: rc=$rc líneas=$(lineas "$TMP/out") — $(tail -3 "$TMP/out") $(tail -3 "$TMP/err")"

# ── T11b (pase adversarial) · formularios sin herramienta de huella: UN aviso y todos cuentan como sin anotar
Z11="$TMP/z11"; rm -rf "$Z11"; for f in a b c; do mkc "$Z11" $f 1.0.2 abc1234def 10; done
formularios_al_dia a b c; cur a abc1234def; cur b abc1234def; cur c abc1234def
for c in unzip zip; do p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$GRANJA/$c"; done
env -i HOME="$TMP" PATH="$GRANJA" STUB_DIR="$TMP" "${REG[@]}" AGENT_TEMPDIRECTORY="$(job)" "$BASH" "$HF" http://stub u p "$Z11" >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && [ "$(lineas "$TMP/out")" = "0" ] && [ "$(grep -c 'logissue type=warning.*registro-despliegue' "$TMP/out")" = "1" ] && grep -q '0 desplegado(s) en esta corrida · 0 ya estaban · 0 sin constancia · 3 sin anotar' "$TMP/err" && ok "2.10 T11b sin herramienta de huella: un solo aviso y los 3 cuentan como sin anotar" || no "🔴 2.10 T11b formularios sin huella: rc=$rc avisos=$(grep -c logissue "$TMP/out") $(grep '\[registro\]' "$TMP/err")"

# ══ SEC-C1 (2026-09-17) · EL NOMBRE NO SE METE CRUDO EN UNA CONSULTA AL HOST ══════════════════════
# El nombre del plugin (plugin.json del ZIP) y el de cada formulario (manifest.json del ZIP) iban tal
# cual a /api/plugins/<n>/health y /api/custom-forms/<f>/code, y a cada mensaje del humo — Azure lee
# `##vso[` en cualquier línea de stdout o stderr. En cada caso de abajo el host de mentira CONOCE ese
# nombre y dice que está todo bien: sin el arreglo el humo aprueba. Un nombre que no pasa NO se
# consulta —ni siquiera se entra al host— y el humo sale rojo diciendo por qué: no verificar nunca es verde.
pedidos(){ if [ -s "$TMP/urls.log" ]; then wc -l < "$TMP/urls.log" | tr -d ' '; else echo 0; fi; }
# toda línea con `##vso[` tiene que ser un aviso o un error del propio humo, al principio de la línea
solo_logissue(){ ! cat "$TMP/out" "$TMP/err" | grep -F '##vso[' | grep -qv '^##vso\[task\.logissue type=\(error\|warning\)\]\[humo\]'; }
dice_por_que(){ grep -q 'logissue type=error.*nombre.*no es válido' "$TMP/out" "$TMP/err"; }
hp_nombre(){ # hp_nombre <nombre>: el host conoce ese plugin, sano, activo, default y del build abc1234
  plugin_sano x; jq -nc --arg n "$1" '[{pluginId:7,name:$n,version:"1.0.214",isActive:true,isDefault:true}]' > "$TMP/plugins.json"
  : > "$TMP/urls.log"; bash "$HP" http://stub u p "$1" 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"
}
mkn(){ # mkn <dir> <archivo> <formName> — el nombre del ZIP no es el del formulario (que puede traer '/')
  local d="$1" a="$2" f="$3" w="$TMP/arm-n"; rm -rf "$w"; mkdir -p "$d" "$w"
  ( cd "$w" && jq -nc --arg f "$f" '{commitHash:"abc1234", forms:[{formName:$f,version:"1.0.2"}]}' > manifest.json && rm -f "$d/$a.zip" && zip -q "$d/$a.zip" manifest.json )
}
hf_nombre(){ # hf_nombre <formName>: un ZIP bueno y uno con ese nombre; el host dice que los dos están al día
  ZSEC="$TMP/zsec"; rm -rf "$ZSEC"; mkn "$ZSEC" bueno totora-catalogo; mkn "$ZSEC" raro "$1"
  echo 200 > "$TMP/login.code"; echo '200 10' > "$TMP/code.http"; rm -f "$TMP"/versions-*.json "$TMP"/versions-*.code
  jq -nc --arg f "$1" '[{formName:"totora-catalogo",currentVersion:"1.0.2"},{formName:$f,currentVersion:"1.0.2"}]' > "$TMP/forms.json"
  : > "$TMP/urls.log"; bash "$HF" http://stub u p "$ZSEC" >"$TMP/out" 2>"$TMP/err"
}
juzgar(){ # juzgar <guion> <etiqueta> <rc> — rojo, sin una sola consulta, diciendo por qué y sin comandos de Azure ajenos
  local g="$1" e="$2" rc="$3"
  [ "$rc" -ne 0 ] && ok "SEC-C1 $g: $e → rojo" || no "🔴 SEC-C1 $g: $e APROBÓ — el nombre crudo llegó al host: $(grep -v '/api/auth/login' "$TMP/urls.log" | tail -1)"
  [ "$(pedidos)" = "0" ] && ok "SEC-C1 $g: $e → ni una consulta al host (ni el login)" || no "🔴 SEC-C1 $g: $e → hizo $(pedidos) consulta(s): $(tail -1 "$TMP/urls.log")"
  dice_por_que && ok "SEC-C1 $g: $e → dice que el nombre no es válido" || no "SEC-C1 $g: $e → no dijo por qué: $(tail -1 "$TMP/out") $(tail -1 "$TMP/err")"
  solo_logissue && ok "SEC-C1 $g: $e → ningún \`##vso[\` que no sea un aviso del propio humo" || no "🔴 SEC-C1 $g: $e → un comando de Azure ajeno llegó a la salida: $(cat "$TMP/out" "$TMP/err" | grep -F '##vso[' | grep -v '^##vso\[task\.logissue' | head -1)"
}
CASOS=('../otro' 'x?x=1' '##vso[task.setvariable variable=PWN]1' 'a b' '*' '.oculto' 'a..b' 'x%2e%2e' 'a/b' $'bueno\n../x')
ETIQS=('con ../'  'con ?x=1' 'con ##vso[task.setvariable' 'con un espacio' 'un comodín (*)' 'empieza con punto' 'con .. en el medio' 'con % (ya codificado)' 'con /' 'con un salto de línea')
i=0
while [ $i -lt ${#CASOS[@]} ]; do
  hp_nombre "${CASOS[$i]}"; juzgar plugin "${ETIQS[$i]}" $?
  hf_nombre "${CASOS[$i]}"; juzgar formularios "${ETIQS[$i]}" $?
  i=$((i+1))
done
# …y lo inyectado no aparece ni saneado a medias: el nombre se muestra sin `#` ni `[`
hp_nombre '##vso[task.setvariable variable=PWN]1'
! grep -qF '##vso[task.setvariable' "$TMP/out" "$TMP/err" && ! grep -qF 'variable=PWN]' "$TMP/out" "$TMP/err" && ok "SEC-C1 plugin: el nombre inyectado se muestra saneado (sin '#', '[' ni ']')" || no "🔴 SEC-C1 plugin: el nombre inyectado salió crudo"
hf_nombre '##vso[task.setvariable variable=PWN]1'
! grep -qF '##vso[task.setvariable' "$TMP/out" "$TMP/err" && ! grep -qF 'variable=PWN]' "$TMP/out" "$TMP/err" && ok "SEC-C1 formularios: el nombre inyectado se muestra saneado" || no "🔴 SEC-C1 formularios: el nombre inyectado salió crudo"
# un solo nombre malo tumba el humo entero: el formulario bueno del mismo directorio tampoco se da por verificado
hf_nombre '../otro'; grep -q '✅' "$TMP/out" && no "🔴 SEC-C1 formularios: con un nombre malo igual dio por verificado al otro" || ok "SEC-C1 formularios: con un nombre malo no se verifica ninguno (no hay ✅ a medias)"
# dentro de Azure, un nombre malo tampoco deja registro de despliegue
plugin_sano x; jq -nc '[{pluginId:7,name:"../otro",version:"1.0.214",isActive:true,isDefault:true}]' > "$TMP/plugins.json"
reg_hp "$(job)" http://stub u p '../otro' 1.0.214 abc1234; rc=$?
[ $rc -ne 0 ] && sin_desplegado && ok "SEC-C1 plugin en Azure: nombre malo → rojo y sin registro de despliegue" || no "🔴 SEC-C1 plugin en Azure: nombre malo anotó o aprobó (rc=$rc)"
# el identificador que devuelve el HOST tampoco va crudo a /api/admin/plugins/<id>/health
plugin_sano; echo '[{"pluginId":"7/../../x","name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"; : > "$TMP/urls.log"
bash "$HP" http://stub u p totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
! grep -qF '7/../../x' "$TMP/urls.log" && ok "SEC-C1 plugin: un identificador raro devuelto por el host no se mete en la consulta de salud" || no "🔴 SEC-C1 plugin: el identificador del host fue crudo a la URL: $(grep -F '7/..' "$TMP/urls.log" | head -1)"
[ $rc -ne 0 ] && grep -q 'logissue type=error.*identificador' "$TMP/out" && ! grep -q '✅' "$TMP/out" && ok "…y es ROJO diciéndolo: una respuesta anormal del host no es 'el host no lo expone'" || no "🔴 SEC-C1 plugin: con identificador raro aprobó o no lo dijo (rc=$rc): $(tail -2 "$TMP/out")"
# …y lo que NO cambia: un host que no devuelve identificador sigue avisando sin frenar (capacidad ausente)
plugin_sano; echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
bash "$HP" http://stub u p totorabackend 1.0.214 abc1234 >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -eq 0 ] && grep -q 'logissue type=warning.*identificador' "$TMP/out" && grep -q 'no medido' "$TMP/out" && ok "SEC-C1 plugin: sin identificador del host sigue siendo aviso + 'no medido', como antes" || no "🔴 SEC-C1 plugin: el host sin identificador cambió de conducta (rc=$rc)"

# ── NO-REGRESIÓN · nombres con las FORMAS de los que se publican pasan: minúsculas, mayúsculas, siglas en medio,
# '-' y '_', y el largo del más largo. Las dos listas se GENERAN de un vocabulario neutro (pedidos, artículos,
# facturas de una «Acme» genérica) y en un orden barajado: no siguen a ningún catálogo. La prueba cuida la forma,
# no a quién nombra. Y la URL que se arma es exactamente la de siempre.
SAMPLE_PLUGINS="samplecatalogapi globex demowarehouseplugin demoinvoices samplestockapi acmeorders globextagsplugin acmebilling acmeroutesservice"
SAMPLE_FORMS="sample-articles acme-zones ACME-EnviosPendientes ACME-CatalogoZonas demo-stock globex-branches DEMO_ZonasEntrega DEMO_Facturas DEMO_AvisosStock GLOBEX-RemitoDigital ACME-EtiquetaBolsa ACME-CategoriasArticulo GLOBEX-CategoriaNueva GLOBEX-DepositoCentral ACME-SucursalesActivas ACME-EntregaASucursal DEMO_Depositos sample-shipping GLOBEX-EnvioExpress GLOBEX-FacturasEmitidas DEMO_Bolsas DEMO_RutasDiarias ACME-RemitoCSVImportado GLOBEX-EntregaPendienteDeRemitoPDF demo-boxes ACME-RutaDiaria GLOBEX-CSVCatalogo ACME-ZonaReparto ACME-PdfFacturas GLOBEX-ZonasYSucursales acme-warehouse GLOBEX-ArticulosPDF DEMO_BitacoraEnvios ACME-ResumenFacturacion GLOBEX-StockMinimo DEMO_EtiquetaGrande globex-deliveries GLOBEX-CatalogoGeneral ACME-FacturaPDFSucursal ACME-ControlStock DEMO_Sucursales GLOBEX-BolsasPorDeposito GLOBEX-ListadoCSVZonas ACME-InvoiceBoxLabels GLOBEX-BajaArticulo ACME-AvisosVencidos DEMO_RemitosPendientes ACME-CierreBolsa ACME-ListadoRemitos demo-catalog GLOBEX-AvisoDeEnvio acme-invoices DEMO_Catalogo GLOBEX-BitacoraPedidos ACME-StockPorDeposito acme-routes ACME-AltaArticulo GLOBEX-EtiquetasPorLote sample-notices GLOBEX-AltaSucursal GLOBEX-WarehouseRoutes globex-tags ACME-PedidoRapido ACME-PanelDepositos GLOBEX-ListadoPedidos"
malos=""; for n in $SAMPLE_PLUGINS; do
  hp_nombre "$n"; rc=$?
  { [ $rc -eq 0 ] && grep -Fxq "http://stub/api/plugins/$n/health" "$TMP/urls.log"; } || malos="$malos $n(rc=$rc)"
done
[ -z "$malos" ] && ok "SEC-C1 no-regresión: los 9 plugins de ejemplo aprueban y su URL de salud es la de siempre" || no "🔴 SEC-C1 no-regresión: plugins de ejemplo que dejaron de pasar:$malos"
ZR="$TMP/zsamples"; rm -rf "$ZR"; nf=0; for f in $SAMPLE_FORMS; do mkc "$ZR" "$f" 1.0.2 abc1234 10; nf=$((nf+1)); done
# shellcheck disable=SC2086
formularios_al_dia $SAMPLE_FORMS; for f in $SAMPLE_FORMS; do cur "$f" abc1234; done; : > "$TMP/urls.log"
reg_hf "$(job)" "$ZR"; rc=$?
[ $rc -eq 0 ] && [ "$nf" = "65" ] && [ "$(grep -c '✅' "$TMP/out")" = "65" ] && ok "SEC-C1 no-regresión: los 65 formularios de ejemplo aprueban" || no "🔴 SEC-C1 no-regresión: rc=$rc, $nf formularios, $(grep -c '✅' "$TMP/out") aprobados — $(tail -2 "$TMP/err" | tr '\n' ' ')"
malos=""; for f in $SAMPLE_FORMS; do grep -Fxq "http://stub/api/custom-forms/$f/code" "$TMP/urls.log" && grep -Fxq "http://stub/api/custom-forms/$f/versions" "$TMP/urls.log" || malos="$malos $f"; done
[ -z "$malos" ] && ok "SEC-C1 no-regresión: /code y /versions se piden con el nombre tal cual (mayúsculas, '-' y '_' incluidos)" || no "🔴 SEC-C1 no-regresión: URL distinta de la de siempre para:$malos"
[ "$(lineas "$TMP/out")" = "65" ] && ok "SEC-C1 no-regresión: y los 65 quedan en el registro de despliegues" || no "🔴 SEC-C1 no-regresión: el registro anotó $(lineas "$TMP/out") de 65"
# ══ SEC-C1, segunda parte (2026-09-17) · LO DEMÁS QUE TRAE EL PAQUETE SE VALIDA; LO QUE DICE EL HOST SE MUESTRA SANEADO ══
# Quedó abierto al cerrar los nombres. Del PAQUETE venían sin validar la versión (plugin.json / manifest), el
# identificador de compilación y el PESO declarado — y el peso entraba a una cuenta `$(( ))`, donde bash
# EJECUTA lo que venga adentro. Del HOST se imprimían tal cual la versión marcada, la cargada, la actual de
# un formulario, el motivo de degradación, el identificador de compilación y el cuerpo de un login fallido.
# Regla: lo del paquete se valida (si no pasa, no se consulta y es rojo); lo del host no se valida —si no
# coincide, el humo ya es rojo—, se muestra sin poder armar una orden de Azure.
INY='##vso[task.setvariable variable=PWN]1'
una_orden_por_linea(){ ! cat "$TMP/out" "$TMP/err" | grep -q '##vso\[.*##'; }
limpio(){ solo_logissue && una_orden_por_linea; }
juzgar_por(){ # juzgar_por <patrón del motivo> <guion> <etiqueta> <rc> — el patrón lleva los acentos LITERALES: un '.' en
  # su lugar falla en Linux sin UTF-8 (la letra son dos bytes); medido en Ubuntu con bash 5.2
  local pat="$1" g="$2" e="$3" rc="$4"
  [ "$rc" -ne 0 ] && ok "SEC-C1b $g: $e → rojo" || no "🔴 SEC-C1b $g: $e APROBÓ: $(grep '✅' "$TMP/out" | head -1 | cut -c1-120)"
  [ "$(pedidos)" = "0" ] && ok "SEC-C1b $g: $e → ni una consulta al host" || no "🔴 SEC-C1b $g: $e → hizo $(pedidos) consulta(s)"
  grep -q "logissue type=error.*$pat" "$TMP/out" "$TMP/err" && ok "SEC-C1b $g: $e → dice por qué" || no "SEC-C1b $g: $e → no dijo por qué: $(tail -1 "$TMP/out" | cut -c1-140)"
  limpio && ok "SEC-C1b $g: $e → ninguna orden de Azure ajena en la salida" || no "🔴 SEC-C1b $g: $e → una orden de Azure ajena llegó a la salida: $(cat "$TMP/out" "$TMP/err" | grep -F '##' | grep -v '^##vso\[task\.logissue[^#]*$' | head -1 | cut -c1-140)"
}
hp_version(){ # el host dice EXACTAMENTE esa versión, cargada y sana: sin el arreglo, aprueba
  plugin_sano; jq -nc --arg v "$1" '[{pluginId:7,name:"totorabackend",version:$v,isActive:true,isDefault:true}]' > "$TMP/plugins.json"
  : > "$TMP/urls.log"; bash "$HP" http://stub u p totorabackend "$1" abc1234 >"$TMP/out" 2>"$TMP/err"
}
hp_hash(){ # el host devuelve un identificador que empieza igual: sin el arreglo, aprueba o compara contra basura
  plugin_sano; jq -nc --arg h "$1" '{status:"healthy",commitHash:($h+"def")}' > "$TMP/pluginhealth.json"
  : > "$TMP/urls.log"; bash "$HP" http://stub u p totorabackend 1.0.214 "$1" >"$TMP/out" 2>"$TMP/err"
}
mkv(){ # mkv <dir> <archivo> <formName> <version> [sizeBytes]
  local d="$1" a="$2" f="$3" v="$4" b="${5:-}" w="$TMP/arm-v"; rm -rf "$w"; mkdir -p "$d" "$w"
  ( cd "$w" && jq -nc --arg f "$f" --arg v "$v" --arg b "$b" '{commitHash:"abc1234", forms:[({formName:$f,version:$v} + (if $b=="" then {} else {sizeBytes:$b} end))]}' > manifest.json && rm -f "$d/$a.zip" && zip -q "$d/$a.zip" manifest.json )
}
hf_paquete(){ # hf_paquete <version> [sizeBytes]: el host dice esa misma versión y sirve 10 bytes
  ZV="$TMP/zver"; rm -rf "$ZV"; mkv "$ZV" bueno totora-catalogo 1.0.2; mkv "$ZV" raro totora-encargos "$1" "${2:-}"
  echo 200 > "$TMP/login.code"; echo '200 10' > "$TMP/code.http"; rm -f "$TMP"/versions-*.json "$TMP"/versions-*.code
  jq -nc --arg v "$1" '[{formName:"totora-catalogo",currentVersion:"1.0.2"},{formName:"totora-encargos",currentVersion:$v}]' > "$TMP/forms.json"
  : > "$TMP/urls.log"; bash "$HF" http://stub u p "$ZV" >"$TMP/out" 2>"$TMP/err"
}
VERS=("$INY" '1.0' '1.0.214 x' 'v1.0.214' $'1.0.214\n'"$INY")
VETQ=('versión con ##vso[' 'versión 1.0 (dos partes)' 'versión con un espacio' 'versión con v adelante' 'versión con un salto de línea')
i=0; while [ $i -lt ${#VERS[@]} ]; do
  hp_version "${VERS[$i]}";  juzgar_por 'versión.*no es válida' plugin "${VETQ[$i]}" $?
  hf_paquete "${VERS[$i]}";  juzgar_por 'versión.*no es válida' formularios "${VETQ[$i]}" $?
  i=$((i+1))
done
HASHES=("abc1234$INY" 'zzzzzzz' 'abc12'); HETQ=('identificador de compilación con ##vso[' 'identificador que no es hexadecimal' 'identificador de 5 caracteres')
i=0; while [ $i -lt ${#HASHES[@]} ]; do hp_hash "${HASHES[$i]}"; juzgar_por 'identificador de compilación.*no es válido' plugin "${HETQ[$i]}" $?; i=$((i+1)); done
# 🔴 EL PESO: bash evalúa como EXPRESIÓN lo que entra a `$(( ))` — y `a[$(orden)]` ejecuta la orden.
# (medido 2026-09-17 en bash 3.2 y 5.2: con `SIZE[$(orden)]` la orden corre; con una variable que no existe,
# `set -u` corta antes — y en bash 3.2 el guion moría saliendo 0, un verde sin haber verificado nada)
rm -f "$TMP/PWNED"; hf_paquete 1.0.2 "SIZE[\$(touch $TMP/PWNED)]"; rc=$?
[ ! -e "$TMP/PWNED" ] && ok "🔴 SEC-C1b formularios: un peso declarado con una orden adentro NO la ejecuta" || no "🔴🔴 SEC-C1b formularios: el peso del manifest EJECUTÓ una orden en el agente"
juzgar_por 'peso.*no es un número' formularios 'peso con una orden adentro' $rc
hf_paquete 1.0.2 '12x'; juzgar_por 'peso.*no es un número' formularios 'peso que no es un número' $?
hf_paquete 1.0.2 'a[0]'; juzgar_por 'peso.*no es un número' formularios 'peso que nombra una variable que no existe (en bash 3.2 salía 0 sin verificar)' $?
hf_paquete 1.0.2 '010'; [ $? -eq 0 ] && ok "SEC-C1b formularios: un peso con ceros adelante se lee en base 10 (010 = 10 bytes), no como octal" || no "🔴 SEC-C1b formularios: '010' no se leyó como 10: $(tail -1 "$TMP/err")"
hf_paquete 1.0.2 '1234567890123456'; juzgar_por 'peso.*no es un número' formularios 'peso de 16 dígitos' $?
hf_paquete 1.0.2 '10'; [ $? -eq 0 ] && ok "SEC-C1b formularios: un peso numérico que coincide sigue aprobando" || no "🔴 SEC-C1b formularios: el peso bueno dejó de pasar: $(tail -1 "$TMP/err")"
# 🔴 …y el OTRO lado de la misma cuenta: los bytes que cuenta `curl` (lo cazó el revisor de fallos silenciosos).
# `curl -w` siempre da un número, pero si un día no lo diera la resta moría igual — en bash 3.2 saliendo 0 y sin
# imprimir una línea. Un tamaño que no es un número es «no pude mirar», con o sin peso declarado.
hf_paquete 1.0.2 '10'; echo '200 abc' > "$TMP/code.http"; bash "$HF" http://stub u p "$ZV" >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -ne 0 ] && grep -q 'no es un número' "$TMP/err" && ! grep -q '✅.*totora-encargos' "$TMP/out" && ok "SEC-C1b formularios: bytes servidos no numéricos (con peso declarado) → rojo y lo dice" || no "🔴 SEC-C1b formularios: bytes no numéricos con peso declarado → rc=$rc, sin decirlo: $(tail -1 "$TMP/err" | cut -c1-120)"
hf_paquete 1.0.2; echo '200 abc' > "$TMP/code.http"; bash "$HF" http://stub u p "$ZV" >"$TMP/out" 2>"$TMP/err"; rc=$?
[ $rc -ne 0 ] && grep -q 'no es un número' "$TMP/err" && ! grep -q '✅.*totora-encargos' "$TMP/out" && ok "SEC-C1b formularios: bytes servidos no numéricos (sin peso declarado) → rojo y lo dice" || no "🔴 SEC-C1b formularios: bytes no numéricos sin peso declarado → rc=$rc: $(grep '✅' "$TMP/out" | tail -1 | cut -c1-120)"
echo '200 10' > "$TMP/code.http"
# formas de versión que SÍ pasan (las 74 publicadas hoy son N.N.N; el sufijo es el que ya admite el registro de despliegues)
for v in 1.0.2 10.20.300 1.0.0-beta.1 1.0.0.4; do
  hp_version "$v"; [ $? -eq 0 ] || no "🔴 SEC-C1b plugin: la versión $v dejó de pasar: $(tail -1 "$TMP/out")"
  hf_paquete "$v"; [ $? -eq 0 ] || no "🔴 SEC-C1b formularios: la versión $v dejó de pasar: $(tail -1 "$TMP/err")"
done; ok "SEC-C1b no-regresión: 1.0.2, 10.20.300, 1.0.0-beta.1 y 1.0.0.4 se recorrieron en los dos humos (los rojos, si hay, están arriba)"

# ── lo que dice el HOST: sigue siendo rojo por lo que ya era rojo, pero no arma una orden de Azure
host_dice(){ # host_dice <etiqueta> <rc esperado: rojo> — se llama después de correr el humo
  [ "$2" -ne 0 ] && limpio && ok "SEC-C1b host: $1 → rojo y sin orden de Azure ajena" || no "🔴 SEC-C1b host: $1 → rc=$2 o una orden ajena en la salida: $(cat "$TMP/out" "$TMP/err" | grep -F '##' | grep -v '^##vso\[task\.logissue[^#]*$' | head -1 | cut -c1-140)"
}
plugin_sano; jq -nc --arg v "$INY" '[{name:"totorabackend",version:$v}]' > "$TMP/loaded.json"
run_hp 1.0.214 abc1234; host_dice 'versión CARGADA con ##vso[' $?; rm -f "$TMP/loaded.json"
plugin_sano; jq -nc --arg v "$INY" '[{pluginId:7,name:"totorabackend",version:$v,isActive:true,isDefault:true}]' > "$TMP/plugins.json"
run_hp 1.0.214 abc1234; host_dice 'versión MARCADA con ##vso[' $?
plugin_sano; jq -nc --arg v "$INY" '[{pluginId:7,name:"totorabackend",version:"1.0.213",isActive:$v,isDefault:true}]' > "$TMP/plugins.json"
run_hp 1.0.214 abc1234; host_dice 'bandera de activo con ##vso[' $?
plugin_sano; jq -nc --arg v "el worker $INY no arrancó" '{errorMessage:$v}' > "$TMP/health.json"
run_hp 1.0.214 abc1234; rc=$?; host_dice 'motivo de degradación con ##vso[' $rc
grep -q 'el worker' "$TMP/out" && grep -q 'no arrancó' "$TMP/out" && ok "…y el motivo se sigue leyendo (con sus acentos)" || no "SEC-C1b host: el saneado se comió el motivo: $(tail -1 "$TMP/out")"
plugin_sano; jq -nc --arg v "$INY" '{status:"healthy",commitHash:$v}' > "$TMP/pluginhealth.json"
run_hp 1.0.214 abc1234; host_dice 'identificador de compilación del host con ##vso[' $?
plugin_sano; echo 401 > "$TMP/login.code"; jq -nc --arg v "$INY" '{error:$v}' > "$TMP/login.body"
run_hp 1.0.214 abc1234; host_dice 'cuerpo del login fallido con ##vso[ (plugin)' $?
Zh="$TMP/zhost"; rm -rf "$Zh"; mkv "$Zh" a totora-catalogo 1.0.2
run_hf "$Zh"; host_dice 'cuerpo del login fallido con ##vso[ (formularios)' $?
rm -f "$TMP/login.body"; echo 200 > "$TMP/login.code"; echo '200 10' > "$TMP/code.http"
jq -nc --arg v "$INY" '[{formName:"totora-catalogo",currentVersion:$v}]' > "$TMP/forms.json"
run_hf "$Zh"; host_dice 'versión ACTUAL de un formulario con ##vso[' $?

# ── las dos copias del criterio son LA MISMA (los humos no pueden depender de un tercer archivo: el
# artefacto puede llegar incompleto y eso no puede ser un modo de falla nuevo; a cambio, no se separan)
bloque(){ sed -n '/^# >>> nombre-seguro/,/^# <<< nombre-seguro/p' "$1"; }
[ -n "$(bloque "$HP")" ] && [ "$(bloque "$HP")" = "$(bloque "$HF")" ] && ok "SEC-C1 el criterio de nombres es byte a byte el mismo en los dos humos" || no "🔴 SEC-C1 el criterio de nombres difiere entre smoke-plugin.sh y smoke-forms.sh (o falta)"

echo "─────────────"
[ $fallos -eq 0 ] && { echo "✅ humo: todo verde"; exit 0; } || { echo "❌ humo: $fallos falla(s)"; exit 1; }
