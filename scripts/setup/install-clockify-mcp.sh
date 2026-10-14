#!/usr/bin/env bash
#
# install-clockify-mcp.sh — macOS / Linux
#
# Instala el MCP server de Clockify (aslamanver/mcp_clockify) en Claude Code
# a nivel user-scope (todos los proyectos de la máquina lo usan).
#
# Uso:
#   bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh
#
# Windows users: usar install-clockify-mcp.ps1 (PowerShell).
#
# Idempotente: si ya está instalado, lo remueve y reinstala con la key nueva.
# La API key NO se commitea a ningún repo — vive solo en ~/.claude.json local.

set -euo pipefail

SERVER_NAME="clockify"
PACKAGE="mcp_clockify@latest"

echo "→ Instalador de Clockify MCP server (user-scope)"
echo

# 1. Verificar dependencias
if ! command -v claude >/dev/null 2>&1; then
  echo "✗ ERROR: el CLI 'claude' no está en PATH. Instalá Claude Code primero." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "✗ ERROR: 'npx' no está en PATH. Instalá Node.js (>= 16)." >&2
  exit 1
fi

# 2. Pedir API key (no se muestra en pantalla, no queda en history)
echo "Necesito tu Clockify API key personal."
echo "  Sacala de: Clockify → Profile Settings (esquina sup. der.) → API → Generate"
echo
read -rsp "API key: " API_KEY
echo
echo

if [ -z "${API_KEY:-}" ]; then
  echo "✗ ERROR: la API key está vacía. Cancelando." >&2
  exit 1
fi

# 3. Si ya existe el server, removerlo (idempotencia)
if claude mcp list 2>/dev/null | grep "^${SERVER_NAME}:" >/dev/null; then
  echo "→ '${SERVER_NAME}' ya estaba instalado; lo remuevo para reinstalar limpio."
  claude mcp remove --scope user "${SERVER_NAME}" >/dev/null 2>&1 || true
fi

# 4. Instalar
# NOTA: --env=KEY=VALUE (con `=`) es obligatorio. -e es variadic y se traga
# el nombre del server si se usa con espacio.
echo "→ Instalando '${SERVER_NAME}' (user-scope)..."
claude mcp add \
  --scope user \
  --env="CLOCKIFY_API_KEY=${API_KEY}" \
  "${SERVER_NAME}" \
  -- npx -y "${PACKAGE}"

# 5. Verificar conexión
echo
echo "→ Verificando conexión..."
sleep 1
if claude mcp list 2>&1 | grep "^${SERVER_NAME}:.*✓ Connected" >/dev/null; then
  echo "✓ '${SERVER_NAME}' instalado y conectado correctamente."
  echo
  echo "Próximo paso: reiniciá tu sesión de Claude Code para ver los tools nuevos."
  echo "Tools disponibles: list workspaces/projects/tasks, time entries, summary reports."
else
  echo "⚠ '${SERVER_NAME}' instalado pero no aparece como ✓ Connected." >&2
  echo "  Corré 'claude mcp list' manualmente y revisá si hay errores." >&2
  exit 1
fi
