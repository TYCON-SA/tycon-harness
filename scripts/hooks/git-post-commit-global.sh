#!/usr/bin/env bash
# git-post-commit-global.sh — después de CADA commit, UNA línea si quedó algo afuera (2026-09-06).
#
# ── POR QUÉ EXISTE (COMMIT-DEJA-AFUERA-1, aprobado por el dev el 2026-09-06) ─────────────────────
# Tres veces en 24 horas quedó trabajo sin commitear en un checkout, sin que nadie lo dijera: la
# evidencia de cierre de dos stories (era lo que trababa el portón), un archivo del inbox modificado
# por el capturador de retrospectivas —que bloqueó el `pull` del arranque seis días seguidos—, y un
# párrafo escrito de madrugada y olvidado al pasar a un clon. En los tres casos hubo commits DESPUÉS
# en ese mismo repo, con staging selectivo (la regla de la casa), y el commit no dijo nada de lo que
# dejaba atrás. El dev lo notó dos días seguidos: «quedan cosas sin commitear constantemente».
#
# ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
# Lo instala `install-tycon-hooks.sh` en `~/.git-hooks/post-commit` (la carpeta del `core.hooksPath`
# global), así que corre en TODOS los repos, desde cualquier herramienta —terminal, VS Code, Claude,
# Codex—, porque lo dispara git y no un hook de la herramienta. Tras el commit:
#   1. delega en `.githooks/post-commit` del repo si existe (misma cadena que el pre-commit global);
#   2. imprime UNA línea si quedaron archivos modificados, borrados o nuevos sin ignorar:
#        ⚠️  quedaron afuera del commit: a.md, b.js (+3 más) — 4 modificados, 1 nuevo sin ignorar
#   3. se calla si no quedó nada.
#
# 🔴 Lo que NO hace, a propósito: no frena (un post-commit no puede, y no debe), no commitea por vos
# (el staging selectivo es la regla: los `bmad-*` de agent-skills jamás entran) y no decide qué es
# basura — sólo lo nombra, para que quien commiteó decida en el momento y no seis días después.
# Lo ignorado por git no cuenta. Lo que un repo quiere excluir del aviso se declara en
# `.tycon/post-commit-ignore` (un patrón glob de bash por línea, `#` comenta), p. ej. `bmad-*`.
#
# Un rebase/cherry-pick de N commits no lo dispara N veces (se mira el estado de git). Si el dev ya tenía un
# post-commit global propio, el instalador lo conserva como `post-commit.local` y este hook lo invoca primero.
# Apagado: TYCON_POST_COMMIT_NOTICE=0. Windows: el instalador `.ps1` no instala hooks de git (deuda
# declarada, la misma que el pre-commit global). Red: controls-bench/cases/hooks/21-hooks-sueltos.json
# y scripts/tests/githook-livefire.test.sh (commits de verdad).
set -u
[ "${TYCON_POST_COMMIT_NOTICE:-1}" = "0" ] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# ── 0. el post-commit que el dev ya tenía en la carpeta global sigue corriendo ─────────────────
# El instalador no lo pisa: lo deja en `post-commit.local` al lado de éste, y se invoca primero.
# (revisión con Fable 2026-09-06, #56: la primera versión lo mandaba a un .bak y dejaba de correr)
LOCAL_HOOK="$(dirname "$0")/post-commit.local"
if [ -x "$LOCAL_HOOK" ]; then "$LOCAL_HOOK" "$@" || true; fi

# ── 1. delegación en el post-commit del repo ────────────────────────────────────────────────────
REPO_HOOK="$REPO_ROOT/.githooks/post-commit"
if [ -f "$REPO_HOOK" ]; then
  if [ -x "$REPO_HOOK" ]; then
    ( cd "$REPO_ROOT" && "$REPO_HOOK" "$@" ) || true
  else
    echo "⚠️  $REPO_HOOK existe pero NO es ejecutable (chmod +x) — no corrió" >&2
  fi
fi

# ── 2. lo que quedó afuera ──────────────────────────────────────────────────────────────────────
# `git status --porcelain` ya excluye lo ignorado; `--untracked-files=all` nombra archivos, no carpetas.
# `core.quotePath=false`: los nombres con acento salen tal cual, no en octal (`m\303\263dulo.md`).
# 🔴 La guarda del rebase va DESPUÉS de las dos delegaciones y silencia SÓLO el aviso propio: un
# rebase o un cherry-pick de N commits dispara el post-commit N veces con el mismo árbol, y una línea
# alcanza — pero el hook previo del dev y el del repo (git-lfs, por ejemplo) tienen que correr en cada
# commit, como corren sin nosotros. Ponerla arriba los salteaba a los tres (crítico del 2do pase con
# Fable, #3 ancho: en el flujo diario del dev, con pull.rebase=true, eso es TODO `git pull`).
# Se mira el ESTADO de git, no GIT_REFLOG_ACTION: esa variable no llega a los hooks en un rebase real.
for d in rebase-merge rebase-apply sequencer; do
  [ -d "$(git rev-parse --git-path "$d" 2>/dev/null)" ] && exit 0
done

STATUS="$(cd "$REPO_ROOT" && git -c core.quotePath=false status --porcelain --untracked-files=all 2>/dev/null)" || exit 0
[ -z "$STATUS" ] && exit 0

IGNORE_FILE="$REPO_ROOT/.tycon/post-commit-ignore"
PATRONES=()
if [ -f "$IGNORE_FILE" ]; then
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%%#*}"; linea="${linea#"${linea%%[![:space:]]*}"}"; linea="${linea%"${linea##*[![:space:]]}"}"
    [ -n "$linea" ] && PATRONES+=("$linea")
  done < "$IGNORE_FILE"
fi
ignorado() {
  local ruta="$1" p
  for p in ${PATRONES[@]+"${PATRONES[@]}"}; do
    # shellcheck disable=SC2254  # el patrón es un glob a propósito
    case "$ruta" in $p|*/$p) return 0;; esac
  done
  return 1
}

MODIFICADOS=0; NUEVOS=0; NOMBRES=()
while IFS= read -r l; do
  [ -z "$l" ] && continue
  estado="${l:0:2}"; ruta="${l:3}"
  # un renombre viene como «R  viejo -> nuevo»: se nombra el destino
  case "$ruta" in *" -> "*) ruta="${ruta##* -> }";; esac
  ruta="${ruta%\"}"; ruta="${ruta#\"}"
  ignorado "$ruta" && continue
  if [ "$estado" = "??" ]; then NUEVOS=$((NUEVOS+1)); else MODIFICADOS=$((MODIFICADOS+1)); fi
  NOMBRES+=("$ruta")
done <<< "$STATUS"

TOTAL=$((MODIFICADOS + NUEVOS))
[ "$TOTAL" -eq 0 ] && exit 0

LISTA=""
i=0
for n in "${NOMBRES[@]}"; do
  i=$((i+1))
  if [ "$i" -le 6 ]; then LISTA="${LISTA:+$LISTA, }$n"; fi
done
[ "$TOTAL" -gt 6 ] && LISTA="$LISTA (+$((TOTAL-6)) más)"
DETALLE=""
[ "$MODIFICADOS" -gt 0 ] && DETALLE="$MODIFICADOS modificado(s)"
[ "$NUEVOS" -gt 0 ] && DETALLE="${DETALLE:+$DETALLE, }$NUEVOS nuevo(s) sin ignorar"
echo "⚠️  quedaron afuera del commit: $LISTA — $DETALLE"
exit 0
