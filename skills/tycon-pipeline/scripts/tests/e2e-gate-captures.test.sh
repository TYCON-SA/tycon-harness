#!/usr/bin/env bash
# =============================================================================
# e2e-gate-captures.test.sh — el gate E2E guarda las capturas de los specs de la story (story 7.24, AC 4)
# =============================================================================
# Caso disparador (2026-10-14, guides/maintaining/incident-log.md#case-screen-passed-all-controls-unreadable-2026-10-14): una ventana pasó todos los controles y
# nadie la vio antes del merge; el dueño la encontró «inentendible» en staging. El gate ahora deja una captura por test
# para que el cierre se la muestre al dev antes de pedir el commit.
#
#   C-01 con filtro: `## Capturas` lista las imágenes copiadas a la evidencia (y sólo imágenes), el veredicto no
#        cambia, la corrida usó el envoltorio y la config del repo queda igual
#   C-02 sin filtro (corrida completa): no guarda capturas y la sección dice por qué
#   C-03 el envoltorio no carga: corre como siempre, mismo veredicto, y la sección dice el motivo
#   C-04 sin playwright.config: la sección lo dice
#
# Sin red y sin Playwright: `npx` se reemplaza por uno falso en el PATH (mismo banco que e2e-gate-bundle.test.sh).
# Correr: bash skills/tycon-pipeline/scripts/tests/e2e-gate-captures.test.sh < /dev/null
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${TYCON_E2E_GATE:-$AQUI/../e2e-gate.sh}"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

[ -f "$GATE" ] || { echo "  MAL  — no encontré el gate en $GATE"; exit 1; }
command -v node >/dev/null || { echo "  ⏭  sin node en esta máquina — se saltea CON CONSTANCIA"; exit 0; }
command -v git >/dev/null || { echo "  MAL  — sin git no se puede armar el repo de prueba"; exit 1; }

# montar <T> <con-config|sin-config> <list-ok|list-falla>
montar() {
  local T="$1" cfg="$2" lista="$3"
  mkdir -p "$T/repo/front/tests" "$T/bin" "$T/ev" "$T/pw-out"
  git init -q -b main "$T/repo"
  [ "$cfg" = "con-config" ] && printf "export default { testDir: './tests', use: { trace: 'off' } };\n" > "$T/repo/front/playwright.config.ts"
  echo "// spec de juguete" > "$T/repo/front/tests/facturas.spec.ts"
  ( cd "$T/repo" && git add -A && git -c user.email=b@b -c user.name=b commit -q -m base )
  # La firma de un PNG al principio: el portón no copia un archivo que no empiece como lo que su extensión dice.
  printf '\211PNG\r\n\032\npng-a' > "$T/pw-out/a.png"; printf '\211PNG\r\n\032\npng-b' > "$T/pw-out/b.png"; printf 'zip' > "$T/pw-out/trace.zip"
  local salida_list=0; [ "$lista" = "list-falla" ] && salida_list=1
  # npx falso: anota sus argumentos; con --list sólo dice si "cargó" la config; si no, imprime un reporte con adjuntos.
  cat > "$T/bin/npx" <<NPX
#!/bin/sh
echo "\$*" >> "$T/args.log"
case " \$* " in *" --list "*) [ $salida_list -eq 0 ] || echo "Error: no pude cargar la config" >&2; exit $salida_list ;; esac
cat <<JSON
{"suites":[{"title":"facturas.spec.ts","specs":[
  {"title":"la lista muestra lo que falta pagar","tests":[{"results":[{"status":"passed","attachments":[{"name":"screenshot","contentType":"image/png","path":"$T/pw-out/a.png"}]}]}]},
  {"title":"el detalle abre","tests":[{"results":[{"status":"passed","attachments":[{"name":"paso del detalle","contentType":"image/png","path":"$T/pw-out/b.png"},{"name":"trace","contentType":"application/zip","path":"$T/pw-out/trace.zip"}]}]}]}
]}]}
JSON
exit 0
NPX
  chmod +x "$T/bin/npx"
}

# correr <T> [filtro...] — imprime el exit code; la salida queda en $T/out.txt y la evidencia en $T/ev/
correr() {
  local T="$1"; shift
  # HOME propio: el portón sella las capturas en el gates.log del home, y la prueba no escribe en el de quien la corre.
  mkdir -p "$T/home"
  ( cd "$T/repo/front" && HOME="$T/home" PATH="$T/bin:$PATH" bash "$GATE" "$T/repo/front" 9.9 "$T/ev" "$@" ) > "$T/out.txt" 2>&1 < /dev/null
  echo $?
}
evidencia() { cat "$1"/ev/*.md 2>/dev/null; }
# capturas_listadas <T> — las líneas de la sección `## Capturas` que son rutas
capturas_listadas() { evidencia "$1" | awk '/^## Capturas/{en=1;next} en&&/^## /{en=0} en&&/^- \//{sub(/^- /,"");print}'; }

# ── C-01 · con filtro: capturas en la evidencia, veredicto igual, config intacta ──────────────────────────────
T=$(mktemp -d); montar "$T" con-config list-ok
RC=$(correr "$T" facturas)
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
evidencia "$T" | grep '^verdict=PASS$' >/dev/null || f="$f veredicto-no-PASS"
evidencia "$T" | grep '^## Capturas' >/dev/null || f="$f sin-sección"
n=0; for p in $(capturas_listadas "$T"); do
  case "$p" in "$T"/ev/9.9-captures-*/*.png) [ -f "$p" ] && n=$((n+1)) ;; *) f="$f ruta-fuera($p)" ;; esac
done
[ "$n" -eq 2 ] || f="$f capturas=$n"
ls "$T"/ev/9.9-captures-*/ 2>/dev/null | grep 'trace' >/dev/null && f="$f copió-el-trace"
grep -- '--config' "$T/args.log" | grep -v -- '--list' >/dev/null || f="$f la-corrida-no-usó-el-envoltorio"
[ -z "$(cd "$T/repo" && git status --porcelain)" ] || f="$f config-del-repo-tocada($(cd "$T/repo" && git status --porcelain | tr '\n' ' '))"
if [ -z "$f" ]; then ok "C-01 con filtro: dos capturas en la evidencia, sin el trace, veredicto PASS y el repo intacto"
else mal "C-01 E2eGate_GuardaCapturasEnEvidencia —$f"; sed 's/^/       /' "$T/out.txt" | head -5; fi
rm -rf "$T"

# ── C-02 · sin filtro: no guarda y dice por qué ───────────────────────────────────────────────────────────────
T=$(mktemp -d); montar "$T" con-config list-ok
RC=$(correr "$T")
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | grep -i 'sin filtro\|completa' >/dev/null || f="$f no-dice-por-qué"
ls -d "$T"/ev/9.9-captures-* >/dev/null 2>&1 && f="$f guardó-capturas"
grep -q -- '--config' "$T/args.log" && f="$f usó-el-envoltorio"
if [ -z "$f" ]; then ok "C-02 sin filtro: no guarda capturas y la evidencia dice por qué"
else mal "C-02 corrida completa —$f"; fi
rm -rf "$T"

# ── C-03 · el envoltorio no carga: corre como siempre y dice el motivo ────────────────────────────────────────
T=$(mktemp -d); montar "$T" con-config list-falla
RC=$(correr "$T" facturas)
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
evidencia "$T" | grep '^verdict=PASS$' >/dev/null || f="$f veredicto-cambió"
evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | grep -i 'no se pudo' >/dev/null || f="$f no-dice-el-motivo"
grep -v -- '--list' "$T/args.log" | grep -- '--config' >/dev/null && f="$f la-corrida-usó-el-envoltorio-roto"
ls "$T/repo/front" | grep 'tycon' >/dev/null && f="$f quedó-el-envoltorio"
if [ -z "$f" ]; then ok "C-03 envoltorio que no carga: misma corrida de siempre, mismo veredicto, y el motivo escrito"
else mal "C-03 envoltorio roto —$f"; fi
rm -rf "$T"

# ── C-04 · sin playwright.config: lo dice ─────────────────────────────────────────────────────────────────────
T=$(mktemp -d); montar "$T" sin-config list-ok
RC=$(correr "$T" facturas)
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | grep -i 'playwright.config' >/dev/null || f="$f no-lo-dice"
if [ -z "$f" ]; then ok "C-04 sin playwright.config: la sección lo dice y la corrida sigue"
else mal "C-04 sin config —$f"; fi
rm -rf "$T"

# ── C-05 · con filtro y una imagen que el reporte nombra pero no está: copia la otra y dice cuál faltó ───────────
# (revisores del paso 5: un error al copiar salía como «ningún test llegó a correr»)
T=$(mktemp -d); montar "$T" con-config list-ok; rm -f "$T/pw-out/b.png"
RC=$(correr "$T" facturas)
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
[ "$(capturas_listadas "$T" | wc -l | tr -d ' ')" = "1" ] || f="$f capturas=$(capturas_listadas "$T" | wc -l | tr -d ' ')"
evidencia "$T" | awk '/^## Capturas/{en=1;next} en&&/^## /{en=0} en{print}' | grep 'b\.png' >/dev/null || f="$f no-nombra-la-que-faltó"
if [ -z "$f" ]; then ok "C-05 una imagen que no está: copia las que hay y nombra la que faltó"
else mal "C-05 imagen faltante —$f"; fi
rm -rf "$T"

# ── C-06 · con filtro y ninguna imagen en el reporte: lo dice sin inventar la causa ──────────────────────────────
T=$(mktemp -d); montar "$T" con-config list-ok
sed -i.bak 's/,"attachments":\[[^]]*\]//g' "$T/bin/npx" && rm -f "$T/bin/npx.bak"
RC=$(correr "$T" facturas)
f=""
[ "$RC" = "0" ] || f="$f exit=$RC"
evidencia "$T" | grep '^verdict=PASS$' >/dev/null || f="$f veredicto-cambió"
evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | grep -i 'no dejó imágenes' >/dev/null || f="$f no-lo-dice"
if [ -z "$f" ]; then ok "C-06 la corrida no dejó imágenes: la sección lo dice y el veredicto no cambia"
else mal "C-06 sin imágenes —$f"; fi
rm -rf "$T"

# ── C-07 · un reporte con otra forma (sin `suites`): la sección lo dice, no culpa a «ningún test corrió» ─────────
T=$(mktemp -d); montar "$T" con-config list-ok
printf '#!/bin/sh\necho "$*" >> "%s/args.log"\ncase " $* " in *" --list "*) exit 0 ;; esac\necho %s\nexit 0\n' "$T" "'{\"otra\":\"forma\"}'" > "$T/bin/npx"; chmod +x "$T/bin/npx"
correr "$T" facturas > /dev/null
f=""
evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | grep -i 'forma esperada' >/dev/null || f="$f no-dice-la-forma"
if [ -z "$f" ]; then ok "C-07 reporte con otra forma: la sección lo dice"
else mal "C-07 reporte raro —$f"; evidencia "$T" | awk '/^## Capturas/{getline; print; exit}' | sed 's/^/       /'; fi
rm -rf "$T"

if [ "$FALLOS" -eq 0 ]; then echo "✅ e2e-gate-captures: 7 de 7"; exit 0; fi
echo "❌ e2e-gate-captures: $FALLOS falla(s)"; exit 1
