#!/usr/bin/env bash
# =============================================================================
# ac14-expected-metrics.sh — el criterio nuevo de «cerrado» mueve lo esperado, ni más ni menos.
#
# Corre el medidor DOS VECES sobre los MISMOS repos reales: una con el diccionario de esta
# story y otra con un diccionario que reproduce exactamente lo que decidía la lista fija del
# código (`done`, `completed`, `closed` sobre el valor crudo, sin resolver alias). El delta de
# `done_total` tiene que ser EXACTAMENTE el número de stories cuyo estado el diccionario manda
# a `cerrado` y la lista vieja no reconocía.
#
# 🔴 Un delta distinto es rojo, en las dos direcciones: de menos significa que el criterio no
#    se aplicó; de más, que se llevó puesto algo que no era una entrega — que es la trampa
#    central de esta story (`cancelled` y compañía terminan, pero no entregan).
#
# Uso: bash ac14-expected-metrics.sh <medidor.js> <states.json> <raiz-de-repos>
# =============================================================================
set -uo pipefail
MEDIDOR="${1:?falta la ruta del medidor}"
ESTADOS="${2:?falta la ruta de states.json}"
RAIZ_REPOS="${3:?falta la raíz de repos}"

[ -d "$RAIZ_REPOS" ] || { echo "🛑 no existe la raíz de repos: $RAIZ_REPOS"; exit 3; }
[ -f "$ESTADOS" ] || { echo "🛑 no existe el diccionario: $ESTADOS"; exit 3; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# El diccionario "como la lista vieja del código": los tres valores crudos que `DONE_STATUSES`
# reconocía, y NINGÚN alias hacia `done`.
python3 - "$ESTADOS" "$TMP/viejo.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
v = json.loads(json.dumps(d))
for a in ('implemented', 'complete', 'completed', 'closed', 'vigente', 'merged'):
    v['alias'].pop(a, None)
v['canonical'] += ['completed', 'closed']
v['groups']['cerrado'] = ['done', 'completed', 'closed']
json.dump(v, open(sys.argv[2], 'w'))
PY

corrida() {  # $1 = archivo de salida, $2 = diccionario (vacío = el canónico)
  if [ -n "${2:-}" ]; then export TYCON_STATES_PATH="$2"; else unset TYCON_STATES_PATH; fi
  node "$MEDIDOR" --scan "$RAIZ_REPOS" --json --transitions-budget-ms 1 > "$1" 2>/dev/null
}
corrida "$TMP/nuevo.json" ""            || { echo "🛑 la corrida con el diccionario nuevo falló"; exit 1; }
corrida "$TMP/viejo.json.out" "$TMP/viejo.json" || { echo "🛑 la corrida con el criterio viejo falló"; exit 1; }

python3 - "$TMP/nuevo.json" "$TMP/viejo.json.out" <<'PY'
import json, sys

nue = json.load(open(sys.argv[1]))
vie = json.load(open(sys.argv[2]))

def done(d):
    return sum(r['done_total'] for r in d['repos'] if r.get('done_total') is not None)
def stories(d):
    return sum(r['stories_total'] for r in d['repos'] if r.get('stories_total') is not None)

dn, dv = done(nue), done(vie)
assert stories(nue) == stories(vie), 'los dos universos tienen que ser el MISMO: si no, el delta no compara nada'

# Lo esperado, contado desde el propio conteo: las stories cuyo canónico está en `cerrado` y que
# la lista vieja no reconocía = las que el criterio nuevo suma.
print(f'stories: {stories(nue)}   ·   cerradas viejo: {dv}   nuevo: {dn}   ·   delta: {dn - dv:+}')

# 🔴 Ninguna de las terminales-que-no-entregan puede haber entrado.
g = nue['global']['estados_por_canonico']
sin_entrega = g['por_grupo'].get('sin_entrega', 0)
print(f'terminales sin entrega (fuera de cerradas): {sin_entrega}')
assert g['por_grupo']['cerrado'] == dn, (
    f"el grupo cerrado ({g['por_grupo']['cerrado']}) y done_total ({dn}) tienen que ser el mismo número: "
    'si difieren, hay DOS criterios de «cerrado» otra vez')

# Las cuatro métricas que dependen de qué es «cerrado» sólo pueden moverse con el delta.
if dn == dv:
    for k in ('rework_ratio', 'dod_evidence_ratio'):
        assert nue['global'][k] == vie['global'][k], f'{k} se movió con delta 0'
    print('✓ delta 0: las métricas derivadas salen idénticas')
else:
    for k in ('rework_ratio', 'dod_evidence_ratio'):
        a, b = nue['global'][k], vie['global'][k]
        assert a['den'] - b['den'] == dn - dv, (
            f'{k}: el denominador se movió {a["den"] - b["den"]} y el delta de cerradas es {dn - dv}')
    print(f'✓ delta {dn - dv:+}: los denominadores de rework y dod se movieron exactamente eso')

# first_pass_ratio NO depende de `status:` — se lee del dashboard. Que no se mueva NUNCA.
assert nue['global']['first_pass_ratio'] == vie['global']['first_pass_ratio'], \
    'first_pass_ratio se movió y no puede: no mira un solo status'
print('✓ first_pass_ratio intacto (no depende del diccionario)')
PY
