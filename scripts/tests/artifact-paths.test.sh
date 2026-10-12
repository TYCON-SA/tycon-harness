#!/usr/bin/env bash
# Prueba de check-artifact-paths.js — el control que impide que un pipeline LEA de una carpeta
# que él nunca LLENA. Nace del defecto real del 2026-09-03: los pipelines de producción de los
# plugins de dos productos del equipo bajaban el artefacto a $(Pipeline.Workspace)/ci y UN paso lo buscaba en
# $(System.ArtifactsDirectory) — el despliegue a producción fallaba SIEMPRE, después de la
# aprobación humana. Los casos 1 y 2 reproducen ese defecto y su gemelo correcto: sin ese par, un
# verde de este control no significaría nada.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-artifact-paths.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; ok(){ echo "✅ rutas: $1"; }; no(){ echo "❌ rutas: $1"; fallos=$((fallos+1)); }
corre(){ node "$CHK" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

# ---------------------------------------------------------------- 1. 🔴 EL DEFECTO REAL
cat > "$TMP/roto.yml" <<'Y'
steps:
  - download: ci
  - script: |
      ARNES="$(Pipeline.Workspace)/ci/arnes-ci"
      ZIP_FILE=$(find "$(System.ArtifactsDirectory)" -name "*.zip" -type f | head -1)
Y
rc=$(corre "$TMP/roto.yml")
[ "$rc" -eq 1 ] && ok "🔴 baja a un lado y lee del otro → lo marca (el defecto que rompió producción)" || no "🔴 el defecto real salió $rc"
grep -q "Pipeline.Workspace" "$TMP/out.txt" && ok "…y dice adónde SÍ baja, para que el arreglo sea obvio" || no "no dijo adónde baja"

# ---------------------------------------------------------------- 2. …y el gemelo correcto NO se marca
cat > "$TMP/bien.yml" <<'Y'
steps:
  - task: DownloadPipelineArtifact@2
    inputs:
      targetPath: '$(System.ArtifactsDirectory)'
  - script: |
      ZIP_FILE=$(find "$(System.ArtifactsDirectory)" -name "*.zip" -type f | head -1)
Y
rc=$(corre "$TMP/bien.yml")
[ "$rc" -eq 0 ] && ok "un pipeline que baja A esa carpeta y lee de ahí está bien y NO se marca" || no "🔴 falso positivo: marcó el caso correcto ($rc)"

# ---------------------------------------------------------------- 3. no juzga cuál carpeta es 'la buena'
cat > "$TMP/workspace.yml" <<'Y'
steps:
  - download: ci
  - script: ZIP=$(find "$(Pipeline.Workspace)/ci" -name "*.zip" | head -1)
Y
rc=$(corre "$TMP/workspace.yml")
[ "$rc" -eq 0 ] && ok "un pipeline que usa la otra carpeta de punta a punta no se marca" || no "🔴 marcó por nombre de variable ($rc)"

# ---------------------------------------------------------------- 4. un COMENTARIO no es una lectura
cat > "$TMP/comentario.yml" <<'Y'
steps:
  - download: ci
  - script: |
      # antes esto buscaba en $(System.ArtifactsDirectory) y estaba mal
      ZIP=$(find "$(Pipeline.Workspace)/ci" -name "*.zip" | head -1)
Y
rc=$(corre "$TMP/comentario.yml")
[ "$rc" -eq 0 ] && ok "un comentario que la nombra no cuenta como lectura" || no "🔴 marcó por un comentario ($rc) — así se apaga un control"

# ---------------------------------------------------------------- 5. varias lecturas, todas nombradas
cat > "$TMP/dos.yml" <<'Y'
steps:
  - download: ci
  - script: A=$(find "$(System.ArtifactsDirectory)" -name "*.zip")
  - script: B=$(ls "$(System.ArtifactsDirectory)")
Y
rc=$(corre "$TMP/dos.yml")
[ "$rc" -eq 1 ] && [ "$(grep -c 'línea ' "$TMP/out.txt")" -eq 2 ] && ok "nombra TODAS las lecturas, no sólo la primera" || no "🔴 no nombró las dos ($rc): $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 6. 🔴 ilegible NO es aprobado
rc=$(corre "$TMP/no-existe.yml")
[ "$rc" -eq 2 ] && ok "🔴 un archivo que no se puede leer sale 2, no 0" || no "🔴 el ilegible salió $rc"

# ---------------------------------------------------------------- 7. sin argumentos no opina verde
rc=$(corre)
[ "$rc" -eq 2 ] && ok "sin archivos que mirar sale 2 (no opina verde sobre nada)" || no "🔴 sin argumentos salió $rc"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ rutas-de-artefacto: todo verde"; exit 0; else echo "❌ rutas-de-artefacto: $fallos falla(s)"; exit 1; fi
