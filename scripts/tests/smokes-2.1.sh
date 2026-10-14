#!/usr/bin/env bash
# =============================================================================
# smokes-2.1.sh — la verificación RUNTIME de la story 2.1, por criterio.
#
# Por qué existe: el portón de Definición de Terminado exige que cada criterio se
# ejercite CORRIENDO el producto, no leyendo el código. Esta story no tiene pantalla ni
# endpoint HTTP: su producto es el medidor, y su "runtime" es correrlo contra repos de
# verdad y mirar lo que publica. Cada smoke va por `smoke-run.sh`, que captura el EXIT
# CODE REAL y lo deja en el ledger del repo Y en el registro global (la matriz sólo
# cuenta lo que aparece en los dos: un ledger escrito a mano no sirve).
#
# Uso:  bash scripts/tests/smokes-2.1.sh [<repo-real>]
#       (default: ~/SourceCode/Ceibo/CeiboProject — 275 stories con 4 meses de historia)
# =============================================================================
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_REAL="${1:-$HOME/SourceCode/Ceibo/CeiboProject}"
MEDIDOR="$RAIZ/scripts/metrics/sdlc-stage-metrics.js"
TABLERO="$RAIZ/scripts/nightly/dashboard/dashboard.js"
EVID="$RAIZ/.advisors/dod-runtime"
SMOKE="$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh"
SID="2.1"
mkdir -p "$EVID"

if [ ! -d "$REPO_REAL/.git" ]; then
  echo "🛑 no encuentro el repo real ($REPO_REAL): sin él estos smokes no prueban nada." >&2
  echo "   Pasá otro como primer argumento. NO se registra evidencia." >&2
  exit 3
fi
if [ ! -x "$SMOKE" ]; then
  echo "🛑 no encuentro smoke-run.sh ($SMOKE): sin él la evidencia no queda registrada." >&2
  exit 3
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "== smokes de la story 2.1 · repo real: $REPO_REAL =="

# El JSON del repo real, UNA vez: es el insumo de casi todos los criterios.
node "$MEDIDOR" --repo "$REPO_REAL" --json > "$TMP/real.json" 2>/dev/null || {
  echo "🛑 el medidor no pudo correr sobre el repo real"; exit 1; }

# 🔴 `corre` ACUMULA el resultado y el guion sale distinto de 0 si alguno falló. Sin esto el
#    script terminaba siempre en verde aunque un criterio rompiera: el portón de Definición de
#    Terminado no se engañaba —lee el código de salida real de cada smoke desde el ledger que
#    escribe smoke-run.sh— pero sí quien lo corriera a mano, o cualquier automatización que
#    mirara el exit code. Lo cazó el revisor de fallos silenciosos el 2026-09-05, sobre el
#    guion gemelo de la story 2.2, donde el defecto estaba copiado.
FALLAS=0
CORRIDOS=0
corre() {
  echo; echo "── $1"; shift
  CORRIDOS=$((CORRIDOS + 1))
  "$SMOKE" "$EVID" "$SID" "$@" || FALLAS=$((FALLAS + 1))
}

# ── AC 1, 3, 4, 5 · la serie sale del historial, con fecha de autor y commit ──
corre "AC 1/3/4/5 · serie derivada del historial real" --acs 1,3,4,5 -- \
  python3 -c "
import json,sys,re
d=json.load(open('$TMP/real.json')); r=d['repos'][0]
t=r['tiempo_por_etapa'] or {}
assert t, 'sin tiempo por etapa: la serie no se derivó'
assert r['stories_medidas'] and r['stories_medidas']>100, f\"pocas stories con serie: {r['stories_medidas']}\"
print(f\"{r['stories_medidas']} stories con serie derivada de {r['stories_total']}\")
"

# ── AC 2 · nadie se pierde: el invariante cierra LEÍDO DEL ARCHIVO ──
corre "AC 2 · el invariante cierra desde el snapshot publicado" --acs 2 -- \
  python3 -c "
import json
r=json.load(open('$TMP/real.json'))['repos'][0]
s=r['stories_medidas']+r['sin_transiciones']+r['sin_historial']+r['archivos_duplicados']
assert s==r['stories_total'], f\"{s} != {r['stories_total']}\"
assert r['sin_transiciones']>0, 'ninguna story sin transiciones: el caso no se ejerció'
print(f\"{s} = {r['stories_total']} · sin transiciones: {r['sin_transiciones']}\")
"

# ── AC 6 · mediana y n por etapa ──
corre "AC 6 · tiempo por etapa con mediana y n" --acs 6 -- \
  python3 -c "
import json
r=json.load(open('$TMP/real.json'))['repos'][0]
t=r['tiempo_por_etapa']
assert t, 'tiempo_por_etapa vacío'
for k,v in t.items():
    for campo in ('n','median','mean','min','max'):
        assert campo in v and v[campo] is not None, f'{k} sin {campo}'
print(' · '.join(f\"{k} {v['median']:.1f}d n={v['n']}\" for k,v in t.items()))
"

# ── AC 7 · ninguna etapa recibe un 0 imputado ──
corre "AC 7 · ninguna etapa con 0 imputado" --acs 7 -- \
  python3 -c "
import json
t=json.load(open('$TMP/real.json'))['repos'][0]['tiempo_por_etapa']
malas=[k for k,v in t.items() if v['min']<=0]
assert not malas, f'etapas con 0 imputado: {malas}'
print(f'{len(t)} etapas, ninguna con 0')
"

# ── AC 8 · presupuesto agotado → null con motivo, sin colgarse ──
corre "AC 8 · presupuesto agotado sale no medido" --acs 8 -- \
  bash -c "
node '$MEDIDOR' --repo '$REPO_REAL' --transitions-budget-ms 1 --json 2>/dev/null > '$TMP/agotado.json' || exit 1
python3 -c \"
import json
r=json.load(open('$TMP/agotado.json'))['repos'][0]
assert r['tiempo_por_etapa'] is None, 'tiempo_por_etapa tendría que ser null'
assert r['sin_transiciones'] is None and r['stories_medidas'] is None, 'los campos tendrían que anularse juntos'
m=[x for x in r['not_measured'] if 'presupuesto de tiempo agotado' in x]
assert m, r['not_measured']
print(m[0][:110])
\""

# ── AC 9 · los estados fuera del diccionario se publican (se EJECUTA la escritura) ──
corre "AC 9 · estados desconocidos publicados en el archivo escrito" --acs 9 --mutates -- \
  bash "$RAIZ/scripts/tests/smokes-2.1/ac9-unknowns-published.sh" "$MEDIDOR" "$REPO_REAL"

# ── AC 10, 11, 12 · el tablero: ficha medida, ficha con trama, y el gráfico intacto ──
corre "AC 10/11/12 · la ficha del tablero y el gráfico mensual" --acs 10,11,12 -- \
  bash -c "
set -e
D='$TMP/dash'; mkdir -p \"\$D\"
H=\$(python3 -c 'from datetime import datetime,timezone;print(datetime.now(timezone.utc).date())')
# snapshot SIN el campo → la ficha tiene que quedar con trama y motivo (AC 11)
python3 - <<'PY'
import json,glob,os,datetime
d=json.load(open('$TMP/real.json'))
h=datetime.datetime.now(datetime.timezone.utc)
d['generated_at']=h.isoformat().replace('+00:00','Z')
sin=json.loads(json.dumps(d)); sin['global']['tiempo_por_etapa']=None
os.makedirs('$TMP/dash',exist_ok=True)
json.dump(sin,open(f'$TMP/dash/sdlc-stage-{h.date()}.json','w'))
json.dump(d,open('$TMP/con.json','w'))
PY
for f in controls-bench dependencias vigilante; do mkdir -p \"\$D/\$f\"; done
TS=\$(python3 -c 'from datetime import datetime,timezone;print(datetime.now(timezone.utc).isoformat().replace(\"+00:00\",\"Z\"))')
echo \"{\\\"ts\\\":\\\"\$TS\\\",\\\"ran\\\":1,\\\"failed\\\":0,\\\"skipped\\\":0,\\\"nomedido\\\":0,\\\"parityBreaks\\\":0,\\\"baselineRegressions\\\":0}\" > \"\$D/controls-bench/banco-\$H.json\"
echo \"{\\\"ts\\\":\\\"\$TS\\\",\\\"corridas\\\":1,\\\"failures\\\":[]}\" > \"\$D/controls-bench/suites-\$H.json\"
echo \"{\\\"fecha\\\":\\\"\$TS\\\",\\\"corrida_completa\\\":true,\\\"repos_activos\\\":1,\\\"no_medidos\\\":[],\\\"hallazgos\\\":[]}\" > \"\$D/dependencias/dependencias-\$H.json\"
echo \"{\\\"generado\\\":\\\"\$TS\\\",\\\"productos\\\":{\\\"p\\\":{\\\"ok\\\":true}},\\\"hallazgos\\\":[],\\\"nuevos\\\":0,\\\"repetidos\\\":0}\" > \"\$D/vigilante/vigilante-\$H.json\"
node '$TABLERO' --dir \"\$D\" --output '$TMP/sin.html' >/dev/null 2>&1 || true
cp '$TMP/con.json' \"\$D/sdlc-stage-\$H.json\"
node '$TABLERO' --dir \"\$D\" --output '$TMP/con.html' >/dev/null 2>&1 || true
python3 - <<'PY'
import hashlib,sys
def ficha(p):
    h=open(p,encoding='utf8').read()
    for f in h.split('<div class=\"tile ')[1:]:
        if 'Tiempo por etapa' in f[:1200]: return f[:1200]
    return ''
def svg(p):
    h=open(p,encoding='utf8').read(); i=h.find('<svg'); j=h.find('</svg>',i)
    return hashlib.sha256(h[i:j].encode()).hexdigest()[:16] if i>=0 else ''
con, sin = ficha('$TMP/con.html'), ficha('$TMP/sin.html')
assert con and sin, 'no encontré la ficha en alguna de las dos páginas'
assert 'no medido' not in con, 'AC 10: con el dato, la ficha NO puede salir con trama'
assert 'n=' in con, 'AC 10: la ficha tiene que declarar el n por etapa'
assert 'queda parado' in con, 'AC 10: falta el pie con la etapa más lenta'
assert 'no medido' in sin, 'AC 11: sin el dato, la ficha TIENE que salir con trama'
assert 'snapshot no trae' in sin, 'AC 11: y con su motivo'
assert svg('$TMP/con.html')==svg('$TMP/sin.html'), 'AC 12: el gráfico mensual cambió'
print('AC10 ficha medida · AC11 ficha con trama y motivo · AC12 gráfico idéntico')
PY"

# Los tres siguientes viven en scripts propios: el escapado de bash-dentro-de-bash-dentro-de-
# python se volvió el riesgo principal del archivo, y un smoke que falla por comillas no prueba
# nada. Cada uno sale != 0 cuando su criterio no se cumple.
AUX="$RAIZ/scripts/tests/smokes-2.1"

corre "AC 13 · el paso de medición imprime su duración" --acs 13 -- \
  bash "$AUX/ac13-step-duration.sh" "$RAIZ" "$MEDIDOR" "$REPO_REAL"

corre "AC 14 · la serie es retroactiva, no arranca el día de la corrida" --acs 14 -- \
  node "$AUX/ac14-retroactivity.js" "$MEDIDOR" "$REPO_REAL"

corre "AC 15 · las cuatro métricas, idénticas contra origin/main" --acs 15 -- \
  bash "$AUX/ac15-metrics-intact.sh" "$RAIZ" "$REPO_REAL" "$TMP/real.json"

# ── AC 16, 17 · las suites de antes siguen verdes ──
corre "AC 16/17 · la suite vieja y la del tablero, verdes" --acs 16,17 -- \
  bash -c "
set -e
node '$RAIZ/scripts/tests/sdlc-stage-metrics.test.js' > /dev/null
bash '$RAIZ/scripts/tests/dashboard.test.sh' > /dev/null
git -C '$RAIZ' diff origin/main -- scripts/tests/sdlc-stage-metrics.test.js | grep -E '^-[^-]' >/dev/null && { echo 'la suite vieja perdió líneas'; exit 1; }
echo 'suite vieja verde y sin tocar · tablero verde'
"

echo
echo "== fin de los smokes =="
[ "$FALLAS" -eq 0 ] || { echo "🛑 FALLARON $FALLAS smoke(s) — la story NO está lista"; exit 1; }
echo "los $CORRIDOS smokes salieron verdes"
