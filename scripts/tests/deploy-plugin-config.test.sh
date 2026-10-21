#!/usr/bin/env bash
# deploy-plugin-config.test.sh — el freno de configuración de deploy-plugin.sh.
#
# 🔴 QUÉ PRUEBA. El freno lee qué opciones de configuración le faltan a la versión que se despliega. En la re-corrida
# (la subida devuelve 409 «ya estaba subido») ese dato no viaja, y `GET /api/admin/plugins/{id}` nunca lo trae: leído
# de ahí, la lista queda vacía y el guion concluiría «no falta nada» sin haber medido, justo en el reintento después de
# corregir una configuración. Estos casos exigen que el freno lea de la vista previa del host, que distinga «vacío» de
# «no vino», y que diga cuando no pudo medir en vez de celebrarlo.
#
# Host simulado (scripts/tests/lib/fake-plugin-host.sh), sin red. Las formas de las respuestas son las del host:
# la vista previa trae `missingSettings: [{key, reason}]`; la subida, `missingSettings: ["clave"]`; la consulta por
# identificador, ninguna de las dos.
#
#   TYCON_DEPLOY_SCRIPT=<guion>  corre los casos contra otra copia del guion (para ver qué casos da en rojo otra versión)
#   TYCON_TEST_HOST=viejo|nuevo  sólo los casos de ese host (viejo: no contesta qué faltaría; nuevo: sí)
#   -v                           muestra la salida del guion de cada caso
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUION="${TYCON_DEPLOY_SCRIPT:-$DIR/../ci/deploy-plugin.sh}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
VERBOSO=no; [ "${1:-}" = "-v" ] && VERBOSO=si
OK=0; MAL=0
ok() { echo "✅ config: $1"; OK=$((OK+1)); }
no() { echo "❌ config: $1"; MAL=$((MAL+1)); }
. "$DIR/lib/fake-plugin-host.sh"
fph_init

ZIP="$TMP/miplugin.1.0.7-abc.zip"
fph_zip "$ZIP" || no "T15 no hay zip ni python3 para armar un paquete de verdad — los casos corren con un paquete que no es un ZIP (no es verde)"

quiere() { [ -z "${TYCON_TEST_HOST:-}" ] || [ "$TYCON_TEST_HOST" = "$1" ] || [ "$1" = ambos ]; }
salida() { cat "$TMP/salida.txt"; }
llamo() { grep -qx "$1" "$TMP/llamadas.txt"; } # llamo "<MÉTODO> <ruta>" — si el guion hizo esa llamada

# corre <escenario> [argumentos extra del guion...] — imprime el código de salida
corre() {
  local esc="$1"; shift
  rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; : > "$TMP/llamadas.txt"
  printf '{}\n200\n' > "$TMP/respuestas/default"
  "$esc"
  PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" LLAMADAS="$TMP/llamadas.txt" bash "$GUION" \
    --url http://host --user u --password c --zip "$ZIP" --endpoint /api/admin/plugins/upload "$@" >"$TMP/salida.txt" 2>&1
  local rc=$?
  [ "$VERBOSO" = si ] && { echo "── salida de $esc (rc=$rc)" >&2; cat "$TMP/salida.txt" >&2; }
  echo "$rc"
}
# corre_az <escenario> [argumentos...] — igual, dentro de una corrida de Azure y con una dirección que no se puede filtrar
corre_az() {
  local esc="$1"; shift
  rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas" "$TMP/job"; : > "$TMP/llamadas.txt"
  printf '{}\n200\n' > "$TMP/respuestas/default"
  "$esc"
  env TF_BUILD=True SYSTEM_TEAMPROJECT=Producto BUILD_REPOSITORY_NAME=Backend AGENT_TEMPDIRECTORY="$TMP/job" BUILD_BUILDID=1 \
    PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" LLAMADAS="$TMP/llamadas.txt" bash "$GUION" \
    --url https://host-secreto.cliente.example --user u --password c --zip "$ZIP" --endpoint /api/admin/plugins/upload \
    --environment staging "$@" >"$TMP/salida.txt" 2>&1
  echo $?
}

# ── las piezas de cada escenario ──────────────────────────────────────────────────────────────
base() {
  resp /api/auth/login '{"token":"t"}' 200
  resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":[]}' 200
  resp /api/admin/plugins/7/set-default/preview '{"pendingCount":0,"rollbackCount":0}' 200
  resp /api/admin/plugins/7/activate '{}' 200
  resp /api/admin/plugins/7/health '{}' 200
  resp /api/admin/plugins/7/set-default '{}' 200
}
# la re-corrida: la subida dice «ya existe» y la lista da el identificador. La consulta por identificador devuelve lo
# que el host de verdad devuelve: los datos de la versión, sin `missingSettings`.
recorrida() {
  resp /api/admin/plugins/upload '{"error":"Plugin version already exists"}' 409
  resp_m GET /api/admin/plugins '[{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}]' 200
  resp_m GET /api/admin/plugins/7 '{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}' 200
}
# un host que contesta la pregunta nueva: la vista previa trae la lista con su motivo
previa_nueva() { # previa_nueva <json de missingSettings> [campos extra]
  resp /api/admin/plugins/7/set-default/preview "{\"pluginId\":7,\"pluginName\":\"miplugin\",\"targetVersion\":\"1.0.7\",\"missingSettings\":$1,\"alreadyStarted\":false,\"manifestDeclaresSettings\":true,\"manifestUnreadable\":false,\"migrationAnalysisFailed\":false,\"pendingCount\":0,\"rollbackCount\":0${2:+,$2}}" 200
}
FALTA_X='[{"key":"Pagos:Clave","reason":"opcion-nueva"}]'

# ── T1 · subida nueva: usa la lista del cuerpo de la subida ───────────────────────────────────
t1() { base; resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":["Pagos:Clave"]}' 200; }
if quiere viejo; then
  rc=$(corre t1)
  [ "$rc" = "1" ] && salida | grep -q "Pagos:Clave" && salida | grep -q "sin motivo: la subida no lo informa" \
    && ok "T1 NewUpload_UsesUploadBody — la subida nueva frena nombrando la opción que su cuerpo dice que falta, y dice que la subida no trae el motivo" \
    || no "T1 NewUpload_UsesUploadBody — rc=$rc: $(tail -2 "$TMP/salida.txt")"
fi

# ── T2 · re-corrida: consulta la vista previa, no la consulta por identificador ───────────────
t2() { base; recorrida; previa_nueva "$FALTA_X"; }
if quiere nuevo; then
  rc=$(corre t2)
  [ "$rc" = "1" ] && salida | grep -q "Pagos:Clave" && ok "T2 Rerun_QueriesPreview — la re-corrida frena nombrando la opción que la vista previa dice que falta" \
    || no "🔴 T2 Rerun_QueriesPreview — la re-corrida no frenó por la opción faltante (rc=$rc)"
  llamo "GET /api/admin/plugins/7" && no "🔴 T2 Rerun_QueriesPreview — sigue pidiendo GET /api/admin/plugins/7, que nunca trae las opciones faltantes" \
    || ok "T2 Rerun_QueriesPreview — …y no pide GET /api/admin/plugins/7 para eso"
fi

# ── T3 · el verde falso de hoy, reproducido ──────────────────────────────────────────────────
# El escenario del incidente: re-corrida, el host responde la consulta por identificador como de verdad responde (sin
# el campo), y a la versión le falta una opción. Contra el guion de antes del arreglo esto salía 0.
if quiere nuevo; then
  rc=$(corre t2)
  [ "$rc" = "1" ] && grep '##vso\[task.logissue type=error\]' "$TMP/salida.txt" | grep -q "Pagos:Clave" \
    && ok "T3 Rerun_TodayGivesFalseGreen — el escenario del incidente ya no sale verde: frena por la opción que falta" \
    || no "🔴 T3 Rerun_TodayGivesFalseGreen — la re-corrida con una opción faltante salió 0: es el verde falso del incidente"
fi

# ── T4 · el campo ausente no es una lista vacía ───────────────────────────────────────────────
t4_previa() { base; recorrida; }
t4_subida() { base; resp /api/admin/plugins/upload '{"pluginId":7}' 200; }
if quiere viejo; then
  rc=$(corre t4_previa)
  salida | grep -q "NO PUDO MEDIR" && ok "T4 MissingField_IsNotEmptyList — una vista previa sin la clave se dice «no pudo medir», no «no falta nada»" \
    || no "🔴 T4 MissingField_IsNotEmptyList — la vista previa sin la clave pasó como si no faltara nada (rc=$rc)"
  rc=$(corre t4_subida)
  salida | grep -q "NO PUDO MEDIR" && ok "T4 MissingField_IsNotEmptyList — …y una subida sin la clave, tampoco" \
    || no "🔴 T4 MissingField_IsNotEmptyList — la subida sin la clave pasó como si no faltara nada (rc=$rc)"
fi

# ── T5 · host viejo, subida nueva: usa lo viejo y lo anota ───────────────────────────────────
if quiere viejo; then
  rc=$(corre_az base)
  CONST=$(grep '^\[puente-config\] ' "$TMP/salida.txt" | sed 's/^\[puente-config\] //')
  [ "$rc" = "0" ] && ok "T5 Bridge_OldHostNewUpload_UsesUploadBody — con la lista de la subida vacía, el despliegue sigue" \
    || no "T5 Bridge_OldHostNewUpload_UsesUploadBody — salió $rc: $(tail -2 "$TMP/salida.txt")"
  printf '%s' "$CONST" | jq -e '.camino=="subida" and .medido==true and .plugin=="miplugin" and .version=="1.0.7" and .host=="Producto/Backend/staging"' >/dev/null 2>&1 \
    && ok "T5 Bridge_OldHostNewUpload_UsesUploadBody — …y deja constancia del puente: host por producto, repo y entorno; plugin y versión" \
    || no "🔴 T5 Bridge_OldHostNewUpload_UsesUploadBody — sin constancia del puente, o fuera de forma: «${CONST}»"
  salida | grep -q 'host-secreto' && no "🔴 T5 Bridge_OldHostNewUpload_UsesUploadBody — la dirección del host quedó en la salida" \
    || ok "T5 Bridge_OldHostNewUpload_UsesUploadBody — …sin la dirección del host"
fi

# ── T6 · host viejo, re-corrida: avisa que no pudo medir y no frena ───────────────────────────
t6() { base; recorrida; }
if quiere viejo; then
  rc=$(corre_az t6)
  [ "$rc" = "0" ] && ok "T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — no frena (romper el despliegue de todos los productos es peor)" \
    || no "T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — frenó ($rc): $(tail -2 "$TMP/salida.txt")"
  grep '##vso\[task.logissue type=warning\]' "$TMP/salida.txt" | grep 'NO PUDO MEDIR' | grep 'subí el número de versión' \
    | grep 'Producto/Backend/staging' | grep -q 'miplugin 1.0.7' \
    && ok "T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — …avisa fuerte que NO PUDO MEDIR, en qué host y qué versión del plugin, y cómo salir" \
    || no "🔴 T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — no avisó que no pudo medir, o no dijo cómo salir"
  grep '^\[puente-config\] ' "$TMP/salida.txt" | sed 's/^\[puente-config\] //' | jq -e '.camino=="re-corrida" and .medido==false and .host=="Producto/Backend/staging" and .version=="1.0.7"' >/dev/null 2>&1 \
    && ok "T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — …y deja constancia de host y versión del plugin" \
    || no "🔴 T6 Bridge_OldHostRerun_WarnsCouldNotMeasure — sin constancia de que no se midió"
fi

# ── T7 · el mensaje del rojo: plugin, versión, identificador, cada opción con su motivo y dónde ───────────
t7() { base; previa_nueva '[{"key":"Pagos:Clave","reason":"opcion-nueva"},{"key":"Correo:Servidor","reason":"vacia-en-ambas"}]'; }
if quiere nuevo; then
  rc=$(corre t7)
  FALLA=""
  for t in miplugin 1.0.7 "identificador 7" "Pagos:Clave" "opcion-nueva" "Correo:Servidor" "vacia-en-ambas" "panel"; do
    salida | grep -q "$t" || FALLA="$FALLA «${t}»"
  done
  [ "$rc" = "1" ] && [ -z "$FALLA" ] && ok "T7 Message_NamesVersionReasonAndWhere — el rojo nombra plugin, versión, identificador, cada opción con su motivo y dónde cargarlas" \
    || no "🔴 T7 Message_NamesVersionReasonAndWhere — rc=$rc; al mensaje le falta:$FALLA"
fi

# ── T8 · el mensaje no inventa una dirección ──────────────────────────────────────────────────
if quiere nuevo; then
  rc=$(corre t7)
  [ "$rc" = "1" ] && ! salida | grep -qE 'https?://' && ok "T8 Message_NoAddress_DoesNotInvent — da el identificador y ninguna URL" \
    || no "🔴 T8 Message_NoAddress_DoesNotInvent — rc=$rc; el mensaje trae una URL: $(salida | grep -oE 'https?://[^ ]*' | head -1)"
fi

# ── T9 · la versión ya arrancó ────────────────────────────────────────────────────────────────
t9() { base; previa_nueva "$FALTA_X"; resp /api/admin/plugins/7/set-default/preview "{\"pluginId\":7,\"pluginName\":\"miplugin\",\"targetVersion\":\"1.0.7\",\"missingSettings\":$FALTA_X,\"alreadyStarted\":true,\"manifestDeclaresSettings\":true,\"manifestUnreadable\":false,\"migrationAnalysisFailed\":false,\"pendingCount\":0,\"rollbackCount\":0}" 200; }
if quiere nuevo; then
  rc=$(corre t9)
  [ "$rc" = "1" ] && salida | grep -q "ya arrancó" && salida | grep -q "cargalo en ELLA" && ok "T9 Message_WarnsIfAlreadyStarted — avisa que la versión ya arrancó y que el valor va en ELLA" \
    || no "🔴 T9 Message_WarnsIfAlreadyStarted — rc=$rc, sin el aviso de la versión que ya arrancó"
fi

# ── T10 · vista previa ilegible: rojo con el código y el principio del cuerpo ─────────────────
t10_500() { base; recorrida; resp /api/admin/plugins/7/set-default/preview '{"error":"se rompió algo adentro"}' 500; }
t10_html() { base; resp /api/admin/plugins/7/set-default/preview '<html>502 Bad Gateway</html>' 200; }
if quiere ambos; then
  rc=$(corre t10_500)
  [ "$rc" = "1" ] && salida | grep -q "HTTP 500" && salida | grep -q "se rompió algo" && ok "T10 Preview_Unreadable_IsRed — con un 500, rojo con el código y el principio del cuerpo" \
    || no "T10 Preview_Unreadable_IsRed — con un 500 salió $rc: $(tail -1 "$TMP/salida.txt")"
  rc=$(corre t10_html)
  [ "$rc" = "1" ] && salida | grep -q "502 Bad Gateway" && ok "T10 Preview_Unreadable_IsRed — …y con HTML, igual" \
    || no "T10 Preview_Unreadable_IsRed — con HTML salió $rc"
  llamo "POST /api/admin/plugins/7/activate" && no "🔴 T10 Preview_Unreadable_IsRed — activó con una vista previa ilegible" || ok "T10 Preview_Unreadable_IsRed — …sin activar nada"
fi

# ── T11 / T12 · las opciones pendientes declaradas ────────────────────────────────────────────
DECL="$TMP/pendientes.json"
# fechas fijas lejos de hoy para los dos lados: una vigente y una vencida, sin depender del reloj de la máquina
MANANA=2999-12-31
AYER=2000-01-01
declara() { printf '{"revision":"%s","opciones":[{"opcion":"Pagos:Clave","motivo":"el servicio de pagos todavía no existe; el único endpoint que la usa devuelve un error claro"}]}\n' "$1" > "$DECL"; }
t11() { base; previa_nueva "$FALTA_X"; }
if quiere nuevo; then
  declara "$MANANA"; rc=$(corre t11 --pending-options "$DECL")
  [ "$rc" = "0" ] && salida | grep -q "DECLARADAS como pendientes" && ok "T11 PendingOptions_Declared_WarnAndPass — la faltante declarada con motivo y fecha vigente avisa y no frena" \
    || no "T11 PendingOptions_Declared_WarnAndPass — salió $rc: $(tail -2 "$TMP/salida.txt")"
  declara "$AYER"; rc=$(corre t11 --pending-options "$DECL")
  [ "$rc" = "1" ] && ok "T12 PendingOptions_Expired_Stop — una declaración vencida frena" || no "🔴 T12 PendingOptions_Expired_Stop — la vencida amparó ($rc)"
  for basura in pronto 2026-13-45 2026-02-30; do
    declara "$basura"; rc=$(corre t11 --pending-options "$DECL")
    [ "$rc" = "1" ] && salida | grep -q "no es una fecha" && ok "T12 PendingOptions_Expired_Stop — una fecha que no es fecha («${basura}») frena" \
      || no "🔴 T12 PendingOptions_Expired_Stop — «${basura}» amparó como si fuera una fecha que nunca vence ($rc)"
  done
fi

# ── T13 · el freno actúa antes de migrar y de activar ─────────────────────────────────────────
t13() { base; resp /api/admin/plugins/7/set-default/preview "{\"pluginId\":7,\"pluginName\":\"miplugin\",\"targetVersion\":\"1.0.7\",\"missingSettings\":$FALTA_X,\"alreadyStarted\":false,\"manifestDeclaresSettings\":true,\"manifestUnreadable\":false,\"migrationAnalysisFailed\":false,\"pendingCount\":2,\"rollbackCount\":0}" 200; }
if quiere nuevo; then
  rc=$(corre t13)
  [ "$rc" = "1" ] && ok "T13 Brake_ActsBeforeMigrateAndActivate — una faltante no declarada frena" || no "🔴 T13 Brake_ActsBeforeMigrateAndActivate — salió $rc"
  if llamo "POST /api/admin/plugins/7/migrations/execute" || llamo "POST /api/admin/plugins/7/activate" || llamo "POST /api/admin/plugins/7/set-default"; then
    no "🔴 T13 Brake_ActsBeforeMigrateAndActivate — tocó la base o la memoria del host antes de frenar: $(tr '\n' ' ' < "$TMP/llamadas.txt")"
  else
    ok "T13 Brake_ActsBeforeMigrateAndActivate — …sin haber llamado a migraciones, activar ni marcar"
  fi
fi

# ── T14 / T24 · la red de pruebas: método, cuerpo y orden ─────────────────────────────────────
if quiere ambos; then
  rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; : > "$TMP/llamadas.txt"
  resp_m GET /api/x '{"lado":"lectura"}' 200; resp_m PUT /api/x '{"lado":"escritura"}' 200
  L=$(RESP="$TMP/respuestas" LLAMADAS="$TMP/llamadas.txt" "$TMP/bin/curl" -s -w "\n%{http_code}" http://host/api/x | head -1)
  E=$(RESP="$TMP/respuestas" LLAMADAS="$TMP/llamadas.txt" "$TMP/bin/curl" -s -w "\n%{http_code}" -X PUT http://host/api/x -H "Content-Type: application/json" --data '{"v":1}' | head -1)
  [ "$L" = '{"lado":"lectura"}' ] && [ "$E" = '{"lado":"escritura"}' ] && grep -qx '  cuerpo: {"v":1}' "$TMP/llamadas.txt" \
    && ok "T14 FakeCurl_DistinguishesMethodAndCapturesBody — un GET y un PUT a la misma ruta reciben respuestas distintas, y el cuerpo del PUT queda guardado" \
    || no "🔴 T14 FakeCurl_DistinguishesMethodAndCapturesBody — GET=«${L}» PUT=«${E}»; llamadas: $(tr '\n' '|' < "$TMP/llamadas.txt")"
  [ "$(grep -v '^  ' "$TMP/llamadas.txt" | tr '\n' '|')" = "GET /api/x|PUT /api/x|" ] \
    && ok "T24 FakeCurl_LogsCallsInOrder — el registro tiene método y ruta, en el orden en que se llamaron" \
    || no "🔴 T24 FakeCurl_LogsCallsInOrder — registro: $(tr '\n' '|' < "$TMP/llamadas.txt")"
fi

# ── T15 · el ZIP de prueba es un ZIP de verdad ────────────────────────────────────────────────
if quiere ambos; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$ZIP" plugin.json 2>/dev/null | jq -e '.name=="miplugin" and .version=="1.0.7"' >/dev/null 2>&1 \
      && ok "T15 TestZip_IsRealZip — unzip -p devuelve el plugin.json del paquete de prueba" \
      || no "🔴 T15 TestZip_IsRealZip — el paquete de prueba no es un ZIP con plugin.json"
  else
    no "T15 TestZip_IsRealZip — no hay unzip para leer el paquete de prueba (no se midió: no es verde)"
  fi
fi

# ── T17 · host actualizado: los dos caminos leen de la vista previa, sin puente ───────────────
t17_subida() { base; previa_nueva '[]'; }
t17_recorrida() { base; recorrida; previa_nueva '[]'; }
if quiere nuevo; then
  for esc in t17_subida t17_recorrida; do
    rc=$(corre "$esc")
    if [ "$rc" = "0" ] && llamo "POST /api/admin/plugins/7/set-default/preview" && ! llamo "GET /api/admin/plugins/7" \
       && ! grep -q '^\[puente-config\]' "$TMP/salida.txt" && ! salida | grep -q 'NO PUDO MEDIR'; then
      ok "T17 UpdatedHost_UsesPreviewOnBothPaths — $esc: lee de la vista previa, sin caer al camino viejo"
    else
      no "🔴 T17 UpdatedHost_UsesPreviewOnBothPaths — $esc: rc=$rc; llamadas: $(grep -v '^  ' "$TMP/llamadas.txt" | tr '\n' '|')"
    fi
  done
fi

# ── T19 · la secuencia del despliegue no cambia ───────────────────────────────────────────────
t19() { base
  resp_seq /api/admin/plugins/7/set-default/preview '{"pluginId":7,"pluginName":"miplugin","targetVersion":"1.0.7","missingSettings":[],"alreadyStarted":false,"manifestDeclaresSettings":true,"manifestUnreadable":false,"migrationAnalysisFailed":false,"pendingCount":1,"rollbackCount":0}' 200
  resp_seq /api/admin/plugins/7/set-default/preview '{"pluginId":7,"pluginName":"miplugin","targetVersion":"1.0.7","missingSettings":[],"alreadyStarted":false,"manifestDeclaresSettings":true,"manifestUnreadable":false,"migrationAnalysisFailed":false,"pendingCount":0,"rollbackCount":0}' 200
  resp /api/admin/plugins/7/migrations/execute '{"applied":1,"failed":0}' 200; }
if quiere nuevo; then
  rc=$(corre t19)
  ORDEN=$(grep -v -e '^  ' -e '/api/auth/login' "$TMP/llamadas.txt" | tr '\n' '|')
  ESPERADO="POST /api/admin/plugins/upload|POST /api/admin/plugins/7/set-default/preview|POST /api/admin/plugins/7/migrations/execute|POST /api/admin/plugins/7/set-default/preview|POST /api/admin/plugins/7/activate|GET /api/admin/plugins/7/health|POST /api/admin/plugins/7/set-default|"
  [ "$rc" = "0" ] && [ "$ORDEN" = "$ESPERADO" ] && ok "T19 DeploySequence_Unchanged — subir, vista previa, migraciones, vista previa, activar, salud y marcar; nada en el medio" \
    || no "🔴 T19 DeploySequence_Unchanged — rc=$rc; orden: $ORDEN"
fi

# ── T20 · una salida posterior a activar recupera la anterior ─────────────────────────────────
t20() { base; previa_nueva '[]'; resp /api/admin/plugins/7/set-default '{"error":"no"}' 400
  resp_m GET /api/admin/plugins '[{"pluginId":6,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200; }
if quiere nuevo; then
  rc=$(corre t20)
  [ "$rc" = "1" ] && [ "$(grep -v '^  ' "$TMP/llamadas.txt" | tail -1)" = "POST /api/admin/plugins/6/activate" ] \
    && ok "T20 ExitAfterActivate_RecoversPrevious — marcar se niega: rojo, y la última llamada vuelve a activar la versión anterior" \
    || no "🔴 T20 ExitAfterActivate_RecoversPrevious — rc=$rc; última llamada: $(grep -v '^  ' "$TMP/llamadas.txt" | tail -1)"
fi

# ── T21 · el manifiesto ilegible no es «no falta nada» ────────────────────────────────────────
t21() { base; previa_nueva '[]' '"manifestUnreadable":true'; }
t21_sin_lista() { base; recorrida; resp /api/admin/plugins/7/set-default/preview '{"pluginId":7,"manifestUnreadable":true,"migrationAnalysisFailed":false,"pendingCount":0,"rollbackCount":0}' 200; }
t26() { base; previa_nueva '[]' '"manifestDeclaresSettings":false'; }
if quiere nuevo; then
  rc=$(corre t21)
  [ "$rc" = "1" ] && salida | grep -q "manifiesto" && ! llamo "POST /api/admin/plugins/7/activate" \
    && ok "T21 Preview_ManifestUnreadable_IsCouldNotMeasure — con el manifiesto ilegible, rojo diciendo que no lo pudo leer" \
    || no "🔴 T21 Preview_ManifestUnreadable_IsCouldNotMeasure — rc=$rc: lo leyó como «no falta nada»"
  rc=$(corre t21_sin_lista)
  [ "$rc" = "1" ] && salida | grep -q "manifiesto" && ! salida | grep -q "NO PUDO MEDIR" \
    && ok "T21 Preview_ManifestUnreadable_IsCouldNotMeasure — …también cuando el host no manda la lista: no cae al puente" \
    || no "🔴 T21 Preview_ManifestUnreadable_IsCouldNotMeasure — sin la lista, el manifiesto ilegible cayó al puente (rc=$rc)"
  rc=$(corre t26)
  [ "$rc" = "0" ] && salida | grep -q "no falta ninguna opción" \
    && ok "T26 Preview_ManifestDeclaresNoSettings_Passes — un manifiesto que no declara opciones, con la lista vacía, pasa" \
    || no "T26 Preview_ManifestDeclaresNoSettings_Passes — salió $rc: $(tail -2 "$TMP/salida.txt")"
fi

# ── T22 · el análisis de migraciones que no corrió no es «sin pendientes» ─────────────────────
t22_fallo() { base; previa_nueva '[]' '"migrationAnalysisFailed":true,"migrationAnalysisError":"zip corrupto"'; }
t22_nulo() { base; resp /api/admin/plugins/7/set-default/preview '{"pluginId":7,"pluginName":"miplugin","targetVersion":"1.0.7","missingSettings":[],"alreadyStarted":false,"manifestDeclaresSettings":true,"manifestUnreadable":false,"migrationAnalysisFailed":false,"pendingCount":null,"rollbackCount":null}' 200; }
t22_ausente() { base; resp /api/admin/plugins/7/set-default/preview '{"pluginId":7,"missingSettings":[],"manifestUnreadable":false,"migrationAnalysisFailed":false}' 200; }
if quiere nuevo; then
  for esc in t22_fallo t22_nulo t22_ausente; do
    rc=$(corre "$esc")
    if [ "$rc" = "1" ] && ! llamo "POST /api/admin/plugins/7/migrations/execute" && ! llamo "POST /api/admin/plugins/7/activate" && ! salida | grep -q "Sin migraciones pendientes"; then
      ok "T22 Preview_MigrationAnalysisFailedOrNullCounts_IsRed — $esc: rojo, sin migrar ni activar"
    else
      no "🔴 T22 Preview_MigrationAnalysisFailedOrNullCounts_IsRed — $esc: rc=$rc; lo leyó como «sin migraciones pendientes»"
    fi
  done
fi

# ── T23 · la lista de objetos no se lee con la expresión de la subida ─────────────────────────
t23() { base; previa_nueva '[{"key":"Correo:Servidor","reason":"vacia-en-ambas"}]'; }
t23_rara() { base; previa_nueva '"Correo:Servidor"'; }
t23_vacia() { base; previa_nueva '[{"key":"","reason":"opcion-nueva"}]'; }
if quiere nuevo; then
  rc=$(corre t23)
  [ "$rc" = "1" ] && salida | grep -q "Correo:Servidor" && ok "T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — la lista de objetos se lee por su clave y frena nombrándola" \
    || no "🔴 T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — la lista de objetos quedó vacía y la corrida siguió (rc=$rc)"
  rc=$(corre t23_rara)
  [ "$rc" = "1" ] && salida | grep -q "no pude leer" && ok "T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — …y una forma que no se puede leer es rojo, no una lista vacía" \
    || no "🔴 T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — una lista ilegible salió $rc"
  rc=$(corre t23_vacia)
  [ "$rc" = "1" ] && salida | grep -q "no pude leer" && ok "T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — …y una opción con la clave vacía es rojo, no se descarta" \
    || no "🔴 T23 Preview_ObjectList_ReadWithUploadExpression_IsRed — una clave vacía se descartó y la corrida salió $rc"
fi

# ── T25 · el texto del host no puede colar comandos de Azure ──────────────────────────────────
# Azure ejecuta como comando toda línea que empieza con `##vso[`. Un salto de línea dentro de algo que manda el host
# (una clave, un motivo, el identificador) no puede dejar una línea así.
t25_clave() { base; resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":["Pagos:Clave\n##vso[task.setvariable variable=inyectado]si"]}' 200; }
t25_motivo() { base; previa_nueva '[]' '"migrationAnalysisFailed":true,"migrationAnalysisError":"zip roto\n##vso[task.complete result=Succeeded]listo"'; }
t25_id() { base; resp /api/admin/plugins/upload '{"pluginId":"7/../9","missingSettings":[]}' 200; }
if quiere ambos; then
  for esc in t25_clave t25_motivo; do
    rc=$(corre "$esc")
    if [ "$rc" = "1" ] && ! grep -qE '^##vso\[task\.(setvariable|complete)' "$TMP/salida.txt"; then
      ok "T25 HostText_CannotInjectAzureCommands — $esc: rojo, y ninguna línea de la salida es un comando que el host coló"
    else
      no "🔴 T25 HostText_CannotInjectAzureCommands — $esc: rc=$rc; línea colada: $(grep -E '^##vso\[task\.(setvariable|complete)' "$TMP/salida.txt" | head -1)"
    fi
  done
  rc=$(corre t25_id)
  if [ "$rc" = "1" ] && ! grep -q '\.\./' "$TMP/llamadas.txt"; then
    ok "T25 HostText_CannotInjectAzureCommands — un identificador con «../» es rojo y no se usa para armar direcciones"
  else
    no "🔴 T25 HostText_CannotInjectAzureCommands — identificador con «../»: rc=$rc; llamadas: $(grep -v '^  ' "$TMP/llamadas.txt" | tr '\n' '|')"
  fi
fi

echo "─────────────"
# un filtro mal escrito (TYCON_TEST_HOST=nuev) no corre ningún caso: eso no es verde
[ $((OK + MAL)) -gt 0 ] || { echo "❌ deploy-plugin-config: no corrió ningún caso (¿TYCON_TEST_HOST=${TYCON_TEST_HOST:-}? vale viejo o nuevo)"; exit 1; }
[ $MAL -eq 0 ] && { echo "✅ deploy-plugin-config: todo verde ($OK casos)"; exit 0; }
echo "❌ deploy-plugin-config: $MAL de $((OK+MAL))"; exit 1
