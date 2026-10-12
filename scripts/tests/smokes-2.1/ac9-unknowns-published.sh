#!/usr/bin/env bash
# AC 9 · los estados fuera del diccionario se PUBLICAN, no se descartan.
# El criterio describe una acción (publicar), así que el smoke la EJECUTA: corre el medidor con
# `--snapshot`, que ESCRIBE el archivo del día, y después verifica los estados desconocidos
# leyendo el archivo ESCRITO — no la salida por pantalla. Por eso se registra con `--mutates`.
set -uo pipefail
MEDIDOR="$1"; REPO_REAL="$2"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

node "$MEDIDOR" --repo "$REPO_REAL" --dashboard "$T" --snapshot >/dev/null 2>&1 || exit 1
ARCHIVO="$(ls "$T"/sdlc-stage-*.json 2>/dev/null | head -1)"
[ -n "$ARCHIVO" ] || { echo "🛑 el --snapshot no escribió ningún archivo"; exit 1; }

python3 - "$ARCHIVO" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
r = d['repos'][0]
des = r['estados_desconocidos']
assert des is not None, 'estados_desconocidos no puede ser null en un repo medido'
assert des, 'el repo real tiene estados fuera del diccionario y el archivo no los trae'
assert d['global']['estados_desconocidos'], 'el resumen global tampoco los trae'
# y los desconocidos aparecen además como etapa marcada, no disfrazados de canónico
etapas = [k for k in (r['tiempo_por_etapa'] or {}) if k.startswith('desconocido:')]
print('publicados en el archivo escrito: '
      + ', '.join(f'{k} ({v})' for k, v in des.items())
      + f' · como etapa marcada: {len(etapas)}')
PY
