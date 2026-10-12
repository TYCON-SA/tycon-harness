#!/usr/bin/env bash
# sdlc-transitions-nightly.test.sh — los dos casos de la story 2.1 que no se prueban corriendo
# código sino mirando el REPO: que el nocturno no haya engordado (T16, AC 13) y que la red vieja
# del medidor no se haya tocado para acomodar lo nuevo (T18, AC 16).
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo.
#
# Se compara contra `origin/main` —lo PUBLICADO—, no contra el árbol de trabajo: la pregunta es
# "¿qué cambia esta entrega respecto de lo que corre?". Sin `origin/main` a mano el caso sale
# SALTEADO diciéndolo, nunca verde: un chequeo que no pudo mirar no es un chequeo que pasó.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ" || exit 1
FALLOS=0
ok()   { echo "  ok   — $1"; }
mal()  { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
salt() { echo "  ∅    — $1 (SALTEADO, no verde)"; }

BASE="origin/main"
echo "== sdlc-transitions-nightly.test.sh =="

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  salt "no hay $BASE en este clon: los dos casos necesitan la referencia de lo publicado"
  exit 0
fi

# ── T16 · el nocturno imprime la duración y NO sumó pasos ni clones (AC 13) ──
# 🔴 rojo previo: agregar un `- script:` o un `git clone` nuevo para medir las transiciones,
#    o quitar el echo de duración.
YML="pipelines/azure-pipelines.yml"
# story 8.12 (tanda R6): el yml pasó a pipelines/. Hasta el merge, origin/main lo tiene en su ruta de antes: se lee la
# nueva si ya está publicada; si no, la vieja armada DESDE EL MAPA (nunca escrita acá), diciéndolo. Sale 2 sin mapa (la
# copia pública) y 1 si ninguna de las dos está en origin/main.
ruta_publicada() { # <ruta nueva> → la ruta a leer en origin/main
  if git cat-file -e "$BASE:$1" 2>/dev/null; then echo "$1"; return 0; fi
  [ -f scripts/lib/renames.json ] || return 2
  local vieja
  vieja=$(node -e 'try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = m.entries.find((x) => x && x.kind === "file" && x.new === process.argv[2]); if (e) console.log(e.old); } catch (_) {}' \
    scripts/lib/renames.json "$1")
  { [ -n "$vieja" ] && git cat-file -e "$BASE:$vieja" 2>/dev/null; } || return 1
  echo "  ·    — $BASE todavía tiene $1 en su ruta de antes, $vieja: se compara contra esa" >&2
  echo "$vieja"
}
# story 8.7 (tanda B): la copia pública no trae los pipelines del equipo (`pipelines/**` queda afuera). Con un clon de
# la copia —que sí tiene origin/main, a diferencia de la copia recién exportada— este caso buscaba un archivo que no
# viaja y daba rojo. Ahí no hay nocturno que medir: se dice y no se cuenta como verde. En el repo del equipo, que falte
# el yml sigue siendo rojo.
COPIA_PUBLICA=0; { [ ! -f perfil-equipo.json ] || [ ! -f scripts/lib/renames.json ]; } && COPIA_PUBLICA=1
if [ ! -f "$YML" ] && [ "$COPIA_PUBLICA" = 1 ]; then
  salt "T16 NO MEDIDO — la copia pública no trae los pipelines del equipo ($YML)"
elif grep -qE '^\s+echo "⏱ .*medición' "$YML"; then
  ok "T16 el paso de medición imprime su duración"
else
  mal "T16 falta el echo de duración del paso de medición"
fi

cuenta() { grep -cE "$2" <<<"$1"; }
ACTUAL="$(cat "$YML" 2>/dev/null)"
PUB="$(ruta_publicada "$YML")"; RC_PUB=$?
PUBLICADO=""
[ "$RC_PUB" = 0 ] && PUBLICADO="$(git show "$BASE:$PUB" 2>/dev/null)"
if [ "$RC_PUB" = 2 ]; then
  salt "T16 NO MEDIDO — copia pública sin el mapa"
elif [ -z "$PUBLICADO" ]; then
  salt "T16 no se pudo leer $YML de $BASE (ni su ruta de antes)"
else
  # los displayName de los PASOS (sangría de paso, 8 o más): los de la cabecera —un parámetro, el horario, el trabajo—
  # no son pasos (story 8.26 B sumó dos parámetros con su displayName; la plantilla traer-arnes.yml no es un paso escrito acá)
  for par in '\bclone\b|clones' '^\s+- script:|pasos' '^ {8,}displayName:|displayName'; do
    RE="${par%%|*}"; NOM="${par##*|}"
    A=$(cuenta "$ACTUAL" "$RE"); P=$(cuenta "$PUBLICADO" "$RE")
    if [ "$A" -eq "$P" ]; then ok "T16 misma cantidad de $NOM que en $BASE ($A)"
    # story 8.18 (AC 16): el nocturno dejó de clonar agent-skills —las skills vienen en el checkout del repo unido—, así
    # que trae MENOS clones que lo publicado. La regla escrita es «no puede agregar ni un paso ni un clon»: de menos, en
    # los clones, la cumple. Sólo para ese par: un paso o un displayName de menos sigue siendo un cambio que mirar.
    elif [ "$NOM" = clones ] && [ "$A" -lt "$P" ]; then ok "T16 menos clones que en $BASE ($P → $A): no agregó ninguno"
    else mal "T16 los $NOM pasaron de $P a $A — la story 2.1 no puede agregar ni un paso ni un clon"; fi
  done
fi

# ── T18 · la red vieja del medidor sigue verde y sus casos NO se tocaron (AC 16) ──
# 🔴 rojo previo: editar un caso viejo para acomodar los campos nuevos del snapshot.
VIEJO="scripts/tests/sdlc-stage-metrics.test.js"
# Un comentario que cambia no toca un caso: la story 8.10 (tanda B) reemplaza los nombres reales de los comentarios
# por los de la tabla, y eso no acomoda nada. Cuentan las líneas de CÓDIGO borradas o cambiadas.
BORRADAS=$(git diff "$BASE" -- "$VIEJO" | grep -E '^-[^-]' | grep -cvE '^-[[:space:]]*(//|/?\*)' || true)
if [ "$BORRADAS" -eq 0 ]; then
  ok "T18 la suite vieja no perdió ni cambió una línea de código (sólo puede crecer)"
else
  mal "T18 el diff de $VIEJO contra $BASE borra o modifica $BORRADAS línea(s)"
  git diff "$BASE" -- "$VIEJO" | grep -E '^-[^-]' | head -5
fi

if node "$VIEJO" >/dev/null 2>&1; then
  ok "T18 la suite vieja del medidor sigue en verde"
else
  mal "T18 la suite vieja del medidor quedó en rojo"
  node "$VIEJO" 2>&1 | grep -E '^(✖|  Assertion)' | head -5
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
