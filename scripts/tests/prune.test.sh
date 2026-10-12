#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO: HOME falso antes de cualquier línea que ejecute algo. El cruce lee
#    ~/.claude/.tycon-pipeline/ (hallazgos, volcados de corridas, carpeta bajada del buzón): sin esta
#    línea mezclaría el material real de la máquina con el de los casos.
HOME="$(mktemp -d)"; export HOME
#
# prune.test.sh — el cruce hallazgos × oportunidades × banco, y los siete estados (story 2.9).
#
# 🔴 LA PRECEDENCIA (y por qué no es la que la story escribió primero):
#      sin_revisor → rota → revision_humana → activa → sin_examinar → candidata_a_retiro
#      → sin_oportunidades_suficientes
#    El banco sólo hace falta para juzgar reglas que NUNCA encontraron nada: una regla con hallazgos
#    reales ya demostró que detecta, y una rota o que grita en falso tiene que verse aunque el banco
#    no la haya examinado. Con `sin_examinar` antes de `rota`, la única regla rota medida hoy
#    (una del paquete de clientes, con un caso «no debe marcar» que falló) quedaba escondida.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito su rojo previo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PODA="${RAIZ}/scripts/nightly/dashboard/prune.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== prune.test.sh =="
[ -f "${PODA}" ] || { mal "no existe ${PODA} (rojo previo: el cruce todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_FINDINGS_OUTPUT TYCON_MAILBOX_DIR TYCON_TODAY TYCON_SOURCES_JSON TYCON_CATALOG TYCON_REVIEWERS_DIR \
      TYCON_HISTORY_DIR TYCON_CASES_DIR TYCON_EXAM

HOY="2026-09-16"
MAQ_LOCAL="mac-de-mengana"   # nombre con persona, a propósito: nunca puede salir crudo

# ── andamios ────────────────────────────────────────────────────────────────────────────────────
# El escenario base: dos revisores y un freno de mano; SIETE pares, uno por estado.
#   adv-a (revisor, lanzado 30 veces en 3 meses): R-C1 activa · R-C2 candidata · R-C3 sin_examinar
#                                                  R-C4 rota · R-C5 revision_humana
#   adv-b (revisor, lanzado 7 veces):              B-C1 sin_oportunidades_suficientes
#   freno (NO es revisor):                         F-C1 sin_revisor
catalogo() {
  cat > "$1" <<'MD'
# Catálogo

## Revisor A — `adv-a`

| Regla | Qué | Fix |
|---|---|---|
| **R-C1** | a | a |
| **R-C2** | b | b |
| **R-C3** | c | c |
| **R-C4** | d | d |
| **R-C5** | e | e |

## Revisor B — `adv-b`

| Regla | Qué | Fix |
|---|---|---|
| **B-C1** | f | f |

## Freno — `freno.sh`

| Regla | Qué | Fix |
|---|---|---|
| **F-C1** | g | g |
MD
}
roster() { mkdir -p "$1"; printf 'name = "adv-a"\n' > "$1/adv-a.toml"; printf 'name = "adv-b"\n' > "$1/adv-b.toml"; }
fuentes() {                # $1 = archivo ; $2 = umbral de oportunidades ; $3 = umbral de meses
  cat > "$1" <<JSON
{
  "sources": [],
  "prune": {
    "window_days": 120,
    "threshold_opportunities": ${2:-20},
    "threshold_months": ${3:-2},
    "floor": 1,
    "floor_reason": "en la tabla por regla, 1 hallazgo y 0 hallazgos son la diferencia entre dejarla y retirarla",
    "not_reviewers": ["general-purpose", "Explore", "claude-code-guide"],
    "exam_max_days": 8,
    "min_refuted": 3,
    "vocabularies": { "severity": ["CRITICAL", "WARNING"], "disposition": ["fixed", "open", "deferred", "waived", "refuted"] },
    "max_findings_days": 3
  }
}
JSON
}
casos() {                  # $1 = dir
  mkdir -p "$1"
  cat > "$1/adv-a.json" <<'JSON'
{"advisor":"adv-a","cases":[
  {"id":"r-c1-rojo","type":"must-flag","rule":"R-C1"},
  {"id":"r-c2-rojo","type":"must-flag","rule":"R-C2"},
  {"id":"r-c4-limpio","type":"must-not-flag","rule":"R-C4"},
  {"id":"r-c5-rojo","type":"must-flag","rule":"R-C5"}
]}
JSON
  cat > "$1/adv-b.json" <<'JSON'
{"advisor":"adv-b","cases":[{"id":"b-c1-rojo","type":"must-flag","rule":"B-C1"}]}
JSON
}
examen() {                 # $1 = archivo ; $2 = ts ; $3 = alcance
  cat > "$1" <<JSON
{"alcance":"${3:-completo}","only":[],"ts":"${2:-2026-09-15T05:00:00Z}","tool":"claude","runs":1,"estado":"completo",
 "results":{
  "adv-a::r-c1-rojo":{"type":"must-flag","rule":"R-C1","tools":{"claude":{"pass":true,"clase":"ok"}}},
  "adv-a::r-c2-rojo":{"type":"must-flag","rule":"R-C2","tools":{"claude":{"pass":true,"clase":"ok"}}},
  "adv-a::r-c4-limpio":{"type":"must-not-flag","rule":"R-C4","tools":{"claude":{"pass":false,"clase":"criterio"}}},
  "adv-a::r-c5-rojo":{"type":"must-flag","rule":"R-C5","tools":{"claude":{"pass":true,"clase":"ok"}}},
  "adv-b::b-c1-rojo":{"type":"must-flag","rule":"B-C1","tools":{"claude":{"pass":true,"clase":"ok"}}}
 }}
JSON
}
volcado() {                # $1 = dir ; $2 = nombre ; $3 = fecha ISO ; $4 = por_tipo JSON ; $5 = estado ; $6 = sesión
  mkdir -p "$1"
  cat > "$1/$2.json" <<JSON
{"archivedAt":"$3","marker":{"storyId":"x","sessionId":"${6:-sesion-$2}","repoPath":"/Users/fulano/SourceCode/ClienteSecreto","startedAt":"$3",
  "filesTouched":["/Users/fulano/SourceCode/ClienteSecreto/src/Clave.cs"]},
 "revisores":{"estado":"${5:-medido}","por_tipo":$4}}
JSON
}
historia_base() {          # $1 = dir — adv-a 30 veces en jul/ago/sep, adv-b 7 veces, y dos que NO son revisores
  local i
  for i in $(seq 1 10); do volcado "$1" "a-jul-${i}" "2026-07-1${i:0:1}T10:00:00Z" '{"adv-a":1}'; done
  for i in $(seq 1 10); do volcado "$1" "a-ago-${i}" "2026-08-1${i:0:1}T10:00:00Z" '{"adv-a":1,"general-purpose":4}'; done
  for i in $(seq 1 10); do volcado "$1" "a-sep-${i}" "2026-09-0${i:0:1}T10:00:00Z" '{"adv-a":1,"Explore":2}'; done
  volcado "$1" "b-1" "2026-09-10T10:00:00Z" '{"adv-b":7,"claude-code-guide":1}'
}
sello() {                  # $1 = archivo de la serie ; $2 = fecha — el sello que deja el recolector cuando midió
  # Los dos conteos se toman de la serie: el recolector los escribe iguales, y si no coinciden no está medida.
  python3 - "$1" "$2" <<'PY'
import json, os, sys
serie, fecha = sys.argv[1:3]
# el nombre del sello, como lo arma el recolector (selloDe): la serie hallazgos.jsonl lleva findings-seal.json
def sello_de(s):
    if os.path.basename(s) == 'hallazgos.jsonl': return os.path.join(os.path.dirname(s), 'findings-seal.json')
    return s[:-len('.jsonl')] + '-seal.json'
h = v = 0
for l in open(serie):
    l = l.strip()
    if not l: continue
    try: o = json.loads(l)
    except Exception: continue
    if 'volcado' in o: v += 1
    else: h += 1
json.dump({"estado": "recolectado", "fecha": fecha, "repos": 2, "run_dirs": 8, "hallazgos": h,
           "sin_evidencia": 1, "baldes": {"con_hallazgos": 8}, "volcados": {"leidos": v, "medidos": v}},
          open(sello_de(serie), 'w'))
PY
}
leidos() {                 # $1 = archivo de la serie ; resto = nombres de volcado cuya corrida se leyó
  local f="$1"; shift
  local n; for n in "$@"; do printf '{"volcado":"%s.json","medida":"con_hallazgos"}\n' "${n}" >> "${f}"; done
}
leidos_base() {            # $1 = archivo — los 31 volcados de historia_base
  local i nombres=""
  for i in $(seq 1 10); do nombres="${nombres} a-jul-${i} a-ago-${i} a-sep-${i}"; done
  # shellcheck disable=SC2086
  leidos "$1" ${nombres} b-1
}
hallazgos_base() {         # $1 = archivo
  cat > "$1" <<'JSONL'
{"ts":"2026-08-10T10:00:00Z","corrida":"c-000000000a01","regla":"R-C1","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}
{"ts":"2026-08-11T10:00:00Z","corrida":"c-000000000a02","regla":"R-C1","dueno":"adv-a","severidad":"CRITICAL","disposicion":"fixed"}
{"ts":"2026-08-12T10:00:00Z","corrida":"c-000000000a03","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-13T10:00:00Z","corrida":"c-000000000a04","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-14T10:00:00Z","corrida":"c-000000000a05","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-15T10:00:00Z","corrida":"c-000000000a06","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-16T10:00:00Z","corrida":"c-000000000a07","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-17T10:00:00Z","corrida":"c-000000000a08","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}
JSONL
  leidos_base "$1"
  sello "$1" "2026-09-16"
}
escenario() {              # $1 = nombre → arma el caso completo e imprime su ruta
  local C="${BASE}/$1"; mkdir -p "${C}"
  catalogo "${C}/catalogo.md"; roster "${C}/revisores"; fuentes "${C}/sources.json"
  casos "${C}/casos"; examen "${C}/examen.json"; historia_base "${C}/historia"; hallazgos_base "${C}/hallazgos.jsonl"
  mkdir -p "${C}/buzon"
  echo "${C}"
}
podar() {                  # $1 = caso ; resto = args → RC ; salida en ${OUT}/${ERR}
  local C="$1"; shift
  OUT="${C}/out"; ERR="${C}/err"
  node "${PODA}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --sources "${C}/sources.json" \
    --cases "${C}/casos" --exam "${C}/examen.json" --history "${C}/historia" \
    --findings "${C}/hallazgos.jsonl" --mailbox "${C}/buzon" --machine "${MAQ_LOCAL}" --today "${HOY}" --json "$@" > "${OUT}" 2> "${ERR}"
}
q() { python3 -c "
import json
d=json.load(open('${OUT}'))
print($1)" 2>/dev/null; }
estado_de() { q "next((f['estado'] for f in d['filas'] if f['regla']=='$1'), 'AUSENTE')"; }

# ── T18 · siete estados, cada regla en el suyo, y la suma cierra ─────────────────────────────────
C="$(escenario t18)"
podar "${C}"; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T18 el cruce salió ${RC} sobre el escenario base (stderr: $(head -c 300 "${ERR}"))"
else
  for par in "R-C1:activa" "R-C2:candidata_a_retiro" "R-C3:sin_examinar" "R-C4:rota" \
             "R-C5:revision_humana" "B-C1:sin_oportunidades_suficientes" "F-C1:sin_revisor"; do
    r="${par%%:*}"; e="${par##*:}"; got="$(estado_de "${r}")"
    [ "${got}" = "${e}" ] && ok "T18 ${r} → ${e}" \
      || mal "T18 ${r} → ${got}, esperaba ${e}"
  done
  TOT="$(q "d['total']")"; SUM="$(q "sum(d['resumen'].values())")"
  [ "${TOT}" = "7" ] && [ "${SUM}" = "7" ] && ok "T18 la suma de los siete estados es el total (7)" \
    || mal "T18 total=${TOT} suma=${SUM}, esperaba 7 y 7"
  B="$(estado_de B-C1)"
  [ "${B}" != "candidata_a_retiro" ] && ok "T18 🔴 una regla examinada con 7 oportunidades NUNCA sale candidata" \
    || mal "T18 🔴 B-C1 (7 oportunidades) salió candidata — rojo previo: con dos cubetas, la regla que nadie tuvo ocasión de probar se marca para retiro"
  ADV="$(q "next(f['sabe_ponerse_roja'] for f in d['filas'] if f['regla']=='R-C2')")"
  [ "${ADV}" = "True" ] && ok "T18 toda candidata lleva la advertencia «sabe ponerse roja»" \
    || mal "T18 la candidata no lleva la advertencia — retirarla pierde disuasión y la persona que decide tiene que saberlo"
fi

# ── T11 · el denominador sale del archivo histórico, y los no-revisores no suman ──────────────────
C="$(escenario t11)"
mkdir -p "${HOME}/.claude/.tycon-pipeline/advisor-runs"
printf '{"subagent_type":"adv-a"}\n' > "${HOME}/.claude/.tycon-pipeline/advisor-runs/s.jsonl"   # otra cifra, a propósito
podar "${C}"; RC=$?
OPP_A="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${OPP_A}" = "30" ] && ok "T11 las oportunidades de adv-a salen de los volcados (30)" \
  || mal "T11 oportunidades=${OPP_A}, esperaba 30 — rojo previo: leer advisor-runs/ (se borra a los 7 días) da 1"
if grep -qE 'general-purpose|Explore|claude-code-guide' "${OUT}"; then
  mal "T11 un lanzamiento que no es revisión apareció en la salida — rojo previo: sumarlos infla el denominador de nadie y ensucia la tabla"
else
  ok "T11 general-purpose, Explore y claude-code-guide no aparecen"
fi
NR="$(q "d['cobertura']['corridas']['lanzamientos_no_revision']")"
[ "${NR}" = "61" ] && ok "T11 los lanzamientos que no son revisión se descartan Y se cuentan (61)" \
  || mal "T11 lanzamientos_no_revision=${NR}, esperaba 61 (40 general-purpose + 20 Explore + 1 claude-code-guide) — rojo previo: sin contarlos, el filtro no tiene efecto visible y un test no distingue «filtra» de «no filtra»"
if grep -qE 'fulano|ClienteSecreto|Clave\.cs' "${OUT}" "${ERR}"; then
  mal "T11 🔴 FUGA: algo del volcado además del conteo llegó a la salida (rutas, nombre de cliente)"
else
  ok "T11 del volcado sólo sale el conteo: ni rutas ni nombres"
fi

# ── T12 · un volcado sin conteo NO aporta cero oportunidades ─────────────────────────────────────
C="$(escenario t12)"
volcado "${C}/historia" "sin-conteo-1" "2026-09-11T10:00:00Z" 'null' 'no_medido'
volcado "${C}/historia" "sin-conteo-2" "2026-09-12T10:00:00Z" 'null' 'borrada'
volcado "${C}/historia" "sin-conteo-3" "2026-09-13T10:00:00Z" '{}' 'parcial'
leidos "${C}/hallazgos.jsonl" sin-conteo-1 sin-conteo-2 sin-conteo-3; sello "${C}/hallazgos.jsonl" "2026-09-16"
podar "${C}"; RC=$?
CON="$(q "d['cobertura']['corridas']['con_denominador']")"; TOTC="$(q "d['cobertura']['corridas']['total']")"
[ "${CON}" = "31" ] && [ "${TOTC}" = "34" ] && ok "T12 el denominador sale de 31 de 34 corridas, y se dice" \
  || mal "T12 con_denominador=${CON} total=${TOTC}, esperaba 31 de 34 — rojo previo: contarlas como 0 oportunidades mezcla «no medí» con «no corrió»"
OPP_A="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${OPP_A}" = "30" ] && ok "T12 y las oportunidades no cambian por los volcados sin conteo" \
  || mal "T12 oportunidades=${OPP_A}, esperaba 30"

# ── T13 · oportunidades por DUEÑO, y una cita no suma ────────────────────────────────────────────
C="$(escenario t13)"
podar "${C}"; RC=$?
for r in R-C1 R-C2 R-C3 R-C4 R-C5; do
  v="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='${r}')")"
  [ "${v}" = "30" ] || { mal "T13 ${r} tiene ${v} oportunidades, esperaba 30 (todas las reglas de adv-a comparten los lanzamientos de adv-a)"; continue; }
done
[ "$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C3')")" = "30" ] \
  && ok "T13 cada regla de adv-a suma los 30 lanzamientos de su dueño" || true
[ "$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='B-C1')")" = "7" ] \
  && ok "T13 y las de adv-b, los 7 de adv-b" || mal "T13 B-C1 no tiene 7 oportunidades"
FNULL="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='F-C1')")"
[ "${FNULL}" = "None" ] && ok "T13 una regla sin revisor no tiene denominador (null, no 0)" \
  || mal "T13 F-C1 oportunidades=${FNULL}, esperaba null — rojo previo: un 0 acá se lee como «nunca tuvo chance» cuando la verdad es «no aplica»"

# ── T14 · las oportunidades se cuentan AUNQUE no haya hallazgos ───────────────────────────────────
C="$(escenario t14)"
: > "${C}/hallazgos.jsonl"   # cero hallazgos en todo el material…
leidos_base "${C}/hallazgos.jsonl"
sello "${C}/hallazgos.jsonl" "2026-09-16"   # …pero MEDIDOS: el recolector corrió y no encontró nada
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${V}" = "30" ] && ok "T14 con cero hallazgos las 30 oportunidades se cuentan igual" \
  || mal "T14 oportunidades=${V}, esperaba 30 — rojo previo: contar oportunidades sólo donde hubo hallazgo deja el denominador en 0 y ninguna regla llega nunca al umbral"
E="$(estado_de R-C2)"
[ "${E}" = "candidata_a_retiro" ] && ok "T14 y la regla examinada llega al umbral (candidata)" \
  || mal "T14 R-C2=${E}, esperaba candidata_a_retiro"

# ── T15 · la misma ventana para las dos puntas ───────────────────────────────────────────────────
C="$(escenario t15)"
# hallazgos y volcados de hace 200 días: fuera de la ventana de 120 → no cuentan NINGUNO de los dos
cat >> "${C}/hallazgos.jsonl" <<'JSONL'
{"ts":"2026-02-20T10:00:00Z","corrida":"c-0000000000b1","regla":"R-C2","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}
JSONL
leidos "${C}/hallazgos.jsonl" viejo; sello "${C}/hallazgos.jsonl" "2026-09-16"
volcado "${C}/historia" "viejo" "2026-02-20T10:00:00Z" '{"adv-a":500}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
H="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${V}" = "30" ] && [ "${H}" = "0" ] && ok "T15 lo de fuera de la ventana no cuenta en NINGUNA de las dos puntas" \
  || mal "T15 oportunidades=${V} hallazgos=${H}, esperaba 30 y 0 — rojo previo: recortar sólo una punta mezcla tres meses con un día"
DES="$(q "d['ventana']['desde']")"; HAS="$(q "d['ventana']['hasta']")"
[ -n "${DES}" ] && [ "${DES}" != "None" ] && [ -n "${HAS}" ] && ok "T15 la ventana se publica (${DES} → ${HAS})" \
  || mal "T15 la ventana no se publica — el rótulo tiene que decir de qué período son los números"
FV="$(q "d['cobertura']['fuera_de_ventana']['hallazgos']")"
[ "${FV}" = "1" ] && ok "T15 lo que quedó afuera se cuenta, no desaparece" || mal "T15 fuera_de_ventana.hallazgos=${FV}, esperaba 1"
# ventana declarada ilegible → se niega
C2="$(escenario t15b)"
python3 - "${C2}/sources.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['prune']['window_days']='mucho'; json.dump(d,open(p,'w'))
PY
podar "${C2}"; RC=$?
[ "${RC}" = "2" ] && ok "T15 una ventana ilegible → exit 2" \
  || mal "T15 ventana ilegible salió ${RC}, esperaba 2 — sin ventana no se pueden igualar las dos puntas"

# ── T16 · el piso de 3 NO borra la señal ─────────────────────────────────────────────────────────
C="$(escenario t16)"
python3 - "${C}/sources.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['prune']['floor']=1; json.dump(d,open(p,'w'))
PY
cat > "${C}/hallazgos.jsonl" <<'JSONL'
{"ts":"2026-08-10T10:00:00Z","corrida":"c-0000000000c1","regla":"R-C2","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}
{"ts":"2026-08-11T10:00:00Z","corrida":"c-0000000000c2","regla":"R-C2","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}
JSONL
leidos_base "${C}/hallazgos.jsonl"; sello "${C}/hallazgos.jsonl" "2026-09-16"
podar "${C}"; RC=$?
E="$(estado_de R-C2)"
[ "${E}" = "activa" ] && ok "T16 una regla con 2 hallazgos es activa, no candidata" \
  || mal "T16 R-C2 con 2 hallazgos → ${E} — rojo previo: con el piso general de 3 sale «no medido», el cruce la lee como 0 y la marca candidata"
C2="$(escenario t16b)"
python3 - "${C2}/sources.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['prune']['floor']=3; json.dump(d,open(p,'w'))
PY
podar "${C2}"; RC=$?
[ "${RC}" = "2" ] && ok "T16 un piso mayor que 1 declarado para la tabla → se niega" \
  || mal "T16 piso=3 salió ${RC}, esperaba 2 — el piso de la tabla por regla es 1 y está escrito con su motivo"

# ── T17 · el umbral tiene que estar declarado ────────────────────────────────────────────────────
for malo in 'null' '0' '"veinte"'; do
  C="$(escenario "t17-${malo//[^a-z0-9]/}")"
  python3 - "${C}/sources.json" "${malo}" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['prune']['threshold_opportunities']=json.loads(sys.argv[2]); json.dump(d,open(p,'w'))
PY
  podar "${C}"; RC=$?
  if [ "${RC}" = "2" ] && grep -q 'threshold_opportunities' "${ERR}"; then
    ok "T17 umbral ${malo} → exit 2 nombrando la clave"
  else
    mal "T17 umbral ${malo} salió ${RC} — rojo previo: un umbral por defecto en el código deja de estar commiteado antes de mirar el resultado"
  fi
done

# ── T19 · caso rojo = must-flag; results es un objeto; una regla con un caso que falla es rota ────
C="$(escenario t19)"
podar "${C}"; RC=$?
[ "${RC}" = "0" ] && ok "T19 results como OBJETO se recorre sin tirar" \
  || mal "T19 salió ${RC} — rojo previo: `for (const r of results)` sobre un objeto tira"
[ "$(estado_de R-C4)" = "rota" ] && ok "T19 R-C4 (su caso «no debe marcar» falló) es rota" \
  || mal "T19 R-C4=$(estado_de R-C4) — rojo previo: con sin_examinar antes que rota, la única regla rota medida hoy queda escondida"
CONCASO="$(q "d['cobertura']['banco']['con_caso']")"
[ "${CONCASO}" = "4" ] && ok "T19 «con caso» cuenta sólo los must-flag (4: R-C1, R-C2, R-C5, B-C1)" \
  || mal "T19 con_caso=${CONCASO}, esperaba 4 — rojo previo: contar cualquier tipo de caso mete el must-not-flag de R-C4, que prueba lo contrario"
# un caso con resultado NULO no es examinado
C2="$(escenario t19b)"
python3 - "${C2}/examen.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['results']['adv-a::r-c2-rojo']['tools']['claude']['pass']=None; json.dump(d,open(p,'w'))
PY
podar "${C2}"; RC=$?
E="$(estado_de R-C2)"
[ "${E}" = "sin_examinar" ] && ok "T19 un caso con resultado nulo NO cuenta como examinado (constancia, no verde)" \
  || mal "T19 R-C2 con resultado nulo → ${E}, esperaba sin_examinar — rojo previo: tratar null como pasó la marca candidata sin haberla probado"
# un caso cuya regla no está en el catálogo: huérfano, contado y no repartido
C3="$(escenario t19c)"
python3 - "${C3}/casos/adv-b.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['cases'].append({"id":"x","type":"must-flag","rule":"R-C2"}); json.dump(d,open(p,'w'))
PY
podar "${C3}"; RC=$?
HU="$(q "d['cobertura']['banco']['huerfanos']")"
[ "${HU}" = "1" ] && ok "T19 un caso de adv-b sobre una regla de adv-a es huérfano, y se cuenta" \
  || mal "T19 huerfanos=${HU}, esperaba 1 — rojo previo: acreditarlo cruzando dueños vuelve a fusionar SEC-C1"

# ── T20 · el reporte del examen tiene su modo de falla ───────────────────────────────────────────
for variante in ausente parcial viejo; do
  C="$(escenario "t20-${variante}")"
  case "${variante}" in
    ausente) rm -f "${C}/examen.json" ;;
    parcial) examen "${C}/examen.json" "2026-09-15T05:00:00Z" "parcial" ;;
    viejo)   examen "${C}/examen.json" "2026-08-27T05:00:00Z" "completo" ;;
  esac
  podar "${C}"; RC=$?
  if [ "${RC}" -ne 0 ]; then
    mal "T20 ${variante}: salió ${RC} — el cruce se publica igual, con el examen como no medido"
    continue
  fi
  EX="$(q "d['cobertura']['banco']['examinadas']")"
  CAND="$(q "d['resumen'].get('candidata_a_retiro',0)")"
  MOT="$(q "d['cobertura']['examen'].get('motivo','')")"
  if [ "${EX}" = "None" ] && [ "${CAND}" = "0" ] && [ -n "${MOT}" ]; then
    ok "T20 examen ${variante} → «examinadas» no medido (null), CERO candidatas, y el motivo"
  else
    mal "T20 examen ${variante} → examinadas=${EX} candidatas=${CAND} motivo='${MOT}' — rojo previo: sin la guarda salen 7 «sin examinar» y la tabla se publica como si fuera una medición"
  fi
done

# ── T21 · los refutados no retiran ───────────────────────────────────────────────────────────────
C="$(escenario t21)"
podar "${C}"; RC=$?
E="$(estado_de R-C5)"
[ "${E}" = "revision_humana" ] && ok "T21 R-C5 (5 refutados de 6) → revisión humana" \
  || mal "T21 R-C5=${E} — rojo previo: ignorar la disposición la deja activa y nadie se entera de que grita en falso"
[ "${E}" != "candidata_a_retiro" ] && ok "T21 nunca candidata a retiro" || mal "T21 R-C5 salió candidata"
# y con menos del mínimo de refutados no alcanza: 2 refutados de 2 sigue activa
C2="$(escenario t21b)"
cat > "${C2}/hallazgos.jsonl" <<'JSONL'
{"ts":"2026-08-12T10:00:00Z","corrida":"c-0000000000d1","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
{"ts":"2026-08-13T10:00:00Z","corrida":"c-0000000000d2","regla":"R-C5","dueno":"adv-a","severidad":"WARNING","disposicion":"refuted"}
JSONL
leidos_base "${C2}/hallazgos.jsonl"; sello "${C2}/hallazgos.jsonl" "2026-09-16"
podar "${C2}"; RC=$?
[ "$(estado_de R-C5)" = "activa" ] && ok "T21 con 2 refutados (menos que el mínimo declarado) sigue activa" \
  || mal "T21 R-C5 con 2 refutados → $(estado_de R-C5) — un solo par de refutados no es una tendencia"

# ════════════════════════ vuelta 2 — lo que encontraron los revisores y el pase adversarial ════════
# Máquina del buzón: $1 = caso ; $2 = nombre ; $3 = fecha de su cobertura ; $4 = estado de hallazgos
#                    $5 = líneas de hallazgos (jsonl) ; $6 = resumen del recolector (JSON)
maquina_buzon() {
  local D="$1/buzon/$2/registros" R="${6:-}"; mkdir -p "${D}"
  [ -n "${R}" ] || R='{}'
  printf '%s\n' "$5" | gzip -c > "${D}/hallazgos.jsonl.gz"
  # la cobertura declara la fecha de la serie y sus dos conteos (tomados de las líneas, como el recolector)
  python3 - "${D}/cobertura.json" "$3" "$4" "${R}" "$5" <<'PY'
import json, sys
dest, fecha, estado, extra, lineas = sys.argv[1:6]
h = v = 0
for l in lineas.splitlines():
    try: o = json.loads(l)
    except Exception: continue
    if 'volcado' in o: v += 1
    elif 'regla' in o: h += 1
resumen = {"hallazgos": h, "volcados": {"medidos": v}}
for k, val in json.loads(extra).items():
    resumen[k] = val
json.dump({"esquema": 1, "fecha": fecha, "fuentes": {"hallazgos": {
    "estado": estado, "motivo": "ruta /Users/fulana/secreta", "fecha": fecha, "resumen": resumen}}}, open(dest, "w"))
PY
}
LEIDO_F1='{"volcado":"f-1.json","medida":"con_hallazgos"}'
LINEA_B='{"ts":"2026-08-20T10:00:00Z","corrida":"c-0000000000e1","regla":"R-C3","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}'

# ── V2-B · sin hallazgos medidos, el cruce se NIEGA ──────────────────────────────────────────────
for variante in sin-sello viejo sin-repos fecha-invalida; do
  C="$(escenario "v2b-${variante}")"
  case "${variante}" in
    sin-sello) rm -f "${C}/findings-seal.json" ;;
    viejo)     sello "${C}/hallazgos.jsonl" "2026-09-10" ;;
    sin-repos) printf '{"estado":"recolectado","fecha":"2026-09-16","repos":0}\n' > "${C}/findings-seal.json" ;;
    fecha-invalida) sello "${C}/hallazgos.jsonl" "ayer" ;;
  esac
  podar "${C}"; RC=$?
  if [ "${RC}" = "2" ] && grep -q 'hallazgos' "${ERR}"; then
    ok "V2-B ${variante}: sin hallazgos medidos → exit 2, con motivo"
  else
    mal "V2-B ${variante}: salió ${RC} (candidatas=$(q "d['resumen']['candidata_a_retiro']")) — rojo previo: el cruce contaba cero hallazgos y toda regla probada salía candidata a retiro"
  fi
done

# ── V2-A · las dos puntas cuentan el MISMO universo de máquinas ──────────────────────────────────
C="$(escenario v2a)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "no_medido" "${LINEA_B}"
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":100}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${RC}" = "0" ] && [ "${V}" = "30" ] && ok "V2-A las corridas de una máquina sin hallazgos medidos NO suman oportunidades (30)" \
  || mal "V2-A rc=${RC} oportunidades=${V}, esperaba 0 y 30 — rojo previo: 130, el denominador de todas las máquinas contra el numerador de una"
DESC="$(q "d['cobertura']['corridas']['descartadas_sin_hallazgos']")"
[ "${DESC}" = "1" ] && ok "V2-A lo descartado se cuenta (1 corrida)" \
  || mal "V2-A descartadas_sin_hallazgos=${DESC}, esperaba 1 — sin el número, el recorte es invisible"
H3="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C3')")"
[ "${H3}" = "0" ] && ok "V2-A y sus hallazgos tampoco se leen (declaró no medido)" || mal "V2-A R-C3 hallazgos=${H3}, esperaba 0"
SM="$(q "[m['alias'] for m in d['cobertura']['hallazgos']['maquinas_sin_medir']]")"
case "${SM}" in *maq-*) ok "V2-A la máquina sin medir se nombra por su alias (${SM})" ;;
  *) mal "V2-A maquinas_sin_medir=${SM} — la página tiene que decir QUÉ máquina no entró" ;; esac
if grep -qE 'fulana|mengana|secreta' "${OUT}" "${ERR}"; then
  mal "V2-A 🔴 FUGA: un nombre de máquina o el motivo crudo de su cobertura llegó a la salida"
else
  ok "V2-A ni nombres de máquina ni texto de afuera en la salida"
fi

C="$(escenario v2a-medida)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")" '{"repos":3,"run_dirs":5,"baldes":{"con_hallazgos":1},"texto":"x"}'
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
H3="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C3')")"
[ "${V}" = "35" ] && [ "${H3}" = "1" ] && ok "V2-A una máquina del buzón medida suma sus dos puntas (35 oportunidades, 1 hallazgo)" \
  || mal "V2-A oportunidades=${V} hallazgos R-C3=${H3}, esperaba 35 y 1"
MM="$(q "d['cobertura']['hallazgos']['maquinas']")"
[ "${MM}" = "2" ] && ok "V2-A dos máquinas medidas" || mal "V2-A maquinas=${MM}, esperaba 2"
REP="$(q "d['cobertura']['hallazgos']['recolector']['repos']")"
BAL="$(q "d['cobertura']['hallazgos']['recolector']['baldes']['con_hallazgos']")"
[ "${REP}" = "5" ] && [ "${BAL}" = "9" ] && ok "V2-A los conteos del recolector se suman entre máquinas (repos 2+3, con hallazgos 8+1)" \
  || mal "V2-A recolector repos=${REP} con_hallazgos=${BAL}, esperaba 5 y 9 — sin la suma, «de cuántos repos salen» no tiene respuesta"

C="$(escenario v2a-atrasada)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-01" "medido" "${LINEA_B}"
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${V}" = "30" ] && ok "V2-A una máquina con hallazgos atrasados no entra (su cobertura es de hace 15 días)" \
  || mal "V2-A oportunidades=${V}, esperaba 30 — rojo previo: una cobertura vieja se leía como medida hoy"

C="$(escenario v2a-local-sin-medir)"
rm -f "${C}/findings-seal.json"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
H1="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C1')")"
[ "${RC}" = "0" ] && [ "${V}" = "5" ] && [ "${H1}" = "0" ] \
  && ok "V2-A esta máquina sin medir: ni sus corridas ni sus hallazgos; la del buzón sí (5)" \
  || mal "V2-A rc=${RC} oportunidades=${V} hallazgos R-C1=${H1}, esperaba 0, 5 y 0"
LOC="$(q "[m for m in d['cobertura']['hallazgos']['maquinas_sin_medir'] if m.get('local')]")"
case "${LOC}" in *sello*) ok "V2-A y dice que esta máquina no entró, con el motivo del recolector" ;;
  *) mal "V2-A maquinas_sin_medir local=${LOC} — esperaba el motivo «sin sello»" ;; esac

# ── la misma corrida vista desde dos máquinas cuenta UNA vez ─────────────────────────────────────
C="$(escenario v2-corrida-repetida)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" \
  '{"ts":"2026-08-10T10:00:00Z","corrida":"c-000000000a01","regla":"R-C1","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}'
podar "${C}"; RC=$?
H1="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C1')")"
DUP="$(q "d['cobertura']['hallazgos']['duplicados']")"
[ "${H1}" = "2" ] && [ "${DUP}" = "1" ] && ok "V2 la misma corrida en dos máquinas (la evidencia viaja por git) cuenta una vez, y se dice" \
  || mal "V2 R-C1 hallazgos=${H1} duplicados=${DUP}, esperaba 2 y 1 — rojo previo: 3, el hallazgo contado por cada clon"

# ── un volcado archivado dos veces cuenta una, el último ─────────────────────────────────────────
C="$(escenario v2-sesion-repetida)"
# el nombre ordena DESPUÉS del original: así «quedarse con el primero» y «quedarse con el más nuevo» difieren
volcado "${C}/historia" "zz-a-sep-1-otra-vez" "2026-09-02T10:00:00Z" '{"adv-a":3}' "medido" "sesion-a-sep-1"
leidos "${C}/hallazgos.jsonl" zz-a-sep-1-otra-vez; sello "${C}/hallazgos.jsonl" "2026-09-16"
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
DS="$(q "d['cobertura']['corridas']['duplicadas']")"
[ "${V}" = "32" ] && [ "${DS}" = "1" ] && ok "V2 la sesión archivada dos veces cuenta una, con el volcado más nuevo (30 − 1 + 3)" \
  || mal "V2 oportunidades=${V} duplicadas=${DS}, esperaba 32 y 1 — rojo previo: 33, la misma sesión sumada dos veces"

# ── una serie con líneas de otro formato deja a su máquina sin medir ─────────────────────────────
# 🔴 rojo previo: la serie de la vuelta 1 (sin `corrida`) con un sello de hoy se leía «medida» con cero
#    hallazgos legibles, y todo lo probado salía candidata.
C="$(escenario v2-formato-viejo)"
printf '{"ts":"2026-08-10T10:00:00Z","regla":"R-C2","dueno":"adv-a","severidad":"WARNING","disposicion":"fixed"}\n' >> "${C}/hallazgos.jsonl"
podar "${C}"; RC=$?
[ "${RC}" = "2" ] && grep -q 'ilegibles' "${ERR}" && ok "V2 una línea sin huella de corrida deja a la máquina sin medir (y sola, el cruce se niega)" \
  || mal "V2 serie con una línea de otro formato salió ${RC} (candidatas=$(q "d['resumen']['candidata_a_retiro']")) — rojo previo: se sumaban las legibles y la otra se contaba aparte"
C="$(escenario v2-formato-viejo-buzon)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" '{"ts":"2026-08-21T10:00:00Z","regla":"R-C2","dueno":"adv-a"}')"
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
H3="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C3')")"
[ "${V}" = "30" ] && [ "${H3}" = "0" ] && ok "V2 y una máquina del buzón con una línea rota no suma ninguna de sus dos puntas" \
  || mal "V2 máquina del buzón con línea rota: oportunidades=${V} hallazgos R-C3=${H3}, esperaba 30 y 0"

# ── rota es SÓLO un error de criterio ─────────────────────────────────────────────────────────────
C="$(escenario v2-clase)"
python3 - "${C}/examen.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
d['results']['adv-a::r-c4-limpio']['tools']['claude']['clase']='error'
d['results']['adv-a::r-c2-rojo']['tools']['claude']={'pass':False,'clase':'inestable'}
json.dump(d,open(p,'w'))
PY
podar "${C}"; RC=$?
E4="$(estado_de R-C4)"; E2="$(estado_de R-C2)"; NC="$(q "d['cobertura']['banco']['no_concluyentes']")"
[ "${E4}" = "sin_examinar" ] && ok "V2 un caso que falló por la corrida (no por el criterio) no hace rota a la regla" \
  || mal "V2 R-C4 con clase error → ${E4}, esperaba sin_examinar — rojo previo: rota, y una regla sana se manda a arreglar"
[ "${E2}" = "sin_examinar" ] && ok "V2 y un must-flag inestable tampoco la da por probada" \
  || mal "V2 R-C2 con clase inestable → ${E2}, esperaba sin_examinar"
[ "${NC}" = "2" ] && ok "V2 los dos no concluyentes se cuentan" || mal "V2 no_concluyentes=${NC}, esperaba 2"

# ── lo ilegible se cuenta, nunca se lee como cero ────────────────────────────────────────────────
C="$(escenario v2-por-tipo)"
volcado "${C}/historia" "raro" "2026-09-11T10:00:00Z" '{"adv-a":"3"}'
volcado "${C}/historia" "negativo" "2026-09-11T10:00:00Z" '{"adv-a":-4}'
leidos "${C}/hallazgos.jsonl" raro negativo; sello "${C}/hallazgos.jsonl" "2026-09-16"
podar "${C}"; RC=$?
IL="$(q "d['cobertura']['corridas']['ilegibles']")"; CD="$(q "d['cobertura']['corridas']['con_denominador']")"
[ "${IL}" = "2" ] && [ "${CD}" = "31" ] && ok "V2 un conteo que no es un número es ilegible, no «con denominador»" \
  || mal "V2 ilegibles=${IL} con_denominador=${CD}, esperaba 2 y 31 — rojo previo: 0 y 33"

C="$(escenario v2-historia-rota)"
rm -rf "${C}/historia"; printf 'no soy una carpeta' > "${C}/historia"
podar "${C}"; RC=$?
[ "${RC}" = "2" ] && grep -q 'denominador' "${ERR}" && ok "V2 una historia que no se puede leer → exit 2 (sin denominador no hay poda)" \
  || mal "V2 historia ilegible salió ${RC} — rojo previo: 0 corridas, todo «sin recorrido suficiente», publicado como medición"

C="$(escenario v2-buzon-roto)"
rm -rf "${C}/buzon"; printf 'x' > "${C}/buzon"
podar "${C}"; RC=$?
BI="$(q "d['cobertura']['hallazgos']['buzon_ilegible']")"
[ "${RC}" = "0" ] && [ "${BI}" = "True" ] && ok "V2 un buzón que no se puede leer se dice (y esta máquina se mide igual)" \
  || mal "V2 buzón ilegible rc=${RC} buzon_ilegible=${BI}, esperaba 0 y True"

C="$(escenario v2-casos-rotos)"
printf '{roto' > "${C}/casos/adv-c.json"
podar "${C}"; RC=$?
CI="$(q "d['cobertura']['banco']['casos_ilegibles']")"
[ "${CI}" = "1" ] && ok "V2 un archivo de casos roto se cuenta" \
  || mal "V2 casos_ilegibles=${CI}, esperaba 1 — rojo previo: se salteaba callado y sus reglas quedaban «sin caso»"

C="$(escenario v2-examen-vacio)"
python3 - "${C}/examen.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['results']={'x::y':{'type':'must-flag'}}; json.dump(d,open(p,'w'))
PY
podar "${C}"; RC=$?
EX="$(q "d['cobertura']['examen']['estado']")"; CAND="$(q "d['resumen']['candidata_a_retiro']")"
[ "${EX}" = "no_medido" ] && [ "${CAND}" = "0" ] && ok "V2 un examen sin un solo resultado legible no se usa" \
  || mal "V2 examen vacío → estado=${EX} candidatas=${CAND}, esperaba no_medido y 0"

for malo in 2026-13-45 hoy; do
  C="$(escenario "v2-hoy-${malo}")"
  OUT="${C}/out"; ERR="${C}/err"
  node "${PODA}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --sources "${C}/sources.json" \
    --cases "${C}/casos" --exam "${C}/examen.json" --history "${C}/historia" \
    --findings "${C}/hallazgos.jsonl" --mailbox "${C}/buzon" --machine "${MAQ_LOCAL}" --today "${malo}" --json > "${OUT}" 2> "${ERR}"; RC=$?
  [ "${RC}" = "2" ] && grep -q 'AAAA-MM-DD' "${ERR}" && ok "V2 --today ${malo} → exit 2, diciendo qué fecha espera" \
    || mal "V2 --today ${malo} salió ${RC} — rojo previo: se usaba la fecha de hoy sin avisar"
done

# ════════════════════════ vuelta 2, segunda revisión ═══════════════════════════════════════════════
# ── V3 · dentro de una máquina medida, sólo cuenta la corrida cuyos hallazgos se LEYERON ──────────
# 🔴 rojo previo: el denominador se filtraba por máquina — medido, 49 de 113 corridas sin archivo legible
#    sumaban oportunidades con «cero hallazgos».
C="$(escenario v3-sin-leer)"
volcado "${C}/historia" "sin-leer" "2026-09-11T10:00:00Z" '{"adv-a":50}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
SL="$(q "d['cobertura']['corridas']['no_leidas']")"
[ "${V}" = "30" ] && [ "${SL}" = "1" ] && ok "V3 una corrida que el recolector no leyó no suma oportunidades (30), y se cuenta" \
  || mal "V3 oportunidades=${V} no_leidas=${SL}, esperaba 30 y 1 — rojo previo: 80"

# ── V3 · la edad de una máquina del buzón es la de su serie, no la de su subida ──────────────────
C="$(escenario v3-fecha-serie)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
python3 - "${C}/buzon/equipo-de-fulana/registros/cobertura.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["fuentes"]["hallazgos"]["fecha"] = "2026-09-08"   # medida hace 8 días, subida ayer
json.dump(d, open(sys.argv[1], "w"))
PY
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${V}" = "30" ] && ok "V3 una serie de hace 8 días subida ayer no entra" \
  || mal "V3 oportunidades=${V}, esperaba 30 — rojo previo: se miraba la fecha de la preparación de la subida"

# ── V3 · una serie del buzón que no coincide con su resumen no entra ──────────────────────────────
C="$(escenario v3-no-coincide)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")" '{"hallazgos":7}'
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
V="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
[ "${V}" = "30" ] && ok "V3 una serie a medias (1 hallazgo contra 7 declarados) no entra" \
  || mal "V3 oportunidades=${V}, esperaba 30 — rojo previo: una serie vacía con resumen bueno se leía «medida con cero»"

# ── V3 · del resumen ajeno sólo entran las claves conocidas ──────────────────────────────────────
C="$(escenario v3-claves)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")" \
  '{"repos":3,"RUTA-Users-fulana-secreta":4,"baldes":{"con_hallazgos":1,"cliente-secreto":2}}'
python3 - "${C}/buzon/equipo-de-fulana/registros/cobertura.json" <<'PY'
import sys
t = open(sys.argv[1]).read().replace('"repos": 3', '"repos": 3, "__proto__": {"contaminado": 1}')
open(sys.argv[1], "w").write(t)
PY
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
REP="$(q "d['cobertura']['hallazgos']['recolector']['repos']")"
if [ "${REP}" = "5" ] && ! grep -qE 'secreta|secreto|contaminado|__proto__' "${OUT}"; then
  ok "V3 del resumen de otra máquina entran sólo las claves conocidas (repos 2+3), ni nombres raros ni __proto__"
else
  mal "V3 repos=${REP} o una clave ajena llegó a la salida — rojo previo: el filtro miraba el valor, no el nombre"
fi

# ── V3 · el alcance del examen sale sólo si es uno conocido ───────────────────────────────────────
C="$(escenario v3-alcance)"
examen "${C}/examen.json" "2026-09-15T05:00:00Z" "RUTA-Users-fulana"
podar "${C}"; RC=$?
MOT="$(q "d['cobertura']['examen']['motivo']")"
case "${MOT}" in *fulana*) mal "V3 🔴 el alcance crudo del examen salió en el motivo: ${MOT}" ;;
  *otro*) ok "V3 un alcance desconocido se publica como «otro»" ;;
  *) mal "V3 motivo=${MOT}" ;; esac

# ── V4 · esta máquina, medida por su copia del buzón, no se nombra como «sin medir» ───────────────
C="$(escenario v4-local-por-buzon)"
rm -f "${C}/findings-seal.json"
maquina_buzon "${C}" "${MAQ_LOCAL}" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
volcado "${C}/buzon/${MAQ_LOCAL}" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}"; RC=$?
MM="$(q "d['cobertura']['hallazgos']['maquinas']")"; SM="$(q "len(d['cobertura']['hallazgos']['maquinas_sin_medir'])")"
[ "${RC}" = "0" ] && [ "${MM}" = "1" ] && [ "${SM}" = "0" ] && ok "V4 entra por su copia del buzón y no figura como «no entró»" \
  || mal "V4 rc=${RC} maquinas=${MM} sin_medir=${SM}, esperaba 0, 1 y 0 — rojo previo: contada y nombrada como sin medir a la vez"

# ── 2.12-T16 · Podar_SinMaquinaLocal (story 2.12) · --without-local: el nocturno no cuenta el disco del agente como una máquina (AC 3) ─────
# 🔴 rojo previo: el cruce agrega SIEMPRE la máquina local → en el nocturno el agente de Azure figura «sin medir», o sus
#    hallazgos y su historia suman, y las dos puntas dejan de contar sólo las máquinas del buzón.
C="$(escenario t16-sin-local)"
maquina_buzon "${C}" "equipo-de-fulana" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
volcado "${C}/buzon/equipo-de-fulana" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}" --without-local; RC=$?
MM="$(q "d['cobertura']['hallazgos']['maquinas']")"; SM="$(q "len(d['cobertura']['hallazgos']['maquinas_sin_medir'])")"
H1="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C1')")"; V2="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
if [ "${RC}" = "0" ] && [ "${MM}" = "1" ] && [ "${SM}" = "0" ] && [ "${H1}" = "0" ] && [ "${V2}" = "5" ]; then
  ok "2.12-T16 Podar_SinMaquinaLocal: una sola máquina (la del buzón), nadie «sin medir», los 2 hallazgos y las 30 corridas del disco no suman"
else
  mal "2.12-T16 Podar_SinMaquinaLocal rc=${RC} maquinas=${MM} sin_medir=${SM} R-C1 hallazgos=${H1} R-C2 oportunidades=${V2} (esperaba 0, 1, 0, 0 y 5) · $(head -c 200 "${ERR}")"
fi
podar "${C}"; RC=$?
MM="$(q "d['cobertura']['hallazgos']['maquinas']")"; H1="$(q "next(f['hallazgos'] for f in d['filas'] if f['regla']=='R-C1')")"
[ "${RC}" = "0" ] && [ "${MM}" = "2" ] && [ "${H1}" = "2" ] && ok "2.12-T16 sin la bandera, el disco local sigue contando (2 máquinas, R-C1 con 2 hallazgos)" \
  || mal "2.12-T16 control sin --without-local: rc=${RC} maquinas=${MM} R-C1=${H1}"
# y sin buzón ni máquina local, se niega igual (nunca «cero hallazgos»)
C="$(escenario t16-vacio)"
podar "${C}" --without-local; RC=$?
[ "${RC}" = "2" ] && ! grep -q 'esta máquina' "${ERR}" && ok "2.12-T16 --without-local sin nada en el buzón: exit 2 y el motivo no habla de «esta máquina»" \
  || mal "2.12-T16 vacío: rc=${RC} · $(head -c 200 "${ERR}")"

# ── 2.12-T16b · Podar_SinMaquinaLocal · la misma corrida en dos carpetas del buzón cuenta por la máquina medida, en cualquier orden (AC 3) ──
# 🔴 rojo previo (pase adversarial 2026-09-17): se deduplicaba por nombre ANTES de mirar si la máquina estaba medida → con una
#    máquina renombrada, la carpeta vieja (sin medir) se quedaba con el volcado o no según el orden alfabético, y con ella el
#    denominador. En el nocturno no hay disco local que lo tape.
for orden in vieja-primero nueva-primero; do
  C="$(escenario "t16b-${orden}")"
  if [ "${orden}" = vieja-primero ]; then VIEJA=a-equipo-viejo; NUEVA=b-equipo-nuevo; else VIEJA=b-equipo-viejo; NUEVA=a-equipo-nuevo; fi
  maquina_buzon "${C}" "${NUEVA}" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
  maquina_buzon "${C}" "${VIEJA}" "2026-08-01" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
  volcado "${C}/buzon/${NUEVA}" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
  volcado "${C}/buzon/${VIEJA}" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
  podar "${C}" --without-local; RC=$?
  V2="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
  if [ "${RC}" = "0" ] && [ "${V2}" = "5" ]; then
    ok "2.12-T16b ${orden}: la corrida repetida en la carpeta vieja (sin medir) no le quita la suya a la medida (R-C2 con 5 oportunidades)"
  else
    mal "2.12-T16b ${orden}: rc=${RC} R-C2 oportunidades=${V2} (esperaba 0 y 5) · $(head -c 200 "${ERR}")"
  fi
done

# 2.12-T16b (segundo escalón) · entre dos máquinas MEDIDAS con el mismo volcado, cuenta la que lo tiene leído en su serie
# 🔴 rojo previo (mutación, revisión de cobertura 2026-09-17): con un rango que sólo mira «medida o no», la primera en orden
#    alfabético se queda con el volcado aunque su serie no lo nombre → la corrida sale «no leída» y el denominador se pierde.
C="$(escenario t16b-medida-sin-leerla-primero)"
maquina_buzon "${C}" "a-equipo-uno" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" '{"volcado":"f-2.json","medida":"con_hallazgos"}')"
maquina_buzon "${C}" "b-equipo-dos" "2026-09-15" "medido" "$(printf '%s\n%s' "${LINEA_B}" "${LEIDO_F1}")"
volcado "${C}/buzon/a-equipo-uno" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
volcado "${C}/buzon/b-equipo-dos" "f-1" "2026-09-05T10:00:00Z" '{"adv-a":5}'
podar "${C}" --without-local; RC=$?
V2="$(q "next(f['oportunidades'] for f in d['filas'] if f['regla']=='R-C2')")"
if [ "${RC}" = "0" ] && [ "${V2}" = "5" ]; then
  ok "2.12-T16b medida-sin-leerla-primero: entre dos máquinas medidas, el volcado cuenta por la que lo tiene leído (R-C2 con 5 oportunidades)"
else
  mal "2.12-T16b medida-sin-leerla-primero: rc=${RC} R-C2 oportunidades=${V2} (esperaba 0 y 5) · $(head -c 200 "${ERR}")"
fi

# ── la suma que no cierra → se niega ─────────────────────────────────────────────────────────────
# (se prueba por construcción adentro del cruce: si la suma de los estados no es el total, exit 2.
#  Acá se verifica el contrato visible: el total que publica es el de pares del catálogo.)
C="$(escenario tsuma)"
podar "${C}"; RC=$?
[ "$(q "d['total']")" = "$(q "len(d['filas'])")" ] && ok "tsuma una fila por par (dueño, regla), ni una más" \
  || mal "tsuma total=$(q "d['total']") filas=$(q "len(d['filas'])")"

echo
echo "${FALLOS} fallo(s)"
[ "${FALLOS}" -eq 0 ] || exit 1
