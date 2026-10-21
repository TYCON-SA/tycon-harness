#!/usr/bin/env bash
# tycon-worktree.sh — worktrees con la convención TYCON (ver guides/git-worktrees.md)
#
# Uso (desde adentro del repo, o con -C <repo> de git no — usar cd):
#   tycon-worktree.sh new <slug> [--branch <name>] [--from <ref>]
#       Crea <parent>/<RepoName>--wt-<slug>. Branch default: wt/<slug> desde HEAD.
#       Si --branch ya existe, la checkoutea en el worktree (debe no estar checkeada en otro).
#   tycon-worktree.sh merge-tree [<target>]
#       Crea/reusa <parent>/<RepoName>--merge con <target> (default: main) checkeada.
#       Persistente a propósito: conserva node_modules/bin/obj entre merges.
#   tycon-worktree.sh rm <slug>
#       Remueve <parent>/<RepoName>--wt-<slug>. Se niega si tiene cambios sin commitear.
#   tycon-worktree.sh list
#       git worktree list
#
# bash 3.2-safe (macOS). En Windows: los comandos git crudos de la guía (idénticos).

set -euo pipefail

die() { echo "tycon-worktree: $*" >&2; exit 1; }

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || die "el cwd no es un repo git"
NAME="$(basename "$REPO")"
PARENT="$(dirname "$REPO")"

# Repos del harness: no se worktree-an (safety-guard matchea por path literal;
# el SessionStart los auto-pullea solo en su ruta fija). Ver guides/git-worktrees.md §1.
# (los dos nombres del arnés —el repo interno y el público, que se clona con el nombre del lugar— como
# segmento de ruta: una carpeta que sólo EMPIEZA igual no es el arnés)
case "$REPO" in
  *"/.claude/agent-skills"*|*"/tycon-claude-guides"|*"/tycon-claude-guides/"*|*"/tycon-harness"|*"/tycon-harness/"*)
    die "no crear worktrees de $NAME — ver guides/git-worktrees.md §1" ;;
esac

CMD="${1:-}"
[ -n "$CMD" ] || die "falta subcomando: new | merge-tree | rm | list"
shift || true

sanitize_slug() {
  case "$1" in
    *[!A-Za-z0-9._-]*|"") die "slug inválido '$1' (solo A-Za-z0-9 . _ -)" ;;
  esac
}

post_checklist() {
  local wt="$1"
  echo ""
  echo "Worktree listo: $wt"
  echo "Checklist antes de correr gates/suites ahí (guides/git-worktrees.md §6):"
  [ -f "$wt/package.json" ] && echo "  • npm install   (node_modules no viaja con el checkout)"
  if ls "$wt"/*.sln >/dev/null 2>&1 || ls "$wt"/*/*.csproj >/dev/null 2>&1; then
    echo "  • dotnet restore   (bin/obj no viajan)"
  fi
  echo "  • .env / secrets no trackeados: copiarlos a mano si el gate runtime los necesita"
  echo "  • NO inicializar codegraph acá (worktree efímero → grep permitido sin .codegraph/)"
}

case "$CMD" in
  new)
    SLUG="${1:-}"; [ -n "$SLUG" ] || die "uso: new <slug> [--branch <name>] [--from <ref>]"
    sanitize_slug "$SLUG"; shift
    BRANCH="wt/$SLUG"; FROM="HEAD"
    while [ $# -gt 0 ]; do
      case "$1" in
        --branch) BRANCH="${2:-}"; [ -n "$BRANCH" ] || die "--branch requiere valor"; shift 2 ;;
        --from)   FROM="${2:-}";   [ -n "$FROM" ]   || die "--from requiere valor";   shift 2 ;;
        *) die "flag desconocido: $1" ;;
      esac
    done
    WT="$PARENT/$NAME--wt-$SLUG"
    [ -e "$WT" ] && die "ya existe $WT (rm primero, o elegí otro slug)"
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$REPO" worktree add "$WT" "$BRANCH"
    else
      git -C "$REPO" worktree add -b "$BRANCH" "$WT" "$FROM"
    fi
    post_checklist "$WT"
    ;;

  merge-tree)
    TARGET="${1:-main}"
    WT="$PARENT/$NAME--merge"
    CURRENT="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
    if [ -d "$WT" ] && git -C "$WT" rev-parse --show-toplevel >/dev/null 2>&1; then
      echo "Worktree de merge ya existe: $WT (branch: $(git -C "$WT" rev-parse --abbrev-ref HEAD))"
      git -C "$WT" status --porcelain | head -5
      exit 0
    fi
    [ "$CURRENT" = "$TARGET" ] && die "tu working tree principal ya está en '$TARGET' — una branch no puede estar checkeada en dos worktrees; usá el merge en modo normal"
    git -C "$REPO" worktree add "$WT" "$TARGET"
    post_checklist "$WT"
    echo "  • persistente: NO lo borres al terminar el merge — amortiza el install entre merges"
    ;;

  rm)
    SLUG="${1:-}"; [ -n "$SLUG" ] || die "uso: rm <slug>"
    sanitize_slug "$SLUG"
    WT="$PARENT/$NAME--wt-$SLUG"
    [ -d "$WT" ] || die "no existe $WT"
    # git worktree remove ya se niega solo si está sucio; el mensaje nuestro es más claro:
    if [ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then
      die "$WT tiene cambios sin commitear — commiteá o descartá antes de remover (override manual: git worktree remove --force)"
    fi
    git -C "$REPO" worktree remove "$WT"
    git -C "$REPO" worktree prune
    echo "Removido $WT (la branch queda — borrala con git branch -d cuando haya mergeado)"
    ;;

  list)
    git -C "$REPO" worktree list
    ;;

  *)
    die "subcomando desconocido '$CMD' (new | merge-tree | rm | list)"
    ;;
esac
