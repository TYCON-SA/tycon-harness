#!/usr/bin/env bash
# build-selftests.test.sh — corre los autotests de los controles del pre-commit.
#
# POR QUÉ EXISTE (2026-08-25, FIX-7): los tres —ahora cuatro— controles de `build/check.js` traen
# su propio `--selftest`, y hasta hoy **nadie los corría**. Es exactamente la lección que el propio
# arnés ya pagó dos veces (`test-runtime-matrix.js` estuvo 8 días en rojo sin que nadie lo viera):
# una suite que nada ejecuta es indistinguible de una suite verde. Los autotests son la red de los
# controles que cuidan a todos los demás — si se pudren, el pre-commit dice OK sobre nada.
#
# Correr: bash scripts/tests/build-selftests.test.sh
set -uo pipefail
BUILD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/build"
fallos=0

for s in check-hooks-registration.js check-bank-coverage.js check-hook-coverage.js; do
  if [ ! -f "$BUILD/$s" ]; then
    echo "❌ $s — no existe (¿se renombró y quedó sin correr?)"; fallos=$((fallos+1)); continue
  fi
  out="$(node "$BUILD/$s" --selftest 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '✅'; then
    echo "✅ $s --selftest"
  else
    echo "❌ $s --selftest (exit=$rc)"; printf '%s\n' "$out" | tail -5; fallos=$((fallos+1))
  fi
done

# El portón de CI (scripts/ci/) — misma razón: su autotest existe y nadie lo corría.
out="$(node "$(dirname "$BUILD")/scripts/ci/tycon-ci-gate.js" --selftest 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '✅'; then echo "✅ tycon-ci-gate --selftest"; else
  echo "❌ tycon-ci-gate --selftest (exit=$rc)"; printf '%s\n' "$out" | tail -5; fallos=$((fallos+1)); fi

# La clasificación de rojos del banco de advisors (criterio vs. inestabilidad). Lógica pura: no
# lanza un solo revisor, así que puede correr todos los días sin costo.
for m in --selftest-classes --selftest-sandbox --selftest-variance; do
  out="$(node "$(dirname "$BUILD")/scripts/controls-bench/advisor-runner.js" "$m" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '✅'; then echo "✅ advisor-runner $m"; else
    echo "❌ advisor-runner $m (exit=$rc)"; printf '%s\n' "$out" | tail -5; fallos=$((fallos+1)); fi
done

# El censo de hooks tiene que dar el mismo veredicto que da el pre-commit sobre este repo:
# si acá pasara y en el commit no (o al revés), la red estaría mintiendo.
out="$(node "$BUILD/check-hook-coverage.js" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then echo "✅ hook-coverage sobre el repo real"; else
  echo "❌ hook-coverage sobre el repo real (exit=$rc)"; printf '%s\n' "$out" | tail -5; fallos=$((fallos+1)); fi

# El censo mira las skills que dice TYCON_SKILLS_DIR —el resolvedor de todo el arnés (scripts/lib/skills-dir.js)—, no
# sólo las de la HOME (pase adversarial de la story 8.7, tanda B, 2026-10-03). Las ubicaba por ~/.claude/agent-skills e
# ignoraba la variable: en una máquina sin instalación (la CI pública) dejaba las skills «sin censar» y salía verde, y con
# otro clon instalado censaba las instaladas y no las del repo que se revisa. Y una raíz que se PIDIÓ por variable y no
# se puede enumerar es rojo, no un aviso: no censar lo que se pidió no es un verde.
COV="$BUILD/check-hook-coverage.js"
LAB="$(mktemp -d "${TMPDIR:-/tmp}/hook-coverage.XXXXXX")"; LAB="$(cd "$LAB" && pwd -P)"
mkdir -p "$LAB/home" "$LAB/repo/skills/tycon-pipeline/scripts" "$LAB/repo/skills/clocki/scripts" "$LAB/partial/skills/clocki/scripts"
printf '// un hook nuevo, sin casos en el banco\n' > "$LAB/repo/skills/tycon-pipeline/scripts/on-new-without-cases.js"
cov_case() { # <nombre> <exit esperado> <texto que tiene que aparecer> <valor de TYCON_SKILLS_DIR ("" = sin la variable)>
  local out rc
  if [ -n "$4" ]; then out="$(HOME="$LAB/home" TYCON_SKILLS_DIR="$4" node "$COV" 2>&1)"; rc=$?
  else out="$(env -u TYCON_SKILLS_DIR HOME="$LAB/home" node "$COV" 2>&1)"; rc=$?; fi
  if [ "$rc" -eq "$2" ] && printf '%s' "$out" | grep -qF -- "$3"; then echo "✅ hook-coverage: $1"; else
    echo "❌ hook-coverage: $1 (exit=$rc, esperaba $2 con «$3»)"; printf '%s\n' "$out" | tail -4; fallos=$((fallos+1)); fi
}
cov_case "con TYCON_SKILLS_DIR (la carpeta skills/) censa ESAS skills: un hook sin casos es rojo" 1 "on-new-without-cases.js" "$LAB/repo/skills"
cov_case "con TYCON_SKILLS_DIR (la raíz del clon) censa ESAS skills: un hook sin casos es rojo" 1 "on-new-without-cases.js" "$LAB/repo"
cov_case "una raíz de skills pedida por variable que no se puede enumerar es rojo, no un aviso" 1 "no pude enumerar $LAB/partial/skills/tycon-pipeline/scripts" "$LAB/partial/skills"
# Sin la variable manda el propio clon cuando trae las skills adentro (story 8.18): ahí no falta ninguna raíz y el
# censo es el de siempre. Sólo en un arnés sin skills/ (dos repos) y sin instalación la raíz que falta es un aviso.
if [ -d "$BUILD/../skills/tycon-pipeline" ] && [ -d "$BUILD/../agents" ]; then
  cov_case "sin la variable, en el repo unido, censa las skills del propio clon (ninguna raíz falta)" 0 "hooks en disco" ""
else
  cov_case "sin la variable y sin instalación, la raíz que falta sigue siendo un aviso (otra máquina)" 0 "queda sin censar" ""
fi
rm -rf "$LAB"

if [ "$fallos" -eq 0 ]; then echo "✅ build-selftests: todo verde"; else echo "❌ build-selftests: $fallos rojo(s)"; fi
exit $([ "$fallos" -eq 0 ] && echo 0 || echo 1)
