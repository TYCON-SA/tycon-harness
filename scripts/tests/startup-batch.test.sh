#!/usr/bin/env bash
# startup-batch.test.sh — la tanda de fondo que lanza el instalador en cada arranque no traba la máquina.
#
# EL CASO. Cada sesión nueva lanzaba otra tanda (rescate del hilo, hallazgos, subida y bajada del buzón) aunque hubiera
# una corriendo, y la bajada traía el buzón entero del equipo (4,1 GB, casi todo conversaciones) en cada arranque. Con
# varias sesiones abiertas, una máquina llegó a una carga de 49 y otra no terminaba de arrancar.
#   · T1: en el arranque, la bajada no trae los hilos ni los cambios de git (lo grande se baja a pedido).
#   · T2: dos arranques seguidos corren UNA sola tanda: el segundo ve el candado y se va.
#   · T3: un candado que dejó una tanda muerta no traba las siguientes.
#   · T4: al terminar, la tanda suelta el candado.
#
# Corre el cuerpo REAL de la tanda, sacado de install-tycon-hooks.sh, con un Node de mentira que anota cómo lo llamaron.
# Todo en una carpeta de mktemp; no toca la HOME ni el buzón.
#
# Correr: bash scripts/tests/startup-batch.test.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALADOR="$RAIZ/scripts/install-tycon-hooks.sh"

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# El cuerpo de la tanda: lo que va entre `nohup bash -c '` y la comilla que lo cierra.
CUERPO="$TMP/tanda.sh"
python3 - "$INSTALADOR" "$CUERPO" <<'PY'
import re, sys
s = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r"nohup bash -c '\n(.*?)\n\s*' _ \"\$_RESCATAR\"", s, re.S)
if not m:
    sys.exit('no encontré la tanda de fondo en el instalador')
open(sys.argv[2], 'w', encoding='utf-8').write(m.group(1) + '\n')
PY
[ -s "$CUERPO" ] || { echo "❌ startup-batch: no pude sacar la tanda de $INSTALADOR"; exit 1; }

# Un Node de mentira: anota «<guion> <argumentos>» y tarda lo que diga DEMORA.
NODO="$TMP/node-de-mentira"
cat > "$NODO" <<'SH'
#!/usr/bin/env bash
echo "$(basename "$1") ${*:2}" >> "$REGISTRO"
sleep "${DEMORA:-0}"
SH
chmod +x "$NODO"

# tanda <estado> [rescatar subir bajar recolectar]: corre la tanda con esa carpeta de estado
tanda() {
  local estado="$1"; mkdir -p "$estado"
  bash -c "$(cat "$CUERPO")" _ "${2:-0}" "$TMP/tokens-digest.js" "$TMP/upload-runs.js" "$estado" "${3:-0}" "${4:-0}" "$TMP/download-runs.js" \
    "${5:-0}" "$TMP/collect-findings.js" "$TMP/no-existe.js" "$NODO"
}

# ── T1 · en el arranque, la bajada no trae los hilos ─────────────────────────────────────────────────────────
E1="$TMP/e1"; export REGISTRO="$TMP/r1.log"; : > "$REGISTRO"
DEMORA=0 tanda "$E1" 0 0 1 0
if grep -q '^download-runs.js .*--no-threads' "$REGISTRO"; then
  ok "T1 · la bajada del arranque pide --no-threads: los hilos y los cambios de git se bajan a pedido"
else
  bad "T1 · bajada liviana en el arranque" "la bajada se llamó así: $(cat "$REGISTRO") (sin --no-threads trae el buzón entero, 3,7 GB de hilos, en cada arranque)"
fi

# ── T2 · dos arranques seguidos: una sola tanda ──────────────────────────────────────────────────────────────
E2="$TMP/e2"; export REGISTRO="$TMP/r2.log"; : > "$REGISTRO"
DEMORA=2 tanda "$E2" 1 0 0 0 & p1=$!
sleep 0.5
DEMORA=2 tanda "$E2" 1 0 0 0 & p2=$!
wait "$p1" "$p2"
n="$(grep -c '^tokens-digest.js' "$REGISTRO")"
if [ "$n" = "1" ]; then
  ok "T2 · con una tanda corriendo, el segundo arranque no lanza otra"
else
  bad "T2 · una tanda a la vez" "el rescate corrió $n veces (esperaba 1): cada sesión nueva sumaba una tanda entera a la máquina"
fi

# ── T3 · un candado de una tanda muerta no traba las siguientes ──────────────────────────────────────────────
E3="$TMP/e3"; export REGISTRO="$TMP/r3.log"; : > "$REGISTRO"
mkdir -p "$E3/startup-batch.lock"
( exit 0 ) & muerto=$!; wait "$muerto"
echo "$muerto" > "$E3/startup-batch.lock/pid"
DEMORA=0 tanda "$E3" 1 0 0 0
n="$(grep -c '^tokens-digest.js' "$REGISTRO")"
if [ "$n" = "1" ]; then
  ok "T3 · el candado de una tanda que ya no existe se toma y la tanda corre"
else
  bad "T3 · candado huérfano" "el rescate corrió $n veces (esperaba 1): un candado de una tanda muerta dejaba la máquina sin rescate para siempre"
fi

# ── T4 · al terminar, la tanda suelta el candado ─────────────────────────────────────────────────────────────
if [ ! -e "$E3/startup-batch.lock" ] && [ ! -e "$E2/startup-batch.lock" ]; then
  ok "T4 · al terminar, la tanda suelta el candado"
else
  bad "T4 · candado suelto al terminar" "quedó $(ls -d "$E2/startup-batch.lock" "$E3/startup-batch.lock" 2>/dev/null | tr '\n' ' ')"
fi

if [ "$fallos" -eq 0 ]; then echo "✅ startup-batch: todo verde"; exit 0; fi
echo "❌ startup-batch: $fallos rojos"; exit 1
