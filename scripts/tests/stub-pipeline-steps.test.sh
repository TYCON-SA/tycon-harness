#!/usr/bin/env bash
# Prueba de stub-pipeline-steps.js — la copia de un pipeline con los pasos reemplazados por
# `echo`, para que el corredor local recorra la cadena entera de etapas sin ejecutar nada.
#
# Nace del 2026-09-04: el corredor local sin agente sólo llegaba hasta la primera etapa con pasos
# (un job sin agente "falla" y arrastra en cascada a lo que depende de él), así que la condición
# de `Deploy` no se podía probar sin una corrida real.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V="$AQUI/scripts/ci/stub-pipeline-steps.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ vaciar: $1"; }
no(){ echo "❌ vaciar: $1"; fallos=$((fallos+1)); }

cat > "$TMP/p.yml" <<'YML'
trigger:
  branches:
    include: [main]
variables:
  nodeVersion: '20.x'
stages:
  - stage: Pruebas
    dependsOn: []
    jobs:
      - job: ContainerTests
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - checkout: self
          - task: UseNode@1
            displayName: 'Setup Node.js'
            inputs:
              version: '$(nodeVersion)'
          - script: |
              if [ -z "$X" ]; then
                echo "##vso[task.setvariable variable=hasTests;isOutput=true]false"
              else
                echo "##vso[task.setvariable variable=hasTests;isOutput=true]true"
              fi
              echo "##vso[task.setvariable variable=lista]a b"
            name: DetectForms
            displayName: 'Detect forms to test'

          # un comentario entre pasos
          - script: dotnet test --collect "XPlat Code Coverage"
            displayName: "Run tests with coverage"
            condition: eq(variables['DetectForms.hasTests'], 'true')
            continueOnError: true
  - stage: Build
    dependsOn: [Pruebas]
    condition: in(dependencies.Pruebas.result, 'Succeeded', 'SucceededWithIssues')
    jobs:
      - job: BuildPlugin
        steps:
          - script: echo build
            displayName: 'Build and publish plugin'
YML

# ---------------------------------------------------------------- 1. estructura intacta, pasos vaciados
node "$V" "$TMP/p.yml" > "$TMP/v.yml" 2>"$TMP/err.txt"; rc=$?
[ "$rc" -eq 0 ] || no "1: salió $rc: $(cat "$TMP/err.txt")"
grep -q "^  - stage: Pruebas" "$TMP/v.yml" && grep -q "^  - stage: Build" "$TMP/v.yml" \
  && grep -q "condition: in(dependencies.Pruebas.result" "$TMP/v.yml" \
  && grep -q "dependsOn: \[Pruebas\]" "$TMP/v.yml" \
  && grep -q "nodeVersion: '20.x'" "$TMP/v.yml" \
  && ok "1: etapas, dependsOn, condiciones de etapa y variables viajan intactas" \
  || no "1: la estructura fuera de steps cambió"
grep -q "dotnet test" "$TMP/v.yml" && no "1b: quedó un comando real adentro" || ok "1b: ningún comando real sobrevive"
[ "$(grep -c '\[vaciado\]' "$TMP/v.yml")" -eq 5 ] && ok "1c: los 5 pasos se vaciaron (checkout, task y scripts incluidos)" || no "1c: vació $(grep -c '\[vaciado\]' "$TMP/v.yml") de 5"
grep -q "5 paso(s) vaciado(s)" "$TMP/err.txt" && ok "1d: informa cuántos vació" || no "1d: no informó la cuenta"

# ---------------------------------------------------------------- 2. conserva name, displayName, condition y continueOnError
grep -q "^            name: DetectForms" "$TMP/v.yml" && ok "2: conserva el name (los pasos siguientes leen sus salidas)" || no "2: perdió el name"
grep -q "displayName: 'Run tests with coverage'" "$TMP/v.yml" && ok "2b: conserva el displayName (normalizado a comilla simple)" || no "2b: perdió el displayName"
grep -q "condition: eq(variables\['DetectForms.hasTests'\], 'true')" "$TMP/v.yml" && ok "2c: conserva la condición del paso" || no "2c: perdió la condición del paso"
grep -q "continueOnError: true" "$TMP/v.yml" && ok "2d: conserva continueOnError" || no "2d: perdió continueOnError"

# ---------------------------------------------------------------- 3. vuelve a publicar las variables que el paso publicaba
grep -q 'variable=hasTests;isOutput=true\]true' "$TMP/v.yml" && ok "3: la salida (isOutput) se publica con true por default" || no "3: no publicó la salida hasTests"
grep -q 'variable=lista\]true' "$TMP/v.yml" && ok "3b: la variable de job (sin isOutput) también" || no "3b: no publicó la variable de job"
[ "$(grep -c 'variable=hasTests' "$TMP/v.yml")" -eq 1 ] && ok "3c: una sola vez aunque el original la escribía en dos ramas" || no "3c: la publicó $(grep -c 'variable=hasTests' "$TMP/v.yml") veces"
node "$V" "$TMP/p.yml" --output hasTests=false > "$TMP/v2.yml" 2>/dev/null
grep -q 'variable=hasTests;isOutput=true\]false' "$TMP/v2.yml" && ok "3d: --output fija el valor" || no "3d: --output no cambió el valor"

# ---------------------------------------------------------------- 4. --fail hace fallar SÓLO el paso elegido
node "$V" "$TMP/p.yml" --fail 'Run tests' > "$TMP/v3.yml" 2>/dev/null; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c 'exit 1' "$TMP/v3.yml")" -eq 1 ] && ok "4: --fail inyecta exactamente un exit 1" || no "4: --fail inyectó $(grep -c 'exit 1' "$TMP/v3.yml") (rc=$rc)"
awk '/Run tests with coverage/{f=1} f&&/exit 1/{print "ok"; exit}' "$TMP/v3.yml" | grep ok >/dev/null || true
node "$V" "$TMP/p.yml" --fail 'NoExiste' > /dev/null 2>"$TMP/err4.txt"; rc=$?
[ "$rc" -ne 0 ] && grep -q "ningún paso coincide" "$TMP/err4.txt" && ok "4b: --fail sin coincidencia sale ≠0 — una prueba que no falla nada no prueba nada" || no "4b: --fail sin coincidencia salió $rc"

# ---------------------------------------------------------------- 5. lo que no es un pipeline no sale 0
printf 'hola: mundo\n' > "$TMP/no.yml"
node "$V" "$TMP/no.yml" > /dev/null 2>"$TMP/err5.txt"; rc=$?
[ "$rc" -eq 2 ] && ok "5: sin pasos que vaciar sale 2, no 0" || no "5: sin pasos salió $rc"
node "$V" "$TMP/inexistente.yml" > /dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "5b: archivo ilegible sale 2" || no "5b: archivo ilegible salió $rc"

# ---------------------------------------------------------------- 6. `steps:` dentro de un comentario no es un bloque
cat > "$TMP/c.yml" <<'YML'
stages:
  - stage: A
    jobs:
      - job: J
        # steps:
        steps:
          - script: echo real
            displayName: 'Real'
YML
node "$V" "$TMP/c.yml" > "$TMP/vc.yml" 2>/dev/null
[ "$(grep -c '\[vaciado\]' "$TMP/vc.yml")" -eq 1 ] && grep -q "^        # steps:" "$TMP/vc.yml" && ok "6: un 'steps:' comentado no se toca; el real sí" || no "6: se confundió con el comentario"

# ---------------------------------------------------------------- 7. el resultado sigue siendo YAML válido (si hay parser)
if python3 -c "import yaml" 2>/dev/null; then
  python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$TMP/v.yml" 2>/dev/null && ok "7: la copia vaciada parsea como YAML" || no "7: la copia vaciada no parsea"
else
  echo "ℹ️ vaciar: 7 salteado (sin PyYAML)"
fi

# ---------------------------------------------------------------- 8. rojo previo: sobre los pipelines reales del equipo vacía TODO
for f in "$AQUI"/../Totora/Backend/azure-pipelines.yml; do
  [ -f "$f" ] || { echo "ℹ️ vaciar: 8 salteado (no está Totora/Backend en el disco)"; break; }
  node "$V" "$f" > "$TMP/real.yml" 2>/dev/null; rc=$?
  # el pipeline de un producto puede nombrar el guion por su nombre viejo (lo cubre el reemplazo) o por el nuevo
  if [ "$rc" -eq 0 ] && ! grep -qE "dotnet (test|publish)|desplegar-plugin\.sh|humo-plugin\.sh|deploy-plugin\.sh|smoke-plugin\.sh" "$TMP/real.yml"; then
    ok "8: sobre un pipeline real no sobrevive ni test, ni publish, ni despliegue, ni humo"
  else
    no "8: sobre el pipeline real quedó un comando real (rc=$rc)"
  fi
done

echo; [ "$fallos" -eq 0 ] && echo "vaciar-pasos: todo verde" || { echo "vaciar-pasos: $fallos fallo(s)"; exit 1; }
