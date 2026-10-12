#!/usr/bin/env bash
# e2e-gate-bundle.test.sh — que las pruebas de navegador no aprueben CÓDIGO VIEJO (2026-09-06).
#
# EL DEFECTO QUE CIERRA. La página de desarrollo carga un archivo ya compilado (`dist/form.dev.js`)
# mientras el build del pipeline genera otro (`dist/form.js`). Si alguien cambia el fuente y no
# recompila, Playwright ejercita la versión ANTERIOR y sale **verde** — el peor resultado posible,
# porque un verde sobre el artefacto equivocado se lee exactamente igual que un verde de verdad.
# Pasó TRES veces (2026-08-22, story M-11, y el merge del 2026-08-27) y las tres se resolvió
# acordándose a mano. Un control que depende de que alguien se acuerde no es un control.
#
# 🔴 ROJO PREVIO VERIFICADO contra la versión PUBLICADA del guion (la que no trae el bloque):
#    los casos 1, 2, 5 y 6 salen rojos ahí y verdes con el control. Se corre con
#      TYCON_E2E_GATE=<ruta a la versión vieja> bash <este archivo>
#    que es el mismo mecanismo que usa esta suite para poder probar su propio rojo.
#
# 🔴 EL CASO QUE IMPIDE QUE ESTO ROMPA A NADIE es el 3: un repo que NO declara el bundle tiene que
#    seguir funcionando igual. El control es opt-in y hoy no lo declara ningún repo del equipo; si
#    rompiera a los que no lo usan, se apagaría entero antes de que alguien lo encienda.
#
# Sin red y sin Playwright: `npx` se reemplaza por uno falso en el PATH.

set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${TYCON_E2E_GATE:-$AQUI/../e2e-gate.sh}"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

[ -f "$GATE" ] || { echo "  MAL  — no encontré el gate en $GATE"; exit 1; }
command -v node >/dev/null || { echo "  ⏭  sin node en esta máquina — se saltea CON CONSTANCIA"; exit 0; }

# ── Banco: repo git de juguete con front, bundle, fuentes y un `npx` falso ────────────────────
# `bundle` y `fuente` son las marcas de tiempo, puestas con `touch -t` y no con esperas: un caso
# que depende de dormir un segundo es un caso que falla en una máquina cargada.
montar() {
  local T="$1" bundle_ts="$2" fuente_ts="$3"
  mkdir -p "$T/repo/front/src" "$T/repo/front/dist" "$T/repo/.tycon" "$T/bin" "$T/ev"
  git init -q -b main "$T/repo"
  ( cd "$T/repo" && git -c user.email=b@b -c user.name=b commit -q --allow-empty -m base )
  echo 'console.log(1)' > "$T/repo/front/src/app.js"
  [ "$bundle_ts" = "AUSENTE" ] || { echo 'viejo' > "$T/repo/front/dist/form.dev.js"; touch -t "$bundle_ts" "$T/repo/front/dist/form.dev.js"; }
  touch -t "$fuente_ts" "$T/repo/front/src/app.js"
  # npx falso: no corre Playwright, deja un JSON mínimo y sale 0 (verde).
  #
  # 🔴 El JSON trae UNA prueba que PASÓ, y no `{}` como hasta el 2026-09-27. Motivo: estos casos
  # miden la dimensión BUNDLE (¿recompila?, ¿de dónde salió?) y para eso necesitan una corrida que
  # por lo demás sea verde. Con `{}` la corrida no ejecutaba NADA, y desde que el gate distingue
  # "no ejerció" de "pasó" (veredicto SIN_EJERCER, story FIX-Q1), `{}` hacía frenar a los cinco
  # casos por un motivo ajeno a lo que quieren probar.
  printf '#!/bin/sh\ncat <<JSON\n{"suites":[{"specs":[{"title":"probe del banco","tests":[{"results":[{"status":"passed"}]}]}]}]}\nJSON\nexit 0\n' > "$T/bin/npx"; chmod +x "$T/bin/npx"
  # el comando de recompilado deja rastro Y toca el bundle, como haría uno de verdad
  printf '#!/bin/sh\necho corrio >> "%s/recompilo.txt"\necho nuevo > "%s/repo/front/dist/form.dev.js"\n' "$T" "$T" > "$T/rebuild.sh"
  chmod +x "$T/rebuild.sh"
}

declarar() {  # $1=T · $2=con-rebuild|sin-rebuild|nada
  local T="$1"
  case "$2" in
    nada) printf 'e2e:\n  preconditions: []\n' > "$T/repo/.tycon/advisors.yaml" ;;
    sin-rebuild) printf 'e2e:\n  bundle:\n    artifact: dist/form.dev.js\n    sources: src\n' > "$T/repo/.tycon/advisors.yaml" ;;
    con-rebuild) printf 'e2e:\n  bundle:\n    artifact: dist/form.dev.js\n    sources: src\n    rebuild: sh %s/rebuild.sh\n' "$T" > "$T/repo/.tycon/advisors.yaml" ;;
  esac
}

correr() {  # imprime el exit code; la salida queda en $T/out.txt y la evidencia en $T/ev/
  local T="$1"
  ( cd "$T/repo/front" && PATH="$T/bin:$PATH" bash "$GATE" "$T/repo/front" 9.9 "$T/ev" ) > "$T/out.txt" 2>&1
  echo $?
}

evidencia() { cat "$1"/ev/*.md 2>/dev/null; }

VIEJO=202601010000   # bundle
NUEVO=202701010000   # fuente

# ── C-01 · fuente más nuevo que el bundle, sin comando de recompilar → FRENA ──────────────────
T=$(mktemp -d); montar "$T" "$VIEJO" "$NUEVO"; declarar "$T" sin-rebuild
RC=$(correr "$T")
if [ "$RC" != "0" ] && grep -qiE "viejo|recompil" "$T/out.txt"; then
  ok "C-01 con el bundle atrasado y sin comando: frena (exit $RC) y dice por qué"
else
  mal "C-01 el gate dejó correr las pruebas sobre código viejo (exit $RC) — el verde no significaría nada"
  head -3 "$T/out.txt" | sed 's/^/       /'
fi
rm -rf "$T"

# ── C-02 · con comando de recompilar → recompila y sigue ──────────────────────────────────────
T=$(mktemp -d); montar "$T" "$VIEJO" "$NUEVO"; declarar "$T" con-rebuild
RC=$(correr "$T")
if [ "$RC" = "0" ] && [ -f "$T/recompilo.txt" ]; then
  ok "C-02 con el bundle atrasado y comando declarado: recompila solo y sigue (exit 0)"
else
  mal "C-02 no recompiló (exit $RC, rastro=$([ -f "$T/recompilo.txt" ] && echo sí || echo no))"
fi
evidencia "$T" | grep -qi "bundle: bundle recompilado" \
  && ok "C-02 la evidencia deja dicho que se recompiló" \
  || mal "C-02 la evidencia no dice que se recompiló — un verde sin esa línea no se puede auditar"
rm -rf "$T"

# ── C-03 · un repo que NO declara el bundle sigue igual ───────────────────────────────────────
# 🔴 El caso que impide que el control se apague: es opt-in, y hoy no lo usa ningún repo.
T=$(mktemp -d); montar "$T" "$VIEJO" "$NUEVO"; declarar "$T" nada
RC=$(correr "$T")
if [ "$RC" = "0" ] && [ ! -f "$T/recompilo.txt" ]; then
  ok "C-03 sin declarar el bundle no cambia nada (exit 0, no recompila)"
else
  mal "C-03 un repo que no usa el control fue afectado (exit $RC)"
fi
evidencia "$T" | grep -qi "bundle: no declarado" \
  && ok "C-03 y la evidencia lo dice: «no declarado», no un silencio" \
  || mal "C-03 la evidencia no distingue «no declarado» de «al día»"
rm -rf "$T"

# ── C-04 · bundle al día → no recompila ───────────────────────────────────────────────────────
# Sin esto, un control que recompila siempre agrega minutos a cada corrida y termina apagado.
T=$(mktemp -d); montar "$T" "$NUEVO" "$VIEJO"; declarar "$T" con-rebuild
RC=$(correr "$T")
if [ "$RC" = "0" ] && [ ! -f "$T/recompilo.txt" ]; then
  ok "C-04 con el bundle al día no recompila al pedo (exit 0)"
else
  mal "C-04 recompiló teniendo el bundle al día (exit $RC)"
fi
evidencia "$T" | grep -qi "bundle: bundle al día" \
  && ok "C-04 la evidencia dice «al día»" || mal "C-04 la evidencia no dice que estaba al día"
rm -rf "$T"

# ── C-05 · el recompilado FALLA → rojo ruidoso, nunca verde ───────────────────────────────────
T=$(mktemp -d); montar "$T" "$VIEJO" "$NUEVO"; declarar "$T" con-rebuild
printf '#!/bin/sh\nexit 3\n' > "$T/rebuild.sh"   # el comando de recompilar se rompe
RC=$(correr "$T")
if [ "$RC" != "0" ] && grep -qiE "recompil" "$T/out.txt"; then
  ok "C-05 si el recompilado falla, el gate falla (exit $RC) — no sigue en verde"
else
  mal "C-05 el recompilado falló y el gate NO se dio por enterado (exit $RC)"
fi
rm -rf "$T"

# ── C-06 · el bundle no existe todavía → se trata como atrasado ───────────────────────────────
T=$(mktemp -d); montar "$T" AUSENTE "$NUEVO"; declarar "$T" sin-rebuild
RC=$(correr "$T")
[ "$RC" != "0" ] && ok "C-06 sin bundle en disco frena igual (exit $RC)" \
                 || mal "C-06 corrió las pruebas sin que exista el archivo que el navegador carga"
rm -rf "$T"

# ── C-07 a C-09 · SIN declarar, con una página de desarrollo que carga el bundle (2026-09-18) ────
# 🔴 El control nació opt-in y medido doce días después NINGÚN repo lo declaraba — ni Totora
#    FrontEnd, donde mordió tres veces y tiene cuatro apps con `dev.html` + `dist/form.dev.js`.
#    Un control que depende de que alguien se acuerde de DECLARARLO es el mismo olvido corrido
#    un casillero. Ahora, si hay un `dev.html` que carga un bundle que existe, la frescura se
#    juzga aunque nadie la haya declarado; `e2e.bundle` queda para apuntar el `rebuild:`.
#    ROJO PREVIO: C-07 salía exit 0 (corría las pruebas sobre el bundle viejo, en verde).
pagina_dev() { printf '<html><body><script src="dist/form.dev.js"></script></body></html>\n' > "$1/repo/front/dev.html"; }

T=$(mktemp -d); montar "$T" "$VIEJO" "$NUEVO"; declarar "$T" nada; pagina_dev "$T"
RC=$(correr "$T")
if [ "$RC" != "0" ] && grep -q "dev.html" "$T/out.txt"; then
  ok "C-07 sin declarar, con dev.html y el bundle atrasado: frena (exit $RC) y nombra la página"
else
  mal "C-07 sin declarar dejó correr las pruebas sobre el bundle viejo que carga dev.html (exit $RC)"; head -3 "$T/out.txt"
fi
grep -q "rebuild" "$T/out.txt" && ok "C-07 y dice cómo hacer que recompile solo (e2e.bundle.rebuild)" \
                               || mal "C-07 frena sin decir cómo se declara el recompilado"
rm -rf "$T"

T=$(mktemp -d); montar "$T" "$NUEVO" "$VIEJO"; declarar "$T" nada; pagina_dev "$T"
RC=$(correr "$T")
[ "$RC" = "0" ] && ok "C-08 sin declarar, con dev.html y el bundle al día: corre (exit 0)" \
                || mal "C-08 frenó con el bundle al día (exit $RC)"
evidencia "$T" | grep -q "bundle: .*dev.html" && ok "C-08 la evidencia dice que lo detectó en dev.html, no «no declarado»" \
                                              || { mal "C-08 la evidencia no dice de dónde salió el bundle"; evidencia "$T" | grep bundle; }
rm -rf "$T"

# el bundle que dev.html nombra NO existe: no se puede juzgar la frescura de nada, y eso se dice
T=$(mktemp -d); montar "$T" AUSENTE "$NUEVO"; declarar "$T" nada; pagina_dev "$T"
RC=$(correr "$T")
[ "$RC" = "0" ] && ok "C-09 dev.html nombra un bundle que no existe: no se inventa un veredicto (exit 0)" \
                || mal "C-09 frenó por un archivo que dev.html nombra pero no está (exit $RC)"
evidencia "$T" | grep -qi "no existe" && ok "C-09 y la evidencia lo dice" || mal "C-09 la evidencia calla que el bundle no existe"
rm -rf "$T"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
