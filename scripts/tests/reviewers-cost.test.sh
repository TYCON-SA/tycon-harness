#!/usr/bin/env bash
# reviewers-cost.test.sh — red de `scripts/metrics/reviewers-cost.js` (story 2.15 del arnés, 2026-09-09).
#
# Lo que cuida, en una frase: que de cada corrida del pipeline quede escrito cuánto costó la REVISIÓN
# —cuántos revisores, de qué tipo, cuánto tardó cada uno, cuánto devolvió y cuánto consumió cuando
# se puede saber— y que lo MEDIDO y lo ESTIMADO no se mezclen nunca en el mismo número.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. Los que más pesan:
#    · T2 — el pipeline lanza revisores en paralelo y las notificaciones llegan en cualquier orden:
#      emparejar por orden de llegada cruza dos revisores sin dar error. Sólo por identificador.
#    · T4 — un revisor que no volvió NO es un revisor de duración 0: sumarlo baja la mediana y miente.
#    · T5 — el estimado jamás entra en lo medido: ni en el consumo del hilo ni en los tokens de los
#      revisores. El chequeo de separación lo detecta cuando alguien los suma.
#    · T6 — un supuesto vencido no ampara ninguna cuenta: sale «no medido» con la fecha.
#
# Los universos (una conversación con dos notificaciones invertidas, un lanzamiento sin resultado, un
# hilo comprimido sin conversación viva) no existen en ningún archivo real: los fabrica cada caso.
# Sin red. Nunca se lee el registro de la máquina: todo va a un temporal.
#
# bash 3.2 (macOS): siempre `${v}`, nunca `«$v»` (lección de la 2.13).
#
# Correr: bash scripts/tests/reviewers-cost.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEDIDOR="${RAIZ}/scripts/metrics/reviewers-cost.js"
DIGEST="${RAIZ}/scripts/metrics/tokens-digest.js"
TABLERO="${RAIZ}/scripts/nightly/dashboard/dashboard.js"
SUPUESTO_REAL="${RAIZ}/scripts/metrics/reviewers-cost-assumption.json"

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

if [ ! -f "${MEDIDOR}" ]; then
  echo "❌ costo-revisores: falta ${MEDIDOR}"; exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
PROJ="${TMP}/projects"; HIST="${TMP}/history"; RUNS="${TMP}/advisor-runs"
mkdir -p "${PROJ}/carpeta-cualquiera" "${HIST}" "${RUNS}"
HOY="2026-09-10"
# 🔴 Los casos usan un supuesto PROPIO, no el del repo: el real se renueva con cada medición (lo hizo el
# 2026-09-10) y los números de T5/T6 no pueden moverse con él. El real tiene su caso aparte (T16).
SUPUESTO="${TMP}/supuesto.json"
cat > "${SUPUESTO}" <<'JSON'
{ "tokens_per_launch_range": [60000, 100000], "ten_reviewers_pass_tokens": 1000000,
  "source": "fixture de la suite", "measured_on": "2026-07-28", "review_before": "2026-12-31" }
JSON

# ── Fabricantes de fixtures ──────────────────────────────────────────────────────────────────────
# Todos con python3 (para no pelear con comillas en bash). Cada fabricante recibe por stdin un
# programa que define `lineas` (lista de dicts o strings) y las escribe una por línea.
#   $1 = ruta destino
jsonl() {
  local destino="$1"
  python3 -c "
import json, sys
ns = {}
exec(sys.stdin.read(), ns)
with open('${destino}', 'w', encoding='utf-8') as fh:
    for l in ns['lineas']:
        fh.write(l if isinstance(l, str) else json.dumps(l, ensure_ascii=False))
        fh.write('\n')
"
}
# Igual que jsonl, pero comprimido: el hilo que guarda la story 2.13 (`<volcado>.hilo.jsonl.gz`).
jsonl_gz() {
  local destino="$1"
  python3 -c "
import json, sys, gzip
ns = {}
exec(sys.stdin.read(), ns)
with gzip.open('${destino}', 'wt', encoding='utf-8') as fh:
    for l in ns['lineas']:
        fh.write(l if isinstance(l, str) else json.dumps(l, ensure_ascii=False))
        fh.write('\n')
"
}
# Un volcado de corrida con la forma que escribe `marker.js cmdClear` (+ lo que dejó la 2.13).
#   $1 destino · $2 sessionId · $3 consumo JSON ('null' = sin consumo) · $4 costo JSON
volcado() {
  python3 -c "
import json
consumo = json.loads('''$3''')
d = {'archivedAt': '2026-09-01T00:00:00.000Z',
     'marker': {'storyId': 'X.Y', 'sessionId': '$2', 'startedAt': '2026-09-01T09:50:00.000Z',
                'lastTouch': '2026-09-01T11:00:00.000Z', 'stepsCompleted': [0,1,2,3,4,5,6,7,8],
                'stepTimings': {'4': {'completedAt': '2026-09-01T10:00:00.000Z'}, '5': {'completedAt': '2026-09-01T10:30:00.000Z'}}},
     'gates': [],
     'costo': json.loads('''$4''')}
if consumo is not None: d['consumo'] = consumo
open('$1', 'w', encoding='utf-8').write(json.dumps(d, indent=2))
"
}
# Los ladrillos de una conversación y de un registro, compartidos por los casos.
LADRILLOS='
def lanz(tid, ts, tipo, modelo=None, bg=True):
    inp = {"description": "x", "subagent_type": tipo, "prompt": "P"}
    if modelo: inp["model"] = modelo
    return {"type": "assistant", "timestamp": ts, "message": {"id": "m-" + tid, "role": "assistant",
            "content": [{"type": "tool_use", "id": tid, "name": "Agent", "input": inp}]}}
def acuse(tid, ts):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": "Async agent launched successfully. agentId: zzz"}]}]}}
def notif_txt(tid, resultado, tokens=None, herramientas=None, duracion=None):
    uso = ""
    if tokens is not None:
        uso = "<usage><subagent_tokens>%d</subagent_tokens><tool_uses>%d</tool_uses><duration_ms>%d</duration_ms></usage>" % (tokens, herramientas or 0, duracion or 0)
    return ("<task-notification>\n<task-id>t-" + tid + "</task-id>\n<tool-use-id>" + tid + "</tool-use-id>\n"
            "<status>completed</status>\n<summary>Agent \"x\" finished</summary>\n<result>" + resultado + "</result>\n" + uso + "\n</task-notification>")
def notif(tid, ts, resultado, tokens=None, herramientas=None, duracion=None):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": notif_txt(tid, resultado, tokens, herramientas, duracion)}}
# La notificación ENCOLADA (el padre estaba ocupado): tres líneas con el mismo texto y NINGUNA `user`.
def encolada(tid, ts, resultado, tokens=None, herramientas=None, duracion=None):
    t = notif_txt(tid, resultado, tokens, herramientas, duracion)
    return [{"type": "queue-operation", "operation": "enqueue", "timestamp": ts, "sessionId": "s", "content": t},
            {"type": "attachment", "timestamp": ts, "attachment": {"type": "queued_command", "prompt": t}},
            {"type": "queue-operation", "operation": "remove", "timestamp": ts, "sessionId": "s", "content": t, "reason": "consumed"}]
def bloqueante(tid, ts, resultado):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": resultado}]}]}}
def reg(ts, tipo, modelo=None):
    return {"ts": ts, "advisor": tipo, "model": modelo, "repo": "/r", "story": "X.Y"}
def vuelta(ts, n):
    return {"ts": ts, "event": "step5-start", "expected": [], "mode": "advisors", "iter": n}
'

correr() { OUT="$(node "${MEDIDOR}" "$@" 2>&1)"; RC=$?; }
# Lee una expresión python sobre el VOLCADO ya escrito ($1) — `d` es el volcado, `r` su bloque revisores.
leer() { python3 -c "
import json,sys
d=json.load(open('$1')); r=d.get('revisores') or {}
v=$2
print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
" 2>/dev/null; }

COMUNES=(--projects-dir "${PROJ}" --runs-dir "${RUNS}" --assumption "${SUPUESTO}" --today "${HOY}")

# ══════════════════════════════════════════════════════════════════════════════════════════════
# LO MEDIDO
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T1 (AC1) · cuenta por tipo, por modelo y por vuelta desde el registro ────────────────────────
S=sesion-t1
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"),
    vuelta("2026-09-01T10:05:00.000Z", 1),
    reg("2026-09-01T10:06:00.000Z", "tycon-plugin-security-basics", "sonnet"),
    reg("2026-09-01T10:06:30.000Z", "tycon-silent-failure-hunter", "sonnet"),
    vuelta("2026-09-01T10:20:00.000Z", 2),
    reg("2026-09-01T10:21:00.000Z", "tycon-plugin-security-basics", "opus"),
]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    lanz("t-val", "2026-09-01T10:00:01.000Z", "tycon-story-validator"), acuse("t-val", "2026-09-01T10:00:02.000Z"),
    notif("t-val", "2026-09-01T10:02:00.000Z", "VAL", 500, 3, 110000),
    lanz("t-sec1", "2026-09-01T10:06:01.000Z", "tycon-plugin-security-basics", "sonnet"), acuse("t-sec1", "2026-09-01T10:06:02.000Z"),
    lanz("t-sil", "2026-09-01T10:06:31.000Z", "tycon-silent-failure-hunter", "sonnet"), acuse("t-sil", "2026-09-01T10:06:32.000Z"),
    notif("t-sil", "2026-09-01T10:09:00.000Z", "SIL", 700, 4, 140000),
    notif("t-sec1", "2026-09-01T10:10:00.000Z", "SEC1", 600, 2, 230000),
    lanz("t-sec2", "2026-09-01T10:21:01.000Z", "tycon-plugin-security-basics", "opus"), acuse("t-sec2", "2026-09-01T10:21:02.000Z"),
    notif("t-sec2", "2026-09-01T10:23:00.000Z", "SEC2", 800, 2, 100000),
]
PY
volcado "${HIST}/t1.json" "${S}" 'null' '{"spawns": 4, "iteraciones": 2}'
correr --run "${HIST}/t1.json" "${COMUNES[@]}" --json
n="$(leer "${HIST}/t1.json" "r.get('lanzamientos')")"
tipos="$(leer "${HIST}/t1.json" "r.get('por_tipo')")"
modelos="$(leer "${HIST}/t1.json" "r.get('por_modelo')")"
vueltas="$(leer "${HIST}/t1.json" "r.get('por_vuelta')")"
if [ "${RC}" -eq 0 ] && [ "${n}" = "4" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_tipo'].get('tycon-plugin-security-basics')")" = "2" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_modelo'].get('sonnet')")" = "2" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_modelo'].get('opus')")" = "1" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_modelo'].get('sin declarar')")" = "1" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_vuelta'].get('0')")" = "1" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_vuelta'].get('1')")" = "2" ] \
   && [ "$(leer "${HIST}/t1.json" "r['por_vuelta'].get('2')")" = "1" ] \
   && [ "$(leer "${HIST}/t1.json" "[x['modelo'] for x in r['detalle'] if x['tipo']=='tycon-plugin-security-basics' and x['vuelta']==2][0]")" = "opus" ]; then
  ok "T1 · 4 lanzamientos: por tipo, por modelo (sonnet 2 · opus 1 · sin declarar 1) y por vuelta (0:1 · 1:2 · 2:1)"
else
  bad "T1 · conteos" "rc=${RC} n=${n} tipos=${tipos} modelos=${modelos} vueltas=${vueltas} (leer el modelo del lanzamiento equivocado cruza los conteos) · ${OUT}"
fi

# ── T2 (AC1) · la duración se empareja por IDENTIFICADOR, no por orden de llegada ────────────────
S=sesion-t2
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:00:02.000Z", "tycon-silent-failure-hunter")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    lanz("toolu_A", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_A", "2026-09-01T10:00:01.000Z"),
    lanz("toolu_B", "2026-09-01T10:00:02.000Z", "tycon-silent-failure-hunter"), acuse("toolu_B", "2026-09-01T10:00:03.000Z"),
    # B vuelve PRIMERO aunque se lanzó después.
    notif("toolu_B", "2026-09-01T10:00:07.000Z", "BB", 1000, 3, 5000),
    notif("toolu_A", "2026-09-01T10:00:09.000Z", "AAAA", 2000, 5, 9000),
]
PY
volcado "${HIST}/t2.json" "${S}" 'null' '{"spawns": 2}'
correr --run "${HIST}/t2.json" "${COMUNES[@]}" --json
dA="$(leer "${HIST}/t2.json" "[x for x in r['detalle'] if x['tipo']=='tycon-story-validator'][0]['duracion_ms']")"
bA="$(leer "${HIST}/t2.json" "[x for x in r['detalle'] if x['tipo']=='tycon-story-validator'][0]['devuelto_bytes']")"
tA="$(leer "${HIST}/t2.json" "[x for x in r['detalle'] if x['tipo']=='tycon-story-validator'][0]['tokens']")"
dB="$(leer "${HIST}/t2.json" "[x for x in r['detalle'] if x['tipo']=='tycon-silent-failure-hunter'][0]['duracion_ms']")"
bB="$(leer "${HIST}/t2.json" "[x for x in r['detalle'] if x['tipo']=='tycon-silent-failure-hunter'][0]['devuelto_bytes']")"
med="$(leer "${HIST}/t2.json" "r['duracion_ms']['mediana']")"
tk="$(leer "${HIST}/t2.json" "r['tokens_medidos']['total']")"
fuente="$(leer "${HIST}/t2.json" "r.get('fuente')")"
if [ "${dA}" = "9000" ] && [ "${bA}" = "4" ] && [ "${tA}" = "2000" ] && [ "${dB}" = "5000" ] && [ "${bB}" = "2" ] \
   && [ "${med}" = "7000" ] && [ "${tk}" = "3000" ] && [ "${fuente}" = "conversacion" ]; then
  ok "T2 · A→9000 ms/4 bytes/2000 tokens · B→5000 ms/2 bytes · mediana 7000 · tokens medidos 3000 · fuente conversación"
else
  bad "T2 · emparejado por identificador" "A=${dA}/${bA}/${tA} B=${dB}/${bB} mediana=${med} tokens=${tk} fuente=${fuente} (por orden de llegada, A y B se cruzan) · ${OUT}"
fi

# ── T2b (AC1/AC3) · la notificación ENCOLADA es un resultado: cuenta una vez, no es «sin resultado» ─
S=sesion-t2b
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [lanz("toolu_Q", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_Q", "2026-09-01T10:00:01.000Z")] \
       + encolada("toolu_Q", "2026-09-01T10:01:30.000Z", "QQQQQ", 1200, 4, 88000)
PY
volcado "${HIST}/t2b.json" "${S}" 'null' '{"spawns": 1}'
correr --run "${HIST}/t2b.json" "${COMUNES[@]}" --json
e="$(leer "${HIST}/t2b.json" "r['detalle'][0]['estado']")"; d="$(leer "${HIST}/t2b.json" "r['detalle'][0]['duracion_ms']")"; b="$(leer "${HIST}/t2b.json" "r['detalle'][0]['devuelto_bytes']")"
tk="$(leer "${HIST}/t2b.json" "r['detalle'][0]['tokens']")"; f="$(leer "${HIST}/t2b.json" "r['detalle'][0]['resultado_fuente']")"; sr="$(leer "${HIST}/t2b.json" "r['sin_resultado']")"; cr="$(leer "${HIST}/t2b.json" "r['con_resultado']")"
if [ "${e}" = "medido" ] && [ "${d}" = "88000" ] && [ "${b}" = "5" ] && [ "${tk}" = "1200" ] && [ "${f}" = "notificacion_encolada" ] && [ "${sr}" = "0" ] && [ "${cr}" = "1" ]; then
  ok "T2b · notificación sólo encolada (queue-operation + attachment, sin línea user): medida una vez (88000 ms, 5 bytes, 1200 tokens), sin_resultado=0"
else
  bad "T2b · notificación encolada" "estado=${e} dur=${d} bytes=${b} tokens=${tk} fuente=${f} sin_resultado=${sr} con_resultado=${cr} (leer sólo los mensajes user daba 769 «sin resultado» de 1930 reales) · ${OUT}"
fi

# ── T3c (AC2) · el hilo que guarda tokens-digest CONSERVA la notificación encolada ─────────────────
S=sesion-t3c
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
u = {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
lineas = [{"type": "assistant", "timestamp": "2026-09-01T09:59:00.000Z", "message": {"id": "m-0", "model": "modelo-a", "role": "assistant", "usage": u, "content": [{"type": "text", "text": "x"}]}},
          lanz("toolu_E", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_E", "2026-09-01T10:00:01.000Z"),
          {"type": "attachment", "timestamp": "2026-09-01T10:00:02.000Z", "contenido": "B" * 40000}] \
       + encolada("toolu_E", "2026-09-01T10:01:00.000Z", "EEE", 700, 2, 50000)
PY
volcado "${HIST}/t3c.json" "${S}" 'null' '{"spawns": 1}'
node "${DIGEST}" --run "${HIST}/t3c.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" >/dev/null 2>&1
rm -f "${PROJ}/carpeta-cualquiera/${S}.jsonl"
correr --run "${HIST}/t3c.json" "${COMUNES[@]}" --json
f="$(leer "${HIST}/t3c.json" "r.get('fuente')")"; tk="$(leer "${HIST}/t3c.json" "(r.get('tokens_medidos') or {}).get('total')")"
relleno="$(gzip -dc "${HIST}/t3c.hilo.jsonl.gz" | grep -c 'BBBBBBBBBB')"
if [ "${f}" = "hilo_guardado" ] && [ "${tk}" = "700" ] && [ "${relleno}" = "0" ]; then
  ok "T3c · con la conversación borrada, el hilo guardado conserva la notificación encolada (700 tokens) y sigue sin adjuntos"
else
  bad "T3c · hilo con la encolada" "fuente=${f} tokens=${tk} relleno_en_hilo=${relleno} (descartar todo queue-operation pierde el único resultado de ese revisor) · ${OUT}"
fi

# ── T2c (AC1) · un adjunto que NO es queued_command no cuenta como notificación ─────────────────
S=sesion-t2c
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [lanz("toolu_Z", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_Z", "2026-09-01T10:00:01.000Z"),
          {"type": "attachment", "timestamp": "2026-09-01T10:00:30.000Z", "attachment": {"type": "otro_adjunto", "prompt": notif_txt("toolu_Z", "FALSA", 999, 1, 1000)}}]
PY
volcado "${HIST}/t2c.json" "${S}" 'null' '{"spawns": 1}'
correr --run "${HIST}/t2c.json" "${COMUNES[@]}" --json
e="$(leer "${HIST}/t2c.json" "r['detalle'][0]['estado']")"; sr="$(leer "${HIST}/t2c.json" "r['sin_resultado']")"
if [ "${e}" = "sin_resultado" ] && [ "${sr}" = "1" ]; then
  ok "T2c · un attachment sin type=queued_command no cuenta: el revisor queda sin_resultado"
else
  bad "T2c · adjunto ajeno" "estado=${e} sin_resultado=${sr} (sin verificar el tipo, cualquier adjunto con texto parecido cuenta como resultado) · ${OUT}"
fi

# ── T13 (AC1) · un informe que contiene «</result>» y un «<usage>» de ejemplo NO rompe el parseo ──
S=sesion-t13
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
informe = "El fixture es </result> y despues <usage><subagent_tokens>1</subagent_tokens></usage> fin"
lineas = [lanz("toolu_R", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_R", "2026-09-01T10:00:01.000Z"),
          notif("toolu_R", "2026-09-01T10:01:00.000Z", informe, 5000, 2, 30000)]
PY
volcado "${HIST}/t13.json" "${S}" 'null' '{"spawns": 1}'
correr --run "${HIST}/t13.json" "${COMUNES[@]}" --json
b="$(leer "${HIST}/t13.json" "r['detalle'][0]['devuelto_bytes']")"; tk="$(leer "${HIST}/t13.json" "r['detalle'][0]['tokens']")"; d="$(leer "${HIST}/t13.json" "r['detalle'][0]['duracion_ms']")"
esperado="$(python3 -c "print(len('El fixture es </result> y despues <usage><subagent_tokens>1</subagent_tokens></usage> fin'.encode()))")"
if [ "${b}" = "${esperado}" ] && [ "${tk}" = "5000" ] && [ "${d}" = "30000" ]; then
  ok "T13 · informe con «</result>» y «<usage>» adentro: tamaño entero (${esperado} bytes), tokens 5000 (los reales, no el ejemplo)"
else
  bad "T13 · texto libre del informe" "bytes=${b} (esperaba ${esperado}) tokens=${tk} (esperaba 5000) dur=${d} (la regex perezosa truncaba y el primer <usage> era el del ejemplo) · ${OUT}"
fi

# ── T14 (AC1) · emparejado de cardinalidad máxima: nadie queda sin ubicar si hay pareja válida ────
S=sesion-t14
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:01:50.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
# c_x está a 20 s de r1 y a 90 s de r2 (pareja de los dos); c_y está a 115 s de r1 y a 225 s de r2 (sólo de r1).
# Greedy: r1 se lleva c_x (la más cercana) y r2 queda sin pareja. Óptimo: r1→c_y, r2→c_x.
lineas = [lanz("c_y", "2026-09-01T09:58:05.000Z", "tycon-story-validator"), acuse("c_y", "2026-09-01T09:58:06.000Z"),
          lanz("c_x", "2026-09-01T10:00:20.000Z", "tycon-story-validator"), acuse("c_x", "2026-09-01T10:00:21.000Z"),
          notif("c_y", "2026-09-01T09:59:00.000Z", "Y", 100, 1, 1000), notif("c_x", "2026-09-01T10:02:00.000Z", "XX", 200, 1, 2000)]
PY
volcado "${HIST}/t14.json" "${S}" 'null' '{"spawns": 2}'
correr --run "${HIST}/t14.json" "${COMUNES[@]}" --json
nu="$(leer "${HIST}/t14.json" "r['no_ubicados']")"; cr="$(leer "${HIST}/t14.json" "r['con_resultado']")"; tk="$(leer "${HIST}/t14.json" "r['tokens_medidos']['total']")"
if [ "${nu}" = "0" ] && [ "${cr}" = "2" ] && [ "${tk}" = "300" ]; then
  ok "T14 · los dos lanzamientos ubicados (0 sin ubicar, 300 tokens): el emparejado no deja a r2 sin su única pareja"
else
  bad "T14 · emparejado óptimo" "no_ubicados=${nu} con_resultado=${cr} tokens=${tk} (el greedy le roba a r2 su única pareja → 1 sin ubicar) · ${OUT}"
fi

# ── T12 (AC1/AC3) · lo que la conversación muestra y el registro no tiene ENTRA al padrón ─────────
S=sesion-t12
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [lanz("t-a", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("t-a", "2026-09-01T10:00:01.000Z"),
          lanz("t-b", "2026-09-01T10:00:02.000Z", "tycon-silent-failure-hunter", "sonnet"), acuse("t-b", "2026-09-01T10:00:03.000Z"),
          notif("t-a", "2026-09-01T10:01:00.000Z", "A", 1000, 1, 60000), notif("t-b", "2026-09-01T10:01:30.000Z", "B", 2000, 1, 88000)]
PY
volcado "${HIST}/t12.json" "${S}" 'null' '{"spawns": 1}'
correr --run "${HIST}/t12.json" "${COMUNES[@]}" --json
n="$(leer "${HIST}/t12.json" "r['lanzamientos']")"; fr="$(leer "${HIST}/t12.json" "r['fuera_del_registro']")"; tk="$(leer "${HIST}/t12.json" "r['tokens_medidos']['total']")"
vs="$(leer "${HIST}/t12.json" "r['por_vuelta'].get('sin registro')")"; fl="$(leer "${HIST}/t12.json" "r['fuente_lanzamientos']")"
er="$(leer "${HIST}/t12.json" "[x['en_registro'] for x in r['detalle'] if x['tipo']=='tycon-silent-failure-hunter'][0]")"
if [ "${n}" = "2" ] && [ "${fr}" = "1" ] && [ "${tk}" = "3000" ] && [ "${vs}" = "1" ] && [ "${fl}" = "registro+conversacion" ] && [ "${er}" = "false" ]; then
  ok "T12 · el revisor que el registro no anotó entra al padrón (2 lanzamientos, 3000 tokens, 1 fuera del registro, vuelta «sin registro»)"
else
  bad "T12 · fuera del registro" "lanzamientos=${n} fuera=${fr} tokens=${tk} sin_registro=${vs} fuente=${fl} en_registro=${er} (sólo contarlo lo dejaba fuera de TODOS los totales) · ${OUT}"
fi

# ── T3 (AC2) · sin conversación ni hilo NO es cero: el conteo igual se publica ──────────────────
S=sesion-t3
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:00:02.000Z", "tycon-silent-failure-hunter", "sonnet")]
PY
volcado "${HIST}/t3.json" "${S}" 'null' '{"spawns": 2}'
correr --run "${HIST}/t3.json" "${COMUNES[@]}" --json
est="$(leer "${HIST}/t3.json" "r.get('estado')")"; mot="$(leer "${HIST}/t3.json" "r.get('motivo')")"
n="$(leer "${HIST}/t3.json" "r.get('lanzamientos')")"; ntipos="$(leer "${HIST}/t3.json" "len(r.get('por_tipo') or {})")"
dEst="$(leer "${HIST}/t3.json" "r['duracion_ms'].get('estado')")"; dMed="$(leer "${HIST}/t3.json" "'mediana' in r['duracion_ms']")"
tEst="$(leer "${HIST}/t3.json" "r['tokens_medidos'].get('estado')")"
cub="$(leer "${HIST}/t3.json" "r['estimado'].get('lanzamientos_cubiertos')")"
if [ "${RC}" -eq 0 ] && [ "${est}" = "borrada" ] && [ -n "${mot}" ] && [ "${n}" = "2" ] && [ "${ntipos}" = "2" ] \
   && [ "${dEst}" = "no_medido" ] && [ "${dMed}" = "false" ] && [ "${tEst}" = "no_medido" ] && [ "${cub}" = "2" ]; then
  ok "T3 · sin conversación: estado borrada con motivo, 2 lanzamientos con sus tipos, duración/tokens no_medido sin cifra, estimado cubre 2"
else
  bad "T3 · ausencia ≠ cero" "rc=${RC} estado=${est} n=${n} tipos=${ntipos} dur=${dEst}/mediana:${dMed} tokens=${tEst} cubiertos=${cub} (devolver 0 hace leer un cero donde hubo ausencia) · ${OUT}"
fi

# ── T3b (AC2) · el hilo guardado por la 2.13 es fuente válida cuando la conversación ya no está ──
S=sesion-t3b
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
volcado "${HIST}/t3b.json" "${S}" 'null' '{"spawns": 1}'
jsonl_gz "${HIST}/t3b.hilo.jsonl.gz" <<PY
${LADRILLOS}
lineas = [lanz("toolu_H", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("toolu_H", "2026-09-01T10:00:01.000Z"),
          notif("toolu_H", "2026-09-01T10:01:00.000Z", "HHH", 1500, 2, 42000)]
PY
correr --run "${HIST}/t3b.json" "${COMUNES[@]}" --json
fuente="$(leer "${HIST}/t3b.json" "r.get('fuente')")"; d="$(leer "${HIST}/t3b.json" "r['detalle'][0]['duracion_ms']")"; tk="$(leer "${HIST}/t3b.json" "r['tokens_medidos']['total']")"
if [ "${fuente}" = "hilo_guardado" ] && [ "${d}" = "42000" ] && [ "${tk}" = "1500" ]; then
  ok "T3b · sin conversación viva, el hilo guardado mide igual (fuente hilo_guardado, 42000 ms, 1500 tokens)"
else
  bad "T3b · hilo guardado" "fuente=${fuente} dur=${d} tokens=${tk} (exigir la transcripción viva deja inútil lo que rescató la 2.13) · ${OUT}"
fi

# ── T4 (AC3) · un revisor que no volvió es `sin_resultado`, no duración 0 ───────────────────────
S=sesion-t4
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:00:01.000Z", "tycon-silent-failure-hunter"),
          reg("2026-09-01T10:00:02.000Z", "tycon-plugin-security-basics")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    lanz("t-1", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("t-1", "2026-09-01T10:00:00.500Z"),
    lanz("t-2", "2026-09-01T10:00:01.000Z", "tycon-silent-failure-hunter"), acuse("t-2", "2026-09-01T10:00:01.500Z"),
    lanz("t-3", "2026-09-01T10:00:02.000Z", "tycon-plugin-security-basics"), acuse("t-3", "2026-09-01T10:00:02.500Z"),
    notif("t-1", "2026-09-01T10:00:05.000Z", "uno", 100, 1, 4000),
    notif("t-3", "2026-09-01T10:00:09.000Z", "tres", 300, 1, 6000),
]
PY
volcado "${HIST}/t4.json" "${S}" 'null' '{"spawns": 3}'
correr --run "${HIST}/t4.json" "${COMUNES[@]}" --json
sr="$(leer "${HIST}/t4.json" "r.get('sin_resultado')")"; nn="$(leer "${HIST}/t4.json" "r['duracion_ms']['n']")"; med="$(leer "${HIST}/t4.json" "r['duracion_ms']['mediana']")"
e2="$(leer "${HIST}/t4.json" "[x for x in r['detalle'] if x['tipo']=='tycon-silent-failure-hunter'][0]['estado']")"
d2="$(leer "${HIST}/t4.json" "[x for x in r['detalle'] if x['tipo']=='tycon-silent-failure-hunter'][0].get('duracion_ms')")"
if [ "${sr}" = "1" ] && [ "${nn}" = "2" ] && [ "${med}" = "5000" ] && [ "${e2}" = "sin_resultado" ] && [ "${d2}" = "null" ]; then
  ok "T4 · 3 lanzados, 2 volvieron: sin_resultado=1, mediana 5000 sobre n=2, el que no volvió sin duración"
else
  bad "T4 · el que no volvió" "sin_resultado=${sr} n=${nn} mediana=${med} estado=${e2} dur=${d2} (tratarlo como 0 ms da mediana 4000 y miente) · ${OUT}"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# LO ESTIMADO
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T5 (AC4) · el estimado va aparte y NUNCA se suma a lo medido ────────────────────────────────
S=sesion-t5
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:00:01.000Z", "tycon-silent-failure-hunter"),
          reg("2026-09-01T10:00:02.000Z", "tycon-plugin-security-basics")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    lanz("t-1", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("t-1", "2026-09-01T10:00:00.500Z"),
    lanz("t-2", "2026-09-01T10:00:01.000Z", "tycon-silent-failure-hunter"), acuse("t-2", "2026-09-01T10:00:01.500Z"),
    # El tercero fue BLOQUEANTE: el informe vuelve en el tool_result, sin bloque de uso → sin tokens medidos.
    lanz("t-3", "2026-09-01T10:00:02.000Z", "tycon-plugin-security-basics"),
    bloqueante("t-3", "2026-09-01T10:00:08.000Z", "informe del bloqueante"),
    notif("t-1", "2026-09-01T10:00:05.000Z", "uno", 1000, 1, 4000),
    notif("t-2", "2026-09-01T10:00:09.000Z", "dos", 2000, 1, 6000),
]
PY
CONSUMO='{"estado": "medido", "respuestas": 10, "tokens": {"in": 100, "out": 50, "cache_new": 7, "cache_read": 900}, "por_modelo": {}, "por_paso": {}, "fuera_de_ventana": 0, "hilo_hasta": "2026-09-01T10:30:00.000Z", "medido_en": "2026-09-02T00:00:00.000Z"}'
volcado "${HIST}/t5.json" "${S}" "${CONSUMO}" '{"spawns": 3}'
correr --run "${HIST}/t5.json" "${COMUNES[@]}" --json
cIn="$(leer "${HIST}/t5.json" "d['consumo']['tokens']['in']")"; cOut="$(leer "${HIST}/t5.json" "d['consumo']['tokens']['out']")"
tk="$(leer "${HIST}/t5.json" "r['tokens_medidos']['total']")"; tn="$(leer "${HIST}/t5.json" "r['tokens_medidos']['n']")"
cub="$(leer "${HIST}/t5.json" "r['estimado']['lanzamientos_cubiertos']")"; emin="$(leer "${HIST}/t5.json" "r['estimado']['tokens_min']")"; emax="$(leer "${HIST}/t5.json" "r['estimado']['tokens_max']")"
eest="$(leer "${HIST}/t5.json" "r['estimado']['estado']")"; d3="$(leer "${HIST}/t5.json" "[x for x in r['detalle'] if x['tipo']=='tycon-plugin-security-basics'][0]['duracion_ms']")"
t3="$(leer "${HIST}/t5.json" "[x for x in r['detalle'] if x['tipo']=='tycon-plugin-security-basics'][0].get('tokens')")"
if [ "${RC}" -eq 0 ] && [ "${cIn}" = "100" ] && [ "${cOut}" = "50" ] && [ "${tk}" = "3000" ] && [ "${tn}" = "2" ] \
   && [ "${eest}" = "estimado" ] && [ "${cub}" = "1" ] && [ "${emin}" = "60000" ] && [ "${emax}" = "100000" ] && [ "${d3}" = "6000" ] && [ "${t3}" = "null" ]; then
  ok "T5 · consumo del hilo intacto (100/50) · tokens medidos 3000 (n=2) · estimado aparte: 1 lanzamiento, 60000–100000 · el bloqueante tiene duración (6000) y no tokens"
else
  bad "T5 · separación medido/estimado" "rc=${RC} consumo=${cIn}/${cOut} medidos=${tk}/${tn} estimado=${eest}/${cub}/${emin}-${emax} bloqueante=${d3}/${t3} · ${OUT}"
fi
# El chequeo de separación: pasa sobre lo escrito, y FALLA sobre una copia con el estimado sumado al consumo.
sep="$(node -e "
const m = require('${MEDIDOR}'); const fs = require('fs');
const d = JSON.parse(fs.readFileSync('${HIST}/t5.json', 'utf8'));
const a = m.verificarSeparacion(d).ok;
const roto = JSON.parse(JSON.stringify(d)); roto.consumo.tokens.in += roto.revisores.estimado.tokens_max;
const b = m.verificarSeparacion(roto).ok;
const roto2 = JSON.parse(JSON.stringify(d)); roto2.revisores.tokens_medidos.total += roto2.revisores.estimado.tokens_min;
const c = m.verificarSeparacion(roto2).ok;
console.log(a + '|' + b + '|' + c);
" 2>&1)"
if [ "${sep}" = "true|false|false" ]; then
  ok "T5 · verificarSeparacion: pasa sobre lo escrito, falla con el estimado sumado al consumo y falla con el estimado sumado a los tokens medidos"
else
  bad "T5 · verificarSeparacion" "esperaba true|false|false, salió ${sep}"
fi

# ── T5b (AC4) · sin huella del consumo (se midió antes de que existiera) el chequeo NO pasa en silencio ─
sep2="$(node -e "
const m = require('${MEDIDOR}'); const fs = require('fs');
const d = JSON.parse(fs.readFileSync('${HIST}/t5.json', 'utf8'));
d.revisores.consumo_visto = null;                       // se midió cuando no había consumo…
d.consumo.tokens.in += d.revisores.estimado.tokens_max; // …y después alguien sumó el estimado al consumo
const r = m.verificarSeparacion(d);
console.log(r.ok + '|' + (r.motivos.join(' ').includes('re-medir')));
" 2>&1)"
if [ "${sep2}" = "false|true" ]; then
  ok "T5b · con consumo presente y sin huella, verificarSeparacion falla y pide re-medir"
else
  bad "T5b · huella ausente" "esperaba false|true, salió ${sep2} (saltear el chequeo dejaba pasar exactamente la contaminación que existe para atrapar)"
fi

# ── T6 (AC5) · supuesto vencido → el estimado sale no_medido con el motivo; lo medido no cambia ──
correr --run "${HIST}/t5.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --assumption "${SUPUESTO}" --today "2027-01-15" --json
eest="$(leer "${HIST}/t5.json" "r['estimado']['estado']")"; emot="$(leer "${HIST}/t5.json" "r['estimado'].get('motivo')")"
emin="$(leer "${HIST}/t5.json" "'tokens_min' in r['estimado']")"; tk="$(leer "${HIST}/t5.json" "r['tokens_medidos']['total']")"
sm="$(leer "${HIST}/t5.json" "r['estimado'].get('lanzamientos_sin_medir')")"
if [ "${RC}" -eq 0 ] && [ "${eest}" = "no_medido" ] && echo "${emot}" | grep -q "2026-12-31" && [ "${emin}" = "false" ] && [ "${tk}" = "3000" ] && [ "${sm}" = "1" ]; then
  ok "T6 · con el supuesto vencido: estimado no_medido con la fecha, sin cifra, 1 lanzamiento sin medir declarado; los 3000 medidos siguen"
else
  bad "T6 · supuesto vencido" "rc=${RC} estado=${eest} motivo=${emot} tiene_min=${emin} medidos=${tk} sin_medir=${sm} (ignorar la fecha sigue publicando el número viejo) · ${OUT}"
fi
# Y un supuesto ilegible tampoco es cero.
echo '{ esto no es json' > "${TMP}/roto.json"
correr --run "${HIST}/t5.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --assumption "${TMP}/roto.json" --today "${HOY}" --json
eest="$(leer "${HIST}/t5.json" "r['estimado']['estado']")"; emin="$(leer "${HIST}/t5.json" "'tokens_min' in r['estimado']")"
if [ "${eest}" = "no_medido" ] && [ "${emin}" = "false" ]; then
  ok "T6b · supuesto ilegible → estimado no_medido, sin cifra"
else
  bad "T6b · supuesto ilegible" "estado=${eest} tiene_min=${emin} · ${OUT}"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# LA VISTA Y EL BARRIDO
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T7 (AC6) · la vista de corridas separa lo medido de lo estimado ──────────────────────────────
# Corre el cliente REAL de la página sobre un DOM mínimo (misma técnica que dashboard-runs.test.sh).
CL="${TMP}/cliente.js"
cat > "${CL}" <<'JS'
const fs = require('fs');
const [html, arg] = [fs.readFileSync(process.argv[2], 'utf8'), process.argv[3]];
const modelo = (html.match(/<script id="modelo" type="application\/json">([\s\S]*?)<\/script>/) || [])[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!modelo || !scripts.length) { console.error('la página no trae modelo o cliente'); process.exit(2); }
const nodos = {};
const el = () => ({ innerHTML: '', textContent: '', value: '', checked: false, min: '', max: '', hidden: false, rows: [],
  addEventListener() {}, set onclick(f) {}, querySelectorAll: () => [], querySelector: () => el(), classList: { add() {}, remove() {}, contains: () => false } });
global.window = global; global.window.parent = global.window;
global.location = { search: '', hash: '' };
global.document = { addEventListener() {}, querySelectorAll: () => [], createElement: () => el(),
  getElementById: (id) => id === 'modelo' ? { textContent: modelo } : (nodos[id] = nodos[id] || el()) };
eval(scripts[scripts.length - 1]);
const M = JSON.parse(modelo);
console.log(window.__detalle(M.corridas[Number(arg)]));
JS
RDIR="${TMP}/runs-vista"; mkdir -p "${RDIR}"
# Corrida 1: medida en parte (2 con tokens, 1 estimado). Corrida 2: sin bloque de revisores.
python3 - "${RDIR}" <<'PY'
import json, sys
d = sys.argv[1]
base = lambda sid, t, ini: {'archivedAt': t, 'marker': {'storyId': '2.1', 'sessionId': sid, 'startedAt': ini, 'lastTouch': ini.replace('09:50', '11:00'),
    'stepsCompleted': [0,1,2,3,4,5,6,7,8], 'stepTimings': {'4': {'completedAt': '2026-09-01T10:00:00.000Z'}}, 'repoPath': '/Users/dev/SourceCode/Totora/FrontEnd'},
    'gates': [], 'costo': {'spawns': 3, 'iteraciones': 1, 'por_tipo': {'tycon-story-validator': 1, 'tycon-silent-failure-hunter': 1, 'tycon-plugin-security-basics': 1}}}
a = base('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-01T12:00:00.000Z', '2026-09-01T09:50:00.000Z')
a['revisores'] = {'estado': 'medido', 'fuente': 'conversacion', 'fuente_lanzamientos': 'registro', 'medido_en': '2026-09-02T00:00:00.000Z',
  'lanzamientos': 3, 'por_tipo': {'tycon-story-validator': 1, 'tycon-silent-failure-hunter': 1, 'tycon-plugin-security-basics': 1},
  'por_modelo': {'sin declarar': 3}, 'por_vuelta': {'0': 1, '1': 2}, 'con_resultado': 3, 'sin_resultado': 0, 'no_ubicados': 0, 'fuera_del_registro': 0, 'con_tokens': 2,
  'duracion_ms': {'mediana': 6000, 'total': 16000, 'n': 3}, 'devuelto_bytes': {'mediana': 3, 'total': 9, 'n': 3},
  'tokens_medidos': {'total': 3000, 'n': 2},
  'detalle': [{'tipo': 'tycon-story-validator', 'modelo': None, 'vuelta': 0, 'estado': 'medido', 'duracion_ms': 4000, 'devuelto_bytes': 3, 'tokens': 1000, 'tool_uses': 1, 'resultado_fuente': 'notificacion'}],
  'estimado': {'estado': 'estimado', 'lanzamientos_cubiertos': 1, 'tokens_min': 60000, 'tokens_max': 100000,
               'supuesto': {'rango_tokens_por_lanzamiento': [60000, 100000], 'medido_el': '2026-07-28', 'revisar_antes_de': '2026-12-31', 'fuente': 'BASELINE FUGA_RUTA /Users/dev/x'}},
  'consumo_visto': None}
json.dump(a, open(d + '/a.json', 'w'), indent=1)
b = base('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-02T12:00:00.000Z', '2026-09-02T09:50:00.000Z')
json.dump(b, open(d + '/b.json', 'w'), indent=1)
PY
node "${TABLERO}" --view runs --runs-dir "${RDIR}" --output "${TMP}/vista.html" >"${TMP}/vista.log" 2>&1; RCV=$?
if [ "${RCV}" -ne 0 ] || [ ! -f "${TMP}/vista.html" ]; then
  bad "T7 · la vista no se generó" "rc=${RCV} · $(cat "${TMP}/vista.log")"
else
  # Las corridas se ordenan de la más nueva a la más vieja por hora de inicio: b (02-09, sin revisores) es la 0, a (01-09) es la 1.
  DA="$(node "${CL}" "${TMP}/vista.html" 1 2>&1)"; DB="$(node "${CL}" "${TMP}/vista.html" 0 2>&1)"
  if echo "${DA}" | grep -q 'class="rev-med"' && echo "${DA}" | grep -q '3 k' && echo "${DA}" | grep -q 'class="rev-est"' && echo "${DA}" | grep -qi 'estimado' \
     && echo "${DA}" | grep -q '60 k' && echo "${DA}" | grep -q '100 k'; then
    ok "T7 · el detalle muestra 3 k tokens con la marca de medido y «estimado 60 k–100 k» con la marca de estimado"
  else
    bad "T7 · marcas distintas" "pintar el estimado igual que lo medido falla acá · detalle=$(echo "${DA}" | head -c 600)"
  fi
  echo "${DA}" | grep -q 'n=2 de 3' && ok "T7 · el denominador de los tokens medidos está al lado (n=2 de 3)" || bad "T7 · sin denominador" "$(echo "${DA}" | head -c 400)"
  if echo "${DB}" | grep -qi 'sin medir' && ! echo "${DB}" | grep -q '0 tokens'; then
    ok "T7 · la corrida sin bloque de revisores dice «sin medir», no cero"
  else
    bad "T7 · ausencia ≠ cero en la vista" "$(echo "${DB}" | head -c 400)"
  fi
  grep -q 'Lo que se mide de un revisor' "${TMP}/vista.html" && ok "T7 · el pie explica qué se mide de un revisor" || bad "T7 · pie" "falta «Lo que se mide de un revisor»"
  # T7b · los tres avisos de discrepancia se dibujan cuando corresponde
  RDIR2="${TMP}/runs-vista2"; mkdir -p "${RDIR2}"
  python3 - "${RDIR2}" <<'PY2'
import json, sys
d = sys.argv[1]
c = {'archivedAt': '2026-09-03T12:00:00.000Z', 'marker': {'storyId': '2.2', 'sessionId': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'startedAt': '2026-09-03T09:50:00.000Z', 'lastTouch': '2026-09-03T11:00:00.000Z',
    'stepsCompleted': [0,1,2,3,4,5,6,7,8], 'stepTimings': {'4': {'completedAt': '2026-09-03T10:00:00.000Z'}}, 'repoPath': '/Users/dev/SourceCode/Totora/FrontEnd'},
    'gates': [], 'costo': {'spawns': 3, 'iteraciones': 1, 'por_tipo': {'tycon-story-validator': 3}},
    'revisores': {'estado': 'parcial', 'fuente': 'conversacion', 'fuente_lanzamientos': 'registro+conversacion', 'lanzamientos': 5, 'con_resultado': 3, 'sin_resultado': 1, 'no_ubicados': 1, 'fuera_del_registro': 2, 'con_tokens': 3,
      'duracion_ms': {'mediana': 5000, 'total': 15000, 'n': 3}, 'devuelto_bytes': {'mediana': 10, 'total': 30, 'n': 3}, 'tokens_medidos': {'total': 9000, 'n': 3},
      'estimado': {'estado': 'estimado', 'lanzamientos_cubiertos': 2, 'tokens_min': 120000, 'tokens_max': 200000, 'supuesto': {'medido_el': '2026-07-28', 'revisar_antes_de': '2026-12-31'}}, 'consumo_visto': None}}
json.dump(c, open(d + '/c.json', 'w'), indent=1)
PY2
  node "${TABLERO}" --view runs --runs-dir "${RDIR2}" --output "${TMP}/vista2.html" >/dev/null 2>&1
  DC="$(node "${CL}" "${TMP}/vista2.html" 0 2>&1)"
  if echo "${DC}" | grep -q '5 lanzamientos vistos en la conversación; el archivador contó 3' && echo "${DC}" | grep -q '1 sin ubicar en la conversación' \
     && echo "${DC}" | grep -q '2 vistos en la conversación que el registro no anotó' && echo "${DC}" | grep -q '1 no volvieron'; then
    ok "T7b · la vista avisa los dos padrones distintos (5 vs 3), 1 sin ubicar, 2 fuera del registro y 1 que no volvió"
  else
    bad "T7b · avisos de discrepancia" "$(echo "${DC}" | grep -o 'class="rev-nd"[^<]*' | head -5)"
  fi
  grep -q 'FUGA_RUTA' "${TMP}/vista.html" && bad "T7 · fuga" "la fuente del supuesto (ruta) llegó a la página" || ok "T7 · la ruta del supuesto no llega a la página"
fi

# ── T9 (AC1, encadenado) · el barrido de tokens-digest llama al medidor ──────────────────────────
S=sesion-t9
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
u = {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
lineas = [
    {"type": "assistant", "timestamp": "2026-09-01T09:59:00.000Z", "message": {"id": "m-0", "model": "modelo-a", "role": "assistant", "usage": u, "content": [{"type": "text", "text": "x"}]}},
    lanz("t-9", "2026-09-01T10:00:00.000Z", "tycon-story-validator"), acuse("t-9", "2026-09-01T10:00:01.000Z"),
    notif("t-9", "2026-09-01T10:01:00.000Z", "nueve", 900, 1, 60000),
]
PY
HIST9="${TMP}/history9"; mkdir -p "${HIST9}"
volcado "${HIST9}/t9.json" "${S}" 'null' '{"spawns": 1}'
OUT="$(node "${DIGEST}" --all --history-dir "${HIST9}" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --json 2>&1)"; RC=$?
cEst="$(leer "${HIST9}/t9.json" "d['consumo']['estado']")"; rEst="$(leer "${HIST9}/t9.json" "r.get('estado')")"; rTk="$(leer "${HIST9}/t9.json" "(r.get('tokens_medidos') or {}).get('total')")"
if [ "${RC}" -eq 0 ] && [ "${cEst}" = "medido" ] && [ "${rEst}" = "medido" ] && [ "${rTk}" = "900" ]; then
  ok "T9 · una pasada del barrido deja consumo (medido) Y revisores (medido, 900 tokens) en el mismo volcado"
else
  bad "T9 · encadenado" "rc=${RC} consumo=${cEst} revisores=${rEst} tokens=${rTk} (sin encadenar, cada corrida nueva queda sin medir) · ${OUT}"
fi
# Sin el medidor en la ruta canónica (arnés partido), el rescate del hilo se escribe igual y revisores queda con motivo.
# La copia lleva scripts/lib/legacy-names.js (story 8.9: la carga al arrancar y vive siempre al lado); falta sólo el medidor.
SOLO="${TMP}/solo/scripts/metrics"; mkdir -p "${SOLO}" "${TMP}/solo/scripts/lib"; cp "${DIGEST}" "${SOLO}/tokens-digest.js"
cp "${RAIZ}/scripts/lib/legacy-names.js" "${TMP}/solo/scripts/lib/"
volcado "${HIST9}/t9b.json" "${S}" 'null' '{"spawns": 1}'
OUT="$(node "${SOLO}/tokens-digest.js" --run "${HIST9}/t9b.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --json 2>&1)"; RC=$?
cEst="$(leer "${HIST9}/t9b.json" "d['consumo']['estado']")"; rEst="$(leer "${HIST9}/t9b.json" "r.get('estado')")"; rMot="$(leer "${HIST9}/t9b.json" "r.get('motivo')")"
if [ "${RC}" -eq 0 ] && [ "${cEst}" = "medido" ] && [ "${rEst}" = "no_medido" ] && echo "${rMot}" | grep -q "reviewers-cost"; then
  ok "T9b · sin reviewers-cost.js al lado: consumo medido igual, revisores no_medido con el motivo (exit 0)"
else
  bad "T9b · fail-open del encadenado" "rc=${RC} consumo=${cEst} revisores=${rEst} motivo=${rMot} (exigir el medidor rompería el rescate del hilo en un arnés atrasado) · ${OUT}"
fi

# ── T9c (encadenado) · el interruptor TYCON_NO_REVIEWER_COST=1 apaga el medidor CON motivo ──────
volcado "${HIST9}/t9c.json" "${S}" 'null' '{"spawns": 1}'
OUT="$(TYCON_NO_REVIEWER_COST=1 node "${DIGEST}" --run "${HIST9}/t9c.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --json 2>&1)"; RC=$?
cEst="$(leer "${HIST9}/t9c.json" "d['consumo']['estado']")"; rEst="$(leer "${HIST9}/t9c.json" "r.get('estado')")"; rMot="$(leer "${HIST9}/t9c.json" "r.get('motivo')")"
if [ "${RC}" -eq 0 ] && [ "${cEst}" = "medido" ] && [ "${rEst}" = "no_medido" ] && echo "${rMot}" | grep -q "apagado"; then
  ok "T9c · con TYCON_NO_REVIEWER_COST=1: consumo medido igual, revisores no_medido con motivo «apagado»"
else
  bad "T9c · interruptor" "rc=${RC} consumo=${cEst} revisores=${rEst} motivo=${rMot} (un apagado sin motivo se lee igual que un medidor que no existe) · ${OUT}"
fi

# ── T9d (encadenado) · un `revisores` en estado borrada NO se pisa cuando el medidor está apagado ──
S=sesion-t9d
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-01T10:00:00.000Z", "tycon-story-validator"), reg("2026-09-01T10:00:01.000Z", "tycon-silent-failure-hunter")]
PY
volcado "${HIST9}/t9d.json" "${S}" 'null' '{"spawns": 2}'
correr --run "${HIST9}/t9d.json" "${COMUNES[@]}" --json          # sin conversación → borrada con 2 lanzamientos
e0="$(leer "${HIST9}/t9d.json" "r.get('estado')")"
OUT="$(TYCON_NO_REVIEWER_COST=1 node "${DIGEST}" --run "${HIST9}/t9d.json" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --json 2>&1)"; RC=$?
e1="$(leer "${HIST9}/t9d.json" "r.get('estado')")"; n1="$(leer "${HIST9}/t9d.json" "r.get('lanzamientos')")"
if [ "${e0}" = "borrada" ] && [ "${e1}" = "borrada" ] && [ "${n1}" = "2" ]; then
  ok "T9d · el bloque borrada (con sus 2 lanzamientos) sobrevive a un rescate con el medidor apagado"
else
  bad "T9d · borrada pisada" "antes=${e0} después=${e1} lanzamientos=${n1} (el fallback pisaba el estado terminal con un no_medido sin conteos) · ${OUT}"
fi

# ── T9e (encadenado) · si el medidor no pudo ESCRIBIR su bloque, --run de tokens-digest sale ≠ 0 ─
r9e="$(node -e "
const td = require('${DIGEST}');
const orig = td.rescatarCorrida;
// Simula un medidor que midió pero no pudo persistir: se inyecta por el módulo ya cargado.
const m = require('${MEDIDOR}');
const real = m.procesarCorrida;
m.procesarCorrida = (v, o) => ({ volcado: v, revisores: { estado: 'medido', lanzamientos: 1, con_tokens: 1, sin_resultado: 0 }, separacion: { ok: true }, no_persistido: 'no pude escribir el volcado: EACCES' });
const r = td.procesarCorrida('${HIST9}/t9.json', { projectsDir: '${PROJ}', runsDir: '${RUNS}', home: require('os').homedir() });
console.log(String(r.no_persistido || ''));
" 2>&1)"
if echo "${r9e}" | grep -q "revisores: no pude escribir"; then
  ok "T9e · el no_persistido del medidor sube al resultado del rescate (→ --run sale 2)"
else
  bad "T9e · no_persistido perdido" "salió «${r9e}» (el rescate devolvía 0 con el bloque sin escribir)"
fi

# ── T15 (encadenado) · el barrido de tokens-digest DICE qué pasó con los revisores ──────────────────
# HIST9 tiene t9 (medido), t9b (no_medido: sin medidor), t9c (no_medido: apagado) y t9d (borrada).
OUT="$(node "${DIGEST}" --all --history-dir "${HIST9}" --projects-dir "${PROJ}" --runs-dir "${RUNS}" --json 2>&1)"; RC=$?
r15="$(python3 -c "
import json,sys
raw=sys.argv[1]; d=json.loads(raw[raw.find('{'):])
print(d.get('revisores_medidos'), d.get('revisores_no_medidos'), d.get('revisores_separacion_rota'))
" "${OUT}" 2>/dev/null)"
OUTT="$(node "${DIGEST}" --all --history-dir "${HIST9}" --projects-dir "${PROJ}" --runs-dir "${RUNS}" 2>&1)"
# En --all el medidor se vuelve a encadenar sobre los 4: t9, t9b, t9c → medidos ahora (el medidor está y no está apagado); t9d sigue borrada.
if [ "${RC}" -eq 0 ] && [ "${r15}" = "3 1 0" ] && echo "${OUTT}" | grep -q "revisores medidos (story 2.15): 3 · no medidos: 1"; then
  ok "T15 · el barrido de tokens-digest cuenta revisores medidos 3 · no medidos 1 · separación rota 0, en JSON y en texto"
else
  bad "T15 · contadores del barrido" "rc=${RC} json=«${r15}» (esperaba «3 1 0») texto=$(echo "${OUTT}" | grep revisores | head -2) (sin esto una separación rota en el arranque de sesión no se ve en ningún lado)"
fi

# ── T10 (AC1) · la salida en texto plano dice lo mismo que el JSON ─────────────────────────────────
correr --run "${HIST}/t2.json" "${COMUNES[@]}"
if [ "${RC}" -eq 0 ] && echo "${OUT}" | grep -q "2 lanzamientos" && echo "${OUT}" | grep -q "tokens medidos 3000 (n=2 de 2)" && echo "${OUT}" | grep -q "estimado: vacio"; then
  ok "T10 · sin --json: «2 lanzamientos · … tokens medidos 3000 (n=2 de 2) · estimado: vacio …»"
else
  bad "T10 · texto plano" "rc=${RC} salida=${OUT}"
fi
OUT="$(node "${MEDIDOR}" --all --history-dir "${HIST}" "${COMUNES[@]}" 2>&1)"; RC=$?
if [ "${RC}" -eq 0 ] && echo "${OUT}" | grep -q "con duración medida: 10" && echo "${OUT}" | grep -q "revisores que no volvieron: 2"; then
  ok "T10 · el resumen del barrido en texto plano trae los mismos números que el JSON"
else
  bad "T10 · resumen en texto plano" "rc=${RC} salida=${OUT}"
fi

# ── T11 (AC7) · un fallo del PROPIO medidor no se disfraza de «volcado ilegible» ─────────────────
r11="$(node -e "
const m = require('${MEDIDOR}');
const vs = ['/x/a.json', '/x/b.json'];
let n = 0;
const procesar = (v, o) => { n += 1; if (n === 1) throw new Error('forma de dato inesperada'); return { volcado: v, error: 'volcado ilegible: EACCES' }; };
const s = m.barrer(vs, { budgetMs: 60000 }, procesar);
const txt = m.resumenBarrido(s);
console.log([s.fallas_del_medidor, s.no_medidas, s.errores.length, s.errores[0], /EL MEDIDOR FALLÓ/.test(txt), /forma de dato inesperada/.test(txt)].join('|'));
" 2>&1)"
if [ "${r11}" = "1|1|1|a.json: forma de dato inesperada|true|true" ]; then
  ok "T11 · la excepción del medidor se cuenta aparte (fallas_del_medidor=1, con el mensaje) y el resumen la grita; el volcado ilegible sigue en no_medidas"
else
  bad "T11 · fallo propio ≠ volcado ilegible" "salió «${r11}» (tragar la excepción la contaba como «volcado ilegible», tapando un defecto del propio medidor)"
fi

# ── El resumen del barrido propio (AC7): los cuatro números, y salida ≠ 0 si no puede arrancar ──
OUT="$(node "${MEDIDOR}" --all --history-dir "${HIST}" "${COMUNES[@]}" --json 2>&1)"; RC=$?
res="$(python3 -c "
import json,sys
raw=sys.argv[1]; d=json.loads(raw[raw.find('{'):])
print(d.get('total'), d.get('con_duracion_medida'), d.get('con_tokens_medidos'), d.get('solo_estimacion'), d.get('revisores_sin_resultado'))
" "${OUT}" 2>/dev/null)"
if [ "${RC}" -eq 0 ] && [ "${res}" = "12 10 10 2 2" ]; then
  ok "T8-resumen · --all sobre 12 volcados: 10 con duración, 10 con tokens, 2 sólo estimación (t3 y t2c), 2 revisores sin resultado"
else
  bad "T8-resumen · los cuatro números" "rc=${RC} salió «${res}» (esperaba «12 10 10 2 2») · ${OUT}"
fi
OUT="$(node "${MEDIDOR}" --run "${TMP}/no-existe.json" "${COMUNES[@]}" 2>&1)"; RC=$?
[ "${RC}" -eq 2 ] && ok "T8-resumen · --run sobre un volcado inexistente sale 2" || bad "T8-resumen · salida" "esperaba 2, fue ${RC}"

# ── T16 (AC5) · el supuesto REAL del repo es legible, completo y no está vencido ──────────────────
r16="$(python3 -c "
import json,sys,datetime
s=json.load(open('${SUPUESTO_REAL}'))
r=s['tokens_per_launch_range']; ok = len(r)==2 and 0<r[0]<r[1] and bool(s.get('source')) and bool(s.get('measured_on')) and bool(s.get('review_before'))
v=datetime.date.fromisoformat(s['review_before']); m=datetime.date.fromisoformat(s['measured_on'])
print('ok' if ok and v>m else 'mal', r, s['measured_on'], s['review_before'])
" 2>&1)"
case "${r16}" in ok*) ok "T16 · el supuesto real del repo es válido: ${r16#ok }";; *) bad "T16 · supuesto real" "${r16} (un supuesto ilegible o con la fecha al revés deja TODO estimado en no_medido, en silencio hasta la próxima mirada)";; esac
# Y avisa (sin fallar) si ya venció: renovarlo es una decisión, no un rojo de la suite.
python3 -c "
import json,datetime; s=json.load(open('${SUPUESTO_REAL}'))
if datetime.date.today() > datetime.date.fromisoformat(s['review_before']): print('⚠️  el supuesto real venció el', s['review_before'], '— renovarlo: scripts/metrics/reviewers-cost-assumption.json')
"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# STORY 7.3 — el veredicto del validador de stories, por lanzamiento y por fase
# ══════════════════════════════════════════════════════════════════════════════════════════════
# 🔴 En carpetas PROPIAS: `T8-resumen` cuenta los volcados de ${HIST} y no puede moverse con estos casos.
H73="${TMP}/hist-7.3"; mkdir -p "${H73}"
LADRILLOS_73='
def lanzp(tid, ts, tipo, prompt):
    return {"type": "assistant", "timestamp": ts, "message": {"id": "m-" + tid, "role": "assistant",
            "content": [{"type": "tool_use", "id": tid, "name": "Agent", "input": {"description": "x", "subagent_type": tipo, "prompt": prompt}}]}}
AVISO = "This agent'"'"'s report was delivered to you as a message from \"%s\" (its SubagentHandback call). Read it there; it is not repeated here."
def traspaso(agente, ts, informe):
    cuerpo = "\n".join("  " + r for r in informe.split("\n"))
    txt = ("Another Claude session sent a message:\n<agent-message from=\"" + agente + "\">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n"
           + cuerpo + "\n</agent-message>\n\nThat \"other Claude session\" is an agent working inside this same session.\nVeredicto: hallazgos (VAL-C1) · bloquea: sí\n")
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": txt}}
'
volcado73() {
  python3 -c "
import json
d = {'archivedAt': '2026-09-17T00:00:00.000Z',
     'marker': {'storyId': 'X.Y', 'storyPath': '/r/specs/story-X.Y-algo.md', 'sessionId': '$2', 'startedAt': '2026-09-17T09:50:00.000Z',
                'lastTouch': '2026-09-17T11:00:00.000Z', 'stepsCompleted': [0,1,2,3,4,5],
                'stepTimings': {'5': {'startedAt': '2026-09-17T10:05:00.000Z', 'completedAt': '2026-09-17T10:40:00.000Z'}}},
     'gates': [], 'costo': json.loads('''$3''')}
open('$1', 'w', encoding='utf-8').write(json.dumps(d, indent=2))
"
}

# ── 7.3-T3 (AC3) · CostoRevisores_DetalleYResumenPorFase ─────────────────────────────────────────────
# Mutación que lo pone en rojo: fase por la vuelta sin mirar «otra story» (v3 cae en re-loop), el veredicto
# del traspaso leído del aviso (v2 sale sin_veredicto), o los campos nuevos también en otros revisores.
S=sesion-73-t3
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [
    reg("2026-09-17T10:00:00.000Z", "tycon-story-validator"),
    vuelta("2026-09-17T10:05:00.000Z", 1),
    reg("2026-09-17T10:06:00.000Z", "tycon-story-validator"),
    reg("2026-09-17T10:06:30.000Z", "tycon-plugin-security-basics", "sonnet"),
    vuelta("2026-09-17T10:20:00.000Z", 2),
    reg("2026-09-17T10:21:00.000Z", "tycon-story-validator"),
    reg("2026-09-17T10:30:00.000Z", "tycon-story-validator"),
]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
${LADRILLOS_73}
lineas = [
    lanzp("v0", "2026-09-17T10:00:01.000Z", "tycon-story-validator", "Validar la story en /r/specs/story-X.Y-algo.md contra el repo /r."), acuse("v0", "2026-09-17T10:00:02.000Z"),
    notif("v0", "2026-09-17T10:02:00.000Z", "- anclas ok\n\nVeredicto: limpio", 500, 3, 110000),
    lanzp("v1", "2026-09-17T10:06:01.000Z", "tycon-story-validator", "context_file: /h/.claude/.tycon-pipeline/advisor-context/s-iter1-tycon-story-validator.md"), acuse("v1", "2026-09-17T10:06:02.000Z"),
] + encolada("v1", "2026-09-17T10:08:00.000Z", "- la lista de archivos no declara uno\n\nVeredicto: hallazgos (VAL-W15) · bloquea: no", 600, 2, 90000) + [
    lanz("sec", "2026-09-17T10:06:31.000Z", "tycon-plugin-security-basics", "sonnet"), acuse("sec", "2026-09-17T10:06:32.000Z"),
    notif("sec", "2026-09-17T10:07:00.000Z", "Limpio.\nVeredicto: limpio", 700, 1, 50000),
    lanzp("v2", "2026-09-17T10:21:01.000Z", "tycon-story-validator", "Iteración 2 sobre /r/specs/story-X.Y-algo.md"), acuse("v2", "2026-09-17T10:21:02.000Z"),
    notif("v2", "2026-09-17T10:23:00.000Z", AVISO % "t-v2", 900, 2, 70000),
    traspaso("t-v2", "2026-09-17T10:23:01.000Z", "- sin cambios desde la vuelta 1\n\nVeredicto: limpio"),
    lanzp("v3", "2026-09-17T10:30:01.000Z", "tycon-story-validator", "Validá la story /r/specs/story-X.Z-otra.md antes de implementarla."), acuse("v3", "2026-09-17T10:30:02.000Z"),
    notif("v3", "2026-09-17T10:33:00.000Z", "- falta la sección de patrón\n\nVeredicto: hallazgos (VAL-C8) · bloquea: sí", 800, 4, 120000),
]
PY
volcado73 "${H73}/t3.json" "${S}" '{"spawns": 5, "iteraciones": 2}'
correr --run "${H73}/t3.json" "${COMUNES[@]}" --json
det="$(leer "${H73}/t3.json" "[[x.get('vuelta'), x.get('veredicto'), x.get('veredicto_reglas'), x.get('veredicto_bloquea'), x.get('sobre_otra_story')] for x in r['detalle'] if x['tipo']=='tycon-story-validator']")"
det_esp='[[0, "limpio", [], false, false], [1, "hallazgos", ["VAL-W15"], false, null], [2, "limpio", [], false, false], [2, "hallazgos", ["VAL-C8"], true, true]]'
otro="$(leer "${H73}/t3.json" "sorted(k for x in r['detalle'] if x['tipo']!='tycon-story-validator' for k in x if k.startswith('veredicto') or k=='sobre_otra_story')")"
fases="$(leer "${H73}/t3.json" "[r.get('validador',{}).get('estado'), r.get('validador',{}).get('lanzamientos')] + [[f, r['validador']['por_fase'][f]] for f in ['antes-de-implementar','vuelta-1','re-loop','sin-vuelta','otra-story']]")"
fases_esp='["medido", 4, ["antes-de-implementar", {"lanzamientos": 1, "limpio": 1, "hallazgos": 0, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 0}], ["vuelta-1", {"lanzamientos": 1, "limpio": 0, "hallazgos": 1, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 0}], ["re-loop", {"lanzamientos": 1, "limpio": 1, "hallazgos": 0, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 0}], ["sin-vuelta", {"lanzamientos": 0, "limpio": 0, "hallazgos": 0, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 0}], ["otra-story", {"lanzamientos": 1, "limpio": 0, "hallazgos": 1, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 0}]]'
if [ "${RC}" -eq 0 ] && [ "${det}" = "${det_esp}" ] && [ "${otro}" = "[]" ] && [ "${fases}" = "${fases_esp}" ]; then
  ok "7.3-T3 · CostoRevisores_DetalleYResumenPorFase — veredicto por lanzamiento (traspaso y encolada incluidos), otra story aparte, y el resto de los revisores sin campos nuevos"
else
  bad "7.3-T3 · detalle y resumen por fase" "rc=${RC} det=${det} otro=${otro} fases=${fases} · ${OUT}"
fi

# ── 7.3-T4 (AC4) · CostoRevisores_SinConversacion_NoMedido ──────────────────────────────────────────
# Mutación: tratar la ausencia como «sin_veredicto» o, peor, como «limpio».
S=sesion-73-t4a
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [reg("2026-09-17T10:00:00.000Z", "tycon-story-validator"), vuelta("2026-09-17T10:05:00.000Z", 1), reg("2026-09-17T10:06:00.000Z", "tycon-story-validator")]
PY
volcado73 "${H73}/t4a.json" "${S}" '{"spawns": 2, "iteraciones": 1}'
correr --run "${H73}/t4a.json" "${COMUNES[@]}" --json
a="$(leer "${H73}/t4a.json" "[[x.get('veredicto'), x.get('veredicto_reglas'), x.get('veredicto_bloquea')] for x in r['detalle']] + [r.get('validador',{}).get('estado'), bool(r.get('validador',{}).get('motivo')), r['validador']['por_fase']['vuelta-1']['no_medido']]")"
S=sesion-73-t4b
jsonl "${RUNS}/${S}.jsonl" <<PY
${LADRILLOS}
lineas = [vuelta("2026-09-17T10:05:00.000Z", 1), reg("2026-09-17T10:06:00.000Z", "tycon-story-validator")]
PY
jsonl "${PROJ}/carpeta-cualquiera/${S}.jsonl" <<PY
${LADRILLOS}
${LADRILLOS_73}
lineas = [lanzp("w1", "2026-09-17T10:06:01.000Z", "tycon-story-validator", "Re-validá /r/specs/story-X.Y-algo.md"), acuse("w1", "2026-09-17T10:06:02.000Z")]
PY
volcado73 "${H73}/t4b.json" "${S}" '{"spawns": 1, "iteraciones": 1}'
correr --run "${H73}/t4b.json" "${COMUNES[@]}" --json
b="$(leer "${H73}/t4b.json" "[[x.get('estado'), x.get('veredicto')] for x in r['detalle']] + [r.get('validador',{}).get('estado'), r['validador']['por_fase']['vuelta-1']]")"
if [ "${a}" = '[["no_medido", [], null], ["no_medido", [], null], "no_medido", true, 1]' ] \
   && [ "${b}" = '[["sin_resultado", "no_medido"], "medido", {"lanzamientos": 1, "limpio": 0, "hallazgos": 0, "inconsistente": 0, "sin_veredicto": 0, "no_medido": 1}]' ]; then
  ok "7.3-T4 · CostoRevisores_SinConversacion_NoMedido — sin conversación y sin resultado: no_medido con motivo, nunca limpio"
else
  bad "7.3-T4 · no medido" "a=${a} b=${b}"
fi

# ── 7.3-T5 (AC3, AC15) · CostoRevisores_NumerosMedidos_NoCambian ────────────────────────────────────
# Los números del fixture del 7.3-T3 fijados a mano (no contra origin/main: después del merge esa comparación
# se vuelve trivial). Mutación: medir el aviso del traspaso en vez del informe (bytes de v2), o que un
# campo nuevo toque tokens, duración o la separación medido/estimado.
nums="$(leer "${H73}/t3.json" "[r.get('lanzamientos'), r.get('con_resultado'), r.get('tokens_medidos'), r.get('duracion_ms',{}).get('mediana'), r.get('estimado',{}).get('estado')]")"
v2bytes="$(leer "${H73}/t3.json" "[x['devuelto_bytes'] for x in r['detalle'] if x['tipo']=='tycon-story-validator'][2]")"
esp_bytes="$(python3 -c "print(len('- sin cambios desde la vuelta 1\n\nVeredicto: limpio'.encode('utf-8')))")"
if [ "${nums}" = '[5, 5, {"total": 3500, "n": 5}, 90000, "vacio"]' ] && [ "${v2bytes}" = "${esp_bytes}" ]; then
  ok "7.3-T5 · CostoRevisores_NumerosMedidos_NoCambian — 5 lanzamientos, 3500 tokens, mediana 90 s, separación intacta; el traspaso mide su informe (${v2bytes} bytes), no el aviso"
else
  bad "7.3-T5 · números medidos" "nums=${nums} v2bytes=${v2bytes} (esperaba ${esp_bytes})"
fi

echo
if [ "${fallos}" -eq 0 ]; then echo "costo-revisores: todos los casos en verde"; exit 0; fi
echo "costo-revisores: ${fallos} caso(s) en rojo"; exit 1
