#!/usr/bin/env bash
# deploy-plugin.test.sh — los casos del guion de despliegue de plugins.
#
# 🔴 QUÉ PRUEBA, Y POR QUÉ ASÍ. La secuencia de despliegue estuvo mal escrita CUATRO veces en el
# plan de cierre, y las cuatro habrían salido VERDES en una corrida real: dejaban producción rota
# sin que nada se pusiera rojo. O sea que lo que hay que probar no es "el camino feliz funciona":
# es que **cada forma de fallar termina en rojo**, y que la versión anterior queda recuperada.
#
# No toca la red: se inyecta un `curl` falso por PATH que responde según el guion del caso.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUION="$DIR/../ci/deploy-plugin.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OK=0; MAL=0
ok() { echo "✅ desplegar: $1"; OK=$((OK+1)); }
no() { echo "❌ desplegar: $1"; MAL=$((MAL+1)); }

# El host simulado vive en un ayudante compartido con la suite del freno de configuración
# (scripts/tests/lib/fake-plugin-host.sh): distingue el método, guarda lo que se manda y anota las llamadas en orden.
# El paquete de prueba es un ZIP de verdad, con su plugin.json.
. "$DIR/lib/fake-plugin-host.sh"
ZIP="$TMP/miplugin.1.0.7-abc.zip"
fph_zip "$ZIP" || no "no hay zip ni python3 para armar el paquete de prueba — los casos corren con un archivo que no es un ZIP (no es verde)"
corre() {
  rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; : > "$TMP/llamadas.txt"
  printf '{}\n200\n' > "$TMP/respuestas/default"
  "$@"
  PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" LLAMADAS="$TMP/llamadas.txt" bash "$GUION" \
    --url http://host --user u --password c --zip "$ZIP" --endpoint /api/admin/plugins/upload >"$TMP/salida.txt" 2>&1
  echo $?
}
fph_init

# Respuestas del camino feliz, que cada caso pisa donde necesita.
feliz() {
  resp /api/auth/login '{"token":"t"}' 200
  resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":[]}' 200
  resp /api/admin/plugins/7/set-default/preview '{"pendingCount":0,"rollbackCount":0}' 200
  resp /api/admin/plugins/7/activate '{}' 200
  resp /api/admin/plugins/7/health '{}' 200
  resp /api/admin/plugins/7/set-default '{}' 200
}

# ── 1. el camino feliz llama a LAS CUATRO, en orden ────────────────────────────────────────────
rc=$(corre feliz)
[ "$rc" = "0" ] && ok "el camino feliz sale bien" || no "el camino feliz salió $rc — $(tail -2 "$TMP/salida.txt")"
for p in "1/5" "2/5" "4/5" "5/5"; do
  grep -q "$p" "$TMP/salida.txt" || no "🔴 el camino feliz se saltó el paso $p — es exactamente el error que se cometió 4 veces"
done
grep -q "$(printf 'Marcar como actual')" "$TMP/salida.txt" && ok "🔴 marca como actual (sin esto, el próximo reinicio del host no carga NINGUNA versión — el error de la v4)" || no "no marcó como actual"

# ── 2. una migración que falla NO activa nada ──────────────────────────────────────────────────
caso2() { feliz; resp /api/admin/plugins/7/set-default/preview '{"pendingCount":2,"rollbackCount":0}' 200
          resp /api/admin/plugins/7/migrations/execute '{"applied":1,"failed":1}' 200; }
rc=$(corre caso2)
[ "$rc" = "1" ] && ok "🔴 una migración fallida termina en rojo (el host devuelve 200 con un contador de fallidas: 200 NO es 'se aplicaron')" || no "migración fallida salió $rc, debía ser 1"
grep -q "4/5" "$TMP/salida.txt" && no "🔴 activó con una migración fallida" || ok "…y no llegó a activar"

# ── 3. un retroceso de base de datos NO toca nada ──────────────────────────────────────────────
caso3() { feliz; resp /api/admin/plugins/7/set-default/preview '{"pendingCount":0,"rollbackCount":3}' 200; }
rc=$(corre caso3)
[ "$rc" = "1" ] && ok "🔴 un retroceso de base de datos frena ANTES de tocar la memoria (la anterior sigue cargada y marcada)" || no "retroceso salió $rc"
grep -qE "4/5|5/5" "$TMP/salida.txt" && no "🔴 tocó la memoria con un retroceso pendiente" || ok "…sin haber activado ni marcado"

# ── 4. faltan opciones de configuración ────────────────────────────────────────────────────────
caso4() { feliz; resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":["Claude:ApiKey"]}' 200; }
rc=$(corre caso4)
[ "$rc" = "1" ] && ok "🔴 si el host dice que faltan opciones de configuración, es rojo (con la versión sin marcar el host NO frena solo)" || no "opciones faltantes salió $rc"
grep -q "Claude:ApiKey" "$TMP/salida.txt" && ok "…y dice cuál falta" || no "no nombró la opción faltante"

# ── 5. modo degradado: cargó, pero sus servicios no arrancaron ─────────────────────────────────
caso5() { feliz; resp /api/admin/plugins/7/health '{"errorMessage":"el worker de cola no arrancó"}' 200; }
rc=$(corre caso5)
[ "$rc" = "1" ] && ok "🔴 el modo degradado es rojo (el host responde 200 y guarda el motivo en vez de fallar)" || no "modo degradado salió $rc"
grep -q "5/5" "$TMP/salida.txt" && no "🔴 marcó como actual una versión degradada" || ok "…y no la marcó como actual"

# ── 6. la activación falla → se recupera la anterior ───────────────────────────────────────────
caso6() { feliz; resp /api/admin/plugins/7/activate '{"error":"no cargó"}' 500
          resp /api/admin/plugins '[{"pluginId":6,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200; }
rc=$(corre caso6)
[ "$rc" = "1" ] && ok "🔴 una activación fallida es rojo" || no "activación fallida salió $rc"
grep -q "recuperarla\|vuelta a cargar" "$TMP/salida.txt" && ok "…y se recupera la anterior (el host descarga la vieja ANTES de validar la nueva: si no, no queda NINGUNA cargada)" || no "no intentó recuperar la anterior"

# ── 7. marcar como actual se niega → se recupera la anterior ──────────────────────────────────
caso7() { feliz; resp /api/admin/plugins/7/set-default '{"error":"no"}' 400
          resp /api/admin/plugins '[{"pluginId":6,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200; }
rc=$(corre caso7)
[ "$rc" = "1" ] && ok "🔴 si marcar como actual se niega, es rojo" || no "marcar negado salió $rc"
grep -q "recupero la anterior" "$TMP/salida.txt" && ok "…y no queda la nueva cargada sin marca (el estado por el que se rechazó la v4 del plan)" || no "no recuperó la anterior"

# ── 8. re-corrida: el paquete ya existe ────────────────────────────────────────────────────────
caso8() { feliz; resp /api/admin/plugins/upload '{"error":"already exists"}' 409
          resp /api/admin/plugins '[{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}]' 200; }
rc=$(corre caso8)
[ "$rc" = "0" ] && ok "una re-corrida con el paquete ya subido resuelve el identificador y sigue" || no "re-corrida salió $rc — $(tail -3 "$TMP/salida.txt")"
grep -q "NO PUDO MEDIR" "$TMP/salida.txt" && ok "…y, con un host que no contesta qué opciones faltan, dice que no pudo medir la configuración" || no "🔴 la re-corrida contra un host viejo pasó sin decir que no midió la configuración"

# ── 9. …pero un conflicto de migraciones con el MISMO código es rojo ──────────────────────────
caso9() { feliz; resp /api/admin/plugins/upload '{"error":"migration 003 was modified after being applied"}' 409; }
rc=$(corre caso9)
[ "$rc" = "1" ] && ok "🔴 el otro rechazo con el mismo código (una migración aplicada que cambió) SÍ es rojo" || no "conflicto de migración salió $rc"

# ── 10. la re-corrida NO se saltea el chequeo de configuración ─────────────────────────────────
# 🔴 El host simulado contesta como el de verdad: `GET /api/admin/plugins/{id}` no trae `missingSettings`, y la lista
# viene en la vista previa, con su motivo. Simular el campo en esa consulta haría pasar en verde justo el defecto que
# este caso tiene que cazar.
caso10() { feliz; resp /api/admin/plugins/upload '{"error":"already exists"}' 409
           resp /api/admin/plugins '[{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}]' 200
           resp /api/admin/plugins/7 '{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}' 200
           resp /api/admin/plugins/7/set-default/preview '{"pluginId":7,"missingSettings":[{"key":"Voip:PbxId","reason":"vacia-en-ambas"}],"manifestUnreadable":false,"migrationAnalysisFailed":false,"pendingCount":0,"rollbackCount":0}' 200; }
rc=$(corre caso10)
[ "$rc" = "1" ] && grep -q "Voip:PbxId" "$TMP/salida.txt" && ok "🔴 en la re-corrida la lista de faltantes se lee de la vista previa, y sigue frenando nombrando la opción" || no "re-corrida con faltantes salió $rc"

# ── 🔴 RETROCESO: SE MIRA CUÁLES, NO CUÁNTAS (2026-09-03) ───────────────────────────────────────
# Un retroceso de base de datos frena, y eso no cambia. Pero hay migraciones que el paquete deja
# afuera A PROPÓSITO (declaradas en excludedMigrations, con su motivo): el host las tiene aplicadas y
# las lee como retroceso, así que CONTAR retrocesos frenaba un despliegue por una decisión ya tomada.
# Medido en Lapacho: la 006 está excluida desde el 29 de agosto y era el único "retroceso".
retro() { # <json de rollbacksNeeded>
  feliz; resp /api/admin/plugins/7/set-default/preview "{\"pendingCount\":0,\"rollbackCount\":1,\"rollbacksNeeded\":$1}" 200; }
corre_ex() { rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; retro "$1"
  PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" bash "$GUION" --url http://host --user u --password c --zip "$ZIP" \
    --endpoint /api/admin/plugins/upload ${2:+--exclusions "$2"} >"$TMP/salida.txt" 2>&1; echo $?; }

UNA='[{"migrationName":"006_SegMensajesIdCompat","hasRollbackScript":true}]'
rc=$(corre_ex "$UNA")
[ "$rc" = "1" ] && ok "🔴 un retroceso SIN exclusión declarada frena (lo de siempre)" || no "🔴 el retroceso sin declarar salió $rc"

rc=$(corre_ex "$UNA" "006")
[ "$rc" = "0" ] && ok "…y si esa misma migración está en excludedMigrations, sigue" || no "🔴 la excluida a propósito igual frenó ($rc): $(tail -2 "$TMP/salida.txt")"
grep -q "A PROPÓSITO" "$TMP/salida.txt" && ok "…dejando constancia de cuál y por qué se dejó pasar" || no "🔴 pasó sin decir nada"

rc=$(corre_ex "$UNA" "014")
[ "$rc" = "1" ] && ok "declarar OTRA migración no ampara a la que retrocede" || no "🔴 amparó por tener lista, sin mirar cuál ($rc)"

DOS='[{"migrationName":"006_SegMensajesIdCompat"},{"migrationName":"009_Otra"}]'
rc=$(corre_ex "$DOS" "006")
[ "$rc" = "1" ] && ok "con dos retrocesos y una sola declarada, frena por la otra" || no "🔴 con una sin declarar salió $rc"
grep -q "009_Otra" "$TMP/salida.txt" && ok "…y nombra exactamente la que falta declarar" || no "no nombró la no declarada"

rc=$(corre_ex '[]' "006")
[ "$rc" = "1" ] && ok "🔴 si el host dice que hay retroceso pero no dice CUÁL, frena (no sé ≠ declarado)" || no "🔴 sin nombres salió $rc — amparó a ciegas"

# ── 🔴 TODA SALIDA POSTERIOR A "ACTIVAR" RECUPERA LA ANTERIOR (2026-09-03) ──────────────────────
# Activar descarga la vieja y carga la nueva, pero NO toca la marca de "actual". Cualquier fallo
# DESPUES de ese punto deja el peor estado: la nueva a medias y la anterior marcada pero descargada
# — el host sirve algo roto AHORA y al proximo reinicio no carga NINGUNA version. Los dos caminos
# viejos recuperaban; los TRES del chequeo de salud, agregados el mismo dia, no. Estos casos exigen
# que las cinco salidas dejen el host en un estado del que se pueda volver.
lista_con_anterior() { resp /api/admin/plugins '[{"pluginId":5,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200; }

degradado() { feliz; lista_con_anterior; resp /api/admin/plugins/7/health '{"errorMessage":"el worker de cola no arranco"}' 200; }
rc=$(corre degradado)
[ "$rc" = "1" ] && ok "modo degradado: rojo" || no "degradado salio $rc"
grep -q "vuelta a cargar" "$TMP/salida.txt" \
  && ok "🔴 …y RECUPERA la anterior (si no, el host queda roto y al reiniciar no carga nada)" \
  || no "🔴 degradado: NO recupero la anterior — la nueva queda a medias y la anterior marcada pero descargada"

salud_ilegible() { feliz; lista_con_anterior; resp /api/admin/plugins/7/health '<html>502</html>' 200; }
rc=$(corre salud_ilegible)
[ "$rc" = "1" ] && grep -q "vuelta a cargar" "$TMP/salida.txt" \
  && ok "🔴 salud ilegible: rojo Y recupera la anterior" \
  || no "🔴 salud ilegible ($rc): no recupero la anterior"

salud_500() { feliz; lista_con_anterior; resp /api/admin/plugins/7/health '{"error":"boom"}' 500; }
rc=$(corre salud_500)
[ "$rc" = "1" ] && grep -q "vuelta a cargar" "$TMP/salida.txt" \
  && ok "🔴 salud que no se pudo leer: rojo Y recupera la anterior" \
  || no "🔴 salud 500 ($rc): no recupero la anterior"

# Y si no hay anterior que recuperar, se DICE (no se calla ni finge haberla recuperado)
sin_anterior() { feliz; resp /api/admin/plugins '[{"pluginId":7,"name":"miplugin","isDefault":false}]' 200
  resp /api/admin/plugins/7/health '{"errorMessage":"roto"}' 200; }
rc=$(corre sin_anterior)
[ "$rc" = "1" ] && ok "sin anterior marcada, sigue siendo rojo" || no "sin anterior salio $rc"
grep -qE "no encontr|NO pude recuperar|NO pude leer la lista" "$TMP/salida.txt" \
  && ok "…y lo DICE, en vez de callarse o fingir que recupero" \
  || no "🔴 no dijo que no habia anterior que recuperar"

# ── 🔴 LA VISTA PREVIA ILEGIBLE NO ES "0 Y 0" (2026-09-03) ──────────────────────────────────────
# `jq -r \'.campo // 0\'` sobre un cuerpo vacio o que no es JSON devuelve 0 sin quejarse, asi que EL
# freno del despliegue imprimia "pendientes 0 - retrocesos 0" sin haber leido nada: no ejecutaba
# migraciones y no revisaba retrocesos. La negativa aparecia mas tarde, al activar o al marcar, y
# para entonces el host ya habia descargado la version anterior.
previa_html() { feliz; resp /api/admin/plugins/7/set-default/preview '<html>502 Bad Gateway</html>' 200; }
rc=$(corre previa_html)
[ "$rc" = "1" ] && ok "🔴 vista previa ilegible: frena ANTES de tocar nada (no la lee como 0 y 0)" || no "🔴 la vista previa ilegible salio $rc — aprobo sin haber leido"
previa_vacia() { feliz; resp /api/admin/plugins/7/set-default/preview '' 200; }
rc=$(corre previa_vacia)
[ "$rc" = "1" ] && ok "…y con cuerpo vacio, igual" || no "🔴 la vista previa vacia salio $rc"

# ── 🔴 LA RECUPERACION NO PUEDE MENTIR (2026-09-03) ─────────────────────────────────────────────
# `api()` no usa --fail, asi que curl sale 0 con un 500 o con el HTML del proxy. El `if` juzgaba por
# el codigo de salida de curl y afirmaba "version anterior vuelta a cargar" sin haberlo medido: la
# corrida quedaba en rojo pero el registro decia lo contrario de lo que paso, y el operador creia
# que el host seguia sirviendo la version vieja cuando no habia NINGUNA cargada.
recup_falla() { feliz
  resp /api/admin/plugins '[{"pluginId":5,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200
  resp /api/admin/plugins/7/activate '{"error":"no cargo"}' 500
  resp /api/admin/plugins/5/activate '{"error":"tampoco"}' 500; }
rc=$(corre recup_falla)
[ "$rc" = "1" ] && ok "activacion fallida + recuperacion fallida: sigue siendo rojo" || no "salio $rc"
grep -q "vuelta a cargar" "$TMP/salida.txt" \
  && no "🔴 DIJO que recupero la anterior y el host contesto 500 — el registro miente sobre el estado del host" \
  || ok "🔴 …y NO afirma haber recuperado: dice que quedo sin cargar"
grep -q "a mano" "$TMP/salida.txt" \
  && ok "…y le dice al operador que hay que activarla a mano" || no "no dijo que hay que intervenir"

# ── 🔴 LA RECUPERACION NO TOCA UN PLUGIN AJENO (2026-09-03) ─────────────────────────────────────
# La recuperacion buscaba "el primer plugin marcado como actual que no sea yo". En un host con varios
# plugins eso reactiva uno AJENO, imprime "version anterior vuelta a cargar" y deja el nuestro
# descargado: se toca algo que nadie pidio tocar y el registro dice lo contrario de lo que paso.
ajeno() { feliz
  resp /api/admin/plugins '[{"pluginId":9,"name":"otroplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]' 200
  resp /api/admin/plugins/7/health '{"errorMessage":"roto"}' 200; }
rc=$(corre ajeno)
[ "$rc" = "1" ] && ok "con un plugin ajeno marcado, sigue siendo rojo" || no "el caso del ajeno salio $rc"
grep -q "vuelta a cargar" "$TMP/salida.txt" \
  && no "🔴 REACTIVO UN PLUGIN AJENO y dijo que recupero la anterior — toco algo que nadie pidio tocar" \
  || ok "🔴 …y NO reactiva el plugin ajeno (dice que no encontro otra version DE ESTE plugin)"

# ── 🔴 LA APROBACIÓN DEL RETROCESO NO SE MANDA SI NO CORRESPONDE (2026-09-03) ────────────────────
# El host se niega a marcar como actual una version que retrocede migraciones salvo que se le mande
# `rollbackApproved`. Esa aprobacion la genera la lista de exclusiones deliberadas — no es una
# bandera de conveniencia. Lo que estos casos cuidan es lo contrario de lo obvio: que NO viaje cuando
# no hay retroceso, y que un retroceso no declarado siga frenando antes de tocar nada.
sin_retro() { feliz; }
rc=$(corre sin_retro)
[ "$rc" = "0" ] && ok "sin retrocesos, el despliegue pasa" || no "el caso sin retrocesos salio $rc"
grep -q "del retroceso: cada" "$TMP/salida.txt" \
  && no "🔴 mando la aprobacion de retroceso SIN haber ningun retroceso" \
  || ok "…y NO manda ninguna aprobacion de retroceso (no habia nada que aprobar)"

con_declarada() { feliz
  resp /api/admin/plugins/7/set-default/preview '{"pendingCount":0,"rollbackCount":1,"rollbacksNeeded":[{"migrationName":"006_X"}]}' 200; }
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; con_declarada
PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" bash "$GUION" --url http://host --user u --password c --zip "$ZIP" \
  --endpoint /api/admin/plugins/upload --exclusions "006" >"$TMP/salida.txt" 2>&1; rc=$?
[ "$rc" = "0" ] && ok "con la unica que retrocede declarada, el despliegue pasa" || no "🔴 la declarada frenó ($rc)"
grep -q "del retroceso: cada" "$TMP/salida.txt" \
  && ok "🔴 …y recien ahi manda la aprobacion, atada a la exclusion declarada" \
  || no "🔴 no mando la aprobacion: el host se va a negar a marcarla como actual"

# ── 🔴 OPCIONES DE CONFIGURACIÓN PENDIENTES: SE DECLARAN, LO NO DECLARADO FRENA (2026-09-03) ────
# El host avisa qué opciones no tienen valor, y es lo único que dice sobre configuración. Frenar es
# lo correcto por default. Pero hay opciones que el equipo deja vacías A SABIENDAS (una credencial
# de un servicio externo que todavía no existe, con el código devolviendo un error claro en el único
# endpoint que la usa): frenar por ésas no protege nada y enseña a apagar el control. La puerta es la
# misma de las vulnerabilidades — motivo y fecha — y lo no declarado frena igual.
DECL="$TMP/pendientes.json"
falta() { feliz; resp /api/admin/plugins/upload '{"pluginId":7,"missingSettings":["Nimbo:ServiceSid"]}' 200; }
corre_con() { rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; falta
  PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" bash "$GUION" --url http://host --user u --password c --zip "$ZIP" \
    --endpoint /api/admin/plugins/upload ${1:+--pending-options "$1"} >"$TMP/salida.txt" 2>&1; echo $?; }

rc=$(corre_con)
[ "$rc" = "1" ] && ok "🔴 una opción faltante SIN declarar frena (el 90% del valor del control)" || no "🔴 una opción sin declarar salió $rc"

MANANA=$(date -u -v+30d +%Y-%m-%d 2>/dev/null || date -u -d '+30 days' +%Y-%m-%d)
AYER=$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d '-1 day' +%Y-%m-%d)
printf '{"revision":"%s","opciones":[{"opcion":"Nimbo:ServiceSid","motivo":"credencial de Twilio que todavia no existe; el servicio devuelve 503 en el unico endpoint que la usa"}]}\n' "$MANANA" > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "0" ] && ok "…y declarada con motivo y fecha, pasa" || no "🔴 la opción declarada igual frenó ($rc): $(tail -2 "$TMP/salida.txt")"
grep -q "DECLARADAS como pendientes" "$TMP/salida.txt" && ok "…dejando constancia, no en silencio" || no "🔴 la declarada pasó SIN dejar rastro"

printf '{"revision":"%s","opciones":[{"opcion":"Nimbo:ServiceSid","motivo":"vencida"}]}\n' "$AYER" > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "1" ] && ok "una declaración VENCIDA vuelve a frenar" || no "🔴 la declaración vencida siguió amparando ($rc)"

printf '{"opciones":[{"opcion":"Nimbo:ServiceSid","motivo":"sin fecha"}]}\n' > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "1" ] && ok "una declaración SIN fecha frena (una deuda sin fecha es permanente en silencio)" || no "🔴 sin fecha amparó igual ($rc)"

printf '{"revision":"%s","opciones":[{"opcion":"Nimbo:ServiceSid","motivo":""}]}\n' "$MANANA" > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "1" ] && ok "una declaración SIN motivo frena (sin motivo no es una decisión, es un permiso)" || no "🔴 sin motivo amparó igual ($rc)"

printf '{"revision":"%s","opciones":[{"opcion":"OtraCosa","motivo":"no es la que falta"}]}\n' "$MANANA" > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "1" ] && ok "declarar OTRA opción no ampara a la que falta" || no "🔴 amparó por tener el archivo, sin mirar cuál opción ($rc)"

echo 'esto no es json' > "$DECL"
rc=$(corre_con "$DECL")
[ "$rc" = "1" ] && ok "un archivo de declaraciones ilegible frena (ilegible no es un permiso)" || no "🔴 el archivo ilegible amparó ($rc)"

# ── 🔴 EL ESTADO DE SALUD SE LEÍA SIN MIRAR EL CÓDIGO HTTP (2026-09-03) ─────────────────────────
# El guion leía `errorMessage` del cuerpo de /health sin mirar el código: con un 500, un HTML del
# proxy o un cuerpo vacío, jq no encontraba el campo, el motivo quedaba vacío y se imprimía
# "activado y sin motivo de degradación". "Verde que significa no miré nada", adentro del guion que
# existe para evitar exactamente eso. El 404 es el único que no frena: esa versión del host no tiene
# el chequeo, y eso NO es "sano" — se dice.
caso13() { feliz; resp /api/admin/plugins/7/health '{"error":"boom"}' 500; }
rc=$(corre caso13)
[ "$rc" = "1" ] && ok "🔴 si no se pudo leer el estado de salud (HTTP 500), NO aprueba" || no "🔴 salud ilegible (500) salió $rc — aprobó sin haber mirado"

caso14() { feliz; resp /api/admin/plugins/7/health '<html>502 Bad Gateway</html>' 200; }
rc=$(corre caso14)
[ "$rc" = "1" ] && ok "…ni cuando el proxy contesta HTML con un 200" || no "🔴 HTML del proxy con 200 salió $rc"

caso15() { feliz; resp /api/admin/plugins/7/health '{}' 404; }
rc=$(corre caso15)
[ "$rc" = "0" ] && ok "si el host no expone /health, el despliegue sigue (la capacidad no está)" || no "🔴 un 404 de /health frenó el despliegue en hosts que no lo tienen ($rc)"
grep -q "no expone /health" "$TMP/salida.txt" && ok "…pero queda dicho que NO se pudo verificar el modo degradado" || no "🔴 el 404 pasó EN SILENCIO — nadie se entera de que no se verificó"

# ── 🔴 la lista de plugins ENVUELTA (2026-09-03) ──────────────────────────────────────────────
# El host la devuelve a veces como arreglo y a veces envuelta en un objeto. La primera versión de
# este guion sólo entendía el arreglo: ante una respuesta envuelta la recuperación de la versión
# anterior fallaba EN SILENCIO, y el aviso de "no pude recuperar" vivía dentro del bloque que no se
# ejecutaba — o sea que el plugin quedaba descargado sin que nadie lo dijera. El humo ya manejaba
# las dos formas: los dos guiones discrepaban sobre el mismo host.
caso11() { feliz; resp /api/admin/plugins/7/activate '{"error":"no cargó"}' 500
           resp /api/admin/plugins '{"plugins":[{"pluginId":6,"name":"miplugin","isDefault":true},{"pluginId":7,"name":"miplugin","isDefault":false}]}' 200; }
rc=$(corre caso11)
[ "$rc" = "1" ] && ok "🔴 con la lista ENVUELTA, una activación fallida sigue siendo roja" || no "lista envuelta salió $rc"
grep -q "vuelta a cargar" "$TMP/salida.txt" && ok "…y recupera la versión anterior igual que con la lista suelta" || no "🔴 con la lista envuelta NO recuperó la anterior — el plugin queda descargado en silencio"

caso12() { feliz; resp /api/admin/plugins/upload '{"error":"already exists"}' 409
           resp /api/admin/plugins '{"value":[{"pluginId":7,"name":"miplugin","version":"1.0.7","isDefault":false}]}' 200; }
rc=$(corre caso12)
[ "$rc" = "0" ] && ok "…y en la re-corrida también resuelve el identificador con la lista envuelta" || no "re-corrida con lista envuelta salió $rc"

# ── 11. no se puede ni empezar ─────────────────────────────────────────────────────────────────
bash "$GUION" --url http://x --user u --password c --zip /no/existe --endpoint /api/x >/dev/null 2>&1
[ $? = 2 ] && ok "sin paquete sale 2 — 'no pude empezar' nunca se confunde con 'desplegado'" || no "sin paquete no salió 2"
bash "$GUION" --url http://x --user u --password c --zip "$ZIP" >/dev/null 2>&1
[ $? = 2 ] && ok "sin la ruta de subida sale 2 (Totora era el único que lo exigía)" || no "sin endpoint no salió 2"

# ── 12. story 2.10 · el INTENTO de desplegar queda anotado en la corrida ───────────────────────
# Dentro de una corrida de Azure, después de entrar al host y antes de subir nada: una línea
# `[registro-despliegue]` con estado «intentado», la etiqueta `despliegue-intentado`, y el entorno
# declarado en el archivo del job para que el humo del mismo job lo use. Un fallo ANTES del ingreso
# no deja nada: no se tocó el host.
REG=(TF_BUILD=True SYSTEM_TEAMPROJECT=Totora BUILD_REPOSITORY_NAME=Backend SYSTEM_STAGENAME=Deploy SYSTEM_JOBNAME=DeployToStaging BUILD_BUILDID=100)
ZREAL_DIR="$TMP/zipreal"; mkdir -p "$ZREAL_DIR"; ZREAL="$ZREAL_DIR/miplugin.1.0.7-abc.zip"
if command -v zip >/dev/null && command -v unzip >/dev/null; then
  ( cd "$ZREAL_DIR" && echo '{"name":"miplugin","version":"1.0.7","commitHash":"abc1234"}' > plugin.json && zip -q "$ZREAL" plugin.json && rm plugin.json )
fi
corre_reg() { # corre_reg <zip> <url> <usuario> <clave> <entorno|""> <var=valor>... — deja $TMP/salida.txt, imprime el rc
  local zip="$1" url="$2" usu="$3" cla="$4" ent="$5"; shift 5
  local extra=(); [ -n "$ent" ] && extra=(--environment "$ent")
  env "${REG[@]}" "$@" PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" bash "$GUION" \
    --url "$url" --user "$usu" --password "$cla" --zip "$zip" --endpoint /api/admin/plugins/upload "${extra[@]}" >"$TMP/salida.txt" 2>&1
  echo $?
}
linea_reg() { grep '^\[registro-despliegue\] ' "$TMP/salida.txt" | sed 's/^\[registro-despliegue\] //'; }
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
J="$TMP/job-a"; mkdir -p "$J"
if [ -f "$ZREAL" ]; then
  rc=$(corre_reg "$ZREAL" http://host u c staging AGENT_TEMPDIRECTORY="$J")
  [ "$rc" = "0" ] && ok "2.10 T12 con registro, el despliegue feliz sigue saliendo 0" || no "🔴 2.10 T12 el registro cambió el resultado del despliegue (rc=$rc): $(tail -3 "$TMP/salida.txt")"
  [ "$(grep -c '^\[registro-despliegue\] ' "$TMP/salida.txt")" = "1" ] && linea_reg | jq -e '.estado=="intentado" and .tipo=="plugin" and .artefacto=="miplugin" and .version=="1.0.7" and .hash=="abc1234" and .entorno=="staging" and .entorno_fuente=="declarado"' >/dev/null && ok "2.10 T12 una línea «intentado» con artefacto, versión, hash del plugin.json y entorno declarado" || no "🔴 2.10 T12 línea de intento fuera de contrato: $(linea_reg)"
  L_INT=$(grep -n '^\[registro-despliegue\] ' "$TMP/salida.txt" | cut -d: -f1); L_SUB=$(grep -n '1/5' "$TMP/salida.txt" | cut -d: -f1); L_OK=$(grep -n '^   ok$' "$TMP/salida.txt" | head -1 | cut -d: -f1)
  [ -n "$L_INT" ] && [ -n "$L_SUB" ] && [ -n "$L_OK" ] && [ "$L_OK" -lt "$L_INT" ] && [ "$L_INT" -lt "$L_SUB" ] && ok "2.10 T12 …después del ingreso y ANTES de subir" || no "🔴 2.10 T12 la línea de intento no quedó entre el ingreso y la subida (ok=$L_OK intento=$L_INT subir=$L_SUB)"
  [ "$(grep -c '^##vso\[build.addbuildtag\]' "$TMP/salida.txt")" = "1" ] && grep -qx '##vso\[build.addbuildtag\]despliegue-intentado' "$TMP/salida.txt" && ok "2.10 T12 …con la etiqueta despliegue-intentado y ninguna otra" || no "2.10 T12 etiquetas: $(grep addbuildtag "$TMP/salida.txt" | tr '\n' ' ')"
  [ "$(cat "$J/tycon-despliegue/entorno" 2>/dev/null)" = "staging" ] && ok "2.10 T12 …y deja el entorno declarado para el humo del mismo job" || no "🔴 2.10 T12 no dejó el archivo de entorno del job"
else
  no "2.10 T12 no hay zip/unzip para armar un paquete real — el caso del hash no se midió (no es verde)"
fi
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
ZMALO_DIR="$TMP/zipmalo"; mkdir -p "$ZMALO_DIR"; ZMALO="$ZMALO_DIR/miplugin.1.0.7-abc.zip"; echo "paquete" > "$ZMALO"
rc=$(corre_reg "$ZMALO" http://host u c staging AGENT_TEMPDIRECTORY="$TMP/job-b")
[ "$rc" = "0" ] && linea_reg | jq -e '.estado=="intentado" and .hash==null' >/dev/null && ok "2.10 T12 un paquete sin plugin.json legible → hash null, sin inventar" || no "2.10 T12 paquete ilegible: rc=$rc línea $(linea_reg)"
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz; resp /api/auth/login '{"error":"Invalid credentials"}' 401
mkdir -p "$TMP/job-c"; rc=$(corre_reg "$ZIP" http://host u c staging AGENT_TEMPDIRECTORY="$TMP/job-c")
[ "$rc" = "2" ] && ! grep -q -e '^\[registro-despliegue\]' -e 'addbuildtag' "$TMP/salida.txt" && ok "2.10 T12 un ingreso rechazado (exit 2) no deja intento: no se tocó el host" || no "🔴 2.10 T12 con el login en 401 quedó un intento anotado (rc=$rc)"
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
mkdir -p "$TMP/job-d"; rc=$(corre_reg "$ZIP" http://host u c prod AGENT_TEMPDIRECTORY="$TMP/job-d")
[ "$rc" = "0" ] && [ ! -f "$TMP/job-d/tycon-despliegue/entorno" ] && grep -q 'logissue type=warning.*registro-despliegue' "$TMP/salida.txt" && ok "2.10 T12 --environment prod (inválido) no escribe el archivo, avisa, y el despliegue sigue igual" || no "2.10 T12 --environment prod: rc=$rc o escribió/no avisó"
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
mkdir -p "$TMP/job-e"; rc=$(corre_reg "$ZIP" http://host u c production AGENT_TEMPDIRECTORY="$TMP/job-e" RESOURCES_PIPELINE_CI_RUNID=77 ENVIRONMENT_NAME=production)
linea_reg | jq -e '.build_ci=="77" and .build=="100" and .entorno=="produccion"' >/dev/null && ok "2.10 T12 en producción build_ci es el CI promovido" || no "2.10 T12 build_ci: $(linea_reg)"
# story 8.9 (B3a): la opción dice `production`; el registro que lee el humo sigue guardando su dato de siempre
REG_PROD=$(linea_reg | jq -r '.entorno' 2>/dev/null)
linea_reg | jq -e '.entorno_fuente=="declarado"' >/dev/null && [ "$(cat "$TMP/job-e/tycon-despliegue/entorno" 2>/dev/null)" = "$REG_PROD" ] && [ -n "$REG_PROD" ] && [ "$REG_PROD" != production ] \
  && ! grep -q 'logissue type=warning.*registro-despliegue' "$TMP/salida.txt" \
  && ok "8.9 --environment production se declara al humo con el valor de registro de siempre ($REG_PROD), sin avisos" \
  || no "🔴 8.9 --environment production: fuente/archivo de entorno fuera de contrato ($(linea_reg); archivo=$(cat "$TMP/job-e/tycon-despliegue/entorno" 2>/dev/null))"
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
rc=$(corre_reg "$ZIP" https://host-secreto.cliente.example usuario-secreto clave-secreta staging AGENT_TEMPDIRECTORY="$TMP/job-f")
[ "$rc" = "0" ] && [ "$(grep -c '^\[registro-despliegue\] ' "$TMP/salida.txt")" = "1" ] && ! grep -q -e 'host-secreto' -e 'usuario-secreto' -e 'clave-secreta' "$TMP/salida.txt" && ok "2.10 T12 la línea de intento no lleva ni la dirección, ni el usuario, ni la clave" || no "🔴 2.10 T12 se filtró la dirección/usuario/clave: $(grep -e host-secreto -e usuario-secreto -e clave-secreta "$TMP/salida.txt")"
rm -rf "$TMP/respuestas"; mkdir -p "$TMP/respuestas"; printf '{}\n200\n' > "$TMP/respuestas/default"; feliz
env -u TF_BUILD PATH="$TMP/bin:$PATH" RESP="$TMP/respuestas" AGENT_TEMPDIRECTORY="$TMP/job-g" bash "$GUION" --url http://host --user u --password c --zip "$ZIP" --endpoint /api/admin/plugins/upload --environment staging >"$TMP/salida.txt" 2>&1
[ $? = 0 ] && ! grep -q -e 'registro' -e 'addbuildtag' "$TMP/salida.txt" && [ ! -e "$TMP/job-g/tycon-despliegue" ] && ok "2.10 T12 fuera de Azure: ni línea, ni etiqueta, ni archivo de entorno" || no "🔴 2.10 T12 fuera de Azure anotó algo"

echo "─────────────"
[ $MAL -eq 0 ] && { echo "✅ deploy-plugin: todo verde ($OK casos)"; exit 0; }
echo "❌ deploy-plugin: $MAL de $((OK+MAL))"; exit 1
