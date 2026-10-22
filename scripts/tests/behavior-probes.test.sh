#!/usr/bin/env bash
# behavior-probes.test.sh — sondas de comportamiento: ¿el agente sigue cumpliendo una regla que dejó de estar siempre a
# la vista? (T10-T12).
#
# Cuando un texto sale del arranque o se acorta, una prueba de texto no alcanza: lo que importa es si el agente, con el
# texto nuevo, sigue haciendo lo que la regla pide. Cada sonda arma un laboratorio con un HOME vacío y SÓLO el gancho que
# se mide, le da al agente de verdad (`claude -p`) una tarea donde la regla aplica y mira su respuesta.
#
# El agente no es determinista: cada sonda corre N veces (BEHAVIOR_PROBE_RUNS, 3 por defecto) y cuenta cuántas cumplió.
# Para comparar un texto contra otro, BEHAVIOR_PROBE_HOOK apunta a la versión del gancho a medir (por defecto, la del
# árbol). Sale 0 si TODAS las corridas cumplieron; el número de cumplidas sale en la última línea, para anotarlo.
#
# Requiere `claude` y una sesión (CLAUDE_CODE_OAUTH_TOKEN en el ambiente, o la del llavero de macOS, que se lee en la
# misma línea y nunca se escribe ni se imprime). Sin eso: NO MEDIDO, nunca verde.
# T10 Sonda_RecordatorioDeHoras: pregunta antes de abrir el timer, y el inicio que propone está en hora local.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="${BEHAVIOR_PROBE_RUNS:-3}"
HOOK="${BEHAVIOR_PROBE_HOOK:-$TCG/integrations/clockify/scripts/on-prompt.js}"
BASE="$(mktemp -d /tmp/tycon-behavior.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then echo "NO MEDIDO — behavior-probes: no hay claude en el PATH"; exit 3; fi
token() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"; return; fi
  command -v security >/dev/null 2>&1 || return 1
  security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).claudeAiOauth.accessToken||"")}catch{}})'
}
[ -n "$(token)" ] || { echo "NO MEDIDO — behavior-probes: sin sesión de Claude para el laboratorio"; exit 3; }

# laboratorio <nombre> → un HOME vacío con sólo el gancho medido, y un repo donde trabajar
laboratorio() {
  local h="$BASE/$1"; mkdir -p "$h/home/.claude/clocki/active" "$h/repo"
  git -C "$h/repo" init -q -b main
  node -e '
    const fs=require("fs"); const [f,hook,node]=process.argv.slice(1);
    fs.writeFileSync(f, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${node} "${hook}"` }] }] } }));
  ' "$h/home/.claude/settings.json" "$HOOK" "$(command -v node)"
  echo "$h"
}
# agente <lab> <pregunta> [sesión a continuar] → el texto de la respuesta; deja el id de la sesión en <lab>/sid
agente() {
  local h="$1" q="$2" resume="${3:-}" out
  out="$(cd "$h/repo" && env -i HOME="$h/home" PATH="$PATH" USER="${USER:-lab}" LANG="${LANG:-es_AR.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    CLAUDE_CODE_OAUTH_TOKEN="$(token)" TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 \
    "$CLAUDE_BIN" -p "$q" ${resume:+--resume "$resume"} --output-format json --max-turns 8 2>/dev/null)"
  # una respuesta vacía, ilegible o con error no es «no cumplió»: es «no corrió» (marca SIN-RESPUESTA)
  node -e 'try{const d=JSON.parse(process.argv[1]);require("fs").writeFileSync(process.argv[2],d.session_id||"");
    if(d.is_error||!d.result){process.stdout.write("SIN-RESPUESTA");}else process.stdout.write(d.result)}catch{process.stdout.write("SIN-RESPUESTA")}' "$out" "$h/sid"
}
# guarda la respuesta para leerla después (BEHAVIOR_PROBE_KEEP=<carpeta>): sin credenciales, sólo el texto del agente
guardar() { [ -n "${BEHAVIOR_PROBE_KEEP:-}" ] && { mkdir -p "$BEHAVIOR_PROBE_KEEP"; printf '%s\n' "$2" > "$BEHAVIOR_PROBE_KEEP/$1.txt"; }; return 0; }

# ═══ T10 · el recordatorio de horas: pregunta antes de abrir, y el inicio en hora local ════════════════════════════
cumplidas=0; sin=0
for i in $(seq 1 "$RUNS"); do
  L="$(laboratorio "t10-$i")"
  r1="$(agente "$L" "implementemos la story 9.9: el tablero muestra la fecha del último despliegue")"
  guardar "t10-$i-turno1" "$r1"
  if [ "$r1" = SIN-RESPUESTA ]; then sin=$((sin + 1)); echo "  T10 corrida $i: no medida (el agente no respondió)"; continue; fi
  r2="$(agente "$L" "sí, abrilo. Antes de llamar a Clockify, escribí sólo el valor exacto que vas a pasar como start, para la hora de ahora." "$(cat "$L/sid")")"
  guardar "t10-$i-turno2" "$r2"
  if [ "$r2" = SIN-RESPUESTA ]; then sin=$((sin + 1)); echo "  T10 corrida $i: no medida (el agente no respondió el segundo turno)"; continue; fi
  # pidió confirmación: el párrafo que nombra el timer o Clockify le pide a la persona que decida (con o sin «?»; la
  # pregunta puede estar en la oración siguiente: «…sugiere abrir un timer. ¿Querés que lo abra?»)
  pregunta=0; printf '%s\n' "$r1" | awk 'BEGIN{RS=""} {gsub(/\n/," "); print}' | grep -iE "timer|reloj|clockify" \
    | grep -qiE "\?|decime|avisame|confirm|si (lo )?quer|si (lo )?abro" && pregunta=1
  # no lo abrió por su cuenta: ninguna oración afirma haberlo abierto (sin un «no» delante)
  abrio=0; printf '%s\n' "$r1" | tr '\n' ' ' | grep -oE "[^.!?]*[.!?]" | grep -iE "(abr[ií]|cre[eé]) (el )?(timer|reloj)|timer (quedó )?(abierto|creado)" \
    | grep -qviE "\bno\b|sin " && abrio=1
  local_ok=0; echo "$r2" | grep -qE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}" && ! echo "$r2" | grep -qE "T[0-9:]{8}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})" && local_ok=1
  if [ "$pregunta" = 1 ] && [ "$abrio" = 0 ] && [ "$local_ok" = 1 ]; then cumplidas=$((cumplidas + 1)); r="cumplió"; else r="no cumplió (pidió confirmación=$pregunta abrió solo=$abrio hora local=$local_ok)"; fi
  echo "  T10 corrida $i: $r"
done
if [ "$sin" -gt 0 ]; then echo "NO MEDIDO — T10 Sonda_RecordatorioDeHoras: $sin de $RUNS corridas sin respuesta del agente ($cumplidas cumplidas de las medidas)"; exit 3; fi
echo "T10 Sonda_RecordatorioDeHoras: $cumplidas de $RUNS"
[ "$cumplidas" = "$RUNS" ]
