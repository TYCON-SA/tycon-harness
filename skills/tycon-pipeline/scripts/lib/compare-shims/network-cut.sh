#!/usr/bin/env bash
# Lo que corren los reemplazos de gh, az, curl, wget y ssh en las corridas comparadas (historia 8.167): no hablan con
# nadie. Sale 97 con «compare: sin red» y deja su marca en TYCON_COMPARE_MARKS: el resultado es «no comparado: usa la
# red». El primer argumento es el nombre del reemplazo que lo llamó.
nombre="${1:-sin-nombre}"
[ -n "${TYCON_COMPARE_MARKS:-}" ] && printf '%s\n' "$nombre" >> "$TYCON_COMPARE_MARKS"
echo "compare: sin red ($nombre)" >&2
exit 97
