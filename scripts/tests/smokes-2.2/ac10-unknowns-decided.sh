#!/usr/bin/env bash
# =============================================================================
# ac10-unknowns-decided.sh — la ficha del tablero, generada de verdad.
#
# Genera `artifacts/tablero-del-arnes.html` con un snapshot REAL (el que produce el medidor
# sobre los repos del disco) y verifica sobre el HTML resultante que las tres fichas están,
# con denominador, con la cobertura de repos, y con los desconocidos NOMBRADOS.
#
# 🔴 El desglose de «en curso» no es decoración: medido el 2026-09-05, 181 de 217 (83 %)
#    están en `review`. Sin el desglose la ficha esconde lo que más importa y del lado que
#    da lindo — y la ficha vecina no lo rescata, porque el tiempo por etapa excluye por
#    diseño la etapa en la que la story está AHORA.
#
# Uso: bash ac10-unknowns-decided.sh <medidor.js> <dashboard.js> <raiz-de-repos>
# =============================================================================
set -uo pipefail
MEDIDOR="${1:?falta la ruta del medidor}"
TABLERO="${2:?falta la ruta del tablero}"
RAIZ_REPOS="${3:?falta la raíz de repos}"
RAIZ="$(cd "$(dirname "$TABLERO")/../.." && pwd)"

[ -d "$RAIZ_REPOS" ] || { echo "🛑 no existe la raíz de repos: $RAIZ_REPOS"; exit 3; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
D="$TMP/dash"; mkdir -p "$D"

node "$MEDIDOR" --scan "$RAIZ_REPOS" --json --transitions-budget-ms 1 > "$TMP/real.json" 2>/dev/null \
  || { echo "🛑 el medidor no pudo correr"; exit 1; }

# El snapshot con fecha de hoy (el tablero borra los números de un dato viejo, a propósito), y el
# resto de las fuentes copiadas del .dashboard real para que la página se pueda generar entera.
python3 - "$TMP/real.json" "$D" <<'PY'
import json, sys, datetime, os
d = json.load(open(sys.argv[1]))
d['generated_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
hoy = datetime.datetime.now(datetime.timezone.utc).date()
json.dump(d, open(os.path.join(sys.argv[2], f'sdlc-stage-{hoy}.json'), 'w'))
PY
for sub in controls-bench dependencias vigilante; do
  [ -d "$RAIZ/.dashboard/$sub" ] && cp -R "$RAIZ/.dashboard/$sub" "$D/" 2>/dev/null
done
cp "$RAIZ"/.dashboard/metrics-*.json "$D/" 2>/dev/null

node "$TABLERO" --dir "$D" --output "$TMP/o.html" >/dev/null 2>&1
[ -f "$TMP/o.html" ] || { echo "🛑 el tablero no escribió la página"; exit 1; }

python3 - "$TMP/o.html" <<'PY'
import re, sys
html = open(sys.argv[1], encoding='utf8').read()

def tile(titulo):
    for frag in html.split('<div class="tile ')[1:]:
        if titulo in frag[:1200]:
            return frag[:1400]
    return None

fallas = []
for t in ('Trabajo en curso', 'En el backlog', 'no reconoce'):
    f = tile(t)
    if f is None:
        fallas.append(f'falta la ficha «{t}»'); continue
    if f.startswith('blind'):
        fallas.append(f'la ficha «{t}» salió con trama sobre un snapshot REAL: '
                      + (re.search(r'<div class="t-den">([^<]*)', f) or [None, '?'])[1])
        continue
    den = re.search(r'<div class="t-den">([^<]*)', f)
    if not den or 'stories' not in den.group(1) or 'repos' not in den.group(1):
        fallas.append(f'la ficha «{t}» no trae denominador y cobertura: {den and den.group(1)}')
    val = re.search(r'<div class="t-val">([^<]*)', f)
    print(f'  {t:22} {val.group(1):>6}   {den.group(1) if den else ""}')
    pie = re.search(r'<div class="t-foot">([^<]*)', f)
    if pie:
        print(f'  {"":22} {"":>6}   ↳ {pie.group(1)}')

# El desglose de «en curso» tiene que estar y nombrar la revisión.
f = tile('Trabajo en curso') or ''
if 'en revisión' not in f:
    fallas.append('«en curso» no se desglosa por canónico: la cola de revisión queda escondida')

# Y el pie que admitía el problema ya no puede estar.
if 'Hoy no hay forma de distinguir' in html:
    fallas.append('sigue el pie que admitía que no se podía distinguir en curso de archivado')
if 'Stories abiertas en toda la historia medida' in html:
    fallas.append('sigue la resta vieja que esta story viene a jubilar')

assert not fallas, '\n'.join('🛑 ' + x for x in fallas)
print('✓ las tres fichas, con denominador, cobertura y desglose, sobre un snapshot real')
PY
