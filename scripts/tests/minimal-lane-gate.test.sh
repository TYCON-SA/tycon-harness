#!/usr/bin/env bash
# minimal-lane-gate.test.sh — con la instalación mínima, el portón de edición está registrado y hace lo mismo que en la
# completa, sobre un repo con la forma del laboratorio del capítulo 2 (specs/story-1-1.md, src/, test/):
#   T2 editar código sin recorrido se niega, con la pregunta en llano para la persona
#   T3 el ajuste puntual, declarado con la frase literal de la persona, pasa
#   T4 la primera historia: con el recorrido abierto y sin plan aprobado se niega; con el plan aprobado, pasa
#   T5 la lista de la completa no cambia: el portón sigue ahí, y el resto de full también
# El hook se corre como lo corre el agente: el comando que la lista de efectos registra antes de Edit|Write, con el
# evento en la entrada. HOME temporal: nada toca la máquina.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SKILL="$ROOT/skills/tycon-pipeline/scripts"
EFFECTS="$ROOT/scripts/setup/install-effects.json"
T="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/minimal-lane-XXXXXX")" && pwd -P)"
trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "  ✓ $1"; }
mal() { echo "  ✗ $1"; fail=1; }
unset TYCON_STORY_GATE TYCON_SESSION_ID CODEX_SESSION_ID TYCON_TEST_GATE NODE_TEST_CONTEXT

# el repo del capítulo 2, con git y una rama de trabajo
R="$T/precios"; mkdir -p "$R/src" "$R/test" "$R/specs"
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
git -C "$R" -c maintenance.auto=false init -q -b main
git -C "$R" config user.email prueba@ejemplo.invalid; git -C "$R" config user.name prueba
printf '{ "name": "precios", "version": "1.0.0", "scripts": { "test": "node --test" } }\n' > "$R/package.json"
printf 'export const enPesos = (n) => `$ ${n}`;\n' > "$R/src/formato.js"
printf 'import test from "node:test";\n' > "$R/test/formato.test.js"
printf -- '---\nepic: 1\nstory: "1.1"\ntitle: "El precio en pesos"\nstatus: ready-for-dev\nfiles_to_create: []\nfiles_to_modify:\n  - src/formato.js\n---\n\n# Story 1.1: El precio en pesos\n\n## Acceptance Criteria\n\n1. **Given** un precio **When** se formatea **Then** se ve en pesos\n\n### Tests\n\n| # | Test | AC | Nivel | Escenario | Resultado esperado |\n|---|---|---|---|---|---|\n| T1 | `EnPesos_Formatea` | 1 | unit | 96.8 | $ 96,80 |\n' > "$R/specs/story-1-1.md"
git -C "$R" add -A; git -C "$R" -c maintenance.auto=false commit -qm base; git -C "$R" checkout -qb trabajo

H="$T/home"; mkdir -p "$H/.claude"
# los dos lugares que deja el instalador: el arnés y las skills, apuntando al árbol que se mide
ln -s "$ROOT" "$H/.claude/tycon-harness"; ln -s "$ROOT" "$H/.claude/agent-skills"
# el comando que la lista de efectos registra en minimal para el portón (si no lo registra, no hay qué correr)
SPEC="$(node -e 'const e=require(process.argv[1]).effects.find((x)=>x.id==="PreToolUse:tycon-pipeline/scripts/hook-pre-edit.js");process.stdout.write(e&&(e.profiles||[]).includes("minimal")?"si":"no")' "$EFFECTS")"
[ "$SPEC" = si ] || mal "la lista de efectos no registra el portón en minimal: lo que sigue mide un hook que la mínima no instala"

editar() { # editar <sid> <archivo> → salida del hook (y deja su exit code en RC)
  local ev; ev="$(printf '{"session_id":"%s","hook_event_name":"PreToolUse","tool_name":"Edit","cwd":"%s","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$1" "$R" "$2")"
  OUT="$(cd "$R" && printf '%s' "$ev" | HOME="$H" CLAUDE_CODE_SESSION_ID="$1" node "$SKILL/hook-pre-edit.js" 2>&1)"; RC=$?
}
# negado: el portón niega (salida 2 o la decisión deny) con su propio texto · pasa: el hook terminó bien y no negó.
# Un hook que se cae (salida 1, sin deny) no es ninguna de las dos: no se lee como «pasa».
negado() { { [ "$RC" = 2 ] || grep -q '"permissionDecision":"deny"' <<<"$OUT"; } && grep -q 'tycon-pipeline' <<<"$OUT"; }
pasa() { [ "$RC" = 0 ] && ! grep -q '"permissionDecision":"deny"' <<<"$OUT"; }

echo "T2 · MinimalLab_EditWithoutLane_DeniedPlain @story-8.74 @ac-2"
editar s874a "$R/src/formato.js"
if negado && grep -q 'CÓDIGO SIN CARRIL' <<<"$OUT" && grep -q 'ajuste puntual' <<<"$OUT" && grep -q 'story y revisión completa' <<<"$OUT"; then
  ok "editar src/formato.js sin recorrido se niega, con la pregunta en llano (ajuste puntual o historia y revisión)"
else mal "no se negó o el mensaje no trae la pregunta: rc=$RC $(head -c 300 <<<"$OUT")"; fi

echo "T3 · MinimalLab_AdhocWithQuote_Allowed @story-8.74 @ac-3"
# lo que escribió la persona entra por el control que lo anota en una sesión real (on-prompt.js, también en minimal);
# sin el clasificador por modelo, decide la cita literal
printf '{"session_id":"s874b","hook_event_name":"UserPromptSubmit","cwd":"%s","prompt":"es un ajuste chico, sin story: arreglá el formato"}' "$R" \
  | ( cd "$R" && HOME="$H" CLAUDE_CODE_SESSION_ID=s874b node "$SKILL/on-prompt.js" ) >"$T/prompt.out" 2>&1 \
  || mal "on-prompt.js no anotó lo que escribió la persona: $(head -c 300 "$T/prompt.out")"
AD="$( cd "$R" && HOME="$H" CLAUDE_CODE_SESSION_ID=s874b TYCON_LANE_LLM=0 node "$SKILL/marker.js" adhoc set '{"reason":"es un ajuste chico, sin story"}' 2>&1 )" \
  || mal "no se pudo declarar el ajuste puntual con la frase de la persona: $(head -c 300 <<<"$AD")"
editar s874b "$R/src/formato.js"
pasa && ok "con el ajuste puntual declarado, la edición pasa" || mal "el ajuste puntual con la frase de la persona no pasó: rc=$RC $(head -c 300 <<<"$OUT")"

echo "T4 · MinimalLab_FirstStory_PipelineOpensGate @story-8.74 @ac-4"
S1="$( cd "$R" && HOME="$H" CLAUDE_CODE_SESSION_ID=s874c TYCON_PIPELINE_NO_AUTONOMOUS=1 node "$SKILL/pipeline.js" start --story "$R/specs/story-1-1.md" --repo "$R" --brief 2>&1 )"
grep -q '"ready": true' <<<"$S1" || mal "pipeline.js start no abrió el recorrido: $(head -c 300 <<<"$S1")"
editar s874c "$R/src/formato.js"
if negado && grep -q 'Aprobar el plan' <<<"$OUT"; then ok "con el recorrido abierto y sin plan aprobado, se niega por el plan"
else mal "sin plan aprobado no se negó por el plan: rc=$RC $(head -c 300 <<<"$OUT")"; fi
( cd "$R" && for n in 1 2; do HOME="$H" CLAUDE_CODE_SESSION_ID=s874c node "$SKILL/marker.js" complete-step $n || exit 1; done
  HOME="$H" CLAUDE_CODE_SESSION_ID=s874c node "$SKILL/marker.js" complete-step 3 --approved "dale, implementala" --approved-by prueba@ejemplo.invalid ) >"$T/pasos.out" 2>&1 \
  || mal "no se pudieron cerrar los pasos 1 a 3: $(tail -c 300 "$T/pasos.out")"
editar s874c "$R/test/formato.test.js"
pasa && ok "con el plan aprobado, la edición pasa" || mal "con el plan aprobado, la prueba no se pudo escribir: rc=$RC $(head -c 300 <<<"$OUT")"

echo "T5 · MinimalLab_FullUnchanged @story-8.74 @ac-1"
FULL="$(node -e 'const l=require(process.argv[1]).effects.filter((x)=>x.kind==="hook"&&(x.profiles||[]).includes("full")).map((x)=>x.id);console.log(l.length+" "+l.includes("PreToolUse:tycon-pipeline/scripts/hook-pre-edit.js"))' "$EFFECTS")"
FULL_MAIN="$(git -C "$ROOT" show origin/main:scripts/setup/install-effects.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).effects.filter((x)=>x.kind==="hook"&&(x.profiles||[]).includes("full")).length)}catch(e){console.log("?")}})')"
if [ "${FULL%% *}" = "$FULL_MAIN" ] && [ "${FULL##* }" = true ]; then ok "la completa sigue con sus ${FULL%% *} hooks, el portón entre ellos"
elif [ "$FULL_MAIN" = "?" ] && [ "${FULL##* }" = true ]; then echo "  ⏭ NO MEDIDO: sin origin/main no comparo la cuenta de la completa (trae el portón: ${FULL%% *} hooks); no es un verde"
else mal "la completa cambió: ${FULL} contra ${FULL_MAIN} en main"; fi

[ "$fail" = 0 ] && echo "=== TODOS OK ===" || { echo "=== HUBO FALLOS ==="; exit 1; }
