#!/usr/bin/env bash
# dashboard.test.sh — los casos del tablero del arnés (vista por pregunta, generada).
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. Un caso que no
#    sabe ponerse rojo no vale — el precedente está en el banco (un chequeo que buscaba un texto
#    que la línea de resumen imprime siempre, y pasaba con el arreglo desactivado).
#
# Sin red. Fixtures en mktemp -d. El exit code se lee ANTES de cualquier pipe.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLERO="$RAIZ/scripts/nightly/dashboard/dashboard.js"
# 🔴 HOME falso (2026-09-15, story 2.16): el anillo local de la página (gates.log, timing-history) sale de
#    ~/.claude en el disco de la máquina. Sin aislarlo, C-02 —que prohíbe «111» en la página— se puso rojo
#    el día que el registro de frenos real de esta máquina llegó a exactamente 111 guías de QA: el caso
#    medía la máquina, no el tablero. Ninguno de estos casos fabrica datos en HOME.
HOME="$(mktemp -d)"; export HOME
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

# Huella del entregable ANTES de correr nada — la lee C-27, al final del archivo.
# Se compara ANTES/DESPUÉS y NO "¿el árbol está limpio?": el dev puede tenerlo modificado a
# propósito (regenerarlo a mano es legítimo), y un caso que exija árbol limpio se apagaría el
# primer día que eso pase — con lo que se perdería también el caso que importa.
huella() { python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1" 2>/dev/null || echo AUSENTE; }
ENTREGABLE="$RAIZ/artifacts/tablero-del-arnes.html"
HUELLA_ANTES="$(huella "$ENTREGABLE")"
DECLARADOS="$RAIZ/scripts/nightly/dashboard/declared.json"
HUELLA_DECL_ANTES="$(huella "$DECLARADOS")"

hoy() { python3 -c "from datetime import datetime,timezone;print(datetime.now(timezone.utc).date())"; }
hace() { python3 -c "
from datetime import datetime,timezone,timedelta
import sys
print((datetime.now(timezone.utc)-timedelta(days=int(sys.argv[1]))).isoformat().replace('+00:00','Z'))" "$1"; }
fecha_hace() { python3 -c "
from datetime import datetime,timezone,timedelta
import sys
print((datetime.now(timezone.utc)-timedelta(days=int(sys.argv[1]))).date())" "$1"; }

# Monta un .dashboard sintético completo y al día.
montar_sano() {
  local T="$1" H; H="$(hoy)"; local TS; TS="$(hace 0)"
  mkdir -p "$T/controls-bench" "$T/dependencias" "$T/vigilante"
  cat > "$T/sdlc-stage-$H.json" <<JSON
{"generated_at":"$TS","global":{"lead_time_days":{"n":400,"mean":16.7,"median":5.2,"max":129},
"lead_time_monthly":[{"month":"2026-07","n":100,"mean":30.1,"median":18.0,"min":0,"max":77},{"month":"2026-08","n":140,"mean":17.7,"median":4.4,"min":0,"max":129}],
"first_pass_ratio":{"num":3,"den":18},"rework_ratio":{"num":100,"den":400},
"dod_evidence_ratio":{"num":80,"den":400}},"repos":[{"repo":"x/A","stories_total":50,"done_total":40,"rework_ratio":{"num":10,"den":40},"dod_evidence_ratio":{"num":0,"den":40},"not_measured":[]}]}
JSON
  cat > "$T/controls-bench/banco-$H.json" <<JSON
{"ts":"$TS","ran":700,"failed":0,"skipped":10,"nomedido":0,"parityBreaks":0,"baselineRegressions":0}
JSON
  echo "{\"ts\":\"$TS\",\"corridas\":50,\"failures\":[]}" > "$T/controls-bench/suites-$H.json"
  echo "{\"fecha\":\"$TS\",\"corrida_completa\":true,\"repos_activos\":10,\"no_medidos\":[],\"hallazgos\":[]}" > "$T/dependencias/dependencias-$H.json"
  echo "{\"generado\":\"$TS\",\"productos\":{\"p\":{\"ok\":true}},\"hallazgos\":[],\"nuevos\":0,\"repetidos\":0}" > "$T/vigilante/vigilante-$H.json"
}

# Agrega tiempo_por_etapa / sin_transiciones / estados_desconocidos al snapshot SDLC ya montado.
con_etapas() {
  python3 - "$1" <<'PY2'
import glob, json, sys
f = glob.glob(sys.argv[1] + '/sdlc-stage-*.json')[0]
d = json.load(open(f))
d['global']['tiempo_por_etapa'] = {
    'in-progress': {'n': 380, 'mean': 3.0, 'median': 2.1, 'min': 0.2, 'max': 40.0},
    'review':      {'n': 402, 'mean': 8.0, 'median': 6.4, 'min': 0.1, 'max': 91.0},
}
d['global']['sin_transiciones'] = 24
d['global']['estados_desconocidos'] = {'blocked': 5}
json.dump(d, open(f, 'w'))
PY2
}

# El fragmento HTML de la ficha cuyo título contiene <patrón>, y su clase de estado.
ficha_html() {
  python3 - "$1" "$2" <<'PY2'
import sys
html = open(sys.argv[1], encoding='utf8').read()
for frag in html.split('<div class="tile ')[1:]:
    cuerpo = frag.split('</div>\n')[0] if '</div>\n' in frag else frag[:2000]
    if sys.argv[2] in frag[:1200]:
        print(frag[:1200]); break
PY2
}
ficha_estado() {
  python3 - "$1" "$2" <<'PY2'
import sys
html = open(sys.argv[1], encoding='utf8').read()
for frag in html.split('<div class="tile ')[1:]:
    if sys.argv[2] in frag[:1200]:
        print(frag.split('"')[0].strip() or 'medido'); break
else:
    print('AUSENTE')
PY2
}
# Huella del bloque del gráfico mensual (el primer <svg> de la página).
svg_grafico() {
  python3 - "$1" <<'PY2'
import hashlib, sys
h = open(sys.argv[1], encoding='utf8').read()
i = h.find('<svg')
j = h.find('</svg>', i)
print(hashlib.sha256(h[i:j].encode()).hexdigest()[:16] if i >= 0 and j > i else '')
PY2
}

echo "== dashboard.test.sh =="

# ── C-01 · una fuente esperada que NO está no es "cero": es exit 2, ficha con trama y banda ──
# 🔴 rojo previo: recorrer el directorio con readdir en vez de la lista de fuentes esperadas.
T=$(mktemp -d); montar_sano "$T"; rm -rf "$T/dependencias"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && ok "C-01 fuente ausente → exit 2 (fue $RC)" || mal "C-01 esperaba exit 2, fue $RC"
grep -q 'class="tile blind"' "$T/o.html" && ok "C-01 hay fichas con trama (no medido)" || mal "C-01 no hay ninguna ficha con trama"
grep -q 'MEDICIÓN INCOMPLETA' "$T/o.html" && ok "C-01 el tablero se declara incompleto" || mal "C-01 falta la banda de medición incompleta"
rm -rf "$T"

# ── C-02 · un dato viejo se pinta con trama y SE LE CALLAN los números ──
# 🔴 rojo previo: subir max_edad_dias, o dibujar el valor tachado en vez de borrarlo.
T=$(mktemp -d); montar_sano "$T"
rm -f "$T"/sdlc-stage-*.json
TS9="$(hace 9)"; F9="$(fecha_hace 9)"
cat > "$T/sdlc-stage-$F9.json" <<JSON
{"generated_at":"$TS9","global":{"lead_time_days":{"n":777,"mean":16.7,"median":5.2,"max":129},
"lead_time_monthly":[{"month":"2026-08","n":777,"mean":33.3,"median":22.2,"min":0,"max":9}],
"first_pass_ratio":{"num":3,"den":18},"rework_ratio":{"num":111,"den":777},
"dod_evidence_ratio":{"num":222,"den":777}},"repos":[{"repo":"x/A","stories_total":777,"done_total":700,"not_measured":[]}]}
JSON
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
if grep -q "777\|222\|111\|22,2\|33,3" "$T/o.html"; then mal "C-02 la página dibujó números de un dato de 9 días"; else ok "C-02 los números viejos NO se dibujan"; fi
grep -q "hace 9 días" "$T/o.html" && ok "C-02 muestra la EDAD, no la fecha" || mal "C-02 no muestra la edad del dato"
rm -rf "$T"

# ── C-03 · un archivo ilegible NO se lee como "sin hallazgos" ──
# 🔴 rojo previo: envolver el JSON.parse en un catch que devuelva {} en vez de conservar el error.
T=$(mktemp -d); montar_sano "$T"; echo "{roto" > "$T/vigilante/vigilante-$(hoy).json"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && ok "C-03 archivo ilegible → exit 2 (fue $RC)" || mal "C-03 esperaba exit 2, fue $RC"
grep -q "ilegible" "$T/o.html" && ok "C-03 el motivo real viaja hasta la página" || mal "C-03 el motivo del error no llegó a la página"
rm -rf "$T"

# ── C-04 · exit 0 con rojos adentro; distinto de 0 SÓLO si no pudo medir ──
# 🔴 rojo previo: hacer que el exit dependa de la cantidad de rojos (invierte el contrato de la casa).
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,os,glob
T=sys.argv[1]
f=glob.glob(os.path.join(T,'controls-bench','banco-*.json'))[0]
d=json.load(open(f)); d['failed']=12; d['baselineRegressions']=3; json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && ok "C-04 12 rojos medidos → exit 0 (fue $RC)" || mal "C-04 esperaba exit 0 con rojos, fue $RC"
grep -q '<div class="t-val">12</div>' "$T/o.html" && ok "C-04 el rojo se cobra en el tablero" || mal "C-04 el 12 no aparece en la página"
grep -q 'chip bad"><span class="g">▲</span>rojo' "$T/o.html" && ok "C-04 el estado rojo lleva glifo Y palabra" || mal "C-04 el estado rojo no lleva glifo+palabra"
rm -rf "$T"

# ── C-05 · un ratio con numerador mayor que el denominador es error, no un dato ──
# 🔴 rojo previo: quitar el aserto num <= den de ratio().
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,glob,os
T=sys.argv[1]; f=glob.glob(os.path.join(T,'sdlc-stage-*.json'))[0]
d=json.load(open(f)); d['global']['dod_evidence_ratio']={"num":13,"den":8}; json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
if grep -q "162%\|163%" "$T/o.html"; then mal "C-05 dibujó un ratio mayor a 100%"; else ok "C-05 el ratio inválido no se dibuja"; fi
grep -q "universos distintos" "$T/o.html" && ok "C-05 dice por qué no lo dibuja" || mal "C-05 falta el motivo del ratio inválido"
rm -rf "$T"

# ── C-06 · denominador cero → trama, jamás 0% ──
# 🔴 rojo previo: `value: den ? num/den : 0`.
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,glob,os
T=sys.argv[1]; f=glob.glob(os.path.join(T,'sdlc-stage-*.json'))[0]
d=json.load(open(f)); d['global']['rework_ratio']={"num":0,"den":0}; json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
grep -q "denominador vacío" "$T/o.html" && ok "C-06 denominador 0 → trama con motivo" || mal "C-06 no declaró el denominador vacío"
rm -rf "$T"

# ── C-07 · ninguna ficha medida sin su denominador al lado ──
# 🔴 rojo previo: sacar el <div class="t-den"> del template de la ficha medida.
T=$(mktemp -d); montar_sano "$T"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
read -r SIN CON <<<"$(python3 - "$T/o.html" <<'PY'
import re,sys
h=open(sys.argv[1],encoding='utf8').read()
# cada ficha empieza en <div class="tile ..."> y su denominador es el primer t-den que le sigue
partes=re.split(r'(?=<div class="tile )', h)[1:]
sin=con=0
for f in partes:
    if f.startswith('<div class="tile blind"'): continue
    m=re.search(r'<div class="t-den">(.*?)</div>', f, re.S)
    if not m or ('n=' not in m.group(1) and ' de ' not in m.group(1)): sin+=1
    else: con+=1
print(sin, con)
PY
)"
[ "$SIN" = "0" ] && ok "C-07 las $CON fichas medidas traen denominador" || mal "C-07 hay $SIN ficha(s) con un número suelto"
rm -rf "$T"

# ── C-08 · la cobertura se mide contra lo ESPERADO, no contra lo encontrado ──
# 🔴 rojo previo: usar `encontradas` como denominador de la cobertura.
T=$(mktemp -d); montar_sano "$T"; rm -rf "$T/vigilante"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
COB=$(grep -o "al día [0-9]*" "$T/o.html" | head -1 | grep -o "[0-9]*$")
ESP=$(grep -o "Fuentes esperadas:</b> [0-9]*" "$T/o.html" | grep -o "[0-9]*$")
if [ -z "$COB" ] || [ -z "$ESP" ] || [ "$COB" = "$ESP" ]; then
  mal "C-08 la cobertura no se mide contra lo esperado (esperadas '$ESP', al día '$COB')"
else ok "C-08 la cobertura se mide contra lo esperado ($COB al día de $ESP esperadas)"; fi
rm -rf "$T"

# ── C-11 · el anillo local no filtra rutas, comandos ni nombres de persona ──
# 🔴 rojo previo: emitir `d.repoPath` o `d.cmd` de gates.log en el detalle de alguna ficha, o el
#    nombre del autor principal en el bus factor. NO es una promesa: es la prueba.
#    🔴 La salida va a un TEMPORAL, no al entregable commiteado (2026-09-06). Antes se generaba
#    sobre `artifacts/tablero-del-arnes.html`: la suite salía 0 y dejaba el archivo que abre una
#    persona reescrito con los datos de esta máquina, sin decir nada. Lo que el caso ejercita es el
#    anillo LOCAL —por eso NO lleva `--dir`, y eso no cambia—: el dato sigue siendo el real, sólo
#    cambia dónde se escribe. El guardián de la familia es C-27, al final del archivo.
T=$(mktemp -d)
node "$TABLERO" --output "$T/local.html" >/dev/null 2>&1
FUGA=0
for PAT in "/Users/" "SourceCode" "\\.cs\\b" "\\.tsx\\b" "git commit" "npm test" "dotnet test" "ApellidoA" "Usuariob" "usuario-c" "OtroApellido"; do
  if grep -qE "$PAT" "$T/local.html"; then
    mal "C-11 la página contiene '$PAT' — el anillo local está filtrando"; FUGA=1
  fi
done
[ "$FUGA" -eq 0 ] && ok "C-11 ni rutas, ni comandos, ni nombres de persona en la página"
rm -rf "$T"

# ── C-12 · un dato DECLARADO vencido no se dibuja como medido ──
# 🔴 rojo previo: quitar la comparación con `revisar_antes_de` en extra().
T=$(mktemp -d); montar_sano "$T"
D="$RAIZ/scripts/nightly/dashboard/declared.json"; cp "$D" "$T/declarados.bak"
# 🔴 El archivo commiteado se MUTA a propósito (dashboard.js lo lee de una ruta fija, no hay flag) y
# el `cp` de abajo lo devuelve. El `trap` cubre el caso en que la suite muera en el medio —una
# señal, un Ctrl-C—: sin él quedaba un JSON commiteable con todas las declaraciones vencidas
# (2026-09-06). C-28, al final del archivo, vigila que se haya devuelto.
trap 'cp "$T/declarados.bak" "$D" 2>/dev/null' EXIT INT TERM
python3 - "$D" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for x in d['declared']: x['review_before']='2000-01-01'
json.dump(d,open(p,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
cp "$T/declarados.bak" "$D"
trap - EXIT INT TERM
grep -q "declaración vencida" "$T/o.html" && ok "C-12 una declaración vencida sale como no medida, con el motivo" || mal "C-12 la declaración vencida se dibujó como medida"
if grep -q 'class="tile decl"' "$T/o.html"; then mal "C-12 quedó una ficha declarada dibujada con la declaración vencida"; else ok "C-12 no queda ninguna ficha declarada dibujada"; fi
rm -rf "$T"

# ── C-09 · el módulo no ejecuta al requerirse ──
# 🔴 rojo previo: quitar el guard `require.main === module`.
node -e "require('$TABLERO')" >/dev/null 2>&1 && ok "C-09 requerirlo no dispara una corrida" || mal "C-09 el módulo corre al requerirse"

# ── C-10 · sin silenciadores en el colector ──
# 🔴 rojo previo: agregar un `?? 0` o un `2>/dev/null` a cualquier línea.
N=$(grep -nE '2>/dev/null|\|\| true|\?\? 0|\|\| 0|catch\s*\{\s*\}' "$TABLERO" | wc -l | tr -d ' ')
[ "$N" = "0" ] && ok "C-10 cero silenciadores" || { mal "C-10 hay $N silenciador(es)"; grep -nE '2>/dev/null|\|\| true|\?\? 0|\|\| 0|catch\s*\{\s*\}' "$TABLERO"; }

# ── C-13 · ningún número escrito a mano en el texto visible del template ──
# 🔴 rojo previo: escribir "496" o "11 de 11" en el HTML del render.
# Se mira el TEMPLATE (el código), no la salida: un literal numérico en el texto visible envejece
# en silencio. Se toleran los pocos que son parte de la regla y no del dato (el umbral del 75 %, el
# ΔE medido de la paleta, el "0 de 4" de DORA que es la definición del hueco).
M=$(python3 - "$TABLERO" <<'PY'
import re,sys
s=open(sys.argv[1],encoding='utf8').read()
i=s.index('function render(d)'); j=s.index('// ───────────────────────────── main')
r=s[i:j]
vis=re.findall(r'>([^<{}]*?)<', r)
# una RUTA (tasks/…-2026-09-05.md, scripts/…) es una referencia, no un número que envejece
esRuta=lambda t: bool(re.search(r'[\w-]+/[\w./-]+|\.(md|js|json)\b', t))
hits=[t.strip() for t in vis if re.search(r'\b\d{2,}\b', t) and not re.search(r'ΔE|75 ?%|0 de 4|DORA', t) and not esRuta(t)]
print(len(hits)); [print('   ', h[:90]) for h in hits[:6]]
PY
)
echo "$M" | head -1 | grep "^0$" >/dev/null && ok "C-13 el template no tiene números visibles escritos a mano" || { mal "C-13 hay números tipeados en el template:"; echo "$M" | tail -n +2; }

# ── C-14 · la ficha «Tiempo por etapa» deja la trama cuando el snapshot trae el dato (T10) ──
# 🔴 rojo previo: no conectar el adaptador → la ficha sigue con trama fija aunque el dato esté.
T=$(mktemp -d); montar_sano "$T"; con_etapas "$T"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
EST=$(ficha_estado "$T/o.html" "Tiempo por etapa")
[ "$EST" != "blind" ] && [ "$EST" != "AUSENTE" ] && ok "C-14 la ficha ya no tiene trama (estado '$EST')" || mal "C-14 la ficha sigue con trama o no está (estado '$EST')"
FIC=$(ficha_html "$T/o.html" "Tiempo por etapa")
echo "$FIC" | grep 'no medido' >/dev/null && mal "C-14 la ficha se sigue declarando no medida" || ok "C-14 la ficha no se declara no medida"
echo "$FIC" | grep 'n=' >/dev/null && ok "C-14 la ficha declara el n por etapa" || mal "C-14 la ficha no trae ningún n="
echo "$FIC" | grep 'in-progress' >/dev/null && echo "$FIC" | grep 'review' >/dev/null && ok "C-14 nombra las etapas medidas" || mal "C-14 no nombra las etapas"
echo "$FIC" | grep 'queda parado' >/dev/null && ok "C-14 nombra en el pie dónde se queda parado el trabajo" || mal "C-14 falta el pie de la etapa más lenta"
echo "$FIC" | grep '6,4' >/dev/null && ok "C-14 muestra la mediana de la etapa más lenta" || mal "C-14 no muestra la mediana más alta (6,4)"
rm -rf "$T"

# ── C-15 · sin el dato, la ficha sigue con trama y motivo — nunca un cero (T11) ──
# 🔴 rojo previo: default `{}` en el adaptador → dibuja etapas vacías con 0.
T=$(mktemp -d); montar_sano "$T"     # montar_sano NO trae tiempo_por_etapa a propósito
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
EST=$(ficha_estado "$T/o.html" "Tiempo por etapa")
[ "$EST" = "blind" ] && ok "C-15 sin el dato la ficha tiene trama" || mal "C-15 esperaba trama y fue '$EST'"
FIC=$(ficha_html "$T/o.html" "Tiempo por etapa")
echo "$FIC" | grep 'no medido' >/dev/null && ok "C-15 se declara no medida" || mal "C-15 no se declara no medida"
echo "$FIC" | grep -E '<div class="t-val">0[,.<]' >/dev/null && mal "C-15 dibujó un 0 donde no hay dato" || ok "C-15 no dibuja ningún 0"
echo "$FIC" | grep 'snapshot no trae' >/dev/null && ok "C-15 dice POR QUÉ no está medida" || mal "C-15 la ficha no trae motivo"
rm -rf "$T"

# ── C-16 · el gráfico mensual NO cambia por agregar el tiempo por etapa (T15 · AC 12) ──
# 🔴 rojo previo: rediseñar el gráfico al conectar la ficha → los dos bloques difieren.
T=$(mktemp -d); montar_sano "$T"
node "$TABLERO" --dir "$T" --output "$T/sin.html" >/dev/null 2>&1
con_etapas "$T"
node "$TABLERO" --dir "$T" --output "$T/con.html" >/dev/null 2>&1
H1=$(svg_grafico "$T/sin.html"); H2=$(svg_grafico "$T/con.html")
[ -n "$H1" ] && [ "$H1" = "$H2" ] && ok "C-16 el gráfico mensual sale idéntico con y sin el campo nuevo" \
  || mal "C-16 el gráfico mensual cambió ($H1 vs $H2)"
rm -rf "$T"

# ═════════════════════════════════════════════════════════════════════════════════════════════
# Story 2.2 — «449 abiertas» pasa a ser tres números con denominador.
# ═════════════════════════════════════════════════════════════════════════════════════════════

# Agrega `estados_por_canonico` al snapshot SDLC ya montado (global y repo).
# $2 (opcional) = JSON con las claves a pisar dentro del campo.
con_estados() {
  # Sin `${2:-{\}}`: la llave escapada adentro de la expansión llega con la barra invertida y
  # revienta el JSON — y el error se veía como «el tablero no dibujó la ficha», o sea acusando al
  # código cuando el roto era el fixture.
  local extra="${2:-}"
  [ -n "$extra" ] || extra='{}'
  python3 - "$1" "$extra" <<'PY2'
import glob, json, sys
f = glob.glob(sys.argv[1] + '/sdlc-stage-*.json')[0]
d = json.load(open(f))
base = {
    'conteo': {'done': 40, 'review': 6, 'in-progress': 3, 'ready-for-dev': 1},
    'sin_diccionario': {'raro': 2},
    'sin_status': 0,
    'total': 52,
    'por_grupo': {'cerrado': 40, 'en_curso': 9, 'backlog': 1},
}
base.update(json.loads(sys.argv[2]))
d['global']['estados_por_canonico'] = base
for r in d['repos']:
    r['estados_por_canonico'] = base
json.dump(d, open(f, 'w'))
PY2
}

# ── C-17 · la ficha se parte en TRES números con denominador y cobertura (T10 · AC 10) ──
# 🔴 rojo previo: no conectar el adaptador → sigue la resta vieja «Stories abiertas en toda la
#    historia medida», que mezcla lo que alguien está desarrollando ahora con lo archivado en mayo.
T=$(mktemp -d); montar_sano "$T"; con_estados "$T"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
for PAT in 'Trabajo en curso' 'En el backlog' 'no reconoce'; do
  grep -q "$PAT" "$T/o.html" && ok "C-17 está la ficha «${PAT}»" || mal "C-17 falta la ficha «${PAT}»"
done
grep -q 'Hoy no hay forma de distinguir' "$T/o.html" && mal "C-17 sigue el pie que admitía el problema" || ok "C-17 el pie viejo ya no está"
grep -q 'Stories abiertas en toda la historia medida' "$T/o.html" && mal "C-17 sigue la resta vieja" || ok "C-17 la resta vieja se fue"
FIC=$(ficha_html "$T/o.html" 'Trabajo en curso')
echo "$FIC" | grep -E 'de 52 stories' >/dev/null && ok "C-17 «en curso» trae su denominador (52 stories)" || mal "C-17 «en curso» sin denominador: $FIC"
echo "$FIC" | grep -E '1 de 1 repos' >/dev/null && ok "C-17 y la cobertura de repos" || mal "C-17 falta la cobertura de repos"
# 🔴 el desglose: sin él la ficha esconde que la mayoría no está en desarrollo sino en revisión
echo "$FIC" | grep 'en revisión' >/dev/null && ok "C-17 «en curso» se desglosa por canónico en el pie" || mal "C-17 falta el desglose por canónico"
rm -rf "$T"

# ── C-18 · sin el campo, las tres fichas van con trama y motivo — jamás tres ceros (T11 · AC 11) ──
# 🔴 rojo previo: default `{}` en el adaptador → dibuja tres ceros, y «0 en curso» se lee como
#    «no hay nada en vuelo», que es la mentira más cara que este tablero puede contar.
T=$(mktemp -d); montar_sano "$T"     # snapshot SIN estados_por_canonico (un nocturno anterior)
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
for PAT in 'Trabajo en curso' 'En el backlog' 'no reconoce'; do
  EST=$(ficha_estado "$T/o.html" "$PAT")
  [ "$EST" = "blind" ] && ok "C-18 «${PAT}» va con trama (fue «${EST}»)" || mal "C-18 «${PAT}» esperaba trama y fue «${EST}»"
  FIC=$(ficha_html "$T/o.html" "$PAT")
  echo "$FIC" | grep -E '<div class="t-val">0[,.<]' >/dev/null && mal "C-18 «${PAT}» dibujó un 0" || ok "C-18 «${PAT}» no dibuja ningún 0"
  echo "$FIC" | grep 'snapshot no trae' >/dev/null && ok "C-18 «${PAT}» dice por qué" || mal "C-18 «${PAT}» sin motivo"
done
rm -rf "$T"

# ── C-19 · los desconocidos se NOMBRAN en el pie, no sólo se cuentan (T12 · AC 12) ──
# 🔴 rojo previo: mostrar sólo el número → se pierde la lista de trabajo del próximo diccionario,
#    que es exactamente cómo un diccionario se queda viejo.
T=$(mktemp -d); montar_sano "$T"
# 🔴 Los cuatro con cuentas DISTINTAS a propósito. La primera versión de este fixture empataba
#    `tercero` y `cuarto` en 1, y el caso pasaba por el ORDEN DE LLEGADA de las claves — o sea que
#    verificaba el defecto en vez de la conducta (lo destapó el pase adversarial del 2026-09-05, al
#    agregarse el desempate por nombre). El empate tiene ahora su caso propio: el C-22.
con_estados "$T" '{"sin_diccionario": {"raro": 4, "otro": 3, "tercero": 2, "cuarto": 1}, "total": 60, "por_grupo": {"cerrado": 40, "en_curso": 9, "backlog": 1}}'
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
FIC=$(ficha_html "$T/o.html" 'no reconoce')
for N in raro otro tercero; do
  echo "$FIC" | grep "$N" >/dev/null && ok "C-19 el pie nombra «${N}»" || mal "C-19 el pie no nombra «${N}»"
done
echo "$FIC" | grep -E '<div class="t-val">10<' >/dev/null && ok "C-19 y la cuenta total es 10 (4+3+2+1)" || mal "C-19 la cuenta total no es 10: $FIC"
rm -rf "$T"

# ── C-20 · «en curso» sale del snapshot, no de una lista adentro del tablero (T5 · AC 5) ──
# 🔴 rojo previo: hardcodear ['in-progress','review'] en dashboard.js y sumar desde `conteo` → los
#    dos snapshots dan el MISMO número y el tablero contradice al diccionario que el medidor usó.
#    Los dos fixtures tienen el mismo `conteo` y distinto `por_grupo` a propósito: es la única
#    forma de que la mutación se note. Que el MEDIDOR aplique el diccionario lo cubre T18.
T=$(mktemp -d); montar_sano "$T"
con_estados "$T" '{"por_grupo": {"cerrado": 40, "en_curso": 9, "backlog": 1}}'
node "$TABLERO" --dir "$T" --output "$T/a.html" >/dev/null 2>&1
con_estados "$T" '{"por_grupo": {"cerrado": 40, "en_curso": 3, "backlog": 7}}'
node "$TABLERO" --dir "$T" --output "$T/b.html" >/dev/null 2>&1
VA=$(ficha_html "$T/a.html" 'Trabajo en curso' | grep -oE '<div class="t-val">[0-9]+' | head -1 | grep -oE '[0-9]+')
VB=$(ficha_html "$T/b.html" 'Trabajo en curso' | grep -oE '<div class="t-val">[0-9]+' | head -1 | grep -oE '[0-9]+')
[ "$VA" = "9" ] && [ "$VB" = "3" ] && ok "C-20 el número sigue a por_grupo del snapshot ($VA → $VB)" \
  || mal "C-20 esperaba 9 y luego 3, salió «${VA}» y «${VB}»"
rm -rf "$T"

# ── C-21 · el gráfico mensual NO cambia por agregar las tres fichas (T14 · AC 16) ──
# 🔴 rojo previo: rediseñar la sección de la pregunta 1 al partir la ficha → los bloques difieren.
T=$(mktemp -d); montar_sano "$T"
node "$TABLERO" --dir "$T" --output "$T/sin.html" >/dev/null 2>&1
con_estados "$T"
node "$TABLERO" --dir "$T" --output "$T/con.html" >/dev/null 2>&1
H1=$(svg_grafico "$T/sin.html"); H2=$(svg_grafico "$T/con.html")
[ -n "$H1" ] && [ "$H1" = "$H2" ] && ok "C-21 el gráfico mensual sale idéntico con y sin el campo nuevo" \
  || mal "C-21 el gráfico mensual cambió ($H1 vs $H2)"
rm -rf "$T"

# ── C-22 · con empate, la lista NO depende del orden en que se escanearon los repos (AC 12) ──
# 🔴 rojo previo: ordenar sólo por valor (`sort((a,b) => b[1]-a[1])`) → el desempate lo decide el
#    orden de inserción de las claves, que viene de cómo el medidor recorrió los repos. Medido por
#    el pase adversarial: con cuatro estados empatados en 1, invertir el orden de escaneo cambia la
#    lista ENTERA de la ficha sin que haya cambiado un dato. Y en el nocturno los clones se rehacen
#    cada noche, así que ese orden puede cambiar solo.
T=$(mktemp -d); montar_sano "$T"
con_estados "$T" '{"sin_diccionario": {"delta": 1, "alfa": 1, "charlie": 1, "bravo": 1}, "total": 60, "por_grupo": {"cerrado": 40, "en_curso": 9, "backlog": 1}}'
node "$TABLERO" --dir "$T" --output "$T/a.html" >/dev/null 2>&1
con_estados "$T" '{"sin_diccionario": {"charlie": 1, "bravo": 1, "delta": 1, "alfa": 1}, "total": 60, "por_grupo": {"cerrado": 40, "en_curso": 9, "backlog": 1}}'
node "$TABLERO" --dir "$T" --output "$T/b.html" >/dev/null 2>&1
PA=$(ficha_html "$T/a.html" 'no reconoce' | grep -oE 't-foot">[^<]*' | head -1)
PB=$(ficha_html "$T/b.html" 'no reconoce' | grep -oE 't-foot">[^<]*' | head -1)
[ -n "$PA" ] && [ "$PA" = "$PB" ] && ok "C-22 con empate la lista es la misma sin importar el orden" \
  || mal "C-22 la lista cambio con el orden de las claves: «${PA}» vs «${PB}»"
echo "$PA" | grep "alfa" >/dev/null && ok "C-22 y desempata por nombre (alfa entra primero)" || mal "C-22 no desempata por nombre: $PA"
rm -rf "$T"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# Story 2.3 · la causa del reproceso — la ficha «Por qué volvió» deja la trama y dibuja 5 barras
# ═══════════════════════════════════════════════════════════════════════════════════════════

# Agrega `rework_por_causa` (global y por repo) al snapshot SDLC ya montado. $2 = JSON que pisa el base.
con_causas() {
  local extra="${2:-}"
  [ -n "$extra" ] || extra='{}'
  python3 - "$1" "$extra" <<'PY2'
import glob, json, sys
f = glob.glob(sys.argv[1] + '/sdlc-stage-*.json')[0]
d = json.load(open(f))
base = {
    'conteo': {'defecto-propio': 4, 'cambio-de-requisito': 2, 'deuda-declarada': 1, 'descubrimiento': 0},
    'sin_declarar': 9,
    'fuera_de_vocabulario': {},
    'sin_declarar_por_type': {'extension': 5, 'fix': 3, 'sin_type': 1},
    'total': 16,
}
base.update(json.loads(sys.argv[2]))
d['global']['rework_por_causa'] = base
for r in d['repos']:
    r['rework_por_causa'] = base
json.dump(d, open(f, 'w'))
PY2
}
# La ficha ENTERA (no los primeros 1200 chars): las cinco barras más el pie superan ese corte.
tile_completo() {
  python3 - "$1" "$2" <<'PY2'
import sys
html = open(sys.argv[1], encoding='utf8').read()
for frag in html.split('<div class="tile ')[1:]:
    if sys.argv[2] in frag[:1200]:
        print(frag); break
PY2
}

# ── C-23 · cinco barras con nombre, cuenta y denominador; «sin declarar» lleva la palabra (T10 · AC 8) ──
# 🔴 rojo previo: no conectar el adaptador → la ficha sigue con trama y el motivo viejo («no se
#    registra la causa de ningún seguimiento»); sembrar el desglose por type en las barras → salen
#    más de cinco, o «Sin declarar» baja de 9.
T=$(mktemp -d); montar_sano "$T"; con_causas "$T"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
EST=$(ficha_estado "$T/o.html" 'Por qué volvió')
[ "$EST" != "blind" ] && [ "$EST" != "AUSENTE" ] && ok "C-23 la ficha «Por qué volvió» dejó la trama (estado «${EST}»)" || mal "C-23 la ficha sigue con trama o no está: «${EST}»"
FIC=$(tile_completo "$T/o.html" 'Por qué volvió')
for PAT in 'Defecto propio' 'Cambio de requisito' 'Deuda declarada' 'Descubrimiento' 'Sin declarar'; do
  echo "$FIC" | grep "$PAT" >/dev/null && ok "C-23 está la barra «${PAT}»" || mal "C-23 falta la barra «${PAT}»"
done
N=$(echo "$FIC" | grep -o 'class="causa-barra' | wc -l | tr -d ' ')
[ "$N" -eq 5 ] && ok "C-23 son exactamente CINCO barras" || mal "C-23 esperaba 5 barras y hay $N"
# La cuenta viaja en el `<span class="cv">` de la fila, no pegada al nombre: entre los dos está la
# barra, que lleva su propio ancho en %. Se asserta la FILA entera de «sin declarar».
echo "$FIC" | python3 -c "
import re,sys
h=sys.stdin.read()
m=re.search(r'<div class=\"causa-barra sd\">.*?</div>\s*</div>', h, re.S)
print('OK' if m and re.search(r'Sin declarar', m.group(0)) and re.search(r'class=\"cv\">9<', m.group(0)) else 'NO')
" | grep OK >/dev/null && ok "C-23 «Sin declarar» trae su cuenta (9) en su propia fila" || mal "C-23 «Sin declarar» sin su cuenta"
echo "$FIC" | grep 'sobre 16 seguimientos' >/dev/null && ok "C-23 el denominador es el total de seguimientos (16)" || mal "C-23 falta el denominador"
echo "$FIC" | grep '1 de 1 repos' >/dev/null && ok "C-23 y la cobertura de repos" || mal "C-23 falta la cobertura de repos"
echo "$FIC" | grep 'cambio-de-requisito subiendo mientras defecto-propio baja' >/dev/null && ok "C-23 el pie escribe la alarma" || mal "C-23 el pie no dice qué mirar"
echo "$FIC" | grep 'derivado del' >/dev/null && echo "$FIC" | grep 'no declarado' >/dev/null && ok "C-23 el desglose por type se rotula derivado, no declarado" || mal "C-23 el desglose no dice que es derivado"
echo "$FIC" | grep 'extension' >/dev/null && ok "C-23 …y nombra el type dominante de las sin declarar" || mal "C-23 el desglose no nombra los type"
echo "$FIC" | grep 'no se registra la causa de ningún seguimiento' >/dev/null && mal "C-23 sigue el motivo viejo de la trama" || ok "C-23 el motivo viejo ya no está"
rm -rf "$T"

# ── C-24 · un valor fuera del vocabulario se NOMBRA en el pie, con su cuenta (T11 · AC 8) ──
# 🔴 rojo previo: esconderlo (o mandarlo a «sin declarar») → la lista de trabajo se pierde y el
#    vocabulario deja de ser cerrado sin que nadie lo vea.
T=$(mktemp -d); montar_sano "$T"; con_causas "$T" '{"fuera_de_vocabulario": {"otra-cosa": 2}, "total": 18}'
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
FIC=$(tile_completo "$T/o.html" 'Por qué volvió')
echo "$FIC" | grep 'otra-cosa (2)' >/dev/null && ok "C-24 el pie nombra «otra-cosa (2)»" || mal "C-24 el fuera de vocabulario no se nombra"
N=$(echo "$FIC" | grep -o 'class="causa-barra' | wc -l | tr -d ' ')
[ "$N" -eq 5 ] && ok "C-24 y siguen siendo cinco barras (no se le dibuja una sexta)" || mal "C-24 el fuera de vocabulario cambió el número de barras: $N"
rm -rf "$T"

# ── C-25 · sin el campo, trama y motivo — jamás cinco ceros (T12 · AC 9) ──
# 🔴 rojo previo: default `{}` en el adaptador → cinco barras en cero, que se leen como «no hubo
#    reproceso» — la mentira más cara que puede contar esta ficha.
T=$(mktemp -d); montar_sano "$T"     # snapshot SIN rework_por_causa (un nocturno anterior a la 2.3)
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
EST=$(ficha_estado "$T/o.html" 'Por qué volvió')
[ "$EST" = "blind" ] && ok "C-25 sin el campo la ficha va con trama" || mal "C-25 esperaba trama y fue «${EST}»"
FIC=$(tile_completo "$T/o.html" 'Por qué volvió')
echo "$FIC" | grep -E '<div class="t-val">0[,.<]' >/dev/null && mal "C-25 dibujó un 0" || ok "C-25 no dibuja ningún 0"
echo "$FIC" | grep 'class="causa-barra' >/dev/null && mal "C-25 dibujó barras sin dato" || ok "C-25 no dibuja barras sin dato"
echo "$FIC" | grep 'snapshot no trae' >/dev/null && ok "C-25 dice por qué (el snapshot no trae el campo)" || mal "C-25 sin motivo"
rm -rf "$T"

# ── C-26 · el gráfico mensual y la ficha «lo que vuelve» no cambian por la ficha nueva (T14 · AC 10) ──
# 🔴 rojo previo: rediseñar la sección al agregar las barras → los bloques difieren.
T=$(mktemp -d); montar_sano "$T"
node "$TABLERO" --dir "$T" --output "$T/a.html" >/dev/null 2>&1
con_causas "$T"
node "$TABLERO" --dir "$T" --output "$T/b.html" >/dev/null 2>&1
HA=$(svg_grafico "$T/a.html"); HB=$(svg_grafico "$T/b.html")
[ -n "$HA" ] && [ "$HA" = "$HB" ] && ok "C-26 el gráfico mensual sale idéntico con y sin el campo" || mal "C-26 el gráfico cambió: $HA vs $HB"
RA=$(ficha_html "$T/a.html" 'Lo que vuelve'); RB=$(ficha_html "$T/b.html" 'Lo que vuelve')
[ -n "$RA" ] && [ "$RA" = "$RB" ] && ok "C-26 la ficha «lo que vuelve» (rework) no se toca" || mal "C-26 la ficha «lo que vuelve» cambió"
rm -rf "$T"

# ═══════════ story 2.5 — frenos y escapes de TODAS las máquinas, contados desde los registros del buzón ═══════════
REDUCTOR="$RAIZ/scripts/nightly/dashboard/reducer.js"
alias_de() { node "$REDUCTOR" --alias-of "$1"; }
# reg_gates <archivo> <fecha> <control> <total> <bloqueados> — agrega evaluaciones de un control
reg_gates() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, control, total, bloq = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
with open(f, 'a') as o:
    for i in range(total):
        o.write(json.dumps({"ts": f"{fecha}T10:{i % 60:02d}:00Z", "name": control, "status": "blocked" if i < bloq else "green", "cmd": "npm test"}) + "\n")
PY2
}
# reg_bypass <archivo> <fecha> <tipo> <n>
reg_bypass() { local k=0; while [ "$k" -lt "$4" ]; do echo "{\"ts\":\"$2T11:00:00Z\",\"type\":\"$3\",\"command\":\"npm test\"}" >> "$1"; k=$((k+1)); done; }
# maq_buzon <buzon> <nombre> <fecha de subida> <carpeta con gates.log y bypass.log> — la carpeta bajada de una máquina
maq_buzon() {
  local R="$1/$2/registros"; mkdir -p "$R"
  [ -f "$4/gates.log" ] && gzip -c "$4/gates.log" > "$R/gates.log.gz"
  [ -f "$4/bypass.log" ] && gzip -c "$4/bypass.log" > "$R/bypass.log.gz"
  # story 2.6: el tercer registro. Una máquina que no lo tiene lo declara `no_medido` con motivo —
  # nunca «medido con cero líneas», que se leería como «este freno nunca frenó».
  local FR='"frenos":{"estado":"no_medido","motivo":"el registro no existe en esta máquina"}'
  if [ -f "$4/frenos.jsonl" ]; then
    gzip -c "$4/frenos.jsonl" > "$R/frenos.jsonl.gz"
    FR='"frenos":{"estado":"medido","bytes":1}'
  fi
  # story 2.7: el cuarto registro, con la misma regla.
  local CA='"carriles":{"estado":"no_medido","motivo":"el registro no existe en esta máquina"}'
  if [ -f "$4/carriles.jsonl" ]; then
    gzip -c "$4/carriles.jsonl" > "$R/carriles.jsonl.gz"
    CA='"carriles":{"estado":"medido","bytes":1}'
  fi
  printf '{"esquema":1,"fecha":"%s","fuentes":{"gates":{"estado":"medido","bytes":1},"bypass":{"estado":"medido","bytes":1},%s,%s}}\n' "$3" "$FR" "$CA" > "$R/cobertura.json"
}
# reg_frenos <archivo> <fecha> <freno> <regla> <decisiones> <bloqueos> <escapes>
reg_frenos() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, freno, regla = sys.argv[1:5]
total, bloq, esc = int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
with open(f, 'a') as o:
    for i in range(total):
        v = 'bloqueo' if i < bloq else ('escape' if i < bloq + esc else 'paso')
        o.write(json.dumps({"ts": f"{fecha}T12:{i % 60:02d}:00Z", "freno": freno,
                            "regla": regla, "veredicto": v, "sha256": "f" * 64}) + "\n")
PY2
}
json_local() {
  python3 - "$1" "$2" <<'PY2'
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
print(json.dumps(d['local'].get(sys.argv[2])))
PY2
}
AYER25="$(fecha_hace 1)"

# ── C-38 · los dos números del MISMO freno, en la misma ficha (2.6 T14 · AC 10) ──
# 🔴 rojo previo: publicar sólo los bloqueos → la ficha no contesta si el freno estorba; o contar
#    la ausencia de escapes como «no medido» → el freno que nunca se saltea desaparece.
T=$(mktemp -d); montar_sano "$T"
mkdir -p "$T/local" "$T/remota"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_frenos "$T/local/frenos.jsonl" "$AYER25" test-scope-guard suite-completa 12 7 4
reg_frenos "$T/remota/frenos.jsonl" "$AYER25" safety-guard GIT-C1 6 6 0
reg_gates "$T/remota/gates.log" "$AYER25" tests 10 1
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
maq_buzon "$T/buzon" maq-remota-b "$AYER25" "$T/remota"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
FR="$(json_local "$T/j.out" frenos)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido', d
assert d['valor']==13 and d['medidos']==13, d   # CUENTA de frenadas (7+6), no una proporción:
                                               # los seis frenos no comparten denominador (ver dashboard.js)
det=d['detalle']
assert 'test-scope-guard: frenó 7, lo saltearon 4, de 12' in det, det
assert 'safety-guard: frenó 6, lo saltearon 0, de 6' in det, det   # cero escapes REALES, no «no medido»
" "$FR" 2>/dev/null \
  && ok "C-38 el total es una CUENTA (13 frenadas) y la proporción vive por freno, con su denominador; el que nunca se saltea dice 0" || mal "C-38 frenos=$FR"
grep -q 'El total es una cuenta, no un porcentaje' "$T/o.html" \
  && ok "C-38b la ficha aclara que el total es una cuenta porque los seis no comparten denominador" || mal "C-38b falta la aclaración del denominador"
rm -rf "$T"

# ── C-39 · el escape dominante se EXPLICA cuando es una declaración esperada (2.6 T14 · AC 11) ──
# 🔴 rojo previo: publicar «el 80 % de los escapes es una sola regla» sin decir que esa regla es
#    correr la suite completa —que está permitido y se declara— se lee como un freno esquivado.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_bypass "$T/local/bypass.log" "$AYER25" FULL_SUITE_RUN 8
reg_bypass "$T/local/bypass.log" "$AYER25" GIT_NO_VERIFY 2
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
grep -q 'declaración esperada, no un freno esquivado' "$T/o.html" \
  && ok "C-39 con FULL_SUITE_RUN dominante, el pie dice que es una declaración esperada" || mal "C-39 el pie no explica el escape dominante"
rm -rf "$T"

# ── C-40 · el freno que NUNCA bloquea no puede salir «frenó 0, lo saltearon 0» (2.6 · AC 11) ──
# 🔴 rojo previo (defecto real, hallado por el pase adversarial ejecutando el código): con sólo
#    `ratio_bloqueo` y `ratio_escape`, `push-referencia-fantasma` —cuyo único veredicto posible es
#    `aviso`— se publicaba con los dos números en cero: literalmente «se ve igual que uno que nunca
#    se disparó», que es la frase con la que se justifica esta story.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_frenos "$T/local/frenos.jsonl" "$AYER25" push-referencia-fantasma referencia-fantasma 16 0 0
python3 - "$T/local/frenos.jsonl" "$AYER25" <<'PY2'
import json, sys
f, fecha = sys.argv[1], sys.argv[2]
# 12 de las 16 son `aviso` (reg_frenos sólo sabe escribir bloqueo/escape/paso)
ls = [json.loads(l) for l in open(f)]
for i, d in enumerate(ls):
    if i < 12: d['veredicto'] = 'aviso'
open(f, 'w').write('\n'.join(json.dumps(d) for d in ls) + '\n')
PY2
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
FR="$(json_local "$T/j.out" frenos)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido', d
det=d['detalle']
assert 'avisó 12' in det, det
assert 'push-referencia-fantasma: frenó 0, lo saltearon 0' not in det, det
" "$FR" 2>/dev/null \
  && ok "C-40 el freno que sólo avisa publica sus 12 avisos, no dos ceros" || mal "C-40 frenos=$FR"
rm -rf "$T"

# ═══════════ story 2.7 — el reproceso por carril y el carril de cada commit ═══════════
# con_carril <dir .dashboard> <json de la lista por repo> — agrega rework_por_carril a cada repo del snapshot
con_carril() {
  python3 - "$1" "$2" <<'PY2'
import glob, json, sys
f = glob.glob(sys.argv[1] + '/sdlc-stage-*.json')[0]
d = json.load(open(f))
d['repos'] = [{"repo": "/w/repos/" + r["repo"], "stories_total": 20, "done_total": 15,
               "rework_ratio": {"num": 1, "den": 15}, "dod_evidence_ratio": {"num": 1, "den": 15}, "not_measured": [],
               "rework_por_carril": r.get("x")} for r in json.loads(sys.argv[2])]
json.dump(d, open(f, 'w'))
PY2
}
carril_x() { echo "{\"desde\":\"2026-09-05\",\"con_corrida\":{\"num\":$1,\"den\":$2},\"sin_constancia\":{\"num\":$3,\"den\":$4},\"fuera_de_ventana\":9}"; }

# ── C-41 · por repo, y se NIEGA bajo el mínimo; sin hipótesis no dibuja (2.7 T15 · AC 14, 16) ──
# 🔴 rojo previo: dibujar con n=2 → el repo B publica «50 %» con dos stories; o sumar A y B en un total.
T=$(mktemp -d); montar_sano "$T"
con_carril "$T" "[{\"repo\":\"Prod__A\",\"x\":$(carril_x 1 6 3 7)},{\"repo\":\"Prod__B\",\"x\":$(carril_x 1 2 4 8)},{\"repo\":\"Prod__C\",\"x\":null}]"
node "$TABLERO" --dir "$T" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
RC="$(python3 - "$T/j.out" <<'PY2'
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
x = d['extra']['rework_por_carril']
assert x['estado'] == 'medido', x
det = x['detalle']
assert 'Prod / A' in det and '1 de 6' in det and '3 de 7' in det, det
assert 'Prod / B' in det and 'faltan 3' in det, det
assert '1 de 2' not in det and '50' not in det, det          # B no se dibuja
assert x['valor'] == 1, x                                     # repos comparables, no una proporción global
assert 'Prod / C' not in det or 'no guarda' in det, det
print('ok')
PY2
)"
[ "$RC" = "ok" ] && ok "C-41 A se dibuja con sus dos grupos; B dice cuánto falta y no publica su proporción; no hay total" || mal "C-41 $RC"
TYCON_LANE_HYPOTHESIS="$T/no-existe.json" node "$TABLERO" --dir "$T" --output "$T/o2.html" --json > "$T/j2.out" 2>/dev/null
python3 - "$T/j2.out" <<'PY2' && ok "C-41b sin hipótesis declarada la ficha sale no medida" || mal "C-41b la ficha dibujó sin hipótesis"
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
x = d['extra']['rework_por_carril']
assert x['estado'] != 'medido' and 'hipótesis' in x['motivo'], x
PY2
grep -q 'lane-hypothesis.json' "$T/o.html" && ok "C-41c la ficha cita dónde está la hipótesis" || mal "C-41c la ficha no cita la hipótesis"
rm -rf "$T"

# ── C-42 · el resultado EN CONTRA del pipeline se publica igual (2.7 T16 · AC 17) ──
# 🔴 rojo previo: esconder el repo donde el pipeline vuelve más.
T=$(mktemp -d); montar_sano "$T"
con_carril "$T" "[{\"repo\":\"Prod__D\",\"x\":$(carril_x 4 5 1 5)}]"
node "$TABLERO" --dir "$T" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
python3 - "$T/j.out" <<'PY2' && ok "C-42 el pipeline peor (4 de 5 contra 1 de 5) se publica" || mal "C-42 el resultado en contra no salió"
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
x = d['extra']['rework_por_carril']
assert x['estado'] == 'medido' and '4 de 5' in x['detalle'] and '1 de 5' in x['detalle'], x
PY2
rm -rf "$T"

# ── C-43 · commits por carril, con cobertura y la nota de «fuera de sesión» (2.7 T17 · AC 11, 12) ──
# 🔴 rojo previo: publicar sólo los carriles vistos como si fueran todos los commits.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
python3 - "$T/local/carriles.jsonl" "$AYER25" <<'PY2'
import json, sys
f, fecha = sys.argv[1], sys.argv[2]
with open(f, 'w') as o:
    for i, c in enumerate(['pipeline'] * 5 + ['adhoc'] * 4 + ['ninguno'] * 3):
        o.write(json.dumps({"ts": f"{fecha}T13:{i:02d}:00Z", "carril": c, "story": "CLIENTE-X-1" if c == 'pipeline' else None}) + "\n")
PY2
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
CA="$(json_local "$T/j.out" carriles)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido' and d['valor']==12, d
assert 'pipeline: 5' in d['detalle'] and 'adhoc: 4' in d['detalle'] and 'ninguno: 3' in d['detalle'], d
" "$CA" 2>/dev/null && ok "C-43 12 commits: pipeline 5 · adhoc 4 · ninguno 3" || mal "C-43 carriles=$CA"
grep -q 'fuera de una sesión no se ven' "$T/o.html" && ok "C-43 el pie dice que los commits fuera de sesión no se miden" || mal "C-43 falta la nota de fuera de sesión"
grep -q 'CLIENTE-X' "$T/o.html" "$T/j.out" && mal "C-43 la story llegó a la página" || ok "C-43 la story nunca sale"
rm -rf "$T"

# ── C-44 · si la cuenta de tiempos se rompe, la ficha dice eso y no «corridas viejas» (2.7 · silencioso) ──
# 🔴 rojo previo: el catch descartaba el error y la ficha publicaba «ninguna corrida anotó el arranque».
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/copia"
cp -R "$RAIZ/scripts" "$T/copia/scripts"
echo 'throw new Error("roto a propósito");' > "$T/copia/scripts/metrics/step-times.js"
mkdir -p "$HOME/.claude/.tycon-pipeline/timing-history"
echo '{"archivedAt":"2026-09-16T10:00:00Z","marker":{"startedAt":"2026-09-16T09:00:00Z","lastTouch":"2026-09-16T10:00:00Z","stepTimings":{"1":{"startedAt":"2026-09-16T09:00:00Z","completedAt":"2026-09-16T09:30:00Z"}}}}' > "$HOME/.claude/.tycon-pipeline/timing-history/c44.json"
node "$T/copia/scripts/nightly/dashboard/dashboard.js" --dir "$T" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
TE="$(json_local "$T/j.out" trabajo_espera)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']!='medido' and 'no se pudo cargar' in d['motivo'] and 'anteriores a la story 2.7' not in d['motivo'], d
" "$TE" 2>/dev/null && ok "C-44 con la cuenta rota, trabajo/espera dice que no se pudo cargar" || mal "C-44 trabajo_espera=$TE"
rm -f "$HOME/.claude/.tycon-pipeline/timing-history/c44.json"
rm -rf "$T"


# ── C-47 · la ficha de cobertura cuenta las corridas que evaluaron el umbral sobre las líneas tocadas (2.4 T13 · AC 9) ──
# 🔴 rojo previo: la ficha vieja caminaba el disco buscando tests-result.json y hablaba de «archivos nuevos».
reg_cobertura() {   # <archivo> <fecha> <cumple> <habria-frenado> <no-medido>
  python3 - "$@" <<'PY2'
import json, sys
f, fecha = sys.argv[1], sys.argv[2]
n = [("cumple", int(sys.argv[3])), ("habria-frenado", int(sys.argv[4])), ("no-medido", int(sys.argv[5]))]
i = 0
with open(f, 'a') as o:
    for st, k in n:
        for _ in range(k):
            o.write(json.dumps({"ts": f"{fecha}T13:{i % 60:02d}:00Z", "name": "cobertura-tocada", "status": st}) + "\n"); i += 1
PY2
}
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_cobertura "$T/local/gates.log" "$AYER25" 5 3 2
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
CT="$(json_local "$T/j.out" cobertura_tocada)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido', d
assert abs(d['valor']-0.8)<1e-9 and d['medidos']==8 and d['total']==10, d
assert 'habría frenado 3 de 8' in d['detalle'], d
" "$CT" 2>/dev/null \
  && ok "C-47 8 de 10 corridas evaluaron el umbral y 3 de esas 8 habrían frenado" || mal "C-47 cobertura_tocada=$CT"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" >/dev/null 2>&1
FIC="$(ficha_html "$T/o.html" 'evaluaron el umbral')"
{ [ -n "$FIC" ] && ! grep -q 'archivos nuevos' "$T/o.html" && ! grep -q 'cobertura_nuevos' "$T/o.html"; } \
  && ok "C-47 la ficha dice «evaluaron el umbral» y la página ya no habla de archivos nuevos" || mal "C-47 ficha=[${FIC:0:200}]"
bloq="$(json_local "$T/j.out" bloqueos)"
python3 -c "import json,sys; b=json.loads(sys.argv[1]); assert b['valor']==1 and b['total']==10 and b['medidos']==10, b" "$bloq" 2>/dev/null \
  && ok "C-47 las líneas de cobertura no tocan la ficha de bloqueos (1 de 10, igual que sin ellas)" || mal "C-47 bloqueos=$bloq"
rm -rf "$T"

# ── C-48 · sin líneas de cobertura tocada la ficha dice «no medido» con motivo, nunca 0 (2.4 · AC 9) ──
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
CT="$(json_local "$T/j.out" cobertura_tocada)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']!='medido' and d.get('motivo'), d
" "$CT" 2>/dev/null && ok "C-48 sin líneas → no medido con motivo" || mal "C-48 cobertura_tocada=$CT"
rm -rf "$T"

# ── C-49 · el nocturno corre el parser de cobertura (2.4 T14 · AC 10) ──
python3 -c "
import json,sys
s=json.load(open(sys.argv[1]))
todas=[x for k,v in s.items() if isinstance(v,list) for x in v]
assert any(x.get('raiz')=='agent-skills' and x.get('ruta')=='tycon-pipeline/scripts/tests/test-coverage-parser.js' for x in todas)
" "$RAIZ/scripts/tests/suites.json" 2>/dev/null \
  && ok "C-49 suites.json lista test-coverage-parser.js" || mal "C-49 suites.json no lista el parser de cobertura"

# ── C-29 · dos máquinas se suman por num/den, nunca promediando; la misma máquina en el disco y en el buzón cuenta una (2.5 T7 · AC 7) ──
# 🔴 rojo previo: promediar los ratios (2/40 y 30/60 → 27,5 %) o sumar el disco local y su copia bajada (34/140).
T=$(mktemp -d); montar_sano "$T"
mkdir -p "$T/local" "$T/remota"
reg_gates "$T/local/gates.log" "$AYER25" tests 40 2;  reg_bypass "$T/local/bypass.log" "$AYER25" FULL_SUITE_RUN 3
reg_gates "$T/remota/gates.log" "$AYER25" tests 60 30; reg_bypass "$T/remota/bypass.log" "$AYER25" FULL_SUITE_RUN 2
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
maq_buzon "$T/buzon" maq-remota-b "$AYER25" "$T/remota"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"; E="$(json_local "$T/j.out" escapes)"; D="$(json_local "$T/j.out" escapes_dom)"
python3 -c "import json,sys; b,e,d=[json.loads(x) for x in sys.argv[1:4]]; assert b['estado']=='medido' and b['valor']==32 and b['medidos']==100, b; assert e['valor']==5, e; assert abs(d['valor']-1.0)<1e-9 and 'FULL_SUITE_RUN' in d['detalle'], d" "$B" "$E" "$D" 2>/dev/null \
  && ok "C-29 32 bloqueos sobre 100 evaluaciones y 5 escapes: sumado por num/den, el disco local y su copia bajada cuentan una" || mal "C-29 bloqueos=$B escapes=$E dominante=$D"
rm -rf "$T"

# ── C-30 · esperadas: la ausente se nombra, la no declarada entra, la atrasada lleva su fecha (2.5 T10 · AC 10) ──
# 🔴 rojo previo: contar las carpetas encontradas como esperadas → «3 de 3», la ausente desaparece.
T=$(mktemp -d); mkdir -p "$T/reg"; reg_gates "$T/reg/gates.log" "$AYER25" tests 5 1
AL_A="$(alias_de maq-a)"; AL_B="$(alias_de maq-b)"; AL_C="$(alias_de maq-c)"; AL_D="$(alias_de maq-d)"
maq_buzon "$T/buzon" maq-a "$(fecha_hace 10)" "$T/reg"
maq_buzon "$T/buzon" maq-b "$AYER25" "$T/reg"
maq_buzon "$T/buzon" maq-d "$AYER25" "$T/reg"
mkdir -p "$T/buzon/maq-e/registros"; echo '{ roto' > "$T/buzon/maq-e/registros/cobertura.json"
node -e '
const r = require(process.argv[1]); const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
cfg.reducer.expected_machines = [process.argv[4], process.argv[5], process.argv[6]].map((alias) => ({ alias, from: "2026-09-01" })).concat([{ alias: "maq-f0f0f0", from: "2099-01-01" }]);
const j = r.juntar({ registros: null, buzon: process.argv[3], cfg, hoy: new Date().toISOString().slice(0, 10) });
console.log(JSON.stringify({ c: j.cobertura, t: r.textoCobertura(j) }));
' "$REDUCTOR" "$RAIZ/scripts/nightly/dashboard/sources.json" "$T/buzon" "$AL_A" "$AL_B" "$AL_C" > "$T/c.json" 2>"$T/c.err"
python3 - "$T/c.json" "$AL_A" "$AL_C" "$AL_D" "$(fecha_hace 10)" <<'PY' && ok "C-30 «reportaron 2 de 3»: la ausente por alias, +1 sin declarar, la atrasada con su fecha, la carpeta ilegible contada, y una esperada «desde» una fecha futura todavía no cuenta" || mal "C-30 cobertura: $(cat "$T/c.json" "$T/c.err" | head -c 600)"
import json, sys
d = json.load(open(sys.argv[1])); c, t = d['c'], d['t']
a, cc, dd, fa = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
assert c['esperadas'] == 3 and c['reportaron'] == 2, c
assert c['ausentes'] == [cc] and c['sin_declarar'] == [dd], c
assert c['atrasadas'] == [{'alias': a, 'hasta': fa}], c
assert c['carpetas_ilegibles'] == 1, c
assert 'reportaron 2 de 3' in t and f'no reportó: {cc}' in t and f'+1 sin declarar: {dd}' in t and f'{a} (hasta {fa})' in t, t
PY
rm -rf "$T"

# ── C-31 · el piso calla los valores chicos, y en el detalle los agrupa sin nombrarlos (2.5 T11 · AC 11) ──
# 🔴 rojo previo: piso en 2 → la ficha publica «2».
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 2 1; reg_bypass "$T/local/bypass.log" "$AYER25" FULL_SUITE_RUN 2
TYCON_MACHINE=maquina-piso node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/nada" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"; E="$(json_local "$T/j.out" escapes)"
python3 -c "import json,sys; b,e=[json.loads(x) for x in sys.argv[1:3]]; assert b['estado']=='no_medido' and 'debajo del piso (2' in b['motivo'], b; assert e['estado']=='no_medido' and 'debajo del piso (2' in e['motivo'], e" "$B" "$E" 2>/dev/null \
  && ok "C-31 2 evaluaciones y 2 escapes → «no medido: por debajo del piso (2)», nunca el número" || mal "C-31 bloqueos=$B escapes=$E"
D="$(json_local "$T/j.out" escapes_dom)"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d and d['estado']=='no_medido' and d['motivo'], d" "$D" 2>/dev/null \
  && ok "C-31 con los escapes bajo el piso, la ficha «escapes concentrados» dice no medido CON motivo (no «error del colector»)" || mal "C-31 escapes_dom=$D"
reg_gates "$T/local/gates.log" "$(fecha_hace 2)" tests 8 4; reg_gates "$T/local/gates.log" "$(fecha_hace 2)" build 2 1
TYCON_MACHINE=maquina-piso node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/nada" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"
python3 -c "import json,sys; b=json.loads(sys.argv[1]); assert b['estado']=='medido' and b['valor']==6 and 'tests: 5' in b['detalle'] and 'otras (1, debajo del piso)' in b['detalle'] and 'build' not in b['detalle'], b" "$B" 2>/dev/null \
  && ok "C-31 en el detalle, el control con menos de 3 evaluaciones va a «otras» sin su nombre" || mal "C-31 detalle: $B"
rm -rf "$T"

# ── C-33 · «otro» y «sin-tipo» no son una regla: no pueden salir como «la regla dominante» (2.5 · AC 12) ──
# 🔴 rojo previo: elegir la dominante entre todos los baldes → 6 tipos distintos fuera de la lista salen como
#    «una regla concentra todo» con «otro» al 100 %.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
for k in KIND_NUEVO_A KIND_NUEVO_B KIND_NUEVO_C KIND_NUEVO_D KIND_NUEVO_E KIND_NUEVO_F; do echo "{\"ts\":\"${AYER25}T11:00:00Z\",\"kind\":\"$k\"}" >> "$T/local/bypass.log"; done
TYCON_MACHINE=maquina-dom node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/nada" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
D="$(json_local "$T/j.out" escapes_dom)"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['estado']=='no_medido' and d['motivo'], d" "$D" 2>/dev/null && ! grep -q 'la regla dominante es otro' "$T/o.html" \
  && ok "C-33 seis tipos fuera de la lista → no hay regla dominante que nombrar (no medido con motivo), nunca «otro» al 100 %" || mal "C-33 dominante con sólo «otro»: $D"
reg_bypass "$T/local/bypass.log" "$AYER25" STEP_OUT_OF_ORDER 4
TYCON_MACHINE=maquina-dom node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/nada" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
D="$(json_local "$T/j.out" escapes_dom)"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['estado']=='medido' and 'STEP_OUT_OF_ORDER' in d['detalle'] and abs(d['valor']-0.4)<1e-9, d" "$D" 2>/dev/null \
  && ok "C-33 con 4 STEP_OUT_OF_ORDER (un tipo que el pipeline escribe) sobre 10, la dominante es ésa al 40 %" || mal "C-33 dominante con nombre: $D"
rm -rf "$T"

# ── C-34 · la carpeta bajada que no se puede leer se DICE en la página (2.5 · AC 8) ──
# 🔴 rojo previo: un readdir que falla leído como «no hay máquinas» → la página dice sólo «reportaron 0 de 1».
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"; reg_gates "$T/local/gates.log" "$AYER25" tests 5 1; echo x > "$T/archivo"
TYCON_MACHINE=maquina-c34 node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/archivo/sub" --output "$T/o.html" >/dev/null 2>&1
grep -q 'no se pudo leer la carpeta bajada' "$T/o.html" && ok "C-34 la nota de la pregunta 4 dice que no se pudo leer la carpeta bajada: las otras máquinas faltan, no son cero" || mal "C-34 la página calla la carpeta ilegible: $(grep -o 'Frenos y escapes[^<]*' "$T/o.html" | head -1)"
rm -rf "$T"

# ── C-32 · un solo cálculo: los nombres crudos de los registros nunca llegan a la página (2.5 T12 · AC 12) ──
# 🔴 rojo previo: el dashboard.js de main → publica «control-crudo-*» y «TIPO-CRUDO» en el detalle de las fichas.
T=$(mktemp -d); montar_sano "$T"
H2="$T/casa"; mkdir -p "$H2/.claude/.tycon-pipeline"
for i in 1 2 3 4; do echo "{\"ts\":\"$(hace 1)\",\"name\":\"control-crudo-$i\",\"status\":\"blocked\"}"; done > "$H2/.claude/.tycon-pipeline/gates.log"
for i in 1 2 3 4; do echo "{\"ts\":\"$(hace 1)\",\"type\":\"TIPO-CRUDO\"}"; done > "$H2/.claude/.tycon-pipeline/bypass.log"
HOME="$H2" TYCON_MACHINE=maquina-cruda node "$TABLERO" --dir "$T" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"; E="$(json_local "$T/j.out" escapes)"
python3 -c "import json,sys; b,e=[json.loads(x) for x in sys.argv[1:3]]; assert b['estado']=='medido' and b['valor']==4 and 'otro: 4' in b['detalle'], b; assert e['valor']==4 and 'otro: 4' in e['detalle'], e" "$B" "$E" 2>/dev/null \
  && ! grep -q 'control-crudo\|TIPO-CRUDO' "$T/o.html" "$T/j.out" \
  && ok "C-32 los registros de esta máquina se cuentan como «otro» y ningún nombre crudo llega a la página ni al --json" || mal "C-32 bloqueos=$B escapes=$E $(grep -o 'control-crudo[^<]*' "$T/o.html" | head -1)"
grep -q 'Frenos y escapes, de todas las máquinas: reportaron 0 de' "$T/o.html" && ! grep -q 'Frenos, escapes y corridas salen de los registros de esta máquina' "$T/o.html" \
  && ok "C-32 la nota de la pregunta 4 dice la cobertura de máquinas y ya no «esta máquina» para frenos y escapes" || mal "C-32 la nota de la pregunta 4 no cambió"
rm -rf "$T"

# ── C-35 · los caminos de «no hay nada que contar» dicen POR QUÉ (2.5 · AC 8, AC 12) ──
# 🔴 rojo previo: devolver null o un motivo genérico en esas ramas → la ficha dice «error del colector».
T=$(mktemp -d); montar_sano "$T"; H3="$T/casa-vacia"; mkdir -p "$H3"
HOME="$H3" TYCON_MACHINE=maquina-vacia node "$TABLERO" --dir "$T" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"; D="$(json_local "$T/j.out" escapes_dom)"
python3 -c "import json,sys; b,d=[json.loads(x) for x in sys.argv[1:3]]; assert b['estado']=='no_medido' and 'ninguna máquina reportó sus registros' in b['motivo'], b; assert d['estado']=='no_medido' and d['motivo'], d" "$B" "$D" 2>/dev/null \
  && ok "C-35 sin registros en ninguna máquina → «ninguna máquina reportó sus registros», también en la regla dominante" || mal "C-35 sin máquinas: bloqueos=$B dom=$D"
mkdir -p "$T/local-vacia"
TYCON_MACHINE=maquina-vacia node "$TABLERO" --dir "$T" --logs "$T/local-vacia" --mailbox "$T/nada" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"; E="$(json_local "$T/j.out" escapes)"
python3 -c "import json,sys; b,e=[json.loads(x) for x in sys.argv[1:3]]; assert 'ninguna máquina pudo leer su registro de frenos' in b['motivo'], b; assert 'ninguna máquina pudo leer su registro de escapes' in e['motivo'], e" "$B" "$E" 2>/dev/null \
  && ok "C-35 una máquina sin gates.log ni bypass.log → «ninguna máquina pudo leer su registro», no «no reportó»" || mal "C-35 sin registros legibles: bloqueos=$B escapes=$E"
HOME="$H3" node -e '
const t = require(process.argv[1]); const r = require(process.argv[2]);
const sinSeccion = t.equipo({ sources: [] });
const tira = {}; Object.defineProperty(tira, "reducer", { get() { throw new TypeError("x"); } });
const falla = t.equipo(tira);
const fs = require("fs"); const leerCfg = () => JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const cfgE = leerCfg(); delete cfgE.reducer.metrics.escapes; const sinEscapes = t.equipo(cfgE);
const cfgB = leerCfg(); delete cfgB.reducer.metrics.bloqueos; const sinBloqueos = t.equipo(cfgB);
console.log(JSON.stringify({ a: sinSeccion.bloqueos, ad: sinSeccion.escapes_dom, b: falla.bloqueos, t: r.textoCobertura({ estado: "no_medido" }), e: sinEscapes.escapes, ed: sinEscapes.escapes_dom, nb: sinBloqueos.bloqueos }));
' "$TABLERO" "$REDUCTOR" "$RAIZ/scripts/nightly/dashboard/sources.json" > "$T/e.json" 2> "$T/e.err"
python3 - "$T/e.json" <<'PY' && ok "C-35 sección «reducer» ausente → no medido con motivo (también la dominante); juntar() que tira → «la cuenta de los registros falló»; una config sin la métrica de escapes o sin la de bloqueos lo dice; y el texto de cobertura sin cuenta lo dice" || mal "C-35 equipo(): $(cat "$T/e.json" "$T/e.err" | head -c 500)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['a']['estado'] == 'no_medido' and 'no sirve' in d['a']['motivo'], d['a']
assert d['ad']['estado'] == 'no_medido' and d['ad']['motivo'] == d['a']['motivo'], d['ad']
assert d['b']['estado'] == 'no_medido' and 'la cuenta de los registros falló' in d['b']['motivo'], d['b']
assert 'no se pudieron contar' in d['t'], d['t']
assert d['e']['estado'] == 'no_medido' and 'no declara la métrica de escapes' in d['e']['motivo'], d['e']
assert d['ed']['estado'] == 'no_medido' and d['ed']['motivo'] == d['e']['motivo'], d['ed']
assert d['nb']['estado'] == 'no_medido' and 'no declara la métrica de bloqueos' in d['nb']['motivo'], d['nb']
PY
rm -rf "$T"

# ── C-36 · el barrido de las ramas que quedaban del texto de la pregunta 4 (2.5 · AC 8, AC 10) ──
# 🔴 rojo previo: sin la nota parcial, «5 escapes» de 1 de 2 máquinas se lee como el total del equipo; sin el
#    conteo de líneas ilegibles en el texto, el número baja y la página no dice por qué.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local" "$T/remota"
reg_gates "$T/local/gates.log" "$AYER25" tests 6 2; reg_bypass "$T/local/bypass.log" "$AYER25" FULL_SUITE_RUN 5; printf 'no soy json\n' >> "$T/local/gates.log"
reg_gates "$T/remota/gates.log" "$AYER25" tests 4 1
maq_buzon "$T/buzon" maq-parcial "$AYER25" "$T/remota"
python3 - "$T/buzon/maq-parcial/registros/cobertura.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); c['fuentes']['bypass'] = {'estado': 'no_medido', 'motivo': 'el registro no existe en esta máquina'}; json.dump(c, open(sys.argv[1], 'w'))
PY
TYCON_MACHINE=maquina-c36 node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
E="$(json_local "$T/j.out" escapes)"; B="$(json_local "$T/j.out" bloqueos)"; CT="$(json_local "$T/j.out" cobertura_maquinas)"
python3 -c "import json,sys; e,b,ct=[json.loads(x) for x in sys.argv[1:4]]; assert e['valor']==5 and 'escapes: midieron 1 de 2 máquinas' in e['detalle'], e; assert b['medidos']==10 and 'midieron' not in b['detalle'], b; assert '1 línea ilegible en los registros' in ct, ct" "$E" "$B" "$CT" 2>/dev/null \
  && ok "C-36 escapes de 1 de 2 máquinas dicen «midieron 1 de 2» (los bloqueos, medidos por las dos, no); y la línea ilegible se dice en la cobertura" || mal "C-36 escapes=$E bloqueos=$B cobertura=$CT"
rm -rf "$T"

# ── C-27 · esta suite NO toca el entregable commiteado (2026-09-06) ───────────────────────────
# 🔴 rojo previo: devolverle a C-11 el `--output "$RAIZ/artifacts/tablero-del-arnes.html"` que
#    tenía. Verificado: con esa línea el caso se pone rojo y `git status` muestra la M.
#
# POR QUÉ ESTE CASO EXISTE. C-11 generaba el tablero DIRECTAMENTE sobre el archivo que abre una
# persona, con los datos de la máquina que corrió el test, y nada lo restauraba: la suite salía 0
# y lo único que quedaba era una `M` en `git status` que había que acordarse de mirar. Medido el
# 2026-09-06: dos fichas medidas pasaron a decir otra cosa y el sello de generación quedó apuntando
# a otro commit. Un `git add -A` distraído lo publica. El vecino C-12 ya hacía copia y restauraba
# `declared.json`, así que el patrón correcto vivía dos casos más abajo.
#
# Es un caso de la FAMILIA, no de la línea: cualquier caso futuro que escriba ahí lo pone rojo.
HUELLA_DESPUES="$(huella "$ENTREGABLE")"
if [ "$HUELLA_ANTES" = "$HUELLA_DESPUES" ]; then
  ok "C-27 la suite no tocó artifacts/tablero-del-arnes.html"
else
  mal "C-27 la suite REESCRIBIÓ artifacts/tablero-del-arnes.html (antes ${HUELLA_ANTES:0:12}… / después ${HUELLA_DESPUES:0:12}…) — algún caso está generando sobre el entregable en vez de sobre un temporal"
fi

# ── C-28 · la suite tampoco deja tocado scripts/nightly/dashboard/declared.json (2026-09-06) ──────────
# 🔴 rojo previo: quitarle a C-12 la línea que restaura (`cp "$T/declarados.bak" "$D"`).
# C-12 MUTA el archivo commiteado a propósito (dashboard.js lo lee de una ruta fija, no hay flag) y
# lo devuelve con un `cp`. Sin este guardián, un C-12 que muera entre la mutación y el `cp` —una
# señal, un Ctrl-C— deja el JSON con `revisar_antes_de: 2000-01-01`, commiteable, y nadie se
# entera hasta que el tablero dibuje todas las declaraciones como vencidas. Mismo defecto que
# tenía C-11 con el html; misma familia de guardián que C-27.
HUELLA_DECL_DESPUES="$(huella "$DECLARADOS")"
if [ "$HUELLA_DECL_ANTES" = "$HUELLA_DECL_DESPUES" ]; then
  ok "C-28 la suite no dejó tocado scripts/nightly/dashboard/declared.json"
else
  mal "C-28 la suite DEJÓ MODIFICADO scripts/nightly/dashboard/declared.json (antes ${HUELLA_DECL_ANTES:0:12}… / después ${HUELLA_DECL_DESPUES:0:12}…) — un caso lo mutó y no lo devolvió"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# story 2.9 — la tabla por regla: el criterio de poda en la pregunta 4
# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Los fixtures del cruce entran por variable de entorno (catálogo, padrón, casos, examen, volcados): el
# catálogo real cambia con el tiempo y un caso que dependa de él se rompería solo. La configuración sí es
# la real (scripts/nightly/dashboard/sources.json → poda), porque lo que se prueba es que el criterio COMMITEADO es
# el que se aplica. Por eso las fechas son relativas a hoy.
poda_fixtures() {   # <T> — un revisor (dos reglas: una activa, una candidata) y un freno (sin revisor)
  local T="$1"
  mkdir -p "$T/poda/revisores" "$T/poda/casos" "$T/poda/historia" "$T/local"
  cat > "$T/poda/catalogo.md" <<'MD'
# Catálogo

## Revisor A — `adv-a`

| Regla | Qué | Fix |
|---|---|---|
| **R-C1** | a | a |
| **R-C2** | b | b |

## Freno — `freno.sh`

| Regla | Qué | Fix |
|---|---|---|
| **F-C1** | c | c |
MD
  printf 'name = "adv-a"\n' > "$T/poda/revisores/adv-a.toml"
  printf '{"cases":[{"type":"must-flag","rule":"R-C1"},{"type":"must-flag","rule":"R-C2"}]}' > "$T/poda/casos/adv-a.json"
  cat > "$T/poda/examen.json" <<JSON
{"alcance":"completo","only":[],"ts":"$(fecha_hace 1)T05:00:00Z","results":{
 "adv-a::r1":{"type":"must-flag","rule":"R-C1","tools":{"claude":{"pass":true,"clase":"ok"}}},
 "adv-a::r2":{"type":"must-flag","rule":"R-C2","tools":{"claude":{"pass":true,"clase":"ok"}}}}}
JSON
  local i
  for i in $(seq 1 13); do echo "{\"marker\":{\"startedAt\":\"$(fecha_hace 5)T10:00:00Z\"},\"revisores\":{\"por_tipo\":{\"adv-a\":1}}}" > "$T/poda/historia/a-${i}.json"; done
  for i in $(seq 1 12); do echo "{\"marker\":{\"startedAt\":\"$(fecha_hace 45)T10:00:00Z\"},\"revisores\":{\"por_tipo\":{\"adv-a\":1}}}" > "$T/poda/historia/b-${i}.json"; done
  echo "{\"ts\":\"$(fecha_hace 3)T10:00:00Z\",\"corrida\":\"c-00000000c401\",\"regla\":\"R-C1\",\"dueno\":\"adv-a\",\"severidad\":\"WARNING\",\"disposicion\":\"fixed\"}" > "$T/local/hallazgos.jsonl"
  echo "{\"ts\":\"$(fecha_hace 4)T10:00:00Z\",\"corrida\":\"c-00000000c402\",\"regla\":\"R-C1\",\"dueno\":\"adv-a\",\"severidad\":\"CRITICAL\",\"disposicion\":\"fixed\"}" >> "$T/local/hallazgos.jsonl"
  # las corridas que el recolector leyó (el denominador) y el sello, con los conteos de la serie (vuelta 2)
  for i in $(seq 1 13); do echo "{\"volcado\":\"a-${i}.json\",\"medida\":\"con_hallazgos\"}" >> "$T/local/hallazgos.jsonl"; done
  for i in $(seq 1 12); do echo "{\"volcado\":\"b-${i}.json\",\"medida\":\"revisado_sin_hallazgos\"}" >> "$T/local/hallazgos.jsonl"; done
  echo "{\"estado\":\"recolectado\",\"fecha\":\"$(fecha_hace 0)\",\"repos\":1,\"hallazgos\":2,\"volcados\":{\"leidos\":25,\"medidos\":25}}" > "$T/local/findings-seal.json"
}
tablero_poda() {    # <T> [args] — corre el tablero con los fixtures del cruce
  local T="$1"; shift
  TYCON_CATALOG="$T/poda/catalogo.md" TYCON_REVIEWERS_DIR="$T/poda/revisores" TYCON_CASES_DIR="$T/poda/casos" \
  TYCON_EXAM="$T/poda/examen.json" TYCON_HISTORY_DIR="$T/poda/historia" TYCON_MACHINE=maquina-poda \
    node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/nada" --output "$T/o.html" "$@"
}
json_poda() {      # mismo recorte que json_local: la salida del tablero trae texto antes del JSON
  python3 - "$1" "$2" <<'PY2'
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
print(json.dumps(d['poda'].get(sys.argv[2])))
PY2
}

# ── C-40 · la tabla por regla reemplaza al hueco, con sus dos denominadores (2.9 · AC 12, 13, 19) ──
# 🔴 rojo previo: el tablero de main dibuja una ficha fija «no se registra cuántas veces cada regla tuvo
#    oportunidad de disparar» — el hueco que esta story cierra.
T=$(mktemp -d); montar_sano "$T"; poda_fixtures "$T"
tablero_poda "$T" --json > "$T/j.out" 2>/dev/null
CAND="$(json_poda "$T/j.out" candidatas)"; PROB="$(json_poda "$T/j.out" probadas)"
python3 -c "
import json,sys
c,p=[json.loads(x) for x in sys.argv[1:3]]
assert c['estado']=='medido' and c['valor']==1, c
assert p['estado']=='medido' and p['medidos']==2 and p['total']==2, p
" "$CAND" "$PROB" 2>/dev/null \
  && ok "C-40 1 candidata a retiro, y 2 de 2 reglas con revisor probadas por el banco" \
  || mal "C-40 candidatas=$CAND probadas=$PROB"
grep -q 'no se registra cuántas veces cada regla tuvo oportunidad' "$T/o.html" \
  && mal "C-40 la página sigue mostrando el hueco — rojo previo: el placeholder fijo de main" \
  || ok "C-40 el hueco fijo ya no está en la página"
grep -q 'R-C2' "$T/o.html" && grep -q 'candidata a retiro' "$T/o.html" \
  && ok "C-40 la tabla nombra la candidata por regla" || mal "C-40 la tabla no lista la candidata R-C2"
grep -q 'R-C2</td><td>candidata a retiro · sabe ponerse roja' "$T/o.html" \
  && ok "C-40 la candidata lleva la advertencia «sabe ponerse roja»" \
  || mal "C-40 falta la advertencia — retirar una regla que sabe ponerse roja pierde disuasión"
grep -q 'medido en 1 de 1 máquina' "$T/o.html" \
  && ok "C-40 la ficha de candidatas dice en cuántas máquinas se midió" \
  || mal "C-40 la ficha no dice sobre cuántas máquinas son las candidatas"
grep -Eq 'desde|ventana' "$T/o.html" && grep -q "$(fecha_hace 120)" "$T/o.html" \
  && ok "C-40 el rótulo dice de qué período son los números" \
  || mal "C-40 la ventana no aparece en la página"
rm -rf "$T"

# ── C-41 · la 2.5 no se toca, y el hueco sale de la lista de pendientes (2.9 · AC 19) ──
# 🔴 rojo previo: sources.json de main todavía lista «Hallazgos por regla con denominador» en instrumentar.
T=$(mktemp -d); montar_sano "$T"; poda_fixtures "$T"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 3; reg_bypass "$T/local/bypass.log" "$AYER25" FULL_SUITE_RUN 4
tablero_poda "$T" --json > "$T/j.out" 2>/dev/null
B="$(json_local "$T/j.out" bloqueos)"
python3 -c "import json,sys; b=json.loads(sys.argv[1]); assert b['estado']=='medido' and b['valor']==3 and b['medidos']==10, b" "$B" 2>/dev/null \
  && ok "C-41 los frenos de la 2.5 se siguen contando igual (3 de 10)" || mal "C-41 bloqueos=$B — regresión sobre la 2.5"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
q=[x['what'] for x in d.get('instrument',[])]
assert 'Hallazgos por regla con denominador' not in q, q
" "$RAIZ/scripts/nightly/dashboard/sources.json" 2>/dev/null \
  && ok "C-41 el hueco salió de «lo que hay que instrumentar»" \
  || mal "C-41 sources.json todavía lista el hueco como pendiente"
rm -rf "$T"

# ── C-42 · sin examen usable, nada se marca candidata y la página lo dice (2.9 · AC 16) ──
# 🔴 rojo previo: sin la guarda, «0 examinadas» se publica como una medición y las candidatas se calculan igual.
T=$(mktemp -d); montar_sano "$T"; poda_fixtures "$T"; rm -f "$T/poda/examen.json"
tablero_poda "$T" --json > "$T/j.out" 2>/dev/null; RC=$?
CAND="$(json_poda "$T/j.out" candidatas)"; PROB="$(json_poda "$T/j.out" probadas)"
python3 -c "
import json,sys
c,p=[json.loads(x) for x in sys.argv[1:3]]
assert c['estado']=='no_medido' and c['motivo'], c
assert p['estado']=='no_medido' and p['motivo'], p
" "$CAND" "$PROB" 2>/dev/null \
  && ok "C-42 sin examen, candidatas y probadas quedan no medidas, con motivo" \
  || mal "C-42 candidatas=$CAND probadas=$PROB"
[ "$RC" = "0" ] && ok "C-42 la página se genera igual (exit 0): el examen no es una fuente obligatoria" \
  || mal "C-42 el tablero salió $RC por el examen ausente"
# y un catálogo ilegible no tira la página: las fichas del cruce quedan no medidas
T2=$(mktemp -d); montar_sano "$T2"; poda_fixtures "$T2"; printf 'nada\n' > "$T2/poda/catalogo.md"
tablero_poda "$T2" --json > "$T2/j.out" 2>/dev/null; RC=$?
CAND="$(json_poda "$T2/j.out" candidatas)"
python3 -c "import json,sys; c=json.loads(sys.argv[1]); assert c['estado']=='no_medido' and 'catálogo' in c['motivo'], c" "$CAND" 2>/dev/null && [ "$RC" = "0" ] \
  && ok "C-42 un catálogo sin reglas deja el cruce no medido sin tirar la página" \
  || mal "C-42 catálogo roto: rc=$RC candidatas=$CAND"
rm -rf "$T" "$T2"

# ── C-43 · sin hallazgos medidos las fichas callan, y el rótulo nombra las máquinas que no entraron (2.9 · vuelta 2) ──
# 🔴 rojo previo: sin hallazgos legibles el cruce contaba cero y la página publicaba como medidas las
#    candidatas de todo lo probado; y el rótulo decía «de 1 máquina(s)» sin decir cuáles faltaban.
T=$(mktemp -d); montar_sano "$T"; poda_fixtures "$T"; rm -f "$T/local/findings-seal.json"
tablero_poda "$T" --json > "$T/j.out" 2>/dev/null; RC=$?
CAND="$(json_poda "$T/j.out" candidatas)"
python3 -c "import json,sys; c=json.loads(sys.argv[1]); assert c['estado']=='no_medido' and 'hallazgos' in c['motivo'], c" "$CAND" 2>/dev/null \
  && ok "C-43 sin el sello del recolector, las candidatas quedan no medidas y el motivo lo dice" \
  || mal "C-43 candidatas=$CAND — rojo previo: medidas, con cero hallazgos"
[ "$RC" = "0" ] && ok "C-43 la página se genera igual" || mal "C-43 el tablero salió $RC"
T2=$(mktemp -d); montar_sano "$T2"; poda_fixtures "$T2"
mkdir -p "$T2/nada/portatil-de-zutana/registros"
echo '{"esquema":1,"fecha":"'"$(fecha_hace 0)"'","fuentes":{"hallazgos":{"estado":"no_medido","motivo":"x"}}}' > "$T2/nada/portatil-de-zutana/registros/cobertura.json"
tablero_poda "$T2" --json > "$T2/j.out" 2>/dev/null
DEN="$(json_poda "$T2/j.out" denominador)"
case "$DEN" in
  *"sin medir: maq-"*) ok "C-43 el rótulo nombra por alias la máquina cuyos hallazgos no entraron" ;;
  *) mal "C-43 denominador=$DEN — tiene que decir qué máquina no entró" ;;
esac
if grep -q 'zutana' "$T2/j.out" "$T2/o.html" 2>/dev/null; then mal "C-43 🔴 FUGA: el nombre de la máquina llegó a la página"
else ok "C-43 el nombre de la máquina no sale"; fi
rm -rf "$T" "$T2"

# ═══════════ story 2.8 — mutación y guía de QA como serie del equipo ═══════════
# reg_mut <archivo> <fecha> <estado> <killed/total|null> ... — una línea `mutation` por par
reg_mut() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, st = sys.argv[1:4]
with open(f, 'a') as o:
    for i, par in enumerate(sys.argv[4:]):
        k, t = (None, None) if par == 'null' else map(int, par.split('/'))
        o.write(json.dumps({"ts": f"{fecha}T14:{i % 60:02d}:00Z", "name": "mutation", "story": "9.9", "status": st,
                            "total": t, "killed": k, "repoPath": "/Users/x/Cliente", "reason": "texto libre"}) + "\n")
PY2
}
# reg_qa <archivo> <fecha> <estado> <esquema|sin> <n>
reg_qa() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, st, esq, n = sys.argv[1:6]
with open(f, 'a') as o:
    for i in range(int(n)):
        x = {"ts": f"{fecha}T15:{i % 60:02d}:00Z", "name": "qa-guide", "action": "warn", "status": st, "story": "/Users/x/specs/stories/9-9.md"}
        if esq != 'sin': x["esquema"] = int(esq)
        o.write(json.dumps(x) + "\n")
PY2
}

# ── C-50 · la mediana de mutación se calcula sobre la UNIÓN de las máquinas (2.8 T7 · AC 3, 7) ──
# 🔴 rojo previo: promediar las dos medianas (0,2 y 1) → 60 %; o leer sólo el disco local → 20 %, n=3.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local" "$T/remota"
reg_mut "$T/local/gates.log" "$AYER25" warn-survivors 1/10 2/10 3/10
reg_mut "$T/remota/gates.log" "$AYER25" pass 9/10 12/12 12/12 12/12 12/12
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
maq_buzon "$T/buzon" maq-remota-b "$AYER25" "$T/remota"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
MU="$(json_local "$T/j.out" mutacion)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido', d
assert abs(d['valor']-0.95)<1e-9 and d['medidos']==8, d
assert 'de 2 máquinas' in d['detalle'], d
" "$MU" 2>/dev/null && ok "C-50 mediana 95 % sobre 8 muestras de 2 máquinas (no 60 %, no 20 %)" || mal "C-50 mutacion=$MU"
rm -rf "$T"

# ── C-51 · una sola máquina aporta: la ficha lo dice, y la nota ya no culpa a «esta máquina» (2.8 T8 · AC 7) ──
# 🔴 rojo previo: la nota de la pregunta 3 de main dice que mutación y guía salen «de esta máquina».
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_mut "$T/local/gates.log" "$AYER25" pass 12/12 6/12 9/12
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
MU="$(json_local "$T/j.out" mutacion)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido' and d['medidos']==3, d
assert 'una sola máquina' in d['detalle'], d
" "$MU" 2>/dev/null && ok "C-51 con una sola máquina aportando, el detalle lo dice" || mal "C-51 mutacion=$MU"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" >/dev/null 2>&1
if grep -q 'sale de los registros de esta máquina, no del equipo' "$T/o.html"; then mal "C-51 la nota de la pregunta 3 sigue atribuyendo mutación y guía a «esta máquina»"
else ok "C-51 la nota de la pregunta 3 ya no atribuye mutación ni guía de QA a «esta máquina»"; fi
rm -rf "$T"

# ── C-52 · sin puntaje y sin registro completo: las dos fichas no medidas, con lo que hubo contado (2.8 T9 · AC 6, 9) ──
# 🔴 rojo previo: la ficha de guía de main publica «0 de 4» — un cero por construcción.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_mut "$T/local/gates.log" "$AYER25" structural null null null null null
reg_qa "$T/local/gates.log" "$AYER25" missing sin 4
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
MU="$(json_local "$T/j.out" mutacion)"; QA="$(json_local "$T/j.out" qa_guia)"
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); q=json.loads(sys.argv[2])
assert m['estado']!='medido' and '5 chequeos' in m['motivo'], m
assert q['estado']!='medido' and '4 avisos' in q['motivo'] and q.get('valor') is None, q
" "$MU" "$QA" 2>/dev/null && ok "C-52 mutación no medida («5 chequeos», ninguno pudo medir) y guía no medida («4 avisos»), sin valor" \
  || mal "C-52 mutacion=$MU qa_guia=$QA"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" >/dev/null 2>&1
FIC="$(ficha_html "$T/o.html" 'guía para que una persona pruebe')"
if [ -z "$FIC" ]; then mal "C-52 no encontré la ficha de la guía de QA en la página"
elif printf '%s' "$FIC" | grep '0%\|0 de 4' >/dev/null; then mal "C-52 la ficha de la guía publica un cero: ${FIC:0:200}"
else ok "C-52 la ficha de la guía de QA no publica «0 %» ni «0 de 4»"; fi
rm -rf "$T"

# ── C-53 · guía de QA con registro completo en dos máquinas (2.8 T10 · AC 6) ──
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local" "$T/remota"
reg_qa "$T/local/gates.log" "$AYER25" presente 2 2
reg_qa "$T/local/gates.log" "$AYER25" no-aplica 2 3
reg_qa "$T/remota/gates.log" "$AYER25" stale 2 1
reg_qa "$T/remota/gates.log" "$AYER25" missing sin 5
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
maq_buzon "$T/buzon" maq-remota-b "$AYER25" "$T/remota"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
QA="$(json_local "$T/j.out" qa_guia)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido', d
assert abs(d['valor']-2/3)<1e-9 and d['medidos']==2 and d['total']==3, d
assert 'de 2 máquinas' in d['detalle'], d
" "$QA" 2>/dev/null && ok "C-53 2 de 3 cierres que necesitaban guía la tenían, de 2 máquinas (no-aplica y los avisos sin esquema fuera)" || mal "C-53 qa_guia=$QA"
rm -rf "$T"

# ── C-54 · no se filtra por máquina: la no declarada cuenta igual que la declarada (2.8 T11 · AC 8) ──
# 🔴 rojo previo: contar sólo las esperadas → aportó 1 y la mediana sale de una sola máquina.
T=$(mktemp -d); mkdir -p "$T/a" "$T/b"
reg_mut "$T/a/gates.log" "$AYER25" pass 12/12 12/12
reg_mut "$T/b/gates.log" "$AYER25" pass 0/12 0/12
maq_buzon "$T/buzon" maq-declarada "$AYER25" "$T/a"
maq_buzon "$T/buzon" maq-no-declarada "$AYER25" "$T/b"
node -e '
const r = require(process.argv[1]); const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
cfg.reducer.expected_machines = [{ alias: r.aliasDe("maq-declarada"), from: "2026-09-01" }];
const j = r.juntar({ registros: null, buzon: process.argv[3], cfg, hoy: new Date().toISOString().slice(0, 10) });
const m = j.metricas.mutacion_puntaje;
console.log(JSON.stringify({ n: m.muestras.length, aportaron: m.aportaron, sin_declarar: j.cobertura.sin_declarar.length }));
' "$REDUCTOR" "$RAIZ/scripts/nightly/dashboard/sources.json" "$T/buzon" > "$T/c.json" 2>"$T/c.err"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d=={'n':4,'aportaron':2,'sin_declarar':1}, d" "$T/c.json" 2>/dev/null \
  && ok "C-54 las 4 muestras de las dos máquinas cuentan (aportaron 2), aunque una no esté declarada" \
  || mal "C-54 $(cat "$T/c.json" "$T/c.err" | head -c 300)"
rm -rf "$T"

# ── C-55 · doscientas mil muestras no tiran la página (2.8 T17 · AC 9, revisión) ──
# 🔴 rojo previo: `Math.min(...muestras)` desborda la pila fuera del try de juntar() → exit 2 y ninguna ficha.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local" "$T/grande"
python3 - "$T/grande/gates.log" "$AYER25" <<'PY2'
import json, sys
with open(sys.argv[1], 'w') as o:
    for i in range(200000):
        o.write(json.dumps({"ts": f"{sys.argv[2]}T10:00:00Z", "name": "mutation", "status": "pass", "killed": i % 13, "total": 12 if i % 13 <= 12 else 13}) + "\n")
PY2
maq_buzon "$T/buzon" maq-grande "$AYER25" "$T/grande"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>"$T/j.err"
RC=$?
MU="$(json_local "$T/j.out" mutacion)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']=='medido' and d['medidos']>=100000, d
" "$MU" 2>/dev/null && [ -f "$T/o.html" ] && [ "$RC" != "2" ] \
  && ok "C-55 con 200 mil muestras la página se escribe y la ficha de mutación está medida (rc=$RC)" \
  || mal "C-55 rc=$RC página=$([ -f "$T/o.html" ] && echo sí || echo no) err=$(head -c 200 "$T/j.err")"
rm -rf "$T"

# ── C-56 · sólo cierres que no necesitaban guía: el motivo no culpa al arnés viejo (2.8 T18 · AC 6, revisión) ──
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_qa "$T/local/gates.log" "$AYER25" no-aplica 2 4
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
QA="$(json_local "$T/j.out" qa_guia)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']!='medido', d
assert 'necesitaba guía' in d['motivo'] and 'actualicen el arnés' not in d['motivo'], d
" "$QA" 2>/dev/null && ok "C-56 con sólo cierres que no aplicaban, el motivo dice que ninguno necesitaba guía" || mal "C-56 qa_guia=$QA"
rm -rf "$T"

# ── C-57 · Tablero_FichaEvidenciaRechazada: con denominador, por hook y con el pie (7.2 T7 · AC 3) ──
# 🔴 rojo previo: sin la métrica ni la ficha, la pregunta 4 no dice cuántas evidencias rechazan los hooks
#    del cierre — el número que decide si el cierre recortado alcanza. Mutación que lo pone rojo: borrar la
#    métrica de sources.json (C-57c) o devolver la ficha como «no medido» siempre.
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local" "$T/remota"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_frenos "$T/local/frenos.jsonl" "$AYER25" on-frontmatter-write evidencia-ausente 6 2 0
reg_frenos "$T/local/frenos.jsonl" "$AYER25" on-pre-commit roster 5 1 0
reg_frenos "$T/local/frenos.jsonl" "$AYER25" safety-guard GIT-C1 4 4 0
reg_gates "$T/remota/gates.log" "$AYER25" tests 10 1
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
maq_buzon "$T/buzon" maq-remota-b "$AYER25" "$T/remota"     # sin frenos.jsonl: declara no_medido
TYCON_MACHINE=maquina-local-l node "$TABLERO" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
EC="$(json_local "$T/j.out" evidencia_cierre)"
FR="$(json_local "$T/j.out" frenos)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1]); f=json.loads(sys.argv[2])
assert d['estado']=='medido', d
assert d['medidos']==3 and d['total']==11, d               # 2 + 1 rechazos de 6 + 5 decisiones: safety-guard no entra
det=d['detalle']
assert 'on-frontmatter-write: rechazó 2 de 6' in det and 'on-pre-commit: rechazó 1 de 5' in det, det
assert 'midieron 1 de 2' in det, det                        # la máquina sin registro no suma un cero
assert 'on-' not in f['detalle'], f                         # los hooks del cierre no se mezclan en la ficha de la 2.6
" "$EC" "$FR" 2>/dev/null \
  && ok "C-57 la ficha cuenta 3 rechazos de 11 decisiones, por hook, sin mezclarse con los frenos previos" || mal "C-57 evidencia=$EC frenos=$FR"
grep -q 'es el número que dice si el cierre mínimo alcanza' "$T/o.html" \
  && ok "C-57b la ficha lleva el pie que explica para qué existe el número" || mal "C-57b falta el pie de la ficha"
rm -rf "$T"

# ── C-57c · sin la métrica declarada la ficha sale «no medido» con motivo, nunca 0 (7.2 T7 · AC 3, 12) ──
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/local"
reg_gates "$T/local/gates.log" "$AYER25" tests 10 1
reg_frenos "$T/local/frenos.jsonl" "$AYER25" on-pre-commit roster 5 1 0
maq_buzon "$T/buzon" maquina-local-l "$AYER25" "$T/local"
cp -R "$RAIZ/scripts" "$T/copia-scripts"
python3 - "$T/copia-scripts/nightly/dashboard/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['reducer']['metrics'].pop('evidencia_rechazada_por_hook', None); json.dump(d,open(p,'w'),ensure_ascii=False)
PY2
TYCON_MACHINE=maquina-local-l node "$T/copia-scripts/nightly/dashboard/dashboard.js" --dir "$T" --logs "$T/local" --mailbox "$T/buzon" --output "$T/o.html" --json > "$T/j.out" 2>/dev/null
EC="$(json_local "$T/j.out" evidencia_cierre)"
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
assert d['estado']!='medido' and 'no declara' in d['motivo'], d
" "$EC" 2>/dev/null && ok "C-57c sin la métrica declarada: «no medido» con motivo" || mal "C-57c evidencia=$EC"
rm -rf "$T"

# ── C-58 · las exentas por declaración se dicen al lado de la ficha de evidencia, con su número ──
# Caso (2026-09-18): el medidor sacó las exentas del cociente. Si el tablero no las nombra, el día del
# cambio la ficha salta y nadie sabe si fueron stories que ganaron prueba o un cambio de conteo.
# 🔴 rojo previo: sacar el bloque `m.dod.detalle` de mejora() en dashboard.js.
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,glob,os
T=sys.argv[1]; f=glob.glob(os.path.join(T,'sdlc-stage-*.json'))[0]
d=json.load(open(f)); d['global']['dod_evidence_ratio']={"num":80,"den":400,"exentas":49}; json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
F="$(ficha_html "$T/o.html" 'Cierres que dejaron prueba')"
echo "$F" | grep '<div class="t-val">20%</div>' >/dev/null && ok "C-58 la ficha sigue midiendo sólo lo probado (80 de 400)" || mal "C-58 el porcentaje no es 80/400"
echo "$F" | grep "49 cerradas con exención declarada" >/dev/null && ok "C-58 nombra las 49 exentas al lado" || mal "C-58 las exentas no aparecen en la ficha"
rm -rf "$T"
# y sin exentas no inventa la línea
T=$(mktemp -d); montar_sano "$T"
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
ficha_html "$T/o.html" 'Cierres que dejaron prueba' | grep "exención declarada" >/dev/null && mal "C-58b dijo exentas donde no hay" || ok "C-58b sin exentas, no aparece la línea"
rm -rf "$T"

# ═══════════════ story 7.12 · los pasos de una corrida, como ficha de la pregunta 4 ═══════════════
# Un buzón de mentira: 4 corridas con consumo medido (100/300/500/700 pasos) y 1 sin medir, fechadas en
# los últimos días — la fuente declara una antigüedad máxima, así que un fixture con fechas fijas se
# pondría gris solo con el paso del tiempo.
buzon_de_mentira() {
  python3 - "$1" <<'PY2'
import json, os, sys
from datetime import datetime, timezone, timedelta
b = os.path.join(sys.argv[1], 'maquina-1'); os.makedirs(b, exist_ok=True)
hoy = datetime.now(timezone.utc)
for i, (dias, pasos) in enumerate([(12, 100), (9, 300), (6, 500), (3, 700), (1, None)]):
    d = (hoy - timedelta(days=dias)).strftime('%Y-%m-%d')
    consumo = {"estado": "medido", "respuestas": pasos, "tokens": {"in": 1, "out": 2, "cache_new": 3, "cache_read": pasos * 1000}} if pasos else {"estado": "borrada", "motivo": "la conversación ya no está"}
    json.dump({"archivedAt": d + "T10:00:00.000Z", "marker": {"storyId": "1.%d" % i, "repoPath": "/tmp/repo-falso", "startedAt": d + "T04:00:00.000Z"}, "consumo": consumo},
              open(os.path.join(b, "1.%d-%s.json" % (i, d)), 'w'))
PY2
}

# ── C-59 · 7.12-T3 SeisPreguntas_TieneSuFicha (AC 3) @story-7.12 @ac-3 ──
# 🔴 rojo previo: no conectar el medidor → la ficha no existe; o conectarlo sin denominador ni fecha.
T=$(mktemp -d); montar_sano "$T"; buzon_de_mentira "$T/buzon"
node "$TABLERO" --dir "$T" --mailbox "$T/buzon" --output "$T/o.html" >/dev/null 2>&1
F="$(ficha_html "$T/o.html" 'Pasos de una corrida')"
[ -n "$F" ] && ok "C-59 la ficha de pasos por corrida existe" || mal "C-59 la ficha de pasos por corrida no está en la página"
echo "$F" | grep '<div class="t-val">400</div>' >/dev/null && ok "C-59 con la mediana de las medidas (400)" || mal "C-59 la mediana no es 400: ${F:0:200}"
echo "$F" | grep 'n=4 de 5 corridas' >/dev/null && ok "C-59 con su denominador al lado (n=4 de 5: la sin medir sigue contando)" || mal "C-59 falta el denominador n=4 de 5"
echo "$F" | grep "$(fecha_hace 3)" >/dev/null && ok "C-59 con la fecha de la corrida medida más nueva" || mal "C-59 la ficha no trae su fecha"
echo "$F" | grep '1 sin consumo medido' >/dev/null && ok "C-59 y dice la que quedó sin medir (AC 2)" || mal "C-59 no dice la corrida sin medir"
# va al lado de la ficha de la duración de una corrida: son la misma pregunta
python3 - "$T/o.html" <<'PY2' && ok "C-59 la ficha vive en la pregunta 4, pegada a la duración de una corrida" || mal "C-59 la ficha no está al lado de «Una corrida del pipeline, de punta a punta»"
import sys
t = open(sys.argv[1], encoding='utf8').read().split('<div class="tile ')[1:]
i = [k for k, x in enumerate(t) if 'Pasos de una corrida' in x[:600]]
j = [k for k, x in enumerate(t) if 'Una corrida del pipeline, de punta a punta' in x[:600]]
assert i and j and abs(i[0] - j[0]) == 1, (i, j)
PY2
rm -rf "$T"

# ── C-59b · 7.12-T5 BuzonVacioNoEsCero, en la página (AC 5) @story-7.12 @ac-5 ──
# 🔴 rojo previo: `medida(r.pasos.mediana || 0, …)` → un buzón vacío publica «0».
T=$(mktemp -d); montar_sano "$T"; mkdir -p "$T/buzon"
node "$TABLERO" --dir "$T" --mailbox "$T/buzon" --output "$T/o.html" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && ok "C-59b con el buzón vacío el tablero mide igual (exit 0): la fuente no es obligatoria" || mal "C-59b el buzón vacío rompió el tablero (exit $RC)"
[ "$(ficha_estado "$T/o.html" 'Pasos de una corrida')" = "blind" ] && ok "C-59b buzón vacío → la ficha sale con trama" || mal "C-59b buzón vacío y la ficha no salió «no medido»"
F="$(ficha_html "$T/o.html" 'Pasos de una corrida')"
echo "$F" | grep 'buzón' >/dev/null && ok "C-59b con su motivo" || mal "C-59b sin motivo: ${F:0:200}"
echo "$F" | grep '<div class="t-val">0' >/dev/null && mal "C-59b publicó un cero" || ok "C-59b ningún cero publicado"
rm -rf "$T"

# ── C-60 · una noche de suites INCOMPLETA no se dibuja como un número (2026-10-04) ──
# Las suites del nocturno corren en trabajos paralelos. Si uno no termina, sus suites quedan en `failures` como no
# medidas y `corridas` sólo cuenta las que corrieron: «108 de 109 suites», con el denominador encogido. El reporte lo
# declara (`complete: false`, `unmeasured`), y el tablero trata a esa noche como a una corrida incompleta de
# dependencias: trama y motivo, nunca un número.
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,os,glob
f=glob.glob(os.path.join(sys.argv[1],'controls-bench','suites-*.json'))[0]
d=json.load(open(f)); u=['lab-%d.test.sh(no-medida)' % i for i in range(108)]
d.update(corridas=109, failures=u, unmeasured=u, complete=False); json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
[ "$(ficha_estado "$T/o.html" 'Suites del arnés en rojo')" = "blind" ] && ok "C-60 una noche de suites incompleta sale con trama, no con un número" || mal "C-60 la noche incompleta se dibujó como medida ($(ficha_estado "$T/o.html" 'Suites del arnés en rojo'))"
F="$(ficha_html "$T/o.html" 'Suites del arnés en rojo')"
echo "$F" | grep '108 suites sin medir' >/dev/null && ok "C-60 con su motivo y la cuenta" || mal "C-60 sin motivo: ${F:0:300}"
echo "$F" | grep '<div class="t-val">108' >/dev/null && mal "C-60 publicó 108 como si fueran rojas" || ok "C-60 las no medidas no se publican como rojas"
rm -rf "$T"
# el espejo: con `complete: true` (o sin el campo, una foto de antes) la ficha se mide como siempre
T=$(mktemp -d); montar_sano "$T"
python3 - "$T" <<'PY'
import json,sys,os,glob
f=glob.glob(os.path.join(sys.argv[1],'controls-bench','suites-*.json'))[0]
d=json.load(open(f)); d.update(failures=['a.test.sh','b.test.sh'], unmeasured=[], complete=True); json.dump(d,open(f,'w'))
PY
node "$TABLERO" --dir "$T" --output "$T/o.html" >/dev/null 2>&1
F="$(ficha_html "$T/o.html" 'Suites del arnés en rojo')"
echo "$F" | grep '<div class="t-val">2</div>' >/dev/null && ok "C-60b una noche entera con dos rojas se mide como siempre" || mal "C-60b la noche entera no se midió: ${F:0:300}"
rm -rf "$T"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
