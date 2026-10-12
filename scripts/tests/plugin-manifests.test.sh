#!/usr/bin/env bash
# plugin-manifests.test.sh — casos del control de los dos manifiestos de un plugin.
#
# 🔴 EL CASO QUE DA SENTIDO A TODO: el 2026-09-02 se cableó el flujo de migraciones administradas
# en URUTAU, FRESNO y Ceibo, copiado de Totora, con sus comentarios y su lógica. Quedó INERTE en los
# tres, porque la bandera se agregó al `plugin.json` y no al `plugin.json.example`, que es el que
# el pipeline copia encima y el único que viaja dentro del paquete. Nada dio error. Todo verde.
#
# Antes había pasado con `hasSignalRHubs` y con `relayHubsOnly`. Tres campos, tres veces, cada una
# "arreglada" agregando el campo de nuevo. El caso 1 de acá es esa tercera vez, congelada.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTRL="$DIR/../ci/check-plugin-manifests.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OK=0; MAL=0
ok() { echo "✅ manifiestos: $1"; OK=$((OK+1)); }
no() { echo "❌ manifiestos: $1"; MAL=$((MAL+1)); }

par() { # par <dir> <nombre> <json-real> <json-ejemplo>
  mkdir -p "$1"; printf '%s\n' "$3" > "$1/$2.plugin.json"; printf '%s\n' "$4" > "$1/$2.plugin.json.example"
}
corre() { node "$CTRL" --pairs "$1" ${2:+--migrations "$2"} >"$TMP/out.txt" 2>&1; echo $?; }

BASE='{"name":"p","version":"1.0.5","requiresDatabase":true,"migrations":{"enabled":true}}'
EJ='{"name":"p","version":"1.0.4","requiresDatabase":true,"migrations":{"enabled":true},"defaultSettings":{"A":"1"}}'

# ── 1. EL CASO REAL: la bandera está en el real y falta en el que viaja ────────────────────────
D="$TMP/c1"; par "$D" urutau "$BASE" '{"name":"p","version":"1.0.4","requiresDatabase":true,"defaultSettings":{"A":"1"}}'
rc=$(corre "$D")
[ "$rc" = "1" ] && ok "🔴 el caso real: la bandera de migraciones está en plugin.json y NO en el que viaja" || no "no lo detectó (salió $rc)"
grep -q "migrations" "$TMP/out.txt" && ok "…y nombra el campo perdido" || no "no nombró el campo"

# ── 2. el par sano no molesta ─────────────────────────────────────────────────────────────────
D="$TMP/c2"; par "$D" totora "$BASE" "$EJ"
rc=$(corre "$D")
[ "$rc" = "0" ] && ok "un par que coincide sale limpio (la versión difiere a propósito y no se marca)" || no "falso positivo en el par sano: $(cat "$TMP/out.txt")"

# ── 3. 🔴 mismo campo, distinto VALOR ─────────────────────────────────────────────────────────
# Comparar sólo nombres dejaba pasar "apagadas" en un archivo y "encendidas" en el otro, con el
# paquete viajando con el valor del ejemplo: el mismo agujero, en verde.
D="$TMP/c3"; par "$D" x "$BASE" '{"name":"p","version":"1.0.4","requiresDatabase":true,"migrations":{"enabled":false},"defaultSettings":{}}'
rc=$(corre "$D")
[ "$rc" = "1" ] && ok "🔴 mismo campo con distinto valor también es hallazgo (viaja el del ejemplo)" || no "no detectó el valor distinto"

# ── 4. el bloque de configuración vive sólo en el ejemplo, y eso NO es hallazgo ───────────────
D="$TMP/c4"; par "$D" x '{"name":"p","version":"1.0.5"}' '{"name":"p","version":"1.0.5","defaultSettings":{"A":"1","B":""}}'
rc=$(corre "$D")
[ "$rc" = "0" ] && ok "el bloque de configuración sólo en el ejemplo es lo correcto, no se marca" || no "falso positivo con defaultSettings: $(cat "$TMP/out.txt")"

# ── 5. …pero con contenido en el real, sí ────────────────────────────────────────────────────
D="$TMP/c5"; par "$D" x '{"name":"p","version":"1.0.5","defaultSettings":{"A":"secreto"}}' '{"name":"p","version":"1.0.5","defaultSettings":{"A":""}}'
rc=$(corre "$D")
[ "$rc" = "1" ] && ok "🔴 configuración con contenido en plugin.json es hallazgo (ahí es donde se filtran credenciales)" || no "no marcó defaultSettings poblado en el real"

# ── 6. paquete con migraciones y manifiesto que no las declara ───────────────────────────────
D="$TMP/c6"; par "$D" x '{"name":"p","version":"1.0.5"}' '{"name":"p","version":"1.0.5","defaultSettings":{}}'
rc=$(corre "$D" 3)
[ "$rc" = "1" ] && ok "🔴 3 migraciones en el paquete y el manifiesto no las declara: rojo" || no "no detectó migraciones sin declarar"
grep -q "sin migraciones pendientes" "$TMP/out.txt" && ok "…y explica que el host las ignora en verde" || no "no explicó la consecuencia"

# ── 7. una sola de las dos banderas no alcanza ───────────────────────────────────────────────
D="$TMP/c7"; par "$D" x '{"name":"p","version":"1.0.5","requiresDatabase":true}' '{"name":"p","version":"1.0.5","requiresDatabase":true,"defaultSettings":{}}'
rc=$(corre "$D" 2)
[ "$rc" = "1" ] && ok "🔴 el host exige las DOS banderas juntas: con una sola sigue ignorando la carpeta" || no "aceptó una sola bandera"

# ── 8. paquete sin migraciones: nada que exigir ──────────────────────────────────────────────
D="$TMP/c8"; par "$D" x '{"name":"p","version":"1.0.5"}' '{"name":"p","version":"1.0.5","defaultSettings":{}}'
rc=$(corre "$D" 0)
[ "$rc" = "0" ] && ok "sin migraciones en el paquete no se exige la declaración" || no "exigió declaración sin migraciones"

# ── 9. 🔴 "no encontré nada" NO es "coinciden" ───────────────────────────────────────────────
mkdir -p "$TMP/c9"
rc=$(corre "$TMP/c9")
[ "$rc" = "2" ] && ok "🔴 una carpeta sin manifiestos sale 2, no 0 — el modo de falla más silencioso posible" || no "una carpeta vacía salió $rc"

# ── 10. un manifiesto ilegible tampoco es "coinciden" ────────────────────────────────────────
D="$TMP/c10"; mkdir -p "$D"; echo '{roto' > "$D/x.plugin.json"; echo '{}' > "$D/x.plugin.json.example"
rc=$(corre "$D")
[ "$rc" = "2" ] && ok "🔴 un manifiesto ilegible sale 2 — ilegible no es aprobado" || no "manifiesto roto salió $rc"

# ── 11. la evidencia congelada del día: 3 rotos de 5 ─────────────────────────────────────────
EV="$DIR/../../tasks/evidencia/2026-09-02-antes-de-los-arreglos/manifiestos"
if [ -d "$EV" ]; then
  node "$CTRL" --pairs "$EV" >"$TMP/ev.txt" 2>&1; rc=$?
  [ "$rc" = "1" ] && ok "🔴 contra la evidencia congelada del 2026-09-02 se pone rojo (es el rojo previo que justifica el control)" || no "la evidencia congelada salió $rc — el control no detecta el defecto que motivó su existencia"
  n=$(grep -c '🔴 [A-Z]' "$TMP/ev.txt")
  [ "$n" = "3" ] && ok "…y marca exactamente los 3 productos rotos, ni uno más" || no "marcó $n productos, debía marcar 3"
else
  echo "⚠️  manifiestos: la evidencia congelada no está — el caso 11 no corrió"
fi

# ---------------------------------------------------------------- 🔴 LA EXPRESIÓN DEL PIPELINE
# El banco probaba el GUION pasándole --migrations a mano, y nunca la expresión del YAML que calcula
# ese número. Por eso pasó desapercibido dos semanas que los 5 pipelines contaban SIEMPRE 0:
# `git ls-tree --name-only HEAD database` SIN barra final devuelve la palabra "database" —el árbol—,
# no su contenido. Con 0, el control nunca evalúa su mitad más importante y un paquete con SQL
# adentro se despliega sin declararlo: el host ignora la carpeta y la base queda sin tocar, en verde.
# Medido el 2026-09-03: un producto 50 migraciones, otro 117, y el conteo daba 0 en los cinco.
D="$TMP/expr"; mkdir -p "$D/database"
( cd "$D" && git init -q -b main . && git config user.email t@t && git config user.name t
  echo "select 1" > database/001_a.sql && echo "select 2" > database/031_b.sql
  echo "no soy migracion" > database/leeme.md
  git add -A && git commit -qm x ) >/dev/null 2>&1
EXPR='^database/[0-9]{3}_.*\.sql$'
SIN=$(cd "$D" && git ls-tree --name-only HEAD database 2>/dev/null | grep -cE "$EXPR")
CON=$(cd "$D" && git ls-tree --name-only HEAD database/ 2>/dev/null | grep -cE "$EXPR")
[ "$SIN" = "0" ] && ok "🔴 queda documentado: SIN la barra final el conteo da 0 aunque haya migraciones" \
  || no "la reproducción del defecto no se sostiene (sin barra dio $SIN)"
[ "$CON" = "2" ] && ok "…y CON la barra cuenta las 2 reales (y no el .md que no es migración)" \
  || no "🔴 con barra contó $CON en vez de 2 — la expresión del pipeline está mal"

# Y que los 5 pipelines de verdad la lleven: si alguien la saca, este caso lo caza.
faltan=""
for r in Totora/Backend URUTAU/Backend Lapacho/Backend Ceibo/CeiboBackend FRESNO/FRESNOBZExtBackend; do
  d="$HOME/SourceCode/$r"
  [ -d "$d/.git" ] || continue
  # 🔴 lo PUBLICADO, no el disco: el dev trabaja en `dev` y leer su árbol denuncia al producto
  # por una rama que no corre. Mismo defecto que el 2026-09-03 se arregló en el control de
  # paridad y en la suite de "las etapas cortan" — tercera pieza con la misma premisa mala.
  y=$(git -C "$d" show origin/main:azure-pipelines.yml 2>/dev/null) || { echo "⚠️  manifiestos: no pude leer lo publicado de $r — no se midió"; continue; }
  printf '%s' "$y" | grep -q 'ls-tree --name-only HEAD database/ ' || faltan="$faltan $r"
done
[ -z "$faltan" ] && ok "los pipelines presentes en esta máquina cuentan con la barra" \
  || no "🔴 sin la barra (cuentan 0 siempre):$faltan"

echo "─────────────"
[ $MAL -eq 0 ] && { echo "✅ manifiestos-de-plugin: todo verde ($OK casos)"; exit 0; }
echo "❌ manifiestos-de-plugin: $MAL de $((OK+MAL))"; exit 1
