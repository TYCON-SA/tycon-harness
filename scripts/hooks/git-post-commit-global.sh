#!/usr/bin/env bash
# git-post-commit-global.sh — después de CADA commit, UNA línea si quedó algo afuera.
#
# ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
# Puede quedar trabajo sin commitear en un checkout, sin que nadie lo diga: la
# evidencia de cierre de una story (que traba el portón), un archivo del inbox modificado
# por el capturador de retrospectivas —que bloquea el `pull` del arranque días seguidos—, o un
# párrafo escrito de madrugada y olvidado al pasar a un clon. Con commits DESPUÉS
# en ese mismo repo, con staging selectivo (la regla de la casa), el commit no dice nada de lo que
# deja atrás.
#
# ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
# Lo instala `install-tycon-hooks.sh` en `~/.git-hooks/post-commit` (la carpeta del `core.hooksPath`
# global), así que corre en TODOS los repos, desde cualquier herramienta —terminal, VS Code, Claude,
# Codex—, porque lo dispara git y no un hook de la herramienta. Tras el commit:
#   1. corre el `.git/hooks/post-commit` propio del repo y delega en su `.githooks/post-commit`, si existen (misma
#      cadena que el pre-commit global);
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
# Apagado del aviso: TYCON_POST_COMMIT_NOTICE=0 (los ganchos de la persona y del repo siguen corriendo). Windows: el instalador `.ps1` no instala hooks de git (deuda
# declarada, la misma que el pre-commit global). Red: controls-bench/cases/hooks/21-hooks-sueltos.json
# y scripts/tests/githook-livefire.test.sh (commits de verdad).
set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# ── 0. el post-commit que el dev ya tenía en la carpeta global sigue corriendo ─────────────────
# El instalador no lo pisa: lo deja en `post-commit.local` al lado de éste, y se invoca primero.
# (mandarlo a un .bak lo dejaría de correr)
LOCAL_HOOK="$(dirname "$0")/post-commit.local"
if [ -x "$LOCAL_HOOK" ]; then "$LOCAL_HOOK" "$@" || true; fi

# ── 0.1. el post-commit propio del repo en .git/hooks/ (como en git: su falla no cambia nada) ──────────────────
# El gancho propio del repo en `.git/hooks/`: con `core.hooksPath` global git no lo llama, así que lo llama éste, como
# haría git sin carpeta global. Se busca en la carpeta común de git (desde un worktree enlazado, la del repo). No corre
# si es este mismo gancho, su `.local` o el `.githooks/` del repo (otro nombre del mismo archivo), si es una copia del
# gancho del arnés (se reconoce por su línea de cabecera, la segunda: un gancho que sólo nombra el archivo del arnés
# corre), o si `.git/hooks` es esta misma carpeta: así nada corre dos veces. Mientras corre lleva
# TYCON_GIT_DIR_HOOK=<gancho>:<carpeta común>; si ese gancho vuelve a llamar a éste, la vuelta de adentro no lo llama
# otra vez (sin lazo). La variable sólo evita esa llamada: no apaga ningún otro control. La primera vez que corre en un
# repo lo dice, con la manera de dejarlo como estaba, y lo anota en la carpeta común para no repetirlo: un archivo por
# gancho, creado sin pisar (`set -C`), así dos corridas a la vez avisan una sola vez. Sin permiso de ejecución, o si git
# no dice cuál es la carpeta común, avisa y no corre. Comparar con `-ef` y no con `readlink`: anda igual en el bash de Git para Windows.
# Devuelve el código del gancho del repo; 0 si no corrió. Está copiado igual en los tres ganchos globales: cada uno
# corre suelto en la carpeta global, sin el arnés al lado.
git_dir_hook() {
  local name="$1" common top hook other seen
  shift
  if ! common="$(git rev-parse --git-common-dir 2>/dev/null)" || ! common="$(cd "$common" 2>/dev/null && pwd -P)"; then
    echo "⚠ no pude ubicar la carpeta de git de este repo: no sé si tiene su propio .git/hooks/$name, y no se corrió" >&2
    return 0
  fi
  [ "${TYCON_GIT_DIR_HOOK:-}" = "$name:$common" ] && return 0
  hook="$common/hooks/$name"
  [ -f "$hook" ] || return 0
  [ "$common/hooks" -ef "$(dirname "$0")" ] && return 0
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || top=""
  for other in "$0" "$(dirname "$0")/$name.local" "${top:+$top/.githooks/$name}"; do
    [ -n "$other" ] && [ -e "$other" ] && [ "$hook" -ef "$other" ] && return 0
  done
  case "$(sed -n 2p "$hook" 2>/dev/null)" in "# git-$name-global.sh"*) return 0 ;; esac
  if [ ! -x "$hook" ]; then
    echo "⚠ $hook existe pero NO es ejecutable — no se corrió. Si querés que corra: chmod +x \"$hook\"" >&2
    return 0
  fi
  seen="$common/tycon-git-dir-hooks-announced/$name"
  if [ ! -e "$seen" ] && { mkdir -p "$(dirname "$seen")" 2>/dev/null; ( set -C; : > "$seen" ) 2>/dev/null || [ ! -e "$seen" ]; }; then
    echo "ℹ desde esta versión del arnés corre también el gancho propio de este repo, $hook (con la carpeta global de ganchos de git no corría). Para dejarlo como estaba: borralo o sacale el permiso de ejecución (chmod -x \"$hook\")." >&2
  fi
  TYCON_GIT_DIR_HOOK="$name:$common" "$hook" "$@"
}
git_dir_hook post-commit "$@" || true

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
# commit, como corren sin nosotros. Ponerla arriba los saltearía a los tres (en el flujo diario del dev,
# con pull.rebase=true, eso es TODO `git pull`).
# Se mira el ESTADO de git, no GIT_REFLOG_ACTION: esa variable no llega a los hooks en un rebase real.
# El apagado silencia sólo este aviso: los ganchos de la persona y del repo corrieron igual.
[ "${TYCON_POST_COMMIT_NOTICE:-1}" = "0" ] && exit 0
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
