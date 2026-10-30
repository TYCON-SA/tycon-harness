#!/usr/bin/env bash
# git-pre-commit-global.sh — el pre-commit de git que vale para TODOS los repos de la máquina.
# Se instala en ~/.git-hooks/pre-commit (lo hace install-tycon-hooks.sh); `core.hooksPath` global
# apunta a ese directorio.
#
# 🔴 POR QUÉ EXISTE ESTE ARCHIVO, Y NO SÓLO EL DE CADA REPO
# Varias guías del arnés documentan el patrón "el repo referencia el linter desde su propio
# `.githooks/pre-commit`" — el lint de frontmatter de stories, el lint de la wiki, el `check.js` de
# paridad con Codex. Sin este archivo, **ninguno corre.** Cuando `core.hooksPath` está seteado a nivel
# global, git usa SÓLO ese directorio: los `.githooks/` de cada repo quedan ignorados, en silencio y
# sin un error que lo delate. Los linters quedan escritos, documentados y adoptados — y no se
# ejecutan nunca.
#
# La solución no es sacar el hooksPath global (rompería el sync de engram, que sí depende de él):
# es que el hook global **delegue** en el del repo. Con eso el patrón que las guías ya documentan
# empieza a funcionar de verdad, y cada repo sigue decidiendo qué chequea sin tocar config global.
#
# Orden: primero los ganchos de la persona y del repo (`pre-commit.local`, `.git/hooks/pre-commit`,
# `.githooks/pre-commit`; cualquiera puede rechazar el commit), después los controles del arnés y al final el sync de
# engram (nunca lo rechaza). Al revés, un commit rechazado igual dejaría chunks stageados.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# El pre-commit global que el dev ya tenía sigue corriendo: el instalador lo conserva como
# `pre-commit.local` al lado de éste, se invoca PRIMERO, y si rechaza, el commit se rechaza.
# Mandarlo a un .bak lo dejaría de correr sin aviso.
LOCAL_HOOK="$(dirname "$0")/pre-commit.local"
if [ -x "$LOCAL_HOOK" ]; then
  if ! "$LOCAL_HOOK" "$@"; then
    echo "⛔ tu pre-commit propio (pre-commit.local) rechazó el commit" >&2
    exit 1
  fi
fi

# ── 0.1. El pre-commit propio del repo en .git/hooks/ ─────────────────────────────────────────────────────────
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
if ! git_dir_hook pre-commit "$@"; then
  echo "⛔ el gancho propio del repo (.git/hooks/pre-commit) rechazó el commit" >&2
  exit 1
fi

# ── 1. Delegación al pre-commit del repo ─────────────────────────────────────────────────────
# Si el repo trae el suyo, corre y su veredicto MANDA. Es lo que hace que
# `.githooks/pre-commit` deje de ser decorativo.
if [ -x "$REPO_ROOT/.githooks/pre-commit" ]; then
  if ! "$REPO_ROOT/.githooks/pre-commit"; then
    echo "⛔ pre-commit del repo rechazó el commit (.githooks/pre-commit)" >&2
    exit 1
  fi
elif [ -f "$REPO_ROOT/.githooks/pre-commit" ]; then
  # Existe pero sin permiso de ejecución: es un hook que el dev cree que corre y no corre —
  # exactamente el modo de falla que este archivo vino a cerrar. Se avisa, no se bloquea.
  echo "⚠ $REPO_ROOT/.githooks/pre-commit existe pero NO es ejecutable — no se corrió. Arreglalo con: chmod +x .githooks/pre-commit" >&2
fi

# ── 1b. Migraciones SQL: compilarlas sin ejecutar, y AVISAR ─────────────────────
# Una migración con un error de sintaxis puede llegar al commit sin haberse ejecutado nunca y frenar un
# despliegue entero. Nunca rechaza el commit: el script sale 0 siempre, y
# acá tampoco se deja que un fallo propio lo rechace. Lo dispara git, así que corre igual desde la
# terminal, VS Code, Claude o Codex. Off: TYCON_SQL_COMPILE=0.
#
# Las variables renombradas a inglés: el nombre viejo sigue apagando hasta el retiro. Este archivo corre
# COPIADO en ~/.git-hooks, así que la biblioteca se busca en el arnés; sin ella (o si no carga), sólo el nombre nuevo —
# nunca rompe un commit. Cuesta ~100 ms por commit.
# El lugar del arnés: la variable; si no, el lugar ~/.claude/tycon-harness y después el nombre viejo
# ~/.claude/tycon-claude-guides, bajo HOME y —en Windows, con HOME en otra carpeta— bajo USERPROFILE. Una sola función
# para todas las lecturas. Los dos nombres van escritos: este archivo corre copiado fuera del repo (copia declarada en
# scripts/tests/fixtures/harness-place-names.json; una prueba frena si se desfasa). Sin `-L` ni `readlink`: preguntar si
# algo es un enlace no anda igual en el bash de Git para Windows; alcanza con que la carpeta exista.
harness_dir() {
  if [ -n "${TYCON_GUIDES_DIR:-}" ]; then printf '%s' "$TYCON_GUIDES_DIR"; return 0; fi
  for _hd_base in "${HOME:-}" "${USERPROFILE:-}"; do
    [ -n "$_hd_base" ] || continue
    if command -v cygpath >/dev/null 2>&1; then _hd_base="$(cygpath -u "$_hd_base" 2>/dev/null || printf '%s' "$_hd_base")"; fi
    for _hd_name in tycon-harness tycon-claude-guides; do
      if [ -d "$_hd_base/.claude/$_hd_name/scripts" ]; then printf '%s' "$_hd_base/.claude/$_hd_name"; return 0; fi
    done
  done
  printf '%s' "${HOME:-}/.claude/tycon-harness"
}
_TCG_DIR="$(harness_dir)"
# el Node del arnés: el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH ni exporta
# nada: el .githooks/pre-commit del repo del dev sigue corriendo con su Node
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$_TCG_DIR/scripts/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
_LEGACY_SH="$_TCG_DIR/scripts/lib/legacy-names.sh"
if [ -f "$_LEGACY_SH" ] && . "$_LEGACY_SH" 2>/dev/null && command -v legacy_env >/dev/null 2>&1; then
  LEGACY_NAMES_WHERE="scripts/hooks/git-pre-commit-global.sh"
  legacy_env TYCON_SQL_COMPILE
  legacy_env TYCON_REVIEWER_RULES
fi
SQL_COMPILA="$_TCG_DIR/scripts/ci/sql-compile.js"
if [ "${TYCON_SQL_COMPILE:-1}" != "0" ] && [ -f "$SQL_COMPILA" ] && command -v "$HNODE" >/dev/null 2>&1; then
  "$HNODE" "$SQL_COMPILA" --staged --repo "$REPO_ROOT" || true
fi
# ── 1b'. Reglas del CLAUDE.md fuera de «Reglas para revisores»: AVISAR ──
# Los revisores del pipeline no cargan el CLAUDE.md: las reglas propias del repo les llegan sólo
# por esa sección. Una regla nueva escrita en otra parte del archivo el revisor no la ve — el aviso
# lo dice al commitear. Con TYPESAFE_API_KEY filtra por probabilidad (tachando antes de mandar);
# sin llave avisa toda línea nueva fuera de la sección. Nunca rechaza. Off: TYCON_REVIEWER_RULES=0.
REGLAS_REV="$_TCG_DIR/scripts/ci/reviewer-rules.js"
if [ "${TYCON_REVIEWER_RULES:-1}" != "0" ] && [ -f "$REGLAS_REV" ] && command -v "$HNODE" >/dev/null 2>&1; then
  "$HNODE" "$REGLAS_REV" --staged --repo "$REPO_ROOT" || true
fi
# ── 1c. El catálogo de producción: forma verificada, y RECHAZA ───────
# `.tycon/production.json` declara qué servidores de base son de producción; el freno
# `prod-access-guard.js` decide con eso. Es lista BLANCA: sólo host, environment y keychain — el
# usuario de la base NO va (vive junto a la contraseña, en el Llavero). A diferencia del bloque
# 1b, acá el veredicto MANDA: una declaración mal formada deja el freno decidiendo con basura.
# Con su nombre anterior (`.tycon/produccion.json`) también, hasta que los productos migren.
# La única salida es la emergencia del próximo commit que la persona firmó en su terminal en este repo
# (`harness.js sign emergency --commit`, lib/harness-sign.js): se gasta sólo si el catálogo rechaza. `TYCON_PROD_LINT=0` ya no apaga nada; se dice.
LINT_PROD="$_TCG_DIR/scripts/production/lint-production-json.js"
SIGN_LIB="$_TCG_DIR/scripts/lib/harness-sign.js"
if [ "${TYCON_PROD_LINT:-1}" = "0" ]; then
  echo "ℹ TYCON_PROD_LINT=0 ya no apaga la revisión del catálogo de producción: la salida es la emergencia (harness.js sign emergency)" >&2
fi
if [ -f "$LINT_PROD" ] && command -v "$HNODE" >/dev/null 2>&1; then
  if ! "$HNODE" "$LINT_PROD" --staged --repo "$REPO_ROOT"; then
    if [ -f "$SIGN_LIB" ] && _emerg="$("$HNODE" "$SIGN_LIB" consume-commit --repo "$REPO_ROOT" 2>/dev/null)"; then
      echo "⚠ el catálogo de producción rechazó el commit y pasa por la emergencia firmada: ${_emerg}" >&2
    else
      echo "⛔ el catálogo de producción rechazó el commit (.tycon/production.json)" >&2
      echo "   Arreglá el catálogo. Si hay que commitear igual, lo decide la persona: firma en su terminal, en este repo," >&2
      echo "   node ~/.claude/tycon-harness/scripts/setup/harness.js sign emergency --reason \"<por qué>\" --commit" >&2
      echo "   (vale para el próximo commit de este repo, por 30 minutos)" >&2
      exit 1
    fi
  fi
elif git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null | grep -E '\.tycon/(production|produccion)\.json$' >/dev/null; then
  # sin el lint o sin node NO se saltea en silencio cuando el commit toca el catálogo: se dice
  echo "⚠ el commit toca el catálogo de producción (.tycon/production.json) y no pude verificarlo (falta $LINT_PROD o node)" >&2
fi

# ── 2. Sync de engram ──────────────────────────────────────────────────────────────────────────
# Sólo en repos que lo pidieron: con .engram/ Y .engram-project. Rechaza el commit sólo si la memoria que el commit puede
# llevar trae una clave: exportarla y prepararla la llevaría al repo y a su historia.
cd "$REPO_ROOT" || exit 0
# sin la carpeta en el disco y sin nada de ella preparado, no hay memoria que mirar (un preparado cuya carpeta se borró
# después igual viaja: por eso no alcanza con mirar el disco)
if [ ! -d "$REPO_ROOT/.engram" ] && [ -z "$(git diff --cached --name-only -- .engram 2>/dev/null)" ]; then exit 0; fi

# La revisión de claves corre en todo repo con .engram/, antes de cualquier salida de abajo: con el sync apagado o sin
# engram, un `git add -A` igual prepara la memoria. Mira lo preparado (como está en el índice, que es lo que se guarda) y
# lo pendiente en el disco. Con una clave, el commit no se crea y la memoria se saca de lo preparado. Sin el detector
# (un arnés viejo) o sin poder mirar, la memoria se saca de lo preparado y el commit pasa: viaja cuando se pueda revisar.
_SECRETOS="$_TCG_DIR/scripts/lib/engram-chunk-secrets.js"
revisar_memoria() {
  local rc
  if [ -f "$_SECRETOS" ] && command -v "$HNODE" >/dev/null 2>&1; then
    "$HNODE" "$_SECRETOS" --repo "$REPO_ROOT"
    rc=$?
  else
    rc=2
    echo "engram: no pude revisar la memoria antes de prepararla (falta $_SECRETOS o node): no se prepara; viaja en un commit cuando el arnés esté al día" >&2
  fi
  case "$rc" in
    0) return 0 ;;
    1) git reset -q -- .engram/ 2>/dev/null; exit 1 ;;
    *) git reset -q -- .engram/ 2>/dev/null; exit 0 ;;
  esac
}
revisar_memoria

[ -d "$REPO_ROOT/.engram" ] || exit 0
[ -f "$REPO_ROOT/.engram-project" ] || exit 0

# engram: este repo PIDE el sync (.engram-project). Con la llave `integrations.engram` apagada no se
# hace y se dice en UNA línea; con la configuración rota, el aviso y sin sync; sin lector, sigue el sync. Este archivo se
# instala COPIADO a ~/.git-hooks/, así que el lector se busca en el arnés, no al lado. Nunca se rechaza un commit por esto.
_CFG_JS="$_TCG_DIR/scripts/lib/tycon-config.js"
if [ -f "$_CFG_JS" ] && command -v "$HNODE" >/dev/null 2>&1; then
  _AV="$(mktemp)"
  # --switch: TYCON_ENGRAM_HOOK puesto manda por encima de la llave, en los dos sentidos (=1 sincroniza aunque la llave
  # esté apagada; =0 ya salió arriba)
  _ESTADO="$("$HNODE" "$_CFG_JS" key engram --hook --switch TYCON_ENGRAM_HOOK 2>"$_AV")" || _ESTADO="prendida"
  case "$_ESTADO" in
    apagada) rm -f "$_AV"; echo "engram apagado en esta máquina: este repo pide sincronizar su memoria (.engram-project) y no se hace (prender: integrations.engram=true en ~/.claude/tycon.json o TYCON_ENGRAM=1)"; exit 0 ;;
    rota) cat "$_AV" >&2; rm -f "$_AV"; exit 0 ;;
  esac
  rm -f "$_AV"
fi

PROJECT="$(tr -d '[:space:]' < "$REPO_ROOT/.engram-project")"
[ -n "$PROJECT" ] || exit 0
command -v engram >/dev/null 2>&1 || exit 0

OUTPUT="$(engram sync --project "$PROJECT" 2>&1 || true)"

if printf '%s' "$OUTPUT" | grep "Created chunk" >/dev/null; then
  # lo recién exportado pasa por la misma revisión antes de prepararse
  revisar_memoria
  git add .engram/
  echo "engram: nuevo chunk auto-staged ($PROJECT)"
fi

exit 0
