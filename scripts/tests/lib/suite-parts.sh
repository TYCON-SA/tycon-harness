# suite-parts.sh — partir una suite de consola SIN mover sus casos (story 8.22, tramo F, AC 34).
#
# Ninguna suite pasa de 45 s en la validación de una rama. Una suite de consola con decenas de casos de un segundo sólo
# baja partiéndola, y acá se parte sin cortar el archivo: la suite carga esta biblioteca, dice cuántas partes tiene y
# envuelve cada tramo en un bloque:
#
#     . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
#     suite_parts 2
#     if suite_part 1; then
#     … los casos de la primera mitad, sin tocar (no hace falta sangrarlos) …
#     fi
#     if suite_part 2; then
#     … los de la segunda …
#     fi
#
# Corrida a mano (`bash scripts/tests/x.test.sh`) corre todos los bloques, como siempre. Cada parte es un archivo de una
# línea, `x.p1.test.sh`, registrado en suites.json:
#
#     SUITE_PART=1/2 exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/x.test.sh"
#
# Lo que queda FUERA de los bloques (las funciones, el mundo de prueba, el resumen final) corre en todas las partes: un
# bloque no puede depender de lo que dejó otro. Lo comprueban la corrida de cada parte y el conteo de verificaciones,
# que entre todas tiene que dar el del archivo entero.
#
# 🔴 La variable se saca del ambiente al cargar: si la heredaran los procesos que la suite lanza, otra suite partida
#    corrida desde adentro haría un solo bloque sin que nadie se lo pida.
# 🔴 Lo que esta biblioteca NO puede saber: si un bloque, una vez adentro, verifica algo. Un bloque vaciado a mano (o con
#    todo comentado y un `:`) deja a su parte verde sin verificar nada. La red es el conteo: al partir o tocar los bloques
#    se corre el archivo entero y cada parte, y la suma de verificaciones tiene que dar la del entero. Que cada parte tenga
#    al menos un bloque sí se mide solo (`layoutProblems`, en la gemela de Node).
# Una variable mal escrita, una parte que no existe o un archivo que declara otra cantidad cortan con 2 antes de correr
# nada: «no sé qué parte soy» nunca es «corro todo» ni «no corro nada y salgo verde».
#
# La gemela de Node es scripts/tests/lib/suite-parts.js, que además revisa cómo quedó armada cada suite partida
# (`layoutProblems`). Bash 3.2 y Git Bash: sin arreglos asociativos ni `[[ =~ ]]`.

__suite_part_asked="${SUITE_PART:-}"
unset SUITE_PART
__suite_part_k=""
__suite_part_n=""
if [ -n "$__suite_part_asked" ]; then
  case "$__suite_part_asked" in
    */*/*|/*|*/|*[!0-9/]*) echo "❌ suite-parts: SUITE_PART=${__suite_part_asked} no es <parte>/<partes> (por ejemplo 1/2)" >&2; exit 2 ;;
    */*) ;;
    *) echo "❌ suite-parts: SUITE_PART=${__suite_part_asked} no es <parte>/<partes> (por ejemplo 1/2)" >&2; exit 2 ;;
  esac
  __suite_part_k="${__suite_part_asked%%/*}"
  __suite_part_n="${__suite_part_asked##*/}"
  # Sin ceros adelante: `01` vale 1 como número y no es «1» como texto, y los bloques se comparan como texto. Pasaba la
  # validación, no corría ningún bloque y salía verde (pase adversarial del tramo F).
  case "$__suite_part_k/$__suite_part_n" in
    0*|*/0*) echo "❌ suite-parts: SUITE_PART=${__suite_part_asked} no es <parte>/<partes> (sin ceros adelante; por ejemplo 1/2)" >&2; exit 2 ;;
  esac
  if [ "$__suite_part_k" -lt 1 ] || [ "$__suite_part_k" -gt "$__suite_part_n" ]; then
    echo "❌ suite-parts: SUITE_PART=${__suite_part_asked}: no hay parte ${__suite_part_k} de ${__suite_part_n}" >&2; exit 2
  fi
fi

# suite_parts <n> — la suite dice cuántas partes tiene. Si le pidieron una parte de otra cantidad, corta.
suite_parts() {
  if [ -n "$__suite_part_asked" ] && [ "$1" != "$__suite_part_n" ]; then
    echo "❌ suite-parts: la suite declara $1 partes y le pidieron la ${__suite_part_k} de ${__suite_part_n}" >&2; exit 2
  fi
}

# suite_part <k> — ¿corre este bloque? Entera, siempre; como parte, sólo el suyo.
suite_part() {
  [ -z "$__suite_part_asked" ] || [ "$1" = "$__suite_part_k" ]
}
