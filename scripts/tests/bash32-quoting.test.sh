#!/usr/bin/env bash
# bash32-quoting.test.sh — red de scripts/ci/check-bash32-quoting.sh (2026-09-18).
#
# El defecto que cierra: en el bash 3.2 de macOS, `$VAR` pegado a un carácter no ASCII se come el
# primer byte del carácter y rompe la variable (`«$X»` → `«�`). Apareció dos veces (2.13, 1.5) y la
# tercera vez se midió: 16 apariciones latentes en el repo, cazadas por nadie. Un control que hay que
# acordarse de correr con el intérprete viejo no corre; éste es un grep y corre en cualquier bash.
#
# 🔴 El primer caso es la PRUEBA del defecto, no del lint: se corre el bash 3.2 real de la máquina
#    (si está) y se exige que rompa. Sin eso, el lint estaría marcando algo que nadie vio romperse.
# 🔴 ROJO PREVIO: con el lint ausente (TYCON_BASH32_LINT=/dev/null) los casos 2, 4, 5 y 6 salen rojos.
# 🔴 Y los ejemplos rotos se construyen con `printf … $%s` a propósito: si este archivo contuviera la
#    secuencia literal, el lint lo marcaría a él (le pasó a la primera versión: el propio test se rompió
#    en bash 3.2 por un «$salida» en su mensaje — el arreglo automático después le «arregló» los ejemplos).
set -uo pipefail
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINT="${TYCON_BASH32_LINT:-$TCG/scripts/ci/check-bash32-quoting.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fallos=0
ok()  { echo "✅ $1"; }
mal() { echo "❌ $1"; fallos=$((fallos+1)); }

# C-1 · el defecto existe de verdad en el bash 3.2 (si esta máquina lo tiene)
if [ -x /bin/bash ] && /bin/bash --version 2>/dev/null | grep -q "version 3\.2"; then
  printf -v cmd 'echo "«$%s»"' X                      # el comando lleva la secuencia rota de verdad; este archivo, no
  # el defecto aparece con el idioma en UTF-8 (el de la terminal de cualquier dev); sin idioma o en C, bash 3.2 lee
  # byte a byte y la línea sale bien — una corrida de fondo sin LANG daba el rojo falso de abajo (2026-09-29)
  salida="$(LC_ALL=en_US.UTF-8 X=3 /bin/bash -c "$cmd")"
  [ "$salida" != "«3»" ] && ok "C-1 el bash 3.2 real rompe «\${X}» (salió «${salida}»): el lint caza un defecto que existe" \
                        || mal "C-1 el bash 3.2 de esta máquina NO rompe «\${X}»: revisar si el lint sigue teniendo sentido"
else
  echo "⏭  C-1 sin bash 3.2 en /bin/bash — se saltea CON CONSTANCIA (el defecto se midió en macOS el 2026-09-18)"
fi

# Repo de juguete con guiones .sh
mkdir -p "$T/r/s"; git -C "$T/r" init -q -b main
printf '#!/bin/bash\nX=3\necho "«$%s»"\necho "$%s→ listo"\n' X X > "$T/r/s/roto.sh"
printf '#!/bin/bash\nX=3\necho "«${X}»"\necho "($X, $X)"\n# un comentario con $%s» no cuenta\n' X > "$T/r/s/sano.sh"
git -C "$T/r" add -A; git -C "$T/r" -c user.email=b@b -c user.name=b commit -qm base

# C-2 · marca las dos líneas rotas y sale 1
out="$( cd "$T/r" && bash "$LINT" s/roto.sh 2>&1 )"; rc=$?
if [ "$rc" = 1 ] && [ "$(printf '%s\n' "$out" | grep -c '^s/roto.sh:')" = 2 ]; then ok "C-2 marca las 2 líneas rotas y sale 1"
else mal "C-2 rc=$rc, salida: $(printf '%s' "$out" | head -3 | tr '\n' '|')"; fi

# C-3 · el guion sano pasa: llaves, ASCII después de la variable y comentarios no cuentan
out="$( cd "$T/r" && bash "$LINT" s/sano.sh 2>&1 )"; rc=$?
[ "$rc" = 0 ] && ok "C-3 \${X}, \$X seguido de ASCII y un comentario no marcan (exit 0)" || mal "C-3 marcó de más (rc=$rc): $out"

# C-4 · --staged mira el ÍNDICE, no el disco: se arregla en disco sin stagear y tiene que seguir rojo
( cd "$T/r" && printf '#!/bin/bash\nX=3\necho "«${X}»"\n' > s/roto.sh )
rc=$( cd "$T/r" && bash "$LINT" --staged s/roto.sh >/dev/null 2>&1; echo $? )
[ "$rc" = 1 ] && ok "C-4 --staged juzga el índice (el disco ya está arreglado y sigue rojo)" || mal "C-4 --staged leyó el disco (rc=$rc)"
( cd "$T/r" && git add s/roto.sh )
rc=$( cd "$T/r" && bash "$LINT" --staged s/roto.sh >/dev/null 2>&1; echo $? )
[ "$rc" = 0 ] && ok "C-4 y stageado el arreglo, pasa" || mal "C-4 stageado el arreglo sigue rojo (rc=$rc)"

# C-5 · sin rutas recorre todos los .sh del repo
( cd "$T/r" && printf '#!/bin/bash\nY=1\necho "$%s…"\n' Y > s/otro.sh && git add s/otro.sh )
out="$( cd "$T/r" && bash "$LINT" 2>&1 )"; rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '^s/otro.sh:3:' && ok "C-5 sin rutas recorre el repo y encuentra el nuevo" || mal "C-5 rc=$rc: $out"

# C-6 · fuera de un repo no dice «limpio»: sale 2
rc=$( cd "$T" && bash "$LINT" >/dev/null 2>&1; echo $? )
[ "$rc" = 2 ] && ok "C-6 fuera de un repo sale 2, no verde" || mal "C-6 fuera de un repo salió $rc"

echo "─────────────────────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ OK — el lint de bash 3.2 caza lo que rompe y deja pasar lo sano"; else echo "❌ FALLARON $fallos chequeo(s)"; fi
exit $(( fallos > 0 ))
