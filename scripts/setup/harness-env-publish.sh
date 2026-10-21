#!/usr/bin/env bash
# harness-env-publish.sh — publica para las apps GRÁFICAS de macOS las variables de entorno
# que el lado Codex necesita (la llave TYCON_CODEX y los secretos de los servidores MCP).
#
# Por qué existe: los secretos de los MCP bajo Codex se leen del AMBIENTE (el
# deployer jamás los copia a archivos), y el ambiente de las apps gráficas (el panel de Codex
# en VSCode) NO pasa por ~/.zshrc — el tracking de Clockify falla ahí con la key ya
# exportada en el rc. `launchctl setenv` publica en memoria y muere con el reinicio, así que
# este script lo invoca un LaunchAgent en cada login (lo instala install-tycon-hooks.sh).
#
# Los valores se LEEN de ~/.claude.json (mcpServers.*.env) — la fuente donde ya viven — y no
# se escriben a ningún archivo nuevo ni se imprimen. Solo macOS; en Windows las variables de
# usuario viven en el registro y son permanentes (lo cubre el setup de F3).
set -u
[[ "$(uname)" == "Darwin" ]] || exit 0
# LAUNCHCTL_BIN: override PARA EL BANCO DE PRUEBAS. `launchctl setenv` escribe estado
# REAL de la máquina — un caso del banco que lo llame de verdad ensucia el ambiente del dev para
# probar que el script funciona. Con el override, el caso le pasa un launchctl falso que anota lo
# que le pidieron y no toca nada. En producción no cambia nada: default = launchctl de siempre.
LAUNCHCTL="${LAUNCHCTL_BIN:-launchctl}"
command -v "$LAUNCHCTL" >/dev/null 2>&1 || exit 0

"$LAUNCHCTL" setenv TYCON_CODEX 1 2>/dev/null || true

# Flags OPT-IN del arnés que gatean hooks por env var (no son secretos, sólo "prendido/apagado").
# Sin esto, un hook opt-in anda en Codex-TERMINAL (hereda ~/.zshrc) pero NO en Codex-VSCODE (el
# panel gráfico no pasa por el rc). Ejemplo: el observador de instintos —agnóstico de herramienta—
# quedaría mudo en el panel de Codex aunque el dev tenga TYCON_INSTINCT_MINING=1 en su rc.
# Se publican desde el AMBIENTE ACTUAL (no de un archivo): el instalador corre este script con el
# env del shell ya cargado, y corre en cada SessionStart, así que se re-publican solas. El
# LaunchAgent del login no las tiene (no ve el rc) — no importa: la próxima sesión las repone.
for f in TYCON_INSTINCT_MINING TYCON_INSTINCT_OBSERVER TYCON_OBSERVER_EXECUTOR; do
  v="${!f:-}"
  [[ -n "$v" ]] && "$LAUNCHCTL" setenv "$f" "$v" 2>/dev/null || true
done

CLAUDE_JSON="$HOME/.claude.json"
[[ -f "$CLAUDE_JSON" ]] || exit 0
# pares KEY<TAB>VALUE de todos los env de servidores MCP registrados
python3 - "$CLAUDE_JSON" <<'PY' 2>/dev/null | while IFS=$'\t' read -r k v; do
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for srv in (d.get("mcpServers") or {}).values():
        for k, v in (srv.get("env") or {}).items():
            if k and v and "\t" not in k and "\n" not in str(v):
                print(f"{k}\t{v}")
except Exception:
    pass
PY
  [[ -n "$k" && -n "$v" ]] && "$LAUNCHCTL" setenv "$k" "$v" 2>/dev/null || true
done
exit 0
