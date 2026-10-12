#!/usr/bin/env bash
# =============================================================================
# ac13-real-measurement.sh — el AC 13 de la story 2.2, el ÚNICO que toca la realidad.
#
# Corre el medidor sobre los repos REALES del disco y exige que lo que publica sea
# accionable: los tres números con su DENOMINADOR y con el universo NOMBRADO. Un solo
# número sin decir de dónde sale es peor que dos números — medir en un universo y
# publicar el del otro es la falla que el arnés cerró el 2026-09-03.
#
# 🔴 Falla si falta cualquiera de los tres, si falta el denominador, o si Dev Notes de la
#    story no trae los números. Publicar sólo el total sin denominador NO alcanza.
#
# Uso: bash ac13-real-measurement.sh <medidor.js> <raiz-de-repos> <story.md>
# =============================================================================
set -uo pipefail
MEDIDOR="${1:?falta la ruta del medidor}"
RAIZ_REPOS="${2:?falta la raíz de repos}"
STORY="${3:?falta la ruta de la story}"

[ -d "$RAIZ_REPOS" ] || { echo "🛑 no existe la raíz de repos: $RAIZ_REPOS — sin ella esto no mide nada"; exit 3; }
[ -f "$STORY" ] || { echo "🛑 no existe la story: $STORY"; exit 3; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# El presupuesto de transiciones se pone al mínimo A PROPÓSITO: este AC mide el contador del
# PRESENTE, que se lee del frontmatter y NO depende de git. Si el contador saliera `null` acá,
# sería exactamente el «no medido» falso que el AC 9 prohíbe — así que el smoke lo ejerce.
node "$MEDIDOR" --scan "$RAIZ_REPOS" --json --transitions-budget-ms 1 > "$TMP/real.json" 2>/dev/null \
  || { echo "🛑 el medidor no pudo correr sobre los repos reales"; exit 1; }

python3 - "$TMP/real.json" "$STORY" <<'PY'
import json, re, sys

d = json.load(open(sys.argv[1]))
story = open(sys.argv[2], encoding='utf8').read()

g = (d.get('global') or {}).get('estados_por_canonico')
assert g, 'el global no trae estados_por_canonico: el AC 13 no se puede publicar'

repos = d.get('repos') or []
con = [r for r in repos if r.get('estados_por_canonico')]
assert con, 'ningún repo produjo el contador'

en_curso = g['por_grupo']['en_curso']
backlog = g['por_grupo']['backlog']
desc = sum(g['sin_diccionario'].values())
total = g['total']

# 🔴 El denominador NO es opcional: un número de «en curso» sin el total de stories no dice si
#    el equipo está saturado o tranquilo, que es la única razón por la que existe la ficha.
assert total and total > 0, 'sin denominador (total de stories) el número no significa nada'
assert en_curso + backlog + desc <= total, 'los tres no pueden sumar más que su denominador'

# El invariante, leído del archivo publicado (mismo criterio que T8).
suma = sum(g['conteo'].values()) + desc + g['sin_status']
assert suma == total, f'el invariante no cierra: {suma} != {total}'

print(f"universo: disco del dev · {len(con)} de {len(repos)} repos · {total} stories")
print(f"  en curso     {en_curso:5}  ({en_curso*100//total} %)  "
      f"[{g['conteo'].get('in-progress', 0)} en desarrollo · {g['conteo'].get('review', 0)} en revisión]")
print(f"  backlog      {backlog:5}  ({backlog*100//total} %)")
print(f"  desconocidas {desc:5}  ({len(g['sin_diccionario'])} valores distintos)")
print(f"  cerradas     {g['por_grupo']['cerrado']:5}")

# 🔴 Y el número tiene que estar ESCRITO en Dev Notes, con su denominador. Sin esto el smoke
#    verificaría que el medidor sabe contar, no que la story publicó lo que prometió.
faltan = []
for n in (en_curso, total, desc):
    if not re.search(rf'\b{n}\b', story):
        faltan.append(n)
assert not faltan, (f'Dev Notes de la story no publica {faltan}: el AC 13 exige el número '
                    f'medido con su denominador, salga como salga')

# Y tiene que NOMBRAR los dos universos: medir en uno y publicar el otro es la falla conocida.
for palabra in ('disco', 'nocturno'):
    assert palabra in story.lower(), f'la story no nombra el universo «{palabra}»'
print('✓ los números están en Dev Notes y los dos universos están nombrados')
PY
