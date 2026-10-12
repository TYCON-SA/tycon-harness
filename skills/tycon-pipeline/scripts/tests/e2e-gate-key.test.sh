#!/usr/bin/env bash
# e2e-gate-key.test.sh — que el portón corra SIEMPRE en modo exigente (2026-09-27).
#
# EL DEFECTO QUE CIERRA. Los specs del set crítico de Totora se saltean solos cuando la base no
# tiene los datos que consumen (`test.skip(cantidad === 0, …)`). Playwright devuelve 0, y una corrida
# que no probó nada se leía igual que una que probó todo. El veredicto SIN_EJERCER (2026-09-27) frenó
# el caso extremo —CERO ejecutados—, pero 1 de 4 sigue siendo verde: contar no cierra el hueco.
# La convención que sí lo cierra ya existía (`guides/definition-of-done.md` §2, regla REAL-C8): una
# env var `<DOMAIN>_REQUIRED=1` cuya rama LANZA en vez de saltear. Lo que faltaba era quién la
# prende — y pedirle al dev que se acuerde es el mismo olvido corrido un casillero.
#
# 🔴 ROJO PREVIO VERIFICADO contra la versión publicada del guion (la que no trae el bloque de la
#    llave): 6 de las 9 aserciones salen rojas ahí —las de C-01, C-02, C-03 y los dos avisos de
#    C-04— y las 3 que quedan verdes son justamente las guardas (una corrida verde sigue verde, un
#    salteo no frena, y el veredicto SIN_EJERCER sigue dando 4). Se corre con
#      TYCON_E2E_GATE=<ruta a la copia vieja> bash <este archivo>
#    igual que la suite del bundle. 🔴 La copia vieja va AL LADO del guion real (por ejemplo
#    `scripts/.gate-viejo.sh`): el gate resuelve `lib/e2e-evidence.js` desde su propio directorio, así
#    que una copia en /tmp sale roja por no encontrar la librería —roja por el motivo equivocado, que
#    es una prueba que no prueba nada.
#
# 🔴 EL CASO QUE IMPIDE QUE ESTO ROMPA A NADIE es el C-04: prender la llave NO frena a un repo que
#    todavía no la honra. Un salteo se NOMBRA (deuda visible) y el portón sigue devolviendo 0; si
#    frenara, se apagaría entero antes de que alguien implemente el override.
#
# Sin red y sin Playwright: `npx` se reemplaza por uno falso que además deja su entorno en un archivo.

set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${TYCON_E2E_GATE:-$AQUI/../e2e-gate.sh}"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

[ -f "$GATE" ] || { echo "  MAL  — no encontré el gate en $GATE"; exit 1; }
command -v node >/dev/null || { echo "  ⏭  sin node en esta máquina — se saltea CON CONSTANCIA"; exit 0; }

# ── Banco: repo de juguete + `npx` falso que VUELCA SU ENTORNO ────────────────────────────────
# `pasados`/`salteados` arman el reporte: el salteo es el que interesa, porque es el estado con el
# que el gate mentía en verde.
montar() {
  local T="$1" pasados="$2" salteados="$3" required_env="${4:-}"
  mkdir -p "$T/repo/front" "$T/repo/.tycon" "$T/bin" "$T/ev"
  git init -q -b main "$T/repo"
  ( cd "$T/repo" && git -c user.email=b@b -c user.name=b commit -q --allow-empty -m base )
  mkdir -p "$T/repo/front/tests/e2e"
  echo '// probe' > "$T/repo/front/tests/e2e/probe.spec.ts"
  {
    echo "e2e:"
    echo "  frontend_dir: front"
    [ -n "$required_env" ] && { echo "  required_env:"; for n in $required_env; do echo "    - $n"; done; }
  } > "$T/repo/.tycon/advisors.yaml"
  # npx falso: deja su entorno en entorno.txt y un reporte con los estados pedidos.
  {
    echo '#!/bin/sh'
    printf 'env > "%s/entorno.txt"\n' "$T"
    echo 'cat <<JSON'
    printf '{"suites":[{"specs":['
    # 🔴 Con `seq` no: el `seq` de macOS cuenta HACIA ATRÁS cuando el final es menor que el inicio
    # (`seq 1 0` imprime "1 0"), así que "cero pasados" generaba DOS pruebas que pasaban y el caso
    # C-05 medía otra cosa. Se cuenta a mano, que se comporta igual en las dos plataformas.
    local coma="" i=1
    while [ "$i" -le "$pasados" ]; do printf '%s{"title":"pasa-%s","tests":[{"results":[{"status":"passed"}]}]}' "$coma" "$i"; coma=","; i=$((i+1)); done
    i=1
    while [ "$i" -le "$salteados" ]; do printf '%s{"title":"saltea-%s","tests":[{"results":[{"status":"skipped"}]}]}' "$coma" "$i"; coma=","; i=$((i+1)); done
    printf ']}]}\n'
    echo 'JSON'
    echo 'exit 0'
  } > "$T/bin/npx"
  chmod +x "$T/bin/npx"
}

correr() {  # $1=T → deja salida.txt (stdout+stderr), evidencia en $T/ev, exit en $T/exit.txt
  local T="$1"
  ( export PATH="$T/bin:$PATH"; bash "$GATE" "$T/repo/front" probe "$T/ev" > "$T/salida.txt" 2>&1 )
  echo "$?" > "$T/exit.txt"
}

evidencia() { cat "$1"/ev/*.md 2>/dev/null; }

echo "e2e-gate-key.test.sh — la llave exigente"

# ── C-01 · sin declarar nada, la llave paraguas se prende igual ───────────────────────────────
T="$(mktemp -d)"; montar "$T" 1 0
correr "$T"
if grep -q '^E2E_REQUIRED=1$' "$T/entorno.txt" 2>/dev/null; then
  ok "C-01 sin configurar nada, el gate corre Playwright con E2E_REQUIRED=1"
else
  mal "C-01 la llave paraguas NO llegó al proceso de Playwright (un repo sin declarar nada queda en modo permisivo)"
fi
[ "$(cat "$T/exit.txt")" = "0" ] && ok "C-01 y una corrida verde sigue siendo verde (exit 0)" \
  || mal "C-01 prender la llave cambió el veredicto de una corrida verde (exit $(cat "$T/exit.txt"))"
rm -rf "$T"

# ── C-02 · los nombres por dominio que el repo declara se prenden también ─────────────────────
T="$(mktemp -d)"; montar "$T" 1 0 "E2E_AUDIT_REQUIRED E2E_OMNI_REQUIRED"
correr "$T"
if grep -q '^E2E_AUDIT_REQUIRED=1$' "$T/entorno.txt" 2>/dev/null && grep -q '^E2E_OMNI_REQUIRED=1$' "$T/entorno.txt" 2>/dev/null; then
  ok "C-02 e2e.required_env se respeta: los dos nombres por dominio llegaron prendidos"
else
  mal "C-02 los nombres declarados en e2e.required_env NO llegaron (el repo los declara y no sirven de nada)"
fi
rm -rf "$T"

# ── C-03 · la evidencia dice con qué llaves corrió ────────────────────────────────────────────
# Sin esta línea, un verde exigente y uno permisivo se leen igual y no se puede auditar cuál fue.
T="$(mktemp -d)"; montar "$T" 1 0 "E2E_AUDIT_REQUIRED"
correr "$T"
EV="$(evidencia "$T")"
echo "$EV" | grep -q '^- llave_exigente: .*E2E_REQUIRED=1' \
  && ok "C-03 la evidencia registra la llave paraguas" \
  || mal "C-03 la evidencia no dice con qué llaves corrió: un verde exigente no se distingue de uno permisivo"
echo "$EV" | grep -q '^- llave_exigente: .*E2E_AUDIT_REQUIRED=1' \
  && ok "C-03 y también el nombre por dominio declarado" \
  || mal "C-03 la evidencia omite el nombre por dominio"
rm -rf "$T"

# ── C-04 · 🔴 un salteo se NOMBRA pero NO frena (esto es lo que no rompe a nadie) ─────────────
T="$(mktemp -d)"; montar "$T" 1 3
correr "$T"
grep -q '3 test(s) se saltearon con la llave exigente prendida' "$T/salida.txt" \
  && ok "C-04 nombra los salteos que quedaron con la llave prendida (deuda visible)" \
  || mal "C-04 los salteos con la llave prendida pasan en silencio: el hueco sigue invisible"
grep -qi 'REAL-C8' "$T/salida.txt" \
  && ok "C-04 y cita la regla que dice qué hacer (REAL-C8)" \
  || mal "C-04 avisa pero no dice qué hacer con el aviso"
[ "$(cat "$T/exit.txt")" = "0" ] \
  && ok "C-04 y NO frena: un repo que aún no implementó el override sigue pasando (exit 0)" \
  || mal "C-04 frenó por un salteo (exit $(cat "$T/exit.txt")) — esto apagaría el control en todos los repos"
rm -rf "$T"

# ── C-05 · con TODO salteado sigue mandando el veredicto SIN_EJERCER (exit 4) ─────────────────
# La llave no reemplaza al veredicto: lo acompaña. Si ningún spec la honra y se saltean todos, el
# freno tiene que seguir siendo el de la story FIX-Q1.
T="$(mktemp -d)"; montar "$T" 0 4
correr "$T"
[ "$(cat "$T/exit.txt")" = "4" ] \
  && ok "C-05 todo salteado sigue frenando con exit 4 (faltan datos), la llave no lo pisa" \
  || mal "C-05 con todo salteado el gate devolvió $(cat "$T/exit.txt") en vez de 4"
rm -rf "$T"

echo
[ "$FALLOS" = "0" ] && { echo "todo verde"; exit 0; } || { echo "$FALLOS caso(s) en rojo"; exit 1; }
