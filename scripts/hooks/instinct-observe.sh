#!/usr/bin/env bash
# instinct-observe.sh — PostToolUse hook que graba observaciones sanitizadas
# a un JSONL LOCAL por máquina (~/.claude/tycon-observations/<YYYY-MM>.jsonl).
# Consumido por scripts/instincts/instinct-observer.js (SessionStart con throttle 12h)
# para detectar patrones repetidos y proponer instincts.
#
# IMPORTANTE: las observations NO van al repo git. Setup multi-máquina 50/50 →
# cada máquina tiene su propio JSONL local, su propio observer, y solo los
# pending/approved/drafts (que SÍ van al repo) cruzan entre máquinas.
#
# Diseño:
#   - Fail-open: cualquier excepción exit 0 silencioso
#   - Async-ish: write rápido (<10ms típico)
#   - Sanitization en instinct-observe.py
#   - Opt-in: TYCON_INSTINCT_MINING != "1" → exit 0
#
# Input (stdin): JSON event del hook PostToolUse
# Output: append a ~/.claude/tycon-observations/<YYYY-MM>.jsonl

set -u

# Opt-in
if [[ "${TYCON_INSTINCT_MINING:-0}" != "1" ]]; then
  exit 0
fi

OBS_DIR="${TYCON_INSTINCT_OBS_DIR:-$HOME/.claude/tycon-observations}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/instinct-observe.py"

# Si el .py no está → silent skip
[[ -f "$PY_SCRIPT" ]] || exit 0

# Pipe stdin a python3, fail-open
python3 "$PY_SCRIPT" "$OBS_DIR" 2>/dev/null || true

exit 0
