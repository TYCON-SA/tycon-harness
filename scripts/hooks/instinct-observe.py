#!/usr/bin/env python3
"""
instinct-observe.py — invocado por instinct-observe.sh (PostToolUse hook).

Lee stdin (JSON event del hook), sanitiza, escribe append a JSONL local.

Args:
    sys.argv[1]: OBS_DIR (path local para el JSONL, no en git)

Fail-open: cualquier excepción → exit 0.
"""

import json
import sys
import os
import re
import time
from pathlib import Path
from datetime import datetime


def main():
    try:
        obs_base = sys.argv[1]
    except IndexError:
        sys.exit(0)

    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)

    cwd = payload.get('cwd', '') or os.getcwd()
    home = os.path.expanduser('~')

    # Project = la carpeta de primer nivel bajo la raíz de repos. Este hook corre en CADA tool use, así
    # que no llama a nada: si hay TYCON_REPOS_ROOT, es <raíz>/<proj>; si no, <home>/<carpeta>/<proj>
    # (cualquier carpeta de primer nivel bajo el home, no una escrita a mano — story 8.3); sino basename(cwd).
    raiz = os.path.expanduser(os.environ.get('TYCON_REPOS_ROOT', '')).rstrip('/')
    if raiz:
        m = re.match(r'^' + re.escape(raiz) + r'/([^/]+)', cwd)
    else:
        m = re.match(r'^' + re.escape(home) + r'/[^/.][^/]*/([^/]+)', cwd)
    if m:
        project = m.group(1)
    else:
        project = os.path.basename(cwd) or 'unknown'

    # Path-based exclusion (privacy cliente)
    tool_input_str = json.dumps(payload.get('tool_input', {}))
    if 'specs/clients/' in tool_input_str or '/clients/' in tool_input_str.lower():
        sys.exit(0)

    # Ensure observations dir (LOCAL, no en repo)
    obs_dir = Path(obs_base)
    try:
        obs_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        sys.exit(0)

    # Sanitization helpers
    SECRET_RE = re.compile(
        r'(?i)(api[_-]?key|token|password|passwd|secret|bearer|authorization)["\':\s=]+["\']?[A-Za-z0-9_\-\.\/+]{8,}'
    )
    SK_RE = re.compile(r'\b(sk-[A-Za-z0-9_\-]{16,})')
    GHP_RE = re.compile(r'\b(ghp_[A-Za-z0-9_\-]{16,})')

    def sanitize(s: str) -> str:
        if not s:
            return s
        s = s.replace(home, '$HOME')
        s = SECRET_RE.sub(r'\1=[REDACTED]', s)
        s = SK_RE.sub('[REDACTED-SK]', s)
        s = GHP_RE.sub('[REDACTED-GHP]', s)
        if len(s) > 500:
            s = s[:497] + '...'
        return s

    tool_name = payload.get('tool_name', 'unknown')
    tool_input = payload.get('tool_input', {})
    tool_response = payload.get('tool_response', {})

    # Per-tool input digest
    digest = ''
    if tool_name in ('Read', 'Edit', 'Write'):
        digest = tool_input.get('file_path', '') or ''
    elif tool_name == 'Bash':
        digest = tool_input.get('command', '') or ''
    elif tool_name in ('Grep', 'Glob'):
        digest = tool_input.get('pattern', '') or ''
    elif tool_name in ('Task', 'Agent'):
        digest = tool_input.get('description', '') or ''
    elif tool_name == 'Skill':
        digest = tool_input.get('skill', '') or ''
    else:
        digest = json.dumps(tool_input)[:200]

    # Status heuristic
    status = 'ok'
    if isinstance(tool_response, dict):
        if tool_response.get('is_error') or tool_response.get('error'):
            status = 'error'

    obs = {
        'ts': int(time.time()),
        'session_id': payload.get('session_id', '')[:8],
        'tool': tool_name,
        'project': project,
        'summary': sanitize(digest),
        'status': status,
    }

    try:
        month = datetime.utcnow().strftime('%Y-%m')
        jsonl_path = obs_dir / f'{month}.jsonl'
        with open(jsonl_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(obs, ensure_ascii=False) + '\n')
    except Exception:
        sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(0)
