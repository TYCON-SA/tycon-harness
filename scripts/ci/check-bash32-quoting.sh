#!/usr/bin/env bash
# check-bash32-quoting.sh — `$VAR` pegado a un carácter que no es ASCII rompe la variable en bash 3.2.
#
# Motivo: el bash 3.2 de macOS —el único que corre en producción en la máquina del dev, bajo
# LaunchAgent— parsea el nombre de una variable byte a byte, y en una locale UTF-8 se come el primer
# byte del carácter que sigue. Reproducido con /bin/bash 3.2.57:
#     X=3; echo "«$X»"   →  «�        echo "$X→"   →  ��        echo "($X,"  →  (3,
# No es sólo «»: cualquier carácter fuera de ASCII (→ … ⏎ · —) rompe igual. Con `${X}` no pasa. En el
# bash 5 de Homebrew y en el agente Linux del nocturno no se reproduce, así que la suite sale verde en
# todos lados menos donde importa.
#
# Por qué es un lint y no «correr las suites con /bin/bash»: las suites ya no corren en la máquina
# del dev (van al nocturno de Azure, Linux, bash 5), así que esa instrucción no cazaría nada. Un
# control que hay que acordarse de correr con el intérprete viejo es un control que no corre. Esto es
# un grep: corre en cualquier bash, en el pre-commit sobre lo stageado y a mano sobre el repo.
#
# Uso:
#   scripts/ci/check-bash32-quoting.sh [--staged] [ruta…]
#     --staged   mira lo que está en el índice de git (el pre-commit), no el disco
#     sin rutas  todos los .sh del repo (o los stageados con --staged)
# Sale 0 sin hallazgos, 1 con hallazgos (lista archivo:línea:texto), 2 si no pudo mirar.
#
# Qué marca: `$nombre` seguido INMEDIATAMENTE de un byte fuera de ASCII. No marca `${nombre}` (es el
# arreglo), ni `$nombre` seguido de ASCII, ni comentarios (empiezan con #).
set -uo pipefail

STAGED=0; RUTAS=()
for a in "$@"; do
  case "$a" in
    --staged) STAGED=1 ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    *) RUTAS+=("$a") ;;
  esac
done

RAIZ="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "check-bash32-quoting: no estoy en un repo git — no pude mirar" >&2; exit 2; }
cd "$RAIZ" || exit 2

if [ "${#RUTAS[@]}" -eq 0 ]; then
  if [ "$STAGED" = 1 ]; then
    while IFS= read -r f; do RUTAS+=("$f"); done < <(git diff --cached --name-only --diff-filter=ACMR -- '*.sh')
  else
    while IFS= read -r f; do RUTAS+=("$f"); done < <(git ls-files -- '*.sh')
  fi
fi
[ "${#RUTAS[@]}" -eq 0 ] && { echo "check-bash32-quoting: sin guiones .sh que mirar"; exit 0; }

# El patrón, en bytes: `$` + nombre + un byte >= 0x80. Se usa perl porque el grep de macOS no entiende
# \x en clases y el de Linux sí — y este guion tiene que decir lo mismo en las dos plataformas.
HALLAZGOS=0
for f in "${RUTAS[@]}"; do
  if [ "$STAGED" = 1 ]; then contenido="$(git show ":$f" 2>/dev/null)" || { echo "check-bash32-quoting: no pude leer $f del índice" >&2; exit 2; }
  else [ -f "$f" ] || { echo "check-bash32-quoting: no existe $f" >&2; exit 2; }; contenido="$(cat "$f")"; fi
  salida="$(printf '%s\n' "$contenido" | LC_ALL=C perl -ne '
    next if /^\s*#/;
    if (/\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xFF]/) { chomp; print "$.:$_\n"; }
  ')"
  if [ -n "$salida" ]; then
    while IFS= read -r l; do echo "$f:$l"; HALLAZGOS=$((HALLAZGOS+1)); done <<< "$salida"
  fi
done

if [ "$HALLAZGOS" -gt 0 ]; then
  echo "❌ check-bash32-quoting: $HALLAZGOS línea(s) con \$VAR pegado a un carácter no ASCII — en el bash 3.2 de macOS eso rompe la variable. Usá \${VAR}." >&2
  exit 1
fi
echo "✅ check-bash32-quoting: ${#RUTAS[@]} guion(es), sin \$VAR pegado a caracteres no ASCII"
exit 0
