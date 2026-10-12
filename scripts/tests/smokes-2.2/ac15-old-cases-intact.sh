#!/usr/bin/env bash
# =============================================================================
# ac15-old-cases-intact.sh — los casos de la 2.1 siguen ahí, sin retocar.
#
# El AC 15 pide que `sdlc-transitions.test.js` y `sdlc-stage-metrics.test.js` sigan verdes
# **sin tocar sus casos existentes**, salvo el único que asserta el contenido del diccionario
# MÍNIMO, que esta story reemplaza por el completo y que se nombra en el commit.
#
# 🔴 POR QUÉ ES UN SMOKE Y NO UN CASO DE LA SUITE. La única forma de verificarlo es comparar
#    contra `origin/main`, y eso deja de significar nada en cuanto la story se mergea: el diff
#    se vacía y el caso pasaría para siempre sin poder ponerse rojo. Un control que no puede
#    fallar es peor que no tenerlo — así que vive acá, se corre UNA vez antes del merge, y su
#    resultado queda en el ledger con su código de salida real. Mismo criterio que el último
#    smoke de la story 2.1, que ya chequeaba esto para su propio diff.
#
# Uso: bash ac15-old-cases-intact.sh <raiz-del-repo>
# =============================================================================
set -uo pipefail
RAIZ="${1:?falta la raíz del repo}"

git -C "$RAIZ" rev-parse --verify origin/main >/dev/null 2>&1 || {
  echo "🛑 no hay origin/main contra qué comparar: este smoke no puede medir nada"; exit 3; }

# El caso que SÍ se puede tocar, nombrado. Cualquier línea borrada fuera de él es un hallazgo.
CASO_PERMITIDO='T14 · los estados del diccionario son los medidos'
FALLAS=0

# ── (a) la suite que esta story NO toca: cero líneas borradas ──
BORRADAS=$(git -C "$RAIZ" diff origin/main -- scripts/tests/sdlc-stage-metrics.test.js \
  | grep -cE '^-[^-]' || true)
if [ "$BORRADAS" != "0" ]; then
  echo "🛑 sdlc-stage-metrics.test.js perdió $BORRADAS línea(s): esta story no lo toca"
  FALLAS=$((FALLAS + 1))
else
  echo "✓ sdlc-stage-metrics.test.js: sin una sola línea borrada"
fi

# ── (b) la suite que sí crece: sólo se agregan casos, y lo borrado cae DENTRO del caso permitido ──
python3 - "$RAIZ" "$CASO_PERMITIDO" <<'PY'
import re, subprocess, sys

raiz, permitido = sys.argv[1], sys.argv[2]
rel = 'scripts/tests/sdlc-transitions.test.js'

viejo = subprocess.run(['git', '-C', raiz, 'show', f'origin/main:{rel}'],
                       capture_output=True, text=True)
if viejo.returncode != 0:
    print(f'🛑 no pude leer la versión publicada de {rel}: {viejo.stderr.strip()}')
    sys.exit(2)
lineas = viejo.stdout.split('\n')

# 🔴 Se juzga por POSICIÓN, no por texto. La primera versión de este smoke comparaba el TEXTO de
#    cada línea borrada contra el conjunto de líneas del caso permitido: una línea borrada en
#    cualquier otro caso pasaba desapercibida con sólo parecerse a una de adentro — y en un archivo
#    de tests las líneas se repiten todo el tiempo (`});`, `const { repo } = nuevoRepo(...)`, un
#    assert idéntico). Lo cazó el pase adversarial del 2026-09-05. Ahora se miran los NÚMEROS DE
#    LÍNEA del archivo publicado, que es lo único que distingue un caso de otro.
ini = next((i for i, l in enumerate(lineas) if permitido in l), None)
if ini is None:
    print(f'🛑 no encontré el caso «{permitido}» en la versión publicada: '
          'el smoke no puede juzgar qué era legítimo tocar')
    sys.exit(2)
fin = next((i for i in range(ini, len(lineas)) if lineas[i].startswith('});')), len(lineas))
permitido_desde, permitido_hasta = ini + 1, fin + 1        # 1-based, como el diff

# `-U0`: sin contexto, así cada hunk dice EXACTAMENTE qué líneas viejas desaparecieron.
diff = subprocess.run(['git', '-C', raiz, 'diff', '-U0', 'origin/main', '--', rel],
                      capture_output=True, text=True)
if diff.returncode != 0:
    print(f'🛑 no pude leer el diff de {rel}: {diff.stderr.strip()}')
    sys.exit(2)

intrusas, borradas, agregadas = [], 0, 0
linea_vieja = None
for l in diff.stdout.split('\n'):
    m = re.match(r'^@@ -(\d+)(?:,(\d+))? \+', l)
    if m:
        linea_vieja = int(m.group(1))
        continue
    if l.startswith('+++') or l.startswith('---'):
        continue
    if l.startswith('+'):
        agregadas += 1
    elif l.startswith('-') and linea_vieja is not None:
        borradas += 1
        if not (permitido_desde <= linea_vieja <= permitido_hasta):
            intrusas.append((linea_vieja, l[1:]))
        linea_vieja += 1

if intrusas:
    print(f'🛑 {rel}: se borraron {len(intrusas)} línea(s) FUERA del caso «{permitido}» '
          f'(que ocupa las líneas {permitido_desde}-{permitido_hasta} de la versión publicada)')
    for n, l in intrusas[:8]:
        print(f'    − línea {n}: {l.strip()[:100]}')
    sys.exit(1)

print(f'✓ {rel}: +{agregadas} líneas, y las {borradas} borradas caen todas dentro de las líneas '
      f'{permitido_desde}-{permitido_hasta}, que son el único caso que esta story actualiza')
PY
[ $? -ne 0 ] && FALLAS=$((FALLAS + 1))

# ── (c) y las dos suites, verdes ──
node "$RAIZ/scripts/tests/sdlc-stage-metrics.test.js" >/dev/null 2>&1 \
  && echo "✓ sdlc-stage-metrics.test.js verde" \
  || { echo "🛑 sdlc-stage-metrics.test.js en rojo"; FALLAS=$((FALLAS + 1)); }
node "$RAIZ/scripts/tests/sdlc-transitions.test.js" >/dev/null 2>&1 \
  && echo "✓ sdlc-transitions.test.js verde" \
  || { echo "🛑 sdlc-transitions.test.js en rojo"; FALLAS=$((FALLAS + 1)); }

[ "$FALLAS" -eq 0 ] || { echo "FALLARON $FALLAS chequeo(s) del AC 15"; exit 1; }
echo "AC 15 · los casos viejos siguen intactos y verdes"
