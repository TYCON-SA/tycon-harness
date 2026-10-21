#!/usr/bin/env bash
# Prueba de backend-to-version.sh — ¿esta corrida del backend trae algo nuevo desde la última versión?
#
# Sin este guion, una corrida de backend sin ningún cambio desde el último bump genera una versión con
# el mismo código, la despliega a staging, deja el commit del bump en main y abre una corrida de
# producción. Esa corrida no se provoca a voluntad sin desplegar: acá se reproduce con una historia
# git sintética.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH_V="$AQUI/scripts/ci/backend-to-version.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ backend-versionar: $1"; }
no(){ echo "❌ backend-versionar: $1"; fallos=$((fallos+1)); }
# Fechas fijas (el sha sale siempre igual), sin los ganchos del dev y sin el mantenimiento automático
# de git, que queda corriendo desprendido y toca el .git del laboratorio.
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_AUTHOR_DATE='2026-10-01T12:00:00Z' GIT_COMMITTER_DATE='2026-10-01T12:00:00Z'
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
  GIT_CONFIG_KEY_1=maintenance.auto GIT_CONFIG_VALUE_1=false

# Mundo: un plugin con src/, su plugin.json, el pipeline y un README. Historia:
#   inicial → "Merged PR 1: src" (P) → "chore: bump version to 1.0.1 [skip ci]" con «Commit: P» = HEAD
mundo(){
  R="$TMP/repo"; rm -rf "$R"; mkdir -p "$R/src"; cd "$R"; git init -q -b main .
  echo '{"name":"plugin","version":"1.0.0"}' > plugin.json
  echo "class A {}" > src/A.cs; echo "trigger: main" > azure-pipelines.yml; echo "# doc" > README.md
  git add -A && git commit -qm "inicial"
  echo "class A { int x; }" > src/A.cs; git add -A && git commit -qm "Merged PR 1: src"
  P=$(git rev-parse HEAD)
  echo '{"name":"plugin","version":"1.0.1"}' > plugin.json
  git add -A && git commit -qm "chore: bump version to 1.0.1 [skip ci]" -m "Commit: $P"
  cd "$AQUI"
}
corre(){ bash "$SH_V" --repo "$R" "$@" 2>"$TMP/err.txt"; }
valor(){ printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

# ---------------------------------------------------------------- T1 🔴 el caso de la corrida vacía
# @story-1.14 @ac-2 @ac-7 — la corrida real del AC 7 (sin casilla, sin versión) la cubre esto hasta el primer producto en main
mundo
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "false" ] \
  && ok "T1 SinCambiosDesdeElUltimoBump_NoVersiona" \
  || no "🔴 T1 SinCambiosDesdeElUltimoBump_NoVersiona: dio [$O] rc=$rc — $(cat "$TMP/err.txt")"
[ "$(valor "$O" ultima)" = "1.0.1" ] && [ "$(valor "$O" motivo)" = "sin-cambios" ] \
  && ok "…y dice la última versión (1.0.1) y el motivo" \
  || no "T1 no dio la última versión o el motivo: [$O]"

# ---------------------------------------------------------------- T2 con un cambio en src/
(cd "$R" && echo "class A { int y; }" > src/A.cs && git add -A && git commit -qm "Merged PR 2: src")
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] && [ "$(valor "$O" motivo)" = "cambios" ] \
  && ok "T2 ConUnCambioEnSrc_Versiona" \
  || no "🔴 T2 ConUnCambioEnSrc_Versiona: dio [$O] rc=$rc — $(cat "$TMP/err.txt")"

# ---------------------------------------------------------------- T3 🔴 dos merges agrupados (batch)
# El primer merge toca src/, el segundo sólo el README. HEAD~1 (el primer merge, por primer padre) sólo
# vería el README y diría «nada nuevo»; la base correcta es el último bump, y el src/ del primer merge cuenta.
mundo
(cd "$R" && git checkout -q -b f1 && echo "class A { int z; }" > src/A.cs && git commit -qam "src en f1" \
  && git checkout -q main && git merge -q --no-ff f1 -m "Merged PR 3: f1" \
  && git checkout -q -b f2 && echo "# otro" > README.md && git commit -qam "doc en f2" \
  && git checkout -q main && git merge -q --no-ff f2 -m "Merged PR 4: f2")
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] \
  && ok "T3 LoteDeDosMerges_ComparaContraElUltimoBump" \
  || no "🔴 T3 LoteDeDosMerges_ComparaContraElUltimoBump: dio [$O] rc=$rc — $(cat "$TMP/err.txt")"
SOLO_ULTIMO=$(cd "$R" && git diff --name-only HEAD~1 HEAD | tr '\n' ' ')
[ "$SOLO_ULTIMO" = "README.md " ] && ok "…(control: HEAD~1 sólo habría visto el README)" \
  || no "el mundo de prueba no reproduce el caso: HEAD~1 ve [$SOLO_ULTIMO]"

# ---------------------------------------------------------------- T4 🔴 sin la marca no se adivina
mundo
(cd "$R" && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.2 [skip ci]")
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] && [ "$(valor "$O" motivo)" = "sin-marca" ] \
  && ok "T4 SinMarcaCommitEnElUltimoBump_VersionaYAvisa" \
  || no "🔴 T4 SinMarcaCommitEnElUltimoBump_VersionaYAvisa: dio [$O] rc=$rc"
grep -q "AVISO" "$TMP/err.txt" && ok "…y avisa por qué versiona" || no "T4 no avisó: $(cat "$TMP/err.txt")"

# una marca que apunta a un commit que no existe tampoco se adivina
mundo
(cd "$R" && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A \
  && git commit -qm "chore: bump version to 1.0.2 [skip ci]" -m "Commit: 0123456789abcdef0123456789abcdef01234567")
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] && [ "$(valor "$O" motivo)" = "marca-invalida" ] && grep -q "AVISO" "$TMP/err.txt" \
  && ok "con una marca que no existe, versiona y avisa" \
  || no "🔴 con una marca que no existe dio [$O] rc=$rc — $(cat "$TMP/err.txt")"

# ---------------------------------------------------------------- T5 la casilla
# @story-1.14 @ac-3 @ac-7 — la corrida real con la casilla (versiona y despliega) la cubre esto hasta el primer producto en main
mundo
O=$(corre --force true); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] && [ "$(valor "$O" motivo)" = "casilla" ] \
  && ok "T5 CasillaTildada_VersionaSinCambios" \
  || no "🔴 T5 CasillaTildada_VersionaSinCambios: dio [$O] rc=$rc"
O=$(corre --force False); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "false" ] \
  && ok "…y la casilla sin tildar (False, como la escribe Azure) no fuerza nada" \
  || no "🔴 la casilla sin tildar dio [$O] rc=$rc"

# ---------------------------------------------------------------- lo que no cuenta como «algo nuevo»
# Sólo documentación o .tycon/ (que el pipeline del arnés escribe en casi toda story): no despiertan al
# pipeline, así que tampoco versionan.
mundo
(cd "$R" && mkdir -p .tycon docs && echo x > .tycon/runtime-waivers.jsonl && echo y > docs/a.md && echo "# otro" > README.md \
  && git add -A && git commit -qm "Merged PR 5: docs")
O=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "false" ] \
  && ok "un merge de sólo documentación y .tycon/ no versiona" \
  || no "🔴 sólo documentación dio [$O] rc=$rc — $(cat "$TMP/err.txt")"
# y cada ruta que sí despierta al pipeline, versiona
for f in database/001_x.sql plugin.json.example scripts/x.sh package.json azure-pipelines.yml tests/T.cs; do
  mundo
  (cd "$R" && mkdir -p "$(dirname "$f")" && echo cambio >> "$f" && git add -A && git commit -qm "Merged PR: $f")
  O=$(corre)
  [ "$(valor "$O" versionar)" = "true" ] && ok "un cambio en $f versiona" || no "🔴 un cambio en $f dio [$O]"
done

# ---------------------------------------------------------------- 🔴 las rutas son las del disparador de ESE pipeline
# Cada producto tiene su lista: uno dispara también con su gateway (tools/…) y con coverlet.runsettings. Con la lista
# del canónico fija, un merge que sólo toca el gateway no se versionaría ni se desplegaría. El guion lee el `trigger`
# del azure-pipelines.yml del commit, y sólo sin lista usa la del canónico.
disparador(){ # <rutas incluidas, separadas por espacio> [rutas excluidas]
  { echo "trigger:"; echo "  batch: true"; echo "  branches:"; echo "    include:"; echo "      - main"
    echo "  paths:"; echo "    include:"; for p in $1; do echo "      - '$p'   # comentario"; done
    if [ -n "${2:-}" ]; then echo "    exclude:"; for p in $2; do echo "      - $p"; done; fi
    echo "pr: none"; echo "  paths:"; echo "    include:"; echo "      - docs/**"; } > "$R/azure-pipelines.yml"
}
mundo
disparador "src/** plugin.json azure-pipelines.yml tools/gateway/** coverlet.runsettings" "src/**/*.md"
(cd "$R" && git add -A && git commit -qm "Merged PR: el disparador del producto" && P2=$(git rev-parse HEAD) \
  && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.2 [skip ci]" -m "Commit: $P2")
O=$(corre)
[ "$(valor "$O" versionar)" = "false" ] && ok "con el disparador del producto y nada nuevo, no versiona" || no "🔴 disparador propio sin cambios dio [$O] — $(cat "$TMP/err.txt")"
for f in tools/gateway/index.js coverlet.runsettings; do
  (cd "$R" && git checkout -q -B prueba main && mkdir -p "$(dirname "$f")" && echo cambio >> "$f" && git add -A && git commit -qm "Merged PR: $f")
  O=$(corre)
  [ "$(valor "$O" versionar)" = "true" ] && ok "una ruta que sólo dispara ESE producto ($f) versiona" || no "🔴 $f, que el producto dispara, dio [$O] — $(cat "$TMP/err.txt")"
done
for f in database/001_x.sql src/notas.md docs/x.md; do
  (cd "$R" && git checkout -q -B prueba main && mkdir -p "$(dirname "$f")" && echo cambio >> "$f" && git add -A && git commit -qm "Merged PR: $f")
  O=$(corre)
  [ "$(valor "$O" versionar)" = "false" ] && ok "una ruta que ESE producto no dispara ($f) no versiona" || no "🔴 $f, que el producto no dispara (o excluye), dio [$O]"
done
(cd "$R" && git checkout -q main)
# una ruta sin comodín en el disparador es un prefijo para Azure (`tools/gateway` dispara con tools/gateway/x.js)
mundo
disparador "src/** tools/gateway"
(cd "$R" && git add -A && git commit -qm "Merged PR: disparador con carpeta" && P3=$(git rev-parse HEAD) \
  && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.2 [skip ci]" -m "Commit: $P3" \
  && mkdir -p tools/gateway tools/gatewayx && echo x > tools/gatewayx/a.js && git add -A && git commit -qm "Merged PR: vecino")
O=$(corre)
[ "$(valor "$O" versionar)" = "false" ] && ok "una carpeta vecina con el mismo comienzo (tools/gatewayx) no cuenta" || no "🔴 tools/gatewayx contó como tools/gateway: [$O]"
(cd "$R" && echo y > tools/gateway/b.js && git add -A && git commit -qm "Merged PR: gateway")
O=$(corre)
[ "$(valor "$O" versionar)" = "true" ] && ok "una ruta sin comodín en el disparador cuenta como carpeta (tools/gateway/b.js versiona)" || no "🔴 tools/gateway/b.js con el disparador «tools/gateway» dio [$O]"

# ---------------------------------------------------------------- 🔴 hallazgos del pase adversarial (cuatro clases)
# Cada una dejaba código sin desplegar, en verde. Reproducidas por el pase con el guion real; acá quedan como regresión.
# (a) mover código de una ruta que cuenta a una que no cuenta: con la detección de renombres sólo se veía el destino
mundo
(cd "$R" && mkdir -p docs && git mv src/A.cs docs/A.cs && git commit -qm "Merged PR: mover A a docs")
O=$(corre)
[ "$(valor "$O" versionar)" = "true" ] && ok "mover src/A.cs a docs/ versiona (el código salió del paquete)" || no "🔴 git mv src/A.cs docs/A.cs dio [$O]"
# (b) un nombre con acentos: con quotepath de fábrica salía entre comillas y no calzaba con src/**
mundo
(cd "$R" && echo x > "src/Café.cs" && git add -A && git commit -qm "Merged PR: café")
O=$(corre)
[ "$(valor "$O" versionar)" = "true" ] && ok "un archivo con acentos bajo src/ versiona" || no "🔴 src/Café.cs dio [$O] — $(cat "$TMP/err.txt")"
# (c) un disparador con sólo exclusiones: Azure dispara todo lo que no está excluido
mundo
{ echo "trigger:"; echo "  branches:"; echo "    include: [main]"; echo "  paths:"; echo "    exclude:"; echo "      - docs/**"; } > "$R/azure-pipelines.yml"
(cd "$R" && git add -A && git commit -qm "Merged PR: sólo exclusiones" && P4=$(git rev-parse HEAD) \
  && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.2 [skip ci]" -m "Commit: $P4" \
  && echo x > coverlet.runsettings && git add -A && git commit -qm "Merged PR: runsettings")
O=$(corre)
[ "$(valor "$O" versionar)" = "true" ] && ok "con sólo exclusiones, un archivo no excluido versiona" || no "🔴 sólo exclusiones, coverlet.runsettings dio [$O]"
(cd "$R" && mkdir -p docs && echo y > docs/a.md && git add -A && git commit -qm "Merged PR: docs" && P5=$(git rev-parse HEAD) \
  && echo '{"name":"plugin","version":"1.0.3"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.3 [skip ci]" -m "Commit: $P5" \
  && echo z >> docs/a.md && git add -A && git commit -qm "Merged PR: docs otra vez")
O=$(corre)
[ "$(valor "$O" versionar)" = "false" ] && ok "…y lo excluido no versiona" || no "🔴 sólo exclusiones, docs/a.md dio [$O]"
# (d) la lista en una línea
mundo
{ echo "trigger:"; echo "  branches:"; echo "    include: [main]"; echo "  paths:"; echo "    include: [src/**, 'tools/gw/**']   # en una línea"; } > "$R/azure-pipelines.yml"
(cd "$R" && git add -A && git commit -qm "Merged PR: lista en una línea" && P6=$(git rev-parse HEAD) \
  && echo '{"name":"plugin","version":"1.0.2"}' > plugin.json && git add -A && git commit -qm "chore: bump version to 1.0.2 [skip ci]" -m "Commit: $P6" \
  && mkdir -p tools/gw && echo x > tools/gw/i.js && git add -A && git commit -qm "Merged PR: gw")
O=$(corre)
[ "$(valor "$O" versionar)" = "true" ] && ok "una lista de rutas escrita en una línea se lee (tools/gw/ versiona)" || no "🔴 include en una línea, tools/gw/i.js dio [$O] — $(cat "$TMP/err.txt")"

# ---------------------------------------------------------------- sin bump en la historia: primera versión
D="$TMP/nuevo"; mkdir -p "$D/src"
(cd "$D" && git init -q -b main . && echo '{"version":"1.0.0"}' > plugin.json && echo x > src/A.cs && git add -A && git commit -qm "inicial" \
  && echo y > src/A.cs && git commit -qam "Merged PR 1")
O=$(bash "$SH_V" --repo "$D" 2>"$TMP/err.txt"); rc=$?
[ "$rc" -eq 0 ] && [ "$(valor "$O" versionar)" = "true" ] && [ "$(valor "$O" motivo)" = "primera" ] \
  && ok "sin un bump previo en la historia, versiona (la primera)" \
  || no "🔴 sin bump previo dio [$O] rc=$rc — $(cat "$TMP/err.txt")"

# ---------------------------------------------------------------- 🔴 no poder mirar no es «nada nuevo»
mkdir -p "$TMP/nogit"; bash "$SH_V" --repo "$TMP/nogit" >"$TMP/o.txt" 2>/dev/null; rc=$?
[ "$rc" -eq 1 ] && [ ! -s "$TMP/o.txt" ] && ok "fuera de un repo git sale 1 sin veredicto" || no "🔴 fuera de git salió $rc: $(cat "$TMP/o.txt")"
mkdir -p "$TMP/solo" && cp "$SH_V" "$TMP/solo/"
mundo
bash "$TMP/solo/backend-to-version.sh" --repo "$R" >"$TMP/o.txt" 2>"$TMP/e.txt"; rc=$?
[ "$rc" -eq 1 ] && grep -q "run-base.sh" "$TMP/e.txt" && ok "sin run-base.sh al lado, sale 1 y lo dice" \
  || no "🔴 sin la base compartida salió $rc: $(cat "$TMP/e.txt")"
bash "$SH_V" --repo "$R" --force quizas >"$TMP/o.txt" 2>"$TMP/e.txt"; rc=$?
[ "$rc" -eq 1 ] && ok "una casilla con un valor que no es true/false sale 1" || no "🔴 --force quizas salió $rc"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ backend-to-version: todo verde"; exit 0; else echo "❌ backend-to-version: $fallos falla(s)"; exit 1; fi
