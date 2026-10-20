#!/usr/bin/env bash
#
# install-codegraph.sh — macOS / Linux
#
# Instala CodeGraph (@colbymchenry/codegraph) y lo registra como MCP server
# en Claude Code para uno o varios proyectos.
#
# CodeGraph indexa el codebase (tree-sitter -> SQLite local) y expone un grafo
# de simbolos / call graph / dependencias via MCP. Reduce tokens y tool calls
# de los agentes vs. escanear archivos con grep.
#
# Uso:
#   bash install-codegraph.sh                      # setup del directorio actual
#   bash install-codegraph.sh /ruta/al/repo        # setup de un repo especifico
#   bash install-codegraph.sh --container /ruta    # contenedor con subproyectos
#   bash install-codegraph.sh --repo /ruta         # forzar modo repo-suelto
#   bash install-codegraph.sh --no-auto            # NO instalar el hook automatico
#   bash install-codegraph.sh --tool-only          # sólo el CLI y el hook, sin indexar ninguna carpeta
#
# Por defecto autodetecta si el target es un repo suelto o un contenedor con
# subproyectos. Idempotente: re-correrlo re-indexa y reinstala limpio.
#
# Ademas instala un hook SessionStart (codegraph-session-hook.sh) que, de aca
# en adelante, auto-configura CodeGraph en cualquier OTRO repo que abras —
# corres este script UNA vez por maquina y listo. --no-auto saltea ese hook
# (modo manual: solo setea el target indicado).
#
# El indice (.codegraph/) y la config MCP son machine-local: NO se commitean.
# Windows: usar install-codegraph.ps1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Version del paquete npm. "latest" o un numero fijo (ej. "0.7.9") para pinear.
CODEGRAPH_VERSION="latest"
PKG="@colbymchenry/codegraph@${CODEGRAPH_VERSION}"

usage() {
  sed -n '/^# Uso:/,/^# Windows:/p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
}

# ---- args ----
MODE="auto"      # auto | repo | container
AUTO_HOOK=1      # instalar el hook SessionStart (0 con --no-auto)
TOOL_ONLY=0      # --tool-only: el CLI y el hook, sin indexar ni registrar ninguna carpeta (lo usa el instalador del arnés)
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --container) MODE="container" ;;
    --repo)      MODE="repo" ;;
    --no-auto)   AUTO_HOOK=0 ;;
    --tool-only) TOOL_ONLY=1 ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "✗ Opcion desconocida: $arg" >&2; usage; exit 1 ;;
    *)           TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$PWD}"
TARGET="$(cd "$TARGET" 2>/dev/null && pwd)" \
  || { echo "✗ No existe el directorio: ${TARGET}" >&2; exit 1; }

echo "→ Instalador de CodeGraph MCP"
echo "  target: $TARGET"
echo

# ---- 1. dependencias ----
command -v node   >/dev/null 2>&1 || { echo "✗ Node.js no esta en PATH (se requiere >= 18)." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "✗ Node $NODE_MAJOR detectado; se requiere >= 18." >&2; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "✗ npm no esta en PATH." >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "✗ El CLI 'claude' no esta en PATH. Instala Claude Code primero." >&2; exit 1; }

# ---- 2. instalar el CLI codegraph (global) ----
echo "→ Instalando $PKG (global)..."
if ! npm install -g "$PKG" >/dev/null 2>&1; then
  echo "✗ Fallo 'npm install -g $PKG'." >&2
  echo "  Si es por permisos, revisa el prefijo de npm: 'npm config get prefix'." >&2
  exit 1
fi
CODEGRAPH_BIN="$(command -v codegraph)" \
  || { echo "✗ codegraph no quedo en PATH tras la instalacion." >&2; exit 1; }
echo "  codegraph $(codegraph --version 2>/dev/null) → $CODEGRAPH_BIN"
echo

# ---- helpers ----
is_project() {
  local d="$1" f
  [ -e "$d/.git" ]            && return 0   # en un worktree, .git es un archivo
  [ -f "$d/package.json" ]    && return 0
  [ -f "$d/go.mod" ]          && return 0
  [ -f "$d/Cargo.toml" ]      && return 0
  [ -f "$d/pom.xml" ]         && return 0
  [ -f "$d/pyproject.toml" ]  && return 0
  # Globs .NET: si no matchean, bash deja el patron literal y [ -e ] da falso.
  for f in "$d"/*.sln "$d"/*.csproj; do [ -e "$f" ] && return 0; done
  return 1
}

# ---- 3. resolver modo + lista de repos ----
REPOS=()
REGDIR="el repo que abras: el hook arma su índice"
if [ "$TOOL_ONLY" -eq 0 ]; then
if [ "$MODE" = "auto" ]; then
  if is_project "$TARGET"; then MODE="repo"; else MODE="container"; fi
  echo "  modo autodetectado: $MODE"
fi

if [ "$MODE" = "repo" ]; then
  is_project "$TARGET" || echo "  ⚠ $TARGET no parece un proyecto; sigo igual (forzado)."
  REPOS=("$TARGET")
else
  for sub in "$TARGET"/*/; do
    sub="${sub%/}"
    name="$(basename "$sub")"
    case "$name" in node_modules|.*) continue ;; esac
    if is_project "$sub"; then REPOS+=("$sub"); fi
  done
  [ "${#REPOS[@]}" -gt 0 ] \
    || { echo "✗ No se encontraron subproyectos en $TARGET." >&2; exit 1; }
  echo "  subproyectos detectados: $(for r in "${REPOS[@]}"; do basename "$r"; done | tr '\n' ' ')"
fi
echo

# ---- 4. indexar cada repo + gitignore ----
for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"
  if [ -d "$repo/.codegraph" ]; then
    echo "→ [$name] re-indexando (.codegraph/ ya existe)..."
    ( cd "$repo" && codegraph index >/dev/null 2>&1 ) \
      || { echo "✗ Fallo el index de $name." >&2; exit 1; }
  else
    echo "→ [$name] init + index inicial..."
    ( cd "$repo" && codegraph init -i >/dev/null 2>&1 ) \
      || { echo "✗ Fallo el init de $name." >&2; exit 1; }
  fi
  # el índice es de esta máquina: al exclude local de git, nunca al .gitignore del equipo; fuera de un repo, nada
  ex="$(git -C "$repo" rev-parse --git-path info/exclude 2>/dev/null)" || ex=""
  if [ -z "$ex" ]; then
    echo "  ⚠ $name no es un repo de git: no anoté .codegraph/ en ningún lado"
  else
    case "$ex" in /*) ;; *) ex="$repo/$ex" ;; esac
    mkdir -p "$(dirname "$ex")"
    if ! grep -qxF ".codegraph/" "$ex" 2>/dev/null; then
      printf '.codegraph/\n' >> "$ex"
      echo "  + .codegraph/ anotado en el exclude local de git de $name (no se sube)"
    fi
  fi
  if [ -f "$repo/CLAUDE.md" ] && ! grep -q "CodeGraph" "$repo/CLAUDE.md"; then
    echo "  ⚠ $name/CLAUDE.md NO tiene la seccion CodeGraph. Sin ella los agentes"
    echo "    no usan codegraph por defecto. Copia el bloque de la guia codegraph-mcp.md."
  fi
done
echo

# ---- 5. registrar MCP server(s) en Claude Code ----
# 'claude mcp add' usa scope 'local' por defecto (per-proyecto, machine-only,
# guardado en ~/.claude.json). NO se pasa --scope: algunos builds del CLI lo
# rechazan, y 'local' ya es lo que queremos.
# Se usa 'serve --path' (forma larga): el '-p' corto colisiona con el flag
# global '-p/--print' del CLI 'claude' y rompe el parseo del subcomando.
echo "→ Registrando MCP server(s) en Claude Code (scope local = solo esta maquina)..."
if [ "$MODE" = "repo" ]; then
  repo="${REPOS[0]}"
  ( cd "$repo"
    claude mcp remove codegraph >/dev/null 2>&1 || true
    claude mcp add codegraph -- "$CODEGRAPH_BIN" serve --mcp --path "$repo" >/dev/null )
  echo "  + 'codegraph' → $repo"
  REGDIR="$repo"
else
  ( cd "$TARGET"
    for repo in "${REPOS[@]}"; do
      name="$(basename "$repo")"
      sname="codegraph-$(echo "$name" | tr '[:upper:]' '[:lower:]')"
      claude mcp remove "$sname" >/dev/null 2>&1 || true
      claude mcp add "$sname" -- "$CODEGRAPH_BIN" serve --mcp --path "$repo" >/dev/null
      echo "  + '$sname' → $repo"
    done )
  REGDIR="$TARGET"
fi

# Marca de "seteado por esta tooling" -> el hook SessionStart sale por fast path.
for repo in "${REPOS[@]}"; do
  [ -d "$repo/.codegraph" ] && touch "$repo/.codegraph/.tycon-setup-done" 2>/dev/null || true
done
echo
fi   # --tool-only: sin repos que indexar ni registrar

# ---- 6. instalar el hook SessionStart (auto-setup de futuros repos) ----
if [ "$AUTO_HOOK" -eq 1 ]; then
  # bajo set -e, un cd que falla dentro de la asignación mataría el script mudo: sin scripts/hooks/, cae al aviso de abajo
  HOOK_SCRIPT="$(cd "$SCRIPT_DIR/../hooks" 2>/dev/null && pwd)/codegraph-session-hook.sh" || HOOK_SCRIPT=""
  SETTINGS="$HOME/.claude/settings.json"
  if [ ! -f "$HOOK_SCRIPT" ]; then
    echo "⚠ No encuentro scripts/hooks/codegraph-session-hook.sh; omito el hook." >&2
  else
    mkdir -p "$HOME/.claude"
    [ -f "$SETTINGS" ] && cp "$SETTINGS" "${SETTINGS}.bak-codegraph"
    HOOK_RESULT="$(
      python3 - "$SETTINGS" "bash \"$HOOK_SCRIPT\"" <<'PY' 2>/dev/null || echo "ERROR"
import json, sys
path, cmd = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
except Exception:
    print("MALFORMED"); sys.exit(0)
if not isinstance(data, dict):
    print("MALFORMED"); sys.exit(0)
hooks = data.setdefault("hooks", {})
ss = hooks.setdefault("SessionStart", [])
if not isinstance(ss, list):
    print("MALFORMED"); sys.exit(0)
for group in ss:
    if not isinstance(group, dict):
        continue
    for h in group.get("hooks", []):
        if isinstance(h, dict) and "codegraph-session-hook" in str(h.get("command", "")):
            print("ALREADY"); sys.exit(0)
ss.append({"hooks": [{"type": "command", "command": cmd, "async": True}]})
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("ADDED")
PY
    )"
    case "$HOOK_RESULT" in
      ADDED)   echo "→ Hook SessionStart instalado en $SETTINGS" ;;
      ALREADY) echo "→ Hook SessionStart ya estaba instalado (ok)" ;;
      *)       echo "⚠ No pude editar $SETTINGS (malformado o sin python3)." >&2
               echo "  Agregalo a mano — ver guia codegraph-mcp.md, seccion 'Modo automatico'." >&2 ;;
    esac
  fi
  echo
else
  # --no-auto saca el gancho de arranque si estaba; el resto de settings.json queda igual
  SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS" ]; then
    HOOK_RESULT="$(
      python3 - "$SETTINGS" <<'PY' 2>/dev/null || echo "ERROR"
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    print("MALFORMED"); sys.exit(0)
ss = data.get("hooks", {}).get("SessionStart") if isinstance(data, dict) and isinstance(data.get("hooks"), dict) else None
if not isinstance(ss, list):
    print("ABSENT"); sys.exit(0)
ours = lambda h: isinstance(h, dict) and "codegraph-session-hook" in str(h.get("command", ""))
kept = []
for group in ss:
    if isinstance(group, dict) and isinstance(group.get("hooks"), list) and any(ours(h) for h in group["hooks"]):
        rest = [h for h in group["hooks"] if not ours(h)]
        if rest:
            kept.append({**group, "hooks": rest})
    else:
        kept.append(group)
if len(kept) == len(ss) and kept == ss:
    print("ABSENT"); sys.exit(0)
data["hooks"]["SessionStart"] = kept
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("REMOVED")
PY
    )"
    case "$HOOK_RESULT" in
      REMOVED) echo "→ saqué el modo automático (el gancho de arranque de CodeGraph) de $SETTINGS" ;;
      ABSENT)  ;;
      *)       echo "⚠ No pude editar $SETTINGS para sacar el modo automático (malformado o sin python3)." >&2 ;;
    esac
  fi
fi

echo "✓ CodeGraph instalado."
echo
echo "Para usarlo: reiniciá Claude Code en el repo ($REGDIR) y, cuando lo pida, aprobá el servidor 'codegraph'."
echo "Se verifica con /mcp dentro de Claude Code (tiene que figurar 'connected')."
if [ "$AUTO_HOOK" -eq 1 ]; then
  echo
  echo "Modo automático prendido: al abrir una sesión en un repo, lo indexa y lo registra en esta máquina (el índice queda"
  echo "en .codegraph/, anotado en el exclude local de git); no corre en cada mensaje ni deja archivos para subir."
  echo "Para sacarlo: bash $SCRIPT_DIR/install-codegraph.sh --tool-only --no-auto"
  echo "Los contenedores con subproyectos (--container) no los maneja: para esos, este script una vez."
else
  echo
  echo "Modo manual (--no-auto): solo se configuró el target. Para otros repos,"
  echo "volvé a correr este script apuntando a cada uno."
fi
