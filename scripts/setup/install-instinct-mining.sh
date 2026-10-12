#!/usr/bin/env bash
# install-instinct-mining.sh — instala los hooks de instinct-mining
# en ~/.claude/settings.json del dev. Idempotente.
#
# Hooks que registra:
#   PostToolUse (matcher-less): scripts/hooks/instinct-observe.sh
#     → graba toda tool call al JSONL (si TYCON_INSTINCT_MINING=1)
#
#   SessionStart (matcher-less): scripts/hooks/instinct-trigger.sh
#     → dispara observer si pasaron >12h (si TYCON_INSTINCT_OBSERVER=1)
#
# Activación: ambos hooks chequean env vars al ejecutarse. La instalación
# solo registra los hooks en settings.json — el dev controla activación
# via env vars en ~/.zshrc.
#
# Uso:
#   ./install-instinct-mining.sh         # corre install
#   ./install-instinct-mining.sh --check # solo reporta qué falta
#   ./install-instinct-mining.sh --uninstall # remueve hooks
#
# Variables que el dev tiene que setear en ~/.zshrc para ACTIVAR:
#   export TYCON_INSTINCT_MINING=1      # activa el hook PostToolUse (graba JSONL)
#   export TYCON_INSTINCT_OBSERVER=1    # activa el observer (Haiku via claude CLI)
#                                       # En setup 50/50 multi-máquina: activar en todas
#
# Opcional:
#   export TYCON_INSTINCT_THROTTLE_SECONDS=43200   # default 12h
#   export TYCON_INSTINCT_NOTIFY=1                 # Telegram notify on
#   export TYCON_INSTINCT_TELEGRAM_BOT_TOKEN=...   # bot token
#   export TYCON_INSTINCT_TELEGRAM_CHAT_ID=...     # chat_id (sin default: si no está, sale de ~/.claude/tycon.json → telegram.chat_id o del plugin de Telegram)
#   export TYCON_OBSERVER_MODEL=claude-haiku-4-5   # model override

set -euo pipefail

# ============================================================
# Args
# ============================================================
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --check) ACTION="check" ;;
    --uninstall) ACTION="uninstall" ;;
    -h|--help)
      sed -n '1,35p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "install-instinct-mining: arg desconocido: $arg" >&2; exit 2 ;;
  esac
done

# ============================================================
# Paths
# ============================================================
SETTINGS="${TYCON_SETTINGS_PATH:-$HOME/.claude/settings.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/../hooks" 2>/dev/null && pwd)" || { echo "ERROR: install-instinct-mining: no encuentro scripts/hooks/ (relativo a $SCRIPT_DIR)" >&2; exit 1; }
OBSERVE_HOOK="$HOOKS_DIR/instinct-observe.sh"
TRIGGER_HOOK="$HOOKS_DIR/instinct-trigger.sh"
CMD_SRC="$SCRIPT_DIR/../../commands/tycon-instincts.md"
CMD_DST="$HOME/.claude/commands/tycon-instincts.md"

# Verificar que los scripts existen
[[ -x "$OBSERVE_HOOK" ]] || { echo "ERROR: $OBSERVE_HOOK no existe o no es ejecutable" >&2; exit 1; }
[[ -x "$TRIGGER_HOOK" ]] || { echo "ERROR: $TRIGGER_HOOK no existe o no es ejecutable" >&2; exit 1; }
[[ -f "$CMD_SRC" ]] || { echo "ERROR: $CMD_SRC no existe" >&2; exit 1; }

# Si settings.json no existe, crear esqueleto
if [[ ! -f "$SETTINGS" ]]; then
  mkdir -p "$HOME/.claude"
  cat > "$SETTINGS" <<'JSON'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {}
}
JSON
fi

# ============================================================
# Python helper para manipular settings.json
# ============================================================
python3 - "$ACTION" "$SETTINGS" "$OBSERVE_HOOK" "$TRIGGER_HOOK" <<'PYEOF'
import json
import sys
import shutil
import os
from datetime import datetime

action, settings_path, observe_hook, trigger_hook = sys.argv[1:5]

with open(settings_path, 'r', encoding='utf-8') as f:
    settings = json.load(f)

settings.setdefault('hooks', {})
hooks = settings['hooks']

# Helpers
def has_hook_command(event_name, command_path):
    entries = hooks.get(event_name, [])
    for entry in entries:
        for h in entry.get('hooks', []):
            if h.get('type') == 'command' and command_path in h.get('command', ''):
                return True
    return False

def add_hook(event_name, command_path):
    if has_hook_command(event_name, command_path):
        return False  # ya estaba
    hooks.setdefault(event_name, [])
    hooks[event_name].append({
        'hooks': [{
            'type': 'command',
            'command': command_path,
        }]
    })
    return True

def remove_hook(event_name, command_path):
    entries = hooks.get(event_name, [])
    new_entries = []
    removed = False
    for entry in entries:
        new_hooks = [h for h in entry.get('hooks', [])
                     if not (h.get('type') == 'command' and command_path in h.get('command', ''))]
        if new_hooks:
            entry['hooks'] = new_hooks
            new_entries.append(entry)
        elif entry.get('hooks'):
            removed = True
        else:
            new_entries.append(entry)
    if new_entries:
        hooks[event_name] = new_entries
    elif event_name in hooks:
        del hooks[event_name]
    return removed

# ============================================================
# Action
# ============================================================
changed = False

if action == 'check':
    obs_present = has_hook_command('PostToolUse', observe_hook)
    trg_present = has_hook_command('SessionStart', trigger_hook)
    print(f'PostToolUse instinct-observe.sh:   {"OK" if obs_present else "MISSING"}')
    print(f'SessionStart instinct-trigger.sh:  {"OK" if trg_present else "MISSING"}')
    sys.exit(0)

elif action == 'install':
    added_obs = add_hook('PostToolUse', observe_hook)
    added_trg = add_hook('SessionStart', trigger_hook)
    changed = added_obs or added_trg
    if added_obs:
        print(f'+ PostToolUse: {observe_hook}')
    if added_trg:
        print(f'+ SessionStart: {trigger_hook}')
    if not changed:
        print('Hooks ya instalados, nada que hacer.')

elif action == 'uninstall':
    removed_obs = remove_hook('PostToolUse', observe_hook)
    removed_trg = remove_hook('SessionStart', trigger_hook)
    changed = removed_obs or removed_trg
    if removed_obs:
        print(f'- PostToolUse: {observe_hook}')
    if removed_trg:
        print(f'- SessionStart: {trigger_hook}')
    if not changed:
        print('Hooks no estaban instalados, nada que hacer.')

# ============================================================
# Write back (backup + atomic)
# ============================================================
if changed:
    backup = f'{settings_path}.bak.{datetime.now().strftime("%Y%m%dT%H%M%S")}'
    shutil.copy2(settings_path, backup)
    tmp = settings_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, settings_path)
    print(f'  (backup: {backup})')
PYEOF

# ============================================================
# Slash command: ~/.claude/commands/tycon-instincts.md
# (symlink al archivo versionado en el repo → cruza máquinas vía git pull)
# ============================================================
case "$ACTION" in
  check)
    if [[ -e "$CMD_DST" ]]; then echo "Slash command tycon-instincts:       OK"; else echo "Slash command tycon-instincts:       MISSING"; fi
    ;;
  install)
    mkdir -p "$HOME/.claude/commands"
    if [[ "$(readlink "$CMD_DST" 2>/dev/null)" == "$CMD_SRC" ]]; then
      echo "Slash command ya enlazado, nada que hacer."
    else
      ln -sf "$CMD_SRC" "$CMD_DST"
      echo "+ Slash command: $CMD_DST -> $CMD_SRC"
    fi
    ;;
  uninstall)
    if [[ -L "$CMD_DST" ]]; then
      rm -f "$CMD_DST"
      echo "- Slash command: $CMD_DST"
    fi
    ;;
esac

# ============================================================
# Tail: recordatorio de env vars para activar
# ============================================================
if [[ "$ACTION" == "install" ]]; then
  cat <<'TAIL'

────────────────────────────────────────────────────────────
ACCIÓN REQUERIDA: agregá a ~/.zshrc para ACTIVAR:

  export TYCON_INSTINCT_MINING=1     # graba observations
  export TYCON_INSTINCT_OBSERVER=1   # corre observer (50/50: activar en ambas)

Y opcional:
  export TYCON_INSTINCT_NOTIFY=1
  export TYCON_INSTINCT_TELEGRAM_BOT_TOKEN=<tu_token>

Después: source ~/.zshrc + reabrir Claude Code.

Para verificar:
  ./install-instinct-mining.sh --check

Para desinstalar:
  ./install-instinct-mining.sh --uninstall
────────────────────────────────────────────────────────────
TAIL
fi
