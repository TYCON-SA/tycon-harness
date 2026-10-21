#!/bin/bash
# Smoke test for tycon-pipeline on-pre-commit.js — full coverage.
#
# Casos:
#   1. ACCOV-C10 Case 1: solo iter1 (no previous) → PERMIT.
#   2. ACCOV-C10 Case 2: iter2 con gap NUEVO → BLOCK.
#   3. ACCOV-C10 Case 3: iter2 converged (mismos gaps) → PERMIT.
#   4. ACCOV-C10 Case 4: iter2 subset (menos gaps) → PERMIT.
#   5. Self-audit exclusion: archivo `<id>-self-audit-iter*.md` NO debe ser
#      tomado como evidencia DoD (compartían prefix).
#   6. parseAcsFromSpec ignora cross-story refs (`Story X.Y AC #N` ≠ AC del story actual).
#   7. parseAcsFromEvidence soporta heading combinado `AC #N/#M`.
#   8. DODRT-C6: transición a done SIN matriz runtime verde/ackeada → BLOCK (matrix-red).
#
# NOTA contrato DODRT-C6: las transiciones a review/done exigen ADEMÁS
# la matriz de verificación runtime verde-o-ackeada (runtime-matrix.js, re-computada en
# vivo por el hook). Los fixtures 1/3/4/6/7 (que esperan PERMIT) satisfacen esa capa vía
# `add_matrix_ack` — plan manual + bloque runtime_verification_ack con el hash real.
#
# Caso de fondo:
#   - review→done: ACCOV-C10 + dedupe audits + selfaudit excl + AC parse.
#
# Uso: bash dod-hook-smoke-test.sh

set -u
HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/on-pre-commit.js"
if [ ! -f "$HOOK" ]; then
  echo "ERROR: hook not found at $HOOK"
  exit 1
fi
BASE=/tmp/dod-hook-smoke
rm -rf "$BASE"
mkdir -p "$BASE"
FAIL=0
dir=""
# Log de waivers aislado (no ensuciar el real). El hook y las inyecciones lo comparten via env.
export TYCON_WAIVER_LOG="$BASE/waivers.jsonl"
# El hook corre con el HOME real — que sus decisiones de prueba no se anoten en frenos.jsonl.
export TYCON_CLOSURE_RECORD=off
# Esta prueba mira la capa de evidencia DoD (runtime, matriz por AC). El portón de constancia de revisores (F.iv)
# exige reportes del Step 5 que estos fixtures no traen: con él prendido los 7 casos que esperan «pasa» frenarían por
# otra capa. Esa capa tiene sus pruebas.
export TYCON_ADVISORS_GATE=off
: > "$TYCON_WAIVER_LOG"

make_spec() {
  local out="$1" status="$2"
  cat > "$out" <<EOF
---
status: $status
story: 9.9
sprint: 9
runtime_not_verifiable:
  - ac: 1
    reason: "fixture de test"
    covered_by: T1
  - ac: 2
    reason: "fixture de test"
    covered_by: T2
---

# Story 9.9 — Test

## Acceptance Criteria

1. **Given** test, when X, then Y. (Playwright E2E)
2. **Given** test2, when X, then Y. (Playwright E2E)

Reference: Story 1.1 AC #10 sigue funcionando (cross-story note, no debe contarse como AC 4.2).

### Tests

| Test | AC |
|------|-----|
| T1   | #1 |
| T2   | #2 |
EOF
}

make_evidence() {
  local out="$1"
  cat > "$out" <<'EOF'
# DoD Evidence — Story 9.9

## Playwright Run
npx playwright test story-9-9.spec.ts → PASS (1/1)

#### AC #1 — verified via curl
#### AC #2/#3 — combined heading (multi-AC test)
PASS.
EOF
}

make_self_audit() {
  local out="$1"; shift
  {
    echo "# Self-audit Story 9.9"
    echo "## 1. Cobertura por AC"
    echo "AC #1 covered."
    echo "## 2. Cobertura por interacción"
    echo "OK."
    echo "## 3. Gaps conocidos"
    echo "| Gap | Descripción |"
    echo "|-----|-------------|"
    for g in "$@"; do
      echo "| **$g — placeholder** | placeholder |"
    done
    echo "## 4. Verificación de no-regresión"
    echo "No regression."
    echo "## 5. Confianza del agente"
    echo "8/10."
  } > "$out"
}

setup_case() {
  local n="$1"
  # `dir` es GLOBAL a propósito (new_case lo consume sin subshell).
  # Cada caso vive en su propio parent para aislar findSibilingSpecRoots —
  # si comparten parent, el hook resuelve siblings y "encuentra" evidencia
  # de OTROS casos, falseando los tests.
  dir="$BASE/case-$n/repo"
  mkdir -p "$dir/specs/stories" "$dir/.advisors/dod-runtime"
  cd "$dir"
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
  make_spec "specs/stories/9-9-test.md" "ready-for-dev"
  git add specs/stories/9-9-test.md
  git commit -q -m "initial"
  make_spec "specs/stories/9-9-test.md" "done"
  git add specs/stories/9-9-test.md
  make_evidence ".advisors/dod-runtime/9.9-2026-05-20T00-00-00Z.md"
  printf '{"ts":"2026-07-10T00:00:00Z","story_id":"9.9","suite_green":true}' > ".advisors/tests-result.json"
  # NO echo: setea la global `dir` (evita subshell $() que perdía el export del waiver log).
}

# Corre setup_case en subshell (captura $dir) y ADEMÁS setea el waiver log por caso EN EL PADRE
# (el export de adentro de setup_case no persiste por el $(...)).
new_case() {
  setup_case "$1"          # setea la global `dir`, en el shell PADRE (sin subshell)
  export TYCON_WAIVER_LOG="$BASE/case-$1/waivers.jsonl"
  : > "$TYCON_WAIVER_LOG"
}

run_hook() {
  local cwd="$1"
  local event_json
  event_json='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m test"},"cwd":"'"$cwd"'"}'
  echo "$event_json" | node "$HOOK"
  echo $?
}

# DODRT-C6 — satisface la capa de matriz runtime en fixtures que esperan PERMIT, simulando el
# WAIVER TTY del usuario: inyecta un waiver válido (hash real de la matriz) al log aislado, igual
# que haría marker.js runtime-waiver tras la confirmación en /dev/tty. En los tests no hay TTY, así
# que se inyecta vía la lib directamente (lo que el comando escribe POST-confirmación).
SKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
add_matrix_ack() {
  local dir="$1"
  local spec="$dir/specs/stories/9-9-test.md"
  SPEC="$spec" SKDIR_INJ="$SKDIR" node -e '
    const rm = require(process.env.SKDIR_INJ + "/runtime-matrix.js");
    const w = require(process.env.SKDIR_INJ + "/lib/runtime-waiver.js");
    const r = rm.compute({ storyPath: process.env.SPEC });
    if (r.structuralError) { console.error("struct", r.structuralError); process.exit(1); }
    if (!r.pendientes.length) process.exit(0);
    w.appendWaiver({ story: r.sid, acs: r.pendientes, matrixHash: r.hash, approvedBy: "DevA(TTY)", nowIso: new Date().toISOString() });
  ' || { echo "  ⚠ add_matrix_ack: inyección de waiver falló para $spec" >&2; return 1; }
}

assert_exit() {
  local label="$1" got="$2" expected="$3" stderr_file="$4"
  if [ "$got" = "$expected" ]; then
    echo "  ✅ PASS — $label"
  else
    echo "  ❌ FAIL — $label (got=$got expected=$expected)"
    [ -f "$stderr_file" ] && head -20 "$stderr_file" | sed 's/^/    /'
    FAIL=$((FAIL+1))
  fi
}

# ---------- Case 1: only iter1 ----------
echo "=== Case 1: solo iter1 (no previous) ==="
new_case 1
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B C
add_matrix_ack "$dir"
ec=$(run_hook "$dir" 2>/tmp/c1.err); assert_exit "permit" "$ec" "0" /tmp/c1.err

# ---------- Case 2: iter2 with new gap ----------
echo "=== Case 2: iter2 introduce gap nuevo F ==="
new_case 2
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B C
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md" A B C F
sleep 1; touch "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md"
ec=$(run_hook "$dir" 2>/tmp/c2.err); assert_exit "block (new gap)" "$ec" "2" /tmp/c2.err

# ---------- Case 3: iter2 converged ----------
echo "=== Case 3: iter2 converged (mismos gaps) ==="
new_case 3
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B C
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md" A B C
sleep 1; touch "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md"
add_matrix_ack "$dir"
ec=$(run_hook "$dir" 2>/tmp/c3.err); assert_exit "permit (converged)" "$ec" "0" /tmp/c3.err

# ---------- Case 4: iter2 subset ----------
echo "=== Case 4: iter2 subset ==="
new_case 4
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B C
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md" A B
sleep 1; touch "$dir/.advisors/dod-runtime/9.9-self-audit-iter2.md"
add_matrix_ack "$dir"
ec=$(run_hook "$dir" 2>/tmp/c4.err); assert_exit "permit (subset)" "$ec" "0" /tmp/c4.err

# ---------- Case 5: self-audit exclusion ----------
echo "=== Case 5: self-audit file NO debe contar como evidencia DoD ==="
new_case 5
# Borrar el evidence file genuino; solo dejamos el self-audit.
rm "$dir/.advisors/dod-runtime/9.9-2026-05-20T00-00-00Z.md"
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A
ec=$(run_hook "$dir" 2>/tmp/c5.err)
# Sin evidencia genuina debe BLOQUEAR con reason 'no-evidence' (no 'no-self-audit').
if [ "$ec" = "2" ] && grep -q "no encontrado" /tmp/c5.err; then
  echo "  ✅ PASS — bloqueado correctamente con 'no-evidence' (excluyó self-audit)"
else
  echo "  ❌ FAIL — esperaba block + no-evidence, got ec=$ec"
  head -25 /tmp/c5.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# ---------- Case 6: cross-story AC ref NO debe disparar missing ----------
echo "=== Case 6: cross-story AC ref (Story 1.1 AC #10) NO debe ser exigida ==="
new_case 6
# evidence cubre AC #1 y #2/#3 — el spec menciona "Story X.Y AC #10" como nota.
# El hook NO debería pedir AC #10 (que pertenece a otra story).
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A
add_matrix_ack "$dir"
ec=$(run_hook "$dir" 2>/tmp/c6.err)
if [ "$ec" = "0" ]; then
  echo "  ✅ PASS — cross-story ref ignorada"
else
  echo "  ❌ FAIL — hook reclamó AC inexistente, ec=$ec"
  grep -E "Criterios sin evidencia" /tmp/c6.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# ---------- Case 7: multi-AC heading "AC #2/#3" ----------
echo "=== Case 7: heading 'AC #2/#3' debe cubrir AC #2 Y #3 ==="
new_case 7
# Crear evidence con SOLO el formato combinado.
cat > "$dir/.advisors/dod-runtime/9.9-2026-05-20T00-00-00Z.md" <<'EOF'
# DoD Evidence
## Playwright Run
npx playwright test story-9-9.spec.ts → PASS (1/1)
#### AC #1 — verified
#### AC #2/#3 — combined (covers both)
EOF
# Ampliar spec a 3 ACs.
cat > "$dir/specs/stories/9-9-test.md" <<'EOF'
---
status: done
story: 9.9
sprint: 9
runtime_not_verifiable:
  - ac: 1
    reason: "fixture"
    covered_by: T1
  - ac: 2
    reason: "fixture"
    covered_by: T2
  - ac: 3
    reason: "fixture"
    covered_by: T3
---

## Acceptance Criteria

1. **Given** a, when b, then c. (Playwright E2E)
2. **Given** d, when e, then f. (Playwright E2E)
3. **Given** g, when h, then i. (Playwright E2E)

### Tests

| Test | AC |
|------|-----|
| T1   | #1 |
| T2   | #2 |
| T3   | #3 |
EOF
git add specs/stories/9-9-test.md
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A
add_matrix_ack "$dir"
ec=$(run_hook "$dir" 2>/tmp/c7.err)
if [ "$ec" = "0" ]; then
  echo "  ✅ PASS — combined heading reconocido"
else
  echo "  ❌ FAIL — hook no reconoció heading combinado, ec=$ec"
  grep -E "Criterios sin evidencia" /tmp/c7.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# ---------- Case 8: DODRT-C6 — sin matriz verde/ackeada → BLOCK ----------
echo "=== Case 8: transición a done SIN matriz runtime → BLOCK (DODRT-C6) ==="
new_case 8
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A
# SIN add_matrix_ack: el spec tiene ACs pero cero evidencia runtime y cero ack.
ec=$(run_hook "$dir" 2>/tmp/c8.err)
if [ "$ec" = "2" ] && grep -q "DODRT-C6" /tmp/c8.err; then
  echo "  ✅ PASS — bloqueado con matrix-red"
else
  echo "  ❌ FAIL — esperaba block DODRT-C6, got ec=$ec"
  head -20 /tmp/c8.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# ---------- Case 9: la firma existe pero se descartó: el bloqueo lo DICE ----------
# Caso: el registro del repo tiene la firma del dev pero la cadena se rompió al unir ramas; un bloqueo que dijera
# «esperan waiver del USUARIO» haría parecer que el dev no había firmado.
echo "=== Case 9: firma descartada por la cadena → el bloqueo lo dice (story 7.17) ==="
new_case 9
make_self_audit "$dir/.advisors/dod-runtime/9.9-self-audit-iter1.md" A
mkdir -p "$dir/.tycon"
SKDIR_INJ="$SKDIR" node -e '
  const w = require(process.env.SKDIR_INJ + "/lib/runtime-waiver.js");
  const d = w.declHashFor("fixture de test", "T1");
  const e = { ts: "2026-10-07T09:00:00.000Z", story: "9.9", acs: [1], matrixHash: "m", approvedBy: "DevA", tty: true,
    declHashByAc: { 1: d }, chain: "deadbeefdeadbeef" };
  process.stdout.write(JSON.stringify(e) + "\n");
' > "$dir/.tycon/runtime-waivers.jsonl"
ec=$(run_hook "$dir" 2>/tmp/c9.err)
if [ "$ec" = "2" ] && grep -q "descart" /tmp/c9.err && grep -q "runtime-waivers.jsonl:1" /tmp/c9.err \
   && grep -q "marker.js runtime-waiver" /tmp/c9.err; then
  echo "  ✅ PASS — el bloqueo nombra la firma descartada, dónde está y cómo volver a firmar"
else
  echo "  ❌ FAIL — esperaba el aviso de firma descartada, got ec=$ec"
  head -30 /tmp/c9.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

echo
if [ $FAIL -eq 0 ]; then
  echo "✅ 9/9 PASS"
  exit 0
else
  echo "❌ $FAIL test(s) FAILED"
  exit 1
fi
