#!/usr/bin/env bash
# =============================================================================
# harness-mods-plugin.test.sh — el plugin de los mods del arnés en el motor de Claude Code (T17)
# =============================================================================
# Corre `claude plugin validate` (sin rechazos) y `claude plugin test` (tests/board.test.tsx: el cartel se dibuja con
# una corrida, sin dinero; /mods hide lo saca en el momento; /mods off queda guardado; sin corrida no dibuja).
#
# Necesita un `claude` que traiga `plugin test` (los mods de función son de Claude Code reciente). Busca, en orden:
# TYCON_CLAUDE_BIN, el `claude` del PATH, y el de la extensión de VS Code más nueva. Sin ninguno, se saltea CON
# CONSTANCIA (exit 0): la lógica del plugin la cubre igual scripts/tests/harness-mods.test.js con node.
#
# Correr: bash scripts/tests/harness-mods-plugin.test.sh < /dev/null
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$AQUI/../../mods/harness-mods"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

[ -d "$PLUGIN" ] || { echo "  MAL  — no encontré el plugin en $PLUGIN"; exit 1; }

# una versión vieja contesta el --help de «plugin» (exit 0) sin conocer «test»: se mira el texto propio de «plugin test»
trae_plugin_test() {
  local ayuda
  ayuda="$("$1" plugin test --help 2>&1 < /dev/null)"
  case "$ayuda" in *"Run a mod's tests"*) return 0 ;; esac
  return 1
}

CLAUDE=""
for cand in "${TYCON_CLAUDE_BIN:-}" "$(command -v claude 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ] && trae_plugin_test "$cand"; then CLAUDE="$cand"; break; fi
done
if [ -z "$CLAUDE" ]; then
  for cand in $(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -r); do
    if [ -x "$cand" ] && trae_plugin_test "$cand"; then CLAUDE="$cand"; break; fi
  done
fi
if [ -z "$CLAUDE" ]; then
  echo "  ⏭  NO MEDIDO: ningún claude de esta máquina trae «plugin test» — se saltea CON CONSTANCIA"
  echo "✅ harness-mods-plugin: 0 de 0 (no medido)"
  exit 0
fi
echo "  claude: $CLAUDE ($("$CLAUDE" --version 2>/dev/null | head -1))"

# C-01 · validate: sin rechazos
SAL="$("$CLAUDE" plugin validate "$PLUGIN" 2>&1 < /dev/null)"; RC=$?
if [ "$RC" -eq 0 ]; then ok "C-01 claude plugin validate: sin rechazos"
else mal "C-01 claude plugin validate salió $RC"; printf '%s\n' "$SAL" | sed 's/^/       /' | tail -15; fi

# C-02 · test: las pruebas del motor en verde
SAL="$("$CLAUDE" plugin test "$PLUGIN" 2>&1 < /dev/null)"; RC=$?
if [ "$RC" -eq 0 ]; then ok "C-02 claude plugin test: $(printf '%s\n' "$SAL" | grep -E '^ *[0-9]+ pass' | tr -s ' ')"
else mal "C-02 claude plugin test salió $RC"; printf '%s\n' "$SAL" | sed 's/^/       /' | tail -30; fi

if [ "$FALLOS" -eq 0 ]; then echo "✅ harness-mods-plugin: 2 de 2"; exit 0; fi
echo "❌ harness-mods-plugin: $FALLOS falla(s)"; exit 1
