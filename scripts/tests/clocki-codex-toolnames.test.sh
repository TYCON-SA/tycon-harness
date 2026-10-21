#!/usr/bin/env bash
# clocki-codex-toolnames.test.sh — guard de regresión del fix "tools de Clockify agnósticas".
#
# Por qué: las tools de Clockify tienen guiones
# en el nombre; bajo Codex vienen con guiones bajos. Las skills llegan a Codex por
# symlink sin traducir, y el guard "si la tool no está → saltear" apagaría el tracking EN SILENCIO.
# Este test falla si alguien REINTRODUCE el patrón peligroso: un guard de salteo atado al nombre
# EXACTO con guiones, o la desaparición de la nota agnóstica.
#
# El guard vive en la skill de la integración (§«Arranque desde el pipeline»): el paso 0b del pipeline no nombra
# ninguna herramienta, y el caso 5 lo vigila.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL="$RAIZ/integrations/clockify/skills/clocki/SKILL.md"
STEP="$RAIZ/skills/tycon-pipeline/steps/step-00b-work-start.md"
[[ -f "$SKILL" ]] || { echo "❌ clocki-codex-toolnames: falta $SKILL (la skill de la integración de Clockify)"; exit 1; }
[[ -f "$STEP" ]] || { echo "❌ clocki-codex-toolnames: falta $STEP (el paso 0b del pipeline)"; exit 1; }

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

# el guard del arranque desde el pipeline: desde su título hasta el próximo de su nivel
GUARD="$(awk '/^### Arranque desde el pipeline/{on=1;print;next} on&&/^##/{exit} on' "$SKILL")"
[[ -n "$GUARD" ]] || bad "sección ausente" "clocki/SKILL.md perdió «Arranque desde el pipeline»"

# 3. El guard NO saltea por el nombre EXACTO con guiones sin caveat.
#    Patrón peligroso: 'mcp__clockify__list-clockify-workspaces` no está disponible → saltear'
if grep -qE 'mcp__clockify__list-clockify-workspaces`? no está disponible → saltear' <<<"$GUARD"; then
  bad "guard peligroso reintroducido" "el arranque desde el pipeline saltea por el nombre exacto con guiones (no-track silencioso en Codex)"
else
  ok "el arranque desde el pipeline no saltea por nombre exacto con guiones"
fi

# 4. El guard menciona ambas variantes / guiones bajos
grep -qiE "guiones bajos|AMBAS variantes|ambas variantes|list_clockify_workspaces" <<<"$GUARD" \
  && ok "el arranque desde el pipeline chequea ambas variantes de nombre" \
  || bad "caveat ausente en el guard" "el arranque desde el pipeline no aclara la variante Codex"

# 5. El paso 0b no nombra la herramienta: el guard no puede volver a él
if grep -qiE 'clockify|clocki' "$STEP"; then
  bad "el paso 0b nombra la herramienta" "lo propio de Clockify va en su integración, no en el paso del pipeline"
else
  ok "el paso 0b no nombra ninguna herramienta de horas"
fi

echo; [[ "$fallos" = "0" ]] && { echo "✅ clocki-codex-toolnames: verde"; exit 0; } || { echo "❌ clocki-codex-toolnames: $fallos fallo(s)"; exit 1; }
