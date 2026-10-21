#!/usr/bin/env bash
# Prueba de pr-one-per-repo-guard.js — el freno que impide abrir un SEGUNDO pull request en un repo que ya
# tiene uno abierto.
#
# 🔴 La cola de Azure se puede llenar por la misma causa, con dos variantes:
# empujar de a poco a la misma rama, y abrir una tanda de pull
# requests y después OTRA sobre los mismos repos. Prometer no repetirlo no alcanza: se
# repite por la otra puerta. Una regla que hay que recordar no es un control.
#
# Sin red: un `az` de mentira en PATH contesta lo que cada caso pide.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/pr-one-per-repo-guard.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# HOME de la prueba para toda la suite: el freno deja su constancia en frenos.jsonl.
source "$AQUI/scripts/tests/lib/fake-home.sh"
fake_home_create "$TMP/casa" || exit 1
fallos=0; casos=0
ok(){ casos=$((casos+1)); echo "✅ pr-uno: $1"; }
no(){ casos=$((casos+1)); echo "❌ pr-uno: $1"; fallos=$((fallos+1)); }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/az" <<'AZ'
#!/usr/bin/env bash
# dos respuestas: la lista de pull requests, y el estado de la politica de cada uno
for a in "$@"; do [ "$a" = "policy" ] && { [ -f "$AZ_POLICY" ] && cat "$AZ_POLICY"; exit "${AZ_EXIT:-0}"; }; done
[ -f "$AZ_SALIDA" ] && cat "$AZ_SALIDA"
exit "${AZ_EXIT:-0}"
AZ
chmod +x "$TMP/bin/az"

export TYCON_PR_ONE_PER_REPO=1   # el freno esta APAGADO por default: el banco lo enciende
corre(){ # <comando> ; usa AZ_SALIDA y AZ_EXIT del entorno
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    | PATH="$TMP/bin:$PATH" node "$HOOK" >"$TMP/out.txt" 2>"$TMP/err.txt"   # HOME de la prueba: fake_home_create (7.16)
  echo $?
}
CREAR='az repos pr create --org https://x --project Totora --repository FrontEnd --source-branch ci/nueva --target-branch main --title t'

# ---------------------------------------------------------------- 1. 🔴 otro pull request construyendo en el mismo repo
echo '[{"pullRequestId":2845,"title":"la amnistia","sourceRefName":"refs/heads/ci/otra"}]' > "$TMP/pr.json"
echo '[{"configuration":{"type":{"displayName":"Build"}},"status":"running"}]' > "$TMP/corriendo.json"
echo '[{"configuration":{"type":{"displayName":"Build"}},"status":"approved"}]' > "$TMP/terminada.json"
rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/corriendo.json" corre "$CREAR")
[ "$rc" -eq 2 ] && ok "🔴 con otro pull request CONSTRUYENDO en el mismo repo, BLOQUEA (exit 2)" || no "🔴 dejó abrir el segundo ($rc)"
grep -q "2845" "$TMP/err.txt" && ok "…y dice CUÁL está abierto, para poder sumarle el cambio" || no "no nombró el pull request abierto"
grep -q "Esperá a que esa construcción termine" "$TMP/err.txt" && ok "…y dice qué hacer en vez de sólo prohibir" || no "no dijo la salida"

# ---------------------------------------------------------------- 1b. un pedido de GitHub no es asunto de este freno
# Este freno cuida los pedidos de Azure de los repos de producto. Un `gh pr create` solo pasa sin que el freno pregunte
# nada; y si la misma línea trae además uno de Azure, decide el de Azure, igual que sin el `gh` adelante.
GH='gh pr create --repo acme/widgets --base main --head feat/x --title t --body b'
rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/corriendo.json" corre "$GH")
{ [ "$rc" -eq 0 ] && [ ! -s "$TMP/err.txt" ]; } && ok "un pedido de GitHub solo pasa callado, aun con uno de Azure construyendo" || no "🔴 el freno de Azure se metió con un pedido de GitHub ($rc): $(head -c 200 "$TMP/err.txt")"
rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/corriendo.json" corre "$GH && $CREAR")
{ [ "$rc" -eq 2 ] && grep -q "2845" "$TMP/err.txt"; } && ok "🔴 con un pedido de GitHub en la misma línea, el de Azure se sigue frenando" || no "🔴 el gh de adelante tapó el pedido de Azure ($rc)"

# ---------------------------------------------------------------- 2. sin ninguno abierto, deja pasar
echo '[]' > "$TMP/vacio.json"
rc=$(AZ_SALIDA="$TMP/vacio.json" AZ_POLICY="$TMP/corriendo.json" corre "$CREAR")
[ "$rc" -eq 0 ] && ok "sin pull requests abiertos, deja pasar" || no "🔴 bloqueó con el repo limpio ($rc)"

# ---------------------------------------------------------------- 3. el de la MISMA rama no cuenta
echo '[{"pullRequestId":2845,"title":"el mismo","sourceRefName":"refs/heads/ci/nueva"}]' > "$TMP/mismo.json"
rc=$(AZ_SALIDA="$TMP/mismo.json" AZ_POLICY="$TMP/corriendo.json" corre "$CREAR")
[ "$rc" -eq 0 ] && ok "un pull request de la MISMA rama no bloquea (es el mismo, re-creado)" || no "🔴 bloqueó por su propia rama ($rc)"

# ---------------------------------------------------------------- 4. sólo mira la CREACIÓN
for otro in "az repos pr update --id 1 --auto-complete true" "az repos pr list --org https://x" "az pipelines runs list"; do
  rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/corriendo.json" corre "$otro")
  [ "$rc" -eq 0 ] || { no "🔴 bloqueó un comando que no crea nada: $otro"; break; }
done
[ "$rc" -eq 0 ] && ok "actualizar, listar o consultar ejecuciones no se tocan"

# ---------------------------------------------------------------- 4b. 🔴 un pull request ya construido no bloquea
# Bloquear ante CUALQUIER pull request abierto le impediría a dos personas trabajar en cosas
# distintas del mismo repositorio, que es lo normal en un equipo. Lo que molesta no son dos pull requests: son dos
# construcciones del mismo pipeline a la vez.
rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/terminada.json" corre "$CREAR")
[ "$rc" -eq 0 ] && ok "🔴 con otro pull request abierto pero YA CONSTRUIDO, deja abrir el segundo" \
  || no "🔴 bloqueó aunque la otra construcción ya había terminado ($rc) — eso frena el trabajo normal del equipo"

# ---------------------------------------------------------------- 5. 🔴 si no pudo preguntar, NO bloquea, pero lo DICE
rc=$(AZ_SALIDA="$TMP/nada" AZ_EXIT=1 corre "$CREAR")
[ "$rc" -eq 0 ] && ok "🔴 si no pudo consultar, NO bloquea (un freno que corta a ciegas se apaga)" || no "🔴 bloqueó sin haber podido mirar ($rc)"
grep -q "NO verifiqué" "$TMP/err.txt" && ok "…pero lo DICE: 'no miré' no puede parecer 'está bien'" || no "🔴 no pudo mirar y se calló"

# ---------------------------------------------------------------- 6. el apagado explícito funciona
# 🔴 APAGADO POR DEFAULT: en el dia a dia de un dev esto NO tiene que estorbar. Se enciende sólo
# para una tanda de cambios en varios repos, que es donde se llena la cola de la organizacion.
unset TYCON_PR_ONE_PER_REPO
rc=$(AZ_SALIDA="$TMP/pr.json" AZ_POLICY="$TMP/corriendo.json" corre "$CREAR")
export TYCON_PR_ONE_PER_REPO=1
[ "$rc" -eq 0 ] && ok "🔴 SIN encenderlo (el default), no estorba: un dev no lo ve nunca" || no "🔴 estorba por default: eso frena el trabajo diario del equipo ($rc)"

# ---------------------------------------------------------------- 7. las constancias van a la HOME de la prueba
# Cada caso deja «paso» o «bloqueo» en frenos.jsonl, que sube al buzón y alimenta el tablero: en la HOME
# REAL serían constancias falsas. Evidencia POSITIVA (el real no sirve de control: las sesiones del dev
# escriben ahí al mismo tiempo). Falla si, sin HOME temporal, el archivo de la prueba no existe.
N="$(fake_home_count frenos.jsonl '"freno":"pr-uno-por-repo"')"
[ "${N:-0}" -gt 0 ] && ok "T23 las constancias de los casos quedaron en la HOME de la prueba ($N), no en la real" \
  || no "T23 🔴 ninguna constancia en la HOME de la prueba: fueron al frenos.jsonl real del dev"

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ pr-uno-por-repo: todo verde ($casos casos)"; exit 0; } || { echo "❌ pr-uno-por-repo: $fallos falla(s)"; exit 1; }
