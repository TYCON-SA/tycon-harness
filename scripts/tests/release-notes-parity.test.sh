#!/usr/bin/env bash
# Prueba del detector de paridad de release-notes.sh.
#
# 🔴 Lo que se prueba NO es que salga verde: es que sepa ponerse ROJO. Un control que nunca se pone
# rojo es decoración: un señuelo prueba el mecanismo sólo si el mecanismo puede fallar.
set -u
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$AQUI/scripts/tools/release-notes-parity.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok() { echo "✅ parity: $1"; }
no() { echo "❌ parity: $1"; fallos=$((fallos+1)); }

# 🔴 La siembra tiene que parecerse a una copia REAL, no al mínimo que el detector lee. El detector exige la línea
# `RUIDO=` y también la línea `ULTIMO=`, y FALLA cuando falta —fail-closed deliberado: "no encontré el camino de
# respaldo" no puede leerse como "esta copia no lo necesita"—. Con una siembra que traiga sólo `RUIDO=`, TODAS las
# copias sembradas caerían como "no se pudo leer", y los casos 1, 2 y 3 fallarían por la siembra, no por lo que quieren
# probar.
sembrar() { # $1=nombre  $2=RUIDO
  mkdir -p "$TMP/Prod/$1/scripts"
  {
    printf "#!/usr/bin/env bash\nRUIDO='%s'\n" "$2"
    printf 'ULTIMO=$(git log --format=%%s "$RANGO" | grep -vE "$RUIDO" | head -50)\n'
  } > "$TMP/Prod/$1/scripts/release-notes.sh"
}
# Incluye los dos formatos de merge `Merge PR` y `Merge branch`.
BUENO='^chore: bump version|^chore\(ci\)|^chore: trigger|^Merged PR|^Merge pull request |^Merge PR[ :#]|^Merge branch |^chore: update versions|\[skip ci\]|^ci[:(]|^[a-z]+\(ci\)'

# 1) dos copias sanas → verde
sembrar A "$BUENO"; sembrar B "$BUENO"
node "$GATE" --root "$TMP" >/dev/null 2>&1 && ok "dos copias alineadas salen verde" || no "dos copias alineadas deberían salir verde"

# 2) 🔴 una copia sin ^Merged PR: el commit de merge se colaría en las notas
sembrar B '^chore: bump version|^chore\(ci\)|^chore: trigger|\[skip ci\]'
S=$(node "$GATE" --root "$TMP" 2>&1); R=$?
[ $R -eq 1 ] && ok "caza la copia sin ^Merged PR (el caso Totora)" || no "NO cazó la copia sin ^Merged PR (exit $R)"
echo "$S" | grep -q "Merged PR 2597" && ok "el mensaje nombra el commit que se colaría" || no "el mensaje no dice qué se colaría"

# 3) una copia que filtra DE MÁS: borraría un cambio real del producto
sembrar B "$BUENO"'|^feat'
S=$(node "$GATE" --root "$TMP" 2>&1); R=$?
[ $R -eq 1 ] && ok "caza la copia que borra cambios reales" || no "NO cazó el filtro que borra cambios reales (exit $R)"
echo "$S" | grep -q "BORRA un cambio real" && ok "distingue 'deja pasar ruido' de 'borra lo importante'" || no "no distingue los dos tipos de falla"

# 4) archivo ilegible = falla, NO 'pasa'
sembrar B "$BUENO"
printf "#!/usr/bin/env bash\n# sin RUIDO\n" > "$TMP/Prod/B/scripts/release-notes.sh"
node "$GATE" --root "$TMP" >/dev/null 2>&1; [ $? -eq 1 ] && ok "una copia sin RUIDO= falla (ilegible ≠ aprobado)" || no "una copia sin RUIDO= debería fallar"

# 4b) 🔴 una copia CON su RUIDO pero SIN la línea ULTIMO= también falla. Es el fail-closed del
# detector: sin un caso propio, el único lugar donde se notaría es en los OTROS casos, cayéndose por la siembra. Una conducta deliberada sin caso propio es una conducta que
# el próximo la borra.
sembrar B "$BUENO"
printf "#!/usr/bin/env bash\nRUIDO='%s'\n# sin ULTIMO=\n" "$BUENO" > "$TMP/Prod/B/scripts/release-notes.sh"
S=$(node "$GATE" --root "$TMP" 2>&1); R=$?
[ $R -eq 1 ] && ok "una copia sin ULTIMO= falla (no encontrar el respaldo ≠ no necesitarlo)" || no "una copia sin ULTIMO= debería fallar (exit $R)"
echo "$S" | grep -q "ULTIMO=" && ok "y el motivo nombra la línea que falta" || no "el motivo no dice qué línea falta"

# 5) una raíz VACÍA (existe, sin copias) sale 0 sin romperse
mkdir -p "$TMP/vacio"
node "$GATE" --root "$TMP/vacio" >/dev/null 2>&1
[ $? -eq 0 ] && ok "raíz sin copias sale 0 sin romperse" || no "raíz sin copias debería salir 0"

# 5b) 🔴 una raíz que NO EXISTE, pasada a mano, FALLA — no se lee como "todo bien"
S=$(node "$GATE" --root "$TMP/no-existe-esta-ruta" 2>&1); R=$?
[ $R -eq 1 ] && ok "una raíz inexistente pasada a mano falla (no se lee como 'todo bien')" || no "raíz inexistente debería fallar (exit $R)"
echo "$S" | grep -q "no se revisó nada" && ok "y lo dice con todas las letras" || no "no explica que no revisó nada"

# 6) las copias REALES del equipo están alineadas
if [ -d "$HOME/SourceCode" ]; then
  node "$GATE" >/dev/null 2>&1 && ok "las copias reales del equipo están alineadas" || no "🔴 las copias reales DIVERGEN — corré: node $GATE"
fi

echo "─────────────"
[ $fallos -eq 0 ] && { echo "✅ release-notes-parity: todo verde"; exit 0; } || { echo "❌ release-notes-parity: $fallos falla(s)"; exit 1; }
