#!/usr/bin/env bash
# smoke-measure.test.sh — el humo registra cuánto tardó el comando y lo que el comando mide.
#
# Por qué existe: un criterio como «responde en menos de 2 s» salía verde con un humo que tardaba 3 s, porque el humo
# juzgaba sólo el código de salida y no anotaba la duración. Ahora `smoke-run.sh` anota `duration_ms` (el reloj de
# pared alrededor del comando) y los renglones `TYCON_MEASURE <nombre>=<valor><unidad>` que imprime el comando, en el
# registro del repo y en el espejo del home; la matriz los compara con la cota que escribe el criterio.
#
# Lo que prueba:
#   T1   SmokeRun_DurationAlways_Sleep3                  `sleep 3` → duration_ms entre 3000 y 4000, en registro y espejo
#   T2   SmokeRun_DurationWithoutTempFile                sin temporal para la salida → duration_ms, sin measures
#   T3   SmokeRun_MeasuresLibMissing_DurationNull        sin lib/smoke-measures.js → duration_ms null con motivo; exit 3
#   T4   SmokeRun_MeasureLines_Stored                    el último gana, sin unidad, tope de 20, salida de más de 8 KB
#   T5   SmokeRun_BadAndReservedMeasureLines_Rejected    mal formados y `duration` → measures_rejected, aviso sin texto
#   T6   SmokeRun_NoMeasureLines_NoField                 sin TYCON_MEASURE → sin measures, con duration_ms
#   T22  Probe_Sleep3_TwoSecondBound_RedThenGreen        la sonda de la auditoría: matriz 1 FUERA-DE-COTA, después 0
#   T25  SmokeRun_Sigterm_AfterMeasureLine_WritesNothing un humo cortado después de medir no escribe nada
#   T26  SmokeRun_LastLineNotMeasured_Exit77              «⏭ <suite>: NO MEDIDO — …» al final con exit 0 → 77, no verde
#
# 🔴 HOME falso siempre: el espejo de los humos (`gates.log`) vive bajo el home.
# stable-data: lee el reloj a propósito y no compara contra un valor fijo: la duración la pone smoke-run.sh con la hora
# real, que es lo que se prueba (con márgenes: el arranque de node suma decenas de ms).
# Correr: bash scripts/tests/smoke-measure.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SK="$AQUI/skills/tycon-pipeline/scripts"
SMOKE="$SK/smoke-run.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ smoke-measure: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ smoke-measure: $1"; fallos=$((fallos+1)); }

command -v node >/dev/null || { echo "❌ smoke-measure: sin node no se puede medir nada"; exit 1; }
unset NODE_TEST_CONTEXT TYCON_EVIDENCE_KEY TYCON_SMOKE_REDACT TYCON_RUNTIME_MATRIX_LEGACY

export HOME="$TMP/casa"; mkdir -p "$HOME/.claude/.tycon-pipeline"
GATES="$HOME/.claude/.tycon-pipeline/gates.log"
export TMPDIR="$TMP/tmpdir"; mkdir -p "$TMPDIR"

REPO="$TMP/repo"; mkdir -p "$REPO"; git init -q "$REPO"
EV="$REPO/.advisors/dod-runtime"

# ultima <archivo> <expresión js sobre `e`> — evalúa sobre la última línea JSON del archivo.
ultima(){ node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").pop();const e=JSON.parse(l);process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"; }

# ── T1 — la duración siempre ─────────────────────────────────────────────────────────────────────────────────
bash "$SMOKE" "$EV" 9.1 --acs 1 --pass-if 'responde en menos de 2 s' -- sleep 3 >/dev/null 2>&1
R="$EV/9.1-smoke-ledger.jsonl"
d1="$(ultima "$R" 'e.duration_ms')"; m1="$(ultima "$GATES" 'e.duration_ms')"
if [ "$d1" = "$m1" ] && [ "$d1" -ge 3000 ] 2>/dev/null && [ "$d1" -lt 4000 ]; then
  ok "T1 sleep 3 → duration_ms $d1 en el registro y en el espejo"
else
  no "T1 duración: registro=$d1 espejo=$m1"
fi

# ── T2 — sin temporal para la salida: duración sí, medidas no ────────────────────────────────────────────────
TMPDIR="$TMP/no-existe" bash "$SMOKE" "$EV" 9.2 --acs 1 --pass-if 'mide' -- sh -c 'echo "TYCON_MEASURE p95=1ms"' >/dev/null 2>&1
R="$EV/9.2-smoke-ledger.jsonl"
if [ "$(ultima "$R" 'e.output')" = null ] && [ "$(ultima "$R" 'Number.isInteger(e.duration_ms)')" = true ] \
  && [ "$(ultima "$R" '"measures" in e')" = false ]; then
  ok "T2 sin temporal: output null, duration_ms presente, sin measures"
else
  no "T2 sin temporal: $(tail -1 "$R" 2>/dev/null)"
fi

# ── T3 — sin la pieza que mide: duration_ms null con motivo, y el resto como hoy ─────────────────────────────
SIN="$TMP/sin-medidas"; mkdir -p "$SIN"; cp "$SMOKE" "$SIN/smoke-run.sh"; cp -R "$SK/lib" "$SIN/lib"; rm -f "$SIN/lib/smoke-measures.js"
aviso="$(bash "$SIN/smoke-run.sh" "$EV" 9.3 --acs 1 --pass-if 'sale 3' -- sh -c 'exit 3' 2>&1 >/dev/null)"; rc=$?
R="$EV/9.3-smoke-ledger.jsonl"
if [ "$rc" = 3 ] && [ "$(ultima "$R" 'e.exit')" = 3 ] && [ "$(ultima "$R" 'e.duration_ms')" = null ] \
  && [ -n "$(ultima "$R" 'e.duration_error||""')" ] && [ "$(ultima "$GATES" 'e.duration_ms')" = null ] \
  && echo "$aviso" | grep 'duración' >/dev/null; then
  ok "T3 sin lib/smoke-measures.js: duration_ms null con duration_error, aviso, y sale 3"
else
  no "T3 sin la pieza: rc=$rc, $(tail -1 "$R" 2>/dev/null) · aviso: $aviso"
fi

# ── T4 — las medidas del comando ─────────────────────────────────────────────────────────────────────────────
bash "$SMOKE" "$EV" 9.4 --acs 1 --pass-if 'mide' -- printf 'hola\nTYCON_MEASURE p95=180ms\nTYCON_MEASURE p95=175 ms\nTYCON_MEASURE errors=0\n' >/dev/null 2>&1
R="$EV/9.4-smoke-ledger.jsonl"
salida4="$EV/$(ultima "$R" 'e.output')"
med4="$(ultima "$R" 'JSON.stringify(e.measures)')"
if [ "$med4" = '[{"name":"p95","value":175,"unit":"ms"},{"name":"errors","value":0,"unit":null}]' ] \
  && [ "$(ultima "$GATES" 'JSON.stringify(e.measures)')" = "$med4" ] && grep -q 'TYCON_MEASURE p95=180ms' "$salida4"; then
  ok "T4 el último gana, sin unidad queda null, en registro y espejo, y los renglones siguen en la salida"
else
  no "T4 medidas: $med4 · espejo: $(ultima "$GATES" 'JSON.stringify(e.measures)')"
fi
bash "$SMOKE" "$EV" 9.41 --acs 1 --pass-if 'mide' -- node -e 'for(let i=0;i<22;i++) console.log("TYCON_MEASURE m"+i+"=1")' >/dev/null 2>&1
R="$EV/9.41-smoke-ledger.jsonl"
if [ "$(ultima "$R" 'e.measures.length')" = 20 ] && [ "$(ultima "$R" 'e.measures_dropped')" = 2 ]; then
  ok "T4 más de 20 nombres: 20 guardados y measures_dropped 2"
else
  no "T4 tope: $(tail -1 "$R" 2>/dev/null | head -c 300)"
fi
aviso="$(bash "$SMOKE" "$EV" 9.42 --acs 1 --pass-if 'mide' -- node -e 'console.log("TYCON_MEASURE p95=9ms");for(let i=0;i<2000;i++) console.log("relleno "+i)' 2>&1 >/dev/null)"
R="$EV/9.42-smoke-ledger.jsonl"
if [ "$(ultima "$R" 'e.measures[0].value')" = 9 ] && echo "$aviso" | grep 'puede no estar' >/dev/null; then
  ok "T4 salida de más de 8 KB: la medida se guarda y el humo avisa que su renglón puede no estar en la salida guardada"
else
  no "T4 salida larga: $(tail -1 "$R" 2>/dev/null | head -c 300) · aviso: $aviso"
fi

# ── T5 — mal formados y el nombre reservado ──────────────────────────────────────────────────────────────────
aviso="$(bash "$SMOKE" "$EV" 9.5 --acs 1 --pass-if 'mide' -- printf 'TYCON_MEASURE p95 180\nTYCON_MEASURE duration=1s\n' 2>&1 >/dev/null)"
R="$EV/9.5-smoke-ledger.jsonl"
if [ "$(ultima "$R" '"measures" in e')" = false ] && [ "$(ultima "$R" 'e.measures_rejected')" = 2 ] \
  && echo "$aviso" | grep '1, 2' >/dev/null && ! echo "$aviso" | grep 'p95 180' >/dev/null; then
  ok "T5 ninguno guardado, measures_rejected 2, el aviso dice los números de renglón y no su texto"
else
  no "T5 rechazados: $(tail -1 "$R" 2>/dev/null) · aviso: $aviso"
fi

# ── T6 — sin medidas, el renglón de hoy más la duración ──────────────────────────────────────────────────────
bash "$SMOKE" "$EV" 9.6 --acs 1 --pass-if 'dice ok' -- echo ok >/dev/null 2>&1
R="$EV/9.6-smoke-ledger.jsonl"
if [ "$(ultima "$R" '"measures" in e || "measures_rejected" in e || "measures_dropped" in e')" = false ] \
  && [ "$(ultima "$R" 'Number.isInteger(e.duration_ms)')" = true ]; then
  ok "T6 echo ok: sin measures, con duration_ms"
else
  no "T6 sin medidas: $(tail -1 "$R" 2>/dev/null)"
fi

# ── T25 — un humo cortado después de medir no escribe nada ───────────────────────────────────────────────────
set -m
bash "$SMOKE" "$EV" 9.25 --acs 1 --pass-if 'termina' -- sh -c 'echo "TYCON_MEASURE p95=1ms"; sleep 30' >/dev/null 2>&1 &
p25=$!
set +m
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ -n "$(ls -A "$TMPDIR")" ]; then break; fi
  sleep 0.2
done
sleep 0.5
kill -TERM -- "-$p25" 2>/dev/null
wait "$p25" 2>/dev/null
if [ ! -e "$EV/9.25-smoke-ledger.jsonl" ] && ! grep -q '"story":"9.25"' "$GATES"; then
  ok "T25 SIGTERM después de imprimir la medida: ni registro ni espejo"
else
  no "T25 humo cortado escribió algo: $(cat "$EV/9.25-smoke-ledger.jsonl" 2>/dev/null)"
fi

# ── T22 — la sonda de la auditoría: con la cota en el criterio, sleep 3 da rojo y sleep 1 da verde ───────────
P="$TMP/sonda"; mkdir -p "$P/specs"; git init -q "$P"
cat > "$P/specs/story-9.22-sonda.md" <<'HISTORIA'
---
story: "9.22"
status: in-progress
---
# Story 9.22

## Acceptance Criteria

1. **Given** la consulta, **When** se pide, **Then** responde en menos de 2 s. @measure(duration < 2s)

### Tests

| ID | Test | AC | Nivel | Escenario | Esperado |
|---|---|---|---|---|---|
| T1 | `Sonda_Responde` | 1 | integration | x | y |
HISTORIA
PEV="$P/.advisors/dod-runtime"
matriz(){ node "$SK/runtime-matrix.js" --story "$P/specs/story-9.22-sonda.md" --evidence-dir "$PEV" --json --no-write 2>/dev/null; }
veredicto(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String(r.perAc[1].verdict))})'; }
bash "$SMOKE" "$PEV" "$P/specs/story-9.22-sonda.md" --acs 1 --pass-if 'responde en menos de 2 s' -- bash -c 'sleep 3; echo respuesta' >/dev/null 2>&1
v1="$(matriz | veredicto)"; matriz >/dev/null; rc1=$?
sleep 1
bash "$SMOKE" "$PEV" "$P/specs/story-9.22-sonda.md" --acs 1 --pass-if 'responde en menos de 2 s' -- bash -c 'sleep 1; echo respuesta' >/dev/null 2>&1
v2="$(matriz | veredicto)"; matriz >/dev/null; rc2=$?
if [ "$v1" = FUERA-DE-COTA ] && [ "$rc1" = 1 ] && [ "$v2" = RUNTIME ] && [ "$rc2" = 0 ]; then
  ok "T22 la sonda: sleep 3 → FUERA-DE-COTA y la matriz sale 1; sleep 1 → RUNTIME y sale 0"
else
  no "T22 la sonda: primero $v1 (sale $rc1), después $v2 (sale $rc2)"
fi

# ── T26 — una suite que sale 0 diciendo «NO MEDIDO» en su última línea no es verde ───────────────────────────
# La misma regla que el nocturno (pipelines/azure-pipelines-banco.yml): salir 0 con la última línea no vacía
# «⏭ <suite>: NO MEDIDO — <motivo>» es «no se midió». El humo lo registra con exit 77 y el motivo, en el registro y en el
# espejo, y la matriz no lo cuenta. Una marca que no es la última línea no cambia nada, y un rojo sigue rojo.
Q="$TMP/no-medido"; mkdir -p "$Q/specs"; git init -q "$Q"
cat > "$Q/specs/story-9.26-no-medido.md" <<'HISTORIA'
---
story: "9.26"
status: in-progress
---
# Story 9.26

## Acceptance Criteria

1. **Given** el freno, **When** corre su suite, **Then** frena.

### Tests

| ID | Test | AC | Nivel | Escenario | Esperado |
|---|---|---|---|---|---|
| T1 | `Freno_Frena` | 1 | integration | x | y |
HISTORIA
QEV="$Q/.advisors/dod-runtime"; QR="$QEV/9.26-smoke-ledger.jsonl"
matriz26(){ node "$SK/runtime-matrix.js" --story "$Q/specs/story-9.26-no-medido.md" --evidence-dir "$QEV" --json --no-write 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String(r.perAc[1].verdict))})'; }
aviso26="$(bash "$SMOKE" "$QEV" "$Q/specs/story-9.26-no-medido.md" --acs 1 --pass-if 'la suite sale verde' -- \
  printf 'arranca\n⏭ prod-guard: NO MEDIDO — esta máquina tiene el freno instalado\n\n' 2>&1 >/dev/null)"; rc26=$?
v26="$(matriz26)"
if [ "$rc26" = 77 ] && [ "$(ultima "$QR" 'e.exit')" = 77 ] && [ "$(ultima "$GATES" 'e.exit')" = 77 ] \
  && [ "$(ultima "$QR" 'e.not_measured')" = 'esta máquina tiene el freno instalado' ] \
  && [ "$(ultima "$GATES" 'e.not_measured')" = 'esta máquina tiene el freno instalado' ] \
  && [ "$v26" != RUNTIME ] && echo "$aviso26" | grep 'NO MEDIDO' >/dev/null; then
  ok "T26 «⏭ …: NO MEDIDO» en la última línea con exit 0 → exit 77 con su motivo, y la matriz no lo cuenta ($v26)"
else
  no "T26 no medido: sale $rc26, matriz $v26, $(tail -1 "$QR" 2>/dev/null) · aviso: $aviso26"
fi
bash "$SMOKE" "$QEV" "$Q/specs/story-9.26-no-medido.md" --acs 1 --pass-if 'la suite sale verde' -- \
  printf '⏭ una-parte: NO MEDIDO — sin pwsh\n✅ prod-guard: 12 ok\n' >/dev/null 2>&1; rc26b=$?
v26b="$(matriz26)"
bash "$SMOKE" "$QEV" "$Q/specs/story-9.26-no-medido.md" --acs 1 --pass-if 'la suite sale verde' -- \
  sh -c 'echo "⏭ prod-guard: NO MEDIDO — algo"; exit 1' >/dev/null 2>&1; rc26c=$?
if [ "$rc26b" = 0 ] && [ "$v26b" = RUNTIME ] && [ "$rc26c" = 1 ] && [ "$(ultima "$QR" 'e.exit')" = 1 ] \
  && [ "$(ultima "$QR" '"not_measured" in e')" = false ]; then
  ok "T26 la marca antes de la última línea sigue verde, y un rojo con la marca sigue rojo (exit 1)"
else
  no "T26 controles: marca en el medio sale $rc26b (matriz $v26b); rojo con marca sale $rc26c, $(tail -1 "$QR" 2>/dev/null)"
fi

echo
echo "smoke-measure: $pasaron ok, $fallos con falla"
[ "$fallos" = 0 ]
