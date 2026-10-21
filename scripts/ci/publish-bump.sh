#!/usr/bin/env bash
# publish-bump.sh — commitea y publica el bump de versión de los formularios, SOBREVIVIENDO a la
# carrera de push y al árbol sucio que deja el build. El canónico ÚNICO para los cinco productos.
#
# ── Por qué existe ──────────────────────────────────────────────────────────────────────────
# Cuando dos construcciones terminan cerca (dos merges agrupados, o un trigger más un run manual),
# la segunda encuentra `main` movido y su push rebota. Si cada producto lo resuelve a su manera
# (un `rebase` pelado, con o sin `git checkout -- '*/dist/*'` antes), sobrevive sólo si el árbol
# está limpio o lo único sucio es dist/; cualquier otro archivo trackeado modificado lo mata.
# Cinco copias de esta misma lógica, cada una con su conducta, son el patrón que este arnés ya pagó
# con las 8 copias de release-notes.sh.
#
# Lo que hace, y por qué cada paso:
#   1. `add` de cada pathspec (uno que no matchea nada AVISA y sigue: un `fatal` de git bajo
#      `set -e` dejaría el bump sin commitear y sin publicar, rc=128 mudo para el pipeline).
#   2. commit con la MARCA `Commit: <sha>` en el cuerpo — el commit del que partió la corrida
#      (por default `BUILD_SOURCEVERSION`, lo que el pipeline hizo checkout; si no, HEAD; o
#      `--from <sha>`). 🔴 Es el contrato con `forms-to-version.sh`: la
#      corrida siguiente mira qué cambió DESDE ese sha, y no desde el commit del bot — con dos
#      merges agrupados, sin la marca el formulario del primero no se versionaría nunca, en verde.
#      Sin cambios → commit VACÍO con la misma marca (si no, la corrida siguiente lee la versión
#      anterior de un bot viejo, propone la que ya está en el host, y el host deduplica).
#   3. push; si rebota: fetch, y si lo que quería publicar YA está en el remoto (lo pusheó un run
#      concurrente) → OK benigno, sin duplicar.
#   4. si no: `rebase --autostash` — el `--autostash` es lo que lo hace sobrevivir al árbol sucio;
#      y el `|| true` del abort es lo que hace que el aviso de abajo se IMPRIMA (bajo `set -e`, un
#      `git rebase --abort` con «no rebase in progress» sale 128 y mata al shell antes del aviso).
#   5. tres intentos; si igual no entra: `##vso[task.logissue type=error]` y exit 1 — rojo con
#      motivo, nunca rojo mudo.
#
# Uso (desde el artefacto `arnes-ci`, que los pipelines ya bajan):
#   bash "$(Agent.TempDirectory)/arnes-ci/publish-bump.sh" <rama> "<mensaje>" [--from <sha>] -- <pathspec...>
#   p. ej.:  … publish-bump.sh "$BRANCH_NAME" "chore: update form versions [skip ci]" -- '*/package.json'
# Casos: scripts/tests/publish-bump.test.sh (sin red; remoto bare local).
set -eu

# Las opciones renombradas a inglés: los pipelines de los productos siguen pasando las viejas hasta
# el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci); lo de después de `--` no lo toca.
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  legacy_options 'desde:from' "$@" || exit 2
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi

RAMA="${1:?uso: publish-bump.sh <rama> <mensaje> [--from <sha>] -- <pathspec...>}"
MENSAJE="${2:?falta el mensaje de commit}"
shift 2
DESDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) DESDE="${2:?--from necesita un sha}"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "publicar-bump: faltan los paths a commitear (después de --)" >&2; exit 2; }

aviso() { echo "##vso[task.logissue type=error]$1"; echo "❌ $1" >&2; }
advertencia() { echo "##vso[task.logissue type=warning]$1"; echo "⚠️  $1" >&2; }

# El commit del que partió la corrida (la marca que lee la corrida siguiente). Se resuelve ANTES
# de commitear nada: después, HEAD ya es el bump.
[ -n "$DESDE" ] || DESDE="${BUILD_SOURCEVERSION:-}"
[ -n "$DESDE" ] || DESDE="$(git rev-parse HEAD)"
if ! git cat-file -e "${DESDE}^{commit}" 2>/dev/null; then
  aviso "publicar-bump: el commit de partida «${DESDE}» no existe en este clon — una marca Commit: falsa es peor que ninguna"
  exit 2
fi

for p in "$@"; do
  git add -- "$p" 2>/dev/null || advertencia "publicar-bump: el pathspec «${p}» no matchea ningún archivo — se sigue con el resto"
done
if git diff --staged --quiet; then
  echo "publicar-bump: sin cambios en: $* — igual se deja la marca (commit vacío con Commit: $DESDE) para que la próxima corrida sepa desde dónde mirar"
  git commit -q --allow-empty -m "$MENSAJE" \
    -m "Sin cambios de versión en esta corrida; la marca queda para que la siguiente sepa desde dónde mirar." \
    -m "Commit: $DESDE"
else
  git commit -q -m "$MENSAJE" -m "Commit: $DESDE"
fi

OK=false
for intento in 1 2 3; do
  if git push origin "HEAD:$RAMA"; then OK=true; break; fi
  echo "⚠️  push rechazado (intento $intento de 3) — ¿carrera con otro run?"
  git fetch origin "$RAMA" || true
  # ¿Lo que quería publicar ya está en el remoto? Entonces lo pusheó un run concurrente y no hay
  # nada que reintentar: duplicar el commit sería peor.
  if git rev-parse -q --verify FETCH_HEAD >/dev/null 2>&1 && git diff --quiet FETCH_HEAD HEAD -- "$@"; then
    echo "✅ las versiones ya están en origin/$RAMA (las publicó un run concurrente) — nada que pushear"
    OK=true; break
  fi
  git rebase --autostash FETCH_HEAD || { git rebase --abort || true; aviso "conflicto al rebasar sobre origin/$RAMA — requiere intervención manual"; break; }
  sleep 2
done

if [ "$OK" != true ]; then
  aviso "no se pudo publicar el bump de versión en $RAMA tras 3 intentos — los formularios de esta corrida NO van a llegar hasta el próximo merge"
  exit 1
fi
echo "✅ bump publicado en $RAMA (Commit: $DESDE)"
