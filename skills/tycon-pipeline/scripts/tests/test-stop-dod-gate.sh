#!/usr/bin/env bash
# Test en aislamiento del Stop-hook portón de autonomía (on-stop-dod-gate.js).
# Inyecta marker states bajo un sessionId de prueba + alimenta eventos Stop fake →
# verifica allow / block / escalate + los frenos. NO wirea nada vivo. Limpia al final.
set -u
cd "$(dirname "$0")/.."
# 🔴 HOME falso. Sin él, esta suite correría contra el HOME REAL del dev: al empezar BORRARÍA su
# `STOP_AUTONOMY` (soltando un freno que una persona puso a propósito) y en el caso H lo CREA
# — frenando, en esa ventana, cualquier otra corrida autónoma de la máquina que cerrara turno. Un test
# no puede tocar el estado vivo de otra corrida. Los `~` de abajo salen de acá.
export HOME="$(mktemp -d)"
trap 'rm -rf "$HOME"' EXIT
HOOK=on-stop-dod-gate.js
SID=stoptest
MK=~/.claude/.tycon-pipeline/active/$SID.json
EV='{"session_id":"stoptest"}'
mkdir -p ~/.claude/.tycon-pipeline/active
rm -f ~/.claude/.tycon-pipeline/STOP_AUTONOMY   # higiene: un archivo stale haría escalar TODO
fail=0
run() { printf '%s' "$EV" | node "$HOOK" 2>&1; }
# Corre el hook capturando SOLO stdout (sin stderr) + el exit code en RC.
# Necesario para validar el CONTRATO exacto que Claude Code exige (stdout = JSON puro, exit 0).
run_strict() { OUT=$(printf '%s' "$EV" | node "$HOOK" 2>/dev/null); RC=$?; }

node --check "$HOOK" || { echo "✗ syntax"; exit 1; }

# A) no autónomo → allow (sin output)
echo '{"storyId":"X","autonomous":false}' > "$MK"
[ -z "$(run)" ] && echo "✓ A no-autónomo → allow" || { echo "✗ A"; fail=1; }

# B) todo verde → allow
echo '{"storyId":"X","autonomous":true,"checks":{"build":"green","tests":"green"}}' > "$MK"
[ -z "$(run)" ] && echo "✓ B verde → allow" || { echo "✗ B"; fail=1; }

# B2) sin checks registrados (pre-ejecución / pausa HITL) → allow.
# 🔴 Semántica: el hook bloquea SOLO ante check rojo, no ante ausencia. Un fin de
# turno sin nada medido (Step 3 plan-approval, Step 7 waive, pregunta al humano) NO se traba.
echo '{"storyId":"X","autonomous":true,"checks":{}}' > "$MK"
[ -z "$(run)" ] && echo "✓ B2 sin checks (pausa HITL) → allow" || { echo "✗ B2 — gate trabó una pausa HITL"; fail=1; }

# B3) un check verde + otro AUSENTE → allow (ausente ≠ rojo; completitud la cubre el commit hook)
echo '{"storyId":"X","autonomous":true,"checks":{"build":"green"}}' > "$MK"
[ -z "$(run)" ] && echo "✓ B3 build verde + resto ausente → allow" || { echo "✗ B3"; fail=1; }

# C) rojo con margen → block + iter++
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"tests":"red:x"}}' > "$MK"
run | grep -q '"decision":"block"' && grep -q '"iter": 1' "$MK" && echo "✓ C rojo → block + iter++" || { echo "✗ C"; fail=1; }

# D) cap de iteraciones → escala (autonomous→false)
echo '{"storyId":"X","autonomous":true,"iter":5,"checks":{"tests":"red:x"}}' > "$MK"
run | grep -q 'AUTONOMÍA DETENIDA' && grep -q '"autonomous": false' "$MK" && echo "✓ D cap → escala" || { echo "✗ D"; fail=1; }

# E) no-progreso (mismos fallos, streak 2→3) → escala
echo '{"storyId":"X","autonomous":true,"iter":1,"noProgressStreak":2,"lastFailures":["tests → red:x"],"checks":{"tests":"red:x"}}' > "$MK"
run | grep -q 'thrashing' && grep -q '"autonomous": false' "$MK" && echo "✓ E no-progreso → escala" || { echo "✗ E"; fail=1; }

# F) hard-escape (variable de entorno) → escala
echo '{"storyId":"X","autonomous":true,"checks":{"tests":"red:x"}}' > "$MK"
STOP_AUTONOMY=1 bash -c "printf '%s' '$EV' | node $HOOK" | grep -q 'hard-escape' && echo "✓ F hard-escape (env) → escala" || { echo "✗ F"; fail=1; }

# ─────────────────────────────────────────────────────────────────────────────
# CONTRATO + casos de seguridad ("la prueba del freno"):
# fijan el formato exacto que Claude Code exige del hook + las propiedades de
# fail-open y no-escalado-prematuro.
# ─────────────────────────────────────────────────────────────────────────────

# G) CONTRATO DE BLOQUEO — el caso crítico. Claude Code SOLO bloquea el stop si stdout es
#    EXACTAMENTE un JSON parseable {"decision":"block","reason":<no vacío>} con exit 0.
#    Cualquier línea extra en stdout rompe el parse → el hook no bloquearía (no-op silencioso).
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"tests":"red:x"}}' > "$MK"
run_strict
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | node -e '
  const s = require("fs").readFileSync(0, "utf8").trim();
  const o = JSON.parse(s);                         // tira si stdout NO es JSON puro
  if (o.decision !== "block") process.exit(3);
  if (!o.reason || !o.reason.length) process.exit(4);
' 2>/dev/null; then
  echo "✓ G CONTRATO block (stdout=JSON puro · decision=block · reason · exit 0)"
else
  echo "✗ G — contrato de bloqueo INVÁLIDO (RC=$RC) — el hook NO bloquearía en vivo"; fail=1
fi

# G2) CONTRATO ALLOW — dejar parar = stdout VACÍO + exit 0 (sin JSON).
echo '{"storyId":"X","autonomous":true,"checks":{"build":"green","tests":"green"}}' > "$MK"
run_strict
[ "$RC" -eq 0 ] && [ -z "$OUT" ] && echo "✓ G2 CONTRATO allow (stdout vacío + exit 0)" || { echo "✗ G2 — allow mal formado (RC=$RC, OUT='$OUT')"; fail=1; }

# H) hard-escape por ARCHIVO (no solo env var) → escala
echo '{"storyId":"X","autonomous":true,"checks":{"tests":"red:x"}}' > "$MK"
touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY
run | grep -q 'hard-escape' && echo "✓ H hard-escape (archivo) → escala" || { echo "✗ H"; fail=1; }
rm -f ~/.claude/.tycon-pipeline/STOP_AUTONOMY

# I) marker CORRUPTO → fail-open (allow, sin output). Un bug NO debe trabar a Claude.
printf '{ no-es-json ' > "$MK"
[ -z "$(run)" ] && echo "✓ I marker corrupto → allow (fail-open)" || { echo "✗ I — NO fail-open ante marker corrupto (foot-gun)"; fail=1; }

# J) SIN marker → allow (sesión normal, no autónoma)
rm -f "$MK"
[ -z "$(run)" ] && echo "✓ J sin marker → allow" || { echo "✗ J"; fail=1; }

# K) PROGRESO resetea el streak → NO escala antes de tiempo. Con 2 checks en rojo;
#    si queda 1 (resolvió uno) → progressed → noProgressStreak vuelve a 0, sigue iterando.
echo '{"storyId":"X","autonomous":true,"iter":1,"noProgressStreak":2,"lastFailures":["tests → red:x","build → red:y"],"checks":{"tests":"red:x"}}' > "$MK"
OUT="$(run)"
if printf '%s' "$OUT" | grep -q 'thrashing'; then
  echo "✗ K — escaló pese a haber PROGRESO (escalado prematuro)"; fail=1
elif printf '%s' "$OUT" | grep -q '"decision":"block"' && grep -q '"noProgressStreak": 0' "$MK"; then
  echo "✓ K progreso → streak reset (0), sigue iterando sin escalar"
else
  echo "✗ K"; fail=1
fi

# L) stdin INVÁLIDO → allow (fail-open del parse, antes de tocar el marker)
echo '{"storyId":"X","autonomous":true,"checks":{"tests":"red:x"}}' > "$MK"
OUT="$(printf 'not-json{' | node "$HOOK" 2>/dev/null)"; RC=$?
[ "$RC" -eq 0 ] && [ -z "$OUT" ] && echo "✓ L stdin inválido → allow (fail-open)" || { echo "✗ L (RC=$RC)"; fail=1; }

# ─────────────────────────────────────────────────────────────────────────────
# Set-check endurecido: un green NO se puede colar sin --manual explícito.
# El Stop-gate confía en marker.checks, así que escribir un green debe ser run-check
# (ground-truth) o --manual deliberado/auditable. set-check resuelve el marker por
# CLAUDE_CODE_SESSION_ID → se aísla en '$SID' para no tocar el marker de la sesión real.
# ─────────────────────────────────────────────────────────────────────────────

# M) set-check SIN --manual → RECHAZADO (exit≠0) y NO setea el check
echo '{"storyId":"X","autonomous":true,"checks":{}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID node marker.js set-check tests green >/dev/null 2>&1; RC=$?
if [ "$RC" -ne 0 ] && ! grep -q '"tests"' "$MK"; then
  echo "✓ M set-check sin --manual → RECHAZADO + no setea (anti green falso)"
else
  echo "✗ M — set-check coló un green SIN --manual (RC=$RC) — loophole abierto"; fail=1
fi

# M2) set-check CON --manual → OK (exit 0), setea check + provenance manual (override auditable)
echo '{"storyId":"X","autonomous":true,"checks":{}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID node marker.js set-check build green --manual >/dev/null 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q '"build": "green"' "$MK" && grep -q '"build": "manual"' "$MK"; then
  echo "✓ M2 set-check --manual → OK + provenance=manual (escape sancionado)"
else
  echo "✗ M2 (RC=$RC) — el override manual explícito debería funcionar"; fail=1
fi

# N) SÓLO la matriz en rojo → el bloqueo dice cómo salir
# 🔴 Sin esto, el hook loopea sobre un rojo que sólo el dev puede poner en verde, sin decir cómo salir.
# 🔴 La pista no puede mandar a `touch STOP_AUTONOMY`, que frena TODAS las corridas de la máquina.
# Manda al tercer estado (`set-flag waitingForHuman`), y este caso lo EXIGE — no se conforma
# con ver la palabra STOP_AUTONOMY en cualquier contexto, así que una pista vieja y una nueva pasarían igual.
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"tests":"green","acmatrix":"red:exit=1"}}' > "$MK"
OUTN=$(run)
if echo "$OUTN" | grep -q '"decision":"block"' && echo "$OUTN" | grep -q 'runtime-waiver' && echo "$OUTN" | grep -q 'waitingForHuman'; then
  echo "✓ N sólo acmatrix rojo → block CON pista del waiver TTY y del tercer estado"
else
  echo "✗ N — el bloqueo por acmatrix no dice cómo salir (waiver TTY / waitingForHuman)"; fail=1
fi

# N3) El tercer estado: con un rojo puesto, el agente puede cerrar el turno para preguntarle al dev,
# sin que la autonomía se apague. De un solo uso: el flag se consume y al turno siguiente vuelve a morder.
# 🔴 Sin esto no existe salida: la única sería el archivo global, que apaga el portón para siempre.
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"acmatrix":"red:exit=1"},"waitingForHuman":true}' > "$MK"
OUTN3=$(run)
if [ -z "$OUTN3" ] \
  && grep -q '"autonomous": true' "$MK" \
  && ! grep -q 'waitingForHuman' "$MK" \
  && echo "$(run)" | grep -q '"decision":"block"'; then
  echo "✓ N3 waitingForHuman → deja cerrar, NO apaga la autonomía, se consume, y al turno siguiente bloquea"
else
  echo "✗ N3 — el tercer estado no deja cerrar, apaga la autonomía, o no se consume"; fail=1
fi

# N2) acmatrix rojo JUNTO a tests rojo → sin la pista (hay algo que el agente SÍ puede arreglar)
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"tests":"red:x","acmatrix":"red:exit=1"}}' > "$MK"
OUTN=$(run)
if echo "$OUTN" | grep -q '"decision":"block"' && ! echo "$OUTN" | grep -q 'runtime-waiver'; then
  echo "✓ N2 acmatrix + tests rojos → block sin la pista (primero se arregla lo arreglable)"
else
  echo "✗ N2 — la pista del waiver apareció con otros rojos, o no bloqueó"; fail=1
fi

# T8) tests «sin-acotar» (el repo hermano no se pudo acotar: la cubre la CI del pedido) → no frena el cierre del
# turno, y complete-step 4 lo deja pasar avisando que el merge exige la CI completa en verde, con constancia en gates.log.
# 🔴 rojo: si el hook frenara todo lo que no es 'green', el agente quedaría en un lazo sin salida (la única sería la suite completa).
echo '{"storyId":"X","autonomous":true,"iter":0,"checks":{"build":"green","tests":"sin-acotar"}}' > "$MK"
[ -z "$(run)" ] && echo "✓ T8 sin-acotar → deja cerrar el turno" || { echo "✗ T8 — sin-acotar frenó el cierre del turno"; fail=1; }
echo '{"storyId":"X","storyPath":"","autonomous":false,"stepsCompleted":[0,1,2,3],"stepsPending":[4,5,6,7,8],"checks":{"tests":"sin-acotar"},"checksProvenance":{"tests":"test-gate"}}' > "$MK"
OUT8=$(CLAUDE_CODE_SESSION_ID=$SID TYCON_MUTATION_CHECK=off node marker.js complete-step 4 --no-atdd 2>&1); RC8=$?
if [ "$RC8" -eq 0 ] && echo "$OUT8" | grep -q 'el merge exige la CI completa en verde' \
  && grep -q '"name":"tests-unscoped"' ~/.claude/.tycon-pipeline/gates.log; then
  echo "✓ T8 complete-step 4 con sin-acotar → pasa, avisa y lo anota"
else
  echo "✗ T8 — complete-step 4 con sin-acotar (rc $RC8): $OUT8"; fail=1
fi

# T19) mark-tests-not-scoped sólo lo usa test-gate.sh y sólo cambia la salida 7 que puso el portón: no tapa otro rojo.
# 🔴 rojo: sin estas negativas, cualquiera podría convertir un rojo en «sin-acotar» y dejar de frenar.
echo '{"storyId":"X","checks":{"tests":"red:exit=7"},"checksProvenance":{"tests":"test-gate"}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID node marker.js mark-tests-not-scoped "x" >/dev/null 2>&1; RA=$?
echo '{"storyId":"X","checks":{"tests":"red:exit=1"},"checksProvenance":{"tests":"test-gate"}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID TYCON_TEST_GATE=1 node marker.js mark-tests-not-scoped "x" >/dev/null 2>&1; RB=$?
grep -q '"red:exit=1"' "$MK"; KB=$?
echo '{"storyId":"X","checks":{"tests":"red:exit=7"},"checksProvenance":{"tests":"run-check"}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID TYCON_TEST_GATE=1 node marker.js mark-tests-not-scoped "x" >/dev/null 2>&1; RC9=$?
echo '{"storyId":"X","checks":{"tests":"red:exit=7"},"checksProvenance":{"tests":"test-gate"}}' > "$MK"
CLAUDE_CODE_SESSION_ID=$SID TYCON_TEST_GATE=1 node marker.js mark-tests-not-scoped "x" >/dev/null 2>&1; RD=$?
if [ "$RA" -eq 2 ] && [ "$RB" -eq 2 ] && [ "$KB" -eq 0 ] && [ "$RC9" -eq 2 ] && [ "$RD" -eq 0 ] && grep -q '"sin-acotar"' "$MK"; then
  echo "✓ T19 mark-tests-not-scoped: sin el portón, con otro rojo o con otra procedencia, no cambia nada; con la salida 7 del portón, sí"
else
  echo "✗ T19 mark-tests-not-scoped: sin portón=$RA otro rojo=$RB(intacto=$KB) otra procedencia=$RC9 el bueno=$RD"; fail=1
fi

rm -f ~/.claude/.tycon-pipeline/STOP_AUTONOMY
rm -f "$MK"
[ "$fail" -eq 0 ] && echo "=== TODOS OK ===" || { echo "=== HUBO FALLOS ==="; exit 1; }
