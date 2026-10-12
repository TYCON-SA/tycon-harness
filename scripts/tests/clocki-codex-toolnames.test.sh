#!/usr/bin/env bash
# clocki-codex-toolnames.test.sh — guard de regresión del fix "tools de Clockify agnósticas".
#
# Caso: incident-log#clockify-tool-names-codex (2026-08-24). Las tools de Clockify tienen guiones
# en el nombre; bajo Codex vienen con guiones bajos (regla D.5). Las skills llegan a Codex por
# symlink sin traducir, y el guard "si la tool no está → saltear" apagaba el tracking EN SILENCIO.
# Este test falla si alguien REINTRODUCE el patrón peligroso: un guard de salteo atado al nombre
# EXACTO con guiones, o la desaparición de la nota agnóstica.
#
# Fail-open: si agent-skills no está en la máquina, skip (exit 0). Corre en la pasada diaria.
set -uo pipefail
AS="${AGENT_SKILLS:-$HOME/.claude/agent-skills}"
SKILL="$AS/skills/clocki/SKILL.md"
STEP="$AS/skills/tycon-pipeline/steps/step-00b-clocki-start.md"
[[ -f "$SKILL" && -f "$STEP" ]] || { echo "⚪ clocki-codex-toolnames: agent-skills no presente, skip"; exit 0; }

fallos=0
ok(){ echo "✅ $1"; }
bad(){ echo "❌ $1 — $2"; fallos=$((fallos+1)); }

# 1. La nota agnóstica existe en clocki/SKILL.md
grep -q "Nombres de las tools de Clockify" "$SKILL" \
  && ok "clocki/SKILL.md tiene la nota de nombres Claude/Codex" \
  || bad "nota ausente" "clocki/SKILL.md perdió 'Nombres de las tools de Clockify' (regresión del fix)"

# 2. La nota menciona los guiones bajos de Codex (la clave del fix)
grep -qiE "guiones bajos|_clockify_" "$SKILL" \
  && ok "la nota menciona la variante Codex (guiones bajos)" \
  || bad "variante Codex ausente" "la nota no menciona guiones bajos / _clockify_"

# 3. El guard de step-00b NO saltea por el nombre EXACTO con guiones sin caveat.
#    Patrón peligroso: 'mcp__clockify__list-clockify-workspaces` no está disponible → saltear'
if grep -qE 'mcp__clockify__list-clockify-workspaces`? no está disponible → saltear' "$STEP"; then
  bad "guard peligroso reintroducido" "step-00b saltea por el nombre exacto con guiones (no-track silencioso en Codex)"
else
  ok "step-00b no saltea por nombre exacto con guiones"
fi

# 4. El guard nuevo menciona ambas variantes / guiones bajos
grep -qiE "guiones bajos|AMBAS variantes|ambas variantes|list_clockify_workspaces" "$STEP" \
  && ok "step-00b chequea ambas variantes de nombre" \
  || bad "caveat ausente en el guard" "step-00b no aclara la variante Codex"

echo; [[ "$fallos" = "0" ]] && { echo "✅ clocki-codex-toolnames: verde"; exit 0; } || { echo "❌ clocki-codex-toolnames: $fallos fallo(s)"; exit 1; }
