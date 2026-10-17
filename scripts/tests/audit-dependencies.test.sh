#!/usr/bin/env bash
# Prueba de audit-dependencies.js — EL criterio del análisis de dependencias, en un solo lugar.
#
# Nace del 2026-09-01. Dos hechos del mismo día lo motivaron:
#  · el pipeline de URUTAU/FrontEnd pasó en verde a las 15:56 y a las 16:42 se publicó
#    CVE-2026-73089 sobre browserslist — mismo código, veredicto opuesto;
#  · el backend de FRESNO tenía 4 vulnerabilidades altas y su pipeline las daba por VERDES, porque
#    no restauraba antes de escanear (así que no miraba nada) y el fallo se perdía en el `| tee`.
#
# Por eso el eje de casi todos los casos de abajo es el mismo: **que "no pude medir" nunca se
# pueda confundir con "está limpio"**. Ninguno toca la red: el comando externo se inyecta.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="$AQUI/scripts/ci/audit-dependencies.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
casos=0
ok(){ casos=$((casos+1)); echo "✅ auditar-deps: $1"; }
no(){ casos=$((casos+1)); echo "❌ auditar-deps: $1"; fallos=$((fallos+1)); }

# ── El comando externo, de mentira ────────────────────────────────────────────────────────────
# El guión le pasa al hijo TYCON_DEP_REAL con el nombre del comando que reemplaza, así que el
# doble sabe si le tocó ser npm o dotnet. Sin esto haría falta red y una versión concreta de npm.
cat > "$TMP/doble.sh" <<'DOBLE'
#!/usr/bin/env bash
case "${TYCON_DEP_REAL}:$1" in
  npm:audit)      [ -f "$FIX/npm.json" ] && cat "$FIX/npm.json";     exit "${NPM_EXIT:-0}" ;;
  dotnet:restore) exit "${RESTORE_EXIT:-0}" ;;
  dotnet:list)    [ -f "$FIX/nuget.json" ] && cat "$FIX/nuget.json"; exit "${LIST_EXIT:-0}" ;;
esac
exit 0
DOBLE
chmod +x "$TMP/doble.sh"

repo(){ rm -rf "$TMP/repo"; mkdir -p "$TMP/repo"; : > "$TMP/repo/package-lock.json"; }
corre(){ FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" TYCON_DEP_TODAY="${HOY:-2026-09-01}" \
         node "$GUION" --repo "$TMP/repo" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

limpio='{"vulnerabilidades":0,"vulnerabilities":{},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0}}}'
conAltas='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://github.com/advisories/GHSA-73wf"}]},"handlebars":{"severity":"critical","via":[{"url":"https://x/GHSA-2qvq"}]}},"metadata":{"vulnerabilities":{"critical":1,"high":1,"moderate":0,"low":0}}}'

# ── 1. sin lockfile: NO SE PUDO MEDIR, y eso no es limpio ────────────────────────────────────
rm -rf "$TMP/repo"; mkdir -p "$TMP/repo"; echo "$limpio" > "$TMP/npm.json"
rc=$(corre --type npm)
{ [ "$rc" -eq 2 ] && grep -q "NO MEDIDO" "$TMP/out.txt"; } \
  && ok "sin lockfile sale 2 y lo dice (no medido ≠ limpio)" || no "sin lockfile salió $rc: $(cat "$TMP/out.txt")"

# ── 2. limpio de verdad ──────────────────────────────────────────────────────────────────────
repo; echo "$limpio" > "$TMP/npm.json"
rc=$(corre --type npm --block)
[ "$rc" -eq 0 ] && ok "un repo limpio sale 0 incluso con --block" || no "limpio salió $rc: $(cat "$TMP/out.txt")"

# ── 3. EL CASO REAL: altas sin declarar frenan el pull request ───────────────────────────────
repo; echo "$conAltas" > "$TMP/npm.json"
rc=$(corre --type npm --block)
{ [ "$rc" -eq 1 ] && grep -q "browserslist" "$TMP/out.txt"; } \
  && ok "altas/críticas sin declarar frenan (exit 1) y se nombran" || no "altas sin declarar salieron $rc"

# ── 4. …pero AVISAN sin frenar cuando no se pide frenar (el modo del nocturno) ───────────────
repo; echo "$conAltas" > "$TMP/npm.json"
rc=$(corre --type npm)
[ "$rc" -eq 0 ] && ok "sin --block el mismo hallazgo sale 0: avisa, no frena" || no "sin --block salió $rc"

# ── 5. la deuda declarada y VIGENTE no despierta a nadie ─────────────────────────────────────
# 🔴 Desde el 2026-09-03 la entrada tiene que nombrar los avisos que ampara: declarar sólo el
# nombre amparaba el paquete entero para todo aviso futuro. El caso de abajo, con los avisos
# puestos, es la conducta correcta; el caso "sin avisos no ampara" está más abajo.
repo; echo "$conAltas" > "$TMP/npm.json"
cat > "$TMP/repo/vulnerabilidades-pendientes.json" <<'D'
{ "revision": "2026-12-31", "paquetes": [ {"paquete":"browserslist","advisories":["GHSA-73wf"]}, {"paquete":"handlebars","advisories":["GHSA-2qvq"]} ] }
D
rc=$(corre --type npm --block)
[ "$rc" -eq 0 ] && ok "lo declarado y vigente no frena" || no "declarado vigente salió $rc: $(cat "$TMP/out.txt")"

# ── 6. 🔴 una declaración VENCIDA vuelve a contar como nueva ─────────────────────────────────
# Sin esto, declarar la deuda una vez la volvería permanente en silencio — que es exactamente lo
# que el archivo de deuda existe para impedir.
repo; echo "$conAltas" > "$TMP/npm.json"
cat > "$TMP/repo/vulnerabilidades-pendientes.json" <<'D'
{ "revision": "2026-01-01", "paquetes": [ {"paquete":"browserslist"}, {"paquete":"handlebars"} ] }
D
rc=$(corre --type npm --block)
{ [ "$rc" -eq 1 ] && grep -qi "venci" "$TMP/out.txt"; } \
  && ok "una declaración vencida vuelve a frenar, y lo dice" || no "declaración vencida salió $rc: $(cat "$TMP/out.txt")"

# ── 7. 🔴 una declaración SIN FECHA no vale ──────────────────────────────────────────────────
repo; echo "$conAltas" > "$TMP/npm.json"
echo '{ "paquetes": [ {"paquete":"browserslist"}, {"paquete":"handlebars"} ] }' > "$TMP/repo/vulnerabilidades-pendientes.json"
rc=$(corre --type npm --block)
[ "$rc" -eq 1 ] && ok "una deuda sin fecha de revisión no ampara (sería permanente)" || no "deuda sin fecha salió $rc"

# ── 8. 🔴 una declaración ILEGIBLE no ampara: dato malo es peor que dato ausente ─────────────
repo; echo "$conAltas" > "$TMP/npm.json"
echo '{ esto no es json' > "$TMP/repo/vulnerabilidades-pendientes.json"
rc=$(corre --type npm --block)
{ [ "$rc" -eq 1 ] && grep -qi "ilegible" "$TMP/out.txt"; } \
  && ok "una deuda ilegible no ampara, y se dice" || no "deuda ilegible salió $rc: $(cat "$TMP/out.txt")"

# ── 9. 🔴 npm audit sale 1 cuando ENCUENTRA algo, no cuando falla ────────────────────────────
# Leer ese 1 como "el escaneo se rompió" es el error clásico, y su gemelo —leerlo como error y
# salir— convertiría cada hallazgo en un "no pude medir".
repo; echo "$conAltas" > "$TMP/npm.json"
rc=$(NPM_EXIT=1 corre --type npm)
{ [ "$rc" -eq 0 ] && grep -q "browserslist" "$TMP/out.txt"; } \
  && ok "el exit 1 de npm audit es 'encontré', no 'fallé'" || no "npm audit exit 1 se leyó mal: salió $rc"

# ── 10. 🔴 salida ilegible: NO se puede leer como limpio ─────────────────────────────────────
repo; echo 'esto no es json' > "$TMP/npm.json"
rc=$(corre --type npm --block)
{ [ "$rc" -eq 2 ] && grep -q "NO MEDIDO" "$TMP/out.txt"; } \
  && ok "una salida ilegible sale 2, nunca 0" || no "salida ilegible salió $rc: $(cat "$TMP/out.txt")"

# ── 11. 🔴 EL CASO DE UN PRODUCTO DEL EQUIPO: si el restore falla, NO se escanea nada — y eso no es limpio ─────────
# Reproduce el defecto real del backend de FRESNO: sin assets file `dotnet list --vulnerable` no ve
# nada, el 1 se pierde en el `| tee` y el paso sale VERDE con 4 altas adentro.
rm -rf "$TMP/repo"; mkdir -p "$TMP/repo"; : > "$TMP/repo/x.sln"
echo '{"projects":[]}' > "$TMP/nuget.json"
rc=$(RESTORE_EXIT=1 corre --type nuget --block)
{ [ "$rc" -eq 2 ] && grep -qi "restore" "$TMP/out.txt"; } \
  && ok "si el restore falla sale 2 y nombra el motivo (el agujero de FRESNO)" || no "restore fallido salió $rc: $(cat "$TMP/out.txt")"

# ── 12. NuGet: el mismo paquete en varios proyectos es UN hallazgo, no tres ──────────────────
rm -rf "$TMP/repo"; mkdir -p "$TMP/repo"; : > "$TMP/repo/x.sln"
cat > "$TMP/nuget.json" <<'N'
{"projects":[
 {"frameworks":[{"transitivePackages":[{"id":"SSH.NET","vulnerabilities":[{"severity":"High","advisoryurl":"https://x/GHSA-q939"}]}]}]},
 {"frameworks":[{"transitivePackages":[{"id":"SSH.NET","vulnerabilities":[{"severity":"High","advisoryurl":"https://x/GHSA-q939"}]}]}]},
 {"frameworks":[{"topLevelPackages":[{"id":"SSH.NET","vulnerabilities":[{"severity":"Critical","advisoryurl":"https://x/GHSA-q939"}]}]}]}]}
N
rc=$(corre --type nuget --json)
n=$(grep -c '"paquete": "SSH.NET"' "$TMP/out.txt")
{ [ "$rc" -eq 0 ] && [ "$n" -eq 1 ] && grep -q '"severidad": "critical"' "$TMP/out.txt"; } \
  && ok "el mismo paquete en 3 proyectos es 1 hallazgo, con la severidad más grave" \
  || no "agrupación NuGet: salió $rc con $n entradas"

# ── 13. un repo que no existe no se lee como limpio ──────────────────────────────────────────
rc=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" node "$GUION" --repo "$TMP/no-existe" --type npm >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "un repo inexistente sale 2" || no "repo inexistente salió $rc"

# ── 14. faltar argumentos es error de uso, no un verde ───────────────────────────────────────
rc=$(node "$GUION" --type npm >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "sin --repo sale 2 con la ayuda" || no "sin --repo salió $rc"

echo
# ── 🔴 LA AMNISTÍA ES POR (PAQUETE, AVISO), NO POR NOMBRE (2026-09-03) ─────────────────────────
# Antes bastaba con que el NOMBRE del paquete figurara: eso amparaba el paquete entero, en todo el
# repo y para todo aviso FUTURO. Un formulario nuevo que agregara un paquete ya declarado pasaba sin
# que nadie lo mirara, y un aviso nuevo sobre un paquete declarado no despertaba a nadie.
decl(){ printf '%s' "$1" > "$TMP/repo/vulnerabilidades-pendientes.json"; }

repo; echo "$conAltas" > "$TMP/npm.json"
decl '{"revision":"2026-12-31","paquetes":[{"paquete":"browserslist","advisories":["GHSA-73wf"]},{"paquete":"handlebars","advisories":["GHSA-2qvq"]}]}'
rc=$(corre --type npm --block)
[ "$rc" -eq 0 ] && ok "con el aviso concreto declarado, ampara" || no "el aviso declarado igual frenó ($rc)"

repo; echo "$conAltas" > "$TMP/npm.json"
decl '{"revision":"2026-12-31","paquetes":[{"paquete":"browserslist","advisories":["GHSA-otro"]},{"paquete":"handlebars","advisories":["GHSA-2qvq"]}]}'
rc=$(corre --type npm --block)
{ [ "$rc" -eq 1 ] && grep -q "browserslist" "$TMP/out.txt"; } \
  && ok "🔴 un aviso NUEVO sobre un paquete ya declarado NO queda amparado: frena" \
  || no "🔴 el aviso nuevo pasó amparado por el nombre ($rc) — es el agujero que esto cierra"

repo; echo "$conAltas" > "$TMP/npm.json"
decl '{"revision":"2026-12-31","paquetes":[{"paquete":"browserslist"},{"paquete":"handlebars"}]}'
rc=$(corre --type npm --block)
[ "$rc" -eq 1 ] && ok "una declaración que no dice QUÉ avisos ampara, no ampara" || no "🔴 la declaración sin avisos amparó igual ($rc)"

# 🔴 Si el análisis NO da un aviso propio (paquete vulnerable a través de otro), no se le puede
# exigir uno: esos casos quedarían IMPOSIBLES de declarar, en rojo para siempre, y un control que no
# se puede satisfacer se apaga. Medido el 2026-09-03: 3 de 47 formularios caían ahí.
sinAviso='{"vulnerabilities":{"jspdf-autotable":{"severity":"high","via":["jspdf"]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'
repo; printf '%s' "$sinAviso" > "$TMP/npm.json"
decl '{"revision":"2026-12-31","paquetes":[{"paquete":"jspdf-autotable","advisories":[]}]}'
rc=$(corre --type npm --block)
[ "$rc" -eq 0 ] && ok "🔴 sin aviso propio, la declaración ampara por nombre (si no, sería indeclarable)" \
  || no "🔴 un paquete sin aviso propio quedó IMPOSIBLE de declarar ($rc)"

repo; printf '%s' "$sinAviso" > "$TMP/npm.json"
decl '{"revision":"2026-12-31","paquetes":[{"paquete":"otro","advisories":["GHSA-x"]}]}'
rc=$(corre --type npm --block)
[ "$rc" -eq 1 ] && ok "…y eso NO abre la puerta: sin declarar, sigue frenando" || no "🔴 sin declarar pasó igual ($rc)"

repo; echo "$conAltas" > "$TMP/npm.json"
decl '{"revision":"2020-01-01","paquetes":[{"paquete":"browserslist","advisories":["GHSA-73wf"]},{"paquete":"handlebars","advisories":["GHSA-2qvq"]}]}'
rc=$(corre --type npm --block)
[ "$rc" -eq 1 ] && ok "una declaración vencida no ampara aunque nombre los avisos" || no "🔴 la vencida amparó ($rc)"

# ── 🔴 el registro de avisos tropieza: se REINTENTA antes de declarar "no pude medir" ────────
# (2026-09-03) Medido en producción: dos pull requests (de dos productos del equipo) quedaron
# rechazados a las 22:42 con "npm audit reportó un error: sin detalle", mientras Lapacho pasaba
# un minuto después con el mismo guion. Los mismos repos habían pasado a las 21:30. O sea: un
# tropiezo del registro, no un hallazgo. El resto del arnés ya reintenta ante lo transitorio (las
# imágenes de análisis, el ingreso al host); esto no, y un tropiezo de red frenaba un cambio sano.
# 🔴 Lo que NO cambia: si tras los reintentos sigue sin poder, es "no pude medir" (exit 2). El
# reintento acorta la ventana del tropiezo; no convierte un no-medido en un verde.
cat > "$TMP/npm-flaky.sh" <<'FLAKY'
#!/usr/bin/env bash
# falla las primeras N veces (contador en un archivo) y después contesta bien
C="$FIX/intentos"; n=$(cat "$C" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$C"
if [ "$n" -le "${FALLAR_HASTA:-1}" ]; then echo '{"error":{}}'; exit 1; fi
cat "$FIX/npm.json"; exit 0
FLAKY
chmod +x "$TMP/npm-flaky.sh"
repo; echo "$limpio" > "$TMP/npm.json"; rm -f "$TMP/intentos"
rc=$(FIX="$TMP" FALLAR_HASTA=1 TYCON_DEP_CMD="$TMP/npm-flaky.sh" TYCON_DEP_TODAY=2026-09-01 TYCON_DEP_WAIT_MS=50 \
     node "$GUION" --repo "$TMP/repo" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 0 ] && [ "$(cat "$TMP/intentos")" -ge 2 ]; } \
  && ok "🔴 un tropiezo del registro se reintenta y la medición sale (intentos: $(cat "$TMP/intentos"))" \
  || no "🔴 un tropiezo del registro tumbó la medición: rc=$rc intentos=$(cat "$TMP/intentos" 2>/dev/null) — $(cat "$TMP/out.txt")"

# ── 🔴 el registro que NO CONTESTA se corta por tiempo, no se espera para siempre ────────────
# (2026-09-03) Esa noche el registro de avisos se degradó y una sola llamada tardó 267 SEGUNDOS
# (medida desde la máquina del dev, otra red: no era Azure). El guion no tenía ningún tiempo de
# espera, así que el paso por formulario de un producto del equipo —33 llamadas— se comió 40 minutos contra un techo
# de 60 por trabajo. Lo normal es ~1 segundo por formulario: el corte se pone treinta veces más
# arriba, y lo que se corta es "no pude medir" con su motivo, nunca un verde.
cat > "$TMP/npm-colgado.sh" <<'COLGADO'
#!/usr/bin/env bash
sleep 30
echo '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0}}}'
COLGADO
chmod +x "$TMP/npm-colgado.sh"
repo
INICIO=$(date +%s)
rc=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/npm-colgado.sh" TYCON_DEP_TODAY=2026-09-01 \
     TYCON_DEP_TIMEOUT_MS=400 TYCON_DEP_ATTEMPTS=1 \
     node "$GUION" --repo "$TMP/repo" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
TARDO=$(( $(date +%s) - INICIO ))
{ [ "$rc" -eq 2 ] && [ "$TARDO" -le 10 ] && grep -qi "no contestó\|NO MEDIDO" "$TMP/out.txt"; } \
  && ok "🔴 un registro que no contesta se corta por tiempo (${TARDO}s) y sale NO MEDIDO, no colgado" \
  || no "🔴 se quedó esperando al registro: ${TARDO}s rc=$rc — $(head -2 "$TMP/out.txt")"

# …y el corte NO se lleva puesta una medición legítima que tarda un poco
repo; echo "$limpio" > "$TMP/npm.json"
rc=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" TYCON_DEP_TODAY=2026-09-01 TYCON_DEP_TIMEOUT_MS=30000 \
     node "$GUION" --repo "$TMP/repo" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 0 ] && ok "…y una medición normal no se corta" || no "🔴 el corte se llevó una medición buena (rc=$rc)"

# 🔴 …y el reintento tiene PRESUPUESTO: no puede estirar el paso sin techo.
# (2026-09-03, la misma noche) El análisis por formulario recorre 33 repos en ese producto; con el registro
# degradado, 3 intentos con esperas por cada uno convertirían un paso de 36 segundos en media hora,
# contra un techo de 60 minutos por trabajo. Medido esa noche: ese paso pasó de 0,6 a 24+ minutos
# SOLO por la lentitud del registro, sin reintentos. El reintento tiene que ayudar con un tropiezo,
# no amplificar una caída.
rm -f "$TMP/intentos"
INICIO=$(date +%s)
rc=$(FIX="$TMP" FALLAR_HASTA=99 TYCON_DEP_CMD="$TMP/npm-flaky.sh" TYCON_DEP_TODAY=2026-09-01 \
     TYCON_DEP_WAIT_MS=5000 TYCON_DEP_BUDGET_MS=300 \
     node "$GUION" --repo "$TMP/repo" --type npm >"$TMP/out.txt" 2>&1; echo $?)
TARDO=$(( $(date +%s) - INICIO ))
{ [ "$rc" -eq 2 ] && [ "$TARDO" -le 5 ]; } \
  && ok "🔴 con el registro caído, el reintento respeta su presupuesto (${TARDO}s, no 15+)" \
  || no "🔴 el reintento se estiró sin techo: ${TARDO}s (rc=$rc)"

rm -f "$TMP/intentos"
rc=$(FIX="$TMP" FALLAR_HASTA=99 TYCON_DEP_CMD="$TMP/npm-flaky.sh" TYCON_DEP_TODAY=2026-09-01 TYCON_DEP_WAIT_MS=50 \
     node "$GUION" --repo "$TMP/repo" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 2 ] && grep -q "NO MEDIDO" "$TMP/out.txt"; } \
  && ok "…y si NUNCA contesta, sigue siendo NO MEDIDO (exit 2), no un verde" \
  || no "🔴 tras los reintentos no dijo no-medido: rc=$rc"


# ── la declaración se lee RELATIVA a --repo: una subcarpeta trae la suya, no la de la raíz ──────
# (2026-09-05) El nocturno pasa a auditar subcarpetas (`subruta`: el gateway de mensajería de un producto del equipo,
# tools/chat-gateway, con su propio lockfile y su propio vulnerabilidades-pendientes.json). Este
# guion ya resolvía la declaración relativa a --repo, así que el caso NO tuvo rojo previo: es la red
# que impide que alguien "arregle" la lectura anclándola a la raíz del repo git, que dejaría al
# gateway sin su deuda declarada y despertando a todo el mundo la primera noche.
rm -rf "$TMP/repo"; mkdir -p "$TMP/repo/sub"; : > "$TMP/repo/sub/package-lock.json"; : > "$TMP/repo/package-lock.json"
echo "$conAltas" > "$TMP/npm.json"
cat > "$TMP/repo/sub/vulnerabilidades-pendientes.json" <<'D'
{ "revision": "2026-12-31", "paquetes": [ {"paquete":"browserslist","advisories":["GHSA-73wf"]}, {"paquete":"handlebars","advisories":["GHSA-2qvq"]} ] }
D
( cd "$TMP/repo" && git init -q . && git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm x ) >/dev/null 2>&1   # la raíz ES un repo git: la declaración igual se busca en --repo
rc=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" TYCON_DEP_TODAY=2026-09-01 node "$GUION" --repo "$TMP/repo/sub" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 0 ] && ok "con --repo en una subcarpeta la deuda declarada se lee AHÍ (el gateway entra en silencio)" \
  || no "subcarpeta: no leyó la declaración de la subcarpeta — rc=$rc: $(head -3 "$TMP/out.txt" | tr '\n' ' ')"
rm -f "$TMP/repo/sub/vulnerabilidades-pendientes.json"
cp "$TMP/repo/sub/../package-lock.json" /dev/null 2>&1 || true
cat > "$TMP/repo/vulnerabilidades-pendientes.json" <<'D'
{ "revision": "2026-12-31", "paquetes": [ {"paquete":"browserslist","advisories":["GHSA-73wf"]}, {"paquete":"handlebars","advisories":["GHSA-2qvq"]} ] }
D
rc=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" TYCON_DEP_TODAY=2026-09-01 node "$GUION" --repo "$TMP/repo/sub" --type npm --block >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 1 ] && ok "…y la declaración de la RAÍZ no ampara a la subcarpeta: cada programa declara su deuda" \
  || no "subcarpeta: la declaración de la raíz amparó a la subcarpeta — rc=$rc"


# ── el informe llega ENTERO a quien lo lee por una tubería ──────────────────────────────────────
# (2026-09-28) Este guion se usa de UNA sola forma en producción: el nocturno lo invoca con
# spawnSync y le parsea el JSON de la salida. Con `process.exit(main())` las escrituras de Node a
# una tubería son asincrónicas y el proceso moría con parte del informe sin escribir: un informe de
# 9782 bytes llegaba cortado en 8192, el JSON no parseaba, y el repo salía «no devolvió JSON
# legible (exit 0)» — NO MEDIDO, con un motivo que no nombra la causa. Los 8 repos que había tenían
# informes chicos y nunca lo dispararon; apareció con el primero grande (custom-forms/runtime-app
# del repo del framework, 21 hallazgos). El caso se escribe con spawnSync a propósito: por el
# redirigido a archivo que usa el resto de esta suite, el corte NO se ve.
# Caso: guides/maintaining/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
rm -rf "$TMP/repo"; mkdir -p "$TMP/repo"; : > "$TMP/repo/package-lock.json"
python3 - "$TMP/npm.json" <<'GRANDE'
import json, sys
# 60 paquetes con aviso: bastante más de 8 KB de informe, como un frontend real sin actualizar.
v = {f"paquete-numero-{i:03d}": {"severity": "high",
     "via": [{"url": f"https://github.com/advisories/GHSA-{i:04d}-xxxx-yyyy-zzzz-relleno"}]}
     for i in range(60)}
json.dump({"vulnerabilities": v, "metadata": {"vulnerabilities":
          {"critical": 0, "high": 60, "moderate": 0, "low": 0}}}, open(sys.argv[1], "w"))
GRANDE
salida=$(FIX="$TMP" TYCON_DEP_CMD="$TMP/doble.sh" TYCON_DEP_TODAY=2026-09-01 \
  node -e '
    const {spawnSync} = require("child_process");
    const r = spawnSync(process.execPath, [process.argv[1], "--repo", process.argv[2], "--type", "npm", "--json"],
                        {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
    let n = 0;
    try { n = JSON.parse(r.stdout).hallazgos.length; } catch (e) { n = -1; }
    console.log(`${n} ${(r.stdout || "").length}`);
  ' "$GUION" "$TMP/repo")
hall=${salida%% *}; bytes=${salida##* }
{ [ "$hall" -eq 60 ] && [ "$bytes" -gt 8192 ]; } \
  && ok "el informe largo llega ENTERO por una tubería ($bytes bytes, 60 hallazgos)" \
  || no "🔴 el informe se cortó al salir por la tubería: hallazgos=$hall bytes=$bytes (con -1, el JSON no parseó)"

[ "$fallos" -eq 0 ] && { echo "✅ auditar-dependencias: todo verde ($casos casos)"; exit 0; } || { echo "❌ auditar-dependencias: $fallos fallo(s)"; exit 1; }
