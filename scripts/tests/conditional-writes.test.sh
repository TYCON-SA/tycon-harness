#!/usr/bin/env bash
# conditional-writes.test.sh — casos del control de escrituras al repositorio.
#
# 🔴 EL CASO QUE LE DA SENTIDO: en Azure DevOps una `condition:` explícita REEMPLAZA al
# `succeeded()` implícito. Medido el 2026-09-02: en CUATRO de los cinco pipelines de formularios,
# el paso que commitea el número de versión nuevo tiene condición explícita y no nombra
# `succeeded()`. Si la construcción falla, el paso que arma los paquetes se saltea —ése sí lo
# tiene— pero el commit entra a la rama principal igual: la rama dice que se publicó una versión
# que no existe, y ese commit pasa a ser la base del próximo cálculo.
#
# Verificado además con el corredor local (`Runner.Client --event azpipelines`): con la
# construcción en rojo, el paso sin la cláusula CORRE y el que la tiene se saltea.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTRL="$DIR/../ci/check-conditional-writes.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OK=0; MAL=0
ok() { echo "✅ escrituras: $1"; OK=$((OK+1)); }
no() { echo "❌ escrituras: $1"; MAL=$((MAL+1)); }
corre() { node "$CTRL" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

# ── 1. EL CASO REAL: commitea con condición propia y sin la cláusula ──────────────────────────
cat > "$TMP/malo.yml" <<'YML'
steps:
  - script: |
      git add .
      git commit -m "chore: update form versions [skip ci]"
      git push origin HEAD:main
    displayName: 'Commit and push changes (main only)'
    condition: and(eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))
YML
rc=$(corre "$TMP/malo.yml")
[ "$rc" = "1" ] && ok "🔴 el caso real: commitea a la rama principal con condición propia y sin succeeded()" || no "no lo detectó (salió $rc)"
grep -q "Commit and push" "$TMP/out.txt" && ok "…y nombra el paso" || no "no nombró el paso"

# ── 2. el mismo paso, con la cláusula, no se marca ────────────────────────────────────────────
sed 's/condition: and(eq/condition: and(succeeded(), eq/' "$TMP/malo.yml" > "$TMP/bueno.yml"
rc=$(corre "$TMP/bueno.yml")
[ "$rc" = "0" ] && ok "con succeeded() en la condición, limpio" || no "falso positivo con succeeded(): $(cat "$TMP/out.txt")"

# ── 3. 🔴 sin `condition:` NO es hallazgo ─────────────────────────────────────────────────────
# Ahí rige el succeeded() implícito, que es lo correcto por default. Marcarlo sería ruido en los
# 14 pipelines y el control terminaría apagado.
cat > "$TMP/sincond.yml" <<'YML'
steps:
  - script: git commit -m x && git push
    displayName: 'Commit sin condición'
YML
rc=$(corre "$TMP/sincond.yml")
[ "$rc" = "0" ] && ok "🔴 sin condición explícita NO es hallazgo: ahí rige el succeeded() implícito" || no "marcó un paso sin condición"

# ── 4. `always()` es deliberado, no un olvido ─────────────────────────────────────────────────
cat > "$TMP/always.yml" <<'YML'
steps:
  - script: git tag limpieza && git push --tags
    displayName: 'Etiqueta de limpieza'
    condition: always()
YML
rc=$(corre "$TMP/always.yml")
[ "$rc" = "0" ] && ok "always() es una decisión, no un descuido: no se marca" || no "marcó un always()"

# ── 5. publicar un artefacto con condición propia y sin la cláusula TAMBIÉN es hallazgo ─────
# (2026-09-03) Hasta hoy quedaba FUERA a propósito: los cinco pipelines de formularios publicaban
# sus ZIP sin `succeeded()` y eso estaba declarado como deuda con fecha — un control que nace rojo
# por diez hallazgos que el plan excluye se apaga. Ese mismo día se arreglaron los cinco, así que
# el alcance se amplía sin nacer rojo: medido sobre los 14 pipelines publicados, cero hallazgos.
cat > "$TMP/publica.yml" <<'YML'
steps:
  - task: PublishPipelineArtifact@1
    displayName: 'Publicar artefacto'
    condition: eq(variables['Build.SourceBranch'], 'refs/heads/main')
YML
rc=$(corre "$TMP/publica.yml")
[ "$rc" = "1" ] && ok "🔴 publicar un artefacto con condición propia y sin succeeded() es hallazgo (era deuda declarada; los 5 ya la pagaron)" || no "dejó pasar una publicación sin la cláusula (salió $rc)"
sed 's/condition: eq(/condition: and(succeeded(), eq(/' "$TMP/publica.yml" > "$TMP/publica-ok.yml"
rc=$(corre "$TMP/publica-ok.yml")
[ "$rc" = "0" ] && ok "…con succeeded(), limpio" || no "falso positivo en una publicación con succeeded(): $(cat "$TMP/out.txt")"
# El artefacto del arnés (arnes-ci) se publica SIN condición en los diez: ahí rige el implícito.
printf 'steps:\n  - task: PublishPipelineArtifact@1\n    displayName: Publish arnes-ci artifact\n    inputs:\n      artifact: arnes-ci\n' > "$TMP/publica-sincond.yml"
rc=$(corre "$TMP/publica-sincond.yml")
[ "$rc" = "0" ] && ok "…y publicar SIN condición no es hallazgo (arnes-ci en los diez)" || no "marcó una publicación sin condición"
# Un paso de copia o empaquetado NO es publicar: el alcance sigue siendo lo que sale del pipeline.
printf 'steps:\n  - script: cp dist/*.zip $(Build.ArtifactStagingDirectory)/\n    displayName: Prepare artifacts for upload\n    condition: eq(1,1)\n' > "$TMP/copia.yml"
rc=$(corre "$TMP/copia.yml")
[ "$rc" = "0" ] && ok "🔴 copiar o empaquetar no es publicar: queda fuera del alcance" || no "se salió del alcance y marcó una copia"

# ── 6. varias formas de escribir cuentan ──────────────────────────────────────────────────────
for verbo in "git commit -m x" "git push origin main" "git tag v1 && git push --tags"; do
  printf 'steps:\n  - script: %s\n    displayName: p\n    condition: eq(1,1)\n' "$verbo" > "$TMP/v.yml"
  rc=$(corre "$TMP/v.yml")
  [ "$rc" = "1" ] || no "no detectó «${verbo}»"
done
ok "detecta commit, push y tag por igual"

# ── 7. un archivo ilegible NO es "está bien" ──────────────────────────────────────────────────
rc=$(corre "$TMP/no-existe-este-archivo.yml")
[ "$rc" = "2" ] && ok "🔴 un archivo que no se puede leer sale 2, no 0" || no "archivo ausente salió $rc"

# ── 8. la evidencia congelada: 4 commits + 5 publicaciones, en los 5 de formularios, de 14 ─────
EV="$DIR/../../tasks/evidencia/2026-09-02-antes-de-los-arreglos"
if [ -d "$EV" ] && ls "$EV"/*.yml >/dev/null 2>&1; then
  node "$CTRL" "$EV"/*.yml >"$TMP/ev.txt" 2>&1; rc=$?
  [ "$rc" = "1" ] && ok "🔴 contra la evidencia congelada se pone rojo — el rojo previo que justifica el control" || no "la evidencia congelada salió $rc"
  n=$(grep -c "escribe en el repositorio con condición propia" "$TMP/ev.txt")
  [ "$n" = "4" ] && ok "…marca exactamente los 4 commits de versión, ni uno más de los 14" || no "marcó $n commits, debía marcar 4"
  # (2026-09-03) Con el alcance ampliado: los 5 de formularios publicaban sus ZIP sin la cláusula;
  # los 5 de plugins ya la tenían. Es el rojo previo de la ampliación.
  m=$(grep -c "publica un artefacto con condición propia" "$TMP/ev.txt")
  [ "$m" = "5" ] && ok "🔴 …y las 5 publicaciones de formularios sin la cláusula, ninguna de plugins" || no "marcó $m publicaciones, debía marcar 5"
  grep -q "5 pipeline(s)" "$TMP/ev.txt" && ok "…en 5 pipelines de 14" || no "el total de pipelines no es 5: $(grep 'pipeline(s)' "$TMP/ev.txt")"
else
  echo "⚠️  escrituras: la evidencia congelada no está — el caso 8 no corrió"
fi

echo "─────────────"
[ $MAL -eq 0 ] && { echo "✅ escrituras-condicionadas: todo verde ($OK casos)"; exit 0; }
echo "❌ escrituras-condicionadas: $MAL de $((OK+MAL))"; exit 1
