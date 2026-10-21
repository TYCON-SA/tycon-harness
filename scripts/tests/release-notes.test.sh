#!/usr/bin/env bash
# Prueba del release-notes.sh CANÓNICO (el unificado).
#
# Lo que se prueba: que UN archivo con una bandera hace lo mismo que hacían las dos variantes
# copiadas en 8 repos — y que la bandera no rompe las invocaciones que ya existen (sin --type
# tiene que comportarse como la variante de plugin, que es la que más llamadas tiene).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH="$AQUI/scripts/ci/release-notes.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ notas: $1"; }
no(){ echo "❌ notas: $1"; fallos=$((fallos+1)); }

cd "$TMP" && git init -q . && git config user.email t@t && git config user.name t
mkdir -p src
# 🔴 Cada commit escribe un número que sube, no `$RANDOM`: si `$RANDOM` repitiera el valor anterior (~1 en 4000 corridas),
#    el commit no se crearía («nothing to commit», que acá no frena) y se perdería un cambio que la prueba busca. Fecha fija y
#    sin el mantenimiento automático de git: nada cambia entre corridas ni queda corriendo de fondo.
N_COMMIT=0
export GIT_AUTHOR_DATE=2026-10-15T00:00:00Z GIT_COMMITTER_DATE=2026-10-15T00:00:00Z
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=gc.auto GIT_CONFIG_VALUE_1=0
c(){ N_COMMIT=$((N_COMMIT + 1)); echo "$N_COMMIT" > src/a.txt; git add -A; git commit -q -m "$1" || no "el commit «$1» del laboratorio no se creó"; }
# 🔴 El marcador del build anterior va SOLO al principio: con un "chore: update versions" en el medio, el guion
# arranca la lista DESDE AHÍ —que es lo correcto, porque ese commit ES un build anterior— y los cambios previos
# quedan fuera a propósito, porque ya se publicaron.
c "chore: bump version to 1.0.1 [skip ci]"
c "feat(pedidos): listado con filtro por fecha"
c "fix(ci): el porton no podia actualizar la rama destino"
c "ci: el porton del arnes"
c "Merged PR 2597: algo del equipo"
c "chore(ci): trigger"
c "fix(vencimientos): la fecha se calculaba mal"

S=$(bash "$SH" --local prueba src/ 2>/dev/null)
echo "$S" | grep "feat(pedidos)" >/dev/null && ok "sin --type lista los cambios reales del producto" || no "sin --type NO listó los cambios reales"
echo "$S" | grep "fix(vencimientos)" >/dev/null && ok "lista el segundo cambio real" || no "perdió un cambio real"
for r in "fix(ci)" "ci: el porton" "Merged PR" "chore(ci)" "bump version"; do
  echo "$S" | grep "$r" >/dev/null && no "🔴 deja pasar ruido a la nota: $r" || ok "filtra el ruido: $r"
done

# la bandera no cambia el resultado en modo --local (la divergencia sólo vive en --from-server)
S2=$(bash "$SH" --type form --local prueba src/ 2>/dev/null)
[ "$S" = "$S2" ] && ok "--type form da lo mismo en modo --local" || no "--type cambió la salida de --local"
S3=$(bash "$SH" --type plugin --local prueba src/ 2>/dev/null)
[ "$S" = "$S3" ] && ok "--type plugin explícito == el default" || no "el default no es 'plugin'"

# un --type inválido no se traga en silencio, pero tampoco rompe el build
S4=$(bash "$SH" --type pepe --local prueba src/ 2>&1); R=$?
[ $R -eq 0 ] && ok "un --type inválido NO rompe el build (exit 0)" || no "un --type inválido rompió el build (exit $R)"
echo "$S4" | grep "type inválido" >/dev/null && ok "…pero lo dice por stderr" || no "un --type inválido pasó en silencio"

# 🔴 conducta correcta y no obvia: un marcador de build en el MEDIO corta la lista ahí — lo
# anterior ya se publicó y no puede volver a anunciarse.
c "chore: update versions and add deployment ZIPs [skip ci]"
c "feat(entregas): alta desde la ficha"
S6=$(bash "$SH" --local prueba src/ 2>/dev/null)
echo "$S6" | grep "feat(entregas)" >/dev/null && ok "lista lo posterior al último build" || no "perdió lo posterior al último build"
echo "$S6" | grep "fix(vencimientos)" >/dev/null && no "🔴 re-anuncia cambios ya publicados en un build anterior" || ok "no re-anuncia lo que ya salió en el build anterior"

# sin punto de partida confiable: avisa y no miente
cd "$TMP" && git checkout -q --orphan huerfana && git rm -rqf . 2>/dev/null; mkdir -p src; echo x > src/a.txt
git add -A && git commit -q -m "feat: primer commit sin build anterior"
S5=$(bash "$SH" --local prueba src/ 2>&1)
echo "$S5" | grep "sin punto de partida confiable" >/dev/null && ok "sin build anterior avisa que la lista puede estar incompleta" || no "no avisó que no tenía punto de partida"

# ---------------------------------------------------------------- reintento del login
# Un curl de mentira: el login falla con 000 dos veces y a la tercera entra; /versions devuelve el
# commit de la versión publicada. Así se prueba SIN red que (a) reintenta, (b) llega a la nota
# "desde la versión que está publicada" en vez de caer al build anterior, y (c) un 401 NO reintenta.
# (Volvemos a la rama con historia: el caso anterior dejó el repo en una rama huérfana.)
cd "$TMP" && (git checkout -q master 2>/dev/null || git checkout -q main)
PUB=$(git rev-parse HEAD~2)
STUB="$TMP/stub"; mkdir -p "$STUB"; export STUB_LOG="$TMP/curl.log"; : > "$STUB_LOG"
cat > "$STUB/curl" <<STUB
#!/usr/bin/env bash
url=""; hdr=""; out=""
while [ \$# -gt 0 ]; do case "\$1" in -D) hdr="\$2"; shift;; -o) out="\$2"; shift;; -w) shift;; http*) url="\$1";; esac; shift; done
echo "\$url" >> "\$STUB_LOG"
if echo "\$url" | grep '/api/auth/login' >/dev/null; then
  n=\$(grep -c '/api/auth/login' "\$STUB_LOG")
  if [ -n "\${STUB_401:-}" ]; then printf '401'; exit 0; fi
  if [ "\$n" -lt 3 ]; then printf '000'; exit 7; fi
  printf 'HTTP/1.1 200 OK\r\nSet-Cookie: admin_token=tok123; Path=/\r\n\r\n' > "\$hdr"; echo '{}' > "\$out"; printf '200'; exit 0
fi
# El curl real escribe el cuerpo en el archivo de -o e imprime el código con -w. El simulador
# tiene que hacer lo mismo o los casos prueban un curl que no existe (2026-09-01).
if echo "\$url" | grep '/versions' >/dev/null; then
  cuerpo='[{"version":"1.0.9","isCurrent":true,"commitHash":"$PUB"}]'
  if [ -n "\${STUB_VERSIONS_CODE:-}" ]; then
    [ -n "\$out" ] && printf '%s' '{}' > "\$out"; printf '%s' "\$STUB_VERSIONS_CODE"; exit 0
  fi
  if [ -n "\${STUB_VERSIONS_SIN_COMMIT:-}" ]; then
    cuerpo='[{"version":"1.0.9","isCurrent":true}]'
  fi
  if [ -n "\$out" ]; then printf '%s' "\$cuerpo" > "\$out"; printf '200'; else printf '%s' "\$cuerpo"; fi
  exit 0
fi
exit 1
STUB
chmod +x "$STUB/curl"
# `sleep` también de mentira: el reintento espera 5 y 10 s de verdad; en el test no hace falta
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/sleep"; chmod +x "$STUB/sleep"
S7=$(PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ 2>"$TMP/err7.txt")
logins=$(grep -c '/api/auth/login' "$STUB_LOG")
[ "$logins" -eq 3 ] && ok "ante HTTP 000 reintenta el login (3 intentos hasta entrar)" || no "🔴 no reintentó: $logins login(s), esperaba 3"
echo "$S7" | grep "la versión que está publicada" >/dev/null && ok "…y la nota sale contra la versión PUBLICADA, no contra el build anterior" || no "🔴 con reintento igual cayó al build anterior: $(head -1 <<<"$S7")"
grep -q "intento 1" "$TMP/err7.txt" && ok "…y avisa cada reintento por stderr" || no "no avisó el reintento"
: > "$STUB_LOG"
S8=$(STUB_401=1 PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ 2>/dev/null)
[ "$(grep -c '/api/auth/login' "$STUB_LOG")" -eq 1 ] && ok "un 401 (clave mala) NO se reintenta" || no "reintentó un 401: $(grep -c login "$STUB_LOG") intentos"

# ---------------------------------------------------------------- 11. ingreso REUTILIZADO (BZ_TOKEN)
# 🔴 Este guion se invoca UNA VEZ POR FORMULARIO, y si cada invocación abriera su propio ingreso al host, con 4
# formularios no se notaría; con 34 el host corta por límite de velocidad (`login HTTP 429`), los reintentos se agotan y las 34 notas salen
# calculadas contra el build anterior en vez de contra la versión PUBLICADA — o sea, el guion
# corre y ninguna nota dice lo que tiene que decir.
# Quien invoca en lote entra UNA vez y pasa el ingreso por `BZ_TOKEN`.
: > "$STUB_LOG"
S9=$(BZ_TOKEN=tok123 PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ 2>/dev/null)
[ "$(grep -c '/api/auth/login' "$STUB_LOG")" -eq 0 ] \
  && ok "con BZ_TOKEN NO vuelve a entrar al servidor (0 ingresos)" \
  || no "🔴 con BZ_TOKEN igual entró $(grep -c '/api/auth/login' "$STUB_LOG") vez/veces — el ingreso único no sirve de nada"
[ "$(grep -c '/versions' "$STUB_LOG")" -ge 1 ] \
  && ok "…pero SÍ consulta la versión publicada (el token se usa, no se ignora)" \
  || no "🔴 con BZ_TOKEN no consultó nada: $(cat "$STUB_LOG")"
echo "$S9" | grep "la versión que está publicada" >/dev/null \
  && ok "…y la nota sale contra la versión PUBLICADA" \
  || no "🔴 con BZ_TOKEN la nota cayó al build anterior: $(head -1 <<<"$S9")"

# Sin BZ_TOKEN el comportamiento tiene que ser EXACTAMENTE el de siempre: si esto se rompe, todos
# los invocadores sueltos (los pipelines de plugins) dejan de calcular contra el servidor.
: > "$STUB_LOG"
PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ >/dev/null 2>&1
[ "$(grep -c '/api/auth/login' "$STUB_LOG")" -ge 1 ] \
  && ok "sin BZ_TOKEN sigue entrando solo (ningún invocador existente cambia)" \
  || no "🔴 sin BZ_TOKEN ya no entra — se rompió el camino de siempre"

# ---------------------------------------------------------------- 12. el mensaje DISTINGUE la causa
# 🔴 Una frase como "el servidor no dijo qué versión tiene publicada" taparía TRES causas distintas y mandaría a
# buscar el problema en cualquiera de las tres. El mensaje dice cuál es.
: > "$STUB_LOG"
STUB_VERSIONS_CODE=404 PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ >/dev/null 2>"$TMP/e12.txt"
grep -q "HTTP 404" "$TMP/e12.txt" && grep -q "no se pudo preguntar" "$TMP/e12.txt" \
  && ok "si el host no tiene esa dirección lo dice (HTTP 404, no 'falta el dato')" \
  || no "🔴 no distinguió un 404: $(head -2 "$TMP/e12.txt")"

: > "$STUB_LOG"
STUB_VERSIONS_SIN_COMMIT=1 PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ >/dev/null 2>"$TMP/e13.txt"
grep -q "ninguna trae el commit" "$TMP/e13.txt" \
  && ok "si contesta pero la versión no trae el commit, lo dice aparte" \
  || no "🔴 no distinguió 'contestó pero sin el dato': $(head -2 "$TMP/e13.txt")"
grep -qE "Campos que sí devuelve: .*version" "$TMP/e13.txt" \
  && ok "…y enumera qué campos SÍ devolvió (para saber qué pedirle al host)" \
  || no "no dijo qué campos devolvió: $(head -2 "$TMP/e13.txt")"

# ---------------------------------------------------------------- 13. la CUARTA causa
# 🔴 El host contesta perfecto, el commit llega, y NO ESTÁ EN EL CLON porque el job del despliegue no clona con
# historia. Un mensaje "sin punto de partida confiable" se leería como "el host no contestó" y mandaría a buscar el
# problema al host. Sin este caso, el diagnóstico tapa la causa real.
cd "$TMP" && (git checkout -q master 2>/dev/null || git checkout -q main)
: > "$STUB_LOG"
cat > "$STUB/curl" <<'STUB2'
#!/usr/bin/env bash
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; -w) shift;; -D) shift;; http*) url="$1";; esac; shift; done
if echo "$url" | grep '/versions' >/dev/null; then
  # un commit que NO existe en este clon
  printf '%s' '[{"version":"9.9.9","isCurrent":true,"commitHash":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}]' > "${out:-/dev/stdout}"
  [ -n "$out" ] && printf '200'
  exit 0
fi
exit 1
STUB2
chmod +x "$STUB/curl"
BZ_TOKEN=tok123 PATH="$STUB:$PATH" bash "$SH" --type form --from-server http://stub usuario clave prueba src/ >/dev/null 2>"$TMP/e14.txt"
grep -q "no está en este clon" "$TMP/e14.txt" \
  && ok "🔴 distingue 'el host contestó pero el commit no está en el clon'" \
  || no "🔴 no distinguió la cuarta causa — vuelve a leerse como 'el host no contestó': $(head -2 "$TMP/e14.txt")"
grep -q "fetchDepth" "$TMP/e14.txt" \
  && ok "…y dice CÓMO se arregla (clonar con historia), no sólo que pasó" \
  || no "no dijo cómo arreglarlo"

# ---------------------------------------------------------------- 14. MERGES REALES
# 🔴 Los commits lineales no alcanzan: el commit que llega a main por el flujo de Pull Request ES un merge (`--no-ff`, squash prohibido). Tres
# formatos: «Merge pull request N from dev into main» (Azure completando solo, sin mensaje),
# «Merged PR N: título» (la pantalla de Azure y el skill de merge) y «Merge PR #N: …».
# Un filtro escrito sólo para el segundo haría que el camino de RESPALDO publicara los otros dos tal cual al
# administrador. Sólo se ve cuando main tiene un cambio propio que dev no trae —
# si no, git simplifica la historia y el merge ni aparece —: por eso cada repo de este bloque lleva uno.
# Suma core.hooksPath a lo de arriba (el mantenimiento automático apagado): reasignar GIT_CONFIG_COUNT a 1 lo volvería a
# prender en los commits de este bloque.
export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_2=core.hooksPath GIT_CONFIG_VALUE_2=/dev/null
armar_merge(){  # $1 = asunto del merge · $2 = "con-build" deja un build anterior antes de ramificar
  local d; d="$(mktemp -d "$TMP/merge.XXXX")"
  cd "$d" && git init -q . && git checkout -q -b main && git config user.email t@t && git config user.name t
  mkdir -p src; echo 0 > src/a.txt; git add -A; git commit -q -m "feat: base"
  [ "${2:-}" = "con-build" ] && { echo 1 > src/v.txt; git add -A; git commit -q -m "chore: bump version to 1.0.1 [skip ci]"; }
  git checkout -q -b dev
  echo 1 > src/a.txt; git commit -qam "feat(stock): filtro por vigencia"
  echo 2 > src/a.txt; git commit -qam "fix(stock): el total no incluia la vigente"
  git checkout -q main
  echo x > src/b.txt; git add -A; git commit -q -m "fix(hotfix): directo a main"
  git merge -q --no-ff dev -m "$1"
}
# Los asuntos con que un merge llega a main. Un filtro que sólo conociera los tres primeros publicaría crudo al
# administrador «Merge PR #<id> into main».
for asunto in \
  "Merge pull request 3137 from dev into main" \
  "Merged PR 3137: fix(stock): stock vigente" \
  "Merge PR #3137: fix(stock): stock vigente" \
  "Merge PR #1918 into main" \
  "Merge PR 1918 into main" \
  "Merge PR: URUTAU Backend — stock W-123" \
  "Merge branch 'dev' into main"; do

  # respaldo: sin build anterior
  armar_merge "$asunto"
  S=$(bash "$SH" --local prueba 2>/dev/null)
  printf '%s\n' "$S" | grep -F -- "- $asunto" >/dev/null \
    && no "🔴 respaldo: le publica el asunto del merge al administrador («${asunto}»)" \
    || ok "respaldo: no publica el asunto del merge («${asunto:0:28}…»)"
  echo "$S" | grep -E '^- (feat|fix)\(' >/dev/null \
    && ok "…y publica un cambio real" \
    || no "🔴 respaldo con «${asunto}»: no quedó ningún cambio real: $(echo "$S" | tail -1)"

  # normal: con build anterior, `--no-merges` ya excluye el merge
  armar_merge "$asunto" con-build
  S=$(bash "$SH" --local prueba 2>/dev/null)
  printf '%s\n' "$S" | grep -F -- "- $asunto" >/dev/null && no "🔴 camino normal: publica el asunto del merge («${asunto}»)" || ok "camino normal: no publica el asunto del merge («${asunto:0:28}…»)"
  { echo "$S" | grep "feat(stock)" >/dev/null && echo "$S" | grep "fix(stock)" >/dev/null && echo "$S" | grep "fix(hotfix)" >/dev/null; } \
    && ok "…y lista los tres cambios reales (los dos del PR y el de main)" \
    || no "🔴 camino normal con «${asunto}»: perdió cambios reales: $(echo "$S" | tr '\n' ' ')"
done

# 🔴 Control: un cambio REAL que habla de un merge NO se filtra (si no, el filtro de la clase se
# comería cambios del producto, que es peor que el defecto que arregla).
armar_merge "Merged PR 10: algo" con-build
cd "$(git rev-parse --show-toplevel)" && echo z > src/c.txt && git add -A && git commit -q -m "fix: el merge de listas perdía el último elemento"
S=$(bash "$SH" --local prueba 2>/dev/null)
echo "$S" | grep "el merge de listas" >/dev/null && ok "un cambio real que habla de «merge» NO se filtra" || no "🔴 el filtro se comió un cambio real del producto: $(echo "$S" | tr '\n' ' ')"

cd "$TMP"

echo "─────────────"
[ $fallos -eq 0 ] && { echo "✅ release-notes (canónico): todo verde"; exit 0; } || { echo "❌ release-notes: $fallos falla(s)"; exit 1; }
