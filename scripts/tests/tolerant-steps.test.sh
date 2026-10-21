#!/usr/bin/env bash
# Prueba de check-tolerant-steps.js — el control que impide que un paso que DECIDE algo quede
# marcado como tolerante a fallos.
#
# 🔴 Una corrida que termina "parcialmente exitosa" —lo que pasa cuando un paso con continueOnError
# falla— APRUEBA la política de build del pull request. O sea que la marca no sólo decide si el pipeline sigue: decide si el
# cambio entra a la rama principal.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-tolerant-steps.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; casos=0
ok(){ casos=$((casos+1)); echo "✅ tolerantes: $1"; }
no(){ casos=$((casos+1)); echo "❌ tolerantes: $1"; fallos=$((fallos+1)); }
corre(){ node "$CHK" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

# ---------------------------------------------------------------- 1. 🔴 Lo que el control tiene que frenar
cat > "$TMP/peligroso.yml" <<'Y'
steps:
  - script: ./correr-las-pruebas.sh
    displayName: 'Run tests'
    continueOnError: true
Y
rc=$(corre "$TMP/peligroso.yml")
[ "$rc" -eq 1 ] && ok "🔴 un paso que decide (correr las pruebas) marcado como tolerante → se marca" || no "🔴 el paso peligroso salió $rc"
grep -q "APRUEBA la política" "$TMP/out.txt" && ok "…y explica POR QUÉ importa (aprueba el pull request)" || no "no explicó la consecuencia"

# ---------------------------------------------------------------- 2. y los inofensivos NO se marcan
cat > "$TMP/inofensivo.yml" <<'Y'
steps:
  - task: PublishTestResults@2
    displayName: 'Publish test results'
    continueOnError: true
  - script: echo notas
    displayName: 'Recompute release notes against staging'
    continueOnError: true
  - script: echo aviso
    displayName: 'Warn if dev fell behind main (main only)'
    continueOnError: true
  - task: DownloadPipelineArtifact@2
    displayName: 'Download plugin artifact'
    continueOnError: true
Y
rc=$(corre "$TMP/inofensivo.yml")
[ "$rc" -eq 0 ] && ok "las clases conocidas-inofensivas no se marcan" || no "🔴 falso positivo sobre lo inofensivo ($rc): $(grep '🔴' "$TMP/out.txt"|head -2)"
# El mismo aviso con el rótulo en castellano, con tilde y sin ella. Si un renombre masivo cambiara la palabra dentro
# de la expresión del control, el caso de arriba no lo vería: sólo ejerce la forma en inglés.
for rotulo in 'Avisar si dev quedó atrás de main' 'Avisar si dev quedo atras de main' 'AVISAR SI DEV QUEDÓ ATRÁS'; do
  printf "steps:\n  - script: echo aviso\n    displayName: '%s'\n    continueOnError: true\n" "${rotulo}" > "$TMP/atras.yml"
  rc=$(corre "$TMP/atras.yml")
  [ "$rc" -eq 0 ] && ok "«${rotulo}» es un aviso: no se marca" || no "🔴 el aviso en castellano «${rotulo}» salió $rc: el control dejó de reconocerlo"
done

# ---------------------------------------------------------------- 2a. lo que sólo corre en la rama principal
# El paso que sube el paquete al host de plugins se reconoce por su forma —«Upload to
# <algo>Extensions …»— sin escribir el nombre del destino; el que commitea la versión, por su nombre. Y la forma no se
# estira: «Upload to <otra cosa> production» es un despliegue como cualquiera, y tolerante se marca.
cat > "$TMP/principal.yml" <<'Y'
steps:
  - script: ./subir.sh
    displayName: 'Upload to PluginExtensions Staging'
    continueOnError: true
  - script: ./subir.sh
    displayName: 'Upload to PluginExtensions'
    continueOnError: true
  - script: git commit -m version
    displayName: 'Commit version update [skip ci]'
    continueOnError: true
Y
rc=$(corre "$TMP/principal.yml")
[ "$rc" -eq 0 ] && ok "el paso que sube el paquete al host de plugins y el que commitea la versión no se marcan" || no "🔴 falso positivo sobre los pasos de la rama principal ($rc): $(grep '🔴' "$TMP/out.txt"|head -2)"
for nombre in 'Upload to S3 production' 'Upload to storage staging' 'Upload artifacts' 'Upload to production'; do
  printf "steps:\n  - script: ./subir.sh\n    displayName: '%s'\n    continueOnError: true\n" "$nombre" > "$TMP/otro.yml"
  rc=$(corre "$TMP/otro.yml")
  [ "$rc" -eq 1 ] && ok "«${nombre}» tolerante → se marca: no es el paso del host de plugins" || no "🔴 «${nombre}» con continueOnError salió $rc: el reconocedor lo dio por inofensivo"
done

# ---------------------------------------------------------------- 2b. bajar el ARNÉS no es inofensivo
# La clase no está en la lista blanca. «Hay copia local de respaldo, y si falta, el paso que la usa corta por su
# cuenta» no se sostiene: sin la copia local, los pasos que usan los guiones —versionar, desplegar, el humo—
# fallan DESPUÉS, con un error que no se parece a la causa. La marca tolerante no puede volver sin que alguien
# la justifique.
cat > "$TMP/arnes.yml" <<'Y'
steps:
  - task: DownloadPipelineArtifact@2
    displayName: 'Download harness scripts'
    continueOnError: true
    inputs:
      artifactName: 'arnes-ci'
Y
rc=$(corre "$TMP/arnes.yml")
{ [ "$rc" -eq 1 ] && grep -q "Download harness scripts" "$TMP/out.txt"; }   && ok "🔴 bajar el arnés marcado como tolerante SE MARCA (sin los guiones no se sigue)"   || no "🔴 la descarga tolerante del arnés se escapó (salió $rc)"
sed 's/^    continueOnError: true$//' "$TMP/arnes.yml" > "$TMP/arnes-ok.yml"
rc=$(corre "$TMP/arnes-ok.yml")
[ "$rc" -eq 0 ] && ok "…y sin la marca, limpio" || no "🔴 falso positivo sobre la descarga estricta ($rc)"

# ---------------------------------------------------------------- 3. un paso SIN tolerancia no se mira
cat > "$TMP/normal.yml" <<'Y'
steps:
  - script: ./desplegar.sh
    displayName: 'Deploy to production'
Y
rc=$(corre "$TMP/normal.yml")
[ "$rc" -eq 0 ] && ok "un paso sin la marca no se mira (sólo importa lo tolerante)" || no "🔴 marcó un paso sin continueOnError ($rc)"

# ---------------------------------------------------------------- 4. sin nombre propio, igual se juzga
cat > "$TMP/sinnombre.yml" <<'Y'
steps:
  - script: ./subir-el-paquete.sh
    continueOnError: true
Y
rc=$(corre "$TMP/sinnombre.yml")
[ "$rc" -eq 1 ] && ok "un paso tolerante SIN nombre propio también se marca (no se escapa por anónimo)" || no "🔴 el anónimo se escapó ($rc)"

# ---------------------------------------------------------------- 5. 🔴 ilegible NO es aprobado
rc=$(corre "$TMP/no-existe.yml")
[ "$rc" -eq 2 ] && ok "🔴 un archivo que no se puede leer sale 2, no 0" || no "🔴 el ilegible salió $rc"

# ---------------------------------------------------------------- 6. sin argumentos no opina verde
rc=$(corre)
[ "$rc" -eq 2 ] && ok "sin archivos que mirar sale 2" || no "🔴 sin argumentos salió $rc"

# ---------------------------------------------------------------- 7. los 14 reales están limpios
# 🔴 Se lee lo PUBLICADO (`origin/main`), no el árbol de trabajo. El checkout del dev suele estar en `dev`,
# y así este caso daría ROJO con hallazgos que en `main` no existen (de la rama `dev` de algunos frontends y de
# repos que ni siquiera son del arnés): el control acusaría a pipelines que no corren. El comparador entre
# productos y la revisión nocturna de dependencias leen lo publicado por la misma razón.
REALES=""
for r in Totora/Backend Totora/FrontEnd URUTAU/Backend URUTAU/FrontEnd Lapacho/Backend Lapacho/FrontEnd \
         Ceibo/CeiboBackend Ceibo/CeiboFrontEnd FRESNO/FRESNOBZExtBackend FRESNO/FRESNOBZExtForms; do
  for a in azure-pipelines.yml azure-pipelines-prod.yml; do
    d="$HOME/SourceCode/$r"; [ -d "$d/.git" ] || continue
    if git -C "$d" show "origin/main:$a" > "$TMP/pub-${r//\//_}-$a" 2>/dev/null; then
      REALES="$REALES $TMP/pub-${r//\//_}-$a"
    fi
  done
done
if [ -n "$REALES" ]; then
  rc=$(corre $REALES)
  [ "$rc" -eq 0 ] && ok "los pipelines publicados en origin/main están limpios (el control no nace con deuda)" \
    || no "🔴 hay pasos tolerantes sin justificar en los pipelines reales: $(grep -c '🔴 ' "$TMP/out.txt")"
else
  echo "⚠️ tolerantes: no se pudo leer origin/main de ningún repo en esta máquina — caso 7 salteado (constancia, no verde)"
fi

# ---------------------------------------------------------------- 8. la evidencia congelada se pone ROJA
# Sobre los 14 pipelines tal como estaban antes de sacar la marca tolerante, el control tiene que marcar
# las descargas tolerantes del arnés. Sin este caso, el verde del caso 7
# no significaría nada — podría estar verde porque el control no mira.
EV="$AQUI/tasks/evidencia/2026-09-02-antes-de-los-arreglos"
if ls "$EV"/*.yml >/dev/null 2>&1; then
  rc=$(corre "$EV"/*.yml)
  n=$(grep -c "Download harness scripts" "$TMP/out.txt")
  { [ "$rc" -eq 1 ] && [ "$n" -gt 0 ]; }     && ok "🔴 contra la evidencia congelada se pone rojo: $n descarga(s) tolerante(s) del arnés"     || no "🔴 la evidencia congelada salió $rc con $n hallazgos de arnés — el control no mide"
else
  echo "⚠️ tolerantes: la evidencia congelada no está — caso 8 salteado (constancia, no verde)"
fi

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ pasos-tolerantes: todo verde ($casos casos)"; exit 0; } || { echo "❌ pasos-tolerantes: $fallos falla(s)"; exit 1; }
