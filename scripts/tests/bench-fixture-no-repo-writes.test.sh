#!/usr/bin/env bash
# bench-fixture-no-repo-writes.test.sh — el sandbox del banco no puede commitear en el repo
# de verdad (2026-09-27).
#
# EL CASO. Un commit que tocaba `agents/tycon-e2e-realness-checker.md` disparó el chequeo de vida del
# pre-commit; el chequeo armó su fixture, y los `git init && git add -A && git commit -qm fixture` del
# fixture cayeron SOBRE LA RAMA DEL DEV: dos commits `fixture` en la punta y el árbol del repo
# reemplazado por el del fixture. El commit del dev se perdió (se recuperó con `git reset`, y estuvo a
# un `git gc` de no volver).
#
# POR QUÉ. git le exporta a sus hooks `GIT_DIR` y `GIT_INDEX_FILE`, cualquier `git` que el hook lance
# las hereda, y GANAN sobre el `cwd`. En un checkout normal `GIT_DIR` vale `.git` —relativo, así que
# con el cwd en el sandbox apunta al sandbox— y no se ve nunca; desde un worktree es ABSOLUTO y se ve.
# Por eso este caso exporta las dos variables en absoluto: reproduce el hook del worktree.
#
# 🔴 ROJO PREVIO: se corre contra la versión anterior del corredor dejándola al lado de la actual
# (necesita su `../lib`), y apuntándole el override:
#    git show HEAD:scripts/controls-bench/advisor-runner.js > scripts/controls-bench/.viejo.js
#    TYCON_ADVISOR_RUNNER=scripts/controls-bench/.viejo.js bash scripts/tests/bench-fixture-no-repo-writes.test.sh
# Ahí C-1 sale rojo: el repo de juguete termina con TRES commits, dos puestos por el fixture. C-2 y
# C-3 quedan verdes en este banco y eso es correcto —los archivos del dev siguen en el disco, lo que
# cambia es el árbol del commit— y son las guardas de que el arreglo no rompa nada por el otro lado.
# En el incidente real eso se vio al revés: `git status` mostraba TODO el repo como no rastreado,
# porque el árbol de la punta ya no era el del repo.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${TYCON_ADVISOR_RUNNER:-$TCG/scripts/controls-bench/advisor-runner.js}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fallos=0
ok()  { echo "✅ $1"; }
mal() { echo "❌ $1"; fallos=$((fallos+1)); }

# Repo de juguete que hace de "repo del dev", con UN commit y un archivo suyo.
REPO="$TMP/repo"
mkdir -p "$REPO"
git init -q -b main "$REPO"
echo 'lo mio' > "$REPO/mio.txt"
git -C "$REPO" add mio.txt
git -C "$REPO" -c user.email=d@d -c user.name=dev commit -qm "trabajo del dev"
ANTES="$(git -C "$REPO" rev-parse HEAD)"

# El corredor, lanzado COMO LO LANZA UN HOOK desde un worktree: GIT_DIR/GIT_INDEX_FILE absolutos.
# `--selftest-retro` arma un fixture con historia git plantada y no habla con ningún modelo.
( cd "$REPO" \
  && GIT_DIR="$REPO/.git" GIT_INDEX_FILE="$REPO/.git/index" \
     node "$RUNNER" --selftest-retro > "$TMP/salida.txt" 2>&1 )
echo "$?" > "$TMP/rc.txt"

DESPUES="$(git -C "$REPO" rev-parse HEAD)"
COMMITS="$(git -C "$REPO" rev-list --count HEAD)"

[ "$ANTES" = "$DESPUES" ] \
  && ok "C-1 el repo del dev sigue en su commit ($COMMITS commit, HEAD intacto)" \
  || mal "C-1 el sandbox movió HEAD del repo del dev: $ANTES → $DESPUES ($COMMITS commits) — es el defecto del 2026-09-27"

if [ -f "$REPO/mio.txt" ] && [ "$(cat "$REPO/mio.txt")" = "lo mio" ]; then
  ok "C-2 el árbol del dev quedó como estaba"
else
  mal "C-2 el sandbox pisó el árbol del dev (mio.txt desapareció o cambió)"
fi

# Y el índice tampoco: un `git add -A` heredado deja staged lo que el dev no staggeó.
if [ -z "$(git -C "$REPO" diff --cached --name-only)" ]; then
  ok "C-3 el índice del dev quedó vacío (no le staggearon nada)"
else
  mal "C-3 quedó staged en el repo del dev: $(git -C "$REPO" diff --cached --name-only | tr '\n' ' ')"
fi

# La guarda: el arreglo no puede romper el selftest — si el fixture dejó de armarse, esto no prueba nada.
if [ "$(cat "$TMP/rc.txt")" = "0" ]; then
  ok "C-4 el selftest del corredor sigue verde (el fixture se armó de verdad)"
else
  mal "C-4 el selftest salió en rojo (rc=$(cat "$TMP/rc.txt")): el caso no probó nada"; tail -6 "$TMP/salida.txt"
fi

echo "─────────────────────────────"
[ "$fallos" -eq 0 ] && { echo "✅ OK — el sandbox del banco no toca el repo que lo lanzó"; exit 0; } \
                    || { echo "❌ FALLARON $fallos chequeo(s)"; exit 1; }
