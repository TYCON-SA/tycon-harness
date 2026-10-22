#!/usr/bin/env bash
# tokens-digest.test.sh — red de `scripts/metrics/tokens-digest.js` .
#
# Lo que cuida, en una frase: que de cada corrida del pipeline queden guardados el CONSUMO (bien
# contado), el HILO (sin adjuntos y sin perder lo ilegible en silencio) y el MENSAJE REAL del error
# de cada freno en rojo — y que ninguno de los tres invente un cero donde hubo ausencia.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. Los tres que más
#    pesan:
#    · T1b — el mismo `usage` se repite en hasta 8 líneas de la transcripción. Sumar por línea da
#      3,22× (579 líneas son 251 respuestas reales).
#    · T10/T11b — la marca del freno se escribe cuando el comando TERMINA, no al verlo. Mirar hacia
#      adelante rescata la re-ejecución POSTERIOR, que suele estar en verde: se publicaría el texto
#      de la corrida que salió bien bajo el rótulo de error. En datos reales casi todos los emparejamientos
#      están antes de la marca; la ventana hacia adelante casi nunca acierta.
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

# ── T1 · el consumo se reparte por paso según la HORA, no según el orden de llegada ───────
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

# ── T1b · una respuesta partida en 4 líneas se cuenta UNA vez ─────────────────────────────
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

# ── T1c · dos marcas invertidas se publican FUSIONADAS, no repartidas a ojo ──────────────
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
# El paso 6 cierra ANTES que el 5: pasa de verdad en los volcados reales (el 6 a las 23:49:54 y el 5 a las 23:50:33).
# Acá se declara, no se finge.
volcado "$HIST/t1c.json" "$S" '{"4": {"completedAt": "2026-09-01T10:01:00.000Z"}, "5": {"completedAt": "2026-09-01T10:05:00.000Z"}, "6": {"completedAt": "2026-09-01T10:03:00.000Z"}}' '[]'
correr --run "$HIST/t1c.json" --projects-dir "$PROJ" --json
pasos="$(leer "sorted(d['consumo']['por_paso'].keys())")"
fus="$(leer "d['consumo']['por_paso'].get('5+6')")"
if [ "$fus" = "300" ] && [[ "$pasos" != *'"5"'* ]] && [[ "$pasos" != *'"6"'* ]]; then
  ok "T1c · marcas invertidas → un balde 5+6 con los 300, y ni 5 ni 6 solos"
else
  bad "T1c · fusión de marcas invertidas" "esperaba 5+6=300 sin claves 5 ni 6; salió pasos=$pasos, 5+6=$fus (asignar al primer corte deja el 6 en cero, en silencio) · $OUT"
fi

# ── T2 · lo posterior al último paso NO se reparte ─────────────────────────────────────────
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

# ── T3 · `<synthetic>` se cuenta aparte y NO suma ──────────────────────────────────────────
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

# ── T4 · sin conversación NO es cero ───────────────────────────────────────────────────────
volcado "$HIST/t4.json" "sesion-que-ya-no-existe" '{}' '[]'
correr --run "$HIST/t4.json" --projects-dir "$PROJ" --json
est="$(leer "d['consumo']['estado']")"; mot="$(leer "d['consumo'].get('motivo','')")"
tk="$(leer "d['consumo'].get('tokens')")"
if [ "$est" = "borrada" ] && [ -n "$mot" ] && [ "$mot" != "null" ] && [ "$tk" = "null" ]; then
  ok "T4 · conversación ausente → estado 'borrada' con motivo, y sin tokens en cero"
else
  bad "T4 · ausencia ≠ cero" "esperaba estado=borrada + motivo + sin tokens; salió estado=$est motivo=$mot tokens=$tk (devolver ceros hace leer 0 donde hubo ausencia) · $OUT"
fi

# ── T7c · «no la encontré» tiene DOS causas y no se confunden ────────────────────
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

# ── T5 · adjuntos e instantáneas quedan afuera; el tamaño se registra ──────────────────────
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
   && ! gzip -dc "$gz" | grep 'BBBBBBBBBB' >/dev/null; then
  ok "T5 · el hilo guarda los 2 mensajes, descarta adjuntos e instantáneas, y registra el tamaño"
else
  bad "T5 · hilo sin adjuntos" "esperaba 2 mensajes, tamaño registrado y ningún relleno adentro; salió mensajes=$msgs bytes=$bytes (copiar el crudo lo hace pesar ~3×) · $OUT"
fi

# ── T6 · una línea ilegible se CUENTA, no se descarta callada ──────────────────────────────
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

# ── T7 · idempotente sobre la misma entrada ────────────────────────────────────────────────
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
b1="$(leer "d['hilo']['bytes']")"; h1="$(leer "d['consumo']['hilo_hasta']")"
correr --run "$HIST/t5.json" --projects-dir "$PROJ" --json
b2="$(leer "d['hilo']['bytes']")"; h2="$(leer "d['consumo']['hilo_hasta']")"
if [ "$b1" = "$b2" ] && [ "$h1" = "$h2" ] && [ -n "$b1" ] && [ "$b1" != "null" ]; then
  ok "T7 · dos pasadas sobre la misma conversación dan el mismo resultado ($b1 bytes)"
else
  bad "T7 · idempotencia" "esperaba el mismo tamaño y el mismo hilo_hasta; salió $b1/$h1 y $b2/$h2 (anexar en vez de reescribir lo duplica) · $OUT"
fi

# ── T7b · si la conversación CRECIÓ, la segunda pasada la incorpora ────────────────────────
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

# ── T14 · el barrido del arranque procesa SÓLO lo que hace falta ──────────────────────────
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
#    ANTES de la marca (en datos reales, casi siempre, a menos de un segundo).

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

# ── T10 · con dos ejecuciones, se rescata LA QUE FALLÓ ─────────────────────────────────────
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
  ok "T10 · se rescata el texto de la ejecución que FALLÓ, no el del reintento verde"
else
  bad "T10 · la ejecución que falló" "esperaba el texto del error; salió: $msg (tomar la más cercana sin acotar dirección, o mirar hacia adelante, publica el VERDE bajo el rótulo de error)"
fi

# ── T11 · no se inventa por cercanía temática ──────────────────────────────────────────────
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

# ── T11b · la ventana mira hacia ATRÁS ─────────────────────────────────────────────────────
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

# ── T12 · el preámbulo de «segundo plano» no es el mensaje del error ──────────────────────
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

# ── T13 · el rescatado sale saneado ───────────────────────────────────────────────────────
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
# CASOS DE BORDE
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T15 · el DESEMPATE: con dos ejecuciones válidas, gana la más cercana a la marca ────────
# 🔴 En T10 sólo un candidato sobrevive el filtro de ventana, así que borrar la comparación de
#    distancia no pondría nada en rojo: este caso es la red de esa regla.
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

# ── T16 · el reparto POR MODELO se publica de verdad ───────────────────────────────────────
# `por_modelo` se calcula y tiene que haber un caso que lo lea.
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

# ── T17 · si el hilo NO se pudo guardar, la corrida NO queda marcada como resuelta ─────────
# 🔴 Si `hilo_hasta` se fijara con lo leído de la transcripción, sin mirar si el archivo llegó a escribirse,
#    con el disco lleno o un permiso mal ese tramo de conversación se perdería PARA SIEMPRE y el barrido lo
#    contaría como salvado: un número diciendo «todo bien» sobre algo que no se guardó.
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
  ok "T17 · hilo que no se pudo guardar → sin hilo_hasta, y la ejecución sigue pendiente para el próximo barrido"
else
  bad "T17 · el hilo perdido no se da por salvado" "error=$err hilo_hasta=$hh sigue_pendiente=$sigue (fijar hilo_hasta sin mirar si se escribió pierde ese tramo para siempre, contándolo como salvado)"
fi

# ── T18 · el saneado corta la ruta ENTERA, no sólo la carpeta personal ────────────────────
# 🔴 Si el saneado colapsara el home a `~` ANTES de borrar la ruta, la regla que la borra ya no la
#    reconocería y sobreviviría justo el tramo que nombra al CLIENTE. T13 no lo detecta porque sólo
#    mira que no quede `/Users/`.
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
# 🔴 El barrido corre en CADA arranque de sesión, con la salida
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
  ok "T19 · la ejecución que no se pudo escribir se cuenta aparte (no_persistidas=1) y NO como salvada"
else
  bad "T19 · no pude ≠ salvada" "esperaba no_persistidas=1 y salvadas=0; salió $nop y $salv (sin contarlo, el barrido la reintenta en cada arranque y nadie se entera) · $OUT"
fi

# ── T20 · un identificador de sesión con forma de ruta no se usa para armar rutas ────────────────
# El origen es confiable (un volcado que escribe el arnés), pero el identificador sale de un JSON y se
# concatena a una ruta: si algún día deja de serlo, esto no se puede convertir en una lectura fuera de lugar.
volcado "$HIST/t20.json" "../../../etc/passwd" '{}' '[]'
correr --run "$HIST/t20.json" --projects-dir "$PROJ" --json
est="$(leer "d['consumo']['estado']")"
if [ "$est" = "no_medido" ]; then
  ok "T20 · un identificador de sesión con separadores de ruta se rechaza («no medido»)"
else
  bad "T20 · identificador validado" "esperaba no_medido; salió $est · $OUT"
fi

# ── T21 · rutas con espacios y credenciales sin nombre de variable ────────────────────────
# 🔴 Una ruta con espacio en el nombre del cliente (`Cliente Grande SA`) se cortaría en el primer espacio
#    y el resto sobreviviría; y una credencial embebida en una URL (`user:pass@host`) o un `Bearer <token>`
#    no tienen «NOMBRE=» adelante, así que la regla de credenciales no las vería. Criterio: antes tapar de más que dejar pasar.
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
# CASOS CONTRA DATOS REALES
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ── T22 · comando compuesto: el mensaje es la salida del FRENO, no el preámbulo ────────────
# 🔴 El comando del freno puede correr al FINAL de un Bash compuesto
#    (`npm run baseline | tail; echo === next ===; pipeline.js next; echo ===; <freno>`). El resultado
#    concatena las tres salidas y el veredicto real empieza lejos del principio: recortar los primeros 700
#    caracteres publicaría el listado de próximos pasos y cortaría justo ANTES de «🔴 ROJO».
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

# ── T23 · con un candidato ANTES y uno DESPUÉS, gana el de antes aunque esté más lejos ──────
# 🔴 El run-check real puede estar a −11,8 s con el error del compilador, y a +7,3 s un script de triage que
#    también contiene el comando. Elegir por cercanía absoluta tomaría el de +7,3 s y publicaría
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

# ── T24 · dos pasos EMPATADOS al milisegundo también se fusionan ──────────────────────────
# Si la fusión sólo mirara marcas INVERTIDAS (estricto `<`), dos pasos distintos con la misma hora exacta
# dejarían un intervalo de ancho cero y el segundo saldría en cero, callado.
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

# ── T25/T26/T27 · el saneado: tmp real de macOS, credencial pelada, y NO romper texto legítimo
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

# ── T28 · la contención respeta el borde del comando: `npm test` no es `npm testx` ─────────
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

# ── T29 · un resumen ya MEDIDO no se pisa con «borrada» por una pasada que no vio la conversación
# 🔴 `--all` reprocesa todo sin condición; si en ESA pasada la carpeta de conversaciones está mal apuntada
#    o inaccesible, sobreescribiría tokens reales e hilo ya guardado por `estado: borrada` — y como
#    «borrada» es terminal para el barrido, no se recuperaría nunca.
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

# ── T30 · `--run` que no pudo persistir sale ≠ 0: es lo ÚNICO que mira el archivador ────
# 🔴 No lanzar al no poder escribir (T19) deja un hueco en el punto de entrada más importante. `marker.js`
#    llama a `--run` en CADA cierre del pipeline con la salida ignorada y sólo mira el código de salida;
#    con 0, creería que la corrida quedó rescatada mientras el volcado sigue sin `consumo`.
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

# ── T31 · credenciales en camelCase, en encabezados con guion y en JSON pegado ─────────────
# 🔴 La regla «componente separado por _» no tapa `dbPassword=`, `apiKey=`, `X-Api-Key:` ni —lo peor,
#    porque es el formato nativo de un curl— `"password":"x"` / `"access_token":"x"`. Una regla por
#    subcadena SÍ los tapa: sin estos casos, afinar la regla de T27 los dejaría pasar.
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

# ── T32 · un parámetro inocente pegado no se traga al siguiente; `Authorization:` pelado ──
# 🔴 En `curl -d "user=admin&password=secreto"` el valor de `user=` (no credencial) no puede tragarse
#    `admin&password=secreto` entero, o `password=` nunca se miraría. Y un `Authorization: <token>` sin
#    `Bearer` adelante también es una credencial.
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

# ── T33 · las ramas del valor: comillas simples, nombre citado con valor suelto, comilla sin cerrar, valor vacío
# El bucle maneja los cuatro casos por lectura de código, «pero sin test es fe».
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

# ── T34..T37 · la COLA que guarda `marker.js run-check` al dar rojo ──────────────────
# Si el comando lo lanza un script, o corre en segundo plano, en la conversación sólo queda «Command running in
# background». Por eso run-check guarda la cola saneada en `cola` y el rescate la usa primero.

# T34 — test-gate.sh lanzado en segundo plano; el freno registra el subproceso
# (run-suites-json.js), que ni aparece en la conversación.
# Mutación que lo pone en rojo: no leer `cola` → sin mensaje.
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

# T36 — una cola escrita con un saneado anterior se vuelve a sanear al publicarse.
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

# ── T23 · Cabecera_DiceQueElHiloViajaAlBuzon ──────────────────────────────────────────
# 🔴 Una cabecera que dice «POR QUÉ NO VIAJA» sin nombrar la subida al buzón miente: el buzón sí lleva el hilo.
CAB23="$(awk '/DÓNDE VIVE/{p=1} p{print} /CUATRO COSAS QUE SE MIDIERON/{exit}' "$DIGEST")"
if echo "$CAB23" | grep 'buzón' >/dev/null && echo "$CAB23" | grep 'upload-runs.js' >/dev/null && echo "$CAB23" | grep 'sin vencimiento' >/dev/null \
   && ! echo "$CAB23" | grep 'POR QUÉ NO VIAJA' >/dev/null; then
  ok "T23 · 2.24 la cabecera dice que el hilo viaja al buzón (upload-runs.js), entero y sin vencimiento"
else
  bad "T23 · 2.24 la cabecera" "$(echo "$CAB23" | head -4 | tr '\n' ' ')"
fi

# ── T26 T_HookSeConservaReducido @story-4.10 @ac-3 ─────────────────────────────────────────────
# 🔴 Falla con: `attachment` descartado entero (0 líneas de hook en el hilo: la revisión nocturna no ve ningún
#    aviso que falló) o el adjunto copiado entero (viaja el `stderr`, texto libre de la máquina del dev).
S=sesion-t4-10-26
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def hook(ts, evento, stderr, code):
    return {"type": "attachment", "timestamp": ts, "uuid": "u-" + ts, "sessionId": "s", "cwd": "/x",
            "attachment": {"type": "hook_non_blocking_error", "hookName": evento + ":algo", "toolUseID": "t1",
                           "hookEvent": evento, "stderr": stderr, "stdout": "", "exitCode": code,
                           "command": "node hook.js", "durationMs": 30}}
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z", "message": {"role": "user", "content": "hola"}},
    hook("2026-09-01T10:00:01.000Z", "SessionStart",
         "Failed with non-blocking status code: hook.js:98\n  x?.y\n   ^\nSyntaxError: Unexpected token '.'", 1),
    hook("2026-09-01T10:00:02.000Z", "UserPromptSubmit",
         "Failed with non-blocking status code: node:internal/modules/cjs/loader:1568", 1),
    hook("2026-09-01T10:00:03.000Z", "PreToolUse",
         "Failed with non-blocking status code: /bin/sh: node: command not found", 127),
    {"type": "assistant", "timestamp": "2026-09-01T10:00:05.000Z",
     "message": {"id": "m1", "model": "modelo-a", "role": "assistant",
                 "usage": {"input_tokens": 1, "output_tokens": 1,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                 "content": [{"type": "text", "text": "chau"}]}},
]
PY
volcado "$HIST/t4-10-26.json" "$S" '{}' '[]'
correr --run "$HIST/t4-10-26.json" --projects-dir "$PROJ" --json
r26="$(gzip -dc "$HIST/t4-10-26.hilo.jsonl.gz" 2>/dev/null | python3 -c "
import json, sys
ad = [json.loads(l) for l in sys.stdin if l.strip()]
hk = [o for o in ad if o.get('type') == 'attachment']
ok = len(ad) == 5 and len(hk) == 3
ok = ok and all(sorted(o) == ['attachment', 'timestamp', 'type'] for o in hk)
ok = ok and all(sorted(o['attachment']) == ['categoria', 'exitCode', 'hookEvent', 'hookName', 'texto', 'type'] for o in hk)
print('ok' if ok else 'mal', ','.join(o['attachment'].get('categoria', '?') for o in hk))
")"
if [ "$r26" = "ok node-viejo,carga,node-ausente" ]; then
  ok "T26 · 4.10 los errores de hook viajan en el hilo, reducidos a nombre, evento, salida y categoría"
else
  bad "T26 · 4.10 errores de hook en el hilo" "esperaba 5 líneas, 3 adjuntos reducidos node-viejo,carga,node-ausente; salió: $r26 · $OUT"
fi

# ── T26b T_HookCanceladoPorTiempo @story-4.10 @ac-3 ───────────────────────────────────────────────
# Claude Code anota un hook que se pasó de tiempo como `hook_cancelled` con `timedOut: true`, no como error.
# 🔴 Falla con: aceptar sólo `hook_non_blocking_error` (un freno que se cuelga nunca llega a la revisión nocturna), o
#    conservar un `hook_cancelled` sin `timedOut` (la persona lo canceló: no es una falla del arnés).
S=sesion-t4-10-26b
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY2'
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z", "message": {"role": "user", "content": "hola"}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:01.000Z",
     "attachment": {"type": "hook_cancelled", "hookName": "PreToolUse:Bash", "hookEvent": "PreToolUse",
                    "timedOut": True, "timeoutMs": 10000, "command": "node /ZZCOMANDO/guard.js"}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:02.000Z",
     "attachment": {"type": "hook_cancelled", "hookName": "Stop", "hookEvent": "Stop"}},
]
PY2
volcado "$HIST/t4-10-26b.json" "$S" '{}' '[]'
correr --run "$HIST/t4-10-26b.json" --projects-dir "$PROJ" --json
r26b="$(gzip -dc "$HIST/t4-10-26b.hilo.jsonl.gz" 2>/dev/null | python3 -c "
import json, sys
hk = [json.loads(l)['attachment'] for l in sys.stdin if '\"attachment\"' in l]
print(json.dumps(hk, sort_keys=True))
")"
esp26b='[{"categoria": "tiempo", "exitCode": null, "hookEvent": "PreToolUse", "hookName": "PreToolUse:Bash", "texto": null, "type": "hook_cancelled"}]'
if [ "$r26b" = "$esp26b" ]; then
  ok "T26b · 4.10 un hook que se pasó de tiempo viaja como «tiempo»; uno cancelado sin tiempo, no"
else
  bad "T26b · 4.10 hook cancelado por tiempo" "salió: $r26b"
fi

# ── T26c T_HookCategoriasYSuOrden @story-4.10 @ac-3 ───────────────────────────────────────────────
# Las formas reales que dejan los hooks en las sesiones de Claude Code.
# 🔴 Falla con: sin `ruta-ausente` (el guion de un hook borrado por una actualización cae en «otro», mezclado con ruido),
#    con `node-ausente` sólo en su forma de sh, con el Node propio del arnés (ruta absoluta) tomado por un guion
#    borrado, o con la lista en otro orden.
r26c="$(node -e '
const { reducirErrorDeHook } = require(process.argv[1]);
const cat = (stderr) => reducirErrorDeHook({ type: "attachment", attachment: { type: "hook_non_blocking_error", stderr } }).attachment.categoria;
console.log([
  "Failed with non-blocking status code: /bin/sh: /x/.tycon/harness/scripts/hooks/a.sh: No such file or directory",
  "Failed with non-blocking status code: env: node: No such file or directory",
  "Failed with non-blocking status code: zsh: command not found: node",
  "Failed with non-blocking status code: \x22node\x22 is not recognized as an internal or external command",
  "Failed with non-blocking status code: x.js:9\nSyntaxError: Unexpected token \x27.\x27\n    at node:internal/modules/cjs/loader:1",
  "Failed with non-blocking status code: /bin/sh: /Users/x/.tycon/node/current/bin/node: No such file or directory",
].map(cat).join(","));
' "$DIGEST" 2>&1)"
if [ "$r26c" = "ruta-ausente,node-ausente,node-ausente,node-ausente,node-viejo,node-ausente" ]; then
  ok "T26c · 4.10 guion borrado, cuatro formas de Node ausente (también el propio del arnés) y el orden de la lista"
else
  bad "T26c · 4.10 categorías y su orden" "salió: $r26c"
fi

# ── T27 T_HookCategoriaOtroSinTexto @story-4.10 @ac-21 ──────────────────────────────────────────
# 🔴 Falla con: una categoría por defecto distinta de `otro` (un error desconocido pasaría por «Node viejo»), un
#    `texto` inventado para un `stderr` vacío, o copiar `command`, `stdout` o `cwd` (sólo el error viaja).
S=sesion-t4-10-27
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
def hook(ts, stderr):
    return {"type": "attachment", "timestamp": ts, "cwd": "/home/ZZCWD",
            "attachment": {"type": "hook_non_blocking_error", "hookName": "Stop", "hookEvent": "Stop",
                           "stderr": stderr, "stdout": "ZZSTDOUT", "exitCode": 2,
                           "command": "node /ZZCOMANDO/hook.js"}}
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z", "message": {"role": "user", "content": "hola"}},
    hook("2026-09-01T10:00:01.000Z", ""),
    hook("2026-09-01T10:00:02.000Z", "Failed with non-blocking status code: ZZSTDERR algo raro"),
]
PY
volcado "$HIST/t4-10-27.json" "$S" '{}' '[]'
correr --run "$HIST/t4-10-27.json" --projects-dir "$PROJ" --json
gz27="$HIST/t4-10-27.hilo.jsonl.gz"
c27="$(gzip -dc "$gz27" 2>/dev/null | python3 -c "
import json, sys
a = [json.loads(l)['attachment'] for l in sys.stdin if '\"attachment\"' in l]
print(','.join(x['categoria'] for x in a), a[0].get('texto') is None and 'ZZSTDERR' in (a[1].get('texto') or ''))
")"
if [ "$c27" = "otro,otro True" ] && ! gzip -dc "$gz27" | grep -E 'ZZSTDOUT|ZZCOMANDO|ZZCWD' >/dev/null; then
  ok "T27 · 4.10 un error de hook vacío o desconocido sale como «otro»; viaja el error, nunca stdout, comando ni carpeta"
else
  bad "T27 · 4.10 categoría otro sin texto" "salió: $c27 · centinelas: $(gzip -dc "$gz27" | grep -oE 'ZZ[A-Z]+' | sort -u | tr '\n' ' ')"
fi

# ── T27b T_HookTextoRecortadoYSaneado @story-4.10 @ac-3 @ac-21 ───────────────────────────────────
# El texto del error viaja saneado, sin controles y con tope: lo leen quienes administran el buzón.
# 🔴 Falla con: sin tope (un stack entero al buzón), con saltos o tabulaciones (rompen la ficha), o sin `sanear()`
#    (viajan la ruta del home y una credencial).
r27b="$(node -e '
const os = require("os");
const { reducirErrorDeHook } = require(process.argv[1]);
const home = os.homedir();
const stderr = "Failed with non-blocking status code: " + home + "/Proyectos/ZZCLIENTE/a.js\tPASSWORD=ZZSECRETO\n" + "x".repeat(2000);
const t = reducirErrorDeHook({ type: "attachment", attachment: { type: "hook_non_blocking_error", stderr } }).attachment.texto;
console.log([t.length <= 300, !/[\x00-\x1f\x7f]/.test(t), !t.includes("ZZCLIENTE"), !t.includes("ZZSECRETO"), t.startsWith("Failed with")].join(","));
' "$DIGEST" 2>&1)"
if [ "$r27b" = "true,true,true,true,true" ]; then
  ok "T27b · 4.10 el texto del error viaja con tope de 300, sin controles, sin rutas ni credenciales"
else
  bad "T27b · 4.10 texto recortado y saneado" "tope,controles,ruta,credencial,comienzo: $r27b"
fi

# ── T27c T_HookNombresRarosNoViajan @story-4.10 @ac-3 ────────────────────────────────────────────
# 🔴 Falla con: dejar pasar un nombre largo o con saltos (texto libre por el costado) o un código que no es entero.
#    También con: un nombre de hasta 80 que no viaja, o uno con una ruta del home sin sanear.
r27c="$(node -e '
const os = require("os");
const { reducirErrorDeHook } = require(process.argv[1]);
const red = (at) => reducirErrorDeHook({ type: "attachment", attachment: { type: "hook_non_blocking_error", stderr: "x", ...at } }).attachment;
const a = red({ hookName: "h".repeat(81), hookEvent: "Stop\nZZ", exitCode: "1" });
// una ruta fija y corta: con la carpeta personal del agente de la CI (más larga) el nombre pasa de 80 y no viaja
const b = red({ hookName: "h".repeat(80), hookEvent: "/srv/acme/ZZCLIENTE/x.sh", exitCode: 2 });
console.log(JSON.stringify([a.hookName, a.hookEvent, a.exitCode, b.hookName.length, b.hookEvent.includes("ZZCLIENTE"), b.exitCode]));
' "$DIGEST" 2>&1)"
if [ "$r27c" = '[null,null,null,80,false,2]' ]; then
  ok "T27c · 4.10 un nombre largo, con saltos o un código que no es entero viajan como null; uno de 80 viaja saneado"
else
  bad "T27c · 4.10 nombres raros" "salió: $r27c"
fi

# ── T28 T_OtrosAdjuntosSiguenAfuera @story-4.10 @ac-26 ──────────────────────────────────────────
# 🔴 Falla con: conservar todo `attachment` que traiga `hookName` (un `hook_success` o un adjunto sin tipo pesan y
#    traen texto), o dejar de descartar cualquiera de los tipos de TIPOS_DESCARTADOS (va una línea de cada uno).
S=sesion-t4-10-28
# la lista sale del programa, no de una copia: un tipo nuevo en TIPOS_DESCARTADOS entra solo al caso
DISCARDED_TYPES_28="$(node -e 'console.log(JSON.stringify([...require(process.argv[1]).TIPOS_DESCARTADOS].filter((t) => t !== "attachment" && t !== "queue-operation")))' "$DIGEST")"
export DISCARDED_TYPES_28
transcripcion "$PROJ/carpeta-cualquiera/$S.jsonl" <<'PY'
import os, json
relleno = "C" * 30000
lineas = [
    {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z", "message": {"role": "user", "content": "hola"}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:01.000Z",
     "attachment": {"type": "hook_success", "hookName": "Stop", "hookEvent": "Stop", "stdout": relleno}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:02.000Z", "attachment": {"hookName": "Stop", "x": relleno}},
    {"type": "attachment", "timestamp": "2026-09-01T10:00:03.000Z", "contenido": relleno},
    {"type": "queue-operation", "timestamp": "2026-09-01T10:00:05.000Z", "operation": "dequeue", "q": relleno},
] + [{"type": t, "timestamp": "2026-09-01T10:00:06.000Z", "x": relleno}
     for t in json.loads(os.environ["DISCARDED_TYPES_28"])]
PY
volcado "$HIST/t4-10-28.json" "$S" '{}' '[]'
correr --run "$HIST/t4-10-28.json" --projects-dir "$PROJ" --json
m28="$(leer "d['hilo']['mensajes']")"
if [ "$m28" = "1" ] && ! gzip -dc "$HIST/t4-10-28.hilo.jsonl.gz" | grep 'CCCCCCCCCC' >/dev/null; then
  ok "T28 · 4.10 los demás adjuntos y metadatos siguen afuera del hilo"
else
  bad "T28 · 4.10 otros adjuntos afuera" "esperaba 1 mensaje y ningún relleno; salió mensajes=$m28"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
if [ "$fallos" -eq 0 ]; then echo "✅ tokens-digest: todo verde"; exit 0; fi
echo "❌ tokens-digest: $fallos rojos"; exit 1
