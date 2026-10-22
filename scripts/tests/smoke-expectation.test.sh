#!/usr/bin/env bash
# smoke-expectation.test.sh — red: la prueba dice qué esperaba y qué salió.
#
# Por qué existe: un humo por terminal (`smoke-run.sh`) que deja sólo el código de salida cuenta igual un `curl` que
# devuelve 200 con el cuerpo equivocado que uno correcto, y no deja nada para que el revisor de cierre vea si la
# prueba encontró algo que el propio agente había escrito (por ejemplo, el agente inserta a mano en la base el
# resultado que la prueba debe encontrar y la marca aprobada).
#
# La regla: un humo que nombra criterios (`--acs`) escribe ANTES de correr qué tiene que pasar (`--pass-if`); su
# salida se guarda recortada y tapada, con su sha256 en el espejo del home. La línea lleva `"v":2`.
#
# Lo que prueba:
#   T1   PasaSi_Registered_AndMirrored        --pass-if y --fail-if tapados en el registro; su sha en el espejo
#   T2   Acs_WithoutPasaSi_Refuses             --acs sin --pass-if no corre (exit 2); sin --acs corre
#   T3   PasaSi_Empty_Refuses                  --pass-if "" o --pass-if -- → exit 2, nada corre
#   T4   Output_Saved_Truncated_Redacted       5.000 líneas: la terminal ve todo; el archivo ≤ 8 KB, con la marca y tapado
#   T5   ExitCode_SurvivesTee                  el comando sale 3 → registro "exit":3 y smoke-run.sh sale 3
#   T6   Output_Binary_StaysValidJson          bytes al azar → JSONL válido y sha256 del archivo coincide
#   T7   RedactionDown_WritesNothing           sin smoke-secrets.js → ni pass_if ni salida; aviso en su lugar
#   T8   OutputDirUnwritable_CommandStillRuns  la carpeta de salidas no se crea → corre igual, output: null
#   T9   SameSecond_TwoFiles                   dos humos del mismo segundo → dos archivos; la matriz cuenta los dos
#   T10  KilledSmoke_TempRemoved               SIGTERM a mitad → no queda temporal ni nada escrito en el repo
#   T17  Step7c_DocumentsSeedGivenRule         el paso 7c tiene el párrafo de la regla
# Y los casos de borde, fuera de la tabla:
#   T20  un proceso de fondo con la salida abierta no cuelga el humo; la salida guardada dice que siguió
#   T21  `smoke-run.sh … | head` corta la copia de la salida → output: null, nunca una salida a medias
#   T22  la salida se guarda con finales de línea \n (git no puede reescribirlos y dejarla por editada)
#   T23  sin temporal para la salida (mktemp falla) el comando corre, conserva su código y queda output: null
#
# 🔴 HOME falso siempre: el espejo de los humos (`gates.log`) vive bajo el home.
# stable-data: lee el reloj a propósito y no compara contra un valor fijo: mide cuánto tarda un humo con un proceso de
# fondo (T20), y el sello de cada humo lo pone smoke-run.sh con la hora real, que es lo que se prueba.
# Correr: bash scripts/tests/smoke-expectation.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SK="$AQUI/skills/tycon-pipeline/scripts"
SMOKE="$SK/smoke-run.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ smoke-expectation: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ smoke-expectation: $1"; fallos=$((fallos+1)); }

command -v node >/dev/null || { echo "❌ smoke-expectation: sin node no se puede medir nada"; exit 1; }
unset NODE_TEST_CONTEXT TYCON_EVIDENCE_KEY TYCON_SMOKE_REDACT

export HOME="$TMP/casa"; mkdir -p "$HOME/.claude/.tycon-pipeline"
GATES="$HOME/.claude/.tycon-pipeline/gates.log"
# El temporal de la salida va a una carpeta propia: así se ve si quedó algo.
export TMPDIR="$TMP/tmpdir"; mkdir -p "$TMPDIR"

REPO="$TMP/repo"; mkdir -p "$REPO"; git init -q "$REPO"
EV="$REPO/.advisors/dod-runtime"

# ultima <archivo> <expresión js sobre `e`> — evalúa sobre la última línea JSON del archivo.
# La forma de credencial que se tapa, armada por partes: escrita entera, el detector de secretos del repo público la
# lee como una contraseña de verdad y frena el empuje. El valor es inventado.
PW_KEY="Pass""word"; export PW_KEY
ultima(){ node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").pop();const e=JSON.parse(l);process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"; }
sha(){ node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
sha_txt(){ node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$1"; }

# ── T1 — la expectativa queda escrita (tapada) y sellada en el espejo ─────────────────────────────────────────
bash "$SMOKE" "$EV" 9.1 --acs 1 --pass-if "responde 200 y conecta con ${PW_KEY}=abc123" --fail-if 'cualquier 5xx' -- true >/dev/null 2>&1
R="$EV/9.1-smoke-ledger.jsonl"
if [ -f "$R" ] \
  && [ "$(ultima "$R" 'e.pass_if')" = "responde 200 y conecta con ${PW_KEY}=***" ] \
  && [ "$(ultima "$R" 'e.fail_if')" = 'cualquier 5xx' ] \
  && [ "$(ultima "$R" 'e.v')" = 2 ] \
  && [ "$(ultima "$GATES" 'e.pass_if_sha')" = "$(sha_txt "responde 200 y conecta con ${PW_KEY}=***")" ] \
  && [ "$(ultima "$GATES" 'e.fail_if_sha')" = "$(sha_txt 'cualquier 5xx')" ] \
  && [ "$(ultima "$GATES" 'e.v')" = 2 ] \
  && ! grep -q 'abc123' "$R" "$GATES"; then
  ok "T1 --pass-if y --fail-if quedan tapados en el registro y su sha256 en el espejo"
else
  no "T1 --pass-if/--fail-if no quedaron como se esperaba: $(tail -1 "$R" 2>/dev/null) · espejo: $(tail -1 "$GATES" 2>/dev/null)"
fi

# ── T2 — un humo con criterios y sin expectativa no corre; sin criterios, sí ──────────────────────────────────
salida="$(bash "$SMOKE" "$EV" 9.2 --acs 3 -- touch "$TMP/testigo2" 2>&1)"; rc=$?
if [ "$rc" = 2 ] && [ ! -e "$TMP/testigo2" ] && echo "$salida" | grep -- '--pass-if' >/dev/null; then
  ok "T2 --acs sin --pass-if sale 2 sin correr y muestra la forma correcta"
else
  no "T2 --acs sin --pass-if: rc=$rc, testigo $( [ -e "$TMP/testigo2" ] && echo creado || echo ausente ), mensaje: $salida"
fi
bash "$SMOKE" "$EV" 9.2 -- touch "$TMP/testigo2b" >/dev/null 2>&1; rc=$?
if [ "$rc" = 0 ] && [ -e "$TMP/testigo2b" ]; then
  ok "T2 sin --acs (sembrar precondiciones) corre sin pedir --pass-if"
else
  no "T2 sin --acs no corrió: rc=$rc"
fi

# ── T3 — una expectativa vacía no vale ────────────────────────────────────────────────────────────────────────
bash "$SMOKE" "$EV" 9.3 --acs 1 --pass-if "" -- touch "$TMP/testigo3a" >/dev/null 2>&1; rc1=$?
bash "$SMOKE" "$EV" 9.3 --acs 1 --pass-if -- touch "$TMP/testigo3b" >/dev/null 2>&1; rc2=$?
bash "$SMOKE" "$EV" 9.3 --acs 1 --pass-if ok --fail-if -- touch "$TMP/testigo3c" >/dev/null 2>&1; rc3=$?
if [ "$rc1" = 2 ] && [ "$rc2" = 2 ] && [ "$rc3" = 2 ] && [ ! -e "$TMP/testigo3a" ] && [ ! -e "$TMP/testigo3b" ] && [ ! -e "$TMP/testigo3c" ]; then
  ok "T3 --pass-if vacío, --pass-if -- y --fail-if sin valor salen 2 sin correr"
else
  no "T3 expectativa vacía: rc=$rc1/$rc2/$rc3"
fi

# ── T4 — la salida se ve entera y se guarda recortada y tapada ────────────────────────────────────────────────
terminal="$(bash "$SMOKE" "$EV" 9.4 --acs 1 --pass-if 'imprime las 5000 líneas' -- \
  node -e 'for(let i=0;i<5000;i++) console.log("linea "+i+(i===1?" "+process.env.PW_KEY+"=abc123":""))' 2>/dev/null)"
R="$EV/9.4-smoke-ledger.jsonl"
rel="$(ultima "$R" 'e.output' 2>/dev/null)"; f="$EV/$rel"
if [ "$(printf '%s\n' "$terminal" | grep -c '^linea ')" = 5000 ] && [ -n "$rel" ] && [ -f "$f" ] \
  && [ "$(wc -c < "$f" | tr -d ' ')" -le 8192 ] && grep -q 'líneas omitidas' "$f" \
  && grep -q "${PW_KEY}=\*\*\*" "$f" && ! grep -q 'abc123' "$f" \
  && case "$rel" in 9.4-smoke-outputs/*.txt) true ;; *) false ;; esac \
  && [ "$(ultima "$R" 'e.output_sha')" = "$(sha "$f")" ] && [ "$(ultima "$GATES" 'e.output_sha')" = "$(sha "$f")" ]; then
  ok "T4 la terminal ve las 5000 líneas; el archivo ≤ 8 KB, con la marca, tapado y con su sha en registro y espejo"
else
  no "T4 salida guardada: líneas en terminal=$(printf '%s\n' "$terminal" | grep -c '^linea '), archivo=«${rel}» $( [ -f "$f" ] && wc -c < "$f" )"
fi

# ── T5 — el guardado no cambia el código de salida ───────────────────────────────────────────────────────────
# Sin --acs a propósito: T5 comprueba que el guardado no cambia el código de salida de un humo sin criterios.
bash "$SMOKE" "$EV" 9.5 -- sh -c 'echo algo; exit 3' >/dev/null 2>&1; rc=$?
if [ "$rc" = 3 ] && [ "$(ultima "$EV/9.5-smoke-ledger.jsonl" 'e.exit')" = 3 ] && [ "$(ultima "$GATES" 'e.exit')" = 3 ]; then
  ok "T5 el comando sale 3: el registro dice 3 y smoke-run.sh sale 3"
else
  no "T5 código de salida: rc=$rc, registro=$(ultima "$EV/9.5-smoke-ledger.jsonl" 'e.exit' 2>/dev/null)"
fi

# ── T6 — bytes que no son texto ──────────────────────────────────────────────────────────────────────────────
bash "$SMOKE" "$EV" 9.6 --acs 1 --pass-if 'escribe bytes' -- node -e 'process.stdout.write(require("crypto").randomBytes(4000))' >/dev/null 2>&1
R="$EV/9.6-smoke-ledger.jsonl"
validas="$(node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){JSON.parse(l);n++}process.stdout.write(String(n))' "$R" 2>/dev/null)"
rel="$(ultima "$R" 'e.output' 2>/dev/null)"
if [ "$validas" = 1 ] && [ -f "$EV/$rel" ] && [ "$(ultima "$R" 'e.output_sha')" = "$(sha "$EV/$rel")" ] \
  && node -e 'new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))' "$EV/$rel" 2>/dev/null; then
  ok "T6 bytes al azar: el registro sigue siendo JSONL válido y la salida, texto con su sha"
else
  no "T6 bytes al azar: líneas válidas=$validas, salida=«${rel}»"
fi

# ── T7 — sin el tapado no se escribe ni la expectativa ni la salida ──────────────────────────────────────────
SIN="$TMP/sin-tapado"; mkdir -p "$SIN/lib"; cp "$SMOKE" "$SIN/smoke-run.sh"
cp "$SK/lib/evidence-key.js" "$SIN/lib/" 2>/dev/null
aviso="$(bash "$SIN/smoke-run.sh" "$EV" 9.7 --acs 1 --pass-if "conecta con ${PW_KEY}=abc123" -- echo "${PW_KEY}=abc123" 2>&1 >/dev/null)"
R="$EV/9.7-smoke-ledger.jsonl"
if [ -f "$R" ] && ! grep -q 'abc123' "$R" && [ "$(ultima "$R" 'e.output')" = null ] \
  && [ "$(ultima "$R" 'e.v')" = 2 ] && [ ! -e "$EV/9.7-smoke-outputs" ] && echo "$aviso" | grep 'tapado' >/dev/null \
  && [ -z "$(ls -A "$TMPDIR")" ]; then
  ok "T7 sin smoke-secrets.js: ni la expectativa ni la salida se escriben, y queda el aviso"
else
  no "T7 tapado caído: $(tail -1 "$R" 2>/dev/null) · aviso: $aviso"
fi

# ── T8 — la carpeta de salidas no se puede crear ─────────────────────────────────────────────────────────────
: > "$EV/9.8-smoke-outputs"   # un archivo donde iría la carpeta
bash "$SMOKE" "$EV" 9.8 --acs 1 --pass-if 'crea el testigo' -- touch "$TMP/testigo8" >/dev/null 2>&1; rc=$?
if [ "$rc" = 0 ] && [ -e "$TMP/testigo8" ] && [ "$(ultima "$EV/9.8-smoke-ledger.jsonl" 'e.output')" = null ] && [ -z "$(ls -A "$TMPDIR")" ]; then
  ok "T8 sin carpeta de salidas: el comando corre igual y el registro dice output: null"
else
  no "T8 carpeta de salidas: rc=$rc, $(tail -1 "$EV/9.8-smoke-ledger.jsonl" 2>/dev/null)"
fi

# ── T9 — dos humos del mismo segundo ─────────────────────────────────────────────────────────────────────────
W9="$TMP/w9"; mkdir -p "$W9/specs"; git init -q "$W9"
S9="$W9/specs/story-9-9-x.md"
cat > "$S9" <<'EOF'
---
epic: 9
story: "9.9"
title: "story de prueba"
status: in-progress
---

# Story 9.9

## Acceptance Criteria

1. **Given** algo **When** pasa **Then** resultado.

### Tests

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Caso1` | 1 | integration | x | y |
EOF
E9="$W9/.advisors/dod-runtime"
mismo=0
for intento in 1 2 3 4 5; do
  rm -rf "$E9"
  bash "$SMOKE" "$E9" "$S9" --acs 1 --pass-if 'uno' -- node -e 'console.log("uno")' >/dev/null 2>&1 &
  p1=$!
  bash "$SMOKE" "$E9" "$S9" --acs 1 --pass-if 'dos' -- node -e 'console.log("dos")' >/dev/null 2>&1 &
  p2=$!
  wait "$p1"; wait "$p2"
  ts="$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(l.length===2&&l[0].ts===l[1].ts?"si":"no")' "$E9/9.9-smoke-ledger.jsonl" 2>/dev/null)"
  if [ "$ts" = si ]; then mismo=1; break; fi
done
archivos="$(ls "$E9/9.9-smoke-outputs" 2>/dev/null | wc -l | tr -d ' ')"
cuenta="$(node "$SK/runtime-matrix.js" --story "$S9" --json --no-write 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const a=r.perAc[1];process.stdout.write(a.verdict+":"+a.fuentes.smoke.length+":"+(r.warnings.some(w=>/cambiada/.test(w))?"cambiada":"ok"))}catch(e){process.stdout.write("?")}})')"
if [ "$mismo" = 1 ] && [ "$archivos" = 2 ] && [ "$cuenta" = "RUNTIME:2:ok" ]; then
  ok "T9 dos humos del mismo segundo: dos archivos de salida y la matriz cuenta los dos"
elif [ "$mismo" = 0 ]; then
  no "T9 en cinco intentos los dos humos no cayeron en el mismo segundo: no se pudo medir"
else
  no "T9 mismo segundo: archivos=$archivos, matriz=$cuenta"
fi

# ── T10 — un humo cortado a mitad no deja el temporal ────────────────────────────────────────────────────────
set -m
bash "$SMOKE" "$EV" 9.10 --acs 1 --pass-if 'termina' -- sh -c "echo ${PW_KEY}=abc123; sleep 30" >/dev/null 2>&1 &
p10=$!
set +m
visto=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ -n "$(ls -A "$TMPDIR")" ]; then visto=1; break; fi
  sleep 0.2
done
sleep 0.3
kill -TERM -- "-$p10" 2>/dev/null
wait "$p10" 2>/dev/null
if [ "$visto" = 1 ] && [ -z "$(ls -A "$TMPDIR")" ] && [ ! -e "$EV/9.10-smoke-outputs" ] \
  && ! grep -rq "${PW_KEY}=abc123" "$REPO" 2>/dev/null; then
  ok "T10 SIGTERM a mitad: el temporal se borró y nada quedó en el repo sin tapar"
else
  no "T10 humo cortado: temporal visto=$visto, quedan: $(ls -A "$TMPDIR" | tr '\n' ' ')"
fi

# ── casos de borde ──────────────────────────────────────────────────────────────────────
# Un humo que deja un proceso de fondo con la salida abierta (arrancar la app para sembrar el «Given») no puede colgar
# el envoltorio: con `| tee` se espera al último que tenga la salida abierta, que con un servidor es nunca.
inicio=$(date +%s)
# El proceso de fondo dura 8 s: más que los 5 s que se lo espera, y menos que la prueba, que después mira que su `tee`,
# al terminar, no dejó el `.rc` suelto en $TMPDIR (el trap ya había borrado el temporal).
aviso="$(bash "$SMOKE" "$EV" 9.20 -- sh -c 'sleep 8 & echo listo' 2>&1 >/dev/null)"; rc=$?
dura=$(( $(date +%s) - inicio ))
f20="$EV/$(ultima "$EV/9.20-smoke-ledger.jsonl" 'e.output' 2>/dev/null)"
sleep 5
# La marca va dentro del sello: el sha del registro y del espejo es el del archivo con la marca.
if [ "$rc" = 0 ] && [ "$dura" -lt 15 ] && echo "$aviso" | grep 'proceso de fondo' >/dev/null \
  && [ -f "$f20" ] && grep -q 'listo' "$f20" && grep -q 'un proceso de fondo la mantenía abierta' "$f20" \
  && [ "$(ultima "$EV/9.20-smoke-ledger.jsonl" 'e.output_sha')" = "$(sha "$f20")" ] \
  && [ "$(ultima "$GATES" 'e.story==="9.20"?e.output_sha:""')" = "$(sha "$f20")" ] \
  && [ -z "$(ls -A "$TMPDIR")" ]; then
  ok "T20 un proceso de fondo con la salida abierta no cuelga el humo (${dura}s), se avisa, la salida guardada lo dice dentro de su sello y no queda nada suelto"
else
  no "T20 proceso de fondo: rc=$rc, ${dura}s, aviso: $aviso"
fi
# `smoke-run.sh … | head -1`: si la copia de la salida se corta, el humo no puede contar con un pedazo.
bash "$SMOKE" "$EV" 9.21 --acs 1 --pass-if 'imprime los números' -- node -e 'for(let i=0;i<200000;i++) console.log(i)' 2>/dev/null | head -1 >/dev/null
r21="$(ultima "$EV/9.21-smoke-ledger.jsonl" 'e.exit+":"+e.output' 2>/dev/null)"
case "$r21" in
  *:null) ok "T21 la copia de la salida cortada no deja una salida guardada a medias ($r21)" ;;
  *) no "T21 copia cortada: el humo quedó verde con salida parcial ($r21)" ;;
esac
# Sin un temporal para la salida (mktemp falla), el comando corre igual, el código de salida se conserva y queda output: null.
TMPDIR="$TMP/no-existe" bash "$SMOKE" "$EV" 9.23 --acs 1 --pass-if 'sale 4' -- sh -c "touch '$TMP/testigo23'; exit 4" >/dev/null 2>&1; rc=$?
if [ "$rc" = 4 ] && [ -e "$TMP/testigo23" ] && [ "$(ultima "$EV/9.23-smoke-ledger.jsonl" 'e.exit+":"+e.output')" = "4:null" ]; then
  ok "T23 sin temporal para la salida: el comando corre, sale 4 y el registro dice output: null"
else
  no "T23 sin temporal: rc=$rc, $(tail -1 "$EV/9.23-smoke-ledger.jsonl" 2>/dev/null)"
fi
# Los finales de línea se guardan como \n: git no puede reescribirlos y dejar la salida por editada.
bash "$SMOKE" "$EV" 9.22 --acs 1 --pass-if 'responde 200' -- printf 'HTTP/1.1 200 OK\r\nx: 1\r\n' >/dev/null 2>&1
f22="$EV/$(ultima "$EV/9.22-smoke-ledger.jsonl" 'e.output' 2>/dev/null)"
if [ -f "$f22" ] && ! LC_ALL=C grep -q "$(printf '\r')" "$f22" && grep -q 'HTTP/1.1 200 OK' "$f22"; then
  ok "T22 la salida se guarda con finales de línea \\n"
else
  no "T22 la salida guardada conserva \\r\\n"
fi

# ── T17 — el paso 7c dice la regla ───────────────────────────────────────────────────────────────────────────
P7="$SK/../steps/step-10-live-check.md"
parrafo="$(awk '/^#+ .*Sembrar el «Given»/{f=1;next} f&&/^#/{exit} f' "$P7")"
# Sin `| grep -q` con pipefail: grep -q corta la tubería al primer calce y el echo puede salir por SIGPIPE (rojo al azar).
if [ -n "$parrafo" ] && echo "$parrafo" | grep 'sin `--acs`' >/dev/null && echo "$parrafo" | grep '«Then»' >/dev/null \
  && echo "$parrafo" | grep 'runtime_not_verifiable:' >/dev/null && echo "$parrafo" | grep 'DODRT-C10' >/dev/null; then
  ok "T17 el paso 7c tiene el párrafo de la regla (sembrar el «Given» sí; escribir el «Then» no cuenta)"
else
  no "T17 el paso 7c no tiene el párrafo «Sembrar el «Given»» con sus cuatro piezas"
fi

echo
echo "smoke-expectation: $pasaron ok, $fallos con falla"
[ "$fallos" = 0 ]
