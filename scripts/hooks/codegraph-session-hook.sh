#!/usr/bin/env bash
#
# codegraph-session-hook.sh — hook SessionStart de Claude Code (macOS / Linux).
#
# Auto-configura CodeGraph para el repo donde se abre la sesión: si es un
# proyecto y todavía no está seteado, lo indexa y registra el MCP server.
# En sesiones siguientes (repo ya seteado) sale al instante.
#
# Lo instala install-codegraph.sh con `"async": true` — corre en background y
# NO bloquea el arranque de la sesión. NO editar ni invocar a mano.
#
# Diseño defensivo: nunca falla ruidosamente, siempre `exit 0`.

set +e

# ── Reparación de la línea de arranque del arnés (2026-08-27) ────────────────────────────────────
# Este hook es uno de los POCOS que una instalación vieja del arnés sí tiene registrados, y su
# código sí se actualiza con el `git pull` que esas máquinas sí hacen. Por eso entra por acá el
# reparador: el arreglo de "tu línea de arranque no llama al instalador" no puede viajar por el
# instalador que no se llama. Sale en silencio y en un grep si ya está sano.
# Ver incident-log#hook-no-instalado-en-silencio-2026-08-27. Off: TYCON_NO_BOOTSTRAP_HEAL=1
_heal="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
for _c in "$_heal/hooks/harness-bootstrap-heal.sh" "$_heal/harness-bootstrap-heal.sh"; do
  [ -f "$_c" ] && { bash "$_c" || true; break; }
done
unset _heal _c


CWD="$PWD"

# No tocar paths dentro de node_modules / .git
case "$CWD" in
  */node_modules/*|*/.git/*) exit 0 ;;
esac

# 🔴 Nunca tratar el HOME (ni "/") como proyecto (caso: incident-log#codegraph-indexa-el-home).
# Una sesión abierta sin carpeta (VS Code sin workspace) arranca en $HOME; si ahí hay un
# package.json suelto, la heurística de abajo lo toma por proyecto, `codegraph init` indexa
# el home ENTERO y registra un MCP con --path $HOME. Caso real 2026-08-24: 2 h y 87 min de
# CPU indexando, 3.8 GB de índice en ~/.codegraph, en una máquina ya en swap.
# Va ANTES del chequeo de herramientas para que el banco lo pruebe sin depender del PATH.
# Se comparan rutas FÍSICAS (pwd -P): en macOS /var → /private/var, y $HOME puede venir
# sin resolver mientras $PWD viene resuelto (el banco lo cazó en la primera corrida).
CWD_REAL="$(pwd -P 2>/dev/null || echo "$CWD")"
HOME_REAL="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P)"
if [ "$CWD_REAL" = "/" ] || { [ -n "$HOME_REAL" ] && [ "$CWD_REAL" = "$HOME_REAL" ]; }; then
  exit 0
fi

# El binario de codegraph es imprescindible (indexa). El CLI `claude` NO: solo hace falta para
# el registro del MCP del lado Claude. Un dev SOLO-Codex tiene `codegraph` pero puede no tener
# `claude` — antes el hook salía acá (línea vieja `command -v claude || exit 0`) y NUNCA construía
# el índice, así que el server codegraph de Codex (registrado en ~/.codex/config.toml) respondía
# VACÍO en silencio. Ahora el indexado corre igual; el registro Claude queda condicionado abajo.
command -v codegraph >/dev/null 2>&1 || exit 0

# ¿cwd es un proyecto?
IS_PROJECT=0
[ -d "$CWD/.git" ]           && IS_PROJECT=1
[ -f "$CWD/package.json" ]   && IS_PROJECT=1
[ -f "$CWD/go.mod" ]         && IS_PROJECT=1
[ -f "$CWD/Cargo.toml" ]     && IS_PROJECT=1
[ -f "$CWD/pom.xml" ]        && IS_PROJECT=1
[ -f "$CWD/pyproject.toml" ] && IS_PROJECT=1
for f in "$CWD"/*.sln "$CWD"/*.csproj; do [ -e "$f" ] && IS_PROJECT=1; done
[ "$IS_PROJECT" -eq 1 ] || exit 0

# ¿Ya seteado por esta tooling? -> nada que hacer (fast path de cada sesión)
[ -f "$CWD/.codegraph/.tycon-setup-done" ] && exit 0

# --- primera vez en este repo: setup completo ---
if [ ! -d "$CWD/.codegraph" ]; then
  codegraph init -i "$CWD" >/dev/null 2>&1 || exit 0
fi

# .gitignore
GI="$CWD/.gitignore"
if [ -f "$GI" ] && ! grep -qxF ".codegraph/" "$GI" 2>/dev/null; then
  printf '\n# CodeGraph: indice local (SQLite), machine-specific y regenerable\n.codegraph/\n' >> "$GI"
fi

# Registrar el MCP server del lado CLAUDE (scope local; forma larga `--path` porque el `-p` corto
# colisiona con el flag global `-p/--print` del CLI `claude`). SOLO si `claude` está: bajo Codex el
# server codegraph se registra por ~/.codex/config.toml (lo deja el instalador), no por este CLI —
# acá sería un no-op, y en una máquina solo-Codex el CLI ni existe.
if command -v claude >/dev/null 2>&1; then
  BIN="$(command -v codegraph)"
  ( cd "$CWD" \
    && claude mcp remove codegraph >/dev/null 2>&1
    claude mcp add codegraph -- "$BIN" serve --mcp --path "$CWD" >/dev/null 2>&1 )
fi

# Marca de completado -> la próxima sesión sale por el fast path de arriba.
[ -d "$CWD/.codegraph" ] && touch "$CWD/.codegraph/.tycon-setup-done" 2>/dev/null

exit 0
