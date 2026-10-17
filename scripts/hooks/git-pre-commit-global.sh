#!/usr/bin/env bash
# git-pre-commit-global.sh — el pre-commit de git que vale para TODOS los repos de la máquina.
# Se instala en ~/.git-hooks/pre-commit (lo hace install-tycon-hooks.sh); `core.hooksPath` global
# apunta a ese directorio.
#
# 🔴 POR QUÉ EXISTE ESTE ARCHIVO, Y NO SÓLO EL DE CADA REPO (hallazgo 2026-08-22)
# Varias guías del arnés documentan el patrón "el repo referencia el linter desde su propio
# `.githooks/pre-commit`" — el lint de frontmatter de stories, el lint de la wiki, el `check.js` de
# paridad con Codex. **Ninguno estaba corriendo.** Cuando `core.hooksPath` está seteado a nivel
# global, git usa SÓLO ese directorio: los `.githooks/` de cada repo quedan ignorados, en silencio y
# sin un error que lo delate. Los linters estaban escritos, documentados y adoptados — y no se
# ejecutaban nunca.
#
# La solución no es sacar el hooksPath global (rompería el sync de engram, que sí depende de él):
# es que el hook global **delegue** en el del repo. Con eso el patrón que las guías ya documentan
# empieza a funcionar de verdad, y cada repo sigue decidiendo qué chequea sin tocar config global.
#
# Orden: primero la delegación (puede rechazar el commit), después el sync de engram (nunca lo
# rechaza). Al revés, un commit rechazado igual dejaría chunks stageados.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# El pre-commit global que el dev ya tenía sigue corriendo: el instalador lo conserva como
# `pre-commit.local` al lado de éste, se invoca PRIMERO, y si rechaza, el commit se rechaza (2026-09-06,
# segundo pase con Fable: la primera versión lo mandaba a un .bak y dejaba de correr sin aviso).
LOCAL_HOOK="$(dirname "$0")/pre-commit.local"
if [ -x "$LOCAL_HOOK" ]; then
  if ! "$LOCAL_HOOK" "$@"; then
    echo "⛔ tu pre-commit propio (pre-commit.local) rechazó el commit" >&2
    exit 1
  fi
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

# ── 1b. Migraciones SQL: compilarlas sin ejecutar, y AVISAR (2026-09-14) ─────────────────────
# Una migración con un error de sintaxis llegó al commit sin haberse ejecutado nunca y frenó un
# despliegue entero (el repo del framework, 054). Nunca rechaza el commit: el script sale 0 siempre, y
# acá tampoco se deja que un fallo propio lo rechace. Lo dispara git, así que corre igual desde la
# terminal, VS Code, Claude o Codex. Off: TYCON_SQL_COMPILE=0.
#
# Las variables renombradas a inglés (story 8.9): el nombre viejo sigue apagando hasta el retiro. Este archivo corre
# COPIADO en ~/.git-hooks, así que la biblioteca se busca en el arnés; sin ella (o si no carga), sólo el nombre nuevo —
# nunca rompe un commit. Cuesta ~100 ms por commit (medido en la tanda B1 de la 8.9: el hook pasó de ~145 a ~245 ms).
# El lugar del arnés (story 8.19, AC 9): la variable; si no, el lugar ~/.claude/tycon-harness y después el nombre viejo
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
# el Node del arnés (story 8.39): el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH ni exporta
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
# ── 1b'. Reglas del CLAUDE.md fuera de «Reglas para revisores»: AVISAR (2026-09-19, story 7.5) ──
# Los revisores del pipeline ya no cargan el CLAUDE.md: las reglas propias del repo les llegan sólo
# por esa sección. Una regla nueva escrita en otra parte del archivo el revisor no la ve — el aviso
# lo dice al commitear. Con TYPESAFE_API_KEY filtra por probabilidad (tachando antes de mandar);
# sin llave avisa toda línea nueva fuera de la sección. Nunca rechaza. Off: TYCON_REVIEWER_RULES=0.
REGLAS_REV="$_TCG_DIR/scripts/ci/reviewer-rules.js"
if [ "${TYCON_REVIEWER_RULES:-1}" != "0" ] && [ -f "$REGLAS_REV" ] && command -v "$HNODE" >/dev/null 2>&1; then
  "$HNODE" "$REGLAS_REV" --staged --repo "$REPO_ROOT" || true
fi
# ── 1c. El catálogo de producción: forma verificada, y RECHAZA (2026-09-15, story 6.1) ───────
# `.tycon/production.json` declara qué servidores de base son de producción; el freno
# `prod-access-guard.js` decide con eso. Es lista BLANCA: sólo host, environment y keychain — el
# usuario de la base NO va (vive junto a la contraseña, en el Llavero). A diferencia del bloque
# 1b, acá el veredicto MANDA: una declaración mal formada deja el freno decidiendo con basura.
# Con su nombre de antes del renombre a inglés (`.tycon/produccion.json`) también: los productos migran en la story de
# retiro (story 8.9, tanda P).
LINT_PROD="$_TCG_DIR/scripts/production/lint-production-json.js"
if [ "${TYCON_PROD_LINT:-1}" != "0" ]; then
  if [ -f "$LINT_PROD" ] && command -v "$HNODE" >/dev/null 2>&1; then
    if ! "$HNODE" "$LINT_PROD" --staged --repo "$REPO_ROOT"; then
      echo "⛔ el catálogo de producción rechazó el commit (.tycon/production.json)" >&2
      exit 1
    fi
  elif git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null | grep -E '\.tycon/(production|produccion)\.json$' >/dev/null; then
    # sin el lint o sin node NO se saltea en silencio cuando el commit toca el catálogo: se dice
    echo "⚠ el commit toca el catálogo de producción (.tycon/production.json) y no pude verificarlo (falta $LINT_PROD o node)" >&2
  fi
fi

# ── 2. Sync de engram (conducta previa, intacta) ──────────────────────────────────────────────
# Sólo en repos que lo pidieron: con .engram/ Y .engram-project. Nunca rechaza un commit.
[ -d "$REPO_ROOT/.engram" ] || exit 0
[ -f "$REPO_ROOT/.engram-project" ] || exit 0

# engram (story 8.3, AC 9/10): este repo PIDE el sync (.engram-project). Con la llave `integrations.engram` apagada no se
# hace y se dice en UNA línea; con la configuración rota, el aviso y sin sync (AC 2); sin lector, como hoy. Este archivo se
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

cd "$REPO_ROOT" || exit 0
OUTPUT="$(engram sync --project "$PROJECT" 2>&1 || true)"

if printf '%s' "$OUTPUT" | grep "Created chunk" >/dev/null; then
  git add .engram/
  echo "engram: nuevo chunk auto-staged ($PROJECT)"
fi

exit 0
