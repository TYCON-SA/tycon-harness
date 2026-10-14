#!/usr/bin/env bash
# harness-lab-git.test.sh — el git del laboratorio no lanza el mantenimiento automático de git.
#
# Por qué existe: `harness_lab_git` (scripts/tests/lib/harness-lab.sh) corre git sin la configuración de la máquina, y
# git, sin configuración, después de cada `commit` y de cada `fetch` lanza `git maintenance run --auto` y lo deja
# corriendo de fondo. Ese proceso empaqueta objetos sueltos y los borra cuando quiere. Las suites del laboratorio que
# sacan una huella de un repo (`find` + `shasum` de cada archivo, antes y después de un comando) leían un repo que se
# estaba moviendo solo: harness-update.test.sh T8 dio «algún comando escribió en un repo ajeno» sin que nadie hubiera
# escrito (validación del 2026-10-11, con git 2.55.0 en el agente: 139 «No such file or directory» de `./objects/…` y uno
# de `./objects/maintenance.lock` en la salida; la misma suite, con el mismo código, dio verde media hora después).
#
# Lo que no se puede perder (LabGit_NoAutoMaintenance_CommitAndFetch):
#   · un `commit` y un `fetch` hechos con `harness_lab_git` no lanzan ningún proceso de mantenimiento (ni
#     `git maintenance`, ni el `git gc --auto` de un git viejo): se mira en la traza de git, no en el reloj;
#   · el control: el MISMO git, con el mismo ambiente y sin pasar por la función, sí lo lanza. Si un git nuevo dejara
#     de lanzarlo, este guion lo dice en rojo en vez de quedar verde sin medir nada.
#
# 🔴 rojo previo (medido con la función de antes sobre este mismo guion): los dos comandos lanzan
#    `git maintenance run --auto --quiet --detach`.
#
# Laboratorio: un repo y un bare en el temporal. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-lab-git.XXXXXX")"
case "$BASE" in *agent-skills*|*/.claude*|*/.tycon*) echo "❌ harness-lab-git: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT

# cuántos procesos de mantenimiento lanzó el git de esa traza (un `child_start` por proceso hijo)
launched() { # launched <traza>
  local n=0 line
  [ -f "$1" ] || { echo 0; return; }
  while IFS= read -r line; do
    case "$line" in *'"event":"child_start"'*) ;; *) continue ;; esac
    case "$line" in *'"maintenance"'*|*'"gc","--auto"'*) n=$((n+1)) ;; esac
  done < "$1"
  echo "$n"
}
# el mismo ambiente que arma harness_lab_git, sin sus opciones: lo que hacía el laboratorio antes
plain_git() { # plain_git <dir> <args…>
  local d="$1"; shift
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 LC_ALL=C \
    GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
    git -C "$d" "$@"
}

echo "LabGit · el git del laboratorio no lanza el mantenimiento automático"
REPO="$BASE/repo"; BARE="$BASE/bare.git"
mkdir -p "$REPO" "$BARE"
harness_lab_git "$REPO" init -q -b main >/dev/null 2>&1 || mal "no pude crear el repo de juguete"
harness_lab_git "$BARE" init -q --bare >/dev/null 2>&1 || mal "no pude crear el bare de juguete"

# el control primero: sin la función, este git lanza el mantenimiento (si no, lo de abajo no mide nada)
echo uno > "$REPO/a.txt"; plain_git "$REPO" add -A >/dev/null 2>&1
GIT_TRACE2_EVENT="$BASE/plain-commit.json" plain_git "$REPO" commit -q -m "control" >/dev/null 2>&1; RC=$?
N="$(launched "$BASE/plain-commit.json")"
if [ "$RC" = 0 ] && [ "$N" -ge 1 ]; then ok "el control: sin la función, un commit lanza el mantenimiento (${N})"
else mal "el control no midió: rc ${RC}, ${N} proceso(s) de mantenimiento — este git ($(git --version 2>&1)) ya no lo lanza tras un commit, o la traza cambió: lo de abajo no prueba nada"; fi

# con harness_lab_git: un commit…
echo dos > "$REPO/b.txt"; harness_lab_git "$REPO" add -A >/dev/null 2>&1
GIT_TRACE2_EVENT="$BASE/lab-commit.json" harness_lab_git "$REPO" commit -q -m "del laboratorio" >/dev/null 2>&1; RC=$?
N="$(launched "$BASE/lab-commit.json")"
[ "$RC" = 0 ] && [ -s "$BASE/lab-commit.json" ] && [ "$N" = 0 ] && ok "un commit con harness_lab_git no lanza mantenimiento" || mal "commit con harness_lab_git: rc ${RC}, ${N} proceso(s) de mantenimiento (traza: $([ -s "$BASE/lab-commit.json" ] && echo sí || echo no))"
# …y un fetch hacia el bare (como entran los commits al bare en las suites: sin push)
GIT_TRACE2_EVENT="$BASE/lab-fetch.json" harness_lab_git "$BARE" fetch -q "$REPO" +refs/heads/main:refs/heads/main >/dev/null 2>&1; RC=$?
N="$(launched "$BASE/lab-fetch.json")"
[ "$RC" = 0 ] && [ -s "$BASE/lab-fetch.json" ] && [ "$N" = 0 ] && ok "un fetch con harness_lab_git no lanza mantenimiento" || mal "fetch con harness_lab_git: rc ${RC}, ${N} proceso(s) de mantenimiento (traza: $([ -s "$BASE/lab-fetch.json" ] && echo sí || echo no))"
[ "$(harness_lab_git "$BARE" rev-parse refs/heads/main 2>/dev/null)" = "$(harness_lab_git "$REPO" rev-parse HEAD 2>/dev/null)" ] && ok "y el fetch trajo el commit (la traza es de un fetch de verdad)" || mal "el fetch no trajo el commit"
# lo que ve cualquier git lanzado por la función
[ "$(harness_lab_git "$REPO" config --get maintenance.auto 2>/dev/null)" = false ] && [ "$(harness_lab_git "$REPO" config --get gc.auto 2>/dev/null)" = 0 ] \
  && ok "harness_lab_git corre con maintenance.auto=false y gc.auto=0" || mal "harness_lab_git no fija maintenance.auto=false y gc.auto=0"

# ── LabMachine_NoAutoMaintenance_CodeUnderTest (2026-10-14) ──────────────────────────────────────────────────────────
# El git que corre el CÓDIGO BAJO PRUEBA (harness.js) no pasa por harness_lab_git: es un `git` a secas que hereda el
# entorno de la máquina de juguete. Ese git también tiene que correr sin mantenimiento automático: con git 2.55 el
# `fetch` de harness.js reempaquetaba el clon de fondo y harness-repoint.test.sh («byte a byte») salía rojo de a ratos.
# 🔴 rojo previo: sin harness_lab_no_auto_maintenance en el armado, el commit y el fetch de abajo lanzan el mantenimiento.
echo "LabMachine · el git del código bajo prueba, con el entorno de la máquina de juguete, tampoco lo lanza"
(
  harness_lab_create "$BASE/machine" >/dev/null 2>&1 || { echo "  MAL  — no pude armar la máquina de juguete"; exit 1; }
  F=0
  [ "${GIT_CONFIG_KEY_0:-}=${GIT_CONFIG_VALUE_0:-}" = "maintenance.auto=false" ] && [ "${GIT_CONFIG_KEY_1:-}=${GIT_CONFIG_VALUE_1:-}" = "gc.auto=0" ] \
    && echo "  ok   — la máquina de juguete exporta maintenance.auto=false y gc.auto=0 a todo git hijo" || { echo "  MAL  — la máquina de juguete no exporta el apagado: ${GIT_CONFIG_COUNT:-sin GIT_CONFIG_COUNT}"; F=1; }
  R2="$BASE/machine-repo"; B2="$BASE/machine-bare.git"; mkdir -p "$R2" "$B2"
  plain_git "$R2" init -q -b main >/dev/null 2>&1; plain_git "$B2" init -q --bare >/dev/null 2>&1
  echo uno > "$R2/a.txt"; plain_git "$R2" add -A >/dev/null 2>&1
  GIT_TRACE2_EVENT="$BASE/machine-commit.json" plain_git "$R2" commit -q -m "código bajo prueba" >/dev/null 2>&1; RC=$?
  N="$(launched "$BASE/machine-commit.json")"
  [ "$RC" = 0 ] && [ -s "$BASE/machine-commit.json" ] && [ "$N" = 0 ] && echo "  ok   — un commit con un git a secas, en la máquina de juguete, no lanza mantenimiento" || { echo "  MAL  — commit en la máquina de juguete: rc ${RC}, ${N} proceso(s) de mantenimiento"; F=1; }
  GIT_TRACE2_EVENT="$BASE/machine-fetch.json" plain_git "$B2" fetch -q "$R2" +refs/heads/main:refs/heads/main >/dev/null 2>&1; RC=$?
  N="$(launched "$BASE/machine-fetch.json")"
  [ "$RC" = 0 ] && [ -s "$BASE/machine-fetch.json" ] && [ "$N" = 0 ] && echo "  ok   — un fetch con un git a secas, en la máquina de juguete, no lanza mantenimiento" || { echo "  MAL  — fetch en la máquina de juguete: rc ${RC}, ${N} proceso(s) de mantenimiento"; F=1; }
  exit "$F"
) || FALLOS=$((FALLOS+1))

if [ "$FALLOS" = 0 ]; then echo "✅ harness-lab-git: todo verde"; exit 0; fi
echo "❌ harness-lab-git: $FALLOS fallo(s)"; exit 1
