#!/usr/bin/env bash
# Prueba de check-stage-dependencies.js — el control que verifica que la condición de cada
# etapa diga la verdad sobre de qué depende.
#
# Caso que lo motiva: un `Deploy` que nombra a `TraerArnes` en su condición sin depender de ella
# anda de casualidad —Azure DevOps resuelve dependencias transitivas— y se rompe el día que alguien
# reordene las etapas. No da ningún error.
#
# El caso 2 reproduce ESE defecto, y el 3 el gemelo peor: depender de las pruebas y no nombrarlas
# en la condición, o sea empaquetar con las pruebas en rojo.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-stage-dependencies.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ deps-etapas: $1"; }
no(){ echo "❌ deps-etapas: $1"; fallos=$((fallos+1)); }
corre(){ node "$CHK" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

# ---------------------------------------------------------------- 1. pipeline sano → verde
cat > "$TMP/sano.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    dependsOn: [A]
    condition: in(dependencies.A.result, 'Succeeded')
    jobs: []
Y
rc=$(corre "$TMP/sano.yml")
[ "$rc" -eq 0 ] && ok "un pipeline coherente sale 0" || no "un pipeline sano salió $rc: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 2. EL DEFECTO REAL: nombrar una etapa sin depender de ella
cat > "$TMP/fantasma.yml" <<'Y'
stages:
  - stage: TraerArnes
    jobs: []
  - stage: Build
    dependsOn: [TraerArnes]
    condition: in(dependencies.TraerArnes.result, 'Succeeded')
    jobs: []
  - stage: Deploy
    dependsOn: Build
    condition: and(in(dependencies.Build.result, 'Succeeded'), in(dependencies.TraerArnes.result, 'Succeeded'))
    jobs: []
Y
rc=$(corre "$TMP/fantasma.yml")
[ "$rc" -eq 1 ] && ok "🔴 caza la condición que nombra una etapa de la que NO depende (el caso FRESNO)" || no "🔴 dejó pasar el defecto real: salió $rc"
grep -q "nombra-sin-depender" "$TMP/out.txt" && ok "…y lo dice con su nombre" || no "no nombró el tipo de hallazgo"
grep -q "TraerArnes" "$TMP/out.txt" && ok "…y nombra la etapa fantasma" || no "no dijo cuál era"

# ---------------------------------------------------------------- 3. EL GEMELO PEOR
# dependsOn ordena, pero un `condition:` explícito REEMPLAZA al succeeded() implícito: el Build
# empaqueta con las pruebas en rojo.
cat > "$TMP/muda.yml" <<'Y'
stages:
  - stage: Pruebas
    jobs: []
  - stage: TraerArnes
    jobs: []
  - stage: Build
    dependsOn: [Pruebas, TraerArnes]
    condition: in(dependencies.TraerArnes.result, 'Succeeded')
    jobs: []
Y
rc=$(corre "$TMP/muda.yml")
[ "$rc" -eq 1 ] && ok "🔴 caza el Build que depende de las pruebas pero no las nombra en su condición" || no "🔴 dejó pasar el empaquetado con pruebas en rojo: salió $rc"
grep -q "depende-en-silencio" "$TMP/out.txt" && ok "…y lo clasifica aparte del otro" || no "no clasificó el hallazgo"

# ---------------------------------------------------------------- 4. sin condición NO es hallazgo
# Ahí rige succeeded(), que es lo correcto por default. Marcarlo sería ruido en todos los pipelines.
cat > "$TMP/sincond.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    dependsOn: [A]
    jobs: []
Y
rc=$(corre "$TMP/sincond.yml")
[ "$rc" -eq 0 ] && ok "sin condición explícita NO hay hallazgo (ahí rige succeeded())" || no "marcó una etapa sin condición: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 5. sin dependsOn → cuelga de la anterior
cat > "$TMP/implicita.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    condition: in(dependencies.A.result, 'Succeeded')
    jobs: []
Y
rc=$(corre "$TMP/implicita.yml")
[ "$rc" -eq 0 ] && ok "sin dependsOn entiende que cuelga de la etapa anterior" || no "🔴 falso positivo con dependencia implícita: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 6. lista de dependencias en varias líneas
cat > "$TMP/multi.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    jobs: []
  - stage: C
    dependsOn:
      - A
      - B
    condition: and(in(dependencies.A.result, 'Succeeded'), in(dependencies.B.result, 'Succeeded'))
    jobs: []
Y
rc=$(corre "$TMP/multi.yml")
[ "$rc" -eq 0 ] && ok "lee la lista de dependencias escrita en varias líneas" || no "🔴 no leyó la lista multilínea: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 7. condición partida en dos líneas
cat > "$TMP/condmulti.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    dependsOn: [A]
    condition: and(in(dependencies.A.result, 'Succeeded'),
      eq(variables['Build.Reason'], 'Manual'))
    jobs: []
Y
rc=$(corre "$TMP/condmulti.yml")
[ "$rc" -eq 0 ] && ok "lee una condición partida en dos líneas" || no "🔴 falso positivo con condición multilínea: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 8. ilegible NO es aprobado
cat > "$TMP/rota.yml" <<'Y'
stages:
  - stage: A
    jobs: []
  - stage: B
    dependsOn: [A]
    condition: and(in(dependencies.A.result, 'Succeeded'
    jobs: []
Y
rc=$(corre "$TMP/rota.yml")
[ "$rc" -eq 2 ] && ok "una condición que no se puede leer sale 2 (ilegible NO es aprobado)" || no "🔴 una condición ilegible salió $rc — se leyó como aprobada"

# ---------------------------------------------------------------- 9. un archivo sin etapas se saltea
printf 'trigger: none\npr: none\n' > "$TMP/vacio.yml"
rc=$(corre "$TMP/vacio.yml")
[ "$rc" -eq 0 ] && ok "un archivo sin etapas no genera falso positivo" || no "marcó un archivo sin etapas: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 10. una ruta inexistente NO es 'todo bien'
rc=$(corre "$TMP/no-existe.yml")
[ "$rc" -ne 0 ] && ok "una ruta inexistente pasada a mano NO se lee como 'todo bien'" || no "🔴 una ruta inexistente salió 0"

# ---------------------------------------------------------------- 11. 🔴 succeeded() sobre una dependencia con condición propia
# `ActivatePlugin` —con el humo adentro— depende de `RecycleAppPool`, que sólo corre si el upload
# devolvió 200. Con un 409 el reciclado queda Skipped, `succeeded()` se envenena, la activación y
# el humo NO corren y el stage queda VERDE.
cat > "$TMP/ceibo.yml" <<'Y'
stages:
  - stage: Deploy
    jobs:
      - job: DeployToStaging
        steps: []
      - job: RecycleAppPool
        dependsOn: DeployToStaging
        condition: and(succeeded(), eq(dependencies.DeployToStaging.outputs['DeployStep.needsRecycle'], 'true'))
        steps: []
      - job: ActivatePlugin
        dependsOn: RecycleAppPool
        condition: succeeded()
        steps: []
Y
rc=$(corre "$TMP/ceibo.yml")
[ "$rc" -eq 1 ] && ok "🔴 caza el job que usa succeeded() sobre una dependencia con condición propia (el caso Ceibo)" || no "🔴 dejó pasar el humo que no corre con el stage verde: salió $rc — $(cat "$TMP/out.txt")"
grep -q "salteo-en-silencio" "$TMP/out.txt" && grep -q "ActivatePlugin" "$TMP/out.txt" && ok "…y lo dice con su nombre y el job" || no "no nombró el tipo o el job: $(cat "$TMP/out.txt")"
grep -q "RecycleAppPool" "$TMP/out.txt" && ok "…y nombra la dependencia condicional que envenena" || no "no dijo cuál era la dependencia"
grep -q "\`Deploy › RecycleAppPool\`" "$TMP/out.txt" && no "🔴 marcó a RecycleAppPool, cuya dependencia NO tiene condición (falso positivo)" || ok "…y NO marca a RecycleAppPool (su dependencia corre siempre)"

# ---------------------------------------------------------------- 12. …el mismo caso con la condición implícita (sin escribirla) también
cat > "$TMP/ceibo-implicito.yml" <<'Y'
stages:
  - stage: Deploy
    jobs:
      - job: A
        steps: []
      - job: B
        dependsOn: A
        condition: eq(variables['x'], 'y')
        steps: []
      - job: C
        dependsOn: B
        steps: []
Y
rc=$(corre "$TMP/ceibo-implicito.yml")
[ "$rc" -eq 1 ] && grep -q "implícito" "$TMP/out.txt" && ok "🔴 sin condición escrita, el succeeded() implícito se caza igual (y se dice que es implícito)" || no "🔴 el succeeded() implícito pasó: salió $rc — $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 13. el arreglo: nombrar la dependencia y decir qué resultados se aceptan
cat > "$TMP/ceibo-arreglado.yml" <<'Y'
stages:
  - stage: Deploy
    jobs:
      - job: DeployToStaging
        steps: []
      - job: RecycleAppPool
        dependsOn: DeployToStaging
        condition: and(succeeded(), eq(dependencies.DeployToStaging.outputs['DeployStep.needsRecycle'], 'true'))
        steps: []
      - job: ActivatePlugin
        dependsOn: RecycleAppPool
        condition: in(dependencies.RecycleAppPool.result, 'Succeeded', 'SucceededWithIssues')
        steps: []
      - job: Humo
        dependsOn: [DeployToStaging, RecycleAppPool, ActivatePlugin]
        condition: and(in(dependencies.DeployToStaging.result, 'Succeeded', 'SucceededWithIssues'), in(dependencies.RecycleAppPool.result, 'Succeeded', 'SucceededWithIssues', 'Skipped'), in(dependencies.ActivatePlugin.result, 'Succeeded', 'SucceededWithIssues', 'Skipped'))
        steps: []
Y
rc=$(corre "$TMP/ceibo-arreglado.yml")
[ "$rc" -eq 0 ] && ok "con cada dependencia nombrada y sus resultados aceptados (incluido Skipped), verde" || no "🔴 falso positivo sobre el arreglo: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 14. las reglas de ETAPAS no se copian a los jobs (falsos positivos)
# Un job sin dependsOn corre en PARALELO (no cuelga del anterior), y `condition: succeeded()`
# explícito SÍ honra a las dependencias.
cat > "$TMP/jobs-sanos.yml" <<'Y'
stages:
  - stage: E2E
    jobs:
      - job: PlaywrightE2ECore
        steps: []
      - job: PlaywrightE2ELoad
        condition: or(eq(variables['Build.Reason'], 'Schedule'), eq(upper(variables['TEST_SUITE']), 'FULL'))
        steps: []
      - job: Reporte
        dependsOn: PlaywrightE2ECore
        condition: succeeded()
        steps: []
Y
rc=$(corre "$TMP/jobs-sanos.yml")
[ "$rc" -eq 0 ] && ok "un job con condición y sin dependsOn, y otro con succeeded() sobre una dependencia sin condición, NO son hallazgo" || no "🔴 falso positivo en jobs: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 15. la regla (c) también a nivel ETAPA
cat > "$TMP/etapa-envenenada.yml" <<'Y'
stages:
  - stage: HarnessGate
    condition: eq(variables['Build.Reason'], 'PullRequest')
    jobs: []
  - stage: Pruebas
    dependsOn: [HarnessGate]
    jobs: []
  - stage: Build
    dependsOn: [HarnessGate]
    condition: in(dependencies.HarnessGate.result, 'Succeeded', 'SucceededWithIssues', 'Skipped')
    jobs: []
Y
rc=$(corre "$TMP/etapa-envenenada.yml")
[ "$rc" -eq 1 ] && grep -q "\`Pruebas\`" "$TMP/out.txt" && ok "🔴 una etapa que cuelga sin condición de otra condicional (se saltea en main) se caza" || no "🔴 etapa envenenada pasó: salió $rc — $(cat "$TMP/out.txt")"
grep -q "\`Build\`" "$TMP/out.txt" && no "🔴 marcó a Build, que nombra a HarnessGate tolerando Skipped" || ok "…y NO marca a la que lo nombra tolerando Skipped"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ dependencias-de-etapas: todo verde"; exit 0; else echo "❌ dependencias-de-etapas: $fallos falla(s)"; exit 1; fi
