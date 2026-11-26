#!/usr/bin/env bash
# install-instinct-mining.sh — ya no hace falta: la grabadora de instintos la registra el instalador del arnés cuando el
# perfil del equipo prende `integrations.instincts` (guides/integrations/instinct-mining.md). Queda para sacar lo que este
# guion registraba antes en ~/.claude/settings.json: los ganchos `scripts/hooks/instinct-observe.sh` (PostToolUse) y
# `scripts/hooks/instinct-trigger.sh` (SessionStart) y el enlace del comando `tycon-instincts`.
#
# Uso:
#   ./install-instinct-mining.sh              # dice que ya no hace falta y sale 0, sin tocar nada
#   ./install-instinct-mining.sh --check      # dice si quedan los ganchos viejos
#   ./install-instinct-mining.sh --uninstall  # saca los ganchos viejos (aunque los haya registrado otro clon)
#
# Sólo Mac y Linux: en Windows el instalador viejo nunca corrió.

set -euo pipefail

ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --check) ACTION="check" ;;
    --uninstall) ACTION="uninstall" ;;
    -h|--help)
      sed -n '2,13p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "install-instinct-mining: arg desconocido: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$ACTION" == "install" ]]; then
  echo "install-instinct-mining: ya no hace falta. La grabadora de instintos la registra el instalador del arnés cuando el perfil del equipo prende integrations.instincts (guides/integrations/instinct-mining.md)."
  echo "Para sacar los ganchos que este guion registraba antes: ./install-instinct-mining.sh --uninstall"
  exit 0
fi

SETTINGS="${TYCON_SETTINGS_PATH:-$HOME/.claude/settings.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# sin scripts/hooks/ al lado, este guion no está en un clon del arnés: lo dice en vez de seguir
HOOKS_DIR="$(cd "$SCRIPT_DIR/../hooks" 2>/dev/null && pwd)" || { echo "ERROR: install-instinct-mining: no encuentro scripts/hooks/ (relativo a $SCRIPT_DIR)" >&2; exit 1; }
CMD_DST="$HOME/.claude/commands/tycon-instincts.md"

if [[ ! -f "$SETTINGS" ]]; then
  echo "No hay $SETTINGS: no quedó nada viejo que sacar."
  exit 0
fi

# ============================================================
# Python helper para manipular settings.json
# ============================================================
python3 - "$ACTION" "$SETTINGS" "scripts/hooks/instinct-observe.sh" "scripts/hooks/instinct-trigger.sh" <<'PYEOF'
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

if [[ "$ACTION" == "check" ]]; then
  if [[ -L "$CMD_DST" ]]; then echo "Enlace viejo del comando tycon-instincts: QUEDA"; else echo "Enlace viejo del comando tycon-instincts: no está"; fi
elif [[ -L "$CMD_DST" ]]; then
  rm -f "$CMD_DST"
  echo "- Enlace viejo del comando: $CMD_DST"
fi
