#!/usr/bin/env bash
# stage-cutoff.test.sh — ¿las etapas CORTAN cuando tienen que cortar?
#
# 🔴 POR QUÉ EXISTE. Incluye casos de falla a propósito para asegurar que las etapas cortan
# cuando deben cortar y no continúan exitosamente los pipes.
#
# Todo lo demás que el arnés prueba son GUIONES: se les inyecta un `curl` falso y se verifica que
# fallen bien. Eso no dice nada sobre el YAML. La pregunta de acá es otra: con la construcción en
# rojo, ¿el paso que commitea la versión corre igual?
#
# Contestar esa pregunta rompiendo algo de verdad y mirando una corrida
# real es caro. Se contesta local con `Runner.Client` (runner.server, de la comunidad): evalúa las
# condiciones de Azure DevOps y decide qué corre y qué se saltea. Ver
# `guides/maintaining/probar-pipelines-sin-correrlos.md`.
#
# 🔴 LAS CONDICIONES NO SE INVENTAN: se leen del pipeline REAL de cada producto. Si mañana alguien
# le saca el `succeeded()` a un paso que escribe en el repositorio, este caso se pone rojo — que es
# exactamente el defecto que se quiere atrapar.
#
# Si `Runner.Client` no está instalado, la suite AVISA y sale 0: no puede exigirse en cada máquina
# del equipo. Pero cuando está, la pregunta se contesta.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.dotnet/tools"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OK=0; MAL=0
ok() { echo "✅ etapas: $1"; OK=$((OK+1)); }
no() { echo "❌ etapas: $1"; MAL=$((MAL+1)); }

if ! command -v Runner.Client >/dev/null 2>&1; then
  echo "⚠️  etapas-cortan: falta Runner.Client — la suite no puede contestar la pregunta."
  echo "   Instalar con: dotnet tool install --global Runner.Client"
  echo "   (no se exige en cada máquina: por eso avisa y sale 0, en vez de fallar)"
  exit 0
fi

# ── el caso base: el arreglo y el defecto, uno al lado del otro ───────────────────────────────
cat > "$TMP/base.yml" <<'YML'
trigger: none
pool: self-hosted
steps:
- script: exit 1
  displayName: Construir (FALLA a proposito)
- script: echo DEFECTO_CORRIO
  displayName: Paso SIN succeeded (el defecto de 4 de 5 productos el 2026-09-02)
  condition: ne('a', 'b')
- script: echo ARREGLO_CORRIO
  displayName: Paso CON succeeded (el arreglo)
  condition: and(succeeded(), ne('a', 'b'))
YML
(cd "$TMP" && Runner.Client --event azpipelines -W base.yml > salida.txt 2>&1)
grep -qE "^DEFECTO_CORRIO$|^\| DEFECTO_CORRIO$" "$TMP/salida.txt" \
  && ok "🔴 reproduce el defecto: sin succeeded(), el paso CORRE con la construcción en rojo" \
  || no "no reprodujo el defecto — sin eso, un verde acá no significa nada"
grep -qE "^ARREGLO_CORRIO$|^\| ARREGLO_CORRIO$" "$TMP/salida.txt" \
  && no "🔴 el paso CON succeeded() corrió igual — el arreglo no sirve" \
  || ok "…y con succeeded() se saltea, que es el arreglo"

# ── las condiciones REALES de cada producto ───────────────────────────────────────────────────
# Se busca, en cada pipeline de formularios, el paso que escribe en el repositorio, se toma su
# condición literal y se la prueba con la construcción en rojo.
# 🔴 SE LEE LO PUBLICADO, NO EL DISCO. La pregunta es si el pipeline que CORRE corta
# cuando debe, o sea `origin/main`. Leyendo el árbol de trabajo, un checkout parado en otra rama —lo
# normal: el dev trabaja en `dev`— se denuncia como si el producto commiteara con la construcción en
# rojo, aunque main ya tenga el succeeded(). Es el MISMO defecto que check-product-parity.js evita — un
# control que da falsas alarmas se apaga, y se lleva puestos los casos donde sí importaba.
# El disco sigue siendo el plan B, pero avisando: "no pude leer lo publicado" ≠ "leí lo publicado".
publicado() {  # publicado <archivo-en-el-disco> → imprime la ruta a usar
  local arch="$1" dir base tmp
  dir=$(dirname "$arch"); base=$(basename "$arch")
  tmp="$TMP/pub-$(echo "$dir" | tr '/' '_').yml"
  if git -C "$dir" show "origin/main:$base" > "$tmp" 2>/dev/null; then printf '%s' "$tmp"; return 0; fi
  echo "⚠️  etapas: no pude leer $base de origin/main en $dir — se mide el archivo del DISCO, que puede estar en otra rama" >&2
  printf '%s' "$arch"
}

probar_real() {  # probar_real <nombre> <archivo>
  local nom="$1" arch="$2"
  [ -f "$arch" ] || { echo "⚠️  etapas: $nom no está en esta máquina — no se midió"; return; }
  arch=$(publicado "$arch")
  local cond
  cond=$(python3 - "$arch" <<'PY'
import re,sys
L=open(sys.argv[1],encoding='utf-8').read().split('\n')
for i,l in enumerate(L):
    if re.search(r"displayName: '(Commit and push changes|Commit version update)", l):
        for j in range(max(0,i-14), min(len(L), i+14)):
            m=re.match(r'^\s*condition:\s*(and\(.+)$', L[j])
            if m: print(m.group(1)); sys.exit()
PY
)
  [ -z "$cond" ] && { echo "⚠️  etapas: $nom no tiene condición explícita en ese paso (rige el succeeded() implícito)"; return; }
  # las variables no existen fuera de Azure: se reemplazan por literales que no cambian el veredicto
  local c
  c=$(printf '%s' "$cond" | sed -E "s/variables\['[^']*'\]/'x'/g; s/'refs\/heads\/main'/'x'/g; s/'PullRequest'/'y'/g; s/'true'/'x'/g")
  printf 'trigger: none\npool: self-hosted\nsteps:\n- script: exit 1\n  displayName: Construir (FALLA)\n- script: echo ESCRIBIO_CON_ROJO\n  displayName: Commit\n  condition: %s\n' "$c" > "$TMP/r.yml"
  (cd "$TMP" && Runner.Client --event azpipelines -W r.yml > r.txt 2>&1)
  if grep -qE "^ESCRIBIO_CON_ROJO$|^\| ESCRIBIO_CON_ROJO$" "$TMP/r.txt"; then
    no "🔴 $nom: commitea al repositorio CON LA CONSTRUCCIÓN EN ROJO"
  else
    ok "$nom: no commitea con la construcción en rojo"
  fi
}

B="$DIR/../../.."
probar_real "Totora formularios"   "$HOME/SourceCode/Totora/FrontEnd/azure-pipelines.yml"
probar_real "URUTAU formularios"     "$HOME/SourceCode/URUTAU/FrontEnd/azure-pipelines.yml"
probar_real "Lapacho formularios" "$HOME/SourceCode/Lapacho/FrontEnd/azure-pipelines.yml"
probar_real "Ceibo formularios"    "$HOME/SourceCode/Ceibo/CeiboFrontEnd/azure-pipelines.yml"
probar_real "FRESNO formularios"       "$HOME/SourceCode/FRESNO/FRESNOBZExtForms/azure-pipelines.yml"

# ── y una etapa entera: si la de pruebas falla, la que empaqueta NO corre ─────────────────────
cat > "$TMP/etapas.yml" <<'YML'
trigger: none
stages:
- stage: Pruebas
  jobs:
  - job: j
    pool: self-hosted
    steps:
    - script: exit 1
      displayName: Pruebas que fallan
- stage: Build
  dependsOn: Pruebas
  condition: in(dependencies.Pruebas.result, 'Succeeded', 'SucceededWithIssues')
  jobs:
  - job: k
    pool: self-hosted
    steps:
    - script: echo EMPAQUETO_CON_PRUEBAS_ROJAS
      displayName: Empaquetar
YML
(cd "$TMP" && Runner.Client --event azpipelines -W etapas.yml > e.txt 2>&1)
grep -qE "^EMPAQUETO_CON_PRUEBAS_ROJAS$|^\| EMPAQUETO_CON_PRUEBAS_ROJAS$" "$TMP/e.txt" \
  && no "🔴 empaquetó con las pruebas en rojo" \
  || ok "la etapa que empaqueta se saltea si las pruebas fallan"

echo "─────────────"
[ $MAL -eq 0 ] && { echo "✅ etapas-cortan: todo verde ($OK casos)"; exit 0; }
echo "❌ etapas-cortan: $MAL de $((OK+MAL))"; exit 1
