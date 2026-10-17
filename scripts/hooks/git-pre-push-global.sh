#!/usr/bin/env bash
# git-pre-push-global.sh — el pre-push de git que vale para TODOS los repos de la máquina (story 8.26, tanda F1 · AC 52).
# Se instala en ~/.git-hooks/pre-push (lo hace el instalador); `core.hooksPath` global apunta a esa carpeta.
#
# 🔴 POR QUÉ ES GLOBAL, Y NO SÓLO EL `.githooks/pre-push` DEL REPO. Con `core.hooksPath` global git usa SÓLO esa
# carpeta: el `.githooks/` de cada repo queda ignorado, en silencio (el hallazgo del 2026-08-22, que el pre-commit global
# documenta). Un `pre-push` del repo, escrito y con sus pruebas en verde, no lo habría llamado nadie — y es el freno
# antes de publicar: lo único que hay entre un nombre y un repo público. Puesto acá corre en CUALQUIER clon, también
# uno recién hecho, sin que nadie tenga que acordarse de prepararlo.
#
# QUÉ HACE, en orden:
#   1. Corre el pre-push que la persona ya tenía (el instalador lo conserva como `pre-push.local`), con los mismos
#      argumentos y la misma entrada que le da git. Si rechaza, el empuje se rechaza. Si está y no se puede ejecutar,
#      lo dice (no corrió) y sigue.
#   2. Llama al freno (scripts/hooks/public-push-guard.js) del arnés INSTALADO, no al del árbol que se empuja: una rama
#      no se juzga con su propia versión del freno. El FRENO decide todo: si el remoto es público, si el empuje es del
#      arnés (por el árbol, por lo que se empuja o por el repo al que va) y qué mira. Este guion no decide nada de eso
#      mientras el freno se pueda correr: decidirlo acá, mirando sólo si el árbol de trabajo trae un archivo, dejaba
#      salir sin mirar una rama del arnés empujada desde otra rama o desde un repo sin árbol.
#   3. Si el freno no se puede correr (no está el guion, no hay `node`): el empuje sale si el remoto claramente no es
#      público (Azure DevOps, o una carpeta local cuya cadena de `origin` termina en una carpeta), o si nada dice que
#      sea del arnés (ni el árbol ni lo que se empuja traen scripts/install-tycon-hooks.sh). Si no, NO sale.
#      Límite declarado de este último paso: sin el freno, este guion no sabe qué repos el arnés declara suyos (la
#      tercera señal del freno); un repo del arnés que no trae ese archivo, empujado desde una máquina sin `node` o
#      sin arnés instalado, sale. Es el caso de una máquina donde tampoco corre nada más del arnés.
#
# No hay variable que lo apague. `.githooks/pre-push` del repo llama a este mismo archivo, para un clon con carpeta de
# hooks propia; sólo en ese caso, y sólo si no hay arnés instalado, vale el freno del propio árbol: se lo dice con
# `--own-tree <carpeta>` como primer argumento (un argumento, no una variable: una variable la pone cualquiera).

set -u

OWN_TREE=""
if [ "${1:-}" = "--own-tree" ]; then OWN_TREE="${2:-}"; shift 2 || shift; fi
REMOTE_NAME="${1:-}"
REMOTE_URL="${2:-}"
TREE_MARK="scripts/install-tycon-hooks.sh"
# La entrada de git (una línea por ref) se lee UNA vez: la necesitan el pre-push propio y el freno. Si no se pudo leer,
# no es «git no empuja nada»: se anota, y al freno se le dice con un argumento (que lee como «no pude mirar»).
INPUT_OK=1
INPUT="$(cat)" || INPUT_OK=0
feed() { if [ -n "$INPUT" ]; then printf '%s\n' "$INPUT"; fi; }

# ── 1. El pre-push que la persona ya tenía ───────────────────────────────────────────────────────────────────────
LOCAL_HOOK="$(dirname "$0")/pre-push.local"
if [ -x "$LOCAL_HOOK" ]; then
  if ! feed | "$LOCAL_HOOK" "$@"; then
    echo "⛔ tu pre-push propio (pre-push.local) rechazó el empuje" >&2
    exit 1
  fi
elif [ -e "$LOCAL_HOOK" ]; then
  echo "⚠️  tu pre-push propio ($LOCAL_HOOK) está y no se puede ejecutar: NO corrió. Dale permiso de ejecución (chmod +x)." >&2
fi

# ── 2. El freno del arnés instalado ──────────────────────────────────────────────────────────────────────────────
# Dónde está el arnés instalado: la variable TYCON_GUIDES_DIR; si no, la casa propia del arnés (`<TYCON_HOME>/harness`,
# que por defecto es ~/.tycon/harness: la versión que la máquina instaló), bajo HOME y —en Windows, con HOME en otra
# carpeta— bajo USERPROFILE. Este archivo corre COPIADO fuera del repo, así que no puede preguntárselo a
# scripts/setup/harness/tycon-home.js. Una máquina que todavía usa un clon como arnés lo dice con la variable.
harness_dir() {
  if [ -n "${TYCON_GUIDES_DIR:-}" ]; then printf '%s' "$TYCON_GUIDES_DIR"; return 0; fi
  if [ -n "${TYCON_HOME:-}" ]; then printf '%s' "$TYCON_HOME/harness"; return 0; fi
  for _hd_base in "${HOME:-}" "${USERPROFILE:-}"; do
    [ -n "$_hd_base" ] || continue
    if command -v cygpath >/dev/null 2>&1; then _hd_base="$(cygpath -u "$_hd_base" 2>/dev/null || printf '%s' "$_hd_base")"; fi
    if [ -d "$_hd_base/.tycon/harness/scripts" ]; then printf '%s' "$_hd_base/.tycon/harness"; return 0; fi
  done
  printf '%s' "${HOME:-}/.tycon/harness"
}
GUARD="$(harness_dir)/scripts/hooks/public-push-guard.js"
WHY=""
if [ ! -f "$GUARD" ]; then
  WHY="no encontré el freno (public-push-guard.js) en el arnés instalado: actualizá el arnés, o decí dónde está con TYCON_GUIDES_DIR"
  # sin arnés instalado, el hook del repo puede prestar el freno del propio árbol (es lo único que hay)
  if [ -n "$OWN_TREE" ] && [ -f "$OWN_TREE/scripts/hooks/public-push-guard.js" ]; then
    GUARD="$OWN_TREE/scripts/hooks/public-push-guard.js"; WHY=""
  fi
fi
# el Node del arnés (story 8.39): el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$(harness_dir)/scripts/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
if [ -z "$WHY" ] && ! command -v "$HNODE" >/dev/null 2>&1; then WHY="falta node en el PATH con que corre git"; fi
if [ -z "$WHY" ]; then
  if [ "$INPUT_OK" -eq 1 ]; then
    feed | "$HNODE" "$GUARD" pre-push "$REMOTE_NAME" "$REMOTE_URL"
  else
    # se le DICE (con cerrarle la entrada no alcanza: Node la reabre sobre nada y lee vacío, que es «nada que empujar»)
    "$HNODE" "$GUARD" pre-push "$REMOTE_NAME" "$REMOTE_URL" --input-unreadable </dev/null
  fi
  exit $?
fi

# ── 3. El freno no se pudo correr: sólo pasa lo que claramente NO es público, o lo que nada dice que sea del arnés ──
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT=""
AZURE_HTTP='^https?://([^@/]+@)?(dev\.azure\.com|[^./]+\.visualstudio\.com)/'
AZURE_SSH='^(ssh://)?[^@/]+@(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]'
not_public() {
  local u="$1" dir="${REPO_ROOT:-.}" hop=0 abs rc
  while [ "$hop" -le 4 ]; do
    # sin dirección: al seguir una carpeta es «no tiene origin» (no sale de esta máquina); de entrada, git siempre
    # pasa una, así que vacía es una dirección que no se sabe leer → pública
    if [ -z "$u" ]; then [ "$hop" -gt 0 ]; return $?; fi
    if [[ "$u" =~ $AZURE_HTTP ]] || [[ "$u" =~ $AZURE_SSH ]]; then return 0; fi
    case "$u" in file://*) u="${u#file://}" ;; esac
    abs="$(cd "$dir" 2>/dev/null && cd "$u" 2>/dev/null && pwd)" || return 1   # no es una carpeta: no se sabe → público
    # sin las variables con que git corre el hook: con GIT_DIR puesta, `git -C <otro>` seguiría leyendo el repo de acá
    u="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX -u GIT_COMMON_DIR git -C "$abs" config --get remote.origin.url 2>/dev/null)"; rc=$?
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then return 1; fi  # git no pudo contestar: no es «sin origin»
    [ "$rc" -eq 0 ] || u=""
    dir="$abs"; hop=$((hop + 1))
  done
  return 1
}
# ¿Algo dice que este empuje es del arnés? El árbol de trabajo, o cualquiera de las puntas que se empujan. Si no se
# pudo leer qué se empuja, no se sabe: cuenta como que sí.
is_harness_push() {
  [ "$INPUT_OK" -eq 1 ] || return 0
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/$TREE_MARK" ]; then return 0; fi
  local _ref sha _rest
  while read -r _ref sha _rest; do
    [ -n "$_ref$sha$_rest" ] || continue                     # un renglón vacío
    case "$sha" in ''|*[!0-9a-f]*) return 0 ;; esac          # una línea que no se sabe leer: no se sabe qué se empuja
    case "$sha" in *[!0]*) ;; *) continue ;; esac            # todo ceros: borra una ref remota, no publica nada
    if git cat-file -e "$sha^{commit}:$TREE_MARK" 2>/dev/null; then return 0; fi
    # «no trae ese archivo» y «git no pudo leer lo que se empuja» salen igual: lo que no se puede leer cuenta como que sí
    git cat-file -e "$sha" 2>/dev/null || return 0
  done <<EOF
$INPUT
EOF
  return 1
}
if not_public "$REMOTE_URL"; then exit 0; fi
if ! is_harness_push; then exit 0; fi
echo "⛔ EMPUJE FRENADO — no pude correr el freno de publicación: $WHY." >&2
echo "   El remoto no es de Azure DevOps ni una carpeta local, así que se trata como público: «no pude mirar» no es «limpio», y nada salió." >&2
exit 1
