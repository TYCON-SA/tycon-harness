#!/usr/bin/env bash
# step-times.test.sh — red de la cuenta de tiempos de una corrida.
#
# Por qué existe: el agente marca cada paso al TERMINARLO; si nadie anota cuándo empieza, la duración
# de un paso es «del fin del anterior al fin de éste», y el tiempo muerto antes de arrancar cae
# entero en el paso siguiente.
#
# Lo que prueba:
#   T3 — la espera del paso 3 no se suma al trabajo
#   T4 — el hueco entre pasos no se imputa al paso siguiente (el caso SR-1)
#   T5 — una corrida vieja (sin arranques) sale ESTIMADA, y su espera y su hueco son null con motivo
#   T6 — las marcas invertidas o empatadas se siguen fusionando
#   T6b — un paso de menos de un minuto se marca «junto»; el corte no depende del número de paso
#   T6c — un arranque ilegible o posterior al fin no se usa: el paso sale estimado
#
# Correr: bash scripts/tests/step-times.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$AQUI/scripts/metrics/step-times.js"
fallos=0; pasaron=0
ok(){ echo "✅ tiempos: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ tiempos: $1"; fallos=$((fallos+1)); }

# evalúa una expresión JS sobre tiempos(stepTimings, {inicio}); imprime el resultado
calc(){ # $1 json de stepTimings  $2 inicio ISO  $3 expresión sobre `t`
  LIB="$LIB" ST="$1" INI="$2" EXPR="$3" node -e '
    const { tiempos } = require(process.env.LIB);
    const t = tiempos(JSON.parse(process.env.ST), { inicio: process.env.INI });
    process.stdout.write(String(eval(process.env.EXPR)));
  ' 2>&1
}
H(){ echo "2026-09-16T$1:00.000Z"; }
M=60000

# ── T3 — 40 minutos de espera en el paso 3 ─────────────────────────────────────────────────────
ST3=$(cat <<EOF
{"1":{"startedAt":"$(H 10:00)","completedAt":"$(H 10:10)"},
 "2":{"startedAt":"$(H 10:10)","completedAt":"$(H 10:20)"},
 "3":{"startedAt":"$(H 10:20)","completedAt":"$(H 11:00)"},
 "4":{"startedAt":"$(H 11:00)","completedAt":"$(H 11:30)"}}
EOF
)
r=$(calc "$ST3" "$(H 10:00)" 't.espera_humana_ms')
[ "$r" = "$((40*M))" ] && ok "T3 la espera del paso 3 da 40 min" || no "T3 espera esperada 40 min, dio $r"
r=$(calc "$ST3" "$(H 10:00)" 't.trabajo_ms')
[ "$r" = "$((50*M))" ] && ok "T3 el trabajo NO suma la espera (50 min)" || no "T3 trabajo esperado 50 min, dio $r"
r=$(calc "$ST3" "$(H 10:00)" 't.estado')
[ "$r" = "medida" ] && ok "T3 la corrida con todos los arranques sale medida" || no "T3 estado: $r"

# ── T4 — el caso SR-1: 2 h 40 min sin nada y 50 min de cierre ───────────────────────────────────
ST4=$(cat <<EOF
{"5":{"startedAt":"$(H 10:00)","completedAt":"$(H 10:30)"},
 "6":{"startedAt":"$(H 10:30)","completedAt":"$(H 10:40)"},
 "7":{"startedAt":"$(H 10:40)","completedAt":"$(H 10:45)"},
 "8":{"startedAt":"$(H 13:25)","completedAt":"$(H 14:15)"}}
EOF
)
r=$(calc "$ST4" "$(H 10:00)" 't.pasos.find((p) => p.paso === "8").ms')
[ "$r" = "$((50*M))" ] && ok "T4 el paso 8 dura 50 min, no 3,3 h" || no "T4 paso 8 = $r ms"
r=$(calc "$ST4" "$(H 10:00)" 't.entre_pasos_ms')
[ "$r" = "$((160*M))" ] && ok "T4 las 2 h 40 min salen como hueco entre pasos" || no "T4 hueco = $r"
r=$(calc "$ST4" "$(H 10:00)" 't.trabajo_ms + t.espera_humana_ms + t.entre_pasos_ms')
[ "$r" = "$((255*M))" ] && ok "T4 trabajo + espera + hueco = la corrida entera" || no "T4 la suma no cierra: $r"

# ── T5 — corrida vieja: sólo completedAt ───────────────────────────────────────────────────────
ST5=$(cat <<EOF
{"1":{"completedAt":"$(H 10:10)"},"2":{"completedAt":"$(H 10:20)"},
 "3":{"completedAt":"$(H 11:00)"},"4":{"completedAt":"$(H 11:30)"}}
EOF
)
r=$(calc "$ST5" "$(H 10:00)" 't.estado')
[ "$r" = "estimada" ] && ok "T5 sin arranques sale estimada" || no "T5 estado: $r"
r=$(calc "$ST5" "$(H 10:00)" 'String(t.espera_humana_ms) + "|" + String(t.entre_pasos_ms)')
[ "$r" = "null|null" ] && ok "T5 espera y hueco son null, nunca 0" || no "T5 espera|hueco: $r"
r=$(calc "$ST5" "$(H 10:00)" 'Boolean(t.motivo && /arranque/.test(t.motivo))')
[ "$r" = "true" ] && ok "T5 el motivo dice que faltan los arranques" || no "T5 motivo ausente"
r=$(calc "$ST5" "$(H 10:00)" 't.estimados.join(",")')
[ "$r" = "1,2,3,4" ] && ok "T5 la cuenta lista los pasos estimados" || no "T5 estimados: $r"
r=$(calc "$ST5" "$(H 10:00)" 't.pasos.find((p) => p.paso === "3").ms')
[ "$r" = "$((40*M))" ] && ok "T5 la duración estimada es la de siempre (del fin anterior al fin)" || no "T5 paso 3 estimado = $r"
# mezcla: arranque sólo en el paso 4 → parcial, la espera del 3 no se mide
ST5b=$(cat <<EOF
{"1":{"completedAt":"$(H 10:10)"},"2":{"completedAt":"$(H 10:20)"},
 "3":{"completedAt":"$(H 11:00)"},"4":{"startedAt":"$(H 11:05)","completedAt":"$(H 11:30)"}}
EOF
)
r=$(calc "$ST5b" "$(H 10:00)" 't.estado + "|" + String(t.espera_humana_ms) + "|" + t.entre_pasos_ms')
[ "$r" = "parcial|null|$((5*M))" ] && ok "T5 parcial: el hueco medido se publica, la espera sin arranque no" || no "T5 parcial: $r"

# ── T6 — invertidas y empatadas siguen fusionándose ────────────────────────────────────────────
ST6=$(cat <<EOF
{"4":{"startedAt":"$(H 10:00)","completedAt":"$(H 10:30)"},
 "5":{"startedAt":"$(H 10:30)","completedAt":"$(H 10:50)"},
 "6":{"startedAt":"$(H 10:45)","completedAt":"$(H 10:40)"}}
EOF
)
r=$(calc "$ST6" "$(H 10:00)" 't.pasos.map((p) => p.paso).join(",")')
[ "$r" = "4,5+6" ] && ok "T6 las marcas invertidas se fusionan (5+6)" || no "T6 pasos: $r"
r=$(calc "$ST6" "$(H 10:00)" 't.pasos.find((p) => p.paso === "5+6").medida')
[ "$r" = "false" ] && ok "T6 lo fusionado no cuenta como medido" || no "T6 fusionado medida=$r"

# ── T6b — «junto con el anterior» por duración, no por número ──────────────────────────────────
ST6b=$(cat <<EOF
{"1":{"startedAt":"$(H 10:00)","completedAt":"$(H 10:20)"},
 "2":{"startedAt":"$(H 10:20)","completedAt":"2026-09-16T10:20:30.000Z"}}
EOF
)
r=$(calc "$ST6b" "$(H 10:00)" 't.pasos.map((p) => p.paso + ":" + p.junto).join(",")')
[ "$r" = "1:false,2:true" ] && ok "T6b un paso de 30 s se marca junto con el anterior" || no "T6b: $r"

# ── T6c — arranques que no sirven ─────────────────────────────────────────────────────────────
ST6c=$(cat <<EOF
{"1":{"startedAt":"no-es-fecha","completedAt":"$(H 10:10)"},
 "2":{"startedAt":"$(H 10:50)","completedAt":"$(H 10:20)"}}
EOF
)
r=$(calc "$ST6c" "$(H 10:00)" 't.estimados.join(",")')
[ "$r" = "1,2" ] && ok "T6c arranque ilegible o posterior al fin → estimado" || no "T6c estimados: $r"
r=$(calc "{}" "no-es-fecha" 't.estado')
[ "$r" = "sin_inicio" ] && ok "T6c sin hora de inicio de la corrida no hay eje" || no "T6c sin inicio: $r"

# ── T6d — el sub-paso 5b es trabajo, no hueco ─────────────
ST6d=$(cat <<EOF
{"5":{"startedAt":"$(H 10:00)","completedAt":"$(H 11:00)"},
 "5b":{"startedAt":"$(H 11:00)"},
 "6":{"startedAt":"$(H 11:30)","completedAt":"$(H 11:40)"}}
EOF
)
r=$(calc "$ST6d" "$(H 10:00)" 't.trabajo_ms + "|" + t.entre_pasos_ms')
[ "$r" = "$((100*M))|0" ] && ok "T6d los 30 min del pase adversarial cuentan como trabajo, no como hueco" || no "T6d trabajo|hueco: $r"
r=$(calc "$ST6d" "$(H 10:00)" 't.pasos.map((p) => p.paso).join(",")')
[ "$r" = "5,5b,6" ] && ok "T6d el sub-paso aparece como tramo propio" || no "T6d pasos: $r"

# ── T6e — vuelta de revisión: pasos que se pisan no se miden ─────────────────────
ST6e=$(cat <<EOF
{"3":{"startedAt":"$(H 09:00)","completedAt":"$(H 09:05)"},
 "4":{"startedAt":"$(H 09:05)","completedAt":"$(H 10:00)"},
 "5":{"startedAt":"$(H 10:00)","completedAt":"$(H 14:00)"},
 "6":{"startedAt":"$(H 10:30)","completedAt":"$(H 14:05)"},
 "7":{"startedAt":"$(H 10:35)","completedAt":"$(H 14:10)"}}
EOF
)
r=$(calc "$ST6e" "$(H 09:00)" 't.estado + "|" + t.trabajo_medido + "|" + t.estimados.join(",")')
[ "$r" = "parcial|false|5,6,7" ] && ok "T6e los pasos de una vuelta que se pisan salen estimados, no medidos" || no "T6e: $r"
r=$(calc "$ST6e" "$(H 09:00)" 'String(t.espera_humana_ms)')
[ "$r" = "null" ] && ok "T6e con el 7 estimado la espera no se publica (no 10 min)" || no "T6e espera: $r"

# ── T6f — espera con uno solo de los dos pasos medido ───────────────────────
ST6f=$(cat <<EOF
{"3":{"startedAt":"$(H 09:00)","completedAt":"$(H 09:10)"},
 "6":{"completedAt":"$(H 10:00)"},
 "7":{"completedAt":"$(H 12:00)"}}
EOF
)
r=$(calc "$ST6f" "$(H 09:00)" 'String(t.espera_humana_ms) + "|" + /7/.test(t.motivo || "")')
[ "$r" = "null|true" ] && ok "T6f si el 7 no tiene arranque, la espera es null y el motivo lo nombra" || no "T6f: $r"
ST6g=$(cat <<EOF
{"2":{"startedAt":"$(H 09:00)","completedAt":"$(H 09:10)"},
 "3":{"startedAt":"$(H 09:12)","completedAt":"$(H 09:10)"}}
EOF
)
r=$(calc "$ST6g" "$(H 09:00)" 't.trabajo_medido + "|" + (t.sin_repartir_ms > 0)')
[ "$r" = "false|true" ] && ok "T6f un tramo fusionado con el 3 deja el trabajo como no medido" || no "T6f fusionado: $r"

# ── T6h — un arranque anterior al inicio de la corrida no se usa ──────────────────
ST6h=$(cat <<EOF
{"1":{"startedAt":"$(H 08:00)","completedAt":"$(H 10:10)"}}
EOF
)
r=$(calc "$ST6h" "$(H 10:00)" 't.estimados.join(",")')
[ "$r" = "1" ] && ok "T6h un arranque de antes del inicio (heredado) se descarta" || no "T6h: $r"

echo "tiempos: $pasaron bien · $fallos mal"
[ "$fallos" -eq 0 ]
