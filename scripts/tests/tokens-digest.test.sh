#!/usr/bin/env bash
# tokens-digest.test.sh — red de `scripts/metrics/tokens-digest.js` (story 2.13 del arnés, 2026-09-09).
#
# Lo que cuida, en una frase: que de cada corrida del pipeline queden guardados el CONSUMO (bien
# contado), el HILO (sin adjuntos y sin perder lo ilegible en silencio) y el MENSAJE REAL del error
# de cada freno en rojo — y que ninguno de los tres invente un cero donde hubo ausencia.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. Los tres que más
#    pesan:
#    · T1b — el mismo `usage` se repite en hasta 8 líneas de la transcripción. Sumar por línea da
#      3,22× (medido en la corrida de la 2.3: 579 líneas → 251 respuestas reales).
#    · T10/T11b — la marca del freno se escribe cuando el comando TERMINA, no al verlo. Mirar hacia
#      adelante rescata la re-ejecución POSTERIOR, que suele estar en verde: se publicaría el texto
#      de la corrida que salió bien bajo el rótulo de error. Medido: 36 de 37 emparejamientos están
#      antes de la marca; la ventana hacia adelante acierta 1 de 22.
#    · T4/T7c — «no la encontré» tiene dos causas que NO son la misma, y ninguna es cero.
#
# Los universos que estos casos necesitan (una respuesta partida en 4 líneas, dos pasos con las
# marcas invertidas, el mismo comando corrido dos veces) no existen en ningún archivo real: los
# fabrica cada caso.
#
# Correr: bash scripts/tests/tokens-digest.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIGEST="$RAIZ/scripts/metrics/tokens-digest.js"

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

if [ ! -f "$DIGEST" ]; then
  echo "❌ tokens-digest: falta $DIGEST"; exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROJ="$TMP/projects"; HIST="$TMP/history"
mkdir -p "$PROJ/carpeta-cualquiera" "$HIST"

# ── Fabricantes de fixtures ──────────────────────────────────────────────────────────────────────
# Una transcripción es un JSONL. Se arma con python3 para no pelear con comillas en bash.
#   $1 = ruta destino · stdin = programa python que define `lineas` (lista de dicts)
transcripcion() {
  local destino="$1"
  python3 -c "
import json, sys
ns = {}
exec(sys.stdin.read(), ns)
with open('$destino', 'w', encoding='utf-8') as fh:
    for l in ns['lineas']:
        fh.write(l if isinstance(l, str) else json.dumps(l, ensure_ascii=False))
        fh.write('\n')
"
}

# Un volcado de corrida, con la forma que escribe `marker.js cmdClear`.
#   $1 destino · $2 sessionId · $3 stepTimings JSON · $4 gates JSON
volcado() {
  python3 -c "
import json
d = {'archivedAt': '2026-09-01T00:00:00.000Z',
     'marker': {'storyId': 'X.Y', 'sessionId': '$2', 'stepTimings': json.loads('''$3''')},
     'gates': json.loads('''$4'''),
     'costo': {'spawns': 0}}
open('$1', 'w', encoding='utf-8').write(json.dumps(d, indent=2))
"
}

correr() { OUT="$(node "$DIGEST" "$@" 2>&1)"; RC=$?; }

# Lee una ruta del JSON de salida. $1 = expresión python sobre `d`
leer() { python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
v=$1
print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
" <<<"$OUT" 2>/dev/null; }

# ══════════════════════════════════════════════════════════════════════════════════════════════
# EL CONSUMO
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T1 (AC1) · el consumo se reparte por paso según la HORA, no según el orden de llegada ───────
S=sesion-t1
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def a(mid, ts, out):
    return {"type": "assistant", "timestamp": ts,
            "message": {"id": mid, "model": "modelo-a", "role": "assistant",
                        "usage": {"input_tokens": 10, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 100},
                        "content": [{"type": "text", "text": "x"}]}}
# Adrede DESORDENADAS en el archivo: la del paso 1 aparece primero.
lineas = [
    a("m-b", "2026-09-01T10:05:00.000Z", 500),   # entre la marca de 0 y la de 1 → paso "1"
    a("m-a", "2026-09-01T10:00:00.000Z", 300),   # antes de la marca de 0        → paso "0"
]
PY
volcado "$HIST/t1.json" "$S" '{"0": {"completedAt": "2026-09-01T10:01:00.000Z"}, "1": {"completedAt": "2026-09-01T10:10:00.000Z"}}' '[]'
correr --run "$HIST/t1.json" --projects-dir "$PROJ" --json
p0="$(leer "d['consumo']['por_paso'].get('0')")"; p1="$(leer "d['consumo']['por_paso'].get('1')")"
if [ "$p0" = "310" ] && [ "$p1" = "510" ]; then
  ok "T1 · cada respuesta cae en el paso que le toca por hora (0=310, 1=510)"
else
  bad "T1 · reparto por paso" "esperaba 0=310 y 1=510; salió 0=$p0 y 1=$p1 · $OUT"
fi

# ── T1b (AC1b) · una respuesta partida en 4 líneas se cuenta UNA vez ─────────────────────────────
S=sesion-t1b
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
u = {"input_tokens": 100, "output_tokens": 50,
     "cache_creation_input_tokens": 7, "cache_read_input_tokens": 900}
bloques = [{"type": "thinking", "thinking": "…"}, {"type": "text", "text": "…"},
           {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
           {"type": "text", "text": "…"}]
# La MISMA respuesta (mismo message.id, mismo usage) repartida en 4 líneas — es lo que hace Claude Code.
lineas = [{"type": "assistant", "timestamp": "2026-09-01T10:00:0%d.000Z" % i,
           "message": {"id": "una-sola-respuesta", "model": "modelo-a", "role": "assistant",
                       "usage": u, "content": [b]}}
          for i, b in enumerate(bloques)]
PY
volcado "$HIST/t1b.json" "$S" '{}' '[]'
correr --run "$HIST/t1b.json" --projects-dir "$PROJ" --json
r="$(leer "d['consumo']['respuestas']")"; ti="$(leer "d['consumo']['tokens']['in']")"; to="$(leer "d['consumo']['tokens']['out']")"
if [ "$r" = "1" ] && [ "$ti" = "100" ] && [ "$to" = "50" ]; then
  ok "T1b · 4 líneas con el mismo message.id suman una sola respuesta"
else
  bad "T1b · dedup por message.id" "esperaba 1 respuesta / in=100 / out=50; salió $r / $ti / $to (sumar por línea da 4× ) · $OUT"
fi

# ── T1c (AC1c) · dos marcas invertidas se publican FUSIONADAS, no repartidas a ojo ──────────────
S=sesion-t1c
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def a(mid, ts, out):
    return {"type": "assistant", "timestamp": ts,
            "message": {"id": mid, "model": "modelo-a", "role": "assistant",
                        "usage": {"input_tokens": 0, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                        "content": [{"type": "text", "text": "x"}]}}
lineas = [a("m1", "2026-09-01T10:02:00.000Z", 100),   # después del paso 4, dentro del tramo 5+6
          a("m2", "2026-09-01T10:04:00.000Z", 200)]
PY
# El paso 6 cierra ANTES que el 5 — pasa de verdad: en el volcado de la 2.3, el 6 a las 23:49:54
# y el 5 a las 23:50:33. Es lo que la story 2.7 arregla; acá se declara, no se finge.
volcado "$HIST/t1c.json" "$S" '{"4": {"completedAt": "2026-09-01T10:01:00.000Z"}, "5": {"completedAt": "2026-09-01T10:05:00.000Z"}, "6": {"completedAt": "2026-09-01T10:03:00.000Z"}}' '[]'
correr --run "$HIST/t1c.json" --projects-dir "$PROJ" --json
pasos="$(leer "sorted(d['consumo']['por_paso'].keys())")"
fus="$(leer "d['consumo']['por_paso'].get('5+6')")"
if [ "$fus" = "300" ] && [[ "$pasos" != *'"5"'* ]] && [[ "$pasos" != *'"6"'* ]]; then
  ok "T1c · marcas invertidas → un balde 5+6 con los 300, y ni 5 ni 6 solos"
else
  bad "T1c · fusión de marcas invertidas" "esperaba 5+6=300 sin claves 5 ni 6; salió pasos=$pasos, 5+6=$fus (asignar al primer corte deja el 6 en cero, en silencio) · $OUT"
fi

# ── T2 (AC2) · lo posterior al último paso NO se reparte ─────────────────────────────────────────
S=sesion-t2
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def a(mid, ts, out):
    return {"type": "assistant", "timestamp": ts,
            "message": {"id": mid, "model": "modelo-a", "role": "assistant",
                        "usage": {"input_tokens": 0, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                        "content": [{"type": "text", "text": "x"}]}}
lineas = [a("dentro", "2026-09-01T10:00:00.000Z", 100),
          a("despues", "2026-09-01T11:00:00.000Z", 900)]   # el cierre sigue después del último paso
PY
volcado "$HIST/t2.json" "$S" '{"8": {"completedAt": "2026-09-01T10:30:00.000Z"}}' '[]'
correr --run "$HIST/t2.json" --projects-dir "$PROJ" --json
fv="$(leer "d['consumo']['fuera_de_ventana']")"; p8="$(leer "d['consumo']['por_paso'].get('8')")"
if [ "$fv" = "900" ] && [ "$p8" = "100" ]; then
  ok "T2 · lo posterior al último paso va a fuera_de_ventana (900), el paso 8 queda en 100"
else
  bad "T2 · fuera de ventana" "esperaba fuera=900 y paso 8=100; salió $fv y $p8 (aplastarlo contra el último paso lo infla 10×) · $OUT"
fi

# ── T3 (AC3) · `<synthetic>` se cuenta aparte y NO suma ──────────────────────────────────────────
S=sesion-t3
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def a(mid, modelo, out):
    return {"type": "assistant", "timestamp": "2026-09-01T10:00:00.000Z",
            "message": {"id": mid, "model": modelo, "role": "assistant",
                        "usage": {"input_tokens": 0, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                        "content": [{"type": "text", "text": "x"}]}}
lineas = [a("real", "modelo-a", 100), a("falso", "<synthetic>", 5000)]
PY
volcado "$HIST/t3.json" "$S" '{}' '[]'
correr --run "$HIST/t3.json" --projects-dir "$PROJ" --json
sin="$(leer "d['consumo']['sinteticos']")"; to="$(leer "d['consumo']['tokens']['out']")"
if [ "$sin" = "1" ] && [ "$to" = "100" ]; then
  ok "T3 · el sintético se cuenta (1) y no suma tokens (out=100)"
else
  bad "T3 · sintéticos" "esperaba sinteticos=1 y out=100; salió $sin y $to · $OUT"
fi

# ── T4 (AC4) · sin conversación NO es cero ───────────────────────────────────────────────────────
volcado "$HIST/t4.json" "sesion-que-ya-no-existe" '{}' '[]'
correr --run "$HIST/t4.json" --projects-dir "$PROJ" --json
est="$(leer "d['consumo']['estado']")"; mot="$(leer "d['consumo'].get('motivo','')")"
tk="$(leer "d['consumo'].get('tokens')")"
if [ "$est" = "borrada" ] && [ -n "$mot" ] && [ "$mot" != "null" ] && [ "$tk" = "null" ]; then
  ok "T4 · conversación ausente → estado 'borrada' con motivo, y sin tokens en cero"
else
  bad "T4 · ausencia ≠ cero" "esperaba estado=borrada + motivo + sin tokens; salió estado=$est motivo=$mot tokens=$tk (devolver ceros hace leer 0 donde hubo ausencia) · $OUT"
fi

# ── T7c (Cómo se ubica) · «no la encontré» tiene DOS causas y no se confunden ────────────────────
# `projects/` ilegible (acá: no es un directorio) → no_medido. Ausente con projects legible → borrada (T4).
touch "$TMP/projects-que-no-es-carpeta"
volcado "$HIST/t7c.json" "sesion-cualquiera" '{}' '[]'
correr --run "$HIST/t7c.json" --projects-dir "$TMP/projects-que-no-es-carpeta" --json
est="$(leer "d['consumo']['estado']")"; mot="$(leer "d['consumo'].get('motivo','')")"
if [ "$est" = "no_medido" ] && [ -n "$mot" ] && [ "$mot" != "null" ]; then
  ok "T7c · carpeta de conversaciones ilegible → 'no_medido' con motivo (≠ 'borrada')"
else
  bad "T7c · no medido ≠ borrada" "esperaba no_medido con motivo; salió estado=$est motivo=$mot (una sola causa hace que «borrada» tape un permiso roto) · $OUT"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# EL HILO
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T5 (AC5) · adjuntos e instantáneas quedan afuera; el tamaño se registra ──────────────────────
S=sesion-t5
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
relleno = "B" * 40000
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z",
     "message": {"role": "user", "content": "hola"}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:01.000Z", "contenido": relleno},
    {"type": "file-history-snapshot", "timestamp": "2026-09-01T10:00:02.000Z", "snapshot": relleno},
    {"type": "file-history-delta", "timestamp": "2026-09-01T10:00:03.000Z", "delta": relleno},
    {"type": "queue-operation", "timestamp": "2026-09-01T10:00:04.000Z", "q": relleno},
    {"type": "assistant", "timestamp": "2026-09-01T10:00:05.000Z",
     "message": {"id": "m1", "model": "modelo-a", "role": "assistant",
                 "usage": {"input_tokens": 1, "output_tokens": 1,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                 "content": [{"type": "text", "text": "chau"}]}},
]
PY
volcado "$HIST/t5.json" "$S" '{}' '[]'
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
msgs="$(leer "d['hilo']['mensajes']")"; bytes="$(leer "d['hilo']['bytes']")"
gz="$HIST/t5.hilo.jsonl.gz"
if [ -f "$gz" ] && [ "$msgs" = "2" ] && [ -n "$bytes" ] && [ "$bytes" != "null" ] \
   && ! gzip -dc "$gz" | grep -q 'BBBBBBBBBB'; then
  ok "T5 · el hilo guarda los 2 mensajes, descarta adjuntos e instantáneas, y registra el tamaño"
else
  bad "T5 · hilo sin adjuntos" "esperaba 2 mensajes, tamaño registrado y ningún relleno adentro; salió mensajes=$msgs bytes=$bytes (copiar el crudo lo hace pesar ~3×) · $OUT"
fi

# ── T6 (AC5) · una línea ilegible se CUENTA, no se descarta callada ──────────────────────────────
S=sesion-t6
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z", "message": {"role": "user", "content": "a"}},
    '{"type": "assistant", "roto',
    {"type": "user", "timestamp": "2026-09-01T10:00:02.000Z", "message": {"role": "user", "content": "b"}},
]
PY
volcado "$HIST/t6.json" "$S" '{}' '[]'
correr --run "$HIST/t6.json" --projects-dir "$PROJ" --json
ile="$(leer "d['consumo']['lineas_ilegibles']")"
if [ "$ile" = "1" ]; then
  ok "T6 · la línea rota queda contada (1), no descartada en silencio"
else
  bad "T6 · lo ilegible se declara" "esperaba 1; salió $ile (ignorarla deja el contador en 0 y nadie se entera) · $OUT"
fi

# ── T7 (AC6) · idempotente sobre la misma entrada ────────────────────────────────────────────────
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
b1="$(leer "d['hilo']['bytes']")"; h1="$(leer "d['consumo']['hilo_hasta']")"
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
b2="$(leer "d['hilo']['bytes']")"; h2="$(leer "d['consumo']['hilo_hasta']")"
if [ "$b1" = "$b2" ] && [ "$h1" = "$h2" ] && [ -n "$b1" ] && [ "$b1" != "null" ]; then
  ok "T7 · dos pasadas sobre la misma conversación dan el mismo resultado ($b1 bytes)"
else
  bad "T7 · idempotencia" "esperaba el mismo tamaño y el mismo hilo_hasta; salió $b1/$h1 y $b2/$h2 (anexar en vez de reescribir lo duplica) · $OUT"
fi

# ── T7b (AC6) · si la conversación CRECIÓ, la segunda pasada la incorpora ────────────────────────
# Es el caso del cierre truncado: el archivador corre en el `clear` y el pipeline sigue hablando.
python3 -c "
import json
p = '$PROJ/carpeta-cualquiera/sesion-t5.jsonl'
with open(p, 'a', encoding='utf-8') as fh:
    for i in range(10):
        fh.write(json.dumps({'type': 'user', 'timestamp': '2026-09-01T11:00:%02d.000Z' % i,
                             'message': {'role': 'user', 'content': 'nuevo %d' % i}}) + '\n')
"
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
m3="$(leer "d['hilo']['mensajes']")"; h3="$(leer "d['consumo']['hilo_hasta']")"
if [ "$m3" = "12" ] && [ "$h3" != "$h1" ] && [[ "$h3" == 2026-09-01T11:00:09* ]]; then
  ok "T7b · la conversación creció → 12 mensajes y hilo_hasta avanza a las 11:00:09"
else
  bad "T7b · actualiza si creció" "esperaba 12 mensajes y hilo_hasta en 11:00:09; salió $m3 y $h3 (saltear si ya hay rescate pierde el cierre de CADA corrida, para siempre) · $OUT"
fi

# ── T14 (AC7b) · el barrido del arranque procesa SÓLO lo que hace falta ──────────────────────────
BARR="$TMP/barrido"; mkdir -p "$BARR"
for n in sin-rescate al-dia atrasada; do
  S="sesion-$n"
  transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
lineas = [{"type": "user", "timestamp": "2026-09-01T10:00:0%d.000Z" % i,
           "message": {"role": "user", "content": "m%d" % i}} for i in range(3)]
PY
  volcado "$BARR/$n.json" "$S" '{}' '[]'
done
# La «al día» ya tiene su rescate, con hilo_hasta en el último mensaje → no hay que tocarla.
node "$DIGEST" --run "$BARR/al-dia.json" --projects-dir "$PROJ" --json >/dev/null 2>&1
# La «atrasada» también fue rescatada… y después su conversación creció.
node "$DIGEST" --run "$BARR/atrasada.json" --projects-dir "$PROJ" --json >/dev/null 2>&1
python3 -c "
import json
p = '$PROJ/carpeta-cualquiera/sesion-atrasada.jsonl'
open(p, 'a', encoding='utf-8').write(json.dumps(
    {'type': 'user', 'timestamp': '2026-09-01T12:00:00.000Z',
     'message': {'role': 'user', 'content': 'lo del cierre'}}) + '\n')
"
correr --pending --history-dir "$BARR" --projects-dir "$PROJ" --json
proc="$(leer "sorted(d['procesadas'])")"
if [[ "$proc" == *'sin-rescate'* ]] && [[ "$proc" == *'atrasada'* ]] && [[ "$proc" != *'al-dia'* ]]; then
  ok "T14 · el barrido toma la que no tiene rescate y la que quedó atrasada, y deja la que está al día"
else
  bad "T14 · barrido selectivo" "esperaba sin-rescate + atrasada y NO al-dia; salió $proc (procesarlas todas relee 70 conversaciones en cada arranque; ninguna deja el cierre truncado así) · $OUT"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# EL MENSAJE DEL ERROR
# ══════════════════════════════════════════════════════════════════════════════════════════════
#
# 🔴 La marca del freno se escribe cuando el comando TERMINA (`marker.js cmdRunCheck` toma t0,
#    ejecuta, y recién entonces escribe la línea con su durationMs). Por eso la invocación está
#    ANTES de la marca — medido: 36 de 37 casos reales, mediana −0,8 s.

# Arma una transcripción con pares comando→resultado. Cada trío: id, hora, comando, salida.
transcripcion_cmds() {
  local destino="$1"; shift
  python3 -c "
import json, sys
trios = json.loads(sys.argv[1])
with open('$destino', 'w', encoding='utf-8') as fh:
    for tid, ts, cmd, salida in trios:
        fh.write(json.dumps({'type': 'assistant', 'timestamp': ts, 'message': {
            'id': 'a-' + tid, 'model': 'modelo-a', 'role': 'assistant',
            'usage': {'input_tokens': 0, 'output_tokens': 0,
                      'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0},
            'content': [{'type': 'tool_use', 'id': tid, 'name': 'Bash',
                         'input': {'command': cmd}}]}}, ensure_ascii=False) + '\n')
        fh.write(json.dumps({'type': 'user', 'timestamp': ts, 'message': {
            'role': 'user',
            'content': [{'type': 'tool_result', 'tool_use_id': tid, 'content': salida}]}},
            ensure_ascii=False) + '\n')
" "$1"
}

# ── T10 (AC9) · con dos ejecuciones, se rescata LA QUE FALLÓ ─────────────────────────────────────
S=sesion-t10
# La que falló corre antes de la marca (10:00:59); el reintento en verde, 30 s DESPUÉS.
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["u1","2026-09-01T10:00:59.000Z","cd /repo && npm run build","ERROR: no compila, faltan 3 tipos"],
  ["u2","2026-09-01T10:01:30.000Z","cd /repo && npm run build","Build OK, 0 errores"]
]'
volcado "$HIST/t10.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 900}]'
correr --run "$HIST/t10.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json,sys
d=json.load(open('$HIST/t10.json'))
print(d['gates'][0].get('mensaje',''))
")"
if [[ "$msg" == *"no compila"* ]] && [[ "$msg" != *"Build OK"* ]]; then
  ok "T10 · se rescata el texto de la corrida que FALLÓ, no el del reintento verde"
else
  bad "T10 · la corrida que falló" "esperaba el texto del error; salió: $msg (tomar la más cercana sin acotar dirección, o mirar hacia adelante, publica el VERDE bajo el rótulo de error)"
fi

# ── T11 (AC9) · no se inventa por cercanía temática ──────────────────────────────────────────────
S=sesion-t11
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["v1","2026-09-01T10:00:58.000Z","git status","On branch main. error: nothing added to commit"]
]'
volcado "$HIST/t11.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 50}]'
correr --run "$HIST/t11.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
d=json.load(open('$HIST/t11.json'))
print(d['gates'][0].get('mensaje',''))
")"
if [ -z "$msg" ]; then
  ok "T11 · un resultado vecino que dice «error» pero es de otro comando NO se rescata"
else
  bad "T11 · nada por cercanía" "no debía rescatar nada; salió: $msg (buscar por parecido temático arrastra 169 casos de basura)"
fi

# ── T11b (AC9) · la ventana mira hacia ATRÁS ─────────────────────────────────────────────────────
S=sesion-t11b
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["w1","2026-09-01T10:00:30.000Z","cd /repo && npm test","FALLAN 4 pruebas"]
]'
volcado "$HIST/t11b.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "npm test", "exit": 1, "durationMs": 30000}]'
correr --run "$HIST/t11b.json" --projects-dir "$PROJ" --json
antes="$(python3 -c "
import json
print(json.load(open('$HIST/t11b.json'))['gates'][0].get('mensaje',''))
")"
S=sesion-t11b2
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["w2","2026-09-01T10:01:30.000Z","cd /repo && npm test","FALLAN 4 pruebas"]
]'
volcado "$HIST/t11b2.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "npm test", "exit": 1, "durationMs": 30000}]'
correr --run "$HIST/t11b2.json" --projects-dir "$PROJ" --json
despues="$(python3 -c "
import json
print(json.load(open('$HIST/t11b2.json'))['gates'][0].get('mensaje',''))
")"
if [[ "$antes" == *"FALLAN 4"* ]] && [ -z "$despues" ]; then
  ok "T11b · la ejecución 30 s ANTES de la marca sí se toma; la de 30 s después, no"
else
  bad "T11b · ventana hacia atrás" "esperaba rescatar la de antes y NO la de después; antes='$antes' después='$despues' (la marca es la hora de FIN: mirar hacia adelante agarra la re-ejecución posterior)"
fi

# ── T12 (AC10) · el preámbulo de «segundo plano» no es el mensaje del error ──────────────────────
S=sesion-t12
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["x1","2026-09-01T10:00:59.000Z","cd /repo && npm test","Command running in background (bash_1). Output: /tmp/x.log"]
]'
volcado "$HIST/t12.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "npm test", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t12.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t12.json'))['gates'][0].get('mensaje',''))
")"
if [ -z "$msg" ]; then
  ok "T12 · el aviso de «corriendo en segundo plano» no se guarda como si fuera el error"
else
  bad "T12 · segundo plano" "no debía guardar nada; salió: $msg (guardarlo hace pasar un preámbulo por evidencia)"
fi

# ── T13 (AC11) · el rescatado sale saneado ───────────────────────────────────────────────────────
S=sesion-t13
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["y1","2026-09-01T10:00:59.000Z","cd /repo && npm run build","falló en /Users/usuarioa/SourceCode/Cliente/src/a.ts y en /private/tmp/claude-501/abc/scratchpad — sesión 00000000-0000-4000-8000-000000000002"]
]'
volcado "$HIST/t13.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t13.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t13.json'))['gates'][0].get('mensaje',''))
")"
if [ -n "$msg" ] && [[ "$msg" != *"/Users/"* ]] && [[ "$msg" != *"/private/tmp/"* ]] \
   && [[ "$msg" != *"00000000-0000-4000-8000-000000000002"* ]]; then
  ok "T13 · el mensaje sale sin rutas absolutas, sin carpeta temporal y sin identificador de sesión"
else
  bad "T13 · saneado" "quedó material del disco adentro: $msg (sin saneado aparecieron 11 rutas del disco del dev en la página)"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# LOS CUATRO QUE AGREGARON LOS REVISORES (2026-09-09, Step 5 del pipeline)
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T15 (AC9) · el DESEMPATE: con dos ejecuciones válidas, gana la más cercana a la marca ────────
# 🔴 Lo trajo el revisor de cobertura: en T10 sólo un candidato sobrevivía el filtro de ventana, así
#    que borrar la comparación de distancia no ponía nada en rojo. La regla existía sin red.
S=sesion-t15
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["z1","2026-09-01T09:59:30.000Z","cd /repo && npm test","ESTA ES LA VIEJA, de hace 90 segundos"],
  ["z2","2026-09-01T10:00:58.000Z","cd /repo && npm test","ESTA ES LA BUENA, la que dejó el freno en rojo"]
]'
volcado "$HIST/t15.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "npm test", "exit": 1, "durationMs": 1500}]'
correr --run "$HIST/t15.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t15.json'))['gates'][0].get('mensaje',''))
")"
if [[ "$msg" == *"LA BUENA"* ]] && [[ "$msg" != *"LA VIEJA"* ]]; then
  ok "T15 · con dos ejecuciones dentro de la ventana, se toma la más cercana a la marca"
else
  bad "T15 · desempate por cercanía" "esperaba «LA BUENA»; salió: $msg (sin la comparación de distancia se publica una ejecución anterior del mismo comando)"
fi

# ── T16 (AC1) · el reparto POR MODELO se publica de verdad ───────────────────────────────────────
# También del revisor de cobertura: `por_modelo` se calculaba y ningún caso lo leía.
S=sesion-t16
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
def a(mid, modelo, out):
    return {"type": "assistant", "timestamp": "2026-09-01T10:00:00.000Z",
            "message": {"id": mid, "model": modelo, "role": "assistant",
                        "usage": {"input_tokens": 7, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                        "content": [{"type": "text", "text": "x"}]}}
lineas = [a("m1", "modelo-caro", 100), a("m2", "modelo-barato", 20), a("m3", "modelo-caro", 30)]
PY2
volcado "$HIST/t16.json" "$S" '{}' '[]'
correr --run "$HIST/t16.json" --projects-dir "$PROJ" --json
caro_r="$(leer "d['consumo']['por_modelo']['modelo-caro']['respuestas']")"
caro_o="$(leer "d['consumo']['por_modelo']['modelo-caro']['out']")"
barato_o="$(leer "d['consumo']['por_modelo']['modelo-barato']['out']")"
if [ "$caro_r" = "2" ] && [ "$caro_o" = "130" ] && [ "$barato_o" = "20" ]; then
  ok "T16 · el consumo se abre por modelo (caro: 2 respuestas, 130 de salida; barato: 20)"
else
  bad "T16 · reparto por modelo" "esperaba caro 2/130 y barato 20; salió $caro_r/$caro_o y $barato_o · $OUT"
fi

# ── T17 (AC6) · si el hilo NO se pudo guardar, la corrida NO queda marcada como resuelta ─────────
# 🔴 Del cazador de fallos silenciosos, y es el peor de los cuatro: `hilo_hasta` se fijaba con lo
#    leído de la transcripción, sin mirar si el archivo llegó a escribirse. Con el disco lleno o un
#    permiso mal, ese tramo de conversación se perdía PARA SIEMPRE y el barrido lo contaba como
#    salvado — un número diciendo «todo bien» sobre algo que no se guardó.
S=sesion-t17
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
lineas = [{"type": "user", "timestamp": "2026-09-01T10:00:0%d.000Z" % i,
           "message": {"role": "user", "content": "m%d" % i}} for i in range(3)]
PY2
volcado "$HIST/t17.json" "$S" '{}' '[]'
mkdir -p "$HIST/t17.hilo.jsonl.gz"   # una CARPETA donde va el archivo → la escritura falla
correr --run "$HIST/t17.json" --projects-dir "$PROJ" --json
err="$(leer "d['hilo'].get('error','')")"
hh="$(python3 -c "
import json
print(json.load(open('$HIST/t17.json'))['consumo'].get('hilo_hasta'))
")"
correr --pending --history-dir "$HIST" --projects-dir "$PROJ" --json
sigue="$(leer "'t17' in d['procesadas']")"
rmdir "$HIST/t17.hilo.jsonl.gz" 2>/dev/null
if [ "$err" != "null" ] && [ -n "$err" ] && [ "$hh" = "None" ] && [ "$sigue" = "true" ]; then
  ok "T17 · hilo que no se pudo guardar → sin hilo_hasta, y la corrida sigue pendiente para el próximo barrido"
else
  bad "T17 · el hilo perdido no se da por salvado" "error=$err hilo_hasta=$hh sigue_pendiente=$sigue (fijar hilo_hasta sin mirar si se escribió pierde ese tramo para siempre, contándolo como salvado)"
fi

# ── T18 (AC11) · el saneado corta la ruta ENTERA, no sólo la carpeta personal ────────────────────
# 🔴 Del revisor de seguridad. El saneado colapsaba el home a `~` ANTES de borrar la ruta, así que
#    la regla que la borraba ya no la reconocía y sobrevivía justo el tramo que nombra al CLIENTE.
#    T13 no lo detectaba porque sólo miraba que no quedara `/Users/`.
S=sesion-t18
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["y2","2026-09-01T10:00:59.000Z","cd /repo && npm run build","falló en /Users/usuarioa/SourceCode/NombreDelCliente/src/Pagos.cs · también C:\\Users\\devb\\SourceCode\\OtroCliente\\a.ts · avisar a alguien@clientex.com.ar · AZURE_DEVOPS_PAT=abc123def456"]
]'
volcado "$HIST/t18.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t18.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t18.json'))['gates'][0].get('mensaje',''))
")"
fuga=""
case "$msg" in *NombreDelCliente*) fuga="$fuga nombre-de-cliente";; esac
case "$msg" in *OtroCliente*) fuga="$fuga ruta-windows";; esac
case "$msg" in *clientex.com.ar*) fuga="$fuga correo";; esac
case "$msg" in *abc123def456*) fuga="$fuga credencial";; esac
if [ -n "$msg" ] && [ -z "$fuga" ]; then
  ok "T18 · no se filtran nombre de cliente, ruta de Windows, correo ni credencial"
else
  bad "T18 · saneado completo" "se filtró:$fuga · salió: $msg (colapsar el home a ~ antes de borrar la ruta deja pasar justo el nombre del cliente)"
fi

# ── T19 · un volcado que no se puede escribir se CUENTA y se DICE, no desaparece ─────────────────
# 🔴 Del cazador de fallos silenciosos. El barrido corre en CADA arranque de sesión, con la salida
#    mandada a un archivo de registro: si una corrida no se puede persistir y eso no se cuenta en
#    ningún lado, se reintenta para siempre sin que nadie se entere. «No pude» tiene que verse.
BARR2="$TMP/barrido-ro"; mkdir -p "$BARR2"
S=sesion-t19
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
lineas = [{"type": "user", "timestamp": "2026-09-01T10:00:00.000Z",
           "message": {"role": "user", "content": "hola"}}]
PY2
volcado "$BARR2/t19.json" "$S" '{}' '[]'
chmod 500 "$BARR2"            # se puede leer y listar, no escribir
correr --pending --history-dir "$BARR2" --projects-dir "$PROJ" --json
chmod 700 "$BARR2"
nop="$(leer "d.get('no_persistidas')")"
salv="$(leer "d.get('salvadas')")"
if [ "$nop" = "1" ] && [ "$salv" = "0" ]; then
  ok "T19 · la corrida que no se pudo escribir se cuenta aparte (no_persistidas=1) y NO como salvada"
else
  bad "T19 · no pude ≠ salvada" "esperaba no_persistidas=1 y salvadas=0; salió $nop y $salv (sin contarlo, el barrido la reintenta en cada arranque y nadie se entera) · $OUT"
fi

# ── T20 · un identificador de sesión con forma de ruta no se usa para armar rutas ────────────────
# Del revisor de seguridad (aviso). Hoy el origen es confiable (un volcado que escribe el arnés),
# pero el identificador sale de un JSON y se concatena a una ruta: si algún día deja de serlo, esto
# ya no se puede convertir en una lectura fuera de lugar.
volcado "$HIST/t20.json" "../../../etc/passwd" '{}' '[]'
correr --run "$HIST/t20.json" --projects-dir "$PROJ" --json
est="$(leer "d['consumo']['estado']")"
if [ "$est" = "no_medido" ]; then
  ok "T20 · un identificador de sesión con separadores de ruta se rechaza («no medido»)"
else
  bad "T20 · identificador validado" "esperaba no_medido; salió $est · $OUT"
fi

# ── T21 (AC11) · rutas con espacios y credenciales sin nombre de variable ────────────────────────
# 🔴 Segunda vuelta del revisor de seguridad. Una ruta con espacio en el nombre del cliente
#    (`Cliente Grande SA`) se cortaba en el primer espacio y el resto sobrevivía; y una credencial
#    embebida en una URL (`user:pass@host`) o un `Bearer <token>` no tienen «NOMBRE=» adelante, así
#    que la regla de credenciales no las veía. Criterio: antes tapar de más que dejar pasar.
S=sesion-t21
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["y3","2026-09-01T10:00:59.000Z","cd /repo && npm run build","falló en /Users/deva/Cliente Grande SA/src/x.ts línea 40 · curl https://admin:P4ssw0rd@host.clientegrande.com/api · Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"]
]'
volcado "$HIST/t21.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t21.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t21.json'))['gates'][0].get('mensaje',''))
")"
fuga=""
case "$msg" in *"Grande SA"*) fuga="$fuga ruta-con-espacios";; esac
case "$msg" in *P4ssw0rd*) fuga="$fuga credencial-en-url";; esac
case "$msg" in *eyJhbGciOiJIUzI1NiJ9*) fuga="$fuga bearer";; esac
if [ -n "$msg" ] && [ -z "$fuga" ]; then
  ok "T21 · ni la ruta con espacios, ni la credencial en la URL, ni el Bearer sobreviven al saneado"
else
  bad "T21 · saneado: espacios y credenciales sin nombre" "se filtró:$fuga · salió: $msg"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# LO QUE TRAJO EL PASE ADVERSARIAL (Step 5b, 2026-09-09) — 10 confirmados contra datos reales
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T22 (AC9) · comando compuesto: el mensaje es la salida del FRENO, no el preámbulo ────────────
# 🔴 Caso real: volcado 4.56 (2026-08-17), freno 9. El comando del freno corrió al FINAL de un Bash
#    compuesto (`npm run baseline | tail; echo === next ===; pipeline.js next; echo ===; <freno>`).
#    El resultado concatena las tres salidas (2700 caracteres) y el veredicto real empieza en el
#    carácter 807: recortar los primeros 700 publicaba el listado de próximos pasos y cortaba justo
#    ANTES de «🔴 ROJO».
S=sesion-t22
PREAMBULO="$(python3 -c "print('byte-baseline: 45/45 filas coinciden · ' * 30)")"
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" "[
  [\"c1\",\"2026-09-01T10:00:59.000Z\",\"npm run baseline | tail -3; echo '=== next ==='; node pipeline.js next; echo '=== matriz runtime ==='; node runtime-matrix.js --story x.md\",\"$PREAMBULO\\n=== matriz runtime ===\\n🔴 ROJO — CAUSA REAL DEL FALLO: 0/9 ACs corridos\"]
]"
volcado "$HIST/t22.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "acmatrix", "status": "red:exit=1", "cmd": "node runtime-matrix.js --story x.md", "exit": 1, "durationMs": 900}]'
correr --run "$HIST/t22.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t22.json'))['gates'][0].get('mensaje',''))
")"
if [[ "$msg" == *"CAUSA REAL DEL FALLO"* ]]; then
  ok "T22 · con un preámbulo largo de otros comandos, el mensaje conserva el veredicto del freno"
else
  bad "T22 · preámbulo de comando compuesto" "el veredicto real quedó afuera del recorte · salió: ${msg:0:160}…"
fi

# ── T23 (AC9) · con un candidato ANTES y uno DESPUÉS, gana el de antes aunque esté más lejos ──────
# 🔴 Caso real: volcado QA-1 (2026-08-15, un producto del equipo), freno 1 (`npm run type-check`). El run-check
#    real estaba a −11,8 s con el error del compilador; a +7,3 s había un script de triage que
#    también contenía el comando. Se elegía el de +7,3 s por cercanía absoluta y se publicaba
#    «NINGUNO de mis archivos» sin un solo error de TypeScript adentro.
S=sesion-t23
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["d1","2026-09-01T10:00:48.200Z","cd /repo && npm run type-check 2>&1 | tail -4","PedidoDetalle.tsx(254,37): error TS7006: EL ERROR REAL"],
  ["d2","2026-09-01T10:01:07.300Z","npm run type-check 2>&1 | grep -c error; echo === alguno es MIO ===","6\n=== alguno es MIO ===\nNINGUNO de mis archivos"]
]'
volcado "$HIST/t23.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=2", "cmd": "npm run type-check", "exit": 2, "durationMs": 11000}]'
correr --run "$HIST/t23.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t23.json'))['gates'][0].get('mensaje',''))
")"
if [[ "$msg" == *"EL ERROR REAL"* ]] && [[ "$msg" != *"NINGUNO"* ]]; then
  ok "T23 · el candidato de ANTES gana al de después aunque el de después esté más cerca"
else
  bad "T23 · antes > después" "esperaba el error real de −11,8 s; salió: $msg (la cercanía absoluta elige el triage posterior)"
fi

# ── T24 (AC1c) · dos pasos EMPATADOS al milisegundo también se fusionan ──────────────────────────
# Del pase adversarial: la fusión sólo miraba marcas INVERTIDAS (estricto `<`); dos pasos distintos
# con la misma hora exacta dejaban un intervalo de ancho cero y el segundo salía en cero, callado.
S=sesion-t24
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
def a(mid, ts, out):
    return {"type": "assistant", "timestamp": ts,
            "message": {"id": mid, "model": "modelo-a", "role": "assistant",
                        "usage": {"input_tokens": 0, "output_tokens": out,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                        "content": [{"type": "text", "text": "x"}]}}
lineas = [a("m1", "2026-09-01T10:02:00.000Z", 100)]
PY2
volcado "$HIST/t24.json" "$S" '{"1": {"completedAt": "2026-09-01T10:01:00.000Z"}, "2": {"completedAt": "2026-09-01T10:03:00.000Z"}, "3": {"completedAt": "2026-09-01T10:03:00.000Z"}}' '[]'
correr --run "$HIST/t24.json" --projects-dir "$PROJ" --json
pasos="$(leer "sorted(d['consumo']['por_paso'].keys())")"
fus="$(leer "d['consumo']['por_paso'].get('2+3')")"
if [ "$fus" = "100" ] && [[ "$pasos" != *'"3"'* ]]; then
  ok "T24 · dos pasos con la misma marca exacta salen fusionados (2+3), no uno en cero"
else
  bad "T24 · empate al milisegundo" "esperaba 2+3=100 sin clave 3; salió pasos=$pasos 2+3=$fus"
fi

# ── T25/T26/T27 (AC11) · el saneado: tmp real de macOS, credencial pelada, y NO romper texto legítimo
S=sesion-t25
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["e1","2026-09-01T10:00:59.000Z","cd /repo && npm run build","log en /var/folders/lr/q2ypfbq1399147mpvylqrxcr0000gn/T/tmp.abc/salida.log · PASSWORD=hunter2 · SECRET: s3cr3t · PATH=/usr/local/bin:/usr/bin · TaskCanceledException: cancelado · primary_key=duplicada · keyId=7"]
]'
volcado "$HIST/t25.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "build", "status": "red:exit=1", "cmd": "npm run build", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t25.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t25.json'))['gates'][0].get('mensaje',''))
")"
case "$msg" in *"/var/folders/"*|*"q2ypfbq1399147mpvylqrxcr0000gn"*) bad "T25 · tmp real de macOS" "sobrevivió /var/folders/…: $msg";; *) ok "T25 · la carpeta temporal REAL de macOS (/var/folders/…/T) se tapa";; esac
case "$msg" in *hunter2*|*s3cr3t*) bad "T26 · credencial pelada" "sobrevivió el valor: $msg";; *) ok "T26 · PASSWORD= y SECRET: sin prefijo también se tapan";; esac
if [[ "$msg" == *"PATH=/usr/local/bin:/usr/bin"* ]] && [[ "$msg" == *"TaskCanceledException: cancelado"* ]] && [[ "$msg" == *"primary_key=duplicada"* ]] && [[ "$msg" == *"keyId=7"* ]]; then
  ok "T27 · PATH=, TaskCanceledException:, primary_key= y keyId= NO se corrompen (no son credenciales)"
else
  bad "T27 · no romper texto legítimo" "el saneado tapó de más y arruinó el mensaje: $msg"
fi

# ── T28 (AC9) · la contención respeta el borde del comando: `npm test` no es `npm testx` ─────────
S=sesion-t28
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["f1","2026-09-01T10:00:55.000Z","cd /repo && npm test","EL CORRECTO"],
  ["f2","2026-09-01T10:00:59.500Z","cd /repo && npm testx --weird","EL EQUIVOCADO (otro comando con el texto pegado)"]
]'
volcado "$HIST/t28.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "npm test", "exit": 1, "durationMs": 4000}]'
correr --run "$HIST/t28.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t28.json'))['gates'][0].get('mensaje',''))
")"
if [[ "$msg" == *"EL CORRECTO"* ]] && [[ "$msg" != *"EQUIVOCADO"* ]]; then
  ok "T28 · un comando que sólo EMPIEZA igual (npm testx) no se toma por el freno"
else
  bad "T28 · borde de token" "salió: $msg (la subcadena plana atribuye la salida de otro comando)"
fi

# ── T29 (AC4/AC6) · un resumen ya MEDIDO no se pisa con «borrada» por una pasada que no vio la conversación
# 🔴 Del pase adversarial: `--all` reprocesa todo sin condición; si en ESA pasada la carpeta de
#    conversaciones estaba mal apuntada o inaccesible, sobreescribía tokens reales e hilo ya guardado
#    por `estado: borrada` — y como «borrada» es terminal para el barrido, no se recuperaba nunca.
S=sesion-t29
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
lineas = [{"type": "assistant", "timestamp": "2026-09-01T10:00:00.000Z",
           "message": {"id": "m1", "model": "modelo-a", "role": "assistant",
                       "usage": {"input_tokens": 1234, "output_tokens": 5,
                                 "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                       "content": [{"type": "text", "text": "x"}]}}]
PY2
volcado "$HIST/t29.json" "$S" '{}' '[]'
correr --run "$HIST/t29.json" --projects-dir "$PROJ" --json      # medido de verdad
mkdir -p "$TMP/projects-vacio/nada"
correr --run "$HIST/t29.json" --projects-dir "$TMP/projects-vacio" --json   # esta pasada no la ve
est="$(python3 -c "
import json
d=json.load(open('$HIST/t29.json'))['consumo']; print(d.get('estado'), d.get('tokens',{}).get('in'))
")"
if [ "$est" = "medido 1234" ]; then
  ok "T29 · lo ya medido no se pisa: siguen los 1234 tokens aunque esta pasada no viera la conversación"
else
  bad "T29 · no degradar lo medido" "esperaba 'medido 1234'; salió '$est' (una pasada con la carpeta mal apuntada borraba tokens e hilo reales)"
fi

# ── T30 (AC7) · `--run` que no pudo persistir sale ≠ 0: es lo ÚNICO que mira el archivador ────
# 🔴 Segunda vuelta del cazador de fallos silenciosos: el arreglo de T19 (no lanzar al no poder
#    escribir) reabrió el hueco en el punto de entrada más importante. `marker.js` llama a
#    `--run` en CADA cierre del pipeline con la salida ignorada y sólo mira el código de salida;
#    con 0, creía que la corrida quedó rescatada mientras el volcado seguía sin `consumo`.
RO="$TMP/solo-lectura"; mkdir -p "$RO"
S=sesion-t30
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
lineas = [{"type": "user", "timestamp": "2026-09-01T10:00:00.000Z",
           "message": {"role": "user", "content": "hola"}}]
PY2
volcado "$RO/t30.json" "$S" '{}' '[]'
chmod 500 "$RO"
correr --run "$RO/t30.json" --projects-dir "$PROJ" --json
RC30=$RC
chmod 700 "$RO"
if [ "$RC30" -ne 0 ]; then
  ok "T30 · --run sin poder escribir el volcado sale con código $RC30, no con 0"
else
  bad "T30 · exit≠0 al no persistir" "salió 0: el archivador creería que la corrida quedó rescatada · $OUT"
fi

# ── T31 (AC11) · credenciales en camelCase, en encabezados con guion y en JSON pegado ─────────────
# 🔴 Tercera vuelta, dos revisores a la vez: la regla «componente separado por _» dejó de tapar
#    `dbPassword=`, `apiKey=`, `X-Api-Key:` y —lo peor, porque es el formato nativo de un curl—
#    `"password":"x"` / `"access_token":"x"`. La versión anterior (por subcadena) SÍ los tapaba: era
#    una regresión introducida por el arreglo de T27.
S=sesion-t31
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["g1","2026-09-01T10:00:59.000Z","cd /repo && curl -v api","dbPassword=hunter3 · myApiKey=AKIA123 · authToken: tok-999 · X-Api-Key: xk-555 · {\"user\":\"deva\",\"password\":\"p4ss\",\"access_token\":\"eyJ.abc\",\"client_secret\":\"cs-1\"}"]
]'
volcado "$HIST/t31.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "dod", "status": "red:exit=1", "cmd": "curl -v api", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t31.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t31.json'))['gates'][0].get('mensaje',''))
")"
fuga=""
for v in hunter3 AKIA123 tok-999 xk-555 p4ss eyJ.abc cs-1; do case "$msg" in *"$v"*) fuga="$fuga $v";; esac; done
if [ -n "$msg" ] && [ -z "$fuga" ] && [[ "$msg" == *'"user":"deva"'* ]]; then
  ok "T31 · camelCase, encabezado con guion y JSON pegado: los 7 valores tapados, y \"user\" intacto"
else
  bad "T31 · credenciales en otros formatos" "se filtró:$fuga · salió: $msg"
fi

# ── T32 (AC11) · un parámetro inocente pegado no se traga al siguiente; `Authorization:` pelado ──
# 🔴 Cuarta vuelta de seguridad: en `curl -d "user=admin&password=secreto"` el valor de `user=` (no
#    credencial) se tragaba `admin&password=secreto` entero, y `password=` nunca se miraba. Y un
#    `Authorization: <token>` sin `Bearer` adelante no se reconocía como credencial.
S=sesion-t32
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["h1","2026-09-01T10:00:59.000Z","cd /repo && curl -d x api","curl -d \"user=admin&password=secreto&scope=all\" · GET /api?user=x&client_secret=cs9&page=2 · Authorization: tok-pelado-77 · key=k-solo-1"]
]'
volcado "$HIST/t32.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "dod", "status": "red:exit=1", "cmd": "curl -d x api", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t32.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t32.json'))['gates'][0].get('mensaje',''))
")"
fuga=""
for v in secreto cs9 tok-pelado-77 k-solo-1; do case "$msg" in *"$v"*) fuga="$fuga $v";; esac; done
if [ -n "$msg" ] && [ -z "$fuga" ] && [[ "$msg" == *"user=admin"* ]] && [[ "$msg" == *"page=2"* ]]; then
  ok "T32 · password= y client_secret= tras un & se tapan; user= y page= quedan; Authorization: pelado y key= solo se tapan"
else
  bad "T32 · parámetros pegados y Authorization pelado" "se filtró:$fuga · salió: $msg"
fi

# ── T33 (AC11) · las ramas del valor: comillas simples, nombre citado con valor suelto, comilla sin cerrar, valor vacío
# Quinta vuelta de cobertura: el bucle maneja los cuatro casos por lectura de código, «pero sin test es fe».
S=sesion-t33
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["i1","2026-09-01T10:00:59.000Z","cd /repo && curl api","password='\''p-simple'\'' · \"password\": p-suelto · TOKEN= · fin=ok · secret=\"sin-cierre y lo que sigue"]
]'
volcado "$HIST/t33.json" "$S" '{}' '[{"ts": "2026-09-01T10:01:00.000Z", "check": "dod", "status": "red:exit=1", "cmd": "curl api", "exit": 1, "durationMs": 40}]'
correr --run "$HIST/t33.json" --projects-dir "$PROJ" --json
msg="$(python3 -c "
import json
print(json.load(open('$HIST/t33.json'))['gates'][0].get('mensaje',''))
")"
fuga=""
for v in p-simple p-suelto sin-cierre; do case "$msg" in *"$v"*) fuga="$fuga $v";; esac; done
if [ -n "$msg" ] && [ -z "$fuga" ] && [[ "$msg" == *"fin=ok"* ]]; then
  ok "T33 · comillas simples, nombre citado con valor suelto y comilla sin cerrar se tapan; TOKEN= vacío no rompe; fin=ok queda"
else
  bad "T33 · ramas del valor" "se filtró:$fuga · salió: $msg"
fi

# ── T34..T37 · la COLA que guarda `marker.js run-check` al dar rojo (2026-09-17) ──────────────────
# Desde el 2026-09-14, 0 de 43 frenos en rojo tenían mensaje: el comando lo lanzaba un script y 26
# corrían en segundo plano, así que en la conversación sólo quedaba «Command running in background».
# Ahora run-check guarda la cola saneada en `cola` y el rescate la usa primero.

# T34 — el caso real: test-gate.sh lanzado en segundo plano; el freno registra el subproceso
# (run-suites-json.js), que ni aparece en la conversación.
# Mutación que lo pone en rojo: no leer `cola` (origin/main antes de este arreglo) → sin mensaje.
S=sesion-t34
transcripcion_cmds "$PROJ/carpeta-cualquiera/$S.jsonl" '[
  ["b1","2026-09-01T10:00:00.000Z","cd /repo && bash test-gate.sh","Command running in background with ID: bxyz. Output is being written to: /private/tmp/claude-501/tasks/bxyz.output"]
]'
volcado "$HIST/t34.json" "$S" '{}' '[{"ts": "2026-09-01T10:14:00.000Z", "check": "tests", "status": "red:exit=1", "cmd": "node /x/lib/run-suites-json.js /repo /tmp/suites.json", "exit": 1, "durationMs": 780000, "cola": "suite-a ok\\nsuite-b FALLA: esperaba 3, vino 2\\n🔴 1 de 35 suites en rojo"}]'
correr --run "$HIST/t34.json" --projects-dir "$PROJ" --json
r34="$(python3 -c "
import json
g=json.load(open('$HIST/t34.json'))['gates'][0]
print(g.get('mensaje_fuente',''), '|', g.get('mensaje',''))
")"
if [[ "$r34" == "salida |"*"1 de 35 suites en rojo"* ]]; then
  ok "T34 · freno en rojo lanzado en segundo plano por un script: el mensaje sale de la cola del registro"
else
  bad "T34 · cola en segundo plano" "salió: $r34 · $OUT"
fi

# T35 — la conversación ya no está: la cola no depende de ella y se conserva igual.
# Mutación: aplicar la cola después de ubicar la transcripción → la salida temprana la pierde.
volcado "$HIST/t35.json" "sesion-que-no-existe-t35" '{}' '[{"ts": "2026-09-01T10:14:00.000Z", "check": "build", "status": "red:exit=2", "cmd": "dotnet build", "exit": 2, "durationMs": 9000, "cola": "error CS1002: ; expected"}]'
correr --run "$HIST/t35.json" --projects-dir "$PROJ" --json
r35="$(python3 -c "
import json
d=json.load(open('$HIST/t35.json'))
print(d['consumo']['estado'], '|', d['gates'][0].get('mensaje',''))
")"
if [[ "$r35" == "borrada | error CS1002: ; expected" ]]; then
  ok "T35 · con la conversación borrada, el mensaje de la cola se guarda igual"
else
  bad "T35 · cola sin conversación" "salió: $r35 · $OUT"
fi

# T36 — una cola escrita con un saneado viejo se vuelve a sanear al publicarse.
# Mutación: copiar `cola` a `mensaje` sin pasar por colaDeSalida → sale el correo y la ruta.
volcado "$HIST/t36.json" "sesion-que-no-existe-t36" '{}' '[{"ts": "2026-09-01T10:14:00.000Z", "check": "dod", "status": "red:exit=1", "cmd": "bash dod.sh", "exit": 1, "durationMs": 900, "cola": "falló /Users/fulano/SourceCode/ClienteSecretoSA/a.cs para persona@cliente.com"}]'
correr --run "$HIST/t36.json" --projects-dir "$PROJ" --json
m36="$(python3 -c "
import json
print(json.load(open('$HIST/t36.json'))['gates'][0].get('mensaje',''))
")"
if [ -n "$m36" ] && [[ "$m36" != *"ClienteSecretoSA"* ]] && [[ "$m36" != *"persona@cliente.com"* ]] && [[ "$m36" == *"<ruta>"* ]]; then
  ok "T36 · la cola se vuelve a sanear: ni la ruta con el cliente ni el correo llegan al mensaje"
else
  bad "T36 · re-saneado de la cola" "salió: $m36"
fi

# T37 — sin rojo no hay mensaje, aunque una línea traiga `cola`.
# Mutación: no mirar el estado → un verde publicaría texto bajo el rótulo de error.
volcado "$HIST/t37.json" "sesion-que-no-existe-t37" '{}' '[{"ts": "2026-09-01T10:14:00.000Z", "check": "tests", "status": "green", "cmd": "npm test", "exit": 0, "durationMs": 900, "cola": "todo bien"}]'
correr --run "$HIST/t37.json" --projects-dir "$PROJ" --json
m37="$(python3 -c "
import json
print(json.load(open('$HIST/t37.json'))['gates'][0].get('mensaje','(sin mensaje)'))
")"
if [ "$m37" = "(sin mensaje)" ]; then
  ok "T37 · un freno en verde no recibe mensaje aunque traiga cola"
else
  bad "T37 · verde con cola" "salió: $m37"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
if [ "$fallos" -eq 0 ]; then echo "✅ tokens-digest: todo verde"; exit 0; fi
echo "❌ tokens-digest: $fallos rojos"; exit 1
