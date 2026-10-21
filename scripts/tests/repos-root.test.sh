#!/usr/bin/env bash
# repos-root.test.sh — ¿dónde cree el arnés que están los repos de esta persona?
#
# Deducir "la carpeta padre del arnés" falla en una máquina con el arnés en ~/SourceCode y los proyectos en otra
# carpeta: elige una carpeta con UN repo, y las auditorías leen "cero repos" como "todo bien". Por eso el resolvedor
# deduce de las sesiones de la persona, el vecino sólo cuenta si tiene vecinos, y el default se dice como default. Y es UNA variable
# (TYCON_REPOS_ROOT), la misma que leen los revisores que buscan plugins hermanos. Detalle: scripts/lib/repos-root.js.
#
# 🔴 Sin pipes sobre el comando: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
J="$TCG/scripts/lib/repos-root.js"
node "$J" --selftest || exit 1
out="$(node "$J")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "raíz de repos: .* · fuente: " || { echo "❌ la CLI tiene que decir la raíz Y de dónde salió (rc=$rc, out='$out')"; exit 1; }
echo "✅ repos-root: selftest + CLI"
