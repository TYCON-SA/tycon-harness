# shellcheck shell=bash
# tree-sums.sh — la huella de un árbol con UN shasum para todos sus archivos, para las suites que comparan una carpeta
# antes y después de un comando («no tocó nada»). Lo carga harness-lab.sh, y lo cargan solas las suites que sacan la
# huella antes de armar el laboratorio.
#
# Con un shasum por archivo, la huella de un repo de juguete de ~120 archivos tardaba 2,5 s en la Mac (0,07 s así), y las
# suites del instalador la sacan antes y después de cada comando. Las dos funciones dan las mismas líneas que el lazo de
# un shasum por archivo: una huella vieja y una nueva de la misma carpeta son iguales. Lo mide
# scripts/tests/harness-lab-git.test.sh (LabTreeList).

# tree_file_sums  — lee rutas separadas por NUL y escribe «ruta <sha256>  -» por cada una, en el mismo orden: lo mismo que
# `printf '%s ' "$f"; shasum -a 256 < "$f"` archivo por archivo. shasum escapa un nombre con barra invertida (una «\»
# al principio del renglón y la barra doble): se deshace. Un nombre con salto de línea no da lo mismo, pero el lazo de un
# shasum por archivo tampoco lo leía entero.
tree_file_sums() {
  xargs -0 -r shasum -a 256 \
    | sed -E -e '/^\\[0-9a-f]{64}  /{s/^\\([0-9a-f]{64})  (.*)$/\2 \1  -/;s/\\\\/\\/g;b' -e '}' -e 's/^([0-9a-f]{64})  (.*)$/\2 \1  -/'
}

# tree_list <dir>  — una línea por ruta de <dir>, en el orden de sus rutas: «ruta -> destino» (enlace), «ruta <sha256>  -»
# (archivo) o «ruta/» (lo demás)
tree_list() {
  ( cd "$1" || exit 1
    exec 3< <(find . -type f -print0 | LC_ALL=C sort -z | tree_file_sums)
    find . -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"
      elif [ -f "$f" ]; then IFS= read -r l <&3; printf '%s\n' "$l"
      else printf '%s/\n' "$f"; fi
    done )
}
