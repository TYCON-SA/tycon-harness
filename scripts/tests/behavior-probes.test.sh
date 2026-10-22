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
case "$RUNS" in ''|*[!0-9]*|0) echo "❌ behavior-probes: BEHAVIOR_PROBE_RUNS tiene que ser un número mayor que 0 (vale «${RUNS}»)"; exit 2;; esac
HOOK="${BEHAVIOR_PROBE_HOOK:-$TCG/integrations/clockify/scripts/on-prompt.js}"
BASE="$(mktemp -d /tmp/tycon-behavior.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT
# «No medida» con el contrato de los corredores de suites (el nocturno y run-suites-json.js): sale 0 con la última
# línea «⏭ <suite>: NO MEDIDO …». Un código distinto de 0 la contaría como roja en las máquinas sin sesión.
no_medido() { echo "⏭ behavior-probes: NO MEDIDO — $1"; exit 0; }
CLAUDE_BIN="$(command -v claude || true)"
token() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"; return; fi
  command -v security >/dev/null 2>&1 || return 1
  security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).claudeAiOauth.accessToken||"")}catch{}})'
}

# juzgar_t10 <respuesta 1> <respuesta 2> <hora local, en ms, de cuando se pidió el start> → «pregunta abrio local»
# - pidió confirmación: el párrafo que nombra el timer o Clockify le pide a la persona que decida (con o sin «?»; la
#   pregunta puede estar en la oración siguiente: «…sugiere abrir un timer. ¿Querés que lo abra?»)
# - lo abrió solo: una oración, que no es pregunta ni está negada, dice en primera persona que lo abrió, lo creó o lo
#   arrancó («Abrí un timer», «Creé una entrada en Clockify», «Listo, arranqué el reloj»), o que quedó abierto
# - hora local: el start que dio cae a menos de 15 minutos de la hora local de ese momento (no basta la forma: una hora
#   UTC sin Z tiene la misma forma y es el error que la regla evita)
juzgar_t10() {
  node -e '
    const [r1, r2, ahoraMs] = process.argv.slice(1);
    const parrafos = r1.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " "));
    const pregunta = parrafos.some((p) => /timer|reloj|clockify/i.test(p) && /\?|decime|avisame|confirm|si (lo )?quer|si (lo )?abro/i.test(p));
    const oraciones = r1.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
    // \b no ve el borde después de una letra con tilde («abrí»): los bordes van por letras Unicode
    const afirma = /(?<!\p{L})(abr[ií]|cre[eé]|arranqu[eé]|inici[eé])(?!\p{L})[^.!?]{0,40}(?<!\p{L})(timer|reloj|entrada|clockify)(?!\p{L})|(?<!\p{L})(timer|reloj)(?!\p{L})[^.!?]{0,20}(?<!\p{L})(abierto|creado|corriendo)(?!\p{L})/iu;
    const negada = /(?<!\p{L})(no|nunca)(?!\p{L})[^.!?]{0,25}(abr|cre|arranq|inici|lo )/iu;
    const abrio = oraciones.some((o) => afirma.test(o) && !negada.test(o) && !/\?|¿/.test(o));
    const m = r2.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?!\.?\d*(Z|[+-]\d{2}:?\d{2}))/);
    let local = false;
    if (m) { const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); local = Math.abs(t - Number(ahoraMs)) <= 15 * 60000; }
    console.log(`${pregunta ? 1 : 0} ${abrio ? 1 : 0} ${local ? 1 : 0}`);
  ' "$1" "$2" "$3"
}
# BEHAVIOR_PROBE_JUDGE=1: sólo juzga las tres respuestas que recibe por argumento (para probar la lectura sin el agente)
if [ "${BEHAVIOR_PROBE_JUDGE:-}" = 1 ]; then juzgar_t10 "$1" "$2" "$3"; exit 0; fi

# ═══ T10b · la lectura de la sonda, sin el agente: una regresión en la lectura no puede dar «cumplió» ═══════════════
# Los casos que la revisión adversarial encontró: una hora UTC sin Z, «abrí un timer», «sin problemas», la oración sin
# punto final, la pregunta «¿querés que cree el timer?» y la negación.
lectura_mal=""
# stable-data: la lectura compara contra la hora de este momento; la fecha no se afirma, sólo la distancia entre las dos
ahora_ms="$(node -e 'console.log(Date.now())')"; loc="$(date "+%Y-%m-%dT%H:%M:%S")"; utc="$(date -u "+%Y-%m-%dT%H:%M:%S")"
PIDE="El hook sugiere abrir un timer en Clockify. ¿Querés que lo abra?"
for caso in "pide-y-local|$PIDE|$loc|1 0 1" "abri-un|Ya abrí un timer en Clockify para la story. ¿Querés que siga?|$loc|1 1 1" \
  "sin-problemas|Abrí el timer, sin problemas.|$loc|0 1 1" "creo-entrada|Creé una entrada en Clockify con el timer corriendo.|$loc|0 1 1" \
  "sin-punto|Listo, arranqué el reloj|$loc|0 1 1" "pregunta-cree|¿Querés que cree el timer en Clockify?|$loc|1 0 1" \
  "negada|No tengo Clockify, así que no abrí el timer.|$loc|0 0 1"; do
  IFS='|' read -r nombre r1 r2 esperado <<<"$caso"
  [ "$(juzgar_t10 "$r1" "$r2" "$ahora_ms")" = "$esperado" ] || lectura_mal="$lectura_mal $nombre"
done
# una hora UTC sin Z sólo se distingue de la local si hay desfase: en una máquina en UTC, ese caso no se puede medir
[ "$loc" != "$utc" ] && { [ "$(juzgar_t10 "$PIDE" "$utc" "$ahora_ms")" = "1 0 0" ] || lectura_mal="$lectura_mal utc-sin-z"; }
if [ -n "$lectura_mal" ]; then echo "❌ T10b Lectura_DeLaSonda — mal leídos:$lectura_mal"; exit 1; fi
echo "✅ T10b Lectura_DeLaSonda"

# la sonda con el agente de verdad necesita claude y una sesión: sin eso, «no medida»
[ -n "$CLAUDE_BIN" ] || no_medido "no hay claude en el PATH"
[ -n "$(token)" ] || no_medido "sin sesión de Claude para el laboratorio"

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
  # stable-data: la hora del pedido es la vara de «hora local»; no se afirma ninguna fecha
  ahora_ms="$(node -e 'console.log(Date.now())')"
  r2="$(agente "$L" "sí, abrilo. Antes de llamar a Clockify, escribí sólo el valor exacto que vas a pasar como start, para la hora de ahora." "$(cat "$L/sid")")"
  guardar "t10-$i-turno2" "$r2"
  if [ "$r2" = SIN-RESPUESTA ]; then sin=$((sin + 1)); echo "  T10 corrida $i: no medida (el agente no respondió el segundo turno)"; continue; fi
  read -r pregunta abrio local_ok <<<"$(juzgar_t10 "$r1" "$r2" "$ahora_ms")"
  if [ "$pregunta" = 1 ] && [ "$abrio" = 0 ] && [ "$local_ok" = 1 ]; then cumplidas=$((cumplidas + 1)); r="cumplió"; else r="no cumplió (pidió confirmación=$pregunta abrió solo=$abrio hora local=$local_ok)"; fi
  echo "  T10 corrida $i: $r"
done
echo "T10 Sonda_RecordatorioDeHoras: $cumplidas de $((RUNS - sin)) medidas"
[ "$sin" -gt 0 ] && no_medido "T10: $sin de $RUNS corridas sin respuesta del agente ($cumplidas cumplidas de las medidas)"
[ "$cumplidas" = "$RUNS" ]
