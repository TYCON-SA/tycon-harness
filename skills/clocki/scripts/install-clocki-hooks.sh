#!/usr/bin/env bash
#
# install-clocki-hooks.sh — macOS / Linux
#
# Instala los hooks de clocki en ~/.claude/settings.json sin pisar otros hooks existentes.
# Idempotente: si los hooks ya están, no los duplica.
#
# Uso:
#   bash ~/.claude/agent-skills/skills/clocki/scripts/install-clocki-hooks.sh
#
# Windows users: usar install-clocki-hooks.ps1 (PowerShell).

set -euo pipefail

CLOCKI_DIR="${HOME}/.claude/agent-skills/skills/clocki/scripts"
STATE_DIR="${HOME}/.claude/clocki"
SETTINGS="${HOME}/.claude/settings.json"

echo "→ Instalador de hooks clocki (macOS/Linux)"
echo

# 1. Dependencias
if ! command -v node >/dev/null 2>&1; then
  echo "✗ ERROR: 'node' no está en PATH. Instalá Node.js (>= 16)." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ ERROR: 'python3' no está en PATH. Es necesario para parchear settings.json." >&2
  exit 1
fi

# 2. Verificar scripts presentes
for f in lib.js sweep.js on-prompt.js touch-activity.js clocki-enforce.js; do
  if [ ! -f "${CLOCKI_DIR}/${f}" ]; then
    echo "✗ ERROR: falta ${CLOCKI_DIR}/${f}. ¿Está clonado el repo AgentSkills?" >&2
    exit 1
  fi
done

# 3. Crear state dir con defaults
mkdir -p "${STATE_DIR}"
if [ ! -f "${STATE_DIR}/active.json" ]; then
  echo "{}" > "${STATE_DIR}/active.json"
fi
if [ ! -f "${STATE_DIR}/project-cache.json" ]; then
  echo "{}" > "${STATE_DIR}/project-cache.json"
fi
if [ ! -f "${STATE_DIR}/settings.json" ]; then
  # Nota: NO sembrar intentKeywords/stopKeywords vacios. readSettings() (lib.js) usa
  # la lista narrow/precision-first de DEFAULT_SETTINGS cuando el field falta o esta vacio.
  # Sembrar `[]` aca degradaria a una lista ANCHA y dispararia falsos positivos sobre
  # charla/meta-discusion. El dev puede agregar estos campos para OVERRIDE.
  cat > "${STATE_DIR}/settings.json" <<'EOF'
{
  "idleTimeoutMinutes": 15,
  "defaultWorkspaceId": null
}
EOF
fi
echo "✓ State dir listo: ${STATE_DIR}"

# 4. Verificar settings.json
if [ ! -f "${SETTINGS}" ]; then
  echo "{}" > "${SETTINGS}"
fi

# 5. Patchear settings.json con los hooks usando Python (cross-platform JSON merge seguro)
# Pasamos los comandos via env vars para evitar dependencia de bash 4.4+ (macOS ships bash 3.2).
export CLOCKI_SWEEP_CMD="node \"${CLOCKI_DIR}/sweep.js\""
export CLOCKI_PROMPT_CMD="node \"${CLOCKI_DIR}/on-prompt.js\""
export CLOCKI_TOUCH_CMD="node \"${CLOCKI_DIR}/touch-activity.js\""
export CLOCKI_ENFORCE_CMD="node \"${CLOCKI_DIR}/clocki-enforce.js\""
export CLOCKI_SETTINGS_PATH="${SETTINGS}"

python3 <<'PYEOF'
import json, os, sys

settings_path = os.environ["CLOCKI_SETTINGS_PATH"]
sweep_cmd = os.environ["CLOCKI_SWEEP_CMD"]
prompt_cmd = os.environ["CLOCKI_PROMPT_CMD"]
touch_cmd = os.environ["CLOCKI_TOUCH_CMD"]
enforce_cmd = os.environ["CLOCKI_ENFORCE_CMD"]

with open(settings_path, "r", encoding="utf-8") as f:
    try:
        s = json.load(f)
    except Exception:
        s = {}

hooks = s.setdefault("hooks", {})

def has_clocki_hook(hook_list, target_cmd):
    if not isinstance(hook_list, list): return False
    for entry in hook_list:
        if not isinstance(entry, dict): continue
        for h in entry.get("hooks", []):
            if not isinstance(h, dict): continue
            c = h.get("command", "")
            if c.strip() == target_cmd.strip(): return True
            # Detección amplia: cualquier comando que mencione la ruta de clocki scripts
            if "clocki" in c and target_cmd.split('"')[1] in c if '"' in target_cmd else False:
                return True
            # Fallback: match por basename del script
            target_script = target_cmd.split("/")[-1].rstrip('"')
            if target_script and target_script in c:
                return True
    return False

def add_hook(event_name, command, matcher=None, async_flag=False):
    arr = hooks.setdefault(event_name, [])
    if has_clocki_hook(arr, command):
        return False
    inner = {"type": "command", "command": command}
    if async_flag:
        inner["async"] = True
    entry = {"hooks": [inner]}
    if matcher:
        entry["matcher"] = matcher
    arr.append(entry)
    return True

added = []
if add_hook("SessionStart", sweep_cmd):
    added.append("SessionStart -> sweep.js")
if add_hook("UserPromptSubmit", prompt_cmd):
    added.append("UserPromptSubmit -> on-prompt.js")
if add_hook("PostToolUse", touch_cmd, async_flag=True):
    added.append("PostToolUse -> touch-activity.js (async, todos los tools)")
# enforce DEBE ser sync (sin async): emite system-reminder en stdout, y async hooks
# tienen stdout discarded — el reminder nunca llega al contexto del modelo.
if add_hook("PostToolUse", enforce_cmd, matcher="Edit|Write", async_flag=False):
    added.append("PostToolUse(Edit|Write) -> clocki-enforce.js (sync, forza timer activo)")

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(s, f, indent=2)

if added:
    print("Hooks agregados:")
    for a in added:
        print("  - " + a)
else:
    print("Hooks ya estaban instalados (idempotente, no se duplico nada).")
PYEOF

echo
echo "✓ Hooks clocki instalados en ${SETTINGS}"
echo
echo "Próximo paso:"
echo "  1. Verificá que Clockify MCP esté instalado: claude mcp list | grep clockify"
echo "     (Si no está, corré: bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh)"
echo "  2. Reiniciá tu sesión de Claude Code."
echo "  3. Probá: en cualquier proyecto, decile a Claude 'fixeemos el bug X'. Debería proponerte abrir timer."
echo
